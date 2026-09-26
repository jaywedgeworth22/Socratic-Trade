// Approved exits vs the app's OWN resting protective stops (lane G2, 2026-09-25).
//
// The problem (Alpaca Paper, 120 days): about 62 of 115 blocked proposals were discretionary
// exits blocked by `evaluateBrokerHeldExitAvailability` because the app's own resting GTC
// protective stop (broker_protective_stops — e.g. BAC 24, KO 14, PYPL 30, BRK-B 2 on 2026-09-24)
// reserved the whole position at the broker (`held_for_orders`), so the available quantity was 0.
// In practice those positions could only ever leave through the stop.
//
// The fix, default ON behind the owner toggle `exitsReleaseAppStops` ("Exits release the app's
// own stop"): when an approved exit (autopilot or human-approved; a sell of a long or a cover of a
// short) needs shares that ONLY the app's own tracked protective stop is holding,
//   1. PLAN (before the placement lease): prove every share the exit needs is held by an
//      app-owned stop — a broker_protective_stops row tracks the order id, order-provenance says
//      the app placed it, and it is not a bracket/OCO leg.  Owner or external orders are never
//      candidates; if they hold any of the needed shares the exit stays blocked as before.
//   2. RELEASE (inside the placement lease, after the fresh system-state fence): persist a durable
//      intent, cancel each stop, and poll the broker until the cancel settles (the same multi-poll
//      helper stale-exit replacements use).  A stop that FILLED during the race is booked like any
//      broker-held stop fill; if that closed the position the exit is moot and is not sent.  A
//      cancel that never settles aborts the exit — the stop stays in charge.
//   3. PLACE the exit.  The placement choke point's position invariant (#3759) still clamps a
//      sell to the shares actually held; this module passes it the position it just read.
//   4. RESTORE: run the normal protective-stop reconcile so a stop is re-placed for whatever is
//      left (coverage-aware: a still-working exit order counts as coverage, and the reconciler
//      re-places once it fills or dies).  The durable intent keeps owing that restore across a
//      crash or restart until protection is back, the position is closed, or live exit orders
//      cover it — see exit-stop-release-intents.ts.  Nothing about a released stop is silent:
//      every step writes an `exit_stop_release_*` audit row.
//
// Broker notes: Alpaca (REST native trailing_stop and MCP) and live Robinhood (opt-in resting
// stops) are the only venues where the app rests its own protective stops, so they are the only
// venues this can act on.  Tradier, eToro, Public, Webull and Kalshi carry no broker_protective_stops
// rows, so their held exits stay blocked exactly as before.

import { audit, filterStopPlansByLiveBasis, getStopPlans, listBrokerProtectiveStops, listSyntheticStops, type BrokerProtectiveStop } from "./db";
import { brokerHeldExitBlockReason, evaluateBrokerHeldExitAvailability, type BrokerHeldExitAvailability } from "./broker-held-orders";
import { isRejectedOrCanceledState } from "./broker-side";
import { reconcileBrokerProtectiveStops, settleReleasedProtectiveStop } from "./broker-protective-stops";
import {
  deleteExitStopReleaseIntent,
  getExitStopReleaseIntent,
  putExitStopReleaseIntent,
  updateExitStopReleasePhase,
  type ReleasedStopSnapshot
} from "./exit-stop-release-intents";
import { normalizeSymbol } from "./money";
import { CANCEL_SETTLE_POLL_MAX_MS, CANCEL_SETTLE_POLL_MS, pollCancelSettlement } from "./order-replacement";
import { isAppPlacedBrokerOrder, isContingentOrderLeg } from "./order-provenance";
import {
  OrderValidationError,
  type BrokerGateway,
  type EquityOrder,
  type EquityPosition,
  type ExecutionMode,
  type TradeProposal,
  type TradingPolicy
} from "./types";

const QTY_EPSILON = 1e-6;

export type ExitProposalSizing = Pick<TradeProposal, "symbol" | "side" | "quantity" | "dollarAmount" | "limitPrice" | "stopPrice" | "referencePrice">;

/** Owner toggle, default ON: `false` restores the old behavior (the exit is blocked). */
export function exitStopReleaseEnabled(policy: Pick<TradingPolicy, "exitsReleaseAppStops">): boolean {
  return policy.exitsReleaseAppStops !== false;
}

