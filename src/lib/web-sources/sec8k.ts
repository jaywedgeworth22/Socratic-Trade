// SEC EDGAR 8-K (material event) ingestion.
//
// An 8-K is filed when something material happens (results, exec changes, major
// agreements, etc.), so a fresh 8-K is a catalyst flag worth surfacing to the agent.
// Free, no key (UA only). We read the market-wide "current 8-K" atom feed, map each
// filer's CIK to a ticker via SEC's company_tickers.json (cached weekly), and keep a
// short rolling window of "TICKER filed an 8-K" events. Per-item label enrichment
// IS implemented: parseEightKItemsFromHtml() fetches the filing summary page and
// extracts item codes (e.g. "Item 5.02"); eightKHasMaterialItem() filters an
// expert-panel allowlist; items surface in bulletins and trigger the event-driven
// engine (`src/lib/triggers.ts`) when a material item code is detected.
// Never fabricated: no feed / no CIK match -> no event.

import {
  audit,
  getDb,
  getInternalSetting,
  hasIngestedAccession,
  insertIngestedAccession,
  runWithActiveVectorCommitProof,
  setInternalSetting
} from "../db";
import { normalizeSymbol } from "../money";
import { envFlagOn } from "../rag/env-flag";
import { resolveSourceBool } from "../source-settings";
import {
  eligibleMaterialTriggerUserIds,
  enqueueMaterialEventsForUsersTx,
  hasDurableMaterialTriggerWork,
  type MaterialEvent
} from "../triggers";
import {
  assertOperationLeaseOwnership,
  OPERATION_LEASE_GROUPS,
  runWithOperationLease,
  throwIfOperationLeaseCancelled,
  type OperationLeaseAware,
  type OperationLeaseClaim
} from "../operation-lease";
import { retryBackoffMs } from "./congress";
import { politeFetchText, runRateLimited, secUserAgent, sleep } from "./http";
import { extractFilingText } from "./sec-filings";
import { eightKWritePath, writeCorpusFile } from "../rag/corpus-layout";
import { bareSecAccession } from "../rag/pinecone-write-class";
import { timeSync, yieldEventLoop } from "../slow-sync-guard";
import type { VectorStoreLeaseGuard } from "../vector-db";

/** Best-effort moveable corpus sidecar under data/corpus/eight-k/{accession}/. */
async function writeEightKCorpusSidecar(accession: string, text: string, html?: string): Promise<void> {
  const bare = bareSecAccession(accession) ?? String(accession ?? "").trim();
  if (!bare || !text.trim()) return;
  try {
    await writeCorpusFile(eightKWritePath(bare, "main.txt"), text);
    if (html && html.length > 0) {
      await writeCorpusFile(eightKWritePath(bare, "main.html"), html);
    }
  } catch (err) {
    console.warn(
      `[sec8k] eight-k corpus sidecar write failed for ${bare}:`,
      err instanceof Error ? err.message : String(err)
    );
  }
}

/**
 * R10 (2026-07-01 RAG backlog): content_hash dedup for the always-on 8-K SUMMARY ingest
 * below. Default ON - avoids re-embedding the same short summary on every refresh cycle
 * even when the underlying event data hasn't changed (the Pinecone upsert is idempotent by
 * contextId, but the Voyage embed call is NOT free). Set VECTOR_STORECONTEXTS_DEDUP=off only
 * when intentionally forcing a re-embed.
 */
function storeContextsDedupEnabled(): boolean {
  return envFlagOn("VECTOR_STORECONTEXTS_DEDUP", true);
}

const DATASET_KEY = "webSource:sec8k:dataset";
const ATTEMPT_KEY = "webSource:sec8k:lastAttempt";
const CIK_KEY = "webSource:sec:cikMap";
const DEFAULT_TTL_MS = 24 * 60 * 60_000; // daily
const CIK_TTL_MS = 7 * 24 * 60 * 60_000; // ticker↔CIK map changes slowly
const DEFAULT_WINDOW_DAYS = 4; // an 8-K is only a "fresh" catalyst for a few days
const DEFAULT_RAG_LIMIT = 16;
const SUMMARY_BACKLOG_KEY = "webSource:sec8k:summaryBacklog";
const FULL_BODY_BACKLOG_KEY = "webSource:sec8k:fullBodyBacklog";
const DEFAULT_SUMMARY_BACKLOG_MAX = 1_000;
const DEFAULT_FULL_BODY_BACKLOG_MAX = 500;
const SEC_BASE = "https://www.sec.gov";

function isValidPersistedTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value));
}

export interface EightKEvent {
  symbol: string;
  filedAt: string; // ISO date
  /** Exact SEC feed acceptance/update time used for point-in-time retrieval. */
  acceptedAt?: string;
  accession: string;
  filingUrl?: string;
  items?: string[];
}
export interface EightKDataset {
  events: EightKEvent[];
  fetchedAt: string;
  recordCount: number;
}

export function eightKTtlMs(): number {
  const v = Number(process.env.WEB_SOURCE_SEC8K_TTL_MS ?? DEFAULT_TTL_MS);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_TTL_MS;
}
function windowDays(): number {
  const v = Number(process.env.WEB_SOURCE_SEC8K_WINDOW_DAYS ?? DEFAULT_WINDOW_DAYS);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_WINDOW_DAYS;
}
export function eightKRagLimit(): number {
  const v = Number(process.env.WEB_SOURCE_SEC8K_RAG_LIMIT ?? DEFAULT_RAG_LIMIT);
  return Number.isFinite(v) && v >= 0 ? Math.floor(v) : DEFAULT_RAG_LIMIT;
}
export function getEightKDataset(): EightKDataset | undefined {
  return getInternalSetting<EightKDataset>(DATASET_KEY);
}

function fullBodyBacklogMax(): number {
  const value = Number(process.env.WEB_SOURCE_SEC8K_FULL_BODY_BACKLOG_MAX ?? DEFAULT_FULL_BODY_BACKLOG_MAX);
  return Number.isFinite(value) && value > 0
    ? Math.min(5_000, Math.floor(value))
    : DEFAULT_FULL_BODY_BACKLOG_MAX;
}

export function getEightKFullBodyBacklog(): EightKEvent[] {
  return readEightKBacklog(FULL_BODY_BACKLOG_KEY, fullBodyBacklogMax(), true);
}

