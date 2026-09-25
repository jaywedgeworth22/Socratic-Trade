// Per-user RAG (Voyage / Pinecone) usage ledger.
//
// Mirrors src/lib/llm-usage.ts: every Voyage embed or rerank call and every Pinecone
// upsert or query call records a row so the operator can meter API spend.
// RAG keys are app-funded (resolved via resolveApiKey), so the userId is always 'local'
// in the system path; per-user separation happens when a user provides their own key.
//
// Pricing notes (approximate, as of 2026-07; verify before committing spend):
//   - voyage-finance-2 embed: $0.00012/1K tokens after the free tier
//   - rerank-2.5:             $0.00005/1K processed tokens after the free tier
//   - Pinecone: serverless — metered by Read/Write Units; rows store units, not dollars.

import crypto from "crypto";
import { audit, getDb, getInternalSetting, setInternalSetting } from "./db";
import { recordPineconeWriteUnits } from "./pinecone-monthly-pace";
import { pushRagUsage } from "./usage-monitor-push";

// ── Types ────────────────────────────────────────────────────────────────────

export type RagOperation = "embed" | "rerank" | "query" | "upsert";

/**
 * The embed/rerank provider dimension (PR bge-m3-metering-gate, 2026-07-18). Distinct from the
 * broader `RagUsageEntry.provider` (which also carries "pinecone" for query/upsert rows) — this
 * narrower union is what `activeEmbeddingProvider`/`activeRerankProvider` in vector-db.ts select
 * between, and what `meterEmbed`/`meterRerank`/`estimateRagDispatchCost` need to price
 * correctly. Defaults to "openrouter" everywhere it's optional.
 */
export type RagEmbedRerankProvider = "voyage" | "openrouter" | "siliconflow";

export interface RagUsageEntry {
  userId?: string;
  operation: RagOperation;
  provider?: string;
  model?: string;
  /** Estimated input tokens; for Pinecone ops this stores estimated/reported Read or Write Units. */
  tokensIn?: number;
  /** Estimated output tokens; for Pinecone ops this stores record count. */
  tokensOut?: number;
  /** Number of items in the batch (texts / records). */
  batchCount?: number;
  /** OpenRouter's generation id for this call (embed/rerank via `baai/bge-m3`/`cohere/rerank-v3.5`).
   *  Undefined for Voyage/SiliconFlow/Pinecone. */
  providerRequestId?: string;
}

export interface RagUsageRow {
  userId: string;
  operation: RagOperation;
  provider: string;
  model: string | null;
  calls: number;
  tokensIn: number;
  tokensOut: number;
  batchCount: number;
  costEstUsd: number;
}

// ── Cost estimation (best-effort) ────────────────────────────────────────────

const SILICONFLOW_PRICE_PER_1K_TOKENS: Record<string, { embed: number; rerank: number }> = {
  // $0.01 per 1M tokens = $0.00001 per 1K tokens — the SAME model + rate as the OpenRouter
  // baai/bge-m3 table below (confirmed on openrouter.ai; SiliconFlow's published bge-m3 embed
  // price matches). The prior literal `0.00001 / 10` was a 10x-too-small typo that undercounted
  // SiliconFlow bge-m3 embed spend in rag_usage.cost_est_usd; pinned exactly in test/rag-metering.test.ts.
  "BAAI/bge-m3": { embed: 0.00001, rerank: 0 },
  "Qwen/Qwen3-Reranker-8B": { embed: 0, rerank: 0.00005 }, // nominal or matching rate
};

// OpenRouter (as of 2026-07-18; verify before relying on this for real billing reconciliation):
//   - baai/bge-m3 embed: confirmed $0.01 per 1M input tokens on openrouter.ai/baai/bge-m3/pricing
//     = $0.00001 per 1K tokens. Token-denominated, so it fits the existing tokensIn*rate model
//     exactly (same shape as the Voyage/SiliconFlow tables above).
const OPENROUTER_EMBED_PRICE_PER_1K_TOKENS: Record<string, number> = {
  "baai/bge-m3": 0.00001
};
//   - cohere/rerank-v3.5 rerank: OpenRouter prices this at $0.001 PER SEARCH
//     (openrouter.ai/cohere/rerank-v3.5), not per token — one "search" is one query plus up to 100
//     documents, and any document over 500 tokens is auto-chunked into additional searches. Our
//     ledger only carries an aggregate tokensIn/batchCount per call (see RagUsageEntry), not
//     per-document token counts, so the 500-token auto-chunking is NOT modeled here — this can
//     undercount cost for unusually long documents. What IS modeled: batchCount (document count)
//     divided into groups of 100, each priced as one search. Good enough for the local $/day
//     dispatch fuse (maxEstimatedCostUsdPer24h) and dashboard visibility; NOT a billing-
//     reconciliation-grade number — reconcile against the OpenRouter dashboard periodically.
const OPENROUTER_RERANK_PRICE_PER_SEARCH: Record<string, number> = {
  "cohere/rerank-v3.5": 0.001
};
const OPENROUTER_DOCUMENTS_PER_SEARCH = 100;

