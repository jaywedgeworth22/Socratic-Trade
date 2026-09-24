# Socratic-Trade backup policy

**Status:** canonical.  Supersedes the backup sections scattered across `docs/litestream.md`
and the rollout notes.  Those remain the record of *how each piece was built*; this is the
record of *what the policy is*.

**Scope:** the production SQLite database `/app/data/app.db` on the Coolify box
(`fleet-hetzner-nbg1`, host `167.233.254.55`, container `d83b1aykr03uwr32yhgzaiay`), which
holds live trading state for real money.

**Last end-to-end verification: 2026-09-09.**  Every number below was read from the live
system on that date, not carried forward from a previous note.  Where a figure is inherited
and unverified, it says so.

---

## 0.  The one-paragraph version

Four layers protect `app.db`, on three different providers, because they fail in different
ways.  **Litestream to Backblaze B2** is the layer that carries the real recovery-point
objective: continuous, five-minute RPO, and it is what an actual restore would use.  **A
weekly cold archive to Cloudflare R2** exists to survive faults that continuous replication
faithfully reproduces — a bad migration, a deletion, a corruption — and it is deliberately on
a *different provider* so that losing an account, a credential, or a vendor does not take
both.  **Six-hourly host-side SQLite dumps** give a fast local rollback without touching a
network.  **Hetzner host snapshots** are the outer envelope for the whole machine.  None of
these count as a backup until a restore from them has been proven, so restore verification is
part of the policy, not an optional drill.

---

## 1.  Current size and shape

Read live 2026-09-09T14:24Z:

| Thing | Value |
|---|---|
| `app.db` | 10,982,244,352 bytes (10.98 GB) |
| `app.db-wal` | 143,800,392 bytes |
| Non-DB data on the same volume | ~17.1 GB (`sec-artifacts` 16 G, `roic-artifacts` 858 M, `history-5y` 190 M, `corpus` 78 M, `logos` 4.1 M) |

The database size is itself a risk to the backup design, and has already broken two tiers.
Any mechanism that copies it must finish in minutes, not hours, and must be bounded by a
deadline that fails loudly.  See §7.

---

## 2.  The tiers

| # | Tier | Mechanism | Destination | Cadence | Retention | RPO | RTO |
|---|---|---|---|---|---|---|---|
| 1 | **Continuous replication** | Litestream 0.5.12, LTX | **Backblaze B2** `jays-socratic-trade-eu` / `trading-live/app.db` | `sync-interval: 300s` | `snapshot.interval 24h`, `snapshot.retention 168h` (**7 days**) | **≤ 5 min** | ~5–10 min |
| 2 | **Host-local dump** | `sqlite3 .backup` from the docker volume | `/data/backups/socratic/` on the box, then **B2** `jays-socratic-trade-eu/hetzner/` | every 6 h (`15 */6`) | local `KEEP_COUNT=2` / `KEEP_DAYS=2`; B2 `B2_KEEP_SETS=2` | ≤ 6 h | minutes (local) |
| 3 | **Weekly cold archive** | `VACUUM INTO` in a child process, gzip-streamed multipart upload | **Cloudflare R2** `socratic-trade-bucket` / `cold-snapshots/app-<date>.db.gz` | Sunday 03:17 UTC | **4 snapshots** (~1 month) — raised from 1 on 2026-09-09 | ≤ 7 days | ~20–30 min |
| 4 | **Host snapshot** | Hetzner server backups | Hetzner | daily, 14:00–18:00 UTC window | Hetzner default | ~24 h | hours |

Tier 1 code: `litestream.coolify.yml`, launched by `scripts/coolify-prod-start.sh`.
Tier 2 code: `/usr/local/sbin/fleet-sqlite-backup.sh` on the host, driven by
`/etc/cron.d/fleet-backups`.  **This script is not in this repo** — it is fleet-wide host
infrastructure.  Tier 3 code: `src/lib/r2-cold-snapshot.ts`.

### `litestream.yml` is NOT the production config

The repo contains two Litestream configs and only one of them is real.

- `litestream.coolify.yml` — **production**.  B2, `snapshot.retention: 168h`.
- `litestream.yml` — a local-development file pointing at
  `/Users/jay/apps/trading-live/data/app.db`, a path that **does not exist on any current
  machine**, with `retention: 720h`.

