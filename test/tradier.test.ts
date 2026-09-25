// Tradier broker-adapter unit tests. global.fetch is stubbed to canned Tradier REST envelopes —
// no network. Each test uses a per-run temp SQLite DB (never data/app.db) and vi.resetModules() so
// the freshly-seeded connected account is picked up.

import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const SANDBOX_TOKEN = "tok-sandbox-abc";
const LIVE_TOKEN = "tok-live-xyz";
const ACCT = "VA1234567";

interface FetchRecord {
  url: string;
  method: string;
  authorization: string | null;
  accept: string | null;
  contentType: string | null;
  body: string | null;
}

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-tradier-${randomUUID()}.db`)}`;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// Seed an active Tradier connected account for `userId`.
async function seedTradier(opts: { environment?: "paper" | "live"; token?: string; userId?: string; accountNumber?: string; baseUrl?: string } = {}): Promise<void> {
  const { upsertConnectedAccount } = await import("../src/lib/db");
  const environment = opts.environment ?? "paper";
  upsertConnectedAccount({
    id: `trd-${randomUUID()}`,
    userId: opts.userId ?? "local",
    broker: "tradier",
    environment,
    accountNumber: opts.accountNumber ?? ACCT,
    label: environment === "live" ? "Tradier Brokerage" : "Tradier Sandbox",
    apiKey: opts.token ?? (environment === "live" ? LIVE_TOKEN : SANDBOX_TOKEN),
    apiSecret: undefined,
    baseUrl: opts.baseUrl,
    isActive: true
  });
}

// Install a fetch mock that routes by URL path and records every call. `handlers` maps a substring
// of the path to a JSON response body.
function installFetchMock(handlers: Array<{ match: (url: string, method: string) => boolean; body: unknown; status?: number }>): { records: FetchRecord[] } {
  const records: FetchRecord[] = [];
  vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    records.push({
      url: u,
      method,
      authorization: headers.get("authorization"),
      accept: headers.get("accept"),
      contentType: headers.get("content-type"),
      body: typeof init?.body === "string" ? init.body : null
    });
    const handler = handlers.find((h) => h.match(u, method));
    if (!handler) {
      // Yahoo/Stooq fallbacks in the quote floor: 404 so nothing throws.
      return new Response("", { status: 404 });
    }
    return new Response(JSON.stringify(handler.body), {
      status: handler.status ?? 200,
      headers: { "content-type": "application/json" }
    });
  });
  return { records };
}

describe("Tradier adapter — auth + base URL", () => {
  it("sends Bearer auth + JSON accept, and a sandbox row hits sandbox.tradier.com", async () => {
    await seedTradier({ environment: "paper" });
    const { records } = installFetchMock([
      { match: (u) => u.includes("/user/profile"), body: { profile: { account: { account_number: ACCT, type: "margin", classification: "individual" } } } }
    ]);
    const { getTradierGateway } = await import("../src/lib/tradier");
    await getTradierGateway("local").getAccounts();
    const call = records.find((r) => r.url.includes("/user/profile"))!;
    expect(call.authorization).toBe(`Bearer ${SANDBOX_TOKEN}`);
    expect(call.accept).toBe("application/json");
    expect(call.url).toContain("https://sandbox.tradier.com/v1/user/profile");
  });

  it("a live row hits api.tradier.com", async () => {
    await seedTradier({ environment: "live" });
    const { records } = installFetchMock([
      { match: (u) => u.includes("/user/profile"), body: { profile: { account: { account_number: ACCT, type: "cash", classification: "individual" } } } }
    ]);
    const { getTradierGateway } = await import("../src/lib/tradier");
    await getTradierGateway("local").getAccounts();
    const call = records.find((r) => r.url.includes("/user/profile"))!;
    expect(call.authorization).toBe(`Bearer ${LIVE_TOKEN}`);
    expect(call.url).toContain("https://api.tradier.com/v1/user/profile");
  });
});

describe("Tradier adapter — side & type mapping (write)", () => {
  async function place(side: "buy" | "sell" | "short" | "cover", type: "market" | "limit" | "stop_market" | "stop_limit" = "market") {
    await seedTradier();
    const { records } = installFetchMock([
      { match: (u) => u.includes("/markets/quotes"), body: { quotes: { quote: { symbol: "AAPL", last: 100 } } } },
      { match: (u, m) => u.includes(`/accounts/${ACCT}/orders`) && m === "POST", body: { order: { id: 555, status: "ok" } } }
    ]);
    const { getTradierGateway } = await import("../src/lib/tradier");
    await getTradierGateway("local").placeEquityOrder({
      accountNumber: ACCT, symbol: "AAPL", side, type, quantity: 3,
      timeInForce: "gfd", marketHours: "regular_hours",
      ...(type === "limit" || type === "stop_limit" ? { limitPrice: 101 } : {}),
      ...(type === "stop_market" || type === "stop_limit" ? { stopPrice: 99 } : {}),
      refId: "r1"
    });
    const post = records.find((r) => r.method === "POST" && r.url.includes("/orders"))!;
    return new URLSearchParams(post.body ?? "");
  }

  it("maps buy/sell/short/cover directly to Tradier sides", async () => {
    expect((await place("buy")).get("side")).toBe("buy");
    expect((await place("sell")).get("side")).toBe("sell");
    expect((await place("short")).get("side")).toBe("sell_short");
    expect((await place("cover")).get("side")).toBe("buy_to_cover");
  });

  it("maps stop_market to 'stop' on write; keeps limit/stop_limit", async () => {
    expect((await place("buy", "stop_market")).get("type")).toBe("stop");
    expect((await place("buy", "limit")).get("type")).toBe("limit");
    expect((await place("buy", "stop_limit")).get("type")).toBe("stop_limit");
  });

  it("never sends price/stop on a MARKET order, even when the input carries them", async () => {
    await seedTradier();
    const { records } = installFetchMock([
      { match: (u, m) => u.includes(`/accounts/${ACCT}/orders`) && m === "POST", body: { order: { id: 9, status: "ok" } } }
    ]);
    const { getTradierGateway } = await import("../src/lib/tradier");
    await getTradierGateway("local").placeEquityOrder({
      accountNumber: ACCT, symbol: "PG", side: "cover", type: "market", quantity: 12,
      limitPrice: 150.1, stopPrice: 155,
      timeInForce: "gfd", marketHours: "regular_hours", refId: "r-market-cover"
    });
    const form = new URLSearchParams(records.find((r) => r.method === "POST")!.body ?? "");
    expect(form.get("type")).toBe("market");
    expect(form.get("side")).toBe("buy_to_cover");
    expect(form.has("price")).toBe(false);
    expect(form.has("stop")).toBe(false);
  });

  it("form-encodes the POST with Content-Type application/x-www-form-urlencoded", async () => {
    await seedTradier();
    const { records } = installFetchMock([
      { match: (u, m) => u.includes(`/accounts/${ACCT}/orders`) && m === "POST", body: { order: { id: 1, status: "ok" } } }
    ]);
    const { getTradierGateway } = await import("../src/lib/tradier");
    await getTradierGateway("local").placeEquityOrder({
      accountNumber: ACCT, symbol: "AAPL", side: "buy", type: "market", quantity: 1,
      timeInForce: "gfd", marketHours: "regular_hours", refId: "r-form"
    });
    const post = records.find((r) => r.method === "POST")!;
    expect(post.contentType).toBe("application/x-www-form-urlencoded");
    expect(new URLSearchParams(post.body ?? "").get("class")).toBe("equity");
  });
});

describe("Tradier adapter — read-back mapping", () => {
  it("maps sell_short->short, buy_to_cover->cover, stop->stop_market from getEquityOrders", async () => {
    await seedTradier();
    installFetchMock([
      {
        match: (u) => u.includes(`/accounts/${ACCT}/orders`),
        body: { orders: { order: [
          { id: 1, symbol: "AAPL", side: "sell_short", type: "stop", status: "open", quantity: 5, duration: "gtc", create_date: "2026-07-10", stop_price: 90, tag: "abc", class: "equity" },
          { id: 2, symbol: "MSFT", side: "buy_to_cover", type: "limit", status: "pending", quantity: 5, duration: "day", create_date: "2026-07-10", price: 300, class: "equity" }
        ] } }
      }
    ]);
    const { getTradierGateway } = await import("../src/lib/tradier");
    const orders = await getTradierGateway("local").getEquityOrders(ACCT);
    expect(orders[0]).toMatchObject({ id: "1", side: "short", type: "stop_market", state: "open", clientOrderId: "abc" });
    expect(orders[1]).toMatchObject({ id: "2", side: "cover", type: "limit", state: "pending" });
  });
});

