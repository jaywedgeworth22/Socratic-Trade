# 2026-09-01 - L1 boundary-trim hardening, multi-app support, and the CT wedge

## 1. Context & Objective

PR #3140 landed `scripts/litestream-l1-boundary-trim.py` as the repo mirror of the tool
installed on `fleet-hetzner-nbg1` at `/usr/local/sbin/litestream-l1-boundary-trim`, which
unwedges Litestream level-2 compaction by deleting L1 objects a full snapshot has already
superseded.  The review on that PR raised three real guard gaps.  All three were fixed on the
host, and this change syncs the repo copy back to byte-identity and documents the new
behaviour.

Two things came out of actually running the hardened tool against a large real level, and
both are the substance of this note:

1. **Congress.Trade's L1 had never been trimmed at all, and its L2 was wedged exactly the way
   Socratic-Trade's was.**  The tool is therefore now a fleet tool with an `--app` selector
   rather than a Socratic-only script.
2. **The first CT run deleted nothing while reporting success**, because `--b2-hard-delete`
   is not usable with the host's scoped key.  That produced two further fixes, and it is the
   reason the tool no longer trusts its own exit codes.

## 2. Changes Made

The script is a verbatim copy of the installed host tool - the repo copy was regenerated with
`ssh root@100.69.77.26 'cat /usr/local/sbin/litestream-l1-boundary-trim'`, not hand-edited,
so the two cannot drift silently.

Behavioural changes relative to the version #3140 landed:

- **Multi-app.**  A new `--app {socratic,congress,usage-monitor}` argument replaces the
  hardcoded `BUCKET` / `PREFIX` module constants with a lookup table.  `socratic` remains the
  default, so existing invocations are unchanged.
- **Snapshot truncation guard.**  Aborts when the newest snapshot is under 50% of the
  *previous* snapshot's size.  The pre-existing 100 MB absolute floor could not reject a
  truncated ~4.5 GB snapshot, and the boundary is read from the object's filename, which
  looks authoritative regardless of content.
- **Kept-chain contiguity.**  Walks the *entire* retained set for internal txid gaps instead
  of only checking that the first kept object reaches the boundary, and aborts when gaps
  exist.  Twins (same `maxTXID`, different `minTXID`) are explicitly allowed.  Level-2
  compaction stays wedged on non-contiguous input no matter how much L1 is trimmed, so
  reporting success in that state is actively misleading.
- **Configurable freshness.**  `--max-snapshot-age-hours` (default 48) replaces the hardcoded
  48h constant.  The scheduled units pass `6`, so a late or failed nightly snapshot aborts
  loudly instead of silently trimming to yesterday's boundary and no-op'ing.
- **Boundary-did-not-advance guard.**  Aborts when nothing is superseded while L1 still holds
  more than 200 objects.
- **Batched deletes.**  Chunks of `DELETE_CHUNK = 500` names are written to a temp file and
  issued as one `rclone delete --files-from <file> --transfers 16 --checkers 16` per chunk.
  `os` and `tempfile` were added to the imports.
- **Plain deletes, deliberately NOT `--b2-hard-delete`.**  See the trade-off below; this is
  the one that silently destroyed a run.
- **Post-apply verification against the bucket.**  After deleting, the run re-lists L1 and
  reports `APPLIED app=X deleted=N survived=M batch_errors=E`, computed from what actually
  remains rather than from rclone's exit codes, naming the first survivors.  Survivors return
  exit 1.
- **Documented exit codes.**  0 ok/no-op, 1 doomed objects survived, 2 no usable snapshot,
  3 snapshot failed a safety guard, 4 would leave a restore hole, 5 kept chain has internal
  gaps, 6 nothing superseded although L1 is large.

Files touched:

- `scripts/litestream-l1-boundary-trim.py` - resynced verbatim from the host (mode 755).
- `docs/litestream.md` - rewrote the boundary-trim section: `--app` table, the guard list with
  per-guard exit codes, an exit-code table, the hide-vs-hard-delete reality, the batched
  delete phase and its bucket-verified reporting, known defects, and the transient-unit
  arming pattern.  The old "Pre-flight before `--apply` - what the guards do NOT cover"
  subsection is gone because all three of its gaps are now enforced in code.
