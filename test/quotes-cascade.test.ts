import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cascadeFreshMaxAgeMs,
  fetchFinnhubQuote,
  fetchFreshQuotesCascade,
  fetchTiingoQuote,
  isCascadeFieldComplete,
  isQuoteFresh,
  isTwoSidedLiveNbbo,
  isUsableBrokerQuote,
  mergeBrokerQuoteFields,
  quoteAgeSecForStalenessGate,
  resolveVenueQuoteMode,
  syncQuotesToFieldStore
} from "../src/lib/quotes-cascade";
import { admitProviderRequests, resetProviderQuotaState } from "../src/lib/provider-rate-limit";
import type { BrokerQuote } from "../src/lib/types";

// Mock the modules that interface with external networks or DB
const mockGetPolicy = vi.fn();
const mockResolveAlpacaMarketData = vi.fn();
const mockResolveApiKeyWithSource = vi.fn();
const mockGetConnectedAccount = vi.fn();
const mockGetActiveConnectedAccount = vi.fn();
vi.mock("../src/lib/db", () => ({
  getPolicy: (...args: unknown[]) => mockGetPolicy(...args),
  resolveAlpacaMarketData: () => mockResolveAlpacaMarketData(),
  resolveApiKeyWithSource: (...args: unknown[]) => mockResolveApiKeyWithSource(...args),
  getConnectedAccount: (...args: unknown[]) => mockGetConnectedAccount(...args),
  getActiveConnectedAccount: (...args: unknown[]) => mockGetActiveConnectedAccount(...args),
  // Multi-broker Level 1b: empty by default so existing tests stay on active-only path.
  listConnectedAccounts: () => []
}));

const mockGetEquityQuotes = vi.fn();
vi.mock("../src/lib/broker", () => ({
  getBrokerGateway: () => ({
    getEquityQuotes: mockGetEquityQuotes
  })
}));

const mockEnrich = vi.fn();
const mockFetchWithRetry = vi.fn();
vi.mock("../src/lib/data-providers", () => ({
  AlpacaSnapshotEnrichmentProvider: class {
    enrich(symbols: string[]) {
      return mockEnrich(symbols);
    }
  },
  fetchWithRetry: (...args: unknown[]) => mockFetchWithRetry(...args),
  apiKeyFingerprint: async (key: string) => `fp:${key}`
}));

const mockUpsertSymbolFieldLatest = vi.fn();
vi.mock("../src/lib/db-fundamentals", () => ({
  upsertSymbolFieldLatest: (...args: unknown[]) => mockUpsertSymbolFieldLatest(...args)
}));

const mockFetchYahooFinanceQuote = vi.fn();
const mockFetchYahooFinanceQuotesBatch = vi.fn();
vi.mock("../src/lib/yahoo-finance", () => ({
  fetchYahooFinanceQuote: (sym: string) => mockFetchYahooFinanceQuote(sym),
  fetchYahooFinanceQuotesBatch: (syms: string[]) => mockFetchYahooFinanceQuotesBatch(syms)
}));

describe("isQuoteFresh / cascadeFreshMaxAgeMs", () => {
  it("aligns the cascade accept window with the 120s policy default (not 16 minutes)", () => {
    expect(cascadeFreshMaxAgeMs()).toBe(120_000);
    expect(cascadeFreshMaxAgeMs(120)).toBe(120_000);
    expect(cascadeFreshMaxAgeMs(60)).toBe(60_000);
  });

  it("rejects ~15-minute delayed feed ages for realtime venues", () => {
    const now = Date.now();
    const delayed15m = { asOf: new Date(now - 15 * 60 * 1000).toISOString() };
    expect(isQuoteFresh(delayed15m, now, cascadeFreshMaxAgeMs(120))).toBe(false);
    expect(isQuoteFresh(delayed15m, now, 16 * 60 * 1000)).toBe(true); // documents the old bug window
  });

  it("treats venue-authoritative quotes as fresh regardless of trade-time age", () => {
    const now = Date.now();
    const delayed15m = {
      asOf: new Date(now - 15 * 60 * 1000).toISOString(),
      venuePriceAuthoritative: true as const
    };
    expect(isQuoteFresh(delayed15m, now, cascadeFreshMaxAgeMs(120))).toBe(true);
  });

  it("accepts a truly fresh quote under the 120s bar", () => {
    const now = Date.now();
    expect(isQuoteFresh({ asOf: new Date(now - 30_000).toISOString() }, now, cascadeFreshMaxAgeMs(120))).toBe(true);
    expect(isQuoteFresh({ asOf: new Date(now - 180_000).toISOString() }, now, cascadeFreshMaxAgeMs(120))).toBe(false);
  });

  it("treats a two-sided live NBBO as fresh when fetchedAt is recent even if last-print asOf is old", () => {
    const now = Date.now();
    const quietName = {
      bid: 10.1,
      ask: 10.2,
      asOf: new Date(now - 30 * 60 * 1000).toISOString(),
      fetchedAt: new Date(now - 5_000).toISOString(),
      provider: "alpaca"
    };
    expect(isQuoteFresh(quietName, now, cascadeFreshMaxAgeMs(120))).toBe(true);
    expect(isUsableBrokerQuote(quietName, now, cascadeFreshMaxAgeMs(120))).toBe(true);
  });

  it("does not treat last-session close as cascade-fresh — later levels still run", () => {
    const now = Date.now();
    const close = {
      price: 95.25,
      asOf: "2026-06-24",
      fetchedAt: new Date(now).toISOString(),
      provider: "session-close"
    };
    expect(isQuoteFresh(close, now, cascadeFreshMaxAgeMs(120))).toBe(false);
    expect(isUsableBrokerQuote(close, now, cascadeFreshMaxAgeMs(120))).toBe(false);
  });

  it("never treats missing asOf as fresh (unless venue-authoritative)", () => {
    expect(isQuoteFresh({}, Date.now(), cascadeFreshMaxAgeMs(120))).toBe(false);
  });

  it("ages delayed tapes by market time — a fresh fetch stamp cannot promote Yahoo delay to live", () => {
    const now = Date.now();
    const delayedYahoo = {
      bid: 10.1,
      ask: 10.2,
      asOf: new Date(now - 15 * 60 * 1000).toISOString(),
      fetchedAt: new Date(now - 5_000).toISOString(),
      provider: "yahoo-finance"
    };
    // Before the fix this returned true: the fresh local fetchedAt masked the stale
    // market timestamp and the delayed Yahoo quote was treated as live.
    expect(isQuoteFresh(delayedYahoo, now, cascadeFreshMaxAgeMs(120))).toBe(false);
  });

  it("ages secondary delayed-tape books (Tradier paper) by market time", () => {
    const now = Date.now();
    const tradierPaper = {
      bid: 10.1,
      ask: 10.2,
      asOf: new Date(now - 15 * 60 * 1000).toISOString(),
      fetchedAt: new Date(now - 5_000).toISOString(),
      provider: "tradier-connected",
      venueDelayedTape: true as const
    };
    expect(isQuoteFresh(tradierPaper, now, cascadeFreshMaxAgeMs(120))).toBe(false);
  });

  it("still ages verified real-time broker books by fetch time", () => {
    const now = Date.now();
    const alpaca = {
      bid: 10.1,
      ask: 10.2,
      asOf: new Date(now - 30 * 60 * 1000).toISOString(),
      fetchedAt: new Date(now - 5_000).toISOString(),
      provider: "alpaca-snapshot"
    };
    expect(isQuoteFresh(alpaca, now, cascadeFreshMaxAgeMs(120))).toBe(true);
  });
});

