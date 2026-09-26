/**
 * One-time retry of a strategy run killed by a process restart (board 687a5fb4, 2026-09-24).
 *
 * Production, Alpaca Paper, last 50 runs 2026-09-22 13:39Z -> 09-24 19:20Z: 11 runs finished
 * "Process restarted mid-run — marked failed by stale-run sweep".  Operators restart the container
 * roughly every 20 minutes during RTH event-loop stalls, and a killed run was simply lost.
 *
 * When the stale-run sweep transitions a run running -> failed with cause
 * `process_restarted_mid_run`, this module queues ONE `strategy_run_requests` row for that run's
 * account — only when every condition below holds.  The same conditions are re-checked when the
 * drain picks the row up (strategy-run-requests.ts), so a retry that became unsafe while queued is
 * dropped with a receipt instead of run.
 *
 * Why this cannot double-place (the idempotency argument):
 *   1. Strategy placement persists an idempotency-keyed `placing` trade_proposals row (run_id +
 *      refId, the broker clientOrderId) BEFORE it calls the broker, and skips the broker call if
 *      that insert fails (strategy.ts, "Atomic, crash-recoverable placement").  So a killed run
 *      with ZERO trade_proposals rows provably never reached `placeEquityOrder`; an order the
 *      broker accepted whose post-write was lost still leaves its `placing` row — which disables
 *      the retry — and `flagStalePlacingIntents` reconciles it by refId.  No broker-side listing
 *      is needed (and none is possible by run: refIds are random UUIDs, not run-prefixed).
 *   2. Any proposal, fill, or Socratic decision row for the run disables the retry — stricter
 *      than "placed": a `proposed` row awaiting approval would otherwise be duplicated.
 *   3. The enqueue happens only for a row THIS sweep call transitioned (`UPDATE … WHERE
 *      status='running'`, changes === 1) and the partial UNIQUE index on `retry_of_run_id` makes
 *      "at most one retry per killed run" a database invariant.  A retry is never itself retried
 *      (lineage check) and a retry interrupted by another restart is never adopted by the drain.
 *   4. The retry executes through `runStrategyOnce`, which takes the per-account strategy run lock
 *      before writing its run row; if the "killed" run were somehow alive elsewhere, its renewed
 *      lease blocks the retry (and a live lease also blocks the enqueue).
 *   Protective work a run does before proposals (fill reconcile, stale-exit replacement,
 *   synthetic stops) runs every scheduler tick anyway under its own intent rows and the account
 *   mutation lease; a retry re-running it adds no placement path that does not already exist.
 *
 * Deliberately NOT retried: Manual Run once / API-requested runs (owner-initiated — the owner
 * re-clicks; a manual run is also propose-only and must not come back as an autonomous one), runs
 * with a run-scoped trigger override (e.g. close_only — a plain retry would not carry it), runs
 * with no account id, and anything outside the account's allowed session.
 */

import { randomUUID } from "crypto";
import { audit, getDb, getPolicy } from "./db";
import { hasLiveStrategyRunLease, sweepStaleRunningRuns, type RestartKilledRun } from "./db-execution";
import { isRunAllowedNow } from "./market-hours";
import type { TradingPolicy } from "./types";

/** A queued retry older than this is dropped at drain time — the "lost slot" it was meant to
 *  refill is stale and the next cadence run is close. */
export const RESTART_RETRY_MAX_QUEUE_AGE_MS = 10 * 60_000;

export type RestartRetrySkipReason =
  | "no_account"
  | "run_not_failed"
  | "killed_run_was_retry"
  | "request_driven_run"
  | "already_retried"
  | "wrote_proposals"
  | "wrote_fills"
  | "wrote_decisions"
  | "run_scoped_override"
  | "live_lease"
  | "account_not_active"
  | "session_closed"
  | "newer_run"
  | "open_request"
  | "expired"
  | "killed_run_missing";

export type RestartRetryDeps = {
  /** Session gate.  Default: the scheduler's own `isRunAllowedNow(policy.runDuringExtendedHours)`. */
  sessionAllows?: (policy: TradingPolicy, nowMs: number) => boolean;
};

type KilledRunRef = Pick<RestartKilledRun, "id" | "userId" | "connectedAccountId" | "startedAt">;

