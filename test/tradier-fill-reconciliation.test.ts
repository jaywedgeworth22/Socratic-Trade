// Tradier fill reconciliation (board 687a5fb4 lane G1, 2026-09-25).
//
// Production evidence (Tradier Sandbox, paper): 40 proposals stuck at "placed", 17 receipts stuck at
// pending_reconciliation with 17 fill_reconciliation_stalled audits, realized P&L and closed lots at
// zero while ~$64K of buys and ~$20.8K of broker-side exits traded.  Root cause: Tradier's order
// listing only covers the CURRENT market session, and a bracket entry is stored under its CONTAINER
// id, which the flattened listing never matches — so a receipt that missed its session could never
// reconcile, and broker-held bracket exits were never booked by anyone.
//
// These tests drive reconcilePendingFills with a mock gateway whose listing is current-session only
// and whose getEquityOrder returns realistic Tradier order payloads (mapped by the real adapter
// helpers), plus a gateway WITHOUT getEquityOrder to prove Alpaca/Robinhood-style gateways keep the
// old listing-only behavior.
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrokerExecution, BrokerGateway, BrokerOrderLookup, EquityOrder } from "../src/lib/types";

vi.mock("../src/lib/vector-db", () => ({
  managedVectorLedgerAuthority: vi.fn(),
  getCurrentVectorProviderAuthority: vi.fn(),
  findRelevantExperiences: async () => [],
  upsertExperiences: async () => {},
  retrieveContext: async () => [],
  storeContext: async () => {},
  storeContexts: async () => ({ attempted: 0, indexed: 0 })
}));

import { getDb, insertFillEvent, listAuditByKind, listFillEvents, insertProposal, getProposal } from "../src/lib/db";
import { calculatePnl } from "../src/lib/performance";
import { reconcilePendingFills } from "../src/lib/strategy-execution";
import { resetFillReconciliationStateForTests } from "../src/lib/fill-reconciliation";
import { executionsFromTradierRow, tradierOrderLookupFromRow } from "../src/lib/tradier";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-tradier-fill-recon-${randomUUID()}.db`)}`;
});

beforeEach(() => {
  resetFillReconciliationStateForTests();
});

const HOUR = 60 * 60_000;
const isoAgo = (ms: number) => new Date(Date.now() - ms).toISOString();

function buyProposal(symbol: string, quantity: number, limitPrice: number, bracket?: { stop: number; takeProfit: number }) {
  return {
    symbol,
    side: "buy" as const,
    type: "limit" as const,
    quantity,
    limitPrice,
    timeInForce: "gfd" as const,
    marketHours: "regular_hours" as const,
    rationale: "Sector relative strength.",
    tradeThesisTag: "Sector-Relative-Strength",
    entryMarketRegime: "Neutral",
    ...(bracket ? { bracketStopLoss: bracket.stop, bracketTakeProfit: bracket.takeProfit, stopPlan: { style: "fixed" as const, rationale: "bracket" } } : {})
  };
}

/** A placed proposal plus its pending receipt, exactly as the placement path writes them. */
function seedPlacedBuy(opts: {
  accountNumber: string;
  orderId: string;
  symbol: string;
  quantity: number;
  limitPrice: number;
  placedAgoMs: number;
  bracket?: { stop: number; takeProfit: number };
  withReceipt?: boolean;
}): { proposalId: string; fillId?: string } {
  const proposalId = randomUUID();
  const proposal = buyProposal(opts.symbol, opts.quantity, opts.limitPrice, opts.bracket);
  insertProposal({
    id: proposalId,
    runId: randomUUID(),
    accountNumber: opts.accountNumber,
    proposal,
    decision: { allowed: true, reasons: [] },
    orderId: opts.orderId,
    status: "placed",
    executionMode: "broker/paper"
  });
  if (opts.withReceipt === false) return { proposalId };
  const fillId = randomUUID();
  insertFillEvent({
    id: fillId,
    proposalId,
    accountNumber: opts.accountNumber,
    source: "paper",
    executionMode: "broker/paper",
    symbol: opts.symbol,
    side: "buy",
    quantity: opts.quantity,
    price: 0,
    notional: 0,
    status: "pending_reconciliation",
    brokerOrderId: opts.orderId,
    filledAt: isoAgo(opts.placedAgoMs),
    raw: { proposal, execution: { orderId: opts.orderId, state: "pending" } }
  });
  return { proposalId, fillId };
}

