/**
 * Regression: an Alpaca LIMIT (or market) order must never carry a stop_price.
 *
 * Alpaca rejects it with HTTP 422 {"code":40010001,"message":"limit orders require no stop
 * price"} — the most likely cause of today's (2026-07-15) repeated "order rejected by broker"
 * SMS for BAC/USB/EQT/PG/T, and the exact 422 the Alpaca Paper account hit for BAC on 2026-07-10.
 * A proposal may carry a protective stopPrice idea; that intent rides the bracket stop_loss /
 * protective-stop systems, never the top-level order stop_price. Only stop-family order types
 * (stop_market / stop_limit) may set it.
 *
 * All Alpaca API calls are mocked — no real orders are ever placed.
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
        return { id: "order_1", status: "accepted", qty: opts.qty, filled_qty: "0", filled_avg_price: null };
      }
      async cancelOrder() {}
    }
  };
});

async function seedRestAccount(): Promise<void> {
  const { upsertConnectedAccount } = await import("../src/lib/db");
  upsertConnectedAccount({
    id: "acc-rest",
    userId: "local",
    broker: "alpaca",
    environment: "paper",
    baseUrl: "https://paper-api.alpaca.markets",
    apiKey: "PK_TEST",
    apiSecret: "secret",
    isActive: true,
    label: "Alpaca Paper"
  });
}

async function seedMcpAccount(): Promise<void> {
  const { upsertConnectedAccount } = await import("../src/lib/db");
  upsertConnectedAccount({
    id: "acc-mcp",
    userId: "local",
    broker: "alpaca-mcp",
    environment: "paper",
    baseUrl: "http://localhost:8000/sse",
    apiKey: "PK_TEST",
    apiSecret: "secret",
    isActive: true,
    label: "Alpaca Paper MCP"
  });
}

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  lastCreateOrderOpts = null;
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-alpaca-stopguard-${randomUUID()}.db`)}`;
});

describe("Alpaca REST path — stop_price gating by order type", () => {
  it("does NOT set stop_price on a LIMIT order even when stopPrice is provided (422 regression)", async () => {
    await seedRestAccount();
    const { getAlpacaGateway } = await import("../src/lib/alpaca");
    await getAlpacaGateway("local").placeEquityOrder({
      accountNumber: "MOCK_ACC",
      symbol: "BAC",
      side: "buy",
      type: "limit",
      quantity: 5,
      limitPrice: 42.5,
      stopPrice: 40, // a protective idea that must NOT leak onto a limit order
      timeInForce: "gfd",
      marketHours: "regular_hours",
      refId: "ref-limit-1"
    });
    expect(lastCreateOrderOpts).not.toBeNull();
    expect(lastCreateOrderOpts.type).toBe("limit");
    expect(lastCreateOrderOpts.limit_price).toBe(42.5);
    expect(lastCreateOrderOpts).not.toHaveProperty("stop_price");
  });

  it("does NOT set stop_price on a MARKET order even when stopPrice is provided", async () => {
    await seedRestAccount();
    const { getAlpacaGateway } = await import("../src/lib/alpaca");
    await getAlpacaGateway("local").placeEquityOrder({
      accountNumber: "MOCK_ACC",
      symbol: "USB",
      side: "buy",
      type: "market",
      quantity: 3,
      stopPrice: 30,
      timeInForce: "gfd",
      marketHours: "regular_hours",
      refId: "ref-market-1"
    });
    expect(lastCreateOrderOpts.type).toBe("market");
    expect(lastCreateOrderOpts).not.toHaveProperty("stop_price");
  });

  it("does NOT set limit_price on a MARKET order even when limitPrice is provided (PG 422, Jul 16/22)", async () => {
    // Alpaca 422 "market orders require no stop or limit price": a closing market cover for the
    // unintended PG short carried the proposal's limitPrice/stopPrice and was refused twice.
    await seedRestAccount();
    const { getAlpacaGateway } = await import("../src/lib/alpaca");
    await getAlpacaGateway("local").placeEquityOrder({
      accountNumber: "MOCK_ACC",
      symbol: "PG",
      side: "cover",
      type: "market",
      quantity: 12,
      limitPrice: 150.1,
      stopPrice: 155,
      timeInForce: "gfd",
      marketHours: "regular_hours",
      refId: "ref-market-cover-1"
    });
    expect(lastCreateOrderOpts.type).toBe("market");
    expect(lastCreateOrderOpts.side).toBe("buy");
    expect(lastCreateOrderOpts).not.toHaveProperty("limit_price");
    expect(lastCreateOrderOpts).not.toHaveProperty("stop_price");
  });

  it("does NOT set limit_price on a STOP_MARKET order", async () => {
    await seedRestAccount();
    const { getAlpacaGateway } = await import("../src/lib/alpaca");
    await getAlpacaGateway("local").placeEquityOrder({
      accountNumber: "MOCK_ACC",
      symbol: "PG",
      side: "sell",
      type: "stop_market",
      quantity: 12,
      limitPrice: 150,
      stopPrice: 140,
      timeInForce: "gtc",
      marketHours: "regular_hours",
      refId: "ref-stop-market-limit-1"
    });
    expect(lastCreateOrderOpts.type).toBe("stop");
    expect(lastCreateOrderOpts.stop_price).toBe(140);
    expect(lastCreateOrderOpts).not.toHaveProperty("limit_price");
  });

  it("DOES set stop_price on a stop_market order (positive control)", async () => {
    await seedRestAccount();
    const { getAlpacaGateway } = await import("../src/lib/alpaca");
    await getAlpacaGateway("local").placeEquityOrder({
      accountNumber: "MOCK_ACC",
      symbol: "EQT",
      side: "sell",
      type: "stop_market",
      quantity: 4,
      stopPrice: 55.25,
      timeInForce: "gfd",
      marketHours: "regular_hours",
      refId: "ref-stop-1"
    });
    expect(lastCreateOrderOpts.type).toBe("stop");
    expect(lastCreateOrderOpts.stop_price).toBe(55.25);
  });

  it("DOES set stop_price on a stop_limit order (positive control)", async () => {
    await seedRestAccount();
    const { getAlpacaGateway } = await import("../src/lib/alpaca");
    await getAlpacaGateway("local").placeEquityOrder({
      accountNumber: "MOCK_ACC",
      symbol: "PG",
      side: "sell",
      type: "stop_limit",
      quantity: 2,
      limitPrice: 160,
      stopPrice: 158,
      timeInForce: "gfd",
      marketHours: "regular_hours",
      refId: "ref-stoplimit-1"
    });
    expect(lastCreateOrderOpts.type).toBe("stop_limit");
    expect(lastCreateOrderOpts.stop_price).toBe(158);
    expect(lastCreateOrderOpts.limit_price).toBe(160);
  });
});

describe("Alpaca MCP path — stop_price gating by order type", () => {
  function stubMcpFetch(): Array<Record<string, unknown>> {
    const argsSeen: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || "{}"));
      argsSeen.push(body?.params?.arguments ?? {});
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "1",
          result: { content: [{ type: "text", text: JSON.stringify({ id: "mcp_order_1", status: "accepted" }) }] }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });
    return argsSeen;
  }

  it("does NOT set stop_price on a LIMIT order in the MCP tool args", async () => {
    await seedMcpAccount();
    const argsSeen = stubMcpFetch();
    const { getAlpacaGateway } = await import("../src/lib/alpaca");
    await getAlpacaGateway("local").placeEquityOrder({
      accountNumber: "MOCK_ACC",
      symbol: "T",
      side: "buy",
      type: "limit",
      quantity: 7,
      limitPrice: 22,
      stopPrice: 20,
      timeInForce: "gfd",
      marketHours: "regular_hours",
      refId: "ref-mcp-limit-1"
    });
    expect(argsSeen.length).toBeGreaterThan(0);
    const args = argsSeen[argsSeen.length - 1];
    expect(args.type).toBe("limit");
    expect(args.limit_price).toBe("22");
    expect(args).not.toHaveProperty("stop_price");
  });

  it("does NOT set limit_price or stop_price on a MARKET order in the MCP tool args", async () => {
    await seedMcpAccount();
    const argsSeen = stubMcpFetch();
    const { getAlpacaGateway } = await import("../src/lib/alpaca");
    await getAlpacaGateway("local").placeEquityOrder({
      accountNumber: "MOCK_ACC",
      symbol: "PG",
      side: "cover",
      type: "market",
      quantity: 12,
      limitPrice: 150.1,
      stopPrice: 155,
      timeInForce: "gfd",
      marketHours: "regular_hours",
      refId: "ref-mcp-market-cover-1"
    });
    const args = argsSeen[argsSeen.length - 1];
    expect(args.type).toBe("market");
    expect(args).not.toHaveProperty("limit_price");
    expect(args).not.toHaveProperty("stop_price");
  });

  it("rounds a sub-penny T limit (>= $1) to the $0.01 increment Alpaca accepts", async () => {
    await seedRestAccount();
    const { getAlpacaGateway } = await import("../src/lib/alpaca");
    await getAlpacaGateway("local").placeEquityOrder({
      accountNumber: "MOCK_ACC",
      symbol: "T",
      side: "buy",
      type: "limit",
      quantity: 10,
      limitPrice: 24.865,
      timeInForce: "gfd",
      marketHours: "regular_hours",
      refId: "ref-t-penny-1"
    });
    expect(lastCreateOrderOpts.limit_price).toBe(24.87);
  });

  it("DOES set stop_price on a stop_limit order in the MCP tool args", async () => {
    await seedMcpAccount();
    const argsSeen = stubMcpFetch();
    const { getAlpacaGateway } = await import("../src/lib/alpaca");
    await getAlpacaGateway("local").placeEquityOrder({
      accountNumber: "MOCK_ACC",
      symbol: "PG",
      side: "sell",
      type: "stop_limit",
      quantity: 2,
      limitPrice: 160,
      stopPrice: 158,
      timeInForce: "gfd",
      marketHours: "regular_hours",
      refId: "ref-mcp-stoplimit-1"
    });
    const args = argsSeen[argsSeen.length - 1];
    expect(args.type).toBe("stop_limit");
    expect(args.stop_price).toBe("158");
  });

  it("maps stop_market to Alpaca wire type stop on the MCP tool args", async () => {
    await seedMcpAccount();
    const argsSeen = stubMcpFetch();
    const { getAlpacaGateway } = await import("../src/lib/alpaca");
    await getAlpacaGateway("local").placeEquityOrder({
      accountNumber: "MOCK_ACC",
      symbol: "EQT",
      side: "sell",
      type: "stop_market",
      quantity: 4,
      stopPrice: 55.25,
      timeInForce: "gfd",
      marketHours: "regular_hours",
      refId: "ref-mcp-stop-1"
    });
    const args = argsSeen[argsSeen.length - 1];
    expect(args.type).toBe("stop");
    expect(args.stop_price).toBe("55.25");
  });
});
