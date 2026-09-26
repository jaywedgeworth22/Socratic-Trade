// Free daily OHLC price-history fetch — the single source of bars for the app.
//
// Two consumers share this: the technical connector (`web-sources/technical.ts`, which
// only reads closes) and the symbol-drilldown price chart (`/api/history`, which needs
// full candles). Sources cascade keyed-first then free floor before last-resort keyed:
// local flat-files → imported/App A → connected brokers (Tradier / Alpaca / Robinhood)
// → Massive → ROIC.ai → Tiingo → Yahoo → Marketstack.
// Broker-owned bars come BEFORE paid third parties so a connected venue lifts Massive/ROIC/Tiingo
// spend and is usually the same tape the account would fill against.
// Capability matrix ranks Yahoo `good` and Marketstack `last_resort` for ohlcv_daily — Yahoo
// is the free floor; Marketstack only runs after Yahoo fails. Keyed Massive/ROIC/Tiingo stay
// ahead of Yahoo when present. Yahoo chart 429s fail fast when Marketstack can still try.
// Server-side only; cached briefly. Never fabricates — no bars → returns null, callers
// degrade to "—".
//
// ROIC.ai (api.roic.ai v3 stock-prices) is ST-side only: Congress.Trade (App A) reads
// prices exclusively via ST's peer market-read routes (PRICE_PROVIDER=peer) after ST has
// cached the series. CT never holds a ROIC key.
//
// Stooq was the terminal free fallback here until 2026-08: research confirmed its daily-CSV
// endpoint now sits behind an Anubis-style JS proof-of-work wall (bot-blocked, not merely
// rate-limited) — integrating around that would mean circumventing bot protection, so the tier
// was removed rather than kept as permanently-dead code. `parseStooqCsv` stays exported (still
// unit-tested as a pure parser, and re-exported from web-sources/technical.ts for back-compat)
// in case a future non-bot-walled CSV source needs the same shape.

import fs from "fs";
import path from "path";
import zlib from "zlib";
import type { OHLCBar } from "./indicators";
export type { OHLCBar };
import { dataSourceFetch } from "./data-source-fetch";
import { normalizeSymbol, toAlpacaSymbol } from "./money";
import { audit, fulfillMarketDataDemand, getConnectedAccountByBroker, getImportedPriceCloses, getImportedSpxCloses, hasDataPoolConsent, recordMarketDataDemand, resolveApiKeyWithSource, upsertImportedPrices, type ApiKeySource } from "./db";
import { emitDashboardEvent } from "./events";
import { expiresAtRespectingMarketClose, latestCompletedTradingSessionEtKey } from "./market-hours";
import { recordProviderCall } from "./usage-monitor-push";
import { massiveApiBase, reserveMassiveRestCall } from "./market-signals/massive";
import { fetchRobinhoodHistoricals } from "./robinhood";
import { appAClosesToBars, congressReadsEnabled, getCongressTradeClient } from "./api-clients/congress";
import { BROWSER_UA, politeFetchJson } from "./web-sources/http";
import { admitProviderRequests } from "./provider-rate-limit";
import { apiKeyFingerprint } from "./data-providers";
import { fetchHistoryCacheEod, upsertHistoryCacheEod } from "./history-cache";
const DEFAULT_TTL_MS = 30 * 60_000; // daily bars only move intraday on the last candle
const cache = new Map<string, { expiresAt: number; bars: OHLCBar[] }>();
const KEYED_HISTORY_SERVICES = ["massive", "roic", "marketstack", "tiingo"] as const;
type CacheScope = "shared" | "private" | "pool";

interface YahooChartResponse {
  chart?: {
    result?: Array<{
      timestamp?: number[];
      indicators?: {
        quote?: Array<{
          open?: Array<number | null>;
          high?: Array<number | null>;
          low?: Array<number | null>;
          close?: Array<number | null>;
          volume?: Array<number | null>;
        }>;
        /** Split-and-dividend-adjusted closes — prefer these over quote.close for multi-year returns. */
        adjclose?: Array<{ adjclose?: Array<number | null> }>;
      };
    }>;
  };
}

function historyTtlMs(): number {
  const v = Number(process.env.HISTORY_TTL_MS ?? DEFAULT_TTL_MS);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_TTL_MS;
}

// ── Yahoo v8/finance/chart HTTP 429 hardening ────────────────────────────────
// Live-verified 2026-08-02: this endpoint does NOT require the crumb+cookie session handshake that
// v7/finance/quote and v10/finance/quoteSummary now enforce (401 "Invalid Crumb" without one) — a
// plain GET with a browser User-Agent (BROWSER_UA) returns real chart data. What it DOES do is
// intermittently rate-limit (HTTP 429) shared/datacenter egress IPs in short bursts that usually
// clear within a second or two. `politeFetchJson` already retries once on 429 (web-sources/http.ts),
// but a single retry isn't always enough for this specific bot-detection pattern, so this dedicated
// helper layers true exponential backoff on top, retrying ONLY on 429 — any other failure (network
// error, timeout, non-429 status) still fails on the first attempt so the cascade degrades to the
// next tier promptly instead of stalling.
//
// When a later live tier still exists (Marketstack), keep Yahoo attempts short (2) so a 429 burst
// does not stall the serial cascade for ~4×9s before the last-resort keyed source can run. When
// Yahoo is the terminal floor, keep the longer retry budget.
const YAHOO_CHART_TIMEOUT_MS = 9000;
const YAHOO_CHART_MAX_ATTEMPTS = 4; // terminal floor: 1 initial try + 3 retries
const YAHOO_CHART_FAST_FAIL_ATTEMPTS = 2; // later tier present: 1 initial + 1 retry
const YAHOO_CHART_BASE_BACKOFF_MS = 400;

