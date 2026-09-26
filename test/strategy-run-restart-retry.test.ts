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

async function setup(
  options: {
    ageMs?: number;
    systemState?: "active" | "halted";
    /** How the killed run was launched.  Default: an autonomous (scheduler / trigger) run. */
    origin?: import("../src/lib/strategy-run-origin").StrategyRunOrigin | null;
  } = {}
) {
  const db = await import("../src/lib/db");
  const { DEFAULT_POLICY } = await import("../src/lib/defaults");
  const userId = `retry-user-${randomUUID()}`;
  const accountId = `acct-${randomUUID()}`;
  // A real connected account row: the retry re-checks it is still connected and not draining.
  db.upsertConnectedAccount({
    id: accountId,
    userId,
    broker: "alpaca",
    environment: "paper",
    accountNumber: "PA-RETRY",
    label: "Retry paper",
    isActive: true
  });
  db.setPolicy({ ...DEFAULT_POLICY, accountNumber: "PA-RETRY", systemState: options.systemState ?? "active" }, userId, accountId);
  const runId = randomUUID();
  // Before this worker booted (restart arm) but inside the 30-min window, with the dead process's
  // lease long expired: exactly a container restart ~20 minutes into an RTH stall.
  db.insertStrategyRun(
    runId,
    userId,
    accountId,
    "PA-RETRY",
    undefined,
    options.origin === undefined ? "autonomous" : (options.origin ?? undefined)
  );
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

  // Review round (2026-09-25): the iOS `strategy.run_once` command calls runStrategyOnce(userId,
  // { manual: true }) directly — no strategy_run_requests row — so "no request row" did not mean
  // "scheduler-launched".  The run's own origin, written with the run row, is now the gate.
  it("does not turn an iOS Run once (manual run, no request row) into an autonomous retry", async () => {
    const { sweepStaleRunsAndRetry } = await import("../src/lib/strategy-run-retry");
    const { db, userId } = await setup({ origin: "manual" });
    sweepStaleRunsAndRetry(Date.now(), OPEN);
    expect(requestsFor(db, userId)).toHaveLength(0);
    expect(auditKinds(db, userId).find((a) => a.kind === "strategy_run_retry_skipped")?.payload.reason).toBe("manual_run");
  });

  it("fails closed on a killed run whose origin was never recorded, and on run-scoped overrides", async () => {
    const { sweepStaleRunsAndRetry } = await import("../src/lib/strategy-run-retry");
    const legacy = await setup({ origin: null });
    sweepStaleRunsAndRetry(Date.now(), OPEN);
    expect(requestsFor(legacy.db, legacy.userId)).toHaveLength(0);
    expect(
      auditKinds(legacy.db, legacy.userId).find((a) => a.kind === "strategy_run_retry_skipped")?.payload.reason
    ).toBe("unknown_origin");

    // close_only trigger run: refused from the run row itself, even with no run_state_override audit row.
    const override = await setup({ origin: "run_state_override" });
    sweepStaleRunsAndRetry(Date.now(), OPEN);
    expect(requestsFor(override.db, override.userId)).toHaveLength(0);
    expect(
      auditKinds(override.db, override.userId).find((a) => a.kind === "strategy_run_retry_skipped")?.payload.reason
    ).toBe("run_scoped_override");
  });

  it("records a manual origin for every manual run and an autonomous one only for scheduler/trigger shapes", async () => {
    const { resolveStrategyRunOrigin, isRestartRetryableOrigin } = await import("../src/lib/strategy-run-origin");
    // iOS strategy.run_once and web Manual Run once.
    expect(resolveStrategyRunOrigin({ manual: true })).toBe("manual");
    expect(resolveStrategyRunOrigin({ manual: true, runId: "r", connectedAccountId: "a" })).toBe("manual");
    // Scheduler ({ connectedAccountId }) and plain trigger (no options) runs.
    expect(resolveStrategyRunOrigin({ connectedAccountId: "a" })).toBe("autonomous");
    expect(resolveStrategyRunOrigin({})).toBe("autonomous");
    expect(resolveStrategyRunOrigin({ runStateOverride: "close_only" })).toBe("run_state_override");
    // Drained request rows (API run, restart retry).
    expect(resolveStrategyRunOrigin({ runId: "r", connectedAccountId: "a" })).toBe("request");
    expect(isRestartRetryableOrigin("autonomous")).toBe(true);
    for (const origin of ["manual", "request", "run_state_override", null, undefined, "something-new"]) {
      expect(isRestartRetryableOrigin(origin)).toBe(false);
    }
  });

  // Review round: deleteConnectedAccount sets is_draining=1 / is_active=0 but leaves the account's
  // strategy state `active`, and only the scheduler loop skips draining accounts.
  it("does not retry on an account that is being disconnected (draining) or is gone", async () => {
    const { sweepStaleRunsAndRetry } = await import("../src/lib/strategy-run-retry");
    const draining = await setup();
    draining.db.deleteConnectedAccount(draining.accountId, draining.userId);
    sweepStaleRunsAndRetry(Date.now(), OPEN);
    expect(requestsFor(draining.db, draining.userId)).toHaveLength(0);
    expect(
      auditKinds(draining.db, draining.userId).find((a) => a.kind === "strategy_run_retry_skipped")?.payload.reason
    ).toBe("account_draining");

    const gone = await setup();
    gone.db.getDb().prepare("DELETE FROM connected_accounts WHERE id = ?").run(gone.accountId);
    sweepStaleRunsAndRetry(Date.now(), OPEN);
    expect(requestsFor(gone.db, gone.userId)).toHaveLength(0);
    expect(auditKinds(gone.db, gone.userId).find((a) => a.kind === "strategy_run_retry_skipped")?.payload.reason).toBe(
      "account_missing"
    );
  });

  it("drain drops a queued retry whose account started draining after it was queued, without running it", async () => {
    const { sweepStaleRunsAndRetry } = await import("../src/lib/strategy-run-retry");
    const { processPendingStrategyRunRequests } = await import("../src/lib/strategy-run-requests");
    const { db, userId, accountId } = await setup();
    sweepStaleRunsAndRetry(Date.now(), OPEN);
    expect(requestsFor(db, userId)[0]?.status).toBe("queued");
    db.deleteConnectedAccount(accountId, userId);

    await processPendingStrategyRunRequests({ limit: 50 });

    expect(strategyMocks.runStrategyOnce.mock.calls.filter((c) => c[0] === userId)).toHaveLength(0);
    const [retry] = requestsFor(db, userId);
    expect(retry.status).toBe("failed");
    expect(auditKinds(db, userId).find((a) => a.kind === "strategy_run_retry_dropped")?.payload.reason).toBe("account_draining");
  });

  // Review round: queueStrategyRunRequest deduped onto ANY open request for the user, and restart
  // retries share that table — so the owner's Run once click returned the retry's id and never ran.
  it("an owner's Run once is never swallowed by a queued restart retry; the owner's request supersedes it", async () => {
    const { sweepStaleRunsAndRetry } = await import("../src/lib/strategy-run-retry");
    const { queueStrategyRunRequest } = await import("../src/lib/strategy-run-requests");
    const { db, userId } = await setup();
    sweepStaleRunsAndRetry(Date.now(), OPEN);
    const [retry] = requestsFor(db, userId);
    expect(retry.status).toBe("queued");

    const owner = queueStrategyRunRequest({ userId, manual: true });
    expect(owner.deduped).toBe(false);
    expect(owner.request.id).not.toBe(retry.id);
    expect(owner.request.manual).toBe(true);

    const rows = requestsFor(db, userId);
    const retryAfter = rows.find((r) => r.id === retry.id)!;
    expect(retryAfter.status).toBe("failed");
    expect(JSON.parse(retryAfter.result ?? "{}").summary).toMatch(/superseded by owner request/);
    expect(auditKinds(db, userId).find((a) => a.kind === "strategy_run_retry_dropped")?.payload.reason).toBe(
      "superseded_by_owner_request"
    );

    // A second owner click still dedupes onto the owner's own open request, exactly as before.
    const again = queueStrategyRunRequest({ userId, manual: true });
    expect(again.deduped).toBe(true);
    expect(again.request.id).toBe(owner.request.id);
  });

  it("an owner's Run once is not deduped onto a RUNNING restart retry (the account lock serializes them)", async () => {
    const { sweepStaleRunsAndRetry } = await import("../src/lib/strategy-run-retry");
    const { queueStrategyRunRequest } = await import("../src/lib/strategy-run-requests");
    const { db, userId } = await setup();
    sweepStaleRunsAndRetry(Date.now(), OPEN);
    const [retry] = requestsFor(db, userId);
    // The drain claimed it: a live autonomous retry is mid-run.
    db.getDb().prepare("UPDATE strategy_run_requests SET status = 'running', started_at = ? WHERE id = ?").run(new Date().toISOString(), retry.id);
    db.insertStrategyRun(retry.id, userId, retry.connected_account_id ?? undefined, "PA-RETRY", undefined, "request");

    const owner = queueStrategyRunRequest({ userId, manual: true });
    expect(owner.deduped).toBe(false);
    expect(owner.request.id).not.toBe(retry.id);
    expect(requestsFor(db, userId).find((r) => r.id === retry.id)?.status).toBe("running");
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
