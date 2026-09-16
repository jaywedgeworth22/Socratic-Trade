import crypto from "crypto";
import { createAlert, removeAlert } from "./alerts";
import { getBrokerGateway } from "./broker";
import {
  audit,
  getDataPoolConsent,
  getDb,
  getLegalNoticeConsent,
  getPolicy,
  getProposal,
  listConnectedAccounts,
  needsAppConsent,
  setActiveConnectedAccount,
  setDataPoolConsent,
  setLegalNoticeConsent,
  setPolicy
} from "./db";
import { isIndexUniverse, isValidAppSymbol } from "./index-universes";
import { normalizeSymbol } from "./money";
import { notify } from "./notify";
import { DEFAULT_TAX_SETTINGS } from "./defaults";
import { cancelWorkingOrder } from "./order-cancel";
import { normalizeExclusivePolicyCaps } from "./policy-normalization";
import {
  rejectProposal,
  runStrategyOnce
} from "./strategy";
import { addToWatchlist, removeFromWatchlist } from "./watchlist";
import type {
  HoldingHorizon,
  IndexUniverse,
  NotificationEvent,
  NotificationEventType,
  RiskRules,
  StrategyAuthority,
  SystemState,
  TaxSettings,
  TradingPolicy
} from "./types";
import { retryProposalRedTeam } from "./retry-red-team";
import {
  mobileCommandStatusForPlacement,
  placementCommandErrorMessage,
  resolvePlacementOutcome,
  type ExecuteProposalResult
} from "./placement-outcome";
import { executeProposal, LiveApprovalConfirmationError, LiveApprovalConfirmation } from "./strategy-execution";

export const MOBILE_COMMAND_TYPES = [
  "strategy.run_once",
  "strategy.start",
  "strategy.stop",
  "strategy.close_only",
  "strategy.liquidating",
  "proposal.approve",
  "proposal.reject",
  "proposal.retry_red_team",
  "account.activate",
  "order.cancel",
  "watchlist.add",
  "watchlist.remove",
  "alert.create",
  "alert.delete",
  "policy.patch",
  "consent.set",
  "notification.test"
] as const;

export type MobileCommandType = (typeof MOBILE_COMMAND_TYPES)[number];
export type MobileCommandStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

const IMMEDIATE_PROTECTIVE_COMMAND_TYPES = new Set<MobileCommandType>([
  "strategy.stop",
  "strategy.close_only",
  "strategy.liquidating"
]);

/**
 * Commands that must not wait on the global sequential mobile worker.
 * Protective state changes (stop/close_only/liquidating) already used this path so a long
 * strategy.run_once cannot block a halt. account.activate is the same class of problem: it is a
 * pure active-pointer flip with no broker I/O, but was queued behind run_once — so the iOS/PWA
 * "Use" / account selector spinner hung for the entire in-flight strategy run (owner report:
 * Roth IRA spinner while Sandbox stayed Active, backlog 2 queued · 1 running).
 *
 * order.cancel is here for the timing reason and NOT in IMMEDIATE_PROTECTIVE_COMMAND_TYPES. The
 * whole point of cancelling a rotting limit order from a phone is that it happens now, not after
 * a 30-minute strategy.run_once drains — so it bypasses the worker. But protective membership
 * additionally means "on success, cancel this user's queued run_once / start / approve"
 * (cancelQueuedRiskIncreasingCommands), which is the right blast radius for a system-wide
 * containment state and the wrong one for killing ONE order: an operator cancelling a stale AAPL
 * limit did not ask to also drop a queued approval on an unrelated symbol. Same seat as
 * account.activate — immediate, not preemptive.
 */
const IMMEDIATE_MOBILE_COMMAND_TYPES = new Set<MobileCommandType>([
  ...IMMEDIATE_PROTECTIVE_COMMAND_TYPES,
  "account.activate",
  "order.cancel"
]);

const RISK_INCREASING_QUEUED_COMMAND_TYPES = [
  "strategy.run_once",
  "strategy.start",
  "proposal.approve"
] as const satisfies readonly MobileCommandType[];

export function isImmediateProtectiveMobileCommandType(
  commandType: MobileCommandType
): boolean {
  return IMMEDIATE_PROTECTIVE_COMMAND_TYPES.has(commandType);
}

export function isImmediateMobileCommandType(commandType: MobileCommandType): boolean {
  return IMMEDIATE_MOBILE_COMMAND_TYPES.has(commandType);
}

export interface MobileClientInfo {
  platform?: "ios" | "web" | "unknown";
  appVersion?: string;
  buildNumber?: string;
  deviceIdHash?: string;
}

interface MobileCommandRecord {
  id: string;
  userId: string;
  idempotencyKey?: string;
  commandType: MobileCommandType;
  status: MobileCommandStatus;
  payload: Record<string, unknown>;
  result?: unknown;
  error?: string;
  client?: MobileClientInfo;
  createdAt: string;
  queuedAt: string;
  startedAt?: string;
  finishedAt?: string;
  updatedAt: string;
}

export interface PublicMobileCommand {
  id: string;
  commandType: MobileCommandType;
  status: MobileCommandStatus;
  payload: Record<string, unknown>;
  result?: unknown;
  error?: string;
  client?: MobileClientInfo;
  createdAt: string;
  queuedAt: string;
  startedAt?: string;
  finishedAt?: string;
  updatedAt: string;
}

export interface MobileCommandEvent {
  type: "mobile.command";
  userId: string;
  at: string;
  command: PublicMobileCommand;
}

type MobileListener = (event: MobileCommandEvent) => void;

const globalForMobileEvents = globalThis as unknown as {
  __mobileCommandListeners?: Set<MobileListener>;
  __mobileCommandWorkerInFlight?: boolean;
};
const mobileListeners =
  globalForMobileEvents.__mobileCommandListeners ??
  (globalForMobileEvents.__mobileCommandListeners = new Set<MobileListener>());

export class MobileCommandValidationError extends Error {
  status = 400;
}

/**
 * A `policy.patch` refused at execution time because an `expectedCurrent` precondition no longer
 * matched what is stored. Same shape and same 409 as `OrderCancelPreconditionError`
 * (src/lib/order-cancel.ts), which refuses a cancel whose `expectedAccountNumber` has moved.
 */
export class PolicyPatchPreconditionError extends Error {
  status = 409;
  field: string;
  expected: PolicyPreconditionValue;
  actual: PolicyPreconditionValue;

  constructor(message: string, detail: { field: string; expected: PolicyPreconditionValue; actual: PolicyPreconditionValue }) {
    super(message);
    this.name = "PolicyPatchPreconditionError";
    this.field = detail.field;
    this.expected = detail.expected;
    this.actual = detail.actual;
  }
}

export function isMobileCommandType(value: unknown): value is MobileCommandType {
  return typeof value === "string" && (MOBILE_COMMAND_TYPES as readonly string[]).includes(value);
}

export function subscribeMobileCommandEvents(listener: MobileListener): () => void {
  mobileListeners.add(listener);
  return () => {
    mobileListeners.delete(listener);
  };
}

