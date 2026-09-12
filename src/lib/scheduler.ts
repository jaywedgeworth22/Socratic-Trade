// Background scheduler for autonomous strategy runs.
//
// Dev note: Next.js HMR may hot-reload modules, but the `if (timer) return` guard
// plus Node module caching ensures startScheduler() is effectively a no-op on
// subsequent calls within the same process. In production (`next start`) it runs once.

import { LANE_WAITS, withAccountMutation } from "./account-mutation";
import { checkAllUserPriceAlerts } from "./alerts";
import { runCongressDailyShareIfDue } from "./congress-share";
import { runMarketScanFreshnessIfDue } from "./market-scan-freshness";
import { runWeeklyMarketDigestRefreshIfDue } from "./weekly-market-digest";
import { runHealthLaneReprobeIfDue } from "./health-lane-reprobe";
import { audit, getActiveConnectedAccount, getAutoResumeOnBoot, getInternalSetting, getLastStrategyRunStartedAt, getPolicy, listConnectedAccounts, listUsers, listWatchlistSymbols, setInternalSetting, setPolicy, purgeConnectedAccount } from "./db";
import { isEarningsCallsRefreshDue, refreshEarningsCallsTranscriptsIfDue } from "./earningscalls-transcripts";
import { isRoicTranscriptRefreshDue, refreshRoicTranscriptsIfDue } from "./web-sources/roic-transcripts";
import { runDailyLearningReviewIfDue } from "./learning-review";
import { isRunAllowedNow } from "./market-hours";
import { runProviderTierCheckIfDue } from "./provider-tier";
import { refreshLitestreamRemoteInventoryIfDue } from "./litestream-remote-inventory";
import { runR2UsageCheckIfDue, runR2UsageDailyDigestIfDue } from "./r2-usage";
import { maybeAdvisePineconeTrialRollback } from "./pinecone-trial-window";
import { pineconeWuExhaustedUntil } from "./pinecone-wu-breaker";
import { runWatchlistDigestIfDue } from "./watchlist-digest";
import { runAuditPruneIfDue } from "./audit-prune";
import {
  applyBrokerOrderPlacementPause,
  checkBrokerHealth,
  persistBrokerHealthSkipRun,
  shouldPersistBrokerHealthSkip,
  type ApplyBrokerPauseResult
} from "./broker-health";
import { sendNotification } from "./notifications";
import { expireStalePendingProposals } from "./proposal-revalidation";
import { hasInFlightStrategyWork, markStaleRunningRuns } from "./db-execution";
import { checkRegimeFlip } from "./regime-watch";
import { getBrokerGateway } from "./broker";
import { deriveExecutionState } from "./execution-mode";
import { runStrategyOnce, type StrategyResult } from "./strategy";
import { checkMonthlyLlmSpendCeiling } from "./llm-budget";
import { maybeAutoTuneWeights } from "./auto-tune-scheduler";
import { notifyStaleLimitOrders } from "./stale-limit-orders";
import { autoRemediateStaleExitOrders } from "./order-replacement";
import { runSyntheticStopMonitor } from "./synthetic-stops";
import { isLiveOrderState } from "./broker-side";
import type { EquityOrder, TradingPolicy } from "./types";
import { presentAccountSchedule } from "./scheduler-presentation";
import { cadenceLaneDecision, drainMaterialEventQueue } from "./triggers";
import {
  getTechnicalWatchlist,
  isFilingIngestDue,
  isFmpTranscriptRefreshDue,
  refreshDueWebSources,
  refreshFilingBodies,
  refreshFmpTranscripts
} from "./web-sources";
import { rankDemandFirstSymbols } from "./rag/demand-first-symbols";
import { acquireOrRenewLeadership, releaseLease, LEASE_OWNER } from "./scheduler-lease";
import { reconcilePendingFills } from "./strategy-execution";
import { safeErrorMessage } from "./telemetry-sanitize";
import { runStPrimaryBridgeWriterIfDue } from "./st-primary-bridge-writer";
import { journalLane } from "./task-journal";
import { pruneTaskJournal } from "./db-task-journal";
import { withDeadline, withLaneDeadline, isLaneDeadlineExpiry, LANE_STALL_ATTRIBUTION_RATIO, SCHEDULER_BROKER_TIMEOUT_MS } from "./safety-maintenance";
import { isAbortOrTimeoutError, isTransientNetworkError } from "./network-errors";
import { logError, logWarn, recordSchedulerTick } from "./sentry-metrics";

const TICK_MS = 60_000; // check every 60s; cadence changes take effect within one tick
export const MANAGED_VECTOR_RECONCILE_LAST_ATTEMPT_KEY = "scheduler:managedVectorReconcile:lastAttempt";
export const MANAGED_VECTOR_RECONCILE_LAST_SUCCESS_KEY = "scheduler:managedVectorReconcile:lastSuccess";
export const MANAGED_VECTOR_RECONCILE_SUCCESS_INTERVAL_MS = 24 * 60 * 60 * 1_000;
export const MANAGED_VECTOR_RECONCILE_RETRY_INTERVAL_MS = 60 * 60 * 1_000;

type PersistedTimestamp = string | number | null | undefined;

function timestampMs(value: PersistedTimestamp): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function elapsed(now: number, marker: PersistedTimestamp, intervalMs: number): boolean {
  const markerMs = timestampMs(marker);
  return markerMs === undefined || now - markerMs >= intervalMs;
}

/** Pure cadence decision for the global managed-vector repair pass. */
export function isManagedVectorReconcileDue(
  now: number,
  lastAttemptAt?: PersistedTimestamp,
  lastSuccessAt?: PersistedTimestamp
): boolean {
  if (!Number.isFinite(now)) return false;
  if (!elapsed(now, lastSuccessAt, MANAGED_VECTOR_RECONCILE_SUCCESS_INTERVAL_MS)) return false;
  return elapsed(now, lastAttemptAt, MANAGED_VECTOR_RECONCILE_RETRY_INTERVAL_MS);
}

export type ManagedVectorReconcileRun = {
  status: "success" | "busy" | "failed";
  result?: { skipped?: boolean };
};

export function drainingAccountLiveOrders(orders: readonly EquityOrder[]): EquityOrder[] {
  return orders.filter((order) => isLiveOrderState(order.state));
}

const managedVectorReconcileGuardHost = globalThis as unknown as {
  __schedulerManagedVectorReconcileInFlight?: Promise<ManagedVectorReconcileRun | null>;
};

/**
 * Run the global managed-vector repair pass when its persisted cadence allows it.
 *
 * This is intentionally independent of user/account state: the reconciler's default scope is the
 * global `local` tenant. The promise guard is pinned to globalThis so HMR/module duplication cannot
 * start a second provider/SQLite repair in the same process.
 */
export async function reconcileManagedVectorRecordsIfDue(now = Date.now()): Promise<ManagedVectorReconcileRun | null> {
  const existing = managedVectorReconcileGuardHost.__schedulerManagedVectorReconcileInFlight;
  if (existing) return existing;

  const run = (async (): Promise<ManagedVectorReconcileRun | null> => {
    try {
      // Live `9d71dda4`: thousands of Pinecone list/fetch ran in the same
      // window as gather.  Pause whole-index inventory while a run/request is
      // queued or running.  Do not consume the attempt marker so the next
      // idle tick can still reconcile.  Do not flip write-class or prune.
      if (hasInFlightStrategyWork()) {
        return { status: "busy", result: { skipped: true } };
      }

      const lastAttemptAt = getInternalSetting<PersistedTimestamp>(MANAGED_VECTOR_RECONCILE_LAST_ATTEMPT_KEY);
      const lastSuccessAt = getInternalSetting<PersistedTimestamp>(MANAGED_VECTOR_RECONCILE_LAST_SUCCESS_KEY);
      if (!isManagedVectorReconcileDue(now, lastAttemptAt, lastSuccessAt)) return null;

      setInternalSetting(MANAGED_VECTOR_RECONCILE_LAST_ATTEMPT_KEY, new Date(now).toISOString());
      const { reconcileManagedVectorRecords } = await import("./vector-db");
      // Scheduled maintenance is observation-only. Provider list inventory is eventually
      // consistent, so destructive repair requires an explicit operator invocation after review.
      const result = await reconcileManagedVectorRecords({ dryRun: true });
      if (result.skipped) {
        console.warn("[scheduler] managed-vector reconciliation busy; retry deferred");
        return { status: "busy", result };
      }

      setInternalSetting(MANAGED_VECTOR_RECONCILE_LAST_SUCCESS_KEY, new Date(now).toISOString());
      return { status: "success", result };
    } catch (error) {
      console.error(`[scheduler] managed-vector reconciliation failed: ${safeErrorMessage(error)}`);
      return { status: "failed" };
    }
  })();

  const guardPromise = run;
  managedVectorReconcileGuardHost.__schedulerManagedVectorReconcileInFlight = guardPromise;
  try {
    return await run;
  } finally {
    if (managedVectorReconcileGuardHost.__schedulerManagedVectorReconcileInFlight === guardPromise) {
      delete managedVectorReconcileGuardHost.__schedulerManagedVectorReconcileInFlight;
    }
  }
}

/**
 * Single-leader is the fail-safe default. Unset, empty, and whitespace-only values stay ON;
 * operators must use an explicit non-truthy value (for example false/off/0/no) to disable it.
 */
export function singleLeaderEnabled(rawValue: string | undefined = process.env.SCHEDULER_SINGLE_LEADER): boolean {
  const v = String(rawValue ?? "").trim().toLowerCase();
  return !["0", "false", "off", "no"].includes(v);
}

/**
 * A signal-driven shutdown can interrupt detached broker maintenance that the scheduler already
 * launched. Keep the durable leader lease fenced until its TTL expires; only release once Node's
 * event loop has actually drained and `beforeExit` proves no such work remains.
 */
export const SCHEDULER_LEASE_RELEASE_EVENTS = ["beforeExit"] as const;

export function shouldReleaseSchedulerLeaseOnShutdown(event: "SIGTERM" | "SIGINT" | "beforeExit"): boolean {
  return (SCHEDULER_LEASE_RELEASE_EVENTS as readonly string[]).includes(event);
}

/** Auto-tuning is follow-on work for a successfully completed decision cycle only.
 *  Pure pre-decision skips (budget / market / broker) must not trigger tuning (UX PR-A1). */
export function shouldAutoTuneAfterStrategyRun(result: Pick<StrategyResult, "status">): boolean {
  return result.status === "completed";
}

