// ROIC.ai earnings-call transcript ingestion -> shared RAG corpus.
//
// Full transcripts from ROIC.ai:
//   v3 list: GET /v3.0.0/earnings-calls?identifier=EXCHANGE:SYM
//   v3 body: GET /v3.0.0/earnings-calls/{NASDAQ:SYM}?fiscal_year=&fiscal_quarter=
//   v2 fallback: GET /v2/company/earnings-calls/latest/{SYM} (latest only)
// Local-complete first: earningscalls_transcripts.content + data/roic-artifacts
// (survives Individual expiry).  Cached list/body never re-hit ROIC.
// Pinecone: extractive earnings-summary for latest/deepen; full-body only for the
// latest high-interest call (proposer-corpus rev 3). Archive = local only.
//
// Scheduler: refreshRoicTranscriptsIfDue (wired from scheduler.ts). Opt-in = ROIC key present;
// kill-switch ROIC_TRANSCRIPTS_DISABLED=1. Quarters-per-symbol follow Connections plan tier
// (free=2, individual=20, professional=40 app cap) unless ROIC_TRANSCRIPTS_QUARTERS_PER_SYMBOL
// overrides. Per-run fetch budget follows the same tier (free-safe 8, Individual default 80).

import { fetchWithRetry } from "../data-providers";
import { audit } from "../db";
import { hasInFlightStrategyWork, shouldDeferBackgroundRagForStrategy } from "../db-execution";
import {
  getUserApiKey,
  LOCAL_USER,
  resolveApiKeyWithSource
} from "../db-api-keys";
import { logApiHealth } from "../db-health";
import {
  getEarningsCallsTranscript,
  listEarningsCallsTranscriptsForSymbol,
  markEarningsCallsTranscriptIngested,
  summarizeEarningsCallsTranscriptCoverage,
  upsertEarningsCallsTranscript
} from "../db-earningscalls";
import {
  countRoicTranscriptArtifactFiles,
  listRoicTranscriptArtifacts,
  readRoicCallIndexArtifact,
  readRoicTranscriptArtifact,
  writeRoicCallIndexArtifact,
  writeRoicTranscriptArtifact
} from "../roic-archive-artifacts";
import { hasIngestedAccession, insertIngestedAccession } from "../db-learning";
import { getInternalSetting, setInternalSetting } from "../db-settings";
import { normalizeSymbol } from "../money";
import { admitProviderRequests, withProviderLimit } from "../provider-rate-limit";
import { lookupRegisteredPlanTier, roicTranscriptQuartersForPlan } from "../provider-tier-plan";
import {
  ROIC_TRANSCRIPT_DOC_TYPE,
  ROIC_TRANSCRIPT_SOURCE,
  roicTranscriptsKillSwitchOn
} from "../roic-transcripts-gate";
import { resolveSourceNumber } from "../source-settings";
import { rankDemandFirstSymbols, rankHighInterestSymbols } from "../rag/demand-first-symbols";
import { chunkDocument } from "../rag/chunk";
import { storeSignalSectionDocuments } from "../rag/processed-corpus-write";
import { yieldEventLoop } from "../slow-sync-guard";
import { hasVectorIngestWriteBudget, storeDocument } from "../vector-db";

export { ROIC_TRANSCRIPT_DOC_TYPE, ROIC_TRANSCRIPT_SOURCE, roicTranscriptsKillSwitchOn };

const ROIC_V3_BASE = "https://api.roic.ai/v3.0.0";
const ROIC_V2_BASE = "https://api.roic.ai/v2";
const LAST_COMPLETE_KEY = "webSource:roicTranscripts:lastCompleteAt";
const LAST_ATTEMPT_KEY = "webSource:roicTranscripts:lastAttemptAt";
const CURSOR_KEY = "webSource:roicTranscripts:cursor";
const DEFAULT_COMPLETE_TTL_HOURS = 6;
/** A started run that has not yet persisted a cursor is treated as in-flight. */
export const ROIC_REFRESH_RUN_STALE_MS = 30 * 60 * 1_000;
const DEFAULT_MAX_TRANSCRIPTS_PER_RUN_FREE = 8;
const DEFAULT_MAX_TRANSCRIPTS_PER_RUN_PAID = 80;

export function roicTranscriptAccession(symbol: string, year: number, quarter: number): string {
  return `roic:${normalizeSymbol(symbol)}:${year}Q${quarter}`;
}

/** Key present (user or env) and kill-switch off. */
export function roicTranscriptsEnabled(userId?: string): boolean {
  if (roicTranscriptsKillSwitchOn()) return false;
  return Boolean(resolveApiKeyWithSource("roic", userId).key);
}

function paidRoicPlan(userId?: string): boolean {
  let tier = lookupRegisteredPlanTier("roic");
  if (tier === undefined || tier === null) {
    try {
      const row = getUserApiKey(userId ?? LOCAL_USER, "roic");
      tier = row?.planTier ?? null;
    } catch {
      tier = null;
    }
  }
  const id = (tier ?? "").toLowerCase();
  return id === "individual" || id === "professional" || id === "enterprise";
}

function completeTtlMs(): number {
  const h = Number(process.env.ROIC_TRANSCRIPTS_TTL_HOURS ?? DEFAULT_COMPLETE_TTL_HOURS);
  return Math.max(1, Number.isFinite(h) ? h : DEFAULT_COMPLETE_TTL_HOURS) * 3_600_000;
}

function maxTranscriptsPerRun(userId?: string): number {
  const paid = paidRoicPlan(userId);
  const fallback = paid ? DEFAULT_MAX_TRANSCRIPTS_PER_RUN_PAID : DEFAULT_MAX_TRANSCRIPTS_PER_RUN_FREE;
  const cap = paid ? 300 : 20;
  const n = resolveSourceNumber("ROIC_TRANSCRIPTS_MAX_PER_RUN");
  const raw = Number.isFinite(n) ? n : fallback;
  return Math.max(1, Math.min(cap, Math.floor(raw)));
}

