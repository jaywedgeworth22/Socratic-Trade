/**
 * Regression for the `order-role.ts` / `order-role-context.ts` split (PR #3755 build fix):
 * `app/console/orders/page.tsx` (a "use client" component) reads `order.role`/`order.whyResting`
 * straight off the orders array `GET /api/dashboard` returns — it never classifies orders itself.
 * This asserts the SERVER side of that contract: `getDashboardSnapshot` (the function
 * `app/api/dashboard/route.ts` wraps in `NextResponse.json`) actually attaches `role`/`whyResting`
 * to a working order via `order-role-context.ts`'s `attachOrderRoles`, so the client never has to
 * (and, after the split, structurally CAN'T — that module has zero DB imports).
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// Keep the snapshot's best-effort macro / market-signal / benchmark fan-out off the network so the
// test is fast and deterministic; none of it touches order-role classification under test.
vi.mock("../src/lib/macro", () => ({
  fetchMacroData: vi.fn(async () => ({})),
  determineMarketRegime: vi.fn(() => "Unknown")
}));
vi.mock("../src/lib/macro-metrics", () => ({ deriveMacroMetrics: vi.fn(() => ({})) }));
vi.mock("../src/lib/macro-history", () => ({ fetchMacroHistory: vi.fn(async () => ({})) }));
vi.mock("../src/lib/market-signals", () => ({ getMarketSignals: vi.fn(async () => ({})) }));
vi.mock("../src/lib/market-signals/massive", () => ({ fetchMassiveNews: vi.fn(async () => []) }));
vi.mock("../src/lib/market-internals", () => ({ computeMarketInternals: vi.fn(() => ({ medianEarnYld: undefined })) }));
vi.mock("../src/lib/benchmark", () => ({
  computeSpyBenchmark: vi.fn(async () => null),
  computeSpyBenchmarkDetailed: vi.fn(async () => ({ comparison: null }))
}));
vi.mock("../src/lib/web-sources", () => ({
  getCongressDataset: vi.fn(() => undefined),
  getInsiderDataset: vi.fn(() => undefined),
  getWebSourcesStatus: vi.fn(() => ({}))
}));

// One working, app-managed protective-stop order (protstop- client_order_id prefix — classifies
// deterministically via order-role.ts's prefix fallback, no broker_protective_stops row needed)
// plus one terminal (filled) order, so both "gets a role" and "terminal orders don't" are covered
// from a single mocked broker order list.
vi.mock("../src/lib/broker", () => ({
  getBrokerGateway: vi.fn(() => ({
    async getAccounts() {
      return [{ accountNumber: "TEST", label: "Test", agenticAllowed: true }];
    },
    async getPortfolio() {
      return { accountNumber: "TEST", totalMarketValue: 1000, buyingPower: 1000, equityMarketValue: 0, optionMarketValue: 0, cash: 1000 };
    },
    async getEquityPositions() {
      return [];
    },
    async getEquityOrders() {
      return [
        {
          id: "role-order-1",
          symbol: "BAC",
          side: "sell",
          type: "stop_market",
          state: "new",
          quantity: 24,
          clientOrderId: "protstop-order-role-test-1",
          createdAt: new Date().toISOString()
        },
        {
          id: "role-order-filled-1",
          symbol: "KO",
          side: "buy",
          type: "market",
          state: "filled",
          quantity: 5,
          filledQuantity: 5,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }
      ];
    },
    async getEquityQuotes() {
      return {};
    }
  }))
}));

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-dash-order-role-${randomUUID()}.db`)}`;
});

afterEach(async () => {
  const { resetDashboardSnapshotCacheForTests } = await import("../src/lib/dashboard-snapshot-cache");
  resetDashboardSnapshotCacheForTests();
});

describe("getDashboardSnapshot attaches order roles (the GET /api/dashboard contract)", () => {
  it("attaches role + whyResting to a working app-managed protective-stop order", async () => {
    const db = await import("../src/lib/db");
    const { getDashboardSnapshot } = await import("../src/lib/dashboard");

    const userId = `dash-order-role-${randomUUID()}`;
    db.upsertConnectedAccount({
      id: `acct-${userId}`,
      userId,
      broker: "test",
      environment: "paper",
      accountNumber: "TEST",
      label: "Order Role Snapshot Account",
      isActive: true
    });

    const snapshot = await getDashboardSnapshot(userId);
    const order = snapshot.orders.find((o) => o.id === "role-order-1");

    // The classifier's protstop- client_order_id prefix fallback (order-role.ts) fires without
    // needing a broker_protective_stops row, so this is deterministic from the mocked order alone.
    expect(order?.role).toBe("protective_stop");
    expect(order?.whyResting).toBe("Protective stop for 24 BAC; rests until it fills at the broker.");
  });

  it("leaves a terminal (filled) order without a role — classification is working-orders only", async () => {
    const db = await import("../src/lib/db");
    const { getDashboardSnapshot } = await import("../src/lib/dashboard");

    const userId = `dash-order-role-terminal-${randomUUID()}`;
    db.upsertConnectedAccount({
      id: `acct-${userId}`,
      userId,
      broker: "test",
      environment: "paper",
      accountNumber: "TEST",
      label: "Order Role Terminal Account",
      isActive: true
    });

    const snapshot = await getDashboardSnapshot(userId);
    const filled = snapshot.orders.find((o) => o.id === "role-order-filled-1");
    expect(filled?.role).toBeUndefined();
  });
});
