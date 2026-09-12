import "server-only";
import { createHash, randomUUID } from "crypto";
import { getDb } from "./db";
import { isLocalDbFaultMessage, noteLocalDbFault } from "./local-db-fault";
import { intentionalOffHealthReason, isIntentionalOffHealthService } from "./retired-direct-vendors";
import { isFilingApiAuthErrorText } from "./filingapi-auth-classify";
import { isTransientNetworkErrorText } from "./network-errors";

// `stoppedWorking` is set for a few distinct reasons (see getServiceHealthSummaries). This one is the
// "5 consecutive failures" condition — the only one strong enough to act on automatically (e.g. the
// enrichment circuit breaker), as opposed to the softer "no success yet this hour" heuristics that a
// single cold failure can trip. Exported so consumers key off the condition, not a brittle string.
export const HEALTH_REASON_CONSECUTIVE_FAILURES = "Last 5 consecutive calls all failed";

/**
 * Prefix written into `error_text` when a failure is an *expected limit* (HTTP 429, daily quota
 * cap, proactive budget exhaustion) rather than a broken integration. No schema column is needed:
 * consecutive-failure STOPPED and the enrichment circuit breaker ignore these rows so a free-tier
 * 25/day provider (or a Yahoo 429 burst) cannot paint the lane red "STOPPED" forever until a
 * success sneaks through. Soft yellow "active this hour, no success" may still apply.
 */
export const HEALTH_SOFT_FAILURE_PREFIX = "[expected-limit] ";

/**
 * True when an api_health_log failure row is a soft/expected limit (rate limit, daily cap, …).
 * Matches both the explicit prefix logApiHealth stamps for `soft: true`, and common free-text
 * shapes from older rows / call sites that forget the flag but still say "HTTP 429".
 */
export function isSoftHealthFailure(errorText: string | null | undefined): boolean {
  if (!errorText) return false;
  if (errorText.startsWith(HEALTH_SOFT_FAILURE_PREFIX)) return true;
  // Legacy / free-text shapes that should never hard-STOP a lane on their own.
  return (
    /\bHTTP 429\b/i.test(errorText) ||
    /\brate limit(?:ed|ing)?\b/i.test(errorText) ||
    /\btoo many requests\b/i.test(errorText) ||
    /\bdaily (?:call )?budget exhausted\b/i.test(errorText) ||
    /\bkey pool exhausted\b/i.test(errorText) ||
    /\b25\/day cap\b/i.test(errorText) ||
    /\b25 requests per day\b/i.test(errorText) ||
    /\bproactive daily call budget\b/i.test(errorText) ||
    // Caller-budget / AbortController cancellations.  GET /api/quote aborts the
    // enrichment cascade at 6s; nasdaq-calendar's per-day fetch aborts at 8s.
    // Those are expected and must not mint "<service> connection failed".
    /\bthis operation was aborted\b/i.test(errorText) ||
    /\bthe operation was aborted\b/i.test(errorText) ||
    /\bAbortError\b/i.test(errorText) ||
    /\bTimeoutError\b/i.test(errorText)
  );
}

/**
 * Prefix written into `error_text` when a failure is a **transport blip** — Node's `fetch()`
 * collapsing a dead keep-alive socket, a DNS hiccup, or an `ECONNRESET` into a bare
 * `"fetch failed"` with the real reason hidden on `err.cause`.
 *
 * This is a THIRD class, deliberately not folded into `HEALTH_SOFT_FAILURE_PREFIX`:
 *
 * - An **expected limit** (429, daily cap) is not a failure of the integration at all, so it is
 *   excluded from the hard consecutive-failure streak entirely.
 * - A **transport blip** might be the first second of a real outage.  It therefore still counts
 *   toward the hard streak — a provider that is genuinely unreachable must still page — but it
 *   does not get to page on its own the instant five of them land back to back.  Five failures
 *   twenty seconds apart is a blip; five failures still going ten minutes later is an outage.
 *
 * That distinction is the whole point: classifying these as plain soft would make a real network
 * outage silent, which is strictly worse than the noise this replaces.
 */
export const HEALTH_TRANSIENT_FAILURE_PREFIX = "[transient-network] ";

/**
 * True when an api_health_log failure row is a transport blip (see the prefix above).  An
 * expected-limit row is never also transient — soft classification wins, so a 429 keeps its
 * existing "does not count at all" treatment rather than being promoted into the streak.
 */
export function isTransientHealthFailure(errorText: string | null | undefined): boolean {
  if (!errorText) return false;
  if (errorText.startsWith(HEALTH_TRANSIENT_FAILURE_PREFIX)) return true;
  if (isSoftHealthFailure(errorText)) return false;
  return isTransientNetworkErrorText(errorText);
}

/**
 * How long a run of consecutive transport blips must keep failing before it is treated as a real
 * outage and captured at Sentry `error` level (which is what pages).  Below this, the lane is
 * captured at `warning`: the event is still recorded, Admin Connections still paints the lane,
 * but nobody is woken for a socket that died and came back.
 *
 * Ten minutes is chosen against the two shapes actually seen in prod.  A burst lane (a calendar
 * fetch that issues several requests seconds apart) produces its whole five-failure streak inside
 * one blip and stays a warning.  A low-frequency lane (an hourly probe) spreads five consecutive
 * failures over hours, so a genuine outage there clears this window on the very first alert and
 * pages exactly as it does today.
 */
export const HEALTH_TRANSIENT_ESCALATION_MS = 10 * 60_000;

/** `HEALTH_TRANSIENT_ESCALATION_MINUTES` override, falling back to the constant above. */
export function transientEscalationWindowMs(env: Record<string, string | undefined> = process.env): number {
  // `Number("")` is 0, so an empty/unset variable must be rejected BEFORE the numeric check —
  // otherwise a blank env var silently means "escalate every blip immediately".
  const text = (env.HEALTH_TRANSIENT_ESCALATION_MINUTES ?? "").trim();
  if (text === "") return HEALTH_TRANSIENT_ESCALATION_MS;
  const minutes = Number(text);
  if (Number.isFinite(minutes) && minutes >= 0) return minutes * 60_000;
  return HEALTH_TRANSIENT_ESCALATION_MS;
}