export type RestartRetryEligibility =
  | { eligible: true }
  | { eligible: false; reason: RestartRetrySkipReason };

function defaultSessionAllows(policy: TradingPolicy, nowMs: number): boolean {
  return isRunAllowedNow(policy.runDuringExtendedHours === true, new Date(nowMs));
}

/**
 * Every condition a retry of `killed` must meet.  Pure reads; safe to call at enqueue and again at
 * drain time (`ignoreRequestId` = the queued retry itself, which must not count against itself).
 */
export function evaluateRestartRetryEligibility(
  killed: KilledRunRef,
  nowMs: number = Date.now(),
  deps: RestartRetryDeps = {},
  options: { ignoreRequestId?: string } = {}
): RestartRetryEligibility {
  const db = getDb();
  const ignore = options.ignoreRequestId ?? "";
  if (!killed.connectedAccountId) return { eligible: false, reason: "no_account" };

  const run = db
    .prepare("SELECT status FROM strategy_runs WHERE id = ? AND user_id = ?")
    .get(killed.id, killed.userId) as { status: string } | undefined;
  if (!run) return { eligible: false, reason: "killed_run_missing" };
  if (run.status !== "failed") return { eligible: false, reason: "run_not_failed" };

  // Lineage: a run that came from a request row is either a retry (never retried again) or an
  // owner-initiated Manual Run once / API run (the owner re-clicks).
  const ownRequest = db
    .prepare("SELECT retry_of_run_id FROM strategy_run_requests WHERE id = ?")
    .get(killed.id) as { retry_of_run_id: string | null } | undefined;
  if (ownRequest) {
    return { eligible: false, reason: ownRequest.retry_of_run_id ? "killed_run_was_retry" : "request_driven_run" };
  }
  if (
    db
      .prepare("SELECT 1 FROM strategy_run_requests WHERE retry_of_run_id = ? AND id != ? LIMIT 1")
      .get(killed.id, ignore)
  ) {
    return { eligible: false, reason: "already_retried" };
  }

  // Placed nothing — see the module doc for why "no proposal row" is sufficient.
  if (db.prepare("SELECT 1 FROM trade_proposals WHERE run_id = ? LIMIT 1").get(killed.id)) {
    return { eligible: false, reason: "wrote_proposals" };
  }
  if (db.prepare("SELECT 1 FROM fill_events WHERE run_id = ? LIMIT 1").get(killed.id)) {
    return { eligible: false, reason: "wrote_fills" };
  }
  if (db.prepare("SELECT 1 FROM socratic_decisions WHERE run_id = ? LIMIT 1").get(killed.id)) {
    return { eligible: false, reason: "wrote_decisions" };
  }
  if (
    db
      .prepare("SELECT 1 FROM audit_events WHERE kind = 'run_state_override' AND json_extract(payload, '$.runId') = ? LIMIT 1")
      .get(killed.id)
  ) {
    return { eligible: false, reason: "run_scoped_override" };
  }
  if (hasLiveStrategyRunLease(killed.id, killed.userId, nowMs)) {
    return { eligible: false, reason: "live_lease" };
  }

  const policy = getPolicy(killed.userId, killed.connectedAccountId);
  if (policy.systemState !== "active") return { eligible: false, reason: "account_not_active" };
  if (!(deps.sessionAllows ?? defaultSessionAllows)(policy, nowMs)) {
    return { eligible: false, reason: "session_closed" };
  }

  // A newer (or still-running) run on the account already covers the lost slot.
  if (
    db
      .prepare(
        `SELECT 1 FROM strategy_runs
         WHERE user_id = ? AND connected_account_id = ? AND id != ? AND id != ?
           AND (started_at > ? OR status = 'running')
         LIMIT 1`
      )
      .get(killed.userId, killed.connectedAccountId, killed.id, ignore, killed.startedAt)
  ) {
    return { eligible: false, reason: "newer_run" };
  }
  // The request queue serializes per user; never stack a retry behind (or ahead of) other work.
  if (
    db
      .prepare("SELECT 1 FROM strategy_run_requests WHERE user_id = ? AND status IN ('queued', 'running') AND id != ? LIMIT 1")
      .get(killed.userId, ignore)
  ) {
    return { eligible: false, reason: "open_request" };
  }
  return { eligible: true };
}

export type EnqueueRestartRetryResult =
  | { queued: true; requestId: string }
  | { queued: false; reason: RestartRetrySkipReason };

