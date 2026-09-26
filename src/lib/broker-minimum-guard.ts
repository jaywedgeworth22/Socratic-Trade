// broker-minimum-guard.ts — pre-flight guard for orders that are GUARANTEED to be rejected for
// landing below the active broker's minimum dollar-based/fractional order size.
//
// Root cause this exists for (2026-07-08): the live Robinhood "Agentic" account (~$4-5 NAV) tried
// an AAPL concentration trim every hour, forever. Sizing (maxOrderPctOfNav) clamped each trim to
// ~$0.20-0.23 — always under Robinhood's $1 minimum — so `placeEquityOrder` rejected it every time,
// producing a `run_failed` alert 11x/day with no end in sight. Robinhood's own `review_equity_order`
// pre-flight already announced this in advance (`order_checks.alertType` ==
// EQUITY_DOLLAR_BASED_MINIMUM_AMOUNT_ERROR / EQUITY_SUB_DOLLAR_SHARE_BASED_ORDER — parsed into
// `ReviewedOrder.preflightBlock` by robinhood.ts) but nothing read it before this module.
//
// This is a CORRECTNESS fix, not a paternalistic cap: it only ever intercepts an order the broker
// has already told us (or that basic sizing math tells us) cannot possibly succeed at its current
// notional. It never blocks a valid order, and it carries no opinion on whether the underlying
// trim/rebalance idea is good — the owner can still raise the trim size, trim manually, or ignore it.
import { getInternalSetting, setInternalSetting } from "./db";
import { ROBINHOOD_MIN_ORDER_NOTIONAL } from "./robinhood";
import type { OrderSide, ReviewedOrder, TradingPolicy } from "./types";

/**
 * Known per-broker minimum dollar-based/fractional equity order size. Brokers with no known floor
 * are simply absent — the guard is a no-op for them rather than guessing a number. Sourced from
 * each broker's own named constant (never a re-hardcoded magic number here).
 */
const BROKER_MIN_ORDER_NOTIONAL: Partial<Record<NonNullable<TradingPolicy["activeBroker"]>, number>> = {
  robinhood: ROBINHOOD_MIN_ORDER_NOTIONAL
};

/** The per-broker minimum order notional for `activeBroker`, or undefined when none is known. */
export function brokerMinOrderNotional(activeBroker: TradingPolicy["activeBroker"]): number | undefined {
  if (!activeBroker) return undefined;
  return BROKER_MIN_ORDER_NOTIONAL[activeBroker];
}

/**
 * A whole-share (integer quantity >= 1) order is placed and sized in shares, not dollars, so a
 * broker's dollar/fractional minimum does not apply to it even if the resulting notional happens to
 * be small (e.g. one share of a sub-$1 stock). Only dollar-amount or fractional-quantity orders are
 * candidates for the notional-floor fallback below.
 */
function isFractionalOrDollarBased(order: { quantity?: number; dollarAmount?: number }): boolean {
  const wholeShare = order.quantity != null && Number.isInteger(order.quantity) && order.quantity >= 1;
  if (wholeShare) return false;
  return (order.dollarAmount != null && order.dollarAmount > 0) || (order.quantity != null && order.quantity > 0);
}

// Float-quantity comparison tolerance for "does this order's quantity match the FULL held
// position" — fractional share quantities carried through a broker/portfolio snapshot can differ
// by a tiny rounding amount even when they represent the same "whole position."
const FULL_POSITION_QTY_EPSILON = 1e-6;

/**
 * True when `order` is a sell/cover whose `quantity` matches the caller-supplied
 * `positionQuantity` (the account's currently held quantity for this symbol) within
 * FULL_POSITION_QTY_EPSILON — i.e. an order that closes the ENTIRE position rather than a partial
 * trim.
 *
 * CORRECTED 2026-09-25 (board 687a5fb4, lane G3): this used to also EXEMPT a matching order from
 * describeBrokerMinimumOrderBlock's own notional-floor fallback, on the assumption that "Robinhood
 * permits liquidating a whole fractional position regardless of its dollar value." Production
 * evidence on the live Robinhood "Agentic" account contradicts that: 11 `placing_failed` rejections
 * for "Fractional orders must be at least $1" and 8 for "Dollar-based orders must be at least $1" —
 * Robinhood's floor is unconditional, including for a full-position exit. Nothing in this codebase's
 * MCP usage (toMcpOrder/reviewEquityOrder in robinhood.ts) documents or exercises a special
 * sub-$1-full-exit path, so there is no verified way to place one. The exemption is REMOVED from
 * describeBrokerMinimumOrderBlock; `isFullPositionExit` now exists only to tell
 * `planBrokerMinimumBump` when a sell/cover is ALREADY at the full held position (nothing left to
 * bump TO), so it can decline immediately instead of proposing a same-size no-op "bump".
 *
 * Both `side` and `positionQuantity` are optional on the order shape: existing call sites that
 * don't supply them simply never match here.
 */