function estimateRagCost(
  provider: string,
  model: string | undefined,
  operation: RagOperation,
  tokensIn: number,
  batchCount?: number
): number | undefined {
  if (operation === "query" || operation === "upsert") return undefined;
  if (provider === "openrouter") {
    if (operation === "embed") {
      const modelKey = (model || "baai/bge-m3").toLowerCase();
      const rate =
        OPENROUTER_EMBED_PRICE_PER_1K_TOKENS[modelKey] ?? OPENROUTER_EMBED_PRICE_PER_1K_TOKENS["baai/bge-m3"];
      return (tokensIn * rate) / 1000;
    }
    // rerank: priced per search, not per token — see the price-table comment above.
    const modelKey = (model || "cohere/rerank-v3.5").toLowerCase();
    const perSearch =
      OPENROUTER_RERANK_PRICE_PER_SEARCH[modelKey] ?? OPENROUTER_RERANK_PRICE_PER_SEARCH["cohere/rerank-v3.5"];
    const documents = Math.max(1, batchCount ?? 1);
    const searches = Math.max(1, Math.ceil(documents / OPENROUTER_DOCUMENTS_PER_SEARCH));
    return searches * perSearch;
  }
  if (provider === "siliconflow") {
    const modelKey = model || "BAAI/bge-m3";
    const prices = SILICONFLOW_PRICE_PER_1K_TOKENS[modelKey] ?? SILICONFLOW_PRICE_PER_1K_TOKENS["BAAI/bge-m3"];
    if (!prices) return undefined;
    const rate = operation === "embed" ? prices.embed : prices.rerank;
    return (tokensIn * rate) / 1000;
  }
  return undefined;
}

// ── Approximate token counting ───────────────────────────────────────────────

/** Crude token estimate from UTF-8 text length (Voyage uses a tokenizer; this is still approximate). */
export function approxTokens(texts: string[]): number {
  return texts.reduce((sum, t) => sum + Math.max(1, Math.ceil(Buffer.byteLength(t, "utf8") / 4)), 0);
}

/**
 * Pre-dispatch cost reservation using the same estimator later written to `rag_usage`. Named for
 * its original Voyage-only origin; `provider` (default "voyage", preserving prior behavior for any
 * caller that omits it) now selects the correct price table so an OpenRouter/SiliconFlow dispatch
 * reserves its OWN cost estimate instead of a Voyage one.
 */
export function estimateRagDispatchCost(
  texts: string[],
  operation: "embed" | "rerank",
  model?: string,
  provider: RagEmbedRerankProvider = "openrouter"
): number {
  // For rerank, `texts` is `[query, ...documents]` (see call sites in vector-db.ts) — the document
  // count (texts.length - 1) is what OpenRouter's per-search rerank pricing needs; embed cost is
  // purely token-based and ignores this.
  const batchCount = operation === "rerank" ? Math.max(0, texts.length - 1) : texts.length;
  return estimateRagCost(provider, model, operation, approxTokens(texts), batchCount) ?? 0;
}

// ── Record ───────────────────────────────────────────────────────────────────

