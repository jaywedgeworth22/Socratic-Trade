// Read-only Alpaca trading-API account/market observability.
//
// These are GET-only calls against Alpaca's trading API — portfolio history, market
// calendar/clock, and the account activity log. They never place, modify, or cancel an
// order. They mirror the credential resolution, auth headers, timeout, and health-logging
// conventions of the Alpaca enrichment providers in `data-providers.ts` (service names are
// distinct so the admin connection-status page can attribute failures precisely).
//
// Unlike the market-data providers (which hit data.alpaca.markets), these endpoints live on
// the trading API. Private account endpoints must use the requested user's connected
// Alpaca account and its paper/live environment; they must not fall back to shared
// operator market-data credentials.

import { getConnectedAccount, listConnectedAccounts, resolveAlpacaMarketData, type ApiKeySource } from "./db";
import { logApiHealth } from "./db-health";
import { isAbortOrTimeoutError, isTransientNetworkError, jitteredBackoffMs } from "./network-errors";
import { appendErrorCause, scrubProviderErrorText } from "./provider-rate-limit";
import type { ConnectedAccount } from "./types";

const DEFAULT_PAPER_BASE = "https://paper-api.alpaca.markets";
const DEFAULT_LIVE_BASE = "https://api.alpaca.markets";
const DEFAULT_ACTIVITIES_PAGE_SIZE = 100;
const DEFAULT_ACTIVITIES_MAX_PAGES = 20;
const REQUEST_TIMEOUT_MS = 8000;
// Bounded: exactly one retry for a transient transport failure, matching the classification
// data-providers.ts's fetchWithRetry already applies to every other enrichment provider (see
// network-errors.ts). A real outage still survives this single retry and logs hard, so the
// consecutive-failure streak still trips — this only stops a one-off blip from counting.
const TRANSIENT_RETRY_BACKOFF_MS = 250;

function tradingBase(environment: "paper" | "live" = "paper"): string {
  const raw = String(process.env.ALPACA_TRADING_BASE_URL ?? "").trim();
  const fallback = environment === "live" ? DEFAULT_LIVE_BASE : DEFAULT_PAPER_BASE;
  return (raw || fallback).replace(/\/+$/, "");
}

/**
 * Hostname (never a credential) the private trading reads use for an environment, and whether
 * ALPACA_TRADING_BASE_URL overrides it.  The override applies to BOTH environments, so an
 * override pointed at paper-api would send a live account's reads to the paper host — the ops
 * account-activity diagnostic surfaces this so a failing read can be told apart from an empty one.
 */
export function alpacaTradingHostInfo(environment: "paper" | "live"): { host: string; overridden: boolean } {
  const overridden = String(process.env.ALPACA_TRADING_BASE_URL ?? "").trim().length > 0;
  let host = "";
  try {
    host = new URL(tradingBase(environment)).host;
  } catch {
    host = "invalid-base-url";
  }
  return { host, overridden };
}

function rankAlpacaAccounts(accounts: ConnectedAccount[]): ConnectedAccount[] {
  const ranked = [
    accounts.find((a) => a.isActive && a.environment === "live"),
    accounts.find((a) => a.isActive),
    accounts.find((a) => a.environment === "live"),
    accounts.find((a) => a.environment === "paper"),
    ...accounts
  ];
  const seen = new Set<string>();
  return ranked.filter((account): account is ConnectedAccount => {
    if (!account || seen.has(account.id)) return false;
    seen.add(account.id);
    return true;
  });
}

function isAlpacaBroker(broker: ConnectedAccount["broker"] | undefined): boolean {
  return broker === "alpaca" || broker === "alpaca-mcp";
}

function credsFromConnectedAccount(
  account: ConnectedAccount | undefined
): { apiKey: string; secretKey?: string; environment: "paper" | "live"; source: ApiKeySource } | undefined {
  if (!account || !isAlpacaBroker(account.broker) || !account.apiKey) return undefined;
  return {
    apiKey: account.apiKey,
    secretKey: account.apiSecret,
    environment: account.environment === "live" ? "live" : "paper",
    source: "user"
  };
}

function resolvePrivateAlpacaAccount(
  userId: string,
  connectedAccountId?: string
): { apiKey: string; secretKey?: string; environment: "paper" | "live"; source: ApiKeySource } | undefined {
  if (connectedAccountId) {
    return credsFromConnectedAccount(getConnectedAccount(connectedAccountId, userId));
  }
  const accounts = rankAlpacaAccounts(
    listConnectedAccounts(userId).filter((account) => isAlpacaBroker(account.broker))
  );
  for (const account of accounts) {
    const creds = credsFromConnectedAccount(getConnectedAccount(account.id, userId));
    if (creds) return creds;
  }
  return undefined;
}

