import { audit, getInternalSetting, setInternalSetting } from "./db";
import { DEFAULT_POLICY } from "./defaults";
import { isWorkingOrderState } from "./broker-held-orders";
import { isContingentOrderLeg } from "./order-provenance";
import { normalizeSymbol } from "./money";
import { shortOrderLabel } from "./order-labels";
import { sendNotification } from "./notifications";
import { sqliteYieldRetry, yieldIfDue } from "./sqlite-event-loop";
import { yieldEventLoop } from "./slow-sync-guard";
import type { EquityOrder, TradingPolicy } from "./types";

const LIMIT_ORDER_TYPES = new Set(["limit", "stop_limit"]);

export interface StaleLimitOrder {
  order: EquityOrder;
  ageMinutes: number;
  thresholdMinutes: number;
  remainingQuantity: number;
}

export function staleLimitOrderThresholdMinutes(policy: Pick<TradingPolicy, "staleLimitOrderMinutes">): number {
  const threshold = policy.staleLimitOrderMinutes ?? DEFAULT_POLICY.staleLimitOrderMinutes ?? 15;
  return Number.isFinite(threshold) && threshold > 0 ? threshold : 0;
}

export function listStaleLimitOrders(
  orders: EquityOrder[],
  policy: Pick<TradingPolicy, "staleLimitOrderMinutes">,
  now: Date = new Date(),
  options: { brokerEvidenceOnly?: boolean } = {}
): StaleLimitOrder[] {
  const thresholdMinutes = staleLimitOrderThresholdMinutes(policy);
  if (thresholdMinutes <= 0) return [];

  const nowMs = now.getTime();
  return orders.flatMap((order) => {
    if (!LIMIT_ORDER_TYPES.has(String(order.type ?? "").toLowerCase())) return [];
    if (!isWorkingOrderState(order.state)) return [];

    // P2.7: Measure staleness from bracket-leg ACTIVATION not createdAt.
    // Bracket exits are created with the entry order but only activate when the entry fills.
    // Broker updates the order (bumping updatedAt) on state change (e.g., held -> new).
    // So updatedAt accurately measures how long the exit has been WORKING.
    // An ACTIVATED contingent leg (bracket/OCO/OTO member, not held) with no updatedAt has an
    // unknown activation time: its createdAt is the PARENT's placement time, not its activation,
    // so never guess it stale from createdAt (the 2026-07-08 PG take-profit leg was flagged stale
    // 15 minutes after the unfilled entry was placed).  Held legs stay listed (order-replacement
    // needs to see them to return the held-leg 409); the alert and auto path skip them.
    const isHeld = String(order.state ?? "").trim().toLowerCase() === "held";
    if (!isHeld && !order.updatedAt && isContingentOrderLeg(order, orders, options)) return [];
    const createdMs = order.updatedAt ? Date.parse(order.updatedAt) : Date.parse(order.createdAt);
    if (!Number.isFinite(createdMs) || createdMs > nowMs) return [];

    const quantity = order.quantity ?? 0;
    const filledQuantity = order.filledQuantity ?? 0;
    const remainingQuantity = Math.max(quantity - filledQuantity, 0);
    if (remainingQuantity <= 0) return [];

    const ageMinutes = Math.floor((nowMs - createdMs) / 60_000);
    if (ageMinutes < thresholdMinutes) return [];

    return [{ order, ageMinutes, thresholdMinutes, remainingQuantity }];
  });
}

export async function notifyStaleLimitOrders(input: {
  userId?: string;
  policy: TradingPolicy;
  orders: EquityOrder[];
  now?: Date;
}): Promise<{ alerted: number; stale: StaleLimitOrder[] }> {
  const userId = input.userId ?? "local";
  const stale = listStaleLimitOrders(input.orders, input.policy, input.now ?? new Date());
  let alerted = 0;
  const yieldClock = { ms: Date.now() };
  await yieldEventLoop();

  for (const item of stale) {
    // Never alert on an unactivated bracket exit leg — see isHeldExitLeg. (The leg stays in the
    // listing for order-replacement's held-leg 409; only the owner-facing alert is suppressed.)
    // Activated bracket legs (orderClass bracket/oco/oto, or a class-less leg recognised by its
    // bracket-class sibling in this same listing) are also not actionable auto-replace targets —
    // suppress the misleading "cancel/reprice before replacing with market" alert.
    if (isHeldExitLeg(item.order) || isContingentOrderLeg(item.order, input.orders)) continue;
    const key = staleLimitOrderAlertKey(userId, input.policy, item);
    if (await sqliteYieldRetry(() => getInternalSetting(key))) continue;

    const symbol = normalizeSymbol(item.order.symbol);
    const side = String(item.order.side ?? "order").toUpperCase();
    const title = `${symbol} ${side} limit order still working`;
    const summary =
      `${symbol} ${side} ${item.order.type} order ${shortOrderLabel(item.order.id)} is still open after ` +
      `${item.ageMinutes} minutes (${formatQuantity(item.remainingQuantity)} remaining). ` +
      "Review the order; cancel/reprice it before replacing it with a market order.";

    await sqliteYieldRetry(() =>
      audit(
        "limit_order_stale",
        {
          orderId: item.order.id,
          symbol,
          side: item.order.side,
          type: item.order.type,
          state: item.order.state,
          createdAt: item.order.createdAt,
          ageMinutes: item.ageMinutes,
          thresholdMinutes: item.thresholdMinutes,
          quantity: item.order.quantity,
          filledQuantity: item.order.filledQuantity ?? 0,
          remainingQuantity: item.remainingQuantity,
          summary
        },
        userId,
        input.policy.connectedAccountId
      )
    );

    await sendNotification(
      {
        type: "limit_order_stale",
        title,
        payload: {
          summary,
          order: item.order,
          ageMinutes: item.ageMinutes,
          thresholdMinutes: item.thresholdMinutes,
          remainingQuantity: item.remainingQuantity
        }
      },
      { policy: input.policy, userId }
    );
    await sqliteYieldRetry(() =>
      setInternalSetting(key, { alertedAt: new Date().toISOString(), orderId: item.order.id })
    );
    alerted += 1;
    await yieldIfDue(yieldClock);
  }

  return { alerted, stale };
}

/**
 * A bracket/OCO/OTO exit leg sits in Alpaca's "held" state until its sibling entry order fills.
 * It cannot execute yet, so the stale-limit ALERT ("cancel/reprice or replace with a market
 * order") is wrong advice and the leg's age is not actionable — suppress the alert for it.
 *
 * This is deliberately NOT done inside `listStaleLimitOrders`/`isWorkingOrderState`: that listing
 * is a shared primitive `order-replacement.ts` relies on to still SEE a held leg so it can reject
 * a manual market-replace with the correct held-leg 409 (and its auto path skips held itself).
 * Once the entry fills, the broker transitions the leg (held -> new) and bumps `updatedAt`, so the
 * leg reappears here and its age-from-activation is measured correctly.
 */
function isHeldExitLeg(order: EquityOrder): boolean {
  return String(order.state ?? "").trim().toLowerCase() === "held";
}

function staleLimitOrderAlertKey(userId: string, policy: TradingPolicy, item: StaleLimitOrder): string {
  const accountKey = policy.connectedAccountId ?? policy.accountNumber ?? "base";
  return `stale_limit_order_alert:${userId}:${accountKey}:${item.order.id}:${item.thresholdMinutes}`;
}

function formatQuantity(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(6).replace(/\.?0+$/, "");
}
