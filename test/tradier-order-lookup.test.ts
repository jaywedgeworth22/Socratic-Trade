// Tradier adapter: per-order lookup and bracket-aware execution listing (board 687a5fb4 lane G1).
// global.fetch is stubbed with canned Tradier envelopes; no network.  Per-run temp SQLite DB.
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ACCT = "VA93389646";

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-tradier-lookup-${randomUUID()}.db`)}`;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function seedTradierSandbox(): Promise<void> {
  const { upsertConnectedAccount } = await import("../src/lib/db");
  upsertConnectedAccount({
    id: `trd-${randomUUID()}`,
    userId: "local",
    broker: "tradier",
    environment: "paper",
    accountNumber: ACCT,
    label: "Tradier Sandbox",
    apiKey: "tok-sandbox-test",
    apiSecret: undefined,
    isActive: true
  });
}

function stubFetch(handler: (url: string, method: string) => { status?: number; body: unknown } | undefined): string[] {
  const urls: string[] = [];
  vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    urls.push(u);
    const hit = handler(u, (init?.method ?? "GET").toUpperCase());
    if (!hit) return new Response("", { status: 404 });
    return new Response(typeof hit.body === "string" ? hit.body : JSON.stringify(hit.body), {
      status: hit.status ?? 200,
      headers: { "content-type": "application/json" }
    });
  });
  return urls;
}

describe("Tradier getEquityOrder", () => {
  it("reads a previous-session filled order by id with tags", async () => {
    await seedTradierSandbox();
    const urls = stubFetch((u) => u.includes(`/accounts/${ACCT}/orders/35740897`)
      ? { body: { order: {
          id: 35740897, type: "limit", symbol: "TTE", side: "buy", quantity: 20.0, status: "filled", duration: "day", price: 60.5,
          avg_fill_price: 60.41, exec_quantity: 20.0, remaining_quantity: 0.0, create_date: "2026-07-22T17:38:38.000Z",
          transaction_date: "2026-07-22T17:41:02.000Z", class: "equity", tag: "st-ref-1"
        } } }
      : undefined);
    const { getTradierGateway } = await import("../src/lib/tradier");
    const lookup = await getTradierGateway("local").getEquityOrder!(ACCT, "35740897");
    expect(urls[0]).toContain("/v1/accounts/VA93389646/orders/35740897");
    expect(urls[0]).toContain("includeTags=true");
    expect(lookup?.order).toMatchObject({ id: "35740897", symbol: "TTE", side: "buy", state: "filled", filledQuantity: 20, averagePrice: 60.41, clientOrderId: "st-ref-1" });
    expect(lookup?.exitLegs).toBeUndefined();
  });

  it("returns undefined on a definitive 404 and throws on a server error", async () => {
    await seedTradierSandbox();
    stubFetch((u) => u.includes("/orders/404404") ? { status: 404, body: "The requested resource was not found" } : u.includes("/orders/500500") ? { status: 502, body: "Bad Gateway" } : undefined);
    const { getTradierGateway } = await import("../src/lib/tradier");
    const gateway = getTradierGateway("local");
    await expect(gateway.getEquityOrder!(ACCT, "404404")).resolves.toBeUndefined();
    await expect(gateway.getEquityOrder!(ACCT, "500500")).rejects.toThrow(/502/);
  });

  it("never interpolates an unusable id into the request path", async () => {
    await seedTradierSandbox();
    const urls = stubFetch(() => undefined);
    const { getTradierGateway } = await import("../src/lib/tradier");
    await expect(getTradierGateway("local").getEquityOrder!(ACCT, "../../accounts")).resolves.toBeUndefined();
    await expect(getTradierGateway("local").getEquityOrder!(ACCT, "undefined")).resolves.toBeUndefined();
    expect(urls).toHaveLength(0);
  });
});