/** Current-session-only listing (the Tradier contract) + per-order lookup over a mutable book. */
function tradierLikeGateway(book: Map<string, Record<string, unknown>>, opts: { listing?: EquityOrder[]; executions?: BrokerExecution[]; failLookup?: boolean } = {}) {
  const lookups: string[] = [];
  const gateway: BrokerGateway = {
    ordersListIncludesTerminal: true,
    getEquityOrders: async () => opts.listing ?? [],
    getEquityPositions: async () => [],
    getEquityOrder: async (_account: string, orderId: string): Promise<BrokerOrderLookup | undefined> => {
      lookups.push(orderId);
      if (opts.failLookup) throw new Error("Tradier HTTP 502: Bad Gateway");
      const row = book.get(orderId);
      return row ? tradierOrderLookupFromRow(row) : undefined;
    },
    ...(opts.executions ? { listRecentExecutions: async () => opts.executions! } : {})
  } as unknown as BrokerGateway;
  return { gateway, lookups };
}

function fillById(accountNumber: string, id: string) {
  return listFillEvents(accountNumber, "paper").find((fill) => fill.id === id);
}

describe("stalled Tradier receipts reconcile through the per-order lookup", () => {
  it("flips a previous-session receipt the listing no longer carries (sandbox order 35740897)", async () => {
    const accountNumber = `VA-${randomUUID()}`;
    const { proposalId, fillId } = seedPlacedBuy({ accountNumber, orderId: "35740897", symbol: "TTE", quantity: 20, limitPrice: 60.5, placedAgoMs: 30 * 24 * HOUR });
    const book = new Map<string, Record<string, unknown>>([
      ["35740897", {
        id: 35740897, type: "limit", symbol: "TTE", side: "buy", quantity: 20.0, status: "filled", duration: "day",
        price: 60.5, avg_fill_price: 60.41, exec_quantity: 20.0, last_fill_price: 60.41, last_fill_quantity: 20.0,
        remaining_quantity: 0.0, create_date: "2026-07-22T17:38:38.000Z", transaction_date: "2026-07-22T17:41:02.000Z",
        class: "equity", tag: "st-ref-35740897"
      }]
    ]);
    const { gateway, lookups } = tradierLikeGateway(book);

    await reconcilePendingFills(gateway, accountNumber);

    expect(lookups).toContain("35740897");
    expect(fillById(accountNumber, fillId!)).toMatchObject({ status: "filled", quantity: 20, price: 60.41, filledAt: "2026-07-22T17:41:02.000Z" });
    expect(getProposal(proposalId)?.status).toBe("filled");
    expect(listAuditByKind("fill_reconciled", 1000).some((row) => (row.payload as { fillId?: string }).fillId === fillId)).toBe(true);
  });

  it("maps a leg-entry OTOCO container to its entry leg, then books the broker-held exit when it fills", async () => {
    const accountNumber = `VA-${randomUUID()}`;
    const { proposalId, fillId } = seedPlacedBuy({
      accountNumber, orderId: "36120045", symbol: "SLB", quantity: 69, limitPrice: 43.1, placedAgoMs: 50 * 24 * HOUR,
      bracket: { stop: 40.1, takeProfit: 47.4 }
    });
    const container: Record<string, unknown> = {
      id: 36120045, type: "otoco", status: "open", duration: "gtc", class: "otoco", num_legs: 3, strategy: "otoco",
      create_date: "2026-08-05T14:02:11.000Z", transaction_date: "2026-08-05T14:05:40.000Z", tag: "st-ref-slb",
      leg: [
        { id: 36120046, type: "limit", symbol: "SLB", side: "buy", quantity: 69.0, status: "filled", duration: "day", price: 43.1,
          avg_fill_price: 43.02, exec_quantity: 69.0, remaining_quantity: 0.0, transaction_date: "2026-08-05T14:05:40.000Z", class: "equity" },
        { id: 36120047, type: "limit", symbol: "SLB", side: "sell", quantity: 69.0, status: "open", duration: "gtc", price: 47.4,
          avg_fill_price: 0.0, exec_quantity: 0.0, remaining_quantity: 69.0, class: "equity" },
        { id: 36120048, type: "stop", symbol: "SLB", side: "sell", quantity: 69.0, status: "open", duration: "gtc", stop_price: 40.1,
          avg_fill_price: 0.0, exec_quantity: 0.0, remaining_quantity: 69.0, class: "equity" }
      ]
    };
    const book = new Map([["36120045", container]]);
    const { gateway } = tradierLikeGateway(book);

    await reconcilePendingFills(gateway, accountNumber);
    expect(fillById(accountNumber, fillId!)).toMatchObject({ status: "filled", quantity: 69, price: 43.02 });
    expect(getProposal(proposalId)?.status).toBe("filled");
    // Exits still resting: nothing booked yet, and the bracket is not settled.
    expect(listFillEvents(accountNumber, "paper").filter((fill) => fill.side === "sell")).toHaveLength(0);

    // While halted, the stop leg fires at the broker and the OCO cancels the take-profit.
    const legs = container.leg as Array<Record<string, unknown>>;
    Object.assign(legs[2], { status: "filled", avg_fill_price: 40.05, exec_quantity: 69.0, remaining_quantity: 0.0, transaction_date: "2026-08-12T15:30:00.000Z" });
    Object.assign(legs[1], { status: "canceled", transaction_date: "2026-08-12T15:30:00.000Z" });
    Object.assign(container, { status: "filled" });

    await reconcilePendingFills(gateway, accountNumber, "local", undefined, { ignoreThrottle: true });
    await reconcilePendingFills(gateway, accountNumber, "local", undefined, { ignoreThrottle: true });

    const sells = listFillEvents(accountNumber, "paper").filter((fill) => fill.side === "sell");
    expect(sells).toHaveLength(1); // booked once across two passes
    expect(sells[0]).toMatchObject({ status: "filled", quantity: 69, price: 40.05, brokerOrderId: "36120048", filledAt: "2026-08-12T15:30:00.000Z" });
    expect((sells[0]!.raw as { brokerOriginated?: boolean; parentOrderId?: string }).brokerOriginated).toBe(true);
    expect((sells[0]!.raw as { parentOrderId?: string }).parentOrderId).toBe("36120045");
    const entry = fillById(accountNumber, fillId!)!;
    expect((entry.raw as { bracketLegs?: { settled?: boolean } }).bracketLegs?.settled).toBe(true);

    // The lot now closes: realized P&L and closed lots are no longer zero.
    const pnl = calculatePnl(listFillEvents(accountNumber, "paper"));
    expect(pnl.closedLots).toHaveLength(1);
    expect(pnl.realized).toBeCloseTo(69 * (40.05 - 43.02), 6);
  });

  it("handles the container-entry shape (top-level entry execution, exit-only legs)", async () => {
    const accountNumber = `VA-${randomUUID()}`;
    const { fillId } = seedPlacedBuy({ accountNumber, orderId: "36120100", symbol: "CVE", quantity: 149, limitPrice: 16.8, placedAgoMs: 40 * 24 * HOUR, bracket: { stop: 15.5, takeProfit: 18.5 } });
    const book = new Map<string, Record<string, unknown>>([["36120100", {
      id: 36120100, type: "limit", symbol: "CVE", side: "buy", quantity: 149, status: "filled", class: "otoco", tag: "st-ref-cve",
      avg_fill_price: 16.77, exec_quantity: 149, create_date: "2026-08-05T14:03:00.000Z", transaction_date: "2026-08-05T14:03:09.000Z",
      leg: [
        { id: 36120101, type: "limit", side: "sell", quantity: 149, status: "filled", price: 18.5, avg_fill_price: 18.52, exec_quantity: 149, class: "equity", transaction_date: "2026-08-20T13:31:00.000Z" },
        { id: 36120102, type: "stop", side: "sell", quantity: 149, status: "canceled", stop_price: 15.5, class: "equity" }
      ]
    }]]);
    const { gateway } = tradierLikeGateway(book);
    await reconcilePendingFills(gateway, accountNumber);
    expect(fillById(accountNumber, fillId!)).toMatchObject({ status: "filled", quantity: 149, price: 16.77 });
    const sells = listFillEvents(accountNumber, "paper").filter((fill) => fill.side === "sell");
    expect(sells).toHaveLength(1);
    expect(sells[0]).toMatchObject({ symbol: "CVE", quantity: 149, price: 18.52, brokerOrderId: "36120101" });
  });

  it("books a partial fill, keeps the proposal placed, then finalizes when the remainder is canceled", async () => {
    const accountNumber = `VA-${randomUUID()}`;
    const { proposalId, fillId } = seedPlacedBuy({ accountNumber, orderId: "35911012", symbol: "BAC", quantity: 100, limitPrice: 44.2, placedAgoMs: 2 * HOUR });
    const row: Record<string, unknown> = {
      id: 35911012, type: "limit", symbol: "BAC", side: "buy", quantity: 100.0, status: "partially_filled", duration: "day", price: 44.2,
      avg_fill_price: 44.18, exec_quantity: 40.0, remaining_quantity: 60.0, create_date: "2026-07-24T16:36:07.000Z", transaction_date: "2026-07-24T16:40:00.000Z", class: "equity"
    };
    const { gateway } = tradierLikeGateway(new Map([["35911012", row]]));
    await reconcilePendingFills(gateway, accountNumber);
    expect(fillById(accountNumber, fillId!)).toMatchObject({ status: "partially_filled", quantity: 40, price: 44.18 });
    expect(getProposal(proposalId)?.status).toBe("placed");

    Object.assign(row, { status: "canceled", transaction_date: "2026-07-24T20:00:00.000Z" });
    await reconcilePendingFills(gateway, accountNumber, "local", undefined, { ignoreThrottle: true });
    expect(fillById(accountNumber, fillId!)).toMatchObject({ status: "filled", quantity: 40, price: 44.18 });
    expect(getProposal(proposalId)?.status).toBe("filled");
  });

  it("an expired day order with no execution declines the proposal", async () => {
    const accountNumber = `VA-${randomUUID()}`;
    const { proposalId, fillId } = seedPlacedBuy({ accountNumber, orderId: "35818015", symbol: "OXY", quantity: 50, limitPrice: 41.0, placedAgoMs: 60 * 24 * HOUR });
    const book = new Map<string, Record<string, unknown>>([["35818015", {
      id: 35818015, type: "limit", symbol: "OXY", side: "buy", quantity: 50, status: "expired", duration: "day", price: 41.0,
      avg_fill_price: 0.0, exec_quantity: 0.0, remaining_quantity: 50, create_date: "2026-07-23T15:36:18.000Z", transaction_date: "2026-07-23T20:00:00.000Z", class: "equity"
    }]]);
    const { gateway } = tradierLikeGateway(book);
    await reconcilePendingFills(gateway, accountNumber);
    expect(fillById(accountNumber, fillId!)?.status).toBe("expired");
    expect(getProposal(proposalId)?.status).toBe("rejected_by_broker");
  });

  it("a stalled order the broker cannot find stays pending, escalates once, and is not re-queried every tick", async () => {
    const accountNumber = `VA-${randomUUID()}`;
    const { proposalId, fillId } = seedPlacedBuy({ accountNumber, orderId: "35972646", symbol: "VZ", quantity: 98, limitPrice: 40.0, placedAgoMs: 45 * 24 * HOUR });
    const { gateway, lookups } = tradierLikeGateway(new Map());
    await reconcilePendingFills(gateway, accountNumber);
    await reconcilePendingFills(gateway, accountNumber);
    expect(lookups.filter((id) => id === "35972646")).toHaveLength(1); // throttled after not-found
    expect(fillById(accountNumber, fillId!)?.status).toBe("pending_reconciliation");
    expect(getProposal(proposalId)?.status).toBe("placed");
    const stalled = listAuditByKind("fill_reconciliation_stalled", 1000).filter((row) => (row.payload as { fillId?: string }).fillId === fillId);
    expect(stalled).toHaveLength(1);
  });

  it("a broker outage on the lookup never flips anything", async () => {
    const accountNumber = `VA-${randomUUID()}`;
    const { proposalId, fillId } = seedPlacedBuy({ accountNumber, orderId: "35890916", symbol: "CVE", quantity: 10, limitPrice: 16.0, placedAgoMs: 3 * HOUR });
    const { gateway } = tradierLikeGateway(new Map(), { failLookup: true });
    await reconcilePendingFills(gateway, accountNumber);
    expect(fillById(accountNumber, fillId!)?.status).toBe("pending_reconciliation");
    expect(getProposal(proposalId)?.status).toBe("placed");
  });

  it("a gateway without getEquityOrder keeps the listing-only behavior (Alpaca/Robinhood not regressed)", async () => {
    const accountNumber = `ALP-${randomUUID()}`;
    const { proposalId, fillId } = seedPlacedBuy({ accountNumber, orderId: randomUUID(), symbol: "AAPL", quantity: 5, limitPrice: 200, placedAgoMs: 3 * 24 * HOUR });
    const gateway = { getEquityOrders: async () => [], getEquityPositions: async () => [] } as unknown as BrokerGateway;
    await reconcilePendingFills(gateway, accountNumber);
    expect(fillById(accountNumber, fillId!)?.status).toBe("pending_reconciliation");
    expect(getProposal(proposalId)?.status).toBe("placed");
  });
});

