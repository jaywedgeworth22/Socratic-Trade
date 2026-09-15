/**
 * STAGE-2 (WRITE / DELETE / INVENTORY) Qdrant backend for RAG ingest.
 *
 * Stage 1 already serves dense reads from the self-hosted collection "socratic-trade".  This
 * module owns upserts, deletes, payload patches, and metadata inventory so runtime default no
 * longer touches Pinecone (whose write units are exhausted and paging Alerts Center).
 *
 * Backend selection (checked fresh per write, flippable without redeploy):
 *   1. Admin > Operations DB override for the catalogued boolean knob RAG_VECTOR_WRITE_QDRANT
 *   2. env RAG_VECTOR_WRITE_QDRANT (truthy/falsy, same parsing as every server knob)
 *   3. env RAG_VECTOR_WRITE_BACKEND ("qdrant" | "pinecone")
 *   4. default: qdrant when QDRANT_URL is configured, else pinecone
 * Qdrant is additionally gated on qdrantConfigured() — a knob flipped on without the endpoint
 * stays on Pinecone (warned once) instead of turning every ingest into a hard failure.
 *
 * Point ids MUST match scripts/qdrant/pinecone-to-qdrant-copy.py: uuid5(NAMESPACE_URL,
 * "st:" + ns + ":" + pinecone_id).  Payload MUST keep pc_id (original Pinecone id) and ns
 * (tenant).  Stage 1 reader src/lib/vector-store/qdrant-read.ts keys on those fields.
 *
 * HARD BAN: do not point ST embeddings at the fleet bge-m3 endpoint.  This module stores
 * whatever vector the caller already embedded with the ST embed provider.
 */

import crypto from "crypto";
import { isAbortOrTimeoutError, isTransientNetworkError } from "../network-errors";
import { hasRagIngestPointsBudget, recordRagUsage } from "../rag-metering";
import { serverKnobOverride } from "../server-knobs";
import {
  qdrantTenantFilter,
  type QdrantFilter
} from "./pinecone-filter-to-qdrant";
import { pineconeNamespaceToQdrantTenant, qdrantConfigured } from "./qdrant-read";

/** Catalogued server-knob id (see SERVER_KNOBS_CATALOG in src/lib/server-knobs.ts). */
export const QDRANT_WRITE_KNOB_ID = "RAG_VECTOR_WRITE_QDRANT";

export type VectorWriteBackend = "pinecone" | "qdrant";

const TRUTHY = new Set(["1", "true", "on", "yes"]);
const FALSY = new Set(["0", "false", "off", "no"]);

const DEFAULT_COLLECTION = "socratic-trade";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_UPSERT_BATCH = 64;
const DEFAULT_SCROLL_LIMIT = 256;
const UUID_NAMESPACE_URL = Buffer.from("6ba7b8119dad11d180b400c04fd430c8", "hex");

export interface QdrantUpsertRecord {
  id: string;
  values?: number[];
  metadata?: Record<string, unknown>;
}

export interface QdrantInventoryRow {
  id: string;
  metadata: Record<string, unknown>;
}

export interface QdrantCollectionInfo {
  exists: boolean;
  collection: string;
  pointsCount?: number;
  dimension?: number;
  status?: string;
  distance?: string;
}

let warnedUnconfigured = false;

export function qdrantCollectionName(): string {
  return process.env.QDRANT_COLLECTION?.trim() || DEFAULT_COLLECTION;
}

function qdrantTimeoutMs(): number {
  const write = Number(process.env.QDRANT_WRITE_TIMEOUT_MS);
  if (Number.isFinite(write) && write > 0) return write;
  const query = Number(process.env.QDRANT_QUERY_TIMEOUT_MS);
  return Number.isFinite(query) && query > 0 ? query : DEFAULT_TIMEOUT_MS;
}

function qdrantBaseUrl(): string {
  const url = process.env.QDRANT_URL?.trim();
  if (!url) throw new Error("QDRANT_URL is not configured");
  return url.replace(/\/+$/, "");
}

function qdrantHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const apiKey = process.env.QDRANT_API_KEY?.trim();
  if (apiKey) headers["api-key"] = apiKey;
  return headers;
}

