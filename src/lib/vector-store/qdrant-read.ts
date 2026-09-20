/**
 * STAGE-1 (READ PATH) Qdrant backend for RAG retrieval.
 *
 * When the runtime knob routes reads to Qdrant, each dense tier query in vector-db.ts hits the
 * self-hosted Qdrant collection (collection "socratic-trade", one point per copied Pinecone vector —
 * see scripts/qdrant/pinecone-to-qdrant-copy.py) instead of Pinecone.  Stage 2 writes, deletes, and
 * inventory live in qdrant-write.ts.
 *
 * Backend selection (checked fresh per retrieval pass, flippable without redeploy):
 *   1. Admin > Operations DB override for the catalogued boolean knob RAG_VECTOR_READ_QDRANT
 *   2. env RAG_VECTOR_READ_QDRANT (truthy/falsy, same parsing as every server knob)
 *   3. env RAG_VECTOR_READ_BACKEND ("qdrant" | "pinecone") — the string spelling of the same switch
 *   4. default: qdrant when QDRANT_URL is configured, else pinecone
 * Qdrant is additionally gated on QDRANT_URL being configured — a knob flipped on without the
 * endpoint stays on Pinecone (warned once) instead of turning every tier into an empty pool.
 *
 * Connection env (prod Infisical): QDRANT_URL, QDRANT_API_KEY.  Optional: QDRANT_COLLECTION
 * (default "socratic-trade"), QDRANT_QUERY_TIMEOUT_MS (default 15000).
 */

import { isAbortOrTimeoutError, isTransientNetworkError } from "../network-errors";
import { serverKnobOverride } from "../server-knobs";
import { recordRagUsage } from "../rag-metering";
import { ABSENT_FIELD_SENTINELS, qdrantTenantFilter } from "./pinecone-filter-to-qdrant";

/** Catalogued server-knob id (see SERVER_KNOBS_CATALOG in src/lib/server-knobs.ts). */
export const QDRANT_READ_KNOB_ID = "RAG_VECTOR_READ_QDRANT";

export type VectorReadBackend = "pinecone" | "qdrant";

const TRUTHY = new Set(["1", "true", "on", "yes"]);
const FALSY = new Set(["0", "false", "off", "no"]);

const DEFAULT_COLLECTION = "socratic-trade";
const DEFAULT_TIMEOUT_MS = 15_000;
const QDRANT_MAX_ATTEMPTS = 3;
const QDRANT_RETRY_BASE_MS = 300;

function isRetryableQdrantServerError(err: unknown): boolean {
  return err instanceof Error && /failed \(HTTP 5\d\d\)/.test(err.message);
}

export function qdrantConfigured(): boolean {
  const url = process.env.QDRANT_URL?.trim();
  if (!url) return false;
  // Remote / production Qdrant endpoints require an API key unless explicitly permitted anonymously
  if (
    !process.env.QDRANT_API_KEY?.trim() &&
    process.env.QDRANT_ALLOW_ANONYMOUS !== "true" &&
    process.env.NODE_ENV !== "test" &&
    !url.includes("127.0.0.1") &&
    !url.includes("localhost")
  ) {
    return false;
  }
  return true;
}

let warnedUnconfigured = false;

/**
 * Effective read backend for this retrieval pass.  Never throws — any resolution failure lands on
 * "pinecone" (today's behavior).
 */
export function vectorReadBackend(): VectorReadBackend {
  let enabled: boolean | undefined;
  try {
    const override = serverKnobOverride(QDRANT_READ_KNOB_ID);
    if (typeof override === "boolean") enabled = override;
  } catch {
    // fail open to env — same posture as every server-knob read
  }
  if (enabled === undefined) {
    const raw = process.env[QDRANT_READ_KNOB_ID]?.trim().toLowerCase();
    if (raw) {
      if (TRUTHY.has(raw)) enabled = true;
      else if (FALSY.has(raw)) enabled = false;
    }
  }
  if (enabled === undefined) {
    const backend = process.env.RAG_VECTOR_READ_BACKEND?.trim().toLowerCase();
    if (backend === "qdrant") enabled = true;
    else if (backend === "pinecone") enabled = false;
  }
  if (enabled === undefined) {
    enabled = true;
  }
  if (enabled !== true) return "pinecone";
  if (!qdrantConfigured()) {
    if (!warnedUnconfigured) {
      warnedUnconfigured = true;
      console.warn(
        "[qdrant-read] Qdrant read backend requested but QDRANT_URL is not set; reads stay on Pinecone."
      );
    }
    return "pinecone";
  }
  return "qdrant";
}