describe("Tradier adapter — duration mapping", () => {
  async function duration(input: { timeInForce: "gfd" | "gtc"; marketHours: "regular_hours" | "extended_hours"; type?: "market" | "limit" }) {
    await seedTradier();
    const { records } = installFetchMock([
      { match: (u, m) => m === "POST" && u.includes("/orders"), body: { order: { id: 9, status: "ok" } } }
    ]);
    const { getTradierGateway } = await import("../src/lib/tradier");
    await getTradierGateway("local").placeEquityOrder({
      accountNumber: ACCT, symbol: "AAPL", side: "buy", type: input.type ?? "market", quantity: 1,
      timeInForce: input.timeInForce, marketHours: input.marketHours,
      ...(input.type === "limit" ? { limitPrice: 100 } : {}),
      refId: "rd"
    });
    return new URLSearchParams(records.find((r) => r.method === "POST")!.body ?? "").get("duration");
  }

  it("gfd->day, gtc->gtc for regular hours", async () => {
    expect(await duration({ timeInForce: "gfd", marketHours: "regular_hours" })).toBe("day");
    expect(await duration({ timeInForce: "gtc", marketHours: "regular_hours" })).toBe("gtc");
  });

  it("extended_hours + limit -> pre/post during Tradier windows, day otherwise", async () => {
    const d = await duration({ timeInForce: "gfd", marketHours: "extended_hours", type: "limit" });
    // Tradier only accepts extended-hours orders during 07:00-09:24 ET (pre) or 16:00-19:55 ET (post).
    // Outside those windows the function returns "day" as a fallback so the order is not
    // rejected by the broker with an invalid session duration.
    expect(["pre", "post", "day"]).toContain(d);
  });

  it("extended_hours on a NON-limit falls back to the TIF session (Tradier fills extended only as limit)", async () => {
    expect(await duration({ timeInForce: "gfd", marketHours: "extended_hours", type: "market" })).toBe("day");
  });
});

describe("Tradier adapter — whole-share resolution", () => {
  it("floors a dollarAmount order to whole shares using a mocked quote", async () => {
    await seedTradier();
    const { records } = installFetchMock([
      { match: (u) => u.includes("/markets/quotes"), body: { quotes: { quote: { symbol: "AAPL", last: 100 } } } },
      { match: (u, m) => m === "POST" && u.includes("/orders"), body: { order: { id: 3, status: "ok" } } }
    ]);
    const { getTradierGateway } = await import("../src/lib/tradier");
    await getTradierGateway("local").placeEquityOrder({
      accountNumber: ACCT, symbol: "AAPL", side: "buy", type: "market", dollarAmount: 550,
      timeInForce: "gfd", marketHours: "regular_hours", refId: "rq"
    });
    const post = records.find((r) => r.method === "POST")!;
    expect(new URLSearchParams(post.body ?? "").get("quantity")).toBe("5"); // floor(550/100)
  });

  it("THROWS (never quantity 1) when there is no live quote to size a market dollar order", async () => {
    await seedTradier();
    installFetchMock([
      { match: (u) => u.includes("/markets/quotes"), body: { quotes: { quote: { symbol: "AAPL" } } } } // no price
    ]);
    const { getTradierGateway } = await import("../src/lib/tradier");
    await expect(
      getTradierGateway("local").placeEquityOrder({
        accountNumber: ACCT, symbol: "AAPL", side: "buy", type: "market", dollarAmount: 550,
        timeInForce: "gfd", marketHours: "regular_hours", refId: "rt"
      })
    ).rejects.toThrow(/without a live quote/i);
  });

  // Finding #2/#4: a MARKET dollar order must size from a FRESH quote, NOT the stale proposal
  // referencePrice — and the fresh-quote lookup must key by the SAME (hyphenated) form the quote map
  // stores under. Reference says 100 (proposal-time), but the stock has RISEN to 200 by placement;
  // sizing off the stale 100 would buy 10 shares (=$2000, DOUBLE the $1000 budget). Fresh 200 -> 5.
  it("sizes a market dollar order from the FRESH (higher) quote, never the stale referencePrice", async () => {
    await seedTradier();
    const { records } = installFetchMock([
      { match: (u) => u.includes("/markets/quotes"), body: { quotes: { quote: { symbol: "AAPL", last: 200 } } } },
      { match: (u, m) => m === "POST" && u.includes("/orders"), body: { order: { id: 88, status: "ok" } } }
    ]);
    const { getTradierGateway } = await import("../src/lib/tradier");
    await getTradierGateway("local").placeEquityOrder({
      accountNumber: ACCT, symbol: "AAPL", side: "buy", type: "market", dollarAmount: 1000,
      referencePrice: 100, // stale/lower — must be ignored for a market order
      timeInForce: "gfd", marketHours: "regular_hours", refId: "rrise"
    });
    const post = records.find((r) => r.method === "POST")!;
    expect(new URLSearchParams(post.body ?? "").get("quantity")).toBe("5"); // floor(1000/200), NOT floor(1000/100)=10
  });

  // A LIMIT dollar order keeps sizing off its limitPrice (the fill is capped there, so it never
  // overspends) — no fresh quote needed.
  it("sizes a LIMIT dollar order off limitPrice (the capped fill price), not a quote", async () => {
    await seedTradier();
    const { records } = installFetchMock([
      { match: (u, m) => m === "POST" && u.includes("/orders"), body: { order: { id: 89, status: "ok" } } }
      // no /markets/quotes handler: if the code fetched a quote it would 404 -> price 0 -> throw
    ]);
    const { getTradierGateway } = await import("../src/lib/tradier");
    await getTradierGateway("local").placeEquityOrder({
      accountNumber: ACCT, symbol: "AAPL", side: "buy", type: "limit", dollarAmount: 1000, limitPrice: 250,
      timeInForce: "gfd", marketHours: "regular_hours", refId: "rlim"
    });
    const post = records.find((r) => r.method === "POST")!;
    expect(new URLSearchParams(post.body ?? "").get("quantity")).toBe("4"); // floor(1000/250)
  });

  it("getEquityTradability reports fractional:false for all symbols", async () => {
    await seedTradier();
    installFetchMock([]);
    const { getTradierGateway } = await import("../src/lib/tradier");
    const t = await getTradierGateway("local").getEquityTradability(ACCT, ["AAPL", "brk-b"]);
    expect(t.AAPL).toEqual({ tradable: true, fractional: false });
    expect(t["BRK-B"]).toEqual({ tradable: true, fractional: false });
  });
});

describe("Tradier adapter — placement response mapping", () => {
  it("maps {order:{id,status:'ok'}} -> {orderId, state:'pending'}", async () => {
    await seedTradier();
    installFetchMock([
      { match: (u, m) => m === "POST" && u.includes("/orders"), body: { order: { id: 777, status: "ok" } } }
    ]);
    const { getTradierGateway } = await import("../src/lib/tradier");
    const res = await getTradierGateway("local").placeEquityOrder({
      accountNumber: ACCT, symbol: "AAPL", side: "buy", type: "market", quantity: 1,
      timeInForce: "gfd", marketHours: "regular_hours", refId: "ro"
    });
    expect(res).toMatchObject({ orderId: "777", state: "pending", refId: "ro" });
    expect(res.filledQuantity).toBeUndefined();
  });

  it("a missing order id THROWS", async () => {
    await seedTradier();
    installFetchMock([
      { match: (u, m) => m === "POST" && u.includes("/orders"), body: { order: { status: "ok" } } }
    ]);
    const { getTradierGateway } = await import("../src/lib/tradier");
    await expect(
      getTradierGateway("local").placeEquityOrder({
        accountNumber: ACCT, symbol: "AAPL", side: "buy", type: "market", quantity: 1,
        timeInForce: "gfd", marketHours: "regular_hours", refId: "rn"
      })
    ).rejects.toThrow(/no order id/i);
  });

  it("a synchronous 'rejected' status passes through verbatim", async () => {
    await seedTradier();
    installFetchMock([
      { match: (u, m) => m === "POST" && u.includes("/orders"), body: { order: { id: 12, status: "rejected" } } }
    ]);
    const { getTradierGateway } = await import("../src/lib/tradier");
    const res = await getTradierGateway("local").placeEquityOrder({
      accountNumber: ACCT, symbol: "AAPL", side: "buy", type: "market", quantity: 1,
      timeInForce: "gfd", marketHours: "regular_hours", refId: "rr"
    });
    expect(res.state).toBe("rejected");
    const { isRejectedOrCanceledState } = await import("../src/lib/broker-side");
    expect(isRejectedOrCanceledState(res.state)).toBe(true);
  });

  it("throws a joined message on a Tradier error envelope", async () => {
    await seedTradier();
    installFetchMock([
      { match: (u, m) => m === "POST" && u.includes("/orders"), body: { errors: { error: ["side is required", "quantity is required"] } } }
    ]);
    const { getTradierGateway } = await import("../src/lib/tradier");
    await expect(
      getTradierGateway("local").placeEquityOrder({
        accountNumber: ACCT, symbol: "AAPL", side: "buy", type: "market", quantity: 1,
        timeInForce: "gfd", marketHours: "regular_hours", refId: "re"
      })
    ).rejects.toThrow(/side is required; quantity is required/);
  });
});

describe("Tradier adapter — envelope normalization", () => {
  it("normalizes a single-object {orders:{order:{...}}} and empty 'null'", async () => {
    await seedTradier();
    // Single object
    installFetchMock([
      { match: (u) => u.includes("/orders"), body: { orders: { order: { id: 1, symbol: "AAPL", side: "buy", type: "market", status: "filled", create_date: "2026-07-10", class: "equity" } } } }
    ]);
    const mod1 = await import("../src/lib/tradier");
    const one = await mod1.getTradierGateway("local").getEquityOrders(ACCT, { fullHistory: true });
    expect(one).toHaveLength(1);
    expect(one[0].id).toBe("1");

    // Empty "null"
    vi.resetModules();
    await seedTradier();
    installFetchMock([
      { match: (u) => u.includes("/orders"), body: { orders: "null" } }
    ]);
    const mod2 = await import("../src/lib/tradier");
    const none = await mod2.getTradierGateway("local").getEquityOrders(ACCT);
    expect(none).toEqual([]);
  });
});

