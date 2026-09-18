/**
 * 2026-09-18 LLM-context audit — money-path prompt wiring for live VIX + macro trends.
 *
 * Full runStrategyOnce integration for this seam segfaults in some agent boxes on strategy.ts
 * import (same class of failure as economic-calendar-prompt-wiring here). Source + pure helper
 * asserts cover the contract; CI still runs the heavier suites.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compactMacroTrendsForPrompt } from "../src/lib/macro-history";
import { pruneMacro, type MacroData } from "../src/lib/macro";
import { projectRedTeamReviewContext, RED_TEAM_REVIEW_CONTEXT_KEYS } from "../src/lib/red-team";

describe("strategy.ts live VIX + macroTrends prompt wiring (2026-09-18 audit)", () => {
  it("source: proposeTrades money path uses fetchMacroDataWithLiveVix and injects macroTrends", () => {
    const src = readFileSync(join(process.cwd(), "src/lib/strategy.ts"), "utf8");
    // Pin the proposeTrades block (comment + call) so other fetchMacroData sites do not satisfy this.
    expect(src).toMatch(
      /Live VIX overlay[\s\S]*?fetchMacroDataWithLiveVix\(input\.userId\)\.catch\(\(\) => undefined\)/
    );
    expect(src).toMatch(
      /const macro: MacroData & \{ vixAsOf\?: string \} = liveMacro \?\? \(await fetchMacroData\(input\.userId\)\);/
    );
    expect(src).toMatch(/fetchMacroHistory\(Date\.now\(\), input\.userId\)/);
    expect(src).toMatch(/compactMacroTrendsForPrompt/);
    expect(src).toMatch(/\.\.\.\(macroTrends \? \{ macroTrends \} : \{\}\)/);
    expect(src).toMatch(/vixAsOf: macro\.vixAsOf/);
  });

  it("prompt-shaped macro + trends project into Red's widened allowlist", () => {
    const current = {
      fedFundsRate: "5.25%",
      dgs3moTreasury: "5.10%",
      dgs2Treasury: "4.60%",
      dgs10Treasury: "4.20%",
      inflationExpectation10y: "2.30%",
      cpiInflation: "3.10%",
      corePCE: "2.80%",
      realGDPGrowth: "2.00%",
      unemploymentRate: "3.90%",
      initialClaims: "220K",
      m2MoneySupply: "20.8T",
      m2GrowthYoY: "2.50%",
      hyCreditSpread: "3.20%",
      usdIndex: "121.00",
      wtiOil: "$75.00",
      housingStarts: "1.3M",
      consumerSentiment: "75.0",
      nonfarmPayrollsChangeK: "+180K",
      vix: "22.50",
      vix3m: "24.00",
      asOf: "2026-09-17"
    } satisfies MacroData;
    const previous: MacroData = { ...current, cpiInflation: "3.00%", asOf: "2026-09-16" };
    const { macro: macroForPrompt, omitted } = pruneMacro(current, previous);
    const vixAsOf = "2026-09-18T10:15:00.000Z";
    const macroeconomicData: Record<string, unknown> = {
      ...macroForPrompt,
      ...(omitted.length > 0 ? { unchangedSinceLastRun: omitted } : {}),
      vixAsOf
    };
    const ramp = (start: number, step: number, n: number) =>
      Array.from({ length: n }, (_, i) => start + i * step);
    const macroTrends = compactMacroTrendsForPrompt({
      vix: ramp(18, 0.1, 40),
      tenY: ramp(4.0, 0.01, 40),
      twoY: ramp(3.5, 0.01, 40),
      hyCreditSpread: ramp(3.0, 0.02, 40),
      usd: ramp(120, 0.05, 40),
      wti: ramp(70, 0.1, 40)
    });
    expect(macroeconomicData.vix).toBe("22.50");
    expect(macroeconomicData.hyCreditSpread).toBe("3.20%");
    expect(macroeconomicData.vix3m).toBe("24.00");
    expect(macroeconomicData.vixAsOf).toBe(vixAsOf);
    expect(macroTrends?.series.VIX?.spark).toMatch(/^[▁▂▃▄▅▆▇█]+$/);

    const green = {
      currentDate: "2026-09-18",
      currentMarketRegime: "Risk-Off (High Volatility)",
      macroeconomicData,
      macroDerived: { curve2s10s: -0.1 },
      macroTrends,
      marketSignals: { skew: 130 },
      eventMarkets: { series: ["FED"] },
      predictionMarketsMacro: { markets: ["x"] },
      upcomingEconomicEvents: { events: [] },
      evidenceManifest: { greenRedParityHash: "abc" }
    };
    const projected = projectRedTeamReviewContext(green) as Record<string, unknown>;
    for (const key of [
      "macroDerived",
      "macroTrends",
      "marketSignals",
      "eventMarkets",
      "predictionMarketsMacro",
      "upcomingEconomicEvents",
      "macroeconomicData"
    ] as const) {
      expect(RED_TEAM_REVIEW_CONTEXT_KEYS).toContain(key);
      expect(projected).toHaveProperty(key);
    }
    expect((projected.macroeconomicData as { vixAsOf?: string }).vixAsOf).toBe(vixAsOf);
  });
});
