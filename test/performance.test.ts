import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { mergeQuoteData } from "../src/lib/market";
import {
  calculatePnl,
  getClosedLotCount,
  getConfidenceCalibration,
  getFactorScorecard,
  getRedTeamEfficacy,
  getRegimeScorecard,
  getSectorScorecard,
  getSignalEfficacy,
  getSkippedCandidateReturns,
  getThesisRegimeScorecard,
  getThesisScorecard,
  recordFillFromProposal,
  type PrefetchedFills
} from "../src/lib/performance";
import type { FillEvent, MarketScan, OrderSide, TradeProposal } from "../src/lib/types";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-performance-${randomUUID()}.db`)}`;
});

describe("calculatePnl", () => {
  it("uses FIFO realized P&L and marks remaining lots to market", () => {
    const fills: FillEvent[] = [
      fill({ id: "b1", side: "buy", quantity: 2, price: 100, notional: 200 }),
      fill({ id: "b2", side: "buy", quantity: 1, price: 120, notional: 120 }),
      fill({ id: "s1", side: "sell", quantity: 1.5, price: 130, notional: 195 })
    ];

    const pnl = calculatePnl(fills, { AAPL: 125 });

    expect(pnl.realized).toBeCloseTo(45);
    expect(pnl.unrealized).toBeCloseTo(17.5);
    expect(pnl.closedLots.length).toBe(1);
  });

  it("does not account for broker-paper fills until the broker reports execution", async () => {
    const { insertFillEvent } = await import("../src/lib/db");
    const pending = fill({
      id: "bp-pending",
      accountNumber: "BROKER_PAPER_PENDING",
      source: "paper",
      executionMode: "broker/paper",
      brokerOrderId: "alpaca-pending-1",
      status: "pending_reconciliation",
      side: "buy",
      quantity: 5,
      price: 100,
      notional: 500
    });

    const pnl = calculatePnl([pending], { AAPL: 110 });
    expect(pnl.openLots).toHaveLength(0);
    expect(pnl.unrealized).toBe(0);

    insertFillEvent(pending);
    // A pending broker-paper fill contributes no realized/unrealized P&L until the broker reports
    // execution (status flips to "filled") — verified above via calculatePnl directly.
  });

  it("does not substitute proposal or review prices into an unpriced broker receipt", () => {
    const pending = recordFillFromProposal({
      accountNumber: `UNPRICED-${randomUUID()}`,
      source: "live",
      executionMode: "broker/live",
      proposal: {
        symbol: "AAPL",
        side: "buy",
        type: "limit",
        quantity: 1,
        limitPrice: 200,
        timeInForce: "gfd",
        marketHours: "regular_hours",
        rationale: "broker price still unknown",
        tradeThesisTag: "test",
        entryMarketRegime: "test"
      },
      review: { estimatedNotional: 200, alerts: [], raw: { price: 200 } },
      marketScan: marketScanWithQuote("AAPL", 201),
      execution: { orderId: "unpriced-order", refId: "unpriced-ref", state: "filled", filledQuantity: 1, raw: {} },
      status: "pending_reconciliation"
    });

    expect(pending).toMatchObject({ status: "pending_reconciliation", quantity: 1, price: 0, notional: 0 });
  });

  it("accounts for the executed quantity of a still-working partial fill", () => {
    const partial = fill({
      id: "live-partial",
      source: "live",
      executionMode: "broker/live",
      brokerOrderId: "broker-partial-1",
      status: "partially_filled",
      side: "buy",
      quantity: 2,
      price: 100,
      notional: 200
    });

    const pnl = calculatePnl([partial], { AAPL: 110 });
    expect(pnl.openLots).toMatchObject([{ symbol: "AAPL", quantity: 2, entryPrice: 100 }]);
    expect(pnl.unrealized).toBe(20);
  });

  it("turns approved dollar Paper orders into quantity fills when a market quote is present", () => {
    const fill = recordFillFromProposal({
      accountNumber: "APPROVAL1",
      source: "paper",
      proposal: {
        symbol: "MSFT",
        side: "buy",
        type: "market",
        dollarAmount: 10,
        timeInForce: "gfd",
        marketHours: "regular_hours",
        rationale: "test",
        tradeThesisTag: "test",
        entryMarketRegime: "test"
      },
      review: { estimatedNotional: 10, alerts: [], raw: {} },
      marketScan: marketScanWithQuote("MSFT", 420),
      status: "filled"
    });

    // With default-ON execution cost (20 bps base, no spread/volume data here):
    // price = 420 * (1 + 0.002) = 420.84; quantity = 10 / 420.84.
    expect(fill.price).toBeCloseTo(420.84, 2); // 20 bps cost applied to buy
    expect(fill.quantity).toBeCloseTo(10 / 420.84, 4);
  });

  it("keeps broker-only approval quotes in the market scan price map", () => {
    const scan = mergeQuoteData(emptyScan(), {
      MSFT: { price: 420, bid: 419.5, ask: 420.5, provider: "mock-robinhood", asOf: "2026-06-15T00:00:00.000Z" }
    });

    expect(scan.quotesBySymbol.MSFT?.price).toBeCloseTo(420);
    expect(scan.quotesBySymbol.MSFT?.ask).toBeCloseTo(420.5);
  });
});

