// POSITION INVARIANT at the single placement choke point (broker.ts getBrokerGateway).
//
// Every app-originated order — the autopilot inline placement, the approval lane's
// executeProposal, stale-exit market replacements, broker protective stops, and synthetic
// stops — reaches the broker through getBrokerGateway's placeEquityOrder.  This wrapper reads
// the account's CURRENT broker position for the order's symbol just before placement and holds
// four correctness rules (not guardrails — each prevents an order the user never intended):
//
//   1. A sell only ever reduces a long.  Sell with no long held -> refused (it would open a
//      SHORT; Alpaca infers open/close from the position, so a "sell" of a flat symbol IS a short
//      sale).  Sell above the held long -> clamped to the exact broker quantity.  Sell against a
//      held short -> refused with the correct verb ("cover").
//   2. A cover only ever reduces a short.  Cover with no short held -> refused (it would buy a
//      LONG).  Cover above the held short -> clamped.
//   3. A buy against a held short (quantity <= the short) IS a cover: it is re-expressed as side
//      "cover" (Tradier needs buy_to_cover; Alpaca's wire side is "buy" either way).
//   4. Closing orders carry no bracket legs (Alpaca 422 "bracket orders must be entry orders"),
//      and a closing MARKET order carries no limit/stop price (Alpaca 422 "market orders require
//      no stop or limit price").  A full-exit DOLLAR order resolves to the exact held quantity so
//      the broker's own dollars->shares rounding cannot overshoot the position (Alpaca 403
//      "insufficient qty").
//
// Production receipts (Alpaca Paper PA33IDTHMFK9, long-only mandate): the 2026-07-08 PG
// standalone MARKET SELL 12 placed while the account held zero PG (filled at the open -> a
// 12-share short held until 2026-09-24); twelve buy-to-cover proposals refused 422 "bracket
// orders must be entry orders"; two 422 "market orders require no stop or limit price"; and the
// 2026-09-21 VZ $1.34 full exit refused 403 (requested 0.027910851, available 0.02778376).
//
// LATENCY: the read is FRESH (one getEquityPositions per placement, no cache).  A cached snapshot
// is exactly the hazard being closed: two sells of the same symbol a second apart would both see
// the pre-fill long, and the second would short.  Placements are a handful per run, so the extra
// broker read (~100-300 ms on Alpaca REST) is cheap next to an unintended position.
//
// READ FAILURE (fail-open vs fail-closed, per side and broker):
//   - buy / short: fail OPEN.  A buy is only reshaped when a short is proven; a short is never
//     inspected.
//   - sell / cover on Alpaca (and the test broker): fail CLOSED, unless the caller passes
//     `verifiedPositionQuantity` from a position read it just made (protective stops, synthetic
//     stops, stale-exit replacements).  Alpaca infers open vs close from the position, so an
//     unverified sell can silently open a short — the PG incident.  A protective exit of a
//     quantity the caller just verified must not be blocked by a transient read failure.
//   - sell / cover on Tradier and Robinhood: fail OPEN.  Their wire verbs are explicit (Tradier
//     sell vs sell_short / buy vs buy_to_cover; Robinhood cannot short), so the broker itself
//     refuses a close with nothing to close — no unintended position can open.
//
// Brokers outside POSITION_INVARIANT_BROKERS (eToro, Public, Webull, Kalshi) pass through
// untouched: their position shapes/sign conventions are unverified here, and a wrong read would
// block real exits.  Cancels are never inspected (risk-reducing).

import { audit } from "./db";
import { normalizeSymbol } from "./money";
import {
  OrderValidationError,
  type BrokerGateway,
  type EquityOrderInput,
  type EquityPosition,
  type ExecutedOrder,
  type TradeProposal,
  type TradingPolicy
} from "./types";

/** Alpaca's fractional granularity is 1e-9 shares; anything smaller is float noise. */
const QTY_EPSILON = 1e-9;

/**
 * A dollar-amount exit within this fraction of the held market value is a FULL exit: the dollar
 * figure was computed from an earlier quote, so a <= 2% shortfall is price drift, not an intent
 * to leave dust behind (the VZ proposal: $1.34 against a $1.3339 position).
 */
const FULL_EXIT_DOLLAR_TOLERANCE = 0.02;

