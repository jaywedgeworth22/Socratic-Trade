import { describe, expect, it } from "vitest";
import { determineMarketRegime, evaluateVolatilityBrake, MARKET_REGIME_LABELS, pruneMacro } from "../src/lib/macro";
import type { MacroData } from "../src/lib/macro";

const base: MacroData = {
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
  vix: "15.00",
  vix3m: "17.00",
  asOf: "2026-06-16"
};

describe("determineMarketRegime", () => {
  it("uses VIX for the primary volatility tier", () => {
    expect(determineMarketRegime({ ...base, vix: "35" })).toContain("Crisis");
    expect(determineMarketRegime({ ...base, vix: "24" })).toContain("Risk-Off");
    expect(determineMarketRegime({ ...base, vix: "11", fedFundsRate: "2.00%", dgs10Treasury: "4.00%" })).toContain("Risk-On");
    expect(determineMarketRegime({ ...base, vix: "16", fedFundsRate: "2.00%", dgs10Treasury: "4.00%" })).toContain("Neutral");
  });

  it("lets an inverted yield curve actually influence the regime (rates now matter)", () => {
    // Calm VIX but inverted curve (10y < fed funds) -> Cautious, not Risk-On.
    expect(determineMarketRegime({ ...base, vix: "12", fedFundsRate: "5.25%", dgs10Treasury: "4.20%" })).toContain("Cautious");
    // Borderline VIX + inversion tips into Risk-Off.
    expect(determineMarketRegime({ ...base, vix: "18", fedFundsRate: "5.25%", dgs10Treasury: "4.20%" })).toContain("Risk-Off");
  });
});

/** The VIX-only fallback shape: live VIX + real asOf, every FRED field blanked to "". */
function vixOnlyMacro(vix: string): MacroData {
  return {
    ...Object.fromEntries(Object.keys(base).map((k) => [k, ""])) as unknown as MacroData,
    vix,
    asOf: "2026-06-21",
    fredSourced: false
  };
}

describe("determineMarketRegime — VIX fallback light-macro", () => {
  it("returns a real regime when asOf is a date (VIX light-macro path)", () => {
    // When fetchVixFromYahoo succeeds, asOf is today's date (not 'unavailable').
    // The regime should be derived from the live VIX.
    const lightMacro: MacroData = { ...base, vix: "28.50", asOf: "2026-06-21" };
    expect(determineMarketRegime(lightMacro)).toBe("Risk-Off (High Volatility)");
  });

  it("VIX-only fallback shape (blank FRED fields) is never distorted by a fabricated inverted curve", () => {
    // The old DEFAULT_MACRO placeholders carried fedFunds 5.25% vs 10Y 4.20% — a hardcoded
    // INVERTED curve that pushed calm markets to "Cautious" and borderline ones to "Risk-Off".
    // Blank FRED fields parse to NaN, so the curve simply doesn't participate.
    expect(determineMarketRegime(vixOnlyMacro("12.00"))).toBe("Risk-On (Low Volatility)");
    expect(determineMarketRegime(vixOnlyMacro("18.00"))).toBe("Neutral (Normal Volatility)");
    expect(determineMarketRegime(vixOnlyMacro("24.00"))).toBe("Risk-Off (High Volatility)");
    expect(determineMarketRegime(vixOnlyMacro("35.00"))).toBe("Crisis (Extreme Volatility)");
  });

  it("returns Unknown when asOf is 'unavailable' (no FRED key AND VIX fetch failed)", () => {
    const noMacro: MacroData = { ...base, asOf: "unavailable" };
    expect(determineMarketRegime(noMacro)).toBe("Unknown (no macro feed)");
  });
});