function readEightKBacklog(key: string, max: number, preserveOrder = false): EightKEvent[] {
  const value = getInternalSetting<unknown>(key);
  if (!Array.isArray(value)) return [];
  const unique = new Map<string, EightKEvent>();
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as Partial<EightKEvent>;
    if (!row.accession || !row.symbol || !row.filedAt) continue;
    unique.set(row.accession, {
      symbol: normalizeSymbol(row.symbol),
      filedAt: String(row.filedAt),
      ...(row.acceptedAt ? { acceptedAt: String(row.acceptedAt) } : {}),
      accession: String(row.accession),
      ...(row.filingUrl ? { filingUrl: String(row.filingUrl) } : {}),
      ...(Array.isArray(row.items) ? { items: row.items.map(String).filter(Boolean) } : {})
    });
  }
  const rows = [...unique.values()];
  if (!preserveOrder) {
    rows.sort((a, b) => b.filedAt.localeCompare(a.filedAt) || b.accession.localeCompare(a.accession));
  }
  return rows.slice(0, max);
}

function persistEightKFullBodyBacklog(events: EightKEvent[]): EightKEvent[] {
  return persistEightKBacklog(FULL_BODY_BACKLOG_KEY, events, fullBodyBacklogMax(), "full-body", true);
}

export function getEightKSummaryBacklog(): EightKEvent[] {
  return readEightKBacklog(SUMMARY_BACKLOG_KEY, DEFAULT_SUMMARY_BACKLOG_MAX);
}

function persistEightKSummaryBacklog(events: EightKEvent[]): EightKEvent[] {
  return persistEightKBacklog(SUMMARY_BACKLOG_KEY, events, DEFAULT_SUMMARY_BACKLOG_MAX, "summary");
}

function persistEightKBacklog(
  key: string,
  events: EightKEvent[],
  max: number,
  kind: "summary" | "full-body",
  preserveOrder = false
): EightKEvent[] {
  const { rows: bounded, dropped } = prepareEightKBacklog(events, max, preserveOrder);
  setInternalSetting(key, bounded);
  if (dropped > 0) audit("sec8k_rag_backlog_truncated", { kind, dropped, retained: bounded.length });
  return bounded;
}

function prepareEightKBacklog(
  events: EightKEvent[],
  max: number,
  preserveOrder = false
): { rows: EightKEvent[]; dropped: number } {
  const unique = new Map<string, EightKEvent>();
  for (const event of events) unique.set(event.accession, event);
  const ordered = [...unique.values()];
  if (!preserveOrder) {
    ordered.sort((a, b) => b.filedAt.localeCompare(a.filedAt) || b.accession.localeCompare(a.accession));
  }
  const bounded = ordered.slice(0, max);
  const dropped = ordered.length - bounded.length;
  return { rows: bounded, dropped };
}

/**
 * Commit discovery and both durable RAG queues in one SQLite transaction. The previous ordering
 * wrote the dataset first and enqueued only afterward, so a process crash in that gap could lose an
 * accession for the full refresh cadence (or forever once it fell out of the current feed).
 */
function persistEightKDiscovery(
  dataset: EightKDataset,
  fresh: EightKEvent[],
  includeFullBodies: boolean,
  triggerUserIds: string[],
  materialEvents: MaterialEvent[],
  nowMs: number
): void {
  const summary = prepareEightKBacklog(
    [...getEightKSummaryBacklog(), ...fresh],
    DEFAULT_SUMMARY_BACKLOG_MAX
  );
  const body = includeFullBodies
    ? prepareEightKBacklog(
        [...getEightKFullBodyBacklog(), ...fresh],
        fullBodyBacklogMax(),
        true
      )
    : { rows: [] as EightKEvent[], dropped: 0 };
  const nowIso = new Date().toISOString();
  const database = getDb();
  const upsert = database.prepare(
    "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) " +
    "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
  );
  database.transaction(() => {
    upsert.run(DATASET_KEY, JSON.stringify(dataset), nowIso);
    upsert.run(SUMMARY_BACKLOG_KEY, JSON.stringify(summary.rows), nowIso);
    if (includeFullBodies) {
      upsert.run(FULL_BODY_BACKLOG_KEY, JSON.stringify(body.rows), nowIso);
    }
    enqueueMaterialEventsForUsersTx(database, triggerUserIds, materialEvents, nowMs);
  }).immediate();

  if (summary.dropped > 0) {
    audit("sec8k_rag_backlog_truncated", {
      kind: "summary",
      dropped: summary.dropped,
      retained: summary.rows.length
    });
  }
  if (body.dropped > 0) {
    audit("sec8k_rag_backlog_truncated", {
      kind: "full-body",
      dropped: body.dropped,
      retained: body.rows.length
    });
  }
}

function hasEightKRagBacklog(): boolean {
  return getEightKSummaryBacklog().length > 0 ||
    (eightKFullBodyEnabled() && getEightKFullBodyBacklog().length > 0);
}

// ── Pure parsers (unit-tested) ───────────────────────────────────────────────

/** Parse the current-8-K atom feed into {cik, accession, filedAt, filingUrl} rows. */
export function parseCurrent8KFeed(atomXml: string): Array<{ cik: string; accession: string; filedAt?: string; acceptedAt?: string; filingUrl?: string }> {
  const out: Array<{ cik: string; accession: string; filedAt?: string; acceptedAt?: string; filingUrl?: string }> = [];
  const seen = new Set<string>();
  for (const entry of atomXml.split(/<entry>/i).slice(1)) {
    const title = entry.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ?? "";
    const cik = title.match(/\((\d{4,10})\)/)?.[1];
    const link = entry.match(/href="([^"]+)"/i)?.[1] ?? "";
    const accession = link.match(/(\d{10}-\d{2}-\d{6})/)?.[1];
    const updated = entry.match(/<updated>([\s\S]*?)<\/updated>/i)?.[1];
    if (!cik || !accession || seen.has(accession)) continue;
    seen.add(accession);
    const acceptedAt = updated && Number.isFinite(Date.parse(updated))
      ? new Date(updated).toISOString()
      : undefined;
    out.push({
      cik: String(Number(cik)),
      accession,
      filedAt: acceptedAt?.slice(0, 10),
      acceptedAt,
      filingUrl: link
    });
  }
  return out;
}

