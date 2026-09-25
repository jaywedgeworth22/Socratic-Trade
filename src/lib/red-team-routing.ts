import type { OrderSide } from "./types";
import type { RedTeamDebateResult } from "./red-team";

/**
 * Human-readable label for a RedTeamDebateResult.failureKind, used in rationale notes and audit
 * payloads so a reader (human approver or the outcome/audit UI) doesn't need to decode the enum.
 * Falls back to a generic label when failureKind is absent (older/legacy verdicts, or the in-flow
 * Bear's own reason string which doesn't carry a failureKind at all).
 */
export function describeRedTeamFailureKind(failureKind: RedTeamDebateResult["failureKind"]): string {
  switch (failureKind) {
    case "not_configured":
      return "not configured";
    case "timeout":
      return "timeout";
    case "provider_error":
      return "provider error";
    case "rate_limited":
      return "rate limited";
    case "malformed_response":
      return "malformed response";
    default:
      return "unavailable";
  }
}

export interface AdversaryUnavailableRouting {
  /** True when this proposal must be held for human approval (openings only). */
  holdForHuman: boolean;
  /** Loud, human-facing rationale note to append to `proposal.rationale`. */
  note: string;
}

/**
 * Policy-aware routing decision for when the approval-time Red Team debate (`debateProposal`)
 * could NOT run (`available: false`) — de-risk-only routing consistency (design doc / board item
 * "Bear/Red-Team unavailable -> policy-aware routing for ALL failure modes").
 *
 * Openings (`buy`/`short`) are risk-INCREASING: ALWAYS hold for human review, matching the in-flow
 * Bear's existing openings-only gate (strategy.ts's `bearReviewUnavailable` branch) so the two
 * adversary passes agree on failure-mode routing. This is unconditional regardless of the policy
 * flag below.
 *
 * Exits (`sell`/`cover`) are risk-REDUCING. Whether they are held for human review depends on
 * `deRiskExitsOnAdversaryUnavailable` (owner ruling 2026-09-24, board 687a5fb4: default flipped
 * from OFF to ON — `src/lib/defaults.ts`'s `DEFAULT_POLICY.tuning` now sets it `true`, and
 * `mergePolicy` deep-merges `tuning` so every stored policy that never explicitly set this key
 * inherits the new default):
 *  - DEFAULT (true, or undefined for a caller that bypasses the merged policy entirely): do NOT
 *    hold — blocking a de-risking trade on an adversary outage is itself unsafe (mirrors the
 *    rationale-collapse gate and the in-flow Bear's own "exits must still flow through" comment).
 *    Instead we append a loud rationale note and let the caller emit the parity audit event, so
 *    the human-facing signal is never silently lost even though the order proceeds without a hold.
 *  - OPT-OUT (explicit `false`): hold for human review, same as openings — the pre-2026-09-24
 *    behavior, still available per-account for anyone who wants the old, more conservative hold.
 *
 * Side classification is RAW-side (buy/short vs sell/cover), the codebase-wide convention (see
 * strategy.ts's other `isOpening`-style checks) — net-exposure-aware classification (a buy that
 * actually covers an existing short, netting risk-reducing) is an explicitly deferred follow-up,
 * not implemented here.
 */
export function routeOnAdversaryUnavailable(
  side: OrderSide,
  failureKind: RedTeamDebateResult["failureKind"],
  reason: string,
  deRiskExitsOnAdversaryUnavailable?: boolean,
  // Whether a NON-held proposal would actually auto-execute without further review — true under
  // `decide` authority, false under `propose` authority (where every proposal becomes a
  // pending-approval card regardless of holdForHuman). Only affects the wording of the opt-in
  // de-risk-exit note so the rationale never claims an order is "proceeding" when propose authority
  // is still surfacing it for approval. Defaults true (decide-authority semantics).
  autoExecutes: boolean = true
): AdversaryUnavailableRouting {
  const isOpening = side === "buy" || side === "short";
  const kindLabel = describeRedTeamFailureKind(failureKind);

  if (isOpening) {
    return {
      holdForHuman: true,
      note: `\n\n⚠ RED TEAM FAILED (${kindLabel}): review was REQUIRED (high conviction) but unavailable (${reason}); routed to human approval.`
    };
  }

  if (deRiskExitsOnAdversaryUnavailable === false) {
    // Explicit per-account opt-OUT: hold for human review, same as an opening.
    return {
      holdForHuman: true,
      note: `\n\n⚠ RED TEAM FAILED (${kindLabel}): review required but unavailable (${reason}); routed to human approval.`
    };
  }

  // Default (true, or undefined — a caller outside the merged policy, e.g. a test): the exit is
  // not held. Under `decide` it proceeds (auto-executes); under `propose` it is still surfaced as a
  // pending-approval card, so word the note accordingly and never claim it is "proceeding" when it
  // is actually awaiting approval.
  return {
    holdForHuman: false,
    note: autoExecutes
      ? `\n\n⚠ RED TEAM FAILED (${kindLabel}): review unavailable — proceeding because this order reduces risk.`
      : `\n\n⚠ RED TEAM FAILED (${kindLabel}): review unavailable — surfaced for your approval (this order reduces risk).`
  };
}
