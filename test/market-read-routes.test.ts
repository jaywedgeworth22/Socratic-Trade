// Tests for the token-gated market-data READ endpoints (congress.trade cache-aside price pulls):
//   GET /api/market/prices/{symbol}  -> PriceSeries envelope, closes DESCENDING
//   GET /api/market/spx              -> { closes } DESCENDING (SPY daily bars)
//   GET /api/market/quotes + /api/market/intraday/{symbol} (#2953 peer routes)
// plus the src/lib/market-read.ts shaping helpers and the middleware bearer pass-through.
//
// Route tests drive the real handlers with APP_B_INGEST_TOKEN set; fetchDailyOHLC is module-mocked
// so no network/DB is touched. Lib tests inject canned bars via the fetcher parameter instead.

import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import type { OHLCBar } from "../src/lib/indicators";
import { closesInRange, fetchCompanyProfile, fetchPriceSeries, fetchSpxCloses, parseMarketRange } from "../src/lib/market-read";
import { GET as profileRoute } from "../app/api/market/profile/[symbol]/route";
import { fetchDailyOHLC } from "../src/lib/history";
import { GET as pricesRoute } from "../app/api/market/prices/[symbol]/route";
import { GET as spxRoute } from "../app/api/market/spx/route";

vi.mock("../src/lib/history", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/history")>();
  return { ...actual, fetchDailyOHLC: vi.fn() };
});
const mockFetchDailyOHLC = vi.mocked(fetchDailyOHLC);

const TEST_TOKEN = "st_ingest_test_secret";
const savedEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-market-read-${randomUUID()}.db`)}`;
  for (const key of ["APP_B_INGEST_TOKEN", "AUTH_SECRET"]) savedEnv[key] = process.env[key];
});

