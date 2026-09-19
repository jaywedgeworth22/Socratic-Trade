// Congressional trade ingestion.
//
// Politicians disclose stock trades on a delay (up to ~45 days). When a disclosure
// lands, copycat retail flow often follows — so surfacing fresh disclosures to the
// agent lets it act on the same names before the copycats pile in.
//
// Sources, in priority order:
//   1. Senate eFD  (efdsearch.senate.gov) — authoritative, free, no key. Validated
//      live: CSRF -> accept terms -> POST report search -> parse each PTR's table.
//      SENATE ONLY (structurally cannot see the House).
//   2. Apify `johnvc` actor — HOUSE coverage (the eFD gap). Keyed (APIFY_API_TOKEN),
//      pay-per-result (~$0.00001/row). Runs the actor synchronously and parses the
//      normalized House Clerk disclosures. House-only by default so it complements eFD.
//   3. Capitol Trades BFF (bff.capitoltrades.com) — public JSON back-end (House+Senate);
//      currently CDN-blocked server-side, kept best-effort/configurable.
//
// All adapters degrade to nothing on failure — we never invent a trade.
//
// Note: The `CongressTrade` type used here is App B's internal representation.
// The shared package's `CongressTransaction` (@jaywedgeworth22/congress-trading-shared)
// is App A's wire format; `coerceCongressTrade()` converts between them.

import { audit, getInternalSetting, resolveApiKey, setInternalSetting } from "../db";
import { congressAsCongressSourceEnabled, getCongressTradeClient } from "../api-clients/congress";
import { normalizeSymbol } from "../money";
import {
  assertOperationLeaseOwnership,
  OPERATION_LEASE_GROUPS,
  runWithOperationLease,
  throwIfOperationLeaseCancelled,
  type OperationLeaseAware,
  type OperationLeaseClaim
} from "../operation-lease";
import type { CongressSignal, CongressTrade } from "./types";
import {
  BROWSER_UA,
  cookieHeader,
  mergeSetCookies,
  politeFetch,
  politeFetchText,
  runRateLimited
} from "./http";

const DATASET_KEY = "webSource:congress:dataset";
const ATTEMPT_KEY = "webSource:congress:lastAttempt";
const DEFAULT_TTL_MS = 24 * 60 * 60_000; // daily; congressional disclosures trickle in every day
const DEFAULT_RETRY_BACKOFF_MS = 60 * 60_000; // wait 1h before retrying after a failed/empty scrape
const DEFAULT_WINDOW_DAYS = 60; // how far back a trade still counts toward the signal
const DEFAULT_LOOKBACK_DAYS = 45; // how far back to pull new filings each refresh
const DEFAULT_MAX_FILINGS = 80; // cap PTR pages fetched per refresh (politeness)
const EFD_BASE = "https://efdsearch.senate.gov";
const DEFAULT_CAPITOL_TRADES_URL = "https://bff.capitoltrades.com/trades?per_page=100&page=1&sortBy=-txDate";

export interface CongressDataset {
  trades: CongressTrade[];
  fetchedAt: string;
  sources: string[];
  recordCount: number;
}

export function congressTtlMs(): number {
  const v = Number(process.env.WEB_SOURCE_CONGRESS_TTL_MS ?? DEFAULT_TTL_MS);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_TTL_MS;
}

function windowDays(): number {
  const v = Number(process.env.WEB_SOURCE_CONGRESS_WINDOW_DAYS ?? DEFAULT_WINDOW_DAYS);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_WINDOW_DAYS;
}

export function getCongressDataset(): CongressDataset | undefined {
  return getInternalSetting<CongressDataset>(DATASET_KEY);
}

// ── Pure parsers (unit-tested without network) ───────────────────────────────

const TICKER_RE = /^[A-Z][A-Z.\-]{0,5}$/;

/** Parse a disclosed dollar range like "$1,001 - $15,000" into numeric bounds. */
export function parseAmountRange(text: string): { amountLow?: number; amountHigh?: number } {
  const nums = (text.match(/\$[\d,]+/g) ?? []).map((s) => Number(s.replace(/[$,]/g, ""))).filter((n) => Number.isFinite(n));
  if (nums.length === 0) return {};
  if (nums.length === 1) return { amountLow: nums[0], amountHigh: nums[0] };
  return { amountLow: nums[0], amountHigh: nums[1] };
}