describe("quoteAgeSecForStalenessGate", () => {
  it("ages realtime quotes by trade-time asOf", () => {
    const now = Date.now();
    const asOf = new Date(now - 90_000).toISOString();
    const r = quoteAgeSecForStalenessGate({ asOf }, now);
    expect(r.missing).toBe(false);
    expect(r.venueDelayed).toBe(false);
    expect(r.ageSec).toBe(90);
  });

  it("ages venue-authoritative quotes by fetchedAt (not trade-time delay)", () => {
    const now = Date.now();
    const tradeAsOf = new Date(now - 15 * 60 * 1000).toISOString(); // 15m delayed trade print
    const fetchedAt = new Date(now - 20_000).toISOString(); // fetched 20s ago
    const r = quoteAgeSecForStalenessGate(
      { asOf: tradeAsOf, fetchedAt, venuePriceAuthoritative: true },
      now
    );
    expect(r.missing).toBe(false);
    expect(r.venueDelayed).toBe(true);
    expect(r.ageSec).toBe(20);
    // Would look "stale" if we aged asOf (~900s) against maxQuoteAgeSec=120 — that is the bug we fixed.
    expect(r.ageSec! < 120).toBe(true);
  });

  it("ages delayed Yahoo fallback by fetchedAt, not the 15m print", () => {
    const now = Date.now();
    const r = quoteAgeSecForStalenessGate(
      {
        asOf: new Date(now - 18 * 60 * 1000).toISOString(),
        fetchedAt: new Date(now - 12_000).toISOString(),
        delayedFallback: true,
        provider: "yahoo-finance-single"
      },
      now
    );
    expect(r.delayedFallback).toBe(true);
    expect(r.venueDelayed).toBe(false);
    expect(r.ageSec).toBe(12);
  });

  it("ages realtime two-sided live NBBO broker quotes by fetchedAt (not trade-time delay)", () => {
    const now = Date.now();
    const tradeAsOf = new Date(now - 180_000).toISOString(); // trade was 3m ago (>120s)
    const fetchedAt = new Date(now - 5_000).toISOString(); // NBBO book was fetched 5s ago
    const r = quoteAgeSecForStalenessGate(
      {
        asOf: tradeAsOf,
        fetchedAt,
        bid: 150.1,
        ask: 150.2,
        provider: "alpaca"
      },
      now
    );
    expect(r.missing).toBe(false);
    expect(r.venueDelayed).toBe(false);
    expect(r.ageSec).toBe(5);
  });

  it("does not age synthetic bid/ask quotes by fetchedAt", () => {
    const now = Date.now();
    const tradeAsOf = new Date(now - 180_000).toISOString();
    const fetchedAt = new Date(now - 5_000).toISOString();
    const r = quoteAgeSecForStalenessGate(
      {
        asOf: tradeAsOf,
        fetchedAt,
        bid: 150.1,
        ask: 150.2,
        syntheticSpread: true,
        provider: "custom"
      },
      now
    );
    expect(r.ageSec).toBe(180);
  });
});

