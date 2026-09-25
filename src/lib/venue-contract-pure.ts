/**
 * Client-safe venue helpers — no source-settings / db imports.
 *
 * Split from venue-contract.ts so console client components (e.g. brokers.tsx) can
 * call mergeAccountCapabilities without dragging the server DB layer into the bundle.
 */

import type {
  AccountCapabilities,
  ConnectedAccount,
  MarketHours,
  OrderSide,
  OrderType
} from "./types";

const ALL_ORDER_TYPES: OrderType[] = ["market", "limit", "stop_market", "stop_limit"];
const REGULAR_ONLY: MarketHours[] = ["regular_hours"];
const REGULAR_AND_EXTENDED: MarketHours[] = ["regular_hours", "extended_hours"];
const ALL_SESSIONS: MarketHours[] = ["regular_hours", "extended_hours", "all_day_hours"];

export interface VenueContract {
  broker: ConnectedAccount["broker"] | "none";
  brokerLabel: string;
  sides: OrderSide[];
  orderTypes: OrderType[];
  marketHours: MarketHours[];
  fractional: boolean;
  trailingStops: boolean;
  nativeBrackets: boolean;
  optionsTrading: boolean;
  optionsOrders: boolean;
  minShareQuantity: number;
  minOrderNotional?: number;
  positionIdCloses: boolean;
  /** One-line facts for the LLM.  Never include a capability the schema already omits. */
  promptLines: string[];
}

export function emptyCapabilities(over: Partial<AccountCapabilities> = {}): AccountCapabilities {
  return {
    equityTrading: true,
    shortSelling: false,
    optionsTrading: false,
    futuresTrading: false,
    cryptoTrading: false,
    marginEnabled: false,
    accountType: "brokerage",
    fractional: false,
    extendedHours: false,
    overnightHours: false,
    trailingStops: false,
    nativeBrackets: false,
    optionsOrders: false,
    orderTypes: ["market", "limit"],
    marketHours: REGULAR_ONLY,
    ...over
  };
}

/**
 * Official, verified venue limits (2026-08).  Live getAccounts may override
 * shortSelling / optionsLevel / accountType / marginEnabled.  It must not invent
 * a short or option-order path the public API does not expose.
 */
export function knownBrokerLimits(broker: ConnectedAccount["broker"] | undefined): Partial<AccountCapabilities> {
  switch (broker) {
    case "alpaca":
    case "alpaca-mcp":
      return {
        equityTrading: true,
        optionsTrading: true,
        optionsOrders: false,
        fractional: true,
        extendedHours: true,
        overnightHours: false,
        trailingStops: true,
        nativeBrackets: true,
        orderTypes: ALL_ORDER_TYPES,
        marketHours: REGULAR_AND_EXTENDED,
        futuresTrading: false,
        cryptoTrading: false
      };
    case "robinhood":
      return {
        equityTrading: true,
        shortSelling: false,
        optionsTrading: true,
        optionsOrders: false,
        fractional: true,
        extendedHours: true,
        overnightHours: true,
        trailingStops: false,
        nativeBrackets: false,
        orderTypes: ALL_ORDER_TYPES,
        marketHours: ALL_SESSIONS,
        futuresTrading: false,
        cryptoTrading: false
      };
    case "tradier":
      return {
        equityTrading: true,
        optionsTrading: true,
        optionsOrders: false,
        fractional: false,
        extendedHours: true,
        overnightHours: false,
        trailingStops: false,
        nativeBrackets: true,
        orderTypes: ALL_ORDER_TYPES,
        marketHours: REGULAR_AND_EXTENDED,
        minShareQuantity: 1,
        futuresTrading: false,
        cryptoTrading: false
      };
    case "etoro":
      return {
        equityTrading: true,
        shortSelling: false,
        optionsTrading: false,
        optionsOrders: false,
        fractional: true,
        extendedHours: false,
        overnightHours: false,
        trailingStops: false,
        nativeBrackets: false,
        orderTypes: ["market", "limit"],
        marketHours: REGULAR_ONLY,
        positionIdCloses: true,
        futuresTrading: false,
        cryptoTrading: false,
        marginEnabled: false
      };
    case "public":
      return {
        equityTrading: true,
        shortSelling: true,
        optionsTrading: true,
        optionsOrders: false,
        fractional: true,
        extendedHours: true,
        overnightHours: true,
        trailingStops: false,
        nativeBrackets: false,
        orderTypes: ALL_ORDER_TYPES,
        marketHours: ALL_SESSIONS,
        minOrderNotional: 5,
        futuresTrading: false,
        cryptoTrading: false
      };
    case "webull":
      return {
        equityTrading: true,
        shortSelling: true,
        optionsTrading: true,
        optionsOrders: false,
        fractional: true,
        extendedHours: true,
        overnightHours: true,
        trailingStops: true,
        nativeBrackets: true,
        orderTypes: ALL_ORDER_TYPES,
        marketHours: ALL_SESSIONS,
        futuresTrading: false,
        cryptoTrading: false
      };
    case "test":
      return {
        equityTrading: true,
        shortSelling: true,
        optionsTrading: true,
        optionsOrders: false,
        fractional: true,
        extendedHours: true,
        overnightHours: true,
        trailingStops: true,
        nativeBrackets: true,
        orderTypes: ALL_ORDER_TYPES,
        marketHours: ALL_SESSIONS
      };
    case "kalshi":
      return {
        equityTrading: false,
        shortSelling: false,
        optionsTrading: false,
        optionsOrders: false,
        eventContracts: true,
        fractional: false,
        extendedHours: false,
        overnightHours: false,
        trailingStops: false,
        nativeBrackets: false,
        orderTypes: ["limit", "market"],
        marketHours: ALL_SESSIONS,
        futuresTrading: false,
        cryptoTrading: false
      };
    default:
      return { equityTrading: true, shortSelling: false, optionsOrders: false };
  }
}

