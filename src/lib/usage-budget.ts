// Cost-aware feedback loop: read budget status from the API Usage Monitor and (Phase 1) alert on
// over-budget providers.
//
// PHASE 2 (force cheaper models / skip a cycle when over budget) is wired into `runStrategyOnce`
// (see strategy.ts's "Cost-aware budget feedback loop" + "Per-user/day LLM budget ceiling"
// comments) as of 2026-07-05:
//   - ADVISORY (always on when the monitor is configured, independent of the enforce flag): every
//     run stamps a `usage_budget_status` audit receipt and, when a provider is at warning/exceeded,
//     injects a `formatBudgetAdvisory` line into the Bull userContent next to `drawdownAdvisory` —
//     DATA for the agent, never a command.
//   - ENFORCEMENT (opt-in via USAGE_BUDGET_ENFORCE, default off): `evaluateBudgetForRun`'s decision
//     is applied at the per-user/day LLM budget choke point, BEFORE any LLM call and AFTER the
//     risk-reducing breakers — skip ends the run gracefully (audit + notifyBudgetSkip), downgrade
//     swaps `policy.llmModel`/`policy.redTeamLlmModel` on the in-memory run policy ONLY (never
//     persisted via setPolicy, so the next run reads the owner's configured model again).
//
// SAFETY / SELF-SUFFICIENCY:
//   - Reads are gated on the same config as the push (USAGE_MONITOR_BASE_URL + USAGE_INGEST_TOKEN);
//     when unset the monitor isn't consulted at all and App B behaves exactly as before.
//   - Enforcement (model downgrade / cycle skip) is additionally gated behind USAGE_BUDGET_ENFORCE
//     (default off) — Phase 1 (alerts + advisory) is the default when the monitor is configured.
//   - FAIL-OPEN: if the monitor is unreachable or returns an error, budget status is treated as
//     unknown and NO enforcement happens (App B keeps trading normally). The only visible effect of
//     an outage is the "usage-monitor" row on the admin connections-health page.
//   - Status is TTL-cached so a run never hammers the monitor.

import { logApiHealth } from "./db-health";
import { sendNotification } from "./notifications";
import { audit } from "./db";
import { createDurableMap } from "./durable-state";
import type { TradingPolicy } from "./types";
import { resolveOpenAiModel } from "./llm-request";
import { modelCredentialService } from "./llm-provider";
import { catalogEntryFor } from "./llm-model-catalog";
import { usageMonitorBaseUrl, usageMonitorToken, usageMonitorEnabled } from "./usage-monitor-push";
import { alertUsageLimitHit } from "./usage-limit-alerts";
import {
  PEER_LANE_USAGE_MONITOR,
  recordPeerLaneSample,
  shouldDeferPeerRefresh,
} from "./peer-lane-backoff";

// ── Contract (subset of the monitor's GET /api/budget-status response) ──────────

export type BudgetLevel = "ok" | "warning" | "exceeded" | "unconfigured";

export interface ProviderBudget {
  name: string;
  status: BudgetLevel;
  monthlyBudgetUsd: number | null;
  spentUsd: number;
  remainingUsd: number | null;
  percentUsed: number | null;
  /**
   * Forecast-aware fields (the monitor's forecasting.ts / budget-status.ts "S9" projection) — end-
   * of-month spend at current burn and the date the projection crosses the budget. Optional: older
   * monitor responses (or a provider the monitor never forecasted, e.g. `unconfigured`) omit them,
   * in which case parseBudgetStatus leaves them `null` rather than treating the response as
   * malformed.
   */
  projectedEomUsd: number | null;
  projectedRunoutDate: string | null;
  /** CostCoverage on the monitor side ("complete" | "partial" | "unknown" | "legacy_unknown") — kept
   *  as a loose string here (not a closed union) so a new coverage label the monitor adds doesn't
   *  need a lockstep type change on this side; `null` when the response doesn't carry it. */
  spendCoverage: string | null;
}