describe("Tradier adapter — quotes", () => {
  it("batches /markets/quotes and follows last->close->ask->bid precedence", async () => {
    await seedTradier();
    const { records } = installFetchMock([
      {
        match: (u) => u.includes("/markets/quotes"),
        body: { quotes: { quote: [
          { symbol: "AAPL", last: 190, close: 188, ask: 191, bid: 189, volume: 1000, trade_date: 1751000000000 },
          { symbol: "MSFT", close: 400 } // no last -> close
        ] } }
      }
    ]);
    const { getTradierGateway } = await import("../src/lib/tradier");
    const quotes = await getTradierGateway("local").getEquityQuotes(ACCT, ["AAPL", "MSFT"]);
    expect(quotes.AAPL.price).toBe(190);
    expect(quotes.MSFT.price).toBe(400);
    const call = records.find((r) => r.url.includes("/markets/quotes"))!;
    expect(call.url).toContain("symbols=AAPL%2CMSFT");
    expect(call.authorization).toBe(`Bearer ${SANDBOX_TOKEN}`);
  });

  it("a quote-fetch error warns and does NOT throw (falls through to Yahoo floor -> no data -> price 0)", async () => {
    await seedTradier();
    installFetchMock([
      { match: (u) => u.includes("/markets/quotes"), body: { error: "boom" }, status: 500 }
    ]);
    const { getTradierGateway } = await import("../src/lib/tradier");
    const quotes = await getTradierGateway("local").getEquityQuotes(ACCT, ["AAPL"]);
    // No throw; symbol may be absent or priced 0 from the (mocked-404) Yahoo floor.
    expect(quotes.AAPL?.price ?? 0).toBe(0);
  });
});

describe("Tradier adapter — getPortfolio", () => {
  it("uses margin.stock_buying_power for a margin account", async () => {
    await seedTradier();
    installFetchMock([
      { match: (u) => u.includes("/balances"), body: { balances: { account_number: ACCT, total_equity: 10000, total_cash: 2000, market_value: 8000, margin: { stock_buying_power: 16000 } } } }
    ]);
    const { getTradierGateway } = await import("../src/lib/tradier");
    const p = await getTradierGateway("local").getPortfolio(ACCT);
    expect(p).toMatchObject({ totalMarketValue: 10000, cash: 2000, buyingPower: 16000, equityMarketValue: 8000 });
  });

  it("uses cash.cash_available for a cash account", async () => {
    await seedTradier();
    installFetchMock([
      { match: (u) => u.includes("/balances"), body: { balances: { account_number: ACCT, total_equity: 5000, total_cash: 3000, market_value: 2000, cash: { cash_available: 2500 } } } }
    ]);
    const { getTradierGateway } = await import("../src/lib/tradier");
    const p = await getTradierGateway("local").getPortfolio(ACCT);
    expect(p.buyingPower).toBe(2500);
  });

  it("throws Account Mismatch only on a genuinely differing account_number", async () => {
    await seedTradier();
    installFetchMock([
      { match: (u) => u.includes("/balances"), body: { balances: { account_number: "OTHER999", total_equity: 1, total_cash: 1 } } }
    ]);
    const { getTradierGateway } = await import("../src/lib/tradier");
    await expect(getTradierGateway("local").getPortfolio(ACCT)).rejects.toThrow(/Account Mismatch/);
  });
});

describe("Tradier adapter — positions", () => {
  it("divides total cost_basis by quantity for averageCost and prices via a quote", async () => {
    await seedTradier();
    installFetchMock([
      { match: (u) => u.includes("/positions"), body: { positions: { position: { symbol: "AAPL", quantity: 10, cost_basis: 1500 } } } },
      { match: (u) => u.includes("/markets/quotes"), body: { quotes: { quote: { symbol: "AAPL", last: 200 } } } }
    ]);
    const { getTradierGateway } = await import("../src/lib/tradier");
    const pos = await getTradierGateway("local").getEquityPositions(ACCT);
    expect(pos[0]).toMatchObject({ symbol: "AAPL", quantity: 10, averageCost: 150, marketValue: 2000 });
  });

  it("filters OCC option positions out of the equity book by symbol format, keeping equities (incl. dotted share classes)", async () => {
    await seedTradier();
    installFetchMock([
      { match: (u) => u.includes("/positions"), body: { positions: { position: [
        { symbol: "DELL140118C00015000", quantity: 2, cost_basis: 300 }, // OCC option — must be dropped
        { symbol: "AAPL", quantity: 10, cost_basis: 1500 },              // equity — kept
        { symbol: "BRK.B", quantity: 4, cost_basis: 1600 }               // dotted share class — kept (never matches OCC suffix)
      ] } } },
      { match: (u) => u.includes("/markets/quotes"), body: { quotes: { quote: [ { symbol: "AAPL", last: 200 }, { symbol: "BRK.B", last: 400 } ] } } }
    ]);
    const { getTradierGateway } = await import("../src/lib/tradier");
    const pos = await getTradierGateway("local").getEquityPositions(ACCT);
    const syms = pos.map((p) => p.symbol).sort();
    expect(syms).toEqual(["AAPL", "BRK-B"]); // option excluded; dotted share class canonicalized + kept
    expect(pos.find((p) => p.symbol === "DELL140118C00015000")).toBeUndefined();
  });
});

describe("Tradier adapter — share-class symbol canonicalization (finding #1/#4)", () => {
  // Tradier speaks dotted BRK.B on the wire; our canonical is hyphenated BRK-B. A POSITION, an
  // ORDER, and a QUOTE for the same share-class ticker must ALL normalize to the identical canonical
  // string, or a resting share-class order never matches its own position and every symbol-equality
  // double-exit / held-exit guard breaks.
  it("a dotted BRK.B from a position, an order, and a quote all normalize to 'BRK-B'", async () => {
    await seedTradier();
    installFetchMock([
      { match: (u) => u.includes("/positions"), body: { positions: { position: { symbol: "BRK.B", quantity: 4, cost_basis: 1600 } } } },
      { match: (u) => u.includes("/orders"), body: { orders: { order: { id: 7, symbol: "BRK.B", side: "sell", type: "stop", status: "open", quantity: 4, create_date: "2026-07-10", stop_price: 380, tag: "abc", class: "equity" } } } },
      { match: (u) => u.includes("/markets/quotes"), body: { quotes: { quote: { symbol: "BRK.B", last: 400 } } } }
    ]);
    const { getTradierGateway } = await import("../src/lib/tradier");
    const gw = getTradierGateway("local");

    const positions = await gw.getEquityPositions(ACCT);
    const orders = await gw.getEquityOrders(ACCT);
    const quotes = await gw.getEquityQuotes(ACCT, ["BRK.B"]);

    const CANON = "BRK-B";
    expect(positions[0].symbol).toBe(CANON);
    expect(orders[0].symbol).toBe(CANON);
    expect(quotes[CANON]?.symbol).toBe(CANON);
    // All three agree with each other AND with the canonical string a proposal/guard compares on.
    expect(new Set([positions[0].symbol, orders[0].symbol, quotes[CANON]?.symbol]).size).toBe(1);
    // The position was priced from the quote (marketValue = qty * quote price), proving the position
    // symbol and the quote-map key match after canonicalization.
    expect(positions[0].marketValue).toBe(1600); // 4 * 400
  });

  it("the wire request converts the canonical hyphen back to a dot (BRK-B -> BRK.B)", async () => {
    await seedTradier();
    const { records } = installFetchMock([
      { match: (u) => u.includes("/markets/quotes"), body: { quotes: { quote: { symbol: "BRK.B", last: 400 } } } }
    ]);
    const { getTradierGateway } = await import("../src/lib/tradier");
    await getTradierGateway("local").getEquityQuotes(ACCT, ["BRK-B"]);
    const call = records.find((r) => r.url.includes("/markets/quotes"))!;
    expect(call.url).toContain("symbols=BRK.B");
  });

  // Finding #4 explicit: a dotted-symbol market dollar order must find its fresh quote (store key ==
  // lookup key after canonicalization) and size off it — not fall through to the unsizable throw.
  it("sizes a dotted-symbol (BRK.B) market dollar order from its fresh quote", async () => {
    await seedTradier();
    const { records } = installFetchMock([
      { match: (u) => u.includes("/markets/quotes"), body: { quotes: { quote: { symbol: "BRK.B", last: 400 } } } },
      { match: (u, m) => m === "POST" && u.includes("/orders"), body: { order: { id: 91, status: "ok" } } }
    ]);
    const { getTradierGateway } = await import("../src/lib/tradier");
    await getTradierGateway("local").placeEquityOrder({
      accountNumber: ACCT, symbol: "BRK-B", side: "buy", type: "market", dollarAmount: 1200,
      timeInForce: "gfd", marketHours: "regular_hours", refId: "rbrk"
    });
    const post = records.find((r) => r.method === "POST")!;
    expect(post.contentType).toBe("application/x-www-form-urlencoded");
    const form = new URLSearchParams(post.body ?? "");
    expect(form.get("quantity")).toBe("3"); // floor(1200/400)
    expect(form.get("symbol")).toBe("BRK.B"); // dotted on the wire
  });
});

