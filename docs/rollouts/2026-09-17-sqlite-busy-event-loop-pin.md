# SQLITE_BUSY event-loop pin + yield (board e7b49943)

## Context & Objective

ST production keeps event-loop stalling about every 30 minutes during RTH.  Docker restart of `st-appworker` recovers briefly; Coolify Deploy is not the recovery.  Root cause: serving-process `better-sqlite3` `busy_timeout = 60000` sleeps the Node event loop on `SQLITE_BUSY`, so `GET /api/live` and `GET /api/health` cannot run (Traefik 503 "no available server") while Docker still reports healthy.  This lands the existing pin+yield WIP as a PR.  Extra-ship no.  No Coolify Deploy.  Do not restart production from this lane.

## Changes Made

Serving-connection `busy_timeout` is now a short pin (`SQLITE_BUSY_PIN_MS = 100`).  Async callers keep the historical 60s lock budget via `sqliteYieldRetry` (yield between SQLITE_BUSY retries).  Safety lanes yield so `/api/health` can run.  FTS/filing/transcript producers defer during regular US equity hours (durable watermarks unchanged).  Task-journal prune is bounded at 500 rows per tick.

- `src/lib/sqlite-event-loop.ts` (new)
- `test/sqlite-event-loop-stall.test.ts` (new)
- `src/lib/db.ts` — `busy_timeout` uses `SQLITE_BUSY_PIN_MS`
- `src/lib/db-learning.ts` — FTS batch groups go through `sqliteYieldRetry`
- `src/lib/db-task-journal.ts` — `TASK_JOURNAL_PRUNE_BATCH_LIMIT = 500`
- `src/lib/task-journal.ts` — journal start/end via `sqliteYieldRetry`
- `src/lib/order-replacement.ts` — stale-exit insert tx via `sqliteYieldRetry`
- `src/lib/safety-maintenance.ts` — yield before the maintenance pass
- `src/lib/scheduler.ts` — skip FTS/filing/transcript ingest during RTH
- `src/lib/stale-limit-orders.ts` — yield + yield-retry around sqlite writes
- `src/lib/synthetic-stops.ts` — yield-retry sqlite reads/writes; per-statement retry on non-idempotent generation advance
- `STATUS.md`, `PLAN.md`, `docs/EFFORT-LOG.md`, `/Users/jay/apps/TRADING-EFFORT-LOG.md`

## Decisions & Trade-offs

- Do not simply drop the 60s lock budget.  `#1728` raised 30s → 60s because money-path writers fail when the wait is too short.  The 60s budget is preserved in JS (`SQLITE_BUSY_RETRY_BUDGET_MS`) with yields so HTTP can run.
- Native pin is 100ms, not 0.  A zero timeout turns every contended write into an immediate `SQLITE_BUSY`; a short pin still absorbs micro-contention without freezing health probes.
- RTH RAG deferral is a skip of this tick, not a dropped watermark.  After cash close the same due flags fire.
- Non-idempotent `fire_generation += 1` is retried per statement so a busy audit cannot advance generation twice.
- Finish-only: no redesign, no production restart, no Coolify Deploy, no extra-ship.

## Verification State

- Focused: `npx vitest run test/sqlite-event-loop-stall.test.ts` (run after PR open; prior job timed out at 900s without committing).
- Full AGENTS.md quartet (`lint` / `tsc` / `test` / `build`) is the hosted `verify` gate on the PR.  This lane prioritized commit+push+PR over a local full gate.

## Next Steps & Blockers

- Hosted `verify` must go green before merge.
- Do not merge from this lane during weekday RTH unless the owner sets `HOTFIX=1` / `RTH_DEPLOY_OVERRIDE=1`.  Evening/weekend auto-deploy still applies after merge.
- Docker restart remains temporary recovery until this image is live.  Do not Coolify Deploy from this lane.
- After merge, watch `/api/health` and safety-lane `event_loop_stall` attribution for the ~30-minute recurrence.

## Zero-Code Findings

Live 2026-09-17 ~13:57Z: public `/api/health` returned Traefik 503; in-container health curl timed out 14s; docker restart at 13:58:47Z restored 200 on the same sha.  Recurrence class matches this pin, not a Coolify image mismatch.