/**
 * FIFO retention for api_health_log: only the newest N rows per (service, key_source) lane survive
 * (enforced on every insert in logApiHealth). Exported because it is NOT just a storage detail — the
 * `callsLastHour`/`callsLast24h` window counts below are computed over this same capped table, so on
 * a busy lane they are a FLOOR, not a total, and any UI that prints them must say so (see
 * ServiceHealthSummary.laneLogCap). Note the equivalence that makes that cheap to detect: a window
 * count can only reach the cap when every retained row falls inside the window, which is exactly the
 * case where older rows may have been evicted out of it -- so `count === cap` is precisely the
 * "saturated" condition, no extra bookkeeping needed. (The residual ambiguity: a lane with exactly
 * `cap` calls and nothing evicted also reads as saturated. "500+" is still true there.)
 */
export const HEALTH_LOG_LANE_CAP = 500;

/** Durable ISO start of the current unbroken hard-failure run — survives api_health_log FIFO. */
export const HEALTH_HARD_STREAK_START_PREFIX = "health:hard-streak-start:";

export function hardStreakStartSettingKey(
  service: string,
  keySource: string | null,
  userId?: string | null
): string {
  const src = keySource ?? "none";
  if (src === "user" && userId != null) {
    return `${HEALTH_HARD_STREAK_START_PREFIX}${service}:user:${userId}`;
  }
  return `${HEALTH_HARD_STREAK_START_PREFIX}${service}:${src}`;
}

/** Durable hard-streak record — survives api_health_log FIFO for both start and class. */
export type DurableHardStreak = {
  startedTs: string;
  /** Sticky false once any hard non-transient failure is observed in the run. */
  entirelyTransient: boolean;
};

function readDurableHardStreak(key: string): DurableHardStreak | null {
  try {
    const row = getDb().prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as
      | { value: string }
      | undefined;
    if (!row?.value) return null;
    const parsed = JSON.parse(row.value) as unknown;
    // Legacy: bare ISO string from the first durable-start tip.
    if (typeof parsed === "string") {
      return Number.isFinite(Date.parse(parsed))
        ? { startedTs: parsed, entirelyTransient: true }
        : null;
    }
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as DurableHardStreak).startedTs === "string" &&
      typeof (parsed as DurableHardStreak).entirelyTransient === "boolean" &&
      Number.isFinite(Date.parse((parsed as DurableHardStreak).startedTs))
    ) {
      return parsed as DurableHardStreak;
    }
    return null;
  } catch {
    return null;
  }
}

function writeDurableHardStreak(key: string, streak: DurableHardStreak): void {
  try {
    const updated_at = new Date().toISOString();
    getDb()
      .prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      )
      .run(key, JSON.stringify(streak), updated_at);
  } catch {
    // Health path must never throw.
  }
}

function clearHardStreakStart(key: string): void {
  try {
    getDb().prepare(`DELETE FROM settings WHERE key = ?`).run(key);
  } catch {
    // Health path must never throw.
  }
}


/**
 * Which condition set `stoppedWorking` (see getServiceHealthSummaries). "consecutive-failures" is
 * the HARD one — the only one strong enough to act on automatically (`app/api/health` fails
 * liveness on it, data-providers.ts trips the enrichment breaker on it). The two "no-success"
 * kinds are SOFT heuristics that a single cold-start failure can trip, and consumers that count or
 * alarm on stopped lanes must weight them below the hard one rather than lumping all three into one
 * number. Carried alongside `stoppedReason` so a client that cannot import this module (the admin
 * connections page is "use client") discriminates on the kind instead of string-matching the prose.
 */
// "expected-limit" is a fourth, ANNOTATION-ONLY kind: never derived from the log here, only
// stamped by surfaces that know a lane is inside a known quota window (e.g. the Pinecone
// monthly write-unit breaker in pinecone-wu-breaker.ts). Clients must render it as SOFT
// (yellow expected-limit), never hard STOPPED.
export type HealthStoppedReasonKind = "consecutive-failures" | "no-success-ever" | "no-success-this-hour" | "expected-limit";
// RAG services (Pinecone, embed, rerank) already get their OWN explicit, operation-scoped alert
// from vector-db.ts's withRagApiHealth -> alertRagConnectionFailure (richer message: which
// operation failed, usage-limit escalation via alertUsageLimitHit, its own 1h cooldown). Without
// this exclusion, logApiHealth's automatic alertConnectionFailure below ALSO fires for the same
// failure (generic "<service> connection failed" text, its own separate 6h cooldown clock) — two
// uncoordinated alerts, ~1s apart, for one underlying event (confirmed 2026-07-07T14:01Z and
// 22:01Z in prod). Keep the richer vector-db.ts alert as the single source of truth for these
// lanes; every OTHER provider (finnhub, tiingo, twelvedata, etc.) has no dedicated alerter, so it
// still needs this generic automatic path.
//
// "voyage"/"voyage-rerank" are the pre-2026-07-19 lane names (still written by
// recordMissingRagKey's missing-API-key path, and possibly present in historical rows/branches in
// flight elsewhere) — kept for back-compat. "rag-embed"/"rag-rerank" are the provider-generic lane
// names withRagApiHealth now uses for actual embed/rerank call failures, so an OpenRouter/
// SiliconFlow-served operation gets the same dedicated-alerting exclusion Voyage always had.
const RAG_SERVICES_WITH_OWN_ALERTING = new Set(["pinecone", "voyage", "voyage-rerank", "rag-embed", "rag-rerank"]);

/**
 * Per-credential-lane health for the API circuit breaker. A "lane" is (service, keySource) — the SAME
 * granularity `getServiceHealthSummaries` and the whole health store already use — NOT per-user, so a
 * globally-dead env key trips once (not per user) and a user's own bad key trips only that user's lane
 * without stopping the shared env lane. `stoppedWorking` reuses the exact predicate below (kept in sync
 * with getServiceHealthSummaries): the last 5 calls all failed, or active-this-hour with no recent
 * success. Read-only; never throws (returns a not-stopped default on any DB error).
 */