describe("the app's own cancel-and-replace is not a broker rejection", () => {
  it("links the market replacement fill to the proposal and marks it filled", async () => {
    const accountNumber = `VA-${randomUUID()}`;
    const { proposalId, fillId } = seedPlacedBuy({ accountNumber, orderId: "36001111", symbol: "MFC", quantity: 111, limitPrice: 31.0, placedAgoMs: 49 * 24 * HOUR });
    const refId = `replace-${randomUUID()}`;
    const now = new Date().toISOString();
    getDb().prepare(
      `INSERT INTO order_replacements (id, user_id, account_number, original_order_id, symbol, side, replacement_ref_id, status, remaining_quantity, replacement_order_id, created_at, updated_at)
       VALUES (?, 'local', ?, '36001111', 'MFC', 'buy', ?, 'replacement_confirmed', 111, '36001190', ?, ?)`
    ).run(randomUUID(), accountNumber, refId, now, now);
    const replacementFillId = randomUUID();
    insertFillEvent({
      id: replacementFillId, accountNumber, source: "paper", executionMode: "broker/paper", symbol: "MFC", side: "buy",
      quantity: 111, price: 31.12, notional: 111 * 31.12, status: "filled", brokerOrderId: "36001190",
      raw: { source: "market_replace", replacementRefId: refId, replacedOrderId: "36001111" }
    });
    const book = new Map<string, Record<string, unknown>>([["36001111", {
      id: 36001111, type: "limit", symbol: "MFC", side: "buy", quantity: 111, status: "canceled", price: 31.0,
      avg_fill_price: 0, exec_quantity: 0, create_date: "2026-08-07T15:00:00.000Z", transaction_date: "2026-08-07T17:47:34.000Z", class: "equity"
    }]]);
    const { gateway } = tradierLikeGateway(book);
    await reconcilePendingFills(gateway, accountNumber);
    expect(fillById(accountNumber, fillId!)?.status).toBe("canceled");
    expect(getProposal(proposalId)?.status).toBe("filled");
    expect(fillById(accountNumber, replacementFillId)?.proposalId).toBe(proposalId);
    // The replacement is still the ONLY booked buy — nothing was double-counted.
    const buys = listFillEvents(accountNumber, "paper").filter((fill) => fill.side === "buy" && fill.status === "filled");
    expect(buys.map((fill) => fill.id)).toEqual([replacementFillId]);
  });
});

