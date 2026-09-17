// Regression: serving-process SQLITE_BUSY must not pin the event loop for the old 60s
// busy_timeout. Board e7b49943 / 2026-09-15 RTH hangs: stale-limit-scan and synthetic-stop
// reported event_loop_stall 90–100% of withLaneDeadline while public /api/health Traefik 503'd.
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-sqlite-stall-${randomUUID()}.db`)}`;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("sqliteYieldRetry", () => {
  it("retries SQLITE_BUSY after yielding and then succeeds", async () => {
    const { sqliteYieldRetry, isSqliteBusy } = await import("../src/lib/sqlite-event-loop");
    const busy = Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
    expect(isSqliteBusy(busy)).toBe(true);

    let calls = 0;
    const result = await sqliteYieldRetry(() => {
      calls += 1;
      if (calls < 3) throw busy;
      return "ok";
    });
    expect(result).toBe("ok");
    expect(calls).toBe(3);
  });

  it("lets a concurrent timer fire between busy retries (the loop is not pinned)", async () => {
    const { sqliteYieldRetry } = await import("../src/lib/sqlite-event-loop");
    const busy = Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
    let concurrent = 0;
    const tick = setInterval(() => {
      concurrent += 1;
    }, 1);
    tick.unref?.();

    try {
      let calls = 0;
      await sqliteYieldRetry(() => {
        calls += 1;
        if (calls < 8) throw busy;
        return true;
      });
      expect(concurrent).toBeGreaterThan(0);
    } finally {
      clearInterval(tick);
    }
  });

  it("does not retry a non-busy error", async () => {
    const { sqliteYieldRetry } = await import("../src/lib/sqlite-event-loop");
    let calls = 0;
    await expect(
      sqliteYieldRetry(() => {
        calls += 1;
        throw new Error("broker returned 500");
      })
    ).rejects.toThrow("broker returned 500");
    expect(calls).toBe(1);
  });

  it("keeps the historical 60s lock budget then rethrows SQLITE_BUSY", async () => {
    const { sqliteYieldRetry, SQLITE_BUSY_RETRY_BUDGET_MS } = await import("../src/lib/sqlite-event-loop");
    const busy = Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
    const t0 = 1_000_000;
    let nowCalls = 0;
    vi.spyOn(Date, "now").mockImplementation(() => {
      nowCalls += 1;
      return nowCalls === 1 ? t0 : t0 + SQLITE_BUSY_RETRY_BUDGET_MS + 1;
    });
    let calls = 0;
    await expect(
      sqliteYieldRetry(() => {
        calls += 1;
        throw busy;
      })
    ).rejects.toThrow("database is locked");
    expect(calls).toBe(1);
    expect(SQLITE_BUSY_RETRY_BUDGET_MS).toBe(60_000);
  });
});

describe("serving busy_timeout", () => {
  it("is a short pin, not the historical 60s event-loop sleep", async () => {
    const { getDb } = await import("../src/lib/db");
    const { SQLITE_BUSY_PIN_MS } = await import("../src/lib/sqlite-event-loop");
    const rows = getDb().pragma("busy_timeout") as Array<{ timeout: number }>;
    expect(rows[0]?.timeout).toBe(SQLITE_BUSY_PIN_MS);
    expect(SQLITE_BUSY_PIN_MS).toBeLessThanOrEqual(250);
    expect(SQLITE_BUSY_PIN_MS).toBeGreaterThan(0);
  });
});

describe("shouldDeferRagIngestDuringRth", () => {
  it("defers FTS/filing producers during regular US equity hours", async () => {
    const { shouldDeferRagIngestDuringRth } = await import("../src/lib/sqlite-event-loop");
    // Tuesday 2026-09-15 15:00 ET = 19:00 UTC (EDT).
    expect(shouldDeferRagIngestDuringRth(new Date("2026-09-15T19:00:00.000Z"))).toBe(true);
    expect(shouldDeferRagIngestDuringRth(new Date("2026-09-19T19:00:00.000Z"))).toBe(false);
    expect(shouldDeferRagIngestDuringRth(new Date("2026-09-15T23:00:00.000Z"))).toBe(false);
  });
});

describe("notifyStaleLimitOrders yields between sqlite writes", () => {
  it("calls yieldEventLoop so /api/health can run during a scan", async () => {
    const yieldSpy = vi.spyOn(await import("../src/lib/slow-sync-guard"), "yieldEventLoop");
    const { notifyStaleLimitOrders } = await import("../src/lib/stale-limit-orders");
    const { getPolicy } = await import("../src/lib/db");
    const policy = { ...getPolicy("local"), staleLimitOrderMinutes: 15, connectedAccountId: undefined };
    const now = new Date("2026-06-30T16:30:00.000Z");
    await notifyStaleLimitOrders({
      userId: "local",
      policy,
      now,
      orders: [
        {
          id: "stale-a",
          symbol: "AAPL",
          side: "buy",
          type: "limit",
          state: "accepted",
          quantity: 10,
          filledQuantity: 0,
          createdAt: "2026-06-30T16:00:00.000Z"
        },
        {
          id: "stale-b",
          symbol: "MSFT",
          side: "buy",
          type: "limit",
          state: "accepted",
          quantity: 5,
          filledQuantity: 0,
          createdAt: "2026-06-30T15:50:00.000Z"
        }
      ]
    });
    expect(yieldSpy.mock.calls.length).toBeGreaterThan(0);
  });
});

describe("pruneTaskJournal batch bound", () => {
  it("does not delete more than TASK_JOURNAL_PRUNE_BATCH_LIMIT rows in one call", async () => {
    const {
      recordTaskStart,
      recordTaskEnd,
      pruneTaskJournal,
      TASK_JOURNAL_PRUNE_BATCH_LIMIT
    } = await import("../src/lib/db");
    const taskName = `prune_bound_${randomUUID()}`;
    const thirtyOneDaysAgo = new Date(Date.now() - 31 * 24 * 60 * 60 * 1_000);
    const extra = 20;
    for (let i = 0; i < TASK_JOURNAL_PRUNE_BATCH_LIMIT + extra; i++) {
      const id = recordTaskStart({ taskName, now: thirtyOneDaysAgo.toISOString() });
      recordTaskEnd(id, { status: "ok" }, thirtyOneDaysAgo);
    }
    const pruned = pruneTaskJournal();
    expect(pruned).toBe(TASK_JOURNAL_PRUNE_BATCH_LIMIT);
    const { getDb } = await import("../src/lib/db");
    const leftover = getDb()
      .prepare("SELECT COUNT(*) as c FROM task_journal WHERE task_name = ?")
      .get(taskName) as { c: number };
    expect(leftover.c).toBe(extra);
  });
});
