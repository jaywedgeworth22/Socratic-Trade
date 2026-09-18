// SEC EDGAR full-filing body ingestion (10-K / 10-Q) → storeDocument → ingested_accessions de-dup.
//
// This is the "analytical body" layer that complements the existing 8-K "catalyst flag" layer
// (sec8k.ts). The 8-K path writes 6-line summaries; this path chunks and embeds the full risk
// sections, MD&A, and financial notes for RAG-grounded reasoning.
//
// KEY DESIGN DECISIONS (owner-resolved 2026-06-21; gate made provider-aware 2026-07-19):
//  • Incremental ingest only: 1 filing per scheduler tick on free tier (Voyage, unpaid key).
//  • Recency window: latest 10-K + latest 10-Q for the universe; extra 10-Qs/Ks
//    only for held/watchlist/technical names (rankHighInterestSymbols).
//  • De-dup: ingested_accessions (accession + doc_type) is the sole gate — never re-embed.
//  • All corpus writes use userId='local' (cleanMetadata → scope:'shared', app-funded).
//  • CIK map: ticker→CIK via sec8k.ts loadTickerCikMap (dual-class safe). Unknown CIK skips ingest.
//  • Gate: paid-tier cap applies whenever the active embedding provider is openrouter/siliconflow
//    (their rate limits are per-request, not the Voyage free-tier trickle this gate was written
//    for) OR the legacy VECTOR_EMBED_BATCH_DELAY_MS ≤ 5000 signal is set for a paid Voyage key.
//    Free-tier Voyage keeps the existing 8-K-summary path UNCHANGED and skips body ingest.
//  • Errors: surface via returned error field and audit log — never swallowed silently.

import {
  audit,
  getInternalSetting,
  hasIngestedAccession,
  insertIngestedAccession,
  runWithActiveVectorCommitProof,
  setInternalSetting,
  getDb,
  insertSecFiling
} from "../db";
import {
  assertOperationLeaseOwnership,
  OPERATION_LEASE_GROUPS,
  runWithOperationLease,
  throwIfOperationLeaseCancelled,
  type OperationLeaseAware,
  type OperationLeaseClaim
} from "../operation-lease";
import { politeFetchText, runRateLimited, secUserAgent, sleep } from "./http";
import { activeEmbeddingProvider } from "../vector-db";
import { resolveSourceNumber } from "../source-settings";
import { rankHighInterestSymbols } from "../rag/demand-first-symbols";
import { chunkDocument } from "../rag/chunk";
import { persistLocalComplete } from "../rag/persist-local-complete";
import { mirrorFtsChunksBounded } from "../rag/mirror-fts-bounded";
import {
  parseItemCodeFromSection,
  pineconeWriteClass,
  writesFullBodyToPinecone
} from "../rag/pinecone-write-class";
import { storeSignalSectionDocuments } from "../rag/processed-corpus-write";
import { loadTickerCikMap } from "./sec8k";
import { parseFilingHtml } from "./sec-parser";
import { buildSecDocument } from "../rag/sec-document";
import { normalizeSymbol } from "../money";
import { timeSync, yieldEventLoop } from "../slow-sync-guard";
import {
  readFirstExisting,
  secArtifactReadPaths,
  secArtifactWritePath,
  writeCorpusFile
} from "../rag/corpus-layout";

export function getLocalArtifactPath(cik: string, accession: string, sequence: number, documentName: string): string {
  return secArtifactWritePath(cik, accession, sequence, documentName);
}

export async function readLocalArtifact(cik: string, accession: string, sequence: number, documentName: string): Promise<string | null> {
  const candidates = secArtifactReadPaths(cik, accession, sequence, documentName);
  try {
    return await readFirstExisting(candidates);
  } catch (err) {
    console.warn(`[sec-filings] readLocalArtifact failed for ${candidates[0]}:`, err);
    return null;
  }
}

export async function writeLocalArtifact(cik: string, accession: string, sequence: number, documentName: string, content: string): Promise<void> {
  const filePath = secArtifactWritePath(cik, accession, sequence, documentName);
  try {
    await writeCorpusFile(filePath, content);
  } catch (err) {
    console.warn(`[sec-filings] writeLocalArtifact failed for ${filePath}:`, err);
  }
}

/** Ticker → 10-digit CIK.  Returns null when unknown — never the sentinel 0000000000. */
export async function getCikForTicker(ticker: string): Promise<string | null> {
  try {
    const cikMap = await loadTickerCikMap(Date.now());
    const raw = cikMap[normalizeSymbol(ticker)];
    if (typeof raw === "string" && /^\d+$/.test(raw) && Number(raw) > 0) {
      return raw.padStart(10, "0");
    }
  } catch (err) {
    console.warn(`[sec-filings] getCikForTicker failed for ${ticker}:`, err);
  }
  return null;
}

const SEC_BASE = "https://www.sec.gov";
const EDGAR_DATA_BASE = "https://data.sec.gov";

// Cadence stamp for the last filing-ingest attempt (one global lastAttempt key).
// Default 24h: paid OpenRouter/bge-m3 can drain the backlog daily. The old 168h weekly pin
// was a Voyage-free-tier artifact. An Infisical value of 87600 is an emergency pause, not
// a product default — do not copy it forward.
const DEFAULT_FILING_INGEST_TTL_HOURS = 24;
function filingIngestTtlMs(): number {
  const hours = resolveSourceNumber("SEC_FILING_INGEST_TTL_HOURS");
  return (Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_FILING_INGEST_TTL_HOURS) * 60 * 60_000;
}
const ATTEMPT_KEY = "webSource:sec10k:lastAttempt";

function isValidPersistedTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value));
}

// Polite delay between per-CIK submissions-JSON fetches (300 ms per EDGAR fair-use guidance).
const CIK_POLITE_DELAY_MS = 300;

// Threshold above which we treat VECTOR_EMBED_BATCH_DELAY_MS as free-tier (unpaid Voyage).
// Default is 21_000 ms; operators with a paid key set this to 0 (or very low).
const PAID_KEY_THRESHOLD_MS = 5_000;
// Free tier: 1 filing/run — at 21s per 8-chunk embed batch a single 10-K takes minutes, so a
// bigger cap would stall the scheduler tick for hours. Paid tier: a cap of 1 made the ~2,000
// filing backlog take decades (prod 2026-07-09: two filings ever ingested); 25/run at the paid
// embed pace is minutes of work, and RAG_INGEST_MAX_TEXTS_PER_DAY still bounds daily spend.
const DEFAULT_MAX_FILINGS_PER_RUN = 1;
const DEFAULT_PAID_MAX_FILINGS_PER_RUN = 200;

export interface FilingRef {
  accession: string;   // dashed form: NNNNNNNNNN-YY-NNNNNN
  docType: "10-K" | "10-Q";
  filedAt: string;           // ISO date (YYYY-MM-DD)
  acceptanceDateTime: string; // ISO datetime
  primaryDoc: string;         // filename inside the filing (e.g. "aapl-20231231.htm")
  url: string;                // full EDGAR archive URL to the primary document
}

