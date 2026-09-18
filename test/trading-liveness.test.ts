import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

// Isolated temp SQLite DB per test file, shared across the tests below (they run sequentially,
// in file order — vitest does not parallelize tests within one file by default). The
// zero-active-accounts test therefore runs FIRST, before any other test in this file creates an
// active-autonomy account, so its "omitted" assertion is meaningful against the whole DB rather
// than a per-account filter (getTradingLivenessSummary has no such filter — it scans every user,
// matching what /api/health actually does).
beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-trading-liveness-${randomUUID()}.db`)}`;
});

afterEach(() => {
  delete process.env.TRADING_LIVENESS_STALE_MINUTES;
  delete process.env.TRADING_LIVENESS_MAX_CONSECUTIVE_FAILURES;
});

async function load() {
  const db = await import("../src/lib/db");
  const liveness = await import("../src/lib/trading-liveness");
  return { db, liveness };
}

/** Insert a strategy_runs row with an explicit started_at/finished_at, bypassing the
 * now()-stamped insertStrategyRun/finishStrategyRun helpers so tests can control run age. */
function insertRunAt(
  db: Awaited<ReturnType<typeof load>>["db"],
  opts: {
    userId: string;
    connectedAccountId: string;
    status: "completed" | "failed" | "skipped" | "skipped_budget" | "skipped_market_closed" | "skipped_broker_unhealthy";
    startedAt: string;
    finishedAt: string;
  }
): void {
  db.getDb()
    .prepare(
      `INSERT INTO strategy_runs (id, user_id, connected_account_id, started_at, finished_at, status, summary)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(randomUUID(), opts.userId, opts.connectedAccountId, opts.startedAt, opts.finishedAt, opts.status, opts.status);
}

async function makeAccount(db: Awaited<ReturnType<typeof load>>["db"], label: string, systemState: "active" | "halted" = "active"): Promise<{ userId: string; accountId: string }> {
  const userId = `liveness-user-${randomUUID()}`;
  const accountId = `liveness-acct-${randomUUID()}`;
  db.upsertConnectedAccount({
    id: accountId,
    userId,
    broker: "alpaca",
    environment: "paper",
    accountNumber: `ACC-${randomUUID().slice(0, 8)}`,
    label,
    isActive: true
  });
  if (systemState === "active") {
    db.setPolicy({ ...db.getPolicy(userId, accountId), systemState: "active" }, userId, accountId);
  }
  return { userId, accountId };
}

describe("trading-liveness", () => {
  it("omits the dimension entirely when there are zero active-autonomy accounts", async () => {
    const { db, liveness } = await load();
    // A connected account exists but is left at its default "halted" state — it must not make
    // the dimension appear (a halted account not completing runs is expected, not degraded).
    await makeAccount(db, "Halted Account", "halted");

    const summary = liveness.getTradingLivenessSummary();
    expect(summary).toBeNull();
    const publicAgg = liveness.toPublicTradingLiveness(summary);
    expect(publicAgg.degraded).toBe(0);
    expect(publicAgg.activeAccounts).toBe(0);
    expect(typeof publicAgg.marketOpen).toBe("boolean");
  });

  it("reports healthy for a fresh completed run with no failures", async () => {
    const { db, liveness } = await load();
    const { userId, accountId } = await makeAccount(db, "Fresh Account");
    const now = Date.parse("2026-07-15T12:00:00.000Z");
    insertRunAt(db, {
      userId,
      connectedAccountId: accountId,
      status: "completed",
      startedAt: new Date(now - 5 * 60_000).toISOString(),
      finishedAt: new Date(now - 4 * 60_000).toISOString()
    });

    const result = liveness.computeAccountTradingLiveness(userId, accountId, "Fresh Account", now);
    expect(result.degraded).toBe(false);
    expect(result.degradedReasons).toEqual([]);
    expect(result.consecutiveFailedRuns).toBe(0);
    expect(result.lastCompletedRunAgeSeconds).toBe(240);
  });

  it("flags stale-last-completed-run and consecutive-failures separately and together", async () => {
    process.env.TRADING_LIVENESS_STALE_MINUTES = "60";
    process.env.TRADING_LIVENESS_MAX_CONSECUTIVE_FAILURES = "3";
    const { db, liveness } = await load();
    const { userId, accountId } = await makeAccount(db, "Degraded Account");
    // Wednesday 18:00 UTC = 14:00 ET, mid regular session — market open, so the stale reason is
    // eligible to fire (see the market-session-aware staleness tests below for the closed case).
    const now = Date.parse("2026-07-15T18:00:00.000Z");

    // A completed run well outside the 60-minute stale window...
    insertRunAt(db, {
      userId,
      connectedAccountId: accountId,
      status: "completed",
      startedAt: new Date(now - 400 * 60_000).toISOString(),
      finishedAt: new Date(now - 399 * 60_000).toISOString()
    });
    // ...followed by 3 consecutive failed runs (>= the threshold), all after the completed run.
    for (let i = 3; i >= 1; i--) {
      insertRunAt(db, {
        userId,
        connectedAccountId: accountId,
        status: "failed",
        startedAt: new Date(now - i * 60_000).toISOString(),
        finishedAt: new Date(now - i * 60_000 + 1000).toISOString()
      });
    }

    const result = liveness.computeAccountTradingLiveness(userId, accountId, "Degraded Account", now);
    expect(result.degraded).toBe(true);
    expect(result.consecutiveFailedRuns).toBe(3);
    expect(result.lastCompletedRunAgeSeconds).toBe(399 * 60);
    expect(result.degradedReasons.slice().sort()).toEqual(["consecutive_failures", "stale_last_completed_run"].sort());
  });

  it("stops the consecutive-failure count at the most recent completed run", async () => {
    process.env.TRADING_LIVENESS_MAX_CONSECUTIVE_FAILURES = "5";
    const { db, liveness } = await load();
    const { userId, accountId } = await makeAccount(db, "Recovered Account");
    const now = Date.parse("2026-07-15T12:00:00.000Z");

    // Two old failures, then a completed run, then one recent failure — only the trailing
    // failure (after the completed run) should count.
    insertRunAt(db, { userId, connectedAccountId: accountId, status: "failed", startedAt: new Date(now - 30 * 60_000).toISOString(), finishedAt: new Date(now - 30 * 60_000).toISOString() });
    insertRunAt(db, { userId, connectedAccountId: accountId, status: "failed", startedAt: new Date(now - 20 * 60_000).toISOString(), finishedAt: new Date(now - 20 * 60_000).toISOString() });
    insertRunAt(db, { userId, connectedAccountId: accountId, status: "completed", startedAt: new Date(now - 10 * 60_000).toISOString(), finishedAt: new Date(now - 9 * 60_000).toISOString() });
    insertRunAt(db, { userId, connectedAccountId: accountId, status: "failed", startedAt: new Date(now - 2 * 60_000).toISOString(), finishedAt: new Date(now - 2 * 60_000).toISOString() });

    const result = liveness.computeAccountTradingLiveness(userId, accountId, "Recovered Account", now);
    expect(result.consecutiveFailedRuns).toBe(1);
    expect(result.degraded).toBe(false); // 1 < default threshold (3) and last completed run is recent
  });

  it("reports a stale last-completed-run without degrading while the market is closed", async () => {
    process.env.TRADING_LIVENESS_STALE_MINUTES = "60";
    const { db, liveness } = await load();
    const { userId, accountId } = await makeAccount(db, "Closed Market Account");
    // Saturday — the market is closed all day regardless of time-of-day/DST.
    const now = Date.parse("2026-07-18T18:00:00.000Z");
    insertRunAt(db, {
      userId,
      connectedAccountId: accountId,
      status: "completed",
      startedAt: new Date(now - 400 * 60_000).toISOString(),
      finishedAt: new Date(now - 399 * 60_000).toISOString()
    });

    const result = liveness.computeAccountTradingLiveness(userId, accountId, "Closed Market Account", now);
    expect(result.marketOpen).toBe(false);
    // The real age is still reported honestly — it's just not treated as an actionable signal.
    expect(result.lastCompletedRunAgeSeconds).toBe(399 * 60);
    expect(result.degradedReasons).not.toContain("stale_last_completed_run");
    expect(result.degraded).toBe(false);
  });

  it("degrades on a stale last-completed-run when the market is open", async () => {
    process.env.TRADING_LIVENESS_STALE_MINUTES = "60";
    const { db, liveness } = await load();
    const { userId, accountId } = await makeAccount(db, "Open Market Account");
    // Wednesday 18:00 UTC = 14:00 ET, mid regular session.
    const now = Date.parse("2026-07-15T18:00:00.000Z");
    insertRunAt(db, {
      userId,
      connectedAccountId: accountId,
      status: "completed",
      startedAt: new Date(now - 400 * 60_000).toISOString(),
      finishedAt: new Date(now - 399 * 60_000).toISOString()
    });

    const result = liveness.computeAccountTradingLiveness(userId, accountId, "Open Market Account", now);
    expect(result.marketOpen).toBe(true);
    expect(result.degradedReasons).toContain("stale_last_completed_run");
    expect(result.degraded).toBe(true);
  });

  it("does not treat pure skip statuses as healthy decision completions (UX PR-A1)", async () => {
    process.env.TRADING_LIVENESS_STALE_MINUTES = "60";
    const { db, liveness } = await load();
    const { userId, accountId } = await makeAccount(db, "Skip-Only Account");
    // Wednesday mid-session — market open so staleness is actionable if lastCompleted is old.
    const now = Date.parse("2026-07-15T18:00:00.000Z");
    // Old completed run well outside the window...
    insertRunAt(db, {
      userId,
      connectedAccountId: accountId,
      status: "completed",
      startedAt: new Date(now - 400 * 60_000).toISOString(),
      finishedAt: new Date(now - 399 * 60_000).toISOString()
    });
    // ...then only recent pre-decision skips (budget / market / broker). These must NOT
    // refresh lastCompletedRunAt or clear staleness.
    for (const status of ["skipped_budget", "skipped_market_closed", "skipped_broker_unhealthy"] as const) {
      insertRunAt(db, {
        userId,
        connectedAccountId: accountId,
        status,
        startedAt: new Date(now - 5 * 60_000).toISOString(),
        finishedAt: new Date(now - 4 * 60_000).toISOString()
      });
    }

    const result = liveness.computeAccountTradingLiveness(userId, accountId, "Skip-Only Account", now);
    expect(result.lastCompletedRunAgeSeconds).toBe(399 * 60);
    expect(result.degradedReasons).toContain("stale_last_completed_run");
    // Skips are neither failures nor completions — failure streak stays 0.
    expect(result.consecutiveFailedRuns).toBe(0);
  });

  it("includes an active account in the summary and surfaces its degraded state", async () => {
    process.env.TRADING_LIVENESS_MAX_CONSECUTIVE_FAILURES = "1";
    const { db, liveness } = await load();
    const { userId, accountId } = await makeAccount(db, "Summary Account");
    const now = Date.now();
    insertRunAt(db, {
      userId,
      connectedAccountId: accountId,
      status: "failed",
      startedAt: new Date(now - 60_000).toISOString(),
      finishedAt: new Date(now - 60_000).toISOString()
    });

    const summary = liveness.getTradingLivenessSummary(now);
    expect(summary).not.toBeNull();
    expect(summary!.degraded).toBe(true);
    const row = summary!.accounts.find((a) => a.connectedAccountId === accountId);
    expect(row?.degraded).toBe(true);
    expect(row?.consecutiveFailedRuns).toBe(1);
  });

  it("/api/health never 503s on a degraded trading-liveness account, leaves the base shape intact, and exposes only a minimal public aggregate (no ids/labels/timestamps)", async () => {
    process.env.TRADING_LIVENESS_MAX_CONSECUTIVE_FAILURES = "1";
    const { db } = await load();
    const { userId, accountId } = await makeAccount(db, "Route Account");
    insertRunAt(db, {
      userId,
      connectedAccountId: accountId,
      status: "failed",
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      finishedAt: new Date(Date.now() - 60_000).toISOString()
    });

    const { GET } = await import("../app/api/health/route");
    // Anonymous (no x-ops-token): the trading-liveness aggregate is public in both views.
    const response = await GET(new Request("http://localhost/api/health"));
    // Trading-liveness degradation must NEVER 503 — a restart would re-trigger the boot
    // autonomy interlock and halt the very account this signal is trying to protect.
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.checks).toHaveProperty("db");
    expect(body.checks).toHaveProperty("schedulerLastTick");
    expect(body.checks.tradingLivenessDegraded).toBe(true);
    // PUBLIC route: only the minimal aggregate — counts + oldest age + market state. No
    // userId/connectedAccountId/label/per-account rows/timestamps (that detail is authed-only,
    // on the ops snapshot). Other tests in this shared-DB file may also have left active
    // accounts behind, so this only checks shape/leakage, not exact counts.
    expect(Object.keys(body.checks.tradingLiveness).sort()).toEqual(
      [
        "activeAccounts",
        "autopilotAccounts",
        "degraded",
        "degradedReasons",
        "marketOpen",
        "maxConsecutiveFailedRuns",
        "oldestCompletedRunAgeSeconds",
        "runningAskFirstAccounts"
      ].sort()
    );
    expect(typeof body.checks.tradingLiveness.activeAccounts).toBe("number");
    expect(typeof body.checks.tradingLiveness.degraded).toBe("number");
    expect(typeof body.checks.tradingLiveness.marketOpen).toBe("boolean");
    expect(
      body.checks.tradingLiveness.oldestCompletedRunAgeSeconds === null ||
        typeof body.checks.tradingLiveness.oldestCompletedRunAgeSeconds === "number"
    ).toBe(true);
    expect(body.checks.tradingLiveness.activeAccounts).toBeGreaterThanOrEqual(1);
    expect(body.checks.tradingLiveness.degraded).toBeGreaterThanOrEqual(1);
    // The cause fields let a JSON-path monitor separate "failing every run" from out-of-session
    // silence.  They must stay identity-free: a max across accounts and a fixed reason vocabulary.
    expect(typeof body.checks.tradingLiveness.maxConsecutiveFailedRuns).toBe("number");
    expect(body.checks.tradingLiveness.maxConsecutiveFailedRuns).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(body.checks.tradingLiveness.degradedReasons)).toBe(true);
    expect(body.checks.tradingLiveness.degradedReasons).toContain("consecutive_failures");
    for (const reason of body.checks.tradingLiveness.degradedReasons) {
      expect(["stale_last_completed_run", "consecutive_failures"]).toContain(reason);
    }
    expect(body.checks.tradingLiveness).not.toHaveProperty("accounts");
    const serialized = JSON.stringify(body.checks.tradingLiveness);
    expect(serialized).not.toContain(accountId);
    expect(serialized).not.toContain(userId);
    expect(serialized).not.toContain("Route Account");
  });
});
