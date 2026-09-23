# 2026-09-01 - L2 unwedge: snapshot-boundary L1 trim

## Context & Objective

Socratic-Trade's Litestream level-2 compaction has been wedged since 2026-08-29.  L0 and L1
replication kept working the entire time - only the L2 fold failed - so `/api/live` stayed
green and nothing paged.  The fleet has hand-healed this same class of wedge four times now
(ST 2026-08-13, ST 2026-08-22, UM 2026-08-27, ST 2026-08-31/09-01), each time by deleting L1
objects by hand from a Mac seat.

This unit lands the reusable heal that was written and installed on the production host today,
plus the documentation that explains the failure mode, when to run the tool, and the
granularity trade-off it deliberately accepts.  No runtime code changes.

## Changes Made

The installed host tool is copied into the repo verbatim so it is reviewable, re-installable,
and does not live only on one box.  `docs/litestream.md` gains a compaction-health section;
the rollout, effort log, and status snapshot record the evidence chain.

Exact files touched:

- `scripts/litestream-l1-boundary-trim.py` (new, mode 100755) - byte-identical copy of
  `/usr/local/sbin/litestream-l1-boundary-trim` on `fleet-hetzner-nbg1`.
- `docs/litestream.md` - new section "Compaction health - the L2 mega-upload wedge":
  failure mode and signature log lines, the tool and when to run it, the PITR trade-off and
  why this is on-demand rather than a nightly timer, the Class A/C property, and a
  boundary-trim vs `scripts/litestream-l1-suffix-heal.py` comparison.
- `docs/rollouts/2026-09-01-l2-unwedge-boundary-trim.md` (this file).
- `docs/EFFORT-LOG.md` - effort row (mirrored into `/Users/jay/apps/TRADING-EFFORT-LOG.md`).
- `STATUS.md` - snapshot entry.

## Decisions & Trade-offs

**Root cause is the mega-upload, not the download cap.**  This is the correction that matters,
because the previous three heals treated the cap as the villain.  Litestream 0.5's L2
compaction reads the *whole* remaining L1 chain into one output object.  When L2 stalls, L1
keeps growing, so every retry is a larger multipart upload than the last and re-downloads more
L1 than the last.  The loop diverges by construction.  The Class B cap exhaustion is what that
retry storm produces, not what starts it.

**The cap is not unreasonably small.**  19 retries got through before it was exhausted, at
roughly 2.3 GB of L1 re-download each - so the daily allowance is on the order of 40+ GB.
Raising it would buy more failed retries per day, not a successful compaction.

**Boundary is the snapshot, not a file count.**  Deleting L1 whose `maxTXID` is at or below
the newest L9 snapshot's `maxTXID` is safe by construction - a full snapshot already contains
those transactions.  That is a stronger guarantee than the existing
`scripts/litestream-l1-suffix-heal.py`, which keeps the newest N contiguous files and can
leave a restore hole if N is chosen carelessly.  Both tools are kept: suffix-heal is still the
right instrument when the L2/L3 objects themselves are poisoned, since boundary-trim never
touches L2/L3.

**Accepted cost: sub-daily PITR granularity inside the trimmed span.**  Trimming L1 below a
snapshot drops the ability to land between two arbitrary mid-day transactions in the span the
snapshot already subsumes; recovery to the snapshot and to any point after the trim boundary is
unaffected, modulo whatever L0 still covers.  This is why the tool is armed as a **one-shot,
not a permanent nightly timer** - the app's configured 168h snapshot retention must stay the
single authoritative retention policy rather than being silently shortened by an ops script.

**Dry-run default, five aborts.**  Deleting backup objects unattended is the kind of thing that
turns a compaction annoyance into a data-loss incident.  The tool refuses to act unless an L9
snapshot exists, is at least 100 MB (so a truncated or in-progress snapshot can never define
the boundary), and is under 48h old; it aborts if trimming would leave a restore hole between
the snapshot and the kept chain; and it warns-and-skips rather than deleting any object whose
name it cannot parse.

**Class A/C, deliberately.**  Listings and deletes are not metered against the Class B download
cap, so the heal is usable in precisely the state the wedge creates - a bucket whose downloads
are already refused.  A tool that needed to read objects to decide what to delete would be
unusable exactly when it is needed.

**Timer placement (~00:02Z).**  The nightly snapshot is what advances the boundary, so the trim
is armed two minutes after it lands.  Running later still helps but heals less: the L1 that has
accumulated since the snapshot is exactly what L2 must still carry.

## Verification State

**sha256, repo copy vs installed host script** - identical:

```
b1a058166bc8dcaa6a4e91cb5b37f048d0490f87ab8d6e7fb1ea9e6ed03ef1d2  scripts/litestream-l1-boundary-trim.py            (repo)
b1a058166bc8dcaa6a4e91cb5b37f048d0490f87ab8d6e7fb1ea9e6ed03ef1d2  /usr/local/sbin/litestream-l1-boundary-trim       (host)
```