/** Effective quarters: env override wins, else Connections plan tier, else free-safe 2. */
export function quartersPerSymbol(userId?: string): number {
  const envRaw = process.env.ROIC_TRANSCRIPTS_QUARTERS_PER_SYMBOL;
  if (envRaw !== undefined && envRaw.trim() !== "") {
    const n = Number(envRaw);
    if (Number.isFinite(n)) return Math.max(1, Math.min(40, Math.floor(n)));
  }
  let tier = lookupRegisteredPlanTier("roic");
  if (tier === undefined || tier === null) {
    try {
      const row = getUserApiKey(userId ?? LOCAL_USER, "roic");
      tier = row?.planTier ?? null;
    } catch {
      tier = null;
    }
  }
  return roicTranscriptQuartersForPlan(tier);
}

/**
 * Most recent completed fiscal quarters to try (calendar approximation).
 * Used only when the vendor list endpoint is empty.  Earnings for calendar Q1
 * usually print in the following months — we walk backward from the previous
 * calendar quarter so we rarely request the current unfinished period.
 */
export function recentFiscalPeriods(
  now: Date = new Date(),
  count: number = quartersPerSymbol()
): Array<{ year: number; quarter: number }> {
  let year = now.getUTCFullYear();
  let quarter = Math.floor(now.getUTCMonth() / 3);
  if (quarter === 0) {
    year -= 1;
    quarter = 4;
  }
  const out: Array<{ year: number; quarter: number }> = [];
  for (let i = 0; i < count; i++) {
    out.push({ year, quarter });
    quarter -= 1;
    if (quarter < 1) {
      quarter = 4;
      year -= 1;
    }
  }
  return out;
}

export type RoicIngestPhase = "latest" | "deepen" | "archive";
export type RoicPineconeWriteClass = "full-body" | "highlight-only" | "local-only";

export interface RoicCursor {
  queue: string[];
  updatedAt: string;
  phase: RoicIngestPhase;
}

export function sortRoicPeriodsNewestFirst<T extends { year: number; quarter: number }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => b.year - a.year || b.quarter - a.quarter);
}

/** Latest-only pass takes one period; deepen/archive use the plan-tier quarter cap. */
export function roicDepthForPhase(phase: RoicIngestPhase, userId?: string): number {
  return phase === "latest" ? 1 : quartersPerSymbol(userId);
}

/**
 * Approved proposer-corpus write class for one call (rev 3).
 * Latest high-interest stays full-body until a transcript FTS mirror exists.
 * Other latest/deepen calls write extractive earnings-summary only.
 * Archive is local cache so we keep Individual history after the tier ends.
 */
export function roicPineconeWriteClass(args: {
  phase: RoicIngestPhase;
  symbol: string;
  newestPeriod: boolean;
  highInterest: ReadonlySet<string>;
}): RoicPineconeWriteClass {
  if (args.phase === "archive") return "local-only";
  if (args.highInterest.has(normalizeSymbol(args.symbol)) && args.newestPeriod) {
    return "full-body";
  }
  return "highlight-only";
}

/** Universe minus held/watchlist/technical — extra Individual history, local only. */
export function archiveRoicQueue(now?: number): string[] {
  const high = new Set(rankHighInterestSymbols({ now }));
  return rankDemandFirstSymbols({ now }).filter((symbol) => !high.has(symbol));
}

export function selectRoicPeriodsForPhase<T extends { year: number; quarter: number }>(
  periods: T[],
  phase: RoicIngestPhase,
  depth: number
): T[] {
  const cap = phase === "latest" ? 1 : Math.max(1, depth);
  return sortRoicPeriodsNewestFirst(periods).slice(0, cap);
}

export interface RoicPeriodRef {
  year: number;
  quarter: number;
  date?: string;
}

export type RoicSymbolWorkPlan =
  | {
      action: "skip-covered";
      coveredCount: number;
      reason: "local-depth" | "index-complete" | "latest-cached";
    }
  | {
      action: "fetch-gaps";
      needsList: boolean;
      periods: RoicPeriodRef[];
    };

function periodKey(period: { year: number; quarter: number }): string {
  return `${period.year}Q${period.quarter}`;
}

/**
 * Decide whether this symbol still needs ROIC HTTP.
 * Cached SQLite/artifact rows and a persisted call-index never re-list or re-fetch.
 */
export function planRoicSymbolWork(args: {
  phase: RoicIngestPhase;
  depth: number;
  localPeriods: RoicPeriodRef[];
  cachedIndex: RoicPeriodRef[] | null;
}): RoicSymbolWorkPlan {
  const depth = args.phase === "latest" ? 1 : Math.max(1, args.depth);
  const localKeys = new Set(args.localPeriods.map(periodKey));

  if (args.cachedIndex && args.cachedIndex.length > 0) {
    const target = selectRoicPeriodsForPhase(args.cachedIndex, args.phase, depth);
    const missing = target.filter((period) => !localKeys.has(periodKey(period)));
    if (missing.length === 0) {
      return { action: "skip-covered", coveredCount: target.length, reason: "index-complete" };
    }
    return { action: "fetch-gaps", needsList: false, periods: missing };
  }

  if (args.phase === "latest" && args.localPeriods.length > 0) {
    return { action: "skip-covered", coveredCount: 1, reason: "latest-cached" };
  }
  if (args.phase !== "latest" && args.localPeriods.length >= depth) {
    return { action: "skip-covered", coveredCount: args.localPeriods.length, reason: "local-depth" };
  }
  return { action: "fetch-gaps", needsList: true, periods: [] };
}

