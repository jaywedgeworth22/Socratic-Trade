// Convert serving-process SQLITE_BUSY waits from a sync event-loop pin into yielded retries.
//
// better-sqlite3 runs on the Node thread. `PRAGMA busy_timeout = 60000` (db.ts, raised
// 5s → 30s → 60s to hide "database is locked") makes a contended writer sleep ON THE
// EVENT LOOP for up to a minute. WAL readers cannot run during that sleep — including
// GET /api/live and GET /api/health — so Traefik 503s while Docker still says healthy.
//
// Live RTH signature 2026-09-15/16 (board e7b49943): stale-limit-scan / synthetic-stop
// report event_loop_stall 90–100% of withLaneDeadline (20–80s). That is this wait, not
// broker I/O. Litestream checkpoints and FTS writers are the usual lock holders.
//
// Serving connection busy_timeout is SQLITE_BUSY_PIN_MS (a short pin). Async callers
// keep the historical 60s lock budget by retrying after yieldEventLoop so HTTP can run.

import { currentMarketSession } from "./market-hours";
import { yieldEventLoop } from "./slow-sync-guard";

/** Max ms a serving-process sqlite call may block waiting for SQLITE_BUSY. */
export const SQLITE_BUSY_PIN_MS = 100;

/** Same overall lock-wait budget as the old 60s busy_timeout, spread across yields. */
export const SQLITE_BUSY_RETRY_BUDGET_MS = 60_000;

/** Yield between safety-lane sync bursts so /api/health can run. */
export const SAFETY_LANE_YIELD_EVERY_MS = 50;

export function isSqliteBusy(err: unknown): boolean {
  if (err == null) return false;
  if (typeof err === "object") {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string" && (code.startsWith("SQLITE_BUSY") || code.startsWith("SQLITE_LOCKED"))) {
      return true;
    }
  }
  const message = err instanceof Error ? err.message : String(err);
  return /database is locked/i.test(message) || /database table is locked/i.test(message);
}

/**
 * Run a sync sqlite call. On SQLITE_BUSY, yield and retry until SQLITE_BUSY_RETRY_BUDGET_MS.
 * Non-busy errors throw immediately.
 */
export async function sqliteYieldRetry<T>(fn: () => T): Promise<T> {
  const deadline = Date.now() + SQLITE_BUSY_RETRY_BUDGET_MS;
  for (;;) {
    try {
      return fn();
    } catch (err) {
      if (!isSqliteBusy(err) || Date.now() >= deadline) throw err;
      await yieldEventLoop();
    }
  }
}

export async function yieldIfDue(lastYieldAt: { ms: number }, everyMs = SAFETY_LANE_YIELD_EVERY_MS): Promise<void> {
  if (Date.now() - lastYieldAt.ms < everyMs) return;
  await yieldEventLoop();
  lastYieldAt.ms = Date.now();
}

/**
 * FTS / filing / transcript producers tokenise and write on the serving event loop.
 * During regular US equity hours the safety lanes need that loop; defer ingest to
 * the next non-RTH tick (same durable watermarks — the pass is not skipped forever).
 */
export function shouldDeferRagIngestDuringRth(now = new Date()): boolean {
  return currentMarketSession(now) === "regular";
}
