import { invalidateDashboardSnapshotCache } from "./dashboard-snapshot-cache";
import { peekBrokerMutationLease } from "./account-mutation";
import { describeCancelDustRisk, shouldAlertCancelDustRisk } from "./broker-minimum-guard";
import { isWorkingOrderState } from "./broker-held-orders";
import { audit, deleteBrokerProtectiveStop, getPolicy, listBrokerProtectiveStops } from "./db";
import { getBrokerGateway } from "./broker";
import { emitDashboardEvent } from "./events";
import { normalizeSymbol } from "./money";
import {
  isAppManagedProtectiveStopClientOrderId,
  recordOwnerCancelledProtectiveStop
} from "./order-provenance";
import { sendNotification } from "./notifications";
import type { BrokerGateway, EquityOrder, ExecutedOrder, TradingPolicy } from "./types";

/**
 * THE cancel path. Extracted verbatim from app/api/orders/cancel/route.ts so the web console, the
 * mobile command lane, and any future caller share ONE implementation — a second cancel written
 * against the gateway directly would drift from the lease receipt, the dust advisory, the audit
 * trail, and the dashboard event that this one carries.
 *
 * Doctrine preserved from the route (do not "improve" these away):
 * - A standalone cancel NEVER waits on the account mutation lease. It can only free buying power,
 *   so it proceeds through someone else's window and receipts the interleave instead.
 * - The pre-cancel broker read is ADVISORY and time-bounded. A hung or failing read must never
 *   delay or block the cancel itself.
 * - `dustWarning` never gates the cancel; it is attached to the result after the fact.
 */

/** How long the advisory pre-cancel broker read may take before the cancel proceeds without it. */
const CANCEL_LOOKUP_TIMEOUT_MS = 2_500;

export class OrderCancelPreconditionError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "OrderCancelPreconditionError";
    this.status = status;
  }
}

export interface CancelWorkingOrderResult extends ExecutedOrder {
  /** Advisory only. Present does NOT mean the cancel failed — it always executed. */
  dustWarning?: string;
  /** Broker symbol of the cancelled order when the advisory read resolved in time. */
  symbol?: string;
}

export interface CancelWorkingOrderInput {
  userId: string;
  orderId: string;
  /**
   * The account the CALLER believed it was acting on. When supplied it must equal the account
   * currently selected for this user, otherwise the cancel is refused. This is the stale-view
   * guard for asynchronous clients (a phone that queued a cancel while looking at account A, then
   * switched to account B, must not have its cancel land on B).
   */
  expectedAccountNumber?: string;
  /**
   * Resolve the order inside the selected account before cancelling and refuse when it is absent
   * or no longer working. Used by the mobile lane, whose failures are read later as text on a
   * phone and therefore have to say something true; the console sheet renders only live rows from
   * the account currently on screen and keeps the unconditional emergency-lever behaviour.
   *
   * Fail-open by construction: if the advisory read times out or errors there is nothing to verify
   * against, and the cancel proceeds. Account isolation does not depend on this flag — it is
   * enforced unconditionally by scoping every cancel to the requesting user's own selected account
   * and their own broker credentials.
   */
  requireWorkingOrder?: boolean;
  /** Receipt-only label for where the cancel came from. */
  source?: "console" | "mobile";
}

interface CancelLookup {
  order?: EquityOrder;
  dust?: { warning: string; symbol: string };
  /** True when the advisory read timed out or threw — nothing was learned either way. */
  unavailable: boolean;
}

/**
 * Best-effort pre-cancel read (r2 lesson: freqtrade). Fetches the resting orders + positions so
 * `describeCancelDustRisk` can warn when cancelling a partially-filled entry would strand the
 * already-filled shares below the broker's minimum order size, and so callers that asked for it
 * can confirm the order is really in this account and still working. Never throws.
 */
