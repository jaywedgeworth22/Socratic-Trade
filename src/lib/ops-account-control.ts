import { verifyAutonomyArmingPreconditions } from "./autonomy-arming";
import { getBrokerGateway } from "./broker";
import { isWorkingOrderState } from "./broker-held-orders";
import { checkBrokerHealth, clearBrokerPlacementPauseMarker, getBrokerPlacementPauseMarker } from "./broker-health";
import {
  audit,
  findConnectedAccountById,
  getAutoResumeOnBoot,
  getConnectedAccount,
  getDb,
  getInternalSetting,
  getLastStrategyRunStartedAt,
  getPolicy,
  listBrokerProtectiveStops,
  peekPolicy,
  setPolicy
} from "./db";
import { emitDashboardEvent } from "./events";
import type { HealthSignals } from "./execution-mode";
import { checkMonthlyLlmSpendCeiling } from "./llm-budget";
import { isRunAllowedNow } from "./market-hours";
import { cancelWorkingOrder, OrderCancelPreconditionError } from "./order-cancel";
import { isAppManagedProtectiveStopClientOrderId } from "./order-provenance";
import { presentAccountSchedule } from "./scheduler-presentation";
import { safeErrorMessage } from "./telemetry-sanitize";
import { cadenceLaneDecision } from "./triggers";
import type { ConnectedAccount, EquityOrder, SystemState, TradingPolicy } from "./types";

/**
 * Ops-token account control (POST /api/ops/account-control).
 *
 * Why this exists: every console mutation (cancel, Start, Stop, policy PUT) is session-gated and
 * acts on the user's SELECTED account.  Agents hold only the ops diagnostic token, and running app
 * code in a side process is unsafe (in-memory caches, the broker mutation lease, and the
 * Infisical-injected secrets live only in the server process).  This module lets an ops caller act
 * on ONE explicitly named connected account, in-process, through the same code the console uses:
 *
 * - cancels go through `cancelWorkingOrder` (src/lib/order-cancel.ts) with an explicit
 *   `connectedAccountId`, so the lease receipt, protective-stop tombstone, bracket teardown, dust
 *   advisory, dashboard event, cache invalidation and `order_cancel` audit are the console's;
 * - arming runs `verifyAutonomyArmingPreconditions` (src/lib/autonomy-arming.ts), the checks the
 *   console Start button runs;
 * - state writes go through `setPolicy(policy, userId, connectedAccountId)`, the same account-scoped
 *   writer the console's targeted policy PUT and the scheduler's own auto-halt/auto-resume use.
 *
 * It never reads or writes the selected account and never changes `isActive` (which is only the
 * console's view pointer — the scheduler runs every connected account whose own systemState is
 * active).  Responses carry no credentials, no raw broker bodies, and only masked account numbers.
 */

export const OPS_ACCOUNT_CONTROL_ACTIONS = ["list_working_orders", "cancel_working_orders", "set_system_state"] as const;
export type OpsAccountControlAction = (typeof OPS_ACCOUNT_CONTROL_ACTIONS)[number];

export const OPS_SETTABLE_SYSTEM_STATES = ["active", "close_only", "halted"] as const;
export type OpsSettableSystemState = (typeof OPS_SETTABLE_SYSTEM_STATES)[number];

/** Upper bound on explicitly named order ids per call. */
export const OPS_MAX_ORDER_IDS = 100;
const MAX_ID_LENGTH = 200;
/** A broker read that has not answered by now is reported as a failure instead of hanging the call. */
const BROKER_READ_TIMEOUT_MS = 15_000;
/** Matches the scheduler's TICK_MS (src/lib/scheduler.ts). */
const SCHEDULER_TICK_MS = 60_000;
const SCHEDULER_STALE_TICK_MS = 3 * SCHEDULER_TICK_MS;
const OPS_ACTOR = "ops-token";

export type OpsAccountControlRequest =
  | { action: "list_working_orders"; connectedAccountId: string; dryRun: boolean }
  | { action: "cancel_working_orders"; connectedAccountId: string; orderIds?: string[]; dryRun: boolean }
  | { action: "set_system_state"; connectedAccountId: string; systemState: OpsSettableSystemState; dryRun: boolean };

export type ParsedOpsAccountControlRequest = { ok: true; request: OpsAccountControlRequest } | { ok: false; error: string };

