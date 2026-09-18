import { getDb, listConnectedAccounts, listUsers, peekPolicy } from "./db";
import { isMarketOpen } from "./market-calendar";

// Handoff 6b.7: the scheduler heartbeat (/api/health's schedulerAgeSeconds) only proves the tick
// FUNCTION is running — it goes green the instant a DB write succeeds, even if every strategy run
// it kicks off then fails (persistent LLM/broker outage). This module adds a second, orthogonal
// signal: per active-autonomy account, how long since a run actually COMPLETED, and how many runs
// in a row have failed. Read-only; never throws (callers treat a thrown/failed computation the
// same as "no data" rather than letting it break the health probe).
//
// Deliberately NEVER maps to a 503 anywhere it's consumed — see the /api/health call site. A
// container restart re-triggers the boot autonomy interlock (reconcileAutonomyOnBoot), reverting
// every "active" account to "halted" (6b.1) — so a naive 503-on-stale-runs would have Coolify
// restart the very process needed to place the trade that clears the staleness, and instead HALT
// autonomy. This is `degraded`-only signal for a human/alert to act on.
//
// Market-session-aware staleness (audit finding, 2026-07-15): the scheduler deliberately skips
// runs while the market is closed (strategy.ts's "Market is closed" guard, sourced from
// market-calendar.ts's isMarketOpen — the SAME source of truth reused here), so a naive
// age-vs-threshold comparison reports every account "stale" as its overnight/weekend baseline.
// The rule: the `stale_last_completed_run` reason can only fire when the market is OPEN at
// evaluation time (`isMarketOpen(now)`). A stale run while the market is closed still reports its
// real age (never fabricated/hidden) plus `marketOpen: false`, just without flipping `degraded`.
// This is the simplest honest rule — it does not try to reconstruct "was the market open at any
// point since the last completed run"; it only asks "is staleness actionable right now." The
// `consecutive_failures` reason is unaffected: a run only reaches 'failed' status by actually
// executing, which itself only happens while the market is open (or extended hours, per
// policy.runDuringExtendedHours), so that signal is already implicitly market-gated.

const MAX_RUN_LOOKBACK = 200;

/** Minutes without a COMPLETED run (for an active-autonomy account) before it's reported stale. */
export function tradingLivenessStaleMinutes(): number {
  const raw = Number(process.env.TRADING_LIVENESS_STALE_MINUTES);
  return Number.isFinite(raw) && raw > 0 ? raw : 180;
}

/** Consecutive failed runs (for an active-autonomy account) before it's reported degraded. */
export function tradingLivenessMaxConsecutiveFailures(): number {
  const raw = Number(process.env.TRADING_LIVENESS_MAX_CONSECUTIVE_FAILURES);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 3;
}

export interface AccountTradingLiveness {
  userId: string;
  connectedAccountId: string;
  label: string;
  /** ISO finished_at of the most recent status='completed' run, or null if none exists. */
  lastCompletedRunAt: string | null;
  /** Age of lastCompletedRunAt in seconds, or null when there is no completed run yet. */
  lastCompletedRunAgeSeconds: number | null;
  /** Failed runs, most-recent-first, before hitting a completed run (capped at MAX_RUN_LOOKBACK). */
  consecutiveFailedRuns: number;
  /** decide = Autopilot (app places trades).  propose = Running / ask-first. */
  strategyAuthority?: string;
  /** Whether the US equity market was open (regular session) at evaluation time — see the
   *  module docstring for why `stale_last_completed_run` is gated on this. */
  marketOpen: boolean;
  degraded: boolean;
  degradedReasons: Array<"stale_last_completed_run" | "consecutive_failures">;
}

export interface TradingLivenessSummary {
  staleMinutes: number;
  maxConsecutiveFailures: number;
  /** Whether the US equity market was open (regular session) at evaluation time; same value
   *  every account in this summary was evaluated against (one `now` for the whole pass). */
  marketOpen: boolean;
  accounts: AccountTradingLiveness[];
  degraded: boolean;
}

/**
 * Public `/api/health` aggregate.  Always emitted so UptimeRobot/Pushover can key
 * on `tradingLiveness.degraded` (count) without the object disappearing when
 * every account is halted.  Never includes user/account identity.
 */
export interface PublicTradingLiveness {
  activeAccounts: number;
  autopilotAccounts: number;
  runningAskFirstAccounts: number;
  /** Count of degraded active-autonomy accounts.  Keyword monitors use the sibling
   *  `tradingLivenessDegraded` boolean; JSON-path monitors use this number `> 0`. */
  degraded: number;
  oldestCompletedRunAgeSeconds: number | null;
  /** Worst consecutive-failure streak across active-autonomy accounts.  Without this a JSON-path
   *  monitor sees only `degraded > 0` and cannot tell an account failing every run from ordinary
   *  out-of-session silence — the two want very different responses.  Identity-free: a max across
   *  accounts, never per-account. */
  maxConsecutiveFailedRuns: number;
  /** Distinct reasons currently degrading at least one account, so ops can route on the CAUSE
   *  rather than inferring it from `oldestCompletedRunAgeSeconds` and the clock. */
  degradedReasons: Array<"stale_last_completed_run" | "consecutive_failures">;
  marketOpen: boolean;
}

