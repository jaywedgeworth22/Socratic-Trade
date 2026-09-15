// db-execution.ts — DAILY_RESET_TIME_ZONE, daily stats, day-trade counting,
// run lock (acquireStrategyLock / releaseStrategyLock), strategy runs.
import "server-only";
import { audit, getDb } from "./db";
import { isStrategyRunExecutionLive } from "./strategy-run-execution-registry";
import { CENTRAL_TRADING_DAY_ZONE, startOfCentralTradingDay } from "./trading-day";
import type { StrategyRunFinishStatus } from "./strategy-run-status";
import type { StrategyRunRow } from "./types";

export type { StrategyRunFinishStatus } from "./strategy-run-status";

/**
 * IANA timezone whose civil midnight defines the daily-notional reset boundary. Central Time
 * matches owner-facing Day P&L and drawdown-breaker day keys (perf-08 / cash-flow cluster).
 */
export const DAILY_RESET_TIME_ZONE = CENTRAL_TRADING_DAY_ZONE;

/** UTC instant of civil midnight, in `timeZone`, for the calendar day containing `now`. (T13) */
export function startOfDayInTimeZone(now: Date, timeZone: string = DAILY_RESET_TIME_ZONE): Date {
  if (timeZone === CENTRAL_TRADING_DAY_ZONE) return startOfCentralTradingDay(now);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    })
      .formatToParts(now)
      .map((part) => [part.type, part.value])
  );
  const hour = parts.hour === "24" ? 0 : Number(parts.hour); // some engines render midnight as "24"
  const wallAsUTC = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), hour, Number(parts.minute), Number(parts.second));
  const offsetMs = wallAsUTC - now.getTime(); // how far the tz wall-clock leads UTC at `now`
  const midnightWallAsUTC = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), 0, 0, 0);
  return new Date(midnightWallAsUTC - offsetMs);
}

/**
 * Scope key for an account. A missing/blank account number maps to an explicit sentinel so
 * the "unassigned" bucket is consistent between writes and reads, rather than relying on the
 * `account_number` column's empty-string DEFAULT (which can silently merge contexts). (T14)
 */
export function scopeAccount(accountNumber?: string | null): string {
  return accountNumber && accountNumber.trim() !== "" ? accountNumber : "__unassigned__";
}

export function dailyExecutionStats(
  accountNumber: string,
  now = new Date(),
  userId: string = "local",
  timeZone: string = DAILY_RESET_TIME_ZONE
): { orderCount: number; openingOrderCount: number; notional: number } {
  const dayStart = startOfDayInTimeZone(now, timeZone);
  // Phase 2 fix: use persisted estimated_notional so share-qty market orders
  // (which have no limitPrice) count correctly against the daily cap.
  const rows = getDb()
    .prepare(
      "SELECT proposal, estimated_notional FROM trade_proposals WHERE datetime(coalesce(placed_at, created_at)) >= datetime(?) AND account_number = ? AND user_id = ? AND status IN ('placed', 'filled', 'paper', 'placing')"
    )
    .all(dayStart.toISOString(), scopeAccount(accountNumber), userId) as Array<{ proposal: string; estimated_notional: number | null }>;

  return rows.reduce(
    (acc, row) => {
      const proposal = JSON.parse(row.proposal) as { side?: string; dollarAmount?: number; quantity?: number; limitPrice?: number };
      // NB: "opening" = buy OR short. (Named isBuy historically; it always included short.)
      const isOpening = proposal.side === "buy" || proposal.side === "short";
      // Notional caps intentionally count only OPENING trades (buy/short); closing trades (sell/cover) are risk-reducing and exempt (notional = 0).
      // Prefer the persisted estimated_notional; fall back to proposal fields for old rows.
      const notional = isOpening
        ? (row.estimated_notional != null
            ? row.estimated_notional
            : (proposal.dollarAmount ?? (proposal.quantity ?? 0) * (proposal.limitPrice ?? 0)))
        : 0;
      return {
        orderCount: acc.orderCount + 1,
        openingOrderCount: acc.openingOrderCount + (isOpening ? 1 : 0),
        notional: acc.notional + notional
      };
    },
    { orderCount: 0, openingOrderCount: 0, notional: 0 }
  );
}

/**
 * Order notional executed within a rolling window of `minutes` (R1 hourly cap). Mirrors
 * dailyExecutionStats but on an arbitrary lookback rather than the calendar day.
 */