export interface IngestResult {
  skipped: boolean;
  chunks: number;
  error?: string;
  /** The embed layer has no capacity left (daily text budget exhausted or vector store
   *  unconfigured) — every later filing in this run would meet the same fate, so bulk
   *  loops should stop instead of fetching/chunking documents that cannot embed. */
  budgetExhausted?: boolean;
  /** FTS mirror paused because a strategy run is in flight — accession stays un-ledgered. */
  deferredStrategy?: boolean;
}

export interface RefreshFilingBodiesResult {
  attempted: number;
  ingested: number;
  skipped: number;
  /** Filings within this run's cap left un-attempted because the embed budget ran out
   *  mid-run; they are NOT recorded as ingested and retry at the next tick. */
  deferredForBudget: number;
  errors: string[];
}

type SecFilingLeaseGuard = { assertOwnership: () => void; signal?: AbortSignal };

function assertSecFilingLease(leaseGuard?: SecFilingLeaseGuard): void {
  if (leaseGuard?.signal) throwIfOperationLeaseCancelled(leaseGuard.signal);
  leaseGuard?.assertOwnership();
}

// ── Submission JSON parsing ──────────────────────────────────────────────────

/** Normalise a CIK to a 10-digit zero-padded string (for EDGAR submission URL). */
export function padCik(cik: string | number): string {
  return String(cik).replace(/\D/g, "").padStart(10, "0");
}

/** Normalise accession number: strip dashes → re-add in standard NNNNNNNNNN-YY-NNNNNN form. */
export function normalizeAccession(raw: string): string {
  const stripped = raw.replace(/-/g, "");
  if (stripped.length !== 18) return raw; // pass-through if already unusual
  return `${stripped.slice(0, 10)}-${stripped.slice(10, 12)}-${stripped.slice(12)}`;
}

/** Convert dashed accession to the no-dash form used in EDGAR archive paths. */
export function accessionNoDashes(acc: string): string {
  return acc.replace(/-/g, "");
}

interface SubmissionsRecent {
  accessionNumber?: string[];
  form?: string[];
  filingDate?: string[];
  acceptanceDateTime?: string[];
  primaryDocument?: string[];
}

interface SubmissionsJson {
  cik?: string | number;
  filings?: {
    recent?: SubmissionsRecent;
    // EDGAR's real shard fields are filingFrom/filingTo (verified against live
    // data.sec.gov/submissions/CIK0000320193.json). The earlier filingStart/filingEnd names were
    // invented and always undefined at runtime — the shard sort below threw on the first issuer
    // deep enough to need pagination (2026-08-09 full-universe seed).
    files?: Array<{ name: string; filingCount: number; filingFrom?: string; filingTo?: string }>;
  };
}

/**
 * Per-docType filing limit: either a single number applied uniformly to every requested
 * docType (the original behavior), or a partial map giving each docType its own cap — e.g.
 * `{ "10-K": 1, "10-Q": 4 }` — so callers who need different limits per type (the ingest
 * seeder's "latest 10-K + latest 4 10-Qs" baseline) can discover both in ONE submissions-API
 * call instead of one call per docType against the identical CIK URL.
 */
export type FilingTypeLimits = number | Partial<Record<"10-K" | "10-Q", number>>;

const DEFAULT_FILING_LIMIT_PER_TYPE = 2;

function resolveFilingLimits(
  docTypes: Array<"10-K" | "10-Q">,
  limitPerType: FilingTypeLimits
): Record<string, number> {
  const limits: Record<string, number> = {};
  for (const dt of docTypes) {
    limits[dt] = typeof limitPerType === "number" ? limitPerType : limitPerType[dt] ?? DEFAULT_FILING_LIMIT_PER_TYPE;
  }
  return limits;
}

/** Helper to parse a flat block of filings (recent or a submissions shard). */
function parseFilingBlock(
  recent: SubmissionsRecent | undefined,
  cik: string,
  docTypes: Array<"10-K" | "10-Q">,
  limitsByType: Record<string, number>,
  countPerType: Record<string, number>
): FilingRef[] {
  if (!recent) return [];

  const accessions = recent.accessionNumber ?? [];
  const forms = recent.form ?? [];
  const dates = recent.filingDate ?? [];
  const acceptances = recent.acceptanceDateTime ?? [];
  const primaries = recent.primaryDocument ?? [];

  const out: FilingRef[] = [];
  for (let i = 0; i < accessions.length; i++) {
    const form = forms[i] as "10-K" | "10-Q" | undefined;
    if (!form || !docTypes.includes(form)) continue;
    if ((countPerType[form] ?? 0) >= (limitsByType[form] ?? 0)) continue;

    const acc = normalizeAccession(accessions[i] ?? "");
    if (!acc) continue;

    const filedAt = dates[i] ?? new Date().toISOString().slice(0, 10);
    const acceptanceDateTime = acceptances[i] ?? filedAt;
    const primaryDoc = primaries[i] ?? "";
    const paddedCik = padCik(cik);
    const noSlashAcc = accessionNoDashes(acc);
    const url = primaryDoc
      ? `${SEC_BASE}/Archives/edgar/data/${paddedCik}/${noSlashAcc}/${primaryDoc}`
      : `${SEC_BASE}/cgi-bin/browse-edgar?action=getcompany&CIK=${paddedCik}&type=${form}&dateb=&owner=include&count=40`;

    out.push({ accession: acc, docType: form, filedAt, acceptanceDateTime, primaryDoc, url });
    countPerType[form] = (countPerType[form] ?? 0) + 1;
  }

  return out;
}

/**
 * Parse a EDGAR submissions JSON blob into FilingRef entries, filtering to the requested
 * docTypes and returning at most `limitPerType` per docType (newest-first). `limitPerType`
 * accepts either a single number (applied to every docType) or a per-docType map.
 */
export function parseRecentFilings(
  json: SubmissionsJson,
  cik: string,
  docTypes: Array<"10-K" | "10-Q">,
  limitPerType: FilingTypeLimits
): FilingRef[] {
  const limitsByType = resolveFilingLimits(docTypes, limitPerType);
  const countPerType: Record<string, number> = {};
  for (const dt of docTypes) countPerType[dt] = 0;
  return parseFilingBlock(json?.filings?.recent, cik, docTypes, limitsByType, countPerType);
}

// ── Network helpers ──────────────────────────────────────────────────────────

/**
 * Fetch the SEC EDGAR submissions JSON for a single CIK, including historical shards if needed.
 * Returns undefined (does NOT throw) if the network call fails — let callers decide.
 *
 * `limitPerType` accepts either a single number applied to every requested docType (original
 * behavior, still the default) or a per-docType map, e.g. `{ "10-K": 1, "10-Q": 4 }` — this lets
 * a caller that needs different caps per docType (the ingest seeder's "1 10-K + 4 10-Qs"
 * baseline) discover both docTypes in ONE call against this CIK's submissions URL instead of one
 * call per docType.
 */
