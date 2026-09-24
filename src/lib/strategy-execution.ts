import { LANE_WAITS, withAccountMutation } from "./account-mutation";
import { loadApprovalQuoteScan } from "./approval-quote-scan";
import { repriceStoredLimitProposal } from "./approval-reprice";
import { getBrokerGateway } from "./broker";
import { evaluateBrokerHeldExitAvailability, brokerHeldExitBlockReason } from "./broker-held-orders";
import { describeBrokerMinimumOrderBlock, planBrokerMinimumBump, shouldAlertBrokerMinimumOrderBlock } from "./broker-minimum-guard";
import { hasBrokerReportedFill, hasBrokerReportedPricedFill, isLiveOrderState, isRejectedOrCanceledState } from "./broker-side";
import { audit, clearStopPlans, deriveExitContractFromOpening, getDb, recordStopPlan } from "./db";
import { auditDeduped } from "./audit-dedupe";
import { getActiveConnectedAccount } from "./db-api-keys";
import { acquireStrategyLock, dailyExecutionStats, notionalInLastMinutes, countDayTradesInLastBusinessDays, releaseStrategyLock } from "./db-execution";
import {
  listPendingBrokerReconciliationFills,
  markUnreconcilableUnusableBrokerOrderFills,
  netAccountingFillQuantity,
  updateFillEvent,
  listFillEventsByProposalId
} from "./db-fills";
import { resolveBrokerVerificationNotifications } from "./db-notifications";
import { getPolicy } from "./db-profiles";
import { getProposal, updatePendingProposalReprice, updateProposalStatus, transitionProposalIfPending, claimProposalForExecution, listStalePlacingProposals } from "./db-proposals";
import { upsertSocraticDecisionCase } from "./db-socratic";
import { emitDashboardEvent } from "./events";
import { isOrderPlacementInfrastructureFailure } from "./broker-health";
import { deriveExecutionState, fillSourceForExecutionMode } from "./execution-mode";
import {
  assessFinalSizeConsentDrift,
  captureProposalSizingSnapshot,
  proposalForFinalSizeRedReview,
  redTeamSizingFromSnapshot,
  stampRedTeamResult
} from "./finalized-sizing-review";
import { currentMarketSession } from "./market-hours";
import { normalizeSymbol } from "./money";
import { sendNotification } from "./notifications";
import { OperationLeaseOwnershipError } from "./operation-lease";
import { recordFillFromProposal } from "./performance";
import { estimateNotional, applyOpeningOrderHeadroom, evaluateTradeProposal } from "./policy";
import { effectiveDailyOpeningNotionalCap } from "./policy-caps";
import { assertLivePreflight } from "./preflight-live-guard";
import { repriceStoredProtectiveExit, assessProtectiveExitRepriceDrift } from "./protective-exit-routing";
import { debateProposal, type RedTeamDebateResult, type RedTeamReviewContext } from "./red-team";
import { describeRedTeamFailureKind } from "./red-team-routing";
import { buildSocraticDecisionCase } from "./socratic-runtime";
import { notifyStaleLimitOrders } from "./stale-limit-orders";
import { freshPlacementBlockReason } from "./system-state-placement-guard";
import { getUserWashSaleLockProvenance } from "./tax";
import { ExecutionMode, FillEvent, OrderValidationError, PolicyDecision, BrokerGateway, TradeProposal, ReviewedOrder, MarketScan, EquityOrder, EquityPosition, FillSource } from "./types";
import { applyRedTeamHalfSize, approvedEscalationsFromDecision, isRiskAddingOpening, shouldEscalateDecision } from "./strategy-risk";
import {
  createExecuteProposalLockOwner,
  startStrategyLockGuard,
  StrategyLockOwnershipLostError
} from "./strategy-lock-guard";
import {
  isRetryableBrokerHttpError,
  isTerminalBrokerHttpError,
  type ExecuteProposalResult
} from "./placement-outcome";
import { appendDecisionStep, assertLiveApprovalConfirmation, protectiveExitQuoteFromScan, openingPolicyNotionalCap, autoRevertOnCapBreach, auditWashSaleProceed } from "./strategy";

export interface LiveApprovalConfirmation {
  proposalId?: string;
  accountNumber?: string | null;
  executionMode?: ExecutionMode | string;
  estimatedNotional?: number | null;
  typedText?: string | null;
}
export class LiveApprovalConfirmationError extends Error {
  code = "LIVE_CONFIRMATION_REQUIRED";
  reasons: string[];
  expectedText: string;

  constructor(reasons: string[], expectedText: string) {
    super(reasons.join(" "));
    this.reasons = reasons;
    this.expectedText = expectedText;
  }
}
export type PlacementReconcileOutcome =
  | { kind: "placed"; orderId: string; state: string; fillStatus: ReconciledFillStatus; fill?: FillEvent; alreadyBooked: boolean }
  | { kind: "declined"; orderId: string; state: string }
  | { kind: "not_placed" }
  | { kind: "uncertain"; error: string };

type ReconciledFillStatus = "filled" | "partially_filled" | "pending_reconciliation";

type ExecutionTruth = {
  quantity: number;
  price: number;
  notional: number;
};

function bookedExecutionTruth(fill: FillEvent | undefined): ExecutionTruth | undefined {
  if (!fill || (fill.status !== "partially_filled" && fill.status !== "filled")) return undefined;
  if (!Number.isFinite(fill.quantity) || fill.quantity <= 0 || !Number.isFinite(fill.price) || fill.price <= 0) return undefined;
  return { quantity: fill.quantity, price: fill.price, notional: Math.abs(fill.quantity * fill.price) };
}

function positiveFinite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function persistedBrokerQuantityFloor(fill: FillEvent | undefined): number {
  if (!fill) return 0;
  const raw = (fill.raw ?? {}) as {
    maxBrokerFilledQuantity?: unknown;
    execution?: { filledQuantity?: unknown };
    reconciliation?: { filledQuantity?: unknown };
    order?: { filledQuantity?: unknown };
  };
  const candidates = [
    fill.status === "filled" || fill.status === "partially_filled" ? positiveFinite(fill.quantity) : undefined,
    positiveFinite(raw.maxBrokerFilledQuantity),
    positiveFinite(raw.execution?.filledQuantity),
    positiveFinite(raw.reconciliation?.filledQuantity),
    positiveFinite(raw.order?.filledQuantity)
  ].filter((value): value is number => value !== undefined);
  return candidates.length > 0 ? Math.max(...candidates) : 0;
}

function reconciliationRaw(fill: FillEvent, order: EquityOrder, knownQuantity: number): Record<string, unknown> {
  return {
    ...((fill.raw as Record<string, unknown>) ?? {}),
    reconciliation: order,
    ...(knownQuantity > 0 ? { maxBrokerFilledQuantity: knownQuantity } : {})
  };
}

function brokerExecutionTruth(order: { filledQuantity?: number | null; averagePrice?: number | null }): ExecutionTruth | undefined {
  if (!hasBrokerReportedPricedFill(order)) return undefined;
  const quantity = order.filledQuantity!;
  const price = order.averagePrice!;
  return { quantity, price, notional: Math.abs(quantity * price) };
}

/** Merge cumulative broker execution monotonically. Broker order snapshots can arrive out of
 * order, so a smaller/later-zero snapshot must never unbook exposure already persisted from a
 * priced partial fill. Conversely, a larger quantity without a realized average price remains
 * unresolved instead of borrowing the old/proposal price for shares whose execution cost is
 * unknown. */
function mergedExecutionTruth(
  order: { filledQuantity?: number | null; averagePrice?: number | null },
  existing?: FillEvent
): { truth?: ExecutionTruth; knownQuantity: number; unresolvedGrowth: boolean } {
  const prior = bookedExecutionTruth(existing);
  const reported = brokerExecutionTruth(order);
  const reportedQuantity = hasBrokerReportedFill(order) ? order.filledQuantity! : 0;
  const knownQuantity = Math.max(persistedBrokerQuantityFloor(existing), reportedQuantity);

  if (reported && reported.quantity >= knownQuantity && (!prior || reported.quantity >= prior.quantity)) {
    return { truth: reported, knownQuantity, unresolvedGrowth: false };
  }
  if (prior) {
    return {
      truth: prior,
      knownQuantity,
      unresolvedGrowth: knownQuantity > prior.quantity
    };
  }
  return { truth: undefined, knownQuantity, unresolvedGrowth: knownQuantity > 0 };
}

/** Convert raw broker lifecycle into accounting truth. A terminal state with positive executed
 * quantity AND a realized broker price is a final execution, not a decline. Existing booked
 * execution is monotonic: stale snapshots cannot downgrade it, while unpriced growth remains
 * pending reconciliation. */
function reconciledFillStatus(
  order: { state: string; filledQuantity?: number | null; averagePrice?: number | null },
  existing?: FillEvent
): ReconciledFillStatus {
  const merged = mergedExecutionTruth(order, existing);
  if (merged.unresolvedGrowth) return merged.truth ? "partially_filled" : "pending_reconciliation";
  if (existing?.status === "filled" && merged.truth) return "filled";
  if (!merged.truth) return "pending_reconciliation";
  if (order.state === "filled" || isRejectedOrCanceledState(order.state)) return "filled";
  if (order.state === "partially_filled" || existing?.status === "partially_filled") return "partially_filled";
  return "pending_reconciliation";
}

function brokerExecutedNotional(order: { filledQuantity?: number | null; averagePrice?: number | null }): number | undefined {
  return brokerExecutionTruth(order)?.notional;
}

/** Commit an opening stop plan only after broker truth proves some execution. Reconciliation paths
 * may be the first point where that proof exists, including a terminal partial fill. */