function authHeaders(apiKey: string, secretKey?: string): Record<string, string> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (secretKey) {
    headers["APCA-API-KEY-ID"] = apiKey;
    headers["APCA-API-SECRET-KEY"] = secretKey;
  } else {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }
  return headers;
}

// GET the trading API and parse JSON, logging health under `service` and degrading to
// undefined on any credential/HTTP/network failure. Never throws.
//
// Classification (SOCRATIC-TRADE-28, "alpaca-account-insights connection failed", 9 events/12
// days -- genuinely low-volume, not a money-path emergency): a bare `err.message` on a Node
// fetch failure is frequently just "fetch failed", which loses the actual transport cause
// (ECONNRESET, DNS blip, dead keep-alive socket) and does not match any of the soft-failure
// text patterns db-health.ts already recognizes -- so a one-off blip was logged exactly like a
// hard, persistent outage. Two changes, both scoped to this call site:
//  - A transient transport error (network-errors.ts: dead socket / DNS / reset) gets ONE bounded
//    retry before it counts against this lane's health at all -- mirrors the retry-once
//    classification data-providers.ts's fetchWithRetry already applies to every other
//    enrichment provider. A real outage still survives the retry and logs hard, so the
//    consecutive-failure streak is unchanged for an actual outage.
//  - Our own REQUEST_TIMEOUT_MS abort is a caller-budget timeout, not a broken integration --
//    logged `soft: true` (data-providers.ts does the same for its own budget aborts) so a
//    slow-but-alive account never mints the generic "<service> connection failed" alert.
//  - err.cause (the real network-layer reason "fetch failed" alone omits) is appended, and the
//    account's own secret is scrubbed, before the row is ever written -- same helpers
//    data-providers.ts uses for every other provider's health row.
interface GetJsonOutcome<T> {
  data?: T;
  /** HTTP status when the server answered (ok or not). Absent on a transport failure. */
  status?: number;
  /** Short, secret-scrubbed failure text (HTTP status + a trimmed body, or the transport error). */
  error?: string;
}

const ERROR_BODY_MAX_CHARS = 200;

async function getJsonDetailed<T>(
  baseUrl: string,
  path: string,
  service: string,
  apiKey: string,
  secretKey: string | undefined,
  keySource: ApiKeySource
): Promise<GetJsonOutcome<T>> {
  const url = `${baseUrl}${path}`;
  const start = Date.now();
  const scrub = (text: string) => scrubProviderErrorText(scrubProviderErrorText(text, secretKey), apiKey);
  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        headers: authHeaders(apiKey, secretKey),
        cache: "no-store",
        signal: controller.signal,
      });
      logApiHealth({
        service,
        ok: response.ok,
        latencyMs: Date.now() - start,
        errorText: response.ok ? undefined : `HTTP ${response.status}`,
        keySource,
      });
      if (!response.ok) {
        // Keep the broker's own reason (e.g. Alpaca's `{"code":…,"message":"invalid activity
        // type"}`) so an ops caller can see WHY a read failed instead of an indistinguishable
        // empty result. Trimmed and scrubbed; never includes request headers.
        let bodyText = "";
        try {
          bodyText = (await response.text()).replace(/\s+/g, " ").trim().slice(0, ERROR_BODY_MAX_CHARS);
        } catch {
          bodyText = "";
        }
        return {
          status: response.status,
          error: scrub(`HTTP ${response.status}${bodyText ? `: ${bodyText}` : ""}`)
        };
      }
      return { data: (await response.json()) as T, status: response.status };
    } catch (err) {
      if (attempt === 0 && !isAbortOrTimeoutError(err) && isTransientNetworkError(err)) {
        await new Promise((resolve) => setTimeout(resolve, jitteredBackoffMs(TRANSIENT_RETRY_BACKOFF_MS, attempt)));
        continue;
      }
      const rawMessage = err instanceof Error ? err.message : String(err);
      // Both credentials are sent as auth material (authHeaders above: APCA-API-KEY-ID +
      // APCA-API-SECRET-KEY, or a Bearer apiKey when secretKey is absent), so both must be
      // scrubbed from a transport-error cause before it reaches api_health_log — scrubbing only
      // secretKey left apiKey exposed verbatim whenever it appeared in the appended cause text.
      const errorText = scrub(appendErrorCause(rawMessage, err));
      logApiHealth({
        service,
        ok: false,
        latencyMs: Date.now() - start,
        errorText,
        keySource,
        ...(isAbortOrTimeoutError(err) ? { soft: true } : {})
      });
      return { error: errorText };
    } finally {
      clearTimeout(timeout);
    }
  }
}