/**
 * Effective write backend for this ingest/delete/inventory pass.  Never throws — any
 * resolution failure lands on "pinecone" (today's behavior) so a broken knob cannot
 * take the only remaining write path down.
 */
export function vectorWriteBackend(): VectorWriteBackend {
  let enabled: boolean | undefined;
  let explicit = false;
  try {
    const override = serverKnobOverride(QDRANT_WRITE_KNOB_ID);
    if (typeof override === "boolean") {
      enabled = override;
      explicit = true;
    }
  } catch {
    // fail open to env — same posture as every server-knob read
  }
  if (enabled === undefined) {
    const raw = process.env[QDRANT_WRITE_KNOB_ID]?.trim().toLowerCase();
    if (raw) {
      if (TRUTHY.has(raw)) enabled = true;
      else if (FALSY.has(raw)) enabled = false;
      if (enabled !== undefined) explicit = true;
    }
  }
  if (enabled === undefined) {
    const backend = process.env.RAG_VECTOR_WRITE_BACKEND?.trim().toLowerCase();
    if (backend === "qdrant") enabled = true;
    else if (backend === "pinecone") enabled = false;
    if (enabled !== undefined) explicit = true;
  }
  if (enabled === undefined) {
    enabled = true;
  }
  if (enabled !== true) return "pinecone";
  if (!qdrantConfigured()) {
    // Default-on without QDRANT_URL is silent pinecone (local tests, boxes without Qdrant).
    // Warn only when an operator explicitly flipped the knob/env on without the endpoint.
    if (explicit && !warnedUnconfigured) {
      warnedUnconfigured = true;
      console.warn(
        "[qdrant-write] Qdrant write backend requested but QDRANT_URL is not set; writes stay on Pinecone."
      );
    }
    return "pinecone";
  }
  return "qdrant";
}

/**
 * Deterministic Qdrant point id matching scripts/qdrant/pinecone-to-qdrant-copy.py
 * `uuid.uuid5(uuid.NAMESPACE_URL, "st:" + ns + ":" + pc_id)`.
 */
export function qdrantPointId(namespace: string | undefined | null, pineconeId: string): string {
  const ns = pineconeNamespaceToQdrantTenant(namespace);
  const name = `st:${ns}:${pineconeId}`;
  const hash = crypto.createHash("sha1").update(UUID_NAMESPACE_URL).update(name, "utf8").digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Stable non-secret physical identity for managed receipts when Pinecone describeIndex is
 * skipped.  Production writes prefer durableProviderAuthority() from SQLite commits so ids
 * keep matching the copied corpus; this fallback is only for an empty ledger.
 */
export function qdrantProviderAuthority(): string {
  return crypto
    .createHash("sha256")
    .update(`qdrant-collection-authority:v1|${qdrantCollectionName()}`, "utf8")
    .digest("hex");
}

function isPayloadScalar(value: unknown): value is string | number | boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function sanitizePayloadValue(value: unknown): unknown {
  if (value == null) return value;
  if (isPayloadScalar(value)) return value;
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return undefined;
}

export function qdrantPayloadForRecord(
  namespace: string | undefined | null,
  record: QdrantUpsertRecord
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  if (record.metadata && typeof record.metadata === "object" && !Array.isArray(record.metadata)) {
    for (const [key, value] of Object.entries(record.metadata)) {
      if (key === "pc_id" || key === "ns") continue;
      const sanitized = sanitizePayloadValue(value);
      if (sanitized === undefined) continue;
      payload[key] = sanitized;
    }
  }
  payload.pc_id = record.id;
  payload.ns = pineconeNamespaceToQdrantTenant(namespace);
  return payload;
}

/** Bounded retry for a transient network blip against the self-hosted box (dead keep-alive
 *  socket, DNS hiccup, a brief 502/503 while Qdrant restarts). Safe to retry the WHOLE request —
 *  every caller in this module is idempotent by construction: upserts key off a deterministic
 *  uuid5 point id, deletes are filter/id-scoped, payload sets are id-scoped, scroll/collection-
 *  info are reads. A caller-side abort/timeout is never retried (isAbortOrTimeoutError takes
 *  priority) — that budget already elapsed once; spending it again just delays the caller. */
const QDRANT_MAX_ATTEMPTS = 3;
const QDRANT_RETRY_BASE_MS = 300;

function isRetryableQdrantServerError(err: unknown): boolean {
  return err instanceof Error && /failed \(HTTP 5\d\d\)/.test(err.message);
}

async function qdrantRequest(path: string, init: RequestInit): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < QDRANT_MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(`${qdrantBaseUrl()}${path}`, {
        ...init,
        headers: { ...qdrantHeaders(), ...(init.headers as Record<string, string> | undefined) },
        signal: init.signal ?? AbortSignal.timeout(qdrantTimeoutMs())
      });
      if (!response.ok) {
        const text = (await response.text().catch(() => "")).slice(0, 400);
        throw new Error(`Qdrant ${init.method ?? "GET"} ${path} failed (HTTP ${response.status}): ${text}`);
      }
      return response;
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
  throw lastErr;
}