describe("proposal convergence and backfill", () => {
  it("flips a placed proposal whose receipt is already final, with no broker call", async () => {
    const accountNumber = `VA-${randomUUID()}`;
    const { proposalId, fillId } = seedPlacedBuy({ accountNumber, orderId: "35890921", symbol: "PYPL", quantity: 10, limitPrice: 70, placedAgoMs: 40 * 24 * HOUR });
    getDb().prepare("UPDATE fill_events SET status = 'filled', price = 69.9, notional = 699 WHERE id = ?").run(fillId);
    const gateway = { getEquityOrders: async () => [], getEquityPositions: async () => [] } as unknown as BrokerGateway;
    await reconcilePendingFills(gateway, accountNumber);
    expect(getProposal(proposalId)?.status).toBe("filled");
    expect(listAuditByKind("proposal_status_converged", 1000).some((row) => (row.payload as { proposalId?: string }).proposalId === proposalId)).toBe(true);
  });

  it("backfills a receipt for a placed proposal that never got one, exactly once", async () => {
    const accountNumber = `VA-${randomUUID()}`;
    const { proposalId } = seedPlacedBuy({ accountNumber, orderId: "35990001", symbol: "BSX", quantity: 60, limitPrice: 88, placedAgoMs: 51 * 24 * HOUR, withReceipt: false });
    const book = new Map<string, Record<string, unknown>>([["35990001", {
      id: 35990001, type: "limit", symbol: "BSX", side: "buy", quantity: 60, status: "filled", price: 88,
      avg_fill_price: 87.95, exec_quantity: 60, create_date: "2026-08-05T14:00:00.000Z", transaction_date: "2026-08-05T14:00:31.000Z", class: "equity"
    }]]);
    const { gateway } = tradierLikeGateway(book);
    await reconcilePendingFills(gateway, accountNumber, "local", undefined, { ignoreThrottle: true });
    await reconcilePendingFills(gateway, accountNumber, "local", undefined, { ignoreThrottle: true });
    const receipts = listFillEvents(accountNumber, "paper").filter((fill) => fill.brokerOrderId === "35990001");
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ proposalId, status: "filled", quantity: 60, price: 87.95, side: "buy" });
    expect(getProposal(proposalId)?.status).toBe("filled");
  });
});

