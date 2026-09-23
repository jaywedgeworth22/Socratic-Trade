# 2026-07-15 - FMP coverage, market-scan reliability, and non-scan ticker sheets

## Summary

- Diagnosed the July 14 interactive Market Scan failures from production audit
  and provider-health rows.
- Removed multi-minute deep enrichment from the interactive scan request,
  reused slow facts from the latest completed strategy scan while replacing
  price-family data, coalesced identical refreshes, and bounded Nasdaq.
- Migrated Socratic-Trade's FMP lane from legacy v4 URLs to stable,
  header-authenticated company profile and insider-search endpoints.
- Expanded FMP field consumption from P/E-only ratios to valuation, leverage,
  profitability, margin, yield, company identity, classification, beta, and
  52-week range.
- Preserved the crash-durable provider-dispatch ledger's scrubbed per-operation
  labels so FMP endpoint use is visible internally without putting the API key
  in URLs.
- Made ticker sheets useful for valid symbols absent from the latest scan by
  combining a bounded company-identity/current-quote floor with the rich
  provider cascade and updating the open sheet header when identity arrives.
- Closed hostile-review freshness/reliability findings with timestamp-aware
  quote arbitration, per-user/symbol quote single-flight, 24-hour slow-only
  seed reuse, and an explicitly stale last-strategy fallback for Nasdaq outages.
- Reconciled PR #1616's concurrently landed FMP capability adapters and moved
  their shared request helper to verified header authentication plus the same
  durable per-endpoint quota/outcome ledger as production enrichment.
- Corrected prior documentation that claimed two unused v3 endpoints were live.

## Why

Production recorded `market_scan_failed` at `2026-07-14T20:35:10Z`,
`20:40:21Z`, and `20:40:34Z`, each with the same 25-second timeout. FMP was
healthy during the incident (194 successful calls and no recorded failures in
the relevant window). The cold default scan widens 30 candidates to 150
symbols, then awaited every provider. Finnhub can enqueue five calls per symbol
at 50 requests/minute, making the cold path roughly 15 minutes before Yahoo and
other providers. The route's `Promise.race` did not cancel underlying work, and
page mounts/retries had no single-flight.

The vendor screenshot is a shared-key aggregate, not a Socratic-Trade endpoint
report. Its dominant history/profile/House/Senate paths map to Congress.Trade.
Socratic-Trade actually used only ratios, grades, legacy insider/Senate calls,
and optional price targets. The three transcript attempts were not ingestion:
the Gamma helpers have no caller and the current subscription returns HTTP 402
for the stable transcript endpoint. PR #1586 later merged a separate stable,
rights-gated producer, but its production ingestion/backfill flags remain off.

## Decisions

- Endpoint count is not the success metric. Optimize field fill rate,
  freshness, provenance, ingestion lag, and decision value.
- Interactive scan returns real fast-path market data and locally reuses the
  latest strategy run's slow facts; scheduled/strategy work owns deep
  ingestion. Opening any valid ticker owns bounded on-demand detail.
- Congress.Trade remains authoritative for normalized congressional disclosure
  data; Socratic-Trade does not duplicate a per-symbol FMP Senate feed.
- FMP credentials travel in headers, never URLs.
- Transcripts remain disabled until the plan and corpus/storage rights support
  them. Structured facts remain time-indexed; narrative artifacts go to RAG.

## Files

- `app/api/quote/route.ts`
- `app/api/scan/route.ts`
- `app/console/ui/symbol-drawer.tsx`
- `app/console/ui/symbol-drilldown.tsx`
- `app/console/console.css`
- `src/lib/data-providers.ts`
- `src/lib/fmp-common.ts`
- `src/lib/fund-holdings.ts`
- `src/lib/market.ts`
- `src/lib/quote-singleflight.ts`
- `src/lib/scan-singleflight.ts`
- `src/lib/types.ts`
- `src/lib/yahoo-finance.ts`
- `test/alternative-data.test.ts`
- `test/console-drilldown.test.ts`
- `test/data-providers.test.ts`
- `test/fmp-common.test.ts`
- `test/market-dynamic-universe.test.ts`
- `test/market-preselection.test.ts`
- `test/quote-route.test.ts`
- `test/scan-singleflight.test.ts`
- `test/usage-monitor-push.test.ts`
- `docs/fmp-capabilities.md`
- `docs/phase-4-market-data-scoring.md`
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`
- `/Users/jay/apps/TRADING-EFFORT-LOG.md`

## Verification

- Production read-only `/api/health`: HTTP 200; FMP, Finnhub, Massive, Yahoo,
  DB, scheduler, and Litestream healthy at investigation time; Alpha Vantage's
  additive daily quota was exhausted.
- Production SQLite read-only audit/provider-health queries: exact failure and
  provider timing evidence summarized above.
- `npm ci`: completed; 768 packages installed.
- Ticker-sheet focused verification: 43 quote/drilldown tests passed; targeted
  Yahoo identity parser passed; scoped TypeScript and ESLint passed with zero
  errors (six inherited warnings); local `GET /api/quote?symbol=LRCX` returned
  HTTP 200 in 3.4 seconds with company identity, quote, and rich fundamentals.
- First local browser compile exposed a Tailwind/Turbopack scanner bug: a CSS
  comment containing a wildcard-shaped semantic variable generated invalid CSS.
  Reworded exact wildcard examples without changing styles;
  browser QA then continued.
- Browser QA (Codex in-app Browser, `http://localhost:3001`): added LRCX to an
  empty watchlist, opened its sheet without any market-scan snapshot, and confirmed
  the issuer name, current quote/change, sector/industry, analyst rating, and derived
  fundamentals rendered. Browser console error count: zero. Local history had no
  LRCX bars, and the sheet honestly said so instead of inventing a chart.
