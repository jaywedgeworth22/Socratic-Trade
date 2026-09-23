# Trading Outcomes Audit — 2026-08-17

**Roles:** quantitative research, market microstructure, risk, trading-systems engineering, model validation.  
**Scope:** read-only code and docs review of Socratic-Trade at `4980322b` (`main`).  
**Constraint:** no trades, no money-path behavior changes, no policy flips.  
**Deliverable:** this report plus a report-only PR.

Two spaces after every sentence terminator in this document.

---

## 1. Executive verdict

The decision path is unusually well-engineered for a personal live-trading app.  Deterministic sizing overrides the LLM.  Red Team is fail-closed on openings.  Evidence packs are content-addressed.  Paper fills carry a cost model.  Walk-forward IC, permutation significance, RAG `VECTOR_ASOF_STRICT`, and a weekly lookahead-audit lane all exist.

The system is **not yet a validated trading process**.  Outcome accuracy is limited by four structural gaps:

1. **Regime stamps used for learning and crisis caps can be a day stale** while the vol brake and flip detector use live VIX.
2. **Green/Red “parity” is audited, not enforced** at Red review time.
3. **Paper and live lessons are pooled per user** (owner 2026-07-23 / 2026-08-04), while Phase 7 and the 2026-07-13 evidence architecture still describe a transfer gate that was removed.
4. **Backtest / tuner integrity is partial.**  Issue #2280 slice 2 (TraderHarness PIT masking for LLM-in-history) is still planned.  `oosPurgeEmbargo` defaults off.  The IC sample is capped at 500 audit rows.  Paper cost defaults to 1 bps while OOS uses 20 bps.

No P0 “silent fail-open on a risk-adding opening” was found in static review.  The highest-severity items are **P1 validation and stamp-quality** issues: they can systematically bias what the app learns and how it sizes, without placing an order the owner did not authorize.

The June 2026 financial panel (`docs/reviews/2026-06-21-financial-expert-panel.md`) graded edge D and execution realism D.  Plumbing has moved a long way since then.  A demonstrated, cost-aware, out-of-sample edge is still not in evidence from this audit.  This review did not pull production P&L.

---

## 2. Method and sources

- Read `STATUS.md`, `PLAN.md`, `docs/EFFORT-LOG.md`, `docs/phase-1-autonomy-loop.md`, `docs/phase-3-performance.md`, `docs/phase-7-strategy.md`, `docs/oss-lessons.md` §6, `docs/reviews/2026-07-13-decision-evidence-architecture.md`, `docs/reviews/2026-07-01-learning-loop-expansion.md`, `docs/reviews/2026-06-21-financial-expert-panel.md`.
- Traced `src/lib/macro.ts`, `market-regime.ts`, `strategy.ts`, `red-team.ts`, `red-team-routing.ts`, `strategy-execution.ts`, `policy.ts`, `strategy-risk.ts`, `performance.ts`, `backtest.ts`, `execution-cost.ts`, `execution-mode.ts`, `learning-*.ts`, `outcome-engine.ts`, `post-mortem.ts`, `evidence-pack.ts`, `lookahead-audit.ts`, `vector-db.ts`, `db-fundamentals.ts`.
- Listed open GitHub issues and PRs on 2026-08-17.  GitHub MCP was unavailable; `gh` was used.
- Did **not** place trades, flip env knobs, or change execution code.
- Did **not** run `scripts/fetch-prod-ops-snapshot.sh` as a required step.  This is a design/validation audit, not a live-desk RCA.  Production outcome numbers are therefore not claimed.

Severity:

| Grade | Meaning |
|---|---|
| **P0** | Can silently place or size live risk on invalid critic/evidence, or fail-open a required adversary |
| **P1** | Systematically biases regime stamps, learning, OOS, or cost-adjusted outcomes |
| **P2** | Material validation or operator-truth gap |
| **P3** | Hygiene, docs drift, observability |

---

## 3. Related issues and PRs (as of 2026-08-17)

### Directly on this audit’s surface

| ID | State | Relevance |
|---|---|---|
| **#2280** | OPEN, planned | Backtest-integrity suite for the learning loop.  Jesse significance (#2294) and qlib walk-forward window (#2305 / #2327) landed.  **TraderHarness PIT masking (slice 2) is still planned.**  Design: `docs/oss-lessons.md` §6. |
| **#2563** | OPEN | Curl-only server capabilities with no UI: `tuning-dry-run`, `learning-ledger`, `backtest-ic`, audit query.  In-flight UI: PR **#2793**. |
| **#2786** | OPEN (effort) | Green-Team empty/malformed failover + credits hint.  Code on `main` already failovers empty HTTP-200 when fallbacks exist; remaining gaps are malformed JSON + implicit rotation fallbacks. |
| **#2749** | OPEN | Rotation fail-closed, Red timeout, Alpaca penny 422, RAG ingest.  Much of this landed via #2751 (`d068d432`).  Residual: Red still has weaker failover than Green. |
| **#2752** / **#2774** | OPEN (effort) | Review UX: fast approve, live vs proposed price, Retry Red Team.  Merged #2757; issues may be stale mirrors. |
| **#527** | CLOSED completed | “Calibrate paper execution-cost against realized live slippage.”  The **model exists and defaults ON**, but default base is still **1 bps**.  Calibration of coefficients against live mid-vs-fill is not evident in code. |
| **#502** / **#742** / **#869** | CLOSED | PIT leakage certificate, survivorship split, golden-set anti-leakage.  Residual: `FUNDAMENTALS_ASOF_STRICT` still default-off; `certifyForwardResolution` is diagnostic-only. |

### Adjacent open PRs (do not steal)