/** Account-bound scheduler composition kept exportable for deterministic regression coverage. */
export async function runScheduledStrategyAndMaybeTune(
  userId: string,
  connectedAccountId: string,
  now?: number
): Promise<StrategyResult> {
  const result = await runStrategyOnce(userId, { connectedAccountId });
  if (shouldAutoTuneAfterStrategyRun(result)) {
    // Compute after the potentially long run so cadence and daily budget reservation use the
    // follow-up's real day/time. Tests may inject an explicit clock value.
    await maybeAutoTuneWeights(userId, now ?? Date.now(), connectedAccountId);
  }
  return result;
}

// ── Health threshold: abdicate leadership after N consecutive heartbeat failures ──
//
// When the scheduler's heartbeat write (setInternalSetting("scheduler:lastTick", …)) fails, the
// DB is unreachable — the lease operations in the same tick will also fail, so another process can
// acquire it. But we also want the current process to explicitly stop trying + log the event rather
// than spinning on a dead DB. After N consecutive heartbeat failures, the leader releases its lease
// and this tick returns early. A successful heartbeat resets the counter.
//
// Pinned to globalThis so Next.js HMR re-evaluations can't reset the counter mid-run.

const healthFailuresHost = globalThis as unknown as { __schedulerHealthFailures?: number };
const DEFAULT_HEALTH_FAILURE_THRESHOLD = 5;

function healthFailureThreshold(): number {
  const v = Number(process.env.SCHEDULER_HEALTH_FAILURE_THRESHOLD);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_HEALTH_FAILURE_THRESHOLD;
}

function incrementHealthFailures(): number {
  const current = healthFailuresHost.__schedulerHealthFailures ?? 0;
  healthFailuresHost.__schedulerHealthFailures = current + 1;
  return current + 1;
}

function resetHealthFailures(): void {
  healthFailuresHost.__schedulerHealthFailures = 0;
}

function getHealthFailures(): number {
  return healthFailuresHost.__schedulerHealthFailures ?? 0;
}

/** Exported for tests — asserts the env gate and that failures can never propagate. */
export function _schedulerTickHealthCheck(): { failures: number; threshold: number; heartbeatOk: boolean } {
  return { failures: getHealthFailures(), threshold: healthFailureThreshold(), heartbeatOk: true };
}

// Sentry Crons heartbeat for the scheduler tick. Addresses a confirmed monitoring gap: a
// dead/hung scheduler still leaves /api/health returning 200, so an external dead-man's-switch
// is needed. Honest check-ins: the leader opens `in_progress` when the tick body starts and
// closes `ok` / `error` when it finishes (or the watchdog unwedge sends `error`). A standalone
// `ok` at tick *start* used to mark a hung tick healthy until the next check-in was missed.
// Opt-in — requires BOTH SENTRY_DSN (the SDK is only initialized in instrumentation.ts when it
// is set) AND SENTRY_CRONS_ENABLED=1 — and fully try/catch-wrapped: monitoring must never be
// able to break trading.
export const SENTRY_CRON_MONITOR_SLUG = "scheduler-tick";

export type SentrySchedulerCheckInStatus = "in_progress" | "ok" | "error";

function sentryCronsEnabled(): boolean {
  return Boolean(process.env.SENTRY_DSN) && process.env.SENTRY_CRONS_ENABLED === "1";
}

const SENTRY_CRON_MONITOR_CONFIG = {
  schedule: { type: "interval" as const, value: 1, unit: "minute" as const },
  checkinMargin: 5,
  maxRuntime: 10,
  timezone: "UTC"
};

/** Exported for tests only — asserts the env gate and that failures can never propagate. */
export async function sendSentrySchedulerCheckIn(
  status: SentrySchedulerCheckInStatus = "ok",
  checkInId?: string
): Promise<string | undefined> {
  if (!sentryCronsEnabled()) return undefined;
  try {
    // Dynamic import keeps the Sentry SDK out of the module graph of every scheduler consumer
    // (tests, API routes) and makes the disabled path a true no-op. Interop note: depending on
    // the module system the CJS exports can surface on `.default` instead of as named exports
    // (raw Node ESM import of @sentry/nextjs does this), so resolve defensively and silently
    // skip — never throw — if the API is unavailable.
    const mod = (await import("@sentry/nextjs")) as typeof import("@sentry/nextjs") & {
      default?: typeof import("@sentry/nextjs");
    };
    const captureCheckIn = mod.captureCheckIn ?? mod.default?.captureCheckIn;
    if (typeof captureCheckIn !== "function") return undefined;
    // The upsert monitor config auto-creates/updates the monitor on first check-in: expected
    // every minute (TICK_MS), flagged missed after a 5-minute margin. maxRuntime 10 minutes
    // is the Sentry-side backstop if in_progress never closes (watchdog unwedge is faster).
    // Branch on `status` (rather than building one object typed as the 3-way union) so each
    // call site's object literal narrows to the exact arm of the SDK's CheckIn union — a
    // pre-widened `status: SentrySchedulerCheckInStatus` field cannot structurally match either
    // arm and fails `tsc` even though every individual call is valid. The SDK's
    // `InProgressCheckIn` arm has no `checkInId` field at all — opening always mints a fresh
    // ID (that's the return value); only the closing "ok"/"error" arm can carry one to resume it.
    const id =
      status === "in_progress"
        ? captureCheckIn({ monitorSlug: SENTRY_CRON_MONITOR_SLUG, status }, SENTRY_CRON_MONITOR_CONFIG)
        : checkInId
          ? captureCheckIn({ monitorSlug: SENTRY_CRON_MONITOR_SLUG, status, checkInId }, SENTRY_CRON_MONITOR_CONFIG)
          : captureCheckIn({ monitorSlug: SENTRY_CRON_MONITOR_SLUG, status }, SENTRY_CRON_MONITOR_CONFIG);
    return typeof id === "string" && id.length > 0 ? id : undefined;
  } catch (err) {
    logError("scheduler.tick", { event: "cron_checkin_failed", error: safeErrorMessage(err) });
    return undefined;
  }
}

let timer: NodeJS.Timeout | null = null;
// Schedule state is per (userId, connectedAccountId): each connected account runs autonomously on
// its own cadence/state, so two accounts of the same user neither share a cadence clock nor block
// each other. Keyed by scheduleKey(userId, accountId).
const accountSchedules: Record<string, {
  lastRunAt: string | null;
  nextRunAt: string | null;
}> = {};

function scheduleKey(userId: string, connectedAccountId: string): string {
  return `${userId}::${connectedAccountId}`;
}

// Per-(user,account) re-entrancy guard for the synthetic-stop monitor: a slow broker call must not
// let the next 60s tick start a second concurrent monitor for the same account. globalThis-pinned so
// Next.js HMR module duplication can't defeat the guard with two module instances.
const stopGuardHost = globalThis as unknown as { __stopMonitorInFlight?: Set<string> };
const stopMonitorInFlight: Set<string> =
  stopGuardHost.__stopMonitorInFlight ?? (stopGuardHost.__stopMonitorInFlight = new Set<string>());

// Per-account in-flight guard for the stale-limit / auto-remediation pass. Without it, a slow broker
// (the ≥4 sequential round-trips in a cancel-replace can outlast the 60s tick) would let the next tick
// re-process the SAME stale exit and place a SECOND market sell — a double-sell / accidental short.
const staleExitGuardHost = globalThis as unknown as { __staleExitInFlight?: Set<string> };
const staleExitInFlight: Set<string> =
  staleExitGuardHost.__staleExitInFlight ?? (staleExitGuardHost.__staleExitInFlight = new Set<string>());

// ── Observability: de-duplicated health-gate skip log + degraded-lane surfacing ──────────────
//
// Production evidence (litestream-runtime.log, 2026-08-29..2026-09-07): a single restricted/
// misbehaving Tradier account generated 1,364 "[scheduler] Tradier order capability probe
// failed" lines because the health gate below re-logged the SAME cause on every 60s tick for as
// long as the account stayed unhealthy. None of that volume changed any decision — the pause/
// resume, the journalLane audit row, and persistBrokerHealthSkipRun all ran unconditionally
// either way. Throttling the console line to state transitions (plus a low-rate heartbeat so a
// days-long outage cannot vanish silently) removes the noise without touching what the scheduler
// DOES. globalThis-pinned to match this file's other guards.
const healthSkipLogHost = globalThis as unknown as {
  __schedulerHealthSkipLog?: Map<string, { reason: string; halted: boolean; occurrences: number }>;
};
const healthSkipLog: Map<string, { reason: string; halted: boolean; occurrences: number }> =
  healthSkipLogHost.__schedulerHealthSkipLog ?? (healthSkipLogHost.__schedulerHealthSkipLog = new Map());
/** Roughly every 30 ticks (~30 min at the 60s cadence) once a cause has gone stale. */
export const HEALTH_SKIP_HEARTBEAT_EVERY = 30;

/** True when the pause result is an AUTO-halt we own, not a manual owner halt.
 *  `ApplyBrokerPauseResult["action"]` is a one-tick transition marker — "halted" fires only the
 *  tick the auto-halt actually happens; a still-auto-halted account reports "still_paused" with
 *  `autoOwned: true` on every later tick. Using `=== "halted"` alone at the health-gate skip
 *  call site made the halt flag flip true/false/true/... every tick after the first, which
 *  logHealthGateSkip reads as a halt-state CHANGE — resetting its dedup counter and re-emitting
 *  "account_skip_started" every tick (2026-09-07 fix). Treating EVERY "still_paused" as
 *  auto-halted was the next miss: a manual owner halt also returns "still_paused" but
 *  deliberately has no auto-pause marker (`autoOwned: false`, broker-health.ts). That path must
 *  not emit `(auto-halted)` / `halted: true` (Codex PR #3189 P2). Dedup is preserved because
 *  the flag stays stable for both kinds of pause. */
export function isHaltedPauseAction(result: ApplyBrokerPauseResult): boolean {
  return result.action === "halted" || (result.action === "still_paused" && result.autoOwned);
}

/** Log an unhealthy-account skip once per NEW cause, then only on a low-rate heartbeat. */
export function logHealthGateSkip(key: string, reason: string, halted: boolean): void {
  const prev = healthSkipLog.get(key);
  const changed = !prev || prev.reason !== reason || prev.halted !== halted;
  const occurrences = changed ? 1 : prev.occurrences + 1;
  healthSkipLog.set(key, { reason, halted, occurrences });
  const suffix = halted ? " (auto-halted)" : "";
  if (changed) {
    console.warn(`[scheduler] Skipping account ${key}: ${reason}${suffix}`);
    logWarn("scheduler.health_gate", { event: "account_skip_started", key, reason, halted });
  } else if (occurrences % HEALTH_SKIP_HEARTBEAT_EVERY === 0) {
    console.warn(`[scheduler] Skipping account ${key}: still unhealthy after ${occurrences} ticks (cause unchanged): ${reason}${suffix}`);
  }
}

