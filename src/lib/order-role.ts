/**
 * Classifies WHY a resting broker order exists, so the ops snapshot and the console Orders
 * screen can say more than "open order" — the concrete owner report this exists for: four
 * resting Alpaca-paper orders (BAC, BRK-B, KO, PYPL) turned out to be correct, app-placed
 * protective stops (`broker_protective_stops`, status "resting"), but nothing in the ops
 * snapshot or the UI said so.
 *
 * `classifyOrderRole` is pure — it never touches the database. `loadOrderRoleContexts` does the
 * DB reads (reusing `order-provenance.ts`'s `isAppPlacedBrokerOrder` — see that file for why a
 * nonempty broker `client_order_id` alone is never enough) and builds the per-order `ctx` inputs.
 * `attachOrderRoles` is the one-call convenience both `dashboard.ts` (console Orders screen) and
 * `ops-snapshot.ts` (`ordersDetail=1`) use so the two surfaces can never classify the same order
 * two different ways.
 */

import { isWorkingOrderState } from "./broker-held-orders";
import { isBracketOrderClass } from "./broker-side";
import { getDb } from "./db";
import { type AppPlacedLookup, isAppPlacedBrokerOrder } from "./order-provenance";
import type { EquityOrder, OrderRole } from "./types";

export type { OrderRole } from "./types";

const PROTECTIVE_STOP_PREFIX = "protstop-";
const SYNTHETIC_STOP_PREFIX = "sstop-";

/** Title Case labels for console badges / any other UI surface — single source of truth so the
 *  badge text can never drift from the role the classifier actually returned. */
export const ORDER_ROLE_LABELS: Record<OrderRole, string> = {
  protective_stop: "Protective Stop",
  trailing_stop: "Trailing Stop",
  bracket_take_profit: "Take-Profit Leg",
  bracket_stop_loss: "Stop-Loss Leg",
  entry: "Entry",
  exit: "Exit",
  synthetic_stop: "Synthetic Stop",
  replacement: "Replacement",
  external: "External"
};

export interface OrderRoleProtectiveStopInfo {
  kind: "fixed" | "trailing";
  stopPrice?: number;
  trailPercent?: number;
}

export interface OrderRoleSyntheticStopInfo {
  trailPercent?: number;
}

export interface OrderRoleReplacementInfo {
  status: string;
}

export interface OrderRoleContext {
  /** Present when a `broker_protective_stops` row's `broker_order_id` matches this order
   *  (or, absent a row, when the order's own `protstop-` client_order_id prefix matches — the
   *  fallback loses the precise stop price / trail percent but still classifies correctly). */
  protectiveStop?: OrderRoleProtectiveStopInfo;
  /** Present when a `synthetic_trailing_stops` row's `last_attempt_ref_id` matches this order's
   *  client_order_id (or, absent a row, the `sstop-` prefix fallback). */
  syntheticStop?: OrderRoleSyntheticStopInfo;
  /** Present when an `order_replacements` row's replacement leg (by order id or ref id) is this
   *  order and the replacement actually reached the broker (`replacement_submitted` /
   *  `replacement_confirmed`). */
  replacement?: OrderRoleReplacementInfo;
  /** The general "the app placed and is tracking this order" signal — `order-provenance.ts`'s
   *  `isAppPlacedBrokerOrder` (a trade-proposal ref_id, stop-placement intent, synthetic-stop
   *  attempt, replacement, or protective-stop row). Drives the entry/exit vs. external fallback
   *  once the more specific roles above don't match. */
  appPlaced: boolean;
}

export interface OrderRoleClassification {
  role: OrderRole;
  /** One sentence, owner-facing: what this order is and what has to happen for it to stop
   *  resting. Never invents a price/percent that isn't in `ctx` — falls back to a generic
   *  "rests until it fills at the broker" style close when the specific level isn't known. */
  whyResting: string;
}

type ClassifiableOrder = Pick<EquityOrder, "symbol" | "side" | "type" | "quantity" | "orderClass" | "clientOrderId">;

function isOpeningSide(side: string): boolean {
  return side === "buy" || side === "short";
}

/** A stop protecting a LONG (exits with a sell) triggers when price falls; a stop protecting a
 *  SHORT (exits with a buy/cover — brokers that infer open/close from the position report a
 *  short's cover as a raw "buy", src/lib/broker-side.ts toBrokerSide) triggers when price rises. */