describe("isTwoSidedLiveNbbo", () => {
  it("returns true when positive numeric bid and ask exist and no synthetic flags", () => {
    expect(isTwoSidedLiveNbbo({ bid: 100, ask: 100.05 })).toBe(true);
  });

  it("returns false when syntheticSpread, syntheticBid, or syntheticAsk is set", () => {
    expect(isTwoSidedLiveNbbo({ bid: 100, ask: 100.05, syntheticSpread: true })).toBe(false);
    expect(isTwoSidedLiveNbbo({ bid: 100, ask: 100.05, syntheticBid: true })).toBe(false);
    expect(isTwoSidedLiveNbbo({ bid: 100, ask: 100.05, syntheticAsk: true })).toBe(false);
  });

  it("returns false when bid or ask is zero, negative, or undefined", () => {
    expect(isTwoSidedLiveNbbo({ bid: 0, ask: 100 })).toBe(false);
    expect(isTwoSidedLiveNbbo({ bid: 100, ask: 0 })).toBe(false);
    expect(isTwoSidedLiveNbbo({ bid: 100 })).toBe(false);
    expect(isTwoSidedLiveNbbo({ ask: 100 })).toBe(false);
  });

  it("returns false for a crossed book (bid > ask) — malformed NBBO is never live", () => {
    expect(isTwoSidedLiveNbbo({ bid: 100.05, ask: 100 })).toBe(false);
  });
});

describe("resolveVenueQuoteMode", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns venue_delayed for Tradier paper/sandbox accounts", () => {
    mockGetConnectedAccount.mockReturnValue({
      id: "tr-sand",
      broker: "tradier",
      environment: "paper"
    });
    expect(
      resolveVenueQuoteMode({ activeBroker: "tradier", connectedAccountId: "tr-sand" }, "local")
    ).toBe("venue_delayed");
  });

  it("returns realtime for Tradier production (live) accounts", () => {
    mockGetConnectedAccount.mockReturnValue({
      id: "tr-live",
      broker: "tradier",
      environment: "live"
    });
    expect(
      resolveVenueQuoteMode({ activeBroker: "tradier", connectedAccountId: "tr-live" }, "local")
    ).toBe("realtime");
  });

  it("returns realtime for Alpaca paper (real-time paper simulation)", () => {
    mockGetConnectedAccount.mockReturnValue({
      id: "ap",
      broker: "alpaca",
      environment: "paper"
    });
    expect(
      resolveVenueQuoteMode({ activeBroker: "alpaca", connectedAccountId: "ap" }, "local")
    ).toBe("realtime");
  });
});