function emitMobileCommandEvent(command: MobileCommandRecord): void {
  const event: MobileCommandEvent = {
    type: "mobile.command",
    userId: command.userId,
    at: new Date().toISOString(),
    command: toPublicMobileCommand(command)
  };
  for (const listener of mobileListeners) {
    try {
      listener(event);
    } catch {
      // A broken subscriber cannot break command execution.
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asOptionalString(value: unknown, max = 256): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, max);
}

function normalizeClientInfo(value: unknown): MobileClientInfo | undefined {
  const input = asRecord(value);
  const platformRaw = asOptionalString(input.platform, 32);
  const platform: MobileClientInfo["platform"] =
    platformRaw === "ios" || platformRaw === "web" ? platformRaw : platformRaw ? "unknown" : undefined;
  const appVersion = asOptionalString(input.appVersion, 64);
  const buildNumber = asOptionalString(input.buildNumber, 64);
  const deviceId = asOptionalString(input.deviceId, 256);
  const deviceIdHash = deviceId
    ? crypto.createHash("sha256").update(deviceId).digest("hex").slice(0, 24)
    : asOptionalString(input.deviceIdHash, 64);
  const client = { platform, appVersion, buildNumber, deviceIdHash };
  return Object.values(client).some(Boolean) ? client : undefined;
}

function parseJson(raw: string | null | undefined, fallback: unknown): unknown {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function normalizeIdempotencyKey(value: unknown): string | undefined {
  const key = asOptionalString(value, 128);
  return key && /^[A-Za-z0-9._:-]+$/.test(key) ? key : undefined;
}

function commandFromRow(row: Record<string, unknown>): MobileCommandRecord {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    idempotencyKey: row.idempotency_key == null ? undefined : String(row.idempotency_key),
    commandType: String(row.command_type) as MobileCommandType,
    status: String(row.status) as MobileCommandStatus,
    payload: asRecord(parseJson(String(row.payload ?? "{}"), {})),
    result: parseJson(row.result == null ? undefined : String(row.result), undefined),
    error: row.error == null ? undefined : String(row.error),
    client: normalizeClientInfo(parseJson(row.client == null ? undefined : String(row.client), undefined)),
    createdAt: String(row.created_at),
    queuedAt: String(row.queued_at),
    startedAt: row.started_at == null ? undefined : String(row.started_at),
    finishedAt: row.finished_at == null ? undefined : String(row.finished_at),
    updatedAt: String(row.updated_at)
  };
}

function redactPayloadForResponse(commandType: MobileCommandType, payload: Record<string, unknown>): Record<string, unknown> {
  if (commandType === "proposal.approve") {
    return {
      proposalId: payload.proposalId,
      hasLiveConfirmation: typeof payload.liveConfirmation === "object" && payload.liveConfirmation !== null
    };
  }
  return payload;
}

export function toPublicMobileCommand(command: MobileCommandRecord): PublicMobileCommand {
  return {
    id: command.id,
    commandType: command.commandType,
    status: command.status,
    payload: redactPayloadForResponse(command.commandType, command.payload),
    result: command.result,
    error: command.error,
    client: command.client,
    createdAt: command.createdAt,
    queuedAt: command.queuedAt,
    startedAt: command.startedAt,
    finishedAt: command.finishedAt,
    updatedAt: command.updatedAt
  };
}

function requireString(payload: Record<string, unknown>, key: string, max = 256): string {
  const value = asOptionalString(payload[key], max);
  if (!value) throw new MobileCommandValidationError(`${key} is required.`);
  return value;
}

function finiteNumber(value: unknown, key: string, opts: { min?: number; max?: number } = {}): number {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new MobileCommandValidationError(`${key} must be a number.`);
  if (opts.min !== undefined && n < opts.min) throw new MobileCommandValidationError(`${key} must be at least ${opts.min}.`);
  if (opts.max !== undefined && n > opts.max) throw new MobileCommandValidationError(`${key} must be at most ${opts.max}.`);
  return n;
}

function optionalFiniteNumber(value: unknown, key: string, opts: { min?: number; max?: number } = {}): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return finiteNumber(value, key, opts);
}

function normalizeSymbols(value: unknown, key: string): string[] {
  if (!Array.isArray(value)) throw new MobileCommandValidationError(`${key} must be an array.`);
  return Array.from(new Set(value.map(String).map(normalizeSymbol).filter(Boolean))).filter(isValidAppSymbol);
}

function normalizeNotificationEvents(value: unknown): NotificationEventType[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const allowed: NotificationEventType[] = ["fill", "block", "run_failed", "pending_approval", "kill_switch", "price_alert", "proposal_withdrawn"];
  return value.map(String).filter((item): item is NotificationEventType => allowed.includes(item as NotificationEventType));
}

/** Numeric guardrails `policy.patch` may set, with the server-side bounds each one accepts. */
const POLICY_PATCH_NUMERIC_FIELDS: Array<[keyof TradingPolicy, number | undefined, number | undefined]> = [
  ["maxOrderNotional", 1, 100_000],
  ["maxOrderPctOfNav", 0.01, 100],
  ["maxDailyNotional", 1, undefined],
  ["maxHourlyNotional", 1, undefined],
  ["maxDailyPctOfNav", 0.01, 100],
  ["maxSymbolExposurePct", 0.01, 100],
  ["maxSymbolExposureNotional", 1, undefined],
  ["maxGrossExposurePct", 0, 100],
  ["maxNetExposurePct", 0, 100],
  ["maxDailyOrders", 1, 500],
  ["maxProposalsPerRun", 1, 25],
  ["proposalExpiryMinutes", 0, undefined],
  ["proposalRevalidateCadenceHours", 0, undefined],
  ["runCadenceMinutes", 1, 24 * 60],
  ["maxShortOrderNotional", 1, 100_000],
  ["maxShortExposurePct", 0, 100],
  ["maxPortfolioBeta", 0.01, 10],
  ["maxEntryDriftPct", 0, 100],
  ["maxOrderPctOfAdv", 0, 100],
  ["volPanicVixThreshold", 0, undefined],
  ["volPanicVvixThreshold", 0, undefined],
  ["volPanicSkewThreshold", 0, undefined]
];

/** Boolean switches `policy.patch` may set. */
const POLICY_PATCH_BOOLEAN_FIELDS = [
  "permitExtendedHours",
  "runDuringExtendedHours",
  "allowExtendedHoursSyntheticStops",
  "shortSellingEnabled",
  "brokerStopsForShorts",
  "optionsTradingEnabled",
  "eventContractsEnabled",
  "kalshiMacroEnabled",
  "brokerBracketsEnabled",
  "betaScaledStops",
  "marketableLimitEntries",
  "volPanicBrakeEnabled"
] as const;

type PolicyPreconditionKind = "number" | "boolean" | "text";
type PolicyPreconditionValue = string | number | boolean | null;

/**
 * The fields an `expectedCurrent` precondition may name, and how each one compares.
 *
 * Deliberately SCALAR-ONLY. A precondition is a promise the server keeps exactly, and "equal"
 * is only unambiguous for a value a client can read off a snapshot and send back verbatim.
 * Collections (`includedIndices`, `additionalSymbols`, `blocklist`) and nested objects
 * (`riskRules`, `taxSettings`, `notificationSettings`) are excluded rather than compared with a
 * hand-rolled deep-equal whose disagreements would be silent.
 */