export async function fetchRecentFilings(
  cik: string,
  docTypes: Array<"10-K" | "10-Q"> = ["10-K", "10-Q"],
  limitPerType: FilingTypeLimits = DEFAULT_FILING_LIMIT_PER_TYPE
): Promise<FilingRef[]> {
  const limitsByType = resolveFilingLimits(docTypes, limitPerType);
  const padded = padCik(cik);
  const url = `${EDGAR_DATA_BASE}/submissions/CIK${padded}.json`;
  let raw: string;
  try {
    raw = await politeFetchText(url, {
      headers: { "user-agent": secUserAgent(), accept: "application/json" },
      timeoutMs: 15_000
    });
  } catch (err) {
    console.warn(`[sec-filings] failed to fetch submissions for CIK ${padded}:`, err);
    return [];
  }

  const json = JSON.parse(raw) as SubmissionsJson;
  const countPerType: Record<string, number> = {};
  for (const dt of docTypes) countPerType[dt] = 0;

  const out = parseFilingBlock(json?.filings?.recent, cik, docTypes, limitsByType, countPerType);

  // Check if we need more filings and have shards available
  const needsMore = docTypes.some(dt => (countPerType[dt] ?? 0) < (limitsByType[dt] ?? 0));
  const files = json?.filings?.files;
  if (needsMore && Array.isArray(files) && files.length > 0) {
    // Sort shards in reverse chronological order (newest date first)
    const sortedFiles = [...files].sort((a, b) => (b.filingTo ?? "").localeCompare(a.filingTo ?? ""));
    for (const file of sortedFiles) {
      const stillNeeds = docTypes.some(dt => (countPerType[dt] ?? 0) < (limitsByType[dt] ?? 0));
      if (!stillNeeds) break;

      try {
        const shardUrl = `${EDGAR_DATA_BASE}/submissions/${file.name}`;
        const shardRaw = await politeFetchText(shardUrl, {
          headers: { "user-agent": secUserAgent(), accept: "application/json" },
          timeoutMs: 15_000
        });
        const shardJson = JSON.parse(shardRaw) as SubmissionsRecent;
        const shardRefs = parseFilingBlock(shardJson, cik, docTypes, limitsByType, countPerType);
        out.push(...shardRefs);
      } catch (err) {
        console.warn(`[sec-filings] failed to fetch/parse shard ${file.name}:`, err);
      }
    }
  }

  return out;
}

/**
 * Fetch the primary HTM document for a single filing from EDGAR.
 * Uses a raised timeout (30s) because 10-K bodies can be 2–10 MB.
 */
export async function fetchFilingHtml(url: string): Promise<string> {
  return politeFetchText(url, {
    headers: { "user-agent": secUserAgent(), accept: "text/html,application/xhtml+xml" },
    timeoutMs: 30_000
  });
}

export interface FilingDirectoryItem {
  name: string;
  type?: string;
  size?: number;
}

/**
 * Fetch and parse index.json for a specific filing accession to discover all documents/exhibits.
 */
export async function fetchFilingDirectory(cik: string, accession: string): Promise<FilingDirectoryItem[]> {
  const paddedCik = padCik(cik);
  const noSlashAcc = accessionNoDashes(accession);
  const url = `${SEC_BASE}/Archives/edgar/data/${paddedCik}/${noSlashAcc}/index.json`;

  try {
    const raw = await politeFetchText(url, {
      headers: { "user-agent": secUserAgent(), accept: "application/json" },
      timeoutMs: 15_000
    });
    const parsed = JSON.parse(raw) as {
      directory?: { item?: Array<{ name?: string; type?: string; size?: string | number }> };
    };
    const items = parsed?.directory?.item;
    if (!Array.isArray(items)) return [];

    return items
      .map((item) => ({
        name: item.name ?? "",
        type: item.type,
        size: item.size ? Number(item.size) : undefined
      }))
      .filter((item) => item.name !== "");
  } catch (err) {
    console.warn(`[sec-filings] fetchFilingDirectory failed for CIK ${paddedCik} accession ${accession}:`, err);
    return [];
  }
}


// ── HTML → plain text ────────────────────────────────────────────────────────

/**
 * Strip an EDGAR HTM filing down to plain text, preserving structural whitespace
 * so the chunker's blockDocument() receives well-separated paragraphs and headings.
 *
 * Pipeline:
 *  1. Strip <script> and <style> blocks entirely.
 *  2. Inject newlines around block elements so headings/paragraphs split cleanly.
 *  3. Decode XML/HTML entities.
 *  4. Strip remaining tags.
 *  5. Collapse whitespace runs.
 */
export function extractFilingText(html: string): string {
  return timeSync("extractFilingText", `${Math.round(html.length / 1024)}KB html`, () => extractFilingTextImpl(html));
}

function extractFilingTextImpl(html: string): string {
  // 1, 2, 4. Unified tag extraction in a single pass to minimize massive intermediate string allocations
  let text = html.replace(
    /(<script[\s\S]*?<\/script>)|(<style[\s\S]*?<\/style>)|(<\/?(?:div|p|h[1-6]|li|tr|td|th|table|thead|tbody|tfoot|blockquote|article|section|header|footer|main|aside|figure|figcaption|pre|hr|br)[^>]*>)|(<[^>]+>)/gi,
    (match, script, style, blockTag) => {
      if (script || style) return " ";
      if (blockTag) return "\n";
      return " ";
    }
  );

  // 3. Decode XML entities (mirrors sec8k.ts decodeXmlEntities)
  text = text
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));

  // 5. Collapse whitespace: replace runs of spaces/tabs with a single space,
  //    preserve structural newlines (collapse 3+ newlines to 2).
  text = text
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return text;
}

// ── Core ingest ──────────────────────────────────────────────────────────────

/**
 * Ingest a single filing body into the vector store.
 * - Checks ingested_accessions de-dup table first (skips if already indexed).
 * - Fetches + strips the HTM body.
 * - Calls storeDocument (which routes through chunkDocument → storeContexts).
 * - On success, records the accession in ingested_accessions.
 * - On failure, returns the error string rather than swallowing it.
 * - Always writes with userId='local' so cleanMetadata → scope:'shared'.
 */
/**
 * When the full body is already in `ingested_accessions`, still rewrite the
 * compact extractive abstract if it is missing or stamped with an older model.
 * Uses local SEC HTML artifacts only (no EDGAR re-fetch). Best-effort.
 */
export async function maybeRefreshSecFilingAbstract(
  ticker: string,
  filingRef: FilingRef,
  _userId: string = "local"
): Promise<void> {
  const sourceType = filingRef.docType === "10-Q" ? "10q-delta" : "10k-delta";
  const { abstractNeedsUpgrade, generateAndStoreDocumentAbstract, tradeHighlightChunksFromText } =
    await import("../rag/document-summarizer");
  if (!abstractNeedsUpgrade(filingRef.accession, sourceType)) return;

  const cik = await getCikForTicker(ticker);
  if (!cik) return;
  const html = await readLocalArtifact(
    cik,
    filingRef.accession,
    1,
    filingRef.primaryDoc || "main.html"
  );
  if (!html || html.length < 200) return;

  const { text, sections } = parseFilingHtml(html, { formType: filingRef.docType });
  if (text.length < 100) return;
  const formHint = filingRef.docType === "10-Q" ? "10-Q" : "10-K";
  await generateAndStoreDocumentAbstract({
    ticker,
    accessionOrEventId: filingRef.accession,
    sourceType,
    headline: `${ticker} ${filingRef.docType} highlights (${filingRef.filedAt})`,
    chunks: tradeHighlightChunksFromText(text, {
      maxChunks: 8,
      formHint,
      sections: sections.map((s) => ({
        itemCode: s.itemCode,
        itemTitle: s.itemTitle,
        text: s.text
      }))
    }),
    publishedAt: filingRef.filedAt,
    acceptanceDatetime: filingRef.acceptanceDateTime ?? filingRef.filedAt
  });
}

