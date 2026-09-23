# Rollout Note: Multi-Source Quote Cascade & Staleness Resolution

## 1. Context & Objective
Resolves the issue where quotes were reported as 10+ days stale. The goal was to implement a robust, redundant cascading quote provider in series to ensure Socratic-Trade always gets fresh quotes (within 16 minutes) at proposal creation, evaluation, and approval times, using every available pricing API.

## 2. Changes Made
- **[NEW]** [`src/lib/quotes-cascade.ts`](file:///Users/jay/apps/trading-antigravity/src/lib/quotes-cascade.ts): Implements `fetchFreshQuotesCascade` checking:
  1. Active broker gateway quotes (`getEquityQuotes`).
  2. Alpaca snapshots API (`AlpacaSnapshotEnrichmentProvider`).
  3. Yahoo Finance batch quotes API (`fetchYahooFinanceQuotesBatch`).
  4. Yahoo Finance single quote API (`fetchYahooFinanceQuote`).
- **[MODIFY]** [`src/lib/strategy.ts`](file:///Users/jay/apps/trading-antigravity/src/lib/strategy.ts): Integrated the cascade in the main strategy scan.
- **[MODIFY]** [`src/lib/strategy-execution.ts`](file:///Users/jay/apps/trading-antigravity/src/lib/strategy-execution.ts): Integrated the cascade in proposal approvals (`executeProposal`).
- **[MODIFY]** [`app/api/proposals/from-draft/route.ts`](file:///Users/jay/apps/trading-antigravity/app/api/proposals/from-draft/route.ts): Integrated the cascade in chat draft promotions, creating an ad-hoc `MarketScan` for preview checks.
- **[NEW]** [`test/quotes-cascade.test.ts`](file:///Users/jay/apps/trading-antigravity/test/quotes-cascade.test.ts): Unit test suite verifying cascade level transitions and stale fallback routing.

## 3. Decisions & Trade-offs
- **Freshness threshold**: 16 minutes (960 seconds).
- **Off-market fallback**: If all levels are exhausted without finding a quote under 16 minutes old (e.g. weekend or market close), the cascade falls back to the freshest quote retrieved across all levels. This prevents false-positive blocks during off-market hours while ensuring we still try every provider first.

## 4. Verification State
- **Unit Tests**: `npx vitest run test/quotes-cascade.test.ts` passes (3 tests).
- **Type Safety**: `npx tsc --noEmit` passes with 0 errors.
- **Linter**: `npm run lint` passes with 0 errors.