describe("fetchFreshQuotesCascade", () => {
  beforeAll(() => {
    vi.stubEnv("TEST_ALLOW_CASCADE_EXTERNAL", "1");
  });

  afterAll(() => {
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    vi.resetAllMocks();

    // Default: Alpaca realtime venue
    mockGetPolicy.mockReturnValue({
      activeBroker: "alpaca",
      accountNumber: "ACC123",
      connectedAccountId: "alp-1",
      maxQuoteAgeSec: 120
    });
    mockGetConnectedAccount.mockReturnValue({
      id: "alp-1",
      broker: "alpaca",
      environment: "paper"
    });
    mockGetActiveConnectedAccount.mockReturnValue(undefined);
    mockResolveAlpacaMarketData.mockReturnValue({
      apiKey: "fake_key",
      secretKey: "fake_secret",
      source: "env"
    });
    mockResolveApiKeyWithSource.mockReturnValue({ key: undefined, source: "none" });
  });

  it("resolves fresh quotes immediately at Level 1 (Broker) and stops cascade", async () => {
    const now = Date.now();
    const freshIso = new Date(now - 60 * 1000).toISOString(); // 1 minute old — within 120s

    const brokerQuotes: Record<string, BrokerQuote> = {
      AAPL: {
        symbol: "AAPL",
        price: 150,
        bid: 149.9,
        ask: 150.1,
        prevClose: 148,
        open: 149,
        high: 151,
        low: 147.5,
        asOf: freshIso,
        provider: "alpaca"
      }
    };
    mockGetEquityQuotes.mockResolvedValue(brokerQuotes);

    const result = await fetchFreshQuotesCascade(["AAPL"], "local", "ACC123");

    expect(mockGetEquityQuotes).toHaveBeenCalledWith("ACC123", ["AAPL"], { signal: undefined });
    expect(mockEnrich).not.toHaveBeenCalled();
    expect(mockFetchYahooFinanceQuotesBatch).not.toHaveBeenCalled();
    expect(mockFetchYahooFinanceQuote).not.toHaveBeenCalled();

    expect(result.AAPL).toMatchObject(brokerQuotes.AAPL);
    expect(result.AAPL?.fetchedAt).toBeDefined();
  });

  it("resolves broker quote with older asOf (>120s) as fresh when two-sided live NBBO is fetched", async () => {
    const now = Date.now();
    const olderTradeIso = new Date(now - 150 * 1000).toISOString(); // 150s old trade print

    mockGetEquityQuotes.mockResolvedValue({
      MSFT: {
        symbol: "MSFT",
        price: 300,
        bid: 299.95,
        ask: 300.05,
        prevClose: 298,
        open: 299,
        high: 301,
        low: 297.5,
        asOf: olderTradeIso,
        provider: "alpaca"
      }
    });

    const result = await fetchFreshQuotesCascade(["MSFT"], "local", "ACC123");

    expect(mockGetEquityQuotes).toHaveBeenCalledWith("ACC123", ["MSFT"], { signal: undefined });
    expect(mockEnrich).not.toHaveBeenCalled();
    expect(mockFetchYahooFinanceQuotesBatch).not.toHaveBeenCalled();
    expect(result.MSFT?.symbol).toBe("MSFT");
    expect(result.MSFT?.price).toBe(300);
    expect(result.MSFT?.fetchedAt).toBeDefined();
    expect(result.MSFT?.delayedFallback).toBeUndefined();
  });

  it("on realtime venues, does NOT stop on a session-close IEX fill — continues to Alpaca snapshot", async () => {
    const now = Date.now();
    const liveIso = new Date(now - 20 * 1000).toISOString();

    mockGetEquityQuotes.mockResolvedValue({
      XOM: {
        symbol: "XOM",
        price: 110.5,
        asOf: "2026-06-24",
        fetchedAt: new Date(now).toISOString(),
        provider: "session-close"
      }
    });
    mockEnrich.mockResolvedValue({
      XOM: { price: 112.4, asOf: liveIso, bid: 112.3, ask: 112.5, volume: 1000 }
    });

    const result = await fetchFreshQuotesCascade(["XOM"], "local", "ACC123");

    expect(mockGetEquityQuotes).toHaveBeenCalled();
    expect(mockEnrich).toHaveBeenCalledWith(["XOM"]);
    expect(result.XOM.price).toBe(112.4);
    expect(result.XOM.provider).toBe("alpaca-snapshot");
    expect(result.XOM.asOf).toBe(liveIso);
  });

  it("on realtime venues, does NOT stop on a ~15-minute delayed broker quote — continues to Alpaca snapshot", async () => {
    // NOTE: the Alpaca quote below is field-complete (prevClose + OHLC) so this
    // test keeps its original intent — Alpaca stops the cascade. A
    // field-incomplete Alpaca quote would (correctly, per the #3449 P1 review)
    // let the cascade continue to Finnhub/Tiingo/Yahoo.
    const now = Date.now();
    const delayedIso = new Date(now - 15 * 60 * 1000).toISOString();
    const liveIso = new Date(now - 20 * 1000).toISOString();

    mockGetEquityQuotes.mockResolvedValue({
      MSFT: { symbol: "MSFT", price: 300, asOf: delayedIso, provider: "tradier" }
    });
    mockEnrich.mockResolvedValue({
      MSFT: {
        price: 305,
        asOf: liveIso,
        bid: 304,
        ask: 306,
        volume: 1000,
        prevClose: 300,
        open: 301,
        high: 306,
        low: 300.5
      }
    });

    const result = await fetchFreshQuotesCascade(["MSFT"], "local", "ACC123");

    expect(mockGetEquityQuotes).toHaveBeenCalled();
    expect(mockEnrich).toHaveBeenCalledWith(["MSFT"]);
    expect(result.MSFT.price).toBe(305);
    expect(result.MSFT.provider).toBe("alpaca-snapshot");
    expect(result.MSFT.asOf).toBe(liveIso);
    expect(result.MSFT.venuePriceAuthoritative).toBeUndefined();
  });

  it("on Tradier sandbox (paper), KEEPS the delayed broker quote and does not overlay fresher external prices", async () => {
    const now = Date.now();
    const delayedIso = new Date(now - 15 * 60 * 1000).toISOString();
    const liveIso = new Date(now - 20 * 1000).toISOString();

    mockGetPolicy.mockReturnValue({
      activeBroker: "tradier",
      accountNumber: "VA00000000",
      connectedAccountId: "tr-sand",
      maxQuoteAgeSec: 120
    });
    mockGetConnectedAccount.mockReturnValue({
      id: "tr-sand",
      broker: "tradier",
      environment: "paper"
    });

    mockGetEquityQuotes.mockResolvedValue({
      MSFT: { symbol: "MSFT", price: 300, asOf: delayedIso, provider: "tradier" }
    });
    mockEnrich.mockResolvedValue({
      MSFT: { price: 305, asOf: liveIso, bid: 304, ask: 306, volume: 1000 }
    });

    const result = await fetchFreshQuotesCascade(["MSFT"], "local", "VA00000000", "tr-sand");

    expect(mockGetEquityQuotes).toHaveBeenCalledWith("VA00000000", ["MSFT"], { signal: undefined });
    // Must not chase a fresher external print — sandbox fills against delayed tape.
    expect(mockEnrich).not.toHaveBeenCalled();
    expect(mockFetchYahooFinanceQuotesBatch).not.toHaveBeenCalled();
    expect(result.MSFT.price).toBe(300);
    expect(result.MSFT.provider).toBe("tradier");
    expect(result.MSFT.asOf).toBe(delayedIso);
    expect(result.MSFT.venuePriceAuthoritative).toBe(true);
    expect(result.MSFT.fetchedAt).toBeTruthy();
    // Snapshot is fresh even though trade print is ~15m old.
    const age = quoteAgeSecForStalenessGate(result.MSFT, Date.now());
    expect(age.venueDelayed).toBe(true);
    expect(age.ageSec!).toBeLessThan(5);
  });

  it("falls back to Level 2 (Alpaca Snapshot) if Level 1 returns a quote older than maxQuoteAgeSec (realtime)", async () => {
    const now = Date.now();
    const staleIso = new Date(now - 5 * 60 * 1000).toISOString(); // 5 minutes — stale vs 120s
    const freshIso = new Date(now - 30 * 1000).toISOString(); // 30s — fresh

    mockGetEquityQuotes.mockResolvedValue({
      MSFT: { symbol: "MSFT", price: 300, asOf: staleIso, provider: "alpaca" }
    });
    // NOTE: field-complete (prevClose + OHLC) so this test keeps its original
    // intent — Alpaca stops the cascade here.
    mockEnrich.mockResolvedValue({
      MSFT: {
        price: 305,
        asOf: freshIso,
        bid: 304,
        ask: 306,
        volume: 1000,
        prevClose: 300,
        open: 301,
        high: 306,
        low: 300.5
      }
    });

    const result = await fetchFreshQuotesCascade(["MSFT"], "local", "ACC123");

    expect(mockGetEquityQuotes).toHaveBeenCalledWith("ACC123", ["MSFT"], { signal: undefined });
    expect(mockEnrich).toHaveBeenCalledWith(["MSFT"]);
    expect(mockFetchYahooFinanceQuotesBatch).not.toHaveBeenCalled();

    expect(result.MSFT.price).toBe(305);
    expect(result.MSFT.provider).toBe("alpaca-snapshot");
    expect(result.MSFT.asOf).toBe(freshIso);
  });

  it("cascades through all levels and falls back to the best available quote when all are stale", async () => {
    const now = Date.now();
    const staleBrokerTime = new Date(now - 30 * 60 * 1000).toISOString(); // 30 mins
    const staleAlpacaTime = new Date(now - 25 * 60 * 1000).toISOString(); // 25 mins
    const staleYahooBatchTime = new Date(now - 20 * 60 * 1000).toISOString(); // 20 mins
    const staleYahooSingleTime = new Date(now - 17 * 60 * 1000).toISOString(); // 17 mins

    mockGetEquityQuotes.mockResolvedValue({
      TSLA: { symbol: "TSLA", price: 200, asOf: staleBrokerTime, provider: "alpaca" }
    });
    mockEnrich.mockResolvedValue({
      TSLA: { price: 201, asOf: staleAlpacaTime }
    });
    mockFetchYahooFinanceQuotesBatch.mockResolvedValue(new Map([["TSLA", { price: 202, asOf: staleYahooBatchTime }]]));
    mockFetchYahooFinanceQuote.mockResolvedValue({
      price: 203,
      asOf: staleYahooSingleTime
    });

    const result = await fetchFreshQuotesCascade(["TSLA"], "local", "ACC123");

    expect(mockGetEquityQuotes).toHaveBeenCalled();
    expect(mockEnrich).toHaveBeenCalled();
    expect(mockFetchYahooFinanceQuotesBatch).toHaveBeenCalled();
    expect(mockFetchYahooFinanceQuote).toHaveBeenCalled();

    // StaleYahooSingleTime (17 mins ago) is the freshest among all stale options.
    expect(result.TSLA.price).toBe(203);
    expect(result.TSLA.provider).toBe("yahoo-finance-single");
    expect(result.TSLA.asOf).toBe(staleYahooSingleTime);
    expect(result.TSLA.delayedFallback).toBe(true);
    expect(result.TSLA.fetchedAt).toBeTruthy();
  });

  it("does not start broker work when the gather deadline has already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("strategy gather timeout"));

    await expect(
      fetchFreshQuotesCascade(["AAPL"], "local", "ACC123", undefined, { signal: controller.signal })
    ).rejects.toThrow("strategy gather timeout");

    expect(mockGetEquityQuotes).not.toHaveBeenCalled();
    expect(mockEnrich).not.toHaveBeenCalled();
  });

  it("does NOT stop at Level 3 (Finnhub) on a field-incomplete quote — the cascade continues for backfill", async () => {
    // Codex P1 review on #3449: a fresh price without a book must not stop the
    // cascade; later levels get the chance to backfill the missing fields.
    const now = Date.now();
    const freshSeconds = Math.floor((now - 30 * 1000) / 1000);

    mockGetEquityQuotes.mockResolvedValue({}); // Level 1 misses
    mockEnrich.mockResolvedValue({}); // Level 2 Alpaca misses
    mockResolveApiKeyWithSource.mockImplementation((svc) =>
      svc === "finnhub" ? { key: "fake_finnhub", source: "env" } : { key: undefined, source: "none" }
    );

    mockFetchWithRetry.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        c: 180.5,
        pc: 178.0,
        o: 179.0,
        h: 181.0,
        l: 178.5,
        d: 2.5,
        dp: 1.4,
        t: freshSeconds
      })
    });

    const result = await fetchFreshQuotesCascade(["NVDA"], "local", "ACC123");
    // Finnhub supplies no bid/ask: field-incomplete, so the cascade continued…
    expect(mockFetchYahooFinanceQuotesBatch).toHaveBeenCalled();
    // …but the Finnhub quote is still returned via the best-quote fallback.
    expect(result.NVDA).toBeDefined();
    expect(result.NVDA?.price).toBe(180.5);
    expect(result.NVDA?.provider).toBe("finnhub");
    expect(result.NVDA?.prevClose).toBe(178.0);
  });

  it("does NOT stop on a fresh broker quote missing prevClose/OHLC — Alpaca backfills the fields", async () => {
    // The review's core case: the common fresh-broker path must not truncate
    // multi-provider coalescing.
    const now = Date.now();
    const brokerIso = new Date(now - 10 * 1000).toISOString();
    const alpacaIso = new Date(now - 60 * 1000).toISOString();

    mockGetEquityQuotes.mockResolvedValue({
      XOM: { symbol: "XOM", price: 110.5, bid: 110.4, ask: 110.6, asOf: brokerIso, provider: "alpaca" }
    });
    mockEnrich.mockResolvedValue({
      XOM: {
        price: 110.45,
        bid: 110.35,
        ask: 110.55,
        prevClose: 108.0,
        open: 109.0,
        high: 111.0,
        low: 108.5,
        volume: 5_000_000,
        asOf: alpacaIso
      }
    });

    const result = await fetchFreshQuotesCascade(["XOM"], "local", "ACC123");

    // The cascade continued past the field-incomplete broker quote…
    expect(mockEnrich).toHaveBeenCalledWith(["XOM"]);
    // …and the merged result kept the fresher broker price while backfilling
    // the missing fields from Alpaca. Field-complete now: Yahoo never ran.
    expect(result.XOM.price).toBe(110.5);
    expect(result.XOM.provider).toBe("alpaca");
    expect(result.XOM.prevClose).toBe(108.0);
    expect(result.XOM.open).toBe(109.0);
    expect(result.XOM.high).toBe(111.0);
    expect(result.XOM.low).toBe(108.5);
    expect(mockFetchYahooFinanceQuotesBatch).not.toHaveBeenCalled();
  });

  it("resolves quote at Level 4 (Tiingo) when Level 1, 2, and 3 miss", async () => {
    const now = Date.now();
    const freshIso = new Date(now - 25 * 1000).toISOString();

    mockGetEquityQuotes.mockResolvedValue({}); // Level 1 misses
    mockEnrich.mockResolvedValue({}); // Level 2 misses
    mockResolveApiKeyWithSource.mockImplementation((svc) =>
      svc === "tiingo" ? { key: "fake_tiingo", source: "env" } : { key: undefined, source: "none" }
    );

    mockFetchWithRetry.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        {
          ticker: "AMD",
          timestamp: freshIso,
          tngoLast: 145.2,
          bidPrice: 145.15,
          askPrice: 145.25,
          bidSize: 100,
          askSize: 200,
          volume: 20_000_000,
          prevClose: 142.0,
          open: 143.0,
          high: 146.0,
          low: 142.5
        }
      ]
    });

    const result = await fetchFreshQuotesCascade(["AMD"], "local", "ACC123");
    expect(result.AMD).toBeDefined();
    expect(result.AMD?.price).toBe(145.2);
    expect(result.AMD?.provider).toBe("tiingo");
    expect(result.AMD?.prevClose).toBe(142.0);
    expect(result.AMD?.bidSize).toBe(100);
    expect(result.AMD?.askSize).toBe(200);
    expect(mockFetchYahooFinanceQuotesBatch).not.toHaveBeenCalled();
  });

  it("syncs resolved quotes to symbol_field_latest asynchronously", async () => {
    const now = Date.now();
    const freshIso = new Date(now - 10 * 1000).toISOString();

    mockGetEquityQuotes.mockResolvedValue({
      AAPL: {
        symbol: "AAPL",
        price: 150,
        bid: 149.9,
        ask: 150.1,
        prevClose: 148,
        vwap: 149.5,
        asOf: freshIso,
        provider: "alpaca"
      }
    });

    await fetchFreshQuotesCascade(["AAPL"], "local", "ACC123");
    expect(mockUpsertSymbolFieldLatest).toHaveBeenCalled();
    const callArgs = mockUpsertSymbolFieldLatest.mock.calls[0][0] as { symbol: string; field: string }[];
    expect(callArgs.some((r) => r.symbol === "AAPL" && r.field === "price")).toBe(true);
    expect(callArgs.some((r) => r.symbol === "AAPL" && r.field === "prevClose")).toBe(true);
    expect(callArgs.some((r) => r.symbol === "AAPL" && r.field === "vwap")).toBe(true);
  });
});