Reading the wrong one is how "we keep 30 days of point-in-time history" entered the fleet's
shared understanding.  **Production keeps 7 days.**  If you want 30, change
`litestream.coolify.yml` and account for the B2 storage.

---

## 3.  Why two providers, and why that must not be "optimised"

Tier 1 (B2) and tier 3 (R2) look redundant.  They are not, and collapsing them onto one
provider would remove protection that is not visible in a diagram.

1. **Different failure classes.**  Replication is faithful: it copies the bad migration, the
   accidental `DELETE`, and the corrupt page as eagerly as it copies good data.  A weekly
   archive taken as an independent point-in-time copy is the only layer that still holds the
   *previous* state after a fault has propagated.
2. **Different blast radius.**  A revoked or compromised credential, a billing lapse, an
   account suspension, or a provider-side incident takes out everything reachable with that
   one set of keys.  Two providers means two independent sets of keys, bills, and control
   planes.
3. **It is cheap.**  Four gzipped weeklies at ~3 GB are roughly 12 GB of paid R2.

`src/lib/r2-cold-snapshot.ts` says the same thing in its header, deliberately, so that the
next person to notice "we are paying for two object stores" finds the reason before the
delete button.

**Rule: never leave the archive tier at depth one, and never delete the only remaining cold
object.**  `selectColdSnapshotsToPrune` refuses to return the newest key for exactly this
reason.

---

## 4.  What is NOT covered

Say these out loud so nobody discovers them during an incident.

- **The ~17.1 GB of non-database data on the volume** — `sec-artifacts`, `roic-artifacts`,
  `history-5y`, `corpus`, `logos`.  Litestream replicates `app.db` only; the host dump copies
  `app.db` only; the cold archive copies `app.db` only.  These are covered **solely** by the
  Hetzner host snapshot (tier 4), at ~24 h RPO.  They are regenerable from upstream APIs, but
  regenerating them costs API budget and time.
- **Secrets.**  `ENCRYPTION_KEY` and every provider credential live in Infisical, not in any
  of these backups.  A restored `app.db` contains encrypted API keys that are **undecryptable
  without the Infisical `ENCRYPTION_KEY`**.  Losing Infisical loses the ability to use a
  perfectly good restore.  Infisical's own durability is out of scope for this document and
  is a genuine single point of failure.
- **The buckets themselves.**  Nothing backs up B2 or R2.  The protection against losing one
  is that there are two, on different providers.
- **Deleted-then-replicated data inside the tier-1 window.**  Litestream keeps 7 days of LTX
  snapshot history; a destructive change discovered on day 8 is recoverable only from the
  weekly cold archive or a host snapshot.
- **Point-in-time recovery on tiers 2, 3, and 4.**  They are discrete copies, not a log.
  Only tier 1 supports `litestream restore -timestamp`.
- **Config and code.**  Git and the container image, not this policy.

---

## 5.  Verification — the part that makes them backups

> An untested backup is a hypothesis.  A tier with no restore proof does not count toward
> coverage, however green its health field is.

Every tier publishes a "we wrote bytes" signal.  Writing bytes is not the property we care
about.  Three checks run at different depths:

| Check | Proves | Where | Cadence |
|---|---|---|---|
| **Pre-upload artifact verification** | The file about to become the cold archive is a coherent SQLite database that still contains trading state | `src/lib/r2-cold-snapshot.ts` — `PRAGMA integrity_check` plus non-empty assertions on `audit_events`, `trade_proposals`, `portfolio_snapshots`, `connected_accounts`, `settings`, `llm_usage`, run in the snapshot child before a single byte is uploaded | every weekly run |
| **Cold-archive restore drill** | The object *in R2* can be downloaded, decompressed, and opened as a working database | `scripts/ops/verify-cold-snapshot-restore.mjs` | monthly, and after any change to the cold-snapshot lane |
| **Continuous-replication restore drill** | The B2 replica can be restored to a scratch file and matches live | `scripts/litestream-restore-drill.sh` | quarterly, and after any Litestream version or config change |

Two design notes that are easy to get wrong:

- **`PRAGMA integrity_check` alone is not enough.**  It answers "is this a well-formed SQLite
  file", not "does it still contain the data".  A structurally perfect *empty* database
  passes it.  Both the in-app check and the restore drill therefore also assert that tables
  which are populated in the live database are populated in the copy.
- **Exact row equality is not required and must not be asserted.**  The live database is
  written continuously, so any copy legitimately trails it.  The assertion is "non-empty",
  not "equal".