export function getLaneHealth(
  service: string,
  keySource: string | null,
  userId?: string | null
): {
  stoppedWorking: boolean;
  reason: string | null;
  lastFailureTs: string | null;
  /** True only when the HARD streak holds AND every row in it is a transport blip. */
  transientStreak: boolean;
  /**
   * ts of the first failure in the ENTIRE consecutive hard-failure run (not merely the oldest of
   * the last-5 sample, and not truncated by HEALTH_LOG_LANE_CAP FIFO). Backed by a durable
   * settings key so a high-volume outage cannot reset the escalation clock. Set whenever the tip
   * row is a hard failure — including short runs (<5) — so sparse RAG lanes can escalate via
   * wall-clock before five rows accumulate. Null only when the tip is not a hard failure.
   */
  streakStartedTs: string | null;
} {
  try {
    const db = getDb();
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    // For a per-USER credential lane (keySource "user"), scope the failure streak to THIS user's own
    // history — otherwise one tenant's 5 failures would trip a provider-degraded alert for every other
    // user sharing the (service, "user") lane. Global/env/none lanes stay aggregate (no user predicate).
    const scopeUser = keySource === "user" && userId != null;
    const userClause = scopeUser ? " AND user_id IS ?" : "";
    const withUser = (params: unknown[]): unknown[] => (scopeUser ? [...params, userId] : params);
    // Pull error_text so expected-limit (soft) failures can be excluded from the HARD consecutive
    // streak — five 429s or a daily-cap row must not trip the enrichment circuit breaker.
    const last5 = db
      .prepare(
        `SELECT ok, error_text, ts FROM api_health_log WHERE service = ? AND key_source IS ?${userClause} ORDER BY ts DESC, rowid DESC LIMIT 5`
      )
      .all(...withUser([service, keySource])) as Array<{ ok: number; error_text: string | null; ts: string }>;
    const lastSuccess = db
      .prepare(`SELECT ts FROM api_health_log WHERE service = ? AND key_source IS ?${userClause} AND ok = 1 ORDER BY ts DESC, rowid DESC LIMIT 1`)
      .get(...withUser([service, keySource])) as { ts: string } | undefined;
    const lastFailure = db
      .prepare(`SELECT ts FROM api_health_log WHERE service = ? AND key_source IS ?${userClause} AND ok = 0 ORDER BY ts DESC, rowid DESC LIMIT 1`)
      .get(...withUser([service, keySource])) as { ts: string } | undefined;
    const callsLastHour = (
      db.prepare(`SELECT COUNT(*) as cnt FROM api_health_log WHERE service = ? AND key_source IS ?${userClause} AND ts >= ?`).get(...withUser([service, keySource]), hourAgo) as { cnt: number }
    ).cnt;

    let stoppedWorking = false;
    let reason: string | null = null;
    // `streakStartedTs` is the start of the ENTIRE consecutive hard-failure run (walk newest→oldest
    // past the last-5 sample until a success or soft row), so `now - streakStartedTs` is how long
    // the lane has been failing — the quantity that separates a burst of blips from an outage.
    // Anchoring only to last-5 would keep a busy lane forever inside the escalation window.
    // Importantly: set this whenever the tip is a hard failure, EVEN when the run is shorter than
    // five rows — sparse RAG lanes otherwise stay warning forever because they never fill last-5.
    let transientStreak = false;
    let streakStartedTs: string | null = null;
    // Whether EVERY hard row in the unbroken run (not just last-5) is a transport blip.
    // Computed on the same walk as streakStartedTs so a hard HTTP 401 that aged out of the
    // last-5 sample cannot be erased by later socket errors (Codex P2 on #3195).
    let runEntirelyTransient = false;
    const tipIsHardFailure =
      last5.length > 0 && last5[0].ok === 0 && !isSoftHealthFailure(last5[0].error_text);
    if (tipIsHardFailure) {
      // Walk the capped lane history newest-first; the last hard row before a success/soft break
      // is the start of this consecutive run (may be far older than last5 on a busy lane, or
      // shorter than 5 on a sparse one).
      const history = db
        .prepare(
          `SELECT ok, error_text, ts FROM api_health_log WHERE service = ? AND key_source IS ?${userClause} ORDER BY ts DESC, rowid DESC LIMIT ?`
        )
        .all(...withUser([service, keySource]), HEALTH_LOG_LANE_CAP) as Array<{
          ok: number;
          error_text: string | null;
          ts: string;
        }>;
      let runStart: string | null = null;
      let entirelyTransient = true;
      let sawHard = false;
      for (const row of history) {
        if (row.ok === 1 || isSoftHealthFailure(row.error_text)) break;
        sawHard = true;
        runStart = row.ts;
        if (!isTransientHealthFailure(row.error_text)) entirelyTransient = false;
      }
      const walkStart = runStart ?? last5[0]?.ts ?? null;
      const walkEntirelyTransient = sawHard && entirelyTransient;
      // Persist start + hard/transient class outside the FIFO health log (Codex P1/P2 on #3195).
      // Once written, never advance startedTs; entirelyTransient is sticky-false. Cleared only
      // from logApiHealth on success/soft — getLaneHealth stays read-only for circuit-breaker
      // preflight (no DELETE on healthy/soft/empty tips).
      const durableKey = hardStreakStartSettingKey(service, keySource, scopeUser ? userId : null);
      let durable = readDurableHardStreak(durableKey);
      if (!durable && walkStart) {
        durable = { startedTs: walkStart, entirelyTransient: walkEntirelyTransient };
        writeDurableHardStreak(durableKey, durable);
      } else if (durable && durable.entirelyTransient && !walkEntirelyTransient && sawHard) {
        durable = { startedTs: durable.startedTs, entirelyTransient: false };
        writeDurableHardStreak(durableKey, durable);
      }
      streakStartedTs = durable?.startedTs ?? walkStart;
      runEntirelyTransient = durable
        ? durable.entirelyTransient && walkEntirelyTransient
        : walkEntirelyTransient;
      // Sticky: if durable already recorded a hard non-transient, keep false even when FIFO
      // dropped that row from the retained walk.
      if (durable && !durable.entirelyTransient) runEntirelyTransient = false;
    }
    // HARD consecutive-failures: every one of the last 5 rows is a non-soft failure. Soft/expected
    // limits (429, daily cap) alone never set this reason — they may still surface as the softer
    // "no success this hour" heuristics below (yellow DEGRADED, not red STOPPED for circuit trips
    // that only key off HEALTH_REASON_CONSECUTIVE_FAILURES in the enrichment breaker).
    // Still requires length >= 5 even though streakStartedTs is set for shorter hard runs above.
    if (
      last5.length >= 5 &&
      last5.every((r) => r.ok === 0 && !isSoftHealthFailure(r.error_text))
    ) {
      stoppedWorking = true;
      reason = HEALTH_REASON_CONSECUTIVE_FAILURES;
      transientStreak = runEntirelyTransient;
    } else if (callsLastHour > 0 && !lastSuccess) {
      stoppedWorking = true;
      reason = "Active in past hour but no successful call ever";
    } else if (callsLastHour > 0 && lastSuccess && lastSuccess.ts < hourAgo) {
      stoppedWorking = true;
      reason = "Active in past hour but no success in 60 min";
    }
    return { stoppedWorking, reason, lastFailureTs: lastFailure?.ts ?? null, transientStreak, streakStartedTs };
  } catch {
    return { stoppedWorking: false, reason: null, lastFailureTs: null, transientStreak: false, streakStartedTs: null };
  }
}
// ── Types ─────────────────────────────────────────────────────────────────────