/**
 * Map the Pinecone namespace name a tier queries today to the `ns` tenant value the copy script
 * wrote.  The script stamped `payload.ns` verbatim from Pinecone's describe_index_stats namespace
 * keys, and on this index the default namespace is keyed as the EMPTY STRING — verified against
 * the live collection 2026-08-31 (5,490 points carry ns=""; zero carry ns="__default__", so the
 * script's "__default__" URL special-case never fired here).  Every named namespace maps to
 * itself.
 */
export function pineconeNamespaceToQdrantTenant(namespace: string | undefined | null): string {
  return namespace ?? "";
}

export interface QdrantTierQueryArgs {
  vector: number[];
  topK: number;
  /** Pinecone-style metadata filter — translated by pinecone-filter-to-qdrant. */
  filter?: Record<string, unknown>;
}

export interface QdrantTierMatch {
  /** The ORIGINAL Pinecone vector id (payload.pc_id) — occ:v3:* prefix checks and receipt matching key on it. */
  id: string;
  score: number;
  /** The Pinecone metadata (payload minus the copy-added pc_id / ns keys). */
  metadata: Record<string, unknown>;
}

export interface QdrantTierResult {
  matches: QdrantTierMatch[];
  /** Hits skipped because the payload carried no pc_id (should be zero for copied points). */
  skippedMissingPcId: number;
}

function qdrantCollection(): string {
  return process.env.QDRANT_COLLECTION?.trim() || DEFAULT_COLLECTION;
}

function qdrantTimeoutMs(): number {
  const n = Number(process.env.QDRANT_QUERY_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
}

/**
 * One dense tier query against Qdrant, equivalent to a Pinecone `index.query({vector, topK,
 * filter, includeMetadata: true})` against `namespace`.  POSTs /points/search (supported on the
 * deployed Qdrant v1.19.0) with rescoring over the int8-quantized index; no score_threshold — the
 * JS-side VECTOR_MIN_SCORE floor in rankPool stays authoritative.  Throws on any transport,
 * status, or filter-translation failure; the caller owns per-tier fail-open.
 */
export async function qdrantQueryTier(
  namespace: string | undefined,
  args: QdrantTierQueryArgs
): Promise<QdrantTierResult> {
  const baseUrl = process.env.QDRANT_URL?.trim();
  if (!baseUrl) throw new Error("QDRANT_URL is not configured");
  const ns = pineconeNamespaceToQdrantTenant(namespace);
  const body = {
    vector: args.vector,
    limit: args.topK,
    filter: qdrantTenantFilter(ns, args.filter),
    params: {
      hnsw_ef: 128,
      exact: false,
      quantization: { ignore: false, rescore: true, oversampling: 2.0 }
    },
    with_payload: true,
    with_vector: false
  };
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const apiKey = process.env.QDRANT_API_KEY?.trim();
  if (apiKey) headers["api-key"] = apiKey;
  const url = `${baseUrl.replace(/\/+$/, "")}/collections/${encodeURIComponent(qdrantCollection())}/points/search`;
  // Same bounded retry as qdrant-write qdrantRequest: a dead keep-alive / 5xx
  // against the self-hosted box used to surface as SOCRATIC-TRADE-1T
  // "RAG retrieval failed" with a hardcoded Pinecone provider tag (PD #116 leftover).
  let lastErr: unknown;
  let response: Response | undefined;
  for (let attempt = 0; attempt < QDRANT_MAX_ATTEMPTS; attempt++) {
    try {
      const next = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(qdrantTimeoutMs())
      });
      if (!next.ok) {
        const text = (await next.text().catch(() => "")).slice(0, 400);
        throw new Error(`Qdrant search failed (HTTP ${next.status}): ${text}`);
      }
      response = next;
      lastErr = undefined;
      break;
    } catch (err) {
      lastErr = err;
      const retryable =
        !isAbortOrTimeoutError(err) && (isTransientNetworkError(err) || isRetryableQdrantServerError(err));
      if (attempt + 1 < QDRANT_MAX_ATTEMPTS && retryable) {
        await new Promise((resolve) => setTimeout(resolve, QDRANT_RETRY_BASE_MS * 2 ** attempt));
        continue;
      }
      throw err;
    }
  }
  if (!response) throw lastErr ?? new Error("Qdrant search failed");
  const parsed = (await response.json()) as { result?: Array<{ id?: unknown; score?: unknown; payload?: unknown }> };
  const hits = Array.isArray(parsed?.result) ? parsed.result : [];
  const matches: QdrantTierMatch[] = [];
  let skippedMissingPcId = 0;
  for (const hit of hits) {
    const payload =
      hit?.payload && typeof hit.payload === "object" && !Array.isArray(hit.payload)
        ? (hit.payload as Record<string, unknown>)
        : undefined;
    const pcId = payload?.pc_id;
    if (typeof pcId !== "string" || pcId.length === 0) {
      skippedMissingPcId++;
      continue;
    }
    const metadata: Record<string, unknown> = { ...payload };
    delete metadata.pc_id;
    delete metadata.ns;
    // Strip the backfill's absent-field sentinels (scripts/qdrant/sentinel-backfill.py stamps
    // them ONLY onto points missing the field) so downstream metadata matches the Pinecone view,
    // where these fields are simply absent.  This is load-bearing, not cosmetic: the post-fetch
    // guards branch on ABSENCE — filterMatchesForTenantVisibility rejects any unrecognized
    // non-null tenant_scope, so a leaked "__absent__" would silently drop every backfilled
    // legacy/shared vector after the server-side filter correctly admitted it.
    // receipt_required is deliberately NOT stripped: real direct records carry an explicit
    // `false`, and every retrieval-path consumer checks `=== true`, so a stamped false already
    // behaves identically to the absent marker.
    for (const [field, sentinel] of Object.entries(ABSENT_FIELD_SENTINELS)) {
      if (field === "receipt_required") continue;
      if (metadata[field] === sentinel) delete metadata[field];
    }
    matches.push({ id: pcId, score: Number(hit.score ?? 0), metadata });
  }
  if (skippedMissingPcId > 0) {
    console.warn(
      `[qdrant-read] Skipped ${skippedMissingPcId} hit(s) missing pc_id (ns="${ns}", collection="${qdrantCollection()}").`
    );
  }
  return { matches, skippedMissingPcId };
}

