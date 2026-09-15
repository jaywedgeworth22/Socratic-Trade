import { pinRagQualityFlagsOff } from "./rag-test-env";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const upsert = vi.fn();
  const query = vi.fn();
  const namespacedIndex = { upsert, query };
  const namespace = vi.fn(() => namespacedIndex);
  const index = vi.fn(() => ({ ...namespacedIndex, namespace }));
  const settings = new Map<string, string>();
  const manifests = new Map<string, { ledger_authority: string; provider_authority: string }>();
  const prepare = vi.fn((sql: string) => {
    if (sql.includes("INSERT OR IGNORE INTO settings")) return {
      run: vi.fn((key: string, value: string) => {
        if (!settings.has(key)) settings.set(key, value);
      })
    };
    if (sql.includes("SELECT value FROM settings WHERE key")) return {
      get: vi.fn((key: string) => settings.has(key) ? { value: settings.get(key) } : undefined)
    };
    if (sql.includes("INSERT OR IGNORE INTO vector_private_namespace_manifests")) return {
      run: vi.fn((tenantScope: string, ledgerAuthority: string, providerAuthority: string) => {
        if (!manifests.has(tenantScope)) {
          manifests.set(tenantScope, {
            ledger_authority: ledgerAuthority,
            provider_authority: providerAuthority
          });
        }
      })
    };
    if (sql.includes("FROM vector_private_namespace_manifests WHERE tenant_scope")) return {
      get: vi.fn((tenantScope: string) => manifests.get(tenantScope))
    };
    if (sql.includes("SELECT DISTINCT ledger_authority FROM vector_private_namespace_manifests")) return {
      all: vi.fn(() => [...manifests.values()].map(({ ledger_authority }) => ({ ledger_authority })))
    };
    if (sql.includes("SELECT DISTINCT ledger_authority") || sql.includes("SELECT COUNT(*) FROM vector_ingest_commits")) {
      return { all: vi.fn(() => []), get: vi.fn(() => ({ count: 0 })) };
    }
    return { run: vi.fn(), get: vi.fn(), all: vi.fn(() => []) };
  });
  const database = {
    transaction: vi.fn((work: () => unknown) => ({ immediate: () => work() })),
    prepare
  };
  return {
    upsert,
    query,
    index,
    listIndexes: vi.fn(),
    createIndex: vi.fn(),
    embed: vi.fn(),
    resolveApiKey: vi.fn(),
    namespace,
    settings,
    manifests,
    getDb: vi.fn(() => database)
  };
});

vi.mock("@pinecone-database/pinecone", () => ({
  Pinecone: vi.fn(function Pinecone() {
    return {
    listIndexes: mocks.listIndexes,
    createIndex: mocks.createIndex,
    Index: mocks.index
    };
  })
}));

vi.mock("voyageai", () => ({
  VoyageAIClient: vi.fn(function VoyageAIClient() {
    return { embed: mocks.embed };
  })
}));

vi.mock("../src/lib/db", () => ({
  resolveApiKey: mocks.resolveApiKey,
  audit: vi.fn(),
  setInternalSetting: vi.fn(),
  filterNewDocumentChunks: vi.fn((chunks) => chunks),
  insertDocumentChunks: vi.fn(),
  getDb: mocks.getDb
}));

vi.mock("../src/lib/user-write-fence", () => ({
  assertUserOperationClaim: vi.fn(),
  withUserWriteOperation: vi.fn(async (
    userId: string,
    kind: string,
    work: (claim: { userId: string; key: string; claimId: string; kind: string; epoch: { generation: string; status: "none" } }) => Promise<unknown>
  ) => work({
    userId,
    key: `claim:${userId}`,
    claimId: "test-claim",
    kind,
    epoch: { generation: "none", status: "none" }
  }))
}));

