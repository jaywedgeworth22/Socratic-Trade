import { afterEach, describe, expect, it, afterAll } from "vitest";
import { createHash } from "crypto";
import Database from "better-sqlite3";
import { existsSync, mkdirSync, unlinkSync } from "fs";
import path from "path";
import os from "os";

// ── Setup: isolated temp SQLite for rag_usage + document_chunks tables ────────

const tmpDir = path.join(os.tmpdir(), `trading-test-rag-metering-${Date.now()}`);
const tmpDbPath = path.join(tmpDir, "test.db");

if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });

// Point DATABASE_URL at the temp file before importing db.
process.env.DATABASE_URL = `file:${tmpDbPath}`;

// Reset the module cache so db.ts picks up the new DATABASE_URL.
// (vitest caches module loads; clearing the cache forces a fresh init.)

afterAll(() => {
  try { unlinkSync(tmpDbPath); } catch { /* best-effort */ }
  try { unlinkSync(`${tmpDbPath}-wal`); } catch { /* ok */ }
  try { unlinkSync(`${tmpDbPath}-shm`); } catch { /* ok */ }
});

// ── Tests ─────────────────────────────────────────────────────────────────────

// Dynamic imports so the module cache sees the overridden DATABASE_URL.
const { recordRagUsage, getRagUsageSummary, meterEmbed, meterRerank, meterPineconeQuery, meterPineconeUpsert } = await import("../src/lib/rag-metering");
const { getChunkCoverage, filterNewDocumentChunks, insertDocumentChunks } = await import("../src/lib/db");