function moveVerb(side: string): "falls" | "rises" {
  return side === "sell" ? "falls" : "rises";
}

function trimmedNumber(value: number): string {
  const rounded = Math.round(value * 10_000) / 10_000;
  return Number.isInteger(rounded) ? String(rounded) : String(rounded);
}

function formatPercent(pct: number): string {
  return `${trimmedNumber(pct)}%`;
}

function formatMoney(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

/** "24 BAC" when a share quantity is known, else just the symbol — never invents a quantity for
 *  a dollar-notional order. */
function subjectPhrase(order: ClassifiableOrder): string {
  const symbol = order.symbol?.trim() || "this symbol";
  const qty = order.quantity;
  if (typeof qty === "number" && Number.isFinite(qty) && qty > 0) {
    return `${trimmedNumber(qty)} ${symbol}`;
  }
  return symbol;
}

function clientOrderIdPrefix(order: ClassifiableOrder): string {
  return String(order.clientOrderId ?? "").trim().toLowerCase();
}

/**
 * Pure classifier. Precedence (most specific tracked role first, broker-reported bracket
 * membership next, then the general app-placed / external fallback):
 *   1. protective_stop / trailing_stop — broker_protective_stops row (or protstop- prefix).
 *   2. synthetic_stop — synthetic_trailing_stops row (or sstop- prefix).
 *   3. replacement — a live order_replacements row's replacement leg.
 *   4. bracket_take_profit / bracket_stop_loss / entry — order_class is a bracket family and the
 *      order is the not-yet-filled entry (opening side) or one of the two exit legs.
 *   5. entry / exit — any other app-tracked order (isAppPlacedBrokerOrder), by opening/closing side.
 *   6. external — nothing above matched.
 */
export function classifyOrderRole(order: ClassifiableOrder, ctx: OrderRoleContext): OrderRoleClassification {
  const subject = subjectPhrase(order);
  const clientOrderId = clientOrderIdPrefix(order);

  if (ctx.protectiveStop || clientOrderId.startsWith(PROTECTIVE_STOP_PREFIX)) {
    const info = ctx.protectiveStop;
    if (info?.kind === "trailing") {
      const pctClause =
        typeof info.trailPercent === "number" && info.trailPercent > 0 ? ` ${formatPercent(info.trailPercent)}` : "";
      return {
        role: "trailing_stop",
        whyResting: `Protective trailing stop for ${subject}; rests until price ${moveVerb(order.side)}${pctClause}.`
      };
    }
    const atClause =
      typeof info?.stopPrice === "number" && info.stopPrice > 0 ? ` at ${formatMoney(info.stopPrice)}` : "";
    return {
      role: "protective_stop",
      whyResting: `Protective stop for ${subject}${atClause}; rests until price ${moveVerb(order.side)} to that level.`
    };
  }

  if (ctx.syntheticStop || clientOrderId.startsWith(SYNTHETIC_STOP_PREFIX)) {
    return {
      role: "synthetic_stop",
      whyResting: `App-managed synthetic trailing-stop trigger for ${subject}; rests until it fills at the broker.`
    };
  }

  if (ctx.replacement) {
    return {
      role: "replacement",
      whyResting: `Automatic replacement for a stale limit order on ${subject}; rests until it fills at the broker.`
    };
  }

  if (isBracketOrderClass(order.orderClass)) {
    if (isOpeningSide(order.side)) {
      return {
        role: "entry",
        whyResting: `Entry leg of a bracket order for ${subject}; rests until the market reaches its price.`
      };
    }
    if (order.type === "limit") {
      return {
        role: "bracket_take_profit",
        whyResting: `Take-profit leg of a bracket order for ${subject}; rests until price reaches that level.`
      };
    }
    return {
      role: "bracket_stop_loss",
      whyResting: `Stop-loss leg of a bracket order for ${subject}; rests until price ${moveVerb(order.side)} to that level.`
    };
  }

  if (ctx.appPlaced) {
    return isOpeningSide(order.side)
      ? { role: "entry", whyResting: `Entry order for ${subject}; rests until it fills at the broker.` }
      : { role: "exit", whyResting: `Exit order for ${subject}; rests until it fills at the broker.` };
  }

  return {
    role: "external",
    whyResting: `Placed outside the app's own order-tracking (e.g. directly at the broker) for ${subject}; rests until it fills or is cancelled there.`
  };
}

interface ProtectiveStopRow {
  broker_order_id: string;
  kind: string;
  stop_price: number;
  trail_percent: number | null;
}

interface SyntheticStopRow {
  last_attempt_ref_id: string;
  trail_percent: number | null;
}

interface ReplacementRow {
  replacement_order_id: string | null;
  replacement_ref_id: string;
  status: string;
}

/**
 * DB-backed context builder — NOT pure. One query per tracking table, scoped to the account, so
 * classifying N working orders costs 3 queries total rather than N. Best-effort: a DB read
 * failure (e.g. a locked file mid-write) degrades every order in this batch to whatever
 * `classifyOrderRole`'s prefix/bracket/appPlaced fallbacks can determine, rather than throwing
 * and losing the whole snapshot.
 */
export function loadOrderRoleContexts(
  orders: ReadonlyArray<Pick<EquityOrder, "id" | "clientOrderId">>,
  lookup: AppPlacedLookup
): Map<string, OrderRoleContext> {
  const contexts = new Map<string, OrderRoleContext>();
  if (orders.length === 0 || !lookup.accountNumber) return contexts;

  let protectiveStopRows: ProtectiveStopRow[] = [];
  let syntheticStopRows: SyntheticStopRow[] = [];
  let replacementRows: ReplacementRow[] = [];
  try {
    const db = getDb();
    protectiveStopRows = db
      .prepare(
        "SELECT broker_order_id, kind, stop_price, trail_percent FROM broker_protective_stops WHERE user_id = ? AND account_number = ?"
      )
      .all(lookup.userId, lookup.accountNumber) as ProtectiveStopRow[];
    syntheticStopRows = db
      .prepare(
        "SELECT last_attempt_ref_id, trail_percent FROM synthetic_trailing_stops WHERE user_id = ? AND account_number = ? AND last_attempt_ref_id IS NOT NULL"
      )
      .all(lookup.userId, lookup.accountNumber) as SyntheticStopRow[];
    replacementRows = db
      .prepare(
        "SELECT replacement_order_id, replacement_ref_id, status FROM order_replacements WHERE user_id = ? AND account_number = ? AND status IN ('replacement_submitted', 'replacement_confirmed')"
      )
      .all(lookup.userId, lookup.accountNumber) as ReplacementRow[];
  } catch {
    // Fall through with empty rows — classifyOrderRole's prefix/bracket/appPlaced fallbacks
    // still produce a reasonable (if less specific) role for every order in this batch.
  }

  const protectiveByOrderId = new Map(protectiveStopRows.map((row) => [row.broker_order_id, row]));
  const syntheticByRefId = new Map(syntheticStopRows.map((row) => [row.last_attempt_ref_id, row]));
  const replacementByOrderId = new Map<string, ReplacementRow>();
  const replacementByRefId = new Map<string, ReplacementRow>();
  for (const row of replacementRows) {
    if (row.replacement_order_id) replacementByOrderId.set(row.replacement_order_id, row);
    if (row.replacement_ref_id) replacementByRefId.set(row.replacement_ref_id, row);
  }

  for (const order of orders) {
    const clientOrderId = order.clientOrderId?.trim();
    const protectiveRow = protectiveByOrderId.get(order.id);
    const syntheticRow = clientOrderId ? syntheticByRefId.get(clientOrderId) : undefined;
    const replacementRow = replacementByOrderId.get(order.id) ?? (clientOrderId ? replacementByRefId.get(clientOrderId) : undefined);

    let appPlaced = false;
    try {
      appPlaced = isAppPlacedBrokerOrder(order, lookup);
    } catch {
      appPlaced = false;
    }

    contexts.set(order.id, {
      protectiveStop: protectiveRow
        ? {
            kind: protectiveRow.kind === "trailing" ? "trailing" : "fixed",
            stopPrice: protectiveRow.stop_price,
            trailPercent: protectiveRow.trail_percent ?? undefined
          }
        : undefined,
      syntheticStop: syntheticRow ? { trailPercent: syntheticRow.trail_percent ?? undefined } : undefined,
      replacement: replacementRow ? { status: replacementRow.status } : undefined,
      appPlaced
    });
  }
  return contexts;
}

/**
 * One-call convenience: classify every WORKING order in `orders` and return a new array with
 * `role`/`whyResting` attached (terminal/history orders pass through unchanged — "why is it
 * resting" has no meaning once an order is done). Used by both `dashboard.ts` (console Orders
 * screen) and `ops-snapshot.ts` (`ordersDetail=1`) so the two surfaces share one classification.
 */
export function attachOrderRoles<T extends EquityOrder>(orders: T[], userId: string, accountNumber: string): T[] {
  if (!accountNumber) return orders;
  const workingOrders = orders.filter((order) => isWorkingOrderState(order.state));
  if (workingOrders.length === 0) return orders;
  const contexts = loadOrderRoleContexts(workingOrders, { userId, accountNumber });
  return orders.map((order) => {
    const ctx = contexts.get(order.id);
    if (!ctx) return order;
    const { role, whyResting } = classifyOrderRole(order, ctx);
    return { ...order, role, whyResting };
  });
}

/** Cap on `buildOpsWorkingOrderDetails`'s per-account output — an ops snapshot is a diagnostic
 *  read, not a full order dump; 100 working orders is far beyond anything the app's own risk
 *  limits allow resting at once. */
export const OPS_ORDERS_DETAIL_MAX_PER_ACCOUNT = 100;

/** Per-order detail row for `/api/ops/snapshot?ordersDetail=1` and any future ops surface.
 *  Deliberately excludes `id`, `clientOrderId`, and the account number — the owner-facing ops
 *  snapshot is a diagnostic summary, not a place broker order ids or app-minted idempotency
 *  keys should leak. */
export interface OpsWorkingOrderDetail {
  symbol: string;
  side: string;
  type: string;
  orderClass: string | null;
  quantity: number | null;
  filledQuantity: number | null;
  limitPrice: number | null;
  stopPrice: number | null;
  /** From the tracked protective-stop / synthetic-stop row's trail_percent — never present on
   *  the raw broker order (Alpaca doesn't echo trail_percent back on a working trailing-stop
   *  order's own record), so this is the only place a trailing stop's distance is visible. */
  trailPercent: number | null;
  timeInForce: string | null;
  state: string;
  createdAt: string;
  updatedAt: string | null;
  role: OrderRole;
  whyResting: string;
}

/**
 * Classify every WORKING order in `orders` (capped at `OPS_ORDERS_DETAIL_MAX_PER_ACCOUNT`) into
 * the compact, owner-facing shape `/api/ops/snapshot?ordersDetail=1` returns. Non-working orders
 * are dropped entirely (a finished order has no "why is it resting" to report). Returns `[]`
 * when `accountNumber` is empty or there are no working orders — never throws (the same
 * best-effort contract as `attachOpsOrderSummaries`; a DB read failure inside
 * `loadOrderRoleContexts` degrades classification quality, it doesn't drop the row).
 */
export function buildOpsWorkingOrderDetails(
  orders: EquityOrder[],
  userId: string,
  accountNumber: string
): OpsWorkingOrderDetail[] {
  if (!accountNumber) return [];
  const workingOrders = orders
    .filter((order) => isWorkingOrderState(order.state))
    .slice(0, OPS_ORDERS_DETAIL_MAX_PER_ACCOUNT);
  if (workingOrders.length === 0) return [];
  const contexts = loadOrderRoleContexts(workingOrders, { userId, accountNumber });
  return workingOrders.map((order) => {
    const ctx = contexts.get(order.id) ?? { appPlaced: false };
    const { role, whyResting } = classifyOrderRole(order, ctx);
    const trailPercent = ctx.protectiveStop?.trailPercent ?? ctx.syntheticStop?.trailPercent;
    return {
      symbol: order.symbol,
      side: order.side,
      type: order.type,
      orderClass: order.orderClass ?? null,
      quantity: order.quantity ?? null,
      filledQuantity: order.filledQuantity ?? null,
      limitPrice: order.limitPrice ?? null,
      stopPrice: order.stopPrice ?? null,
      trailPercent: typeof trailPercent === "number" ? trailPercent : null,
      timeInForce: order.timeInForce ?? null,
      state: order.state,
      createdAt: order.createdAt,
      updatedAt: order.updatedAt ?? null,
      role,
      whyResting
    };
  });
}