export interface ReleasableProtectiveStop {
  rowId: string;
  brokerOrderId: string;
  /** The tracked row's quantity (what the reconciler placed). */
  quantity: number;
  /** Unfilled quantity the broker reports on the order right now. */
  remainingQuantity: number;
  stopPrice: number;
  kind: "fixed" | "trailing";
  trailPercent?: number;
  /** The broker's current trigger (a native trail moves it). */
  brokerStopPrice?: number;
}

export interface ExitStopReleasePlan {
  symbol: string;
  side: "sell" | "cover";
  requestedQuantity: number;
  positionQuantity: number;
  heldQuantity: number;
  availableQuantity: number;
  stops: ReleasableProtectiveStop[];
  heldExit: BrokerHeldExitAvailability;
}

export type ExitStopReleaseDecision =
  | { kind: "none" }
  | { kind: "release"; plan: ExitStopReleasePlan }
  | { kind: "blocked"; heldExit: BrokerHeldExitAvailability; reason: string; appStopOrderIds: string[] };

export type ExitStopReleaseErrorCode = "stop_cancel_unconfirmed" | "position_unverified" | "exit_moot_stop_filled" | "still_held";

/**
 * A deterministic refusal before the exit reached the broker.  Extends OrderValidationError so
 * both placement lanes (strategy.ts autopilot, strategy-execution.ts approval) record the
 * proposal as "blocked" with this message instead of treating it as an uncertain placement.
 */
export class ExitStopReleaseError extends OrderValidationError {
  readonly code: ExitStopReleaseErrorCode;
  constructor(message: string, code: ExitStopReleaseErrorCode) {
    super(message);
    this.name = "ExitStopReleaseError";
    this.code = code;
  }
}

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function remainingOnOrder(order: EquityOrder): number {
  const quantity = order.quantity ?? 0;
  if (!(quantity > 0)) return 0;
  return Math.max(quantity - (order.filledQuantity ?? 0), 0);
}

function backingQuantity(positions: EquityPosition[], symbol: string, side: "sell" | "cover"): { signed: number; backing: number } {
  const pos = positions.find((p) => normalizeSymbol(p.symbol) === symbol);
  const signed = pos?.quantity ?? 0;
  return { signed, backing: side === "sell" ? Math.max(signed, 0) : Math.max(-signed, 0) };
}

/**
 * Decide, BEFORE the placement lease, whether a held exit can be unblocked by releasing the app's
 * own protective stop.  Pure over its inputs plus one read of broker_protective_stops.
 *   - `none`: nothing holds the exit (the normal path).
 *   - `release`: only app-owned tracked stops stand between the exit and its shares.
 *   - `blocked`: keep the old block (toggle off, or an owner/external/bracket order holds shares
 *     the exit needs).  `reason` is the owner-facing block text.
 */
