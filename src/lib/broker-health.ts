import { randomUUID } from "crypto";
import { audit, finishStrategyRun, getDb, getInternalSetting, getPolicy, insertStrategyRun, setInternalSetting, setPolicy, deleteInternalSetting } from "./db";
import { countRecentAuditEvents } from "./db-learning";
import { ExecutionAccount, HealthSignals } from "./execution-mode";
import { accountEquity } from "./risk-breaker";
import { sendNotification } from "./notifications";
import { isAbortOrTimeoutError, isTransientNetworkError } from "./network-errors";
import { isDeadlineTimeoutError } from "./inflight-deadline";
import { startEventLoopLagSampler, stalledMsSince } from "./event-loop-lag";
import { safeErrorMessage } from "./telemetry-sanitize";
import type { BrokerGateway, BrokerageAccount, SystemState, TradingPolicy } from "./types";

/** Consecutive transient connectivity failures before an auto-halt.  One
 *  `fetch failed` / dead socket — or one probe TIMEOUT (board 687a5fb4) — must skip this tick,
 *  not kill Autopilot. */
export const BROKER_CONNECTIVITY_HALT_STREAK = 3;

/**
 * Fraction of a timed-out probe's window that must be measured event-loop stall before the
 * timeout is blamed on THIS process instead of the broker.  Deliberately the same bar as
 * `LANE_STALL_ATTRIBUTION_RATIO` (safety-maintenance.ts, see its doc for why 0.75 and not 0.25);
 * duplicated as a literal because importing it would cycle
 * broker-health -> safety-maintenance -> strategy-execution -> broker-health.  A test pins the two
 * equal.
 */
export const PROBE_STALL_ATTRIBUTION_RATIO = 0.75;

/** True when a probe failure is a TIMEOUT rather than an answer.  Structural first: the
 *  `__deadlineTimeout` flag set where `withDeadline` / `awaitWithFirstCallRetry` manufacture the
 *  error, the lane-deadline expiry marker, and AbortError/TimeoutError by name.  No prose regex. */
export function isProbeTimeoutError(err: unknown): boolean {
  if (isDeadlineTimeoutError(err)) return true;
  if (err && typeof err === "object" && (err as { __laneDeadlineExpiry?: unknown }).__laneDeadlineExpiry === true) return true;
  return isAbortOrTimeoutError(err);
}

/** Honest, owner-readable reason for a probe that timed out because the app itself was frozen. */
export function processStallReason(stalledMs: number, elapsedMs: number): string {
  return (
    `App process was stalled (event loop blocked ${Math.round(stalledMs / 1000)}s of ` +
    `${Math.round(elapsedMs / 1000)}s); broker not at fault`
  );
}

/** Health signals for a probe whose timeout is attributed to a stalled event loop.  Unhealthy (we
 *  still do not know the broker is fine, so this tick launches nothing) but never streak-counted. */
export function processStallHealthSignals(stalledMs: number, elapsedMs: number): HealthSignals {
  return {
    isHealthy: false,
    reason: processStallReason(stalledMs, elapsedMs),
    category: "connectivity",
    probeTimedOut: true,
    processStall: { stalledMs: Math.round(stalledMs), elapsedMs: Math.round(elapsedMs) }
  };
}

/**
 * Convert the scheduler's probe-deadline rejection into health signals.  The scheduler wraps
 * `checkBrokerHealth` in `withLaneDeadline`, whose expiry carries the measured stall; a
 * stall-dominated expiry is the process's fault, anything else is a (streak-eligible) timeout.
 */
