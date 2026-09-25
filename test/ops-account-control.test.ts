/**
 * POST /api/ops/account-control — ops-token account control for an EXPLICIT connected account.
 *
 * The broker is mocked per account number (like test/mobile-order-cancel.test.ts) so account
 * scoping is observable: every read and cancel records which account it was resolved for.  Each
 * test seeds one user with TWO connected accounts — "selected" (isActive, what the console acts
 * on) and "named" (not selected, the one the ops call names) — and proves the ops route touches
 * only the named one.
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrokerageAccount, EquityOrder, ExecutedOrder, TradingPolicy } from "../src/lib/types";

beforeAll(async () => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-ops-account-control-${randomUUID()}.db`)}`;
  // Warm the route's import graph once so the first test's time budget is not spent on a cold
  // module load (seconds on CI, much longer on a loaded shared dev box).
  await import("../app/api/ops/account-control/route");
  await import("../src/lib/db");
}, 300_000);

const OPS_TOKEN = "ops-account-control-test-token";

const broker = vi.hoisted(() => ({
  /** accountNumber -> that account's order book. Nothing crosses between entries. */
  books: new Map<string, unknown[]>(),
  /** accountNumber -> the account list that broker login reports. */
  accounts: new Map<string, unknown[]>(),
  /** Accounts whose broker READS fail. */
  readThrows: new Set<string>(),
  reads: [] as Array<{ accountNumber: string; method: string }>,
  cancelCalls: [] as Array<{ accountNumber: string; orderId: string }>,
  placeCalls: 0,
  /** Runs inside getAccounts, i.e. while the ops route is awaiting the broker. */
  onGetAccounts: undefined as undefined | (() => void)
}));

vi.mock("../src/lib/broker", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/broker")>();
  return {
    ...actual,
    getBrokerGateway: (policy: TradingPolicy) => {
      const accountNumber = policy.accountNumber ?? "";
      const read = (method: string) => {
        broker.reads.push({ accountNumber, method });
        if (broker.readThrows.has(accountNumber)) throw new Error(`broker unreachable for ${accountNumber}`);
      };
      return {
        getAccounts: async () => {
          read("getAccounts");
          broker.onGetAccounts?.();
          return broker.accounts.get(accountNumber) ?? [{ accountNumber, label: "acct", agenticAllowed: true }];
        },
        getPortfolio: async () => {
          read("getPortfolio");
          return { accountNumber, totalMarketValue: 1000, buyingPower: 1000, equityMarketValue: 0, optionMarketValue: 0, cash: 1000 };
        },
        getEquityOrders: async () => {
          read("getEquityOrders");
          return broker.books.get(accountNumber) ?? [];
        },
        getEquityPositions: async () => {
          read("getEquityPositions");
          return [];
        },
        getEquityQuotes: async () => ({}),
        getEquityTradability: async (_acc: string, symbols: string[]) =>
          Object.fromEntries(symbols.map((s) => [s, { tradable: true, fractional: true }])),
        reviewEquityOrder: async () => ({ estimatedNotional: 0, alerts: [], raw: {} }),
        placeEquityOrder: async () => {
          broker.placeCalls += 1;
          throw new Error("placement must never happen on an ops account-control path");
        },
        cancelEquityOrder: async (acct: string, orderId: string): Promise<ExecutedOrder> => {
          broker.cancelCalls.push({ accountNumber: acct, orderId });
          return { orderId, refId: randomUUID(), state: "canceled", raw: { account: acct, secret: "raw-broker-body" } };
        }
      };
    }
  };
});

function order(id: string, symbol: string, state = "open", extra: Partial<EquityOrder> = {}): EquityOrder {
  return {
    id,
    symbol,
    side: "buy",
    type: "limit",
    state,
    quantity: 10,
    filledQuantity: 0,
    limitPrice: 100,
    timeInForce: "day",
    createdAt: "2026-09-24T14:00:00.000Z",
    ...extra
  };
}

