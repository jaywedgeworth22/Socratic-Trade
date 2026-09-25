// Per-broker ORDER-SHAPE CONSTRAINT TABLES (oss-lessons §7 slice 2 — Lean discipline: each
// broker's order-type constraints are DATA, validated BEFORE submission, with a unit test per
// constraint — instead of being learned one production 422 at a time).
//
// Enforced at the single placement choke point (broker.ts getBrokerGateway wraps every gateway
// in withOrderConstraints), so all placement lanes — strategy loop, approval path, protective
// stops, synthetic stops, order replacement — are covered in EVERY environment. That matters:
// the motivating incident (Alpaca 422 "bracket orders must be entry orders" on a T sell,
// docs/rollouts/2026-07-27-pending-orders-done-for-day.md) happened on Alpaca PAPER.
//
// Two remedies, chosen per constraint:
// - "reshape": the order's INTENT is valid but carries fields the broker would reject or
//   silently drop — the table produces a corrected input and the choke point audits a receipt
//   (`order_constraint_reshaped`). Used where blocking would be worse than fixing (never block
//   an EXIT over decorative bracket legs), mirroring enrichOpeningProposal's strip-with-receipt
//   precedent.
// - "block": the order cannot be honestly expressed on this broker (e.g. trailPercent on a
//   gateway with no native trailing — silently placing a non-trailing order would leave a
//   position believed-protected but not). Throws OrderValidationError, which the strategy and
//   approval lanes already classify as proposal status "blocked" (never "rejected_by_broker").
//
// Adding a constraint: only encode rules with a receipt — a broker doc, a production 422, or an
// adapter check being promoted — never a guessed rule (a wrong block here stops real orders).
// Some rows intentionally duplicate adapter-internal checks (the adapter keeps its own copy as
// defense in depth). The table rows are pinned per-constraint in
// test/broker-order-constraints.test.ts; the adapters' own copies are behavior-pinned by their
// own suites. Messages are copy-equal by convention, not by shared constant — the choke point
// fires first, so its message is the one production actually surfaces.

import { OrderValidationError, type EquityOrderInput } from "./types";

/** A "block" remedy throw. Extends OrderValidationError so the placement lanes' existing
 *  `instanceof OrderValidationError` branches classify it as proposal status "blocked"
 *  (deterministic pre-submission refusal — the broker was never contacted), while carrying
 *  the row identity so the choke point can audit `order_constraint_blocked` accurately
 *  (the strategy lane's own audit kind for this branch predates the tables and is named
 *  for the live preflight). */
export class OrderConstraintBlockedError extends OrderValidationError {
  readonly constraintId: string;
  readonly constraintDescription: string;
  constructor(message: string, constraintId: string, constraintDescription: string) {
    super(message);
    this.name = "OrderConstraintBlockedError";
    this.constraintId = constraintId;
    this.constraintDescription = constraintDescription;
  }
}

/** Brokers as the placement choke point sees them (policy.activeBroker with alpaca-mcp folded
 *  into alpaca — both resolve to the same adapter family and constraint set). "test" is the
 *  unit-suite gateway: deliberately constraint-free so tests can exercise any shape. */
export type ConstraintBrokerId = "alpaca" | "robinhood" | "tradier" | "test";

export function toConstraintBrokerId(activeBroker: string | undefined): ConstraintBrokerId | null {
  if (activeBroker === "alpaca" || activeBroker === "alpaca-mcp") return "alpaca";
  if (activeBroker === "robinhood") return "robinhood";
  if (activeBroker === "tradier") return "tradier";
  if (activeBroker === "test") return "test";
  return null;
}