`#2800` Pinecone write deadlock, `#2798` alert noise, `#2797` CT/UM backoff, `#2796` deploy freshness, `#2795` a11y, `#2794` iOS release leftovers, `#2793` curl-only UI, `#2792` / `#2788` FilingAPI, `#2785` favicon.  None of these change the money path this audit describes.

### Doc contradictions to treat as first-class

- `docs/phase-7-strategy.md` lines 19–20 still say paper lessons transfer only after live corroboration.
- `docs/reviews/2026-07-13-decision-evidence-architecture.md` specifies 20 paper + 5 live lots before transfer.
- Owner later directed **per-user pooling** (`docs/rollouts/2026-07-23-per-user-reflections-learning.md`; `post-mortem.ts:553`; `outcome-engine.ts:1099–1102`).  Learning Review is the only paper-exclusive-defect filter (`learning-review.ts`).

Until one contract is canonical, model-validation claims about “paper does not train live” are false.

---

## 4. How the process actually works

Naming map (easy to get wrong):

| Spoken term | Code | Role |
|---|---|---|
| **Green Team** | Bull / `proposeTrades` / `buildBullSystem` / `step: "bull"` | Proposer LLM |
| **Red Team** | `debateProposal` | Single post-sizing adversary |
| **Bear** | `deterministicBearFilter` only | Deterministic pre-Red vetoes.  In-flow Bear LLM deleted 2026-07-07. |
| **Paper** | `broker/paper` via account `environment` | Real broker sandbox.  No local simulator.  `paperMode` stripped on policy read. |

Pipeline:

```
runStrategyOnce
  → vol brake (live VIX) + drawdown / budget gates
  → market scan + enrichment + score threshold
  → proposeTrades (24h-cached macro → regime stamp → overlays → Green/Bull LLM)
  → deterministicBearFilter
  → deterministic sizing + enrichOpening
  → debateProposal (Red) on risk-adding openings
  → evaluateTradeProposal + resolveSocraticOverride
  → propose: persist pending  |  decide: place if not human-held
  → executeProposal on Approve (re-quote, optional final-size Red)
  → fill_events + socratic_decisions + matureSocraticDecisionOutcomes
  → scorecards / post-mortem / tuner / lookahead audit
```

Evidence: `src/lib/strategy.ts` (`runStrategyOnce` ~439, vol brake ~1008, `proposeTrades` ~4705, Red loop ~2475, placement ~3753), `src/lib/red-team.ts:177`, `src/lib/strategy-execution.ts:232`, `src/lib/execution-mode.ts:50–98`.

Manual “Run once” forces `strategyAuthority: "propose"` (`strategy.ts:482–483`).  It never auto-executes.  Scheduled `decide` is the autonomous money path.

---

## 5. Findings by domain

### 5.1 Macro market analysis and regime

**What works**

- Fabricated regimes are gone.  `BLANK_MACRO` + `asOf === "unavailable"` → `unknown` (`market-regime.ts:86–88`).  Caps stay neutral on a missing feed.
- Typed enum + gate matrix in one module (`crisis` / `risk-off` / `cautious-inverted` / `neutral` / `risk-on` / `unknown`).  Crisis cap, bear filter, and escalation are not independent substring rules.
- Keyless path: Cboe VIX then Yahoo daily, plus Treasury.gov + BLS (`macro.ts` `fetchVixOnlyFallback`).
- Vol brake and regime-watch use `fetchMacroDataWithLiveVix` (10-minute overlay).  Crash-day brake is not pinned to yesterday’s FRED `VIXCLS`.
- Cache provenance is scoped so a user FRED key is not a cross-user leak.

**Findings**

| ID | Sev | Finding | Evidence | Risk |
|---|---|---|---|---|
| M-01 | **P1** | **Propose-time regime uses 24h-cached `fetchMacroData`, not live VIX.**  Brake/flip use the live overlay. | `strategy.ts:4943–4953`, `6201` (`entryMarketRegime`); brake at `1010`; `regime-watch.ts:123`.  Same stale call in `proposal-revalidation.ts:190`, `strategy.ts:1560`, `4233`. | On a crash day, VIX 35 live + cached VIX 16 → stamp `"Neutral (Normal Volatility)"`.  Bear filter, crisis cap, thesis×regime scorecards, and overlays all key off the stamp.  Brake may still trip at VIX ≥ 40.  Learning then credits Neutral for Crisis entries. |
| M-02 | **P1** | **Keyless inversion is unreachable.**  Classifier needs `fedFundsRate` + `dgs10Treasury`.  VIX-only fallback fills treasuries, not fed funds. | `market-regime.ts:90–93`; `macro.ts` `fetchVixOnlyFallback`. | `"Cautious (Inverted Curve)"` never fires without FRED.  3m10y / 2s10s already exist in `deriveMacroMetrics` and are unused by the classifier. |
| M-03 | **P1** | **`asOf` is fetch date, not FRED observation date.**  Mixed-frequency series share one calendar day. | `macro.ts` sets `asOf` to `new Date()` date; `fetchFredSeries` discards observation date. | Evidence manifest and prompt present GDP/CPI/VIX as co-temporal.  Staleness is invisible to Green/Red. |
| M-04 | **P2** | Yahoo VIX lane is **prior daily close** (`range=5d&interval=1d`).  Cboe is `current_price`. | `macro.ts` `fetchVixFromYahoo` / `fetchVixFromCboe`. | If Cboe fails, “live” overlay can be yesterday’s close for up to the 10-minute TTL. |
| M-05 | **P2** | Classifier is **VIX + fed-funds/10Y only**.  HY OAS, VIX term structure, breadth, VVIX/SKEW live in opt-in `computeMultiSignalSeverity` (default off, advisory). | `market-regime.ts:16–21`; `strategy.ts:5012–5013`. | Risk-On label while credit is blowing out.  Severity scorer would flag it and does not gate. |
| M-06 | **P2** | **No hysteresis.**  Memoryless thresholds at VIX 13 / 17 / 20 / 30. | `classifyMarketRegime`. | Flip chatter around 20, especially with live VIX on watch and stale VIX on propose. |
| M-07 | **P3** | Crisis regime at VIX > 30; vol brake default VIX ≥ 40. | `market-regime.ts:95`; `macro.ts` `VOL_BRAKE_DEFAULTS`. | Operators may assume the brake equals Crisis.  Band 30–40 is Crisis/Risk-Off with openings still allowed. |