function isFullPositionExit(order: { quantity?: number; side?: OrderSide; positionQuantity?: number }): boolean {
  if (order.side !== "sell" && order.side !== "cover") return false;
  if (order.quantity == null || order.positionQuantity == null) return false;
  // Short positions are stored with NEGATIVE quantities — a full COVER must qualify for the
  // exemption exactly like a full sell, so compare magnitudes.
  const held = Math.abs(order.positionQuantity);
  if (!(held > 0)) return false;
  return Math.abs(order.quantity - held) <= FULL_POSITION_QTY_EPSILON;
}

/**
 * Returns a human-readable block reason when `review` shows this order is a GUARANTEED reject for
 * being below the active broker's minimum order size — either because the broker's own pre-flight
 * review already flagged it (`review.preflightBlock`, the authoritative signal) or, as a defensive
 * fallback for a fractional/dollar-based order whose reviewed notional is itself under the known
 * per-broker floor. Returns undefined for anything else — this must never flag a legitimate order.
 *
 * NO EXEMPTION for a full-position exit (removed 2026-09-25, board 687a5fb4, lane G3): production
 * evidence shows Robinhood rejects a sub-$1 order at placement regardless of whether it closes the
 * entire position — see `isFullPositionExit`'s doc comment for the evidence and root cause. A
 * full-position exit under the floor is blocked exactly like a partial trim; callers that support
 * `brokerMinimumHandling: "bump"` still get a chance to raise a PARTIAL trim toward (and, if
 * needed, up to) the full position first — see `planBrokerMinimumBump` — before this block fires
 * on the re-reviewed size.
 */
