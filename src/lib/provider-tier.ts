// Provider paid-tier watchdog.
//
// We raise the Massive client rate limit to 100/min on the assumption of a paid (unlimited) plan.
// If that subscription ever lapses back to free (5/min), the app would 429-storm. This nightly
// watchdog probes each market-data key's actual tier.  A confident "free" detection still
// auto-clamps the Massive limiter to the free-safe 5/min so the app does not 429-storm, then
// restores the high limit once it sees paid again.  Operator alerts and
// `dataProvidersDegraded` fire only when the probe disagrees with the Settings plan (or the
// provider is not working) — a deliberate downgrade that matches the configured tier is healthy.
//
// Neither Massive (Polygon) nor FMP exposes a "what plan am I on" endpoint, so we use cheap
// capability probes (~2 calls each, well within any tier). The classifier is biased toward "unknown"
// (no action) on any ambiguous/transient signal, so it never wrongly clamps a working paid key.

import { audit, getInternalSetting, resolveApiKey, setInternalSetting } from "./db";
import { massiveApiBase } from "./market-signals/massive";
import { sendNotification } from "./notifications";
import { lookupRegisteredPlanTier, massivePlanAllowsDeepHistory } from "./provider-tier-plan";

export type ProviderTier = "paid" | "free" | "unknown";

/** What kind of evidence backed a tier classification — decoupled from the human-readable
 *  `reason` prose so a consumer can tell WHAT WAS TESTED without parsing English. Every one of
 *  these is a CAPABILITY/plan-access probe (rate limit headroom, historical-depth access): none
 *  of them measures how fresh today's live market data is. That distinction matters because
 *  `history_depth_confirmed`/`history_cap_blocked` read, out of context, like a claim about the
 *  CURRENCY of served data ("returned >2-year-old history") when they're actually only checking
 *  whether the key CAN reach 2-year-old history at all (a paid-tier feature) — see item 24,
 *  docs/rollouts/2026-07-18-decision-status-truth.md. */
export type ProviderTierSignal =
  | "no_key"
  | "rate_limited_429"
  | "history_depth_confirmed"
  | "history_cap_blocked"
  | "history_cap_empty"
  | "premium_gated_error"
  | "data_returned"
  | "probe_error"
  | "ambiguous";

export interface ProviderTierEntry {
  tier: ProviderTier;
  at: string;
  /** Human-readable capability-probe explanation for notifications/audit — NEVER a claim about
   *  how fresh today's live market data is; see `signal` for a structured, prose-free version of
   *  the same distinction. */
  reason: string;
  /** Structured evidence kind behind `reason` (see ProviderTierSignal). Optional because rows
   *  persisted before this field existed won't have it. */
  signal?: ProviderTierSignal;
}
export type ProviderTierStatus = Partial<Record<"massive" | "fmp", ProviderTierEntry>>;

/** Per-user internal-setting key holding the latest detected tier for the user's API keys.
 *  Also read by massive.ts (massiveDetectedFree). Scoped per-user to avoid the shared-row RMW
 *  race that checkRegimeFlip had — two users probing concurrently would otherwise overwrite each
 *  other's merged status on the single shared key. */
export function providerTierStatusKey(userId: string): string {
  return `providerTier:status:${userId}`;
}
export function lastCheckKey(userId: string): string {
  return `providerTier:lastCheckAt:${userId}`;
}

export type DataProviderHonestyCause = "ok" | "tier_mismatch" | "probe_failure";

export interface DataProviderHonesty {
  degraded: boolean;
  cause: DataProviderHonestyCause;
  detail: string;
}

function observedMassiveCapped(entry: ProviderTierEntry): boolean {
  return (
    entry.signal === "history_cap_blocked" ||
    entry.signal === "history_cap_empty" ||
    entry.signal === "rate_limited_429" ||
    entry.tier === "free"
  );
}

/**
 * Honesty rule for `checks.dataProvidersDegraded`.
 *
 * Degrade only when (a) the paid/expected plan is not what the probe sees, or
 * (b) the provider is not working.  A deliberate Settings downgrade to free or
 * a lower paid SKU that matches the configured plan is healthy.  Massive
 * `history_cap_blocked` on a ~2.5y window is expected on Stocks Basic.
 */