async function getJson<T>(
  baseUrl: string,
  path: string,
  service: string,
  apiKey: string,
  secretKey: string | undefined,
  keySource: ApiKeySource
): Promise<T | undefined> {
  return (await getJsonDetailed<T>(baseUrl, path, service, apiKey, secretKey, keySource)).data;
}

const SERVICE = "alpaca-account-insights";

export interface AlpacaPortfolioHistory {
  timestamp: number[];
  equity: number[];
  profit_loss: number[];
  profit_loss_pct: Array<number | null>;
  base_value?: number;
  timeframe: string;
}

export interface AlpacaCalendarDay {
  date: string;
  open: string;
  close: string;
  session_open?: string;
  session_close?: string;
}

export interface AlpacaMarketClock {
  timestamp: string;
  is_open: boolean;
  next_open: string;
  next_close: string;
}

export interface AlpacaAccountActivity {
  id: string;
  activity_type: string;
  // Trade activities (fills) carry transaction_time/type/price/qty/side/symbol/order_id;
  // non-trade activities (dividends, transfers, fees) carry date/net_amount/description.
  transaction_time?: string;
  date?: string;
  type?: string;
  price?: string;
  qty?: string;
  side?: string;
  symbol?: string;
  leaves_qty?: string;
  cum_qty?: string;
  order_id?: string;
  order_status?: string;
  net_amount?: string;
  per_share_amount?: string;
  description?: string;
  status?: string;
  /** Non-trade activities: Alpaca's creation timestamp (when present) and sub-type. */
  created_at?: string;
  activity_sub_type?: string;
}

// Equity-curve time series (GET /v2/account/portfolio/history). Returns undefined when no
// Alpaca credential is available or the request fails.
export async function fetchAlpacaPortfolioHistory(
  userId: string,
  opts: { period?: string; timeframe?: string; connectedAccountId?: string; start?: string; end?: string } = {}
): Promise<AlpacaPortfolioHistory | undefined> {
  const creds = resolvePrivateAlpacaAccount(userId, opts.connectedAccountId);
  if (!creds) return undefined;

  const params = new URLSearchParams();
  if (opts.period) params.set("period", opts.period);
  if (opts.timeframe) params.set("timeframe", opts.timeframe);
  if (opts.start) params.set("start", opts.start);
  if (opts.end) params.set("end", opts.end);
  const query = params.toString();
  const path = `/v2/account/portfolio/history${query ? `?${query}` : ""}`;
  return getJson<AlpacaPortfolioHistory>(tradingBase(creds.environment), path, SERVICE, creds.apiKey, creds.secretKey, creds.source);
}

export interface AlpacaDailyEquityPoint {
  /** America/New_York calendar day of the (left-labeled) daily window. */
  day: string;
  /** Alpaca's end-of-day equity for that day. */
  equity: number;
}

function newYorkDay(unixSeconds: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date(unixSeconds * 1000));
}

/**
 * Daily end-of-day equity from Alpaca's own books (GET /v2/account/portfolio/history,
 * timeframe=1D).  Alpaca's daily equity and its activity `date` come from the same ledger, so a
 * withdrawal dated D is reflected in D's close — the day-consistent pairing the HWM replay needs
 * (local portfolio_snapshots are taken at arbitrary run times and can sit on either side of a
 * transfer).  Returns undefined when the read fails or the body is not the documented shape.
 */
export async function fetchAlpacaDailyEquityHistory(
  userId: string,
  opts: { connectedAccountId?: string; start: string; end?: string }
): Promise<AlpacaDailyEquityPoint[] | undefined> {
  // start + end (two of start/end/period, per Alpaca) so the window is exactly what we asked for.
  const history = await fetchAlpacaPortfolioHistory(userId, {
    connectedAccountId: opts.connectedAccountId,
    timeframe: "1D",
    start: opts.start,
    end: opts.end ?? new Date().toISOString()
  });
  if (!history || !Array.isArray(history.timestamp) || !Array.isArray(history.equity)) return undefined;
  if (history.timestamp.length !== history.equity.length) return undefined;
  const points: AlpacaDailyEquityPoint[] = [];
  for (let i = 0; i < history.timestamp.length; i += 1) {
    const ts = Number(history.timestamp[i]);
    const raw = history.equity[i] as number | string | null | undefined;
    if (raw === null || raw === undefined || raw === "") continue;
    const equity = Number(raw);
    if (!Number.isFinite(ts) || !Number.isFinite(equity)) continue;
    points.push({ day: newYorkDay(ts), equity });
  }
  points.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  return points;
}

