# 2026-07-05 - fractional-kelly-sizing

## Summary

Adds a fractional-Kelly sizing advisory on top of the existing Kelly-lite deterministic sizer:

1. `src/lib/performance.ts` — extends the shared `aggregateClosedLots` (and, through it,
   `ThesisStat` / `ThesisRegimeStat`) with additive, optional payoff-split fields: `avgWinPct`,
   `avgLossPct`, `downsideDeviationPct`, `winCount`, `lossCount`. All existing fields/consumers
   are unaffected (verified — `RegimeStat`/`SectorStat`/`FactorScorecardStat` untouched, and every
   existing performance test still passes byte-for-byte).
2. `src/lib/kelly.ts` (new, pure/dependency-light) — `kellyFraction(p, b)` (classic
   `f* = p - (1-p)/b`, clamped at 0, `undefined` outside its domain), `dispersionPenalty(avgReturn,
   downsideDeviation)` (risk-adjusted-edge damping in `[0,1]`), and
   `fractionalKellySuggestion(stats, opts)` (combines both into a suggested multiplier expressed in
   the same `[0,1]` sizing scale the deterministic sizer already uses).
3. `src/lib/strategy.ts` (`applyDeterministicSizing`) — wires the above in BESIDE the existing
   "Edge-aware Kelly-lite" `edgeFactor` block (left untouched, per spec). Always computes a
   suggestion and appends an informational `[Sizing] Fractional-Kelly (...)` rationale note once
   the bucket clears the existing `minClosedLotsForWeightShift` sample gate AND has a computable
   payoff ratio (both winners and losers present). The note is suppressed exactly like every other
   "trust-the-stats" note when the bucket is thin. Only changes the actual order size when the new
   `policy.tuning.fractionalKellySizing` flag (default `false`/OFF) is explicitly on, and even then
   the final multiplier is `min(existing multiplier, kelly suggestion)` — Kelly can only shrink
   size relative to today, never grow it. Emits `audit("sizing_fractional_kelly_applied", ...)`
   only when the flag is on AND Kelly actually reduced the size.
4. `src/lib/types.ts` — two new `TuningSettings` fields: `fractionalKellySizing?: boolean` (default
   OFF) and `kellyFraction?: number` (default `0.5`, "half-Kelly"), each documented with the house
   "Default false/0.5: default behavior is byte-identical" comment pattern.

## Why

Board item / composite review `docs/reviews/2026-07-04-composite-expert-review.md:449`: sizing was
"blind to outcome distribution (skew/tail)" — a thesis with a good average return but a fat left
tail (occasional large losers) was sized identically to a thesis with the same average and steady,
low-dispersion returns. This change adds a downside-dispersion-aware fractional-Kelly advisory that
(a) computes the realized win/loss payoff ratio the codebase never tracked before, (b) penalizes
the suggested size when the mean edge is small relative to the bucket's downside deviation, and
(c) surfaces the result as a receipt first, with an explicit opt-in flag before it can actually
change size — matching the "Phase-0 byte-identical invariant" convention used by every other
learning-loop feature in this codebase (`calibrationSizing`, `skipNegativeExpectancy`, etc.).

## Design decisions

- **Left the existing Kelly-lite `edgeFactor` heuristic untouched.** It is explicitly out of scope
  per the lane spec ("changing the existing Kelly-lite heuristic" is listed as out of scope). Real
  Kelly runs beside it as a second, independently-gated advisory signal.
- **Payoff-split fields use `returnPct` (not `pnl`) for win/loss classification.** The existing
  `winRate`/`shrunkWinRate` fields classify a win as `pnl > 0`; the new `avgWinPct`/`avgLossPct`
  split classifies by `returnPct > 0` / `returnPct < 0` per the spec (`avgWinPct?: number — mean
  returnPct over lots with returnPct > 0`). In practice these agree for all realistic lots (pnl and
  returnPct share a sign), but the new fields are computed independently to match the spec exactly
  rather than assuming the two never diverge.
- **`downsideDeviationPct` is defined (0), not `undefined`, when a bucket has zero losing lots.**
  This differs from `avgWinPct`/`avgLossPct`, which ARE `undefined` with no winners/losers
  respectively — a payoff RATIO genuinely has no answer without both sides (never fabricate `b`),
  but "zero measured downside" is itself a well-defined, honest answer for sigma_down, not a
  fabrication. `fractionalKellySuggestion` treats an `undefined` `downsideDeviationPct` from the
  caller the same as `0` (full penalty, no damping) purely as a defensive default, since
  `performance.ts` never actually emits `undefined` for it once `trades > 0`.