/** Clear a prior skip state and announce recovery — a no-op if the account was already healthy. */
export function clearHealthGateSkip(key: string): void {
  const prev = healthSkipLog.get(key);
  if (!prev) return;
  healthSkipLog.delete(key);
  logWarn("scheduler.health_gate", {
    event: "account_skip_recovered",
    key,
    priorReason: prev.reason,
    occurrences: prev.occurrences
  });
}

// Consecutive-failure tracking for money-adjacent monitor lanes (synthetic-stop monitor,
// stale-limit-order handling). Classifies each failure (timeout vs. dead-socket/transient
// network vs. other) and emits ONE elevated "lane_degraded" event when a sustained streak
// crosses the threshold, instead of a sustained outage dissolving into per-tick log noise.
// Purely observability: it never retries or alters the lane's own work.
export type LaneFailureCategory = "timeout" | "event_loop_stall" | "transient_network" | "other";
const laneFailureHost = globalThis as unknown as {
  __schedulerLaneFailures?: Map<string, { category: LaneFailureCategory; streak: number; degraded: boolean }>;
};
const laneFailureStreaks: Map<string, { category: LaneFailureCategory; streak: number; degraded: boolean }> =
  laneFailureHost.__schedulerLaneFailures ?? (laneFailureHost.__schedulerLaneFailures = new Map());
export const LANE_DEGRADED_STREAK_THRESHOLD = 3;

export function classifyLaneFailure(err: unknown): LaneFailureCategory {
  // Checked FIRST and deliberately so: an attributed lane expiry still carries the word
  // "timeout" in its message, so either matcher below would swallow it back into "timeout" and
  // we would keep blaming the broker for a stalled event loop — the exact misdiagnosis that
  // sent PR #3189 after Tradier GET retries that could not possibly help (57 of 71 synthetic-stop
  // occurrences landed AFTER that fix merged, and the daily rate went UP).
  if (isLaneDeadlineExpiry(err) && err.stallRatio >= LANE_STALL_ATTRIBUTION_RATIO) return "event_loop_stall";
  if (isAbortOrTimeoutError(err)) return "timeout";
  // `withDeadline` (inflight-deadline.ts) manufactures a plain `new Error(message)` on expiry —
  // name stays "Error", so it never matches isAbortOrTimeoutError's AbortError/TimeoutError check
  // — but every call site in this file names that message after the timeout it is
  // ("runSyntheticStopMonitor timeout", "stale-limit-scan broker timeout", "checkBrokerHealth
  // timeout", "Tradier/Alpaca broker call timed out"). Recognize that convention directly so the
  // 79/75-occurrence timeout family from production evidence actually lands in "timeout" instead
  // of the "other" catch-all.
  const message = err instanceof Error ? err.message : String(err);
  if (/\btimeout\b|timed out/i.test(message)) return "timeout";
  if (isTransientNetworkError(err)) return "transient_network";
  return "other";
}

/** Log one lane failure with its classification, escalating to a Sentry "lane_degraded"
 *  structured event only when the SAME category has now failed LANE_DEGRADED_STREAK_THRESHOLD+
 *  times in a row for this account. */
export function recordLaneFailure(lane: string, key: string, err: unknown): void {
  const mapKey = `${lane}:${key}`;
  const category = classifyLaneFailure(err);
  const prev = laneFailureStreaks.get(mapKey);
  // Streak continuity is keyed on the FAMILY, not the exact category (Codex P1, 2026-09-09).
  // `event_loop_stall` and `timeout` are both "the lane did not finish inside its deadline", and
  // a lane whose stall ratio hovers around LANE_STALL_ATTRIBUTION_RATIO alternates between them.
  // Comparing exact categories reset the streak to 1 on every flip, so an indefinitely failing
  // safety lane could oscillate forever without ever reaching LANE_DEGRADED_STREAK_THRESHOLD and
  // never escalate `lane_degraded` at all — strictly worse than before this category existed.
  const streak = prev && laneStreakFamily(prev.category) === laneStreakFamily(category) ? prev.streak + 1 : 1;
  // Once degraded, STAY degraded across a failure-category change (2026-09-07 fix) — a lane
  // failing 3x on "timeout" then switching to "transient_network" is still the same ongoing
  // outage, not a resolved one. Gating on `prev.category === category` here reset `degraded` to
  // false the moment the category changed (even though nothing had actually recovered), which
  // both suppressed the eventual lane_recovered event and let the map entry silently lose its
  // degraded status. Only recordLaneRecovery (an actual success) may clear it.
  const alreadyDegraded = Boolean(prev?.degraded);
  const nowDegraded = alreadyDegraded || streak >= LANE_DEGRADED_STREAK_THRESHOLD;
  laneFailureStreaks.set(mapKey, { category, streak, degraded: nowDegraded });
  console.error(`[scheduler] ${lane} error (${category}, streak=${streak}):`, err);
  if (nowDegraded && !alreadyDegraded) {
    // Carry the raw stall measurement alongside the category (Codex P2, 2026-09-09) so a
    // responder can always see BOTH facts. A single category can never express "the broker was
    // slow AND the loop was pinned", and collapsing to one of them would hide the other.
    const stall = isLaneDeadlineExpiry(err)
      ? { elapsedMs: err.elapsedMs, stalledMs: err.stalledMs, stallRatio: Number(err.stallRatio.toFixed(3)) }
      : {};
    logError("scheduler.lane", { event: "lane_degraded", lane, key, category, streak, ...stall });
  }
}

/** Failure categories that represent the same underlying condition for streak accounting. */
function laneStreakFamily(category: LaneFailureCategory): string {
  return category === "event_loop_stall" || category === "timeout" ? "deadline" : category;
}

/** Clear a lane's failure streak on success; announces recovery only if it had gone degraded. */
export function recordLaneRecovery(lane: string, key: string): void {
  const mapKey = `${lane}:${key}`;
  const prev = laneFailureStreaks.get(mapKey);
  if (!prev) return;
  laneFailureStreaks.delete(mapKey);
  if (prev.degraded) {
    logWarn("scheduler.lane", { event: "lane_recovered", lane, key, category: prev.category, streak: prev.streak });
  }
}

/** Test-only: clear the module-pinned health-skip / lane-failure maps between test cases. */
export function _resetSchedulerObservabilityStateForTest(): void {
  healthSkipLog.clear();
  laneFailureStreaks.clear();
}

// Whole-tick re-entrancy guard: a still-running tick must not let the next 60s interval start an
// overlapping sweep/health pass.  Overlapping ticks do NOT duplicate trades — `lastRunAt` advances
// before a run is launched and per-account strategy locks hold the money path — the harm is
// re-running sweep lanes (~30 `journalLane` calls) and a `checkBrokerHealth` network call per
// account. globalThis-pinned so Next.js HMR module duplication can't defeat the guard.
//
// Generation token: the 2026-08-31 hung-tick incident left `__tickInFlight` true until process
// restart because `tickInner` never returned.  The watchdog clears the guard and bumps generation
// so a later `finally` from the abandoned tick cannot clobber a newer tick's in-flight bit.
const tickGuardHost = globalThis as unknown as {
  __tickInFlight?: boolean;
  __tickStartedAtMs?: number;
  __tickGeneration?: number;
  __tickSentryCheckInId?: string;
  __tickAbortController?: AbortController;
};

/** Default wall-clock budget for one tick body before the watchdog unwedge.  2 minutes is under
 *  `/api/health` schedulerStale (5 min) and the Sentry checkinMargin (5 min) so autopilot can
 *  resume before those pages.  Override with SCHEDULER_TICK_WATCHDOG_MS. */
export const DEFAULT_TICK_WATCHDOG_MS = 120_000;
export const TICK_WATCHDOG_POLL_MS = 15_000;
/** Serial per-account health probe ceiling.  Longer than SCHEDULER_BROKER_TIMEOUT_MS (15s)
 *  because checkBrokerHealth runs getAccounts+getPortfolio whose first+retry budget is 16+8s. */
export const SCHEDULER_HEALTH_PROBE_TIMEOUT_MS = 30_000;

export type SchedulerTickWatchdogResult = "idle" | "waiting" | "unwedged";

export function schedulerTickWatchdogLimitMs(): number {
  const v = Number(process.env.SCHEDULER_TICK_WATCHDOG_MS);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_TICK_WATCHDOG_MS;
}

function nextTickGeneration(): number {
  const next = (tickGuardHost.__tickGeneration ?? 0) + 1;
  tickGuardHost.__tickGeneration = next;
  return next;
}

function clearTickGuard(): void {
  tickGuardHost.__tickInFlight = false;
  tickGuardHost.__tickStartedAtMs = undefined;
  tickGuardHost.__tickSentryCheckInId = undefined;
  tickGuardHost.__tickAbortController = undefined;
}

/** Test-only: drop the process-pinned in-flight bit so files sharing a vitest worker stay isolated. */
export function _resetSchedulerTickGuardForTest(): void {
  clearTickGuard();
  tickGuardHost.__tickGeneration = 0;
}

/**
 * Independent of `setInterval(tick)`.  A tick that never returns used to skip every later
 * interval (lease expired at TTL 90s, lastTick froze, Sentry `ok` had already fired at start).
 * While the body is still inside the budget, renew the leader lease so a slow-but-alive tick
 * does not look expired.  Do NOT write `scheduler:lastTick` here — that stamp means a tick
 * body finished, so a wedged tick goes stale honestly.
 *
 * After the budget, bump generation, clear the guard, close the Sentry check-in as `error`,
 * and kick a fresh tick so autopilot does not sit dead until a container restart.
 */
export function runSchedulerTickWatchdog(now = Date.now()): SchedulerTickWatchdogResult {
  if (!tickGuardHost.__tickInFlight) return "idle";
  const started = tickGuardHost.__tickStartedAtMs;
  const limitMs = schedulerTickWatchdogLimitMs();
  if (typeof started === "number" && Number.isFinite(started) && now - started < limitMs) {
    if (singleLeaderEnabled()) {
      try {
        acquireOrRenewLeadership(new Date(now));
      } catch {
        /* lease renew must never throw out of the watchdog */
      }
    }
    return "waiting";
  }
  const hungForMs =
    typeof started === "number" && Number.isFinite(started) ? now - started : Number.NaN;
  if (tickGuardHost.__tickAbortController) {
    tickGuardHost.__tickAbortController.abort(new Error("Scheduler tick watchdog timeout"));
  }
  const checkInId = tickGuardHost.__tickSentryCheckInId;
  nextTickGeneration();
  clearTickGuard();
  logError("scheduler.tick", {
    event: "watchdog_unwedge",
    hung_for_ms: Number.isFinite(hungForMs) ? hungForMs : undefined
  });
  recordSchedulerTick("error", Number.isFinite(hungForMs) ? hungForMs : undefined);
  void sendSentrySchedulerCheckIn("error", checkInId);
  void tick();
  return "unwedged";
}