/** Brokers whose position reads and sign conventions (short = negative quantity) are verified. */
const POSITION_INVARIANT_BROKERS = new Set(["alpaca", "alpaca-mcp", "tradier", "robinhood", "test"]);

/** Brokers that infer open-vs-close from the position (a flat "sell" is a short sale). */
const POSITION_INFERRED_SIDE_BROKERS = new Set(["alpaca", "alpaca-mcp", "test"]);

/** Brokers that cannot hold an equity short: a buy there can never be a cover, so no read for buys. */
const NO_SHORT_BROKERS = new Set(["robinhood"]);

export type PositionInvariantRefusalCode =
  | "sell_without_long"
  | "sell_against_short"
  | "cover_without_short"
  | "position_unverified";

export type PositionInvariantReceiptKind =
  | "quantity_clamped_to_position"
  | "dollar_exit_resolved_to_quantity"
  | "buy_against_short_is_cover"
  | "closing_bracket_legs_stripped"
  | "closing_market_price_fields_stripped";

export interface PositionInvariantReceipt {
  kind: PositionInvariantReceiptKind;
  detail: string;
  changedFields: string[];
}

/** The account's signed position in the order's symbol (short = negative). */
export interface HeldPosition {
  signedQuantity: number;
  /** Broker market value (negative for a short on Alpaca). Used only for dollar full-exit resolution. */
  marketValue?: number;
  /** "broker" = fresh placement-time read; "caller" = the caller's own just-verified read. */
  source?: "broker" | "caller";
}

/**
 * A deterministic pre-submission refusal.  Extends OrderValidationError so the strategy and
 * approval lanes classify it as proposal status "blocked" (the broker was never contacted).
 */
export class OrderPositionInvariantError extends OrderValidationError {
  readonly code: PositionInvariantRefusalCode;
  constructor(message: string, code: PositionInvariantRefusalCode) {
    super(message);
    this.name = "OrderPositionInvariantError";
    this.code = code;
  }
}

function formatQty(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(9)));
}

function hasBracketLegs(input: Pick<EquityOrderInput, "bracketTakeProfit" | "bracketStopLoss" | "bracketStopLimit">): boolean {
  return input.bracketTakeProfit != null || input.bracketStopLoss != null || input.bracketStopLimit != null;
}

function stripLegs<T extends Pick<EquityOrderInput, "bracketTakeProfit" | "bracketStopLoss" | "bracketStopLimit">>(
  input: T
): { next: T; changedFields: string[] } {
  const changedFields = (["bracketTakeProfit", "bracketStopLoss", "bracketStopLimit"] as const).filter(
    (field) => input[field] != null
  );
  const next = { ...input };
  delete next.bracketTakeProfit;
  delete next.bracketStopLoss;
  delete next.bracketStopLimit;
  return { next, changedFields };
}

/** Signed held quantity for one symbol from a broker position list (short = negative). */
export function heldPositionFor(positions: EquityPosition[], symbol: string): HeldPosition {
  const target = normalizeSymbol(symbol);
  let signedQuantity = 0;
  let marketValue = 0;
  let matched = 0;
  for (const position of positions) {
    if (normalizeSymbol(position.symbol) !== target) continue;
    const quantity = Number(position.quantity);
    if (!Number.isFinite(quantity)) continue;
    matched += 1;
    // One row per symbol is the norm; keep the broker's own number (no arithmetic) so a
    // fractional clamp sends the exact broker quantity string.
    signedQuantity = matched === 1 ? quantity : signedQuantity + quantity;
    const value = Number(position.marketValue);
    if (Number.isFinite(value)) marketValue = matched === 1 ? value : marketValue + value;
  }
  return { signedQuantity, marketValue, source: "broker" };
}

/**
 * Pure: apply the position invariant to one order.  Returns the (possibly reshaped) order plus a
 * receipt per change, or throws OrderPositionInvariantError.  `position` undefined means the
 * position could not be verified.  Never mutates `order`; never forwards `verifiedPositionQuantity`.
 */
