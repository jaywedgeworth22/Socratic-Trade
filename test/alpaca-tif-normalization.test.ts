/**
 * Alpaca time-in-force normalization (item 10, Codex review): Alpaca rejects a GTC order carrying
 * a fractional share quantity or a notional (dollar) amount — both require time_in_force="day"
 * (docs.alpaca.markets). `resolveAlpacaTimeInForce` (and its three call sites in placeEquityOrder —
 * REST, MCP, and native trailing) normalize instead of letting the broker bounce the order with a
 * 422, and audit the normalization so the caller's original intent isn't silently lost.
 *
 * All Alpaca API calls are mocked — no real orders are ever placed.
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveAlpacaTimeInForce } from "../src/lib/alpaca";

let lastCreateOrderOpts: any = null;

vi.mock("@alpacahq/alpaca-trade-api", () => {
  return {
    default: class MockAlpaca {
      async getAccount() {
        return { account_number: "MOCK_ACC", portfolio_value: "50000", buying_power: "25000", equity: "40000", cash: "10000" };
      }
      async getPositions() { return []; }
      async getOrders() { return []; }
      async createOrder(opts: any) {
        lastCreateOrderOpts = opts;
        return { id: "tif_order_1", status: "accepted", qty: opts.qty, filled_qty: "0", filled_avg_price: null };
      }
      async cancelOrder() { /* not exercised here */ }
    }
  };
});

async function lastAuditPayload(kind: string): Promise<Record<string, unknown> | undefined> {
  const { getDb } = await import("../src/lib/db");
  const rows = getDb()
    .prepare("SELECT payload FROM audit_events WHERE kind = ? ORDER BY created_at DESC LIMIT 1")
    .all(kind) as Array<{ payload: string }>;
  return rows[0] ? (JSON.parse(rows[0].payload) as Record<string, unknown>) : undefined;
}

beforeEach(async () => {
  vi.resetModules();
  vi.unstubAllEnvs();
  lastCreateOrderOpts = null;
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-alpaca-tif-${randomUUID()}.db`)}`;

  const { upsertConnectedAccount } = await import("../src/lib/db");
  upsertConnectedAccount({
    id: "acc-tif-test",
    userId: "local",
    broker: "alpaca",
    environment: "paper",
    baseUrl: "https://paper-api.alpaca.markets",
    apiKey: "PK_TEST",
    apiSecret: "secret",
    isActive: true,
    label: "Alpaca Paper TIF"
  });
});

describe("resolveAlpacaTimeInForce (pure resolution matrix)", () => {
  it("a whole-share GTC quantity order stays GTC — unchanged", () => {
    const r = resolveAlpacaTimeInForce({ requestedTimeInForce: "gtc", isBracket: false, quantity: 10 });
    expect(r).toEqual({ timeInForce: "gtc", normalized: false, reason: undefined });
  });

  it("a fractional-quantity GTC order normalizes to day", () => {
    const r = resolveAlpacaTimeInForce({ requestedTimeInForce: "gtc", isBracket: false, quantity: 2.5 });
    expect(r.timeInForce).toBe("day");
    expect(r.normalized).toBe(true);
    expect(r.reason).toBe("fractional_quantity");
  });

  it("a notional (dollar) GTC order normalizes to day", () => {
    const r = resolveAlpacaTimeInForce({ requestedTimeInForce: "gtc", isBracket: false, notional: 500 });
    expect(r.timeInForce).toBe("day");
    expect(r.normalized).toBe(true);
    expect(r.reason).toBe("notional");
  });

  it("a bracket forces day for its own pre-existing reason — NOT counted as this item's normalization", () => {
    const r = resolveAlpacaTimeInForce({ requestedTimeInForce: "gtc", isBracket: true, quantity: 10 });
    expect(r.timeInForce).toBe("day");
    expect(r.normalized).toBe(false); // whole-share bracket: not fractional/notional, just bracket-forced
    expect(r.reason).toBeUndefined();
  });

  it("an already-'gfd' request resolves to day but is not flagged 'normalized' (nothing was overridden)", () => {
    const r = resolveAlpacaTimeInForce({ requestedTimeInForce: "gfd", isBracket: false, quantity: 2.5 });
    expect(r.timeInForce).toBe("day");
    expect(r.normalized).toBe(false);
  });

  it("a whole-share quantity with no notional stays GTC even when notional is explicitly undefined", () => {
    const r = resolveAlpacaTimeInForce({ requestedTimeInForce: "gtc", isBracket: false, quantity: 5, notional: undefined });
    expect(r.timeInForce).toBe("gtc");
    expect(r.normalized).toBe(false);
  });

  it("an extended-hours GTC order normalizes to day (Alpaca extended-hours is day-only)", () => {
    const r = resolveAlpacaTimeInForce({ requestedTimeInForce: "gtc", isBracket: false, quantity: 10, extendedHours: true });
    expect(r.timeInForce).toBe("day");
    expect(r.normalized).toBe(true);
    expect(r.reason).toBe("extended_hours");
  });

  it("an extended-hours order that already asked for day is not flagged normalized", () => {
    const r = resolveAlpacaTimeInForce({ requestedTimeInForce: "day", isBracket: false, quantity: 10, extendedHours: true });
    expect(r.timeInForce).toBe("day");
    expect(r.normalized).toBe(false);
  });
});