async function lookupCancelContext(
  gateway: BrokerGateway,
  accountNumber: string,
  orderId: string,
  activeBroker: TradingPolicy["activeBroker"]
): Promise<CancelLookup> {
  try {
    const [orders, positions] = await Promise.all([
      gateway.getEquityOrders(accountNumber),
      gateway.getEquityPositions(accountNumber)
    ]);
    const order = orders.find((candidate) => candidate.id === orderId);
    if (!order) return { unavailable: false };
    const symbol = normalizeSymbol(order.symbol);
    const position = positions.find((candidate) => normalizeSymbol(candidate.symbol) === symbol);
    // Implied current price from the position's own market value — no separate quote fetch, and
    // consistent with how planBrokerMinimumBump derives a price from held position value.
    const currentPrice = position && position.quantity !== 0 ? Math.abs(position.marketValue / position.quantity) : undefined;
    const warning = describeCancelDustRisk(
      {
        side: order.side,
        quantity: order.quantity,
        dollarAmount: order.dollarAmount,
        filledQuantity: order.filledQuantity,
        averagePrice: order.averagePrice,
        currentPrice,
        symbol: order.symbol
      },
      position?.quantity,
      activeBroker
    );
    return { order, dust: warning ? { warning, symbol } : undefined, unavailable: false };
  } catch {
    return { unavailable: true };
  }
}

