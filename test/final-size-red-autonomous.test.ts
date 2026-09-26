import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_POLICY } from "../src/lib/defaults";
import type { BrokerGateway, MarketQuote, MarketScan } from "../src/lib/types";

const { debateProposal, reviewEquityOrder, placeEquityOrder, rationaleDiversityState, brokerFailureState, accountState, marketState } = vi.hoisted(() => ({
  debateProposal: vi.fn(),
  reviewEquityOrder: vi.fn(),
  placeEquityOrder: vi.fn(),
  rationaleDiversityState: { collapsed: false },
  brokerFailureState: { placementAttempted: false, ordersUnreachable: false },
  accountState: {
    buyingPower: 100,
    cash: 100,
    positions: [] as Array<{ symbol: string; quantity: number; averageCost: number; marketValue: number }>
  },
  marketState: { symbols: ["AAPL"] }
}));

vi.mock("../src/lib/red-team", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/red-team")>();
  return { ...actual, debateProposal };
});

vi.mock("../src/lib/rationale-diversity", () => ({
  computeRationaleDiversity: (rationales: string[]) => ({
    count: rationales.length,
    meanPairwiseSimilarity: rationaleDiversityState.collapsed ? 0.99 : 0,
    maxPairwiseSimilarity: rationaleDiversityState.collapsed ? 0.99 : 0,
    collapsed: rationaleDiversityState.collapsed,
    threshold: 0.85
  })
}));

vi.mock("../src/lib/vector-db", () => ({
  managedVectorLedgerAuthority: vi.fn(),
  getCurrentVectorProviderAuthority: vi.fn(),
  findRelevantExperiences: async () => [],
  upsertExperiences: async () => {},
  retrieveContext: async () => [],
  retrieveContextDetailed: async () => [],
  defaultMinScore: () => 0.3,
  defaultRelevanceFloor: () => 0.3,
  defaultDedupeSimilarity: () => 0.6,
  formatChunkWithProvenance: (chunk: { text: string }) => chunk.text,
  storeContext: async () => {},
  storeContexts: async () => {}
}));

vi.mock("../src/lib/approval-quote-scan", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/approval-quote-scan")>();
  return {
    ...actual,
    loadApprovalQuoteScan: async () =>
      actual.buildApprovalQuoteScan(
        { AAPL: { symbol: "AAPL", price: 200, bid: 199, ask: 200, provider: "test-scan" } },
        []
      )
  };
});

vi.mock("../src/lib/market", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/market")>();
  return {
    ...actual,
    scanMarket: async (): Promise<MarketScan> => {
      const asOf = new Date().toISOString();
      const quotes: MarketQuote[] = marketState.symbols.map((symbol) => ({
        symbol,
        price: symbol === "AAPL" ? 10 : 1,
        bid: symbol === "AAPL" ? 9.99 : 1,
        ask: symbol === "AAPL" ? 10 : 1,
        volume: 1_000_000,
        intradayChangePct: 0.5,
        positionMarketValue: 0,
        score: 80,
        provider: "test-scan",
        asOf
      }));
      return {
        source: "test-scan",
        generatedAt: asOf,
        scannedSymbols: quotes.length,
        returnedQuotes: quotes.length,
        topCandidates: quotes,
        sectorBySymbol: Object.fromEntries(quotes.map((quote) => [quote.symbol, "Technology"])),
        quotesBySymbol: Object.fromEntries(quotes.map((quote) => [quote.symbol, quote])),
        warnings: []
      };
    }
  };
});

const ACCOUNT = "RH-AUTONOMOUS-FINAL-SIZE";