beforeEach(() => {
  pinRagQualityFlagsOff();
  vi.resetModules();
  vi.clearAllMocks();
  mocks.settings.clear();
  mocks.manifests.clear();
  process.env.PINECONE_API_KEY = "pinecone-test";
  process.env.VOYAGE_API_KEY = "voyage-test";
  process.env.PINECONE_INDEX_READY_WAIT_MS = "0";
  process.env.RAG_VECTOR_WRITE_QDRANT = "0";
  delete process.env.QDRANT_URL;
  delete process.env.PINECONE_INDEX_NAME;
  delete process.env.VECTOR_EMBED_BATCH_SIZE;
  delete process.env.VECTOR_EMBED_BATCH_DELAY_MS;
  delete process.env.VECTOR_EMBED_RETRY_ATTEMPTS;
  delete process.env.VECTOR_EMBED_RETRY_DELAY_MS;
  delete process.env.VECTOR_CONTEXT_MAX_CHARS;
  mocks.resolveApiKey.mockImplementation((service: string) => {
    if (service === "pinecone") return process.env.PINECONE_API_KEY;
    if (service === "voyage") return process.env.VOYAGE_API_KEY;
    return undefined;
  });
});

const COMMITTED_RECEIPT_CLAUSE = {
  $or: [
    { receipt_required: { $exists: false } },
    { receipt_required: { $eq: false } },
    { ingest_state: { $eq: "committed" } }
  ]
};

function unwrapCommittedFilter(filter: Record<string, unknown>): Record<string, unknown> {
  expect(Array.isArray(filter.$and)).toBe(true);
  const clauses = filter.$and as Record<string, unknown>[];
  expect(clauses).toHaveLength(2);
  expect(clauses[1]).toEqual(COMMITTED_RECEIPT_CLAUSE);
  return clauses[0]!;
}