export async function cancelWorkingOrder(input: CancelWorkingOrderInput): Promise<CancelWorkingOrderResult> {
  const { userId, source = "console" } = input;
  const policy = getPolicy(userId);
  if (!policy.accountNumber) throw new OrderCancelPreconditionError("No selected account.", 400);
  const orderId = String(input.orderId ?? "").trim();
  if (!orderId) throw new OrderCancelPreconditionError("orderId is required.", 400);
  // Account isolation, enforced unconditionally: the cancel is scoped to the account currently
  // selected for THIS user, through a gateway resolved from THIS user's own stored credentials.
  // A caller that names a different account is refused outright rather than silently re-pointed.
  if (input.expectedAccountNumber && input.expectedAccountNumber !== policy.accountNumber) {
    audit(
      "order_cancel_account_mismatch",
      { requestedAccountNumber: input.expectedAccountNumber, selectedAccountNumber: policy.accountNumber, orderId, source },
      userId,
      policy.connectedAccountId
    );
    throw new OrderCancelPreconditionError(
      "That order belongs to a different account than the one selected now.  Switch back to it and try again.",
      409
    );
  }

  // §7 slice 3 cancel doctrine: a standalone cancel is the operator's emergency lever and NEVER
  // waits behind the account mutation lease — it can only free buying power. If it fires while
  // another sequence holds the lease, receipt the interleave so it is visible, then proceed.
  const heldBy = peekBrokerMutationLease(userId, policy.accountNumber, policy.connectedAccountId);
  if (heldBy) {
    audit(
      "broker_mutation_cancel_during_lease",
      { accountNumber: policy.accountNumber, orderId, activeOperation: heldBy.operation },
      userId,
      policy.connectedAccountId
    );
  }

  const gateway = getBrokerGateway(policy, userId);
  // Time-bound the advisory pre-fetch: the cancel must never wait behind a hung broker READ.
  // If the reads don't answer quickly, skip the advisory and cancel immediately.
  const lookup = await Promise.race([
    lookupCancelContext(gateway, policy.accountNumber, orderId, policy.activeBroker),
    new Promise<CancelLookup>((resolve) => setTimeout(() => resolve({ unavailable: true }), CANCEL_LOOKUP_TIMEOUT_MS))
  ]);

  if (input.requireWorkingOrder) {
    if (lookup.unavailable) {
      // Nothing was learned, so there is nothing to refuse on. Say so in the receipt rather than
      // letting a silent fall-through look like a verified cancel.
      audit(
        "order_cancel_precheck_unavailable",
        { accountNumber: policy.accountNumber, orderId, source },
        userId,
        policy.connectedAccountId
      );
    } else if (!lookup.order) {
      throw new OrderCancelPreconditionError(
        "That order is not open in the selected account.  It may have already filled, or been cancelled elsewhere.",
        404
      );
    } else if (!isWorkingOrderState(lookup.order.state)) {
      throw new OrderCancelPreconditionError(
        `That order is no longer working (${lookup.order.state}).  There is nothing left to cancel.`,
        409
      );
    }
  }

  const dust = lookup.dust;
  if (dust) {
    audit(
      "order_cancel_dust_risk",
      { accountNumber: policy.accountNumber, orderId, symbol: dust.symbol, warning: dust.warning },
      userId,
      policy.connectedAccountId
    );
  }
  // ADVISORY ONLY — the cancel always executes regardless of `dust`. Cancel is the operator's
  // emergency lever and must never be blocked or delayed by this warning.
  //
  // The pre-cancel read is advisory and may time out, throw, or miss a working GTC stop
  // that is still cancellable by id.  The tracked broker_protective_stops row already
  // has the symbol — use it so an owner cancel still writes the do-not-replace tombstone.
  const managedStopRow = listBrokerProtectiveStops(policy.accountNumber, userId).find((row) => row.brokerOrderId === orderId);
  const cancelledSymbol = lookup.order
    ? normalizeSymbol(lookup.order.symbol)
    : managedStopRow
      ? normalizeSymbol(managedStopRow.symbol)
      : undefined;
  const managedStopClientOrderId = lookup.order?.clientOrderId;
  const tombstoneSymbol =
    cancelledSymbol
    && (managedStopRow || isAppManagedProtectiveStopClientOrderId(managedStopClientOrderId))
      ? cancelledSymbol
      : undefined;

  let result: ExecutedOrder;
  try {
    result = await gateway.cancelEquityOrder(policy.accountNumber, orderId);
  } catch (err) {
    // #2886 deadlines can throw after the broker already accepted the cancel.
    // Persist the do-not-replace tombstone from owner intent; leave the tracked
    // row so a still-live stop is not orphaned if the cancel did not land.
    if (tombstoneSymbol) {
      recordOwnerCancelledProtectiveStop(userId, policy.accountNumber, tombstoneSymbol);
      audit(
        "owner_cancelled_protective_stop",
        {
          accountNumber: policy.accountNumber,
          orderId,
          symbol: tombstoneSymbol,
          source,
          brokerStopRowId: managedStopRow?.id,
          cancelError: err instanceof Error ? err.message : String(err)
        },
        userId,
        policy.connectedAccountId
      );
    }
    throw err;
  }
  if (tombstoneSymbol) {
    recordOwnerCancelledProtectiveStop(userId, policy.accountNumber, tombstoneSymbol);
    if (managedStopRow) deleteBrokerProtectiveStop(managedStopRow.id, userId);
    audit(
      "owner_cancelled_protective_stop",
      { accountNumber: policy.accountNumber, orderId, symbol: tombstoneSymbol, source, brokerStopRowId: managedStopRow?.id },
      userId,
      policy.connectedAccountId
    );
  }
  audit("order_cancel", { accountNumber: policy.accountNumber, orderId, result, source }, userId);

  if (cancelledSymbol) {
    const { listOpenBracketOrders, enqueueTeardownForAllOpenBrackets } = await import("./db-api-keys");
    const openBrackets = listOpenBracketOrders(policy.accountNumber, cancelledSymbol, userId);
    if (openBrackets.length > 0) {
      // If a user manually cancels an order on a symbol with active brackets, we conservatively tear down
      // the sibling bracket legs. If they cancelled a take-profit or stop-loss leg, this cleans up the
      // other side immediately rather than waiting for background sweeps.
      enqueueTeardownForAllOpenBrackets(policy.accountNumber, cancelledSymbol, userId);
      audit("bracket_teardown_enqueued_from_manual_cancel", { accountNumber: policy.accountNumber, symbol: cancelledSymbol, orderId }, userId, policy.connectedAccountId);
      
      const { reconcilePendingBracketTeardowns } = await import("./broker-protective-stops");
      reconcilePendingBracketTeardowns(gateway, policy.accountNumber, userId, policy.connectedAccountId).catch((err) => {
        console.error(`reconcilePendingBracketTeardowns failed after manual cancel: ${err}`);
      });
    }
  }

  emitDashboardEvent({ type: "order", userId, at: new Date().toISOString(), detail: { orderId, action: "cancel" } });
  invalidateDashboardSnapshotCache(userId, policy.accountNumber);
  if (dust && shouldAlertCancelDustRisk(userId, policy.accountNumber, dust.symbol)) {
    await sendNotification(
      {
        type: "risk_advisory",
        title: `${dust.symbol} cancel may leave dust below the broker minimum`,
        payload: { reason: dust.warning, orderId, symbol: dust.symbol, accountNumber: policy.accountNumber }
      },
      { policy, userId }
    );
  }
  return { ...result, ...(dust ? { dustWarning: dust.warning } : {}), ...(cancelledSymbol ? { symbol: cancelledSymbol } : {}) };
}
