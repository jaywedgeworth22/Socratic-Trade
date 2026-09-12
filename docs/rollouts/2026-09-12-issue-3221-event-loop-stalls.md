# Issue 3221: Event-loop stall elimination & Scheduler enhancements

## Context & Objective
Issue #3221 aims to address event-loop stalls triggered by synchronous SQLite writes on the main thread during high-frequency outbound API calls (via `logApiHealth`), and to prevent concurrent scheduler ticks by attaching an AbortController pipeline to the scheduler watchdog. It also addresses a timezone bug in `isTradingDay` and optimizes the `hasLiveStrategyRunLease` SQLite index scan.

## Changes Made
- `src/lib/db-health.ts`: Modified `logApiHealth` to buffer health insertions in memory, flushing them in 5-second batches using `flushApiHealthBuffer`. This eliminates synchronous `db.transaction()` writes blocking the main thread on every API call.
- `src/lib/scheduler.ts`: Introduced `__tickAbortController` to the `tickGuardHost`. The watchdog `runSchedulerTickWatchdog()` now calls `.abort()` on it to cancel any running loops in `tickInner`, preventing overlapping concurrent I/O. Added `signal?.throwIfAborted()` checks in the main loops.
- `src/lib/market-hours.ts`: Fixed the timezone bug in `isTradingDay` by using `America/New_York` (ET) explicitly instead of the server's local timezone (UTC), ensuring that weekends and holidays are correctly identified based on the New York calendar day rather than UTC. Modified `adjacentTradingDayStart` to return midnight ET correctly.
- `src/lib/db-execution.ts`: Optimized `hasLiveStrategyRunLease` to replace the full-table-scanning `LIKE` clause with a strict bounded range query (`key >= ? AND key < ?`) leveraging the `sqlite_autoindex_settings_1` index.

## Decisions & Trade-offs
- Delaying health log writes by up to 5 seconds is acceptable since health telemetry is not consensus-critical.
- We opted to insert `throwIfAborted()` checks within `tickInner()` loops rather than passing the AbortSignal down into every `fetch` call across the codebase, which would be a massive, risky refactor. This guarantees the scheduler will break out of its loop during an overrun.

## Verification State
- `npm run lint` — passed
- `npx tsc --noEmit` — passed
- `npm test` — passed
- `gh pr create` — ready to merge.

## Next Steps
- Move to issue #3222 (Datadog LLMObs duplicate invocation fix).
