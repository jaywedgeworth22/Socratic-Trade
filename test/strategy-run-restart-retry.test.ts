import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// Board 687a5fb4 (2026-09-24, lane B `st-run-resilience`).  11 of the last 50 Alpaca Paper runs
// ended "Process restarted mid-run — marked failed by stale-run sweep" and none was retried.
// A restart-killed run that provably placed nothing now gets exactly ONE queued retry on its own
// account; everything that could make the retry unsafe disables it.  See strategy-run-retry.ts
// for the idempotency argument.

const strategyMocks = vi.hoisted(() => ({
  runStrategyOnce: vi.fn()
}));

vi.mock("../src/lib/strategy", () => ({
  runStrategyOnce: strategyMocks.runStrategyOnce
}));

// The drain-time session re-check uses the real market clock; pin it open so these cases do not
// depend on when CI runs.  (Enqueue-time cases pass an explicit `sessionAllows` instead.)
vi.mock("../src/lib/market-hours", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/market-hours")>();
  return { ...actual, isRunAllowedNow: () => true };
});

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-restart-retry-${randomUUID()}.db`)}`;
});

afterEach(() => {
  strategyMocks.runStrategyOnce.mockReset();
});

const OPEN = { sessionAllows: () => true };
const CLOSED = { sessionAllows: () => false };

type Db = typeof import("../src/lib/db");

async function setup(options: { ageMs?: number; systemState?: "active" | "halted" } = {}) {
  const db = await import("../src/lib/db");
  const { DEFAULT_POLICY } = await import("../src/lib/defaults");
  const userId = `retry-user-${randomUUID()}`;
  const accountId = `acct-${randomUUID()}`;
  db.setPolicy({ ...DEFAULT_POLICY, accountNumber: "PA-RETRY", systemState: options.systemState ?? "active" }, userId, accountId);
  const runId = randomUUID();
  // Before this worker booted (restart arm) but inside the 30-min window, with the dead process's
  // lease long expired: exactly a container restart ~20 minutes into an RTH stall.
  db.insertStrategyRun(runId, userId, accountId, "PA-RETRY");
  db.getDb()
    .prepare("UPDATE strategy_runs SET started_at = ? WHERE id = ?")
    .run(new Date(Date.now() - (options.ageMs ?? 20 * 60_000)).toISOString(), runId);
  return { db, userId, accountId, runId };
}

function requestsFor(db: Db, userId: string) {
  return db
    .getDb()
    .prepare(
      "SELECT id, status, manual, connected_account_id, retry_of_run_id, result FROM strategy_run_requests WHERE user_id = ? ORDER BY created_at"
    )
    .all(userId) as Array<{
    id: string;
    status: string;
    manual: number;
    connected_account_id: string | null;
    retry_of_run_id: string | null;
    result: string | null;
  }>;
}

function auditKinds(db: Db, userId: string): Array<{ kind: string; payload: Record<string, unknown> }> {
  return (
    db.getDb().prepare("SELECT kind, payload FROM audit_events WHERE user_id = ? ORDER BY created_at").all(userId) as Array<{
      kind: string;
      payload: string;
    }>
  ).map((r) => ({ kind: r.kind, payload: JSON.parse(r.payload) as Record<string, unknown> }));
}

