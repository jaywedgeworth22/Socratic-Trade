/**
 * DB-backed half of `order-role.ts`'s classifier — SERVER ONLY. Split out of `order-role.ts` so
 * that file can stay a pure module `app/console/orders/page.tsx` (a "use client" component) can
 * import for `ORDER_ROLE_LABELS` / `type OrderRole` without dragging the DB layer into the client
 * bundle (`next build` failed with "You're importing a module that depends on 'server-only'"
 * once this file's `getDb`/`order-provenance.ts` imports lived in the same module as those
 * client-safe exports — see `order-role.ts`'s top comment for the full story).
 *
 * `loadOrderRoleContexts` does the DB reads (batching the same app-placed signal
 * `order-provenance.ts`'s `isAppPlacedBrokerOrder` checks per order — see that file for why a
 * nonempty broker `client_order_id` alone is never enough — but only for orders a cheaper
 * protective/synthetic/replacement/bracket match didn't already resolve, and across the whole
 * account in a fixed number of queries rather than one scan per order) and builds the per-order
 * `ctx` inputs that `order-role.ts`'s pure `classifyOrderRole` classifies against.
 * `attachOrderRoles` is the one-call convenience both
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
import { CONTINGENT_SIBLING_WINDOW_MS, type AppPlacedLookup, isAppMintedClientOrderPrefix } from "./order-provenance";
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

interface RefIdRow {
  ref_id: string | null;
}

interface ClientOrderIdRow {
  client_order_id: string | null;
}

interface ReplacementIdentifierRow {
  replacement_order_id: string | null;
  replacement_ref_id: string | null;
}

/** True when two orders' broker-reported creation timestamps are close enough to have been
 *  created together as legs of one bracket/OTO/OCO (the same signal order-provenance.ts's
 *  `isContingentOrderLeg` uses via `CONTINGENT_SIBLING_WINDOW_MS`). Missing or unparseable
 *  timestamps fall back to "yes" — deliberately conservative, matching this codebase's existing
 *  bias (see `isContingentOrderLeg`'s own doc comment) toward over-grouping rather than losing a
 *  real sibling relationship when the data can't disambiguate. */
function wereCreatedTogether(aIso: string | undefined, bIso: string | undefined): boolean {
  if (!aIso || !bIso) return true;
  const a = Date.parse(aIso);
  const b = Date.parse(bIso);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return true;
  return Math.abs(a - b) <= CONTINGENT_SIBLING_WINDOW_MS;
}

/**
 * DB-backed context builder — NOT pure. Always issues 3 queries (one per tracking table) scoped
 * to the account, plus up to 3 more (trade_proposals / broker_stop_placement_intents /
 * order_replacements-all-statuses) ONLY when at least one order still needs the general
 * app-placed fallback after the cheaper protective/synthetic/replacement/bracket checks below —
 * so classifying N working orders costs at most 6 queries total, never N. Best-effort: a DB read
 * failure (e.g. a locked file mid-write) degrades every order in this batch to whatever
 * `classifyOrderRole`'s prefix/bracket/appPlaced fallbacks can determine, rather than throwing
 * and losing the whole snapshot.
 */
