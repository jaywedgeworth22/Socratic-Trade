/**
 * STAGE-1 Qdrant read backend (src/lib/vector-store/qdrant-read.ts):
 *   - backend knob resolution: default qdrant when QDRANT_URL is set; DB override > env boolean > env string; the
 *     qdrant choice additionally requires QDRANT_URL
 *   - Pinecone-namespace -> ns tenant mapping (default namespace == "" on this index, verified live)
 *   - qdrantQueryTier request shape + response mapping (pc_id becomes the match id; pc_id/ns are
 *     stripped from metadata; hits missing pc_id are skipped and counted)
 *   - meterQdrantQuery books provider "qdrant" with zero read units (no phantom Pinecone WUs)
 *
 * HTTP is mocked (vi.stubGlobal fetch) — no live network.  DB uses the temp-SQLite pattern.
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-qdrant-read-${randomUUID()}.db`)}`;
});

import {
  QDRANT_READ_KNOB_ID,
  meterQdrantQuery,
  pineconeNamespaceToQdrantTenant,
  qdrantConfigured,
  qdrantQueryTier,
  vectorReadBackend
} from "../src/lib/vector-store/qdrant-read";
import { invalidateServerKnobCache, serverKnobById, setServerKnobOverride } from "../src/lib/server-knobs";
import { getDb } from "../src/lib/db";

const KNOB_ENV_VARS = [QDRANT_READ_KNOB_ID, "RAG_VECTOR_READ_BACKEND", "QDRANT_URL", "QDRANT_API_KEY", "QDRANT_COLLECTION", "QDRANT_QUERY_TIMEOUT_MS"];

beforeEach(() => {
  for (const name of KNOB_ENV_VARS) delete process.env[name];
  setServerKnobOverride(QDRANT_READ_KNOB_ID, null);
  invalidateServerKnobCache();
});

afterEach(() => {
  for (const name of KNOB_ENV_VARS) delete process.env[name];
  setServerKnobOverride(QDRANT_READ_KNOB_ID, null);
  invalidateServerKnobCache();
  vi.unstubAllGlobals();
});

describe("backend knob resolution", () => {
  it("is a catalogued server knob (runtime-flippable without redeploy)", () => {
    const spec = serverKnobById(QDRANT_READ_KNOB_ID);
    expect(spec?.type).toBe("boolean");
    expect(spec?.defaultValue).toBe(true);
  });

  it("defaults to qdrant when QDRANT_URL is set, falls back to pinecone when unconfigured", () => {
    expect(vectorReadBackend()).toBe("pinecone");
    process.env.QDRANT_URL = "http://qdrant.example:6333";
    expect(vectorReadBackend()).toBe("qdrant");
  });

  it("boolean env turns qdrant on (with QDRANT_URL) and explicit falsy keeps pinecone", () => {
    process.env.QDRANT_URL = "http://qdrant.example:6333";
    process.env[QDRANT_READ_KNOB_ID] = "1";
    expect(vectorReadBackend()).toBe("qdrant");
    process.env[QDRANT_READ_KNOB_ID] = "off";
    expect(vectorReadBackend()).toBe("pinecone");
  });

  it("string env RAG_VECTOR_READ_BACKEND=qdrant|pinecone is honored when the boolean is unset", () => {
    process.env.QDRANT_URL = "http://qdrant.example:6333";
    process.env.RAG_VECTOR_READ_BACKEND = "qdrant";
    expect(vectorReadBackend()).toBe("qdrant");
    process.env.RAG_VECTOR_READ_BACKEND = "pinecone";
    expect(vectorReadBackend()).toBe("pinecone");
    // The boolean env spelling wins over the string spelling when both are set.
    process.env.RAG_VECTOR_READ_BACKEND = "qdrant";
    process.env[QDRANT_READ_KNOB_ID] = "0";
    expect(vectorReadBackend()).toBe("pinecone");
  });

  it("DB override beats env in both directions", () => {
    process.env.QDRANT_URL = "http://qdrant.example:6333";
    process.env[QDRANT_READ_KNOB_ID] = "1";
    setServerKnobOverride(QDRANT_READ_KNOB_ID, false);
    expect(vectorReadBackend()).toBe("pinecone");
    setServerKnobOverride(QDRANT_READ_KNOB_ID, true);
    expect(vectorReadBackend()).toBe("qdrant");
    setServerKnobOverride(QDRANT_READ_KNOB_ID, null);
    expect(vectorReadBackend()).toBe("qdrant"); // falls back to env
  });

  it("qdrant selection requires QDRANT_URL — knob on without it stays on pinecone", () => {
    process.env[QDRANT_READ_KNOB_ID] = "true";
    expect(qdrantConfigured()).toBe(false);
    expect(vectorReadBackend()).toBe("pinecone");
  });

  it("requires QDRANT_API_KEY on remote endpoints in production", () => {
    const originalEnv = process.env.NODE_ENV;
    try {
      (process.env as unknown as { NODE_ENV: string }).NODE_ENV = "production";
      process.env.QDRANT_URL = "https://qdrant.remote.example:6333";
      delete process.env.QDRANT_API_KEY;
      delete process.env.QDRANT_ALLOW_ANONYMOUS;
      expect(qdrantConfigured()).toBe(false);
      expect(vectorReadBackend()).toBe("pinecone");

      process.env.QDRANT_API_KEY = "live-key";
      expect(qdrantConfigured()).toBe(true);
      expect(vectorReadBackend()).toBe("qdrant");
    } finally {
      (process.env as unknown as { NODE_ENV: string }).NODE_ENV = originalEnv;
    }
  });
});

describe("namespace -> ns tenant mapping", () => {
  it("maps the Pinecone default namespace ('' / undefined) to ns '' — the value the copy wrote", () => {
    expect(pineconeNamespaceToQdrantTenant("")).toBe("");
    expect(pineconeNamespaceToQdrantTenant(undefined)).toBe("");
    expect(pineconeNamespaceToQdrantTenant(null)).toBe("");
  });

  it("maps every named namespace to itself verbatim", () => {
    for (const ns of [
      "socratic-164c2691b903641db7ff",
      "socratic-private-164c2691b903641db7ff-3005089dedde7bd97ac2",
      "socratic-fmp-transcripts-164c2691b903641db7ff"
    ]) {
      expect(pineconeNamespaceToQdrantTenant(ns)).toBe(ns);
    }
  });
});

function stubFetch(response: { ok?: boolean; status?: number; json?: unknown; text?: string }) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return {
      ok: response.ok ?? true,
      status: response.status ?? 200,
      json: async () => response.json ?? { result: [] },
      text: async () => response.text ?? ""
    } as unknown as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, calls };
}

describe("qdrantQueryTier", () => {
  beforeEach(() => {
    process.env.QDRANT_URL = "http://qdrant.example:6333/";
    process.env.QDRANT_API_KEY = "test-key";
  });

  it("POSTs /points/search with tenant-pinned filter, quantization rescore params, and no score_threshold", async () => {
    const { calls } = stubFetch({ json: { result: [] } });
    await qdrantQueryTier("socratic-abc", {
      vector: [0.1, 0.2],
      topK: 25,
      filter: { symbol: { $eq: "AAPL" } }
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://qdrant.example:6333/collections/socratic-trade/points/search");
    expect((calls[0].init.headers as Record<string, string>)["api-key"]).toBe("test-key");
    const body = JSON.parse(String(calls[0].init.body));
    expect(body).toEqual({
      vector: [0.1, 0.2],
      limit: 25,
      filter: {
        must: [
          { key: "ns", match: { value: "socratic-abc" } },
          { key: "symbol", match: { value: "AAPL" } }
        ]
      },
      params: {
        hnsw_ef: 128,
        exact: false,
        quantization: { ignore: false, rescore: true, oversampling: 2.0 }
      },
      with_payload: true,
      with_vector: false
    });
    expect(body.score_threshold).toBeUndefined();
  });

  it("maps hits to {id: payload.pc_id, score, metadata minus pc_id/ns} and skip-counts missing pc_id", async () => {
    stubFetch({
      json: {
        result: [
          {
            id: "9c0f7ee2-0000-4000-8000-000000000001",
            score: 0.91,
            payload: {
              pc_id: "occ:v3:abc123",
              ns: "socratic-abc",
              symbol: "AAPL",
              doc_type: "10-k",
              receipt_required: false
            }
          },
          { id: "9c0f7ee2-0000-4000-8000-000000000002", score: 0.88, payload: { symbol: "MSFT" } },
          { id: "9c0f7ee2-0000-4000-8000-000000000003", score: 0.7, payload: { pc_id: "legacy-id-7", symbol: "NVDA" } }
        ]
      }
    });
    const result = await qdrantQueryTier("socratic-abc", { vector: [0.1], topK: 10 });
    expect(result.skippedMissingPcId).toBe(1);
    expect(result.matches).toEqual([
      {
        id: "occ:v3:abc123",
        score: 0.91,
        metadata: { symbol: "AAPL", doc_type: "10-k", receipt_required: false }
      },
      { id: "legacy-id-7", score: 0.7, metadata: { symbol: "NVDA" } }
    ]);
  });

  it("strips backfilled absent-field sentinels from metadata (but keeps a real receipt_required=false)", async () => {
    stubFetch({
      json: {
        result: [
          {
            id: "9c0f7ee2-0000-4000-8000-000000000004",
            score: 0.8,
            payload: {
              pc_id: "legacy-shared-1",
              ns: "",
              symbol: "AAPL",
              userId: "local",
              // Sentinels stamped by scripts/qdrant/sentinel-backfill.py on points MISSING
              // these fields.  Leaked into metadata they would make
              // filterMatchesForTenantVisibility drop every backfilled legacy vector
              // (tenant_scope "__absent__" is an unrecognized non-null scope -> reject).
              scope: "__absent__",
              tenant_scope: "__absent__",
              as_of_epoch_ms: 0,
              receipt_required: false
            }
          },
          {
            id: "9c0f7ee2-0000-4000-8000-000000000005",
            score: 0.75,
            payload: {
              pc_id: "real-values-1",
              ns: "",
              symbol: "MSFT",
              scope: "shared",
              tenant_scope: "shared:operator",
              as_of_epoch_ms: 1719800000000,
              receipt_required: false
            }
          }
        ]
      }
    });
    const result = await qdrantQueryTier("", { vector: [0.1], topK: 10 });
    expect(result.matches[0].metadata).toEqual({ symbol: "AAPL", userId: "local", receipt_required: false });
    // Real (non-sentinel) values pass through untouched.
    expect(result.matches[1].metadata).toEqual({
      symbol: "MSFT",
      scope: "shared",
      tenant_scope: "shared:operator",
      as_of_epoch_ms: 1719800000000,
      receipt_required: false
    });
  });

  it("queries the default tenant (ns '') for the Pinecone default namespace", async () => {
    const { calls } = stubFetch({ json: { result: [] } });
    await qdrantQueryTier("", { vector: [0.1], topK: 5 });
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.filter.must[0]).toEqual({ key: "ns", match: { value: "" } });
  });

  it("throws on a non-OK response (the caller owns per-tier fail-open)", async () => {
    vi.useFakeTimers();
    try {
      const { fetchMock } = stubFetch({ ok: false, status: 503, text: "service unavailable" });
      const pending = qdrantQueryTier("socratic-abc", { vector: [0.1], topK: 5 });
      const assertion = expect(pending).rejects.toThrow(/HTTP 503/);
      await vi.runAllTimersAsync();
      await assertion;
      expect(fetchMock).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries a transient fetch failed then returns hits", async () => {
    vi.useFakeTimers();
    try {
      process.env.QDRANT_URL = "http://qdrant.example:6333/";
      process.env.QDRANT_API_KEY = "test-key";
      let attempts = 0;
      const fetchMock = vi.fn(async () => {
        attempts += 1;
        if (attempts < 2) throw new TypeError("fetch failed");
        return {
          ok: true,
          status: 200,
          json: async () => ({
            result: [{ id: "x", score: 0.5, payload: { pc_id: "occ:v3:retry-1", symbol: "AAPL" } }]
          }),
          text: async () => ""
        } as unknown as Response;
      });
      vi.stubGlobal("fetch", fetchMock);
      const pending = qdrantQueryTier("", { vector: [0.1], topK: 5 });
      const resultPromise = pending.then((result) => result);
      await vi.runAllTimersAsync();
      const result = await resultPromise;
      expect(attempts).toBe(2);
      expect(result.matches[0].id).toBe("occ:v3:retry-1");
    } finally {
      vi.useRealTimers();
    }
  });

  it("throws on an unimplemented filter operator instead of querying with a widened filter", async () => {
    const { fetchMock } = stubFetch({ json: { result: [] } });
    await expect(
      qdrantQueryTier("socratic-abc", { vector: [0.1], topK: 5, filter: { doc_type: { $nin: ["x"] } } })
    ).rejects.toThrow(/Unsupported operator/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("meterQdrantQuery", () => {
  it("books a rag_usage query row under provider 'qdrant' with zero read units", () => {
    meterQdrantQuery("user-q", 42);
    const row = getDb()
      .prepare(
        `SELECT provider, operation, tokens_in, tokens_out, batch_count
         FROM rag_usage WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`
      )
      .get("user-q") as { provider: string; operation: string; tokens_in: number; tokens_out: number; batch_count: number };
    expect(row).toMatchObject({
      provider: "qdrant",
      operation: "query",
      tokens_in: 0,
      tokens_out: 42,
      batch_count: 42
    });
  });
});