describe("getThesisScorecard", () => {
  it("attributes realized P&L to the thesis a position was opened under", async () => {
    const { insertFillEvent } = await import("../src/lib/db");
    const account = "SCORE1";
    // Winner opened under "Momentum": buy 1 @ 100, sell 1 @ 120 => +20 (+20%).
    insertFillEvent(
      fill({
        id: "sc-b1",
        side: "buy",
        quantity: 1,
        price: 100,
        notional: 100,
        accountNumber: account,
        symbol: "AAPL",
        filledAt: "2026-06-15T00:00:01.000Z",
        raw: { proposal: { tradeThesisTag: "Momentum", entryMarketRegime: "Tech-Bull" } }
      })
    );
    insertFillEvent(
      fill({
        id: "sc-s1",
        side: "sell",
        quantity: 1,
        price: 120,
        notional: 120,
        accountNumber: account,
        symbol: "AAPL",
        filledAt: "2026-06-15T00:00:02.000Z"
      })
    );
    // Loser opened under "MeanReversion": buy 1 @ 100, sell 1 @ 90 => -10 (-10%).
    insertFillEvent(
      fill({
        id: "sc-b2",
        side: "buy",
        quantity: 1,
        price: 100,
        notional: 100,
        accountNumber: account,
        symbol: "MSFT",
        filledAt: "2026-06-15T00:00:03.000Z",
        raw: { proposal: { tradeThesisTag: "MeanReversion", entryMarketRegime: "Choppy" } }
      })
    );
    insertFillEvent(
      fill({
        id: "sc-s2",
        side: "sell",
        quantity: 1,
        price: 90,
        notional: 90,
        accountNumber: account,
        symbol: "MSFT",
        filledAt: "2026-06-15T00:00:04.000Z"
      })
    );

    const scorecard = getThesisScorecard(account, "paper");

    // Sorted by total P&L descending: winner first.
    expect(scorecard.map((s) => s.thesisTag)).toEqual(["Momentum", "MeanReversion"]);

    const momentum = scorecard.find((s) => s.thesisTag === "Momentum")!;
    expect(momentum.trades).toBe(1);
    expect(momentum.winRate).toBe(100);
    expect(momentum.avgReturnPct).toBeCloseTo(20);
    expect(momentum.totalPnl).toBeCloseTo(20);
    // Bayesian shrinkage (5-trade neutral prior) tempers the 1-trade sample:
    // win rate (1 + 2.5)/(1 + 5) = 58%; avg return 20/(1 + 5) = 3.33%.
    expect(momentum.shrunkWinRate).toBe(58);
    expect(momentum.shrunkAvgReturnPct).toBeCloseTo(3.33);

    const reversion = scorecard.find((s) => s.thesisTag === "MeanReversion")!;
    expect(reversion.winRate).toBe(0);
    expect(reversion.avgReturnPct).toBeCloseTo(-10);
    expect(reversion.totalPnl).toBeCloseTo(-10);

    // Same closed lots, grouped by the regime each was opened in.
    const regimes = getRegimeScorecard(account, "paper");
    expect(regimes.map((r) => r.regime)).toEqual(["Tech-Bull", "Choppy"]);
    expect(regimes.find((r) => r.regime === "Tech-Bull")!.totalPnl).toBeCloseTo(20);
    expect(regimes.find((r) => r.regime === "Choppy")!.winRate).toBe(0);
  });

  it("crosses thesis and regime into combined buckets and counts closed lots", async () => {
    const { insertFillEvent } = await import("../src/lib/db");
    const account = "SCORE_TR";
    // Two closed lots under the same thesis but different regimes.
    insertFillEvent(fill({ id: "tr-b1", side: "buy", quantity: 1, price: 100, notional: 100, accountNumber: account, symbol: "AAA", filledAt: "2026-06-15T00:00:01.000Z", raw: { proposal: { tradeThesisTag: "Momentum-Breakout", entryMarketRegime: "Tech-Bull" } } }));
    insertFillEvent(fill({ id: "tr-s1", side: "sell", quantity: 1, price: 130, notional: 130, accountNumber: account, symbol: "AAA", filledAt: "2026-06-15T00:00:02.000Z" }));
    insertFillEvent(fill({ id: "tr-b2", side: "buy", quantity: 1, price: 100, notional: 100, accountNumber: account, symbol: "BBB", filledAt: "2026-06-15T00:00:03.000Z", raw: { proposal: { tradeThesisTag: "Momentum-Breakout", entryMarketRegime: "High-Vol" } } }));
    insertFillEvent(fill({ id: "tr-s2", side: "sell", quantity: 1, price: 80, notional: 80, accountNumber: account, symbol: "BBB", filledAt: "2026-06-15T00:00:04.000Z" }));

    const combined = getThesisRegimeScorecard(account, "paper");
    expect(combined.map((b) => `${b.thesisTag} @ ${b.regime}`).sort()).toEqual(["Momentum-Breakout @ High-Vol", "Momentum-Breakout @ Tech-Bull"]);
    expect(combined.find((b) => b.regime === "Tech-Bull")!.totalPnl).toBeCloseTo(30);
    expect(combined.find((b) => b.regime === "High-Vol")!.totalPnl).toBeCloseTo(-20);
    expect(getClosedLotCount(account, "paper")).toBe(2);
  });

  it("attributes realized win rate to entry signals via the signal_snapshot join", async () => {
    const { insertFillEvent, audit } = await import("../src/lib/db");
    const account = "SIGEFF1";
    const runId = "run-sigeff-1";
    // A winning buy (100 -> 130) opened in a run that recorded a congressional + insider tailwind.
    insertFillEvent(fill({ id: "se-b1", side: "buy", quantity: 1, price: 100, notional: 100, accountNumber: account, symbol: "NVDA", runId, filledAt: "2026-06-15T00:00:01.000Z" }));
    insertFillEvent(fill({ id: "se-s1", side: "sell", quantity: 1, price: 130, notional: 130, accountNumber: account, symbol: "NVDA", filledAt: "2026-06-15T00:00:02.000Z" }));
    // The snapshot now records the full scored set; the skipped TSLA entry (chosen:false,
    // no fill) must NOT inflate any signal bucket. The NVDA entry has no `chosen` field
    // (older shape) and must still attribute, proving backward compatibility.
    audit("signal_snapshot", {
      runId,
      signals: [
        { symbol: "NVDA", side: "buy", congressNet: 2, insiderSentiment: 80 },
        { symbol: "TSLA", chosen: false, congressNet: 5, insiderSentiment: 90 }
      ]
    });

    const eff = getSignalEfficacy(account, "paper");
    expect(eff.find((e) => e.signal.includes("baseline"))?.trades).toBe(1);
    const congress = eff.find((e) => e.signal.includes("Congressional"));
    expect(congress?.trades).toBe(1); // only NVDA, not the skipped TSLA
    expect(congress?.winRate).toBe(100);
    expect(eff.find((e) => e.signal.includes("Insider"))?.trades).toBe(1);
  });

  it("keeps signal efficacy audit joins isolated by user", async () => {
    const { insertFillEvent, audit } = await import("../src/lib/db");
    const account = "SIGEFF_USERS";
    const userA = `sig-a-${randomUUID()}`;
    const userB = `sig-b-${randomUUID()}`;
    const runId = "run-sigeff-users";

    insertFillEvent(fill({ id: "seu-b1", userId: userA, side: "buy", quantity: 1, price: 100, notional: 100, accountNumber: account, symbol: "AAPL", runId, filledAt: "2026-06-15T00:00:01.000Z" }));
    insertFillEvent(fill({ id: "seu-s1", userId: userA, side: "sell", quantity: 1, price: 110, notional: 110, accountNumber: account, symbol: "AAPL", filledAt: "2026-06-15T00:00:02.000Z" }));
    audit("signal_snapshot", { runId, signals: [{ symbol: "AAPL", chosen: true, congressNet: 2 }] }, userB);

    const eff = getSignalEfficacy(account, "paper", {}, userA);
    expect(eff.find((e) => e.signal.includes("baseline"))?.trades).toBe(1);
    expect(eff.find((e) => e.signal.includes("Congressional"))).toBeUndefined();
  });

  it("buckets realized outcomes by the dominant entry factor", async () => {
    const { insertFillEvent, audit } = await import("../src/lib/db");
    const account = "FACTOR1";
    const userId = `factor-user-${randomUUID()}`;
    const runId = "run-factor-1";

    insertFillEvent(fill({ id: "fb-b1", userId, side: "buy", quantity: 1, price: 100, notional: 100, accountNumber: account, symbol: "AAPL", runId, filledAt: "2026-06-15T00:00:01.000Z" }));
    insertFillEvent(fill({ id: "fb-s1", userId, side: "sell", quantity: 1, price: 125, notional: 125, accountNumber: account, symbol: "AAPL", filledAt: "2026-06-15T00:00:02.000Z" }));
    audit("signal_snapshot", {
      runId,
      signals: [
        {
          symbol: "AAPL",
          chosen: true,
          factorBreakdown: { liquidity: 10, momentum: 90, value: 30, quality: 20, volatility: 15, sentiment: 25, positioning: 40, diversification: 5, weightedTotal: 70 }
        },
        {
          symbol: "MSFT",
          chosen: false,
          factorBreakdown: { liquidity: 10, momentum: 5, value: 95, quality: 20, volatility: 15, sentiment: 25, positioning: 40, diversification: 5, weightedTotal: 70 }
        }
      ]
    }, userId);

    const factors = getFactorScorecard(account, "paper", {}, userId);
    expect(factors).toHaveLength(1);
    expect(factors[0].factor).toBe("momentum");
    expect(factors[0].totalPnl).toBeCloseTo(25);
  });

  it("summarizes skipped candidate counterfactual returns from user-scoped snapshots", async () => {
    const { audit } = await import("../src/lib/db");
    const userA = `skip-a-${randomUUID()}`;
    const userB = `skip-b-${randomUUID()}`;
    const asOf = new Date().toISOString();

    audit("signal_snapshot", {
      runId: "run-skip-a",
      asOf,
      signals: [{ symbol: "AAPL", chosen: false, refPrice: 100, score: 80, regime: "Risk-On", factorBreakdown: { liquidity: 10, momentum: 90, value: 30, quality: 20, volatility: 15, sentiment: 25, positioning: 40, diversification: 5, weightedTotal: 70 } }]
    }, userA);
    audit("signal_snapshot", {
      runId: "run-skip-b",
      asOf,
      signals: [{ symbol: "AAPL", chosen: false, refPrice: 50, score: 80, regime: "Risk-On" }]
    }, userB);

    const rows = getSkippedCandidateReturns({ AAPL: 110 }, userA);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ runId: "run-skip-a", symbol: "AAPL", returnPct: 10, dominantFactor: "momentum" });
  });

  it("getRedTeamEfficacy joins Bear-veto audit events to matured counterfactual returns, per model", async () => {
    const { audit, insertSkippedCounterfactualCandidate, markSkippedCounterfactualMatured } = await import("../src/lib/db");
    const userId = `redteam-eff-${randomUUID()}`;

    // Veto 1 (model A): would have LOST money — the Bear added value.
    audit("proposal_rejected_by_red_team", { runId: "run-rt-1", symbol: "AAPL", side: "buy", thesisTag: "Momentum", reason: "Overbought.", model: "openai/gpt-4.1-mini" }, userId);
    insertSkippedCounterfactualCandidate({ userId, runId: "run-rt-1", symbol: "AAPL", snapshotAt: "2026-06-01T00:00:00.000Z", refPrice: 100, horizonDays: 5, targetDate: "2026-06-06" });
    markSkippedCounterfactualMatured({ id: `${userId}:run-rt-1:AAPL:5`, userId, exitDate: "2026-06-06", exitPrice: 90, returnPct: -10 });

    // Veto 2 (model A): would have WON — a survivor-risk hit (the veto missed a winner).
    audit("proposal_rejected_by_red_team", { runId: "run-rt-2", symbol: "MSFT", side: "buy", thesisTag: "Momentum", reason: "Overbought.", model: "openai/gpt-4.1-mini" }, userId);
    insertSkippedCounterfactualCandidate({ userId, runId: "run-rt-2", symbol: "MSFT", snapshotAt: "2026-06-01T00:00:00.000Z", refPrice: 200, horizonDays: 5, targetDate: "2026-06-06" });
    markSkippedCounterfactualMatured({ id: `${userId}:run-rt-2:MSFT:5`, userId, exitDate: "2026-06-06", exitPrice: 220, returnPct: 10 });

    // Veto 3 (model B, unmatured): counted in totalVetoes but not maturedVetoes.
    audit("proposal_rejected_by_red_team", { runId: "run-rt-3", symbol: "NVDA", side: "buy", thesisTag: "Momentum", reason: "Overbought.", model: "claude-opus" }, userId);
    insertSkippedCounterfactualCandidate({ userId, runId: "run-rt-3", symbol: "NVDA", snapshotAt: "2026-06-01T00:00:00.000Z", refPrice: 300, horizonDays: 5, targetDate: "2026-06-06" });

    const efficacy = getRedTeamEfficacy(userId);
    expect(efficacy.totalVetoes).toBe(3);
    expect(efficacy.maturedVetoes).toBe(2);
    expect(efficacy.maturedCoveragePct).toBeCloseTo((2 / 3) * 100, 1);
    expect(efficacy.vetoValueAddRate).toBe(50); // 1 of 2 matured vetoes avoided a loser
    expect(efficacy.survivorRiskHitRate).toBe(50); // 1 of 2 matured vetoes missed a winner
    expect(efficacy.avgReturnPct).toBe(0); // (-10 + 10) / 2

    const modelA = efficacy.byModel.find((m) => m.model === "gpt-mini-latest");
    expect(modelA?.maturedVetoes).toBe(2);
    expect(modelA?.vetoValueAddRate).toBe(50);
    expect(modelA?.survivorRiskHitRate).toBe(50);
    // Model B has zero MATURED vetoes, so it's absent from byModel (never a fabricated 0/0 row).
    expect(efficacy.byModel.find((m) => m.model === "claude-opus")).toBeUndefined();

    expect(efficacy.records).toHaveLength(2);
  });

  it("getRedTeamEfficacy merges Gemini Flash version slugs onto gemini-flash-latest", async () => {
    const { audit, insertSkippedCounterfactualCandidate, markSkippedCounterfactualMatured } = await import("../src/lib/db");
    const userId = `redteam-eff-flash-${randomUUID()}`;

    audit("proposal_rejected_by_red_team", { runId: "run-flash-1", symbol: "AAPL", side: "buy", model: "google/gemini-3.7-flash" }, userId);
    insertSkippedCounterfactualCandidate({ userId, runId: "run-flash-1", symbol: "AAPL", snapshotAt: "2026-06-01T00:00:00.000Z", refPrice: 100, horizonDays: 5, targetDate: "2026-06-06" });
    markSkippedCounterfactualMatured({ id: `${userId}:run-flash-1:AAPL:5`, userId, exitDate: "2026-06-06", exitPrice: 90, returnPct: -10 });

    audit("proposal_rejected_by_red_team", { runId: "run-flash-2", symbol: "MSFT", side: "buy", model: "gemini-flash-latest" }, userId);
    insertSkippedCounterfactualCandidate({ userId, runId: "run-flash-2", symbol: "MSFT", snapshotAt: "2026-06-01T00:00:00.000Z", refPrice: 200, horizonDays: 5, targetDate: "2026-06-06" });
    markSkippedCounterfactualMatured({ id: `${userId}:run-flash-2:MSFT:5`, userId, exitDate: "2026-06-06", exitPrice: 180, returnPct: -10 });

    const efficacy = getRedTeamEfficacy(userId);
    expect(efficacy.byModel).toHaveLength(1);
    expect(efficacy.byModel[0]).toMatchObject({
      model: "gemini-flash-latest",
      maturedVetoes: 2,
      vetoValueAddRate: 100
    });
  });

  it("getRedTeamEfficacy side-adjusts SHORT vetoes (a short's counterfactual close-price-up is a value-add)", async () => {
    const { audit, insertSkippedCounterfactualCandidate, markSkippedCounterfactualMatured } = await import("../src/lib/db");
    const userId = `redteam-eff-short-${randomUUID()}`;

    // A vetoed SHORT whose price ROSE (raw returnPct positive) means the short thesis would have
    // LOST money — the veto added value. Side-adjusted returnPct should be negative.
    audit("proposal_rejected_by_red_team", { runId: "run-rt-short", symbol: "TSLA", side: "short", thesisTag: "Breakdown", reason: "Squeeze risk.", model: "openai/gpt-4.1-mini" }, userId);
    insertSkippedCounterfactualCandidate({ userId, runId: "run-rt-short", symbol: "TSLA", snapshotAt: "2026-06-01T00:00:00.000Z", refPrice: 100, horizonDays: 5, targetDate: "2026-06-06" });
    markSkippedCounterfactualMatured({ id: `${userId}:run-rt-short:TSLA:5`, userId, exitDate: "2026-06-06", exitPrice: 120, returnPct: 20 });

    const efficacy = getRedTeamEfficacy(userId);
    expect(efficacy.records[0]?.returnPct).toBe(-20);
    expect(efficacy.vetoValueAddRate).toBe(100);
  });

  it("getRedTeamEfficacy computes unattributed model rollups from full history, not the recent record slice", async () => {
    const { audit, insertSkippedCounterfactualCandidate, markSkippedCounterfactualMatured } = await import("../src/lib/db");
    const userId = `redteam-eff-unattributed-${randomUUID()}`;

    for (let i = 0; i < 13; i += 1) {
      const runId = `run-rt-unattributed-${i}`;
      const symbol = `T${i}`;
      audit("proposal_rejected_by_red_team", { runId, symbol, side: "buy", thesisTag: "Momentum", reason: "Legacy unstamped veto." }, userId);
      insertSkippedCounterfactualCandidate({ userId, runId, symbol, snapshotAt: "2026-06-01T00:00:00.000Z", refPrice: 100, horizonDays: 5, targetDate: "2026-06-06" });
      markSkippedCounterfactualMatured({ id: `${userId}:${runId}:${symbol}:5`, userId, exitDate: "2026-06-06", exitPrice: 90, returnPct: -10 });
    }

    const efficacy = getRedTeamEfficacy(userId, { limit: 2 });

    expect(efficacy.records).toHaveLength(2);
    expect(efficacy.byModel.find((m) => m.model === "unattributed")).toMatchObject({
      maturedVetoes: 13,
      vetoValueAddRate: 100,
      survivorRiskHitRate: 0,
      avgReturnPct: -10
    });
  });

  it("getRedTeamEfficacy scans audits BY KIND — a flood of newer other-kind audits cannot evict veto history", async () => {
    const { audit } = await import("../src/lib/db");
    const userId = `redteam-eff-kind-${randomUUID()}`;

    audit("proposal_rejected_by_red_team", { runId: "run-rt-old", symbol: "AAPL", side: "buy", reason: "Overbought.", model: "openai/gpt-4.1-mini" }, userId);
    // Ten newer audit rows of OTHER kinds — more than the auditLimit below. Under the old
    // all-kind scan (LIMIT applied before the kind filter), these would push the veto out
    // of the window entirely and the scorecard would report zero veto history.
    for (let i = 0; i < 10; i += 1) {
      audit("signal_snapshot", { runId: `run-noise-${i}`, signals: [] }, userId);
    }

    const efficacy = getRedTeamEfficacy(userId, { auditLimit: 5 });
    expect(efficacy.totalVetoes).toBe(1);
  });

  // 2026-09-18: the audit-kind scan defaulted to a 500-row LIMIT. That was a soft ceiling while
  // proposal_rejected_by_red_team rows were also being hard-deleted after 90 days (audit-prune.ts)
  // — the prune bug always evicted history long before 500 accumulated. Once that exemption
  // landed (AUDIT_PRUNE_NEVER_PRUNED_KINDS), lifetime veto history can genuinely exceed 500 on any
  // account with sustained Red Team activity, and the old default would have silently truncated
  // this rollup back down to the newest 500 — the exact failure mode the prune fix was meant to
  // end. Proves the DEFAULT (no auditLimit override) now reaches every one of >500 matured vetoes.
  it("getRedTeamEfficacy's default audit scan reaches every matured veto past the old 500-row cap", async () => {
    const { audit, insertSkippedCounterfactualCandidate, markSkippedCounterfactualMatured } = await import("../src/lib/db");
    const userId = `redteam-eff-past500-${randomUUID()}`;
    const total = 520;

    for (let i = 0; i < total; i += 1) {
      const runId = `run-rt-past500-${i}`;
      const symbol = `SYM${i}`;
      audit("proposal_rejected_by_red_team", { runId, symbol, side: "buy", reason: "Overbought.", model: "openai/gpt-4.1-mini" }, userId);
      insertSkippedCounterfactualCandidate({ userId, runId, symbol, snapshotAt: "2026-06-01T00:00:00.000Z", refPrice: 100, horizonDays: 5, targetDate: "2026-06-06" });
      markSkippedCounterfactualMatured({ id: `${userId}:${runId}:${symbol}:5`, userId, exitDate: "2026-06-06", exitPrice: 90, returnPct: -10 });
    }

    const efficacy = getRedTeamEfficacy(userId);
    expect(efficacy.totalVetoes).toBe(total);
    expect(efficacy.maturedVetoes).toBe(total);
    expect(efficacy.byModel.find((m) => m.model === "gpt-mini-latest")?.maturedVetoes).toBe(total);
  });

  it("getRedTeamEfficacy excludes EXIT vetoes from totals (no counterfactual is ever recorded for them)", async () => {
    const { audit } = await import("../src/lib/db");
    const userId = `redteam-eff-exit-${randomUUID()}`;

    // A vetoed SELL (exit) is audited by the strategy but never gets a counterfactual row —
    // counting it in totalVetoes would permanently depress maturation coverage.
    audit("proposal_rejected_by_red_team", { runId: "run-rt-exit", symbol: "AAPL", side: "sell", reason: "Premature exit.", model: "openai/gpt-4.1-mini" }, userId);
    audit("proposal_rejected_by_red_team", { runId: "run-rt-open", symbol: "MSFT", side: "buy", reason: "Overbought.", model: "openai/gpt-4.1-mini" }, userId);

    const efficacy = getRedTeamEfficacy(userId);
    expect(efficacy.totalVetoes).toBe(1);
  });

  it("groups realized outcomes by the sector each position was opened in", async () => {
    const { insertFillEvent } = await import("../src/lib/db");
    const account = "SECT1";
    insertFillEvent(fill({ id: "sec-b1", side: "buy", quantity: 1, price: 100, notional: 100, accountNumber: account, symbol: "AAA", filledAt: "2026-06-15T00:00:01.000Z", raw: { proposal: { tradeThesisTag: "T" }, sector: "Technology" } }));
    insertFillEvent(fill({ id: "sec-s1", side: "sell", quantity: 1, price: 120, notional: 120, accountNumber: account, symbol: "AAA", filledAt: "2026-06-15T00:00:02.000Z" }));
    const sc = getSectorScorecard(account, "paper");
    expect(sc.find((s) => s.sector === "Technology")?.totalPnl).toBeCloseTo(20);
  });

  it("buckets realized outcomes by the agent's entry confidence band", async () => {
    const { insertFillEvent } = await import("../src/lib/db");
    const account = "CONF1";
    // High-confidence winner (90 → +20%).
    insertFillEvent(fill({ id: "cf-b1", side: "buy", quantity: 1, price: 100, notional: 100, accountNumber: account, symbol: "AAA", filledAt: "2026-06-15T00:00:01.000Z", raw: { proposal: { tradeThesisTag: "T", confidenceScore: 90 } } }));
    insertFillEvent(fill({ id: "cf-s1", side: "sell", quantity: 1, price: 120, notional: 120, accountNumber: account, symbol: "AAA", filledAt: "2026-06-15T00:00:02.000Z" }));
    // Low-confidence loser (40 → −10%).
    insertFillEvent(fill({ id: "cf-b2", side: "buy", quantity: 1, price: 100, notional: 100, accountNumber: account, symbol: "BBB", filledAt: "2026-06-15T00:00:03.000Z", raw: { proposal: { tradeThesisTag: "T", confidenceScore: 40 } } }));
    insertFillEvent(fill({ id: "cf-s2", side: "sell", quantity: 1, price: 90, notional: 90, accountNumber: account, symbol: "BBB", filledAt: "2026-06-15T00:00:04.000Z" }));

    const cal = getConfidenceCalibration(account, "paper");
    expect(cal.find((c) => c.band.startsWith("85"))?.winRate).toBe(100);
    expect(cal.find((c) => c.band.startsWith("1-49"))?.winRate).toBe(0);
  });

  it("buckets fills with no thesis tag under 'Untagged'", async () => {
    const { insertFillEvent } = await import("../src/lib/db");
    const account = "SCORE2";
    insertFillEvent(fill({ id: "u-b1", side: "buy", quantity: 1, price: 50, notional: 50, accountNumber: account, symbol: "T", filledAt: "2026-06-15T00:00:01.000Z" }));
    insertFillEvent(fill({ id: "u-s1", side: "sell", quantity: 1, price: 55, notional: 55, accountNumber: account, symbol: "T", filledAt: "2026-06-15T00:00:02.000Z" }));

    const scorecard = getThesisScorecard(account, "paper");
    expect(scorecard).toHaveLength(1);
    expect(scorecard[0].thesisTag).toBe("Untagged");
    expect(scorecard[0].totalPnl).toBeCloseTo(5);
  });
});