export function applyPositionInvariant(
  order: EquityOrderInput,
  position: HeldPosition | undefined
): { input: EquityOrderInput; receipts: PositionInvariantReceipt[] } {
  const { verifiedPositionQuantity: _hint, ...rest } = order;
  void _hint;
  let input: EquityOrderInput = rest;
  const receipts: PositionInvariantReceipt[] = [];
  const symbol = normalizeSymbol(order.symbol);
  const side = order.side;

  if (side === "short") return { input, receipts };

  if (!position) {
    if (side === "buy") return { input, receipts };
    throw new OrderPositionInvariantError(
      `${symbol} ${side.toUpperCase()} refused: could not verify the broker's ${symbol} position just before placement, ` +
        `and a ${side} of an unverified position can open an unintended ${side === "sell" ? "SHORT" : "LONG"}.  ` +
        "Nothing was sent to the broker; the next run or reconcile retries with a fresh position read.",
      "position_unverified"
    );
  }

  const held = position.signedQuantity;
  const heldLong = held > QTY_EPSILON ? held : 0;
  const heldShort = held < -QTY_EPSILON ? -held : 0;
  const heldMarketValue = Math.abs(Number(position.marketValue ?? 0));

  let closingSide: "sell" | "cover";
  let closable: number;
  if (side === "buy") {
    // A buy only changes shape when it provably closes (part of) a held short.
    const quantity = input.quantity;
    if (!(heldShort > 0) || quantity == null || !(quantity > 0) || quantity > heldShort + QTY_EPSILON) {
      return { input, receipts };
    }
    input = { ...input, side: "cover" };
    receipts.push({
      kind: "buy_against_short_is_cover",
      detail: `The account is short ${formatQty(heldShort)} ${symbol}; a buy of ${formatQty(quantity)} closes it, so it is placed as a cover.`,
      changedFields: ["side"]
    });
    closingSide = "cover";
    closable = heldShort;
  } else if (side === "sell") {
    if (heldShort > 0) {
      throw new OrderPositionInvariantError(
        `${symbol} SELL refused: the account is SHORT ${formatQty(heldShort)} ${symbol}, and a sell would ADD to the short, not close it.  ` +
          `Close a short with side "cover" (up to ${formatQty(heldShort)} shares).  Nothing was sent to the broker.`,
        "sell_against_short"
      );
    }
    if (!(heldLong > 0)) {
      throw new OrderPositionInvariantError(
        `${symbol} SELL refused: the account holds no ${symbol} long, so this sell would open a SHORT nobody intended.  ` +
          "Nothing was sent to the broker.  (An intended short is side \"short\".)",
        "sell_without_long"
      );
    }
    closingSide = "sell";
    closable = heldLong;
  } else {
    // cover
    if (!(heldShort > 0)) {
      throw new OrderPositionInvariantError(
        `${symbol} COVER refused: the account holds no ${symbol} short (position ${formatQty(held)}), so this buy-to-cover ` +
          "would open a LONG (or add to one) instead of closing a short.  Nothing was sent to the broker.",
        "cover_without_short"
      );
    }
    closingSide = "cover";
    closable = heldShort;
  }

  // Full-exit dollar orders resolve to the exact held quantity.
  if (input.quantity == null && input.dollarAmount != null && input.dollarAmount > 0 && heldMarketValue > 0) {
    if (input.dollarAmount >= heldMarketValue * (1 - FULL_EXIT_DOLLAR_TOLERANCE)) {
      const dollars = input.dollarAmount;
      const next = { ...input, quantity: closable };
      delete next.dollarAmount;
      input = next;
      receipts.push({
        kind: "dollar_exit_resolved_to_quantity",
        detail: `$${dollars.toFixed(2)} ${closingSide} of a $${heldMarketValue.toFixed(2)} position is a full exit; placed as the exact held quantity ${formatQty(closable)}.`,
        changedFields: ["dollarAmount", "quantity"]
      });
    }
  }

  // Never close more than is held.
  if (input.quantity != null && input.quantity > closable) {
    const from = input.quantity;
    input = { ...input, quantity: closable };
    receipts.push({
      kind: "quantity_clamped_to_position",
      detail: `${closingSide} ${formatQty(from)} exceeds the held ${formatQty(closable)} ${symbol}; clamped to the exact broker quantity.`,
      changedFields: ["quantity"]
    });
  }

  if (hasBracketLegs(input)) {
    const { next, changedFields } = stripLegs(input);
    input = next;
    receipts.push({
      kind: "closing_bracket_legs_stripped",
      detail: `A closing ${closingSide} carries no bracket legs (brokers accept brackets on entry orders only).`,
      changedFields
    });
  }

  if (input.type === "market" && (input.limitPrice != null || input.stopPrice != null)) {
    const changedFields = (["limitPrice", "stopPrice"] as const).filter((field) => input[field] != null);
    const next = { ...input };
    delete next.limitPrice;
    delete next.stopPrice;
    input = next;
    receipts.push({
      kind: "closing_market_price_fields_stripped",
      detail: "A market order carries no limit or stop price.",
      changedFields: [...changedFields]
    });
  }

  return { input, receipts };
}

