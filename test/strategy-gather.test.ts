import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MarketScan, ScoringWeights } from "../src/lib/types";

const mockScanMarket = vi.fn();
const mockFetchFreshQuotesCascade = vi.fn();
const mockNewestPersisted = vi.fn();

vi.mock("../src/lib/market", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/market")>();
  return {
    ...actual,
    scanMarket: (...args: unknown[]) => mockScanMarket(...args)
  };
});

vi.mock("../src/lib/quotes-cascade", () => ({
  fetchFreshQuotesCascade: (...args: unknown[]) => mockFetchFreshQuotesCascade(...args)
}));

vi.mock("../src/lib/market-scan-freshness", () => ({
  newestPersistedMarketScan: (...args: unknown[]) => mockNewestPersisted(...args)
}));

import {
  STRATEGY_GATHER_TIMEOUT_MESSAGE,
  gatherStrategyMarket
} from "../src/lib/strategy-gather";

const WEIGHTS = {
  liquidity: 1,
  momentum: 1,
  value: 1,
  quality: 1,
  volatility: 1,
  sentiment: 1,
  positioning: 1,
  diversification: 1
} as ScoringWeights;

function liveScan(): MarketScan {
  return {
    source: "nasdaq-delayed-screener",
    generatedAt: "2026-08-21T19:00:00.000Z",
    scannedSymbols: 500,
    returnedQuotes: 500,
    topCandidates: [
      {
        symbol: "AAPL",
        price: 220,
        volume: 1_000_000,
        intradayChangePct: 1.2,
        positionMarketValue: 0,
        score: 70
      }
    ],
    sectorBySymbol: {},
    quotesBySymbol: { AAPL: { symbol: "AAPL", price: 220, score: 70 } },
    warnings: []
  };
}

function lastGoodScan(): MarketScan {
  return {
    source: "nasdaq-delayed-screener",
    generatedAt: "2026-08-20T20:16:11.801Z",
    scannedSymbols: 500,
    returnedQuotes: 500,
    topCandidates: [
      {
        symbol: "MSFT",
        price: 400,
        volume: 800_000,
        intradayChangePct: 0.4,
        positionMarketValue: 0,
        score: 65
      }
    ],
    sectorBySymbol: {},
    quotesBySymbol: { MSFT: { symbol: "MSFT", price: 400, score: 65 } },
    warnings: []
  };
}

function gatherArgs() {
  return {
    allowedSymbols: ["AAPL", "MSFT"],
    positions: [],
    scanWeights: WEIGHTS,
    userId: "local",
    dynamicUniverses: [],
    connectedAccountId: "roth-1",
    accountNumber: "294709855",
    deadlineMs: 100,
    quoteFallbackMs: 50
  };
}