describe("Tradier adapter — environment is the base-URL authority (finding #3)", () => {
  // A paper account with a MISMATCHED stored baseUrl pointing at the LIVE host must still route to
  // sandbox — the environment is the authority; the corrupt/legacy baseUrl is ignored.
  it("a paper row NEVER hits api.tradier.com even with a stored live baseUrl", async () => {
    await seedTradier({ environment: "paper", baseUrl: "https://api.tradier.com/v1" });
    const { records } = installFetchMock([
      { match: (u) => u.includes("/user/profile"), body: { profile: { account: { account_number: ACCT, type: "cash", classification: "individual" } } } }
    ]);
    const { getTradierGateway } = await import("../src/lib/tradier");
    await getTradierGateway("local").getAccounts();
    const call = records.find((r) => r.url.includes("/user/profile"))!;
    expect(call.url).toContain("https://sandbox.tradier.com/v1/");
    expect(call.url).not.toContain("api.tradier.com");
  });

  it("a live row NEVER hits sandbox even with a stored sandbox baseUrl", async () => {
    await seedTradier({ environment: "live", baseUrl: "https://sandbox.tradier.com/v1" });
    const { records } = installFetchMock([
      { match: (u) => u.includes("/user/profile"), body: { profile: { account: { account_number: ACCT, type: "cash", classification: "individual" } } } }
    ]);
    const { getTradierGateway } = await import("../src/lib/tradier");
    await getTradierGateway("local").getAccounts();
    const call = records.find((r) => r.url.includes("/user/profile"))!;
    expect(call.url).toContain("https://api.tradier.com/v1/");
    expect(call.url).not.toContain("sandbox.tradier.com");
  });

  it("a host-consistent stored baseUrl is still honored (paper -> sandbox)", async () => {
    await seedTradier({ environment: "paper", baseUrl: "https://sandbox.tradier.com/v1" });
    const { records } = installFetchMock([
      { match: (u) => u.includes("/user/profile"), body: { profile: { account: { account_number: ACCT, type: "cash", classification: "individual" } } } }
    ]);
    const { getTradierGateway } = await import("../src/lib/tradier");
    await getTradierGateway("local").getAccounts();
    expect(records.find((r) => r.url.includes("/user/profile"))!.url).toContain("https://sandbox.tradier.com/v1/");
  });
});

describe("Tradier adapter — capsFromProfile", () => {
  it("margin -> shortSelling/marginEnabled true; classifications map to account types", async () => {
    await seedTradier();
    installFetchMock([
      { match: (u) => u.includes("/user/profile"), body: { profile: { account: [
        { account_number: "A1", type: "margin", classification: "individual", option_level: 0 },
        { account_number: "A2", type: "cash", classification: "ira_roth" },
        { account_number: "A3", type: "cash", classification: "traditional_ira" }
      ] } } }
    ]);
    const { getTradierGateway } = await import("../src/lib/tradier");
    const accts = await getTradierGateway("local").getAccounts();
    expect(accts).toHaveLength(3);
    expect(accts[0].capabilities).toMatchObject({ shortSelling: true, marginEnabled: true, accountType: "brokerage", optionsTrading: false });
    expect(accts[1].capabilities).toMatchObject({ shortSelling: false, accountType: "roth_ira" });
    expect(accts[2].capabilities).toMatchObject({ accountType: "traditional_ira" });
  });
});

describe("Tradier adapter — cancel", () => {
  // Finding #7: Tradier's DELETE returns the bare "ok" (= cancel request accepted, async), which no
  // broker-side.ts state check recognizes. Normalize it to "pending_cancel" — a state isLiveOrderState
  // still treats as live (a cancel-requested order can still fill until confirmed dead).
  it("DELETEs the order and normalizes the bare 'ok' to 'pending_cancel' (a recognized live state)", async () => {
    await seedTradier();
    const { records } = installFetchMock([
      { match: (u, m) => m === "DELETE" && u.includes("/orders/42"), body: { order: { id: 42, status: "ok" } } }
    ]);
    const { getTradierGateway } = await import("../src/lib/tradier");
    const res = await getTradierGateway("local").cancelEquityOrder(ACCT, "42");
    expect(res.orderId).toBe("42");
    expect(res.state).toBe("pending_cancel");
    expect(records.some((r) => r.method === "DELETE" && r.url.includes("/orders/42"))).toBe(true);
    const { isLiveOrderState, isRejectedOrCanceledState } = await import("../src/lib/broker-side");
    expect(isLiveOrderState(res.state)).toBe(true); // never the bare, unrecognized "ok"
    expect(isRejectedOrCanceledState(res.state)).toBe(false);
  });

  it("passes a real terminal cancel status through verbatim", async () => {
    await seedTradier();
    installFetchMock([
      { match: (u, m) => m === "DELETE" && u.includes("/orders/43"), body: { order: { id: 43, status: "canceled" } } }
    ]);
    const { getTradierGateway } = await import("../src/lib/tradier");
    const res = await getTradierGateway("local").cancelEquityOrder(ACCT, "43");
    expect(res.state).toBe("canceled");
    const { isRejectedOrCanceledState } = await import("../src/lib/broker-side");
    expect(isRejectedOrCanceledState(res.state)).toBe(true);
  });
});

describe("Tradier tag round-trips a synthetic-stop refId for the client-order-id dedup (finding #5)", () => {
  // A non-primary user's id is `u_<hash>` (contains an underscore). The synthetic-stop refId embeds
  // that id, and the secondary dedup matches a resting broker order to its stop by EXACT
  // client-order-id equality. Tradier's tag charset rewrites '_' -> '-', so the raw refId would come
  // back mangled and never match. brokerPortableRefId keeps the generated refId within [A-Za-z0-9-]
  // so Tradier's sanitizeTag is IDENTITY on it and the tag round-trips to the stored refId exactly.
  it("a u_<hash> synthetic-stop refId is placed and read back byte-identical (dedup matches)", async () => {
    await seedTradier();
    // The refId the monitor would generate for a non-primary user (see synthetic-stops.ts):
    //   sstop-synstop-<userId>-<account>-<sym>-<price*100>. Build it, sanitize it portably, place it,
    // read it back, and assert the client_order_id equals the STORED refId used for dedup.
    const userId = "u_" + "a".repeat(24); // shape of userIdForEmail() for a non-primary user
    const rawRefId = `sstop-synstop-${userId}-${ACCT}-BRK-B-40000`;
    const { records } = installFetchMock([
      { match: (u) => u.includes("/markets/quotes"), body: { quotes: { quote: { symbol: "BRK.B", last: 400 } } } },
      { match: (u, m) => m === "POST" && u.includes("/orders"), body: { order: { id: 200, status: "ok" } } },
      // The broker echoes back whatever tag it stored — model Tradier's charset by sanitizing here.
      { match: (u, m) => m === "GET" && u.includes("/orders"), body: { orders: { order: { id: 200, symbol: "BRK.B", side: "sell", type: "stop", status: "open", quantity: 1, create_date: "2026-07-10", stop_price: 400, tag: rawRefId.replace(/[^a-zA-Z0-9-]/g, "-"), class: "equity" } } } }
    ]);
    const { getTradierGateway } = await import("../src/lib/tradier");

    // What synthetic-stops.ts stores as lastAttemptRefId (portable form):
    const storedRefId = rawRefId.replace(/[^A-Za-z0-9-]/g, "-");
    // Sanity: portable refId has NO underscore, so Tradier's tag transform is a no-op on it.
    expect(storedRefId).not.toContain("_");

    const gw = getTradierGateway("local");
    await gw.placeEquityOrder({
      accountNumber: ACCT, symbol: "BRK-B", side: "sell", type: "stop_market", quantity: 1, stopPrice: 400,
      timeInForce: "gtc", marketHours: "regular_hours", refId: storedRefId
    });
    // The tag actually SENT equals the stored refId (round-trip is identity, no mangling).
    const post = records.find((r) => r.method === "POST")!;
    expect(new URLSearchParams(post.body ?? "").get("tag")).toBe(storedRefId);

    // Read the order back: its clientOrderId must EXACTLY equal the stored refId the dedup compares.
    const orders = await gw.getEquityOrders(ACCT);
    expect(orders[0].clientOrderId).toBe(storedRefId);
  });
});