describe("Alpaca placeEquityOrder — tif normalization end-to-end", () => {
  it("fractional quantity + GTC submits as time_in_force=day and audits the normalization", async () => {
    const { getAlpacaGateway } = await import("../src/lib/alpaca");
    const gateway = getAlpacaGateway("local");

    await gateway.placeEquityOrder({
      accountNumber: "MOCK_ACC",
      symbol: "AAPL",
      side: "buy",
      type: "market",
      quantity: 2.5,
      timeInForce: "gtc",
      marketHours: "regular_hours",
      refId: "tif-fractional-1"
    });

    expect(lastCreateOrderOpts.time_in_force).toBe("day");
    expect(lastCreateOrderOpts.qty).toBe(2.5);
    const payload = await lastAuditPayload("alpaca_tif_normalized_to_day");
    expect(payload).toMatchObject({ symbol: "AAPL", requestedTimeInForce: "gtc", reason: "fractional_quantity", quantity: 2.5 });
  });

  it("notional (dollar) + GTC submits as time_in_force=day and audits the normalization", async () => {
    const { getAlpacaGateway } = await import("../src/lib/alpaca");
    const gateway = getAlpacaGateway("local");

    await gateway.placeEquityOrder({
      accountNumber: "MOCK_ACC",
      symbol: "TSLA",
      side: "buy",
      type: "market",
      dollarAmount: 500,
      timeInForce: "gtc",
      marketHours: "regular_hours",
      refId: "tif-notional-1"
    });

    expect(lastCreateOrderOpts.time_in_force).toBe("day");
    expect(lastCreateOrderOpts.notional).toBe(500);
    expect(lastCreateOrderOpts.qty).toBeUndefined();
    const payload = await lastAuditPayload("alpaca_tif_normalized_to_day");
    expect(payload).toMatchObject({ symbol: "TSLA", requestedTimeInForce: "gtc", reason: "notional", dollarAmount: 500 });
  });

  it("a whole-share quantity + GTC order is left UNCHANGED — no normalization, no audit receipt", async () => {
    const { getAlpacaGateway } = await import("../src/lib/alpaca");
    const gateway = getAlpacaGateway("local");

    await gateway.placeEquityOrder({
      accountNumber: "MOCK_ACC",
      symbol: "MSFT",
      side: "buy",
      type: "market",
      quantity: 10,
      timeInForce: "gtc",
      marketHours: "regular_hours",
      refId: "tif-whole-1"
    });

    expect(lastCreateOrderOpts.time_in_force).toBe("gtc");
    expect(lastCreateOrderOpts.qty).toBe(10);
    const payload = await lastAuditPayload("alpaca_tif_normalized_to_day");
    expect(payload).toBeUndefined();
  });

  it("a fractional-quantity NATIVE TRAILING stop also normalizes GTC to day", async () => {
    const { getAlpacaGateway } = await import("../src/lib/alpaca");
    const gateway = getAlpacaGateway("local");

    await gateway.placeEquityOrder({
      accountNumber: "MOCK_ACC",
      symbol: "NVDA",
      side: "sell",
      type: "stop_market",
      quantity: 3.25,
      trailPercent: 5,
      timeInForce: "gtc",
      marketHours: "regular_hours",
      refId: "tif-trailing-fractional-1"
    });

    expect(lastCreateOrderOpts.type).toBe("trailing_stop");
    expect(lastCreateOrderOpts.time_in_force).toBe("day");
    const payload = await lastAuditPayload("alpaca_tif_normalized_to_day");
    expect(payload).toMatchObject({ symbol: "NVDA", reason: "fractional_quantity" });
  });

  it("a whole-share NATIVE TRAILING stop stays GTC (unchanged) — matches the pre-existing behavior", async () => {
    const { getAlpacaGateway } = await import("../src/lib/alpaca");
    const gateway = getAlpacaGateway("local");

    await gateway.placeEquityOrder({
      accountNumber: "MOCK_ACC",
      symbol: "AAPL",
      side: "sell",
      type: "stop_market",
      quantity: 10,
      trailPercent: 5,
      timeInForce: "gtc",
      marketHours: "regular_hours",
      refId: "tif-trailing-whole-1"
    });

    expect(lastCreateOrderOpts.time_in_force).toBe("gtc");
    const payload = await lastAuditPayload("alpaca_tif_normalized_to_day");
    expect(payload).toBeUndefined();
  });

  it("brackets with a fractional (dollar) entry still protect: the dollar bracket resolves to a WHOLE-share qty and stays 'day' for the pre-existing bracket reason, not double-flagged as this item's normalization", async () => {
    const { getAlpacaGateway } = await import("../src/lib/alpaca");
    const gateway = getAlpacaGateway("local");

    await gateway.placeEquityOrder({
      accountNumber: "MOCK_ACC",
      symbol: "AMZN",
      side: "buy",
      type: "limit",
      dollarAmount: 2050,
      limitPrice: 200, // qty = floor(2050 / 200) = 10 (whole)
      timeInForce: "gtc",
      marketHours: "regular_hours",
      bracketTakeProfit: 230,
      bracketStopLoss: 185,
      refId: "tif-bracket-fractional-entry"
    });

    expect(lastCreateOrderOpts.order_class).toBe("bracket");
    expect(lastCreateOrderOpts.time_in_force).toBe("day");
    expect(lastCreateOrderOpts.qty).toBe(10);
    expect(lastCreateOrderOpts.notional).toBeUndefined();
    // Bracket forces "day" for its own pre-existing, unrelated reason (native OCO support) — this
    // item's fractional/notional normalization audit must not fire for it.
    const payload = await lastAuditPayload("alpaca_tif_normalized_to_day");
    expect(payload).toBeUndefined();
  });

  it("a whole-share GFD order (no gtc requested) is never flagged 'normalized' even though it resolves to day", async () => {
    const { getAlpacaGateway } = await import("../src/lib/alpaca");
    const gateway = getAlpacaGateway("local");

    await gateway.placeEquityOrder({
      accountNumber: "MOCK_ACC",
      symbol: "SPY",
      side: "buy",
      type: "market",
      quantity: 4,
      timeInForce: "gfd",
      marketHours: "regular_hours",
      refId: "tif-gfd-1"
    });

    expect(lastCreateOrderOpts.time_in_force).toBe("day");
    const payload = await lastAuditPayload("alpaca_tif_normalized_to_day");
    expect(payload).toBeUndefined();
  });
});
