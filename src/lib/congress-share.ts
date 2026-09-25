// Outbound data-share to congress.trade (App A) — server-only.
//
// App A (congress.trade, a Cloudflare Worker backed by a DB) is the shared system-of-record
// for company reference + daily-close data. Both apps consume Financial Modeling Prep (FMP),
// which has a shared daily quota. To keep App A from spending that quota, this app forwards the
// company-reference + daily-close + S&P-500 data it ALREADY has to App A's idempotent import
// endpoint. App A upserts securities_ref / spx_eod / price_eod and recomputes per-trade anchors.
//
// NOTE on sourcing: this app does NOT fetch FMP /v3/profile or /v3/historical-price-full — its
// only FMP use is the fundamentals enrichment cascade (ratios/grades/insider/senate). The refs +
// closes we forward come from the app's existing sources (NASDAQ screener enrichment for refs;
// the history cascade Massive → Tradier → Marketstack → Yahoo → Stooq for closes). App A just
// needs the DATA, not FMP-sourced data, so sharing it still conserves App A's FMP quota.
//
// Safety: default OFF. Automatic forwarding (scan-refs + the nightly batch) runs only when
// CONGRESS_TRADE_TOKEN is set AND CONGRESS_SHARE_ENABLED is on. The admin route can trigger a
// manual run with just the token. The token is a server-only secret — never exposed to the browser.

import {
  API_PATHS,
  APP_B_ORIGIN_TAG,
  type PriceClose,
  type PriceSeries,
  type InsiderRow,
  type ShortVolumeRow,
  type FundamentalRow,
  type AnalystRow,
  type SharePayload,
  classifyTickerAlias,
  resolveContinuousTicker,
  resolveTickerAlias,
  SecurityRefInputSchema,
  PriceSeriesSchema,
  PriceCloseSchema,
  InsiderRowSchema,
  ShortVolumeRowSchema,
  FundamentalRowSchema,
  AnalystRowSchema,
  TradeEventRowSchema,
} from "@jaywedgeworth22/congress-trading-shared";
import {
  assertOperationLeaseOwnership,
  OPERATION_LEASE_GROUPS,
  runWithOperationLease,
  throwIfOperationLeaseCancelled,
  type OperationLeaseAware,
  type OperationLeaseClaim
} from "./operation-lease";
import { createHash } from "crypto";
import {
  audit,
  deleteInternalSetting,
  getInternalSetting,
  getPolicy,
  listUsers,
  listWatchlistSymbols,
  setInternalSetting
} from "./db";
import { HEALTH_TRANSIENT_FAILURE_PREFIX, logApiHealth } from "./db-health";
import { isTransientNetworkError } from "./network-errors";
import { createDurableMap } from "./durable-state";
import { fetchDailyOHLC, toBusinessDay } from "./history";
import { INDEX_UNIVERSES, symbolsForPolicyUniverse } from "./index-universes";
import type { OHLCBar } from "./indicators";
import { fetchGroupedDailyBarsRange } from "./market-signals/massive-s3";
import { normalizeSymbol } from "./money";
import type { MarketQuote, MarketScan } from "./types";
import { getFinraDataset, getInsiderDataset, getInsiderSignals, getShortVolumeSignals } from "./web-sources";
import { fetchNasdaqScreenerResponse } from "./nasdaq-screener-fetch";
const DEFAULT_BASE_URL = "https://congress.trade";
const DEFAULT_TIMEOUT_MS = 30_000; // App A upserts + recomputes per-trade perf anchors per call — give it room
const LAST_DAILY_RUN_KEY = "congress-share:lastDailyRunDate";
const LAST_TOKEN_PROBE_KEY = "congress-share:lastTokenProbeTs";

/** Minimum interval between scheduled token probes — matches the auth breaker cooldown so
 *  a probe fires roughly once per breaker window even on long-running instances. */
const TOKEN_PROBE_INTERVAL_MS = 6 * 60 * 60_000; // 6h

/**
 * Auth circuit-breaker (prod incident 2026-09-07): HTTP 401/403 from App A means the shared
 * bearer token is wrong on one side — a PERMANENT condition until an operator rotates/resyncs it,
 * not a transient blip. Before this breaker, every caller kept retrying at its normal cadence
 * forever: the scan-hook throttle is rolled back on ANY failure (so the very next scan re-POSTs),
 * and the nightly batch's own 60-minute failure backoff (isCongressDailyShareDue) still let a
 * single "due" run fan out into a dozen-plus chunked POSTs (refs/spx/insider/shortVolume/prices
 * are independent bounded requests — see the chunking note above runCongressDailyShareUnlocked's
 * payload loop), each one failing the same way. That combination produced 3,096 identical
 * `[congress-share] import failed: HTTP 401` log lines over nine days
 * (2026-08-29 through 2026-09-07) with no Sentry capture, no health signal, and no brake.
 *
 * This breaker is keyed ONE way for the whole module — every caller funnels through
 * `shareWithCongressTrade`, so tripping it here stops the scan-hook, the in-flight nightly-batch
 * loop's REMAINING chunks, and the next nightly run alike, without touching any of their own
 * separate gating. A non-auth failure (5xx/timeout/network) does NOT trip it — those stay on the
 * existing per-caller backoff, since they may well be transient.
 */
const AUTH_BREAKER_KEY = "congress-share:authBreaker";

interface CongressAuthBreakerState {
  /** Epoch ms the breaker stays tripped until; a fresh real attempt is allowed once now >= this. */
  untilMs: number;
  /** The HTTP-error text from the real 401/403 that tripped the breaker, replayed into the health
   *  log (see below) for every call the breaker silently absorbs, so the failure stays diagnosable
   *  without a live retry. */
  lastError: string;
  /** Non-secret fingerprint (sha256 prefix) of the CONGRESS_TRADE_TOKEN that tripped the breaker.
   *  An operator resyncing the token before the cooldown elapses is exactly the recovery action
   *  this breaker exists to wait for — without this, the durable breaker state has no identity
   *  for the token that failed, so a resynced token still sits blocked for the rest of the
   *  cooldown (a container restart does not help either: the settings DB is persistent). */
  tokenFingerprint: string;
  /** Epoch ms until which the single half-open probe (see claimCongressAuthBreakerProbe below)
   *  is claimed by an in-flight caller. Self-expires (bounded by the request timeout) if the
   *  claiming caller crashes without clearing or re-tripping the breaker. */
  probeClaimedUntilMs?: number;
}

function authBreakerCooldownMs(): number {
  const v = Number(process.env.CONGRESS_SHARE_AUTH_BREAKER_COOLDOWN_MS ?? 6 * 60 * 60_000); // 6h default
  return Number.isFinite(v) && v > 0 ? v : 6 * 60 * 60_000;
}

/** How long a claimed half-open probe blocks other callers — bounded by the same timeout the
 *  probe's own fetch is bounded by, so a crashed/hung probe cannot wedge the claim forever. */