Record every drill result in `docs/rollouts/YYYY-MM-DD-<slug>.md` and on THE BOARD.  A drill
that was run but not written down is a drill that will be run again next quarter by someone
who cannot tell whether it ever passed.

### Running the cold-archive drill

```bash
# Inventory only — cheap, proves credentials and shows archive depth
node scripts/ops/verify-cold-snapshot-restore.mjs --list

# Full round trip: download, gunzip, integrity_check, row-count assertions, discard
RESTORE_DRILL_SCRATCH_DIR=/tmp/restore-drill \
  node scripts/ops/verify-cold-snapshot-restore.mjs --receipt /tmp/restore-receipt.json
```

Exit `0` verified, `2` auth failure, `3` **verification failed — the archive is not provably
restorable**.  It needs free scratch space of roughly the uncompressed database size (~11 GB
today).  R2 egress is free, so the drill costs disk and time, not money.  The script has no
DELETE path of any kind and removes only the scratch copy it made.

---

## 6.  Alerting

| Tier | Signal | Path |
|---|---|---|
| 1 | `checks.storage.litestream*`, `litestreamDegradedReasons`, `litestreamTiers*` | `app/api/health/route.ts` calls `alertStorageWarning` on each degradation reason (12 h per-type cooldown).  Fires on health requests, which the Coolify healthcheck makes continuously. |
| 3 | `checks.storage.r2Weekly` | `reportR2WeeklyFreshness()` in the scheduler lane — one Sentry event per state transition plus `r2_cold_snapshot_stale`.  Run failures also emit `r2_cold_snapshot_failed` immediately. |
| 2 | **none** | The host cron writes to `/var/log/fleet-backup/*.log` and nothing reads them.  See §8. |
| 4 | Hetzner console | Not wired into the app. |

The lesson from the 2026-09-06 incident is worth restating: `checks.storage.r2Weekly` had been
correct and red for nine days.  The check was never the problem — **nothing was reading it**.
A health field with no watcher is documentation, not monitoring.

---

## 7.  Mechanisms that do not work on a database this size

Both of these have already caused a silent multi-day outage of a backup tier.  Neither is a
theory.