describe("restart-killed strategy run: one-time retry", () => {
  it("queues exactly one account-targeted, non-manual retry for a restart-killed run that placed nothing", async () => {
    const { sweepStaleRunsAndRetry } = await import("../src/lib/strategy-run-retry");
    const { db, userId, accountId, runId } = await setup();

    const first = sweepStaleRunsAndRetry(Date.now(), OPEN);
    expect(first.retry.enqueued).toBeGreaterThanOrEqual(1);
    const killed = db.getDb().prepare("SELECT status, summary FROM strategy_runs WHERE id = ?").get(runId) as {
      status: string;
      summary: string;
    };
    expect(killed.status).toBe("failed");
    expect(killed.summary).toContain("Process restarted mid-run");

    const rows = requestsFor(db, userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "queued", manual: 0, connected_account_id: accountId, retry_of_run_id: runId });
    expect(auditKinds(db, userId).map((a) => a.kind)).toContain("strategy_run_retry_enqueued");

    // A second sweep (next tick, or a second process) never adds another.
    sweepStaleRunsAndRetry(Date.now(), OPEN);
    expect(requestsFor(db, userId)).toHaveLength(1);
  });

  it("enforces one retry per killed run at the database level too", async () => {
    const { enqueueRestartRetry } = await import("../src/lib/strategy-run-retry");
    const { db, userId, accountId, runId } = await setup();
    db.markStaleRunningRuns(Date.now());
    const killed = { id: runId, userId, connectedAccountId: accountId, startedAt: new Date(Date.now() - 20 * 60_000).toISOString() };
    const a = enqueueRestartRetry(killed, Date.now(), OPEN);
    expect(a.queued).toBe(true);
    // Mark the first retry terminal so only the lineage (not "open request") can stop the second.
    db.getDb().prepare("UPDATE strategy_run_requests SET status = 'completed' WHERE retry_of_run_id = ?").run(runId);
    const b = enqueueRestartRetry(killed, Date.now(), OPEN);
    expect(b).toEqual({ queued: false, reason: "already_retried" });
    expect(() =>
      db
        .getDb()
        .prepare(
          "INSERT INTO strategy_run_requests (id, user_id, manual, status, created_at, retry_of_run_id) VALUES (?, ?, 0, 'queued', ?, ?)"
        )
        .run(randomUUID(), userId, new Date().toISOString(), runId)
    ).toThrow(/UNIQUE/);
  });

  it("does not retry a run that wrote any trade_proposals row (placing intent persisted before the broker call)", async () => {
    const { sweepStaleRunsAndRetry } = await import("../src/lib/strategy-run-retry");
    const { db, userId, runId } = await setup();
    db.getDb()
      .prepare(
        "INSERT INTO trade_proposals (id, run_id, account_number, created_at, proposal, decision, status, user_id, ref_id) VALUES (?, ?, 'PA-RETRY', ?, '{}', '{}', 'placing', ?, ?)"
      )
      .run(randomUUID(), runId, new Date().toISOString(), userId, randomUUID());
    sweepStaleRunsAndRetry(Date.now(), OPEN);
    expect(requestsFor(db, userId)).toHaveLength(0);
    const skipped = auditKinds(db, userId).find((a) => a.kind === "strategy_run_retry_skipped");
    expect(skipped?.payload.reason).toBe("wrote_proposals");
  });

  it("does not retry a run that has a fill_events row", async () => {
    const { sweepStaleRunsAndRetry } = await import("../src/lib/strategy-run-retry");
    const { db, userId, runId } = await setup();
    db.getDb()
      .prepare(
        "INSERT INTO fill_events (id, run_id, account_number, source, symbol, side, quantity, price, notional, status, filled_at) VALUES (?, ?, 'PA-RETRY', 'broker', 'AAPL', 'buy', 1, 100, 100, 'filled', ?)"
      )
      .run(randomUUID(), runId, new Date().toISOString());
    sweepStaleRunsAndRetry(Date.now(), OPEN);
    expect(requestsFor(db, userId)).toHaveLength(0);
    expect(auditKinds(db, userId).find((a) => a.kind === "strategy_run_retry_skipped")?.payload.reason).toBe("wrote_fills");
  });

  it("never retries a retry", async () => {
    const { sweepStaleRunsAndRetry } = await import("../src/lib/strategy-run-retry");
    const { db, userId, accountId, runId } = await setup();
    // The killed run IS a retry: its own request row carries lineage to an older killed run.
    db.getDb()
      .prepare(
        "INSERT INTO strategy_run_requests (id, user_id, manual, status, created_at, connected_account_id, retry_of_run_id) VALUES (?, ?, 0, 'running', ?, ?, ?)"
      )
      .run(runId, userId, new Date(Date.now() - 20 * 60_000).toISOString(), accountId, randomUUID());
    sweepStaleRunsAndRetry(Date.now(), OPEN);
    const rows = requestsFor(db, userId);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(runId);
    expect(rows[0].status).toBe("failed"); // closed by the sweep, not re-queued
    expect(auditKinds(db, userId).find((a) => a.kind === "strategy_run_retry_skipped")?.payload.reason).toBe("killed_run_was_retry");
  });

  it("does not turn an owner's Manual Run once into an autonomous retry", async () => {
    const { sweepStaleRunsAndRetry } = await import("../src/lib/strategy-run-retry");
    const { db, userId, accountId, runId } = await setup();
    db.getDb()
      .prepare(
        "INSERT INTO strategy_run_requests (id, user_id, manual, status, created_at, connected_account_id) VALUES (?, ?, 1, 'running', ?, ?)"
      )
      .run(runId, userId, new Date(Date.now() - 20 * 60_000).toISOString(), accountId);
    sweepStaleRunsAndRetry(Date.now(), OPEN);
    expect(requestsFor(db, userId).filter((r) => r.retry_of_run_id)).toHaveLength(0);
    expect(auditKinds(db, userId).find((a) => a.kind === "strategy_run_retry_skipped")?.payload.reason).toBe("request_driven_run");
  });

  it("does not retry when the account is halted, the session is closed, or a newer run started", async () => {
    const { sweepStaleRunsAndRetry } = await import("../src/lib/strategy-run-retry");

    const halted = await setup({ systemState: "halted" });
    sweepStaleRunsAndRetry(Date.now(), OPEN);
    expect(requestsFor(halted.db, halted.userId)).toHaveLength(0);
    expect(auditKinds(halted.db, halted.userId).find((a) => a.kind === "strategy_run_retry_skipped")?.payload.reason).toBe(
      "account_not_active"
    );

    const closed = await setup();
    sweepStaleRunsAndRetry(Date.now(), CLOSED);
    expect(requestsFor(closed.db, closed.userId)).toHaveLength(0);
    expect(auditKinds(closed.db, closed.userId).find((a) => a.kind === "strategy_run_retry_skipped")?.payload.reason).toBe(
      "session_closed"
    );

    const newer = await setup();
    newer.db.insertStrategyRun(randomUUID(), newer.userId, newer.accountId, "PA-RETRY");
    sweepStaleRunsAndRetry(Date.now(), OPEN);
    expect(requestsFor(newer.db, newer.userId)).toHaveLength(0);
    expect(auditKinds(newer.db, newer.userId).find((a) => a.kind === "strategy_run_retry_skipped")?.payload.reason).toBe(
      "newer_run"
    );
  });

  it("does not retry a run carrying a run-scoped trigger override", async () => {
    const { sweepStaleRunsAndRetry } = await import("../src/lib/strategy-run-retry");
    const { db, userId, accountId, runId } = await setup();
    db.getDb()
      .prepare("INSERT INTO audit_events (id, user_id, connected_account_id, created_at, kind, payload) VALUES (?, ?, ?, ?, 'run_state_override', ?)")
      .run(randomUUID(), userId, accountId, new Date(Date.now() - 19 * 60_000).toISOString(), JSON.stringify({ runId, override: "close_only" }));
    sweepStaleRunsAndRetry(Date.now(), OPEN);
    expect(requestsFor(db, userId)).toHaveLength(0);
    expect(auditKinds(db, userId).find((a) => a.kind === "strategy_run_retry_skipped")?.payload.reason).toBe("run_scoped_override");
  });

  it("sweeps a pre-boot run promptly even though the dead process wrote audit rows for it before boot", async () => {
    const { db, userId, runId } = await setup();
    // Written by the killed process 5 minutes ago (i.e. before this worker booted).
    db.getDb()
      .prepare("INSERT INTO audit_events (id, user_id, connected_account_id, created_at, kind, payload) VALUES (?, ?, NULL, ?, 'usage_budget_status', ?)")
      .run(randomUUID(), userId, new Date(Date.now() - 5 * 60_000).toISOString(), JSON.stringify({ runId }));
    db.markStaleRunningRuns(Date.now());
    expect((db.getDb().prepare("SELECT status FROM strategy_runs WHERE id = ?").get(runId) as { status: string }).status).toBe("failed");
  });

  it("still leaves a pre-boot run alone when something wrote activity for it after this process booted", async () => {
    const { db, userId, runId } = await setup();
    db.getDb()
      .prepare("INSERT INTO audit_events (id, user_id, connected_account_id, created_at, kind, payload) VALUES (?, ?, NULL, ?, 'llm_step', ?)")
      .run(randomUUID(), userId, new Date().toISOString(), JSON.stringify({ runId }));
    db.markStaleRunningRuns(Date.now());
    expect((db.getDb().prepare("SELECT status FROM strategy_runs WHERE id = ?").get(runId) as { status: string }).status).toBe("running");
  });

  it("drain runs a valid retry on the killed run's account as an autonomous (non-manual) run", async () => {
    const { sweepStaleRunsAndRetry } = await import("../src/lib/strategy-run-retry");
    const { processPendingStrategyRunRequests } = await import("../src/lib/strategy-run-requests");
    const { db, userId, accountId } = await setup();
    sweepStaleRunsAndRetry(Date.now(), OPEN);
    const [retry] = requestsFor(db, userId);
    strategyMocks.runStrategyOnce.mockResolvedValue({ runId: retry.id, status: "completed", summary: "ok", proposals: [] });

    // Drain the whole queue (other tests' rows may be ahead of ours).
    await processPendingStrategyRunRequests({ limit: 50 });
    const call = strategyMocks.runStrategyOnce.mock.calls.find((c) => c[0] === userId);
    expect(call?.[1]).toEqual({ manual: false, runId: retry.id, connectedAccountId: accountId });
    expect(requestsFor(db, userId)[0].status).toBe("completed");
  });

  it("drain drops a queued retry whose account was halted after it was queued, without running it", async () => {
    const { sweepStaleRunsAndRetry } = await import("../src/lib/strategy-run-retry");
    const { processPendingStrategyRunRequests } = await import("../src/lib/strategy-run-requests");
    const { db, userId, accountId } = await setup();
    sweepStaleRunsAndRetry(Date.now(), OPEN);
    db.setPolicy({ ...db.getPolicy(userId, accountId), systemState: "halted" }, userId, accountId);

    await processPendingStrategyRunRequests({ limit: 50 });

    expect(strategyMocks.runStrategyOnce.mock.calls.filter((c) => c[0] === userId)).toHaveLength(0);
    const [retry] = requestsFor(db, userId);
    expect(retry.status).toBe("failed");
    expect(JSON.parse(retry.result ?? "{}").summary).toMatch(/account not active/);
    expect(auditKinds(db, userId).find((a) => a.kind === "strategy_run_retry_dropped")?.payload.reason).toBe("account_not_active");
  });

  it("drain never adopts (re-runs) a retry that was itself interrupted by a restart", async () => {
    const { processPendingStrategyRunRequests } = await import("../src/lib/strategy-run-requests");
    const { db, userId, accountId } = await setup();
    const retryId = randomUUID();
    db.getDb()
      .prepare(
        "INSERT INTO strategy_run_requests (id, user_id, manual, status, created_at, started_at, connected_account_id, retry_of_run_id) VALUES (?, ?, 0, 'running', ?, ?, ?, ?)"
      )
      .run(retryId, userId, new Date().toISOString(), new Date().toISOString(), accountId, randomUUID());

    await processPendingStrategyRunRequests({ limit: 50 });

    expect(strategyMocks.runStrategyOnce.mock.calls.filter((c) => c[0] === userId)).toHaveLength(0);
    const row = requestsFor(db, userId).find((r) => r.id === retryId)!;
    expect(row.status).toBe("failed");
    expect(JSON.parse(row.result ?? "{}").summary).toMatch(/not retried again/);
  });

  it("leaves Manual Run once rows running exactly as before (no account id -> active account)", async () => {
    const { processPendingStrategyRunRequests, queueStrategyRunRequest } = await import("../src/lib/strategy-run-requests");
    const db = await import("../src/lib/db");
    const userId = `manual-user-${randomUUID()}`;
    const { request } = queueStrategyRunRequest({ userId, manual: true });
    strategyMocks.runStrategyOnce.mockResolvedValue({ runId: request.id, status: "completed", summary: "ok", proposals: [] });
    await processPendingStrategyRunRequests({ limit: 50 });
    const call = strategyMocks.runStrategyOnce.mock.calls.find((c) => c[0] === userId);
    expect(call?.[1]).toEqual({ manual: true, runId: request.id });
    expect(requestsFor(db, userId)[0].status).toBe("completed");
  });
});
