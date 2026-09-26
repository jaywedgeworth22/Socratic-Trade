/**
 * Lane G2 regression, through the REAL approval path (executeProposal): a human-approved exit
 * whose shares are held ONLY by the app's own resting protective stop must reach the broker —
 * the stop is cancelled first, the sell placed, and a stop re-placed for any shares left.  Before
 * this lane the proposal was retired "blocked" with "Existing open sell order(s) already hold 24
 * of 24 BAC shares", so the position could only ever leave through its stop.
 *
 * The mocked broker ENFORCES held quantity like Alpaca (403 insufficient qty while an open sell
 * holds the shares), so the test only passes if the stop is out of the way before the exit.
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_POLICY } from "../src/lib/defaults";
import { getProposal, insertProposal, listBrokerProtectiveStops, setPolicy, upsertBrokerProtectiveStop, upsertConnectedAccount } from "../src/lib/db";
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

interface MockOrder {
  id: string;
  symbol: string;
  side: string;
  type: string;
  state: string;
  quantity: number;
  filledQuantity: number;
  averagePrice?: number;
  stopPrice?: number;
  createdAt: string;
  clientOrderId?: string;
}

const broker = vi.hoisted(() => ({
  positions: [] as Array<{ symbol: string; quantity: number; averageCost: number; marketValue: number }>,
  orders: [] as MockOrder[],
  placed: [] as Array<{ symbol: string; side: string; type: string; quantity?: number; stopPrice?: number; refId?: string }>,
  cancelled: [] as string[],
  seq: 0
}));

vi.mock("../src/lib/broker", () => {
  const ACTIVE = new Set(["new", "accepted", "held", "pending_new", "partially_filled", "pending_cancel"]);
  const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
  return {
    getBrokerGateway: () => ({
      ordersListIncludesTerminal: true,
      getPortfolio: async () => ({
        accountNumber: "G2INT",
        totalMarketValue: 10000,
        buyingPower: 5000,
        equityMarketValue: 5000,
        optionMarketValue: 0,
        cash: 5000
      }),
      getEquityPositions: async () => clone(broker.positions),
      getEquityOrders: async () => clone(broker.orders),
      getEquityQuotes: async () => ({}),
      getEquityTradability: async (_accountNumber: string, symbols: string[]) =>
        Object.fromEntries(symbols.map((symbol) => [symbol, { tradable: true, fractional: true }])),
      reviewEquityOrder: async (input: { quantity?: number }) => ({ estimatedNotional: (input.quantity ?? 0) * 50, alerts: [] }),
      cancelEquityOrder: async (_accountNumber: string, orderId: string) => {
        broker.cancelled.push(orderId);
        const order = broker.orders.find((o) => o.id === orderId);
        if (order) order.state = "canceled";
        return { orderId, refId: "x", state: "cancel_requested", raw: {} };
      },
      placeEquityOrder: async (order: { symbol: string; side: string; type: string; quantity?: number; stopPrice?: number; refId?: string }) => {
        broker.placed.push(order);
        const position = broker.positions.find((p) => p.symbol === order.symbol);
        const qty = order.quantity ?? 0;
        if (order.side === "sell") {
          const held = broker.orders
            .filter((o) => o.symbol === order.symbol && o.side === "sell" && ACTIVE.has(o.state))
            .reduce((sum, o) => sum + (o.quantity - o.filledQuantity), 0);
          const available = Math.max((position?.quantity ?? 0) - held, 0);
          if (qty > available) throw new Error(`HTTP 403 insufficient qty available for order (requested: ${qty}, available: ${available})`);
        }
        broker.seq += 1;
        const id = `ord-${broker.seq}`;
        const fills = order.type === "market";
        broker.orders.push({
          id,
          symbol: order.symbol,
          side: order.side,
          type: order.type,
          state: fills ? "filled" : "new",
          quantity: qty,
          filledQuantity: fills ? qty : 0,
          averagePrice: fills ? 50 : undefined,
          stopPrice: order.stopPrice,
          createdAt: new Date().toISOString(),
          clientOrderId: order.refId
        });
        if (fills && position) {
          position.quantity -= qty;
          position.marketValue = position.quantity * 50;
          if (position.quantity <= 0) broker.positions = broker.positions.filter((p) => p.symbol !== order.symbol);
        }
        return { orderId: id, refId: order.refId ?? id, state: fills ? "filled" : "new", raw: {} };
      }
    })
  };
});

vi.mock("../src/lib/approval-quote-scan", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/approval-quote-scan")>();
  return {
    ...actual,
    loadApprovalQuoteScan: async () =>
      actual.buildApprovalQuoteScan({ BAC: { symbol: "BAC", price: 50, bid: 49.99, ask: 50, provider: "test-scan" } }, [])
  };
});

vi.mock("../src/lib/market", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/market")>();
  return {
    ...actual,
    scanMarket: async (): Promise<MarketScan> => {
      const asOf = new Date().toISOString();
      const bac: MarketQuote = {
        symbol: "BAC",
        price: 50,
        bid: 49.99,
        ask: 50,
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
        topCandidates: [bac],
        sectorBySymbol: {},
        quotesBySymbol: { BAC: bac },
        warnings: []
      };
    }
  };
});

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-exit-stop-release-approval-${randomUUID()}.db`)}`;
});

const ACCOUNT = "G2INT";

beforeEach(() => {
  broker.positions = [{ symbol: "BAC", quantity: 24, averageCost: 50, marketValue: 24 * 50 }];
  broker.orders = [
    {
      id: "stop-BAC",
      symbol: "BAC",
      side: "sell",
      type: "stop_market",
      state: "new",
      quantity: 24,
      filledQuantity: 0,
      stopPrice: 46,
      createdAt: new Date(Date.now() - 86_400_000).toISOString(),
      clientOrderId: "protstop-g2-BAC-1700000000000"
    }
  ];
  broker.placed = [];
  broker.cancelled = [];
});

function seed(userId: string, sellQuantity: number, over: Record<string, unknown> = {}): string {
  upsertConnectedAccount({
    id: `acct-${userId}`,
    userId,
    broker: "alpaca",
    environment: "paper",
    accountNumber: ACCOUNT,
    label: "G2 Integration",
    isActive: true
  });
  setPolicy(
    {
      ...DEFAULT_POLICY,
      accountNumber: ACCOUNT,
      connectedAccountId: `acct-${userId}`,
      activeBroker: "alpaca",
      systemState: "active",
      brokerTrailingStops: false,
      riskRules: { ...DEFAULT_POLICY.riskRules, stopLossPct: 8, trailingStopPct: 0 },
      additionalSymbols: ["BAC"],
      maxDailyNotional: 5000,
      ...over
    },
    userId
  );
  // The app's OWN protective stop, exactly as the reconciler tracks it.
  upsertBrokerProtectiveStop({
    id: `protstop-${userId}-${ACCOUNT}-BAC`,
    userId,
    accountNumber: ACCOUNT,
    symbol: "BAC",
    brokerOrderId: "stop-BAC",
    quantity: 24,
    stopPrice: 46,
    status: "resting",
    kind: "fixed"
  });
  const proposal: TradeProposal = {
    symbol: "BAC",
    side: "sell",
    type: "market",
    quantity: sellQuantity,
    timeInForce: "gfd",
    marketHours: "regular_hours",
    rationale: "Owner-approved discretionary exit (G2 integration).",
    tradeThesisTag: "Discretionary-Exit",
    entryMarketRegime: "Test"
  };
  const proposalId = randomUUID();
  insertProposal({
    id: proposalId,
    runId: randomUUID(),
    accountNumber: ACCOUNT,
    userId,
    proposal,
    decision: { approved: true, reasons: [] },
    status: "proposed"
  });
  return proposalId;
}

describe("executeProposal — approved exit vs the app's own resting stop", () => {
  it("full exit: releases the app stop, then sells all 24 instead of blocking", async () => {
    const userId = `g2-full-${randomUUID()}`;
    const proposalId = seed(userId, 24);
    const result = await executeProposal(proposalId, userId);
    expect(broker.cancelled).toEqual(["stop-BAC"]);
    expect(broker.placed[0]).toMatchObject({ symbol: "BAC", side: "sell", type: "market", quantity: 24 });
    expect(["placed", "filled"]).toContain(result.status);
    expect(getProposal(proposalId, userId)?.status).not.toBe("blocked");
    // Position closed: nothing re-placed, no tracking row left behind.
    expect(broker.placed).toHaveLength(1);
    expect(listBrokerProtectiveStops(ACCOUNT, userId)).toHaveLength(0);
  }, 60_000);

  it("partial exit: sells 10 and re-places the stop for the remaining 14", async () => {
    const userId = `g2-partial-${randomUUID()}`;
    const proposalId = seed(userId, 10);
    await executeProposal(proposalId, userId);
    expect(broker.cancelled).toEqual(["stop-BAC"]);
    expect(broker.placed[0]).toMatchObject({ side: "sell", type: "market", quantity: 10 });
    expect(broker.placed[1]).toMatchObject({ side: "sell", type: "stop_market", quantity: 14, stopPrice: 46 });
    const rows = listBrokerProtectiveStops(ACCOUNT, userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ quantity: 14, status: "resting" });
  }, 60_000);

  it("toggle off: the exit stays blocked and the stop is never touched", async () => {
    const userId = `g2-off-${randomUUID()}`;
    const proposalId = seed(userId, 24, { exitsReleaseAppStops: false });
    await expect(executeProposal(proposalId, userId)).rejects.toThrow(/already hold 24 of 24 BAC/);
    expect(broker.cancelled).toEqual([]);
    expect(broker.placed).toHaveLength(0);
    expect(getProposal(proposalId, userId)?.status).toBe("blocked");
  }, 60_000);
});