function toIsoDate(mdy: string): string | undefined {
  const m = mdy.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return undefined;
  const [, mm, dd, yyyy] = m;
  // Range-validate so a corrupt source date (e.g. "13/45/2026") falls through to a
  // fallback instead of producing "2026-13-45", which Date.parse() reads as NaN and
  // then silently slips past the recency-window guard in aggregateCongressSignals.
  const month = Number(mm);
  const day = Number(dd);
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  return `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
}

function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

interface EfdFiling {
  member: string;
  viewUrl: string;
  isPtr: boolean;
  filedAt?: string;
}

/** Parse the DataTables JSON returned by /search/report/data/ into filing rows. */
export function parseEfdReportRows(json: unknown): EfdFiling[] {
  const data = (json as { data?: unknown[] })?.data;
  if (!Array.isArray(data)) return [];
  const filings: EfdFiling[] = [];
  for (const row of data) {
    if (!Array.isArray(row) || row.length < 5) continue;
    const first = stripTags(String(row[0] ?? ""));
    const last = stripTags(String(row[1] ?? ""));
    const linkCell = String(row[3] ?? "");
    const hrefMatch = linkCell.match(/href=["']([^"']+)["']/);
    const href = hrefMatch?.[1];
    if (!href) continue;
    const filedAt = toIsoDate(stripTags(String(row[4] ?? "")));
    filings.push({
      member: `${first} ${last}`.replace(/\s+/g, " ").trim(),
      viewUrl: href.startsWith("http") ? href : `${EFD_BASE}${href}`,
      isPtr: href.includes("/view/ptr/"),
      filedAt
    });
  }
  return filings;
}

/**
 * Parse the transactions table from an e-filed PTR view page. Classifies each cell
 * by content (ticker / date / amount / type) rather than fixed column index, so the
 * parser survives column reordering in the source HTML.
 */
export function parsePtrTransactions(html: string, ctx: { member: string; filedAt?: string }): CongressTrade[] {
  const tbody = html.match(/<tbody>([\s\S]*?)<\/tbody>/i);
  if (!tbody) return [];
  const rowChunks = tbody[1].split(/<tr[^>]*>/i).slice(1);
  const trades: CongressTrade[] = [];
  for (const chunk of rowChunks) {
    const cells = (chunk.match(/<td[^>]*>([\s\S]*?)<\/td>/gi) ?? []).map((c) => stripTags(c));
    if (cells.length < 5) continue;

    // Anchor the ticker to its fixed eFD column (4th cell:
    // [#, txDate, owner, ticker, assetName, assetType, txType, amount, comment]).
    // A row-wide search would mis-grab an all-caps asset-name token (e.g. "GOLD")
    // when the ticker cell is "--" for a non-equity holding, fabricating a trade.
    const ticker = cells[3];
    if (!ticker || ticker === "--" || !TICKER_RE.test(ticker)) continue;

    const typeCell = cells.find((c) => /\b(purchase|sale|exchange)\b/i.test(c));
    if (!typeCell) continue;
    let side: "buy" | "sell";
    if (/purchase/i.test(typeCell)) side = "buy";
    else if (/sale/i.test(typeCell)) side = "sell";
    else continue; // exchanges aren't directional

    const amountCell = cells.find((c) => /\$[\d,]+/.test(c)) ?? "";
    // First date-looking cell that isn't the future-dated nothing; tx date precedes filing.
    const dateCell = cells.map((c) => toIsoDate(c)).find(Boolean);

    trades.push({
      symbol: normalizeSymbol(ticker),
      member: ctx.member,
      chamber: "senate",
      side,
      ...parseAmountRange(amountCell),
      tradedAt: dateCell ?? ctx.filedAt ?? new Date().toISOString().slice(0, 10),
      disclosedAt: ctx.filedAt,
      source: "senate-efd"
    });
  }
  return trades;
}

/** Parse Capitol Trades BFF JSON (best-effort; their field names have shifted over time). */
export function parseCapitolTradesBff(json: unknown): CongressTrade[] {
  const data = (json as { data?: unknown[] })?.data;
  if (!Array.isArray(data)) return [];
  const trades: CongressTrade[] = [];
  for (const raw of data) {
    const row = raw as Record<string, any>;
    const ticker =
      row.asset?.assetTicker ?? row.assetTicker ?? row.ticker ?? row.issuer?.issuerTicker ?? row._stockTicker;
    if (!ticker || typeof ticker !== "string") continue;
    const sym = normalizeSymbol(ticker.split(":")[0]);
    if (!TICKER_RE.test(sym)) continue;
    const txType = String(row.txType ?? row.type ?? "").toLowerCase();
    let side: "buy" | "sell";
    if (/buy|purchase/.test(txType)) side = "buy";
    else if (/sell|sale|sold/.test(txType)) side = "sell";
    else continue;
    const pol = row.politician ?? {};
    const member =
      [pol.firstName, pol.lastName].filter(Boolean).join(" ").trim() ||
      String(row.politicianName ?? "").trim() ||
      "Unknown";
    const chamber: "senate" | "house" = /house|rep/i.test(String(pol.chamber ?? row.chamber ?? "")) ? "house" : "senate";
    const value = Number(row.value ?? row.size ?? NaN);
    trades.push({
      symbol: sym,
      member,
      chamber,
      side,
      ...(Number.isFinite(value) ? { amountLow: value, amountHigh: value } : {}),
      tradedAt: String(row.txDate ?? row.transactionDate ?? "").slice(0, 10) || new Date().toISOString().slice(0, 10),
      disclosedAt: row.pubDate ? String(row.pubDate).slice(0, 10) : undefined,
      source: "capitol-trades"
    });
  }
  return trades;
}

// ── Apify congress actor (House coverage) ────────────────────────────────────

const APIFY_CONGRESS_ACTOR = "johnvc~us-congress-financial-disclosures-and-stock-trading-data";
const DEFAULT_APIFY_MAX_RESULTS = 300;

const OWNER_LABELS: Record<string, string> = { sp: "Spouse", se: "Self", jt: "Joint", jo: "Joint", dc: "Child", ch: "Child" };

/** Validate an ISO date and reject data-quality garbage (e.g. a "2036" future date). */
function saneIsoDate(value: string, now: number): string | undefined {
  const m = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return undefined;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  // Reject impossible calendar dates that would otherwise roll over to a valid timestamp (e.g.
  // "2026-02-30" -> Mar 2): build the UTC date from the components and require it to round-trip.
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return undefined;
  const iso = `${m[1]}-${m[2]}-${m[3]}`;
  const ts = d.getTime();
  if (!Number.isFinite(ts)) return undefined;
  if (ts > now + 3 * 24 * 60 * 60_000) return undefined; // absurd future (allow small skew)
  if (ts < Date.parse("2000-01-01")) return undefined; // absurd past
  return iso;
}

/**
 * Normalize a raw trade-date string to a sane ISO date, REJECTING future-dated values. A trade
 * cannot occur after today, so a future date (e.g. a "12/26/2026" parsed from a corrupt source) is
 * an unambiguous data-quality error — we drop it rather than let it poison the recency window or
 * surface an impossible date in the UI. Accepts ISO directly or a US MM/DD/YYYY value.
 */
function normalizeTradeDate(value: string | undefined, now: number): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  const mdy = toIsoDate(trimmed);
  const iso = saneIsoDate(trimmed, now) ?? (mdy ? saneIsoDate(mdy, now) : undefined);
  if (!iso) return undefined;
  // A congressional trade/disclosure DATE is a timezone-less calendar date, so `saneIsoDate`'s small
  // (±3 day) future skew — meant for timestamps — is too lax here: even tomorrow is impossible.
  // Reject anything strictly after today (lexicographic compare is valid for YYYY-MM-DD).
  const todayIso = new Date(now).toISOString().slice(0, 10);
  return iso > todayIso ? undefined : iso;
}

/** Parse the Apify `johnvc` actor's dataset items into CongressTrade rows (pure). */
export function parseApifyCongress(items: unknown, now: number = Date.now()): CongressTrade[] {
  if (!Array.isArray(items)) return [];
  const out: CongressTrade[] = [];
  for (const raw of items) {
    const row = raw as Record<string, any>;
    const tickerRaw = typeof row.Ticker === "string" ? row.Ticker.trim() : "";
    if (!tickerRaw) continue;
    const sym = normalizeSymbol(tickerRaw.split(":")[0]);
    if (!TICKER_RE.test(sym)) continue;

    const tx = String(row.Transaction_Type ?? "").trim().toLowerCase();
    let side: "buy" | "sell";
    if (/^p/.test(tx)) side = "buy"; // P / Purchase / "P (partial)"
    else if (/^s/.test(tx)) side = "sell"; // S / Sale / "S (partial)" / "Sale (Partial)"
    else continue; // exchanges / other are non-directional

    const chamber: "senate" | "house" = /senate/i.test(String(row.House ?? "")) ? "senate" : "house";
    const member =
      [row.First_Name, row.Last_Name].map((v) => String(v ?? "").trim()).filter(Boolean).join(" ").replace(/\s+/g, " ").trim() || "Unknown";
    const tradedAt = saneIsoDate(String(row.Date ?? ""), now);
    const disclosedAt = saneIsoDate(String(row.Notification_Date ?? ""), now);
    if (!tradedAt && !disclosedAt) continue;
    const ownerCode = String(row.Owner ?? "").trim().toLowerCase();

    out.push({
      symbol: sym,
      member,
      chamber,
      side,
      ...parseAmountRange(String(row.Amount_Range ?? "")),
      ...(OWNER_LABELS[ownerCode] ? { owner: OWNER_LABELS[ownerCode] } : {}),
      tradedAt: tradedAt ?? disclosedAt!,
      disclosedAt,
      source: "apify-congress"
    });
  }
  return out;
}

/**
 * Run the Apify `johnvc` congress actor synchronously and return parsed trades.
 * Keyed by APIFY_API_TOKEN. House-only by default (eFD is authoritative for the Senate);
 * set WEB_SOURCE_APIFY_CONGRESS_CHAMBERS=all to include Senate too. Returns [] when no token.
 */
export async function fetchApifyCongress(now: number = Date.now(), userId?: string): Promise<CongressTrade[]> {
  // Apify is shared-operator-infra: the resolver returns the operator env token for any user
  // (incl. no-userId background refresh), so no direct process.env read is needed here.
  const token = resolveApiKey("apify", userId);
  if (!token) return [];
  const actor = (process.env.WEB_SOURCE_APIFY_CONGRESS_ACTOR || APIFY_CONGRESS_ACTOR).trim();
  if (/^(off|false|disabled|none)$/i.test(actor)) return [];

  const maxRaw = Number(process.env.WEB_SOURCE_APIFY_CONGRESS_MAX ?? DEFAULT_APIFY_MAX_RESULTS);
  const maxResults = Number.isFinite(maxRaw) && maxRaw > 0 ? Math.floor(maxRaw) : DEFAULT_APIFY_MAX_RESULTS;
  const lookbackRaw = Number(process.env.WEB_SOURCE_CONGRESS_WINDOW_DAYS ?? DEFAULT_WINDOW_DAYS);
  const lookback = Number.isFinite(lookbackRaw) && lookbackRaw > 0 ? lookbackRaw : DEFAULT_WINDOW_DAYS;
  const startDate = new Date(now - lookback * 24 * 60 * 60_000).toISOString().slice(0, 10);

  const url = `https://api.apify.com/v2/acts/${actor}/run-sync-get-dataset-items?token=${encodeURIComponent(token)}`;
  const controller = new AbortController();
  const timeoutMs = Number(process.env.WEB_SOURCE_APIFY_TIMEOUT_MS ?? 180_000);
  const timeout = setTimeout(() => controller.abort(), Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 180_000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ Start_Date: startDate, Max_Results: maxResults }),
      signal: controller.signal
    });
    if (!res.ok) throw new Error(`Apify congress HTTP ${res.status}`);
    const trades = parseApifyCongress(await res.json(), now);
    const chambers = String(process.env.WEB_SOURCE_APIFY_CONGRESS_CHAMBERS ?? "house").toLowerCase();
    return chambers === "all" || chambers === "both" ? trades : trades.filter((t) => t.chamber === "house");
  } finally {
    clearTimeout(timeout);
  }
}