export function planExitStopRelease(input: {
  proposal: ExitProposalSizing;
  positions: EquityPosition[];
  orders: EquityOrder[];
  policy: Pick<TradingPolicy, "exitsReleaseAppStops">;
  userId: string;
  accountNumber: string;
}): ExitStopReleaseDecision {
  const heldExit = evaluateBrokerHeldExitAvailability(input.proposal as TradeProposal, input.positions, input.orders);
  if (!heldExit) return { kind: "none" };
  const baseReason = brokerHeldExitBlockReason(heldExit);
  const symbol = heldExit.symbol;

  let rows: BrokerProtectiveStop[] = [];
  try {
    rows = listBrokerProtectiveStops(input.accountNumber, input.userId).filter(
      (row) => normalizeSymbol(row.symbol) === symbol && row.status === "resting"
    );
  } catch {
    rows = [];
  }
  const heldIds = new Set(heldExit.heldOrderIds);
  const lookup = { userId: input.userId, accountNumber: input.accountNumber };
  const releasable: Array<{ order: EquityOrder; row: BrokerProtectiveStop }> = [];
  for (const order of input.orders) {
    if (!heldIds.has(order.id)) continue;
    const row = rows.find((r) => r.brokerOrderId === order.id);
    if (!row) continue; // not a stop the app tracks — owner/external/other app exit: never touched
    if (!isAppPlacedBrokerOrder(order, lookup)) continue;
    if (isContingentOrderLeg(order, input.orders, { brokerEvidenceOnly: true })) continue;
    // A stop that is executing right now is already exiting; cancelling it mid-fill would abort a
    // working exit.  Leave it alone (the old block stands for this pass).
    if (String(order.state ?? "").trim().toLowerCase() === "partially_filled") continue;
    releasable.push({ order, row });
  }
  const appStopOrderIds = releasable.map((r) => r.order.id);
  if (releasable.length === 0) return { kind: "blocked", heldExit, reason: baseReason, appStopOrderIds };

  // Would the exit fit once ONLY the app's own stops are gone?  Anything else still holding
  // shares (owner orders, bracket legs, another working exit) keeps it blocked, untouched.
  const releasedIds = new Set(appStopOrderIds);
  const need = Math.min(heldExit.requestedQuantity, heldExit.positionQuantity);
  const afterRelease = evaluateBrokerHeldExitAvailability(
    { ...(input.proposal as TradeProposal), quantity: need, dollarAmount: undefined },
    input.positions,
    input.orders.filter((o) => !releasedIds.has(o.id))
  );
  if (afterRelease) {
    return {
      kind: "blocked",
      heldExit,
      appStopOrderIds,
      reason: `${baseReason}  The app's own protective stop holds only part of those shares; other orders hold the rest, so the stop was left in place.`
    };
  }
  if (!exitStopReleaseEnabled(input.policy)) {
    return {
      kind: "blocked",
      heldExit,
      appStopOrderIds,
      reason: `${baseReason}  The shares are held by the app's own protective stop.  Turn on "Exits release the app's own stop" in Guardrails to let approved exits cancel it and re-place it for any remaining shares.`
    };
  }
  return {
    kind: "release",
    plan: {
      symbol,
      side: heldExit.side,
      requestedQuantity: heldExit.requestedQuantity,
      positionQuantity: heldExit.positionQuantity,
      heldQuantity: heldExit.heldQuantity,
      availableQuantity: heldExit.availableQuantity,
      heldExit,
      stops: releasable.map(({ order, row }) => ({
        rowId: row.id,
        brokerOrderId: row.brokerOrderId,
        quantity: row.quantity,
        remainingQuantity: round6(remainingOnOrder(order)),
        stopPrice: row.stopPrice,
        kind: row.kind,
        ...(row.trailPercent !== undefined ? { trailPercent: row.trailPercent } : {}),
        ...(typeof order.stopPrice === "number" && order.stopPrice > 0 ? { brokerStopPrice: order.stopPrice } : {})
      }))
    }
  };
}

export interface ExitStopReleaseRun {
  userId: string;
  policy: TradingPolicy;
  accountNumber: string;
  connectedAccountId?: string;
  gateway: BrokerGateway;
  executionMode: ExecutionMode;
  proposal: ExitProposalSizing;
  plan: ExitStopReleasePlan;
  lane: "autopilot" | "approval";
  proposalId?: string;
  runId?: string;
  /** Mutation-lease fence, re-asserted before cancelling protection. */
  assertOwned?: () => void;
  /** Test seam: settle poll interval in ms (0 = one immediate order read). */
  cancelSettleMs?: number;
  cancelSettleMaxMs?: number;
}

type StopReleaseOutcome = "cancelled" | "cancelled_unlisted" | "filled" | "still_active" | "unknown";

interface StopReleaseResult {
  stop: ReleasableProtectiveStop;
  outcome: StopReleaseOutcome;
  brokerState?: string;
  filledQuantity?: number;
  error?: string;
}

function snapshotOf(stop: ReleasableProtectiveStop): ReleasedStopSnapshot {
  return {
    rowId: stop.rowId,
    brokerOrderId: stop.brokerOrderId,
    quantity: stop.quantity,
    stopPrice: stop.stopPrice,
    kind: stop.kind,
    ...(stop.trailPercent !== undefined ? { trailPercent: stop.trailPercent } : {}),
    ...(stop.brokerStopPrice !== undefined ? { brokerStopPrice: stop.brokerStopPrice } : {})
  };
}

