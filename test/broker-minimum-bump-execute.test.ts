/**
 * Integration tests for broker-minimum BUMP-TO-FLOOR on the approval path (executeProposal):
 * owner ruling 2026-07-09 — a below-minimum order is resized UP to the broker floor (default
 * brokerMinimumHandling "bump"), re-reviewed once, and placed; bumps the planner can't make
 * safe/executable fall back to the cooldown-gated skip path BEFORE any re-review, so a bump can
 * never manufacture a policy rejection (which would demote authority via autoRevertOnCapBreach).
 * These tests drive the REAL executeProposal through a mocked BrokerGateway (activeBroker
 * "robinhood", $1 floor) and pin the wiring the planner unit suite can't see: the audit record,
 * execution-time sizing persisted to the row, cap/count/buying-power bump-eligibility declines,
 * the still-blocked one-shot fallback, and the "skip" off-switch.
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_POLICY } from "../src/lib/defaults";
import type { MarketQuote, MarketScan, ReviewedOrder } from "../src/lib/types";

const { debateProposal } = vi.hoisted(() => ({ debateProposal: vi.fn() }));

vi.mock("../src/lib/red-team", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/red-team")>();
  return { ...actual, debateProposal };
});

vi.mock("../src/lib/vector-db", () => ({
  managedVectorLedgerAuthority: vi.fn(),
  getCurrentVectorProviderAuthority: vi.fn(),
  findRelevantExperiences: async () => [],
  upsertExperiences: async () => {},
  retrieveContext: async () => [],
  storeContext: async () => {},
  storeContexts: async () => {}
}));

// Stub ONLY scanMarket (same rationale as order-confirmation-status.test.ts): left real it fans
// out to live Nasdaq/Yahoo fetches with multi-second abort timeouts and flakes the suite.
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
      const aapl: MarketQuote = {
        symbol: "AAPL",
        price: 200,
        bid: 199,
        ask: 200,
        volume: 1_000_000,
        intradayChangePct: 0,
        positionMarketValue: 0,
        score: 1,
        provider: "test-scan",
        asOf
      };
      return {
        source: "test-scan",
        generatedAt: asOf,
        scannedSymbols: 1,
        returnedQuotes: 1,
        topCandidates: [aapl],
        sectorBySymbol: {},
        quotesBySymbol: { AAPL: aapl },
        warnings: []
      };
    }
  };
});

const ACCOUNT = "RH-BUMP-TEST";

// Gateway mock with full control of reviewEquityOrder — the bump planner derives everything from
// the review's estimatedNotional, so echoing dollarAmount back as the estimate makes it exact.
const reviewEquityOrder = vi.fn();
const placeEquityOrder = vi.fn();
let portfolioOverrides: Record<string, number> = {};
function makeGateway() {
  return {
    getAccounts: async () => [{ accountNumber: ACCOUNT, type: "brokerage" }],
    getPortfolio: async () => ({
      accountNumber: ACCOUNT,
      totalMarketValue: 5000,
      buyingPower: 2500,
      equityMarketValue: 5000,
      optionMarketValue: 0,
      cash: 2500,
      ...portfolioOverrides
    }),
    getEquityPositions: async () => [],
    getEquityOrders: async () => [],
    getEquityQuotes: async () => ({ AAPL: { bid: 199, ask: 200, asOf: new Date().toISOString() } }),
    getEquityTradability: async (_acc: string, symbols: string[]) =>
      Object.fromEntries(symbols.map((s) => [s, { tradable: true, fractional: true }])),
    reviewEquityOrder,
    placeEquityOrder,
    cancelEquityOrder: async () => ({ ok: true })
  };
}

vi.mock("../src/lib/broker", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/broker")>();
  return { ...actual, getBrokerGateway: () => makeGateway() };
});

function echoReview(input: { dollarAmount?: number; quantity?: number }): ReviewedOrder {
  return { estimatedNotional: input.dollarAmount ?? (input.quantity ?? 0) * 200, alerts: [], raw: {} };
}

async function seedApprovedProposal(userId: string, policyOverrides: Record<string, unknown> = {}): Promise<string> {
  const { upsertConnectedAccount, setPolicy, insertProposal } = await import("../src/lib/db");
  upsertConnectedAccount({
    id: "acc-bump-test",
    userId,
    broker: "robinhood",
    environment: "paper", // identical placeEquityOrder path without the typed live-confirmation gate
    accountNumber: ACCOUNT,
    isActive: true,
    label: "Robinhood Bump Test"
  });
  setPolicy(
    {
      ...DEFAULT_POLICY,
      accountNumber: ACCOUNT,
      connectedAccountId: "acc-bump-test",
      activeBroker: "robinhood",
      systemState: "active",
      maxDailyNotional: 5_000,
      maxOrderNotional: 100,
      ...policyOverrides
    },
    userId
  );
  const proposalId = randomUUID();
  insertProposal({
    id: proposalId,
    runId: randomUUID(),
    accountNumber: ACCOUNT,
    userId,
    proposal: {
      symbol: "AAPL",
      side: "buy",
      type: "market",
      dollarAmount: 0.25, // below Robinhood's $1 floor
      timeInForce: "gfd",
      marketHours: "regular_hours",
      rationale: "bump-to-floor integration test",
      tradeThesisTag: "Momentum-Breakout",
      entryMarketRegime: "Neutral (Normal Volatility)"
    },
    decision: { approved: true, reasons: [] },
    status: "proposed"
  });
  return proposalId;
}

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  reviewEquityOrder.mockReset();
  placeEquityOrder.mockReset();
  debateProposal.mockReset();
  debateProposal.mockResolvedValue({
    verdict: "approve",
    rejected: false,
    available: true,
    reason: "Final broker-adjusted size remains sound.",
    model: "gpt-5.6-terra"
  });
  portfolioOverrides = {};
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-broker-min-bump-exec-${randomUUID()}.db`)}`;
});

describe("executeProposal — broker-minimum bump-to-floor wiring", () => {
  it("bumps a below-minimum dollar buy to the $1 floor, re-reviews once, places at the bumped size, audits it, and persists the executed sizing to the row", async () => {
    reviewEquityOrder.mockImplementation(async (i) => echoReview(i));
    placeEquityOrder.mockImplementation(async (i) => ({ orderId: `ord-${randomUUID()}`, state: "confirmed", raw: {}, ...i }));

    const userId = `bump-happy-${randomUUID()}`;
    const proposalId = await seedApprovedProposal(userId);
    const { executeProposal } = await import("../src/lib/strategy");
    const { getProposal, listAudit } = await import("../src/lib/db");

    const result = await executeProposal(proposalId, userId);

    expect(result.status).toBe("placed");
    // Exactly two reviews: original ($0.25) then the bumped order ($1, quantity cleared).
    expect(reviewEquityOrder).toHaveBeenCalledTimes(2);
    expect(reviewEquityOrder.mock.calls[1][0]).toMatchObject({ dollarAmount: 1 });
    expect(reviewEquityOrder.mock.calls[1][0].quantity).toBeUndefined();
    // Placement went out at the bumped size, not the original.
    expect(placeEquityOrder).toHaveBeenCalledTimes(1);
    expect(placeEquityOrder.mock.calls[0][0]).toMatchObject({ dollarAmount: 1 });
    // Audit trail records original -> bumped.
    const bumpEvents = listAudit(50, userId).filter((e) => e.kind === "order_bumped_broker_minimum");
    expect(bumpEvents.length).toBe(1);
    const detail = bumpEvents[0].payload as Record<string, unknown>;
    expect(detail.fromNotional).toBeCloseTo(0.25);
    expect(detail.toNotional).toBeCloseTo(1);
    expect(detail.action).toBe("approval");
    // The stored row's proposal JSON reflects the EXECUTED (bumped) sizing — crash-recovery
    // (flagStalePlacingIntents) books fills from this JSON, so it must match what was sent.
    const row = getProposal(proposalId, userId);
    expect(row?.proposal?.dollarAmount).toBe(1);
    expect(row?.proposal?.rationale).toContain("Sized up from $0.25");
    expect(row?.proposal?.sizingSnapshot).toMatchObject({
      estimatedNotional: 1,
      estimatedPctOfNav: 0.02,
      sizeBasis: "notional",
      dollarAmount: 1
    });
    expect(row?.proposal?.finalSizeReview).toMatchObject({
      trigger: "broker_minimum_bump",
      fromNotional: 0.25,
      toNotional: 1,
      ownerApprovalRequired: false
    });
    expect(debateProposal).toHaveBeenCalledTimes(1);
    expect(debateProposal.mock.calls[0][0].redTeamVerdict).toBeUndefined();
    expect(debateProposal.mock.calls[0][4]?.sizing).toMatchObject({
      estimatedNotional: 1,
      estimatedPctOfNav: 0.02
    });
  });

  it("persists a fresh Red rejection against the bumped size, then consumes one explicit owner override without rerunning or looping", async () => {
    reviewEquityOrder.mockImplementation(async (i) => echoReview(i));
    placeEquityOrder.mockImplementation(async (i) => ({ orderId: `ord-${randomUUID()}`, state: "confirmed", raw: {}, ...i }));
    debateProposal.mockResolvedValue({
      verdict: "reject",
      rejected: true,
      available: true,
      reason: "The broker floor makes this position too large for the thesis.",
      model: "gpt-5.6-terra"
    });

    const userId = `bump-red-reject-${randomUUID()}`;
    const proposalId = await seedApprovedProposal(userId);
    const { executeProposal } = await import("../src/lib/strategy");
    const { getProposal, listAudit } = await import("../src/lib/db");

    const first: Error = await executeProposal(proposalId, userId).then(
      (v) => { throw new Error(`expected throw, got ${JSON.stringify(v)}`); },
      (e) => e
    );
    expect(first.message).toContain("Red rejected the final broker-adjusted size");
    expect(placeEquityOrder).not.toHaveBeenCalled();
    expect(debateProposal).toHaveBeenCalledTimes(1);

    const pending = getProposal(proposalId, userId);
    expect(pending?.proposal.dollarAmount).toBe(1);
    expect(pending?.estimatedNotional).toBe(1);
    expect(pending?.proposal.finalSizeReview?.ownerApprovalRequired).toBe(true);
    expect(pending?.proposal.redTeamVerdict).toMatchObject({ verdict: "reject", rejected: true });
    expect(pending?.proposal.redTeamVerdict?.humanOverrideApplied).toBeUndefined();

    const second = await executeProposal(proposalId, userId);
    expect(second.status).toBe("placed");
    expect(placeEquityOrder).toHaveBeenCalledTimes(1);
    expect(placeEquityOrder.mock.calls[0][0]).toMatchObject({ dollarAmount: 1 });
    expect(debateProposal).toHaveBeenCalledTimes(1);

    const placed = getProposal(proposalId, userId);
    expect(placed?.decision.approved).toBe(true);
    expect(placed?.proposal.finalSizeReview).toMatchObject({
      ownerApprovalRequired: false,
      ownerApprovalReason: expect.stringContaining("Red rejected"),
      ownerOverrideAppliedAt: expect.any(String)
    });
    expect(placed?.proposal.redTeamVerdict?.humanOverrideApplied).toBe(true);
    expect(listAudit(100, userId).filter((event) => event.kind === "final_size_red_review_owner_override")).toHaveLength(1);
  });

  it("does not consume final-size consent after a material upward requote; it shows the new notional and requires one fresh click", async () => {
    reviewEquityOrder.mockImplementation(async (input) => ({
      estimatedNotional: input.dollarAmount ?? (input.quantity ?? 0) * 204,
      alerts: [],
      raw: {}
    }));
    placeEquityOrder.mockImplementation(async (input) => ({
      orderId: `ord-${randomUUID()}`,
      state: "confirmed",
      raw: {},
      ...input
    }));

    const userId = `bump-red-requote-${randomUUID()}`;
    const proposalId = await seedApprovedProposal(userId);
    const { executeProposal } = await import("../src/lib/strategy");
    const { getProposal, listAudit, updatePendingProposalReprice } = await import("../src/lib/db");
    const seeded = getProposal(proposalId, userId)!;
    updatePendingProposalReprice(
      proposalId,
      {
        proposal: {
          ...seeded.proposal,
          quantity: 0.005,
          dollarAmount: undefined,
          finalSizeReview: {
            trigger: "broker_minimum_bump",
            fromNotional: 0.25,
            toNotional: 1,
            reviewedAt: new Date().toISOString(),
            ownerApprovalRequired: true,
            ownerApprovalReason: "Red rejected the final broker-adjusted size.",
            ownerApprovalNotional: 1
          },
          redTeamVerdict: {
            verdict: "reject",
            rejected: true,
            available: true,
            reason: "The broker floor makes this position too large for the thesis."
          }
        },
        estimatedNotional: 1
      },
      userId
    );

    const first: Error = await executeProposal(proposalId, userId).then(
      (v) => { throw new Error(`expected throw, got ${JSON.stringify(v)}`); },
      (e) => e
    );
    expect(first.message).toContain("increased from $1.00 to $1.02");
    expect(placeEquityOrder).not.toHaveBeenCalled();
    expect(debateProposal).not.toHaveBeenCalled();
    expect(getProposal(proposalId, userId)?.proposal.finalSizeReview).toMatchObject({
      ownerApprovalRequired: true,
      ownerApprovalNotional: 1.02,
      ownerApprovalRequoteReason: expect.stringContaining("Approve the updated amount again")
    });
    expect(listAudit(100, userId).filter((event) => event.kind === "final_size_owner_consent_requoted")).toHaveLength(1);

    const second = await executeProposal(proposalId, userId);
    expect(second.status).toBe("placed");
    expect(placeEquityOrder).toHaveBeenCalledTimes(1);
    expect(placeEquityOrder.mock.calls[0][0]).toMatchObject({ quantity: 0.005 });
    expect(getProposal(proposalId, userId)?.proposal.finalSizeReview).toMatchObject({
      ownerApprovalRequired: false,
      ownerApprovalNotional: 1.02,
      ownerOverrideAppliedAt: expect.any(String)
    });
  });

  it("holds an unavailable final-size review for owner approval and records that failure on the pending decision", async () => {
    reviewEquityOrder.mockImplementation(async (i) => echoReview(i));
    debateProposal.mockResolvedValue({
      rejected: false,
      available: false,
      reason: "provider timed out",
      failureKind: "timeout",
      model: "gpt-5.6-terra"
    });

    const userId = `bump-red-unavailable-${randomUUID()}`;
    const proposalId = await seedApprovedProposal(userId);
    const { executeProposal } = await import("../src/lib/strategy");
    const { getProposal } = await import("../src/lib/db");

    const result: Error = await executeProposal(proposalId, userId).then(
      (v) => { throw new Error(`expected throw, got ${JSON.stringify(v)}`); },
      (e) => e
    );
    expect(result.message).toContain("provider timed out");
    expect(placeEquityOrder).not.toHaveBeenCalled();
    const pending = getProposal(proposalId, userId);
    expect(pending?.decision).toMatchObject({
      approved: false,
      adversaryUnavailable: true,
      adversaryUnavailableReason: expect.stringContaining("timeout")
    });
    expect(pending?.proposal.redTeamVerdict).toMatchObject({
      available: false,
      failureKind: "timeout"
    });
  });

  it("does not bump Red's half-size advice back to the broker floor; an unplaceable haircut is held for the owner", async () => {
    reviewEquityOrder.mockImplementation(async (i) => echoReview(i));
    debateProposal.mockResolvedValue({
      verdict: "approve-at-half",
      rejected: false,
      available: true,
      reason: "Proceed only at half the broker-adjusted size.",
      model: "gpt-5.6-terra"
    });

    const userId = `bump-red-half-${randomUUID()}`;
    const proposalId = await seedApprovedProposal(userId);
    const { executeProposal } = await import("../src/lib/strategy");
    const { getProposal } = await import("../src/lib/db");

    const result: Error = await executeProposal(proposalId, userId).then(
      (v) => { throw new Error(`expected throw, got ${JSON.stringify(v)}`); },
      (e) => e
    );
    expect(result.message).toContain("not executable");
    expect(reviewEquityOrder).toHaveBeenCalledTimes(2);
    expect(placeEquityOrder).not.toHaveBeenCalled();
    expect(getProposal(proposalId, userId)?.proposal).toMatchObject({
      dollarAmount: 1,
      finalSizeReview: { ownerApprovalRequired: true },
      redTeamVerdict: { verdict: "approve-at-half" }
    });
  });

  it("declines the bump (skip path, no re-review) when the per-order cap can't fit the floor — never manufactures a policy rejection", async () => {
    reviewEquityOrder.mockImplementation(async (i) => echoReview(i));

    const userId = `bump-cap-${randomUUID()}`;
    // Headroomed per-order cap ($0.50 * 0.95) < $1 floor: planner declines, order skips.
    const proposalId = await seedApprovedProposal(userId, { maxOrderNotional: 0.5 });
    const { executeProposal } = await import("../src/lib/strategy");
    const { listAudit } = await import("../src/lib/db");

    // #3343: 'blocked' status outcomes now surface as a thrown Error. The persisted proposal
    // status is updated before the throw, so we can verify both the throw and the row state.
    const expectBlocked = async (proposalId: string, userId: string) => {
      return executeProposal(proposalId, userId).then(
        (v) => { throw new Error(`expected throw, got ${JSON.stringify(v)}`); },
        (e) => e as Error
      );
    };

    const result = await expectBlocked(proposalId, userId);

    expect(result).toBeInstanceOf(Error);
    expect(reviewEquityOrder).toHaveBeenCalledTimes(1); // declined BEFORE any bump re-review
    expect(debateProposal).not.toHaveBeenCalled();
    expect(placeEquityOrder).not.toHaveBeenCalled();
    expect(listAudit(50, userId).some((e) => e.kind === "order_skipped_broker_minimum")).toBe(true);
  });

  it("declines the bump when available buying power can't fit the floor (codex finding)", async () => {
    reviewEquityOrder.mockImplementation(async (i) => echoReview(i));
    portfolioOverrides = { buyingPower: 0.5 }; // all other caps ample

    const userId = `bump-bp-${randomUUID()}`;
    const proposalId = await seedApprovedProposal(userId);
    const { executeProposal } = await import("../src/lib/strategy");

    const result: Error = await executeProposal(proposalId, userId).then(
      (v) => { throw new Error(`expected throw, got ${JSON.stringify(v)}`); },
      (e) => e
    );
    expect(result).toBeInstanceOf(Error);
    expect(reviewEquityOrder).toHaveBeenCalledTimes(1);
    expect(placeEquityOrder).not.toHaveBeenCalled();
  });

  it("declines the bump when the daily opening ORDER-COUNT budget is spent (codex finding)", async () => {
    reviewEquityOrder.mockImplementation(async (i) => echoReview(i));

    const userId = `bump-count-${randomUUID()}`;
    // maxDailyOrders 0: the opening count budget is spent before any order — the planner must
    // decline rather than bump into evaluateTradeProposal's daily-order rejection (demotion risk).
    const proposalId = await seedApprovedProposal(userId, { maxDailyOrders: 0 });
    const { executeProposal } = await import("../src/lib/strategy");

    const result: Error = await executeProposal(proposalId, userId).then(
      (v) => { throw new Error(`expected throw, got ${JSON.stringify(v)}`); },
      (e) => e
    );
    expect(result).toBeInstanceOf(Error);
    expect(reviewEquityOrder).toHaveBeenCalledTimes(1);
    expect(placeEquityOrder).not.toHaveBeenCalled();
  });

  it("one-shot fallback: if the broker still flags the bumped order, it takes the block path with the ORIGINAL sizing restored (no loop)", async () => {
    reviewEquityOrder.mockImplementation(async (i) => ({
      ...echoReview(i),
      preflightBlock: { alertTypes: ["EQUITY_DOLLAR_BASED_MINIMUM_AMOUNT_ERROR"], message: "still too small" }
    }));

    const userId = `bump-stillblocked-${randomUUID()}`;
    const proposalId = await seedApprovedProposal(userId);
    const { executeProposal } = await import("../src/lib/strategy");
    const { getProposal, listAudit } = await import("../src/lib/db");

    const result: Error = await executeProposal(proposalId, userId).then(
      (v) => { throw new Error(`expected throw, got ${JSON.stringify(v)}`); },
      (e) => e
    );
    expect(result).toBeInstanceOf(Error);
    // Original review + exactly ONE bump re-review — never a loop.
    expect(reviewEquityOrder).toHaveBeenCalledTimes(2);
    expect(placeEquityOrder).not.toHaveBeenCalled();
    expect(getProposal(proposalId, userId)?.status).toBe("blocked");
    const skips = listAudit(50, userId).filter((e) => e.kind === "order_skipped_broker_minimum");
    expect(skips.length).toBe(1);
    // Failed bump restores the original sizing and records the attempt.
    expect((skips[0].payload as Record<string, unknown>).attemptedBumpToNotional).toBeDefined();
  });

  it('the "skip" off-switch restores pre-ruling behavior: blocked without any bump attempt', async () => {
    reviewEquityOrder.mockImplementation(async (i) => echoReview(i));

    const userId = `bump-skip-${randomUUID()}`;
    const proposalId = await seedApprovedProposal(userId, { brokerMinimumHandling: "skip" });
    const { executeProposal } = await import("../src/lib/strategy");

    const result: Error = await executeProposal(proposalId, userId).then(
      (v) => { throw new Error(`expected throw, got ${JSON.stringify(v)}`); },
      (e) => e
    );
    expect(result).toBeInstanceOf(Error);
    expect(reviewEquityOrder).toHaveBeenCalledTimes(1); // no bump re-review
    expect(placeEquityOrder).not.toHaveBeenCalled();
  });
});
