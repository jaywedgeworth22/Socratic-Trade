# 2026-07-12 — Sentry Issues Resolution

**Author**: Antigravity (AG)
**Branch**: `agent/antigravity`

## Summary
Resolved two unresolved sets of issues occurring in the production Sentry project for Socratic-Trade:
1. **RangeError on `/console`**: A recursive array spreading limit exception on Safari iOS devices.
2. **Noisy Provider Limit Sentry Alerts**: `alertConnectionFailure` generated Sentry events for expected API rate limits from Tiingo, Alpha Vantage, and Congress.Trade SSE stream.

## Why
* Users loading `/console` with a massive dataset of equity points (`liveEquityCurve`) were crashing on Mobile Safari due to a stack overflow when `...data.map()` exceeded Safari's call stack argument limit (typically ~65k, but easily surpassed). Replacing `Math.max(...data)` with standard `data.reduce()` handles indefinitely large arrays safely.
* The API providers `tiingo`, `alpha-vantage`, and `congress.trade:sse` hit 429s or daily quotas normally. `fetchWithRetry` correctly logged them as `ok: false`, triggering the circuit breaker after 5 failures to stop spamming the provider. However, the circuit-breaker trip also alerted Sentry via `alertConnectionFailure`. This created noisy, unactionable issues for developers. We now silence Sentry alerts specifically for `429` and `rate limit` errors, maintaining the breaker trip functionality.

## Files Touched
* `app/console/components/equity-chart.tsx`: Converted `Math.max` and `Math.min` over spread array mappings to `.reduce`.
* `src/lib/db-health.ts`: Modified `logApiHealth` to regex-test `opts.errorText` for `/429|rate limit/i` and conditionally bypass `alertConnectionFailure`.
* `STATUS.md`: Added entry for Sentry resolution.
* `docs/EFFORT-LOG.md`: Logged effort completion.

## Verification
- `npm run lint` — passed.
- `npx tsc --noEmit` — passed.
- `npm test` — passed (3896 tests).
- `npm run build` — passed.

## Follow-ups
- Merge to `main`.
