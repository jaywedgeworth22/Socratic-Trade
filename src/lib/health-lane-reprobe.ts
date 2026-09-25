/**
 * Periodic re-probe of Connections health lanes that are hard-STOPPED.
 *
 * Owner (2026-08-06): red STOPPED lanes must not sit forever until a human/agent
 * clears them. The scheduler opens a re-probe window (and runs a cheap live probe
 * when we know how) every 3–6 hours by default, or at a known quota reset when the
 * failure stamped one (daily AV midnight, etc.).
 *
 * Does NOT re-enable intentionally retired vendors (FMP/Quiver/UW).
 * Does NOT invent success — a failed re-probe logs an honest failure; only a
 * real probe success (or natural traffic success after the window opens) clears red.
 */

import {
  getServiceHealthSummaries,
  HEALTH_REASON_CONSECUTIVE_FAILURES,
  HEALTH_SOFT_FAILURE_PREFIX,
  isSoftHealthFailure,
  logApiHealth,
  type ServiceHealthSummary
} from "./db-health";
import { getDb } from "./db";
import { isIntentionalOffHealthService } from "./retired-direct-vendors";
import { resolveApiKey } from "./db-api-keys";
import {
  clearFilingApiKeyRejected,
  isFilingApiAuthStatus,
  isFilingApiKeyRejected,
  markFilingApiKeyRejected
} from "./filingapi-auth";

const DEFAULT_REPROBE_INTERVAL_MS = 4 * 60 * 60_000; // 4h (mid of 3–6h)
const MIN_REPROBE_INTERVAL_MS = 3 * 60 * 60_000;
const MAX_REPROBE_INTERVAL_MS = 6 * 60 * 60_000;
/** Scheduler admission: don't thrash the lane runner more often than this. */
const LANE_TICK_MS = 30 * 60_000;
const LAST_TICK_KEY = "healthLaneReprobe:lastTickAt";
const NEXT_LANE_PREFIX = "healthLaneReprobe:next:";

export type HealthReprobeOutcome =
  | "skipped_not_due"
  | "skipped_intentional_off"
  | "skipped_sibling_healthy"
  | "window_opened"
  | "probe_ok"
  | "probe_fail"
  | "probe_unsupported";

/** Backup health lane → primary that already serves the same reading. */
export const BACKUP_HEALTH_LANES: Record<string, string> = {
  "vix-yahoo": "vix-cboe"
};

/**
 * True when this backup lane's primary is serving.  Do not re-probe (and 429)
 * the backup while the primary is up — keep the backup for when the primary dies.
 */
export function backupLanePrimaryIsServing(
  backupService: string,
  summaries: Array<Pick<ServiceHealthSummary, "service" | "keySource" | "stoppedWorking">>
): boolean {
  const primary = BACKUP_HEALTH_LANES[backupService];
  if (!primary) return false;
  const row = summaries.find((s) => {
    if (s.service !== primary) return false;
    return s.keySource === "env" || s.keySource === "none" || s.keySource === null;
  });
  return row != null && row.stoppedWorking !== true;
}

export interface HealthReprobeLaneResult {
  service: string;
  keySource: string | null;
  outcome: HealthReprobeOutcome;
  reason?: string | null;
  detail?: string;
}

export interface HealthReprobeRunResult {
  ran: boolean;
  asOf: string;
  considered: number;
  results: HealthReprobeLaneResult[];
}

function envIntervalMs(): number {
  const raw = Number(process.env.HEALTH_LANE_REPROBE_INTERVAL_HOURS ?? "");
  if (Number.isFinite(raw) && raw > 0) {
    return Math.min(MAX_REPROBE_INTERVAL_MS, Math.max(MIN_REPROBE_INTERVAL_MS, raw * 3_600_000));
  }
  return DEFAULT_REPROBE_INTERVAL_MS;
}

