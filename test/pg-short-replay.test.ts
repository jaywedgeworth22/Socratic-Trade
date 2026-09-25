/**
 * PG replay — the 2026-07-08 unintended short on Alpaca Paper PA33IDTHMFK9 (long-only mandate).
 *
 *   11:04:00Z  bracket entry BUY limit PG 12 @152.75 day (d9f77ab8) with a take-profit leg
 *              SELL limit 165 (c6e5334f, state "held", Alpaca-minted client id 1bc35dbf-...).
 *   11:19:32Z  limit_order_stale fired for BOTH the unfilled parent and the held leg.
 *   11:19:33Z  stale-exit auto-remediation cancelled the HELD leg and placed a standalone
 *              MARKET SELL 12 PG (92d9e66d).  The parent never filled.
 *   13:33:43Z  the market sell filled 12 @149.76 -> a 12-share SHORT.
 *
 * Every layer is replayed with the exact shapes, and with the leg labelled every way Alpaca's
 * flat order list could label it (order_class "bracket", "" / absent, held or activated).
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_POLICY } from "../src/lib/defaults";
import type {
  BrokerGateway,
  ConnectedAccount,
  EquityOrder,
  EquityOrderInput,
  EquityPosition
} from "../src/lib/types";

beforeEach(() => {
  vi.resetModules();
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-pg-replay-${randomUUID()}.db`)}`;
});

const ACCOUNT = "PA33IDTHMFK9";
const AT_1104 = "2026-07-08T11:04:00.000Z";
const AT_1119 = new Date("2026-07-08T11:19:32.000Z");

function parent(patch: Partial<EquityOrder> = {}): EquityOrder {
  return {
    id: "d9f77ab8-0000-4000-8000-000000000001",
    symbol: "PG",
    side: "buy",
    type: "limit",
    state: "new",
    quantity: 12,
    filledQuantity: 0,
    limitPrice: 152.75,
    timeInForce: "day",
    createdAt: AT_1104,
    updatedAt: AT_1104,
    clientOrderId: "969c4499-0000-4000-8000-000000000002",
    orderClass: "bracket",
    ...patch
  };
}

function takeProfitLeg(patch: Partial<EquityOrder> = {}): EquityOrder {
  return {
    id: "c6e5334f-0000-4000-8000-000000000003",
    symbol: "PG",
    side: "sell",
    type: "limit",
    state: "held",
    quantity: 12,
    filledQuantity: 0,
    limitPrice: 165,
    timeInForce: "day",
    createdAt: AT_1104,
    updatedAt: AT_1104,
    clientOrderId: "1bc35dbf-0000-4000-8000-000000000004",
    orderClass: "bracket",
    ...patch
  };
}

/** The labellings Alpaca's flat (non-nested) list could give the leg. */
const LEG_LABELS: Array<{ name: string; patch: Partial<EquityOrder> }> = [
  { name: "held + order_class bracket", patch: {} },
  { name: "held + order_class absent", patch: { orderClass: undefined } },
  { name: "held + order_class empty string", patch: { orderClass: "" } },
  { name: "held + order_class oco", patch: { orderClass: "oco" } }
];

function paperPolicy() {
  return {
    ...DEFAULT_POLICY,
    activeBroker: "alpaca" as const,
    connectedAccountId: "acct-paper",
    accountNumber: ACCOUNT,
    staleLimitOrderMinutes: 15,
    autoRemediateStaleExits: true
  };
}

function account(): ConnectedAccount {
  return {
    id: "acct-paper",
    userId: "local",
    broker: "alpaca",
    environment: "paper",
    accountNumber: ACCOUNT,
    label: "Alpaca Paper",
    isActive: true,
    capabilities: {
      equityTrading: true,
      shortSelling: true,
      optionsTrading: false,
      futuresTrading: false,
      cryptoTrading: false,
      marginEnabled: true,
      accountType: "brokerage"
    },
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z"
  };
}

function gatewayMock(orders: EquityOrder[], positions: EquityPosition[] = []) {
  const placed: Array<EquityOrderInput & { refId: string }> = [];
  const cancelled: string[] = [];
  const gateway: BrokerGateway = {
    getAccounts: vi.fn(async () => []),
    getPortfolio: vi.fn(),
    getEquityPositions: vi.fn(async () => positions),
    getEquityOrders: vi.fn(async () => orders),
    getEquityQuotes: vi.fn(async () => ({})),
    getEquityTradability: vi.fn(async () => ({})),
    reviewEquityOrder: vi.fn(async () => ({ estimatedNotional: 1797, alerts: [], raw: {} })),
    placeEquityOrder: vi.fn(async (input: EquityOrderInput & { refId: string }) => {
      placed.push(input);
      return { orderId: "92d9e66d", refId: input.refId, state: "accepted", raw: {} };
    }),
    cancelEquityOrder: vi.fn(async (_account: string, orderId: string) => {
      cancelled.push(orderId);
      return { orderId, refId: "cancel", state: "canceled", raw: {} };
    })
  };
  return { gateway, placed, cancelled };
}

