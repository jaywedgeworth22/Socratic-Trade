# Per-app R2 backup consolidation (2026-08-01)

## Context & objective

Owner directive: **all 3 apps must back up to R2 on their OWN Cloudflare
accounts, guaranteed free-tier safe.** End state per app:

| App | Account | Bucket | Status |
| --- | --- | --- | --- |
| Socratic-Trade | SocraticTrade.com (94ec35cf…) | socratic-trade-bucket | ✅ live since 2026-07-31; retention tuned this session |
| Congress.Trade | Congress.Trade (0e9f5a0c…) | congress-trade-bucket | ✅ wired this session (was: no continuous backup at all) |
| Usage Monitor | Usage.Jays.Services (3a936805…) | (needs backups bucket) | ⏳ blocked on owner-created R2 API token |

## Findings during mapping

- **ST**: bucket growth measured at ~3 GB/day — DB is 1.5 GB (daily snapshot)
  plus heavy WAL LTX churn. The `ltx` listing showed the live WAL window is
  tiny (21 files); storage is snapshot+history dominated. Consequence: the
  10 GiB free tier only holds ~3 days of history.
- **CT**: had NO continuous backup — `congress-trade-bucket`'s 1.97 GiB was
  from one-off uploads (Grok's cutover scripts). No litestream anywhere for
  the congress DB. CT Infisical already had the correct AWS_* R2 creds.
- **UM**: contrary to the dry-run's "Garage S3" reading, UM's litestream
  already targets R2 — but on the **254301ba… account** (the old/shared one),
  not UM's own 3a936805… account. UM's Infisical has no R2 creds for its own
  account, and permanent R2 API tokens are dashboard-only.

## Changes made

**ST (repo, PR #2334 + #2338):** litestream `snapshot.retention` 720h → 48h.
Rationale (measured, documented in the yml comment): ~3 GB/day growth →
~6 GiB steady state at 48h — safely under both the 10 GiB cap and the 70%
(7 GiB) monitor alert line. 168h (7d) would project to ~21 GB — a breach.
Deeper PITR is an economics choice (R2 paid ≈ $0.015/GB-mo), not a technical
limit.

**CT (host-level, no repo change):** new `litestream-congress` systemd unit
on the Oracle box replicating `/data/congress-trade/db.sqlite` →
`congress-trade-bucket` (path `congress-trade/db.sqlite`):
- binary: pinned litestream 0.5.12 copied to `/usr/local/bin/litestream`
- config: `/etc/litestream/congress.yml` (retention 72h — safe at 709 MB DB;
  sync-interval 10s socket-leak mitigation)
- creds: `/etc/litestream/congress.env` (0600, from CT Infisical AWS_*)
- enabled + started; first snapshot (277 MB compressed) verified in-bucket
  at 23:52 UTC; service active, zero errors.

**R2 monitor:** PR #2332 (merged) now watches all three accounts
(st/ct/um slots) with per-account alert state — CT's new backup growth is
covered automatically.

## Verification state

- CT: `systemctl is-active litestream-congress` = active; `snapshot complete`
  in journal; CT bucket object count +4 and payload growing post-start.
- ST: retention PR #2338 open with auto-merge (verify CI).
- UM: blocked (below).

## Next steps & blockers

- **UM — OWNER STEP (2 min):** Cloudflare dashboard → Usage.Jays.Services
  account (3a936805…) → R2 → Manage R2 API Tokens → create token (Object
  Read & Write). Then an agent creates a `usage-monitor-backups` bucket,
  updates UM Infisical (new AWS_* set per the fleet naming convention), and
  restarts `oracle-app-1`. The current replica to the 254301ba… account
  keeps working until then (no gap).
- Weekly ops digest will track CT/UM growth rates once a few days of data
  exist; ST steady state should settle ~6 GiB as the 48h window slides.