// The six regime labels below are a PERSISTED CONTRACT: determineMarketRegime's output is
// stamped verbatim into TradeProposal.entryMarketRegime and later joined on by exact string
// equality (src/lib/strategy.ts's selectThesisStat, src/lib/performance.ts's
// getFactorScorecard regime filter, and the regime-scorecard lookup in
// app/console/macro/page.tsx). Renaming a label here is NOT a safe find/replace — it silently
// orphans every already-persisted proposal/fill row still carrying the old string. A rename
// requires either a one-time data migration that rewrites entryMarketRegime on existing rows,
// or an old-label -> new-label alias map consulted at every join site. These toBe() assertions
// (not toContain()) exist so a label edit fails CI loudly instead of quietly breaking historical
// joins.
describe("determineMarketRegime — regime label set is a persisted contract", () => {
  it("vix > 30 -> Crisis (Extreme Volatility)", () => {
    expect(determineMarketRegime({ ...base, vix: "35.00" })).toBe(MARKET_REGIME_LABELS.crisis);
    expect(MARKET_REGIME_LABELS.crisis).toBe("Crisis (Extreme Volatility)");
  });

  it("vix > 20 -> Risk-Off (High Volatility)", () => {
    expect(determineMarketRegime({ ...base, vix: "24.00", fedFundsRate: "2.00%", dgs10Treasury: "4.00%" })).toBe(
      MARKET_REGIME_LABELS["risk-off"]
    );
    expect(MARKET_REGIME_LABELS["risk-off"]).toBe("Risk-Off (High Volatility)");
  });

  it("inverted curve && vix > 17 -> Risk-Off (High Volatility)", () => {
    // Calm-ish VIX (17 < vix <= 20) that would otherwise read Neutral, tipped by inversion.
    expect(determineMarketRegime({ ...base, vix: "18.00", fedFundsRate: "5.25%", dgs10Treasury: "4.20%" })).toBe(
      MARKET_REGIME_LABELS["risk-off"]
    );
  });

  it("vix < 13 && !inverted -> Risk-On (Low Volatility)", () => {
    expect(determineMarketRegime({ ...base, vix: "11.00", fedFundsRate: "2.00%", dgs10Treasury: "4.00%" })).toBe(
      MARKET_REGIME_LABELS["risk-on"]
    );
    expect(MARKET_REGIME_LABELS["risk-on"]).toBe("Risk-On (Low Volatility)");
  });

  it("neutral (calm VIX, no inversion) -> Neutral (Normal Volatility)", () => {
    expect(determineMarketRegime({ ...base, vix: "16.00", fedFundsRate: "2.00%", dgs10Treasury: "4.00%" })).toBe(
      MARKET_REGIME_LABELS.neutral
    );
    expect(MARKET_REGIME_LABELS.neutral).toBe("Neutral (Normal Volatility)");
  });

  it("inverted-calm (inverted curve, VIX not high enough to escalate) -> Cautious (Inverted Curve)", () => {
    expect(determineMarketRegime({ ...base, vix: "12.00", fedFundsRate: "5.25%", dgs10Treasury: "4.20%" })).toBe(
      MARKET_REGIME_LABELS["cautious-inverted"]
    );
    expect(MARKET_REGIME_LABELS["cautious-inverted"]).toBe("Cautious (Inverted Curve)");
  });

  it("asOf === 'unavailable' -> Unknown (no macro feed)", () => {
    expect(determineMarketRegime({ ...base, asOf: "unavailable" })).toBe(MARKET_REGIME_LABELS.unknown);
    expect(MARKET_REGIME_LABELS.unknown).toBe("Unknown (no macro feed)");
  });
});

describe("evaluateVolatilityBrake", () => {
  const calm = { ...base, vix: "15.00" };
  it("does not brake in calm conditions", () => {
    const r = evaluateVolatilityBrake(calm, { vvix: 90, skew: 120 }, { volPanicBrakeEnabled: true });
    expect(r.brake).toBe(false);
  });

  it("brakes on an extreme VIX tail", () => {
    const r = evaluateVolatilityBrake({ ...base, vix: "42" }, undefined, { volPanicBrakeEnabled: true });
    expect(r.brake).toBe(true);
    expect(r.reason).toContain("VIX");
  });

  it("brakes on VVIX or SKEW even when VIX is calm", () => {
    expect(evaluateVolatilityBrake(calm, { vvix: 160 }, { volPanicBrakeEnabled: true }).brake).toBe(true);
    expect(evaluateVolatilityBrake(calm, { skew: 165 }, { volPanicBrakeEnabled: true }).brake).toBe(true);
  });

  it("respects custom thresholds", () => {
    expect(evaluateVolatilityBrake({ ...base, vix: "28" }, undefined, { volPanicBrakeEnabled: true, volPanicVixThreshold: 25 }).brake).toBe(true);
    expect(evaluateVolatilityBrake({ ...base, vix: "28" }, undefined, { volPanicBrakeEnabled: true, volPanicVixThreshold: 40 }).brake).toBe(false);
  });

  it("is disabled when volPanicBrakeEnabled === false", () => {
    expect(evaluateVolatilityBrake({ ...base, vix: "99" }, { vvix: 999, skew: 999 }, { volPanicBrakeEnabled: false }).brake).toBe(false);
  });

  it("never trips on unavailable macro or missing gauges (no false-trip on partial data)", () => {
    expect(evaluateVolatilityBrake({ ...base, asOf: "unavailable", vix: "99" }, undefined, { volPanicBrakeEnabled: true }).brake).toBe(false);
    expect(evaluateVolatilityBrake(undefined, undefined, { volPanicBrakeEnabled: true }).brake).toBe(false);
  });
});

