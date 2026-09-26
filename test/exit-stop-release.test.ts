/**
 * Lane G2 (2026-09-25): approved exits must not be blocked by the app's OWN resting protective
 * stop.  Alpaca Paper evidence: ~62 of 115 blocked proposals in 120 days were exits whose shares
 * were held by the app's own GTC stop (broker_protective_stops, e.g. BAC 24 / KO 14 / PYPL 30).
 *
 * Drives the real planner, release sequence, and protective-stop reconcile against a stateful
 * fake broker that ENFORCES held quantity the way Alpaca does (403 insufficient qty when a sell
 * exceeds position minus shares held by other open sell orders), so a test only passes when the
 * stop is genuinely out of the way before the exit reaches the broker.
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_POLICY } from "../src/lib/defaults";
import { reconcileBrokerProtectiveStops } from "../src/lib/broker-protective-stops";
import { getDb, listBrokerProtectiveStops, listFillEvents, upsertBrokerProtectiveStop } from "../src/lib/db";
import { setInternalSetting } from "../src/lib/db-settings";
import {
  ExitStopReleaseError,
  placeExitReleasingOwnStops,
  planExitStopRelease,
  type ExitStopReleasePlan
} from "../src/lib/exit-stop-release";
import {
  EXIT_STOP_RELEASE_STALE_MS,
  exitStopReleaseKey,
  getExitStopReleaseIntent,
  type ExitStopReleaseIntent
} from "../src/lib/exit-stop-release-intents";
import type { EquityOrder, EquityOrderInput as BaseOrderInput, EquityPosition, TradeProposal, TradingPolicy } from "../src/lib/types";

/** The gateway contract: every placement carries its idempotency key. */
type EquityOrderInput = BaseOrderInput & { refId: string };

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-exit-stop-release-${randomUUID()}.db`)}`;
});

type CancelBehavior = "cancel" | "fill" | "stuck";

interface FakeBroker {
  positions: EquityPosition[];
  orders: EquityOrder[];
  placed: EquityOrderInput[];
  cancelled: string[];
  cancelBehavior: CancelBehavior;
  /** Market exits fill immediately at this price (undefined = rest as "new"). */
  marketFillPrice?: number;
  seq: number;
  getEquityPositions(accountNumber: string): Promise<EquityPosition[]>;
  getEquityOrders(accountNumber: string): Promise<EquityOrder[]>;
  cancelEquityOrder(accountNumber: string, orderId: string): Promise<{ orderId: string; refId: string; state: string; raw: unknown }>;
  placeEquityOrder(order: EquityOrderInput): Promise<{ orderId: string; refId: string; state: string; raw: unknown }>;
}

const ACTIVE = new Set(["new", "accepted", "pending_new", "held", "partially_filled", "pending_cancel"]);

function heldSellQty(broker: FakeBroker, symbol: string): number {
  return broker.orders
    .filter((o) => o.symbol === symbol && o.side === "sell" && ACTIVE.has(o.state))
    .reduce((sum, o) => sum + Math.max((o.quantity ?? 0) - (o.filledQuantity ?? 0), 0), 0);
}

function adjustPosition(broker: FakeBroker, symbol: string, delta: number): void {
  const pos = broker.positions.find((p) => p.symbol === symbol);
  if (!pos) return;
  const mark = pos.marketValue / pos.quantity;
  pos.quantity += delta;
  pos.marketValue = pos.quantity * mark;
  if (Math.abs(pos.quantity) < 1e-9) broker.positions = broker.positions.filter((p) => p.symbol !== symbol);
}

