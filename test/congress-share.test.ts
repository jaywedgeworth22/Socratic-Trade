import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OHLCBar } from "../src/lib/indicators";

// Mock the history cascade without importOriginal(). history.ts imports the db barrel, whose
// outcome-horizon re-export imports history.ts again; importing the original inside this factory can
// therefore cache a second, real fetchDailyOHLC binding and leak network calls into this suite.
vi.mock("../src/lib/history", () => {
  const toBusinessDay = (time: number | string | undefined): string | undefined => {
    if (typeof time === "number" && Number.isFinite(time)) {
      const ms = time > 1e12 ? time : time * 1000;
      return new Date(ms).toISOString().slice(0, 10);
    }
    if (typeof time === "string") {
      if (/^\d{4}-\d{2}-\d{2}/.test(time)) return time.slice(0, 10);
      const parsed = Date.parse(time);
      if (Number.isFinite(parsed)) return new Date(parsed).toISOString().slice(0, 10);
    }
    return undefined;
  };
  return { fetchDailyOHLC: vi.fn(), toBusinessDay };
});

import { fetchDailyOHLC } from "../src/lib/history";
import {
  buildInsiderImport,
  buildShortVolumeImport,
  canonicalMarketDataSymbol,
  canonicalOutboundSymbol,
  chunkPrices,
  dropInvalidShareRows,
  isCongressAuthBreakerTripped,
  isCongressDailyShareDue,
  isCongressShareAutoEnabled,
  marketQuoteToAnalyst,
  marketQuoteToFundamentals,
  marketQuoteToRef,
  ohlcBarsToCloses,
  ohlcBarsToPriceEntry,
  fetchCongressPriceNeeds,
  mergeShareUniverse,
  resetCongressAuthBreakerForTests,
  resetCongressRefThrottle,
  runCongressDailyShare,
  runCongressDailyShareIfDue,
  shareScanRefs,
  shareWithCongressTrade,
  type CongressPrice
} from "../src/lib/congress-share";
import { setInternalSetting } from "../src/lib/db";
import { getServiceHealthLog } from "../src/lib/db-health";
import { flushDurableStateNow, resetDurableStateCacheForTests } from "../src/lib/durable-state";

const recentDate = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);

const mockedFetchDailyOHLC = vi.mocked(fetchDailyOHLC);

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-congress-share-${randomUUID()}.db`)}`;
});

beforeEach(() => {
  delete process.env.CONGRESS_TRADE_TOKEN;
  delete process.env.CONGRESS_SHARE_ENABLED;
  delete process.env.CONGRESS_SHARE_FUNDAMENTALS_ENABLED;
  delete process.env.CONGRESS_SHARE_MAX_CLOSES_PER_TICKER;
  delete process.env.CONGRESS_TRADE_BASE_URL;
  delete process.env.CONGRESS_SHARE_AUTH_BREAKER_COOLDOWN_MS;
  resetCongressRefThrottle();
  resetCongressAuthBreakerForTests();
  mockedFetchDailyOHLC.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── Ticker aliasing (item 4) ──────────────────────────────────────────────────────

describe("canonicalOutboundSymbol + alias-resolved outbound tickers", () => {
  it("resolves shared corporate-action aliases (FB->META, ATVI->MSFT, SQ->XYZ)", () => {
    expect(canonicalOutboundSymbol("fb")).toBe("META");
    expect(canonicalOutboundSymbol("ATVI")).toBe("MSFT");
    expect(canonicalOutboundSymbol(" sq ")).toBe("XYZ");
    expect(canonicalOutboundSymbol("AAPL")).toBe("AAPL"); // non-aliased passes through
    expect(canonicalOutboundSymbol("BRK-B")).toBe("BRK-B"); // share-class hyphen preserved
  });

  it("stamps the canonical ticker on outbound ref / fundamentals / analyst rows", () => {
    type RefArg = Parameters<typeof marketQuoteToRef>[0];
    type FundArg = Parameters<typeof marketQuoteToFundamentals>[0];
    type AnalystArg = Parameters<typeof marketQuoteToAnalyst>[0];
    expect(marketQuoteToRef({ symbol: "FB" } as unknown as RefArg)?.ticker).toBe("META");
    expect(marketQuoteToFundamentals({ symbol: "FB", peRatio: 20 } as unknown as FundArg, recentDate(0))?.ticker).toBe("META");
    expect(marketQuoteToAnalyst({ symbol: "FB", analystRating: "Buy" } as unknown as AnalystArg, recentDate(0))?.ticker).toBe("META");
  });
});

describe("canonicalMarketDataSymbol (shared rename-vs-acquisition)", () => {
  it("folds continuous renames via shared resolveContinuousTicker", () => {
    expect(canonicalMarketDataSymbol("fb")).toBe("META");
    expect(canonicalMarketDataSymbol("SQ")).toBe("XYZ");
    expect(canonicalMarketDataSymbol("AAPL")).toBe("AAPL");
    expect(canonicalMarketDataSymbol("BRK-B")).toBe("BRK-B");
  });

  it("drops acquisition sources (never relabel ATVI/TWX/RHT onto acquirer)", () => {
    expect(canonicalMarketDataSymbol("ATVI")).toBeNull();
    expect(canonicalMarketDataSymbol("TWX")).toBeNull();
    expect(canonicalMarketDataSymbol("RHT")).toBeNull();
    expect(canonicalMarketDataSymbol("BRCM")).toBeNull();
  });

  it("keeps identity refs folding acquisitions while market-data mappers drop them", () => {
    type RefArg = Parameters<typeof marketQuoteToRef>[0];
    type FundArg = Parameters<typeof marketQuoteToFundamentals>[0];
    // Company identity still points at the acquirer (canonicalOutboundSymbol).
    expect(canonicalOutboundSymbol("ATVI")).toBe("MSFT");
    expect(marketQuoteToRef({ symbol: "ATVI", companyName: "Activision" } as unknown as RefArg)?.ticker).toBe("MSFT");
    // Market-data rows must not pollute MSFT's series with ATVI numbers.
    expect(
      marketQuoteToFundamentals({ symbol: "ATVI", peRatio: 12, eps: 1 } as unknown as FundArg, "2026-07-01")
    ).toBeNull();
    expect(
      ohlcBarsToPriceEntry("ATVI", [
        { time: "2026-07-01", open: 1, high: 1, low: 1, close: 90, volume: 1 }
      ])
    ).toBeNull();
  });
});

// ── Outbound payload validation (item 5) ──────────────────────────────────────────

describe("dropInvalidShareRows — drop malformed rows instead of sending them", () => {
  it("drops schema-invalid rows per dataset and keeps the valid ones", () => {
    const { payload, dropped } = dropInvalidShareRows({
      refs: [{ ticker: "AAPL" }, { ticker: "" }], // "" fails ticker.min(1)
      spx: [{ date: "2026-06-15", close: 100 }, { date: "not-a-date", close: 1 }], // bad date dropped
      insider: [{ ticker: "AAPL", date: "2026-06-15", sentiment: 60, buyFilings: 1, sellFilings: 0, buyShares: 1, sellShares: 0, owners: [] }],
    });
    expect(payload.refs).toEqual([{ ticker: "AAPL" }]);
    expect(payload.spx).toEqual([{ date: "2026-06-15", close: 100 }]);
    expect(payload.insider).toHaveLength(1); // all valid -> untouched
    expect(dropped).toMatchObject({ refs: 1, spx: 1 });
    expect(dropped.insider).toBeUndefined();
  });

  it("shareWithCongressTrade excludes invalid rows from the POST body and counts only what's sent", async () => {
    process.env.CONGRESS_TRADE_TOKEN = "t";
    let posted: { refs?: unknown[]; origin?: string } | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      posted = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }));
    const res = await shareWithCongressTrade({ refs: [{ ticker: "AAPL" }, { ticker: "" }] });
    expect(res.ok).toBe(true);
    expect(res.sent.refs).toBe(1);
    expect(posted?.refs).toEqual([{ ticker: "AAPL" }]);
  });
});