// ── Aggregation (pure) ───────────────────────────────────────────────────────

/** Build per-symbol congressional signals for the requested symbols, within the window. */
export function aggregateCongressSignals(
  trades: CongressTrade[],
  symbols: string[],
  now: number = Date.now(),
  window = windowDays()
): Record<string, CongressSignal> {
  const wanted = new Set(symbols.map(normalizeSymbol).filter(Boolean));
  const cutoff = now - window * 24 * 60 * 60_000;
  const bySymbol = new Map<string, CongressTrade[]>();
  for (const t of trades) {
    if (!wanted.has(t.symbol)) continue;
    // Use disclosedAt as the recency anchor: trades are disclosed up to ~45 days after they
    // occur, and the market can only react once the disclosure lands. Windowing on tradedAt
    // would include trades the market hasn't seen yet (or saw weeks ago) and exclude fresh
    // disclosures of older trades. Fall back to tradedAt when disclosedAt is absent.
    const ts = Date.parse(t.disclosedAt || t.tradedAt || "");
    if (Number.isFinite(ts) && ts < cutoff) continue;
    const list = bySymbol.get(t.symbol) ?? [];
    list.push(t);
    bySymbol.set(t.symbol, list);
  }

  const out: Record<string, CongressSignal> = {};
  for (const [symbol, list] of bySymbol) {
    list.sort((a, b) => Date.parse(b.disclosedAt || b.tradedAt) - Date.parse(a.disclosedAt || a.tradedAt));
    const buyMembers = distinct(list.filter((t) => t.side === "buy").map((t) => t.member));
    const sellMembers = distinct(list.filter((t) => t.side === "sell").map((t) => t.member));
    const buyCount = list.filter((t) => t.side === "buy").length;
    const sellCount = list.filter((t) => t.side === "sell").length;
    out[symbol] = {
      netSignal: buyMembers.length - sellMembers.length,
      buyCount,
      sellCount,
      buyMembers,
      sellMembers,
      windowDays: window,
      lastTradedAt: list[0]?.tradedAt,
      lastDisclosedAt: list[0]?.disclosedAt,
      bulletin: buildBulletin(symbol, buyMembers, sellMembers, buyCount, sellCount, window, list)
    };
  }
  return out;
}