function chunkItems<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function qdrantMaxPointsCapacity(): number | null {
  const configured = Number(process.env.QDRANT_MAX_POINTS ?? process.env.RAG_QDRANT_MAX_POINTS);
  return Number.isFinite(configured) && configured > 0
    ? Math.floor(configured)
    : null;
}

export async function qdrantUpsertPoints(options: {
  namespace: string | undefined | null;
  records: QdrantUpsertRecord[];
  wait?: boolean;
  userId?: string;
  /** Same IDs already written this request (pending → committed).  Skip growth/budget charges. */
  replacingExisting?: boolean;
}): Promise<{ upserted: number }> {
  if (options.records.length === 0) return { upserted: 0 };
  const userId = options.userId ?? "local";
  if (!options.replacingExisting && !hasRagIngestPointsBudget(userId, options.records.length, "qdrant")) {
    throw new Error(
      `[qdrant-write] Daily vector point ingestion budget exceeded; refusing upsert of ${options.records.length} points.`
    );
  }
  const maxCapacity = qdrantMaxPointsCapacity();
  if (maxCapacity !== null && !options.replacingExisting) {
    try {
      const info = await qdrantCollectionInfo();
      if (
        info.exists &&
        typeof info.pointsCount === "number" &&
        info.pointsCount + options.records.length > maxCapacity
      ) {
        throw new Error(
          `[qdrant-write] Qdrant collection point capacity exceeded (${info.pointsCount} points, limit ${maxCapacity}); upsert refused to prevent disk saturation.`
        );
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes("capacity exceeded")) {
        throw err;
      }
    }
  }
  const collection = encodeURIComponent(qdrantCollectionName());
  const wait = options.wait !== false;
  let upserted = 0;
  for (const batch of chunkItems(options.records, DEFAULT_UPSERT_BATCH)) {
    const points = batch.map((record) => ({
      id: qdrantPointId(options.namespace, record.id),
      vector: Array.isArray(record.values) ? record.values : [],
      payload: qdrantPayloadForRecord(options.namespace, record)
    }));
    await qdrantRequest(`/collections/${collection}/points?wait=${wait ? "true" : "false"}`, {
      method: "PUT",
      body: JSON.stringify({ points })
    });
    upserted += points.length;
  }
  return { upserted };
}

export async function qdrantDeleteByIds(options: {
  namespace: string | undefined | null;
  ids: string[];
  wait?: boolean;
}): Promise<{ deleted: number }> {
  const ids = [...new Set(options.ids.filter(Boolean))];
  if (ids.length === 0) return { deleted: 0 };
  const collection = encodeURIComponent(qdrantCollectionName());
  const wait = options.wait !== false;
  const ns = pineconeNamespaceToQdrantTenant(options.namespace);
  let deleted = 0;
  for (const batch of chunkItems(ids, DEFAULT_UPSERT_BATCH)) {
    await qdrantRequest(`/collections/${collection}/points/delete?wait=${wait ? "true" : "false"}`, {
      method: "POST",
      body: JSON.stringify({
        filter: {
          must: [
            { key: "ns", match: { value: ns } },
            { key: "pc_id", match: { any: batch } }
          ]
        }
      })
    });
    deleted += batch.length;
  }
  return { deleted };
}