export function healthSignalsFromProbeFailure(err: unknown): HealthSignals {
  const expiry = err as { __laneDeadlineExpiry?: unknown; stalledMs?: unknown; elapsedMs?: unknown; stallRatio?: unknown } | null;
  if (
    expiry &&
    typeof expiry === "object" &&
    expiry.__laneDeadlineExpiry === true &&
    typeof expiry.stallRatio === "number" &&
    typeof expiry.stalledMs === "number" &&
    typeof expiry.elapsedMs === "number" &&
    expiry.stallRatio >= PROBE_STALL_ATTRIBUTION_RATIO
  ) {
    return processStallHealthSignals(expiry.stalledMs, expiry.elapsedMs);
  }
  return {
    isHealthy: false,
    reason: `Broker health check timed out: ${safeErrorMessage(err)}`,
    category: "connectivity",
    ...(isProbeTimeoutError(err) ? { probeTimedOut: true } : {})
  };
}

/**
 * Terminal status + summary + audit kind for a strategy run that skips because the in-run broker
 * probe was unhealthy.  A stall-attributed probe is NOT a broker problem, so it finishes as the
 * generic `skipped` (every client — web `strategyRunStatusLabel`, iOS ActivityView — already
 * renders that as "Skipped"; a brand-new status would render as "Completed" on the current iOS
 * build, whose switch defaults unknown statuses to Completed).
 */
export function brokerHealthRunSkip(health: HealthSignals): {
  status: "skipped" | "skipped_broker_unhealthy";
  summary: string;
  auditKind: "run_skipped_process_stalled" | "run_skipped_broker_unhealthy";
} {
  if (health.processStall) {
    return {
      status: "skipped",
      summary: `${health.reason ?? processStallReason(health.processStall.stalledMs, health.processStall.elapsedMs)}. Skipping this strategy run; the next one retries.`,
      auditKind: "run_skipped_process_stalled"
    };
  }
  return {
    status: "skipped_broker_unhealthy",
    summary: `Broker health check failed: ${health.reason}. Skipping strategy run to avoid consuming budget.`,
    auditKind: "run_skipped_broker_unhealthy"
  };
}

export function brokerConnectivityStreakKey(userId: string, accountScope: string): string {
  return `broker:connectivity-fail-streak:${userId}:${accountScope}`;
}

/**
 * Validates whether the broker connection is currently healthy and the account is ready for trading.
 * Checks connectivity, account status, order-placement capability (when the gateway can probe it),
 * and recent error rates to prevent the agent from burning LLM tokens when orders cannot land.
 *
 * Unhealthy results are sticky at the policy layer via {@link applyBrokerOrderPlacementPause}:
 * autonomous strategy runs flip `systemState` to `halted` until the probe recovers (auto-resume)
 * or the owner re-arms.
 */
