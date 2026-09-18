/**
 * Compact macro HISTORY → Green/Red prompt block (2026-09-18 LLM-context audit).
 * Dashboard already consumed fetchMacroHistory; prompts only saw latest scalars.
 */
import { describe, expect, it } from "vitest";
import { compactMacroTrendsForPrompt, type MacroHistory } from "../src/lib/macro-history";

function ramp(start: number, step: number, n: number): number[] {
  return Array.from({ length: n }, (_, i) => start + i * step);
}

describe("compactMacroTrendsForPrompt", () => {
  it("emits labeled series with last, d7, d30, and a sparkline", () => {
    const history: MacroHistory = {
      vix: ramp(12, 0.2, 40),
      tenY: ramp(4.0, 0.01, 40),
      twoY: ramp(3.5, 0.01, 40),
      hyCreditSpread: ramp(3.0, 0.02, 40),
      usd: ramp(120, 0.05, 40),
      wti: ramp(70, 0.1, 40)
    };
    const block = compactMacroTrendsForPrompt(history);
    expect(block).toBeDefined();
    expect(block!.note).toMatch(/FRED/);
    expect(Object.keys(block!.series).sort()).toEqual(["10Y", "2Y", "HY", "USD", "VIX", "WTI"]);
    expect(block!.series.VIX!.last).toBeCloseTo(12 + 0.2 * 39, 5);
    expect(block!.series.VIX!.d7).toBeCloseTo(0.2 * 7, 5);
    expect(block!.series.VIX!.d30).toBeCloseTo(0.2 * 30, 5);
    expect(block!.series.VIX!.spark.length).toBe(20);
    expect(block!.series.VIX!.spark).toMatch(/^[▁▂▃▄▅▆▇█]+$/);
  });

  it("returns undefined when history is empty — omit the prompt block entirely", () => {
    expect(compactMacroTrendsForPrompt({})).toBeUndefined();
  });

  it("skips series that are too short or non-finite", () => {
    const block = compactMacroTrendsForPrompt({
      vix: [10, 11, 12], // < 5
      tenY: ramp(4, 0.01, 10),
      twoY: [NaN, NaN, NaN, NaN, NaN, NaN]
    });
    expect(block).toBeDefined();
    expect(block!.series.VIX).toBeUndefined();
    expect(block!.series["10Y"]).toBeDefined();
    expect(block!.series["2Y"]).toBeUndefined();
  });
});