function laneKey(service: string, keySource: string | null): string {
  return `${NEXT_LANE_PREFIX}${service}:${keySource ?? ""}`;
}

/** Exported for tests — when is this hard-stopped lane eligible for a re-probe attempt? */
export function isLaneDueForReprobe(
  summary: Pick<ServiceHealthSummary, "lastFailureTs" | "lastFailureError" | "stoppedReason">,
  nowMs: number,
  opts?: { nextDueIso?: string | null; intervalMs?: number }
): { due: boolean; reason: string; nextDueMs: number } {
  const intervalMs = opts?.intervalMs ?? envIntervalMs();
  const nextStored = opts?.nextDueIso ? Date.parse(opts.nextDueIso) : NaN;
  if (Number.isFinite(nextStored) && nowMs < nextStored) {
    return { due: false, reason: "before_scheduled_next", nextDueMs: nextStored };
  }

  // Known quota / "won't work until" instant from error text or cooldown stamp patterns.
  const until = parseKnownUnavailabilityUntil(summary.lastFailureError, nowMs);
  if (until != null && until > nowMs) {
    return { due: false, reason: "waiting_quota_or_known_until", nextDueMs: until };
  }

  const lastFailMs = summary.lastFailureTs ? Date.parse(summary.lastFailureTs) : NaN;
  const anchor = Number.isFinite(lastFailMs) ? lastFailMs : 0;
  const nextDueMs = Math.max(anchor + intervalMs, Number.isFinite(nextStored) ? nextStored : 0);
  if (nowMs < nextDueMs) {
    return { due: false, reason: "interval_not_elapsed", nextDueMs };
  }
  return { due: true, reason: "due", nextDueMs: nowMs + intervalMs };
}

/**
 * Parse a future "don't bother until" instant from known error shapes.
 * Returns null when unknown — caller uses the 3–6h interval.
 */
export function parseKnownUnavailabilityUntil(
  errorText: string | null | undefined,
  nowMs: number = Date.now()
): number | null {
  if (!errorText) return null;
  // Explicit ISO stamped by logApiHealth quotaResetAt path (callers may embed it).
  const iso = errorText.match(
    /(?:until|reset(?:s)?(?: at)?|cooldownUntil)[=:\s]+(\d{4}-\d{2}-\d{2}T[\d:.]+Z)/i
  );
  if (iso) {
    const ms = Date.parse(iso[1]);
    if (Number.isFinite(ms) && ms > nowMs) return ms;
  }
  // Alpha Vantage-style "25/day" — next America/New_York midnight is a safe bound.
  if (
    /25\/day|25 requests per day|daily (?:call )?budget|proactive daily call budget|Note\.? daily/i.test(
      errorText
    )
  ) {
    return nextAmericaNewYorkMidnightMs(nowMs);
  }
  // HTTP 429 with Retry-After seconds
  const retryAfter = errorText.match(/Retry-After:\s*(\d+)/i);
  if (retryAfter) {
    const sec = Number(retryAfter[1]);
    if (Number.isFinite(sec) && sec > 0) {
      return nowMs + Math.min(sec * 1000, 24 * 3600_000);
    }
  }
  // Permanent product death (403 delisted RapidAPI) — still re-probe every max interval
  // in case access returns; do not wait forever.
  return null;
}

