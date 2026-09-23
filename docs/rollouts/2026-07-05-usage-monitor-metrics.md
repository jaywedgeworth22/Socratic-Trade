# 2026-07-05 Usage Monitor Metrics

## Summary
Added telemetry event pushing for broker account balances and limits to track tech account caps/credits accurately via the API Usage Monitor.

## Why
Socratic-Trade needs to be able to monitor the total available limits and account balances to properly handle capital limits across Robinhood and Alpaca without exceeding risk barriers or API limits.

## Files
- `src/lib/usage-monitor-push.ts`
- `src/lib/alpaca.ts`
- `src/lib/robinhood.ts`

## Verification
- `npm run lint` (passed)
- `npx tsc --noEmit` (passed)
- `npm test` (2650 tests passed)
- `npm run build` encountered local cache locks (`ENOENT pages-manifest.json`), but code was verified via unit tests and typing.

## Follow-ups
- Ensure the newly exported API Usage Monitor properly handles the `"balance"` and `"limit"` metricTypes coming from Socratic-Trade.
