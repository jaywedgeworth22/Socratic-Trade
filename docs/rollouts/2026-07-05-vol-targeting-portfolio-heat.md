# 2026-07-05 — Volatility-targeting sizing + portfolio-heat budget (continuous taper, advisory)

Lane 2 of a 5-lane parallel risk-engine effort. Worktree
`~/Code/Socratic-Trade/.claude/worktrees/monet-vol-heat`, branch
`claude/vol-targeting-portfolio-heat` (based on `origin/main`). Committed locally only — the
orchestrator lands serially across all five lanes.

## Summary

Two independent, default-OFF `policy.tuning.*` knobs that continuously TAPER (never scale up,
never hard-block) an OPENING proposal's size:

1. **Vol-targeting sizing** (`policy.tuning.volTargeting` + `targetPortfolioVolPct`): a new
   dependency-light module `src/lib/vol-targeting.ts` computes `realizedVolPct(bars, lookbackDays
   = 20)` — annualized realized vol % from the stdev of daily simple returns × √252 × 100 — and
   `volTargetScale(realizedVol, targetVol, floor = 0.25)` = `clamp(targetVol / realizedVol, floor,
   1)`. `strategy.ts` precomputes `realizedVolPctBySymbol` for every opening candidate (bars via
   `fetchDailyOHLC`, 30-min cache, gated on `volTargeting === true || atrStops === true` so no
   extra fetch load when the feature is fully off) and multiplies the Kelly-lite `multiplier` by
   this scale, before the existing `sizingFloorPct`/`sizingCeilingPct` clamp — so it composes with
   every other sizing input identically.
2. **Portfolio-heat budget** (`policy.tuning.portfolioHeatBudgetPct`): `computePortfolioHeat` sums
   distance-to-stop dollar risk (`positionRiskUsd = |marketValue| × stopPct/100`) across the
   current book as % of equity, reusing the SAME stop-basis precedence
   `generateProactiveRiskProposals` already uses (ATR > beta-scaled > flat). Positions with no
   resolvable stop basis are excluded from the risk total but flagged `estimated: true` — the
   receipt states "N of M positions have no stop basis" rather than guessing a stop. When the
   current book heat plus an order's own incremental risk would exceed the budget,
   `applyDeterministicSizing` continuously tapers that order's notional to whatever budget remains
   (never below the existing exploratory floor, never a hard block).

Both mechanisms surface an advisory rationale note whenever the underlying number is cheaply
available, REGARDLESS of whether the flag is on — e.g. `withData.rationale` says "advisory-only"
when `volTargeting` is false, `"applied"` when it fires. Flags OFF ⇒ byte-identical sizing (new
params to `applyDeterministicSizing` are optional trailing args; every pre-existing call site and
test is unaffected).

## Why

Board ask: "continuous exposure taper instead of binary caps; advisory-style and
owner-overridable." A hard vol/heat cap would be a new blocking gate; this lane deliberately
avoids that — every taper is continuous (`clamp`/proportional scaling), bottoms out at the
existing exploratory floor rather than zero, and any resulting advisory note is a rationale/audit
receipt, never a new `isHardGateReason` pattern. `sizing_vol_target_applied` fires per proposal
where the vol-target scale actually applied (<1); `sizing_heat_budget_applied` fires per proposal
where the heat-budget taper actually reduced size — kept as two distinct audit kinds so telemetry
doesn't conflate which brake fired on a given order.

## Files

- `src/lib/vol-targeting.ts` — NEW leaf module: `realizedVolPct`, `volTargetScale`,
  `positionRiskUsd`, `computePortfolioHeat` (+ `PortfolioHeatPosition`/`PortfolioHeatResult`
  types). Pure, only imports the `OHLCBar` type — no DB/network.
- `src/lib/strategy.ts` — precomputes `realizedVolPctBySymbol` and `bookHeat` once per
  `runStrategyOnce` call (mirrors the existing ATR/beta precompute pattern) and threads both into
  `applyDeterministicSizing` as new optional trailing params; vol-target taper applied to the
  Kelly-lite multiplier before floor/ceiling; heat-budget taper applied to `targetNotional` after
  the ADV cap; two new audit kinds (`sizing_vol_target_applied`, `sizing_heat_budget_applied`).
- `src/lib/types.ts` — `TuningSettings` += `volTargeting?: boolean`, `targetPortfolioVolPct?:
  number`, `portfolioHeatBudgetPct?: number` (all optional, default OFF, documented
  byte-identical-when-unset).
- `test/vol-targeting.test.ts` — NEW: 18 pure unit tests — known-vector realized vol (hand-verified
  ≈23.8118% annualized), insufficient-data/non-finite → `undefined`, close-only bars OK,
  `volTargetScale` clamping (down-scale, never-up, floor, invalid-input degrade-to-1),
  `positionRiskUsd`, and `computePortfolioHeat` mixed/missing/no-basis/zero-equity/empty-book
  honesty cases.
- `test/vol-targeting-sizing.test.ts` — NEW: 6 integration tests against
  `applyDeterministicSizing` directly — flag OFF byte-identical (even with data supplied), flag ON
  high-vol tapers + note, at/below target never sizes up, heat budget exceeded tapers to remaining
  budget, no-stop-basis-anywhere honest receipt, heat budget fully exhausted holds at exploratory
  floor with an overridable advisory note (never a hard block).

## Verification (exact commands run, all green)

```bash
npx tsc --noEmit                                                    # clean
npx vitest run test/vol-targeting.test.ts test/vol-targeting-sizing.test.ts
  # Test Files  2 passed (2) / Tests  23 passed (23)
npm test -- --run                                                   # FULL suite
  # Test Files  262 passed (262) / Tests  2600 passed (2600)
npm run lint
  # 0 errors, 309 pre-existing warnings (none introduced by vol-targeting.ts/strategy.ts changes)
```

Pinned tests (`test/hard-gate-classification.test.ts`, `test/policy.test.ts`,
`test/red-team.test.ts`, `test/market-regime.test.ts`, `test/regime-gate-adoption.test.ts`,
`test/deterministic-bear.test.ts`, `test/correlation-cluster-gate.test.ts`) all pass as part of
the full suite run above. `npm run build` intentionally NOT run — the orchestrator runs it at
landing.

## Review fixes applied before commit

The build arrived uncommitted; on review before finishing the lane, one small telemetry fix was
applied: the heat-budget taper originally reused the `sizing_vol_target_applied` audit kind
(copy-paste from the vol-target-scale audit above it). Split into its own
`sizing_heat_budget_applied` kind so the audit log can distinguish which of the two independent
tapers fired on a given order — otherwise a heat-budget-only taper (vol-targeting off, only
`portfolioHeatBudgetPct` set) would show up under a misleading "vol_target" audit name. No test
asserted the old shared name, so this is a pure telemetry-accuracy fix with no behavior change.
Also removed a dead intermediate variable (`wouldBeHeatPct`) that duplicated an inline
recomputation in the "tapered to add X%" note.

## Out of scope (follow-ups, per lane spec)

Severity-scaled targets (regime-scorer lane), EWMA vol, options/short-vol treatments, UI, broker
brackets.
