import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { opsDiagnosticSecrets } from "../src/lib/ops-auth";
import type { EquityOrder } from "../src/lib/types";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-ops-snapshot-${randomUUID()}.db`)}`;
});

// ../src/lib/ops-snapshot (and the route that wraps it) pulls in ./db (~5k lines) plus a long
// transitive chain — a multi-second cold import solo, and much slower under full-suite/full-fleet
// CPU contention (same class of flake test/chat-orchestrator-search-knowledge.test.ts's own
// comment documents: paying that cost inside a test body charges it to whichever test happens to
// import the module first, under that test's default testTimeout). Warm both up here with an
// explicit budget so every test below is fast regardless of import order.
beforeAll(async () => {
  await import("../src/lib/ops-snapshot");
  await import("../app/api/ops/snapshot/route");
}, 120_000);

// attachOpsOrderSummaries (?orders=1 / ?ordersDetail=1) dynamic-imports ./broker; mock its one
// entry point rather than the real gateways so these tests never touch a network.
const brokerMocks = vi.hoisted(() => ({ getEquityOrders: vi.fn() }));
vi.mock("../src/lib/broker", () => ({
  getBrokerGateway: vi.fn(() => ({ getEquityOrders: brokerMocks.getEquityOrders }))
}));

describe("ops auth", () => {
  it("accepts only OPS_DIAGNOSTIC_TOKEN and never falls back to ADMIN_REINDEX_TOKEN", () => {
    process.env.OPS_DIAGNOSTIC_TOKEN = "ops-only";
    process.env.ADMIN_REINDEX_TOKEN = "legacy-admin";
    expect(opsDiagnosticSecrets()).toEqual(["ops-only"]);
    delete process.env.OPS_DIAGNOSTIC_TOKEN;
    expect(opsDiagnosticSecrets()).toEqual([]);
    delete process.env.ADMIN_REINDEX_TOKEN;
    expect(opsDiagnosticSecrets()).toEqual([]);
  });

  it("rejects a request that presents only ADMIN_REINDEX_TOKEN", async () => {
    delete process.env.OPS_DIAGNOSTIC_TOKEN;
    process.env.ADMIN_REINDEX_TOKEN = "legacy-admin";
    const { GET } = await import("../app/api/ops/snapshot/route");
    const response = await GET(
      new Request("http://localhost/api/ops/snapshot", {
        headers: { "x-ops-token": "legacy-admin", "x-admin-token": "legacy-admin" }
      })
    );
    expect(response.status).toBe(401);
    delete process.env.ADMIN_REINDEX_TOKEN;
  });
});