function brokerInScope(activeBroker: string | undefined): boolean {
  return typeof activeBroker === "string" && POSITION_INVARIANT_BROKERS.has(activeBroker);
}

/**
 * Wrap a gateway so `placeEquityOrder` applies the position invariant with a FRESH broker
 * position read.  Composed into getBrokerGateway (broker.ts) inside the live preflight and
 * outside the per-broker constraint tables, so a reshaped order (e.g. buy -> cover) is still
 * validated by the constraint rows.  A Proxy keeps the underlying gateway untouched.
 */
export function withPositionInvariant(gateway: BrokerGateway, policy: TradingPolicy, userId: string): BrokerGateway {
  return new Proxy(gateway, {
    get(target, prop, receiver) {
      if (prop === "placeEquityOrder") {
        return async (rawInput: EquityOrderInput & { refId: string }): Promise<ExecutedOrder> => {
          const { verifiedPositionQuantity, ...withoutHint } = rawInput;
          if (
            !brokerInScope(policy.activeBroker) ||
            rawInput.side === "short" ||
            (rawInput.side === "buy" && NO_SHORT_BROKERS.has(policy.activeBroker ?? ""))
          ) {
            return target.placeEquityOrder(withoutHint as EquityOrderInput & { refId: string });
          }
          const symbol = normalizeSymbol(rawInput.symbol);
          let position: HeldPosition | undefined;
          try {
            const positions = await target.getEquityPositions(rawInput.accountNumber);
            if (!Array.isArray(positions)) throw new Error("broker returned a non-list position payload");
            position = heldPositionFor(positions, symbol);
          } catch (error) {
            const hasHint = typeof verifiedPositionQuantity === "number" && Number.isFinite(verifiedPositionQuantity);
            const failClosed = POSITION_INFERRED_SIDE_BROKERS.has(policy.activeBroker ?? "");
            audit(
              "order_position_read_failed",
              {
                symbol,
                side: rawInput.side,
                type: rawInput.type,
                refId: rawInput.refId,
                error: error instanceof Error ? error.message : String(error),
                fallback: hasHint ? "caller_verified_quantity" : failClosed ? "none" : "broker_enforces_close_verb"
              },
              userId,
              policy.connectedAccountId
            );
            if (hasHint) {
              position = { signedQuantity: verifiedPositionQuantity as number, source: "caller" };
            } else if (!failClosed) {
              // Tradier/Robinhood: explicit close verbs — the broker itself refuses a close with
              // nothing to close, so pass through unchanged rather than block a real exit.
              return target.placeEquityOrder(withoutHint as EquityOrderInput & { refId: string });
            }
          }

          let applied: ReturnType<typeof applyPositionInvariant>;
          try {
            applied = applyPositionInvariant(rawInput, position);
          } catch (error) {
            if (error instanceof OrderPositionInvariantError) {
              audit(
                "order_position_invariant_refused",
                {
                  symbol,
                  side: rawInput.side,
                  type: rawInput.type,
                  quantity: rawInput.quantity,
                  dollarAmount: rawInput.dollarAmount,
                  refId: rawInput.refId,
                  code: error.code,
                  positionQuantity: position?.signedQuantity ?? null,
                  positionSource: position?.source ?? null,
                  reason: error.message
                },
                userId,
                policy.connectedAccountId
              );
            }
            throw error;
          }

          for (const receipt of applied.receipts) {
            audit(
              "order_position_invariant_reshaped",
              {
                symbol,
                side: rawInput.side,
                placedSide: applied.input.side,
                type: rawInput.type,
                refId: rawInput.refId,
                receipt: receipt.kind,
                changedFields: receipt.changedFields,
                detail: receipt.detail,
                positionQuantity: position?.signedQuantity ?? null,
                positionSource: position?.source ?? null
              },
              userId,
              policy.connectedAccountId
            );
          }
          return target.placeEquityOrder({ ...applied.input, refId: rawInput.refId });
        };
      }
      return Reflect.get(target, prop, receiver);
    }
  });
}