export async function qdrantDeleteByFilter(options: {
  namespace: string | undefined | null;
  filter?: Record<string, unknown>;
  wait?: boolean;
}): Promise<void> {
  const collection = encodeURIComponent(qdrantCollectionName());
  const wait = options.wait !== false;
  const qdrantFilter = qdrantTenantFilter(
    pineconeNamespaceToQdrantTenant(options.namespace),
    options.filter
  );
  await qdrantRequest(`/collections/${collection}/points/delete?wait=${wait ? "true" : "false"}`, {
    method: "POST",
    body: JSON.stringify({ filter: qdrantFilter })
  });
}

export async function qdrantDeleteNamespace(options: {
  namespace: string | undefined | null;
  wait?: boolean;
}): Promise<void> {
  await qdrantDeleteByFilter({ namespace: options.namespace, wait: options.wait });
}

export async function qdrantSetPayload(options: {
  namespace: string | undefined | null;
  ids: string[];
  payload: Record<string, unknown>;
  wait?: boolean;
}): Promise<void> {
  const ids = [...new Set(options.ids.filter(Boolean))];
  if (ids.length === 0) return;
  const collection = encodeURIComponent(qdrantCollectionName());
  const wait = options.wait !== false;
  const payload: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(options.payload)) {
    const sanitized = sanitizePayloadValue(value);
    if (sanitized === undefined) continue;
    payload[key] = sanitized;
  }
  for (const batch of chunkItems(ids, DEFAULT_UPSERT_BATCH)) {
    await qdrantRequest(`/collections/${collection}/points/payload?wait=${wait ? "true" : "false"}`, {
      method: "POST",
      body: JSON.stringify({
        payload,
        points: batch.map((id) => qdrantPointId(options.namespace, id))
      })
    });
  }
}

function metadataFromPayload(payload: Record<string, unknown> | undefined): {
  pcId?: string;
  metadata: Record<string, unknown>;
} {
  if (!payload) return { metadata: {} };
  const metadata: Record<string, unknown> = { ...payload };
  const pcId = typeof metadata.pc_id === "string" ? metadata.pc_id : undefined;
  delete metadata.pc_id;
  delete metadata.ns;
  return { pcId, metadata };
}

export async function qdrantRetrieveByPcIds(options: {
  namespace: string | undefined | null;
  ids: string[];
}): Promise<string[]> {
  const ids = [...new Set(options.ids.filter(Boolean))];
  if (ids.length === 0) return [];
  const collection = encodeURIComponent(qdrantCollectionName());
  const existing: string[] = [];
  for (const batch of chunkItems(ids, DEFAULT_UPSERT_BATCH)) {
    const response = await qdrantRequest(`/collections/${collection}/points`, {
      method: "POST",
      body: JSON.stringify({
        ids: batch.map((id) => qdrantPointId(options.namespace, id)),
        with_payload: true,
        with_vector: false
      })
    });
    const parsed = (await response.json()) as {
      result?: Array<{ payload?: unknown }> | { points?: Array<{ payload?: unknown }> };
    };
    const hits = Array.isArray(parsed.result)
      ? parsed.result
      : Array.isArray(parsed.result?.points)
        ? parsed.result.points
        : [];
    for (const hit of hits) {
      const payload =
        hit?.payload && typeof hit.payload === "object" && !Array.isArray(hit.payload)
          ? (hit.payload as Record<string, unknown>)
          : undefined;
      const { pcId } = metadataFromPayload(payload);
      if (pcId) existing.push(pcId);
    }
  }
  return [...new Set(existing)].sort();
}