export interface BudgetStatus {
  generatedAt: string;
  month: string;
  providers: ProviderBudget[];
  summary: {
    totalBudgetUsd: number;
    totalSpentUsd: number;
    remainingUsd: number;
    percentUsed: number | null;
    overBudget: boolean;
    warning: boolean;
  };
}

// ── Config ──────────────────────────────────────────────────────────────────────

function flagOn(value: string | undefined): boolean {
  const v = (value ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function numEnv(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/** Phase 2 enforcement (model downgrade / cycle skip). Default OFF. */
export function usageBudgetEnforceEnabled(): boolean {
  return flagOn(process.env.USAGE_BUDGET_ENFORCE);
}

/**
 * Token for the budget-status GET. The monitor accepts a dedicated `USAGE_READ_TOKEN` when set,
 * else the ingest token — mirror that here so a separate read token doesn't 401 every budget read.
 */
function budgetReadToken(): string | undefined {
  const read = (process.env.USAGE_READ_TOKEN ?? "").trim();
  return read.length > 0 ? read : usageMonitorToken();
}

function ttlMs(): number {
  return numEnv("USAGE_BUDGET_TTL_MS", 5 * 60_000);
}

function timeoutMs(): number {
  // Bounded: the enforce path awaits this at run entry, so a hung monitor must not stall a
  // scheduled cycle for long. Fail-open returns null after the timeout (no enforcement).
  //
  // 8000, not the original 2500 (2026-08-12): this is a cross-internet call to usage.jays.services
  // and 2.5s aborted healthy-but-slow responses often enough to be a top "usage-monitor connection
  // failed" source. The health-lane re-probe for this exact host already uses 8000
  // (health-lane-reprobe.ts), so the two agree now instead of the probe passing while the real
  // read times out. Overridable via USAGE_BUDGET_TIMEOUT_MS.
  return numEnv("USAGE_BUDGET_TIMEOUT_MS", 8000);
}

function alertCooldownMs(): number {
  return numEnv("USAGE_BUDGET_ALERT_COOLDOWN_MS", 6 * 60 * 60_000);
}

// ── Fetch + TTL cache (globalThis-pinned so HMR can't split it) ─────────────────

interface BudgetCacheHost {
  __usageBudgetCache?: { status: BudgetStatus; fetchedAt: number };
}
const cacheHost = globalThis as unknown as BudgetCacheHost;

// Durable (survives a process restart): every OTHER alert-cooldown in this codebase (db-health.ts,
// usage-limit-alerts.ts, broker-minimum-guard.ts, vector-db.ts) is backed by getInternalSetting/
// setInternalSetting (durable); this one alone used a bare in-memory Map — an inconsistency, not a
// deliberate choice. Without persistence, a redeploy resets the cooldown clock and a user/provider
// already alerted minutes earlier gets re-alerted immediately after — the exact duplicate-alert spam
// this cooldown exists to prevent.
// Lazily created (not at module top level) — see provider-rate-limit.ts's quotaStore() for why
// eagerly calling createDurableMap() at import time risks a circular-import TDZ crash.
let alertSentAtInstance: ReturnType<typeof createDurableMap<number>> | undefined;
function alertSentAt(): ReturnType<typeof createDurableMap<number>> {
  return alertSentAtInstance ?? (alertSentAtInstance = createDurableMap<number>("usage-budget-alert-cooldown"));
}

function isBudgetLevel(v: unknown): v is BudgetLevel {
  return v === "ok" || v === "warning" || v === "exceeded" || v === "unconfigured";
}

function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function strOrNull(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** Defensive parse of the monitor response — tolerant of extra/missing fields. */
function parseBudgetStatus(json: unknown): BudgetStatus | null {
  if (!json || typeof json !== "object") return null;
  const obj = json as Record<string, unknown>;
  const rawProviders = Array.isArray(obj.providers) ? obj.providers : [];
  const providers: ProviderBudget[] = [];
  for (const raw of rawProviders) {
    if (!raw || typeof raw !== "object") continue;
    const p = raw as Record<string, unknown>;
    if (typeof p.name !== "string") continue;
    providers.push({
      name: p.name,
      status: isBudgetLevel(p.status) ? p.status : "unconfigured",
      monthlyBudgetUsd: numOrNull(p.monthlyBudgetUsd),
      spentUsd: numOrNull(p.spentUsd) ?? 0,
      remainingUsd: numOrNull(p.remainingUsd),
      percentUsed: numOrNull(p.percentUsed),
      projectedEomUsd: numOrNull(p.projectedEomUsd),
      projectedRunoutDate: strOrNull(p.projectedRunoutDate),
      spendCoverage: strOrNull(p.spendCoverage),
    });
  }
  const summaryRaw = (obj.summary && typeof obj.summary === "object" ? obj.summary : {}) as Record<string, unknown>;
  return {
    generatedAt: typeof obj.generatedAt === "string" ? obj.generatedAt : new Date().toISOString(),
    month: typeof obj.month === "string" ? obj.month : "",
    providers,
    summary: {
      totalBudgetUsd: numOrNull(summaryRaw.totalBudgetUsd) ?? 0,
      totalSpentUsd: numOrNull(summaryRaw.totalSpentUsd) ?? 0,
      remainingUsd: numOrNull(summaryRaw.remainingUsd) ?? 0,
      percentUsed: numOrNull(summaryRaw.percentUsed),
      overBudget: summaryRaw.overBudget === true,
      warning: summaryRaw.warning === true,
    },
  };
}

async function fetchBudgetStatus(fetchImpl: typeof fetch = fetch): Promise<BudgetStatus | null> {
  const baseUrl = usageMonitorBaseUrl();
  const token = budgetReadToken();
  if (!baseUrl || !token) return null;
  const url = `${baseUrl}/api/budget-status`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs());
  const start = Date.now();
  try {
    const res = await fetchImpl(url, {
      method: "GET",
      headers: { authorization: `Bearer ${token}` },
      signal: controller.signal,
      cache: "no-store",
    });
    const latencyMs = Date.now() - start;
    recordPeerLaneSample(PEER_LANE_USAGE_MONITOR, latencyMs);
    logApiHealth({
      service: "usage-monitor",
      ok: res.ok,
      latencyMs,
      errorText: res.ok ? undefined : `budget-status HTTP ${res.status}`,
    });
    if (!res.ok) return null;
    const json = await res.json().catch(() => null);
    return parseBudgetStatus(json);
  } catch (err) {
    // Soft: this read is explicitly FAIL-OPEN (the catch returns null and the caller does not
    // enforce), so an abort/network blip changes no behavior and must not page at level=error.
    // The row is still stored ok=0, so Admin Connections shows the lane honestly.
    const latencyMs = Date.now() - start;
    recordPeerLaneSample(PEER_LANE_USAGE_MONITOR, latencyMs);
    logApiHealth({
      service: "usage-monitor",
      ok: false,
      latencyMs,
      errorText: err instanceof Error ? err.message : String(err),
      soft: true,
    });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Cached budget status. Returns null when the monitor is unconfigured or unreachable (fail-open —
 * callers must treat null as "unknown, do not enforce"). Successful fetches are cached for TTL.
 */
export async function getBudgetStatusCached(opts: { force?: boolean; fetchImpl?: typeof fetch } = {}): Promise<BudgetStatus | null> {
  if (!usageMonitorEnabled()) return null;
  const now = Date.now();
  const cached = cacheHost.__usageBudgetCache;
  if (!opts.force && cached && now - cached.fetchedAt < ttlMs()) return cached.status;
  // #2550: a 7s UM must not stall a strategy run. Serve stale cache (or fail-open
  // null) and skip the network while the peer-lane p50 is slow.
  if (!opts.force && shouldDeferPeerRefresh(PEER_LANE_USAGE_MONITOR, now)) {
    return cached?.status ?? null;
  }
  const status = await fetchBudgetStatus(opts.fetchImpl);
  if (status) cacheHost.__usageBudgetCache = { status, fetchedAt: now };
  return status; // null on failure → fail-open
}

/** Test-only: drop the in-process budget cache so tests do not leak across files. */
export function resetUsageBudgetCacheForTests(): void {
  delete cacheHost.__usageBudgetCache;
}

// ── Forecast-aware alert level ───────────────────────────────────────────────────
// ADVISORY ONLY — the alert/advisory surface below considers the forecasted end-of-month spend, not
// just lagging month-to-date spend, so early-month burn that's on pace to blow the budget is
// visible before it actually does. Phase 2 enforcement (evaluateBudgetForRun/computeBudgetDecision)
// deliberately still keys off the monitor's own lagging `status` field only — unchanged by this.

// Mirrors the monitor's own WARNING_RATIO (budget-status.ts) so a forecast-derived level lines up
// with what the monitor itself would call "warning" — advisory-only, not the enforcement threshold.
const FORECAST_WARNING_RATIO = 0.8;

const LEVEL_SEVERITY: Record<BudgetLevel, number> = { unconfigured: 0, ok: 0, warning: 1, exceeded: 2 };

/** Level implied by projectedEomUsd vs monthlyBudgetUsd alone, ignoring the monitor's own lagging
 *  `status`. "unconfigured" (== not worth alerting on) when either figure is missing/non-positive —
 *  a provider the monitor never forecasted must not spuriously read as "ok" via a 0/0 ratio. */
function forecastAlertLevel(p: ProviderBudget): BudgetLevel {
  if (p.projectedEomUsd == null || p.monthlyBudgetUsd == null || p.monthlyBudgetUsd <= 0) return "unconfigured";
  const ratio = p.projectedEomUsd / p.monthlyBudgetUsd;
  if (ratio >= 1) return "exceeded";
  if (ratio >= FORECAST_WARNING_RATIO) return "warning";
  return "ok";
}

/** More severe of the monitor's own lagging `status` and the locally-derived forecast level, so a
 *  provider comfortably under MTD spend but on pace to blow its monthly budget still surfaces. */
function alertLevel(p: ProviderBudget): BudgetLevel {
  const forecast = forecastAlertLevel(p);
  return LEVEL_SEVERITY[forecast] > LEVEL_SEVERITY[p.status] ? forecast : p.status;
}

// ── Phase 1: alerts ──────────────────────────────────────────────────────────────

function shouldAlert(userId: string, provider: string, level: BudgetLevel): boolean {
  const key = `${userId}|${provider}|${level}`;
  const now = Date.now();
  const last = alertSentAt().get(key);
  if (last !== undefined && now - last < alertCooldownMs()) return false;
  alertSentAt().set(key, now);
  return true;
}

/**
 * Fire budget alerts through the existing notification pipe for any provider at warning/exceeded.
 * Best-effort, throttled per (user, provider, level). Never throws. Runs whenever the monitor is
 * configured (independent of the enforce flag).
 */
export async function checkBudgetAndAlert(
  userId: string,
  policy: TradingPolicy,
  deps: { status?: BudgetStatus | null; fetchImpl?: typeof fetch } = {}
): Promise<void> {
  try {
    if (!usageMonitorEnabled()) return;
    const status = deps.status ?? (await getBudgetStatusCached({ fetchImpl: deps.fetchImpl }));
    if (!status) return;
    for (const p of status.providers) {
      // Forecast-aware: alert on either the monitor's own lagging status OR a projected EOM spend
      // that's on pace to breach the budget, whichever is worse — not lagging spend alone.
      const level = alertLevel(p);
      if (level !== "exceeded" && level !== "warning") continue;
      if (!shouldAlert(userId, p.name, level)) continue;
      const laggingLevel = p.status === "exceeded" || p.status === "warning";
      const forecastOnly = !laggingLevel; // triggered purely by the forecast, MTD spend is still ok
      await alertUsageLimitHit({
        userId,
        provider: p.name,
        operation: "usage-monitor.budget-status",
        limitName: "monthly usage budget",
        status: level === "exceeded" ? "exceeded" : "warning",
        used: p.spentUsd,
        limit: p.monthlyBudgetUsd,
        unit: "USD",
        recommendation: forecastOnly
          ? `Month-to-date spend is still within budget, but the projected end-of-month spend ($${p.projectedEomUsd?.toFixed(2) ?? "?"}) is on pace to ${level === "exceeded" ? "exceed" : "approach"} the budget${p.projectedRunoutDate ? ` (~${p.projectedRunoutDate})` : ""} — worth getting ahead of it now rather than waiting for the lagging total to catch up.`
          : level === "exceeded"
            ? "If usage is intentional and useful, raise the provider budget. If not, inspect repeated calls, retries, model selection, and batching."
            : "Watch trend and decide whether to raise the budget or reduce usage before the provider blocks useful work.",
        payload: {
          spentUsd: p.spentUsd,
          monthlyBudgetUsd: p.monthlyBudgetUsd,
          remainingUsd: p.remainingUsd,
          percentUsed: p.percentUsed,
          projectedEomUsd: p.projectedEomUsd,
          projectedRunoutDate: p.projectedRunoutDate,
          spendCoverage: p.spendCoverage,
          month: status.month,
          policyConnectedAccountId: policy.connectedAccountId
        }
      });
    }
  } catch {
    /* alerts are best-effort — never break the caller */
  }
}

// ── Phase 2: enforcement (model downgrade / cycle skip) ─────────────────────────

const CHEAPER_MODEL: Record<string, string> = {
  // OpenAI — 2026-09-18 cleanup: gpt-5.6-terra / gpt-5.4-mini / gpt-5.4-nano / gpt-mini-latest /
  // gpt-4o / gpt-4.1 / o1 / o1-preview were removed from the curated catalog. Downgrade chain
  // for the four remaining OpenAI rows:
  //   gpt-6-astra-pro -> gpt-5.6-sol -> gpt-5.6-luna (no further OpenAI downgrade)
  // The chain stops at luna: there is no cheaper OpenAI tier left in the catalog, so any further
  // downgrade attempt falls out to a skip/cycle-skip rather than a bogus tier. The historical
  // entries below are kept so persisted pre-cleanup policies (which may still carry the older
  // slug names) downgrade to a valid catalog row instead of failing closed.
  "gpt-6-astra-pro": "gpt-5.6-sol",
  "gpt-6-astra": "gpt-5.6-sol",
  "gpt-5.6": "gpt-5.6-luna",
  "gpt-5.6-sol": "gpt-5.6-luna",
  "gpt-5.6-terra": "gpt-5.6-luna",
  "gpt-5.6-luna": "gpt-5.6-luna", // already at the bottom of the curated OpenAI chain
  "gpt-5.5": "gpt-5.6-luna",
  "gpt-5.4": "gpt-5.6-luna",
  "gpt-mini-latest": "gpt-5.6-luna",
  "gpt-5.4-mini": "gpt-5.6-luna",
  "gpt-5.4-nano": "gpt-5.6-luna",
  "gpt-4o": "gpt-5.6-luna",
  "gpt-4.1": "gpt-5.6-luna",
  "o1": "gpt-5.6-luna",
  "o1-preview": "gpt-5.6-luna",
  // Anthropic
  "claude-fable-latest": "claude-sonnet-latest",
  "claude-opus-latest": "claude-sonnet-latest",
  "claude-sonnet-latest": "claude-haiku-latest",
  "claude-fable-5": "claude-sonnet-latest",
  "claude-opus-5": "claude-sonnet-latest",
  "claude-sonnet-5": "claude-haiku-latest",
  "claude-opus-4-8": "claude-sonnet-latest",
  "claude-sonnet-4-6": "claude-haiku-latest",
  // xAI
  "grok-latest": "grok-build-0.1",
  "grok-4.6": "grok-build-0.1",
  "grok-4.5": "grok-build-0.1",
  "grok-4.3": "grok-build-0.1",
  // Meta / Muse (OpenRouter)
  "muse-spark-1.3": "muse-glimmer-30b",
  // Gemini
  "gemini-pro-latest": "gemini-flash-latest",
  "gemini-flash-latest": "gemini-flash-lite-latest",
  "gemini-3.1-pro-preview": "gemini-flash-latest",
  "gemini-3.7-flash": "gemini-flash-lite-latest",
  "gemini-3.6-flash": "gemini-flash-lite-latest",
  "gemini-3.5-flash": "gemini-flash-lite-latest",
  "gemini-2.5-pro": "gemini-flash-latest",
  "gemini-2.5-flash": "gemini-flash-lite-latest",
  // Mistral
  "mistral-large-latest": "mistral-medium-latest",
  "mistral-medium-latest": "mistral-small-latest",
  "mistral-large-2512": "mistral-medium-latest",
  "mistral-medium-3-5": "mistral-small-latest",
  "mistral-large": "mistral-medium-latest",
  "mistral-medium": "mistral-small-latest",
  // DeepSeek
  "deepseek-pro-latest": "deepseek-flash-latest",
  "deepseek-r1": "deepseek-flash-latest",
  "deepseek-v4-pro": "deepseek-flash-latest",
  "deepseek-reasoner": "deepseek-flash-latest",
};

/** A cheaper model in the same family, or undefined if none is known. */
export function cheaperModel(model: string | null | undefined): string | undefined {
  if (!model) return undefined;
  const raw = model.trim();
  const parts = raw.toLowerCase().replace(/^~/, "").split("/");
  const prefix = parts.length > 1 ? parts.slice(0, -1).join("/") + "/" : "";
  const rawKey = parts[parts.length - 1];
  const entry = catalogEntryFor(raw);
  // Keep explicitly configured historical tiers; resolve new catalog aliases before prefix fallback.
  const key = CHEAPER_MODEL[rawKey] ? rawKey : (entry?.displaySlug ?? rawKey).toLowerCase();

  let cheaper: string | undefined;
  if (CHEAPER_MODEL[key]) {
    cheaper = CHEAPER_MODEL[key];
  } else {
    // Prefix fallback for DATED/versioned suffixes only (e.g. "claude-opus-4-8-20251101" → the
    // "claude-opus-4-8" tier). Requires the remainder to be a "-<digit>..." date/version — never a
    // variant suffix like "-mini"/"-nano" (those must be exact keys, else they'd wrongly map to their
    // own base tier's downgrade, i.e. to themselves).
    const matchedKey = Object.keys(CHEAPER_MODEL).find((k) => {
      if (!key.startsWith(k)) return false;
      const rest = key.slice(k.length);
      return rest === "" || /^-\d/.test(rest);
    });
    if (matchedKey) cheaper = CHEAPER_MODEL[matchedKey];
  }
  return cheaper ? prefix + cheaper : undefined;
}

export interface BudgetRunDecision {
  skip: boolean;
  downgraded: boolean;
  llmModel?: string;
  redTeamLlmModel?: string;
  reason?: string;
}

const NO_DECISION: BudgetRunDecision = { skip: false, downgraded: false };

/**
 * Decide whether to skip a strategy cycle or downgrade its models given current budget status.
 * Only active when USAGE_BUDGET_ENFORCE is on AND the monitor is configured. Returns a no-op
 * decision otherwise (and on any monitor failure — fail-open).
 *
 * Wired into `runStrategyOnce` at the per-user/day LLM budget choke point (see strategy.ts): the
 * caller applies this ONLY to the LLM proposal step (never the broker reconciliation or
 * risk-reducing exits above it), applies any model downgrade to the in-memory run policy only
 * (never the object `setPolicy` would persist), and — because `debateProposal` re-resolves its own
 * model from the policy it's handed — the downgraded `redTeamLlmModel` rides along on that same
 * in-memory policy so the Bear review picks it up too.
 */
export async function evaluateBudgetForRun(
  userId: string,
  policy: { llmModel?: string | null; redTeamLlmModel?: string | null },
  deps: { status?: BudgetStatus | null; fetchImpl?: typeof fetch } = {}
): Promise<BudgetRunDecision> {
  try {
    if (!usageBudgetEnforceEnabled() || !usageMonitorEnabled()) return NO_DECISION;
    const status = deps.status ?? (await getBudgetStatusCached({ fetchImpl: deps.fetchImpl }));
    if (!status) return NO_DECISION; // unknown → fail-open
    return computeBudgetDecision(policy, status, modelCredentialService(resolveOpenAiModel(policy), userId));
  } catch {
    return NO_DECISION; // fail-open
  }
}

/**
 * Pure decision logic shared by `evaluateBudgetForRun` (gated on USAGE_BUDGET_ENFORCE) and
 * `previewBudgetDecision` (the advisory's ungated "what WOULD happen" preview — see
 * strategy.ts's `usage_budget_status` receipt). Never throws; callers wrap in try/catch anyway
 * for defense in depth. Kept separate from `evaluateBudgetForRun` so the advisory preview can see
 * what enforcement WOULD do without needing the flag on — the tested public contract of
 * `evaluateBudgetForRun` (flag-gated, fail-open) is unchanged.
 */
function computeBudgetDecision(
  policy: { llmModel?: string | null; redTeamLlmModel?: string | null },
  status: BudgetStatus,
  primaryProvider: string
): BudgetRunDecision {
  // Resolve the models that will ACTUALLY serve this run, matching resolveLlmEndpoint. NO MODEL
  // DEFAULTS (owner directive 2026-07-07): both resolve to the user's explicit choices, or "" when
  // unchosen — Red NEVER falls back to Green. A run with an unchosen model fails closed before any
  // spend, so there is nothing here to budget: bail out with NO_DECISION on a blank Green, and treat
  // a blank Red as "no red call will run" (no downgrade to compute for it).
  const greenModel = resolveOpenAiModel(policy);
  if (!greenModel) return NO_DECISION;
  const redModel = policy.redTeamLlmModel?.trim() || "";

  // Enforce only the provider selected by this user's actual credentials.  An unrelated
  // provider's row or aggregate summary cannot make this run exceed its budget.
  const statusByProvider = new Map(status.providers.map((p) => [p.name.toLowerCase(), p.status]));
  const primaryStatus = statusByProvider.get(primaryProvider) ?? "ok";

  if (primaryStatus !== "exceeded" && primaryStatus !== "warning") return NO_DECISION;

  const cheaperGreen = cheaperModel(greenModel);
  const greenChanged = !!cheaperGreen && cheaperGreen !== greenModel;

  // Skip the cycle only when the GREEN (primary) provider is fully over budget AND its model has no
  // cheaper tier — the green call is the dominant cost and can't be reduced. Red having a cheaper
  // tier does NOT rescue an over-budget green (that was the earlier bug: it kept running green).
  if (primaryStatus === "exceeded" && !greenChanged) {
    return {
      skip: true,
      downgraded: false,
      reason: `LLM provider "${primaryProvider}" over budget and "${greenModel}" is already the cheapest tier.`,
    };
  }

  const cheaperRed = redModel ? cheaperModel(redModel) : undefined;
  const redChanged = !!cheaperRed && cheaperRed !== redModel;
  if (greenChanged || redChanged) {
    return {
      skip: false,
      downgraded: true,
      llmModel: greenChanged ? cheaperGreen : undefined,
      redTeamLlmModel: redChanged ? cheaperRed : undefined,
      reason: `LLM provider "${primaryProvider}" is ${primaryStatus}; downgraded to a cheaper model tier.`,
    };
  }

  return NO_DECISION;
}

/**
 * ADVISORY preview of what `evaluateBudgetForRun` WOULD decide, ignoring the USAGE_BUDGET_ENFORCE
 * gate (only `usageMonitorEnabled()` still applies — no monitor configured means nothing to
 * preview). Used to populate the `usage_budget_status` audit receipt's `wouldSkip`/`wouldDowngrade`
 * fields every run, independent of whether enforcement is actually on, so the owner can see what
 * enforcement would have done before opting in. Fail-open (never throws).
 */
export async function previewBudgetDecision(
  userId: string,
  policy: { llmModel?: string | null; redTeamLlmModel?: string | null },
  deps: { status?: BudgetStatus | null; fetchImpl?: typeof fetch } = {}
): Promise<BudgetRunDecision> {
  try {
    if (!usageMonitorEnabled()) return NO_DECISION;
    const status = deps.status ?? (await getBudgetStatusCached({ fetchImpl: deps.fetchImpl }));
    if (!status) return NO_DECISION;
    return computeBudgetDecision(policy, status, modelCredentialService(resolveOpenAiModel(policy), userId));
  } catch {
    return NO_DECISION;
  }
}

// ── Advisory formatting (Phase 2 wiring: strategy loop injects this into the prompt) ────────────

/**
 * Compact 1-2 line ADVISORY string summarizing operator LLM-provider spend vs budget, meant to be
 * injected into the Bull (and Bear) userContent next to `drawdownAdvisory` — DATA for the agent,
 * never a command. Returns undefined when there's nothing worth surfacing (monitor unconfigured,
 * or every provider is comfortably under budget) so callers can omit the field entirely.
 *
 * Only mentions providers at "warning" or "exceeded" by the forecast-aware `alertLevel` (matches
 * checkBudgetAndAlert's alerting threshold, so the prompt and the notification pipe agree on what
 * counts as "worth mentioning") — so a provider that's still fine on lagging MTD spend but on pace
 * to blow its budget by end of month still surfaces here, not just once it's already over.
 */
export function formatBudgetAdvisory(status: BudgetStatus | null | undefined): string | undefined {
  if (!status) return undefined;
  const notable = status.providers.filter((p) => {
    const level = alertLevel(p);
    return level === "exceeded" || level === "warning";
  });
  if (notable.length === 0) return undefined;

  const lines = notable.map((p) => {
    const level = alertLevel(p);
    const pct = typeof p.percentUsed === "number" ? ` (${Math.round(p.percentUsed)}%)` : "";
    const budgetTxt = typeof p.monthlyBudgetUsd === "number" ? `$${p.monthlyBudgetUsd.toFixed(0)}` : "no set budget";
    const forecastTxt = typeof p.projectedEomUsd === "number" ? `, projected EOM $${p.projectedEomUsd.toFixed(2)}` : "";
    const runoutTxt = p.projectedRunoutDate ? `, projected runout ${p.projectedRunoutDate}` : "";
    const levelTxt = level !== p.status ? ` (forecast=${level})` : "";
    return `${p.name}: $${p.spentUsd.toFixed(2)} spent of ${budgetTxt}${pct} this month${forecastTxt}${runoutTxt}, status=${p.status}${levelTxt}`;
  });

  const anyExceeded = notable.some((p) => alertLevel(p) === "exceeded");
  const suggestion = anyExceeded
    ? "At least one provider is over (or, on current pace, projected to go over) its monthly budget — worth weighing a cheaper model tier or skipping this cycle's LLM call, but it's your call."
    : "At least one provider is approaching (or, on current pace, projected to approach) its monthly budget — worth keeping an eye on model choice/frequency, but it's your call.";

  return `Operator LLM spend status: ${lines.join("; ")}. ${suggestion}`;
}

/** Audit + notify a budget-driven skip (called from the strategy loop). Never throws. */
export async function notifyBudgetSkip(
  userId: string,
  policy: TradingPolicy,
  runId: string,
  reason: string
): Promise<void> {
  try {
    audit("run_skipped_over_budget", { runId, userId, reason }, userId);
    await sendNotification(
      { type: "budget_alert", title: "Strategy run skipped — over budget", payload: { runId, reason } },
      { policy, userId }
    );
  } catch {
    /* best-effort */
  }
}