interface Seeded {
  userId: string;
  selectedId: string;
  selectedAccountNumber: string;
  namedId: string;
  namedAccountNumber: string;
}

async function seed(opts: { namedOrders?: EquityOrder[]; selectedOrders?: EquityOrder[]; namedPolicy?: Partial<TradingPolicy> } = {}): Promise<Seeded> {
  const { upsertConnectedAccount, setPolicy, getPolicy } = await import("../src/lib/db");
  const { DEFAULT_POLICY } = await import("../src/lib/defaults");
  const userId = `ops-control-${randomUUID()}`;
  const selectedId = randomUUID();
  const namedId = randomUUID();
  const selectedAccountNumber = `SEL${randomUUID().slice(0, 8)}`;
  const namedAccountNumber = `VA${randomUUID().replace(/-/g, "").slice(0, 8)}`;
  upsertConnectedAccount({
    id: namedId,
    userId,
    broker: "tradier",
    environment: "paper",
    accountNumber: namedAccountNumber,
    label: "Tradier Sandbox",
    apiKey: "named-api-key-value",
    isActive: false
  });
  // Upserted second with isActive: true so it is the console's selected account.
  upsertConnectedAccount({
    id: selectedId,
    userId,
    broker: "alpaca",
    environment: "paper",
    accountNumber: selectedAccountNumber,
    label: "Alpaca Paper",
    apiKey: "selected-api-key-value",
    apiSecret: "selected-api-secret-value",
    isActive: true
  });
  setPolicy({ ...DEFAULT_POLICY, systemState: "active" }, userId, selectedId);
  const namedBase = getPolicy(userId, namedId);
  setPolicy({ ...namedBase, systemState: "halted", ...(opts.namedPolicy ?? {}) }, userId, namedId);
  broker.books.set(namedAccountNumber, opts.namedOrders ?? []);
  broker.books.set(selectedAccountNumber, opts.selectedOrders ?? []);
  return { userId, selectedId, selectedAccountNumber, namedId, namedAccountNumber };
}

// Response bodies are loosely typed JSON; tests assert on their shape directly.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

async function call(body: unknown, headers: Record<string, string> = { "x-ops-token": OPS_TOKEN }) {
  const { POST } = await import("../app/api/ops/account-control/route");
  const response = await POST(
    new Request("http://localhost/api/ops/account-control", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body)
    })
  );
  return { status: response.status, body: (await response.json()) as Json };
}

async function auditRows(userId: string): Promise<Array<{ kind: string; payload: Json; connectedAccountId: string | null }>> {
  const { getDb } = await import("../src/lib/db");
  return (
    getDb()
      .prepare("SELECT kind, payload, connected_account_id FROM audit_events WHERE user_id = ? ORDER BY rowid ASC")
      .all(userId) as Array<{ kind: string; payload: string; connected_account_id: string | null }>
  ).map((row) => ({ kind: row.kind, payload: JSON.parse(row.payload), connectedAccountId: row.connected_account_id }));
}

beforeEach(() => {
  process.env.OPS_DIAGNOSTIC_TOKEN = OPS_TOKEN;
  broker.cancelCalls.length = 0;
  broker.reads.length = 0;
  broker.readThrows.clear();
  broker.accounts.clear();
  broker.placeCalls = 0;
  broker.onGetAccounts = undefined;
});