describe("calculatePnl — short/cover", () => {
  it("short then cover at a lower price realizes a profit (price fell)", () => {
    const fills: FillEvent[] = [
      fill({ id: "sh1", side: "short", quantity: 1, price: 120, notional: 120, filledAt: "2026-06-15T00:00:01.000Z" }),
      fill({ id: "cv1", side: "cover", quantity: 1, price: 100, notional: 100, filledAt: "2026-06-15T00:00:02.000Z" })
    ];
    const pnl = calculatePnl(fills);
    expect(pnl.realized).toBeCloseTo(20);
    expect(pnl.closedLots).toHaveLength(1);
    expect(pnl.closedLots[0].side).toBe("short");
    expect(pnl.openLots).toHaveLength(0);
  });

  it("short then cover at a higher price realizes a loss (price rose)", () => {
    const fills: FillEvent[] = [
      fill({ id: "sh2", side: "short", quantity: 1, price: 100, notional: 100, filledAt: "2026-06-15T00:00:01.000Z" }),
      fill({ id: "cv2", side: "cover", quantity: 1, price: 130, notional: 130, filledAt: "2026-06-15T00:00:02.000Z" })
    ];
    expect(calculatePnl(fills).realized).toBeCloseTo(-30);
  });

  it("marks an open short to market with the short sign (profit when below entry)", () => {
    const pnl = calculatePnl(
      [fill({ id: "sh3", side: "short", quantity: 1, price: 120, notional: 120, filledAt: "2026-06-15T00:00:01.000Z" })],
      { AAPL: 100 }
    );
    expect(pnl.unrealized).toBeCloseTo(20);
    expect(pnl.openLots).toHaveLength(1);
    expect(pnl.openLots[0].side).toBe("short");
    expect(pnl.openLots[0].quantity).toBeLessThan(0); // signed: negative for short
  });

  it("a sell skips a leading short lot and realizes against the long lot (no $0 erasure)", () => {
    const fills: FillEvent[] = [
      fill({ id: "x-sh", side: "short", quantity: 1, price: 90, notional: 90, filledAt: "2026-06-15T00:00:01.000Z" }),
      fill({ id: "x-b", side: "buy", quantity: 1, price: 100, notional: 100, filledAt: "2026-06-15T00:00:02.000Z" }),
      fill({ id: "x-s", side: "sell", quantity: 1, price: 130, notional: 130, filledAt: "2026-06-15T00:00:03.000Z" })
    ];
    const pnl = calculatePnl(fills);
    // The sell closes the LONG lot (+30); the short lot is NOT consumed at $0.
    expect(pnl.realized).toBeCloseTo(30);
    expect(pnl.closedLots).toHaveLength(1);
    expect(pnl.closedLots[0].side).toBe("long");
    expect(pnl.openLots).toHaveLength(1);
    expect(pnl.openLots[0].side).toBe("short");
    expect(pnl.openLots[0].quantity).toBeLessThan(0); // signed: negative for short
  });

  it("a cover skips a leading long lot and realizes against the short lot", () => {
    const fills: FillEvent[] = [
      fill({ id: "y-b", side: "buy", quantity: 1, price: 100, notional: 100, filledAt: "2026-06-15T00:00:01.000Z" }),
      fill({ id: "y-sh", side: "short", quantity: 1, price: 120, notional: 120, filledAt: "2026-06-15T00:00:02.000Z" }),
      fill({ id: "y-cv", side: "cover", quantity: 1, price: 100, notional: 100, filledAt: "2026-06-15T00:00:03.000Z" })
    ];
    const pnl = calculatePnl(fills);
    expect(pnl.realized).toBeCloseTo(20);
    expect(pnl.closedLots).toHaveLength(1);
    expect(pnl.closedLots[0].side).toBe("short");
    expect(pnl.openLots).toHaveLength(1);
    expect(pnl.openLots[0].side).toBe("long");
  });

  it("a short round-trip realizes a profit AND a +returnPct when cover price < short price", () => {
    // short 1@100, cover 1@90 → realized 1*(100-90)=+10; returnPct (100-90)/100*100=+10%.
    const fills: FillEvent[] = [
      fill({ id: "a-sh", side: "short", quantity: 1, price: 100, notional: 100, filledAt: "2026-06-15T00:00:01.000Z" }),
      fill({ id: "a-cv", side: "cover", quantity: 1, price: 90, notional: 90, filledAt: "2026-06-15T00:00:02.000Z" })
    ];
    const pnl = calculatePnl(fills);
    expect(pnl.realized).toBeCloseTo(10);
    expect(pnl.closedLots).toHaveLength(1);
    expect(pnl.closedLots[0].side).toBe("short");
    expect(pnl.closedLots[0].returnPct).toBeCloseTo(10);
    expect(pnl.openLots).toHaveLength(0);
  });

  it("a short round-trip realizes a loss AND a -returnPct when cover price > short price", () => {
    // short 1@100, cover 1@130 → realized 1*(100-130)=-30; returnPct (100-130)/100*100=-30%.
    const fills: FillEvent[] = [
      fill({ id: "a-sh2", side: "short", quantity: 1, price: 100, notional: 100, filledAt: "2026-06-15T00:00:01.000Z" }),
      fill({ id: "a-cv2", side: "cover", quantity: 1, price: 130, notional: 130, filledAt: "2026-06-15T00:00:02.000Z" })
    ];
    const pnl = calculatePnl(fills);
    expect(pnl.realized).toBeCloseTo(-30);
    expect(pnl.closedLots).toHaveLength(1);
    expect(pnl.closedLots[0].side).toBe("short");
    expect(pnl.closedLots[0].returnPct).toBeCloseTo(-30);
  });

  it("a cover that partially closes a short realizes on the matched chunk; the residual short marks to market", () => {
    // short 3@100, cover 1@90 → matched 1: realized 1*(100-90)=+10; returnPct (100-90)/100*100=+10%.
    // residual short = 3-1 = 2 @ 100; at current 120 unrealized = 2*(100-120) = -40 (short loses as price rises).
    const fills: FillEvent[] = [
      fill({ id: "b-sh", side: "short", quantity: 3, price: 100, notional: 300, filledAt: "2026-06-15T00:00:01.000Z" }),
      fill({ id: "b-cv", side: "cover", quantity: 1, price: 90, notional: 90, filledAt: "2026-06-15T00:00:02.000Z" })
    ];
    const pnl = calculatePnl(fills, { AAPL: 120 });
    expect(pnl.realized).toBeCloseTo(10);
    expect(pnl.closedLots).toHaveLength(1);
    expect(pnl.closedLots[0].side).toBe("short");
    expect(pnl.closedLots[0].returnPct).toBeCloseTo(10);
    expect(pnl.unrealized).toBeCloseTo(-40);
    expect(pnl.openLots).toHaveLength(1);
    expect(pnl.openLots[0].side).toBe("short");
    expect(pnl.openLots[0].quantity).toBeCloseTo(-2); // signed: residual short is negative
  });

  it("a long closed by a partial-then-full sell sequence realizes each chunk with the right returnPct", () => {
    // buy 3@100.
    // sell 1@130 → matched 1: realized 1*(130-100)=+30; returnPct (130-100)/100*100=+30%.
    // sell 2@90  → matched 2: realized 2*(90-100)=-20; returnPct (90-100)/100*100=-10%.
    // total realized = +30 + (-20) = +10; both closed lots are LONG; nothing left open.
    const fills: FillEvent[] = [
      fill({ id: "c-b", side: "buy", quantity: 3, price: 100, notional: 300, filledAt: "2026-06-15T00:00:01.000Z" }),
      fill({ id: "c-s1", side: "sell", quantity: 1, price: 130, notional: 130, filledAt: "2026-06-15T00:00:02.000Z" }),
      fill({ id: "c-s2", side: "sell", quantity: 2, price: 90, notional: 180, filledAt: "2026-06-15T00:00:03.000Z" })
    ];
    const pnl = calculatePnl(fills);
    expect(pnl.realized).toBeCloseTo(10);
    expect(pnl.closedLots).toHaveLength(2);
    expect(pnl.closedLots.map((l) => l.side)).toEqual(["long", "long"]);
    expect(pnl.closedLots[0].returnPct).toBeCloseTo(30);
    expect(pnl.closedLots[1].returnPct).toBeCloseTo(-10);
    expect(pnl.openLots).toHaveLength(0);
  });

  it("an interleaved buy/short/sell/cover on the SAME symbol never cross-consumes lots (the critical FIFO/sign case)", () => {
    // Time order, all AAPL:
    //   buy   1@100  → long lot {q1, p100}
    //   short 1@120  → short lot {q1, p120}
    //   sell  1@130  → closes ONLY the long lot: realized 1*(130-100)=+30; returnPct +30%; side "long".
    //   cover 1@110  → closes ONLY the short lot: realized 1*(120-110)=+10; returnPct (120-110)/120*100=+8.333%; side "short".
    // total realized = +30 + +10 = +40. If sell had consumed the short (or cover the long) at $0,
    // realized would be wrong AND a real open lot would be silently erased — this asserts neither happens.
    const fills: FillEvent[] = [
      fill({ id: "d-b", side: "buy", quantity: 1, price: 100, notional: 100, filledAt: "2026-06-15T00:00:01.000Z" }),
      fill({ id: "d-sh", side: "short", quantity: 1, price: 120, notional: 120, filledAt: "2026-06-15T00:00:02.000Z" }),
      fill({ id: "d-s", side: "sell", quantity: 1, price: 130, notional: 130, filledAt: "2026-06-15T00:00:03.000Z" }),
      fill({ id: "d-cv", side: "cover", quantity: 1, price: 110, notional: 110, filledAt: "2026-06-15T00:00:04.000Z" })
    ];
    const pnl = calculatePnl(fills);
    expect(pnl.realized).toBeCloseTo(40);
    expect(pnl.closedLots).toHaveLength(2);
    // The sell closed the long (FIFO chronological), the cover closed the short — never the reverse.
    expect(pnl.closedLots[0].side).toBe("long");
    expect(pnl.closedLots[0].pnl).toBeCloseTo(30);
    expect(pnl.closedLots[0].returnPct).toBeCloseTo(30);
    expect(pnl.closedLots[1].side).toBe("short");
    expect(pnl.closedLots[1].pnl).toBeCloseTo(10);
    expect(pnl.closedLots[1].returnPct).toBeCloseTo(8.3333, 3);
    expect(pnl.openLots).toHaveLength(0); // both real lots accounted for, none erased or stranded
  });

  it("a cover with no open short contributes 0 realized and leaves the open long untouched (wrong-side/flat close)", () => {
    // buy 1@100 (open long), then cover 1@90 with NO open short → matches nothing → 0 realized, no closed lot.
    // The long lot is unchanged and still marks to market: at current 110 unrealized = 1*(110-100)=+10.
    const fills: FillEvent[] = [
      fill({ id: "e-b", side: "buy", quantity: 1, price: 100, notional: 100, filledAt: "2026-06-15T00:00:01.000Z" }),
      fill({ id: "e-cv", side: "cover", quantity: 1, price: 90, notional: 90, filledAt: "2026-06-15T00:00:02.000Z" })
    ];
    const pnl = calculatePnl(fills, { AAPL: 110 });
    expect(pnl.realized).toBeCloseTo(0);
    expect(pnl.closedLots).toHaveLength(0);
    expect(pnl.openLots).toHaveLength(1);
    expect(pnl.openLots[0].side).toBe("long");
    expect(pnl.openLots[0].quantity).toBeCloseTo(1); // long lot untouched, not consumed at $0
    expect(pnl.openLots[0].entryPrice).toBeCloseTo(100);
    expect(pnl.unrealized).toBeCloseTo(10);
  });

  it("a sell with no open long contributes 0 realized and leaves the open short untouched (mirror of the cover case)", () => {
    // Symmetric counterpart to the cover-with-no-short case: short 1@100 (open short), then sell 1@90 with
    // NO open long → wantSide "long" matches nothing → 0 realized, no closed lot, short lot intact.
    // At current 80 the short marks to market with the short sign: unrealized = 1*(100-80)=+20 (short profits as price falls).
    const fills: FillEvent[] = [
      fill({ id: "f-sh", side: "short", quantity: 1, price: 100, notional: 100, filledAt: "2026-06-15T00:00:01.000Z" }),
      fill({ id: "f-s", side: "sell", quantity: 1, price: 90, notional: 90, filledAt: "2026-06-15T00:00:02.000Z" })
    ];
    const pnl = calculatePnl(fills, { AAPL: 80 });
    expect(pnl.realized).toBeCloseTo(0);
    expect(pnl.closedLots).toHaveLength(0);
    expect(pnl.openLots).toHaveLength(1);
    expect(pnl.openLots[0].side).toBe("short");
    expect(pnl.openLots[0].quantity).toBeCloseTo(-1); // short lot untouched, signed qty negative, not consumed at $0
    expect(pnl.openLots[0].entryPrice).toBeCloseTo(100);
    expect(pnl.unrealized).toBeCloseTo(20);
  });

  it("aggregates unrealized across a residual long AND short on the SAME symbol with correct signs", () => {
    // Both sides left open on AAPL (calculatePnl keeps them as independent same-symbol lots; it does not net):
    //   buy   2@100 → long  {q2, p100}
    //   short 1@200 → short {q1, p200}
    // At current 150: long unrealized = 2*(150-100)=+100; short unrealized = 1*(200-150)=+50; total +150. realized 0.
    const fills: FillEvent[] = [
      fill({ id: "g-b", side: "buy", quantity: 2, price: 100, notional: 200, filledAt: "2026-06-15T00:00:01.000Z" }),
      fill({ id: "g-sh", side: "short", quantity: 1, price: 200, notional: 200, filledAt: "2026-06-15T00:00:02.000Z" })
    ];
    const pnl = calculatePnl(fills, { AAPL: 150 });
    expect(pnl.realized).toBeCloseTo(0);
    expect(pnl.openLots).toHaveLength(2);
    const long = pnl.openLots.find((l) => l.side === "long");
    const short = pnl.openLots.find((l) => l.side === "short");
    expect(long?.quantity).toBeCloseTo(2); // signed positive for the long
    expect(short?.quantity).toBeCloseTo(-1); // signed negative for the short
    expect(pnl.unrealized).toBeCloseTo(150); // +100 long + +50 short, mixed signs aggregated correctly
  });
});