describe("Tradier adapter — getEquityOrders pagination (double-sell coverage, codex-autofix reconciliation)", () => {
  // A mixed equity+options account can hold a page of ONLY option/combo orders sitting BEFORE a later
  // page carrying a resting protective EQUITY exit. The pagination loop must continue past the
  // option-only page (its rows count toward continuation even though the equity FILTER drops them),
  // or the equity exit is invisible to liveExitOrderCoverage and the synthetic monitor double-sells.
  it("does NOT stop at an option-only page; a later page's equity exit is still returned", async () => {
    await seedTradier();
    installFetchMock([
      {
        match: (u, m) => m === "GET" && u.includes(`/accounts/${ACCT}/orders`) && u.includes("page=1"),
        body: { orders: { order: [
          // Page 1: option-only. Post-equity-filter this page contributes ZERO returned orders — the
          // old `added === 0` break would have stopped here, hiding the page-2 protective stop.
          { id: 10, symbol: "AAPL", side: "buy_to_open", type: "limit", status: "open", quantity: 1, create_date: "2026-07-10", class: "option" }
        ] } }
      },
      {
        match: (u, m) => m === "GET" && u.includes(`/accounts/${ACCT}/orders`) && u.includes("page=2"),
        body: { orders: { order: [
          { id: 11, symbol: "MSFT", side: "sell", type: "stop", status: "open", quantity: 5, create_date: "2026-07-10", stop_price: 300, tag: "protect", class: "equity" }
        ] } }
      },
      // Page 3+: empty — real end of pages.
      { match: (u, m) => m === "GET" && u.includes(`/accounts/${ACCT}/orders`), body: { orders: "null" } }
    ]);
    const { getTradierGateway } = await import("../src/lib/tradier");
    const orders = await getTradierGateway("local").getEquityOrders(ACCT);
    // The option order is dropped; the equity protective stop from page 2 IS present.
    expect(orders.map((o) => o.id)).toEqual(["11"]);
    expect(orders[0]).toMatchObject({ symbol: "MSFT", side: "sell", type: "stop_market", state: "open", stopPrice: 300 });
    // That resting sell is recognized as a live exit by the coverage guard.
    const { isLiveOrderState } = await import("../src/lib/broker-side");
    expect(isLiveOrderState(orders[0].state)).toBe(true);
  });

  it("terminates on a fully-duplicate page (guards a pager that repeats its last page)", async () => {
    await seedTradier();
    // Every page returns the SAME single equity order. The loop must stop once a page adds no NEW id
    // (id-deduped), not spin to the 50-page cap; exactly one order is returned.
    const { records } = installFetchMock([
      {
        match: (u, m) => m === "GET" && u.includes(`/accounts/${ACCT}/orders`),
        body: { orders: { order: [
          { id: 99, symbol: "AAPL", side: "sell", type: "stop", status: "open", quantity: 1, create_date: "2026-07-10", stop_price: 90, class: "equity" }
        ] } }
      }
    ]);
    const { getTradierGateway } = await import("../src/lib/tradier");
    const orders = await getTradierGateway("local").getEquityOrders(ACCT);
    expect(orders).toHaveLength(1);
    const orderPages = records.filter((r) => r.method === "GET" && r.url.includes(`/accounts/${ACCT}/orders`));
    expect(orderPages.length).toBeLessThanOrEqual(2); // page 1 (new) + page 2 (all dup -> stop); never 50
  });

  it("keeps pending_cancel / pending_replace GTC equity stops older than 24h on the default path", async () => {
    await seedTradier();
    installFetchMock([
      {
        match: (u, m) => m === "GET" && u.includes(`/accounts/${ACCT}/orders`),
        body: {
          orders: {
            order: [
              {
                id: 71,
                symbol: "MSFT",
                side: "sell",
                type: "stop",
                status: "pending_cancel",
                quantity: 5,
                create_date: "2026-07-10",
                stop_price: 300,
                tag: "protect-cancel",
                class: "equity"
              },
              {
                id: 72,
                symbol: "AAPL",
                side: "sell",
                type: "stop",
                status: "pending_replace",
                quantity: 2,
                create_date: "2026-07-10",
                stop_price: 180,
                tag: "protect-replace",
                class: "equity"
              },
              {
                id: 73,
                symbol: "NVDA",
                side: "sell",
                type: "market",
                status: "filled",
                quantity: 1,
                create_date: "2026-07-10",
                class: "equity"
              }
            ]
          }
        }
      }
    ]);
    const { getTradierGateway } = await import("../src/lib/tradier");
    const { isLiveOrderState } = await import("../src/lib/broker-side");
    const orders = await getTradierGateway("local").getEquityOrders(ACCT);
    expect(orders.map((o) => o.id).sort()).toEqual(["71", "72"]);
    expect(orders.every((o) => isLiveOrderState(o.state))).toBe(true);
    expect(orders.some((o) => o.id === "73")).toBe(false);
  });

  it("does NOT stop after 5 option-only pages; a page-6 equity exit is still returned", async () => {
    await seedTradier();
    const optionPage = (id: number) => ({
      match: (u: string, m: string) => m === "GET" && u.includes(`/accounts/${ACCT}/orders`) && u.includes(`page=${id}`),
      body: { orders: { order: [
        { id, symbol: "AAPL", side: "buy_to_open", type: "limit", status: "open", quantity: 1, create_date: "2026-08-19", class: "option" }
      ] } }
    });
    installFetchMock([
      optionPage(1),
      optionPage(2),
      optionPage(3),
      optionPage(4),
      optionPage(5),
      {
        match: (u, m) => m === "GET" && u.includes(`/accounts/${ACCT}/orders`) && u.includes("page=6"),
        body: { orders: { order: [
          { id: 66, symbol: "MSFT", side: "sell", type: "stop", status: "open", quantity: 5, create_date: "2026-07-10", stop_price: 300, tag: "protect", class: "equity" }
        ] } }
      },
      { match: (u, m) => m === "GET" && u.includes(`/accounts/${ACCT}/orders`), body: { orders: "null" } }
    ]);
    const { getTradierGateway } = await import("../src/lib/tradier");
    const orders = await getTradierGateway("local").getEquityOrders(ACCT);
    expect(orders.map((o) => o.id)).toEqual(["66"]);
    expect(orders[0]).toMatchObject({ symbol: "MSFT", side: "sell", type: "stop_market", state: "open", stopPrice: 300 });
    const { isLiveOrderState } = await import("../src/lib/broker-side");
    expect(isLiveOrderState(orders[0].state)).toBe(true);
  });
});

describe("Tradier adapter — OTOCO/OCO equity legs surface for coverage (codex-autofix reconciliation)", () => {
  // A user-placed OCO/OTOCO bracket is reported by Tradier as a CONTAINER whose own class is not
  // "equity"; the individual legs are nested under a `leg` array. A resting protective EQUITY stop/
  // limit leg must be surfaced or it is invisible to getEquityOrders coverage. (Leg shape follows
  // Tradier's documented advanced-order response; needs live-token confirmation.)
  it("surfaces resting equity legs nested inside an otoco container; a leg inherits container symbol/status", async () => {
    await seedTradier();
    installFetchMock([
      {
        match: (u, m) => m === "GET" && u.includes(`/accounts/${ACCT}/orders`),
        body: { orders: { order: {
          id: 500, symbol: "AAPL", type: "otoco", class: "otoco", status: "open", create_date: "2026-07-10", tag: "bracket",
          leg: [
            { id: 501, symbol: "AAPL", side: "sell", type: "limit", status: "open", quantity: 10, price: 210, class: "equity" },
            // This leg OMITS symbol + status -> must inherit "AAPL"/"open" from the container.
            { id: 502, side: "sell", type: "stop", quantity: 10, stop_price: 180, class: "equity" }
          ]
        } } }
      }
    ]);
    const { getTradierGateway } = await import("../src/lib/tradier");
    const orders = await getTradierGateway("local").getEquityOrders(ACCT);
    // Container is kept for clientOrderId identity when Tradier omits top-level side.
    // Exit legs still omit the container tag so they cannot steal placement reconciliation.
    expect(orders.map((o) => o.id).sort()).toEqual(["500", "501", "502"]);
    expect(orders.find((o) => o.id === "500")?.clientOrderId).toBe("bracket");
    expect(orders.find((o) => o.id === "501")?.clientOrderId).toBeUndefined();
    expect(orders.find((o) => o.id === "502")?.clientOrderId).toBeUndefined();
    const stopLeg = orders.find((o) => o.type === "stop_market")!;
    expect(stopLeg).toMatchObject({ id: "502", symbol: "AAPL", side: "sell", type: "stop_market", state: "open", stopPrice: 180 });
    const { isLiveOrderState } = await import("../src/lib/broker-side");
    expect(isLiveOrderState(stopLeg.state)).toBe(true); // a long-side coverage check sees the resting exit
  });

  it("a lone option order (container class not equity, no equity legs) is still dropped", async () => {
    await seedTradier();
    installFetchMock([
      {
        match: (u, m) => m === "GET" && u.includes(`/accounts/${ACCT}/orders`),
        body: { orders: { order: {
          id: 600, symbol: "AAPL", side: "buy_to_open", type: "limit", status: "open", quantity: 1, create_date: "2026-07-10", class: "option"
        } } }
      }
    ]);
    const { getTradierGateway } = await import("../src/lib/tradier");
    const orders = await getTradierGateway("local").getEquityOrders(ACCT);
    expect(orders).toEqual([]);
  });
});