- Focused combined verification: 7 files / 177 tests passed; persisted-scan reuse
  adds 2 focused tests, and scoped ESLint exited zero with inherited warnings only.
- First ordered full gate: lint passed with 0 errors / 459 inherited warnings,
  TypeScript passed, and 371 files / 4,179 tests passed. The production build
  then caught that two internal quote helpers were exported from a Next.js route
  module. Removed those invalid exports; the 5 quote-route tests and a standalone
  production build with the real TypeScript phase and 32 static pages passed.
- Final corrected-tree ordered Node 24 gate: `npm run lint` passed with 0
  errors / 459 inherited warnings; `npx tsc --noEmit` passed; `npm test`
  passed 371 files / 4,179 tests; `npm run build` completed with its real
  TypeScript phase and 32 static pages.
- Reconciled current `origin/main@ede902f5`, preserving PR #1586's async
  credential fingerprint, durable per-operation dispatch ledger, and default-off
  transcript producer. Post-review/current-main verification before the final
  freshness regression: lint and standalone TypeScript passed; 9 focused files / 201 tests
  passed; diff-check clean.
- Current-main full landing gate remains before publish.
- The first `scripts/land.sh` gate passed TypeScript, 380 files / 4,375 tests,
  and the production build with 32 static pages, then pushed `d0220578` and
  opened ready PR #1618.
- While that gate ran, PR #1616 advanced `main` to `d3efc9a6` with overlapping
  FMP capability adapters. Merged that exact baseline, preserved both lanes,
  and hardened the adapter helper. A production-key read-only probe confirmed
  FMP accepts header authentication (HTTP 200; no key emitted). Post-merge
  scoped lint and TypeScript pass; 5 overlap files / 163 tests pass.
- Production `/api/health` serves exact `d3efc9a6` with DB healthy, a current
  scheduler lease, FMP healthy, and Litestream replicating.
- Final post-reconciliation `scripts/land.sh`: TypeScript passed; 381 files /
  4,377 tests passed; production build completed with 32 static pages; refreshed
  head `8949ebd8` pushed to ready PR #1618.
- Hosted review P2 remediation: added a hard 20-second interactive deadline,
  propagated aborts through Nasdaq and BlackRock response bodies, included
  weights/floor/dynamic universes/positions in the scan single-flight key, and
  evicted hung quote entries after 30 seconds. Scoped lint and TypeScript pass;
  5 files / 26 review regressions pass.
- Final review-remediation `scripts/land.sh`: TypeScript passed; 381 files /
  4,381 tests passed; production build completed with 32 static pages; code
  head `3df82396` pushed to ready PR #1618.
- Hosted gitleaks, classify, Playwright smoke, `verify-hosted`, and required
  `verify` passed; all review threads were replied to and resolved.
- PR #1618 squash-merged as `28eab7cb08abcefaa718b74889e8f29b0105941f`.
  Coolify deployment `a140o5e4sh3vh7ylqzzwu1qr` finished on that exact SHA.
  Production `/api/health` returned `ok:true`, DB `ok`, scheduler age 14 seconds
  with an unexpired lease, FMP and Congress dependencies healthy, and Litestream
  `replicating` with a valid one-second-old IPC sync and no degraded reasons.

## Follow-ups

- Build persistent, point-in-time FMP ingestion for statements, metrics,
  estimates/revisions, calendars, insider facts, and material news as described
  in `docs/fmp-capabilities.md`; scans should read those facts locally.
- Add an operator view over the durable endpoint attempts/outcomes and explicit
  entitlement state; the ledger now has endpoint identity but health remains provider-level.
- Replace process-only enrichment cache with durable scoped facts so deployments
  do not cold-start the full provider graph.
- If the owner upgrades FMP and confirms corpus rights, activate the existing
  default-off transcript producer in staged holdings/candidate waves before broad backfill.
