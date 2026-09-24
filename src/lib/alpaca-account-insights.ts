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
async function getJson<T>(
  baseUrl: string,
  path: string,
  service: string,
  apiKey: string,
  secretKey: string | undefined,
  keySource: ApiKeySource
): Promise<T | undefined> {
  const url = `${baseUrl}${path}`;
  const start = Date.now();
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
      if (!response.ok) return undefined;
      return (await response.json()) as T;
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
      const errorText = scrubProviderErrorText(scrubProviderErrorText(appendErrorCause(rawMessage, err), secretKey), apiKey);
      logApiHealth({
        service,
        ok: false,
        latencyMs: Date.now() - start,
        errorText,
        keySource,
        ...(isAbortOrTimeoutError(err) ? { soft: true } : {})
      });
      return undefined;
    } finally {
      clearTimeout(timeout);
    }
  }
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
}

// Equity-curve time series (GET /v2/account/portfolio/history). Returns undefined when no
// Alpaca credential is available or the request fails.
export async function fetchAlpacaPortfolioHistory(
  userId: string,
  opts: { period?: string; timeframe?: string; connectedAccountId?: string } = {}
): Promise<AlpacaPortfolioHistory | undefined> {
  const creds = resolvePrivateAlpacaAccount(userId, opts.connectedAccountId);
  if (!creds) return undefined;

  const params = new URLSearchParams();
  if (opts.period) params.set("period", opts.period);
  if (opts.timeframe) params.set("timeframe", opts.timeframe);
  const query = params.toString();
  const path = `/v2/account/portfolio/history${query ? `?${query}` : ""}`;
  return getJson<AlpacaPortfolioHistory>(tradingBase(creds.environment), path, SERVICE, creds.apiKey, creds.secretKey, creds.source);
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

// Account activity/audit log — fills, dividends, transfers (GET /v2/account/activities).
// Returns an empty array when no Alpaca credential is available or the request fails.
export async function fetchAlpacaAccountActivities(
  userId: string,
  opts: {
    activityTypes?: string[];
    pageSize?: number;
    maxPages?: number;
    connectedAccountId?: string;
    after?: string;
    until?: string;
  } = {}
): Promise<AlpacaAccountActivity[]> {
  const creds = resolvePrivateAlpacaAccount(userId, opts.connectedAccountId);
  if (!creds) return [];

  const types = (opts.activityTypes ?? [])
    .map((t) => t.trim())
    .filter(Boolean);
  const pageSize = Math.max(1, Math.min(100, Math.trunc(opts.pageSize ?? DEFAULT_ACTIVITIES_PAGE_SIZE)));
  const maxPages = Math.max(1, Math.trunc(opts.maxPages ?? DEFAULT_ACTIVITIES_MAX_PAGES));
  const all: AlpacaAccountActivity[] = [];
  let pageToken: string | undefined;

  for (let page = 0; page < maxPages; page += 1) {
    const params = new URLSearchParams();
    if (types.length > 0) params.set("activity_types", types.join(","));
    params.set("page_size", String(pageSize));
    if (opts.after) params.set("after", opts.after);
    if (opts.until) params.set("until", opts.until);
    if (pageToken) params.set("page_token", pageToken);
    const path = `/v2/account/activities?${params.toString()}`;
    const activities = await getJson<AlpacaAccountActivity[]>(tradingBase(creds.environment), path, SERVICE, creds.apiKey, creds.secretKey, creds.source);
    if (!Array.isArray(activities) || activities.length === 0) break;
    all.push(...activities);
    if (activities.length < pageSize) break;
    const nextToken = activities[activities.length - 1]?.id;
    if (!nextToken || nextToken === pageToken) break;
    pageToken = nextToken;
  }

  return all;
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