- `docs/rollouts/2026-09-01-l1-trim-hardening.md` - this note.
- `docs/EFFORT-LOG.md` - new effort row, and an in-place correction of the #3140 row that was
  left at IN PROGRESS after that PR merged.
- `STATUS.md` - current-state snapshot.
- `PLAN.md` - lane entry, and the #3140 entry marked merged.

## 3. Decisions & Trade-offs

**Hides, not hard deletes - because the host key cannot hard-delete.**  B2 is versioned:
`rclone delete` writes a hide marker and leaves the prior version in place, while
`--b2-hard-delete` removes the version outright.  Hard-deleting looks strictly better, and
that assumption cost a full run.  The host's scoped `fleet-backup-writer` key may hide a
version but returns `Unknown 401 (401 unauthorized)` on `b2_delete_file_version`.  With the
flag set, rclone reported progress while deleting **nothing** - roughly 800 no-op "deletes"
against Congress.Trade.  Verified directly on a single object: hard delete returns 401 and
the file survives; plain delete via `--files-from` removes it from listings.

A hide is sufficient for the actual goal.  Litestream stops seeing the object immediately, so
compaction unwedges at once, and the bucket's lifecycle rule (`daysFromHidingToDeleting=1`)
frees the bytes about a day later.  What is given up is same-hour space reclamation - and
that is exactly where the billing lesson still applies: hidden versions stay **billed** until
the reaper collects them.  That overhang was measured across the fleet: **199.59 GB** billed
against a **126.49 GB** logical footprint, a ~73 GB gap.  So the distinction matters; the
host simply cannot avoid it.  Hard deletes need the **B2 master key**, so same-hour
reclamation means running the trim from an operator workstation.  The `NOT --b2-hard-delete`
comment in the script records this and must stay - the flag looks like an obvious improvement
to anyone who has not seen the 401.

**Trust the bucket, not the exit codes.**  The 401 run is why the tool re-lists L1 after
applying and derives `deleted` / `survived` from what remains.  Every signal short of that
was lying: rclone returned success, the progress counter advanced normally, and the log
showed no errors, while not one object had been removed.  A tool whose failure mode is
"reports success, does nothing" has to verify its own work against the system of record.

**Batching, because the per-object loop was O(n^2).**  Resolving `--include "/<name>"`
re-lists the whole prefix, so an N-object trim performed N full listings - measured at ~12 s
per delete against CT's ~2,400-object L1, roughly 8 hours for 2,362 objects.  Chunked
`--files-from` lists once per chunk instead.

**Contiguity is a hard abort (exit 5), not a warning.**  A trim cannot fix a hole - it only
deletes at or below the boundary and never creates one - so continuing would delete real
objects and still leave L2 wedged, burning the shared Backblaze allowance on every retry.
Reconciling a hole needs a human, so the tool refuses rather than doing partial work.

**Freshness is configurable rather than tightened globally.**  Dropping the default from 48h
would have been wrong for interactive use, where a human reads the printed `modtime` and
decides.  The value that matters is on the *unattended* path, so the scheduled units pass `6`
and the default stays permissive.

**Still deliberately not a permanent nightly timer.**  Trimming L1 below a snapshot reduces
sub-daily point-in-time granularity for the trimmed span to whatever L0 still covers.  The
app's configured 168h snapshot retention stays the authoritative retention policy, and this
tool must never quietly become a second, shorter one.

## 4. Verification State

Repo copy is byte-identical to the installed host tool:

```
sha256 (host /usr/local/sbin/litestream-l1-boundary-trim)
  a6bfc2bf41652cd367178c28e95e9c7ba11dd854c13da1fc87be4905e4698087
sha256 (repo scripts/litestream-l1-boundary-trim.py)
  a6bfc2bf41652cd367178c28e95e9c7ba11dd854c13da1fc87be4905e4698087
```