/** Parse SEC company_tickers.json into a numeric-CIK-string -> ticker map. */
export function parseCikTickerMap(json: unknown): Record<string, string> {
  const map: Record<string, string> = {};
  const rows = json && typeof json === "object" ? Object.values(json as Record<string, unknown>) : [];
  for (const row of rows) {
    const r = row as { cik_str?: number | string; ticker?: string };
    if (r?.cik_str == null || !r.ticker) continue;
    map[String(Number(r.cik_str))] = normalizeSymbol(r.ticker);
  }
  return map;
}

/**
 * Parse SEC company_tickers.json into a ticker -> numeric-CIK-string map. Unlike parseCikTickerMap
 * (which collapses each CIK to ONE ticker), this keeps EVERY ticker, so dual-class names that share a
 * CIK (e.g. GOOGL & GOOG) both resolve to their CIK.
 */
export function parseTickerCikMap(json: unknown): Record<string, string> {
  const map: Record<string, string> = {};
  const rows = json && typeof json === "object" ? Object.values(json as Record<string, unknown>) : [];
  for (const row of rows) {
    const r = row as { cik_str?: number | string; ticker?: string };
    if (r?.cik_str == null || !r.ticker) continue;
    const ticker = normalizeSymbol(r.ticker);
    if (ticker) map[ticker] = String(Number(r.cik_str));
  }
  return map;
}

// ── Read API ─────────────────────────────────────────────────────────────────

export interface EightKSignal {
  count: number;
  lastFiledAt?: string;
  bulletin: string;
}

export function getEightKSignals(symbols: string[], now: number = Date.now()): Record<string, EightKSignal> {
  const dataset = getEightKDataset();
  if (!dataset?.events?.length) return {};
  const wanted = new Set(symbols.map(normalizeSymbol).filter(Boolean));
  const cutoff = now - windowDays() * 24 * 60 * 60_000;
  const bySymbol = new Map<string, EightKEvent[]>();
  for (const e of dataset.events) {
    if (!wanted.has(e.symbol)) continue;
    const ts = Date.parse(e.filedAt);
    if (Number.isFinite(ts) && ts < cutoff) continue;
    (bySymbol.get(e.symbol) ?? bySymbol.set(e.symbol, []).get(e.symbol)!).push(e);
  }
  const out: Record<string, EightKSignal> = {};
  for (const [symbol, events] of bySymbol) {
    events.sort((a, b) => Date.parse(b.filedAt) - Date.parse(a.filedAt));
    const last = events[0]?.filedAt;
    const items = events.flatMap((event) => event.items ?? []).slice(0, 3);
    const itemText = items.length > 0 ? ` Items: ${items.join("; ")}.` : "";
    out[symbol] = {
      count: events.length,
      lastFiledAt: last,
      bulletin: `Catalyst: ${symbol} filed ${events.length > 1 ? `${events.length} 8-Ks` : "an 8-K"} (material event) ${last ? `on ${last}` : "recently"}.${itemText} Check for fresh news.`
    };
  }
  return out;
}

// ── Refresh ──────────────────────────────────────────────────────────────────

function isEightKDiscoveryDue(now: number = Date.now()): boolean {
  const lastAttempt = getInternalSetting<unknown>(ATTEMPT_KEY);
  if (isValidPersistedTimestamp(lastAttempt) && now - Date.parse(lastAttempt) < retryBackoffMs()) return false;
  const ds = getEightKDataset();
  if (!isValidPersistedTimestamp(ds?.fetchedAt)) return true;
  return now - Date.parse(ds.fetchedAt) >= eightKTtlMs();
}

/** Scheduler admission includes durable delivery work even when SEC discovery cadence is not due. */
export function isEightKRefreshDue(now: number = Date.now()): boolean {
  return isEightKDiscoveryDue(now) || hasEightKRagBacklog() || hasDurableMaterialTriggerWork();
}

// Shared in-flight promises for the cold company_tickers.json fetch. Both maps derive from the SAME
// SEC file; without these guards, concurrent scans (or repeated dashboard refreshes) that all miss the
// weekly cache would each fire a duplicate request and defeat SEC fair-access throttling. A pending load
// is shared across callers and cleared once settled, so a later cache expiry re-fetches.
let cikMapInFlight: Promise<Record<string, string>> | null = null;
let tickerCikMapInFlight: Promise<Record<string, string>> | null = null;

/** Load the CIK→ticker map, cached weekly in the settings KV. */
export async function loadCikMap(now: number): Promise<Record<string, string>> {
  const cached = getInternalSetting<{ map: Record<string, string>; fetchedAt: string }>(CIK_KEY);
  if (cached?.map && cached.fetchedAt && now - Date.parse(cached.fetchedAt) < CIK_TTL_MS) return cached.map;
  if (cikMapInFlight) return cikMapInFlight;
  cikMapInFlight = (async () => {
    const json = JSON.parse(await politeFetchText(`${SEC_BASE}/files/company_tickers.json`, { headers: { "user-agent": secUserAgent() } }));
    const map = parseCikTickerMap(json);
    if (Object.keys(map).length > 0) setInternalSetting(CIK_KEY, { map, fetchedAt: new Date(now).toISOString() });
    return map;
  })();
  try {
    return await cikMapInFlight;
  } finally {
    cikMapInFlight = null;
  }
}

const TICKER_CIK_KEY = "webSource:sec:tickerCikMap";

/** Load the ticker→CIK map (preserves dual-class tickers), cached weekly in the settings KV. */
export async function loadTickerCikMap(now: number): Promise<Record<string, string>> {
  const cached = getInternalSetting<{ map: Record<string, string>; fetchedAt: string }>(TICKER_CIK_KEY);
  if (cached?.map && cached.fetchedAt && now - Date.parse(cached.fetchedAt) < CIK_TTL_MS) return cached.map;
  if (tickerCikMapInFlight) return tickerCikMapInFlight;
  tickerCikMapInFlight = (async () => {
    const json = JSON.parse(await politeFetchText(`${SEC_BASE}/files/company_tickers.json`, { headers: { "user-agent": secUserAgent() } }));
    const map = parseTickerCikMap(json);
    if (Object.keys(map).length > 0) setInternalSetting(TICKER_CIK_KEY, { map, fetchedAt: new Date(now).toISOString() });
    return map;
  })();
  try {
    return await tickerCikMapInFlight;
  } finally {
    tickerCikMapInFlight = null;
  }
}

export function mergeEightK(existing: EightKEvent[], fresh: EightKEvent[], now: number, window = windowDays()): EightKEvent[] {
  const cutoff = now - window * 24 * 60 * 60_000;
  const byAccession = new Map<string, EightKEvent>();
  for (const e of [...existing, ...fresh]) {
    const ts = Date.parse(e.filedAt);
    if (Number.isFinite(ts) && ts < cutoff) continue;
    byAccession.set(e.accession, e);
  }
  return Array.from(byAccession.values());
}