export function evaluateDataProviderHonesty(
  provider: "massive" | "fmp",
  observed: ProviderTierEntry | undefined,
  configuredPlan?: string | null
): DataProviderHonesty {
  if (!observed) {
    return { degraded: false, cause: "ok", detail: "no probe result" };
  }
  if (observed.signal === "no_key") {
    return { degraded: false, cause: "ok", detail: observed.reason };
  }
  // FMP direct access is retired — a leftover persisted row must not paint health red.
  if (provider === "fmp") {
    return { degraded: false, cause: "ok", detail: "FMP direct access retired" };
  }
  if (observed.signal === "probe_error") {
    return {
      degraded: true,
      cause: "probe_failure",
      detail: observed.reason || "provider probe failed"
    };
  }
  if (massivePlanAllowsDeepHistory(configuredPlan) && observedMassiveCapped(observed)) {
    return {
      degraded: true,
      cause: "tier_mismatch",
      detail:
        observed.reason ||
        `configured ${configuredPlan} should allow a ~2.5-year history window, but the probe saw ${observed.tier}`
    };
  }
  return { degraded: false, cause: "ok", detail: observed.reason };
}

/** True when any probed provider is broken or below the plan that was paid for. */
export function isDataProvidersDegraded(
  tiers: ProviderTierStatus,
  configuredPlans: Partial<Record<"massive" | "fmp", string | null | undefined>> = {}
): boolean {
  return (["massive", "fmp"] as const).some((provider) =>
    evaluateDataProviderHonesty(provider, tiers[provider], configuredPlans[provider]).degraded
  );
}

const DEFAULT_INTERVAL_HOURS = 24;
const PROBE_TIMEOUT_MS = 8000;
const DAY_MS = 86_400_000;

type Fetcher = typeof fetch;

function numericEnv(name: string, fallback: number, min = 0): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= min ? v : fallback;
}