function gateway(): BrokerGateway {
  return {
    getAccounts: async () => [{ accountNumber: ACCOUNT, label: "Autonomous final-size test", agenticAllowed: true }],
    getPortfolio: async () => ({
      accountNumber: ACCOUNT,
      totalMarketValue: 100,
      buyingPower: accountState.buyingPower,
      equityMarketValue: 0,
      optionMarketValue: 0,
      cash: accountState.cash
    }),
    getEquityPositions: async () => accountState.positions,
    getEquityOrders: async () => {
      if (brokerFailureState.placementAttempted && brokerFailureState.ordersUnreachable) {
        throw new Error("broker unreachable after placement timeout");
      }
      return [];
    },
    getEquityQuotes: async (_account, symbols) => Object.fromEntries(symbols.map((symbol) => [
      symbol,
      {
        symbol,
        bid: symbol === "AAPL" ? 9.99 : 1,
        ask: symbol === "AAPL" ? 10 : 1,
        asOf: new Date().toISOString()
      }
    ])),
    getEquityTradability: async (_account, symbols) =>
      Object.fromEntries(symbols.map((symbol) => [symbol, { tradable: true, fractional: true }])),
    reviewEquityOrder,
    placeEquityOrder,
    cancelEquityOrder: async () => ({ orderId: randomUUID(), refId: randomUUID(), state: "cancelled", raw: {} })
  };
}

vi.mock("../src/lib/broker", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/broker")>();
  return { ...actual, getBrokerGateway: () => gateway() };
});

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-final-size-autonomous-${randomUUID()}.db`)}`;
  debateProposal.mockReset();
  reviewEquityOrder.mockReset();
  placeEquityOrder.mockReset();
  rationaleDiversityState.collapsed = false;
  brokerFailureState.placementAttempted = false;
  brokerFailureState.ordersUnreachable = false;
  accountState.buyingPower = 100;
  accountState.cash = 100;
  accountState.positions = [];
  marketState.symbols = ["AAPL"];
});