beforeEach(() => {
  process.env.APP_B_INGEST_TOKEN = TEST_TOKEN;
  mockFetchDailyOHLC.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/** Canned daily bar with a ms-epoch time (Massive shape). */
function bar(date: string, close: number, volume?: number): OHLCBar {
  return { time: Date.parse(`${date}T00:00:00Z`), close, ...(volume !== undefined ? { volume } : {}) };
}

function authedRequest(url: string, token?: string): Request {
  // No default: an omitted token must produce a genuinely header-less request (the 401 path).
  return new Request(url, token ? { headers: { authorization: `Bearer ${token}` } } : undefined);
}

// ── parseMarketRange ─────────────────────────────────────────────────────────

describe("parseMarketRange", () => {
  const now = new Date(Date.UTC(2026, 6, 31)); // 2026-07-31

  it("defaults to a ~1y window ending today when params are omitted", () => {
    expect(parseMarketRange("http://x/api/market/spx", now)).toEqual({ from: "2025-07-30", to: "2026-07-31" });
  });

  it("passes valid from/to through unchanged", () => {
    expect(parseMarketRange("http://x/api/market/spx?from=2026-01-01&to=2026-06-30", now)).toEqual({
      from: "2026-01-01",
      to: "2026-06-30"
    });
  });

  it("falls back to the default for malformed params instead of erroring", () => {
    expect(parseMarketRange("http://x/api/market/spx?from=yesterday&to=2026-06-30", now)).toEqual({
      from: "2025-07-30",
      to: "2026-06-30"
    });
  });
});

// ── closesInRange ────────────────────────────────────────────────────────────

describe("closesInRange", () => {
  it("filters inclusively and preserves order", () => {
    const closes = [
      { date: "2026-07-28", close: 1 },
      { date: "2026-07-29", close: 2 },
      { date: "2026-07-30", close: 3 },
      { date: "2026-07-31", close: 4 }
    ];
    expect(closesInRange(closes, "2026-07-29", "2026-07-30")).toEqual([
      { date: "2026-07-29", close: 2 },
      { date: "2026-07-30", close: 3 }
    ]);
  });
});

// ── fetchPriceSeries ─────────────────────────────────────────────────────────

describe("fetchPriceSeries", () => {
  const range = { from: "2026-07-01", to: "2026-07-31" };

  it("returns closes DESCENDING with volume, ticker uppercased", async () => {
    const series = await fetchPriceSeries("aapl", range, async () => [
      bar("2026-07-28", 230.1, 40_000_000),
      bar("2026-07-29", 231.0, 41_000_000),
      bar("2026-07-30", 233.4, 41_230_000)
    ]);
    expect(series.ticker).toBe("AAPL");
    expect(series.closes).toEqual([
      { date: "2026-07-30", close: 233.4, volume: 41_230_000 },
      { date: "2026-07-29", close: 231.0, volume: 41_000_000 },
      { date: "2026-07-28", close: 230.1, volume: 40_000_000 }
    ]);
    expect(series.currentPrice).toBe(233.4);
    expect(series.currentPriceDate).toBe("2026-07-30");
  });

  it("filters closes to [from, to] but keeps currentPrice from the full series", async () => {
    const series = await fetchPriceSeries("AAPL", { from: "2026-07-01", to: "2026-07-28" }, async () => [
      bar("2026-07-27", 228),
      bar("2026-07-28", 230.1),
      bar("2026-07-30", 233.4)
    ]);
    expect(series.closes).toEqual([
      { date: "2026-07-28", close: 230.1 },
      { date: "2026-07-27", close: 228 }
    ]);
    // Range-independent: the true latest close even though it falls outside the requested window.
    expect(series.currentPrice).toBe(233.4);
    expect(series.currentPriceDate).toBe("2026-07-30");
  });

  it("unknown symbol / no bars → 200-shaped empty series (closes: [], null currentPrice)", async () => {
    const series = await fetchPriceSeries("NOTREAL", range, async () => null);
    expect(series).toEqual({ ticker: "NOTREAL", closes: [], currentPrice: null, currentPriceDate: null });
  });

  it("empty symbol never calls the fetcher", async () => {
    const fetcher = vi.fn(async () => [bar("2026-07-30", 1)]);
    const series = await fetchPriceSeries("   ", range, fetcher);
    expect(fetcher).not.toHaveBeenCalled();
    expect(series.closes).toEqual([]);
  });
});

// ── fetchSpxCloses ───────────────────────────────────────────────────────────

describe("fetchSpxCloses", () => {
  it("pulls SPY bars and returns them DESCENDING within the range", async () => {
    const fetcher = vi.fn(async () => [bar("2026-07-29", 635.1), bar("2026-07-30", 636.2)]);
    const closes = await fetchSpxCloses({ from: "2026-07-01", to: "2026-07-31" }, fetcher);
    expect(fetcher).toHaveBeenCalledWith("SPY");
    expect(closes).toEqual([
      { date: "2026-07-30", close: 636.2 },
      { date: "2026-07-29", close: 635.1 }
    ]);
  });

  it("returns an empty array when no SPY bars are available", async () => {
    expect(await fetchSpxCloses({ from: "2026-07-01", to: "2026-07-31" }, async () => null)).toEqual([]);
  });
});

// ── route handlers ───────────────────────────────────────────────────────────

describe("GET /api/market/prices/[symbol]", () => {
  const url = "http://localhost/api/market/prices/AAPL?from=2026-07-01&to=2026-07-31";
  const ctx = { params: Promise.resolve({ symbol: "AAPL" }) };

  it("401s without a bearer token (and never fetches)", async () => {
    const res = await pricesRoute(authedRequest(url), ctx);
    expect(res.status).toBe(401);
    expect(mockFetchDailyOHLC).not.toHaveBeenCalled();
  });

  it("401s with a wrong bearer token", async () => {
    const res = await pricesRoute(authedRequest(url, "st_ingest_wrong"), ctx);
    expect(res.status).toBe(401);
    expect(mockFetchDailyOHLC).not.toHaveBeenCalled();
  });

  it("401s when APP_B_INGEST_TOKEN is not configured (default-closed)", async () => {
    delete process.env.APP_B_INGEST_TOKEN;
    const res = await pricesRoute(authedRequest(url, TEST_TOKEN), ctx);
    expect(res.status).toBe(401);
  });

  it("200 with the contract envelope (closes DESCENDING) for an authorized read", async () => {
    mockFetchDailyOHLC.mockResolvedValue([
      bar("2026-07-29", 231.0, 41_000_000),
      bar("2026-07-30", 233.4, 41_230_000)
    ]);
    const res = await pricesRoute(authedRequest(url, TEST_TOKEN), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ticker: "AAPL",
      closes: [
        { date: "2026-07-30", close: 233.4, volume: 41_230_000 },
        { date: "2026-07-29", close: 231.0, volume: 41_000_000 }
      ],
      currentPrice: 233.4,
      currentPriceDate: "2026-07-30"
    });
  });

  it("200 with empty closes for an unknown symbol (not an error status)", async () => {
    mockFetchDailyOHLC.mockResolvedValue(null);
    const res = await pricesRoute(authedRequest("http://localhost/api/market/prices/NOTREAL", TEST_TOKEN), {
      params: Promise.resolve({ symbol: "NOTREAL" })
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ticker).toBe("NOTREAL");
    expect(body.closes).toEqual([]);
  });
});

describe("GET /api/market/spx", () => {
  const url = "http://localhost/api/market/spx?from=2026-07-01&to=2026-07-31";

  it("401s without a bearer token", async () => {
    const res = await spxRoute(authedRequest(url));
    expect(res.status).toBe(401);
    expect(mockFetchDailyOHLC).not.toHaveBeenCalled();
  });

  it("200 with { closes } DESCENDING from SPY daily bars", async () => {
    mockFetchDailyOHLC.mockResolvedValue([bar("2026-07-29", 635.1), bar("2026-07-30", 636.2)]);
    const res = await spxRoute(authedRequest(url, TEST_TOKEN));
    expect(res.status).toBe(200);
    // The peer-serving default must skip the App A read-back tier: serving App A's own
    // request through a tier that calls App A back is a guaranteed-wasted echo hop.
    expect(mockFetchDailyOHLC).toHaveBeenCalledWith("SPY", expect.any(Number), undefined, {
      skipAppATier: true,
      usageLabel: "congress-read",
    });
    expect(await res.json()).toEqual({
      closes: [
        { date: "2026-07-30", close: 636.2 },
        { date: "2026-07-29", close: 635.1 }
      ]
    });
  });

  it("200 with { closes: [] } when no SPY bars exist in range", async () => {
    mockFetchDailyOHLC.mockResolvedValue(null);
    const res = await spxRoute(authedRequest(url, TEST_TOKEN));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ closes: [] });
  });
});