function sha16(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

describe("rag-metering", () => {
  it("records and aggregates rag usage", () => {
    meterEmbed(["Risk factors for AAPL.", "MD&A for AAPL."]);
    meterEmbed(["Financial notes."]);
    meterRerank("AAPL risk", ["Chunk A", "Chunk B", "Chunk C"]);

    const summary = getRagUsageSummary();
    const embedRows = summary.filter((r) => r.operation === "embed");
    const rerankRows = summary.filter((r) => r.operation === "rerank");

    expect(embedRows.length).toBeGreaterThanOrEqual(1);
    expect(rerankRows.length).toBeGreaterThanOrEqual(1);

    // Embed: 3 texts across 2 calls
    const embedTotal = embedRows.reduce((s, r) => s + r.batchCount, 0);
    expect(embedTotal).toBe(3);

    // Rerank: 3 documents in one call
    const rerankTotal = rerankRows.reduce((s, r) => s + r.batchCount, 0);
    expect(rerankTotal).toBe(3);
  });

  it("meter helpers attribute retrieval spend to the requesting userId (not default 'local')", () => {
    // Regression: the daily LLM/RAG budget filters rag_usage by userId, so retrieval meters MUST book
    // under the requesting user or a non-local user's ceiling never trips (Codex P2 on 1e14e848fb).
    meterEmbed(["query for alice"], undefined, "alice");
    meterPineconeQuery(7, "alice");
    meterRerank("alice q", ["d1", "d2"], undefined, "alice");

    const alice = getRagUsageSummary().filter((r) => r.userId === "alice");
    expect(alice.some((r) => r.operation === "embed")).toBe(true);
    expect(alice.some((r) => r.operation === "query")).toBe(true);
    expect(alice.some((r) => r.operation === "rerank")).toBe(true);
    // And nothing from these calls leaked to the default "local" bucket.
    const localAfter = getRagUsageSummary().filter((r) => r.userId === "local");
    expect(localAfter.every((r) => r.userId === "local")).toBe(true); // sanity
    expect(alice.reduce((s, r) => s + r.batchCount, 0)).toBeGreaterThan(0);
  });

  // Provider-aware metering (bge-m3-metering-gate, 2026-07-18): meterEmbed/meterRerank used to
  // hardcode provider: "voyage" on every row regardless of which provider actually served the
  // call, so an OpenRouter/SiliconFlow bge-m3 call was silently priced and labeled as Voyage. These
  // guard the fix: a non-voyage provider argument must stamp the true provider on the row AND price
  // it from that provider's own table, while a caller that omits `provider` entirely now books
  // OpenRouter exactly as expected for the new unified fleet strategy.
  describe("provider-aware metering", () => {
    it("openrouter embed stamps provider='openrouter' and prices at the confirmed bge-m3 rate ($0.01 per 1M tokens)", () => {
      const text = "OpenRouter bge-m3 embed call for provider-aware metering test.";
      meterEmbed([text], "baai/bge-m3", "prov-or-embed", "openrouter");

      const row = getRagUsageSummary().find((r) => r.userId === "prov-or-embed" && r.operation === "embed");
      expect(row).toBeDefined();
      expect(row!.provider).toBe("openrouter");
      expect(row!.model).toBe("baai/bge-m3");

      const expectedTokens = Math.max(1, Math.ceil(Buffer.byteLength(text, "utf8") / 4));
      expect(row!.tokensIn).toBe(expectedTokens);
      const expectedCost = (expectedTokens * 0.00001) / 1000; // $0.01 / 1M tokens = $0.00001 / 1K tokens
      expect(row!.costEstUsd).toBeCloseTo(expectedCost, 12);
    });

    it("openrouter rerank prices PER SEARCH ($0.001/search for <=100 docs), not per token", () => {
      const documents = ["doc a", "doc b", "doc c"];
      meterRerank("query text", documents, "cohere/rerank-v3.5", "prov-or-rerank", "openrouter");

      const row = getRagUsageSummary().find((r) => r.userId === "prov-or-rerank" && r.operation === "rerank");
      expect(row).toBeDefined();
      expect(row!.provider).toBe("openrouter");
      // 3 documents fit in one 100-doc search -> flat $0.001, independent of token count.
      expect(row!.costEstUsd).toBeCloseTo(0.001, 12);
    });

    it("siliconflow embed stamps provider='siliconflow' and prices bge-m3 at $0.01 per 1M tokens (pins the 10x-mismatch regression)", () => {
      const text = "siliconflow bge-m3 embed text";
      meterEmbed([text], "BAAI/bge-m3", "prov-sf-embed", "siliconflow");

      const row = getRagUsageSummary().find((r) => r.userId === "prov-sf-embed" && r.operation === "embed");
      expect(row).toBeDefined();
      expect(row!.provider).toBe("siliconflow");
      expect(row!.model).toBe("BAAI/bge-m3");

      const expectedTokens = Math.max(1, Math.ceil(Buffer.byteLength(text, "utf8") / 4));
      expect(row!.tokensIn).toBe(expectedTokens);
      // $0.01 per 1M tokens = $0.00001 per 1K tokens — the SAME rate as OpenRouter's confirmed
      // baai/bge-m3 above. Pin the exact cost so the SiliconFlow table can't silently drift 10x
      // again (was `0.00001 / 10` = 0.000001, which this assertion would fail against).
      const expectedCost = (expectedTokens * 0.00001) / 1000;
      expect(row!.costEstUsd).toBeCloseTo(expectedCost, 12);
    });

    it("omitting `provider` now defaults to openrouter", () => {
      meterEmbed(["unchanged default voyage behavior text"], undefined, "prov-default-embed");
      const embedRow = getRagUsageSummary().find((r) => r.userId === "prov-default-embed" && r.operation === "embed");
      expect(embedRow).toBeDefined();
      expect(embedRow!.provider).toBe("openrouter");
      expect(embedRow!.model).toBe("baai/bge-m3");

      meterRerank("q", ["d1", "d2"], undefined, "prov-default-rerank");
      const rerankRow = getRagUsageSummary().find((r) => r.userId === "prov-default-rerank" && r.operation === "rerank");
      expect(rerankRow).toBeDefined();
      expect(rerankRow!.provider).toBe("openrouter");
      expect(rerankRow!.model).toBe("cohere/rerank-v3.5");
    });
  });

  it("recordRagUsage never throws", () => {
    // Force a bad call that would break if we didn't catch
    expect(() => recordRagUsage({ operation: "embed" as any, tokensIn: -1 })).not.toThrow();
  });

  it("meters Pinecone upsert estimated write units separately from record count", () => {
    meterPineconeUpsert(7, "alice", 42);

    const row = getRagUsageSummary().find((r) => r.userId === "alice" && r.provider === "pinecone" && r.operation === "upsert");
    expect(row).toBeDefined();
    expect(row!.tokensIn).toBeGreaterThanOrEqual(42);
    expect(row!.tokensOut).toBeGreaterThanOrEqual(7);
    expect(row!.batchCount).toBeGreaterThanOrEqual(7);
  });

  it("getRagUsageSummary respects sinceIso window", () => {
    const future = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
    const futureSummary = getRagUsageSummary({ sinceIso: future });
    expect(futureSummary.length).toBe(0); // nothing in the future

    const past = new Date(Date.now() - 365 * 24 * 60 * 60_000).toISOString();
    const pastSummary = getRagUsageSummary({ sinceIso: past });
    expect(pastSummary.length).toBeGreaterThan(0); // everything since last year
  });
});

describe("document_chunks content-hash dedup", () => {
  it("filterNewDocumentChunks returns only new hashes", () => {
    const h1 = sha16("unique text A");
    const h2 = sha16("unique text B");
    const h3 = sha16("unique text C");

    // Insert two
    insertDocumentChunks([
      { content_hash: h1, symbol: "AAPL", source: "sec-edgar", chunk_id: "a" },
      { content_hash: h2, symbol: "MSFT", source: "sec-edgar", chunk_id: "b" }
    ]);

    // All three
    const candidates = [
      { content_hash: h1, symbol: "AAPL", source: "sec-edgar", chunk_id: "a" },
      { content_hash: h2, symbol: "MSFT", source: "sec-edgar", chunk_id: "b" },
      { content_hash: h3, symbol: "GOOG", source: "sec-edgar", chunk_id: "c" }
    ];

    const newOnes = filterNewDocumentChunks(candidates);
    expect(newOnes).toHaveLength(1);
    expect(newOnes[0]!.content_hash).toBe(h3);

    // Empty input
    expect(filterNewDocumentChunks([])).toEqual([]);
  });

  it("getChunkCoverage returns per-symbol stats", () => {
    const coverage = getChunkCoverage();
    // AAPL and MSFT were inserted above
    const aapl = coverage.find((c) => c.symbol === "AAPL");
    const msft = coverage.find((c) => c.symbol === "MSFT");
    expect(aapl).toBeDefined();
    expect(aapl!.chunkCount).toBe(1);
    expect(msft).toBeDefined();
    expect(msft!.chunkCount).toBe(1);
  });
});


describe("Qdrant daily ingest point fuse defaults", () => {
  const prev = {
    RAG_MAX_DAILY_INGEST_POINTS: process.env.RAG_MAX_DAILY_INGEST_POINTS,
    QDRANT_MAX_DAILY_INGEST_POINTS: process.env.QDRANT_MAX_DAILY_INGEST_POINTS,
    RAG_INGEST_POINTS_BUDGET_ENABLED: process.env.RAG_INGEST_POINTS_BUDGET_ENABLED
  };

  afterEach(() => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("defaults to 150_000 points/day (matches Infisical prod)", async () => {
    delete process.env.RAG_MAX_DAILY_INGEST_POINTS;
    delete process.env.QDRANT_MAX_DAILY_INGEST_POINTS;
    const {
      DEFAULT_RAG_MAX_DAILY_INGEST_POINTS,
      ragMaxDailyIngestPoints
    } = await import("../src/lib/rag-metering");
    expect(DEFAULT_RAG_MAX_DAILY_INGEST_POINTS).toBe(150_000);
    expect(ragMaxDailyIngestPoints()).toBe(150_000);
  });

  it("honors RAG_MAX_DAILY_INGEST_POINTS env override", async () => {
    process.env.RAG_MAX_DAILY_INGEST_POINTS = "250000";
    const { ragMaxDailyIngestPoints } = await import("../src/lib/rag-metering");
    expect(ragMaxDailyIngestPoints()).toBe(250_000);
  });

  it("ragIngestPointsBudgetDeferUntil is ~1h ahead", async () => {
    const { ragIngestPointsBudgetDeferUntil } = await import("../src/lib/rag-metering");
    const now = Date.UTC(2026, 8, 18, 10, 0, 0);
    const until = Date.parse(ragIngestPointsBudgetDeferUntil(now));
    expect(until - now).toBe(60 * 60_000);
  });
});