function stubGreenProposals(proposals: Array<{ symbol: string; dollarAmount: number }>): void {
  vi.stubGlobal("fetch", async (url: string | URL | Request) => {
    const href = String(url);
    if (href.includes("openrouter.ai") || href.includes("api.openai.com")) {
      return new Response(
        JSON.stringify({
          output_text: JSON.stringify({
            proposals: proposals.map((proposal) => ({
                symbol: proposal.symbol,
                side: "buy",
                type: "market",
                dollarAmount: proposal.dollarAmount,
                timeInForce: "gfd",
                marketHours: "regular_hours",
                rationale: "Small-account value setup.",
                tradeThesisTag: "Value-Quality",
                entryMarketRegime: "Neutral (Normal Volatility)",
                confidenceScore: 75
              }))
          })
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    return new Response("not found", { status: 404 });
  });
}

function stubGreenProposalResponse(dollarAmount: number = 0.25): void {
  stubGreenProposals([{ symbol: "AAPL", dollarAmount }]);
}

async function configureAutonomousAccount(
  userId: string,
  gateOnRationaleCollapse: boolean = false,
  sellToFundBuy: "off" | "suggest" | "propose" | "automated" = "off"
): Promise<void> {
  const { setPolicy, upsertConnectedAccount, upsertUserApiKey } = await import("../src/lib/db");
  upsertConnectedAccount({
    id: "autonomous-final-size-account",
    userId,
    broker: "robinhood",
    environment: "paper",
    accountNumber: ACCOUNT,
    label: "Autonomous final-size account",
    isActive: true
  });
  upsertUserApiKey(userId, "openrouter", "test-openai-key", "test fixture");
  setPolicy(
    {
      ...DEFAULT_POLICY,
      accountNumber: ACCOUNT,
      connectedAccountId: "autonomous-final-size-account",
      activeBroker: "robinhood",
      systemState: "active",
      strategyAuthority: "decide",
      llmModel: "openai/gpt-4.1-mini",
      redTeamLlmModel: "gpt-5.6-terra",
      includedIndices: [],
      additionalSymbols: marketState.symbols,
      sellToFundBuy,
      tuning: { ...DEFAULT_POLICY.tuning, gateOnRationaleCollapse }
    },
    userId
  );
}

describe("autonomous broker-minimum final-size Red review", () => {
  it("does not emit or execute funding sells when the pre-funded buy fails final-size Red review", async () => {
    accountState.buyingPower = 0;
    accountState.cash = 0;
    accountState.positions = [{ symbol: "MSFT", quantity: 10, averageCost: 1, marketValue: 10 }];
    debateProposal
      .mockResolvedValueOnce({
        verdict: "approve",
        rejected: false,
        available: true,
        reason: "Initial size approved.",
        model: "gpt-5.6-terra"
      })
      .mockResolvedValueOnce({
        verdict: "reject",
        rejected: true,
        available: true,
        reason: "The broker-adjusted size is not justified.",
        model: "gpt-5.6-terra"
      });
    let aaplReviewCount = 0;
    reviewEquityOrder.mockImplementation(async (input: {
      symbol: string;
      dollarAmount?: number;
      quantity?: number;
    }) => {
      const estimatedNotional = input.dollarAmount ?? (input.quantity ?? 0) * (input.symbol === "AAPL" ? 10 : 1);
      if (input.symbol === "AAPL") aaplReviewCount += 1;
      return input.symbol === "AAPL" && aaplReviewCount === 1
        ? {
            estimatedNotional: 0.25,
            alerts: [],
            preflightBlock: {
              alertTypes: ["EQUITY_DOLLAR_BASED_MINIMUM_AMOUNT_ERROR"],
              message: "below broker minimum"
            },
            raw: {}
          }
        : { estimatedNotional, alerts: [], raw: {} };
    });
    placeEquityOrder.mockResolvedValue({
      orderId: randomUUID(),
      refId: randomUUID(),
      state: "filled",
      raw: {}
    });
    stubGreenProposalResponse();
    const userId = `autonomous-final-size-funding-${randomUUID()}`;
    await configureAutonomousAccount(userId, false, "automated");

    const { runStrategyOnce } = await import("../src/lib/strategy");
    const { listAudit, listRecentProposals } = await import("../src/lib/db");
    const result = await runStrategyOnce(userId);

    expect(result.status).toBe("completed");
    expect(placeEquityOrder).not.toHaveBeenCalled();
    expect(listRecentProposals(ACCOUNT, 20, userId).some(
      (row) => row.proposal.tradeThesisTag === "Sell-to-Fund"
    )).toBe(false);
    expect(listAudit(100, userId).some((event) => event.kind === "sell_to_fund_plan")).toBe(false);
    expect(listRecentProposals(ACCOUNT, 20, userId).find(
      (row) => row.proposal.symbol === "AAPL"
    )).toMatchObject({ status: "proposed" });
    expect(aaplReviewCount).toBe(2);
    expect(debateProposal).toHaveBeenCalledTimes(2);
  }, 30_000);

  it("funds a cumulative buying-power shortfall and reuses each prepared broker shape", async () => {
    accountState.buyingPower = 2;
    accountState.cash = 100;
    accountState.positions = [{ symbol: "MSFT", quantity: 10, averageCost: 1, marketValue: 10 }];
    marketState.symbols = ["AAPL", "GOOG"];
    debateProposal.mockResolvedValue({
      verdict: "approve",
      rejected: false,
      available: true,
      reason: "The proposed size is justified.",
      model: "gpt-5.6-terra"
    });
    const reviewCounts = new Map<string, number>();
    reviewEquityOrder.mockImplementation(async (input: {
      symbol: string;
      dollarAmount?: number;
      quantity?: number;
    }) => {
      reviewCounts.set(input.symbol, (reviewCounts.get(input.symbol) ?? 0) + 1);
      return {
        estimatedNotional:
          input.dollarAmount ?? (input.quantity ?? 0) * (input.symbol === "AAPL" ? 10 : 1),
        alerts: [],
        raw: {}
      };
    });
    placeEquityOrder.mockImplementation(async (input: { quantity?: number }) => ({
      orderId: randomUUID(),
      refId: randomUUID(),
      state: "filled",
      filledQuantity: input.quantity,
      averagePrice: 1,
      raw: {}
    }));
    stubGreenProposals([
      { symbol: "AAPL", dollarAmount: 2 },
      { symbol: "GOOG", dollarAmount: 1 }
    ]);
    const userId = `autonomous-final-size-buying-power-${randomUUID()}`;
    await configureAutonomousAccount(userId, false, "automated");

    const { runStrategyOnce } = await import("../src/lib/strategy");
    const { listAudit } = await import("../src/lib/db");
    const result = await runStrategyOnce(userId);

    expect(result.status).toBe("completed");
    expect(placeEquityOrder).toHaveBeenCalledTimes(3);
    expect(placeEquityOrder.mock.calls.map((call) => call[0])).toContainEqual(expect.objectContaining({
      symbol: "MSFT",
      side: "sell",
      quantity: 1
    }));
    expect(placeEquityOrder.mock.calls.map((call) => call[0].symbol).sort()).toEqual([
      "AAPL",
      "GOOG",
      "MSFT"
    ]);
    expect(reviewCounts.get("AAPL")).toBe(1);
    expect(reviewCounts.get("GOOG")).toBe(1);
    expect(debateProposal).toHaveBeenCalledTimes(2);
    expect(listAudit(100, userId).some((event) => event.kind === "sell_to_fund_plan")).toBe(true);
  }, 30_000);

  it("reruns Red on the broker-reviewed order, persists the new rejection, and routes to approval without placement", async () => {
    debateProposal
      .mockResolvedValueOnce({
        verdict: "approve",
        rejected: false,
        available: true,
        reason: "Initial finalized size is acceptable.",
        model: "gpt-5.6-terra"
      })
      .mockResolvedValueOnce({
        verdict: "reject",
        rejected: true,
        available: true,
        reason: "The broker-adjusted order is not justified.",
        model: "gpt-5.6-terra"
      });
    reviewEquityOrder
      .mockResolvedValueOnce({
        estimatedNotional: 0.25,
        alerts: [],
        preflightBlock: {
          alertTypes: ["EQUITY_DOLLAR_BASED_MINIMUM_AMOUNT_ERROR"],
          message: "below broker minimum"
        },
        raw: {}
      })
      .mockImplementation(async (input: { dollarAmount?: number; quantity?: number }) => ({
        estimatedNotional: input.dollarAmount ?? (input.quantity ?? 0) * 10,
        alerts: [],
        raw: {}
      }));
    placeEquityOrder.mockResolvedValue({ orderId: randomUUID(), refId: randomUUID(), state: "filled", raw: {} });

    stubGreenProposalResponse();

    const userId = `autonomous-final-size-${randomUUID()}`;
    await configureAutonomousAccount(userId);

    const { runStrategyOnce } = await import("../src/lib/strategy");
    const { listAudit, listRecentProposals } = await import("../src/lib/db");
    const result = await runStrategyOnce(userId);

    expect(result.status).toBe("completed");
    expect(debateProposal).toHaveBeenCalledTimes(2);
    const finalReviewInput = debateProposal.mock.calls[1][0];
    expect(finalReviewInput.rationale).toBe("Small-account value setup.");
    expect(finalReviewInput.redTeamVerdict).toBeUndefined();
    expect(debateProposal.mock.calls[1][4]?.sizing).toMatchObject({ estimatedNotional: 1, estimatedPctOfNav: 1 });
    expect(placeEquityOrder).not.toHaveBeenCalled();

    const row = listRecentProposals(ACCOUNT, 20, userId).find((candidate) => candidate.proposal.symbol === "AAPL");
    expect(row?.status).toBe("proposed");
    // lane G3: a final_size_red_team hold classifies as the "red_team_unavailable" holdReason
    // bucket (see hold-reason.ts — it covers both "could not run" and "ran but needs a decision").
    expect(row?.proposal.holdReason).toBe("red_team_unavailable");
    expect(row?.proposal.redTeamVerdict).toMatchObject({
      verdict: "reject",
      rejected: true,
      reason: "The broker-adjusted order is not justified."
    });
    expect(row?.proposal.finalSizeReview).toMatchObject({
      trigger: "broker_minimum_bump",
      fromNotional: 0.25,
      toNotional: 1,
      ownerApprovalRequired: true
    });
    expect(row?.proposal.sizingSnapshot).toMatchObject({ estimatedNotional: 1, estimatedPctOfNav: 1 });
    expect(listAudit(100, userId).filter((event) => event.kind === "red_team_rereview_after_broker_minimum")).toHaveLength(1);
  }, 30_000);

  it("persists proposal intent and its Socratic case atomically before broker submission, then places after final-size approval", async () => {
    debateProposal
      .mockResolvedValueOnce({ verdict: "approve", rejected: false, available: true, reason: "Initial size approved.", model: "gpt-5.6-terra" })
      .mockResolvedValueOnce({ verdict: "approve", rejected: false, available: true, reason: "Broker-adjusted size approved.", model: "gpt-5.6-terra" });
    reviewEquityOrder
      .mockResolvedValueOnce({
        estimatedNotional: 0.25,
        alerts: [],
        preflightBlock: { alertTypes: ["EQUITY_DOLLAR_BASED_MINIMUM_AMOUNT_ERROR"], message: "below broker minimum" },
        raw: {}
      })
      .mockImplementation(async (input: { dollarAmount?: number; quantity?: number }) => ({
        estimatedNotional: input.dollarAmount ?? (input.quantity ?? 0) * 10,
        alerts: [],
        raw: {}
      }));
    stubGreenProposalResponse();
    const userId = `autonomous-final-size-place-${randomUUID()}`;
    await configureAutonomousAccount(userId);
    placeEquityOrder.mockImplementation(async () => {
      const { listRecentProposals, listSocraticDecisionCases } = await import("../src/lib/db");
      expect(listRecentProposals(ACCOUNT, 10, userId)[0]?.status).toBe("placing");
      expect(listSocraticDecisionCases(userId, { connectedAccountId: "autonomous-final-size-account" })[0]?.status).toBe("placing");
      return {
        orderId: randomUUID(),
        refId: randomUUID(),
        state: "filled",
        filledQuantity: 0.1,
        averagePrice: 10,
        raw: {}
      };
    });

    const { runStrategyOnce } = await import("../src/lib/strategy");
    const { listRecentProposals, listSocraticDecisionCases } = await import("../src/lib/db");
    const result = await runStrategyOnce(userId);

    expect(result.status).toBe("completed");
    expect(placeEquityOrder).toHaveBeenCalledTimes(1);
    expect(listRecentProposals(ACCOUNT, 10, userId)[0]).toMatchObject({ status: "filled", estimatedNotional: 1 });
    expect(listSocraticDecisionCases(userId, { connectedAccountId: "autonomous-final-size-account" })[0]).toMatchObject({ status: "filled", notional: 1 });
  }, 30_000);

  it("does not clear an independent rationale-collapse hold when final-size Red approves", async () => {
    rationaleDiversityState.collapsed = true;
    debateProposal
      .mockResolvedValueOnce({ verdict: "approve", rejected: false, available: true, reason: "Initial size approved.", model: "gpt-5.6-terra" })
      .mockResolvedValueOnce({ verdict: "approve", rejected: false, available: true, reason: "Broker-adjusted size approved.", model: "gpt-5.6-terra" });
    reviewEquityOrder
      .mockResolvedValueOnce({
        estimatedNotional: 0.25,
        alerts: [],
        preflightBlock: { alertTypes: ["EQUITY_DOLLAR_BASED_MINIMUM_AMOUNT_ERROR"], message: "below broker minimum" },
        raw: {}
      })
      .mockImplementation(async (input: { dollarAmount?: number; quantity?: number }) => ({
        estimatedNotional: input.dollarAmount ?? (input.quantity ?? 0) * 10,
        alerts: [],
        raw: {}
      }));
    stubGreenProposalResponse();
    const userId = `autonomous-final-size-held-${randomUUID()}`;
    await configureAutonomousAccount(userId, true);

    const { runStrategyOnce } = await import("../src/lib/strategy");
    const { listNotificationEvents, listRecentProposals, listSocraticDecisionCases } = await import("../src/lib/db");
    const result = await runStrategyOnce(userId);

    expect(result.status).toBe("completed");
    expect(placeEquityOrder).not.toHaveBeenCalled();
    const row = listRecentProposals(ACCOUNT, 10, userId)[0];
    expect(row?.status).toBe("proposed");
    expect(row?.proposal.finalSizeReview).toMatchObject({ ownerApprovalRequired: false, toNotional: 1 });
    expect(row?.proposal.rationale).toContain("Rationale-diversity gate");
    expect(row?.proposal.humanReviewReasons).toEqual([
      expect.objectContaining({ code: "rationale_collapse", title: "Rationale-diversity hold" })
    ]);
    // lane G3: a standalone rationale_collapse hold (no Red-Team or policy-override code present)
    // classifies as the "other" holdReason bucket — it is neither Red-Team- nor policy-related.
    expect(row?.proposal.holdReason).toBe("other");
    expect(result.proposals[0]?.reasons.join(" ")).toContain("Rationale-diversity hold");
    expect(result.proposals[0]?.reasons.join(" ")).not.toContain("Red Team review unavailable");
    expect(listNotificationEvents(userId).find((event) => event.type === "pending_approval")?.title).toContain("Rationale-diversity hold");
    expect(listSocraticDecisionCases(userId, { connectedAccountId: "autonomous-final-size-account" })[0]).toMatchObject({ status: "proposed" });
  }, 30_000);

  it("keeps both proposal and Socratic case in placing when autonomous broker acceptance is uncertain", async () => {
    debateProposal
      .mockResolvedValueOnce({ verdict: "approve", rejected: false, available: true, reason: "Initial size approved.", model: "gpt-5.6-terra" })
      .mockResolvedValueOnce({ verdict: "approve", rejected: false, available: true, reason: "Broker-adjusted size approved.", model: "gpt-5.6-terra" });
    reviewEquityOrder
      .mockResolvedValueOnce({
        estimatedNotional: 0.25,
        alerts: [],
        preflightBlock: { alertTypes: ["EQUITY_DOLLAR_BASED_MINIMUM_AMOUNT_ERROR"], message: "below broker minimum" },
        raw: {}
      })
      .mockImplementation(async (input: { dollarAmount?: number; quantity?: number }) => ({
        estimatedNotional: input.dollarAmount ?? (input.quantity ?? 0) * 10,
        alerts: [],
        raw: {}
      }));
    brokerFailureState.ordersUnreachable = true;
    placeEquityOrder.mockImplementation(async () => {
      brokerFailureState.placementAttempted = true;
      throw new Error("network timeout during placement");
    });
    stubGreenProposalResponse();
    const userId = `autonomous-uncertain-${randomUUID()}`;
    await configureAutonomousAccount(userId);

    const { runStrategyOnce } = await import("../src/lib/strategy");
    const { listRecentProposals, listSocraticDecisionCases } = await import("../src/lib/db");
    const result = await runStrategyOnce(userId);

    expect(result.status).toBe("completed");
    expect(listRecentProposals(ACCOUNT, 10, userId)[0]?.status).toBe("placing");
    const decisionCase = listSocraticDecisionCases(userId, { connectedAccountId: "autonomous-final-size-account" })[0];
    expect(decisionCase?.status).toBe("placing");
    expect(decisionCase?.evidence[0]).toMatchObject({ title: "Placement pending confirmation" });
    expect(decisionCase?.evidence[0]?.summary).toContain("network timeout during placement");
    expect(decisionCase?.evidence[0]?.title).not.toBe("Policy approved");
  }, 30_000);
});