**Validation gaps:** no integration test that cached VIX=16 + live VIX=35 stamps Neutral while the brake trips.  No test that treasury-only inversion stays Neutral.  No property tests on boundary VIX with simultaneous inversion.

---

### 5.2 Green / Red / Bull process

**What works**

- Green = Bull.  Empty HTTP-200 failover exists when `llmFallbackModels` is set.  Implicit rotation fallbacks (cap 2) exist for Green.
- Red unavailable never fail-opens an opening (`routeOnAdversaryUnavailable` holds for human; `red-team-routing.ts:74–78`).
- Red JSON is not repaired into an approval.  Verdicts are `approve` / `approve-at-half` / `reject`.
- Sizing receipts are computed before Red.  Red is not allowed to invent NAV arithmetic (`finalized-sizing-review.ts`, `red-team.ts` `RedTeamFinalizedSizing`).
- Evidence pack + `greenRedParityHash` is built and audited (`evidence-pack.ts:216–253`; `strategy.ts` `strategy_evidence_pack`).
- Credits-exhausted hint can attach to `run_failed` (2026-08-17 Green failover work).

**Findings**

| ID | Sev | Finding | Evidence | Risk |
|---|---|---|---|---|
| G-01 | **P1** | **`compareGreenRedParity` is never called in production.**  Only unit tests use it. | `evidence-pack.ts:279–284`; grep: `src/lib` has the export, no callers except `test/evidence-pack.test.ts`. | The 2026-07-13 contract (“one provably identical evidence object”) is an audit claim.  Approval-time Red and budget-trimmed prompts can drift undetected. |
| G-02 | **P1** | **Red failover is weaker than Green.**  Red uses only `redTeamFallbackModels`.  No implicit rotation fallbacks.  429 is a single attempt. | `red-team.ts:204–217`, `291–320`; `test/red-team.test.ts` expects `calls === 1` on 429. | One bad Red model + empty fallbacks → every opening held every tick.  Green may still propose.  Queue bloat, not silent trade. |
| G-03 | **P1** | **Red vetoes are overrideable.**  `isHardGateReason` treats `red_team_veto:` / `deterministic_bear_veto:` as non-hard.  `socraticOverrideMode: "execute"` can flip `approved: true`. | `policy.ts:294–303`; `socratic-runtime.ts`; `strategy.ts` pre-veto fold-in. | Intended owner override.  High-risk if treated as “Red approved.”  Efficacy metrics must keep `red_team_veto_override_requested` separate from counterfactual vetoes. |
| G-04 | **P2** | Empty / truncated Green finishes **`completed`**, not failed/skipped.  Score-threshold skip also `completed`. | `strategy.ts` truncation path; `test/strategy-bull-truncation.test.ts`. | Ops and learning treat “completed” as evaluated.  Zero-proposal ticks look like “no edge today.” |
| G-05 | **P2** | Approval-time Red context is a **minimal stub**, not the run `adversaryContext`. | `strategy-execution.ts` `approvalRedContext`. | Final-size Red at Approve does not share Green’s scorecards/RAG/macro pack. |
| G-06 | **P2** | `isRiskAddingOpening` is side+qty, not net-exposure.  A buy that covers a short is still a full Red opening. | `strategy-risk.ts:42–48`; `red-team-routing.ts:54–57` (deferred). | False holds on risk-reducing opens. |
| G-07 | **P3** | Default `deRiskExitsOnAdversaryUnavailable !== true` holds exits on Red failure. | `red-team-routing.ts:81–86`. | Safety vs opportunity cost.  Owner-tunable. |

---

### 5.3 Proposal, approval, execution outcomes

**What works**