export function loadOrderRoleContexts(
  orders: ReadonlyArray<
    Pick<EquityOrder, "id" | "clientOrderId" | "symbol" | "orderClass"> & { createdAt?: string }
  >,
  lookup: AppPlacedLookup
): Map<string, OrderRoleContext> {
  const contexts = new Map<string, OrderRoleContext>();
  if (orders.length === 0 || !lookup.accountNumber) return contexts;

  // Side-agnostic bracket entry-vs-exit-leg signal (see OrderRoleContext.bracketSiblingWorkingCount
  // and classifyOrderRole's bracket branch): for each bracket-family order, count how many OTHER
  // bracket-family orders in this batch share its symbol AND were created within
  // CONTINGENT_SIBLING_WINDOW_MS of it. A real Alpaca bracket's own legs are always created
  // together within that window, so this tells entry from exit regardless of long/short side
  // semantics — WITHOUT also counting an unrelated, independent bracket group that happens to
  // rest on the same symbol at a different time (e.g. an existing position's resting exit pair
  // plus a brand-new scale-in entry's own bracket; src/lib/strategy.ts's scale-in support means a
  // symbol can legitimately carry two simultaneous, unrelated bracket-family order groups). Grouping
  // by bare symbol alone (the original implementation) would misread the fresh scale-in entry as an
  // exit leg of the older group.
  const bracketOrdersBySymbol = new Map<string, Array<{ id: string; createdAt?: string }>>();
  for (const order of orders) {
    if (!isBracketOrderClass(order.orderClass)) continue;
    const entry = { id: order.id, createdAt: order.createdAt };
    const list = bracketOrdersBySymbol.get(order.symbol);
    if (list) list.push(entry);
    else bracketOrdersBySymbol.set(order.symbol, [entry]);
  }
  function bracketSiblingCount(order: { id: string; symbol: string; createdAt?: string }): number {
    const list = bracketOrdersBySymbol.get(order.symbol);
    if (!list) return 0;
    return list.filter((sibling) => sibling.id !== order.id && wereCreatedTogether(sibling.createdAt, order.createdAt)).length;
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

  // classifyOrderRole only ever reads ctx.appPlaced in its FINAL fallback branch — every more
  // specific role (protective_stop/trailing_stop, including the pure module's own protstop-
  // client_order_id prefix fallback; synthetic_stop, including its own sstop- prefix fallback;
  // replacement; and every bracket-family role) returns before that point. So the up-to-5-query
  // isAppPlacedBrokerOrder scan is only ever NEEDED for an order none of the cheaper checks above
  // already resolved. Collect just those orders, then batch their lookup into 3 more queries total
  // (not 3 per order) — mirroring how protective/synthetic/replacement are already batched above.
  const needsAppPlaced: Array<{ id: string; clientOrderId: string }> = [];
  for (const order of orders) {
    if (isBracketOrderClass(order.orderClass)) continue;
    const clientOrderId = order.clientOrderId?.trim();
    if (!clientOrderId) continue; // no ref -> isAppPlacedBrokerOrder returns false without any DB read
    if (isAppMintedClientOrderPrefix(clientOrderId)) continue; // resolves true without any DB read
    if (protectiveByOrderId.has(order.id)) continue;
    if (syntheticByRefId.has(clientOrderId)) continue;
    if (replacementByOrderId.has(order.id) || replacementByRefId.has(clientOrderId)) continue;
    needsAppPlaced.push({ id: order.id, clientOrderId });
  }

  const appPlacedByOrderId = new Map<string, boolean>();
  if (needsAppPlaced.length > 0) {
    try {
      const db = getDb();
      const proposalRefs = new Set(
        (
          db
            .prepare("SELECT ref_id FROM trade_proposals WHERE user_id = ? AND account_number = ?")
            .all(lookup.userId, lookup.accountNumber) as RefIdRow[]
        )
          .map((row) => row.ref_id)
          .filter((ref): ref is string => Boolean(ref))
      );
      const intentRefs = new Set(
        (
          db
            .prepare("SELECT client_order_id FROM broker_stop_placement_intents WHERE user_id = ? AND account_number = ?")
            .all(lookup.userId, lookup.accountNumber) as ClientOrderIdRow[]
        )
          .map((row) => row.client_order_id)
          .filter((ref): ref is string => Boolean(ref))
      );
      // No status filter here (unlike replacementRows above, which is scoped to
      // submitted/confirmed for the "replacement" ROLE) — matches isAppPlacedBrokerOrder's own
      // original per-order semantics, which treated ANY order_replacements match as app-placed
      // regardless of status.
      const replacementIdentifiers = new Set<string>();
      for (const row of db
        .prepare("SELECT replacement_order_id, replacement_ref_id FROM order_replacements WHERE user_id = ? AND account_number = ?")
        .all(lookup.userId, lookup.accountNumber) as ReplacementIdentifierRow[]) {
        if (row.replacement_order_id) replacementIdentifiers.add(row.replacement_order_id);
        if (row.replacement_ref_id) replacementIdentifiers.add(row.replacement_ref_id);
      }
      for (const candidate of needsAppPlaced) {
        appPlacedByOrderId.set(
          candidate.id,
          proposalRefs.has(candidate.clientOrderId) ||
            intentRefs.has(candidate.clientOrderId) ||
            replacementIdentifiers.has(candidate.clientOrderId) ||
            replacementIdentifiers.has(candidate.id)
        );
      }
    } catch {
      // Best-effort, same contract as the protective/synthetic/replacement fetch above — a DB
      // failure degrades these orders to appPlaced=false rather than throwing.
    }
  }

  for (const order of orders) {
    const clientOrderId = order.clientOrderId?.trim();
    const protectiveRow = protectiveByOrderId.get(order.id);
    const syntheticRow = clientOrderId ? syntheticByRefId.get(clientOrderId) : undefined;
    const replacementRow = replacementByOrderId.get(order.id) ?? (clientOrderId ? replacementByRefId.get(clientOrderId) : undefined);

    let appPlaced = false;
    if (protectiveRow || syntheticRow || replacementRow || isBracketOrderClass(order.orderClass)) {
      // Never read by classifyOrderRole once one of these more specific roles matches — see the
      // comment above needsAppPlaced.
    } else if (clientOrderId && isAppMintedClientOrderPrefix(clientOrderId)) {
      appPlaced = true;
    } else if (clientOrderId) {
      appPlaced = appPlacedByOrderId.get(order.id) ?? false;
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
      bracketSiblingWorkingCount: isBracketOrderClass(order.orderClass) ? bracketSiblingCount(order) : undefined
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