describe("Tradier adapter — getPortfolio buying power (no intraday-4x lever-up, codex-autofix reconciliation)", () => {
  // Position sizing must be fed the OVERNIGHT/Reg-T buying power, never the ~4x intraday PDT figure.
  it("a PDT margin account uses the conservative overnight figure, not the inflated pdt intraday one", async () => {
    await seedTradier();
    installFetchMock([
      {
        match: (u) => u.includes("/balances"),
        body: { balances: { account_number: ACCT, total_equity: 10000, total_cash: 2000, market_value: 8000,
          margin: { stock_buying_power: 16000 }, pdt: { stock_buying_power: 64000 } } }
      }
    ]);
    const { getTradierGateway } = await import("../src/lib/tradier");
    const p = await getTradierGateway("local").getPortfolio(ACCT);
    expect(p.buyingPower).toBe(16000); // the 64000 intraday PDT number must NOT inflate sizing
  });

  it("a literal 0 pdt.stock_buying_power is treated as absent, not a real value that zeroes sizing", async () => {
    await seedTradier();
    installFetchMock([
      {
        match: (u) => u.includes("/balances"),
        body: { balances: { account_number: ACCT, total_equity: 5000, total_cash: 1000, market_value: 4000,
          margin: { stock_buying_power: 12000 }, pdt: { stock_buying_power: 0 } } }
      }
    ]);
    const { getTradierGateway } = await import("../src/lib/tradier");
    const p = await getTradierGateway("local").getPortfolio(ACCT);
    expect(p.buyingPower).toBe(12000); // spurious 0 ignored; the real Reg-T figure stands
  });

  it("an absent overnight stock_buying_power does NOT let the intraday 4x figure become buying power", async () => {
    // The min()-asymmetry bug: if Tradier omits the Reg-T OVERNIGHT figure but reports the ~4x
    // INTRADAY pdt figure, the old symmetric min over surviving positive candidates returned the
    // intraday number as buying power and over-levered an overnight hold. The intraday figure must
    // only ever pull BP DOWN, never stand in — an unknown overnight BP reports 0 (which both
    // consumers read as "unknown => don't block, defer to broker"), never 64000.
    await seedTradier();
    installFetchMock([
      {
        match: (u) => u.includes("/balances"),
        body: { balances: { account_number: ACCT, total_equity: 20000, total_cash: 3000, market_value: 17000,
          margin: {}, pdt: { stock_buying_power: 64000 } } }
      }
    ]);
    const { getTradierGateway } = await import("../src/lib/tradier");
    const p = await getTradierGateway("local").getPortfolio(ACCT);
    expect(p.buyingPower).not.toBe(64000); // the intraday 4x number must NEVER be reported as BP
    expect(p.buyingPower).toBe(0); // unknown Reg-T BP => 0 => "don't block, defer to broker"
  });

  it("a zero-filled overnight stock_buying_power also does NOT fall through to the intraday 4x figure", async () => {
    // Same asymmetry, but the overnight field is present as a spurious 0 (positiveNumber => absent)
    // rather than omitted — must behave identically: 0, never the intraday 96000.
    await seedTradier();
    installFetchMock([
      {
        match: (u) => u.includes("/balances"),
        body: { balances: { account_number: ACCT, total_equity: 30000, total_cash: 5000, market_value: 25000,
          margin: { stock_buying_power: 0 }, pdt: { stock_buying_power: 96000 } } }
      }
    ]);
    const { getTradierGateway } = await import("../src/lib/tradier");
    const p = await getTradierGateway("local").getPortfolio(ACCT);
    expect(p.buyingPower).not.toBe(96000);
    expect(p.buyingPower).toBe(0);
  });
});

describe("Tradier tag / synthetic-stop refId 255-char symmetry (finding #4)", () => {
  // brokerPortableRefId (the stored lastAttemptRefId) and Tradier's sanitizeTag (the wire tag) must
  // truncate identically at 255, or a hypothetical long refId would diverge past char 255 and the
  // client-order-id dedup would never match.
  it("brokerPortableRefId caps at 255 chars, matching Tradier's sanitizeTag output", async () => {
    const { brokerPortableRefId } = await import("../src/lib/synthetic-stops");
    const longRaw = "sstop-" + "a".repeat(400);
    const stored = brokerPortableRefId(longRaw);
    expect(stored.length).toBe(255);
    // The tag Tradier actually stores is sanitizeTag(stored); with both capped at 255 it round-trips.
    const brokerTag = stored.replace(/[^a-zA-Z0-9-]/g, "-").slice(0, 255);
    expect(brokerTag).toBe(stored);
  });
});

describe("Tradier adapter — tenant isolation", () => {
  it("user B never resolves user A's stored token; a non-owner with no row throws", async () => {
    await seedTradier({ userId: "local", environment: "paper", token: SANDBOX_TOKEN });
    installFetchMock([
      { match: (u) => u.includes("/user/profile"), body: { profile: { account: { account_number: ACCT, type: "margin", classification: "individual" } } } }
    ]);
    const { getTradierGateway } = await import("../src/lib/tradier");
    // User B has no Tradier row -> construction throws, never borrows 'local'.
    expect(() => getTradierGateway("u_other")).toThrow(/No Tradier account connected/);
  });
});

describe("Tradier adapter — native OTOCO/OTO bracket order placement", () => {
  it("places an OTOCO (class=otoco) with indexed legs when both take-profit and stop-loss are set", async () => {
    await seedTradier();
    const { records } = installFetchMock([
      { match: (u, m) => m === "POST" && u.includes("/orders"), body: { order: { id: 900, status: "ok" } } }
    ]);
    const { getTradierGateway } = await import("../src/lib/tradier");
    const res = await getTradierGateway("local").placeEquityOrder({
      accountNumber: ACCT, symbol: "AAPL", side: "buy", type: "limit", quantity: 10, limitPrice: 190,
      timeInForce: "gfd", marketHours: "regular_hours", bracketTakeProfit: 210, bracketStopLoss: 175,
      refId: "otoco-ref-1"
    });
    expect(res).toMatchObject({ orderId: "900", state: "pending", refId: "otoco-ref-1" });
    const post = records.find((r) => r.method === "POST")!;
    const form = new URLSearchParams(post.body ?? "");
    expect(form.get("class")).toBe("otoco");
    expect(form.get("symbol[0]")).toBe("AAPL");
    expect(form.get("side[0]")).toBe("buy");
    expect(form.get("quantity[0]")).toBe("10");
    expect(form.get("type[0]")).toBe("limit");
    expect(form.get("price[0]")).toBe("190");
    expect(form.get("symbol[1]")).toBe("AAPL");
    expect(form.get("side[1]")).toBe("sell"); // exit leg for a long entry
    expect(form.get("type[1]")).toBe("limit");
    expect(form.get("price[1]")).toBe("210");
    expect(form.get("symbol[2]")).toBe("AAPL");
    expect(form.get("side[2]")).toBe("sell");
    expect(form.get("type[2]")).toBe("stop");
    expect(form.get("stop[2]")).toBe("175");
  });

  it("places an OTO (class=oto, single exit leg) when only a stop-loss is set", async () => {
    await seedTradier();
    const { records } = installFetchMock([
      { match: (u, m) => m === "POST" && u.includes("/orders"), body: { order: { id: 901, status: "ok" } } }
    ]);
    const { getTradierGateway } = await import("../src/lib/tradier");
    await getTradierGateway("local").placeEquityOrder({
      accountNumber: ACCT, symbol: "TSLA", side: "buy", type: "stop_market", quantity: 5, stopPrice: 300,
      timeInForce: "gfd", marketHours: "regular_hours", bracketStopLoss: 250,
      refId: "oto-ref-1"
    });
    const post = records.find((r) => r.method === "POST")!;
    const form = new URLSearchParams(post.body ?? "");
    expect(form.get("class")).toBe("oto");
    expect(form.get("type[0]")).toBe("stop"); // stop_market -> "stop" on the wire
    expect(form.get("stop[0]")).toBe("300");
    expect(form.get("symbol[1]")).toBe("TSLA");
    expect(form.get("side[1]")).toBe("sell");
    expect(form.get("type[1]")).toBe("stop");
    expect(form.get("stop[1]")).toBe("250");
    expect(form.get("symbol[2]")).toBeNull(); // no second exit leg
  });

  it("uses a stop_limit exit leg when bracketStopLimit is provided", async () => {
    await seedTradier();
    const { records } = installFetchMock([
      { match: (u, m) => m === "POST" && u.includes("/orders"), body: { order: { id: 902, status: "ok" } } }
    ]);
    const { getTradierGateway } = await import("../src/lib/tradier");
    await getTradierGateway("local").placeEquityOrder({
      accountNumber: ACCT, symbol: "NVDA", side: "buy", type: "limit", quantity: 3, limitPrice: 500,
      timeInForce: "gfd", marketHours: "regular_hours", bracketTakeProfit: 560, bracketStopLoss: 470, bracketStopLimit: 465,
      refId: "otoco-ref-stoplimit"
    });
    const post = records.find((r) => r.method === "POST")!;
    const form = new URLSearchParams(post.body ?? "");
    expect(form.get("type[2]")).toBe("stop_limit");
    expect(form.get("stop[2]")).toBe("470");
    expect(form.get("price[2]")).toBe("465");
  });

  it("uses exit side buy_to_cover for a short entry's bracket legs", async () => {
    await seedTradier();
    const { records } = installFetchMock([
      { match: (u, m) => m === "POST" && u.includes("/orders"), body: { order: { id: 903, status: "ok" } } }
    ]);
    const { getTradierGateway } = await import("../src/lib/tradier");
    await getTradierGateway("local").placeEquityOrder({
      accountNumber: ACCT, symbol: "MSFT", side: "short", type: "limit", quantity: 4, limitPrice: 400,
      timeInForce: "gfd", marketHours: "regular_hours", bracketTakeProfit: 370, bracketStopLoss: 420,
      refId: "otoco-short-ref"
    });
    const post = records.find((r) => r.method === "POST")!;
    const form = new URLSearchParams(post.body ?? "");
    expect(form.get("side[0]")).toBe("sell_short");
    expect(form.get("side[1]")).toBe("buy_to_cover");
    expect(form.get("side[2]")).toBe("buy_to_cover");
  });

  it("falls back to a PLAIN single-leg order (no bracket) for a market-type entry — OTOCO leg[0] has no market type", async () => {
    await seedTradier();
    const { records } = installFetchMock([
      { match: (u, m) => m === "POST" && u.includes("/orders"), body: { order: { id: 904, status: "ok" } } }
    ]);
    const { getTradierGateway } = await import("../src/lib/tradier");
    await getTradierGateway("local").placeEquityOrder({
      accountNumber: ACCT, symbol: "AMZN", side: "buy", type: "market", quantity: 2,
      timeInForce: "gfd", marketHours: "regular_hours", bracketTakeProfit: 230, bracketStopLoss: 185,
      refId: "market-bracket-fallback"
    });
    const post = records.find((r) => r.method === "POST")!;
    const form = new URLSearchParams(post.body ?? "");
    expect(form.get("class")).toBe("equity"); // plain order, bracket silently not attached
    expect(form.get("symbol[0]")).toBeNull();
  });

  it("places a plain equity order (no class param at all beyond 'equity') when no bracket fields are set", async () => {
    await seedTradier();
    const { records } = installFetchMock([
      { match: (u, m) => m === "POST" && u.includes("/orders"), body: { order: { id: 905, status: "ok" } } }
    ]);
    const { getTradierGateway } = await import("../src/lib/tradier");
    await getTradierGateway("local").placeEquityOrder({
      accountNumber: ACCT, symbol: "SPY", side: "buy", type: "market", quantity: 1,
      timeInForce: "gfd", marketHours: "regular_hours", refId: "no-bracket-ref"
    });
    const post = records.find((r) => r.method === "POST")!;
    const form = new URLSearchParams(post.body ?? "");
    expect(form.get("class")).toBe("equity");
  });
});

