import { describe, expect, it } from "vitest";
import { projectRedTeamReviewContext, RED_TEAM_REVIEW_CONTEXT_KEYS } from "../src/lib/red-team";

// `RedTeamReviewContext` documents a CURATED subset of the Green evidence: macro, limits,
// portfolio, scorecards, analogs and the candidates under review.  The run-time review ignored it
// and spread the entire Green `userContent` instead — the full evidence budget, every scan
// candidate, the RAG pack, learned context and the reflection summary — once PER OPENING.  The
// reviewer's job is to fact-check ONE finalized proposal against the evidence for ITS symbol.
//
// Parity between the two stages is carried by `evidenceManifest.greenRedParityHash`, a
// content-addressed hash over the evidence pack.  That is what makes parity provable; re-sending
// the bodies never was.

/** A Green userContent shaped like a real run: small contract fields, very large evidence blocks. */
function greenUserContent() {
  return {
    // ── documented reviewer contract ──
    currentDate: "2026-08-20",
    currentMarketRegime: "Tech-Bull",
    regimeSeverity: { severity: 0.31, inputsUsed: 6 },
    macroeconomicData: { cpiYoY: 2.4, fedFunds: 3.75, vixAsOf: "2026-09-18T12:00:00.000Z" },
    macroDerived: { curve2s10s: -0.12, vixTermStructure: 1.05 },
    macroTrends: { note: "trends", series: { VIX: { last: 18.2, d7: 1.5, spark: "▁▂▃▄" } } },
    marketSignals: { skew: 130, vvix: 90, marketBreadthPct: 48 },
    eventMarkets: { series: ["FED"], markets: ["Fed cut ~62%"] },
    predictionMarketsMacro: { markets: ["Recession 2026 Yes 18%"] },
    upcomingEconomicEvents: { events: [{ event: "CPI (YoY)", date: "2026-09-20" }] },
    limits: { maxOrderNotional: 5000, remainingDailyNotional: 12000 },
    socraticAuthority: { overrideMode: "off" },
    portfolio: { totalMarketValue: 100_000 },
    positions: [{ symbol: "AAPL", qty: 10 }],
    sectorComposition: { Technology: 0.42 },
    thesisOutcomes: [{ tag: "momentum", winRate: 0.55 }],
    regimeOutcomes: [{ regime: "Tech-Bull", winRate: 0.6 }],
    comboOutcomes: [{ combo: "momentum/Tech-Bull", n: 18 }],
    closestHistoricalAnalogs: "2026-05-02 AAPL momentum entry, +2.1%",
    ownerCoaching: "Prefer liquid names near earnings.",
    evidenceManifest: { packHash: "a".repeat(64), greenRedParityHash: "b".repeat(64), refs: [{ id: "e1" }] },
    reviewerFilingsPack: "### RAG Dossier for AAPL\nItem 1A. Supply-chain risk.",
    // ── Green-only bulk the reviewer used to receive verbatim ──
    marketScan: { topCandidates: Array.from({ length: 40 }, (_, i) => ({ sym: `SYM${i}`, news: "x".repeat(400) })) },
    retrievedFinancialContext: "R".repeat(20_000),
    learnedContext: "L".repeat(8_000),
    reflectionSummary: `<reflection_summary>\n${"F".repeat(6_000)}\n</reflection_summary>`,
    recentOrders: Array.from({ length: 50 }, (_, i) => ({ id: `o${i}` })),
    allowedSymbols: Array.from({ length: 300 }, (_, i) => `SYM${i}`),
    evidenceBudgetReceipts: Array.from({ length: 20 }, (_, i) => ({ field: `f${i}`, originalCharacters: 5000 })),
    executionMode: "broker",
    signalEfficacy: [{ signal: "rsi", lift: 0.02 }],
    // A field that is genuinely absent this run must not appear as an explicit undefined.
    taxContext: undefined
  };
}

describe("projectRedTeamReviewContext", () => {
  it("keeps every documented contract key", () => {
    const projected = projectRedTeamReviewContext(greenUserContent()) as Record<string, unknown>;
    for (const key of RED_TEAM_REVIEW_CONTEXT_KEYS) {
      expect(projected, `documented key "${key}" must reach the reviewer`).toHaveProperty(key);
    }
  });

  it("drops the Green-only bulk the reviewer never needed", () => {
    const projected = projectRedTeamReviewContext(greenUserContent()) as Record<string, unknown>;
    for (const key of [
      "marketScan",
      "retrievedFinancialContext",
      "learnedContext",
      "reflectionSummary",
      "recentOrders",
      "allowedSymbols",
      "evidenceBudgetReceipts",
      "executionMode",
      "signalEfficacy"
    ]) {
      expect(projected, `"${key}" is Green-only and must not be re-sent per opening`).not.toHaveProperty(key);
    }
  });

  it("preserves the parity manifest verbatim — that is what proves both stages saw one pack", () => {
    const green = greenUserContent();
    const projected = projectRedTeamReviewContext(green);
    expect(projected.evidenceManifest).toEqual(green.evidenceManifest);
  });

  it("omits absent fields rather than sending explicit undefined", () => {
    const projected = projectRedTeamReviewContext(greenUserContent()) as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(projected, "taxContext")).toBe(false);
    expect(projectRedTeamReviewContext({})).toEqual({});
  });

  it("cuts the per-review payload by an order of magnitude on a realistic evidence load", () => {
    const green = greenUserContent();
    const before = JSON.stringify(green).length;
    const after = JSON.stringify(projectRedTeamReviewContext(green)).length;
    // The saving multiplies: it is paid once per risk-adding opening, per run.
    expect(after).toBeLessThan(before / 10);
  });

  it("projects macroDerived, marketSignals, macroTrends, and event/calendar keys Green already has", () => {
    const green = greenUserContent();
    const projected = projectRedTeamReviewContext(green) as Record<string, unknown>;
    for (const key of [
      "macroDerived",
      "macroTrends",
      "marketSignals",
      "eventMarkets",
      "predictionMarketsMacro",
      "upcomingEconomicEvents"
    ]) {
      expect(projected, `regime key "${key}" must reach Red (2026-09-18 audit)`).toHaveProperty(key);
      expect(projected[key]).toEqual((green as Record<string, unknown>)[key]);
    }
  });

});