export function notionalInLastMinutes(accountNumber: string, minutes: number, now = new Date(), userId: string = "local"): { orderCount: number; openingOrderCount: number; notional: number } {
  const cutoff = new Date(now.getTime() - minutes * 60_000);
  const rows = getDb()
    .prepare(
      "SELECT proposal, estimated_notional FROM trade_proposals WHERE datetime(coalesce(placed_at, created_at)) >= datetime(?) AND account_number = ? AND user_id = ? AND status IN ('placed', 'filled', 'paper', 'placing')"
    )
    .all(cutoff.toISOString(), scopeAccount(accountNumber), userId) as Array<{ proposal: string; estimated_notional: number | null }>;

  return rows.reduce(
    (acc, row) => {
      const proposal = JSON.parse(row.proposal) as { side?: string; dollarAmount?: number; quantity?: number; limitPrice?: number };
      // NB: "opening" = buy OR short. (Named isBuy historically; it always included short.)
      const isOpening = proposal.side === "buy" || proposal.side === "short";
      // Notional caps intentionally count only OPENING trades (buy/short); closing trades (sell/cover) are risk-reducing and exempt (notional = 0).
      const notional = isOpening
        ? (row.estimated_notional != null ? row.estimated_notional : (proposal.dollarAmount ?? (proposal.quantity ?? 0) * (proposal.limitPrice ?? 0)))
        : 0;
      return {
        orderCount: acc.orderCount + 1,
        openingOrderCount: acc.openingOrderCount + (isOpening ? 1 : 0),
        notional: acc.notional + notional
      };
    },
    { orderCount: 0, openingOrderCount: 0, notional: 0 }
  );
}

/**
 * Count day-trades for an account over a rolling N-business-day window ending at `asOf` (PDT gate).
 *
 * Regulatory definition (FINRA Rule 4210 pattern-day-trader): a day-trade is a same-symbol
 * round-trip OPENED and CLOSED on the same calendar day. We detect this from `fill_events`:
 * group fills by symbol + market-calendar day (the America/New_York day, matching the
 * daily-notional boundary), and count a day-trade when that symbol+day has BOTH an opening fill
 * (side buy or short) AND a closing fill (side sell or cover). The PDT rule counts at most one
 * day-trade per symbol per day for this purpose, so each qualifying symbol+day bucket contributes
 * exactly one. The window is the last `businessDays` market days (weekdays) ending at `asOf`'s
 * market day, inclusive; weekend days carry no fills and are skipped.
 */
export function countDayTradesInLastBusinessDays(
  accountNumber: string,
  businessDays: number,
  asOf: Date = new Date(),
  userId: string = "local",
  timeZone: string = DAILY_RESET_TIME_ZONE
): number {
  if (businessDays <= 0) return 0;
  // Walk back from asOf's market day, collecting business days (Mon–Fri) until we have N of them.
  const dayMs = 24 * 60 * 60 * 1000;
  let cursor = startOfDayInTimeZone(asOf, timeZone);
  let collected = 0;
  let windowStart = cursor;
  while (collected < businessDays) {
    // getUTCDay() on a civil-midnight instant identifies the market day's weekday: 0=Sun, 6=Sat.
    const weekday = startOfDayInTimeZone(cursor, timeZone).getUTCDay();
    if (weekday !== 0 && weekday !== 6) {
      collected += 1;
      windowStart = cursor;
    }
    // Step back ~one day, then re-snap to the market-day boundary to stay DST-safe.
    cursor = startOfDayInTimeZone(new Date(cursor.getTime() - dayMs), timeZone);
  }

  const rows = getDb()
    .prepare(
      "SELECT symbol, side, filled_at FROM fill_events WHERE filled_at >= ? AND filled_at <= ? AND account_number = ? AND user_id = ?"
    )
    .all(windowStart.toISOString(), asOf.toISOString(), scopeAccount(accountNumber), userId) as Array<{
    symbol: string;
    side: string;
    filled_at: string;
  }>;

  // Bucket by symbol + market-calendar day; track whether each bucket saw an open and a close.
  const buckets = new Map<string, { opened: boolean; closed: boolean }>();
  for (const row of rows) {
    const marketDay = startOfDayInTimeZone(new Date(row.filled_at), timeZone).toISOString();
    const key = `${row.symbol}__${marketDay}`;
    const bucket = buckets.get(key) ?? { opened: false, closed: false };
    if (row.side === "buy" || row.side === "short") bucket.opened = true;
    if (row.side === "sell" || row.side === "cover") bucket.closed = true;
    buckets.set(key, bucket);
  }

  let dayTrades = 0;
  for (const bucket of buckets.values()) {
    if (bucket.opened && bucket.closed) dayTrades += 1;
  }
  return dayTrades;
}