function distinct(names: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const n of names) {
    if (n && !seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  }
  return out;
}

function buildBulletin(
  symbol: string,
  buyMembers: string[],
  sellMembers: string[],
  buyCount: number,
  sellCount: number,
  window: number,
  trades: CongressTrade[]
): string {
  const names = (m: string[]) => m.slice(0, 3).join(", ") + (m.length > 3 ? `, +${m.length - 3} more` : "");
  let base = "";
  if (buyCount > 0 && sellCount === 0) {
    base = `Congress: ${buyMembers.length} member(s) disclosed BUYS of ${symbol} in the last ${window}d (${names(buyMembers)}); no sells.`;
  } else if (sellCount > 0 && buyCount === 0) {
    base = `Congress: ${sellMembers.length} member(s) disclosed SELLS of ${symbol} in the last ${window}d (${names(sellMembers)}); no buys.`;
  } else {
    base = `Congress: mixed activity on ${symbol} in last ${window}d — ${buyCount} buy(s) by ${names(buyMembers)} vs ${sellCount} sell(s) by ${names(sellMembers)}.`;
  }

  // Include latency/competitor discovery info for LLM insights.
  const latencies = trades
    .filter((t) => t.latencyProbeDelayMs !== undefined)
    .slice(0, 3); // cap to 3 most recent

  if (latencies.length > 0) {
    const details = latencies
      .map((t) => `latency: ${t.latencyProbeDelayMs}ms, health: ${t.latencyProbeHealth ?? "unknown"}, provider_pub: ${t.providerPublishedAt ?? "N/A"}`)
      .join("; ");
    base += ` (Competitor tracking stats for latest trades: ${details})`;
  }

  return base;
}

/** Read the cached dataset and build signals for the given symbols (no network). */
export function getCongressSignals(symbols: string[], now: number = Date.now()): Record<string, CongressSignal> {
  const dataset = getCongressDataset();
  if (!dataset?.trades?.length) return {};
  return aggregateCongressSignals(dataset.trades, symbols, now);
}