- **Kelly's applied multiplier is allowed to go below `sizingFloorPct`.** The first implementation
  re-clamped the Kelly-selected multiplier to `[floor, ceiling]`, which silently defeated the
  "reduce, never increase" guardrail whenever the Kelly suggestion was smaller than the floor (the
  clamp would snap it back UP to the floor). Fixed to clamp only to `[0, ceiling]` and to the
  pre-Kelly multiplier itself (`min(boundedMultiplier, suggestedPctOfCeiling)`) — Kelly is
  explicitly allowed to cut size below the ordinary exploratory floor, since a poor
  risk-adjusted-edge reading should be able to shrink size further than "unproven" already does.
  Caught by the `kellyFraction` tuning-knob test (quarter- vs half-Kelly) during implementation —
  both produced the identical floor-clamped notional before the fix.
- **`p`/`avgReturn` inputs to the Kelly suggestion use the SAME shrunk stats the existing sizer
  already reads** (`stat?.shrunkWinRate`, `stat?.shrunkAvgReturnPct` — the `winRate`/`avgReturn`
  locals already in scope), while `avgWinPct`/`avgLossPct`/`downsideDeviationPct` use the RAW
  (unshrunk) per-bucket values, per spec ("do NOT shrink these ... expose raw values + counts and
  let the gate handle thinness"). The sample gate is the shared `minClosedLotsForWeightShift`
  reused as `opts.minTrades` — no new threshold constant introduced.
- **Shorts get an explicit "(short: uncalibrated)" receipt suffix.** `getConfidenceCalibration` is
  long-only; the Kelly payoff split itself is computed from raw closed-lot stats regardless of side
  (so shorts DO get a suggestion), but the receipt is honest that the calibration curve backing the
  conviction multiplier elsewhere in the sizer has no short-side analog.
- **Reused `MIN_CLOSED_LOTS_FOR_WEIGHT_SHIFT` / `policy.tuning.minClosedLotsForWeightShift`** as the
  Kelly sample gate — no new threshold constant, per house convention.
- **No new `SocraticEvidenceItem.kind` value added** — the Kelly receipt is a plain rationale-note
  string (`\n\n[Sizing] Fractional-Kelly ...`), following the exact `capNote`/`advisedSizeNote`
  pattern already used for every other sizing note in `applyDeterministicSizing`.

## Files

- `src/lib/performance.ts` (+~45/-9) — `ThesisStat`/`ThesisRegimeStat` additive fields;
  `aggregateClosedLots` payoff-split computation.
- `src/lib/kelly.ts` (new, ~130 lines) — `kellyFraction`, `dispersionPenalty`,
  `fractionalKellySuggestion` and their supporting types.
- `src/lib/strategy.ts` (+~40) — Fractional-Kelly wiring inside `applyDeterministicSizing`, beside
  the existing Kelly-lite block; `fallbackNotional`/fallback rationale note now read
  `finalMultiplier` instead of `boundedMultiplier` (byte-identical when the flag is off, since
  `finalMultiplier` defaults to `boundedMultiplier`); new `sizing_fractional_kelly_applied` audit
  event.
- `src/lib/types.ts` (+~17) — `TuningSettings.fractionalKellySizing`, `TuningSettings.kellyFraction`.
- `test/kelly.test.ts` (new, 20 tests) — pure unit tests for `kellyFraction`, `dispersionPenalty`,
  `fractionalKellySuggestion` (hand-computed vectors, domain edges, monotonicity).
- `test/performance-payoff-stats.test.ts` (new, 4 tests) — `aggregateClosedLots` payoff-split
  fields via `getThesisScorecard`/`getThesisRegimeScorecard`, synthetic closed-lot fixtures.
- `test/kelly-sizing.test.ts` (new, 8 tests) — end-to-end `applyDeterministicSizing` integration:
  flag off (byte-identical sizing + informational receipt), flag on (reduced size + "applied"
  note), thin bucket (no note, no change), no-losers bucket (no note), shorts (uncalibrated
  marker), `kellyFraction` tuning knob, audit event emission, and a dedicated safety-invariant
  regression (below) proving Kelly cannot size UP even when its own suggestion is numerically
  higher than the pre-existing multiplier.
- `docs/rollouts/2026-07-05-fractional-kelly-sizing.md` (this file).

## Verification

Run from `/Users/jay/Code/Socratic-Trade/.claude/worktrees/monet-kelly`:

- `npx tsc --noEmit` — clean, no output.
- `npx vitest run test/kelly.test.ts test/performance-payoff-stats.test.ts test/kelly-sizing.test.ts test/conviction-size-cap.test.ts test/performance.test.ts` —
  **5 files / 76 tests, all passed** (59.49s wall).
- `npm test -- --run` (full suite) — **263 files / 2608 tests, all passed** (156.00s wall, exit
  code 0).
- `npm run lint` — **0 errors, 309 warnings** (all pre-existing/grandfathered `@typescript-eslint/
  no-explicit-any` etc.; zero new warnings in any file touched by this change, confirmed by
  grepping the lint output for `kelly`).
- Pinned-behavior spot check: `test/hard-gate-classification.test.ts`, `test/policy.test.ts`,
  `test/red-team.test.ts`, `test/market-regime.test.ts`, `test/regime-gate-adoption.test.ts`,
  `test/deterministic-bear.test.ts` all pass. `test/correlation-cluster-gate.test.ts` and (in one
  concurrent run only) `test/red-team.test.ts` hit a pre-existing 20s test-timeout flake under
  worker contention — reproduced identically on unmodified `main` @ `041b73b2` (confirmed via
  `git stash` before re-running), so it predates and is unrelated to this change; both pass cleanly
  in isolation and inside the full 263-file suite run above.
- Did not run `npm run build` (orchestrator runs it at landing, per lane instructions).

### Post-review addendum (2026-07-06) — safety-invariant test coverage

An adversarial review flagged a real coverage gap (not a source bug): none of the seeded fixtures
in `test/kelly-sizing.test.ts` produced a case where the raw Kelly-suggested multiplier
(`suggestedPctOfCeiling`) exceeds the pre-existing bounded multiplier (`boundedMultiplier`) — the
exact condition the `suggestedPctOfCeiling < boundedMultiplier` guard in `applyKelly`
(`strategy.ts`) exists to prevent from ever sizing up. Mutation-tested by relaxing that guard to
`policy.tuning?.fractionalKellySizing === true` (dropping the reduce-only check): all 7
pre-existing tests still passed, confirming the gap.

Fix: added one new fixture (60 closed lots, 59 winners @ +1%, 1 loser @ -1%, `confidenceScore=50`)
that genuinely produces `suggested (45% of max) > boundedMultiplier (33% of max)` — a near-100%
win-rate, low-conviction, tight-payoff-ratio bucket where Kelly-lite's three-factor product
(shrunk win rate x capped conviction x edgeFactor) lands below the raw Kelly fraction's own
suggestion. Verified end-to-end through `applyDeterministicSizing` (not hand-modeled): flag OFF and
flag ON both report `dollarAmount = 3324` (33% of the $10,000 ceiling) and the note stays
"informational only, not applied" — i.e. Kelly does NOT size up even though its own suggestion is
numerically larger. Re-ran the same mutation against this new test in isolation: it fails exactly
as expected (`dollarAmount` jumps to $4,536 / 45%, note flips to "— applied"), while the other 7
tests remain green — confirming the new test isolates this invariant without being redundant with
existing coverage.

No production code changed — `src/lib/strategy.ts` is unmodified since the original commit
(`git diff` against `a955bd6a` is empty for that file). This was purely a missing-coverage gap, not
a logic bug: the guard was already correct.

- `npx tsc --noEmit` — clean, no output (re-run post-fix).
- `npx vitest run test/kelly-sizing.test.ts` — **1 file / 8 tests, all passed**.
- `npm test -- --run` (full suite, re-run post-fix) — **263 files / 2609 tests, all passed**
  (18.90s wall, exit code 0).
- `npm run lint` (re-run post-fix) — **0 errors, 309 warnings** (same pre-existing/grandfathered
  set as before; no new warnings).

## Follow-ups

- **Per-model Kelly** (w3-permodel-loop) — not landed in this worktree; `ClosedLot` has no
  `proposedByModel` field and no model-keyed scorecard exists yet. Out of scope here.
- **Portfolio-level joint Kelly** — this lane is per-thesis-bucket only, matching the existing
  sizer's scope; a portfolio-level joint-Kelly allocation across simultaneously-held positions is a
  separate, larger design.
- **Wiring `crossCheckRealizedPnl`** — confirmed still zero production callers
  (`src/lib/robinhood-pnl-crosscheck.ts`); not touched by this change.
- **UI surfacing** — the Kelly receipt is currently rationale-text only (flows to
  `SocraticDecisionCase.rationale` via the existing pipeline, same as every other sizing note); no
  dedicated console/dashboard visualization was added (out of scope, console/UI is the CODEX lane
  per `app/**` keepout).
- Consider whether `avgWinPct`/`avgLossPct`/`downsideDeviationPct` should also be exposed on
  `RegimeStat`/`SectorStat`/`FactorScorecardStat` for other future consumers — deferred since only
  `ThesisStat`/`ThesisRegimeStat` are read by `applyDeterministicSizing`/`selectThesisStat` today,
  and the spec scoped the aggregation change to "minimal additive diff."
