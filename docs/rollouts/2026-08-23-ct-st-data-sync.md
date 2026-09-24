# Data Synchronization & Latency Propagation

## Context & Objective
The user requested that we ensure Congress.Trade (CT) is properly coordinating and exchanging data with Socratic-Trade (ST). Specifically, CT must share real-time and EOD prices with ST, track competitor trade publication latency, and provide that latency data to ST's LLM trade proposers.

## Changes Made
- ST already shares EOD pricing, SPX closes, and reference data to CT daily via `runCongressDailyShare`.
- CT already polls ST for real-time and intraday prices via `latencyPriceSnapshots.ts` (added `-15m` and `+12hr` in a previous session).
- **Latency Data Propagation (CT -> ST)**:
  - Updated `buildTransactionsQuery` in CT's `app/src/delivery/rows.ts` to `LEFT JOIN` the `trade_latency_candidates` table.
  - Selected `provider_published_at` and dynamically calculated `latency_probe_delay_ms` and `latency_probe_health` (`healthy` if <= 10m, otherwise `degraded`).
  - Added these fields to `FeedTransactionRow` and mapped them in `mapFeedTransaction` so they are exposed on CT's `/api/transactions` endpoint.
  - ST's daily `refreshCongress` job paginates over this endpoint and natively picks up the latency data using `coerceCongressTrade` (added last session) and exposes it to the LLM trade proposer via `buildBulletin`.
- **Test Fixes**:
  - Fixed `app/src/ingestion/__tests__/latencyPriceSnapshots.test.ts` to assert the newly added `-15m` and `+12hr` snapshot plan events.
  - Updated mock DB schemas in four CT delivery/analytics test files to include the missing `trade_latency_candidates` table.

## Decisions & Trade-offs
- We expose the latency data to ST via the paginated `/api/transactions` endpoint rather than just the initial webhook. Webhooks fire upon extraction, before the competitor publishes, meaning latency data would be absent. ST's nightly `refreshCongress` pulls recent trades up to 67 days old, ensuring ST passively receives updated latency data as CT discovers competitor publications over time.
- `trade_latency_candidates` matches using `doc_id`, `ticker`, `tx_date`, and `tx_type` rather than `trade_hash` in `buildTransactionsQuery` because `trade_hash` is not explicitly stored in `transactions`.

## Verification State
- `npx tsc --noEmit` and `npm run lint` on ST (passed, warnings only).
- `npm run lint`, `npm run typecheck` and `npm test` on CT (passed).

## Next Steps & Blockers
- None. The ST <-> CT synchronization loop is fully wired. ST LLMs now possess competitor tracking statistics for their strategy decisions.