export async function checkBrokerHealth(
  userId: string,
  account: ExecutionAccount,
  brokerGateway?: BrokerGateway
): Promise<HealthSignals> {
  // If no gateway is provided, we can't check broker-side health.
  // This typically happens if the account isn't meant to submit orders (e.g. read-only mode).
  if (!brokerGateway) {
    return { isHealthy: true };
  }

  // Stall attribution window (board 687a5fb4).  Idempotent sampler start; no behavior change.
  startEventLoopLagSampler();
  const probeStartedAt = Date.now();
  try {
    const [accounts, portfolio] = await Promise.all([
      brokerGateway.getAccounts(),
      brokerGateway.getPortfolio(account.accountNumber ?? "")
    ]);

    const activeBrokerAccount = accounts.find((a: BrokerageAccount) => a.accountNumber === account.accountNumber);
    if (!activeBrokerAccount) {
      return {
        isHealthy: false,
        reason: "Account not found on broker",
        category: "connectivity"
      };
    }

    if (!activeBrokerAccount.agenticAllowed) {
      return {
        isHealthy: false,
        reason: "Account is not marked agenticAllowed by the broker",
        category: "account"
      };
    }

    // Minimum notional check to prevent burning tokens when there's no money.
    // E.g., Robinhood requires $1 minimum for fractional shares.
    const equity = accountEquity(portfolio);
    if (equity < 5.0) {
      return {
        isHealthy: false,
        reason: `Account equity (${equity}) is too low to trade`,
        category: "equity"
      };
    }

    // Check recent error rate: if there are >= 3 order_placement_uncertain errors in the last 15 mins,
    // the broker is likely having transient issues.
    const recentErrors = countRecentAuditEvents("order_placement_uncertain", account.id, 15, userId);
    if (recentErrors >= 3) {
      return {
        isHealthy: false,
        reason: `Elevated error rate: ${recentErrors} order placement uncertainties in the last 15 minutes`,
        category: "error_rate"
      };
    }

    // Infrastructure place failures (5xx / OMS down / backend unreachable) — 2+ in 30 minutes
    // means further strategy LLM runs will just mint unplaceable proposals.
    const recentInfra = countRecentAuditEvents("order_place_infrastructure_failed", account.id, 30, userId);
    if (recentInfra >= 2) {
      return {
        isHealthy: false,
        reason: `Broker order path failing: ${recentInfra} infrastructure placement failures in the last 30 minutes`,
        category: "order_capability"
      };
    }

    // Optional proactive OMS/order-path probe (Tradier preview, Alpaca trading_blocked, …).
    // Throttled inside the gateway implementations so a multi-account scheduler tick does not
    // hammer the broker.
    if (typeof brokerGateway.probeOrderCapability === "function" && account.accountNumber) {
      const probe = await brokerGateway.probeOrderCapability(account.accountNumber);
      if (!probe.ok) {
        return {
          isHealthy: false,
          reason: probe.reason ?? "Broker reports orders cannot be placed",
          category: "order_capability"
        };
      }
    }

    return { isHealthy: true };
  } catch (err) {
    const timedOut = isProbeTimeoutError(err);
    if (timedOut) {
      // A read that never answered while the event loop was pinned for most of the wait says
      // nothing about the broker — the 16s+8s timer could not even fire on time.
      const elapsedMs = Date.now() - probeStartedAt;
      const stalledMs = stalledMsSince(probeStartedAt);
      if (elapsedMs > 0 && stalledMs / elapsedMs >= PROBE_STALL_ATTRIBUTION_RATIO) {
        return processStallHealthSignals(stalledMs, elapsedMs);
      }
    }
    return {
      isHealthy: false,
      reason: `Broker connectivity failure: ${err instanceof Error ? err.message : String(err)}`,
      category: "connectivity",
      ...(timedOut ? { probeTimedOut: true } : {})
    };
  }
}

// ── Auto-pause / auto-resume when the account cannot place orders ────────────

export type BrokerPlacementPauseMarker = {
  since: string;
  reason: string;
  category?: HealthSignals["category"];
  /** Always true for this path — owner manual halt is unmarked and never auto-resumed by us. */
  autoResume: true;
  /** systemState before we flipped it (should be "active"). */
  priorState: SystemState;
};

const pauseMarkerKey = (userId: string, accountScope: string) =>
  `broker:placement-paused:${userId}:${accountScope}`;

export function getBrokerPlacementPauseMarker(
  userId: string,
  accountScope: string
): BrokerPlacementPauseMarker | undefined {
  const raw = getInternalSetting<BrokerPlacementPauseMarker>(pauseMarkerKey(userId, accountScope));
  if (!raw || typeof raw !== "object" || typeof raw.since !== "string" || raw.autoResume !== true) return undefined;
  return raw;
}

/**
 * Drop the auto-resume marker AND the connectivity streak for this scope.  Every caller that clears
 * the marker is ending a pause episode (healthy probe, owner halt, boot interlock, and the ops-token
 * `set_system_state` in PR #3754, which calls this directly): a streak left behind would let the
 * next single timeout after a re-arm halt again — the first-strike halt this lane removed (board
 * 687a5fb4 review round).
 */
export function clearBrokerPlacementPauseMarker(userId: string, accountScope: string): void {
  deleteInternalSetting(pauseMarkerKey(userId, accountScope));
  deleteInternalSetting(brokerConnectivityStreakKey(userId, accountScope));
}

