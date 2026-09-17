import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { evaluateStop, runSyntheticStopMonitor } from "../src/lib/synthetic-stops";
import { DEFAULT_POLICY } from "../src/lib/defaults";
import {
  claimSyntheticStop,
  getDb,
  listBrokerProtectiveStops,
  listFillEvents,
  listSyntheticStops,
  recordStopPlan,
  revertSyntheticStopClaim,
  upsertBrokerProtectiveStop,
  upsertConnectedAccount,
  upsertSyntheticStop
} from "../src/lib/db";
import type { BrokerGateway, ConnectedAccount, EquityOrder, TradingPolicy } from "../src/lib/types";
import { reconcilePendingFills } from "../src/lib/strategy-execution";

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
  positions: [] as Array<{ symbol: string; quantity: number; averageCost: number; marketValue: number }>,
  quotes: {} as Record<string, { price?: number; bid?: number; ask?: number }>,
  placed: [] as Array<{ side: string; quantity: number; symbol: string; refId: string; type?: string; marketHours?: string; limitPrice?: number; trailPercent?: number }>,
  cancelled: [] as string[],
  orders: [] as Array<{ id: string; symbol: string; side: string; type: string; state: string; quantity?: number; filledQuantity?: number; clientOrderId?: string; stopPrice?: number }>,
  // Broker state returned by placeEquityOrder. "accepted" = the order RESTS (e.g. a market order
  // placed after hours); "filled" = synchronous fill (the Test broker's behavior).
  placeState: "accepted",
  // When set, getEquityOrders throws (broker order list unreadable this tick).
  ordersError: null as Error | null,
  // When set, placeEquityOrder records the placement (the broker ACCEPTED it) and then throws —
  // the "placement threw but the broker may have taken the order" money-path trap.
  placeError: null as Error | null,
  // When set, cancelEquityOrder throws (the cancel call failed at the broker).
  cancelError: null as Error | null,
  gatewayPolicies: [] as Array<{ connectedAccountId?: string; activeBroker?: string; accountNumber?: string }>
}));

vi.mock("../src/lib/broker", () => ({
  getBrokerGateway: (policy: { connectedAccountId?: string; activeBroker?: string; accountNumber?: string }) => {
    broker.gatewayPolicies.push(policy);
    return {
      getPortfolio: async () => ({
        accountNumber: "TEST",
        totalMarketValue: 10000,
        buyingPower: 5000,
        equityMarketValue: 10000,
        optionMarketValue: 0,
        cash: 5000
      }),
      getEquityPositions: async () => broker.positions,
      getEquityOrders: async () => {
        if (broker.ordersError) throw broker.ordersError;
        return broker.orders;
      },
      getEquityQuotes: async () => broker.quotes,
      getEquityTradability: async (_accountNumber: string, symbols: string[]) => Object.fromEntries(
        symbols.map((symbol) => [symbol, { tradable: true, fractional: true }])
      ),
      placeEquityOrder: async (order: { side: string; quantity: number; symbol: string; refId: string; type?: string; marketHours?: string; limitPrice?: number; trailPercent?: number }) => {
        broker.placed.push(order);
        if (broker.placeError) throw broker.placeError;
        return { orderId: `ord-${broker.placed.length}`, refId: order.refId, state: broker.placeState, raw: {} };
      },
      cancelEquityOrder: async (_accountNumber: string, orderId: string) => {
        if (broker.cancelError) throw broker.cancelError;
        broker.cancelled.push(orderId);
        return { orderId, refId: "x", state: "cancel_requested", raw: {} };
      }
    };
  }
}));

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-synthstops-${randomUUID()}.db`)}`;
});

const longBase = { side: "long" as const, extremePrice: 100, trailPercent: 5, trailAmount: undefined, lastPrice: 100 };

describe("evaluateStop (synthetic trailing stop)", () => {
  it("raises the extreme as a long climbs and does not trigger above the trail", () => {
    const r = evaluateStop({ ...longBase, extremePrice: 100, lastPrice: 105 }, 110);
    expect(r.newExtreme).toBe(110);
    expect(r.triggerPrice).toBeCloseTo(104.5); // 110 * (1 - 5%)
    expect(r.triggered).toBe(false);
  });

  it("triggers a long when price falls trailPercent below the extreme", () => {
    const r = evaluateStop({ ...longBase, extremePrice: 110, lastPrice: 109 }, 104); // 104 <= 104.5
    expect(r.triggered).toBe(true);
    expect(r.newExtreme).toBe(110); // a pullback never raises the extreme
  });

  it("ignores a bad tick (>10% off last price): no extreme move, no trigger", () => {
    const r = evaluateStop({ ...longBase, extremePrice: 110, lastPrice: 110 }, 60); // -45% spurious print
    expect(r.badTick).toBe(true);
    expect(r.newExtreme).toBe(110);
    expect(r.triggered).toBe(false);
  });

  it("triggers a short when price rises trailPercent above the low extreme", () => {
    const r = evaluateStop({ side: "short", extremePrice: 100, trailPercent: 5, trailAmount: undefined, lastPrice: 101 }, 106);
    expect(r.triggerPrice).toBeCloseTo(105); // 100 * (1 + 5%)
    expect(r.triggered).toBe(true);
  });

  it("lowers the extreme as a short falls and supports an absolute trail amount", () => {
    const r = evaluateStop({ side: "short", extremePrice: 100, trailPercent: undefined, trailAmount: 3, lastPrice: 99 }, 95);
    expect(r.newExtreme).toBe(95); // a short's extreme tracks DOWN
    expect(r.triggerPrice).toBeCloseTo(98); // 95 + 3
    expect(r.triggered).toBe(false); // 95 < 98, not yet
  });
});