- Intent + Socratic case commit in one SQLite transaction before broker submit (Phase 7 2026-07-14 invariants).
- Uncertain broker responses stay `placing` until reconcile.  `(proposalId, brokerOrderId)` prevents duplicate fills.
- Approve path no longer full-universe scans (#2757).  Cards show Proposed / Now / Target / Delay.  Retry Red Team exists.
- Alpaca ≥$1 limits round to $0.01 (#2751) — closes a class of 422s.
- `executionMode` is persisted on proposals and fills.  Stale approve can reject paper/live drift.
- Test broker is refused outside vitest (`strategy.ts:498–505`).

**Findings**

| ID | Sev | Finding | Evidence | Risk |
|---|---|---|---|---|
| E-01 | **P2** | Outcome maturation is **fire-and-forget** after the run. | `strategy.ts:4292–4294` `matureSocraticDecisionOutcomes`. | Near-real-time model validation is impossible.  Red efficacy lags the horizon. |
| E-02 | **P2** | Live `pending_reconciliation` fills can book **price 0** until reconcile. | `performance.ts:221–232`. | Interim scorecards can be garbage if read early. |
| E-03 | **P2** | Funnel statuses are not a first-class metric.  Proposed / policy-blocked / red-reject / red-unavailable / placed / filled must be reconstructed from audits. | Cross-cutting. | Cannot answer “what fraction of Green ideas die at which gate?” without a custom query.  #2563 / #2793 only expose curl/admin entry, not the funnel. |
| E-04 | **P3** | No prod e2e harness without a real paper/live account. | Test broker blocked in prod. | Correct for product philosophy.  Validation stays fragmented across mocks. |

---

### 5.4 Portfolio and risk controls

**What works**

- Layered caps: order notional / % NAV, daily/hourly, symbol %, sector %, gross/net, beta, ADV %, crisis cap (`policy.ts`, `policy-caps.ts`).
- Risk-reducing exits bypass opening caps (does not trap an over-limit book).
- Deterministic sizing: thesis×regime scorecards, conviction cap, vol-target, heat, Kelly-lite.  **Does not parse `learned_context` into math** (`strategy-risk.ts` Phase-0 comment).
- Correlation gate is async and account-leased.
- Vol panic and drawdown breakers flip `close_only` before LLM spend.

**Findings**

| ID | Sev | Finding | Evidence | Risk |
|---|---|---|---|---|
| R-01 | **P2** | ADV cap uses **same-day scan volume**, not trailing ADV. | `strategy-risk.ts:690–705`; `policy.ts` `maxOrderPctOfAdv`. | Spike-day oversize or quiet-day undersize into thin names.  Microstructure 101. |
| R-02 | **P2** | Rule-4 fundamentals veto is **overrideable** via `preVetoReasons`. | `strategy-risk.ts:159–167`. | “Model-independent” veto is not independent under execute-override. |
| R-03 | **P2** | `priorDayTradeCount` is threaded and **unused**.  PDT gate retired. | `policy.ts:89`; `test/pdt.test.ts`. | Dead telemetry.  No FINRA 26-10 advisory even as a non-blocking note. |
| R-04 | **P3** | Portfolio heat uses flat stop % when ATR history is missing. | `strategy-risk.ts:708–716`. | Understated heat on new names.  Documented skip. |
| R-05 | **P3** | Correlation skip drops proposals rather than tagging them. | `strategy-risk.ts:249–278`. | Owner cannot see “blocked for correlation” in the same way as earnings blackout. |

AGENTS.md still flags short/cover daily-notional tracking as high-risk.  This audit did not re-prove all four sides of `OrderSide`.  Treat a short/cover cap matrix as a required test, not a completed proof.

---

### 5.5 Backtests

**What works**

- IC harness over `signal_snapshot` with injectable OHLC.  Unresolved forwards are omitted, not invented (`backtest.ts:8–11`).
- `isPointInTimeForwardExit` — exit strictly after snapshot day (`backtest.ts:146–151`).
- Walk-forward: chronological unique-date split, **always-on embargo** of `horizonDays`, optional purge.
- Autonomous apply is default-off, scoringWeights-only, re-clamped to `MAX_WEIGHT_STEP`, ledgered and revertible.
- Autonomous OOS is stricter than manual: IC-delta margin (env default 0.005), ICIR floor 0.2, paired-t optional (`strategy-tuning.ts:1371–1394`).
- `pitEvidenceCutoff` default ON cuts tuner realized-outcome evidence at fold start (#2327).
- Jesse permutation significance annotates thesis facts (`significance.ts`).  Not a hard gate.

**Findings**

| ID | Sev | Finding | Evidence | Risk |
|---|---|---|---|---|
| B-01 | **P1** | **`DEFAULT_AUDIT_LIMIT = 500`.**  Older snapshots drop out of IC/OOS. | `backtest.ts:25`, `98`. | Recent-regime-only “validation.”  Survivorship in *which history is scored*. |
| B-02 | **P1** | **`purgeEmbargo` defaults false** (policy `oosPurgeEmbargo` too).  Embargo is always on; train/test bar overlap purge is not. | `backtest.ts:1150–1152`; `strategy-tuning.ts:1467`. | Inflated OOS IC when autonomous path runs with defaults.  Comment says purge “fails safe” by shrinking train — the leak is the other direction. |
| B-03 | **P1** | **#2280 slice 2 (PIT masking / entity anonymization) is not implemented.**  Aggregate lessons/reflections are still uncut at the OOS fold. | `docs/oss-lessons.md` §6; issue #2280. | Any LLM-in-loop historical eval measures memorization.  Do not run one until this lands. |
| B-04 | **P2** | Manual `applyOosGate` is **`candidateIC > baselineIC` only.** | `strategy-tuning.ts:758` (comment at 1365–1367). | Human-approved weight changes on noise. |
| B-05 | **P2** | Equity curve treats overlapping horizons as independent cross-sections. | `backtest.ts:912–914`. | Sharpe/drawdown is not a tradable simulation.  Do not show it as account P&L. |
| B-06 | **P2** | Min 4 snapshot dates for OOS; autonomous `minTestDates` default 4; `minCandidateIC` default 0. | `backtest.ts:1148`; `strategy-tuning.ts:1390–1392`. | Auto-apply (if enabled) on a meaningless fold. |
| B-07 | **P3** | `certifyForwardResolution` is diagnostic only.  Not a CI/ops gate. | `backtest.ts:179–237`. | Forward-coverage drift unnoticed. |

---

### 5.6 Benchmark comparisons

**What works**

- Closed-lot alpha = lot return minus benchmark over the same entry→exit window.  Missing bars → no fabricated alpha (`performance.ts:147–159`).
- OOS compounds a SPY same-horizon series in parallel (`backtest.ts:1180–1210`).
- Missed-opportunity mode can exclude rows without SPY.

**Findings**

| ID | Sev | Finding | Evidence | Risk |
|---|---|---|---|---|
| BM-01 | **P2** | OOS benchmark is **SPY same-horizon only**.  No sector/style control. | `backtest.ts:986–1003`. | Factor-tilted books print false alpha vs SPY. |
| BM-02 | **P2** | Skipped-candidate SPY uses **“to now”**, not the outcome-horizon used for placed trades. | `backtest.ts:1007–1029`. | “Missed winner” narratives are not horizon-matched.  Selection bias into the tuner nudge. |
| BM-03 | **P3** | `shrunkAvgAlphaPct` uses the same shrinkage prior as raw returns. | `performance.ts:1598–1599`. | Sparse alpha over-shrunk.  Honest, but under-powered. |

---

### 5.7 Slippage and fees

**What works**

- Paper cost model is **default ON**: `base + half-spread + coeff * sqrt(participation)` (`execution-cost.ts:31–37`).
- Direction is correct: buy/cover pay up, sell/short receive down.
- Live fills are never adjusted (no double-count of broker price).
- Paper **exits** via synthetic stops / replacements get at least base slippage (`applyPaperExitCost`).
- Stop-plan basis uses **raw** fill price, not the cost-adjusted print (`performance.ts:351–356`).

**Findings**

| ID | Sev | Finding | Evidence | Risk |
|---|---|---|---|---|
| C-01 | **P1** | Default **1 bps base** is far below typical US-equity half-spread + fee for most names.  Impact needs a real two-sided quote and dollar volume or it is 0. | `execution-cost.ts:49–52`, `86–94`. | Paper scorecards still look nearly frictionless.  Sizing and auto-tune then scale into the exact names where live cost is worst.  #527 closed “completed” without a live-calibrated default. |
| C-02 | **P1** | **OOS backtest uses 20 bps round-trip**, unrelated to the paper 1 bps model. | `backtest.ts:1135`. | “Net of cost” means two different numbers in two subsystems. |
| C-03 | **P2** | Exit cost is **base only** (no spread/impact) when no quote exists at stop time. | `execution-cost.ts:72–83`. | Losing-tail paper exits still under-costed. |
| C-04 | **P2** | No live **mid-vs-fill** observability.  Live prices are trusted; paper is modeled; they are never compared. | Absence in `performance.ts` / ops snapshot. | Cannot calibrate C-01 from production. |
| C-05 | **P3** | No partial-fill or queue-position model. | `recordFillFromProposal`. | Acceptable if broker average is reconciled.  Paper market-replacements will not match. |

---

### 5.8 Causality and leakage

**What works**

- RAG: `VECTOR_ASOF_STRICT=on` in prod (2026-08-16, #2764).  Live desk still omits `asOf` (correct: fail-closed only when dated).  Strategy path passes `asOf: runAsOf` (`strategy.ts:1421–1423`).
- Weekly `lookahead_audit` lane (`src/lib/lookahead-audit.ts`): truncated OHLC replay vs persisted factor scores; RAG Jaccard vs used rows; honest `unverifiable` for factors that cannot be certified.  Default ON, advisory.
- Forward-return PIT exit guard.  Kill-survivorship for unresolvable Red-efficacy counterfactuals (`performance.ts:1269–1277`).
- `dominantFactor` / `factorBreakdown` stamped at fill so scorecards do not re-join a 500-row audit tail (`performance.ts:294–311`).
- Instruction-like retrieved text is quarantined as data (evidence architecture).

**Findings**

| ID | Sev | Finding | Evidence | Risk |
|---|---|---|---|---|
| L-01 | **P1** | **`FUNDAMENTALS_ASOF_STRICT` defaults off.**  Lenient path falls back to `symbol_field_latest` (today). | `db-fundamentals.ts:191–213`. | Replay / tuner / lookahead can see future fundamentals.  The PIT revision chain exists and is unused by default. |
| L-02 | **P1** | Lookahead audit marks value/quality/volatility/sentiment/positioning/diversification **always unverifiable**. | `lookahead-audit.ts` + 2026-08-12 r3 rollout. | Most of the score is outside the certified set.  A “clean” verdict is not a full-factor certificate. |
| L-03 | **P2** | 500-row audit cap still affects **legacy** lots without entry stamps. | B-01; learning-expansion B5. | Old history silently drops out of factor joins. |
| L-04 | **P2** | Aggregate lessons/reflections are **not cut** at the OOS fold. | `docs/oss-lessons.md` §6 last sentence. | Tuner prompt still sees in-fold prose even when numeric evidence is cut. |
| L-05 | **P3** | `certifyForwardResolution` is a survivorship **proxy**, not a delist tape. | `backtest.ts:179–237`. | Unresolved names vanish.  Coverage can look clean because the dead names never matured. |

---

### 5.9 Paper vs live parity

**What works**

- Product rule is coherent: an account is an account.  `deriveExecutionState` is `broker/paper` | `broker/live` | no account.  No local sim, no `paperMode`.
- FIFO P&L and dashboard series split by `source`.
- `executionMode` drift is a reject reason on stale approve.
- Learning Review has an explicit paper-parity rule: paper is first-class unless a paper-exclusive defect is found.

**Findings**

| ID | Sev | Finding | Evidence | Risk |
|---|---|---|---|---|
| PL-01 | **P1** | **Paper lessons inform live by default.**  `poolThesisStats` / `writeThesisRegimeLessonVectors` / portfolio-scoped `ingestLearned`.  Transfer validation (20/5 lots) was removed. | `post-mortem.ts:242–253`, `548–553`; `outcome-engine.ts:1099–1102`.  Contradicts `docs/phase-7-strategy.md:19–20` and the 2026-07-13 doc. | Live sizing and prompts can train on paper-only edge.  Owner-directed — **not a rogue bug** — but Phase 7 still claims the opposite.  Validation must treat pooling as the live contract. |
| PL-02 | **P1** | Paper cost ≠ live microstructure (C-01).  Limits, partials, rejects, PDT, typed confirm differ. | `execution-cost.ts` vs `preflight-live-guard.ts`. | Paper optimism flows into live via PL-01. |
| PL-03 | **P2** | Tuner `compactPerformance` picks paper **or** live, not a joint view. | `strategy-tuning.ts:814–821`. | Weights can optimize the sandbox the tuner happened to read. |
| PL-04 | **P3** | Margin-minimum gate is no longer live-only (2026-07-23). | Rollout note. | Likely intended.  Confirm in operator copy. |

---

### 5.10 Learning loops

**What works**

- Closed-lot scorecards with Bayesian shrinkage (`SHRINK_PRIOR = 5`).
- Mutation ledger + revert (`learning-ledger.ts`).
- Daily learning review fail-closed on LLM failure; defer preserves the human queue.
- Autonomous weight apply cannot loosen risk caps or set `strategyAuthority: "decide"`.
- Source-value telemetry is labeled observational, not causal (evidence architecture residual #1).
- MAE/MFE excursions exist (`learning-loop.ts`) as async enrichment.

**Findings**

| ID | Sev | Finding | Evidence | Risk |
|---|---|---|---|---|
| LL-01 | **P1** | Autonomous OOS defaults are **thin** (`minTestDates=4`, `minCandidateIC=0`).  Auto-apply is default-off, which saves this today. | `strategy-tuning.ts:1388–1393`. | Enabling `autoApplyWeights` without raising floors is a model-validation incident. |
| LL-02 | **P2** | Missed-opportunity nudge can bump weights from skipped names that rallied. | `applyMissedOpportunityNudge` tests. | Classic selection bias.  Worse with BM-02’s “to now” SPY window. |
| LL-03 | **P2** | Excursion MAE/MFE fetches **live Yahoo**, not PIT bars. | `learning-loop.ts:33–35`. | Acceptable as async post-hoc.  Must not enter OOS evidence. |
| LL-04 | **P2** | Significance annotates only.  A lucky thesis still sizes if `n ≥ 5` at the combo gate. | `significance.ts:12–14`; `strategy-risk.ts:214–216`. | Personal-volume stats are inert.  The 5-trade combo floor is low. |
| LL-05 | **P3** | Learning-ledger / backtest-ic are curl-only until #2793. | Issue #2563. | Owner cannot see mutations without SSH. |

---

### 5.11 Outcome accuracy

**What works**

- FIFO lots carry thesis, regime, confidence, alpha, `entryRunId`, `dominantFactor`.
- Win rate on PnL>0; payoff/Kelly on `returnPct` — documented split (`performance.ts:1548–1569`).
- Red-team efficacy discloses matured vs unresolvable.
- Side-adjusted `returnSinceProposalPct`.
- Chat-draft run ids are permanent idempotency (Phase 7).

**Findings**

| ID | Sev | Finding | Evidence | Risk |
|---|---|---|---|---|
| O-01 | **P2** | Win rate (PnL) and Kelly (returnPct) can **diverge** around commissions / cost-adjusted paper prints. | `performance.ts:1548–1569`. | “60% win rate” can sit next to a negative expectancy sizer. |
| O-02 | **P2** | No first-class **`outcome_join_coverage_pct`**.  Lots missing `entryRunId` / snapshot / alpha are invisible. | Absence. | Cannot certify that scorecards represent the book. |
| O-03 | **P2** | Skipped counterfactuals are market observations, not executable fills (architecture residual).  Combined with 1 bps paper cost, “we should have bought X” is optimistic. | `docs/reviews/2026-07-13-decision-evidence-architecture.md` residual 4. | Tuner nudges on non-tradable prints. |
| O-04 | **P3** | Thesis×regime sizing needs ≥5 trades. | `strategy-risk.ts:214–216`. | Combo overfitting at personal volume. |

---

## 6. Consolidated validation gaps

1. **No runtime Green/Red parity check** (`compareGreenRedParity` unused).
2. **No stale-vs-live VIX integration test** on `entryMarketRegime` vs vol brake.
3. **No paper/live pooling golden test** that states the owner contract (pool vs transfer) and fails if docs and retrieval disagree.
4. **`certifyForwardResolution` not in CI.**  `pointInTimeClean === false` does not fail the build.
5. **No live slippage post-mortem** (mid vs fill, per broker, per side).
6. **No horizon-matched skipped-vs-placed benchmark test.**
7. **No run-status taxonomy tests** (`completed/zero_prop` vs `failed/green_exhausted` vs `skipped_score`).
8. **Short/cover cap matrix** not treated as a standing CI table (AGENTS.md trap).
9. **#2280 slice 2** (PIT masking) blocks any honest LLM historical eval.
10. **Fundamentals as-of** has no coverage receipt analogous to the RAG epoch dry-run (13076/13076).
11. **iOS approve/retry** is not compiled by the local JS gate.  If a change touches `ios/**`, `xcodebuild` is mandatory (AGENTS.md).  This audit did not.

---

## 7. Metrics that should exist

None of these are required to trade.  They are required to **know whether the process is working**.

### Decision funnel

| Metric | Why |
|---|---|
| `strategy_run_finish_status{status, reason_class}` | Split completed/zero_prop, truncated, score_skip, failed/green_exhausted, skipped_budget |
| `proposal_funnel{stage}` | proposed → policy_blocked → red_reject → red_unavailable → override → placed → filled |
| `green_llm_attempts` / `green_failover_reason` | empty, malformed, timeout, http, model |
| `red_review_outcome{verdict, failureKind, model}` | timeout vs approve/reject rates |
| `red_human_hold_rate` | openings in `requiresHumanReview` by reason |
| `parity_mismatch` | after G-01 is enforced |
| `override_applied_count{mode, conflict_type}` | execute-override vs refused |

### Macro / regime

| Metric | Why |
|---|---|
| `macro_vix_staleness_seconds` | propose vs brake |
| `regime_brake_divergence_count` | cached regime ≠ live-VIX regime |
| `macro_feed_mode` | fred_full / vix_treasury_bls / unavailable |
| `regime_flip_rate_24h` | boundary chatter |
| `keyless_vix_source` | Cboe vs Yahoo vs FRED |

### Risk / execution

| Metric | Why |
|---|---|
| `policy_gate_fires{gate, side, environment}` | which cap binds |
| `adv_cap_trim_pct` | thin-name pressure |
| `correlation_skip_count` | silent drops |
| `execution_cost_bps_applied{leg, source}` | paper model distribution |
| `live_slippage_bps{broker, side}` | mid vs fill — **the calibration series for C-01** |
| `paper_vs_live_return_delta{thesis, regime}` | PL-01 monitor |

### Validation / learning

| Metric | Why |
|---|---|
| `backtest_forward_coverage_pct` | from `certifyForwardResolution` |
| `oos_fold_window` + `oos_paired_t_stat` | persist on every tuning proposal, including manual |
| `outcome_join_coverage_pct` | lots with entryRunId + snapshot + alpha |
| `counterfactual_maturity_pct` | skipped / matured / unresolvable |
| `learning_row_environment_breakdown` | already computed; **gate retrieval**, do not only print |
| `lookahead_audit_verdict{clean, mismatch, unverifiable}` | already persisted; surface on Results / ops snapshot |
| `auto_tune_would_apply` | shadow log when `autoApplyWeights` is off |

#2563 / PR #2793 should expose these, not only the existing curl endpoints.

---

## 8. Recommended fixes and upgrades

Ordered for a validation program.  None of these are authorized by this PR.

### P1 — do before trusting scorecards or enabling auto-tune

1. **Unify VIX for all regime consumers in `proposeTrades`.**  Use `fetchMacroDataWithLiveVix` for `determineMarketRegime`, overlays, severity, and `entryMarketRegime`.  Persist `vixAsOf` on the proposal.  Keep the 24h FRED cache for slow series.
2. **Call `compareGreenRedParity` at Red review** (or persist the pack and rebuild Red’s manifest).  Audit mismatches.  Replay the same pack in `executeProposal` final-size Red.
3. **Reconcile the paper→live contract in one place.**  Update `docs/phase-7-strategy.md` and the 2026-07-13 review to match owner pooling — **or** restore the 20/5 transfer gate.  Add `tuning.environmentScope` so a live account can tune on live lots only.  Down-weight paper-only theses in live runs (owner-adjustable, like `iraWashSaleHandling`).
4. **Default `oosPurgeEmbargo: true` on the autonomous path.**  Raise `DEFAULT_AUDIT_LIMIT` or paginate.  Persist the fold window on every readout.
5. **Calibrate paper cost from live mid-vs-fill.**  Do not close this as “model exists.”  Until then, raise the default base toward the OOS 20 bps or document that paper edge is optimistic.  Unify or explicitly dual-name the two constants.
6. **Do not run LLM-in-history eval until #2280 slice 2.**  PIT mask, entity/date anonymization, trajectory export.
7. **Turn `FUNDAMENTALS_ASOF_STRICT` on for replay/tuner/lookahead** even if live stay lenient.  Publish a coverage receipt like the RAG epoch dry-run.

### P2 — strengthen gates and truth

8. Manual OOS gate: require paired t, ICIR, and a min IC-delta — not point IC.
9. Distinct run finish reasons for empty Green / truncation / score skip.
10. Horizon-match skipped counterfactuals to `outcome-horizons`.  Default missed-opportunity nudges to benchmark-relative.
11. ADV cap: trailing median dollar volume, not same-day scan volume.
12. Keyless inversion: use 3m10y / 2s10s from `deriveMacroMetrics` when fed funds is blank.
13. Per-series FRED observation dates in the evidence manifest.
14. Symmetric (bounded) Red rotation fallbacks, or a startup warning when Red rotation has an empty fallback list.
15. Net-exposure Red exemption for buys that reduce shorts.
16. Surface correlation skips as tagged / audited, not silent drops.
17. Raise autonomous `minTestDates` (20+) and `minCandidateIC` before anyone flips `autoApplyWeights`.
18. Sector-ETF optional benchmark layer for single-name alpha.

### P3 — hygiene

19. Rename `deterministicBearFilter` → `deterministicPreRedFilter` in docs/UI.  Kill leftover Bear comments.
20. Remove or use `priorDayTradeCount`.
21. Alias legacy free-text regimes (`Tech-Bull`) for scorecard joins, or migrate rows.
22. Keyless macro-history sparklines (VIX + treasury).
23. Document vol-brake 40 vs Crisis 30 as two bars, or add a policy mode that ties brake to `crisis`.

---

## 9. Prioritized test and evaluation plan

### Tier A — CI, cheap, should exist before the next money-path change

| # | Test | Falsifier |
|---|---|---|
| A1 | Cached VIX=16 + live VIX=35 → stamp ≠ brake regime | `entryMarketRegime` Neutral while `policy_violation_vol_panic` fires |
| A2 | `compareGreenRedParity` called with a mutated Red pack → audit `parity_mismatch` | Drift produces no event |
| A3 | `certifyForwardResolution` fixture with a delisted symbol → coverage drops; CI fails if `pointInTimeClean === false` on the golden set | Unresolved names vanish silently |
| A4 | Paper-only thesis (0 live lots) appears / does not appear in a live-account prompt per the **written** owner contract | Docs say transfer-gate, retrieval pools |
| A5 | Round-trip paper lot at 1 / 5 / 10 / 20 bps → scorecard edge is monotone decreasing | 1 bps and 20 bps produce the same shrunk edge |
| A6 | Short/cover × symbol/sector/gross/net/daily cap matrix | A cover is treated as a risk-adding buy for caps |
| A7 | Run-status: truncation / score-skip / Green-exhausted / budget-skip each have a distinct `reason_class` | All four finish `completed` with empty summary |

### Tier B — eval jobs, weekly or on-demand

| # | Eval | Falsifier |
|---|---|---|
| B1 | Shadow autonomous tune: 30 days of `wouldApply` with current defaults | Apply rate on noise folds > agreed bound |
| B2 | Purge-on vs purge-off IC delta on the same fixture | Purge-off IC exceeds purge-on by more than embargo theory allows |
| B3 | Live slippage harvest: mid vs fill, 30 sessions, by broker and side | Cannot estimate a paper `BASE_BPS` with a confidence interval |
| B4 | Skipped vs placed: same horizon, same SPY window | “Missed winner” mean excess uses a longer window than closed lots |
| B5 | Lookahead-audit panel: % clean / mismatch / unverifiable by factor | “Clean” claimed for unverifiable factors |
| B6 | Fundamentals as-of: replay a known revision (10-Q restatement) under strict vs lenient | Lenient returns the post-revision value before `filed_at` |
| B7 | Outcome join: % new closed lots with `dominantFactor`, `entryRunId`, `alphaPct` | Coverage < 95% on lots opened after the stamp shipped |
| B8 | Regime calibration: realized P&L by **stamped** regime vs **live-VIX-implied** regime | Neutral-stamped Crisis days dominate Neutral P&L |

### Tier C — do not run until #2280 slice 2

| # | Eval | Why blocked |
|---|---|---|
| C1 | LLM-in-the-loop historical “would Green have proposed X on date T?” | Memorization without PIT masking + entity/date anonymization |
| C2 | Auto-apply weights in production | LL-01 floors + B-02 purge + C-01 cost still wrong |

### Suggested ownership

- **A1–A2, A7, M-01 / G-01** — strategy/macro lane (small, high leverage).
- **A3–A5, B1–B4, #2280** — learning/backtest lane (this is issue #2280’s real remaining work, not just slice 2).
- **A4, PL-01 docs** — docs-only follow-up; can land without touching execution.
- **B3** — ops; needs a connected broker and a mid snapshot at send time.  No new broker keys.

---

## 10. Strengths to keep

Do not “simplify” these away in a cleanup pass:

- Fail-closed Red on openings.
- Deterministic sizing and finalized NAV receipts before the critic.
- Content-addressed evidence pack (even if parity is not yet enforced).
- No fabricated macro regime; unknown is a first-class state.
- Paper cost model default ON (coefficients need work; the hook is correct).
- No local simulator; broker paper is a real account.
- `VECTOR_ASOF_STRICT` on; lookahead-audit lane honest about unverifiable factors.
- Autonomous tune cannot change authority or risk caps.
- Owner overrides are explicit, not hidden fail-opens — as long as efficacy joins stay clean.

---

## 11. What this audit did not do

- Place, cancel, or approve any order.
- Change `src/lib/strategy.ts`, policy defaults, or env knobs.
- Pull production P&L, fill tapes, or `/api/ops/snapshot`.
- Re-run the full vitest suite (docs-only change; no behavior claim).
- Compile iOS.
- Adjudicate whether the owner should pool paper into live.  That is an owner policy.  This audit only requires that **docs, retrieval, and metrics tell the same story**.

---

## 12. File index

| Topic | Primary files |
|---|---|
| Macro / regime | `src/lib/macro.ts`, `src/lib/market-regime.ts`, `src/lib/macro-metrics.ts`, `src/lib/regime-watch.ts`, `src/lib/regime-severity.ts` |
| Green / Red | `src/lib/strategy.ts`, `src/lib/red-team.ts`, `src/lib/red-team-routing.ts`, `src/lib/strategy-prompts.ts`, `src/lib/evidence-pack.ts` |
| Execution | `src/lib/strategy-execution.ts`, `src/lib/execution-mode.ts`, `src/lib/preflight-live-guard.ts` |
| Risk | `src/lib/policy.ts`, `src/lib/policy-caps.ts`, `src/lib/strategy-risk.ts` |
| Outcomes | `src/lib/performance.ts`, `src/lib/outcome-engine.ts` |
| Cost | `src/lib/execution-cost.ts` |
| Backtest / tune | `src/lib/backtest.ts`, `src/lib/strategy-tuning.ts`, `src/lib/significance.ts` |
| Learning | `src/lib/learning-loop.ts`, `src/lib/learning-ledger.ts`, `src/lib/learning-review.ts`, `src/lib/post-mortem.ts` |
| Leakage | `src/lib/vector-db.ts`, `src/lib/db-fundamentals.ts`, `src/lib/lookahead-audit.ts` |
| Prior reviews | `docs/reviews/2026-07-13-decision-evidence-architecture.md`, `docs/reviews/2026-06-21-financial-expert-panel.md`, `docs/oss-lessons.md` §6 |
| Open tracker | GitHub #2280, #2563, #2786, #2749 |

---

*End of audit.  Report-only.  Next agent: pick Tier A tests or the Phase 7 paper/live doc reconciliation — do not enable `autoApplyWeights` or an LLM historical eval from this note.*
