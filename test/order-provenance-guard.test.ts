import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_POLICY } from "../src/lib/defaults";
import type { BrokerGateway, ConnectedAccount, EquityOrder, EquityOrderInput, EquityPosition, TradingPolicy } from "../src/lib/types";

const broker = vi.hoisted(() => ({
  gateway: null as BrokerGateway | null
}));

vi.mock("../src/lib/broker", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/broker")>();
  return {
    ...actual,
    getBrokerGateway: () => {
      if (!broker.gateway) throw new Error("broker gateway not configured for test");
      return broker.gateway;
    }
  };
});

beforeEach(() => {
  vi.resetModules();
  broker.gateway = null;
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-order-provenance-${randomUUID()}.db`)}`;
});

describe("order provenance guard", () => {
  it("does not auto-remediate a stale activated bracket take-profit leg", async () => {
    const { autoRemediateStaleExitOrders } = await import("../src/lib/order-replacement");
    const { getDb } = await import("../src/lib/db");
    const now = new Date("2026-06-30T16:30:00.000Z");
    const staleBracketTp = order({
      id: "bracket-tp-1",
      side: "sell",
      type: "limit",
      state: "new",
      orderClass: "bracket",
      clientOrderId: "proposal-ref-bracket-tp",
      createdAt: "2026-06-30T10:00:00.000Z",
      updatedAt: "2026-06-30T16:00:00.000Z"
    });
    const gateway = gatewayMock({ orders: [[staleBracketTp]], positions: [position({ quantity: 10 })] });

    const out = await autoRemediateStaleExitOrders({
      userId: "local",
      policy: paperPolicy(),
      activeAccount: account("paper"),
      gateway,
      orders: [staleBracketTp],
      now
    });

    expect(out).toMatchObject({ attempted: 0, remediated: 0, deferred: 1 });
    const row = getDb()
      .prepare("SELECT 1 FROM order_replacements WHERE original_order_id = ?")
      .get("bracket-tp-1");
    expect(row).toBeUndefined();
    expect(gateway.cancelEquityOrder).not.toHaveBeenCalled();
    expect(gateway.placeEquityOrder).not.toHaveBeenCalled();
  });

  it("does not auto-remediate a stale owner-placed GTC sell whose Alpaca UUID is not an app prefix", async () => {
    const { autoRemediateStaleExitOrders } = await import("../src/lib/order-replacement");
    const { getDb } = await import("../src/lib/db");
    const staleOwnerSell = order({
      id: "owner-gtc-uuid",
      side: "sell",
      type: "limit",
      state: "accepted",
      clientOrderId: "6fa459ea-ee8a-3ca4-894e-db77e160355e",
      createdAt: "2026-01-01T00:00:00.000Z"
    });
    const gateway = gatewayMock({ orders: [[staleOwnerSell]], positions: [position({ quantity: 10 })] });

    const out = await autoRemediateStaleExitOrders({
      userId: "local",
      policy: paperPolicy(),
      activeAccount: account("paper"),
      gateway,
      orders: [staleOwnerSell]
    });

    expect(out).toMatchObject({ attempted: 0, remediated: 0, deferred: 1 });
    const row = getDb()
      .prepare("SELECT 1 FROM order_replacements WHERE original_order_id = ?")
      .get("owner-gtc-uuid");
    expect(row).toBeUndefined();
    expect(gateway.placeEquityOrder).not.toHaveBeenCalled();
    expect(gateway.cancelEquityOrder).not.toHaveBeenCalled();
  });

  it("does not auto-remediate a stale owner-placed GTC sell without clientOrderId", async () => {
    const { autoRemediateStaleExitOrders } = await import("../src/lib/order-replacement");
    const { getDb } = await import("../src/lib/db");
    const staleOwnerSell = order({
      id: "owner-gtc-1",
      side: "sell",
      type: "limit",
      state: "accepted",
      clientOrderId: undefined,
      createdAt: "2026-01-01T00:00:00.000Z"
    });
    const gateway = gatewayMock({ orders: [[staleOwnerSell]], positions: [position({ quantity: 10 })] });

    const out = await autoRemediateStaleExitOrders({
      userId: "local",
      policy: paperPolicy(),
      activeAccount: account("paper"),
      gateway,
      orders: [staleOwnerSell]
    });

    expect(out).toMatchObject({ attempted: 0, remediated: 0, deferred: 1 });
    const row = getDb()
      .prepare("SELECT 1 FROM order_replacements WHERE original_order_id = ?")
      .get("owner-gtc-1");
    expect(row).toBeUndefined();
    expect(gateway.placeEquityOrder).not.toHaveBeenCalled();
  });

  it("does not re-place a protective stop the owner just cancelled", async () => {
    const { cancelWorkingOrder } = await import("../src/lib/order-cancel");
    const { reconcileBrokerProtectiveStops } = await import("../src/lib/broker-protective-stops");
    const { hasOwnerCancelledProtectiveStop } = await import("../src/lib/order-provenance");
    const { listBrokerProtectiveStops, setPolicy, upsertBrokerProtectiveStop } = await import("../src/lib/db");

    const userId = "local";
    const accountNumber = "PS-OWNER-CANCEL";
    const policy: TradingPolicy = {
      ...DEFAULT_POLICY,
      accountNumber,
      activeBroker: "robinhood",
      robinhoodBrokerStops: true,
      riskRules: { ...DEFAULT_POLICY.riskRules, stopLossPct: 8 }
    };
    setPolicy(policy, userId);

    const stopOrderId = "broker-stop-1";
    upsertBrokerProtectiveStop({
      id: `protstop-${userId}-${accountNumber}-AAPL`,
      userId,
      accountNumber,
      symbol: "AAPL",
      brokerOrderId: stopOrderId,
      quantity: 10,
      stopPrice: 92,
      status: "resting",
      kind: "fixed"
    });

    const openStop = order({
      id: stopOrderId,
      symbol: "AAPL",
      side: "sell",
      type: "stop_market",
      state: "open",
      clientOrderId: "protstop-local-PS-OWNER-CANCEL-AAPL-1"
    });
    const gw = gatewayMock({ orders: [[openStop]] });
    broker.gateway = gw;

    await cancelWorkingOrder({ userId, orderId: stopOrderId, source: "console" });
    expect(gw.cancelEquityOrder).toHaveBeenCalledWith(accountNumber, stopOrderId);
    expect(hasOwnerCancelledProtectiveStop(userId, accountNumber, "AAPL")).toBe(true);
    expect(listBrokerProtectiveStops(accountNumber, userId)).toHaveLength(0);

    const canceledOrders = [order({
      id: stopOrderId,
      symbol: "AAPL",
      side: "sell",
      type: "stop_market",
      state: "canceled",
      clientOrderId: "protstop-local-PS-OWNER-CANCEL-AAPL-1"
    })];
    const reconcileGw = gatewayMock({ orders: [canceledOrders] });

    const result = await reconcileBrokerProtectiveStops({
      userId,
      policy,
      accountNumber,
      gateway: reconcileGw,
      positions: [position({ quantity: 10 })],
      executionMode: "broker/live",
      running: true,
      orders: canceledOrders,
      ordersListed: true
    });

    expect(result.placed).toBe(0);
    expect(reconcileGw.placeEquityOrder).not.toHaveBeenCalled();
  });

  it("tombstones an owner-cancelled protective stop when the advisory lookup misses the order", async () => {
    const { cancelWorkingOrder } = await import("../src/lib/order-cancel");
    const { reconcileBrokerProtectiveStops } = await import("../src/lib/broker-protective-stops");
    const { hasOwnerCancelledProtectiveStop } = await import("../src/lib/order-provenance");
    const { listBrokerProtectiveStops, setPolicy, upsertBrokerProtectiveStop } = await import("../src/lib/db");

    const userId = "local";
    const accountNumber = "PS-OWNER-CANCEL-LOOKUP-MISS";
    const policy: TradingPolicy = {
      ...DEFAULT_POLICY,
      accountNumber,
      activeBroker: "robinhood",
      robinhoodBrokerStops: true,
      riskRules: { ...DEFAULT_POLICY.riskRules, stopLossPct: 8 }
    };
    setPolicy(policy, userId);

    const stopOrderId = "broker-stop-lookup-miss";
    upsertBrokerProtectiveStop({
      id: `protstop-${userId}-${accountNumber}-AAPL`,
      userId,
      accountNumber,
      symbol: "AAPL",
      brokerOrderId: stopOrderId,
      quantity: 10,
      stopPrice: 92,
      status: "resting",
      kind: "fixed"
    });

    // Console cancel is fail-open on the advisory read: empty/timeout still cancels by id.
    // The tracked row is the only remaining source of the symbol for the tombstone.
    const gw = gatewayMock({ orders: [[]] });
    broker.gateway = gw;

    await cancelWorkingOrder({ userId, orderId: stopOrderId, source: "console" });
    expect(gw.cancelEquityOrder).toHaveBeenCalledWith(accountNumber, stopOrderId);
    expect(hasOwnerCancelledProtectiveStop(userId, accountNumber, "AAPL")).toBe(true);
    expect(listBrokerProtectiveStops(accountNumber, userId)).toHaveLength(0);

    const canceledOrders = [order({
      id: stopOrderId,
      symbol: "AAPL",
      side: "sell",
      type: "stop_market",
      state: "canceled",
      clientOrderId: "protstop-local-PS-OWNER-CANCEL-LOOKUP-MISS-AAPL-1"
    })];
    const reconcileGw = gatewayMock({ orders: [canceledOrders] });

    const result = await reconcileBrokerProtectiveStops({
      userId,
      policy,
      accountNumber,
      gateway: reconcileGw,
      positions: [position({ quantity: 10 })],
      executionMode: "broker/live",
      running: true,
      orders: canceledOrders,
      ordersListed: true
    });

    expect(result.placed).toBe(0);
    expect(reconcileGw.placeEquityOrder).not.toHaveBeenCalled();
  });

  it("tombstones an owner-cancelled protective stop when cancelEquityOrder times out", async () => {
    const { cancelWorkingOrder } = await import("../src/lib/order-cancel");
    const { reconcileBrokerProtectiveStops } = await import("../src/lib/broker-protective-stops");
    const { hasOwnerCancelledProtectiveStop } = await import("../src/lib/order-provenance");
    const { listBrokerProtectiveStops, setPolicy, upsertBrokerProtectiveStop } = await import("../src/lib/db");

    const userId = "local";
    const accountNumber = "PS-OWNER-CANCEL-TIMEOUT";
    const policy: TradingPolicy = {
      ...DEFAULT_POLICY,
      accountNumber,
      activeBroker: "robinhood",
      robinhoodBrokerStops: true,
      riskRules: { ...DEFAULT_POLICY.riskRules, stopLossPct: 8 }
    };
    setPolicy(policy, userId);

    const stopOrderId = "broker-stop-timeout";
    upsertBrokerProtectiveStop({
      id: `protstop-${userId}-${accountNumber}-AAPL`,
      userId,
      accountNumber,
      symbol: "AAPL",
      brokerOrderId: stopOrderId,
      quantity: 10,
      stopPrice: 92,
      status: "resting",
      kind: "fixed"
    });

    const openStop = order({
      id: stopOrderId,
      symbol: "AAPL",
      side: "sell",
      type: "stop_market",
      state: "open",
      clientOrderId: "protstop-local-PS-OWNER-CANCEL-TIMEOUT-AAPL-1"
    });
    const gw = gatewayMock({ orders: [[openStop]] });
    gw.cancelEquityOrder = vi.fn(async () => {
      throw new Error("Alpaca broker call timed out");
    });
    broker.gateway = gw;

    await expect(cancelWorkingOrder({ userId, orderId: stopOrderId, source: "console" }))
      .rejects.toThrow(/timed out/i);
    expect(gw.cancelEquityOrder).toHaveBeenCalledWith(accountNumber, stopOrderId);
    expect(hasOwnerCancelledProtectiveStop(userId, accountNumber, "AAPL")).toBe(true);
    // Cancel ACK was lost — keep the tracked row so a still-live stop is not orphaned.
    expect(listBrokerProtectiveStops(accountNumber, userId)).toHaveLength(1);

    const canceledOrders = [order({
      id: stopOrderId,
      symbol: "AAPL",
      side: "sell",
      type: "stop_market",
      state: "canceled",
      clientOrderId: "protstop-local-PS-OWNER-CANCEL-TIMEOUT-AAPL-1"
    })];
    const reconcileGw = gatewayMock({ orders: [canceledOrders] });

    const timeoutResult = await reconcileBrokerProtectiveStops({
      userId,
      policy,
      accountNumber,
      gateway: reconcileGw,
      positions: [position({ quantity: 10 })],
      executionMode: "broker/live",
      running: true,
      orders: canceledOrders,
      ordersListed: true
    });

    expect(timeoutResult.placed).toBe(0);
    expect(reconcileGw.placeEquityOrder).not.toHaveBeenCalled();
  });

  // The owner-cancel tombstone is permanent and had no delete path anywhere in the repo, so it
  // used to outlive the position it was written for.  A later re-entry into the same symbol is a
  // position the owner never declined protection on; leaving it tombstoned left it NAKED forever.
  it("retires the owner-cancel tombstone once the position is flat, so a re-entry is protected again", async () => {
    const { reconcileBrokerProtectiveStops } = await import("../src/lib/broker-protective-stops");
    const { hasOwnerCancelledProtectiveStop, recordOwnerCancelledProtectiveStop } = await import(
      "../src/lib/order-provenance"
    );
    const { setPolicy } = await import("../src/lib/db");

    const userId = "local";
    const accountNumber = "PS-OWNER-CANCEL-REENTRY";
    const policy: TradingPolicy = {
      ...DEFAULT_POLICY,
      accountNumber,
      activeBroker: "robinhood",
      robinhoodBrokerStops: true,
      riskRules: { ...DEFAULT_POLICY.riskRules, stopLossPct: 8 }
    };
    setPolicy(policy, userId);

    // The owner cancelled AAPL's app-managed protective stop while the position was open.
    recordOwnerCancelledProtectiveStop(userId, accountNumber, "AAPL");
    expect(hasOwnerCancelledProtectiveStop(userId, accountNumber, "AAPL")).toBe(true);

    // Tick 1: AAPL has since been sold out.  `positions` here is a SUCCESSFUL broker snapshot
    // (the caller returns early when the read throws), so AAPL's absence means genuinely flat.
    const flatGw = gatewayMock({ orders: [[]] });
    await reconcileBrokerProtectiveStops({
      userId,
      policy,
      accountNumber,
      gateway: flatGw,
      positions: [position({ symbol: "MSFT", quantity: 5 })],
      executionMode: "broker/live",
      running: true,
      orders: [],
      ordersListed: true
    });
    expect(hasOwnerCancelledProtectiveStop(userId, accountNumber, "AAPL")).toBe(false);

    // Tick 2: the owner re-enters AAPL.  This new position was never un-protected by anyone, so
    // the reconciler must arm a protective stop for it.
    const reentryGw = gatewayMock({ orders: [[]] });
    const reentry = await reconcileBrokerProtectiveStops({
      userId,
      policy,
      accountNumber,
      gateway: reentryGw,
      positions: [position({ symbol: "AAPL", quantity: 10 })],
      executionMode: "broker/live",
      running: true,
      orders: [],
      ordersListed: true
    });

    expect(reentryGw.placeEquityOrder).toHaveBeenCalled();
    expect(reentry.placed).toBe(1);
  });

  it("keeps the owner-cancel tombstone while the un-protected position is still open", async () => {
    const { reconcileBrokerProtectiveStops } = await import("../src/lib/broker-protective-stops");
    const { hasOwnerCancelledProtectiveStop, recordOwnerCancelledProtectiveStop } = await import(
      "../src/lib/order-provenance"
    );
    const { setPolicy } = await import("../src/lib/db");

    const userId = "local";
    const accountNumber = "PS-OWNER-CANCEL-STILL-OPEN";
    const policy: TradingPolicy = {
      ...DEFAULT_POLICY,
      accountNumber,
      activeBroker: "robinhood",
      robinhoodBrokerStops: true,
      riskRules: { ...DEFAULT_POLICY.riskRules, stopLossPct: 8 }
    };
    setPolicy(policy, userId);

    recordOwnerCancelledProtectiveStop(userId, accountNumber, "AAPL");

    const gw = gatewayMock({ orders: [[]] });
    const result = await reconcileBrokerProtectiveStops({
      userId,
      policy,
      accountNumber,
      gateway: gw,
      positions: [position({ symbol: "AAPL", quantity: 10 })],
      executionMode: "broker/live",
      running: true,
      orders: [],
      ordersListed: true
    });

    expect(hasOwnerCancelledProtectiveStop(userId, accountNumber, "AAPL")).toBe(true);
    expect(result.placed).toBe(0);
    expect(gw.placeEquityOrder).not.toHaveBeenCalled();
  });
});

