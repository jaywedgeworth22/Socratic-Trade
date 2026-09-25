// Hermetic unit tests for disclosure-rag.ts.
// No network, no Pinecone, no Voyage — storeContexts is mocked via vi.hoisted.

import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Temp SQLite — set BEFORE any module import that touches db
beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-disclosure-rag-${randomUUID()}.db`)}`;
});

// ── Mocks (hoisted so they apply before module resolution) ───────────────────

const mocks = vi.hoisted(() => ({
  storeContexts: vi.fn().mockResolvedValue({ attempted: 0, indexed: 0 }),
  hasIngestTextBudget: vi.fn().mockReturnValue(true),
}));

vi.mock("../src/lib/vector-db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/vector-db")>();
  return {
    ...actual,
    managedVectorLedgerAuthority: vi.fn(),
    storeContexts: mocks.storeContexts,
    hasIngestTextBudget: mocks.hasIngestTextBudget,
  };
});

vi.mock("../src/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/db")>();
  return { managedVectorLedgerAuthority: vi.fn(), ...actual, audit: vi.fn().mockResolvedValue(undefined) };
});

// ── Fixtures ─────────────────────────────────────────────────────────────────

import type { CongressTrade } from "../src/lib/web-sources/types";
import type { InsiderFiling } from "../src/lib/web-sources/sec";

const singleTrade: CongressTrade = {
  symbol: "AAPL",
  member: "Jane Doe",
  chamber: "senate",
  side: "buy",
  amountLow: 15001,
  amountHigh: 50000,
  tradedAt: "2025-05-10",
  disclosedAt: "2025-05-20",
  source: "senate-efd"
};

const tradeNoDisclosedAt: CongressTrade = {
  symbol: "MSFT",
  member: "John Smith",
  chamber: "house",
  side: "sell",
  tradedAt: "2025-03-10",
  source: "house-clerk"
};

const singleFiling: InsiderFiling = {
  symbol: "NVDA",
  owner: "Jensen Huang",
  buyTx: 1,
  sellTx: 0,
  buyShares: 1000,
  sellShares: 0,
  filedAt: "2025-06-12",
  accession: "0001234567-25-000001"
};

const trade2: CongressTrade = {
  symbol: "TSLA",
  member: "Alice Brown",
  chamber: "house",
  side: "buy",
  tradedAt: "2025-06-01",
  disclosedAt: "2025-06-10",
  source: "house-clerk"
};

const filing2: InsiderFiling = {
  symbol: "AMD",
  owner: "Lisa Su",
  buyTx: 2,
  sellTx: 1,
  buyShares: 5000,
  sellShares: 1000,
  filedAt: "2025-06-20",
  accession: "0009876543-25-000002"
};

