import { describe, expect, it } from "vitest";
import { applyEnrichment, hasNotableWebSignal, mergeGroupedBarData, mergeQuoteData, outlierInterestScore, rankMarketQuotes, scoreFactors } from "../src/lib/market";
import type { SymbolEnrichment } from "../src/lib/data-providers";
import type { MarketQuote, MarketScan } from "../src/lib/types";

describe("rankMarketQuotes", () => {
  it("prioritizes liquid positive movers without existing exposure", () => {
    const quotes: MarketQuote[] = [
      quote({ symbol: "AAPL", volume: 5_000_000, intradayChangePct: 1, positionMarketValue: 20 }),
      quote({ symbol: "MSFT", volume: 20_000_000, intradayChangePct: 2, positionMarketValue: 0 }),
      quote({ symbol: "XYZ", volume: 10_000, intradayChangePct: -3, positionMarketValue: 0 })
    ];

    expect(rankMarketQuotes(quotes).map((item) => item.symbol)).toEqual(["MSFT", "AAPL", "XYZ"]);
  });

  it("normalizes scoring weights into a transparent factor total", () => {
    const scored = scoreFactors(
      quote({ symbol: "MSFT", volume: 20_000_000, intradayChangePct: 2, positionMarketValue: 0 }),
      { liquidity: 1, momentum: 1, value: 0, quality: 0, volatility: 0, sentiment: 0, positioning: 0, diversification: 0 }
    );

    expect(scored.liquidity).toBeGreaterThan(0);
    expect(scored.momentum).toBeGreaterThan(50);
    expect(scored.weightedTotal).toBeGreaterThan(40);
    expect(scored.weightedTotal).toBeLessThanOrEqual(100);
  });

  it("rewards strong fundamentals in the value and quality sub-scores", () => {
    const common = { marketCap: 2_000_000_000, volume: 2_000_000, peRatio: 30 };
    const weak = scoreFactors(quote({ symbol: "W", ...common, fcfYield: -2, debtToEquity: 350, epsGrowth: -0.2 }));
    const strong = scoreFactors(quote({ symbol: "S", ...common, fcfYield: 8, debtToEquity: 30, epsGrowth: 0.25 }));
    expect(strong.value).toBeGreaterThan(weak.value); // FCF yield lifts value
    expect(strong.quality).toBeGreaterThan(weak.quality); // low leverage + EPS growth lift quality
  });

  it("treats a sec-xbrl D/E above 10 as a true ratio (penalized), not a percentage", () => {
    const common = { marketCap: 2_000_000_000, volume: 2_000_000 };
    // sec-xbrl always emits a true ratio: 12 = 12x leverage → penalized. The `>10 → ÷100` percentage
    // heuristic is source-aware, so it is NOT applied here (otherwise 12 would read as 0.12 and the
    // over-levered name would be wrongly REWARDED as near-debt-free).
    const levered = scoreFactors(quote({ symbol: "L", ...common, debtToEquity: 12, sources: { debtToEquity: "sec-xbrl" } }));
    const safe = scoreFactors(quote({ symbol: "S", ...common, debtToEquity: 0.3, sources: { debtToEquity: "sec-xbrl" } }));
    expect(levered.quality).toBeLessThan(safe.quality);
  });

  it("blends 52-week position into momentum and beta into volatility", () => {
    const nearHigh = scoreFactors(quote({ symbol: "H", intradayChangePct: 1, price: 99, fiftyTwoWeekLow: 50, fiftyTwoWeekHigh: 100 }));
    const nearLow = scoreFactors(quote({ symbol: "L", intradayChangePct: 1, price: 51, fiftyTwoWeekLow: 50, fiftyTwoWeekHigh: 100 }));
    expect(nearHigh.momentum).toBeGreaterThan(nearLow.momentum); // near the 52-week high = stronger momentum

    const highBeta = scoreFactors(quote({ symbol: "HB", intradayChangePct: 0, beta: 1.8 }));
    const lowBeta = scoreFactors(quote({ symbol: "LB", intradayChangePct: 0, beta: 0.6 }));
    expect(lowBeta.volatility).toBeGreaterThan(highBeta.volatility); // high beta scores as riskier (lower stability)
  });
});