describe("isCascadeFieldComplete", () => {
  const complete: BrokerQuote = {
    symbol: "AAPL",
    price: 150,
    bid: 149.9,
    ask: 150.1,
    prevClose: 148,
    open: 149,
    high: 151,
    low: 147.5
  };

  it("accepts a quote with price, two-sided book, prevClose and OHLC", () => {
    expect(isCascadeFieldComplete(complete)).toBe(true);
  });

  it("rejects a quote missing prevClose", () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { prevClose, ...rest } = complete;
    expect(isCascadeFieldComplete(rest)).toBe(false);
  });

  it("rejects a quote missing the book", () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { bid, ask, ...rest } = complete;
    expect(isCascadeFieldComplete(rest)).toBe(false);
  });

  it("rejects a quote missing OHLC", () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { open, ...rest } = complete;
    expect(isCascadeFieldComplete(rest)).toBe(false);
  });

  it("rejects a quote with no usable price", () => {
    expect(isCascadeFieldComplete({ symbol: "AAPL" })).toBe(false);
    expect(isCascadeFieldComplete({ ...complete, price: 0 })).toBe(false);
  });
});

describe("mergeBrokerQuoteFields", () => {
  it("preserves venue-authoritative execution price and provider while backfilling missing fields from incoming quote", () => {
    const target: BrokerQuote = {
      symbol: "MSFT",
      price: 300,
      asOf: "2026-09-21T10:00:00.000Z",
      provider: "tradier",
      venuePriceAuthoritative: true,
      fetchedAt: "2026-09-21T10:15:00.000Z"
    };
    const incoming: BrokerQuote = {
      symbol: "MSFT",
      price: 305,
      prevClose: 298,
      open: 299,
      high: 306,
      low: 297,
      vwap: 302.5,
      bid: 304.9,
      ask: 305.1,
      bidSize: 500,
      askSize: 800,
      volume: 12_000_000,
      companyName: "Microsoft Corporation",
      asOf: "2026-09-21T10:14:30.000Z",
      provider: "alpaca-snapshot"
    };

    const merged = mergeBrokerQuoteFields(target, incoming);
    expect(merged).toBeDefined();
    // Authoritative execution fields MUST be preserved
    expect(merged?.price).toBe(300);
    expect(merged?.provider).toBe("tradier");
    expect(merged?.venuePriceAuthoritative).toBe(true);
    expect(merged?.asOf).toBe("2026-09-21T10:00:00.000Z");

    // Missing descriptive fields MUST be backfilled
    expect(merged?.prevClose).toBe(298);
    expect(merged?.open).toBe(299);
    expect(merged?.high).toBe(306);
    expect(merged?.low).toBe(297);
    expect(merged?.vwap).toBe(302.5);
    expect(merged?.bid).toBe(304.9);
    expect(merged?.ask).toBe(305.1);
    expect(merged?.bidSize).toBe(500);
    expect(merged?.askSize).toBe(800);
    expect(merged?.volume).toBe(12_000_000);
    expect(merged?.companyName).toBe("Microsoft Corporation");
  });

  it("fresher quote wins primary price/provider while older quote backfills missing fields", () => {
    const older: BrokerQuote = {
      symbol: "AAPL",
      price: 150,
      bid: 149.9,
      ask: 150.1,
      bidSize: 100,
      askSize: 200,
      volume: 5_000_000,
      asOf: "2026-09-21T10:00:00.000Z",
      provider: "alpaca"
    };
    const newer: BrokerQuote = {
      symbol: "AAPL",
      price: 152,
      prevClose: 148,
      open: 149,
      high: 153,
      low: 148.5,
      vwap: 151,
      companyName: "Apple Inc.",
      asOf: "2026-09-21T10:05:00.000Z",
      provider: "finnhub"
    };

    const merged = mergeBrokerQuoteFields(older, newer);
    expect(merged).toBeDefined();
    // Newer wins primary price & provider
    expect(merged?.price).toBe(152);
    expect(merged?.provider).toBe("finnhub");
    expect(merged?.asOf).toBe("2026-09-21T10:05:00.000Z");

    // Older backfills bid, ask, sizes, volume
    expect(merged?.bid).toBe(149.9);
    expect(merged?.ask).toBe(150.1);
    expect(merged?.bidSize).toBe(100);
    expect(merged?.askSize).toBe(200);
    expect(merged?.volume).toBe(5_000_000);

    // Newer provides OHLC / vwap / prevClose / companyName
    expect(merged?.prevClose).toBe(148);
    expect(merged?.open).toBe(149);
    expect(merged?.high).toBe(153);
    expect(merged?.low).toBe(148.5);
    expect(merged?.vwap).toBe(151);
    expect(merged?.companyName).toBe("Apple Inc.");
  });

  it("records per-field provenance: the winner stamps price, the backfiller stamps its fields", () => {
    // Codex P1 review on #3449: persistence must attribute each field to the
    // provider that actually supplied it.
    const older: BrokerQuote = {
      symbol: "AAPL",
      price: 150,
      bid: 149.9,
      ask: 150.1,
      asOf: "2026-09-21T10:00:00.000Z",
      fetchedAt: "2026-09-21T10:00:05.000Z",
      provider: "alpaca"
    };
    const newer: BrokerQuote = {
      symbol: "AAPL",
      price: 152,
      prevClose: 148,
      asOf: "2026-09-21T10:05:00.000Z",
      fetchedAt: "2026-09-21T10:05:05.000Z",
      provider: "finnhub"
    };

    const merged = mergeBrokerQuoteFields(older, newer);
    expect(merged).toBeDefined();
    // Newer wins the primary price/provider…
    expect(merged?.price).toBe(152);
    expect(merged?.fieldProvenance?.price?.provider).toBe("finnhub");
    expect(merged?.fieldProvenance?.price?.asOf).toBe("2026-09-21T10:05:00.000Z");
    expect(merged?.fieldProvenance?.prevClose?.provider).toBe("finnhub");
    // …while the older quote's backfilled book keeps ITS provider/timestamps.
    expect(merged?.bid).toBe(149.9);
    expect(merged?.fieldProvenance?.bid?.provider).toBe("alpaca");
    expect(merged?.fieldProvenance?.bid?.asOf).toBe("2026-09-21T10:00:00.000Z");
    expect(merged?.fieldProvenance?.ask?.provider).toBe("alpaca");
  });

  it("incoming venue-authoritative quote supersedes non-authoritative target", () => {
    const target: BrokerQuote = {
      symbol: "TSLA",
      price: 250,
      asOf: "2026-09-21T10:05:00.000Z",
      provider: "yahoo-finance-batch"
    };
    const incoming: BrokerQuote = {
      symbol: "TSLA",
      price: 248,
      asOf: "2026-09-21T09:50:00.000Z",
      provider: "tradier",
      venuePriceAuthoritative: true
    };

    const merged = mergeBrokerQuoteFields(target, incoming);
    expect(merged?.price).toBe(248);
    expect(merged?.provider).toBe("tradier");
    expect(merged?.venuePriceAuthoritative).toBe(true);
  });
});