function fakeBroker(init: { positions: EquityPosition[]; orders: EquityOrder[] }): FakeBroker {
  const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
  const b: FakeBroker = {
    positions: clone(init.positions),
    orders: clone(init.orders),
    placed: [],
    cancelled: [],
    cancelBehavior: "cancel",
    marketFillPrice: undefined,
    seq: 0,
    async getEquityPositions() {
      return clone(b.positions);
    },
    async getEquityOrders() {
      return clone(b.orders);
    },
    async cancelEquityOrder(_accountNumber, orderId) {
      b.cancelled.push(orderId);
      const order = b.orders.find((o) => o.id === orderId);
      if (!order) throw new Error("HTTP 404 order not found");
      if (b.cancelBehavior === "fill") {
        // The stop triggered and filled before the cancel reached the book.
        const qty = (order.quantity ?? 0) - (order.filledQuantity ?? 0);
        order.state = "filled";
        order.filledQuantity = order.quantity;
        order.averagePrice = order.stopPrice ?? 1;
        adjustPosition(b, order.symbol, order.side === "sell" ? -qty : qty);
        throw new Error("HTTP 422 order is already in filled state");
      }
      order.state = b.cancelBehavior === "stuck" ? "pending_cancel" : "canceled";
      return { orderId, refId: "x", state: "cancel_requested", raw: {} };
    },
    async placeEquityOrder(order) {
      b.placed.push(order);
      const pos = b.positions.find((p) => p.symbol === order.symbol);
      const qty = order.quantity ?? 0;
      if (order.side === "sell") {
        const available = Math.max((pos?.quantity ?? 0) - heldSellQty(b, order.symbol), 0);
        if (qty > available + 1e-9) {
          throw new Error(`HTTP 403 insufficient qty available for order (requested: ${qty}, available: ${available})`);
        }
      }
      b.seq += 1;
      const id = `ord-${b.seq}`;
      const fills = order.type === "market" && b.marketFillPrice !== undefined;
      b.orders.push({
        id,
        symbol: order.symbol,
        side: order.side,
        type: order.type,
        state: fills ? "filled" : "new",
        quantity: qty,
        filledQuantity: fills ? qty : 0,
        averagePrice: fills ? b.marketFillPrice : undefined,
        stopPrice: order.stopPrice,
        limitPrice: order.limitPrice,
        createdAt: new Date().toISOString(),
        clientOrderId: order.refId
      });
      if (fills) adjustPosition(b, order.symbol, order.side === "sell" ? -qty : qty);
      return { orderId: id, refId: order.refId ?? id, state: fills ? "filled" : "new", raw: {} };
    }
  };
  return b;
}

const USER = "local";

function alpacaPolicy(accountNumber: string, over: Partial<TradingPolicy> = {}): TradingPolicy {
  return {
    ...DEFAULT_POLICY,
    accountNumber,
    activeBroker: "alpaca",
    systemState: "active",
    brokerTrailingStops: false,
    riskRules: { ...DEFAULT_POLICY.riskRules, stopLossPct: 8, trailingStopPct: 0 },
    ...over
  };
}

const pos = (symbol: string, quantity: number, averageCost: number, mark = averageCost): EquityPosition => ({
  symbol,
  quantity,
  averageCost,
  marketValue: quantity * mark
});

function stopOrder(id: string, symbol: string, quantity: number, stopPrice: number, clientOrderId: string): EquityOrder {
  return {
    id,
    symbol,
    side: "sell",
    type: "stop_market",
    state: "new",
    quantity,
    filledQuantity: 0,
    stopPrice,
    timeInForce: "gtc",
    createdAt: new Date(Date.now() - 86_400_000).toISOString(),
    clientOrderId
  };
}

/** Seed the app's OWN tracked protective stop (the reconciler's row + the broker order). */
function seedAppStop(accountNumber: string, symbol: string, quantity: number, stopPrice: number, brokerOrderId = `stop-${symbol}`): EquityOrder {
  upsertBrokerProtectiveStop({
    id: `protstop-${USER}-${accountNumber}-${symbol}`,
    userId: USER,
    accountNumber,
    symbol,
    brokerOrderId,
    quantity,
    stopPrice,
    status: "resting",
    kind: "fixed"
  });
  return stopOrder(brokerOrderId, symbol, quantity, stopPrice, `protstop-${USER}-${accountNumber}-${symbol}-1700000000000`);
}

function sellProposal(symbol: string, quantity: number): TradeProposal {
  return {
    symbol,
    side: "sell",
    type: "market",
    quantity,
    timeInForce: "gfd",
    marketHours: "regular_hours",
    rationale: "Discretionary exit (G2 test).",
    tradeThesisTag: "Discretionary-Exit",
    entryMarketRegime: "Test"
  };
}