export interface ServiceHealthSummary {
  service: string;
  keySource: string | null;
  lastSuccessTs: string | null;
  lastSuccessLatencyMs: number | null;
  lastFailureTs: string | null;
  lastFailureError: string | null;
  /** Calls in the trailing hour / 24h, counted over the CAPPED log (see HEALTH_LOG_LANE_CAP): a
   *  value equal to `laneLogCap` means "at least this many", not "exactly this many". */
  callsLastHour: number;
  callsLast24h: number;
  stoppedWorking: boolean;
  stoppedReason: string | null;
  /** Which condition set `stoppedWorking` — hard vs soft; null when not stopped. Optional so the
   *  admin connections route can keep synthesizing never-used placeholder lanes as plain object
   *  literals (they have no log and no stop state). */
  stoppedReasonKind?: HealthStoppedReasonKind | null;
  /** Row-retention cap the two window counts were computed against, so a caller can render the
   *  saturated case honestly ("500+") without importing this module. Optional for the same
   *  placeholder-lane reason; a lane with no rows cannot be saturated. */
  laneLogCap?: number;
  /**
   * Product-retired vendor lane (FMP / Quiver / UW / FilingAPI). Admin Connections must
   * render these as muted OFF — not red STOPPED — and exclude them from the "N stopped"
   * header. Stamped by `getServiceHealthSummaries` from `retired-direct-vendors` so ops
   * snapshot and `/api/health` see the same OFF as Connections (leftover 401 rows must
   * not paint a retired vendor as a live outage).
   */
  intentionalOff?: boolean;
}

/**
 * Coolify `DB_BOOTSTRAP=live` restarts page every probe that 5xxs during the first minutes
 * (nasdaq-quote / vix / congress.trade / alpaca-broker). Those are boot, not an outage.
 * Tests and local/dev never set `DB_BOOTSTRAP=live`, so the existing hard-streak pages stay.
 */
export const CONNECTION_ALERT_STARTUP_GRACE_SECONDS = 5 * 60;

export function shouldSuppressConnectionAlertForStartup(
  processUptimeSeconds: number,
  env: Record<string, string | undefined> = process.env
): boolean {
  if (env.DB_BOOTSTRAP !== "live") return false;
  const raw = Number(env.HEALTH_ALERT_STARTUP_GRACE_SECONDS ?? CONNECTION_ALERT_STARTUP_GRACE_SECONDS);
  const grace = Number.isFinite(raw) && raw >= 0 ? raw : CONNECTION_ALERT_STARTUP_GRACE_SECONDS;
  return processUptimeSeconds < grace;
}

export interface HealthLogRow {
  id: string;
  service: string;
  ts: string;
  ok: number;
  latency_ms: number | null;
  error_text: string | null;
  key_source: string | null;
  user_id: string | null;
}

export interface ErrorPatternRow {
  id: string;
  service: string;
  fingerprint: string;
  error_text: string;
  first_seen: string;
  last_seen: string;
  count: number;
  key_source: string | null;
}

// ── Write ──────────────────────────────────────────────────────────────────────


type ApiHealthLogOpts = {
  service: string;
  ok: boolean;
  latencyMs?: number;
  errorText?: string;
  keySource?: string;
  userId?: string;
  quotaResetAt?: string;
  soft?: boolean;
};

const apiHealthBuffer: ApiHealthLogOpts[] = [];
let apiHealthFlushTimeout: ReturnType<typeof setTimeout> | null = null;