// ── Mappers ─────────────────────────────────────────────────────────────────────

describe("marketQuoteToRef", () => {
  it("normalizes ticker, defaults assetClass to equity, and omits absent fields", () => {
    const ref = marketQuoteToRef({ symbol: "aapl", companyName: "Apple Inc.", sector: "Technology" });
    expect(ref).toEqual({ ticker: "AAPL", assetClass: "equity", companyName: "Apple Inc.", sector: "Technology" });
  });

  it("drops a non-positive / non-finite market cap", () => {
    expect(marketQuoteToRef({ symbol: "X", marketCap: 0 })?.marketCap).toBeUndefined();
    expect(marketQuoteToRef({ symbol: "X", marketCap: NaN })?.marketCap).toBeUndefined();
    expect(marketQuoteToRef({ symbol: "X", marketCap: 1_000 })?.marketCap).toBe(1_000);
  });

  it("returns null when there is no usable ticker", () => {
    expect(marketQuoteToRef({ symbol: "" })).toBeNull();
  });
});

describe("ohlcBarsToCloses", () => {
  it("maps to {date, close}, sorts ascending, and drops invalid bars", () => {
    const bars: OHLCBar[] = [
      { time: "2026-06-16", close: 101 },
      { time: "2026-06-15", close: 100 },
      { time: "2026-06-17", close: NaN }, // dropped (bad close)
      { time: undefined, close: 99 } // dropped (no date)
    ];
    expect(ohlcBarsToCloses(bars)).toEqual([
      { date: "2026-06-15", close: 100 },
      { date: "2026-06-16", close: 101 }
    ]);
  });

  it("dedupes by date (later bar wins) and accepts ms-epoch times", () => {
    const ms = Date.UTC(2026, 5, 15); // 2026-06-15
    const bars: OHLCBar[] = [
      { time: ms, close: 10 },
      { time: ms, close: 12 }
    ];
    expect(ohlcBarsToCloses(bars)).toEqual([{ date: "2026-06-15", close: 12 }]);
  });

  it("returns [] for empty/nullish input", () => {
    expect(ohlcBarsToCloses(null)).toEqual([]);
    expect(ohlcBarsToCloses([])).toEqual([]);
  });
});

describe("ohlcBarsToPriceEntry", () => {
  it("derives currentPrice/currentPriceDate from the most-recent close", () => {
    const entry = ohlcBarsToPriceEntry("msft", [
      { time: "2026-06-15", close: 100 },
      { time: "2026-06-16", close: 105 }
    ]);
    expect(entry).toEqual({
      ticker: "MSFT",
      closes: [
        { date: "2026-06-15", close: 100 },
        { date: "2026-06-16", close: 105 }
      ],
      currentPrice: 105,
      currentPriceDate: "2026-06-16"
    });
  });

  it("returns null when there are no valid closes", () => {
    expect(ohlcBarsToPriceEntry("MSFT", [])).toBeNull();
    expect(ohlcBarsToPriceEntry("", [{ time: "2026-06-16", close: 1 }])).toBeNull();
  });
});

describe("chunkPrices", () => {
  const mk = (ticker: string, n: number): CongressPrice => ({
    ticker,
    closes: Array.from({ length: n }, (_, i) => ({ date: `2026-01-${String((i % 28) + 1).padStart(2, "0")}`, close: i }))
  });

  it("packs by close budget", () => {
    const chunks = chunkPrices([mk("A", 60), mk("B", 60), mk("C", 60)], 100, 2000);
    expect(chunks.map((c) => c.map((p) => p.ticker))).toEqual([["A"], ["B"], ["C"]]);
  });

  it("packs by ticker count", () => {
    const chunks = chunkPrices([mk("A", 1), mk("B", 1), mk("C", 1), mk("D", 1)], 100_000, 2);
    expect(chunks.map((c) => c.map((p) => p.ticker))).toEqual([["A", "B"], ["C", "D"]]);
  });

  it("truncates a single ticker exceeding the close budget to the most-recent closes", () => {
    const [chunk] = chunkPrices([mk("BIG", 250)], 100, 2000);
    expect(chunk).toHaveLength(1);
    expect(chunk[0].closes).toHaveLength(100);
    expect(chunk[0].closes[0].close).toBe(150); // kept the last 100 (indices 150..249)
  });
});

