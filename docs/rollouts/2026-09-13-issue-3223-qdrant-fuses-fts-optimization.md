# Rollout: Qdrant Write Spend Fuses, Distance Metric Assertions, and SEC FTS Offloading

**Date:** 2026-09-13  
**Lane:** Antigravity (`~/apps/trading-antigravity`)  
**Branch:** `ag/issue-3223-qdrant-fuses-fts-optimization`  
**Issue:** #3223  

---

## 1. Context & Objective

Following the production cutover from Pinecone to self-hosted Qdrant, write paths lacked spend fuses, capacity ceilings, and metric validation assertions, leaving Qdrant susceptible to unbounded point explosion or distorted ranking under misconfigured distance metrics.  Additionally, embedding rate-limit backoffs could not extract `Retry-After` response headers, and the SEC ingest worker repeatedly read and parsed filing artifacts from disk on every single tick during sliced SQLite FTS mirroring.  This change adds daily vector ingestion point fuses, collection capacity breakers, Cosine distance assertions, HTTP header retention on embedding rate limits, and in-memory caching to eliminate redundant disk I/O during SEC FTS mirroring.

---

## 2. Changes Made

- **`src/lib/rag-metering.ts`**:
  - Implemented `usedRagUpsertPointsLast24h(userId, provider)` to query total vector points ingested over the last 24 hours from `rag_usage`.
  - Added `ragMaxDailyIngestPoints()` configurable via `RAG_MAX_DAILY_INGEST_POINTS` (default: 50,000 points/day).
  - Implemented `hasRagIngestPointsBudget(userId, requested, provider)` to enforce daily point limits across providers.

- **`src/lib/vector-store/qdrant-write.ts`**:
  - Added `distance?: string` to `QdrantCollectionInfo` extracted from `config.params.vectors`.
  - Added `qdrantMaxPointsCapacity()` returning parsed `QDRANT_MAX_POINTS` or `RAG_QDRANT_MAX_POINTS` (or `null` when unconfigured).
  - Integrated `hasRagIngestPointsBudget` and `qdrantMaxPointsCapacity` checks in `qdrantUpsertPoints` to refuse upserts when capacity or daily budget is exceeded.

- **`src/lib/vector-store/qdrant-read.ts`**:
  - Implemented `assertQdrantCollectionMetric()` and `resetQdrantMetricCheckedForTests()`.
  - Audits metric mismatches to `audit_events` with `kind = 'vector_index_metric_mismatch'` when the collection distance metric is not `Cosine`.

- **`src/lib/vector-db.ts`**:
  - Integrated `assertQdrantCollectionMetric()` on the Qdrant retrieval path.
  - Added `hasRagIngestPointsBudget` check on `storeDocumentImpl` before point writes.
  - Defined and exported `HttpProviderError` preserving response status code and headers.
  - Updated `embedWithRetry` and `rerankMatches` to throw `HttpProviderError` so `retryAfterMs` can inspect `Retry-After` headers.

- **`src/lib/rag/fts-mirror-bound.ts`**:
  - Made `FTS_MIRROR_MAX_CHUNKS_PER_TICK` (default: 6) and `FTS_MIRROR_TICK_BUDGET_MS` (default: 4,000 ms) configurable via `FTS_MIRROR_MAX_CHUNKS_PER_TICK` and `FTS_MIRROR_TICK_BUDGET_MS` environment variables.

- **`src/lib/rag/sec-ingest-worker.ts`**:
  - Introduced in-memory `ftsRowsCache` keyed by task ID and sequence.
  - Deferred reading `rawContent` and `sections.json` from disk when `storeAlreadyDone` is true, avoiding 150+ redundant disk reads and JSON parses per filing during sliced FTS mirroring.

- **`instrumentation.ts`**:
  - Resolved dynamic import type-checking for optional `@sentry/profiling-node` dependency.

- **Tests**:
  - `test/qdrant-write.test.ts`: Added unit tests verifying daily point spend fuses and collection capacity limits.
  - `test/vector-db-qdrant-index-metric.test.ts`: Added tests verifying Qdrant Cosine metric assertion and audit logging.
  - `test/vector-db.test.ts`: Added tests for `HttpProviderError` response header extraction and rate-limit backoff.

---

## 3. Decisions & Trade-offs

- **Optional Capacity Checks**: `qdrantMaxPointsCapacity()` returns `null` when neither `QDRANT_MAX_POINTS` nor `RAG_QDRANT_MAX_POINTS` is specified.  This ensures normal upserts do not issue an unneeded HTTP GET preflight request before every batch, saving network round trips while enforcing limits whenever configured.
- **In-Memory FTS Caching**: The FTS chunk cache in `sec-ingest-worker.ts` is keyed in-memory per task ID and cleaned up upon task completion, avoiding disk churn without risking memory leaks.

---

## 4. Verification State

All local gate checks passed cleanly:
- `npm run lint`: 0 errors (809 grandfathered warnings).
- `npx tsc --noEmit`: Clean, 0 type errors.
- `npx vitest run test/vector-db-qdrant-index-metric.test.ts test/qdrant-write.test.ts test/vector-db.test.ts test/sec-ingest-worker.test.ts`: 4 test files passed, 73 tests passed.

---

## 5. Next Steps & Blockers

- Proceed with Issue #3224: API security hardening (open redirect sanitization, public auth rate limiting, and defensive JSON parsing).
- Monitor PR #3282 (Issue #3221) and PR #3283 (Issue #3222) auto-merge progression.

---

## 6. Zero-Code Findings

- None.
