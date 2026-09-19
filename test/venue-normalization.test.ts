/**
 * normalizeVenueOrder regression tests for the two Seer findings on the venue-normalization PRs
 * (#3371 / #3380):
 *
 *   1. Alpaca: `timeInForce: "gfd"` must ALWAYS reach the wire as "day" (Alpaca rejects "gfd" with a
 *      422).  The first draft only rewrote "gfd" for fractional / bracket / extended-hours orders, so
 *      every ordinary whole-share regular-hours order using the internal default would have bounced.
 *   2. Robinhood: `reviewEquityOrder` must review the SAME order `placeEquityOrder` sends.  The
 *      fractional limit -> market coercion moved out of `toMcpOrder` into `normalizeVenueOrder`, so
 *      the review path has to normalize too or it prices/checks a limit order that is then placed as
 *      a market order.
 *
 * All broker calls are mocked -- no real order is ever placed.
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EquityOrderInput } from "../src/lib/types";

async function auditRows(kind: string): Promise<Array<Record<string, unknown>>> {
  const { getDb } = await import("../src/lib/db");
  const rows = getDb()
    .prepare("SELECT payload FROM audit_events WHERE kind = ? ORDER BY created_at ASC")
    .all(kind) as Array<{ payload: string }>;
  return rows.map((row) => JSON.parse(row.payload) as Record<string, unknown>);
}

const base: EquityOrderInput = {
  accountNumber: "ACC-1",
  symbol: "AAPL",
  side: "buy",
  type: "limit",
  quantity: 3,
  limitPrice: 180.5,
  timeInForce: "gfd",
  marketHours: "regular_hours"
};

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-venue-norm-${randomUUID()}.db`)}`;
});

describe("normalizeVenueOrder — Alpaca time in force", () => {
  it("translates gfd to day for an ordinary whole-share regular-hours order (the 422 regression)", async () => {
    const { normalizeVenueOrder } = await import("../src/lib/venue-normalization");
    const out = normalizeVenueOrder(base, "alpaca", "local");
    expect(out.timeInForce).toBe("day");
    // A spelling translation is not a rewrite of the caller's intent, so it writes no receipt.
    expect(await auditRows("venue_order_normalized")).toHaveLength(0);
  });

  it("still translates gfd to day for fractional, bracket and extended-hours orders", async () => {
    const { normalizeVenueOrder } = await import("../src/lib/venue-normalization");
    expect(normalizeVenueOrder({ ...base, quantity: 2.5 }, "alpaca", "local").timeInForce).toBe("day");
    expect(normalizeVenueOrder({ ...base, bracketTakeProfit: 200 }, "alpaca", "local").timeInForce).toBe("day");
    expect(normalizeVenueOrder({ ...base, marketHours: "extended_hours" }, "alpaca", "local").timeInForce).toBe("day");
  });

  it("leaves a whole-share regular-hours GTC order as GTC", async () => {
    const { normalizeVenueOrder } = await import("../src/lib/venue-normalization");
    const out = normalizeVenueOrder({ ...base, timeInForce: "gtc" }, "alpaca", "local");
    expect(out.timeInForce).toBe("gtc");
    expect(await auditRows("venue_order_normalized")).toHaveLength(0);
  });

  it("rewrites a fractional GTC order to day and audits the rewrite", async () => {
    const { normalizeVenueOrder } = await import("../src/lib/venue-normalization");
    const out = normalizeVenueOrder({ ...base, quantity: 2.5, timeInForce: "gtc" }, "alpaca", "local");
    expect(out.timeInForce).toBe("day");
    const rows = await auditRows("venue_order_normalized");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      broker: "alpaca",
      symbol: "AAPL",
      originalTimeInForce: "gtc",
      newTimeInForce: "day",
      reason: "fractional"
    });
  });

  it("audit:false normalizes without writing a receipt (used by the review path)", async () => {
    const { normalizeVenueOrder } = await import("../src/lib/venue-normalization");
    const out = normalizeVenueOrder({ ...base, quantity: 2.5, timeInForce: "gtc" }, "alpaca", "local", { audit: false });
    expect(out.timeInForce).toBe("day");
    expect(await auditRows("venue_order_normalized")).toHaveLength(0);
  });
});

describe("Robinhood — review and placement send the same order", () => {
  function stubMcp(calls: Array<{ name: string; args: Record<string, unknown> }>) {
    vi.stubEnv("ROBINHOOD_MCP_URL", "https://mcp.example.test/trading");
    vi.stubGlobal("fetch", async (_url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body ?? "{}"));
      calls.push({ name: request.params?.name, args: request.params?.arguments ?? {} });
      const data = request.params?.name === "place_equity_order" ? { id: "rh-order-1", state: "queued" } : { estimated_cost: 5 };
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { structuredContent: { data, guide: "ok" } } }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });
  }

  it("reviews a fractional (dollar-routed) limit buy as the regular-hours market order that placement sends", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    stubMcp(calls);
    const { getRobinhoodGateway } = await import("../src/lib/robinhood");
    const { setMcpOAuthTokens } = await import("../src/lib/mcp-oauth");
    setMcpOAuthTokens("user-rh", { accessToken: "test-token", tokenType: "Bearer" });

    const order: EquityOrderInput = {
      accountNumber: "RH-1",
      symbol: "GOOG",
      side: "buy",
      type: "limit",
      dollarAmount: 5,
      limitPrice: 180.12,
      timeInForce: "gfd",
      marketHours: "extended_hours"
    };
    const gateway = getRobinhoodGateway("user-rh");
    await gateway.reviewEquityOrder(order);
    await gateway.placeEquityOrder({ ...order, refId: "ref-1" });

    const review = calls.find((call) => call.name === "review_equity_order");
    const place = calls.find((call) => call.name === "place_equity_order");
    expect(review).toBeDefined();
    expect(place).toBeDefined();
    expect(review!.args.type).toBe("market");
    expect(review!.args.limit_price).toBeUndefined();
    expect(review!.args.market_hours).toBe("regular_hours");
    // The reviewed order is exactly the placed order (place additionally carries the idempotency key).
    const { ref_id: _refId, ...placedArgs } = place!.args;
    expect(review!.args).toEqual(placedArgs);
    // Review normalizes silently; placement writes the single receipt.
    expect(await auditRows("venue_order_normalized")).toHaveLength(1);
  });

  it("leaves a whole-share limit buy as a limit in both review and placement", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    stubMcp(calls);
    const { getRobinhoodGateway } = await import("../src/lib/robinhood");
    const { setMcpOAuthTokens } = await import("../src/lib/mcp-oauth");
    setMcpOAuthTokens("user-rh2", { accessToken: "test-token", tokenType: "Bearer" });

    const gateway = getRobinhoodGateway("user-rh2");
    await gateway.reviewEquityOrder({ ...base, accountNumber: "RH-1" });

    const review = calls.find((call) => call.name === "review_equity_order");
    expect(review!.args.type).toBe("limit");
    expect(review!.args.limit_price).toBe("180.50");
  });
});