function absoluteSecUrl(url?: string): string | undefined {
  if (!url) return undefined;
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith("/")) return `${SEC_BASE}${url}`;
  return `${SEC_BASE}/${url}`;
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

export function parseEightKItemsFromHtml(html: string): string[] {
  const items = new Set<string>();
  const infoBlocks = html.match(/<div[^>]*class=["']info["'][^>]*>[\s\S]*?<\/div>/gi) ?? [];
  for (const block of infoBlocks) {
    const text = decodeXmlEntities(block.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
    for (const match of text.matchAll(/Item\s+\d+\.\d{2}\s+[^;.]+/gi)) {
      items.add(match[0].trim());
    }
  }
  for (const match of html.matchAll(/Item\s+\d+\.\d{2}\s+[^<\n\r;.]+/gi)) {
    items.add(decodeXmlEntities(match[0].replace(/\s+/g, " ").trim()));
  }
  return Array.from(items).slice(0, 8);
}

async function enrichEightKEvents(events: EightKEvent[]): Promise<EightKEvent[]> {
  const limit = Number(process.env.WEB_SOURCE_SEC8K_DETAIL_LIMIT ?? 25);
  const maxDetails = Number.isFinite(limit) && limit > 0 ? limit : 25;
  const slice = events.slice(0, maxDetails);
  const enriched = await runRateLimited(slice, 250, async (event) => {
    const url = absoluteSecUrl(event.filingUrl);
    if (!url) return event;
    try {
      const html = await politeFetchText(url, { headers: { "user-agent": secUserAgent(), accept: "text/html" } });
      const items = parseEightKItemsFromHtml(html);
      return items.length > 0 ? { ...event, filingUrl: url, items } : { ...event, filingUrl: url };
    } catch {
      return { ...event, filingUrl: url };
    }
  });
  return [...enriched, ...events.slice(maxDetails)];
}

// 8-K item codes that are genuinely tradeable-material (expert panel). Most 8-Ks (5.07 votes,
// 9.01 exhibits, 5.03 bylaws, routine 8.01 PR) are noise and intentionally excluded.
const MATERIAL_8K_ITEMS = new Set(["1.01", "1.02", "1.03", "2.01", "2.02", "4.01", "4.02", "5.02"]);

export function eightKHasMaterialItem(event: EightKEvent): boolean {
  const items = event.items ?? [];
  for (const item of items) {
    const code = item.match(/(\d+\.\d{2})/)?.[1];
    if (code && MATERIAL_8K_ITEMS.has(code)) return true;
  }
  return false;
}

export function buildEightKContext(event: EightKEvent): string {
  return [
    `SEC 8-K filing for ${event.symbol}.`,
    `Filed: ${event.filedAt}.`,
    `Accession: ${event.accession}.`,
    event.items?.length ? `Reported item(s): ${event.items.join("; ")}.` : "Reported item(s): not available from the filing summary page.",
    event.filingUrl ? `SEC filing page: ${event.filingUrl}.` : "",
    "Use this as catalyst context only; infer bullish/bearish impact from item details and other market evidence."
  ].filter(Boolean).join("\n");
}

/**
 * Re-embed the *persisted* 8-K dataset into vector memory. Unlike a normal refresh (which only
 * embeds newly-`fresh` filings), this backfills everything already stored — the path used to
 * recover after the Voyage-billing 429 left the Pinecone index empty. Returns the embed/upsert
 * outcome so a caller (e.g. the reindex route) can confirm `indexed > 0`.
 */
export interface ReindexEightKResult {
  attempted: number;
  indexed: number;
  error?: string;
  skipped?: boolean;
}

export async function reindexEightKDataset(
  userId: string = "local",
  limit: number = Number.POSITIVE_INFINITY,
  operationLeaseClaim?: OperationLeaseClaim
): Promise<OperationLeaseAware<ReindexEightKResult>> {
  const guarded = await runWithOperationLease(
    {
      group: OPERATION_LEASE_GROUPS.RAG_REINDEX,
      operation: "reindex-8k",
      claim: operationLeaseClaim
    },
    async (claim, signal) => reindexEightKDatasetUnlocked(userId, limit, claim, signal)
  );
  if (!guarded.acquired) {
    return { attempted: 0, indexed: 0, skipped: true, operationLease: guarded.busy };
  }
  return guarded.value;
}

async function reindexEightKDatasetUnlocked(
  userId: string,
  limit: number,
  operationLeaseClaim: OperationLeaseClaim,
  operationLeaseSignal: AbortSignal
): Promise<ReindexEightKResult> {
  assertOperationLeaseOwnership(operationLeaseClaim);
  const dataset = getEightKDataset();
  const events = dataset?.events ?? [];
  if (events.length === 0) return { attempted: 0, indexed: 0 };
  const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : events.length;
  const slice = events.slice(0, cap);
  const { storeContexts } = await import("../vector-db");
  const result = await storeContexts(
    slice.map((event) => ({
      text: buildEightKContext(event),
      metadata: {
        symbol: event.symbol,
        source: "sec-8k",
        timestamp: event.filedAt,
        // Point-in-time anchor so retrieveContextDetailed({asOf}) can exclude look-ahead filings.
        acceptance_datetime: event.acceptedAt ?? event.filedAt,
        doc_type: "8-k",
        accession: event.accession,
        filingUrl: event.filingUrl,
        items: event.items ?? []
      }
    })),
    userId,
    {
      leaseGuard: {
        signal: operationLeaseSignal,
        assertOwnership: () => {
          throwIfOperationLeaseCancelled(operationLeaseSignal);
          assertOperationLeaseOwnership(operationLeaseClaim);
        }
      }
    }
  );
  throwIfOperationLeaseCancelled(operationLeaseSignal);
  return result;
}

export async function refreshEightK(
  now: number = Date.now(),
  force = false,
  operationLeaseClaim?: OperationLeaseClaim
): Promise<OperationLeaseAware<import("./types").WebSourceRefreshResult>> {
  const discoveryDue = force || isEightKDiscoveryDue(now);
  // Discovery cadence must not gate durable delivery. A prior tick may have committed the dataset
  // and backlog and then crashed/been RAG-busy before embedding it.
  if (!discoveryDue && !hasEightKRagBacklog() && !hasDurableMaterialTriggerWork()) {
    const ds = getEightKDataset();
    return { id: "sec8k", ok: true, recordCount: ds?.recordCount ?? 0, sources: ds ? ["sec-edgar"] : [], fetchedAt: ds?.fetchedAt ?? "", skipped: true };
  }

  const guarded = await runWithOperationLease(
    {
      group: OPERATION_LEASE_GROUPS.SEC8K_WEB_SOURCE,
      operation: discoveryDue ? "refresh-websource:sec8k" : "drain-websource:sec8k-rag",
      claim: operationLeaseClaim
    },
    async (claim, signal) => refreshEightKUnlocked(now, force, claim, signal)
  );
  if (!guarded.acquired) {
    const ds = getEightKDataset();
    return {
      id: "sec8k",
      ok: true,
      recordCount: ds?.recordCount ?? 0,
      sources: ds ? ["sec-edgar"] : [],
      fetchedAt: ds?.fetchedAt ?? "",
      skipped: true,
      warning: `Skipped because ${guarded.busy.activeOperation} is already refreshing the SEC 8-K dataset.`,
      operationLease: guarded.busy
    };
  }
  return guarded.value;
}

async function refreshEightKUnlocked(
  now: number,
  force: boolean,
  operationLeaseClaim: OperationLeaseClaim,
  operationLeaseSignal: AbortSignal
): Promise<import("./types").WebSourceRefreshResult> {
  // Recheck after durable acquisition so a delayed scheduler process cannot repeat discovery after
  // the prior owner advanced the cadence. Backlog delivery remains independently due every tick.
  const discoveryDue = force || isEightKDiscoveryDue(now);
  if (!discoveryDue && !hasEightKRagBacklog() && !hasDurableMaterialTriggerWork()) {
    const ds = getEightKDataset();
    return { id: "sec8k", ok: true, recordCount: ds?.recordCount ?? 0, sources: ds ? ["sec-edgar"] : [], fetchedAt: ds?.fetchedAt ?? "", skipped: true };
  }
  assertOperationLeaseOwnership(operationLeaseClaim);

  const prior = getEightKDataset();
  let dataset = prior;
  let fresh: EightKEvent[] = [];
  let warning: string | undefined;
  if (discoveryDue) {
    setInternalSetting(ATTEMPT_KEY, new Date(now).toISOString());
    try {
      const cikMap = await loadCikMap(now);
      throwIfOperationLeaseCancelled(operationLeaseSignal);
      assertOperationLeaseOwnership(operationLeaseClaim);
      const feed = await politeFetchText(
        `${SEC_BASE}/cgi-bin/browse-edgar?action=getcurrent&type=8-K&count=100&output=atom`,
        { headers: { "user-agent": secUserAgent(), accept: "application/atom+xml" } }
      );
      throwIfOperationLeaseCancelled(operationLeaseSignal);
      assertOperationLeaseOwnership(operationLeaseClaim);
      fresh = parseCurrent8KFeed(feed)
        .map((row): EightKEvent | undefined => {
          const symbol = cikMap[row.cik];
          if (!symbol) return undefined;
          return {
            symbol,
            filedAt: row.filedAt ?? new Date(now).toISOString().slice(0, 10),
            ...(row.acceptedAt ? { acceptedAt: row.acceptedAt } : {}),
            accession: row.accession,
            ...(row.filingUrl ? { filingUrl: row.filingUrl } : {})
          };
        })
        .filter((event): event is EightKEvent => Boolean(event));
      fresh = await enrichEightKEvents(fresh);
      throwIfOperationLeaseCancelled(operationLeaseSignal);
      assertOperationLeaseOwnership(operationLeaseClaim);
    } catch (error) {
      throwIfOperationLeaseCancelled(operationLeaseSignal);
      assertOperationLeaseOwnership(operationLeaseClaim);
      warning = error instanceof Error ? error.message : "sec8k failed";
    }

    const merged = mergeEightK(prior?.events ?? [], fresh, now);
    if (merged.length > 0) {
      const fetchedAt = fresh.length > 0
        ? new Date(now).toISOString()
        : (prior?.fetchedAt ?? new Date(now).toISOString());
      dataset = { events: merged, fetchedAt, recordCount: merged.length };
      assertOperationLeaseOwnership(operationLeaseClaim);
      if (fresh.length > 0) {
        const materialEvents: MaterialEvent[] = fresh
          .filter(eightKHasMaterialItem)
          .map((event) => ({
            type: "sec8k",
            symbol: event.symbol,
            sourceId: event.accession,
            reason: `8-K ${event.items?.[0] ?? ""}`.trim()
          }));
        const triggerUserIds = materialEvents.length > 0 ? eligibleMaterialTriggerUserIds() : [];
        // This is the durability boundary: discovery and every enabled downstream queue become
        // visible together, before any trigger/provider work can fail.
        persistEightKDiscovery(
          dataset,
          fresh,
          eightKFullBodyEnabled(),
          triggerUserIds,
          materialEvents,
          now
        );
      } else {
        setInternalSetting(DATASET_KEY, dataset);
      }
      assertOperationLeaseOwnership(operationLeaseClaim);
    }
    audit("web_source_refresh", {
      id: "sec8k",
      ok: fresh.length > 0,
      recordCount: dataset?.recordCount ?? 0,
      fresh: fresh.length,
      warning
    });
  }

  const ragWarning = await drainEightKRagBacklogs(now, operationLeaseClaim, operationLeaseSignal);
  let triggerWarning: string | undefined;
  try {
    assertOperationLeaseOwnership(operationLeaseClaim);
    const { drainMaterialEventQueue } = await import("../triggers");
    drainMaterialEventQueue();
    assertOperationLeaseOwnership(operationLeaseClaim);
  } catch (error) {
    throwIfOperationLeaseCancelled(operationLeaseSignal);
    assertOperationLeaseOwnership(operationLeaseClaim);
    triggerWarning = `8-K material trigger deferred: ${error instanceof Error ? error.message : String(error)}`;
  }
  const ok = discoveryDue ? fresh.length > 0 : true;
  if (!dataset && !hasEightKRagBacklog() && !hasDurableMaterialTriggerWork()) {
    return {
      id: "sec8k",
      ok: false,
      recordCount: 0,
      sources: [],
      fetchedAt: "",
      warning: [warning ?? "no events", ragWarning, triggerWarning].filter(Boolean).join("; ") || undefined,
      ...(!discoveryDue ? { skipped: true } : {})
    };
  }

  return {
    id: "sec8k",
    ok,
    recordCount: dataset?.recordCount ?? 0,
    sources: dataset ? ["sec-edgar"] : [],
    fetchedAt: dataset?.fetchedAt ?? "",
    warning: [warning, ragWarning, triggerWarning].filter(Boolean).join("; ") || undefined,
    ...(!discoveryDue ? { skipped: true } : {})
  };
}

async function drainEightKRagBacklogs(
  now: number,
  operationLeaseClaim: OperationLeaseClaim,
  operationLeaseSignal: AbortSignal
): Promise<string | undefined> {
  const summaryBacklog = getEightKSummaryBacklog();
  const bodyBacklog = eightKFullBodyEnabled() ? getEightKFullBodyBacklog() : [];
  if (summaryBacklog.length === 0 && bodyBacklog.length === 0) return undefined;

  try {
    const ragGuarded = await runWithOperationLease(
      { group: OPERATION_LEASE_GROUPS.RAG_REINDEX, operation: "refresh-sec8k-rag" },
      async (ragClaim, ragSignal) => {
        const warnings: string[] = [];
        const combinedSignal = AbortSignal.any([operationLeaseSignal, ragSignal]);
        const assertRagOwnership = () => {
          throwIfOperationLeaseCancelled(combinedSignal);
          assertOperationLeaseOwnership(operationLeaseClaim);
          assertOperationLeaseOwnership(ragClaim);
        };
        const leaseGuard: VectorStoreLeaseGuard = {
          signal: combinedSignal,
          assertOwnership: assertRagOwnership
        };
        assertRagOwnership();
        const ragEvents = summaryBacklog.slice(0, eightKRagLimit());
        if (ragEvents.length > 0) {
          const { storeContexts } = await import("../vector-db");
          assertRagOwnership();
          const summaryResult = await storeContexts(
            ragEvents.map((event) => ({
              text: buildEightKContext(event),
              metadata: {
                symbol: event.symbol,
                source: "sec-8k",
                timestamp: event.filedAt,
                acceptance_datetime: event.acceptedAt ?? event.filedAt,
                doc_type: "8-k",
                accession: event.accession,
                filingUrl: event.filingUrl,
                items: event.items ?? []
              }
            })),
            "local",
            {
              ...(storeContextsDedupEnabled() ? { dedupKeyPrefix: "sec8k-summary" } : {}),
              leaseGuard
            }
          );
          assertRagOwnership();
          const exactWrite =
            summaryResult.attempted === ragEvents.length &&
            summaryResult.indexed === ragEvents.length;
          const summaryComplete =
            !summaryResult.error &&
            summaryResult.unconfigured !== true &&
            (summaryResult.budgetSkipped ?? 0) === 0 &&
            (summaryResult.writeUnitBudgetSkipped ?? 0) === 0 &&
            (summaryResult.rejectedInvalidEmbeddings ?? 0) === 0 &&
            (exactWrite || summaryResult.dedupComplete === true);
          if (summaryComplete) {
            const completed = new Set(ragEvents.map((event) => event.accession));
            persistEightKSummaryBacklog(summaryBacklog.filter((event) => !completed.has(event.accession)));
            for (const event of ragEvents) {
              await writeEightKCorpusSidecar(event.accession, buildEightKContext(event));
            }
            assertRagOwnership();
          } else {
            warnings.push(`8-K summary RAG deferred${summaryResult.error ? `: ${summaryResult.error}` : " by RAG capacity"}`);
          }
        }

        if (bodyBacklog.length > 0) {
          const cap = eightKFullBodyLimit();
          const bodyBatch = bodyBacklog.slice(0, cap);
          const bodyResult = await ingestEightKBodies(bodyBatch, now, leaseGuard);
          assertRagOwnership();
          const completed = new Set(bodyResult.completedAccessions);
          const attemptedPrefix = bodyBatch.slice(0, bodyResult.attempted);
          const notAttempted = [
            ...bodyBatch.slice(bodyResult.attempted),
            ...bodyBacklog.slice(bodyBatch.length)
          ];
          const retryLater = attemptedPrefix.filter((event) => !completed.has(event.accession));
          // Rotate retryable failures behind never-attempted work so one permanent bad filing cannot
          // starve the bounded queue. Duplicate accessions from the next SEC feed preserve this order.
          persistEightKFullBodyBacklog([...notAttempted, ...retryLater]);
          assertRagOwnership();
          if (bodyResult.errors.length > 0) {
            warnings.push(`8-K full-body deferred (${bodyResult.errors.length} error(s))`);
          } else if (bodyResult.capacityExhausted) {
            warnings.push("8-K full-body deferred by RAG capacity");
          }
        }
        assertRagOwnership();
        return warnings;
      }
    );
    if (!ragGuarded.acquired) {
      return `8-K RAG deferred because ${ragGuarded.busy.activeOperation} owns the shared ingest lease.`;
    }
    return ragGuarded.value.join("; ") || undefined;
  } catch (error) {
    // Provider/RAG failures leave the durable queue untouched. Only loss of the outer SEC owner is
    // terminal; do not disguise it as a retryable provider warning.
    throwIfOperationLeaseCancelled(operationLeaseSignal);
    assertOperationLeaseOwnership(operationLeaseClaim);
    return `8-K RAG deferred: ${error instanceof Error ? error.message : String(error)}`;
  }
}

// ── 8-K full-body ingest (gated behind WEB_SOURCE_SEC8K_FULL_BODY) ───────────

const DEFAULT_SEC8K_FULL_BODY_LIMIT = 5;
/** Wall-time cap for one refresh cycle of full-body ingest.  Keeps FTS+chunk work
 *  from fusing into the 60s event-loop stalls that adaptive FTS batching was built
 *  to stop.  Env 0/invalid falls back to this default; hard-capped at 60s. */
const DEFAULT_SEC8K_FULL_BODY_BUDGET_MS = 12_000;
const MAX_SEC8K_FULL_BODY_BUDGET_MS = 60_000;

export function eightKFullBodyLimit(): number {
  const value = Number(process.env.WEB_SOURCE_SEC8K_FULL_BODY_LIMIT ?? DEFAULT_SEC8K_FULL_BODY_LIMIT);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_SEC8K_FULL_BODY_LIMIT;
}

export function eightKFullBodyBudgetMs(): number {
  const value = Number(process.env.WEB_SOURCE_SEC8K_FULL_BODY_BUDGET_MS ?? DEFAULT_SEC8K_FULL_BODY_BUDGET_MS);
  return Number.isFinite(value) && value > 0
    ? Math.min(MAX_SEC8K_FULL_BODY_BUDGET_MS, Math.floor(value))
    : DEFAULT_SEC8K_FULL_BODY_BUDGET_MS;
}

/** Pure: stop the cycle after the current filing when elapsed >= budget. */
export function eightKBodyCycleShouldStop(startedAtMs: number, nowMs: number, budgetMs: number): boolean {
  return nowMs - startedAtMs >= budgetMs;
}

function assertEightKIngestLease(leaseGuard?: VectorStoreLeaseGuard): void {
  if (leaseGuard?.signal) throwIfOperationLeaseCancelled(leaseGuard.signal);
  leaseGuard?.assertOwnership();
}

/** Whether full 8-K body ingestion is enabled (default OFF). Settings / Infisical. */
export function eightKFullBodyEnabled(): boolean {
  return resolveSourceBool("WEB_SOURCE_SEC8K_FULL_BODY");
}

/**
 * Fetch the full 8-K filing body for one event, chunk it via storeDocument, and record
 * the accession in ingested_accessions so the same filing is never re-fetched.
 *
 * Only calls storeDocument when the accession isn't already in ingested_accessions.
 * Returns the number of chunks indexed (0 = skipped or failed).
 */
export async function ingestEightKBody(
  event: EightKEvent,
  _now: number = Date.now(),
  leaseGuard?: VectorStoreLeaseGuard
): Promise<{
  skipped: boolean;
  chunks: number;
  error?: string;
  completed?: boolean;
  retryable?: boolean;
  capacityExhausted?: boolean;
}> {
  assertEightKIngestLease(leaseGuard);
  if (hasIngestedAccession(event.accession, "8-K-body")) {
    // Body already ledgered — still upgrade extractive abstract if model lags.
    try {
      const { abstractNeedsUpgrade, generateAndStoreDocumentAbstract, tradeHighlightChunksFromText } =
        await import("../rag/document-summarizer");
      if (abstractNeedsUpgrade(event.accession, "8k-brief")) {
        const url = absoluteSecUrl(event.filingUrl);
        if (url) {
          const html = await politeFetchText(url, {
            headers: {
              "user-agent": secUserAgent(),
              accept: "text/html,application/xhtml+xml"
            },
            timeoutMs: 30_000
          });
          const bodyText = extractFilingText(html);
          if (bodyText.length >= 100) {
            await writeEightKCorpusSidecar(event.accession, bodyText, html);
            const itemsHint = (event.items ?? []).slice(0, 6).join(", ");
            await generateAndStoreDocumentAbstract({
              ticker: event.symbol,
              accessionOrEventId: event.accession,
              sourceType: "8k-brief",
              headline: `${event.symbol} 8-K highlights (${event.filedAt})${itemsHint ? ` — ${itemsHint}` : ""}`,
              chunks: tradeHighlightChunksFromText(bodyText, {
                maxChunks: 6,
                formHint: "8-K",
                materialItems: event.items ?? []
              }),
              publishedAt: event.filedAt,
              acceptanceDatetime: event.acceptedAt ?? event.filedAt
            });
          }
        }
      }
    } catch (err) {
      console.warn(
        `[sec8k] abstract refresh skipped for ${event.accession}:`,
        err instanceof Error ? err.message : String(err)
      );
    }
    return { skipped: true, chunks: 0, completed: true };
  }

  const url = absoluteSecUrl(event.filingUrl);
  if (!url) {
    return { skipped: false, chunks: 0, error: "no filing URL", retryable: true };
  }
  const vectorDb = await import("../vector-db");
  assertEightKIngestLease(leaseGuard);
  if (!vectorDb.hasIngestTextBudget("local") || !vectorDb.hasVectorIngestWriteBudget("local")) {
    return { skipped: true, chunks: 0, retryable: true, capacityExhausted: true };
  }

  let html: string;
  try {
    assertEightKIngestLease(leaseGuard);
    html = await politeFetchText(url, {
      headers: { "user-agent": secUserAgent(), accept: "text/html,application/xhtml+xml" },
      timeoutMs: 30_000
    });
    assertEightKIngestLease(leaseGuard);
  } catch (err) {
    assertEightKIngestLease(leaseGuard);
    return { skipped: false, chunks: 0, error: `fetch failed: ${err instanceof Error ? err.message : String(err)}`, retryable: true };
  }

  const text = timeSync("sec8kExtract", event.accession, () => extractFilingText(html));
  if (text.length < 100) {
    return { skipped: false, chunks: 0, error: "extracted text too short", retryable: true };
  }

  await writeEightKCorpusSidecar(event.accession, text, html);

  // Insert into sec_artifacts
  try {
    assertEightKIngestLease(leaseGuard);
    const { createHash } = await import("crypto");
    assertEightKIngestLease(leaseGuard);
    const sha256 = createHash("sha256").update(html).digest("hex");
    const byteCount = Buffer.byteLength(html, "utf8");
    const { insertSecArtifact } = await import("../db");
    assertEightKIngestLease(leaseGuard);
    insertSecArtifact({
      accession: event.accession,
      sequence: 1,
      documentName: "main.html",
      sha256,
      type: "html",
      byteCount,
      rawUri: url,
      parserVersion: "v1"
    });
    assertEightKIngestLease(leaseGuard);
  } catch (err) {
    // Artifact persistence remains best-effort for ordinary SQLite errors, but a stale owner must
    // stop immediately rather than continuing into the vector write.
    assertEightKIngestLease(leaseGuard);
    console.warn(`[sec8k] insertSecArtifact failed for ${event.accession} (non-fatal):`, err instanceof Error ? err.message : String(err));
  }

  assertEightKIngestLease(leaseGuard);
  const result = await vectorDb.storeDocument(
    {
      text,
      doc_id: event.accession,
      ticker: event.symbol,
      title: `${event.symbol} 8-K (${event.filedAt})`,
      doc_type: "8-k",
      published_at: event.filedAt,
      acceptance_datetime: event.acceptedAt ?? event.filedAt,
      source: "sec-8k",
      url
    },
    "local",
    {
      parserRevision: "sec8k-full-body-v1",
      ...(leaseGuard ? { leaseGuard } : {})
    }
  );
  assertEightKIngestLease(leaseGuard);

  if (result.error) {
    return { skipped: false, chunks: result.indexed, error: result.error, retryable: true };
  }

  const outOfCapacity =
    result.unconfigured === true ||
    (result.budgetSkipped ?? 0) > 0 ||
    (result.writeUnitBudgetSkipped ?? 0) > 0;
  const reusedCommitted =
    result.reusedCommitted === true && result.documentComplete === true && result.attempted > 0;
  if (
    outOfCapacity ||
    result.attempted <= 0 ||
    result.documentComplete !== true ||
    (!reusedCommitted && result.indexed !== result.attempted)
  ) {
    // Keep the accession retryable. A no-error partial/budget result is not a completed source
    // document and must never suppress a later full occurrence write.
    return {
      skipped: true,
      chunks: result.indexed,
      retryable: true,
      ...(outOfCapacity ? { capacityExhausted: true } : {})
    };
  }
  if (!result.managedCommitProof) {
    return { skipped: true, chunks: result.indexed, error: "document-commit-proof-missing", retryable: true };
  }

  try {
    assertEightKIngestLease(leaseGuard);
    const { chunkDocument } = await import("../rag/chunk");
    const { insertDocumentChunkFtsBatch } = await import("../db");
    // Same document shape as storeDocument above so FTS content_hash/accession identity matches the
    // committed vectors (mirrors sec-filings.ts production filing-body FTS path).
    const document = {
      text,
      doc_id: event.accession,
      ticker: event.symbol,
      title: `${event.symbol} 8-K (${event.filedAt})`,
      doc_type: "8-k" as const,
      published_at: event.filedAt,
      acceptance_datetime: event.acceptedAt ?? event.filedAt,
      source: "sec-8k" as const,
      url
    };
    // Chunk BEFORE the commit-proof transaction (same 2026-08-10 stall fix as sec-filings):
    // chunkDocument is multi-second CPU on a large HTML body and must not hold the SQLite write lock.
    const ftsChunks = timeSync("sec8kChunk", event.accession, () => chunkDocument(document, {}));
    await yieldEventLoop();
    assertEightKIngestLease(leaseGuard);
    // Adaptive FTS sub-batches + yields (insertDocumentChunkFtsBatch) — never one sync txn of
    // every row.  Accession is stamped only after FTS succeeds so a crash stays retryable.
    await insertDocumentChunkFtsBatch(
      ftsChunks.map((chunk) => ({
        contentHash: chunk.content_hash,
        symbol: chunk.ticker[0] ?? event.symbol,
        source: "sec-8k",
        accession: event.accession,
        text: chunk.text
      }))
    );
    assertEightKIngestLease(leaseGuard);
    runWithActiveVectorCommitProof(result.managedCommitProof, () => {
      insertIngestedAccession(event.accession, "8-K-body", event.symbol, result.attempted);
    });
  } catch {
    return { skipped: true, chunks: result.indexed, error: "document-commit-proof-lost", retryable: true };
  }

  // Trade-relevant highlights as a short document-summary (full 8-k body remains retrievable).
  try {
    const { generateAndStoreDocumentAbstract, tradeHighlightChunksFromText } = await import(
      "../rag/document-summarizer"
    );
    const itemsHint = (event.items ?? []).slice(0, 6).join(", ");
    await generateAndStoreDocumentAbstract({
      ticker: event.symbol,
      accessionOrEventId: event.accession,
      sourceType: "8k-brief",
      headline: `${event.symbol} 8-K highlights (${event.filedAt})${itemsHint ? ` — ${itemsHint}` : ""}`,
      chunks: tradeHighlightChunksFromText(text, {
        maxChunks: 6,
        formHint: "8-K",
        materialItems: event.items ?? []
      }),
      publishedAt: event.filedAt,
      acceptanceDatetime: event.acceptedAt ?? event.filedAt
    });
  } catch (err) {
    console.warn(
      `[sec8k] abstract failed for ${event.accession}:`,
      err instanceof Error ? err.message : String(err)
    );
  }

  return { skipped: false, chunks: result.attempted, completed: true };
}

/**
 * Ingest full 8-K bodies for multiple events sequentially (respects EDGAR fair-use).
 * Never throws — errors are logged and aggregated.
 */
export async function ingestEightKBodies(
  events: EightKEvent[],
  now: number = Date.now(),
  leaseGuard?: VectorStoreLeaseGuard,
  opts?: { budgetMs?: number }
): Promise<{
  attempted: number;
  ingested: number;
  skipped: number;
  errors: string[];
  completedAccessions: string[];
  deferredAccessions: string[];
  capacityExhausted: boolean;
  budgetExhausted?: boolean;
}> {
  const result = {
    attempted: 0,
    ingested: 0,
    skipped: 0,
    errors: [] as string[],
    completedAccessions: [] as string[],
    deferredAccessions: [] as string[],
    capacityExhausted: false,
    budgetExhausted: false
  };
  const budgetMs = opts?.budgetMs ?? eightKFullBodyBudgetMs();
  const startedAt = Date.now();
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!;
    assertEightKIngestLease(leaseGuard);
    result.attempted++;
    try {
      const ingestResult = await ingestEightKBody(event, now, leaseGuard);
      if (ingestResult.completed) {
        result.completedAccessions.push(event.accession);
        if (ingestResult.skipped) result.skipped++;
        else result.ingested++;
      } else {
        if (ingestResult.skipped) result.skipped++;
        result.deferredAccessions.push(event.accession);
      }
      if (ingestResult.error) {
        result.errors.push(`${event.symbol} ${event.accession}: ${ingestResult.error}`);
      }
      if (ingestResult.capacityExhausted) {
        result.capacityExhausted = true;
        result.deferredAccessions.push(...events.slice(index + 1).map((item) => item.accession));
        break;
      }
      if (index + 1 < events.length && eightKBodyCycleShouldStop(startedAt, Date.now(), budgetMs)) {
        result.budgetExhausted = true;
        result.deferredAccessions.push(...events.slice(index + 1).map((item) => item.accession));
        break;
      }
      // Polite delay between EDGAR fetches + yield so queued HTTP can run.
      if (index + 1 < events.length) {
        await yieldEventLoop();
        await sleep(300);
        assertEightKIngestLease(leaseGuard);
      }
    } catch (err) {
      assertEightKIngestLease(leaseGuard);
      result.deferredAccessions.push(event.accession);
      result.errors.push(`${event.symbol} ${event.accession}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return result;
}