const POLICY_PRECONDITION_FIELDS: Record<string, PolicyPreconditionKind> = {
  strategyAuthority: "text",
  holdingHorizon: "text",
  ...Object.fromEntries(POLICY_PATCH_NUMERIC_FIELDS.map(([field]) => [field, "number" as const])),
  ...Object.fromEntries(POLICY_PATCH_BOOLEAN_FIELDS.map((field) => [field, "boolean" as const]))
};

/**
 * Optional stale-view guard for `policy.patch`, the exact counterpart of `order.cancel`'s
 * `expectedAccountNumber` (src/lib/order-cancel.ts): the values the CALLER believed were current
 * for the fields it is patching. When supplied they must equal what is stored at EXECUTION time,
 * otherwise the patch is refused outright rather than silently applied against a policy that
 * moved underneath it.
 *
 * This is what makes the phone's "these controls only tighten" footer true END TO END.
 * `policy.patch` is a QUEUED command (it is not in IMMEDIATE_MOBILE_COMMAND_TYPES), so minutes
 * can pass behind a draining `strategy.run_once` between the tap and the write — and
 * `applyPolicyPatch` merges verbatim in either direction. A tightening tapped against a $10,000
 * cap that the console has since lowered to $2,000 would land as a LOOSENING. The phone's
 * tap-time re-check closes every window the phone can see; this closes the one it cannot.
 *
 * OPTIONAL by construction: a patch that carries no `expectedCurrent` behaves exactly as it
 * always has. The web console and every existing caller are unaffected.
 */
function normalizePolicyPreconditions(raw: unknown): Record<string, PolicyPreconditionValue> | undefined {
  if (raw === undefined || raw === null) return undefined;
  // A malformed precondition is refused, never coerced away: `asRecord` would quietly turn a
  // string or array into `{}`, and dropping an assertion the caller believes is being enforced
  // is the one failure mode this guard exists to prevent.
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new MobileCommandValidationError("expectedCurrent must be an object of policy fields.");
  }
  const expected: Record<string, PolicyPreconditionValue> = {};
  for (const [field, value] of Object.entries(raw as Record<string, unknown>)) {
    const kind = POLICY_PRECONDITION_FIELDS[field];
    if (!kind) {
      throw new MobileCommandValidationError(`expectedCurrent.${field} is not a field policy.patch can guard.`);
    }
    // Explicit null means "I believed this was unset" — a real, checkable expectation.
    if (value === null || value === undefined) {
      expected[field] = null;
      continue;
    }
    switch (kind) {
      case "number":
        expected[field] = finiteNumber(value, `expectedCurrent.${field}`);
        break;
      case "boolean":
        if (typeof value !== "boolean") {
          throw new MobileCommandValidationError(`expectedCurrent.${field} must be boolean.`);
        }
        expected[field] = value;
        break;
      case "text": {
        const text = asOptionalString(value, 64);
        if (!text) throw new MobileCommandValidationError(`expectedCurrent.${field} must be a string.`);
        expected[field] = text;
        break;
      }
    }
  }
  // An empty object asserts nothing; keep the payload in its legacy shape rather than storing a
  // guard that would always pass.
  return Object.keys(expected).length > 0 ? expected : undefined;
}

function normalizePolicyPatch(raw: unknown): Partial<TradingPolicy> {
  const input = asRecord(raw);
  for (const forbidden of ["userId", "accountNumber", "connectedAccountId", "activeBroker", "apiKey", "apiSecret", "providerSecret"]) {
    if (forbidden in input) {
      throw new MobileCommandValidationError(`${forbidden} cannot be changed through policy.patch.`);
    }
  }

  const patch: Partial<TradingPolicy> = {};
  if (input.strategyAuthority !== undefined) {
    if (input.strategyAuthority !== "propose" && input.strategyAuthority !== "decide") {
      throw new MobileCommandValidationError("strategyAuthority must be propose or decide.");
    }
    patch.strategyAuthority = input.strategyAuthority as StrategyAuthority;
  }
  if (input.holdingHorizon !== undefined) {
    if (!["intraday", "swing", "position", "longterm"].includes(String(input.holdingHorizon))) {
      throw new MobileCommandValidationError("holdingHorizon is invalid.");
    }
    patch.holdingHorizon = input.holdingHorizon as HoldingHorizon;
  }
  if (input.includedIndices !== undefined) {
    if (!Array.isArray(input.includedIndices)) throw new MobileCommandValidationError("includedIndices must be an array.");
    patch.includedIndices = Array.from(new Set(input.includedIndices.map(String).filter(isIndexUniverse))) as IndexUniverse[];
  }
  if (input.additionalSymbols !== undefined) patch.additionalSymbols = normalizeSymbols(input.additionalSymbols, "additionalSymbols");
  if (input.blocklist !== undefined) patch.blocklist = normalizeSymbols(input.blocklist, "blocklist");

  for (const [field, min, max] of POLICY_PATCH_NUMERIC_FIELDS) {
    if (input[field] !== undefined) {
      (patch as Record<string, unknown>)[field] = finiteNumber(input[field], String(field), { min, max });
    }
  }

  for (const field of POLICY_PATCH_BOOLEAN_FIELDS) {
    if (input[field] !== undefined) {
      if (typeof input[field] !== "boolean") throw new MobileCommandValidationError(`${field} must be boolean.`);
      patch[field] = input[field] as never;
    }
  }

  if (input.riskRules !== undefined) {
    const risk = asRecord(input.riskRules);
    const next: Partial<RiskRules> = {};
    for (const [key, value] of Object.entries(risk)) {
      if (!["stopLossPct", "stopLossNotional", "takeProfitPct", "takeProfitNotional", "trailingStopPct", "shortStopLossPct", "maxDrawdownPct", "maxDailyLossNotional"].includes(key)) continue;
      (next as Record<string, number>)[key] = finiteNumber(value, `riskRules.${key}`, { min: 0 });
    }
    patch.riskRules = next;
  }

  if (input.notificationSettings !== undefined) {
    const settings = asRecord(input.notificationSettings);
    const next: Partial<TradingPolicy["notificationSettings"]> = {};
    if (settings.webhookUrl !== undefined) {
      const webhookUrl = asOptionalString(settings.webhookUrl, 2048) ?? "";
      if (webhookUrl) new URL(webhookUrl);
      next.webhookUrl = webhookUrl;
    }
    const enabledEvents = normalizeNotificationEvents(settings.enabledEvents);
    if (enabledEvents) next.enabledEvents = enabledEvents;
    patch.notificationSettings = next as TradingPolicy["notificationSettings"];
  }

  if (input.taxSettings !== undefined) {
    const tax = asRecord(input.taxSettings);
    const next: Partial<TaxSettings> = {};
    if (tax.taxationType !== undefined) {
      if (!["taxable", "roth_ira", "traditional_ira"].includes(String(tax.taxationType))) {
        throw new MobileCommandValidationError("taxSettings.taxationType is invalid.");
      }
      next.taxationType = tax.taxationType as TaxSettings["taxationType"];
    }
    if (tax.washSaleGuard !== undefined) {
      if (typeof tax.washSaleGuard !== "boolean") throw new MobileCommandValidationError("taxSettings.washSaleGuard must be boolean.");
      next.washSaleGuard = tax.washSaleGuard;
    }
    const shortTermRatePct = optionalFiniteNumber(tax.shortTermRatePct, "taxSettings.shortTermRatePct", { min: 0, max: 100 });
    const longTermRatePct = optionalFiniteNumber(tax.longTermRatePct, "taxSettings.longTermRatePct", { min: 0, max: 100 });
    if (shortTermRatePct !== undefined) next.shortTermRatePct = shortTermRatePct;
    if (longTermRatePct !== undefined) next.longTermRatePct = longTermRatePct;
    if (tax.subtractFromResults !== undefined) {
      if (typeof tax.subtractFromResults !== "boolean") throw new MobileCommandValidationError("taxSettings.subtractFromResults must be boolean.");
      next.subtractFromResults = tax.subtractFromResults;
    }
    patch.taxSettings = next as TaxSettings;
  }

  if (Object.keys(patch).length === 0) throw new MobileCommandValidationError("policy.patch has no allowed fields.");
  return patch;
}

