# Quote Key Stats + tappable fill/position cards

## Context & Objective

Owner screenshot 2026-08-13 ~5:31pm CT: the GOOG iOS company sheet showed price $343.94, +0.5% today, volume 14,897,228, and "Alphabet Inc.", but P/E, EPS, Dividend Yield, Beta, 52W High, and 52W Low were all "—".  Footer: "Quote data from a live fetch (Aug 13, 2026 at 3:00 PM CT)."  The owner also asked why so much data could not be seen, saved, or updated.  Separately, tapping a mobile fill or position card did nothing unless the small logo+ticker was hit.

## Changes Made

The dashes were honest (no fabricated numbers) but the data was being dropped, not missing.

Live probe of Yahoo `v8/finance/chart/GOOG` on 2026-08-13 returned `fiftyTwoWeekHigh=404.47` and `fiftyTwoWeekLow=197.46` on the **same** chart meta object that already supplied price/volume/name.  `fetchYahooFinanceQuote` and `fastQuoteEnrichment` never mapped those keys, so 52W was dashes after a successful live fetch.

PE/EPS/div/beta are not on the keyless chart.  They come from crumb-authed `v10/finance/quoteSummary` inside `YahooFinanceEnrichmentProvider`, which is only one provider in the full cascade.  Wave A Yahoo can finish in 1–3s; `CascadingEnrichmentProvider.enrich` then waits for paid and scarce waves (`Promise.all`).  `/api/quote` budgets that whole promise at 6s and returns the chart floor alone when it times out — discarding Yahoo's already-fetched fundamentals.  Yahoo `v7/finance/quote` is HTTP 401 without a crumb (`Unauthorized` / "User is unable to access this feature") and is **not** a keyless floor.

`/api/quote` also never read or wrote `symbol_field_latest`.  Scan-persisted PE/EPS/52w stayed invisible on the sheet, and a successful open never updated the store — the "see / save / update" gap.

Fix:
- Map the 52-week range from chart meta onto the fast floor.
- Run Yahoo quoteSummary as its own 6s layer so PE/EPS/div/beta do not wait for paid/scarce providers.  The cascade still runs and can add more fields; Yahoo's in-process cache prevents a second quoteSummary when the dedicated call finishes first.
- Seed from `symbol_field_latest` via `persistedSlowEnrichment` and persist the merged quote back so the next open sees saved fundamentals immediately.
- Entire iOS fill and position cards are one button (no nested buttons) and present `SymbolInfoSheet` with fill/position facts plus company stats.  Watchlist chips stay two sibling buttons.  Order Cancel / Delete Alert stay explicit action controls.
- PWA Home position rows were inert; they now open a compact quote/position sheet against the same `/api/quote`.  PWA has no fill cards.

Touched files:
- `src/lib/yahoo-finance.ts`
- `src/lib/on-demand-quote.ts` (new)
- `src/lib/data-providers.ts` (`enrichYahooFinanceSymbol`)
- `app/api/quote/route.ts`
- `test/on-demand-quote.test.ts` (new)
- `test/yahoo-finance-fundamentals.test.ts` (new)
- `test/quote-route.test.ts`
- `ios/SocraticTrade/AppComponents.swift`
- `ios/SocraticTrade/MarketsView.swift`
- `ios/SocraticTrade/ActivityView.swift`
- `ios/SocraticTrade/SymbolInfoSheet.swift`
- `ios/SocraticTrade/MobileModels.swift`
- `ios/SocraticTradeTests/MobileModelsTests.swift`
- `app/mobile/components/MobileHomeTab.tsx`
- `app/mobile/components/MobileSymbolSheet.tsx` (new)
- `STATUS.md`
- `docs/EFFORT-LOG.md`
- `docs/rollouts/2026-08-13-quote-stats-and-card-taps.md`

## Decisions & Trade-offs

- Did **not** treat v7 quote as a keyless fundamentals path.  Live 401 without crumb.
- Did **not** fabricate PE/EPS/div/beta from the chart.  Those fields still require quoteSummary, the durable store, or a cascade that finishes in time.
- n/a vs — kept: n/a = negative/zero earnings (real no-ratio); — = unavailable.
- Dedicated Yahoo layer can race the cascade's Yahoo provider on a cold cache.  Acceptable: cache then hits; one extra quoteSummary is cheaper than empty Key Stats.
- Orders and alerts stay logo-tap only so Cancel / Delete do not nest inside a card button.

## Verification State

```bash
npm run lint            # 0 errors, 758 grandfathered warnings
npx tsc --noEmit        # clean
npx vitest run test/quote-route.test.ts test/on-demand-quote.test.ts test/yahoo-finance-fundamentals.test.ts
# 18/18 pass
bash scripts/land.sh    # full suite 6624 passed / 51 skipped (569 files); npm run build clean
```

PR https://github.com/jaywedgeworth22/Socratic-Trade/pull/2692 — squash auto-merge armed.

## Next Steps & Blockers

- After deploy, open GOOG on iOS: 52W High/Low should match the live chart; PE/EPS/div/beta should populate from quoteSummary or the durable store (not dashes on a name Yahoo has).
- If quoteSummary 429s from the prod egress IP, the durable seed still shows last saved fundamentals; do not invent numbers.
- Native TestFlight will pick up the card-tap UI on the next iOS ship.

## Zero-Code Findings

Yahoo chart meta for GOOG on 2026-08-13 already included `fiftyTwoWeekHigh` / `fiftyTwoWeekLow`.  The UI dashes were a mapping drop, not an upstream hole.