describe("POST /api/ops/account-control — auth and validation", () => {
  it("rejects a missing or wrong ops token before touching the broker or the database", async () => {
    const seeded = await seed({ namedOrders: [order("o-1", "AAPL")] });
    for (const headers of [{}, { "x-ops-token": "wrong-token" }, { authorization: "Bearer nope" }]) {
      const res = await call(
        { action: "cancel_working_orders", connectedAccountId: seeded.namedId },
        headers as Record<string, string>
      );
      expect(res.status).toBe(401);
      expect(res.body.ok).toBe(false);
    }
    expect(broker.reads).toEqual([]);
    expect(broker.cancelCalls).toEqual([]);
    expect((await auditRows(seeded.userId)).some((row) => row.kind === "ops_account_control")).toBe(false);
  });

  it("refuses every request when OPS_DIAGNOSTIC_TOKEN is not configured", async () => {
    delete process.env.OPS_DIAGNOSTIC_TOKEN;
    const res = await call({ action: "list_working_orders", connectedAccountId: "x" }, { "x-ops-token": "" });
    expect(res.status).toBe(401);
  });

  it("validates action, connectedAccountId, systemState, orderIds and dryRun", async () => {
    expect((await call({ action: "sell_everything", connectedAccountId: "x" })).status).toBe(400);
    expect((await call({ action: "list_working_orders" })).status).toBe(400);
    expect((await call({ action: "set_system_state", connectedAccountId: "x" })).status).toBe(400);
    expect((await call({ action: "set_system_state", connectedAccountId: "x", systemState: "liquidating" })).status).toBe(400);
    expect((await call({ action: "cancel_working_orders", connectedAccountId: "x", orderIds: [] })).status).toBe(400);
    expect((await call({ action: "cancel_working_orders", connectedAccountId: "x", orderIds: [42] })).status).toBe(400);
    expect((await call({ action: "cancel_working_orders", connectedAccountId: "x", dryRun: "yes" })).status).toBe(400);
    expect((await call("{not json")).status).toBe(400);
    expect((await call({ action: "list_working_orders", connectedAccountId: "x", pad: "x".repeat(20_000) })).status).toBe(413);
    expect(broker.reads).toEqual([]);
  });

  it("returns 404 for an unknown connected account", async () => {
    const res = await call({ action: "list_working_orders", connectedAccountId: randomUUID() });
    expect(res.status).toBe(404);
    expect(broker.reads).toEqual([]);
  });
});

describe("list_working_orders", () => {
  it("lists only the NAMED account's working orders, masked, with no secrets or raw broker bodies", async () => {
    const seeded = await seed({
      namedOrders: [
        order("n-1", "AAPL", "open", { stopPrice: undefined }),
        order("n-2", "MSFT", "pending", { side: "sell", type: "stop_market", stopPrice: 90, limitPrice: undefined, timeInForce: "gtc" }),
        order("n-3", "TSLA", "filled")
      ],
      selectedOrders: [order("s-1", "NVDA")]
    });
    const res = await call({ action: "list_working_orders", connectedAccountId: seeded.namedId });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.account.connectedAccountId).toBe(seeded.namedId);
    expect(res.body.account.isSelectedInConsole).toBe(false);
    expect(res.body.workingOrders.map((o: { orderId: string }) => o.orderId)).toEqual(["n-1", "n-2"]);
    expect(res.body.workingOrders[1]).toMatchObject({
      orderId: "n-2",
      symbol: "MSFT",
      side: "sell",
      type: "stop_market",
      quantity: 10,
      filledQuantity: 0,
      stopPrice: 90,
      timeInForce: "gtc",
      state: "pending",
      createdAt: "2026-09-24T14:00:00.000Z"
    });
    // Every broker read was for the named account.
    expect(new Set(broker.reads.map((r) => r.accountNumber))).toEqual(new Set([seeded.namedAccountNumber]));
    const text = JSON.stringify(res.body);
    expect(text).not.toContain(seeded.namedAccountNumber);
    expect(text).not.toContain(seeded.selectedAccountNumber);
    expect(text).toContain(seeded.namedAccountNumber.slice(-4));
    expect(text).not.toMatch(/api-key-value|api-secret-value|raw-broker-body/);
    expect(broker.cancelCalls).toEqual([]);
  });
});