describe("recordFillFromProposal — T9 short/cover boundaries", () => {
  const baseProposal = (over: Record<string, unknown>): TradeProposal =>
    ({
      type: "limit",
      timeInForce: "gfd",
      marketHours: "regular_hours",
      rationale: "t",
      tradeThesisTag: "t",
      entryMarketRegime: "t",
      ...over
    }) as TradeProposal;

  it("records a short fill with the right side, quantity, price, and absolute notional", () => {
    const f = recordFillFromProposal({
      accountNumber: "T9_SHORT",
      source: "paper",
      proposal: baseProposal({ symbol: "TSLA", side: "short", quantity: 2, limitPrice: 100 }),
      status: "filled"
    });
    expect(f.side).toBe("short");
    expect(f.quantity).toBeCloseTo(2);
    // With default-ON execution cost (20 bps base, no spread/volume): short receives DOWN.
    // price = 100 * (1 - 0.002) = 99.8; notional = 2 * 99.8 = 199.6.
    expect(f.price).toBeCloseTo(99.8, 2);
    expect(f.notional).toBeCloseTo(199.6, 1); // notional is always recorded as a positive magnitude
  });

  it("books a cover fill as a partial short close", async () => {
    const { listFillEvents } = await import("../src/lib/db");
    recordFillFromProposal({
      accountNumber: "T9_COVER",
      source: "paper",
      proposal: baseProposal({ symbol: "TSLA", side: "short", quantity: 3, limitPrice: 100 }),
      status: "filled"
    });
    const cover = recordFillFromProposal({
      accountNumber: "T9_COVER",
      source: "paper",
      proposal: baseProposal({ symbol: "TSLA", side: "cover", quantity: 1, limitPrice: 90 }),
      status: "filled"
    });
    expect(cover.side).toBe("cover");
    expect(cover.quantity).toBeCloseTo(1);

    const fills = listFillEvents("T9_COVER", "paper", 100, "local");
    const pnl = calculatePnl(fills, { TSLA: 95 });
    expect(pnl.openLots.find((lot) => lot.symbol === "TSLA")?.quantity).toBeCloseTo(-2); // short 3, covered 1
  });
});