function identifiersForRoicFetch(symbol: string, preferred?: string): string[] {
  const ids = roicV3Identifiers(symbol);
  if (!preferred) return ids;
  return [preferred, ...ids.filter((id) => id !== preferred)];
}

export function readRoicCursor(): RoicCursor | null {
  const raw = getInternalSetting<unknown>(CURSOR_KEY);
  if (!raw || typeof raw !== "object") return null;
  const queue = (raw as { queue?: unknown }).queue;
  if (!Array.isArray(queue)) return null;
  const symbols = queue.map((s) => normalizeSymbol(String(s))).filter(Boolean);
  const updatedAt = typeof (raw as { updatedAt?: unknown }).updatedAt === "string"
    ? (raw as { updatedAt: string }).updatedAt
    : "";
  const rawPhase = (raw as { phase?: unknown }).phase;
  const phase: RoicIngestPhase =
    rawPhase === "deepen" ? "deepen" : rawPhase === "archive" ? "archive" : "latest";
  return { queue: symbols, updatedAt, phase };
}

function writeRoicCursor(queue: string[], nowIso: string, phase: RoicIngestPhase): void {
  if (queue.length === 0) {
    setInternalSetting(CURSOR_KEY, null);
    return;
  }
  setInternalSetting(CURSOR_KEY, { queue, updatedAt: nowIso, phase } satisfies RoicCursor);
}

export interface RoicRefreshDueState {
  enabled: boolean;
  cursorQueueLength: number;
  lastCompleteAt?: string | null;
  lastAttemptAt?: string | null;
  now: number;
  completeTtlMs: number;
  runStaleMs: number;
}

/**
 * Pure due decision.  A leftover mid-universe cursor always resumes.  lastComplete
 * is the 6h quiet period after a full walk.  lastAttempt only covers the in-flight
 * window so a crash before the first cursor write retries after runStaleMs instead
 * of stacking a new walk on every 60s scheduler tick (that pile-up crashed prod
 * every ~22 minutes on 2026-08-16).
 */
export function roicRefreshDueFromState(state: RoicRefreshDueState): boolean {
  if (!state.enabled) return false;
  if (state.cursorQueueLength > 0) return true;
  const completeTs = parseStamp(state.lastCompleteAt);
  if (completeTs !== undefined && state.now - completeTs < state.completeTtlMs) return false;
  const attemptTs = parseStamp(state.lastAttemptAt);
  if (attemptTs !== undefined && state.now - attemptTs < state.runStaleMs) return false;
  return true;
}

function parseStamp(value: unknown): number | undefined {
  if (typeof value !== "string" || !value) return undefined;
  const ts = Date.parse(value);
  return Number.isFinite(ts) ? ts : undefined;
}

export function isRoicTranscriptRefreshDue(now: number = Date.now()): boolean {
  if (!roicTranscriptsEnabled()) return false;
  const cursor = readRoicCursor();
  return roicRefreshDueFromState({
    enabled: true,
    cursorQueueLength: cursor?.queue.length ?? 0,
    lastCompleteAt: getInternalSetting<string>(LAST_COMPLETE_KEY),
    lastAttemptAt: getInternalSetting<string>(LAST_ATTEMPT_KEY),
    now,
    completeTtlMs: completeTtlMs(),
    runStaleMs: ROIC_REFRESH_RUN_STALE_MS
  });
}

export interface RoicTranscriptRefreshResult {
  attempted: number;
  ingested: number;
  cachedLocally: number;
  skippedNoContent: number;
  skippedAlreadyStored: number;
  symbolsConsidered: number;
  due: boolean;
  enabled: boolean;
  remaining: number;
  phase: RoicIngestPhase;
  /** Walk paused so a Manual Run once / strategy run can reach Green. */
  pausedForStrategyRun?: boolean;
}

const roicRefreshHost = globalThis as unknown as {
  __roicTranscriptRefreshInFlight?: Promise<RoicTranscriptRefreshResult>;
};

export interface RoicTranscriptTurn {
  speaker: string;
  text: string;
}

export interface RoicTranscriptItem {
  symbol: string;
  year: number;
  quarter: number;
  date?: string;
  content: string;
  turns: RoicTranscriptTurn[];
}

export interface RoicCallIndexRow {
  id?: string;
  symbol: string;
  year: number;
  quarter: number;
  date?: string;
}

/** Join speaker turns or take a plain string body; reject short / empty. */
export function transcriptTextFromRoicPayload(raw: unknown): string | null {
  if (typeof raw === "string") {
    const t = raw.trim();
    return t.length >= 200 ? t : null;
  }
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const parts: string[] = [];
  for (const turn of raw) {
    if (!turn || typeof turn !== "object") continue;
    const row = turn as Record<string, unknown>;
    const speaker = typeof row.speaker === "string" ? row.speaker.trim() : "";
    const text = typeof row.text === "string" ? row.text.trim() : typeof row.content === "string" ? row.content.trim() : "";
    if (!text) continue;
    parts.push(speaker ? `${speaker}: ${text}` : text);
  }
  const joined = parts.join("\n\n").trim();
  return joined.length >= 200 ? joined : null;
}

export function speakerTurnsFromRoicPayload(raw: unknown): RoicTranscriptTurn[] {
  if (!Array.isArray(raw)) return [];
  const turns: RoicTranscriptTurn[] = [];
  for (const turn of raw) {
    if (!turn || typeof turn !== "object") continue;
    const row = turn as Record<string, unknown>;
    const speaker = typeof row.speaker === "string" ? row.speaker.trim() : "";
    const text = typeof row.text === "string" ? row.text.trim() : typeof row.content === "string" ? row.content.trim() : "";
    if (!text) continue;
    turns.push({ speaker, text });
  }
  return turns;
}