// ── Live adapters ────────────────────────────────────────────────────────────

/**
 * Scrape recent Senate PTR disclosures. Multi-step Django flow:
 *   GET /search/ -> CSRF + cookies; POST /search/home/ (accept terms, token rotates);
 *   POST /search/report/data/ -> filings; GET each e-filed PTR -> parse table.
 */

async function getSenateSessionFromKV(): Promise<Record<string, string> | null> {
  const account = process.env.CLOUDFLARE_ST_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_ST_API_TOKEN;
  const namespace = process.env.CLOUDFLARE_SENATE_KV_NAMESPACE;
  if (!account || !token || !namespace) return null;

  try {
    const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/storage/kv/namespaces/${namespace}/values/senate_efd_session`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!res.ok) return null;
    return await res.json() as Record<string, string>;
  } catch {
    return null;
  }
}

async function putSenateSessionToKV(jar: Record<string, string>): Promise<void> {
  const account = process.env.CLOUDFLARE_ST_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_ST_API_TOKEN;
  const namespace = process.env.CLOUDFLARE_SENATE_KV_NAMESPACE;
  if (!account || !token || !namespace) return;

  try {
    await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/storage/kv/namespaces/${namespace}/values/senate_efd_session`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(jar)
    });
  } catch {
    // ignore
  }
}

