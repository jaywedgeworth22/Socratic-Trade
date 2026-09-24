# 2026-08-04 — ST ROIC.ai history cascade (CT stays peer-only) [GROK]

## Summary

Owner chose **option 1**: ROIC.ai is integrated **on Socratic-Trade only**.
Congress.Trade continues to take all EOD prices from ST via `PRICE_PROVIDER=peer`
and never holds a ROIC key.

### What changed

- `src/lib/history.ts`: new keyed history tier **ROIC.ai**
  (`GET https://api.roic.ai/v3.0.0/stock-prices/{symbol}?adjustment=splits…`)
  seated **after Massive, before Tradier/Tiingo/Marketstack/Yahoo**.
- Cursor pagination (`next_page_url`, max 8 pages × 1000 bars).
- Shares the existing `roic` `admitProviderRequests` bucket with enrichment.
- Gate: `ROIC_HISTORY_ENABLED` (default `on`); key: `ROIC_API_KEY` (already used
  by `RoicAiEnrichmentProvider`).
- Pure parser `parseRoicStockPrices` exported + unit-tested.

### Why this shape

ROIC has no flat-file bulk dump — only REST JSON. ST already owns the multi-provider
history cascade and peer market-read routes that CT consumes. Putting ROIC in ST
means one cache, one rate budget, and CT remains a thin peer client.

### Verification

```bash
cd /tmp/st-roic-history  # or repo checkout
npx vitest run test/history.test.ts
# with a live key (operator only):
# ROIC_API_KEY=… node -e '…fetchDailyOHLC("AAPL")…'
```

### Ops

- Ensure Infisical ST prod has `ROIC_API_KEY` (already required for enrichment).
- Optional: raise `PROVIDER_QUOTA_ROIC_PER_DAY` if history + enrichment contend.
- CT unchanged: keep `PRICE_PROVIDER=peer` + valid `APP_B_INGEST_TOKEN`.

## Follow-ups

- Warm ST cache for high-traffic tickers (scheduler/import) so CT peer reads hit
  dense local history without per-request ROIC calls.
- Consider exchange-prefixed identifiers (`NASDAQ:AAPL`) if plain tickers 404 for
  dual-listed names.

## Follow-up 2026-08-04 (GROK) — CI tsc fix

`verify-hosted` failed on TS7022 circular inference for `json` / `next` in
`fetchRoic` pagination loop (reassignment of `url`). Fixed with explicit type
annotations. `npx tsc --noEmit` clean; `test/history.test.ts` 25/25.