/** Map a speaker label to a stable section role for RAG filters. */
export function roleOfSpeaker(speaker: string): string {
  const s = speaker.toLowerCase();
  if (!s) return "qa";
  if (/\boperator\b/.test(s)) return "operator";
  if (/\banalyst\b/.test(s) && !/\b(ceo|cfo|coo|officer|president)\b/.test(s)) return "analyst";
  if (/\b(ceo|cfo|coo|cto|chief|officer|president|director|management)\b/.test(s)) return "management";
  return "qa";
}

export function parseRoicTranscriptResponse(
  json: unknown,
  symbol: string,
  year: number,
  quarter: number
): RoicTranscriptItem | null {
  if (!json || typeof json !== "object") return null;
  const obj = json as Record<string, unknown>;
  const payload = obj.transcript ?? obj.content ?? obj.text ?? obj.body;
  const content = transcriptTextFromRoicPayload(payload);
  if (!content) return null;
  const date = typeof obj.date === "string" ? obj.date : undefined;
  const fy =
    typeof obj.fiscal_year === "number"
      ? obj.fiscal_year
      : typeof obj.year === "number"
        ? obj.year
        : year;
  const fq =
    typeof obj.fiscal_quarter === "number"
      ? obj.fiscal_quarter
      : typeof obj.quarter === "number"
        ? obj.quarter
        : quarter;
  return {
    symbol: normalizeSymbol(symbol),
    year: fy,
    quarter: fq,
    date,
    content,
    turns: speakerTurnsFromRoicPayload(payload)
  };
}

export function parseRoicEarningsCallList(json: unknown, fallbackSymbol: string): RoicCallIndexRow[] {
  if (!json || typeof json !== "object") return [];
  const obj = json as Record<string, unknown>;
  const rows = Array.isArray(obj.data) ? obj.data : Array.isArray(obj) ? obj : [];
  const out: RoicCallIndexRow[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const rec = row as Record<string, unknown>;
    const year = typeof rec.fiscal_year === "number" ? rec.fiscal_year : typeof rec.year === "number" ? rec.year : NaN;
    const quarter = typeof rec.fiscal_quarter === "number" ? rec.fiscal_quarter : typeof rec.quarter === "number" ? rec.quarter : NaN;
    if (!Number.isFinite(year) || !Number.isFinite(quarter) || quarter < 1 || quarter > 4) continue;
    const rawSym = typeof rec.symbol === "string" ? rec.symbol : fallbackSymbol;
    const symbol = normalizeSymbol(rawSym.includes(":") ? rawSym.slice(rawSym.indexOf(":") + 1) : rawSym);
    if (!symbol) continue;
    const date = typeof rec.date === "string" ? rec.date : undefined;
    const id = typeof rec.id === "string" ? rec.id : undefined;
    out.push({ id, symbol, year, quarter, date });
  }
  return out;
}

/**
 * Prefer exchange:ticker for v3 when we only have a bare symbol. US large-caps
 * commonly resolve as NASDAQ: or NYSE: — try NASDAQ first then bare path fails with 400.
 */
export function roicV3Identifiers(symbol: string): string[] {
  const s = normalizeSymbol(symbol);
  if (!s) return [];
  if (s.includes(":")) return [s];
  return [`NASDAQ:${s}`, `NYSE:${s}`, s];
}

export function publishedAtIso(date: string | undefined, year: number, quarter: number): string {
  if (date) {
    const ts = Date.parse(date);
    if (Number.isFinite(ts)) return new Date(ts).toISOString();
  }
  const month = Math.min(12, Math.max(1, quarter * 3));
  return new Date(Date.UTC(year, month - 1, 28, 16, 0, 0)).toISOString();
}

async function roicGetJson(
  url: string,
  fetchOpts: { service: "roic"; keySource: "env" | "user" | "none"; userId?: string; suppressHealthStatuses: number[] }
): Promise<unknown | null> {
  const credKey = `${fetchOpts.keySource}:${fetchOpts.userId ?? ""}`;
  const allowed = admitProviderRequests("roic", credKey, 1);
  if (!allowed) return null;
  return withProviderLimit("roic", async () => {
    const res = await fetchWithRetry(url, {}, fetchOpts);
    if (!res || !res.ok) return null;
    return await res.json();
  });
}

export async function fetchRoicCallIndex(
  symbol: string,
  userId?: string,
  preferredIdentifier?: string
): Promise<{ rows: RoicCallIndexRow[]; identifier?: string }> {
  const normalized = normalizeSymbol(symbol);
  if (!normalized) return { rows: [] };
  const keyInfo = resolveApiKeyWithSource("roic", userId);
  if (!keyInfo.key) return { rows: [] };
  const fetchOpts = {
    service: "roic" as const,
    keySource: keyInfo.source,
    userId,
    suppressHealthStatuses: [400, 404, 429] as number[]
  };
  for (const identifier of identifiersForRoicFetch(normalized, preferredIdentifier)) {
    const url =
      `${ROIC_V3_BASE}/earnings-calls` +
      `?identifier=${encodeURIComponent(identifier)}` +
      `&limit=100&order=desc&apikey=${encodeURIComponent(keyInfo.key)}`;
    try {
      const json = await roicGetJson(url, fetchOpts);
      const rows = parseRoicEarningsCallList(json, normalized);
      if (rows.length > 0) return { rows, identifier };
    } catch (err) {
      console.warn(
        `[roic-transcripts] v3 list failed for ${identifier}:`,
        err instanceof Error ? err.message : err
      );
    }
  }
  return { rows: [] };
}