describe("positioning sub-score", () => {
  it("lifts net congressional + insider buying and dings net selling", () => {
    const neutral = scoreFactors(quote({ symbol: "N" }));
    const buy = scoreFactors(quote({ symbol: "B", senateTrades: 3, insiderSentiment: 80 }));
    const sell = scoreFactors(quote({ symbol: "S", senateTrades: -2, insiderSentiment: 20 }));
    expect(buy.positioning).toBeGreaterThan(neutral.positioning);
    expect(sell.positioning).toBeLessThan(neutral.positioning);
    expect(neutral.positioning).toBe(50); // no signal => neutral
  });
});

describe("hasNotableWebSignal (event candidate union)", () => {
  it("flags net congressional buys (≥2 members, netSignal≥2), insider buying, and elevated short pressure", () => {
    // Congress: both buyCount AND netSignal must reach the floor.
    expect(hasNotableWebSignal({ congress: { netSignal: 2, buyCount: 2 } as never, bulletins: [] })).toBe(true);
    expect(hasNotableWebSignal({ congress: { netSignal: 3, buyCount: 4 } as never, bulletins: [] })).toBe(true);
    expect(hasNotableWebSignal({ insiderSentiment: 80, bulletins: [] })).toBe(true);
    expect(hasNotableWebSignal({ shortVolumeRatio: 62, bulletins: [] })).toBe(true);
  });
  it("does not flag thin congress signals (single member or netSignal < 2)", () => {
    // netSignal=1: only 1 more buyer than seller — not enough on its own
    expect(hasNotableWebSignal({ congress: { netSignal: 1, buyCount: 1 } as never, bulletins: [] })).toBe(false);
    // buyCount=1 even with netSignal=2 — single member, too thin
    expect(hasNotableWebSignal({ congress: { netSignal: 2, buyCount: 1 } as never, bulletins: [] })).toBe(false);
    // net selling
    expect(hasNotableWebSignal({ congress: { netSignal: -1, buyCount: 1 } as never, bulletins: [] })).toBe(false);
  });
  it("does not flag neutral insider, ordinary short volume, or undefined", () => {
    expect(hasNotableWebSignal({ insiderSentiment: 40, shortVolumeRatio: 45, bulletins: [] })).toBe(false);
    expect(hasNotableWebSignal(undefined)).toBe(false);
  });

  it("requires strong supported BUY analytics before promoting a Congress.Trade outlier", () => {
    expect(hasNotableWebSignal({
      bulletins: [],
      congressAnalytics: { convictionScore: 100, convictionDirection: "BUY", convictionFallback: true }
    })).toBe(false);
    expect(hasNotableWebSignal({
      bulletins: [],
      congressAnalytics: { convictionScore: 90, convictionDirection: "SELL", netFlowUsd: -1_000_000, memberCount: 3 }
    })).toBe(false);
    expect(hasNotableWebSignal({
      bulletins: [],
      congressAnalytics: { convictionScore: 85, convictionDirection: "BUY", netFlowUsd: 1_000_000, memberCount: 3, tradeCount: 4, cluster: true, topMemberScore: 90 }
    })).toBe(true);
  });

  it("scores stronger below-cutoff outlier signals ahead of weaker ones", () => {
    const thinInsider = outlierInterestScore({ insiderSentiment: 61, bulletins: [] });
    const broadCongressBuying = outlierInterestScore({ congress: { netSignal: 3, buyCount: 4 } as never, bulletins: [] });

    expect(thinInsider).toBeGreaterThan(0);
    expect(broadCongressBuying).toBeGreaterThan(thinInsider);
  });
});

