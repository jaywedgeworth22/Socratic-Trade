/**
 * Regression tests: a broker call that resolves without throwing is NOT the same as "the broker
 * accepted the order" — Alpaca (and Robinhood) can both return a synchronous rejected/canceled
 * state without an HTTP error. Before this fix, executeProposal always recorded such a response
 * as proposal status "placed", telling the dashboard a live order existed when the broker had
 * already declined it. This drives the real approval path (executeProposal) through a mocked
 * Alpaca SDK so the fix is verified end-to-end, not just at the isRejectedOrCanceledState unit.
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_POLICY } from "../src/lib/defaults";
import type { MarketQuote, MarketScan } from "../src/lib/types";

vi.mock("../src/lib/vector-db", () => ({
  managedVectorLedgerAuthority: vi.fn(),
  getCurrentVectorProviderAuthority: vi.fn(),
  findRelevantExperiences: async () => [],
  upsertExperiences: async () => {},
  retrieveContext: async () => [],
  storeContext: async () => {},
  storeContexts: async () => {}
}));

// Order-state assertions do not cover delivery; keep notification I/O out of this focused suite.
vi.mock("../src/lib/notifications", () => ({
  sendNotification: async () => ({ id: "test", status: "skipped" })
}));

// The market scan inside executeProposal is incidental to what this file verifies (broker
// order-state confirmation). Left unmocked it fans out to REAL Nasdaq-screener/Yahoo fetches
// (6-8s abort timeouts, 429-retry backoff): ~12s per test solo, and the direct cause of the
// full-suite flake — 4 workers' worth of shared network/rate-limit contention pushed these
// tests past even a 30s timeout. Stub ONLY scanMarket (importOriginal keeps mergeQuoteData
// and the other exports real) with a minimal fresh AAPL scan so the price/staleness gates in
// policy.ts still see a quote.
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
      const msft: MarketQuote = { ...aapl, symbol: "MSFT", price: 300, bid: 299, ask: 300 };
      return {
        source: "test-scan",
        generatedAt: asOf,
        scannedSymbols: 2,
        returnedQuotes: 2,
        topCandidates: [aapl, msft],
        sectorBySymbol: {},
        quotesBySymbol: { AAPL: aapl, MSFT: msft },
        warnings: []
      };
    }
  };
});

let mockOrderStatus = "accepted";
let lastCreateOrderOpts: Record<string, unknown> | null = null;
let mockOrderSeq = 0;

vi.mock("@alpacahq/alpaca-trade-api", () => {
  return {
    default: class MockAlpaca {
      async getAccount() {
        return { account_number: "ACC-CONFIRM", portfolio_value: "50000", buying_power: "25000", equity: "40000", cash: "40000" };
      }
      async getPositions() {
        return [];
      }
      async getOrders() {
        return [];
      }
      async getAsset(symbol: string) {
        // PR #3380 turned getEquityTradability into a real Alpaca asset lookup; without this
        // stub every order gets blocked as not-tradable.  Reflect Alpaca's "default" tradable
        // shape so the test exercises the same code path it did before the refactor.
        return {
          symbol,
          tradable: true,
          fractionable: true,
          shortable: true,
          easy_to_borrow: true,
          marginable: true,
          status: "active"
        };
      }
      async getLatestQuotes(symbols: string[]) {
        if (symbols.includes("BRK.B")) return { "BRK.B": { bp: 409, ap: 410, t: new Date().toISOString() } };
        return Object.fromEntries(
          symbols.map((symbol) => [
            symbol,
            symbol === "MSFT"
              ? { bp: 299, ap: 300, t: new Date().toISOString() }
              : { bp: 199, ap: 200, t: new Date().toISOString() }
          ])
        );
      }
      async createOrder(opts: Record<string, unknown>) {
        lastCreateOrderOpts = opts;
        mockOrderSeq += 1;
        return { id: `order-confirm-${mockOrderSeq}`, status: mockOrderStatus, qty: opts.qty, filled_qty: "0", filled_avg_price: null };
      }
      async cancelOrder() {}
    }
  };
});

const ACCOUNT = "ACC-CONFIRM";

async function seedLiveProposal(
  userId: string,
  environment: "paper" | "live" = "paper",
  symbol: string = "AAPL"
): Promise<string> {
  const { upsertConnectedAccount, setPolicy, insertProposal } = await import("../src/lib/db");

  // "paper" (not "live") by default — this exercises the identical broker/placeEquityOrder
  // code path (submitsBrokerOrders: true, real gateway, not the local simulator) without also
  // having to satisfy the separate typed live-approval confirmation gate, which is unrelated to
  // what this test verifies.
  upsertConnectedAccount({
    id: "acc-confirm-test",
    userId,
    broker: "alpaca",
    environment,
    accountNumber: ACCOUNT,
    baseUrl: "https://paper-api.alpaca.markets",
    apiKey: "AK_TEST",
    apiSecret: "secret",
    isActive: true,
    label: "Alpaca Paper Confirm Test"
  });

  setPolicy(
    {
      ...DEFAULT_POLICY,
      accountNumber: ACCOUNT,
      connectedAccountId: "acc-confirm-test",
      activeBroker: "alpaca",
      systemState: "active",
      requireTypedConfirmation: true,
      maxDailyNotional: 5_000
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
      symbol,
      side: "buy",
      type: "market",
      dollarAmount: 500,
      timeInForce: "gfd",
      marketHours: "regular_hours",
      rationale: "order confirmation test",
      tradeThesisTag: "Momentum-Breakout",
      entryMarketRegime: "Neutral (Normal Volatility)"
    },
    decision: { approved: true, reasons: [] },
    status: "proposed"
  });
  return proposalId;
}

beforeEach(async () => {
  vi.resetModules();
  vi.unstubAllEnvs();
  mockOrderStatus = "accepted";
  mockOrderSeq = 0;
  lastCreateOrderOpts = null;
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-order-confirm-${randomUUID()}.db`)}`;
});

describe("executeProposal — broker-agnostic order-placement confirmation", () => {
  it("does NOT mark the proposal 'placed' when the broker synchronously rejects the order", async () => {
    mockOrderStatus = "rejected";
    const userId = `confirm-rejected-${randomUUID()}`;
    const proposalId = await seedLiveProposal(userId);

    const { executeProposal } = await import("../src/lib/strategy");
    const { getProposal } = await import("../src/lib/db");

    // #3343: a broker synchronous decline surfaces as a thrown Error with the broker state
    // persisted on the row. The Error's message carries the decline reason.
    const result: Error = await executeProposal(proposalId, userId).then(
      (v) => { throw new Error(`expected throw, got ${JSON.stringify(v)}`); },
      (e) => e
    );
    expect(result.message).toContain("Broker declined the order");
    expect(lastCreateOrderOpts).not.toBeNull();

    const row = getProposal(proposalId, userId);
    expect(row?.status).toBe("rejected_by_broker");
    expect(row?.status).not.toBe("placed");
  }, 30000); // Network is stubbed (scanMarket mock above); the pad now only covers the
  // vi.resetModules() re-import of the strategy module graph under full-suite CPU contention.

  it("marks the proposal 'placed' when the broker accepts the order", async () => {
    mockOrderStatus = "accepted";
    const userId = `confirm-accepted-${randomUUID()}`;
    const proposalId = await seedLiveProposal(userId);

    const { executeProposal } = await import("../src/lib/strategy");
    const { getProposal } = await import("../src/lib/db");

    const result = await executeProposal(proposalId, userId);

    expect(result.status).toBe("placed");
    expect(result.orderId).toBe("order-confirm-1");

    const row = getProposal(proposalId, userId);
    expect(row?.status).toBe("placed");
  }, 30000);

  it("rejects a generic batch phrase on the per-proposal live approval contract", async () => {
    mockOrderStatus = "accepted";
    const userId = `confirm-live-per-item-${randomUUID()}`;
    const proposalId = await seedLiveProposal(userId, "live");

    const { executeProposal } = await import("../src/lib/strategy");

    await expect(executeProposal(proposalId, userId, {
      liveConfirmation: {
        proposalId,
        accountNumber: ACCOUNT,
        executionMode: "broker/live",
        estimatedNotional: 500,
        typedText: "APPROVE 2 LIVE ORDERS"
      }
    })).rejects.toThrow("Type APPROVE LIVE AAPL to approve this live order.");
    expect(lastCreateOrderOpts).toBeNull();
  }, 30000);

  it("accepts a server-verified typed batch phrase through the bulk approval route", async () => {
    mockOrderStatus = "accepted";
    const userId = "local";
    const firstId = await seedLiveProposal(userId, "live", "AAPL");
    const secondId = await seedLiveProposal(userId, "live", "MSFT");

    const { POST } = await import("../app/api/proposals/bulk-approve/route");
    const response = await POST(
      new Request("http://localhost/api/proposals/bulk-approve", {
        method: "POST",
        body: JSON.stringify({
          proposalIds: [firstId, secondId],
          liveConfirmation: { typedText: "APPROVE 2 LIVE ORDERS" }
        })
      })
    );

    expect(response.status).toBe(200);
    const body = await response.json() as { results: Array<{ status: string; orderId?: string }> };
    expect(body.results.map((result) => result.status)).toEqual(["placed", "placed"]);
    expect(body.results.map((result) => result.orderId)).toEqual(["order-confirm-1", "order-confirm-2"]);
  }, 30000);

  it("server-verifies the typed bulk count from selected proposal rows", async () => {
    mockOrderStatus = "accepted";
    const userId = "local";
    const proposalId = await seedLiveProposal(userId, "live", "AAPL");

    const { POST } = await import("../app/api/proposals/bulk-approve/route");
    const response = await POST(
      new Request("http://localhost/api/proposals/bulk-approve", {
        method: "POST",
        body: JSON.stringify({
          proposalIds: [proposalId],
          liveConfirmation: { typedText: "APPROVE 2 LIVE ORDERS" }
        })
      })
    );

    expect(response.status).toBe(409);
    const body = await response.json() as { expectedText?: string };
    expect(body.expectedText).toBe("APPROVE LIVE AAPL");
    expect(lastCreateOrderOpts).toBeNull();
  }, 30000);

  it("returns quotes under both canonical and requested share-class symbols", async () => {
    const userId = `quote-alias-${randomUUID()}`;
    const connectedAccountId = "acc-quote-alias";
    const { upsertConnectedAccount } = await import("../src/lib/db");
    upsertConnectedAccount({
      id: connectedAccountId,
      userId,
      broker: "alpaca",
      environment: "paper",
      accountNumber: ACCOUNT,
      baseUrl: "https://paper-api.alpaca.markets",
      apiKey: "AK_TEST",
      apiSecret: "secret",
      isActive: true,
      label: "Alpaca Paper Quote Alias Test"
    });

    const { getAlpacaGateway } = await import("../src/lib/alpaca");
    const quotes = await getAlpacaGateway(userId, connectedAccountId).getEquityQuotes(ACCOUNT, ["BRK.B"]);

    expect(quotes["BRK-B"]?.price).toBe(410);
    expect(quotes["BRK.B"]?.price).toBe(410);
    expect(quotes["BRK.B"]?.symbol).toBe("BRK.B");
  });
});