let watchdogTimer: NodeJS.Timeout | null = null;

function startTickWatchdog(): void {
  if (watchdogTimer) return;
  watchdogTimer = setInterval(() => {
    runSchedulerTickWatchdog();
  }, TICK_WATCHDOG_POLL_MS);
  watchdogTimer.unref();
}

/**
 * Boot-time autonomy interlock. A persisted `systemState === "active"` must NOT silently resume
 * live/paper order placement after an unattended restart, crash-loop, or DB restore. Unless an
 * operator explicitly opts in (AUTONOMY_RESUME_ON_BOOT=1 env var OR per-user `autoResumeOnBoot`
 * setting), every user left "active" is reverted to "halted" on boot (audited), forcing a human
 * to re-arm autonomy deliberately. "close_only" and "liquidating" are left untouched (they are
 * themselves human-/breaker-set safe states).
 *
 * The env var is a global override — when set, ALL users resume regardless of their per-user
 * toggle. When not set, each user's `autoResumeOnBoot` setting controls their own accounts.
 */
export function reconcileAutonomyOnBoot(): void {
  if (process.env.AUTONOMY_RESUME_ON_BOOT === "1") {
    console.log("[scheduler] AUTONOMY_RESUME_ON_BOOT=1 — persisted 'active' autonomy will resume");
    return;
  }
  // Collect halted accounts per user so we can fire ONE summary notification per boot (not one
  // per account) after the reconcile loop finishes, rather than notifying inline per account.
  const haltedByUser = new Map<string, string[]>();
  for (const userId of listUsers()) {
      signal?.throwIfAborted();
    // Per-user autoResumeOnBoot setting (default false) — the individual opt-in replaces
    // the old global env var. Each user independently decides whether their accounts resume.
    if (getAutoResumeOnBoot(userId)) {
      console.log(`[scheduler] user ${userId} has autoResumeOnBoot enabled — persisted 'active' autonomy will resume`);
      continue;
    }
    // Reconcile EVERY connected account, not just the active one — a non-active account left
    // "active" would otherwise auto-resume the moment the multi-account scheduler iterates it.
    // A user with no connected accounts still has a base policy (accountId undefined), so reconcile
    // that too (preserves the original single-account interlock behavior).
    const accounts = listConnectedAccounts(userId);
    const accountIds: Array<string | undefined> = accounts.map((a) => a.id);
    if (accountIds.length === 0) accountIds.push(undefined);
    for (const accountId of accountIds) {
      try {
        const policy = getPolicy(userId, accountId);
        if (policy.systemState === "active") {
          setPolicy({ ...policy, systemState: "halted" }, userId, accountId);
          audit("autonomy_halted_on_boot", { from: "active", to: "halted", reason: "autoResumeOnBoot not enabled" }, userId, accountId);
          console.warn(`[scheduler] autonomy was 'active' for ${userId}/${accountId ?? "(base)"} at boot; reverted to 'halted' (enable autoResumeOnBoot in Settings to auto-resume).`);
          const label = accountId ? (accounts.find((a) => a.id === accountId)?.label ?? accountId) : "(base account)";
          const labels = haltedByUser.get(userId) ?? [];
          labels.push(label);
          haltedByUser.set(userId, labels);
        }
      } catch (err) {
        console.error(`[scheduler] boot autonomy reconcile failed for ${userId}/${accountId ?? "(base)"}:`, err);
      }
    }
  }
  // Fire-and-forget: notification delivery must never block or fail boot. sendNotification already
  // catches its own channel errors internally, but this catch is the backstop against a synchronous
  // throw (e.g. a policy lookup failure) reaching the caller of reconcileAutonomyOnBoot().
  for (const [userId, accountLabels] of haltedByUser) {
    notifyAutonomyHaltedOnBoot(userId, accountLabels).catch((err) => {
      console.error(`[scheduler] boot-halt notification failed for ${userId}:`, err);
    });
  }
}

/** One summary notification per user per boot when reconcileAutonomyOnBoot halted at least one of
 *  their accounts — so a deploy/restart silently disarming live autonomy doesn't go unnoticed until
 *  the owner happens to check Settings. Delivery honors the user's real enabledEvents toggle
 *  (owner ruling 2026-08-12, "ALL toggles must be real" — no force-include). A legacy stored
 *  enabledEvents array predating this event type was backfilled once by migration 78 (db.ts);
 *  after that the toggle is genuinely the user's. */
async function notifyAutonomyHaltedOnBoot(userId: string, accountLabels: string[]): Promise<void> {
  const accountsList = accountLabels.join(", ");
  const activeAccountId = getActiveConnectedAccount(userId)?.id;
  const policy = getPolicy(userId, activeAccountId);
  const title =
    accountLabels.length === 1
      ? `Autonomy halted on boot: ${accountsList}`
      : `Autonomy halted on boot for ${accountLabels.length} accounts`;
  const body =
    `Autonomy was reverted from 'active' to 'halted' because the app restarted (deploy or crash restart).\n` +
    `Affected account(s): ${accountsList}.\n` +
    `Re-arm autonomy in Settings when ready. To skip this halt on future restarts, enable ` +
    `"auto-resume on boot" for this user in Settings, or set AUTONOMY_RESUME_ON_BOOT=1.`;
  await sendNotification(
    { type: "autonomy_halted_on_boot", title, payload: { accountLabels } },
    { userId, policy, directBody: body }
  );
}

export function getSchedulerState(userId: string = "local", connectedAccountId?: string): {
  lastRunAt: string | null;
  nextRunAt: string | null;
} {
  // Default to the active account's schedule (dashboard shows the active account).
  const accountId = connectedAccountId ?? getActiveConnectedAccount(userId)?.id;
  if (!accountId) return { lastRunAt: null, nextRunAt: null };
  const memory = accountSchedules[scheduleKey(userId, accountId)];
  const policy = getPolicy(userId, accountId);
  return presentAccountSchedule({
    memoryLastRunAt: memory?.lastRunAt,
    memoryNextRunAt: memory?.nextRunAt,
    lastStrategyRunStartedAt: getLastStrategyRunStartedAt(userId, accountId),
    systemState: policy.systemState,
    runCadenceMinutes: policy.runCadenceMinutes,
    triggerSettings: policy.triggerSettings,
    runDuringExtendedHours: policy.runDuringExtendedHours === true
  });
}

export function startScheduler(): void {
  if (timer) return; // guard against double-start

  // Release only after the event loop drains. SIGTERM/SIGINT intentionally retain the lease until
  // its TTL: signal shutdown can kill detached synthetic-stop/broker work, and immediate release
  // would let a successor duplicate those protective orders before their outcome is known.
  // Guarded by globalThis so HMR re-evaluation cannot double-register the beforeExit listener.
  const shutdownHost = globalThis as unknown as { __schedulerLeaseShutdownRegistered?: boolean };
  if (!shutdownHost.__schedulerLeaseShutdownRegistered) {
    shutdownHost.__schedulerLeaseShutdownRegistered = true;
    const release = () => {
      try { releaseLease(LEASE_OWNER); } catch { /* never throw on shutdown */ }
    };
    for (const event of SCHEDULER_LEASE_RELEASE_EVENTS) process.on(event, release);
  }

  // Boot interlock runs once, before any tick, so a restored/copied DB cannot resume live
  // execution unattended.
  reconcileAutonomyOnBoot();

  // Run a tick immediately on start to schedule Next Run right away
  void tick();

  timer = setInterval(tick, TICK_MS);
  timer.unref(); // don't hold the process open in dev
  startTickWatchdog();
  console.log("[scheduler] started (tick every 60s; watchdog every 15s)");
}

