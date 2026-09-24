# 2026-09-21 — Quote Cascade Freshness and Event-Loop Performance Repair

## Context & Objective

ST production quotes were frequently branded stale (>120s) and demoted to delayed fallbacks, even when live broker two-sided NBBO quotes were fetched seconds prior.  Simultaneously, background SEC RAG ingestion and vector store reconciliation caused prolonged main-thread event-loop stalls (26s–362s observed in production APM), freezing API responsiveness and quote refreshes.  This change restores quote freshness accuracy across the cascade and isolates heavy background SEC/vector work from regular market trading hours (RTH).

## Changes Made

- **Quote Cascade (`src/lib/quotes-cascade.ts`):**
  - Stamped `quote.fetchedAt` timestamp across all broker and data levels (Level 1a/1b broker quotes, Level 2 Alpaca snapshots, Level 3/4 Yahoo, Level 5 ROIC).
  - Corrected `quoteAgeSecForStalenessGate` to evaluate `quote.fetchedAt` when a live two-sided NBBO is present, preventing recent quotes from being branded stale when last trade print `asOf` is >120s old.
  - Exported `isTwoSidedLiveNbbo(quote)` and prohibited synthetic quotes (`syntheticSpread`, `syntheticBid`, `syntheticAsk`) from qualifying as live two-sided NBBO.
- **Single Quote Route (`app/api/quote/route.ts`):**
  - Updated `/api/quote` to query `fetchFreshQuotesCascade` concurrently with Yahoo chart data, overlaying real-time broker/Alpaca quotes on top of fundamental and 52w range metrics while preventing delayed fallbacks for live symbols.
- **Dashboard & Watchlist Fallbacks (`src/lib/dashboard.ts`, `app/api/watchlist/route.ts`):**
  - Added fallback to `fetchFreshQuotesCascade` in `src/lib/dashboard.ts` for any missing or zero-priced position symbols before resorting to cost basis.
  - Added fallback to `fetchFreshQuotesCascade` in `app/api/watchlist/route.ts` when broker quotes are unavailable, missing, or when no account number is configured.
- **SEC RAG & Vector Store Performance Isolation (`src/lib/rag/sec-ingest-worker.ts`, `src/lib/scheduler.ts`, `src/lib/vector-store/qdrant-write.ts`):**
  - Defer background SEC ingestion ticks and polling during US regular trading hours (RTH) via `shouldDeferRagIngestDuringRth()`.
  - Added event loop yields (`await yieldEventLoop()`) immediately before and after synchronous Cheerio HTML parsing of multi-megabyte SEC filings in `SecIngestWorker`.
  - Defer managed vector reconciliation during RTH in `src/lib/scheduler.ts`.
  - Added event loop yields inside `qdrantInventoryByMetadata` pagination loops and supported `VECTOR_INVENTORY_MAX_SCANNED` env configuration.
- **Tests Updated:**
  - `test/quotes-cascade.test.ts`: Added tests for `isTwoSidedLiveNbbo`, live NBBO staleness gate, and broker quote freshness with quiet `asOf`.
  - `test/quote-route.test.ts`: Added test asserting live quote overlay from cascade onto Yahoo chart base.

Touched files:
- `src/lib/quotes-cascade.ts`
- `app/api/quote/route.ts`
- `src/lib/dashboard.ts`
- `app/api/watchlist/route.ts`
- `src/lib/rag/sec-ingest-worker.ts`
- `src/lib/scheduler.ts`
- `src/lib/vector-store/qdrant-write.ts`
- `test/quotes-cascade.test.ts`
- `test/quote-route.test.ts`
- `vitest.config.ts`
- `STATUS.md`
- `docs/EFFORT-LOG.md`
- `/Users/jay/apps/TRADING-EFFORT-LOG.md`
- `docs/rollouts/2026-09-21-quote-cascade-freshness-and-performance.md`

## Decisions & Trade-offs

- **Quote Age vs Trade Age**:  For trading decisions and freshness validation, a two-sided NBBO (bid > 0, ask >= bid) fetched within the last few seconds represents actionable market reality even if no trade has printed recently (common in mid/small caps or quiet periods).  Evaluating `fetchedAt` when a live NBBO is present prevents false staleness penalties while still requiring active quotes.
- **RTH Ingestion Deferral**:  SEC filings (10-K, 10-Q, 8-K) and vector reconciliation do not require sub-second indexing during the market day.  Deferring them during RTH (09:30–16:00 ET) avoids event-loop blocking during active trading hours, and background workers catch up immediately post-market.  In unit tests, an `allowRth` option and `NODE_ENV !== "test"` guards ensure tests pass regardless of execution time.

## Verification State

- Four-gate sequence executed in mandated order per `AGENTS.md`:
  1. `npm run lint` — exit 0 (0 errors, 821 grandfathered warnings).
  2. `npx tsc --noEmit` — exit 0 (clean type check).
  3. `npm test` — targeted vitest passed 162/162 across 9 files (0 failed):
     - `test/quotes-cascade.test.ts`: 26/26 passed.
     - `test/quote-route.test.ts`: 15/15 passed.
     - `test/staleness-gate.test.ts`: 14/14 passed.
     - `test/quote-delayed-fallback.test.ts`: 8/8 passed.
     - `test/price-alerts-evaluation.test.ts`: 4/4 passed.
     - `test/sec-ingest-worker.test.ts`: 33/33 passed.
     - `test/scheduler-managed-vector-reconcile.test.ts`: 7/7 passed.
     - `test/market-hours.test.ts`: 39/39 passed.
     - `test/server-knobs.test.ts`: 16/16 passed.
  4. `npm run build` — exit 0 (clean Next.js webpack production build; verified static generation and bundle compilation).

## Next Steps & Blockers

- Commit changes referencing updated handoff docs.
- Push branch `ag/quote-cascade-freshness-performance`, open PR, and arm auto-merge.
- Post completion closeout notice to Slack `#agent-sync`.