describe("Tradier adapter — cancelBracketSiblingLegs (bracket sibling-leg teardown)", () => {
  it("cancels only the still-open legs of an OTOCO container, skipping a filled/canceled one", async () => {
    await seedTradier();
    const { records } = installFetchMock([
      {
        match: (u, m) => m === "GET" && u.includes("/orders/900"),
        body: { order: { id: 900, class: "otoco", symbol: "AAPL", status: "open", leg: [
          { id: 901, class: "equity", status: "open" },
          { id: 902, class: "equity", status: "filled" }
        ] } }
      },
      { match: (u, m) => m === "DELETE" && u.includes("/orders/901"), body: { order: { id: 901, status: "ok" } } }
    ]);
    const { getTradierGateway } = await import("../src/lib/tradier");
    const result = await getTradierGateway("local").cancelBracketSiblingLegs!(ACCT, "900");
    expect(result.cancelledOrderIds).toEqual(["901"]);
    expect(records.some((r) => r.method === "DELETE" && r.url.includes("/orders/901"))).toBe(true);
    expect(records.some((r) => r.method === "DELETE" && r.url.includes("/orders/902"))).toBe(false);
  });

  it("returns no cancellations for a plain (non-container) order", async () => {
    await seedTradier();
    installFetchMock([
      { match: (u, m) => m === "GET" && u.includes("/orders/800"), body: { order: { id: 800, class: "equity", symbol: "AAPL", status: "filled" } } }
    ]);
    const { getTradierGateway } = await import("../src/lib/tradier");
    const result = await getTradierGateway("local").cancelBracketSiblingLegs!(ACCT, "800");
    expect(result.cancelledOrderIds).toEqual([]);
  });

  it("never cancels the entry order itself when no bracket was ever attached, even if it's still OPEN (not just filled)", async () => {
    await seedTradier();
    const { records } = installFetchMock([
      // A market-type entry (Tradier can't carry a bracket leg[0] of type market) falls through to a
      // plain single-leg order in placeEquityOrder, but openingOrderId is still recorded on the plan
      // (see performance.ts) — this order is class "equity" and still resting (partial fill), which
      // must NOT be treated as a cancellable "sibling" of itself (adversarial review of PR #1661).
      { match: (u, m) => m === "GET" && u.includes("/orders/801"), body: { order: { id: 801, class: "equity", symbol: "AAPL", status: "open" } } }
    ]);
    const { getTradierGateway } = await import("../src/lib/tradier");
    const result = await getTradierGateway("local").cancelBracketSiblingLegs!(ACCT, "801");
    expect(result.cancelledOrderIds).toEqual([]);
    expect(records.some((r) => r.method === "DELETE")).toBe(false);
  });

  it("resolves as done (empty result) when the order is gone via a genuine HTTP 404", async () => {
    await seedTradier();
    installFetchMock([
      { match: (u, m) => m === "GET" && u.includes("/orders/never-existed"), body: { errors: { error: "no such order" } }, status: 404 }
    ]);
    const { getTradierGateway } = await import("../src/lib/tradier");
    const result = await getTradierGateway("local").cancelBracketSiblingLegs!(ACCT, "never-existed");
    expect(result.cancelledOrderIds).toEqual([]);
  });

  it("resolves as done (empty result) when Tradier's own 200-with-errors-envelope reports the order not found", async () => {
    await seedTradier();
    installFetchMock([
      { match: (u, m) => m === "GET" && u.includes("/orders/gone"), body: { errors: { error: "not found" } }, status: 200 }
    ]);
    const { getTradierGateway } = await import("../src/lib/tradier");
    const result = await getTradierGateway("local").cancelBracketSiblingLegs!(ACCT, "gone");
    expect(result.cancelledOrderIds).toEqual([]);
  });

  it("propagates a NON-not-found lookup failure so the caller's bounded-retry sweep actually retries it", async () => {
    await seedTradier();
    installFetchMock([
      { match: (u, m) => m === "GET" && u.includes("/orders/901-transient"), body: { errors: { error: "internal server error" } }, status: 503 }
    ]);
    const { getTradierGateway } = await import("../src/lib/tradier");
    await expect(getTradierGateway("local").cancelBracketSiblingLegs!(ACCT, "901-transient")).rejects.toThrow();
  });

  // Codex round-1 review (2026-09-07): the rollout note claimed this idempotent GET was opted
  // into the transient-retry option, but the actual trackHealth call site omitted it — a dead
  // keep-alive socket would consume one of the pending teardown row's ten attempts and defer to
  // another scheduler tick instead of retrying once in-process.
  it("retries once on a dead-socket TypeError instead of consuming a teardown-row attempt", async () => {
    await seedTradier();
    let attempt = 0;
    vi.stubGlobal("fetch", async () => {
      attempt += 1;
      if (attempt === 1) throw new TypeError("fetch failed");
      return new Response(
        JSON.stringify({ order: { id: 900, class: "equity", symbol: "AAPL", status: "filled" } }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });
    const { getTradierGateway } = await import("../src/lib/tradier");
    const result = await getTradierGateway("local").cancelBracketSiblingLegs!(ACCT, "900");
    expect(attempt).toBe(2);
    expect(result.cancelledOrderIds).toEqual([]);
  });
});

describe("Tradier adapter — option positions", () => {
  it("fetches and maps option positions, parses OCC symbols, and prices them via getEquityQuotes", async () => {
    await seedTradier();
    installFetchMock([
      {
        match: (u, m) => m === "GET" && u.includes(`/accounts/${ACCT}/positions`),
        body: {
          positions: {
            position: [
              {
                symbol: "DELL  260717C00150000",
                quantity: 2,
                cost_basis: 500.0,
                date_acquired: "2026-07-01T00:00:00Z"
              },
              {
                symbol: "AAPL",
                quantity: 10,
                cost_basis: 1500.0
              }
            ]
          }
        }
      },
      {
        match: (u, m) => m === "GET" && u.includes("/markets/quotes") && u.includes("DELL260717C00150000"),
        body: {
          quotes: {
            quote: {
              symbol: "DELL260717C00150000",
              last: 3.5,
              volume: 100
            }
          }
        }
      }
    ]);
    const { getTradierGateway } = await import("../src/lib/tradier");
    const gateway = getTradierGateway("local");
    const result = await gateway.getOptionPositions!(ACCT);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      symbol: "DELL260717C00150000",
      underlyingSymbol: "DELL",
      expirationDate: "2026-07-17",
      optionType: "call",
      strikePrice: 150.0,
      quantity: 2,
      averageCost: 2.5,
      marketValue: 700.0
    });
  });
});