export async function ingestFiling(
  ticker: string,
  filingRef: FilingRef,
  userId: string = "local",
  leaseGuard?: SecFilingLeaseGuard
): Promise<IngestResult> {
  assertSecFilingLease(leaseGuard);
  // Parser-revision note (deliberate, low-risk choice — PR #1669): this accession
  // ledger is intentionally NOT versioned by parser revision. Filings ingested under
  // the v1 parser keep their v1 (flattened) chunks; only filings not yet in the ledger
  // get the v2 (Cheerio, section-aware) treatment tagged `sec-edgar-filing-v2` below.
  // Re-embedding the existing corpus was considered and rejected: the embed-budget and
  // Pinecone-write cost of a full backfill outweighs the retrieval gain on old filings.
  // If a corpus-wide re-parse is ever wanted, do it as an explicit one-time invalidation
  // (clear ingested_accessions rows for the affected docTypes), not by weakening this
  // sole-gate skip.
  if (hasIngestedAccession(filingRef.accession, filingRef.docType)) {
    // Body is already ledgered — still upgrade extractive abstracts when model lags.
    try {
      await maybeRefreshSecFilingAbstract(ticker, filingRef, userId);
    } catch (err) {
      console.warn(
        `[sec-filings] abstract refresh skipped for ${filingRef.accession}:`,
        err instanceof Error ? err.message : String(err)
      );
    }
    return { skipped: true, chunks: 0 };
  }

  // Budget pre-flight BEFORE the EDGAR fetch: a filing body is 2–10 MB and chunking it is
  // pure waste when the daily embed budget is already spent — storeDocument would only
  // budget-skip it (and emit a budget warning per filing; prod 2026-07-10 saw a 20-event
  // burst from exactly this). Deferring here costs nothing: the accession stays
  // un-recorded and retries at the next tick.
  const { hasIngestTextBudget, hasVectorIngestWriteBudget } = await import("../vector-db");
  assertSecFilingLease(leaseGuard);
  if (!hasIngestTextBudget(userId) || !hasVectorIngestWriteBudget(userId)) {
    return { skipped: true, chunks: 0, budgetExhausted: true };
  }
  // Same preflight for the MONTHLY Pinecone write-unit breaker: while it is active every
  // storeDocument call is refused before embedding anyway, so skip the EDGAR fetch/chunk work
  // entirely and let the bulk loop stop (budgetExhausted semantics — the accession stays
  // un-recorded and retries after the marker expires).  Qdrant writes ignore this park.
  const { vectorWriteBackend } = await import("../vector-store/qdrant-write");
  if (vectorWriteBackend() === "pinecone") {
    const { pineconeWuExhaustedUntil } = await import("../pinecone-wu-breaker");
    if (pineconeWuExhaustedUntil()) {
      return { skipped: true, chunks: 0, budgetExhausted: true };
    }
  }

  let html: string | null = null;
  const cik = await getCikForTicker(ticker);
  if (!cik) {
    return { skipped: false, chunks: 0, error: `unknown CIK for ${ticker}` };
  }
  try {
    assertSecFilingLease(leaseGuard);
    html = await readLocalArtifact(cik, filingRef.accession, 1, filingRef.primaryDoc || "main.html");
    if (html === null) {
      html = await fetchFilingHtml(filingRef.url);
      await writeLocalArtifact(cik, filingRef.accession, 1, filingRef.primaryDoc || "main.html", html);
    }
    assertSecFilingLease(leaseGuard);
  } catch (err) {
    // A stale owner must never turn lease loss into an ordinary provider warning and continue
    // into artifact/vector writes. Re-assert first; normal network errors still return below.
    assertSecFilingLease(leaseGuard);
    const error = err instanceof Error ? err.message : String(err);
    return { skipped: false, chunks: 0, error: `fetch failed: ${error}` };
  }

  if (!html) {
    return { skipped: false, chunks: 0, error: "fetch failed: empty body" };
  }

  // Pass the form type so Item-title canonicalization is form-aware (the 10-K
  // Item-1 -> "Business" mapping must not be applied to 10-Q filings).
  const { text, sections } = parseFilingHtml(html, { formType: filingRef.docType });
  if (text.length < 100) {
    return { skipped: false, chunks: 0, error: "extracted text too short (possible XBRL viewer redirect)" };
  }

  // Insert into sec_artifacts
  try {
    assertSecFilingLease(leaseGuard);
    const { createHash } = await import("crypto");
    assertSecFilingLease(leaseGuard);
    const sha256 = createHash("sha256").update(html).digest("hex");
    const byteCount = Buffer.byteLength(html, "utf8");
    const { insertSecArtifact } = await import("../db");
    assertSecFilingLease(leaseGuard);
    insertSecArtifact({
      accession: filingRef.accession,
      sequence: 1,
      documentName: filingRef.primaryDoc || "main.html",
      sha256,
      type: "html",
      byteCount,
      rawUri: filingRef.url,
      parserVersion: "v2"
    });
    assertSecFilingLease(leaseGuard);
  } catch (err) {
    // Artifact persistence is otherwise best-effort, but ownership loss is terminal.
    assertSecFilingLease(leaseGuard);
    console.warn(`[sec-filings] insertSecArtifact failed for ${filingRef.accession} (non-fatal):`, err instanceof Error ? err.message : String(err));
  }

  assertSecFilingLease(leaseGuard);
  const { storeDocument } = await import("../vector-db");
  assertSecFilingLease(leaseGuard);
  const writeClass = pineconeWriteClass();
  const document = buildSecDocument({
    rawContent: html,
    sections,
    documentName: filingRef.primaryDoc || "main.html",
    ticker,
    docId: `${ticker}:${filingRef.accession}:${filingRef.docType}`,
    title: `${ticker} ${filingRef.docType} (${filingRef.filedAt})`,
    docType: filingRef.docType.toLowerCase(),
    publishedAt: filingRef.filedAt,
    ...(filingRef.acceptanceDateTime ? { acceptanceDateTime: filingRef.acceptanceDateTime } : {}),
    url: filingRef.url
  });
  const localChunks = chunkDocument(document, {});
  try {
    await writeLocalArtifact(
      cik,
      filingRef.accession,
      1,
      "sections.json",
      JSON.stringify(
        sections.map((section) => ({
          itemCode: section.itemCode,
          itemTitle: section.itemTitle,
          text: section.text
        }))
      )
    );
    await writeLocalArtifact(
      cik,
      filingRef.accession,
      1,
      "chunks.json",
      JSON.stringify(
        localChunks.map((chunk) => ({
          text: chunk.text,
          parent_text: chunk.parent_text ?? chunk.text,
          content_hash: chunk.content_hash,
          section: chunk.section,
          itemCode: parseItemCodeFromSection(chunk.section)
        }))
      )
    );
  } catch (err) {
    console.warn(
      `[sec-filings] sections/chunks sidecar failed for ${filingRef.accession}:`,
      err instanceof Error ? err.message : String(err)
    );
  }
  const localComplete = await persistLocalComplete({
    ticker,
    accession: filingRef.accession,
    docType: filingRef.docType,
    chunks: localChunks,
    pineconeWriteClass: writeClass,
    recordLedger: writeClass !== "full-body"
  });
  if (!localComplete.ftsMirrorComplete) {
    return {
      skipped: true,
      chunks: 0,
      ...(localComplete.abortedByStrategy ? { deferredStrategy: true } : {})
    };
  }
  assertSecFilingLease(leaseGuard);
  try {
    const { generateAndStoreDocumentAbstract, tradeHighlightChunksFromText } = await import(
      "../rag/document-summarizer"
    );
    const sourceType = filingRef.docType === "10-Q" ? "10q-delta" : "10k-delta";
    const formHint = filingRef.docType === "10-Q" ? "10-Q" : "10-K";
    await generateAndStoreDocumentAbstract({
      ticker,
      accessionOrEventId: filingRef.accession,
      sourceType,
      headline: `${ticker} ${filingRef.docType} highlights (${filingRef.filedAt})`,
      chunks: tradeHighlightChunksFromText(document.text, {
        maxChunks: 8,
        formHint,
        sections: (document.sections ?? sections).map((s) => ({
          itemCode: s.itemCode,
          itemTitle: s.itemTitle,
          text: s.text
        })),
        sourceChunks: localChunks.map((chunk) => ({
          content_hash: chunk.content_hash,
          text: chunk.text,
          section: chunk.section
        }))
      }),
      publishedAt: filingRef.filedAt,
      acceptanceDatetime: filingRef.acceptanceDateTime ?? filingRef.filedAt
    });
  } catch (err) {
    console.warn(
      `[sec-filings] abstract failed for ${filingRef.accession}:`,
      err instanceof Error ? err.message : String(err)
    );
  }
  assertSecFilingLease(leaseGuard);
  // Default full-body already upserts the whole filing.  Extra signal-section
  // documents would double WU this week (write-class flip still forbidden).
  if (!writesFullBodyToPinecone()) {
    const signal = await storeSignalSectionDocuments({
      ticker,
      accession: filingRef.accession,
      form: filingRef.docType,
      title: document.title,
      publishedAt: filingRef.filedAt,
      acceptanceDatetime: filingRef.acceptanceDateTime ?? filingRef.filedAt,
      source: "sec-edgar",
      url: filingRef.url,
      chunks: localChunks,
      userId,
      ...(leaseGuard ? { leaseGuard } : {})
    }, storeDocument);
    assertSecFilingLease(leaseGuard);
    insertIngestedAccession(filingRef.accession, filingRef.docType, ticker, localChunks.length, {
      pineconeWriteClass: writeClass,
      pineconeVectorCount: signal.indexed
    });
    audit("sec_filing_ingest", {
      ticker,
      accession: filingRef.accession,
      docType: filingRef.docType,
      filedAt: filingRef.filedAt,
      chunks: localChunks.length,
      attempted: localChunks.length,
      pinecone_write_class: writeClass,
      pinecone_vector_count: signal.indexed
    });
    return { skipped: false, chunks: signal.indexed };
  }
  const result = await storeDocument(document, userId, {
    parserRevision: "sec-edgar-filing-v2",
    ...(leaseGuard ? { leaseGuard } : {})
  });
  assertSecFilingLease(leaseGuard);

  if (result.error) {
    return { skipped: false, chunks: result.indexed, error: result.error };
  }

  // storeDocument can come back with indexed: 0 (or a truncated count with budgetSkipped > 0)
  // and NO error — daily chunk budget (RAG_INGEST_MAX_TEXTS_PER_DAY) crossed mid-document or
  // vector keys unconfigured. Recording the accession then would mark the filing "ingested"
  // forever with zero/partial retrievable chunks, inflate the ingested-count receipts, and
  // suppress the corpus-coverage receipt while retrieval finds nothing. Budget exhaustion
  // mid-run is an EXPECTED state during the backlog drain — leave the filing un-recorded so
  // a later run retries it (content-hash dedup makes the re-embed cheap), and flag
  // budgetExhausted so the bulk loop stops instead of grinding through doomed filings.
  // budgetExhausted only on genuine capacity signals — the explicit budget counters or the
  // store's keys-unconfigured skip. A single pathological document that chunks to nothing
  // must not stop the whole run.
  const outOfCapacity =
    (result.budgetSkipped ?? 0) > 0 ||
    (result.writeUnitBudgetSkipped ?? 0) > 0 ||
    result.wuExhausted === true ||
    result.unconfigured === true;
  const reusedCommitted =
    result.reusedCommitted === true && result.documentComplete === true && result.attempted > 0;
  if ((result.indexed <= 0 && !reusedCommitted) || outOfCapacity) {
    return { skipped: true, chunks: result.indexed, ...(outOfCapacity ? { budgetExhausted: true } : {}) };
  }
  if (result.documentComplete !== true || (!reusedCommitted && result.indexed !== result.attempted)) {
    // A content-only dedup receipt or partial Pinecone write cannot complete an accession. Every
    // occurrence must have its own queryable vector and the required local receipt transaction.
    return { skipped: true, chunks: result.indexed };
  }
  if (!result.managedCommitProof) {
    return { skipped: true, chunks: result.indexed, error: "document-commit-proof-missing" };
  }

  try {
    const managedAccession = document.doc_id ?? `${ticker}:${filingRef.accession}:${filingRef.docType}`;
    const ftsRows = localChunks.map((chunk) => ({
      contentHash: chunk.content_hash,
      symbol: chunk.ticker[0] ?? ticker,
      source: "sec-edgar" as const,
      accession: managedAccession,
      text: chunk.text
    }));
    const mirror = await mirrorFtsChunksBounded(ftsRows, {
      resumeKey: { symbol: ticker, source: "sec-edgar", accession: managedAccession }
    });
    if (!mirror.complete) {
      return {
        skipped: true,
        chunks: result.indexed,
        ...(mirror.abortedByStrategy ? { deferredStrategy: true } : {})
      };
    }
    runWithActiveVectorCommitProof(result.managedCommitProof, () => {
      insertIngestedAccession(filingRef.accession, filingRef.docType, ticker, result.attempted, {
        pineconeWriteClass: writeClass,
        pineconeVectorCount: result.attempted
      });
      audit("sec_filing_ingest", {
        ticker,
        accession: filingRef.accession,
        docType: filingRef.docType,
        filedAt: filingRef.filedAt,
        chunks: result.attempted,
        attempted: result.attempted,
        pinecone_write_class: writeClass,
        pinecone_vector_count: result.attempted
      });
    });
  } catch (err) {
    return { skipped: true, chunks: result.indexed, error: err instanceof Error ? err.message : "document-commit-proof-lost" };
  }

  return { skipped: false, chunks: result.attempted };
}

