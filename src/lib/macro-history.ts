/**
 * Short trailing histories for the most trend-relevant macro series, fetched from FRED, so the
 * Macro tab can draw sparklines (the main macro layer only keeps the latest value per series).
 * Daily series only (smooth sparklines); cached 12h. Free FRED key required — without it this
 * returns {} and the UI simply omits the trends. Never fabricated.
 */

import { resolveApiKeyWithSource, type ApiKeySource } from "./db";
import { expiresAtRespectingMarketClose } from "./market-hours";

const FRED_OBS_URL = "https://api.stlouisfed.org/fred/series/observations";
const POINTS = 90; // ~4–5 months of daily observations

/** Friendly key → FRED series id, for the curated set we sparkline. */
const SERIES: Record<string, string> = {
  tenY: "DGS10",
  twoY: "DGS2",
  vix: "VIXCLS",
  hyCreditSpread: "BAMLH0A0HYM2",
  usd: "DTWEXBGS",
  wti: "DCOILWTICO"
};

export type MacroHistory = Partial<Record<keyof typeof SERIES | string, number[]>>;

// ── Cache-provenance scoping (mirrors src/lib/history.ts) ─────────────────────
// Same FRED-key provenance concern as macro.ts: a user-keyed FRED sparkline fetch
// must NOT populate a shared cache that is then served to all other users for 12h.
//
// Opt-in env flag: MARKET_DATA_SHARE_USER_KEYED_MACRO_HISTORY (default OFF).
// Safe default: unknown provenance → private.

interface MacroHistoryCacheEntry { expiresAt: number; data: MacroHistory }

const sharedMacroHistoryCache: { entry: MacroHistoryCacheEntry | null } = { entry: null };
const privateMacroHistoryCache = new Map<string, MacroHistoryCacheEntry>();

function macroHistoryCacheScopeForKeySource(source: ApiKeySource): "shared" | "private" {
  if (source === "env") return "shared";
  if (source === "user") return shareUserKeyedMacroHistory() ? "shared" : "private";
  return "shared"; // "none" → empty result, safe to share
}