describe("tradierOrderLookupFromRow / executionsFromTradierRow", () => {
  it("leg-entry OTOCO: the container id carries the entry leg's execution; exits come back as legs", async () => {
    const { tradierOrderLookupFromRow } = await import("../src/lib/tradier");
    const lookup = tradierOrderLookupFromRow({
      id: 900, class: "otoco", type: "otoco", status: "open", tag: "st-ref-otoco", create_date: "2026-08-05T14:02:11.000Z",
      leg: [
        { id: 901, class: "equity", type: "limit", symbol: "SLB", side: "buy", quantity: 69, status: "filled", avg_fill_price: 43.02, exec_quantity: 69 },
        { id: 902, class: "equity", type: "limit", symbol: "SLB", side: "sell", quantity: 69, status: "open", price: 47.4 },
        { id: 903, class: "equity", type: "stop", symbol: "SLB", side: "sell", quantity: 69, status: "open", stop_price: 40.1 }
      ]
    });
    expect(lookup.order).toMatchObject({ id: "900", symbol: "SLB", side: "buy", state: "filled", filledQuantity: 69, averagePrice: 43.02, clientOrderId: "st-ref-otoco" });
    expect(lookup.entryLegId).toBe("901");
    expect(lookup.exitLegs?.map((leg) => [leg.id, leg.side, leg.type])).toEqual([["902", "sell", "limit"], ["903", "sell", "stop_market"]]);
    expect(lookup.exitLegs?.every((leg) => leg.clientOrderId === undefined)).toBe(true);
  });

  it("container-entry OTOCO (exit-only legs): the container is the entry", async () => {
    const { tradierOrderLookupFromRow } = await import("../src/lib/tradier");
    const lookup = tradierOrderLookupFromRow({
      id: 500, symbol: "AAPL", side: "buy", type: "limit", class: "otoco", status: "filled", avg_fill_price: 190.1, exec_quantity: 10, tag: "bracket",
      leg: [
        { id: 501, symbol: "AAPL", side: "sell", type: "limit", status: "open", quantity: 10, price: 210, class: "equity" },
        { id: 502, side: "sell", type: "stop", quantity: 10, stop_price: 180, class: "equity" }
      ]
    });
    expect(lookup.order).toMatchObject({ id: "500", state: "filled", filledQuantity: 10, averagePrice: 190.1 });
    expect(lookup.entryLegId).toBeUndefined();
    expect(lookup.exitLegs?.map((leg) => leg.id)).toEqual(["501", "502"]);
    // A leg that omits its symbol inherits the container's; it carries no execution of its own.
    expect(lookup.exitLegs?.[1]).toMatchObject({ symbol: "AAPL", stopPrice: 180 });
    expect(lookup.exitLegs?.[1]?.filledQuantity).toBeUndefined();
  });

  it("listRecentExecutions keeps bracket roles and drops rows with an unrecognized side", async () => {
    await seedTradierSandbox();
    stubFetch((u) => {
      if (!u.includes(`/accounts/${ACCT}/orders`)) return undefined;
      const page = new URL(u).searchParams.get("page");
      if (page !== "1") return { body: { orders: "null" } };
      return { body: { orders: { order: [
        { id: 1, class: "equity", symbol: "C", side: "sell", type: "market", status: "filled", exec_quantity: 47, avg_fill_price: 72.4 },
        { id: 2, class: "equity", symbol: "C", side: "mystery", type: "market", status: "filled", exec_quantity: 1, avg_fill_price: 72.4 },
        { id: 10, class: "oto", status: "open", tag: "st-ref", leg: [
          { id: 11, class: "equity", symbol: "VZ", side: "buy", type: "limit", status: "filled", exec_quantity: 98, avg_fill_price: 40 },
          { id: 12, class: "equity", symbol: "VZ", side: "sell", type: "stop", status: "open" }
        ] },
        { id: 20, class: "oco", symbol: "MFC", status: "open", leg: [
          { id: 21, class: "equity", side: "sell", type: "limit", status: "open" },
          { id: 22, class: "equity", side: "sell", type: "stop", status: "open" }
        ] },
        { id: 30, class: "option", symbol: "SPY", side: "buy_to_open", status: "filled" }
      ] } } };
    });
    const { getTradierGateway } = await import("../src/lib/tradier");
    const executions = await getTradierGateway("local").listRecentExecutions!(ACCT);
    expect(executions.map((e) => [e.order.id, e.role, e.parentOrderId ?? null, e.parentClientOrderId ?? null])).toEqual([
      ["1", "single", null, null],
      ["11", "entry", "10", "st-ref"],
      ["12", "exit", "10", "st-ref"],
      ["21", "exit", "20", null],
      ["22", "exit", "20", null]
    ]);
    expect(executions.find((e) => e.order.id === "21")?.order.symbol).toBe("MFC");
  });

  it("getEquityOrders is unchanged by the raw page-walk refactor", async () => {
    await seedTradierSandbox();
    stubFetch((u) => {
      if (!u.includes(`/accounts/${ACCT}/orders`)) return undefined;
      const page = new URL(u).searchParams.get("page");
      if (page === "1") return { body: { orders: { order: [
        { id: 1, class: "equity", symbol: "C", side: "sell", type: "limit", status: "open", create_date: "2026-09-25T14:00:00.000Z" },
        { id: 2, class: "option", symbol: "SPY", side: "buy_to_open", status: "open" }
      ] } } };
      if (page === "2") return { body: { orders: { order: { id: 3, class: "equity", symbol: "VZ", side: "buy", type: "stop", status: "open", create_date: "2026-09-25T14:00:00.000Z" } } } };
      return { body: { orders: "null" } };
    });
    const { getTradierGateway } = await import("../src/lib/tradier");
    const orders = await getTradierGateway("local").getEquityOrders(ACCT);
    expect(orders.map((o) => o.id)).toEqual(["1", "3"]);
  });
});