describe("cancel_working_orders", () => {
  it("dryRun reports what would be cancelled and makes NO broker mutation and no policy change", async () => {
    const seeded = await seed({ namedOrders: [order("n-1", "AAPL"), order("n-2", "MSFT")] });
    const { getPolicy } = await import("../src/lib/db");
    const before = getPolicy(seeded.userId, seeded.namedId);
    const res = await call({ action: "cancel_working_orders", connectedAccountId: seeded.namedId, dryRun: true });
    expect(res.status).toBe(200);
    expect(res.body.dryRun).toBe(true);
    expect(res.body.results.map((r: { orderId: string; wouldCancel: boolean }) => [r.orderId, r.wouldCancel])).toEqual([
      ["n-1", true],
      ["n-2", true]
    ]);
    expect(broker.cancelCalls).toEqual([]);
    expect(broker.placeCalls).toBe(0);
    // Only read-only broker methods were used.
    expect(broker.reads.every((r) => ["getEquityOrders", "getEquityPositions", "getAccounts", "getPortfolio"].includes(r.method))).toBe(true);
    expect(getPolicy(seeded.userId, seeded.namedId).systemState).toBe(before.systemState);
    const kinds = (await auditRows(seeded.userId)).map((row) => row.kind);
    expect(kinds).not.toContain("order_cancel");
    expect(kinds).toContain("ops_account_control");
  });

  it("cancels every working order of the NAMED account (not the selected one) through the console's cancel path", async () => {
    const seeded = await seed({
      namedOrders: [order("n-1", "AAPL"), order("n-2", "MSFT", "partially_filled"), order("n-3", "TSLA", "filled")],
      selectedOrders: [order("s-1", "NVDA")]
    });
    const res = await call({ action: "cancel_working_orders", connectedAccountId: seeded.namedId });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.summary).toMatchObject({ requested: 2, cancelled: 2, failed: 0, skipped: 0 });
    expect(broker.cancelCalls).toEqual([
      { accountNumber: seeded.namedAccountNumber, orderId: "n-1" },
      { accountNumber: seeded.namedAccountNumber, orderId: "n-2" }
    ]);
    // The selected account was never read or touched.
    expect(broker.reads.some((r) => r.accountNumber === seeded.selectedAccountNumber)).toBe(false);
    expect(JSON.stringify(res.body)).not.toMatch(/raw-broker-body/);
    expect(JSON.stringify(res.body)).not.toContain(seeded.namedAccountNumber);

    const rows = await auditRows(seeded.userId);
    const cancels = rows.filter((row) => row.kind === "order_cancel");
    expect(cancels).toHaveLength(2);
    for (const row of cancels) {
      expect(row.payload.source).toBe("ops");
      expect(row.payload.accountNumber).toBe(seeded.namedAccountNumber);
      expect(row.connectedAccountId).toBe(seeded.namedId);
    }
    const opsRow = rows.find((row) => row.kind === "ops_account_control");
    expect(opsRow?.payload).toMatchObject({ action: "cancel_working_orders", dryRun: false, actor: "ops-token" });
    expect(opsRow?.connectedAccountId).toBe(seeded.namedId);
    expect(opsRow?.payload.results).toHaveLength(2);
  });

  it("cancels only the requested subset and refuses an order id that is not working in the named account", async () => {
    const seeded = await seed({
      namedOrders: [order("n-1", "AAPL"), order("n-2", "MSFT")],
      selectedOrders: [order("s-1", "NVDA")]
    });
    const res = await call({
      action: "cancel_working_orders",
      connectedAccountId: seeded.namedId,
      orderIds: ["n-2", "s-1", "n-2"]
    });
    expect(res.status).toBe(200);
    expect(broker.cancelCalls).toEqual([{ accountNumber: seeded.namedAccountNumber, orderId: "n-2" }]);
    const byId = Object.fromEntries(res.body.results.map((r: { orderId: string }) => [r.orderId, r]));
    expect(byId["n-2"].ok).toBe(true);
    expect(byId["s-1"]).toMatchObject({ ok: false, skipped: true });
    expect(res.body.summary).toMatchObject({ requested: 2, cancelled: 1, skipped: 1 });
  });

  it("fails closed (no cancel) when the named account's order book cannot be read and no ids were given", async () => {
    const seeded = await seed({ namedOrders: [order("n-1", "AAPL")] });
    broker.readThrows.add(seeded.namedAccountNumber);
    const res = await call({ action: "cancel_working_orders", connectedAccountId: seeded.namedId });
    expect(res.status).toBe(502);
    expect(res.body.ok).toBe(false);
    expect(broker.cancelCalls).toEqual([]);
    // The broker's error text carried the full account number; the response must not.
    expect(JSON.stringify(res.body)).not.toContain(seeded.namedAccountNumber);
  });
});