export async function scrapeSenateEfd(now: number = Date.now()): Promise<CongressTrade[]> {
  let jar = await getSenateSessionFromKV();
  let apiToken = jar?.csrftoken ?? "";
  
  const lookbackDays = Number(process.env.WEB_SOURCE_CONGRESS_LOOKBACK_DAYS ?? DEFAULT_LOOKBACK_DAYS);
  const from = new Date(now - lookbackDays * 24 * 60 * 60_000);
  const fmt = (d: Date) => `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}/${d.getFullYear()}`;
  
  async function performSearch() {
    const searchBody = new URLSearchParams();
    searchBody.append("draw", "1");
    searchBody.append("start", "0");
    searchBody.append("length", "100");
    searchBody.append("report_types", "[11]"); // Periodic Transaction Reports
    searchBody.append("filer_types", "[]");
    searchBody.append("submitted_start_date", `${fmt(from)} 00:00:00`);
    searchBody.append("submitted_end_date", "");
    searchBody.append("candidate_state", "");
    searchBody.append("senator_state", "");
    searchBody.append("office_id", "");
    searchBody.append("first_name", "");
    searchBody.append("last_name", "");
    searchBody.append("csrfmiddlewaretoken", apiToken);

    return await politeFetch(`${EFD_BASE}/search/report/data/`, {
      method: "POST",
      headers: {
        "user-agent": BROWSER_UA,
        "content-type": "application/x-www-form-urlencoded",
        referer: `${EFD_BASE}/search/`,
        cookie: cookieHeader(jar!),
        "x-csrftoken": apiToken,
        "x-requested-with": "XMLHttpRequest"
      },
      body: searchBody
    });
  }

  let searchJson: Response | null = null;
  if (jar && apiToken) {
    searchJson = await performSearch();
    if (!searchJson.ok) {
      searchJson = null; // force re-handshake
    }
  }

  if (!searchJson) {
    jar = {};
    const landing = await politeFetch(`${EFD_BASE}/search/`, { headers: { "user-agent": BROWSER_UA } });
    mergeSetCookies(jar, landing);
    const landingHtml = await landing.text();
    const formCsrf = landingHtml.match(/name=["']csrfmiddlewaretoken["']\s+value=["']([^"']+)["']/)?.[1] ?? jar.csrftoken;
    if (!formCsrf) throw new Error("Senate eFD: no CSRF token");

    const acceptBody = new URLSearchParams({ prohibition_agreement: "1", csrfmiddlewaretoken: formCsrf });
    const accept = await politeFetch(`${EFD_BASE}/search/home/`, {
      method: "POST",
      redirect: "manual",
      headers: {
        "user-agent": BROWSER_UA,
        "content-type": "application/x-www-form-urlencoded",
        referer: `${EFD_BASE}/search/`,
        cookie: cookieHeader(jar),
        "x-csrftoken": formCsrf
      },
      body: acceptBody
    });
    mergeSetCookies(jar, accept);
    apiToken = jar.csrftoken ?? formCsrf;
    
    await putSenateSessionToKV(jar);
    
    searchJson = await performSearch();
    if (!searchJson.ok) throw new Error(`Senate eFD search HTTP ${searchJson.status}`);
  }
  const filings = parseEfdReportRows(await searchJson.json())
    .filter((f) => f.isPtr)
    .slice(0, Number(process.env.WEB_SOURCE_CONGRESS_MAX_FILINGS ?? DEFAULT_MAX_FILINGS));

  const perFiling = await runRateLimited(filings, 350, async (filing) => {
    try {
      const html = await politeFetchText(filing.viewUrl, {
        headers: { "user-agent": BROWSER_UA, cookie: cookieHeader(jar), referer: `${EFD_BASE}/search/` }
      });
      return parsePtrTransactions(html, { member: filing.member, filedAt: filing.filedAt });
    } catch {
      return [] as CongressTrade[];
    }
  });
  return perFiling.flat();
}

/** Fetch Capitol Trades' public JSON back-end (best-effort; host can be configured/disabled). */
export async function fetchCapitolTrades(): Promise<CongressTrade[]> {
  const configured = process.env.WEB_SOURCE_CAPITOLTRADES_URL?.trim();
  if (configured && /^(off|false|disabled|none)$/i.test(configured)) return [];
  const base = configured || DEFAULT_CAPITOL_TRADES_URL;
  const res = await politeFetch(base, {
    headers: {
      "user-agent": BROWSER_UA,
      accept: "application/json",
      origin: "https://www.capitoltrades.com",
      referer: "https://www.capitoltrades.com/"
    }
  });
  if (!res.ok) throw new Error(`Capitol Trades HTTP ${res.status}`);
  return parseCapitolTradesBff(await res.json());
}

// ── Refresh orchestration ────────────────────────────────────────────────────

function tradeKey(t: CongressTrade): string {
  return `${t.symbol}|${t.member}|${t.side}|${t.tradedAt}|${t.amountLow ?? ""}`;
}

function dedupeTrades(trades: CongressTrade[]): CongressTrade[] {
  const seen = new Set<string>();
  const out: CongressTrade[] = [];
  for (const t of trades) {
    const key = tradeKey(t);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

export function retryBackoffMs(): number {
  const v = Number(process.env.WEB_SOURCE_RETRY_BACKOFF_MS ?? DEFAULT_RETRY_BACKOFF_MS);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_RETRY_BACKOFF_MS;
}

export function isCongressRefreshDue(now: number = Date.now()): boolean {
  // Back off briefly after ANY attempt so a failed scrape (which intentionally does
  // not advance the dataset's fetchedAt) doesn't re-fire on every 60s scheduler tick.
  const lastAttempt = getInternalSetting<string>(ATTEMPT_KEY);
  if (lastAttempt && now - Date.parse(lastAttempt) < retryBackoffMs()) return false;
  const dataset = getCongressDataset();
  if (!dataset?.fetchedAt) return true;
  return now - Date.parse(dataset.fetchedAt) >= congressTtlMs();
}

/**
 * Refresh the cached congressional dataset if it's stale. Runs Senate eFD first
 * (authoritative), then Capitol Trades (House coverage). Persists whatever was
 * gathered; on total failure leaves the previous dataset untouched (never wipes to
 * fake/empty mid-trading-day). Returns a result for auditing.
 */
export async function refreshCongress(
  now: number = Date.now(),
  force = false,
  operationLeaseClaim?: OperationLeaseClaim
): Promise<OperationLeaseAware<import("./types").WebSourceRefreshResult>> {
  if (!force && !isCongressRefreshDue(now)) {
    const ds = getCongressDataset();
    return { id: "congress", ok: true, recordCount: ds?.recordCount ?? 0, sources: ds?.sources ?? [], fetchedAt: ds?.fetchedAt ?? "", skipped: true };
  }

  const guarded = await runWithOperationLease(
    {
      group: OPERATION_LEASE_GROUPS.CONGRESS_WEB_SOURCE,
      operation: "refresh-websource:congress",
      claim: operationLeaseClaim
    },
    async (claim, signal) => refreshCongressUnlocked(now, force, claim, signal)
  );
  if (!guarded.acquired) {
    const ds = getCongressDataset();
    return {
      id: "congress",
      ok: true,
      recordCount: ds?.recordCount ?? 0,
      sources: ds?.sources ?? [],
      fetchedAt: ds?.fetchedAt ?? "",
      skipped: true,
      warning: `Skipped because ${guarded.busy.activeOperation} is already refreshing the congressional dataset.`,
      operationLease: guarded.busy
    };
  }
  return guarded.value;
}

async function refreshCongressUnlocked(
  now: number,
  force: boolean,
  operationLeaseClaim: OperationLeaseClaim,
  operationLeaseSignal: AbortSignal
): Promise<import("./types").WebSourceRefreshResult> {
  // Recheck after durable acquisition: a different process may have refreshed the dataset and
  // advanced its timestamps after this caller's fast pre-check.
  if (!force && !isCongressRefreshDue(now)) {
    const ds = getCongressDataset();
    return { id: "congress", ok: true, recordCount: ds?.recordCount ?? 0, sources: ds?.sources ?? [], fetchedAt: ds?.fetchedAt ?? "", skipped: true };
  }
  assertOperationLeaseOwnership(operationLeaseClaim);

  // Record the attempt up front so a failure backs off (retryBackoffMs) instead of
  // re-firing every tick; the dataset's fetchedAt still only advances on success.
  setInternalSetting(ATTEMPT_KEY, new Date(now).toISOString());

  const collected: CongressTrade[] = [];
  const sources: string[] = [];
  const warnings: string[] = [];

  // When App A (congress.trade) is the configured source of truth, pull from it and skip the
  // local scrapers entirely (it IS the authority on congressional disclosures). Otherwise run
  // App B's own adapter cascade.
  const adapters = congressAsCongressSourceEnabled()
    ? [{ id: "congress-trade", run: () => fetchAppACongressTrades(now) }]
    : [
        { id: "senate-efd", run: () => scrapeSenateEfd(now) },
        { id: "apify-congress", run: () => fetchApifyCongress(now) },
        { id: "capitol-trades", run: fetchCapitolTrades }
      ];

  for (const adapter of adapters) {
    throwIfOperationLeaseCancelled(operationLeaseSignal);
    try {
      const trades = await adapter.run();
      throwIfOperationLeaseCancelled(operationLeaseSignal);
      if (trades.length > 0) {
        collected.push(...trades);
        sources.push(adapter.id);
      }
    } catch (error) {
      throwIfOperationLeaseCancelled(operationLeaseSignal);
      warnings.push(`${adapter.id}: ${error instanceof Error ? error.message : "failed"}`);
    }
  }

  assertOperationLeaseOwnership(operationLeaseClaim);
  const fetchedAt = new Date(now).toISOString();
  if (collected.length === 0) {
    // Don't overwrite a good prior dataset with nothing on a transient outage.
    const prior = getCongressDataset();
    audit("web_source_refresh", { id: "congress", ok: false, recordCount: 0, warnings });
    return { id: "congress", ok: false, recordCount: prior?.recordCount ?? 0, sources: prior?.sources ?? [], fetchedAt: prior?.fetchedAt ?? "", warning: warnings.join("; ") || "no records" };
  }

  const trades = dedupeTrades(collected);
  const dataset: CongressDataset = { trades, fetchedAt, sources, recordCount: trades.length };
  assertOperationLeaseOwnership(operationLeaseClaim);
  setInternalSetting(DATASET_KEY, dataset);
  audit("web_source_refresh", { id: "congress", ok: true, recordCount: trades.length, sources, warnings });
  return { id: "congress", ok: true, recordCount: trades.length, sources, fetchedAt, warning: warnings.join("; ") || undefined };
}

// ── App A (congress.trade) as the congressional source ───────────────────────
// When CONGRESS_TRADE_AS_CONGRESS_SOURCE is on, App A is the system-of-record for disclosures.
// We pull its /api/transactions feed and coerce rows into App B's CongressTrade shape. App A's
// exact per-row field names are not finalized, so the coercer is tolerant (accepts common aliases).

const APP_A_MAX_PAGES = 40;
const APP_A_PAGE_SIZE = 500;
const APP_A_MAX_TRADES = 20000;
const APP_A_RETENTION_DAYS = 120; // bound the push-merged dataset (> the 60-day signal window)
const APP_A_SOURCE = "congress.trade";

/** Min extraction confidence (App A stamps 0–1 per row) below which we drop a disclosure as noise. */
function appAMinConfidence(): number {
  const v = Number(process.env.CONGRESS_TRADE_MIN_CONFIDENCE ?? 0.3);
  return Number.isFinite(v) ? v : 0.3;
}

function pickStr(o: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return undefined;
}

function pickNum(o: Record<string, unknown>, keys: string[]): number | undefined {
  for (const k of keys) {
    const v = o[k];
    const n = typeof v === "number" ? v : typeof v === "string" ? Number(v.replace(/[$,]/g, "")) : NaN;
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/** Tolerantly coerce an App A transaction row (or a pushed CongressTrade) into a CongressTrade. */
export function coerceCongressTrade(raw: unknown): CongressTrade | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;

  // App B is equity-focused: skip option disclosures (a P/S txType can't express call/put direction,
  // so an option trade's directional meaning is ambiguous), and drop very-low-confidence extractions
  // (App A stamps a 0–1 `confidence` on every transaction row).
  if (o.isOption === true) return null;
  const confidence = pickNum(o, ["confidence"]);
  if (confidence !== undefined && confidence < appAMinConfidence()) return null;

  const symbol = normalizeSymbol(pickStr(o, ["symbol", "ticker", "asset", "assetTicker", "issuerTicker"]) ?? "");
  if (!symbol) return null;

  // App A's /api/transactions uses single-letter SEC codes: P=purchase(buy), S / S_partial=sale(sell);
  // other codes (E exchange, G gift, …) are intentionally ignored. Also accept word forms from
  // other sources.
  const sideRaw = (pickStr(o, ["side", "type", "transactionType", "txType", "action"]) ?? "").toLowerCase();
  let side: "buy" | "sell" | undefined;
  if (sideRaw === "p" || sideRaw === "b" || /(buy|purchase|acqui)/.test(sideRaw)) side = "buy";
  else if (sideRaw === "s" || sideRaw.startsWith("s_") || /(sell|sale|dispos)/.test(sideRaw)) side = "sell";
  if (!side) return null;

  const now = Date.now();
  const rawTradedAt = pickStr(o, ["tradedAt", "txDate", "transactionDate", "tradeDate", "date"]);
  const rawDisclosedAt = pickStr(o, ["disclosedAt", "filedDate", "filedAt", "reportDate", "disclosureDate", "publishedAt", "pubDate"]);
  const tradedAt = normalizeTradeDate(rawTradedAt, now);
  const disclosedAt = normalizeTradeDate(rawDisclosedAt, now);
  // A date field that was SUPPLIED but is unparseable ("2026-13-45") or FUTURE-dated is a
  // data-quality error — reject the whole row rather than silently falling back to the other date,
  // which would otherwise let a future-dated trade in under its disclosure date. Only fall back when
  // a field was simply absent.
  if (rawTradedAt && !tradedAt) return null;
  if (rawDisclosedAt && !disclosedAt) return null;
  const anchor = tradedAt ?? disclosedAt;
  // Reject a trade with no usable date at all so garbage never accumulates and the
  // disclosedAt-windowed signal stays correct.
  if (!anchor) return null;

  // Match the senate prefix (senate/senator) at the START — substring .includes("sen") would
  // misclassify "representative". Anything else (house/rep/unknown) → house.
  const chamberRaw = (pickStr(o, ["chamber", "house", "body"]) ?? "").toLowerCase();
  const chamber: "senate" | "house" = chamberRaw.startsWith("sen") ? "senate" : "house";

  const trade: CongressTrade = {
    symbol,
    member: pickStr(o, ["memberName", "member", "politician", "fullName", "name", "representative", "senator"]) ?? "Unknown",
    chamber,
    side,
    tradedAt: anchor,
    disclosedAt: disclosedAt ?? tradedAt,
    source: APP_A_SOURCE
  };
  const amountLow = pickNum(o, ["amountLow", "amount_min", "minAmount", "sizeRangeLow", "valueLow", "amountMin"]);
  const amountHigh = pickNum(o, ["amountHigh", "amount_max", "maxAmount", "sizeRangeHigh", "valueHigh", "amountMax"]);
  if (amountLow !== undefined) trade.amountLow = amountLow;
  if (amountHigh !== undefined) trade.amountHigh = amountHigh;
  const owner = pickStr(o, ["owner", "ownerType", "holder"]);
  if (owner) trade.owner = owner;

  const latencyProbeHealth = pickStr(o, ["latencyProbeHealth"]);
  if (latencyProbeHealth) trade.latencyProbeHealth = latencyProbeHealth;
  const latencyProbeDelayMs = pickNum(o, ["latencyProbeDelayMs"]);
  if (latencyProbeDelayMs !== undefined) trade.latencyProbeDelayMs = latencyProbeDelayMs;
  const providerPublishedAt = pickStr(o, ["providerPublishedAt"]);
  if (providerPublishedAt) trade.providerPublishedAt = providerPublishedAt;

  return trade;
}

/**
 * Pull the rolling congressional window from App A's public /api/transactions feed. App A's feed is
 * oldest-first by `cursor_seq`, so we bound it server-side with `from=<window start>` (the documented
 * rolling-window param) and page forward via `cursor` until the window is exhausted. Without `from`
 * a recent-window pull would have to walk all historical rows to reach today's disclosures.
 */
export async function fetchAppACongressTrades(now: number = Date.now()): Promise<CongressTrade[]> {
  const out: CongressTrade[] = [];
  const from = new Date(now - (windowDays() + 7) * 24 * 60 * 60_000).toISOString().slice(0, 10);
  let since: string | undefined;
  for (let page = 0; page < APP_A_MAX_PAGES; page++) {
    const client = getCongressTradeClient();
    const res = await client.getTransactions({ from, limit: APP_A_PAGE_SIZE, ...(since ? { since } : {}) }).catch(e => { console.error("getTransactions error:", e); return null; });
    if (!res || res.transactions.length === 0) break;
    for (const raw of res.transactions) {
      const t = coerceCongressTrade(raw);
      if (t) out.push(t);
      if (out.length >= APP_A_MAX_TRADES) return out;
    }
    const next = res.cursor === undefined || res.cursor === null ? undefined : String(res.cursor);
    if (!next || next === since) break; // no more pages / no forward progress
    since = next;
  }
  return out;
}

/**
 * Merge externally-received congressional trades (push webhook / SSE) into the persisted dataset,
 * deduped and pruned to APP_A_RETENTION_DAYS. Returns how many net-new rows landed. Idempotent:
 * re-sending the same trades is a no-op (dedupeTrades keeps the first occurrence).
 */
export function upsertCongressTrades(incoming: CongressTrade[], now: number = Date.now()): { added: number; total: number } {
  const clean = incoming.filter((t): t is CongressTrade => Boolean(t && t.symbol && t.side && t.tradedAt));
  const prior = getCongressDataset();
  if (clean.length === 0) return { added: 0, total: prior?.recordCount ?? 0 };
  // `added` = distinct incoming keys not already present, computed BEFORE retention pruning so the
  // count is accurate even when pruning drops unrelated old prior rows.
  const priorKeys = new Set((prior?.trades ?? []).map(tradeKey));
  const added = new Set(clean.map(tradeKey).filter((k) => !priorKeys.has(k))).size;
  const cutoff = now - APP_A_RETENTION_DAYS * 24 * 60 * 60_000;
  const merged = dedupeTrades([...(prior?.trades ?? []), ...clean]).filter((t) => {
    const ts = Date.parse(t.disclosedAt ?? t.tradedAt);
    return Number.isFinite(ts) && ts >= cutoff; // keep only parseable + within-retention rows
  });
  const sources = Array.from(new Set([...(prior?.sources ?? []), APP_A_SOURCE]));
  const dataset: CongressDataset = {
    trades: merged,
    fetchedAt: new Date(now).toISOString(),
    sources,
    recordCount: merged.length
  };
  setInternalSetting(DATASET_KEY, dataset);
  return { added, total: merged.length };
}