function authProbeClaimWindowMs(): number {
  return Number(process.env.CONGRESS_SHARE_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
}

/** Non-secret token fingerprint (length-independent, no value ever printed) — same method used
 *  to diagnose the 2026-09-07 token-drift incident: sha256 prefix only. */
function fingerprintCongressToken(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

function readCongressAuthBreakerState(): CongressAuthBreakerState | undefined {
  try {
    return getInternalSetting<CongressAuthBreakerState>(AUTH_BREAKER_KEY);
  } catch {
    return undefined; // fail open — never let breaker-state reads block a legitimate send
  }
}

/** The breaker state, but ignoring (and eagerly clearing) an entry keyed to a DIFFERENT token
 *  than the one currently configured. Handles the operator-resync recovery path: without this,
 *  a breaker tripped by the old broken token keeps blocking the newly-resynced good token for
 *  the rest of the cooldown, and a container restart does not help since the settings DB (where
 *  the breaker lives) is persistent. */
function activeCongressAuthBreakerState(token: string | undefined): CongressAuthBreakerState | undefined {
  const state = readCongressAuthBreakerState();
  if (!state) return undefined;
  if (!token || state.tokenFingerprint !== fingerprintCongressToken(token)) {
    clearCongressAuthBreaker();
    return undefined;
  }
  return state;
}

/** True while a prior HTTP 401/403 has the breaker tripped (cooldown not yet elapsed) for the
 *  CURRENTLY configured token. A breaker tripped by a since-resynced token is treated as cleared. */
export function isCongressAuthBreakerTripped(now: number = Date.now()): boolean {
  const state = activeCongressAuthBreakerState(congressTradeToken());
  return state !== undefined && now < state.untilMs;
}

function tripCongressAuthBreaker(now: number, errorText: string, token: string): void {
  try {
    setInternalSetting(AUTH_BREAKER_KEY, {
      untilMs: now + authBreakerCooldownMs(),
      lastError: errorText,
      tokenFingerprint: fingerprintCongressToken(token)
    });
  } catch {
    // best-effort; a failed write just means the next call probes sooner than intended
  }
}

/** Atomically claims the single half-open probe slot once the cooldown has elapsed, so
 *  overlapping callers (scan-hook + nightly batch) don't each treat the expired cooldown as
 *  their own independent probe and recreate a burst of 401/403 requests. The read-then-write
 *  below has no `await` between them, so it is atomic against any other same-process caller
 *  reaching this same half-open window concurrently. Returns false when another caller already
 *  holds the claim. */
function claimCongressAuthBreakerProbe(now: number, state: CongressAuthBreakerState): boolean {
  try {
    const fresh = readCongressAuthBreakerState() ?? state;
    if (fresh.probeClaimedUntilMs !== undefined && now < fresh.probeClaimedUntilMs) return false;
    setInternalSetting(AUTH_BREAKER_KEY, { ...fresh, probeClaimedUntilMs: now + authProbeClaimWindowMs() });
    return true;
  } catch {
    return true; // fail open — never let breaker bookkeeping block a legitimate probe
  }
}

function clearCongressAuthBreaker(): void {
  try {
    deleteInternalSetting(AUTH_BREAKER_KEY);
  } catch {
    // best-effort
  }
}

/** Test seam: reset the auth breaker between tests (mirrors resetCongressRefThrottle below). */
export function resetCongressAuthBreakerForTests(): void {
  clearCongressAuthBreaker();
}

/**
 * Module-level single-flight for the nightly batch (P2.4 / activity-feed audit §1.4).
 * Without this, a long run can still be re-entered from the 60s scheduler tick even when the
 * failure backoff has not yet stamped (or while the prior promise is still posting).
 * Survives hot-reload via globalThis; cleared when the in-flight promise settles.
 */
const congressDailyShareInFlightHost = globalThis as unknown as {
  __congressDailyShareInFlight?: Promise<OperationLeaseAware<CongressDailyShareSummary> | null>;
};

/**
 * Origin tag stamped on every outbound payload so the counterpart's receiver can recognize App B's
 * own rows and never echo them back into our store (the no-echo-loop guard). Our OWN inbound receiver
 * (POST /api/admin/securities/import) skips any payload carrying this origin. See docs/congress-trade-app-b-reply.md §1.3.
 * Re-exported from @jaywedgeworth22/congress-trading-shared as APP_B_ORIGIN_TAG.
 */
export const APP_B_ORIGIN = APP_B_ORIGIN_TAG;

// Per-POST sizing. The endpoint accepts up to ~2,000 tickers / ~20,000 closes, but App A's per-call
// work (row upserts + per-trade performance recompute) made big chunks blow the timeout in prod, so we
// keep each POST small and bounded — many small POSTs beat one timing-out megabatch.
const MAX_REFS_PER_POST = 2000; // refs are tiny (no closes) — fine in bulk
const MAX_TICKERS_PER_POST = 100; // bound per-POST perf recompute on App A
const CLOSE_BUDGET_PER_POST = 5_000; // bound per-POST upload + upsert
const MAX_ROWS_PER_POST = 500; // insider / short-volume rows per POST
const DEFAULT_MAX_CLOSES_PER_TICKER = 260; // ~1y; App A backfills deeper history itself

// ── Configuration / gating ────────────────────────────────────────────────────

/** The App A bearer token (ADMIN_TOKEN or INGEST_TOKEN). Server-only; trimmed; empty → undefined. */
export function congressTradeToken(): string | undefined {
  const t = (process.env.CONGRESS_TRADE_TOKEN ?? "").trim();
  return t.length > 0 ? t : undefined;
}

function congressTradeBaseUrl(): string {
  const base = (process.env.CONGRESS_TRADE_BASE_URL ?? DEFAULT_BASE_URL).trim();
  return base.replace(/\/+$/, "");
}

function flagOn(value: string | undefined): boolean {
  const v = (value ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/**
 * Whether AUTOMATIC forwarding (the scan-refs hook + the nightly batch) is enabled. Requires both
 * the token AND an explicit CONGRESS_SHARE_ENABLED opt-in, so a configured token alone never starts
 * silently pushing data off-box. The admin route bypasses the flag (token-only) for manual ops.
 */
export function isCongressShareAutoEnabled(): boolean {
  return congressTradeToken() !== undefined && flagOn(process.env.CONGRESS_SHARE_ENABLED);
}

/**
 * Whether to include fundamentals[]/analyst[] in the scan-hook push. Held OFF by default: App A's #46
 * tables don't exist until its migration runs, and pushing those rows earlier just errors them on App A
 * (the rest of the import is unaffected). Flip this on only after App A confirms #46 is applied.
 */
export function congressFundamentalsShareEnabled(): boolean {
  return flagOn(process.env.CONGRESS_SHARE_FUNDAMENTALS_ENABLED);
}

function maxDailyTickers(): number {
  // Caps the nightly UNIVERSE (chunked into MAX_TICKERS_PER_POST-sized POSTs), not the per-POST size.
  const v = Number(process.env.CONGRESS_SHARE_MAX_TICKERS ?? 2000);
  return Number.isFinite(v) && v > 0 ? Math.min(Math.floor(v), 2000) : 2000;
}

/** Per-symbol close cap for the nightly price push — bounds payload (App A backfills deeper itself). */
function maxClosesPerTicker(): number {
  const v = Number(process.env.CONGRESS_SHARE_MAX_CLOSES_PER_TICKER ?? DEFAULT_MAX_CLOSES_PER_TICKER);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : DEFAULT_MAX_CLOSES_PER_TICKER;
}

/** How many App A price-need tickers to pull per nightly drain (paginated on App A). */
function priceNeedsLimit(): number {
  const v = Number(process.env.CONGRESS_SHARE_PRICE_NEEDS_LIMIT ?? 500);
  return Number.isFinite(v) && v > 0 ? Math.min(Math.floor(v), 2000) : 500;
}

/** App A export path for tickers still lacking history for congressional performance. */
const PRICE_NEEDS_PATH = "/api/export/price-needs";

export interface CongressPriceNeedTicker {
  ticker: string;
  oldestTradeDate?: string;
  needsDeepHistory?: boolean;
  reasons?: string[];
}

export interface CongressPriceNeedsResponse {
  tickers: CongressPriceNeedTicker[];
  spx?: {
    oldestTradeDate?: string | null;
    needsHistoryBefore?: string | null;
  };
  summary?: Record<string, number>;
}

/**
 * Pull App A's list of congressional tickers that still need price/SPX history for
 * performance-vs-S&P. Soft-fails to [] on any transport/auth error so the nightly
 * share never aborts. Uses the same CONGRESS_TRADE_TOKEN (App A INGEST_TOKEN).
 */
export async function fetchCongressPriceNeeds(
  limit: number = priceNeedsLimit(),
  fetchImpl: typeof fetch = fetch
): Promise<CongressPriceNeedsResponse> {
  const empty: CongressPriceNeedsResponse = { tickers: [] };
  const token = congressTradeToken();
  if (!token) return empty;
  const url = `${congressTradeBaseUrl()}${PRICE_NEEDS_PATH}?limit=${encodeURIComponent(String(limit))}`;
  const timeoutMs = Number(process.env.CONGRESS_SHARE_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: "GET",
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      signal: controller.signal,
      cache: "no-store"
    });
    if (!res.ok) {
      console.error(`[congress-share] price-needs failed: HTTP ${res.status}`);
      return empty;
    }
    const body = (await res.json()) as CongressPriceNeedsResponse;
    const tickers = Array.isArray(body?.tickers)
      ? body.tickers
          .filter((t) => t && typeof t.ticker === "string" && t.ticker.trim())
          .map((t) => ({
            ticker: normalizeSymbol(t.ticker),
            oldestTradeDate: typeof t.oldestTradeDate === "string" ? t.oldestTradeDate : undefined,
            needsDeepHistory: t.needsDeepHistory === true,
            reasons: Array.isArray(t.reasons) ? t.reasons.map(String) : undefined
          }))
          .filter((t) => Boolean(t.ticker))
      : [];
    return {
      tickers,
      spx: body?.spx,
      summary: body?.summary
    };
  } catch (err) {
    console.error("[congress-share] price-needs error:", err instanceof Error ? err.message : err);
    return empty;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Lightweight congress-share auth probe. Makes a cheap GET to PRICE_NEEDS_PATH?limit=0 using
 * the configured CONGRESS_TRADE_TOKEN. On 401/403, logs via logApiHealth with an explicit
 * operator remediation hint and trips the auth circuit breaker so subsequent batch runs are
 * gated immediately. On success, clears the breaker and logs ok. Never throws — always
 * fire-and-forget safe.
 */
export async function probeCongressShareToken(
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  const token = congressTradeToken();
  if (!token) return; // no token configured — nothing to probe
  const url = `${congressTradeBaseUrl()}${PRICE_NEEDS_PATH}?limit=0`;
  const timeoutMs = Number(process.env.CONGRESS_SHARE_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: "GET",
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      signal: controller.signal,
      cache: "no-store"
    });
    if (res.status === 401 || res.status === 403) {
      const text = await res.text().catch(() => "");
      const base = `HTTP ${res.status} ${text.slice(0, 200)}`.trim();
      const errorText =
        `${base} — token mismatch: resync CONGRESS_TRADE_TOKEN in ST Infisical prod ` +
        `to match INGEST_TOKEN / ADMIN_TOKEN in CT Infisical prod`;
      console.error(`[congress-share] token probe auth failure: ${errorText}`);
      tripCongressAuthBreaker(Date.now(), errorText, token);
      logApiHealth({ service: "congress-share", ok: false, errorText, keySource: "env" });
      return;
    }
    if (!res.ok) {
      // Non-auth failure (5xx, network, etc.): log as transient; do not trip the auth breaker.
      const text = await res.text().catch(() => "");
      const errorText = `${HEALTH_TRANSIENT_FAILURE_PREFIX}HTTP ${res.status} ${text.slice(0, 200)}`.trim();
      console.warn(`[congress-share] token probe non-auth failure: ${errorText}`);
      logApiHealth({ service: "congress-share", ok: false, errorText, keySource: "env" });
      return;
    }
    clearCongressAuthBreaker();
    logApiHealth({ service: "congress-share", ok: true, keySource: "env" });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const isTransient = isTransientNetworkError(err);
    const errorText = isTransient ? `${HEALTH_TRANSIENT_FAILURE_PREFIX}${error}` : error;
    console.warn(`[congress-share] token probe error: ${error}`);
    logApiHealth({ service: "congress-share", ok: false, errorText, keySource: "env" });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run the congress-share token probe if the probe interval has elapsed since the last run.
 * Intended for the scheduler tick — returns {status:"skipped"} when the window hasn't elapsed
 * so the task journal records a benign skip rather than a gap. Never throws.
 */
export async function probeCongressShareTokenIfDue(now: number = Date.now()): Promise<{ status: "ok" | "skipped" }> {
  if (!congressTradeToken()) return { status: "skipped" };
  try {
    const last = getInternalSetting<number>(LAST_TOKEN_PROBE_KEY);
    if (last !== undefined && now - last < TOKEN_PROBE_INTERVAL_MS) {
      return { status: "skipped" };
    }
    setInternalSetting(LAST_TOKEN_PROBE_KEY, now);
  } catch {
    // fail open — if the marker read/write fails, run the probe anyway
  }
  await probeCongressShareToken();
  return { status: "ok" };
}

/**
 * Merge App A needs (priority) with the local base universe, cap to maxDailyTickers.
 * Needs tickers come first so congressional performance gaps drain before fill.
 */
export function mergeShareUniverse(base: string[], needs: string[], max = maxDailyTickers()): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of [...needs, ...base]) {
    const sym = normalizeSymbol(raw);
    if (!sym || seen.has(sym)) continue;
    seen.add(sym);
    out.push(sym);
    if (out.length >= max) break;
  }
  return out;
}

/** Split an array into fixed-size chunks (for insider / short-volume rows). */
function rowChunks<T>(rows: T[], size = MAX_ROWS_PER_POST): T[][] {
  if (rows.length === 0) return [];
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

function refTtlMs(): number {
  const v = Number(process.env.CONGRESS_SHARE_REF_TTL_MS ?? 6 * 60 * 60_000);
  return Number.isFinite(v) && v > 0 ? v : 6 * 60 * 60_000;
}

// ── Payload types (mirror App A's import contract; we send subsets we have) ─────
// Many individual row types now come from @jaywedgeworth22/congress-trading-shared.
// CongressRef stays local because it uses optional (?) fields rather than T|null.

export type CongressAssetClass = "equity" | "etf" | "adr" | "fund" | "other";

export interface CongressRef {
  ticker: string;
  companyName?: string;
  sector?: string;
  industry?: string;
  assetClass?: CongressAssetClass;
  isEtf?: boolean;
  isAdr?: boolean;
  country?: string;
  stateHq?: string;
  stateOfIncorp?: string;
  exchange?: string;
  exchangeShort?: string;
  currency?: string;
  marketCap?: number;
  ipoDate?: string;
  cik?: string;
  sicCode?: string;
  sicDescription?: string;
}

// Re-export shared types under the names congress-share consumers expect.
export type CongressClose = PriceClose;
export type CongressPrice = PriceSeries;
export type CongressInsider = InsiderRow;
export type CongressShortVol = ShortVolumeRow;
export type CongressFundamental = FundamentalRow;
export type CongressAnalyst = AnalystRow;

/**
 * Outbound share payload. Same wire shape as shared `SharePayload`; `refs` may
 * use the local optional-field builder (`CongressRef`) before schema validation
 * coerces them to `SecurityRefInput`.
 */
export type CongressSharePayload = Omit<SharePayload, "refs"> & {
  refs?: CongressRef[];
};

export interface CongressShareResult {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  status?: number;
  response?: unknown;
  error?: string;
  /** Counts actually transmitted across all POSTs in this call. */
  sent: {
    refs: number;
    spx: number;
    prices: number;
    closes: number;
    insider: number;
    shortVolume: number;
    fundamentals: number;
    analyst: number;
  };
}

// ── Mappers (pure, unit-testable) ──────────────────────────────────────────────

/**
 * Canonicalize a symbol for OUTBOUND IDENTITY / company-ref rows: normalize (trim+upper) then
 * resolve corporate-action aliases via the shared map (FB->META, SQ->XYZ, ATVI->MSFT, ...). This is
 * display/identity resolution — acquisitions fold onto the acquirer so App A does not keep a dead
 * securities_ref row. For MARKET DATA (prices/fundamentals/analyst/insider/short-vol) use
 * `canonicalMarketDataSymbol` instead, which drops acquisition sources so their history is never
 * relabeled onto the acquirer. Well-formed non-aliased symbols (incl. share-class hyphens like
 * BRK-B) pass through unchanged.
 */
export function canonicalOutboundSymbol(symbol: string): string {
  return resolveTickerAlias(normalizeSymbol(symbol));
}

/**
 * Canonicalize a symbol for MARKET-DATA rows (price / fundamentals / analyst / insider /
 * short-volume). Uses the shared package's rename-vs-acquisition classification
 * (`classifyTickerAlias` / `resolveContinuousTicker` / curated `TICKER_RENAMES` +
 * `TICKER_ACQUISITIONS`) — do NOT hand-roll a local acquisition set.
 *
 * - RENAMES (FB->META, SQ->XYZ, …): fold to the current ticker (continuous series).
 * - ACQUISITIONS (ATVI, TWX, RHT, …): return `null` so the caller DROPS the row — an acquired
 *   ticker's numbers must never be relabeled onto the acquirer.
 * - Non-aliased well-formed symbols pass through unchanged.
 */
export function canonicalMarketDataSymbol(symbol: string): string | null {
  const normalized = normalizeSymbol(symbol);
  if (!normalized) return null;
  const classified = classifyTickerAlias(normalized);
  if (classified?.class === "acquisition") return null;
  return resolveContinuousTicker(normalized);
}

/**
 * Map an app MarketQuote/summary to a (partial) company ref. This app only knows
 * name/sector/industry/market-cap — never CIK, exchange, country, ipoDate, etc. — and every name
 * in the screener universe is an equity, so assetClass defaults to "equity". Undefined fields are
 * omitted (the endpoint accepts any subset). Returns null when there is no usable ticker.
 */
export function marketQuoteToRef(
  q: Pick<MarketQuote, "symbol" | "companyName" | "sector" | "industry" | "marketCap">
): CongressRef | null {
  const ticker = canonicalOutboundSymbol(q.symbol);
  if (!ticker) return null;
  const ref: CongressRef = { ticker, assetClass: "equity" };
  if (q.companyName) ref.companyName = q.companyName;
  if (q.sector) ref.sector = q.sector;
  if (q.industry) ref.industry = q.industry;
  if (typeof q.marketCap === "number" && Number.isFinite(q.marketCap) && q.marketCap > 0) {
    ref.marketCap = q.marketCap;
  }
  return ref;
}

function numOrUndef(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * Map a scanned MarketQuote's fundamentals to App A's import row (PR #46). `date` is the as-of day.
 * Returns null when the quote carries no fundamental values (nothing worth sending). App A saves App B's
 * FMP quota by accepting these — App B already fetched them during the scan.
 */
export function marketQuoteToFundamentals(
  q: Pick<MarketQuote, "symbol" | "peRatio" | "eps" | "beta" | "dividendYield" | "fiftyTwoWeekHigh" | "fiftyTwoWeekLow" | "fcfYield" | "debtToEquity" | "epsGrowth">,
  date: string
): CongressFundamental | null {
  const ticker = canonicalMarketDataSymbol(q.symbol); // renames only; drops acquired tickers
  if (!ticker) return null;
  const row: CongressFundamental = { ticker, date };
  const pe = numOrUndef(q.peRatio); if (pe !== undefined) row.peRatio = pe;
  const eps = numOrUndef(q.eps); if (eps !== undefined) row.eps = eps;
  const beta = numOrUndef(q.beta); if (beta !== undefined) row.beta = beta;
  const dy = numOrUndef(q.dividendYield); if (dy !== undefined) row.dividendYield = dy;
  const hi = numOrUndef(q.fiftyTwoWeekHigh); if (hi !== undefined) row.week52High = hi;
  const lo = numOrUndef(q.fiftyTwoWeekLow); if (lo !== undefined) row.week52Low = lo;
  const fcf = numOrUndef(q.fcfYield); if (fcf !== undefined) row.fcfYield = fcf;
  const de = numOrUndef(q.debtToEquity); if (de !== undefined) row.debtToEquity = de;
  const eg = numOrUndef(q.epsGrowth); if (eg !== undefined) row.epsGrowth = eg;
  // Only the ticker+date keys present → nothing real to share.
  return Object.keys(row).length > 2 ? row : null;
}

/**
 * Map a scanned MarketQuote's analyst consensus to App A's import row (PR #46). Blends the per-source
 * rating counts App B holds. Numeric price targets are included only when the opt-in FMP price-target
 * provider populated them on the quote (FMP_PRICE_TARGETS_ENABLED); otherwise omitted (App A fills null).
 */
export function marketQuoteToAnalyst(
  q: Pick<MarketQuote, "symbol" | "analystRating" | "analystBySource" | "targetMean" | "targetHigh" | "targetLow" | "targetMedian">,
  date: string
): CongressAnalyst | null {
  const ticker = canonicalMarketDataSymbol(q.symbol); // renames only; drops acquired tickers
  if (!ticker) return null;
  const counts = { strongBuy: 0, buy: 0, hold: 0, sell: 0, strongSell: 0 };
  let haveCounts = false;
  for (const detail of Object.values(q.analystBySource ?? {})) {
    if (!detail?.counts) continue;
    haveCounts = true;
    counts.strongBuy += detail.counts.strongBuy ?? 0;
    counts.buy += detail.counts.buy ?? 0;
    counts.hold += detail.counts.hold ?? 0;
    counts.sell += detail.counts.sell ?? 0;
    counts.strongSell += detail.counts.strongSell ?? 0;
  }
  const tMean = numOrUndef(q.targetMean);
  const tHigh = numOrUndef(q.targetHigh);
  const tLow = numOrUndef(q.targetLow);
  const tMedian = numOrUndef(q.targetMedian);
  const haveTargets = tMean !== undefined || tHigh !== undefined || tLow !== undefined || tMedian !== undefined;
  if (!q.analystRating && !haveCounts && !haveTargets) return null;
  const row: CongressAnalyst = { ticker, date };
  if (q.analystRating) row.rating = q.analystRating;
  if (haveCounts) Object.assign(row, counts);
  if (tMean !== undefined) row.targetMean = tMean;
  if (tHigh !== undefined) row.targetHigh = tHigh;
  if (tLow !== undefined) row.targetLow = tLow;
  if (tMedian !== undefined) row.targetMedian = tMedian;
  return row;
}

/** Convert OHLC bars to deduped, date-sorted {date, close, volume?} closes (drops invalid bars). */
export function ohlcBarsToCloses(bars: OHLCBar[] | null | undefined): CongressClose[] {
  if (!bars || bars.length === 0) return [];
  const byDate = new Map<string, CongressClose>();
  for (const bar of bars) {
    const date = toBusinessDay(bar.time);
    const close = bar.close;
    if (!date || typeof close !== "number" || !Number.isFinite(close)) continue;
    const entry: CongressClose = { date, close };
    if (typeof bar.volume === "number" && Number.isFinite(bar.volume)) entry.volume = bar.volume;
    byDate.set(date, entry); // later bar for a given date wins
  }
  return Array.from(byDate.values()).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)); // ascending
}

/** Build a per-ticker price entry from OHLC bars. currentPrice/currentPriceDate = most recent close. */
export function ohlcBarsToPriceEntry(symbol: string, bars: OHLCBar[] | null | undefined): CongressPrice | null {
  const ticker = canonicalMarketDataSymbol(symbol); // renames only; drops acquired tickers (never relabel bars onto the acquirer)
  if (!ticker) return null;
  const closes = ohlcBarsToCloses(bars);
  if (closes.length === 0) return null;
  const newest = closes[closes.length - 1]; // closes are ascending
  return { ticker, closes, currentPrice: newest.close, currentPriceDate: newest.date };
}

// ── Insider / short-volume import builders (App B's highest-fit datasets for App A) ──

/** Build App A insider rows from App B's cached SEC Form-4 dataset; shares summed per symbol. */
export function buildInsiderImport(): CongressInsider[] {
  const ds = getInsiderDataset();
  if (!ds || ds.filings.length === 0) return [];
  const agg = new Map<string, { buyShares: number; sellShares: number; date: string }>();
  for (const f of ds.filings) {
    const sym = normalizeSymbol(f.symbol);
    if (!sym) continue;
    const a = agg.get(sym) ?? { buyShares: 0, sellShares: 0, date: f.filedAt };
    a.buyShares += f.buyShares;
    a.sellShares += f.sellShares;
    if (f.filedAt > a.date) a.date = f.filedAt;
    agg.set(sym, a);
  }
  const symbols = Array.from(agg.keys());
  const signals = getInsiderSignals(symbols);
  const out: CongressInsider[] = [];
  for (const sym of symbols) {
    const sig = signals[sym];
    const a = agg.get(sym);
    if (!sig || !a) continue;
    const ticker = canonicalMarketDataSymbol(sym);
    if (!ticker) continue; // acquired ticker — drop rather than relabel onto the acquirer
    out.push({
      ticker,
      date: a.date,
      sentiment: sig.insiderSentiment,
      buyFilings: sig.buyFilings,
      sellFilings: sig.sellFilings,
      buyShares: a.buyShares,
      sellShares: a.sellShares,
      owners: sig.owners
    });
  }
  return out.slice(0, maxDailyTickers());
}

/** Build App A short-volume rows from App B's cached FINRA dataset. */
export function buildShortVolumeImport(): CongressShortVol[] {
  const ds = getFinraDataset();
  const symbols = ds ? Object.keys(ds.ratios) : [];
  if (symbols.length === 0) return [];
  const signals = getShortVolumeSignals(symbols);
  const out: CongressShortVol[] = [];
  for (const sym of symbols) {
    const sig = signals[sym];
    if (!sig) continue;
    const date = sig.asOf ?? ds?.asOf;
    if (!date) continue;
    const ticker = canonicalMarketDataSymbol(sym);
    if (!ticker) continue; // acquired ticker — drop rather than relabel onto the acquirer
    out.push({ ticker, date, ratio: sig.shortVolumeRatio, elevated: sig.elevated });
  }
  return out.slice(0, maxDailyTickers());
}

// ── Low-level POST ─────────────────────────────────────────────────────────────

function countCloses(payload: CongressSharePayload): number {
  let n = (payload.spx?.length ?? 0);
  for (const p of payload.prices ?? []) n += p.closes.length;
  return n;
}

/** Minimal shape of a shared Zod row schema (avoids importing `z` just for the parameter type). */
type RowSchema = { safeParse: (value: unknown) => { success: boolean } };

/**
 * Validate each dataset's rows against the shared row schemas and DROP any that fail, so malformed
 * data never reaches App A's import endpoint. Validation is PER-ROW (not whole-payload) so one bad
 * row never suppresses the valid rows in the same dataset — and it filters, rather than logs-and-sends
 * as the old code did. Rows that pass are returned verbatim (App A's importer accepts the extra
 * CongressRef fields the strict schema strips, so we never narrow a valid row's payload).
 * Returns the filtered payload plus a per-dataset dropped-row count for observability.
 */
export function dropInvalidShareRows(
  payload: CongressSharePayload,
): { payload: CongressSharePayload; dropped: Record<string, number> } {
  const dropped: Record<string, number> = {};
  const filterRows = <T>(rows: T[] | undefined, schema: RowSchema, key: string): T[] | undefined => {
    if (!rows || rows.length === 0) return rows;
    const valid: T[] = [];
    let bad = 0;
    for (const row of rows) {
      if (schema.safeParse(row).success) valid.push(row);
      else bad++;
    }
    if (bad > 0) dropped[key] = bad;
    return valid;
  };
  return {
    payload: {
      ...payload,
      refs: filterRows(payload.refs, SecurityRefInputSchema, "refs"),
      prices: filterRows(payload.prices, PriceSeriesSchema, "prices"),
      spx: filterRows(payload.spx, PriceCloseSchema, "spx"),
      insider: filterRows(payload.insider, InsiderRowSchema, "insider"),
      shortVolume: filterRows(payload.shortVolume, ShortVolumeRowSchema, "shortVolume"),
      fundamentals: filterRows(payload.fundamentals, FundamentalRowSchema, "fundamentals"),
      analyst: filterRows(payload.analyst, AnalystRowSchema, "analyst"),
      trades: filterRows(payload.trades, TradeEventRowSchema, "trades"),
    },
    dropped,
  };
}

/**
 * POST one payload to App A's import endpoint. Idempotent + safe to resend. Self-guarded: never
 * throws — returns a structured result (skipped when no token; ok:false on transport/HTTP error).
 */
export async function shareWithCongressTrade(payload: CongressSharePayload): Promise<CongressShareResult> {
  // Drop schema-invalid rows BEFORE building the payload so malformed data never reaches App A;
  // `sent` (and the empty check) then reflect only what is actually transmitted.
  const { payload: clean, dropped } = dropInvalidShareRows(payload);
  if (Object.keys(dropped).length > 0) {
    console.warn("[congress-share] dropped schema-invalid rows before send:", dropped);
  }
  const sent = {
    refs: clean.refs?.length ?? 0,
    spx: clean.spx?.length ?? 0,
    prices: clean.prices?.length ?? 0,
    closes: countCloses(clean),
    insider: clean.insider?.length ?? 0,
    shortVolume: clean.shortVolume?.length ?? 0,
    fundamentals: clean.fundamentals?.length ?? 0,
    analyst: clean.analyst?.length ?? 0,
    trades: clean.trades?.length ?? 0
  };
  const token = congressTradeToken();
  if (!token) return { ok: false, skipped: true, reason: "no-token", sent };
  const total = sent.refs + sent.spx + sent.prices + sent.insider + sent.shortVolume + sent.fundamentals + sent.analyst;
  if (total === 0) {
    // Distinguish a genuinely-empty input (nothing to send → legitimate skip) from a payload whose
    // rows were ALL rejected by the shared schema. The latter is a real failure: counting it as a
    // skip would let the daily-run marker advance and silently swallow schema/API drift until the
    // next day. Returning skipped:false makes runCongressDailyShare count it in failedPosts.
    if (Object.keys(dropped).length > 0) {
      return { ok: false, skipped: false, reason: "all-rows-dropped", sent };
    }
    return { ok: false, skipped: true, reason: "empty", sent };
  }

  const now = Date.now();
  const breakerState = activeCongressAuthBreakerState(token);
  if (breakerState && now < breakerState.untilMs) {
    // Auth breaker open: a recent real 401/403 means the token is broken until an operator fixes
    // it — skip the network call entirely (no fetch) rather than hammering App A again. Every
    // caller (scan-hook + nightly batch, including the REST of an in-flight batch's chunk loop)
    // shares this one check, so tripping it once silences the whole storm. Still replay the
    // cached failure into the health store (no console.error — that already fired for the real
    // attempt) so the "5 consecutive failures" Sentry/health-degraded threshold (logApiHealth ->
    // alertConnectionFailure, same mechanism "roic"/"congress.trade" already use) is reached at
    // the caller's NORMAL cadence instead of only once per cooldown window.
    logApiHealth({
      service: "congress-share",
      ok: false,
      errorText: `${breakerState.lastError} [auth breaker cooldown active; not re-sent]`,
      keySource: "env"
    });
    return { ok: false, skipped: false, reason: "auth-breaker-tripped", sent };
  }
  if (breakerState) {
    // Cooldown elapsed: half-open. Exactly one caller may send the real probe; any other caller
    // reaching this same instant (scan-hook firing while the nightly batch is also mid-run, etc.)
    // absorbs instead of independently treating the expired cooldown as its own single probe —
    // otherwise concurrent callers recreate a burst of 401/403 requests every cooldown boundary.
    if (!claimCongressAuthBreakerProbe(now, breakerState)) {
      logApiHealth({
        service: "congress-share",
        ok: false,
        errorText: `${breakerState.lastError} [auth breaker half-open probe already in flight; not re-sent]`,
        keySource: "env"
      });
      return { ok: false, skipped: false, reason: "auth-breaker-tripped", sent };
    }
  }

  const url = `${congressTradeBaseUrl()}${API_PATHS.ADMIN_SECURITIES_IMPORT}`;
  const timeoutMs = Number(process.env.CONGRESS_SHARE_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      // Stamp our origin so the counterpart never echoes our own rows back to us (no-echo-loop guard).
      const body = { ...clean, origin: clean.origin ?? APP_B_ORIGIN_TAG };
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
        signal: controller.signal,
        cache: "no-store"
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        const isAuthFailure = res.status === 401 || res.status === 403;
        const baseError = `HTTP ${res.status} ${text.slice(0, 300)}`;
        const errorText = isAuthFailure
          ? `${baseError} — token mismatch: resync CONGRESS_TRADE_TOKEN in ST Infisical prod ` +
            `to match INGEST_TOKEN / ADMIN_TOKEN in CT Infisical prod`
          : baseError;
        if (isAuthFailure) {
          console.error(`[congress-share] import failed: ${errorText}`);
          tripCongressAuthBreaker(now, errorText, token);
          logApiHealth({ service: "congress-share", ok: false, errorText, keySource: "env" });
          return { ok: false, status: res.status, error: text.slice(0, 500) || `HTTP ${res.status}`, sent };
        }
        // Downstream 5xx errors (e.g. transient D1 overload): retry with backoff before hard failure.
        if (res.status >= 500 && attempt < maxAttempts) {
          const delay = process.env.NODE_ENV === "test" ? 0 : Math.min(1000 * Math.pow(2, attempt - 1), 5000);
          console.warn(`[congress-share] import got HTTP ${res.status}; retrying attempt ${attempt + 1}/${maxAttempts} in ${delay}ms`);
          if (delay > 0) await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        console.error(`[congress-share] import failed: ${errorText}`);
        // Surface failure to health store: prefix 5xx as transient to allow escalation window.
        const formattedError = res.status >= 500 ? `${HEALTH_TRANSIENT_FAILURE_PREFIX}${errorText}` : errorText;
        logApiHealth({ service: "congress-share", ok: false, errorText: formattedError, keySource: "env" });
        return { ok: false, status: res.status, error: text.slice(0, 500) || `HTTP ${res.status}`, sent };
      }
      const response = await res.json().catch(() => undefined);
      clearCongressAuthBreaker(); // a successful call proves the token is good again
      logApiHealth({ service: "congress-share", ok: true, keySource: "env" });
      return { ok: true, status: res.status, response, sent };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      if (attempt < maxAttempts && isTransientNetworkError(err)) {
        const delay = process.env.NODE_ENV === "test" ? 0 : Math.min(1000 * Math.pow(2, attempt - 1), 5000);
        console.warn(`[congress-share] import transient error: ${error}; retrying attempt ${attempt + 1}/${maxAttempts} in ${delay}ms`);
        if (delay > 0) await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      // Include payload sizes so a timeout/abort points at which dataset was too big.
      console.error(
        `[congress-share] import error: ${error} ` +
          `(refs=${sent.refs} spx=${sent.spx} prices=${sent.prices} closes=${sent.closes} ` +
          `insider=${sent.insider} shortVolume=${sent.shortVolume} fundamentals=${sent.fundamentals} analyst=${sent.analyst})`
      );
      const isTransient = isTransientNetworkError(err);
      const formattedError = isTransient ? `${HEALTH_TRANSIENT_FAILURE_PREFIX}${error}` : error;
      logApiHealth({ service: "congress-share", ok: false, errorText: formattedError, keySource: "env" });
      return { ok: false, error, sent };
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, error: "max-attempts-exceeded", sent };
}

// ── Chunking ────────────────────────────────────────────────────────────────────

/**
 * Greedily pack price entries into POST-sized chunks bounded by BOTH a close budget and a ticker
 * count. A single ticker carrying more closes than the budget is sent alone (truncating its history
 * to the most-recent `CLOSE_BUDGET_PER_POST` closes so one POST always stays under the ceiling).
 */
export function chunkPrices(
  prices: CongressPrice[],
  closeBudget = CLOSE_BUDGET_PER_POST,
  maxTickers = MAX_TICKERS_PER_POST
): CongressPrice[][] {
  const chunks: CongressPrice[][] = [];
  let current: CongressPrice[] = [];
  let closesInChunk = 0;
  for (const price of prices) {
    let entry = price;
    if (entry.closes.length > closeBudget) {
      const trimmed = entry.closes.slice(-closeBudget);
      entry = { ...entry, closes: trimmed };
    }
    const wouldExceedCloses = closesInChunk + entry.closes.length > closeBudget && current.length > 0;
    const wouldExceedTickers = current.length >= maxTickers;
    if (wouldExceedCloses || wouldExceedTickers) {
      chunks.push(current);
      current = [];
      closesInChunk = 0;
    }
    current.push(entry);
    closesInChunk += entry.closes.length;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

// ── Scan-refs forwarding (after each scan) ──────────────────────────────────────

// Per-symbol throttle so frequent scans don't re-POST the same refs. Durable (survives a process
// restart): the app now auto-deploys on every merge to main, and without this a redeploy would make
// every symbol look "never shared" to the very next scan, re-POSTing refs shared minutes earlier.
// Low stakes either way (App A's import endpoint is idempotent — worst case is redundant, harmless
// network calls, per the module header above), so debounced (not immediate) flush is fine here.
// Lazily created (not at module top level) — see provider-rate-limit.ts's quotaStore() for why
// eagerly calling createDurableMap() at import time risks a circular-import TDZ crash.
let refSentAtInstance: ReturnType<typeof createDurableMap<number>> | undefined;
function refSentAt(): ReturnType<typeof createDurableMap<number>> {
  return refSentAtInstance ?? (refSentAtInstance = createDurableMap<number>("congress-share-ref-throttle"));
}

/**
 * Forward the scan's candidate company refs — plus the fundamentals + analyst consensus App B just
 * fetched for them — to App A. The scan already paid for this data, so sharing it lets App A skip its
 * own FMP calls (PR #46 import slots). Fire-and-forget friendly + self-guarded; no-op unless automatic
 * sharing is enabled; per-symbol throttled (default 6h) so it never spams. Fundamentals/analyst are
 * HELD OFF (refs still flow) until CONGRESS_SHARE_FUNDAMENTALS_ENABLED is set — App A's #46 tables don't
 * exist until its migration runs, and pushing those rows earlier errors them on App A.
 */
export async function shareScanRefs(scan: Pick<MarketScan, "topCandidates">): Promise<CongressShareResult | null> {
  try {
    if (!isCongressShareAutoEnabled()) return null;
    const now = Date.now();
    const ttl = refTtlMs();
    const date = utcDate(now);
    // Held OFF until App A's #46 migration is live (pushing these rows earlier errors them on App A).
    const includeFundamentals = congressFundamentalsShareEnabled();
    const refs: CongressRef[] = [];
    const fundamentals: CongressFundamental[] = [];
    const analyst: CongressAnalyst[] = [];
    const claimed: string[] = [];
    for (const quote of scan.topCandidates ?? []) {
      const ref = marketQuoteToRef(quote);
      if (!ref) continue;
      const sentAt = refSentAt().get(ref.ticker);
      if (sentAt !== undefined && now - sentAt < ttl) continue; // throttled
      refs.push(ref);
      if (includeFundamentals) {
        const f = marketQuoteToFundamentals(quote, date);
        if (f) fundamentals.push(f);
        const a = marketQuoteToAnalyst(quote, date);
        if (a) analyst.push(a);
      }
      claimed.push(ref.ticker);
      // Optimistically claim BEFORE the await so concurrent scans don't double-POST the same ref.
      refSentAt().set(ref.ticker, now);
      if (refs.length >= MAX_REFS_PER_POST) break;
    }
    if (refs.length === 0) return null;
    const result = await shareWithCongressTrade({ refs, fundamentals, analyst });
    if (!result.ok) {
      // Roll back the throttle so a later scan retries the failed refs (don't spam on success).
      for (const ticker of claimed) refSentAt().delete(ticker);
    }
    return result;
  } catch (err) {
    console.error("[congress-share] shareScanRefs error:", err);
    return null;
  }
}

/** Test seam: reset the in-memory scan-refs throttle. */
export function resetCongressRefThrottle(): void {
  refSentAt().clear();
}

// ── Nightly daily-close + S&P-500 batch ─────────────────────────────────────────

/** UTC calendar date (YYYY-MM-DD) for the given epoch ms. */
function utcDate(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** True when the once-per-day batch has not yet run for `now`'s UTC date and isn't in failure backoff. Pure (no env gate). */
export function isCongressDailyShareDue(now: number): boolean {
  const last = getInternalSetting<string>(LAST_DAILY_RUN_KEY);
  if (last === utcDate(now)) return false;
  
  // 60-minute backoff after a failure to prevent unbounded retry storms
  const lastFailure = getInternalSetting<number>("congress_share_last_failure_ms");
  if (lastFailure && now - lastFailure < 60 * 60 * 1000) return false;
  
  return true;
}

/** Union of every user's watchlist symbols + policy-universe symbols (what this app monitors). */
function collectMonitoredSymbols(): string[] {
  const set = new Set<string>();
  for (const userId of listUsers()) {
    try {
      const policy = getPolicy(userId);
      for (const s of symbolsForPolicyUniverse(policy)) {
        const sym = normalizeSymbol(s);
        if (sym) set.add(sym);
      }
      for (const item of listWatchlistSymbols(userId)) {
        const sym = normalizeSymbol(item.symbol);
        if (sym) set.add(sym);
      }
    } catch {
      // one user's DB error must not block the others
    }
  }
  return Array.from(set);
}

/** Union of every STATIC index universe's members (dynamic-source universes contribute no static symbols). */
export function allIndexUniverseSymbols(): string[] {
  const set = new Set<string>();
  for (const cfg of Object.values(INDEX_UNIVERSES)) {
    for (const s of cfg.symbols) {
      const sym = normalizeSymbol(s);
      if (sym) set.add(sym);
    }
  }
  return Array.from(set);
}

/** Bounded-concurrency async map (gentle on the upstream history providers). */
async function mapPool<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) break;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

export interface RunCongressDailyShareOptions {
  now?: number;
  /** Bypass the once-per-day date gate (the admin/manual path passes true). */
  force?: boolean;
  /** Override the universe (admin targeted test). When set, the date marker is NOT advanced. */
  symbols?: string[];
  /**
   * Deep-history backfill: send each symbol's FULL available history (skip the per-symbol close cap)
   * so App A can compute performance back to old trade dates. Still chunked into small bounded POSTs.
   * Use one-time / on-demand via the admin route; the recurring nightly run leaves this off (light).
   */
  fullHistory?: boolean;
  /**
   * Source full history from Massive flat files (bulk per-day downloads pivoted to per-ticker series)
   * instead of N per-ticker REST calls. Scales to a broad universe; falls back to the per-ticker source
   * for any symbol absent from the flat files. Best paired with `fullHistory` + `allIndexes`.
   */
  flatFile?: boolean;
  /**
   * Expand the (non-custom) universe to the union of every STATIC index universe (S&P 500, Nasdaq-100,
   * Dow 30, …) plus the monitored symbols — for a broad cross-index backfill. Still capped by maxDailyTickers.
   */
  allIndexes?: boolean;
  /**
   * Pull App A's /api/export/price-needs and prefer those congressional tickers in the share
   * universe (deep history for tickers flagged needsDeepHistory). When set without other symbols,
   * the universe is needs-only (does not advance the daily marker unless also the scheduled path).
   * The scheduled nightly path always merges a page of needs even when this is false.
   */
  fromAppANeeds?: boolean;
  /** Opaque durable claim supplied by the outer admin guard; background callers omit it. */
  operationLeaseClaim?: OperationLeaseClaim;
}

export interface CongressDailyShareSummary {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  tickers: number;
  priced: number;
  refRows?: number;
  spxRows: number;
  insiderRows: number;
  shortVolRows: number;
  posts: number;
  failedPosts: number;
  sent: { spx: number; prices: number; closes: number; insider: number; shortVolume: number };
  responses?: unknown[];
}

let activeDailySharePromise: Promise<OperationLeaseAware<CongressDailyShareSummary>> | null = null;

/**
 * Collect the monitored universe's daily closes + the S&P-500 (^GSPC) series and POST them to App A
 * in capped chunks. Reuses the app's history cache, so a name fetched earlier in the day is free.
 * Self-guarded; safe to fire-and-forget. The scheduler calls the gated wrapper below; the admin
 * route calls this with force:true.
 */
export async function runCongressDailyShare(
  options: RunCongressDailyShareOptions = {}
): Promise<OperationLeaseAware<CongressDailyShareSummary>> {
  if (activeDailySharePromise) {
    return activeDailySharePromise;
  }
  
  const promise = (async () => {
    const now = options.now ?? Date.now();
    const empty = {
      tickers: 0, priced: 0, spxRows: 0, insiderRows: 0, shortVolRows: 0,
      posts: 0, failedPosts: 0, sent: { spx: 0, prices: 0, closes: 0, insider: 0, shortVolume: 0 }
    };
    if (!congressTradeToken()) return { ok: false, skipped: true, reason: "no-token", ...empty };

    const customUniverse = Array.isArray(options.symbols) && options.symbols.length > 0;
    if (!options.force && !customUniverse && !isCongressDailyShareDue(now)) {
      return { ok: false, skipped: true, reason: "not-due", ...empty };
    }

    const guarded = await runWithOperationLease(
      {
        group: OPERATION_LEASE_GROUPS.CONGRESS_SHARE,
        operation: "congress-share",
        claim: options.operationLeaseClaim
      },
      async (claim, signal) => runCongressDailyShareUnlocked(options, claim, signal)
    );
    if (!guarded.acquired) {
      return {
        ok: true,
        skipped: true,
        reason: "operation-in-flight",
        ...empty,
        operationLease: guarded.busy
      };
    }
    return guarded.value;
  })();

  activeDailySharePromise = promise;
  try {
    return await promise;
  } finally {
    activeDailySharePromise = null;
  }
}

async function fetchNasdaqScreenerRefs(): Promise<CongressRef[]> {
  try {
    const response = await fetchNasdaqScreenerResponse("congress-nasdaq-screener");
    if (!response.ok) return [];
    const payload = await response.json();
    const rows = Array.isArray(payload?.data?.table?.rows) ? payload.data.table.rows : [];
    
    const seen = new Set<string>();
    const refs: CongressRef[] = [];
    
    for (const row of rows) {
      const rawSymbol = String(row.symbol ?? "");
      const sym = normalizeSymbol(rawSymbol).replace(/\//g, "-");
      const ticker = canonicalOutboundSymbol(sym);
      if (!ticker || seen.has(ticker)) continue;
      
      const ref: CongressRef = { ticker, assetClass: "equity" };
      
      const rawName = typeof row.name === "string" ? row.name.trim() : "";
      const cleanedName = rawName.replace(/\s*\(Representing\s*[-–—]*\s*\)\s*$/i, "").trim();
      const companyName = cleanedName || rawName;
      if (companyName) ref.companyName = companyName;
      
      if (typeof row.sector === "string" && row.sector.trim()) ref.sector = row.sector.trim();
      if (typeof row.industry === "string" && row.industry.trim()) ref.industry = row.industry.trim();
      
      const marketCapStr = String(row.marketCap ?? "").replace(/[$,%\s,]/g, "");
      const marketCap = Number(marketCapStr);
      if (Number.isFinite(marketCap) && marketCap > 0) ref.marketCap = marketCap;
      
      refs.push(ref);
      seen.add(ticker); // Avoid duplicates if screener has multiple rows mapping to same canonical ticker
    }
    return refs;
  } catch (err) {
    console.error("[congress-share] failed to fetch screener refs:", err);
    return [];
  }
}

async function runCongressDailyShareUnlocked(
  options: RunCongressDailyShareOptions,
  operationLeaseClaim: OperationLeaseClaim,
  operationLeaseSignal: AbortSignal
): Promise<CongressDailyShareSummary> {
  const now = options.now ?? Date.now();
  const empty = {
    tickers: 0, priced: 0, spxRows: 0, insiderRows: 0, shortVolRows: 0,
    posts: 0, failedPosts: 0, sent: { spx: 0, prices: 0, closes: 0, insider: 0, shortVolume: 0 }
  };
  if (!congressTradeToken()) return { ok: false, skipped: true, reason: "no-token", ...empty };
  const customUniverse = Array.isArray(options.symbols) && options.symbols.length > 0;
  // Recheck after durable acquisition: another process may have completed and advanced the daily
  // marker after this caller's cheap pre-check but before it won the lease.
  if (!options.force && !customUniverse && !isCongressDailyShareDue(now)) {
    return { ok: false, skipped: true, reason: "not-due", ...empty };
  }
  assertOperationLeaseOwnership(operationLeaseClaim);

  // Gate the ENTIRE collection phase on the auth breaker (P2 fix 2026-09-07), not just the final
  // shareWithCongressTrade POSTs below: fetchCongressPriceNeeds (itself an authenticated request
  // to App A), the SPX/per-ticker OHLC fetches, and the screener refs fetch previously all still
  // ran every time the nightly job was due — hourly, for the whole 6h cooldown — only to have
  // every resulting POST rejected locally by the breaker check inside shareWithCongressTrade. A
  // breaker keyed to a since-resynced token is already treated as cleared (see
  // activeCongressAuthBreakerState), so this cannot block recovery once the token is fixed.
  if (isCongressAuthBreakerTripped(now)) {
    logApiHealth({
      service: "congress-share",
      ok: false,
      errorText: "auth breaker cooldown active; skipped nightly collection entirely",
      keySource: "env"
    });
    return { ok: false, skipped: false, reason: "auth-breaker-tripped", ...empty };
  }

  // Congressional price-needs from App A: always consulted on scheduled runs so performance
  // gaps drain; also when admin passes fromAppANeeds. Soft-fails to empty.
  const shouldFetchNeeds = options.fromAppANeeds === true || !customUniverse;
  let needsResp: CongressPriceNeedsResponse = { tickers: [] };
  if (shouldFetchNeeds) {
    throwIfOperationLeaseCancelled(operationLeaseSignal);
    needsResp = await fetchCongressPriceNeeds(priceNeedsLimit());
  }
  const needTickers = needsResp.tickers.map((t) => t.ticker).filter(Boolean);
  // Full history for App A-flagged deep needs (old trades) and when fullHistory is on.
  const deepNeedSet = new Set(
    needsResp.tickers.filter((t) => t.needsDeepHistory === true).map((t) => t.ticker)
  );

  let universe: string[];
  if (customUniverse && !options.fromAppANeeds) {
    // Admin targeted symbols only — do not merge App A needs (caller is explicit).
    universe = Array.from(new Set(options.symbols!.map(normalizeSymbol).filter(Boolean))).slice(
      0,
      maxDailyTickers()
    );
  } else if (options.fromAppANeeds && !customUniverse && !options.allIndexes) {
    // Admin/ops: App A needs only (may be empty if App A is fully covered).
    universe = Array.from(new Set(needTickers)).slice(0, maxDailyTickers());
  } else {
    const base = customUniverse
      ? options.symbols!
      : options.allIndexes
        ? [...allIndexUniverseSymbols(), ...collectMonitoredSymbols()]
        : collectMonitoredSymbols();
    // Scheduled path: needs first (priority drain), then monitored/index fill.
    universe = mergeShareUniverse(base, needTickers);
  }

  // Treat fromAppANeeds-only as a custom universe so a manual needs drain does not
  // advance the once-per-day marker (same rule as symbols: override).
  const advancesDailyMarker = !customUniverse && !options.fromAppANeeds;

  // S&P-500 daily closes (^GSPC) — sent once per day regardless of the ticker universe.
  // Full history when App A reports SPX gaps before oldest congressional trade, or fullHistory flag.
  let spx: CongressClose[] = [];
  throwIfOperationLeaseCancelled(operationLeaseSignal);
  try {
    spx = ohlcBarsToCloses(await fetchDailyOHLC("^GSPC", now));
    const spxCap =
      options.fullHistory || needsResp.spx?.needsHistoryBefore
        ? Number.POSITIVE_INFINITY
        : maxClosesPerTicker();
    if (spx.length > spxCap) spx = spx.slice(-spxCap);
  } catch (err) {
    console.error("[congress-share] SPX fetch failed:", err);
  }

  const concurrency = Number(process.env.CONGRESS_SHARE_CONCURRENCY ?? 4) || 4;
  // Deep-history backfill sends each symbol's FULL series (still chunked into small POSTs); the nightly
  // run caps to the most-recent N closes (App A backfills deeper itself) to keep each POST under the wall.
  // Tickers from App A price-needs with needsDeepHistory always get full history so old trade anchors fill.
  const defaultMaxCloses = options.fullHistory ? Number.POSITIVE_INFINITY : maxClosesPerTicker();
  const capCloses = (entry: CongressPrice | null): CongressPrice | null => {
    if (!entry) return entry;
    const maxCloses =
      options.fullHistory || deepNeedSet.has(entry.ticker) ? Number.POSITIVE_INFINITY : defaultMaxCloses;
    if (entry.closes.length > maxCloses) entry.closes = entry.closes.slice(-maxCloses);
    return entry;
  };
  const perTicker = async (symbols: string[]): Promise<CongressPrice[]> =>
    (
      await mapPool(symbols, concurrency, async (symbol) => {
        throwIfOperationLeaseCancelled(operationLeaseSignal);
        try {
          return capCloses(ohlcBarsToPriceEntry(symbol, await fetchDailyOHLC(symbol, now)));
        } catch {
          return null;
        }
      })
    ).filter((p): p is CongressPrice => p !== null);

  let priceEntries: CongressPrice[];
  if (options.flatFile) {
    // Bulk path: one pass over the flat files for the whole universe, then per-ticker fallback for misses
    // (or when flat-file download isn't granted, in which case the whole universe falls back).
    const years = Number(process.env.MASSIVE_FLATFILE_BACKFILL_YEARS ?? 5) || 5;
    const toISO = toBusinessDay(now) ?? new Date(now).toISOString().slice(0, 10);
    const fromISO = new Date(now - years * 365 * 86_400_000).toISOString().slice(0, 10);
    let seriesBySymbol = new Map<string, OHLCBar[]>();
    throwIfOperationLeaseCancelled(operationLeaseSignal);
    try {
      seriesBySymbol = await fetchGroupedDailyBarsRange(fromISO, toISO, { tickers: universe });
    } catch (err) {
      console.error("[congress-share] flat-file range fetch failed; falling back per-ticker:", err);
    }
    const entries: CongressPrice[] = [];
    const missing: string[] = [];
    for (const symbol of universe) {
      const bars = seriesBySymbol.get(symbol);
      const entry = bars && bars.length ? capCloses(ohlcBarsToPriceEntry(symbol, bars)) : null;
      if (entry) entries.push(entry);
      else missing.push(symbol);
    }
    priceEntries = [...entries, ...(await perTicker(missing))];
  } else {
    priceEntries = await perTicker(universe);
  }

  // App B's two highest-fit datasets for congress.trade — already cached locally, sent once/day.
  // Skip on targeted custom/needs-only runs so a performance backfill stays price-focused.
  const insider = advancesDailyMarker ? buildInsiderImport() : [];
  const shortVolume = advancesDailyMarker ? buildShortVolumeImport() : [];
  
  // Push company refs for the full public screener
  const refs = await fetchNasdaqScreenerRefs();

  // Send each dataset as its OWN bounded POST(s) rather than one bundled megabatch: App A's per-call
  // work (upserts + per-trade perf recompute) made big combined payloads exceed the timeout, and a
  // bundled POST also let one oversized dataset abort the rest. Independent small POSTs each succeed.
  const payloads: CongressSharePayload[] = [];
  if (spx.length > 0) payloads.push({ spx });
  for (const rows of rowChunks(refs, MAX_REFS_PER_POST)) payloads.push({ refs: rows });
  for (const rows of rowChunks(insider)) payloads.push({ insider: rows });
  for (const rows of rowChunks(shortVolume)) payloads.push({ shortVolume: rows });
  for (const prices of chunkPrices(priceEntries)) payloads.push({ prices });

  const responses: unknown[] = [];
  let posts = 0;
  let failedPosts = 0;
  const sent = { refs: 0, spx: 0, prices: 0, closes: 0, insider: 0, shortVolume: 0 };
  for (const payload of payloads) {
    assertOperationLeaseOwnership(operationLeaseClaim);
    const result = await shareWithCongressTrade(payload);
    throwIfOperationLeaseCancelled(operationLeaseSignal);
    posts++;
    if (result.ok) {
      responses.push(result.response);
      sent.refs += result.sent.refs ?? 0;
      sent.spx += result.sent.spx;
      sent.prices += result.sent.prices;
      sent.closes += result.sent.closes;
      sent.insider += result.sent.insider;
      sent.shortVolume += result.sent.shortVolume;
    } else if (!result.skipped) {
      failedPosts++;
    }
  }

  const ok = posts > 0 && failedPosts === 0;
  // Advance the once-per-day marker only for the real scheduled universe (not admin custom-symbol /
  // fromAppANeeds-only drains).
  if (advancesDailyMarker) {
    assertOperationLeaseOwnership(operationLeaseClaim);
    try {
      if (ok) {
        setInternalSetting(LAST_DAILY_RUN_KEY, utcDate(now));
      } else {
        setInternalSetting("congress_share_last_failure_ms", now);
      }
    } catch (err) {
      console.error("[congress-share] failed to persist daily-run or failure marker:", err);
    }
  }

  const summary: CongressDailyShareSummary = {
    ok: posts === 0 && universe.length === 0 ? true : ok,
    tickers: universe.length,
    priced: priceEntries.length,
    refRows: refs.length,
    spxRows: spx.length,
    insiderRows: insider.length,
    shortVolRows: shortVolume.length,
    posts,
    failedPosts,
    sent,
    responses
  };
  try {
    audit("congress_share_daily", {
      ok: summary.ok,
      reason: posts === 0 ? (universe.length === 0 ? "nothing-to-send" : "nothing-to-send") : undefined,
      tickers: summary.tickers,
      priced: summary.priced,
      refRows: summary.refRows,
      spxRows: summary.spxRows,
      insiderRows: summary.insiderRows,
      shortVolRows: summary.shortVolRows,
      posts,
      failedPosts,
      sent,
      custom: customUniverse,
      fromAppANeeds: options.fromAppANeeds === true,
      needsCount: needTickers.length
    });
  } catch {
    // audit is best-effort
  }
  return summary;
}

/**
 * Scheduler entry point: run the nightly batch at most once per UTC day, only when automatic
 * sharing is enabled. Self-guarded; returns null when disabled/not due so the tick stays clean.
 * Single-flight + 60-minute failure backoff (see isCongressDailyShareDue) prevent retry storms.
 */
export async function runCongressDailyShareIfDue(
  now: number = Date.now()
): Promise<OperationLeaseAware<CongressDailyShareSummary> | null> {
  try {
    if (!isCongressShareAutoEnabled()) return null;
    if (!isCongressDailyShareDue(now)) return null;
    const existing = congressDailyShareInFlightHost.__congressDailyShareInFlight;
    if (existing) return existing;
    const runPromise = runCongressDailyShare({ now })
      .catch((err) => {
        console.error("[congress-share] daily batch error:", err);
        return null;
      })
      .finally(() => {
        if (congressDailyShareInFlightHost.__congressDailyShareInFlight === runPromise) {
          delete congressDailyShareInFlightHost.__congressDailyShareInFlight;
        }
      });
    congressDailyShareInFlightHost.__congressDailyShareInFlight = runPromise;
    return runPromise;
  } catch (err) {
    console.error("[congress-share] daily batch error:", err);
    return null;
  }
}