describe("holding-period fields (Task 3 — avgDaysHeld / shortTermPct)", () => {
  it("computes avgDaysHeld and shortTermPct from entryAt/exitAt on closed lots", async () => {
    const { insertFillEvent, audit } = await import("../src/lib/db");
    const account = "HOLDPERIOD1";
    const userId = `hp-${randomUUID()}`;
    const runId = "run-hp-1";

    // Lot A: held 10 days (short-term < 365). runId must match the snapshot audit entry.
    insertFillEvent({ userId, accountNumber: account, source: "paper", symbol: "AAA", side: "buy", quantity: 1, price: 100, notional: 100, status: "filled", runId, filledAt: "2026-01-01T00:00:00.000Z", raw: { proposal: { tradeThesisTag: "T", entryMarketRegime: "R" } } });
    insertFillEvent({ userId, accountNumber: account, source: "paper", symbol: "AAA", side: "sell", quantity: 1, price: 110, notional: 110, status: "filled", filledAt: "2026-01-11T00:00:00.000Z" });
    // Lot B: held ~400 days (long-term >= 365). runId must match the snapshot audit entry.
    insertFillEvent({ userId, accountNumber: account, source: "paper", symbol: "BBB", side: "buy", quantity: 1, price: 100, notional: 100, status: "filled", runId, filledAt: "2025-01-01T00:00:00.000Z", raw: { proposal: { tradeThesisTag: "T", entryMarketRegime: "R" } } });
    insertFillEvent({ userId, accountNumber: account, source: "paper", symbol: "BBB", side: "sell", quantity: 1, price: 90, notional: 90, status: "filled", filledAt: "2026-02-05T00:00:00.000Z" });
    audit("signal_snapshot", {
      runId,
      signals: [
        { symbol: "AAA", chosen: true, factorBreakdown: { liquidity: 5, momentum: 90, value: 20, quality: 10, volatility: 10, sentiment: 15, positioning: 30, diversification: 5, weightedTotal: 60 } },
        { symbol: "BBB", chosen: true, factorBreakdown: { liquidity: 5, momentum: 90, value: 20, quality: 10, volatility: 10, sentiment: 15, positioning: 30, diversification: 5, weightedTotal: 60 } }
      ]
    }, userId);

    const scorecard = getFactorScorecard(account, "paper", {}, userId);
    // Both lots have momentum as dominant factor → one bucket.
    expect(scorecard).toHaveLength(1);
    expect(scorecard[0].factor).toBe("momentum");
    expect(scorecard[0].trades).toBe(2);
    // AAA: 10 days, BBB: ~400 days → avg ≈ 205 days (check within 5 days tolerance).
    expect(scorecard[0].avgDaysHeld).toBeDefined();
    expect(scorecard[0].avgDaysHeld!).toBeGreaterThan(200);
    expect(scorecard[0].avgDaysHeld!).toBeLessThan(215);
    // shortTermPct: 1 out of 2 lots < 365 days = 50%.
    expect(scorecard[0].shortTermPct).toBeCloseTo(50, 0);
  });

  it("returns avgDaysHeld=0 and shortTermPct=100 when lots are closed very quickly", async () => {
    const { insertFillEvent } = await import("../src/lib/db");
    const account = "QUICKCLOSE1";
    // Buy then sell within the same second — avgDaysHeld ≈ 0, still short-term.
    insertFillEvent({ accountNumber: account, source: "paper", symbol: "FAST", side: "buy", quantity: 1, price: 100, notional: 100, status: "filled", filledAt: "2026-06-15T10:00:00.000Z" });
    insertFillEvent({ accountNumber: account, source: "paper", symbol: "FAST", side: "sell", quantity: 1, price: 105, notional: 105, status: "filled", filledAt: "2026-06-15T10:00:01.000Z" });

    const sc = getThesisScorecard(account, "paper");
    expect(sc).toHaveLength(1);
    // avgDaysHeld should be defined and very close to 0 (1 second / 86400 seconds per day).
    expect(sc[0].avgDaysHeld).toBeDefined();
    expect(sc[0].avgDaysHeld!).toBeGreaterThanOrEqual(0);
    expect(sc[0].avgDaysHeld!).toBeLessThan(0.1);
    // shortTermPct: held < 365 days → 100%.
    expect(sc[0].shortTermPct).toBe(100);
  });
});

