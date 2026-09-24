# 2026-07-21 — Voyage AI Purge & OpenRouter BAAI bge-m3 / cohere Reranker Standardization

## Summary
Completely purged Voyage AI SDK and dependencies from `Socratic-Trade`. Standardized default RAG embedding on OpenRouter (`baai/bge-m3`) with fallback to SiliconFlow (`BAAI/bge-m3`), and default cross-encoder reranking on OpenRouter (`cohere/rerank-v3.5`) with fallback to SiliconFlow (`Qwen/Qwen3-Reranker-8B`).

## Context & Rationale
Per explicit owner directive: Voyage AI is no longer used, and Voyage fallback logic and health checks were causing false 503s on `/api/health` during Voyage service outages even though OpenRouter was serving embeddings. Removing `voyageai` eliminates dependency churn, reduces bundle size, and prevents cross-provider confusion.

## Key Changes
1. **`package.json`**: Removed `"voyageai": "^0.4.0"` dependency.
2. **`src/lib/vector-db.ts`**:
   - Removed `import { VoyageAIClient } from "voyageai"`.
   - Removed `VOYAGE_MODEL` and Voyage client creation/caching in `getClients`.
   - Updated `pinnedEmbedProvider`, `assertPinnedProviderKeyConfigured`, `resolveActiveRagProvider`, `activeEmbeddingModel`, and `activeRerankModel` to default to `openrouter` (`baai/bge-m3` / `cohere/rerank-v3.5`) and allow `siliconflow`.
   - Updated `embedWithRetry` and `rerankMatches` to dispatch directly to OpenRouter / SiliconFlow HTTP embedding and reranking endpoints using `estimateRagDispatchCost`.
3. **`src/lib/rag-metering.ts`**:
   - Updated `RagEmbedRerankProvider` type union to `"openrouter" | "siliconflow"`.
   - Removed Voyage pricing tables and defaulted `meterEmbed`, `meterRerank`, `estimateRagDispatchCost` to `openrouter`.
4. **`src/lib/db-health.ts`**:
   - Updated `RAG_SERVICES_WITH_OWN_ALERTING` to replace `"voyage"` and `"voyage-rerank"` with `"openrouter"` and `"openrouter-rerank"`.
5. **`app/api/health/route.ts`**:
   - Removed Voyage key checks and updated critical RAG dependency health checks to verify `openrouter` / `openrouter-rerank` (or `siliconflow`).
6. **Test Suite**:
   - `test/connection-health-routing.test.ts`: Replaced Voyage outage tests with OpenRouter active provider outage 503 test.
   - `test/rag-embed-provider-gate.test.ts`: Purged Voyage pinning tests and verified OpenRouter default behavior.

## Verification
- `npx tsc --noEmit`: PASS (0 type errors)
- `npm run lint`: PASS (0 lint errors)
- `VITEST_MAX_THREADS=4 npm test`: PASS (420 test files, 4,900 tests passed)
- `npm run build`: PASS (Full Next.js production build succeeded)