function auditKinds(accountSymbol: string): string[] {
  return (getDb().prepare("SELECT kind, payload FROM audit_events WHERE kind LIKE 'exit_stop_release%' OR kind = 'exit_stop_released' ORDER BY rowid ASC").all() as Array<{ kind: string; payload: string }>)
    .filter((row) => (JSON.parse(row.payload) as { symbol?: string }).symbol === accountSymbol)
    .map((row) => row.kind);
}

function releasePlan(accountNumber: string, broker: FakeBroker, proposal: TradeProposal, policy = alpacaPolicy(accountNumber)): ExitStopReleasePlan {
  const decision = planExitStopRelease({ proposal, positions: broker.positions, orders: broker.orders, policy, userId: USER, accountNumber });
  if (decision.kind !== "release") throw new Error(`expected a release plan, got ${decision.kind}`);
  return decision.plan;
}

async function runExit(accountNumber: string, broker: FakeBroker, proposal: TradeProposal, policy = alpacaPolicy(accountNumber)) {
  const plan = releasePlan(accountNumber, broker, proposal, policy);
  return placeExitReleasingOwnStops(
    {
      userId: USER,
      policy,
      accountNumber,
      gateway: broker as never,
      executionMode: "broker/paper",
      proposal,
      plan,
      lane: "approval",
      proposalId: `prop-${proposal.symbol}`,
      cancelSettleMs: 0
    },
    (verifiedPositionQuantity) => broker.placeEquityOrder({ accountNumber, ...proposal, refId: `ref-${proposal.symbol}`, verifiedPositionQuantity })
  );
}

describe("planExitStopRelease", () => {
  it("returns none when nothing holds the exit's shares", () => {
    const broker = fakeBroker({ positions: [pos("AAA", 10, 50)], orders: [] });
    const decision = planExitStopRelease({ proposal: sellProposal("AAA", 10), positions: broker.positions, orders: broker.orders, policy: alpacaPolicy("PL-1"), userId: USER, accountNumber: "PL-1" });
    expect(decision.kind).toBe("none");
  });

  it("plans a release when only the app's own tracked stop holds the shares", () => {
    const stop = seedAppStop("PL-2", "BAC", 24, 46);
    const broker = fakeBroker({ positions: [pos("BAC", 24, 50)], orders: [stop] });
    const decision = planExitStopRelease({ proposal: sellProposal("BAC", 24), positions: broker.positions, orders: broker.orders, policy: alpacaPolicy("PL-2"), userId: USER, accountNumber: "PL-2" });
    expect(decision.kind).toBe("release");
    if (decision.kind !== "release") return;
    expect(decision.plan.stops.map((s) => s.brokerOrderId)).toEqual(["stop-BAC"]);
    expect(decision.plan.availableQuantity).toBe(0);
  });

  it("keeps the old block, with an honest pointer to the toggle, when the owner turned it off", () => {
    const stop = seedAppStop("PL-3", "KO", 14, 60);
    const broker = fakeBroker({ positions: [pos("KO", 14, 65)], orders: [stop] });
    const decision = planExitStopRelease({
      proposal: sellProposal("KO", 14),
      positions: broker.positions,
      orders: broker.orders,
      policy: alpacaPolicy("PL-3", { exitsReleaseAppStops: false }),
      userId: USER,
      accountNumber: "PL-3"
    });
    expect(decision.kind).toBe("blocked");
    if (decision.kind !== "blocked") return;
    expect(decision.reason).toContain("already hold 14 of 14 KO");
    expect(decision.reason).toContain("Exits release the app's own stop");
    expect(decision.appStopOrderIds).toEqual(["stop-KO"]);
  });
});