function fill(input: Partial<FillEvent> & { id: string; side: OrderSide; quantity: number; price: number; notional: number; userId?: string }): FillEvent {
  return {
    proposalId: "p1",
    runId: "r1",
    accountNumber: "A1",
    source: "paper",
    symbol: "AAPL",
    status: "filled",
    brokerOrderId: undefined,
    raw: undefined,
    filledAt: `2026-06-15T00:00:0${input.id === "s1" ? 3 : input.id === "b2" ? 2 : 1}.000Z`,
    ...input
  };
}

function emptyScan(): MarketScan {
  return {
    source: "test",
    generatedAt: "2026-06-15T00:00:00.000Z",
    scannedSymbols: 0,
    returnedQuotes: 0,
    topCandidates: [],
    sectorBySymbol: {},
    quotesBySymbol: {},
    warnings: []
  };
}

function marketScanWithQuote(symbol: string, price: number): MarketScan {
  return {
    ...emptyScan(),
    scannedSymbols: 1,
    returnedQuotes: 1,
    quotesBySymbol: {
      [symbol]: {
        symbol,
        price,
        score: 0
      }
    }
  };
}

describe("PrefetchedFills optimization", () => {
  it("uses prefetched fills instead of calling listFillEvents when supplied", async () => {
    const db = await import("../src/lib/db");
    const spy = vi.spyOn(db, "listFillEvents");
    
    const prefetched: PrefetchedFills = {
      liveFills: [
        fill({ id: "b1", side: "buy", quantity: 1, price: 100, notional: 100, accountNumber: "PREFETCH1", symbol: "AAPL" }),
        fill({ id: "s1", side: "sell", quantity: 1, price: 110, notional: 110, accountNumber: "PREFETCH1", symbol: "AAPL" })
      ],
      paperFills: []
    };

    spy.mockClear();

    // Call all the optimized scorecards with prefetched fills
    getSectorScorecard("PREFETCH1", "live", {}, "local", prefetched);
    getThesisRegimeScorecard("PREFETCH1", "live", {}, "local", prefetched);
    getClosedLotCount("PREFETCH1", "live", "local", prefetched);
    getSignalEfficacy("PREFETCH1", "live", {}, "local", prefetched);
    getFactorScorecard("PREFETCH1", "live", {}, "local", undefined, prefetched);
    getConfidenceCalibration("PREFETCH1", "live", {}, "local", prefetched);

    // listFillEvents should not have been called!
    expect(spy).not.toHaveBeenCalled();

    // Call without prefetched and listFillEvents should be called
    spy.mockClear();
    getSectorScorecard("PREFETCH1", "live", {}, "local");
    expect(spy).toHaveBeenCalled();

    spy.mockRestore();
  });
});