/**
 * Retrieval-stage query telemetry for the Qdrant backend — the same rag_usage row shape the
 * Pinecone path writes via meterPineconeQuery, with provider "qdrant" and ZERO read units
 * (self-hosted; there is no metered spend, and phantom Pinecone WUs must never be recorded when
 * Pinecone served nothing).  Never throws (recordRagUsage is best-effort).
 */
export function meterQdrantQuery(userId?: string, recordCount?: number): void {
  recordRagUsage({
    userId,
    operation: "query",
    provider: "qdrant",
    tokensIn: 0,
    tokensOut: recordCount,
    batchCount: recordCount ?? 1
  });
}

let qdrantMetricChecked = false;

export function resetQdrantMetricCheckedForTests(): void {
  qdrantMetricChecked = false;
}

/**
 * Asserts that the Qdrant collection is configured with Cosine distance metric.
 * Distorted distance metrics skew VECTOR_MIN_SCORE and rerank relevance cutoffs.
 * Cached per-process; fail-soft.
 */
export async function assertQdrantCollectionMetric(): Promise<void> {
  if (qdrantMetricChecked) return;
  try {
    const { qdrantCollectionInfo } = await import("./qdrant-write");
    const info = await qdrantCollectionInfo();
    if (!info.exists) return;
    if (info.distance && info.distance.toLowerCase() !== "cosine") {
      console.warn(
        `[vector-db] Qdrant collection "${info.collection}" distance metric is "${info.distance}", expected "Cosine" — cosine-scale cutoffs (VECTOR_MIN_SCORE) may be distorted.`
      );
      try {
        const { audit } = await import("../db");
        audit(
          "vector_index_metric_mismatch",
          { provider: "qdrant", collection: info.collection, metric: info.distance, expectedMetric: "Cosine" },
          "local"
        );
      } catch {
        // best-effort audit
      }
    }
    qdrantMetricChecked = true;
  } catch (err) {
    console.warn("[qdrant-read] Could not verify collection metric:", err instanceof Error ? err.message : String(err));
  }
}