export function describeBrokerMinimumOrderBlock(
  review: ReviewedOrder,
  activeBroker: TradingPolicy["activeBroker"],
  order: { quantity?: number; dollarAmount?: number; side?: OrderSide; positionQuantity?: number }
): string | undefined {
  if (review.preflightBlock?.alertTypes?.length) {
    return `Broker pre-flight rejects this order: ${review.preflightBlock.message}`;
  }
  const minNotional = brokerMinOrderNotional(activeBroker);
  if (
    minNotional !== undefined &&
    review.estimatedNotional > 0 &&
    review.estimatedNotional < minNotional &&
    isFractionalOrDollarBased(order)
  ) {
    return `Order notional $${review.estimatedNotional.toFixed(2)} is below the broker's $${minNotional.toFixed(2)} minimum order size and would be rejected.`;
  }
  return undefined;
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Returns a human-readable ADVISORY when cancelling a partially-filled entry order (buy/short)
 * would leave the already-filled portion stranded below the broker's minimum order notional —
 * dust the owner may not be able to exit as a standalone order later (oss-lessons r2, freqtrade).
 *
 * ADVISORY ONLY: the caller must execute the cancel unconditionally regardless of this return
 * value — cancel is the operator's emergency lever and this must never block or delay it. Returns
 * undefined for anything that isn't this specific shape:
 *  - exit sides (sell/cover) — cancelling an exit never CREATES a new position fragment;
 *  - whole-share orders (`isFractionalOrDollarBased` false) — a broker's fractional/dollar-based
 *    floor doesn't apply to whole-share sizing;
 *  - nothing filled yet, or `remaining` (quantity - filledQuantity) isn't positive — either the
 *    order hasn't started filling or there's nothing left for the cancel to interrupt;
 *  - the resulting position quantity is unknown, or is materially larger than the filled quantity
 *    (epsilon-compared magnitudes, mirroring isFullPositionExit) — that's scaling INTO an existing
 *    larger holding, not creating a new dust fragment;
 *  - no known per-broker floor, or no usable price to value the filled portion (`averagePrice`
 *    when the broker has reported one, else the caller-supplied `currentPrice` fallback).
 */
export function describeCancelDustRisk(
  order: {
    side?: OrderSide;
    quantity?: number;
    dollarAmount?: number;
    filledQuantity?: number;
    averagePrice?: number;
    /** Current market price fallback for orders the broker hasn't reported an averagePrice for
     *  yet — no `review` is available at cancel time to source a price from. */
    currentPrice?: number;
    symbol?: string;
  },
  positionQuantity: number | undefined,
  activeBroker: TradingPolicy["activeBroker"]
): string | undefined {
  if (order.side !== "buy" && order.side !== "short") return undefined;
  if (!isFractionalOrDollarBased(order)) return undefined;

  const filledQuantity = order.filledQuantity ?? 0;
  if (!(filledQuantity > 0)) return undefined;

  const price = order.averagePrice ?? order.currentPrice;
  if (price == null || !(price > 0)) return undefined;
  const filledNotional = filledQuantity * price;

  // Remaining-to-fill: share-sized orders compare quantities; dollar-sized orders (quantity
  // undefined) compare the ordered notional against what has filled.  Without the dollar branch,
  // `(quantity ?? 0) - filled` went negative and the advisory silently never fired for the order
  // type most likely to strand fractional dust.
  const remaining =
    order.quantity !== undefined
      ? order.quantity - filledQuantity
      : order.dollarAmount !== undefined
        ? (order.dollarAmount - filledNotional) / price
        : 0;
  if (!(remaining > FULL_POSITION_QTY_EPSILON)) return undefined;

  if (positionQuantity == null) return undefined;
  // Short positions are stored with NEGATIVE quantities — compare magnitudes (isFullPositionExit).
  if (Math.abs(Math.abs(positionQuantity) - filledQuantity) > FULL_POSITION_QTY_EPSILON) return undefined;

  const minNotional = brokerMinOrderNotional(activeBroker);
  if (minNotional === undefined) return undefined;
  if (!(filledNotional > 0) || filledNotional >= minNotional) return undefined;

  const symbol = order.symbol ?? "this symbol";
  return `Cancelling now will leave ${round6(filledQuantity)} sh (~$${round2(filledNotional).toFixed(2)}) of ${symbol} already filled — below the broker's $${minNotional.toFixed(2)} minimum order size and may be stranded as unsellable dust.`;
}

/** Result of planning a bump-to-floor: the sizing patch to apply to the order, plus the
 *  before/after notionals for the audit trail. The patch always carries BOTH sizing keys — the
 *  bumped one set, the other explicitly `undefined` — because broker gateways prefer `quantity`
 *  over `dollarAmount` when both are present (robinhood.ts placeEquityOrder), so a dollar bump
 *  that left a stale sub-minimum quantity behind would execute at the stale size. `toNotional`
 *  is an estimate for quantity-based patches (priced at the reviewed implied price); the
 *  post-bump broker re-review is the authoritative number. */
export interface BrokerMinimumBumpPlan {
  patch: { dollarAmount: number | undefined; quantity: number | undefined };
  fromNotional: number;
  toNotional: number;
}

// Cushion applied when re-sizing a QUANTITY-based order to the notional floor: the floor is a
// dollar threshold but the order prices at execution time, so land ~0.5% above the floor rather
// than exactly on it and lose the race to a one-tick move.
const BUMP_QTY_CUSHION = 1.005;

// A reviewed notional this small is more likely a broker-estimate artifact than a real price
// signal (e.g. Robinhood's review parse falls back through several raw fields). Refuse to use it
// as the price oracle for quantity scaling — the scale factor minNotional/from would be unbounded.
const MIN_TRUSTED_REVIEW_NOTIONAL = 0.05;

/**
 * Plans raising a sub-minimum fractional/dollar-based order TO the broker's floor instead of
 * skipping it (policy.brokerMinimumHandling = "bump", the default — owner ruling 2026-07-09:
 * "bump, not skip"). Returns undefined whenever a safe, executable bump cannot be computed, in
 * which case callers fall back to the existing skip path unchanged:
 *  - no known floor for this broker, whole-share order (floor doesn't apply), or the reviewed
 *    notional is zero / already at the floor;
 *  - OPENING orders (buy/short) whose bump target exceeds `openingCapNotional` — the
 *    caller-computed max placeable opening notional (per-order cap WITH policy's 5% headroom,
 *    further bounded by remaining daily/hourly budget). Bumping into a guaranteed policy
 *    rejection would just trade skip-noise for reject-noise — and a cap breach can even demote
 *    the account's authority (autoRevertOnCapBreach), which the app must never self-inflict;
 *  - quantity scaling whose price oracle (the reviewed notional) is too small to trust;
 *  - SELL/COVER orders whose held position is unknown (no safe way to bound the bump).
 * A sell/cover bump is capped at the FULL held position: brokers permit liquidating an entire
 * fractional position regardless of its dollar value (see isFullPositionExit), so "needs more
 * than held" degrades to a whole-position exit rather than an unfillable order. Dollar-based
 * exits are CONVERTED to a quantity order priced off the position's market value (the production
 * AAPL trim case is a dollar-based sell — declining those would leave the motivating loop alive).
 * positionQuantity may be negative for short positions (cover): magnitudes are used throughout.
 */
export function planBrokerMinimumBump(
  review: ReviewedOrder,
  activeBroker: TradingPolicy["activeBroker"],
  order: {
    quantity?: number;
    dollarAmount?: number;
    side?: OrderSide;
    positionQuantity?: number;
    positionMarketValue?: number;
  },
  opts: { openingCapNotional?: number } = {}
): BrokerMinimumBumpPlan | undefined {
  const minNotional = brokerMinOrderNotional(activeBroker);
  if (minNotional === undefined) return undefined;
  if (!isFractionalOrDollarBased(order)) return undefined;
  const from = review.estimatedNotional;
  if (!(from > 0) || from >= minNotional) return undefined;

  if (order.side === "buy" || order.side === "short") {
    if (order.dollarAmount != null && order.dollarAmount > 0) {
      // NEVER shrink: a mixed-form order whose dollarAmount already meets the floor was only
      // "blocked" because of a stale sub-minimum quantity — keep the dollar size and just clear
      // the stale field. Only a genuine raise is checked against the opening cap.
      const dollarAmount = Math.max(order.dollarAmount, minNotional);
      const raising = dollarAmount > order.dollarAmount;
      if (raising && opts.openingCapNotional !== undefined && dollarAmount > opts.openingCapNotional) return undefined;
      return { patch: { dollarAmount, quantity: undefined }, fromNotional: from, toNotional: dollarAmount };
    }
    if (order.quantity != null && order.quantity > 0) {
      // Compare the actual bump TARGET against the cap — quantity patches aim 0.5% above the
      // floor, so a floor that fits but a cushioned target that doesn't must still decline.
      if (opts.openingCapNotional !== undefined && minNotional * BUMP_QTY_CUSHION > opts.openingCapNotional) return undefined;
      if (from < MIN_TRUSTED_REVIEW_NOTIONAL) return undefined;
      const quantity = round6((order.quantity * minNotional * BUMP_QTY_CUSHION) / from);
      return { patch: { quantity, dollarAmount: undefined }, fromNotional: from, toNotional: round2(minNotional * BUMP_QTY_CUSHION) };
    }
    return undefined;
  }

  if (order.side === "sell" || order.side === "cover") {
    // Short positions carry negative quantities — magnitude is what bounds a cover.
    const heldQty = order.positionQuantity != null ? Math.abs(order.positionQuantity) : undefined;
    if (heldQty === undefined || !(heldQty > 0)) return undefined;

    // Already sized to the FULL held position: there is nothing left to bump TO. Robinhood's floor
    // is unconditional (describeBrokerMinimumOrderBlock no longer exempts a full-position exit), so
    // an order already at the whole position that's still under the floor cannot be resized any
    // further — decline immediately instead of returning a same-size "bump" that would re-review
    // and get blocked anyway one round trip later.
    if (isFullPositionExit(order)) return undefined;

    if (order.quantity != null && order.quantity > 0) {
      if (from < MIN_TRUSTED_REVIEW_NOTIONAL) return undefined;
      const impliedPrice = from / order.quantity;
      const needed = (order.quantity * minNotional * BUMP_QTY_CUSHION) / from;
      if (needed >= heldQty - FULL_POSITION_QTY_EPSILON) {
        return { patch: { quantity: heldQty, dollarAmount: undefined }, fromNotional: from, toNotional: round2(heldQty * impliedPrice) };
      }
      return { patch: { quantity: round6(needed), dollarAmount: undefined }, fromNotional: from, toNotional: round2(needed * impliedPrice) };
    }

    if (order.dollarAmount != null && order.dollarAmount > 0) {
      // Dollar-based exit: convert to a position-bounded QUANTITY order priced off the held
      // position's market value (a dollar patch alone has no safe bound by held quantity).
      const heldValue = order.positionMarketValue != null ? Math.abs(order.positionMarketValue) : undefined;
      if (heldValue === undefined || !(heldValue > 0)) return undefined;
      const impliedPrice = heldValue / heldQty;
      if (!(impliedPrice > 0) || heldValue < MIN_TRUSTED_REVIEW_NOTIONAL) return undefined;
      const needed = (minNotional * BUMP_QTY_CUSHION) / impliedPrice;
      if (needed >= heldQty - FULL_POSITION_QTY_EPSILON) {
        return { patch: { quantity: heldQty, dollarAmount: undefined }, fromNotional: from, toNotional: round2(heldValue) };
      }
      return { patch: { quantity: round6(needed), dollarAmount: undefined }, fromNotional: from, toNotional: round2(needed * impliedPrice) };
    }
    return undefined;
  }

  return undefined;
}

const SUB_MINIMUM_ALERT_COOLDOWN_PREFIX = "subMinimumOrderAlertSent";
// This condition is NAV-bound and persistent (it will not clear itself run to run like a transient
// outage), so there's no value in re-alerting every hour — one alert per window is plenty until the
// owner acts (raise the trim/order size, trim manually, or ignore).
const SUB_MINIMUM_ALERT_COOLDOWN_MS = 24 * 60 * 60_000; // 24 hours

/**
 * Cooldown-gated: returns true (and marks the cooldown) at most once per (user, accountNumber, symbol)
 * per `SUB_MINIMUM_ALERT_COOLDOWN_MS` window — mirrors the HEALTH_ALERT_COOLDOWN /
 * STORAGE_ALERT_COOLDOWN pattern in db-health.ts. Callers must still skip placing the order
 * regardless of this return value; it only gates whether an outward alert/notification fires this run.
 */
export function shouldAlertBrokerMinimumOrderBlock(userId: string, accountNumber: string, symbol: string): boolean {
  const key = `${SUB_MINIMUM_ALERT_COOLDOWN_PREFIX}:${userId}:${accountNumber}:${symbol}`;
  const last = getInternalSetting<string>(key);
  if (last && Date.now() - Date.parse(last) < SUB_MINIMUM_ALERT_COOLDOWN_MS) return false;
  setInternalSetting(key, new Date().toISOString());
  return true;
}

const CANCEL_DUST_ALERT_COOLDOWN_PREFIX = "cancelDustRiskAlertSent";
// Same rationale as SUB_MINIMUM_ALERT_COOLDOWN_MS: a dust-producing cancel is a one-off event to
// surface, not a recurring condition worth re-alerting on every subsequent cancel of the same
// symbol within the window.
const CANCEL_DUST_ALERT_COOLDOWN_MS = 24 * 60 * 60_000; // 24 hours

/**
 * Cooldown-gated: returns true (and marks the cooldown) at most once per (user, accountNumber,
 * symbol) per `CANCEL_DUST_ALERT_COOLDOWN_MS` window — same pattern as
 * shouldAlertBrokerMinimumOrderBlock. Callers must still execute the cancel unconditionally
 * regardless of this return value; it only gates whether an outward alert fires for this cancel.
 */
export function shouldAlertCancelDustRisk(userId: string, accountNumber: string, symbol: string): boolean {
  const key = `${CANCEL_DUST_ALERT_COOLDOWN_PREFIX}:${userId}:${accountNumber}:${symbol}`;
  const last = getInternalSetting<string>(key);
  if (last && Date.now() - Date.parse(last) < CANCEL_DUST_ALERT_COOLDOWN_MS) return false;
  setInternalSetting(key, new Date().toISOString());
  return true;
}