function normalizeCommandPayload(commandType: MobileCommandType, rawPayload: unknown): Record<string, unknown> {
  const payload = asRecord(rawPayload);
  switch (commandType) {
    case "strategy.run_once":
    case "strategy.start":
    case "strategy.stop":
    case "strategy.close_only":
    case "strategy.liquidating":
    case "notification.test":
      return {};
    case "proposal.approve": {
      const proposalId = requireString(payload, "proposalId");
      const liveConfirmation = asRecord(payload.liveConfirmation);
      return Object.keys(liveConfirmation).length > 0 ? { proposalId, liveConfirmation } : { proposalId };
    }
    case "proposal.reject":
    case "proposal.retry_red_team":
      return { proposalId: requireString(payload, "proposalId") };
    case "account.activate":
      return { accountId: requireString(payload, "accountId") };
    case "order.cancel": {
      const orderId = requireString(payload, "orderId", 128);
      // Optional, and verified server-side when present: the account the phone BELIEVED it was
      // looking at. A client that sends it gets a refusal instead of a cancel landing on whatever
      // account happens to be selected by the time the command runs.
      const accountNumber = asOptionalString(payload.accountNumber, 64);
      return accountNumber ? { orderId, accountNumber } : { orderId };
    }
    case "watchlist.add":
    case "watchlist.remove": {
      const symbol = normalizeSymbol(requireString(payload, "symbol"));
      if (!isValidAppSymbol(symbol)) throw new MobileCommandValidationError(`${symbol} is not supported by the equity universe.`);
      return { symbol };
    }
    case "alert.create": {
      const symbol = normalizeSymbol(requireString(payload, "symbol"));
      const op = requireString(payload, "op");
      const price = finiteNumber(payload.price, "price", { min: 0.01 });
      const note = asOptionalString(payload.note, 500);
      return { symbol, op, price, ...(note ? { note } : {}) };
    }
    case "alert.delete":
      return { alertId: requireString(payload, "alertId") };
    case "policy.patch": {
      const patch = normalizePolicyPatch(payload.patch ?? payload);
      // Optional, and verified server-side when present: the values the phone BELIEVED were
      // current for the fields it is changing. A client that sends them gets a refusal instead
      // of a patch landing on a policy that moved while the command sat in the queue.
      const expectedCurrent = normalizePolicyPreconditions(payload.expectedCurrent);
      return expectedCurrent ? { patch, expectedCurrent } : { patch };
    }
    case "consent.set":
      if (payload.accepted !== true) {
        throw new MobileCommandValidationError("Accepting the current terms and shared data pool is required.");
      }
      return { accepted: true };
    default: {
      const _exhaustive: never = commandType;
      throw new MobileCommandValidationError(`Unsupported command: ${String(_exhaustive)}`);
    }
  }
}