// ── Scheduler-facing refresh ─────────────────────────────────────────────────

/**
 * Whether the free-tier cap applies. Provider-aware (2026-07-19): openrouter/siliconflow
 * (bge-m3) are rate-limited per-request, not by the Voyage free-tier trickle this gate was
 * originally written for, so they're always treated as paid-tier regardless of
 * VECTOR_EMBED_BATCH_DELAY_MS — a Voyage-pricing knob nobody sets when migrating providers.
 * Only when the active provider is voyage (the default) does the legacy env-var heuristic
 * (VECTOR_EMBED_BATCH_DELAY_MS > 5000 = free/default) still apply.
 */
function isFreeTier(): boolean {
  if (activeEmbeddingProvider("local") !== "voyage") return false;
  const delay = Number(process.env.VECTOR_EMBED_BATCH_DELAY_MS ?? 21_000);
  return !Number.isFinite(delay) || delay > PAID_KEY_THRESHOLD_MS;
}

function maxFilingsPerRunFromEnv(): number {
  const n = resolveSourceNumber("SEC_FILING_RAG_MAX_PER_RUN");
  // This catalog entry's own default is 25 (non-zero), so a resolved 0 can ONLY come from an
  // explicit operator override (env or per-user setting), never from "unconfigured" — treat it
  // as authoritative (0 filings this run), not as a signal to fall back to the tier default.
  // Bug history (2026-08-10): the prior `n > 0` guard silently ignored an explicit
  // SEC_FILING_RAG_MAX_PER_RUN=0 site-protective pause and fell through to 25 filings/run on the
  // paid tier — the refresh lane kept running the whole night despite being believed paused.
  if (Number.isFinite(n) && n >= 0) return Math.floor(n);
  return isFreeTier() ? DEFAULT_MAX_FILINGS_PER_RUN : DEFAULT_PAID_MAX_FILINGS_PER_RUN;
}