describe("gatherStrategyMarket", () => {
  beforeEach(() => {
    mockScanMarket.mockReset();
    mockFetchFreshQuotesCascade.mockReset();
    mockNewestPersisted.mockReset();
    mockNewestPersisted.mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the live scan when gather finishes inside the deadline", async () => {
    const scanned = liveScan();
    mockScanMarket.mockResolvedValue(scanned);
    mockFetchFreshQuotesCascade.mockResolvedValue({
      AAPL: { symbol: "AAPL", price: 221, asOf: "2026-08-21T19:00:10.000Z", provider: "alpaca" }
    });

    const result = await gatherStrategyMarket(gatherArgs());

    expect(result.usedLastGood).toBe(false);
    expect(result.baseMarketScan).toBe(scanned);
    expect(result.marketScan.topCandidates[0]?.price).toBe(221);
    expect(mockNewestPersisted).not.toHaveBeenCalled();
    const scanOptions = mockScanMarket.mock.calls[0]?.[5] as { deadlineAt?: number; signal?: AbortSignal };
    expect(typeof scanOptions.deadlineAt).toBe("number");
    expect(scanOptions.deadlineAt).toBeGreaterThan(Date.now() - 1_000);
  });

  it("aborts the in-flight scan when the deadline wins", async () => {
    vi.useFakeTimers();
    let seen: AbortSignal | undefined;
    mockScanMarket.mockImplementation(
      (_symbols: unknown, _positions: unknown, _weights: unknown, _userId: unknown, _universes: unknown, options: { signal?: AbortSignal }) => {
        seen = options.signal;
        return new Promise(() => undefined);
      }
    );

    const pending = gatherStrategyMarket(gatherArgs());
    pending.catch(() => undefined);
    expect(seen?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(100);

    await expect(pending).rejects.toThrow(STRATEGY_GATHER_TIMEOUT_MESSAGE);
    expect(seen?.aborted).toBe(true);
    expect((seen?.reason as Error)?.message).toBe(STRATEGY_GATHER_TIMEOUT_MESSAGE);
  });

  it("uses the last completed tape so Green can start after a gather timeout", async () => {
    vi.useFakeTimers();
    const seed = lastGoodScan();
    mockScanMarket.mockImplementation(
      (_symbols: unknown, _positions: unknown, _weights: unknown, _userId: unknown, _universes: unknown, options: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          options.signal?.addEventListener("abort", () => {
            reject(options.signal?.reason ?? new Error("aborted"));
          });
        })
    );
    mockNewestPersisted.mockReturnValue({
      scan: seed,
      entry: { id: "audit-1", createdAt: seed.generatedAt }
    });
    mockFetchFreshQuotesCascade.mockResolvedValue({
      MSFT: { symbol: "MSFT", price: 402, asOf: "2026-08-21T19:08:00.000Z", provider: "alpaca" }
    });

    const pending = gatherStrategyMarket(gatherArgs());
    await vi.advanceTimersByTimeAsync(100);
    const result = await pending;

    expect(result.usedLastGood).toBe(true);
    expect(result.lastGoodAt).toBe(seed.generatedAt);
    expect(result.marketScan.topCandidates[0]?.symbol).toBe("MSFT");
    expect(result.marketScan.topCandidates[0]?.price).toBe(402);
    expect(result.marketScan.warnings.some((warning) => warning.includes("last completed scan"))).toBe(true);
    expect(mockNewestPersisted).toHaveBeenCalledWith("local", "roth-1");
  });

  // Regression for the prod crash "k.warnings is not iterable": `withLastGoodWarning` used to
  // spread `...scan.warnings` unconditionally. A `strategy_run` audit's marketScan is a bounded
  // `{ omitted: true, ... }` summary with NO `warnings` field (audit-bounded-run.ts) — before
  // market-scan-freshness.ts's `extractScan` validated/normalized this, `newestPersistedMarketScan`
  // could hand back exactly that shape, and the spread threw. Defends the spread site directly
  // (belt-and-suspenders with the extractScan-level fix) regardless of what the mocked/real
  // `newestPersistedMarketScan` returns.
  it("does not throw when the last-good scan is missing `warnings` — defaults to [] and still appends the fallback note", async () => {
    vi.useFakeTimers();
    const seed = lastGoodScan();
    const { warnings: _omit, ...seedWithoutWarnings } = seed;
    mockScanMarket.mockImplementation(
      (_symbols: unknown, _positions: unknown, _weights: unknown, _userId: unknown, _universes: unknown, options: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          options.signal?.addEventListener("abort", () => {
            reject(options.signal?.reason ?? new Error("aborted"));
          });
        })
    );
    mockNewestPersisted.mockReturnValue({
      scan: seedWithoutWarnings as unknown as MarketScan,
      entry: { id: "audit-2", createdAt: seed.generatedAt }
    });
    mockFetchFreshQuotesCascade.mockResolvedValue({
      MSFT: { symbol: "MSFT", price: 402, asOf: "2026-08-21T19:08:00.000Z", provider: "alpaca" }
    });

    const pending = gatherStrategyMarket(gatherArgs());
    await vi.advanceTimersByTimeAsync(100);
    const result = await pending;

    expect(result.usedLastGood).toBe(true);
    expect(Array.isArray(result.marketScan.warnings)).toBe(true);
    expect(result.marketScan.warnings.some((warning) => warning.includes("last completed scan"))).toBe(true);
  });

  it("still fails the run when gather times out and no last-good tape exists", async () => {
    vi.useFakeTimers();
    mockScanMarket.mockImplementation(() => new Promise(() => undefined));
    mockNewestPersisted.mockReturnValue(undefined);

    const pending = gatherStrategyMarket(gatherArgs());
    pending.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(100);

    await expect(pending).rejects.toThrow(STRATEGY_GATHER_TIMEOUT_MESSAGE);
  });
});