async function fetchYahooChartJson<T>(
  url: string,
  opts?: { maxAttempts?: number }
): Promise<T> {
  const maxAttempts = opts?.maxAttempts ?? YAHOO_CHART_MAX_ATTEMPTS;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), YAHOO_CHART_TIMEOUT_MS);
    try {
      const res = await dataSourceFetch(url, {
        headers: { "user-agent": BROWSER_UA, accept: "application/json" },
        cache: "no-store",
        signal: controller.signal
      });
      if (res.status === 429 && attempt < maxAttempts - 1) {
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(4000, YAHOO_CHART_BASE_BACKOFF_MS * 2 ** attempt))
        );
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return (await res.json()) as T;
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new Error(`HTTP 429 for ${url} (exhausted retries)`);
}

/**
 * Evaluates whether a series of daily OHLC bars is fresh: the latest bar must include the most
 * recently completed US equity trading session (session-counted, not calendar days).
 */
export function isBarSeriesFresh(bars: OHLCBar[] | null, now: number = Date.now()): boolean {
  if (!bars || bars.length < 2) return false;
  const lastBar = bars[bars.length - 1];
  if (!lastBar || lastBar.time == null) return false;
  const lastBarDay = toBusinessDay(lastBar.time);
  if (!lastBarDay) return false;
  const latestExpected = latestCompletedTradingSessionEtKey(now);
  return lastBarDay >= latestExpected;
}

/**
 * Merges historical bars with incoming fresh bars by date YYYY-MM-DD, sorting ascending.
 */
export function mergeOHLCBars(existing: OHLCBar[], incoming: OHLCBar[]): OHLCBar[] {
  const map = new Map<string, OHLCBar>();
  const toKey = (b: OHLCBar) => {
    if (!b.time) return "";
    if (typeof b.time === "string") return b.time.slice(0, 10);
    const ms = typeof b.time === "number" ? (b.time < 1e10 ? b.time * 1000 : b.time) : 0;
    const d = new Date(ms);
    return d.toISOString().slice(0, 10);
  };

  for (const b of existing) {
    const k = toKey(b);
    if (k) map.set(k, b);
  }
  for (const b of incoming) {
    const k = toKey(b);
    if (k) {
      const prev = map.get(k);
      map.set(k, { ...prev, ...b });
    }
  }

  return Array.from(map.values()).sort((a, b) => {
    const tA = typeof a.time === "number" ? a.time : typeof a.time === "string" ? new Date(a.time).getTime() : 0;
    const tB = typeof b.time === "number" ? b.time : typeof b.time === "string" ? new Date(b.time).getTime() : 0;
    return tA - tB;
  });
}

function persistEodBarsToCache(symbol: string, bars: OHLCBar[]): void {
  try {
    const pricesInput = [{
      ticker: symbol,
      closes: bars.map((b) => {
        const dStr = typeof b.time === "string"
          ? b.time.slice(0, 10)
          : new Date(typeof b.time === "number" ? (b.time < 1e10 ? b.time * 1000 : b.time) : 0).toISOString().slice(0, 10);
        return {
          date: dStr,
          close: b.close,
          volume: b.volume
        };
      })
    }];
    upsertImportedPrices(pricesInput, "eod-auto-cache");
  } catch {
    // Non-fatal if DB write fails
  }

  try {
    const baseDir = path.join(process.cwd(), "data", "history-5y");
    if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true });
    const targetFile = path.join(baseDir, `${symbol.toUpperCase()}.json`);
    const formatted = bars.map((b) => ({
      t: typeof b.time === "number" ? b.time : typeof b.time === "string" ? new Date(b.time).getTime() : 0,
      o: b.open,
      h: b.high,
      l: b.low,
      c: b.close,
      v: b.volume
    }));
    fs.writeFileSync(targetFile, JSON.stringify(formatted));
  } catch {
    // Non-fatal if disk write fails
  }
}


/**
 * Fetch ~5y of daily OHLC bars for a symbol, cached briefly. Cascades keyed providers
 * first (reliable, generous limits): Massive → ROIC.ai → Tradier → Tiingo →
 * Marketstack, then free Yahoo. Keyed sources are skipped when no user/env key is
 * available. Returns the first source that yields ≥2 bars, or null (never fabricated).
 * ROIC is operator-key only (ROIC_API_KEY); CT (App A) never holds a ROIC key — it
 * pulls via ST market-read peer routes after ST has cached the series.
 */