describe("broker-originated executions from the listing", () => {
  it("books owner orders and bracket exit legs once; never app-tagged orders or app bracket entries", async () => {
    const accountNumber = `VA-${randomUUID()}`;
    // Resolve paper mode from history (no connected account in this test).
    insertFillEvent({ accountNumber, source: "paper", executionMode: "broker/paper", symbol: "C", side: "buy", quantity: 47, price: 70, notional: 3290, status: "filled", brokerOrderId: "35000001", filledAt: "2026-08-05T14:00:00.000Z" });
    const rows: Array<Record<string, unknown>> = [
      // Owner sells C from the Tradier UI: untagged, filled.
      { id: 36200001, type: "market", symbol: "C", side: "sell", quantity: 47, status: "filled", avg_fill_price: 72.4, exec_quantity: 47, class: "equity", create_date: "2026-09-25T14:00:00.000Z", transaction_date: "2026-09-25T14:00:02.000Z" },
      // App order (tagged): its own lane books it.
      { id: 36200002, type: "market", symbol: "SHEL", side: "buy", quantity: 5, status: "filled", avg_fill_price: 66.1, exec_quantity: 5, class: "equity", tag: "st-ref-app", create_date: "2026-09-25T14:01:00.000Z", transaction_date: "2026-09-25T14:01:01.000Z" },
      // App OTOCO: entry leg (booked under the container by placement) + a filled take-profit leg.
      { id: 36200010, type: "otoco", class: "otoco", status: "filled", tag: "st-ref-bracket", create_date: "2026-09-25T14:02:00.000Z", leg: [
        { id: 36200011, type: "limit", symbol: "MPC", side: "buy", quantity: 4, status: "filled", avg_fill_price: 150.0, exec_quantity: 4, class: "equity", transaction_date: "2026-09-25T14:02:05.000Z" },
        { id: 36200012, type: "limit", symbol: "MPC", side: "sell", quantity: 4, status: "filled", avg_fill_price: 158.5, exec_quantity: 4, class: "equity", transaction_date: "2026-09-25T15:10:00.000Z" },
        { id: 36200013, type: "stop", symbol: "MPC", side: "sell", quantity: 4, status: "canceled", avg_fill_price: 0, exec_quantity: 0, class: "equity" }
      ] },
      // An open order with nothing executed is ignored.
      { id: 36200020, type: "limit", symbol: "CI", side: "buy", quantity: 27, status: "open", avg_fill_price: 0, exec_quantity: 0, class: "equity", create_date: "2026-09-25T14:03:00.000Z" }
    ];
    const executions = rows.flatMap((row) => executionsFromTradierRow(row));
    expect(executions.find((e) => e.order.id === "36200011")?.role).toBe("entry");
    expect(executions.find((e) => e.order.id === "36200012")?.role).toBe("exit");
    const { gateway } = tradierLikeGateway(new Map(), { executions });

    await reconcilePendingFills(gateway, accountNumber, "local", undefined, { ignoreThrottle: true });
    await reconcilePendingFills(gateway, accountNumber, "local", undefined, { ignoreThrottle: true });

    const booked = listFillEvents(accountNumber, "paper").filter((fill) => (fill.raw as { brokerOriginated?: boolean } | undefined)?.brokerOriginated);
    expect(booked.map((fill) => fill.brokerOrderId).sort()).toEqual(["36200001", "36200012"]);
    expect(booked.find((fill) => fill.brokerOrderId === "36200001")).toMatchObject({ symbol: "C", side: "sell", quantity: 47, price: 72.4, status: "filled" });
    // The owner's sell closes the app's C lot, so P&L sees it.
    const pnl = calculatePnl(listFillEvents(accountNumber, "paper"));
    expect(pnl.closedLots.some((lot) => lot.symbol === "C")).toBe(true);
  });
});