/** Whether we're due for a filing ingest check (TTL per SEC_FILING_INGEST_TTL_HOURS, default 24h). */
export function isFilingIngestDue(now: number = Date.now()): boolean {
  const last = getInternalSetting<unknown>(ATTEMPT_KEY);
  if (!isValidPersistedTimestamp(last)) return true;
  return now - Date.parse(last) >= filingIngestTtlMs();
}

/**
 * Refresh 10-K/10-Q body ingestion for the given symbol list. Symbols are processed in the
 * order given — callers put the highest-demand names (held positions, watchlists) FIRST so a
 * capped run ingests the filings decisions actually retrieve against.
 *
 * Free-tier (VECTOR_EMBED_BATCH_DELAY_MS > 5000): processes at most 1 filing total per
 * invocation to avoid multi-hour scheduler stalls. The function is still called every tick but
 * the TTL gate (isFilingIngestDue) means it's a no-op until the TTL has passed.
 *
 * Paid-tier (VECTOR_EMBED_BATCH_DELAY_MS <= 5000): processes up to SEC_FILING_RAG_MAX_PER_RUN
 * filings per invocation (default 25).
 *
 * An EXPLICIT `maxPerRun` (the admin backfill route's `limit`) is an operator decision and wins
 * outright — including on free-tier env, where the caller is accepting the slow embed pacing.
 * `opts.force` skips the TTL gate (again: the admin backfill route, which used to silently
 * no-op for up to a week after any scheduler attempt).
 *
 * Provider/data errors are captured in the returned result and the audit log. Lease loss is
 * intentionally re-thrown so a stale scheduler owner cannot continue into the next EDGAR call.
 */
export async function refreshFilingBodies(
  symbols: string[],
  now: number = Date.now(),
  maxPerRun?: number,
  opts?: { force?: boolean; operationLeaseClaim?: OperationLeaseClaim }
): Promise<OperationLeaseAware<RefreshFilingBodiesResult>> {
  const empty: RefreshFilingBodiesResult = {
    attempted: 0,
    ingested: 0,
    skipped: 0,
    deferredForBudget: 0,
    errors: []
  };
  if (symbols.length === 0) return empty;
  if (!opts?.force && !isFilingIngestDue(now)) return empty;

  const guarded = await runWithOperationLease(
    {
      group: OPERATION_LEASE_GROUPS.RAG_REINDEX,
      operation: opts?.force ? "reindex-10k" : "scheduled-filing-ingest",
      claim: opts?.operationLeaseClaim
    },
    async (claim, signal) => refreshFilingBodiesUnlocked(symbols, now, maxPerRun, opts, claim, signal)
  );
  if (!guarded.acquired) return { ...empty, operationLease: guarded.busy };
  return guarded.value;
}