describe("PG replay 11:19:32Z — the stale scan", () => {
  for (const label of LEG_LABELS) {
    it(`never alerts the take-profit leg as stale (${label.name})`, async () => {
      const { notifyStaleLimitOrders } = await import("../src/lib/stale-limit-orders");
      const { listNotificationEvents } = await import("../src/lib/db");
      const leg = takeProfitLeg(label.patch);
      // Positive control: an ordinary owner limit sell on another symbol IS alerted, so the
      // negative assertion below cannot pass just because nothing was recorded.
      const control: EquityOrder = {
        id: "control-limit",
        symbol: "AAPL",
        side: "sell",
        type: "limit",
        state: "accepted",
        quantity: 3,
        filledQuantity: 0,
        limitPrice: 250,
        createdAt: "2026-07-08T10:50:00.000Z"
      };
      const result = await notifyStaleLimitOrders({
        userId: "local",
        policy: paperPolicy(),
        orders: [parent(), leg, control],
        now: AT_1119
      });
      expect(result.alerted).toBe(1);
      const events = listNotificationEvents("local", 50).filter((event) => event.type === "limit_order_stale");
      expect(events.some((event) => (event.payload as { order?: { id?: string } })?.order?.id === "control-limit")).toBe(true);
      expect(events.some((event) => (event.payload as { order?: { id?: string } })?.order?.id === leg.id)).toBe(false);
    });

    it(`never cancel-replaces the take-profit leg (${label.name})`, async () => {
      const { autoRemediateStaleExitOrders } = await import("../src/lib/order-replacement");
      const leg = takeProfitLeg(label.patch);
      const { gateway, placed, cancelled } = gatewayMock([parent(), leg]);
      await autoRemediateStaleExitOrders({
        userId: "local",
        policy: paperPolicy(),
        activeAccount: account(),
        gateway,
        now: AT_1119
      });
      expect(cancelled).toEqual([]);
      expect(placed).toEqual([]);
    });
  }

  it("classifies an activated leg with NO order_class as a bracket child via its bracket-class sibling", async () => {
    const { isContingentOrderLeg, autoReplaceProvenanceSkipReason } = await import("../src/lib/order-provenance");
    // Worst case: the leg reads as an ordinary working order AND carries an app-minted client id,
    // so neither the held-state nor the provenance check would stop it.
    const leg = takeProfitLeg({ state: "new", orderClass: undefined, clientOrderId: "sstop-looks-app-placed" });
    const siblings = [parent({ state: "filled", filledQuantity: 12 }), leg];
    expect(isContingentOrderLeg(leg, siblings)).toBe(true);
    expect(autoReplaceProvenanceSkipReason(leg, { userId: "local", accountNumber: ACCOUNT }, siblings)).toBe("bracket_leg");
    // Without the sibling it would have looked app-placed.
    expect(autoReplaceProvenanceSkipReason(leg, { userId: "local", accountNumber: ACCOUNT }, [leg])).toBeNull();
    // A held order is a contingent leg however it is labelled.
    expect(isContingentOrderLeg(takeProfitLeg({ orderClass: undefined }), [])).toBe(true);
  });

  it("measures an activated leg's age from activation, and does not guess when activation is unknown", async () => {
    const { listStaleLimitOrders } = await import("../src/lib/stale-limit-orders");
    const now = new Date("2026-07-08T13:40:00.000Z");
    // Parent filled at 13:33; leg activated then (updatedAt bumped) — 7 minutes old, not stale.
    const activated = takeProfitLeg({ state: "new", updatedAt: "2026-07-08T13:33:43.000Z" });
    expect(listStaleLimitOrders([activated], { staleLimitOrderMinutes: 15 }, now)).toEqual([]);
    // Same leg with no updatedAt: createdAt (11:04) is NOT its activation — never report it stale.
    const unknownActivation = takeProfitLeg({ state: "new", updatedAt: undefined });
    expect(listStaleLimitOrders([unknownActivation], { staleLimitOrderMinutes: 15 }, now)).toEqual([]);
  });
});

describe("PG replay 11:19:33Z — the market SELL at the placement choke point", () => {
  it("refuses a standalone MARKET SELL 12 PG while the account holds zero PG", async () => {
    const { withPositionInvariant } = await import("../src/lib/order-position-invariant");
    const { gateway, placed } = gatewayMock([parent(), takeProfitLeg()], []);
    const wrapped = withPositionInvariant(gateway, paperPolicy(), "local");
    await expect(
      wrapped.placeEquityOrder({
        accountNumber: ACCOUNT,
        symbol: "PG",
        side: "sell",
        type: "market",
        quantity: 12,
        timeInForce: "gfd",
        marketHours: "regular_hours",
        refId: "92d9e66d-replacement"
      })
    ).rejects.toThrow(/would open a SHORT/i);
    // 13:33:43Z: nothing was ever sent, so nothing can fill into a short.
    expect(placed).toEqual([]);
  });
});