export async function fetchDailyOHLC(
  rawSymbol: string,
  now: number = Date.now(),
  userId?: string,
  opts?: { skipAppATier?: boolean; usageLabel?: string },
): Promise<OHLCBar[] | null> {
  const symbol = normalizeSymbol(rawSymbol);
  if (!symbol) return null;

  const keySources: Record<(typeof KEYED_HISTORY_SERVICES)[number], { key?: string; source: ApiKeySource }> = {
    massive: resolveApiKeyWithSource("massive", userId),
    roic: resolveApiKeyWithSource("roic", userId),
    marketstack: resolveApiKeyWithSource("marketstack", userId),
    tiingo: resolveApiKeyWithSource("tiingo", userId)
  };
  const tradierCredential = resolveTradierHistoryCredential();
  const alpacaHistory = resolveAlpacaHistoryCredential(userId);
  const privateCacheKey = historyCacheKey(symbol, userId, "private");
  const poolCacheKey = historyCacheKey(symbol, userId, "pool");
  const sharedCacheKey = historyCacheKey(symbol, userId, "shared");

  const consented = hasDataPoolConsent(userId ?? "local");
  const privateHit = cache.get(privateCacheKey);
  if (privateHit && privateHit.expiresAt > now) return privateHit.bars;
  if (consented) {
    const poolHit = cache.get(poolCacheKey);
    if (poolHit && poolHit.expiresAt > now) return poolHit.bars;
  }
  const sharedHit = cache.get(sharedCacheKey);
  if (sharedHit && sharedHit.expiresAt > now) return sharedHit.bars;

  // 1. Evaluate local SQLite history cache
  const localBars = await fetchHistoryCacheEod(symbol);
  if (localBars && localBars.length >= 2 && isBarSeriesFresh(localBars, now)) {
    const stampedLocal = stampOhlcBarProvenance(localBars, "history-cache-eod", new Date(now).toISOString());
    cache.set(sharedCacheKey, { expiresAt: expiresAtRespectingMarketClose(new Date(now), historyTtlMs()), bars: stampedLocal });
    emitHistoryDemandFilled(symbol, now);
    return stampedLocal;
  }

  // If localBars exists but is STALE, retain for topping up with active provider data
  const staleLocalBars = localBars && localBars.length >= 2 ? localBars : null;

  const startDate = new Date(now - 1825 * 24 * 60 * 60_000).toISOString().slice(0, 10);
  const sources: Array<{
    scope: CacheScope;
    sourceId: string;
    fetch: () => Promise<OHLCBar[] | null>;
  }> = [
    // Local imported-EOD cache tier (congress.trade return-path): App A POSTs gap-fill closes to
    // /api/admin/securities/import; they land in imported_price_eod/imported_spx_eod. Reading the local
    // table first (ahead of the App A HTTP read and our keyed providers) lets an imported series displace
    // a re-fetch entirely. DEFAULT OFF + density-guarded inside fetchImportedHistory so a sparse gap-fill
    // never short-circuits with an incomplete series. Close-only bars.
    { scope: "shared", sourceId: "imported-eod", fetch: async () => fetchImportedHistory(symbol) },
    ...(opts?.skipAppATier
      ? []
      : [{ scope: "shared" as const, sourceId: "congress.trade", fetch: () => fetchAppAHistory(symbol) }]),
    // Connected-broker tier BEFORE paid third parties: a connected venue is already paid
    // for by the account, matches the fill tape, and lifts Massive/ROIC/Tiingo spend.
    {
      scope: "shared",
      sourceId: "tradier",
      fetch: () => fetchTradier(symbol, startDate, tradierCredential.key, tradierCredential.baseUrl)
    },
    {
      scope: cacheScopeForKeySource(alpacaHistory.source, userId),
      sourceId: "alpaca",
      fetch: () => fetchAlpacaDaily(symbol, startDate, alpacaHistory.apiKey, alpacaHistory.secretKey)
    },
    ...(userId
      ? [
          {
            scope: cacheScopeForKeySource("user", userId),
            sourceId: "robinhood",
            fetch: () => fetchRobinhoodHistoricals(symbol, { interval: "day", span: "5year", userId })
          }
        ]
      : []),
    {
      scope: cacheScopeForKeySource(keySources.massive.source, userId),
      sourceId: "massive",
      fetch: () => fetchMassive(symbol, startDate, keySources.massive.key, opts?.usageLabel)
    },
    {
      scope: cacheScopeForKeySource(keySources.roic.source, userId),
      sourceId: "roic",
      fetch: () => fetchRoic(symbol, startDate, keySources.roic.key, opts?.usageLabel)
    },
    {
      scope: cacheScopeForKeySource(keySources.tiingo.source, userId),
      sourceId: "tiingo",
      fetch: () => fetchTiingo(symbol, startDate, keySources.tiingo.key, opts?.usageLabel)
    },
    // Yahoo free floor before Marketstack last_resort (capability matrix ohlcv_daily).
    {
      scope: "shared",
      sourceId: "yahoo-finance",
      fetch: () =>
        fetchYahoo(symbol, {
          // Fail 429s faster when Marketstack can still satisfy the request.
          maxAttempts: keySources.marketstack.key ? YAHOO_CHART_FAST_FAIL_ATTEMPTS : YAHOO_CHART_MAX_ATTEMPTS
        })
    },
    {
      scope: cacheScopeForKeySource(keySources.marketstack.source, userId),
      sourceId: "marketstack",
      fetch: () => fetchMarketstack(symbol, keySources.marketstack.key, opts?.usageLabel)
    }
  ];

  for (const source of sources) {
    const liveBars = await source.fetch();
    if (liveBars && liveBars.length >= 2) {
      const fetchedAt = new Date(now).toISOString();
      const stampedLive = stampOhlcBarProvenance(liveBars, source.sourceId, fetchedAt);
      const finalBars = staleLocalBars
        ? stampOhlcBarProvenance(mergeOHLCBars(staleLocalBars, stampedLive), source.sourceId, fetchedAt)
        : stampedLive;
      persistEodBarsToCache(symbol, finalBars);

      const cacheKey = source.scope === "private" ? privateCacheKey : source.scope === "pool" ? poolCacheKey : sharedCacheKey;
      cache.set(cacheKey, { expiresAt: expiresAtRespectingMarketClose(new Date(now), historyTtlMs()), bars: finalBars });
      if (source.scope === "shared") emitHistoryDemandFilled(symbol, now);
      
      // Persist to the local SQLite cache so future runs can skip the network hop entirely.
      // This handles all fetched tiers (Tradier, Massive, Tiingo, etc.).
      if (source.fetch.name !== "fetchHistoryCacheEod") {
        upsertHistoryCacheEod(symbol, finalBars);
      }
      
      return finalBars;
    }
  }

  // Fallback if active providers hit errors or expired keys: audit warning and return stale local bars
  if (staleLocalBars) {
    const lastBar = staleLocalBars[staleLocalBars.length - 1];
    audit(
      "eod_cache_stale",
      { symbol, lastBarTime: lastBar?.time, note: "All active EOD price history providers failed or expired; falling back to stale local bars." },
      userId ?? "local"
    );
    const stampedStale = stampOhlcBarProvenance(staleLocalBars, "history-cache-eod-stale", new Date(now).toISOString());
    cache.set(sharedCacheKey, { expiresAt: now + 5 * 60_000, bars: stampedStale });
    return stampedStale;
  }

  recordMarketDataDemand({ kind: "history", symbol, userId, now });
  return null;
}