export async function fetchRoicTranscript(
  symbol: string,
  year: number,
  quarter: number,
  userId?: string
): Promise<RoicTranscriptItem | null> {
  const normalized = normalizeSymbol(symbol);
  if (!normalized) return null;

  const keyInfo = resolveApiKeyWithSource("roic", userId);
  if (!keyInfo.key) return null;

  const fetchOpts = {
    service: "roic" as const,
    keySource: keyInfo.source,
    userId,
    suppressHealthStatuses: [400, 404, 429] as number[]
  };

  const preferred = readRoicCallIndexArtifact(normalized)?.identifier;
  for (const identifier of identifiersForRoicFetch(normalized, preferred)) {
    const url =
      `${ROIC_V3_BASE}/earnings-calls/${encodeURIComponent(identifier)}` +
      `?fiscal_year=${year}&fiscal_quarter=${quarter}&format=json&apikey=${encodeURIComponent(keyInfo.key)}`;
    try {
      const json = await roicGetJson(url, fetchOpts);
      const parsed = parseRoicTranscriptResponse(json, normalized, year, quarter);
      if (parsed) return parsed;
    } catch (err) {
      console.warn(
        `[roic-transcripts] v3 fetch failed for ${identifier} Q${quarter} ${year}:`,
        err instanceof Error ? err.message : err
      );
    }
  }

  try {
    const latestUrl =
      `${ROIC_V2_BASE}/company/earnings-calls/latest/${encodeURIComponent(normalized)}` +
      `?apikey=${encodeURIComponent(keyInfo.key)}`;
    const json = await roicGetJson(latestUrl, fetchOpts);
    const parsed = parseRoicTranscriptResponse(json, normalized, year, quarter);
    if (parsed) {
      const matchesPeriod =
        (parsed.year === year && parsed.quarter === quarter) ||
        (typeof (json as { year?: unknown } | null)?.year !== "number" &&
          typeof (json as { quarter?: unknown } | null)?.quarter !== "number");
      if (matchesPeriod) return parsed;
    }
  } catch (err) {
    console.warn(
      `[roic-transcripts] v2 latest failed for ${normalized}:`,
      err instanceof Error ? err.message : err
    );
  }

  return null;
}

function speakerSections(item: RoicTranscriptItem): Array<{ itemCode: string; itemTitle: string; text: string }> {
  if (item.turns.length === 0) {
    return [{ itemCode: "transcript", itemTitle: "Full call", text: item.content }];
  }
  return item.turns.map((turn) => ({
    itemCode: roleOfSpeaker(turn.speaker),
    itemTitle: turn.speaker || "Speaker",
    text: turn.text
  }));
}

export function persistRoicTranscriptLocally(transcript: RoicTranscriptItem): boolean {
  if (!transcript.content || transcript.content.length < 200) return false;
  const accession = roicTranscriptAccession(transcript.symbol, transcript.year, transcript.quarter);
  const fetchedAt = new Date().toISOString();
  const identifier = readRoicCallIndexArtifact(transcript.symbol)?.identifier;
  upsertEarningsCallsTranscript({
    symbol: transcript.symbol,
    fiscalYear: transcript.year,
    fiscalQuarter: transcript.quarter,
    eventDate: transcript.date,
    content: transcript.content,
    fetchedAt,
    sourceMeta: JSON.stringify({ provider: "roic", accession, identifier })
  });
  writeRoicTranscriptArtifact({
    symbol: transcript.symbol,
    year: transcript.year,
    quarter: transcript.quarter,
    date: transcript.date,
    content: transcript.content,
    fetchedAt,
    accession,
    identifier,
    provider: "roic"
  });
  return true;
}

export function roicItemFromLocalCache(
  symbol: string,
  year: number,
  quarter: number
): RoicTranscriptItem | null {
  const row = getEarningsCallsTranscript(symbol, year, quarter);
  if (row?.content && row.content.length >= 200) {
    return {
      symbol: normalizeSymbol(symbol),
      year,
      quarter,
      date: row.eventDate,
      content: row.content,
      turns: []
    };
  }
  const artifact = readRoicTranscriptArtifact(symbol, year, quarter);
  if (!artifact) return null;
  const item: RoicTranscriptItem = {
    symbol: artifact.symbol,
    year: artifact.year,
    quarter: artifact.quarter,
    date: artifact.date,
    content: artifact.content,
    turns: []
  };
  persistRoicTranscriptLocally(item);
  return item;
}

export function listLocalRoicCoverage(symbol: string): RoicPeriodRef[] {
  const map = new Map<string, RoicPeriodRef>();
  for (const row of listEarningsCallsTranscriptsForSymbol(symbol)) {
    if (!row.content || row.content.length < 200) continue;
    map.set(periodKey({ year: row.fiscalYear, quarter: row.fiscalQuarter }), {
      year: row.fiscalYear,
      quarter: row.fiscalQuarter,
      date: row.eventDate
    });
  }
  for (const period of listRoicTranscriptArtifacts(symbol)) {
    const key = periodKey(period);
    if (map.has(key)) continue;
    const item = roicItemFromLocalCache(symbol, period.year, period.quarter);
    if (!item) continue;
    map.set(key, { year: item.year, quarter: item.quarter, date: item.date });
  }
  return [...map.values()];
}

function hasLocalTranscriptContent(symbol: string, year: number, quarter: number): boolean {
  return roicItemFromLocalCache(symbol, year, quarter) !== null;
}

function isRoicRagIngested(symbol: string, year: number, quarter: number, accession: string): boolean {
  if (hasIngestedAccession(accession, ROIC_TRANSCRIPT_DOC_TYPE)) return true;
  return Boolean(getEarningsCallsTranscript(symbol, year, quarter)?.ingestedAt);
}