// ── Run lock ──────────────────────────────────────────────────────────────────
// Uses a direct prepared statement (not setSetting) to avoid noisy policy_change
// audit events.

/** Lock key — per-account when an account id is given, else the legacy user-wide key. */
function strategyLockKey(userId: string, connectedAccountId?: string): string {
  return connectedAccountId ? `strategy_run_lock:${userId}:${connectedAccountId}` : `strategy_run_lock:${userId}`;
}

export function acquireStrategyLock(owner: string, userId: string = "local", connectedAccountId?: string, staleMs = 5 * 60_000, now = new Date()): boolean {
  const database = getDb();
  const key = strategyLockKey(userId, connectedAccountId);
  const acquire = database.transaction(() => {
    const row = database
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get(key) as { value: string } | undefined;

    if (row) {
      try {
        const existing = JSON.parse(row.value) as { owner?: string, expiresAt?: string, lockedAt?: string };
        const expiresAt = existing.expiresAt
          ? new Date(existing.expiresAt).getTime()
          : (existing.lockedAt ? new Date(existing.lockedAt).getTime() + staleMs : 0);
        
        const canWin = expiresAt <= now.getTime() || existing.owner === owner;
        if (!canWin) return false;
      } catch {
        // malformed lock value — treat as absent and reclaim
      }
    }

    const value = JSON.stringify({ owner, acquiredAt: now.toISOString(), expiresAt: new Date(now.getTime() + staleMs).toISOString() });
    database
      .prepare(
        "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
      )
      .run(key, value, now.toISOString());
    return true;
  });

  return acquire.immediate() as boolean;
}

export function renewStrategyLock(owner: string, userId: string = "local", connectedAccountId?: string, staleMs = 5 * 60_000, now = new Date()): boolean {
  const database = getDb();
  const key = strategyLockKey(userId, connectedAccountId);
  const renew = database.transaction(() => {
    const row = database
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get(key) as { value: string } | undefined;

    if (!row) return false;

    try {
      const existing = JSON.parse(row.value) as { owner?: string };
      if (existing.owner !== owner) return false;
    } catch {
      return false; // malformed lock value, can't renew
    }

    const value = JSON.stringify({ owner, acquiredAt: now.toISOString(), expiresAt: new Date(now.getTime() + staleMs).toISOString() });
    database
      .prepare("UPDATE settings SET value = ?, updated_at = ? WHERE key = ?")
      .run(value, now.toISOString(), key);
    return true;
  });

  return renew.immediate() as boolean;
}

export function releaseStrategyLock(owner: string, userId: string = "local", connectedAccountId?: string): void {
  const database = getDb();
  const key = strategyLockKey(userId, connectedAccountId);
  
  database.transaction(() => {
    if (connectedAccountId) {
      const row = database.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
      if (row) {
        try {
          const existing = JSON.parse(row.value) as { owner?: string };
          if (existing.owner === owner) {
            database.prepare("DELETE FROM settings WHERE key = ?").run(key);
          }
        } catch {
          database.prepare("DELETE FROM settings WHERE key = ?").run(key);
        }
      }
      return;
    }

    // No account given: release the user's base lock AND any per-account locks (teardown/back-compat).
    const rows = database
      .prepare("SELECT key, value FROM settings WHERE key = ? OR key LIKE ?")
      .all(`strategy_run_lock:${userId}`, `strategy_run_lock:${userId}:%`) as Array<{ key: string, value: string }>;
      
    for (const r of rows) {
      try {
        const existing = JSON.parse(r.value) as { owner?: string };
        if (existing.owner === owner) {
          database.prepare("DELETE FROM settings WHERE key = ?").run(r.key);
        }
      } catch {
        database.prepare("DELETE FROM settings WHERE key = ?").run(r.key);
      }
    }
  }).immediate();
}

/** Default lease window of `acquireStrategyLock` / `startStrategyLockGuard` (5 min TTL, renewed
 *  every 60s).  Duplicated as a literal rather than imported from `strategy-lock-guard.ts`,
 *  which imports `renewStrategyLock` from this module — importing it back would recreate the
 *  db -> db-execution cycle that PR #3138 already had to break once. */
const STRATEGY_LOCK_LEASE_MS = 5 * 60_000;

