# 2026-09-25 — Robinhood $1 minimum correctness fix + account-questionnaire hold + holdReason (lane G3)

## Context & Objective

Owner-directed trading-performance program (board `687a5fb4`).  Production evidence pulled
read-only from the live Robinhood "Agentic" account showed 22 `placing_failed` order rejections
(11x "Fractional orders must be at least $1", 8x "Dollar-based orders must be at least $1", 3x an
account-questionnaire message) despite this codebase already having a broker-minimum pre-flight
guard, plus 4 Autopilot ("decide") proposals landing "Awaiting approval" on 2026-09-23 with no
structured way to see why.  This lane (G3, `st-rh-min-and-hold-reasons`) fixes the root cause of
the first class, adds a durable account-level hold for the second, and adds a structured
`holdReason` for the third.

## Changes Made

**Task A1 — broker-minimum guard's full-position-exit exemption was unsafe.**
`src/lib/broker-minimum-guard.ts`'s `describeBrokerMinimumOrderBlock` exempted a sell/cover that
closes the ENTIRE held position from its own notional-floor fallback check, on a 2026-07-09
assumption that "Robinhood permits liquidating a whole fractional position regardless of its
dollar value."  Nothing in this codebase's Robinhood MCP usage (`robinhood.ts`'s `toMcpOrder`/
`reviewEquityOrder`) documents or exercises such a path, and the production evidence directly
contradicts it — Robinhood rejects a sub-$1 order at `place_equity_order` regardless of whether it
closes the position.  Removed the exemption: a full-position exit under the floor is now blocked
exactly like a partial trim.  `planBrokerMinimumBump` still gets first crack at raising a PARTIAL
trim toward (and, if it fits, up to) the full position — a real bump that can clear the floor — but
now declines immediately (no wasted re-review round trip) when the order is ALREADY the full held
position, since there is nothing left to bump to.  Net effect: an order that truly cannot clear the
floor now blocks BEFORE the broker call with a clear reason, instead of reaching Robinhood and
guaranteed-rejecting.

**Task A2 — Robinhood account-questionnaire error is now a durable account-level hold.**
New `src/lib/broker-account-questionnaire.ts`: detects Robinhood's "We're required to have you
answer some questions about y[our...]" `place_equity_order` rejection (a broker-side account gate,
not a per-order sizing problem — no resize/retry fixes it), persists an account-level
action-required state (`getInternalSetting`/`setInternalSetting`, same pattern as the existing
broker-minimum cooldowns), and gates NEW entries (buy/short) for that account in `strategy.ts`'s
run loop until an opening order for the account is actually accepted again (the only reliable
in-app signal the owner resolved it on Robinhood's site).  Exits and existing management are never
touched.  The owner is alerted once per 24h cooldown (`shouldAlertAccountActionRequired`, mirrors
`shouldAlertBrokerMinimumOrderBlock`), not on every run.  Wired into `strategy.ts` at three points:
the placement catch block (first detection + mark), the run-loop's per-proposal gate (skip openings
while held), and the successful-fill path (clear).  `src/lib/db-notifications.ts`'s auto-ack sweep
was extended (`reconcile: "account_action_required"`) so this alert stays protected like the
existing "uncertain"/"declined" broker-verification alerts — a later run's success elsewhere
(e.g. a sell) must not silently clear a still-active entries-paused state.

**Task B — structured `holdReason` on every "Awaiting approval" proposal.**
New `src/lib/hold-reason.ts`: `HoldReasonCode` (`red_team_unavailable | funding_sell |
policy_revert | other`) plus `classifyHoldReasonFromCodes`, a pure classifier over the existing
`HumanReviewReasonCode` receipts.  `TradeProposal.holdReason` (types.ts) is set at all four
strategy.ts insertion sites that land a proposal in status `"proposed"`: the escalation framework
(wash-sale ask / time-context caps) → `policy_revert`; sell-to-fund "propose" mode → `funding_sell`;
the `"propose"` authority branch and the fail-closed `requiresHumanReview` branch → classified from
whichever `HumanReviewReasonCode`(s) are attached (`initial_red_team`/`final_size_red_team` →
`red_team_unavailable`; `pre_veto_override`/`override_resolution` → `policy_revert`; a standalone
`rationale_collapse` → `other`).  Surfaced in three places: the run summary (the full `proposal`
object, including `holdReason`, is already embedded in `StrategyResult.proposals[]`), the console
approval card (`app/console/components/approval-card.tsx` — a small header chip using
`HOLD_REASON_LABELS`), and `GET /api/ops/performance`'s funnel (`src/lib/ops-performance.ts` —
new `OpsProposalFunnel.holdReasons`/`holdReasonRowsCapped`, same row-capped-rollup shape as the
existing `topBlockReasons`).

**Files touched:**
- `src/lib/broker-minimum-guard.ts` — removed the full-position-exit exemption from
  `describeBrokerMinimumOrderBlock`; `planBrokerMinimumBump` declines immediately for a sell/cover
  already at the full held position.
- `src/lib/broker-account-questionnaire.ts` (new) — detection, mark/get/clear, alert cooldown.
- `src/lib/hold-reason.ts` (new) — `HoldReasonCode`, `HOLD_REASON_LABELS`,
  `classifyHoldReasonFromCodes`.
- `src/lib/types.ts` — `HoldReasonCode` type, `TradeProposal.holdReason`.
- `src/lib/strategy.ts` — wiring for both A2 and B (see above); imports added.
- `src/lib/db-notifications.ts` — `isBrokerVerificationRunFailed` recognizes
  `reconcile: "account_action_required"` as protected.
- `src/lib/ops-performance.ts` — `OpsProposalFunnel.holdReasons`/`holdReasonRowsCapped` +
  query + two empty-funnel fallback literals updated.