async function storeRoicEarningsSummary(
  transcript: RoicTranscriptItem,
  accession: string,
  published: string,
  observed: string
): Promise<boolean> {
  try {
    const { generateAndStoreDocumentAbstract, tradeHighlightChunksFromText } = await import(
      "../rag/document-summarizer"
    );
    const result = await generateAndStoreDocumentAbstract({
      ticker: transcript.symbol,
      accessionOrEventId: accession,
      sourceType: "earnings-summary",
      headline: `${transcript.symbol} earnings call highlights ${transcript.year} Q${transcript.quarter}`,
      chunks: tradeHighlightChunksFromText(transcript.content, {
        maxChunks: 8,
        formHint: "earnings",
        sections: speakerSections(transcript)
      }),
      publishedAt: published,
      acceptanceDatetime: observed
    });
    return !result.error;
  } catch (err) {
    console.warn(
      `[roic-transcripts] abstract failed for ${accession}:`,
      err instanceof Error ? err.message : String(err)
    );
    return false;
  }
}

export async function ingestRoicTranscriptToRag(
  transcript: RoicTranscriptItem,
  userId?: string,
  writeClass: RoicPineconeWriteClass = "full-body"
): Promise<"ingested" | "cached" | "failed"> {
  if (!persistRoicTranscriptLocally(transcript)) return "failed";

  const doc_id = `roic-transcript-${transcript.symbol.toLowerCase()}-${transcript.year}-q${transcript.quarter}`;
  const accession = roicTranscriptAccession(transcript.symbol, transcript.year, transcript.quarter);
  const title = `${transcript.symbol} Q${transcript.quarter} ${transcript.year} Earnings Call Transcript`;
  const published = publishedAtIso(transcript.date, transcript.year, transcript.quarter);
  const observed = new Date().toISOString();

  if (writeClass === "local-only") return "cached";
  if (!hasVectorIngestWriteBudget(userId ?? "local")) return "cached";

  let fullBodyOk = writeClass !== "full-body";
  if (writeClass === "full-body") {
    try {
      const result = await storeDocument(
        {
          doc_id,
          title,
          doc_type: ROIC_TRANSCRIPT_DOC_TYPE,
          source: ROIC_TRANSCRIPT_SOURCE,
          text: transcript.content,
          ticker: transcript.symbol,
          published_at: published,
          acceptance_datetime: observed,
          sections: speakerSections(transcript)
        },
        userId ?? "local",
        { parserRevision: "roic-transcript-speakers-v1", documentKey: accession }
      );
      fullBodyOk = Boolean(
        result && !result.error && !result.wuExhausted && !result.unconfigured && result.documentComplete
      );
      if (fullBodyOk) {
        insertIngestedAccession(accession, ROIC_TRANSCRIPT_DOC_TYPE, transcript.symbol, result!.indexed);
      }
    } catch (err) {
      console.error(`[roic-transcripts] failed to store RAG document for ${doc_id}:`, err);
      fullBodyOk = false;
    }
  }

  const summaryOk = await storeRoicEarningsSummary(transcript, accession, published, observed);
  const signalChunks = chunkDocument(
    {
      doc_id: `${doc_id}:signal`,
      title,
      doc_type: ROIC_TRANSCRIPT_DOC_TYPE,
      source: ROIC_TRANSCRIPT_SOURCE,
      text: transcript.content,
      ticker: transcript.symbol,
      published_at: published,
      acceptance_datetime: observed,
      sections: speakerSections(transcript)
    },
    {}
  );
  const signal = await storeSignalSectionDocuments(
    {
      ticker: transcript.symbol,
      accession,
      form: "earnings-transcript",
      title,
      publishedAt: published,
      acceptanceDatetime: observed,
      source: ROIC_TRANSCRIPT_SOURCE,
      chunks: signalChunks,
      userId: userId ?? "local"
    },
    storeDocument
  );
  if (writeClass === "highlight-only" && summaryOk) {
    insertIngestedAccession(accession, ROIC_TRANSCRIPT_DOC_TYPE, transcript.symbol, 8 + signal.indexed, {
      pineconeWriteClass: "highlight-only",
      pineconeVectorCount: 8 + signal.indexed
    });
  }

  const ragOk = writeClass === "full-body" ? fullBodyOk : summaryOk;
  if (ragOk) {
    markEarningsCallsTranscriptIngested(transcript.symbol, transcript.year, transcript.quarter, observed);
    audit("roic_transcript_ingested", {
      symbol: transcript.symbol,
      year: transcript.year,
      quarter: transcript.quarter,
      doc_id,
      accession,
      writeClass,
      userId
    });
    logApiHealth({
      service: "roic",
      ok: true,
      errorText: `Ingested ${transcript.symbol} Q${transcript.quarter} ${transcript.year} transcript (${writeClass})`,
      userId
    });
    return "ingested";
  }
  return "cached";
}

export { rankDemandFirstSymbols as rankRoicUniverseSymbols } from "../rag/demand-first-symbols";

/**
 * Three-pass ingest (approved proposer-corpus rev 3):
 *   latest  — one newest call for the demand-first universe
 *   deepen  — Individual quarter cap for held/watchlist/technical
 *   archive — same cap for the rest of the universe, local cache only
 * Fetch from ROIC even when the Pinecone write fuse is spent so the Individual
 * window still fills `earningscalls_transcripts`.  Cursor continues mid-universe.
 */