/**
 * Durable, cross-process proof that `runId` is still being executed by SOMEONE.
 *
 * `runStrategyOnce` acquires the per-account strategy run lock with the run id itself as `owner`
 * (strategy.ts, `acquireStrategyLock(runId, ...)`) BEFORE `insertStrategyRun` writes the
 * `running` row, and releases it in the `finally` AFTER `finishStrategyRun`.  While the run is
 * in flight `startStrategyLockGuard` renews that lease every 60s with a 5-minute TTL.  So an
 * unexpired lock whose `owner` is the run id is durable evidence the run is alive — evidence
 * that survives a process boundary, unlike `isStrategyRunExecutionLive`, whose map is
 * process-local by construction and is EMPTY for a run another node legitimately adopted.
 *
 * Scans BOTH lock-key shapes for the user — the account-scoped `strategy_run_lock:<u>:<acct>`
 * and the legacy user-wide `strategy_run_lock:<u>` — rather than deriving one key from the run
 * row's `connected_account_id`.  `runStrategyOnce` locks under the account it resolved at entry,
 * which is not guaranteed to be the id later persisted on the row, and the drain path releases
 * with no account id at all; matching on `owner === runId` is the exact, shape-independent test.
 */
export function hasLiveStrategyRunLease(
  runId: string,
  userId: string,
  nowMs: number = Date.now()
): boolean {
  try {
    const database = getDb();
    // Optimized index scan: replaces `key = ? OR key LIKE ?` which caused a full table scan.
    // `:` is ASCII 58, `;` is ASCII 59, so `< ...;` cleanly bounds the exact key and all `:` prefixed subkeys.
    const rows = database
      .prepare("SELECT value FROM settings WHERE key >= ? AND key < ?")
      .all(`strategy_run_lock:${userId}`, `strategy_run_lock:${userId};`) as Array<{ value: string }>;
    for (const row of rows) {
      let parsed: { owner?: string; expiresAt?: string; acquiredAt?: string; lockedAt?: string };
      try {
        parsed = JSON.parse(row.value) as typeof parsed;
      } catch {
        continue; // malformed lock value is not evidence of life
      }
      if (parsed.owner !== runId) continue;
      const expiresAt = parsed.expiresAt
        ? Date.parse(parsed.expiresAt)
        : (parsed.acquiredAt ?? parsed.lockedAt)
          ? Date.parse((parsed.acquiredAt ?? parsed.lockedAt)!) + STRATEGY_LOCK_LEASE_MS
          : NaN;
      if (Number.isFinite(expiresAt) && expiresAt > nowMs) return true;
    }
    return false;
  } catch {
    // A settings read fault must not be read as "definitely dead" — money-path sweeps fail closed
    // by LEAVING the run alone.  A genuinely crashed run is swept on the next tick.
    return true;
  }
}

export function insertStrategyRun(id: string, userId: string = "local", connectedAccountId?: string, accountNumber?: string, policyRevision?: string): void {
  const existing = getDb()
    .prepare("SELECT status FROM strategy_runs WHERE id = ? AND user_id = ?")
    .get(id, userId) as { status: string } | undefined;
  if (existing) {
    // Drain re-adopts a claimed Manual Run once whose HTTP kick died after this
    // insert (live Roth `9d71dda4`).  Resume the same row; do not mint a second.
    if (existing.status === "running") return;
    throw new Error(`Cannot reuse strategy run ${id} after status=${existing.status}`);
  }
  getDb()
    .prepare("INSERT INTO strategy_runs (id, user_id, connected_account_id, account_number, policy_revision, started_at, status) VALUES (?, ?, ?, ?, ?, ?, 'running')")
    .run(id, userId, connectedAccountId ?? null, accountNumber ?? null, policyRevision ?? null, new Date().toISOString());
}

/**
 * Live Roth `b3b83913` (2026-08-18): Manual Run once wrote the run row, then sat
 * llm=0 for ~17m with no gather/Green because `roic-transcript-refresh` and
 * `ftsMirrorSlice` owned the one Node event loop.  Background RAG is process-wide
 * (not per-user): any in-flight run or queued/running request on this process
 * must pause ROIC / FTS so Green can start.
 */
export function shouldDeferBackgroundRagForStrategy(input: {
  strategyWorkInFlight: boolean;
  force?: boolean;
}): boolean {
  return input.strategyWorkInFlight && input.force !== true;
}

/**
 * Live Roth `9d71dda4` (2026-08-19): same window as the Robinhood max-10 reject
 * also listed/fetched the whole Pinecone index (managed-vector-reconcile
 * inventory).  Gather retrieval is query/id scoped.  A queued or running
 * strategy run must not start or continue a whole-index list/fetch.  Account
 * deletion still inventories so erasure can finish.  Do not flip
 * `RAG_PINECONE_WRITE_CLASS`.  Do not prune the live index.
 */