describe("placeExitReleasingOwnStops", () => {
  it("full exit with a full-quantity app stop: cancels the stop first, sells everything, re-places nothing", async () => {
    const account = "FX-1";
    const stop = seedAppStop(account, "BAC", 24, 46);
    const broker = fakeBroker({ positions: [pos("BAC", 24, 50)], orders: [stop] });
    broker.marketFillPrice = 49;

    const exec = await runExit(account, broker, sellProposal("BAC", 24));

    expect(exec.state).toBe("filled");
    expect(broker.cancelled).toEqual(["stop-BAC"]);
    // Exactly one order reached the broker: the exit.  No replacement stop for a closed position.
    expect(broker.placed.map((o) => [o.side, o.type, o.quantity])).toEqual([["sell", "market", 24]]);
    expect(broker.positions.find((p) => p.symbol === "BAC")).toBeUndefined();
    expect(listBrokerProtectiveStops(account, USER)).toHaveLength(0);
    expect(getExitStopReleaseIntent(USER, account, "BAC")).toBeUndefined();
    expect(auditKinds("BAC")).toEqual(expect.arrayContaining(["exit_stop_release_started", "exit_stop_released", "exit_stop_release_restored"]));
  });

  it("partial exit: the remainder gets a re-placed stop sized to the shares left", async () => {
    const account = "FX-2";
    const stop = seedAppStop(account, "PYPL", 30, 55.2);
    const broker = fakeBroker({ positions: [pos("PYPL", 30, 60)], orders: [stop] });
    broker.marketFillPrice = 61;

    await runExit(account, broker, sellProposal("PYPL", 10));

    expect(broker.cancelled).toEqual(["stop-PYPL"]);
    const [exit, restored] = broker.placed;
    expect([exit.side, exit.type, exit.quantity]).toEqual(["sell", "market", 10]);
    // 60 avg cost x (1 - 8%) = 55.2 — the same fixed trigger the released stop had.
    expect(restored).toMatchObject({ symbol: "PYPL", side: "sell", type: "stop_market", quantity: 20, stopPrice: 55.2, timeInForce: "gtc" });
    const rows = listBrokerProtectiveStops(account, USER);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ symbol: "PYPL", quantity: 20, status: "resting" });
    expect(getExitStopReleaseIntent(USER, account, "PYPL")).toBeUndefined();
  });

  it("partial exit that rests as a working order: the stop comes back for the uncovered shares only", async () => {
    const account = "FX-3";
    const stop = seedAppStop(account, "KO", 14, 59.8);
    const broker = fakeBroker({ positions: [pos("KO", 14, 65)], orders: [stop] });
    // No immediate fill: the exit rests and holds its 4 shares at the broker.
    await runExit(account, broker, sellProposal("KO", 4));

    const restored = broker.placed[1];
    expect(restored).toMatchObject({ symbol: "KO", type: "stop_market", quantity: 10 });
    expect(getExitStopReleaseIntent(USER, account, "KO")).toBeUndefined();
  });

  it("the stop fills during the cancel: the exit is moot, never sent, and the stop fill is booked", async () => {
    const account = "FX-4";
    const stop = seedAppStop(account, "BRKB", 2, 440);
    const broker = fakeBroker({ positions: [pos("BRKB", 2, 480)], orders: [stop] });
    broker.cancelBehavior = "fill";

    const err = await runExit(account, broker, sellProposal("BRKB", 2)).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ExitStopReleaseError);
    expect((err as ExitStopReleaseError).code).toBe("exit_moot_stop_filled");
    expect(broker.placed).toHaveLength(0); // no exit, no accidental short
    expect(listBrokerProtectiveStops(account, USER)).toHaveLength(0);
    const fills = listFillEvents(account, undefined, undefined, USER).filter((f) => f.symbol === "BRKB");
    expect(fills).toHaveLength(1);
    expect(fills[0]).toMatchObject({ side: "sell", quantity: 2, price: 440, brokerOrderId: "stop-BRKB" });
    expect(getExitStopReleaseIntent(USER, account, "BRKB")).toBeUndefined();
    expect(auditKinds("BRKB")).toContain("exit_stop_release_moot");
  });

  it("a cancel that never settles aborts the exit and leaves the stop in charge", async () => {
    const account = "FX-5";
    const stop = seedAppStop(account, "VZ", 98, 36.8);
    const broker = fakeBroker({ positions: [pos("VZ", 98, 40)], orders: [stop] });
    broker.cancelBehavior = "stuck";

    const err = await runExit(account, broker, sellProposal("VZ", 98)).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ExitStopReleaseError);
    expect((err as ExitStopReleaseError).code).toBe("stop_cancel_unconfirmed");
    expect(broker.placed).toHaveLength(0);
    const rows = listBrokerProtectiveStops(account, USER);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ brokerOrderId: "stop-VZ", status: "resting" });
    // The stop row still stands, so the restore pass resolves the intent immediately.
    expect(getExitStopReleaseIntent(USER, account, "VZ")).toBeUndefined();
    expect(auditKinds("VZ")).toEqual(expect.arrayContaining(["exit_stop_release_aborted", "exit_stop_release_restored"]));
  });
});