export interface OrderConstraintRow {
  /** Stable kebab-case id — appears in audit receipts and test fixtures. */
  id: string;
  /** The broker rule, stated as the broker enforces it. */
  description: string;
  /** The trap/incident this row guards — receipt required (see header). */
  note: string;
  remedy: "block" | "reshape";
  /** True when `input` VIOLATES the constraint. Must be pure (no market data, no IO). */
  violates(input: EquityOrderInput): boolean;
  /** block: the OrderValidationError message. May reference the input (e.g. its side). */
  message?(input: EquityOrderInput): string;
  /** reshape: return a corrected COPY (never mutate) plus the fields that changed. */
  reshape?(input: EquityOrderInput): { input: EquityOrderInput; changedFields: string[] };
}

const hasBracketLegs = (input: EquityOrderInput): boolean =>
  input.bracketTakeProfit != null || input.bracketStopLoss != null || input.bracketStopLimit != null;

const isTrailing = (input: EquityOrderInput): boolean => input.trailPercent != null && input.trailPercent > 0;

const stripBracketLegs = (input: EquityOrderInput): { input: EquityOrderInput; changedFields: string[] } => {
  const changedFields = (["bracketTakeProfit", "bracketStopLoss", "bracketStopLimit"] as const).filter(
    (field) => input[field] != null
  );
  const next = { ...input };
  delete next.bracketTakeProfit;
  delete next.bracketStopLoss;
  delete next.bracketStopLimit;
  return { input: next, changedFields };
};

/** A limit price is legal only on limit-family orders (limit / stop_limit). */
const carriesStrayLimitPrice = (input: EquityOrderInput): boolean =>
  (input.type === "market" || input.type === "stop_market") && input.limitPrice != null;

const stripLimitPrice = (input: EquityOrderInput): { input: EquityOrderInput; changedFields: string[] } => {
  const next = { ...input };
  delete next.limitPrice;
  return { input: next, changedFields: ["limitPrice"] };
};