function paperPolicy(): TradingPolicy & { accountNumber: string } {
  return {
    ...DEFAULT_POLICY,
    connectedAccountId: "acct-paper",
    accountNumber: "APCA-PAPER"
  };
}

function account(environment: "paper" | "live"): ConnectedAccount {
  return {
    id: environment === "paper" ? "acct-paper" : "acct-live",
    userId: "local",
    broker: "alpaca",
    environment,
    accountNumber: environment === "paper" ? "APCA-PAPER" : "APCA-LIVE",
    label: environment === "paper" ? "Alpaca Paper" : "Alpaca Brokerage",
    isActive: true,
    capabilities: {
      equityTrading: true,
      shortSelling: false,
      optionsTrading: false,
      futuresTrading: false,
      cryptoTrading: false,
      marginEnabled: false,
      accountType: "brokerage"
    },
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z"
  };
}

function order(overrides: Partial<EquityOrder> = {}): EquityOrder {
  return {
    id: "limit-1",
    symbol: "AAPL",
    side: "buy",
    type: "limit",
    state: "accepted",
    quantity: 10,
    filledQuantity: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

function position(overrides: Partial<EquityPosition> = {}): EquityPosition {
  return { symbol: "AAPL", quantity: 10, averageCost: 100, marketValue: 1000, ...overrides };
}

function gatewayMock(input: {
  orders: EquityOrder[][];
  positions?: EquityPosition[];
  execution?: { orderId?: string; refId: string; state: string; filledQuantity?: number; averagePrice?: number; raw: unknown };
}): BrokerGateway {
  const orderResponses = [...input.orders];
  return {
    getAccounts: vi.fn(async () => []),
    getPortfolio: vi.fn(),
    getEquityPositions: vi.fn(async () => input.positions ?? []),
    getEquityOrders: vi.fn(async () => orderResponses.shift() ?? input.orders.at(-1) ?? []),
    getEquityQuotes: vi.fn(async () => ({})),
    getEquityTradability: vi.fn(async () => ({})),
    reviewEquityOrder: vi.fn(async (orderInput: EquityOrderInput) => ({
      estimatedNotional: Math.abs((orderInput.quantity ?? 0) * 100),
      alerts: [],
      raw: { reviewed: true }
    })),
    placeEquityOrder: vi.fn(async () => (
      input.execution ?? { orderId: "market-1", refId: "ref-1", state: "accepted", raw: { id: "market-1" } }
    )),
    cancelEquityOrder: vi.fn(async (_accountNumber: string, orderId: string) => ({
      orderId,
      refId: "cancel-ref",
      state: "canceled",
      raw: { canceled: true }
    }))
  };
}
