# Rollout Note: Fill-Out Data Cascade — Review-Findings Sweep (PR #3449)

**Date:** 2026-09-21
**Agent:** MUSE (fleet PR-merge sweep, board `e146fd05`)
**Branch:** `ag/fill-out-data-cascade`
**PR:** #3449 — `[AG] Complete and fill out quote data cascade with multi-provider coalescing` (stacked on #3448)

---

## 1. Context & Objective

PR #3449 fills out the quote data cascade with multi-provider coalescing (broker → Alpaca → Finnhub → Tiingo → Yahoo → ROIC).  Codex/Sentry review raised nine findings on the PR; five were already fixed by the #3448 freshness-repair round merged into this branch (Yahoo `prevClose` fallback, route Yahoo-floor blocking, watchlist stale-`session-close` suppression, crossed-book NBBO rejection, per-task SEC RTH rechecks).  This round fixes the four remaining #3449-specific findings, merges current `main` and the updated #3448 branch, and runs the full verification gate.

## 2. Changes Made

### Finding 1 — Fresh-but-field-incomplete quotes stop the cascade (Codex P1)
- New exported `isCascadeFieldComplete(quote)`: a quote stops the cascade only when it carries price, a two-sided book, `prevClose`, and session OHLC.
- New `acceptIfComplete(symbol, quote)` gate in `fetchFreshQuotesCascade` replaces the six bare `isQuoteFresh` accept sites (Levels 2–7) and the Level 1b secondary-broker accept.  The *merged* best quote is what gets accepted, so a later level that completes the field set stops the cascade.
- Fresh-but-incomplete quotes stay in `pendingSymbols`; the end-of-cascade fallback still returns the best merged quote, so no symbol loses its price.
- Level 1a venue-authoritative path keeps its unconditional accept (active execution venue's price is authoritative by owner rule).
- VWAP deliberately excluded from the completeness set: it is effectively single-provider (Alpaca); requiring it would force every non-Alpaca symbol through all seven levels on every refresh, conflicting with the quota-protection finding below.

### Finding 2 — Per-field provenance in merge + persistence (Codex P1)
- New `QuoteFieldProvenance` (`provider`/`asOf`/`fetchedAt`) and optional `BrokerQuote.fieldProvenance`.
- `mergeBrokerQuoteFields` now stamps every tracked field (price, bid/ask, sizes, volume, prevClose, OHLC, close, vwap, change/changePct, netChange, companyName) with the winning quote's own provider/timestamps in all three merge cases; prior receipts ride along.
- `syncQuotesToFieldStore` persists each field with its own provenance, falling back to the merged quote-level stamps only when no per-field receipt exists.  A Finnhub price merged with an older broker bid is no longer stored as though Finnhub supplied the bid.

### Finding 3 — Enrichment wiring for the new quote fields (Codex P1)
- `bidSize`, `askSize`, `prevClose`, `open`, `high`, `low`, `netChange` added to `EnrichmentSourcedField`, the `EMPTY_SOURCED` arbitration marker set, and the cascade's `takeScalar` loop in `src/lib/data-providers.ts`; `EnrichmentSources` and `MarketQuote` extended for `bidSize`/`askSize`.
- `applyEnrichment` (`src/lib/market.ts`) now carries all seven fields onto the `MarketQuote` (positive-number guards for sizes/prices, numeric guard for `netChange`).

### Finding 4 — Finnhub/Tiingo rate guards (Codex P1)
- `fetchFinnhubQuote` is paced through `withProviderLimit("finnhub")` like every other Finnhub call site.
- `fetchTiingoQuote` admits each call against the shared `tiingo` quota bucket (`admitProviderRequests` keyed by `apiKeyFingerprint`, the same lane `history.ts` and the Tiingo enrichment provider draw from; skips the symbol when the budget is exhausted) and passes `retries: 0` so no uncounted retry escapes the reservation.

### Merge
- Merged current `origin/main` and `origin/ag/quote-cascade-freshness-performance` (one content conflict in `src/lib/types.ts`: kept both #3449's new `BrokerQuote` fields and #3448's `venueDelayedTape`).

## 3. Verification

- `npx tsc --noEmit`: clean (no output).
- Targeted: `test/quotes-cascade.test.ts` (49), `test/market.test.ts`, `test/provenance-stamps.test.ts`, `test/data-providers.test.ts`, `test/enrichment-coverage.test.ts`, `test/enrichment-scarce-tier-gate.test.ts`, `test/quote-route.test.ts`, `test/on-demand-quote.test.ts` — all pass.
- New/updated tests: `isCascadeFieldComplete` unit tests; "does NOT stop at Level 3 (Finnhub) on a field-incomplete quote"; "does NOT stop on a fresh broker quote missing prevClose/OHLC — Alpaca backfills"; per-field provenance merge + persistence tests; Tiingo `retries: 0` and quota-exhaustion tests; `applyEnrichment` new-fields test; cascade `takeScalar` arbitration test.  Three pre-existing cascade tests had their mocks made field-complete to preserve their original intent under the new gate.
- **Full gate, run IN ORDER on the pushed head `55060c6b` (after push, so every number below is from this head):**
  - `npm run lint`: **0 errors**, 825 warnings (repo-pre-existing; changed files contribute 0)
  - `npx tsc --noEmit`: **clean**
  - `npm test`: **8204 passed / 51 skipped / 0 failed** (8255 total, ~818s)
  - `npm run build`: **EXIT=0**

## 4. Follow-ups / Notes

- The still-running Codex review on #3448 may post new threads; they belong to a follow-up round.
- Broker abort-signal adoption inside gateway HTTP clients remains incremental (optional `signal` param, backward compatible).
- Moving the SEC `parseFilingHtml` parse itself off the serving event loop remains tracked follow-up work (RTH rechecks before each task and before the parse are in place).