// Session open/close and holiday info (GET /v2/calendar). Market-wide reference data, so it
// resolves the operator/shared Alpaca credential. Returns an empty array on failure.
export async function fetchAlpacaMarketCalendar(
  opts: { start?: string; end?: string } = {}
): Promise<AlpacaCalendarDay[]> {
  const creds = resolveAlpacaMarketData();
  if (!creds.apiKey) return [];

  const params = new URLSearchParams();
  if (opts.start) params.set("start", opts.start);
  if (opts.end) params.set("end", opts.end);
  const query = params.toString();
  const path = `/v2/calendar${query ? `?${query}` : ""}`;
  const days = await getJson<AlpacaCalendarDay[]>(tradingBase(), path, SERVICE, creds.apiKey, creds.secretKey, creds.source);
  return Array.isArray(days) ? days : [];
}

// Current market open/closed state + next open/close (GET /v2/clock). Returns undefined when
// no Alpaca credential is available or the request fails.
export async function fetchAlpacaMarketClock(): Promise<AlpacaMarketClock | undefined> {
  const creds = resolveAlpacaMarketData();
  if (!creds.apiKey) return undefined;
  return getJson<AlpacaMarketClock>(tradingBase(), "/v2/clock", SERVICE, creds.apiKey, creds.secretKey, creds.source);
}

/** Alpaca `category` filter. Mutually exclusive with `activity_types` (Alpaca rejects both). */
export type AlpacaActivityCategory = "trade_activity" | "non_trade_activity";

export interface AlpacaActivitiesFetchOptions {
  activityTypes?: string[];
  category?: AlpacaActivityCategory;
  pageSize?: number;
  maxPages?: number;
  connectedAccountId?: string;
  after?: string;
  until?: string;
}

/**
 * Honest activity-ledger read. `ok: false` means the broker ledger is UNKNOWN (no credential,
 * HTTP error, transport failure, malformed body) — callers that do money math on flows must
 * not treat that the same as "the account had no deposits or withdrawals".
 */
export interface AlpacaActivitiesFetchResult {
  ok: boolean;
  activities: AlpacaAccountActivity[];
  pages: number;
  /** True when paging stopped at maxPages with a full last page (older rows may be missing). */
  truncated: boolean;
  httpStatus?: number;
  error?: string;
  credentialMissing?: boolean;
  /** Query shape that was sent (no credentials, no account identifiers). */
  query: string;
}

// Account activity/audit log — fills, dividends, transfers (GET /v2/account/activities).
export async function fetchAlpacaAccountActivitiesDetailed(
  userId: string,
  opts: AlpacaActivitiesFetchOptions = {}
): Promise<AlpacaActivitiesFetchResult> {
  const types = (opts.activityTypes ?? [])
    .map((t) => t.trim())
    .filter(Boolean);
  const category = types.length > 0 ? undefined : opts.category;
  const queryShape = category ? `category=${category}` : types.length > 0 ? `activity_types=${types.join(",")}` : "all";
  const creds = resolvePrivateAlpacaAccount(userId, opts.connectedAccountId);
  if (!creds) {
    return {
      ok: false,
      activities: [],
      pages: 0,
      truncated: false,
      credentialMissing: true,
      error: "no private Alpaca credential for this account",
      query: queryShape
    };
  }

  const pageSize = Math.max(1, Math.min(100, Math.trunc(opts.pageSize ?? DEFAULT_ACTIVITIES_PAGE_SIZE)));
  const maxPages = Math.max(1, Math.trunc(opts.maxPages ?? DEFAULT_ACTIVITIES_MAX_PAGES));
  const all: AlpacaAccountActivity[] = [];
  let pageToken: string | undefined;
  let pages = 0;
  let truncated = false;

  for (let page = 0; page < maxPages; page += 1) {
    const params = new URLSearchParams();
    if (types.length > 0) params.set("activity_types", types.join(","));
    else if (category) params.set("category", category);
    params.set("page_size", String(pageSize));
    if (opts.after) params.set("after", opts.after);
    if (opts.until) params.set("until", opts.until);
    if (pageToken) params.set("page_token", pageToken);
    const path = `/v2/account/activities?${params.toString()}`;
    const outcome = await getJsonDetailed<AlpacaAccountActivity[]>(
      tradingBase(creds.environment),
      path,
      SERVICE,
      creds.apiKey,
      creds.secretKey,
      creds.source
    );
    if (outcome.data === undefined || !Array.isArray(outcome.data)) {
      // A failure on ANY page leaves the ledger incomplete — report it rather than returning a
      // silently short list that reads as "no more transfers".
      return {
        ok: false,
        activities: all,
        pages,
        truncated: false,
        httpStatus: outcome.status,
        error: outcome.error ?? (outcome.data === undefined ? "activity read failed" : "activity response was not a list"),
        query: queryShape
      };
    }
    pages += 1;
    const activities = outcome.data;
    if (activities.length === 0) break;
    all.push(...activities);
    if (activities.length < pageSize) break;
    const nextToken = activities[activities.length - 1]?.id;
    if (!nextToken || nextToken === pageToken) break;
    pageToken = nextToken;
    if (page === maxPages - 1) truncated = true;
  }

  return { ok: true, activities: all, pages, truncated, query: queryShape };
}