describe("applyEnrichment", () => {
  it("folds every enriched field (incl. fcf/leverage/growth/congress) onto the quote", () => {
    // Regression: these four used to be dropped by the scan merge, so scoring/prompt/UI
    // never saw them even when a provider supplied real values.
    const extra: SymbolEnrichment = {
      fcfYield: 7.5,
      debtToEquity: 0.4,
      epsGrowth: 0.22,
      senateTrades: 3,
      insiderSentiment: 80,
      peRatio: 18,
      sector: "Technology",
      sources: { fcfYield: "yahoo-finance", senateTrades: "congress-trades" }
    };
    const enriched = applyEnrichment(quote({ symbol: "NVDA" }), extra);
    expect(enriched.fcfYield).toBe(7.5);
    expect(enriched.debtToEquity).toBe(0.4);
    expect(enriched.epsGrowth).toBe(0.22);
    expect(enriched.senateTrades).toBe(3);
    expect(enriched.insiderSentiment).toBe(80);
    expect(enriched.sources?.fcfYield).toBe("yahoo-finance");
    expect(enriched.sources?.senateTrades).toBe("congress-trades");
  });

  it("folds the newly arbitrated quote fields (bidSize/askSize/prevClose/OHLC/netChange) onto the quote", () => {
    // Codex P1 review on #3449: providers supply these, the cascade arbitrates
    // them, and applyEnrichment must carry them onto the MarketQuote.
    const extra: SymbolEnrichment = {
      bidSize: 100,
      askSize: 200,
      prevClose: 148,
      open: 149,
      high: 151,
      low: 147.5,
      netChange: 2.5
    };
    const enriched = applyEnrichment(quote({ symbol: "AAPL" }), extra);
    expect(enriched.bidSize).toBe(100);
    expect(enriched.askSize).toBe(200);
    expect(enriched.prevClose).toBe(148);
    expect(enriched.open).toBe(149);
    expect(enriched.high).toBe(151);
    expect(enriched.low).toBe(147.5);
    expect(enriched.netChange).toBe(2.5);
  });

  it("keeps the existing quote value when enrichment omits a field", () => {
    const enriched = applyEnrichment(quote({ symbol: "AAPL", senateTrades: 2 }), { peRatio: 30 });
    expect(enriched.senateTrades).toBe(2); // not clobbered by undefined
    expect(enriched.peRatio).toBe(30);
  });

  it("folds the new data-breadth fields (earnings, institution ownership, options IV) onto the quote", () => {
    const extra: SymbolEnrichment = {
      daysToEarnings: 8,
      institutionOwnershipPct: 61.5,
      nearTheMoneyIv: 34,
      putCallRatio: 0.9,
      sources: {
        daysToEarnings: "yahoo-finance",
        institutionOwnershipPct: "yahoo-finance",
        nearTheMoneyIv: "robinhood-options",
        putCallRatio: "robinhood-options"
      }
    };
    const enriched = applyEnrichment(quote({ symbol: "NVDA" }), extra);
    expect(enriched.daysToEarnings).toBe(8);
    expect(enriched.institutionOwnershipPct).toBe(61.5);
    expect(enriched.nearTheMoneyIv).toBe(34);
    expect(enriched.putCallRatio).toBe(0.9);
    expect(enriched.sources?.daysToEarnings).toBe("yahoo-finance");
    expect(enriched.sources?.nearTheMoneyIv).toBe("robinhood-options");
  });

  it("preserves cascade fieldObservations and providerFailures on the quote", () => {
    const extra: SymbolEnrichment = {
      peRatio: 22,
      sources: { peRatio: "yahoo-finance" },
      fieldObservations: {
        peRatio: {
          value: 22,
          source: "yahoo-finance",
          upstreamFamily: "yahoo-finance",
          fetchedAt: "2026-07-26T00:00:00.000Z",
          status: "ok"
        }
      },
      providerFailures: {
        finnhub: {
          source: "finnhub",
          upstreamFamily: "finnhub",
          fetchedAt: "2026-07-26T00:00:00.000Z",
          status: "failed",
          errorKind: "TimeoutError"
        }
      }
    };
    const enriched = applyEnrichment(quote({ symbol: "NVDA" }), extra);
    expect(enriched.fieldObservations?.peRatio?.source).toBe("yahoo-finance");
    expect(enriched.providerFailures?.finnhub?.errorKind).toBe("TimeoutError");
  });
});