describe("re-plan inside the lease", () => {
  it("releases the CURRENT app stop when the reconciler replaced it after the plan was made", async () => {
    const account = "RP-1";
    const oldStop = seedAppStop(account, "MFC", 111, 27.6, "stop-MFC-old");
    const broker = fakeBroker({ positions: [pos("MFC", 111, 30)], orders: [oldStop] });
    const proposal = sellProposal("MFC", 111);
    const stalePlan = releasePlan(account, broker, proposal);
    // Between the plan and the placement lease, the reconciler cancel-replaced the stop.
    broker.orders[0].state = "canceled";
    const newStop = seedAppStop(account, "MFC", 111, 27.6, "stop-MFC-new");
    broker.orders.push(newStop);
    broker.marketFillPrice = 30;

    await placeExitReleasingOwnStops(
      { userId: USER, policy: alpacaPolicy(account), accountNumber: account, gateway: broker as never, executionMode: "broker/paper", proposal, plan: stalePlan, lane: "autopilot", cancelSettleMs: 0 },
      (verifiedPositionQuantity) => broker.placeEquityOrder({ accountNumber: account, ...proposal, refId: "ref-MFC", verifiedPositionQuantity })
    );

    expect(broker.cancelled).toEqual(["stop-MFC-new"]);
    expect(broker.placed.map((o) => [o.side, o.type, o.quantity])).toEqual([["sell", "market", 111]]);
  });

  it("an owner order that appeared after the plan keeps the exit blocked and cancels nothing", async () => {
    const account = "RP-2";
    const appStop = seedAppStop(account, "BSX", 60, 80);
    const broker = fakeBroker({ positions: [pos("BSX", 60, 87)], orders: [appStop] });
    const proposal = sellProposal("BSX", 60);
    const plan = releasePlan(account, broker, proposal);
    // The app stop is gone and the owner placed their own GTC stop for the whole position.
    broker.orders[0].state = "canceled";
    broker.orders.push(stopOrder("owner-BSX", "BSX", 60, 79, "owner-typed-in-alpaca-ui"));

    const err = await placeExitReleasingOwnStops(
      { userId: USER, policy: alpacaPolicy(account), accountNumber: account, gateway: broker as never, executionMode: "broker/paper", proposal, plan, lane: "approval", cancelSettleMs: 0 },
      (verifiedPositionQuantity) => broker.placeEquityOrder({ accountNumber: account, ...proposal, refId: "ref-BSX", verifiedPositionQuantity })
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ExitStopReleaseError);
    expect(broker.cancelled).toEqual([]);
    expect(broker.placed).toHaveLength(0);
  });
});

