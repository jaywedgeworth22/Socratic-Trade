// Regression: #3385 leftover from #3383.  Three plan-purge paths ran deleteSyntheticStop and
// non-idempotent audit() inside one sqliteYieldRetry callback.  A SQLITE_BUSY on the audit
// insert retried the delete+audit envelope and could duplicate synthetic_stop_purged_by_plan.
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_POLICY } from "../src/lib/defaults";
import type { ConnectedAccount, TradingPolicy } from "../src/lib/types";

const state = vi.hoisted(() => ({
  deleteCalls: 0,
  purgeAuditCalls: 0,
  purgeAuditBusyThrows: 0
}));

const broker = vi.hoisted(() => ({
  positions: [] as Array<{ symbol: string; quantity: number; averageCost: number; marketValue: number }>,
  quotes: {} as Record<string, { price?: number }>
}));

vi.mock("../src/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/db")>();
  return {
    ...actual,
    deleteSyntheticStop: (id: string, userId: string) => {
      state.deleteCalls += 1;
      return actual.deleteSyntheticStop(id, userId);
    },
    audit: (kind: string, payload: unknown, userId?: string, accountId?: string) => {
      if (kind === "synthetic_stop_purged_by_plan") {
        state.purgeAuditCalls += 1;
        if (state.purgeAuditBusyThrows > 0) {
          state.purgeAuditBusyThrows -= 1;
          throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
        }
      }
      return actual.audit(kind, payload, userId, accountId);
    }
  };
});

vi.mock("../src/lib/broker", () => ({
  getBrokerGateway: () => ({
    getPortfolio: async () => ({
      accountNumber: "TEST",
      totalMarketValue: 10000,
      buyingPower: 5000,
      equityMarketValue: 10000,
      optionMarketValue: 0,
      cash: 5000
    }),
    getEquityPositions: async () => broker.positions,
    getEquityOrders: async () => [],
    getEquityQuotes: async () => broker.quotes,
    getEquityTradability: async (_accountNumber: string, symbols: string[]) =>
      Object.fromEntries(symbols.map((symbol) => [symbol, { tradable: true, fractional: true }])),
    placeEquityOrder: async () => ({ orderId: "ord-1", refId: "ref-1", state: "accepted", raw: {} }),
    cancelEquityOrder: async () => ({ orderId: "x", refId: "x", state: "cancel_requested", raw: {} })
  })
}));

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-synth-purge-busy-${randomUUID()}.db`)}`;
});

afterEach(() => {
  vi.useRealTimers();
});

function policyFor(account: string, symbol: string, trailPct = 5): TradingPolicy {
  return {
    ...DEFAULT_POLICY,
    accountNumber: account,
    connectedAccountId: `acct-${account}`,
    activeBroker: "test",
    systemState: "active",
    shortSellingEnabled: true,
    additionalSymbols: [symbol],
    riskRules: { ...DEFAULT_POLICY.riskRules, trailingStopPct: trailPct }
  };
}

async function connectTestAccount(accountNumber: string): Promise<void> {
  const { upsertConnectedAccount } = await import("../src/lib/db");
  upsertConnectedAccount({
    id: `acct-${accountNumber}`,
    userId: "local",
    broker: "test" as ConnectedAccount["broker"],
    environment: "paper",
    accountNumber,
    label: accountNumber,
    isActive: true
  });
}

function purgeReceipts(
  getDb: () => ReturnType<typeof import("../src/lib/db")["getDb"]>,
  symbol: string
): Array<Record<string, unknown>> {
  const rows = getDb()
    .prepare("SELECT payload FROM audit_events WHERE kind = ? ORDER BY created_at ASC")
    .all("synthetic_stop_purged_by_plan") as Array<{ payload: string }>;
  return rows
    .map((r) => JSON.parse(r.payload) as Record<string, unknown>)
    .filter((p) => p.symbol === symbol);
}