async function refreshFilingBodiesUnlocked(
  symbols: string[],
  now: number,
  maxPerRun: number | undefined,
  opts: { force?: boolean } | undefined,
  operationLeaseClaim: OperationLeaseClaim,
  operationLeaseSignal: AbortSignal
): Promise<RefreshFilingBodiesResult> {
  const result: RefreshFilingBodiesResult = { attempted: 0, ingested: 0, skipped: 0, deferredForBudget: 0, errors: [] };

  // Recheck after durable acquisition so a delayed scheduler process cannot repeat work after the
  // prior owner completed and advanced the cadence stamp.
  if (!opts?.force && !isFilingIngestDue(now)) return result;
  assertOperationLeaseOwnership(operationLeaseClaim);
  const leaseGuard = {
    signal: operationLeaseSignal,
    assertOwnership: () => {
      throwIfOperationLeaseCancelled(operationLeaseSignal);
      assertOperationLeaseOwnership(operationLeaseClaim);
    }
  };

  // Mark attempt so the next tick won't immediately retry. Forced runs (admin backfill)
  // deliberately do NOT touch the stamp — a targeted backfill must not push the scheduled
  // corpus-wide demand-first ingest back by a full TTL window.
  if (!opts?.force) setInternalSetting(ATTEMPT_KEY, new Date(now).toISOString());

  const freeTier = isFreeTier();
  const cap =
    typeof maxPerRun === "number" && Number.isFinite(maxPerRun) && maxPerRun > 0
      ? Math.floor(maxPerRun)
      : freeTier
        ? DEFAULT_MAX_FILINGS_PER_RUN
        : maxFilingsPerRunFromEnv();

  let tickerToCik: Record<string, string>;
  try {
    throwIfOperationLeaseCancelled(operationLeaseSignal);
    tickerToCik = await loadTickerCikMap(now);
  } catch (err) {
    throwIfOperationLeaseCancelled(operationLeaseSignal);
    const msg = err instanceof Error ? err.message : String(err);
    result.errors.push(`loadTickerCikMap failed: ${msg}`);
    return result;
  }

  // Collect (ticker, FilingRef) pairs that need ingesting.
  const pending: Array<{ ticker: string; ref: FilingRef }> = [];

  // 1. Gather previously stashed "discovered" filings from SQLite first
  try {
    const db = getDb();
    const localPendingRows = db.prepare(`
      SELECT accession, cik, ticker, form, filed_at, accepted_at
      FROM sec_filings
      WHERE status = 'discovered' AND ticker IN (${symbols.map(() => "?").join(",")})
    `).all(...symbols) as Array<{ accession: string; cik: string; ticker: string; form: string; filed_at: string; accepted_at: string }>;

    for (const row of localPendingRows) {
      if (!hasIngestedAccession(row.accession, row.form)) {
        const artRow = db.prepare("SELECT document_name, raw_uri FROM sec_artifacts WHERE accession = ? LIMIT 1").get(row.accession) as { document_name: string; raw_uri: string } | undefined;
        const primaryDoc = artRow?.document_name || "";
        const noSlashAcc = accessionNoDashes(row.accession);
        const url = artRow?.raw_uri || (primaryDoc
          ? `${SEC_BASE}/Archives/edgar/data/${padCik(row.cik)}/${noSlashAcc}/${primaryDoc}`
          : `${SEC_BASE}/cgi-bin/browse-edgar?action=getcompany&CIK=${padCik(row.cik)}&type=${row.form}&dateb=&owner=include&count=40`);

        pending.push({
          ticker: row.ticker,
          ref: {
            accession: row.accession,
            docType: row.form as "10-K" | "10-Q",
            filedAt: row.filed_at,
            acceptanceDateTime: row.accepted_at,
            primaryDoc,
            url
          }
        });
      }
    }
  } catch (err) {
    console.warn("[sec-filings] failed to query stashed discovered filings:", err);
  }

  // 2. Dynamic online discovery: only scan tickers if we haven't hit the cap yet
  let onlineFetches = 0;
  const MAX_ONLINE_DISCOVERY_PER_RUN = 20;

  for (const symbol of symbols) {
    if (pending.length >= cap || onlineFetches >= MAX_ONLINE_DISCOVERY_PER_RUN) break;

    // Ingest fundamentals card first (uses local cache or provider API cascade).
    try {
      const fundResult = await ingestFundamentalsCard(symbol, "local", leaseGuard);
      if (fundResult.error) {
        result.errors.push(`ingestFundamentalsCard(${symbol}): ${fundResult.error}`);
      }
    } catch (err) {
      assertSecFilingLease(leaseGuard);
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`ingestFundamentalsCard(${symbol}) threw: ${msg}`);
    }

    const cik = tickerToCik[normalizeSymbol(symbol)] ?? tickerToCik[symbol];
    if (!cik) continue;

    try {
      assertSecFilingLease(leaseGuard);
      onlineFetches++;
      const filings = await fetchRecentFilings(cik, ["10-K", "10-Q"], 10);
      assertSecFilingLease(leaseGuard);

      const db = getDb();
      for (const ref of filings) {
        // Between filings, let queued HTTP requests run: each ingest chains synchronous
        // extract/chunk/score segments, and back-to-back filings otherwise fuse into one long
        // event-loop pin (the 2026-08-10 Uptime Robot stalls during the trial backfill).
        await yieldEventLoop();
        try {
          const existing = db.prepare("SELECT accession FROM sec_filings WHERE accession = ?").get(ref.accession);
          if (!existing) {
            insertSecFiling({
              accession: ref.accession,
              cik,
              ticker: symbol,
              form: ref.docType,
              filedAt: ref.filedAt,
              acceptedAt: ref.acceptanceDateTime,
              status: "discovered",
              chunkCount: 0
            });
          }
        } catch (err) {
          console.warn(`[sec-filings] insertSecFiling failed for ${ref.accession} (non-fatal):`, err instanceof Error ? err.message : String(err));
        }

        if (!hasIngestedAccession(ref.accession, ref.docType)) {
          if (!pending.some((p) => p.ref.accession === ref.accession)) {
            pending.push({ ticker: symbol, ref });
          }
        }
      }
    } catch (err) {
      assertSecFilingLease(leaseGuard);
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`fetchRecentFilings(${symbol}): ${msg}`);
    }

    // Polite delay between CIK fetches
    await sleep(CIK_POLITE_DELAY_MS);
  }

  // 3. Sort pending breadth-first globally so newest annual reports are ingested first.
  // Extra history (2nd+ 10-Q / older 10-K) only for held/watchlist/technical names.
  const deepenTickers = new Set(rankHighInterestSymbols({ now }));
  const sortedPending = sortBreadthFirst(pending, deepenTickers);
  pending.splice(0, pending.length, ...sortedPending);

  // Process pending filings sequentially (EDGAR + Voyage both require polite pacing).
  let processed = 0;
  for (const { ticker, ref } of pending) {
    if (result.attempted >= cap) break;
    result.attempted++;
    processed++;
    try {
      assertOperationLeaseOwnership(operationLeaseClaim);
      const ingestResult = await ingestFiling(ticker, ref, "local", leaseGuard);
      throwIfOperationLeaseCancelled(operationLeaseSignal);
      if (ingestResult.budgetExhausted) {
        // The embed layer is out of capacity for the day (or unconfigured) — every later
        // filing meets the same fate, so stop instead of fetching/chunking doomed documents.
        // Everything not embedded stays un-recorded and retries at the next tick. The count
        // is cap-aware: only filings this run WOULD have attempted, excluding the breaker
        // (which is already counted in attempted/skipped).
        result.skipped++;
        result.deferredForBudget = Math.max(0, Math.min(pending.length, cap) - processed);
        break;
      }
      // Check `error` BEFORE `skipped`: ingestFiling can return `{ skipped: true, error: ... }`
      // (e.g. "document-commit-proof-missing"/"document-commit-proof-lost" below) for a genuine
      // failure that also happened to stop short of a full ingest. The old `skipped`-first order
      // took that branch and silently dropped the error — `result.errors` stayed empty and this
      // refresh reported success (skipped: true is normally benign) while it had actually failed,
      // so monitoring never fired (P1, 2026-08-23).
      if (ingestResult.error) {
        result.errors.push(`ingestFiling(${ticker} ${ref.accession}): ${ingestResult.error}`);
      } else if (ingestResult.skipped) {
        result.skipped++;
      } else {
        result.ingested++;
      }
      // Polite delay between filings (separate from VECTOR_EMBED_BATCH_DELAY_MS which governs
      // chunk-level Voyage batching). Keep at least 300ms between EDGAR fetches.
      if (result.attempted < cap) await sleep(CIK_POLITE_DELAY_MS);
    } catch (err) {
      throwIfOperationLeaseCancelled(operationLeaseSignal);
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`ingestFiling(${ticker} ${ref.accession}) threw: ${msg}`);
    }
  }

  audit("sec_filing_refresh", { symbols: symbols.length, ...result, freeTier, forced: Boolean(opts?.force) });
  return result;
}

// ── Blended Fundamentals Profile Card Ingest ──────────────────────────────────

function fmt(val: any, suffix = ""): string {
  if (val == null || (typeof val === "number" && !Number.isFinite(val))) return "N/A";
  if (typeof val === "number") {
    return `${val.toLocaleString(undefined, { maximumFractionDigits: 2 })}${suffix}`;
  }
  return `${val}${suffix}`;
}

