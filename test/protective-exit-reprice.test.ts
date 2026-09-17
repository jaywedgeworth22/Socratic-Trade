/**
 * Regression tests for repricing APPROVAL-HELD protective exits at placement time (PR #1228 review):
 * under propose authority a Risk-Exit card is stored as generated and can sit while the quote and
 * session move. executeProposal must NOT submit the stored extended-hours marketable-limit verbatim —
 * it re-resolves the routing off the fresh approval-time quote (bid-anchored for a SELL) and wall
 * clock, degrading to the market/queue-to-open default when the extended session no longer applies.
 * Drives the REAL approval path (executeProposal) with the broker gateway and market scan mocked.
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_POLICY } from "../src/lib/defaults";
import { liveApprovalText } from "../src/lib/strategy";
import { getDb, getProposal, insertProposal, setPolicy, upsertConnectedAccount } from "../src/lib/db";
import type { MarketQuote, MarketScan, TradeProposal } from "../src/lib/types";
import { executeProposal } from "../src/lib/strategy-execution";

vi.mock("../src/lib/vector-db", () => ({
  managedVectorLedgerAuthority: vi.fn(),
  getCurrentVectorProviderAuthority: vi.fn(),
  findRelevantExperiences: async () => [],
  upsertExperiences: async () => {},
  retrieveContext: async () => [],
  storeContext: async () => {},
  storeContexts: async () => {}
}));

const broker = vi.hoisted(() => ({
  placed: [] as Array<{ symbol: string; side: string; type?: string; marketHours?: string; limitPrice?: number; quantity?: number; refId: string }>
}));

vi.mock("../src/lib/broker", () => ({
  getBrokerGateway: () => ({
    getPortfolio: async () => ({
      accountNumber: "REPRICE",
      totalMarketValue: 10000,
      buyingPower: 5000,
      equityMarketValue: 10000,
      optionMarketValue: 0,
      cash: 5000
    }),
    getEquityPositions: async () => [{ symbol: "AAPL", quantity: 5, averageCost: 220, marketValue: 1000 }],
    getEquityOrders: async () => [],
    getEquityQuotes: async () => ({}),
    getEquityTradability: async (_accountNumber: string, symbols: string[]) => Object.fromEntries(
      symbols.map((symbol) => [symbol, { tradable: true, fractional: true }])
    ),
    reviewEquityOrder: async (input: { quantity?: number; limitPrice?: number }) => ({
      estimatedNotional: (input.quantity ?? 0) * (input.limitPrice ?? 200),
      alerts: []
    }),
    placeEquityOrder: async (order: typeof broker.placed[number]) => {
      broker.placed.push(order);
      return { orderId: `ord-${broker.placed.length}`, refId: order.refId, state: "accepted", raw: {} };
    }
  })
}));

// Stub ONLY scanMarket (importOriginal keeps mergeQuoteData and the other exports real) so the
// approval-time scan carries a fresh AAPL quote that has fallen through the stored exit limit:
// bid 199 / ask 200 with the ask-biased composite at 200.
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

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-exit-reprice-${randomUUID()}.db`)}`;
});

beforeEach(() => {
  broker.placed = [];
});

afterEach(() => {
  vi.useRealTimers();
});

/** Stored at generation time in a pre-market session, priced off a $220 quote (220 * (1 - 0.0015)). */
const STORED_EXIT: TradeProposal = {
  symbol: "AAPL",
  side: "sell",
  type: "limit",
  quantity: 5,
  limitPrice: 219.67,
  timeInForce: "gfd",
  marketHours: "extended_hours",
  rationale: "Proactive stop-loss exit (reprice test).",
  tradeThesisTag: "Risk-Exit",
  entryMarketRegime: "Active Risk Check"
};

function seedStoredExit(
  userId: string,
  opts: { environment?: "paper" | "live"; storedProposal?: TradeProposal } = {}
): string {
  upsertConnectedAccount({
    id: `acct-${userId}`,
    userId,
    broker: "test",
    environment: opts.environment ?? "paper",
    accountNumber: "REPRICE",
    label: "Reprice Test",
    isActive: true
  });
  setPolicy(
    {
      ...DEFAULT_POLICY,
      accountNumber: "REPRICE",
      connectedAccountId: `acct-${userId}`,
      systemState: "active",
      allowExtendedHoursSyntheticStops: true,
      additionalSymbols: ["AAPL"],
      maxDailyNotional: 5000
    },
    userId
  );
  const proposalId = randomUUID();
  insertProposal({
    id: proposalId,
    runId: randomUUID(),
    accountNumber: "REPRICE",
    userId,
    proposal: opts.storedProposal ?? STORED_EXIT,
    decision: { approved: true, reasons: [] },
    status: "proposed"
  });
  return proposalId;
}