function historyCacheKey(symbol: string, userId: string | undefined, scope: CacheScope): string {
  if (scope === "private") return `user:${userId ?? "local"}:${symbol}`;
  if (scope === "pool") return `pool:${symbol}`;
  return `shared:${symbol}`;
}

/**
 * Stamp every bar in a series with source + fetch clock. Bar `time` remains the session
 * date/as-of; `fetchedAt` is when we obtained the series. Capability ranks: source-capability-matrix
 * `ohlcv_daily`.
 */
export function stampOhlcBarProvenance(
  bars: OHLCBar[],
  source: string,
  fetchedAt: string = new Date().toISOString()
): OHLCBar[] {
  if (!bars.length) return bars;
  const src = source.trim() || "unknown";
  return bars.map((bar) => ({
    ...bar,
    source: bar.source ?? src,
    fetchedAt: bar.fetchedAt ?? fetchedAt
  }));
}

function cacheScopeForKeySource(source: ApiKeySource, userId: string | undefined): CacheScope {
  if (source !== "user") return "shared"; // env-key / free providers are public — everyone benefits.
  // A user's OWN provider key: shared globally if the env override is on; otherwise contributed to
  // the reciprocal POOL when the user has consented; otherwise kept private to that user.
  if (shareUserKeyedHistory()) return "shared";
  if (hasDataPoolConsent(userId ?? "local")) return "pool";
  return "private";
}