export function shouldSkipWholeIndexInventory(input: {
  strategyWorkInFlight: boolean;
  accountDeletionRequestId?: string;
  allowDuringStrategyWork?: boolean;
}): boolean {
  if (input.allowDuringStrategyWork) return false;
  if (input.accountDeletionRequestId) return false;
  return input.strategyWorkInFlight;
}

export function hasInFlightStrategyWork(): boolean {
  const db = getDb();
  const run = db.prepare("SELECT 1 FROM strategy_runs WHERE status = 'running' LIMIT 1").get();
  if (run) return true;
  const request = db
    .prepare("SELECT 1 FROM strategy_run_requests WHERE status IN ('queued', 'running') LIMIT 1")
    .get();
  return Boolean(request);
}

// 30 min — raised from 10 min after a 2026-07-08 incident: an evening run (id 5d49c9b5) with
// slow LLM steps (150s+ each observed under load) was still genuinely running past the old 10-min
// threshold, got marked "crashed" by this sweep at the ~11-minute mark, and then completed 5s later
// having already placed 4 real trades — a live run was declared dead while it was still trading.
// 30 min comfortably clears worst-case multi-step LLM runs with margin; a tick-cadence run still
// normally finishes in ~1-2 min, so this only widens the window for the genuine crash case, it
// doesn't meaningfully delay detecting an actual stuck/killed process.
const STALE_RUN_THRESHOLD_MS = 30 * 60_000;

/** Boot instant, same formula as `runtime-health` `PROCESS_STARTED_AT_MS`, captured on FIRST USE
 *  rather than at module load.  This module is reachable from the browser bundle through the
 *  `db` barrel (`app/console/settings/brokers.tsx` -> `venue-contract` -> `source-settings` ->
 *  `db-api-keys` -> `db`); webpack stubs `better-sqlite3` for that bundle but Next's browser
 *  `process` shim has no `uptime`, so a module-scope `process.uptime()` threw
 *  "process.uptime is not a function" and took down `/console/connections` (2026-08-18, #2848).
 *  Guarded + lazy: server callers get the real boot instant; a browser evaluation never throws. */
let processStartedAtMsCache: number | null = null;
function processStartedAtMs(): number {
  if (processStartedAtMsCache === null) {
    const uptimeSeconds =
      typeof process !== "undefined" && typeof process.uptime === "function" ? process.uptime() : 0;
    processStartedAtMsCache = Date.now() - Math.round(uptimeSeconds * 1000);
  }
  return processStartedAtMsCache;
}
/** Uptime rounding can place boot a few hundred ms after the first Date.now() in this process.
 *  Only treat a run as a prior-process leftover when it started clearly before boot. */
const PROCESS_RESTART_DETECT_SKEW_MS = 2_000;

export type StaleRunningSweepCause = "process_restarted_mid_run" | "stalled_no_progress";

/** A 30m gather stall on the same process is not a restart.  Roth `b3b83913` started after
 *  `processStartedAt` 23:10:43Z, sat llm=0, and the sweep still wrote "Process restarted mid-run". */
export function staleRunningRunSweepCause(
  startedAt: string,
  processStartedMs: number = processStartedAtMs()
): StaleRunningSweepCause {
  const startedMs = Date.parse(startedAt);
  if (Number.isFinite(startedMs) && startedMs < processStartedMs - PROCESS_RESTART_DETECT_SKEW_MS) {
    return "process_restarted_mid_run";
  }
  return "stalled_no_progress";
}

export function staleRunningRunSweepSummary(
  startedAt: string,
  processStartedMs: number = processStartedAtMs()
): string {
  const cause = staleRunningRunSweepCause(startedAt, processStartedMs);
  switch (cause) {
    case "process_restarted_mid_run":
      return `Process restarted mid-run — marked failed by stale-run sweep (started at ${startedAt})`;
    case "stalled_no_progress":
      return `Strategy run stalled with no progress — marked failed by stale-run sweep (started at ${startedAt})`;
    default: {
      const _exhaustive: never = cause;
      throw new Error(`unhandled stale running sweep cause: ${String(_exhaustive)}`);
    }
  }
}

/**
 * Manual Run once persists `strategy_run_requests.id` and then passes that same UUID to
 * `runStrategyOnce` as `runId`, so the request row and the `strategy_runs` row share an id.
 * `queueStrategyRunRequest` refuses a second click while any request for that user is still
 * `queued` or `running`.  Closing the matching open request here is the write-path coupling:
 * a terminal run must not leave the request in `running` (the 2026-08-18 Roth orphan
 * `0e5ccd66` was sweep-failed while its request stayed `running`, so the next Manual Run once
 * 502'd and wrote no new `strategy_runs` row).
 *
 * Kept in this module (getDb-only) so `strategy-run-requests.ts` is not imported — that file
 * imports `strategy.ts`, which calls `finishStrategyRun`.
 */