export async function refreshRoicTranscriptsIfDue(options?: {
  force?: boolean;
  now?: number;
  symbols?: string[];
  userId?: string;
  phase?: RoicIngestPhase;
}): Promise<RoicTranscriptRefreshResult> {
  const now = options?.now ?? Date.now();
  const enabled = roicTranscriptsEnabled(options?.userId);
  const base: RoicTranscriptRefreshResult = {
    attempted: 0,
    ingested: 0,
    cachedLocally: 0,
    skippedNoContent: 0,
    skippedAlreadyStored: 0,
    symbolsConsidered: 0,
    due: enabled && isRoicTranscriptRefreshDue(now),
    enabled,
    remaining: 0,
    phase: "latest"
  };
  if (!enabled) return base;
  if (!options?.force && !isRoicTranscriptRefreshDue(now)) return base;
  if (
    shouldDeferBackgroundRagForStrategy({
      strategyWorkInFlight: hasInFlightStrategyWork(),
      force: options?.force
    })
  ) {
    return {
      ...base,
      due: true,
      remaining: readRoicCursor()?.queue.length ?? 0,
      pausedForStrategyRun: true
    };
  }
  if (!options?.force && roicRefreshHost.__roicTranscriptRefreshInFlight) {
    return {
      ...base,
      due: true,
      remaining: readRoicCursor()?.queue.length ?? 0
    };
  }

  const run = runRoicTranscriptRefresh(base, now, options);
  roicRefreshHost.__roicTranscriptRefreshInFlight = run;
  try {
    return await run;
  } finally {
    if (roicRefreshHost.__roicTranscriptRefreshInFlight === run) {
      roicRefreshHost.__roicTranscriptRefreshInFlight = undefined;
    }
  }
}

async function runRoicTranscriptRefresh(
  base: RoicTranscriptRefreshResult,
  now: number,
  options?: {
    force?: boolean;
    symbols?: string[];
    userId?: string;
    phase?: RoicIngestPhase;
  }
): Promise<RoicTranscriptRefreshResult> {
  const nowIso = new Date(now).toISOString();
  // Stamp start immediately so the next 60s tick is not due while this walk runs.
  setInternalSetting(LAST_ATTEMPT_KEY, nowIso);

  const existing = options?.force || options?.symbols?.length ? null : readRoicCursor();
  let phase: RoicIngestPhase = options?.phase ?? existing?.phase ?? "latest";
  let queue: string[] = existing && existing.queue.length > 0
    ? existing.queue
    : rankDemandFirstSymbols({ symbols: options?.symbols, now });
  if (!options?.phase && (!existing || existing.queue.length === 0)) phase = "latest";

  const highInterest = new Set(rankHighInterestSymbols({ now }));
  const deepenQueue = (): string[] => {
    if (options?.symbols?.length) {
      return rankDemandFirstSymbols({ symbols: options.symbols, now });
    }
    return rankHighInterestSymbols({ now });
  };
  const nextArchiveQueue = (): string[] => {
    if (options?.symbols?.length) {
      return phase === "archive" || options.phase === "archive"
        ? rankDemandFirstSymbols({ symbols: options.symbols, now })
        : [];
    }
    return archiveRoicQueue(now);
  };

  const advanceEmptyPhase = (): boolean => {
    if (queue.length > 0) return false;
    if (phase === "latest") {
      phase = "deepen";
      queue = deepenQueue();
      return true;
    }
    if (phase === "deepen") {
      phase = "archive";
      queue = nextArchiveQueue();
      return true;
    }
    return false;
  };

  base.symbolsConsidered = queue.length;
  const budget = maxTranscriptsPerRun(options?.userId);
  let remainingBudget = budget;

  const recordIngest = (status: "ingested" | "cached" | "failed"): void => {
    if (status === "ingested") base.ingested += 1;
    else if (status === "cached") base.cachedLocally += 1;
    else base.skippedNoContent += 1;
  };

  const ingestCachedPeriod = async (
    symbol: string,
    period: RoicPeriodRef,
    writeClass: RoicPineconeWriteClass
  ): Promise<void> => {
    const accession = roicTranscriptAccession(symbol, period.year, period.quarter);
    const cachedForArtifact = roicItemFromLocalCache(symbol, period.year, period.quarter);
    if (cachedForArtifact && !readRoicTranscriptArtifact(symbol, period.year, period.quarter)) {
      persistRoicTranscriptLocally(cachedForArtifact);
    }
    if (writeClass === "local-only" || isRoicRagIngested(symbol, period.year, period.quarter, accession)) {
      base.skippedAlreadyStored += 1;
      return;
    }
    const cached = roicItemFromLocalCache(symbol, period.year, period.quarter);
    if (!cached) {
      base.skippedAlreadyStored += 1;
      return;
    }
    try {
      recordIngest(await ingestRoicTranscriptToRag(cached, options?.userId, writeClass));
    } catch {
      base.cachedLocally += 1;
    }
  };

  const walkQueue = async (): Promise<void> => {
    const depth = roicDepthForPhase(phase, options?.userId);
    while (queue.length > 0) {
      await yieldEventLoop();
      if (
        shouldDeferBackgroundRagForStrategy({
          strategyWorkInFlight: hasInFlightStrategyWork(),
          force: options?.force
        })
      ) {
        writeRoicCursor(queue, nowIso, phase);
        base.pausedForStrategyRun = true;
        return;
      }
      const symbol = queue[0]!;
      const localPeriods = listLocalRoicCoverage(symbol);
      const cachedIndex = readRoicCallIndexArtifact(symbol);
      const plan = planRoicSymbolWork({
        phase,
        depth,
        localPeriods,
        cachedIndex: cachedIndex?.calls ?? null
      });

      if (plan.action === "skip-covered") {
        const covered = selectRoicPeriodsForPhase(
          cachedIndex?.calls?.length ? cachedIndex.calls : localPeriods,
          phase,
          depth
        );
        for (let periodIndex = 0; periodIndex < covered.length; periodIndex++) {
          const period = covered[periodIndex]!;
          const writeClass = roicPineconeWriteClass({
            phase,
            symbol,
            newestPeriod: periodIndex === 0,
            highInterest
          });
          await ingestCachedPeriod(symbol, period, writeClass);
        }
        queue.shift();
        writeRoicCursor(queue, nowIso, phase);
        continue;
      }

      if (remainingBudget <= 0) break;

      let indexRows: RoicCallIndexRow[] = cachedIndex?.calls?.map((row) => ({
        id: row.id,
        symbol,
        year: row.year,
        quarter: row.quarter,
        date: row.date
      })) ?? [];

      if (plan.needsList) {
        try {
          remainingBudget -= 1;
          base.attempted += 1;
          const listed = await fetchRoicCallIndex(symbol, options?.userId, cachedIndex?.identifier);
          if (listed.rows.length > 0) {
            indexRows = listed.rows;
            writeRoicCallIndexArtifact({
              symbol,
              identifier: listed.identifier,
              fetchedAt: nowIso,
              calls: listed.rows.map((row) => ({
                year: row.year,
                quarter: row.quarter,
                date: row.date,
                id: row.id
              }))
            });
          }
        } catch {
          queue.shift();
          writeRoicCursor(queue, nowIso, phase);
          continue;
        }
      }

      const rawPeriods = indexRows.length > 0
        ? indexRows.map((row) => ({ year: row.year, quarter: row.quarter, date: row.date }))
        : plan.periods.length > 0
          ? plan.periods
          : recentFiscalPeriods(new Date(now), depth).map((p) => ({ ...p, date: undefined as string | undefined }));
      const periods = plan.needsList || plan.periods.length === 0
        ? selectRoicPeriodsForPhase(rawPeriods, phase, depth)
        : plan.periods;

      let symbolDone = true;
      for (let periodIndex = 0; periodIndex < periods.length; periodIndex++) {
        await yieldEventLoop();
        if (
          shouldDeferBackgroundRagForStrategy({
            strategyWorkInFlight: hasInFlightStrategyWork(),
            force: options?.force
          })
        ) {
          writeRoicCursor(queue, nowIso, phase);
          base.pausedForStrategyRun = true;
          return;
        }
        const period = periods[periodIndex]!;
        const writeClass = roicPineconeWriteClass({
          phase,
          symbol,
          newestPeriod: periodIndex === 0,
          highInterest
        });
        if (hasLocalTranscriptContent(symbol, period.year, period.quarter)) {
          await ingestCachedPeriod(symbol, period, writeClass);
          continue;
        }
        if (remainingBudget <= 0) {
          symbolDone = false;
          break;
        }
        remainingBudget -= 1;
        base.attempted += 1;
        try {
          const item = await fetchRoicTranscript(symbol, period.year, period.quarter, options?.userId);
          if (!item) {
            base.skippedNoContent += 1;
            continue;
          }
          if (!item.date && period.date) item.date = period.date;
          recordIngest(await ingestRoicTranscriptToRag(item, options?.userId, writeClass));
        } catch {
          base.skippedNoContent += 1;
        }
      }

      if (symbolDone) {
        queue.shift();
        writeRoicCursor(queue, nowIso, phase);
      } else {
        writeRoicCursor(queue, nowIso, phase);
        break;
      }
    }
  };

  await walkQueue();
  while (remainingBudget > 0 && queue.length === 0 && advanceEmptyPhase()) {
    base.symbolsConsidered += queue.length;
    if (queue.length === 0) continue;
    await walkQueue();
  }
  if (queue.length === 0) advanceEmptyPhase();

  writeRoicCursor(queue, nowIso, phase);
  if (queue.length === 0) {
    setInternalSetting(LAST_COMPLETE_KEY, nowIso);
  }
  base.remaining = queue.length;
  base.phase = phase;
  audit("roic_transcript_refresh", {
    attempted: base.attempted,
    ingested: base.ingested,
    cachedLocally: base.cachedLocally,
    skippedNoContent: base.skippedNoContent,
    skippedAlreadyStored: base.skippedAlreadyStored,
    symbolsConsidered: base.symbolsConsidered,
    remaining: base.remaining,
    phase
  });
  return { ...base, due: true };
}