export type ApplyBrokerPauseResult =
  | { action: "none" }
  | { action: "halted"; reason: string }
  | { action: "resumed"; priorReason?: string }
  | { action: "still_paused"; reason: string; autoOwned: boolean };

/**
 * Persist a skipped strategy_runs row when the scheduler health gate auto-halts
 * an active account.  Journal-only skip left tradingLiveness with no row while
 * equity-0 accounts sat halted (board 06df80cf).  Do not call on already-halted
 * ticks — that would write a row every 15s.
 */
export function shouldPersistBrokerHealthSkip(input: {
  wasActive: boolean;
  pauseAction: ApplyBrokerPauseResult["action"];
}): boolean {
  return input.wasActive && input.pauseAction === "halted";
}

export function persistBrokerHealthSkipRun(input: {
  userId: string;
  connectedAccountId: string;
  accountNumber?: string;
  reason: string;
  halted: boolean;
}): string {
  const runId = randomUUID();
  insertStrategyRun(runId, input.userId, input.connectedAccountId, input.accountNumber);
  const summary = input.halted
    ? `Broker cannot place orders — autonomous strategy auto-paused: ${input.reason}`
    : `Broker health check failed: ${input.reason}. Skipping strategy run to avoid consuming budget.`;
  finishStrategyRun(runId, "skipped_broker_unhealthy", summary, input.userId);
  audit(
    "run_skipped_broker_unhealthy",
    { runId, reason: input.reason, autoHalted: input.halted, source: "scheduler-gate" },
    input.userId,
    input.connectedAccountId
  );
  return runId;
}

/**
 * When broker health says the account cannot place orders and the policy is `active`, flip
 * `systemState` to `halted` so future autonomous strategy runs (scheduler + locked loop) stop
 * burning LLM budget. When health recovers and the halt was ours (marker present), auto-resume
 * to `active`. Manual owner halts (no marker) are never auto-resumed.
 *
 * Decides against the DURABLE policy, re-read here, not the caller's snapshot (board 687a5fb4).
 * The scheduler reads its snapshot BEFORE a probe that can take 30s; deciding on that snapshot
 * let an owner Pause issued mid-probe be claimed as our auto-pause (marker written, so the next
 * healthy probe "resumed" it), and `setPolicy(snapshot)` rewrote every field the owner edited in
 * that window.  Strategy runs pass a run-scoped policy (manual runs force `active` + `propose`)
 * that must never be persisted at all.  Only `systemState` is ever written here; the caller's
 * object is updated in place so it sees the new state.
 *
 * Streak gate: a transient socket failure OR a probe timeout (`health.probeTimedOut`) must repeat
 * BROKER_CONNECTIVITY_HALT_STREAK times in a row before an auto-halt.  A probe attributed to a
 * stalled event loop (`health.processStall`) is not the broker's failure: it neither counts toward
 * nor resets the streak.
 *
 * Safe to call every scheduler tick — notifications fire once per pause episode.
 */