function closeMatchingStrategyRunRequest(
  runId: string,
  requestStatus: "completed" | "failed",
  summary: string,
  finishedAt: string,
): void {
  getDb()
    .prepare(
      `UPDATE strategy_run_requests
       SET status = ?, result = ?, finished_at = ?
       WHERE id = ? AND status IN ('queued', 'running')`
    )
    .run(
      requestStatus,
      JSON.stringify({ runId, status: requestStatus, summary, proposals: [] }),
      finishedAt,
      runId
    );
}

/**
 * Close open `strategy_run_requests` whose matching `strategy_runs` row is already
 * terminal (live Roth `0e5ccd66` after the stale sweep wrote only the run).  Optional
 * `userId` scopes the heal to one user so Manual Run once can clear that user's lock
 * on the click without waiting for the next scheduler tick.
 */
export function closeOrphanedStrategyRunRequests(nowMs: number = Date.now(), userId?: string): void {
  const db = getDb();
  const finishedAt = new Date(nowMs).toISOString();
  const cutoff = new Date(nowMs - STALE_RUN_THRESHOLD_MS).toISOString();

  // Already-terminal run + still-open request (the live Roth lock after a sweep that only
  // wrote strategy_runs).  Close immediately; do not wait another 30 minutes.
  const mismatched = (
    userId
      ? db
          .prepare(
            `SELECT r.id AS id, s.status AS run_status, s.summary AS run_summary
             FROM strategy_run_requests r
             INNER JOIN strategy_runs s ON s.id = r.id
             WHERE r.user_id = ?
               AND r.status IN ('queued', 'running')
               AND s.status != 'running'`
          )
          .all(userId)
      : db
          .prepare(
            `SELECT r.id AS id, s.status AS run_status, s.summary AS run_summary
             FROM strategy_run_requests r
             INNER JOIN strategy_runs s ON s.id = r.id
             WHERE r.status IN ('queued', 'running')
               AND s.status != 'running'`
          )
          .all()
  ) as Array<{ id: string; run_status: string; run_summary: string | null }>;
  for (const row of mismatched) {
    const failed = row.run_status === "failed";
    closeMatchingStrategyRunRequest(
      row.id,
      failed ? "failed" : "completed",
      row.run_summary ?? "Matching strategy run already finished",
      finishedAt
    );
  }

  // Claimed or queued request whose strategy_runs row was never written, older than the same
  // stale-run window.  Fresh queued rows (the live Manual Run once queue) are left alone.
  const stranded = (
    userId
      ? db
          .prepare(
            `SELECT id FROM strategy_run_requests
             WHERE user_id = ?
               AND status IN ('queued', 'running')
               AND created_at < ?
               AND NOT EXISTS (SELECT 1 FROM strategy_runs WHERE strategy_runs.id = strategy_run_requests.id)`
          )
          .all(userId, cutoff)
      : db
          .prepare(
            `SELECT id FROM strategy_run_requests
             WHERE status IN ('queued', 'running')
               AND created_at < ?
               AND NOT EXISTS (SELECT 1 FROM strategy_runs WHERE strategy_runs.id = strategy_run_requests.id)`
          )
          .all(cutoff)
  ) as Array<{ id: string }>;
  for (const row of stranded) {
    closeMatchingStrategyRunRequest(
      row.id,
      "failed",
      "No matching strategy run — marked failed by stale-run sweep",
      finishedAt
    );
  }
}

/** Terminal statuses for strategy_runs.
 *  - completed: a decision cycle ran (LLM evaluated candidates, even if it proposed nothing)
 *  - skipped_* / skipped: pre-decision gate — no successful evaluation (UX PR-A1)
 *  - failed: hard error
 * Skips must NOT feed trading-liveness "healthy" or auto-tune. */
export function finishStrategyRun(id: string, status: StrategyRunFinishStatus, summary: string, userId: string = "local"): void {
  const finishedAt = new Date().toISOString();
  getDb()
    .prepare("UPDATE strategy_runs SET finished_at = ?, status = ?, summary = ? WHERE id = ? AND user_id = ?")
    .run(finishedAt, status, summary, id, userId);
  closeMatchingStrategyRunRequest(
    id,
    status === "failed" ? "failed" : "completed",
    summary,
    finishedAt
  );
}