export interface OpsAccountControlOutcome {
  status: number;
  body: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseOpsAccountControlRequest(raw: unknown): ParsedOpsAccountControlRequest {
  if (!isRecord(raw)) return { ok: false, error: "Body must be a JSON object." };
  const action = raw.action;
  if (typeof action !== "string" || !(OPS_ACCOUNT_CONTROL_ACTIONS as readonly string[]).includes(action)) {
    return { ok: false, error: `action must be one of: ${OPS_ACCOUNT_CONTROL_ACTIONS.join(", ")}.` };
  }
  const connectedAccountId = typeof raw.connectedAccountId === "string" ? raw.connectedAccountId.trim() : "";
  if (!connectedAccountId) return { ok: false, error: "connectedAccountId is required." };
  if (connectedAccountId.length > MAX_ID_LENGTH) return { ok: false, error: "connectedAccountId is too long." };
  if (raw.dryRun !== undefined && typeof raw.dryRun !== "boolean") return { ok: false, error: "dryRun must be a boolean." };
  const dryRun = raw.dryRun === true;

  if (action === "list_working_orders") return { ok: true, request: { action, connectedAccountId, dryRun } };

  if (action === "cancel_working_orders") {
    if (raw.orderIds === undefined) return { ok: true, request: { action, connectedAccountId, dryRun } };
    if (!Array.isArray(raw.orderIds) || raw.orderIds.length === 0) {
      return { ok: false, error: "orderIds must be a non-empty array of order ids (omit it to cancel every working order)." };
    }
    if (raw.orderIds.length > OPS_MAX_ORDER_IDS) return { ok: false, error: `orderIds may name at most ${OPS_MAX_ORDER_IDS} orders.` };
    const orderIds: string[] = [];
    for (const value of raw.orderIds) {
      const id = typeof value === "string" ? value.trim() : "";
      if (!id || id.length > MAX_ID_LENGTH) return { ok: false, error: "Every orderIds entry must be a non-empty order id string." };
      if (!orderIds.includes(id)) orderIds.push(id);
    }
    return { ok: true, request: { action, connectedAccountId, orderIds, dryRun } };
  }

  const systemState = raw.systemState;
  if (typeof systemState !== "string" || !(OPS_SETTABLE_SYSTEM_STATES as readonly string[]).includes(systemState)) {
    return { ok: false, error: `systemState must be one of: ${OPS_SETTABLE_SYSTEM_STATES.join(", ")}.` };
  }
  return { ok: true, request: { action: "set_system_state", connectedAccountId, systemState: systemState as OpsSettableSystemState, dryRun } };
}

// ── Output hygiene ─────────────────────────────────────────────────────────────

export function maskAccountNumber(accountNumber: string | undefined | null): string | null {
  if (!accountNumber) return null;
  const tail = accountNumber.slice(-4);
  return `****${tail}`;
}

/** Error text for a response: secrets redacted, the full broker account number masked. */
function redactFor(account: ConnectedAccount, error: unknown): string {
  let text = safeErrorMessage(error);
  const accountNumber = account.accountNumber;
  if (accountNumber && accountNumber.length >= 4) text = text.split(accountNumber).join(maskAccountNumber(accountNumber) ?? "****");
  return text;
}

function accountSummary(account: ConnectedAccount) {
  return {
    connectedAccountId: account.id,
    label: account.label,
    broker: account.broker,
    environment: account.environment,
    accountNumberMasked: maskAccountNumber(account.accountNumber),
    /** The console's selected-account pointer (connected_accounts.is_active).  Not a scheduling input. */
    isSelectedInConsole: account.isActive,
    isDraining: account.isDraining === true
  };
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ── Working orders ─────────────────────────────────────────────────────────────

export interface OpsWorkingOrder {
  orderId: string;
  symbol: string;
  side: EquityOrder["side"];
  type: EquityOrder["type"];
  quantity: number | null;
  dollarAmount: number | null;
  filledQuantity: number | null;
  limitPrice: number | null;
  stopPrice: number | null;
  timeInForce: string | null;
  state: string;
  createdAt: string;
  /** True when the app placed or tracks this order as a protective stop (cancelling it writes a do-not-replace tombstone). */
  protectiveStop: boolean;
}

function describeWorkingOrder(order: EquityOrder, trackedStopIds: Set<string>): OpsWorkingOrder {
  return {
    orderId: order.id,
    symbol: order.symbol,
    side: order.side,
    type: order.type,
    quantity: order.quantity ?? null,
    dollarAmount: order.dollarAmount ?? null,
    filledQuantity: order.filledQuantity ?? null,
    limitPrice: order.limitPrice ?? null,
    stopPrice: order.stopPrice ?? null,
    timeInForce: order.timeInForce ?? null,
    state: order.state,
    createdAt: order.createdAt,
    protectiveStop: trackedStopIds.has(order.id) || isAppManagedProtectiveStopClientOrderId(order.clientOrderId)
  };
}

async function readWorkingOrders(
  account: ConnectedAccount,
  policy: TradingPolicy,
  userId: string
): Promise<{ ok: true; orders: EquityOrder[] } | { ok: false; error: string }> {
  const accountNumber = policy.accountNumber;
  if (!accountNumber) return { ok: false, error: "That connected account has no broker account number." };
  try {
    const orders = await withTimeout(getBrokerGateway(policy, userId).getEquityOrders(accountNumber), BROKER_READ_TIMEOUT_MS, "getEquityOrders");
    return { ok: true, orders: orders.filter((order) => isWorkingOrderState(order.state)) };
  } catch (error) {
    return { ok: false, error: redactFor(account, error) };
  }
}

// ── Scheduler eligibility ──────────────────────────────────────────────────────

export interface NextEligibleRun {
  /** True when nothing in the scheduler's own gate order blocks a strategy run for this account. */
  willRun: boolean;
  /** When the scheduler will launch the next strategy run (ISO), or null when it will not. */
  at: string | null;
  atCentral: string | null;
  /** One sentence the operator can act on. */
  reason: string;
  /** Every gate that blocks a run, in the scheduler's own evaluation order. */
  blockers: string[];
  notes: string[];
  lastRunAt: string | null;
  cadenceMinutes: number | null;
  schedulerLastTickAt: string | null;
}

function centralTime(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return null;
  const text = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(date);
  return `${text} CT`;
}

/**
 * What the scheduler (src/lib/scheduler.ts `tickInner`, per-account loop) will do with this account
 * on its next ticks, evaluated in the same gate order: test broker → draining → account number →
 * broker health gate → systemState → cadence lane → market session → cadence clock → monthly LLM
 * ceiling.  Read-only; uses the scheduler's own presentation helper for the next-run time.
 */
export function describeNextEligibleRun(input: {
  userId: string;
  account: ConnectedAccount;
  policy: TradingPolicy;
  brokerHealth?: HealthSignals;
  now?: Date;
}): NextEligibleRun {
  const { userId, account, policy, brokerHealth } = input;
  const now = input.now ?? new Date();
  const blockers: string[] = [];
  const notes: string[] = [
    "isActive only marks the console's selected account.  The scheduler iterates every connected account and runs each one whose own systemState is active, selected or not, so this account does not need to be selected."
  ];
  const lastRunAt = getLastStrategyRunStartedAt(userId, account.id);
  const schedulerLastTickAt = getInternalSetting<string>("scheduler:lastTick") ?? null;
  const lane = cadenceLaneDecision(policy);

  if (account.broker === "test") blockers.push("This is an internal test-broker account; the scheduler never runs strategy for it.");
  if (account.isDraining) blockers.push("This account is draining (being disconnected); the scheduler only winds it down.");
  if (!policy.accountNumber) blockers.push("This connected account has no broker account number.");
  if (brokerHealth && !brokerHealth.isHealthy) {
    blockers.push(
      `The broker health gate is failing right now (${brokerHealth.reason ?? "unhealthy"}).  The scheduler skips this account every tick until it passes, and re-halts an active account if the failure persists.`
    );
  }
  if (policy.systemState !== "active") {
    blockers.push(
      `systemState is ${policy.systemState}; the scheduler launches strategy runs only for active accounts${
        policy.systemState === "close_only" ? " (close_only still runs the protective-stop and reconcile lanes)" : ""
      }.`
    );
  }
  if (!lane.run) {
    blockers.push("Trigger mode is event-only with no fallback interval, so there is no interval run; the trigger engine launches runs on material events.");
  }
  const ceiling = checkMonthlyLlmSpendCeiling(now);
  if (!ceiling.ok) {
    blockers.push(
      `The monthly LLM spend ceiling is reached ($${ceiling.totalUsd.toFixed(2)} of $${(ceiling.ceilingUsd ?? 0).toFixed(2)}); strategy runs for every account are suppressed until it resets.`
    );
  }

  if (policy.systemState === "active" && !getAutoResumeOnBoot(userId) && process.env.AUTONOMY_RESUME_ON_BOOT !== "1") {
    notes.push("A restart or deploy reverts this account to halted (autoResumeOnBoot is off), so re-arm it after the next deploy.");
  }
  const lastTickMs = schedulerLastTickAt ? Date.parse(schedulerLastTickAt) : Number.NaN;
  if (!Number.isFinite(lastTickMs)) {
    notes.push("The scheduler has not recorded a tick in this database yet; nothing runs until it does.");
  } else if (now.getTime() - lastTickMs > SCHEDULER_STALE_TICK_MS) {
    notes.push(`The scheduler's last tick was at ${schedulerLastTickAt}, more than three minutes ago; nothing runs until it ticks again.`);
  }

  if (blockers.length > 0) {
    return {
      willRun: false,
      at: null,
      atCentral: null,
      reason: `Will not run: ${blockers[0]}`,
      blockers,
      notes,
      lastRunAt,
      cadenceMinutes: lane.run ? lane.cadenceMinutes : null,
      schedulerLastTickAt
    };
  }

  const schedule = presentAccountSchedule({
    lastStrategyRunStartedAt: lastRunAt,
    systemState: policy.systemState,
    runCadenceMinutes: policy.runCadenceMinutes,
    triggerSettings: policy.triggerSettings,
    runDuringExtendedHours: policy.runDuringExtendedHours === true,
    now
  });
  const at = schedule.nextRunAt;
  const atMs = at ? Date.parse(at) : Number.NaN;
  let reason: string;
  if (Number.isFinite(atMs) && atMs <= now.getTime() + 1_000) {
    reason = "Due now: the next scheduler tick (every 60 seconds) launches a strategy run for this account.";
  } else if (!isRunAllowedNow(policy.runDuringExtendedHours === true, now)) {
    reason = `The market is closed now; the first run is at the next ${
      policy.runDuringExtendedHours === true ? "extended-hours or regular" : "regular"
    } session, ${centralTime(at) ?? at}.`;
  } else {
    reason = `On cadence: every ${lane.cadenceMinutes} minutes after the last run${lastRunAt ? ` (${centralTime(lastRunAt)})` : ""}, so the next run is ${centralTime(at) ?? at}.`;
  }
  return {
    willRun: true,
    at,
    atCentral: centralTime(at),
    reason,
    blockers,
    notes,
    lastRunAt,
    cadenceMinutes: lane.cadenceMinutes,
    schedulerLastTickAt
  };
}

// ── Actions ────────────────────────────────────────────────────────────────────

function auditOpsCall(
  account: ConnectedAccount,
  request: OpsAccountControlRequest,
  outcome: OpsAccountControlOutcome,
  detail: Record<string, unknown>
): void {
  try {
    audit(
      "ops_account_control",
      {
        action: request.action,
        dryRun: request.dryRun,
        actor: OPS_ACTOR,
        status: outcome.status,
        ok: outcome.body.ok === true,
        ...detail
      },
      account.userId,
      account.id
    );
  } catch (error) {
    // A receipt write must not turn a completed broker action into a 500 the caller retries.
    console.error("[ops-account-control] audit write failed:", safeErrorMessage(error));
  }
}

async function listWorkingOrders(account: ConnectedAccount, request: OpsAccountControlRequest): Promise<OpsAccountControlOutcome> {
  const userId = account.userId;
  const policy = peekPolicy(userId, account.id);
  const read = await readWorkingOrders(account, policy, userId);
  if (!read.ok) {
    const outcome = { status: policy.accountNumber ? 502 : 409, body: { ok: false, error: `Could not read working orders: ${read.error}`, account: accountSummary(account) } };
    auditOpsCall(account, request, outcome, { error: outcome.body.error });
    return outcome;
  }
  const trackedStopIds = new Set(listBrokerProtectiveStops(policy.accountNumber ?? "", userId).map((row) => row.brokerOrderId));
  const workingOrders = read.orders.map((order) => describeWorkingOrder(order, trackedStopIds));
  const outcome = {
    status: 200,
    body: { ok: true, action: request.action, account: accountSummary(account), systemState: policy.systemState, count: workingOrders.length, workingOrders }
  };
  auditOpsCall(account, request, outcome, { results: workingOrders.map((order) => ({ orderId: order.orderId, symbol: order.symbol, state: order.state })) });
  return outcome;
}

interface CancelResult {
  orderId: string;
  ok: boolean;
  symbol?: string;
  side?: string;
  type?: string;
  state?: string;
  dryRun?: true;
  wouldCancel?: boolean;
  skipped?: true;
  dustWarning?: string;
  error?: string;
  status?: number;
}

async function cancelWorkingOrders(
  account: ConnectedAccount,
  request: Extract<OpsAccountControlRequest, { action: "cancel_working_orders" }>
): Promise<OpsAccountControlOutcome> {
  const userId = account.userId;
  const policy = peekPolicy(userId, account.id);
  const read = await readWorkingOrders(account, policy, userId);
  if (!policy.accountNumber || !read.ok) {
    // Even explicit ids need a working-order read. A failed read cannot prove
    // that the id is working in this account, so never send it to the broker.
    const error = read.ok ? "That connected account has no broker account number." : read.error;
    const outcome = {
      status: policy.accountNumber ? 502 : 409,
      body: { ok: false, error: `Could not read working orders, so nothing was cancelled: ${error}`, account: accountSummary(account) }
    };
    auditOpsCall(account, request, outcome, { error: outcome.body.error });
    return outcome;
  }
  const working = new Map(read.orders.map((order) => [order.id, order]));
  const targets = request.orderIds ?? [...working.keys()];
  const results: CancelResult[] = [];

  for (const orderId of targets) {
    const known = working.get(orderId);
    if (!known) {
      // Never send a cancel for an id that is not working in THIS account's own order book.
      results.push({
        orderId,
        ok: false,
        skipped: true,
        error: "Not a working order in this account (it may have filled, been cancelled, or belong to another account)."
      });
      continue;
    }
    const describe = { symbol: known.symbol, side: known.side, type: known.type, state: known.state };
    if (request.dryRun) {
      results.push({ orderId, ok: true, dryRun: true, wouldCancel: true, ...describe });
      continue;
    }
    try {
      // The console's cancel path, pointed at THIS account.  requireWorkingOrder re-checks
      // membership at cancel time (an order that filled since the read above is refused).
      const result = await cancelWorkingOrder({
        userId,
        orderId,
        connectedAccountId: account.id,
        requireWorkingOrder: true,
        failClosedWhenUnverified: true,
        source: "ops"
      });
      results.push({
        orderId,
        ok: true,
        ...describe,
        symbol: result.symbol ?? known.symbol,
        state: result.state,
        ...(result.dustWarning ? { dustWarning: result.dustWarning } : {})
      });
    } catch (error) {
      results.push({
        orderId,
        ok: false,
        ...describe,
        error: redactFor(account, error),
        ...(error instanceof OrderCancelPreconditionError ? { status: error.status } : {})
      });
    }
  }

  const skipped = results.filter((r) => r.skipped).length;
  const failed = results.filter((r) => !r.ok && !r.skipped).length;
  const summary = {
    requested: targets.length,
    ...(request.dryRun ? { wouldCancel: results.filter((r) => r.wouldCancel).length } : { cancelled: results.filter((r) => r.ok).length }),
    failed,
    skipped
  };
  const outcome = {
    status: 200,
    body: {
      ok: failed === 0 && skipped === 0,
      action: request.action,
      dryRun: request.dryRun,
      account: accountSummary(account),
      summary,
      results
    }
  };
  auditOpsCall(account, request, outcome, { summary, results });
  return outcome;
}

async function setSystemState(
  account: ConnectedAccount,
  request: Extract<OpsAccountControlRequest, { action: "set_system_state" }>
): Promise<OpsAccountControlOutcome> {
  const userId = account.userId;
  const target: SystemState = request.systemState;
  // Read without seeding account_strategy_state. A real change takes its
  // authoritative getPolicy snapshot inside the transaction below: a failed
  // arming check or a later rollback must not leave a seeded policy row behind.
  const policy = peekPolicy(userId, account.id);
  const from = policy.systemState;

  const refuse = (status: number, error: string, extra: Record<string, unknown> = {}): OpsAccountControlOutcome => {
    const outcome = { status, body: { ok: false, error, account: accountSummary(account), systemState: from, ...extra } };
    auditOpsCall(account, request, outcome, { from, to: target, error });
    return outcome;
  };

  if (target === "active" && account.isDraining) {
    return refuse(409, "This account is disconnected and being wound down; it cannot be armed.");
  }

  let brokerHealth: HealthSignals | undefined;
  if (target === "active") {
    // THE console Start checks (account number, universe, broker reachable, account listed,
    // agentic_allowed), against this account's own broker login.
    const check = await verifyAutonomyArmingPreconditions(policy, userId);
    if (!check.ok) return refuse(400, redactFor(account, check.message));
    // Advisory, never a gate here: the same health probe the scheduler runs at the top of each
    // tick, so the response can say whether the next tick will actually launch a run.
    try {
      brokerHealth = await withTimeout(checkBrokerHealth(userId, account, getBrokerGateway(policy, userId)), BROKER_READ_TIMEOUT_MS, "checkBrokerHealth");
    } catch (error) {
      brokerHealth = { isHealthy: false, reason: redactFor(account, error), category: "connectivity" };
    }
    if (brokerHealth.reason) brokerHealth = { ...brokerHealth, reason: redactFor(account, brokerHealth.reason) };
  }

  // Same shapes as the console: Stop (POST /api/strategy/pause) also clears the legacy `enabled`
  // flag; Start and close_only change systemState only.
  const withTargetState = (base: TradingPolicy): TradingPolicy =>
    target === "halted"
      ? ({ ...base, enabled: false, systemState: "halted" } as TradingPolicy)
      : { ...base, systemState: target };
  const next = withTargetState(policy);
  const autoPause = getBrokerPlacementPauseMarker(userId, account.id);
  let clearedBrokerAutoPause = false;

  if (!request.dryRun) {
    // The broker read above awaited.  Re-check and re-read inside one SQLite transaction so that
    // (1) an account deleted meanwhile is refused — setPolicy falls back to USER-level storage for
    // an id that no longer resolves, the same trap PUT /api/policy guards against — and (2) a
    // concurrent console edit to this account's policy is not overwritten by the pre-await
    // snapshot: only systemState (and `enabled` on halt) changes.
    let refusal: string | undefined;
    getDb().transaction(() => {
      const current = getConnectedAccount(account.id, userId);
      if (!current) {
        refusal = "The connected account was removed before this change could be saved.";
        return;
      }
      if (target === "active" && current.isDraining) {
        refusal = "This account is disconnected and being wound down; it cannot be armed.";
        return;
      }
      setPolicy(withTargetState(getPolicy(userId, account.id)), userId, account.id);
    })();
    if (refusal) return refuse(409, refusal);
    if (target === "halted" && autoPause) {
      // The broker-health gate auto-resumes a halt it owns (marker present) once the broker
      // recovers.  An explicit operator halt must stick, so the halt is now the operator's.
      clearBrokerPlacementPauseMarker(userId, account.id);
      clearedBrokerAutoPause = true;
    }
    // Nudge any open console to refresh: this change did not come from that console.
    emitDashboardEvent({
      type: "dirty",
      userId,
      at: new Date().toISOString(),
      detail: { source: "ops", action: request.action, connectedAccountId: account.id }
    });
  }

  const effective = request.dryRun ? next : getPolicy(userId, account.id);
  const nextEligibleRun = describeNextEligibleRun({ userId, account, policy: effective, brokerHealth });
  const outcome = {
    status: 200,
    body: {
      ok: true,
      action: request.action,
      dryRun: request.dryRun,
      account: accountSummary(account),
      previousSystemState: from,
      systemState: effective.systemState,
      ...(request.dryRun ? { wouldChange: from !== target } : {}),
      ...(brokerHealth ? { brokerHealthNow: { isHealthy: brokerHealth.isHealthy, reason: brokerHealth.reason ?? null, category: brokerHealth.category ?? null } } : {}),
      brokerAutoPause: autoPause ? { reason: redactFor(account, autoPause.reason), since: autoPause.since } : null,
      clearedBrokerAutoPause,
      nextEligibleRun
    }
  };
  auditOpsCall(account, request, outcome, {
    from,
    to: target,
    clearedBrokerAutoPause,
    brokerHealthy: brokerHealth?.isHealthy,
    nextEligibleRun: { willRun: nextEligibleRun.willRun, at: nextEligibleRun.at, reason: nextEligibleRun.reason }
  });
  return outcome;
}

export async function runOpsAccountControl(request: OpsAccountControlRequest): Promise<OpsAccountControlOutcome> {
  const account = findConnectedAccountById(request.connectedAccountId);
  if (!account) return { status: 404, body: { ok: false, error: "Connected account not found." } };
  // findConnectedAccountById decrypts credentials; drop them before anything else touches the row.
  const safeAccount: ConnectedAccount = { ...account, apiKey: undefined, apiSecret: undefined };
  switch (request.action) {
    case "list_working_orders":
      return listWorkingOrders(safeAccount, request);
    case "cancel_working_orders":
      return cancelWorkingOrders(safeAccount, request);
    case "set_system_state":
      return setSystemState(safeAccount, request);
  }
}