export function toPublicTradingLiveness(
  summary: TradingLivenessSummary | null,
  now: number = Date.now()
): PublicTradingLiveness {
  if (!summary) {
    return {
      activeAccounts: 0,
      autopilotAccounts: 0,
      runningAskFirstAccounts: 0,
      degraded: 0,
      oldestCompletedRunAgeSeconds: null,
      maxConsecutiveFailedRuns: 0,
      degradedReasons: [],
      marketOpen: isMarketOpen(new Date(now))
    };
  }
  const degradedCount = summary.accounts.filter((a) => a.degraded).length;
  const oldestCompletedRunAgeSeconds = summary.accounts.reduce<number | null>((oldest, a) => {
    if (a.lastCompletedRunAgeSeconds === null) return oldest;
    return oldest === null ? a.lastCompletedRunAgeSeconds : Math.max(oldest, a.lastCompletedRunAgeSeconds);
  }, null);
  const maxConsecutiveFailedRuns = summary.accounts.reduce(
    (worst, a) => Math.max(worst, a.consecutiveFailedRuns),
    0
  );
  // Union the reasons from the DEGRADED accounts only — a healthy account contributes none, so an
  // empty array always means "nothing is degraded right now".
  const degradedReasons = [
    ...new Set(summary.accounts.filter((a) => a.degraded).flatMap((a) => a.degradedReasons))
  ];
  return {
    activeAccounts: summary.accounts.length,
    autopilotAccounts: summary.accounts.filter((a) => a.strategyAuthority === "decide").length,
    runningAskFirstAccounts: summary.accounts.filter((a) => a.strategyAuthority !== "decide").length,
    degraded: degradedCount,
    oldestCompletedRunAgeSeconds,
    maxConsecutiveFailedRuns,
    degradedReasons,
    marketOpen: summary.marketOpen
  };
}

/**
 * Compute the liveness dimension for one (userId, connectedAccountId). Read-only against
 * strategy_runs; the caller decides what "active autonomy" means (this function doesn't check
 * systemState itself, so it can also be reused for diagnostics on a halted account).
 */
export function computeAccountTradingLiveness(
  userId: string,
  connectedAccountId: string,
  label: string,
  now: number = Date.now()
): AccountTradingLiveness {
  const staleMinutes = tradingLivenessStaleMinutes();
  const maxConsecutiveFailures = tradingLivenessMaxConsecutiveFailures();
  const db = getDb();

  const lastCompleted = db
    .prepare(
      `SELECT finished_at FROM strategy_runs
       WHERE user_id = ? AND connected_account_id = ? AND status = 'completed'
       ORDER BY started_at DESC LIMIT 1`
    )
    .get(userId, connectedAccountId) as { finished_at: string | null } | undefined;
  const lastCompletedRunAt = lastCompleted?.finished_at ?? null;
  const lastCompletedRunAgeSeconds = lastCompletedRunAt
    ? Math.max(0, Math.round((now - new Date(lastCompletedRunAt).getTime()) / 1000))
    : null;

  // Walk the most recent finished (non-'running') runs newest-first, counting a leading streak of
  // 'failed' rows until the first 'completed' row (or the lookback cap) breaks it. A run still
  // 'running' is neither a success nor a failure yet, so it's excluded rather than resetting or
  // extending the streak.
  const recentFinished = db
    .prepare(
      `SELECT status FROM strategy_runs
       WHERE user_id = ? AND connected_account_id = ? AND status IN ('completed', 'failed')
       ORDER BY started_at DESC LIMIT ?`
    )
    .all(userId, connectedAccountId, MAX_RUN_LOOKBACK) as Array<{ status: string }>;
  let consecutiveFailedRuns = 0;
  for (const row of recentFinished) {
    if (row.status === "completed") break;
    consecutiveFailedRuns++;
  }

  const marketOpen = isMarketOpen(new Date(now));

  const degradedReasons: AccountTradingLiveness["degradedReasons"] = [];
  // Staleness only counts as degraded while the market is open — see the module docstring. A
  // stale run reported while the market is closed is expected (the scheduler isn't running), not
  // a signal a human needs to act on.
  if (
    marketOpen &&
    lastCompletedRunAgeSeconds !== null &&
    lastCompletedRunAgeSeconds > staleMinutes * 60
  ) {
    degradedReasons.push("stale_last_completed_run");
  }
  if (consecutiveFailedRuns >= maxConsecutiveFailures) {
    degradedReasons.push("consecutive_failures");
  }

  return {
    userId,
    connectedAccountId,
    label,
    lastCompletedRunAt,
    lastCompletedRunAgeSeconds,
    consecutiveFailedRuns,
    marketOpen,
    degraded: degradedReasons.length > 0,
    degradedReasons
  };
}

/**
 * Trading-liveness across every account with active autonomy (policy.systemState === "active"),
 * for every user. Returns null when there are zero such accounts — the dimension is omitted
 * rather than reported "healthy" for a fleet that isn't trading (nothing to be live about).
 * Never throws: a per-account read error is skipped rather than breaking the whole summary, and a
 * top-level error (e.g. DB unreachable) returns null the same as "no active accounts" — callers
 * that need to distinguish should check DB health separately (this module is not the DB probe).
 */
export function getTradingLivenessSummary(now: number = Date.now()): TradingLivenessSummary | null {
  try {
    const accounts: AccountTradingLiveness[] = [];
    for (const userId of listUsers()) {
      for (const account of listConnectedAccounts(userId)) {
        try {
          const policy = peekPolicy(userId, account.id);
          if (policy.systemState !== "active") continue;
          accounts.push({
            ...computeAccountTradingLiveness(userId, account.id, account.label || account.broker, now),
            strategyAuthority: policy.strategyAuthority
          });
        } catch {
          // Skip an unreadable account's policy/runs rather than failing the whole summary.
        }
      }
    }
    if (accounts.length === 0) return null;
    return {
      staleMinutes: tradingLivenessStaleMinutes(),
      maxConsecutiveFailures: tradingLivenessMaxConsecutiveFailures(),
      marketOpen: isMarketOpen(new Date(now)),
      accounts,
      degraded: accounts.some((a) => a.degraded)
    };
  } catch {
    return null;
  }
}