/**
 * Sweep strategy_runs rows left in status='running' after a process crash / kill / unhandled
 * rejection (the normal `finishStrategyRun` exit paths never ran). A run that hasn't finished
 * within STALE_THRESHOLD_MS (default 30 min) is marked failed with a receipted reason — UNLESS it
 * still has recent audit activity (see the in-loop check below), in which case it's left alone.
 * The reason is a process-restart leftover only when `started_at` predates this process boot.
 * A same-process 30m stall with llm=0 (Roth `b3b83913`) is `stalled_no_progress`, not a restart.
 *
 * Also closes any matching open `strategy_run_requests` row (same UUID) so Manual Run once
 * is not left locked after the run is marked failed.  A later tick heals already-failed
 * runs whose request was left `running` by an older process.
 *
 * Returns the number of repaired strategy_runs rows for logging/auditing.
 */
export function markStaleRunningRuns(now: number = Date.now()): number {
  const cutoff = new Date(now - STALE_RUN_THRESHOLD_MS).toISOString();
  const processStarted = processStartedAtMs();
  const processBootCutoff = new Date(processStarted - PROCESS_RESTART_DETECT_SKEW_MS).toISOString();
  const db = getDb();
  const stale = db
    .prepare(
      `SELECT id, user_id, connected_account_id, started_at FROM strategy_runs
       WHERE status = 'running' AND (started_at < ? OR started_at < ?)`
    )
    .all(cutoff, processBootCutoff) as Array<{
      id: string;
      user_id: string;
      connected_account_id: string | null;
      started_at: string;
    }>;
  let count = 0;
  for (const row of stale) {
    if (isStrategyRunExecutionLive(row.id)) continue;
    // Pre-boot grace (money path).  `started_at >= cutoff` means this row is NOT time-stale — the
    // restart sweep alone selected it, purely because it started before this process booted.  On a
    // multi-instance deploy (and during a rolling restart) that is exactly the shape of a run
    // another node legitimately adopted seconds ago: `isStrategyRunExecutionLive` cannot see it,
    // and a run that young has usually emitted no `$.runId` audit row yet, so both existing graces
    // miss it and the sweep marks a LIVE trading run failed mid-flight — and frees its request row
    // for a duplicate.  An unexpired strategy run lock owned by the run id is durable, cross-process
    // proof of ownership, renewed every 60s by `startStrategyLockGuard`; honour it here.
    //
    // Deliberately NOT applied to the time-stale path: a wedged run whose lock guard interval keeps
    // renewing must still be swept after STALE_RUN_THRESHOLD_MS, which is the stuck-run bug the
    // sweep exists to fix.
    const preBootOnly = row.started_at >= cutoff;
    if (preBootOnly && hasLiveStrategyRunLease(row.id, row.user_id, now)) continue;
    const cause = staleRunningRunSweepCause(row.started_at, processStarted);
    // Unconditional audit activity grace: check if the run is still emitting audit rows recently
    const recentActivity = db
      .prepare(`SELECT 1 FROM audit_events WHERE json_extract(payload, '$.runId') = ? AND created_at >= ? LIMIT 1`)
      .get(row.id, cutoff);
    if (recentActivity) continue;

    const finishedAt = new Date(now).toISOString();
    const summary = staleRunningRunSweepSummary(row.started_at, processStarted);
    const res = db
      .prepare(
        `UPDATE strategy_runs SET status = 'failed', finished_at = ?, summary = ?
         WHERE id = ? AND status = 'running'`
      )
      .run(finishedAt, summary, row.id);
    // Only receipt+count rows this sweep actually transitioned. If a concurrent scheduler
    // instance already repaired the row between our SELECT and UPDATE, `changes === 0` — skip
    // it so we don't emit a duplicate `strategy_run_crashed` audit or over-report `count`.
    if (res.changes === 0) continue;
    closeMatchingStrategyRunRequest(row.id, "failed", summary, finishedAt);
    // `audit` is imported statically from ./db (top of file). The db → db-execution cycle is safe
    // under ESM live bindings because audit is only called here at runtime, never at module init.
    audit(
      "strategy_run_crashed",
      {
        runId: row.id,
        startedAt: row.started_at,
        reason: cause,
        processStartedAt: new Date(processStartedAtMs()).toISOString()
      },
      row.user_id,
      // Scope the receipt to the run's account so per-account ops queries can filter it.
      row.connected_account_id ?? undefined
    );
    count++;
  }
  closeOrphanedStrategyRunRequests(now);
  return count;
}