**`sqlite3_backup_step` / better-sqlite3 `backup()` / `sqlite3 .backup` restart from page 1
whenever the source is written through another connection.**  `app.db` is written
continuously by the app and checkpointed by Litestream, so on a ~11 GB database the copy
never converges.  Reproduced on better-sqlite3 13.0.3: 2,698 restarts in 15 seconds with
`remainingPages` pinned.  It **hangs** rather than failing, so no error path runs and nothing
alerts.  Tier 3 hit this and stalled for 9 days (fixed in #3192).  **Tier 2 still uses
`sqlite3 .backup` and is hitting it now** (§8).

**Use `VACUUM INTO` instead.**  It runs inside one read transaction, so concurrent writers
cannot restart it, and it emits a compacted copy.  Same source, same concurrent writer: 117 ms
versus never.  It is synchronous and must run in a child process so it cannot block the event
loop or stall `/api/health` into a healthcheck restart.

**Bound every phase, not just the slow-looking one.**  #3192 bounded the snapshot step; the
very first run under that fix died in the *upload* instead, unbounded, and only stopped when
the 2 h job lease expired.  As of 2026-09-09 the whole attempt is bounded
(`R2_COLD_SNAPSHOT_ATTEMPT_DEADLINE_MIN`, default 90 min) and the deadline **aborts in-flight
S3 requests** rather than abandoning them.

Three properties that make that bound actually hold, each of which was wrong in the first
draft of the change and was caught in review:

- **The deadline is clamped below the job lease** (`R2_COLD_SNAPSHOT_MAX_ATTEMPT_DEADLINE_MS`
  = lease − 15 min), not merely documented as "must stay under it".  An env of 120 min would
  otherwise be honoured, and an attempt still running when the next drain reclaims the job
  starts a second multi-GB snapshot, sweeps the first attempt's temp file out from under its
  open fd, and races an upload to the same weekly key.
- **Child deadlines draw down the shared attempt budget** rather than each starting a fresh
  full-size timer.  A child handed 45 minutes when 3 remain outlives the parent that is
  already reporting failure.
- **The failure path can still abort an upload it never learned the id of.**  The deadline
  can fire between R2 minting an upload id and the calling scope assigning it; cleanup waits
  (briefly, and bounded — the hang may be the create itself) for that to settle.

**A timeout that deletes its output and reports success is worse than no timeout.**  See
§8.1: the host tier now does exactly this.  Bounding without alerting converts a loud hang
into a quiet nothing, which is strictly harder to notice.

---

## 8.  Known gaps and owner decisions — as of 2026-09-09

### 8.1  Tier 2 (host 6-hourly dumps) is broken.  Owner action required.

Not fixable from this repo — the script lives at `/usr/local/sbin/fleet-sqlite-backup.sh` on
the host.

Evidence read 2026-09-09:

- `/data/backups/socratic/` contains exactly **one** dump,
  `socratic-app-20260906T121501Z.db` (10,607,546,368 bytes), finished 2026-09-07T11:59Z.
  Retention asks for two.  Nothing has been produced since.
- That dump took **~23.7 hours** to write.  It is `sqlite3 .backup` against the live volume,
  the mechanism described in §7.
- Its 6-hourly cron then logged `SKIP already running (lock held)` on every subsequent tick
  from 2026-09-07T18:15Z through 2026-09-09T12:15Z, because the previous run still held the
  `flock`.
- The hardened version installed 2026-09-08T03:24Z bounds the dump at
  `FLEET_BACKUP_TIMEOUT=30m`.  A copy that takes ~24 h will now be killed at 30 minutes, its
  output deleted, and the run will `return 0` — **failing silently, forever, on every tick**.

Recommended fix (owner or a fleet-ops lane, not this repo): replace
`sqlite3 "$src" ".backup '$dest'"` with `sqlite3 "$src" "VACUUM INTO '$dest'"`, and make a
timed-out or failed dump raise an alert instead of `return 0`.  The same change applies to
Congress.Trade and Usage-Monitor, whose databases are smaller and therefore still succeeding
— for now.

Also worth an owner decision: `fleet-backup-verify-weekly.sh` **failed for socratic on
2026-09-06** (`Error: in prepare, file is not a database (26)`) and the only place that
appeared was `/var/log/fleet-backup/cron-weekly.log`.  A verification that fails into a log
file nobody reads is indistinguishable from one that never ran.

### 8.2  Backblaze growth — the ~535 GB figure is stale.  No pruning needed.

An earlier board row recorded ~535 GB across three B2 buckets under the `hetzner/` prefix,
growing ~45 GB/day.  **Re-measured 2026-09-09 with `rclone size`; it is no longer true.**  The
`B2_KEEP_SETS` prune added 2026-08-31 fixed it.

| Bucket / prefix | Objects | Size |
|---|---|---|
| `jays-socratic-trade-eu/hetzner/` | 8 | 34.236 GiB |
| `jays-socratic-trade-eu/trading-live/` (Litestream) | 5,910 | 56.343 GiB |
| `jays-socratic-trade-eu` **total** | 5,918 | **90.579 GiB** |
| `jays-congress-trade-eu/hetzner/` | 6 | 5.055 GiB |
| `jays-usage-monitor-eu/hetzner/` | 4 | 1.989 GiB |
| **All three `hetzner/` prefixes** | 18 | **41.280 GiB** |

Including B2 file versions changes nothing (`rclone size --b2-versions` returns the same
34.236 GiB for the socratic `hetzner/` prefix).  **No deletion is proposed and none is
needed.**

### 8.3  The cold archive is still at depth one until the next successful run.

Live read 2026-09-09T14:00Z via the Cloudflare R2 analytics API: `socratic-trade-bucket`
`objectCount=1`, `payloadSize=9,679,310,848`, sole key `cold-snapshots/app-2026-08-30.db`.
The retain change to 4 takes effect as snapshots accumulate; it cannot conjure history that
was already pruned.  Expect depth 2 after the first successful Sunday run, 4 after four.

Nothing in this policy deletes that 9.68 GB legacy object.  With `retain = 4` it is simply
kept, which is the desired outcome and needs no approval.

**It is also known-good.**  A full restore drill on 2026-09-09 downloaded that exact object
(9,679,310,848 bytes, 127 s), opened it, and got `PRAGMA integrity_check` = `ok` with every key
table populated: `audit_events` 262,290, `trade_proposals` 803, `portfolio_snapshots` 1,755,
`connected_accounts` 7, `settings` 664, `llm_usage` 2,491 — each trailing the live counts as a
2026-08-30 snapshot should.  The archive tier is **stale, not broken**.

### 8.4  Weekly job `week-2026-09-06` is terminally `unresolvable`.

It reached `attempts = 31` — 30 of those were the pre-#3192 hang re-claiming an expired
lease, not real failures — and then exhausted its budget on its first genuine error.  The
next scheduled run is `week-2026-09-13` (Sunday 03:17 UTC), which is unaffected.  If the
archive needs to advance sooner, enqueue a fresh due-job row rather than resurrecting the
dead one.

---

## 9.  Restore runbooks

### From tier 1 (B2, Litestream) — the default

```bash
# On the box.  ALWAYS restore to a scratch path first; never over the live app.db.
litestream restore -config /app/litestream.coolify.yml \
  -o /data/scratch/app-restore-$(date -u +%Y%m%dT%H%M%SZ).db /app/data/app.db
sqlite3 <scratch> 'PRAGMA integrity_check;'
```

Add `-timestamp <ISO8601>` for point-in-time recovery inside the 7-day window.

**Run it on the HOST, not inside the app container.**  Verified 2026-09-09: the host has
`litestream` 0.5.16 and `sqlite3` 3.46.1; the runtime image has **neither** — it ships no
`sqlite3` CLI, and `coolify-prod-start.sh` puts Litestream on PID 1's `PATH` only, which a
later `docker exec` does not inherit.  Credentials come from Infisical via the running
Litestream process and are **not** inherited by a fresh shell: export them into the drill
shell from a trusted source, never into a file that outlives the drill.

The R2 cold-archive drill is the opposite — `verify-cold-snapshot-restore.mjs` uses the
bundled `better-sqlite3`, needs no `sqlite3` CLI, and does run inside the container —
**but only when `AWS_R2_HISTORIC_*` are present**.  A bare `docker exec` shell does not
inherit Infisical secrets from PID 1; wrap the drill in `scripts/infisical-run.mjs`
(or re-exec through the same Infisical path the app uses) so those credentials load.

### From tier 3 (R2, weekly cold archive)

```bash
# Inside the app container, through Infisical (so AWS_R2_HISTORIC_* are set):
node scripts/infisical-run.mjs -- node scripts/ops/verify-cold-snapshot-restore.mjs --list
node scripts/infisical-run.mjs -- node scripts/ops/verify-cold-snapshot-restore.mjs --key cold-snapshots/app-<date>.db.gz
```

Objects since 2026-08-31 are gzipped and need `gunzip` first; the script does this for you.
Objects before that are raw `.db`.

### From tier 2 (host-local)

```bash
sha256sum -c /data/backups/socratic/<file>.db.sha256
sqlite3 /data/backups/socratic/<file>.db 'PRAGMA integrity_check;'
```

### Cutting over to a restored file

Out of scope for this document on purpose — swapping the live database is a deploy-class
operation with a stop, a Litestream re-seed, and a `FORCE_RESTORE` decision.  Do not
improvise it during an incident from this page.

---

## 10.  Change log

| Date | Change |
|---|---|
| 2026-09-09 | **Cold-archive restore PROVEN** — `cold-snapshots/app-2026-08-30.db` restored from R2, `integrity_check` ok, key tables populated (receipt in `docs/rollouts/2026-09-09-backup-methodology.md`).  This policy written.  Cold retention 1 → 4; `R2_COLD_SNAPSHOT_RETAIN` can now raise retention rather than only lower it; whole-attempt deadline with S3 request abort; bounded per-request retries; `fetch failed` cause unwrapping; pre-upload artifact verification; `scripts/ops/verify-cold-snapshot-restore.mjs`; `scripts/litestream-restore-drill.sh` repointed at B2 and the real production paths. |
| 2026-09-08 | #3192 — cold snapshot moved from better-sqlite3 `backup()` to `VACUUM INTO` in a child process; snapshot-step deadline; Sentry freshness watchdog. |
| 2026-08-31 | #3135 — cold snapshot gzip-streamed.  `B2_KEEP_SETS` prune added to the host tier. |
| 2026-08-18 | First proven restore: B2 → scratch, integrity ok, row counts compared (`docs/rollouts/2026-08-17-litestream-restore-drill.md`). |
| 2026-08-08 | Weekly R2 cold archive introduced as second-provider DR (`docs/rollouts/2026-08-08-r2-cold-snapshot.md`). |
| 2026-08-07 | Litestream's active replica moved R2 → B2 (#2584). |
