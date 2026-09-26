import { randomUUID } from "crypto";
import { audit, getDb } from "./db";
import {
  closeOrphanedStrategyRunRequests,
  releaseStrategyLock
} from "./db-execution";
import { runStrategyOnce, type StrategyResult } from "./strategy";
import { restartRetryDropReason } from "./strategy-run-retry";

export type StrategyRunRequestStatus = "queued" | "running" | "completed" | "failed";

export type StrategyRunRequest = {
  id: string;
  userId: string;
  manual: boolean;
  status: StrategyRunRequestStatus;
  result: StrategyResult | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

type QueueResult = { request: StrategyRunRequest; deduped: boolean };

function nowIso(): string {
  return new Date().toISOString();
}

function rowToRequest(row: {
  id: string;
  user_id: string;
  manual: number;
  status: StrategyRunRequestStatus;
  result: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}): StrategyRunRequest {
  return {
    id: row.id,
    userId: row.user_id,
    manual: row.manual === 1,
    status: row.status,
    result: row.result ? (JSON.parse(row.result) as StrategyResult) : null,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at
  };
}

export function getStrategyRunRequest(runId: string, userId: string): StrategyRunRequest | null {
  const row = getDb()
    .prepare(
      `SELECT id, user_id, manual, status, result, created_at, started_at, finished_at
       FROM strategy_run_requests
       WHERE id = ? AND user_id = ?`
    )
    .get(runId, userId) as
    | {
        id: string;
        user_id: string;
        manual: number;
        status: StrategyRunRequestStatus;
        result: string | null;
        created_at: string;
        started_at: string | null;
        finished_at: string | null;
      }
    | undefined;
  return row ? rowToRequest(row) : null;
}

export function queueStrategyRunRequest(input: { userId: string; manual?: boolean }): QueueResult {
  // Live 0e5ccd66: strategy_runs was already sweep-failed; the request stayed running.
  // Heal this user first so the next Manual Run once click is not deduped onto the orphan.
  // A genuinely running request (matching strategy_runs still running) is left alone.
  closeOrphanedStrategyRunRequests(Date.now(), input.userId);
  const db = getDb();
  const existing = db
    .prepare(
      `SELECT id, user_id, manual, status, result, created_at, started_at, finished_at
       FROM strategy_run_requests
       WHERE user_id = ? AND status IN ('queued', 'running')
       ORDER BY created_at ASC
       LIMIT 1`
    )
    .get(input.userId) as
    | {
        id: string;
        user_id: string;
        manual: number;
        status: StrategyRunRequestStatus;
        result: string | null;
        created_at: string;
        started_at: string | null;
        finished_at: string | null;
      }
    | undefined;
  // Dedupes on any remaining open request for this user.  Do not ignore `running` here —
  // a live overlapping run must still serialize.  Sweep-failed orphans are closed above.
  if (existing) {
    return { request: rowToRequest(existing), deduped: true };
  }
  const createdAt = nowIso();
  const request: StrategyRunRequest = {
    id: randomUUID(),
    userId: input.userId,
    manual: input.manual === true,
    status: "queued",
    result: null,
    createdAt,
    startedAt: null,
    finishedAt: null
  };
  db.prepare(
    `INSERT INTO strategy_run_requests
      (id, user_id, manual, status, result, created_at, started_at, finished_at)
     VALUES (?, ?, ?, 'queued', NULL, ?, NULL, NULL)`
  ).run(request.id, request.userId, request.manual ? 1 : 0, request.createdAt);
  return { request, deduped: false };
}

/**
 * Live Roth `9d71dda4` (c55c2e64, 2026-08-19): Manual Run once queued, the HTTP
 * `void` kick claimed the row, `insertStrategyRun` wrote `running`, then
 * `strategy-run-drain` journaled skipped=every-tick (processed=0) because this
 * worker only selected `queued`.  Background ROIC/FTS/embed were already
 * skipped.  Green / `llm_usage` never started.  Sweep-failed 01:29:44Z
 * `stalled_no_progress` after ~31m on the same process.  A claimed request
 * with no live in-process heartbeat is an orphan — drain must resume that
 * same id so the 202 runId Activity is polling is the row that gets `llm_usage`.
 *
 * Presence on this process is the liveness signal, not the beat timestamp.
 * A 90s age check treated an event-loop freeze (SQLite busy_timeout 60s, and
 * measured >120s back-to-back stalls) as a dead worker, then
 * `releaseStrategyLock` + a second `runStrategyOnce` on the same id.  The
 * still-running gather can already have passed `assertOwned` before place,
 * so the adopted run double-places.  A hung worker on this process must
 * stay single-flight; only a missing map entry (process restart) is an orphan.
 */
export const STRATEGY_RUN_EXECUTION_STALE_MS = 90_000;

import {
  isStrategyRunExecutionLive,
  beginStrategyRunExecution,
  resetStrategyRunExecutionsForTest
} from "./strategy-run-execution-registry";

export {
  isStrategyRunExecutionLive,
  beginStrategyRunExecution,
  resetStrategyRunExecutionsForTest
};

/** Close a restart-retry request without running it, with a receipt on the request and in audit. */
function dropRestartRetryRequest(
  row: { id: string; user_id: string; connected_account_id: string | null; retry_of_run_id: string | null },
  reason: string,
  fromStatus: "queued" | "running"
): void {
  const summary =
    reason === "interrupted_again"
      ? "Restart retry was itself interrupted by a process restart — not retried again (max one retry)."
      : `Restart retry not run: ${reason.replace(/_/g, " ")}.`;
  const failed: StrategyResult = { runId: row.id, status: "failed", summary, proposals: [] };
  const res = getDb()
    .prepare(
      `UPDATE strategy_run_requests
       SET status = 'failed', result = ?, finished_at = ?
       WHERE id = ? AND status = ?`
    )
    .run(JSON.stringify(failed), nowIso(), row.id, fromStatus);
  if (res.changes !== 1) return;
  try {
    audit(
      "strategy_run_retry_dropped",
      { retryRunId: row.id, killedRunId: row.retry_of_run_id, reason },
      row.user_id,
      row.connected_account_id ?? undefined
    );
  } catch (err) {
    console.error("[strategy-run-requests] retry drop receipt failed:", err);
  }
}

export type ProcessPendingStrategyRunResult = {
  processed: number;
  adopted: number;
  liveRunning: number;
};

export async function processPendingStrategyRunRequests(
  options: { limit?: number } = {}
): Promise<ProcessPendingStrategyRunResult> {
  const limit = Math.max(1, options.limit ?? 1);
  const db = getDb();
  type RequestRow = {
    id: string;
    user_id: string;
    manual: number;
    created_at: string;
    connected_account_id: string | null;
    retry_of_run_id: string | null;
  };
  const queued = db
    .prepare(
      `SELECT id, user_id, manual, created_at, connected_account_id, retry_of_run_id
       FROM strategy_run_requests
       WHERE status = 'queued'
       ORDER BY created_at ASC
       LIMIT ?`
    )
    .all(limit) as RequestRow[];
  const running = db
    .prepare(
      `SELECT id, user_id, manual, created_at, connected_account_id, retry_of_run_id
       FROM strategy_run_requests
       WHERE status = 'running'
       ORDER BY created_at ASC
       LIMIT ?`
    )
    .all(limit) as RequestRow[];

  const liveRunning = running.filter((row) => isStrategyRunExecutionLive(row.id)).length;
  const adoptedRows = running.filter((row) => !isStrategyRunExecutionLive(row.id));
  const work: Array<RequestRow & { adopt: boolean }> = [
    ...queued.map((row) => ({ ...row, adopt: false })),
    ...adoptedRows.map((row) => ({ ...row, adopt: true }))
  ].slice(0, limit);

  let processed = 0;
  let adopted = 0;
  for (const candidate of work) {
    const row = candidate;
    if (isStrategyRunExecutionLive(row.id)) continue;
    // Restart retries (board 687a5fb4, strategy-run-retry.ts): at most ONE attempt, ever.  A retry
    // found `running` with no live execution was itself killed by another restart — never adopt
    // (re-run) it; close it with a receipt.  A queued retry is re-validated right before it runs
    // (account still active, session open, nothing placed, no newer run) and dropped if not.
    if (row.retry_of_run_id) {
      const dropReason = row.adopt
        ? "interrupted_again"
        : restartRetryDropReason({
            id: row.id,
            userId: row.user_id,
            connectedAccountId: row.connected_account_id,
            retryOfRunId: row.retry_of_run_id,
            createdAt: row.created_at
          });
      if (dropReason) {
        dropRestartRetryRequest(row, dropReason, row.adopt ? "running" : "queued");
        continue;
      }
    }
    if (row.adopt) {
      // Resume the same id.  Manual Run once returns this UUID in the 202;
      // Activity polls it.  A new id would get llm_usage while the click
      // stayed failed/running.  The leftover kick is gone after a process
      // restart (empty heartbeat map).  In-process, a live heartbeat is
      // left alone above.  Drop a stale lock so this worker can acquire it.
      releaseStrategyLock(row.id, row.user_id);
    }

    const startedAt = nowIso();
    const claim = db
      .prepare(
        row.adopt
          ? `UPDATE strategy_run_requests
             SET status = 'running', started_at = COALESCE(started_at, ?)
             WHERE id = ? AND status = 'running'`
          : `UPDATE strategy_run_requests
             SET status = 'running', started_at = ?
             WHERE id = ? AND status = 'queued'`
      )
      .run(startedAt, row.id);
    if (claim.changes !== 1) continue;

    const execution = beginStrategyRunExecution(row.id);
    try {
      const result = await runStrategyOnce(row.user_id, {
        manual: row.manual === 1,
        runId: row.id,
        // Account-targeted rows (restart retries) run on THAT account, not the user's active one.
        ...(row.connected_account_id ? { connectedAccountId: row.connected_account_id } : {})
      });
      if (execution.owns()) {
        db.prepare(
          `UPDATE strategy_run_requests
           SET status = ?, result = ?, finished_at = ?
           WHERE id = ?`
        ).run(result.status === "failed" ? "failed" : "completed", JSON.stringify(result), nowIso(), row.id);
      }
    } catch (error) {
      if (execution.owns()) {
        const failed: StrategyResult = {
          runId: row.id,
          status: "failed",
          summary: error instanceof Error ? error.message : String(error),
          proposals: []
        };
        db.prepare(
          `UPDATE strategy_run_requests
           SET status = 'failed', result = ?, finished_at = ?
           WHERE id = ?`
        ).run(JSON.stringify(failed), nowIso(), row.id);
      }
    } finally {
      execution.stop();
    }
    processed += 1;
    if (candidate.adopt) adopted += 1;
  }
  return { processed, adopted, liveRunning };
}
