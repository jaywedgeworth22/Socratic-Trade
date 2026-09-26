/**
 * Position invariant at the single placement choke point (broker.ts getBrokerGateway).
 *
 * Production receipts this pins (Alpaca Paper, long-only mandate):
 *  - PG 2026-07-08: a standalone market SELL 12 went out while the account held ZERO PG, filled
 *    at the open, and opened a 12-share SHORT that took 2.5 months to close.
 *  - PG 2026-07 .. 09: twelve buy-to-cover proposals (side "buy" + bracket legs) were refused by
 *    Alpaca 422 "bracket orders must be entry orders" — the side-only constraint row never saw
 *    that a buy against a held short is a CLOSING order.
 *  - VZ 2026-09-21: a full-exit dollar sell ($1.34) became 0.027910851 shares against
 *    0.02778376 held — Alpaca 403 insufficient qty.
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_POLICY } from "../src/lib/defaults";
import type { EquityOrderInput, EquityPosition, TradeProposal, TradingPolicy } from "../src/lib/types";

// Warm the transform cache once (the module graph pulls in db.ts); every test re-imports after
// vi.resetModules, so class identity checks must use the SAME fresh module instance — import
// OrderValidationError dynamically next to the module under test, never statically.
beforeAll(async () => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-position-invariant-warm-${randomUUID()}.db`)}`;
  await import("../src/lib/order-position-invariant");
  await import("../src/lib/broker");
}, 240_000);

beforeEach(() => {
  vi.resetModules();
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-position-invariant-${randomUUID()}.db`)}`;
});

function order(patch: Partial<EquityOrderInput> = {}): EquityOrderInput {
  return {
    accountNumber: "PA33IDTHMFK9",
    symbol: "PG",
    side: "sell",
    type: "market",
    quantity: 12,
    timeInForce: "gfd",
    marketHours: "regular_hours",
    ...patch
  };
}

function position(patch: Partial<EquityPosition> = {}): EquityPosition {
  return { symbol: "PG", quantity: 12, averageCost: 150, marketValue: 1800, ...patch };
}

describe("applyPositionInvariant — pure rules", () => {
  it("refuses a SELL when the account holds no long (the PG short)", async () => {
    const { applyPositionInvariant, OrderPositionInvariantError } = await import("../src/lib/order-position-invariant");
    const { OrderValidationError } = await import("../src/lib/types");
    let caught: unknown;
    try {
      applyPositionInvariant(order(), { signedQuantity: 0 });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(OrderPositionInvariantError);
    expect(caught).toBeInstanceOf(OrderValidationError);
    expect((caught as InstanceType<typeof OrderPositionInvariantError>).code).toBe("sell_without_long");
    expect(String((caught as Error).message)).toMatch(/would open a SHORT/i);
    expect(String((caught as Error).message)).toMatch(/Nothing was sent to the broker/);
  });

  it("refuses a SELL against a held SHORT (a sell adds to the short; the verb is cover)", async () => {
    const { applyPositionInvariant } = await import("../src/lib/order-position-invariant");
    expect(() => applyPositionInvariant(order(), { signedQuantity: -12 })).toThrow(/cover/);
  });

  it("clamps a fractional SELL above the held long to the exact broker quantity (VZ 403)", async () => {
    const { applyPositionInvariant } = await import("../src/lib/order-position-invariant");
    const { input, receipts } = applyPositionInvariant(
      order({ symbol: "VZ", quantity: 0.027910851 }),
      { signedQuantity: 0.02778376, marketValue: 1.3339 }
    );
    expect(input.quantity).toBe(0.02778376);
    expect(JSON.stringify({ qty: input.quantity })).toBe('{"qty":0.02778376}');
    expect(receipts.map((r) => r.kind)).toContain("quantity_clamped_to_position");
  });

  it("resolves a full-exit DOLLAR sell to the exact held quantity (the VZ proposal shape)", async () => {
    const { applyPositionInvariant } = await import("../src/lib/order-position-invariant");
    const { input, receipts } = applyPositionInvariant(
      order({ symbol: "VZ", quantity: undefined, dollarAmount: 1.34 }),
      { signedQuantity: 0.02778376, marketValue: 1.3339 }
    );
    expect(input.quantity).toBe(0.02778376);
    expect(input.dollarAmount).toBeUndefined();
    expect(receipts.map((r) => r.kind)).toContain("dollar_exit_resolved_to_quantity");
  });

  it("leaves a PARTIAL dollar sell alone", async () => {
    const { applyPositionInvariant } = await import("../src/lib/order-position-invariant");
    const { input, receipts } = applyPositionInvariant(
      order({ quantity: undefined, dollarAmount: 500 }),
      { signedQuantity: 12, marketValue: 1800 }
    );
    expect(input.dollarAmount).toBe(500);
    expect(input.quantity).toBeUndefined();
    expect(receipts).toEqual([]);
  });

  it("treats a BUY against a held short as a cover: legs stripped, side cover (the 12x Alpaca 422)", async () => {
    const { applyPositionInvariant } = await import("../src/lib/order-position-invariant");
    const { input, receipts } = applyPositionInvariant(
      order({ side: "buy", type: "limit", limitPrice: 149.5, bracketStopLoss: 160, bracketTakeProfit: 140 }),
      { signedQuantity: -12, marketValue: -1797 }
    );
    expect(input.side).toBe("cover");
    expect(input.quantity).toBe(12);
    expect(input.limitPrice).toBe(149.5);
    expect(input.bracketStopLoss).toBeUndefined();
    expect(input.bracketTakeProfit).toBeUndefined();
    expect(receipts.map((r) => r.kind)).toEqual(
      expect.arrayContaining(["buy_against_short_is_cover", "closing_bracket_legs_stripped"])
    );
  });

  it("strips limit/stop price off a closing MARKET order (the Jul 16/22 Alpaca 422)", async () => {
    const { applyPositionInvariant } = await import("../src/lib/order-position-invariant");
    const { input, receipts } = applyPositionInvariant(
      order({ side: "cover", type: "market", limitPrice: 150, stopPrice: 155 }),
      { signedQuantity: -12 }
    );
    expect(input.limitPrice).toBeUndefined();
    expect(input.stopPrice).toBeUndefined();
    expect(receipts.map((r) => r.kind)).toContain("closing_market_price_fields_stripped");
  });

  it("refuses a COVER when the account holds no short (a cover would open a long)", async () => {
    const { applyPositionInvariant } = await import("../src/lib/order-position-invariant");
    expect(() => applyPositionInvariant(order({ side: "cover" }), { signedQuantity: 5 })).toThrow(/would open a LONG/i);
  });

  it("clamps a COVER above the held short", async () => {
    const { applyPositionInvariant } = await import("../src/lib/order-position-invariant");
    const { input } = applyPositionInvariant(order({ side: "cover", quantity: 20 }), { signedQuantity: -12 });
    expect(input.quantity).toBe(12);
  });

  it("strips bracket legs off a SELL of a held long", async () => {
    const { applyPositionInvariant } = await import("../src/lib/order-position-invariant");
    const { input } = applyPositionInvariant(
      order({ type: "limit", limitPrice: 160, bracketStopLoss: 140, bracketTakeProfit: 170 }),
      { signedQuantity: 12 }
    );
    expect(input.quantity).toBe(12);
    expect(input.bracketStopLoss).toBeUndefined();
    expect(input.bracketTakeProfit).toBeUndefined();
    expect(input.limitPrice).toBe(160);
  });

  it("leaves an opening BUY (flat or long) and its bracket legs untouched", async () => {
    const { applyPositionInvariant } = await import("../src/lib/order-position-invariant");
    const entry = order({ side: "buy", type: "limit", limitPrice: 152.75, bracketTakeProfit: 165, bracketStopLoss: 140 });
    for (const held of [0, 5]) {
      const { input, receipts } = applyPositionInvariant(entry, { signedQuantity: held });
      expect(input).toEqual(entry);
      expect(receipts).toEqual([]);
    }
  });

  it("fails CLOSED for a sell/cover when the position could not be verified, OPEN for a buy", async () => {
    const { applyPositionInvariant } = await import("../src/lib/order-position-invariant");
    expect(() => applyPositionInvariant(order(), undefined)).toThrow(/could not verify/i);
    expect(() => applyPositionInvariant(order({ side: "cover" }), undefined)).toThrow(/could not verify/i);
    const entry = order({ side: "buy", type: "limit", limitPrice: 150 });
    expect(applyPositionInvariant(entry, undefined).input).toEqual(entry);
  });

  it("never forwards the caller-verified position hint to the broker", async () => {
    const { applyPositionInvariant } = await import("../src/lib/order-position-invariant");
    const { input } = applyPositionInvariant(order({ verifiedPositionQuantity: 12 }), { signedQuantity: 12 });
    expect("verifiedPositionQuantity" in input).toBe(false);
  });
});

describe("withPositionInvariant — placement choke point", () => {
  function policy(patch: Partial<TradingPolicy> = {}): TradingPolicy {
    return { ...DEFAULT_POLICY, activeBroker: "alpaca", accountNumber: "PA33IDTHMFK9", connectedAccountId: "acct-paper", ...patch };
  }

  function stubGateway(positions: EquityPosition[] | (() => Promise<EquityPosition[]>)) {
    const seen: Array<EquityOrderInput & { refId: string }> = [];
    const gateway = {
      getEquityPositions: vi.fn(async () => (typeof positions === "function" ? positions() : positions)),
      placeEquityOrder: vi.fn(async (input: EquityOrderInput & { refId: string }) => {
        seen.push(input);
        return { orderId: "o1", refId: input.refId, state: "accepted", raw: {} };
      })
    };
    return { seen, gateway };
  }

  async function auditKinds(kind: string) {
    const db = await import("../src/lib/db");
    return db
      .getDb()
      .prepare("SELECT payload FROM audit_events WHERE kind = ?")
      .all(kind)
      .map((row) => JSON.parse((row as { payload: string }).payload));
  }

  it("refuses the PG market SELL 12 with zero PG held — nothing reaches the adapter", async () => {
    const { withPositionInvariant } = await import("../src/lib/order-position-invariant");
    const { OrderValidationError } = await import("../src/lib/types");
    const { seen, gateway } = stubGateway([position({ symbol: "AAPL", quantity: 3 })]);
    const wrapped = withPositionInvariant(gateway as never, policy(), "local");
    await expect(wrapped.placeEquityOrder({ ...order(), refId: "92d9e66d" })).rejects.toBeInstanceOf(OrderValidationError);
    expect(seen).toHaveLength(0);
    const refused = await auditKinds("order_position_invariant_refused");
    expect(refused).toEqual([expect.objectContaining({ symbol: "PG", side: "sell", code: "sell_without_long", refId: "92d9e66d" })]);
  });

  it("reads the position FRESH at placement, then reshapes and audits", async () => {
    const { withPositionInvariant } = await import("../src/lib/order-position-invariant");
    const { seen, gateway } = stubGateway([position({ symbol: "PG", quantity: -12, marketValue: -1797 })]);
    const wrapped = withPositionInvariant(gateway as never, policy(), "local");
    await wrapped.placeEquityOrder({
      ...order({ side: "buy", type: "limit", limitPrice: 149.5, bracketStopLoss: 160, bracketTakeProfit: 140 }),
      refId: "cover-1"
    });
    expect(gateway.getEquityPositions).toHaveBeenCalledWith("PA33IDTHMFK9");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ side: "cover", quantity: 12, refId: "cover-1" });
    expect(seen[0].bracketStopLoss).toBeUndefined();
    const reshaped = await auditKinds("order_position_invariant_reshaped");
    expect(reshaped.map((row) => row.receipt)).toEqual(
      expect.arrayContaining(["buy_against_short_is_cover", "closing_bracket_legs_stripped"])
    );
  });

  it("falls back to the caller-verified position when the fresh read fails (protective exit)", async () => {
    const { withPositionInvariant } = await import("../src/lib/order-position-invariant");
    const { seen, gateway } = stubGateway(async () => {
      throw new Error("alpaca getPositions timed out");
    });
    const wrapped = withPositionInvariant(gateway as never, policy(), "local");
    await wrapped.placeEquityOrder({
      ...order({ type: "stop_market", stopPrice: 140, quantity: 12, verifiedPositionQuantity: 12 }),
      refId: "protstop-1"
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ side: "sell", quantity: 12, refId: "protstop-1" });
    expect("verifiedPositionQuantity" in seen[0]).toBe(false);
    expect(await auditKinds("order_position_read_failed")).toHaveLength(1);
  });

  it("fails closed for an unverified sell when the fresh read fails", async () => {
    const { withPositionInvariant } = await import("../src/lib/order-position-invariant");
    const { seen, gateway } = stubGateway(async () => {
      throw new Error("alpaca getPositions timed out");
    });
    const wrapped = withPositionInvariant(gateway as never, policy(), "local");
    await expect(wrapped.placeEquityOrder({ ...order(), refId: "sell-1" })).rejects.toThrow(/could not verify/i);
    expect(seen).toHaveLength(0);
  });

  it("fails OPEN on a read failure where the broker's close verb is explicit (Tradier)", async () => {
    const { withPositionInvariant } = await import("../src/lib/order-position-invariant");
    const { seen, gateway } = stubGateway(async () => {
      throw new Error("tradier positions 503");
    });
    const wrapped = withPositionInvariant(gateway as never, policy({ activeBroker: "tradier" }), "local");
    await wrapped.placeEquityOrder({ ...order(), refId: "tr-sell-1" });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ side: "sell", quantity: 12 });
    const failed = await auditKinds("order_position_read_failed");
    expect(failed).toEqual([expect.objectContaining({ refId: "tr-sell-1", fallback: "broker_enforces_close_verb" })]);
  });

  it("never reads positions for a Robinhood buy (Robinhood cannot hold a short)", async () => {
    const { withPositionInvariant } = await import("../src/lib/order-position-invariant");
    const { seen, gateway } = stubGateway([]);
    const wrapped = withPositionInvariant(gateway as never, policy({ activeBroker: "robinhood" }), "local");
    await wrapped.placeEquityOrder({ ...order({ side: "buy", type: "limit", limitPrice: 150 }), refId: "rh-buy-1" });
    expect(gateway.getEquityPositions).not.toHaveBeenCalled();
    expect(seen).toHaveLength(1);
  });

  it("never reads positions for an intended SHORT entry", async () => {
    const { withPositionInvariant } = await import("../src/lib/order-position-invariant");
    const { seen, gateway } = stubGateway([]);
    const wrapped = withPositionInvariant(gateway as never, policy(), "local");
    await wrapped.placeEquityOrder({ ...order({ side: "short", bracketStopLoss: 160 }), refId: "short-1" });
    expect(gateway.getEquityPositions).not.toHaveBeenCalled();
    expect(seen[0]).toMatchObject({ side: "short", bracketStopLoss: 160 });
  });

  it("does not read positions or reshape for brokers outside the invariant's scope", async () => {
    const { withPositionInvariant } = await import("../src/lib/order-position-invariant");
    const { seen, gateway } = stubGateway([]);
    const wrapped = withPositionInvariant(gateway as never, policy({ activeBroker: "kalshi" as TradingPolicy["activeBroker"] }), "local");
    await wrapped.placeEquityOrder({ ...order(), refId: "k-1" });
    expect(gateway.getEquityPositions).not.toHaveBeenCalled();
    expect(seen).toHaveLength(1);
  });

  it("is composed into getBrokerGateway (test broker: no lots -> sell refused)", async () => {
    const { getBrokerGateway } = await import("../src/lib/broker");
    const { upsertConnectedAccount } = await import("../src/lib/db");
    upsertConnectedAccount({
      id: "acct-test",
      userId: "local",
      broker: "test",
      environment: "paper",
      accountNumber: "TEST",
      label: "Test broker",
      isActive: true
    });
    const gateway = getBrokerGateway(
      policy({ activeBroker: "test", accountNumber: "TEST", connectedAccountId: "acct-test" }),
      "local"
    );
    await expect(
      gateway.placeEquityOrder({ ...order({ accountNumber: "TEST" }), refId: "test-sell-1" })
    ).rejects.toThrow(/would open a SHORT/i);
  });
});

describe("normalizeExitSideForHeldPosition — the correct verb for closing a short", () => {
  function proposal(patch: Partial<TradeProposal> = {}): TradeProposal {
    return {
      symbol: "PG",
      side: "sell",
      type: "market",
      quantity: 12,
      timeInForce: "gfd",
      marketHours: "regular_hours",
      rationale: "Exit the PG position.",
      confidenceScore: 0.6,
      tradeThesisTag: "Risk-Exit",
      entryMarketRegime: "neutral",
      ...patch
    } as TradeProposal;
  }

  it("rewrites an LLM market SELL on a held short into a COVER for the held quantity (long-only venue)", async () => {
    const { normalizeExitSideForHeldPosition } = await import("../src/lib/order-position-invariant");
    const { proposal: next, change } = normalizeExitSideForHeldPosition(
      proposal({ bracketStopLoss: 160 }),
      [position({ quantity: -12, marketValue: -1797 })],
      { convertSellToCover: true }
    );
    expect(next.side).toBe("cover");
    expect(next.quantity).toBe(12);
    expect(next.bracketStopLoss).toBeUndefined();
    expect(next.rationale).toMatch(/cover/i);
    expect(change).toMatchObject({ from: "sell", to: "cover", heldShortQuantity: 12 });
  });

  it("rewrites a dollar SELL at least the size of a held short into a COVER of the whole short (long-only venue)", async () => {
    const { normalizeExitSideForHeldPosition } = await import("../src/lib/order-position-invariant");
    const { proposal: next } = normalizeExitSideForHeldPosition(
      proposal({ quantity: undefined, dollarAmount: 5000 }),
      [position({ quantity: -12, marketValue: -1797 })],
      { convertSellToCover: true }
    );
    expect(next.side).toBe("cover");
    expect(next.quantity).toBe(12);
    expect(next.dollarAmount).toBeUndefined();
  });

  it("rewrites a BUY (with bracket legs) of at most the held short into a COVER", async () => {
    const { normalizeExitSideForHeldPosition } = await import("../src/lib/order-position-invariant");
    const { proposal: next, change } = normalizeExitSideForHeldPosition(
      proposal({ side: "buy", type: "limit", limitPrice: 149, bracketStopLoss: 140, bracketTakeProfit: 165 }),
      [position({ quantity: -12, marketValue: -1797 })]
    );
    expect(next.side).toBe("cover");
    expect(next.bracketStopLoss).toBeUndefined();
    expect(next.bracketTakeProfit).toBeUndefined();
    expect(change).toMatchObject({ from: "buy", to: "cover" });
  });

  it("leaves a sell of a held long, and a buy with no short, untouched", async () => {
    const { normalizeExitSideForHeldPosition } = await import("../src/lib/order-position-invariant");
    const sell = proposal();
    expect(normalizeExitSideForHeldPosition(sell, [position()]).proposal).toBe(sell);
    const buy = proposal({ side: "buy", bracketStopLoss: 140 });
    expect(normalizeExitSideForHeldPosition(buy, []).proposal).toBe(buy);
  });

  it("labels each prompt position long/short so the strategist sees the sign", async () => {
    const { withPositionSides } = await import("../src/lib/order-position-invariant");
    expect(withPositionSides([position({ quantity: -12 }), position({ symbol: "AAPL", quantity: 3 })])).toEqual([
      expect.objectContaining({ symbol: "PG", quantity: -12, side: "short" }),
      expect.objectContaining({ symbol: "AAPL", quantity: 3, side: "long" })
    ]);
  });
});

describe("strategist prompt — the correct verb for a held short", () => {
  it("long-only accounts are still told to close an unintended short with cover, never sell", async () => {
    const { buildBullSystem } = await import("../src/lib/strategy-prompts");
    const text = buildBullSystem({
      shortAllowed: false,
      executionMode: "broker/paper",
      executionModeClarification: "",
      strategyPrompt: "",
      hasTaxContext: false
    } as never);
    expect(text).toContain("SHORT SELLING IS DISABLED");
    expect(text).toMatch(/side 'short'.*close it with side='cover'/);
    expect(text).toMatch(/never 'sell'/);

    const { buildPromptLines, emptyCapabilities } = await import("../src/lib/venue-contract-pure");
    const lines = buildPromptLines({
      brokerLabel: "Alpaca",
      shortAllowed: false,
      caps: emptyCapabilities({ equityTrading: true }),
      orderTypes: ["market", "limit"],
      marketHours: ["regular_hours"]
    });
    const disabled = lines.find((line) => line.includes("SHORT SELLING IS DISABLED")) ?? "";
    expect(disabled).toMatch(/close it with side='cover'/);
  });
});

// Review round 2026-09-25 (PR #3759 follow-up): dollar-sized buys against a held short, the
// autopilot sell -> cover flip on shorting-enabled venues, the long-only schema/prompt mismatch,
// and a transient position-read failure booked as terminal "blocked".
describe("review round — dollar-sized buys against a held short (P1)", () => {
  it("reshapes a DOLLAR buy of less than the held short into a whole-share cover without legs", async () => {
    const { applyPositionInvariant } = await import("../src/lib/order-position-invariant");
    const { input, receipts } = applyPositionInvariant(
      order({
        symbol: "TSLA",
        side: "buy",
        type: "limit",
        limitPrice: 250,
        quantity: undefined,
        dollarAmount: 500,
        bracketStopLoss: 230,
        bracketTakeProfit: 280
      }),
      { signedQuantity: -10, marketValue: -2500 }
    );
    expect(input.side).toBe("cover");
    expect(input.quantity).toBe(2);
    expect(input.dollarAmount).toBeUndefined();
    expect(input.limitPrice).toBe(250);
    expect(input.bracketStopLoss).toBeUndefined();
    expect(input.bracketTakeProfit).toBeUndefined();
    expect(receipts.map((r) => r.kind)).toEqual(
      expect.arrayContaining(["buy_against_short_is_cover", "dollar_exit_resolved_to_quantity", "closing_bracket_legs_stripped"])
    );
  });

  it("resolves a DOLLAR buy within 2% of the held short to the full short (the PG shape, dollar-sized)", async () => {
    const { applyPositionInvariant } = await import("../src/lib/order-position-invariant");
    const { input } = applyPositionInvariant(
      order({ side: "buy", type: "market", quantity: undefined, dollarAmount: 1790, bracketStopLoss: 160 }),
      { signedQuantity: -12, marketValue: -1797 }
    );
    expect(input).toMatchObject({ side: "cover", quantity: 12 });
    expect(input.dollarAmount).toBeUndefined();
    expect(input.bracketStopLoss).toBeUndefined();
  });

  it("leaves a DOLLAR buy larger than the held short, or smaller than one share of it, unchanged", async () => {
    const { applyPositionInvariant } = await import("../src/lib/order-position-invariant");
    const oversized = order({ symbol: "TSLA", side: "buy", type: "market", quantity: undefined, dollarAmount: 4000 });
    expect(applyPositionInvariant(oversized, { signedQuantity: -10, marketValue: -2500 }).input).toEqual(oversized);
    const subShare = order({ symbol: "TSLA", side: "buy", type: "market", quantity: undefined, dollarAmount: 100 });
    expect(applyPositionInvariant(subShare, { signedQuantity: -10, marketValue: -2500 }).input).toEqual(subShare);
  });

  it("normalizes an LLM DOLLAR buy of a held short into a cover before sizing (upstream pass)", async () => {
    const { normalizeExitSideForHeldPosition } = await import("../src/lib/order-position-invariant");
    const { proposal: next, change } = normalizeExitSideForHeldPosition(
      {
        symbol: "TSLA",
        side: "buy",
        type: "limit",
        limitPrice: 250,
        dollarAmount: 500,
        bracketStopLoss: 230,
        timeInForce: "gfd",
        marketHours: "regular_hours",
        rationale: "Reduce the TSLA short.",
        confidenceScore: 60,
        tradeThesisTag: "Risk-Exit",
        entryMarketRegime: "neutral"
      } as TradeProposal,
      [position({ symbol: "TSLA", quantity: -10, marketValue: -2500 })]
    );
    expect(next).toMatchObject({ side: "cover", quantity: 2, limitPrice: 250 });
    expect(next.dollarAmount).toBeUndefined();
    expect(next.bracketStopLoss).toBeUndefined();
    expect(change).toMatchObject({ from: "buy", to: "cover", quantity: 2, heldShortQuantity: 10 });
  });
});

describe("review round — the autopilot sell -> cover flip (P2)", () => {
  function sellProposal(patch: Partial<TradeProposal> = {}): TradeProposal {
    return {
      symbol: "XYZ",
      side: "sell",
      type: "market",
      quantity: 50,
      timeInForce: "gfd",
      marketHours: "regular_hours",
      rationale: "Sell XYZ.",
      confidenceScore: 60,
      tradeThesisTag: "Risk-Exit",
      entryMarketRegime: "neutral",
      ...patch
    } as TradeProposal;
  }
  const shortXyz = [position({ symbol: "XYZ", quantity: -100, marketValue: -5000 })];

  it("does not flip a sell of a held short by default (a shorting-enabled venue refuses it with the correct verb)", async () => {
    const { normalizeExitSideForHeldPosition } = await import("../src/lib/order-position-invariant");
    const sell = sellProposal({ type: "limit", limitPrice: 55 });
    expect(normalizeExitSideForHeldPosition(sell, shortXyz).proposal).toBe(sell);
  });

  it("never carries a sell-side limit/stop price onto a cover, even on a long-only venue", async () => {
    const { normalizeExitSideForHeldPosition } = await import("../src/lib/order-position-invariant");
    for (const patch of [
      { type: "limit" as const, limitPrice: 55 },
      { type: "stop_market" as const, stopPrice: 45 },
      { type: "stop_limit" as const, stopPrice: 45, limitPrice: 44 }
    ]) {
      const sell = sellProposal(patch);
      expect(normalizeExitSideForHeldPosition(sell, shortXyz, { convertSellToCover: true }).proposal).toBe(sell);
    }
  });

  it("caps a DOLLAR sell at its own dollar size, not the whole short (long-only venue)", async () => {
    const { normalizeExitSideForHeldPosition } = await import("../src/lib/order-position-invariant");
    const { proposal: next } = normalizeExitSideForHeldPosition(
      sellProposal({ quantity: undefined, dollarAmount: 200 }),
      shortXyz,
      { convertSellToCover: true }
    );
    expect(next).toMatchObject({ side: "cover", quantity: 4 });
    expect(next.dollarAmount).toBeUndefined();
  });

  it("strips a stray limit/stop price off a flipped MARKET sell", async () => {
    const { normalizeExitSideForHeldPosition } = await import("../src/lib/order-position-invariant");
    const { proposal: next } = normalizeExitSideForHeldPosition(
      sellProposal({ limitPrice: 55 }),
      shortXyz,
      { convertSellToCover: true }
    );
    expect(next).toMatchObject({ side: "cover", type: "market", quantity: 50 });
    expect(next.limitPrice).toBeUndefined();
  });
});

describe("review round — long-only schema offers the verb the prompt names (P2)", () => {
  it("adds cover to a long-only side enum only while a short is held", async () => {
    const { proposalSidesForHeldPositions } = await import("../src/lib/order-position-invariant");
    const short = [position({ quantity: -12 })];
    expect(proposalSidesForHeldPositions(["buy", "sell"], short)).toEqual(["buy", "sell", "cover"]);
    expect(proposalSidesForHeldPositions(["buy", "sell"], [position()])).toEqual(["buy", "sell"]);
    expect(proposalSidesForHeldPositions(["buy", "sell", "short", "cover"], short)).toEqual(["buy", "sell", "short", "cover"]);
    // A parked venue (no sides at all) stays parked.
    expect(proposalSidesForHeldPositions([], short)).toEqual([]);
  });

  it("the long-only prompt's close verb is in the schema enum, and the repair path keeps it", async () => {
    const { proposalSidesForHeldPositions } = await import("../src/lib/order-position-invariant");
    const { buildBullSystem } = await import("../src/lib/strategy-prompts");
    const { filterRepairedProposals } = await import("../src/lib/strategy");
    const { deriveVenueContract } = await import("../src/lib/venue-contract");
    const venue = deriveVenueContract({ shortSellingEnabled: false }, { broker: "alpaca", capabilities: undefined } as never);
    expect(venue.sides).toEqual(["buy", "sell"]);
    const enumSides = proposalSidesForHeldPositions(venue.sides, [position({ quantity: -12, marketValue: -1797 })]);
    const prompt = buildBullSystem({
      shortAllowed: venue.sides.includes("short"),
      venueLines: venue.promptLines,
      executionMode: "broker/paper",
      executionModeClarification: "",
      strategyPrompt: "",
      hasTaxContext: false
    } as never);
    const instructed = [...prompt.matchAll(/side='(buy|sell|short|cover)'/g)].map((m) => m[1]);
    expect(instructed).toContain("cover");
    for (const side of instructed) expect(enumSides).toContain(side);
    const { kept } = filterRepairedProposals(
      [
        {
          symbol: "PG",
          side: "cover",
          type: "market",
          quantity: 12,
          dollarAmount: null,
          limitPrice: null,
          stopPrice: null,
          timeInForce: "gfd",
          marketHours: "regular_hours",
          rationale: "Close the unintended PG short.",
          tradeThesisTag: "Risk-Exit",
          confidenceScore: 80,
          autonomyOverride: null,
          bracketStopLoss: null,
          bracketTakeProfit: null,
          exitPlan: "Full exit.",
          stopPlan: null
        }
      ],
      enumSides,
      ["PG"]
    );
    expect(kept.map((p) => p.side)).toEqual(["cover"]);
  });
});

describe("review round — a transient position-read failure is retryable, not blocked (P2)", () => {
  it("marks position_unverified retryable and says so in the refusal text", async () => {
    const { applyPositionInvariant, isRetryablePositionInvariantError } = await import("../src/lib/order-position-invariant");
    let caught: unknown;
    try {
      applyPositionInvariant(order(), undefined);
    } catch (error) {
      caught = error;
    }
    expect(isRetryablePositionInvariantError(caught)).toBe(true);
    expect(String((caught as Error).message)).toMatch(/safe to retry/i);
    expect(String((caught as Error).message)).not.toMatch(/next run or reconcile/i);
    let refused: unknown;
    try {
      applyPositionInvariant(order(), { signedQuantity: 0 });
    } catch (error) {
      refused = error;
    }
    expect(isRetryablePositionInvariantError(refused)).toBe(false);
    expect(isRetryablePositionInvariantError(new Error("x"))).toBe(false);
  });
});
