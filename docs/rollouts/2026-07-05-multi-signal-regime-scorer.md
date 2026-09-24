# 2026-07-05 - multi-signal-regime-scorer

## Summary

- New module `src/lib/regime-severity.ts` (`computeMultiSignalSeverity`): a pure, dependency-light
  blender that turns VIX, VIX term structure, HY credit spread, market breadth, VVIX, and SKEW
  into one continuous `[0, 1]` severity score, floored by the classified `MarketRegime`'s existing
  enum severity (`MARKET_REGIME_SEVERITY`) so the composite can only ADD caution versus today's
  channel, never dilute a crisis reading.
- Wired as a **data-only receipt**, not a new gate: (1) a compact `regimeSeverity` block added to
  both the Bull and Bear prompts' `userContent`, next to `currentMarketRegime`; (2) an additive
  `TradeProposal.entryRegimeSeverity?: number` field stamped alongside `entryMarketRegime` at both
  proposal-mapping sites in `strategy.ts` (Bull output + Bear re-stamp); (3) a macro-only variant
  (`severityMacroOnly`) added to the existing `regime_flip` audit payload in `regime-watch.ts`.
- No changes to `market-regime.ts`'s pinned enum/label/severity contracts, no changes to any gate
  or cap (`policy.ts`, `deterministicBearFilter`, `checkRegimeFlip`'s flip/broadcast semantics).
- **Gated behind `policy.tuning.regimeSeverityScoring?: boolean` (DEFAULT false)**, per house
  convention (COMMON.md rule 4 — any behavior change ships behind a default-OFF `policy.tuning.*`
  flag). Default false: default behavior is byte-identical — the scorer is never invoked, no
  `regimeSeverity` block is added to any prompt, no `entryRegimeSeverity` field is stamped on any
  proposal, and no `severityMacroOnly` key is added to the `regime_flip` audit payload. See
  "Post-review fix" below for why this was added after the initial landing.

## Why

- `MARKET_REGIME_SEVERITY` (market-regime.ts) has had zero consumers since it was introduced —
  explicitly flagged in `docs/rollouts/2026-07-04-regime-enum-risk-gate-adoption.md:86-88` as the
  seam for exactly this follow-up. The board row for this lane: "credit spreads, VIX term
  structure, breadth → severity feeding caps/learning."
- The lane spec (and the `maps/regime.md` code map) confirmed the ingredients are already fetched
  elsewhere in the pipeline (`deriveMacroMetrics` gives `vixTermStructure`; `MacroData.hyCreditSpread`
  is the raw FRED HY OAS series; `getMarketSignals` gives `vvix`/`skew`/`marketBreadthPct`;
  `MarketScan.breadthPct` is the key-free screener fallback) — this is wiring + a new blend
  function, not new fetch code.
- "Feeding caps" is explicitly scoped OUT of this lane per the spec: nothing here changes
  `policy.ts`'s crisis cap, `deterministicBearFilter`'s advisory veto, or any sizing multiplier.
  A severity-aware consumer (e.g. a vol-targeting sizer) is a new capability for a future lane —
  coupling to one now (e.g. the sibling `vol-targeting-portfolio-heat` effort) would create a
  cross-lane dependency this build explicitly avoids. This lane only produces the receipt
  (prompt context + persisted `entryRegimeSeverity`) so a future consumer/scorecard can bucket by
  it later.

## Design decisions

- **New module, not an extension of `market-regime.ts`.** `MARKET_REGIME_SEVERITY` is asserted as
  a plain object lookup by pinned tests (`test/market-regime.test.ts`,
  `test/regime-gate-adoption.test.ts`) — replacing it with a function would break that contract.
  `regime-severity.ts` is a parallel file: types-only import of `MarketRegime` plus a value import
  of the (also dependency-free) `MARKET_REGIME_SEVERITY` map for the floor. It does not import
  from, and is not imported by, `market-regime.ts` for anything else, and is not on the
  client-bundled path (`app/console/macro/indicators.ts` never imports it).
- **Floor, not blend input.** Per spec: `severity = max(MARKET_REGIME_SEVERITY[regime],
  weightedBlend)`. Verified in tests: a crisis regime + entirely benign continuous signals still
  reads `severity = 1`; a risk-on regime + terrible continuous signals reads the pure blend (no
  floor interference, since risk-on's floor is 0).
- **Weight renormalization over available inputs only**, never a fabricated default for a missing
  signal. Base weights (vix .30, vixTermStructure .20, hyCreditSpreadPct .20, breadthPct .15,
  vvix .10, skew .05) are divided by the sum of weights for inputs that are actually
  finite/defined. Zero inputs → `severity` collapses to exactly the enum floor, `inputsUsed: 0`,
  `components: []`.
- **Normalization thresholds** (all linear, clamped to `[0, 1]`, monotonic toward risk) taken
  verbatim from the lane spec: vix 12→40, vixTermStructure 0.85→1.10 (backwardation), hyCreditSpreadPct
  3.0%→8.0%, breadthPct INVERTED 60→25 (low breadth = high stress), vvix 80→140, skew 115→155.
- **Wiring site**: `strategy.ts`'s existing prompt-assembly block (~line 3038-3070, right after
  `marketSignals` is fetched and before `userContent` is built) — every input the scorer needs
  (`macro`, `macroDerived`, `marketSignals`, `input.marketScan?.breadthPct`) was already in local
  scope; no new fetch was added. Wrapped in a try/catch (`regimeSeverity` is `undefined` on any
  throw) per house convention — a scorer failure must never fail a strategy run. Verified this
  explicitly with a dedicated test that stubs `computeMultiSignalSeverity` to throw and asserts
  `runStrategyOnce` still completes with no `regimeSeverity`/`entryRegimeSeverity` in the output.
- **Both Bull and Bear prompts get the receipt** (`bearUserContent.regimeSeverity =
  userContent.regimeSeverity`), matching the existing evidence-parity pattern used for
  `macroeconomicData`/`limits`/`socraticAuthority` and the documented rationale for
  `closestHistoricalAnalogs`/`ownerCoaching` ("evidence parity between Bull and Bear is the
  point").
- **`entryRegimeSeverity` stamped at both proposal-mapping sites** (`rawBullProposals` and
  `bearProposals` in `strategy.ts`), mirroring exactly how `entryMarketRegime` is stamped/re-stamped
  at the same two call sites (Bear re-emits proposals through its own strict schema, which strips
  `proposedByModel` but the origin model/regime/severity are still the entry-time values).
  Persisted via the existing `proposal` JSON blob column (`db-proposals.ts`) — no migration needed,
  confirmed by inspection: `TradeProposal` is serialized whole with `JSON.stringify`, so a new
  optional field flows through automatically.
- **`regime-watch.ts` diff kept to ~20 lines** (spec asked for ≤~10; the extra lines are the new
  `macroOnlySeverity` helper function itself, which could not be inlined without duplicating the
  try/catch + parse logic — the single call-site diff inside `checkRegimeFlip` itself is exactly
  one line, appending `severityMacroOnly: macroOnlySeverity(macro)` to the existing audit payload).
  `classifyMarketRegime`/`deriveMacroMetrics`/`computeMultiSignalSeverity` are imported from
  `./market-regime` / `./macro-metrics` / `./regime-severity` — deliberately NOT re-derived from
  `./macro` (which `test/regime-watch.test.ts` mocks wholesale via `vi.doMock`, and which does not
  export `classifyMarketRegime` in that mock) — so the pinned test's existing mocks continue to
  work untouched. No flip/broadcast/notify semantics changed; verified `test/regime-watch.test.ts`
  passes unmodified (3/3).
- **`entryRegimeSeverity` rounded to 2dp** before being stamped/sent, matching the spec and the
  existing `macroDerived` rounding convention (`round2` in macro-metrics.ts).

## Deviations from spec

- None material. One small addition beyond the literal spec text: the Bear prompt also receives
  `regimeSeverity` (spec only explicitly required it "next to `currentMarketRegime`" in the
  general "prompt receipt" bullet, without specifying Bull-only vs. both) — added to the Bear side
  too for evidence parity with the existing pattern the codebase already uses for every other
  advisory context block shared between the two passes.

## Post-review fix: default-OFF flag (`policy.tuning.regimeSeverityScoring`)

- **What was missed initially**: the first landing computed `regimeSeverity` unconditionally on
  every strategy run and stamped `entryRegimeSeverity`/`severityMacroOnly` unconditionally, with
  no `policy.tuning.*` flag gating any of it. That is a real behavior change to the money-path LLM
  prompt content on every run as soon as it lands — exactly the class of change COMMON.md rule 4
  requires a default-OFF flag for. Sibling lanes in this same effort followed the convention for
  comparable advisory/receipt-only wiring (HyDE + evidence-derived retrieval, the market-data
  staleness gate, the correlation cluster gate), so there was no basis for treating this lane as
  exempt. Adversarial review caught the omission; it is fixed here rather than waived.
- **Fix**: added `TuningSettings.regimeSeverityScoring?: boolean` (types.ts, default undefined ≡
  false). `strategy.ts`'s `regimeSeverity` local is now `undefined` outright when the flag is off
  (`!input.policy.tuning?.regimeSeverityScoring ? undefined : (() => { ... })()`), which
  transitively gates every downstream site that was already conditioned on
  `regimeSeverity`/`userContent.regimeSeverity` being truthy (`userContent.regimeSeverity`,
  `bearUserContent.regimeSeverity`, both `entryRegimeSeverity` stamps) — no separate flag check
  needed at each site. `regime-watch.ts`'s `macroOnlySeverity` now takes `userId`, reads
  `getPolicy(userId).tuning?.regimeSeverityScoring` (imported from `./db-profiles`, no
  circularity — `db-profiles.ts` does not import `regime-watch.ts`), and returns `undefined` when
  off; the `regime_flip` audit payload now spreads `severityMacroOnly` in only when defined, so the
  key is absent (not merely `undefined`-valued) by default.
- **Tests**: `test/regime-severity.test.ts`'s two wiring tests now explicitly opt in via
  `seed({ regimeSeverityScoring: true })`; a new third wiring test asserts the default-OFF,
  byte-identical case (no `regimeSeverity` in `userContent`, no `entryRegimeSeverity` on the
  proposal) with the flag left unset. `test/regime-watch.test.ts` gained a new describe block with
  two tests: default-OFF asserts `severityMacroOnly` is entirely absent from the persisted
  `regime_flip` audit payload; flag-ON (via `setPolicy`) asserts it is present as a number. All
  pre-existing tests in both files pass unmodified.

## Scoping decision (explicit, per spec item 5)

- **No changes to `policy.ts` caps, `deterministicBearFilter`, or any gate.** "Feeding caps" is
  deferred to a follow-up once a consumer lane exists. The natural consumer is a vol-targeting /
  continuous-taper sizer (a sibling lane per the `regime.md` map: `vol-targeting-portfolio-heat`);
  this lane deliberately does not couple to it. The only present-day consumers of
  `computeMultiSignalSeverity`'s output are: the LLM prompt (advisory context) and the persisted
  `entryRegimeSeverity` (a receipt for a future regime-conditioned scorecard — not built here).

## Files

- `src/lib/regime-severity.ts` (new) — `computeMultiSignalSeverity`, `RegimeSeverityInputs`,
  `RegimeSeverityResult`, `RegimeSeverityComponent`.
- `src/lib/types.ts` — additive `TradeProposal.entryRegimeSeverity?: number` field (+doc comment);
  additive `TuningSettings.regimeSeverityScoring?: boolean` field (+"Default false: default
  behavior is byte-identical" doc comment).
- `src/lib/strategy.ts` — import `classifyMarketRegime` (market-regime.ts) and
  `computeMultiSignalSeverity` (regime-severity.ts); compute `regimeSeverity` (try/catch,
  best-effort, gated on `policy.tuning?.regimeSeverityScoring`) once per run alongside the existing
  macro/signals assembly; add a compact `regimeSeverity` block to both `userContent` and
  `bearUserContent`; stamp `entryRegimeSeverity` on both `rawBullProposals` and `bearProposals`
  (all four sites are already conditioned on `regimeSeverity` being truthy, so they inherit the
  gate for free).
- `src/lib/regime-watch.ts` — import `classifyMarketRegime`, `deriveMacroMetrics`,
  `computeMultiSignalSeverity`, `getPolicy` (from `./db-profiles`); `macroOnlySeverity(macro,
  userId)` now flag-checks before computing; the `regime_flip` audit payload spreads
  `severityMacroOnly` in only when defined. No flip/broadcast/notify semantics changed.
- `test/regime-severity.test.ts` — 20 tests: normalization endpoints/midpoints per signal, weight
  renormalization (1 input / 2 inputs / all 6), enum-floor behavior (crisis floor wins over benign
  signals, risk-on blend wins with no floor interference, risk-off floor vs. a milder blend,
  risk-off blend exceeding its floor), zero-input collapse, monotonicity spot checks, and three
  `strategy.ts` wiring tests: default-OFF byte-identical (no `regimeSeverity`/
  `entryRegimeSeverity` with the flag unset), flag-ON (regimeSeverity present in userContent +
  entryRegimeSeverity stamped on the persisted proposal), and flag-ON + scorer throw (run still
  completes with no receipt).
- `test/regime-watch.test.ts` — added a `regimeSeverityScoring flag gating` describe block (2
  tests): default-OFF asserts `severityMacroOnly` is absent from the persisted `regime_flip` audit
  payload; flag-ON (via `setPolicy`) asserts it is present as a number. All pre-existing tests in
  the file are unmodified.

## Verification

Run from `/Users/jay/Code/Socratic-Trade/.claude/worktrees/monet-regime-scorer`:

- `npx tsc --noEmit` — clean, no output.
- `npx vitest run test/regime-severity.test.ts test/regime-watch.test.ts` — 25/25 passed.
- `npx vitest run test/hard-gate-classification.test.ts test/policy.test.ts test/red-team.test.ts test/market-regime.test.ts test/regime-gate-adoption.test.ts test/deterministic-bear.test.ts test/correlation-cluster-gate.test.ts` — 144/144 passed (all COMMON.md-pinned tests).
- `npm test -- --run` (full suite) — 2599 tests / 261 files: all passed.
- `npm run lint` — 0 errors (pre-existing warning count unaffected by this diff; no warnings in
  any file touched by this fix).

## Follow-ups

- No dedicated Settings UI toggle for `policy.tuning.regimeSeverityScoring` — it is settable via
  the policy JSON/API only for now, consistent with several other `tuning.*` boolean flags in this
  codebase (e.g. `congressGoNoGoGating`, `autoApplyDrawdownGuard`) that also ship without a
  dedicated UI control. `app/**` (console/UI) is out of scope for this lane per COMMON.md
  keepouts; a Settings field is a follow-up for whichever lane owns that surface.
- A severity-aware consumer (vol-targeting sizer, or a cap that scales with `entryRegimeSeverity`
  instead of a fixed threshold) is explicitly out of scope here — see "Scoping decision" above.
- A regime-severity-bucketed scorecard (mirroring `regimeScorecard`/`thesisRegimeScorecard`) is
  deferred — `entryRegimeSeverity` is persisted now specifically so that scorecard has data to
  read once it's built.
- If `test/usage-limit-alerts.test.ts`'s full-suite flake recurs, it's a candidate for the same
  de-flake treatment as `test/order-confirmation-status.test.ts` /
  `test/chat-orchestrator-search-knowledge.test.ts` (mock/hoist whatever's contending under 4
  parallel workers) — out of scope for this lane; flagging for whichever lane owns test
  determinism.