/** Next calendar midnight in America/New_York as epoch ms (for AV daily caps). */
export function nextAmericaNewYorkMidnightMs(nowMs: number = Date.now()): number {
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23"
    });
    const parts = Object.fromEntries(
      fmt.formatToParts(new Date(nowMs)).filter((p) => p.type !== "literal").map((p) => [p.type, p.value])
    ) as Record<string, string>;
    // Build "tomorrow 00:00" NY by formatting now+1d at midnight via iterative approach:
    // take current NY date, add 1 day in UTC approx then snap.
    const y = Number(parts.year);
    const m = Number(parts.month);
    const d = Number(parts.day);
    // Noon UTC on "tomorrow" NY calendar day as a stable anchor, then binary-ish: use
    // Temporal-free approach — Date in UTC for NY date+1 at 05:00Z (EST) / 04:00Z (EDT) is wrong.
    // Simpler: walk hour-by-hour until NY day rolls.
    let t = nowMs;
    const dayOf = (ms: number) => {
      const p = Object.fromEntries(
        fmt.formatToParts(new Date(ms)).filter((x) => x.type !== "literal").map((x) => [x.type, x.value])
      ) as Record<string, string>;
      return `${p.year}-${p.month}-${p.day}`;
    };
    const today = dayOf(nowMs);
    // Jump ~20h then fine-tune
    t = nowMs + 20 * 3600_000;
    while (dayOf(t) === today) t += 3600_000;
    // Back up to first hour of new day
    while (dayOf(t - 3600_000) !== today && dayOf(t - 60_000) !== today) {
      // find start of new day: when dayOf changes from today
      break;
    }
    // Find exact transition
    let lo = nowMs;
    let hi = nowMs + 48 * 3600_000;
    while (hi - lo > 1000) {
      const mid = Math.floor((lo + hi) / 2);
      if (dayOf(mid) === today) lo = mid;
      else hi = mid;
    }
    return hi;
  } catch {
    return nowMs + 24 * 3600_000;
  }
}

/**
 * Soften the last N hard-failure rows so consecutive-failure STOPPED lifts and the
 * circuit breaker / natural traffic can try again. Does not invent ok=1.
 */
export function openHardStopReprobeWindow(
  service: string,
  keySource: string | null,
  opts?: { limit?: number; nowIso?: string }
): number {
  const db = getDb();
  const limit = opts?.limit ?? 5;
  const rows = db
    .prepare(
      `SELECT rowid, error_text FROM api_health_log
       WHERE service = ? AND key_source IS ? AND ok = 0
       ORDER BY ts DESC, rowid DESC
       LIMIT ?`
    )
    .all(service, keySource, limit) as Array<{ rowid: number; error_text: string | null }>;

  let changed = 0;
  const stamp = opts?.nowIso ?? new Date().toISOString();
  const update = db.prepare(`UPDATE api_health_log SET error_text = ? WHERE rowid = ?`);
  for (const row of rows) {
    const et = row.error_text ?? "";
    if (isSoftHealthFailure(et)) continue;
    update.run(
      `${HEALTH_SOFT_FAILURE_PREFIX}reprobe-window@${stamp}: ${et.slice(0, 200)}`,
      row.rowid
    );
    changed += 1;
  }
  return changed;
}

type ProbeFn = () => Promise<{ ok: boolean; detail?: string; latencyMs?: number }>;

/** Public JSON health paths on Usage Monitor. Exported for tests. */
export function usageMonitorProbeUrls(baseRaw?: string): string[] {
  const base = (
    baseRaw ||
    process.env.USAGE_MONITOR_BASE_URL ||
    process.env.USAGE_MONITOR_URL ||
    "https://usage.jays.services"
  ).replace(/\/$/, "");
  return [`${base}/api/ready`, `${base}/api/health`];
}