describe("executeProposal — approval-held protective-exit reprice", () => {
  it("still in the extended session: places a FRESH bid-anchored limit, never the stale stored one", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-10T12:00:00Z")); // 08:00 ET = pre-market (EDT)
    try {
      const userId = `reprice-pre-${randomUUID()}`;
      const proposalId = seedStoredExit(userId);
      const result = await executeProposal(proposalId, userId);
      expect(result.status).toBe("placed");
      expect(broker.placed).toHaveLength(1);
      expect(broker.placed[0]).toMatchObject({
        symbol: "AAPL",
        side: "sell",
        type: "limit",
        marketHours: "extended_hours",
        limitPrice: 198.7 // 199 (fresh bid) * (1 - 0.0015) — NOT the stored 219.67
      });
      const persistedRow = getProposal(proposalId, userId);
      expect(persistedRow?.status).toBe("placed");
      // The REPRICED order is persisted back onto the row: Recent/Activity must show the order the
      // broker actually received, never the stale generation-time price.
      expect(persistedRow?.proposal).toMatchObject({ type: "limit", marketHours: "extended_hours", limitPrice: 198.7 });
      // The reprice leaves an audit receipt tying the stored card to the placed order.
      const receipts = (getDb()
        .prepare("SELECT payload FROM audit_events WHERE kind = 'protective_exit_repriced'")
        .all() as Array<{ payload: string }>)
        .map((row) => JSON.parse(row.payload) as { proposalId: string; from: { limitPrice?: number }; to: { limitPrice?: number } })
        .filter((payload) => payload.proposalId === proposalId);
      expect(receipts).toHaveLength(1);
      expect(receipts[0].from.limitPrice).toBe(219.67);
      expect(receipts[0].to.limitPrice).toBe(198.7);
    } finally {
      vi.useRealTimers();
    }
  }, 30000);

  it("extended session over by approval time: degrades to the market/queue-to-open default", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-10T14:30:00Z")); // 10:30 ET = regular session (EDT)
    try {
      const userId = `reprice-regular-${randomUUID()}`;
      const proposalId = seedStoredExit(userId);
      const result = await executeProposal(proposalId, userId);
      expect(result.status).toBe("placed");
      expect(broker.placed).toHaveLength(1);
      expect(broker.placed[0]).toMatchObject({
        symbol: "AAPL",
        side: "sell",
        type: "market",
        marketHours: "regular_hours"
      });
      expect(broker.placed[0].limitPrice).toBeUndefined();
      // The degraded market order is what the row shows too, not the stale extended-hours limit.
      const persistedRow = getProposal(proposalId, userId);
      expect(persistedRow?.proposal).toMatchObject({ type: "market", marketHours: "regular_hours" });
      expect(persistedRow?.proposal.limitPrice).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  }, 30000);

  it("LIVE + typed confirmation: a MATERIAL reprice routes BACK to approval instead of placing", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-10T12:00:00Z")); // 08:00 ET = pre-market (EDT)
    try {
      const userId = `reprice-live-material-${randomUUID()}`;
      const proposalId = seedStoredExit(userId, { environment: "live" });
      // The phrase below confirms the STORED order (limit 219.67); the fresh quote has fallen ~9.5%
      // through it, so placing the 198.70 reprice under that confirmation would violate the live
      // typed-confirm invariant — defer to the human (precedent: autoRemediateStaleExitOrders).
      const result = await executeProposal(proposalId, userId, {
        liveConfirmation: {
          proposalId,
          accountNumber: "REPRICE",
          executionMode: "broker/live",
          typedText: liveApprovalText("AAPL")
        }
      });
      expect(result.status).toBe("proposed");
      expect(result.reasons?.[0]).toContain("approve the repriced order again");
      expect(broker.placed).toHaveLength(0);
      // The card stays pending, updated to the repriced order the next Approve will confirm.
      const persistedRow = getProposal(proposalId, userId);
      expect(persistedRow?.status).toBe("proposed");
      expect(persistedRow?.proposal).toMatchObject({ type: "limit", marketHours: "extended_hours", limitPrice: 198.7 });
      // Honest audit receipt on the defer branch.
      const receipts = (getDb()
        .prepare("SELECT payload FROM audit_events WHERE kind = 'protective_exit_reprice_reapproval'")
        .all() as Array<{ payload: string }>)
        .map((row) => JSON.parse(row.payload) as { proposalId: string; drift: { material: boolean }; reason: string })
        .filter((payload) => payload.proposalId === proposalId);
      expect(receipts).toHaveLength(1);
      expect(receipts[0].drift.material).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  }, 30000);

  it("LIVE + typed confirmation: IMMATERIAL drift places normally (with the reprice audited)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-10T12:00:00Z")); // 08:00 ET = pre-market (EDT)
    try {
      const userId = `reprice-live-immaterial-${randomUUID()}`;
      // Stored limit 198.73 vs the fresh bid-anchored 198.70 — ~1.5 bps, well inside the 15 bps
      // buffer tolerance: the confirmed and placed orders are the same trade for practical purposes.
      const proposalId = seedStoredExit(userId, {
        environment: "live",
        storedProposal: { ...STORED_EXIT, limitPrice: 198.73 }
      });
      const result = await executeProposal(proposalId, userId, {
        liveConfirmation: {
          proposalId,
          accountNumber: "REPRICE",
          executionMode: "broker/live",
          typedText: liveApprovalText("AAPL")
        }
      });
      expect(result.status).toBe("placed");
      expect(broker.placed).toHaveLength(1);
      expect(broker.placed[0]).toMatchObject({ type: "limit", marketHours: "extended_hours", limitPrice: 198.7 });
      const receipts = (getDb()
        .prepare("SELECT payload FROM audit_events WHERE kind = 'protective_exit_repriced'")
        .all() as Array<{ payload: string }>)
        .map((row) => JSON.parse(row.payload) as { proposalId: string; drift: { material: boolean } })
        .filter((payload) => payload.proposalId === proposalId);
      expect(receipts).toHaveLength(1);
      expect(receipts[0].drift.material).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  }, 30000);
});