export interface RoicArchiveCoverage {
  transcriptsWithContent: number;
  symbolsWithContent: number;
  symbolsAtDepth: number;
  symbolsPartial: number;
  artifactFiles: number;
  archiveDepth: number;
  cursorPhase: RoicIngestPhase | null;
  cursorRemaining: number;
  lastCompleteAt: string | null;
  lastAttemptAt: string | null;
  universeSize: number;
  universeUncovered: number;
  thinSymbols: Array<{ symbol: string; count: number }>;
}

/** Local archive inventory for ops / remaining-gap lists.  No ROIC HTTP. */
export function summarizeRoicArchiveCoverage(options?: {
  now?: number;
  universe?: string[];
  depth?: number;
}): RoicArchiveCoverage {
  const depth = options?.depth ?? quartersPerSymbol();
  const table = summarizeEarningsCallsTranscriptCoverage(depth);
  let universe: string[] = options?.universe ?? [];
  if (universe.length === 0) {
    try {
      universe = rankDemandFirstSymbols({ now: options?.now });
    } catch {
      universe = [];
    }
  }
  const covered = new Set(table.perSymbol.map((row) => row.symbol));
  const universeUncovered = universe.filter((symbol) => !covered.has(normalizeSymbol(symbol))).length;
  const cursor = readRoicCursor();
  return {
    transcriptsWithContent: table.transcriptsWithContent,
    symbolsWithContent: table.symbolsWithContent,
    symbolsAtDepth: table.symbolsAtDepth,
    symbolsPartial: table.symbolsPartial,
    artifactFiles: countRoicTranscriptArtifactFiles(),
    archiveDepth: depth,
    cursorPhase: cursor?.phase ?? null,
    cursorRemaining: cursor?.queue.length ?? 0,
    lastCompleteAt: getInternalSetting<string>(LAST_COMPLETE_KEY) ?? null,
    lastAttemptAt: getInternalSetting<string>(LAST_ATTEMPT_KEY) ?? null,
    universeSize: universe.length,
    universeUncovered,
    thinSymbols: table.perSymbol.filter((row) => row.count < depth).slice(0, 24)
  };
}