describe("ops diagnostic snapshot", () => {
  it("rejects requests without a token", async () => {
    const { GET } = await import("../app/api/ops/snapshot/route");
    const response = await GET(new Request("http://localhost/api/ops/snapshot"));
    expect(response.status).toBe(401);
  });

  it("returns per-account runs and audit when authorized", async () => {
    process.env.OPS_DIAGNOSTIC_TOKEN = "test-ops-token";
    const db = await import("../src/lib/db");
    const userId = `ops-user-${randomUUID()}`;
    const paperId = `paper-${randomUUID()}`;
    const rothId = `roth-${randomUUID()}`;

    db.upsertConnectedAccount({
      id: paperId,
      userId,
      broker: "alpaca",
      environment: "paper",
      accountNumber: "PAPER-1",
      label: "Alpaca Paper",
      isActive: true
    });
    db.upsertConnectedAccount({
      id: rothId,
      userId,
      broker: "alpaca",
      environment: "live",
      accountNumber: "ROTH-2",
      label: "Roth IRA",
      isActive: false
    });
    const stateBefore = db.getDb()
      .prepare("SELECT COUNT(*) AS c FROM account_strategy_state WHERE user_id = ? AND connected_account_id = ?")
      .get(userId, rothId) as { c: number };
    expect(stateBefore.c).toBe(0);

    db.setPolicy({ ...db.getPolicy(userId, paperId), systemState: "active", strategyAuthority: "decide", llmModel: "gpt-5.4-mini" }, userId, paperId);

    const runId = randomUUID();
    db.insertStrategyRun(runId, userId, rothId);
    db.finishStrategyRun(runId, "failed", "Selected account is not available.", userId);
    db.audit(
      "strategy_run",
      { runId, status: "failed", summary: "Selected account is not available.", proposals: [] },
      userId,
      rothId
    );
    db.insertProposal({
      id: randomUUID(),
      userId,
      runId,
      accountNumber: "ROTH-2",
      proposal: {
        symbol: "EXE",
        side: "buy",
        type: "market",
        dollarAmount: 4,
        timeInForce: "gfd",
        marketHours: "regular_hours",
        rationale: "Ops snapshot filled-state regression.",
        tradeThesisTag: "Value-Quality",
        entryMarketRegime: "Neutral"
      },
      decision: { approved: true, reasons: [] },
      estimatedNotional: 4,
      status: "filled",
      executionMode: "broker/live"
    });

    const { buildOpsSnapshot } = await import("../src/lib/ops-snapshot");
    const snapshot = buildOpsSnapshot({ runsPerUser: 5, auditPerUser: 5 });
    const stateAfter = db.getDb()
      .prepare("SELECT COUNT(*) AS c FROM account_strategy_state WHERE user_id = ? AND connected_account_id = ?")
      .get(userId, rothId) as { c: number };
    expect(stateAfter.c).toBe(0);
    const user = snapshot.users.find((row) => row.userId === userId);
    expect(user).toBeDefined();
    expect(user!.accounts).toHaveLength(2);
    expect(user!.accounts.find((a) => a.connectedAccountId === rothId)?.label).toBe("Roth IRA");
    const roth = user!.accounts.find((a) => a.connectedAccountId === rothId);
    expect(roth?.authorityLabel === "Autopilot" || roth?.authorityLabel === "Ask-first").toBe(true);
    expect(roth?.runStateLabel).toBeTruthy();
    expect(user!.recentRuns.some((r) => r.connectedAccountId === rothId && r.summary?.includes("not available"))).toBe(true);
    expect(user!.recentRuns.find((r) => r.id === runId)?.placedCount).toBe(1);
    expect(user!.recentAudit.some((a) => a.kind === "strategy_run" && a.accountLabel === "Roth IRA")).toBe(true);

    const { GET } = await import("../app/api/ops/snapshot/route");
    const response = await GET(
      new Request("http://localhost/api/ops/snapshot", {
        headers: { "x-ops-token": "test-ops-token" }
      })
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.users.some((u: { userId: string }) => u.userId === userId)).toBe(true);
    expect(body.roicArchive).toBeTruthy();
    expect(typeof body.roicArchive.transcriptsWithContent).toBe("number");

    delete process.env.OPS_DIAGNOSTIC_TOKEN;
  });

  // Root-cause: today's prod broker-rejection triage was blocked because this kind wasn't in
  // the ops-snapshot audit allowlist — the raw rejection body (audit()'s `reason` field, the
  // actual broker error text) never reached remote diagnostics. See OPS_AUDIT_KINDS in
  // src/lib/ops-snapshot.ts.
  it("surfaces order_rejected_by_broker audit rows (including the raw broker rejection reason) in recentAudit", async () => {
    const db = await import("../src/lib/db");
    const userId = `ops-user-${randomUUID()}`;
    const accountId = `acct-${randomUUID()}`;

    db.upsertConnectedAccount({
      id: accountId,
      userId,
      broker: "alpaca",
      environment: "live",
      accountNumber: "REJ-1",
      label: "Rejection Test",
      isActive: true
    });

    const runId = randomUUID();
    const proposalId = randomUUID();
    db.audit(
      "order_rejected_by_broker",
      { runId, proposalId, symbol: "AAPL", side: "buy", reason: "insufficient buying power" },
      userId,
      accountId
    );

    const { buildOpsSnapshot } = await import("../src/lib/ops-snapshot");
    const snapshot = buildOpsSnapshot({ runsPerUser: 5, auditPerUser: 5 });
    const user = snapshot.users.find((row) => row.userId === userId);
    expect(user).toBeDefined();
    const rejection = user!.recentAudit.find((a) => a.kind === "order_rejected_by_broker");
    expect(rejection).toBeDefined();
    expect(rejection!.detail).toContain("insufficient buying power");
    expect(rejection!.detail).toContain("symbol=AAPL");
  });

  it("treats FilingAPI 401s as ok (soft skip) and expected-limit lanes as ok", async () => {
    const { logApiHealth } = await import("../src/lib/db-health");
    for (let i = 0; i < 5; i++) {
      logApiHealth({ service: "filingapi", ok: false, errorText: "HTTP 401 Unauthorized", keySource: "env" });
    }
    for (let i = 0; i < 5; i++) {
      logApiHealth({ service: "vix-yahoo", ok: false, errorText: "HTTP 429", soft: true, keySource: "none" });
    }
    logApiHealth({ service: "roic", ok: true, latencyMs: 12, keySource: "env" });

    const { buildOpsSnapshot } = await import("../src/lib/ops-snapshot");
    const snapshot = buildOpsSnapshot({ runsPerUser: 1, auditPerUser: 1 });
    const deps = snapshot.dependencies ?? {};
    expect(deps.filingapi?.ok).toBe(true);
    expect(deps["vix-yahoo"]?.ok).toBe(true);
    expect(deps.roic?.ok).toBe(true);
  });

  it("summarizeBrokerOrderList separates live working from historical done_for_day", async () => {
    const { summarizeBrokerOrderList } = await import("../src/lib/ops-snapshot");
    const summary = summarizeBrokerOrderList([
      { id: "1", symbol: "AAPL", side: "buy", type: "limit", state: "new", createdAt: "2026-07-27T12:00:00.000Z" },
      { id: "2", symbol: "T", side: "sell", type: "limit", state: "held", createdAt: "2026-07-27T12:00:00.000Z" },
      { id: "3", symbol: "OLD", side: "buy", type: "limit", state: "done_for_day", createdAt: "2026-05-01T12:00:00.000Z" },
      { id: "4", symbol: "OLD2", side: "buy", type: "market", state: "done_for_day", createdAt: "2026-04-01T12:00:00.000Z" },
      { id: "5", symbol: "X", side: "buy", type: "market", state: "filled", createdAt: "2026-07-20T12:00:00.000Z" }
    ]);
    expect(summary.listedCount).toBe(5);
    expect(summary.liveCount).toBe(2);
    expect(summary.workingCount).toBe(2);
    expect(summary.doneForDayCount).toBe(2);
    expect(summary.topStates.find((s) => s.state === "done_for_day")?.count).toBe(2);
  });

  it("exposes the Pinecone trial window and does not paint soft 429 backups as down", async () => {
    process.env.RAG_PINECONE_MAX_WRITE_UNITS_PER_DAY = "2500000";
    process.env.RAG_INGEST_MAX_TEXTS_PER_DAY = "1";
    // buildOpsSnapshot uses Date.now(); a hardcoded calendar pin expires and
    // turns this fixture red (2026-08-27 default, then 2026-08-30). Keep the
    // window in the future relative to the run.
    process.env.PINECONE_TRIAL_ENDS_AT = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const db = await import("../src/lib/db");
    db.getDb();
    const { logApiHealth } = await import("../src/lib/db-health");
    logApiHealth({ service: "vix-cboe", ok: true, latencyMs: 20 });
    logApiHealth({
      service: "vix-yahoo",
      ok: false,
      latencyMs: 15,
      errorText: "[expected-limit] HTTP 429",
      soft: true
    });
    const { buildOpsSnapshot } = await import("../src/lib/ops-snapshot");
    const snapshot = buildOpsSnapshot({ runsPerUser: 1, auditPerUser: 1 });
    expect(snapshot.pineconeIngest).toBeDefined();
    expect(snapshot.pineconeIngest!.trial.active).toBe(true);
    expect(snapshot.pineconeIngest!.trial.effectiveDailyWriteUnits).toBeGreaterThanOrEqual(2_048);
    expect(snapshot.pineconeIngest!.trial.effectiveTextsPerDay).toBeGreaterThanOrEqual(32);
    expect(snapshot.dependencies?.["vix-cboe"]?.ok).toBe(true);
    expect(snapshot.dependencies?.["vix-yahoo"]?.ok).toBe(true);
    delete process.env.PINECONE_TRIAL_ENDS_AT;
  });
});