export function queueMobileCommand(input: {
  userId: string;
  commandType: MobileCommandType;
  payload?: unknown;
  idempotencyKey?: unknown;
  client?: unknown;
  now?: Date;
}): { command: PublicMobileCommand; deduped: boolean } {
  const payload = normalizeCommandPayload(input.commandType, input.payload);
  const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
  const client = normalizeClientInfo(input.client);
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const database = getDb();
  const create = database.transaction(() => {
    if (idempotencyKey) {
      const existing = database
        .prepare("SELECT * FROM mobile_commands WHERE user_id = ? AND idempotency_key = ?")
        .get(input.userId, idempotencyKey) as Record<string, unknown> | undefined;
      if (existing) return { record: commandFromRow(existing), deduped: true };
    }

    const id = crypto.randomUUID();
    database
      .prepare(
        `INSERT INTO mobile_commands
          (id, user_id, idempotency_key, command_type, status, payload, result, error, client, created_at, queued_at, updated_at)
         VALUES (?, ?, ?, ?, 'queued', ?, NULL, NULL, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.userId,
        idempotencyKey ?? null,
        input.commandType,
        JSON.stringify(payload),
        client ? JSON.stringify(client) : null,
        nowIso,
        nowIso,
        nowIso
      );
    const row = database.prepare("SELECT * FROM mobile_commands WHERE id = ?").get(id) as Record<string, unknown>;
    return { record: commandFromRow(row), deduped: false };
  });

  const { record, deduped } = create() as { record: MobileCommandRecord; deduped: boolean };
  if (!deduped) {
    audit(
      "mobile_command_queued",
      {
        commandId: record.id,
        commandType: record.commandType,
        hasIdempotencyKey: Boolean(record.idempotencyKey),
        payload: redactPayloadForResponse(record.commandType, record.payload),
        client: record.client
      },
      input.userId
    );
    emitMobileCommandEvent(record);
  }
  return { command: toPublicMobileCommand(record), deduped };
}

export function getMobileCommand(id: string, userId: string): PublicMobileCommand | undefined {
  const row = getDb()
    .prepare("SELECT * FROM mobile_commands WHERE id = ? AND user_id = ?")
    .get(id, userId) as Record<string, unknown> | undefined;
  return row ? toPublicMobileCommand(commandFromRow(row)) : undefined;
}

function getMobileCommandRecord(id: string, userId?: string): MobileCommandRecord | undefined {
  const row = userId
    ? (getDb().prepare("SELECT * FROM mobile_commands WHERE id = ? AND user_id = ?").get(id, userId) as Record<string, unknown> | undefined)
    : (getDb().prepare("SELECT * FROM mobile_commands WHERE id = ?").get(id) as Record<string, unknown> | undefined);
  return row ? commandFromRow(row) : undefined;
}

export function listMobileCommands(input: {
  userId: string;
  status?: MobileCommandStatus;
  limit?: number;
}): PublicMobileCommand[] {
  const limit = Math.min(Math.max(Math.floor(input.limit ?? 50), 1), 200);
  const rows = input.status
    ? (getDb()
        .prepare("SELECT * FROM mobile_commands WHERE user_id = ? AND status = ? ORDER BY created_at DESC LIMIT ?")
        .all(input.userId, input.status, limit) as Record<string, unknown>[])
    : (getDb()
        .prepare("SELECT * FROM mobile_commands WHERE user_id = ? ORDER BY created_at DESC LIMIT ?")
        .all(input.userId, limit) as Record<string, unknown>[]);
  return rows.map(commandFromRow).map(toPublicMobileCommand);
}

function claimNextQueuedCommand(): MobileCommandRecord | undefined {
  const database = getDb();
  const nowIso = new Date().toISOString();
  const claim = database.transaction(() => {
    const row = database
      .prepare("SELECT * FROM mobile_commands WHERE status = 'queued' ORDER BY queued_at ASC LIMIT 1")
      .get() as Record<string, unknown> | undefined;
    if (!row) return undefined;
    const id = String(row.id);
    const info = database
      .prepare("UPDATE mobile_commands SET status = 'running', started_at = ?, updated_at = ? WHERE id = ? AND status = 'queued'")
      .run(nowIso, nowIso, id);
    if (info.changes !== 1) return undefined;
    return commandFromRow(database.prepare("SELECT * FROM mobile_commands WHERE id = ?").get(id) as Record<string, unknown>);
  });
  return claim() as MobileCommandRecord | undefined;
}

function finishCommand(command: MobileCommandRecord, status: "succeeded" | "failed", result: unknown, error?: string): MobileCommandRecord {
  const nowIso = new Date().toISOString();
  const database = getDb();
  const args = [status, result === undefined ? null : JSON.stringify(result), error ?? null, nowIso, nowIso, command.id, command.userId] as const;
  // The `AND status = 'running'` guard exists to DETECT (not to lose) the race with
  // markStaleRunningMobileCommands: a command that outlived the stale threshold while still
  // genuinely executing gets stamped 'failed'/"outcome unknown" by the sweep, and then this worker
  // reports in with the real outcome. Without the guard the overwrite is silent, and the audit
  // trail shows an unexplained mobile_command_crashed -> mobile_command_succeeded pair for the
  // same commandId.
  const info = database
    .prepare(
      "UPDATE mobile_commands SET status = ?, result = ?, error = ?, finished_at = ?, updated_at = ? WHERE id = ? AND user_id = ? AND status = 'running'"
    )
    .run(...args);
  if (info.changes === 0) {
    const superseded = getMobileCommandRecord(command.id, command.userId);
    // The row can also be gone entirely (account deletion swept mobile_commands mid-flight). There
    // is nothing left to correct or emit; hand the caller the in-memory outcome so the normal
    // return contract holds.
    if (!superseded) return { ...command, status, result, error, finishedAt: nowIso, updatedAt: nowIso };
    // The worker's outcome supersedes the sweep's guess: the sweep only ever knew "this looked
    // dead", whereas the worker knows whether the broker call actually happened. Leaving the
    // operator with "outcome unknown" for a command we can fully account for would be the less
    // honest record. Receipt the correction first so the crashed->terminal sequence is explained.
    audit(
      "mobile_command_late_completion",
      {
        commandId: command.id,
        commandType: command.commandType,
        supersededStatus: superseded.status,
        supersededError: superseded.error,
        status,
        error
      },
      command.userId
    );
    database
      .prepare(
        "UPDATE mobile_commands SET status = ?, result = ?, error = ?, finished_at = ?, updated_at = ? WHERE id = ? AND user_id = ?"
      )
      .run(...args);
  }
  const updated = getMobileCommandRecord(command.id, command.userId)!;
  audit(
    status === "succeeded" ? "mobile_command_succeeded" : "mobile_command_failed",
    {
      commandId: command.id,
      commandType: command.commandType,
      error,
      result: status === "succeeded" ? summarizeResult(result) : undefined
    },
    command.userId
  );
  emitMobileCommandEvent(updated);
  return updated;
}

function cancelQueuedRiskIncreasingCommands(
  userId: string,
  exceptCommandId: string,
  protectiveCommandType: MobileCommandType
): PublicMobileCommand[] {
  const database = getDb();
  const nowIso = new Date().toISOString();
  const placeholders = RISK_INCREASING_QUEUED_COMMAND_TYPES.map(() => "?").join(",");
  const cancelled = database.transaction(() => {
    const rows = database.prepare(`
      SELECT id
        , command_type
        , payload
      FROM mobile_commands
      WHERE user_id = ?
        AND id <> ?
        AND status = 'queued'
        AND command_type IN (${placeholders})
      ORDER BY queued_at ASC
    `).all(userId, exceptCommandId, ...RISK_INCREASING_QUEUED_COMMAND_TYPES) as Array<{
      id: string;
      command_type: MobileCommandType;
      payload: string;
    }>;
    const update = database.prepare(`
      UPDATE mobile_commands
      SET status = 'cancelled', error = ?, finished_at = ?, updated_at = ?
      WHERE id = ? AND user_id = ? AND status = 'queued'
    `);
    const records: MobileCommandRecord[] = [];
    for (const row of rows) {
      // A queued approval may be an exit: preserve sell/cover approvals only while Close-only
      // or Liquidating is being applied, so those containment modes can still reduce risk. A
      // full Stop must cancel every queued approval, including exits, because it promises no
      // additional broker submission. An approval whose proposal has disappeared is stale work.
      if (protectiveCommandType !== "strategy.stop" && row.command_type === "proposal.approve") {
        let proposalId: string | undefined;
        try {
          const payload = JSON.parse(row.payload) as Record<string, unknown>;
          proposalId = typeof payload.proposalId === "string" ? payload.proposalId : undefined;
        } catch {
          // Malformed queued payloads cannot execute a valid approval, so they remain cancellable.
        }
        const proposal = proposalId ? getProposal(proposalId, userId) : undefined;
        if (proposal && (proposal.proposal.side === "sell" || proposal.proposal.side === "cover")) {
          continue;
        }
      }
      const reason = `Cancelled because ${protectiveCommandType} took immediate effect.`;
      const result = update.run(reason, nowIso, nowIso, row.id, userId);
      if (result.changes !== 1) continue;
      const updated = getMobileCommandRecord(row.id, userId);
      if (updated) records.push(updated);
    }
    return records;
  })() as MobileCommandRecord[];

  for (const command of cancelled) {
    audit(
      "mobile_command_cancelled_by_protective_state",
      {
        commandId: command.id,
        commandType: command.commandType,
        protectiveCommandType,
        error: command.error
      },
      userId
    );
    emitMobileCommandEvent(command);
  }
  return cancelled.map(toPublicMobileCommand);
}

function summarizeResult(result: unknown): unknown {
  if (!result || typeof result !== "object") return result;
  const obj = result as Record<string, unknown>;
  return {
    ok: obj.ok,
    status: obj.status,
    outcome: obj.outcome,
    reasons: obj.reasons,
    runId: obj.runId,
    proposalId: obj.proposalId,
    orderId: obj.orderId,
    removed: obj.removed,
    symbol: obj.symbol
  };
}

async function setStrategyState(userId: string, state: SystemState): Promise<{ ok: true; systemState: SystemState }> {
  const policy = getPolicy(userId);
  // Active is the only state that can authorize new strategy work. The three containment states
  // must remain available even when a user has an incomplete universe: they are the path to stop
  // future submissions or allow only exits for an already-held account.
  if (state === "active") {
    if (!policy.accountNumber) throw new Error("Select an account before changing strategy state.");
    if (policy.includedIndices.length === 0 && policy.additionalSymbols.length === 0) {
      throw new Error("Select at least one base index or additional watchlist symbol before changing strategy state.");
    }
  }
  if (state === "active") {
    const account = (await getBrokerGateway(policy, userId).getAccounts()).find((item) => item.accountNumber === policy.accountNumber);
    if (!account) throw new Error("Selected account is not available.");
    if (!account.agenticAllowed) throw new Error("Selected account is not agentic_allowed.");
  }
  const next = { ...policy, systemState: state } as TradingPolicy & { enabled?: boolean };
  if (state === "halted") next.enabled = false;
  setPolicy(next, userId);
  audit("mobile_strategy_state", { from: policy.systemState, to: state }, userId);
  return { ok: true, systemState: state };
}

/** Stored value as a precondition compares it: absent and null are the same "not set". */
function policyPreconditionActual(value: unknown): PolicyPreconditionValue {
  if (value === undefined || value === null) return null;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "string") return value;
  // Not a scalar, so it cannot equal any accepted expectation. Reported as-is in the receipt.
  return String(value);
}

function describePreconditionValue(value: PolicyPreconditionValue): string {
  return value === null ? "not set" : String(value);
}

function applyPolicyPatch(
  userId: string,
  patch: Partial<TradingPolicy>,
  expectedCurrent?: Record<string, PolicyPreconditionValue>
): { ok: true; policy: TradingPolicy } {
  const current = getPolicy(userId);
  // Fail closed BEFORE anything is merged: a mismatch means the policy moved between the tap and
  // this write, so the whole patch is refused. Never partially applied, never silently applied.
  for (const [field, expected] of Object.entries(expectedCurrent ?? {})) {
    const actual = policyPreconditionActual((current as unknown as Record<string, unknown>)[field]);
    if (actual === expected) continue;
    audit(
      "mobile_policy_patch_precondition_mismatch",
      { field, expected, actual, fields: Object.keys(patch) },
      userId,
      current.connectedAccountId
    );
    throw new PolicyPatchPreconditionError(
      `${field} changed since this was sent — it is ${describePreconditionValue(actual)} now, not the ${describePreconditionValue(expected)} this change was based on.  Nothing was changed.`,
      { field, expected, actual }
    );
  }
  const next: TradingPolicy = {
    ...current,
    ...patch,
    riskRules: { ...current.riskRules, ...(patch.riskRules ?? {}) },
    notificationSettings: {
      ...current.notificationSettings,
      ...(patch.notificationSettings ?? {}),
      enabledEvents: patch.notificationSettings?.enabledEvents ?? current.notificationSettings.enabledEvents
    },
    taxSettings: { ...DEFAULT_TAX_SETTINGS, ...(current.taxSettings ?? {}), ...(patch.taxSettings ?? {}) },
    tuning: { ...(current.tuning ?? {}), ...(patch.tuning ?? {}) }
  };
  if (next.systemState === "active") {
    if (!next.accountNumber) throw new Error("Select an account before enabling autonomy.");
    if (next.includedIndices.length === 0 && next.additionalSymbols.length === 0) {
      throw new Error("Select at least one base index or additional watchlist symbol before enabling autonomy.");
    }
  }
  normalizeExclusivePolicyCaps(next, patch);
  setPolicy(next, userId);
  audit(
    "mobile_policy_patch",
    { fields: Object.keys(patch), ...(expectedCurrent ? { guardedFields: Object.keys(expectedCurrent) } : {}) },
    userId
  );
  return { ok: true, policy: getPolicy(userId) };
}

async function runCommand(command: MobileCommandRecord): Promise<unknown> {
  const payload = command.payload;
  switch (command.commandType) {
    case "strategy.run_once": {
      const result = await runStrategyOnce(command.userId, { manual: true });
      if (result.status === "failed") throw new Error(result.summary || "Strategy run failed.");
      return result;
    }
    case "strategy.start":
      return setStrategyState(command.userId, "active");
    case "strategy.stop":
      return setStrategyState(command.userId, "halted");
    case "strategy.close_only":
      return setStrategyState(command.userId, "close_only");
    case "strategy.liquidating":
      return setStrategyState(command.userId, "liquidating");
    case "proposal.approve":
      return executeProposal(String(payload.proposalId), command.userId, {
        liveConfirmation: payload.liveConfirmation as LiveApprovalConfirmation | undefined
      });
    case "proposal.reject": {
      const proposalId = String(payload.proposalId);
      if (!getProposal(proposalId, command.userId)) throw new Error("Proposal not found.");
      rejectProposal(proposalId, command.userId);
      return { ok: true, status: "rejected", proposalId };
    }
    case "proposal.retry_red_team":
      return retryProposalRedTeam(String(payload.proposalId), command.userId);
    case "account.activate": {
      const accountId = String(payload.accountId);
      setActiveConnectedAccount(accountId, command.userId);
      audit("mobile_account_activate", { accountId }, command.userId);
      return { ok: true, activeAccount: listConnectedAccounts(command.userId).find((account) => account.id === accountId) };
    }
    case "order.cancel": {
      // Same implementation the console's POST /api/orders/cancel runs — lease-interleave receipt,
      // time-bounded dust advisory, audit trail, dashboard event and all. `requireWorkingOrder`
      // asks it to resolve the order inside THIS user's selected account first, because a mobile
      // failure is read as text on a phone minutes later and has to say something true; account
      // isolation itself does not rest on that read (the cancel is always scoped to the requesting
      // user's own selected account and their own broker credentials).
      const orderId = String(payload.orderId);
      const expectedAccountNumber = typeof payload.accountNumber === "string" ? payload.accountNumber : undefined;
      const result = await cancelWorkingOrder({
        userId: command.userId,
        orderId,
        expectedAccountNumber,
        requireWorkingOrder: true,
        source: "mobile"
      });
      return {
        ok: true,
        status: result.state,
        orderId: result.orderId ?? orderId,
        ...(result.symbol ? { symbol: result.symbol } : {}),
        ...(result.dustWarning ? { dustWarning: result.dustWarning } : {})
      };
    }
    case "watchlist.add": {
      const item = addToWatchlist(command.userId, String(payload.symbol));
      return { ok: true, ...item };
    }
    case "watchlist.remove": {
      const symbol = String(payload.symbol);
      return { ok: true, symbol, removed: removeFromWatchlist(command.userId, symbol) };
    }
    case "alert.create": {
      const result = createAlert(command.userId, {
        symbol: String(payload.symbol),
        op: String(payload.op),
        price: Number(payload.price),
        note: typeof payload.note === "string" ? payload.note : undefined
      });
      if ("error" in result) throw new Error(result.error);
      return { ok: true, alert: result };
    }
    case "alert.delete": {
      const alertId = String(payload.alertId);
      return { ok: true, alertId, removed: removeAlert(command.userId, alertId) };
    }
    case "policy.patch":
      return applyPolicyPatch(
        command.userId,
        payload.patch as Partial<TradingPolicy>,
        payload.expectedCurrent as Record<string, PolicyPreconditionValue> | undefined
      );
    case "consent.set": {
      const legal = setLegalNoticeConsent(command.userId, true);
      const dataPool = setDataPoolConsent(command.userId, true);
      return { ok: true, legal, consent: dataPool };
    }
    case "notification.test":
      return {
        ok: true,
        results: await notify(command.userId, {
          title: "Test notification",
          body: "If you received this, your iPhone alert path is working.",
          kind: "test"
        })
      };
    default: {
      const _exhaustive: never = command.commandType;
      throw new Error(`Unsupported command: ${String(_exhaustive)}`);
    }
  }
}

function errorPayload(error: unknown): { message: string; result?: unknown } {
  if (error instanceof PolicyPatchPreconditionError) {
    return {
      message: error.message,
      result: {
        error: "policy_precondition_mismatch",
        field: error.field,
        expected: error.expected,
        actual: error.actual
      }
    };
  }
  if (error instanceof LiveApprovalConfirmationError) {
    return {
      message: error.message,
      result: { error: error.code, reasons: error.reasons, expectedText: error.expectedText }
    };
  }
  return { message: error instanceof Error ? error.message : "Mobile command failed." };
}

export async function executeMobileCommand(command: MobileCommandRecord): Promise<PublicMobileCommand> {
  try {
    const result = await runCommand(command);
    if (command.commandType === "proposal.approve") {
      const placement = resolvePlacementOutcome(result as ExecuteProposalResult);
      const commandStatus = mobileCommandStatusForPlacement(placement.outcome);
      const error = placementCommandErrorMessage(placement);
      return toPublicMobileCommand(finishCommand(command, commandStatus, placement, error));
    }
    return toPublicMobileCommand(finishCommand(command, "succeeded", result));
  } catch (error) {
    const payload = errorPayload(error);
    return toPublicMobileCommand(finishCommand(command, "failed", payload.result, payload.message));
  }
}

/**
 * Runs an immediate mobile command outside the global sequential worker so it cannot stall behind
 * a long strategy.run_once (or any other queued command). Used for:
 * - Protective strategy state (stop / close_only / liquidating): Stop must remain authoritative
 *   while a run awaits providers. Cannot revoke a broker request that already crossed the
 *   submission boundary; placement re-reads durable state at its final pre-submit boundary.
 * - account.activate: pure active-pointer flip; must complete in the same request so mobile
 *   clients do not leave the Use / selector control spinning for the entire run_once duration.
 * - order.cancel: killing a rotting limit order is worth nothing if it lands after the run that
 *   was already ahead of it in the queue. Immediate, but NOT protective — it does not cancel the
 *   user's other queued work (see IMMEDIATE_MOBILE_COMMAND_TYPES).
 */
export async function executeMobileCommandImmediately(
  commandId: string,
  userId: string
): Promise<PublicMobileCommand> {
  const current = getMobileCommandRecord(commandId, userId);
  if (!current) throw new MobileCommandValidationError("Command not found.");
  if (!isImmediateMobileCommandType(current.commandType)) {
    throw new MobileCommandValidationError("Command is not an immediate action.");
  }
  if (current.status !== "queued") return toPublicMobileCommand(current);

  const nowIso = new Date().toISOString();
  const claimed = getDb().prepare(`
    UPDATE mobile_commands
    SET status = 'running', started_at = ?, updated_at = ?
    WHERE id = ? AND user_id = ? AND status = 'queued'
  `).run(nowIso, nowIso, commandId, userId);
  if (claimed.changes !== 1) {
    return getMobileCommand(commandId, userId) ?? toPublicMobileCommand(current);
  }

  const running = getMobileCommandRecord(commandId, userId)!;
  emitMobileCommandEvent(running);
  const completed = await executeMobileCommand(running);
  if (completed.status === "succeeded" && isImmediateProtectiveMobileCommandType(running.commandType)) {
    cancelQueuedRiskIncreasingCommands(userId, commandId, running.commandType);
  }
  return completed;
}

/** @deprecated Prefer executeMobileCommandImmediately — kept for existing test import sites. */
export async function executeProtectiveMobileCommandImmediately(
  commandId: string,
  userId: string
): Promise<PublicMobileCommand> {
  return executeMobileCommandImmediately(commandId, userId);
}

export async function processPendingMobileCommands(options: { limit?: number } = {}): Promise<{ processed: number }> {
  if (globalForMobileEvents.__mobileCommandWorkerInFlight) return { processed: 0 };
  globalForMobileEvents.__mobileCommandWorkerInFlight = true;
  let processed = 0;
  const limit = Math.min(Math.max(Math.floor(options.limit ?? 3), 1), 10);
  try {
    while (processed < limit) {
      const command = claimNextQueuedCommand();
      if (!command) break;
      emitMobileCommandEvent(command);
      await executeMobileCommand(command);
      processed += 1;
    }
    return { processed };
  } finally {
    globalForMobileEvents.__mobileCommandWorkerInFlight = false;
  }
}

/** Scoped to the requesting user (api-contract-web-ios:api-10) — this backlog gauge renders on
 *  the iOS Home/Activity screens as if it were "your commands"; unscoped, it silently counted
 *  every user's queued/running mobile commands, which would misattribute another user's activity
 *  as the signed-in user's own. */
export function mobileCommandBacklog(userId: string): { queued: number; running: number } {
  const rows = getDb()
    .prepare("SELECT status, COUNT(*) AS n FROM mobile_commands WHERE user_id = ? AND status IN ('queued','running') GROUP BY status")
    .all(userId) as Array<{ status: MobileCommandStatus; n: number }>;
  return {
    queued: rows.find((row) => row.status === "queued")?.n ?? 0,
    running: rows.find((row) => row.status === "running")?.n ?? 0
  };
}

// Mirrors STALE_RUN_THRESHOLD_MS in db-execution.ts, and for the same reason: the longest command
// here (strategy.run_once) wraps the very strategy run that threshold was raised to 30 min to
// accommodate, so anything tighter would re-create the 2026-07-08 incident on the mobile path.
// Consequence worth stating plainly: after a crash, a stranded command — and therefore the
// account-deletion blocker it feeds — clears in up to 30 minutes, not instantly.
const STALE_MOBILE_COMMAND_THRESHOLD_MS = 30 * 60_000;

// This string is read by a human on their phone, and it must not lie. The sweep knows only that
// the worker stopped reporting — it does NOT know whether the command ran. Saying "failed" here
// would tell an operator whose proposal.approve had already crossed the broker submission boundary
// that nothing happened, and the natural next action is a duplicate order. State the uncertainty
// and point at verification instead.
const STALE_MOBILE_COMMAND_ERROR =
  "Interrupted by a process restart while running. The outcome is UNKNOWN - this command may have completed, partly completed, or never started. Check your orders and settings before retrying; do not assume it did nothing.";

/**
 * Liveness evidence for a command that is already past the time cutoff. Returning true means "slow,
 * not dead" — the sweep must leave it alone. Only the two command types that can legitimately run
 * long have evidence to check; every other type is a single DB write or one bounded HTTP call, so
 * 30 minutes past `started_at` can only mean the worker process died.
 */
function staleMobileCommandStillAlive(
  db: ReturnType<typeof getDb>,
  row: { user_id: string; command_type: MobileCommandType; started_at: string; payload: string },
  cutoffIso: string
): boolean {
  if (row.command_type === "strategy.run_once") {
    // The command wraps runStrategyOnce, which inserts a strategy_runs row immediately. A run this
    // user started at/after the command claim and that is STILL 'running' is the command's own body
    // still executing. This deliberately reads the run's live status rather than its own clock: the
    // scheduler sweeps strategy_runs on the same tick with the same threshold and the same
    // audit-activity grace, so a run that is genuinely alive keeps its 'running' status and hands
    // that grace straight through to the command here. A concurrent unrelated run for the same user
    // would also grant grace — that errs toward not declaring a live command dead, which is the
    // side to err on.
    const liveRun = db
      .prepare("SELECT 1 FROM strategy_runs WHERE user_id = ? AND status = 'running' AND started_at >= ? LIMIT 1")
      .get(row.user_id, row.started_at);
    if (liveRun) return true;
  }
  if (row.command_type === "proposal.approve") {
    // The money-path case. executeProposal receipts every step of an approval under the proposal's
    // id (order_placement_uncertain, order_rejected_by_broker, proposal_approved, ...), so an
    // approval still emitting audit rows inside the lookback window is demonstrably mid-flight —
    // the same evidence markStaleRunningRuns uses via '$.runId'. Declaring a live approval dead is
    // the single worst outcome this sweep can produce: the operator reads "outcome unknown" while
    // the broker submission is still in progress, and the natural response is a duplicate order.
    let proposalId: string | undefined;
    try {
      const payload = JSON.parse(row.payload) as Record<string, unknown>;
      proposalId = typeof payload.proposalId === "string" ? payload.proposalId : undefined;
    } catch {
      // A malformed payload can't have executed an approval; fall through with no grace.
    }
    if (proposalId) {
      const recentActivity = db
        .prepare("SELECT 1 FROM audit_events WHERE json_extract(payload, '$.proposalId') = ? AND created_at >= ? LIMIT 1")
        .get(proposalId, cutoffIso);
      if (recentActivity) return true;
    }
  }
  return false;
}

/**
 * Sweep mobile_commands rows left in status='running' after a process crash / kill / unhandled
 * rejection (claimNextQueuedCommand set 'running', and finishCommand never ran). Without this,
 * such a row is stuck forever: nothing in the codebase selects or updates 'running' commands, so
 * account deletion stays blocked on `activeMobileCommands` permanently, the PWA spins forever, and
 * `mobileCommandBacklog().running` never returns to zero.
 *
 * Rows are marked FAILED, never requeued. A stranded proposal.approve may already have crossed the
 * broker submission boundary, so re-executing it could duplicate a real order — the correct repair
 * is to record that the outcome is unknown and let the operator decide, not to retry.
 *
 * Returns the number of repaired rows for logging/auditing.
 */
export function markStaleRunningMobileCommands(now: number = Date.now()): number {
  const db = getDb();
  const cutoffIso = new Date(now - STALE_MOBILE_COMMAND_THRESHOLD_MS).toISOString();
  const stale = db
    .prepare(
      `SELECT id, user_id, command_type, payload, started_at FROM mobile_commands
       WHERE status = 'running' AND started_at IS NOT NULL AND started_at < ?`
    )
    .all(cutoffIso) as Array<{
      id: string;
      user_id: string;
      command_type: MobileCommandType;
      payload: string;
      started_at: string;
    }>;
  let count = 0;
  for (const row of stale) {
    if (staleMobileCommandStillAlive(db, row, cutoffIso)) continue;

    const nowIso = new Date(now).toISOString();
    const res = db
      .prepare(
        "UPDATE mobile_commands SET status = 'failed', error = ?, finished_at = ?, updated_at = ? WHERE id = ? AND status = 'running'"
      )
      .run(STALE_MOBILE_COMMAND_ERROR, nowIso, nowIso, row.id);
    // Only receipt+count rows this sweep actually transitioned, so a concurrent scheduler instance
    // that repaired the row between our SELECT and UPDATE doesn't produce a duplicate receipt.
    if (res.changes === 0) continue;
    audit(
      "mobile_command_crashed",
      {
        commandId: row.id,
        commandType: row.command_type,
        startedAt: row.started_at,
        reason: "marked failed by stale mobile-command sweep; outcome unknown"
      },
      row.user_id
    );
    const updated = getMobileCommandRecord(row.id, row.user_id);
    if (updated) emitMobileCommandEvent(updated);
    count++;
  }
  return count;
}

/** Public iOS Activity rows. Payload and webhook URL stay off the wire. */
export function serializeMobileNotifications(events: NotificationEvent[]) {
  return events.map((event) => ({
    id: event.id,
    type: event.type,
    title: event.title,
    createdAt: event.createdAt,
    status: event.status,
    acknowledgedAt: event.acknowledgedAt ?? null,
    connectedAccountId: event.connectedAccountId ?? null
  }));
}

export function mobileControlCatalog() {
  return {
    version: 2,
    auth: {
      mode: "server-session",
      supported: ["Cloudflare Access", "Auth.js session"],
      phoneStores: "server session cookie only; provider and broker secrets stay server-side"
    },
    realtime: {
      sse: "/api/mobile/events",
      eventTypes: ["mobile.command", "dashboard.run-complete", "dashboard.proposal", "dashboard.order", "dashboard.market-data", "dashboard.dirty"]
    },
    accountDeletion: {
      request: "GET /api/mobile/account-deletion/request (read-only preview)",
      confirm: "POST /api/mobile/account-deletion/confirm",
      requiredText: "DELETE MY ACCOUNT",
      note: "Previewing is read-only. Final confirmation prepares and deletes app-side data and server-stored secrets for the signed-in OAuth identity, then the client should sign out."
    },
    commands: MOBILE_COMMAND_TYPES.map((type) => ({ type }))
  };
}

import { userHasAnyLlmCredential } from "./db-api-keys";

export function mobileReadiness(userId: string) {
  const policy = getPolicy(userId);
  const consent = getDataPoolConsent(userId);
  const connectedAccounts = listConnectedAccounts(userId);
  return {
    hasAccount: Boolean(policy.accountNumber),
    hasUniverse: policy.includedIndices.length > 0 || policy.additionalSymbols.length > 0,
    hasLlmKey: userHasAnyLlmCredential(userId),
    systemState: policy.systemState,
    strategyAuthority: policy.strategyAuthority,
    selectedAccountNumber: policy.accountNumber ?? null,
    activeConnectedAccount: connectedAccounts.find((account) => account.isActive) ?? null,
    dataPoolConsent: consent,
    legalNotice: getLegalNoticeConsent(userId),
    needsAppConsent: needsAppConsent(userId),
    commandBacklog: mobileCommandBacklog(userId)
  };
}