Both 5381 bytes.

**Evidence chain - the cap reset but L2 still never completed.**  The daily Class B allowance
resets at 00:00Z.  It did reset: from `docker logs` on the ST container
(`d83b1aykr03uwr32yhgzaiay`), there are **zero** cap errors between 00:00Z and 01:39Z on
2026-09-01.  In that same window L2 failed **19 times**, every one of them on the **upload**:

```
00:03:29Z ... level=2 error="write ltx file: s3: upload to trading-live/app.db/0002/
  0000000000134700-000000000013a259.ltx: read upload data failed: read page header 312: unexpected EOF"
00:12:09Z ... level=2 error="write ltx file: s3: upload to trading-live/app.db/0002/
  0000000000134700-000000000013a350.ltx: read upload data failed: read page header 402:
  read lz4 trailer: expected lz4 end frame"
```

Nineteen failures at 00:03:29, 00:12:09, 00:16:57, 00:21:47, 00:26:37, 00:31:03, 00:35:54,
00:40:59, 00:45:48, 00:50:36, 00:55:45, 01:00:46, 01:05:42, 01:11:15, 01:16:21, 01:20:59,
01:26:14, 01:31:23, 01:36:12Z.  Note the `0002/` object name: `<min>` is pinned at
`0000000000134700` on every retry while `<max>` climbs - the mega-upload growing with each
attempt, exactly as the failure mode predicts.

The **first** cap-exceeded of the day is at **01:39:33Z**, after those 19 uploads had already
failed, and from then on the same 5-minute tick fails earlier, on the read:

```
01:39:33Z ... level=2 error="open ltx file: s3: get object trading-live/app.db/0001/
  0000000000134700-000000000013471f.ltx: ... AccessDenied: Cannot download file,
  download bandwidth or transaction (Class B) cap exceeded."
```

So the cap was a **symptom of the retry storm, not the root cause**.  At ~2.3 GB re-downloaded
per retry, 19 retries puts the daily allowance around 40+ GB - not unreasonably small.

**Mac-side heals applied today (2026-08-31 Central), both via
`scripts/litestream-l1-suffix-heal.py`:**

- `--keep-l1 200 --apply` at ~08:00Z - deleted 756 objects.
- `--keep-l1 113 --apply` at ~03:00Z (2026-09-01 UTC) - deleted ~556 objects.

**Live dry-run of the new tool, 03:00Z** (before the second suffix-heal), on the host:

```
[l1-boundary-trim] mode=DRY-RUN bucket=jays-socratic-trade-eu prefix=trading-live/app.db
[l1-boundary-trim] L1 total=373 superseded=266 (941 MB) keep=107 (454 MB)
[l1-boundary-trim] first kept 000000000013a267-000000000013a29e.ltx (chain intact)
```

**Live dry-run re-run at 03:04:39Z** (after that suffix-heal), confirming the guards read a
real snapshot and the chain is intact:

```
[l1-boundary-trim] 2026-09-01T03:04:39Z mode=DRY-RUN bucket=jays-socratic-trade-eu prefix=trading-live/app.db
[l1-boundary-trim] 2026-09-01T03:04:40Z newest snapshot 0000000000000001-000000000013a27e.ltx size=4520377833 modtime=2026-09-01 00:00:02 boundary=13a27e
[l1-boundary-trim] 2026-09-01T03:04:40Z snapshot age 3.1h - ok
[l1-boundary-trim] 2026-09-01T03:04:41Z L1 total=116 superseded=6 (14 MB) keep=110 (460 MB)
[l1-boundary-trim] 2026-09-01T03:04:41Z first kept 000000000013a267-000000000013a29e.ltx (chain intact)
```

**One-shot timer armed** (transient systemd unit on `fleet-hetzner-nbg1`, verified via
`systemctl list-timers --all` and `systemctl cat`):

```
Wed 2026-09-02 00:02:00 UTC   l1-boundary-trim-oneshot.timer -> l1-boundary-trim-oneshot.service
[Timer]   OnCalendar=2026-09-02 00:02:00 UTC
          RemainAfterElapse=no
[Service] ExecStart="/usr/local/sbin/litestream-l1-boundary-trim" "--apply"
```

**Repo gate** - all four commands, in the AGENTS.md order.  `land.sh` runs only the tsc /
vitest / build trio, so `npm run lint` was run separately:

```
npm run lint       # 792 problems (0 errors, 792 warnings) - passes; the gate fails on errors only
npx tsc --noEmit
npm test
npm run build
```

Results: lint 0 errors (792 grandfathered warnings, unchanged by this PR - it adds no
TypeScript); `tsc` clean; **699 test files passed / 1 skipped, 7,692 tests passed / 51 skipped**;
`next build` clean.  `scripts/litestream-l1-boundary-trim.py` is a standalone Python operator
tool - it is not imported by the app, not exercised by vitest, and does nothing at runtime.

