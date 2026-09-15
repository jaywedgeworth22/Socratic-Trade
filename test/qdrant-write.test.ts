/**
 * STAGE-2 Qdrant write backend (src/lib/vector-store/qdrant-write.ts):
 *   - backend knob resolution: default qdrant when QDRANT_URL is set; DB override > env boolean >
 *     env string; unconfigured stays on pinecone
 *   - uuid5 point-id scheme matching scripts/qdrant/pinecone-to-qdrant-copy.py
 *   - upsert payload keeps pc_id + ns
 *   - delete-by-ids uses ns + pc_id filter (never Pinecone health wrap)
 *   - meterQdrantUpsert books provider "qdrant" with zero write units
 *
 * HTTP is mocked (vi.stubGlobal fetch) — no live network.  DB uses the temp-SQLite pattern.
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-qdrant-write-${randomUUID()}.db`)}`;
});

import {
  QDRANT_WRITE_KNOB_ID,
  meterQdrantUpsert,
  qdrantCollectionInfo,
  qdrantDeleteByFilter,
  qdrantDeleteByIds,
  qdrantInventoryByMetadata,
  qdrantPayloadForRecord,
  qdrantPointId,
  qdrantProviderAuthority,
  qdrantSetPayload,
  qdrantUpsertPoints,
  vectorWriteBackend
} from "../src/lib/vector-store/qdrant-write";
import { qdrantConfigured } from "../src/lib/vector-store/qdrant-read";
import { invalidateServerKnobCache, serverKnobById, setServerKnobOverride } from "../src/lib/server-knobs";
import { getDb } from "../src/lib/db";

const KNOB_ENV_VARS = [
  QDRANT_WRITE_KNOB_ID,
  "RAG_VECTOR_WRITE_BACKEND",
  "QDRANT_URL",
  "QDRANT_API_KEY",
  "QDRANT_COLLECTION",
  "QDRANT_WRITE_TIMEOUT_MS",
  "QDRANT_QUERY_TIMEOUT_MS",
  "QDRANT_ALLOW_ANONYMOUS"
];

beforeEach(() => {
  for (const name of KNOB_ENV_VARS) delete process.env[name];
  setServerKnobOverride(QDRANT_WRITE_KNOB_ID, null);
  invalidateServerKnobCache();
});

afterEach(() => {
  for (const name of KNOB_ENV_VARS) delete process.env[name];
  setServerKnobOverride(QDRANT_WRITE_KNOB_ID, null);
  invalidateServerKnobCache();
  vi.unstubAllGlobals();
});

describe("backend knob resolution", () => {
  it("is a catalogued server knob (runtime-flippable without redeploy)", () => {
    const spec = serverKnobById(QDRANT_WRITE_KNOB_ID);
    expect(spec?.type).toBe("boolean");
    expect(spec?.defaultValue).toBe(true);
  });

  it("defaults to qdrant when QDRANT_URL is set, falls back to pinecone when unconfigured", () => {
    expect(vectorWriteBackend()).toBe("pinecone");
    process.env.QDRANT_URL = "http://qdrant.example:6333";
    expect(vectorWriteBackend()).toBe("qdrant");
  });

  it("boolean env turns qdrant on (with QDRANT_URL) and explicit falsy keeps pinecone", () => {
    process.env.QDRANT_URL = "http://qdrant.example:6333";
    process.env[QDRANT_WRITE_KNOB_ID] = "1";
    expect(vectorWriteBackend()).toBe("qdrant");
    process.env[QDRANT_WRITE_KNOB_ID] = "off";
    expect(vectorWriteBackend()).toBe("pinecone");
  });

  it("string env RAG_VECTOR_WRITE_BACKEND=qdrant|pinecone is honored when the boolean is unset", () => {
    process.env.QDRANT_URL = "http://qdrant.example:6333";
    process.env.RAG_VECTOR_WRITE_BACKEND = "qdrant";
    expect(vectorWriteBackend()).toBe("qdrant");
    process.env.RAG_VECTOR_WRITE_BACKEND = "pinecone";
    expect(vectorWriteBackend()).toBe("pinecone");
    process.env.RAG_VECTOR_WRITE_BACKEND = "qdrant";
    process.env[QDRANT_WRITE_KNOB_ID] = "0";
    expect(vectorWriteBackend()).toBe("pinecone");
  });

  it("DB override beats env in both directions", () => {
    process.env.QDRANT_URL = "http://qdrant.example:6333";
    process.env[QDRANT_WRITE_KNOB_ID] = "1";
    setServerKnobOverride(QDRANT_WRITE_KNOB_ID, false);
    expect(vectorWriteBackend()).toBe("pinecone");
    setServerKnobOverride(QDRANT_WRITE_KNOB_ID, true);
    expect(vectorWriteBackend()).toBe("qdrant");
    setServerKnobOverride(QDRANT_WRITE_KNOB_ID, null);
    expect(vectorWriteBackend()).toBe("qdrant");
  });

  it("qdrant selection requires QDRANT_URL — knob on without it stays on pinecone", () => {
    process.env[QDRANT_WRITE_KNOB_ID] = "true";
    expect(qdrantConfigured()).toBe(false);
    expect(vectorWriteBackend()).toBe("pinecone");
  });
});

describe("uuid5 point id scheme", () => {
  it("matches Python uuid.uuid5(NAMESPACE_URL, 'st:' + ns + ':' + pc_id)", () => {
    expect(qdrantPointId("", "occ:v3:abc")).toBe("7bdd2e12-ffba-5970-b57e-75794a8ec662");
    expect(qdrantPointId("socratic-abc", "sec-filings:AAPL:10-k:chunk-1")).toBe(
      "49a1f52d-68c2-5e42-95d9-4e8c5a8baff6"
    );
  });

  it("treats undefined/null namespace as the empty-string default tenant", () => {
    expect(qdrantPointId(undefined, "occ:v3:abc")).toBe(qdrantPointId("", "occ:v3:abc"));
    expect(qdrantPointId(null, "occ:v3:abc")).toBe(qdrantPointId("", "occ:v3:abc"));
  });
});

describe("payload pc_id/ns", () => {
  it("stamps pc_id and ns and ignores caller spoofing of those keys", () => {
    const payload = qdrantPayloadForRecord("socratic-abc", {
      id: "occ:v3:abc",
      values: [0.1, 0.2],
      metadata: {
        symbol: "AAPL",
        pc_id: "spoofed",
        ns: "attacker",
        ticker: ["AAPL"]
      }
    });
    expect(payload.pc_id).toBe("occ:v3:abc");
    expect(payload.ns).toBe("socratic-abc");
    expect(payload.symbol).toBe("AAPL");
    expect(payload.ticker).toEqual(["AAPL"]);
  });
});

function stubFetch(response: { ok?: boolean; status?: number; json?: unknown; text?: string }) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return {
      ok: response.ok ?? true,
      status: response.status ?? 200,
      json: async () => response.json ?? { result: {} },
      text: async () => response.text ?? ""
    } as unknown as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, calls };
}

describe("qdrantUpsertPoints", () => {
  beforeEach(() => {
    process.env.QDRANT_URL = "http://qdrant.example:6333/";
    process.env.QDRANT_API_KEY = "test-key";
  });

  it("PUTs /points?wait=true with uuid5 ids and payload pc_id/ns", async () => {
    const { calls } = stubFetch({ json: { result: { status: "ok" } } });
    await qdrantUpsertPoints({
      namespace: "socratic-abc",
      records: [
        {
          id: "occ:v3:abc",
          values: [0.1, 0.2],
          metadata: { symbol: "AAPL", source: "sec-edgar" }
        }
      ]
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://qdrant.example:6333/collections/socratic-trade/points?wait=true");
    expect(calls[0].init.method).toBe("PUT");
    expect((calls[0].init.headers as Record<string, string>)["api-key"]).toBe("test-key");
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.points).toHaveLength(1);
    expect(body.points[0].id).toBe(qdrantPointId("socratic-abc", "occ:v3:abc"));
    expect(body.points[0].vector).toEqual([0.1, 0.2]);
    expect(body.points[0].payload).toMatchObject({
      pc_id: "occ:v3:abc",
      ns: "socratic-abc",
      symbol: "AAPL",
      source: "sec-edgar"
    });
  });
});

describe("qdrantDeleteByIds / qdrantDeleteByFilter", () => {
  beforeEach(() => {
    process.env.QDRANT_URL = "http://qdrant.example:6333";
    process.env.QDRANT_API_KEY = "test-key";
  });

  it("deletes by ns + pc_id filter, not by wrapping Pinecone health", async () => {
    const { calls } = stubFetch({ json: { result: { status: "ok" } } });
    await qdrantDeleteByIds({ namespace: "socratic-abc", ids: ["occ:v3:abc", "occ:v3:def"] });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("/points/delete?wait=true");
    expect(calls[0].init.method).toBe("POST");
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.filter).toEqual({
      must: [
        { key: "ns", match: { value: "socratic-abc" } },
        { key: "pc_id", match: { any: ["occ:v3:abc", "occ:v3:def"] } }
      ]
    });
  });

  it("translates a Pinecone metadata filter for namespace delete", async () => {
    const { calls } = stubFetch({ json: { result: { status: "ok" } } });
    await qdrantDeleteByFilter({
      namespace: "",
      filter: { tenant_scope: { $eq: "private:user-1" } }
    });
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.filter.must[0]).toEqual({ key: "ns", match: { value: "" } });
    expect(body.filter.must[1]).toEqual({ key: "tenant_scope", match: { value: "private:user-1" } });
  });
});

describe("qdrant inventory / payload / collection info", () => {
  beforeEach(() => {
    process.env.QDRANT_URL = "http://qdrant.example:6333";
    process.env.QDRANT_API_KEY = "test-key";
  });

  it("scrolls with tenant filter and returns pc_id as the inventory id", async () => {
    const { calls } = stubFetch({
      json: {
        result: {
          points: [
            {
              id: qdrantPointId("socratic-abc", "occ:v3:abc"),
              payload: { pc_id: "occ:v3:abc", ns: "socratic-abc", symbol: "AAPL" }
            }
          ],
          next_page_offset: null
        }
      }
    });
    const rows = await qdrantInventoryByMetadata({ namespace: "socratic-abc", prefix: "occ:v3:" });
    expect(calls[0].url).toContain("/points/scroll");
    expect(rows).toEqual([{ id: "occ:v3:abc", metadata: { symbol: "AAPL" } }]);
  });

  it("sets payload on uuid5 point ids", async () => {
    const { calls } = stubFetch({ json: { result: { status: "ok" } } });
    await qdrantSetPayload({
      namespace: "socratic-abc",
      ids: ["occ:v3:abc"],
      payload: { ingest_state: "committed" }
    });
    expect(calls[0].url).toContain("/points/payload?wait=true");
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.points).toEqual([qdrantPointId("socratic-abc", "occ:v3:abc")]);
    expect(body.payload).toEqual({ ingest_state: "committed" });
  });

  it("reads collection points_count from GET /collections/{name}", async () => {
    stubFetch({
      json: {
        result: {
          status: "green",
          points_count: 801239,
          config: { params: { vectors: { size: 1024 } } }
        }
      }
    });
    const info = await qdrantCollectionInfo();
    expect(info).toMatchObject({
      exists: true,
      collection: "socratic-trade",
      pointsCount: 801239,
      dimension: 1024
    });
  });
});

describe("meterQdrantUpsert", () => {
  it("books a rag_usage upsert row under provider 'qdrant' with zero write units", () => {
    meterQdrantUpsert(7, "user-w");
    const row = getDb()
      .prepare(
        `SELECT provider, operation, tokens_in, tokens_out, batch_count
         FROM rag_usage WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`
      )
      .get("user-w") as { provider: string; operation: string; tokens_in: number; tokens_out: number; batch_count: number };
    expect(row).toMatchObject({
      provider: "qdrant",
      operation: "upsert",
      tokens_in: 0,
      tokens_out: 7,
      batch_count: 7
    });
  });
});

describe("qdrantProviderAuthority", () => {
  it("is a stable hex digest of the collection name", () => {
    const a = qdrantProviderAuthority();
    const b = qdrantProviderAuthority();
    expect(a).toMatch(/^[a-f0-9]{64}$/);
    expect(a).toBe(b);
  });
});

// Production evidence (litestream-runtime.log, 2026-08-29..2026-09-07): 92 "[vector-db] Error
// storing contexts: TypeError: fetch failed" events on the RAG write path since the 2026-09-01
// Qdrant write cutover. Every write in this module is idempotent by construction (deterministic
// uuid5 point ids, ns+pc_id-filtered deletes), so a whole-request retry on a transient network
// blip is safe. These tests pin that retry and its two boundaries: a caller abort/timeout is
// never retried, and a non-retryable 4xx (e.g. a real validation error) fails immediately.
describe("qdrantUpsertPoints — retry on a transient network failure", () => {
  beforeEach(() => {
    process.env.QDRANT_URL = "http://qdrant.example:6333";
    process.env.QDRANT_API_KEY = "test-key";
  });

  it("retries a dead-socket TypeError and succeeds on the fresh connection", async () => {
    let attempt = 0;
    const fetchMock = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) throw new TypeError("fetch failed");
      return {
        ok: true,
        status: 200,
        json: async () => ({ result: { status: "ok" } }),
        text: async () => ""
      } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await qdrantUpsertPoints({
      namespace: "socratic-abc",
      records: [{ id: "occ:v3:abc", values: [0.1, 0.2] }]
    });

    expect(attempt).toBe(2);
    expect(result.upserted).toBe(1);
  });

  it("retries a transient Qdrant 5xx response", async () => {
    let attempt = 0;
    const fetchMock = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) {
        return { ok: false, status: 503, json: async () => ({}), text: async () => "temporarily unavailable" } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => ({ result: { status: "ok" } }), text: async () => "" } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await qdrantUpsertPoints({
      namespace: "socratic-abc",
      records: [{ id: "occ:v3:abc", values: [0.1, 0.2] }]
    });

    expect(attempt).toBe(2);
    expect(result.upserted).toBe(1);
  });

  it("gives up after exhausting attempts on a sustained network failure", async () => {
    let attempt = 0;
    const fetchMock = vi.fn(async () => {
      attempt += 1;
      throw new TypeError("fetch failed");
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      qdrantUpsertPoints({ namespace: "socratic-abc", records: [{ id: "occ:v3:abc", values: [0.1, 0.2] }] })
    ).rejects.toThrow(/fetch failed/);
    expect(attempt).toBe(3); // bounded — never retries forever
  });

  it("does NOT retry a caller-side abort/timeout", async () => {
    let attempt = 0;
    const fetchMock = vi.fn(async () => {
      attempt += 1;
      const err = new Error("The operation was aborted");
      err.name = "AbortError";
      throw err;
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      qdrantUpsertPoints({ namespace: "socratic-abc", records: [{ id: "occ:v3:abc", values: [0.1, 0.2] }] })
    ).rejects.toThrow();
    expect(attempt).toBe(1);
  });

  it("does NOT retry a non-retryable 4xx validation failure", async () => {
    let attempt = 0;
    const fetchMock = vi.fn(async () => {
      attempt += 1;
      return { ok: false, status: 400, json: async () => ({}), text: async () => "bad request" } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      qdrantUpsertPoints({ namespace: "socratic-abc", records: [{ id: "occ:v3:abc", values: [0.1, 0.2] }] })
    ).rejects.toThrow(/HTTP 400/);
    expect(attempt).toBe(1);
  });
});

describe("Qdrant spend fuses and storage breakers", () => {
  it("refuses upsert when daily point budget is exceeded", async () => {
    process.env.QDRANT_URL = "http://qdrant.example:6333";
    process.env.RAG_MAX_DAILY_INGEST_POINTS = "5";

    meterQdrantUpsert(5, "local");

    await expect(
      qdrantUpsertPoints({ namespace: "test", records: [{ id: "p1", values: [0.1] }] })
    ).rejects.toThrow(/Daily vector point ingestion budget exceeded/);

    delete process.env.RAG_MAX_DAILY_INGEST_POINTS;
  });

  it("refuses upsert when collection capacity limit is reached", async () => {
    process.env.QDRANT_URL = "http://qdrant.example:6333";
    process.env.QDRANT_MAX_POINTS = "100";

    vi.stubGlobal("fetch", async (url: string | URL | Request) => {
      const urlStr = String(url);
      if (urlStr.includes("/collections/") && !urlStr.includes("/points")) {
        return new Response(
          JSON.stringify({
            result: {
              status: "green",
              points_count: 100,
              config: { params: { vectors: { size: 1024, distance: "Cosine" } } }
            }
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(JSON.stringify({ result: { status: "ok" } }), { status: 200 });
    });

    await expect(
      qdrantUpsertPoints({ namespace: "test", records: [{ id: "p1", values: [0.1] }] })
    ).rejects.toThrow(/Qdrant collection point capacity exceeded/);

    delete process.env.QDRANT_MAX_POINTS;
  });
});

