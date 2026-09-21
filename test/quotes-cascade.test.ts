import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cascadeFreshMaxAgeMs,
  fetchFreshQuotesCascade,
  isQuoteFresh,
  isTwoSidedLiveNbbo,
  isUsableBrokerQuote,
  quoteAgeSecForStalenessGate,
  resolveVenueQuoteMode
} from "../src/lib/quotes-cascade";
import type { BrokerQuote } from "../src/lib/types";

// Mock the modules that interface with external networks or DB
const mockGetPolicy = vi.fn();
const mockResolveAlpacaMarketData = vi.fn();
const mockGetConnectedAccount = vi.fn();
const mockGetActiveConnectedAccount = vi.fn();
vi.mock("../src/lib/db", () => ({
  getPolicy: (...args: unknown[]) => mockGetPolicy(...args),
  resolveAlpacaMarketData: () => mockResolveAlpacaMarketData(),
  resolveApiKeyWithSource: () => ({ key: undefined, source: "none" }),
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
vi.mock("../src/lib/data-providers", () => ({
  AlpacaSnapshotEnrichmentProvider: class {
    enrich(symbols: string[]) {
      return mockEnrich(symbols);
    }
  },
  fetchWithRetry: vi.fn()
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
  });

  it("resolves fresh quotes immediately at Level 1 (Broker) and stops cascade", async () => {
    const now = Date.now();
    const freshIso = new Date(now - 60 * 1000).toISOString(); // 1 minute old — within 120s

    const brokerQuotes: Record<string, BrokerQuote> = {
      AAPL: { symbol: "AAPL", price: 150, bid: 149.9, ask: 150.1, asOf: freshIso, provider: "alpaca" }
    };
    mockGetEquityQuotes.mockResolvedValue(brokerQuotes);

    const result = await fetchFreshQuotesCascade(["AAPL"], "local", "ACC123");

    expect(mockGetEquityQuotes).toHaveBeenCalledWith("ACC123", ["AAPL"]);
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
      MSFT: { symbol: "MSFT", price: 300, bid: 299.95, ask: 300.05, asOf: olderTradeIso, provider: "alpaca" }
    });

    const result = await fetchFreshQuotesCascade(["MSFT"], "local", "ACC123");

    expect(mockGetEquityQuotes).toHaveBeenCalledWith("ACC123", ["MSFT"]);
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
    const now = Date.now();
    const delayedIso = new Date(now - 15 * 60 * 1000).toISOString();
    const liveIso = new Date(now - 20 * 1000).toISOString();

    mockGetEquityQuotes.mockResolvedValue({
      MSFT: { symbol: "MSFT", price: 300, asOf: delayedIso, provider: "tradier" }
    });
    mockEnrich.mockResolvedValue({
      MSFT: { price: 305, asOf: liveIso, bid: 304, ask: 306, volume: 1000 }
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

    expect(mockGetEquityQuotes).toHaveBeenCalledWith("VA00000000", ["MSFT"]);
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
    mockEnrich.mockResolvedValue({
      MSFT: { price: 305, asOf: freshIso, bid: 304, ask: 306, volume: 1000 }
    });

    const result = await fetchFreshQuotesCascade(["MSFT"], "local", "ACC123");

    expect(mockGetEquityQuotes).toHaveBeenCalledWith("ACC123", ["MSFT"]);
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
});