describe("set_system_state", () => {
  it("active runs the console enable checks against the NAMED account: empty universe is refused with the same message", async () => {
    const seeded = await seed({ namedPolicy: { includedIndices: [], additionalSymbols: [] } });
    const res = await call({ action: "set_system_state", connectedAccountId: seeded.namedId, systemState: "active" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Select at least one base index or additional watchlist symbol before enabling autonomy.");
    const { getPolicy } = await import("../src/lib/db");
    expect(getPolicy(seeded.userId, seeded.namedId).systemState).toBe("halted");
  });

  it("active refuses an unreachable broker and a non-agentic account with the console's messages", async () => {
    const seeded = await seed();
    broker.readThrows.add(seeded.namedAccountNumber);
    const unreachable = await call({ action: "set_system_state", connectedAccountId: seeded.namedId, systemState: "active" });
    expect(unreachable.status).toBe(400);
    expect(unreachable.body.error).toMatch(/^Selected broker account is not reachable: /);
    expect(JSON.stringify(unreachable.body)).not.toContain(seeded.namedAccountNumber);

    broker.readThrows.clear();
    broker.accounts.set(seeded.namedAccountNumber, [{ accountNumber: seeded.namedAccountNumber, label: "x", agenticAllowed: false } satisfies BrokerageAccount]);
    const notAgentic = await call({ action: "set_system_state", connectedAccountId: seeded.namedId, systemState: "active" });
    expect(notAgentic.status).toBe(400);
    expect(notAgentic.body.error).toBe("Selected account is not agentic_allowed.");

    broker.accounts.set(seeded.namedAccountNumber, [{ accountNumber: "SOMEONE-ELSE", label: "x", agenticAllowed: true }]);
    const missing = await call({ action: "set_system_state", connectedAccountId: seeded.namedId, systemState: "active" });
    expect(missing.status).toBe(400);
    expect(missing.body.error).toBe("Selected account is not available.");

    const { getPolicy } = await import("../src/lib/db");
    expect(getPolicy(seeded.userId, seeded.namedId).systemState).toBe("halted");
  });

  it("active arms ONLY the named account, leaves the console selection alone, and says when the scheduler will run it", async () => {
    const seeded = await seed();
    const { getPolicy, listConnectedAccounts } = await import("../src/lib/db");
    const { setPolicy } = await import("../src/lib/db");
    const selectedBefore = getPolicy(seeded.userId, seeded.selectedId);
    setPolicy({ ...selectedBefore, systemState: "close_only" }, seeded.userId, seeded.selectedId);

    const res = await call({ action: "set_system_state", connectedAccountId: seeded.namedId, systemState: "active" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.previousSystemState).toBe("halted");
    expect(res.body.systemState).toBe("active");
    expect(getPolicy(seeded.userId, seeded.namedId).systemState).toBe("active");
    // The selected account's state and the console selection are untouched.
    expect(getPolicy(seeded.userId, seeded.selectedId).systemState).toBe("close_only");
    const accounts = listConnectedAccounts(seeded.userId);
    expect(accounts.find((a) => a.id === seeded.selectedId)?.isActive).toBe(true);
    expect(accounts.find((a) => a.id === seeded.namedId)?.isActive).toBe(false);
    // The scheduler contract is stated explicitly.
    expect(res.body.nextEligibleRun).toBeDefined();
    expect(typeof res.body.nextEligibleRun.reason).toBe("string");
    expect(res.body.nextEligibleRun.reason.length).toBeGreaterThan(10);
    expect(res.body.nextEligibleRun.notes.join(" ")).toMatch(/isActive/);
    expect(broker.reads.some((r) => r.accountNumber === seeded.selectedAccountNumber)).toBe(false);

    const opsRow = (await auditRows(seeded.userId)).find((row) => row.kind === "ops_account_control");
    expect(opsRow?.payload).toMatchObject({ action: "set_system_state", dryRun: false, actor: "ops-token", from: "halted", to: "active" });
    expect(opsRow?.connectedAccountId).toBe(seeded.namedId);
  });

  it("does not overwrite a console edit made while the broker check was in flight", async () => {
    const seeded = await seed();
    const { getPolicy, setPolicy } = await import("../src/lib/db");
    broker.onGetAccounts = () => {
      broker.onGetAccounts = undefined;
      setPolicy({ ...getPolicy(seeded.userId, seeded.namedId), runCadenceMinutes: 17 }, seeded.userId, seeded.namedId);
    };
    const res = await call({ action: "set_system_state", connectedAccountId: seeded.namedId, systemState: "active" });
    expect(res.status).toBe(200);
    const after = getPolicy(seeded.userId, seeded.namedId);
    expect(after.systemState).toBe("active");
    expect(after.runCadenceMinutes).toBe(17);
  });

  it("refuses (409) instead of writing user-level policy when the account is removed mid-call", async () => {
    const seeded = await seed();
    const { purgeConnectedAccount, getDb } = await import("../src/lib/db");
    broker.onGetAccounts = () => {
      broker.onGetAccounts = undefined;
      purgeConnectedAccount(seeded.namedId, seeded.userId);
    };
    const before = getDb()
      .prepare("SELECT value FROM user_settings WHERE user_id = ? AND key = 'policy'")
      .get(seeded.userId) as { value: string } | undefined;
    const res = await call({ action: "set_system_state", connectedAccountId: seeded.namedId, systemState: "active" });
    expect(res.status).toBe(409);
    const after = getDb()
      .prepare("SELECT value FROM user_settings WHERE user_id = ? AND key = 'policy'")
      .get(seeded.userId) as { value: string } | undefined;
    expect(after?.value).toBe(before?.value);
  });

  it("dryRun runs the checks but changes nothing", async () => {
    const seeded = await seed();
    const res = await call({ action: "set_system_state", connectedAccountId: seeded.namedId, systemState: "active", dryRun: true });
    expect(res.status).toBe(200);
    expect(res.body.dryRun).toBe(true);
    expect(res.body.wouldChange).toBe(true);
    const { getPolicy } = await import("../src/lib/db");
    expect(getPolicy(seeded.userId, seeded.namedId).systemState).toBe("halted");
    expect(broker.cancelCalls).toEqual([]);
    expect(broker.placeCalls).toBe(0);
  });

  it("halted mirrors the console Stop (enabled:false) and clears a broker auto-pause marker so the halt sticks", async () => {
    const seeded = await seed();
    const { getPolicy, setPolicy, setInternalSetting } = await import("../src/lib/db");
    setPolicy({ ...getPolicy(seeded.userId, seeded.namedId), systemState: "active" }, seeded.userId, seeded.namedId);
    const { getBrokerPlacementPauseMarker } = await import("../src/lib/broker-health");
    setInternalSetting(`broker:placement-paused:${seeded.userId}:${seeded.namedId}`, {
      since: new Date().toISOString(),
      reason: "Tradier order capability probe failed",
      autoResume: true,
      priorState: "active"
    });
    expect(getBrokerPlacementPauseMarker(seeded.userId, seeded.namedId)).toBeDefined();

    const res = await call({ action: "set_system_state", connectedAccountId: seeded.namedId, systemState: "halted" });
    expect(res.status).toBe(200);
    const after = getPolicy(seeded.userId, seeded.namedId) as TradingPolicy & { enabled?: boolean };
    expect(after.systemState).toBe("halted");
    expect(after.enabled).toBe(false);
    expect(res.body.clearedBrokerAutoPause).toBe(true);
    expect(getBrokerPlacementPauseMarker(seeded.userId, seeded.namedId)).toBeUndefined();
    expect(getPolicy(seeded.userId, seeded.selectedId).systemState).toBe("active");
    expect(res.body.nextEligibleRun.willRun).toBe(false);
  });

  it("close_only needs no broker read and only changes the named account", async () => {
    const seeded = await seed();
    const res = await call({ action: "set_system_state", connectedAccountId: seeded.namedId, systemState: "close_only" });
    expect(res.status).toBe(200);
    const { getPolicy } = await import("../src/lib/db");
    expect(getPolicy(seeded.userId, seeded.namedId).systemState).toBe("close_only");
    expect(getPolicy(seeded.userId, seeded.selectedId).systemState).toBe("active");
    expect(broker.reads).toEqual([]);
  });
});

describe("console paths are unchanged", () => {
  it("cancelWorkingOrder without connectedAccountId still acts on the SELECTED account", async () => {
    const seeded = await seed({ namedOrders: [order("n-1", "AAPL")], selectedOrders: [order("s-1", "NVDA")] });
    const { cancelWorkingOrder } = await import("../src/lib/order-cancel");
    const result = await cancelWorkingOrder({ userId: seeded.userId, orderId: "s-1", source: "console" });
    expect(result.state).toBe("canceled");
    expect(broker.cancelCalls).toEqual([{ accountNumber: seeded.selectedAccountNumber, orderId: "s-1" }]);
    const cancelRow = (await auditRows(seeded.userId)).find((row) => row.kind === "order_cancel");
    expect(cancelRow?.payload.source).toBe("console");
    expect(cancelRow?.payload.accountNumber).toBe(seeded.selectedAccountNumber);
    // Console receipts keep their historical shape: no connected-account column.
    expect(cancelRow?.connectedAccountId).toBeNull();
  });

  it("the console mismatch guard still refuses a stale expectedAccountNumber", async () => {
    const seeded = await seed({ selectedOrders: [order("s-1", "NVDA")] });
    const { cancelWorkingOrder, OrderCancelPreconditionError } = await import("../src/lib/order-cancel");
    await expect(
      cancelWorkingOrder({ userId: seeded.userId, orderId: "s-1", expectedAccountNumber: seeded.namedAccountNumber })
    ).rejects.toBeInstanceOf(OrderCancelPreconditionError);
    expect(broker.cancelCalls).toEqual([]);
  });

  it("an explicit connectedAccountId that is not this user's is refused, never re-pointed", async () => {
    const seeded = await seed({ selectedOrders: [order("s-1", "NVDA")] });
    const other = await seed({ namedOrders: [order("n-1", "AAPL")] });
    const { cancelWorkingOrder, OrderCancelPreconditionError } = await import("../src/lib/order-cancel");
    await expect(
      cancelWorkingOrder({ userId: seeded.userId, orderId: "n-1", connectedAccountId: other.namedId, source: "ops" })
    ).rejects.toBeInstanceOf(OrderCancelPreconditionError);
    expect(broker.cancelCalls).toEqual([]);
  });
});

describe("describeNextEligibleRun", () => {
  // Wed 2026-09-23 11:00 ET (regular session) and Sat 2026-09-26 11:00 ET (closed).
  const OPEN = new Date("2026-09-23T15:00:00.000Z");
  const CLOSED = new Date("2026-09-26T15:00:00.000Z");

  async function fixture(policyPatch: Partial<TradingPolicy> = {}, accountPatch: Record<string, unknown> = {}) {
    const { DEFAULT_POLICY } = await import("../src/lib/defaults");
    const account = {
      id: randomUUID(),
      userId: `nerun-${randomUUID()}`,
      broker: "tradier",
      environment: "paper",
      accountNumber: "VA00001234",
      label: "Tradier Sandbox",
      isActive: false,
      isDraining: false,
      createdAt: OPEN.toISOString(),
      updatedAt: OPEN.toISOString(),
      ...accountPatch
    } as import("../src/lib/types").ConnectedAccount;
    const policy = {
      ...DEFAULT_POLICY,
      accountNumber: account.accountNumber,
      connectedAccountId: account.id,
      activeBroker: account.broker,
      systemState: "active",
      runCadenceMinutes: 60,
      runDuringExtendedHours: false,
      ...policyPatch
    } as TradingPolicy;
    return { account, policy };
  }

  it("is due on the next tick during the session when the account has never run", async () => {
    const { describeNextEligibleRun } = await import("../src/lib/ops-account-control");
    const { account, policy } = await fixture();
    const run = describeNextEligibleRun({ userId: account.userId, account, policy, now: OPEN, brokerHealth: { isHealthy: true } });
    expect(run.willRun).toBe(true);
    expect(run.blockers).toEqual([]);
    expect(run.at).toBe(OPEN.toISOString());
    expect(run.reason).toMatch(/^Due now/);
  });

  it("waits for the next session open while the market is closed", async () => {
    const { describeNextEligibleRun } = await import("../src/lib/ops-account-control");
    const { account, policy } = await fixture();
    const run = describeNextEligibleRun({ userId: account.userId, account, policy, now: CLOSED });
    expect(run.willRun).toBe(true);
    expect(Date.parse(run.at ?? "")).toBeGreaterThan(CLOSED.getTime());
    expect(run.reason).toMatch(/market is closed/);
    expect(run.atCentral).toMatch(/ CT$/);
  });

  it("names every blocker in the scheduler's gate order", async () => {
    const { describeNextEligibleRun } = await import("../src/lib/ops-account-control");
    const halted = await fixture({ systemState: "halted" });
    expect(describeNextEligibleRun({ userId: halted.account.userId, account: halted.account, policy: halted.policy, now: OPEN }).reason).toMatch(
      /systemState is halted/
    );
    const unhealthy = await fixture();
    const blocked = describeNextEligibleRun({
      userId: unhealthy.account.userId,
      account: unhealthy.account,
      policy: unhealthy.policy,
      now: OPEN,
      brokerHealth: { isHealthy: false, reason: "Tradier order capability probe failed" }
    });
    expect(blocked.willRun).toBe(false);
    expect(blocked.reason).toMatch(/broker health gate is failing/);
    const testBroker = await fixture({}, { broker: "test" });
    expect(
      describeNextEligibleRun({ userId: testBroker.account.userId, account: testBroker.account, policy: testBroker.policy, now: OPEN }).reason
    ).toMatch(/test-broker/);
    const eventOnly = await fixture({ triggerSettings: { enabled: true, mode: "event" } });
    const eventRun = describeNextEligibleRun({ userId: eventOnly.account.userId, account: eventOnly.account, policy: eventOnly.policy, now: OPEN });
    expect(eventRun.willRun).toBe(false);
    expect(eventRun.reason).toMatch(/event-only/);
  });

  it("warns that a deploy reverts an armed account when autoResumeOnBoot is off", async () => {
    const { describeNextEligibleRun } = await import("../src/lib/ops-account-control");
    const { account, policy } = await fixture();
    const previous = process.env.AUTONOMY_RESUME_ON_BOOT;
    delete process.env.AUTONOMY_RESUME_ON_BOOT;
    try {
      const run = describeNextEligibleRun({ userId: account.userId, account, policy, now: OPEN });
      expect(run.notes.join(" ")).toMatch(/restart or deploy reverts this account to halted/);
    } finally {
      if (previous !== undefined) process.env.AUTONOMY_RESUME_ON_BOOT = previous;
    }
  });
});