Both 9721 bytes, mode 755.  (An earlier revision landed on this branch as
`71c14e0a…668c` / 8018 bytes; the batched-delete and hide-not-hard-delete fixes replaced it,
and the repo copy was re-pulled from the host rather than patched.)

Repo gate, run in AGENTS.md order on Node 24 (`/opt/homebrew/opt/node@24/bin` first on
`PATH`; the Homebrew default is Node 26, whose ABI mass-fails `better-sqlite3`):

```bash
npm run lint       # PASS - 792 problems (0 errors, 792 warnings) - grandfathered backlog unchanged
npx tsc --noEmit   # PASS - clean
npm test           # PASS - 699 files passed / 1 skipped; 7692 tests passed / 51 skipped
npm run build      # PASS - clean
```

The script is Python and is not compiled by any of the four; it was syntax-checked
(`ast.parse`), confirmed pure ASCII, and exercised on the host directly.

CI note: one `verify-hosted` run on this branch failed on a vitest worker teardown flake
(`EnvironmentTeardownError: [vitest-worker]: Closing rpc while "onUserConsoleLog" was
pending`, attributed to `test/economic-calendar-prompt-wiring.test.ts`) with all 7,692 tests
passing and `Errors 1`.  Unrelated to this diff; superseded by a later push.

### Congress.Trade: L1 had never been trimmed, and L2 was wedged the same way

Verified against B2 on 2026-09-01, from the `--app congress` run's own output:

- CT's fresh nightly snapshot `0000000000000001-000000000005b521.ltx` landed
  **2026-09-01T00:00:02Z**, 896,065,649 bytes, boundary `5b521`.  Size ratio against the
  previous snapshot (848,386,671 bytes) was 1.06 - the truncation guard passed cleanly.
- CT L1 held **2,413 objects**, of which **2,362 (24,593 MB) were superseded** by that
  snapshot, leaving **51 objects (12 MB)**.  The first kept object
  `000000000005b50c-000000000005b534.ltx` reaches the boundary, and the contiguity walk found
  no internal gaps.
- CT's **L2 level held ZERO objects** - the same wedge state Socratic-Trade was in.  ST's L2
  is also at zero, with L1 at 172 objects after its earlier heals.

That CT had accumulated 2,413 never-trimmed L1 objects while its L2 stayed empty is the
strongest evidence that this class of wedge is silent: L0/L1 replication and every health
probe stay green throughout, because nothing user-facing depends on L2 compaction completing.

### The first CT run was a complete no-op, and how that was established

The first `--apply` run started 2026-09-01T04:38:20Z (log:
`/var/log/fleet-backup/l1-trim-congress-20260901.log`) and passed every guard - the numbers
above are its own output.  It then deleted nothing at all, while reporting normal progress.

Establishing that took three attempts, and the first two were unsound.  They are recorded
because the reasoning error is the reusable part:

- **The level count does not work.**  L1 went 2,413 -> 2,420 -> 2,433, but that is a *net*
  figure: Litestream keeps adding L1 objects while the trim runs, so a rise is consistent
  with some deletions succeeding alongside more arrivals.
- **A small sample does not work.**  The first three doomed objects still being present after
  400 calls proves three failures, not four hundred.
- **A census of the doomed set does work.**  Every object Litestream adds during the run has
  a `maxTXID` *above* the boundary, so the count of objects still at or below the boundary is
  immune to new arrivals and falls by exactly one per successful delete.  At 06:56Z, after
  `progress 600/2362`:

```
current L1 total          : 2433
still <= boundary 5b521   : 2362      (the run started with exactly 2362 doomed)
above boundary            :   71      (started at 51 kept; +20 new arrivals)
=> successful deletes     :    0
```

Zero of 600 attempted deletes had succeeded - measured over the whole doomed set, not
inferred from a sample.  The run went on to hard-delete nothing across roughly 800 calls.