function hadExecutedFill(order: EquityOrder): boolean {
  return String(order.state ?? "").trim().toLowerCase() === "filled" || (order.filledQuantity ?? 0) > 0;
}

/**
 * Release the app's own protective stop(s) named in `run.plan`, place the exit through `place`,
 * then restore protection for whatever is left.  `place` receives the signed position quantity
 * this sequence just read (pass it as `verifiedPositionQuantity`).  Must run INSIDE the account
 * placement lease, after the fresh system-state fence and immediately before the broker call.
 *
 * Throws ExitStopReleaseError (an OrderValidationError) when the exit must not be sent: a stop
 * cancel did not settle, the position could not be re-read, the stop filled and closed the
 * position, or other orders still hold the shares.  Errors from `place` propagate unchanged —
 * the restore runs either way and never throws.
 */
export async function placeExitReleasingOwnStops<T>(run: ExitStopReleaseRun, place: (verifiedPositionQuantity: number) => Promise<T>): Promise<T> {
  const symbol = normalizeSymbol(run.plan.symbol);
  const exitSide = run.plan.side;
  const { userId, accountNumber, gateway } = run;
  const connectedAccountId = run.connectedAccountId ?? run.policy.connectedAccountId;
  const auditBase = { symbol, side: exitSide, lane: run.lane, proposalId: run.proposalId, runId: run.runId };
  const now = new Date().toISOString();

  putExitStopReleaseIntent({
    userId,
    accountNumber,
    connectedAccountId,
    symbol,
    exitSide,
    lane: run.lane,
    proposalId: run.proposalId,
    runId: run.runId,
    phase: "releasing",
    stops: run.plan.stops.map(snapshotOf),
    restoreAttempts: 0,
    createdAt: now,
    updatedAt: now
  });
  audit(
    "exit_stop_release_started",
    {
      ...auditBase,
      requestedQuantity: run.plan.requestedQuantity,
      positionQuantity: run.plan.positionQuantity,
      heldQuantity: run.plan.heldQuantity,
      stops: run.plan.stops.map((s) => ({ brokerOrderId: s.brokerOrderId, kind: s.kind, quantity: s.remainingQuantity, stopPrice: s.stopPrice }))
    },
    userId,
    connectedAccountId
  );

  const settleMs = run.cancelSettleMs ?? CANCEL_SETTLE_POLL_MS;
  const maxWaitMs = settleMs <= 0 ? 0 : run.cancelSettleMaxMs ?? CANCEL_SETTLE_POLL_MAX_MS;
  const results: StopReleaseResult[] = [];
  let lastOrders: EquityOrder[] | undefined;
  let aborted: ExitStopReleaseError | undefined;

  for (const stop of run.plan.stops) {
    try {
      run.assertOwned?.();
    } catch (fenceError) {
      // Lost the lease before touching protection: nothing was cancelled for this stop.
      await rollBack(run, symbol, "lease_lost_before_cancel");
      throw fenceError;
    }
    let cancelError: string | undefined;
    try {
      await gateway.cancelEquityOrder(accountNumber, stop.brokerOrderId);
    } catch (err) {
      cancelError = errMsg(err);
    }
    let after: EquityOrder | undefined;
    let stillActive = false;
    try {
      const settled = await pollCancelSettlement({ gateway, accountNumber, orderId: stop.brokerOrderId, settleMs, maxWaitMs });
      lastOrders = settled.afterCancelOrders;
      after = settled.afterCancel;
      stillActive = settled.stillActive;
    } catch (err) {
      results.push({ stop, outcome: "unknown", error: `order list unavailable after cancel: ${errMsg(err)}${cancelError ? ` (cancel: ${cancelError})` : ""}` });
      continue;
    }
    if (after && stillActive) {
      results.push({ stop, outcome: "still_active", brokerState: after.state, error: cancelError });
    } else if (after && hadExecutedFill(after)) {
      results.push({ stop, outcome: "filled", brokerState: after.state, filledQuantity: after.filledQuantity, error: cancelError });
    } else if (after && isRejectedOrCanceledState(after.state)) {
      results.push({ stop, outcome: "cancelled", brokerState: after.state, error: cancelError });
    } else if (!after && !cancelError) {
      // The broker accepted the cancel and the order no longer shows in its list (a list that is
      // not authoritative for terminal orders, e.g. Robinhood).  Accepted as cancelled; the fresh
      // position read below still decides how much the exit may sell.
      results.push({ stop, outcome: "cancelled_unlisted" });
    } else {
      results.push({ stop, outcome: "unknown", brokerState: after?.state, error: cancelError });
    }
  }

  // Bookkeeping for every stop the broker is done with: drop its tracking row, and book any
  // executed quantity as a broker-held stop fill (atomic pair, idempotent on replay).
  for (const result of results) {
    if (result.outcome !== "cancelled" && result.outcome !== "cancelled_unlisted" && result.outcome !== "filled") continue;
    const row = findTrackedRow(userId, accountNumber, result.stop);
    if (!row) continue;
    try {
      const order = (lastOrders ?? []).find((o) => o.id === result.stop.brokerOrderId);
      const booked = settleReleasedProtectiveStop({ userId, accountNumber, executionMode: run.executionMode, row, exitSide, order: result.outcome === "filled" ? order : undefined });
      if (booked > 0) result.filledQuantity = booked;
    } catch (err) {
      audit("exit_stop_release_bookkeeping_error", { ...auditBase, brokerOrderId: result.stop.brokerOrderId, error: errMsg(err) }, userId, connectedAccountId);
    }
  }
  audit(
    "exit_stop_release_cancel_results",
    { ...auditBase, results: results.map((r) => ({ brokerOrderId: r.stop.brokerOrderId, outcome: r.outcome, brokerState: r.brokerState, filledQuantity: r.filledQuantity, error: r.error })) },
    userId,
    connectedAccountId
  );

  const unresolved = results.filter((r) => r.outcome === "still_active" || r.outcome === "unknown");
  if (unresolved.length > 0) {
    aborted = new ExitStopReleaseError(
      `${symbol} exit not placed: the app's own protective stop did not confirm its cancel in time (${unresolved.map((r) => `${r.stop.brokerOrderId}: ${r.brokerState ?? r.error ?? "unknown"}`).join(", ")}).  The stop stays in charge, or is re-placed on the next protective-stop pass if the cancel lands later.`,
      "stop_cancel_unconfirmed"
    );
  }

  let signedPosition = 0;
  if (!aborted) {
    let positions: EquityPosition[];
    try {
      positions = await gateway.getEquityPositions(accountNumber);
    } catch (err) {
      aborted = new ExitStopReleaseError(
        `${symbol} exit not placed: the position could not be re-read after releasing the app's own protective stop (${errMsg(err)}).  The stop is re-placed on the next protective-stop pass.`,
        "position_unverified"
      );
      positions = [];
    }
    if (!aborted) {
      const { signed, backing } = backingQuantity(positions, symbol, exitSide);
      signedPosition = signed;
      if (backing <= QTY_EPSILON) {
        // The stop fired (fully) during the release: the position the exit meant to close is
        // already gone.  Nothing to sell, nothing to restore.
        deleteExitStopReleaseIntent(userId, accountNumber, symbol);
        audit("exit_stop_release_moot", { ...auditBase, results: results.map((r) => ({ brokerOrderId: r.stop.brokerOrderId, outcome: r.outcome, filledQuantity: r.filledQuantity })) }, userId, connectedAccountId);
        throw new ExitStopReleaseError(
          `${symbol} exit not placed: the app's own protective stop filled while it was being released and the position is already closed.  Nothing was left to ${exitSide}.`,
          "exit_moot_stop_filled"
        );
      }
      const need = Math.min(run.plan.requestedQuantity, backing);
      const stillHeld = evaluateBrokerHeldExitAvailability(
        { ...(run.proposal as TradeProposal), quantity: need, dollarAmount: undefined },
        positions,
        lastOrders ?? []
      );
      if (stillHeld) {
        aborted = new ExitStopReleaseError(
          `${symbol} exit not placed after releasing the app's own protective stop: ${brokerHeldExitBlockReason(stillHeld)}  The released stop is re-placed for the position.`,
          "still_held"
        );
      }
    }
  }

  if (aborted) {
    await rollBack(run, symbol, aborted.code);
    throw aborted;
  }

  updateExitStopReleasePhase(userId, accountNumber, symbol, "released");
  audit(
    "exit_stop_released",
    { ...auditBase, positionQuantity: signedPosition, requestedQuantity: run.plan.requestedQuantity, releasedStopOrderIds: run.plan.stops.map((s) => s.brokerOrderId) },
    userId,
    connectedAccountId
  );

  try {
    return await place(signedPosition);
  } finally {
    await restoreProtectionAfterRelease(run, symbol, "exit_submitted");
  }
}