describe("vector-db", () => {
  it("batches document embeddings and upserts through one initialized index", async () => {
    mocks.listIndexes.mockResolvedValue({ indexes: [] });
    mocks.createIndex.mockResolvedValue(undefined);
    mocks.embed.mockResolvedValue({ data: [{ embedding: [0.1, 0.2] }, { embedding: [0.3, 0.4] }] });
    const { storeContexts } = await import("../src/lib/vector-db");

    await storeContexts([
      { text: "AAPL 8-K Item 2.02 details", metadata: { symbol: "AAPL", source: "sec-8k", timestamp: "2026-06-18", accession: "a1" } },
      { text: "MSFT 8-K Item 5.02 details", metadata: { symbol: "MSFT", source: "sec-8k", timestamp: "2026-06-18", accession: "m1" } }
    ]);

    expect(mocks.listIndexes).toHaveBeenCalledTimes(1);
    expect(mocks.createIndex).toHaveBeenCalledTimes(1);
    expect(mocks.embed).toHaveBeenCalledWith(expect.objectContaining({
      model: "voyage-finance-2",
      input: [
        "[Published: 2026-06-18] AAPL 8-K Item 2.02 details",
        "[Published: 2026-06-18] MSFT 8-K Item 5.02 details"
      ],
      inputType: "document"
    }));
    // Pinecone SDK v8 takes an options object: index.upsert({ records }).
    const records = mocks.upsert.mock.calls[0][0].records;
    expect(records).toHaveLength(2);
    expect(records[0].metadata).toMatchObject({
      symbol: "AAPL",
      source: "sec-8k",
      text: "[Published: 2026-06-18] AAPL 8-K Item 2.02 details",
      userId: "local"
    });
  });

  it("does not let document metadata spoof reserved tenant or text fields", async () => {
    mocks.listIndexes.mockResolvedValue({ indexes: [{ name: "socratic-trade" }] });
    mocks.embed.mockResolvedValue({ data: [{ embedding: [0.1, 0.2] }] });
    const { storeContexts } = await import("../src/lib/vector-db");

    await storeContexts([
      {
        text: "Private AAPL context",
        metadata: {
          symbol: "AAPL",
          source: "notes",
          timestamp: "2026-06-20",
          userId: "attacker",
          text: "spoofed body"
        }
      }
    ], "user-1");

    const records = mocks.upsert.mock.calls[0][0].records;
    expect(records[0].metadata).toMatchObject({
      symbol: "AAPL",
      source: "notes",
      text: "[Published: 2026-06-20] Private AAPL context",
      userId: "user-1"
    });
  });

  // 2026-07-04 RAG quick-wins: embedding-model / representation version tag on vectors. A mixed
  // population (pre-tag legacy vectors vs post-tag) can now be detected/filtered/migrated, and the
  // stamped fields are NOT spoofable via a caller-supplied metadata key of the same name.
  it("stamps every new vector with embed_model + embed_rev, and a caller cannot override them", async () => {
    mocks.listIndexes.mockResolvedValue({ indexes: [{ name: "socratic-trade" }] });
    mocks.embed.mockResolvedValue({ data: [{ embedding: [0.1, 0.2] }] });
    const { storeContexts } = await import("../src/lib/vector-db");

    await storeContexts([
      {
        text: "AAPL context",
        metadata: {
          symbol: "AAPL",
          source: "sec-8k",
          timestamp: "2026-06-18",
          embed_model: "spoofed-model",
          embed_rev: 999
        }
      }
    ]);

    const records = mocks.upsert.mock.calls[0][0].records;
    expect(records[0].metadata.embed_model).toBe("voyage-finance-2");
    expect(records[0].metadata.embed_rev).toBe(1);
  });

  // Item 6 (2026-07-01 RAG workstream): doc_type is now normalized to lowercase AT WRITE TIME
  // (cleanMetadata) regardless of what casing the caller passes in — some ingesters historically
  // passed "10-K"/"10-Q" (upper), others "8-k" (lower). buildExtraFilters still expands both
  // casings at query time so pre-existing mixed-case vectors stay matchable (see
  // test/vector-db-retrieval.test.ts "matches doc_type across casings").
  it("normalizes doc_type to lowercase at write time regardless of caller casing", async () => {
    mocks.listIndexes.mockResolvedValue({ indexes: [{ name: "socratic-trade" }] });
    mocks.embed.mockResolvedValue({ data: [{ embedding: [0.1, 0.2] }, { embedding: [0.3, 0.4] }] });
    const { storeContexts } = await import("../src/lib/vector-db");

    await storeContexts([
      { text: "AAPL 10-K body", metadata: { symbol: "AAPL", source: "sec-edgar", timestamp: "2026-06-20", doc_type: "10-K" } },
      { text: "AAPL 8-K catalyst", metadata: { symbol: "AAPL", source: "sec-8k", timestamp: "2026-06-20", doc_type: "8-k" } }
    ]);

    const records = mocks.upsert.mock.calls[0][0].records;
    expect(records[0].metadata.doc_type).toBe("10-k");
    expect(records[1].metadata.doc_type).toBe("8-k"); // already-lowercase input is unaffected
  });

  it("leaves other metadata fields' casing untouched (only doc_type is normalized)", async () => {
    mocks.listIndexes.mockResolvedValue({ indexes: [{ name: "socratic-trade" }] });
    mocks.embed.mockResolvedValue({ data: [{ embedding: [0.1, 0.2] }] });
    const { storeContexts } = await import("../src/lib/vector-db");

    await storeContexts([
      { text: "AAPL 10-K body", metadata: { symbol: "AAPL", source: "SEC-EDGAR", timestamp: "2026-06-20", doc_type: "10-K", section: "Risk Factors" } }
    ]);

    const records = mocks.upsert.mock.calls[0][0].records;
    expect(records[0].metadata.doc_type).toBe("10-k");
    expect(records[0].metadata.source).toBe("SEC-EDGAR"); // unrelated field: casing untouched
    expect(records[0].metadata.section).toBe("Risk Factors"); // unrelated field: casing untouched
  });

  it("honors the configured embedding batch size", async () => {
    process.env.VECTOR_EMBED_BATCH_SIZE = "1";
    process.env.VECTOR_EMBED_BATCH_DELAY_MS = "0";
    mocks.listIndexes.mockResolvedValue({ indexes: [{ name: "socratic-trade" }] });
    mocks.embed.mockResolvedValue({ data: [{ embedding: [0.1, 0.2] }] });
    const { storeContexts } = await import("../src/lib/vector-db");

    await storeContexts([
      { text: "AAPL context", metadata: { symbol: "AAPL", source: "sec-8k", timestamp: "2026-06-18", accession: "a1" } },
      { text: "MSFT context", metadata: { symbol: "MSFT", source: "sec-8k", timestamp: "2026-06-18", accession: "m1" } }
    ]);

    expect(mocks.embed).toHaveBeenCalledTimes(2);
    expect(mocks.embed.mock.calls[0][0]).toMatchObject({ input: ["[Published: 2026-06-18] AAPL context"], inputType: "document" });
    expect(mocks.embed.mock.calls[1][0]).toMatchObject({ input: ["[Published: 2026-06-18] MSFT context"], inputType: "document" });
  });

  it("retries Voyage 429s before giving up on a batch", async () => {
    process.env.VECTOR_EMBED_RETRY_ATTEMPTS = "1";
    process.env.VECTOR_EMBED_RETRY_DELAY_MS = "0";
    process.env.VECTOR_EMBED_BATCH_DELAY_MS = "0";
    mocks.listIndexes.mockResolvedValue({ indexes: [{ name: "socratic-trade" }] });
    mocks.embed
      .mockRejectedValueOnce(Object.assign(new Error("Status code: 429 Rate Limit Exceeded"), { status: 429 }))
      .mockResolvedValueOnce({ data: [{ embedding: [0.1, 0.2] }] });
    const { storeContexts } = await import("../src/lib/vector-db");

    await storeContexts([
      { text: "AAPL context", metadata: { symbol: "AAPL", source: "sec-8k", timestamp: "2026-06-18", accession: "a1" } }
    ]);

    expect(mocks.embed).toHaveBeenCalledTimes(2);
    expect(mocks.upsert).toHaveBeenCalledTimes(1);
  });

  it("shares index initialization across concurrent single-document stores", async () => {
    mocks.listIndexes.mockResolvedValue({ indexes: [] });
    mocks.createIndex.mockResolvedValue(undefined);
    mocks.embed.mockResolvedValue({ data: [{ embedding: [0.1, 0.2] }] });
    const { storeContext } = await import("../src/lib/vector-db");

    await Promise.all([
      storeContext("AAPL context", { symbol: "AAPL", source: "sec-8k", timestamp: "2026-06-18", accession: "a1" }),
      storeContext("MSFT context", { symbol: "MSFT", source: "sec-8k", timestamp: "2026-06-18", accession: "m1" })
    ]);

    expect(mocks.listIndexes).toHaveBeenCalledTimes(1);
    expect(mocks.createIndex).toHaveBeenCalledTimes(1);
  });

  it("retrieves matching text with query embeddings and tenant-safe public/user filters", async () => {
    mocks.listIndexes.mockResolvedValue({ indexes: [{ name: "socratic-trade" }] });
    mocks.embed.mockResolvedValue({ data: [{ embedding: [0.1, 0.2] }] });
    mocks.query
      .mockResolvedValueOnce({
        matches: [{ metadata: { text: "AAPL retrieved filing context", userId: "user-1", scope: "private" } }]
      })
      .mockResolvedValueOnce({ matches: [] });
    const { retrieveContext } = await import("../src/lib/vector-db");

    const results = await retrieveContext("AAPL catalysts", "AAPL", 2, "user-1");

    expect(results).toEqual(["AAPL retrieved filing context"]);
    expect(mocks.embed).toHaveBeenCalledWith(expect.objectContaining({ input: ["AAPL catalysts"], inputType: "query" }));
    // No durable private-namespace manifest exists in this fixture, so retrieval uses only
    // the default-index private and shared tiers. Querying an unproven namespace would add
    // latency and could surface rows from a stale provider authority.
    expect(mocks.query).toHaveBeenCalledTimes(2);
    expect(mocks.query.mock.calls[0][0]).toMatchObject({
      // This fixture has no configured OpenRouter/SiliconFlow rerank authority, so retrieval keeps
      // the dense path at the requested limit instead of silently borrowing the test Voyage embed
      // client. The filter is the tenant-isolation contract under test.
      topK: 2,
      includeMetadata: true
    });
    const privateFilter = unwrapCommittedFilter(mocks.query.mock.calls[0][0].filter);
    expect(privateFilter).toMatchObject({
      symbol: { $eq: "AAPL" },
      userId: { $eq: "user-1" }
    });
    expect(privateFilter.$or).toEqual(expect.arrayContaining([
      expect.objectContaining({ tenant_scope: expect.any(Object) }),
      { $and: [{ tenant_scope: { $exists: false } }, { scope: { $eq: "private" } }] },
      { $and: [{ tenant_scope: { $exists: false } }, { scope: { $exists: false } }] }
    ]));
    // Legacy local vectors are public only when they lack an explicit scope.
    const sharedFilter = unwrapCommittedFilter(mocks.query.mock.calls[1][0].filter);
    expect(sharedFilter.symbol).toEqual({ $eq: "AAPL" });
    expect(sharedFilter.$or).toEqual(
      expect.arrayContaining([
        { scope: { $eq: "shared" } },
        {
          $and: [
            { userId: { $eq: "local" } },
            { scope: { $exists: false } }
          ]
        }
      ])
    );
  });

  it("sanitizes user IDs correctly", async () => {
    const { sanitizeUserId } = await import("../src/lib/vector-db");
    expect(sanitizeUserId("user; DROP TABLE users;")).toBe("userDROPTABLEusers");
    expect(sanitizeUserId("test-user_123.dots@domain.com")).toBe("test-user_123.dots@domain.com");
    expect(sanitizeUserId("a".repeat(150))).toBe("a".repeat(100));
    expect(sanitizeUserId("")).toBe("local");
    expect(sanitizeUserId(undefined)).toBe("local");
    expect(sanitizeUserId("!!!")).toBe("local");
  });

  it("uses raw user IDs for key lookup and sanitized user IDs for Pinecone filters", async () => {
    mocks.listIndexes.mockResolvedValue({ indexes: [{ name: "socratic-trade" }] });
    mocks.embed.mockResolvedValue({ data: [{ embedding: [0.1, 0.2] }] });
    mocks.query.mockResolvedValue({ matches: [] });
    const { retrieveContext } = await import("../src/lib/vector-db");

    await retrieveContext("query", "AAPL", 2, "auth0|user 1");

    expect(mocks.resolveApiKey).toHaveBeenCalledWith("pinecone", "auth0|user 1");
    expect(mocks.resolveApiKey).toHaveBeenCalledWith("voyage", "auth0|user 1");
    expect(unwrapCommittedFilter(mocks.query.mock.calls[0][0].filter).userId).toEqual({ $eq: "auth0user1" });
  });

  it("applies deduplication, score sorting, and slicing in retrieveContext", async () => {
    mocks.listIndexes.mockResolvedValue({ indexes: [{ name: "socratic-trade" }] });
    mocks.embed.mockResolvedValue({ data: [{ embedding: [0.1, 0.2] }] });
    
    // First query returns records with IDs and scores
    mocks.query.mockResolvedValueOnce({
      matches: [
        { id: "doc-1", score: 0.9, metadata: { text: "High score user doc", userId: "user-1", scope: "private" } },
        { id: "doc-2", score: 0.7, metadata: { text: "Medium score user doc", userId: "user-1", scope: "private" } }
      ]
    });
    // Second query (public "local") returns overlapping ID with lower score, and a new public doc
    mocks.query.mockResolvedValueOnce({
      matches: [
        { id: "doc-1", score: 0.8, metadata: { text: "High score user doc duplicate", userId: "local", scope: "shared" } },
        { id: "doc-3", score: 0.95, metadata: { text: "Very high score public doc", userId: "local", scope: "shared" } }
      ]
    });

    const { retrieveContext } = await import("../src/lib/vector-db");
    const results = await retrieveContext("query", "AAPL", 2, "user-1");

    // Total top 2 should be doc-3 (0.95) and doc-1 (0.9, deduplicated)
    expect(results).toEqual(["Very high score public doc", "High score user doc"]);
  });

  it("Voyage Backoff Jitter Test: verifies exponential backoff with full jitter is distributed", async () => {
    const { retryAfterMs } = await import("../src/lib/vector-db");
    process.env.VECTOR_EMBED_RETRY_DELAY_MS = "20000";
    process.env.VECTOR_EMBED_BATCH_DELAY_MS = "0";

    const error = new Error("429 Rate Limit");
    const sampleSize = 100;
    const delays: number[] = [];

    for (let i = 0; i < sampleSize; i++) {
      delays.push(retryAfterMs(error, 2));
    }

    // attempt = 2, baseDelay = 20s => max backoff = min(60s, 20s * 2^2) = 60s = 60,000ms
    // delay should be between 0 and 60,000.
    const minDelay = Math.min(...delays);
    const maxDelay = Math.max(...delays);

    expect(minDelay).toBeGreaterThanOrEqual(0);
    expect(maxDelay).toBeLessThanOrEqual(60000);
    
    // Check that we have a wide distribution (at least 20 seconds difference between min and max)
    expect(maxDelay - minDelay).toBeGreaterThan(20000);
  });

  it("honors Retry-After header from HttpProviderError", async () => {
    const { HttpProviderError, retryAfterMs } = await import("../src/lib/vector-db");
    const headers = new Headers();
    headers.set("retry-after", "15");
    const error = new HttpProviderError("Rate limited", 429, headers);

    const delay = retryAfterMs(error, 0);
    expect(delay).toBe(15_000);
  });

  it("prepends publication date for string, number, and Date object timestamps", async () => {
    mocks.listIndexes.mockResolvedValue({ indexes: [{ name: "socratic-trade" }] });
    mocks.embed.mockResolvedValue({ data: [{ embedding: [0.1, 0.2] }] });
    const { storeContexts } = await import("../src/lib/vector-db");

    // Test ISO string
    await storeContexts([
      { text: "AAPL document", metadata: { symbol: "AAPL", source: "sec-8k", timestamp: "2026-06-20T18:00:16Z" } }
    ]);
    expect(mocks.embed.mock.calls[mocks.embed.mock.calls.length - 1][0].input[0]).toBe("[Published: 2026-06-20] AAPL document");

    // Test Epoch Milliseconds Number
    const epochTime = new Date("2026-06-19T12:00:00Z").getTime();
    await storeContexts([
      { text: "AAPL document 2", metadata: { symbol: "AAPL", source: "sec-8k", timestamp: epochTime as any } }
    ]);
    expect(mocks.embed.mock.calls[mocks.embed.mock.calls.length - 1][0].input[0]).toBe("[Published: 2026-06-19] AAPL document 2");

    // Test Date Object
    const dateObj = new Date("2026-06-18T00:00:00Z");
    await storeContexts([
      { text: "AAPL document 3", metadata: { symbol: "AAPL", source: "sec-8k", timestamp: dateObj as any } }
    ]);
    expect(mocks.embed.mock.calls[mocks.embed.mock.calls.length - 1][0].input[0]).toBe("[Published: 2026-06-18] AAPL document 3");
  });

  it("sanitizeVectorId replaces non-ASCII and special characters with underscores and slices to 512 chars", async () => {
    const { sanitizeVectorId } = await import("../src/lib/vector-db");
    const input = "v1:CB:0000896159-26-000011:10-Q:1:CB 10-Q (2026-04-28):ITEM\xa03. Quantitative and Qualitative Disclosures about Market Risk:88:v1:v1";
    const sanitized = sanitizeVectorId(input);
    expect(sanitized).toBe("v1:CB:0000896159-26-000011:10-Q:1:CB_10-Q__2026-04-28_:ITEM_3._Quantitative_and_Qualitative_Disclosures_about_Market_Risk:88:v1:v1");
    
    // Check that long string is truncated to 512
    const longInput = "a".repeat(600);
    expect(sanitizeVectorId(longInput).length).toBe(512);
  });
});