**This PR does trigger a production build - do not read "docs + script" as image-noop.**
Checked, not assumed: the live `watch_paths` on Coolify app `socratic-app` was read straight
out of `coolify-db` (`SELECT uuid, name, watch_paths FROM applications WHERE name ILIKE
'%socratic%'`) and it contains both `scripts` and `scripts/**`, alongside `Dockerfile`,
`src/**`, `app/**`, `public/**`, and the config files.  Adding a file under `scripts/`
therefore matches, so the merge starts a real stop-old-first rebuild and container swap even
though nothing the image runs has changed.

This lands at ~03:20 UTC on Monday 2026-09-01, which is **outside** US regular trading hours
(09:30-16:00 ET = 13:30-20:00 UTC), so the Dockerfile's RTH latch will not refuse the build -
it deploys on merge rather than waiting for the 21:20 UTC drain.  No `HOTFIX=1` and no
`RTH_DEPLOY_OVERRIDE=1` were used, and no deploy was hand-triggered.

## Next Steps & Blockers

1. **After 2026-09-02 00:02Z, confirm the heal worked.**  Look for a
   `msg="compaction complete" ... level=2` line in the ST container logs, and for the L2 object
   `<min>` TXID finally advancing past `0000000000134700`.  If L2 completes, the wedge is
   cleared and the transient timer lapses on its own (`RemainAfterElapse=no`).
2. **If L2 still fails after the trim**, the remaining suspect is a poisoned L2/L3 object that
   Compact keeps trying to extend - boundary-trim never touches those levels.  That is the case
   `scripts/litestream-l1-suffix-heal.py` exists for; run its dry-run first and read the
   hole/twin counts.
3. **Do not convert the one-shot into a recurring timer.**  See the trade-off above - the app's
   168h snapshot retention stays authoritative.
4. **Fleet follow-up (not this repo):** CT and UM share the same Backblaze account and were
   starved by ST's retry storm.  Worth an alert on repeated `level=2` `compaction failed` lines
   so the next wedge is caught in hours rather than days - the existing health probes cannot
   see it, because L0/L1 replication stays perfectly healthy the whole time.
5. **Harden the three guard gaps Codex review found on PR #3140 - paired repo + host change.**
   All three are real and all three are accepted; none is fixed in this PR, because
   `scripts/litestream-l1-boundary-trim.py` is landed as a *verbatim mirror* of the file
   installed at `/usr/local/sbin/litestream-l1-boundary-trim`.  Changing the repo copy alone
   would break that correspondence and would not change what actually runs - the host copy is
   what the armed one-shot executes - so the fix has to land in both at once, which is a
   production write this unit was not authorized to make.  Until then the gaps are covered by
   the "Pre-flight before `--apply`" checklist in `docs/litestream.md`:
   - **Snapshot integrity (highest severity).**  The 100 MB floor cannot catch a truncated
     ~4.5 GB snapshot, and the boundary is read from the object's filename.  Trimming through
     the boundary of a truncated snapshot can leave those transactions with no valid restore
     source.  Cheapest real fix that stays Class A/C: reject a material size regression
     against the previous snapshot, which needs only the listing the tool already does.
   - **Kept-chain contiguity.**  Only the *first* kept object is checked against the boundary;
     internal gaps in the retained set are not.  This is a demonstrated wedge, not a
     hypothetical - `docs/rollouts/2026-08-22-litestream-l2l3-unwedge.md` records Litestream
     refusing L1 with `non-contiguous transaction ids in input files` (4 holes / 560 objects).
     The trim cannot create such a hole, but it exits 0 and reports success while L2 stays
     wedged.  Walk every retained range, treating twins the way `suffix-heal` does.
   - **Scheduled-run snapshot freshness.**  The 48h guard accepts yesterday's snapshot, so a
     late or failed nightly snapshot lets the 00:02Z one-shot trim to the old boundary, exit
     0, and lapse - under-healing exactly when it matters.  The scheduled path should require
     a snapshot from the current run, or poll for it, rather than accept the prior day's.
6. **No blockers.**

## Zero-Code Findings

- The 2026-08-29 through 2026-09-01 wedge produced **no alert of any kind**.  `/api/live` was
  green, L0 uploads were landing every few seconds, and `litestream ltx` looked healthy - the
  only signal was `level=2` lines inside container logs nobody was tailing.  Any monitoring
  added for this class must key on compaction level, not on replication liveness.
- Reading the cap error as the root cause is the specific trap here, and it is a convincing
  one: the cap message is loud, actionable-sounding, and arrives right when someone starts
  looking.  The 00:00-01:39Z window - allowance freshly reset, zero cap errors, 19 upload
  failures anyway - is what settles it, and is the reason that window is quoted in full above.
- The `<min>` TXID pinned at `0000000000134700` across every retry, while `<max>` climbed, is
  the cheapest available tell that the upload is growing rather than being retried at a fixed
  size.  Worth checking first on any future L2 wedge.