- `app/console/components/approval-card.tsx` — holdReason header chip.
- Tests: `test/broker-minimum-guard.test.ts`, `test/broker-minimum-bump.test.ts` (updated for the
  removed exemption); `test/hold-reason.test.ts`, `test/broker-account-questionnaire.test.ts` (new,
  pure-unit); `test/ops-performance.test.ts`, `test/notification-lifecycle.test.ts`,
  `test/final-size-red-autonomous.test.ts`, `test/redteam-failure-routing.test.ts` (assertions
  added to existing `runStrategyOnce` integration coverage).

## Decisions & Trade-offs

- **No new "sub-$1 full-exit" broker path was invented.**  The task asked me to verify what
  Robinhood accepts for a sub-$1 full exit "from the code's MCP/API usage and docs; do not guess."
  Nothing in `robinhood.ts` documents or exercises a special accepted path, and production evidence
  is a direct, unambiguous rejection.  Blocking (with the existing bump-a-partial-trim-toward-full
  attempt first) is the only evidence-backed behavior; I did not fabricate a broker capability.
- **`holdReason` taxonomy is intentionally coarser than `HumanReviewReasonCode`.**  The mapping
  (`initial_red_team`/`final_size_red_team` → `red_team_unavailable`;
  `pre_veto_override`/`override_resolution` → `policy_revert`; anything else → `other`) is a
  judgment call, documented in `hold-reason.ts`'s doc comment — `"red_team_unavailable"` covers
  both "could not run" and "ran but its own verdict needs a decision," which is a slight
  broadening of the name but matches how the existing code already bundles both under one
  `HumanReviewReasonCode` family.
- **No `npm run build`-time DB migration.**  `holdReason` rides inside the existing
  `trade_proposals.proposal` JSON blob (schema already `TEXT NOT NULL`) — no new column, no
  migration, and it degrades honestly (simply absent) on every proposal persisted before this
  change.
- **Account-questionnaire gate sits after Red Team debate, not before.**  The cheapest insertion
  point structurally mirrors the existing `evaluateBrokerHeldExitAvailability` gate (post-decision,
  pre-placement); Red Team debate for a `"decide"`-authority opening already ran earlier in the
  loop by that point, so this gate does not save that LLM cost.  A future optimization could check
  the account-level hold before candidate generation to skip that cost entirely — out of scope
  here (noted below).
- **No full `runStrategyOnce` integration test for the account-questionnaire strategy.ts wiring.**
  Matches this codebase's own established convention: the analogous `evaluateBrokerHeldExitAvailability`
  gate has ONLY a pure-function unit suite (`test/broker-held-orders.test.ts`), no end-to-end
  strategy-loop test.  `broker-account-questionnaire.test.ts` covers the detection regex and the
  account-level state/cooldown primitives at the same level of rigor.
- **`funding_sell` and `policy_revert` (escalation) holdReason assignments are one-line literals,
  not independently integration-tested.**  Both are simple, non-branching assignments right next
  to already-tested insertion code; the classifier function they parallel (used by the other two
  branches) IS unit-tested with 8 cases.  Building a ~150-line `runStrategyOnce` mock harness for
  each (mirroring `final-size-red-autonomous.test.ts`) was judged disproportionate for two
  one-line assignments — flagged as a Next Step below.

## Verification State

Commands run (Node 24 pinned):
```
export PATH=/opt/homebrew/opt/node@24/bin:$PATH
npx eslint src/lib/broker-minimum-guard.ts src/lib/hold-reason.ts src/lib/broker-account-questionnaire.ts \
  src/lib/strategy.ts src/lib/ops-performance.ts app/console/components/approval-card.tsx src/lib/types.ts
npx tsc --noEmit
npx vitest run test/broker-minimum-guard.test.ts test/broker-minimum-bump.test.ts \
  test/broker-minimum-bump-execute.test.ts test/broker-minimum-sizing.test.ts
npx vitest run test/hold-reason.test.ts test/broker-account-questionnaire.test.ts \
  test/ops-performance.test.ts test/final-size-red-autonomous.test.ts test/sell-to-fund.test.ts \
  test/console-universe-discard.test.ts
npx vitest run test/pre-veto-override.test.ts test/washsale-modes.test.ts test/risk-receipts.test.ts \
  test/retry-red-team.test.ts test/redteam-failure-routing.test.ts
npx vitest run test/notification-lifecycle.test.ts
npm run build
```
Results: eslint 0 errors (pre-existing grandfathered warnings only, none new).  `tsc --noEmit`
clean.  Vitest: 63 + 41 + 102 + 20 = 226 targeted tests, all passing.  `npm run build` — see the
rollout PR's CI `verify` run for the authoritative full-suite + build result (this Mac is under
heavy load per the lane brief; the local build was kicked off and is not required to be waited on
inline — the required `verify` CI check is binding).

## Next Steps & Blockers

- Add full `runStrategyOnce` integration coverage for the `funding_sell` and `policy_revert`
  (escalation) `holdReason` assignment sites, mirroring `final-size-red-autonomous.test.ts`'s
  harness — currently covered only by direct code review + the shared pure classifier's unit tests.
- Consider checking the account-questionnaire hold before Red Team debate (candidate-generation
  stage) to actually save the LLM cost the current post-decision insertion point does not.
- The account-level hold clears only on a subsequent ACCEPTED opening order for that account.  If
  the owner resolves the questionnaire on Robinhood but the account then goes quiet (no new
  candidates generated), the hold will not self-clear — worth a manual clear path (e.g. an ops
  endpoint) in a follow-up if that proves annoying in practice.
- This PR carries the `do-not-automerge` label per the lane brief and is NOT armed for auto-merge.

## Zero-Code Findings

None — every task item above resulted in a code or test change.