/**
 * Fallback filter for an API that rejects `category`: only codes published in Alpaca's Trading
 * API account-activities list (never "DIVTX", which is not an Alpaca type).
 */
const NON_TRADE_FALLBACK_ACTIVITY_TYPES = [
  "CSD",
  "CSW",
  "ACATC",
  "ACATS",
  "JNLC",
  "JNLS",
  "DIV",
  "DIVNRA",
  "DIVTXEX",
  "INT",
  "FEE",
  "PTC"
];

/**
 * Every non-trade activity (deposits, withdrawals, IRA contributions/distributions, withholding,
 * dividends, fees, journals, …) via `category=non_trade_activity`, so classification happens on
 * our side and an unanticipated type is surfaced instead of filtered away.  Falls back to an
 * explicit documented type list only when Alpaca rejects the category parameter itself (400/422).
 */
export async function fetchAlpacaNonTradeActivities(
  userId: string,
  opts: Omit<AlpacaActivitiesFetchOptions, "activityTypes" | "category"> = {}
): Promise<AlpacaActivitiesFetchResult & { fallbackFrom?: string }> {
  const primary = await fetchAlpacaAccountActivitiesDetailed(userId, { ...opts, category: "non_trade_activity" });
  if (primary.ok || primary.credentialMissing) return primary;
  if (primary.httpStatus !== 400 && primary.httpStatus !== 422) return primary;
  const fallback = await fetchAlpacaAccountActivitiesDetailed(userId, {
    ...opts,
    activityTypes: NON_TRADE_FALLBACK_ACTIVITY_TYPES
  });
  return { ...fallback, fallbackFrom: `category=non_trade_activity rejected (${primary.error ?? "HTTP " + primary.httpStatus})` };
}

// Back-compat list form: returns an empty array when no Alpaca credential is available or the
// request fails. Money-path callers (drawdown HWM) use the Detailed form so a failure is visible.
export async function fetchAlpacaAccountActivities(
  userId: string,
  opts: AlpacaActivitiesFetchOptions = {}
): Promise<AlpacaAccountActivity[]> {
  return (await fetchAlpacaAccountActivitiesDetailed(userId, opts)).activities;
}

export interface AlpacaAccountEquitySnapshot {
  equity: number;
  portfolioValue: number;
  accountNumber?: string;
}

/** GET /v2/account equity fields. Returns undefined when credentials are missing or the call fails. */
export async function fetchAlpacaAccountEquity(
  userId: string,
  opts: { connectedAccountId?: string } = {}
): Promise<AlpacaAccountEquitySnapshot | undefined> {
  const creds = resolvePrivateAlpacaAccount(userId, opts.connectedAccountId);
  if (!creds) return undefined;
  const account = await getJson<{
    equity?: string | number;
    portfolio_value?: string | number;
    account_number?: string;
  }>(tradingBase(creds.environment), "/v2/account", SERVICE, creds.apiKey, creds.secretKey, creds.source);
  if (!account) return undefined;
  const equity = Number(account.equity ?? account.portfolio_value);
  const portfolioValue = Number(account.portfolio_value ?? account.equity);
  if (!Number.isFinite(equity) && !Number.isFinite(portfolioValue)) return undefined;
  return {
    equity: Number.isFinite(equity) ? equity : portfolioValue,
    portfolioValue: Number.isFinite(portfolioValue) ? portfolioValue : equity,
    accountNumber: account.account_number != null ? String(account.account_number) : undefined
  };
}