export function mergeAccountCapabilities(
  broker: ConnectedAccount["broker"] | undefined,
  live?: Partial<AccountCapabilities>
): AccountCapabilities {
  const known = knownBrokerLimits(broker);
  const base = emptyCapabilities(known);
  if (!live) return base;
  return {
    ...base,
    ...live,
    fractional: live.fractional ?? base.fractional,
    extendedHours: live.extendedHours ?? base.extendedHours,
    overnightHours: live.overnightHours ?? base.overnightHours,
    trailingStops: live.trailingStops ?? base.trailingStops,
    nativeBrackets: live.nativeBrackets ?? base.nativeBrackets,
    orderTypes: live.orderTypes ?? base.orderTypes,
    marketHours: live.marketHours ?? base.marketHours,
    minShareQuantity: live.minShareQuantity ?? base.minShareQuantity,
    minOrderNotional: live.minOrderNotional ?? base.minOrderNotional,
    positionIdCloses: live.positionIdCloses ?? base.positionIdCloses,
    shortSelling: known.shortSelling === false ? false : (live.shortSelling ?? base.shortSelling),
    optionsOrders: known.optionsOrders === false ? false : (live.optionsOrders ?? base.optionsOrders)
  };
}

export function brokerDisplayLabel(broker: ConnectedAccount["broker"] | undefined): string {
  switch (broker) {
    case "alpaca":
    case "alpaca-mcp":
      return "Alpaca";
    case "robinhood":
      return "Robinhood";
    case "tradier":
      return "Tradier";
    case "etoro":
      return "eToro";
    case "public":
      return "Public";
    case "webull":
      return "Webull";
    case "kalshi":
      return "Kalshi";
    case "test":
      return "Test";
    default:
      return "broker";
  }
}

export function resolveSessions(caps: AccountCapabilities): MarketHours[] {
  if (caps.marketHours?.length) return caps.marketHours as MarketHours[];
  const sessions: MarketHours[] = ["regular_hours"];
  if (caps.extendedHours) sessions.push("extended_hours");
  if (caps.overnightHours) sessions.push("all_day_hours");
  return sessions;
}

export function buildPromptLines(input: {
  brokerLabel: string;
  shortAllowed: boolean;
  caps: AccountCapabilities;
  orderTypes: OrderType[];
  marketHours: MarketHours[];
}): string[] {
  if (input.brokerLabel === "Kalshi") {
    return [
      "You are an autonomous event-contract trading agent for a Kalshi account.",
      "You trade binary CFTC-regulated event contracts (Yes/No outcomes priced $0.01–$0.99) on macro, economic, political, and financial indicators.",
      "Propose Yes contracts (side='buy') or No contracts (side='short' or side='cover' to exit) with integer share counts and limit prices in cents (e.g. 0.52 for 52¢).",
      `Allowed order types: ${input.orderTypes.join(", ")}.`
    ];
  }
  const lines: string[] = [
    `You are an autonomous equity trading agent for a ${input.brokerLabel} account.`
  ];
  if (input.shortAllowed) {
    lines.push(
      "SHORT SELLING IS ENABLED on this account.  In addition to buy/sell you MAY open SHORT positions (side='short') and close them with side='cover' (never 'sell' — a sell adds to a short)."
    );
  } else {
    lines.push(
      "SHORT SELLING IS DISABLED on this account.  Propose long-only: side is buy or sell.  Do not propose short.  " +
        "The one use of cover: a position listed with side 'short' (negative quantity) is an unintended short — close it with side='cover' for its held quantity, never 'sell' (a sell adds to a short) and never a bracketed 'buy'."
    );
  }
  if (!input.caps.optionsOrders) {
    lines.push(
      "OPTIONS ORDERS ARE NOT AVAILABLE on this strategy path.  Do not propose calls, puts, spreads, or option overlays — even as a hedge.  Equities only."
    );
  }
  if (input.caps.fractional !== true) {
    lines.push("Whole shares only.  Do not size an opening below one share.");
  }
  if (input.caps.minOrderNotional != null && input.caps.minOrderNotional > 0) {
    lines.push(`Minimum order notional is ${input.caps.minOrderNotional} in account currency.`);
  }
  if (!input.marketHours.includes("extended_hours") && !input.marketHours.includes("all_day_hours")) {
    lines.push("Regular-hours only.  Do not set marketHours to extended_hours or all_day_hours.");
  } else if (!input.marketHours.includes("all_day_hours")) {
    lines.push("Overnight / 24-hour session is not available.  Regular or extended hours only.");
  }
  if (!input.caps.trailingStops) {
    lines.push("This venue has no native trailing-stop parameter.  Do not request trailPercent.");
  }
  if (!input.caps.nativeBrackets) {
    lines.push("This venue has no native bracket/OTOCO legs.  Protective prices still belong in bracketStopLoss / stopPlan; the app will hold them.");
  }
  if (input.caps.positionIdCloses) {
    lines.push("Sells close an existing lot at this venue.  Never use sell to open a short.");
  }
  lines.push(`Allowed equity order types: ${input.orderTypes.join(", ")}.`);
  return lines;
}