describe("mergeQuoteData", () => {
  it("derives scan source attribution from the quote providers instead of hardcoding Robinhood", () => {
    const scan: MarketScan = {
      source: "nasdaq-delayed-screener",
      generatedAt: "2026-06-19T00:00:00.000Z",
      scannedSymbols: 1,
      returnedQuotes: 1,
      topCandidates: [quote({ symbol: "AAPL" })],
      sectorBySymbol: {},
      quotesBySymbol: { AAPL: quote({ symbol: "AAPL" }) },
      cacheTtlMs: 300_000,
      cached: false,
      warnings: []
    };

    const merged = mergeQuoteData(scan, {
      AAPL: { price: 101, bid: 100.9, ask: 101.1, provider: "alpaca", asOf: "2026-06-19T14:00:00.000Z" }
    });

    expect(merged.source).toBe("nasdaq-delayed-screener+alpaca-quotes");
    expect(merged.topCandidates[0]).toMatchObject({ price: 101, provider: "alpaca" });
  });

  it("does not duplicate quote provider sources when quote data is merged again", () => {
    const scan: MarketScan = {
      source: "nasdaq-delayed-screener+alpaca-quotes",
      generatedAt: "2026-06-19T00:00:00.000Z",
      scannedSymbols: 1,
      returnedQuotes: 1,
      topCandidates: [quote({ symbol: "AAPL", provider: "alpaca" })],
      sectorBySymbol: {},
      quotesBySymbol: { AAPL: quote({ symbol: "AAPL", provider: "alpaca" }) },
      cacheTtlMs: 300_000,
      cached: false,
      warnings: []
    };

    const merged = mergeQuoteData(scan, {
      AAPL: { price: 101, bid: 100.9, ask: 101.1, provider: "alpaca", asOf: "2026-06-19T14:00:00.000Z" }
    });

    expect(merged.source).toBe("nasdaq-delayed-screener+alpaca-quotes");
  });

  it("refreshes synthetic bid/ask provenance when a real broker spread is merged in", () => {
    const synthetic = () =>
      quote({
        symbol: "AAPL",
        bid: 99.9,
        ask: 100.1,
        sources: { price: "yahoo-finance", bid: "yahoo-finance-synthetic", ask: "yahoo-finance-synthetic" }
      });
    const scan: MarketScan = {
      source: "nasdaq-delayed-screener",
      generatedAt: "2026-06-19T00:00:00.000Z",
      scannedSymbols: 1,
      returnedQuotes: 1,
      topCandidates: [synthetic()],
      sectorBySymbol: {},
      quotesBySymbol: { AAPL: synthetic() },
      cacheTtlMs: 300_000,
      cached: false,
      warnings: []
    };

    const merged = mergeQuoteData(scan, {
      AAPL: { price: 101, bid: 100.9, ask: 101.1, provider: "alpaca", asOf: "2026-06-19T14:00:00.000Z" }
    });

    // A real broker spread replaces the synthetic values AND their provenance — on both the ranked
    // candidate and the quotesBySymbol entry the marketable-limit calc reads — so a real ask is no
    // longer mistaken for synthetic and does not fall back to refPrice.
    expect(merged.topCandidates[0]!.ask).toBe(101.1);
    expect(merged.topCandidates[0]!.sources?.ask).toBe("alpaca");
    expect(merged.topCandidates[0]!.sources?.bid).toBe("alpaca");
    expect(merged.quotesBySymbol.AAPL!.sources?.ask).toBe("alpaca");
    expect(merged.quotesBySymbol.AAPL!.sources?.bid).toBe("alpaca");
  });

  it("keeps synthetic provenance when a Test-mode synthetic Yahoo batch spread is merged", () => {
    const withRealScreenerSource = () => quote({ symbol: "AAPL", sources: { price: "yahoo-finance" } });
    const scan: MarketScan = {
      source: "nasdaq-delayed-screener",
      generatedAt: "2026-06-19T00:00:00.000Z",
      scannedSymbols: 1,
      returnedQuotes: 1,
      topCandidates: [withRealScreenerSource()],
      sectorBySymbol: {},
      quotesBySymbol: { AAPL: withRealScreenerSource() },
      cacheTtlMs: 300_000,
      cached: false,
      warnings: []
    };

    // TestBrokerGateway returns a Yahoo BATCH quote whose bid/ask were synthesized from price.
    const merged = mergeQuoteData(scan, {
      AAPL: { price: 100, bid: 99.9, ask: 100.1, provider: "yahoo-finance", syntheticSpread: true }
    });

    // The synthetic spread must NOT be relabeled as a real quoted spread — otherwise hasRealAsk /
    // marketable-limit pricing would treat a price-derived ask as real in the default Test mode.
    expect(merged.topCandidates[0]!.sources?.ask).toBe("yahoo-finance-synthetic");
    expect(merged.topCandidates[0]!.sources?.bid).toBe("yahoo-finance-synthetic");
    expect(merged.quotesBySymbol.AAPL!.sources?.ask).toBe("yahoo-finance-synthetic");
    expect(merged.quotesBySymbol.AAPL!.sources?.bid).toBe("yahoo-finance-synthetic");
  });

  it("preserves the REAL side of a one-sided quote (real bid, synthetic ask)", () => {
    const withRealScreenerSource = () => quote({ symbol: "AAPL", sources: { price: "yahoo-finance" } });
    const scan: MarketScan = {
      source: "nasdaq-delayed-screener",
      generatedAt: "2026-06-19T00:00:00.000Z",
      scannedSymbols: 1,
      returnedQuotes: 1,
      topCandidates: [withRealScreenerSource()],
      sectorBySymbol: {},
      quotesBySymbol: { AAPL: withRealScreenerSource() },
      cacheTtlMs: 300_000,
      cached: false,
      warnings: []
    };

    // Yahoo reported a real bid but no ask, so only the ask was derived from price.
    const merged = mergeQuoteData(scan, {
      AAPL: { price: 100, bid: 99.9, ask: 100.1, provider: "yahoo-finance", syntheticAsk: true }
    });

    // The real bid keeps the actual provider; only the synthetic ask is tagged synthetic.
    expect(merged.topCandidates[0]!.sources?.bid).toBe("yahoo-finance");
    expect(merged.topCandidates[0]!.sources?.ask).toBe("yahoo-finance-synthetic");
    expect(merged.quotesBySymbol.AAPL!.sources?.bid).toBe("yahoo-finance");
    expect(merged.quotesBySymbol.AAPL!.sources?.ask).toBe("yahoo-finance-synthetic");
  });

  it("attributes a merged broker price to the broker provider (both tiers)", () => {
    const screenerPriced = () => quote({ symbol: "AAPL", sources: { price: "yahoo-finance" } });
    const scan: MarketScan = {
      source: "nasdaq-delayed-screener",
      generatedAt: "2026-06-19T00:00:00.000Z",
      scannedSymbols: 1,
      returnedQuotes: 1,
      topCandidates: [screenerPriced()],
      sectorBySymbol: {},
      quotesBySymbol: { AAPL: screenerPriced() },
      cacheTtlMs: 300_000,
      cached: false,
      warnings: []
    };

    // A live broker quote replaces `price`; sources.price must follow the value to the broker so the
    // drilldown/table price tooltip attributes the shown number correctly (it previously kept the
    // stale screener source).
    const merged = mergeQuoteData(scan, {
      AAPL: { price: 101, bid: 100.9, ask: 101.1, provider: "alpaca", asOf: "2026-06-19T14:00:00.000Z" }
    });

    expect(merged.topCandidates[0]!.price).toBe(101);
    expect(merged.topCandidates[0]!.sources?.price).toBe("alpaca");
    expect(merged.quotesBySymbol.AAPL!.sources?.price).toBe("alpaca");
  });

  it("attributes the real price provider even when the merged SPREAD is synthetic", () => {
    const screenerPriced = () => quote({ symbol: "AAPL", sources: { price: "nasdaq-delayed-screener" } });
    const scan: MarketScan = {
      source: "nasdaq-delayed-screener",
      generatedAt: "2026-06-19T00:00:00.000Z",
      scannedSymbols: 1,
      returnedQuotes: 1,
      topCandidates: [screenerPriced()],
      sectorBySymbol: {},
      quotesBySymbol: { AAPL: screenerPriced() },
      cacheTtlMs: 300_000,
      cached: false,
      warnings: []
    };

    // Yahoo batch quote: a REAL last price with a price-DERIVED (synthetic) spread. The synthetic
    // flags describe the derived bid/ask only — the price itself is real, so it takes the actual
    // provider while bid/ask stay tagged synthetic.
    const merged = mergeQuoteData(scan, {
      AAPL: { price: 100, bid: 99.9, ask: 100.1, provider: "yahoo-finance", syntheticSpread: true }
    });

    expect(merged.topCandidates[0]!.sources?.price).toBe("yahoo-finance");
    expect(merged.topCandidates[0]!.sources?.bid).toBe("yahoo-finance-synthetic");
    expect(merged.topCandidates[0]!.sources?.ask).toBe("yahoo-finance-synthetic");
    expect(merged.quotesBySymbol.AAPL!.sources?.price).toBe("yahoo-finance");
  });

  it("recalculates intradayChangePct and netChange when fresh quote and prevClose are merged", () => {
    const scan: MarketScan = {
      source: "nasdaq-delayed-screener",
      generatedAt: "2026-06-19T00:00:00.000Z",
      scannedSymbols: 1,
      returnedQuotes: 1,
      topCandidates: [quote({ symbol: "AAPL", price: 100, intradayChangePct: 0, netChange: 0 })],
      sectorBySymbol: {},
      quotesBySymbol: { AAPL: quote({ symbol: "AAPL", price: 100, intradayChangePct: 0, netChange: 0 }) },
      cacheTtlMs: 300_000,
      cached: false,
      warnings: []
    };

    const merged = mergeQuoteData(scan, {
      AAPL: {
        price: 105,
        prevClose: 100,
        open: 101,
        high: 106,
        low: 100.5,
        vwap: 103.5,
        companyName: "Apple Inc.",
        provider: "alpaca"
      }
    });

    const cand = merged.topCandidates[0];
    expect(cand.price).toBe(105);
    expect(cand.prevClose).toBe(100);
    expect(cand.intradayChangePct).toBe(5.0);
    expect(cand.netChange).toBe(5.0);
    expect(cand.open).toBe(101);
    expect(cand.high).toBe(106);
    expect(cand.low).toBe(100.5);
    expect(cand.vwap).toBe(103.5);
    expect(cand.companyName).toBe("Apple Inc.");

    const summary = merged.quotesBySymbol.AAPL;
    expect(summary.intradayChangePct).toBe(5.0);
    expect(summary.netChange).toBe(5.0);
    expect(summary.prevClose).toBe(100);
    expect(summary.open).toBe(101);
    expect(summary.high).toBe(106);
    expect(summary.low).toBe(100.5);
    expect(summary.vwap).toBe(103.5);
    expect(summary.companyName).toBe("Apple Inc.");
  });

  it("populates newly discovered symbols from quoteData with full quote metrics", () => {
    const scan: MarketScan = {
      source: "nasdaq-delayed-screener",
      generatedAt: "2026-06-19T00:00:00.000Z",
      scannedSymbols: 1,
      returnedQuotes: 1,
      topCandidates: [quote({ symbol: "AAPL" })],
      sectorBySymbol: {},
      quotesBySymbol: { AAPL: quote({ symbol: "AAPL" }) },
      cacheTtlMs: 300_000,
      cached: false,
      warnings: []
    };

    const merged = mergeQuoteData(scan, {
      MSFT: {
        symbol: "MSFT",
        price: 300,
        prevClose: 295,
        open: 296,
        high: 302,
        low: 294,
        vwap: 298.5,
        companyName: "Microsoft Corp",
        provider: "finnhub"
      }
    });

    expect(merged.quotesBySymbol.MSFT).toBeDefined();
    const msft = merged.quotesBySymbol.MSFT;
    expect(msft.price).toBe(300);
    expect(msft.prevClose).toBe(295);
    expect(msft.open).toBe(296);
    expect(msft.high).toBe(302);
    expect(msft.low).toBe(294);
    expect(msft.vwap).toBe(298.5);
    expect(msft.companyName).toBe("Microsoft Corp");
    expect(msft.intradayChangePct).toBe(1.69);
    expect(msft.netChange).toBe(5);
  });
});

