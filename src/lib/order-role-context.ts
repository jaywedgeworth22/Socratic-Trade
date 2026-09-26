/**
 * DB-backed half of `order-role.ts`'s classifier — SERVER ONLY. Split out of `order-role.ts` so
 * that file can stay a pure module `app/console/orders/page.tsx` (a "use client" component) can
 * import for `ORDER_ROLE_LABELS` / `type OrderRole` without dragging the DB layer into the client
 * bundle (`next build` failed with "You're importing a module that depends on 'server-only'"
 * once this file's `getDb`/`order-provenance.ts` imports lived in the same module as those
 * client-safe exports — see `order-role.ts`'s top comment for the full story).
 *
 * `loadOrderRoleContexts` does the DB reads (reusing `order-provenance.ts`'s
 * `isAppPlacedBrokerOrder` — see that file for why a nonempty broker `client_order_id` alone is
 * never enough) and builds the per-order `ctx` inputs that `order-role.ts`'s pure
 * `classifyOrderRole` classifies against. `attachOrderRoles` is the one-call convenience both
 * `dashboard.ts` (console Orders screen — the snapshot `GET /api/dashboard` returns, which is
 * exactly what the client renders `role`/`whyResting` from) and `ops-snapshot.ts`
 * (`ordersDetail=1`) use so the two surfaces can never classify the same order two different
 * ways.
 */

import "server-only";
import { isWorkingOrderState } from "./broker-held-orders";
import { isBracketOrderClass } from "./broker-side";
import { getDb } from "./db";
import { classifyOrderRole, type OrderRoleContext } from "./order-role";
import { type AppPlacedLookup, isAppPlacedBrokerOrder } from "./order-provenance";
import type { EquityOrder, OrderRole } from "./types";

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
  orders: ReadonlyArray<Pick<EquityOrder, "id" | "clientOrderId" | "symbol" | "orderClass">>,
  lookup: AppPlacedLookup
): Map<string, OrderRoleContext> {
  const contexts = new Map<string, OrderRoleContext>();
  if (orders.length === 0 || !lookup.accountNumber) return contexts;

  // Side-agnostic bracket entry-vs-exit-leg signal (see OrderRoleContext.bracketSiblingWorkingCount
  // and classifyOrderRole's bracket branch): count, per symbol, how many of THESE working orders
  // are bracket-family. A real Alpaca bracket only ever has 1 working bracket-class order for a
  // symbol before the entry fills, and exactly 2 (the OCO exit pair) after — so "how many bracket
  // siblings does this order have" tells entry from exit regardless of long/short side semantics.
  const bracketWorkingCountBySymbol = new Map<string, number>();
  for (const order of orders) {
    if (!isBracketOrderClass(order.orderClass)) continue;
    const key = order.symbol;
    bracketWorkingCountBySymbol.set(key, (bracketWorkingCountBySymbol.get(key) ?? 0) + 1);
  }

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
      appPlaced,
      bracketSiblingWorkingCount: isBracketOrderClass(order.orderClass)
        ? (bracketWorkingCountBySymbol.get(order.symbol) ?? 1) - 1
        : undefined
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
