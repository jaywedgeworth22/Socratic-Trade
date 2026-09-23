# 2026-08-04 — Congress member skill: filing-date copy-trade into ST

## Context & Objective

Owner: Socratic-Trade needs politician performance context that Congress.Trade
already calculates — especially **how well trades work after filing/disclosure**
(copy-trade), not only a compressed rank. Wire dual-anchor performance through
the shared client, restore `memberSkill` weight, and persist raw excess stats.

## Changes Made

### Shared package (`@jaywedgeworth22/congress-trading-shared` **v2.5.1**)
- `MemberDualPerformanceSchema`: `filingDate` + `tradeDate` + legacy `performance`
- `avgAnnualizedExcess` on performance legs
- `getMemberPerformance()` returns dual envelope (legacy single-leg still accepted)
- PR: https://github.com/jaywedgeworth22/congress-trading-shared/pull/258
- Tag: `v2.5.1` @ `787b53ba…`

### Socratic-Trade
1. **Prefer filing-date skill** for ranking (`preferMemberSkillLeg` / `buildMemberSkillDetails`)
2. **Parse dual legs** via shared client v2.5.1
3. **Restore `memberSkill` weight to 0.2** (research weights: conviction 0.25, consensus 0.2, flow 0.15, freshness 0.1, confidence 0.1)
4. **Raw context on overlay + MarketQuote + CandidateEvidence**:
   - `topMemberFilingAvgExcess` / winRate / scoredCount / avgAnnualizedExcess
   - trade-date opposite-anchor fields for context
5. Strategy **bulletins** include filing excess % and n=
6. Scan outlier support treats `realized_skill_filing` / `_trade` as skill support

### Files (ST)
- `package.json` / `package-lock.json` — pin shared `#v2.5.1`
- `src/lib/web-sources/congress-analytics.ts`, `types.ts`, `index.ts`
- `src/lib/congress-score.ts`, `market.ts`, `types.ts`, `evidence.ts`
- `test/congress-analytics.test.ts`
- This rollout

## Decisions & Trade-offs
- Filing-date leg is primary for trading decisions; trade-date is context.
- Rank is still 0–100 within the refresh cohort (relative), but raw `avgExcess` is stored for absolute context.
- `realized_skill` remains accepted as a legacy synonym for filing/trade skill sources.

## Verification
```bash
# shared
cd congress-trading-shared && npm test && npm run build
# ST
npx vitest run test/congress-analytics.test.ts test/congress-score.test.ts
# 32/32 passed
```

## Next Steps
- Merge shared PR #258 to main (tag already published).
- Land ST PR; after deploy, confirm analytics refresh populates `topMemberFilingAvgExcess` when CT has scored prices.