function ymd(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function getProviderTierStatus(userId: string = "local"): ProviderTierStatus {
  const scoped = getInternalSetting<ProviderTierStatus>(providerTierStatusKey(userId));
  if (scoped) return scoped;
  // Backward-compat: before per-user scoping (pre-2026-07-06) the status lived on the single
  // shared key `providerTier:status`, which the "local" scheduler owned. Surface that legacy
  // blob for the "local" scope until the next tier check re-writes the per-user key, so readers
  // like /api/health don't regress to `{}` for up to 24h after deploy while a previously detected
  // degraded/free tier is still persisted.
  if (userId === "local") {
    return getInternalSetting<ProviderTierStatus>("providerTier:status") ?? {};
  }
  return {};
}

// ── Massive (Polygon) probe ───────────────────────────────────────────────────
// Free tier: 5 req/min + ~2 years of history. Paid: unlimited + full history. So a daily-aggregate
// query for a long-listed symbol (AAPL) at a window >2yr back returns data on paid and is empty/403
// on free. A 429 on a single call also means free (paid never rate-limits one call).
async function massiveAgg(key: string, from: string, to: string, fetcher: Fetcher): Promise<{ status: number; ok: boolean; results: number } | null> {
  const url = `${massiveApiBase()}/v2/aggs/ticker/AAPL/range/1/day/${from}/${to}?adjusted=true&limit=20`;
  try {
    const res = await fetcher(url, { cache: "no-store", headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (!res.ok) return { status: res.status, ok: false, results: 0 };
    const json = (await res.json().catch(() => null)) as { results?: unknown[] } | null;
    return { status: res.status, ok: true, results: Array.isArray(json?.results) ? json!.results!.length : 0 };
  } catch {
    return null;
  }
}

export async function probeMassiveTier(
  key: string | undefined,
  now: number = Date.now(),
  fetcher: Fetcher = fetch
): Promise<{ tier: ProviderTier; reason: string; signal: ProviderTierSignal }> {
  if (!key) return { tier: "unknown", reason: "no Massive key configured", signal: "no_key" };
  const recent = await massiveAgg(key, ymd(now - 10 * DAY_MS), ymd(now), fetcher);
  if (!recent) return { tier: "unknown", reason: "recent probe network/timeout error", signal: "probe_error" };
  if (recent.status === 429) return { tier: "free", reason: "429 on a single call (free tier is 5 req/min)", signal: "rate_limited_429" };
  if (!recent.ok) return { tier: "unknown", reason: `recent probe HTTP ${recent.status} (likely a bad key, not a tier signal)`, signal: "probe_error" };

  const oldFrom = ymd(now - Math.round(2.5 * 365) * DAY_MS);
  const oldTo = ymd(now - Math.round(2.5 * 365 - 6) * DAY_MS);
  const old = await massiveAgg(key, oldFrom, oldTo, fetcher);
  if (!old) return { tier: "unknown", reason: "history probe network/timeout error", signal: "probe_error" };
  if (old.status === 429 || old.status === 403) {
    return {
      tier: "free",
      reason: `plan-access probe: a ~2.5-year-old history window was blocked (HTTP ${old.status}) — free tier caps history at ~2 years (this checks plan access, not today's data freshness)`,
      signal: "history_cap_blocked"
    };
  }
  if (!old.ok) return { tier: "unknown", reason: `history probe HTTP ${old.status}`, signal: "probe_error" };
  if (old.results > 0) {
    return {
      tier: "paid",
      reason: "plan-access probe: a ~2.5-year-old history window was fetched successfully — confirms unlimited-history (paid) plan access; this checks plan capability, not today's data freshness",
      signal: "history_depth_confirmed"
    };
  }
  return {
    tier: "free",
    reason: "plan-access probe: a ~2.5-year-old history window came back empty — free tier caps history at ~2 years (this checks plan access, not today's data freshness)",
    signal: "history_cap_empty"
  };
}

// ── FMP probe ──────────────────────────────────────────────────────────────────
// Best-effort: FMP free vs Starter is distinguished by per-minute throughput + endpoint gating, not
// a plan endpoint. We only assert "free" on an explicit premium/upgrade/limit error (or a 429);
// otherwise "unknown" — FMP's action is notify-only (no auto-clamp), so a miss just skips an alert.
const FMP_FREE_SIGNAL = /exclusive|premium|upgrade|limit reach|special endpoint|not available under your/i;

export async function probeFmpTier(
  key: string | undefined,
  _fetcher: Fetcher = fetch
): Promise<{ tier: ProviderTier; reason: string; signal: ProviderTierSignal }> {
  // Owner 2026-08-04: never probe financialmodelingprep.com from this app.
  // FMP quota lives on Congress.Trade; ignore any local key presence.
  if (!key) return { tier: "unknown", reason: "FMP direct access retired (use Congress.Trade)", signal: "no_key" };
  return {
    tier: "unknown",
    reason: "FMP direct access retired in Socratic-Trade — no probe issued",
    signal: "no_key"
  };
}

// ── Orchestration ──────────────────────────────────────────────────────────────
export async function runProviderTierCheck(opts: { userId?: string; now?: number; fetcher?: Fetcher } = {}): Promise<ProviderTierStatus> {
  const userId = opts.userId ?? "local";
  const now = opts.now ?? Date.now();
  const fetcher = opts.fetcher ?? fetch;
  const nowIso = new Date(now).toISOString();
  const prev = getProviderTierStatus(userId);
  const next: ProviderTierStatus = {};

  const massiveKey = resolveApiKey("massive", userId);
  if (massiveKey) {
    const r = await probeMassiveTier(massiveKey, now, fetcher);
    next.massive = { tier: r.tier, at: nowIso, reason: r.reason, signal: r.signal };
  }
  // FMP tier probe retired with direct FMP access (owner 2026-08-04). Do not
  // resolve or call FMP keys from this app — Congress.Trade owns that quota.

  setInternalSetting(providerTierStatusKey(userId), next);
  audit("provider_tier_check", { massive: next.massive, fmp: next.fmp }, userId);

  // Alert only when the probe disagrees with the configured/paid plan (or recovers from that).
  // A deliberate Settings downgrade that matches the probe is healthy — not a lapse.
  for (const provider of ["massive", "fmp"] as const) {
    const cur = next[provider];
    if (!cur) continue;
    const prevTier = prev[provider]?.tier;
    const configuredPlan = lookupRegisteredPlanTier(provider) ?? null;
    const msg = tierChangeMessage(provider, prevTier, cur, configuredPlan);
    if (!msg) continue;
    await sendNotification(
      { type: "provider_degraded", title: msg.title, payload: { provider, fromTier: prevTier ?? "unknown", toTier: cur.tier, configuredPlan, reason: cur.reason, detectedAt: nowIso } },
      { userId, directBody: msg.body }
    ).catch(() => {});
  }
  return next;
}

/** Build the alert text for a tier transition, or null when it isn't worth alerting. */
export function tierChangeMessage(
  provider: "massive" | "fmp",
  prevTier: ProviderTier | undefined,
  cur: Pick<ProviderTierEntry, "tier" | "reason" | "signal">,
  configuredPlan?: string | null
): { title: string; body: string } | null {
  const honesty = evaluateDataProviderHonesty(provider, { ...cur, at: "" }, configuredPlan);
  const prevLooksCapped = prevTier === "free";
  const name = provider === "massive" ? "Massive (Polygon)" : "FMP";

  if (honesty.cause === "probe_failure") {
    // Transient unknown without a previous healthy read is not news; a working key that
    // stops answering is.
    if (prevTier === undefined) return null;
    return {
      title: `⚠️ ${name} data provider is not working`,
      body: `The ${name} probe failed.  The provider is not answering at the configured plan.\n\nDetection: ${cur.reason}`
    };
  }

  if (honesty.degraded && honesty.cause === "tier_mismatch") {
    if (prevTier === cur.tier) return null;
    const action = provider === "massive"
      ? "Massive's rate limit was auto-clamped to the free-safe 5/min to avoid 429 errors."
      : "FMP enrichment will degrade to the free 250-calls/day budget.";
    return {
      title: `⚠️ ${name} is not working at the paid ${configuredPlan} plan`,
      body: `The ${name} API key is responding below the configured ${configuredPlan} plan.  The paid subscription may have lapsed or the key may be on the wrong tier.\n\nDetection: ${cur.reason}\n\n${action}\n\nCheck your ${provider} billing/plan and confirm the key.`
    };
  }

  // Recovery: configured paid plan now matches the probe after a capped/failed read.
  if (
    !honesty.degraded &&
    cur.tier === "paid" &&
    prevLooksCapped &&
    massivePlanAllowsDeepHistory(configuredPlan)
  ) {
    return {
      title: `✅ ${name} data subscription is back on a PAID tier`,
      body: `The ${name} API key is now responding like a paid-tier key (${cur.reason}).  Full limits restored.`
    };
  }
  return null;
}

/** True roughly between 1am–6am US/Eastern, so the nightly check runs overnight (low-activity). */
function isOvernightEt(now: number): boolean {
  try {
    const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false }).format(new Date(now)));
    return Number.isFinite(hour) && hour >= 1 && hour < 6;
  } catch {
    return true; // if the runtime lacks tz data, don't block the check
  }
}

