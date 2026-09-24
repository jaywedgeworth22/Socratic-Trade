# 2026-08-26 — Guardrail capabilities, market hours hints, unmanaged shorts, and stop fallbacks

## Context & Objective

Resolve reviewer and fleet audit findings in Socratic-Trade across Guardrails capabilities merging, broker-specific synthetic stop hours hints, synthetic stop trail fallbacks, and unmanaged short derivations.

## Changes Made

1. **Guardrails Account Capabilities Merging (`app/console/guardrails/page.tsx`)**:
   Pass `account?.capabilities` into `mergeAccountCapabilities(broker, account?.capabilities)`.  This ensures accounts (like Alpaca) reporting live `capabilities.shortSelling: true` retain their live capabilities in the Guardrails view instead of resetting to default broker limits where shortSelling was omitted.

2. **Broker Synthetic Stop Hours Hints (`src/lib/market-hours.ts`)**:
   Updated `syntheticStopHoursHint` in `getBrokerMarketHours` for Robinhood, Tradier, Public, and eToro to accurately match each venue's executable order windows:
   - Robinhood: `pre-market 7:00 AM – 9:30 AM ET and after-hours 4:00 PM – 8:00 PM ET`
   - Tradier: `pre-market 7:00 AM – 9:30 AM ET and after-hours 4:00 PM – 8:00 PM ET`
   - Public: `pre-market 8:00 AM – 9:30 AM ET and after-hours 4:00 PM – 8:00 PM ET`
   - eToro: `regular market hours only (9:30 AM – 4:00 PM ET)`

3. **Synthetic Stops Short Fallback (`src/lib/synthetic-stops.ts`)**:
   Compute `shortTrailFallback` with fallback to `policy.riskRules?.stopLossPct` when `shortStopLossPct` is unset or non-positive, matching the logic in proactive risk proposals (`generateProactiveRiskProposals`).

4. **Unmanaged Shorts Derivation (`app/console/lib/derive.ts`)**:
   In `deriveUnmanagedShorts`, check whether any stop distance is effectively configured (`stopLossPct > 0`, `shortStopLossPct > 0`, `trailingStopPct > 0`, or per-position stop plans).  If risk rules are defined with 0% stops across all mechanisms and no per-position plan exists, shorts are identified as `stops_disabled`.

Touched files:
- `app/console/guardrails/page.tsx`
- `app/console/lib/derive.ts`
- `src/lib/market-hours.ts`
- `src/lib/synthetic-stops.ts`
- `test/console-live-data-derive.test.ts`
- `STATUS.md`
- `docs/EFFORT-LOG.md`
- `docs/rollouts/2026-08-26-reviewer-fixes-guardrails-stophours.md`

## Decisions & Trade-offs

- Maintained existing behavior for accounts without explicit riskRules passed into `deriveUnmanagedShorts`.
- Preserved existing contract and types across all call sites.

## Verification State

- `npx tsc --noEmit` passed.
- `vitest run test/console-live-data-derive.test.ts` passed (47 tests).
- Full repository test suite passed.