export interface ExitSideNormalization {
  symbol: string;
  from: "sell" | "buy";
  to: "cover";
  heldShortQuantity: number;
  quantity: number;
  strippedLegs: string[];
}

/**
 * Closing a short is side "cover".  Upstream of policy, rewrite:
 *   - a SELL of a symbol held SHORT (a sell would ADD to the short) -> cover of the held quantity
 *     (or of the proposal's smaller quantity); a dollar sell covers the whole short.  Disabled with
 *     `convertSellToCover: false` where the owner already confirmed a "sell" (the approval lane):
 *     flipping the wire direction there must not happen behind the owner's back — the choke point
 *     refuses it with the correct verb instead.
 *   - a BUY of at most the held short -> cover (same wire direction; strips its bracket legs).
 * Returns the SAME object when nothing changes.
 */
export function normalizeExitSideForHeldPosition(
  proposal: TradeProposal,
  positions: EquityPosition[],
  options: { convertSellToCover?: boolean } = {}
): { proposal: TradeProposal; change?: ExitSideNormalization } {
  if (proposal.side !== "sell" && proposal.side !== "buy") return { proposal };
  const { signedQuantity } = heldPositionFor(positions, proposal.symbol);
  const heldShort = signedQuantity < -QTY_EPSILON ? -signedQuantity : 0;
  if (!(heldShort > 0)) return { proposal };
  const symbol = normalizeSymbol(proposal.symbol);

  let quantity: number;
  if (proposal.side === "sell") {
    if (options.convertSellToCover === false) return { proposal };
    quantity = proposal.quantity != null && proposal.quantity > 0 ? Math.min(proposal.quantity, heldShort) : heldShort;
  } else {
    if (proposal.quantity == null || !(proposal.quantity > 0) || proposal.quantity > heldShort + QTY_EPSILON) {
      return { proposal };
    }
    quantity = Math.min(proposal.quantity, heldShort);
  }

  const { next, changedFields } = stripLegs(proposal);
  const rewritten: TradeProposal = { ...next, side: "cover", quantity };
  delete rewritten.dollarAmount;
  const from = proposal.side;
  rewritten.rationale =
    `${proposal.rationale} [Side normalized: ${symbol} is held SHORT ${formatQty(heldShort)}; ` +
    (from === "sell"
      ? `a sell would add to the short, so this exit is a cover of ${formatQty(quantity)}.]`
      : `a buy of ${formatQty(quantity)} closes it, so it is a cover${changedFields.length > 0 ? " (bracket legs removed — exits carry none)" : ""}.]`);
  return {
    proposal: rewritten,
    change: { symbol, from, to: "cover", heldShortQuantity: heldShort, quantity, strippedLegs: changedFields }
  };
}

/** Normalize a batch of proposals and audit each rewrite (`proposal_exit_side_normalized`). */
export function normalizeExitSidesForHeldPositions(
  proposals: TradeProposal[],
  positions: EquityPosition[],
  context: { userId: string; connectedAccountId?: string; lane: "autopilot" | "approval"; runId?: string; proposalId?: string },
  options: { convertSellToCover?: boolean } = {}
): TradeProposal[] {
  return proposals.map((proposal) => {
    const result = normalizeExitSideForHeldPosition(proposal, positions, options);
    if (result.change) {
      audit(
        "proposal_exit_side_normalized",
        { ...result.change, lane: context.lane, ...(context.runId ? { runId: context.runId } : {}), ...(context.proposalId ? { proposalId: context.proposalId } : {}) },
        context.userId,
        context.connectedAccountId
      );
    }
    return result.proposal;
  });
}

/** Label each position long/short so the strategist sees the sign (short = negative quantity). */
export function withPositionSides<T extends EquityPosition>(positions: T[]): Array<T & { side: "long" | "short" }> {
  return positions.map((position) => {
    const side: "long" | "short" = Number(position.quantity) < 0 ? "short" : "long";
    return { ...position, side };
  });
}