describe("syncQuotesToFieldStore field provenance", () => {
  it("persists each field with its own provider/timestamps, not the merged quote-level stamps", () => {
    mockUpsertSymbolFieldLatest.mockClear();
    const quote: BrokerQuote = {
      symbol: "AAPL",
      price: 180.5,
      bid: 180.4,
      ask: 180.6,
      prevClose: 178,
      asOf: "2026-09-21T14:00:00.000Z",
      fetchedAt: "2026-09-21T14:00:05.000Z",
      provider: "finnhub",
      fieldProvenance: {
        price: { provider: "finnhub", asOf: "2026-09-21T14:00:00.000Z", fetchedAt: "2026-09-21T14:00:05.000Z" },
        prevClose: { provider: "finnhub", asOf: "2026-09-21T14:00:00.000Z", fetchedAt: "2026-09-21T14:00:05.000Z" },
        bid: { provider: "alpaca-snapshot", asOf: "2026-09-21T13:59:00.000Z", fetchedAt: "2026-09-21T13:59:30.000Z" },
        ask: { provider: "alpaca-snapshot", asOf: "2026-09-21T13:59:00.000Z", fetchedAt: "2026-09-21T13:59:30.000Z" }
      }
    };

    syncQuotesToFieldStore({ AAPL: quote });

    expect(mockUpsertSymbolFieldLatest).toHaveBeenCalled();
    const records = mockUpsertSymbolFieldLatest.mock.calls[0][0] as any[];
    const byField = Object.fromEntries(records.map((r) => [r.field, r]));
    // The backfilled bid keeps the broker's stamps — not Finnhub's.
    expect(byField.bid.source).toBe("alpaca-snapshot");
    expect(byField.bid.asOf).toBe("2026-09-21T13:59:00.000Z");
    expect(byField.bid.fetchedAt).toBe("2026-09-21T13:59:30.000Z");
    // The winning price keeps Finnhub's stamps.
    expect(byField.price.source).toBe("finnhub");
    expect(byField.price.asOf).toBe("2026-09-21T14:00:00.000Z");
  });

  it("falls back to quote-level stamps when a field has no provenance receipt", () => {
    mockUpsertSymbolFieldLatest.mockClear();
    const quote: BrokerQuote = {
      symbol: "AAPL",
      price: 180.5,
      asOf: "2026-09-21T14:00:00.000Z",
      fetchedAt: "2026-09-21T14:00:05.000Z",
      provider: "finnhub"
    };

    syncQuotesToFieldStore({ AAPL: quote });

    const records = mockUpsertSymbolFieldLatest.mock.calls[0][0] as any[];
    const price = records.find((r) => r.field === "price");
    expect(price.source).toBe("finnhub");
    expect(price.asOf).toBe("2026-09-21T14:00:00.000Z");
  });
});