export async function applyBrokerOrderPlacementPause(input: {
  userId: string;
  connectedAccountId?: string;
  accountScope: string;
  health: HealthSignals;
  /** Caller's policy snapshot.  Read-only input for the decision; its `systemState` is updated in
   *  place when the durable state flips. */
  policy: TradingPolicy;
}): Promise<ApplyBrokerPauseResult> {
  const { userId, connectedAccountId, accountScope, health, policy } = input;
  const marker = getBrokerPlacementPauseMarker(userId, accountScope);
  // Durable state, read synchronously right before any write (no await between read and write).
  const current = getPolicy(userId, connectedAccountId);

  if (health.isHealthy) {
    deleteInternalSetting(brokerConnectivityStreakKey(userId, accountScope));
    if (!marker) return { action: "none" };
    // Only auto-resume if we still own the halt (marker present) and state is still halted.
    // If the owner already re-armed to active, just clear the marker.
    if (current.systemState === "halted") {
      setPolicy({ ...current, systemState: "active" }, userId, connectedAccountId);
      policy.systemState = "active";
      audit(
        "broker_placement_auto_resumed",
        {
          reason: marker.reason,
          category: marker.category,
          since: marker.since,
          from: "halted",
          to: "active"
        },
        userId,
        connectedAccountId
      );
      // Delivery honors the user's real enabledEvents toggle (owner ruling 2026-08-12, "ALL
      // toggles must be real" — no force-include). A legacy stored enabledEvents array predating
      // this event type was backfilled once by migration 78 (db.ts); after that the toggle is
      // genuinely the user's.
      await sendNotification(
        {
          type: "risk_advisory",
          title: "Broker order path recovered — autonomous strategy resumed",
          payload: {
            reason: marker.reason,
            pausedSince: marker.since,
            action: "auto_resume"
          }
        },
        { policy: current, userId, connectedAccountId }
      );
      clearBrokerPlacementPauseMarker(userId, accountScope);
      return { action: "resumed", priorReason: marker.reason };
    }
    clearBrokerPlacementPauseMarker(userId, accountScope);
    return { action: "none" };
  }

  // Unhealthy.
  const reason = health.reason ?? "Broker cannot place orders";

  if (current.systemState === "halted") {
    // Already halted — ensure marker exists if this was (or becomes) our pause, so auto-resume works.
    if (!marker) {
      // Do NOT claim ownership of a pre-existing owner halt. Without a marker we won't auto-resume.
      // autoOwned: false so logHealthGateSkip does not emit (auto-halted) / halted:true for a
      // manual owner pause (Codex PR #3189 P2).
      return { action: "still_paused", reason, autoOwned: false };
    }
    return { action: "still_paused", reason: marker.reason, autoOwned: true };
  }

  if (current.systemState !== "active") {
    // close_only / liquidating: leave owner intent alone; still skip runs via health gate.
    return { action: "none" };
  }

  // The app was frozen, not the broker: skip this tick (isHealthy=false upstream) but leave the
  // streak exactly where it was — neither evidence of a broker outage nor of broker recovery.
  if (health.processStall) {
    return { action: "none" };
  }

  // Transient connectivity (dead keep-alive, one `fetch failed`) or a probe that got no answer in
  // time is not an order-path outage.  Skip this tick via isHealthy=false; only halt after a
  // short consecutive streak so Autopilot survives a single blip.  The timeout flag is structural
  // (set where the timeout is produced), deliberately NOT a widening of isTransientNetworkError.
  if (health.category === "connectivity" && (health.probeTimedOut === true || isTransientNetworkError(reason))) {
    const streakKey = brokerConnectivityStreakKey(userId, accountScope);
    const prev = getInternalSetting<number>(streakKey);
    const next = (typeof prev === "number" && Number.isFinite(prev) ? prev : 0) + 1;
    setInternalSetting(streakKey, next);
    if (next < BROKER_CONNECTIVITY_HALT_STREAK) {
      return { action: "none" };
    }
  }

  // Flip active → halted (systemState only — never the caller's snapshot).
  const priorState = current.systemState;
  setPolicy({ ...current, systemState: "halted" }, userId, connectedAccountId);
  policy.systemState = "halted";
  const nextMarker: BrokerPlacementPauseMarker = {
    since: new Date().toISOString(),
    reason,
    category: health.category,
    autoResume: true,
    priorState
  };
  setInternalSetting(pauseMarkerKey(userId, accountScope), nextMarker);
  // The streak did its job.  Reset it so a re-arm (console Start, mobile, ops token) while the broker
  // is still flaky needs a fresh three-in-a-row before the next connectivity halt, instead of
  // re-halting on the first timeout (board 687a5fb4 review round).
  deleteInternalSetting(brokerConnectivityStreakKey(userId, accountScope));
  audit(
    "broker_placement_auto_halted",
    {
      reason,
      category: health.category,
      from: priorState,
      to: "halted",
      ...(health.probeTimedOut ? { probeTimedOut: true, streak: BROKER_CONNECTIVITY_HALT_STREAK } : {})
    },
    userId,
    connectedAccountId
  );
  await sendNotification(
    {
      type: "kill_switch",
      title: "Autonomous strategy paused — broker cannot place orders",
      payload: {
        reason,
        category: health.category,
        action: "auto_halt",
        note: "Will auto-resume when the broker order path recovers. You can also re-arm Start manually after fixing the connection."
      }
    },
    { policy: current, userId, connectedAccountId }
  );
  return { action: "halted", reason };
}

