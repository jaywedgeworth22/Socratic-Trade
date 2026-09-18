import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// With Pinecone writes retired (Qdrant-only), `assertIndexMetric` / `describeIndex` must NOT run
// on the retrieval path — Cosine is asserted via `assertQdrantCollectionMetric`, and managed
// authority comes from the durable ledger / qdrantProviderAuthority.  Earlier (#3138/#3158)
// kept a best-effort Pinecone describeIndex even on Qdrant reads; that control-plane call is
// retired once the write backend is qdrant.

process.env.DATABASE_URL = `file:${join(tmpdir(), `socratic-qdrant-index-metric-${randomUUID()}.db`)}`;

const mocks = vi.hoisted(() => {
  const namespacedIndex = {
    upsert: vi.fn(async () => undefined),
    query: vi.fn(async () => ({ matches: [] })),
    listPaginated: vi.fn(),
    fetch: vi.fn(),
    update: vi.fn(async () => undefined),
    deleteMany: vi.fn(async () => undefined)
  };
  return {
    namespacedIndex,
    index: vi.fn(() => ({ ...namespacedIndex, namespace: vi.fn(() => namespacedIndex) })),
    listIndexes: vi.fn(async () => ({ indexes: [{ name: "socratic-trade" }] })),
    createIndex: vi.fn(async () => undefined),
    describeIndex: vi.fn(async () => ({ dimension: 1024, metric: "cosine", host: "idx-test.pinecone.io" }))
  };
});

vi.mock("@pinecone-database/pinecone", () => ({
  Pinecone: vi.fn(function Pinecone() {
    return {
      listIndexes: mocks.listIndexes,
      createIndex: mocks.createIndex,
      describeIndex: mocks.describeIndex,
      Index: mocks.index
    };
  })
}));

beforeAll(async () => {
  const { getDb } = await import("../src/lib/db");
  getDb();
}, 60_000);

function qdrantSearchFetch() {
  return vi.fn(async (url: string | URL | Request) => {
    const urlStr = String(url);
    if (urlStr.includes("embeddings")) {
      return new Response(JSON.stringify({ data: [{ embedding: new Array(1024).fill(0.01) }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
    if (urlStr.includes("/points/search")) {
      return new Response(
        JSON.stringify({
          result: [
            {
              id: "d8c1c4b7-0000-0000-0000-000000000001",
              score: 0.88,
              payload: {
                pc_id: "sec-filings:AAPL:10-k:2026:chunk-1",
                symbol: "AAPL",
                doc_type: "10-k",
                scope: "shared",
                tenant_scope: "shared:operator",
                userId: "local",
                text: "Apple Inc. reported quarterly revenue of 100B."
              }
            }
          ]
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    return new Response("Not found", { status: 404 });
  });
}

describe("assertIndexMetric on the Qdrant read path", () => {
  beforeEach(async () => {
    process.env.PINECONE_API_KEY = "pinecone-test";
    process.env.QDRANT_URL = "http://127.0.0.1:6333";
    process.env.QDRANT_API_KEY = "live-qdrant-key";
    process.env.SILICONFLOW_API_KEY = "live-sf-key";
    process.env.RAG_EMBED_PROVIDER = "siliconflow";
    process.env.PINECONE_INDEX_READY_WAIT_MS = "0";
    process.env.VECTOR_EMBED_BATCH_DELAY_MS = "0";
    process.env.VECTOR_EMBED_RETRY_DELAY_MS = "0";
    process.env.VECTOR_ENABLE_RERANK = "off";
    process.env.HYBRID_RETRIEVAL = "off";
    delete process.env.VOYAGE_API_KEY;
    const { setServerKnobOverride, invalidateServerKnobCache } = await import("../src/lib/server-knobs");
    setServerKnobOverride("RAG_VECTOR_READ_QDRANT", true);
    invalidateServerKnobCache();
    mocks.describeIndex.mockClear();
    mocks.listIndexes.mockClear();
  });

  afterEach(async () => {
    const { setServerKnobOverride, invalidateServerKnobCache } = await import("../src/lib/server-knobs");
    setServerKnobOverride("RAG_VECTOR_READ_QDRANT", null);
    invalidateServerKnobCache();
    vi.unstubAllGlobals();
  });

  afterAll(() => {
    delete process.env.PINECONE_API_KEY;
    delete process.env.QDRANT_URL;
    delete process.env.QDRANT_API_KEY;
    delete process.env.SILICONFLOW_API_KEY;
    delete process.env.RAG_EMBED_PROVIDER;
  });

  it("skips Pinecone describeIndex when write backend is qdrant (Pinecone CP retired)", async () => {
    const mockFetch = qdrantSearchFetch();
    vi.stubGlobal("fetch", mockFetch);

    const { retrieveContextDetailed } = await import("../src/lib/vector-db");
    const chunks = await retrieveContextDetailed("Apple revenue", "AAPL", 5, "local");

    // Pinecone control-plane must stay quiet on the Qdrant-only write path.
    expect(mocks.describeIndex).not.toHaveBeenCalled();
    expect(mocks.listIndexes).not.toHaveBeenCalled();
    expect(mocks.namespacedIndex.query).not.toHaveBeenCalled();
    expect(mockFetch.mock.calls.some((call) => String(call[0]).includes("/points/search"))).toBe(true);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].id).toBe("sec-filings:AAPL:10-k:2026:chunk-1");
  });

  it("assertQdrantCollectionMetric validates Cosine distance and audits mismatch on Euclid", async () => {
    const { assertQdrantCollectionMetric, resetQdrantMetricCheckedForTests } = await import(
      "../src/lib/vector-store/qdrant-read"
    );
    const { getDb } = await import("../src/lib/db");

    resetQdrantMetricCheckedForTests();

    // Stub fetch returning Euclid distance for the collection
    vi.stubGlobal("fetch", async (url: string | URL | Request) => {
      const urlStr = String(url);
      if (urlStr.includes("/collections/")) {
        return new Response(
          JSON.stringify({
            result: {
              status: "green",
              points_count: 500,
              config: {
                params: {
                  vectors: {
                    size: 1024,
                    distance: "Euclid"
                  }
                }
              }
            }
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response("Not found", { status: 404 });
    });

    await assertQdrantCollectionMetric();

    const auditRow = getDb()
      .prepare("SELECT * FROM audit_events WHERE kind = 'vector_index_metric_mismatch' ORDER BY id DESC LIMIT 1")
      .get() as { payload?: string; details?: string } | undefined;
    expect(auditRow).toBeDefined();
    expect(auditRow?.payload).toContain("Euclid");
  });
});