describe("plan-purge delete/audit split (#3385)", () => {
  beforeEach(() => {
    broker.positions = [];
    broker.quotes = {};
    state.deleteCalls = 0;
    state.purgeAuditCalls = 0;
    state.purgeAuditBusyThrows = 0;
  });

  it("a 'none' plan: BUSY on audit after delete does not re-delete or double-audit", async () => {
    const db = await import("../src/lib/db");
    const { runSyntheticStopMonitor } = await import("../src/lib/synthetic-stops");
    const account = "SYN-PURGE-NONE-BUSY";
    const symbol = "NONEQ";
    await connectTestAccount(account);
    db.upsertSyntheticStop({
      id: `synstop-local-${account}-${symbol}`,
      userId: "local",
      accountNumber: account,
      symbol,
      side: "long",
      quantity: 10,
      entryPrice: 100,
      extremePrice: 100,
      trailPercent: 5,
      status: "active"
    });
    db.recordStopPlan(account, symbol, "none", "no stop wanted", 100, "local");
    broker.positions = [{ symbol, quantity: 10, averageCost: 100, marketValue: 1000 }];
    broker.quotes = { [symbol]: { price: 100 } };
    state.purgeAuditBusyThrows = 1;

    await runSyntheticStopMonitor("local", policyFor(account, symbol), true);

    expect(db.listSyntheticStops(account, "local")).toHaveLength(0);
    expect(state.deleteCalls).toBe(1);
    expect(state.purgeAuditCalls).toBe(2);
    expect(purgeReceipts(db.getDb, symbol)).toHaveLength(1);
  });

  it("a fixed-kind row: BUSY on audit after delete does not re-delete or double-audit", async () => {
    const db = await import("../src/lib/db");
    const { runSyntheticStopMonitor } = await import("../src/lib/synthetic-stops");
    const account = "SYN-PURGE-FIXED-BUSY";
    const symbol = "FIXDQ";
    await connectTestAccount(account);
    db.upsertSyntheticStop({
      id: `synstop-local-${account}-${symbol}`,
      userId: "local",
      accountNumber: account,
      symbol,
      side: "long",
      quantity: 10,
      entryPrice: 100,
      extremePrice: 100,
      trailPercent: 8,
      status: "active",
      kind: "fixed"
    });
    db.recordStopPlan(account, symbol, "trailing", undefined, 100, "local");
    broker.positions = [{ symbol, quantity: 10, averageCost: 100, marketValue: 1000 }];
    broker.quotes = { [symbol]: { price: 100 } };
    state.purgeAuditBusyThrows = 1;

    await runSyntheticStopMonitor("local", policyFor(account, symbol, 0), true);

    expect(db.listSyntheticStops(account, "local").filter((s) => s.kind === "fixed")).toHaveLength(0);
    expect(state.deleteCalls).toBe(1);
    expect(state.purgeAuditCalls).toBe(2);
    expect(purgeReceipts(db.getDb, symbol)).toHaveLength(1);
  });

  it("a trailing row excluded by a 'fixed' plan: BUSY on audit after delete does not double-audit", async () => {
    const db = await import("../src/lib/db");
    const { runSyntheticStopMonitor } = await import("../src/lib/synthetic-stops");
    const account = "SYN-PURGE-TRAIL-BUSY";
    const symbol = "TRAIQ";
    await connectTestAccount(account);
    db.upsertSyntheticStop({
      id: `synstop-local-${account}-${symbol}`,
      userId: "local",
      accountNumber: account,
      symbol,
      side: "long",
      quantity: 10,
      entryPrice: 100,
      extremePrice: 100,
      trailPercent: 5,
      status: "active",
      kind: "trailing"
    });
    db.recordStopPlan(account, symbol, "fixed", undefined, 100, "local");
    broker.positions = [{ symbol, quantity: 10, averageCost: 100, marketValue: 1000 }];
    broker.quotes = { [symbol]: { price: 100 } };
    state.purgeAuditBusyThrows = 1;

    await runSyntheticStopMonitor("local", policyFor(account, symbol, 0), true);

    expect(db.listSyntheticStops(account, "local").filter((s) => (s.kind ?? "trailing") === "trailing")).toHaveLength(0);
    expect(state.deleteCalls).toBe(1);
    expect(state.purgeAuditCalls).toBe(2);
    expect(purgeReceipts(db.getDb, symbol)).toHaveLength(1);
  });
});