// ── /api/market/profile/{symbol} ─────────────────────────────────────────────

describe("GET /api/market/profile/{symbol}", () => {
  function profileUrl(symbol: string): string {
    return `http://x/api/market/profile/${symbol}`;
  }

  it("401 without bearer", async () => {
    const res = await profileRoute(authedRequest(profileUrl("AAPL")), {
      params: Promise.resolve({ symbol: "AAPL" })
    });
    expect(res.status).toBe(401);
  });

  it("404 { ref: null } envelope when screener has no row (no bare framework 404)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ data: { table: { rows: [] } } })
      ) as unknown as typeof fetch
    );
    const res = await profileRoute(authedRequest(profileUrl("ZZZZNOPE"), TEST_TOKEN), {
      params: Promise.resolve({ symbol: "ZZZZNOPE" })
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ ref: null });
  });

  it("helper returns null when the injected lookup misses", async () => {
    expect(await fetchCompanyProfile("ZZZZNOPE", async () => null)).toBeNull();
  });

  it("200 { ref } when lookup returns sector/industry/marketCap", async () => {
    // Unit the helper with an injected lookup (no network / DB).
    const ref = await fetchCompanyProfile("MSFT", async () => ({
      ticker: "MSFT",
      companyName: "Microsoft Corporation",
      sector: "Technology",
      industry: "Software",
      marketCap: 3_000_000_000_000,
      assetClass: "equity"
    }));
    expect(ref).toEqual({
      ticker: "MSFT",
      companyName: "Microsoft Corporation",
      sector: "Technology",
      industry: "Software",
      marketCap: 3_000_000_000_000,
      assetClass: "equity"
    });
  });

  it("returns null from the helper for an empty symbol", async () => {
    expect(await fetchCompanyProfile("   ", async () => ({ ticker: "X" }))).toBeNull();
  });
});

