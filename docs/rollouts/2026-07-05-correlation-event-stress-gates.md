# 2026-07-05 - correlation-event-stress-gates

## Summary

Lane 3 of the 5-lane parallel risk-engine build: three new advisory RECEIPTS attached to opening
(buy/short) proposals — never new blocking gates.

1. **EWMA + downside correlation** (`src/lib/correlation.ts`): added `ewmaCorrelation` (RiskMetrics-
   style exponentially weighted correlation, more responsive to a recent regime shift than the
   existing equal-weight `pearson`), `downsideCorrelation` (Pearson conditioned on the HOLDING's down
   days only — "when what I already own falls, does the candidate fall too"), and `correlationProfile`
   (per-holding pearson/EWMA/downside + `maxPairwise`/`avgEwma` summary, capped at 15 holdings by
   |marketValue| descending). None of the existing exports (`alignedReturns`, `pearson`,
   `avgReturnCorrelation`) changed behavior; `applyCorrelationClusterGate` (the existing opt-in
   `policy.maxAvgCorrelation` gate) is untouched.
2. **Per-candidate correlation + pre-trade stress receipts** (`src/lib/strategy.ts`, new
   `applyRiskReceipts` function): for each opening proposal, appends a `\n\n[Risk] Correlation: …`
   rationale note + `audit("correlation_receipt", …)`, and a `\n\n[Risk] Stress …` rationale note +
   `audit("stress_receipt", …)` from a new deterministic parametric stress engine
   (`src/lib/stress-scenario.ts`, pure, no I/O). Both gated behind one new flag,
   `policy.tuning.riskReceipts` (default false/undefined) — off means zero extra `fetchDailyOHLC`
   calls and byte-identical rationale/prompt/audit trail.
3. **Earnings-proximity advisory blackout** (openings only, also in `applyRiskReceipts`): an
   unconditional `\n\n[Risk] Earnings in N trading day(s)` note whenever `quote.daysToEarnings <= 7`
   (skipped silently when unknown — never fabricated), and — only when the separate
   `policy.tuning.earningsBlackout` flag is on AND `daysToEarnings <= earningsBlackoutDays` (default
   3) — an overridable `earnings_blackout: …` tag pushed onto `proposal.preVetoReasons`, following the
   exact PR #814 pattern (folds into the sized `PolicyDecision` right before `resolveSocraticOverride`,
   classified as an overridable preference by `isHardGateReason`, never a hard block).

No macro-event (FOMC/CPI) calendar was built — confirmed out of scope per the lane spec (none exists
in this codebase; see Follow-ups).

## Post-review fixes (adversarial review, same lane)

Two must-fix blockers surfaced in review of the initial commit; both are fixed on this branch:

1. **Reference-identity break in `applyRiskReceipts`.** The initial version rebuilt each opening
   proposal via `proposal = { ...proposal, rationale: ... }` when appending a correlation/stress/
   earnings note. Every earlier stage in `runStrategyOnce` (Bear-unavailable routing, the
   rationale-collapse gate, FIX#3 propose-mode pre-routing) adds the SAME proposal object to
   `requiresHumanReview`, a `Set<TradeProposal>` keyed by reference — and the placement loop's
   `requiresHumanReview.has(proposal)` check (the Fail-CLOSED safety net that keeps an un-critiqued or
   collapsed-rationale opening from auto-executing in "decide" mode) depends on that same reference
   surviving unchanged. Rebuilding the object silently broke Set membership for any proposal that both
   (a) was routed to human review by an earlier gate and (b) picked up any risk-receipt note — which
   happens routinely, since the earnings note is unconditional whenever `daysToEarnings <= 7`, with
   both new flags off. **Fix:** `applyRiskReceipts` now mutates the same object reference throughout
   (`proposal.rationale += note`, matching every other stage's existing convention) instead of
   spreading into a new object. No test in the original submission drove `runStrategyOnce` with this
   combination (Bear-unavailable + a risk-receipt note on the same proposal), so the regression shipped
   with a fully green suite; two new tests in `test/risk-receipts.test.ts`
   ("applyRiskReceipts — reference identity (regression)") build a `Set` before calling
   `applyRiskReceipts` and assert `.has()` still recognizes the returned object afterward, for both an
   opening (correlation+stress+earnings notes) and an exit (untouched).
2. **Earnings-blackout tag applied too late for `preVetoTaggedOpeningWillPlace` / FIX#3.** The
   `earnings_blackout` `preVetoReasons` tag was applied inside `applyRiskReceipts` at the
   `gatedProposals` stage, near the end of the pipeline — AFTER the FIX#3 propose-mode pre-routing loop
   (which reads `preVetoReasons` to decide whether an opening carrying a pre-veto tag needs to route to
   `requiresHumanReview` now) and AFTER the sell-to-fund intended-notional filter (which excludes a
   pre-veto-tagged opening that won't auto-execute via `preVetoTaggedOpeningWillPlace`, per that
   function's own doc comment). Because both of those ran on `debatedProposals` before the tag existed,
   an earnings-blackout-tagged opening was NOT excluded from sell-to-fund notional / FIX#3 pre-routing
   for one run — a live re-run of the exact hazard `preVetoTaggedOpeningWillPlace`'s doc comment warns
   about, just for this lane's own new tag. **Fix:** split the earnings-proximity logic out of
   `applyRiskReceipts` into its own exported function, `applyEarningsBlackoutTag(proposals, policy,
   marketScan, userId)`, and call it in `runStrategyOnce` immediately after the debate loop —
   BEFORE the rationale-collapse gate, FIX#3 pre-routing, and the sell-to-fund planner. `applyRiskReceipts`
   still calls `applyEarningsBlackoutTag` again internally at its later `gatedProposals` stage (so its
   own unit tests and any other direct caller keep seeing the earnings note/tag), guarded by an
   idempotency check (skips a proposal whose rationale already contains the `[Risk] Earnings in` marker)
   so the same proposal is never double-tagged or double-noted within one run. New test:
   "applyEarningsBlackoutTag — ordering (regression)" in `test/risk-receipts.test.ts` drives the tag
   function directly, then `applyRiskReceipts`, and asserts exactly one tag / one note survive.

## Why

The board row asked for EWMA/downside correlation, earnings/macro-event blackout windows, and
pre-trade scenario stress on proposals, ALL as advisory receipts — the house convention throughout
this codebase (deterministic-bear/red-team pre-vetoes, correlation cluster gate, ATR stops, etc.) is
"receipts, not cages": inform the agent/owner, log it, and let an `autonomyOverride` thesis pass any
non-hard gate. This lane extends that pattern rather than inventing a new blocking mechanism, and
reuses the existing `preVetoReasons` fold-in from PR #814 so the earnings tag is overridable for free
(no new override plumbing).

## Files

- `src/lib/correlation.ts` — added `ewmaCorrelation`, `downsideCorrelation`, `correlationProfile`,
  `HoldingCorrelation`, `CorrelationProfile`, `MAX_CORRELATION_PROFILE_HOLDINGS` (=15). Existing
  exports unchanged.
- `src/lib/stress-scenario.ts` (new) — `stressScenario`, `StressScenarioInputs`,
  `StressPositionInput`, `StressCandidateInput`, `StressResult`, `StressContributor`. Pure, no I/O.
- `src/lib/strategy.ts` — new `applyRiskReceipts` function (correlation + stress + earnings receipts);
  wired into the proposal pipeline right after `applyCorrelationClusterGate` resolves (before the
  rationale-diversity check), renaming the intermediate variable to `gatedProposals` so `proposals`
  still names the final set consumed downstream. New imports: `correlationProfile` from
  `./correlation`, `stressScenario`/`StressPositionInput` from `./stress-scenario`. Post-review: the
  earnings-proximity logic was split out into its own exported `applyEarningsBlackoutTag` function,
  called early on `debatedProposals` (right after the debate loop, before the rationale-collapse gate/
  FIX#3 pre-routing/sell-to-fund planner) as well as internally by `applyRiskReceipts` at its later
  call site (idempotent — see "Post-review fixes" above); `applyRiskReceipts` itself now mutates
  proposals in place (`proposal.rationale += note`) instead of rebuilding via spread, to preserve
  `requiresHumanReview` Set-by-reference membership.
- `src/lib/types.ts` — three new `TuningSettings` fields: `riskReceipts?: boolean` (covers Parts 2+4
  — correlation + stress receipts, one flag per COMMON.md guidance since they're the two halves of
  one feature and share the same cost-bounding rationale), `earningsBlackout?: boolean`,
  `earningsBlackoutDays?: number` (default 3 when the flag is on). All default false/undefined with
  "byte-identical" doc comments matching the house `calibrationSizing`/`skipNegativeExpectancy`
  pattern.
- `test/correlation-ewma.test.ts` (new) — `ewmaCorrelation` hand-computed vs plain Pearson (shows the
  EWMA is measurably more responsive to a recent correlation-regime shift), min-sample/zero-variance/
  lambda-range guards; `downsideCorrelation` conditioning on down days, min-sample guard, custom
  floor, zero-variance guard, perfect-correlation clamp. 11 tests.
- `test/stress-scenario.test.ts` (new) — known book (long+short+beta mix) matching hand-computed
  impacts, sign correctness for short positions and short candidates (both gain under a down shock),
  sell/cover candidates contributing zero marginal impact, missing-beta fallback + `betasEstimated`
  threshold (>half), equity<=0 → undefined, top-3 contributor ranking, vix/shockSigmas defaults.
  11 tests.
- `test/risk-receipts.test.ts` (new, integration) — flag OFF is byte-identical (no `[Risk]` notes, no
  `preVetoReasons`, `fetchDailyOHLC` never called); flag ON attaches correlation+stress notes with
  mocked bars and audits both receipts; correlation note is skipped (never fabricated) when there are
  no holdings or bar data is insufficient; exits (sell/cover) are never touched; earnings note is
  unconditional at `daysToEarnings<=7` regardless of flags, only the `preVetoReasons` tag depends on
  `earningsBlackout` + being inside the window; unknown `daysToEarnings` is skipped silently. Post-review
  additions: reference-identity regression tests (a `Set<TradeProposal>` built before `applyRiskReceipts`
  still `.has()` the returned proposal, for both an opening with notes and an untouched exit), and an
  `applyEarningsBlackoutTag` ordering/idempotency regression test. 12 tests.
- `test/hard-gate-classification.test.ts` — pinned one new case: `earnings_blackout: opening within 2
  day(s) of earnings (window 3)` classifies as a PREFERENCE (`isHardGateReason(...) === false`), same
  as the existing `deterministic_bear_veto:`/`red_team_veto:` pre-veto prefixes.

## Verification

Run from the worktree root (`/Users/jay/Code/Socratic-Trade/.claude/worktrees/monet-corr-stress`):

- `npx tsc --noEmit` → clean, no output.
- Focused: `npx vitest run test/correlation-ewma.test.ts test/stress-scenario.test.ts test/risk-receipts.test.ts test/hard-gate-classification.test.ts test/policy.test.ts test/red-team.test.ts test/market-regime.test.ts test/regime-gate-adoption.test.ts test/deterministic-bear.test.ts test/correlation-cluster-gate.test.ts`
  → **10 files passed, 176 tests passed**.
- Full suite: `npm test -- --run` → first attempt under heavy CPU contention (5+ sibling worktrees
  running full suites concurrently) reported 9 files / 11 tests FAILED, all `Error: Test timed out in
  20000ms/30000ms` on unrelated LLM-mocked tests (`strategy-llm-failover`, `strategy-prompt-safety`,
  `strategy-rationale-collapse-gate`, `strategy-tuning`, `security-admin-timing-safe`) plus one
  flaky-under-load assertion in `strategy-tuning.test.ts`; none of these files were touched by this
  lane. Re-ran those 5 failing files in isolation with a longer timeout → **31/31 passed**. Re-ran the
  FULL suite once contention eased → **263 files passed, 2609 tests passed**, 62.17s wall — clean.
- `npm run lint` → **0 errors, 309 warnings** (matches the documented pre-existing baseline; grepped
  the lint output for every new/touched file — zero warnings from `correlation.ts`,
  `stress-scenario.ts`, `strategy.ts`, or any of the four test files).
- Did NOT run `npm run build` per lane instructions (orchestrator runs it at landing).

### Post-review fix re-verification

Re-ran all gates after the two blockers above were fixed (`applyRiskReceipts` in-place mutation +
`applyEarningsBlackoutTag` extraction/reordering) and two regression tests were added:

- `npx tsc --noEmit` → clean, no output.
- Focused (same 10 files as above, now including the 3 new regression tests in
  `test/risk-receipts.test.ts`): **10 files passed, 179 tests passed**.
- Full suite: `npm test -- --run` → **263 files passed, 2612 tests passed**, 24.03s wall — clean, no
  flakes this run.
- `npm run lint` → **0 errors, 309 warnings** (unchanged baseline; `strategy.ts`'s only warnings are
  the 3 pre-existing unused-var ones at lines 115/606/632, none introduced by this fix; the touched
  `test/risk-receipts.test.ts` has zero warnings).
- Did NOT run `npm run build` per lane instructions (orchestrator runs it at landing).

## Follow-ups

- **Macro-event calendar (FOMC/CPI) is explicitly out of scope** — no such data source exists
  anywhere in this codebase (confirmed by the reference map's exhaustive grep); only a per-symbol
  Yahoo earnings-date field (`daysToEarnings`) exists. If macro-event blackouts are wanted later,
  they need a new calendar data source (e.g. FRED's release-calendar endpoint) wired through
  `src/lib/macro.ts`, which today only fetches point-in-time levels, not future release dates.
- `correlationProfile` caps holdings considered at 15 (by `|marketValue|` descending) to bound
  bar-fetch cost; a book with >15 positions will silently truncate (flagged via `truncated: true` in
  the returned profile, though the current rationale-note text doesn't surface the truncation count —
  worth adding `"(top 15 of N)"` to the note if operators run larger books routinely).
- `stressScenario` uses a single market factor (beta) — it does not model idiosyncratic/sector
  co-movement or a full covariance matrix. This was explicit lane scope ("Out of scope:
  covariance-matrix portfolio VaR"); a future iteration could blend in `correlationProfile`'s pairwise
  correlations for a two-factor (market + cluster) shock.
- No run-level VIX is currently plumbed from `marketScan` into `applyRiskReceipts`; the stress receipt
  always falls back to `stressScenario`'s own default (20, long-run-average VIX) rather than the
  live VIX level `src/lib/macro.ts`/`market-signals/cboe.ts` may already have fetched this run. Wiring
  the live VIX through would make the stress shock size reflect actual current volatility instead of
  a flat assumption — left out here to keep this lane's diff to `strategy.ts` minimal (the live VIX
  isn't threaded into the proposal pipeline's local scope at the `applyRiskReceipts` call site today).
- The correlation + stress receipts run sequentially per opening proposal (same O(holdings) fetch
  pattern as the existing `avgReturnCorrelation`); a run with many opening proposals AND `riskReceipts`
  enabled will multiply `fetchDailyOHLC` calls — bounded by the existing 30-min history cache and the
  15-holding cap, but worth watching rate limits on `reserveMassiveRestCall` if usage grows.

## Deviations from spec

- The spec's Part 2 named the correlation note format as `[Risk] Correlation: max ${corr} w/ ...`; I
  render `corr`/`avgEwma` as percentages (`(max.corr * 100).toFixed(0)}%`) rather than raw
  `-1..1` decimals for readability, consistent with how other rationale notes in this codebase format
  percentages (e.g. sizing notes use `%`). This is a formatting choice, not a semantic deviation.
- The spec suggested naming the combined Part 2+4 flag `riskReceipts` "one flag, one doc comment" —
  implemented exactly as specified.
- `isHardGateReason` was NOT modified — the spec asked to "confirm" `earnings_blackout: ...`
  classifies as overridable, which it already does via the existing denylist-default fallthrough (no
  special prefix carve-out was needed, unlike `deterministic_bear_veto:`/`red_team_veto:`, since the
  earnings-blackout free text never contains a hard-gate substring). Added the pinning test case only.