async function tickInner(signal?: AbortSignal): Promise<void> {
  // Captured immediately: `tick()` bumps `__tickGeneration` synchronously right before invoking
  // `tickInner`, so this is always this call's own generation. Guards the Sentry check-in close in
  // the `finally` below the same way `tick()`'s own `finally` already guards `clearTickGuard()` —
  // otherwise an abandoned tick that the watchdog already unwedged can settle later and either
  // close its own now-stale check-in a second time, or worse, clobber a newer tick's still-open
  // in-progress check-in (tickGuardHost.__tickSentryCheckInId by then belongs to that newer tick).
  const myTickGeneration = tickGuardHost.__tickGeneration;
  // Crashed-run sweep: mark strategy_runs left in status='running' after a process crash/kill,
  // and close the matching strategy_run_requests row so Manual Run once is not left locked.
  // Must run BEFORE the single-leader gate so stale rows are always repaired (idempotent: the
  // UPDATE has a `WHERE status = 'running'` guard, so even two concurrent sweeps won't double-count).
  try {
    await journalLane("stale-run-sweep", {}, () => {
      const repaired = markStaleRunningRuns(Date.now());
      if (repaired > 0) console.log(`[scheduler] marked ${repaired} stale running run(s) as failed`);
      return { status: repaired > 0 ? ("ok" as const) : ("skipped" as const), summary: `repaired=${repaired}` };
    });
  } catch (err) {
    console.error("[scheduler] stale-run sweep error:", err);
  }

  // Same repair for the mobile/PWA command queue: claimNextQueuedCommand marks a row 'running' and
  // nothing else in the codebase ever selects that status, so a crash mid-command strands the row
  // forever — which permanently blocks account deletion (activeMobileCommands) and permanently
  // spins the PWA. Placed here for two reasons: before the single-leader gate (like the run sweep,
  // so stale rows are repaired even on a follower — its liveness graces are all durable DB
  // evidence, so a follower cannot misjudge a command the leader is running), and after the run
  // sweep, so a strategy_runs row that sweep just left alive on this same tick still hands its
  // grace through to the strategy.run_once command wrapping it. Dynamic import matches the
  // mobile-command-drain lane below and keeps scheduler -> mobile-api off the static graph.
  try {
    await journalLane("stale-mobile-command-sweep", {}, async () => {
      const { markStaleRunningMobileCommands } = await import("./mobile-api");
      const repaired = markStaleRunningMobileCommands(Date.now());
      if (repaired > 0) console.log(`[scheduler] marked ${repaired} stale running mobile command(s) as failed`);
      return { status: repaired > 0 ? ("ok" as const) : ("skipped" as const), summary: `repaired=${repaired}` };
    });
  } catch (err) {
    console.error("[scheduler] stale mobile-command sweep error:", err);
  }

  // Task-journal retention: 'skipped' heartbeat rows age out in 24h, ok/error in 30d
  // (db-task-journal.ts). One cheap indexed DELETE per tick; never throws.
  pruneTaskJournal();

  // Daily audit_events + provider-observability retention (audit-prune.ts):
  // observability kinds 14d, everything else 90d, bounded batches. First-ever
  // run drains a large backlog over several daily passes. Also sweeps the
  // embed_stage table (35d orphan retention + defensive size cap, db-embed-stage.ts).
  void journalLane("audit-prune", {}, () => {
    const result = runAuditPruneIfDue();
    if (!result) return { status: "skipped" as const, summary: "not due" };
    const total = result.auditObservability + result.auditDefault + result.providerDispatch +
      result.providerOutbox + result.embedStageExpired + result.embedStageCapPruned;
    return { status: "ok" as const, summary: `deleted=${total}` };
  }).catch((err) => console.error("[scheduler] audit prune error:", err));

  // Single-leader gate (default ON, including unset/empty). Only an explicit false/off/0/no-style
  // value disables it; otherwise only the lease holder runs the background updates and per-account tick body
  // — preventing duplicate API scrapes and broker EXIT orders on multi-process deploys.
  if (singleLeaderEnabled() && !acquireOrRenewLeadership(new Date())) {
    return; // not the leader this tick — no side effects
  }

  // Open an honest Sentry Crons job after the leader gate: only the process running the tick
  // body reports, so idle followers cannot mask a dead leader. `ok` is sent in `finally` once
  // the body finishes — not here — so a hung await cannot look like a successful tick.
  const sentryCheckInId = await sendSentrySchedulerCheckIn("in_progress");
  if (sentryCheckInId) tickGuardHost.__tickSentryCheckInId = sentryCheckInId;
  let sentryStatus: SentrySchedulerCheckInStatus = "ok";

  try {

  // Drain durable material-event inboxes on every leader tick, independent of SEC ingestion
  // flags. Events may be produced by filings, transcripts, broker state, or operator actions;
  // gating this on one source would strand queued work indefinitely. Deadline so a hung drain
  // cannot pin `__tickInFlight` past the watchdog (live 2026-08-31 scheduler-tick miss).
  try {
    await withDeadline(
      journalLane("material-event-drain", {}, () => drainMaterialEventQueue()),
      SCHEDULER_BROKER_TIMEOUT_MS,
      "material-event-drain timeout"
    );
  } catch (err) {
    console.error("[scheduler] material-event drain error:", err);
  }

  // Global managed-vector crash repair is cadence-gated and single-flight. It must never block or
  // throw into trading work; failed or lease-busy attempts persist their hourly retry marker.
  void journalLane("managed-vector-reconcile", {}, async () => {
    const run = await reconcileManagedVectorRecordsIfDue();
    if (run === null) return { status: "skipped" as const, summary: "not due" };
    return { status: "ok" as const, summary: `status=${run.status}` };
  }).catch((err) => console.error("[scheduler] managed-vector reconcile journal error:", err));

  // Default-off, cadence-gated export of only the primary local user's Gemini
  // and DeepSeek credentials to the isolated Usage Monitor bridge path. The
  // writer is self-guarded and returns sanitized status codes without throwing
  // into trading work.
  void journalLane("st-primary-bridge-writer", {}, () => runStPrimaryBridgeWriterIfDue()).then((result) => {
    if (result.status === "error") {
      console.error(
        `[scheduler] ST primary credential bridge failed (${result.errorCode ?? "unknown"})`
      );
    }
  }).catch((err) => console.error("[scheduler] ST primary bridge journal error:", err));

  // Refresh backend web sources (congressional trades, etc.) independently of the
  // trading loop — these are low-frequency (cadence-gated, ~daily) data reads that
  // keep the dashboard + agent context fresh even while autonomous trading is paused.
  // Skipped instantly when not yet due; fully self-guarded so it can't break a tick.
  void journalLane("web-source-refresh", {}, () => refreshDueWebSources())
    .catch((err) => console.error("[scheduler] web-source refresh error:", err));

  // Nightly (cadence-gated) market-data paid-tier watchdog: probes the Massive/FMP keys' actual tier
  // and, on a confident "free" detection (e.g. a lapsed sub), notifies + auto-clamps Massive to the
  // free-safe 5/min so the raised paid default can't 429-storm. No-op until due; fully self-guarded.
  void journalLane("provider-tier-check", {}, () => runProviderTierCheckIfDue())
    .catch((err) => console.error("[scheduler] provider-tier check error:", err));

  // Re-open hard-STOPPED Connections health lanes on a 3–6h cadence (or at known
  // quota reset). Prevents "red forever until an agent SSHs" — owner 2026-08-06.
  void journalLane("health-lane-reprobe", {}, () => runHealthLaneReprobeIfDue())
    .catch((err) => console.error("[scheduler] health-lane-reprobe error:", err));

  // Per-compaction-level backup coverage. Litestream keeps only level 0 on local disk, so
  // levels 1/2/3/9 can ONLY be graded from the remote replica — a listing that costs real B2
  // requests and ~11s, hence a 30-minute scheduled refresh here instead of inline work in
  // /api/health. Without it every higher level is honestly reported "not-observable"; with it
  // a wedged compactor (the 2026-08-12 level-2 incident) becomes visible.
  void journalLane("litestream-remote-inventory", {}, () => refreshLitestreamRemoteInventoryIfDue())
    .catch((err) => console.error("[scheduler] litestream remote inventory error:", err));

  // Cloudflare R2 free-tier watchdog (owner directive 2026-07-30: never pace >70%
  // of the 10 GiB / 1M Class A / 10M Class B monthly free tier). Cadence-gated
  // (default 6h), leader-only, self-guarded; alerts via notify() on threshold
  // crossings and persists a snapshot for the admin dashboard card.
  void journalLane("r2-usage-check", {}, () => runR2UsageCheckIfDue())
    .catch((err) => console.error("[scheduler] r2 usage check error:", err));

  void journalLane("pinecone-trial-rollback", {}, () => maybeAdvisePineconeTrialRollback())
    .catch((err) => console.error("[scheduler] pinecone trial rollback error:", err));
  // Cheap: while the Standard trial is open, drop a leftover Starter 2M monthly-WU marker
  // so ingest is not parked behind a free-tier latch the write-success path can never clear.
  void journalLane("pinecone-wu-breaker-trial-clear", {}, async () => {
    pineconeWuExhaustedUntil();
  }).catch((err) => console.error("[scheduler] pinecone wu-breaker trial-clear error:", err));

  // Daily R2 free-tier digest (owner opt-in 2026-07-31): fresh check + notify()
  // summary of MTD usage and month-end pace, whether or not anything crossed.
  // Separate watermark from the 6h check; disable with R2_USAGE_DAILY_DIGEST=off.
  void journalLane("r2-usage-daily-digest", {}, () => runR2UsageDailyDigestIfDue())
    .catch((err) => console.error("[scheduler] r2 usage digest error:", err));

  // Opt-in daily watchlist digest (owner default OFF, per-user Settings -> Delivery toggle):
  // once per Central-Time day, at/after 15:15 CT (shortly after US market close), summarizes the
  // watchlist from data the app already persisted (last market scan + recent proposals per
  // symbol) — no provider or LLM calls. Resolves its own due users internally; self-guarded.
  void journalLane("watchlist-digest", {}, () => runWatchlistDigestIfDue())
    .catch((err) => console.error("[scheduler] watchlist digest error:", err));

  // 10-K/10-Q bodies and default-OFF FMP transcripts have separate producer cadences, request
  // budgets, and cursors. They share the durable RAG_REINDEX operation lease and this demand-first
  // symbol collection so both corpora prioritize held/watchlisted/recent-candidate names.
  // Gated on the operator monthly spend ceiling too: RAG (Voyage/Pinecone) spend counts toward
  // LLM_SPEND_CEILING, and this refresh runs BEFORE the strategy-run ceiling check below, so without
  // this guard a breached ceiling would still let the weekly filing-body ingest spend.
  const filingIngestDue = isFilingIngestDue();
  const transcriptIngestDue = isFmpTranscriptRefreshDue();
  if ((filingIngestDue || transcriptIngestDue) && checkMonthlyLlmSpendCeiling().ok) {
    // DEMAND-FIRST: held-by-value, watchlist, technical, policy universe, then the
    // 1k-issuer manifest.  Insertion order is the ingest order; a Set union used to
    // drop value ranking so the desk's names waited behind the alphabet.
    const symbols = rankDemandFirstSymbols();
    // These producers spend from the same Voyage/Pinecone budgets and share the durable RAG_REINDEX
    // lease. Keep their scheduler admission ordered too, so a same-tick refresh does not make one
    // producer race into a benign busy result while the other starts embedding.
    void (async () => {
      if (filingIngestDue) {
        try {
          await journalLane("filing-body-ingest", { metadata: { symbols: symbols.length } }, () => refreshFilingBodies(symbols));
        } catch (err) {
          console.error("[scheduler] filing-body refresh error:", err);
        }
      }
      if (transcriptIngestDue) {
        try {
          await journalLane("fmp-transcript-ingest", { metadata: { symbols: symbols.length } }, () => refreshFmpTranscripts(symbols));
        } catch {
          // The connector captures sanitized failures in its result/audit. Do not print a thrown
          // provider error here: it could contain request context and transcript bodies are untrusted.
          console.error("[scheduler] FMP transcript refresh failed before a result was recorded");
        }
      }
    })();
  }

  // Once-per-UTC-day EarningsCalls.dev transcript pass (dormant without EARNINGSCALLS_API_KEY;
  // kill-switch EARNINGSCALLS_DISABLED=1). Holdings-first selection, durable 180/month
  // reserve-before-call budget under the plan's HARD 200/month — see
  // src/lib/earningscalls-transcripts.ts. Gated on the monthly LLM/RAG spend ceiling like the
  // filing/FMP-transcript producers above (its ingest spends Voyage/Pinecone), and serialized
  // with them via the shared durable RAG_REINDEX operation lease (acquired inside the producer,
  // like refreshFilingBodies/refreshFmpTranscripts; a busy lease is a benign deferred pass —
  // the daily watermark is untouched, so a later tick retries). Self-guarded.
  if (isEarningsCallsRefreshDue() && checkMonthlyLlmSpendCeiling().ok) {
    void journalLane("earningscalls-refresh", {}, () => refreshEarningsCallsTranscriptsIfDue()).catch((err) =>
      console.error("[scheduler] earningscalls transcript refresh error:", err instanceof Error ? err.message : err)
    );
  }

  // ROIC.ai transcripts: latest-then-deepen-then-archive (key = opt-in; ROIC_TRANSCRIPTS_DISABLED=1).
  // Prefer this over free EarningsCalls previews when the ROIC individual plan is configured.
  // Cached earningscalls_transcripts + data/roic-artifacts never re-list or re-fetch.
  // Holdings → watchlist, last N fiscal quarters, cap ROIC_TRANSCRIPTS_MAX_PER_RUN.
  // Library helpers existed earlier without a scheduler caller — that left zero ROIC saves.
  if (isRoicTranscriptRefreshDue() && !hasInFlightStrategyWork() && checkMonthlyLlmSpendCeiling().ok) {
    void journalLane("roic-transcript-refresh", {}, () => refreshRoicTranscriptsIfDue()).catch((err) =>
      console.error("[scheduler] roic transcript refresh error:", err instanceof Error ? err.message : err)
    );
  }

  // Once-per-day share of company refs + daily closes + the S&P-500 series to congress.trade
  // (App A) so it can avoid spending the shared FMP quota. No-op unless CONGRESS_TRADE_TOKEN +
  // CONGRESS_SHARE_ENABLED are set and the batch hasn't already run today. Fully self-guarded.
  void journalLane("congress-daily-share", {}, () => runCongressDailyShareIfDue(Date.now())).catch((err) =>
    console.error("[scheduler] congress-share daily batch error:", err)
  );

  // Weekend/off-hours Market Scan freshness guarantee: scanMarket otherwise has no scheduled
  // caller, so a Friday-evening scan would sit stale until a user visits the app Monday.
  // Deliberately does NOT pass through isRunAllowedNow/isTradingDay — this is a data-freshness
  // read, not a trading action — and never places an order or invokes the LLM. Cadence-gated on
  // the newest persisted scan's age (default 20h; MARKET_SCAN_FRESHNESS_MAX_AGE_HOURS=0 disables).
  void journalLane("market-scan-freshness", {}, () => runMarketScanFreshnessIfDue(Date.now(), process.uptime())).catch((err) =>
    console.error("[scheduler] market-scan freshness error:", err)
  );

  // Native weekly value + momentum screens.  Rebuilds when a user's persisted scan
  // is newer than the last digest.  Bar work (grouped daily + detail OHLC) lives here,
  // never on the dashboard read path.
  void journalLane("weekly-market-digest", {}, () => runWeeklyMarketDigestRefreshIfDue(Date.now())).catch((err) =>
    console.error("[scheduler] weekly-market-digest error:", err)
  );

  // Deterministic regime-flip detector (Phase 1) — cheap, self-guarded. Runs per-user so
  // each user's stored regime label is independent; multi-user setups can't share one KV row.
  for (const userId of listUsers()) {
    void journalLane("regime-flip-check", { userId }, () => checkRegimeFlip(userId)).catch((err) =>
      console.error(`[scheduler] regime check error for ${userId}:`, err)
    );
  }

  // Once-per-day LLM learning review (default OFF; policy.learningReviewEnabled): a frontier-class
  // model audits recent learned-context rows + the pending learning queue against a system-history
  // digest, so lessons built on corrupted evidence (execution defects blamed on theses) get caught.
  // Annotate-only unless the owner opted into "decide". No-op unless enabled + due; self-guarded.
  for (const userId of listUsers()) {
    void journalLane("learning-review", { userId }, () => runDailyLearningReviewIfDue(userId)).catch((err) =>
      console.error(`[scheduler] learning-review error for ${userId}:`, err)
    );
  }

  // Once-per-day retrieval-usefulness join (handoff 4.1): credit the analog/coaching vector ids
  // each decision case injected (ragAttributions) with that case's matured outcome, into the
  // retrieval_usefulness_stats aggregates. Bounded batch, credited-ledger watermark (idempotent),
  // SQLite-only — no provider or LLM calls. Advisory observability + a bounded ranking nudge.
  for (const userId of listUsers()) {
    void import("./retrieval-usefulness")
      .then(({ runRetrievalUsefulnessJoinIfDue }) =>
        journalLane("retrieval-usefulness-join", { userId }, () => runRetrievalUsefulnessJoinIfDue(userId))
      )
      .catch((err) => console.error(`[scheduler] retrieval-usefulness join error for ${userId}:`, err));
  }

  // Once-per-day signal-health refresh (r2 lesson: health): pure-arithmetic rolling diagnostics of
  // the LLM's OWN confidenceScore against matured decision outcomes (rank IC + t-stat, quantile
  // buckets, top-K churn, gross vs net) persisted as signal_health_snapshot rows; a confirmed
  // rank-IC drift raises an advisory signal_health alarm — sizing only changes under the opt-in
  // policy.tuning.signalHealthAutoThrottle. SQLite-only, no provider or LLM calls; self-guarded
  // (UTC-day marker) like the retrieval-usefulness join above.
  for (const userId of listUsers()) {
    void import("./signal-health")
      .then(({ runSignalHealthRefreshIfDue }) =>
        journalLane("signal-health-refresh", { userId }, () => runSignalHealthRefreshIfDue(userId))
      )
      .catch((err) => console.error(`[scheduler] signal-health refresh error for ${userId}:`, err));
  }

  // Atlas public-repo port: evaluate armed price alerts against live quotes every tick.
  void journalLane("price-alert-check", {}, () => checkAllUserPriceAlerts())
    .catch((err) => console.error("[scheduler] price-alert check error:", err));

  // Mobile/PWA command gateway: drain queued user commands from the durable queue. Route handlers
  // also kick this worker immediately after enqueueing, but the scheduler makes queued commands
  // recover after a process restart or an interrupted request.
  void import("./mobile-api")
    .then(({ processPendingMobileCommands }) =>
      journalLane("mobile-command-drain", {}, async () => {
        const result = await processPendingMobileCommands({ limit: 5 });
        return { status: result.processed > 0 ? ("ok" as const) : ("skipped" as const), summary: `processed=${result.processed}` };
      })
    )
    .catch((err) => console.error("[scheduler] mobile-command worker error:", err));

  void import("./strategy-run-requests")
    .then(({ processPendingStrategyRunRequests }) =>
      journalLane("strategy-run-drain", {}, async () => {
        const result = await processPendingStrategyRunRequests({ limit: 1 });
        const working = result.processed > 0 || result.liveRunning > 0;
        return {
          status: working ? ("ok" as const) : ("skipped" as const),
          summary: `processed=${result.processed} adopted=${result.adopted} live=${result.liveRunning}`
        };
      })
    )
    .catch((err) => console.error("[scheduler] strategy-run worker error:", err));

  // Durable due-jobs: drain due 15m/1h intraday outcome-sampling jobs (db-jobs.ts + outcome-engine's
  // drainDueIntradaySampleJobs) so sampling survives process downtime instead of depending on a
  // strategy run coincidentally landing inside the narrow tolerance window.
  void import("./outcome-engine")
    .then(({ drainDueIntradaySampleJobs }) =>
      journalLane("due-job-intraday-drain", {}, () => drainDueIntradaySampleJobs())
    )
    .catch((err) => console.error("[scheduler] due-jobs intraday sample drain error:", err));

  // Weekly R2 cold snapshot (owner directive 2026-08-08): second-provider disaster
  // recovery — a `VACUUM INTO` snapshot of the live DB taken in a child process (NOT
  // better-sqlite3 backup(), which never converges against a concurrently written DB —
  // that is what stalled the archive for 9 days from 2026-08-30), gzip-streamed +
  // multipart-uploaded to the idle historic R2 bucket (cold-snapshots/app-<date>.db.gz
  // since 2026-08-31; newest 1 kept across .db/.db.gz).  First gzip land must set
  // R2_COLD_SNAPSHOT_SKIP_PRUNE=1 until Jay approves deleting the legacy
  // cold-snapshots/app-2026-08-30.db.  Durable weekly due-job (Sunday ~03:17 UTC;
  // survives downtime), silent no-op without the AWS_R2_HISTORIC_* credentials,
  // budget-guarded against the R2 free tier, and every attempt bounded by
  // R2_COLD_SNAPSHOT_DEADLINE_MIN so a stuck snapshot fails loudly inside its own lease.
  //
  // reportR2WeeklyFreshness watches the SAME checks.storage.r2Weekly field the public
  // health endpoint publishes and emits ONE Sentry event per state transition — nothing
  // watched it before, which is why 9 days of staleness went unnoticed.  It runs on every
  // tick regardless of whether a job drained, and is a single settings read when nothing
  // changed.
  void import("./r2-cold-snapshot")
    .then(({ ensureR2ColdSnapshotJobScheduled, drainR2ColdSnapshotJobs, reportR2WeeklyFreshness }) =>
      journalLane("r2-cold-snapshot", {}, async () => {
        ensureR2ColdSnapshotJobScheduled();
        const result = await drainR2ColdSnapshotJobs();
        const freshness = await reportR2WeeklyFreshness();
        const summary = [
          result.drained > 0 ? `drained=${result.drained} last=${result.lastRun?.status ?? "?"}` : undefined,
          freshness.changed ? `health=${freshness.previous ?? "unknown"}->${freshness.state}` : undefined,
        ]
          .filter(Boolean)
          .join(" ");
        return {
          status: result.drained > 0 ? ("ok" as const) : ("skipped" as const),
          summary: summary || undefined,
        };
      })
    )
    .catch((err) => console.error("[scheduler] r2 cold snapshot error:", err));

  // Weekly truncated-replay lookahead audit (freqtrade lookahead-analysis port): recompute
  // momentum/liquidity factor sub-scores and RAG evidence from data truncated to each sampled
  // decision's date and diff against what was persisted at decision time; everything else is an
  // honest 'unverifiable' receipt. Durable per-user due-job (default weekly; LOOKAHEAD_AUDIT_*
  // knobs; LOOKAHEAD_AUDIT_ENABLED=off is the kill switch). Read-only + advisory — findings and
  // the lookahead_leak notification gate nothing.
  void import("./lookahead-audit")
    .then(({ ensureLookaheadAuditJobsScheduled, drainLookaheadAuditJobs }) =>
      journalLane("lookahead-audit", {}, async () => {
        ensureLookaheadAuditJobsScheduled();
        const result = await drainLookaheadAuditJobs();
        return {
          status: result.drained > 0 ? ("ok" as const) : ("skipped" as const),
          summary:
            result.drained > 0
              ? `drained=${result.drained} verdict=${result.lastResult?.verdict.verdict ?? "?"}`
              : undefined,
        };
      })
    )
    .catch((err) => console.error("[scheduler] lookahead audit error:", err));

    // ── Operator-level monthly LLM spend ceiling ──────────────────────────────
    // Checked once per tick after the single-leader gate. When breached, the scheduler
    // skips LLM work (strategy runs) for all users but still runs non-LLM safety
    // maintenance: reconciliation, synthetic-stop monitor, stale-limit alerts, etc.
    const monthlyCeiling = checkMonthlyLlmSpendCeiling();
    if (!monthlyCeiling.ok) {
      console.warn(
        `[scheduler] monthly LLM spend ceiling reached: $${monthlyCeiling.totalUsd.toFixed(2)} ` +
        `of $${monthlyCeiling.ceilingUsd?.toFixed(2)} — skipping LLM work for all users this tick`
      );
      // Still run the per-account non-LLM safety tasks below (reconciliation, stop monitor,
      // stale orders, proposal expiry). Only the dueRuns / strategy execution is skipped.
    }

    // --- Per-Account Scheduling ---
    // Each connected account is scheduled independently: its own per-account policy
    // (systemState, cadence, broker) drives whether/when it runs. Autonomy is opt-in per
    // account — only accounts whose own systemState is "active" trade.
    const dueRuns: Array<{
      userId: string;
      accountId: string;
      key: string;
      prevLastRunAt: string | null;
      prevNextRunAt: string | null;
    }> = [];

    for (const userId of listUsers()) {
      for (const account of listConnectedAccounts(userId)) {
        const accountId = account.id;
        const key = scheduleKey(userId, accountId);
        // Owner ruling 2026-08-05: the internal TestBroker adapter (`broker: "test"`) is test
        // infrastructure only. Never schedule LLM strategy autonomy for it — historical "test-local"
        // armed accounts burned shared LLM budget and 429'd live accounts. Protective/reconcile
        // paths below also skip; there is no product execution mode here.
        if (account.broker === "test") {
          if (accountSchedules[key]) accountSchedules[key].nextRunAt = null;
          continue;
        }
        if (!accountSchedules[key]) {
          // Rehydrate this account's cadence clock from its last real run so a restart/HMR/deploy
          // doesn't fire an immediate run regardless of cadence (in-memory state starts empty).
          accountSchedules[key] = {
            lastRunAt: getLastStrategyRunStartedAt(userId, accountId),
            nextRunAt: null
          };
        }
        const schedule = accountSchedules[key];

        const policy = getPolicy(userId, accountId);

        // Deterministic proposal expiry runs independently of the trading cadence so a stale
        // approval queue self-clears even while the system is halted or the market is closed.
        if (policy.accountNumber) {
          void journalLane(
            "proposal-expiry",
            { userId, connectedAccountId: accountId },
            () => expireStalePendingProposals({ userId, policy, accountNumber: policy.accountNumber })
          ).catch((err) => console.error("[scheduler] proposal-expiry error:", err));
        }

        if (!policy.accountNumber) {
          schedule.nextRunAt = null;
          continue;
        }
        const executionState = deriveExecutionState(policy, account);
        const brokerGateway = executionState.submitsBrokerOrders ? getBrokerGateway(policy, userId) : undefined;
        
        if (account.isDraining) {
          if (brokerGateway && policy.accountNumber) {
            const gw = brokerGateway;
            const accountNumber = policy.accountNumber;
            void journalLane("account-drain", { userId, connectedAccountId: accountId }, async () => {
              // §7 slice 3: drain is a multi-cancel + purge sequence — hold the account mutation
              // lease so it cannot interleave with a stop-monitor or replacement window mid-flight.
              // (These are sequence cancels, not the sacred STANDALONE cancel — that stays unleased.)
              const outcome = await withAccountMutation(
                { userId, accountNumber, connectedAccountId: accountId, lane: "account-drain" },
                async () => {
                  const orders = await gw.getEquityOrders(accountNumber);
                  const openOrders = drainingAccountLiveOrders(orders);
                  for (const o of openOrders) {
                    await gw.cancelEquityOrder(accountNumber, o.id).catch((err: unknown) => {
                      console.error(`[scheduler] draining account cancel error for order ${o.id}:`, err);
                    });
                  }
                  await reconcilePendingFills(gw, accountNumber, userId, policy.connectedAccountId);
                  if (openOrders.length === 0) purgeConnectedAccount(accountId, userId);
                  return openOrders.length;
                }
              );
              if (!outcome.acquired) return { status: "skipped" as const, summary: "account mutation lease busy" };
              return { status: "ok" as const, summary: `open=${outcome.value}` };
            }).catch((err: unknown) => console.error("[scheduler] draining account order check error:", err));
          } else {
            purgeConnectedAccount(accountId, userId);
          }
          schedule.nextRunAt = null;
          continue;
        }
        
        if (brokerGateway && !staleExitInFlight.has(key)) {
          staleExitInFlight.add(key);
          const gw = brokerGateway;
          const stalePolicy = policy as TradingPolicy & { accountNumber: string }; // accountNumber checked non-null above
          const staleExitWork = journalLane("stale-limit-scan", { userId, connectedAccountId: accountId }, async () => {
            const orders = await gw.getEquityOrders(stalePolicy.accountNumber);
            await notifyStaleLimitOrders({ userId, policy, orders });
            const outcome = await withAccountMutation(
              { userId, accountNumber: stalePolicy.accountNumber, connectedAccountId: accountId, lane: "stale-exit-replacement", waitMs: LANE_WAITS.staleExit },
              (ctx) => autoRemediateStaleExitOrders({ userId, policy: stalePolicy, activeAccount: account, gateway: gw, orders, fence: ctx.assertOwned })
            );
            if (!outcome.acquired) return { status: "skipped" as const, summary: "account mutation lease busy" };
            return undefined;
          });
          // Guard is released by the REAL work, never by the 15s race loser: a lane still running
          // past the deadline must not get a duplicate launched on the next tick.
          void staleExitWork.catch(() => undefined).finally(() => staleExitInFlight.delete(key));
          // Recovery/failure must both key off the SAME deadline-raced promise (2026-09-07 fix):
          // attaching recordLaneRecovery to the raw staleExitWork promise let a run that timed out
          // (recordLaneFailure fires) but later fulfilled in the background silently clear the
          // just-recorded failure streak, so a lane that always times out but eventually succeeds
          // could never reach lane_degraded. withDeadline's promise only fulfills when the real
          // work finishes BEFORE the deadline; once it rejects (timeout OR a real error), it is
          // settled and a later background fulfillment of staleExitWork can no longer reach this
          // .then — recovery reflects success WITHIN the deadline, not late fulfillment of an
          // invocation already classified as failed.
          void withLaneDeadline(staleExitWork, SCHEDULER_BROKER_TIMEOUT_MS, "stale-limit-scan broker timeout", "stale-limit-scan")
            .then(() => recordLaneRecovery("stale-limit-order handling", key))
            .catch((err) => recordLaneFailure("stale-limit-order handling", key, err));
        }

        const protectiveState =
          policy.systemState === "active" ||
          policy.systemState === "close_only" ||
          policy.systemState === "liquidating" ||
          (policy.systemState === "halted" && policy.riskRules?.protectWhileHalted === true);

        // R2: synthetic trailing-stop monitor — runs every tick in states where risk-reducing exits
        // are allowed. `close_only` and `liquidating` must not disable the very protection that can
        // reduce exposure after a breaker trips. `halted` remains the only no-order state unless protectWhileHalted is active.
        if (protectiveState && !stopMonitorInFlight.has(key)) {
          stopMonitorInFlight.add(key);
          const stopMonitorWork = journalLane("synthetic-stop-monitor", { userId, connectedAccountId: accountId }, async () => {
            const outcome = await withAccountMutation(
              { userId, accountNumber: policy.accountNumber, connectedAccountId: accountId, lane: "stop-monitor" },
              (ctx) => runSyntheticStopMonitor(userId, policy, true, undefined, ctx.assertOwned)
            );
            if (!outcome.acquired) return { status: "skipped" as const, summary: "account mutation lease busy" };
            const result = outcome.value;
            return {
              status: "ok" as const,
              summary: `evaluated=${result.evaluated} triggered=${result.triggered} exited=${result.exited}`
            };
          });
          // Guard is released by the REAL work, never by the 15s race loser: a lane still running
          // past the deadline must not get a duplicate launched on the next tick.
          void stopMonitorWork.catch(() => undefined).finally(() => stopMonitorInFlight.delete(key));
          // See the matching comment on the stale-limit-order lane above: recovery/failure both
          // key off the SAME deadline-raced promise so a late background fulfillment (after the
          // deadline already timed out and recorded a failure) cannot silently clear the streak.
          void withLaneDeadline(stopMonitorWork, SCHEDULER_BROKER_TIMEOUT_MS, "runSyntheticStopMonitor timeout", "synthetic-stop-monitor")
            .then(() => recordLaneRecovery("synthetic-stop monitor", key))
            .catch((err) => recordLaneFailure("synthetic-stop monitor", key, err));
        }

        // Reconcile pending broker fills every tick (independent of the strategy cadence) so a broker
        // order that returned non-filled — common on Robinhood and limit orders — doesn't sit
        // pending_reconciliation until the next strategy run. Applies to broker/paper and broker/live;
        // Test/local has no broker order lifecycle.
        if (brokerGateway) {
          // Captured outside the closure: the !accountNumber `continue` guard above narrows the
          // property here, but property narrowing does not propagate into arrow closures.
          const accountNumber = policy.accountNumber;
          void journalLane(
            "pending-fill-reconcile",
            { userId, connectedAccountId: accountId },
            () => reconcilePendingFills(brokerGateway, accountNumber, userId, policy.connectedAccountId)
          ).catch((err) => console.error("[scheduler] pending-fill reconcile error:", err));
        }

        // Fast pre-proposal broker health gate.
        // E.g., skips queuing an LLM strategy run if the broker is unreachable, account is suspended,
        // order path is down (Tradier OMS 500s, Alpaca trading_blocked), or elevated place failures.
        // Unhealthy + active → auto-halt systemState so future ticks stay paused until recovery.
        const wasActiveForHealthGate = policy.systemState === "active";
        // Hard deadline: Alpaca REST has hung past 14s (inflight-deadline.ts); without this the
        // serial per-account await pins `__tickInFlight`, skips later interval ticks, and the
        // 90s lease expires (Firefighter SOCRATIC-TRADE-4, 2026-08-31).
        let healthSignals: Awaited<ReturnType<typeof checkBrokerHealth>>;
        try {
          healthSignals = await withDeadline(
            checkBrokerHealth(userId, account, brokerGateway),
            SCHEDULER_HEALTH_PROBE_TIMEOUT_MS,
            "checkBrokerHealth timeout"
          );
        } catch (err) {
          healthSignals = {
            isHealthy: false,
            reason: `Broker health check timed out: ${safeErrorMessage(err)}`,
            category: "connectivity"
          };
        }
        const pauseResult = await applyBrokerOrderPlacementPause({
          userId,
          connectedAccountId: accountId,
          accountScope: accountId,
          health: healthSignals,
          policy
        });
        if (pauseResult.action === "halted" || pauseResult.action === "resumed") {
          // Policy may have flipped; re-read so the rest of this tick sees durable state.
          const refreshed = getPolicy(userId, accountId);
          policy.systemState = refreshed.systemState;
        }
        if (!healthSignals.isHealthy) {
          // De-duplicated: logs on first occurrence and on any reason/halt-state change, then a
          // low-rate heartbeat — see logHealthGateSkip doc comment for why (1,364 identical
          // "Tradier order capability probe failed" lines / 9 days, production evidence 2026-09-07).
          // isHaltedPauseAction (not a raw `=== "halted"` check) tracks the DURABLE auto-halt
          // we own, not the one-tick transition marker and not a manual owner pause — see its
          // own doc comment.
          logHealthGateSkip(key, healthSignals.reason ?? "unhealthy", isHaltedPauseAction(pauseResult));
          // Journal the suppression itself: an unhealthy gate is exactly the event an operator
          // later asks "why didn't this account trade?" about.
          void journalLane("broker-health-gate", { userId, connectedAccountId: accountId }, () => ({
            status: "ok" as const,
            summary: `suppressed: ${healthSignals.reason ?? "unhealthy"}${pauseResult.action === "halted" ? "; auto-halted" : pauseResult.action === "still_paused" ? "; still paused" : ""}`
          })).catch(() => undefined);
          // Equity-0 / OMS-down used to write NO strategy_runs row, so the completed-run
          // counter never moved.  Persist once when we auto-halt an active account.
          if (
            shouldPersistBrokerHealthSkip({
              wasActive: wasActiveForHealthGate,
              pauseAction: pauseResult.action
            })
          ) {
            try {
              persistBrokerHealthSkipRun({
                userId,
                connectedAccountId: accountId,
                accountNumber: policy.accountNumber,
                reason: healthSignals.reason ?? "unhealthy",
                halted: true
              });
            } catch (err) {
              console.error("[scheduler] broker-health-gate skip row failed:", err);
            }
          }
          schedule.nextRunAt = null; // Re-evaluate on next tick without advancing the cadence
          continue;
        }
        // Recovered (or was never unhealthy) — clear any pending skip state so the NEXT
        // unhealthy tick logs fresh instead of inheriting a stale occurrence count.
        clearHealthGateSkip(key);

        if (policy.systemState !== "active") {
          schedule.nextRunAt = null;
          continue;
        }

        // Event-only mode: the trigger engine drives runs; skip the fixed-interval cadence.
        // Resolved PER ACCOUNT (2026-07-28): triggerSettings.enabled/mode fall back to the global
        // TRIGGER_ENGINE/TRIGGER_MODE env, and triggerSettings.fallbackIntervalMinutes keeps a
        // safety-floor cadence alive in event mode (used as this account's cadenceMs instead of
        // runCadenceMinutes). Default — engine off for the account, or mode interval/both —
        // leaves the interval lane byte-identical to before.
        const cadenceLane = cadenceLaneDecision(policy);
        if (!cadenceLane.run) {
          schedule.nextRunAt = null;
          continue;
        }

        if (!isRunAllowedNow(policy.runDuringExtendedHours)) {
          // Still publish the next session so Home / iOS do not read "not scheduled"
          // on an Autopilot account after a restart or after the cash close.
          schedule.nextRunAt = presentAccountSchedule({
            memoryLastRunAt: schedule.lastRunAt,
            memoryNextRunAt: null,
            lastStrategyRunStartedAt: schedule.lastRunAt,
            systemState: policy.systemState,
            runCadenceMinutes: policy.runCadenceMinutes,
            triggerSettings: policy.triggerSettings,
            runDuringExtendedHours: policy.runDuringExtendedHours === true
          }).nextRunAt;
          continue;
        }

        const now = Date.now();
        const cadenceMs = cadenceLane.cadenceMinutes * 60_000;

        if (schedule.lastRunAt !== null) {
          const elapsed = now - new Date(schedule.lastRunAt).getTime();
          if (elapsed < cadenceMs) {
            schedule.nextRunAt = new Date(new Date(schedule.lastRunAt).getTime() + cadenceMs).toISOString();
            continue;
          }
        }

        // Due for a run. Record the pre-mutation cadence state so a run suppressed by the monthly
        // operator ceiling below can be ROLLED BACK — otherwise advancing lastRunAt/nextRunAt here
        // makes a never-executed run look completed, so the account waits a full cadence and the UI
        // shows a next-run for a skipped run (see the monthly-ceiling rollback below).
        const prevLastRunAt = schedule.lastRunAt;
        const prevNextRunAt = schedule.nextRunAt;
        schedule.lastRunAt = new Date(now).toISOString();
        schedule.nextRunAt = new Date(now + cadenceMs).toISOString();
        dueRuns.push({ userId, accountId, key, prevLastRunAt, prevNextRunAt });
      }
    }

    // Skip LLM strategy runs when the monthly operator spend ceiling is breached.
    // Non-LLM safety tasks (reconciliation, stop monitor, stale orders, proposal expiry)
    // have already run above — only the LLM-heavy strategy execution is gated here.
    if (!monthlyCeiling.ok) {
      if (dueRuns.length > 0) {
        console.warn(`[scheduler] monthly ceiling: suppressing ${dueRuns.length} due strategy run(s)`);
        // Roll back the cadence state advanced in the due-detection loop above: a run that never
        // executed must NOT look completed, or the account waits a full cadence and the UI shows a
        // next-run for a skipped run. Restore each suppressed account's pre-mutation lastRunAt/nextRunAt.
        for (const { key, prevLastRunAt, prevNextRunAt } of dueRuns) {
          const s = accountSchedules[key];
          if (s) {
            s.lastRunAt = prevLastRunAt;
            s.nextRunAt = prevNextRunAt;
          }
        }
      }
    } else {
      // Do NOT await the strategy promises: a hung LLM/gather used to pin `__tickInFlight` until
      // process restart, which skipped every later 60s interval (no lease renew, no lastTick, no
      // Sentry close). Per-account strategy locks still prevent duplicate money-path work.
      // Stagger launches so concurrent-account bursts do not blow QPM (P2.9).
      let jitterMs = 0;
      for (const { userId, accountId } of dueRuns) {
        const runDelayMs = jitterMs;
        jitterMs += 2000 + Math.random() * 3000;
        void (async () => {
          if (runDelayMs > 0) await new Promise((r) => setTimeout(r, runDelayMs));
          await journalLane("strategy-run", { userId, connectedAccountId: accountId }, async () => {
            const result = await runScheduledStrategyAndMaybeTune(userId, accountId);
            return { status: "ok" as const, summary: `status=${result.status}` };
          });
        })().catch((err) => {
          console.error(`[scheduler] error running strategy for ${userId}/${accountId}:`, err);
        });
      }
    }
  } catch (err) {
    // Never let a thrown error kill the timer
    sentryStatus = "error";
    logError("scheduler.tick", { event: "tick_error", error: safeErrorMessage(err) });
  } finally {
    // Heartbeat AFTER the leader body so a hung tick cannot keep /api/health fresh. Followers
    // never reach this finally. A completed tick (ok or error) proves the loop is alive;
    // the watchdog does not write lastTick on unwedge.
    try {
      setInternalSetting("scheduler:lastTick", new Date().toISOString());
      if (getHealthFailures() > 0) resetHealthFailures();
    } catch (err) {
      console.error("[scheduler] heartbeat write error:", err);
      const failures = incrementHealthFailures();
      const threshold = healthFailureThreshold();
      if (failures >= threshold && singleLeaderEnabled()) {
        console.error(
          `[scheduler] health threshold reached (${failures}/${threshold} consecutive heartbeat failures) — abdicating leadership`
        );
        try { releaseLease(LEASE_OWNER); } catch { /* never throw on shutdown */ }
      }
    }
    if (tickGuardHost.__tickGeneration === myTickGeneration) {
      await sendSentrySchedulerCheckIn(sentryStatus, tickGuardHost.__tickSentryCheckInId ?? sentryCheckInId);
    } else {
      // The watchdog already unwedged this tick (and closed its check-in as "error") while it was
      // still running. The global guard state now belongs to a newer generation, so sending here
      // would either duplicate that close or, worse, apply this abandoned tick's status to the
      // newer tick's still-open check-in. Suppress it — the watchdog's own close already reported.
      console.warn("[scheduler] stale tick finished after watchdog unwedge; suppressing its Sentry check-in");
    }
  }
}