function findTrackedRow(userId: string, accountNumber: string, stop: ReleasableProtectiveStop): BrokerProtectiveStop | undefined {
  try {
    return listBrokerProtectiveStops(accountNumber, userId).find((row) => row.id === stop.rowId && row.brokerOrderId === stop.brokerOrderId);
  } catch {
    return undefined;
  }
}

async function rollBack(run: ExitStopReleaseRun, symbol: string, reason: string): Promise<void> {
  audit("exit_stop_release_aborted", { symbol, side: run.plan.side, lane: run.lane, proposalId: run.proposalId, runId: run.runId, reason }, run.userId, run.connectedAccountId ?? run.policy.connectedAccountId);
  await restoreProtectionAfterRelease(run, symbol, "restore_pending");
}

/**
 * Put protection back after a release: mark the intent as owing a restore, then run the normal
 * protective-stop reconcile with a fresh position + order read (the same inputs the stop-monitor
 * tick builds).  The reconcile resolves the intent when a stop rests again, the position closed,
 * or live exit orders cover it; otherwise the intent stays `restore_pending` for every later pass.
 * Never throws — a failure here must not mask the exit's own outcome.
 */
async function restoreProtectionAfterRelease(run: ExitStopReleaseRun, symbol: string, phase: "exit_submitted" | "restore_pending"): Promise<void> {
  const { userId, accountNumber, gateway, policy, executionMode } = run;
  const connectedAccountId = run.connectedAccountId ?? policy.connectedAccountId;
  try {
    updateExitStopReleasePhase(userId, accountNumber, symbol, phase);
  } catch (err) {
    audit("exit_stop_release_bookkeeping_error", { symbol, error: errMsg(err), context: "mark_restore" }, userId, connectedAccountId);
  }
  try {
    const positions = await gateway.getEquityPositions(accountNumber);
    let orders: EquityOrder[] = [];
    let ordersListed = false;
    try {
      orders = await gateway.getEquityOrders(accountNumber);
      ordersListed = true;
    } catch {
      ordersListed = false;
    }
    let extremePriceBySymbol: Record<string, number> = {};
    let stopPlanBySymbol: ReturnType<typeof filterStopPlansByLiveBasis> = {};
    try {
      extremePriceBySymbol = Object.fromEntries(listSyntheticStops(accountNumber, userId).map((s) => [normalizeSymbol(s.symbol), s.extremePrice]));
      stopPlanBySymbol = filterStopPlansByLiveBasis(getStopPlans(accountNumber, userId), positions);
    } catch {
      // Best-effort context, same as the stop-monitor tick: absent maps fall back to defaults.
    }
    await reconcileBrokerProtectiveStops({
      userId,
      policy,
      accountNumber,
      gateway,
      positions,
      executionMode,
      running: true,
      haltedProtectOnly: policy.systemState === "halted",
      orders,
      ordersListed,
      extremePriceBySymbol,
      stopPlanBySymbol
    });
  } catch (err) {
    audit("exit_stop_release_restore_error", { symbol, error: errMsg(err), note: "restore retries on the next protective-stop pass" }, userId, connectedAccountId);
  }
  try {
    const pending = getExitStopReleaseIntent(userId, accountNumber, symbol);
    if (pending) {
      audit(
        "exit_stop_release_remainder_unprotected",
        {
          symbol,
          side: run.plan.side,
          lane: run.lane,
          proposalId: run.proposalId,
          phase: pending.phase,
          note: "no broker-held stop rests on the remaining shares yet; every protective-stop pass retries until one does or the position closes"
        },
        userId,
        connectedAccountId
      );
    }
  } catch {
    // Reading the intent back is informational only.
  }
}