describe("pruneMacro", () => {
  it("sends every field on the first run (no previous snapshot)", () => {
    const { macro, omitted } = pruneMacro(base);
    expect(omitted).toEqual([]);
    expect(Object.keys(macro).sort()).toEqual(Object.keys(base).sort());
  });

  it("omits unchanged slow-moving fields but keeps regime-critical ones", () => {
    const next: MacroData = { ...base, cpiInflation: "3.40%", asOf: "2026-06-17" };
    const { macro, omitted } = pruneMacro(next, base);

    // Changed field is included.
    expect(macro.cpiInflation).toBe("3.40%");
    // Regime-critical fields are always included even when unchanged.
    expect(macro.vix).toBe("15.00");
    expect(macro.vix3m).toBe("17.00");
    expect(macro.fedFundsRate).toBe("5.25%");
    expect(macro.dgs3moTreasury).toBe(base.dgs3moTreasury);
    expect(macro.dgs2Treasury).toBe(base.dgs2Treasury);
    expect(macro.dgs10Treasury).toBe("4.20%");
    expect(macro.hyCreditSpread).toBe(base.hyCreditSpread);
    // Unchanged, non-critical fields are omitted to save tokens.
    expect(omitted).toContain("unemploymentRate");
    expect(omitted).toContain("m2MoneySupply");
    expect(omitted).toContain("consumerSentiment");
    expect(omitted).not.toContain("cpiInflation");
    expect(omitted).not.toContain("vix");
    expect(omitted).not.toContain("hyCreditSpread");
    expect(omitted).not.toContain("vix3m");
    expect(omitted).not.toContain("dgs2Treasury");
  });

  
  it("keeps vixAsOf out of omitted when unchanged across the live-VIX cache window", () => {
    const stamp = "2026-09-18T10:00:00.000Z";
    const base = {
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
      usdIndex: "104.00",
      wtiOil: "$75.00",
      housingStarts: "1.3M",
      consumerSentiment: "75.0",
      nonfarmPayrollsChangeK: "+180K",
      vix: "18.50",
      vix3m: "20.00",
      asOf: "2026-09-18",
      vixAsOf: stamp
    } as MacroData & { vixAsOf: string };
    // Same payload again (10-min live VIX cache hit): stamp unchanged, still re-applied by caller.
    const again = { ...base, vixAsOf: stamp } as MacroData & { vixAsOf: string };
    const { macro, omitted } = pruneMacro(again, base);
    expect(omitted).not.toContain("vixAsOf");
    expect(macro.vixAsOf).toBeUndefined();
    // Caller re-stamps — simulate proposeTrades assembly.
    const macroeconomicData = {
      ...macro,
      ...(omitted.length > 0 ? { unchangedSinceLastRun: omitted.filter((k) => k !== "vixAsOf") } : {}),
      vixAsOf: again.vixAsOf
    };
    expect(macroeconomicData.vixAsOf).toBe(stamp);
    expect((macroeconomicData.unchangedSinceLastRun as string[] | undefined) ?? []).not.toContain("vixAsOf");
  });

  it("never leaks the fredSourced meta flag into the LLM prompt payload (first run and delta)", () => {
    const flagged: MacroData = { ...base, fredSourced: true };

    // First run: the flag is excluded from the prompt record entirely.
    const first = pruneMacro(flagged);
    expect(Object.keys(first.macro)).not.toContain("fredSourced");
    expect(first.omitted).not.toContain("fredSourced");
    // …and the string data fields all still go through.
    expect(Object.keys(first.macro).sort()).toEqual(Object.keys(base).sort());

    // Delta run (flag flipped between runs): still never surfaces in macro OR omitted.
    const next: MacroData = { ...base, fredSourced: false, cpiInflation: "3.40%" };
    const delta = pruneMacro(next, flagged);
    expect(Object.keys(delta.macro)).not.toContain("fredSourced");
    expect(delta.omitted).not.toContain("fredSourced");
    expect(delta.macro.cpiInflation).toBe("3.40%");
  });

  it("drops empty-string fields entirely — the strategist never sees a blank/placeholder reading", () => {
    // The VIX-only fallback blanks every FRED field to "". Those fields must not be sent as ""
    // (which an LLM could misread as data), and no DEFAULT_MACRO-era constant may appear.
    const light = vixOnlyMacro("22.50");
    const { macro, omitted } = pruneMacro(light);
    expect(macro.vix).toBe("22.50");
    expect(macro.asOf).toBe("2026-06-21");
    expect(Object.keys(macro).sort()).toEqual(["asOf", "vix"]);
    expect(Object.values(macro)).not.toContain("");
    expect(omitted).toEqual([]);

    // Delta mode: a regime-critical field that is blank stays dropped (MACRO_ALWAYS_KEEP must not
    // resurrect an empty string), and blank fields never land in `omitted` either.
    const delta = pruneMacro(light, base);
    expect(Object.keys(delta.macro).sort()).toEqual(["asOf", "vix"]);
    expect(Object.values(delta.macro)).not.toContain("");
    expect(delta.macro.fedFundsRate).toBeUndefined();
  });
});