describe("owner and external orders are never cancelled", () => {
  it("an owner-placed stop holding the shares keeps the exit blocked and is never touched", async () => {
    const account = "EXT-1";
    const ownerStop = stopOrder("owner-1", "MPC", 4, 150, "3b0c7c5e-7d7f-4a8e-9a57-6d8f6e0c1a11"); // Alpaca-minted UUID
    const broker = fakeBroker({ positions: [pos("MPC", 4, 170)], orders: [ownerStop] });
    const decision = planExitStopRelease({ proposal: sellProposal("MPC", 4), positions: broker.positions, orders: broker.orders, policy: alpacaPolicy(account), userId: USER, accountNumber: account });
    expect(decision.kind).toBe("blocked");
    if (decision.kind !== "blocked") return;
    expect(decision.appStopOrderIds).toEqual([]);
    expect(broker.cancelled).toEqual([]);
  });

  it("an app stop row for the symbol does not make a DIFFERENT (owner) order releasable", () => {
    const account = "EXT-2";
    seedAppStop(account, "SLB", 69, 40, "stop-SLB-old"); // tracked row points at another order id
    const ownerStop = stopOrder("owner-2", "SLB", 69, 41, "manual-ui-order");
    const broker = fakeBroker({ positions: [pos("SLB", 69, 44)], orders: [ownerStop] });
    const decision = planExitStopRelease({ proposal: sellProposal("SLB", 69), positions: broker.positions, orders: broker.orders, policy: alpacaPolicy(account), userId: USER, accountNumber: account });
    expect(decision.kind).toBe("blocked");
  });

  it("app stop plus an owner order sharing the position: blocked, the app stop is left in place", () => {
    const account = "EXT-3";
    const appStop = seedAppStop(account, "CVE", 100, 15);
    const ownerLimit: EquityOrder = { ...stopOrder("owner-3", "CVE", 49, 0, "owner-take-profit"), type: "limit", stopPrice: undefined, limitPrice: 19 };
    const broker = fakeBroker({ positions: [pos("CVE", 149, 17)], orders: [appStop, ownerLimit] });
    const decision = planExitStopRelease({ proposal: sellProposal("CVE", 149), positions: broker.positions, orders: broker.orders, policy: alpacaPolicy(account), userId: USER, accountNumber: account });
    expect(decision.kind).toBe("blocked");
    if (decision.kind !== "blocked") return;
    expect(decision.reason).toContain("holds only part of those shares");
    expect(broker.cancelled).toEqual([]);
  });
});