// ── shareWithCongressTrade ────────────────────────────────────────────────────────

describe("shareWithCongressTrade", () => {
  it("skips (no fetch) when no token is configured", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const res = await shareWithCongressTrade({ refs: [{ ticker: "AAPL" }] });
    expect(res).toMatchObject({ ok: false, skipped: true, reason: "no-token" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("skips an empty payload", async () => {
    process.env.CONGRESS_TRADE_TOKEN = "tok";
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const res = await shareWithCongressTrade({});
    expect(res).toMatchObject({ ok: false, skipped: true, reason: "empty" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fails (not skip) when every row is schema-dropped — do not advance daily marker", async () => {
    process.env.CONGRESS_TRADE_TOKEN = "tok";
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const res = await shareWithCongressTrade({ refs: [{ ticker: "" }] });
    expect(res).toMatchObject({ ok: false, skipped: false, reason: "all-rows-dropped" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("POSTs to the import endpoint with bearer auth + JSON body and returns the response", async () => {
    process.env.CONGRESS_TRADE_TOKEN = "secret-token";
    process.env.CONGRESS_TRADE_BASE_URL = "https://congress.trade/";
    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ ok: true, refs: 1 }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchSpy);

    const res = await shareWithCongressTrade({ refs: [{ ticker: "AAPL" }], spx: [{ date: "2026-06-15", close: 5400 }] });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://congress.trade/api/admin/securities/import"); // trailing slash normalized
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer secret-token");
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual({
      refs: [{ ticker: "AAPL" }],
      spx: [{ date: "2026-06-15", close: 5400 }],
      origin: "app-b" // no-echo-loop provenance tag stamped on every outbound payload
    });
    expect(res).toMatchObject({ ok: true, status: 200, response: { ok: true, refs: 1 }, sent: { refs: 1, spx: 1 } });
  });

  it("returns ok:false on an HTTP error without throwing", async () => {
    process.env.CONGRESS_TRADE_TOKEN = "tok";
    vi.stubGlobal("fetch", vi.fn(async () => new Response("denied", { status: 401 })));
    const res = await shareWithCongressTrade({ refs: [{ ticker: "AAPL" }] });
    expect(res).toMatchObject({ ok: false, status: 401 });
  });

  it("returns ok:false on a transport error without throwing", async () => {
    process.env.CONGRESS_TRADE_TOKEN = "tok";
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
    const res = await shareWithCongressTrade({ refs: [{ ticker: "AAPL" }] });
    expect(res).toMatchObject({ ok: false, error: "network down" });
  });

  // ── Health-log observability (prod incident 2026-09-07: 3,096 silent 401s over 9 days,
  // console.error only — no Sentry, no /api/health signal). shareWithCongressTrade now logs
  // every attempt into api_health_log via logApiHealth, the SAME generic pipeline "roic" and
  // "congress.trade" already use to surface a degraded /api/health dependency and (after 5
  // consecutive hard failures) a Sentry capture. ────────────────────────────────────────────

  // NOTE: api_health_log lives in the SAME per-file SQLite DB every test in this suite shares
  // (one DATABASE_URL, created once in beforeAll — see the top of this file), so rows from
  // earlier tests persist. getServiceHealthLog orders `ts DESC, rowid DESC`, so rows[0] is always
  // THIS test's most recent write — assert on that instead of the log's total length.

  it("logs a failed health-log row (service congress-share) on an HTTP error", async () => {
    process.env.CONGRESS_TRADE_TOKEN = "tok";
    vi.stubGlobal("fetch", vi.fn(async () => new Response("denied", { status: 401 })));
    await shareWithCongressTrade({ refs: [{ ticker: "AAPL" }] });
    const rows = getServiceHealthLog("congress-share", 10);
    expect(rows[0]).toMatchObject({ ok: 0, key_source: "env" });
    expect(rows[0].error_text).toContain("HTTP 401");
  });

  it("logs an ok health-log row on success", async () => {
    process.env.CONGRESS_TRADE_TOKEN = "tok";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })));
    await shareWithCongressTrade({ refs: [{ ticker: "AAPL" }] });
    const rows = getServiceHealthLog("congress-share", 10);
    expect(rows[0]).toMatchObject({ ok: 1, key_source: "env" });
  });

  // ── Auth circuit breaker: a 401/403 is a PERMANENT failure (the shared token is wrong), not a
  // transient one, so it must stop hammering App A at full cadence — unlike a 5xx/timeout, which
  // stays on the existing per-caller backoff since it may well clear on its own. ─────────────────

  it("trips the auth breaker on HTTP 401 and short-circuits the next call without hitting fetch", async () => {
    process.env.CONGRESS_TRADE_TOKEN = "tok";
    const fetchSpy = vi.fn(async () => new Response("denied", { status: 401 }));
    vi.stubGlobal("fetch", fetchSpy);

    const first = await shareWithCongressTrade({ refs: [{ ticker: "AAPL" }] });
    expect(first).toMatchObject({ ok: false, status: 401 });
    expect(isCongressAuthBreakerTripped()).toBe(true);

    const second = await shareWithCongressTrade({ refs: [{ ticker: "MSFT" }] });
    expect(second).toMatchObject({ ok: false, skipped: false, reason: "auth-breaker-tripped" });
    expect(fetchSpy).toHaveBeenCalledTimes(1); // second call never touched the network
  });

  it("trips the auth breaker on HTTP 403 as well", async () => {
    process.env.CONGRESS_TRADE_TOKEN = "tok";
    vi.stubGlobal("fetch", vi.fn(async () => new Response("forbidden", { status: 403 })));
    await shareWithCongressTrade({ refs: [{ ticker: "AAPL" }] });
    expect(isCongressAuthBreakerTripped()).toBe(true);
  });

  it("does NOT trip the breaker on a non-auth HTTP error — every call still hits fetch", async () => {
    process.env.CONGRESS_TRADE_TOKEN = "tok";
    const fetchSpy = vi.fn(async () => new Response("boom", { status: 500 }));
    vi.stubGlobal("fetch", fetchSpy);

    await shareWithCongressTrade({ refs: [{ ticker: "AAPL" }] });
    await shareWithCongressTrade({ refs: [{ ticker: "MSFT" }] });
    expect(isCongressAuthBreakerTripped()).toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(6); // 2 calls * 3 retry attempts on 5xx
  });

  it("does NOT trip the breaker on a transport error", async () => {
    process.env.CONGRESS_TRADE_TOKEN = "tok";
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
    await shareWithCongressTrade({ refs: [{ ticker: "AAPL" }] });
    expect(isCongressAuthBreakerTripped()).toBe(false);
  });

  it("replays the cached failure into the health log while the breaker is tripped, without a live retry", async () => {
    process.env.CONGRESS_TRADE_TOKEN = "tok";
    const fetchSpy = vi.fn(async () => new Response("denied", { status: 401 }));
    vi.stubGlobal("fetch", fetchSpy);

    await shareWithCongressTrade({ refs: [{ ticker: "AAPL" }] }); // real 401, trips breaker
    await shareWithCongressTrade({ refs: [{ ticker: "MSFT" }] }); // absorbed by breaker
    await shareWithCongressTrade({ refs: [{ ticker: "GOOG" }] }); // absorbed by breaker

    expect(fetchSpy).toHaveBeenCalledTimes(1); // only the first call ever reached the network
    // Most recent 3 rows (DESC order): the 2 breaker-absorbed replays land first, then the
    // original real 401 — all three still land a failed health-log row, so the
    // 5-consecutive-hard-failure Sentry/degraded threshold accrues at the caller's normal cadence.
    const [mostRecent, secondMostRecent, thirdMostRecent] = getServiceHealthLog("congress-share", 10);
    expect([mostRecent, secondMostRecent, thirdMostRecent].every((r) => r.ok === 0)).toBe(true);
    expect(mostRecent.error_text).toContain("breaker cooldown active");
    expect(secondMostRecent.error_text).toContain("breaker cooldown active");
    expect(thirdMostRecent.error_text).toContain("HTTP 401"); // the original real failure
  });

  it("clears the breaker and resumes real sends after a successful post-cooldown probe", async () => {
    process.env.CONGRESS_TRADE_TOKEN = "tok";
    process.env.CONGRESS_SHARE_AUTH_BREAKER_COOLDOWN_MS = "300"; // short but not flaky-short
    const fetchSpy = vi
      .fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response("denied", { status: 401 }));
    vi.stubGlobal("fetch", fetchSpy);

    await shareWithCongressTrade({ refs: [{ ticker: "AAPL" }] }); // trips breaker
    expect(isCongressAuthBreakerTripped()).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 400)); // let the 300ms cooldown elapse

    const res = await shareWithCongressTrade({ refs: [{ ticker: "MSFT" }] }); // real probe
    expect(res).toMatchObject({ ok: true });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(isCongressAuthBreakerTripped()).toBe(false); // success clears the breaker
  });

  // P2 fix (2026-09-07): the durable breaker state has no identity for the token that tripped
  // it unless it stores a fingerprint. An operator resyncing CONGRESS_TRADE_TOKEN before the
  // cooldown elapses is exactly the recovery action this breaker exists to wait for — without
  // the fingerprint check, the resynced (good) token still sits blocked for the rest of the
  // cooldown, and a container restart does not help since the settings DB is persistent.
  it("ignores a breaker tripped by a DIFFERENT (since-resynced) token and lets the new token probe immediately", async () => {
    process.env.CONGRESS_TRADE_TOKEN = "broken-token";
    const fetchSpy = vi.fn(async () => new Response("denied", { status: 401 }));
    vi.stubGlobal("fetch", fetchSpy);

    await shareWithCongressTrade({ refs: [{ ticker: "AAPL" }] }); // trips breaker for "broken-token"
    expect(isCongressAuthBreakerTripped()).toBe(true);

    // Operator resyncs the token — no restart, no waiting for the 6h cooldown.
    process.env.CONGRESS_TRADE_TOKEN = "resynced-good-token";
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    expect(isCongressAuthBreakerTripped()).toBe(false); // stale entry is ignored for the new token
    const res = await shareWithCongressTrade({ refs: [{ ticker: "MSFT" }] });
    expect(res).toMatchObject({ ok: true });
    expect(fetchSpy).toHaveBeenCalledTimes(2); // the resynced token got its own real probe, not absorbed
  });

  // P2 fix (2026-09-07): once the cooldown elapses, exactly one caller should send the real
  // probe — concurrent overlapping callers (scan-hook firing while the nightly batch is also
  // mid-run) previously each treated the expired cooldown as their own independent probe,
  // recreating a burst of 401/403 requests every cooldown boundary.
  it("serializes the post-cooldown half-open probe across concurrent overlapping callers", async () => {
    process.env.CONGRESS_TRADE_TOKEN = "tok";
    process.env.CONGRESS_SHARE_AUTH_BREAKER_COOLDOWN_MS = "300";
    const fetchSpy = vi
      .fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response("denied", { status: 401 }));
    vi.stubGlobal("fetch", fetchSpy);

    await shareWithCongressTrade({ refs: [{ ticker: "AAPL" }] }); // trips breaker
    expect(isCongressAuthBreakerTripped()).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 400)); // let the cooldown elapse

    // Two overlapping callers both reach the half-open window at the same instant.
    const [first, second] = await Promise.all([
      shareWithCongressTrade({ refs: [{ ticker: "MSFT" }] }),
      shareWithCongressTrade({ refs: [{ ticker: "GOOG" }] })
    ]);

    const results = [first, second];
    const probed = results.filter((r) => r.ok);
    const absorbed = results.filter((r) => !r.ok);
    expect(probed).toHaveLength(1); // exactly one caller got the real probe
    expect(absorbed).toHaveLength(1);
    expect(absorbed[0]).toMatchObject({ skipped: false, reason: "auth-breaker-tripped" });
    // Only the original trip (401) + the single half-open probe ever touched the network.
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

// ── shareScanRefs (after-scan hook) ────────────────────────────────────────────────

describe("shareScanRefs", () => {
  const scan = { topCandidates: [{ symbol: "AAPL" }, { symbol: "MSFT" }] } as Parameters<typeof shareScanRefs>[0];

  it("is a no-op when automatic sharing is disabled", async () => {
    process.env.CONGRESS_TRADE_TOKEN = "tok"; // token alone is not enough
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    expect(await shareScanRefs(scan)).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("POSTs candidate refs once, then throttles repeat sends within the TTL", async () => {
    process.env.CONGRESS_TRADE_TOKEN = "tok";
    process.env.CONGRESS_SHARE_ENABLED = "on";
    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchSpy);

    const first = await shareScanRefs(scan);
    expect(first?.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(body.refs.map((r: { ticker: string }) => r.ticker)).toEqual(["AAPL", "MSFT"]);

    // Second scan with the same names: throttled → no new POST, returns null.
    expect(await shareScanRefs(scan)).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("rolls back the throttle so a failed send is retried on the next scan", async () => {
    process.env.CONGRESS_TRADE_TOKEN = "tok";
    process.env.CONGRESS_SHARE_ENABLED = "on";
    const fetchSpy = vi
      .fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ ok: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response("boom", { status: 500 }))
      .mockResolvedValueOnce(new Response("boom", { status: 500 }))
      .mockResolvedValueOnce(new Response("boom", { status: 500 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    expect((await shareScanRefs(scan))?.ok).toBe(false);
    expect((await shareScanRefs(scan))?.ok).toBe(true); // retried, not throttled
    expect(fetchSpy).toHaveBeenCalledTimes(4);
  });

  it("the per-symbol send throttle survives a simulated process restart", async () => {
    process.env.CONGRESS_TRADE_TOKEN = "tok";
    process.env.CONGRESS_SHARE_ENABLED = "on";
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    expect((await shareScanRefs(scan))?.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    flushDurableStateNow(); // the throttle's debounced write lands in SQLite

    // Simulate a restart: forget the in-memory durable-state cache (the SQLite rows are untouched).
    resetDurableStateCacheForTests();

    // A fresh process's next scan of the SAME candidates must still see the throttle, not re-POST.
    expect(await shareScanRefs(scan)).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1); // unchanged
  });
});

// ── Nightly batch + gating ─────────────────────────────────────────────────────────

describe("isCongressShareAutoEnabled", () => {
  it("requires both the token and the enable flag", () => {
    expect(isCongressShareAutoEnabled()).toBe(false);
    process.env.CONGRESS_TRADE_TOKEN = "tok";
    expect(isCongressShareAutoEnabled()).toBe(false);
    process.env.CONGRESS_SHARE_ENABLED = "true";
    expect(isCongressShareAutoEnabled()).toBe(true);
  });
});

describe("isCongressDailyShareDue", () => {
  it("is true until the marker matches the run's UTC date", () => {
    const now = Date.UTC(2026, 5, 22, 13, 0, 0);
    setInternalSetting("congress-share:lastDailyRunDate", "2026-06-21");
    expect(isCongressDailyShareDue(now)).toBe(true);
    setInternalSetting("congress-share:lastDailyRunDate", "2026-06-22");
    expect(isCongressDailyShareDue(now)).toBe(false);
  });

  it("applies a 60-minute failure backoff even when the daily marker is stale", () => {
    const now = Date.UTC(2026, 5, 22, 13, 0, 0);
    setInternalSetting("congress-share:lastDailyRunDate", "2026-06-21");
    setInternalSetting("congress_share_last_failure_ms", now - 30 * 60 * 1000);
    expect(isCongressDailyShareDue(now)).toBe(false);
    setInternalSetting("congress_share_last_failure_ms", now - 61 * 60 * 1000);
    expect(isCongressDailyShareDue(now)).toBe(true);
  });
});

describe("runCongressDailyShare", () => {
  it("skips with no token", async () => {
    const res = await runCongressDailyShare({ force: true, symbols: ["AAPL"] });
    expect(res).toMatchObject({ ok: false, skipped: true, reason: "no-token" });
  });

  // P2 fix (2026-09-07): before this, a tripped breaker only stopped the individual
  // shareWithCongressTrade POSTs at the very end of the nightly run — fetchCongressPriceNeeds
  // (an authenticated request to App A), the SPX/per-ticker OHLC fetches, and the screener refs
  // fetch all still ran every time the job was due, hourly, for the entire 6h cooldown. The
  // whole collection phase must be gated up front instead.
  it("skips the entire collection phase (no OHLC fetch at all) when the auth breaker is tripped", async () => {
    process.env.CONGRESS_TRADE_TOKEN = "tok";
    vi.stubGlobal("fetch", vi.fn(async () => new Response("denied", { status: 401 })));
    await shareWithCongressTrade({ refs: [{ ticker: "AAPL" }] }); // trips breaker
    expect(isCongressAuthBreakerTripped()).toBe(true);

    mockedFetchDailyOHLC.mockClear();
    const now = Date.UTC(2026, 5, 22, 13, 0, 0);
    setInternalSetting("congress-share:lastDailyRunDate", "2026-06-20");
    const res = await runCongressDailyShare({ now, force: true, symbols: ["AAPL", "MSFT"] });

    expect(res).toMatchObject({ ok: false, skipped: false, reason: "auth-breaker-tripped" });
    expect(mockedFetchDailyOHLC).not.toHaveBeenCalled(); // collection phase never started
  });

  it("shares custom symbols + SPX as separate bounded POSTs and does not advance the daily marker", async () => {
    process.env.CONGRESS_TRADE_TOKEN = "tok";
    const bars: OHLCBar[] = [
      { time: "2026-06-15", close: 100 },
      { time: "2026-06-16", close: 101 }
    ];
    mockedFetchDailyOHLC.mockResolvedValue(bars);
    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchSpy);

    const now = Date.UTC(2026, 5, 22, 13, 0, 0);
    setInternalSetting("congress-share:lastDailyRunDate", "2026-06-20"); // a known past marker
    const res = await runCongressDailyShare({ now, force: true, symbols: ["AAPL", "MSFT"] });

    expect(res.ok).toBe(true);
    expect(res).toMatchObject({ tickers: 2, priced: 2, spxRows: 2, failedPosts: 0 });
    // spx and prices now go in their own bounded POSTs (not one bundled body).
    const bodies = fetchSpy.mock.calls
      .filter((c) => (c[1] as RequestInit)?.body)
      .map((c) => JSON.parse((c[1] as RequestInit).body as string));
    expect(bodies.find((b) => b.spx)?.spx).toHaveLength(2);
    expect(bodies.find((b) => b.prices)?.prices.map((p: { ticker: string }) => p.ticker)).toEqual(["AAPL", "MSFT"]);
    expect(mockedFetchDailyOHLC).toHaveBeenCalledWith("^GSPC", now);
    // Custom-symbol runs must NOT advance the once-per-day marker.
    expect(isCongressDailyShareDue(now)).toBe(true);
  });

  it("skips when not due and not forced", async () => {
    process.env.CONGRESS_TRADE_TOKEN = "tok";
    const now = Date.UTC(2026, 5, 22, 13, 0, 0);
    setInternalSetting("congress-share:lastDailyRunDate", "2026-06-22");
    const res = await runCongressDailyShare({ now });
    expect(res).toMatchObject({ ok: false, skipped: true, reason: "not-due" });
    expect(mockedFetchDailyOHLC).not.toHaveBeenCalled();
  });

  it("deduplicates concurrent runs via a shared in-flight promise", async () => {
    process.env.CONGRESS_TRADE_TOKEN = "tok";
    const bars: OHLCBar[] = [
      { time: "2026-06-15", close: 100 }
    ];
    mockedFetchDailyOHLC.mockResolvedValue(bars);
    const fetchSpy = vi.fn(async (url: string, _init?: RequestInit) => {
      await new Promise(r => setTimeout(r, 50));
      if (url.includes("nasdaq.com")) {
        return new Response(JSON.stringify({ data: { table: { rows: [] } } }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchSpy);

    const now = Date.UTC(2026, 5, 22, 13, 0, 0);
    setInternalSetting("congress-share:lastDailyRunDate", "2026-06-20");

    const [res1, res2] = await Promise.all([
      runCongressDailyShare({ now, force: true, symbols: ["AAPL"] }),
      runCongressDailyShare({ now, force: true, symbols: ["AAPL"] })
    ]);

    expect(res1).toBe(res2); // Should return the exact same promise/result reference
    expect(fetchSpy.mock.calls.filter((c) => (c[1] as RequestInit)?.body)).toHaveLength(2); // Should only execute one run (which POSTs SPX and prices payload separately)
  });
});

describe("runCongressDailyShareIfDue", () => {
  it("returns null when automatic sharing is disabled", async () => {
    process.env.CONGRESS_TRADE_TOKEN = "tok"; // no enable flag
    expect(await runCongressDailyShareIfDue(Date.now())).toBeNull();
    expect(mockedFetchDailyOHLC).not.toHaveBeenCalled();
  });
});

describe("ohlcBarsToCloses — volume", () => {
  it("carries volume when the bar provides it", () => {
    expect(ohlcBarsToCloses([{ time: "2026-06-15", close: 100, volume: 5000 }])).toEqual([
      { date: "2026-06-15", close: 100, volume: 5000 }
    ]);
  });
});

describe("insider / short-volume import builders", () => {
  it("builds insider rows (shares summed, sentiment from signals) from the cached dataset", () => {
    setInternalSetting("webSource:insider:dataset", {
      filings: [
        { symbol: "AAPL", owner: "Jane Director", buyTx: 3, sellTx: 1, buyShares: 12000, sellShares: 2000, filedAt: recentDate(2), accession: "x1" }
      ],
      fetchedAt: new Date().toISOString(),
      recordCount: 1
    });
    const aapl = buildInsiderImport().find((r) => r.ticker === "AAPL");
    expect(aapl).toMatchObject({ ticker: "AAPL", sentiment: 75, buyFilings: 1, sellFilings: 0, buyShares: 12000, sellShares: 2000 });
    expect(aapl?.owners).toContain("Jane Director");
  });

  it("builds short-volume rows from the FINRA dataset", () => {
    setInternalSetting("webSource:finra:dataset", {
      ratios: { NVDA: 48.3 },
      asOf: recentDate(1),
      fetchedAt: new Date().toISOString(),
      recordCount: 1
    });
    expect(buildShortVolumeImport().find((r) => r.ticker === "NVDA")).toMatchObject({ ticker: "NVDA", ratio: 48.3 });
  });
});

describe("runCongressDailyShare — insider + short-volume on the nightly batch", () => {
  it("sends cached insider + short-volume rows as their own bounded POSTs", async () => {
    process.env.CONGRESS_TRADE_TOKEN = "tok";
    setInternalSetting("webSource:insider:dataset", {
      filings: [{ symbol: "AAPL", owner: "Jane", buyTx: 2, sellTx: 0, buyShares: 9000, sellShares: 0, filedAt: recentDate(2), accession: "y1" }],
      fetchedAt: new Date().toISOString(),
      recordCount: 1
    });
    setInternalSetting("webSource:finra:dataset", { ratios: { AAPL: 51.2 }, asOf: recentDate(1), fetchedAt: new Date().toISOString(), recordCount: 1 });
    mockedFetchDailyOHLC.mockResolvedValue([{ time: recentDate(2), close: 1 }, { time: recentDate(1), close: 2 }]);
    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    const res = await runCongressDailyShare({ now: Date.now(), force: true }); // non-custom → builds both
    expect(res.insiderRows).toBeGreaterThanOrEqual(1);
    expect(res.shortVolRows).toBeGreaterThanOrEqual(1);
    // Scheduled runs also GET /price-needs (no body); only parse POSTs with a body.
    const bodies = fetchSpy.mock.calls
      .filter((c) => (c[1] as RequestInit | undefined)?.body != null)
      .map((c) => JSON.parse((c[1] as RequestInit).body as string));
    expect(bodies.some((b) => Array.isArray(b.insider) && b.insider.length >= 1)).toBe(true);
    expect(bodies.some((b) => Array.isArray(b.shortVolume) && b.shortVolume.length >= 1)).toBe(true);
    // No single POST bundles everything — each dataset rides its own bounded request.
    expect(bodies.every((b) => !(b.insider && b.prices))).toBe(true);
  });

  it("caps each symbol's closes to CONGRESS_SHARE_MAX_CLOSES_PER_TICKER (most-recent N)", async () => {
    process.env.CONGRESS_TRADE_TOKEN = "tok";
    process.env.CONGRESS_SHARE_MAX_CLOSES_PER_TICKER = "2";
    mockedFetchDailyOHLC.mockResolvedValue([
      { time: "2026-06-12", close: 1 },
      { time: "2026-06-13", close: 2 },
      { time: "2026-06-14", close: 3 },
      { time: "2026-06-15", close: 4 },
      { time: "2026-06-16", close: 5 }
    ]);
    const fetchSpy = vi.fn(async (_u: string, _i?: RequestInit) => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    const res = await runCongressDailyShare({ now: Date.UTC(2026, 5, 22), force: true, symbols: ["AAPL"] });
    expect(res.ok).toBe(true);
    const bodies = fetchSpy.mock.calls
      .filter((c) => (c[1] as RequestInit)?.body)
      .map((c) => JSON.parse((c[1] as RequestInit).body as string));
    const entry = bodies.find((b) => b.prices)?.prices.find((p: { ticker: string }) => p.ticker === "AAPL");
    expect(entry.closes).toHaveLength(2); // capped from 5 → most-recent 2
    expect(entry.closes.map((c: { date: string }) => c.date)).toEqual(["2026-06-15", "2026-06-16"]);
    expect(entry.currentPrice).toBe(5); // still the latest close
  });

  it("fullHistory backfill bypasses the per-symbol close cap (sends the full series)", async () => {
    process.env.CONGRESS_TRADE_TOKEN = "tok";
    process.env.CONGRESS_SHARE_MAX_CLOSES_PER_TICKER = "2"; // would cap nightly, but backfill ignores it
    mockedFetchDailyOHLC.mockResolvedValue([
      { time: "2026-06-12", close: 1 },
      { time: "2026-06-13", close: 2 },
      { time: "2026-06-14", close: 3 },
      { time: "2026-06-15", close: 4 },
      { time: "2026-06-16", close: 5 }
    ]);
    const fetchSpy = vi.fn(async (_u: string, _i?: RequestInit) => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    const res = await runCongressDailyShare({ now: Date.UTC(2026, 5, 22), force: true, symbols: ["AAPL"], fullHistory: true });
    expect(res.ok).toBe(true);
    const bodies = fetchSpy.mock.calls
      .filter((c) => (c[1] as RequestInit)?.body)
      .map((c) => JSON.parse((c[1] as RequestInit).body as string));
    const entry = bodies.find((b) => b.prices)?.prices.find((p: { ticker: string }) => p.ticker === "AAPL");
    expect(entry.closes).toHaveLength(5); // full series, not capped to 2
  });
});

describe("marketQuoteToFundamentals / marketQuoteToAnalyst", () => {
  it("maps fundamentals (52w aliases), omits absent fields, null when empty", () => {
    expect(
      marketQuoteToFundamentals(
        { symbol: "aapl", peRatio: 25, eps: 6, beta: 1.2, dividendYield: 0.5, fiftyTwoWeekHigh: 200, fiftyTwoWeekLow: 120, fcfYield: 3, debtToEquity: 1.5, epsGrowth: 10 },
        "2026-06-23"
      )
    ).toMatchObject({
      ticker: "AAPL", date: "2026-06-23", peRatio: 25, eps: 6, beta: 1.2, dividendYield: 0.5,
      week52High: 200, week52Low: 120, fcfYield: 3, debtToEquity: 1.5, epsGrowth: 10
    });
    expect(marketQuoteToFundamentals({ symbol: "AAPL" }, "2026-06-23")).toBeNull();
  });

  it("blends analyst counts across sources, keeps rating, null when empty", () => {
    const a = marketQuoteToAnalyst(
      {
        symbol: "AAPL",
        analystRating: "Buy",
        analystBySource: {
          fmp: { score: 80, label: "Buy", counts: { strongBuy: 2, buy: 3, hold: 1, sell: 0, strongSell: 0 } },
          finnhub: { score: 75, label: "Buy", counts: { strongBuy: 1, buy: 2, hold: 2, sell: 1, strongSell: 0 } }
        }
      },
      "2026-06-23"
    );
    expect(a).toMatchObject({ ticker: "AAPL", date: "2026-06-23", rating: "Buy", strongBuy: 3, buy: 5, hold: 3, sell: 1, strongSell: 0 });
    expect(marketQuoteToAnalyst({ symbol: "AAPL" }, "2026-06-23")).toBeNull();
  });
});

describe("shareScanRefs — fundamentals + analyst", () => {
  it("includes fundamentals + analyst for candidates in the same POST (when the gate is on)", async () => {
    process.env.CONGRESS_TRADE_TOKEN = "tok";
    process.env.CONGRESS_SHARE_ENABLED = "on";
    process.env.CONGRESS_SHARE_FUNDAMENTALS_ENABLED = "on"; // App A's #46 migration is live
    const fetchSpy = vi.fn(async (_u: string, _i?: RequestInit) => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    const scan = {
      topCandidates: [
        {
          symbol: "AAPL",
          peRatio: 25,
          analystRating: "Buy",
          analystBySource: { fmp: { score: 80, label: "Buy", counts: { strongBuy: 2, buy: 1, hold: 0, sell: 0, strongSell: 0 } } }
        }
      ]
    } as unknown as Parameters<typeof shareScanRefs>[0];
    const res = await shareScanRefs(scan);
    expect(res?.ok).toBe(true);
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(body.refs[0].ticker).toBe("AAPL");
    expect(body.fundamentals[0]).toMatchObject({ ticker: "AAPL", peRatio: 25 });
    expect(body.analyst[0]).toMatchObject({ ticker: "AAPL", rating: "Buy", strongBuy: 2 });
  });

  it("HOLDS fundamentals + analyst by default (refs still flow) until App A's #46 migration", async () => {
    process.env.CONGRESS_TRADE_TOKEN = "tok";
    process.env.CONGRESS_SHARE_ENABLED = "on";
    // CONGRESS_SHARE_FUNDAMENTALS_ENABLED unset (default) → held
    const fetchSpy = vi.fn(async (_u: string, _i?: RequestInit) => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    const scan = {
      topCandidates: [{ symbol: "AAPL", peRatio: 25, analystRating: "Buy", analystBySource: { fmp: { score: 80, label: "Buy", counts: { strongBuy: 2, buy: 1, hold: 0, sell: 0, strongSell: 0 } } } }]
    } as unknown as Parameters<typeof shareScanRefs>[0];
    const res = await shareScanRefs(scan);
    expect(res?.ok).toBe(true);
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(body.refs[0].ticker).toBe("AAPL"); // refs still flow
    expect(body.fundamentals).toEqual([]); // held
    expect(body.analyst).toEqual([]); // held
  });
});

// ── App A price-needs (congressional performance vs S&P) ───────────────────────

describe("mergeShareUniverse", () => {
  it("puts needs first, dedupes, and caps", () => {
    expect(mergeShareUniverse(["MSFT", "AAPL"], ["NEED", "aapl"], 10)).toEqual(["NEED", "AAPL", "MSFT"]);
    expect(mergeShareUniverse(["A", "B", "C"], ["X", "Y"], 3)).toEqual(["X", "Y", "A"]);
  });
});

describe("fetchCongressPriceNeeds", () => {
  it("returns empty without token", async () => {
    delete process.env.CONGRESS_TRADE_TOKEN;
    const res = await fetchCongressPriceNeeds(10);
    expect(res.tickers).toEqual([]);
  });

  it("parses App A response and soft-fails on HTTP errors", async () => {
    process.env.CONGRESS_TRADE_TOKEN = "tok";
    process.env.CONGRESS_TRADE_BASE_URL = "https://congress.example";
    const okFetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          tickers: [
            { ticker: "need", oldestTradeDate: "2019-01-01", needsDeepHistory: true, reasons: ["no_price_history"] },
            { ticker: "" }
          ],
          spx: { needsHistoryBefore: "2014-01-01" }
        }),
        { status: 200 }
      )
    );
    const res = await fetchCongressPriceNeeds(50, okFetch as unknown as typeof fetch);
    expect(res.tickers).toEqual([
      { ticker: "NEED", oldestTradeDate: "2019-01-01", needsDeepHistory: true, reasons: ["no_price_history"] }
    ]);
    expect(res.spx?.needsHistoryBefore).toBe("2014-01-01");
    const calls = okFetch.mock.calls as unknown as Array<[unknown, ...unknown[]]>;
    expect(String(calls[0]?.[0] ?? "")).toContain("/api/export/price-needs?limit=50");

    const bad = await fetchCongressPriceNeeds(
      10,
      vi.fn(async () => new Response("nope", { status: 403 })) as unknown as typeof fetch
    );
    expect(bad.tickers).toEqual([]);
  });
});

describe("runCongressDailyShare — fromAppANeeds + deep history for needs", () => {
  it("shares App A needs tickers with full history when needsDeepHistory", async () => {
    process.env.CONGRESS_TRADE_TOKEN = "tok";
    process.env.CONGRESS_SHARE_MAX_CLOSES_PER_TICKER = "2";
    const bars = (n: number): OHLCBar[] =>
      Array.from({ length: n }, (_, i) => ({
        time: `2020-01-${String(i + 1).padStart(2, "0")}`,
        close: 100 + i
      }));
    mockedFetchDailyOHLC.mockImplementation(async (sym: string) => {
      if (sym === "^GSPC") return bars(5);
      return bars(5);
    });
    const fetchSpy = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes("/api/export/price-needs")) {
        return new Response(
          JSON.stringify({
            tickers: [{ ticker: "NEED", needsDeepHistory: true, oldestTradeDate: "2020-01-01" }],
            spx: { needsHistoryBefore: "2020-01-01" }
          }),
          { status: 200 }
        );
      }
      // import POST
      return new Response(JSON.stringify({ ok: true, perfTickers: 1 }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchSpy);

    const summary = await runCongressDailyShare({ force: true, fromAppANeeds: true });
    expect(summary.ok).toBe(true);
    expect(summary.tickers).toBe(1);
    // price-needs GET + SPX/prices POSTs
    const importBodies = fetchSpy.mock.calls
      .filter((c) => String(c[0]).includes("/securities/import"))
      .map((c) => JSON.parse(String((c[1] as RequestInit).body)));
    const pricePost = importBodies.find((b) => Array.isArray(b.prices) && b.prices.length);
    expect(pricePost?.prices[0].ticker).toBe("NEED");
    // full history despite MAX_CLOSES=2
    expect(pricePost?.prices[0].closes.length).toBe(5);
  });
});