async function commitRecoveredOpeningStopPlan(input: {
  gateway: BrokerGateway;
  accountNumber: string;
  userId: string;
  proposal: TradeProposal;
  price: number;
  /** The recovered/reconciled order's own broker ID — recorded as the plan's openingOrderId ONLY
   *  when the proposal carried bracket fields (enrichOpeningProposal strips them unconditionally
   *  for "trailing"/"none", so this naturally scopes to fixed/atr) — see performance.ts's identical
   *  reasoning at its own recordStopPlan call site. */
  orderId?: string;
}): Promise<void> {
  const { proposal } = input;
  if (!proposal.stopPlan || (proposal.side !== "buy" && proposal.side !== "short")) return;
  try {
    if (proposal.stopPlan.style === "default") {
      clearStopPlans(input.accountNumber, [proposal.symbol], input.userId);
      return;
    }
    let basis = input.price;
    try {
      const positions = await input.gateway.getEquityPositions(input.accountNumber);
      basis = positions.find((position) => normalizeSymbol(position.symbol) === normalizeSymbol(proposal.symbol))?.averageCost ?? basis;
    } catch {
      // The broker fill price remains a valid fallback for a fresh position.
    }
    const openingOrderId = (proposal.bracketStopLoss != null || proposal.bracketTakeProfit != null) ? input.orderId : undefined;
    const contract = deriveExitContractFromOpening({
      side: proposal.side === "short" ? "short" : "buy",
      avgCost: basis,
      bracketStopLoss: proposal.bracketStopLoss,
      bracketTakeProfit: proposal.bracketTakeProfit,
      invalidation: proposal.autonomyOverride?.invalidation
    });
    recordStopPlan(
      input.accountNumber,
      proposal.symbol,
      proposal.stopPlan.style,
      proposal.stopPlan.rationale,
      basis,
      input.userId,
      undefined,
      proposal.side === "short" ? "short" : "long",
      openingOrderId,
      contract
    );
  } catch {
    // Stop-plan bookkeeping must never reverse a durable broker-fill receipt.
  }
}
export async function executeProposal(
  proposalId: string,
  userId: string = "local",
  // leaseWaitMs: caller-supplied override for the mutation-lease bounded wait, defaulting to
  // LANE_WAITS.approvalPlacement. A bulk-approve batch shares one wait BUDGET across every
  // proposal in the request (computed once before its loop) instead of paying up to
  // LANE_WAITS.approvalPlacement per proposal serially — see app/api/proposals/bulk-approve/route.ts.
  options: { liveConfirmation?: LiveApprovalConfirmation; leaseWaitMs?: number } = {}
): Promise<ExecuteProposalResult> {
  const policy = getPolicy(userId);
  const activeAccount = getActiveConnectedAccount(userId);
  const executionState = deriveExecutionState(policy, activeAccount);
  if (!policy.accountNumber) throw new Error("No account selected.");
  // Captured once, narrowed: a property access (`policy.accountNumber`) loses its non-null
  // narrowing across a closure boundary (the mutation-lease callback below), but a local const
  // of a primitive keeps it.
  const accountNumber = policy.accountNumber;
  // An account is an account: with none connected there is no broker to trade through, and there is
  // no local-simulation fallback. Refuse to run rather than synthesize a fake fill.
  if (!executionState.mode) throw new Error("No connected account. Connect a broker account before approving trades.");
  const executionMode: ExecutionMode = executionState.mode;
  const executionSource = fillSourceForExecutionMode(executionMode);
  if (policy.systemState === "halted") throw new Error("System is halted.");

  const row = getProposal(proposalId, userId);
  if (!row) throw new Error("Proposal not found.");
  if (row.status !== "proposed") throw new Error(`Proposal is already ${row.status}.`);
  if (row.accountNumber !== policy.accountNumber) {
    throw new Error("Proposal account no longer matches the selected account. Re-run the strategy before approving.");
  }
  if (row.executionMode && row.executionMode !== executionMode) {
    throw new Error("Proposal execution mode no longer matches the selected mode. Re-run the strategy before approving.");
  }

  // `let`: an approval-held protective exit is repriced against the fresh approval-time quote below.
  let proposal = row.proposal;
  // A prior approval attempt can persist a fresh Red objection against an execution-time broker
  // bump. This click explicitly confirms THAT stored size/verdict. Consume it once below only if
  // the order shape stays unchanged; a new bump gets its own review and cannot inherit consent.
  let ownerApprovedStoredFinalSize = proposal.finalSizeReview?.ownerApprovalRequired === true;
  assertLiveApprovalConfirmation({
    executionMode,
    confirmation: options.liveConfirmation,
    proposalId,
    accountNumber: row.accountNumber,
    proposal,
    estimatedNotional: row.estimatedNotional ?? row.review?.estimatedNotional,
    requireTypedConfirmation: policy.requireTypedConfirmation !== false
  });

  // TOCTOU guard on notional/order caps: the daily/hourly cap check reads the
  // trade_proposals table BEFORE inserting the new row. Without this lock, a
  // concurrent autonomous run (which holds acquireStrategyLock) and a manual
  // Approve can each read the same pre-cap totals and both place — jointly
  // exceeding maxDailyNotional / maxHourlyNotional / maxDailyOrders. Acquiring
  // the same lock here serialises approval execution against the strategy loop.
  // Every invocation gets its own owner token. Two same-proposal approvals must contend like any
  // other callers; a loser can never share or release the winner's lease.
  const lockOwner = createExecuteProposalLockOwner(proposalId);
  if (!acquireStrategyLock(lockOwner, userId, policy.connectedAccountId)) {
    return { status: "busy", reasons: ["A strategy run is in progress; try again in a moment."] };
  }
  const lockGuard = startStrategyLockGuard({ owner: lockOwner, userId, connectedAccountId: policy.connectedAccountId });

  try {
    const gateway = getBrokerGateway(policy, userId);

    const [portfolio, positions, orders] = await Promise.all([
      gateway.getPortfolio(policy.accountNumber),
      gateway.getEquityPositions(policy.accountNumber),
      gateway.getEquityOrders(policy.accountNumber)
    ]);
    // Quote the proposal + held names only. A full-universe scanMarket here is why
    // Approve sat on "Sending approve…" for tens of seconds (NASDAQ screener + enrich).
    const approvalScan = await loadApprovalQuoteScan({
      proposal,
      positions,
      userId,
      accountNumber: policy.accountNumber,
      connectedAccountId: policy.connectedAccountId
    });

    // An account is an account: the approval is always evaluated against the real broker-reported
    // portfolio and positions for the active account — there is no local-simulation alternative.
    const account = { portfolio, positions };
    lockGuard.assertOwned();
    await notifyStaleLimitOrders({ userId, policy, orders });
    lockGuard.assertOwned();

    // Approval-held protective exits: an extended-hours marketable-limit stored on the card was
    // priced off the generation-time quote and goes stale while it waits for a human — a quote that
    // moved through the stored limit would leave the once-marketable order resting unfilled where
    // the queue-to-open market exit still gets out. Re-resolve the routing off the fresh quote and
    // wall clock (degrading to market/regular_hours when the extended session no longer applies) and
    // review/evaluate/place the repriced order. Everything else passes through untouched.
    const storedProposal = proposal;
    const approvalExitQuote = protectiveExitQuoteFromScan(
      approvalScan.quotesBySymbol[proposal.symbol] ?? approvalScan.quotesBySymbol[normalizeSymbol(proposal.symbol)]
    );
    proposal = repriceStoredProtectiveExit(proposal, policy, approvalExitQuote);
    if (proposal !== storedProposal) {
      const confirmedNotional = row.estimatedNotional ?? row.review?.estimatedNotional;
      const drift = assessProtectiveExitRepriceDrift(storedProposal, proposal, policy, approvalExitQuote, confirmedNotional);
      // Fresh estimate for the persisted card; a degrade to market has no limit price to estimate
      // from (estimateNotional returns 0), so keep the stored estimate rather than write a zero.
      const repricedEstimate = estimateNotional(proposal);
      const repricedNotional = Number.isFinite(repricedEstimate) && repricedEstimate > 0 ? repricedEstimate : undefined;
      const repriceChange = {
        proposalId,
        symbol: proposal.symbol,
        side: proposal.side,
        from: { type: storedProposal.type, limitPrice: storedProposal.limitPrice, marketHours: storedProposal.marketHours },
        to: { type: proposal.type, limitPrice: proposal.limitPrice, marketHours: proposal.marketHours },
        drift
      };
      // LIVE typed-confirmation invariant (repo precedent: autoRemediateStaleExitOrders defers
      // live+typed-confirm remediation to the human rather than silently substituting): the phrase
      // the user typed confirmed the STORED order, so a MATERIAL reprice — price or notional beyond
      // the marketable-limit buffer tolerance — must go back to approval, not to the broker. The
      // card stays pending with the repriced order persisted so the next Approve confirms the
      // numbers that will actually be placed. Immaterial drift places normally below (also audited,
      // via the drift payload on protective_exit_repriced).
      const typedConfirmGatesLive = executionMode === "broker/live" && policy.requireTypedConfirmation !== false;
      if (typedConfirmGatesLive && drift.material) {
        const reason = `Protective exit repriced materially while awaiting approval (price drift ${
          drift.priceDriftBps !== undefined ? Math.round(drift.priceDriftBps) : "unverifiable"
        } bps vs ${drift.toleranceBps} bps tolerance) — a live typed confirmation covered the prior order, so approve the repriced order again.`;
        const persisted = updatePendingProposalReprice(proposalId, { proposal, estimatedNotional: repricedNotional }, userId);
        audit("protective_exit_reprice_reapproval", { ...repriceChange, reason, persisted }, userId, policy.connectedAccountId);
        if (!persisted) {
          const current = getProposal(proposalId, userId)?.status ?? "removed";
          throw new Error([`Proposal was ${current} before it could be executed.`].join(" "));
        }
        await sendNotification(
          {
            type: "pending_approval",
            title: `${proposal.symbol} protective exit repriced — approval needed again`,
            payload: { proposalId, proposal, previous: storedProposal, drift, reason }
          },
          { policy, userId }
        );
        throw new Error([reason].join(" "));
      }
      // Persist the repriced order BEFORE claiming/placing so trade_proposals.proposal (Recent,
      // Activity, getProposal) shows the order the broker actually received, never the stale
      // generation-time price. CAS on status='proposed': if the card expired or was rejected while
      // this approval was in flight, stop here like the other pending guards.
      if (!updatePendingProposalReprice(proposalId, { proposal, estimatedNotional: repricedNotional }, userId)) {
        const current = getProposal(proposalId, userId)?.status ?? "removed";
        throw new Error([`Proposal was ${current} before it could be executed.`].join(" "));
      }
      audit("protective_exit_repriced", repriceChange, userId, policy.connectedAccountId);
    }

    // Approval-held ORDINARY limit orders (entries and regular-hours exits, any side): the stored
    // limitPrice was anchored to the generation-time quote and goes stale the same way the
    // protective exits above do — an overnight approval would place yesterday's price into today's
    // market. Re-anchor the limit to the fresh approval-time quote, preserving the stored
    // limit-to-anchor ratio (src/lib/approval-reprice.ts). The protective path keeps precedence:
    // this runs only when it returned the stored object unchanged (reference equality — the
    // double-reprice guard), and repriceStoredLimitProposal itself declines proposals it claims.
    if (proposal === storedProposal && proposal.type === "limit") {
      const limitReprice = repriceStoredLimitProposal(proposal, policy, approvalExitQuote);
      if (limitReprice.proposal !== proposal) {
        proposal = limitReprice.proposal;
        const limitDrift = limitReprice.drift;
        // Fresh estimate for the persisted card and the live typed-confirmation re-check.
        const repricedEstimate = estimateNotional(proposal);
        const repricedNotional = Number.isFinite(repricedEstimate) && repricedEstimate > 0 ? repricedEstimate : undefined;
        // Receipts must match the order the broker will see: a repriced risk-adding opening
        // recaptures its sizing snapshot (buildSocraticDecisionCase / lifecycle sync persist the
        // embedded snapshot — leaving the generation-time size would record stale notional and
        // pct-of-NAV into learning data).
        if (repricedNotional !== undefined && isRiskAddingOpening(proposal, account.positions)) {
          proposal.sizingSnapshot = captureProposalSizingSnapshot({
            proposal,
            estimatedNotional: repricedNotional,
            policy,
            portfolioValue: account.portfolio.totalMarketValue,
            dailyNotionalUsed: dailyExecutionStats(policy.accountNumber, new Date(), userId).notional
          });
        }
        const repriceChange = {
          proposalId,
          symbol: proposal.symbol,
          side: proposal.side,
          from: { limitPrice: storedProposal.limitPrice, anchorPrice: storedProposal.repriceAnchorPrice ?? storedProposal.referencePrice },
          to: { limitPrice: proposal.limitPrice, anchorPrice: proposal.repriceAnchorPrice },
          drift: limitDrift
        };
        // Same LIVE typed-confirmation invariant as the protective-exit reprice above: the phrase
        // the user typed confirmed the STORED limit, so a MATERIAL reprice — anchor drift beyond
        // the marketable-limit buffer tolerance — goes back to approval, not to the broker. The
        // card stays pending with the repriced order persisted so the next Approve confirms the
        // price that will actually be placed. Immaterial drift places normally below (audited via
        // the drift payload on approval_limit_repriced).
        const typedConfirmGatesLive = executionMode === "broker/live" && policy.requireTypedConfirmation !== false;
        // Once the reprice moves the limit, the entry-drift guard's limit-order exemption
        // (policy.ts — "the broker's limit caps the fill") no longer protects the thesis: the cap
        // now tracks the market. An OPENING whose anchor drifted beyond policy.maxEntryDriftPct
        // therefore goes back to the human on EVERY execution mode, not just live+typed.
        const isOpeningSide = proposal.side === "buy" || proposal.side === "short";
        const entryDriftCapBps = (policy.maxEntryDriftPct ?? 0) * 100;
        const beyondEntryDriftCap =
          isOpeningSide && entryDriftCapBps > 0 && (limitDrift.anchorDriftBps ?? 0) > entryDriftCapBps;
        if ((typedConfirmGatesLive && limitDrift.material) || beyondEntryDriftCap) {
          const driftText = limitDrift.anchorDriftBps !== undefined ? `${Math.round(limitDrift.anchorDriftBps)} bps` : "an unverifiable amount";
          const reason = beyondEntryDriftCap
            ? `Quote moved ${driftText} while this opening awaited approval — beyond the ${policy.maxEntryDriftPct}% entry-drift cap. The limit was re-anchored; approve the repriced order again if the thesis still holds.`
            : `Limit price re-anchored materially while awaiting approval (quote moved ${driftText} vs ${limitDrift.toleranceBps} bps tolerance) — a live typed confirmation covered the prior price, so approve the repriced order again.`;
          proposal = { ...proposal, priceRequoteReason: reason, priceRequotedAt: new Date().toISOString() };
          // The held card must not keep an approved:true decision receipt (reloads/other clients
          // would show an approved decision for an order explicitly held for fresh consent) —
          // same pattern as the final-size requote below.
          const heldDecision: PolicyDecision = {
            ...row.decision,
            approved: false,
            reasons: [...new Set([...(row.decision.reasons ?? []), reason])]
          };
          const persisted = updatePendingProposalReprice(proposalId, { proposal, estimatedNotional: repricedNotional, decision: heldDecision }, userId);
          audit("approval_limit_reprice_reapproval", { ...repriceChange, reason, persisted }, userId, policy.connectedAccountId);
          if (!persisted) {
            const current = getProposal(proposalId, userId)?.status ?? "removed";
            throw new Error([`Proposal was ${current} before it could be executed.`].join(" "));
          }
          await sendNotification(
            {
              type: "pending_approval",
              title: `${proposal.symbol} limit price repriced — approval needed again`,
              payload: { proposalId, proposal, previous: storedProposal, drift: limitDrift, reason }
            },
            { policy, userId }
          );
          throw new Error([reason].join(" "));
        }
        // Persist the repriced order BEFORE claiming/placing (same CAS-on-'proposed' rationale as
        // the protective reprice): the row must show the order the broker actually received.
        if (!updatePendingProposalReprice(proposalId, { proposal, estimatedNotional: repricedNotional }, userId)) {
          const current = getProposal(proposalId, userId)?.status ?? "removed";
          throw new Error([`Proposal was ${current} before it could be executed.`].join(" "));
        }
        audit("approval_limit_repriced", repriceChange, userId, policy.connectedAccountId);
      }
    }

    const tradability = await gateway.getEquityTradability(policy.accountNumber, [proposal.symbol]);
    lockGuard.assertOwned();
    if (!tradability[proposal.symbol]?.tradable) {
      const reason = tradability[proposal.symbol]?.reason ?? "Symbol is not tradable.";
      const tradabilityDecision: PolicyDecision = { approved: false, reasons: [reason] };
      updateProposalStatus(proposalId, "blocked", undefined, undefined, undefined, userId, undefined, undefined, tradabilityDecision);
      audit("proposal_approved", { proposalId, symbol: proposal.symbol, side: proposal.side, action: "approval", result: "blocked", reason }, userId, policy.connectedAccountId);
      await sendNotification(
        {
          type: "block",
          title: `${proposal.side.charAt(0).toUpperCase() + proposal.side.slice(1)} ${proposal.symbol} blocked`,
          payload: { proposalId, reason, proposal }
        },
        { policy, userId }
      );
      throw new Error([reason].join(" "));
    }

    let review = await gateway.reviewEquityOrder({ accountNumber: policy.accountNumber, ...proposal });
    lockGuard.assertOwned();

    // Same broker-minimum pre-flight guard as the autonomous run loop: NAV/sizing can drift between
    // proposal creation and a human clicking Approve, so re-check here too rather than let a
    // known-doomed order reach the broker from this path. Same bump-first handling (owner ruling:
    // bump, not skip) and whole-position dust-exit exemption as the autonomous loop (see the guard);
    // the bumped order is re-reviewed and still goes through evaluateTradeProposal below.
    const heldForMinimumGuard = positions.find((p) => normalizeSymbol(p.symbol) === normalizeSymbol(proposal.symbol));
    let brokerMinimumBlockReason = describeBrokerMinimumOrderBlock(review, policy.activeBroker, { ...proposal, positionQuantity: heldForMinimumGuard?.quantity });
    // Hoisted above the guard: the bump planner bounds opening bumps by the remaining
    // daily/hourly budget (values unchanged for the post-guard consumers — the skip path
    // returns without placing anything).
    const daily = dailyExecutionStats(policy.accountNumber, new Date(), userId);
    const hourly = notionalInLastMinutes(policy.accountNumber, 60, new Date(), userId);
    let attemptedBumpToNotional: number | undefined;
    // Typed live confirmations and bumps: the owner's confirmation (validated earlier in this
    // function) was minted against the STORED pre-bump notional. A bump can raise the placed
    // notional to the broker floor (+0.5% cushion, so ≤ ~$1.01 on Robinhood) — a bounded,
    // owner-ruled default (brokerMinimumHandling "bump", 2026-07-09), so we deliberately do NOT
    // force a re-confirmation ceremony for that sub-dollar delta; the order_bumped_broker_minimum
    // audit records both sizes and the rationale annotates the up-sizing.
    if (brokerMinimumBlockReason && (policy.brokerMinimumHandling ?? "bump") === "bump") {
      // Same composed cap as the run loop: policy's headroomed per-order cap ∧ remaining
      // daily/hourly budget ∧ available buying power — a bump past any of these would be
      // policy-rejected (and a cap breach can demote authority via autoRevertOnCapBreach).
      const effectiveMaxDailyNotional = effectiveDailyOpeningNotionalCap(
        policy,
        account.portfolio.totalMarketValue
      );
      const openingCapNotional = Math.min(
        applyOpeningOrderHeadroom(openingPolicyNotionalCap(proposal, policy, account.portfolio)),
        effectiveMaxDailyNotional - daily.notional,
        (policy.maxHourlyNotional ?? Infinity) - hourly.notional,
        // Mirror policy.ts's buying-power gate (binds when finite && > 0).
        Number.isFinite(account.portfolio.buyingPower) && account.portfolio.buyingPower > 0 ? account.portfolio.buyingPower : Infinity
      );
      // Daily ORDER-COUNT budget (not just notional) — see the run-loop site.
      const openingCountSpent =
        (proposal.side === "buy" || proposal.side === "short") &&
        policy.maxDailyOrders != null &&
        daily.openingOrderCount >= policy.maxDailyOrders;
      const bumpPlan = openingCountSpent ? undefined : planBrokerMinimumBump(
        review,
        policy.activeBroker,
        { ...proposal, positionQuantity: heldForMinimumGuard?.quantity, positionMarketValue: heldForMinimumGuard?.marketValue },
        { openingCapNotional: Number.isFinite(openingCapNotional) ? openingCapNotional : undefined }
      );
      if (bumpPlan) {
        const originalSizing = { quantity: proposal.quantity, dollarAmount: proposal.dollarAmount };
        const originalReview = review;
        Object.assign(proposal, bumpPlan.patch);
        review = await gateway.reviewEquityOrder({ accountNumber: policy.accountNumber, ...proposal });
        lockGuard.assertOwned();
        const stillBlocked = describeBrokerMinimumOrderBlock(review, policy.activeBroker, { ...proposal, positionQuantity: heldForMinimumGuard?.quantity });
        if (!stillBlocked) {
          proposal.rationale = `${proposal.rationale} [Sized up from $${bumpPlan.fromNotional.toFixed(2)} to meet the broker's minimum order size (brokerMinimumHandling: bump).]`;
          audit(
            "order_bumped_broker_minimum",
            { proposalId, symbol: proposal.symbol, side: proposal.side, fromNotional: bumpPlan.fromNotional, toNotional: review.estimatedNotional, reason: brokerMinimumBlockReason, action: "approval" },
            userId,
            policy.connectedAccountId
          );

          // Consent attached to an earlier execution shape does not carry over to this new one.
          ownerApprovedStoredFinalSize = false;
          if (isRiskAddingOpening(proposal, account.positions)) {
            const fullBumpedReview = review;
            const fullBumpedSizing = { quantity: proposal.quantity, dollarAmount: proposal.dollarAmount };
            proposal.sizingSnapshot = captureProposalSizingSnapshot({
              proposal,
              estimatedNotional: fullBumpedReview.estimatedNotional,
              policy,
              portfolioValue: account.portfolio.totalMarketValue,
              dailyNotionalUsed: daily.notional
            });
            const quote = approvalScan.topCandidates.find(
              (candidate) => normalizeSymbol(candidate.symbol) === normalizeSymbol(proposal.symbol)
            );
            const approvalRedContext: RedTeamReviewContext = {
              currentDate: new Date().toISOString().slice(0, 10),
              currentMarketRegime: proposal.entryMarketRegime,
              portfolio: account.portfolio,
              positions: account.positions,
              limits: {
                maxOrderNotional: policy.maxOrderNotional,
                maxDailyNotional: policy.maxDailyNotional,
                maxDailyPctOfNav: policy.maxDailyPctOfNav,
                dailyNotionalUsed: daily.notional,
                hourlyNotionalUsed: hourly.notional
              },
              candidatesUnderReview: quote ? [quote] : []
            };
            let finalRed: RedTeamDebateResult;
            try {
              finalRed = await debateProposal(
                proposalForFinalSizeRedReview(proposal),
                quote,
                userId,
                policy,
                {
                  context: approvalRedContext,
                  sizing: redTeamSizingFromSnapshot(proposal.sizingSnapshot)
                }
              );
            } catch (error) {
              finalRed = {
                rejected: false,
                available: false,
                reason: `Final-size Red Team review threw unexpectedly: ${error instanceof Error ? error.message : String(error)}`,
                failureKind: "provider_error"
              };
            }
            lockGuard.assertOwned();
            stampRedTeamResult(proposal, finalRed);
            proposal.preVetoReasons = proposal.preVetoReasons?.filter(
              (reason) => !reason.startsWith("red_team_veto:")
            );
            if (proposal.preVetoReasons?.length === 0) delete proposal.preVetoReasons;

            let ownerApprovalReason: string | undefined;
            if (!finalRed.available) {
              ownerApprovalReason = `The final broker-adjusted size could not be re-reviewed by Red (${describeRedTeamFailureKind(finalRed.failureKind)}): ${finalRed.reason}`;
            } else if (finalRed.rejected || finalRed.verdict === "reject") {
              ownerApprovalReason = `Red rejected the final broker-adjusted size: ${finalRed.reason}`;
            } else if (finalRed.verdict === "approve-at-half") {
              const haircut = applyRedTeamHalfSize(proposal);
              if (!haircut.applied) {
                ownerApprovalReason = `Red authorized only half size, but that size is not executable: ${haircut.note}`;
              } else {
                const haircutReview = await gateway.reviewEquityOrder({ accountNumber: policy.accountNumber, ...proposal });
                lockGuard.assertOwned();
                const haircutBlock = describeBrokerMinimumOrderBlock(haircutReview, policy.activeBroker, {
                  ...proposal,
                  positionQuantity: heldForMinimumGuard?.quantity
                });
                if (haircutBlock) {
                  // Restore the full, already broker-reviewed bump. Never feed the haircut back into
                  // the bump planner: that would negate Red's one allowed down-only intervention.
                  Object.assign(proposal, fullBumpedSizing);
                  review = fullBumpedReview;
                  proposal.sizingSnapshot = captureProposalSizingSnapshot({
                    proposal,
                    estimatedNotional: fullBumpedReview.estimatedNotional,
                    policy,
                    portfolioValue: account.portfolio.totalMarketValue,
                    dailyNotionalUsed: daily.notional
                  });
                  ownerApprovalReason = `Red authorized only half size, but the broker rejects that haircut: ${haircutBlock}`;
                } else {
                  review = haircutReview;
                  proposal.sizingSnapshot = captureProposalSizingSnapshot({
                    proposal,
                    estimatedNotional: haircutReview.estimatedNotional,
                    policy,
                    portfolioValue: account.portfolio.totalMarketValue,
                    dailyNotionalUsed: daily.notional
                  });
                  proposal.rationale += `\n\nRed Team review — final broker-adjusted size approved at half: ${finalRed.reason} [${haircut.note}]`;
                  audit(
                    "red_team_approved_at_half_after_broker_minimum",
                    { proposalId, symbol: proposal.symbol, side: proposal.side, model: finalRed.model, haircut: haircut.note, finalNotional: haircutReview.estimatedNotional, action: "approval" },
                    userId,
                    policy.connectedAccountId
                  );
                }
              }
            } else {
              proposal.rationale += `\n\nRed Team review — final broker-adjusted size approved at full size: ${finalRed.reason}`;
            }

            proposal.finalSizeReview = {
              trigger: "broker_minimum_bump",
              fromNotional: bumpPlan.fromNotional,
              toNotional: fullBumpedReview.estimatedNotional,
              reviewedAt: new Date().toISOString(),
              ownerApprovalRequired: Boolean(ownerApprovalReason),
              ...(ownerApprovalReason
                ? { ownerApprovalReason, ownerApprovalNotional: review.estimatedNotional }
                : {})
            };
            audit(
              "red_team_rereview_after_broker_minimum",
              {
                proposalId,
                symbol: proposal.symbol,
                side: proposal.side,
                fromNotional: bumpPlan.fromNotional,
                bumpedNotional: fullBumpedReview.estimatedNotional,
                finalNotional: review.estimatedNotional,
                verdict: finalRed.verdict,
                available: finalRed.available,
                model: finalRed.model,
                ownerApprovalRequired: Boolean(ownerApprovalReason),
                ownerApprovalReason,
                action: "approval"
              },
              userId,
              policy.connectedAccountId
            );

            if (ownerApprovalReason) {
              proposal.rationale += `\n\nRed Team review — final broker-adjusted size requires owner approval: ${ownerApprovalReason}`;
              const pendingDecision: PolicyDecision = {
                ...row.decision,
                approved: false,
                reasons: [...new Set([...(row.decision.reasons ?? []), ownerApprovalReason])],
                ...(!finalRed.available
                  ? { adversaryUnavailable: true, adversaryUnavailableReason: ownerApprovalReason }
                  : { adversaryUnavailable: undefined, adversaryUnavailableReason: undefined })
              };
              const persisted = updatePendingProposalReprice(
                proposalId,
                { proposal, review, estimatedNotional: review.estimatedNotional, decision: pendingDecision },
                userId
              );
              if (!persisted) {
                const current = getProposal(proposalId, userId)?.status ?? "removed";
                throw new Error([`Proposal was ${current} before the final-size review could be saved.`].join(" "));
              }
              await sendNotification(
                {
                  type: "pending_approval",
                  title: `${proposal.symbol} broker-adjusted size needs your approval`,
                  payload: { proposalId, proposal, review, decision: pendingDecision, reason: ownerApprovalReason }
                },
                { policy, userId }
              );
              throw new Error([ownerApprovalReason].join(" "));
            }
          }

          // Persist successful execution-time sizing before later policy checks. If one of those
          // checks blocks, the ledger/case still describes the exact order it evaluated.
          if (!updatePendingProposalReprice(proposalId, { proposal, review, estimatedNotional: review.estimatedNotional }, userId)) {
            const current = getProposal(proposalId, userId)?.status ?? "removed";
            throw new Error([`Proposal was ${current} before the broker-adjusted size could be saved.`].join(" "));
          }
        } else {
          Object.assign(proposal, originalSizing);
          review = originalReview;
          attemptedBumpToNotional = bumpPlan.toNotional;
        }
        brokerMinimumBlockReason = stillBlocked ? brokerMinimumBlockReason : undefined;
      }
    }
    if (brokerMinimumBlockReason) {
      const blockedDecision: PolicyDecision = { approved: false, reasons: [brokerMinimumBlockReason] };
      updateProposalStatus(proposalId, "blocked", undefined, review, review.estimatedNotional, userId, undefined, undefined, blockedDecision);
      audit(
        "order_skipped_broker_minimum",
        { proposalId, symbol: proposal.symbol, side: proposal.side, estimatedNotional: review.estimatedNotional, reason: brokerMinimumBlockReason, action: "approval", ...(attemptedBumpToNotional !== undefined ? { attemptedBumpToNotional } : {}) },
        userId,
        policy.connectedAccountId
      );
      if (shouldAlertBrokerMinimumOrderBlock(userId, policy.accountNumber, proposal.symbol)) {
        await sendNotification(
          {
            type: "block",
            title: `${proposal.side.charAt(0).toUpperCase() + proposal.side.slice(1)} ${proposal.symbol} skipped (below broker minimum)`,
            payload: { proposalId, decision: blockedDecision, review, proposal }
          },
          { policy, userId }
        );
      }
      throw new Error([brokerMinimumBlockReason].join(" "));
    }

    if (ownerApprovedStoredFinalSize) {
      const storedFinalSizeReview = proposal.finalSizeReview as NonNullable<TradeProposal["finalSizeReview"]>;
      const consentedNotional = storedFinalSizeReview.ownerApprovalNotional ?? storedFinalSizeReview.toNotional;
      const consentDrift = assessFinalSizeConsentDrift(consentedNotional, review.estimatedNotional);
      if (consentDrift.materialIncrease) {
        const requotedAt = new Date().toISOString();
        const driftReason = `The broker's fresh estimate increased from $${consentedNotional.toFixed(2)} to $${review.estimatedNotional.toFixed(2)} (${(consentDrift.increasePct ?? 0).toFixed(2)}%) after your final-size approval. Approve the updated amount again before placement.`;
        proposal.finalSizeReview = {
          ...storedFinalSizeReview,
          ownerApprovalRequired: true,
          ownerApprovalNotional: review.estimatedNotional,
          ownerApprovalRequoteReason: driftReason,
          ownerApprovalRequotedAt: requotedAt
        };
        proposal.sizingSnapshot = captureProposalSizingSnapshot({
          proposal,
          estimatedNotional: review.estimatedNotional,
          policy,
          portfolioValue: account.portfolio.totalMarketValue,
          dailyNotionalUsed: daily.notional
        });
        const pendingDecision: PolicyDecision = {
          ...row.decision,
          approved: false,
          reasons: [...new Set([...(row.decision.reasons ?? []), driftReason])]
        };
        const persisted = updatePendingProposalReprice(
          proposalId,
          { proposal, review, estimatedNotional: review.estimatedNotional, decision: pendingDecision },
          userId
        );
        audit(
          "final_size_owner_consent_requoted",
          {
            proposalId,
            symbol: proposal.symbol,
            side: proposal.side,
            consentedNotional,
            freshNotional: review.estimatedNotional,
            increase: consentDrift.increase,
            increasePct: consentDrift.increasePct,
            tolerance: consentDrift.tolerance,
            persisted,
            action: "approval"
          },
          userId,
          policy.connectedAccountId
        );
        if (!persisted) {
          const current = getProposal(proposalId, userId)?.status ?? "removed";
          throw new Error([`Proposal was ${current} before the updated owner consent could be saved.`].join(" "));
        }
        await sendNotification(
          {
            type: "pending_approval",
            title: `${proposal.symbol} final size increased — approval needed again`,
            payload: { proposalId, proposal, review, decision: pendingDecision, reason: driftReason }
          },
          { policy, userId }
        );
        throw new Error([driftReason].join(" "));
      }

      const approvedAt = new Date().toISOString();
      proposal.finalSizeReview = {
        ...(proposal.finalSizeReview as NonNullable<TradeProposal["finalSizeReview"]>),
        ownerApprovalRequired: false,
        ownerOverrideAppliedAt: approvedAt
      };
      if (proposal.redTeamVerdict) {
        proposal.redTeamVerdict = { ...proposal.redTeamVerdict, humanOverrideApplied: true };
        // Scorecard lifecycle receipt — appended exactly where humanOverrideApplied is set.
        appendDecisionStep(proposal, "human_approved");
      }
      if (!updatePendingProposalReprice(proposalId, { proposal, review, estimatedNotional: review.estimatedNotional }, userId)) {
        const current = getProposal(proposalId, userId)?.status ?? "removed";
        throw new Error([`Proposal was ${current} before owner approval could be recorded.`].join(" "));
      }
      audit(
        "final_size_red_review_owner_override",
        {
          proposalId,
          symbol: proposal.symbol,
          side: proposal.side,
          reviewedAt: proposal.finalSizeReview.reviewedAt,
          approvedAt,
          reason: proposal.finalSizeReview.ownerApprovalReason,
          verdict: proposal.redTeamVerdict?.verdict,
          available: proposal.redTeamVerdict?.available
        },
        userId,
        policy.connectedAccountId
      );
    }

    const isLiveExecution = executionState.environment === "live";
    const decision = evaluateTradeProposal(proposal, {
      policy,
      portfolio: account.portfolio,
      positions: account.positions,
      dailyNotionalUsed: daily.notional,
      hourlyNotionalUsed: hourly.notional,
      dailyOrderCount: daily.openingOrderCount,
      estimatedNotional: review.estimatedNotional,
      marketScan: approvalScan,
      washSaleLocks: getUserWashSaleLockProvenance(userId, new Date()),
      // Escalated-card override handles from the STORED row (server-minted at escalation time).
      // Empty for ordinary proposals. Only the wash-sale gate consults these, and only while
      // taxSettings.washSaleHandling is ask/auto; every other gate re-runs at full strength.
      approvedEscalations: approvedEscalationsFromDecision(row.decision),
      // ConnectedAccount taxationType is the SOURCE OF TRUTH for the buyer's tax regime (wins
      // over policy taxSettings; capabilities can be absent/"brokerage" on legacy IRA rows) —
      // required so the IRA-replacement hard block (Rev. Rul. 2008-5) can never miss an IRA.
      accountTaxationType: activeAccount?.taxationType,
      accountCapabilities: activeAccount?.capabilities,
      isLiveExecution,
      // PDT gate (FINRA Rule 4210): only meaningful for LIVE execution — skip the count entirely otherwise.
      priorDayTradeCount: isLiveExecution
        ? countDayTradesInLastBusinessDays(policy.accountNumber, 5, new Date(), userId)
        : 0
    });

    if (decision.quoteStale) {
      const ageText = decision.quoteStale.ageSec !== undefined ? `${decision.quoteStale.ageSec}s old` : "missing/unparseable";
      audit(
        "quote_staleness_warn",
        {
          proposalId,
          symbol: proposal.symbol,
          side: proposal.side,
          ageSec: decision.quoteStale.ageSec,
          limitPrice: proposal.limitPrice,
          referencePrice: decision.quoteStale.referencePrice,
          originalType: decision.quoteStale.originalType,
          originalLimitPrice: decision.quoteStale.originalLimitPrice
        },
        userId,
        policy.connectedAccountId
      );
      if (currentMarketSession() === "regular") {
        await sendNotification(
          {
            type: "provider_degraded",
            title: `Stale Quote Warning: ${proposal.symbol} quote was ${ageText}`,
            payload: {
              proposalId,
              symbol: proposal.symbol,
              side: proposal.side,
              ageSec: decision.quoteStale.ageSec,
              limitPrice: proposal.limitPrice,
              referencePrice: decision.quoteStale.referencePrice
            }
          },
          { policy, userId }
        );
      }
    }

    // Auditable wash-sale trail on the approval path — never silent. For honored overrides the
    // token ties this execution back to the exact escalated card the owner approved; for IRA
    // disregards the record carries the verbatim note + priced provenance.
    //
    // Gated on decision.approved: a re-evaluation at approval time can return approved:false while
    // still carrying an ira_disregarded / auto_proceeded / approved_via_override outcome (the
    // wash-sale gate itself didn't block, but a later gate — daily cap, buying power, staleness —
    // did). Logging the proceed-trail then would tell Activity the wash sale was disregarded and the
    // deduction forfeited even though the order is blocked below and no purchase happens. When
    // approved, this function proceeds to place/fill the order, so the trail is accurate.
    if (
      decision.approved &&
      decision.washSale &&
      (decision.washSale.outcome === "approved_via_override" ||
        decision.washSale.outcome === "auto_proceeded" ||
        decision.washSale.outcome === "ira_disregarded")
    ) {
      audit(
        decision.washSale.outcome === "ira_disregarded" ? "wash_sale_ira_disregarded" : "wash_sale_override_applied",
        {
          proposalId,
          symbol: proposal.symbol,
          side: proposal.side,
          estimatedNotional: review.estimatedNotional,
          washSale: decision.washSale
        },
        userId,
        policy.connectedAccountId
      );
    }

    if (!decision.approved) {
      // Wash-sale re-escalation instead of death: when the ONLY thing standing between this
      // approval and execution is an ask-mode wash-sale failure (fresh lock discovered at
      // approval time, or a stale override refused because the priced cost moved past
      // washSaleOverrideCostTolerance — outcome "reescalated_cost_changed"), keep the card
      // PENDING with the freshly priced reason and newly minted server-side tokens so the owner
      // can approve again at the current cost. Every other refusal (still-binding caps, IRA
      // hard block, universe, ...) retires the card as blocked exactly as before.
      const washReescalation =
        (decision.escalations ?? []).some((entry) => entry.kind === "wash_sale_ask") &&
        shouldEscalateDecision(decision, policy);
      if (washReescalation) {
        const reescalated: PolicyDecision = {
          ...decision,
          escalations: (decision.escalations ?? []).map((entry) => ({ ...entry, token: crypto.randomUUID() }))
        };
        // Guarded re-queue: only while the row is STILL pending. The scan/review above is async,
        // so the scheduler can expire this proposal — or another tab can reject it — while this
        // approval was in flight; an unconditional 'proposed' write here would resurrect that
        // withdrawn card with fresh override tokens. If the row left the pending state, honor
        // that outcome instead of re-queuing.
        if (!transitionProposalIfPending(proposalId, "proposed", userId, { review, estimatedNotional: review.estimatedNotional, decision: reescalated })) {
          const current = getProposal(proposalId, userId);
          audit(
            "proposal_reescalation_skipped",
            {
              proposalId,
              symbol: proposal.symbol,
              side: proposal.side,
              reasons: decision.reasons,
              currentStatus: current?.status ?? "missing"
            },
            userId,
            policy.connectedAccountId
          );
          return {
            status: current?.status ?? "unknown",
            reasons: [
              `Proposal is no longer pending (now ${current?.status ?? "missing"}); the wash-sale re-escalation was not re-queued.`,
              ...decision.reasons
            ]
          };
        }
        audit(
          "proposal_reescalated",
          {
            proposalId,
            symbol: proposal.symbol,
            side: proposal.side,
            action: "approval",
            result: "reescalated",
            reasons: decision.reasons,
            escalations: reescalated.escalations,
            ...(decision.washSale ? { washSale: decision.washSale } : {})
          },
          userId,
          policy.connectedAccountId
        );
        await sendNotification(
          {
            type: "pending_approval",
            title:
              decision.washSale?.outcome === "reescalated_cost_changed"
                ? `${proposal.symbol} rebuy needs a fresh call (wash-sale cost changed)`
                : `${proposal.symbol} rebuy needs your call (wash sale)`,
            payload: { proposalId, proposal, review, decision: reescalated, escalated: true }
          },
          { policy, userId }
        );
        throw new Error(decision.reasons.join(" "));
      }

      // Same in-flight window as the re-escalation above: retire the card as blocked only if it
      // is still pending — never overwrite a rejection/expiry that landed during the async review.
      if (!transitionProposalIfPending(proposalId, "blocked", userId, { review, estimatedNotional: review.estimatedNotional, decision })) {
        const current = getProposal(proposalId, userId);
        audit(
          "proposal_block_skipped",
          {
            proposalId,
            symbol: proposal.symbol,
            side: proposal.side,
            reasons: decision.reasons,
            currentStatus: current?.status ?? "missing"
          },
          userId,
          policy.connectedAccountId
        );
        return {
          status: current?.status ?? "unknown",
          reasons: [
            `Proposal is no longer pending (now ${current?.status ?? "missing"}); the policy block was not applied.`,
            ...decision.reasons
          ]
        };
      }
      audit("proposal_approved", {
        proposalId,
        symbol: proposal.symbol,
        side: proposal.side,
        action: "approval",
        result: "blocked",
        reasons: decision.reasons
      }, userId, policy.connectedAccountId);
      await sendNotification(
        {
          type: "block",
          title: `${proposal.side.charAt(0).toUpperCase() + proposal.side.slice(1)} ${proposal.symbol} blocked`,
          payload: { proposalId, decision, review, proposal }
        },
        { policy, userId }
      );
      const blockedResult = { status: "blocked", reasons: decision.reasons };
      try {
        lockGuard.assertOwned();
      } catch (error) {
        // The row is already terminally blocked. Losing the lease while its ancillary notification
        // was in flight must not misreport that durable outcome as "busy"/still pending; simply skip
        // the unrelated authority-demotion write that would require current ownership.
        if (error instanceof StrategyLockOwnershipLostError) return blockedResult;
        throw error;
      }
      autoRevertOnCapBreach(decision.reasons, policy, userId, policy.connectedAccountId);
      return blockedResult;
    }

    // Re-assert the proposal is still pending immediately before we act on it. The awaits above
    // (scan, broker review) take time, during which deterministic expiry (scheduler tick) or a
    // concurrent run's LLM re-validation could have retired this proposal to expired/withdrawn —
    // we must not place an order for an idea the system already pulled from the queue.
    const stillPending = getProposal(proposalId, userId);
    if (!stillPending || stillPending.status !== "proposed") {
      const current = stillPending?.status ?? "removed";
      throw new Error([`Proposal was ${current} before it could be executed.`].join(" "));
    }

    const heldExit = evaluateBrokerHeldExitAvailability(proposal, account.positions, orders);
    if (heldExit) {
      const heldReason = brokerHeldExitBlockReason(heldExit);
      const heldDecision: PolicyDecision = { approved: false, reasons: [heldReason] };
      updateProposalStatus(proposalId, "blocked", undefined, review, review.estimatedNotional, userId, undefined, undefined, heldDecision);
      audit(
        "proposal_approved",
        { proposalId, symbol: proposal.symbol, side: proposal.side, action: "approval", result: "blocked", reasons: heldDecision.reasons, heldExit },
        userId,
        policy.connectedAccountId
      );
      await sendNotification(
        {
          type: "block",
          title: `${proposal.side.charAt(0).toUpperCase() + proposal.side.slice(1)} ${proposal.symbol} blocked`,
          payload: { proposalId, decision: heldDecision, review, proposal }
        },
        { policy, userId }
      );
      throw new Error(heldDecision.reasons.join(" "));
    }

    // Pre-flight live-order guard on the human-approval path too (parity with the autonomous run
    // loop). No-op on broker/paper; on broker/live it ALLOWS by default and refuses ONLY when live
    // trading has been explicitly disabled via the ALLOW_LIVE_TRADING=false escape hatch. It NEVER
    // places or enables a trade — a human-approved pending proposal clears the same live invariant.
    try {
      assertLivePreflight({
        mode: executionMode,
        symbol: proposal.symbol,
        side: proposal.side
      });
    } catch (guardError) {
      const message = guardError instanceof Error ? guardError.message : String(guardError);
      // Persist a REJECTED decision (not the earlier approved one) so the ledger reflects the block.
      const blockedDecision: PolicyDecision = { ...decision, approved: false, reasons: [...decision.reasons, message] };
      updateProposalStatus(proposalId, "blocked", undefined, review, review.estimatedNotional, userId, undefined, message, blockedDecision);
      audit("order_blocked_live_preflight", { proposalId, symbol: proposal.symbol, side: proposal.side, reason: message, path: "approval" }, userId, policy.connectedAccountId);
      await sendNotification(
        { type: "block", title: `${proposal.symbol} live order blocked (pre-flight)`, payload: { proposalId, proposal, review, reason: message, decision: blockedDecision } },
        { policy, userId }
      );
      throw new Error([message].join(" "));
    }

    // Re-prove ownership at the final safe boundary. A lost/failed lease leaves the proposal
    // pending instead of writing an intent or calling the broker.
    lockGuard.assertOwned();

    // Atomic, crash-recoverable placement (mirrors the autonomous path): persist the
    // idempotency-keyed intent (status "placing" + refId) BEFORE the broker call so a crash or
    // lost broker response can't leave an untracked real order.
    const refId = crypto.randomUUID();
    // Terminal scorecard lifecycle step: the human-approved decision is final — the placing claim
    // below persists the proposal JSON (chain included) before the broker call.
    appendDecisionStep(proposal, "final");
    // Atomic compare-and-swap BEFORE the broker call: only the caller that flips this proposal
    // proposed -> placing proceeds to placeEquityOrder, so concurrent approvals (double-click, two
    // tabs, from-draft) can't both place a real order (defense in depth with the run-lock above).
    // `proposal` persists execution-time sizing (broker-minimum bump / approval-time reprice) into
    // the row before placement, so crash-recovery books any fill at the size actually sent and
    // Recent/Activity show the executed order rather than the stale original ask.
    const decisionCaseNow = new Date().toISOString();
    const fallbackDecisionCase = {
      ...buildSocraticDecisionCase({
        userId,
        connectedAccountId: policy.connectedAccountId,
        runId: row.runId,
        proposalId,
        accountNumber: row.accountNumber,
        proposal,
        status: "proposed",
        authority: policy.strategyAuthority,
        decision,
        review,
        marketScan: approvalScan,
        ragAttributions: []
      }),
      createdAt: decisionCaseNow,
      updatedAt: decisionCaseNow
    };
    // The lease is acquired BEFORE the claimProposalForExecution CAS deliberately: a busy exit
    // leaves the proposal in "proposed" with no claim to revert (see account-mutation.ts's lock
    // hierarchy -- row CAS claims are non-blocking and taken INSIDE the lease window on purpose).
    // This acquisition itself sits inside the strategy lock held above, per that same hierarchy
    // (strategy lock -> broker-mutation lease -> row CAS claims -> broker network calls).
    const mutationOutcome = await withAccountMutation(
      {
        userId,
        accountNumber: policy.accountNumber,
        connectedAccountId: policy.connectedAccountId,
        lane: "approval-placement",
        waitMs: options.leaseWaitMs ?? LANE_WAITS.approvalPlacement
      },
      async (mutationCtx) => {
        let claimed = false;
        try {
          claimed = claimProposalForExecution(proposalId, "placing", userId, {
            review,
            estimatedNotional: review.estimatedNotional,
            refId,
            executionMode,
            proposal,
            decision,
            createSocraticDecisionCase: () => {
              upsertSocraticDecisionCase(fallbackDecisionCase);
            }
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          audit("proposal_claim_receipt_failed", { proposalId, symbol: proposal.symbol, side: proposal.side, error: message }, userId, policy.connectedAccountId);
          throw new Error([`Decision receipt could not be persisted; no order was submitted: ${message}`].join(" "));
        }
        if (!claimed) {
          const current = getProposal(proposalId, userId)?.status ?? "removed";
          throw new Error([`Proposal was ${current} before it could be executed.`].join(" "));
        }

        // Stop/close-only/liquidating is authoritative even for an approval that was already in
        // flight. Re-read durable state after the placing claim and immediately before the broker call;
        // the claim itself must never become a bypass around the final placement fence.
        const protectiveStateBlock = freshPlacementBlockReason({
          userId,
          connectedAccountId: policy.connectedAccountId,
          side: proposal.side,
          source: "owner_approval"
        });
        if (protectiveStateBlock) {
          const blockedDecision: PolicyDecision = {
            ...decision,
            approved: false,
            reasons: [...decision.reasons, protectiveStateBlock]
          };
          updateProposalStatus(
            proposalId,
            "blocked",
            undefined,
            review,
            review.estimatedNotional,
            userId,
            undefined,
            protectiveStateBlock,
            blockedDecision
          );
          audit(
            "order_blocked_protective_state",
            { proposalId, symbol: proposal.symbol, side: proposal.side, reason: protectiveStateBlock, path: "approval" },
            userId,
            policy.connectedAccountId
          );
          await sendNotification(
            {
              type: "block",
              title: `${proposal.symbol} order blocked by protective state`,
              payload: { proposalId, proposal, reason: protectiveStateBlock, decision: blockedDecision }
            },
            { policy, userId }
          );
          throw new Error([protectiveStateBlock].join(" "));
        }

        let execution: Awaited<ReturnType<typeof gateway.placeEquityOrder>>;
        try {
          // Mutation-lease fence: fail closed if the window lost its lease before the risk-creating call.
          mutationCtx.assertOwned();
          execution = await gateway.placeEquityOrder({ accountNumber, ...proposal, refId });
        } catch (placeError) {
          const message = placeError instanceof Error ? placeError.message : String(placeError);
          const sym = proposal.symbol;
          if (isOrderPlacementInfrastructureFailure(message) && policy.connectedAccountId) {
            audit(
              "order_place_infrastructure_failed",
              { proposalId, refId, symbol: sym, side: proposal.side, error: message.slice(0, 400), path: "approval" },
              userId,
              policy.connectedAccountId
            );
          }
          // OrderValidationError is a DETERMINISTIC pre-submission refusal (adapter or the
          // broker-order-constraints tables) — the broker was never contacted, so asking it what
          // happened is pointless and, worse, concludes not_placed ("safe to retry") for an order
          // that will be refused identically every retry. Mirror the autonomous lane's short-circuit
          // (strategy.ts) and the protective-state block above: honest terminal "blocked".
          // P2.6 / #1319: pre-flight validation and definitive broker HTTP 4xx are never
          // "uncertain". OrderValidationError → blocked; terminal 4xx → rejected_by_broker;
          // HTTP 429/408 → not_placed (retryable). HTTP 409 (duplicate client_order_id) is
          // not a rejection — fall through to reconcilePlacementError. Reserve uncertain
          // for timeouts / 5xx.
          if (placeError instanceof OrderValidationError) {
            const blockedDecision: PolicyDecision = {
              ...decision,
              approved: false,
              reasons: [...decision.reasons, message]
            };
            updateProposalStatus(proposalId, "blocked", undefined, review, review.estimatedNotional, userId, undefined, message, blockedDecision);
            audit(
              "order_blocked_validation",
              { proposalId, refId, symbol: sym, side: proposal.side, reason: message, path: "approval" },
              userId,
              policy.connectedAccountId
            );
            await sendNotification(
              {
                type: "block",
                title: `${sym} order blocked before submission`,
                payload: { proposalId, refId, proposal, reason: message, decision: blockedDecision }
              },
              { policy, userId }
            );
            throw new Error([message].join(" "));
          }
          if (isRetryableBrokerHttpError(message)) {
            const note = `Broker rate-limited or timed out (${message}). Safe to retry.`;
            updateProposalStatus(proposalId, "not_placed", undefined, review, review.estimatedNotional, userId, undefined, note);
            audit(
              "order_not_placed_retryable_http",
              { proposalId, refId, symbol: sym, side: proposal.side, error: message.slice(0, 400), path: "approval" },
              userId,
              policy.connectedAccountId
            );
            await sendNotification(
              {
                type: "run_failed",
                title: `${sym} order not placed — safe to retry`,
                payload: { proposalId, refId, error: message, reconcile: "not_placed" }
              },
              { policy, userId }
            );
            throw new Error([note].join(" "));
          }
          if (isTerminalBrokerHttpError(message)) {
            updateProposalStatus(proposalId, "rejected_by_broker", undefined, review, review.estimatedNotional, userId, undefined, message);
            audit(
              "order_rejected_by_broker",
              { proposalId, refId, symbol: sym, side: proposal.side, reason: message, path: "approval", via: "http_4xx" },
              userId,
              policy.connectedAccountId
            );
            await sendNotification(
              {
                type: "run_failed",
                title: `${sym} order rejected by broker`,
                payload: { proposalId, refId, reason: message, reconcile: "rejected_by_broker" }
              },
              { policy, userId }
            );
            throw new Error([message].join(" "));
          }
          // A lost mutation lease (mutationCtx.assertOwned() above) is ALSO a deterministic
          // pre-submission refusal — the order provably never reached the broker — so it gets the
          // same short-circuit as OrderValidationError instead of falling into reconcilePlacementError.
          // Asking the broker "did this refId land?" would be a pointless round trip (it never left
          // this process), and on a gateway whose order list isn't authoritative for recent terminal
          // orders (e.g. Robinhood, ordersListIncludesTerminal unset) that round trip resolves
          // "uncertain": the row gets stuck in 'placing' and audits order_placement_uncertain, which
          // the account-mutation.ts doctrine forbids for a non-broker-fault condition (it must never
          // feed the broker-health run suppressor). Land it as retryable not_placed instead.
          if (placeError instanceof OperationLeaseOwnershipError) {
            const note = "Account mutation lease lost before submission — the order was never sent to the broker. Safe to retry.";
            updateProposalStatus(proposalId, "not_placed", undefined, review, review.estimatedNotional, userId, undefined, note);
            audit("order_not_placed_lease_lost", { proposalId, refId, symbol: sym, side: proposal.side, error: message, path: "approval" }, userId, policy.connectedAccountId);
            await sendNotification(
              { type: "run_failed", title: `${sym} order not placed — mutation lease lost (safe to retry)`, payload: { proposalId, refId, error: message } },
              { policy, userId }
            );
            throw new Error([note].join(" "));
          }
          // Ask the broker what actually happened (via the refId idempotency key) rather than firing a
          // perpetual "verify with broker" alert. Mirrors the autonomous run-loop catch above.
          const outcome = await reconcilePlacementError({
            gateway,
            accountNumber: row.accountNumber,
            userId,
            connectedAccountId: policy.connectedAccountId,
            proposalId,
            refId,
            proposal,
            review,
            marketScan: approvalScan,
            executionMode,
            placeErrorMessage: message,
            runId: row.runId
          });
          if (outcome.kind === "placed") {
            const fillStatus = outcome.fillStatus;
            updateProposalStatus(
              proposalId,
              fillStatus === "filled" ? "filled" : "placed",
              outcome.orderId,
              review,
              fillStatus === "filled" ? outcome.fill?.notional ?? review.estimatedNotional : review.estimatedNotional,
              userId
            );
            auditWashSaleProceed(decision, { proposalId, symbol: sym, side: proposal.side, estimatedNotional: review.estimatedNotional, userId, connectedAccountId: policy.connectedAccountId });
            audit("order_placement_recovered_inline", { proposalId, refId, orderId: outcome.orderId, state: outcome.state, alreadyBooked: outcome.alreadyBooked, symbol: sym, side: proposal.side, path: "approval" }, userId, policy.connectedAccountId);
            resolveBrokerVerificationNotifications(userId, { proposalId, refId, resolution: "recovered" });
            await sendNotification(
              { type: "fill", title: `${sym} order ${outcome.state} (recovered after placement error)`, payload: { proposalId, refId, fill: outcome.fill, reconcile: "recovered" } },
              { policy, userId }
            );
            emitDashboardEvent({ type: "order", userId, at: new Date().toISOString(), detail: { proposalId, orderId: outcome.orderId, symbol: sym } });
            return { status: fillStatus === "filled" ? "filled" : "placed", orderId: outcome.orderId, brokerState: outcome.state, fillStatus };
          }
          if (outcome.kind === "declined") {
            const declinedMsg = `Broker declined the order (state: ${outcome.state}).`;
            updateProposalStatus(proposalId, "rejected_by_broker", outcome.orderId, review, review.estimatedNotional, userId, undefined, declinedMsg);
            audit("order_rejected_by_broker", { proposalId, refId, symbol: sym, side: proposal.side, orderId: outcome.orderId, brokerState: outcome.state, via: "inline_reconcile" }, userId, policy.connectedAccountId);
            await sendNotification(
              { type: "run_failed", title: `${sym} order declined by broker (${outcome.state})`, payload: { proposalId, refId, orderId: outcome.orderId, state: outcome.state, reconcile: "declined" } },
              { policy, userId }
            );
            throw new Error([declinedMsg].join(" "));
          }
          if (outcome.kind === "not_placed") {
            const note = "Broker reachable; no order carries our idempotency key — the order never reached the broker. Safe to retry.";
            updateProposalStatus(proposalId, "not_placed", undefined, review, review.estimatedNotional, userId, undefined, note);
            audit("order_confirmed_not_placed", { proposalId, refId, symbol: sym, side: proposal.side, error: message, path: "approval" }, userId, policy.connectedAccountId);
            await sendNotification(
              { type: "run_failed", title: `${sym} order was NOT placed — safe to retry`, payload: { proposalId, refId, error: message, reconcile: "not_placed" } },
              { policy, userId }
            );
            throw new Error([`Order not placed (safe to retry): ${message}`].join(" "));
          }
          // uncertain: broker unreachable — KEEP status 'placing' so flagStalePlacingIntents retries.
          updateProposalStatus(proposalId, "placing", undefined, review, review.estimatedNotional, userId, undefined, outcome.error);
          audit("order_placement_uncertain", { proposalId, refId, symbol: sym, side: proposal.side, estimatedNotional: review.estimatedNotional, error: outcome.error, brokerUnreachable: true }, userId, policy.connectedAccountId);
          await sendNotification(
            { type: "run_failed", title: `${sym} order placement uncertain — verify with broker`, payload: { proposalId, refId, error: outcome.error, reconcile: "uncertain" } },
            { policy, userId }
          );
          throw new Error([`Order placement failed/uncertain: ${outcome.error}`].join(" "));
        }

        // See the matching comment in the autonomous run-loop placement path above: a non-throwing
        // broker response can still be a synchronous rejection/cancellation, and that must not be
        // recorded as "placed".
        if (isRejectedOrCanceledState(execution.state) && !hasBrokerReportedFill(execution)) {
          const message = `Broker declined the order (state: ${execution.state}).`;
          updateProposalStatus(proposalId, "rejected_by_broker", execution.orderId, review, review.estimatedNotional, userId, undefined, message);
          audit("order_rejected_by_broker", { proposalId, refId, symbol: proposal.symbol, side: proposal.side, orderId: execution.orderId, brokerState: execution.state }, userId, policy.connectedAccountId);
          await sendNotification(
            { type: "run_failed", title: `${proposal.symbol} order declined by broker (${execution.state})`, payload: { proposalId, refId, orderId: execution.orderId, state: execution.state } },
            { policy, userId }
          );
          throw new Error([message].join(" "));
        }

        const fillStatus = reconciledFillStatus(execution);
        const proposalStatus = fillStatus === "filled" ? "filled" : "placed";
        if (!execution.orderId && fillStatus !== "filled") {
          const message = `Broker returned ${execution.state} without an order id; keeping the idempotent intent pending until refId reconciliation confirms the order.`;
          updateProposalStatus(proposalId, "placing", undefined, review, review.estimatedNotional, userId, undefined, message);
          audit("order_placement_uncertain", { proposalId, refId, symbol: proposal.symbol, side: proposal.side, brokerState: execution.state, missingOrderId: true }, userId, policy.connectedAccountId);
          await sendNotification(
            { type: "run_failed", title: `${proposal.symbol} order accepted without broker id — recovery pending`, payload: { proposalId, refId, state: execution.state, reconcile: "uncertain" } },
            { policy, userId }
          );
          throw new Error([message].join(" "));
        }
        const executedNotional = brokerExecutedNotional(execution);
        const preFillPosition = positions.find((p) => normalizeSymbol(p.symbol) === normalizeSymbol(proposal.symbol));
        let fill!: FillEvent;
        // The broker call has already succeeded. Commit its receipt FIRST and the proposal/case status
        // in the same transaction; if receipt persistence fails, the transaction leaves `placing` so
        // the refId-based stale sweep can recover the real broker order instead of stranding it.
        try {
          getDb().transaction(() => {
            fill = recordFillFromProposal({
              userId,
              connectedAccountId: policy.connectedAccountId,
              accountNumber: row.accountNumber,
              proposalId,
              runId: row.runId,
              source: executionSource,
              executionMode,
              proposal,
              review,
              execution,
              marketScan: approvalScan,
              status: fillStatus,
              existingPosition: preFillPosition ? { averageCost: preFillPosition.averageCost, quantity: preFillPosition.quantity } : undefined
            });
            updateProposalStatus(
              proposalId,
              proposalStatus,
              execution.orderId,
              review,
              fillStatus === "filled" ? executedNotional ?? fill.notional : review.estimatedNotional,
              userId
            );
          }).immediate();
        } catch (receiptError) {
          const detail = receiptError instanceof Error ? receiptError.message : String(receiptError);
          const message = `Broker confirmed order ${execution.orderId}, but its local fill receipt could not be committed: ${detail}`;
          updateProposalStatus(proposalId, "placing", execution.orderId, review, review.estimatedNotional, userId, undefined, message);
          audit("order_placement_uncertain", { proposalId, refId, orderId: execution.orderId, symbol: proposal.symbol, side: proposal.side, brokerState: execution.state, receiptPersistenceFailed: true, error: detail }, userId, policy.connectedAccountId);
          await sendNotification(
            { type: "run_failed", title: `${proposal.symbol} broker order confirmed — local receipt recovery pending`, payload: { proposalId, refId, orderId: execution.orderId, state: execution.state, error: detail, reconcile: "uncertain" } },
            { policy, userId }
          );
          throw new Error([message].join(" "));
        }
        audit("proposal_approved", {
          proposalId,
          symbol: proposal.symbol,
          side: proposal.side,
          action: "approval",
          result: proposalStatus,
          orderId: execution.orderId,
          brokerState: execution.state,
          fillStatus
        }, userId, policy.connectedAccountId);
        await sendNotification(
          {
            type: "fill",
            title: isRejectedOrCanceledState(execution.state) && hasBrokerReportedFill(execution)
              ? `${proposal.symbol} partially filled, then ${execution.state}`
              : `${proposal.side.charAt(0).toUpperCase() + proposal.side.slice(1)} ${proposal.symbol} ${execution.state}`,
            payload: { proposalId, fill }
          },
          { policy, userId }
        );
        // Push so other open dashboards refresh immediately (the approving client refreshes via its
        // own response).
        emitDashboardEvent({ type: "order", userId, at: new Date().toISOString(), detail: { proposalId, orderId: execution.orderId, symbol: proposal.symbol } });
        return { status: proposalStatus, orderId: execution.orderId, brokerState: execution.state, fillStatus };
      }
    );
    if (!mutationOutcome.acquired) {
      return {
        status: "busy",
        reasons: [
          `Another broker operation (${mutationOutcome.busy.activeOperation}) is in progress for this account. Retry in ~${mutationOutcome.busy.retryAfterSeconds}s.`
        ]
      };
    }
    return mutationOutcome.value;
  } catch (error) {
    if (error instanceof StrategyLockOwnershipLostError) {
      return { status: "busy", reasons: [error.message] };
    }
    throw error;
  } finally {
    lockGuard.stop();
    releaseStrategyLock(lockOwner, userId, policy.connectedAccountId);
  }
}
export async function reconcilePendingFills(gateway: BrokerGateway, accountNumber: string, userId: string = "local", connectedAccountId?: string): Promise<void> {
  // Forward guard: fills with empty/literal-"undefined" broker_order_id can never match a broker
  // order (historical String(undefined) bug; insertion path fixed in PR #284). Flip to terminal
  // unreconcilable so they leave the pending list and stop forcing reconcile work every run.
  const quarantined = markUnreconcilableUnusableBrokerOrderFills(accountNumber, userId);
  for (const fill of quarantined) {
    audit(
      "fill_unreconcilable",
      {
        fillId: fill.id,
        symbol: fill.symbol,
        brokerOrderId: fill.brokerOrderId ?? null,
        reason: "broker_order_id_unusable"
      },
      userId,
      connectedAccountId
    );
  }

  const pending = listPendingBrokerReconciliationFills(accountNumber, userId);
  if (pending.length === 0) return;

  try {
    const brokerOrders = await gateway.getEquityOrders(accountNumber);
    // Lazily fetched (only if a pending fill actually carries an opening stopPlan) and cached across
    // the loop — these orders already EXECUTED at the broker, so the live position's averageCost is
    // the real POST-fill blended basis (no manual weighting needed, unlike the placement-time callers
    // in performance.ts that only have the PRE-fill snapshot). Recording the raw single-fill `price`
    // instead would make `filterStopPlansByLiveBasis` discard a scale-in's plan as stale on the very
    // next run (Codex review, PR #1371).
    let livePositions: EquityPosition[] | null | undefined;
    const positionsSnapshot = async (): Promise<EquityPosition[] | null> => {
      if (livePositions === undefined) {
        try {
          livePositions = await gateway.getEquityPositions(accountNumber);
        } catch {
          livePositions = null;
        }
      }
      return livePositions;
    };
    const liveBasisFor = async (symbol: string): Promise<number | undefined> => {
      const positions = await positionsSnapshot();
      return positions?.find((p) => normalizeSymbol(p.symbol) === normalizeSymbol(symbol))?.averageCost;
    };
    const escalationCandidates = new Map<string, PendingFillEscalationCandidate>();
    for (const fill of pending) {
      const matched = brokerOrders.find((bo) => bo.id === fill.brokerOrderId);
      if (!matched) {
        // Absent from the order listing. fill_events is NOT a complete ledger of the broker
        // account — the owner trades manually and via the Robinhood MCP outside the app, and
        // pre-app holdings exist — so no amount of position arithmetic can prove THIS order
        // executed: an identical position delta is produced by an external trade plus this order
        // canceling/expiring, and flipping on it would fabricate a fill (wrong P&L, phantom
        // opening-stop plans). No gateway exposes a direct per-order lookup that could supply
        // broker truth for a single order id either (BrokerGateway has no getOrder-style method).
        // So an absent order NEVER auto-flips: the receipt stays pending and, past the age
        // threshold, escalates to the owner with the observed position evidence attached
        // (collectAbsentOrderPositionEvidence) so one look at the broker resolves it.
        escalationCandidates.set(fill.id, {
          reason: "order_absent_from_listing",
          listingIncludesTerminal: gateway.ordersListIncludesTerminal === true
        });
        continue;
      }

      // The stop plan couldn't be committed at placement time — this order was still
      // pending_reconciliation then, and a canceled/expired-with-nothing-executed order must never
      // leave a plan row governing a lot that never opened (Codex review, PR #1371). Any executed
      // quantity (full or partial fill) DID open the lot, so commit the plan now from the original
      // proposal stamped into this fill's own raw payload.
      const commitStopPlanIfOpening = async (price: number) => {
        const openingProposal = (fill.raw as { proposal?: TradeProposal } | undefined)?.proposal;
        if (
          openingProposal?.stopPlan &&
          (openingProposal.side === "buy" || openingProposal.side === "short")
        ) {
          try {
            // An explicit "default" CLEARS any existing override (the only way a scale-in can ever
            // reset a position back to the account's own precedence) — mirrors
            // recordFillFromProposal's same-named gate in performance.ts (Codex review, PR #1371).
            if (openingProposal.stopPlan.style === "default") {
              clearStopPlans(accountNumber, [fill.symbol], userId);
            } else {
              const basis = (await liveBasisFor(fill.symbol)) ?? price;
              // See performance.ts's identical reasoning: bracket fields survive on the proposal
              // only when a broker-native bracket was (or was meant to be) attached, so this
              // naturally scopes to fixed/atr plans.
              const openingOrderId =
                (openingProposal.bracketStopLoss != null || openingProposal.bracketTakeProfit != null)
                  ? matched.id
                  : undefined;
              const contract = deriveExitContractFromOpening({
                side: openingProposal.side === "short" ? "short" : "buy",
                avgCost: basis,
                bracketStopLoss: openingProposal.bracketStopLoss,
                bracketTakeProfit: openingProposal.bracketTakeProfit,
                invalidation: openingProposal.autonomyOverride?.invalidation
              });
              recordStopPlan(
                accountNumber,
                fill.symbol,
                openingProposal.stopPlan.style,
                openingProposal.stopPlan.rationale,
                basis,
                userId,
                undefined,
                openingProposal.side === "short" ? "short" : "long",
                openingOrderId,
                contract
              );
            }
          } catch {
            // plan bookkeeping must never break fill reconciliation
          }
        }
      };
      const merged = mergedExecutionTruth(matched, fill);
      const receiptStatus = reconciledFillStatus(matched, fill);
      const raw = reconciliationRaw(fill, matched, merged.knownQuantity);

      if (merged.truth && (receiptStatus === "filled" || receiptStatus === "partially_filled")) {
        const truth = merged.truth;
        const writeReceipt = () => updateFillEvent(fill.id, {
          status: receiptStatus,
          price: truth.price,
          quantity: truth.quantity,
          notional: truth.notional,
          filledAt: matched.updatedAt ?? fill.filledAt,
          raw
        }, userId);
        if (receiptStatus === "filled" && fill.proposalId) {
          getDb().transaction(() => {
            writeReceipt();
            updateProposalStatus(fill.proposalId!, "filled", matched.id, undefined, truth.notional, userId);
          }).immediate();
        } else {
          writeReceipt();
        }
        const auditStatus = receiptStatus === "filled" && isRejectedOrCanceledState(matched.state)
          ? `${matched.state}_partial`
          : receiptStatus;
        audit("fill_reconciled", { fillId: fill.id, symbol: fill.symbol, status: auditStatus, price: truth.price, quantity: truth.quantity }, userId, connectedAccountId);
        await commitStopPlanIfOpening(truth.price);
        if (receiptStatus === "filled" && fill.proposalId) {
          resolveBrokerVerificationNotifications(userId, { proposalId: fill.proposalId, resolution: "placed" });
        }
        // Live sell/cover fills insert as pending_reconciliation, so the episodic-memory hook in
        // recordFillFromProposal saw a non-accounting fill and wrote nothing (calculatePnl matched
        // no closed lot). Re-fire it now that the receipt flipped to accounting truth — this is the
        // ONLY point live closed lots ever become experience memory. Idempotent: once "filled" the
        // row leaves listPendingBrokerReconciliationFills, and even a crash-retry no-ops — the
        // experience doc's vector id is stable (contextId = source:symbol:accession:timestamp with
        // accession `exp:<entryProposalId>:<exitProposalId>`, experience-memory.ts) and
        // storeContexts' content-hash dedup skips byte-identical re-writes (vector-db.ts).
        if (receiptStatus === "filled" && fill.status !== "filled" && (fill.side === "sell" || fill.side === "cover")) {
          const closingProposal = (fill.raw as { proposal?: TradeProposal } | undefined)?.proposal;
          if (closingProposal) {
            const closingFill: FillEvent = {
              ...fill,
              status: receiptStatus,
              price: truth.price,
              quantity: truth.quantity,
              notional: truth.notional,
              filledAt: matched.updatedAt ?? fill.filledAt
            };
            void import("./experience-memory")
              .then((experienceMemory) =>
                experienceMemory.recordClosedLotExperience({
                  userId,
                  connectedAccountId,
                  accountNumber,
                  source: fill.source,
                  closingFill,
                  closingProposal
                })
              )
              .catch((err) => {
                console.warn("[reconciliation] experience-memory re-fire failed:", err instanceof Error ? err.message : String(err));
              });
          }
        }
      } else if (isRejectedOrCanceledState(matched.state) && merged.knownQuantity <= 0) {
        const declinedMessage = `Broker terminated the order without a fill (state: ${matched.state}).`;
        getDb().transaction(() => {
          updateFillEvent(fill.id, { status: matched.state, raw }, userId);
          if (fill.proposalId) {
            updateProposalStatus(fill.proposalId, "rejected_by_broker", matched.id, undefined, undefined, userId, undefined, declinedMessage);
          }
        }).immediate();
        audit("fill_reconciled", { fillId: fill.id, symbol: fill.symbol, status: matched.state }, userId, connectedAccountId);
        if (fill.proposalId) resolveBrokerVerificationNotifications(userId, { proposalId: fill.proposalId, resolution: "recovered" });
      } else {
        // The broker reports execution growth but not a usable realized price (or reports a final
        // state with an unpriced cumulative quantity larger than the already-booked partial). Keep
        // the prior accounting truth and leave this receipt eligible for another reconciliation.
        updateFillEvent(fill.id, { raw }, userId);
        // Steady-state per-tick spam guard (~4.5k identical rows/day in prod):
        // first occurrence per (fillId, brokerState) logs immediately, then ≤1/6h.
        auditDeduped("fill_reconciliation_pending_price", {
          fillId: fill.id,
          symbol: fill.symbol,
          brokerState: matched.state,
          brokerQuantity: matched.filledQuantity,
          knownBrokerQuantity: merged.knownQuantity,
          priorBookedQuantity: bookedExecutionTruth(fill)?.quantity,
          unresolvedGrowth: merged.unresolvedGrowth
        }, [fill.id, matched.state], { userId, connectedAccountId });
        // A matched order still LIVE at the broker (working day limit, queued stop, ...) is
        // healthy — it simply hasn't executed yet, and stale-limit-orders.ts owns the alerting
        // for a far-from-market resting order. Only a matched order in a TERMINAL state that
        // still lacks usable execution price/quantity data is genuinely unresolvable here.
        if (!isLiveOrderState(matched.state)) {
          escalationCandidates.set(fill.id, {
            reason: "terminal_state_unusable_execution_data",
            brokerState: matched.state,
            knownBrokerQuantity: merged.knownQuantity
          });
        }
      }
    }
    // Escalation is gated on THIS pass's classification: only fills proven unresolvable right now
    // (order absent from the listing, or matched-terminal with unusable execution data) escalate.
    // When the listing call itself failed we cannot classify, so nothing escalates this pass — a
    // healthy working order must never be flagged just because the broker API hiccuped.
    await escalateAgedPendingFills({ accountNumber, userId, connectedAccountId, candidates: escalationCandidates, positionsSnapshot });
  } catch (error) {
    console.error("[reconciliation] failed to reconcile pending fills:", error);
  }
}

/** Default age (minutes) after which a still-pending fill escalates to an audit event + one
 *  notification. Override with PENDING_FILL_ESCALATION_MINUTES. */
export const DEFAULT_PENDING_FILL_ESCALATION_MINUTES = 30;

function pendingFillEscalationMinutes(): number {
  const parsed = Number(process.env.PENDING_FILL_ESCALATION_MINUTES);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_PENDING_FILL_ESCALATION_MINUTES;
}

/** Why a pending fill is escalation-eligible THIS reconcile pass. Only genuinely-unresolvable
 *  receipts qualify: the broker order is absent from the listing, or it matched but sits in a
 *  terminal state with no usable execution price/quantity. A matched order that is still
 *  live/working never becomes a candidate — that is a healthy resting order (normal for a day
 *  limit), and stale-limit-orders.ts owns that alerting surface. */
type PendingFillEscalationCandidate =
  | { reason: "order_absent_from_listing"; listingIncludesTerminal: boolean }
  | { reason: "terminal_state_unusable_execution_data"; brokerState: string; knownBrokerQuantity: number };

/** Position evidence attached to an absent-order escalation so the owner can resolve it with one
 *  look at the broker. DIAGNOSTIC ONLY — never used to flip the receipt: fill_events is not a
 *  complete ledger of the broker account (the owner trades manually and via the Robinhood MCP
 *  outside the app, and pre-app holdings exist), so a position delta that "matches" this order
 *  executing is equally consistent with an external trade plus this order dying unexecuted.
 *  Flipping on it would fabricate a fill — wrong P&L and possibly a phantom opening-stop plan. */
type AbsentOrderPositionEvidence = {
  /** Live broker position quantity for the symbol; null when the positions listing was unavailable. */
  brokerPositionQuantity: number | null;
  /** Signed net quantity implied by locally-booked accounting fills (netAccountingFillQuantity). */
  bookedNetQuantity: number;
  intendedQuantity?: number;
  /** True when broker position == booked net + this order's signed quantity — CONSISTENT with
   *  execution, but not proof (external trades produce the same delta). Undefined when it cannot
   *  be evaluated (positions unavailable, unknown intended quantity, or a partially_filled
   *  receipt whose booked portion muddies the delta). */
  deltaConsistentWithExecution?: boolean;
  /** True when broker position == booked net — consistent with the order never executing. */
  positionUnchanged?: boolean;
  /** The placement response's averagePrice, if it was captured at placement time. */
  placementAveragePrice?: number;
  /** Human-readable one-look summary of the above. */
  summary: string;
};

async function collectAbsentOrderPositionEvidence(p: {
  accountNumber: string;
  userId: string;
  fill: FillEvent;
  positionsSnapshot: () => Promise<EquityPosition[] | null>;
}): Promise<AbsentOrderPositionEvidence> {
  const { fill } = p;
  const symbol = normalizeSymbol(fill.symbol);
  const raw = (fill.raw ?? {}) as { proposal?: TradeProposal; execution?: { averagePrice?: unknown } };
  const bookedNetQuantity = netAccountingFillQuantity(p.accountNumber, fill.source, symbol, p.userId);
  const intendedQuantity = positiveFinite(fill.quantity) ?? positiveFinite(raw.proposal?.quantity);
  const placementAveragePrice = positiveFinite(raw.execution?.averagePrice);
  const positions = await p.positionsSnapshot();
  const brokerPositionQuantity = positions
    ? (positions.find((pos) => normalizeSymbol(pos.symbol) === symbol)?.quantity ?? 0)
    : null;
  const QTY_EPS = 1e-4;
  let deltaConsistentWithExecution: boolean | undefined;
  let positionUnchanged: boolean | undefined;
  if (brokerPositionQuantity !== null) {
    positionUnchanged = Math.abs(brokerPositionQuantity - bookedNetQuantity) <= QTY_EPS;
    if (fill.status === "pending_reconciliation" && intendedQuantity !== undefined) {
      const sign = fill.side === "buy" || fill.side === "cover" ? 1 : -1;
      deltaConsistentWithExecution =
        Math.abs(brokerPositionQuantity - (bookedNetQuantity + sign * intendedQuantity)) <= QTY_EPS;
    }
  }
  const parts: string[] = [];
  if (brokerPositionQuantity === null) {
    parts.push("Live positions listing was unavailable — no position evidence this pass.");
  } else {
    parts.push(`Broker position ${brokerPositionQuantity} sh vs ${bookedNetQuantity} sh booked in the app.`);
    if (deltaConsistentWithExecution) {
      parts.push(
        `The delta matches this ${fill.side} ${intendedQuantity} executing, but a manual/external trade produces the same delta — this is NOT proof of execution.`
      );
    } else if (positionUnchanged) {
      parts.push("Position unchanged — consistent with no execution (canceled/expired, or working outside the listing's view).");
    } else {
      parts.push("The delta matches neither full execution nor no execution.");
    }
  }
  parts.push(
    placementAveragePrice !== undefined
      ? `Placement captured an average price of ${placementAveragePrice}.`
      : "No broker price was captured at placement."
  );
  return {
    brokerPositionQuantity,
    bookedNetQuantity,
    intendedQuantity,
    deltaConsistentWithExecution,
    positionUnchanged,
    placementAveragePrice,
    summary: parts.join(" ")
  };
}

/**
 * Age-based escalation for fills stuck pending_reconciliation/partially_filled — ADVISORY only:
 * it informs, and never blocks, cancels, or mutates accounting state. Escalates ONLY fills this
 * reconcile pass proved genuinely unresolvable (see PendingFillEscalationCandidate): the broker
 * order was absent from the listing, or matched in a terminal state with no usable execution
 * data. A fill whose matched order is still open/working NEVER escalates — that is a healthy
 * resting order (normal for a day limit) already covered by stale-limit-order alerting. Past the
 * threshold (PENDING_FILL_ESCALATION_MINUTES, default 30) each fill emits one audit event and ONE
 * notification — once per fill across all reconcile passes AND process restarts, via a marker
 * persisted in the fill's raw column (reconciliationRaw spreads fill.raw, so the marker survives
 * later reconcile rewrites). Absent-order escalations attach the observed position evidence
 * (diagnostic only — see AbsentOrderPositionEvidence) so the owner can resolve with one look.
 * The alert carries reconcile: "uncertain" so the auto-ack sweep leaves it standing until the
 * fill actually reconciles, at which point resolveBrokerVerificationNotifications clears it by
 * proposalId.
 */
async function escalateAgedPendingFills(p: {
  accountNumber: string;
  userId: string;
  connectedAccountId?: string;
  candidates: Map<string, PendingFillEscalationCandidate>;
  positionsSnapshot: () => Promise<EquityPosition[] | null>;
}): Promise<void> {
  if (p.candidates.size === 0) return;
  try {
    const thresholdMinutes = pendingFillEscalationMinutes();
    const cutoffMs = Date.now() - thresholdMinutes * 60_000;
    for (const fill of listPendingBrokerReconciliationFills(p.accountNumber, p.userId)) {
      const candidate = p.candidates.get(fill.id);
      if (!candidate) continue;
      const placedAtMs = Date.parse(fill.filledAt);
      if (!Number.isFinite(placedAtMs) || placedAtMs > cutoffMs) continue;
      const raw = (fill.raw ?? {}) as Record<string, unknown>;
      if (raw.pendingEscalation) continue;
      const ageMinutes = Math.round((Date.now() - placedAtMs) / 60_000);
      const evidence = candidate.reason === "order_absent_from_listing"
        ? await collectAbsentOrderPositionEvidence({
            accountNumber: p.accountNumber,
            userId: p.userId,
            fill,
            positionsSnapshot: p.positionsSnapshot
          })
        : undefined;
      // Marker first: an at-most-once informational alert beats a repeat-on-notify-failure one
      // (the audit row below still records the stall either way).
      updateFillEvent(fill.id, {
        raw: { ...raw, pendingEscalation: { at: new Date().toISOString(), thresholdMinutes, reason: candidate.reason } }
      }, p.userId);
      const summary = candidate.reason === "order_absent_from_listing"
        ? `Broker order ${fill.brokerOrderId ?? "(unknown)"} is absent from the ${candidate.listingIncludesTerminal ? "" : "non-authoritative "}order listing after ${ageMinutes} minutes. ${evidence?.summary ?? ""} Verify with the broker and resolve manually.`
        : `Broker order ${fill.brokerOrderId ?? "(unknown)"} is in terminal state "${candidate.brokerState}" but reported no usable execution price/quantity after ${ageMinutes} minutes (known executed quantity: ${candidate.knownBrokerQuantity}). Verify the real fill with the broker.`;
      const reasonDetail = candidate.reason === "terminal_state_unusable_execution_data"
        ? { brokerState: candidate.brokerState, knownBrokerQuantity: candidate.knownBrokerQuantity }
        : { listingIncludesTerminal: candidate.listingIncludesTerminal };
      audit("fill_reconciliation_stalled", {
        fillId: fill.id,
        proposalId: fill.proposalId,
        brokerOrderId: fill.brokerOrderId,
        symbol: fill.symbol,
        side: fill.side,
        ageMinutes,
        thresholdMinutes,
        reason: candidate.reason,
        ...reasonDetail,
        ...(evidence ? { evidence } : {})
      }, p.userId, p.connectedAccountId);
      try {
        await sendNotification(
          {
            type: "run_failed",
            title: `${fill.symbol} fill pending reconciliation ${ageMinutes}m — verify with broker`,
            payload: {
              fillId: fill.id,
              proposalId: fill.proposalId,
              brokerOrderId: fill.brokerOrderId,
              symbol: fill.symbol,
              side: fill.side,
              ageMinutes,
              thresholdMinutes,
              reason: candidate.reason,
              ...reasonDetail,
              ...(evidence ? { evidence } : {}),
              reconcile: "uncertain",
              summary
            }
          },
          { userId: p.userId }
        );
      } catch (notifyError) {
        console.warn("[reconciliation] pending-fill escalation notification failed:", notifyError instanceof Error ? notifyError.message : String(notifyError));
      }
    }
  } catch (error) {
    console.error("[reconciliation] pending-fill age escalation failed:", error);
  }
}
export async function reconcilePlacementError(p: {
  gateway: BrokerGateway;
  accountNumber: string;
  userId: string;
  connectedAccountId?: string;
  proposalId: string;
  refId: string;
  proposal: TradeProposal;
  review?: ReviewedOrder;
  marketScan?: MarketScan;
  executionMode: ExecutionMode;
  placeErrorMessage: string;
  runId?: string;
}): Promise<PlacementReconcileOutcome> {
  // Wait a brief period to allow the broker's order list to index the new order
  // and prevent sub-millisecond races (where an accepted order isn't visible yet).
  await new Promise((resolve) => setTimeout(resolve, 1000));

  let brokerOrders: EquityOrder[];
  try {
    brokerOrders = await p.gateway.getEquityOrders(p.accountNumber);
  } catch {
    // getEquityOrders throwing is the ONLY genuinely-unknown case.
    return { kind: "uncertain", error: p.placeErrorMessage };
  }
  // Truthiness guard identical to the sweep's (:5249) so undefined === undefined can never false-match.
  const matched = p.refId ? brokerOrders.find((o) => o.clientOrderId && o.clientOrderId === p.refId) : undefined;
  if (!matched) {
    // Absent-from-list is only a SAFE not_placed conclusion when the broker's order list is
    // authoritative for recently-terminal orders (Alpaca pages status:"all"). If the adapter can't
    // guarantee the list includes filled/canceled orders for the lookback window (Robinhood —
    // unverified; ordersListIncludesTerminal unset), absence can't distinguish "never placed" from
    // "placed, filled, and already aged out", so prefer uncertain (keep 'placing' + protected alert)
    // over dropping a possibly-real order that the next run would then duplicate (MP-3).
    if (p.gateway.ordersListIncludesTerminal === true) return { kind: "not_placed" };
    return {
      kind: "uncertain",
      error: `${p.placeErrorMessage} (broker reachable but its order list may omit recently-terminal orders — cannot confirm the order was never placed)`
    };
  }
  // Live / filled / any non-terminal state: the order reached the broker. Book it (deduped).
  try {
    const existing = listFillEventsByProposalId(p.proposalId, p.userId);
    const dup = existing.find((f) => f.brokerOrderId === matched.id);
    const merged = mergedExecutionTruth(matched, dup);
    if (isRejectedOrCanceledState(matched.state) && merged.knownQuantity <= 0) {
      return { kind: "declined", orderId: matched.id, state: matched.state };
    }
    const fillStatus = reconciledFillStatus(matched, dup);
    if (dup) {
      let reconciled = dup;
      if (merged.truth && (fillStatus === "filled" || fillStatus === "partially_filled")) {
        const { price, quantity, notional } = merged.truth;
        updateFillEvent(dup.id, {
          status: fillStatus,
          price,
          quantity,
          notional,
          filledAt: matched.updatedAt ?? dup.filledAt,
          raw: reconciliationRaw(dup, matched, merged.knownQuantity)
        }, p.userId);
        reconciled = { ...dup, status: fillStatus, price, quantity, notional, filledAt: matched.updatedAt ?? dup.filledAt };
        await commitRecoveredOpeningStopPlan({ gateway: p.gateway, accountNumber: p.accountNumber, userId: p.userId, proposal: p.proposal, price, orderId: matched.id });
      } else {
        updateFillEvent(dup.id, { raw: reconciliationRaw(dup, matched, merged.knownQuantity) }, p.userId);
      }
      return { kind: "placed", orderId: matched.id, state: matched.state, fillStatus, fill: reconciled, alreadyBooked: true };
    }
    const source: FillSource = p.executionMode === "broker/live" ? "live" : "paper";
    const fill = recordFillFromProposal({
      userId: p.userId,
      connectedAccountId: p.connectedAccountId,
      accountNumber: p.accountNumber,
      proposalId: p.proposalId,
      runId: p.runId,
      source,
      executionMode: p.executionMode,
      proposal: p.proposal,
      review: p.review,
      marketScan: p.marketScan,
      execution: { orderId: matched.id, refId: p.refId, state: matched.state, filledQuantity: matched.filledQuantity, averagePrice: matched.averagePrice, raw: matched },
      status: fillStatus
    });
    if (fillStatus === "filled" || fillStatus === "partially_filled") {
      const price = matched.averagePrice ?? p.proposal.referencePrice ?? 0;
      await commitRecoveredOpeningStopPlan({ gateway: p.gateway, accountNumber: p.accountNumber, userId: p.userId, proposal: p.proposal, price, orderId: matched.id });
    }
    return { kind: "placed", orderId: matched.id, state: matched.state, fillStatus, fill, alreadyBooked: false };
  } catch (bookError) {
    // We KNOW the order exists but booking failed — degrade to uncertain so the 'placing' intent +
    // alert survive for the sweep to retry, rather than dropping a real order on the floor (MP-8).
    const detail = bookError instanceof Error ? bookError.message : String(bookError);
    return { kind: "uncertain", error: `${p.placeErrorMessage} (order confirmed at broker but booking failed: ${detail})` };
  }
}
export async function flagStalePlacingIntents(gateway: BrokerGateway, accountNumber: string, userId: string, connectedAccountId?: string): Promise<void> {
  const STALE_PLACING_MS = 2 * 60_000;
  const cutoff = new Date(Date.now() - STALE_PLACING_MS).toISOString();
  let stale: ReturnType<typeof listStalePlacingProposals>;
  try {
    stale = listStalePlacingProposals(accountNumber, cutoff, userId);
  } catch (e) {
    console.error("[placing-sweep] failed to list stale placing intents:", e);
    return;
  }
  if (stale.length === 0) return;

  // Broker-truth-first reconcile: a stale "placing" intent means a prior run died between the
  // broker call and the post-write. Ask the broker for the order carrying our idempotency key
  // (refId → clientOrderId). If it exists, the order DID reach the broker — recover it into P&L/
  // accounting at the broker's real fill price. If no order carries our key, it never executed and
  // is safe to abandon. If the broker is unreachable, leave the row 'placing' for a later retry.
  let brokerOrders: EquityOrder[];
  try {
    brokerOrders = await gateway.getEquityOrders(accountNumber);
  } catch (e) {
    const { logError, recordBrokerCall } = await import("./sentry-metrics");
    recordBrokerCall("unknown", "getEquityOrders", 0, "failure");
    logError("broker.call", {
      broker: "unknown",
      endpoint: "getEquityOrders",
      error: e instanceof Error ? e.message : String(e)
    });
    for (const row of stale) {
      audit("order_placement_uncertain", { proposalId: row.id, refId: row.refId, note: "Stale placing intent; broker unreachable for recovery — will retry." }, userId, connectedAccountId);
    }
    return;
  }

  // Lazily fetched (only if a recovered fill actually carries an opening stopPlan) — these orders
  // already EXECUTED at the broker, so the live position's averageCost is the real POST-fill blended
  // basis, same reasoning as reconcilePendingFills' liveBasisFor (Codex review, PR #1371).
  let liveBasisBySymbol: Map<string, number> | null = null;
  const liveBasisFor = async (symbol: string): Promise<number | undefined> => {
    if (!liveBasisBySymbol) {
      try {
        const livePositions = await gateway.getEquityPositions(accountNumber);
        liveBasisBySymbol = new Map(livePositions.map((pos) => [normalizeSymbol(pos.symbol), pos.averageCost]));
      } catch {
        liveBasisBySymbol = new Map();
      }
    }
    return liveBasisBySymbol.get(normalizeSymbol(symbol));
  };

  for (const row of stale) {
    const p = row.proposal as TradeProposal | undefined;
    const matched = row.refId ? brokerOrders.find((o) => o.clientOrderId && o.clientOrderId === row.refId) : undefined;
    if (matched) {
      const existingReceipt = listFillEventsByProposalId(row.id, userId).find((fill) => fill.brokerOrderId === matched.id);
      const merged = mergedExecutionTruth(matched, existingReceipt);
      if (isRejectedOrCanceledState(matched.state) && merged.knownQuantity <= 0) {
        // A terminal zero snapshot is a decline only when no earlier priced partial execution was
        // booked. Broker snapshots can regress; an existing partial is durable execution truth.
        const declinedMsg = `Broker declined the order (state: ${matched.state}).`;
        updateProposalStatus(row.id, "rejected_by_broker", matched.id, undefined, undefined, userId, undefined, declinedMsg);
        audit("order_rejected_by_broker", { proposalId: row.id, refId: row.refId, orderId: matched.id, brokerState: matched.state, symbol: p?.symbol, side: p?.side, via: "sweep" }, userId, connectedAccountId);
        continue;
      }

      const fillStatus = reconciledFillStatus(matched, existingReceipt);
      const recoveredProposalStatus = fillStatus === "filled" ? "filled" : "placed";
      let lifecycleCommitted = false;

      // A crash can leave the durable receipt at pending_reconciliation while the broker later
      // reports a full fill. Dedupe must not mean "skip reconciliation": finalize that SAME receipt
      // and the proposal/case lifecycle together, otherwise accounting omits the execution while the
      // UI claims it filled. This also makes a second sweep a true no-op.
      if (existingReceipt && merged.truth && (fillStatus === "filled" || fillStatus === "partially_filled")) {
        const { price, quantity, notional } = merged.truth;
        const shouldUpdateReceipt = existingReceipt.status !== fillStatus
          || existingReceipt.quantity !== quantity
          || existingReceipt.price !== price
          || existingReceipt.notional !== notional;
        const updateExistingReceipt = () => {
          updateFillEvent(existingReceipt.id, {
            status: fillStatus,
            price,
            quantity,
            notional,
            filledAt: matched.updatedAt ?? existingReceipt.filledAt,
            raw: reconciliationRaw(existingReceipt, matched, merged.knownQuantity)
          }, userId);
        };
        if (fillStatus === "filled") {
          getDb().transaction(() => {
            if (shouldUpdateReceipt) updateExistingReceipt();
            updateProposalStatus(row.id, "filled", matched.id, undefined, notional, userId);
          }).immediate();
          lifecycleCommitted = true;
        } else if (shouldUpdateReceipt) {
          updateExistingReceipt();
        }

        if (p) {
          await commitRecoveredOpeningStopPlan({ gateway, accountNumber, userId, proposal: p, price, orderId: matched.id });
        }
      } else if (existingReceipt) {
        updateFillEvent(existingReceipt.id, { raw: reconciliationRaw(existingReceipt, matched, merged.knownQuantity) }, userId);
      }
      if (p) {
        // Layer-B dedupe (crash window): if a prior inline reconcile / sweep already booked this
        // order (same brokerOrderId) but the status flip didn't persist, don't book a second fill.
        // Dedupe key = (proposalId, brokerOrderId); the same physical order always yields the same
        // brokerOrderId (we place with client_order_id = refId), so re-entry matches and no-ops.
        const alreadyBooked = Boolean(existingReceipt);
        if (!alreadyBooked) {
          const recoveredExecutionMode = row.executionMode ?? "broker/live";
          const recoveredSource: FillSource = recoveredExecutionMode === "broker/live" ? "live" : "paper";
          const existingAvgCost = p.stopPlan ? await liveBasisFor(p.symbol) : undefined;
          recordFillFromProposal({
            userId,
            connectedAccountId,
            accountNumber,
            proposalId: row.id,
            source: recoveredSource,
            executionMode: recoveredExecutionMode,
            proposal: p,
            execution: { orderId: matched.id, refId: row.refId ?? "", state: matched.state, filledQuantity: matched.filledQuantity, averagePrice: matched.averagePrice, raw: matched },
            status: fillStatus,
            // The order already executed at the broker, so the live position's averageCost IS the
            // correct post-fill blended basis already — bypass the pre-fill blend math entirely rather
            // than re-deriving it from the single recovered fill price.
            stopPlanBasisOverride: existingAvgCost
          });
        }
      }
      // Book first, then close the placing intent. If the process dies between these writes, the
      // next sweep sees `placing` plus the broker-order dedupe receipt and finishes the status only;
      // the inverse order could permanently lose a real fill.
      const recoveredNotional = fillStatus === "filled" ? merged.truth?.notional : undefined;
      if (!lifecycleCommitted) {
        updateProposalStatus(row.id, recoveredProposalStatus, matched.id, undefined, recoveredNotional, userId);
      }
      audit("order_placement_recovered", { proposalId: row.id, refId: row.refId, orderId: matched.id, state: matched.state, symbol: p?.symbol, side: p?.side }, userId, connectedAccountId);
      // A recovered order is a CONFIRMED placement — clear any perpetual "verify with broker" alert
      // this proposal left behind (the primary fix for "even reconciled orders stay uncertain").
      resolveBrokerVerificationNotifications(userId, { proposalId: row.id, refId: row.refId ?? undefined, resolution: "recovered" });
    } else if (gateway.ordersListIncludesTerminal === true) {
      // Absent from an AUTHORITATIVE order list (includes recently-terminal orders, e.g. Alpaca
      // status:"all") ⇒ the order truly never reached the matching engine. Abandon it.
      updateProposalStatus(row.id, "placing_failed", undefined, undefined, undefined, userId, undefined, "Order never confirmed — broker record not found during reconciliation.");
      audit("order_placement_uncertain", { proposalId: row.id, refId: row.refId, symbol: p?.symbol, side: p?.side, createdAt: row.createdAt, note: "Stale 'placing' intent had no matching broker order — never executed; abandoned." }, userId, connectedAccountId);
    } else {
      // Absent from a NON-authoritative list (terminal-inclusion unverified, e.g. Robinhood): absence
      // can't prove "never placed" vs "placed, filled, and aged out". Abandoning would risk dropping a
      // real fill that the next run then duplicates, so KEEP the row 'placing' + its protected
      // uncertain alert (a human must verify). Matches reconcilePlacementError's conservative branch —
      // without this the sweep would silently undo that inline conservatism.
      audit("order_placement_uncertain", { proposalId: row.id, refId: row.refId, symbol: p?.symbol, side: p?.side, createdAt: row.createdAt, note: "Stale 'placing' intent absent from a non-authoritative broker order list — cannot confirm it was never placed; kept 'placing' for verification rather than abandoned." }, userId, connectedAccountId);
    }
  }
}
export function coerceProtectiveExitToMarket(proposal: TradeProposal): TradeProposal {
  const isProtectiveExit = (proposal.side === "sell" || proposal.side === "cover") && proposal.tradeThesisTag === "Risk-Exit";
  if (!isProtectiveExit) return proposal;
  if (proposal.type !== "limit" && proposal.type !== "stop_limit") return proposal;
  return {
    ...proposal,
    type: "market",
    limitPrice: undefined,
    stopPrice: undefined,
    rationale: (proposal.rationale ?? "") + "\n\n[Risk] Protective Risk-Exit routed as a MARKET order so it actually fills — a resting limit can miss the exit in a fast/falling tape, and a stale unfilled exit then blocks every retry."
  };
}