**Cause: `--b2-hard-delete` against the host's scoped key returns `Unknown 401 (401
unauthorized)` on `b2_delete_file_version`, and rclone reports progress anyway.**  A
`--dry-run` cannot detect this, because dry runs never exercise the delete permission - which
is precisely why every dry run looked healthy.  Both fixes above (drop the flag, verify
against the bucket) come directly from this.

### The fixed tool then worked: CT trimmed 2,361 objects cleanly

Re-run at 2026-09-01T07:46:53Z with the batched, hide-not-hard-delete build
(`/var/log/fleet-backup/l1-trim-congress-20260901b.log`):

```
APPLIED app=congress deleted=2361 survived=0 batch_errors=0
```

Confirmed against the bucket at 08:13Z:

| | before | after |
|---|---|---|
| CT L1 (plain listing) | 2,413 | **82** |
| CT L1 (`--b2-versions`) | - | 2,444 |

82 is the 51 originally-kept objects plus new arrivals since.  `survived=0` and the recount
agree, and the whole run took minutes rather than the ~8 hours the per-object loop projected -
both fixes doing exactly what they were meant to.

The `--b2-versions` count is the other half of the story: **2,444 versions still exist** while
only 82 are listed.  The trimmed objects are hidden, not gone, and stay recoverable until the
bucket's `daysFromHidingToDeleting=1` reaper collects them.  That is the cost (bytes stay
billed ~24h) and the safety margin (a mistaken trim is reversible within that window) of the
hide-based approach, both visible in one listing.

**Still open: CT's L2 is still at zero objects**, as is ST's, so deletion is proven but
*recovery* is not yet.  That is Next Steps item 2, and it is the whole point of the exercise -
a trim that removes objects without restarting compaction has not fixed anything.

### Scheduled retries on the host

Six **transient** one-shot systemd units are armed for **2026-09-02** at **00:04 / 00:20 /
00:40 UTC**:

```
l1trim-st-0004  l1trim-st-0020  l1trim-st-0040   --app socratic
l1trim-ct-0004  l1trim-ct-0020  l1trim-ct-0040   --app congress
```

Each passes `--max-snapshot-age-hours 6 --apply`, so an attempt that fires before the nightly
snapshot has landed aborts with exit 3 and the next attempt picks it up once it does - two
retries of headroom for a late snapshot.  Verified armed via `systemctl list-timers`, and
verified transient via `FragmentPath=/run/systemd/transient/...` plus `Transient=yes`.

These **replace** the earlier single `l1-boundary-trim-oneshot` unit, which was stopped;
`systemctl show l1-boundary-trim-oneshot.service` now reports `LoadState=not-found`.

They are transient on purpose.  Transient units do not survive a reboot, so a forgotten heal
expires on its own instead of silently becoming a nightly retention policy - which, per the
trade-off above, it must never be.

## 5. Next Steps & Blockers

1. **Deletion is now proven on CT; still prove it on ST.**  The CT re-run reported
   `deleted=2361 survived=0 batch_errors=0` and the bucket recount agrees (L1 2,413 -> 82), so
   the 401 fix works.  ST has not been trimmed with this build - its L1 stands at 255.  The
   check is cheap and unambiguous: read the
   `APPLIED app=X deleted=N survived=M batch_errors=E` line, computed from a re-listing of the
   bucket.  A non-zero `survived` (exit 1) means objects the run intended to remove are still
   there.
2. **After the 2026-09-02 00:04-00:40 UTC window, confirm deletion and recovery separately.**
   Exit 0 means only that the run completed without hitting a guard - a dry run and a
   legitimate no-op both return 0 without removing anything.  First establish *deletion* from
   the `APPLIED` line; only then establish that the *wedge* is fixed, via
   `msg="compaction complete" ... level=2` and the L2 object's `<min>` TXID advancing, on
   both ST and CT.  If CT's L2 count is still zero afterwards, the wedge has a second cause.
3. **Validate the snapshot itself, not just its size (P1, from the #3142 review).**  The
   truncation guard is a **heuristic, not an integrity check**: it compares the newest
   snapshot's byte size against the previous one and against a 100 MB floor.  A snapshot
   truncated to, say, 3 GB from 4.5 GB clears both, and the boundary is then taken from the
   *filename* of that incomplete object - so the trim would hide L1 history the snapshot does
   not actually contain.  Nothing in the script opens or checksums the LTX file.  The right
   fix is real completion evidence (`litestream ltx` inspection, or a checksum/finalisation
   marker), not a tighter percentage.

   Severity is bounded by two things worth stating precisely, neither of which makes it
   acceptable: deletes are **hides**, so within the lifecycle window
   (`daysFromHidingToDeleting=1`) the versions still exist and are recoverable - confirmed on
   CT, where 82 objects were listed while `--b2-versions` showed 2,444.  And the restore-hole
   guard (exit 4) still refuses to strand the kept chain.  Neither helps after the reaper
   runs, so treat the ~24h window as the actual remediation deadline.

4. **Fix two confirmed script defects (paired repo + host change).**  Both were found by the
   #3142 review, reproduced directly, and are still present in this build:
   - A **zero-byte previous snapshot crashes the run**: the relative-size guard
     short-circuits on `prev_size > 0`, but the next log line computes `size / prev_size`
     unconditionally, raising an uncaught `ZeroDivisionError`.  Fail-safe (before any delete)
     but it exits on a traceback rather than a documented code.
   - **Legal twin shapes are misreported as gaps**: the contiguity walk sorts by
     `(min, max)` and only recognises a twin on the adjacent pair.  For
     `(1,99), (1,200), (100,200)` it compares `(1,99)` against `(1,200)`, misses the twin,
     and reports gap `63->1` even though `(100,200)` is the exact continuation - a spurious
     exit 5 blocking a trim that should have run.  Collapse same-max twins before testing
     adjacency.
5. **Add single-flight locking.**  The tool still has no lock and each run snapshots its
   delete list up front.  Batching made runs short enough that a collision at 16-20 minute
   retry spacing is far less likely than it was at ~12 s per object, but it is not prevented.
6. **Re-check billed vs logical B2 storage ~24h after a successful trim.**  Because the host
   can only hide, freed bytes lag by roughly a day via `daysFromHidingToDeleting=1`.  The
   199.59 GB / 126.49 GB gap should close on that schedule, not immediately - do not read the
   lag as a failed trim.
7. **Usage-Monitor has a table entry but has not been exercised.**  `--app usage-monitor`
   (`jays-usage-monitor-eu` / `api-usage-monitor/prod.db`) should get a dry run before anyone
   arms it, to confirm the prefix is right and its L1/L2 state.
8. **The timers are transient by design and expire on reboot.**  If the wedge recurs, arm a
   fresh set - do not convert these into an installed nightly timer.

No blockers.  The one that stood earlier - "CT deletes nothing and nobody knows why" - is
diagnosed and fixed; item 1 is verification, not investigation.

## 6. Zero-Code Findings

- **A dry run cannot validate a permission.**  Every dry run of this tool looked healthy while
  the real delete path was returning 401, because `--dry-run` never exercises
  `b2_delete_file_version`.  Any tool whose dry run is treated as a pre-flight check shares
  this blind spot: a dry run validates *intent* (which objects, in what order), never
  *authority*.
- **Progress output is not evidence of progress.**  rclone advanced its counters normally
  through ~800 deletes that removed nothing.  That is why the tool now re-lists the bucket and
  reports `deleted` / `survived` from what remains; a component's own success report is the
  weakest available signal about a side effect on an external system.
- **Guard against the wrong *scope* of key, not just the wrong key.**  The host's key was
  valid and correctly scoped for backup writing; it simply lacked one capability.  That
  presents as a silent no-op rather than an auth error at startup, which is far harder to
  notice than a missing or expired credential.
- The tool never touches L2/L3.  When the L2 object *itself* is poisoned rather than merely
  oversized, `scripts/litestream-l1-suffix-heal.py` is still the right instrument; the
  comparison table in `docs/litestream.md` covers the choice.