export function buildFundamentalsContext(symbol: string, data: any): string {
  const name = data.companyName ? ` (${data.companyName})` : "";
  const capStr = data.marketCap != null && Number.isFinite(data.marketCap)
    ? `$${(data.marketCap / 1e9).toLocaleString(undefined, { maximumFractionDigits: 2 })}B`
    : "N/A";

  return [
    `Blended Corporate Fundamentals and Profile for ${symbol}${name}.`,
    `Sector: ${fmt(data.sector)}. Industry: ${fmt(data.industry)}.`,
    `Market Cap: ${capStr}. Current Share Price: ${fmt(data.price, " USD")}.`,
    `P/E Ratio: ${fmt(data.peRatio)}. P/B Ratio: ${fmt(data.pbRatio)}. EPS (TTM): ${fmt(data.eps, " USD")}.`,
    `FCF Yield: ${fmt(data.fcfYield, "%")}. Debt-to-Equity: ${fmt(data.debtToEquity)}.`,
    `ROE: ${fmt(data.returnOnEquity, "%")}. ROA: ${fmt(data.returnOnAssets, "%")}.`,
    `Gross Margin: ${fmt(data.grossProfitMargin, "%")}. Free Cash Flow Yield: ${fmt(data.freeCashFlowYield, "%")}.`,
    `Revenue Growth (YoY): ${fmt(data.revenueGrowth, "%")}. EPS Growth (YoY): ${fmt(data.epsGrowth, "%")}.`,
    `Short Interest (% of Float): ${fmt(data.shortPercentOfFloat, "%")}.`,
    `Analyst Consensus Rating: ${fmt(data.analystRating)} (Consensus Score: ${fmt(data.analystScore)}/100).`,
    `Days to Next Earnings: ${fmt(data.daysToEarnings)}. Institutional Ownership: ${fmt(data.institutionOwnershipPct, "%")}.`,
    `Dividend Yield: ${fmt(data.dividendYield, "%")}. Beta: ${fmt(data.beta)}.`,
    `As of: ${data.asOf || new Date().toISOString().slice(0, 10)}.`,
    `Source: blended-fundamentals-enrichment.`,
    `Use this for corporate profile, valuation ranges, capital structure, and growth trends.`,
  ].join("\n");
}

export async function ingestFundamentalsCard(
  symbol: string,
  userId: string = "local",
  leaseGuard?: SecFilingLeaseGuard
): Promise<{ skipped: boolean; error?: string }> {
  try {
    assertSecFilingLease(leaseGuard);
    const { getEnrichmentProvider } = await import("../data-providers");
    const { storeContexts } = await import("../vector-db");

    const provider = getEnrichmentProvider(userId);
    const enriched = await provider.enrich([symbol]);
    assertSecFilingLease(leaseGuard);
    const data = enriched[symbol];
    if (!data) {
      return { skipped: true, error: `No enrichment data found for symbol: ${symbol}` };
    }

    // Skip empty fundamentals cards: if every field rendered by
    // buildFundamentalsContext is null/undefined, embedding an all-"N/A" card
    // wastes budget and pollutes RAG with empty factual content (e.g. when the
    // enrichment cascade returned an empty object for an unsupported ticker or
    // all providers were skipped by quota/circuit breaker). Check every field the
    // card renders so a provider that returns only debtToEquity (for example via
    // SEC_XBRL_ENRICHMENT_ENABLED=on) is not incorrectly dropped.
    const hasRealField =
      data.companyName != null ||
      data.sector != null ||
      data.industry != null ||
      // marketCap is on MarketQuote (types.ts), not SymbolEnrichment; the card renders it
      // via buildFundamentalsContext which takes `data: any`, so check with a safe cast.
      (data as any).marketCap != null ||
      data.price != null ||
      data.peRatio != null ||
      data.pbRatio != null ||
      data.eps != null ||
      data.fcfYield != null ||
      data.debtToEquity != null ||
      data.returnOnEquity != null ||
      data.returnOnAssets != null ||
      data.grossProfitMargin != null ||
      data.freeCashFlowYield != null ||
      data.revenueGrowth != null ||
      data.epsGrowth != null ||
      data.shortPercentOfFloat != null ||
      data.analystRating != null ||
      data.analystScore != null ||
      data.daysToEarnings != null ||
      data.institutionOwnershipPct != null ||
      data.dividendYield != null ||
      data.beta != null;
    if (!hasRealField) {
      return { skipped: true };
    }
    const text = buildFundamentalsContext(symbol, data);
    const publishedAt = data.asOf || new Date().toISOString().slice(0, 10);
    const acceptanceDatetime = new Date().toISOString();

    const result = await storeContexts(
      [
        {
          text,
          metadata: {
            symbol,
            source: "blended-fundamentals",
            timestamp: publishedAt,
            accession: `${symbol}:fundamentals:${publishedAt}`,
            acceptance_datetime: acceptanceDatetime,
            section: "Fundamentals",
            doc_type: "fundamentals",
            ticker: [symbol]
          }
        }
      ],
      userId,
      {
        dedupKeyPrefix: "fundamentals",
        ...(leaseGuard ? { leaseGuard } : {})
      }
    );
    assertSecFilingLease(leaseGuard);

    if (result.error) {
      return { skipped: false, error: result.error };
    }

    const skipped = result.indexed === 0;
    audit("fundamentals_card_ingest", {
      symbol,
      asOf: publishedAt,
      indexed: result.indexed,
      skipped
    });

    return { skipped };
  } catch (err) {
    // Do not convert cooperative cancellation/ownership loss into a normal fundamentals error.
    // A healthy lease passes this check and preserves the existing error-return contract.
    assertSecFilingLease(leaseGuard);
    const error = err instanceof Error ? err.message : String(err);
    return { skipped: false, error };
  }
}

export function sortBreadthFirst(
  filings: Array<{ ticker: string; ref: FilingRef }>,
  deepenTickers?: Set<string>
): Array<{ ticker: string; ref: FilingRef }> {
  // Group by ticker
  const byTicker: Record<string, { k: FilingRef[]; q: FilingRef[] }> = {};
  for (const item of filings) {
    if (!byTicker[item.ticker]) {
      byTicker[item.ticker] = { k: [], q: [] };
    }
    if (item.ref.docType === "10-K") {
      byTicker[item.ticker].k.push(item.ref);
    } else {
      byTicker[item.ticker].q.push(item.ref);
    }
  }

  // Sort each ticker's filings descending by date
  for (const ticker of Object.keys(byTicker)) {
    byTicker[ticker].k.sort((a, b) => b.filedAt.localeCompare(a.filedAt));
    byTicker[ticker].q.sort((a, b) => b.filedAt.localeCompare(a.filedAt));
  }

  const priorityLevels: Array<Array<{ ticker: string; ref: FilingRef }>> = Array.from({ length: 6 }, () => []);

  for (const [ticker, lists] of Object.entries(byTicker)) {
    // Level 0: newest 10-K
    if (lists.k.length > 0) {
      priorityLevels[0].push({ ticker, ref: lists.k[0] });
    }
    // Level 1: newest 10-Q
    if (lists.q.length > 0) {
      priorityLevels[1].push({ ticker, ref: lists.q[0] });
    }
    const deepen = !deepenTickers || deepenTickers.has(ticker);
    // Level 2: second newest 10-Q (depth — high-interest names only)
    if (deepen && lists.q.length > 1) {
      priorityLevels[2].push({ ticker, ref: lists.q[1] });
    }
    // Level 3: third newest 10-Q
    if (deepen && lists.q.length > 2) {
      priorityLevels[3].push({ ticker, ref: lists.q[2] });
    }
    // Level 4: remaining 10-Ks
    if (deepen) {
      for (let i = 1; i < lists.k.length; i++) {
        priorityLevels[4].push({ ticker, ref: lists.k[i] });
      }
    }
    // Level 5: remaining 10-Qs
    if (deepen) {
      for (let i = 3; i < lists.q.length; i++) {
        priorityLevels[5].push({ ticker, ref: lists.q[i] });
      }
    }
  }

  // For each level, sort by filedAt DESC so the newest overall are first
  for (const level of priorityLevels) {
    level.sort((a, b) => b.ref.filedAt.localeCompare(a.ref.filedAt));
  }

  // Flatten
  return priorityLevels.flat();
}