/** Cheap keyless / env probes for common stopped lanes. Unknown services only get a window open. */
export function probeFnForService(service: string): ProbeFn | null {
  const s = service.toLowerCase();
  if (s === "nasdaq-quote") {
    return async () => {
      const t0 = Date.now();
      const res = await fetch("https://api.nasdaq.com/api/quote/AAPL/info?assetclass=stocks", {
        headers: {
          Accept: "application/json",
          "User-Agent": "SocraticTradeHealth/1.0",
          Origin: "https://www.nasdaq.com",
          Referer: "https://www.nasdaq.com/"
        },
        signal: AbortSignal.timeout(12_000)
      });
      if (!res.ok) return { ok: false, detail: `HTTP ${res.status}`, latencyMs: Date.now() - t0 };
      return { ok: true, detail: "AAPL", latencyMs: Date.now() - t0 };
    };
  }
  if (s === "nasdaq-calendar") {
    return async () => {
      const t0 = Date.now();
      const d = new Date().toISOString().slice(0, 10);
      const res = await fetch(`https://api.nasdaq.com/api/calendar/earnings?date=${d}`, {
        headers: {
          Accept: "application/json",
          "User-Agent": "SocraticTradeHealth/1.0",
          Origin: "https://www.nasdaq.com",
          Referer: "https://www.nasdaq.com/"
        },
        signal: AbortSignal.timeout(12_000)
      });
      if (!res.ok) return { ok: false, detail: `HTTP ${res.status}`, latencyMs: Date.now() - t0 };
      return { ok: true, detail: d, latencyMs: Date.now() - t0 };
    };
  }
  if (s === "yahoo-finance" || s === "vix-yahoo") {
    return async () => {
      const t0 = Date.now();
      const path =
        s === "vix-yahoo"
          ? "https://query1.finance.yahoo.com/v8/finance/chart/%5EVIX?interval=1d&range=5d"
          : "https://query1.finance.yahoo.com/v8/finance/chart/AAPL?interval=1d&range=1d";
      const res = await fetch(path, {
        headers: { "User-Agent": "Mozilla/5.0" },
        signal: AbortSignal.timeout(12_000)
      });
      if (!res.ok) return { ok: false, detail: `HTTP ${res.status}`, latencyMs: Date.now() - t0 };
      return { ok: true, latencyMs: Date.now() - t0 };
    };
  }
  if (s === "vix-cboe") {
    return async () => {
      const t0 = Date.now();
      const res = await fetch("https://cdn.cboe.com/api/global/delayed_quotes/quotes/VIX.json", {
        signal: AbortSignal.timeout(12_000)
      });
      if (!res.ok) return { ok: false, detail: `HTTP ${res.status}`, latencyMs: Date.now() - t0 };
      return { ok: true, latencyMs: Date.now() - t0 };
    };
  }
  if (s === "filingapi") {
    return async () => {
      const key = resolveApiKey("filingapi")?.trim();
      // Optional lane: missing or known-dead key is a skip, not a health failure.
      if (!key) return { ok: true, detail: "no-key-skip" };
      if (isFilingApiKeyRejected(key)) return { ok: true, detail: "unauthorized-skip" };
      const t0 = Date.now();
      const res = await fetch("https://filingapi.dev/v1/company/AAPL", {
        headers: { Accept: "application/json", "X-API-Key": key },
        signal: AbortSignal.timeout(8_000)
      }).catch(() => null);
      if (!res) return { ok: false, detail: "fetch-failed", latencyMs: Date.now() - t0 };
      if (isFilingApiAuthStatus(res.status)) {
        markFilingApiKeyRejected(key);
        return { ok: true, detail: `HTTP ${res.status} skip`, latencyMs: Date.now() - t0 };
      }
      if (!res.ok) return { ok: false, detail: `HTTP ${res.status}`, latencyMs: Date.now() - t0 };
      clearFilingApiKeyRejected(key);
      return { ok: true, detail: "AAPL", latencyMs: Date.now() - t0 };
    };
  }
  if (s === "usage-monitor") {
    return async () => {
      const t0 = Date.now();
      const urls = usageMonitorProbeUrls();
      let lastStatus = 0;
      for (const url of urls) {
        // Never follow redirects: `/health` and `/` 307 to the login HTML (200),
        // which would look like a healthy monitor while the real JSON lives at
        // `/api/ready` and `/api/health`.
        const res = await fetch(url, {
          signal: AbortSignal.timeout(8000),
          redirect: "manual"
        }).catch(() => null);
        if (res?.ok) return { ok: true, detail: url, latencyMs: Date.now() - t0 };
        lastStatus = res?.status ?? lastStatus;
      }
      return { ok: false, detail: `HTTP ${lastStatus || "fetch-failed"}`, latencyMs: Date.now() - t0 };
    };
  }
  return null;
}