export const BROKER_ORDER_CONSTRAINTS: Record<ConstraintBrokerId, OrderConstraintRow[]> = {
  alpaca: [
    {
      id: "alpaca-bracket-legs-entry-only",
      description: "Bracket legs (take-profit/stop-loss) are allowed on ENTRY orders (buy/short) only.",
      note:
        "THE motivating incident: Alpaca (paper) 422 'bracket orders must be entry orders' on a T sell, " +
        "2026-07-27. Never fixed upstream of the adapter — enrichOpeningProposal returns early for exits " +
        "and sanitizeProposals carries bracket fields for any side, so an exit proposal can still arrive " +
        "here wearing legs. Reshape (not block): the EXIT itself is valid and must go out.",
      remedy: "reshape",
      violates: (input) => (input.side === "sell" || input.side === "cover") && hasBracketLegs(input),
      reshape: stripBracketLegs
    },
    {
      id: "alpaca-trailing-excludes-brackets",
      description: "A native trailing stop cannot carry bracket legs (both would claim the same shares).",
      note: "Promotes the adapter's own guard (alpaca.ts placeEquityOrder) to the pre-submission table.",
      remedy: "block",
      violates: (input) => isTrailing(input) && hasBracketLegs(input),
      message: () => "Alpaca trailing stop cannot carry bracket legs — place one or the other."
    },
    {
      id: "alpaca-trailing-requires-share-quantity",
      description: "Native trailing stops are quantity-based only — no notional/dollar trailing.",
      note: "Promotes the adapter's own guard; a dollarAmount trailing order has no valid Alpaca encoding.",
      remedy: "block",
      violates: (input) => isTrailing(input) && !(input.quantity != null && input.quantity > 0),
      message: () => "Alpaca trailing stop requires a positive share quantity (no notional trailing stops)."
    },
    {
      id: "alpaca-stop-price-only-on-stop-orders",
      description: "market/limit orders must not carry a stop_price.",
      note:
        "Alpaca 422 40010001 ('limit orders require no stop price'). The adapter avoids it by payload " +
        "construction; this row makes the drop explicit and audited. Reshape: the stopPrice on a " +
        "market/limit order is inert metadata (a ratchet anchor for other brokers), never intent.",
      remedy: "reshape",
      violates: (input) => (input.type === "market" || input.type === "limit") && input.stopPrice != null,
      reshape: (input) => {
        const next = { ...input };
        delete next.stopPrice;
        return { input: next, changedFields: ["stopPrice"] };
      }
    },
    {
      id: "alpaca-limit-price-only-on-limit-orders",
      description: "market/stop orders must not carry a limit_price.",
      note:
        "Alpaca 422 'market orders require no stop or limit price' — twice on the PG buy-to-cover " +
        "(2026-07-16, 2026-07-22): a MARKET cover still wearing the proposal's limitPrice. The adapter " +
        "now gates limit_price by type; this row makes the drop explicit and audited. Reshape: the " +
        "order type is the intent, a stray limitPrice on a market/stop order is not.",
      remedy: "reshape",
      violates: carriesStrayLimitPrice,
      reshape: stripLimitPrice
    },
    {
      id: "alpaca-extended-hours-exit-requeue",
      description: "A non-limit EXIT tagged extended_hours re-queues to regular hours.",
      note:
        "Split from the entry block below by the money-path review: the LLM schema allows any " +
        "type x hours combination and policy exempts sell/cover from the permitExtendedHours gate, " +
        "so exits CAN arrive shaped this way. Never block an exit: a market exit at the regular " +
        "open is this shape's only honest Alpaca encoding — and exactly what the alpaca-mcp " +
        "transport silently did before (it never forwarded the flag; see protective-exit-routing.ts " +
        "header), while REST 422'd. Ordered before the entry block; the receipt makes the requeue visible.",
      remedy: "reshape",
      violates: (input) =>
        (input.side === "sell" || input.side === "cover") && input.marketHours === "extended_hours" && input.type !== "limit",
      reshape: (input) => ({ input: { ...input, marketHours: "regular_hours" }, changedFields: ["marketHours"] })
    },
    {
      id: "alpaca-extended-hours-limit-only",
      description: "Extended-hours ENTRIES must be limit orders (extended_hours=true on market/stop is rejected).",
      note:
        "The LLM strategy/approval lanes CAN produce this shape when permitExtendedHours is on. " +
        "On plain REST it already 422'd (this block is a strict improvement: pre-submission, " +
        "classified 'blocked'); on the alpaca-mcp transport it was silently misrouted as a " +
        "regular-hours order that executed. Fail-closed here is deliberate for ENTRIES — a trade " +
        "the broker cannot honestly take in the requested session should not start a position at " +
        "a different session's price. Exits are re-queued by the row above instead.",
      remedy: "block",
      violates: (input) =>
        (input.side === "buy" || input.side === "short") && input.marketHours === "extended_hours" && input.type !== "limit",
      message: (input) =>
        `Alpaca extended-hours orders must be limit orders — a ${input.type} order with extended_hours=true is rejected by the broker.`
    }
  ],
  robinhood: [
    {
      id: "robinhood-no-short-selling",
      description: "Short selling (short/cover) is not supported.",
      note:
        "Duplicates toMcpOrder's throw at the choke point as defense in depth. NOTE: the standard " +
        "strategy/approval lanes call reviewEquityOrder first, which hits the same toMcpOrder " +
        "plain-Error throw before this row can run — the OrderValidationError -> 'blocked' " +
        "classification upgrade applies only to lanes that place without reviewing.",
      remedy: "block",
      violates: (input) => input.side === "short" || input.side === "cover",
      message: (input) =>
        `Robinhood does not support short selling (side="${input.side}"). Short/cover orders must not reach the broker.`
    },
    {
      id: "robinhood-no-native-trailing",
      description: "No verified native trailing-stop parameter on the Robinhood MCP.",
      note:
        "Fail closed rather than silently degrade into a plain stop — the protective-stop reconciler " +
        "emulates trailing on Robinhood by ratcheting a stop_market and never sets trailPercent for it.",
      remedy: "block",
      violates: isTrailing,
      message: () =>
        "Robinhood MCP does not support native trailing stops. Place a stop_market and ratchet it (see broker-protective-stops.ts)."
    },
    {
      id: "robinhood-no-bracket-legs",
      description: "No bracket/OTO/OCO support — bracket fields have no Robinhood encoding.",
      note:
        "The adapter previously ignored the fields silently; reshape makes the drop an audited receipt " +
        "so 'believed bracketed' can never be quietly wrong.",
      remedy: "reshape",
      violates: hasBracketLegs,
      reshape: stripBracketLegs
    }
  ],
  tradier: [
    {
      id: "tradier-no-native-trailing",
      description: "The Tradier gateway has no native trailing-stop support.",
      note:
        "tradier.ts contains zero trailPercent handling — the field would be SILENTLY DROPPED and the " +
        "order placed without trailing semantics: a position believed-protected but not. Production " +
        "never routes trailing here (broker-protective-stops' nativeTrailing is alpaca-only); this row " +
        "makes that invariant structural.",
      remedy: "block",
      violates: isTrailing,
      message: () =>
        "Tradier gateway has no native trailing-stop support — trailPercent would be silently ignored. Use the ratcheted stop_market emulation (broker-protective-stops.ts) instead."
    },
    {
      id: "tradier-bracket-legs-require-limitable-entry",
      description: "OTO/OTOCO bracket legs require a limit/stop entry — a market entry cannot carry them.",
      note:
        "tradier.ts's entryTypeSupportsBracket silently falls through to a plain single-leg order for a " +
        "market entry; enrichOpeningProposal strips with a rationale receipt upstream. This row is the " +
        "choke-point backstop with an audited receipt.",
      remedy: "reshape",
      violates: (input) => input.type === "market" && hasBracketLegs(input),
      reshape: stripBracketLegs
    },
    {
      id: "tradier-limit-price-only-on-limit-orders",
      description: "market/stop orders carry no `price` (Tradier `price` is the limit price).",
      note:
        "tradier.ts used to send `price` whenever limitPrice was set, whatever the type — the same " +
        "stray-limit shape that 422'd the PG market cover on Alpaca. The adapter now gates `price` by " +
        "type; this row is the audited choke-point receipt.",
      remedy: "reshape",
      violates: carriesStrayLimitPrice,
      reshape: stripLimitPrice
    }
  ],
  test: []
};