function shareUserKeyedMacroHistory(): boolean {
  const value = (process.env.MARKET_DATA_SHARE_USER_KEYED_MACRO_HISTORY ?? "off").trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function readMacroHistoryCache(scope: "shared" | "private", userId: string | undefined, now: number): MacroHistory | null {
  if (scope === "private") {
    const key = `user:${userId ?? "local"}`;
    const entry = privateMacroHistoryCache.get(key);
    if (entry && entry.expiresAt > now) return entry.data;
  }
  const shared = sharedMacroHistoryCache.entry;
  if (shared && shared.expiresAt > now) return shared.data;
  return null;
}

function writeMacroHistoryCache(scope: "shared" | "private", userId: string | undefined, data: MacroHistory, expiresAt: number): void {
  if (scope === "shared") {
    sharedMacroHistoryCache.entry = { expiresAt, data };
  } else {
    privateMacroHistoryCache.set(`user:${userId ?? "local"}`, { expiresAt, data });
  }
}

const CACHE_TTL_MS = 12 * 60 * 60_000;

async function fetchSeriesHistory(seriesId: string, apiKey: string): Promise<number[] | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const url = `${FRED_OBS_URL}?series_id=${seriesId}&limit=${POINTS}&sort_order=desc&api_key=${apiKey}&file_type=json`;
    const res = await fetch(url, { cache: "no-store", signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const json = (await res.json()) as { observations?: Array<{ value?: string }> };
    const obs = json?.observations ?? [];
    // API returns newest-first; reverse to chronological and drop missing ('.') values.
    const values: number[] = [];
    for (let i = obs.length - 1; i >= 0; i--) {
      const v = obs[i]?.value;
      if (typeof v === "string" && v !== ".") {
        const n = Number(v);
        if (Number.isFinite(n)) values.push(n);
      }
    }
    return values.length >= 5 ? values : null;
  } catch {
    clearTimeout(timeout);
    return null;
  }
}

export async function fetchMacroHistory(now: number = Date.now(), userId?: string): Promise<MacroHistory> {
  const { key: apiKey, source } = resolveApiKeyWithSource("fred", userId);
  const scope = macroHistoryCacheScopeForKeySource(source);

  const cached = readMacroHistoryCache(scope, userId, now);
  if (cached) return cached;

  if (!apiKey) return {};

  const entries = Object.entries(SERIES);
  const results = await Promise.all(entries.map(([, id]) => fetchSeriesHistory(id, apiKey).catch(() => null)));
  const data: MacroHistory = {};
  entries.forEach(([key], i) => {
    const series = results[i];
    if (series && series.length > 0) data[key] = series;
  });

  // Only cache a non-empty result, so a cold-start FRED hiccup self-heals on the next poll
  // instead of caching an empty trends panel for 12h.
  if (Object.keys(data).length > 0) {
    writeMacroHistoryCache(scope, userId, data, expiresAtRespectingMarketClose(new Date(now), CACHE_TTL_MS));
  }
  return data;
}


const SPARK_CHARS = "▁▂▃▄▅▆▇█";

/** Friendly prompt labels for the curated FRED history series. */
const SERIES_PROMPT_LABEL: Record<keyof typeof SERIES, string> = {
  tenY: "10Y",
  twoY: "2Y",
  vix: "VIX",
  hyCreditSpread: "HY",
  usd: "USD",
  wti: "WTI"
};

export interface MacroTrendPoint {
  /** Latest observation in the series. */
  last: number;
  /** Absolute change vs ~7 daily observations earlier (when available). */
  d7?: number;
  /** Absolute change vs ~30 daily observations earlier (when available). */
  d30?: number;
  /** Short unicode sparkline over the trailing ~20 points (levels, not returns). */
  spark: string;
}

export interface MacroTrendsForPrompt {
  note: string;
  series: Partial<Record<string, MacroTrendPoint>>;
}

function sparkline(values: number[], width = 20): string {
  const slice = values.slice(-width);
  if (slice.length < 2) return "";
  let min = slice[0];
  let max = slice[0];
  for (const v of slice) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const range = max - min || 1;
  return slice
    .map((v) => {
      const idx = Math.min(SPARK_CHARS.length - 1, Math.max(0, Math.floor(((v - min) / range) * (SPARK_CHARS.length - 1))));
      return SPARK_CHARS[idx];
    })
    .join("");
}

function absoluteDelta(values: number[], lookback: number): number | undefined {
  if (values.length <= lookback) return undefined;
  const last = values[values.length - 1];
  const prev = values[values.length - 1 - lookback];
  return Number((last - prev).toFixed(2));
}

/**
 * Compact trailing macro trends for Green/Red prompts. Dashboard already had the raw series via
 * `fetchMacroHistory`; until 2026-09-18 neither LLM saw slopes — only latest scalars from
 * `pruneMacro`. Returns `undefined` when history is empty so the prompt block is omitted entirely
 * (never an empty scaffold). Fail-open at the call site.
 */
export function compactMacroTrendsForPrompt(history: MacroHistory): MacroTrendsForPrompt | undefined {
  const series: MacroTrendsForPrompt["series"] = {};
  for (const key of Object.keys(SERIES) as Array<keyof typeof SERIES>) {
    const values = history[key];
    if (!values || values.length < 5) continue;
    const last = values[values.length - 1];
    if (!Number.isFinite(last)) continue;
    const point: MacroTrendPoint = {
      last: Number(last.toFixed(2)),
      spark: sparkline(values, 20)
    };
    const d7 = absoluteDelta(values, 7);
    const d30 = absoluteDelta(values, 30);
    if (d7 !== undefined) point.d7 = d7;
    if (d30 !== undefined) point.d30 = d30;
    if (!point.spark) continue;
    series[SERIES_PROMPT_LABEL[key]] = point;
  }
  if (Object.keys(series).length === 0) return undefined;
  return {
    note: "Trailing FRED daily levels with ~7d/~30d absolute deltas and a 20-point sparkline (10Y, 2Y, VIX, HY OAS, USD, WTI). Levels without slopes are incomplete — weigh trend breaks next to macroeconomicData scalars. Not a trade signal by itself.",
    series
  };
}

/** Clear both caches (test helper). */
export function clearMacroHistoryCacheForTests(): void {
  sharedMacroHistoryCache.entry = null;
  privateMacroHistoryCache.clear();
}
