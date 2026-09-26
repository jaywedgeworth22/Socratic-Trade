/**
 * Who launched a strategy run, written on its `strategy_runs.origin` column when the run row is
 * inserted (board 687a5fb4 review round, 2026-09-25 — follow-up to PR #3752, migration 93).
 *
 * Why it exists: the one-time restart retry (strategy-run-retry.ts) used to infer "scheduler
 * launched" from the ABSENCE of a `strategy_run_requests` row.  The iOS `strategy.run_once` command
 * calls `runStrategyOnce(userId, { manual: true })` directly and never writes a request row, so a
 * propose-only owner run killed by a restart could come back as an autonomous retry that places
 * orders under the account's saved authority.  The origin is now derived from the SAME options that
 * decide the run's authority, inside `runStrategyOnce`, and persisted atomically with the run row.
 *
 *   manual              — `manual: true` (web Manual Run once via the request drain, iOS Run once).
 *                         Wins over everything else: a manual run is propose-only.
 *   run_state_override  — a run-scoped trigger override (e.g. close_only); a plain retry would not
 *                         carry the override.
 *   request             — a drained `strategy_run_requests` row (`runId` supplied): an API-requested
 *                         run or a restart retry itself.
 *   autonomous          — everything else: the scheduler cadence run (`{ connectedAccountId }`) and a
 *                         plain material-event trigger run (no options).
 *
 * Only `autonomous` runs are restart-retry eligible.  A NULL origin (a row written before migration
 * 93, or by a path that does not record one) fails closed.
 */
export type StrategyRunOrigin = "autonomous" | "manual" | "run_state_override" | "request";

export function resolveStrategyRunOrigin(options: {
  manual?: boolean;
  runStateOverride?: string;
  runId?: string;
  connectedAccountId?: string;
}): StrategyRunOrigin {
  if (options.manual) return "manual";
  if (options.runStateOverride) return "run_state_override";
  if (options.runId) return "request";
  return "autonomous";
}

export function isRestartRetryableOrigin(origin: string | null | undefined): boolean {
  return origin === "autonomous";
}