// Production evidence (litestream-runtime.log, 2026-08-29..2026-09-07): 1,364 "Tradier order
// capability probe failed" events over 9 days, all landing in the generic fallback bucket because
// the old regex never matched Tradier's actual "Unexpected server error" wording (there is a
// "server" between "unexpected" and "error") nor a timeout. These tests pin the fixed
// classification and the exponential-backoff cache that stops a sustained failure from re-probing
// (and re-warning) every 60s tick.
describe("Tradier adapter — probeOrderCapability classification", () => {
  it("classifies 'HTTP 400: Unexpected server error' as a transient server error, not the generic fallback", async () => {
    await seedTradier({ environment: "paper" });
    installFetchMock([
      {
        match: (u, m) => m === "POST" && u.includes(`/accounts/${ACCT}/orders`),
        status: 400,
        body: { errors: { error: "Unexpected server error" } }
      }
    ]);
    const { getTradierGateway } = await import("../src/lib/tradier");
    const result = await getTradierGateway("local").probeOrderCapability!(ACCT);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/Tradier order path unavailable/);
  });

  it("still treats a structured OMS validation rejection (buying power) as healthy order capability", async () => {
    await seedTradier({ environment: "paper" });
    installFetchMock([
      {
        match: (u, m) => m === "POST" && u.includes(`/accounts/${ACCT}/orders`),
        status: 400,
        body: { errors: { error: "Not enough buying power" } }
      }
    ]);
    const { getTradierGateway } = await import("../src/lib/tradier");
    const result = await getTradierGateway("local").probeOrderCapability!(ACCT);
    expect(result).toEqual({ ok: true });
  });

  it("classifies a genuinely unrecognized failure as its own category rather than 'connectivity'", async () => {
    await seedTradier({ environment: "paper" });
    installFetchMock([
      {
        match: (u, m) => m === "POST" && u.includes(`/accounts/${ACCT}/orders`),
        status: 401,
        body: { errors: { error: "Invalid access token" } }
      }
    ]);
    const { getTradierGateway } = await import("../src/lib/tradier");
    const result = await getTradierGateway("local").probeOrderCapability!(ACCT);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/Tradier order capability probe failed:/);
  });
});

describe("Tradier adapter — probeOrderCapability exponential backoff", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("backs off exponentially on a sustained identical failure instead of re-probing every call", async () => {
    vi.useFakeTimers();
    await seedTradier({ environment: "paper" });
    const { records } = installFetchMock([
      {
        match: (u, m) => m === "POST" && u.includes(`/accounts/${ACCT}/orders`),
        status: 400,
        body: { errors: { error: "Unexpected server error" } }
      }
    ]);
    const { getTradierGateway } = await import("../src/lib/tradier");
    const gateway = getTradierGateway("local");
    const probeCalls = () =>
      records.filter((r) => r.method === "POST" && r.url.includes(`/accounts/${ACCT}/orders`)).length;

    const start = Date.now();
    vi.setSystemTime(start);
    await gateway.probeOrderCapability!(ACCT);
    expect(probeCalls()).toBe(1);

    // Immediately again — served from the cache, no new network call.
    await gateway.probeOrderCapability!(ACCT);
    expect(probeCalls()).toBe(1);

    // Past the base 2-minute TTL — first backoff step (streak 0 -> 1), re-probes.
    vi.setSystemTime(start + 2 * 60_000 + 1);
    await gateway.probeOrderCapability!(ACCT);
    expect(probeCalls()).toBe(2);

    // Only 2 more minutes (would have expired the OLD fixed 2-minute TTL) — the streak is now 1,
    // doubling the effective TTL to 4 minutes, so this must still be served from cache.
    vi.setSystemTime(start + 2 * 60_000 + 1 + 2 * 60_000);
    await gateway.probeOrderCapability!(ACCT);
    expect(probeCalls()).toBe(2);

    // Past the doubled 4-minute window — re-probes again.
    vi.setSystemTime(start + 2 * 60_000 + 1 + 4 * 60_000 + 1);
    await gateway.probeOrderCapability!(ACCT);
    expect(probeCalls()).toBe(3);
  });

  it("resets the backoff streak once the probe recovers, instead of continuing to back off", async () => {
    vi.useFakeTimers();
    await seedTradier({ environment: "paper" });
    let failing = true;
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push(`${method} ${u}`);
      if (method === "POST" && u.includes(`/accounts/${ACCT}/orders`)) {
        if (failing) {
          return new Response(JSON.stringify({ errors: { error: "Unexpected server error" } }), {
            status: 400,
            headers: { "content-type": "application/json" }
          });
        }
        return new Response(JSON.stringify({ order: { id: "1", status: "ok" } }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      return new Response("", { status: 404 });
    });
    const { getTradierGateway } = await import("../src/lib/tradier");
    const gateway = getTradierGateway("local");

    const start = Date.now();
    vi.setSystemTime(start);
    let result = await gateway.probeOrderCapability!(ACCT);
    expect(result.ok).toBe(false);

    failing = false;
    vi.setSystemTime(start + 2 * 60_000 + 1);
    result = await gateway.probeOrderCapability!(ACCT);
    expect(result.ok).toBe(true);

    // Recovery must reset the streak: the very next failure re-probes at the BASE 2-minute TTL,
    // not a TTL that continued doubling from the earlier failing streak.
    failing = true;
    vi.setSystemTime(start + 2 * 60_000 + 1 + 2 * 60_000 + 1);
    result = await gateway.probeOrderCapability!(ACCT);
    expect(result.ok).toBe(false);
  });

  // Codex round-1 review (2026-09-07): the backoff previously applied to a HEALTHY streak too,
  // so a long run of consecutive successes could ride the cached "ok" result all the way to the
  // 60-minute ceiling — if the order path then actually went down, checkBrokerHealth could keep
  // accepting that stale success for up to an hour instead of the intended 2-minute base window.
  it("keeps successful probes at the base 2-minute TTL — never backs off a healthy streak", async () => {
    vi.useFakeTimers();
    await seedTradier({ environment: "paper" });
    const { records } = installFetchMock([
      {
        match: (u, m) => m === "POST" && u.includes(`/accounts/${ACCT}/orders`),
        status: 200,
        body: { order: { id: "1", status: "ok" } }
      }
    ]);
    const { getTradierGateway } = await import("../src/lib/tradier");
    const gateway = getTradierGateway("local");
    const probeCalls = () =>
      records.filter((r) => r.method === "POST" && r.url.includes(`/accounts/${ACCT}/orders`)).length;

    const start = Date.now();
    vi.setSystemTime(start);
    // Build up a long consecutive-success streak — if success were backed off like failure, this
    // would grow the cache TTL well past the base 2 minutes.
    for (let i = 0; i < 6; i++) {
      vi.setSystemTime(start + i * 2 * 60_000 + 1);
      const result = await gateway.probeOrderCapability!(ACCT);
      expect(result.ok).toBe(true);
    }
    expect(probeCalls()).toBe(6); // each call landed exactly on the base 2-minute boundary and re-probed

    const lastSuccessAt = start + 5 * 2 * 60_000 + 1; // the final loop iteration's timestamp

    // A probe requested only ~90s after the last success (under the 2-minute base TTL) must still
    // be served from cache...
    vi.setSystemTime(lastSuccessAt + 90_000);
    await gateway.probeOrderCapability!(ACCT);
    expect(probeCalls()).toBe(6);

    // ...but past the base 2-minute TTL, it must re-probe immediately — NOT wait out an
    // exponentially-grown window the way a failing streak would.
    vi.setSystemTime(lastSuccessAt + 2 * 60_000 + 1);
    await gateway.probeOrderCapability!(ACCT);
    expect(probeCalls()).toBe(7);
  });
});

describe("Tradier adapter — read-path retry on a transient network failure", () => {
  it("getAccounts retries once on a dead-socket TypeError and succeeds on the fresh connection", async () => {
    await seedTradier({ environment: "paper" });
    let attempt = 0;
    vi.stubGlobal("fetch", async () => {
      attempt += 1;
      if (attempt === 1) throw new TypeError("fetch failed");
      return new Response(
        JSON.stringify({ profile: { account: { account_number: ACCT, type: "margin", classification: "individual" } } }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });
    const { getTradierGateway } = await import("../src/lib/tradier");
    const accounts = await getTradierGateway("local").getAccounts();
    expect(attempt).toBe(2);
    expect(accounts).toHaveLength(1);
    expect(accounts[0].accountNumber).toBe(ACCT);
  });

  it("placeEquityOrder (a real order write) does NOT retry a transient network failure", async () => {
    await seedTradier({ environment: "paper" });
    let attempt = 0;
    vi.stubGlobal("fetch", async () => {
      attempt += 1;
      throw new TypeError("fetch failed");
    });
    const { getTradierGateway } = await import("../src/lib/tradier");
    await expect(
      getTradierGateway("local").placeEquityOrder({
        accountNumber: ACCT,
        symbol: "AAPL",
        side: "buy",
        quantity: 1,
        type: "market",
        timeInForce: "gfd",
        marketHours: "regular_hours",
        refId: "r-1"
      })
    ).rejects.toThrow();
    // Exactly one attempt — a retried write after Tradier may have already accepted the POST
    // risks a genuine duplicate order, so writes never opt into trackHealth's retryTransient.
    expect(attempt).toBe(1);
  });
});