// Helper: capture docs passed to the most recent storeContexts call
function capturedDocs() {
  const calls = mocks.storeContexts.mock.calls;
  if (calls.length === 0) return [];
  return calls[calls.length - 1][0] as Array<{ text: string; metadata: Record<string, unknown> }>;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("disclosureRagEnabled()", () => {
  it("returns false when RAG_EMBED_DISCLOSURES is unset", async () => {
    delete process.env.RAG_EMBED_DISCLOSURES;
    const { disclosureRagEnabled } = await import("../src/lib/web-sources/disclosure-rag");
    expect(disclosureRagEnabled()).toBe(false);
  });

  it("returns false when RAG_EMBED_DISCLOSURES=off", async () => {
    process.env.RAG_EMBED_DISCLOSURES = "off";
    const { disclosureRagEnabled } = await import("../src/lib/web-sources/disclosure-rag");
    expect(disclosureRagEnabled()).toBe(false);
  });

  it("returns true when RAG_EMBED_DISCLOSURES=on", async () => {
    process.env.RAG_EMBED_DISCLOSURES = "on";
    const { disclosureRagEnabled } = await import("../src/lib/web-sources/disclosure-rag");
    expect(disclosureRagEnabled()).toBe(true);
  });

  // R6 (2026-07-01 RAG backlog): FIXES the operator trap the previous version of this test
  // documented. disclosureRagEnabled() previously required the EXACT string "on" — an operator
  // who reasonably set RAG_EMBED_DISCLOSURES=true got a SILENT no-op, unlike every other RAG flag
  // in this app (VECTOR_ENABLE_RERANK, HYBRID_RETRIEVAL, VECTOR_ASOF_STRICT), which all accept
  // "1"/"true"/"on"/"yes". disclosureRagEnabled() now routes through the shared envFlagOn parser,
  // so it accepts the same vocabulary as every other RAG flag. This is an intentional, SAFE-
  // DIRECTION behavior change (an operator setting any of these values was already trying to turn
  // disclosures ON) — noted explicitly in docs/rollouts/2026-07-01-rag-backlog.md because it can
  // trigger real Voyage/Pinecone embedding cost for an operator who was unknowingly relying on the
  // old exact-match quirk to silently no-op.
  it("accepts 'true'/'1'/'yes'/'on' (case/whitespace-insensitive) — the same vocabulary as every other RAG flag", async () => {
    for (const value of ["true", "1", "yes", "TRUE", "ON", " on ", "YES"]) {
      process.env.RAG_EMBED_DISCLOSURES = value;
      vi.resetModules();
      const { disclosureRagEnabled } = await import("../src/lib/web-sources/disclosure-rag");
      expect(disclosureRagEnabled(), `RAG_EMBED_DISCLOSURES="${value}" should enable disclosures`).toBe(true);
    }
  });

  it("fails closed on garbage/unrecognized values", async () => {
    for (const value of ["enabled", "please", "2"]) {
      process.env.RAG_EMBED_DISCLOSURES = value;
      vi.resetModules();
      const { disclosureRagEnabled } = await import("../src/lib/web-sources/disclosure-rag");
      expect(disclosureRagEnabled(), `RAG_EMBED_DISCLOSURES="${value}" should NOT enable disclosures`).toBe(false);
    }
  });
});

describe("embedDisclosures() — flag OFF", () => {
  beforeEach(() => {
    process.env.RAG_EMBED_DISCLOSURES = "off";
    mocks.storeContexts.mockClear();
  });

  it("returns { skipped: true } and does NOT call storeContexts when flag is off", async () => {
    const { embedDisclosures } = await import("../src/lib/web-sources/disclosure-rag");
    const result = await embedDisclosures([singleTrade], [singleFiling]);
    expect(result.skipped).toBe(true);
    expect(mocks.storeContexts).not.toHaveBeenCalled();
  });
});

describe("embedDisclosures() — daily text embed budget spent", () => {
  beforeEach(() => {
    process.env.RAG_EMBED_DISCLOSURES = "on";
    mocks.storeContexts.mockClear();
    mocks.hasIngestTextBudget.mockReturnValueOnce(false);
  });

  it("skips without calling storeContexts", async () => {
    const { embedDisclosures } = await import("../src/lib/web-sources/disclosure-rag");
    const result = await embedDisclosures([singleTrade], [singleFiling]);
    expect(result).toMatchObject({ indexed: 0, skipped: true });
    expect(mocks.storeContexts).not.toHaveBeenCalled();
  });
});

describe("embedDisclosures() — flag ON, congress trades", () => {
  beforeEach(() => {
    process.env.RAG_EMBED_DISCLOSURES = "on";
    mocks.storeContexts.mockClear();
    mocks.storeContexts.mockResolvedValue({ attempted: 1, indexed: 1 });
  });

  it("produces a document for each congress trade", async () => {
    const { embedDisclosures } = await import("../src/lib/web-sources/disclosure-rag");
    await embedDisclosures([singleTrade], []);
    expect(mocks.storeContexts).toHaveBeenCalledOnce();
    const docs = capturedDocs();
    expect(docs).toHaveLength(1);
  });

  it("congress trade document has correct doc_type='congress-trade'", async () => {
    const { embedDisclosures } = await import("../src/lib/web-sources/disclosure-rag");
    await embedDisclosures([singleTrade], []);
    const doc = capturedDocs()[0];
    expect(doc.metadata.doc_type).toBe("congress-trade");
  });

  it("congress trade document text mentions member, symbol, side (uppercased), and tradedAt", async () => {
    const { embedDisclosures } = await import("../src/lib/web-sources/disclosure-rag");
    await embedDisclosures([singleTrade], []);
    const text = capturedDocs()[0].text;
    expect(text).toContain(singleTrade.member);
    expect(text).toContain(singleTrade.symbol);
    expect(text).toContain("BUY"); // uppercase
    expect(text).toContain(singleTrade.tradedAt);
  });

  it("congress trade acceptance_datetime equals disclosedAt, not current time", async () => {
    const { embedDisclosures } = await import("../src/lib/web-sources/disclosure-rag");
    await embedDisclosures([singleTrade], []);
    const doc = capturedDocs()[0];
    expect(doc.metadata.acceptance_datetime).toBe("2025-05-20");
    expect(doc.metadata.acceptance_datetime).not.toBe(new Date().toISOString().slice(0, 10));
  });

  it("congress trade acceptance_datetime falls back to tradedAt when disclosedAt is absent", async () => {
    const { embedDisclosures } = await import("../src/lib/web-sources/disclosure-rag");
    await embedDisclosures([tradeNoDisclosedAt], []);
    const doc = capturedDocs()[0];
    expect(doc.metadata.acceptance_datetime).toBe("2025-03-10");
  });

  it("congress trade metadata includes correct symbol and source='congress-disclosure'", async () => {
    const { embedDisclosures } = await import("../src/lib/web-sources/disclosure-rag");
    await embedDisclosures([singleTrade], []);
    const doc = capturedDocs()[0];
    expect(doc.metadata.symbol).toBe(singleTrade.symbol);
    expect(doc.metadata.source).toBe("congress-disclosure");
  });

  it("congress trade text includes amount range when both bounds are present", async () => {
    const { embedDisclosures } = await import("../src/lib/web-sources/disclosure-rag");
    await embedDisclosures([singleTrade], []);
    const text = capturedDocs()[0].text;
    expect(text).toContain("15,001");
    expect(text).toContain("50,000");
  });

  it("congress trade text omits amount sentence when no bounds are present", async () => {
    const { embedDisclosures } = await import("../src/lib/web-sources/disclosure-rag");
    const noAmount: CongressTrade = { ...singleTrade, amountLow: undefined, amountHigh: undefined };
    await embedDisclosures([noAmount], []);
    const text = capturedDocs()[0].text;
    expect(text).not.toContain("Amount range");
  });
});

describe("embedDisclosures() — flag ON, insider filings", () => {
  beforeEach(() => {
    process.env.RAG_EMBED_DISCLOSURES = "on";
    mocks.storeContexts.mockClear();
    mocks.storeContexts.mockResolvedValue({ attempted: 1, indexed: 1 });
  });

  it("produces a document for each insider filing", async () => {
    const { embedDisclosures } = await import("../src/lib/web-sources/disclosure-rag");
    await embedDisclosures([], [singleFiling]);
    expect(mocks.storeContexts).toHaveBeenCalledOnce();
    const docs = capturedDocs();
    expect(docs).toHaveLength(1);
  });

  it("insider filing document has correct doc_type='insider-filing'", async () => {
    const { embedDisclosures } = await import("../src/lib/web-sources/disclosure-rag");
    await embedDisclosures([], [singleFiling]);
    const doc = capturedDocs()[0];
    expect(doc.metadata.doc_type).toBe("insider-filing");
  });

  it("insider filing document text mentions owner, symbol, buyTx, sellTx, filedAt", async () => {
    const { embedDisclosures } = await import("../src/lib/web-sources/disclosure-rag");
    await embedDisclosures([], [singleFiling]);
    const text = capturedDocs()[0].text;
    expect(text).toContain(singleFiling.owner);
    expect(text).toContain(singleFiling.symbol);
    expect(text).toContain(String(singleFiling.buyTx));
    expect(text).toContain(singleFiling.filedAt);
  });

  it("insider filing acceptance_datetime equals filedAt, not current time", async () => {
    const { embedDisclosures } = await import("../src/lib/web-sources/disclosure-rag");
    await embedDisclosures([], [singleFiling]);
    const doc = capturedDocs()[0];
    expect(doc.metadata.acceptance_datetime).toBe("2025-06-12");
    expect(doc.metadata.acceptance_datetime).not.toBe(new Date().toISOString().slice(0, 10));
  });

  it("insider filing accession is the filing accession number", async () => {
    const { embedDisclosures } = await import("../src/lib/web-sources/disclosure-rag");
    await embedDisclosures([], [singleFiling]);
    const doc = capturedDocs()[0];
    expect(doc.metadata.accession).toBe(singleFiling.accession);
  });

  it("insider filing metadata has correct symbol and source='insider-filing'", async () => {
    const { embedDisclosures } = await import("../src/lib/web-sources/disclosure-rag");
    await embedDisclosures([], [singleFiling]);
    const doc = capturedDocs()[0];
    expect(doc.metadata.symbol).toBe(singleFiling.symbol);
    expect(doc.metadata.source).toBe("insider-filing");
  });
});

describe("embedDisclosures() — mixed trades and filings", () => {
  beforeEach(() => {
    process.env.RAG_EMBED_DISCLOSURES = "on";
    mocks.storeContexts.mockClear();
  });

  it("combines trades and filings into one storeContexts call", async () => {
    mocks.storeContexts.mockResolvedValue({ attempted: 3, indexed: 3 });
    const { embedDisclosures } = await import("../src/lib/web-sources/disclosure-rag");
    await embedDisclosures([singleTrade, trade2], [singleFiling]);
    expect(mocks.storeContexts).toHaveBeenCalledOnce();
    const docs = capturedDocs();
    expect(docs).toHaveLength(3);
  });

  it("returns attempted+indexed from storeContexts result", async () => {
    mocks.storeContexts.mockResolvedValue({ attempted: 3, indexed: 3 });
    const { embedDisclosures } = await import("../src/lib/web-sources/disclosure-rag");
    const result = await embedDisclosures([singleTrade, trade2], [singleFiling]);
    expect(result.attempted).toBe(3);
    expect(result.indexed).toBe(3);
  });

  it("trade docs appear before filing docs in the combined array", async () => {
    mocks.storeContexts.mockResolvedValue({ attempted: 2, indexed: 2 });
    const { embedDisclosures } = await import("../src/lib/web-sources/disclosure-rag");
    await embedDisclosures([singleTrade], [filing2]);
    const docs = capturedDocs();
    expect(docs[0].metadata.doc_type).toBe("congress-trade");
    expect(docs[1].metadata.doc_type).toBe("insider-filing");
  });
});

describe("embedDisclosures() — empty inputs", () => {
  beforeEach(() => {
    process.env.RAG_EMBED_DISCLOSURES = "on";
    mocks.storeContexts.mockClear();
  });

  it("returns { attempted: 0, indexed: 0 } and does not call storeContexts when both arrays are empty", async () => {
    const { embedDisclosures } = await import("../src/lib/web-sources/disclosure-rag");
    const result = await embedDisclosures([], []);
    expect(mocks.storeContexts).not.toHaveBeenCalled();
    expect(result.attempted).toBe(0);
    expect(result.indexed).toBe(0);
    expect(result.skipped).toBeUndefined();
  });
});

describe("embedDisclosures() — no-op audit rollup (#2553c)", () => {
  beforeEach(async () => {
    process.env.RAG_EMBED_DISCLOSURES = "on";
    mocks.storeContexts.mockClear();
    const db = await import("../src/lib/db");
    vi.mocked(db.audit).mockClear();
    const { DISCLOSURE_RAG_NOOP_ROLLUP_KEY } = await import("../src/lib/web-sources/disclosure-rag");
    db.deleteInternalSetting(DISCLOSURE_RAG_NOOP_ROLLUP_KEY);
  });

  it("suppresses per-cycle no-op audits and flushes at most one daily rollup carrying the count", async () => {
    const { embedDisclosures, DISCLOSURE_RAG_NOOP_ROLLUP_KEY } = await import("../src/lib/web-sources/disclosure-rag");
    const db = await import("../src/lib/db");
    const auditMock = vi.mocked(db.audit);
    // The live symptom: every 1–3 min refresh re-embedded 310 already-deduped docs
    // ("Attempted: 310 · Indexed: 0") and wrote an identical audit row each time.
    mocks.storeContexts.mockResolvedValue({ attempted: 310, indexed: 0 });

    // First-ever no-op (no watermark): ONE rollup row proves the lane is alive.
    await embedDisclosures([singleTrade], []);
    expect(auditMock).toHaveBeenCalledTimes(1);
    expect(auditMock.mock.calls[0]![0]).toBe("disclosure_rag_embed");
    expect(auditMock.mock.calls[0]![1]).toMatchObject({ ok: true, indexed: 0, rollup: true, dedupedCycles: 1 });

    // Further no-op cycles inside the 24h window: silent — only the watermark accumulates.
    await embedDisclosures([singleTrade], []);
    await embedDisclosures([singleTrade], []);
    expect(auditMock).toHaveBeenCalledTimes(1);
    expect(db.getInternalSetting(DISCLOSURE_RAG_NOOP_ROLLUP_KEY)).toMatchObject({ cycles: 2, attempted: 620 });

    // Window lapsed: the next no-op flushes ONE rollup carrying every suppressed cycle.
    const state = db.getInternalSetting<{ cycles: number; attempted: number }>(DISCLOSURE_RAG_NOOP_ROLLUP_KEY)!;
    db.setInternalSetting(DISCLOSURE_RAG_NOOP_ROLLUP_KEY, {
      ...state,
      lastAuditAt: new Date(Date.now() - 25 * 3600_000).toISOString()
    });
    await embedDisclosures([singleTrade], []);
    expect(auditMock).toHaveBeenCalledTimes(2);
    expect(auditMock.mock.calls[1]![1]).toMatchObject({ rollup: true, dedupedCycles: 3, dedupedAttempted: 930 });
    expect(db.getInternalSetting(DISCLOSURE_RAG_NOOP_ROLLUP_KEY)).toMatchObject({ cycles: 0, attempted: 0 });
  });

  it("still audits every cycle that indexed documents, was skipped upstream, or errored", async () => {
    const { embedDisclosures } = await import("../src/lib/web-sources/disclosure-rag");
    const db = await import("../src/lib/db");
    const auditMock = vi.mocked(db.audit);

    mocks.storeContexts.mockResolvedValue({ attempted: 310, indexed: 4 });
    await embedDisclosures([singleTrade], []);
    expect(auditMock).toHaveBeenCalledTimes(1);
    expect(auditMock.mock.calls[0]![1]).toMatchObject({ ok: true, indexed: 4 });

    mocks.storeContexts.mockResolvedValue({ attempted: 0, indexed: 0, skipped: true });
    await embedDisclosures([singleTrade], []);
    expect(auditMock).toHaveBeenCalledTimes(2);
    expect(auditMock.mock.calls[1]![1]).toMatchObject({ skipped: true });

    mocks.storeContexts.mockResolvedValue({ attempted: 310, indexed: 0, error: "pinecone unavailable" });
    await embedDisclosures([singleTrade], []);
    expect(auditMock).toHaveBeenCalledTimes(3);
    expect(auditMock.mock.calls[2]![1]).toMatchObject({ ok: false });
  });
});