describe("runSyntheticStopMonitor (orchestration)", () => {
  function policyFor(account: string): TradingPolicy {
    return {
      ...DEFAULT_POLICY,
      accountNumber: account,
      connectedAccountId: `acct-${account}`,
      activeBroker: "test",
      systemState: "active",
      shortSellingEnabled: true,
      additionalSymbols: ["AAPL", "TSLA", "NVDA"],
      riskRules: { ...DEFAULT_POLICY.riskRules, trailingStopPct: 5 }
    };
  }

  // An account is an account: runSyntheticStopMonitor derives its execution mode from the real
  // connected account identified by policy.connectedAccountId — there is no local-simulation
  // fallback. getBrokerGateway itself is mocked above, but the ownership-scoped account lookup is
  // real DB state, so every test needs a matching connected TEST-BROKER account wired up first.
  function connectTestAccount(
    accountNumber: string,
    environment: "paper" | "live" = "paper",
    brokerName: ConnectedAccount["broker"] = "test"
  ): void {
    upsertConnectedAccount({
      id: `acct-${accountNumber}`,
      userId: "local",
      broker: brokerName,
      environment,
      accountNumber,
      label: accountNumber,
      isActive: true
    });
  }

  beforeEach(() => {
    broker.positions = [];
    broker.quotes = {};
    broker.placed = [];
    broker.cancelled = [];
    broker.orders = [];
    broker.placeState = "accepted";
    broker.ordersError = null;
    broker.placeError = null;
    broker.gatewayPolicies = [];
  });

  afterEach(() => {
    // runSyntheticStopMonitor now awaits setImmediate (yieldEventLoop).  A timed-out
    // test that left full fake timers installed would hang every later case in this
    // file (vitest maxWorkers=1).  Date-only faking is restored here too.
    vi.useRealTimers();
  });

  /** Audit receipts of one kind for one symbol (payloads are JSON with a `symbol` field). */
  function auditPayloads(kind: string, symbol: string): Array<Record<string, unknown>> {
    const rows = getDb()
      .prepare("SELECT payload FROM audit_events WHERE kind = ? ORDER BY created_at ASC")
      .all(kind) as Array<{ payload: string }>;
    return rows
      .map((r) => JSON.parse(r.payload) as Record<string, unknown>)
      .filter((p) => p.symbol === symbol);
  }

  it("uses the policy-targeted Account A context when Account B is UI-active", async () => {
    broker.positions = [{ symbol: "AAPL", quantity: 10, averageCost: 100, marketValue: 1000 }];
    broker.quotes = { AAPL: { price: 90 } };
    upsertConnectedAccount({
      id: "acct-SYN-TARGET-A",
      userId: "local",
      broker: "test",
      environment: "paper",
      accountNumber: "SYN-TARGET-A",
      label: "Target Account A",
      isActive: false
    });
    upsertConnectedAccount({
      id: "acct-SYN-ACTIVE-B",
      userId: "local",
      broker: "alpaca",
      environment: "live",
      accountNumber: "SYN-ACTIVE-B",
      label: "UI-active Account B",
      isActive: true
    });

    const result = await runSyntheticStopMonitor("local", policyFor("SYN-TARGET-A"), true);

    expect(result.exited).toBe(1);
    expect(broker.gatewayPolicies.at(-1)).toMatchObject({
      activeBroker: "test",
      connectedAccountId: "acct-SYN-TARGET-A"
    });
    const fills = listFillEvents("SYN-TARGET-A", "paper", 10, "local");
    expect(fills).toHaveLength(1);
    expect(fills[0]).toMatchObject({ source: "paper", executionMode: "broker/paper" });
    expect(listFillEvents("SYN-TARGET-A", "live", 10, "local")).toHaveLength(0);
  });

  it("rebinds spoofed policy routing fields to the owned target account row", async () => {
    broker.positions = [{ symbol: "AAPL", quantity: 10, averageCost: 100, marketValue: 1000 }];
    broker.quotes = { AAPL: { price: 90 } };
    upsertConnectedAccount({
      id: "acct-SYN-ROW-A",
      userId: "local",
      broker: "test",
      environment: "paper",
      accountNumber: "SYN-ROW-A",
      label: "Authoritative Account A",
      isActive: false
    });
    upsertConnectedAccount({
      id: "acct-SYN-ROW-B",
      userId: "local",
      broker: "alpaca",
      environment: "live",
      accountNumber: "SYN-ROW-B",
      label: "UI-active Account B",
      isActive: true
    });
    const spoofedPolicy = {
      ...policyFor("SYN-SPOOFED-NUMBER"),
      connectedAccountId: "acct-SYN-ROW-A",
      accountNumber: "SYN-SPOOFED-NUMBER",
      activeBroker: "alpaca" as const
    };

    const result = await runSyntheticStopMonitor("local", spoofedPolicy, true);

    expect(result.exited).toBe(1);
    expect(broker.gatewayPolicies.at(-1)).toMatchObject({
      connectedAccountId: "acct-SYN-ROW-A",
      accountNumber: "SYN-ROW-A",
      activeBroker: "test"
    });
    expect(listFillEvents("SYN-ROW-A", "paper", 10, "local")).toHaveLength(1);
    expect(listFillEvents("SYN-SPOOFED-NUMBER", undefined, 10, "local")).toHaveLength(0);
  });

  it("does no broker work when a policy has no explicit connected-account target", async () => {
    broker.positions = [{ symbol: "AAPL", quantity: 10, averageCost: 100, marketValue: 1000 }];
    broker.quotes = { AAPL: { price: 90 } };
    upsertConnectedAccount({
      id: "acct-SYN-UNRELATED-ACTIVE",
      userId: "local",
      broker: "test",
      environment: "paper",
      accountNumber: "SYN-UNRELATED-ACTIVE",
      label: "Unrelated active account",
      isActive: true
    });
    const unboundPolicy = { ...policyFor("SYN-NO-TARGET"), connectedAccountId: undefined };

    const result = await runSyntheticStopMonitor("local", unboundPolicy, true);

    expect(result).toEqual({ evaluated: 0, triggered: 0, exited: 0, purged: 0 });
    expect(broker.gatewayPolicies).toHaveLength(0);
    expect(broker.placed).toHaveLength(0);
  });

  it("does no broker work when the explicit target belongs to another user", async () => {
    upsertConnectedAccount({
      id: "acct-SYN-FOREIGN",
      userId: "other-user",
      broker: "test",
      environment: "live",
      accountNumber: "SYN-FOREIGN",
      label: "Other user's account",
      isActive: true
    });
    connectTestAccount("SYN-OWN-ACTIVE");
    const foreignTargetPolicy = {
      ...policyFor("SYN-FOREIGN"),
      connectedAccountId: "acct-SYN-FOREIGN"
    };

    const result = await runSyntheticStopMonitor("local", foreignTargetPolicy, true);

    expect(result).toEqual({ evaluated: 0, triggered: 0, exited: 0, purged: 0 });
    expect(broker.gatewayPolicies).toHaveLength(0);
    expect(broker.placed).toHaveLength(0);
  });

  it("auto-registers and fires a SELL to exit a long when the trail breaches (running)", async () => {
    broker.positions = [{ symbol: "AAPL", quantity: 10, averageCost: 100, marketValue: 1000 }];
    broker.quotes = { AAPL: { price: 90 } }; // extreme 100, trail 5% → trigger ≤95; 90 breaches
    connectTestAccount("SYN-LONG");
    const result = await runSyntheticStopMonitor("local", policyFor("SYN-LONG"), true);
    expect(result.exited).toBe(1);
    expect(broker.placed).toHaveLength(1);
    expect(broker.placed[0].side).toBe("sell");
    expect(broker.placed[0].quantity).toBe(10);
  });

  it("fires a COVER to exit a short when the trail breaches (running)", async () => {
    broker.positions = [{ symbol: "TSLA", quantity: -5, averageCost: 100, marketValue: -500 }];
    broker.quotes = { TSLA: { price: 110 } }; // short extreme 100, trail 5% → trigger ≥105; 110 breaches
    connectTestAccount("SYN-SHORT");
    const result = await runSyntheticStopMonitor("local", policyFor("SYN-SHORT"), true);
    expect(result.exited).toBe(1);
    expect(broker.placed).toHaveLength(1);
    expect(broker.placed[0].side).toBe("cover");
    expect(broker.placed[0].quantity).toBe(5);
  });

  it("suppresses the exit order when not running (would-trigger only)", async () => {
    broker.positions = [{ symbol: "TSLA", quantity: -5, averageCost: 100, marketValue: -500 }];
    broker.quotes = { TSLA: { price: 110 } };
    connectTestAccount("SYN-SUPPRESS");
    const result = await runSyntheticStopMonitor("local", policyFor("SYN-SUPPRESS"), false);
    expect(result.triggered).toBe(1);
    expect(result.exited).toBe(0);
    expect(broker.placed).toHaveLength(0);
  });

  it("does NOT auto-register a synthetic stop when a broker-held stop already rests for the symbol", async () => {
    broker.positions = [{ symbol: "AAPL", quantity: 10, averageCost: 100, marketValue: 1000 }];
    broker.quotes = { AAPL: { price: 90 } }; // would breach a 5% trail off extreme 100 IF registered
    broker.orders = [{ id: "oco-stop-1", symbol: "AAPL", side: "sell", type: "stop", state: "new" }];
    connectTestAccount("SYN-BRACKET");
    const result = await runSyntheticStopMonitor("local", policyFor("SYN-BRACKET"), true);
    // The broker bracket owns the exit — no synthetic stop registered, so nothing evaluated/fired.
    expect(result.exited).toBe(0);
    expect(broker.placed).toHaveLength(0);
  });

  it.each(["queued", "confirmed", "unconfirmed"])(
    "treats a RESTING Robinhood broker stop (state=%s) as protection → no duplicate synthetic exit",
    async (rhState) => {
      // Regression for the double-exit hazard: a Robinhood broker-held protective stop rests in
      // queued/confirmed/unconfirmed (not Alpaca's new/accepted). Before the fix those states were
      // unrecognized, so the monitor didn't see the broker stop, auto-registered a synthetic trailing
      // stop, and could market-sell on top of the resting broker stop. It must now skip the symbol.
      broker.positions = [{ symbol: "AAPL", quantity: 10, averageCost: 100, marketValue: 1000 }];
      broker.quotes = { AAPL: { price: 90 } }; // would breach a 5% trail off extreme 100 IF registered
      broker.orders = [{ id: "rh-stop-1", symbol: "AAPL", side: "sell", type: "stop_market", state: rhState }];
      connectTestAccount(`SYN-RH-${rhState}`, "live");
      const result = await runSyntheticStopMonitor("local", policyFor(`SYN-RH-${rhState}`), true);
      // The resting RH broker stop owns the exit — no synthetic stop registered, nothing fired.
      expect(result.exited).toBe(0);
      expect(broker.placed).toHaveLength(0);
    }
  );

  it("still auto-registers when the only broker stop for the symbol is terminal (canceled)", async () => {
    broker.positions = [{ symbol: "AAPL", quantity: 10, averageCost: 100, marketValue: 1000 }];
    broker.quotes = { AAPL: { price: 90 } };
    broker.orders = [{ id: "dead", symbol: "AAPL", side: "sell", type: "stop", state: "canceled" }];
    connectTestAccount("SYN-CANCELED");
    const result = await runSyntheticStopMonitor("local", policyFor("SYN-CANCELED"), true);
    // A canceled broker stop no longer protects → the synthetic must take over and fire.
    expect(result.exited).toBe(1);
    expect(broker.placed).toHaveLength(1);
    expect(broker.placed[0].side).toBe("sell");
  });

  it("a FULL-size live broker stop suppresses registration via quantity-aware coverage", async () => {
    broker.positions = [{ symbol: "AAPL", quantity: 10, averageCost: 100, marketValue: 1000 }];
    broker.quotes = { AAPL: { price: 90 } };
    // Explicit quantity == position: coverage (not any symbol-level shortcut) is what suppresses.
    broker.orders = [{ id: "rh-full", symbol: "AAPL", side: "sell", type: "stop_market", state: "queued", quantity: 10 }];
    connectTestAccount("SYN-FULLSTOP", "live");
    const result = await runSyntheticStopMonitor("local", policyFor("SYN-FULLSTOP"), true);
    expect(result.exited).toBe(0);
    expect(broker.placed).toHaveLength(0);
    expect(listSyntheticStops("SYN-FULLSTOP", "local")).toHaveLength(0);
  });

  it("a PARTIAL-size live broker stop no longer suppresses protection for the uncovered shares", async () => {
    broker.positions = [{ symbol: "MU", quantity: 100, averageCost: 100, marketValue: 10000 }];
    broker.quotes = { MU: { price: 90 } }; // breaches a 5% trail off extreme 100
    // A live broker stop covering only 40 of the 100 shares (e.g. an owner-placed manual RH stop).
    // The old symbol-level "has a live stop" guard was quantity-blind and suppressed registration
    // entirely — 60 shares rode through a crash unprotected. Coverage must register the synthetic
    // and fire it for exactly the uncovered remainder.
    broker.orders = [{ id: "rh-part", symbol: "MU", side: "sell", type: "stop_market", state: "queued", quantity: 40 }];
    connectTestAccount("SYN-PARTSTOP", "live");
    const result = await runSyntheticStopMonitor("local", policyFor("SYN-PARTSTOP"), true);
    expect(result.exited).toBe(1);
    expect(broker.placed).toHaveLength(1);
    expect(broker.placed[0].side).toBe("sell");
    expect(broker.placed[0].quantity).toBe(60);
  });

  it("a live stop-BUY (entry/add-on) is NOT protection for a long — the synthetic registers and fires", async () => {
    broker.positions = [{ symbol: "MU", quantity: 10, averageCost: 100, marketValue: 1000 }];
    broker.quotes = { MU: { price: 90 } };
    // A stop-entry BUY above the market on a symbol we're long. The old symbol-level guard was
    // side-blind — any live /stop/i order marked the symbol broker-protected. A buy can never exit
    // a long, so it must not suppress the trailing stop.
    broker.orders = [{ id: "buystop-1", symbol: "MU", side: "buy", type: "stop_market", state: "queued", quantity: 5 }];
    connectTestAccount("SYN-BUYSTOP", "live");
    const result = await runSyntheticStopMonitor("local", policyFor("SYN-BUYSTOP"), true);
    expect(result.exited).toBe(1);
    expect(broker.placed).toHaveLength(1);
    expect(broker.placed[0].side).toBe("sell");
    expect(broker.placed[0].quantity).toBe(10);
  });

  it("disabled-teardown tick: the just-cancelled broker stop is pruned, so the synthetic registers the SAME tick", async () => {
    broker.positions = [{ symbol: "AAPL", quantity: 10, averageCost: 100, marketValue: 1000 }];
    broker.quotes = { AAPL: { price: 90 } };
    // The RH protective stop the feature placed while it was ON — the order list is fetched BEFORE
    // reconcile runs, so this tick it still shows the stop as live even after the teardown cancels it.
    broker.orders = [{ id: "prot-1", symbol: "AAPL", side: "sell", type: "stop_market", state: "queued", quantity: 10 }];
    upsertBrokerProtectiveStop({
      id: "protstop-local-SYN-TEARDOWN-AAPL", userId: "local", accountNumber: "SYN-TEARDOWN",
      symbol: "AAPL", brokerOrderId: "prot-1", quantity: 10, stopPrice: 92, status: "resting"
    });
    connectTestAccount("SYN-TEARDOWN", "live");
    // policyFor leaves robinhoodBrokerStops at its default (off) → reconcile tears the stop down mid-tick.
    const result = await runSyntheticStopMonitor("local", policyFor("SYN-TEARDOWN"), true);
    expect(broker.cancelled).toEqual(["prot-1"]); // the teardown actually cancelled it
    // The cancelled stop must NOT suppress auto-registration — the position would otherwise carry
    // NEITHER protection until the next tick. The synthetic row exists (armed) this same tick.
    expect(listSyntheticStops("SYN-TEARDOWN", "local")).toHaveLength(1);
    // The FIRE path deliberately still honors the stale order for this one tick (a cancel the
    // broker merely accepted can still fill) — no exit stacks on it.
    expect(result.exited).toBe(0);
    expect(broker.placed).toHaveLength(0);
    // Next tick the broker's list no longer shows the cancelled stop: the armed synthetic takes over.
    broker.orders = [];
    const second = await runSyntheticStopMonitor("local", policyFor("SYN-TEARDOWN"), true);
    expect(second.exited).toBe(1);
    expect(broker.placed).toHaveLength(1);
    expect(broker.placed[0]).toMatchObject({ side: "sell", quantity: 10 });
  });

  it("mismatch cancel/REPLACE tick: the just-placed replacement stop defers registration — no same-tick fire, replacement never cancelled", async () => {
    broker.positions = [{ symbol: "MU", quantity: 100, averageCost: 100, marketValue: 10000 }];
    broker.quotes = { MU: { price: 90 } }; // would breach a 5% trail off extreme 100 IF a synthetic registered
    // A tracked-but-undersized RH broker stop (position grew 40 -> 100 since it was placed). The
    // monitor's order list is fetched BEFORE reconcile runs, so this tick it still shows only the
    // stale 40-share stop — and can never show the full-size replacement reconcile places mid-tick.
    broker.orders = [{ id: "prot-old", symbol: "MU", side: "sell", type: "stop_market", state: "queued", quantity: 40 }];
    upsertBrokerProtectiveStop({
      id: "protstop-local-SYN-REPLACE-MU", userId: "local", accountNumber: "SYN-REPLACE",
      symbol: "MU", brokerOrderId: "prot-old", quantity: 40, stopPrice: 92, status: "resting"
    });
    connectTestAccount("SYN-REPLACE", "live", "robinhood");
    const policy: TradingPolicy = {
      ...policyFor("SYN-REPLACE"),
      activeBroker: "robinhood",
      robinhoodBrokerStops: true,
      riskRules: { ...DEFAULT_POLICY.riskRules, trailingStopPct: 5, stopLossPct: 8 }
    };
    const result = await runSyntheticStopMonitor("local", policy, true);
    // Reconcile cancelled the mismatched stop and placed a full-size replacement mid-tick...
    expect(broker.cancelled).toEqual(["prot-old"]); // ...and the replacement (ord-1) was NOT cancelled
    expect(broker.placed).toHaveLength(1); // ONLY reconcile's replacement — no synthetic market sell
    expect(broker.placed[0]).toMatchObject({ side: "sell", quantity: 100 });
    // Before the fix: registration coverage (pruned of prot-old, blind to the just-placed ord-1)
    // saw 0 covered shares, registered the synthetic, fired a 60-share market sell against the
    // stale 40-share coverage, and cancelBrokerProtectiveStop then cancelled the fresh full-size
    // replacement — shares double-sold AND the remainder left unprotected until the re-arm grace.
    // Now: the just-placed symbol is broker-covered for THIS tick's registration; nothing fires.
    expect(result.exited).toBe(0);
    expect(listSyntheticStops("SYN-REPLACE", "local")).toHaveLength(0); // registration deferred
    expect(listSyntheticStops("SYN-REPLACE", "local", "triggered")).toHaveLength(0);

    // Next tick: the fresh order fetch sees the replacement resting full-size — normal
    // quantity-aware coverage suppresses registration; nothing new placed or cancelled.
    broker.orders = [{ id: "ord-1", symbol: "MU", side: "sell", type: "stop_market", state: "queued", quantity: 100 }];
    const second = await runSyntheticStopMonitor("local", policy, true);
    expect(second.exited).toBe(0);
    expect(broker.placed).toHaveLength(1);
    expect(broker.cancelled).toEqual(["prot-old"]);
    expect(listSyntheticStops("SYN-REPLACE", "local")).toHaveLength(0);
  });

  it("ACTIVE row + broker stop placed the SAME tick: the fire defers — no exit on top of the fresh stop, stop never cancelled", async () => {
    // An already-armed synthetic row (e.g. registered on an earlier tick where section-4 placement
    // threw, or armed before robinhoodBrokerStops was enabled). THIS tick reconcile PLACES the
    // broker stop and the quote breaches the trail. The fire loop's coverage comes from the
    // pre-reconcile order list, which can never contain the just-placed stop — before the fix it
    // fired a full-size market sell on top of it and cancelBrokerProtectiveStop then cancelled the
    // fresh stop after booking the fill (duplicate exit, then no protection).
    upsertSyntheticStop({
      id: "stop-justplaced", userId: "local", accountNumber: "SYN-JUSTPLACED", symbol: "JPLC",
      side: "long", quantity: 100, entryPrice: 100, extremePrice: 100, trailPercent: 5, status: "active"
    });
    broker.positions = [{ symbol: "JPLC", quantity: 100, averageCost: 100, marketValue: 10000 }];
    broker.quotes = { JPLC: { price: 90 } }; // breaches the 5% trail off extreme 100
    broker.orders = []; // pre-reconcile list: nothing resting yet (the stop is placed mid-tick)
    connectTestAccount("SYN-JUSTPLACED", "live", "robinhood");
    const policy: TradingPolicy = {
      ...policyFor("SYN-JUSTPLACED"),
      activeBroker: "robinhood",
      robinhoodBrokerStops: true,
      riskRules: { ...DEFAULT_POLICY.riskRules, trailingStopPct: 5, stopLossPct: 8 }
    };
    const result = await runSyntheticStopMonitor("local", policy, true);
    expect(broker.placed).toHaveLength(1); // ONLY reconcile's stop_market placement
    expect(broker.placed[0]).toMatchObject({ side: "sell", type: "stop_market", quantity: 100 });
    expect(result.triggered).toBe(1); // the trail did breach…
    expect(result.exited).toBe(0); // …but nothing fired on top of the fresh full-size stop
    expect(broker.cancelled).toEqual([]); // the fresh broker stop was NOT cancelled
    expect(listSyntheticStops("SYN-JUSTPLACED", "local")).toHaveLength(1); // stays armed, not claimed
    expect(listSyntheticStops("SYN-JUSTPLACED", "local", "triggered")).toHaveLength(0);
    const receipts = auditPayloads("synthetic_stop_skipped_resting_exit", "JPLC");
    expect(receipts).toHaveLength(1);
    expect(receipts[0].note).toContain("placed this tick");

    // Next tick: the fresh order fetch shows the full-size stop resting — normal quantity-aware
    // coverage suppresses the fire; nothing new placed, still nothing cancelled.
    broker.orders = [{ id: "ord-1", symbol: "JPLC", side: "sell", type: "stop_market", state: "queued", quantity: 100 }];
    const second = await runSyntheticStopMonitor("local", policy, true);
    expect(second.exited).toBe(0);
    expect(broker.placed).toHaveLength(1);
    expect(broker.cancelled).toEqual([]);
    expect(listSyntheticStops("SYN-JUSTPLACED", "local")).toHaveLength(1);
  });

  it("registration folds a SAME-TICK PARTIAL broker-stop placement into coverage — no needless synthetic row when combined coverage is already full (Codex review, PR #1331)", async () => {
    // 100-share long already 40-covered by a manual live sell. Reconcile places a broker-held
    // trailing stop for the true 60-share remainder — a PARTIAL placement (60 < 100). The order list
    // is fetched BEFORE reconcile runs, so it can only ever show the 40-share order, never the fresh
    // 60-share stop. Registration coverage therefore sees only 40/100. Before the fix that undercount
    // armed a needless full-size synthetic row for an already-fully-covered position (40 manual + 60
    // broker = 100) — a stale row that then over-sells on a later tick where the order fetch fails.
    // The fix folds the just-placed partial quantity into registration coverage, exactly as the fire
    // path already does. Mark is held AT entry (no trail breach) so this isolates the REGISTRATION
    // decision from any firing.
    broker.positions = [{ symbol: "MU", quantity: 100, averageCost: 100, marketValue: 10000 }]; // mark == entry (100)
    broker.quotes = { MU: { price: 100 } };
    broker.orders = [{ id: "manual-sell", symbol: "MU", side: "sell", type: "limit", state: "queued", quantity: 40 }];
    connectTestAccount("SYN-REG-PARTIAL", "live", "robinhood");
    const policy: TradingPolicy = {
      ...policyFor("SYN-REG-PARTIAL"),
      activeBroker: "robinhood",
      robinhoodBrokerStops: true,
      riskRules: { ...DEFAULT_POLICY.riskRules, trailingStopPct: 5, stopLossPct: 8 }
    };
    const result = await runSyntheticStopMonitor("local", policy, true);
    // Reconcile placed exactly the 60-share partial broker stop (100 position - 40 already covered).
    expect(broker.placed).toHaveLength(1);
    expect(broker.placed[0]).toMatchObject({ side: "sell", quantity: 60 });
    // The fix: 40 (manual) + 60 (just-placed partial) == 100 fully covers the position, so NO
    // synthetic row is registered. Before the fix, registration saw only 40/100 and armed one.
    expect(listSyntheticStops("SYN-REG-PARTIAL", "local")).toHaveLength(0);
    expect(result.exited).toBe(0);
  });

  it("a PARTIAL synthetic fire (uncovered remainder) does NOT cancel the still-valid broker stop covering the rest of the position", async () => {
    // A fractional long (10.6 sh) whose whole-share portion is already protected by a native Alpaca
    // trailing stop placed on an earlier tick (floored to 10 sh — Alpaca rejects fractional trailing
    // stops); the 0.6-sh remainder has no broker-held coverage. Modeled directly as "tick 2" state
    // (the resting stop + an already-armed synthetic row) so this test isolates the FIRE loop's
    // cancel decision from reconcile's own same-tick placement/coverage bookkeeping.
    broker.positions = [{ symbol: "AAPL", quantity: 10.6, averageCost: 100, marketValue: 10.6 * 90 }];
    broker.quotes = { AAPL: { price: 90 } }; // breaches a 5% trail off the seeded extreme (100)
    broker.orders = [{ id: "trail-1", symbol: "AAPL", side: "sell", type: "stop_market", state: "queued", quantity: 10 }];
    upsertBrokerProtectiveStop({
      id: "protstop-local-SYN-PARTIALFIRE-AAPL", userId: "local", accountNumber: "SYN-PARTIALFIRE",
      symbol: "AAPL", brokerOrderId: "trail-1", quantity: 10, stopPrice: 95, status: "resting",
      kind: "trailing", trailPercent: 5
    });
    upsertSyntheticStop({
      id: "synstop-local-SYN-PARTIALFIRE-AAPL", userId: "local", accountNumber: "SYN-PARTIALFIRE",
      symbol: "AAPL", side: "long", quantity: 10.6, entryPrice: 100, extremePrice: 100, trailPercent: 5, status: "active"
    });
    connectTestAccount("SYN-PARTIALFIRE", "paper", "alpaca");
    const policy: TradingPolicy = {
      ...policyFor("SYN-PARTIALFIRE"),
      activeBroker: "alpaca",
      riskRules: { ...DEFAULT_POLICY.riskRules, trailingStopPct: 5 }
    };
    const result = await runSyntheticStopMonitor("local", policy, true);
    // Reconcile is a no-op this tick — the existing 10-sh trailing stop already matches what it
    // would place (no mismatch, no re-cancel/replace) — so the only placeEquityOrder call is the
    // fire loop's own protective exit, sized to the 0.6-sh uncovered remainder.
    expect(broker.placed).toHaveLength(1);
    expect(broker.placed[0].side).toBe("sell");
    expect(broker.placed[0].quantity).toBeCloseTo(0.6);
    expect(result.exited).toBe(1);
    const fills = listFillEvents("SYN-PARTIALFIRE", "paper", 10, "local");
    expect(fills).toHaveLength(1);
    expect(fills[0].quantity).toBeCloseTo(0.6);
    // ...and — the fix under test — must NOT cancel the broker-held stop still covering the other
    // 10 shares: before the fix, cancelBrokerProtectiveStop ran unconditionally after every fire.
    expect(broker.cancelled).toEqual([]);
    const stops = listBrokerProtectiveStops("SYN-PARTIALFIRE", "local");
    expect(stops).toHaveLength(1);
    expect(stops[0]).toMatchObject({ brokerOrderId: "trail-1", status: "resting", quantity: 10 });
  });

  it("books a LIVE stop exit as pending_reconciliation (provisional at quote price, not a final fill)", async () => {
    broker.positions = [{ symbol: "NVDA", quantity: 10, averageCost: 100, marketValue: 1000 }];
    broker.quotes = { NVDA: { price: 90 } }; // breaches a 5% trail off extreme 100
    connectTestAccount("SYN-LIVE", "live");
    const result = await runSyntheticStopMonitor("local", policyFor("SYN-LIVE"), true);
    expect(result.exited).toBe(1);
    const fills = listFillEvents("SYN-LIVE", "live", 10, "local");
    expect(fills).toHaveLength(1);
    expect(fills[0].status).toBe("pending_reconciliation"); // reconcilePendingFills books the real fill
    expect(fills[0].brokerOrderId).toBe("ord-1");
  });

  // ── Regressions for the 2026-07-08 overnight MU incident (Alpaca paper) ─────────────

  it("books an after-hours PAPER exit as pending (not filled-at-quote) and reconciliation finalizes the true fill", async () => {
    broker.positions = [{ symbol: "MU", quantity: 10, averageCost: 100, marketValue: 1000 }];
    broker.quotes = { MU: { price: 90 } }; // breaches a 5% trail off extreme 100
    broker.placeState = "accepted"; // the market sell RESTS at the broker until the next open
    connectTestAccount("SYN-AFTERHOURS");
    const result = await runSyntheticStopMonitor("local", policyFor("SYN-AFTERHOURS"), true);
    expect(result.exited).toBe(1);
    let fills = listFillEvents("SYN-AFTERHOURS", "paper", 10, "local");
    expect(fills).toHaveLength(1);
    // The incident booked this as status "filled" at the placement-time quote — realized P&L was
    // fabricated hours before the true open fill. It must sit pending until the broker reports it.
    expect(fills[0].status).toBe("pending_reconciliation");
    expect(fills[0].brokerOrderId).toBe("ord-1");

    // Next morning: the resting order fills at the open — the EXISTING reconciliation path books it.
    const openFillGateway = {
      getEquityOrders: async () => [{
        id: "ord-1",
        symbol: "MU",
        side: "sell",
        type: "market",
        state: "filled",
        filledQuantity: 10,
        averagePrice: 93.85,
        createdAt: new Date().toISOString(),
        updatedAt: "2026-07-08T13:30:05.000Z"
      } as EquityOrder]
    } as unknown as BrokerGateway;
    await reconcilePendingFills(openFillGateway, "SYN-AFTERHOURS", "local");
    fills = listFillEvents("SYN-AFTERHOURS", "paper", 10, "local");
    expect(fills[0].status).toBe("filled");
    expect(fills[0].price).toBe(93.85); // the true open fill, not the after-hours quote
    expect(fills[0].notional).toBeCloseTo(938.5);
    expect(fills[0].filledAt).toBe("2026-07-08T13:30:05.000Z");
  });

  it("does NOT re-arm or re-fire a triggered stop while its exit order is still resting", async () => {
    broker.positions = [{ symbol: "MU", quantity: 10, averageCost: 100, marketValue: 1000 }];
    broker.quotes = { MU: { price: 90 } };
    connectTestAccount("SYN-REFIRE");
    const first = await runSyntheticStopMonitor("local", policyFor("SYN-REFIRE"), true);
    expect(first.exited).toBe(1);
    expect(broker.placed).toHaveLength(1);
    // The exit rests at the broker all night, visible as a live open MARKET order.
    broker.orders = [{ id: "ord-1", symbol: "MU", side: "sell", type: "market", state: "new" }];
    // Next tick (and every ~60s all night in the incident): must not fire again.
    const second = await runSyntheticStopMonitor("local", policyFor("SYN-REFIRE"), true);
    expect(second.exited).toBe(0);
    expect(broker.placed).toHaveLength(1); // no duplicate protective sell
    expect(listSyntheticStops("SYN-REFIRE", "local", "triggered")).toHaveLength(1); // still claimed
    expect(listSyntheticStops("SYN-REFIRE", "local")).toHaveLength(0); // never resurrected to active
  });

  it("treats a resting NON-STOP exit order (limit sell) as protection — nothing registered or fired on top of it", async () => {
    broker.positions = [{ symbol: "MU", quantity: 10, averageCost: 100, marketValue: 1000 }];
    broker.quotes = { MU: { price: 90 } }; // would breach a 5% trail IF a stop were registered
    broker.orders = [{ id: "lim-1", symbol: "MU", side: "sell", type: "limit", state: "new" }];
    connectTestAccount("SYN-LIMIT");
    const result = await runSyntheticStopMonitor("local", policyFor("SYN-LIMIT"), true);
    expect(result.exited).toBe(0);
    expect(broker.placed).toHaveLength(0);
    expect(listSyntheticStops("SYN-LIMIT", "local")).toHaveLength(0); // registration deferred, not stacked
  });

  it("does not fire an ACTIVE stop on top of a resting exit order (fire-path protection check)", async () => {
    connectTestAccount("SYN-SKIPFIRE");
    upsertSyntheticStop({
      id: "stop-skipfire", userId: "local", accountNumber: "SYN-SKIPFIRE", symbol: "MU",
      side: "long", quantity: 10, entryPrice: 100, extremePrice: 100, trailPercent: 5, status: "active"
    });
    broker.positions = [{ symbol: "MU", quantity: 10, averageCost: 100, marketValue: 1000 }];
    broker.quotes = { MU: { price: 90 } };
    broker.orders = [{ id: "lim-2", symbol: "MU", side: "sell", type: "limit", state: "new" }];
    const result = await runSyntheticStopMonitor("local", policyFor("SYN-SKIPFIRE"), true);
    expect(result.triggered).toBe(1); // the trail breached…
    expect(result.exited).toBe(0); // …but no order is stacked on the resting exit
    expect(broker.placed).toHaveLength(0);
    expect(listSyntheticStops("SYN-SKIPFIRE", "local")).toHaveLength(1); // stays active/armed, not claimed
  });

  it("upsertSyntheticStop cannot resurrect a 'triggered' row to 'active' (revertSyntheticStopClaim is the only re-arm path)", () => {
    const stop = {
      id: "stop-resurrect", userId: "local", accountNumber: "SYN-UPS", symbol: "MU",
      side: "long" as const, quantity: 10, entryPrice: 100, extremePrice: 100, trailPercent: 5,
      status: "active" as const
    };
    upsertSyntheticStop(stop);
    expect(claimSyntheticStop("stop-resurrect", "local")).toBe(true);
    upsertSyntheticStop(stop); // the incident's auto-register overwrite (status: "active")
    expect(listSyntheticStops("SYN-UPS", "local", "triggered")).toHaveLength(1); // guard held
    expect(listSyntheticStops("SYN-UPS", "local")).toHaveLength(0);
    revertSyntheticStopClaim("stop-resurrect", "local"); // the deliberate confirmed-terminal path
    expect(listSyntheticStops("SYN-UPS", "local")).toHaveLength(1);
  });

  it("re-arms and re-fires under a FRESH refId once the exit order is confirmed dead with the position still open", async () => {
    broker.positions = [{ symbol: "MU", quantity: 10, averageCost: 100, marketValue: 1000 }];
    broker.quotes = { MU: { price: 90 } };
    connectTestAccount("SYN-REARM");
    const first = await runSyntheticStopMonitor("local", policyFor("SYN-REARM"), true);
    expect(first.exited).toBe(1);
    // The resting exit later dies unfilled — reconciliation confirms it terminal.
    const expiredGateway = {
      getEquityOrders: async () => [{
        id: "ord-1", symbol: "MU", side: "sell", type: "market", state: "expired",
        createdAt: new Date().toISOString()
      } as EquityOrder]
    } as unknown as BrokerGateway;
    await reconcilePendingFills(expiredGateway, "SYN-REARM", "local");
    expect(listFillEvents("SYN-REARM", "paper", 10, "local")[0].status).toBe("expired");
    // Age the triggered row past the re-arm confirmation grace window.
    getDb()
      .prepare("UPDATE synthetic_trailing_stops SET updated_at = ? WHERE account_number = ? AND user_id = ?")
      .run(new Date(Date.now() - 16 * 60_000).toISOString(), "SYN-REARM", "local");
    broker.orders = [{ id: "ord-1", symbol: "MU", side: "sell", type: "market", state: "expired" }];
    const second = await runSyntheticStopMonitor("local", policyFor("SYN-REARM"), true);
    // Protection restored: still breached, so a fresh exit fires — under a NEW client order id,
    // so the broker's client_order_id uniqueness cannot 422 the legitimate replacement. The id
    // rolls forward via the per-row fire generation ("-g1"), persisted on the stop itself.
    expect(second.exited).toBe(1);
    expect(broker.placed).toHaveLength(2);
    expect(broker.placed[1].refId).not.toBe(broker.placed[0].refId);
    expect(broker.placed[1].refId).toBe(`${broker.placed[0].refId}-g1`);
    const rowAfter = listSyntheticStops("SYN-REARM", "local", "triggered")[0];
    expect(rowAfter.fireGeneration).toBe(1);
    expect(rowAfter.lastAttemptRefId).toBe(broker.placed[1].refId);
  });

  it("re-arms the remainder's own dead exit even while an UNRELATED broker-held stop is still live for the same symbol (Codex review, PR #1331, round 7)", async () => {
    // Alpaca native trailing floors to whole shares — 10.6 shares gets a 10-share resting native
    // trail (placed by reconcile) PLUS the synthetic monitor firing its own market sell for the
    // 0.6-share uncovered remainder (round 6's fix). If that remainder order later dies, re-arm
    // must not be blocked just because the (unrelated, still perfectly valid) 10-share trail is
    // still live — a quantity-blind "anything live for this symbol" check would wrongly conflate
    // the two and leave the remainder permanently unprotected.
    broker.positions = [{ symbol: "AAPL", quantity: 10.6, averageCost: 100, marketValue: 1060 }];
    broker.quotes = { AAPL: { price: 90 } };
    connectTestAccount("SYN-REARM-PARTIAL", "paper", "alpaca");
    const alpacaPolicy = { ...policyFor("SYN-REARM-PARTIAL"), activeBroker: "alpaca" as const };
    const first = await runSyntheticStopMonitor("local", alpacaPolicy, true);
    expect(first.exited).toBe(1);
    expect(broker.placed).toHaveLength(2); // [0] native trail (10 sh), [1] market sell (0.6 sh remainder)
    const trailOrderId = "ord-1";
    const remainderRefId = broker.placed[1].refId;

    // The remainder's market sell later EXPIRES (never filled) — reconcile that to a terminal status.
    const expiredGateway = {
      getEquityOrders: async () => [
        { id: trailOrderId, symbol: "AAPL", side: "sell", type: "stop_market", state: "new", quantity: 10, createdAt: new Date().toISOString() },
        { id: "ord-2", symbol: "AAPL", side: "sell", type: "market", state: "expired", clientOrderId: remainderRefId, createdAt: new Date().toISOString() }
      ] as EquityOrder[]
    } as unknown as BrokerGateway;
    await reconcilePendingFills(expiredGateway, "SYN-REARM-PARTIAL", "local");

    // Age the triggered row past the re-arm confirmation grace window.
    getDb()
      .prepare("UPDATE synthetic_trailing_stops SET updated_at = ? WHERE account_number = ? AND user_id = ?")
      .run(new Date(Date.now() - 16 * 60_000).toISOString(), "SYN-REARM-PARTIAL", "local");

    // Next tick: the native trail (10 sh) is STILL resting/live, but the remainder's own order is
    // confirmed dead — re-arm must succeed despite the trail's continued presence.
    broker.orders = [
      { id: trailOrderId, symbol: "AAPL", side: "sell", type: "stop_market", state: "new", quantity: 10 },
      { id: "ord-2", symbol: "AAPL", side: "sell", type: "market", state: "expired", clientOrderId: remainderRefId }
    ];
    const second = await runSyntheticStopMonitor("local", alpacaPolicy, true);
    expect(second.exited).toBe(1); // re-armed AND re-fired for the still-uncovered 0.6-share remainder
    const rowAfter = listSyntheticStops("SYN-REARM-PARTIAL", "local", "triggered")[0];
    expect(rowAfter.fireGeneration).toBe(1);
    expect(rowAfter.lastAttemptRefId).not.toBe(remainderRefId);
  });

  // ── Round 2 (adversarial review): per-row fire_generation / last_attempt_ref_id ─────

  it("reverted-after-throw path: reuses the SAME refId while ambiguous and advances to -g1 only after confirmed-terminal", async () => {
    broker.positions = [{ symbol: "MU", quantity: 10, averageCost: 100, marketValue: 1000 }];
    broker.quotes = { MU: { price: 90 } };
    connectTestAccount("SYN-THROW");

    // Tick 1: the broker ACCEPTS the market sell but the placement call throws (response lost).
    // No fill is booked, the claim reverts — but the attempted client_order_id must be remembered.
    broker.placeError = new Error("socket hang up");
    const first = await runSyntheticStopMonitor("local", policyFor("SYN-THROW"), true);
    expect(first.exited).toBe(0);
    expect(broker.placed).toHaveLength(1);
    const r0 = broker.placed[0].refId;
    expect(r0).not.toContain("-g"); // generation 0 keeps the original unsuffixed id format
    expect(listFillEvents("SYN-THROW", "paper", 10, "local")).toHaveLength(0); // nothing booked
    let row = listSyntheticStops("SYN-THROW", "local")[0]; // reverted to active…
    expect(row.lastAttemptRefId).toBe(r0); // …but the possibly-live order's id is remembered
    expect(row.fireGeneration).toBe(0);

    // Tick 2: the order list is UNREADABLE — the prior order's fate is ambiguous, so the retry
    // must reuse the exact same client_order_id (a 422 collision fails safe; a fresh id could
    // double-sell on top of an order the broker actually took).
    broker.ordersError = new Error("504 gateway timeout");
    await runSyntheticStopMonitor("local", policyFor("SYN-THROW"), true);
    expect(broker.placed).toHaveLength(2);
    expect(broker.placed[1].refId).toBe(r0); // verbatim reuse — generation did NOT advance
    expect(listSyntheticStops("SYN-THROW", "local")[0].fireGeneration).toBe(0);

    // Tick 3: the order list is readable and POSITIVELY shows the prior attempt dead (no live
    // exit order, r0's client_order_id nowhere live, no fill pending). Only now does the
    // generation advance and the replacement place under a fresh "-g1" id.
    broker.ordersError = null;
    broker.placeError = null;
    broker.orders = [];
    const third = await runSyntheticStopMonitor("local", policyFor("SYN-THROW"), true);
    expect(third.exited).toBe(1);
    expect(broker.placed).toHaveLength(3);
    expect(broker.placed[2].refId).toBe(`${r0}-g1`);
    row = listSyntheticStops("SYN-THROW", "local", "triggered")[0];
    expect(row.fireGeneration).toBe(1);
    expect(row.lastAttemptRefId).toBe(`${r0}-g1`);
  });

  // ── Extended-hours routing (allowExtendedHoursSyntheticStops) — PR #1228 review regressions ──

  it("anchors the extended-hours SELL exit limit to the BID, not the ask-biased composite price", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-10T12:00:00Z")); // 08:00 ET = pre-market (EDT)
    try {
      broker.positions = [{ symbol: "AAPL", quantity: 10, averageCost: 100, marketValue: 1000 }];
      // bid 89.5 / ask 90: the composite price is the ASK (Alpaca sets price = ask ?? bid). A limit
      // off the composite (89.87) would sit ABOVE the 89.5 bid — resting, not marketable.
      broker.quotes = { AAPL: { price: 90, bid: 89.5, ask: 90 } };
      connectTestAccount("SYN-EXTHOURS");
      const policy = { ...policyFor("SYN-EXTHOURS"), allowExtendedHoursSyntheticStops: true };
      const result = await runSyntheticStopMonitor("local", policy, true);
      expect(result.exited).toBe(1);
      expect(broker.placed).toHaveLength(1);
      expect(broker.placed[0]).toMatchObject({
        side: "sell",
        type: "limit",
        marketHours: "extended_hours",
        limitPrice: 89.36 // 89.5 * (1 - 0.0015) = 89.36575, bid-anchored, rounded OUTWARD (down) to stay marketable
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a FRACTIONAL extended-hours exit as a regular-hours market order (queues to the open instead of being hard-blocked)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-10T12:00:00Z")); // 08:00 ET = pre-market (EDT)
    try {
      broker.positions = [{ symbol: "AAPL", quantity: 10.5, averageCost: 100, marketValue: 1050 }];
      broker.quotes = { AAPL: { price: 90, bid: 89.5, ask: 90 } };
      connectTestAccount("SYN-EXTFRAC");
      const policy = { ...policyFor("SYN-EXTFRAC"), allowExtendedHoursSyntheticStops: true };
      const result = await runSyntheticStopMonitor("local", policy, true);
      // Before the quantity guard this became a fractional extended_hours limit, which policy
      // hard-blocks ("Fractional or dollar-based orders must be regular-hours only.") — leaving the
      // breached position with NO protective order at all for the rest of the extended session.
      expect(result.exited).toBe(1);
      expect(broker.placed).toHaveLength(1);
      expect(broker.placed[0]).toMatchObject({
        side: "sell",
        quantity: 10.5,
        type: "market",
        marketHours: "regular_hours"
      });
      expect(broker.placed[0].limitPrice).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("partial coverage: a 10-of-100-share resting trim leaves 90 shares protected — the stop fires for the UNCOVERED remainder", async () => {
    broker.positions = [{ symbol: "MU", quantity: 100, averageCost: 100, marketValue: 10000 }];
    broker.quotes = { MU: { price: 90 } }; // breaches a 5% trail off extreme 100
    // A live GTC take-profit trim for 10 of the 100 shares. Before quantity-aware coverage, ANY
    // live sell suppressed registration AND firing — 90 shares rode through a crash unprotected.
    broker.orders = [{ id: "trim-1", symbol: "MU", side: "sell", type: "limit", state: "new", quantity: 10 }];
    connectTestAccount("SYN-PARTIAL");
    const result = await runSyntheticStopMonitor("local", policyFor("SYN-PARTIAL"), true);
    expect(result.exited).toBe(1);
    expect(broker.placed).toHaveLength(1);
    expect(broker.placed[0].side).toBe("sell");
    expect(broker.placed[0].quantity).toBe(90); // only the shares the trim does NOT already cover
  });

  it("partial coverage counts REMAINING quantity: a partially filled trim covers only its open shares", async () => {
    broker.positions = [{ symbol: "MU", quantity: 100, averageCost: 100, marketValue: 10000 }];
    broker.quotes = { MU: { price: 90 } };
    // 20-share trim, 5 already filled → 15 still resting; the stop must fire for the other 85.
    broker.orders = [{ id: "trim-2", symbol: "MU", side: "sell", type: "limit", state: "partially_filled", quantity: 20, filledQuantity: 5 }];
    connectTestAccount("SYN-PARTFILL");
    const result = await runSyntheticStopMonitor("local", policyFor("SYN-PARTFILL"), true);
    expect(result.exited).toBe(1);
    expect(broker.placed[0].quantity).toBe(85);
  });

  it("a PARTIAL native-trail placement folds its known quantity into coverage instead of blanket-skipping the fire path (the fractional remainder still gets sold)", async () => {
    // Alpaca native trailing floors to whole shares — a 10.5-share long gets a 10-share resting
    // trail, leaving a genuine 0.5-share uncovered remainder. Before the fix, ANY partial broker
    // placement this tick blanket-skipped the fire path entirely, leaving that 0.5 share naked for
    // the rest of the tick (and exposed indefinitely if the app stopped before the next one).
    broker.positions = [{ symbol: "AAPL", quantity: 10.5, averageCost: 100, marketValue: 1050 }];
    broker.quotes = { AAPL: { price: 90 } }; // extreme 100, 5% trail → trigger 95; 90 breaches
    connectTestAccount("SYN-PARTIAL-NATIVE", "paper", "alpaca");
    const alpacaPolicy = { ...policyFor("SYN-PARTIAL-NATIVE"), activeBroker: "alpaca" as const };
    const result = await runSyntheticStopMonitor("local", alpacaPolicy, true);
    expect(result.exited).toBe(1);
    // Two placements this tick: the broker-held native trail (floored to 10 whole shares, from
    // reconcile) and the synthetic monitor's own market sell for the uncovered 0.5-share remainder.
    expect(broker.placed).toHaveLength(2);
    const trail = broker.placed.find((o) => o.trailPercent != null);
    const marketSell = broker.placed.find((o) => o.trailPercent == null);
    expect(trail).toMatchObject({ symbol: "AAPL", quantity: 10 });
    expect(marketSell).toMatchObject({ symbol: "AAPL", side: "sell", quantity: 0.5 });
  });

  it("full-size resting exit (whatever its price) blocks the fire with an audit receipt — those shares are broker-held", async () => {
    connectTestAccount("SYN-FULLCOVER");
    upsertSyntheticStop({
      id: "stop-fullcover", userId: "local", accountNumber: "SYN-FULLCOVER", symbol: "FULLC",
      side: "long", quantity: 100, entryPrice: 100, extremePrice: 100, trailPercent: 5, status: "active"
    });
    broker.positions = [{ symbol: "FULLC", quantity: 100, averageCost: 100, marketValue: 10000 }];
    broker.quotes = { FULLC: { price: 90 } };
    // A full-size limit sell far above the market still holds all 100 shares at the broker — a
    // second sell would be rejected anyway; the stale-limit-order notifier is what flags it.
    broker.orders = [{ id: "lim-full", symbol: "FULLC", side: "sell", type: "limit", state: "new", quantity: 100 }];
    const result = await runSyntheticStopMonitor("local", policyFor("SYN-FULLCOVER"), true);
    expect(result.triggered).toBe(1);
    expect(result.exited).toBe(0);
    expect(broker.placed).toHaveLength(0);
    expect(listSyntheticStops("SYN-FULLCOVER", "local")).toHaveLength(1); // stays armed, not claimed
    const receipts = auditPayloads("synthetic_stop_skipped_resting_exit", "FULLC");
    expect(receipts).toHaveLength(1);
    expect(receipts[0].coveredQty).toBe(100);
    expect(receipts[0].unknownOrderQuantity).toBe(false);
  });

  it("unknowable exit-order quantity is treated as FULL coverage (no fire) with the reason on the audit receipt", async () => {
    connectTestAccount("SYN-UNKNOWNQTY");
    upsertSyntheticStop({
      id: "stop-unknownqty", userId: "local", accountNumber: "SYN-UNKNOWNQTY", symbol: "UNKQ",
      side: "long", quantity: 100, entryPrice: 100, extremePrice: 100, trailPercent: 5, status: "active"
    });
    broker.positions = [{ symbol: "UNKQ", quantity: 100, averageCost: 100, marketValue: 10000 }];
    broker.quotes = { UNKQ: { price: 90 } };
    // e.g. a notional/dollarAmount sell reports no share quantity — coverage is unknowable, so it
    // must fail toward no-duplicate-sell (skip firing), never toward a possible oversell.
    broker.orders = [{ id: "notional-1", symbol: "UNKQ", side: "sell", type: "limit", state: "new" }];
    const result = await runSyntheticStopMonitor("local", policyFor("SYN-UNKNOWNQTY"), true);
    expect(result.exited).toBe(0);
    expect(broker.placed).toHaveLength(0);
    const receipts = auditPayloads("synthetic_stop_skipped_resting_exit", "UNKQ");
    expect(receipts).toHaveLength(1);
    expect(receipts[0].unknownOrderQuantity).toBe(true);
  });

  describe("per-position stop plans (universal availability + never-hidden 'none')", () => {
    it("a 'trailing' plan registers a trail using STOP_PLAN_FALLBACK_STOP_PCT even when the account has NO trailing % configured at all", async () => {
      broker.positions = [{ symbol: "AAPL", quantity: 10, averageCost: 100, marketValue: 1000 }];
      broker.quotes = { AAPL: { price: 90 } }; // extreme 100 (mark == avgCost at registration), 8% fallback trail → trigger 92; 90 breaches
      connectTestAccount("SYN-PLAN-TRAIL");
      recordStopPlan("SYN-PLAN-TRAIL", "AAPL", "trailing", undefined, 100, "local");
      const noTrailPolicy = { ...policyFor("SYN-PLAN-TRAIL"), riskRules: { ...policyFor("SYN-PLAN-TRAIL").riskRules, trailingStopPct: 0 } };
      const result = await runSyntheticStopMonitor("local", noTrailPolicy, true);
      expect(result.exited).toBe(1);
      expect(broker.placed).toHaveLength(1);
      expect(broker.placed[0].side).toBe("sell");
      expect(broker.placed[0].quantity).toBe(10);
    });

    it("a 'trailing' plan does NOT register when the account-wide trail is 0 and the plan is absent (unaffected symbols keep prior behavior)", async () => {
      broker.positions = [{ symbol: "AAPL", quantity: 10, averageCost: 100, marketValue: 1000 }];
      broker.quotes = { AAPL: { price: 90 } };
      connectTestAccount("SYN-PLAN-NONE-DEFAULT");
      const noTrailPolicy = {
        ...policyFor("SYN-PLAN-NONE-DEFAULT"),
        riskRules: { ...policyFor("SYN-PLAN-NONE-DEFAULT").riskRules, trailingStopPct: 0 }
      };
      const result = await runSyntheticStopMonitor("local", noTrailPolicy, true);
      expect(result.exited).toBe(0);
      expect(broker.placed).toHaveLength(0);
      expect(listSyntheticStops("SYN-PLAN-NONE-DEFAULT", "local")).toHaveLength(0);
    });

    it("a 'none' plan never registers a synthetic trail, even with a healthy account-wide trailing % configured", async () => {
      broker.positions = [{ symbol: "AAPL", quantity: 10, averageCost: 100, marketValue: 1000 }];
      broker.quotes = { AAPL: { price: 90 } }; // would breach a 5% account-wide trail if registered
      connectTestAccount("SYN-PLAN-NONE");
      recordStopPlan("SYN-PLAN-NONE", "AAPL", "none", "high-conviction, no stop desired", 100, "local");
      const result = await runSyntheticStopMonitor("local", policyFor("SYN-PLAN-NONE"), true);
      expect(result.exited).toBe(0);
      expect(broker.placed).toHaveLength(0);
      expect(listSyntheticStops("SYN-PLAN-NONE", "local")).toHaveLength(0);
    });

    it("a 'none' plan set AFTER a trail was already registered purges the existing row (never silently keeps protecting against the owner's choice)", async () => {
      broker.positions = [{ symbol: "AAPL", quantity: 10, averageCost: 100, marketValue: 1000 }];
      broker.quotes = { AAPL: { price: 100 } }; // flat — no breach, just exercising registration/purge
      connectTestAccount("SYN-PLAN-NONE-LATER");
      await runSyntheticStopMonitor("local", policyFor("SYN-PLAN-NONE-LATER"), true);
      expect(listSyntheticStops("SYN-PLAN-NONE-LATER", "local")).toHaveLength(1);
      recordStopPlan("SYN-PLAN-NONE-LATER", "AAPL", "none", "reconsidered — no stop wanted", 100, "local");
      await runSyntheticStopMonitor("local", policyFor("SYN-PLAN-NONE-LATER"), true);
      expect(listSyntheticStops("SYN-PLAN-NONE-LATER", "local")).toHaveLength(0);
      const receipts = auditPayloads("synthetic_stop_purged_by_plan", "AAPL");
      expect(receipts).toHaveLength(1);
    });

    it("a 'fixed' plan does not touch the RATCHETING trailing lane (registration behaves as 'default' there), but gets its own static-trigger row (item 7)", async () => {
      broker.positions = [{ symbol: "AAPL", quantity: 10, averageCost: 100, marketValue: 1000 }];
      broker.quotes = { AAPL: { price: 90 } }; // fixed trigger @ base stopLossPct=8% below entry (100) → 92; 90 breaches
      connectTestAccount("SYN-PLAN-FIXED");
      recordStopPlan("SYN-PLAN-FIXED", "AAPL", "fixed", undefined, 100, "local");
      const noTrailPolicy = { ...policyFor("SYN-PLAN-FIXED"), riskRules: { ...policyFor("SYN-PLAN-FIXED").riskRules, trailingStopPct: 0 } };
      const result = await runSyntheticStopMonitor("local", noTrailPolicy, true);
      // No account-wide trail and "fixed" doesn't grant a RATCHETING row — but item 7 gives it a
      // static-trigger row instead of leaving the position with zero tick-level protection, and the
      // quote already breaches that fixed level this same tick.
      expect(result.exited).toBe(1);
      expect(broker.placed).toHaveLength(1);
      expect(broker.placed[0].side).toBe("sell");
      expect(broker.placed[0].quantity).toBe(10);
    });

    it("DROPS a stale 'none' plan whose recorded avgCost no longer matches the live lot (close+rebuy between strategy runs), so the new lot gets the account-wide trailing protection instead of being silently left unprotected (Codex review, PR #1371 — same live-basis filter as the strategy run)", async () => {
      // The live lot is a DIFFERENT position from the one the 'none' plan was recorded against: the
      // symbol was closed and re-bought at 130 before any strategy run observed it flat, so the plan's
      // recorded basis (100) is stale. Pre-fix (raw getStopPlans, no basis check) the stale 'none'
      // suppressed BOTH the synthetic and broker-held stop for the new lot; post-fix the live-basis
      // filter drops it and the account-wide 5% trail registers and fires.
      broker.positions = [{ symbol: "AAPL", quantity: 10, averageCost: 130, marketValue: 1300 }];
      broker.quotes = { AAPL: { price: 90 } }; // extreme max(90,130)=130, 5% trail → trigger 123.5; 90 breaches
      connectTestAccount("SYN-PLAN-STALE-NONE");
      recordStopPlan("SYN-PLAN-STALE-NONE", "AAPL", "none", "old lot — no stop wanted", 100, "local");
      const result = await runSyntheticStopMonitor("local", policyFor("SYN-PLAN-STALE-NONE"), true);
      expect(result.exited).toBe(1);
      expect(broker.placed).toHaveLength(1);
      expect(broker.placed[0].side).toBe("sell");
      expect(broker.placed[0].quantity).toBe(10);
    });
  });

  describe("item 7: fixed/ATR tick-cadence backstop (static-trigger rows)", () => {
    it("an 'atr' plan gets the SAME static-trigger fallback as 'fixed' (no live ATR precompute available to this tick monitor)", async () => {
      // A distinct symbol (not the file's usual AAPL) so the audit-receipt count below can't pick up
      // registrations from other "fixed"/"atr" tests that also use AAPL against the shared test DB.
      broker.positions = [{ symbol: "ATRX", quantity: 10, averageCost: 100, marketValue: 1000 }];
      broker.quotes = { ATRX: { price: 90 } }; // fixed trigger @ base stopLossPct=8% below entry (100) → 92; 90 breaches
      connectTestAccount("SYN-PLAN-ATR");
      recordStopPlan("SYN-PLAN-ATR", "ATRX", "atr", undefined, 100, "local");
      const noTrailPolicy = { ...policyFor("SYN-PLAN-ATR"), riskRules: { ...policyFor("SYN-PLAN-ATR").riskRules, trailingStopPct: 0 } };
      const result = await runSyntheticStopMonitor("local", noTrailPolicy, true);
      expect(result.exited).toBe(1);
      expect(broker.placed).toHaveLength(1);
      expect(broker.placed[0].side).toBe("sell");
      const receipts = auditPayloads("synthetic_stop_registered_fixed", "ATRX");
      expect(receipts).toHaveLength(1);
      expect(receipts[0].plan).toBe("atr");
    });

    it("does NOT register a static-trigger row when a live broker-held stop already covers the position (no double-enforcement)", async () => {
      broker.positions = [{ symbol: "AAPL", quantity: 10, averageCost: 100, marketValue: 1000 }];
      broker.quotes = { AAPL: { price: 90 } }; // would breach the fixed 92 trigger IF registered
      broker.orders = [{ id: "oco-stop-1", symbol: "AAPL", side: "sell", type: "stop", state: "new", quantity: 10 }];
      connectTestAccount("SYN-PLAN-FIXED-COVERED");
      recordStopPlan("SYN-PLAN-FIXED-COVERED", "AAPL", "fixed", undefined, 100, "local");
      const noTrailPolicy = { ...policyFor("SYN-PLAN-FIXED-COVERED"), riskRules: { ...policyFor("SYN-PLAN-FIXED-COVERED").riskRules, trailingStopPct: 0 } };
      const result = await runSyntheticStopMonitor("local", noTrailPolicy, true);
      // The resting broker-held stop already covers the whole position — the synthetic monitor must
      // not stack a second (redundant) protective row/exit on top of it.
      expect(result.exited).toBe(0);
      expect(broker.placed).toHaveLength(0);
      expect(listSyntheticStops("SYN-PLAN-FIXED-COVERED", "local")).toHaveLength(0);
    });

    it("a static-trigger row does NOT ratchet: a favorable rise then a pullback that stays ABOVE the fixed level never fires — only a break below entryPrice*(1-stopPct) does", async () => {
      // Deltas kept within the monitor's own >10% bad-tick filter (BAD_TICK_PCT) at every step —
      // this test is about the fixed/no-ratchet distance, not the separate (already-tracked) bad-tick
      // gap-deadlock behavior, so large single-tick jumps would conflate the two.
      broker.positions = [{ symbol: "AAPL", quantity: 10, averageCost: 100, marketValue: 1000 }];
      connectTestAccount("SYN-PLAN-FIXED-NORATCHET");
      recordStopPlan("SYN-PLAN-FIXED-NORATCHET", "AAPL", "fixed", undefined, 100, "local");
      const policy = { ...policyFor("SYN-PLAN-FIXED-NORATCHET"), riskRules: { ...policyFor("SYN-PLAN-FIXED-NORATCHET").riskRules, trailingStopPct: 0 } };

      // Tick 1: registers at entry (100); price rallies 10% to 110 — a TRAILING stop would ratchet
      // its extreme to 110 (8% trail trigger → 101.2); a FIXED stop must not.
      broker.quotes = { AAPL: { price: 110 } };
      let result = await runSyntheticStopMonitor("local", policy, true);
      expect(result.exited).toBe(0);
      let stops = listSyntheticStops("SYN-PLAN-FIXED-NORATCHET", "local");
      expect(stops).toHaveLength(1);
      expect(stops[0].kind).toBe("fixed");
      expect(stops[0].extremePrice).toBe(100); // pinned at entry, NOT ratcheted to 110

      // Tick 2: price gives back the rally to 100 (flat vs. entry) — ABOVE the fixed trigger (92) but
      // BELOW where a ratcheted trailing extreme (110) would already have fired (101.2). Must NOT fire.
      broker.quotes = { AAPL: { price: 100 } };
      result = await runSyntheticStopMonitor("local", policy, true);
      expect(result.exited).toBe(0);
      stops = listSyntheticStops("SYN-PLAN-FIXED-NORATCHET", "local");
      expect(stops[0].extremePrice).toBe(100); // still pinned

      // Tick 3: price breaks the actual fixed level (92). Must fire now.
      broker.quotes = { AAPL: { price: 90 } };
      result = await runSyntheticStopMonitor("local", policy, true);
      expect(result.exited).toBe(1);
      expect(broker.placed).toHaveLength(1);
      expect(broker.placed[0].side).toBe("sell");
      expect(broker.placed[0].quantity).toBe(10);
    });

    it("a plan change AWAY from 'fixed'/'atr' purges the static-trigger row", async () => {
      broker.positions = [{ symbol: "AAPL", quantity: 10, averageCost: 100, marketValue: 1000 }];
      broker.quotes = { AAPL: { price: 100 } }; // flat — no breach, just exercising registration/purge
      connectTestAccount("SYN-PLAN-FIXED-SWITCH");
      recordStopPlan("SYN-PLAN-FIXED-SWITCH", "AAPL", "fixed", undefined, 100, "local");
      const policy = { ...policyFor("SYN-PLAN-FIXED-SWITCH"), riskRules: { ...policyFor("SYN-PLAN-FIXED-SWITCH").riskRules, trailingStopPct: 0 } };
      await runSyntheticStopMonitor("local", policy, true);
      expect(listSyntheticStops("SYN-PLAN-FIXED-SWITCH", "local")).toHaveLength(1);

      recordStopPlan("SYN-PLAN-FIXED-SWITCH", "AAPL", "none", "reconsidered — no stop wanted", 100, "local");
      await runSyntheticStopMonitor("local", policy, true);
      expect(listSyntheticStops("SYN-PLAN-FIXED-SWITCH", "local")).toHaveLength(0);
      const receipts = auditPayloads("synthetic_stop_purged_by_plan", "AAPL");
      expect(receipts.length).toBeGreaterThan(0);
    });

    it("SHORT fixed plan mirrors the proactive layer's three-tier fallback: shortStopLossPct unset + stopLossPct=15 arms at 15% (NOT the 8% fallback) — a +10% adverse move does not fire (adversarial review of 003dd33e)", async () => {
      // Concrete divergence the adversarial verifier proved: with stopLossPct=15 and
      // shortStopLossPct unset, strategy.ts's generateProactiveRiskProposals resolves a short's
      // stop as shortStopLossPct > 0 ? shortStopLossPct : stopLossPct (= 15), with 8% only when
      // BOTH are unset. A two-tier `shortStopLossPct || 8` here armed the backstop at 8% and fired
      // a real cover at a distance the owner never configured.
      broker.positions = [{ symbol: "NVDA", quantity: -10, averageCost: 100, marketValue: -1100 }]; // mark 110 = +10% adverse
      broker.quotes = { NVDA: { price: 110 } };
      connectTestAccount("SYN-SHORT-FB");
      recordStopPlan("SYN-SHORT-FB", "NVDA", "fixed", undefined, 100, "local", new Date().toISOString(), "short");
      const policy = {
        ...policyFor("SYN-SHORT-FB"),
        riskRules: { ...policyFor("SYN-SHORT-FB").riskRules, trailingStopPct: 0, stopLossPct: 15, shortStopLossPct: 0 }
      };
      const result = await runSyntheticStopMonitor("local", policy, true);
      const stops = [...listSyntheticStops("SYN-SHORT-FB", "local"), ...listSyntheticStops("SYN-SHORT-FB", "local", "triggered")];
      expect(stops).toHaveLength(1);
      expect(stops[0].kind).toBe("fixed");
      expect(stops[0].side).toBe("short");
      // Distance must equal the proactive layer's resolution (15), not the 8% plan fallback...
      expect(stops[0].trailPercent).toBe(15);
      // ...so a +10% adverse move (trigger is 115) must NOT fire a cover.
      expect(result.exited).toBe(0);
      expect(broker.placed).toHaveLength(0);
    });

    it("SHORT fixed plan with BOTH stop %'s unset falls back to the 8% plan distance and fires on a +10% adverse move", async () => {
      broker.positions = [{ symbol: "NVDA", quantity: -10, averageCost: 100, marketValue: -1100 }]; // mark 110 = +10% adverse
      broker.quotes = { NVDA: { price: 110 } };
      connectTestAccount("SYN-SHORT-FB-UNSET");
      recordStopPlan("SYN-SHORT-FB-UNSET", "NVDA", "fixed", undefined, 100, "local", new Date().toISOString(), "short");
      const policy = {
        ...policyFor("SYN-SHORT-FB-UNSET"),
        riskRules: { ...policyFor("SYN-SHORT-FB-UNSET").riskRules, trailingStopPct: 0, stopLossPct: 0, shortStopLossPct: 0 }
      };
      const result = await runSyntheticStopMonitor("local", policy, true);
      // Both unset → STOP_PLAN_FALLBACK_STOP_PCT (8) → trigger 108; 110 breaches → cover fires.
      expect(result.exited).toBe(1);
      expect(broker.placed).toHaveLength(1);
      expect(broker.placed[0].side).toBe("cover");
      expect(broker.placed[0].quantity).toBe(10);
      const stops = listSyntheticStops("SYN-SHORT-FB-UNSET", "local", "triggered");
      expect(stops[0].trailPercent).toBe(8);
    });

    it("does NOT register a NEW static-trigger row while halted (mirrors the trailing lane's halted registration skip)", async () => {
      connectTestAccount("SYN-PLAN-FIXED-HALTED");
      recordStopPlan("SYN-PLAN-FIXED-HALTED", "AAPL", "fixed", undefined, 100, "local");
      broker.positions = [{ symbol: "AAPL", quantity: 10, averageCost: 100, marketValue: 1000 }];
      broker.quotes = { AAPL: { price: 90 } }; // would breach the fixed 92 trigger IF registered
      const haltedPolicy = {
        ...policyFor("SYN-PLAN-FIXED-HALTED"),
        systemState: "halted" as const,
        riskRules: { ...policyFor("SYN-PLAN-FIXED-HALTED").riskRules, trailingStopPct: 0, protectWhileHalted: true }
      };
      const result = await runSyntheticStopMonitor("local", haltedPolicy, true);
      expect(result.evaluated).toBe(0);
      expect(broker.placed).toHaveLength(0);
      expect(listSyntheticStops("SYN-PLAN-FIXED-HALTED", "local")).toHaveLength(0);
    });
  });

  describe("Exit Strategy Phase A: confirmation-based bad-tick acceptance & halted protection", () => {
    it("bad tick confirmation: N=3 consecutive out-of-band prints accept the new level and trigger", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-07-15T10:00:00-04:00")); // 10:00 AM EDT = regular hours
      try {
        connectTestAccount("SYN-CONFIRM");
        upsertSyntheticStop({
          id: "stop-confirm", userId: "local", accountNumber: "SYN-CONFIRM", symbol: "AAPL",
          side: "long", quantity: 100, entryPrice: 100, extremePrice: 100, trailPercent: 5, status: "active",
          lastPrice: 100
        });
        broker.positions = [{ symbol: "AAPL", quantity: 100, averageCost: 100, marketValue: 10000 }];

        // Tick 1: Out-of-band print (85, -15% off 100). Should NOT trigger, should set suspect state.
        broker.quotes = { AAPL: { price: 85 } };
        let res = await runSyntheticStopMonitor("local", policyFor("SYN-CONFIRM"), true);
        expect(res.exited).toBe(0);
        let stops = listSyntheticStops("SYN-CONFIRM", "local");
        expect(stops[0].suspectPrice).toBe(85);
        expect(stops[0].suspectCount).toBe(1);
        expect(stops[0].lastPrice).toBe(100);

        // Tick 2: Second out-of-band print (84.5) agreeing with 85 (diff ~0.6% <= 1.5%). Should NOT trigger.
        broker.quotes = { AAPL: { price: 84.5 } };
        res = await runSyntheticStopMonitor("local", policyFor("SYN-CONFIRM"), true);
        expect(res.exited).toBe(0);
        stops = listSyntheticStops("SYN-CONFIRM", "local");
        expect(stops[0].suspectPrice).toBe(85);
        expect(stops[0].suspectCount).toBe(2);
        expect(stops[0].lastPrice).toBe(100);

        // Tick 3: Third out-of-band print (85.2) agreeing with 85. Should trigger!
        broker.quotes = { AAPL: { price: 85.2 } };
        res = await runSyntheticStopMonitor("local", policyFor("SYN-CONFIRM"), true);
        expect(res.exited).toBe(1);
        stops = listSyntheticStops("SYN-CONFIRM", "local", "triggered");
        expect(stops[0].status).toBe("triggered");
        expect(stops[0].suspectPrice).toBeUndefined();
        expect(stops[0].suspectCount).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it("bad tick non-confirmation: non-agreeing out-of-band prints reset suspect count", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-07-15T10:00:00-04:00")); // 10:00 AM EDT = regular hours
      try {
        connectTestAccount("SYN-RESET");
        upsertSyntheticStop({
          id: "stop-reset", userId: "local", accountNumber: "SYN-RESET", symbol: "AAPL",
          side: "long", quantity: 100, entryPrice: 100, extremePrice: 100, trailPercent: 5, status: "active",
          lastPrice: 100
        });
        broker.positions = [{ symbol: "AAPL", quantity: 100, averageCost: 100, marketValue: 10000 }];

        // Tick 1: Out-of-band print (85). suspectPrice=85, suspectCount=1.
        broker.quotes = { AAPL: { price: 85 } };
        await runSyntheticStopMonitor("local", policyFor("SYN-RESET"), true);

        // Tick 2: Out-of-band print (80) not agreeing with 85 (diff > 1.5%). suspectPrice=80, suspectCount=1.
        broker.quotes = { AAPL: { price: 80 } };
        await runSyntheticStopMonitor("local", policyFor("SYN-RESET"), true);
        const stops = listSyntheticStops("SYN-RESET", "local");
        expect(stops[0].suspectPrice).toBe(80);
        expect(stops[0].suspectCount).toBe(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("extended-hours corroboration: requires real bid/ask quote", async () => {
      connectTestAccount("SYN-EXT");
      upsertSyntheticStop({
        id: "stop-ext", userId: "local", accountNumber: "SYN-EXT", symbol: "AAPL",
        side: "long", quantity: 100, entryPrice: 100, extremePrice: 100, trailPercent: 5, status: "active",
        lastPrice: 100
      });
      broker.positions = [{ symbol: "AAPL", quantity: 100, averageCost: 100, marketValue: 10000 }];

      const extPolicy = { ...policyFor("SYN-EXT"), allowExtendedHoursSyntheticStops: true };
      // pre-market hours: 06:00 AM
      const preMarketTime = new Date("2026-07-17T06:00:00-04:00");

      // Tick 1: Out-of-band print (85) with synthetic spread. Should NOT increment suspect count.
      broker.quotes = { AAPL: { price: 85, syntheticSpread: true, syntheticBid: true, syntheticAsk: true } as any };
      await runSyntheticStopMonitor("local", extPolicy, true, preMarketTime);
      let stops = listSyntheticStops("SYN-EXT", "local");
      expect(stops[0].suspectCount).toBe(0);

      // Tick 2: Out-of-band print (85) with real bid/ask. Should increment.
      broker.quotes = { AAPL: { price: 85, bid: 84.8, ask: 85.2, syntheticSpread: false, syntheticBid: false, syntheticAsk: false } as any };
      await runSyntheticStopMonitor("local", extPolicy, true, preMarketTime);
      stops = listSyntheticStops("SYN-EXT", "local");
      expect(stops[0].suspectPrice).toBe(85);
      expect(stops[0].suspectCount).toBe(1);
    });

    it("session boundary reset at regular open", async () => {
      connectTestAccount("SYN-BOUNDARY");
      upsertSyntheticStop({
        id: "stop-boundary", userId: "local", accountNumber: "SYN-BOUNDARY", symbol: "AAPL",
        side: "long", quantity: 100, entryPrice: 100, extremePrice: 100, trailPercent: 5, status: "active",
        lastPrice: 100, suspectPrice: 85, suspectCount: 2
      });
      // pre-market time: 06:00 AM. updatedAt is set to this time.
      const preMarketTime = new Date("2026-07-17T06:00:00-04:00");
      getDb().prepare("UPDATE synthetic_trailing_stops SET updated_at = ? WHERE id = ?").run(preMarketTime.toISOString(), "stop-boundary");

      broker.positions = [{ symbol: "AAPL", quantity: 100, averageCost: 100, marketValue: 10000 }];
      broker.quotes = { AAPL: { price: 100 } }; // normal price

      // Run during regular hours: 10:00 AM. Should reset suspect state.
      const regularTime = new Date("2026-07-17T10:00:00-04:00");
      await runSyntheticStopMonitor("local", policyFor("SYN-BOUNDARY"), true, regularTime);
      const stops = listSyntheticStops("SYN-BOUNDARY", "local");
      expect(stops[0].suspectPrice).toBeUndefined();
      expect(stops[0].suspectCount).toBe(0);
    });

    it("protectWhileHalted: monitor fires exits in halted when toggle is ON, but never registers new stops", async () => {
      connectTestAccount("SYN-HALTED-ON");
      
      // Part 1: Exits should fire if stop already exists and breaches
      upsertSyntheticStop({
        id: "stop-halted-on", userId: "local", accountNumber: "SYN-HALTED-ON", symbol: "AAPL",
        side: "long", quantity: 100, entryPrice: 100, extremePrice: 100, trailPercent: 5, status: "active",
        lastPrice: 100
      });
      broker.positions = [{ symbol: "AAPL", quantity: 100, averageCost: 100, marketValue: 10000 }];
      broker.quotes = { AAPL: { price: 90 } }; // breaches 95 trigger

      const policyOn = {
        ...policyFor("SYN-HALTED-ON"),
        systemState: "halted" as const,
        riskRules: { ...policyFor("SYN-HALTED-ON").riskRules, protectWhileHalted: true }
      };
      
      const res = await runSyntheticStopMonitor("local", policyOn, true);
      expect(res.exited).toBe(1);
      expect(broker.placed).toHaveLength(1);

      // Part 2: Never registers new stops under halted mode even if trailingStopPct is set
      connectTestAccount("SYN-HALTED-REG");
      broker.positions = [{ symbol: "AAPL", quantity: 100, averageCost: 100, marketValue: 10000 }];
      broker.quotes = { AAPL: { price: 100 } };
      
      const policyReg = {
        ...policyFor("SYN-HALTED-REG"),
        systemState: "halted" as const,
        riskRules: { ...policyFor("SYN-HALTED-REG").riskRules, trailingStopPct: 5, protectWhileHalted: true }
      };

      const resReg = await runSyntheticStopMonitor("local", policyReg, true);
      expect(resReg.evaluated).toBe(0); // AAPL stop shouldn't be registered, so evaluated is 0
      const stops = listSyntheticStops("SYN-HALTED-REG", "local");
      expect(stops).toHaveLength(0);
    });

    it("protectWhileHalted: never PLACES/REPLACES a broker-held protective stop while halted", async () => {
      // Money-path regression (PR #1701 finding 1): a halted+protectWhileHalted tick runs
      // runSyntheticStopMonitor(..., running=true), and that `running` flag used to flow straight
      // into reconcileBrokerProtectiveStops — so a halted account could still PLACE new/looser
      // broker-held protective orders. Halted protection may only FIRE existing exits, never place
      // or replace broker stops. Uses an Alpaca (paper) account so the broker trailing-stop lane
      // is actually enabled (desiredBrokerStopKind === "trailing").
      connectTestAccount("SYN-HALTED-BSTOP", "paper", "alpaca");
      broker.positions = [{ symbol: "AAPL", quantity: 100, averageCost: 100, marketValue: 10000 }];
      broker.quotes = { AAPL: { price: 100 } }; // no breach — isolate the placement path, not firing

      const haltedPolicy = {
        ...policyFor("SYN-HALTED-BSTOP"),
        activeBroker: "alpaca" as const,
        systemState: "halted" as const,
        riskRules: { ...policyFor("SYN-HALTED-BSTOP").riskRules, trailingStopPct: 5, protectWhileHalted: true }
      };
      await runSyntheticStopMonitor("local", haltedPolicy, true);
      // Halted: no broker-held protective stop may be placed, and no tracking row persisted.
      expect(broker.placed).toHaveLength(0);
      expect(listBrokerProtectiveStops("SYN-HALTED-BSTOP", "local")).toHaveLength(0);

      // Control: the SAME account when ACTIVE does place a broker-held trailing stop — proving the
      // lane is live and the halted suppression above is what blocked it (not a disabled lane).
      broker.placed = [];
      const activePolicy = { ...haltedPolicy, systemState: "active" as const };
      await runSyntheticStopMonitor("local", activePolicy, true);
      expect(broker.placed.length).toBeGreaterThan(0);
      expect(listBrokerProtectiveStops("SYN-HALTED-BSTOP", "local").length).toBeGreaterThan(0);
    });

    it("protectWhileHalted: RIGHT-SIZES an oversized broker stop (cancel + place smaller replacement) so it can't over-sell NOR strand the position (Codex PR #1738)", async () => {
      // A halted+protectWhileHalted account whose position was partially reduced out-of-band leaves a
      // resting broker stop sized for the PRE-shrink quantity; if it fires it over-sells / opens a
      // short. While halted the reconciler cancels the oversized stop AND places a correctly-sized
      // replacement the SAME tick (a risk-reducing right-size — the smaller half). Leaving no
      // replacement would strand the position: a broker-covered position has no synthetic row and the
      // monitor won't register one while halted.
      connectTestAccount("SYN-HALT-OVER", "paper", "alpaca");
      broker.positions = [{ symbol: "NVDA", quantity: 40, averageCost: 100, marketValue: 4000 }]; // shrank 100 -> 40
      broker.quotes = { NVDA: { price: 100 } }; // no breach — isolate the reconcile path, not firing
      broker.orders = [{ id: "prot-over", symbol: "NVDA", side: "sell", type: "stop_market", state: "queued", quantity: 100 }];
      upsertBrokerProtectiveStop({
        id: "protstop-local-SYN-HALT-OVER-NVDA", userId: "local", accountNumber: "SYN-HALT-OVER",
        symbol: "NVDA", brokerOrderId: "prot-over", quantity: 100, stopPrice: 95, status: "resting",
        kind: "trailing", trailPercent: 5
      });
      const haltedPolicy = {
        ...policyFor("SYN-HALT-OVER"),
        activeBroker: "alpaca" as const,
        systemState: "halted" as const,
        riskRules: { ...policyFor("SYN-HALT-OVER").riskRules, trailingStopPct: 5, protectWhileHalted: true }
      };
      await runSyntheticStopMonitor("local", haltedPolicy, true);
      expect(broker.cancelled).toContain("prot-over"); // the oversized stop WAS cancelled while halted
      expect(broker.placed).toHaveLength(1); // ...and a right-sized replacement WAS placed the same tick
      expect(broker.placed[0]).toMatchObject({ side: "sell", quantity: 40 }); // sized to the CURRENT 40 shares
      const rows = listBrokerProtectiveStops("SYN-HALT-OVER", "local");
      expect(rows).toHaveLength(1); // still protected — the right-sized stop
      expect(rows[0].quantity).toBe(40);
    });

    it("protectWhileHalted: a right-size whose replacement placement FAILS persists a pending_replace marker that the NEXT halted tick reads and retries (Codex PR #1738 F1)", async () => {
      // The oversized right-size cancels the too-large stop, then the smaller replacement placement
      // throws (broker hiccup). The position is now uncovered AND halted, so section 4 can't freely
      // re-place. A durable `pending_replace` marker records the owed retry; on the next halted tick
      // section 1 must READ that marker (listBrokerProtectiveStops has to return pending_replace rows),
      // re-queue the symbol, and section 4 completes the replacement — otherwise the position stays
      // unprotected until the account is unhalted.
      connectTestAccount("SYN-HALT-F1RETRY", "paper", "alpaca");
      broker.positions = [{ symbol: "NVDA", quantity: 40, averageCost: 100, marketValue: 4000 }]; // shrank 100 -> 40
      broker.quotes = { NVDA: { price: 100 } }; // no breach — isolate the reconcile path
      broker.orders = [{ id: "prot-f1", symbol: "NVDA", side: "sell", type: "stop_market", state: "queued", quantity: 100 }];
      upsertBrokerProtectiveStop({
        id: "protstop-local-SYN-HALT-F1RETRY-NVDA", userId: "local", accountNumber: "SYN-HALT-F1RETRY",
        symbol: "NVDA", brokerOrderId: "prot-f1", quantity: 100, stopPrice: 95, status: "resting",
        kind: "trailing", trailPercent: 5
      });
      const haltedPolicy = {
        ...policyFor("SYN-HALT-F1RETRY"),
        activeBroker: "alpaca" as const,
        systemState: "halted" as const,
        riskRules: { ...policyFor("SYN-HALT-F1RETRY").riskRules, trailingStopPct: 5, protectWhileHalted: true }
      };

      // Tick 1: right-size cancels the oversized stop, but the replacement placement THROWS.
      broker.placeError = new Error("broker rejected placement");
      await runSyntheticStopMonitor("local", haltedPolicy, true);
      expect(broker.cancelled).toContain("prot-f1"); // oversized stop cancelled
      expect(broker.placed).toHaveLength(1); // replacement attempted (and threw)
      const afterTick1 = listBrokerProtectiveStops("SYN-HALT-F1RETRY", "local");
      expect(afterTick1).toHaveLength(1);
      expect(afterTick1[0].status).toBe("pending_replace"); // durable retry marker persisted
      expect(afterTick1[0].quantity).toBe(40); // sized to the current 40 shares

      // Tick 2: broker healthy, the cancelled order is gone. Section 1 must SEE the pending_replace
      // marker and re-queue; section 4 then completes the right-sized replacement.
      broker.placeError = null;
      broker.cancelled = [];
      broker.placed = [];
      broker.orders = []; // prot-f1 was cancelled last tick — no live order remains
      await runSyntheticStopMonitor("local", haltedPolicy, true);
      expect(broker.placed).toHaveLength(1); // replacement finally placed
      expect(broker.placed[0]).toMatchObject({ side: "sell", quantity: 40 });
      const afterTick2 = listBrokerProtectiveStops("SYN-HALT-F1RETRY", "local");
      expect(afterTick2).toHaveLength(1);
      expect(afterTick2[0].status).toBe("resting"); // protection restored
      expect(afterTick2[0].quantity).toBe(40);
    });

    it("protectWhileHalted: a pending_replace marker SURVIVES a tick that SKIPS placement (order-list fetch failed) — not lost before the retry is placed (Codex PR #1738)", async () => {
      // Finding #1: section 1 must NOT delete the durable retry marker before section 4 proves it can
      // place. If the retry tick skips (here: order-list fetch fails -> qty unknown), deleting the
      // marker would forget the owed right-size and leave the position unprotected until unhalted.
      connectTestAccount("SYN-HALT-KEEPMARK", "paper", "alpaca");
      broker.positions = [{ symbol: "NVDA", quantity: 40, averageCost: 100, marketValue: 4000 }];
      broker.quotes = { NVDA: { price: 100 } };
      broker.orders = [];
      upsertBrokerProtectiveStop({
        id: "protstop-local-SYN-HALT-KEEPMARK-NVDA", userId: "local", accountNumber: "SYN-HALT-KEEPMARK",
        symbol: "NVDA", brokerOrderId: "pending-replace-1-NVDA", quantity: 40, stopPrice: 95,
        status: "pending_replace", kind: "trailing", trailPercent: 5
      });
      const haltedPolicy = {
        ...policyFor("SYN-HALT-KEEPMARK"),
        activeBroker: "alpaca" as const,
        systemState: "halted" as const,
        riskRules: { ...policyFor("SYN-HALT-KEEPMARK").riskRules, trailingStopPct: 5, protectWhileHalted: true }
      };

      // Tick 1: order list unreadable -> section 4 skips placement (coverage unknown). Marker KEPT.
      broker.ordersError = new Error("order list unreadable this tick");
      try {
        await runSyntheticStopMonitor("local", haltedPolicy, true);
        expect(broker.placed).toHaveLength(0); // skipped, not placed
        const afterSkip = listBrokerProtectiveStops("SYN-HALT-KEEPMARK", "local");
        expect(afterSkip).toHaveLength(1);
        expect(afterSkip[0].status).toBe("pending_replace"); // marker preserved across the skip
      } finally {
        broker.ordersError = null;
      }

      // Tick 2: order list readable, no live order -> the preserved marker completes the placement.
      broker.placed = [];
      broker.orders = [];
      await runSyntheticStopMonitor("local", haltedPolicy, true);
      expect(broker.placed).toHaveLength(1);
      const afterPlace = listBrokerProtectiveStops("SYN-HALT-KEEPMARK", "local");
      expect(afterPlace).toHaveLength(1);
      expect(afterPlace[0].status).toBe("resting");
    });

    it("protectWhileHalted: a pending_replace marker for a CLOSED position is dropped WITHOUT a broker cancel of its synthetic ref (Codex PR #1738)", async () => {
      // Finding #2: cancel-only paths must never call cancelEquityOrder on a marker's synthetic
      // `pending-replace-*` id (404 -> stuck pending_cancel). When the position closed, section 1 drops
      // the marker outright — no broker call — and no cancel-on-close path touches it.
      connectTestAccount("SYN-HALT-MARKCLOSE", "paper", "alpaca");
      broker.positions = []; // position closed out-of-band
      broker.quotes = {};
      broker.orders = [];
      upsertBrokerProtectiveStop({
        id: "protstop-local-SYN-HALT-MARKCLOSE-NVDA", userId: "local", accountNumber: "SYN-HALT-MARKCLOSE",
        symbol: "NVDA", brokerOrderId: "pending-replace-9-NVDA", quantity: 40, stopPrice: 95,
        status: "pending_replace", kind: "trailing", trailPercent: 5
      });
      const haltedPolicy = {
        ...policyFor("SYN-HALT-MARKCLOSE"),
        activeBroker: "alpaca" as const,
        systemState: "halted" as const,
        riskRules: { ...policyFor("SYN-HALT-MARKCLOSE").riskRules, trailingStopPct: 5, protectWhileHalted: true }
      };
      await runSyntheticStopMonitor("local", haltedPolicy, true);
      expect(broker.cancelled).not.toContain("pending-replace-9-NVDA"); // never cancelled the fake id
      expect(broker.placed).toHaveLength(0);
      expect(listBrokerProtectiveStops("SYN-HALT-MARKCLOSE", "local")).toHaveLength(0); // marker dropped
    });

    it("protectWhileHalted: a retry ADOPTS a now-visible order carrying the prior submitted ref instead of duplicating it (Codex PR #1738)", async () => {
      // Finding #3: when the right-size placement THREW after the broker accepted it, the marker stores
      // the submitted client ref. On the next tick, a live order carrying that ref is adopted (tracked
      // by its real id) rather than re-placed as a duplicate.
      connectTestAccount("SYN-HALT-ADOPT", "paper", "alpaca");
      broker.positions = [{ symbol: "NVDA", quantity: 40, averageCost: 100, marketValue: 4000 }]; // shrank 100 -> 40
      broker.quotes = { NVDA: { price: 100 } };
      broker.orders = [{ id: "prot-adopt", symbol: "NVDA", side: "sell", type: "stop_market", state: "queued", quantity: 100 }];
      upsertBrokerProtectiveStop({
        id: "protstop-local-SYN-HALT-ADOPT-NVDA", userId: "local", accountNumber: "SYN-HALT-ADOPT",
        symbol: "NVDA", brokerOrderId: "prot-adopt", quantity: 100, stopPrice: 95, status: "resting",
        kind: "trailing", trailPercent: 5
      });
      const haltedPolicy = {
        ...policyFor("SYN-HALT-ADOPT"),
        activeBroker: "alpaca" as const,
        systemState: "halted" as const,
        riskRules: { ...policyFor("SYN-HALT-ADOPT").riskRules, trailingStopPct: 5, protectWhileHalted: true }
      };

      // Tick 1: the oversized stop is cancelled, the right-sized replacement placement THROWS (but the
      // broker actually accepted it). The marker records the submitted client ref.
      broker.placeError = new Error("reply lost after broker accepted");
      await runSyntheticStopMonitor("local", haltedPolicy, true);
      const afterThrow = listBrokerProtectiveStops("SYN-HALT-ADOPT", "local");
      expect(afterThrow).toHaveLength(1);
      expect(afterThrow[0].status).toBe("pending_replace");
      const submittedRef = afterThrow[0].brokerOrderId;
      expect(submittedRef).not.toMatch(/^pending-replace-/); // a REAL client ref was preserved

      // Tick 2: the broker's order list now shows the accepted order carrying that ref. Adopt it.
      broker.placeError = null;
      broker.placed = [];
      broker.cancelled = [];
      broker.orders = [{ id: "adopted-real", symbol: "NVDA", side: "sell", type: "stop_market", state: "queued", quantity: 40, clientOrderId: submittedRef }];
      await runSyntheticStopMonitor("local", haltedPolicy, true);
      expect(broker.placed).toHaveLength(0); // adopted, NOT duplicated
      const afterAdopt = listBrokerProtectiveStops("SYN-HALT-ADOPT", "local");
      expect(afterAdopt).toHaveLength(1);
      expect(afterAdopt[0].status).toBe("resting");
      expect(afterAdopt[0].brokerOrderId).toBe("adopted-real"); // now tracked by its real broker id
    });

    it("protectWhileHalted: does NOT cancel a correctly-sized stop with only a trail-% mismatch — protection-CHANGING replacements stay blocked while halted (Codex PR #1738)", async () => {
      // The counterpart to the oversized case: a full-size resting trailing stop whose only drift is a
      // trail-% change is a cancel-THEN-replace. While halted the replacement can't be placed, so
      // cancelling would strand the position with no stop — keep the existing one. (An oversized SHRINK
      // is the sole exception, tested above.)
      connectTestAccount("SYN-HALT-KEEP", "paper", "alpaca");
      broker.positions = [{ symbol: "NVDA", quantity: 100, averageCost: 100, marketValue: 13000 }]; // mark 130 (rallied)
      broker.quotes = { NVDA: { price: 130 } }; // above the trail — no breach, and full coverage suppresses synthetic
      broker.orders = [{ id: "prot-keep", symbol: "NVDA", side: "sell", type: "stop_market", state: "queued", quantity: 100 }];
      upsertBrokerProtectiveStop({
        id: "protstop-local-SYN-HALT-KEEP-NVDA", userId: "local", accountNumber: "SYN-HALT-KEEP",
        symbol: "NVDA", brokerOrderId: "prot-keep", quantity: 100, stopPrice: 95, status: "resting",
        kind: "trailing", trailPercent: 5
      });
      // policy trail is 6% while the resting stop is 5% -> a "trail %" mismatch (a cancel/replace),
      // NOT a quantity shrink.
      const haltedPolicy = {
        ...policyFor("SYN-HALT-KEEP"),
        activeBroker: "alpaca" as const,
        systemState: "halted" as const,
        riskRules: { ...policyFor("SYN-HALT-KEEP").riskRules, trailingStopPct: 6, protectWhileHalted: true }
      };
      await runSyntheticStopMonitor("local", haltedPolicy, true);
      expect(broker.cancelled).toHaveLength(0); // kept — never cancelled into a replacement we can't place
      expect(broker.placed).toHaveLength(0);
      expect(listBrokerProtectiveStops("SYN-HALT-KEEP", "local")).toHaveLength(1); // still resting

      // Control: the SAME trail-% mismatch when ACTIVE cancels-and-replaces — proving the halt gate is
      // what kept it, not an inert lane.
      broker.cancelled = [];
      broker.placed = [];
      const activePolicy = { ...haltedPolicy, systemState: "active" as const };
      await runSyntheticStopMonitor("local", activePolicy, true);
      expect(broker.cancelled).toContain("prot-keep");
      expect(broker.placed.length).toBeGreaterThan(0);
    });

    it("protectWhileHalted: does NOT retry a pending_cancel row for an OPEN position — the still-live stop keeps protecting (Codex PR #1738)", async () => {
      // A `pending_cancel` row for an open position may track a still-live broker order (its cancel
      // kept failing) left over from an earlier non-shrink replacement attempt. Section 1 would retry
      // the cancel and succeed, removing the ONLY broker-held stop — and section 4 (blocked while
      // halted) then refuses the replacement, stranding the position. The section-1 skip now also
      // covers haltedProtectOnly, so the retry is deferred and the old stop keeps protecting.
      connectTestAccount("SYN-HALT-PC", "paper", "alpaca");
      broker.positions = [{ symbol: "NVDA", quantity: 100, averageCost: 100, marketValue: 10000 }];
      broker.quotes = { NVDA: { price: 100 } }; // no breach
      broker.orders = [{ id: "prot-pc", symbol: "NVDA", side: "sell", type: "stop_market", state: "queued", quantity: 100 }]; // still live
      upsertBrokerProtectiveStop({
        id: "protstop-local-SYN-HALT-PC-NVDA", userId: "local", accountNumber: "SYN-HALT-PC",
        symbol: "NVDA", brokerOrderId: "prot-pc", quantity: 100, stopPrice: 95, status: "pending_cancel",
        kind: "trailing", trailPercent: 5
      });
      const haltedPolicy = {
        ...policyFor("SYN-HALT-PC"),
        activeBroker: "alpaca" as const,
        systemState: "halted" as const,
        riskRules: { ...policyFor("SYN-HALT-PC").riskRules, trailingStopPct: 5, protectWhileHalted: true }
      };
      await runSyntheticStopMonitor("local", haltedPolicy, true);
      expect(broker.cancelled).not.toContain("prot-pc"); // retry deferred while halted
      const rows = listBrokerProtectiveStops("SYN-HALT-PC", "local");
      expect(rows.some((r) => r.brokerOrderId === "prot-pc" && r.status === "pending_cancel")).toBe(true);

      // Control: ACTIVE retries and cancels the pending_cancel row (proving the halt gate deferred it).
      broker.cancelled = [];
      const activePolicy = { ...haltedPolicy, systemState: "active" as const };
      await runSyntheticStopMonitor("local", activePolicy, true);
      expect(broker.cancelled).toContain("prot-pc");
    });

    it("protectWhileHalted: DOES retry an OVERSIZED pending_cancel row and right-sizes it — an over-selling order can't linger through a halt (Codex PR #1738)", async () => {
      // Counterpart to the kept-pending_cancel case: when the pending_cancel row's quantity EXCEEDS the
      // current position (out-of-band partial exit), it would over-sell/short if it fires — and section
      // 3 only examines resting stops, so this section-1 retry is the ONLY path that can clear it. The
      // halt guard makes an exception for the oversized row: it retries the cancel and section 4 places
      // a right-sized replacement the same tick.
      connectTestAccount("SYN-HALT-PCO", "paper", "alpaca");
      broker.positions = [{ symbol: "NVDA", quantity: 40, averageCost: 100, marketValue: 4000 }]; // shrank 100 -> 40
      broker.quotes = { NVDA: { price: 100 } }; // no breach
      broker.orders = [{ id: "prot-pco", symbol: "NVDA", side: "sell", type: "stop_market", state: "queued", quantity: 100 }]; // still live, oversized
      upsertBrokerProtectiveStop({
        id: "protstop-local-SYN-HALT-PCO-NVDA", userId: "local", accountNumber: "SYN-HALT-PCO",
        symbol: "NVDA", brokerOrderId: "prot-pco", quantity: 100, stopPrice: 95, status: "pending_cancel",
        kind: "trailing", trailPercent: 5
      });
      const haltedPolicy = {
        ...policyFor("SYN-HALT-PCO"),
        activeBroker: "alpaca" as const,
        systemState: "halted" as const,
        riskRules: { ...policyFor("SYN-HALT-PCO").riskRules, trailingStopPct: 5, protectWhileHalted: true }
      };
      await runSyntheticStopMonitor("local", haltedPolicy, true);
      expect(broker.cancelled).toContain("prot-pco"); // oversized pending row cancelled despite the halt
      expect(broker.placed).toHaveLength(1); // right-sized replacement placed
      expect(broker.placed[0]).toMatchObject({ side: "sell", quantity: 40 });
      const rows = listBrokerProtectiveStops("SYN-HALT-PCO", "local");
      expect(rows).toHaveLength(1);
      expect(rows[0].quantity).toBe(40);
    });

    it("protectWhileHalted: KEEPS an oversized stop when the right-sized trailing replacement can't arm (mark below tracked extreme) — cancel only if replaceable (Codex PR #1738)", async () => {
      // Rally-then-pullback: the resting stop's high stopPrice implies a tracked extreme (126.32) well
      // ABOVE the current mark (100), so canArmTrailingNow refuses a native trailing replacement. While
      // halted there is no synthetic fallback, so cancelling the oversized stop would strand the
      // position — keep it instead (a bounded over-sell risk beats no protection).
      connectTestAccount("SYN-HALT-NOARM", "paper", "alpaca");
      broker.positions = [{ symbol: "NVDA", quantity: 40, averageCost: 100, marketValue: 4000 }]; // shrank 100 -> 40, mark 100
      broker.quotes = { NVDA: { price: 100 } };
      broker.orders = [{ id: "prot-noarm", symbol: "NVDA", side: "sell", type: "stop_market", state: "queued", quantity: 100 }];
      upsertBrokerProtectiveStop({
        id: "protstop-local-SYN-HALT-NOARM-NVDA", userId: "local", accountNumber: "SYN-HALT-NOARM",
        symbol: "NVDA", brokerOrderId: "prot-noarm", quantity: 100, stopPrice: 120, status: "resting", // implies extreme 126.32 > mark
        kind: "trailing", trailPercent: 5
      });
      const haltedPolicy = {
        ...policyFor("SYN-HALT-NOARM"),
        activeBroker: "alpaca" as const,
        systemState: "halted" as const,
        riskRules: { ...policyFor("SYN-HALT-NOARM").riskRules, trailingStopPct: 5, protectWhileHalted: true }
      };
      await runSyntheticStopMonitor("local", haltedPolicy, true);
      expect(broker.cancelled).toHaveLength(0); // kept — the replacement couldn't arm, so no strand
      expect(broker.placed).toHaveLength(0);
      const rows = listBrokerProtectiveStops("SYN-HALT-NOARM", "local");
      expect(rows).toHaveLength(1);
      expect(rows[0].quantity).toBe(100); // the (oversized) stop still rests
    });

    it("protectWhileHalted: KEEPS an oversized stop when the broker order-list fetch failed (coverage unknown) — no right-size computable (Codex PR #1738)", async () => {
      // ordersError -> getEquityOrders throws -> ordersListed=false -> desiredStopQuantity returns null
      // (coverage unknown). While halted, no replacement can be sized and no synthetic fallback
      // registers, so cancelling would strand the position — keep the oversized stop.
      connectTestAccount("SYN-HALT-NOFETCH", "paper", "alpaca");
      broker.positions = [{ symbol: "NVDA", quantity: 40, averageCost: 100, marketValue: 4000 }]; // shrank 100 -> 40
      broker.quotes = { NVDA: { price: 100 } };
      broker.orders = [];
      broker.ordersError = new Error("order list unreadable this tick");
      upsertBrokerProtectiveStop({
        id: "protstop-local-SYN-HALT-NOFETCH-NVDA", userId: "local", accountNumber: "SYN-HALT-NOFETCH",
        symbol: "NVDA", brokerOrderId: "prot-nofetch", quantity: 100, stopPrice: 95, status: "resting",
        kind: "trailing", trailPercent: 5
      });
      const haltedPolicy = {
        ...policyFor("SYN-HALT-NOFETCH"),
        activeBroker: "alpaca" as const,
        systemState: "halted" as const,
        riskRules: { ...policyFor("SYN-HALT-NOFETCH").riskRules, trailingStopPct: 5, protectWhileHalted: true }
      };
      try {
        await runSyntheticStopMonitor("local", haltedPolicy, true);
        expect(broker.cancelled).toHaveLength(0); // kept — coverage unknown, can't right-size
        expect(broker.placed).toHaveLength(0);
        const rows = listBrokerProtectiveStops("SYN-HALT-NOFETCH", "local");
        expect(rows).toHaveLength(1);
        expect(rows[0].quantity).toBe(100);
      } finally {
        broker.ordersError = null;
      }
    });

    it("protectWhileHalted: right-sizes an oversized stop that ALSO needs a kind change (label-independent shrink) — Codex PR #1738", async () => {
      // The mismatch label is "stop kind fixed -> trailing" (set before the quantity check), but the row
      // is ALSO oversized. Keying isQuantityShrink off the label would miss it and keep an over-selling
      // stop; the fix judges the shrink by quantities, so it's cancelled + right-sized like any shrink.
      connectTestAccount("SYN-HALT-KINDSHRINK", "paper", "alpaca");
      broker.positions = [{ symbol: "NVDA", quantity: 40, averageCost: 100, marketValue: 4000 }]; // shrank 100 -> 40
      broker.quotes = { NVDA: { price: 100 } };
      broker.orders = [{ id: "prot-kind", symbol: "NVDA", side: "sell", type: "stop_market", state: "queued", quantity: 100 }];
      upsertBrokerProtectiveStop({
        id: "protstop-local-SYN-HALT-KINDSHRINK-NVDA", userId: "local", accountNumber: "SYN-HALT-KINDSHRINK",
        symbol: "NVDA", brokerOrderId: "prot-kind", quantity: 100, stopPrice: 92, status: "resting",
        kind: "fixed" // account wants trailing below -> kind mismatch, AND oversized
      });
      const haltedPolicy = {
        ...policyFor("SYN-HALT-KINDSHRINK"),
        activeBroker: "alpaca" as const,
        systemState: "halted" as const,
        riskRules: { ...policyFor("SYN-HALT-KINDSHRINK").riskRules, trailingStopPct: 5, protectWhileHalted: true }
      };
      await runSyntheticStopMonitor("local", haltedPolicy, true);
      expect(broker.cancelled).toContain("prot-kind"); // over-selling stop removed despite the kind label
      expect(broker.placed).toHaveLength(1);
      expect(broker.placed[0]).toMatchObject({ side: "sell", quantity: 40 });
      const rows = listBrokerProtectiveStops("SYN-HALT-KINDSHRINK", "local");
      expect(rows).toHaveLength(1);
      expect(rows[0].quantity).toBe(40);
    });

    it("protectWhileHalted: cancels a redundant oversized stop when another live order already covers (qty<=0) — no arm-gate strand (Codex PR #1738)", async () => {
      // Another live sell already covers the shrunk position, so desiredStopQuantity resolves to 0 — no
      // replacement is needed. The halted trailing arm-gate must NOT block this cancel (it only guards
      // when qty>0), else the stacking oversized stop keeps resting and both could fire (over-sell).
      connectTestAccount("SYN-HALT-COV", "paper", "alpaca");
      broker.positions = [{ symbol: "NVDA", quantity: 40, averageCost: 100, marketValue: 4000 }]; // shrank 100 -> 40
      broker.quotes = { NVDA: { price: 100 } };
      broker.orders = [
        { id: "prot-cov", symbol: "NVDA", side: "sell", type: "stop_market", state: "queued", quantity: 100 },
        { id: "other-sell", symbol: "NVDA", side: "sell", type: "limit", state: "open", quantity: 40 } // covers the 40 shares
      ];
      upsertBrokerProtectiveStop({
        id: "protstop-local-SYN-HALT-COV-NVDA", userId: "local", accountNumber: "SYN-HALT-COV",
        symbol: "NVDA", brokerOrderId: "prot-cov", quantity: 100, stopPrice: 120, status: "resting", // high stopPrice: canArm would be FALSE, but qty<=0 bypasses the gate
        kind: "trailing", trailPercent: 5
      });
      const haltedPolicy = {
        ...policyFor("SYN-HALT-COV"),
        activeBroker: "alpaca" as const,
        systemState: "halted" as const,
        riskRules: { ...policyFor("SYN-HALT-COV").riskRules, trailingStopPct: 5, protectWhileHalted: true }
      };
      await runSyntheticStopMonitor("local", haltedPolicy, true);
      expect(broker.cancelled).toContain("prot-cov"); // redundant oversized stop removed (other order covers)
      expect(broker.placed).toHaveLength(0); // qty<=0 -> no replacement needed
      expect(listBrokerProtectiveStops("SYN-HALT-COV", "local")).toHaveLength(0);
    });

    it("protectWhileHalted: KEEPS an oversized pending_cancel trailing stop whose ratcheted extreme is above the mark — extreme backfilled before placeability (Codex PR #1738)", async () => {
      // The pending_cancel placeability check runs BEFORE the section-3 extreme backfill; the inline
      // backfill reconstructs the extreme (126.32 from stopPrice 120) so canArmTrailingNow sees mark 100
      // < extreme and refuses — the stop is KEPT rather than cancelled + reseeded from the depressed mark
      // (which would loosen protection during a halt).
      connectTestAccount("SYN-HALT-PCBF", "paper", "alpaca");
      broker.positions = [{ symbol: "NVDA", quantity: 40, averageCost: 100, marketValue: 4000 }]; // shrank 100 -> 40, mark 100
      broker.quotes = { NVDA: { price: 100 } };
      broker.orders = [{ id: "prot-pcbf", symbol: "NVDA", side: "sell", type: "stop_market", state: "queued", quantity: 100, stopPrice: 120 }]; // still live, ratcheted
      upsertBrokerProtectiveStop({
        id: "protstop-local-SYN-HALT-PCBF-NVDA", userId: "local", accountNumber: "SYN-HALT-PCBF",
        symbol: "NVDA", brokerOrderId: "prot-pcbf", quantity: 100, stopPrice: 120, status: "pending_cancel", // extreme 126.32 > mark 100
        kind: "trailing", trailPercent: 5
      });
      const haltedPolicy = {
        ...policyFor("SYN-HALT-PCBF"),
        activeBroker: "alpaca" as const,
        systemState: "halted" as const,
        riskRules: { ...policyFor("SYN-HALT-PCBF").riskRules, trailingStopPct: 5, protectWhileHalted: true }
      };
      await runSyntheticStopMonitor("local", haltedPolicy, true);
      expect(broker.cancelled).not.toContain("prot-pcbf"); // kept — the replacement couldn't arm at the ratcheted extreme
      expect(broker.placed).toHaveLength(0);
      const rows = listBrokerProtectiveStops("SYN-HALT-PCBF", "local");
      expect(rows.some((r) => r.brokerOrderId === "prot-pcbf" && r.status === "pending_cancel")).toBe(true);
    });

    it("protectWhileHalted: a pending_cancel stop OVERSIZED vs the UNCOVERED remainder (stacked on another exit) is right-sized even if the position didn't shrink (Codex PR #1738)", async () => {
      // Position is still 100 shares, but another live sell already covers 60, so a pending 100-share
      // stop is oversized relative to the 40 UNCOVERED shares and would over-sell if both fire. The
      // oversized test compares to desiredStopQuantity (uncovered), not the whole position, so the
      // stacked stop is retried + right-sized to 40.
      connectTestAccount("SYN-HALT-STACK", "paper", "alpaca");
      broker.positions = [{ symbol: "NVDA", quantity: 100, averageCost: 100, marketValue: 10000 }]; // NOT shrunk
      broker.quotes = { NVDA: { price: 100 } };
      broker.orders = [
        { id: "prot-stack", symbol: "NVDA", side: "sell", type: "stop_market", state: "queued", quantity: 100 },
        { id: "other-sell", symbol: "NVDA", side: "sell", type: "limit", state: "open", quantity: 60 } // covers 60 of 100
      ];
      upsertBrokerProtectiveStop({
        id: "protstop-local-SYN-HALT-STACK-NVDA", userId: "local", accountNumber: "SYN-HALT-STACK",
        symbol: "NVDA", brokerOrderId: "prot-stack", quantity: 100, stopPrice: 95, status: "pending_cancel",
        kind: "trailing", trailPercent: 5
      });
      const haltedPolicy = {
        ...policyFor("SYN-HALT-STACK"),
        activeBroker: "alpaca" as const,
        systemState: "halted" as const,
        riskRules: { ...policyFor("SYN-HALT-STACK").riskRules, trailingStopPct: 5, protectWhileHalted: true }
      };
      await runSyntheticStopMonitor("local", haltedPolicy, true);
      expect(broker.cancelled).toContain("prot-stack"); // stacked (oversized-vs-uncovered) stop removed
      expect(broker.placed).toHaveLength(1);
      expect(broker.placed[0]).toMatchObject({ side: "sell", quantity: 40 }); // right-sized to the 40 uncovered shares
      const rows = listBrokerProtectiveStops("SYN-HALT-STACK", "local");
      expect(rows).toHaveLength(1);
      expect(rows[0].quantity).toBe(40);
    });

    it("protectWhileHalted: does NOT place a spurious replacement when the pending_cancel 'cancel' only recovers an already-dead order (Codex PR #1738)", async () => {
      // The cancel call throws, but the order is found already terminal (canceled, no fill) — the catch
      // path recovers by deleting the stale row. Because the right-size marker is only set AFTER a
      // SUCCESSFUL cancel, no live order was reduced, so section 4 must NOT place a replacement (that
      // would initiate NEW broker protection during the halt).
      connectTestAccount("SYN-HALT-DEADRECOVER", "paper", "alpaca");
      broker.positions = [{ symbol: "NVDA", quantity: 40, averageCost: 100, marketValue: 4000 }]; // shrank -> oversized pending row
      broker.quotes = { NVDA: { price: 100 } };
      broker.orders = [{ id: "prot-dead", symbol: "NVDA", side: "sell", type: "stop_market", state: "canceled", quantity: 100 }]; // already terminal, no fill
      broker.cancelError = new Error("order not found");
      upsertBrokerProtectiveStop({
        id: "protstop-local-SYN-HALT-DEADRECOVER-NVDA", userId: "local", accountNumber: "SYN-HALT-DEADRECOVER",
        symbol: "NVDA", brokerOrderId: "prot-dead", quantity: 100, stopPrice: 95, status: "pending_cancel",
        kind: "trailing", trailPercent: 5
      });
      const haltedPolicy = {
        ...policyFor("SYN-HALT-DEADRECOVER"),
        activeBroker: "alpaca" as const,
        systemState: "halted" as const,
        riskRules: { ...policyFor("SYN-HALT-DEADRECOVER").riskRules, trailingStopPct: 5, protectWhileHalted: true }
      };
      try {
        await runSyntheticStopMonitor("local", haltedPolicy, true);
        expect(broker.placed).toHaveLength(0); // no spurious replacement — nothing live was reduced
        expect(listBrokerProtectiveStops("SYN-HALT-DEADRECOVER", "local")).toHaveLength(0); // stale row recovered/deleted
      } finally {
        broker.cancelError = null;
      }
    });
  });
});