// Thin guarded wrapper: `startScheduler` fires this both immediately (`void tick()`) and on every
// `setInterval(tick, TICK_MS)` callback, so the guard must live here rather than only around the
// interval registration to cover both entry points.  Released in `finally` so a throw inside
// `tickInner` can never wedge the scheduler permanently.  Generation must match so a watchdog
// unwedge cannot be undone by this `finally` when the abandoned body later settles.
async function tick(): Promise<void> {
  if (tickGuardHost.__tickInFlight) {
    logWarn("scheduler.overrun", { reason: "in_flight" });
    recordSchedulerTick("overrun");
    return;
  }
  tickGuardHost.__tickInFlight = true;
  tickGuardHost.__tickStartedAtMs = Date.now();
  tickGuardHost.__tickAbortController = new AbortController();
  const started = tickGuardHost.__tickStartedAtMs;
  const myGen = nextTickGeneration();
  try {
    await tickInner(tickGuardHost.__tickAbortController?.signal);
    const durationMs = Date.now() - started;
    recordSchedulerTick(durationMs > TICK_MS ? "overrun" : "ok", durationMs);
  } catch (err) {
    recordSchedulerTick("error", Date.now() - started);
    throw err;
  } finally {
    if (tickGuardHost.__tickGeneration === myGen) {
      clearTickGuard();
    } else {
      console.warn("[scheduler] stale tick finished after watchdog unwedge; leaving current guard in place");
    }
  }
}

/** Test-only entry point for asserting leader-gate ordering without starting the interval. */
export async function _runSchedulerTickForTest(): Promise<void> {
  await tick();
}