export async function qdrantInventoryByMetadata(options: {
  namespace?: string | undefined | null;
  prefix?: string;
  source?: string;
  docType?: string;
  receiptRequired?: boolean;
  batchSize?: number;
  maxScanned?: number;
} = {}): Promise<QdrantInventoryRow[]> {
  const batchSize = Math.max(1, Math.min(1_000, Math.floor(options.batchSize ?? DEFAULT_SCROLL_LIMIT)));
  const maxScanned = Math.max(1, Math.min(1_000_000, Math.floor(options.maxScanned ?? 250_000)));
  const ns = pineconeNamespaceToQdrantTenant(options.namespace);
  const extraFilter: Record<string, unknown> = {};
  if (options.source !== undefined) extraFilter.source = { $eq: options.source };
  if (options.docType !== undefined) extraFilter.doc_type = { $eq: options.docType.toLowerCase() };
  if (options.receiptRequired !== undefined) extraFilter.receipt_required = { $eq: options.receiptRequired };
  const filter: QdrantFilter = qdrantTenantFilter(
    ns,
    Object.keys(extraFilter).length > 0 ? extraFilter : undefined
  );
  const collection = encodeURIComponent(qdrantCollectionName());
  const found: QdrantInventoryRow[] = [];
  let scanned = 0;
  let offset: unknown = null;
  do {
    const body: Record<string, unknown> = {
      filter,
      limit: batchSize,
      with_payload: true,
      with_vector: false
    };
    if (offset != null) body.offset = offset;
    const response = await qdrantRequest(`/collections/${collection}/points/scroll`, {
      method: "POST",
      body: JSON.stringify(body)
    });
    const parsed = (await response.json()) as {
      result?: {
        points?: Array<{ id?: unknown; payload?: unknown }>;
        next_page_offset?: unknown;
      };
    };
    const points = Array.isArray(parsed.result?.points) ? parsed.result.points : [];
    if (scanned + points.length > maxScanned) {
      throw new Error(`Vector inventory scan limit exceeded (${maxScanned} records).`);
    }
    scanned += points.length;
    for (const point of points) {
      const payload =
        point?.payload && typeof point.payload === "object" && !Array.isArray(point.payload)
          ? (point.payload as Record<string, unknown>)
          : undefined;
      const { pcId, metadata } = metadataFromPayload(payload);
      if (!pcId) continue;
      if (options.prefix && !pcId.startsWith(options.prefix)) continue;
      if (options.source !== undefined && metadata.source !== options.source) continue;
      if (
        options.docType !== undefined &&
        String(metadata.doc_type ?? "").toLowerCase() !== options.docType.toLowerCase()
      ) {
        continue;
      }
      if (options.receiptRequired !== undefined && metadata.receipt_required !== options.receiptRequired) {
        continue;
      }
      found.push({ id: pcId, metadata });
    }
    offset = parsed.result?.next_page_offset ?? null;
  } while (offset != null && offset !== "");
  return found.sort((a, b) => a.id.localeCompare(b.id));
}

export async function qdrantCollectionInfo(): Promise<QdrantCollectionInfo> {
  const collection = qdrantCollectionName();
  const encoded = encodeURIComponent(collection);
  try {
    const response = await qdrantRequest(`/collections/${encoded}`, { method: "GET" });
    const parsed = (await response.json()) as {
      result?: {
        status?: unknown;
        points_count?: unknown;
        indexed_vectors_count?: unknown;
        config?: { params?: { vectors?: { size?: unknown } | Record<string, { size?: unknown }> } };
      };
    };
    const vectors = parsed.result?.config?.params?.vectors;
    const vectorObj = vectors && typeof vectors === "object"
      ? ("size" in vectors || "distance" in vectors ? vectors : Object.values(vectors)[0])
      : undefined;
    const dimension = vectorObj && typeof vectorObj === "object" && "size" in vectorObj
      ? Number((vectorObj as { size?: unknown }).size)
      : undefined;
    const distance = vectorObj && typeof vectorObj === "object" && "distance" in vectorObj
      ? String((vectorObj as { distance?: unknown }).distance)
      : undefined;
    return {
      exists: true,
      collection,
      pointsCount: Number(parsed.result?.points_count ?? parsed.result?.indexed_vectors_count ?? 0),
      ...(Number.isFinite(dimension) ? { dimension } : {}),
      ...(distance ? { distance } : {}),
      ...(typeof parsed.result?.status === "string" ? { status: parsed.result.status } : {})
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/HTTP 404/.test(message)) return { exists: false, collection };
    throw error;
  }
}

/**
 * Ingest-stage upsert telemetry for the Qdrant backend — same rag_usage row shape the Pinecone
 * path writes via meterPineconeUpsert, with provider "qdrant" and ZERO write units (self-hosted;
 * phantom Pinecone WUs must never be recorded when Pinecone served nothing).  Never throws.
 */
export function meterQdrantUpsert(recordCount: number, userId?: string): void {
  recordRagUsage({
    userId,
    operation: "upsert",
    provider: "qdrant",
    tokensIn: 0,
    tokensOut: recordCount,
    batchCount: recordCount
  });
}

export { qdrantConfigured, pineconeNamespaceToQdrantTenant };