function isHardStopped(s: ServiceHealthSummary): boolean {
  return (
    s.stoppedWorking === true &&
    (s.stoppedReasonKind === "consecutive-failures" ||
      s.stoppedReason === HEALTH_REASON_CONSECUTIVE_FAILURES ||
      // Soft heuristics also deserve re-open so traffic can resume after transient outages.
      s.stoppedReasonKind === "no-success-this-hour" ||
      s.stoppedReasonKind === "no-success-ever" ||
      Boolean(s.stoppedReason))
  );
}

/**
 * Scheduler entry: reopen STOPPED health lanes on a 3–6h cadence (or at known quota reset).
 * Self-guarded; never throws into the tick.
 */
export async function runHealthLaneReprobeIfDue(
  nowMs: number = Date.now(),
  opts?: { force?: boolean }
): Promise<HealthReprobeRunResult> {
  const asOf = new Date(nowMs).toISOString();
  const empty: HealthReprobeRunResult = { ran: false, asOf, considered: 0, results: [] };

  try {
    if ((process.env.HEALTH_LANE_REPROBE_ENABLED ?? "on").toLowerCase() === "off") {
      return empty;
    }

    const { getInternalSetting, setInternalSetting, audit } = await import("./db");
    if (!opts?.force) {
      const lastTick = getInternalSetting<string>(LAST_TICK_KEY);
      const lastTickMs = lastTick ? Date.parse(lastTick) : NaN;
      if (Number.isFinite(lastTickMs) && nowMs - lastTickMs < LANE_TICK_MS) {
        return {
          ...empty,
          results: [{ service: "*", keySource: null, outcome: "skipped_not_due", detail: "tick" }]
        };
      }
    }
    setInternalSetting(LAST_TICK_KEY, asOf);

    let summaries: ServiceHealthSummary[] = [];
    try {
      summaries = getServiceHealthSummaries();
    } catch {
      return empty;
    }

    const candidates = summaries.filter(
      (s) => isHardStopped(s) && !s.intentionalOff && !isIntentionalOffHealthService(s.service)
    );

    const results: HealthReprobeLaneResult[] = [];
    const intervalMs = envIntervalMs();

    for (const s of candidates) {
      if (backupLanePrimaryIsServing(s.service, summaries)) {
        // Advance the reprobe clock so this backup lane is not re-evaluated on every scheduler
        // tick while its primary is healthy.  The lane stays red in Admin Connections (correct —
        // it IS stopped and we want it ready for failover), but we do not burn a real probe
        // attempt or generate any Sentry event until the next interval expires.
        setInternalSetting(laneKey(s.service, s.keySource), new Date(nowMs + intervalMs).toISOString());
        results.push({
          service: s.service,
          keySource: s.keySource,
          outcome: "skipped_sibling_healthy",
          reason: s.stoppedReason,
          detail: `primary ${BACKUP_HEALTH_LANES[s.service]} is serving; keep this backup for failover`
        });
        continue;
      }
      const nextDueIso = getInternalSetting<string>(laneKey(s.service, s.keySource));
      const due = isLaneDueForReprobe(s, nowMs, { nextDueIso, intervalMs });
      if (!due.due) {
        results.push({
          service: s.service,
          keySource: s.keySource,
          outcome: "skipped_not_due",
          reason: s.stoppedReason,
          detail: due.reason
        });
        continue;
      }

      // 1) Open window: soften hard consecutive streak so circuit breaker + natural calls can try.
      let softened = 0;
      try {
        softened = openHardStopReprobeWindow(s.service, s.keySource, { nowIso: asOf });
      } catch (err) {
        console.warn(
          `[health-lane-reprobe] open window failed for ${s.service}:`,
          err instanceof Error ? err.message : err
        );
      }

      // 2) Optional live probe for known keyless/ops services.
      const probe = probeFnForService(s.service);
      if (!probe) {
        setInternalSetting(laneKey(s.service, s.keySource), new Date(due.nextDueMs).toISOString());
        results.push({
          service: s.service,
          keySource: s.keySource,
          outcome: "window_opened",
          reason: s.stoppedReason,
          detail: softened ? `softened ${softened} rows; no automated probe` : "window open; no automated probe"
        });
        continue;
      }

      try {
        const outcome = await probe();
        if (outcome.ok) {
          logApiHealth({
            service: s.service,
            ok: true,
            latencyMs: outcome.latencyMs,
            keySource: s.keySource ?? undefined
          });
          // Extra successes so a single row isn't buried under a 5-fail lookback if something races.
          for (let i = 0; i < 2; i++) {
            logApiHealth({
              service: s.service,
              ok: true,
              latencyMs: outcome.latencyMs,
              keySource: s.keySource ?? undefined
            });
          }
          setInternalSetting(laneKey(s.service, s.keySource), new Date(nowMs + intervalMs).toISOString());
          results.push({
            service: s.service,
            keySource: s.keySource,
            outcome: "probe_ok",
            reason: s.stoppedReason,
            detail: outcome.detail
          });
        } else {
          // ALL probe failures are soft — not just the 429-shaped ones this used to match.
          //
          // A re-probe is SYNTHETIC traffic we generate specifically because the lane is already
          // known-red; it is not user traffic and it is not new evidence worth paging on. Logged
          // hard, each probe failure re-satisfied the alert gate and minted another Sentry event,
          // which re-armed the 6h alert cooldown, which kept the lane in the probe candidate set —
          // a self-sustaining loop that alerted forever on a lane nobody was actually calling.
          // Soft rows are still stored ok=0, so the lane keeps showing red in Admin Connections
          // and the probe cadence is unchanged; only the paging stops.
          logApiHealth({
            service: s.service,
            ok: false,
            latencyMs: outcome.latencyMs,
            errorText: outcome.detail,
            keySource: s.keySource ?? undefined,
            soft: true
          });
          const until = parseKnownUnavailabilityUntil(outcome.detail, nowMs);
          const next = until != null && until > nowMs ? until : nowMs + intervalMs;
          setInternalSetting(laneKey(s.service, s.keySource), new Date(next).toISOString());
          results.push({
            service: s.service,
            keySource: s.keySource,
            outcome: "probe_fail",
            reason: s.stoppedReason,
            detail: outcome.detail
          });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Same reasoning as the probe_fail branch above: a thrown probe is still a synthetic
        // probe, so it records red without paging.
        logApiHealth({
          service: s.service,
          ok: false,
          errorText: msg,
          keySource: s.keySource ?? undefined,
          soft: true
        });
        setInternalSetting(laneKey(s.service, s.keySource), new Date(nowMs + intervalMs).toISOString());
        results.push({
          service: s.service,
          keySource: s.keySource,
          outcome: "probe_fail",
          reason: s.stoppedReason,
          detail: msg
        });
      }
    }

    const acted = results.filter((r) =>
      r.outcome === "probe_ok" || r.outcome === "probe_fail" || r.outcome === "window_opened"
    );
    if (acted.length > 0) {
      try {
        audit(
          "health_lane_reprobe",
          {
            considered: candidates.length,
            acted: acted.length,
            results: acted
          },
          "local"
        );
      } catch {
        /* audit optional */
      }
    }

    return {
      ran: true,
      asOf,
      considered: candidates.length,
      results
    };
  } catch (err) {
    console.error(
      "[health-lane-reprobe] error:",
      err instanceof Error ? err.message : err
    );
    return empty;
  }
}

/** Test helper — deterministic lane key. */
export function healthReprobeLaneSettingKey(service: string, keySource: string | null): string {
  return laneKey(service, keySource);
}