// ── middleware pass-through ──────────────────────────────────────────────────

describe("middleware — market read bearer pass-through", () => {
  async function loadMiddleware() {
    const mod = await import("../middleware.js");
    return mod.middleware as (req: NextRequest) => Promise<import("next/server").NextResponse>;
  }

  function mwRequest(path: string, headers: Record<string, string> = {}): NextRequest {
    return new NextRequest(`https://trading.example.com${path}`, { headers });
  }

  it("lets a bearer request through to /api/market/spx without a session", async () => {
    vi.resetModules();
    process.env.AUTH_SECRET = "test-secret";
    const middleware = await loadMiddleware();
    const res = await middleware(mwRequest("/api/market/spx", { authorization: `Bearer ${TEST_TOKEN}` }));
    // Passed through (NextResponse.next) — NOT the fail-closed 401.
    expect(res.status).not.toBe(401);
  });

  it("lets a bearer request through to /api/market/prices/{symbol} without a session", async () => {
    vi.resetModules();
    process.env.AUTH_SECRET = "test-secret";
    const middleware = await loadMiddleware();
    const res = await middleware(mwRequest("/api/market/prices/AAPL", { authorization: `Bearer ${TEST_TOKEN}` }));
    expect(res.status).not.toBe(401);
  });

  it("lets a bearer request through to /api/market/quotes without a session", async () => {
    vi.resetModules();
    process.env.AUTH_SECRET = "test-secret";
    const middleware = await loadMiddleware();
    const res = await middleware(mwRequest("/api/market/quotes", { authorization: `Bearer ${TEST_TOKEN}` }));
    expect(res.status).not.toBe(401);
  });

  it("lets a bearer request through to /api/market/intraday/{symbol} without a session", async () => {
    vi.resetModules();
    process.env.AUTH_SECRET = "test-secret";
    const middleware = await loadMiddleware();
    const res = await middleware(mwRequest("/api/market/intraday/AAPL", { authorization: `Bearer ${TEST_TOKEN}` }));
    expect(res.status).not.toBe(401);
  });

  it("lets a bearer request through to /api/market/profile/{symbol} without a session", async () => {
    vi.resetModules();
    process.env.AUTH_SECRET = "test-secret";
    const middleware = await loadMiddleware();
    const res = await middleware(mwRequest("/api/market/profile/AAPL", { authorization: `Bearer ${TEST_TOKEN}` }));
    expect(res.status).not.toBe(401);
  });

  it("still fail-closes /api/market/quotes with NO bearer token", async () => {
    vi.resetModules();
    process.env.AUTH_SECRET = "test-secret";
    const middleware = await loadMiddleware();
    const res = await middleware(mwRequest("/api/market/quotes"));
    expect(res.status).toBe(401);
  });

  it("still fail-closes /api/market/spx with NO bearer token", async () => {
    vi.resetModules();
    process.env.AUTH_SECRET = "test-secret";
    const middleware = await loadMiddleware();
    const res = await middleware(mwRequest("/api/market/spx"));
    expect(res.status).toBe(401);
  });

  it("does NOT extend the bypass to /api/market/flatfile (stays session-gated)", async () => {
    vi.resetModules();
    process.env.AUTH_SECRET = "test-secret";
    const middleware = await loadMiddleware();
    const res = await middleware(mwRequest("/api/market/flatfile?date=2026-07-30", { authorization: `Bearer ${TEST_TOKEN}` }));
    expect(res.status).toBe(401);
  });
});