/** Queue at most one retry for a restart-killed run.  Check + insert in one IMMEDIATE transaction. */
export function enqueueRestartRetry(
  killed: KilledRunRef,
  nowMs: number = Date.now(),
  deps: RestartRetryDeps = {}
): EnqueueRestartRetryResult {
  const db = getDb();
  const requestId = randomUUID();
  const outcome = db
    .transaction((): EnqueueRestartRetryResult => {
      const eligibility = evaluateRestartRetryEligibility(killed, nowMs, deps);
      if (!eligibility.eligible) return { queued: false, reason: eligibility.reason };
      const res = db
        .prepare(
          `INSERT OR IGNORE INTO strategy_run_requests
             (id, user_id, manual, status, result, created_at, started_at, finished_at, connected_account_id, retry_of_run_id)
           VALUES (?, ?, 0, 'queued', NULL, ?, NULL, NULL, ?, ?)`
        )
        .run(requestId, killed.userId, new Date(nowMs).toISOString(), killed.connectedAccountId, killed.id);
      if (res.changes !== 1) return { queued: false, reason: "already_retried" };
      return { queued: true, requestId };
    })
    .immediate();

  try {
    if (outcome.queued) {
      audit(
        "strategy_run_retry_enqueued",
        { killedRunId: killed.id, retryRunId: outcome.requestId, killedStartedAt: killed.startedAt, cause: "process_restarted_mid_run" },
        killed.userId,
        killed.connectedAccountId ?? undefined
      );
    } else {
      audit(
        "strategy_run_retry_skipped",
        { killedRunId: killed.id, reason: outcome.reason, cause: "process_restarted_mid_run" },
        killed.userId,
        killed.connectedAccountId ?? undefined
      );
    }
  } catch (err) {
    console.error("[strategy-run-retry] receipt write failed:", err);
  }
  return outcome;
}

export type QueuedRetryRequest = {
  id: string;
  userId: string;
  connectedAccountId: string | null;
  retryOfRunId: string;
  createdAt: string;
};

/**
 * Drain-time re-check for a queued retry.  Returns null when the retry may run, else the reason
 * it must be dropped.
 */
export function restartRetryDropReason(
  request: QueuedRetryRequest,
  nowMs: number = Date.now(),
  deps: RestartRetryDeps = {}
): RestartRetrySkipReason | null {
  const createdMs = Date.parse(request.createdAt);
  if (!Number.isFinite(createdMs) || nowMs - createdMs > RESTART_RETRY_MAX_QUEUE_AGE_MS) return "expired";
  const killed = getDb()
    .prepare("SELECT id, user_id, connected_account_id, started_at FROM strategy_runs WHERE id = ?")
    .get(request.retryOfRunId) as
    | { id: string; user_id: string; connected_account_id: string | null; started_at: string }
    | undefined;
  if (!killed || killed.user_id !== request.userId) return "killed_run_missing";
  if (!killed.connected_account_id || killed.connected_account_id !== request.connectedAccountId) return "no_account";
  const eligibility = evaluateRestartRetryEligibility(
    { id: killed.id, userId: killed.user_id, connectedAccountId: killed.connected_account_id, startedAt: killed.started_at },
    nowMs,
    deps,
    { ignoreRequestId: request.id }
  );
  return eligibility.eligible ? null : eligibility.reason;
}

export type SweepAndRetryResult = {
  repaired: number;
  retry: { enqueued: number; skipped: number };
};

/** The scheduler's stale-run-sweep lane: sweep, then offer each restart-killed run one retry. */
export function sweepStaleRunsAndRetry(nowMs: number = Date.now(), deps: RestartRetryDeps = {}): SweepAndRetryResult {
  const sweep = sweepStaleRunningRuns(nowMs);
  let enqueued = 0;
  let skipped = 0;
  for (const killed of sweep.restartKilled) {
    try {
      const outcome = enqueueRestartRetry(killed, nowMs, deps);
      if (outcome.queued) enqueued += 1;
      else skipped += 1;
    } catch (err) {
      skipped += 1;
      console.error(`[strategy-run-retry] retry evaluation failed for ${killed.id}:`, err);
    }
  }
  return { repaired: sweep.repaired, retry: { enqueued, skipped } };
}