function shareUserKeyedHistory(): boolean {
  const value = (process.env.MARKET_DATA_SHARE_USER_KEYED_HISTORY ?? "off").trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function emitHistoryDemandFilled(symbol: string, now: number): void {
  const fill = fulfillMarketDataDemand({ kind: "history", symbol, now });
  if (!fill) return;
  emitDashboardEvent({
    type: "market-data",
    at: new Date(now).toISOString(),
    detail: {
      kind: fill.kind,
      cacheScope: "shared",
      pendingUserCount: fill.pendingUserCount,
      oldestRequestedAt: fill.oldestRequestedAt,
      latestRequestedAt: fill.latestRequestedAt
    }
  });
}

interface MassiveAggBar { t?: number; o?: number; h?: number; l?: number; c?: number; v?: number; vw?: number }
interface MassiveAggResponse { results?: MassiveAggBar[] }

interface RoicPriceRow {
  date?: string;
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  volume?: number;
}
interface RoicStockPricesResponse {
  data?: RoicPriceRow[];
  next_page_url?: string | null;
}

/**
 * Pure mapper for ROIC.ai v3 stock-prices rows → OHLCBar[]. Exported for unit tests.
 * Prefers split-adjusted closes when the caller requested adjustment=splits (the
 * fetch path always does). Volume is always raw session volume per ROIC docs.
 */
export function parseRoicStockPrices(rows: unknown): OHLCBar[] {
  const list = Array.isArray(rows) ? rows : [];
  const bars: OHLCBar[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as RoicPriceRow;
    if (!r.date || typeof r.close !== "number" || !Number.isFinite(r.close)) continue;
    bars.push({
      time: String(r.date).slice(0, 10),
      open: numOrUndef(r.open),
      high: numOrUndef(r.high),
      low: numOrUndef(r.low),
      close: r.close,
      volume: numOrUndef(r.volume),
    });
  }
  // Ascending by date so consumers (MACD/SMA) see chronological series.
  bars.sort((a, b) => String(a.time).localeCompare(String(b.time)));
  return bars;
}

/**
 * ROIC.ai historical daily prices
 * (`GET https://api.roic.ai/v3.0.0/stock-prices/{identifier}`).
 * Free tier: ~2y history + low rpm; paid plans deepen history. Cursor-paginated
 * (limit ≤1000). Shares the "roic" admitProviderRequests bucket with
 * RoicAiEnrichmentProvider so enrichment + history cannot jointly over-burn.
 */
async function fetchRoic(symbol: string, startDate: string, key?: string, usageLabel?: string): Promise<OHLCBar[] | null> {
  if (!key) return null;
  if ((process.env.ROIC_HISTORY_ENABLED ?? "on").toLowerCase() === "off") return null;
  const credKey = await apiKeyFingerprint(key);
  // Reserve one request for the first page; further pages re-admit.
  if (admitProviderRequests("roic", credKey, 1) < 1) return null;

  const to = new Date().toISOString().slice(0, 10);
  // Plain ticker works for US names; exchange-prefixed form is accepted by the API too.
  const identifier = encodeURIComponent(symbol);
  let url: string | null =
    `https://api.roic.ai/v3.0.0/stock-prices/${identifier}` +
    `?apikey=${encodeURIComponent(key)}` +
    `&date.gte=${encodeURIComponent(startDate)}` +
    `&date.lte=${encodeURIComponent(to)}` +
    `&adjustment=splits&order=asc&limit=1000`;

  const all: OHLCBar[] = [];
  let pages = 0;
  const MAX_PAGES = 8; // 8×1000 >> 5y of daily bars
  try {
    while (url && pages < MAX_PAGES) {
      if (pages > 0 && admitProviderRequests("roic", credKey, 1) < 1) break;
      // Explicit types break TS7022 circular inference with `url` reassignment in the loop.
      const json: RoicStockPricesResponse = await politeFetchJson<RoicStockPricesResponse>(url, {
        headers: { Accept: "application/json" },
      });
      pages += 1;
      const pageBars = parseRoicStockPrices(json?.data);
      for (const b of pageBars) all.push(b);
      const next: string | null =
        typeof json?.next_page_url === "string" && json.next_page_url.trim()
          ? json.next_page_url.trim()
          : null;
      // next_page_url is absolute; ensure apikey still present (some page tokens drop query).
      if (next && !/[?&]apikey=/.test(next)) {
        url = next.includes("?")
          ? `${next}&apikey=${encodeURIComponent(key)}`
          : `${next}?apikey=${encodeURIComponent(key)}`;
      } else {
        url = next;
      }
    }
    recordProviderCall("roic", { service: "market-data", ok: all.length >= 2, label: usageLabel });
    // Dedupe by date (overlap across pages) keeping last write.
    const byDate = new Map<string, OHLCBar>();
    for (const b of all) byDate.set(String(b.time), b);
    const bars = [...byDate.values()].sort((a, b) => String(a.time).localeCompare(String(b.time)));
    return bars.length >= 2 ? bars : null;
  } catch {
    recordProviderCall("roic", { service: "market-data", ok: false, label: usageLabel });
    return null;
  }
}

/** Massive daily aggregates (Polygon-compatible REST). Generous limits — the preferred primary. */
async function fetchMassive(symbol: string, startDate: string, key?: string, usageLabel?: string): Promise<OHLCBar[] | null> {
  if (!key) return null;
  if ((process.env.MASSIVE_HISTORY_ENABLED ?? "on").toLowerCase() === "off") return null;
  if (!reserveMassiveRestCall()) return null;
  const base = massiveApiBase();
  const to = new Date().toISOString().slice(0, 10);
  try {
    const url = `${base}/v2/aggs/ticker/${encodeURIComponent(symbol)}/range/1/day/${startDate}/${to}?adjusted=true&sort=asc&limit=50000`;
    const json = await politeFetchJson<MassiveAggResponse>(url, { headers: { Authorization: `Bearer ${key}`, Accept: "application/json" } });
    recordProviderCall("massive", { service: "market-data", ok: true, label: usageLabel });
    const rows = json?.results ?? [];
    const bars: OHLCBar[] = [];
    for (const r of rows) {
      if (typeof r.c !== "number" || !Number.isFinite(r.c) || typeof r.t !== "number") continue;
      bars.push({ time: r.t, open: numOrUndef(r.o), high: numOrUndef(r.h), low: numOrUndef(r.l), close: r.c, volume: numOrUndef(r.v), vwap: numOrUndef(r.vw) });
    }
    return bars.length >= 2 ? bars : null;
  } catch {
    recordProviderCall("massive", { service: "market-data", ok: false, label: usageLabel });
    return null;
  }
}

interface TradierHistoryDay {
  date?: string;
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  volume?: number;
}
interface TradierHistoryResponse {
  history?: { day?: TradierHistoryDay | TradierHistoryDay[] } | null;
}

/**
 * Resolves Tradier's price-history credential from the owner's own CONNECTED broker account
 * (connected_accounts, broker "tradier") rather than a separate stored API key — the owner connects
 * Tradier once (even just as a data source, not necessarily as the active EXECUTION broker — see
 * getConnectedAccountByBroker's doc comment) and that connection's access token becomes the app's
 * Tradier price-history source too. Always resolves the "local" (owner's) connection regardless of
 * the requesting userId — a single connected broker naturally serves the whole app, mirroring the
 * "shared-operator-infra" model every other keyed history provider already uses via an env var, just
 * sourced from a broker connection instead. Sandbox vs production tracks the connection's own
 * `environment`, matching tradier.ts's own derivation for order placement.
 */
/**
 * Alpaca daily bars come from a CONNECTED Alpaca account (the requesting user, else
 * the owner's local connection).  We do not fall back to leftover env paper keys —
 * those would silently spend the operator credential on every tenant history miss.
 */
export function resolveAlpacaHistoryCredential(userId?: string): { apiKey?: string; secretKey?: string; source: ApiKeySource } {
  const scoped = userId ? getConnectedAccountByBroker("alpaca", userId) ?? getConnectedAccountByBroker("alpaca-mcp", userId) : undefined;
  const acct = scoped ?? getConnectedAccountByBroker("alpaca", "local") ?? getConnectedAccountByBroker("alpaca-mcp", "local");
  const liveKey = process.env.ALPACA_LIVE_API_KEY?.trim() ?? process.env.APCA_API_KEY_ID?.trim() ?? process.env.ALPACA_API_KEY?.trim();
  const liveSecret = process.env.ALPACA_LIVE_SECRET_KEY?.trim() ?? process.env.APCA_API_SECRET_KEY?.trim() ?? process.env.ALPACA_SECRET_KEY?.trim();
  return {
    apiKey: acct?.apiKey?.trim() || liveKey || undefined,
    secretKey: acct?.apiSecret?.trim() || liveSecret || undefined,
    source: scoped ? "user" : "env"
  };
}

function resolveTradierHistoryCredential(): { key?: string; baseUrl: string } {
  const acct = getConnectedAccountByBroker("tradier", "local");
  return {
    key: acct?.apiKey?.trim() || undefined,
    baseUrl: acct?.environment === "live" ? "https://api.tradier.com" : "https://sandbox.tradier.com"
  };
}

interface AlpacaDailyBar {
  t?: string;
  o?: number;
  h?: number;
  l?: number;
  c?: number;
  v?: number;
}
interface AlpacaBarsResponse {
  bars?: AlpacaDailyBar[] | Record<string, AlpacaDailyBar[]>;
  next_page_token?: string | null;
}

/**
 * Alpaca IEX daily bars from the market-data credential already on a connected
 * Alpaca account (or the operator paper key).  Same tape as the snapshot
 * cascade.  No extra third-party key.
 */
async function fetchAlpacaDaily(
  symbol: string,
  startDate: string,
  apiKey: string | undefined,
  secretKey: string | undefined
): Promise<OHLCBar[] | null> {
  if (!apiKey || !secretKey) return null;
  const alpacaSymbol = toAlpacaSymbol(symbol);
  try {
    const bars: OHLCBar[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < 8; page += 1) {
      const params = new URLSearchParams({
        timeframe: "1Day",
        start: `${startDate}T00:00:00Z`,
        adjustment: "split",
        limit: "10000",
        feed: "iex"
      });
      if (pageToken) params.set("page_token", pageToken);
      const url = `https://data.alpaca.markets/v2/stocks/${encodeURIComponent(alpacaSymbol)}/bars?${params.toString()}`;
      const json = await politeFetchJson<AlpacaBarsResponse>(url, {
        headers: {
          "APCA-API-KEY-ID": apiKey,
          "APCA-API-SECRET-KEY": secretKey,
          Accept: "application/json"
        }
      });
      const raw = Array.isArray(json?.bars)
        ? json.bars
        : json?.bars && typeof json.bars === "object"
          ? (json.bars[alpacaSymbol] ?? json.bars[symbol] ?? [])
          : [];
      for (const d of raw) {
        if (typeof d.c !== "number" || !Number.isFinite(d.c) || !d.t) continue;
        bars.push({
          time: d.t.slice(0, 10),
          open: numOrUndef(d.o),
          high: numOrUndef(d.h),
          low: numOrUndef(d.l),
          close: d.c,
          volume: numOrUndef(d.v)
        });
      }
      pageToken = json?.next_page_token ?? undefined;
      if (!pageToken) break;
    }
    recordProviderCall("alpaca", { service: "market-data", ok: true });
    return bars.length >= 2 ? bars : null;
  } catch {
    recordProviderCall("alpaca", { service: "market-data", ok: false });
    return null;
  }
}

/** Tradier daily history — brokerage-grade, generous rate limits. Best primary source. */
async function fetchTradier(symbol: string, startDate: string, key: string | undefined, baseUrl: string): Promise<OHLCBar[] | null> {
  if (!key) return null;
  try {
    const url = `${baseUrl}/v1/markets/history?symbol=${encodeURIComponent(symbol)}&interval=daily&start=${startDate}`;
    const json = await politeFetchJson<TradierHistoryResponse>(url, { headers: { Authorization: `Bearer ${key}`, Accept: "application/json" } });
    recordProviderCall("tradier", { service: "market-data", ok: true });
    const day = json?.history?.day;
    const days = Array.isArray(day) ? day : day ? [day] : [];
    const bars: OHLCBar[] = [];
    for (const d of days) {
      if (typeof d.close !== "number" || !Number.isFinite(d.close) || !d.date) continue;
      bars.push({ time: d.date, open: numOrUndef(d.open), high: numOrUndef(d.high), low: numOrUndef(d.low), close: d.close, volume: numOrUndef(d.volume) });
    }
    return bars.length >= 2 ? bars : null;
  } catch {
    recordProviderCall("tradier", { service: "market-data", ok: false });
    return null;
  }
}

interface TiingoPriceRow {
  date?: string;
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  volume?: number;
  adjOpen?: number;
  adjHigh?: number;
  adjLow?: number;
  adjClose?: number;
  adjVolume?: number;
}

/**
 * Tiingo EOD history (`/tiingo/daily/{ticker}/prices`) — 30+ years of split/dividend-adjusted daily
 * bars on the free Starter tier (50 req/hour, 1,000/day, 500 unique symbols/month). Admits against the
 * SAME "tiingo" quota bucket TiingoEnrichmentProvider uses (provider-rate-limit.ts RATE_QUOTAS), since
 * both draw on one real account-wide rate limit — a scan's enrichment calls must not let a chart's
 * history call (or vice versa) blow the hourly cap. Prefers adjOpen/High/Low/Close over the raw OHLC
 * (same technique fetchYahoo uses: scale raw O/H/L by adjClose/close so all four stay on one basis).
 */
async function fetchTiingo(symbol: string, startDate: string, key?: string, usageLabel?: string): Promise<OHLCBar[] | null> {
  if (!key) return null;
  const credKey = await apiKeyFingerprint(key);
  if (admitProviderRequests("tiingo", credKey, 1) < 1) return null; // hourly/daily budget exhausted this pass
  try {
    const url = `https://api.tiingo.com/tiingo/daily/${symbol.toLowerCase()}/prices?startDate=${startDate}&token=${key}`;
    const json = await politeFetchJson<TiingoPriceRow[]>(url, { headers: { Authorization: `Token ${key}`, Accept: "application/json" } });
    recordProviderCall("tiingo", { service: "market-data", ok: true, label: usageLabel });
    const rows = Array.isArray(json) ? json : [];
    const bars: OHLCBar[] = [];
    for (const r of rows) {
      if (!r.date) continue;
      const rawClose = numOrUndef(r.close);
      const adjClose = numOrUndef(r.adjClose);
      const close = adjClose ?? rawClose;
      if (close === undefined) continue;
      let o = numOrUndef(r.open);
      let h = numOrUndef(r.high);
      let l = numOrUndef(r.low);
      if (adjClose !== undefined && rawClose !== undefined && rawClose !== 0) {
        const factor = adjClose / rawClose;
        if (o !== undefined) o = o * factor;
        if (h !== undefined) h = h * factor;
        if (l !== undefined) l = l * factor;
      }
      bars.push({ time: r.date.slice(0, 10), open: o, high: h, low: l, close, volume: numOrUndef(r.adjVolume ?? r.volume) });
    }
    return bars.length >= 2 ? bars : null;
  } catch {
    recordProviderCall("tiingo", { service: "market-data", ok: false, label: usageLabel });
    return null;
  }
}

interface MarketstackEodRow {
  date?: string;
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  volume?: number;
}
interface MarketstackEodResponse {
  data?: MarketstackEodRow[];
}

/** Marketstack EOD — keyed fallback (free tier is monthly-capped, so secondary to Tradier). */
async function fetchMarketstack(symbol: string, key?: string, usageLabel?: string): Promise<OHLCBar[] | null> {
  if (!key) return null;
  try {
    const url = `https://api.marketstack.com/v1/eod?access_key=${key}&symbols=${encodeURIComponent(symbol)}&limit=1500&sort=ASC`;
    const json = await politeFetchJson<MarketstackEodResponse>(url, {});
    recordProviderCall("marketstack", { service: "market-data", ok: true, label: usageLabel });
    const rows = json?.data ?? [];
    const bars: OHLCBar[] = [];
    for (const r of rows) {
      if (typeof r.close !== "number" || !Number.isFinite(r.close) || !r.date) continue;
      bars.push({ time: r.date, open: numOrUndef(r.open), high: numOrUndef(r.high), low: numOrUndef(r.low), close: r.close, volume: numOrUndef(r.volume) });
    }
    return bars.length >= 2 ? bars : null;
  } catch {
    recordProviderCall("marketstack", { service: "market-data", ok: false, label: usageLabel });
    return null;
  }
}

async function fetchYahoo(
  symbol: string,
  opts?: { maxAttempts?: number }
): Promise<OHLCBar[] | null> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1y&interval=1d`;
    const json = await fetchYahooChartJson<YahooChartResponse>(url, opts);
    const result = json?.chart?.result?.[0];
    const ts = result?.timestamp ?? [];
    const q = result?.indicators?.quote?.[0];
    const rawClose = q?.close ?? [];
    // Prefer split+dividend-adjusted closes (adjclose) for correct multi-year returns.
    // Fall back to raw close if adjclose is absent or length-mismatched.
    const adjCloseArr = result?.indicators?.adjclose?.[0]?.adjclose ?? [];
    const useAdjusted = adjCloseArr.length === ts.length;
    if (ts.length === 0 || rawClose.length === 0) return null;
    const bars: OHLCBar[] = [];
    for (let i = 0; i < ts.length; i++) {
      const rawC = rawClose[i] ?? null;
      // Per-bar fallback: if adjclose entry is null/non-finite use rawC so Yahoo gaps
      // in adjclose don't cause bars with valid rawclose to be silently dropped.
      const adjEntry = useAdjusted ? (adjCloseArr[i] ?? null) : null;
      const usingAdj = typeof adjEntry === "number" && Number.isFinite(adjEntry);
      const c = usingAdj ? adjEntry : rawC;
      if (typeof c !== "number" || !Number.isFinite(c)) continue; // skip null/holiday gaps
      // Scale O/H/L by adjclose/rawclose so all four OHLC values stay on the same basis.
      // Candle consistency: close cannot fall outside [low, high] after ex-dividend adjustments.
      let o = numOrUndef(q?.open?.[i]);
      let h = numOrUndef(q?.high?.[i]);
      let l = numOrUndef(q?.low?.[i]);
      if (usingAdj && typeof rawC === "number" && Number.isFinite(rawC) && rawC !== 0) {
        const factor = c / rawC;
        if (o !== undefined) o = o * factor;
        if (h !== undefined) h = h * factor;
        if (l !== undefined) l = l * factor;
      }
      bars.push({
        time: ts[i] * 1000, // seconds → ms epoch
        open: o, high: h, low: l,
        close: c,
        volume: numOrUndef(q?.volume?.[i])
      });
    }
    return bars.length >= 2 ? bars : null;
  } catch {
    return null;
  }
}

/**
 * Parse a Stooq daily CSV (Date,Open,High,Low,Close,Volume) into bars. Pure / unit-tested.
 * The cascade no longer CALLS Stooq (see the header comment — its endpoint sits behind a
 * proof-of-work bot wall as of 2026-08). Kept exported in case a future non-bot-walled CSV
 * source needs the same shape.
 */
export function parseStooqCsv(text: string): OHLCBar[] {
  const out: OHLCBar[] = [];
  for (const line of text.split(/\r?\n/)) {
    const parts = line.split(",");
    if (parts.length < 5) continue;
    const [date, open, high, low, close, volume] = parts;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue; // skips the header row
    const c = Number(close);
    if (!Number.isFinite(c)) continue;
    out.push({
      time: date,
      open: Number(open),
      high: Number(high),
      low: Number(low),
      close: c,
      volume: volume ? Number(volume) : undefined
    });
  }
  return out;
}

/** Normalize a bar's `time` (ms-epoch number or date string) to a 'YYYY-MM-DD' business day. */
export function toBusinessDay(time: number | string | undefined): string | undefined {
  if (typeof time === "number" && Number.isFinite(time)) {
    const ms = time > 1e12 ? time : time * 1000;
    return new Date(ms).toISOString().slice(0, 10);
  }
  if (typeof time === "string") {
    if (/^\d{4}-\d{2}-\d{2}/.test(time)) return time.slice(0, 10);
    const parsed = Date.parse(time);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString().slice(0, 10);
  }
  return undefined;
}

function numOrUndef(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function clearHistoryCache(): void {
  cache.clear();
}

/**
 * congress.trade (App A) cache-aside source: App A's EOD close series for a symbol (or the S&P-500
 * via ^GSPC) as close-only OHLCBars. Returns null unless reads are enabled AND App A has ≥2 closes,
 * so the cascade falls through to App B's own providers on a miss. Self-guarded inside the client.
 */
async function fetchAppAHistory(symbol: string): Promise<OHLCBar[] | null> {
  if (!congressReadsEnabled()) return null;

  let closes: any[] = [];
  try {
    const client = getCongressTradeClient();
    if (symbol === "^GSPC") {
      closes = await client.getSpx();
    } else {
      const resp = await client.getPrices(symbol);
      closes = resp?.closes ?? [];
    }
  } catch (err) {
    // Ignore error, fallback logic kicks in
  }
  const bars = appAClosesToBars(closes);
  return bars.length >= 2 ? bars : null;
}

function importedHistoryTierEnabled(): boolean {
  const v = (process.env.SECURITIES_IMPORT_HISTORY_TIER_ENABLED ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/** Minimum imported closes before the local tier may short-circuit the cascade (avoids sparse gap-fills). */
function importedHistoryMinBars(): number {
  const v = Number(process.env.SECURITIES_IMPORT_MIN_BARS ?? 200);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 200;
}

/**
 * Local imported-EOD cache tier (congress.trade return-path). Serves App A's gap-fill closes that were
 * POSTed to /api/admin/securities/import (persisted in imported_price_eod / imported_spx_eod). DEFAULT
 * OFF (SECURITIES_IMPORT_HISTORY_TIER_ENABLED) and density-guarded (SECURITIES_IMPORT_MIN_BARS, default
 * 200 ≈ ~10 months) so a sparse gap-fill never displaces a full fetch with an incomplete series.
 * Close-only bars (no OHLC), like the App A HTTP tier — an enabled price chart renders a line on hits.
 */
function fetchImportedHistory(symbol: string): OHLCBar[] | null {
  if (!importedHistoryTierEnabled()) return null;
  const closes = symbol === "^GSPC" ? getImportedSpxCloses() : getImportedPriceCloses(symbol);
  if (closes.length < importedHistoryMinBars()) return null;
  const bars = appAClosesToBars(closes);
  return bars.length >= 2 ? bars : null;
}



