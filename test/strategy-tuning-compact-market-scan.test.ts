// Regression coverage for compactMarketScan's shape guard (src/lib/strategy-tuning.ts).
//
// proposeStrategyTuning reads `latestDecision.marketScan` from an UNCHECKED cast of a
// `strategy_run` audit payload (`.payload as LatestDecisionPayload`). Since 2026-08-01
// (audit-bounded-run.ts), every `strategy_run` row stores its marketScan as a bounded
// `{ omitted: true, source, generatedAt, scannedSymbols, returnedQuotes, candidateCount,
// topSymbols }` summary rather than the full MarketScan — it has no `topCandidates` array and no
// `warnings` array. Before this fix, `compactMarketScan` trusted the static `MarketScan` type and
// crashed on `scan.topCandidates.slice(10)` the first time a tuning-context build read a real
// persisted `strategy_run` row — the same failure class as the "k.warnings is not iterable" crash
// in strategy-gather.ts / market-scan-freshness.ts (see docs/rollouts/2026-09-24-st-rotation-warnings.md).
import { describe, expect, it } from "vitest";
import { compactMarketScan } from "../src/lib/strategy-tuning";
import type { MarketScan } from "../src/lib/types";

function fullScan(): MarketScan {
  return {
    source: "nasdaq-delayed-screener",
    generatedAt: "2026-09-20T19:00:00.000Z",
    scannedSymbols: 500,
    returnedQuotes: 480,
    topCandidates: [
      { symbol: "AAPL", price: 220, volume: 1_000_000, intradayChangePct: 1.2, positionMarketValue: 0, score: 70 }
    ],
    sectorBySymbol: { AAPL: "Technology" },
    quotesBySymbol: { AAPL: { symbol: "AAPL", price: 220, score: 70 } },
    warnings: ["one warning"]
  };
}

describe("compactMarketScan", () => {
  it("compacts a real, full MarketScan normally", () => {
    const compact = compactMarketScan(fullScan());
    expect(compact?.source).toBe("nasdaq-delayed-screener");
    expect(compact?.topCandidates).toHaveLength(1);
    expect(compact?.topCandidates[0]?.symbol).toBe("AAPL");
    expect(compact?.warnings).toEqual(["one warning"]);
  });

  it("returns undefined for undefined input", () => {
    expect(compactMarketScan(undefined)).toBeUndefined();
  });

  // The exact real persisted shape: audit-bounded-run.ts's BoundedMarketScanSummary, mistaken for
  // a MarketScan via `latestDecision.marketScan`'s unchecked cast.
  it("returns undefined (never throws) for a bounded-summary marketScan (omitted:true, no topCandidates)", () => {
    const bounded = {
      omitted: true,
      source: "nasdaq-delayed-screener",
      generatedAt: "2026-09-20T19:00:00.000Z",
      scannedSymbols: 500,
      returnedQuotes: 480,
      candidateCount: 12,
      topSymbols: ["AAPL", "MSFT"]
      // No topCandidates, warnings, sectorBySymbol, or quotesBySymbol.
    } as unknown as MarketScan;
    expect(() => compactMarketScan(bounded)).not.toThrow();
    expect(compactMarketScan(bounded)).toBeUndefined();
  });

  it("defaults a missing `warnings` array to [] instead of throwing on the topCandidates path", () => {
    const { warnings: _omit, ...withoutWarnings } = fullScan();
    const compact = compactMarketScan(withoutWarnings as unknown as MarketScan);
    expect(compact?.warnings).toEqual([]);
    expect(compact?.topCandidates).toHaveLength(1);
  });
});