export function isProviderTierCheckDue(now: number = Date.now(), userId: string = "local"): boolean {
  const intervalMs = numericEnv("PROVIDER_TIER_CHECK_INTERVAL_HOURS", DEFAULT_INTERVAL_HOURS, 1) * 3600_000;
  const last = getInternalSetting<string>(lastCheckKey(userId));
  if (!last) return true;
  const lastMs = Date.parse(last);
  if (!Number.isFinite(lastMs)) return true;
  const elapsed = now - lastMs;
  if (elapsed < intervalMs) return false;
  // Past the interval: prefer to actually fire overnight, but never stall forever — if we've already
  // waited 1.5× the interval (e.g. the box was down all night), run at the next opportunity.
  return isOvernightEt(now) || elapsed >= intervalMs * 1.5;
}

/** Cadence-gated runner for the scheduler tick. Self-guarded; sets the watermark BEFORE probing so a
 *  busy tick loop can't double-run it. No-op until due (default every 24h). */
export async function runProviderTierCheckIfDue(now: number = Date.now()): Promise<void> {
  try {
    const userId = "local"; // provider tier check uses the env-level API keys
    if (!isProviderTierCheckDue(now, userId)) return;
    setInternalSetting(lastCheckKey(userId), new Date(now).toISOString());
    await runProviderTierCheck({ now, userId });
  } catch (err) {
    console.error("[provider-tier] tier check error:", err);
  }
}