describe("GET /api/ops/snapshot — ordersDetail=1", () => {
  it("attaches per-working-order role classification, without a bare open-order account number or client order id leaking into it", async () => {
    process.env.OPS_DIAGNOSTIC_TOKEN = "test-ops-token-order-detail";
    const db = await import("../src/lib/db");
    const userId = `ops-user-${randomUUID()}`;
    const accountId = `acct-${randomUUID()}`;
    const accountNumber = `ORD-DETAIL-${randomUUID()}`;

    db.upsertConnectedAccount({
      id: accountId,
      userId,
      broker: "alpaca",
      environment: "paper",
      accountNumber,
      label: "Order Detail Test",
      isActive: true
    });
    // The owner report this feature exists for: a resting protective stop that the ops
    // snapshot's plain open-order count couldn't explain.
    db.upsertBrokerProtectiveStop({
      id: randomUUID(),
      userId,
      accountNumber,
      symbol: "BAC",
      brokerOrderId: "working-bac",
      quantity: 24,
      stopPrice: 38.5,
      status: "resting",
      kind: "fixed"
    });

    const workingOrder: EquityOrder = {
      id: "working-bac",
      symbol: "BAC",
      side: "sell",
      type: "stop_market",
      state: "new",
      quantity: 24,
      filledQuantity: 0,
      createdAt: "2026-09-24T14:00:00.000Z",
      clientOrderId: "raw-broker-client-id-should-not-leak"
    };
    const filledOrder: EquityOrder = {
      id: "filled-1",
      symbol: "AAPL",
      side: "buy",
      type: "market",
      state: "filled",
      quantity: 1,
      filledQuantity: 1,
      createdAt: "2026-09-24T13:00:00.000Z"
    };
    brokerMocks.getEquityOrders.mockResolvedValue([workingOrder, filledOrder]);

    const { GET } = await import("../app/api/ops/snapshot/route");
    const response = await GET(
      new Request("http://localhost/api/ops/snapshot?ordersDetail=1", {
        headers: { "x-ops-token": "test-ops-token-order-detail" }
      })
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    const user = body.users.find((u: { userId: string }) => u.userId === userId);
    expect(user).toBeDefined();
    const account = user.accounts.find((a: { connectedAccountId: string }) => a.connectedAccountId === accountId);
    expect(account).toBeDefined();
    // orders=1's existing counts are unaffected by ordersDetail=1.
    expect(account.orders.listedCount).toBe(2);
    expect(account.orders.workingCount).toBe(1);
    expect(account.ordersDetail).toHaveLength(1);
    expect(account.ordersDetail[0]).toMatchObject({
      symbol: "BAC",
      role: "protective_stop",
      whyResting: expect.stringContaining("Protective stop for 24 BAC")
    });
    expect(account.ordersDetail[0]).not.toHaveProperty("id");
    expect(account.ordersDetail[0]).not.toHaveProperty("clientOrderId");
    expect(account.ordersDetail[0]).not.toHaveProperty("accountNumber");
    // No raw client_order_id and no account number anywhere in the detail payload.
    const serializedDetail = JSON.stringify(account.ordersDetail);
    expect(serializedDetail).not.toContain("raw-broker-client-id-should-not-leak");
    expect(serializedDetail).not.toContain(accountNumber);

    delete process.env.OPS_DIAGNOSTIC_TOKEN;
  });

  it("plain ?orders=1 (no ordersDetail) keeps the counts but omits ordersDetail entirely", async () => {
    process.env.OPS_DIAGNOSTIC_TOKEN = "test-ops-token-orders-only";
    const db = await import("../src/lib/db");
    const userId = `ops-user-${randomUUID()}`;
    const accountId = `acct-${randomUUID()}`;
    db.upsertConnectedAccount({
      id: accountId,
      userId,
      broker: "alpaca",
      environment: "paper",
      accountNumber: `ORD-ONLY-${randomUUID()}`,
      label: "Orders Only Test",
      isActive: true
    });
    brokerMocks.getEquityOrders.mockResolvedValue([]);

    const { GET } = await import("../app/api/ops/snapshot/route");
    const response = await GET(
      new Request("http://localhost/api/ops/snapshot?orders=1", {
        headers: { "x-ops-token": "test-ops-token-orders-only" }
      })
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    const user = body.users.find((u: { userId: string }) => u.userId === userId);
    const account = user.accounts.find((a: { connectedAccountId: string }) => a.connectedAccountId === accountId);
    expect(account.orders).toBeDefined();
    expect(account).not.toHaveProperty("ordersDetail");

    delete process.env.OPS_DIAGNOSTIC_TOKEN;
  });
});