describe("mergeGroupedBarData", () => {
  it("adds source-provided VWAP to scan rows and summaries", () => {
    const scan: MarketScan = {
      source: "nasdaq-delayed-screener",
      generatedAt: "2026-06-19T00:00:00.000Z",
      scannedSymbols: 2,
      returnedQuotes: 2,
      topCandidates: [quote({ symbol: "AAPL" }), quote({ symbol: "MSFT" })],
      sectorBySymbol: {},
      quotesBySymbol: {
        AAPL: quote({ symbol: "AAPL" }),
        MSFT: quote({ symbol: "MSFT" })
      },
      cacheTtlMs: 300_000,
      cached: false,
      warnings: []
    };

    const merged = mergeGroupedBarData(scan, [
      { ticker: "AAPL", close: 100, vwap: 98.5 },
      { ticker: "MSFT", close: 100 }
    ]);

    expect(merged.source).toBe("nasdaq-delayed-screener+massive-vwap");
    expect(merged.topCandidates[0]).toMatchObject({ symbol: "AAPL", vwap: 98.5, sources: { vwap: "massive-vwap" } });
    expect(merged.topCandidates[1].vwap).toBeUndefined();
    expect(merged.quotesBySymbol.AAPL).toMatchObject({ vwap: 98.5, sources: { vwap: "massive-vwap" } });
  });
});

function quote(input: Partial<MarketQuote> & { symbol: string }): MarketQuote {
  return {
    price: 100,
    volume: 1,
    intradayChangePct: 0,
    positionMarketValue: 0,
    score: 0,
    ...input
  };
}
