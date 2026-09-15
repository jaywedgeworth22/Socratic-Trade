import { Pinecone, type PineconeRecord, type RecordMetadata } from "@pinecone-database/pinecone";
import crypto from "crypto";
import { siliconflowBaseUrl } from "./siliconflow-base";
import * as dbModule from "./db";
import { audit, getInternalSetting, resolveApiKey, setInternalSetting, type ApiKeySource } from "./db";
import { filterNewDocumentChunks, insertDocumentChunks } from "./db";
import { deleteStagedEmbeddings, getStagedEmbeddings, stageEmbeddedVectors } from "./db-embed-stage";
import { isProviderDispatchLeaseLostError } from "./db-provider-dispatch";
import { getLaneHealth, logApiHealth, transientEscalationWindowMs } from "./db-health";
import { isLocalDbFaultError, localDbFaultReason, noteLocalDbFault } from "./local-db-fault";
import { describeNetworkError, isTransientNetworkError, isTransientNetworkErrorText } from "./network-errors";
import {
  auditPineconeWuGateSkip,
  isPineconeWuExhaustedError,
  notePineconeWriteSuccess,
  pineconeWuExhaustedUntil,
  tripPineconeWuBreaker
} from "./pinecone-wu-breaker";
import { applyOpenRouterClassifierEnrichment } from "./llm-call";
import { logError, logWarn, recordEmbedFailure, recordRagRejection } from "./sentry-metrics";
import { withGenAiSpan, withSentrySpan } from "./sentry-gen-ai";
import { timeSync as timeSyncGuard } from "./slow-sync-guard";
import { CHARS_PER_TOKEN_CEILING, DEFAULT_MAX_TOKENS, canonicalTicker, chunkDocument, hashContent, type ChunkInput, type ChunkOptions } from "./rag/chunk";
import { EARNINGSCALLS_TRANSCRIPT_SOURCE, earningsCallsTranscriptsEnabled } from "./earningscalls-gate";
import { ROIC_TRANSCRIPT_SOURCE, roicTranscriptsEnabled } from "./roic-transcripts-gate";
import { envFlagOn } from "./rag/env-flag";
import { bareSecAccession } from "./rag/pinecone-write-class";
import { resolveSourceBool } from "./source-settings";
import { serverKnobBool } from "./server-knobs";
import { expandPostRerankParentContext } from "./rag/parent-context";
import { fuseHybrid, rrfFuse } from "./rag/hybrid";
import { searchCorpusWideLexicalCandidates, type CorpusWideLexicalCandidate } from "./rag/corpus-wide-lexical";
import { fuseDenseAndLexicalRecall, hasLexicalRecall } from "./rag/recall-fusion";
import { adaptiveRerankEnabled, planRerank, resolveRerankRoute, type RagRerankProvider } from "./rag/rerank-policy";
import { RetrievalStageTrace, type RetrievalTraceSnapshot } from "./rag/retrieval-stage-telemetry";
import { dedupeSimilar, type DedupeSimilarReport } from "./rag/dedupe-similar";
import { getCachedQueryEmbedding, setCachedQueryEmbedding } from "./rag/query-embed-cache";
import { recordRagOperation, shouldDegradeForBudget } from "./rag/run-budget";
import { estimateRagDispatchCost, getRagUsageSummary, hasRagIngestPointsBudget, hashQuery, meterEmbed, meterPineconeQuery, meterPineconeUpsert, meterRerank, recordRetrievalQuality, retrievalTelemetryEnabled, type RagEmbedRerankProvider } from "./rag-metering";
import {
  EMBED_REQUEST_TOKEN_BUDGET,
  embedRequestFits,
  packInWindowTexts
} from "./rag/embed-request-pack";
import { pineconeMonthToDateWriteUnits } from "./pinecone-monthly-pace";
import { selectItemsWithinWriteBudget } from "./pinecone-write-budget";
import { pineconeTrialState } from "./pinecone-trial-window";
import { candidatePoolPersistEnabled, recordCandidatePool, candidatePoolFullPersistEnabled, recordCandidatePoolFull, type CandidateDisposition } from "./rag/candidate-pool";
import { isOverLlmBudget } from "./llm-budget";
import { sendNotification } from "./notifications";
import { alertUsageLimitHit } from "./usage-limit-alerts";
import {
  OPERATION_LEASE_GROUPS,
  assertOperationLeaseOwnership,
  runWithOperationLease,
  throwIfOperationLeaseCancelled,
  type OperationLeaseBusy
} from "./operation-lease";
import {
  assertUserOperationClaim,
  withUserWriteOperation,
  type UserOperationClaim
} from "./user-write-fence";
import { hasInFlightStrategyWork, shouldSkipWholeIndexInventory } from "./db-execution";
import { assertQdrantCollectionMetric, meterQdrantQuery, qdrantQueryTier, vectorReadBackend } from "./vector-store/qdrant-read";
import {
  meterQdrantUpsert,
  qdrantCollectionInfo,
  qdrantDeleteByFilter,
  qdrantDeleteByIds,
  qdrantDeleteNamespace,
  qdrantInventoryByMetadata,
  qdrantProviderAuthority,
  qdrantRetrieveByPcIds,
  qdrantSetPayload,
  qdrantUpsertPoints,
  vectorWriteBackend
} from "./vector-store/qdrant-write";

export class WholeIndexInventoryDeferredError extends Error {
  readonly code = "whole-index-inventory-deferred" as const;
  constructor() {
    super("Whole-index Pinecone inventory deferred while a strategy run is in flight");
    this.name = "WholeIndexInventoryDeferredError";
  }
}

export function isWholeIndexInventoryDeferredError(error: unknown): boolean {
  return (
    error instanceof WholeIndexInventoryDeferredError
    || (error instanceof Error && error.name === "WholeIndexInventoryDeferredError")
  );
}

function usesQdrantWrites(): boolean {
  return vectorWriteBackend() === "qdrant";
}

/** Durable SQLite authority first so Qdrant writes keep matching copied occ:v3 ids. */
function resolveQdrantWriteProviderAuthority(ledgerAuthority?: string): string {
  try {
    if (typeof dbModule.durableProviderAuthority === "function") {
      const durable = dbModule.durableProviderAuthority(ledgerAuthority);
      if (durable) return durable;
    }
  } catch {
    // Isolated unit suites replace the DB barrel with a tiny mock.
  }
  return qdrantProviderAuthority();
}

function assertGatherSafeWholeIndexInventory(options?: {
  accountDeletionRequestId?: string;
  allowDuringStrategyWork?: boolean;
}): void {
  if (options?.allowDuringStrategyWork || options?.accountDeletionRequestId) {
    return;
  }
  if (
    !shouldSkipWholeIndexInventory({
      strategyWorkInFlight: hasInFlightStrategyWork()
    })
  ) {
    return;
  }
  throw new WholeIndexInventoryDeferredError();
}

const LAST_INGEST_KEY = "vectorStore:lastIngest";
const RAG_CONNECTION_ALERT_PREFIX = "vectorStore:connectionAlert";
const PINECONE_WU_BUDGET_SENTRY_KEY = "pinecone:wuBudgetSentryAt";
const PINECONE_WU_BUDGET_SENTRY_COOLDOWN_MS = 6 * 60 * 60 * 1000;

function shouldEmitPineconeWuBudgetSentry(nowMs: number = Date.now()): boolean {
  const last = getInternalSetting<string>(PINECONE_WU_BUDGET_SENTRY_KEY);
  const lastMs = last ? Date.parse(last) : Number.NaN;
  if (Number.isFinite(lastMs) && nowMs - lastMs < PINECONE_WU_BUDGET_SENTRY_COOLDOWN_MS) return false;
  setInternalSetting(PINECONE_WU_BUDGET_SENTRY_KEY, new Date(nowMs).toISOString());
  return true;
}
const RAG_CONNECTION_ALERT_COOLDOWN_MS = 60 * 60_000;
const RAG_INGEST_BUDGET_ALERT_PREFIX = "vectorStore:ingestBudgetAlert";
const RAG_INGEST_BUDGET_ALERT_COOLDOWN_MS = 30 * 60_000;

/**
 * A persistent daily-ingest-budget exhaustion must page ONCE per cooldown window, not once per
 * document/tick. Unlike alertRagConnectionFailure (which has always had a cooldown), this Sentry
 * warning had none: SOCRATIC-TRADE-27 fired 8,036 times over 2 days (roughly every 10-20s,
 * matching the SEC ingest worker's 5s tick x up to 5 tasks/tick claimed against one persistent
 * condition) and buried the handful of real "embed connection failed" events underneath it.
 */
function shouldEmitRagIngestBudgetSentry(userId: string, nowMs: number = Date.now()): boolean {
  // Fail-soft (2026-09-07 P2 fix): getInternalSetting/setInternalSetting are synchronous SQLite
  // calls and can throw (e.g. SQLITE_BUSY under contention). This helper only gates an optional
  // Sentry warning — it must never let a persistence error escape into storeContextsImpl's
  // control flow and turn an expected budget-skip into a rejected store operation. On any read/
  // write failure, fail open (emit) rather than throw or silently suppress forever.
  try {
    const key = `${RAG_INGEST_BUDGET_ALERT_PREFIX}:${userId}`;
    const last = getInternalSetting<string>(key);
    const lastMs = last ? Date.parse(last) : Number.NaN;
    if (Number.isFinite(lastMs) && nowMs - lastMs < RAG_INGEST_BUDGET_ALERT_COOLDOWN_MS) return false;
    setInternalSetting(key, new Date(nowMs).toISOString());
    return true;
  } catch (err) {
    logWarn("rag.ingest_budget_cooldown_persist_failed", {
      userId,
      error: err instanceof Error ? err.message : String(err)
    });
    return true;
  }
}
const VECTOR_COMMIT_LEASE_MS = 15 * 60_000;
const VECTOR_RECONCILE_CONFIRMATION_GRACE_MS = 5 * 60_000;
const MANAGED_VECTOR_LEDGER_SETTING = "vectorStore:managedLedgerAuthority";
const DEFAULT_ERASURE_VERIFY_ATTEMPTS = 4;
const DEFAULT_ERASURE_VERIFY_CONSECUTIVE_CLEAN = 3;
const DEFAULT_ERASURE_VERIFY_DELAY_MS = 500;

const globalForVectorCommitSerializers = globalThis as typeof globalThis & {
  __socraticVectorCommitSerializers?: Map<string, Promise<void>>;
};
const vectorCommitSerializers =
  globalForVectorCommitSerializers.__socraticVectorCommitSerializers ??
  (globalForVectorCommitSerializers.__socraticVectorCommitSerializers = new Map());

/** Scope values written into vector metadata. New vectors carry this; legacy vectors lack it. */
export const SHARED_SCOPE = "shared" as const;
export const PRIVATE_SCOPE = "private" as const;
export type VectorScope = typeof SHARED_SCOPE | typeof PRIVATE_SCOPE;

export interface StoreContextsResult {
  /** Documents handed in (after trimming/empty-filter). */
  attempted: number;
  /** Records actually upserted into Pinecone. */
  indexed: number;
  /** Set when the embed/upsert flow threw (e.g. Voyage 429) — the failure is no longer silent. */
  error?: string;
  /** True when nothing was stored for a non-error reason — see unconfigured/dedupComplete for which. */
  skipped?: boolean;
  /** Set with skipped: Pinecone/Voyage keys missing — nothing can embed until configured. */
  unconfigured?: boolean;
  /** Set by opt-in `storeContexts` content dedup only. This proves reusable content exists, not that
   *  a new source occurrence has its own queryable vector; source producers must require
   *  `documentComplete` instead. `storeDocument` never returns this shortcut. */
  dedupComplete?: boolean;
  /** `storeDocument` found this exact deterministic commit and occurrence set already committed.
   * No provider call or budget was consumed; `indexed` is therefore zero while `attempted` is the
   * proven complete source cardinality. Source ledgers may treat this as completed reuse only when
   * `documentComplete` is also true. */
  reusedCommitted?: boolean;
  /** CAS proof required for atomically writing the producer's source-completion ledger. */
  managedCommitProof?: dbModule.ActiveVectorCommitProof;
  /**
   * Set by storeDocument only when every source occurrence has a successful Pinecone upsert plus
   * atomic document_chunks/chunk_occurrences receipts. Producers must require this plus either
   * exact indexed===attempted cardinality or an exact reusedCommitted receipt before writing a
   * source-level completion ledger.
   */
  documentComplete?: boolean;
  /**
   * Count of malformed or unaccounted response entries detected by the integrity guard. Any positive
   * value rejects its entire Voyage batch, so callers can distinguish "nothing to embed" from an
   * incomplete/ambiguous provider response and keep the source document retryable.
   */
  rejectedInvalidEmbeddings?: number;
  /** Count skipped by RAG_INGEST_MAX_TEXTS_PER_DAY before any Voyage/Pinecone write. */
  budgetSkipped?: number;
  /** Count skipped by RAG_PINECONE_MAX_WRITE_UNITS_PER_DAY before any Voyage/Pinecone write. */
  writeUnitBudgetSkipped?: number;
  /** Count of previously-PAID embeddings replayed from the durable embed_stage table
   *  (db-embed-stage.ts) with no provider call — the embed-once guarantee in action. Rows only
   *  exist between a paid embed and its successful Pinecone delivery, so this is non-zero only
   *  when a prior attempt's upsert failed (WU exhaustion, 429s, network, restart). */
  embedsFromStage?: number;
  /** Set with skipped when the MONTHLY Pinecone write-unit breaker is active
   *  (pinecone-wu-breaker.ts): the store was refused BEFORE any embed spend or Pinecone call.
   *  Producers should treat this as a clean deferral until `wuExhaustedUntil`, never a failure. */
  wuExhausted?: boolean;
  /** ISO instant the monthly WU breaker expires (first day of next month UTC). */
  wuExhaustedUntil?: string;
  /**
   * The real embed-api-failed text (e.g. an HTTP 400/429 body) from the LAST rejected batch,
   * even on the non-throwing success path — a batch-isolated embed failure just drops that
   * batch's records and lets the call continue, so `error` (reserved for "the whole call threw")
   * stays unset here. Producers that need to classify permanent-vs-transient when
   * `rejectedInvalidEmbeddings > 0` (e.g. the SEC ingest worker deciding retryable-vs-dead-letter
   * — see classifyEmbedFailure) should read this instead of assuming a total failure.
   */
  embedFailureMessage?: string;
}

export interface VectorStoreStats {
  configured: boolean;
  indexName: string;
  exists?: boolean;
  totalVectorCount?: number;
  dimension?: number;
  error?: string;
}

export interface VectorIndexStats {
  indexName: string;
  totalVectorCount?: number;
  dimension?: number;
  error?: string;
}

function pinnedEmbedProvider(): RagEmbedRerankProvider | undefined {
  const raw = process.env.RAG_EMBED_PROVIDER?.trim().toLowerCase();
  if (!raw) return undefined;
  if (raw === "openrouter" || raw === "siliconflow") return raw;
  if (process.env.NODE_ENV === "test" && raw === "voyage") return raw as any;
  throw new Error(
    `Invalid RAG_EMBED_PROVIDER "${raw}" — must be one of "openrouter", "siliconflow", or unset.`
  );
}

function assertPinnedProviderKeyConfigured(provider: RagEmbedRerankProvider, userId: string): void {
  if (provider === ("voyage" as any)) return;
  const key = resolveApiKey(provider, userId);
  if (key && !key.startsWith("mock")) return;
  const envVar = provider === "openrouter" ? "OPENROUTER_API_KEY" : "SILICONFLOW_API_KEY";
  throw new Error(
    `RAG_EMBED_PROVIDER is pinned to "${provider}" but no ${provider} API key is configured for user ` +
    `"${userId}". Set ${envVar} (or a per-user key), or unset RAG_EMBED_PROVIDER to fall back to ` +
    `key-presence precedence.`
  );
}

function resolveActiveRagProvider(userId: string): RagEmbedRerankProvider {
  const pinned = pinnedEmbedProvider();
  if (pinned) {
    assertPinnedProviderKeyConfigured(pinned, userId);
    return pinned;
  }
  const openrouterKey = resolveApiKey("openrouter", userId);
  if (openrouterKey && !openrouterKey.startsWith("mock")) return "openrouter";
  const siliconflowKey = resolveApiKey("siliconflow", userId);
  if (siliconflowKey && !siliconflowKey.startsWith("mock")) return "siliconflow";
  if (process.env.NODE_ENV === "test") {
    const voyageKey = resolveApiKey("voyage", userId);
    if (voyageKey) return "voyage" as any;
  }
  return "openrouter";
}

export function activeEmbeddingProvider(userId: string = "local"): RagEmbedRerankProvider {
  return resolveActiveRagProvider(userId);
}

export function activeRerankProvider(userId: string = "local"): RagEmbedRerankProvider {
  return activeRerankRoute(userId).provider;
}

export function activeEmbeddingModel(userId: string = "local"): string {
  const provider = activeEmbeddingProvider(userId);
  if (provider === "siliconflow") return "BAAI/bge-m3";
  if (provider === ("voyage" as any)) return "voyage-finance-2";
  return "baai/bge-m3";
}

export function embeddingSpaceRevisionForModel(model: string): string {
  const rev = currentEmbedRev();
  if (model === "voyage-finance-2") return `v${rev}`;
  return `v${rev}-${model.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
}

export function embedSpaceFilterForModel(model: string): Record<string, unknown> {
  if (model === "voyage-finance-2") return {};
  const variants = new Set([model]);
  if (model.toLowerCase() === "baai/bge-m3") {
    variants.add("baai/bge-m3");
    variants.add("BAAI/bge-m3");
  }
  return { embed_model: { $in: [...variants] } };
}

function embeddingSpaceRevision(userId: string = "local"): string {
  return embeddingSpaceRevisionForModel(activeEmbeddingModel(userId));
}

function buildEmbedSpaceFilter(userId: string): Record<string, unknown> {
  return embedSpaceFilterForModel(activeEmbeddingModel(userId));
}

export function activeRerankModel(userId: string = "local"): string {
  return activeRerankRoute(userId).model;
}

export interface ResolvedRagRuntimeConfiguration {
  embeddingProvider: string;
  embeddingModel: string;
  embeddingCredentialSource: ApiKeySource;
  rerankProvider: string;
  rerankModel: string;
  rerankAvailable: boolean;
  pineconeIndexName: string;
  pineconeCredentialSource: ApiKeySource;
  pineconeProviderAuthority?: string;
  ledgerAuthority: string;
}

/** Non-secret runtime receipt for evaluation; values come from the same resolvers as retrieval. */
export async function resolvedRagRuntimeConfiguration(
  userId: string = "local"
): Promise<ResolvedRagRuntimeConfiguration> {
  const embeddingProvider = activeEmbeddingProvider(userId);
  const embeddingCredential = resolveRagKeyWithSource(embeddingProvider, userId);
  const rerankRoute = activeRerankRoute(userId);
  const clients = await getClients(userId);
  const providerAuthority = clients.initCacheKey
    ? stableProviderAuthorityForInitKey(clients.initCacheKey)
    : undefined;
  return {
    embeddingProvider,
    embeddingModel: activeEmbeddingModel(userId),
    embeddingCredentialSource: embeddingCredential.source,
    rerankProvider: rerankRoute.provider,
    rerankModel: rerankRoute.model,
    rerankAvailable: rerankRoute.available,
    pineconeIndexName: indexName(),
    pineconeCredentialSource: clients.pineconeSource,
    ...(providerAuthority ? { pineconeProviderAuthority: providerAuthority } : {}),
    ledgerAuthority: managedVectorLedgerAuthority()
  };
}

function providerCredentialAvailable(provider: RagRerankProvider, userId: string): boolean {
  const key = resolveApiKey(provider, userId);
  return Boolean(key && !key.startsWith("mock"));
}

function activeRerankRoute(userId: string, allowMockClient = false) {
  const embeddingProvider = activeEmbeddingProvider(userId);
  return resolveRerankRoute({
    embeddingProvider: embeddingProvider === "siliconflow" ? "siliconflow" : "openrouter",
    hasCredential: (provider) => allowMockClient || providerCredentialAvailable(provider, userId)
  });
}
/**
 * Embedding representation revision (2026-07-04 RAG quick-wins, builds on the composite review's
 * embed-model version-tag item). Bump this whenever the embedding-space representation changes in
 * a way that breaks direct cosine comparability against previously-indexed vectors — e.g. a
 * `VOYAGE_MODEL` swap, or flipping `VECTOR_EMBED_CLEAN_TEXT` (R17). Vectors written before this
 * item shipped carry no `embed_rev` at all; callers should treat a missing value as rev 0, NOT as
 * this rev, so a mixed population stays distinguishable.
 *
 * `currentEmbedRev()` returns BASE (1) normally, and CLEAN_TEXT (2) when
 * `VECTOR_EMBED_CLEAN_TEXT` is on — so enabling clean-text is migration-safe to *detect* (new
 * vectors are tagged differently) even before a full reindex. Do not purge rev-1 until an
 * inventory/backfill/completeness/switchover receipt says so.
 */
const BASE_EMBED_REV = 1;
const CLEAN_TEXT_EMBED_REV = 2;

/** Live representation revision stamped on every newly-written vector (`embed_rev` metadata). */
export function currentEmbedRev(): number {
  return embedCleanTextEnabled() ? CLEAN_TEXT_EMBED_REV : BASE_EMBED_REV;
}
const EMBEDDING_DIMENSION = 1024; // voyage-finance-2 dimension
const DEFAULT_INDEX_NAME = "socratic-trade";
const DEFAULT_EMBED_BATCH_SIZE = 8;
const DEFAULT_EMBED_BATCH_DELAY_MS = 21_000; // unpaid Voyage limit is 3 RPM; paid accounts can set this to 0.
const DEFAULT_CONTEXT_MAX_CHARS = 2400;
const DEFAULT_EMBED_RETRY_ATTEMPTS = 2;
const DEFAULT_EMBED_RETRY_DELAY_MS = 20_000;
const DEFAULT_INGEST_MAX_TEXTS_PER_DAY = 20_000;
const DEFAULT_PINECONE_WRITE_UNITS_PER_DAY = 200_000;

/**
 * Embedding integrity guard (R2, 2026-07-01 expert review): a Voyage model/config drift (partial
 * response, NaN values) would otherwise upsert/query a degenerate vector that silently poisons
 * cosine scoring. Always-on (no flag) — it only ever REJECTS malformed data, never valid data.
 *
 * Deliberately checks non-emptiness + finiteness only, NOT strict equality to EMBEDDING_DIMENSION
 * (1024): many existing tests across this codebase use short illustrative mock embeddings (e.g.
 * `[0.1, 0.2]`) for readability, and a strict dimension check would reject all of them as "invalid"
 * even though they're perfectly fine test doubles, not production drift. A wrong-dimension response
 * from the REAL Voyage API would itself almost certainly also be empty/malformed in a way this still
 * catches; a hard 1024-only assertion is a follow-up if production evidence ever shows a same-length
 * garbage response slipping through.
 */
export function isValidEmbedding(embedding: unknown): embedding is number[] {
  return (
    Array.isArray(embedding) &&
    embedding.length > 0 &&
    embedding.every((v) => typeof v === "number" && Number.isFinite(v))
  );
}

export interface ValidatedDocumentEmbeddingBatch {
  /** Embeddings ordered by original request position; present only when the whole response is valid. */
  embeddings?: number[][];
  /** Number of malformed/unaccounted response entries; any positive value rejects the whole batch. */
  rejected: number;
  /** Bounded diagnostic code; never contains provider content or document text. */
  reason?: "missing-data" | "cardinality" | "malformed-item" | "mixed-index" | "invalid-index" | "duplicate-index" | "invalid-embedding" | "embed-api-failed" | "embed-api-skipped";
}

/**
 * Validate Voyage's document response as an exact one-to-one mapping before any Pinecone write.
 * Explicit indices may arrive out of response-array order and are authoritative. A legacy response
 * with no indices remains positional, but mixed index presence is ambiguous and fails closed.
 */
export function validateDocumentEmbeddingBatch(
  data: unknown,
  expectedCount: number
): ValidatedDocumentEmbeddingBatch {
  if (!Array.isArray(data)) {
    return { rejected: Math.max(1, expectedCount), reason: "missing-data" };
  }
  if (data.length !== expectedCount) {
    return { rejected: Math.max(1, expectedCount), reason: "cardinality" };
  }

  const items: Array<{ embedding?: unknown; index?: unknown }> = [];
  let explicitIndexCount = 0;
  for (const raw of data) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return { rejected: Math.max(1, expectedCount), reason: "malformed-item" };
    }
    const item = raw as { embedding?: unknown; index?: unknown };
    if (item.index !== undefined) explicitIndexCount += 1;
    items.push(item);
  }
  if (explicitIndexCount !== 0 && explicitIndexCount !== expectedCount) {
    return { rejected: Math.max(1, expectedCount), reason: "mixed-index" };
  }

  const embeddings = new Array<number[]>(expectedCount);
  const seen = new Set<number>();
  let invalidEmbeddings = 0;
  for (let responsePosition = 0; responsePosition < items.length; responsePosition++) {
    const item = items[responsePosition]!;
    const targetIndex = explicitIndexCount === 0 ? responsePosition : item.index;
    if (!Number.isInteger(targetIndex) || (targetIndex as number) < 0 || (targetIndex as number) >= expectedCount) {
      return { rejected: Math.max(1, expectedCount), reason: "invalid-index" };
    }
    const requestIndex = targetIndex as number;
    if (seen.has(requestIndex)) {
      return { rejected: Math.max(1, expectedCount), reason: "duplicate-index" };
    }
    seen.add(requestIndex);
    if (!isValidEmbedding(item.embedding)) {
      invalidEmbeddings += 1;
      continue;
    }
    embeddings[requestIndex] = item.embedding;
  }
  if (invalidEmbeddings > 0 || embeddings.some((embedding) => !embedding)) {
    return { rejected: Math.max(1, invalidEmbeddings), reason: "invalid-embedding" };
  }
  return { embeddings, rejected: 0 };
}

export interface ContextDocument {
  text: string;
  /**
   * Optional exact text handed to Voyage while `text` remains the citation/display payload.
   * `storeDocument` uses raw chunk content here so occurrence-specific provenance stays in metadata
   * and citations without forcing byte-identical content to be embedded again for every ticker/date.
   */
  embeddingText?: string;
  metadata: { symbol: string; source: string; timestamp: string; accession?: string; [key: string]: unknown };
}

const DOCUMENT_EMBED_CACHE_MAX_ENTRIES = 4096;
const DOCUMENT_EMBED_CACHE_TTL_MS = 6 * 60 * 60_000;

interface DocumentEmbeddingCacheEntry {
  embedding: number[];
  expiresAt: number;
}

// Exact-text, vector-only, process-local cache. It never stores Pinecone results or metadata, so
// user/symbol/PIT filters still execute independently for every per-occurrence vector materialized.
const documentEmbeddingCache = new Map<string, DocumentEmbeddingCacheEntry>();

function documentEmbeddingCacheKey(input: string, userId: string = "local"): string {
  // `input` is already the exact post-cleaning text, so model + representation revision + bytes is
  // sufficient and remains stable even if an operator changes an env flag while a call is in flight.
  const modelName = activeEmbeddingModel(userId);
  return `${modelName}\u0000${currentEmbedRev()}\u0000${input}`;
}

function getCachedDocumentEmbedding(input: string, userId: string = "local"): number[] | undefined {
  const key = documentEmbeddingCacheKey(input, userId);
  const entry = documentEmbeddingCache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt || !isValidEmbedding(entry.embedding)) {
    documentEmbeddingCache.delete(key);
    return undefined;
  }
  documentEmbeddingCache.delete(key);
  documentEmbeddingCache.set(key, entry);
  return [...entry.embedding];
}

function setCachedDocumentEmbedding(input: string, embedding: number[], userId: string = "local"): void {
  if (!isValidEmbedding(embedding)) return;
  const key = documentEmbeddingCacheKey(input, userId);
  documentEmbeddingCache.delete(key);
  documentEmbeddingCache.set(key, {
    embedding: [...embedding],
    expiresAt: Date.now() + DOCUMENT_EMBED_CACHE_TTL_MS
  });
  while (documentEmbeddingCache.size > DOCUMENT_EMBED_CACHE_MAX_ENTRIES) {
    const oldest = documentEmbeddingCache.keys().next().value;
    if (oldest === undefined) break;
    documentEmbeddingCache.delete(oldest);
  }
}

/** Test-only cache reset; production callers never need to clear exact document vectors manually. */
export function clearDocumentEmbeddingCacheForTest(): void {
  documentEmbeddingCache.clear();
}

const indexInitPromises = new Map<string, Promise<void>>();

function indexName(): string {
  return process.env.PINECONE_INDEX_NAME || DEFAULT_INDEX_NAME;
}

function indexReadyWaitMs(): number {
  const parsed = Number(process.env.PINECONE_INDEX_READY_WAIT_MS ?? 5000);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 5000;
}

export function numericEnv(name: string, fallback: number, min = 0, max = Number.POSITIVE_INFINITY): number {
  const parsed = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

/** Cosine-similarity floor applied at every retrieval call site unless the caller overrides it.
 *  Set VECTOR_MIN_SCORE=0 to disable the floor (restores the previous no-floor behavior). Default 0.30. */
export function defaultMinScore(): number {
  return numericEnv("VECTOR_MIN_SCORE", 0.3, 0, 1);
}

/**
 * Post-rerank relevance floor (2026-07-04 RAG quick-wins — "wire the dormant relevance-floor +
 * near-duplicate suppression stages"): `rankPool`/`RetrieveOptions.minRelevanceScore` have existed
 * since the 2026-07-01 backlog but no caller ever passed a value, so the Voyage cross-encoder floor
 * never ran in production. On rerank-2.5's relevance scale (distinct from Pinecone cosine `score`).
 * Set VECTOR_MIN_RELEVANCE_SCORE=0 to disable (restores pre-wiring behavior of no post-rerank
 * floor). Default 0.3 — the low end of the review's suggested 0.3-0.5 band, kept conservative so a
 * genuinely relevant chunk that reranks modestly isn't dropped before the floor is tuned on a
 * golden set.
 */
export function defaultRelevanceFloor(): number {
  return numericEnv("VECTOR_MIN_RELEVANCE_SCORE", 0.3, 0, 1);
}

/**
 * Near-duplicate suppression threshold (2026-07-04 RAG quick-wins, same item as
 * `defaultRelevanceFloor` above): `dedupeSimilar`/`RetrieveOptions.dedupeSimilarity` have existed
 * since the 2026-07-01 backlog but no caller ever passed a value, so the final top-K context could
 * be several near-identical restatements of one passage. Jaccard-shingle similarity (0-1); the
 * default is 0.6 per the review's suggested value.
 *
 * IMPORTANT: unlike `defaultMinScore`/`VECTOR_MIN_SCORE=0`, a threshold of literal `0` here is NOT
 * a safe "disable" value — `dedupeSimilar` treats `jaccardSimilarity(...) >= 0` as always true, so
 * threshold 0 would flag every subsequent non-empty chunk as a duplicate of the first one kept
 * (the opposite of disabling). Returns `undefined` — the actual "don't run dedup" sentinel
 * `RetrieveOptions.dedupeSimilarity`/`rankPool` already understand — when `VECTOR_DEDUPE_SIMILARITY`
 * resolves to <= 0, so an operator setting it to 0 to "turn dedup off" gets the behavior they
 * intended instead of a silently-broken threshold.
 */
export function defaultDedupeSimilarity(): number | undefined {
  const value = numericEnv("VECTOR_DEDUPE_SIMILARITY", 0.6, 0, 1);
  return value > 0 ? value : undefined;
}

function embedBatchSize(): number {
  return Math.floor(numericEnv("VECTOR_EMBED_BATCH_SIZE", DEFAULT_EMBED_BATCH_SIZE, 1, 128));
}

function embedBatchDelayMs(): number {
  return numericEnv("VECTOR_EMBED_BATCH_DELAY_MS", DEFAULT_EMBED_BATCH_DELAY_MS, 0);
}

function contextMaxChars(): number {
  return Math.floor(numericEnv("VECTOR_CONTEXT_MAX_CHARS", DEFAULT_CONTEXT_MAX_CHARS, 256));
}

/** Default OFF: retain legacy parent-text mapping until the bounded post-rerank path is enabled. */
function parentContextExpansionEnabled(): boolean {
  return envFlagOn("RAG_PARENT_CONTEXT_EXPANSION", true);
}

function parentContextMaxChars(): number {
  return Math.floor(numericEnv("RAG_PARENT_CONTEXT_MAX_CHARS", 6_000, 0));
}

function parentContextMaxTotalChars(): number {
  return Math.floor(numericEnv("RAG_PARENT_CONTEXT_MAX_TOTAL_CHARS", 12_000, 0));
}

function ingestBudgetEnabled(): boolean {
  // Server knob: Admin > Operations DB override > RAG_INGEST_BUDGET_ENABLED env > on.
  return serverKnobBool("RAG_INGEST_BUDGET_ENABLED");
}

function ingestMaxTextsPerDay(): number {
  const configured = Math.floor(numericEnv("RAG_INGEST_MAX_TEXTS_PER_DAY", DEFAULT_INGEST_MAX_TEXTS_PER_DAY, 1));
  return pineconeTrialState(Date.now(), pineconeMonthToDateWriteUnits()).effectiveTextsPerDay || configured;
}

function remainingIngestTexts(userId: string, requested: number): { allowed: number; used: number; limit: number } {
  const limit = ingestMaxTextsPerDay();
  if (!ingestBudgetEnabled()) return { allowed: requested, used: 0, limit };
  try {
    const sinceIso = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
    // Count embed texts across ANY embed provider, not just "voyage" — this budget caps embedding
    // VOLUME regardless of which provider serves it. It used to hardcode "voyage" only because
    // meterEmbed itself used to hardcode provider: "voyage" on every row (the very bug this PR
    // fixes); now that rows carry the true provider (openrouter/siliconflow/voyage), a "voyage"-only
    // filter would silently stop counting real usage the instant a non-Voyage provider goes active
    // (e.g. prod's OPENROUTER_API_KEY), making RAG_INGEST_MAX_TEXTS_PER_DAY effectively unenforced.
    const used = getRagUsageSummary({ sinceIso })
      .filter((row) => row.userId === userId && row.operation === "embed")
      .reduce((sum, row) => sum + row.batchCount, 0);
    return { allowed: Math.max(0, Math.min(requested, limit - used)), used, limit };
  } catch {
    // Tests mock db.ts without the usage table; fail open there instead of breaking vector mocks.
    return { allowed: requested, used: 0, limit };
  }
}

/** Whether the rolling-24h ingest text budget (RAG_INGEST_MAX_TEXTS_PER_DAY) has any headroom
 *  left for this user scope. Cheap pre-flight for bulk ingest loops (SEC filings): checking
 *  BEFORE fetching/chunking a document avoids downloading multi-MB filing bodies that
 *  storeDocument would only budget-skip — and avoids emitting one budget warning per doomed
 *  document. Fails open (true) when the budget is disabled or unreadable, mirroring
 *  remainingIngestTexts. */
export function hasIngestTextBudget(userId: string = "local"): boolean {
  return remainingIngestTexts(userId, 1).allowed > 0;
}

function pineconeWriteBudgetEnabled(): boolean {
  // Server knob: Admin > Operations DB override > RAG_PINECONE_WRITE_BUDGET_ENABLED env > on.
  return serverKnobBool("RAG_PINECONE_WRITE_BUDGET_ENABLED");
}

function pineconeMaxWriteUnitsPerDay(): number {
  const configured = Math.floor(numericEnv("RAG_PINECONE_MAX_WRITE_UNITS_PER_DAY", DEFAULT_PINECONE_WRITE_UNITS_PER_DAY, 1));
  return pineconeTrialState(Date.now(), pineconeMonthToDateWriteUnits()).effectiveDailyWriteUnits || configured;
}

/**
 * App-side rolling-24h write fuse copy.  This is not a Pinecone outage: retrieval stays up,
 * and new upserts resume as the 24h window rolls.  The configured cap is
 * RAG_PINECONE_MAX_WRITE_UNITS_PER_DAY (trial installs are often 2.5M).
 */
export const PINECONE_DAILY_WU_FUSE_RECOMMENDATION =
  "This is the app's rolling-24h write fuse, not a Pinecone outage.  Retrieval still works.  During a Standard trial the fuse stays at the configured trial cap unless remaining local-MTD credit is still in a plausible range; it will not collapse to a remainder smaller than one document.  After the trial it snaps to free-tier 60k WU/day.";

/** True when the daily write fuse still has room (or is disabled).  Fail-open like the text budget. */
export function hasPineconeWriteBudget(userId: string = "local"): boolean {
  if (usesQdrantWrites()) return true;
  if (!pineconeWriteBudgetEnabled()) return true;
  return usedPineconeWriteUnitsLast24h(userId) < pineconeMaxWriteUnitsPerDay();
}

async function notifyPineconeDailyWriteFuse(input: {
  userId: string;
  used: number;
  limit: number;
  requested: number;
  skipped: number;
  exceeded: boolean;
  leaseGuard?: VectorStoreLeaseGuard;
}): Promise<void> {
  const budgetPayload = {
    requestedEstimatedWriteUnits: input.requested,
    allowedEstimatedWriteUnits: Math.max(0, input.limit - input.used),
    skipped: input.skipped,
    usedLast24h: input.used,
    limitPer24h: input.limit
  };
  audit("vector_write_unit_budget", budgetPayload, input.userId);
  await settleRagSideEffect(alertUsageLimitHit({
    userId: input.userId,
    provider: "Pinecone",
    operation: "upsert-budget",
    limitName: "Write Unit daily fuse",
    status: input.exceeded ? "exceeded" : "warning",
    used: input.used,
    limit: input.limit,
    attempted: input.requested,
    skipped: input.skipped,
    unit: "estimated WUs",
    recommendation: PINECONE_DAILY_WU_FUSE_RECOMMENDATION
  }, {
    assertActive: input.leaseGuard ? () => assertVectorStoreLease(input.leaseGuard) : undefined,
    signal: input.leaseGuard?.signal
  }), input.leaseGuard);
  if (shouldEmitPineconeWuBudgetSentry()) {
    await settleRagSideEffect(captureRagSentryMessage("warning", "Pinecone write unit budget reached", {
      provider: "pinecone",
      operation: "upsert-budget",
      source: input.userId === "local" ? "operator" : "user",
      requestedEstimatedWriteUnits: input.requested,
      allowedEstimatedWriteUnits: budgetPayload.allowedEstimatedWriteUnits,
      skipped: input.skipped,
      usedLast24h: input.used,
      limitPer24h: input.limit
    }, input.leaseGuard), input.leaseGuard);
  }
}

function usedPineconeWriteUnitsLast24h(userId: string): number {
  if (!pineconeWriteBudgetEnabled()) return 0;
  try {
    const sinceIso = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
    return getRagUsageSummary({ sinceIso })
      .filter((row) => row.userId === userId && row.provider === "pinecone" && row.operation === "upsert")
      .reduce((sum, row) => {
        // New rows store estimated WUs in tokensIn. Older rows only stored record count in
        // tokensOut; charge them at 5 WUs/record so legacy history still throttles runaway writes.
        return sum + (row.tokensIn > 0 ? row.tokensIn : row.tokensOut * 5);
      }, 0);
  } catch {
    // Tests mock db.ts without the usage table; fail open there instead of breaking vector mocks.
    return 0;
  }
}

function estimatePineconeRecordWriteUnits(bytes: number): number {
  return Math.max(1, Math.ceil(bytes / 1024));
}

function pineconeMetadataBytes(metadata: RecordMetadata): number {
  return Buffer.byteLength(JSON.stringify(metadata), "utf8");
}

/** Pinecone hard cap per vector. Production upserts 2 bytes over this (40962 > 40960) page as "connection failed". */
export const PINECONE_METADATA_HARD_LIMIT_BYTES = 40_960;
/** Stay under the hard cap so JSON escape/key-order drift cannot bounce the write. */
export const PINECONE_METADATA_SOFT_LIMIT_BYTES = 40_896;

function truncateUtf8Bytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (Buffer.byteLength(text.slice(0, mid), "utf8") <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo);
}

const PINECONE_METADATA_IDENTITY_KEYS = new Set([
  "symbol",
  "source",
  "timestamp",
  "userId",
  "scope",
  "tenant_scope",
  "provider_authority",
  "ledger_authority",
  "embed_model",
  "embed_rev",
  "accession",
  "doc_type",
  "ingest_state",
  "receipt_required",
  "as_of_epoch_ms"
]);

/** Trim metadata.text (then other non-identity strings) so an upsert stays under Pinecone's 40960-byte cap. */
export function enforcePineconeMetadataLimit(metadata: RecordMetadata): RecordMetadata {
  if (pineconeMetadataBytes(metadata) <= PINECONE_METADATA_SOFT_LIMIT_BYTES) return metadata;
  const out: Record<string, unknown> = { ...metadata };
  const text = typeof out.text === "string" ? out.text : "";
  if (text) {
    const overhead = pineconeMetadataBytes(out as RecordMetadata) - Buffer.byteLength(text, "utf8");
    out.text = truncateUtf8Bytes(text, Math.max(0, PINECONE_METADATA_SOFT_LIMIT_BYTES - overhead));
  }
  if (pineconeMetadataBytes(out as RecordMetadata) <= PINECONE_METADATA_SOFT_LIMIT_BYTES) {
    return out as RecordMetadata;
  }
  const droppable = Object.entries(out)
    .filter(([key, value]) => key !== "text" && !PINECONE_METADATA_IDENTITY_KEYS.has(key) && typeof value === "string")
    .sort((a, b) => Buffer.byteLength(String(b[1]), "utf8") - Buffer.byteLength(String(a[1]), "utf8"));
  for (const [key] of droppable) {
    delete out[key];
    if (pineconeMetadataBytes(out as RecordMetadata) <= PINECONE_METADATA_SOFT_LIMIT_BYTES) break;
  }
  return out as RecordMetadata;
}

function embedRetryAttempts(): number {
  return Math.floor(numericEnv("VECTOR_EMBED_RETRY_ATTEMPTS", DEFAULT_EMBED_RETRY_ATTEMPTS, 0, 5));
}

function embedRetryDelayMs(): number {
  return numericEnv("VECTOR_EMBED_RETRY_DELAY_MS", DEFAULT_EMBED_RETRY_DELAY_MS, 0);
}

function erasureVerifyAttempts(): number {
  return Math.floor(numericEnv(
    "VECTOR_ERASURE_VERIFY_ATTEMPTS",
    DEFAULT_ERASURE_VERIFY_ATTEMPTS,
    1,
    10
  ));
}

function erasureVerifyConsecutiveClean(attempts: number): number {
  return Math.min(attempts, Math.floor(numericEnv(
    "VECTOR_ERASURE_VERIFY_CONSECUTIVE_CLEAN",
    DEFAULT_ERASURE_VERIFY_CONSECUTIVE_CLEAN,
    1,
    10
  )));
}

function erasureVerifyDelayMs(): number {
  return numericEnv(
    "VECTOR_ERASURE_VERIFY_DELAY_MS",
    DEFAULT_ERASURE_VERIFY_DELAY_MS,
    0,
    30_000
  );
}

// Cross-encoder reranking is the largest post-recall quality lever. It remains opt-out for backward
// compatibility, while route/model selection and candidate depth are resolved independently.
function rerankEnabled(): boolean {
  // Rerank is opt-OUT (default true), unlike every other RAG flag which is opt-in (default
  // false) — so this can't route through envFlagOn's truthy-set/default_ shape directly. Keep
  // its own off-set check, but reuse envFlagOn's accepted vocabulary so "off"/"no"/"false"/"0"
  // stay consistent across every RAG flag in this file.
  const v = String(process.env.VECTOR_ENABLE_RERANK ?? "true").trim().toLowerCase();
  return !["0", "false", "off", "no"].includes(v);
}
/** How many candidates to pull from Pinecone before as-of filtering (non-rerank path) down to `limit`. */
function overFetchK(limit: number): number {
  return Math.min(Math.max(limit * 5, limit), 50);
}

const RERANK_MAX_DOCUMENTS = 1_000;

interface CandidatePoolObservability {
  providerCandidateCount: number;
  visibleCandidateCount: number;
  receiptEligibleCount: number;
  receiptCrowdingDegraded: boolean;
  tierByCandidateIdentity: Map<any, number>;
}

function uniqueTierCandidateCount(tiers: any[][]): number {
  const ids = new Set<string>();
  const idless = new Set<any>();
  for (const tier of tiers) {
    for (const match of tier) {
      const id = typeof match?.id === "string" && match.id.length > 0 ? match.id : undefined;
      if (id) ids.add(id);
      else idless.add(match);
    }
  }
  return ids.size + idless.size;
}

function candidatePoolIdentity(match: any): string | object {
  return typeof match?.id === "string" && match.id.length > 0 ? match.id : match;
}

/**
 * Deduplicate several independently bounded provider tiers without allowing their union to exceed
 * Voyage's rerank request limit. When a cap is needed, rank-round-robin preserves quota from every
 * non-empty tier; selected candidates are then restored to global cosine order for fail-open fallback.
 */
function boundedTierCandidateUnion(
  tiers: any[][],
  maxDocuments: number,
  rankScore: (match: any) => number = (match) => Number(match?.score) || 0
): any[] {
  const compareRank = (a: any, b: any) => rankScore(b) - rankScore(a);
  const sortedTiers = tiers.map((tier) => [...tier].sort(compareRank));
  const globallySorted = sortedTiers.flat().sort(compareRank);
  const bestById = new Map<string, any>();
  const unique: any[] = [];
  const idlessSeen = new Set<any>();
  for (const match of globallySorted) {
    const id = typeof match?.id === "string" && match.id.length > 0 ? match.id : undefined;
    if (id) {
      if (bestById.has(id)) continue;
      bestById.set(id, match);
      unique.push(match);
    } else if (!idlessSeen.has(match)) {
      idlessSeen.add(match);
      unique.push(match);
    }
  }
  if (unique.length <= maxDocuments) return unique;

  const cursors = sortedTiers.map(() => 0);
  const selected: any[] = [];
  const selectedIds = new Set<string>();
  const selectedIdless = new Set<any>();
  while (selected.length < maxDocuments) {
    let progressed = false;
    for (let tierIndex = 0; tierIndex < sortedTiers.length && selected.length < maxDocuments; tierIndex++) {
      const tier = sortedTiers[tierIndex]!;
      while (cursors[tierIndex]! < tier.length) {
        const match = tier[cursors[tierIndex]!]!;
        cursors[tierIndex] = cursors[tierIndex]! + 1;
        const id = typeof match?.id === "string" && match.id.length > 0 ? match.id : undefined;
        if (id) {
          if (selectedIds.has(id)) continue;
          selectedIds.add(id);
          selected.push(bestById.get(id) ?? match);
        } else {
          if (selectedIdless.has(match)) continue;
          selectedIdless.add(match);
          selected.push(match);
        }
        progressed = true;
        break;
      }
    }
    if (!progressed) break;
  }
  return selected.sort(compareRank);
}

/** Hybrid dense+BM25 retrieval via Reciprocal Rank Fusion. OFF by default — set HYBRID_RETRIEVAL=on to enable.
 *  When OFF, the retrieval path is byte-for-byte the current dense-only flow. */
function hybridRetrievalEnabled(): boolean {
  return envFlagOn("HYBRID_RETRIEVAL", false);
}

/** Independent FTS5 recall across the persisted filing corpus. Default off until eval promotion. */
function corpusWideLexicalRetrievalEnabled(): boolean {
  return envFlagOn("RAG_CORPUS_WIDE_LEXICAL", true);
}

function retrievalStageTelemetryEnabled(): boolean {
  return envFlagOn("RAG_RETRIEVAL_STAGE_TELEMETRY", true);
}

/**
 * R1 strict as-of mode (2026-07-01 expert-review follow-up, item R1 part 2). OFF by default — set
 * VECTOR_ASOF_STRICT=on to enable. When ON *and* the caller passed `options.asOf`, the retrieval
 * pipeline DROPS chunks with no resolvable date stamp (after the acceptance_datetime ->
 * published_at -> as_of -> timestamp chain `isWithinAsOf` already resolves) instead of the lenient
 * default of keeping them. Never changes behavior when `asOf` is unset (the chat default — no
 * point-in-time guard active at all) or when this flag is off, so default retrieval is unaffected.
 */
export function asOfStrictEnabled(): boolean {
  return envFlagOn("VECTOR_ASOF_STRICT", false);
}

/**
 * server-asof-filter (2026-07-06): push the point-in-time (`asOf`) constraint INTO the Pinecone
 * query so `topK` is filled with ELIGIBLE (pre-asOf) candidates, instead of the current behavior
 * where the pure-vector top-K is dominated by too-recent filings that the POST-fetch `isWithinAsOf`
 * guard then decimates — leaving a tiny/empty pool in a backtest even though the correct older
 * filings exist in the corpus (ranked below the fetch window).
 *
 * ON by default (owner enablement 2026-07-24) — set VECTOR_ASOF_SERVER_FILTER=off to disable. It is safe
 * to leave on at any time on
 * the DEFAULT (fail-open) semantics because the server clause keeps un-epoch'd vectors (see
 * `buildAsOfEpochFilter`), so an un-backfilled corpus is NOT dropped; running the backfill first
 * just makes the topK-fill improvement effective for older vectors too. When OFF, the retrieval
 * path is byte-for-byte the current post-fetch-only behavior.
 *
 * DEFENSE IN DEPTH: this NEVER removes the post-fetch `isWithinAsOf` guard in `rankPool` — that
 * stays the authoritative leakage gate regardless of this flag. Server filtering only pre-fills a
 * better candidate pool; the post-fetch guard is what actually enforces no-lookahead.
 */
export function asOfServerFilterEnabled(): boolean {
  return envFlagOn("VECTOR_ASOF_SERVER_FILTER", true);
}

/**
 * server-asof-filter (2026-07-06): build the Pinecone metadata-filter clause that pushes the `asOf`
 * epoch constraint server-side. Returns `undefined` when it should add NO clause (asOf unset/
 * unparseable, or the server-filter flag off) so the caller's existing filter is byte-identical to
 * today. Otherwise returns a single clause to AND-combine with the existing docType/symbol/scope
 * filter.
 *
 * Semantics (owner-approved):
 *  - FAIL-OPEN (default, `strict=false`): keep epoch'd-AND-eligible vectors OR vectors LACKING the
 *    epoch field, via `$or: [{as_of_epoch_ms: {$lte: X}}, {as_of_epoch_ms: {$exists: false}}]`, so
 *    an un-backfilled/undated corpus is NOT dropped server-side. The post-fetch `isWithinAsOf` guard
 *    remains the real leakage gate. `$exists` is a documented Pinecone metadata operator; the JS
 *    client (v8) types `filter` as an opaque `object` and forwards it verbatim, so this composes
 *    cleanly (verified in node_modules — see the server-asof-filter rollout note).
 *  - FAIL-CLOSED (`strict=true`, VECTOR_ASOF_STRICT on): drop un-epoch'd vectors server-side with a
 *    plain `{as_of_epoch_ms: {$lte: X}}` (no `$exists` branch) — only epoch'd-and-eligible return.
 *    Composes with the existing post-fetch strict undated-drop for leakage-certified backtests.
 */
export function buildAsOfEpochFilter(asOf: string | undefined, strict: boolean): Record<string, unknown> | undefined {
  if (!asOf || !asOfServerFilterEnabled()) return undefined;
  const asOfMs = Date.parse(asOf);
  if (!Number.isFinite(asOfMs)) return undefined; // unparseable asOf -> no server constraint (matches isWithinAsOf's lenient short-circuit)
  const eligible = { [AS_OF_EPOCH_FIELD]: { $lte: asOfMs } };
  if (strict) return eligible; // fail-closed: epoch'd-and-eligible only
  // fail-open: epoch'd-and-eligible OR un-epoch'd (absent field)
  return { $or: [eligible, { [AS_OF_EPOCH_FIELD]: { $exists: false } }] };
}

/**
 * server-asof-filter (2026-07-06): AND-combine a base Pinecone metadata filter with the optional
 * server-side `asOf` epoch clause. Returns the base UNCHANGED (same object) when there is no epoch
 * clause, so a call with `epoch === undefined` is byte-identical to not calling this at all.
 *
 * When an epoch clause IS present it merges via `$and: [base, epoch]` rather than spreading epoch's
 * keys onto the base. This is REQUIRED for correctness, not stylistic: the fail-open epoch clause is
 * itself `{$or: [...]}`, and the shared-tier base filter ALSO carries a top-level `$or` (scope/userId
 * coexistence) — a spread would silently drop one `$or` (a JS object can't hold two identical keys),
 * changing which vectors match. `$and` keeps both intact and is the documented Pinecone way to
 * combine independent constraints. The base is not mutated (a fresh object is returned).
 */
export function mergeAsOfEpoch(
  base: Record<string, unknown>,
  epoch: Record<string, unknown> | undefined
): Record<string, unknown> {
  if (!epoch) return base;
  return { $and: [base, epoch] };
}

/**
 * Every query excludes managed pending records at Pinecone. Legacy records are admitted only when
 * the receipt marker is absent; direct new records explicitly carry receipt_required=false.
 */
export function withCommittedVectorFilter(base: Record<string, unknown>): Record<string, unknown> {
  return {
    $and: [
      base,
      {
        $or: [
          { receipt_required: { $exists: false } },
          { receipt_required: { $eq: false } },
          { ingest_state: { $eq: "committed" } }
        ]
      }
    ]
  };
}

/**
 * R17 (2026-07-01 RAG backlog): fix train/serve text skew. `storeContexts` embeds a literal
 * `[Published: ...]` prefix (and `storeDocument` bakes a `context_header` into stored text), but
 * the QUERY embedding is the raw query with none of that boilerplate — a systematic query/document
 * skew in Voyage's embedding space that dilutes what the cosine floor actually measures.
 *
 * When ON, `storeContexts` embeds CLEAN text (provenance boilerplate stripped) while the STORED
 * metadata text (used for citations/display) is unchanged — `matchToChunk` already reads
 * `acceptance_datetime`/`timestamp` from metadata directly, so no retrieval-side behavior depends
 * on the boilerplate being embedded.
 *
 * Default OFF: flipping this changes the embedding-space representation of every NEWLY-indexed
 * vector, so it invalidates direct comparability against vectors indexed before the flag was
 * enabled (a full reindex is the clean way to move the whole corpus onto one representation —
 * see the rollout note for the decision on transitional mixed-representation vs scheduled reindex).
 */
export function embedCleanTextEnabled(): boolean {
  // Settings override → Infisical/env → catalog default. Fail-open to env if the
  // settings store is unavailable so embed writes never throw from a knob read.
  return resolveSourceBool("VECTOR_EMBED_CLEAN_TEXT");
}

/**
 * Strip the `[Published: YYYY-MM-DD] ` boilerplate prefix `storeContexts` prepends, if present.
 * Pure string operation — used ONLY to build the text handed to Voyage for embedding when
 * `VECTOR_EMBED_CLEAN_TEXT` is on; the stored/cited text is never modified by this.
 */
export function stripPublishedPrefix(text: string): string {
  return text.replace(/^\[Published: \d{4}-\d{2}-\d{2}\]\s*/, "");
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error("Operation aborted."));
  }
  if (ms <= 0) return Promise.resolve();
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener("abort", aborted);
      resolve();
    }
    function aborted() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", aborted);
      reject(signal?.reason instanceof Error ? signal.reason : new Error("Operation aborted."));
    }
    signal.addEventListener("abort", aborted, { once: true });
  });
}

/**
 * Sanitizes user IDs to prevent injection attacks and ensure query stability.
 * Allows alphanumeric, dashes, underscores, dots, and '@'. Caps at 100 characters.
 */
export function sanitizeUserId(userId?: string): string {
  if (!userId) return "local";
  const sanitized = userId.trim().replace(/[^a-zA-Z0-9_\-.@]/g, "");
  if (!sanitized) return "local";
  return sanitized.slice(0, 100);
}

/**
 * Ensures we have valid clients for Pinecone. Clients are memoized per resolved
 * key (not per userId, so a key rotation naturally yields a fresh client) to avoid
 * constructing a new SDK client on every call.
 */
const pineconeClientCache = new Map<string, Pinecone>();

/**
 * Non-secret identity of the physical Pinecone index currently in use. The preferred input is the
 * provider-reported index host, which survives API-key rotation while still distinguishing two
 * projects that happen to use the same index name. Managed writes require this stable identity;
 * the key-derived fallback is restricted to direct, unreceipted records and is never persisted as
 * managed physical ownership.
 */
const indexAuthorityByInitKey = new Map<string, string>();

function hashProviderAuthority(identity: string): string {
  return crypto.createHash("sha256").update(`pinecone-index-authority:v1|${identity}`, "utf8").digest("hex");
}

function fallbackProviderAuthority(initCacheKey: string): string {
  return hashProviderAuthority(`fallback|${initCacheKey}`);
}

function rememberProviderAuthority(initCacheKey: string, describedIndex: unknown): string {
  const host = typeof (describedIndex as { host?: unknown } | undefined)?.host === "string"
    ? (describedIndex as { host: string }).host.trim().toLowerCase()
    : "";
  if (!host && process.env.NODE_ENV !== "test") {
    throw new Error("Pinecone describeIndex did not return a stable index host.");
  }
  // Lightweight unit doubles historically omitted `host`. Production managed writes still fail
  // closed above; tests get a deterministic nonsecret authority so they exercise the remaining
  // commit path without embedding fake provider topology in every unrelated fixture.
  const authority = host
    ? hashProviderAuthority(`host|${host}|index|${indexName()}`)
    : fallbackProviderAuthority(initCacheKey);
  indexAuthorityByInitKey.set(initCacheKey, authority);
  return authority;
}

function providerAuthorityForInitKey(initCacheKey: string): string {
  return indexAuthorityByInitKey.get(initCacheKey) ?? fallbackProviderAuthority(initCacheKey);
}

function stableProviderAuthorityForInitKey(initCacheKey: string): string | undefined {
  return indexAuthorityByInitKey.get(initCacheKey);
}

/**
 * Immutable, non-PII identity for this SQLite vector ledger. Managed vectors live in the matching
 * Pinecone namespace and carry the same authority in their id/metadata, so a shared BYOK index can
 * never make this deployment's reconciler claim another application's records.
 */
export function managedVectorLedgerAuthority(): string {
  try {
    const database = dbModule.getDb();
    if (!database) throw new Error("Vector ledger database is unavailable.");
    return database.transaction(() => {
      const readAuthority = (value: string | undefined): string | undefined => {
        try {
          const parsed = JSON.parse(value ?? "");
          return typeof parsed === "string" && parsed.startsWith("ledger:v1:") && parsed.length > 20
            ? parsed
            : undefined;
        } catch {
          return undefined;
        }
      };
      const existing = database.prepare("SELECT value FROM settings WHERE key = ?")
        .get(MANAGED_VECTOR_LEDGER_SETTING) as { value?: string } | undefined;
      const authorities = new Set<string>();
      const commitRows = database.prepare(`
        SELECT DISTINCT ledger_authority
        FROM vector_ingest_commits
        WHERE ledger_authority IS NOT NULL AND TRIM(ledger_authority) <> ''
      `).all() as Array<{ ledger_authority: string }>;
      for (const row of commitRows) authorities.add(row.ledger_authority);
      const manifestRows = database.prepare(`
        SELECT DISTINCT ledger_authority FROM vector_private_namespace_manifests
      `).all() as Array<{ ledger_authority: string }>;
      for (const row of manifestRows) authorities.add(row.ledger_authority);
      if (authorities.size > 1) {
        throw new Error("Managed vector ledger authority is ambiguous; refusing namespace rotation.");
      }
      if (existing) {
        const parsed = readAuthority(existing.value);
        if (!parsed) {
          throw new Error("Managed vector ledger authority is corrupt; refusing namespace rotation.");
        }
        if (authorities.size === 1 && !authorities.has(parsed)) {
          throw new Error("Managed vector ledger authority conflicts with persisted vector evidence.");
        }
        return parsed;
      }
      // Only authority-bearing evidence may block first-authority minting. `legacy_committed`
      // occurrences predate the managed ledger entirely: they live in the provider's default
      // namespace, carry no ledger_authority, and are never claimed by the reconciler — so a
      // deployment upgrading with years of legacy RAG data must still be able to mint. Counting
      // them here wedged production permanently (every retrieval AND every ingest resolves the
      // authority, so nothing could ever create the first commit): 2026-07-15 RAG outage.
      const localEvidence = database.prepare(`
        SELECT
          (SELECT COUNT(*) FROM vector_ingest_commits) +
          (SELECT COUNT(*) FROM chunk_occurrences WHERE receipt_state <> 'legacy_committed') +
          (SELECT COUNT(*) FROM vector_private_namespace_manifests) AS count
      `).get() as { count: number };
      const recovered = [...authorities][0];
      if (!recovered && localEvidence.count > 0) {
        throw new Error("Managed vector ledger authority is missing while vector evidence exists.");
      }
      const candidate = recovered ?? `ledger:v1:${crypto.randomUUID()}`;
      const now = new Date().toISOString();
      // INSERT OR IGNORE is the cross-process winner election. A second process never overwrites
      // the first authority after both observed an empty table; it reads the durable winner below.
      database.prepare(`
        INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?, ?, ?)
      `).run(MANAGED_VECTOR_LEDGER_SETTING, JSON.stringify(candidate), now);
      const row = database.prepare("SELECT value FROM settings WHERE key = ?")
        .get(MANAGED_VECTOR_LEDGER_SETTING) as { value?: string } | undefined;
      const parsed = readAuthority(row?.value);
      if (parsed) return parsed;
      throw new Error("Managed vector ledger authority is missing or corrupt.");
    })();
  } catch (error) {
    // A few isolated unit suites intentionally replace the DB barrel with a tiny mock. Production
    // must never mint an ephemeral authority, but those tests may use one deterministic seam.
    if (process.env.NODE_ENV === "test") return "ledger:v1:test-only-authority";
    throw error;
  }
}

export function managedVectorNamespace(): string {
  return `socratic-${managedOccurrenceToken(managedVectorLedgerAuthority())}`;
}

export function privateVectorNamespace(
  userId: string,
  ledgerAuthority = managedVectorLedgerAuthority()
): string {
  return `socratic-private-${managedOccurrenceToken(ledgerAuthority)}-${managedOccurrenceToken(vectorTenantScope(userId, PRIVATE_SCOPE))}`;
}

function ensurePrivateVectorNamespaceManifest(
  userId: string,
  ledgerAuthority: string,
  providerAuthority: string
): void {
  const tenantScope = vectorTenantScope(userId, PRIVATE_SCOPE);
  const database = dbModule.getDb();
  const now = new Date().toISOString();
  database.transaction(() => {
    database.prepare(`
      INSERT OR IGNORE INTO vector_private_namespace_manifests
        (tenant_scope, ledger_authority, provider_authority, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(tenantScope, ledgerAuthority, providerAuthority, now, now);
    const row = database.prepare(`
      SELECT ledger_authority, provider_authority
      FROM vector_private_namespace_manifests WHERE tenant_scope = ?
    `).get(tenantScope) as { ledger_authority?: string; provider_authority?: string | null } | undefined;
    if (row?.ledger_authority !== ledgerAuthority || row.provider_authority !== providerAuthority) {
      throw new Error("Private vector namespace manifest authority mismatch.");
    }
  }).immediate();
}

export function fmpTranscriptVectorNamespace(ledgerAuthority = managedVectorLedgerAuthority()): string {
  return `socratic-fmp-transcripts-${managedOccurrenceToken(ledgerAuthority)}`;
}

function hasCommittedManagedRecords(): boolean {
  try {
    return Boolean(dbModule.getDb().prepare(`
      SELECT 1 AS ok
      FROM vector_ingest_commits
      WHERE state = 'committed'
      LIMIT 1
    `).get());
  } catch {
    // Retrieval must stay available during migrations and in lightweight module mocks. A false
    // result only skips the additive managed-namespace query; legacy/direct retrieval still runs.
    return false;
  }
}

function hasCommittedVectorNamespaceRecords(
  ledgerAuthority: string,
  vectorNamespace: "managed" | "fmp-transcripts"
): boolean {
  try {
    return Boolean(dbModule.getDb().prepare(`
      SELECT 1 AS ok
      FROM vector_ingest_commits
      WHERE state = 'committed' AND ledger_authority = ? AND vector_namespace = ?
      LIMIT 1
    `).get(ledgerAuthority, vectorNamespace));
  } catch {
    return false;
  }
}

function hasCurrentPrivateVectorNamespaceRecords(
  userId: string,
  ledgerAuthority: string,
  providerAuthority: string | undefined
): boolean {
  if (!providerAuthority) return false;
  try {
    return Boolean(dbModule.getDb().prepare(`
      SELECT 1 AS ok
      FROM vector_private_namespace_manifests WHERE tenant_scope = ?
        AND ledger_authority = ? AND provider_authority = ?
      LIMIT 1
    `).get(vectorTenantScope(userId, PRIVATE_SCOPE), ledgerAuthority, providerAuthority));
  } catch {
    return false;
  }
}

function hasUnreachableCommittedManagedRecords(
  ledgerAuthority: string,
  providerAuthority: string | undefined
): boolean {
  try {
    return Boolean(dbModule.getDb().prepare(`
      SELECT 1 AS ok
      FROM vector_ingest_commits
      WHERE state = 'committed'
        AND (
          ledger_authority IS NULL OR ledger_authority <> ? OR
          provider_authority IS NULL OR provider_authority <> ?
        )
      LIMIT 1
    `).get(ledgerAuthority, providerAuthority ?? ""));
  } catch {
    return false;
  }
}

function resolveRagKeyWithSource(service: "pinecone" | RagEmbedRerankProvider, userId: string): { key?: string; source: ApiKeySource; envVar?: string; service: string } {
  let sourceAwareResolver: ((service: string, userId?: string) => { key?: string; source: ApiKeySource; envVar?: string; service: string }) | undefined;
  try {
    const candidate = (dbModule as Record<string, unknown>).resolveApiKeyWithSource;
    if (typeof candidate === "function") sourceAwareResolver = candidate as typeof sourceAwareResolver;
  } catch {
    // Older isolated tests mock only resolveApiKey; fall through to the legacy resolver.
  }
  if (sourceAwareResolver) return sourceAwareResolver(service, userId);
  const key = resolveApiKey(service, userId);
  return { key, source: key ? "env" : "none", service };
}

export async function getClients(
  userId: string = "local",
  leaseGuard?: VectorStoreLeaseGuard,
  options?: { skipMissingPineconeAlert?: boolean }
) {
  assertVectorStoreLease(leaseGuard);
  const lookupUserId = userId || "local";
  const pinecone = resolveRagKeyWithSource("pinecone", lookupUserId);
  const pineconeKey = pinecone.key;

  const activeEmbed = activeEmbeddingProvider(lookupUserId);
  const voyageRes = resolveRagKeyWithSource(activeEmbed, lookupUserId);
  const voyageKey: string | undefined = voyageRes.key;
  const voyageSource: ApiKeySource = voyageRes.source;
  let voyage: any = null;

  if (process.env.NODE_ENV === "test") {
    if (voyageKey) {
      try {
        const mod = await import("voyageai" as any);
        if (mod && mod.VoyageAIClient) {
          voyage = new mod.VoyageAIClient({ apiKey: voyageKey });
        }
      } catch {
        // ignore
      }
    }
  }

  if (!pineconeKey) {
    if (!options?.skipMissingPineconeAlert) {
      if (leaseGuard) {
        await recordMissingRagKey("pinecone", pinecone.source, lookupUserId, pinecone.envVar, leaseGuard);
        assertVectorStoreLease(leaseGuard);
      } else {
        void recordMissingRagKey("pinecone", pinecone.source, lookupUserId, pinecone.envVar).catch(() => {});
      }
    }
    return { pc: null, voyage, initCacheKey: "", pineconeSource: pinecone.source, voyageSource };
  }

  let pc = pineconeClientCache.get(pineconeKey);
  if (!pc) {
    assertVectorStoreLease(leaseGuard);
    pc = new Pinecone({ apiKey: pineconeKey });
    pineconeClientCache.set(pineconeKey, pc);
  }

  return {
    pc,
    voyage,
    initCacheKey: `${pineconeKey}:${indexName()}`,
    pineconeSource: pinecone.source,
    voyageSource
  };
}

/** Provider-only operations such as inventory and erasure must not require an unrelated Voyage key. */
async function getPineconeClient(userId: string = "local", leaseGuard?: VectorStoreLeaseGuard) {
  assertVectorStoreLease(leaseGuard);
  const lookupUserId = userId || "local";
  const pinecone = resolveRagKeyWithSource("pinecone", lookupUserId);
  if (!pinecone.key) {
    if (leaseGuard) {
      await recordMissingRagKey("pinecone", pinecone.source, lookupUserId, pinecone.envVar, leaseGuard);
      assertVectorStoreLease(leaseGuard);
    } else {
      void recordMissingRagKey("pinecone", pinecone.source, lookupUserId, pinecone.envVar).catch(() => {});
    }
    return { pc: null, initCacheKey: "", pineconeSource: pinecone.source };
  }
  let pc = pineconeClientCache.get(pinecone.key);
  if (!pc) {
    pc = new Pinecone({ apiKey: pinecone.key });
    pineconeClientCache.set(pinecone.key, pc);
  }
  return { pc, initCacheKey: `${pinecone.key}:${indexName()}`, pineconeSource: pinecone.source };
}

function ragHealthUserId(source: ApiKeySource, userId: string): string {
  return source === "user" ? sanitizeUserId(userId) : "local";
}

function ragErrorMessage(error: unknown): string {
  // Walk nested causes so PineconeConnectionError("Request failed to reach Pinecone…")
  // still classifies when the inner TypeError is `fetch failed` (Codex P1 on #3195).
  const walked = describeNetworkError(error).trim();
  if (walked) return walked;
  return error instanceof Error ? error.message : String(error);
}

export type RagLimitStatus = "rate_limited" | "billing" | "quota" | "transient";

/**
 * Classify a provider error for alerting.
 * Engine-overloaded 429s are transient capacity, not our usage cap — check that before generic 429.
 *
 * Deliberately does NOT classify `fetch failed` / `UND_ERR_SOCKET` as "transient" here: those are
 * transport blips owned by `isTransientNetworkErrorText` + alertRagConnectionFailure's escalation
 * window. Mapping them here soft-stamped the health row and returned before escalation (Codex P1
 * on #3195), so a persistent outage in the primary Node/undici shapes never reached error.
 */
export function ragLimitStatus(message: string): RagLimitStatus | undefined {
  if (/overloaded|engine is currently|terminated/i.test(message)) return "transient";
  if (/\b429\b|rate limit|too many requests|RPM|TPM/i.test(message)) return "rate_limited";
  if (/billing|payment|invoice|past due|upgrade|plan/i.test(message)) return "billing";
  if (/quota|write units?|read units?|usage limit|capacity|exceeded|paused/i.test(message)) return "quota";
  return undefined;
}

export type EmbedFailureClass = "permanent" | "transient";

/**
 * Classify a raw embed/store failure message so a producer (SEC ingest worker) can decide
 * retryable-vs-dead-letter instead of collapsing every non-complete storeDocument result into a
 * generic "budget exceeded" bucket that then gets blindly requeued forever (2026-08-23 P0: dead
 * letters filled with permanently-failing 400s masked as a budget problem, while Sentry
 * separately buried the real signal — see shouldEmitRagIngestBudgetSentry above).
 *
 * A 429 is capacity/pacing, not a rejected request — transient, worth a bounded retry. 408
 * (Request Timeout) is also transient: the provider never actually evaluated the request, so a
 * retry is not "byte-identical content that can never succeed" the way a 400 is. Any OTHER 4xx
 * means the provider rejected the request itself (bad payload, auth, size, not-found): retrying
 * byte-identical content can never succeed, so it is permanent. Everything else (5xx, timeouts,
 * connection resets, unrecognized shapes) defaults to transient: the existing
 * stage_attempts/max_stage_attempts ceiling already bounds a wrong "retry" guess, while a wrong
 * "permanent" guess would dead-letter a possibly-recoverable document on one bad read.
 */
export function classifyEmbedFailure(message: string): EmbedFailureClass {
  if (/\b429\b/.test(message)) return "transient";
  if (/\b408\b/.test(message)) return "transient";
  if (/\b4\d\d\b/.test(message)) return "permanent";
  return "transient";
}

function markRagSentryCaptured(error: unknown): void {
  if (!error || (typeof error !== "object" && typeof error !== "function")) return;
  try {
    Object.defineProperty(error, "__ragSentryCaptured", {
      value: true,
      configurable: true
    });
  } catch {
    try {
      (error as { __ragSentryCaptured?: boolean }).__ragSentryCaptured = true;
    } catch {
      // best-effort marker only
    }
  }
}

function wasRagSentryCaptured(error: unknown): boolean {
  return Boolean((error as { __ragSentryCaptured?: boolean } | undefined)?.__ragSentryCaptured);
}

async function recordMissingRagKey(
  service: "pinecone" | "voyage" | "openrouter" | "siliconflow",
  source: ApiKeySource,
  userId: string,
  envVar?: string,
  leaseGuard?: VectorStoreLeaseGuard
): Promise<void> {
  assertVectorStoreLease(leaseGuard);
  const message = envVar ? `${envVar} is not configured` : `${service} API key is not configured`;
  const targetUserId = ragHealthUserId(source, userId);
  assertVectorStoreLease(leaseGuard);
  logApiHealth({
    service,
    ok: false,
    errorText: message,
    keySource: source,
    userId: targetUserId
  });
  assertVectorStoreLease(leaseGuard);
  await alertRagConnectionFailure(
    service as any,
    source,
    targetUserId,
    "configuration",
    message,
    leaseGuard
  );
  assertVectorStoreLease(leaseGuard);
}

// Display names for the alert title/payload when the ACTIVE provider is known (the "rag-embed"/
// "rag-rerank" lanes below) — distinct from the health-log `service` identifier itself.
const RAG_PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  voyage: "Voyage",
  openrouter: "OpenRouter",
  siliconflow: "SiliconFlow"
};

async function alertRagConnectionFailure(
  // "voyage"/"voyage-rerank" remain valid inputs for back-compat (recordMissingRagKey's
  // missing-API-key path still reports under the literal "voyage" service, unrelated to this rename
  // — see its call site). "rag-embed"/"rag-rerank" are the provider-generic lanes withRagApiHealth
  // now uses for actual embed/rerank call failures (added 2026-07-19) — pass `activeProvider`
  // alongside them so the title/payload still say which vendor is actually behind the failure.
  service: "pinecone" | "voyage" | "voyage-rerank" | "rag-embed" | "rag-rerank" | "openrouter" | "openrouter-rerank" | "siliconflow" | "siliconflow-rerank",
  source: ApiKeySource,
  targetUserId: string,
  operation: string,
  message: string,
  leaseGuard?: VectorStoreLeaseGuard,
  activeProvider?: "voyage" | "openrouter" | "siliconflow",
  /** Raw thrown value — used to classify Pinecone HTTP errors by class before message text. */
  rawError?: unknown
): Promise<void> {
  try {
    const assertActive = leaseGuard ? () => assertVectorStoreLease(leaseGuard) : undefined;
    assertVectorStoreLease(leaseGuard);
    // Transport-blip warnings arm a short cooldown on a `:transient` key so they cannot suppress a
    // later error-level / hard capture on the same lane (parity with alertConnectionFailure).
    const transportBlipForCooldown =
      rawError !== undefined
        ? isTransientNetworkError(rawError)
        : isTransientNetworkErrorText(message);
    let transientWarningCooldown = false;
    // Hoisted out of the `if` so the cooldown write below can anchor the suppression at the streak
    // deadline rather than at `now` (Codex P2 on #3195): when the first warning fires mid-streak —
    // e.g. right after deploy over retained failures, or on a low-volume lane — a now-anchored
    // cooldown would keep suppressing until `now + window` and delay the error-level escalation
    // past the ten-minute threshold.
    let blipStreakStartedMs = NaN;
    if (transportBlipForCooldown) {
      const laneForCooldown = getLaneHealth(service, source, source === "user" ? targetUserId : null);
      blipStreakStartedMs = laneForCooldown.streakStartedTs ? Date.parse(laneForCooldown.streakStartedTs) : NaN;
      transientWarningCooldown =
        !Number.isFinite(blipStreakStartedMs) ||
        Date.now() - blipStreakStartedMs < transientEscalationWindowMs();
    }
    const baseKey = `${RAG_CONNECTION_ALERT_PREFIX}:${service}:${source}:${targetUserId}`;
    const key = transientWarningCooldown ? `${baseKey}:transient` : baseKey;
    const cooldownMs = transientWarningCooldown ? transientEscalationWindowMs() : RAG_CONNECTION_ALERT_COOLDOWN_MS;
    const last = getInternalSetting<string>(key);
    if (last && Date.now() - Date.parse(last) < cooldownMs) return;
    assertVectorStoreLease(leaseGuard);
    // The cooldown check reads the stored value as "last alerted" and suppresses for `cooldownMs`
    // after it, so a transient-blip warning stores the STREAK START: `streakStart + window` is
    // exactly the escalation deadline, and the first failure after the window escalates on
    // schedule (parity with db-health's `streakStartedTs + transientEscalationWindowMs` deadline).
    // When the run start is unknown, fall back to now (a full window from this alert).
    setInternalSetting(
      key,
      transientWarningCooldown && Number.isFinite(blipStreakStartedMs)
        ? new Date(blipStreakStartedMs).toISOString()
        : new Date().toISOString()
    );

    const title =
      service === "pinecone" ? "Pinecone connection failed"
      : service === "voyage" ? "Voyage connection failed"
      : service === "voyage-rerank" ? "Voyage Rerank connection failed"
      : service === "openrouter" || service === "openrouter-rerank" ? "OpenRouter connection failed"
      : service === "siliconflow" || service === "siliconflow-rerank" ? "SiliconFlow connection failed"
      : `${RAG_PROVIDER_DISPLAY_NAMES[activeProvider ?? ""] ?? "RAG"} ${service === "rag-rerank" ? "rerank" : "embed"} connection failed`;
    const body = `${operation}: ${message}`;
    // `provider` carries the ACTUAL active provider when known (rag-embed/rag-rerank), falling back
    // to the raw service identifier for pinecone/legacy voyage calls — unchanged shape for those.
    // `lane` additionally exposes the health/alert identifier itself so a reader can tell "rag-embed"
    // apart from "rag-rerank" even when both currently resolve to the same active provider.
    const payload = {
      provider: activeProvider ?? service,
      lane: service,
      source,
      operation,
      reason: message,
      userSpecific: source === "user"
    };
    // Rate-limit parity with the non-RAG lane. db-health's alertConnectionFailure has always
    // passed `skipSentry` for 429/rate-limit-shaped text (a 429 is budget/pacing behavior, not a
    // broken integration), but this RAG path had no equivalent — so OpenRouter 429s paged while
    // the identical failure on any other provider did not. Suppress the Sentry event only; the
    // provider_degraded notification below and the alertUsageLimitHit escalation further down
    // (which is the RIGHT channel for a rate limit, with its own cooldown and recommendation)
    // both still fire.
    const limitStatus = ragLimitStatus(message);
    // Transient engine-overload (often wrapped as HTTP 429) is the provider being busy, not a
    // broken integration and not our quota. Skip Sentry + Pushover + usage-limit — retries own it.
    if (limitStatus === "transient") return;
    // Monthly write-unit 429s are routed by withRagApiHealth to the WU breaker.  If that
    // matcher used to miss (body without the word "429"), this path paged hourly
    // "Pinecone connection failed" plus a usage-limit while the Standard trial is unlimited.
    if (service === "pinecone" && isPineconeWuExhaustedError(message)) return;
    if (limitStatus !== "rate_limited") {
      // An unclassified failure (not rate-limited/billing/quota, and not caught by the transient
      // early-return above) is a genuine broken request (e.g. an HTTP 400) or an unrecognized
      // connection failure — report it at error level with the real status/message attached
      // (`reason` below) instead of warning, so it cannot hide behind a benign-looking log line.
      // 2026-09 Sentry evidence (SOCRATIC-TRADE-27/-1X): real embed failures were logged at the
      // same warning level as expected quota/budget conditions and were easy to miss.
      // ...with one exception, the same one db-health.ts's transport-blip class draws: a bare
      // socket/DNS failure (`ECONNRESET`, `ENOTFOUND`, `EAI_AGAIN`, `socket hang up`) is NOT a
      // "genuine broken request" — it is the transport dying, and this lane's own retries own it.
      // Those shapes fell through to `error` only because `ragLimitStatus`'s transient arm lists
      // `fetch failed` / `UND_ERR_SOCKET` and nothing else (SOCRATIC-TRADE-1X, -22).  Level only
      // via `isTransientNetworkErrorText` (widening `ragLimitStatus` was rejected — that would
      // soft-stamp the health row and silence a sustained outage).  Short blips stay `warning`;
      // once the lane's consecutive hard-failure run has lasted `transientEscalationWindowMs`,
      // escalate to `error` so a persistent RAG transport outage still reaches PagerDuty.
      const transportBlip =
        rawError !== undefined
          ? isTransientNetworkError(rawError)
          : isTransientNetworkErrorText(message);
      // A transport blip that has outlasted the escalation window is an OUTAGE — level `error`
      // AND tagged `hard`, matching db-health where an escalated blip streak stops being
      // "transient-network" (Codex P2 on #3195). One blip-window computation drives both so the
      // tag can never disagree with the level.
      const blipLane = transportBlip ? getLaneHealth(service, source, source === "user" ? targetUserId : null) : null;
      const blipStreakStartedMs = blipLane?.streakStartedTs ? Date.parse(blipLane.streakStartedTs) : NaN;
      const withinBlipWindow =
        !transportBlip ||
        !Number.isFinite(blipStreakStartedMs) ||
        Date.now() - blipStreakStartedMs < transientEscalationWindowMs();
      let level: "warning" | "error";
      if (limitStatus === undefined && !transportBlip) {
        level = "error";
      } else if (transportBlip && withinBlipWindow) {
        level = "warning";
      } else if (transportBlip) {
        level = "error";
      } else {
        level = "warning";
      }
      // Same health.failure_class tag the non-RAG alert path stamps — operators filter the twelve
      // connection-failed issues by this tag across lanes (Codex P2 on #3195).  An escalated
      // transport outage is tagged `hard` so `health.failure_class:hard` routing finds it.
      const failureClass = transportBlip && withinBlipWindow ? "transient-network" : "hard";
      await captureRagSentryMessage(level, title, {
        provider: activeProvider ?? service,
        lane: service,
        source,
        operation,
        userSpecific: source === "user",
        reason: message,
        failureClass
      }, leaseGuard);
    }
    assertVectorStoreLease(leaseGuard);
    await sendNotification(
      { type: "provider_degraded", title, payload },
      { userId: targetUserId, directBody: body, assertActive, signal: leaseGuard?.signal }
    );
    assertVectorStoreLease(leaseGuard);
    if (limitStatus) {
      await alertUsageLimitHit(
        {
          userId: targetUserId,
          provider: title.replace(" connection failed", ""),
          operation,
          limitName: limitStatus === "rate_limited" ? "provider rate limit" : limitStatus === "billing" ? "provider billing limit" : "provider quota",
          status: limitStatus,
          recommendation:
            limitStatus === "rate_limited"
              ? "Either slow the caller, batch requests more efficiently, or raise the provider rate limit if the traffic is intentional."
              : "Check whether this is expected growth. If usage is useful, raise the cap; if not, inspect batching, deduping, and retry behavior before paying for more."
        },
        { assertActive, signal: leaseGuard?.signal }
      );
      assertVectorStoreLease(leaseGuard);
    }
  } catch (error) {
    if (error instanceof VectorStoreLeaseLostError) throw error;
    // Alerts must not affect trading/RAG control flow.
  }
}

async function captureRagSentryMessage(
  level: "warning" | "error",
  message: string,
  context: Record<string, string | number | boolean | null | undefined>,
  leaseGuard?: VectorStoreLeaseGuard
): Promise<void> {
  assertVectorStoreLease(leaseGuard);
  const provider = context.provider != null ? String(context.provider) : undefined;
  if (message.toLowerCase().includes("embedding integrity rejection")) {
    recordRagRejection("embedding_integrity", provider ?? "unknown");
  }
  if (level === "warning") {
    logWarn(message.toLowerCase().includes("embedding integrity") ? "rag.rejected" : "rag.warning", {
      provider,
      operation: context.operation != null ? String(context.operation) : undefined,
      lane: context.lane != null ? String(context.lane) : undefined
    });
  } else {
    logError("rag.error", {
      provider,
      operation: context.operation != null ? String(context.operation) : undefined
    });
  }
  if (!process.env.SENTRY_DSN) return;
  try {
    const mod = (await import("@sentry/nextjs")) as typeof import("@sentry/nextjs") & {
      default?: typeof import("@sentry/nextjs");
    };
    assertVectorStoreLease(leaseGuard);
    const captureMessage = mod.captureMessage ?? mod.default?.captureMessage;
    const withScope = mod.withScope ?? mod.default?.withScope;
    if (typeof captureMessage !== "function" || typeof withScope !== "function") return;
    assertVectorStoreLease(leaseGuard);
    withScope((scope) => {
      scope.setLevel(level);
      scope.setTag("component", "rag");
      if (context.provider) scope.setTag("rag.provider", String(context.provider));
      if (context.operation) scope.setTag("rag.operation", String(context.operation));
      if (context.source) scope.setTag("rag.key_source", String(context.source));
      if (context.failureClass) scope.setTag("health.failure_class", String(context.failureClass));
      // Group by the STABLE lane identifier, not by the rendered title. Sentry fingerprints
      // captureMessage by message text, and these titles are built from DISPLAY names that drift
      // ("Voyage" vs "voyage", "OpenRouter" vs "OpenRouter embed" vs "OpenRouter rerank") — the
      // single rag-embed lane fragmented into six Sentry issues that way. `lane` is the health
      // service id ("rag-embed"/"rag-rerank"/"pinecone"); fall back to `provider` for the few
      // contexts that carry no lane (e.g. the storeContexts ledger path).
      const groupKey = context.lane ?? context.provider;
      if (groupKey) scope.setFingerprint(["rag", String(groupKey)]);
      scope.setContext("rag", context);
      captureMessage(message);
    });
    assertVectorStoreLease(leaseGuard);
  } catch (error) {
    if (error instanceof VectorStoreLeaseLostError) throw error;
    // Observability must not affect trading/RAG control flow.
  }
}

interface RagDispatchOptions {
  units?: number;
  estimatedCostUsd?: number;
  /** Exact durable account-deletion request authorizing the erasure operation through its fence. */
  accountDeletionRequestId?: string;
  /** The callback reserves each physical retry itself (used by Voyage's explicit retry loop). */
  durablyTrackedInside?: boolean;
}

async function withDurableRagProviderDispatch<T>(
  service: "pinecone" | "voyage" | "voyage-rerank" | "openrouter" | "openrouter-rerank" | "siliconflow" | "siliconflow-rerank",
  source: ApiKeySource,
  userId: string,
  operation: string,
  fn: () => Promise<T>,
  leaseGuard?: VectorStoreLeaseGuard,
  dispatch?: RagDispatchOptions
): Promise<T> {
  assertVectorStoreLease(leaseGuard);
  const provider = service === "voyage-rerank" ? "voyage" :
                   service === "openrouter-rerank" ? "openrouter" :
                   service === "siliconflow-rerank" ? "siliconflow" : service;
  const credential = resolveApiKey(provider, userId) ?? `${provider}:${source}:${userId}`;
  const credentialRef = crypto.createHash("sha256").update(credential, "utf8").digest("hex").slice(0, 24);
  const perMinuteDefault = provider === "voyage" ? 60 : 600;
  const envPrefix = provider.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  const perMinuteRaw = process.env[`PROVIDER_DISPATCH_${envPrefix}_PER_MIN`]?.trim();
  const costCapRaw = process.env[`PROVIDER_DISPATCH_${envPrefix}_MAX_COST_USD_PER_DAY`]?.trim();
  const configuredPerMinute = perMinuteRaw ? Number(perMinuteRaw) : undefined;
  const configuredCostCap = costCapRaw ? Number(costCapRaw) : undefined;
  let attemptId: string | undefined;
  let providerSettled = false;
  let providerReturned = false;
  let markDispatch: typeof dbModule.markProviderDispatchStarted | undefined;
  let settleDispatch: typeof dbModule.settleProviderDispatch | undefined;
  try {
    const reserveDispatch = dbModule.reserveProviderDispatch;
    markDispatch = dbModule.markProviderDispatchStarted;
    settleDispatch = dbModule.settleProviderDispatch;
    if (
      typeof reserveDispatch !== "function" ||
      typeof markDispatch !== "function" ||
      typeof settleDispatch !== "function"
    ) throw new Error("Durable provider dispatch ledger is unavailable.");
    const reservation = reserveDispatch({
      provider,
      operation,
      credentialRef,
      userId,
      units: dispatch?.units ?? 1,
      estimatedCostUsd: dispatch?.estimatedCostUsd ?? 0,
      windows: [{
        // Explicit zero pauses this provider lane. Empty/unset/invalid values retain the safe
        // default instead of Number("") accidentally becoming a production stop.
        maxUnits: typeof configuredPerMinute === "number" && Number.isFinite(configuredPerMinute) && configuredPerMinute >= 0
          ? Math.floor(configuredPerMinute)
          : perMinuteDefault,
        windowMs: 60_000
      }],
      // A configured zero is a deliberate stop. When unset, $25/day is a conservative shared
      // dispatch fuse; request/text/WU budgets remain the tighter normal controls.
      maxEstimatedCostUsdPer24h: typeof configuredCostCap === "number" && Number.isFinite(configuredCostCap) && configuredCostCap >= 0
        ? configuredCostCap
        : 25,
      ...(dispatch?.accountDeletionRequestId
        ? { accountDeletionRequestId: dispatch.accountDeletionRequestId }
        : {})
    });
    if (!reservation.admitted) throw new Error(`Durable ${provider} ${reservation.reason} reservation denied.`);
    attemptId = reservation.attemptId;
  } catch (error) {
    // A few isolated unit suites replace the entire db module with a minimal fake. Never permit
    // that seam outside tests; production must fail closed if the durable admission ledger fails.
    const missingTestMock = process.env.NODE_ENV === "test" && error instanceof Error && (
      error.message === "Durable provider dispatch ledger is unavailable." ||
      /No \"(?:reserveProviderDispatch|markProviderDispatchStarted|settleProviderDispatch)\" export is defined .* mock/i.test(error.message)
    );
    if (!missingTestMock) throw error;
    markDispatch = undefined;
    settleDispatch = undefined;
  }
  try {
    if (attemptId) markDispatch!(attemptId);
    const result = await fn();
    providerReturned = true;
    // Usage truth is independent of the business lease. Settle before checking whether ownership
    // moved while the SDK promise was in flight.
    if (attemptId) settleDispatch!(attemptId, "succeeded");
    providerSettled = true;
    assertVectorStoreLease(leaseGuard);
    return result;
  } catch (error) {
    if (attemptId && !providerSettled && !providerReturned) settleDispatch!(attemptId, "failed", {
      outcomeCode: error instanceof Error ? error.name : "provider-error"
    });
    throw error;
  }
}

async function withRagApiHealth<T>(
  // Still what drives the durable-dispatch/credential path below (withDurableRagProviderDispatch) —
  // unchanged, a separate concern from health/alert labeling. Pinecone call sites pass "pinecone"
  // and nothing else changes for them.
  // Dispatch/credential service id (must match withDurableRagProviderDispatch). healthLane is a
  // separate label for rag-embed/rag-rerank so OpenRouter/SiliconFlow outages are not reported as Voyage.
  service: "pinecone" | "voyage" | "voyage-rerank" | "openrouter" | "openrouter-rerank" | "siliconflow" | "siliconflow-rerank",
  source: ApiKeySource,
  userId: string,
  operation: string,
  fn: () => Promise<T>,
  leaseGuard?: VectorStoreLeaseGuard,
  dispatch?: RagDispatchOptions,
  healthLane?: { lane: "rag-embed" | "rag-rerank"; provider: "voyage" | "openrouter" | "siliconflow" }
): Promise<T> {
  assertVectorStoreLease(leaseGuard);
  const start = Date.now();
  const targetUserId = ragHealthUserId(source, userId);
  const loggedService = healthLane?.lane ?? service;
  try {
    const result = dispatch?.durablyTrackedInside
      ? await fn()
      : await withDurableRagProviderDispatch(
          service,
          source,
          userId,
          operation,
          fn,
          leaseGuard,
          dispatch
        );
    assertVectorStoreLease(leaseGuard);
    logApiHealth({
      service: loggedService,
      ok: true,
      latencyMs: Date.now() - start,
      keySource: source,
      userId: targetUserId
    });
    // Eager monthly-WU-breaker clear: a successful Pinecone WRITE proves quota is available
    // again (plan upgraded mid-month). No-op unless a marker exists and the operation is
    // write-shaped — see notePineconeWriteSuccess.
    if (service === "pinecone") notePineconeWriteSuccess(operation);
    return result;
  } catch (error) {
    // Lease cancellation is a concurrency boundary, not provider degradation. The caller converts
    // it to VectorStoreLeaseLostError and must not emit health failures/alerts for the successor's
    // operation.
    assertVectorStoreLease(leaseGuard);
    const rawMessage = ragErrorMessage(error);
    const message = `${operation}: ${rawMessage}`;
    // A LOCAL SQLite failure ("database is locked", "no such table") is not provider evidence.
    // This wrapper spans the whole durable dispatch cycle — reserve -> mark started -> provider
    // call -> settle — so a SQLite error from the ledger writes on EITHER side of the network call
    // arrives here wearing the provider's operation label. Reporting it as a provider outage is
    // what produced the hourly "Pinecone connection failed / inventory fetch: database is locked"
    // pushes in prod (2026-08-09) while Pinecone was healthy the whole time. Attribute it to the
    // real cause and leave the provider lane alone: no failure health row (the call proved nothing
    // about the provider either way, and inventing a success would be worse), no provider_degraded
    // notification. The error still propagates unchanged, so caller behavior is identical.
    if (isLocalDbFaultError(error)) {
      markRagSentryCaptured(error);
      const localNote = noteLocalDbFault({
        lane: loggedService,
        operation,
        message: rawMessage,
        userId: targetUserId
      });
      if (leaseGuard) {
        await localNote;
        assertVectorStoreLease(leaseGuard);
      } else {
        void localNote;
      }
      throw error;
    }
    // Same class of local-process fault as the SQLite case above: settle lost the
    // process-local owner token (deploy, restart, or 2-minute lease expiry) AFTER the
    // vendor call. That is not evidence Pinecone/OpenRouter is down — 2026-08-17 paged
    // both as "connection failed" during a 1m23s site blip. Leave the provider lane
    // untouched; the error still propagates so the caller can retry.
    if (isProviderDispatchLeaseLostError(error)) {
      markRagSentryCaptured(error);
      throw error;
    }
    // Monthly Pinecone write-unit exhaustion is an EXPECTED limit (soft health row, so the lane
    // never paints hard red STOPPED) and trips the WU breaker instead of the generic hourly
    // "Pinecone connection failed" alert — one storage_warning notification per episode, and the
    // early write-gate in storeContexts/storeDocument stops the paid re-embed churn.
    const wuExhausted = service === "pinecone" && isPineconeWuExhaustedError(rawMessage);
    const limitStatus = ragLimitStatus(rawMessage);
    const isTransient = limitStatus === "transient";
    assertVectorStoreLease(leaseGuard);
    logApiHealth({
      service: loggedService,
      ok: false,
      latencyMs: Date.now() - start,
      errorText: message,
      keySource: source,
      userId: targetUserId,
      ...(wuExhausted || isTransient ? { soft: true } : {})
    });
    markRagSentryCaptured(error);
    const alert = wuExhausted
      ? tripPineconeWuBreaker({ message: rawMessage, operation, userId: targetUserId }).then(() => undefined)
      : alertRagConnectionFailure(loggedService, source, targetUserId, operation, rawMessage, leaseGuard, healthLane?.provider, error);
    if (leaseGuard) {
      await alert;
      assertVectorStoreLease(leaseGuard);
    } else {
      void alert;
    }
    throw error;
  }
}

// R7 (2026-07-01 RAG backlog): cache of already-asserted index metrics, keyed the same way as
// indexInitPromises, so `describeIndex` is called AT MOST ONCE per (key, index) pair for the
// lifetime of the process — not once per retrieval/store call.
const indexMetricChecked = new Set<string>();
const initializedIndexKeys = new Set<string>();

/**
 * R7 — index-metric assertion at bootstrap. Every cosine floor (VECTOR_MIN_SCORE, the rerank
 * relevance floor) is meaningless if the Pinecone index's distance metric isn't actually
 * 'cosine' — EMBEDDING_DIMENSION is asserted (createIndex specifies it), but the metric never
 * was. Calls `describeIndex` once (cached via indexMetricChecked) and WARNS (audit + console),
 * NEVER throws for provider/metric failures — a legitimate non-cosine index or transient
 * control-plane failure must not take down retrieval/storage. Durable lease loss still propagates.
 */
async function assertIndexMetric(
  pc: Pinecone,
  initCacheKey: string,
  source: ApiKeySource,
  userId: string,
  leaseGuard?: VectorStoreLeaseGuard,
  accountDeletionRequestId?: string
): Promise<void> {
  assertVectorStoreLease(leaseGuard);
  if (indexMetricChecked.has(initCacheKey) && indexAuthorityByInitKey.has(initCacheKey)) return;
  let described = false;
  try {
    const model = await withRagApiHealth(
      "pinecone",
      source,
      userId,
      "describeIndex",
      () => pc.describeIndex(indexName()),
      leaseGuard,
      accountDeletionRequestId ? { accountDeletionRequestId } : undefined
    );
    assertVectorStoreLease(leaseGuard);
    rememberProviderAuthority(initCacheKey, model);
    described = true;
    const metric = (model as { metric?: unknown })?.metric;
    if (metric != null && metric !== "cosine") {
      assertVectorStoreLease(leaseGuard);
      console.warn(`[vector-db] Pinecone index "${indexName()}" metric is "${String(metric)}", expected "cosine" — cosine-scale floors (VECTOR_MIN_SCORE, rerank relevance floor) may be meaningless against this index.`);
      await captureRagSentryMessage("warning", "Pinecone index metric mismatch", {
        provider: "pinecone",
        operation: "describeIndex",
        source,
        indexName: indexName(),
        metric: String(metric),
        expectedMetric: "cosine"
      }, leaseGuard);
      assertVectorStoreLease(leaseGuard);
      try {
        audit("vector_index_metric_mismatch", { indexName: indexName(), metric: String(metric) }, "local");
      } catch {
        // best-effort audit only
      }
    }
  } catch (err) {
    // A stale owner must not turn cancellation into a best-effort warning, Sentry alert, or cached
    // "metric checked" receipt. The successor gets an independent initialization attempt.
    assertVectorStoreLease(leaseGuard);
    // describeIndex itself failing (network, permissions, index not found yet) is NOT the
    // condition this guard checks for — swallow silently, this is a best-effort sanity check.
    console.warn(`[vector-db] Could not verify index metric for "${indexName()}":`, err instanceof Error ? err.message : String(err));
    await captureRagSentryMessage("warning", "Pinecone index metric check failed", {
      provider: "pinecone",
      operation: "describeIndex",
      source,
      indexName: indexName(),
      reason: err instanceof Error ? err.message : String(err)
    }, leaseGuard);
    // Unit-only fallback authorities keep unrelated embedding fixtures small, but destructive
    // account erasure must exercise the same fail-closed identity requirement as production.
    if (process.env.NODE_ENV === "test" && !accountDeletionRequestId) {
      indexAuthorityByInitKey.set(initCacheKey, fallbackProviderAuthority(initCacheKey));
      described = true;
    }
  }
  assertVectorStoreLease(leaseGuard);
  // Mark only after a stable host authority was observed. Provider failures and malformed
  // describe responses remain retryable and cannot mint key-derived managed identities.
  if (described && indexAuthorityByInitKey.has(initCacheKey)) indexMetricChecked.add(initCacheKey);
}

async function initializeIndex(
  pc: Pinecone,
  initCacheKey: string,
  source: ApiKeySource,
  userId: string,
  leaseGuard?: VectorStoreLeaseGuard
): Promise<void> {
  assertVectorStoreLease(leaseGuard);
  const name = indexName();
  const indexes = await withRagApiHealth(
    "pinecone",
    source,
    userId,
    "listIndexes",
    () => pc.listIndexes(),
    leaseGuard
  );
  assertVectorStoreLease(leaseGuard);
  if (!indexes.indexes?.some((i) => i.name === name)) {
    try {
      await withRagApiHealth(
        "pinecone",
        source,
        userId,
        "createIndex",
        () => pc.createIndex({
          name,
          dimension: EMBEDDING_DIMENSION,
          metric: "cosine",
          spec: { serverless: { cloud: "aws", region: "us-east-1" } }
        }),
        leaseGuard
      );
    } catch (error) {
      assertVectorStoreLease(leaseGuard);
      const message = error instanceof Error ? error.message : String(error);
      if (!/already exists|409|conflict/i.test(message)) throw error;
    }
    assertVectorStoreLease(leaseGuard);
    await sleep(indexReadyWaitMs(), leaseGuard?.signal);
    assertVectorStoreLease(leaseGuard);
  }
  await assertIndexMetric(pc, initCacheKey, source, userId, leaseGuard);
  assertVectorStoreLease(leaseGuard);
}

async function ensureIndex(
  pc: Pinecone,
  initCacheKey: string,
  source: ApiKeySource,
  userId: string,
  leaseGuard?: VectorStoreLeaseGuard
): Promise<void> {
  assertVectorStoreLease(leaseGuard);
  if (initializedIndexKeys.has(initCacheKey)) return;

  // Never attach a durable owner to another owner's in-flight cached promise. Guarded producers are
  // serialized by RAG_REINDEX and initialize independently; only a fully completed result is shared.
  if (leaseGuard) {
    await initializeIndex(pc, initCacheKey, source, userId, leaseGuard);
    assertVectorStoreLease(leaseGuard);
    initializedIndexKeys.add(initCacheKey);
    return;
  }

  const cached = indexInitPromises.get(initCacheKey);
  if (cached) return cached;

  const init = initializeIndex(pc, initCacheKey, source, userId);

  indexInitPromises.set(initCacheKey, init);
  try {
    await init;
    initializedIndexKeys.add(initCacheKey);
  } catch (error) {
    indexInitPromises.delete(initCacheKey);
    throw error;
  }
}

async function indexExists(
  pc: Pinecone,
  source: ApiKeySource,
  userId: string,
  accountDeletionRequestId?: string,
  leaseGuard?: VectorStoreLeaseGuard
): Promise<boolean> {
  const indexes = await withRagApiHealth(
    "pinecone",
    source,
    userId,
    "listIndexes",
    () => pc.listIndexes(),
    leaseGuard,
    accountDeletionRequestId ? { accountDeletionRequestId } : undefined
  );
  return Boolean(indexes.indexes?.some((i) => i.name === indexName()));
}

/** Resolve the non-secret physical index identity used by managed-vector receipts and ids. */
export async function getCurrentVectorProviderAuthority(options: {
  userId?: string;
  accountDeletionRequestId?: string;
  leaseGuard?: VectorStoreLeaseGuard;
} = {}): Promise<string | undefined> {
  if (usesQdrantWrites()) {
    try {
      return resolveQdrantWriteProviderAuthority(managedVectorLedgerAuthority());
    } catch {
      return qdrantProviderAuthority();
    }
  }
  const userId = options.userId ?? "local";
  const { pc, initCacheKey, pineconeSource } = await getPineconeClient(userId, options.leaseGuard);
  if (!pc || !initCacheKey) return undefined;
  if (!(await indexExists(
    pc,
    pineconeSource,
    userId,
    options.accountDeletionRequestId,
    options.leaseGuard
  ))) return undefined;
  await assertIndexMetric(
    pc,
    initCacheKey,
    pineconeSource,
    userId,
    options.leaseGuard,
    options.accountDeletionRequestId
  );
  return stableProviderAuthorityForInitKey(initCacheKey);
}

/**
 * server-asof-filter (2026-07-06): the numeric point-in-time metadata field written on every
 * newly-upserted vector so a backtest's `asOf` constraint can be pushed INTO the Pinecone query
 * (server-side) instead of only being applied POST-fetch. Integer epoch milliseconds. Deliberately
 * numeric (not the ISO string in `acceptance_datetime`) because Pinecone's `$lte`/`$gte` range
 * operators only work against numbers — an ISO-string range filter isn't expressible server-side.
 *
 * ABSENCE is meaningful: a vector that lacks this field is UNDATED-for-server-purposes and is the
 * fail-open signal (see `retrieveContextDetailed`'s epoch clause). It is ONLY written when a date
 * actually resolves, so an un-backfilled/undated vector stays absent and is not falsely dated to 0.
 */
export const AS_OF_EPOCH_FIELD = "as_of_epoch_ms" as const;

/**
 * Derive the numeric point-in-time epoch (ms) for a vector's metadata using the SAME precedence
 * `resolveAsOfStamp`/`isWithinAsOf` use: acceptance_datetime -> published_at -> as_of -> timestamp.
 * Returns `undefined` when none of those keys is present/parseable (NaN-safe) — callers MUST treat
 * `undefined` as "leave the field absent" so absence stays the fail-open signal. Pure/dependency-free
 * so both the ingest write path (`cleanMetadata`) and the backfill path can share one source of truth.
 *
 * NOTE: this intentionally mirrors `resolveAsOfStamp` exactly. It is a separate function only so it
 * can be co-located with the write path (`cleanMetadata` is defined above `resolveAsOfStamp`) and so
 * its "absent means fail-open" contract is documented at the point the field is written.
 */
export function resolveAsOfEpochMs(metadata: Record<string, unknown> | undefined): number | undefined {
  const stamp = metadata?.acceptance_datetime ?? metadata?.published_at ?? metadata?.as_of ?? metadata?.timestamp;
  if (stamp == null) return undefined;
  const t = typeof stamp === "number" ? stamp : Date.parse(String(stamp));
  return Number.isFinite(t) ? t : undefined;
}

function cleanMetadata(
  metadata: ContextDocument["metadata"],
  text: string,
  userId: string,
  scope: VectorScope,
  tenantScope: string,
  providerAuthority: string,
  ledgerAuthority?: string
): RecordMetadata {
  // Embedding-model/representation version tag (2026-07-04 RAG quick-wins): stamp every new vector
  // with the model that produced it + a representation revision, so a mixed population (e.g. after
  // a VOYAGE_MODEL swap or a VECTOR_EMBED_CLEAN_TEXT flip) can be detected/filtered/migrated later
  // instead of silently comparing across incompatible embedding spaces. Legacy vectors written
  // before this field existed simply lack it — treat missing as rev 0 (see currentEmbedRev above).
  const out: Record<string, string | number | boolean | string[]> = {
    text,
    userId,
    scope,
    tenant_scope: tenantScope,
    provider_authority: providerAuthority,
    embed_model: activeEmbeddingModel(userId),
    embed_rev: currentEmbedRev(),
    // Direct/legacy-style writes have no relational receipt protocol and are committed by their
    // single successful upsert. `storeDocument` explicitly overrides these to pending/required,
    // then promotes them only after its exact receipt transaction.
    ingest_state: "committed",
    receipt_required: false
  };
  if (ledgerAuthority) out.ledger_authority = ledgerAuthority;
  for (const [key, value] of Object.entries(metadata)) {
    if (
      key === "text" ||
      key === "userId" ||
      key === "scope" ||
      key === "tenant_scope" ||
      key === "provider_authority" ||
      key === "ledger_authority" ||
      key === "embed_model" ||
      key === "embed_rev"
    ) continue;
    // as_of_epoch_ms is DERIVED below from the date precedence, never copied from a caller-supplied
    // value — skip any inbound one so a stray/incorrect field can't override the authoritative
    // derivation (and so the "absent when undated" invariant can't be violated by a caller passing 0).
    if (key === AS_OF_EPOCH_FIELD) continue;
    if (key === "doc_type" && typeof value === "string") {
      // Normalize doc_type to lowercase AT WRITE TIME so every new vector is consistent, regardless
      // of what casing the caller passed in (some ingesters historically passed "10-K"/"10-Q").
      // Legacy mixed-case vectors already in Pinecone are unaffected — buildExtraFilters still
      // expands both casings at query time so old data stays matchable.
      out[key] = value.toLowerCase();
      continue;
    }
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") out[key] = value;
    else if (Array.isArray(value)) out[key] = value.map(String).filter(Boolean);
  }
  // server-asof-filter (2026-07-06): additively stamp a NUMERIC point-in-time epoch (ms) derived
  // from the SAME acceptance_datetime -> published_at -> as_of -> timestamp precedence the post-fetch
  // guard uses, so a backtest's asOf can be pushed into the Pinecone query. Written ONLY when a date
  // actually resolves — an undated document leaves the field ABSENT, which is the fail-open signal
  // the query path relies on (absent vectors are not dropped server-side under the default). NaN-safe
  // via resolveAsOfEpochMs. Changes only NEW upserts; existing vectors are handled by the backfill.
  const asOfEpochMs = resolveAsOfEpochMs(metadata);
  if (asOfEpochMs != null) out[AS_OF_EPOCH_FIELD] = asOfEpochMs;
  return enforcePineconeMetadataLimit(out as RecordMetadata);
}

function vectorUserIdFor(userId: string | undefined): string {
  return sanitizeUserId(userId);
}

export function vectorTenantScope(userId: string | undefined, scope?: VectorScope): string {
  const exact = String(userId ?? "local");
  const effectiveScope = scope ?? (exact === "local" ? SHARED_SCOPE : PRIVATE_SCOPE);
  if (effectiveScope === SHARED_SCOPE) return "shared:operator";
  return `private:${crypto.createHash("sha256").update(exact, "utf8").digest("hex")}`;
}

/** Legacy private ids are safe only when sanitization is an identity operation. Otherwise two
 * distinct raw users can collapse onto the same historical metadata.userId value. */
export function isUnambiguousLegacyVectorUserId(userId: string | undefined): boolean {
  const exact = String(userId ?? "local");
  return exact === sanitizeUserId(exact);
}

function legacyPrivateMetadataUserMatches(metadataUserId: string | undefined, userId: string | undefined): boolean {
  const exact = String(userId ?? "local");
  return isUnambiguousLegacyVectorUserId(exact) && metadataUserId === exact;
}

function managedOccurrenceToken(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex").slice(0, 20);
}

export function managedOccurrenceVectorPrefix(input: {
  ledgerAuthority?: string;
  providerAuthority: string;
  tenantScope?: string;
  source?: string;
}): string {
  const ledgerAuthority = input.ledgerAuthority ?? managedVectorLedgerAuthority();
  let prefix = `${managedLedgerVectorPrefix(ledgerAuthority)}${managedOccurrenceToken(input.providerAuthority)}`;
  if (input.tenantScope === undefined) return `${prefix}:`;
  prefix += `:${managedOccurrenceToken(input.tenantScope)}`;
  if (input.source === undefined) return `${prefix}:`;
  return `${prefix}:${managedOccurrenceToken(input.source)}:`;
}

export function managedLedgerVectorPrefix(ledgerAuthority = managedVectorLedgerAuthority()): string {
  return `occ:v3:${managedOccurrenceToken(ledgerAuthority)}:`;
}

export function managedOccurrenceVectorIdMatches(input: {
  id: string;
  ledgerAuthority?: string;
  providerAuthority: string;
  tenantScope: string;
  source?: string;
}): boolean {
  return input.id.startsWith(managedOccurrenceVectorPrefix(input));
}

export function isManagedOccurrenceVectorId(id: string): boolean {
  return id.startsWith("occ:v2:") || id.startsWith("occ:v3:");
}

export function buildOccurrenceVectorId(input: {
  ledgerAuthority?: string;
  providerAuthority: string;
  tenantScope: string;
  source: string;
  accession: string;
  contentVersion: string;
  section: string;
  ordinal: number;
  parserRevision: string;
  embedRevision: string;
}): string {
  const ledgerAuthority = input.ledgerAuthority ?? managedVectorLedgerAuthority();
  const canonical = JSON.stringify([
    ledgerAuthority,
    input.providerAuthority,
    input.tenantScope,
    input.source,
    input.accession,
    input.contentVersion,
    input.section,
    input.ordinal,
    input.parserRevision,
    input.embedRevision
  ]);
  const prefix = managedOccurrenceVectorPrefix({
    ledgerAuthority,
    providerAuthority: input.providerAuthority,
    tenantScope: input.tenantScope,
    source: input.source
  });
  return `${prefix}${crypto.createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

export function sanitizeVectorId(id: string): string {
  const sanitized = id.replace(/[^A-Za-z0-9_.:-]/g, "_");
  if (sanitized.length <= 512) return sanitized;
  // Preserve the tail where unique suffixes (ordinal, parserRev, embedRev) live.
  // Taking a blind prefix slice can drop the only differing portion when a
  // document title or section has a long common prefix, causing multiple
  // chunks to share the same truncated ID.
  const headLen = 384;
  const tailMarker = "..";
  const tailLen = 512 - headLen - tailMarker.length;
  return sanitized.slice(0, headLen) + tailMarker + sanitized.slice(-tailLen);
}

function contextId(document: ContextDocument, fallbackIndex: number): string {
  if (document.metadata?.vector_id) {
    return sanitizeVectorId(String(document.metadata.vector_id));
  }
  const { symbol, source, accession, timestamp } = document.metadata;
  const raw = [source, symbol, accession, timestamp].filter(Boolean).join(":") || `${symbol}:${source}:${fallbackIndex}`;
  return sanitizeVectorId(raw);
}

function estimatePineconeWriteUnitsForDocument(
  document: ContextDocument,
  vectorUserId: string,
  scope: VectorScope,
  tenantScope: string
): number {
  // Physical authority is resolved after the pre-embed budget check. Its persisted representation
  // is always a 64-character SHA-256 hex digest, so an equal-width placeholder keeps this estimate
  // conservative and byte-accurate without requiring an early provider call.
  const metadata = cleanMetadata(
    document.metadata,
    document.text,
    vectorUserId,
    scope,
    tenantScope,
    "0".repeat(64),
    "ledger:v1:" + "0".repeat(36)
  );
  const idBytes = Buffer.byteLength(contextId(document, 0), "utf8");
  // Pinecone bills by request size. This pre-embed estimate uses float32 vector bytes plus
  // metadata/id overhead so the budget can stop before paying Voyage to embed doomed writes.
  return estimatePineconeRecordWriteUnits(idBytes + pineconeMetadataBytes(metadata) + EMBEDDING_DIMENSION * 4 + 512);
}

function estimatePineconeWriteUnitsForRecords(records: PineconeRecord<RecordMetadata>[]): number {
  if (records.length === 0) return 0;
  const bytes = records.reduce((sum, record) => {
    const values = Array.isArray(record.values) ? record.values : [];
    const dimension = Math.max(values.length, EMBEDDING_DIMENSION);
    return (
      sum +
      Buffer.byteLength(String(record.id), "utf8") +
      pineconeMetadataBytes(record.metadata ?? {}) +
      dimension * 4 +
      512
    );
  }, 0);
  return Math.max(5, Math.ceil(bytes / 1024));
}

function pineconeReadUnits(result: unknown, fallback: number): number {
  const usage = (result as { usage?: Record<string, unknown> } | undefined)?.usage;
  const raw = usage?.readUnits ?? usage?.read_units ?? usage?.readUnit ?? usage?.read_unit;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function applyPineconeWriteBudget(
  documents: ContextDocument[],
  userId: string,
  vectorUserId: string,
  scope: VectorScope,
  tenantScope: string,
  isManagedCommit = false
): { documents: ContextDocument[]; skipped: number; used: number; limit: number; requested: number; allowed: number } {
  const limit = pineconeMaxWriteUnitsPerDay();
  if (!pineconeWriteBudgetEnabled()) {
    return { documents, skipped: 0, used: 0, limit, requested: 0, allowed: Number.POSITIVE_INFINITY };
  }

  const used = usedPineconeWriteUnitsLast24h(userId);
  const selection = selectItemsWithinWriteBudget(
    documents,
    (document) => {
      const estimatedPending = estimatePineconeWriteUnitsForDocument(document, vectorUserId, scope, tenantScope);
      return isManagedCommit ? estimatedPending * 2 : estimatedPending;
    },
    used,
    limit
  );

  return {
    documents: selection.kept,
    skipped: selection.skipped,
    used,
    limit,
    requested: selection.requested,
    allowed: selection.allowed
  };
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// Pinecone `index.fetch({ ids })` issues a GET with every id URL-encoded into the query string
// (`?ids=…&ids=…`). Managed occurrence ids (`occ:v3:…`) are ~150 chars each, so a batch that is
// fine by COUNT (the default 100) can still build an ~18 KB request URL and fail with an opaque
// "unexpected error" once Pinecone/its edge rejects the oversized URL. Chunk fetch ids by encoded
// URL length as well as count so both short (default-namespace) and long (managed) ids stay under
// a safe limit. Only fetches need this — upsert/delete send ids in the POST body, not the URL.
export const PINECONE_FETCH_ID_URL_BUDGET = 3500; // encoded id chars per GET; headroom under a ~4 KB URL
export function fetchIdChunks(ids: string[], maxCount: number): string[][] {
  const out: string[][] = [];
  let current: string[] = [];
  let currentLen = 0;
  for (const id of ids) {
    const encodedLen = encodeURIComponent(id).length + 6; // "&ids=" + separator overhead
    if (current.length > 0 && (current.length >= maxCount || currentLen + encodedLen > PINECONE_FETCH_ID_URL_BUDGET)) {
      out.push(current);
      current = [];
      currentLen = 0;
    }
    current.push(id);
    currentLen += encodedLen;
  }
  if (current.length > 0) out.push(current);
  return out;
}

function trimContextText(text: string, maxCharsOverride?: number): string {
  const trimmed = text.trim();
  const maxChars = maxCharsOverride ?? contextMaxChars();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars).trimEnd()}\n[truncated for vector memory]`;
}

function isRateLimitError(error: unknown): boolean {
  const maybeStatus = (error as { status?: unknown; statusCode?: unknown }) ?? {};
  if (maybeStatus.status === 429 || maybeStatus.statusCode === 429) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /\b429\b|rate limit|too many requests|RPM|TPM/i.test(message);
}

export class HttpProviderError extends Error {
  readonly status: number;
  readonly headers: Headers;
  constructor(message: string, status: number, headers: Headers) {
    super(message);
    this.name = "HttpProviderError";
    this.status = status;
    this.headers = headers;
  }
}

export function retryAfterMs(error: unknown, attempt: number): number {
  const headers =
    (error as { headers?: { get?: (name: string) => string | null } })?.headers ??
    (error as { response?: { headers?: { get?: (name: string) => string | null } } })?.response?.headers;
  const retryAfter = headers?.get?.("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const dateDelay = Date.parse(retryAfter) - Date.now();
    if (Number.isFinite(dateDelay) && dateDelay > 0) return dateDelay;
  }
  const batchDelay = embedBatchDelayMs();
  const baseDelay = embedRetryDelayMs();
  
  const backoff = Math.min(60_000, baseDelay * Math.pow(2, attempt));
  const delay = Math.random() * backoff;
  return Math.max(batchDelay, delay);
}

async function embedWithRetry(
  voyage: any,
  input: string[],
  inputType: "document" | "query",
  signal: AbortSignal | undefined,
  source: ApiKeySource,
  userId: string,
  leaseGuard?: VectorStoreLeaseGuard
): Promise<any> {
  const attempts = embedRetryAttempts();
  const provider = activeEmbeddingProvider(userId);
  const modelName = activeEmbeddingModel(userId);

  const openrouterKey = resolveApiKey("openrouter", userId);
  const siliconflowKey = resolveApiKey("siliconflow", userId);

  const isOpenRouter = provider === "openrouter";
  const apiKey = isOpenRouter ? (openrouterKey || "") : (siliconflowKey || "");

  const useMockClient = !!voyage && typeof voyage.embed === "function";

  // Hermetic tests intentionally avoid provider traffic. Production must never turn a missing or
  // placeholder credential into deterministic fake vectors: those would look committed and poison
  // the managed index irreversibly until reconciled.
  if (!useMockClient && process.env.NODE_ENV === "test") {
    return {
      data: input.map((_, i) => ({
        embedding: Array.from({ length: 1024 }, (_, idx) => (i + idx) / 2048)
      }))
    };
  }
  if (!useMockClient && !embeddingCredentialIsUsable(apiKey, false)) {
    throw new Error(`${provider} embedding credential is missing or is a mock placeholder.`);
  }

  const embedOnce = async (texts: string[]): Promise<any> => {
    for (let attempt = 0; ; attempt++) {
      try {
        const runCall = async () => {
          if (useMockClient) {
            if (leaseGuard?.signal) {
              return await voyage.embed({
                input: texts,
                model: modelName,
                inputType: inputType === "document" ? "document" : "query"
              }, {
                abortSignal: leaseGuard.signal
              });
            }
            return await voyage.embed({
              input: texts,
              model: modelName,
              inputType: inputType === "document" ? "document" : "query"
            });
          }

          const url = isOpenRouter ? "https://openrouter.ai/api/v1/embeddings" : `${siliconflowBaseUrl()}/v1/embeddings`;
          const headers: Record<string, string> = {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${apiKey}`
          };
          const body: Record<string, unknown> = { model: modelName, input: texts };
          if (isOpenRouter) {
            // OpenRouter attribution headers + classifier enrichment, matching the search-fusion.ts
            // OpenRouter embed path. Enrichment never breaks the call — see
            // applyOpenRouterClassifierEnrichment.
            headers["HTTP-Referer"] = "https://socratictrade.com";
            headers["X-Title"] = "Socratic.Trade";
            applyOpenRouterClassifierEnrichment(body, { userId, service: "rag", feature: "embed" });
          }
          const response = await withGenAiSpan(
            url,
            { method: "POST", body: JSON.stringify(body) },
            () =>
              fetch(url, {
                method: "POST",
                headers,
                body: JSON.stringify(body),
                signal
              }),
            { operation: "embeddings", model: modelName, system: isOpenRouter ? "openrouter" : "siliconflow" }
          );
          if (!response.ok) {
            const body = await response.text();
            throw new HttpProviderError(
              `Embedding API failed (isOpenRouter=${isOpenRouter}): ${response.status} ${body}`,
              response.status,
              response.headers
            );
          }
          return await response.json();
        };

        return await withDurableRagProviderDispatch(
          provider,
          source,
          userId,
          `embed ${inputType}`,
          runCall,
          leaseGuard,
          { estimatedCostUsd: estimateRagDispatchCost(texts, "embed", modelName, provider) }
        );
      } catch (error) {
        if (signal?.aborted) {
          throw signal.reason instanceof Error ? signal.reason : error;
        }
        if (!isRateLimitError(error) || attempt >= attempts) throw error;
        const delay = retryAfterMs(error, attempt);
        console.warn(`[vector-db] Embedding rate limited for inputType=${inputType}; retrying in ${Math.round(delay / 1000)}s.`);
        await sleep(delay, signal);
      }
    }
  };

  // DeepInfra sums the whole `input[]` against 8192.  Count-only batches (prod
  // VECTOR_EMBED_BATCH_SIZE=32) 400 at 8193.  Pack under ~7500.  A single
  // over-budget text is isolated as its own POST — never re-chunked into extra
  // Pinecone records or extra ContextDocuments.
  const packed = packInWindowTexts(
    input.map((text, sourceIndex) => ({ text, sourceIndex })),
    { maxCount: embedBatchSize() }
  );
  if (packed.length <= 1) {
    return embedOnce(input);
  }

  const embeddings = new Array<number[]>(input.length);
  let sent = false;
  for (const group of packed) {
    const texts = group.map((item) => item.text);
    if (texts.length > 1 && !embedRequestFits(texts)) {
      throw new Error(`embed packer produced an over-budget request (${texts.length} texts, budget ${EMBED_REQUEST_TOKEN_BUDGET})`);
    }
    if (sent) await sleep(embedBatchDelayMs(), signal);
    sent = true;
    const response = await embedOnce(texts);
    const validated = validateDocumentEmbeddingBatch(response?.data, texts.length);
    if (!validated.embeddings) {
      throw new Error(`Embedding response rejected after window pack (${validated.reason ?? "unknown"})`);
    }
    for (let i = 0; i < group.length; i++) {
      embeddings[group[i]!.sourceIndex] = validated.embeddings[i]!;
    }
  }
  return {
    data: embeddings.map((embedding, index) => ({ embedding, index }))
  };
}

export function embeddingCredentialIsUsable(
  value: string | null | undefined,
  allowTestPlaceholder: boolean = process.env.NODE_ENV === "test"
): boolean {
  const credential = value?.trim();
  if (!credential) return false;
  return allowTestPlaceholder || !credential.toLowerCase().startsWith("mock");
}

async function embedDocumentsWithRetry(
  voyage: any,
  input: string[],
  source: ApiKeySource,
  userId: string,
  leaseGuard?: VectorStoreLeaseGuard
): Promise<any> {
  return embedWithRetry(voyage, input, "document", leaseGuard?.signal, source, userId, leaseGuard);
}

/**
 * Reorder recalled matches by the configured cross-encoder relevance and keep the top `topK`. Pure
 * best-effort: on any error (rate limit, unsupported model, empty docs) returns the input order
 * unchanged so retrieval never breaks — reranking is a quality boost, not a dependency.
 *
 * Each returned match carries the reranker's own `relevanceScore` (Voyage's cross-encoder score,
 * distinct from the Pinecone cosine `score`) attached as `_rerankScore` — a non-enumerable-ish
 * plain field on a shallow copy of the match, so callers that only read `.score`/`.metadata` are
 * unaffected. `matchToChunk` reads `_rerankScore` into `RetrievedChunk.relevanceScore`.
 */
export async function rerankMatches(
  voyage: any,
  query: string,
  matches: any[],
  topK: number,
  userId: string = "local",
  source: ApiKeySource = "env"
): Promise<any[]> {
  if (matches.length <= 1) return matches;
  const rerankableMatches = matches.slice(0, RERANK_MAX_DOCUMENTS);
  const documents = rerankableMatches.map((m) => {
    const t = (m?.metadata as Record<string, unknown> | undefined)?.text;
    return typeof t === "string" ? t : "";
  });
  if (documents.every((d) => !d)) return rerankableMatches;
  
  const useMockClient = !!voyage && typeof voyage.rerank === "function";
  const route = activeRerankRoute(userId, useMockClient);
  const provider = route.provider;
  const modelName = route.model;

  const openrouterKey = resolveApiKey("openrouter", userId);
  const siliconflowKey = resolveApiKey("siliconflow", userId);

  const isOpenRouter = provider === "openrouter";
  const isSiliconFlow = provider === "siliconflow";
  const apiKey = isOpenRouter ? (openrouterKey || "") : (siliconflowKey || "");

  // An explicit rerank route never silently spends against a different provider. Missing authority
  // is a truthful no-op: retain the deterministic fused/cosine order and emit no fabricated score.
  if (!useMockClient && (!route.available || !apiKey || apiKey.startsWith("mock") || process.env.NODE_ENV === "test")) {
    return rerankableMatches;
  }

  try {
    const rerankProvider =
      provider === "openrouter" || provider === "siliconflow" || provider === "voyage"
        ? provider
        : "voyage";
    // Durable dispatch must use the active provider id (openrouter/siliconflow/voyage-rerank),
    // not a hardcoded voyage-rerank service — otherwise OpenRouter cost-cap reservation is wrong.
    const dispatchService =
      rerankProvider === "openrouter" ? "openrouter"
      : rerankProvider === "siliconflow" ? "siliconflow"
      : "voyage-rerank";
    const resp = await withRagApiHealth(
      dispatchService,
      source,
      userId,
      "rerank",
      async () => {
        if (useMockClient) {
          return await voyage.rerank({
            query,
            documents,
            model: modelName,
            topK
          });
        }

        const url = isOpenRouter ? "https://openrouter.ai/api/v1/rerank" : `${siliconflowBaseUrl()}/v1/rerank`;
        const rerankHeaders: Record<string, string> = {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`
        };
        const rerankBody: Record<string, unknown> = {
          model: modelName,
          query,
          documents,
          top_n: Math.min(topK, rerankableMatches.length)
        };
        if (isOpenRouter) {
          // OpenRouter attribution headers + classifier enrichment for rerank, matching the
          // embed path above. Enrichment never breaks the call — see
          // applyOpenRouterClassifierEnrichment.
          rerankHeaders["HTTP-Referer"] = "https://socratictrade.com";
          rerankHeaders["X-Title"] = "Socratic.Trade";
          applyOpenRouterClassifierEnrichment(rerankBody, { userId, service: "rag", feature: "rerank" });
        }
        const response = await fetch(url, {
          method: "POST",
          headers: rerankHeaders,
          body: JSON.stringify(rerankBody)
        });
        if (!response.ok) {
          const body = await response.text();
          throw new HttpProviderError(
            `Rerank API failed (isOpenRouter=${isOpenRouter}): ${response.status} ${body}`,
            response.status,
            response.headers
          );
        }
        const res = await response.json();
        return res;
      },
      undefined,
      { estimatedCostUsd: estimateRagDispatchCost([query, ...documents], "rerank", modelName, provider) },
      { lane: "rag-rerank", provider: rerankProvider }
    );
    meterRerank(query, documents, modelName, userId, provider);
    recordRagOperation(Date.now(), userId);
    
    const data = useMockClient ? (resp.data ?? []) : (isOpenRouter ? (resp.results ?? []) : (resp.data ?? []));
    if (data.length === 0) return rerankableMatches;
    const reordered: any[] = [];
    for (const item of data) {
      const idx = item.index;
      const relevanceScore = typeof item.relevance_score === "number" ? item.relevance_score : 
                             typeof item.relevanceScore === "number" ? item.relevanceScore : undefined;
      if (typeof idx === "number" && rerankableMatches[idx]) {
        reordered.push(
          relevanceScore != null
            ? { ...rerankableMatches[idx], _rerankScore: relevanceScore }
            : rerankableMatches[idx]
        );
      }
    }
    return reordered.length > 0 ? reordered : rerankableMatches;
  } catch (err) {
    console.warn("[vector-db] rerank failed; retaining fused recall order:", err instanceof Error ? err.message : String(err));
    return rerankableMatches;
  }
}

/**
 * Store a document context into Pinecone.
 */
export async function storeContext(
  text: string,
  metadata: ContextDocument["metadata"],
  userId: string = "local"
): Promise<void> {
  await storeContexts(
    [{ text, metadata }],
    userId,
    envFlagOn("VECTOR_STORECONTEXTS_DEDUP", true) ? { dedupKeyPrefix: "direct-context" } : undefined
  );
}

export interface StoreContextsOptions {
  /**
   * Corpus visibility is an explicit content property, not an inference from the operator sentinel.
   * Public filings/web data may omit this when written as `local` (the backward-compatible shared
   * default). Account/decision/experience memory must pass `private`, including for `local`.
   */
  scope?: VectorScope;
  /**
   * Per-call override for the trim cap applied to each document's text (chars). Defaults to
   * `contextMaxChars()` (env-tunable `VECTOR_CONTEXT_MAX_CHARS`, 2400) when omitted — so existing
   * callers (8-K summaries, disclosure docs) are byte-for-byte unchanged. `storeDocument` passes a
   * cap derived from the actual chunker token budget so an already-atomic, already-token-bounded
   * chunk (e.g. a table kept whole by chunkDocument) isn't silently re-truncated here.
   */
  maxChars?: number;
  /**
   * R10 (2026-07-01 RAG backlog): opt-in content_hash dedup for THIS storeContexts call. When set,
   * documents whose trimmed-text SHA-256 (the same `hashContent` helper `chunk.ts`/`storeDocument`
   * already use for dedup) is already present in `document_chunks` are skipped entirely — no Voyage
   * embed, no Pinecone upsert. Newly-indexed documents are recorded into `document_chunks` under a
   * synthetic `source` of `${dedupKeyPrefix}:<doc.metadata.source>` so this call's dedup namespace
   * never collides with `storeDocument`'s own per-source hashes (the two dedup populations are
   * intentionally kept in the same table but distinguishable by source prefix, since `document_chunks`
   * is keyed on content_hash ALONE — a real collision on identical text across sources is the
   * desired outcome: identical text truly doesn't need re-embedding twice).
   *
   * Default omitted/undefined = current behavior (always re-embeds), so `sec8k.ts`'s existing
   * unconditional refresh cadence and any other unmigrated caller is completely unaffected.
   * Keys on TEXT content, not accession/id — a genuinely-updated filing (different text) still
   * re-embeds even if the accession/contextId is stable.
   */
  dedupKeyPrefix?: string;
  /**
   * Reuse only exact, model/revision-matched document embeddings from a bounded process-local cache.
   * Pinecone records are still upserted once per input document with their own id and metadata; a
   * cache hit skips Voyage only, never the occurrence vector or its query-time filters/citation.
   */
  reuseExactEmbeddings?: boolean;
  /**
   * Optional durable-operation guard for long-running producers. The callback is invoked at each
   * provider/write boundary and the signal is forwarded to Voyage, so a producer that loses its
   * outer lease stops before another paid or persistent side effect.
   */
  leaseGuard?: VectorStoreLeaseGuard;
  /** Internal two-phase commit used by storeDocument. Pending records are first upserted, then this
   * exact local receipt callback runs, then the same records are re-upserted as committed. */
  managedCommit?: {
    /** Full source-document cardinality. Budget/dedup filtering must never shrink this commit set. */
    expectedRecordCount: number;
    /** Stable physical and logical ownership established before any managed record is built. */
    providerAuthority: string;
    ledgerAuthority: string;
    namespace: "managed" | "fmp-transcripts";
    persistReceipts: () => void;
    markCommitted: () => void;
  };
}

export interface VectorStoreLeaseGuard {
  assertOwnership: () => void;
  signal?: AbortSignal;
  /** Pin long-running licensed writes to the physical Pinecone index observed before work began. */
  expectedProviderAuthority?: string;
  /** Pin private writes to the durable SQLite namespace authority observed before work began. */
  expectedLedgerAuthority?: string;
}

function documentEmbeddingInput(document: ContextDocument): string {
  const source = document.embeddingText?.trim() || document.text;
  return embedCleanTextEnabled() ? stripPublishedPrefix(source) : source;
}

class VectorStoreLeaseLostError extends Error {
  constructor(cause?: unknown) {
    super(cause instanceof Error ? cause.message : "Vector-store operation lease was lost.", {
      cause: cause instanceof Error ? cause : undefined
    });
    this.name = "VectorStoreLeaseLostError";
  }
}

function assertVectorStoreLease(guard: VectorStoreLeaseGuard | undefined): void {
  if (!guard) return;
  if (guard.signal?.aborted) {
    throw new VectorStoreLeaseLostError(guard.signal.reason);
  }
  try {
    guard.assertOwnership();
  } catch (error) {
    throw new VectorStoreLeaseLostError(error);
  }
}

/**
 * One dead rag-embed call must not abort remaining batches or the rest of the store.
 * Lease loss still throws (concurrency boundary). Provider/network failures skip THIS
 * batch only — later batches still embed. Health already logs the lane via withRagApiHealth.
 */
async function embedDocumentsLaneOrSkip(
  voyage: unknown,
  inputs: string[],
  voyageSource: ApiKeySource,
  userId: string,
  leaseGuard: VectorStoreLeaseGuard | undefined
): Promise<{
  response?: { data?: unknown };
  rejected: number;
  reason?: ValidatedDocumentEmbeddingBatch["reason"];
  /** The real underlying failure (e.g. "Embedding API failed (isOpenRouter=false): 400 ...") so
   *  callers can classify permanent-vs-transient instead of only knowing "embed-api-failed"
   *  happened. See classifyEmbedFailure — losing this message is what let a real 400 get
   *  mislabeled as budget exhaustion and retried forever (2026-08-23 P0). */
  errorMessage?: string;
}> {
  try {
    const embedProvider = activeEmbeddingProvider(userId);
    const response = await withRagApiHealth(
      "voyage",
      voyageSource,
      userId,
      "embed documents",
      () => embedDocumentsWithRetry(voyage, inputs, voyageSource, userId, leaseGuard),
      leaseGuard,
      { durablyTrackedInside: true },
      { lane: "rag-embed", provider: embedProvider }
    );
    assertVectorStoreLease(leaseGuard);
    meterEmbed(inputs, activeEmbeddingModel(userId), userId, embedProvider);
    return { response, rejected: 0 };
  } catch (error) {
    if (error instanceof VectorStoreLeaseLostError) throw error;
    assertVectorStoreLease(leaseGuard);
    recordEmbedFailure(activeEmbeddingProvider(userId), "embed-api-failed");
    logWarn("embed.failed", { provider: activeEmbeddingProvider(userId), error_type: "embed-api-failed" });
    return {
      rejected: Math.max(1, inputs.length),
      reason: "embed-api-failed",
      errorMessage: error instanceof Error ? error.message : String(error)
    };
  }
}

/**
 * Token-pack already-condensed embed texts, then embed each in-window group on its own lane.
 * A singleton that still 400s skips only that group — companions in the count-32 batch still
 * upsert.  Integrity stays atomic per POST (`validateDocumentEmbeddingBatch`).  Does not mint
 * extra ContextDocuments or split table text.
 */
async function embedPackedInputGroups(
  voyage: unknown,
  inputs: string[],
  voyageSource: ApiKeySource,
  userId: string,
  leaseGuard: VectorStoreLeaseGuard | undefined
): Promise<{
  embeddingsByInputIndex: Array<number[] | undefined>;
  rejected: number;
  reason?: ValidatedDocumentEmbeddingBatch["reason"];
  /** Real failure text from the LAST rejected group this call, when the rejection was an actual
   *  embed-api-failed (never set for a plain validation/malformed-response rejection). */
  errorMessage?: string;
}> {
  const embeddingsByInputIndex = new Array<number[] | undefined>(inputs.length);
  if (inputs.length === 0) {
    return { embeddingsByInputIndex, rejected: 0 };
  }

  const packed = packInWindowTexts(
    inputs.map((text, sourceIndex) => ({ text, sourceIndex })),
    { maxCount: embedBatchSize() }
  );
  let rejected = 0;
  let reason: ValidatedDocumentEmbeddingBatch["reason"] | undefined;
  let errorMessage: string | undefined;
  let sent = false;
  for (const group of packed) {
    if (sent) await sleep(embedBatchDelayMs(), leaseGuard?.signal);
    sent = true;
    const groupTexts = group.map((item) => item.text);
    const embedResult = await embedDocumentsLaneOrSkip(
      voyage,
      groupTexts,
      voyageSource,
      userId,
      leaseGuard
    );
    if (embedResult.reason === "embed-api-failed" || !embedResult.response) {
      rejected += embedResult.rejected;
      reason = embedResult.reason ?? "embed-api-failed";
      if (embedResult.errorMessage) errorMessage = embedResult.errorMessage;
      continue;
    }
    const validated = validateDocumentEmbeddingBatch(embedResult.response.data, groupTexts.length);
    if (!validated.embeddings) {
      rejected += validated.rejected;
      reason = validated.reason;
      continue;
    }
    for (let i = 0; i < group.length; i++) {
      embeddingsByInputIndex[group[i]!.sourceIndex] = validated.embeddings[i]!;
    }
  }
  return { embeddingsByInputIndex, rejected, reason, errorMessage };
}

/** Serialize the complete lifecycle of one deterministic commit inside a process. A concurrent
 * replay waits for its predecessor, then reuses the proven committed occurrence set. This keeps
 * same-commit calls from resetting or finalizing each other's local/provider state. */
async function withSerializedVectorCommit<T>(
  commitId: string,
  guard: VectorStoreLeaseGuard | undefined,
  work: () => Promise<T>
): Promise<T> {
  const previous = vectorCommitSerializers.get(commitId) ?? Promise.resolve();
  let releaseTurn!: () => void;
  const turn = new Promise<void>((resolve) => {
    releaseTurn = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => turn);
  vectorCommitSerializers.set(commitId, tail);

  await previous.catch(() => undefined);
  try {
    assertVectorStoreLease(guard);
    return await work();
  } finally {
    releaseTurn();
    if (vectorCommitSerializers.get(commitId) === tail) vectorCommitSerializers.delete(commitId);
  }
}

async function settleRagSideEffect(
  effect: Promise<void>,
  leaseGuard: VectorStoreLeaseGuard | undefined
): Promise<void> {
  if (!leaseGuard) {
    // Preserve the established best-effort/non-blocking behavior for callers with no durable owner.
    void effect;
    return;
  }
  await effect;
  assertVectorStoreLease(leaseGuard);
}

/**
 * Store multiple context documents in one embedding/upsert flow. This keeps Pinecone index
 * creation centralized and avoids one Voyage/Pinecone round-trip per SEC filing.
 */
function effectiveStoreScope(userId: string, requestedScope: VectorScope | undefined): VectorScope {
  // Shared is an application-managed corpus owned by the local operator. A tenant-controlled
  // caller can never promote its own data into that cross-user tier, even by passing an internal
  // option directly rather than spoofing metadata.
  if (String(userId ?? "local") !== "local") return PRIVATE_SCOPE;
  return requestedScope ?? SHARED_SCOPE;
}

function userOperationLeaseGuard(
  claim: UserOperationClaim,
  existing: VectorStoreLeaseGuard | undefined
): VectorStoreLeaseGuard {
  return {
    ...(existing?.signal ? { signal: existing.signal } : {}),
    ...(existing?.expectedProviderAuthority
      ? { expectedProviderAuthority: existing.expectedProviderAuthority }
      : {}),
    ...(existing?.expectedLedgerAuthority
      ? { expectedLedgerAuthority: existing.expectedLedgerAuthority }
      : {}),
    assertOwnership: () => {
      existing?.assertOwnership();
      assertUserOperationClaim(claim);
    }
  };
}

export async function storeContexts(
  documents: ContextDocument[],
  userId: string = "local",
  options?: StoreContextsOptions
): Promise<StoreContextsResult> {
  assertVectorStoreLease(options?.leaseGuard);
  const scope = effectiveStoreScope(userId, options?.scope);
  const normalizedOptions: StoreContextsOptions = { ...options, scope };
  if (scope !== PRIVATE_SCOPE) {
    return storeContextsImpl(documents, userId, normalizedOptions);
  }

  // Hold one durable per-user operation claim across Voyage and Pinecone. Account deletion sees
  // the claim as a blocker, and every provider/write boundary reasserts it. A writer admitted
  // before deletion therefore finishes before the provider purge; one admitted after preparation
  // is rejected by the durable write epoch and cannot recreate private vectors after erasure.
  return withUserWriteOperation(userId, "vector-store-contexts", async (claim) => (
    storeContextsImpl(documents, userId, {
      ...normalizedOptions,
      leaseGuard: userOperationLeaseGuard(claim, options?.leaseGuard)
    })
  ));
}

async function storeContextsImpl(
  documents: ContextDocument[],
  userId: string,
  options: StoreContextsOptions
): Promise<StoreContextsResult> {
  assertVectorStoreLease(options?.leaseGuard);
  const vectorUserId = vectorUserIdFor(userId);
  const scope = effectiveStoreScope(userId, options.scope);
  const tenantScope = vectorTenantScope(userId, scope);
  const validDocuments = documents
    .map((doc) => {
      let text = doc.text;
      const timestamp = doc.metadata?.timestamp;
      if (timestamp) {
        let tsStr = "";
        if (typeof timestamp === "number") {
          try {
            tsStr = new Date(timestamp).toISOString();
          } catch {
            tsStr = String(timestamp);
          }
        } else if ((timestamp as any) instanceof Date) {
          try {
            tsStr = (timestamp as any).toISOString();
          } catch {}
        } else {
          tsStr = String(timestamp).trim();
        }

        const dateMatch = tsStr.match(/^(\d{4}-\d{2}-\d{2})/);
        if (dateMatch) {
          const dateStr = dateMatch[1];
          const prefix = `[Published: ${dateStr}]`;
          if (!text.startsWith("[Published:")) {
            text = `${prefix} ${text}`;
          }
        }
      }
      // Atomic table chunks (chunk.ts never splits a table, regardless of token count) are EXEMPT
      // from char trimming — truncating mid-row would corrupt numeric data, which is worse than a
      // large vector. content_hash (computed pre-trim in chunk.ts) stays consistent with the stored
      // text specifically because this chunk never gets trimmed.
      const isTable = doc.metadata?.is_table === true;
      const storedText = isTable ? text.trim() : trimContextText(text, options?.maxChars);
      const rawEmbeddingText = doc.embeddingText?.trim();
      const embeddingText = rawEmbeddingText
        ? (isTable ? rawEmbeddingText : trimContextText(rawEmbeddingText, options?.maxChars))
        : undefined;
      return { ...doc, text: storedText, ...(embeddingText ? { embeddingText } : {}) };
    })
    .filter((doc) => doc.text.length > 0);
  if (validDocuments.length === 0) return { attempted: 0, indexed: 0 };
  const writeBackend = vectorWriteBackend();
  // Monthly Pinecone write-unit breaker — gate BEFORE dedup bookkeeping, budgets, and (most
  // importantly) any paid embed call. While the marker is active every upsert would 429, and
  // because content-hash dedup only records STORED documents, embedding here is pure spend
  // with no possible benefit. Auto-resumes when the marker expires (first of next month UTC).
  // Qdrant writes are self-hosted and must not inherit a dead Pinecone WU park.
  if (writeBackend === "pinecone") {
    const wuExhaustedUntil = pineconeWuExhaustedUntil();
    if (wuExhaustedUntil) {
      auditPineconeWuGateSkip(
        { operation: "storeContexts", attempted: validDocuments.length, until: wuExhaustedUntil },
        userId
      );
      return { attempted: validDocuments.length, indexed: 0, skipped: true, wuExhausted: true, wuExhaustedUntil };
    }
  }
  if (writeBackend === "qdrant" && !hasRagIngestPointsBudget(userId, validDocuments.length, "qdrant")) {
    console.warn(
      `[vector-db] Qdrant daily point ingestion budget exceeded for ${userId}; skipping storeContexts of ${validDocuments.length} docs.`
    );
    return {
      attempted: validDocuments.length,
      indexed: 0,
      skipped: true,
      writeUnitBudgetSkipped: validDocuments.length
    };
  }
  const privateLedgerAuthority = scope === PRIVATE_SCOPE && !options?.managedCommit
    ? managedVectorLedgerAuthority()
    : undefined;
  // R10 (2026-07-01 RAG backlog): opt-in content_hash dedup for this call, gated on
  // `dedupKeyPrefix` being set. Reuses the same SHA-256-first-16 `hashContent` helper
  // `storeDocument`/`chunk.ts` use, and the same `document_chunks` table/CRUD — keyed on the
  // FINAL (post-trim) text of each document so a repeat call with byte-identical text (e.g. an
  // unchanged 8-K summary re-embedded on every refresh cycle) is skipped before any Voyage/Pinecone
  // call. Default (dedupKeyPrefix unset) = current behavior, always re-embeds.
  const dedupPrefix = options?.dedupKeyPrefix;
  let dedupHashes: Array<{ content_hash: string; symbol: string; source: string; chunk_id: string }> | undefined;
  let documentsToStore = validDocuments;
  let skippedByDedup = 0;
  if (dedupPrefix) {
    dedupHashes = validDocuments.map((doc) => ({
      content_hash: hashContent(doc.text),
      symbol: doc.metadata?.symbol ?? "",
      source: `${dedupPrefix}:${doc.metadata?.source ?? ""}`,
      chunk_id: contextId(doc, 0)
    }));
    const newHashes = filterNewDocumentChunks(dedupHashes);
    const newHashSet = new Set(newHashes.map((h) => h.content_hash));
    documentsToStore = validDocuments.filter((_doc, i) => newHashSet.has(dedupHashes![i]!.content_hash));
    skippedByDedup = validDocuments.length - documentsToStore.length;
    if (skippedByDedup > 0) {
      console.log(`[vector-db] Content-hash dedup (storeContexts, prefix="${dedupPrefix}"): ${skippedByDedup}/${validDocuments.length} document(s) already indexed, skipping.`);
    }
    // Re-key dedupHashes/documentsToStore in lockstep so the later insertDocumentChunks call
    // below can zip surviving documents back to their hashes without recomputing anything.
    dedupHashes = documentsToStore.map((doc) => ({
      content_hash: hashContent(doc.text),
      symbol: doc.metadata?.symbol ?? "",
      source: `${dedupPrefix}:${doc.metadata?.source ?? ""}`,
      chunk_id: contextId(doc, 0)
    }));
  }
  if (documentsToStore.length === 0) {
    return { attempted: validDocuments.length, indexed: 0, skipped: true, dedupComplete: true };
  }

  const reuseExactEmbeddings = options?.reuseExactEmbeddings === true;
  // Durable embed stage (db-embed-stage.ts, embed-once directive 2026-08-09). Keyed exactly
  // like the L1 process cache: hashContent() of the EXACT embed-input text + model + embed
  // revision. Rows only exist between a paid embed and its successful Pinecone delivery, so a
  // stage hit is always a vector a prior FAILED attempt already paid OpenRouter for.
  const stageModel = activeEmbeddingModel(userId);
  const stageRevision = String(currentEmbedRev());
  // Documents whose vector has a durable stage row this call (consumed hit OR freshly staged);
  // their rows are deleted only once the vectors are durably delivered to Pinecone.
  const stageHashByDocument = new Map<ContextDocument, string>();
  let embedsFromStage = 0;
  const cachedDocumentEmbeddings = new Map<ContextDocument, number[]>();
  const uniqueMissingEmbeddingInputs: string[] = [];
  const missingEmbeddingInputSet = new Set<string>();
  if (reuseExactEmbeddings) {
    const documentsByMissingInput = new Map<string, ContextDocument[]>();
    for (const document of documentsToStore) {
      const input = documentEmbeddingInput(document);
      const cached = getCachedDocumentEmbedding(input, userId);
      if (cached) {
        cachedDocumentEmbeddings.set(document, cached);
      } else {
        const siblings = documentsByMissingInput.get(input);
        if (siblings) siblings.push(document);
        else documentsByMissingInput.set(input, [document]);
        if (!missingEmbeddingInputSet.has(input)) {
          missingEmbeddingInputSet.add(input);
          uniqueMissingEmbeddingInputs.push(input);
        }
      }
    }
    // L2 after L1: consuming staged vectors here both skips the provider call below and keeps
    // already-paid inputs out of the paid-embed ingest-budget accounting.
    if (uniqueMissingEmbeddingInputs.length > 0) {
      try {
        const stagedByHash = getStagedEmbeddings(
          uniqueMissingEmbeddingInputs.map(hashContent),
          stageModel,
          stageRevision
        );
        if (stagedByHash.size > 0) {
          const stillMissing: string[] = [];
          for (const input of uniqueMissingEmbeddingInputs) {
            const hash = hashContent(input);
            const staged = stagedByHash.get(hash);
            if (staged && isValidEmbedding(staged)) {
              embedsFromStage += 1;
              setCachedDocumentEmbedding(input, staged, userId);
              for (const document of documentsByMissingInput.get(input) ?? []) {
                cachedDocumentEmbeddings.set(document, [...staged]);
                stageHashByDocument.set(document, hash);
              }
            } else {
              stillMissing.push(input);
            }
          }
          uniqueMissingEmbeddingInputs.length = 0;
          uniqueMissingEmbeddingInputs.push(...stillMissing);
          missingEmbeddingInputSet.clear();
          for (const input of stillMissing) missingEmbeddingInputSet.add(input);
        }
      } catch (err) {
        console.warn(
          "[vector-db] embed-stage lookup failed (non-fatal; will embed normally):",
          err instanceof Error ? err.message : String(err)
        );
      }
    }
  }

  let budgetSkipped = 0;
  assertVectorStoreLease(options?.leaseGuard);
  const requestedEmbeddingTexts = reuseExactEmbeddings
    ? uniqueMissingEmbeddingInputs.length
    : documentsToStore.length;
  const budget = remainingIngestTexts(userId, requestedEmbeddingTexts);
  if (budget.allowed < requestedEmbeddingTexts) {
    const providerTextsSkipped = requestedEmbeddingTexts - budget.allowed;
    const beforeBudgetDocuments = documentsToStore;
    const beforeBudgetHashes = dedupHashes;
    if (reuseExactEmbeddings) {
      const allowedMissingInputs = new Set(uniqueMissingEmbeddingInputs.slice(0, budget.allowed));
      const keptIndexes: number[] = [];
      for (let index = 0; index < beforeBudgetDocuments.length; index++) {
        const document = beforeBudgetDocuments[index]!;
        if (cachedDocumentEmbeddings.has(document) || allowedMissingInputs.has(documentEmbeddingInput(document))) {
          keptIndexes.push(index);
        }
      }
      documentsToStore = keptIndexes.map((index) => beforeBudgetDocuments[index]!);
      if (beforeBudgetHashes) dedupHashes = keptIndexes.map((index) => beforeBudgetHashes[index]!);
      budgetSkipped = beforeBudgetDocuments.length - documentsToStore.length;
    } else {
      budgetSkipped = beforeBudgetDocuments.length - budget.allowed;
      documentsToStore = beforeBudgetDocuments.slice(0, budget.allowed);
      if (beforeBudgetHashes) dedupHashes = beforeBudgetHashes.slice(0, budget.allowed);
    }
    const budgetPayload = {
      requested: requestedEmbeddingTexts,
      allowed: budget.allowed,
      skipped: providerTextsSkipped,
      skippedOccurrences: budgetSkipped,
      usedLast24h: budget.used,
      limitPer24h: budget.limit
    };
    audit("vector_ingest_budget", budgetPayload, userId);
    await settleRagSideEffect(alertUsageLimitHit({
      userId,
      // Was hardcoded "Voyage" — now that the ingest budget counts embeds from ANY provider (see
      // remainingIngestTexts above), the alert must say which provider actually hit the cap.
      provider: activeEmbeddingProvider(userId),
      operation: "embed-budget",
      limitName: "RAG ingest text daily cap",
      status: budget.allowed === 0 ? "exceeded" : "warning",
      used: budget.used,
      limit: budget.limit,
      attempted: requestedEmbeddingTexts,
      skipped: providerTextsSkipped,
      unit: "texts",
      recommendation:
        "If this happened during a deliberate backfill, raise RAG_INGEST_MAX_TEXTS_PER_DAY temporarily. If it happened during normal use, inspect deduping and ingestion cadence first."
    }, {
      assertActive: options?.leaseGuard ? () => assertVectorStoreLease(options.leaseGuard) : undefined,
      signal: options?.leaseGuard?.signal
    }), options?.leaseGuard);
    // Cooldown-gated: a persistent daily-budget exhaustion must page ONCE per window, not once
    // per document/tick. Without this gate, SOCRATIC-TRADE-27 fired 8,036 times in 2 days (every
    // SEC ingest worker tick re-hit the same exhausted budget) and buried the handful of real
    // "embed connection failed" events underneath an identical-looking flood of warnings.
    if (shouldEmitRagIngestBudgetSentry(userId)) {
      await settleRagSideEffect(captureRagSentryMessage("warning", "RAG ingest text budget reached", {
        provider: activeEmbeddingProvider(userId),
        operation: "embed-budget",
        // Explicit lane (not just `provider`) so this budget condition fingerprints as its own
        // Sentry issue and can never collide with the rag-embed/rag-rerank connection-failure
        // lanes that fall back to `provider` when no lane is set — see captureRagSentryMessage's
        // groupKey selection.
        lane: "rag-ingest-budget",
        source: userId === "local" ? "operator" : "user",
        requested: requestedEmbeddingTexts,
        allowed: budget.allowed,
        skipped: providerTextsSkipped,
        skippedOccurrences: budgetSkipped,
        usedLast24h: budget.used,
        limitPer24h: budget.limit
      }, options?.leaseGuard), options?.leaseGuard);
    }
    if (documentsToStore.length === 0) {
      const lastIngest = {
        at: new Date().toISOString(),
        attempted: validDocuments.length,
        indexed: 0,
        budgetSkipped,
        budget: budgetPayload
      };
      setInternalSetting(LAST_INGEST_KEY, lastIngest);
      audit("vector_store", { ok: true, attempted: validDocuments.length, indexed: 0, budgetSkipped }, userId);
      return { attempted: validDocuments.length, indexed: 0, skipped: true, budgetSkipped };
    }
  }

  let writeUnitBudgetSkipped = 0;
  assertVectorStoreLease(options?.leaseGuard);
  if (writeBackend === "pinecone") {
    const writeBudget = applyPineconeWriteBudget(documentsToStore, userId, vectorUserId, scope, tenantScope, Boolean(options?.managedCommit));
    if (writeBudget.skipped > 0) {
      writeUnitBudgetSkipped = writeBudget.skipped;
      const budgetPayload = {
        requestedEstimatedWriteUnits: writeBudget.requested,
        allowedEstimatedWriteUnits: writeBudget.allowed,
        skipped: writeUnitBudgetSkipped,
        usedLast24h: writeBudget.used,
        limitPer24h: writeBudget.limit
      };
      await notifyPineconeDailyWriteFuse({
        userId,
        used: writeBudget.used,
        limit: writeBudget.limit,
        requested: writeBudget.requested,
        skipped: writeUnitBudgetSkipped,
        exceeded: writeBudget.documents.length === 0,
        leaseGuard: options?.leaseGuard
      });
      if (writeBudget.documents.length === 0) {
        const lastIngest = {
          at: new Date().toISOString(),
          attempted: validDocuments.length,
          indexed: 0,
          writeUnitBudgetSkipped,
          writeBudget: budgetPayload
        };
        setInternalSetting(LAST_INGEST_KEY, lastIngest);
        audit("vector_store", { ok: true, attempted: validDocuments.length, indexed: 0, writeUnitBudgetSkipped }, userId);
        return { attempted: validDocuments.length, indexed: 0, skipped: true, budgetSkipped, writeUnitBudgetSkipped };
      }
      documentsToStore = writeBudget.documents;
      if (dedupHashes) dedupHashes = dedupHashes.slice(0, documentsToStore.length);
    }
  }

  const { pc, voyage, initCacheKey, pineconeSource, voyageSource } = await getClients(
    userId,
    options?.leaseGuard,
    { skipMissingPineconeAlert: writeBackend === "qdrant" }
  );
  const activeProvider = activeEmbeddingProvider(userId);
  const hasActiveKey = !!voyage || (resolveApiKey(activeProvider, userId) != null);
  if (writeBackend === "qdrant") {
    if (!hasActiveKey) {
      console.log(`[vector-db] Skipping storeContexts: Missing ${activeProvider} key.`);
      await settleRagSideEffect(captureRagSentryMessage("warning", `RAG store skipped: missing ${activeProvider} key`, {
        provider: activeProvider,
        operation: "storeContexts",
        source: userId === "local" ? "operator" : "user",
        attempted: validDocuments.length
      }, options?.leaseGuard), options?.leaseGuard);
      audit("vector_store", { ok: false, attempted: validDocuments.length, indexed: 0, skipped: true, reason: `missing ${activeProvider} key` }, userId);
      return { attempted: validDocuments.length, indexed: 0, skipped: true, unconfigured: true };
    }
  } else if (!pc || !hasActiveKey) {
    console.log(`[vector-db] Skipping storeContexts: Missing Pinecone or ${activeProvider} keys.`);
    await settleRagSideEffect(captureRagSentryMessage("warning", `RAG store skipped: missing Pinecone or ${activeProvider} key`, {
      provider: !pc ? "pinecone" : activeProvider,
      operation: "storeContexts",
      source: userId === "local" ? "operator" : "user",
      attempted: validDocuments.length
    }, options?.leaseGuard), options?.leaseGuard);
    audit("vector_store", { ok: false, attempted: validDocuments.length, indexed: 0, skipped: true, reason: `missing Pinecone/${activeProvider} keys` }, userId);
    return { attempted: validDocuments.length, indexed: 0, skipped: true, unconfigured: true };
  }

  let indexed = 0;
  let rejectedInvalidEmbeddings = 0;
  let malformedEmbeddingCount = 0;
  // Real embed-api-failed text (e.g. an HTTP 400/429 body), captured so the caller (storeDocument
  // -> SEC ingest worker) can classify the ACTUAL failure instead of only seeing
  // rejectedInvalidEmbeddings > 0 with no reason attached — see classifyEmbedFailure.
  let embedFailureMessage: string | undefined;
  const managedRecordBatches: Array<PineconeRecord<RecordMetadata>[]> = [];
  // Managed two-phase commits keep their embed_stage rows until the committed re-upsert AND
  // markCommitted() succeed: a mid-commit failure aborts and re-runs the whole document, and
  // that retry must still find the paid vectors after a process restart.
  const stageHashesPendingCommit: string[] = [];
  // R10: content_hash of each document actually upserted (not rejected by the R2 integrity
  // guard), keyed by identity against `documentsToStore` — only recorded into document_chunks
  // (via insertDocumentChunks below) when dedup is active for this call.
  const indexedDocIdentities = new Set<ContextDocument>();
  try {
    assertVectorStoreLease(options?.leaseGuard);
    const namespaceName = options?.managedCommit
      ? vectorNamespaceName(options.managedCommit.namespace, options.managedCommit.ledgerAuthority)
      : scope === PRIVATE_SCOPE
        ? vectorNamespaceName("private", privateLedgerAuthority, userId)
        : vectorNamespaceName("default");
    let stableProviderAuthority: string | undefined;
    let index: ReturnType<typeof vectorDataIndex> | undefined;
    if (writeBackend === "qdrant") {
      const ledgerForAuthority = options?.managedCommit?.ledgerAuthority
        ?? privateLedgerAuthority
        ?? managedVectorLedgerAuthority();
      stableProviderAuthority = options?.managedCommit?.providerAuthority
        ?? resolveQdrantWriteProviderAuthority(ledgerForAuthority);
    } else {
      await ensureIndex(pc!, initCacheKey, pineconeSource, userId, options?.leaseGuard);
      assertVectorStoreLease(options?.leaseGuard);
      stableProviderAuthority = stableProviderAuthorityForInitKey(initCacheKey);
      index = options?.managedCommit
        ? vectorDataIndex(pc!, options.managedCommit.namespace, options.managedCommit.ledgerAuthority)
        : scope === PRIVATE_SCOPE
          ? vectorDataIndex(pc!, "private", privateLedgerAuthority, userId)
          : vectorDataIndex(pc!, "default");
    }
    if (
      options?.leaseGuard?.expectedProviderAuthority &&
      stableProviderAuthority !== options.leaseGuard.expectedProviderAuthority
    ) {
      throw new VectorStoreLeaseLostError("Private vector provider authority changed during licensed work.");
    }
    if (
      options?.leaseGuard?.expectedLedgerAuthority &&
      privateLedgerAuthority !== options.leaseGuard.expectedLedgerAuthority
    ) {
      throw new VectorStoreLeaseLostError("Private vector ledger authority changed during licensed work.");
    }
    if (privateLedgerAuthority) {
      if (!stableProviderAuthority) throw new Error("private-vector-provider-authority-unavailable");
      ensurePrivateVectorNamespaceManifest(userId, privateLedgerAuthority, stableProviderAuthority);
    }
    if (options?.managedCommit && stableProviderAuthority !== options.managedCommit.providerAuthority) {
      throw new Error("managed-vector-provider-authority-unavailable");
    }
    const providerAuthority = options?.managedCommit?.providerAuthority
      ?? stableProviderAuthority
      ?? (initCacheKey ? providerAuthorityForInitKey(initCacheKey) : qdrantProviderAuthority());
    const batches = chunks(documentsToStore, embedBatchSize());

    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
      const batch = batches[batchIndex];
      if (!batch) continue;
      if (batchIndex > 0) await sleep(embedBatchDelayMs(), options?.leaseGuard?.signal);
      assertVectorStoreLease(options?.leaseGuard);
      // The stored citation text and the text embedded by Voyage can intentionally differ:
      // storeDocument retains occurrence-specific headers for display while embedding exact raw
      // chunk content. Exact cache hits skip Voyage only; every document below still gets its own
      // Pinecone id/metadata record and therefore remains independently queryable by symbol/PIT.
      const embedInputs = batch.map(documentEmbeddingInput);
      const resolved = new Array<number[] | undefined>(batch.length);
      let rejected = 0;
      let rejectionReason: ValidatedDocumentEmbeddingBatch["reason"];

      if (reuseExactEmbeddings) {
        const missingInputs: string[] = [];
        const missingPositions = new Map<string, number[]>();
        for (let indexInBatch = 0; indexInBatch < batch.length; indexInBatch++) {
          const document = batch[indexInBatch]!;
          const input = embedInputs[indexInBatch]!;
          const cached = cachedDocumentEmbeddings.get(document) ?? getCachedDocumentEmbedding(input, userId);
          if (cached) {
            resolved[indexInBatch] = cached;
            continue;
          }
          const positions = missingPositions.get(input);
          if (positions) positions.push(indexInBatch);
          else {
            missingInputs.push(input);
            missingPositions.set(input, [indexInBatch]);
          }
        }

        if (missingInputs.length > 0) {
          // Pack after hybrid condense.  One over-limit singleton skips that POST only;
          // companions in this count-32 batch still embed.  Integrity stays atomic per POST.
          const packedResult = await embedPackedInputGroups(
            voyage,
            missingInputs,
            voyageSource,
            userId,
            options?.leaseGuard
          );
          rejected += packedResult.rejected;
          if (packedResult.reason) rejectionReason = packedResult.reason;
          if (packedResult.errorMessage) embedFailureMessage = packedResult.errorMessage;
          const successfulInputs: string[] = [];
          const successfulEmbeddings: number[][] = [];
          for (let inputIndex = 0; inputIndex < missingInputs.length; inputIndex++) {
            const embedding = packedResult.embeddingsByInputIndex[inputIndex];
            if (!embedding) continue;
            const input = missingInputs[inputIndex]!;
            setCachedDocumentEmbedding(input, embedding, userId);
            for (const position of missingPositions.get(input) ?? []) resolved[position] = [...embedding];
            successfulInputs.push(input);
            successfulEmbeddings.push(embedding);
          }
          if (successfulInputs.length > 0) {
            try {
              stageEmbeddedVectors(successfulInputs.map((input, inputIndex) => {
                const hash = hashContent(input);
                const positions = missingPositions.get(input) ?? [];
                for (const position of positions) stageHashByDocument.set(batch[position]!, hash);
                const representative = batch[positions[0] ?? 0]!;
                return {
                  contentHash: hash,
                  model: stageModel,
                  revision: stageRevision,
                  vector: successfulEmbeddings[inputIndex]!,
                  symbol: representative.metadata?.symbol ?? "",
                  source: representative.metadata?.source ?? "",
                  chunkId: typeof representative.metadata?.chunk_id === "string"
                    ? representative.metadata.chunk_id
                    : "",
                  userScope: userId
                };
              }));
            } catch (err) {
              console.warn(
                "[vector-db] embed-stage persist failed (non-fatal):",
                err instanceof Error ? err.message : String(err)
              );
            }
          }
        }
      } else {
        // Durable embed stage (L2) first — a hit is a vector a prior FAILED attempt already
        // paid for (rows only exist between a paid embed and a successful upsert), so consuming
        // it is exactly the embed-once guarantee. The always-re-embed refresh semantics of this
        // branch are otherwise unchanged: after a successful upsert the stage rows are deleted,
        // so a routine refresh cycle never finds a hit here.
        const inputHashes = embedInputs.map(hashContent);
        let stagedByHash = new Map<string, number[]>();
        try {
          stagedByHash = getStagedEmbeddings(inputHashes, stageModel, stageRevision);
        } catch (err) {
          console.warn(
            "[vector-db] embed-stage lookup failed (non-fatal; will embed normally):",
            err instanceof Error ? err.message : String(err)
          );
        }
        const toEmbedPositions: number[] = [];
        for (let indexInBatch = 0; indexInBatch < batch.length; indexInBatch++) {
          const staged = stagedByHash.get(inputHashes[indexInBatch]!);
          if (staged && isValidEmbedding(staged)) {
            resolved[indexInBatch] = [...staged];
            stageHashByDocument.set(batch[indexInBatch]!, inputHashes[indexInBatch]!);
            embedsFromStage += 1;
          } else {
            toEmbedPositions.push(indexInBatch);
          }
        }

        if (toEmbedPositions.length > 0) {
          const toEmbedInputs = toEmbedPositions.map((position) => embedInputs[position]!);
          const packedResult = await embedPackedInputGroups(
            voyage,
            toEmbedInputs,
            voyageSource,
            userId,
            options?.leaseGuard
          );
          rejected += packedResult.rejected;
          if (packedResult.reason) rejectionReason = packedResult.reason;
          if (packedResult.errorMessage) embedFailureMessage = packedResult.errorMessage;
          const stagedDocs: Array<{ position: number; embedding: number[] }> = [];
          for (let embedIndex = 0; embedIndex < toEmbedPositions.length; embedIndex++) {
            const embedding = packedResult.embeddingsByInputIndex[embedIndex];
            if (!embedding) continue;
            const position = toEmbedPositions[embedIndex]!;
            resolved[position] = embedding;
            stagedDocs.push({ position, embedding });
          }
          if (stagedDocs.length > 0) {
            try {
              stageEmbeddedVectors(stagedDocs.map(({ position, embedding }) => {
                const document = batch[position]!;
                stageHashByDocument.set(document, inputHashes[position]!);
                return {
                  contentHash: inputHashes[position]!,
                  model: stageModel,
                  revision: stageRevision,
                  vector: embedding,
                  symbol: document.metadata?.symbol ?? "",
                  source: document.metadata?.source ?? "",
                  chunkId: typeof document.metadata?.chunk_id === "string"
                    ? document.metadata.chunk_id
                    : "",
                  userScope: userId
                };
              }));
            } catch (err) {
              console.warn(
                "[vector-db] embed-stage persist failed (non-fatal):",
                err instanceof Error ? err.message : String(err)
              );
            }
          }
        }
      }

      const records: PineconeRecord<RecordMetadata>[] = [];
      for (let indexInBatch = 0; indexInBatch < batch.length; indexInBatch++) {
        const embedding = resolved[indexInBatch];
        if (!isValidEmbedding(embedding)) continue;
        const document = batch[indexInBatch]!;
        indexedDocIdentities.add(document);
        records.push({
          id: contextId(document, indexInBatch),
          values: embedding,
          metadata: cleanMetadata(
            document.metadata,
            document.text,
            vectorUserId,
            scope,
            tenantScope,
            providerAuthority,
            options?.managedCommit?.ledgerAuthority
          )
        });
      }
      const failedCount = batch.length - records.length;
      if (failedCount > 0) {
        const batchRejects = rejected > 0 ? rejected : Math.max(1, failedCount);
        rejectedInvalidEmbeddings += batchRejects;
        if (rejectionReason !== "embed-api-failed" && rejectionReason !== "embed-api-skipped") {
          malformedEmbeddingCount += batchRejects;
        }
        assertVectorStoreLease(options?.leaseGuard);
        if (records.length === 0) {
          console.warn(
            `[vector-db] Rejected Voyage document embedding batch (${rejectionReason ?? "invalid-response"}; expected=${batch.length}) — no records from this batch were upserted; remaining batches continue.`
          );
          continue;
        }
        console.warn(
          `[vector-db] Isolated ${failedCount} over-limit or failed embed(s) from a ${batch.length}-document batch (${rejectionReason ?? "invalid-response"}); companions still upsert.`
        );
      }

      if (records.length > 0) {
        assertVectorStoreLease(options?.leaseGuard);
        const upsertOperation = options?.managedCommit?.namespace === "fmp-transcripts"
          ? "upsert fmp transcript vectors"
          : records.some((record) => record.metadata?.fmp_derived === true)
            ? "upsert fmp-derived private memory"
            : "upsert";
        if (writeBackend === "qdrant") {
          await qdrantUpsertPoints({ namespace: namespaceName, records, userId });
          meterQdrantUpsert(records.length, userId);
        } else {
          const estimatedWriteUnits = estimatePineconeWriteUnitsForRecords(records);
          // Pinecone JS SDK v8 takes an options object ({ records }), not a bare array.
          await withRagApiHealth(
            "pinecone",
            pineconeSource,
            userId,
            upsertOperation,
            () => index!.upsert({ records } as any),
            options?.leaseGuard
          );
          meterPineconeUpsert(records.length, userId, estimatedWriteUnits);
        }
        assertVectorStoreLease(options?.leaseGuard);
        indexed += records.length;
        if (options?.managedCommit) managedRecordBatches.push(records);
        // Delivered: this batch's vectors are now in Pinecone, so their "paid but not yet
        // delivered" stage rows can go (plain calls delete per batch; managed commits defer
        // until the committed re-upsert + finalize). Best-effort — a stray row is swept by
        // the 35-day retention lane, never re-upserted incorrectly.
        const deliveredStageHashes = batch
          .filter((document) => indexedDocIdentities.has(document))
          .map((document) => stageHashByDocument.get(document))
          .filter((hash): hash is string => typeof hash === "string");
        if (deliveredStageHashes.length > 0) {
          if (options?.managedCommit) {
            stageHashesPendingCommit.push(...deliveredStageHashes);
          } else {
            try {
              deleteStagedEmbeddings(deliveredStageHashes, stageModel, stageRevision);
            } catch (err) {
              console.warn(
                "[vector-db] embed-stage delete failed (non-fatal; retention lane will sweep):",
                err instanceof Error ? err.message : String(err)
              );
            }
          }
        }
      }
    }

    if (
      options?.managedCommit &&
      rejectedInvalidEmbeddings === 0 &&
      documentsToStore.length === options.managedCommit.expectedRecordCount &&
      indexed === options.managedCommit.expectedRecordCount
    ) {
      assertVectorStoreLease(options.leaseGuard);
      try {
        // This is the exact relational receipt transaction. Provider records are still pending and
        // server-side retrieval filters exclude them if this callback throws.
        options.managedCommit.persistReceipts();
      } catch (error) {
        throw new Error("document-receipt-write-failed", { cause: error });
      }
      assertVectorStoreLease(options.leaseGuard);
      for (const pendingRecords of managedRecordBatches) {
        const committedRecords = pendingRecords.map((record) => ({
          ...record,
          metadata: { ...record.metadata, ingest_state: "committed" }
        }));
        if (writeBackend === "qdrant") {
          await qdrantUpsertPoints({
            namespace: namespaceName,
            records: committedRecords,
            userId,
            replacingExisting: true
          });
        } else {
          const estimatedWriteUnits = estimatePineconeWriteUnitsForRecords(committedRecords);
          await withRagApiHealth(
            "pinecone",
            pineconeSource,
            userId,
            options.managedCommit.namespace === "fmp-transcripts"
              ? "commit fmp transcript vectors"
              : "commit managed vectors",
            () => index!.upsert({ records: committedRecords } as any),
            options.leaseGuard,
            { units: 1 }
          );
          meterPineconeUpsert(committedRecords.length, userId, estimatedWriteUnits);
        }
        assertVectorStoreLease(options.leaseGuard);
      }
      try {
        options.managedCommit.markCommitted();
      } catch (error) {
        throw new Error("document-local-commit-finalize-failed", { cause: error });
      }
      // The document is fully committed (pending + committed upserts + receipts + finalize) —
      // only now are the managed call's paid vectors provably delivered.
      if (stageHashesPendingCommit.length > 0) {
        try {
          deleteStagedEmbeddings(stageHashesPendingCommit, stageModel, stageRevision);
        } catch (err) {
          console.warn(
            "[vector-db] embed-stage delete failed (non-fatal; retention lane will sweep):",
            err instanceof Error ? err.message : String(err)
          );
        }
      }
      assertVectorStoreLease(options.leaseGuard);
    }

    if (malformedEmbeddingCount > 0) {
      assertVectorStoreLease(options?.leaseGuard);
      audit("vector_embedding_integrity", { rejected: malformedEmbeddingCount, attempted: validDocuments.length }, userId);
      await captureRagSentryMessage("warning", "RAG document embedding integrity rejection", {
        provider: activeEmbeddingProvider(userId),
        operation: "embed documents",
        source: voyageSource,
        attempted: validDocuments.length,
        rejected: malformedEmbeddingCount
      }, options?.leaseGuard);
    }
    assertVectorStoreLease(options?.leaseGuard);
    console.log(`[vector-db] Indexed ${indexed}/${validDocuments.length} context document(s).${rejectedInvalidEmbeddings > 0 ? ` (${rejectedInvalidEmbeddings} rejected/failed)` : ""}`);

    // Receipt for the embed-once guarantee: how many provider embed calls this call avoided by
    // replaying previously-paid vectors from the durable stage. One audit row per store call
    // (not per batch) so a large recovery drain cannot flood audit_events.
    if (embedsFromStage > 0) {
      audit(
        "embed_stage_replay",
        { embedsAvoided: embedsFromStage, attempted: validDocuments.length, indexed, batches: batches.length },
        userId
      );
      console.log(`[vector-db] Embed stage replay: ${embedsFromStage} previously-paid embedding(s) reused without a provider call.`);
    }

    // R10: record newly-indexed content hashes so a repeat storeContexts call with the same
    // dedupKeyPrefix and byte-identical text skips re-embedding next time. Best-effort — a
    // failure here must not fail the store (the record was already upserted to Pinecone).
    if (dedupPrefix && dedupHashes && indexedDocIdentities.size > 0 && rejectedInvalidEmbeddings === 0) {
      assertVectorStoreLease(options?.leaseGuard);
      const toRecord = documentsToStore
        .map((doc, i) => (indexedDocIdentities.has(doc) ? dedupHashes![i] : undefined))
        .filter((h): h is { content_hash: string; symbol: string; source: string; chunk_id: string } => h != null);
      try {
        insertDocumentChunks(toRecord);
      } catch (err) {
        console.warn("[vector-db] insertDocumentChunks failed (non-fatal, storeContexts dedup path):", err instanceof Error ? err.message : String(err));
      }
    }

    // Persist the outcome so RAG ingestion health is visible in the audit log / dashboard
    // instead of being swallowed to console (the original cause of the silent empty index).
    const lastIngest = {
      at: new Date().toISOString(),
      attempted: validDocuments.length,
      indexed,
      ...(embedsFromStage > 0 ? { embedsFromStage } : {}),
      ...(budgetSkipped > 0 ? { budgetSkipped } : {}),
      ...(writeUnitBudgetSkipped > 0 ? { writeUnitBudgetSkipped } : {})
    };
    assertVectorStoreLease(options?.leaseGuard);
    setInternalSetting(LAST_INGEST_KEY, lastIngest);
    audit("vector_store", { ok: true, attempted: validDocuments.length, indexed, rejectedInvalidEmbeddings, ...(embedsFromStage > 0 ? { embedsFromStage } : {}), ...(budgetSkipped > 0 ? { budgetSkipped } : {}), ...(writeUnitBudgetSkipped > 0 ? { writeUnitBudgetSkipped } : {}) }, userId);
    return {
      attempted: validDocuments.length,
      indexed,
      ...(embedsFromStage > 0 ? { embedsFromStage } : {}),
      ...(rejectedInvalidEmbeddings > 0 ? { rejectedInvalidEmbeddings } : {}),
      ...(budgetSkipped > 0 ? { budgetSkipped } : {}),
      ...(writeUnitBudgetSkipped > 0 ? { writeUnitBudgetSkipped } : {}),
      // Surfaces the real embed-api failure (HTTP status/body) even though this call did not
      // throw — a batch-isolated embed failure just drops that batch's records and continues.
      // Deliberately NOT `error` (reserved below for "the whole call threw"; existing callers
      // treat a present `error` as a total failure). Without this, storeDocument's caller only
      // saw rejectedInvalidEmbeddings > 0 with no reason, and fell back to a generic "budget
      // exceeded" guess (2026-08-23 P0) — see classifyEmbedFailure.
      ...(embedFailureMessage ? { embedFailureMessage } : {})
    };
  } catch (err) {
    // Lease loss is a concurrency boundary, not a provider failure. Propagate it without writing
    // success/failure ledgers after ownership has moved to a successor. Voyage receives the abort
    // signal directly; Pinecone's high-level upsert API is only cooperatively guarded before/after,
    // and deterministic vector ids make a completed in-flight upsert safe to retry idempotently.
    if (err instanceof VectorStoreLeaseLostError) throw err;
    // SDK AbortErrors and abort-aware retry sleeps surface their raw reason. Re-check the guard
    // before any failure ledger, audit, or alert so lease loss cannot write after ownership moved.
    assertVectorStoreLease(options?.leaseGuard);
    const error = err instanceof Error ? err.message : String(err);
    console.error("[vector-db] Error storing contexts:", err);
    setInternalSetting(LAST_INGEST_KEY, { at: new Date().toISOString(), attempted: validDocuments.length, indexed, error });
    audit("vector_store", { ok: false, attempted: validDocuments.length, indexed, error }, userId);
    // A LOCAL SQLite fault is OUR file contending with itself, not the vector store failing.
    // Both local seams in the managed-commit path (persistReceipts, markCommitted) rethrow as
    // `new Error("document-…-failed", { cause: sqliteError })`, so the raw "database is locked" /
    // "no such table" text lives on the CAUSE — classifying `error` (the wrapper's own message)
    // would match nothing and quietly leave the bug in place. `localDbFaultReason` walks the chain
    // and hands back the real SQLite text, which is what gets recorded. Attributing this to
    // "RAG vector store failed" at level=error is the same mislabel class as the 2026-08-09
    // "Pinecone connection failed / database is locked" pushes (docs/rollouts/
    // 2026-08-09-pinecone-lock-mislabel.md), just at the storeContexts ledger seam instead of the
    // provider seam. Control flow is unchanged: the same result object is returned either way.
    const localDbReason = localDbFaultReason(err);
    if (localDbReason) {
      await noteLocalDbFault({
        lane: "vector-store",
        operation: "storeContexts",
        message: localDbReason,
        userId
      });
    } else if (!wasRagSentryCaptured(err)) {
      // Qdrant write-path fetch failures (self-hosted, network-level "TypeError: fetch failed")
      // used to be reported here as a Pinecone failure regardless of which backend actually
      // wrote — the hardcoded `provider: "pinecone"` mislabeled every post-cutover Qdrant write
      // error the same way docs/rollouts/2026-08-09-pinecone-lock-mislabel.md already called out
      // for the local-DB case just above. `writeBackend` already reflects the real backend for
      // this call, and `qdrantRequest` (vector-store/qdrant-write.ts) has already retried a
      // transient network failure with backoff before this catch ever sees it — so `isTransient`
      // here means the retries themselves were exhausted, not a single blip, and is worth a
      // distinct triage signal rather than folding into the generic reason string.
      await captureRagSentryMessage("error", "RAG vector store failed", {
        provider: writeBackend,
        operation: "storeContexts",
        source: userId === "local" ? "operator" : "user",
        attempted: validDocuments.length,
        indexed,
        reason: error,
        ...(isTransientNetworkError(err) ? { isTransient: true } : {})
      }, options?.leaseGuard);
    }
    return { attempted: validDocuments.length, indexed, error, ...(embedsFromStage > 0 ? { embedsFromStage } : {}) };
  }
}

/**
 * Chunk a long document (structure-aware) and store each chunk as its own vector, carrying
 * `acceptance_datetime` so retrieval can apply a point-in-time (`as_of`) filter. Prefer this over
 * storeContexts for anything longer than a short catalyst summary (e.g. full 10-K risk sections).
 */
export interface StoreDocumentOptions extends ChunkOptions {
  /** Explicit corpus visibility. Public `local` documents remain shared by default. */
  scope?: VectorScope;
  /** Guard inherited from the producer's durable shared vector-ingest lease. */
  leaseGuard?: VectorStoreLeaseGuard;
  /** Full source-content version (normally SHA-256). Defaults to SHA-256 of the input body. */
  contentVersion?: string;
  /** Parser/chunker identity included in every collision-safe occurrence id. */
  parserRevision?: string;
  /** Stable logical document identity shared by corrected/versioned occurrences. */
  documentKey?: string;
}

/** Canonical identity for metadata that changes retrieval eligibility or citation meaning. The
 * same helper is used before writes and after provider reads, so carrying a stale hash beside
 * tampered metadata cannot satisfy the relational receipt guard. */
export function retrievalMetadataVersionFromMetadata(metadata: Record<string, unknown>): string {
  const stringValue = (value: unknown): string => (
    typeof value === "string" || typeof value === "number" ? String(value) : ""
  );
  const rawTickers = Array.isArray(metadata.ticker)
    ? metadata.ticker
    : typeof metadata.ticker === "string"
      ? metadata.ticker.split(",")
      : [];
  const tickers = [...new Set([
    ...rawTickers.map((value) => canonicalTicker(String(value))),
    canonicalTicker(stringValue(metadata.symbol))
  ].filter(Boolean))].sort();
  return crypto.createHash("sha256").update(JSON.stringify({
    schema: 1,
    docType: stringValue(metadata.doc_type).toLowerCase(),
    publishedAt: stringValue(metadata.timestamp),
    acceptanceDatetime: stringValue(metadata.acceptance_datetime),
    asOfEpochMs: resolveAsOfEpochMs(metadata) ?? null,
    title: stringValue(metadata.document_title),
    url: stringValue(metadata.url),
    symbol: canonicalTicker(stringValue(metadata.symbol)),
    tickers
  }), "utf8").digest("hex");
}

type DocumentChunkReceipt = Parameters<typeof insertDocumentChunks>[0][number];
type ChunkOccurrenceReceipt = Parameters<typeof dbModule.insertManagedChunkOccurrences>[0][number];

function committedVectorCommitDisposition(
  commitId: string,
  expected: ChunkOccurrenceReceipt[],
  providerAuthority: string,
  ledgerAuthority: string,
  vectorNamespace: "managed" | "fmp-transcripts"
): { disposition: "not_committed" | "exact" | "mismatch"; attemptToken?: string } {
  const database = dbModule.getDb();
  const commit = database.prepare(`
    SELECT c.state, c.expected_vectors, c.attempt_token, c.lease_expires_at,
           c.provider_authority, c.ledger_authority, c.vector_namespace,
           CASE WHEN h.commit_id IS NULL THEN 0 ELSE 1 END AS is_active
    FROM vector_ingest_commits c
    LEFT JOIN vector_document_heads h
      ON h.commit_id = c.id
      AND h.tenant_scope = c.tenant_scope
      AND h.source = c.source
      AND h.accession = c.document_key
    WHERE c.id = ?
  `).get(commitId) as {
    state?: string;
    expected_vectors?: number;
    attempt_token?: string;
    is_active?: number;
    lease_expires_at?: string | null;
    provider_authority?: string | null;
    ledger_authority?: string | null;
    vector_namespace?: string;
  } | undefined;
  if (commit?.state !== "committed") return { disposition: "not_committed" };
  if (
    !commit.is_active ||
    !commit.attempt_token ||
    commit.provider_authority !== providerAuthority ||
    commit.ledger_authority !== ledgerAuthority ||
    commit.vector_namespace !== vectorNamespace ||
    commit.lease_expires_at ||
    commit.expected_vectors !== expected.length
  ) return { disposition: "mismatch" };

  const rows = database.prepare(`
    SELECT vector_id, content_hash, symbol, source, accession, section, ordinal,
           tenant_scope, content_version, receipt_state
    FROM chunk_occurrences
    WHERE commit_id = ?
    ORDER BY vector_id
  `).all(commitId) as Array<{
    vector_id: string;
    content_hash: string;
    symbol: string;
    source: string;
    accession: string;
    section: string;
    ordinal: number;
    tenant_scope: string;
    content_version: string;
    receipt_state: string;
  }>;
  if (rows.length !== expected.length) return { disposition: "mismatch" };

  const expectedById = new Map(expected.map((item) => [item.vectorId, item]));
  const exact = rows.every((row) => {
    const item = expectedById.get(row.vector_id);
    return Boolean(
      item &&
      row.receipt_state === "committed" &&
      row.content_hash === item.contentHash &&
      row.symbol === item.symbol &&
      row.source === item.source &&
      row.accession === item.accession &&
      row.section === item.section &&
      row.ordinal === item.ordinal &&
      row.tenant_scope === item.tenantScope &&
      row.content_version === item.contentVersion
    );
  });
  return exact
    ? { disposition: "exact", attemptToken: commit.attempt_token }
    : { disposition: "mismatch" };
}

function persistDocumentReceipts(
  chunksToRecord: DocumentChunkReceipt[],
  occurrencesToRecord: ChunkOccurrenceReceipt[],
  commitId: string,
  attemptToken: string
): void {
  // Both receipts describe one completed external write set. Nested better-sqlite3 transactions use
  // savepoints, so either every local receipt commits or neither does; an idempotent retry can then
  // safely overwrite the deterministic Pinecone ids and retry this transaction.
  const db = dbModule.getDb();
  timeSyncGuard("persistDocumentReceipts", `${chunksToRecord.length} chunks / ${occurrencesToRecord.length} occurrences`, () =>
  db.transaction(() => {
    insertDocumentChunks(chunksToRecord);
    dbModule.insertManagedChunkOccurrences(occurrencesToRecord);
    if (typeof dbModule.markVectorCommitReceiptsPersisted === "function") {
      dbModule.markVectorCommitReceiptsPersisted(commitId, attemptToken);
    } else if (process.env.NODE_ENV !== "test") {
      throw new Error("Vector commit receipt ledger is unavailable.");
    }

    // The CRUD helpers intentionally use INSERT OR IGNORE for idempotency. Verify the postcondition
    // inside the same transaction so a conflicting/stale occurrence cannot be mistaken for a
    // successful receipt merely because SQLite did not throw.
    const findChunk = db.prepare("SELECT 1 AS ok FROM document_chunks WHERE content_hash = ?");
    for (const chunk of chunksToRecord) {
      if (!findChunk.get(chunk.content_hash)) throw new Error("document_chunks receipt was not persisted");
    }
    const findOccurrence = db.prepare(`
      SELECT 1 AS ok
      FROM chunk_occurrences
      WHERE vector_id = ? AND content_hash = ? AND symbol = ? AND source = ? AND accession = ?
        AND sequence IS ? AND document_name IS ? AND section = ? AND ordinal = ? AND accepted_at = ?
        AND tenant_scope = ? AND content_version = ? AND commit_id = ? AND receipt_state = 'pending'
    `);
    for (const occurrence of occurrencesToRecord) {
      if (!findOccurrence.get(
        occurrence.vectorId,
        occurrence.contentHash,
        occurrence.symbol,
        occurrence.source,
        occurrence.accession,
        occurrence.sequence ?? null,
        occurrence.documentName ?? null,
        occurrence.section,
        occurrence.ordinal,
        occurrence.acceptedAt,
        occurrence.tenantScope,
        occurrence.contentVersion,
        occurrence.commitId
      )) throw new Error("chunk_occurrences receipt was not persisted");
    }
  })());
}

export async function storeDocument(
  doc: ChunkInput & { symbol?: string },
  userId: string = "local",
  options?: StoreDocumentOptions
): Promise<StoreContextsResult> {
  assertVectorStoreLease(options?.leaseGuard);
  const scope = effectiveStoreScope(userId, options?.scope);
  const normalizedOptions: StoreDocumentOptions = { ...options, scope };
  if (scope !== PRIVATE_SCOPE) {
    return storeDocumentImpl(doc, userId, normalizedOptions);
  }

  // `storeDocument` performs provider discovery and creates durable commit/occurrence receipts
  // before it reaches the lower-level upsert. Hold the account write claim across that entire
  // workflow so deletion cannot race any of those side effects, and force every tenant document
  // into its private corpus before deriving tenant/commit identities.
  return withUserWriteOperation(userId, "vector-store-document", async (claim) => (
    storeDocumentImpl(doc, userId, {
      ...normalizedOptions,
      leaseGuard: userOperationLeaseGuard(claim, options?.leaseGuard)
    })
  ));
}

async function storeDocumentImpl(
  doc: ChunkInput & { symbol?: string },
  userId: string,
  options: StoreDocumentOptions
): Promise<StoreContextsResult> {
  assertVectorStoreLease(options.leaseGuard);
  const chunked = chunkDocument(doc, options);
  // Empty/whitespace-only input has no commit cardinality. Do not leave an unfinishable
  // expected_vectors=0 row in the durable pending ledger.
  if (chunked.length === 0) return { attempted: 0, indexed: 0, documentComplete: false };
  const writeBackend = vectorWriteBackend();
  // Monthly Pinecone write-unit breaker — refuse BEFORE provider discovery, commit-ledger rows,
  // and any embed spend. `documentComplete: false` + `wuExhausted` lets producers (SEC ingest
  // worker, filings backfill, transcripts) park the document until `wuExhaustedUntil` instead of
  // retry-storming or dead-lettering it.
  // Qdrant writes must not inherit that park — Pinecone WU exhaustion is why ingest is stuck.
  if (writeBackend === "pinecone") {
    const storeDocWuUntil = pineconeWuExhaustedUntil();
    if (storeDocWuUntil) {
      auditPineconeWuGateSkip(
        { operation: "storeDocument", attempted: chunked.length, until: storeDocWuUntil },
        userId
      );
      return {
        attempted: chunked.length,
        indexed: 0,
        skipped: true,
        wuExhausted: true,
        wuExhaustedUntil: storeDocWuUntil,
        documentComplete: false
      };
    }
  }
  if (writeBackend === "qdrant" && !hasRagIngestPointsBudget(userId, chunked.length, "qdrant")) {
    console.warn(`[vector-db] Qdrant daily point ingestion budget exceeded for ${userId}; skipping ${chunked.length} chunks.`);
    return {
      attempted: chunked.length,
      indexed: 0,
      skipped: true,
      writeUnitBudgetSkipped: chunked.length,
      documentComplete: false
    };
  }
  // Daily write fuse: refuse BEFORE provider discovery and beginVectorCommit.  The monthly
  // breaker above parks on a calendar marker; this one parks when the rolling 24h ledger is
  // already at the configured cap so incremental lanes (ROIC transcripts, filings, 8-Ks) do
  // not open-and-abort a commit for every new document after the fuse is spent.
  if (writeBackend === "pinecone" && !hasPineconeWriteBudget(userId)) {
    const used = usedPineconeWriteUnitsLast24h(userId);
    const limit = pineconeMaxWriteUnitsPerDay();
    await notifyPineconeDailyWriteFuse({
      userId,
      used,
      limit,
      requested: 0,
      skipped: chunked.length,
      exceeded: true,
      leaseGuard: options.leaseGuard
    });
    return {
      attempted: chunked.length,
      indexed: 0,
      skipped: true,
      writeUnitBudgetSkipped: chunked.length,
      documentComplete: false
    };
  }
  const fallbackSymbol = doc.symbol ?? (Array.isArray(doc.ticker) ? doc.ticker[0] : doc.ticker) ?? "";
  const source = doc.source || "sec-edgar";

  // A content hash identifies content, never an occurrence. Every occurrence still receives a real
  // Pinecone record with its own symbol/accession/PIT metadata; exact embeddings may be reused, but
  // vectors and citations are never deduplicated away.
  const chunkHashes = chunked.map((c) => ({
    content_hash: c.content_hash,
    symbol: c.ticker[0] ?? fallbackSymbol,
    source,
    chunk_id: c.chunk_id
  }));

  // Model-aware embedding-space revision (PR #1669 P1): stays the historical bare `v1` while the
  // Voyage model is active; a non-Voyage model yields a suffixed tag so its vector ids/commits can
  // never collide with or overwrite the Voyage corpus rows for the same content.
  const embedRev = embeddingSpaceRevision(userId);
  const parserRev = options?.parserRevision?.trim() || "v1";
  const accession = doc.doc_id || "unknown_accession";
  const documentKey = options?.documentKey?.trim() || accession;
  const contentVersion = options?.contentVersion?.trim() ||
    crypto.createHash("sha256").update(doc.text, "utf8").digest("hex");
  // Retrieval-significant metadata is version identity, not mutable decoration. A corrected
  // acceptance/publication stamp or document type must produce a distinct occurrence generation;
  // otherwise an exact-content replay could retain stale point-in-time filters and citations.
  const normalizedDocument = chunked[0];
  const normalizedSymbol = normalizedDocument.ticker[0] ?? canonicalTicker(fallbackSymbol);
  const retrievalMetadataVersion = retrievalMetadataVersionFromMetadata({
    doc_type: normalizedDocument.doc_type,
    timestamp: normalizedDocument.published_at,
    acceptance_datetime: normalizedDocument.acceptance_datetime,
    document_title: normalizedDocument.title,
    url: normalizedDocument.url,
    symbol: normalizedSymbol,
    ticker: normalizedDocument.ticker
  });
  const scope = effectiveStoreScope(userId, options.scope);
  const tenantScope = vectorTenantScope(userId, scope);
  const sequence = 1;
  const documentName = doc.title || "main.html";
  const now = new Date().toISOString();
  // Managed ids and relational receipts are bound to the physical Pinecone index. Resolve that
  // authority before creating any local commit row, so a control-plane/configuration failure cannot
  // leave a deterministic receipt for a provider that was never identified.
  const providerClients = await getClients(userId, options?.leaseGuard, {
    skipMissingPineconeAlert: writeBackend === "qdrant"
  });
  const activeProvider = activeEmbeddingProvider(userId);
  // Voyage is intentionally test-only after the production BGE-M3 migration. A managed document
  // must therefore require the credential that will actually embed it, not the optional test
  // client returned by getClients(). Keep the Voyage client check for its explicit test provider.
  const activeProviderCredential = activeProvider === "voyage"
    ? undefined
    : resolveApiKey(activeProvider, userId);
  const hasActiveEmbeddingAuthority = activeProvider === "voyage"
    ? Boolean(providerClients.voyage)
    : embeddingCredentialIsUsable(activeProviderCredential);
  if (!hasActiveEmbeddingAuthority) {
    audit("vector_store", {
      ok: false,
      attempted: chunked.length,
      indexed: 0,
      skipped: true,
      reason: `missing ${activeProvider} embedding authority before managed commit`
    }, userId);
    return { attempted: chunked.length, indexed: 0, skipped: true, unconfigured: true };
  }
  let providerAuthority: string | undefined;
  if (writeBackend === "qdrant") {
    providerAuthority = resolveQdrantWriteProviderAuthority(managedVectorLedgerAuthority());
  } else {
    if (!providerClients.pc || !providerClients.initCacheKey) {
      audit("vector_store", {
        ok: false,
        attempted: chunked.length,
        indexed: 0,
        skipped: true,
        reason: `missing Pinecone or ${activeProvider} embedding authority before managed commit`
      }, userId);
      return { attempted: chunked.length, indexed: 0, skipped: true, unconfigured: true };
    }
    await ensureIndex(
      providerClients.pc,
      providerClients.initCacheKey,
      providerClients.pineconeSource,
      userId,
      options?.leaseGuard
    );
    assertVectorStoreLease(options?.leaseGuard);
    providerAuthority = stableProviderAuthorityForInitKey(providerClients.initCacheKey);
  }
  if (!providerAuthority) {
    audit("vector_store", {
      ok: false,
      attempted: chunked.length,
      indexed: 0,
      skipped: true,
      reason: writeBackend === "qdrant"
        ? "stable Qdrant provider authority unavailable"
        : "stable Pinecone provider authority unavailable"
    }, userId);
    return {
      attempted: chunked.length,
      indexed: 0,
      skipped: true,
      error: "managed-vector-provider-authority-unavailable",
      documentComplete: false
    };
  }
  const ledgerAuthority = managedVectorLedgerAuthority();
  const vectorNamespace = source === "fmp-earnings-transcript" ? "fmp-transcripts" : "managed";
  const occurrenceDescriptors = chunked.map((chunk, index) => {
    const ordinal = index + 1;
    const cleanSection = chunk.section || "body";
    const vectorId = buildOccurrenceVectorId({
      ledgerAuthority,
      providerAuthority,
      tenantScope,
      source,
      accession,
      contentVersion: `${contentVersion}:metadata:${retrievalMetadataVersion}`,
      section: cleanSection,
      ordinal,
      parserRevision: parserRev,
      embedRevision: embedRev
    });
    return { chunk, ordinal, vectorId };
  });
  const commitId = `vcommit:v3:${crypto.createHash("sha256").update(JSON.stringify([
    ledgerAuthority,
    providerAuthority,
    tenantScope,
    source,
    accession,
    documentKey,
    contentVersion,
    retrievalMetadataVersion,
    parserRev,
    embedRev,
    occurrenceDescriptors.map((item) => item.vectorId)
  ]), "utf8").digest("hex")}`;
  const attemptToken = crypto.randomUUID();

  const documents: ContextDocument[] = occurrenceDescriptors.map(({ chunk, ordinal, vectorId }) => ({
    text: `${chunk.context_header}\n\n${chunk.text}`,
    // The vector is content-derived and safe to reuse; the stored text/metadata below remains
    // occurrence-specific for filtering, point-in-time correctness, and citation display.
    embeddingText: chunk.text,
    metadata: {
      symbol: chunk.ticker[0] ?? fallbackSymbol,
      source: chunk.source,
      timestamp: chunk.published_at,
      accession,
      chunk_id: chunk.chunk_id,
      acceptance_datetime: chunk.acceptance_datetime,
      document_title: chunk.title,
      section: chunk.section,
      doc_type: chunk.doc_type,
      is_table: chunk.is_table,
      ticker: chunk.ticker,
      content_hash: chunk.content_hash,
      vector_id: vectorId,
      tenant_scope: tenantScope,
      ledger_authority: ledgerAuthority,
      provider_authority: providerAuthority,
      content_version: contentVersion,
      retrieval_metadata_version: retrievalMetadataVersion,
      vector_commit_id: commitId,
      vector_namespace: vectorNamespace,
      document_key: documentKey,
      vector_attempt_token: attemptToken,
      chunk_ordinal: ordinal,
      parser_revision: parserRev,
      embed_revision: embedRev,
      receipt_required: true,
      ingest_state: "pending",
      parent_text: chunk.parent_text || chunk.text,
      ...(doc.url ? { url: doc.url } : {})
    }
  }));
  const occurrencesToRecord: ChunkOccurrenceReceipt[] = occurrenceDescriptors.map(({ chunk, ordinal, vectorId }) => ({
    vectorId,
    contentHash: chunk.content_hash,
    symbol: chunk.ticker[0] || fallbackSymbol,
    source,
    accession,
    sequence,
    documentName,
    section: chunk.section || "body",
    ordinal,
    acceptedAt: chunk.acceptance_datetime || now,
    tenantScope,
    contentVersion,
    commitId,
    receiptState: "pending",
    createdAt: now
  }));

  return withSerializedVectorCommit(commitId, options?.leaseGuard, async () => {
    const reuseCommitted = (): StoreContextsResult | undefined => {
      const committed = committedVectorCommitDisposition(
        commitId,
        occurrencesToRecord,
        providerAuthority,
        ledgerAuthority,
        vectorNamespace
      );
      if (committed.disposition === "exact" && committed.attemptToken) {
        return {
          attempted: chunked.length,
          indexed: 0,
          skipped: true,
          reusedCommitted: true,
          documentComplete: true,
          managedCommitProof: { commitId, attemptToken: committed.attemptToken }
        };
      }
      if (committed.disposition === "mismatch") {
        return {
          attempted: chunked.length,
          indexed: 0,
          error: "document-committed-receipt-integrity-mismatch",
          documentComplete: false
        };
      }
      return undefined;
    };

    const existing = reuseCommitted();
    if (existing) return existing;

    const leaseExpiry = () => new Date(Date.now() + VECTOR_COMMIT_LEASE_MS).toISOString();
    if (typeof dbModule.beginVectorCommit === "function") {
      const begun = dbModule.beginVectorCommit({
        id: commitId,
        tenantScope,
        userId,
        providerAuthority,
        ledgerAuthority,
        vectorNamespace,
        source,
        accession,
        documentKey,
        contentVersion,
        retrievalMetadataVersion,
        parserRevision: parserRev,
        embedRevision: embedRev,
        expectedVectors: occurrenceDescriptors.length,
        attemptToken,
        leaseExpiresAt: leaseExpiry(),
        now
      });
      // Defense in depth for another process committing between the inspection and SQLite claim.
      if (begun === "already_committed") {
        return reuseCommitted() ?? {
          attempted: chunked.length,
          indexed: 0,
          error: "document-committed-receipt-integrity-mismatch",
          documentComplete: false
        };
      }
      if (begun === "busy") {
        return {
          attempted: chunked.length,
          indexed: 0,
          error: "document-commit-in-progress",
          documentComplete: false
        };
      }
    } else if (process.env.NODE_ENV !== "test") {
      throw new Error("Vector commit ledger is unavailable.");
    }

    const commitLeaseGuard: VectorStoreLeaseGuard = {
      signal: options?.leaseGuard?.signal,
      assertOwnership: () => {
        options?.leaseGuard?.assertOwnership();
        if (typeof dbModule.renewVectorCommitLease === "function") {
          dbModule.renewVectorCommitLease(commitId, attemptToken, leaseExpiry());
        } else if (process.env.NODE_ENV !== "test") {
          throw new Error("Vector commit lease ledger is unavailable.");
        }
      }
    };
    assertVectorStoreLease(commitLeaseGuard);

    // Align the storeContexts trim cap with the ACTUAL token budget chunkDocument used (plus the
    // citation header allowance). Table chunks remain untrimmed in storeContexts.
    const maxTokens = options?.maxTokens ?? DEFAULT_MAX_TOKENS;
    const headerAllowance = 512;
    const chunkAlignedMaxChars = Math.max(contextMaxChars(), maxTokens * CHARS_PER_TOKEN_CEILING + headerAllowance);
    // The exported storeContexts wrapper acquires the same durable account claim for direct batch
    // callers. This document workflow already holds it, so call the implementation directly and
    // retain the claim-bearing lease guard across the managed commit transaction.
    const result = await storeContextsImpl(documents, userId, {
      scope,
      maxChars: chunkAlignedMaxChars,
      reuseExactEmbeddings: true,
      leaseGuard: commitLeaseGuard,
      managedCommit: {
        expectedRecordCount: occurrenceDescriptors.length,
        providerAuthority,
        ledgerAuthority,
        namespace: vectorNamespace,
        persistReceipts: () => persistDocumentReceipts(
          chunkHashes,
          occurrencesToRecord,
          commitId,
          attemptToken
        ),
        markCommitted: () => {
          if (typeof dbModule.markVectorCommitCommitted === "function") {
            dbModule.markVectorCommitCommitted(commitId, attemptToken);
          } else if (process.env.NODE_ENV !== "test") {
            throw new Error("Vector commit finalizer is unavailable.");
          }
        }
      }
    });
    assertVectorStoreLease(commitLeaseGuard);

    const vectorsComplete =
      result.indexed === chunked.length &&
      !result.error &&
      (result.rejectedInvalidEmbeddings ?? 0) === 0 &&
      (result.budgetSkipped ?? 0) === 0 &&
      (result.writeUnitBudgetSkipped ?? 0) === 0;
    if (!vectorsComplete) {
      if (typeof dbModule.abortVectorCommit === "function") {
        dbModule.abortVectorCommit(commitId, attemptToken);
      }
      else if (process.env.NODE_ENV !== "test") throw new Error("Vector commit abort ledger is unavailable.");
      return { ...result, attempted: chunked.length, documentComplete: false };
    }

    assertVectorStoreLease(commitLeaseGuard);
    return {
      ...result,
      attempted: chunked.length,
      documentComplete: true,
      managedCommitProof: { commitId, attemptToken }
    };
  });
}

/**
 * Resolve a chunk's point-in-time stamp using the same precedence `isWithinAsOf` applies:
 * acceptance_datetime -> published_at -> as_of -> timestamp. Returns `undefined` when none of
 * those keys are present/parseable — i.e. when the chunk has NO resolvable date stamp at all.
 * Exported so callers (the strict-mode drop-count in `rankPool`) can distinguish "undated chunk"
 * from "dated chunk that happens to be in-window" without duplicating the resolution chain.
 */
export function resolveAsOfStamp(metadata: Record<string, unknown> | undefined): number | undefined {
  const stamp = metadata?.acceptance_datetime ?? metadata?.published_at ?? metadata?.as_of ?? metadata?.timestamp;
  if (stamp == null) return undefined;
  const t = typeof stamp === "number" ? stamp : Date.parse(String(stamp));
  return Number.isFinite(t) ? t : undefined;
}

/**
 * Point-in-time guard for retrieval: returns false when a chunk's
 * acceptance_datetime / as_of / timestamp is strictly after `asOf` — a lookahead-bias guard for
 * backtest-style queries.
 *
 * Default (`strict=false`, byte-identical to pre-R1 behavior): undated chunks and an unset/
 * unparseable `asOf` are KEPT (lenient/fail-open).
 *
 * `strict=true` (R1, 2026-07-01 expert-review follow-up, gated by `VECTOR_ASOF_STRICT` AND only
 * applied by callers when `options.asOf` is set): a chunk with NO resolvable stamp is DROPPED
 * instead of kept — closing the silent look-ahead hole an undated chunk otherwise represents for
 * a dated retrieval. An unset/unparseable `asOf` still short-circuits to "keep" even in strict
 * mode, since there is no point-in-time constraint to violate.
 */
export function isWithinAsOf(
  metadata: Record<string, unknown> | undefined,
  asOf: string | undefined,
  strict: boolean = false
): boolean {
  if (!asOf) return true;
  const asOfMs = Date.parse(asOf);
  if (!Number.isFinite(asOfMs)) return true;
  // Resolution precedence (R1, 2026-07-01 expert review): acceptance_datetime is the most precise
  // point-in-time anchor (when a filing was actually accepted by EDGAR); published_at is the next
  // best fallback (chunk.ts always populates it, even when acceptance_datetime is absent) — added
  // here so a chunk lacking acceptance_datetime doesn't fall all the way through to "include" when a
  // dated published_at is available. as_of/timestamp remain the final legacy fallbacks. This is
  // additive-only: any chunk that already had acceptance_datetime is unaffected.
  const t = resolveAsOfStamp(metadata);
  if (t == null) return !strict; // lenient: keep; strict: drop (no resolvable stamp under an active asOf)
  return t <= asOfMs;
}

/** Returns true when RAG_CITATION_STALENESS is truthy. Default ON (owner enablement 2026-07-24). */
export function citationStalenessEnabled(): boolean {
  return envFlagOn("RAG_CITATION_STALENESS", true);
}

/**
 * R13 (2026-07-01 RAG backlog) — heuristic, ADVISORY-ONLY staleness horizons per doc_type. These
 * are deliberately generous, documented, tunable defaults — NOT a validity judgment. A 10-K stays
 * "fresh" far longer than an 8-K because it's an annual filing; a transcript sits in between.
 * Override any horizon via env (days): RAG_STALENESS_DAYS_<DOC_TYPE_UPPERCASE_UNDERSCORED>.
 */
const DEFAULT_STALENESS_HORIZON_DAYS: Record<string, number> = {
  "10-k": 400,
  "10-q": 120,
  "8-k": 90,
  transcript: 120,
  "earnings-transcript": 120,
  "congress-trade": 60,
  "insider-filing": 90
};
const FALLBACK_STALENESS_HORIZON_DAYS = 180;

function stalenessHorizonDays(docType: string | undefined): number {
  const key = (docType ?? "").toLowerCase();
  const envKey = `RAG_STALENESS_DAYS_${key.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
  const override = Number(process.env[envKey]);
  if (Number.isFinite(override) && override > 0) return override;
  return DEFAULT_STALENESS_HORIZON_DAYS[key] ?? FALLBACK_STALENESS_HORIZON_DAYS;
}

/**
 * Heuristic recency label: true when `asOfIso` is older than the doc_type's staleness horizon.
 * Returns `undefined` (not `false`) when there's no resolvable `asOfIso` to judge — an unknown
 * age is NOT the same claim as "known to be fresh". ADVISORY ONLY: never gates retrieval, never
 * feeds any numeric/sizing path — purely a recency label a future citation UI may choose to
 * render. Callers must gate on `citationStalenessEnabled()` before calling this (kept as a
 * separate pure function so it's independently unit-testable).
 */
export function isStale(asOfIso: string | undefined, docType: string | undefined): boolean | undefined {
  if (!asOfIso) return undefined;
  const t = Date.parse(asOfIso);
  if (!Number.isFinite(t)) return undefined;
  const ageDays = (Date.now() - t) / (24 * 60 * 60 * 1000);
  return ageDays > stalenessHorizonDays(docType);
}

/**
 * Live Pinecone index stats — used by the reindex/diagnostic route so the operator can
 * confirm `totalVectorCount > 0` after a backfill instead of guessing.
 */
export async function getVectorStoreStats(userId: string = "local"): Promise<VectorStoreStats> {
  if (usesQdrantWrites()) {
    try {
      const info = await qdrantCollectionInfo();
      return {
        configured: true,
        indexName: info.collection,
        exists: info.exists,
        ...(info.pointsCount != null ? { totalVectorCount: info.pointsCount } : {}),
        ...(info.dimension != null ? { dimension: info.dimension } : {})
      };
    } catch (err) {
      return {
        configured: true,
        indexName: process.env.QDRANT_COLLECTION?.trim() || "socratic-trade",
        error: err instanceof Error ? err.message : String(err)
      };
    }
  }
  const name = indexName();
  const { pc, pineconeSource } = await getClients(userId);
  if (!pc) return { configured: false, indexName: name };
  try {
    if (!(await indexExists(pc, pineconeSource, userId))) return { configured: true, indexName: name, exists: false };
    const stats = (await withRagApiHealth("pinecone", pineconeSource, userId, "describeIndexStats", () =>
      pc.Index(name).describeIndexStats()
    )) as {
        totalRecordCount?: number;
        totalVectorCount?: number;
        dimension?: number;
      };
    return {
      configured: true,
      indexName: name,
      exists: true,
      totalVectorCount: stats.totalRecordCount ?? stats.totalVectorCount ?? 0,
      dimension: stats.dimension
    };
  } catch (err) {
    return { configured: true, indexName: name, error: err instanceof Error ? err.message : String(err) };
  }
}

/** All Pinecone index totals visible to this key. Diagnostic-only: the RAG coverage
 * page is local-ledger based, so this exposes old/alternate indexes that can consume
 * the same org-level Pinecone quota while not appearing in ticker coverage. */
let cachedAllStats: { ts: number; data: VectorIndexStats[] } | null = null;
const ALL_STATS_TTL_MS = 60_000;

export async function getAllVectorStoreStats(userId: string = "local"): Promise<VectorIndexStats[]> {
  if (cachedAllStats && Date.now() - cachedAllStats.ts < ALL_STATS_TTL_MS) {
    return cachedAllStats.data;
  }
  if (usesQdrantWrites()) {
    try {
      const info = await qdrantCollectionInfo();
      const results: VectorIndexStats[] = [{
        indexName: info.collection,
        ...(info.pointsCount != null ? { totalVectorCount: info.pointsCount } : {}),
        ...(info.dimension != null ? { dimension: info.dimension } : {}),
        ...(!info.exists ? { error: "collection missing" } : {})
      }];
      cachedAllStats = { ts: Date.now(), data: results };
      return results;
    } catch (err) {
      return [{
        indexName: process.env.QDRANT_COLLECTION?.trim() || "socratic-trade",
        error: err instanceof Error ? err.message : String(err)
      }];
    }
  }
  const { pc, pineconeSource } = await getClients(userId);
  if (!pc) return [];
  try {
    const indexes = await withRagApiHealth("pinecone", pineconeSource, userId, "listIndexes", () => pc.listIndexes());
    const names = (indexes.indexes ?? []).map((i) => i.name).filter((name): name is string => Boolean(name));
    const results = await Promise.all(
      names.map(async (name) => {
        try {
          const stats = (await withRagApiHealth("pinecone", pineconeSource, userId, "describeIndexStats", () =>
            pc.Index(name).describeIndexStats()
          )) as {
            totalRecordCount?: number;
            totalVectorCount?: number;
            dimension?: number;
          };
          return {
            indexName: name,
            totalVectorCount: stats.totalRecordCount ?? stats.totalVectorCount ?? 0,
            dimension: stats.dimension
          };
        } catch (err) {
          return { indexName: name, error: err instanceof Error ? err.message : String(err) };
        }
      })
    );
    cachedAllStats = { ts: Date.now(), data: results };
    return results;
  } catch (err) {
    return [{ indexName: indexName(), error: err instanceof Error ? err.message : String(err) }];
  }
}

/**
 * server-asof-filter backfill (2026-07-06): pure per-vector decision for the idempotent backfill of
 * `as_of_epoch_ms` onto EXISTING vectors. Given one vector's current metadata, decide what to do:
 *
 *  - `"skip-has-epoch"`: the vector already carries a (finite numeric) `as_of_epoch_ms` — idempotent
 *    no-op, so re-running the backfill never re-writes it or costs a Pinecone update.
 *  - `"skip-undated"`: no `as_of_epoch_ms` AND no resolvable date in the acceptance_datetime ->
 *    published_at -> as_of -> timestamp chain — leave the field ABSENT (absence is the fail-open
 *    signal; we must NOT stamp 0/NaN onto a genuinely-undated vector).
 *  - `{ action: "update", epochMs }`: no epoch yet but a date resolves — set it via partial update.
 *
 * NaN-safe (reuses `resolveAsOfEpochMs`). No I/O — the orchestrator does the actual Pinecone update.
 */
export type BackfillEpochDecision =
  | { action: "skip-has-epoch" }
  | { action: "skip-undated" }
  | { action: "update"; epochMs: number };

export function computeBackfillEpochUpdate(metadata: Record<string, unknown> | undefined): BackfillEpochDecision {
  const existing = metadata?.[AS_OF_EPOCH_FIELD];
  // Idempotency: a vector already carrying a finite numeric epoch is left untouched. A non-numeric
  // or non-finite stray value is treated as "not set" so a corrupt write can be corrected by a re-run.
  if (typeof existing === "number" && Number.isFinite(existing)) return { action: "skip-has-epoch" };
  const epochMs = resolveAsOfEpochMs(metadata);
  if (epochMs == null) return { action: "skip-undated" };
  return { action: "update", epochMs };
}

export interface BackfillAsOfEpochResult {
  /** Total vectors scanned across all pages. */
  scanned: number;
  /** Vectors that already had a finite epoch (idempotent skips). */
  skippedHasEpoch: number;
  /** Vectors with no resolvable date — field intentionally left absent. */
  skippedUndated: number;
  /** Vectors updated with a freshly-derived epoch. */
  updated: number;
  /** Per-id update failures (non-fatal; the scan continues). */
  errors: number;
  /** True when `dryRun` was set — no `update` calls were issued, `updated` counts would-be updates. */
  dryRun: boolean;
}

export interface BackfillAsOfEpochOptions {
  /** userId whose resolved Pinecone key is used (default "local" = operator/env key). */
  userId?: string;
  /** When true, compute decisions and counts but issue NO Pinecone `update` calls. Default false. */
  dryRun?: boolean;
  /** Restrict the scan to ids under this prefix (Pinecone `listPaginated` prefix). Default: all ids. */
  prefix?: string;
  /** Vectors fetched per page (Pinecone fetch batch). Default 100. */
  batchSize?: number;
  /** Optional progress callback fired once per page with the running totals. */
  onProgress?: (progress: BackfillAsOfEpochResult) => void;
}

/**
 * server-asof-filter backfill orchestrator (2026-07-06): idempotently add `as_of_epoch_ms` to
 * EXISTING Pinecone vectors by recomputing the epoch from each vector's OWN date metadata
 * (acceptance_datetime/published_at/as_of/timestamp) and issuing a partial metadata update
 * (`index.update({ id, metadata: { as_of_epoch_ms } })`) for those lacking it. Vectors that already
 * have it are skipped (idempotent — safe to re-run), and genuinely-undated vectors are left absent.
 *
 * Iterates the whole index via Pinecone `listPaginated` (ids) + `fetch` (metadata) — no local chunk
 * ledger drives this because `document_chunks` stores content_hashes, not Pinecone vector ids, and
 * private-tier ids aren't enumerated there at all; listing the index is the authoritative source of
 * "every vector that exists". Per-id update failures are counted, not thrown, so one bad record
 * doesn't abort a long backfill. Returns aggregate counts for the operator/rollout note.
 */
export async function backfillAsOfEpoch(options: BackfillAsOfEpochOptions = {}): Promise<BackfillAsOfEpochResult> {
  const userId = options.userId ?? "local";
  const dryRun = Boolean(options.dryRun);
  const batchSize = Math.max(1, Math.min(1000, Math.floor(options.batchSize ?? 100)));
  const result: BackfillAsOfEpochResult = {
    scanned: 0,
    skippedHasEpoch: 0,
    skippedUndated: 0,
    updated: 0,
    errors: 0,
    dryRun
  };

  const { pc, pineconeSource } = await getClients(userId);
  if (!pc) throw new Error("backfillAsOfEpoch: Pinecone key not configured");
  if (!(await indexExists(pc, pineconeSource, userId))) {
    throw new Error(`backfillAsOfEpoch: index "${indexName()}" does not exist`);
  }
  const index = pc.Index(indexName());

  let paginationToken: string | undefined;
  do {
    assertGatherSafeWholeIndexInventory();
    const listResp = await withRagApiHealth("pinecone", pineconeSource, userId, "list", () =>
      index.listPaginated({
        ...(options.prefix ? { prefix: options.prefix } : {}),
        ...(paginationToken ? { paginationToken } : {})
      })
    );
    const ids = (listResp.vectors ?? []).map((v) => v.id).filter((id): id is string => Boolean(id));
    paginationToken = listResp.pagination?.next;
    if (ids.length === 0) continue;

    // Fetch metadata in batches so a large page doesn't build one oversized fetch request.
    for (const idBatch of fetchIdChunks(ids, batchSize)) {
      const fetchResp = await withRagApiHealth("pinecone", pineconeSource, userId, "fetch", () =>
        index.fetch({ ids: idBatch })
      );
      const records = fetchResp.records ?? {};
      for (const id of idBatch) {
        const record = records[id];
        if (!record) continue;
        result.scanned++;
        const decision = computeBackfillEpochUpdate(record.metadata as Record<string, unknown> | undefined);
        if (decision.action === "skip-has-epoch") {
          result.skippedHasEpoch++;
          continue;
        }
        if (decision.action === "skip-undated") {
          result.skippedUndated++;
          continue;
        }
        if (dryRun) {
          result.updated++;
          continue;
        }
        try {
          await withRagApiHealth("pinecone", pineconeSource, userId, "update", () =>
            index.update({ id, metadata: { [AS_OF_EPOCH_FIELD]: decision.epochMs } })
          );
          result.updated++;
        } catch (err) {
          result.errors++;
          console.warn(`[vector-db] backfillAsOfEpoch: update failed for id="${id}":`, err instanceof Error ? err.message : String(err));
        }
      }
    }
    options.onProgress?.({ ...result });
  } while (paginationToken);

  try {
    audit("vector_asof_epoch_backfill", { ...result }, userId);
  } catch {
    // best-effort telemetry only
  }
  return result;
}

export interface VectorMetadataInventoryRow {
  id: string;
  metadata: Record<string, unknown>;
}

export type VectorDataNamespace = "default" | "managed" | "private" | "fmp-transcripts";

/**
 * The literal Pinecone namespace NAME a logical tier targets ("" = the default namespace).
 * Factored out of vectorDataIndex so the Qdrant read backend (vector-store/qdrant-read.ts)
 * pins its `ns` tenant clause to the exact same string a Pinecone query would use — the two
 * can never drift.
 */
export function vectorNamespaceName(
  namespace: VectorDataNamespace,
  ledgerAuthority?: string,
  userId?: string
): string {
  if (namespace === "default") return "";
  return namespace === "private"
    ? privateVectorNamespace(userId ?? "local", ledgerAuthority)
    : namespace === "fmp-transcripts"
      ? fmpTranscriptVectorNamespace(ledgerAuthority)
      : ledgerAuthority
        ? `socratic-${managedOccurrenceToken(ledgerAuthority)}`
        : managedVectorNamespace();
}

function vectorDataIndex(
  pc: Pinecone,
  namespace: VectorDataNamespace,
  ledgerAuthority?: string,
  userId?: string
) {
  const base = pc.Index(indexName());
  if (namespace === "default") return base;
  const namespaceMethod = (base as unknown as { namespace?: (name: string) => typeof base }).namespace;
  if (typeof namespaceMethod === "function") {
    return namespaceMethod.call(base, vectorNamespaceName(namespace, ledgerAuthority, userId));
  }
  if (process.env.NODE_ENV === "test") return base;
  throw new Error("Pinecone namespace support is unavailable for isolated vectors.");
}

/**
 * Authoritative provider-side metadata inventory. It lists Pinecone itself rather than trusting
 * local receipts, so receiptless crash ghosts are included. Callers must opt into this I/O by
 * invoking the function; importing the module performs no external work.
 */
export async function inventoryVectorRecordsByMetadata(options: {
  userId?: string;
  /** Immutable id prefix. Prefer this over mutable metadata for v3 managed-corpus inventories. */
  prefix?: string;
  source?: string;
  docType?: string;
  receiptRequired?: boolean;
  batchSize?: number;
  /** Hard provider-record scan bound. Exceeding it throws rather than returning a partial inventory. */
  maxScanned?: number;
  /** Exact prepared request authorizing provider reads through the account-deletion fence. */
  accountDeletionRequestId?: string;
  leaseGuard?: VectorStoreLeaseGuard;
  /** Managed corpus is isolated from legacy/direct vectors and other applications in shared BYOK indexes. */
  namespace?: VectorDataNamespace;
} = {}): Promise<VectorMetadataInventoryRow[]> {
  const userId = options.userId ?? "local";
  const batchSize = Math.max(1, Math.min(1_000, Math.floor(options.batchSize ?? 100)));
  const maxScanned = Math.max(1, Math.min(1_000_000, Math.floor(options.maxScanned ?? 250_000)));
  assertGatherSafeWholeIndexInventory({
    accountDeletionRequestId: options.accountDeletionRequestId
  });
  assertVectorStoreLease(options.leaseGuard);
  if (usesQdrantWrites()) {
    const namespaceName = vectorNamespaceName(options.namespace ?? "default", undefined, userId);
    return qdrantInventoryByMetadata({
      namespace: namespaceName,
      prefix: options.prefix,
      source: options.source,
      docType: options.docType,
      receiptRequired: options.receiptRequired,
      batchSize: options.batchSize,
      maxScanned: options.maxScanned
    });
  }
  const { pc, pineconeSource } = await getPineconeClient(userId, options.leaseGuard);
  if (!pc) throw new Error("Pinecone key not configured for vector inventory.");
  if (!(await indexExists(pc, pineconeSource, userId, options.accountDeletionRequestId, options.leaseGuard))) return [];
  const index = vectorDataIndex(pc, options.namespace ?? "default", undefined, userId);
  const found: VectorMetadataInventoryRow[] = [];
  let scanned = 0;
  let paginationToken: string | undefined;
  do {
    assertGatherSafeWholeIndexInventory({
      accountDeletionRequestId: options.accountDeletionRequestId
    });
    assertVectorStoreLease(options.leaseGuard);
    const listed = await withRagApiHealth(
      "pinecone",
      pineconeSource,
      userId,
      "inventory list",
      () => index.listPaginated({
        ...(options.prefix ? { prefix: options.prefix } : {}),
        ...(paginationToken ? { paginationToken } : {})
      }),
      options.leaseGuard,
      options.accountDeletionRequestId ? { accountDeletionRequestId: options.accountDeletionRequestId } : undefined
    );
    paginationToken = listed.pagination?.next;
    const ids = (listed.vectors ?? []).map((row) => row.id).filter((id): id is string => Boolean(id));
    if (scanned + ids.length > maxScanned) {
      throw new Error(`Vector inventory scan limit exceeded (${maxScanned} records).`);
    }
    scanned += ids.length;
    for (const idBatch of fetchIdChunks(ids, batchSize)) {
      assertVectorStoreLease(options.leaseGuard);
      const fetched = await withRagApiHealth(
        "pinecone",
        pineconeSource,
        userId,
        "inventory fetch",
        () => index.fetch({ ids: idBatch }),
        options.leaseGuard,
        options.accountDeletionRequestId ? { accountDeletionRequestId: options.accountDeletionRequestId } : undefined
      );
      for (const id of idBatch) {
        const record = fetched.records?.[id];
        // Pinecone listing is eventually consistent after deletes. A listed id that the
        // authoritative fetch no longer returns is absent, not a metadata-less live vector.
        if (!record) continue;
        const raw = record.metadata;
        const metadata = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
        if (options.source !== undefined && metadata.source !== options.source) continue;
        if (options.docType !== undefined && String(metadata.doc_type ?? "").toLowerCase() !== options.docType.toLowerCase()) continue;
        if (options.receiptRequired !== undefined && metadata.receipt_required !== options.receiptRequired) continue;
        found.push({ id, metadata });
      }
    }
  } while (paginationToken);
  assertVectorStoreLease(options.leaseGuard);
  return found.sort((a, b) => a.id.localeCompare(b.id));
}

export async function purgeVectorRecordsByMetadata(options: {
  userId?: string;
  prefix?: string;
  source?: string;
  docType?: string;
  receiptRequired?: boolean;
  dryRun?: boolean;
  batchSize?: number;
  maxScanned?: number;
  leaseGuard?: VectorStoreLeaseGuard;
  accountDeletionRequestId?: string;
  namespace?: VectorDataNamespace;
}): Promise<{ dryRun: boolean; ids: string[]; deleted: number }> {
  assertVectorStoreLease(options.leaseGuard);
  const dryRun = options.dryRun !== false;
  const rows = await inventoryVectorRecordsByMetadata(options);
  assertVectorStoreLease(options.leaseGuard);
  const ids = rows.map((row) => row.id);
  if (dryRun || ids.length === 0) return { dryRun, ids, deleted: 0 };
  const userId = options.userId ?? "local";
  if (usesQdrantWrites()) {
    const namespaceName = vectorNamespaceName(options.namespace ?? "default", undefined, userId);
    await qdrantDeleteByIds({ namespace: namespaceName, ids });
    assertVectorStoreLease(options.leaseGuard);
    return { dryRun, ids, deleted: ids.length };
  }
  const { pc, pineconeSource } = await getPineconeClient(userId, options.leaseGuard);
  if (!pc) throw new Error("Pinecone key not configured for vector purge.");
  const index = vectorDataIndex(pc, options.namespace ?? "default", undefined, userId);
  const batchSize = Math.max(1, Math.min(1_000, Math.floor(options.batchSize ?? 100)));
  let deleted = 0;
  for (const idBatch of chunks(ids, batchSize)) {
    assertVectorStoreLease(options.leaseGuard);
    await withRagApiHealth(
      "pinecone",
      pineconeSource,
      userId,
      "rights purge delete",
      () => index.deleteMany({ ids: idBatch }),
      options.leaseGuard,
      options.accountDeletionRequestId ? { accountDeletionRequestId: options.accountDeletionRequestId } : undefined
    );
    assertVectorStoreLease(options.leaseGuard);
    deleted += idBatch.length;
  }
  return { dryRun, ids, deleted };
}

/** Delete an exact durable id set without first depending on provider list visibility. */
export async function purgeVectorRecordIds(options: {
  ids: string[];
  userId?: string;
  namespace?: VectorDataNamespace;
  batchSize?: number;
  leaseGuard?: VectorStoreLeaseGuard;
  /** Exact physical index authority recorded when these ids were created. */
  expectedProviderAuthority?: string;
  /** Exact logical namespace authority recorded when these ids were created. */
  ledgerAuthority?: string;
}): Promise<{ ids: string[]; deleted: number }> {
  const ids = [...new Set(options.ids.filter(Boolean))].sort();
  if (ids.length === 0) return { ids, deleted: 0 };
  const userId = options.userId ?? "local";
  if (usesQdrantWrites()) {
    const providerAuthority = resolveQdrantWriteProviderAuthority(options.ledgerAuthority);
    if (options.expectedProviderAuthority && providerAuthority !== options.expectedProviderAuthority) {
      throw new Error("Exact vector purge provider authority mismatch.");
    }
    if (
      options.namespace === "private" &&
      options.ledgerAuthority &&
      options.expectedProviderAuthority &&
      !hasCurrentPrivateVectorNamespaceRecords(
        userId,
        options.ledgerAuthority,
        options.expectedProviderAuthority
      )
    ) {
      throw new Error("Exact private-vector purge manifest authority mismatch.");
    }
    const namespaceName = vectorNamespaceName(
      options.namespace ?? "default",
      options.ledgerAuthority,
      userId
    );
    await qdrantDeleteByIds({ namespace: namespaceName, ids });
    assertVectorStoreLease(options.leaseGuard);
    return { ids, deleted: ids.length };
  }
  const { pc, initCacheKey, pineconeSource } = await getPineconeClient(userId, options.leaseGuard);
  if (!pc) throw new Error("Pinecone key not configured for exact vector purge.");
  if (!(await indexExists(pc, pineconeSource, userId, undefined, options.leaseGuard))) {
    throw new Error("Pinecone index is unavailable for exact vector purge.");
  }
  await assertIndexMetric(pc, initCacheKey, pineconeSource, userId, options.leaseGuard);
  const providerAuthority = stableProviderAuthorityForInitKey(initCacheKey);
  if (options.expectedProviderAuthority && providerAuthority !== options.expectedProviderAuthority) {
    throw new Error("Exact vector purge provider authority mismatch.");
  }
  if (
    options.namespace === "private" &&
    options.ledgerAuthority &&
    options.expectedProviderAuthority &&
    !hasCurrentPrivateVectorNamespaceRecords(
      userId,
      options.ledgerAuthority,
      options.expectedProviderAuthority
    )
  ) {
    throw new Error("Exact private-vector purge manifest authority mismatch.");
  }
  const index = vectorDataIndex(
    pc,
    options.namespace ?? "default",
    options.ledgerAuthority,
    userId
  );
  const batchSize = Math.max(1, Math.min(1_000, Math.floor(options.batchSize ?? 100)));
  for (const idBatch of chunks(ids, batchSize)) {
    assertVectorStoreLease(options.leaseGuard);
    await withRagApiHealth(
      "pinecone",
      pineconeSource,
      userId,
      "rights purge exact delete",
      () => index.deleteMany({ ids: idBatch }),
      options.leaseGuard
    );
  }
  assertVectorStoreLease(options.leaseGuard);
  return { ids, deleted: ids.length };
}

/** Exact provider verification for durable identities that may live in a user-private namespace. */
export async function fetchExistingVectorRecordIds(options: {
  ids: string[];
  userId?: string;
  namespace?: VectorDataNamespace;
  batchSize?: number;
  leaseGuard?: VectorStoreLeaseGuard;
  /** Exact physical index authority recorded when these ids were created. */
  expectedProviderAuthority?: string;
  /** Exact logical namespace authority recorded when these ids were created. */
  ledgerAuthority?: string;
}): Promise<string[]> {
  const ids = [...new Set(options.ids.filter(Boolean))].sort();
  if (ids.length === 0) return [];
  const userId = options.userId ?? "local";
  assertVectorStoreLease(options.leaseGuard);
  if (usesQdrantWrites()) {
    const providerAuthority = resolveQdrantWriteProviderAuthority(options.ledgerAuthority);
    if (options.expectedProviderAuthority && providerAuthority !== options.expectedProviderAuthority) {
      throw new Error("Exact vector verification provider authority mismatch.");
    }
    if (
      options.namespace === "private" &&
      options.ledgerAuthority &&
      options.expectedProviderAuthority &&
      !hasCurrentPrivateVectorNamespaceRecords(
        userId,
        options.ledgerAuthority,
        options.expectedProviderAuthority
      )
    ) {
      throw new Error("Exact private-vector verification manifest authority mismatch.");
    }
    const namespaceName = vectorNamespaceName(
      options.namespace ?? "default",
      options.ledgerAuthority,
      userId
    );
    return qdrantRetrieveByPcIds({ namespace: namespaceName, ids });
  }
  const { pc, initCacheKey, pineconeSource } = await getPineconeClient(userId, options.leaseGuard);
  if (!pc) throw new Error("Pinecone key not configured for exact vector verification.");
  if (!(await indexExists(pc, pineconeSource, userId, undefined, options.leaseGuard))) {
    if (options.expectedProviderAuthority) {
      throw new Error("Expected Pinecone authority is unavailable for exact vector verification.");
    }
    return [];
  }
  await assertIndexMetric(pc, initCacheKey, pineconeSource, userId, options.leaseGuard);
  const providerAuthority = stableProviderAuthorityForInitKey(initCacheKey);
  if (options.expectedProviderAuthority && providerAuthority !== options.expectedProviderAuthority) {
    throw new Error("Exact vector verification provider authority mismatch.");
  }
  if (
    options.namespace === "private" &&
    options.ledgerAuthority &&
    options.expectedProviderAuthority &&
    !hasCurrentPrivateVectorNamespaceRecords(
      userId,
      options.ledgerAuthority,
      options.expectedProviderAuthority
    )
  ) {
    throw new Error("Exact private-vector verification manifest authority mismatch.");
  }
  const index = vectorDataIndex(
    pc,
    options.namespace ?? "default",
    options.ledgerAuthority,
    userId
  );
  const batchSize = Math.max(1, Math.min(1_000, Math.floor(options.batchSize ?? 100)));
  const existing: string[] = [];
  for (const idBatch of fetchIdChunks(ids, batchSize)) {
    assertVectorStoreLease(options.leaseGuard);
    const fetched = await withRagApiHealth(
      "pinecone",
      pineconeSource,
      userId,
      "rights exact verification",
      () => index.fetch({ ids: idBatch }),
      options.leaseGuard
    );
    for (const id of idBatch) if (fetched.records?.[id]) existing.push(id);
  }
  assertVectorStoreLease(options.leaseGuard);
  return existing.sort();
}

/** Namespace-wide provider erasure for a corpus isolated specifically for revocable rights. */
export async function purgeVectorNamespaceAll(options: {
  userId?: string;
  namespace: "fmp-transcripts";
  leaseGuard?: VectorStoreLeaseGuard;
}): Promise<void> {
  const userId = options.userId ?? "local";
  if (usesQdrantWrites()) {
    const namespaceName = vectorNamespaceName(options.namespace, undefined, userId);
    await qdrantDeleteNamespace({ namespace: namespaceName });
    assertVectorStoreLease(options.leaseGuard);
    return;
  }
  const { pc, pineconeSource } = await getPineconeClient(userId, options.leaseGuard);
  if (!pc) throw new Error("Pinecone key not configured for namespace purge.");
  const index = vectorDataIndex(pc, options.namespace, undefined, userId);
  assertVectorStoreLease(options.leaseGuard);
  await withRagApiHealth(
    "pinecone",
    pineconeSource,
    userId,
    "rights purge namespace delete",
    () => index.deleteAll(),
    options.leaseGuard
  );
  assertVectorStoreLease(options.leaseGuard);
}

/** Exact private-corpus ownership predicate shared by account erasure and its network-free tests. */
export function vectorMetadataBelongsToPrivateUser(
  metadata: Record<string, unknown>,
  userId: string
): boolean {
  const vectorUserId = vectorUserIdFor(userId);
  const metadataUserId = typeof metadata.userId === "string" ? metadata.userId : undefined;
  const tenantScope = typeof metadata.tenant_scope === "string" ? metadata.tenant_scope : undefined;
  const exactPrivateTenant = vectorTenantScope(userId, PRIVATE_SCOPE);

  if (tenantScope === exactPrivateTenant) return true;
  // Before tenant ids were hashed, account-private rows used the exact raw user id. Only the exact
  // owner value is accepted; other private:* tenants remain isolated even if sanitized ids collide.
  if (tenantScope === `private:${userId}`) return true;
  if (tenantScope?.startsWith("private:")) return false;
  // Historical operator memories were incorrectly stamped scope=shared. The account marker plus
  // exact legacy user id distinguishes them from public SEC/web vectors that also use `local`.
  if (metadata.memory_scope === "account") {
    return legacyPrivateMetadataUserMatches(metadataUserId, userId);
  }
  if (metadata.scope === PRIVATE_SCOPE) {
    return tenantScope == null && legacyPrivateMetadataUserMatches(metadataUserId, userId);
  }
  if (metadata.scope === SHARED_SCOPE) {
    // Explicit shared/public writes normally belong to the local application corpus. A nonlocal
    // user id on such a record is still account-linked data and must be erased with that account.
    return vectorUserId !== "local" && legacyPrivateMetadataUserMatches(metadataUserId, userId);
  }
  // Pre-scope non-operator rows were private by construction. A bare local sentinel remains public
  // unless the account-memory marker above proves otherwise.
  return vectorUserId !== "local" && legacyPrivateMetadataUserMatches(metadataUserId, userId);
}

/**
 * Exact provider-side filters for the historical default namespace. A successful filter delete is
 * the authority for records that an eventually-consistent list can omit. Every clause is scoped to
 * an exact tenant/user identity; the local operator's unscoped public SEC corpus is never matched.
 */
export function legacyPrivateVectorDeleteFilters(userId: string): Record<string, unknown>[] {
  const tenantScope = vectorTenantScope(userId, PRIVATE_SCOPE);
  const rawTenantScope = `private:${userId}`;
  const filters: Record<string, unknown>[] = [
    { tenant_scope: { $eq: tenantScope } },
    ...(rawTenantScope === tenantScope ? [] : [{ tenant_scope: { $eq: rawTenantScope } }])
  ];
  if (!isUnambiguousLegacyVectorUserId(userId)) return filters;
  const metadataUserId = vectorUserIdFor(userId);
  const withoutTenant = { tenant_scope: { $exists: false } };
  filters.push(
    { $and: [withoutTenant, { userId: { $eq: metadataUserId } }, { scope: { $eq: PRIVATE_SCOPE } }] },
    { $and: [withoutTenant, { userId: { $eq: metadataUserId } }, { memory_scope: { $eq: "account" } }] }
  );
  if (metadataUserId !== "local") {
    filters.push(
      {
        $and: [
          withoutTenant,
          { userId: { $eq: metadataUserId } },
          { scope: { $exists: false } }
        ]
      },
      {
        $and: [
          withoutTenant,
          { userId: { $eq: metadataUserId } },
          { scope: { $eq: SHARED_SCOPE } }
        ]
      }
    );
  }
  return filters;
}

export interface ManagedVectorReceiptEvidence {
  id: string;
  contentHash: string;
  source: string;
  tenantScope: string;
  userId: string;
  providerAuthority?: string;
  ledgerAuthority?: string;
  vectorNamespace: "managed" | "fmp-transcripts";
}

/** Local identity evidence for purge/reconciliation. Provider metadata is mutable and therefore
 * cannot be the sole authority for proving that a managed vector belongs to a source or tenant. */
export function managedVectorReceiptEvidence(options: {
  source?: string;
  tenantScope?: string;
  userId?: string;
} = {}): ManagedVectorReceiptEvidence[] {
  let rows: Array<{
    vector_id: string;
    content_hash: string;
    source: string;
    tenant_scope: string;
    user_id: string;
    provider_authority: string | null;
    ledger_authority: string | null;
    vector_namespace: "managed" | "fmp-transcripts";
  }>;
  try {
    rows = dbModule.getDb().prepare(`
      SELECT o.vector_id, o.content_hash, c.source, c.tenant_scope, c.user_id,
             c.provider_authority, c.ledger_authority, c.vector_namespace
      FROM chunk_occurrences o
      JOIN vector_ingest_commits c ON c.id = o.commit_id
      ORDER BY o.vector_id
    `).all() as typeof rows;
  } catch (error) {
    // Isolated unit suites replace the DB barrel with a deliberately tiny mock. Production must
    // never lose the relational purge authority silently.
    if (process.env.NODE_ENV === "test") return [];
    throw error;
  }
  return rows
    .filter((row) => options.source === undefined || row.source === options.source)
    .filter((row) => options.tenantScope === undefined || row.tenant_scope === options.tenantScope)
    .filter((row) => options.userId === undefined || row.user_id === options.userId)
    .map((row) => ({
      id: row.vector_id,
      contentHash: row.content_hash,
      source: row.source,
      tenantScope: row.tenant_scope,
      userId: row.user_id,
      ...(row.provider_authority ? { providerAuthority: row.provider_authority } : {}),
      ...(row.ledger_authority ? { ledgerAuthority: row.ledger_authority } : {}),
      vectorNamespace: row.vector_namespace
    }));
}

export interface PurgeManagedVectorsByIdsResult {
  deleted: number;
  ids: string[];
}

/**
 * Delete an exact, caller-provided set of managed-namespace vector ids. This generalizes the same
 * exact-id delete pattern `purgePrivateVectorRecordsForUser`'s local `purgeExactIds` closure uses
 * (chunked `deleteMany({ids})` calls against the managed namespace), for callers that derive their
 * own target id list from LOCAL receipts (e.g. corpus-reembed's legacy-embedding-space purge)
 * rather than a private-account inventory scan. Deliberately takes only exact ids — never a
 * metadata filter — so a purge can never remove more than the caller already proved it owns.
 */
export async function purgeManagedVectorsByIds(
  ids: string[],
  options: { userId?: string; leaseGuard?: VectorStoreLeaseGuard } = {}
): Promise<PurgeManagedVectorsByIdsResult> {
  const uniqueIds = [...new Set(ids)];
  if (uniqueIds.length === 0) return { deleted: 0, ids: [] };
  const userId = options.userId ?? "local";
  assertVectorStoreLease(options.leaseGuard);
  if (usesQdrantWrites()) {
    const namespaceName = vectorNamespaceName("managed", undefined, userId);
    await qdrantDeleteByIds({ namespace: namespaceName, ids: uniqueIds });
    assertVectorStoreLease(options.leaseGuard);
    return { deleted: uniqueIds.length, ids: uniqueIds };
  }
  const { pc, pineconeSource } = await getPineconeClient(userId, options.leaseGuard);
  if (!pc) throw new Error("Pinecone key not configured for managed vector purge.");
  const index = vectorDataIndex(pc, "managed", undefined, userId);
  const batchSize = 100;
  let deleted = 0;
  for (const idBatch of chunks(uniqueIds, batchSize)) {
    assertVectorStoreLease(options.leaseGuard);
    await withRagApiHealth(
      "pinecone",
      pineconeSource,
      userId,
      "corpus-reembed legacy-space purge",
      () => index.deleteMany({ ids: idBatch }),
      options.leaseGuard
    );
    assertVectorStoreLease(options.leaseGuard);
    deleted += idBatch.length;
  }
  return { deleted, ids: uniqueIds };
}

/**
 * Provider-first account erasure for private RAG data. The exact prepared-request id is required so
 * only this operation can cross the provider-dispatch fence. Local receipts/API keys are untouched
 * on any error; retries are idempotent even after a partially completed provider deletion.
 */
export async function purgePrivateVectorRecordsForUser(options: {
  userId: string;
  accountDeletionRequestId: string;
  batchSize?: number;
  maxScanned?: number;
  leaseGuard: VectorStoreLeaseGuard;
}): Promise<{ ids: string[]; contentHashes: string[]; deleted: number }> {
  assertVectorStoreLease(options.leaseGuard);
  if (!options.accountDeletionRequestId.trim()) {
    throw new Error("Prepared account-deletion request id is required for private vector purge.");
  }
  const tenantScope = vectorTenantScope(options.userId, PRIVATE_SCOPE);
  const providerAuthority = await getCurrentVectorProviderAuthority({
    userId: options.userId,
    accountDeletionRequestId: options.accountDeletionRequestId,
    leaseGuard: options.leaseGuard
  });
  assertVectorStoreLease(options.leaseGuard);
  const rawLegacyTenantScope = `private:${options.userId}`;
  const ledgerAuthority = managedVectorLedgerAuthority();
  const authorityDatabase = dbModule.getDb();
  const manifestAuthorities = authorityDatabase.prepare(`
    SELECT tenant_scope, ledger_authority, provider_authority
    FROM vector_private_namespace_manifests
    WHERE tenant_scope IN (?, ?)
  `).all(tenantScope, rawLegacyTenantScope) as Array<{
    tenant_scope: string;
    ledger_authority: string;
    provider_authority: string | null;
  }>;
  const commitAuthorities = authorityDatabase.prepare(`
    SELECT id, ledger_authority, provider_authority
    FROM vector_ingest_commits
    WHERE user_id = ? AND tenant_scope IN (?, ?)
  `).all(options.userId, tenantScope, rawLegacyTenantScope) as Array<{
    id: string;
    ledger_authority: string | null;
    provider_authority: string | null;
  }>;
  const localEvidence = managedVectorReceiptEvidence({ userId: options.userId })
    .filter((row) => row.tenantScope === tenantScope || row.tenantScope === rawLegacyTenantScope);
  const localManagedEvidence = localEvidence.filter((row) => row.id.startsWith("occ:v3:"));
  const authorityEvidence = [
    ...manifestAuthorities.map((row) => ({
      ledgerAuthority: row.ledger_authority,
      providerAuthority: row.provider_authority
    })),
    ...commitAuthorities.map((row) => ({
      ledgerAuthority: row.ledger_authority,
      providerAuthority: row.provider_authority
    })),
    ...localEvidence.map((row) => ({
      ledgerAuthority: row.ledgerAuthority,
      providerAuthority: row.providerAuthority
    }))
  ];
  const historicalAuthorities = new Set(
    authorityEvidence.map((row) => row.providerAuthority).filter((value): value is string => Boolean(value))
  );
  if (authorityEvidence.some((row) => !row.providerAuthority)) {
    throw new Error("Private managed vectors lack a deletable provider authority; account deletion remains pending.");
  }
  if (authorityEvidence.some((row) => row.ledgerAuthority !== ledgerAuthority)) {
    throw new Error("Historical vector ledger authority is not currently reachable; account deletion remains pending.");
  }
  // Receiptless managed crash ghosts can exist even when every local authority table is empty.
  // Without the current provider token their immutable prefix cannot be inventoried or deleted,
  // so a private-account purge must fail closed instead of relying only on namespace deleteAll.
  if (!providerAuthority) {
    throw new Error("Current Pinecone authority is unavailable; account deletion remains pending.");
  }
  if ([...historicalAuthorities].some((authority) => authority !== providerAuthority)) {
    throw new Error("Historical Pinecone authority is not currently reachable; account deletion remains pending.");
  }

  const qdrantWrites = usesQdrantWrites();
  const { pc, pineconeSource } = qdrantWrites
    ? { pc: null as Pinecone | null, pineconeSource: "none" as ApiKeySource }
    : await getPineconeClient(options.userId, options.leaseGuard);
  if (!qdrantWrites && !pc) throw new Error("Pinecone key not configured for account vector purge.");
  const dispatch = { accountDeletionRequestId: options.accountDeletionRequestId };
  const defaultNamespaceName = vectorNamespaceName("default");
  // Submit exact metadata-filter deletes before relying on list/fetch inventory. This reaches live
  // historical rows even when listPaginated omits them; retries are idempotent after a crash.
  for (const filter of legacyPrivateVectorDeleteFilters(options.userId)) {
    assertVectorStoreLease(options.leaseGuard);
    if (qdrantWrites) {
      await qdrantDeleteByFilter({ namespace: defaultNamespaceName, filter });
    } else {
      const defaultIndex = vectorDataIndex(pc!, "default");
      await withRagApiHealth(
        "pinecone",
        pineconeSource,
        options.userId,
        "account legacy-private-filter delete",
        () => defaultIndex.deleteMany({ filter } as any),
        options.leaseGuard,
        dispatch
      );
    }
  }
  assertVectorStoreLease(options.leaseGuard);

  const localManagedIds = new Set(localManagedEvidence.map((row) => row.id));
  const localLegacyIds = new Set(
    localEvidence.filter((row) => !row.id.startsWith("occ:v3:")).map((row) => row.id)
  );
  const managedRows = await inventoryVectorRecordsByMetadata({
    userId: options.userId,
    namespace: "managed",
    prefix: managedOccurrenceVectorPrefix({ ledgerAuthority, providerAuthority, tenantScope }),
    batchSize: options.batchSize,
    maxScanned: options.maxScanned,
    accountDeletionRequestId: options.accountDeletionRequestId,
    leaseGuard: options.leaseGuard
  });
  const legacyRows = await inventoryVectorRecordsByMetadata({
    userId: options.userId,
    namespace: "default",
    batchSize: options.batchSize,
    maxScanned: options.maxScanned,
    accountDeletionRequestId: options.accountDeletionRequestId,
    leaseGuard: options.leaseGuard
  });
  const privateNamespaceRows = await inventoryVectorRecordsByMetadata({
    userId: options.userId,
    namespace: "private",
    batchSize: options.batchSize,
    maxScanned: options.maxScanned,
    accountDeletionRequestId: options.accountDeletionRequestId,
    leaseGuard: options.leaseGuard
  });
  assertVectorStoreLease(options.leaseGuard);
  const managedIds = [...new Set([
    ...localManagedIds,
    ...managedRows.map((row) => row.id)
  ])].sort();
  const privateLegacyRows = legacyRows.filter((row) => (
    localLegacyIds.has(row.id) || vectorMetadataBelongsToPrivateUser(row.metadata, options.userId)
  ));
  const legacyIds = [...new Set([
    ...localLegacyIds,
    ...privateLegacyRows.map((row) => row.id)
  ])].sort();
  const privateNamespaceIds = [...new Set(privateNamespaceRows.map((row) => row.id))].sort();
  const ids = [...new Set([...managedIds, ...legacyIds, ...privateNamespaceIds])].sort();
  const privateRows = [...managedRows, ...privateLegacyRows, ...privateNamespaceRows];
  const contentHashes = [...new Set([
    ...localEvidence.map((row) => row.contentHash),
    ...privateRows.flatMap((row) => {
    const hashes: string[] = [];
    if (typeof row.metadata.content_hash === "string" && row.metadata.content_hash) {
      hashes.push(row.metadata.content_hash);
    }
    if (typeof row.metadata.text === "string" && row.metadata.text.trim()) {
      hashes.push(hashContent(row.metadata.text));
    }
    return hashes;
    })
  ])].sort();
  const batchSize = Math.max(1, Math.min(1_000, Math.floor(options.batchSize ?? 100)));
  let deleted = 0;
  const purgeExactIds = async (namespace: VectorDataNamespace, targetIds: string[]) => {
    if (targetIds.length === 0) return;
    if (qdrantWrites) {
      await qdrantDeleteByIds({
        namespace: vectorNamespaceName(namespace, undefined, options.userId),
        ids: targetIds
      });
      deleted += targetIds.length;
      return;
    }
    const index = vectorDataIndex(pc!, namespace, undefined, options.userId);
    for (const idBatch of chunks(targetIds, batchSize)) {
      assertVectorStoreLease(options.leaseGuard);
      await withRagApiHealth(
        "pinecone",
        pineconeSource,
        options.userId,
        "account private-vector delete",
        () => index.deleteMany({ ids: idBatch }),
        options.leaseGuard,
        dispatch
      );
      assertVectorStoreLease(options.leaseGuard);
      deleted += idBatch.length;
    }
  };
  await purgeExactIds("managed", managedIds);
  await purgeExactIds("default", legacyIds);
  // New direct private writes are isolated by subject namespace. Namespace-wide deletion is the
  // provider authority here: it removes even a live record omitted by eventually-consistent list.
  assertVectorStoreLease(options.leaseGuard);
  if (qdrantWrites) {
    await qdrantDeleteNamespace({
      namespace: vectorNamespaceName("private", undefined, options.userId)
    });
  } else {
    const privateIndex = vectorDataIndex(pc!, "private", undefined, options.userId);
    await withRagApiHealth(
      "pinecone",
      pineconeSource,
      options.userId,
      "account private-namespace delete",
      () => privateIndex.deleteAll(),
      options.leaseGuard,
      dispatch
    );
  }
  assertVectorStoreLease(options.leaseGuard);
  deleted += privateNamespaceIds.length;

  const fetchExactResiduals = async (namespace: VectorDataNamespace, targetIds: string[]) => {
    if (targetIds.length === 0) return [];
    if (qdrantWrites) {
      const existing = await qdrantRetrieveByPcIds({
        namespace: vectorNamespaceName(namespace, undefined, options.userId),
        ids: targetIds
      });
      return existing;
    }
    const remaining: string[] = [];
    const index = vectorDataIndex(pc!, namespace, undefined, options.userId);
    for (const idBatch of fetchIdChunks(targetIds, batchSize)) {
      assertVectorStoreLease(options.leaseGuard);
      const fetched = await withRagApiHealth(
        "pinecone",
        pineconeSource,
        options.userId,
        "account private-vector stability verify",
        () => index.fetch({ ids: idBatch }),
        options.leaseGuard,
        dispatch
      );
      assertVectorStoreLease(options.leaseGuard);
      for (const id of idBatch) if (fetched.records?.[id]) remaining.push(id);
    }
    return remaining;
  };

  const verifyProviderAbsenceOnce = async (): Promise<string[]> => {
    const exactResiduals = [
      ...(await fetchExactResiduals("managed", managedIds)),
      ...(await fetchExactResiduals("default", legacyIds)),
      ...(await fetchExactResiduals("private", privateNamespaceIds))
    ];
    const remainingManaged = await inventoryVectorRecordsByMetadata({
      userId: options.userId,
      namespace: "managed",
      prefix: managedOccurrenceVectorPrefix({ ledgerAuthority, providerAuthority, tenantScope }),
      batchSize: options.batchSize,
      maxScanned: options.maxScanned,
      accountDeletionRequestId: options.accountDeletionRequestId,
      leaseGuard: options.leaseGuard
    });
    const remainingLegacy = (await inventoryVectorRecordsByMetadata({
      userId: options.userId,
      namespace: "default",
      batchSize: options.batchSize,
      maxScanned: options.maxScanned,
      accountDeletionRequestId: options.accountDeletionRequestId,
      leaseGuard: options.leaseGuard
    })).filter((row) => (
      localLegacyIds.has(row.id) || vectorMetadataBelongsToPrivateUser(row.metadata, options.userId)
    ));
    const remainingPrivateNamespace = await inventoryVectorRecordsByMetadata({
      userId: options.userId,
      namespace: "private",
      batchSize: options.batchSize,
      maxScanned: options.maxScanned,
      accountDeletionRequestId: options.accountDeletionRequestId,
      leaseGuard: options.leaseGuard
    });
    assertVectorStoreLease(options.leaseGuard);
    return [...new Set([
      ...exactResiduals,
      ...remainingManaged.map((row) => row.id),
      ...remainingLegacy.map((row) => row.id),
      ...remainingPrivateNamespace.map((row) => row.id)
    ])].sort();
  };

  // Pinecone deletion/list/fetch propagation is eventually consistent. Require a stability window
  // of consecutive clean observations across exact fetches and all relevant inventories. A record
  // that is briefly absent and then reappears resets the streak; local receipts remain untouched
  // so the entire account deletion can be retried safely.
  const verifyAttempts = erasureVerifyAttempts();
  const requiredClean = erasureVerifyConsecutiveClean(verifyAttempts);
  const verifyDelay = erasureVerifyDelayMs();
  let consecutiveClean = 0;
  let lastResiduals: string[] = [];
  for (let attempt = 0; attempt < verifyAttempts; attempt++) {
    if (attempt > 0 && verifyDelay > 0) {
      await sleep(Math.min(30_000, verifyDelay * (2 ** (attempt - 1))), options.leaseGuard.signal);
      assertVectorStoreLease(options.leaseGuard);
    }
    lastResiduals = await verifyProviderAbsenceOnce();
    consecutiveClean = lastResiduals.length === 0 ? consecutiveClean + 1 : 0;
    if (consecutiveClean >= requiredClean) break;
  }
  if (consecutiveClean < requiredClean) {
    throw new Error(
      `Private vector purge stability verification failed (${lastResiduals.length} vector(s) in final observation; ${consecutiveClean}/${requiredClean} consecutive clean).`
    );
  }
  return { ids, contentHashes, deleted };
}

/**
 * Repair or delete managed crash leftovers. Provider-committed vectors are replayed only when an
 * exact local receipt set exists; every other managed provider ghost is deleted. Defaults to a
 * deterministic dry run.
 */
export interface ReconcileManagedVectorRecordsResult {
  dryRun: boolean;
  promoteIds: string[];
  deleteIds: string[];
  invalidateCommitIds: string[];
  /** Proven historical versions whose provider set needs repair but must never be discarded. */
  repairCommitIds: string[];
  quarantineIds: string[];
  promoted: number;
  deleted: number;
  skipped?: boolean;
  operationLease?: OperationLeaseBusy;
}

export async function reconcileManagedVectorRecords(options: {
  userId?: string;
  source?: string;
  dryRun?: boolean;
} = {}): Promise<ReconcileManagedVectorRecordsResult> {
  if (options.dryRun !== false) return reconcileManagedVectorRecordsUnlocked(options);
  const guarded = await runWithOperationLease(
    { group: OPERATION_LEASE_GROUPS.RAG_REINDEX, operation: "reconcile-managed-vectors" },
    async (claim, signal) => {
      const leaseGuard: VectorStoreLeaseGuard = {
        signal,
        assertOwnership: () => {
          throwIfOperationLeaseCancelled(signal);
          assertOperationLeaseOwnership(claim);
        }
      };
      return reconcileManagedVectorRecordsUnlocked(options, leaseGuard);
    }
  );
  if (guarded.acquired) return guarded.value;
  return {
    dryRun: false,
    promoteIds: [],
    deleteIds: [],
    invalidateCommitIds: [],
    repairCommitIds: [],
    quarantineIds: [],
    promoted: 0,
    deleted: 0,
    skipped: true,
    operationLease: guarded.busy
  };
}

function emptyReconcileResult(dryRun: boolean, skipped = false): ReconcileManagedVectorRecordsResult {
  return {
    dryRun,
    promoteIds: [],
    deleteIds: [],
    invalidateCommitIds: [],
    repairCommitIds: [],
    quarantineIds: [],
    promoted: 0,
    deleted: 0,
    ...(skipped ? { skipped: true } : {})
  };
}

async function reconcileManagedVectorRecordsUnlocked(
  options: { userId?: string; source?: string; dryRun?: boolean },
  operationLeaseGuard?: VectorStoreLeaseGuard
): Promise<ReconcileManagedVectorRecordsResult> {
  assertVectorStoreLease(operationLeaseGuard);
  const dryRun = options.dryRun !== false;
  try {
    assertGatherSafeWholeIndexInventory();
  } catch (error) {
    if (isWholeIndexInventoryDeferredError(error)) return emptyReconcileResult(dryRun, true);
    throw error;
  }
  const userId = options.userId ?? "local";
  let providerAuthority: string | undefined;
  try {
    providerAuthority = await getCurrentVectorProviderAuthority({
      userId,
      leaseGuard: operationLeaseGuard
    });
  } catch (error) {
    assertVectorStoreLease(operationLeaseGuard);
    const msg = error instanceof Error ? error.message : String(error);
    if (isPineconeWuExhaustedError(msg) || isWholeIndexInventoryDeferredError(error)) {
      return emptyReconcileResult(dryRun, true);
    }
    throw error;
  }
  assertVectorStoreLease(operationLeaseGuard);
  if (!providerAuthority) {
    return emptyReconcileResult(dryRun, true);
  }
  const ledgerAuthority = managedVectorLedgerAuthority();
  const targetNamespace: "managed" | "fmp-transcripts" = options.source === "fmp-earnings-transcript"
    ? "fmp-transcripts"
    : "managed";
  let providerRows: VectorMetadataInventoryRow[];
  try {
    providerRows = (await inventoryVectorRecordsByMetadata({
      userId,
      namespace: targetNamespace,
      prefix: managedOccurrenceVectorPrefix({ ledgerAuthority, providerAuthority }),
      leaseGuard: operationLeaseGuard
    })).filter((row) => (
      row.metadata.receipt_required === true ||
      typeof row.metadata.vector_commit_id === "string" ||
      isManagedOccurrenceVectorId(row.id)
    ));
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (isWholeIndexInventoryDeferredError(error) || isPineconeWuExhaustedError(msg)) return emptyReconcileResult(dryRun, true);
    if (
      !usesQdrantWrites() &&
      /rate limit|429|too many requests|Pinecone connection failed|fetch failed/i.test(msg)
    ) {
      return emptyReconcileResult(dryRun, true);
    }
    throw error;
  }
  assertVectorStoreLease(operationLeaseGuard);
  // Resolve the mutation client before claiming any SQLite reconciliation fences. Inventory uses
  // the same provider, but this explicit preflight prevents a later configuration/client failure
  // from parking otherwise untouched commits behind fresh reconciliation leases.
  const qdrantWrites = usesQdrantWrites();
  const mutationNamespaceName = vectorNamespaceName(targetNamespace, ledgerAuthority);
  const mutationClients = dryRun || qdrantWrites
    ? undefined
    : await getClients(userId, operationLeaseGuard);
  assertVectorStoreLease(operationLeaseGuard);
  if (!dryRun && !qdrantWrites && !mutationClients?.pc) {
    throw new Error("Pinecone key not configured for vector reconciliation.");
  }
  const mutationIndex = mutationClients?.pc
    ? vectorDataIndex(mutationClients.pc, targetNamespace, ledgerAuthority)
    : undefined;
  const database = dbModule.getDb();
  const reconciledAt = new Date().toISOString();
  const knownCommitRows = database.prepare(`
    SELECT id, source FROM vector_ingest_commits
  `).all() as Array<{ id: string; source: string }>;
  const knownCommitSources = new Map(knownCommitRows.map((row) => [row.id, row.source]));
  const commitRows = database.prepare(`
    SELECT c.id, c.tenant_scope, c.user_id, c.provider_authority, c.ledger_authority,
           c.source, c.accession, c.document_key, c.content_version,
           c.retrieval_metadata_version, c.parser_revision, c.embed_revision,
           c.expected_vectors, c.state,
           c.attempt_token, c.lease_expires_at,
           CASE WHEN h.commit_id IS NULL THEN 0 ELSE 1 END AS is_active
           ,CASE WHEN v.commit_id IS NULL THEN 0 ELSE 1 END AS is_versioned
    FROM vector_ingest_commits c
    LEFT JOIN vector_document_versions v ON v.commit_id = c.id
    LEFT JOIN vector_document_heads h
      ON h.commit_id = c.id
      AND h.tenant_scope = c.tenant_scope
      AND h.source = c.source
      AND h.accession = c.document_key
    WHERE c.state IN ('pending','receipts_persisted','committed','aborted')
      AND c.ledger_authority = ?
      AND c.provider_authority = ?
      AND c.vector_namespace = ?
      ${options.source === undefined ? "" : "AND c.source = ?"}
  `).all(ledgerAuthority, providerAuthority, targetNamespace, ...(options.source === undefined ? [] : [options.source])) as Array<{
    id: string;
    tenant_scope: string;
    user_id: string;
    provider_authority: string | null;
    ledger_authority: string | null;
    source: string;
    accession: string;
    document_key: string;
    content_version: string;
    retrieval_metadata_version: string;
    parser_revision: string;
    embed_revision: string;
    expected_vectors: number;
    state: string;
    attempt_token: string | null;
    lease_expires_at: string | null;
    is_active: number;
    is_versioned: number;
  }>;
  const commits = new Map(commitRows.map((row) => [row.id, row]));
  const localRows = database.prepare(`
    SELECT o.vector_id, o.commit_id, o.content_version, o.tenant_scope,
           o.content_hash, o.symbol, o.source, o.accession, o.section, o.ordinal,
           o.receipt_state, c.state AS commit_state
    FROM chunk_occurrences o
    JOIN vector_ingest_commits c ON c.id = o.commit_id
    WHERE o.receipt_state IN ('pending','committed')
      AND c.ledger_authority = ?
      AND c.provider_authority = ?
      AND c.vector_namespace = ?
      ${options.source === undefined ? "" : "AND c.source = ?"}
  `).all(ledgerAuthority, providerAuthority, targetNamespace, ...(options.source === undefined ? [] : [options.source])) as Array<{
    vector_id: string;
    commit_id: string;
    content_version: string;
    tenant_scope: string;
    content_hash: string;
    symbol: string;
    source: string;
    accession: string;
    section: string;
    ordinal: number;
    receipt_state: string;
    commit_state: string;
  }>;
  const local = new Map(localRows.map((row) => [row.vector_id, row]));
  const localByCommit = new Map<string, typeof localRows>();
  for (const row of localRows) {
    const grouped = localByCommit.get(row.commit_id) ?? [];
    grouped.push(row);
    localByCommit.set(row.commit_id, grouped);
  }
  const providerByCommit = new Map<string, VectorMetadataInventoryRow[]>();
  const providerCommitIds = new Map<string, string>();
  const consideredProviderRows: VectorMetadataInventoryRow[] = [];
  for (const providerRow of providerRows) {
    const metadata = providerRow.metadata;
    // A corrupted/missing provider commit id must not detach a known deterministic vector from its
    // local receipt and bypass the commit CAS/grace path.
    const commitId = local.get(providerRow.id)?.commit_id ?? (
      typeof metadata.vector_commit_id === "string" ? metadata.vector_commit_id : ""
    );
    if (options.source !== undefined && !commits.has(commitId)) {
      // Never let corrupted provider metadata pull a known commit owned by another source into a
      // source-scoped repair. A genuinely orphaned row can still be deleted by its claimed source.
      const knownSource = knownCommitSources.get(commitId);
      if (knownSource !== undefined && knownSource !== options.source) continue;
      if (knownSource === undefined && metadata.source !== options.source) continue;
    }
    consideredProviderRows.push(providerRow);
    providerCommitIds.set(providerRow.id, commitId);
    const grouped = providerByCommit.get(commitId) ?? [];
    grouped.push(providerRow);
    providerByCommit.set(commitId, grouped);
  }
  const promoteRows: Array<{ row: VectorMetadataInventoryRow; commitId: string; attemptToken: string }> = [];
  const deleteRows = new Map<string, VectorMetadataInventoryRow>();
  const commitsToFinalize = new Map<string, string>();
  const commitsToInvalidate = new Map<string, string>();
  const commitsToComplete = new Map<string, string>();
  const historicalCommitRows = database.prepare(`
    SELECT id FROM vector_ingest_commits
    WHERE state = 'committed'
      AND (ledger_authority IS NULL OR ledger_authority <> ? OR
           provider_authority IS NULL OR provider_authority <> ?)
      AND vector_namespace = ?
      ${options.source === undefined ? "" : "AND source = ?"}
  `).all(ledgerAuthority, providerAuthority, targetNamespace, ...(options.source === undefined ? [] : [options.source])) as Array<{ id: string }>;
  const commitsToRepair = new Set(historicalCommitRows.map((row) => row.id));
  const claimedTokens = new Map<string, string>();

  const claimForMutation = (commit: (typeof commitRows)[number]): string | undefined => {
    assertVectorStoreLease(operationLeaseGuard);
    if (!commit.attempt_token) return undefined;
    if (dryRun) return commit.attempt_token;
    const token = `reconcile:${crypto.randomUUID()}`;
    const claimed = dbModule.claimVectorCommitForReconciliation(
      commit.id,
      commit.attempt_token,
      commit.state as dbModule.VectorCommitState,
      commit.is_active === 1,
      token,
      new Date(Date.now() + VECTOR_COMMIT_LEASE_MS).toISOString(),
      reconciledAt
    );
    if (!claimed) return undefined;
    claimedTokens.set(commit.id, token);
    return token;
  };

  for (const providerRow of consideredProviderRows) {
    const commitId = providerCommitIds.get(providerRow.id) ?? "";
    if (!commits.has(commitId)) deleteRows.set(providerRow.id, providerRow);
  }

  for (const commit of commitRows) {
    const providerGroup = providerByCommit.get(commit.id) ?? [];
    const localGroup = localByCommit.get(commit.id) ?? [];
    const hasLiveLease = Boolean(
      commit.lease_expires_at && commit.lease_expires_at > reconciledAt
    );
    if (hasLiveLease) continue;
    if (commit.state === "aborted" && providerGroup.length === 0) continue;

    const expectedReceiptState = commit.state === "committed" ? "committed" : "pending";
    const exactLocalSet =
      localGroup.length === commit.expected_vectors &&
      new Set(localGroup.map((row) => row.vector_id)).size === commit.expected_vectors &&
      localGroup.every((row) =>
        row.commit_id === commit.id &&
        row.tenant_scope === commit.tenant_scope &&
        row.content_version === commit.content_version &&
        row.source === commit.source &&
        row.accession === commit.accession &&
        row.receipt_state === expectedReceiptState
      );
    const exactProviderSet =
      Boolean(providerAuthority) &&
      commit.provider_authority === providerAuthority &&
      commit.ledger_authority === ledgerAuthority &&
      providerGroup.length === commit.expected_vectors &&
      new Set(providerGroup.map((row) => row.id)).size === commit.expected_vectors &&
      localGroup.every((receipt) => providerGroup.some((row) => row.id === receipt.vector_id)) &&
      providerGroup.every((candidate) => {
        const receipt = local.get(candidate.id);
        const metadata = candidate.metadata;
        return Boolean(
          receipt &&
          candidate.id.startsWith("occ:v3:") &&
          managedOccurrenceVectorIdMatches({
            id: candidate.id,
            ledgerAuthority,
            providerAuthority: providerAuthority!,
            tenantScope: commit.tenant_scope,
            source: commit.source
          }) &&
          metadata.receipt_required === true &&
          metadata.ingest_state === (commit.state === "committed" ? "committed" : "pending") &&
          metadata.vector_attempt_token === commit.attempt_token &&
          metadata.scope === (
            commit.tenant_scope === vectorTenantScope("local", SHARED_SCOPE)
              ? SHARED_SCOPE
              : PRIVATE_SCOPE
          ) &&
          metadata.userId === vectorUserIdFor(commit.user_id) &&
          metadata.ledger_authority === ledgerAuthority &&
          metadata.provider_authority === providerAuthority &&
          metadata.vector_commit_id === commit.id &&
          metadata.document_key === commit.document_key &&
          metadata.content_version === receipt.content_version &&
          metadata.tenant_scope === receipt.tenant_scope &&
          metadata.content_hash === receipt.content_hash &&
          metadata.symbol === receipt.symbol &&
          metadata.source === receipt.source &&
          metadata.accession === receipt.accession &&
          metadata.section === receipt.section &&
          metadata.chunk_ordinal === receipt.ordinal &&
          metadata.parser_revision === commit.parser_revision &&
          metadata.embed_revision === commit.embed_revision &&
          metadata.retrieval_metadata_version === commit.retrieval_metadata_version &&
          retrievalMetadataVersionFromMetadata(metadata) === commit.retrieval_metadata_version &&
          metadata[AS_OF_EPOCH_FIELD] === resolveAsOfEpochMs(metadata)
        );
      });
    const canFinalize =
      Boolean(commit.attempt_token) &&
      exactLocalSet &&
      exactProviderSet &&
      (commit.state === "receipts_persisted" || (commit.state === "committed" && commit.is_versioned === 1));

    if (!canFinalize) {
      if (commit.state === "committed" && commit.is_versioned === 1) {
        const provenanceUpgradeRequired = (
          !providerAuthority ||
          commit.provider_authority !== providerAuthority ||
          providerGroup.some((row) => (
            row.metadata.ledger_authority !== ledgerAuthority ||
            row.metadata.provider_authority !== providerAuthority ||
            !managedOccurrenceVectorIdMatches({
              id: row.id,
              ledgerAuthority,
              providerAuthority,
              tenantScope: commit.tenant_scope,
              source: commit.source
            })
          ))
        );
        // Existing committed evidence that predates physical-provider provenance is fail-closed at
        // retrieval, but routine reconciliation must not erase it. Keep it intact for an explicit
        // deterministic re-ingest/backfill that can create v3 ids and current-authority receipts.
        if (provenanceUpgradeRequired) {
          commitsToRepair.add(commit.id);
          continue;
        }
        const fingerprint = crypto.createHash("sha256").update(JSON.stringify({
          commitId: commit.id,
          ledgerAuthority,
          currentProviderAuthority: providerAuthority ?? null,
          commitProviderAuthority: commit.provider_authority,
          expectedVectors: commit.expected_vectors,
          local: [...localGroup]
            .sort((a, b) => a.vector_id.localeCompare(b.vector_id))
            .map((row) => [
              row.vector_id, row.content_hash, row.symbol, row.source, row.accession,
              row.section, row.ordinal, row.receipt_state, row.tenant_scope, row.content_version
            ]),
          provider: [...providerGroup]
            .sort((a, b) => a.id.localeCompare(b.id))
            .map((row) => [
              row.id,
              row.metadata.vector_commit_id,
              row.metadata.ledger_authority,
              row.metadata.provider_authority,
              row.metadata.receipt_required,
              row.metadata.ingest_state,
              row.metadata.vector_attempt_token,
              row.metadata.userId,
              row.metadata.scope,
              row.metadata.content_hash,
              row.metadata.symbol,
              row.metadata.source,
              row.metadata.accession,
              row.metadata.section,
              row.metadata.chunk_ordinal,
              row.metadata.content_version,
              row.metadata.tenant_scope,
              row.metadata.parser_revision,
              row.metadata.embed_revision,
              row.metadata.retrieval_metadata_version,
              retrievalMetadataVersionFromMetadata(row.metadata),
              row.metadata[AS_OF_EPOCH_FIELD]
            ])
        }), "utf8").digest("hex");
        // A dry run must not advance the two-observation confirmation clock or claim that a
        // committed version is safe to remove. A superseded version is historical evidence: even
        // after a confirmed anomaly it remains in the interval ledger and is reported for repair,
        // never invalidated/purged by routine reconciliation.
        if (dryRun) {
          commitsToRepair.add(commit.id);
          continue;
        }
        const observation = dbModule.recordVectorReconcileObservation(commit.id, fingerprint, reconciledAt);
        const ageMs = Date.parse(reconciledAt) - Date.parse(observation.firstObservedAt);
        if (commit.is_active !== 1) {
          commitsToRepair.add(commit.id);
          continue;
        }
        if (
          observation.observationCount < 2 ||
          !Number.isFinite(ageMs) ||
          ageMs < VECTOR_RECONCILE_CONFIRMATION_GRACE_MS
        ) continue;
        // Pinecone list inventory is eventually consistent and cannot prove an expected id is
        // absent. Even repeated omissions may only mark an active committed generation for exact
        // fetch/backfill repair; routine reconciliation must never delete its observed subset or
        // invalidate the local head from list evidence alone.
        commitsToRepair.add(commit.id);
        continue;
      }
      const claimedToken = claimForMutation(commit);
      if (!claimedToken) continue;
      for (const row of providerGroup) deleteRows.set(row.id, row);
      commitsToInvalidate.set(commit.id, claimedToken);
      continue;
    }

    if (!dryRun && commit.state === "committed" && commit.is_versioned === 1) {
      dbModule.clearVectorReconcileObservation(commit.id);
    }

    const providerAlreadyCurrent = providerGroup.every((row) =>
      row.metadata.ingest_state === "committed" &&
      row.metadata.vector_attempt_token === commit.attempt_token
    );
    if (commit.state === "committed" && providerAlreadyCurrent) continue;

    const attemptToken = claimForMutation(commit);
    if (!attemptToken) continue;
    for (const row of providerGroup) {
      if (
        row.metadata.ingest_state !== "committed" ||
        row.metadata.vector_attempt_token !== attemptToken
      ) promoteRows.push({ row, commitId: commit.id, attemptToken });
    }
    if (commit.state === "receipts_persisted") commitsToFinalize.set(commit.id, attemptToken);
    else if (!dryRun) commitsToComplete.set(commit.id, attemptToken);
  }

  const promoteIds = promoteRows.map(({ row }) => row.id).sort();
  // Rows with neither a provider commit id nor a matching local receipt are fail-closed at query
  // time, but cannot be deleted safely under a commit CAS. Quarantine/report them for an explicit
  // operator purge instead of racing a deterministic ingest that began after inventory.
  const quarantineIds = [...deleteRows.values()]
    .filter((row) => !(providerCommitIds.get(row.id) ?? ""))
    .map((row) => row.id)
    .sort();
  const quarantined = new Set(quarantineIds);
  const deleteIds = [...deleteRows.keys()].filter((id) => !quarantined.has(id)).sort();
  const invalidateCommitIds = [...commitsToInvalidate.keys()].sort();
  const repairCommitIds = [...commitsToRepair].sort();
  if (dryRun) {
    return {
      dryRun,
      promoteIds,
      deleteIds,
      invalidateCommitIds,
      repairCommitIds,
      quarantineIds,
      promoted: 0,
      deleted: 0
    };
  }

  if (!qdrantWrites && (!mutationClients || !mutationIndex)) {
    throw new Error("Pinecone key not configured for vector reconciliation.");
  }
  const pineconeSource = mutationClients?.pineconeSource;
  const renewReconciliationLease = (commitId: string, attemptToken: string): void => {
    dbModule.renewVectorCommitReconciliationLease(
      commitId,
      attemptToken,
      new Date(Date.now() + VECTOR_COMMIT_LEASE_MS).toISOString()
    );
  };
  for (const { row, commitId, attemptToken } of promoteRows) {
    assertVectorStoreLease(operationLeaseGuard);
    renewReconciliationLease(commitId, attemptToken);
    if (qdrantWrites) {
      await qdrantSetPayload({
        namespace: mutationNamespaceName,
        ids: [row.id],
        payload: { ingest_state: "committed", vector_attempt_token: attemptToken }
      });
    } else {
      await withRagApiHealth(
        "pinecone",
        pineconeSource!,
        userId,
        "reconcile commit",
        () => mutationIndex!.update({
          id: row.id,
          metadata: { ingest_state: "committed", vector_attempt_token: attemptToken }
        }),
        operationLeaseGuard
      );
    }
    renewReconciliationLease(commitId, attemptToken);
  }
  // Finalize only after the complete expected provider set was observed. A partial provider set
  // is deleted above and remains locally non-queryable until the deterministic ingest retries.
  for (const [commitId, attemptToken] of commitsToFinalize) {
    renewReconciliationLease(commitId, attemptToken);
    dbModule.markVectorCommitCommitted(commitId, attemptToken);
  }

  const claimedDeleteGroups = new Map<string, { attemptToken: string; ids: string[] }>();
  const claimedOrphanDeleteGroups = new Map<string, { claimToken: string; ids: string[] }>();
  for (const row of deleteRows.values()) {
    const commitId = providerCommitIds.get(row.id) ?? (
      typeof row.metadata.vector_commit_id === "string" ? row.metadata.vector_commit_id : ""
    );
    const attemptToken = claimedTokens.get(commitId);
    if (!attemptToken) {
      if (!commitId) continue;
      let orphanGroup = claimedOrphanDeleteGroups.get(commitId);
      if (!orphanGroup) {
        const claimToken = `orphan-reconcile:${crypto.randomUUID()}`;
        const claimed = dbModule.claimVectorReconcileOrphan(
          commitId,
          claimToken,
          new Date(Date.now() + VECTOR_COMMIT_LEASE_MS).toISOString()
        );
        if (!claimed) continue;
        orphanGroup = { claimToken, ids: [] };
        claimedOrphanDeleteGroups.set(commitId, orphanGroup);
      }
      orphanGroup.ids.push(row.id);
      continue;
    }
    const group = claimedDeleteGroups.get(commitId) ?? { attemptToken, ids: [] };
    group.ids.push(row.id);
    claimedDeleteGroups.set(commitId, group);
  }
  let deleted = 0;
  for (const [commitId, group] of claimedOrphanDeleteGroups) {
    for (const idBatch of chunks(group.ids, 100)) {
      dbModule.renewVectorReconcileOrphanLease(
        commitId,
        group.claimToken,
        new Date(Date.now() + VECTOR_COMMIT_LEASE_MS).toISOString()
      );
      if (qdrantWrites) {
        await qdrantDeleteByIds({ namespace: mutationNamespaceName, ids: idBatch });
      } else {
        await withRagApiHealth(
          "pinecone",
          pineconeSource!,
          userId,
          "reconcile delete orphan fenced",
          () => mutationIndex!.deleteMany({ ids: idBatch }),
          operationLeaseGuard
        );
      }
      dbModule.renewVectorReconcileOrphanLease(
        commitId,
        group.claimToken,
        new Date(Date.now() + VECTOR_COMMIT_LEASE_MS).toISOString()
      );
      deleted += idBatch.length;
    }
    dbModule.releaseVectorReconcileOrphan(commitId, group.claimToken);
  }
  for (const [commitId, group] of claimedDeleteGroups) {
    for (const idBatch of chunks(group.ids, 100)) {
      renewReconciliationLease(commitId, group.attemptToken);
      if (qdrantWrites) {
        await qdrantDeleteByIds({ namespace: mutationNamespaceName, ids: idBatch });
      } else {
        await withRagApiHealth(
          "pinecone",
          pineconeSource!,
          userId,
          "reconcile delete fenced",
          () => mutationIndex!.deleteMany({ ids: idBatch }),
          operationLeaseGuard
        );
      }
      renewReconciliationLease(commitId, group.attemptToken);
      deleted += idBatch.length;
    }
  }
  for (const [commitId, attemptToken] of commitsToInvalidate) {
    renewReconciliationLease(commitId, attemptToken);
    dbModule.invalidateVectorCommitForReconciliation(commitId, attemptToken);
  }
  for (const [commitId, attemptToken] of commitsToComplete) {
    renewReconciliationLease(commitId, attemptToken);
    dbModule.completeVectorCommitReconciliation(commitId, attemptToken);
  }
  assertVectorStoreLease(operationLeaseGuard);
  return {
    dryRun,
    promoteIds,
    deleteIds,
    invalidateCommitIds,
    repairCommitIds,
    quarantineIds,
    promoted: promoteIds.length,
    deleted
  };
}

export interface RetrievedChunk {
  /** Real Pinecone vector id (NOT a fabricated `<SYMBOL>#i`). */
  id: string;
  text: string;
  score: number;
  source?: string;
  /** The chunk's own acceptance_datetime/timestamp (NOT the query's as_of). */
  as_of?: string;
  doc_type?: string;
  section?: string;
  url?: string;
  /** 'shared' for public/shared-tier docs, 'private' for user-private docs. Undefined for legacy pre-scope vectors. */
  scope?: VectorScope;
  /**
   * Voyage cross-encoder relevance score from the rerank step (distinct from `score`, which is
   * Pinecone cosine similarity). Only present when reranking ran AND returned a score for this
   * chunk — undefined when rerank is off, failed, or the reranker didn't return `relevanceScore`.
   */
  relevanceScore?: number;
  /**
   * Raw Pinecone metadata for this chunk, with the (large, already-surfaced-as-`text`) `text`
   * field omitted (2026-07-04 episodic-retrieval lane, additive). Lets memory-aware callers read
   * fields the typed surface doesn't lift (e.g. `run_id` for same-run exclusion, `return_pct` for
   * counterexample labeling) without vector-db needing to know every memory schema. Undefined only
   * when the match carried no metadata at all.
   */
  metadata?: Record<string, unknown>;
}

/** Map a raw Pinecone match to a chunk carrying REAL provenance (id, score, acceptance date, url). */
export function matchToChunk(match: any): RetrievedChunk {
  return matchToChunkWithOptions(match);
}

/**
 * Internal/advanced mapper variant for post-rerank parent expansion. Kept separate from
 * `matchToChunk` so the long-standing `.map(matchToChunk)` call sites retain their normal
 * Array callback signature.
 */
export function matchToChunkWithOptions(match: any, options: { includeParentText?: boolean } = {}): RetrievedChunk {
  const md = (match?.metadata ?? {}) as Record<string, unknown>;
  const asOf = md.acceptance_datetime ?? md.as_of ?? md.timestamp;
  const rawScope = md.scope;
  const scope: VectorScope | undefined =
    rawScope === SHARED_SCOPE || rawScope === PRIVATE_SCOPE ? rawScope : undefined;
  const rerankScore = (match as { _rerankScore?: unknown } | undefined)?._rerankScore;
  // Metadata passthrough (episodic-retrieval lane): everything except the large `text` field,
  // which is already surfaced as `chunk.text`. Only attached when the match had metadata.
  const metadataRest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(md)) {
    if (key !== "text") metadataRest[key] = value;
  }
  return {
    id: String(match?.id ?? ""),
    text: (() => {
      const parentText = md.parent_text;
      const rawText = typeof md.text === "string" ? md.text : "";
      if (options.includeParentText !== false && typeof parentText === "string" && parentText) {
        const headerIndex = rawText.indexOf("\n\n");
        const header = headerIndex >= 0 ? rawText.slice(0, headerIndex) : "";
        return header ? `${header}\n\n${parentText}` : parentText;
      }
      return rawText;
    })(),
    score: typeof match?.score === "number" ? match.score : 0,
    source: typeof md.source === "string" ? md.source : undefined,
    as_of: asOf != null ? String(asOf) : undefined,
    doc_type: typeof md.doc_type === "string" ? md.doc_type : undefined,
    section: typeof md.section === "string" ? md.section : undefined,
    url: typeof md.url === "string" ? md.url : typeof md.filingUrl === "string" ? md.filingUrl : undefined,
    scope,
    ...(typeof rerankScore === "number" ? { relevanceScore: rerankScore } : {}),
    ...(match?.metadata != null ? { metadata: metadataRest } : {})
  };
}

/**
 * Compact provenance header (2026-07-04 RAG quick-wins, composite review "Provenance headers +
 * stable chunk ids on retrieved chunks"): `strategy.ts` used to join raw chunk text with no
 * indication of doc_type/section/date/relevance, so the model had no signal to weight a fresh 8-K
 * over a stale 10-K, and no visible reference to cite back. Prefixing each chunk with
 * `[10-K · risk-factors · AAPL · 2026-02-01 · rel 0.82]` gives the model exactly that signal inline
 * with the text it's reading, using data `RetrievedChunk` already carries (doc_type/section/as_of/
 * score/relevanceScore) — no new retrieval work. Chunk ids (`RetrievedChunk.id`, the real Pinecone
 * vector id) are already stable/real (see `matchToChunk`) and are NOT part of this text header —
 * they travel alongside it (`SocraticRagAttribution.chunkId`, orchestrator's `chunk_id`) for a
 * future `evidenceRefs` citation mechanism to key off.
 *
 * Date is truncated to YYYY-MM-DD (a citation header doesn't need sub-day precision); relevance
 * prefers the post-rerank `relevanceScore` (Voyage cross-encoder, the more meaningful "is this
 * actually relevant" signal) and falls back to the Pinecone cosine `score` when rerank didn't run.
 * Any missing field is simply omitted rather than rendered as a placeholder — a header for
 * unenriched legacy metadata still degrades gracefully instead of showing "undefined".
 */
export function formatChunkWithProvenance(chunk: RetrievedChunk, symbol?: string): string {
  const parts: string[] = [];
  if (chunk.doc_type) parts.push(chunk.doc_type.toUpperCase());
  if (chunk.section) parts.push(chunk.section);
  const sym = symbol ? canonicalTicker(symbol) : "";
  if (sym) parts.push(sym);
  const accession = bareAccessionFromChunkMetadata(chunk);
  if (accession) parts.push(accession);
  if (chunk.as_of) {
    const dateOnly = String(chunk.as_of).slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateOnly)) parts.push(dateOnly);
  }
  const relevance = chunk.relevanceScore ?? chunk.score;
  if (typeof relevance === "number" && Number.isFinite(relevance)) parts.push(`rel ${relevance.toFixed(2)}`);
  if (parts.length === 0) return chunk.text;
  return `[${parts.join(" · ")}]\n${chunk.text}`;
}

function bareAccessionFromChunkMetadata(chunk: RetrievedChunk): string | null {
  const md = chunk.metadata ?? {};
  const candidates = [md.accession, md.accession_or_event_id, md.document_key, md.doc_id];
  for (const raw of candidates) {
    if (typeof raw !== "string" || !raw.trim()) continue;
    const bare = bareSecAccession(raw);
    if (bare) return bare;
  }
  return null;
}

/**
 * Typed retrieval-status receipt (typed-retrieval-status, 2026-07-06): `retrieveContextDetailed`
 * already computes four distinct reasons an empty (or quality-degraded) result can occur, but
 * previously only surfaced them as Sentry-only warning strings — every caller saw an
 * indistinguishable `[]`/non-empty result. This union names them for callers that opt in via
 * `RetrieveOptions.onStatus`; it is a RECEIPT ONLY and must never gate/alter which chunks are
 * returned (owner philosophy: advisory-only, see AGENTS.md).
 *  - "ok": normal path, chunks returned (possibly empty via `no_memory`, see below).
 *  - "no_memory": pipeline ran cleanly but found zero matching chunks (real empty corpus/query).
 *  - "lookup_failed": missing Pinecone/Voyage keys, or the pipeline threw (outer catch).
 *  - "budget_skipped": skipped before any Voyage/Pinecone call because the daily LLM/RAG budget
 *    (isOverLlmBudget) was already exceeded.
 *  - "degraded": quality path was reduced (R16 per-run budget, managed version crowding/authority,
 *    or an explicit rerank route unavailable while non-empty candidates remained). Core dense
 *    recall still ran — NON-empty, just lower quality. Clean zero-match after successful dense/
 *    lexical recall is `no_memory` even when rerank credentials are missing.
 */
export type RetrievalStatus = "ok" | "no_memory" | "lookup_failed" | "budget_skipped" | "degraded";

/**
 * Retrieve relevant chunks from Pinecone with REAL provenance (id/score/as_of/url) so answers can
 * be grounded and honestly cited.
 */
export interface RetrieveOptions {
  /** Point-in-time guard: drop chunks whose acceptance_datetime is after this ISO date. */
  asOf?: string;
  /**
   * Per-call strict PIT contract. When true, an as-of query also rejects undated evidence across
   * dense, lexical, and parent-context stages. Omitted preserves the VECTOR_ASOF_STRICT default.
   */
  strictAsOf?: boolean;
  /** The account being run, so the RAG budget guard resolves THAT account's ceiling (not the active
   *  account's) in a multi-account scheduler run. Omit for the active-account default (unchanged). */
  connectedAccountId?: string;
  /**
   * Restrict account-derived vector memory to the exact connected account. This is deliberately
   * opt-in so public filings/fundamentals remain cross-account; episodic decision memory opts in.
   * Missing connectedAccountId under `exact` fails closed to an impossible sentinel match.
   */
  accountScope?: "exact";
  /** Restrict to these document types (metadata.doc_type), e.g. ["10-k","10-q"]. */
  docType?: string[];
  /**
   * When true, drop the `symbol == <symbol arg>` metadata clause so retrieval spans ALL symbols
   * (2026-07-04 episodic-retrieval lane, additive). Episodic decision analogs are cross-symbol by
   * design — the same setup on a different ticker is exactly the prior worth surfacing. Default
   * false/omitted = existing per-symbol behavior, byte-for-byte unchanged for every current caller.
   */
  matchAllSymbols?: boolean;
  /** Restrict to a specific filing section (metadata.section). */
  section?: string;
  /** Restrict to a specific source (metadata.source), e.g. "sec-8k". */
  source?: string;
  /** Drop matches whose cosine score is below this (0–1). Applied before reranking. */
  minScore?: number;
  /**
   * Post-rerank relevance floor (0–1): drop chunks whose Voyage cross-encoder `relevanceScore` is
   * below this, applied AFTER reranking. Default-off/opt-in — omitted (or rerank not running)
   * means no post-rerank filtering, so current behavior is byte-for-byte unchanged unless a caller
   * sets this. Has no effect when reranking is disabled or failed (no relevanceScore to filter on).
   */
  minRelevanceScore?: number;
  /**
   * R12 (2026-07-01 RAG backlog): when true (or RAG_APPLY_DEFAULT_FLOORS is truthy) AND `minScore`
   * was NOT explicitly set, applies `defaultMinScore()` (VECTOR_MIN_SCORE, default 0.30) as the
   * cosine floor instead of leaving it unset. `defaultMinScore()` has existed since before this
   * item as a helper that only `strategy.ts`/`orchestrator.ts` remembered to call explicitly — any
   * OTHER/new caller of `retrieveContextDetailed` silently got NO floor. This option closes that
   * gap for new callers without changing either existing call site (both already pass `minScore`
   * explicitly, so `options.minScore == null` is false for them and this option is a no-op).
   * Floor-only: does NOT change reranking behavior on small pools (a full-pool result set is
   * returned regardless of cosine ordering, so there was never a meaningful "run rerank on small
   * pools" half to this item — see the RAG expansion doc R12 for why that half was dropped).
   */
  applyDefaultFloors?: boolean;
  /**
   * R14 (2026-07-01 RAG backlog): opt-in near-duplicate suppression (0-1 Jaccard-shingle
   * threshold) applied after reranking/floors but before the final top-`limit` slice. See
   * `RankPoolOptions.dedupeSimilarity` for the exact pipeline placement. Omitted = current
   * behavior (no dedup pass, near-identical chunks can all appear in the final context).
   */
  dedupeSimilarity?: number;
  /**
   * HyDE + evidence-derived multi-query retrieval (hyde-multiquery-retrieval, 2026-07-05).
   * When present (and non-empty), `retrieveContextDetailed` embeds EACH query independently (via
   * the same query-embed cache as the single-query path), runs a separate Pinecone match per
   * query, and RRF-fuses the per-query ranked id lists into one candidate pool BEFORE the existing
   * `rankPool` pipeline (hybrid/rerank/floors/dedup) runs, unchanged. The primary `query` argument
   * is still used for hybrid BM25 fusion and rerank scoring; `queries` only affects which Pinecone
   * matches are recalled. Omitted/empty = current single-query behavior, byte-for-byte unchanged.
   */
  queries?: string[];
  /**
   * persist-candidate-pool (2026-07-06): current strategy run id, threaded through purely so an
   * opt-in candidate-pool persistence record (see rag/candidate-pool.ts, RAG_PERSIST_CANDIDATE_POOL)
   * can be joined back to the run that produced it. Additive/optional — omitted has zero effect on
   * retrieval behavior either way.
   */
  runId?: string;
  /**
   * Typed retrieval-status receipt (typed-retrieval-status, 2026-07-06, additive/optional). When
   * supplied, invoked exactly once with the classified `RetrievalStatus` before `retrieveContextDetailed`
   * returns. Fire-and-forget from the callee's perspective — a throwing callback is swallowed so it
   * can never break retrieval; never used to alter chunk selection. Omitted = current behavior,
   * byte-for-byte unchanged (no callback invoked, no extra work performed).
   */
  onStatus?: (status: RetrievalStatus) => void;
  /**
   * Optional text-free, per-stage latency/candidate receipt. The same snapshot is persisted as an
   * audit row only when RAG_RETRIEVAL_STAGE_TELEMETRY is enabled; a callback alone stays in-memory.
   */
  onTrace?: (trace: RetrievalTraceSnapshot) => void;
}

/** Invoke `options?.onStatus` best-effort; a throwing callback must never affect retrieval. */
function reportRetrievalStatus(
  options: RetrieveOptions | undefined,
  status: RetrievalStatus,
  ctx?: { userId: string; symbol: string }
): void {
  // P1 fix (2026-09-07): `retrieveContextDetailed` is the shared retrieval path every production
  // caller actually uses (chat orchestrator, strategy, proposer-dossier, experience-memory,
  // lookahead-audit — see test/rag-production-path-contract.test.ts "audit R1", which pins
  // strategy/chat to this function and explicitly forbids retrieveFusedContext in those paths).
  // The search-fusion.ts wrapper's own dense-recall-degraded signal only fires for callers of
  // retrieveFusedContext, which today has zero production callers — so a real query-embed
  // failure on every actual production path went unreported. Emit here instead, unconditionally,
  // so it fires regardless of whether the caller supplied its own onStatus. budget_skipped is
  // deliberately excluded (a caller passing ctx should only do so for a genuine lookup failure;
  // see the call sites below) — a deliberate budget skip is not a provider/lookup failure and
  // must not flood Sentry or inflate the embed-failure metric.
  if (status === "lookup_failed" && ctx) {
    recordEmbedFailure(activeEmbeddingProvider(ctx.userId), "dense-recall-lookup-failed");
    logError("rag.dense_recall_degraded", { symbol: ctx.symbol, userId: ctx.userId, reason: "lookup_failed" });
  }
  if (!options?.onStatus) return;
  try {
    options.onStatus(status);
  } catch {
    // advisory receipt only — never let a callback failure affect retrieval
  }
}

function reportRetrievalTrace(
  trace: RetrievalStageTrace | undefined,
  options: RetrieveOptions | undefined,
  finalCandidates: number,
  userId: string
): void {
  if (!trace) return;
  try {
    const snapshot = trace.snapshot(finalCandidates);
    try {
      options?.onTrace?.(snapshot);
    } catch {
      // advisory callback only
    }
    if (retrievalStageTelemetryEnabled()) audit("rag_retrieval_stage_trace", snapshot, userId);
  } catch {
    // observability must never affect retrieval
  }
}

function lexicalCandidateMatchesOptions(
  candidate: CorpusWideLexicalCandidate,
  options: RetrieveOptions | undefined
): boolean {
  if (options?.source && candidate.source !== options.source) return false;
  if (options?.section && candidate.section !== options.section) return false;
  if (options?.docType?.length) {
    const candidateType = candidate.doc_type?.toLowerCase();
    if (!candidateType || !options.docType.some((value) => value.toLowerCase() === candidateType)) return false;
  }
  return true;
}

const DEFAULT_MANAGED_VERSION_TOP_K_CAP = 1_000;
const MAX_MANAGED_VERSION_TOP_K_CAP = 10_000;

function managedVersionTopKCap(limit: number): number {
  const configured = Math.floor(numericEnv(
    "RAG_MANAGED_VERSION_TOP_K_CAP",
    DEFAULT_MANAGED_VERSION_TOP_K_CAP,
    1
  ));
  return Math.max(limit, Math.min(configured, MAX_MANAGED_VERSION_TOP_K_CAP));
}

/**
 * Count locally proven managed records that match the coarse provider filter but are not eligible
 * under the active-head or point-in-time relational receipt rule. This is an upper bound: fields
 * unavailable in SQLite receipt rows (for example doc_type/account scope) are intentionally not
 * subtracted. Over-counting spends recall capacity; under-counting could let stale generations
 * crowd the provider topK and hide eligible evidence.
 */
export function managedVersionRejectedUpperBound(
  symbol: string,
  userId: string,
  options?: RetrieveOptions
): number {
  try {
    if (typeof dbModule.getDb !== "function") return 0;
    const database = dbModule.getDb();
    if (!database?.prepare) return 0;
    const parsedAsOf = options?.asOf && Number.isFinite(Date.parse(options.asOf))
      ? new Date(options.asOf).toISOString()
      : undefined;
    const conditions = [
      "o.receipt_state = 'committed'",
      "c.state = 'committed'",
      "c.lease_expires_at IS NULL",
      "o.tenant_scope = c.tenant_scope",
      "o.content_version = c.content_version",
      "c.tenant_scope IN (?, ?)"
    ];
    const bindings: Array<string> = [
      vectorTenantScope(userId, PRIVATE_SCOPE),
      vectorTenantScope(userId, SHARED_SCOPE)
    ];
    if (!options?.matchAllSymbols) {
      conditions.push("o.symbol = ?");
      bindings.push(canonicalTicker(symbol));
    }
    if (options?.source) {
      conditions.push("o.source = ?");
      bindings.push(options.source);
    }
    if (options?.section) {
      conditions.push("o.section = ?");
      bindings.push(options.section);
    }

    if (parsedAsOf) {
      conditions.push(`NOT EXISTS (
        SELECT 1 FROM vector_document_versions v
        WHERE v.commit_id = c.id
          AND v.tenant_scope = c.tenant_scope
          AND v.source = c.source
          AND v.document_key = c.document_key
          AND v.valid_from <= ?
          AND (v.valid_to IS NULL OR v.valid_to > ?)
      )`);
      bindings.push(parsedAsOf, parsedAsOf);
    } else {
      conditions.push(`NOT EXISTS (
        SELECT 1 FROM vector_document_heads h
        WHERE h.commit_id = c.id
          AND h.tenant_scope = c.tenant_scope
          AND h.source = c.source
          AND h.accession = c.document_key
      )`);
    }

    const row = database.prepare(`
      SELECT COUNT(*) AS rejected
      FROM chunk_occurrences o
      JOIN vector_ingest_commits c ON c.id = o.commit_id
      WHERE ${conditions.join(" AND ")}
    `).get(...bindings) as { rejected?: number } | undefined;
    const rejected = Number(row?.rejected ?? 0);
    return Number.isFinite(rejected) && rejected > 0 ? Math.floor(rejected) : 0;
  } catch {
    // Retrieval must remain available during a schema migration or in lightweight test mocks.
    return 0;
  }
}

/**
 * Build the optional metadata-filter clauses (doc_type/section/source) shared by both tiers.
 *
 * doc_type is now normalized to lowercase AT WRITE TIME (cleanMetadata), so new vectors are
 * consistent. This still expands every casing variant at query time — NOT simplified to an
 * exact-match — because vectors written before that normalization landed may still carry
 * mixed/upper case (e.g. "10-K") and Pinecone `$in` is exact-match; dropping the variant expansion
 * would silently exclude that legacy data, which is worse than the (cheap) redundant variants.
 */
const EARNINGS_TRANSCRIPT_DOC_TYPE = "earnings-transcript";
const RIGHTS_BLOCKED_DOC_TYPE = "__earnings_transcript_rights_unconfirmed__";

function fmpTranscriptRightsActive(): boolean {
  if (!envFlagOn("FMP_TRANSCRIPT_STORAGE_RIGHTS_CONFIRMED", false)) return false;
  try {
    const row = dbModule.getDb().prepare(`
      SELECT generation, status FROM fmp_transcript_rights_gate WHERE singleton = 1
    `).get() as { generation?: number; status?: string } | undefined;
    return row?.status === "active" && Number.isInteger(row.generation) && Number(row.generation) > 0;
  } catch {
    return false;
  }
}

function docTypeVariants(docTypes: string[]): string[] {
  return Array.from(new Set(docTypes.flatMap((docType) => [docType, docType.toLowerCase(), docType.toUpperCase()])));
}

export function buildExtraFilters(options?: RetrieveOptions): Record<string, unknown> {
  const extra: Record<string, unknown> = {};
  const transcriptRightsConfirmed = fmpTranscriptRightsActive();
  // Independently-gated transcript producers share the "earnings-transcript" doc type:
  // FMP (rights-flag), EarningsCalls.dev (key + kill-switch), and ROIC.ai (key + kill-switch).
  // The doc-type filter stays open when ANY gate is active; the post-fetch guard then
  // enforces the per-SOURCE gate so one producer's consent cannot leak another's chunks.
  const earningsCallsActive = earningsCallsTranscriptsEnabled();
  const roicActive = roicTranscriptsEnabled();
  const anyTranscriptSourceActive = transcriptRightsConfirmed || earningsCallsActive || roicActive;
  if (options?.docType && options.docType.length > 0) {
    const allowedDocTypes = anyTranscriptSourceActive
      ? options.docType
      : options.docType.filter((docType) => docType.toLowerCase() !== EARNINGS_TRANSCRIPT_DOC_TYPE);
    extra.doc_type = allowedDocTypes.length > 0
      ? { $in: docTypeVariants(allowedDocTypes) }
      : { $eq: RIGHTS_BLOCKED_DOC_TYPE };
  }
  if (options?.section) extra.section = { $eq: options.section };
  if (options?.source) {
    extra.source = !transcriptRightsConfirmed && options.source === "fmp-earnings-transcript"
      ? { $eq: "__fmp_transcript_rights_unconfirmed__" }
      : !earningsCallsActive && options.source === EARNINGSCALLS_TRANSCRIPT_SOURCE
        ? { $eq: "__earningscalls_transcripts_disabled__" }
        : !roicActive && options.source === ROIC_TRANSCRIPT_SOURCE
          ? { $eq: "__roic_transcripts_disabled__" }
        : { $eq: options.source };
  }
  if (options?.accountScope === "exact") {
    extra.connected_account_id = { $eq: options.connectedAccountId ?? "__missing_connected_account__" };
  }
  return extra;
}

/**
 * Defense-in-depth for broad retrieval paths that do not send a doc_type filter. Pinecone documents
 * `$nin` but does not define how it treats legacy records where the field is absent; applying it to
 * every default query could therefore hide unrelated old corpus data. Explicit transcript requests
 * are blocked server-side by buildExtraFilters, while this post-fetch guard removes transcript
 * matches before ranking, persistence, or prompt injection without changing missing-field recall.
 */
export function filterMatchesForTranscriptRights<T extends { metadata?: Record<string, unknown> }>(matches: T[]): T[] {
  const rightsConfirmed = fmpTranscriptRightsActive();
  const hasMarkedDerivative = matches.some((match) => match?.metadata?.fmp_derived === true);
  // The everything-passes fast path is only safe when no earningscalls-sourced match needs its
  // own (independent) gate applied — an active FMP rights flag must never resurrect
  // EarningsCalls.dev chunks after the owner pulled that key or set its kill-switch.
  const hasBlockedEarningsCalls = !earningsCallsTranscriptsEnabled() &&
    matches.some((match) => match?.metadata?.source === EARNINGSCALLS_TRANSCRIPT_SOURCE);
  const hasBlockedRoic = !roicTranscriptsEnabled() &&
    matches.some((match) => match?.metadata?.source === ROIC_TRANSCRIPT_SOURCE);
  if (rightsConfirmed && !hasMarkedDerivative && !hasBlockedEarningsCalls && !hasBlockedRoic) {
    return matches;
  }
  let activeGeneration: number | undefined;
  if (rightsConfirmed && hasMarkedDerivative) {
    try {
      const row = dbModule.getDb().prepare(`
        SELECT generation, status FROM fmp_transcript_rights_gate WHERE singleton = 1
      `).get() as { generation?: number; status?: string } | undefined;
      if (row?.status === "active" && Number.isInteger(row.generation) && Number(row.generation) > 0) {
        activeGeneration = Number(row.generation);
      }
    } catch {
      // A marked licensed derivative without an authoritative gate is not eligible for retrieval.
    }
  }
  const earningsCallsActive = earningsCallsTranscriptsEnabled();
  const roicActive = roicTranscriptsEnabled();
  return matches.filter((match) => {
    const docType = match?.metadata?.doc_type;
    const source = match?.metadata?.source;
    if (match?.metadata?.fmp_derived === true) {
      const generation = Number(match.metadata.fmp_rights_generation);
      return rightsConfirmed && activeGeneration !== undefined && generation === activeGeneration;
    }
    // Each producer is gated by its OWN predicate.  An active FMP flag must never
    // resurrect EarningsCalls or ROIC chunks after those keys are pulled.
    if (source === EARNINGSCALLS_TRANSCRIPT_SOURCE) return earningsCallsActive;
    if (source === ROIC_TRANSCRIPT_SOURCE) return roicActive;
    if (rightsConfirmed) return true;
    return source !== "fmp-earnings-transcript" &&
      (typeof docType !== "string" || docType.toLowerCase() !== EARNINGS_TRANSCRIPT_DOC_TYPE);
  });
}

/**
 * Enforce tenant visibility on provider results before relational receipt checks, persistence,
 * reranking, or prompt injection. Pinecone filters reduce the candidate set, but metadata remains
 * untrusted: legacy personal account memory written as `userId=local` must not ride the public
 * compatibility fallback into another user's context.
 */
export function filterMatchesForTenantVisibility<T extends { metadata?: Record<string, unknown> }>(
  matches: T[],
  userId: string = "local"
): T[] {
  const vectorUserId = vectorUserIdFor(userId);
  const privateTenantScope = vectorTenantScope(userId, PRIVATE_SCOPE);
  return matches.filter((match) => {
    const metadata = match?.metadata;
    if (!metadata) return false;
    const scope = metadata.scope;
    const tenantScope = typeof metadata.tenant_scope === "string" ? metadata.tenant_scope : undefined;
    const metadataUserId = typeof metadata.userId === "string" ? metadata.userId : undefined;

    // Some historical account memories were explicitly stamped `scope=shared` before tenant
    // scopes existed. The account marker is more specific than that stale scope label, so enforce
    // exact ownership before accepting either the private or shared branches below.
    if (metadata.memory_scope === "account") {
      if (tenantScope != null) return tenantScope === privateTenantScope;
      return legacyPrivateMetadataUserMatches(metadataUserId, userId);
    }

    if (scope === PRIVATE_SCOPE) {
      return tenantScope
        ? tenantScope === privateTenantScope
        : legacyPrivateMetadataUserMatches(metadataUserId, userId);
    }
    if (scope === SHARED_SCOPE) {
      // Legacy shared/public corpus was written by the local operator. A scope-only nonlocal row
      // is account-linked data, not public evidence, unless a current authoritative tenant scope
      // explicitly marks it shared.
      return tenantScope === "shared:operator" || (tenantScope == null && metadataUserId === "local");
    }
    if (tenantScope?.startsWith("private:")) return tenantScope === privateTenantScope;
    if (tenantScope != null && tenantScope !== "shared:operator") return false;

    // Legacy public corpus used the local sentinel. Other legacy ids are private to that user.
    return metadataUserId === "local" || legacyPrivateMetadataUserMatches(metadataUserId, userId);
  });
}

/**
 * Relational defense in depth for managed records. Pinecone metadata is not trusted by itself: a
 * result must match a locally committed occurrence, commit id, content version, and tenant scope
 * before it can enter ranking/candidate persistence. Any local validation fault drops managed
 * matches while retaining unrelated legacy/direct records.
 */
export function filterMatchesForCommittedReceipts<T extends {
  id?: string;
  metadata?: Record<string, unknown>;
}>(
  matches: T[],
  asOf?: string,
  authority?: { userId?: string; providerAuthority?: string; ledgerAuthority?: string }
): T[] {
  const requestingUserId = authority?.userId ?? "local";
  const providerAuthority = authority?.providerAuthority;
  const visibleTenantScopes = new Set([
    vectorTenantScope("local", SHARED_SCOPE),
    vectorTenantScope(requestingUserId, PRIVATE_SCOPE)
  ]);
  const isManaged = (match: T): boolean => (
    match.metadata?.receipt_required === true ||
    typeof match.metadata?.vector_commit_id === "string" ||
    (typeof match.id === "string" && isManagedOccurrenceVectorId(match.id))
  );
  const managed = matches.filter(isManaged);
  if (managed.length === 0) return matches;
  // Fail closed, explicitly and early, when the caller could not name the physical provider
  // authority.  Every managed match must prove `metadata.provider_authority === providerAuthority`
  // AND `receipt.providerAuthority === providerAuthority`; with no authority to compare against
  // there is no way to prove a record belongs to THIS deployment's index/collection, so no managed
  // record is admissible.  This was previously only implied by a conjunct buried at the end of a
  // ~25-term predicate below — stated here so it cannot be weakened by accident, and so it also
  // covers the receipts lookup itself.
  if (typeof providerAuthority !== "string" || providerAuthority.length === 0) {
    return matches.filter((match) => !isManaged(match));
  }
  const ids = managed.map((match) => typeof match.id === "string" ? match.id : "").filter(Boolean);
  try {
    const ledgerAuthority = authority?.ledgerAuthority ?? managedVectorLedgerAuthority();
    const receipts = dbModule.committedManagedVectorReceipts(ids, asOf);
    return matches.filter((match) => {
      if (!isManaged(match)) return true;
      if (typeof match.id !== "string" || !match.id) return false;
      const metadata = match.metadata;
      if (!metadata) return false;
      const receipt = receipts.get(match.id);
      if (!receipt) return false;
      const expectedScope = receipt.tenantScope === vectorTenantScope("local", SHARED_SCOPE)
        ? SHARED_SCOPE
        : PRIVATE_SCOPE;
      const expectedMetadataUserId = expectedScope === SHARED_SCOPE
        ? "local"
        : vectorUserIdFor(requestingUserId);
      return (
        typeof providerAuthority === "string" &&
        providerAuthority.length > 0 &&
        visibleTenantScopes.has(receipt.tenantScope) &&
        match.id.startsWith("occ:v3:") &&
        managedOccurrenceVectorIdMatches({
          id: match.id,
          ledgerAuthority,
          providerAuthority,
          tenantScope: receipt.tenantScope,
          source: receipt.source
        }) &&
        metadata.receipt_required === true &&
        metadata.ingest_state === "committed" &&
        metadata.scope === expectedScope &&
        metadata.userId === expectedMetadataUserId &&
        metadata.ledger_authority === ledgerAuthority &&
        metadata.provider_authority === providerAuthority &&
        receipt.providerAuthority === providerAuthority &&
        receipt.ledgerAuthority === ledgerAuthority &&
        receipt.vectorNamespace === metadata.vector_namespace &&
        metadata.vector_commit_id === receipt.commitId &&
        metadata.document_key === receipt.documentKey &&
        metadata.vector_attempt_token === receipt.attemptToken &&
        metadata.content_version === receipt.contentVersion &&
        metadata.tenant_scope === receipt.tenantScope &&
        metadata.content_hash === receipt.contentHash &&
        metadata.symbol === receipt.symbol &&
        metadata.source === receipt.source &&
        metadata.accession === receipt.accession &&
        metadata.section === receipt.section &&
        metadata.chunk_ordinal === receipt.ordinal &&
        metadata.parser_revision === receipt.parserRevision &&
        metadata.embed_revision === receipt.embedRevision &&
        metadata.retrieval_metadata_version === receipt.retrievalMetadataVersion &&
        retrievalMetadataVersionFromMetadata(metadata) === receipt.retrievalMetadataVersion &&
        metadata[AS_OF_EPOCH_FIELD] === resolveAsOfEpochMs(metadata)
      );
    });
  } catch {
    return matches.filter((match) => !isManaged(match));
  }
}

export async function retrieveContextDetailed(
  query: string,
  symbol: string,
  limit: number = 3,
  userId: string = "local",
  options?: RetrieveOptions
): Promise<RetrievedChunk[]> {
  const stageTrace = options?.onTrace || retrievalStageTelemetryEnabled()
    ? new RetrievalStageTrace({ query, symbol })
    : undefined;
  const finish = (chunks: RetrievedChunk[]): RetrievedChunk[] => {
    reportRetrievalTrace(stageTrace, options, chunks.length, userId);
    return chunks;
  };
  // Budget guard (durable spend primitive): when the user is over their daily LLM/RAG budget, skip
  // retrieval entirely — no Voyage embed, no Pinecone query, no metered spend. Returns empty like the
  // no-client case, so every caller degrades gracefully. Default OFF (no ceiling) → no-op.
  if (isOverLlmBudget(userId, options?.connectedAccountId)) {
    void captureRagSentryMessage("warning", "RAG retrieval skipped: daily LLM/RAG budget exceeded", {
      provider: "voyage",
      operation: "retrieveContext",
      source: userId === "local" ? "operator" : "user",
      connectedAccountId: options?.connectedAccountId ?? null
    });
    reportRetrievalStatus(options, "budget_skipped");
    return finish([]);
  }
  const vectorUserId = vectorUserIdFor(userId);
  const activeProvider = activeEmbeddingProvider(userId);
  const activeModel = activeEmbeddingModel(userId);
  const hasEmbedSpaceFilter = Object.keys(embedSpaceFilterForModel(activeModel)).length > 0;
  const readBackend: "pinecone" | "qdrant" = hasEmbedSpaceFilter ? vectorReadBackend() : "pinecone";

  const { pc, voyage, initCacheKey, pineconeSource, voyageSource } = await getClients(userId, undefined, {
    skipMissingPineconeAlert: readBackend === "qdrant"
  });
  const hasActiveKey = !!voyage || embeddingCredentialIsUsable(resolveApiKey(activeProvider, userId));
  if (!hasActiveKey) {
    void captureRagSentryMessage("warning", `RAG retrieval skipped: missing ${activeProvider} key`, {
      provider: activeProvider,
      operation: "retrieveContext",
      source: userId === "local" ? "operator" : "user"
    });
    reportRetrievalStatus(options, "lookup_failed", { userId, symbol });
    return finish([]);
  }
  if (readBackend === "pinecone" && !pc) {
    void captureRagSentryMessage("warning", "RAG retrieval skipped: missing Pinecone key", {
      provider: "pinecone",
      operation: "retrieveContext",
      source: userId === "local" ? "operator" : "user"
    });
    reportRetrievalStatus(options, "lookup_failed", { userId, symbol });
    return finish([]);
  }
  // R16 (2026-07-01 RAG backlog): default-off, very-high-ceiling per-run budget check. When
  // tripped, DEGRADE by skipping rerank/hybrid only — never core dense-cosine recall. A no-op
  // (always false) when RAG_RUN_BUDGET_ENABLED is off, so default behavior is unaffected.
  const budgetDegraded = shouldDegradeForBudget(Date.now(), userId);
  if (budgetDegraded) {
    void captureRagSentryMessage("warning", "RAG retrieval degraded: per-run budget reached", {
      provider: "voyage",
      operation: "retrieveContext",
      source: userId === "local" ? "operator" : "user"
    });
  }
  const rerankRoute = activeRerankRoute(userId, Boolean(voyage && typeof voyage.rerank === "function"));
  const rerankRequested = rerankEnabled() && !budgetDegraded;
  const rerankUnavailable = rerankRequested && !rerankRoute.available;
  const wantRerank = rerankRequested && rerankRoute.available;
  if (rerankUnavailable) {
    const endUnavailableRerank = stageTrace?.start("rerank", {
      provider: rerankRoute.provider,
      model: rerankRoute.model,
      route: "unavailable",
      candidatesIn: 0
    });
    endUnavailableRerank?.({ error: new Error(rerankRoute.reason ?? "unavailable") });
    void captureRagSentryMessage("warning", "RAG rerank route unavailable; preserving recall order", {
      provider: rerankRoute.provider,
      model: rerankRoute.model,
      operation: "rerank",
      source: userId === "local" ? "operator" : "user",
      reason: rerankRoute.reason ?? "unavailable"
    });
  }
  const wantHybrid = hybridRetrievalEnabled() && !budgetDegraded;
  // Corpus-wide lexical recall is a local SQLite FTS read, not a paid provider operation. Keep it
  // available when the per-run budget degrades rerank/hybrid so exact filing evidence is not lost;
  // only the quality stages are budget-gated.
  const wantCorpusWideLexical = corpusWideLexicalRetrievalEnabled() && !options?.matchAllSymbols;
  const useAdaptiveRerank = adaptiveRerankEnabled();
  // Over-fetch when we'll post-filter (as-of), rerank, OR hybrid-fuse — so the final top-`limit` is
  // high quality. Hybrid must be included even when rerank is off: otherwise fetchK == limit and the
  // BM25/RRF step only reorders the dense top-N, so an exact ticker/accession hit at dense rank
  // limit+1 is never in the pool and the recall gap the flag targets can't be recovered.
  // When reranking will actually run, use the wider env-tunable rerank-path cap (default 150) — the
  // cross-encoder is cheap to run over hundreds of candidates and a modest-50 cap otherwise hides a
  // flip-the-decision chunk at dense rank 51+ from ever reaching it. Non-rerank over-fetch (as-of or
  // hybrid alone) keeps the existing modest `overFetchK` cap — this does not change their Pinecone topK.
  const preRecallRerankPlan = planRerank({
    query,
    limit,
    availableCandidates: RERANK_MAX_DOCUMENTS,
    enabled: wantRerank,
    adaptiveEnabled: useAdaptiveRerank
  });
  const baseFetchK = wantRerank
    ? preRecallRerankPlan.candidateLimit
    : options?.asOf || wantHybrid || wantCorpusWideLexical
      ? overFetchK(limit)
      : limit;
  const rejectedVersionUpperBound = managedVersionRejectedUpperBound(symbol, userId, options);
  const managedTopKCap = managedVersionTopKCap(limit);
  const requestedManagedFetchK = Math.max(baseFetchK, limit + rejectedVersionUpperBound);
  const fetchK = Math.min(managedTopKCap, requestedManagedFetchK);
  const managedTopKCapHit = requestedManagedFetchK > managedTopKCap;
  // Embedding-space isolation (PR #1669 P1): when a non-Voyage embedding model is active, restrict
  // every dense query to vectors stamped with that same model — a BGE query vector must never rank
  // voyage-finance-2 records. Empty (no clause; legacy behavior byte-identical) when Voyage is
  // active, which keeps pre-`embed_model` vectors retrievable.
  const extraFilter = { ...buildExtraFilters(options), ...buildEmbedSpaceFilter(userId) };

  // server-asof-filter (2026-07-06): the optional server-side point-in-time clause. `undefined`
  // (asOf unset/unparseable, or VECTOR_ASOF_SERVER_FILTER off) means NO clause is added — the
  // filters below are then byte-identical to today. `mergeAsOfEpoch` AND-combines it with the
  // existing scope/symbol/docType filter (via `$and` when the base already carries a top-level `$or`,
  // so the fail-open epoch `$or` cannot collide with the scope-coexistence `$or`).
  const strictAsOf = options?.strictAsOf ?? asOfStrictEnabled();
  const asOfEpochFilter = buildAsOfEpochFilter(options?.asOf, strictAsOf);

  try {
    let stableProviderAuthority: string | undefined;
    let defaultIndex: any;
    let managedIndex: any;
    let privateIndex: any;
    let fmpIndex: any;

    // R7 index-metric assertion runs on BOTH read backends whenever a Pinecone client exists.
    // #3138 skipped it when `pc` was absent; #3158 narrowed it further to `readBackend ===
    // "pinecone"`, which silently dropped BOTH of its jobs on the Qdrant path: the cosine-metric
    // warning, and populating `indexAuthorityByInitKey` — the only in-process source of a
    // Pinecone-derived provider authority.  It is cached per init key (`indexMetricChecked`) and
    // documented never to throw for provider/metric faults, so running it here costs at most one
    // `describeIndex` per process and cannot fail a retrieval pass.  Only the AUTHORITY it mints
    // stays backend-specific: on the Qdrant path the records were committed under the durable
    // authority read from the commit ledger below, so the Pinecone host authority must NOT
    // pre-empt it — taking it here would drop every managed match on an authority mismatch.
    if (pc && initCacheKey) {
      try {
        await assertIndexMetric(pc, initCacheKey, pineconeSource, userId);
      } catch {
        // fail-soft on metric check
      }
      if (readBackend === "pinecone") {
        stableProviderAuthority = stableProviderAuthorityForInitKey(initCacheKey);
      }
    }

    if (readBackend === "qdrant") {
      try {
        await assertQdrantCollectionMetric();
      } catch {
        // fail-soft on Qdrant metric check
      }
    }

    if (readBackend === "pinecone") {
      if (!pc || !(await indexExists(pc, pineconeSource, userId))) {
        reportRetrievalStatus(options, "lookup_failed", { userId, symbol });
        return finish([]);
      }
      defaultIndex = vectorDataIndex(pc, "default");
    }
    const ledgerAuthority = managedVectorLedgerAuthority();
    if (!stableProviderAuthority) {
      try {
        if (typeof dbModule.durableProviderAuthority === "function") {
          stableProviderAuthority = dbModule.durableProviderAuthority(ledgerAuthority);
        }
      } catch {
        stableProviderAuthority = undefined;
      }
      if (!stableProviderAuthority && (readBackend === "qdrant" || usesQdrantWrites())) {
        stableProviderAuthority = qdrantProviderAuthority();
      }
    }
    const providerAuthority = stableProviderAuthority;
    const managedRecordsExpected = hasCommittedManagedRecords();
    const currentManagedRecordsExpected = hasCommittedVectorNamespaceRecords(ledgerAuthority, "managed");
    const currentFmpRecordsExpected = hasCommittedVectorNamespaceRecords(ledgerAuthority, "fmp-transcripts");
    const managedAuthorityDegraded = managedRecordsExpected && (
      !stableProviderAuthority ||
      hasUnreachableCommittedManagedRecords(ledgerAuthority, stableProviderAuthority)
    );
    // Fail closed without an authority.  `managedAuthorityClause` below pins
    // `provider_authority: { $eq: stableProviderAuthority }`; an undefined value is dropped by
    // JSON serialization, so the provider would receive `provider_authority: {}` — the
    // server-side half of the committed-receipts gate silently widened to "any authority"
    // instead of refusing.  If we cannot name the authority we do not query the receipt-bearing
    // namespaces at all.  (The Pinecone branch already had this guard; the Qdrant branch did not.)
    const queryManagedNamespace = Boolean(stableProviderAuthority && currentManagedRecordsExpected);
    if (pc && queryManagedNamespace) {
      managedIndex = vectorDataIndex(pc, "managed", ledgerAuthority);
    }
    const queryPrivateNamespace = readBackend === "qdrant"
      ? Boolean(stableProviderAuthority)
      : hasCurrentPrivateVectorNamespaceRecords(
          userId,
          ledgerAuthority,
          stableProviderAuthority
        );
    if (pc && queryPrivateNamespace) {
      privateIndex = vectorDataIndex(pc, "private", ledgerAuthority, userId);
    }
    const queryFmpNamespace = readBackend === "qdrant"
      ? Boolean(stableProviderAuthority && currentFmpRecordsExpected && fmpTranscriptRightsActive())
      : Boolean(
          stableProviderAuthority &&
          currentFmpRecordsExpected &&
          fmpTranscriptRightsActive()
        );
    if (pc && queryFmpNamespace) {
      fmpIndex = vectorDataIndex(pc, "fmp-transcripts", ledgerAuthority);
    }
    const defaultNamespaceName = vectorNamespaceName("default");
    const privateNamespaceName = queryPrivateNamespace
      ? vectorNamespaceName("private", ledgerAuthority, userId)
      : undefined;
    const managedNamespaceName = queryManagedNamespace
      ? vectorNamespaceName("managed", ledgerAuthority)
      : undefined;
    const fmpNamespaceName = queryFmpNamespace
      ? vectorNamespaceName("fmp-transcripts", ledgerAuthority)
      : undefined;

    // Episodic cross-symbol mode (matchAllSymbols): omit the symbol clause entirely so decision
    // analogs on OTHER tickers stay retrievable. Default (unset) keeps the per-symbol restriction.
    const symbolFilter: Record<string, unknown> = options?.matchAllSymbols ? {} : { symbol: { $eq: symbol } };

    // The legacy local sentinel is only a shared fallback when scope is absent. A bare
    // `userId=local` alternative would also select historical operator decision memory that was
    // accidentally stamped private content as shared-user data.
    const sharedTierFilter = withCommittedVectorFilter(mergeAsOfEpoch({
      ...symbolFilter,
      ...extraFilter,
      $or: [
        { scope: { $eq: SHARED_SCOPE } },
        {
          $and: [
            { userId: { $eq: "local" } },
            { scope: { $exists: false } }
          ]
        }
      ]
    }, asOfEpochFilter));

    // Keep provider-vs-eligible counts alongside each in-memory pool without exposing internal
    // bookkeeping to Pinecone/Voyage or changing the array contract used by the ranking pipeline.
    const candidatePoolObservability = new WeakMap<any[], CandidatePoolObservability>();

    // Embed ONE query string (via the shared query-embed cache) and run its Pinecone match(es),
    // returning `null` on a malformed embedding (already audited/logged by the caller of `null`).
    // Factored out of the single-query path unchanged so `queries?.length` absent/empty is
    // byte-for-byte identical to pre-multi-query behavior (one embed, one match round-trip).
    const embedAndMatchOneQuery = async (q: string): Promise<any[] | null> => {
      const activeModel = activeEmbeddingModel(userId);
      const endCacheLookup = stageTrace?.start("query_embed_cache", {
        provider: activeEmbeddingProvider(userId),
        model: activeModel
      });
      let embedding = getCachedQueryEmbedding(activeModel, q);
      endCacheLookup?.({ cacheHit: embedding != null });
      if (embedding == null) {
        // Provider-generic health/alert lane (2026-07-19) + stage telemetry from #1892.
        const embedProvider = activeEmbeddingProvider(userId);
        const endEmbed = stageTrace?.start("query_embed_api", {
          provider: embedProvider,
          model: activeModel,
          candidatesIn: 1
        });
        let response: any;
        try {
          response = await withRagApiHealth(
            "voyage",
            voyageSource,
            userId,
            "embed query",
            () => embedWithRetry(voyage, [q], "query", undefined, voyageSource, userId),
            undefined,
            { durablyTrackedInside: true },
            { lane: "rag-embed", provider: embedProvider }
          );
          endEmbed?.({ candidatesOut: response.data?.[0]?.embedding ? 1 : 0 });
        } catch (error) {
          endEmbed?.({ error });
          // Soft-degrade this query only. Multi-query already isolates per variant; the
          // single-query caller treats null as lookup_failed and Green/Red skip RAG.
          recordEmbedFailure(activeEmbeddingProvider(userId), "query-embed-failed");
          logWarn("embed.failed", {
            provider: activeEmbeddingProvider(userId),
            error_type: "query-embed-failed"
          });
          return null;
        }
        meterEmbed([q], activeModel, userId, embedProvider); // count only on a cache MISS; book under the requesting userId
        recordRagOperation(Date.now(), userId); // R16: count this embed call against the per-run budget (no-op unless enabled).
        embedding = response.data?.[0]?.embedding;
      }
      // R2 integrity guard applies to the query embedding too: a malformed vector (wrong dimension,
      // NaN) would return garbage matches rather than a clean empty result. Audit so a Voyage
      // model/config drift is observable instead of silently returning bad matches.
      if (!isValidEmbedding(embedding)) {
        if (embedding != null) {
          const dim = Array.isArray(embedding as unknown) ? (embedding as unknown[]).length : "n/a";
          audit("vector_embedding_integrity", { rejected: 1, context: "query" }, userId);
          void captureRagSentryMessage("warning", "RAG query embedding integrity rejection", {
            provider: activeEmbeddingProvider(userId),
            operation: "embed query",
            source: voyageSource,
            rejected: 1,
            dimension: String(dim)
          });
        }
        return null;
      }
      // Only cache a validated (finite, correctly-shaped) embedding — never a malformed one.
      setCachedQueryEmbedding(activeModel, q, embedding);

      // server-asof-filter: the user-tier filter gets the SAME epoch clause as the shared tier.
      // The fail-open epoch clause itself carries an `$or`, so it must go through `mergeAsOfEpoch`
      // (which promotes to `$and`) rather than a spread — a bare spread would be fine here (no
      // pre-existing top-level `$or`), but routing both tiers through one helper keeps them identical.
      const privateVisibilityClauses: Record<string, unknown>[] = [
        { tenant_scope: { $eq: vectorTenantScope(userId, PRIVATE_SCOPE) } }
      ];
      if (isUnambiguousLegacyVectorUserId(userId)) {
        privateVisibilityClauses.push(
          {
            $and: [
              { tenant_scope: { $exists: false } },
              { scope: { $eq: PRIVATE_SCOPE } }
            ]
          },
          {
            $and: [
              { tenant_scope: { $exists: false } },
              { scope: { $exists: false } }
            ]
          }
        );
      }
      const userTierFilter = withCommittedVectorFilter(mergeAsOfEpoch({
        ...symbolFilter,
        userId: { $eq: vectorUserId },
        ...extraFilter,
        $or: privateVisibilityClauses
      }, asOfEpochFilter));

      const managedAuthorityClause = {
        ledger_authority: { $eq: ledgerAuthority },
        provider_authority: { $eq: stableProviderAuthority },
        receipt_required: { $eq: true },
        ingest_state: { $eq: "committed" }
      };
      const managedUserFilter = { $and: [userTierFilter, managedAuthorityClause] };
      const managedSharedFilter = { $and: [sharedTierFilter, managedAuthorityClause] };
      // Keep private and shared pools separate even for the local operator. A single union query
      // can fill topK entirely from one high-scoring tier and starve the other before reranking.
      // The dedicated private namespace is queried only when its durable manifest proves it exists
      // under the current physical provider authority.
      const endDenseQuery = stageTrace?.start("dense_query", {
        provider: readBackend,
        model: activeModel,
        candidatesIn: fetchK
      });
      // Per-tier dense query dispatcher: Pinecone (today's path, byte-identical) or the Qdrant
      // mirror per the runtime read-backend knob.  Qdrant errors — including a refused
      // (unimplemented) filter translation, which throws rather than silently widening the
      // filter — soft-fail that tier to an empty pool so the run continues; they are NEVER
      // routed through withRagApiHealth("pinecone"), so they cannot trip the Pinecone WU
      // breaker, book phantom Pinecone read units, or page the Pinecone health lane.
      let qdrantTierAttempts = 0;
      const qdrantTierErrors: unknown[] = [];
      const denseTierQuery = (
        index: any,
        namespaceName: string,
        operation: string,
        filter: Record<string, unknown>
      ): Promise<{ matches: any[] }> => {
        if (readBackend === "qdrant") {
          qdrantTierAttempts += 1;
          return qdrantQueryTier(namespaceName, { vector: embedding as number[], topK: fetchK, filter }).catch(
            (error) => {
              qdrantTierErrors.push(error);
              console.warn(
                `[vector-db] Qdrant ${operation} failed; tier contributes no candidates:`,
                error instanceof Error ? error.message : String(error)
              );
              return { matches: [] };
            }
          );
        }
        if (!index) return Promise.resolve({ matches: [] });
        return withRagApiHealth("pinecone", pineconeSource, userId, operation, () =>
          withSentrySpan("pinecone.query", "db", () =>
            index.query({
              vector: embedding,
              topK: fetchK,
              filter,
              includeMetadata: true
            }),
            { "db.system": "pinecone", "db.operation": "query" }
          )
        ) as Promise<{ matches: any[] }>;
      };
      let denseResults: any[];
      try {
        denseResults = await Promise.all([
          denseTierQuery(defaultIndex, defaultNamespaceName, "query user tier", userTierFilter),
          privateNamespaceName && (readBackend === "qdrant" || privateIndex)
            ? denseTierQuery(privateIndex, privateNamespaceName, "query private namespace", userTierFilter)
            : Promise.resolve({ matches: [] }),
          denseTierQuery(defaultIndex, defaultNamespaceName, "query shared tier", sharedTierFilter),
          managedNamespaceName && (readBackend === "qdrant" || managedIndex)
            ? denseTierQuery(managedIndex, managedNamespaceName, "query managed user tier", managedUserFilter)
            : Promise.resolve({ matches: [] }),
          managedNamespaceName && (readBackend === "qdrant" || managedIndex)
            ? denseTierQuery(managedIndex, managedNamespaceName, "query managed shared tier", managedSharedFilter)
            : Promise.resolve({ matches: [] }),
          fmpNamespaceName && (readBackend === "qdrant" || fmpIndex)
            ? denseTierQuery(fmpIndex, fmpNamespaceName, "query FMP transcript tier", managedSharedFilter)
            : Promise.resolve({ matches: [] })
        ]);
        // Total-outage escalation (review fix): per-tier fail-open is for PARTIAL degradation.
        // When EVERY queried Qdrant tier failed (endpoint down, refused translation on a shared
        // filter shape), rethrow so the pass reports lookup_failed — exactly what a Pinecone
        // outage does — instead of a "successful" empty retrieval that Green/Red would misread
        // as "no relevant evidence exists".
        if (readBackend === "qdrant" && qdrantTierAttempts > 0 && qdrantTierErrors.length >= qdrantTierAttempts) {
          throw qdrantTierErrors[0];
        }
        endDenseQuery?.({
          candidatesOut: denseResults.reduce((total, result) => total + (result.matches?.length ?? 0), 0)
        });
      } catch (error) {
        endDenseQuery?.({ error });
        throw error;
      }
      const [userResults, privateResults, localResults, managedUserResults, managedLocalResults, fmpResults] = denseResults;
      const denseMatchCount =
        (userResults.matches?.length ?? 0) +
        (privateResults.matches?.length ?? 0) +
        (localResults.matches?.length ?? 0) +
        (managedUserResults.matches?.length ?? 0) +
        (managedLocalResults.matches?.length ?? 0) +
        (fmpResults.matches?.length ?? 0);
      if (readBackend === "qdrant") {
        // Self-hosted reads: provider "qdrant", zero read units — never book phantom Pinecone WUs
        // for queries Pinecone did not serve.
        meterQdrantQuery(userId, denseMatchCount);
      } else {
        meterPineconeQuery(
          pineconeReadUnits(userResults, 1) +
            pineconeReadUnits(privateResults, privateIndex ? 1 : 0) +
            pineconeReadUnits(localResults, 1) +
            pineconeReadUnits(managedUserResults, managedIndex ? 1 : 0) +
            pineconeReadUnits(managedLocalResults, managedIndex ? 1 : 0) +
            pineconeReadUnits(fmpResults, fmpIndex ? 1 : 0),
          userId,
          denseMatchCount
        );
      }

      const tiers = [
        userResults.matches || [],
        privateResults.matches || [],
        localResults.matches || [],
        managedUserResults.matches || [],
        managedLocalResults.matches || [],
        fmpResults.matches || []
      ];
      const providerCandidateCount = uniqueTierCandidateCount(tiers);
      const visibleTiers = tiers.map((tier) => filterMatchesForTenantVisibility(tier, userId));
      const visibleCandidateCount = uniqueTierCandidateCount(visibleTiers);

      // Mandatory eligibility must run before tier quotas. Otherwise high-scoring stale generations
      // can consume an entire tier's share of the 1,000-document rerank budget and then be dropped,
      // hiding lower-scoring current evidence that the provider already returned.
      const receiptEligibleMatches = filterMatchesForCommittedReceipts(visibleTiers.flat(), options?.asOf, {
        userId,
        providerAuthority,
        ...(ledgerAuthority ? { ledgerAuthority } : {})
      });
      const receiptEligibleReferences = new Set(receiptEligibleMatches);
      const receiptEligibleTiers = visibleTiers.map((tier) => (
        tier.filter((match) => receiptEligibleReferences.has(match))
      ));
      const receiptEligibleCount = uniqueTierCandidateCount(receiptEligibleTiers);
      const transcriptEligibleReferences = new Set(
        filterMatchesForTranscriptRights(receiptEligibleTiers.flat())
      );
      const eligibleTiers = receiptEligibleTiers.map((tier) => (
        tier.filter((match) => transcriptEligibleReferences.has(match))
      ));
      const tierByCandidateIdentity = new Map<any, number>();
      eligibleTiers.forEach((tier, tierIndex) => {
        tier.forEach((match) => {
          const identity = candidatePoolIdentity(match);
          if (!tierByCandidateIdentity.has(identity)) tierByCandidateIdentity.set(identity, tierIndex);
        });
      });

      // Every provider tier enforces its own topK. Preserve each non-empty eligible tier's quota
      // while keeping the combined rerank request within Voyage's documented 1,000-document ceiling.
      const eligiblePool = boundedTierCandidateUnion(
        eligibleTiers,
        wantRerank ? RERANK_MAX_DOCUMENTS : Number.MAX_SAFE_INTEGER
      );
      candidatePoolObservability.set(eligiblePool, {
        providerCandidateCount,
        visibleCandidateCount,
        receiptEligibleCount,
        receiptCrowdingDegraded: providerCandidateCount >= fetchK &&
          visibleCandidateCount > receiptEligibleCount &&
          receiptEligibleCount < limit,
        tierByCandidateIdentity
      });
      return eligiblePool;
    };

    // Additive multi-query fan-out (hyde-multiquery-retrieval, 2026-07-05): when the caller passes
    // `options.queries` (a non-empty array — set behind RAG_MULTIQUERY/RAG_HYDE in strategy.ts),
    // embed + match EACH query independently (INCLUDING the caller's original `query`, so its dense
    // recall is augmented rather than replaced — 2026-07-05 review fix), then RRF-fuse the per-query
    // ranked id lists into one candidate pool before the existing rankPool pipeline. Absent/empty
    // `queries` runs the exact single-query path unchanged (same one embed, one match round-trip).
    //
    // Fail-OPEN, never fail-closed (2026-07-05 review fix; query-embed isolate 2026-08-18):
    // `embedAndMatchOneQuery` now returns null on a dead embed (same contract as a malformed
    // vector). Each fan-out variant is also individually caught. If EVERY variant fails/fuses
    // to nothing, we fall back to the plain single-`query` path instead of returning `[]`.
    const fanOutQueries = (options?.queries ?? []).length > 0
      ? Array.from(new Set([query, ...(options!.queries as string[])]))
      : [];
    let matches: any[];
    if (fanOutQueries.length > 0) {
      const perQueryResults = await Promise.all(
        fanOutQueries.map(async (q) => {
          try {
            return await embedAndMatchOneQuery(q);
          } catch (err) {
            console.warn(`[vector-db] multi-query variant failed, dropping it from the fan-out:`, err instanceof Error ? err.message : String(err));
            return null;
          }
        })
      );
      const validResults = perQueryResults.filter((r): r is any[] => r != null && r.length > 0);
      if (validResults.length === 0) {
        // Every variant (including the original query, always included above) failed or matched
        // nothing — fall back to the plain single-query path rather than returning `[]`.
        const single = await embedAndMatchOneQuery(query);
        if (single == null) {
          reportRetrievalStatus(options, "lookup_failed", { userId, symbol });
          return finish([]);
        }
        matches = single;
      } else {
        // Synthetic ids for matches lacking a real Pinecone id are scoped per-list-index (list N /
        // position i) so a missing id in one query's pool can never collide with a missing id at the
        // same position in a DIFFERENT query's pool — each stays its own distinct, unfused candidate.
        const rankedIdLists: string[][] = validResults.map((matchList, listIdx) =>
          matchList.map((m: any, i: number) => (typeof m?.id === "string" && m.id.length > 0 ? m.id : `__idx_${listIdx}_${i}__`))
        );
        const tierByFusedId = new Map<string, number>();
        validResults.forEach((matchList, listIdx) => {
          const observation = candidatePoolObservability.get(matchList);
          matchList.forEach((match, matchIndex) => {
            const fusedId = rankedIdLists[listIdx]![matchIndex]!;
            const tierIndex = observation?.tierByCandidateIdentity.get(candidatePoolIdentity(match));
            if (tierIndex !== undefined && !tierByFusedId.has(fusedId)) {
              tierByFusedId.set(fusedId, tierIndex);
            }
          });
        });
        // First-occurrence-wins would let a LOWER cosine score for a chunk that appears in multiple
        // per-query pools silently win the fused entry (feeding a lower score into rankPool's
        // minScore floor for that chunk). Keep the occurrence with the HIGHER match.score instead.
        const idToMatch = new Map<string, any>();
        validResults.forEach((matchList, listIdx) => {
          matchList.forEach((m: any, i: number) => {
            const id = rankedIdLists[listIdx]![i]!;
            const existing = idToMatch.get(id);
            if (!existing || (Number(m?.score) || 0) > (Number(existing?.score) || 0)) {
              idToMatch.set(id, m);
            }
          });
        });
        const fusedIds = rrfFuse(rankedIdLists);
        const fusedMatches = fusedIds.map((id) => idToMatch.get(id)).filter((m): m is any => m !== undefined);
        if (wantRerank) {
          // Do not collapse a fair per-query tier union back to the single-query fetchK before
          // reranking. Preserve each candidate's provider tier through RRF, then apply one final
          // fair provider-contract cap while retaining RRF order for rerank fail-open behavior.
          const fusedTiers = Array.from({ length: 7 }, () => [] as any[]);
          const fusedRank = new Map<string | object, number>();
          fusedIds.forEach((id, rank) => {
            const match = idToMatch.get(id);
            if (!match) return;
            const tierIndex = tierByFusedId.get(id) ?? 6;
            while (fusedTiers.length <= tierIndex) fusedTiers.push([]);
            fusedTiers[tierIndex]!.push(match);
            fusedRank.set(candidatePoolIdentity(match), rank);
          });
          matches = boundedTierCandidateUnion(
            fusedTiers,
            RERANK_MAX_DOCUMENTS,
            (match) => -(fusedRank.get(candidatePoolIdentity(match)) ?? Number.MAX_SAFE_INTEGER)
          );
        } else {
          matches = fusedMatches.slice(0, fetchK);
        }
        const observations = perQueryResults
          .filter((result): result is any[] => result != null)
          .map((result) => candidatePoolObservability.get(result) ?? {
            providerCandidateCount: result.length,
            visibleCandidateCount: result.length,
            receiptEligibleCount: result.length,
            receiptCrowdingDegraded: false,
            tierByCandidateIdentity: new Map<any, number>()
          });
        const finalTierByCandidateIdentity = new Map<any, number>();
        for (const [fusedId, tierIndex] of tierByFusedId) {
          const match = idToMatch.get(fusedId);
          if (match) finalTierByCandidateIdentity.set(candidatePoolIdentity(match), tierIndex);
        }
        candidatePoolObservability.set(matches, {
          providerCandidateCount: Math.max(...observations.map((item) => item.providerCandidateCount)),
          visibleCandidateCount: Math.max(...observations.map((item) => item.visibleCandidateCount)),
          receiptEligibleCount: Math.max(...observations.map((item) => item.receiptEligibleCount)),
          receiptCrowdingDegraded: observations.some((item) => item.receiptCrowdingDegraded),
          tierByCandidateIdentity: finalTierByCandidateIdentity
        });
      }
    } else {
      const single = await embedAndMatchOneQuery(query);
      if (single == null) {
        reportRetrievalStatus(options, "lookup_failed", { userId, symbol });
        return finish([]);
      }
      matches = single;
    }

    const poolObservation = candidatePoolObservability.get(matches);
    const providerCandidateCount = poolObservation?.providerCandidateCount ?? matches.length;

    // Broad coach/chat retrieval has no docType filter. Enforce tenant visibility and transcript
    // rights before any candidate-pool persistence, reranking, or prompt injection.
    matches = filterMatchesForTenantVisibility(matches, userId);
    const visibleCandidateCount = poolObservation?.visibleCandidateCount ?? matches.length;
    const beforeReceiptCount = visibleCandidateCount;
    matches = filterMatchesForCommittedReceipts(matches, options?.asOf, {
      userId,
      providerAuthority,
      ...(ledgerAuthority ? { ledgerAuthority } : {})
    });
    const receiptEligibleCount = poolObservation?.receiptEligibleCount ?? matches.length;
    const managedVersionCrowdingDegraded = (
      managedTopKCapHit ||
      poolObservation?.receiptCrowdingDegraded === true ||
      (providerCandidateCount >= fetchK &&
        beforeReceiptCount > receiptEligibleCount &&
        receiptEligibleCount < limit)
    );
    if (managedVersionCrowdingDegraded) {
      audit("managed_version_crowding", {
        symbol,
        asOf: options?.asOf ?? null,
        baseFetchK,
        fetchK,
        cap: managedTopKCap,
        capHit: managedTopKCapHit,
        rejectedVersionUpperBound,
        providerCandidateCount,
        visibleCandidateCount,
        receiptRejectedCount: beforeReceiptCount - receiptEligibleCount,
        receiptEligibleCount
      }, userId);
    }

    // Independently recall exact terms from the persisted filing FTS index, then RRF-union them
    // with dense recall. This is the actual recall expansion: unlike the legacy HYBRID_RETRIEVAL
    // pass, it can surface a filing occurrence that Pinecone did not return at all. The flag is
    // default-off until the production eval gate promotes it.
    let usedCorpusWideLexical = false;
    // When the enabled FTS stage throws, fall back to dense but mark the run degraded so
    // empty final results are not mis-labeled `no_memory` (failed stage vs clean empty corpus).
    let corpusWideLexicalFailed = false;
    if (wantCorpusWideLexical) {
      const endLexical = stageTrace?.start("lexical_query", {
        provider: "sqlite-fts5",
        candidatesIn: Math.min(baseFetchK, 100)
      });
      let lexicalCandidates: CorpusWideLexicalCandidate[] = [];
      try {
        lexicalCandidates = searchCorpusWideLexicalCandidates({
          symbol,
          query,
          limit: Math.min(baseFetchK, 100),
          visibleTenantScopes: [
            vectorTenantScope(userId, SHARED_SCOPE),
            vectorTenantScope(userId, PRIVATE_SCOPE)
          ],
          ...(options?.docType?.length ? { docTypes: options.docType } : {}),
          ...(options?.source ? { source: options.source } : {}),
          ...(options?.section ? { section: options.section } : {}),
          strictUndated: strictAsOf,
          ...(options?.asOf ? { asOf: options.asOf } : {})
        }).filter((candidate) => lexicalCandidateMatchesOptions(candidate, options));
        endLexical?.({ candidatesOut: lexicalCandidates.length });
      } catch (error) {
        corpusWideLexicalFailed = true;
        endLexical?.({ error, candidatesOut: 0 });
        console.warn("[vector-db] corpus-wide lexical recall failed; retaining dense recall:", error instanceof Error ? error.message : String(error));
      }

      if (lexicalCandidates.length > 0) {
        const endFusion = stageTrace?.start("fusion", {
          route: "rrf:dense+sqlite-fts5",
          candidatesIn: matches.length + lexicalCandidates.length
        });
        const fusion = fuseDenseAndLexicalRecall(
          matches,
          lexicalCandidates,
          wantRerank ? RERANK_MAX_DOCUMENTS : fetchK
        );
        matches = fusion.matches;
        usedCorpusWideLexical = true;
        endFusion?.({
          candidatesOut: matches.length,
          dropped: fusion.denseCandidates + fusion.lexicalCandidates - matches.length
        });
      }
    }

    // Lexical candidates originate outside Pinecone's metadata filter, so reapply the same
    // ownership boundary after fusion. The SQL adapter also restricts tenant scopes and excludes
    // transcript sources; this post-fusion guard is defense in depth before rerank/prompt use.
    matches = filterMatchesForTenantVisibility(matches, userId);

    // Broad coach/chat retrieval has no docType filter. Enforce transcript rights before any
    // candidate-pool persistence, reranking, or prompt injection while preserving legacy matches
    // whose metadata predates doc_type.
    matches = filterMatchesForTranscriptRights(matches);

    // R12 (2026-07-01 RAG backlog): apply the default cosine floor for a caller that opted in via
    // `applyDefaultFloors`/RAG_APPLY_DEFAULT_FLOORS AND did not explicitly set `minScore`. Both
    // existing callers (strategy.ts, orchestrator.ts) already pass `minScore` explicitly, so
    // `options?.minScore == null` is false for them — this resolves to their explicit value,
    // unchanged, regardless of `applyDefaultFloors`.
    const wantDefaultFloors = Boolean(options?.applyDefaultFloors) || envFlagOn("RAG_APPLY_DEFAULT_FLOORS", true);
    const effectiveMinScore = options?.minScore ?? (wantDefaultFloors ? defaultMinScore() : undefined);

    // persist-pool-v2 (2026-07-06): the flag check happens BEFORE any work (no hook is even
    // constructed when off), mirroring v1's "no-op, not a suppressed write" posture — off means
    // `rankPool` gets no `onDispositions` at all, so it runs its exact pre-v2 pure-function path.
    const wantFullPool = candidatePoolFullPersistEnabled();
    let capturedDispositions: Map<string, CandidateDisposition> | undefined;

    // Review fix (2026-07-06): id-less rerank-survivor mislabel. `rerankMatches` returns a NEW
    // spread object `{ ...match, _rerankScore }` for every candidate Voyage assigns a numeric
    // relevanceScore to — including id-less ones — so an id-less match that SURVIVES rerank loses
    // its original object identity. The v2 capture block below used to key id-less matches purely
    // by identity (`finalSliceIdentitySet`/`rerankScoreByIdentity` built against the ORIGINAL
    // `matches` array), so a surviving-but-rerank-copied id-less match was invisible to both sets
    // and got mislabeled `dropped_rerank_truncate` with no relevanceScore. Fix: stamp a stable,
    // own-enumerable `__poolKey` string onto every id-less match BEFORE rankPool/rerank runs — a
    // plain spread (`{ ...match, ... }`) always copies own enumerable properties, so this key
    // survives rerank's copy intact and lets every downstream lookup key off `m.id || m.__poolKey`
    // instead of raw object identity. Only stamped when `wantFullPool` (v2 is the only consumer),
    // so retrieval is a true no-op — no extra property, no extra work — when the flag is off.
    if (wantFullPool) {
      matches.forEach((m, i) => {
        if (m != null && typeof m === "object" && !(typeof m.id === "string" && m.id.length > 0)) {
          Object.defineProperty(m, "__poolKey", { value: `__cand_${i}__`, enumerable: true, configurable: true, writable: true });
        }
      });
    }

    // Pipeline: cosine recall → score floor → point-in-time guard → hybrid fuse → cross-encoder
    // rerank → post-rerank floor → top-limit. Factored into the pure `rankPool` helper (R4,
    // 2026-07-01 expert-review follow-up) so a network-free regression test can drive the exact
    // same post-recall logic this call site uses, instead of re-implementing it in test code.
    const rerankPlan = planRerank({
      query,
      limit,
      availableCandidates: matches.length,
      enabled: wantRerank,
      adaptiveEnabled: useAdaptiveRerank
    });
    // Before adaptive depth existed, multi-query reranked its full fair union. Preserve that
    // default-off contract, and apply the same rule to the new independent lexical expansion so
    // a candidate recalled specifically to close a dense gap is not truncated before reranking.
    const rerankCandidateLimit = rerankPlan.shouldRerank && !useAdaptiveRerank &&
      (fanOutQueries.length > 0 || usedCorpusWideLexical)
      ? Math.min(matches.length, RERANK_MAX_DOCUMENTS)
      : rerankPlan.candidateLimit;
    const ordered = await rankPool(matches, query, limit, {
      minScore: effectiveMinScore,
      asOf: options?.asOf,
      minRelevanceScore: options?.minRelevanceScore,
      hybrid: wantHybrid && !usedCorpusWideLexical,
      rerank: rerankPlan.shouldRerank ? (q, m, k) => rerankMatches(voyage, q, m, k, userId, voyageSource) : undefined,
      rerankCandidateLimit,
      strictAsOf,
      dedupeSimilarity: options?.dedupeSimilarity,
      userId,
      trace: stageTrace,
      onDispositions: wantFullPool ? (d) => { capturedDispositions = d; } : undefined
    });
    const finalSlice = ordered.slice(0, limit);
    // persist-candidate-pool (2026-07-06): capture the FULL post-recall/post-dedupe candidate pool
    // (every candidate that survived floor/asOf/hybrid/rerank/dedupe — including ones NOT making
    // this final top-`limit` slice), so "what did we retrieve but not inject" is analyzable later.
    // The flag check is the FIRST thing this block does, before any mapping/hashing, so this is a
    // true no-op (not just a suppressed write) when RAG_PERSIST_CANDIDATE_POOL is off — default
    // retrieval is byte-for-byte unchanged. Runs for both the single-query and the #822 fused
    // multi-query path alike, since `ordered` is already the one fused pool by this point.
    //
    // HONESTY NOTE (2026-07-06 hardening pass): this captures rankPool's OUTPUT pool (`ordered`) —
    // i.e. post floor/asOf/hybrid/rerank/dedupe. Candidates dropped UPSTREAM of `ordered` by
    // minScore/asOf/dedupe are NOT here; this only ever answers "of what survived the full quality
    // pipeline, what got cut by the final top-N slice". With the FLAGSHIP production caller
    // (strategy.ts's filings retrieval pass, ~line 719-731 — dedupeSimilarity=defaultDedupeSimilarity()
    // = 0.6 non-null, limit=3), both `dedupeSimilar` and `rerankMatches` already hard-cap their
    // output at `limit`, so in that default config `ordered.length <= limit` — `finalSlice ===
    // ordered` and every persisted row is `used:true`. The interesting minScore/asOf/dedupe drops
    // are simply invisible to this feature in exactly the path it's meant to illuminate; `used:false`
    // rows are rare/absent there. A v2 that instead captures the PRE-rankPool `matches` pool with a
    // per-stage drop reason (minScore / asOf / dedupe / final-slice) is the real follow-up if "why
    // did we drop this candidate" is the actual goal — see docs/rollouts/2026-07-06-persist-candidate-pool.md.
    // Review fix (2026-07-06): capture-never-breaks-retrieval guard. This whole block runs BEFORE
    // the `return finalChunks` below, and was previously protected only by `retrieveContextDetailed`'s
    // OUTER catch — which returns `[]`. That means a throw ANYWHERE in this observability capture
    // (mapping, hashing, the id-less key computation, etc.) would silently turn a SUCCESSFUL
    // retrieval into an empty result, which is exactly backwards for an advisory-only feature. Wrap
    // the whole block in its own try/catch that swallows any throw so retrieval proceeds normally
    // regardless — `recordCandidatePool` itself already has an internal try/catch around the
    // `audit()` call, but this defends the mapping/key-computation code ABOVE that call too.
    try {
      if (candidatePoolPersistEnabled()) {
        // Id-less collision hardening (2026-07-06 hardening pass): a Pinecone match without a real
        // `id` would otherwise key on the literal empty string `""`, so multiple id-less matches in
        // `ordered` would collapse onto the same `finalIds` membership test and a non-sliced id-less
        // candidate could be mislabeled `used:true` just because SOME id-less candidate happened to
        // land in `finalSlice`. Mirror the #822 fan-out fusion code's guard above (`rankedIdLists`):
        // when a match's id is empty, use a per-position synthetic key instead, scoped to `ordered`'s
        // own indices so it won't collide with another id-less candidate. (Pinecone ids are arbitrary
        // strings, so a real id shaped like `__cand_${i}__` is not impossible — just vanishingly
        // unlikely; this guard disambiguates id-less matches, it is not a hard uniqueness proof.)
        const orderedKeys = ordered.map((m, i) => (typeof m?.id === "string" && m.id.length > 0 ? m.id : `__cand_${i}__`));
        const finalSliceKeySet = new Set(orderedKeys.slice(0, finalSlice.length));
        recordCandidatePool(
          {
            runId: options?.runId,
            symbol,
            queryHash: hashQuery(query),
            asOf: options?.asOf,
            candidates: ordered.map((m, i) => {
              const md = (m?.metadata ?? {}) as Record<string, unknown>;
              const asOfStamp = md.acceptance_datetime ?? md.as_of ?? md.timestamp;
              const rerankScore = (m as { _rerankScore?: unknown } | undefined)?._rerankScore;
              const key = orderedKeys[i]!;
              const id = String(m?.id ?? "");
              return {
                id,
                score: typeof m?.score === "number" ? m.score : undefined,
                ...(typeof rerankScore === "number" ? { relevanceScore: rerankScore } : {}),
                ...(typeof md.doc_type === "string" ? { docType: md.doc_type } : {}),
                ...(asOfStamp != null ? { asOf: String(asOfStamp) } : {}),
                used: finalSliceKeySet.has(key)
              };
            })
          },
          userId
        );
      }
    } catch (captureErr) {
      // Advisory capture only — never let a throw here affect retrieval. Best-effort log, never
      // re-thrown.
      console.warn("[vector-db] candidate-pool v1 capture failed (ignored, retrieval unaffected):", captureErr instanceof Error ? captureErr.message : String(captureErr));
    }

    // persist-pool-v2 (2026-07-06): capture the PRE-`rankPool` `matches` pool (raw Pinecone
    // recall, or the #822 fused pool when multi-query fan-out ran — either way, ONE record for the
    // whole call, matching v1's "one record per retrieveContextDetailed call" contract) together
    // with the per-candidate DISPOSITION `rankPool` computed via `onDispositions` above. This is
    // what actually answers "why did we drop this candidate": v1 only ever sees `ordered` (post
    // floor/asOf/hybrid/rerank/dedupe), so a minScore/asOf/dedupe/rerank-truncate drop is invisible
    // to it; here every candidate in `matches` gets exactly one disposition, including the ones v1
    // can never show. Flag-gated by a DISTINCT flag (RAG_PERSIST_CANDIDATE_POOL_FULL, checked via
    // `wantFullPool` above BEFORE `rankPool` even runs) so v1/v2 toggle independently; `wantFullPool`
    // false means `capturedDispositions` stays undefined and this block is a pure no-op.
    // Review fix (2026-07-06): capture-never-breaks-retrieval guard, same posture as the v1 block
    // above (defense in depth — both blocks run before `return finalChunks` and were previously
    // protected only by the function's OUTER catch, which returns `[]`; a throw anywhere in this
    // mapping/key-computation code must never turn a successful retrieval into an empty one).
    try {
      if (wantFullPool && capturedDispositions) {
        const dispositions = capturedDispositions;
        // Review fix (2026-07-06): key EVERY lookup below (final-slice membership AND relevanceScore
        // recovery) off `m.id || m.__poolKey` instead of splitting real-id-vs-object-identity. The
        // previous identity-based split was wrong for an id-less match that SURVIVES rerank: Voyage
        // assigns it a numeric relevanceScore, so `rerankMatches` returns a NEW spread object
        // `{ ...match, _rerankScore }` for it — same as a real-id match — which is no longer `===`
        // its pre-rerank original. That made it invisible to both `finalSliceIdentitySet` and
        // `rerankScoreByIdentity` (built against the ORIGINAL matches array), so it was mislabeled
        // `dropped_rerank_truncate` with no relevanceScore even though it was actually `used`.
        // `__poolKey` is stamped onto every id-less match BEFORE rankPool/rerank runs (see above,
        // only when `wantFullPool`) as an own-enumerable string property, which a plain object spread
        // always copies — so it survives rerank's copy intact, giving every id-less match a stable
        // key exactly like a real Pinecone `id` would. Same key scheme `rankPool`'s own `resolveKey`
        // uses internally (`m.id` when non-empty, else a synthetic per-original-index key), so this
        // stays in the same key space `dispositions` was built in.
        const keyOf = (m: any): string =>
          typeof m?.id === "string" && m.id.length > 0
            ? m.id
            : typeof m?.__poolKey === "string" && m.__poolKey.length > 0
              ? m.__poolKey
              : "";
        const matchKeys = matches.map((m, i) => {
          const k = keyOf(m);
          return k.length > 0 ? k : `__cand_${i}__`;
        });
        // Final-slice membership: a `finalSlice` entry may be a rerank-produced spread copy (new
        // object reference, same `id`/`__poolKey` FIELD) — always compare by key, never by `===`.
        const finalSliceKeySet = new Set(finalSlice.map((m) => keyOf(m)).filter((k) => k.length > 0));
        // `rerankMatches` (when it ran) returns NEW spread objects carrying `_rerankScore` — the
        // ORIGINAL `matches` entry never has that field. Recover it from `ordered` (rankPool's
        // return value, which IS the post-rerank pool) keyed the same way, so a candidate that
        // survived to be reranked reports its real relevanceScore instead of silently omitting it.
        const rerankScoreByKey = new Map<string, number>();
        for (const m of ordered) {
          const s = (m as { _rerankScore?: unknown } | undefined)?._rerankScore;
          if (typeof s !== "number") continue;
          const k = keyOf(m);
          if (k.length > 0) rerankScoreByKey.set(k, s);
        }
        // `used` is a strictly finer-grained disposition than `kept_not_used`: rankPool can only ever
        // report a survivor as `kept_not_used` (it doesn't know the caller's final top-`limit`
        // slice) — upgrade the ones actually present in `finalSlice` here, mirroring v1's
        // `finalSliceKeySet` upgrade logic but against the PRE-rankPool `matches` pool.
        recordCandidatePoolFull(
          {
            runId: options?.runId,
            symbol,
            queryHash: hashQuery(query),
            asOf: options?.asOf,
            candidates: matches.map((m, i) => {
              const md = (m?.metadata ?? {}) as Record<string, unknown>;
              const asOfStamp = md.acceptance_datetime ?? md.as_of ?? md.timestamp;
              const key = matchKeys[i]!;
              // Persisted `id` is ALWAYS the real Pinecone id (or "" when absent) — `__poolKey` is a
              // purely internal disambiguation key and must never leak into the persisted payload.
              const id = String(m?.id ?? "");
              const inFinalSlice = finalSliceKeySet.has(key);
              const rerankScore = rerankScoreByKey.get(key);
              const stageDisposition = dispositions.get(key);
              const disposition: CandidateDisposition = stageDisposition === "kept_not_used" && inFinalSlice
                ? "used"
                : (stageDisposition ?? "kept_not_used");
              return {
                id,
                score: typeof m?.score === "number" ? m.score : undefined,
                ...(typeof rerankScore === "number" ? { relevanceScore: rerankScore } : {}),
                ...(typeof md.doc_type === "string" ? { docType: md.doc_type } : {}),
                ...(asOfStamp != null ? { asOf: String(asOfStamp) } : {}),
                disposition
              };
            })
          },
          userId
        );
      }
    } catch (captureErr) {
      // Advisory capture only — never let a throw here affect retrieval. Best-effort log, never
      // re-thrown.
      console.warn("[vector-db] candidate-pool v2 capture failed (ignored, retrieval unaffected):", captureErr instanceof Error ? captureErr.message : String(captureErr));
    }
    const endFinalInjection = stageTrace?.start("final_injection", { candidatesIn: finalSlice.length });
    // Child chunks are selected/reranked first. The default retains the legacy one-chunk parent
    // substitution exactly; the opt-in path maps raw child text, then attaches each surviving
    // parent once under deterministic per-parent/global caps. It never feeds parent text into
    // recall/rerank or creates another candidate.
    const wantParentContextExpansion = parentContextExpansionEnabled();
    const mappedFinalChunks = finalSlice
      .map((match) => matchToChunkWithOptions(match, { includeParentText: !wantParentContextExpansion }))
      .filter((c) => c.text);
    const finalChunks = wantParentContextExpansion
      ? expandPostRerankParentContext(mappedFinalChunks, {
          enabled: true,
          asOf: options?.asOf,
          strictAsOf,
          maxParentChars: parentContextMaxChars(),
          maxTotalParentChars: parentContextMaxTotalChars()
        }).chunks
      : mappedFinalChunks;
    endFinalInjection?.({ candidatesOut: finalChunks.length, dropped: finalSlice.length - finalChunks.length });
    // Final status classification (receipt only — never changes `finalChunks`): a real zero-match
    // result is "no_memory" (pipeline ran cleanly, nothing relevant found); a non-empty result under
    // quality-path degrade (R16 budget, version crowding, authority mismatch, or explicit rerank
    // route unavailable with candidates that could have been reordered) is "degraded"; else "ok".
    //
    // Rerank unavailability must NOT mask a clean empty lookup: dense/lexical already succeeded with
    // zero matches, so there is nothing to rerank — report `no_memory` rather than `degraded`.
    const qualityDegraded =
      managedVersionCrowdingDegraded ||
      managedAuthorityDegraded ||
      budgetDegraded ||
      corpusWideLexicalFailed ||
      (rerankUnavailable && finalChunks.length > 0);
    reportRetrievalStatus(
      options,
      qualityDegraded
        ? "degraded"
        : finalChunks.length === 0
          ? "no_memory"
          : "ok"
    );
    return finish(finalChunks);
  } catch (err) {
    console.error("[vector-db] Error retrieving context:", err);
    if (!wasRagSentryCaptured(err)) {
      await captureRagSentryMessage("error", "RAG retrieval failed", {
        provider: "pinecone",
        operation: "retrieveContext",
        source: userId === "local" ? "operator" : "user",
        symbol,
        reason: err instanceof Error ? err.message : String(err)
      });
    }
    reportRetrievalStatus(options, "lookup_failed", { userId, symbol });
    return finish([]);
  }
}

/**
 * Thin convenience wrapper (typed-retrieval-status, 2026-07-06) for callers that want the typed
 * status alongside the chunks without wiring their own `onStatus` callback. Purely additive — does
 * not change `retrieveContextDetailed` itself, and a caller-supplied `options.onStatus` (if any)
 * still fires exactly as it would calling `retrieveContextDetailed` directly.
 */
export async function retrieveContextDetailedWithStatus(
  query: string,
  symbol: string,
  limit: number = 3,
  userId: string = "local",
  options?: RetrieveOptions
): Promise<{ chunks: RetrievedChunk[]; status: RetrievalStatus }> {
  let status: RetrievalStatus = "ok";
  const chunks = await retrieveContextDetailed(query, symbol, limit, userId, {
    ...options,
    onStatus: (s) => {
      status = s;
      // Forward to the caller-supplied callback best-effort — a throwing callback must never
      // break retrieval. This mirrors the same guarantee `reportRetrievalStatus` already gives
      // internally; guarded explicitly here too since this closure is itself what gets invoked
      // through that internal call chain, and a receipt callback must never propagate a throw.
      try {
        options?.onStatus?.(s);
      } catch {
        // advisory receipt only — never let a callback failure affect retrieval
      }
    }
  });
  return { chunks, status };
}

/** Injectable rerank function shape `rankPool` accepts — matches `rerankMatches`'s signature minus the `voyage` client. */
export type RankPoolRerankFn = (query: string, matches: any[], topK: number) => Promise<any[]>;

export interface RankPoolOptions {
  /** Drop matches whose cosine score is below this (0–1). Applied first, before any reordering. */
  minScore?: number;
  /** Point-in-time guard: drop chunks whose resolved date stamp is after this ISO date. */
  asOf?: string;
  /** Post-rerank relevance floor (0–1), applied after rerank/hybrid but before the final slice. */
  minRelevanceScore?: number;
  /** Whether hybrid BM25/RRF fusion should run (caller resolves the env flag). */
  hybrid?: boolean;
  /** Injectable reranker; omit (or pass undefined) to skip reranking entirely (matches `wantRerank=false`). */
  rerank?: RankPoolRerankFn;
  /** Maximum fused candidates sent to the reranker; omitted means the full pool. */
  rerankCandidateLimit?: number;
  /** R1 strict as-of mode (caller resolves `VECTOR_ASOF_STRICT`) — only has an effect when `asOf` is set. */
  strictAsOf?: boolean;
  /** userId for the strict-mode drop-count audit record; defaults to "local". */
  userId?: string;
  /** Optional text-free stage collector. */
  trace?: RetrievalStageTrace;
  /**
   * R14 (2026-07-01 RAG backlog): opt-in near-duplicate suppression, applied AFTER the
   * post-rerank relevance floor but BEFORE the final slice-to-limit. A 0-1 Jaccard-shingle
   * similarity threshold — a candidate >= this similar to an already-kept chunk is dropped and
   * back-filled from later candidates. Omitted (undefined) = current behavior, no dedup pass.
   */
  dedupeSimilarity?: number;
  /**
   * persist-pool-v2 (2026-07-06): OPTIONAL per-candidate disposition capture hook. When supplied,
   * `rankPool` tracks every input candidate through each filtering stage (minScore -> asOf ->
   * rerank-truncate -> post-rerank floor -> dedupe) and invokes this callback exactly once with a
   * `Map` from a stable per-candidate key (the match's real Pinecone `id`, or a synthetic
   * `__cand_<inputIndex>__` key when the id is empty/missing — same id-less collision hardening
   * `retrieveContextDetailed`'s v1 capture already uses) to its `CandidateDisposition`. Every
   * candidate present in the original `matches` input gets exactly one entry; candidates that
   * survive every stage are recorded as `kept_not_used` here (the caller, which alone knows the
   * final top-`limit` slice, upgrades the ones actually used to `used`).
   *
   * Omitted (the default for every existing call site): zero extra work — no map allocation, no
   * key computation, no extra pass over the pool. `rankPool` remains a pure function with
   * byte-identical behavior/return value whether or not this option existed.
   */
  onDispositions?: (dispositions: Map<string, CandidateDisposition>) => void;
}

/**
 * Pure(ish) post-recall ranking pipeline: score floor → point-in-time guard (lenient or strict) →
 * optional hybrid BM25 fusion → optional cross-encoder rerank → post-rerank relevance floor.
 * Does NOT slice to `limit` or map to `RetrievedChunk` — callers do that themselves (this keeps
 * the helper reusable for both the real retrieval call site and network-free regression tests
 * that want to inspect the still-Pinecone-shaped `match[]` output, e.g. `_rerankScore`).
 *
 * Side effects (both fire-and-forget, never throw, never block the returned pool):
 *  - a `vector_asof_strict_drop` audit when strict as-of mode actually drops an undated chunk.
 *  - an R5 `recordRetrievalQuality()` distribution-telemetry record, ONLY when
 *    RAG_RETRIEVAL_TELEMETRY is on (a complete no-op — no hashing, no audit call — when off).
 */
export async function rankPool(
  matches: any[],
  query: string,
  limit: number,
  options: RankPoolOptions = {}
): Promise<any[]> {
  const candidates = matches.length;

  // persist-pool-v2 (2026-07-06): disposition tracking is entirely opt-in via `onDispositions`.
  // When absent (every existing call site), none of this block's code runs — `trackDrop`/
  // `keyFor` are never called, no Map is allocated — so `rankPool` is byte-identical in behavior
  // and cost to its pre-v2 form. Keys mirror the id-less collision hardening the v1 capture site
  // in `retrieveContextDetailed` already uses: a match's real Pinecone `id` when non-empty,
  // else a synthetic `__cand_<originalInputIndex>__` key scoped to the ORIGINAL `matches` array
  // position (stable across every filtering stage, unlike a re-computed post-filter index).
  const wantDispositions = typeof options.onDispositions === "function";
  const keyFor = (match: any, originalIndex: number): string =>
    typeof match?.id === "string" && match.id.length > 0 ? match.id : `__cand_${originalIndex}__`;
  // Two lookup tables, both built once up front (only when a hook is supplied): object identity
  // -> key, for matches that still carry their ORIGINAL object reference (true through minScore/
  // asOf filtering and `fuseHybrid`'s reordering, which reuses the same objects — see
  // `fuseHybrid`'s `idToMatch.get(id)` returning `matches[i]` directly, never a copy); and real-id
  // -> key, for post-rerank objects whose `id` field survives the copy.
  //
  // Review fix (2026-07-06): an id-less match that SURVIVES rerank is also returned as a NEW
  // spread object (`rerankMatches` copies `{ ...matches[idx], _rerankScore }` for every candidate
  // Voyage assigns a numeric relevanceScore to, real-id or not) — so the identity map alone is
  // NOT sufficient for id-less rerank survivors; they lose their original identity same as a
  // real-id match would, but have no `id` field for the real-id map to recover them by either.
  // `retrieveContextDetailed` (the only caller that ever supplies `onDispositions`) stamps a
  // stable own-enumerable `__poolKey` onto every id-less match in `matches` BEFORE calling
  // `rankPool` — a plain spread always copies own enumerable props, so `__poolKey` survives
  // rerank's copy intact. A third lookup table recovers those by that stamped key.
  const keyByIdentity = new Map<any, string>();
  const keyByRealId = new Map<string, string>();
  const keyByPoolKey = new Map<string, string>();
  if (wantDispositions) {
    matches.forEach((m, i) => {
      const key = keyFor(m, i);
      keyByIdentity.set(m, key);
      if (typeof m?.id === "string" && m.id.length > 0) keyByRealId.set(m.id, key);
      else if (typeof m?.__poolKey === "string" && m.__poolKey.length > 0) keyByPoolKey.set(m.__poolKey, key);
    });
  }
  const resolveKey = (match: any): string => {
    const byIdentity = keyByIdentity.get(match);
    if (byIdentity) return byIdentity;
    const byId = typeof match?.id === "string" && match.id.length > 0 ? keyByRealId.get(match.id) : undefined;
    if (byId) return byId;
    const byPoolKey = typeof match?.__poolKey === "string" && match.__poolKey.length > 0 ? keyByPoolKey.get(match.__poolKey) : undefined;
    if (byPoolKey) return byPoolKey;
    // Should be unreachable for any candidate that originated in `matches`, but fail safe rather
    // than throw: fall back to the id itself (still stable/unique in practice) if somehow neither
    // lookup hits.
    return String(match?.id ?? "");
  };
  const dispositions = wantDispositions ? new Map<string, CandidateDisposition>() : undefined;
  const trackDrop = (match: any, disposition: CandidateDisposition) => {
    if (!dispositions) return;
    dispositions.set(resolveKey(match), disposition);
  };

  let pool = matches;
  let droppedByMinScore = 0;
  if (options.minScore != null) {
    const endScoreFloor = options.trace?.start("score_floor", { candidatesIn: pool.length });
    const before = pool.length;
    pool = pool.filter((match) => {
      // Independently-recalled lexical candidates carry score=0 by design because FTS BM25 and
      // cosine are incomparable. Never erase real recall by applying a dense-only floor to them.
      const kept = hasLexicalRecall(match) || (typeof match?.score === "number" ? match.score : 0) >= options.minScore!;
      if (!kept) trackDrop(match, "dropped_minscore");
      return kept;
    });
    droppedByMinScore = before - pool.length;
    endScoreFloor?.({ candidatesOut: pool.length, dropped: droppedByMinScore });
  }
  let droppedByAsOf = 0;
  if (options.asOf) {
    const endAsOf = options.trace?.start("asof_filter", { candidatesIn: pool.length });
    const strict = Boolean(options.strictAsOf);
    let droppedUndated = 0;
    const before = pool.length;
    pool = pool.filter((match) => {
      const md = match?.metadata as Record<string, unknown> | undefined;
      const kept = isWithinAsOf(md, options.asOf, strict);
      if (!kept) {
        if (strict && resolveAsOfStamp(md) == null) droppedUndated++;
        trackDrop(match, "dropped_asof");
      }
      return kept;
    });
    droppedByAsOf = before - pool.length;
    endAsOf?.({ candidatesOut: pool.length, dropped: droppedByAsOf });
    // R1 strict-mode drop-count (2026-07-01 expert-review follow-up): observability only, so the
    // ingest-dating gap ("how much of the corpus has no resolvable stamp") is visible to an
    // operator instead of silently shrinking results. Never throws; a logging failure must not
    // break retrieval.
    if (strict && droppedUndated > 0) {
      try {
        audit("vector_asof_strict_drop", { droppedUndated, asOf: options.asOf }, options.userId ?? "local");
      } catch {
        // best-effort telemetry only
      }
    }
  }
  // Hybrid BM25 fusion (flag-gated): reorder the candidate pool by RRF(dense, BM25) before
  // cross-encoder rerank. Falls back to dense order when off or on error. Does not change
  // overFetchK or the Pinecone query — purely a post-retrieval reordering step. Never drops.
  const endFusion = options.hybrid && pool.length > 1
    ? options.trace?.start("fusion", { route: "rrf:dense-pool-bm25", candidatesIn: pool.length })
    : undefined;
  const fusedPool = options.hybrid && pool.length > 1 ? fuseHybrid(query, pool) : pool;
  endFusion?.({ candidatesOut: fusedPool.length });
  const rerankRan = Boolean(options.rerank) && fusedPool.length > limit;
  const rerankPool = rerankRan && options.rerankCandidateLimit != null
    ? fusedPool.slice(0, Math.max(limit, options.rerankCandidateLimit))
    : fusedPool;
  const endRerank = rerankRan
    ? options.trace?.start("rerank", { candidatesIn: rerankPool.length })
    : undefined;
  let ordered: any[];
  try {
    ordered = rerankRan ? await options.rerank!(query, rerankPool, limit) : fusedPool;
    endRerank?.({ candidatesOut: ordered.length, dropped: rerankPool.length - ordered.length });
  } catch (error) {
    endRerank?.({ error });
    throw error;
  }
  if (wantDispositions && rerankRan) {
    // Voyage's rerank call is itself invoked with `topK: Math.min(limit, fusedPool.length)`
    // (see `rerankMatches`), so any candidate in `fusedPool` that did NOT come back in `ordered`
    // was truncated by that top-K cut, not by a relevance-floor comparison (the floor runs next,
    // against `ordered` only). Compare by `resolveKey` (not `===`) since `rerankMatches` returns
    // NEW spread objects for reordered items — see the identity/real-id lookup note above.
    const orderedKeys = new Set(ordered.map((m: any) => resolveKey(m)));
    for (const match of fusedPool) {
      if (!orderedKeys.has(resolveKey(match))) trackDrop(match, "dropped_rerank_truncate");
    }
  }
  // Post-rerank relevance floor (opt-in via minRelevanceScore), applied AFTER rerank but BEFORE the
  // final slice-to-limit — matches carrying no relevanceScore (rerank off/failed/didn't return one
  // for this item) are FAIL-OPEN kept, never treated as a 0: a transient Voyage 429 (which makes
  // rerankMatches fall back to cosine order with no scores) must not empty every result. The floor
  // can legitimately return fewer than `limit` chunks; callers (strategy.ts advisory context,
  // orchestrator.ts citations) already tolerate short lists. No-op unless set.
  const endRelevanceFloor = options.minRelevanceScore != null
    ? options.trace?.start("relevance_floor", { candidatesIn: ordered.length })
    : undefined;
  const floored = options.minRelevanceScore != null
    ? ordered.filter((match) => {
        const s = (match as { _rerankScore?: unknown } | undefined)?._rerankScore;
        const kept = typeof s !== "number" || s >= options.minRelevanceScore!;
        if (!kept) trackDrop(match, "dropped_rerank_floor");
        return kept;
      })
    : ordered;
  endRelevanceFloor?.({ candidatesOut: floored.length, dropped: ordered.length - floored.length });

  // R14 (2026-07-01 RAG backlog): opt-in near-duplicate suppression, applied AFTER the
  // post-rerank relevance floor but BEFORE the final slice-to-limit (callers `.slice(0, limit)`
  // the RETURNED pool, so dedup must have already narrowed it here to have any effect). No-op
  // unless `dedupeSimilarity` is set.
  //
  // Disposition review fix (2026-07-06): `dedupeSimilar` drops candidates for TWO distinct
  // reasons — a genuine near-duplicate judgment, and its OWN internal top-`limit` cap (see the
  // `CandidateDisposition` doc comment in rag/candidate-pool.ts). Only ask for the (otherwise-free)
  // `report` out-param when a disposition hook is actually attached, so every existing caller pays
  // zero extra cost.
  const endDedupe = options.dedupeSimilarity != null
    ? options.trace?.start("dedupe", { candidatesIn: floored.length })
    : undefined;
  const dedupeReport: DedupeSimilarReport | undefined = wantDispositions && options.dedupeSimilarity != null ? { genuineDuplicateIndices: [], neverReachedIndices: [] } : undefined;
  const deduped = options.dedupeSimilarity != null ? dedupeSimilar(floored, limit, options.dedupeSimilarity, dedupeReport) : floored;
  endDedupe?.({ candidatesOut: deduped.length, dropped: floored.length - deduped.length });
  if (wantDispositions && options.dedupeSimilarity != null && dedupeReport) {
    for (const idx of dedupeReport.genuineDuplicateIndices) {
      trackDrop(floored[idx]!, "dropped_dedupe");
    }
    for (const idx of dedupeReport.neverReachedIndices) {
      trackDrop(floored[idx]!, "dropped_dedupe_truncate");
    }
  }

  if (dispositions) {
    // Everything still in `deduped` survived every rankPool-internal filter. `rankPool` itself
    // doesn't know the final top-`limit` slice (the caller applies that), so record every
    // survivor as `kept_not_used` here — the caller's `onDispositions` handler upgrades the ones
    // actually in its final slice to `used`.
    for (const match of deduped) {
      dispositions.set(resolveKey(match), "kept_not_used");
    }
    options.onDispositions!(dispositions);
  }

  // R5 consolidated retrieval-quality telemetry (2026-07-01 RAG backlog): default OFF via
  // RAG_RETRIEVAL_TELEMETRY. The flag check happens BEFORE any work (hashing, score scanning) so
  // this is a true no-op — not just a suppressed write — when the flag is unset.
  if (retrievalTelemetryEnabled()) {
    const topMatch = deduped[0] as { score?: unknown; _rerankScore?: unknown } | undefined;
    const topCosine = typeof topMatch?.score === "number" ? topMatch.score : undefined;
    const topRelevanceScore = typeof topMatch?._rerankScore === "number" ? topMatch._rerankScore : undefined;
    recordRetrievalQuality(
      {
        queryHash: hashQuery(query),
        k: limit,
        candidates,
        droppedByMinScore,
        droppedByAsOf,
        hybrid: Boolean(options.hybrid),
        rerankAttempted: Boolean(options.rerank),
        rerankRan,
        topCosine,
        topRelevanceScore,
        finalCount: deduped.length
      },
      options.userId ?? "local"
    );
  }

  return deduped;
}

/** Back-compat string[] view (used by strategy.ts) — thin wrapper over retrieveContextDetailed. */
export async function retrieveContext(
  query: string,
  symbol: string,
  limit: number = 3,
  userId: string = "local",
  options?: RetrieveOptions
): Promise<string[]> {
  const chunks = await retrieveContextDetailed(query, symbol, limit, userId, options);
  return chunks.map((c) => c.text).filter(Boolean);
}

/**
 * Boot-time warmup to ensure Qdrant's cold-cache fault-in doesn't delay the first real user query.
 * Dispatched in the background at server start (instrumentation.ts) for the three globally-shared
 * namespaces (default, managed, fmp-transcripts). Private/per-user namespaces are not globally
 * warmed up. Fire-and-forget; failure is logged but doesn't crash the boot.
 */
export async function warmupQdrantHotTenants(): Promise<void> {
  const { qdrantConfigured, qdrantQueryTier, vectorReadBackend } = await import("./vector-store/qdrant-read");
  if (!qdrantConfigured() || vectorReadBackend() !== "qdrant") return;

  const namespaces = [
    vectorNamespaceName("default"),
    vectorNamespaceName("managed", managedVectorLedgerAuthority()),
    vectorNamespaceName("fmp-transcripts", managedVectorLedgerAuthority()),
  ];

  const dummyVector = new Array(EMBEDDING_DIMENSION).fill(0);

  await Promise.allSettled(
    namespaces.map(async (ns) => {
      try {
        await qdrantQueryTier(ns, {
          vector: dummyVector,
          topK: 1,
        });
      } catch (e) {
        logWarn(`Qdrant boot warmup failed for namespace "${ns}": ${e instanceof Error ? e.message : String(e)}`);
      }
    })
  );
}
