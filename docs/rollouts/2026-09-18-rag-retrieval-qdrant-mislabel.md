# 2026-09-18 — RAG retrieval no longer pages as Pinecone after Qdrant cutover

## Summary

Sentry `SOCRATIC-TRADE-1T` ("RAG retrieval failed") kept tagging `rag.provider=pinecone` on
production retrieveContext failures after Stage 1/2 Qdrant cutover. Live 2026-09-18T14:53Z
event: `reason=fetch failed`, release `fcb64d2b`, public `/api/health` 200. Writes already
labeled Qdrant correctly (`storeContexts` catch + `qdrantRequest` retry, 2026-09-07). Reads
did not.

## Changes

1. `retrieveContextDetailed` catch uses `readBackend` (qdrant|pinecone), not a hardcoded
   `"pinecone"`.
2. `qdrantQueryTier` retries transient `fetch failed` / HTTP 5xx the same way writes do
   (3 attempts, no retry on caller abort/timeout).
3. Public `/api/health` reports `qdrantConfigured`, `ragVectorReadBackend`,
   `ragVectorWriteBackend`. RAG-configured no longer requires a Pinecone key when Qdrant
   is the read backend. Pinecone is not a 503-critical dependency while Qdrant is serving.

No Coolify deploy. Extra-ship no.

## Verify

- `npx vitest run test/qdrant-read.test.ts test/vector-db-qdrant-retrieval.test.ts test/connection-health-routing.test.ts`