export function flushApiHealthBuffer(): void {
  if (apiHealthFlushTimeout) {
    clearTimeout(apiHealthFlushTimeout);
    apiHealthFlushTimeout = null;
  }
  if (apiHealthBuffer.length === 0) return;
  const batch = apiHealthBuffer.splice(0, apiHealthBuffer.length);
  try {
    const db = getDb();
    
    // Compute derived values outside transaction
    const processed = batch.map(opts => {
      const now = new Date().toISOString();
      const id = randomUUID();
      const keySource = opts.keySource ?? null;
      const userId = opts.userId ?? null;
      let errorText = opts.errorText ?? null;
      const filingApiAuthSoft =
        opts.service === "filingapi" && !opts.ok && isFilingApiAuthErrorText(errorText);
      if (!opts.ok && errorText && (opts.soft || filingApiAuthSoft || isSoftHealthFailure(errorText))) {
        if (!errorText.startsWith(HEALTH_SOFT_FAILURE_PREFIX)) {
          errorText = `${HEALTH_SOFT_FAILURE_PREFIX}${errorText}`;
        }
      } else if (!opts.ok && errorText && isTransientHealthFailure(errorText)) {
        if (!errorText.startsWith(HEALTH_TRANSIENT_FAILURE_PREFIX)) {
          errorText = `${HEALTH_TRANSIENT_FAILURE_PREFIX}${errorText}`;
        }
      }
      return { ...opts, now, id, keySource, userId, errorText, isSoft: isSoftHealthFailure(errorText ?? "") };
    });

    db.transaction(() => {
      const insertRow = db.prepare(`INSERT INTO api_health_log (id, service, ts, ok, latency_ms, error_text, key_source, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
      const updatePattern = db.prepare(`INSERT INTO api_health_error_patterns
               (id, service, fingerprint, error_text, first_seen, last_seen, count, key_source)
             VALUES (?, ?, ?, ?, ?, ?, 1, ?)
             ON CONFLICT(service, fingerprint, key_source) DO UPDATE SET
               last_seen = excluded.last_seen,
               count = count + 1`);
      const deleteCap = db.prepare(`DELETE FROM api_health_log
           WHERE service = ? AND key_source IS ?
             AND id NOT IN (
               SELECT id FROM api_health_log
               WHERE service = ? AND key_source IS ?
               ORDER BY ts DESC, rowid DESC
               LIMIT ${HEALTH_LOG_LANE_CAP}
             )`);

      const lanesToPrune = new Set<string>();

      for (const p of processed) {
        insertRow.run(p.id, p.service, p.now, p.ok ? 1 : 0, p.latencyMs ?? null, p.errorText, p.keySource, p.userId);
        lanesToPrune.add(`${p.service}::${p.keySource ?? ""}`);

        if (!p.ok && p.errorText) {
          const normalized = p.errorText.trim().toLowerCase().replace(/\s+/g, " ");
          const fingerprint = createHash("sha256").update(normalized).digest("hex").slice(0, 12);
          const patternId = randomUUID();
          const patternKeySource = p.keySource ?? "";
          updatePattern.run(patternId, p.service, fingerprint, p.errorText, p.now, p.now, patternKeySource);
        }
      }

      for (const lane of lanesToPrune) {
        const [service, keySourceRaw] = lane.split("::");
        const keySource = keySourceRaw === "" ? null : keySourceRaw;
        deleteCap.run(service, keySource, service, keySource);
      }
    })();

    // Post-transaction operations
    for (const p of processed) {
      const streakKey = hardStreakStartSettingKey(p.service, p.keySource, p.userId);
      if (p.ok || p.isSoft) {
        clearHardStreakStart(streakKey);
      }

      if (
        !p.ok &&
        p.errorText &&
        !RAG_SERVICES_WITH_OWN_ALERTING.has(p.service) &&
        !isIntentionalOffHealthService(p.service)
      ) {
        if (p.isSoft && !p.quotaResetAt) {
          // pure expected-limit with no known reset: no automatic alert
        } else {
          const lane = getLaneHealth(p.service, p.keySource, p.userId);
          if (p.quotaResetAt || lane.reason === HEALTH_REASON_CONSECUTIVE_FAILURES) {
            const escalationWindowMs = transientEscalationWindowMs();
            const streakStartedMs = lane.streakStartedTs ? Date.parse(lane.streakStartedTs) : NaN;
            const transientBlip =
              !p.quotaResetAt &&
              lane.reason === HEALTH_REASON_CONSECUTIVE_FAILURES &&
              lane.transientStreak &&
              (!Number.isFinite(streakStartedMs) || Date.now() - streakStartedMs < escalationWindowMs);
            void alertConnectionFailure(p.service, p.keySource, p.userId, p.errorText, {
              skipSentry: p.isSoft || /429|rate limit/i.test(p.errorText),
              cooldownUntil:
                p.quotaResetAt ??
                (transientBlip
                  ? new Date(
                      (Number.isFinite(streakStartedMs) ? streakStartedMs : Date.now()) + escalationWindowMs
                    ).toISOString()
                  : undefined),
              transientBlip
            });
          }
        }
      }
    }
  } catch (e) {
    // Health logging must never throw — swallow all errors
    // console.error(e);
  }
}

export function logApiHealth(opts: ApiHealthLogOpts): void {
  apiHealthBuffer.push(opts);
  if (!apiHealthFlushTimeout) {
    apiHealthFlushTimeout = setTimeout(flushApiHealthBuffer, 5000);
    apiHealthFlushTimeout.unref();
  }
}

// ── Read ───────────────────────────────────────────────────────────────────────

interface ServiceKeyLane { service: string; key_source: string | null }

function listHealthLanes(): ServiceKeyLane[] {
  try {
    const db = getDb();
    return db
      .prepare(`SELECT DISTINCT service, key_source FROM api_health_log ORDER BY service, key_source`)
      .all() as ServiceKeyLane[];
  } catch {
    return [];
  }
}

export function listHealthServices(): string[] {
  try {
    const db = getDb();
    const rows = db
      .prepare(`SELECT DISTINCT service FROM api_health_log ORDER BY service`)
      .all() as Array<{ service: string }>;
    return rows.map((r) => r.service);
  } catch {
    return [];
  }
}

export function getServiceHealthSummaries(): ServiceHealthSummary[] {
  try {
    const db = getDb();
    const lanes = listHealthLanes();
    const now = Date.now();
    const hourAgo = new Date(now - 60 * 60 * 1000).toISOString();
    const dayAgo = new Date(now - 24 * 60 * 60 * 1000).toISOString();

    return lanes.map(({ service, key_source: ks }) => {
      const lastSuccess = db
        .prepare(
          `SELECT ts, latency_ms FROM api_health_log
           WHERE service = ? AND key_source IS ? AND ok = 1
           ORDER BY ts DESC, rowid DESC LIMIT 1`
        )
        .get(service, ks) as { ts: string; latency_ms: number | null } | undefined;

      const lastFailure = db
        .prepare(
          `SELECT ts, error_text FROM api_health_log
           WHERE service = ? AND key_source IS ? AND ok = 0
           ORDER BY ts DESC, rowid DESC LIMIT 1`
        )
        .get(service, ks) as { ts: string; error_text: string | null } | undefined;

      const callsLastHour = (
        db
          .prepare(
            `SELECT COUNT(*) as cnt FROM api_health_log
             WHERE service = ? AND key_source IS ? AND ts >= ?`
          )
          .get(service, ks, hourAgo) as { cnt: number }
      ).cnt;

      const callsLast24h = (
        db
          .prepare(
            `SELECT COUNT(*) as cnt FROM api_health_log
             WHERE service = ? AND key_source IS ? AND ts >= ?`
          )
          .get(service, ks, dayAgo) as { cnt: number }
      ).cnt;

      // "Stopped working" detection — scoped per credential lane. Soft/expected-limit failures
      // (429, daily caps) do NOT count toward the hard consecutive-failures kind.
      const last5 = db
        .prepare(
          `SELECT ok, error_text FROM api_health_log
           WHERE service = ? AND key_source IS ?
           ORDER BY ts DESC, rowid DESC LIMIT 5`
        )
        .all(service, ks) as Array<{ ok: number; error_text: string | null }>;

      let stoppedWorking = false;
      let stoppedReason: string | null = null;
      let stoppedReasonKind: HealthStoppedReasonKind | null = null;

      if (
        last5.length >= 5 &&
        last5.every((r) => r.ok === 0 && !isSoftHealthFailure(r.error_text))
      ) {
        stoppedWorking = true;
        stoppedReason = HEALTH_REASON_CONSECUTIVE_FAILURES;
        stoppedReasonKind = "consecutive-failures";
      } else if (callsLastHour > 0 && !lastSuccess) {
        stoppedWorking = true;
        stoppedReason = "Active in past hour but no successful call ever";
        stoppedReasonKind = "no-success-ever";
      } else if (callsLastHour > 0 && lastSuccess && lastSuccess.ts < hourAgo) {
        stoppedWorking = true;
        stoppedReason = "Active in past hour but no success in 60 min";
        stoppedReasonKind = "no-success-this-hour";
      }

      const intentionalOff = isIntentionalOffHealthService(service);
      return {
        service,
        keySource: ks,
        lastSuccessTs: lastSuccess?.ts ?? null,
        lastSuccessLatencyMs: lastSuccess?.latency_ms ?? null,
        lastFailureTs: lastFailure?.ts ?? null,
        lastFailureError: lastFailure?.error_text ?? null,
        callsLastHour,
        callsLast24h,
        // Leftover 401/5xx rows after a vendor retire must not paint the lane STOPPED.
        stoppedWorking: intentionalOff ? false : stoppedWorking,
        stoppedReason: intentionalOff ? intentionalOffHealthReason(service) : stoppedReason,
        stoppedReasonKind: intentionalOff ? null : stoppedReasonKind,
        laneLogCap: HEALTH_LOG_LANE_CAP,
        intentionalOff: intentionalOff || undefined
      };
    });
  } catch {
    return [];
  }
}

/**
 * Hard outage only: last 5 calls all failed.  Soft "no success this hour" and
 * rate-limit rows are degraded signal, not a reason to paint the dependency down
 * or abandon a backup lane.
 */
export function isHardStoppedHealthSummary(
  summary: Pick<ServiceHealthSummary, "stoppedWorking" | "stoppedReasonKind" | "intentionalOff">
): boolean {
  if (summary.intentionalOff) return false;
  if (!summary.stoppedWorking) return false;
  return summary.stoppedReasonKind === "consecutive-failures";
}

// NOTE: `rowid DESC` tiebreaker — `ts` is ms-resolution, so rows written in the same millisecond
// otherwise return in arbitrary order and "the newest row" reads become nondeterministic (bit
// test/data-providers.test.ts's newest-row assertion, 2026-07-10). It must be `rowid` (implicit
// monotonic insertion order; `id TEXT PRIMARY KEY` does not alias it): `id` is a randomUUID, so
// ordering by it is a per-run coin flip, not a tiebreak.
export function getServiceHealthLog(
  service: string,
  limit = 100,
  offset = 0,
  keySource?: string | null
): HealthLogRow[] {
  try {
    const db = getDb();
    if (keySource !== undefined) {
      return db
        .prepare(
          `SELECT id, service, ts, ok, latency_ms, error_text, key_source, user_id
           FROM api_health_log
           WHERE service = ? AND key_source IS ?
           ORDER BY ts DESC, rowid DESC
           LIMIT ? OFFSET ?`
        )
        .all(service, keySource ?? null, limit, offset) as HealthLogRow[];
    }
    return db
      .prepare(
        `SELECT id, service, ts, ok, latency_ms, error_text, key_source, user_id
         FROM api_health_log
         WHERE service = ?
         ORDER BY ts DESC, rowid DESC
         LIMIT ? OFFSET ?`
      )
      .all(service, limit, offset) as HealthLogRow[];
  } catch {
    return [];
  }
}

export function getServiceErrorPatterns(
  service: string,
  keySource?: string | null
): ErrorPatternRow[] {
  try {
    const db = getDb();
    if (keySource !== undefined) {
      // Error patterns use "" sentinel (not NULL) so UNIQUE dedup works; map null → ""
      return db
        .prepare(
          `SELECT id, service, fingerprint, error_text, first_seen, last_seen, count, key_source
           FROM api_health_error_patterns
           WHERE service = ? AND key_source = ?
           ORDER BY last_seen DESC`
        )
        .all(service, keySource ?? "") as ErrorPatternRow[];
    }
    return db
      .prepare(
        `SELECT id, service, fingerprint, error_text, first_seen, last_seen, count, key_source
         FROM api_health_error_patterns
         WHERE service = ?
         ORDER BY last_seen DESC`
      )
      .all(service) as ErrorPatternRow[];
  } catch {
    return [];
  }
}

export function getAllErrorPatterns(): Record<string, ErrorPatternRow[]> {
  try {
    const db = getDb();
    const rows = db
      .prepare(
        `SELECT id, service, fingerprint, error_text, first_seen, last_seen, count, key_source
         FROM api_health_error_patterns
         ORDER BY last_seen DESC`
      )
      .all() as ErrorPatternRow[];
    const result: Record<string, ErrorPatternRow[]> = {};
    for (const row of rows) {
      // key_source is "" for no-key services (sentinel), never NULL in error_patterns
      const lane = `${row.service}:${row.key_source ?? ""}`;
      if (!result[lane]) result[lane] = [];
      result[lane].push(row);
    }
    return result;
  } catch {
    return {};
  }
}

// ── Connection Health & Storage Alerts ────────────────────────────────────────

const HEALTH_ALERT_COOLDOWN_PREFIX = "healthAlertSent";
// Default cooldown for an ordinary transient failure. A caller that knows the failure is a
// daily-quota exhaustion (persists until a known reset instant, not just "some hours") overrides
// this per-call via alertConnectionFailure's `opts.cooldownUntil` — see its doc comment.
const HEALTH_ALERT_COOLDOWN_MS = 6 * 60 * 60_000; // 6 hours

const STORAGE_ALERT_COOLDOWN_PREFIX = "storageAlertSent";
const STORAGE_ALERT_COOLDOWN_MS = 12 * 60 * 60_000; // 12 hours

function operatorAlertEmail(): string | undefined {
  return (
    process.env.USAGE_LIMIT_ALERT_EMAIL?.trim() ||
    process.env.ADMIN_ALERT_EMAIL?.trim() ||
    process.env.PRIMARY_USER_EMAIL?.trim() ||
    undefined
  );
}

/**
 * System-wide alerts go to every administrator via sendNotification (APNs is
 * auto-included when they have a registered device).  Pushover/email remain a
 * last-resort additionalDelivery only when no admin has a live device token and
 * those channels are not already in prefs — otherwise we double-send.
 */
async function deliverSystemAlertToAdmins(input: {
  type: "provider_degraded" | "storage_warning";
  title: string;
  body: string;
  payload: unknown;
  kind: string;
}): Promise<void> {
  const { getNotifyPrefs, getPolicy, listActiveDeviceTokens } = await import("./db");
  const { isPushoverDeliverable, loadNotifyConfig, notify, operatorPushoverUserKey } = await import("./notify");
  const { sendNotification } = await import("./notifications");
  const { listAdminUserIds } = await import("./admin-user-ids");

  const adminIds = listAdminUserIds();
  const config = loadNotifyConfig();
  const prefs = getNotifyPrefs("local");
  const alreadySendingPushover = prefs.channels.includes("pushover");
  const alreadySendingEmail = prefs.channels.includes("email") && Boolean(prefs.email.trim());
  let anyAdminHasApns = false;
  for (const id of adminIds) {
    try {
      if (listActiveDeviceTokens(id).length > 0) {
        anyAdminHasApns = true;
        break;
      }
    } catch {
      /* registry hiccup must not block the rest of delivery */
    }
  }

  const fallbackEmail = operatorAlertEmail();
  const additionalDelivery =
    anyAdminHasApns || alreadySendingPushover || alreadySendingEmail
      ? undefined
      : isPushoverDeliverable(prefs, config)
        ? () =>
            notify(
              "local",
              { title: input.title, body: input.body, kind: input.kind, data: input.payload },
              {
                config,
                prefs: {
                  ...prefs,
                  channels: ["pushover"],
                  pushoverTarget: operatorPushoverUserKey(prefs),
                  updatedAt: prefs.updatedAt
                }
              }
            )
        : fallbackEmail && config.email.resendKey && config.email.from
          ? () =>
              notify(
                "local",
                { title: input.title, body: input.body, kind: input.kind, data: input.payload },
                {
                  config,
                  prefs: {
                    ...prefs,
                    channels: ["email" as const],
                    email: fallbackEmail,
                    updatedAt: prefs.updatedAt
                  }
                }
              )
          : undefined;

  for (const userId of adminIds) {
    const policy = getPolicy(userId);
    await sendNotification(
      { type: input.type, title: input.title, payload: input.payload },
      {
        userId,
        policy,
        directBody: input.body,
        notifyDeps: { config },
        ...(userId === "local" && additionalDelivery ? { additionalDelivery } : {})
      }
    ).catch(() => {});
  }
}

async function captureHealthSentryMessage(
  level: "warning" | "error",
  message: string,
  context: Record<string, string | number | boolean | null | undefined>
): Promise<void> {
  if (!process.env.SENTRY_DSN) return;
  try {
    const mod = (await import("@sentry/nextjs")) as typeof import("@sentry/nextjs") & {
      default?: typeof import("@sentry/nextjs");
    };
    const captureMessage = mod.captureMessage ?? mod.default?.captureMessage;
    const withScope = mod.withScope ?? mod.default?.withScope;
    if (typeof captureMessage !== "function" || typeof withScope !== "function") return;
    withScope((scope) => {
      scope.setLevel(level);
      scope.setTag("component", "api-health");
      if (context.service) scope.setTag("health.service", String(context.service));
      if (context.keySource) scope.setTag("health.key_source", String(context.keySource));
      // Lets an alert rule route on the CLASS of failure, not the level alone: "hard" is a real
      // provider/auth outage, "transient-network" is a socket/DNS blip that has not escalated.
      if (context.failureClass) scope.setTag("health.failure_class", String(context.failureClass));
      // Group by the STABLE lane identifier, not by the rendered message. Sentry's default
      // fingerprint for captureMessage is the message text, and these messages embed a DISPLAY
      // name that drifts ("Voyage" vs "voyage", "OpenRouter" vs "OpenRouter embed") — one lane
      // fragmented into six issues that way. `service` is the health-log service id and never
      // drifts, so grouping survives any future title rewording.
      if (context.service) scope.setFingerprint(["api-health", String(context.service)]);
      scope.setContext("api-health", context);
      captureMessage(message);
    });
  } catch {
    // Observability must not affect trading control flow.
  }
}

/**
 * Raise the generic "<service> connection failed" provider-degraded alert for a lane.
 *
 * A failure whose text is one of OUR OWN SQLite fault shapes never gets here past the
 * isLocalDbFaultMessage guard in the body — defense in depth for every non-RAG lane; the
 * Pinecone/RAG lanes are classified earlier, at withRagApiHealth in vector-db.ts (prod bug
 * 2026-08-09, see docs/rollouts/2026-08-09-pinecone-lock-mislabel.md).
 */
export async function alertConnectionFailure(
  service: string,
  keySource: string | null,
  userId: string | null,
  errorText: string,
  // `cooldownUntil`: an ISO instant a caller passes when it KNOWS this failure won't clear
  // before then (e.g. Alpha Vantage's daily-quota exhaustion, cooldownUntil = next
  // America/New_York midnight reset) — the alert is suppressed until that instant instead of
  // the generic HEALTH_ALERT_COOLDOWN_MS window. Falls back to the generic window when absent,
  // unparsable, or already in the past, so a bad/stale value never shortens the cooldown to
  // "always re-alert" or silences alerts forever.
  opts?: {
    skipSentry?: boolean;
    cooldownUntil?: string;
    /**
     * This streak is made entirely of transport blips and has not yet lasted the escalation
     * window (see `HEALTH_TRANSIENT_ESCALATION_MS`). Record it — audit row plus a `warning`
     * Sentry capture — but do NOT page: no `error` level, no operator push. It escalates on its
     * own if the lane keeps failing past the window.
     */
    transientBlip?: boolean;
  }
): Promise<void> {
  try {
    const targetUserId = userId || "local";
    const actualKeySource = keySource || "none";
    // Local SQLite contention/misconfiguration incidental to a provider call is OUR fault, not the
    // vendor's. Never let it mint a "<service> connection failed" push; record it under its real
    // cause instead (audit row + threshold-gated "local database contention" advisory).
    if (isLocalDbFaultMessage(errorText)) {
      await noteLocalDbFault({ lane: service, operation: "connection health", message: errorText, userId: targetUserId });
      return;
    }
    // process.uptime() — do not import runtime-health here.  That module loads
    // node:fs / node:http / node:path, and db.ts re-exports this file into client
    // graphs (PR #2798 verify-hosted webpack UnhandledSchemeError).
    if (shouldSuppressConnectionAlertForStartup(process.uptime())) {
      return;
    }
    // Cool down GLOBAL lanes (env/none) by service+source only — NOT per-user. In a multi-user outage
    // each tenant's failure hits the SAME global dependency, so a userId-scoped cooldown key would let
    // every tenant mint its own cooldown row and re-alert the admin every 6h for the one shared outage.
    // Only per-USER credential lanes ("user") key the cooldown by userId (each user's own key/alert).
    //
    // Transient-blip warnings use a SEPARATE `:transient` suffix so their short escalation-window
    // cooldown cannot suppress a later hard failure (HTTP 401/500) on the same lane. Hard / escalated
    // captures keep the unsuffixed key and ignore any active transient cooldown.
    const baseKey =
      actualKeySource === "user"
        ? `${HEALTH_ALERT_COOLDOWN_PREFIX}:${service}:${actualKeySource}:${targetUserId}`
        : `${HEALTH_ALERT_COOLDOWN_PREFIX}:${service}:${actualKeySource}`;
    const key = opts?.transientBlip ? `${baseKey}:transient` : baseKey;

    // Cooldown check. The stored setting value is the "suppressed until" instant (not "last sent
    // at"): this lets a quota-exhaustion caller stretch the window arbitrarily far (to the
    // provider's actual daily reset) while an ordinary transient failure keeps the fixed 6h
    // window, using the exact same comparison. Audit + Sentry stay gated behind this SAME check
    // as the notification (not split into an always-fires audit path) — the per-request
    // api_health_log/error-pattern rows above already record every occurrence for forensics, so
    // an audit row per occurrence here would just duplicate that without adding signal; only the
    // repeat-alert noise is the target of this cooldown.
    const { getInternalSetting, setInternalSetting, audit } = await import("./db");
    const now = Date.now();
    const last = getInternalSetting<string>(key);
    if (last) {
      const suppressedUntilMs = Date.parse(last);
      if (Number.isFinite(suppressedUntilMs) && now < suppressedUntilMs) return;
    }
    const requestedCooldownMs = opts?.cooldownUntil ? Date.parse(opts.cooldownUntil) : NaN;
    const cooldownUntilMs =
      Number.isFinite(requestedCooldownMs) && requestedCooldownMs > now
        ? requestedCooldownMs
        : now + HEALTH_ALERT_COOLDOWN_MS;
    setInternalSetting(key, new Date(cooldownUntilMs).toISOString());

    const isGlobal = actualKeySource !== "user";
    const title = `${service} connection failed`;
    const body = `Connection to ${service} (${actualKeySource} lane) failed: ${errorText}`;

    const payload = {
      service,
      keySource: actualKeySource,
      userId: targetUserId,
      errorText,
      global: isGlobal
    };

    // Log audit event
    audit("connection_health_alert", payload, targetUserId);

    // Send Sentry event. A transport blip is warning-level on every lane, global or not — the
    // level is what PagerDuty routes on, so this is the difference between "recorded" and "paged".
    if (!opts?.skipSentry) {
      await captureHealthSentryMessage(opts?.transientBlip || !isGlobal ? "warning" : "error", title, {
        service,
        keySource: actualKeySource,
        userSpecific: !isGlobal,
        failureClass: opts?.transientBlip ? "transient-network" : "hard",
        reason: errorText
      });
    }

    // Not yet an outage: the audit row and the warning capture above are the whole response.
    if (opts?.transientBlip) return;

    if (isGlobal) {
      await deliverSystemAlertToAdmins({
        type: "provider_degraded",
        title,
        body,
        payload,
        kind: "provider_degraded"
      });
    } else {
      // User-key failures: Route to user notifications only. Same real-toggle delivery as above.
      const { sendNotification } = await import("./notifications");
      const { getPolicy } = await import("./db");
      const policy = getPolicy(targetUserId);
      await sendNotification(
        { type: "provider_degraded", title, payload },
        { userId: targetUserId, policy, directBody: body }
      ).catch(() => {});
    }
  } catch (err) {
    // Health alerts must never throw
    console.error("Health alert error:", err);
  }
}

export async function alertStorageWarning(warningType: string, message: string): Promise<void> {
  try {
    const key = `${STORAGE_ALERT_COOLDOWN_PREFIX}:${warningType}`;
    const { getInternalSetting, setInternalSetting, audit } = await import("./db");
    const last = getInternalSetting<string>(key);
    if (last && Date.now() - Date.parse(last) < STORAGE_ALERT_COOLDOWN_MS) return;
    setInternalSetting(key, new Date().toISOString());

    const title = `Storage Warning: ${warningType.replace(/_/g, " ")}`;
    const body = message;
    const payload = { warningType, message };

    audit("storage_warning_alert", payload, "local");

    await deliverSystemAlertToAdmins({
      type: "storage_warning",
      title,
      body,
      payload,
      kind: "storage_warning"
    });
  } catch {
    // never throw on warnings
  }
}