describe("restart mid-sequence", () => {
  function writeIntent(intent: Omit<ExitStopReleaseIntent, "createdAt" | "updatedAt">, ageMs: number): void {
    const at = new Date(Date.now() - ageMs).toISOString();
    setInternalSetting(exitStopReleaseKey(intent.userId, intent.accountNumber, intent.symbol), { ...intent, createdAt: at, updatedAt: at });
  }

  it("a process that died after cancelling the stop (phase released): the next protective pass re-places it, even while halted", async () => {
    const account = "RS-1";
    // State a crash leaves behind: the stop is cancelled at the broker, its row already deleted,
    // the exit never sent.
    const broker = fakeBroker({ positions: [pos("C", 47, 70)], orders: [{ ...stopOrder("stop-C", "C", 47, 64.4, "protstop-x"), state: "canceled" }] });
    writeIntent(
      {
        userId: USER,
        accountNumber: account,
        symbol: "C",
        exitSide: "sell",
        lane: "autopilot",
        phase: "released",
        stops: [{ rowId: `protstop-${USER}-${account}-C`, brokerOrderId: "stop-C", quantity: 47, stopPrice: 64.4, kind: "fixed" }],
        restoreAttempts: 0
      },
      EXIT_STOP_RELEASE_STALE_MS + 1_000
    );
    const policy = alpacaPolicy(account, { systemState: "halted" });
    // Halted: a naked position normally gets NO new stop.  A released one is restored.
    await reconcileBrokerProtectiveStops({
      userId: USER,
      policy,
      accountNumber: account,
      gateway: broker as never,
      positions: await broker.getEquityPositions(account),
      executionMode: "broker/paper",
      running: true,
      haltedProtectOnly: true,
      orders: await broker.getEquityOrders(account),
      ordersListed: true
    });
    expect(broker.placed).toHaveLength(1);
    expect(broker.placed[0]).toMatchObject({ symbol: "C", type: "stop_market", quantity: 47, stopPrice: 64.4 });
    expect(listBrokerProtectiveStops(account, USER)).toHaveLength(1);
    expect(getExitStopReleaseIntent(USER, account, "C")).toBeUndefined();
    const restored = (getDb().prepare("SELECT payload FROM audit_events WHERE kind = 'exit_stop_release_restored'").all() as Array<{ payload: string }>)
      .map((r) => JSON.parse(r.payload) as { symbol: string; abandonedSequence: boolean; outcome: string })
      .find((p) => p.symbol === "C");
    expect(restored).toMatchObject({ abandonedSequence: true, outcome: "stop_in_place" });
  });

  it("a process that died mid-cancel (phase releasing): the cancelled stop's stale row is recovered and re-placed", async () => {
    const account = "RS-2";
    seedAppStop(account, "SHEL", 156, 60);
    const broker = fakeBroker({ positions: [pos("SHEL", 156, 65.2)], orders: [{ ...stopOrder("stop-SHEL", "SHEL", 156, 60, "protstop-y"), state: "canceled" }] });
    writeIntent(
      {
        userId: USER,
        accountNumber: account,
        symbol: "SHEL",
        exitSide: "sell",
        lane: "approval",
        phase: "releasing",
        stops: [{ rowId: `protstop-${USER}-${account}-SHEL`, brokerOrderId: "stop-SHEL", quantity: 156, stopPrice: 60, kind: "fixed" }],
        restoreAttempts: 0
      },
      EXIT_STOP_RELEASE_STALE_MS + 1_000
    );
    await reconcileBrokerProtectiveStops({
      userId: USER,
      policy: alpacaPolicy(account),
      accountNumber: account,
      gateway: broker as never,
      positions: await broker.getEquityPositions(account),
      executionMode: "broker/paper",
      running: true,
      orders: await broker.getEquityOrders(account),
      ordersListed: true
    });
    expect(broker.placed).toHaveLength(1);
    expect(broker.placed[0]).toMatchObject({ symbol: "SHEL", type: "stop_market", quantity: 156 });
    const rows = listBrokerProtectiveStops(account, USER);
    expect(rows).toHaveLength(1);
    expect(rows[0].brokerOrderId).not.toBe("stop-SHEL");
    expect(getExitStopReleaseIntent(USER, account, "SHEL")).toBeUndefined();
  });

  it("an owed restore that cannot be placed yet stays pending and audited, then resolves on the next pass", async () => {
    const account = "RS-3";
    const broker = fakeBroker({ positions: [pos("CI", 27, 300)], orders: [] });
    writeIntent(
      {
        userId: USER,
        accountNumber: account,
        symbol: "CI",
        exitSide: "sell",
        lane: "autopilot",
        phase: "exit_submitted",
        stops: [{ rowId: `protstop-${USER}-${account}-CI`, brokerOrderId: "stop-CI", quantity: 27, stopPrice: 276, kind: "fixed" }],
        restoreAttempts: 0
      },
      0
    );
    // Order list fetch failed this pass: coverage unknown, the reconciler must not guess.
    await reconcileBrokerProtectiveStops({
      userId: USER,
      policy: alpacaPolicy(account),
      accountNumber: account,
      gateway: broker as never,
      positions: await broker.getEquityPositions(account),
      executionMode: "broker/paper",
      running: true,
      orders: [],
      ordersListed: false
    });
    expect(broker.placed).toHaveLength(0);
    const intent = getExitStopReleaseIntent(USER, account, "CI");
    expect(intent).toMatchObject({ phase: "restore_pending", restoreAttempts: 1 });
    expect(auditKinds("CI")).toContain("exit_stop_release_restore_pending");
    // Next pass with a working order list restores it.
    await reconcileBrokerProtectiveStops({
      userId: USER,
      policy: alpacaPolicy(account),
      accountNumber: account,
      gateway: broker as never,
      positions: await broker.getEquityPositions(account),
      executionMode: "broker/paper",
      running: true,
      orders: await broker.getEquityOrders(account),
      ordersListed: true
    });
    expect(broker.placed[0]).toMatchObject({ symbol: "CI", type: "stop_market", quantity: 27, stopPrice: 276 });
    expect(getExitStopReleaseIntent(USER, account, "CI")).toBeUndefined();
  });
});