/** Record a RAG operation against a user. Never throws. */
export function recordRagUsage(entry: RagUsageEntry): void {
  try {
    const usageId = crypto.randomUUID();
    const occurredAt = new Date().toISOString();
    const userId = entry.userId || "local";
    const provider = entry.provider || "openrouter";
    const tokensIn = entry.tokensIn ?? 0;
    const tokensOut = entry.tokensOut ?? 0;
    const batchCount = entry.batchCount ?? 1;
    const cost = estimateRagCost(provider, entry.model, entry.operation, tokensIn, batchCount);

    getDb()
      .prepare(
        `INSERT INTO rag_usage (id, user_id, operation, provider, model, tokens_in, tokens_out, batch_count, cost_est_usd, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        usageId,
        userId,
        entry.operation,
        provider,
        entry.model ?? null,
        tokensIn,
        tokensOut,
        batchCount,
        cost ?? null,
        occurredAt
      );
    // Fire-and-forget forward to the API Usage Monitor (no-op unless configured; never throws).
    pushRagUsage({
      sourceEventId: usageId,
      occurredAt,
      provider,
      operation: entry.operation,
      model: entry.model,
      userId,
      tokensIn,
      tokensOut,
      batchCount,
      costUsd: cost,
      providerRequestId: entry.providerRequestId,
    });
  } catch {
    /* ledger is best-effort; never break the caller */
  }
}

/**
 * Convenience: record an embed call. Pass `userId` for per-user retrieval spend so the daily
 * LLM/RAG budget (`checkLlmDailyBudget`, which filters `rag_usage` by userId) actually sees it —
 * omitting it books the spend under the default "local" user and a non-local user's ceiling never trips.
 * `provider` (default "openrouter") must match
 * whichever provider actually served the embed call — see `activeEmbeddingProvider` in
 * vector-db.ts — so the ledger row's price and the `rag_usage.provider` column both reflect reality.
 */
export function meterEmbed(
  texts: string[],
  model?: string,
  userId?: string,
  provider: RagEmbedRerankProvider = "openrouter",
  providerRequestId?: string
): void {
  const tokens = approxTokens(texts);
  recordRagUsage({
    userId,
    operation: "embed",
    provider,
    model:
      model ||
      (provider === "openrouter" ? "baai/bge-m3" : "BAAI/bge-m3"),
    tokensIn: tokens,
    batchCount: texts.length,
    providerRequestId
  });
}

/**
 * Convenience: record a rerank call. Pass `userId` so retrieval rerank spend counts toward that
 * user's daily budget (see `meterEmbed`). `provider` (default "openrouter") must match the active
 * rerank provider — see `activeRerankProvider` in vector-db.ts.
 */
export function meterRerank(
  query: string,
  documents: string[],
  model?: string,
  userId?: string,
  provider: RagEmbedRerankProvider = "openrouter",
  providerRequestId?: string
): void {
  const tokens = approxTokens([query, ...documents]);
  recordRagUsage({
    userId,
    operation: "rerank",
    provider,
    model:
      model ||
      (provider === "openrouter"
        ? "cohere/rerank-v3.5"
        : "Qwen/Qwen3-Reranker-8B"),
    tokensIn: tokens,
    batchCount: documents.length,
    providerRequestId
  });
}

/**
 * Convenience: record a Pinecone query. Pass `userId` so retrieval query spend counts toward that
 * user's daily budget (see `meterEmbed`).
 */
export function meterPineconeQuery(readUnits: number, userId?: string, recordCount?: number): void {
  recordRagUsage({
    userId,
    operation: "query",
    provider: "pinecone",
    tokensIn: readUnits,
    tokensOut: recordCount,
    batchCount: recordCount ?? 1
  });
}

/**
 * Convenience: record a Pinecone upsert.
 *
 * Also advances the persisted CALENDAR-MONTH write-unit counter (pinecone-monthly-pace.ts). The
 * rolling-24h fuse reads `rag_usage` directly, but the monthly pace guard needs a number that
 * survives ledger pruning and that resets on Pinecone's own billing boundary, so it keeps its own
 * one-row total. Both are fed from this single post-success call site so they can never disagree
 * about what was actually delivered. Best-effort and never throws.
 */
export function meterPineconeUpsert(recordCount: number, userId?: string, estimatedWriteUnits?: number): void {
  recordRagUsage({
    userId,
    operation: "upsert",
    provider: "pinecone",
    tokensIn: estimatedWriteUnits,
    tokensOut: recordCount,
    batchCount: recordCount
  });
  // Legacy rows charged 5 WUs/record when no estimate was supplied (see
  // usedPineconeWriteUnitsLast24h in vector-db.ts); keep the month counter on the same basis so a
  // caller that omits the estimate still contributes a realistic figure instead of zero.
  recordPineconeWriteUnits(
    Number.isFinite(estimatedWriteUnits) && (estimatedWriteUnits ?? 0) > 0
      ? (estimatedWriteUnits as number)
      : recordCount * 5
  );
}

// ── Read ─────────────────────────────────────────────────────────────────────

/**
 * Aggregate RAG usage grouped by (userId, operation, provider, model).
 */
export function getRagUsageSummary(opts: { sinceIso?: string } = {}): RagUsageRow[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.sinceIso) {
    where.push("created_at >= ?");
    params.push(opts.sinceIso);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const rows = getDb()
    .prepare(
      `SELECT user_id, operation, provider, model,
              COUNT(*) AS calls,
              COALESCE(SUM(tokens_in),0) AS tokens_in,
              COALESCE(SUM(tokens_out),0) AS tokens_out,
              COALESCE(SUM(batch_count),0) AS batch_count,
              COALESCE(SUM(cost_est_usd),0) AS cost_est_usd
       FROM rag_usage ${clause}
       GROUP BY user_id, operation, provider, model
       ORDER BY cost_est_usd DESC, calls DESC`
    )
    .all(...params) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    userId: String(r.user_id),
    operation: r.operation as RagOperation,
    provider: String(r.provider),
    model: r.model == null ? null : String(r.model),
    calls: Number(r.calls),
    tokensIn: Number(r.tokens_in),
    tokensOut: Number(r.tokens_out),
    batchCount: Number(r.batch_count),
    costEstUsd: Number(r.cost_est_usd)
  }));
}

export const DEFAULT_RAG_MAX_DAILY_INGEST_POINTS = 150_000;

/** Internal watermark: audit the Qdrant daily-point gate skip at most once per UTC day. */
export const RAG_INGEST_POINTS_GATE_AUDIT_DAY_KEY = "rag:ingestPointsGateLastAuditDay";

export function ragMaxDailyIngestPoints(): number {
  const configured = Number(process.env.RAG_MAX_DAILY_INGEST_POINTS ?? process.env.QDRANT_MAX_DAILY_INGEST_POINTS);
  return Number.isFinite(configured) && configured > 0
    ? Math.floor(configured)
    : DEFAULT_RAG_MAX_DAILY_INGEST_POINTS;
}

/**
 * ISO deferral target when the rolling 24h Qdrant point fuse is spent.
 * Mirrors the Pinecone daily-WU fuse park (1h) used by SecIngest / incremental lanes.
 */
export function ragIngestPointsBudgetDeferUntil(nowMs: number = Date.now()): string {
  return new Date(nowMs + 60 * 60_000).toISOString();
}

/**
 * ISO deferral target when the rolling 24h text embed budget (RAG_INGEST_MAX_TEXTS_PER_DAY)
 * is spent.  Parks producers for 1h — matching the Qdrant point and Pinecone WU fuse
 * conventions — so they retry once a slice of the 24h window has rolled.
 */
export function ragIngestTextBudgetDeferUntil(nowMs: number = Date.now()): string {
  return new Date(nowMs + 60 * 60_000).toISOString();
}

/**
 * Audit that the Qdrant daily-point gate skipped work, at most once per UTC day.
 * Producers still park/defer on every call; this only stops audit_events / console spam
 * (Datadog showed ~148k daily-budget skip warns when the fuse was spent).
 */
export function auditRagIngestPointsGateSkip(
  payload: { operation: string; attempted: number; until: string; used?: number; limit?: number },
  userId: string = "local"
): void {
  try {
    const day = new Date().toISOString().slice(0, 10);
    if (getInternalSetting<string>(RAG_INGEST_POINTS_GATE_AUDIT_DAY_KEY) === day) return;
    setInternalSetting(RAG_INGEST_POINTS_GATE_AUDIT_DAY_KEY, day);
    console.warn(
      `[rag-metering] Qdrant daily point ingest fuse spent — parking producers until ${payload.until}` +
        (payload.used != null && payload.limit != null ? ` (used ${payload.used}/${payload.limit})` : "") +
        ` [${payload.operation} attempted=${payload.attempted}]`
    );
    audit("rag_ingest_points_gate_skip", payload, userId);
  } catch {
    // audit is best-effort; the gate result itself is the caller's signal
  }
}

/**
 * Total vector points upserted in the rolling 24-hour window, optionally scoped to a provider.
 */
export function usedRagUpsertPointsLast24h(userId: string = "local", provider?: string): number {
  try {
    const sinceIso = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
    const query = provider
      ? "SELECT COALESCE(SUM(batch_count), 0) AS total FROM rag_usage WHERE user_id = ? AND operation = 'upsert' AND provider = ? AND created_at >= ?"
      : "SELECT COALESCE(SUM(batch_count), 0) AS total FROM rag_usage WHERE user_id = ? AND operation = 'upsert' AND created_at >= ?";
    const params = provider ? [userId, provider, sinceIso] : [userId, sinceIso];
    const row = getDb().prepare(query).get(...params) as { total: number } | undefined;
    return Number(row?.total ?? 0);
  } catch {
    return 0;
  }
}

/**
 * Verifies that the rolling 24-hour vector point ingestion budget has headroom.
 * Defaults to enabled, fail-open on DB errors.
 */
export function hasRagIngestPointsBudget(userId: string = "local", requested: number = 1, provider?: string): boolean {
  if (process.env.RAG_INGEST_POINTS_BUDGET_ENABLED === "off" || process.env.RAG_INGEST_POINTS_BUDGET_ENABLED === "false") {
    return true;
  }
  const used = usedRagUpsertPointsLast24h(userId, provider);
  const limit = ragMaxDailyIngestPoints();
  return used + requested <= limit;
}

// ── R5: consolidated per-retrieval distribution telemetry ───────────────────
//
// (2026-07-01 RAG backlog item R5.) Subsumes three overlapping proposals ("recall-proxy
// telemetry", "per-chunk retrieval trace", "embed/rerank cost meter") into ONE record per
// `retrieveContextDetailed` call, instead of three separate mechanisms. Default OFF via
// RAG_RETRIEVAL_TELEMETRY — when unset/off this is a complete no-op (not even a hashed-query
// computation runs), so default retrieval stays byte-for-byte unchanged.
//
// IMPORTANT — these are DISTRIBUTION telemetry, NOT a recall metric. Recall/MRR is only
// measurable against a golden set (see test/rag-retrieval-eval.test.ts); a field like
// `topCosine` or `finalCount` here says nothing about whether the RIGHT chunks were retrieved.
// Field names are chosen so an operator reading this table doesn't mistake "we got N results
// with a wide score spread" for "recall is good."

import { envFlagOn } from "./rag/env-flag";

/** Returns true when RAG_RETRIEVAL_TELEMETRY is truthy. Default ON (owner enablement 2026-07-24). */
export function retrievalTelemetryEnabled(): boolean {
  return envFlagOn("RAG_RETRIEVAL_TELEMETRY", true);
}

/** Stable, non-reversible hash of a query string — the raw query text must NEVER be persisted
 *  (it may contain private/user-scoped context), only a fingerprint for grouping/debugging. */
export function hashQuery(query: string): string {
  return crypto.createHash("sha256").update(query, "utf8").digest("hex").slice(0, 16);
}

export interface RetrievalQualityRecord {
  /** SHA-256 (first 16 hex) of the query — NEVER the raw query text. */
  queryHash: string;
  /** Requested result count (the caller's `limit`). */
  k: number;
  /** Number of raw Pinecone matches fetched before any post-recall filtering. */
  candidates: number;
  /** Count dropped by the cosine score floor (`minScore`). */
  droppedByMinScore: number;
  /** Count dropped by the as-of point-in-time guard. */
  droppedByAsOf: number;
  /** Whether hybrid BM25/RRF fusion ran for this call. */
  hybrid: boolean;
  /** Whether reranking was attempted for this call (not necessarily succeeded). */
  rerankAttempted: boolean;
  /** Whether reranking actually ran (fusedPool.length > limit) and returned scored results. */
  rerankRan: boolean;
  /** Top cosine similarity score in the final pool (undefined if the pool ended up empty). */
  topCosine?: number;
  /** Top Voyage cross-encoder relevance score, if rerank produced one (undefined otherwise). */
  topRelevanceScore?: number;
  /** Final chunk count returned to the caller after every stage (score floor/as-of/hybrid/rerank/limit). */
  finalCount: number;
}

/**
 * Record one consolidated retrieval-quality distribution record. Fire-and-forget: wrapped in
 * try/catch so a telemetry failure (DB unavailable, serialization error) can never break
 * retrieval. No-ops entirely when RAG_RETRIEVAL_TELEMETRY is unset/off — the caller is expected
 * to gate the (cheap but non-zero) call site itself, but this function double-checks the flag
 * so importing/calling it directly is always safe.
 */
export function recordRetrievalQuality(entry: RetrievalQualityRecord, userId: string = "local"): void {
  if (!retrievalTelemetryEnabled()) return;
  try {
    audit(
      "rag_retrieval_quality",
      {
        queryHash: entry.queryHash,
        k: entry.k,
        candidates: entry.candidates,
        droppedByMinScore: entry.droppedByMinScore,
        droppedByAsOf: entry.droppedByAsOf,
        hybrid: entry.hybrid,
        rerankAttempted: entry.rerankAttempted,
        rerankRan: entry.rerankRan,
        topCosine: entry.topCosine,
        topRelevanceScore: entry.topRelevanceScore,
        finalCount: entry.finalCount
      },
      userId
    );
  } catch {
    /* telemetry is best-effort only; never break retrieval */
  }
}