/**
 * Most recent strategy-run start time for a user (ISO string), or null if none. The scheduler
 * rehydrates its in-memory cadence clock from this on boot so a restart/HMR/deploy doesn't fire an
 * immediate run regardless of the configured cadence (userSchedules starts empty each process).
 */
export function getLastStrategyRunStartedAt(userId: string = "local", connectedAccountId?: string): string | null {
  const row = (connectedAccountId
    ? getDb()
        .prepare("SELECT MAX(started_at) AS last FROM strategy_runs WHERE user_id = ? AND connected_account_id = ?")
        .get(userId, connectedAccountId)
    : getDb()
        .prepare("SELECT MAX(started_at) AS last FROM strategy_runs WHERE user_id = ?")
        .get(userId)) as { last: string | null } | undefined;
  return row?.last ?? null;
}

export function listStrategyRuns(limit = 20, userId: string = "local", connectedAccountId?: string): StrategyRunRow[] {
  type RawRow = {
    id: string;
    started_at: string;
    finished_at: string | null;
    status: string;
    summary: string | null;
    connected_account_id: string | null;
    placed_count: number;
    paper_count: number;
    blocked_count: number;
    proposed_count: number;
    total_count: number;
  };

  const selectSql = `SELECT
        sr.id,
        sr.started_at,
        sr.finished_at,
        sr.status,
        sr.summary,
        sr.connected_account_id,
        COUNT(CASE WHEN tp.status IN ('placed', 'filled') THEN 1 END) AS placed_count,
        COUNT(CASE WHEN tp.status = 'paper'    THEN 1 END) AS paper_count,
        COUNT(CASE WHEN tp.status = 'blocked'  THEN 1 END) AS blocked_count,
        COUNT(CASE WHEN tp.status = 'proposed' THEN 1 END) AS proposed_count,
        COUNT(tp.id)                                        AS total_count
       FROM strategy_runs sr
       LEFT JOIN trade_proposals tp ON tp.run_id = sr.id
       WHERE sr.user_id = ?${connectedAccountId ? " AND sr.connected_account_id = ?" : ""}
       GROUP BY sr.id
       ORDER BY sr.started_at DESC
       LIMIT ?`;
  const rows = getDb()
    .prepare(selectSql)
    .all(...(connectedAccountId ? [userId, connectedAccountId, limit] : [userId, limit])) as RawRow[];

  return rows.map((r) => ({
    id: r.id,
    startedAt: r.started_at,
    finishedAt: r.finished_at ?? undefined,
    status: r.status as StrategyRunRow["status"],
    summary: r.summary ?? undefined,
    connectedAccountId: r.connected_account_id ?? undefined,
    placedCount: r.placed_count,
    paperCount: r.paper_count,
    blockedCount: r.blocked_count,
    proposedCount: r.proposed_count,
    totalCount: r.total_count
  }));
}

export function getStrategyRunById(id: string, userId: string = "local"): StrategyRunRow | undefined {
  type RawRow = {
    id: string;
    started_at: string;
    finished_at: string | null;
    status: string;
    summary: string | null;
    connected_account_id: string | null;
    placed_count: number;
    paper_count: number;
    blocked_count: number;
    proposed_count: number;
    total_count: number;
  };
  const row = getDb()
    .prepare(
      `SELECT sr.id, sr.started_at, sr.finished_at, sr.status, sr.summary, sr.connected_account_id,
              COUNT(CASE WHEN tp.status IN ('placed', 'filled') THEN 1 END) AS placed_count,
              COUNT(CASE WHEN tp.status = 'paper'    THEN 1 END) AS paper_count,
              COUNT(CASE WHEN tp.status = 'blocked'  THEN 1 END) AS blocked_count,
              COUNT(CASE WHEN tp.status = 'proposed' THEN 1 END) AS proposed_count,
              COUNT(tp.id)                                        AS total_count
         FROM strategy_runs sr
         LEFT JOIN trade_proposals tp ON tp.run_id = sr.id
        WHERE sr.id = ? AND sr.user_id = ?
        GROUP BY sr.id`
    )
    .get(id, userId) as RawRow | undefined;

  return row
    ? {
        id: row.id,
        startedAt: row.started_at,
        finishedAt: row.finished_at ?? undefined,
        status: row.status as StrategyRunRow["status"],
        summary: row.summary ?? undefined,
        connectedAccountId: row.connected_account_id ?? undefined,
        placedCount: row.placed_count,
        paperCount: row.paper_count,
        blockedCount: row.blocked_count,
        proposedCount: row.proposed_count,
        totalCount: row.total_count
      }
    : undefined;
}