export interface OrderConstraintReshapeReceipt {
  constraintId: string;
  description: string;
  changedFields: string[];
}

export interface AppliedOrderConstraints {
  input: EquityOrderInput;
  reshaped: OrderConstraintReshapeReceipt[];
}

/**
 * Validate (and where sanctioned, reshape) one order against a broker's constraint table.
 * Pure: no IO, never mutates `input`. Throws OrderValidationError on a "block" violation;
 * returns the (possibly reshaped) input plus receipts for every reshape applied. Rows are
 * applied in table order; a reshape's output feeds the next row's check.
 */
export function applyOrderConstraints(broker: ConstraintBrokerId, input: EquityOrderInput): AppliedOrderConstraints {
  let current = input;
  const reshaped: OrderConstraintReshapeReceipt[] = [];
  for (const row of BROKER_ORDER_CONSTRAINTS[broker]) {
    if (!row.violates(current)) continue;
    if (row.remedy === "block") {
      const message = row.message?.(current) ?? `${broker}: order violates constraint ${row.id}.`;
      throw new OrderConstraintBlockedError(message, row.id, row.description);
    }
    if (!row.reshape) continue;
    const result = row.reshape(current);
    if (result.changedFields.length === 0) continue;
    current = result.input;
    reshaped.push({ constraintId: row.id, description: row.description, changedFields: result.changedFields });
  }
  return { input: current, reshaped };
}
