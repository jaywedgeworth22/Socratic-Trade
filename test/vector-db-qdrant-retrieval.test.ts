import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-qdrant-retrieval-${randomUUID()}.db`)}`;
});

const sentryMetricsMock = vi.hoisted(() => ({
  logError: vi.fn()
}));

vi.mock("../src/lib/sentry-metrics", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/sentry-metrics")>();
  return { ...actual, logError: sentryMetricsMock.logError };
});

import {
  retrieveContextDetailed,
  reconcileManagedVectorRecords,
  storeContexts,
  inventoryVectorRecordsByMetadata,
  purgePrivateVectorRecordsForUser,
  vectorNamespaceName,
  getCurrentVectorProviderAuthority,
  hasPineconeWriteBudget
} from "../src/lib/vector-db";
import { setServerKnobOverride, invalidateServerKnobCache } from "../src/lib/server-knobs";
import { qdrantPointId } from "../src/lib/vector-store/qdrant-write";
import { PINECONE_WU_EXHAUSTED_UNTIL_KEY } from "../src/lib/pinecone-wu-breaker";
import { setInternalSetting } from "../src/lib/db";

describe("retrieveContextDetailed with Qdrant read backend", () => {
  beforeEach(() => {
    process.env.QDRANT_URL = "http://127.0.0.1:6333";
    process.env.QDRANT_API_KEY = "live-qdrant-key";
    process.env.SILICONFLOW_API_KEY = "live-sf-key";
    process.env.RAG_EMBED_PROVIDER = "siliconflow";
    process.env.VECTOR_EMBED_BATCH_DELAY_MS = "0";
    process.env.VECTOR_EMBED_RETRY_DELAY_MS = "0";
    invalidateServerKnobCache();
    sentryMetricsMock.logError.mockClear();
  });

  afterEach(() => {
    delete process.env.QDRANT_URL;
    delete process.env.QDRANT_API_KEY;
    delete process.env.SILICONFLOW_API_KEY;
    delete process.env.RAG_EMBED_PROVIDER;
    delete process.env.PINECONE_API_KEY;
    delete process.env.VOYAGE_API_KEY;
    delete process.env.PINECONE_MONTHLY_WU_BUDGET;
    delete process.env.VECTOR_EMBED_BATCH_DELAY_MS;
    delete process.env.VECTOR_EMBED_RETRY_DELAY_MS;
    setServerKnobOverride("RAG_VECTOR_READ_QDRANT", null);
    setServerKnobOverride("RAG_VECTOR_WRITE_QDRANT", null);
    invalidateServerKnobCache();
    vi.unstubAllGlobals();
  });

  it("retrieves context from Qdrant by default without Pinecone key or client", async () => {
    delete process.env.PINECONE_API_KEY;

    const mockFetch = vi.fn(async (url: string | URL | Request) => {
      const urlStr = String(url);
      if (urlStr.includes("embeddings")) {
        return new Response(
          JSON.stringify({
            data: [{ embedding: new Array(1024).fill(0.01) }]
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
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

    vi.stubGlobal("fetch", mockFetch);

    const chunks = await retrieveContextDetailed("Apple revenue", "AAPL", 5, "local");
    expect(chunks).toBeDefined();
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].text).toContain("Apple Inc. reported quarterly revenue");
    expect(chunks[0].id).toBe("sec-filings:AAPL:10-k:2026:chunk-1");
  });

  it("reconcileManagedVectorRecords inventories Qdrant without a Pinecone client", async () => {
    delete process.env.PINECONE_API_KEY;
    const mockFetch = vi.fn(async (url: string | URL | Request) => {
      const urlStr = String(url);
      if (urlStr.includes("/points/scroll")) {
        return new Response(
          JSON.stringify({ result: { points: [], next_page_offset: null } }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response("Not found", { status: 404 });
    });
    vi.stubGlobal("fetch", mockFetch);
    const res = await reconcileManagedVectorRecords({ userId: "local", dryRun: true });
    expect(res).toBeDefined();
    expect(res.promoted).toBe(0);
    expect(res.deleted).toBe(0);
    expect(mockFetch.mock.calls.some((call) => String(call[0]).includes("/points/scroll"))).toBe(true);
  });

  it("storeContexts upserts to Qdrant without a Pinecone client or pinecone health wrap", async () => {
    delete process.env.PINECONE_API_KEY;
    delete process.env.VOYAGE_API_KEY;
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const mockFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      const urlStr = String(url);
      if (urlStr.includes("/points")) {
        return new Response(JSON.stringify({ result: { status: "ok" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      return new Response("Not found", { status: 404 });
    });
    vi.stubGlobal("fetch", mockFetch);

    const result = await storeContexts([
      {
        text: "AAPL 10-K body for qdrant write",
        metadata: { symbol: "AAPL", source: "sec-edgar", timestamp: "2026-06-20", accession: "a1" }
      }
    ]);
    expect(result.indexed).toBe(1);
    expect(result.wuExhausted).toBeUndefined();
    const upsert = calls.find((call) => call.url.includes("/points?wait=true") && call.init.method === "PUT");
    expect(upsert).toBeDefined();
    const body = JSON.parse(String(upsert!.init.body));
    expect(body.points[0].payload.pc_id).toBeTruthy();
    expect(body.points[0].payload.ns).toBe("");
    expect(body.points[0].id).toBe(qdrantPointId("", body.points[0].payload.pc_id));
    expect(calls.every((call) => !call.url.includes("pinecone"))).toBe(true);
  });

  it("storeContexts does not park on an exhausted Pinecone WU marker when writes are Qdrant", async () => {
    delete process.env.PINECONE_API_KEY;
    process.env.PINECONE_MONTHLY_WU_BUDGET = "5000000";
    setInternalSetting(PINECONE_WU_EXHAUSTED_UNTIL_KEY, "2099-01-01T00:00:00.000Z");
    const mockFetch = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes("/points")) {
        return new Response(JSON.stringify({ result: { status: "ok" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      return new Response("Not found", { status: 404 });
    });
    vi.stubGlobal("fetch", mockFetch);
    const result = await storeContexts([
      { text: "MSFT 8-K despite WU park", metadata: { symbol: "MSFT", source: "sec-8k", timestamp: "2026-06-20" } }
    ]);
    expect(result.wuExhausted).toBeUndefined();
    expect(result.indexed).toBe(1);
    expect(hasPineconeWriteBudget("local")).toBe(true);
  });

  it("inventoryVectorRecordsByMetadata scrolls Qdrant and does not require a Pinecone key", async () => {
    delete process.env.PINECONE_API_KEY;
    const mockFetch = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes("/points/scroll")) {
        return new Response(
          JSON.stringify({
            result: {
              points: [
                {
                  id: "aaaaaaaa-bbbb-5ccc-8ddd-eeeeeeeeeeee",
                  payload: { pc_id: "occ:v3:inv-1", ns: "", symbol: "AAPL", source: "sec-edgar" }
                }
              ],
              next_page_offset: null
            }
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response("Not found", { status: 404 });
    });
    vi.stubGlobal("fetch", mockFetch);
    const rows = await inventoryVectorRecordsByMetadata({ userId: "local", namespace: "default" });
    expect(rows).toEqual([
      { id: "occ:v3:inv-1", metadata: { symbol: "AAPL", source: "sec-edgar" } }
    ]);
  });

  it("erases a private Qdrant namespace above 50k without hitting the reconciliation scan ceiling", async () => {
    delete process.env.PINECONE_API_KEY;
    process.env.VECTOR_ERASURE_VERIFY_ATTEMPTS = "1";
    process.env.VECTOR_ERASURE_VERIFY_CONSECUTIVE_CLEAN = "1";
    process.env.VECTOR_ERASURE_VERIFY_DELAY_MS = "0";
    const total = 50_001;
    let privateScrollPages = 0;
    let namespaceDeleted = false;
    const mockFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = String(url);
      if (path.includes("/points/delete")) {
        const body = JSON.parse(String(init?.body));
        const tenant = body.filter?.must?.find((clause: { key: string }) => clause.key === "ns")?.match?.value;
        if (tenant === vectorNamespaceName("private", undefined, "local")) namespaceDeleted = true;
        return new Response(JSON.stringify({ result: { status: "ok" } }), { status: 200 });
      }
      if (path.includes("/points/scroll")) {
        const body = JSON.parse(String(init?.body));
        const tenant = body.filter.must.find((clause: { key: string }) => clause.key === "ns")?.match?.value;
        const isPrivate = tenant === vectorNamespaceName("private", undefined, "local");
        const start = Number(body.offset ?? 0);
        const count = isPrivate && !namespaceDeleted ? Math.min(1000, total - start) : 0;
        if (isPrivate && !namespaceDeleted) privateScrollPages++;
        return new Response(JSON.stringify({ result: {
          points: Array.from({ length: count }, (_, i) => ({ payload: {
            pc_id: `private-${start + i}`, ns: tenant, content_hash: `hash-${start + i}`
          } })),
          next_page_offset: count && start + count < total ? start + count : null
        } }), { status: 200 });
      }
      return new Response("Not found", { status: 404 });
    });
    vi.stubGlobal("fetch", mockFetch);
    try {
      const result = await purgePrivateVectorRecordsForUser({
        userId: "local", accountDeletionRequestId: "prepared-request",
        batchSize: 1000, leaseGuard: { assertOwnership: vi.fn() }
      });
      expect(privateScrollPages).toBe(51);
      expect(namespaceDeleted).toBe(true);
      expect(result.deleted).toBe(total);
      expect(result.contentHashes).toHaveLength(total);
    } finally {
      delete process.env.VECTOR_ERASURE_VERIFY_ATTEMPTS;
      delete process.env.VECTOR_ERASURE_VERIFY_CONSECUTIVE_CLEAN;
      delete process.env.VECTOR_ERASURE_VERIFY_DELAY_MS;
    }
  });

  it("getCurrentVectorProviderAuthority returns a durable/qdrant authority without Pinecone", async () => {
    delete process.env.PINECONE_API_KEY;
    const authority = await getCurrentVectorProviderAuthority({ userId: "local" });
    expect(typeof authority).toBe("string");
    expect(authority?.length).toBeGreaterThan(20);
  });

  // Production evidence (litestream-runtime.log, 2026-08-29..2026-09-07): 92 "[vector-db] Error
  // storing contexts: TypeError: fetch failed" events on the RAG write path since the 2026-09-01
  // Qdrant write cutover. Before this fix, storeContextsImpl's catch block hardcoded
  // `provider: "pinecone"` in the Sentry/logError report regardless of which backend actually
  // wrote — the same mislabel class as the 2026-08-09 "Pinecone connection failed / database is
  // locked" pushes (docs/rollouts/2026-08-09-pinecone-lock-mislabel.md), just at the provider tag
  // instead of the failure cause. qdrantUpsertPoints already retries a transient network failure
  // with backoff (see qdrant-write.test.ts), so by the time this fires the retries are exhausted.
  it("labels a sustained Qdrant write failure with provider 'qdrant', not the old hardcoded 'pinecone'", async () => {
    delete process.env.PINECONE_API_KEY;
    delete process.env.VOYAGE_API_KEY;
    const mockFetch = vi.fn(async (url: string | URL | Request) => {
      const urlStr = String(url);
      if (urlStr.includes("embeddings")) {
        return new Response(JSON.stringify({ data: [{ embedding: new Array(1024).fill(0.01) }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      if (urlStr.includes("/points")) {
        throw new TypeError("fetch failed");
      }
      return new Response("Not found", { status: 404 });
    });
    vi.stubGlobal("fetch", mockFetch);

    const result = await storeContexts([
      {
        text: "AAPL 10-K body for a sustained Qdrant write failure",
        metadata: { symbol: "AAPL", source: "sec-edgar", timestamp: "2026-06-20", accession: "a2" }
      }
    ]);

    expect(result.error).toBeDefined();
    const call = sentryMetricsMock.logError.mock.calls.find((c) => c[0] === "rag.error");
    expect(call).toBeDefined();
    expect(call?.[1]).toMatchObject({ provider: "qdrant" });
  });

  // Production evidence (Sentry SOCRATIC-TRADE-1T, lastSeen 2026-09-18): retrieveContext
  // "RAG retrieval failed" / reason "fetch failed" was tagged rag.provider=pinecone after
  // the Qdrant read cutover because the catch hardcoded the provider. Dense queries never
  // left the self-hosted box. Same leftover family as the storeContexts mislabel above.
  it("labels a sustained Qdrant retrieve failure with provider 'qdrant', not the old hardcoded 'pinecone'", async () => {
    delete process.env.PINECONE_API_KEY;
    // Real timers, like the storeContexts sibling above.  This test used vi.useFakeTimers() plus one
    // `await vi.runAllTimersAsync()`, which hangs: retrieveContextDetailed awaits real async work (the
    // embed fetch, settings reads) BEFORE qdrantQueryTier schedules its 300ms/600ms retry backoff, so
    // when runAllTimersAsync runs there are no timers yet, it returns at once, and the backoff timer
    // scheduled afterwards is never advanced (timed out at 60s in CI run 35372259807 and locally).
    // The real backoff is only 300 + 600 ms.
    const mockFetch = vi.fn(async (url: string | URL | Request) => {
      const urlStr = String(url);
      if (urlStr.includes("embeddings")) {
        return new Response(
          JSON.stringify({ data: [{ embedding: new Array(1024).fill(0.01) }] }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      throw new TypeError("fetch failed");
    });
    vi.stubGlobal("fetch", mockFetch);

    const chunks = await retrieveContextDetailed("Apple revenue", "AAPL", 5, "local");
    expect(chunks).toEqual([]);
    const call = sentryMetricsMock.logError.mock.calls.find((c) => c[0] === "rag.error");
    expect(call).toBeDefined();
    expect(call?.[1]).toMatchObject({ provider: "qdrant" });
  });
});