/** Pause-marker scope for an account: the connected account id, else the legacy
 *  "<accountNumber>:<broker or unknown>" scope strategy.ts uses when it has no account id. */
export function brokerPauseAccountScope(connectedAccountId: string | undefined, accountNumber: string | undefined, broker?: string): string {
  // Same template as strategy.ts (`${policy.accountNumber}:${broker ?? "unknown"}`), byte for byte.
  return connectedAccountId ?? `${accountNumber}:${broker ?? "unknown"}`;
}

/**
 * The OWNER just halted this account on purpose (Pause/Stop, or a boot interlock acting for the
 * owner).  If a broker-health auto-pause marker is sitting on it, the halt is no longer ours — drop
 * the marker so a later healthy probe can never "auto-resume" over the owner's decision.
 * Returns true when a marker was removed (and audited).
 */
export function releaseBrokerPlacementPauseToOwner(input: {
  userId: string;
  connectedAccountId?: string;
  accountNumber?: string;
  source: string;
}): boolean {
  const scope = brokerPauseAccountScope(input.connectedAccountId, input.accountNumber);
  // Read, clear, and audit as ONE transaction: a SQLITE_BUSY anywhere rolls the whole release back,
  // so a retry (the boot interlock wraps this in sqliteYieldRetry) redoes it exactly once instead of
  // finding the marker already gone and skipping the streak reset and the ownership receipt.
  return getDb()
    .transaction((): boolean => {
      const marker = getBrokerPlacementPauseMarker(input.userId, scope);
      if (!marker) return false;
      clearBrokerPlacementPauseMarker(input.userId, scope);
      audit(
        "broker_placement_pause_owner_override",
        { source: input.source, autoPauseReason: marker.reason, autoPausedSince: marker.since },
        input.userId,
        input.connectedAccountId
      );
      return true;
    })
    .immediate();
}

/**
 * True when a placeEquityOrder error message indicates infrastructure/OMS failure rather than a
 * normal validation or buying-power reject. Used to audit `order_place_infrastructure_failed` and
 * feed the broker-health consecutive-failure gate.
 */
export function isOrderPlacementInfrastructureFailure(message: string): boolean {
  const m = String(message ?? "");
  if (!m.trim()) return false;
  // Explicit non-infra rejects first (avoid false positives on "HTTP 403 insufficient buying power")
  if (
    /buying power|insufficient|notional|wash.?sale|pdt|day.?trad|fractional|qty|quantity|validation|OrderValidation|not tradable|halted|universe|margin.?call/i.test(
      m
    ) &&
    !/HTTP 5\d\d|backend|OmsUnavailable|OmsInternal|ECONN|ETIMEDOUT|fetch failed|network/i.test(m)
  ) {
    return false;
  }
  return (
    /HTTP 5\d\d/i.test(m) ||
    /communicating with the backend/i.test(m) ||
    /unexpected error occurred/i.test(m) ||
    /OmsUnavailable|OmsInternalError/i.test(m) ||
    /ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|fetch failed|network/i.test(m) ||
    /broker (?:connectivity|unreachable|unavailable)/i.test(m) ||
    /Tradier HTTP 5\d\d/i.test(m) ||
    /Alpaca.*\b5\d\d\b/i.test(m)
  );
}

/**
 * Re-read policy for the account (used by scheduler after pause may have mutated state).
 */
export function freshPolicyForAccount(userId: string, connectedAccountId?: string): TradingPolicy {
  return getPolicy(userId, connectedAccountId);
}