describe("fetchFinnhubQuote and fetchTiingoQuote", () => {
  it("fetchFinnhubQuote extracts full quote metrics", async () => {
    mockFetchWithRetry.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        c: 261.74,
        d: 3.24,
        dp: 1.25,
        h: 263.31,
        l: 260.68,
        o: 261.07,
        pc: 258.5,
        t: 1582641000
      })
    });

    const quote = await fetchFinnhubQuote("AAPL", "fake_key", "env", "local");
    expect(quote).toBeDefined();
    expect(quote?.symbol).toBe("AAPL");
    expect(quote?.price).toBe(261.74);
    expect(quote?.prevClose).toBe(258.5);
    expect(quote?.open).toBe(261.07);
    expect(quote?.high).toBe(263.31);
    expect(quote?.low).toBe(260.68);
    expect(quote?.change).toBe(3.24);
    expect(quote?.changePct).toBe(1.25);
    expect(quote?.provider).toBe("finnhub");
    expect(quote?.asOf).toBe(new Date(1582641000 * 1000).toISOString());
  });

  it("fetchTiingoQuote extracts IEX quote metrics", async () => {
    mockFetchWithRetry.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        {
          ticker: "AAPL",
          timestamp: "2026-09-21T14:30:00.000Z",
          tngoLast: 220.5,
          bidPrice: 220.48,
          askPrice: 220.52,
          bidSize: 200,
          askSize: 300,
          volume: 45_000_000,
          prevClose: 218.2,
          open: 219.0,
          high: 221.0,
          low: 218.5
        }
      ]
    });

    const quote = await fetchTiingoQuote("AAPL", "fake_key", "env", "local");
    expect(quote).toBeDefined();
    expect(quote?.symbol).toBe("AAPL");
    expect(quote?.price).toBe(220.5);
    expect(quote?.bid).toBe(220.48);
    expect(quote?.ask).toBe(220.52);
    expect(quote?.bidSize).toBe(200);
    expect(quote?.askSize).toBe(300);
    expect(quote?.volume).toBe(45_000_000);
    expect(quote?.prevClose).toBe(218.2);
    expect(quote?.open).toBe(219.0);
    expect(quote?.high).toBe(221.0);
    expect(quote?.low).toBe(218.5);
    expect(quote?.change).toBe(2.3);
    expect(quote?.changePct).toBe(1.05);
    expect(quote?.provider).toBe("tiingo");
    expect(quote?.asOf).toBe("2026-09-21T14:30:00.000Z");
  });

  it("fetchTiingoQuote passes retries: 0 so no uncounted retry escapes the quota", async () => {
    mockFetchWithRetry.mockResolvedValueOnce({
      ok: true,
      json: async () => [{ ticker: "AAPL", tngoLast: 220.5, timestamp: "2026-09-21T14:30:00.000Z" }]
    });

    await fetchTiingoQuote("AAPL", "fake_key", "env", "local");

    expect(mockFetchWithRetry).toHaveBeenCalled();
    const options = mockFetchWithRetry.mock.calls[0][2] as any;
    expect(options.retries).toBe(0);
  });

  it("fetchTiingoQuote skips the upstream call when the tiingo quota is exhausted", async () => {
    // The data-providers mock fingerprints keys as `fp:${key}`.
    admitProviderRequests("tiingo", "fp:quota_key", 50); // exhaust the 50/hour bucket
    try {
      const quote = await fetchTiingoQuote("AAPL", "quota_key", "env", "local");
      expect(quote).toBeUndefined();
      expect(mockFetchWithRetry).not.toHaveBeenCalled();
    } finally {
      resetProviderQuotaState("tiingo");
    }
  });
});
