import { describe, it, expect, beforeAll, vi } from "vitest";
import { getDb, applyVersionedMigrations } from "../src/lib/db";
import { createSecIngestJob, enqueueSecIngestTask, getSecIngestTask, claimSecIngestTasks, transitionSecIngestJob } from "../src/lib/db-rag-ingest";
import { SecIngestWorker } from "../src/lib/rag/sec-ingest-worker";
import { politeFetchText, politeFetch } from "../src/lib/web-sources/http";
import { storeDocument } from "../src/lib/vector-db";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

beforeAll(() => {
  const runId = randomUUID();
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-sec-worker-${runId}.db`)}`;
  process.env.DATA_DIR = join(tmpdir(), `agentic-sec-worker-data-${runId}`);
  const db = getDb();
  applyVersionedMigrations(db);
});

vi.mock("../src/lib/web-sources/http", () => ({
  politeFetchText: vi.fn(),
  politeFetch: vi.fn(),
  BROWSER_UA: "Mozilla/5.0 test"
}));

vi.mock("../src/lib/vector-db", async (importOriginal) => {
  // classifyEmbedFailure is a pure classifier the worker now calls directly to decide
  // retryable-vs-dead-letter (2026-08-23 P0 fix) — keep the REAL implementation so these tests
  // exercise the same classification production does, and only stub the provider-calling
  // storeDocument.
  const actual = await importOriginal<typeof import("../src/lib/vector-db")>();
  return { ...actual, storeDocument: vi.fn(), hasIngestTextBudget: vi.fn(actual.hasIngestTextBudget) };
});

describe("SEC Ingestion Worker and State Machine (P5)", () => {
  it("should claim a discovered task, run the pipeline checkpoints, and mark it complete", async () => {
    const db = getDb();
    const accession = "0000320193-26-000010";

    const job = createSecIngestJob({
      idempotencyKey: "idemp-123",
      corpusRevision: "corp-v1"
    });
    const jobId = job.id;

    transitionSecIngestJob(jobId, "running");

    const { task } = enqueueSecIngestTask({
      jobId,
      accession,
      cik: "0000320193",
      symbol: "AAPL",
      payload: {
        url: "https://www.sec.gov/Archives/edgar/data/320193/000032019326000010/aapl-20260715.htm",
        docType: "10-K",
        filedAt: "2026-07-15",
        acceptanceDateTime: "2026-07-15T21:37:12.000Z"
      }
    });

    expect(task.checkpoint).toBe("discovered");

    const claimed = claimSecIngestTasks(jobId, {
      owner: "test-worker",
      leaseMs: 60000,
      limit: 1
    });
    expect(claimed).toHaveLength(1);
    const taskToProcess = claimed[0]!;

    // Mocks
    vi.mocked(politeFetchText).mockResolvedValueOnce("<html><body>Item 1. Business<p>AAPL makes iPhones and lots of other consumer electronics that people buy all over the world.</p></body></html>");
    vi.mocked(politeFetch).mockResolvedValue({
      ok: false,
      status: 404,
      statusText: "Not Found"
    } as any);
    vi.mocked(storeDocument).mockResolvedValueOnce({
      skipped: false,
      attempted: 1,
      indexed: 1,
      documentComplete: true
    } as any);

    // Process step-by-step re-claiming the task at each stage
    const worker = new SecIngestWorker();
    let currentTask = taskToProcess;

    while (currentTask.checkpoint !== "complete") {
      await worker.processTask(currentTask);

      const claimedNext = claimSecIngestTasks(jobId, {
        owner: "test-worker",
        leaseMs: 60000,
        limit: 1
      });
      if (claimedNext.length === 0) {
        break;
      }
      currentTask = claimedNext[0]!;
    }

    const finalTask = getSecIngestTask(task.id);
    expect(finalTask).not.toBeNull();
    expect(finalTask!.checkpoint).toBe("complete");
    expect(finalTask!.status).toBe("complete");
    expect(finalTask!.observedChunks).toBe(1);

    // Point-in-time: the queued acceptance timestamp must flow into the stored document, not a
    // date-only fallback derived from filedAt.
    const storeCall = vi.mocked(storeDocument).mock.calls[0]?.[0] as any;
    expect(storeCall.acceptance_datetime).toBe("2026-07-15T21:37:12.000Z");
    expect(storeCall.text).toContain("iPhones");
    expect(storeCall.text).not.toMatch(/<html|<script|<body/i);

    // Multi-document accessions: the vector document id must carry the task's document identity
    // (sequence + documentName) so a second document in the same accession can never supersede
    // this one's managed-ledger head or collide on chunk citations.
    expect(storeCall.doc_id).toBe(`${accession}:1:document.html`);

    // Lexical FTS rows are written only after storeDocument reports a committed document —
    // and they ARE written (the worker pipeline is the FTS producer for queued ingests).
    // Accession key matches storeDocument doc_id / chunk_occurrences (vectorDocId), not bare SEC accession.
    const ftsRows = db.prepare(
      "SELECT symbol, accession FROM document_chunks_fts WHERE accession = ?"
    ).all(`${accession}:1:document.html`) as any[];
    expect(ftsRows.length).toBeGreaterThan(0);
    expect(ftsRows[0].symbol).toBe("AAPL");
    expect(ftsRows[0].accession).toBe(`${accession}:1:document.html`);
  });
});

describe("EDGAR 403 handling and dead-letter requeue (2026-08-09 outage class)", () => {
  function makeClaimedTask(idempotencyKey: string, accession: string) {
    const job = createSecIngestJob({ idempotencyKey, corpusRevision: "corp-v1" });
    transitionSecIngestJob(job.id, "running");
    enqueueSecIngestTask({
      jobId: job.id,
      accession,
      cik: "0000798354",
      symbol: "FI",
      payload: {
        url: `https://www.sec.gov/Archives/edgar/data/798354/${accession.replace(/-/g, "")}/doc.htm`,
        docType: "10-Q",
        filedAt: "2026-06-30",
        acceptanceDateTime: "2026-06-30T21:00:00.000Z"
      }
    });
    const claimed = claimSecIngestTasks(job.id, { owner: "test-worker", leaseMs: 60000, limit: 1 });
    expect(claimed).toHaveLength(1);
    return { jobId: job.id, task: claimed[0]! };
  }

  it("defers (not fails) a task when EDGAR answers 403, refunding the stage attempt", async () => {
    const { task } = makeClaimedTask("idemp-403-defer", "0000798354-26-000031");
    vi.mocked(politeFetchText).mockRejectedValueOnce(
      new Error("HTTP 403 for https://www.sec.gov/Archives/edgar/data/798354/000079835426000031/doc.htm")
    );

    const worker = new SecIngestWorker();
    await worker.processTask(task);

    const after = getSecIngestTask(task.id);
    expect(after).not.toBeNull();
    expect(after!.status).toBe("retry_wait");
    expect(after!.lastErrorType).toBe("edgar_403_deferred");
    // Deferral refunds the attempt the claim consumed — a persistent block must never march the
    // task toward dead_letter.
    expect(after!.stageAttempts).toBe(0);
    expect(after!.checkpoint).toBe("discovered");
  });

  it("requeues dead-lettered tasks and reopens their complete_with_errors job", async () => {
    const { jobId, task } = makeClaimedTask("idemp-requeue", "0000798354-26-000032");
    const { failSecIngestTask, sealSecIngestJobIntake, reconcileSecIngestJob, requeueSecIngestDeadLetters, getSecIngestJob } =
      await import("../src/lib/db-rag-ingest");

    expect(sealSecIngestJobIntake(jobId, 1)).toBe(true);
    const failed = failSecIngestTask({
      taskId: task.id,
      owner: "test-worker",
      leaseToken: task.leaseToken || "",
      retryable: false,
      errorType: "worker-error",
      error: "HTTP 403 for https://www.sec.gov/Archives/..."
    });
    expect(failed.applied).toBe(true);
    expect(getSecIngestTask(task.id)!.status).toBe("dead_letter");
    expect(reconcileSecIngestJob(jobId)).toBe("complete_with_errors");

    const result = requeueSecIngestDeadLetters({ jobIds: [jobId] });
    expect(result.requeuedTasks).toBe(1);
    expect(result.reopenedJobs).toBe(1);

    const after = getSecIngestTask(task.id)!;
    expect(after.status).toBe("retry_wait");
    expect(after.stageAttempts).toBe(0);
    expect(getSecIngestJob(jobId)!.status).toBe("running");

    // The requeued task is claimable again once its next_retry_at passes.
    const reclaimed = claimSecIngestTasks(jobId, {
      owner: "test-worker",
      leaseMs: 60000,
      limit: 1,
      now: new Date(Date.now() + 60_000)
    });
    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0]!.id).toBe(task.id);
  });

  it("requeues only budget-misclassified dead letters when errorLike is set", async () => {
    const budget = makeClaimedTask("idemp-requeue-budget", "0000798354-26-000099");
    const other = makeClaimedTask("idemp-requeue-other", "0000798354-26-000098");
    const { failSecIngestTask, requeueSecIngestDeadLetters, getSecIngestTask } =
      await import("../src/lib/db-rag-ingest");

    failSecIngestTask({
      taskId: budget.task.id,
      owner: "test-worker",
      leaseToken: budget.task.leaseToken || "",
      retryable: false,
      errorType: "worker-error",
      error: "Ingestion budget or capacity exceeded mid-task"
    });
    failSecIngestTask({
      taskId: other.task.id,
      owner: "test-worker",
      leaseToken: other.task.leaseToken || "",
      retryable: false,
      errorType: "worker-error",
      error: "HTTP 403 for https://www.sec.gov/Archives/..."
    });

    const result = requeueSecIngestDeadLetters({
      errorTypeLike: "worker-error",
      errorLike: "Ingestion budget or capacity exceeded%"
    });
    expect(result.requeuedTasks).toBe(1);
    expect(getSecIngestTask(budget.task.id)!.status).toBe("retry_wait");
    expect(getSecIngestTask(other.task.id)!.status).toBe("dead_letter");
  });
});

describe("insertDocumentChunkFtsBatch (2026-08-10 lock-contention fix, sub-batched + yielded)", () => {
  it("writes identical rows to the per-chunk loop", async () => {
    const { insertDocumentChunkFts, insertDocumentChunkFtsBatch } = await import("../src/lib/db-learning");
    const rows = [
      { contentHash: "hash-a", symbol: "AAPL", source: "sec-edgar", accession: "acc-batch-test", text: "alpha text" },
      { contentHash: "hash-b", symbol: "AAPL", source: "sec-edgar", accession: "acc-batch-test", text: "beta text" },
      { contentHash: "hash-c", symbol: "AAPL", source: "sec-edgar", accession: "acc-batch-test", text: "gamma text" }
    ];

    await insertDocumentChunkFtsBatch(rows);
    const batchRows = getDb()
      .prepare("SELECT content_hash, text FROM document_chunks_fts WHERE accession = ? ORDER BY content_hash")
      .all("acc-batch-test") as Array<{ content_hash: string; text: string }>;
    expect(batchRows).toHaveLength(3);
    expect(batchRows.map((r) => r.content_hash)).toEqual(["hash-a", "hash-b", "hash-c"]);

    // Re-running with the per-chunk loop against the SAME identity must produce the same final
    // rows (idempotent delete+insert), proving the batch path is a drop-in replacement.
    for (const row of rows) {
      insertDocumentChunkFts(row.contentHash, row.symbol, row.source, row.accession, row.text);
    }
    const loopRows = getDb()
      .prepare("SELECT content_hash, text FROM document_chunks_fts WHERE accession = ? ORDER BY content_hash")
      .all("acc-batch-test") as Array<{ content_hash: string; text: string }>;
    expect(loopRows).toEqual(batchRows);
  });

  it("no-ops on an empty array instead of opening an empty transaction", async () => {
    const { insertDocumentChunkFtsBatch } = await import("../src/lib/db-learning");
    await expect(insertDocumentChunkFtsBatch([])).resolves.not.toThrow();
  });

  it("writes every row correctly across multiple sub-batches (proves the yield boundary doesn't drop or duplicate work)", async () => {
    const { insertDocumentChunkFtsBatch } = await import("../src/lib/db-learning");
    // 3 sub-batches at the 40-row internal batch size (2 full + 1 partial).
    const rows = Array.from({ length: 97 }, (_, i) => ({
      contentHash: `hash-multi-${i.toString().padStart(3, "0")}`,
      symbol: "MSFT",
      source: "sec-edgar",
      accession: "acc-multi-batch-test",
      text: `chunk ${i}`
    }));

    await insertDocumentChunkFtsBatch(rows);
    const written = getDb()
      .prepare("SELECT COUNT(*) AS n FROM document_chunks_fts WHERE accession = ?")
      .get("acc-multi-batch-test") as { n: number };
    expect(written.n).toBe(97);
  });

  it("keeps document_chunks_fts_index at one row per occurrence on re-insert", async () => {
    const { insertDocumentChunkFts, insertDocumentChunkFtsBatch } = await import("../src/lib/db-learning");
    const row = {
      contentHash: "hash-idem",
      symbol: "AAPL",
      source: "sec-edgar",
      accession: "acc-idem-index",
      text: "first text"
    };
    await insertDocumentChunkFtsBatch([row]);
    await insertDocumentChunkFtsBatch([
      { ...row, text: "updated text" }
    ]);
    const indexCount = getDb()
      .prepare(
        `SELECT COUNT(*) AS n FROM document_chunks_fts_index
         WHERE content_hash = ? AND symbol = ? AND source = ? AND accession = ?`
      )
      .get(row.contentHash, row.symbol, row.source, row.accession) as { n: number };
    const ftsCount = getDb()
      .prepare(
        `SELECT COUNT(*) AS n FROM document_chunks_fts
         WHERE content_hash = ? AND symbol = ? AND source = ? AND accession = ?`
      )
      .get(row.contentHash, row.symbol, row.source, row.accession) as { n: number };
    expect(indexCount.n).toBe(1);
    expect(ftsCount.n).toBe(1);
    const stored = getDb()
      .prepare("SELECT text FROM document_chunks_fts WHERE rowid = (SELECT fts_rowid FROM document_chunks_fts_index WHERE content_hash = ?)")
      .get(row.contentHash) as { text: string };
    expect(stored.text).toBe("updated text");

    insertDocumentChunkFts(row.contentHash, row.symbol, row.source, row.accession, "third text");
    const indexAfterSingle = getDb()
      .prepare(
        `SELECT COUNT(*) AS n FROM document_chunks_fts_index
         WHERE content_hash = ? AND symbol = ? AND source = ? AND accession = ?`
      )
      .get(row.contentHash, row.symbol, row.source, row.accession) as { n: number };
    expect(indexAfterSingle.n).toBe(1);
  });

  it("does not delete a reused FTS5 rowid after a stale index lookup", async () => {
    const { insertDocumentChunkFts } = await import("../src/lib/db-learning");
    const db = getDb();
    insertDocumentChunkFts(
      "sum-hash-stale",
      "MSFT",
      "document-summarizer",
      "abstract:earnings-summary:MSFT:stale-rowid",
      "Azure growth accelerated with enough text to index."
    );
    const stale = db
      .prepare(
        `SELECT fts_rowid FROM document_chunks_fts_index
         WHERE content_hash = ? AND symbol = ? AND source = ? AND accession = ?`
      )
      .get(
        "sum-hash-stale",
        "MSFT",
        "document-summarizer",
        "abstract:earnings-summary:MSFT:stale-rowid"
      ) as { fts_rowid: number };
    db.prepare("DELETE FROM document_chunks_fts WHERE rowid = ?").run(stale.fts_rowid);

    insertDocumentChunkFts(
      "filing-hash-victim",
      "AAPL",
      "sec-edgar",
      "0000320193-26-000099",
      "Item 1A Risk Factors for the reused rowid victim filing."
    );
    const victimRowid = db
      .prepare("SELECT rowid AS n FROM document_chunks_fts WHERE content_hash = ?")
      .get("filing-hash-victim") as { n: number };
    expect(victimRowid.n).toBe(stale.fts_rowid);

    insertDocumentChunkFts(
      "sum-hash-stale",
      "MSFT",
      "document-summarizer",
      "abstract:earnings-summary:MSFT:stale-rowid",
      "Azure growth accelerated with enough text to index."
    );

    const victim = db
      .prepare("SELECT text FROM document_chunks_fts WHERE content_hash = ?")
      .get("filing-hash-victim") as { text: string } | undefined;
    expect(victim?.text).toMatch(/Risk Factors/);
    const summaryCount = db
      .prepare(
        `SELECT COUNT(*) AS n FROM document_chunks_fts
         WHERE content_hash = ? AND source = 'document-summarizer'`
      )
      .get("sum-hash-stale") as { n: number };
    expect(summaryCount.n).toBe(1);
  });

  it("deleteDocumentChunkFtsBySourceAccession drops matching index keys", async () => {
    const { insertDocumentChunkFts, deleteDocumentChunkFtsBySourceAccession } =
      await import("../src/lib/db-learning");
    const db = getDb();
    const accession = "abstract:10k-delta:MSFT:index-drop";
    insertDocumentChunkFts("sum-drop", "MSFT", "document-summarizer", accession, "highlight text enough");
    insertDocumentChunkFts("keep-filing", "MSFT", "sec-edgar", "0000789019-26-000010", "filing body enough");
    deleteDocumentChunkFtsBySourceAccession("document-summarizer", accession);
    const indexLeft = db
      .prepare(
        `SELECT COUNT(*) AS n FROM document_chunks_fts_index
         WHERE source = 'document-summarizer' AND accession = ?`
      )
      .get(accession) as { n: number };
    const filingLeft = db
      .prepare("SELECT COUNT(*) AS n FROM document_chunks_fts WHERE content_hash = ?")
      .get("keep-filing") as { n: number };
    expect(indexLeft.n).toBe(0);
    expect(filingLeft.n).toBe(1);
  });
});

describe("nextFtsBatchGroupSize (2026-08-13 adaptive stretch budget)", () => {
  it("halves after an over-budget group, floored at 1", async () => {
    const { nextFtsBatchGroupSize } = await import("../src/lib/db-learning");
    expect(nextFtsBatchGroupSize(8, 6600)).toBe(4);
    expect(nextFtsBatchGroupSize(1, 6600)).toBe(1);
  });

  it("doubles after a fast group, capped at 40", async () => {
    const { nextFtsBatchGroupSize } = await import("../src/lib/db-learning");
    expect(nextFtsBatchGroupSize(8, 10)).toBe(16);
    expect(nextFtsBatchGroupSize(40, 10)).toBe(40);
  });

  it("holds steady inside the comfort band", async () => {
    const { nextFtsBatchGroupSize } = await import("../src/lib/db-learning");
    expect(nextFtsBatchGroupSize(8, 200)).toBe(8);
  });

  it("converges from the 119s incident shape: 165ms/row halves 8 -> 1 within three groups", async () => {
    const { nextFtsBatchGroupSize } = await import("../src/lib/db-learning");
    let size = 8;
    size = nextFtsBatchGroupSize(size, 8 * 165);
    size = nextFtsBatchGroupSize(size, 4 * 165);
    size = nextFtsBatchGroupSize(size, 2 * 165);
    expect(size).toBe(1);
  });
});

describe("planFtsMirrorSlice (2026-08-14 bound above the 250ms yield)", () => {
  it("computes the production 933/279522 receipt into a tick that stays inside the wall budget and 250ms sync", async () => {
    const {
      FTS_MIRROR_INCIDENT_CHUNKS,
      FTS_MIRROR_INCIDENT_WALL_MS,
      FTS_MIRROR_INCIDENT_MS_PER_CHUNK,
      FTS_MIRROR_MAX_CHUNKS_PER_TICK,
      FTS_MIRROR_TICK_BUDGET_MS,
      FTS_MIRROR_SYNC_STRETCH_BUDGET_MS,
      planFtsMirrorSlice
    } = await import("../src/lib/rag/fts-mirror-bound");
    const { FTS_BATCH_STRETCH_BUDGET_MS } = await import("../src/lib/db-learning");

    expect(FTS_MIRROR_INCIDENT_CHUNKS).toBe(933);
    expect(FTS_MIRROR_INCIDENT_WALL_MS).toBe(279_522);
    expect(FTS_MIRROR_INCIDENT_MS_PER_CHUNK).toBe(279_522 / 933);
    expect(FTS_MIRROR_SYNC_STRETCH_BUDGET_MS).toBe(250);
    expect(FTS_BATCH_STRETCH_BUDGET_MS).toBe(FTS_MIRROR_SYNC_STRETCH_BUDGET_MS);

    const first = planFtsMirrorSlice({
      totalChunks: FTS_MIRROR_INCIDENT_CHUNKS,
      offset: 0
    });
    expect(first.chunkCount).toBeGreaterThan(0);
    expect(first.chunkCount).toBeLessThanOrEqual(FTS_MIRROR_MAX_CHUNKS_PER_TICK);
    expect(first.offset).toBe(0);
    expect(first.end).toBe(first.chunkCount);
    expect(first.complete).toBe(false);
    expect(first.worstCaseSyncStretchMs).toBe(250);
    expect(first.worstCaseTickWallMs).toBeLessThanOrEqual(FTS_MIRROR_TICK_BUDGET_MS);
    expect(first.chunkCount * FTS_MIRROR_INCIDENT_MS_PER_CHUNK).toBeLessThanOrEqual(
      FTS_MIRROR_TICK_BUDGET_MS
    );

    // A full-document feed of 933 is exactly the incident: 279s wall, unbounded tick.
    expect(933 * FTS_MIRROR_INCIDENT_MS_PER_CHUNK).toBe(FTS_MIRROR_INCIDENT_WALL_MS);
    expect(933 * FTS_MIRROR_INCIDENT_MS_PER_CHUNK).toBeGreaterThan(FTS_MIRROR_TICK_BUDGET_MS);
  });

  it("resume starts after completed slices and never re-plans them", async () => {
    const { planFtsMirrorSlice, FTS_MIRROR_INCIDENT_CHUNKS } = await import(
      "../src/lib/rag/fts-mirror-bound"
    );
    const first = planFtsMirrorSlice({ totalChunks: FTS_MIRROR_INCIDENT_CHUNKS, offset: 0 });
    const second = planFtsMirrorSlice({
      totalChunks: FTS_MIRROR_INCIDENT_CHUNKS,
      offset: first.end
    });
    expect(second.offset).toBe(first.end);
    expect(second.offset).toBeGreaterThan(0);
    expect(second.end).toBeGreaterThan(second.offset);
    expect(second.offset).toBeGreaterThanOrEqual(first.end);
  });

  it("a 933-chunk filing takes more than one tick (never 279s in one call)", async () => {
    const {
      planFtsMirrorSlice,
      FTS_MIRROR_INCIDENT_CHUNKS,
      FTS_MIRROR_MAX_CHUNKS_PER_TICK
    } = await import("../src/lib/rag/fts-mirror-bound");
    let offset = 0;
    let ticks = 0;
    while (offset < FTS_MIRROR_INCIDENT_CHUNKS) {
      ticks += 1;
      const start = offset;
      let doneThisTick = 0;
      let elapsedMs = 0;
      while (offset < FTS_MIRROR_INCIDENT_CHUNKS) {
        const plan = planFtsMirrorSlice({
          totalChunks: FTS_MIRROR_INCIDENT_CHUNKS,
          offset,
          chunksDoneThisTick: doneThisTick,
          elapsedMs
        });
        if (plan.chunkCount <= 0) break;
        offset = plan.end;
        doneThisTick += plan.chunkCount;
        elapsedMs = plan.worstCaseTickWallMs;
      }
      expect(offset - start).toBeLessThanOrEqual(FTS_MIRROR_MAX_CHUNKS_PER_TICK);
      expect(ticks).toBeLessThan(200);
    }
    expect(offset).toBe(FTS_MIRROR_INCIDENT_CHUNKS);
    expect(ticks).toBeGreaterThan(1);
    expect(ticks).toBe(Math.ceil(FTS_MIRROR_INCIDENT_CHUNKS / FTS_MIRROR_MAX_CHUNKS_PER_TICK));
  });

  it("stops on wall-clock even when chunks remain (whichever first)", async () => {
    const { planFtsMirrorSlice, FTS_MIRROR_TICK_BUDGET_MS } = await import("../src/lib/rag/fts-mirror-bound");
    const plan = planFtsMirrorSlice({
      totalChunks: 933,
      offset: 0,
      elapsedMs: FTS_MIRROR_TICK_BUDGET_MS,
      tickBudgetMs: FTS_MIRROR_TICK_BUDGET_MS
    });
    expect(plan.chunkCount).toBe(0);
    expect(plan.stopReason).toBe("tick-budget");
    expect(plan.complete).toBe(false);
  });

  it("does not start a chunk when remaining budget is below expected ms/chunk", async () => {
    const { planFtsMirrorSlice, FTS_MIRROR_INCIDENT_MS_PER_CHUNK } = await import(
      "../src/lib/rag/fts-mirror-bound"
    );
    const plan = planFtsMirrorSlice({
      totalChunks: 933,
      offset: 0,
      elapsedMs: 1_900,
      tickBudgetMs: 2_000,
      msPerChunk: FTS_MIRROR_INCIDENT_MS_PER_CHUNK
    });
    expect(FTS_MIRROR_INCIDENT_MS_PER_CHUNK).toBeGreaterThan(100);
    expect(plan.chunkCount).toBe(0);
    expect(plan.stopReason).toBe("tick-budget");
  });

  it("keeps the FTS tick budget below the getAccounts first wait", async () => {
    const { FTS_MIRROR_TICK_BUDGET_MS } = await import("../src/lib/rag/fts-mirror-bound");
    const { GET_ACCOUNTS_FIRST_MS } = await import("../src/lib/inflight-deadline");
    expect(FTS_MIRROR_TICK_BUDGET_MS).toBeLessThan(GET_ACCOUNTS_FIRST_MS);
  });
});

describe("ftsMirrorLeaseExpiresDuringTick (heartbeat + tick cap)", () => {
  it("the 279s no-heartbeat full-mirror scenario expires a 60s lease", async () => {
    const { ftsMirrorLeaseExpiresDuringTick, FTS_MIRROR_INCIDENT_WALL_MS } = await import(
      "../src/lib/rag/fts-mirror-bound"
    );
    expect(
      ftsMirrorLeaseExpiresDuringTick({
        tickBudgetMs: FTS_MIRROR_INCIDENT_WALL_MS,
        heartbeatIntervalMs: null
      })
    ).toBe(true);
  });

  it("is no longer possible when the tick is capped and the 20s heartbeat runs", async () => {
    const { ftsMirrorLeaseExpiresDuringTick } = await import("../src/lib/rag/fts-mirror-bound");
    expect(ftsMirrorLeaseExpiresDuringTick()).toBe(false);
    expect(
      ftsMirrorLeaseExpiresDuringTick({
        tickBudgetMs: 6_000,
        heartbeatIntervalMs: 20_000,
        leaseMs: 60_000
      })
    ).toBe(false);
    // Even without heartbeat, a 6s tick cannot outlive a 60s lease.
    expect(
      ftsMirrorLeaseExpiresDuringTick({
        tickBudgetMs: 6_000,
        heartbeatIntervalMs: null,
        leaseMs: 60_000
      })
    ).toBe(false);
  });
});

describe("embed_queued FTS slice + durable resume", () => {
  async function seedEmbedQueued(opts: { accession: string; chunks: number; storeAlreadyDone?: boolean }) {
    const { writeLocalArtifact } = await import("../src/lib/web-sources/sec-filings");
    const {
      createSecIngestJob,
      enqueueSecIngestTask,
      claimSecIngestTasks,
      advanceSecIngestTask,
      transitionSecIngestJob
    } = await import("../src/lib/db-rag-ingest");

    const job = createSecIngestJob({
      idempotencyKey: `fts-slice-${opts.accession}`,
      corpusRevision: "corp-v1"
    });
    transitionSecIngestJob(job.id, "running");
    const { task } = enqueueSecIngestTask({
      jobId: job.id,
      accession: opts.accession,
      cik: "0000320193",
      symbol: "AAPL",
      payload: {
        url: `https://www.sec.gov/Archives/edgar/data/320193/${opts.accession.replace(/-/g, "")}/aapl.htm`,
        docType: "10-K",
        filedAt: "2026-07-15",
        acceptanceDateTime: "2026-07-15T21:37:12.000Z"
      }
    });

    const raw = "<html><body>Item 1. Business<p>AAPL makes iPhones.</p></body></html>";
    const chunks = Array.from({ length: opts.chunks }, (_, i) => ({
      content_hash: `hash-${opts.accession}-${i.toString().padStart(4, "0")}`,
      text: `chunk ${i} of ${opts.accession}`
    }));
    await writeLocalArtifact(task.cik, task.accession, 1, "raw-document.html", raw);
    await writeLocalArtifact(task.cik, task.accession, 1, "sections.json", JSON.stringify([{ itemCode: "1", text: raw }]));
    await writeLocalArtifact(task.cik, task.accession, 1, "chunks.json", JSON.stringify(chunks));
    if (opts.storeAlreadyDone) {
      await writeLocalArtifact(
        task.cik,
        task.accession,
        1,
        "storeResult.json",
        JSON.stringify({ skipped: false, attempted: opts.chunks, indexed: opts.chunks, documentComplete: true })
      );
    }

    let claimed = claimSecIngestTasks(job.id, { owner: "test-worker", leaseMs: 60_000, limit: 1 });
    expect(claimed).toHaveLength(1);
    const steps = [
      ["discovered", "fetched"],
      ["fetched", "validated"],
      ["validated", "parsed"],
      ["parsed", "facts_extracted"],
      ["facts_extracted", "chunked"],
      ["chunked", "embed_queued"]
    ] as const;
    for (const [from, to] of steps) {
      expect(
        advanceSecIngestTask({
          taskId: claimed[0]!.id,
          owner: "test-worker",
          leaseToken: claimed[0]!.leaseToken || "",
          expectedCheckpoint: from,
          nextCheckpoint: to,
          receipt: claimed[0]!.payload
        })
      ).toBe(true);
      claimed = claimSecIngestTasks(job.id, { owner: "test-worker", leaseMs: 60_000, limit: 1 });
      expect(claimed).toHaveLength(1);
    }
    return { jobId: job.id, task: claimed[0]! };
  }

  it("writes at most one tick of chunks, stays at embed_queued, and resumes without rewriting the first slice", async () => {
    const { FTS_MIRROR_MAX_CHUNKS_PER_TICK } = await import("../src/lib/rag/fts-mirror-bound");
    const { getSecIngestTask, claimSecIngestTasks } = await import("../src/lib/db-rag-ingest");
    const { storeDocument } = await import("../src/lib/vector-db");
    vi.mocked(storeDocument).mockClear();
    vi.mocked(storeDocument).mockResolvedValue({
      skipped: false,
      attempted: 45,
      indexed: 45,
      documentComplete: true
    } as any);

    const accession = "0000320193-26-000099";
    const { jobId, task } = await seedEmbedQueued({ accession, chunks: 45 });
    const vectorDocId = `${accession}:1:document.html`;
    const worker = new SecIngestWorker();

    await worker.processTask(task);

    const afterFirst = getSecIngestTask(task.id)!;
    expect(afterFirst.checkpoint).toBe("embed_queued");
    expect(afterFirst.status).toBe("retry_wait");
    expect(afterFirst.stageAttempts).toBe(0);
    const firstRows = getDb()
      .prepare("SELECT content_hash FROM document_chunks_fts WHERE accession = ? ORDER BY content_hash")
      .all(vectorDocId) as Array<{ content_hash: string }>;
    expect(firstRows.length).toBe(FTS_MIRROR_MAX_CHUNKS_PER_TICK);
    expect(firstRows[0]!.content_hash).toBe(`hash-${accession}-0000`);
    expect(firstRows.at(-1)!.content_hash).toBe(
      `hash-${accession}-${String(FTS_MIRROR_MAX_CHUNKS_PER_TICK - 1).padStart(4, "0")}`
    );
    expect(vi.mocked(storeDocument)).toHaveBeenCalledTimes(1);

    const reclaimed = claimSecIngestTasks(jobId, {
      owner: "test-worker",
      leaseMs: 60_000,
      limit: 1
    });
    expect(reclaimed).toHaveLength(1);
    await worker.processTask(reclaimed[0]!);

    const afterSecond = getSecIngestTask(task.id)!;
    expect(afterSecond.checkpoint).toBe("embed_queued");
    const secondRows = getDb()
      .prepare("SELECT content_hash FROM document_chunks_fts WHERE accession = ? ORDER BY content_hash")
      .all(vectorDocId) as Array<{ content_hash: string }>;
    expect(secondRows.length).toBe(FTS_MIRROR_MAX_CHUNKS_PER_TICK * 2);
    expect(secondRows.slice(0, FTS_MIRROR_MAX_CHUNKS_PER_TICK).map((r) => r.content_hash)).toEqual(
      firstRows.map((r) => r.content_hash)
    );
    expect(secondRows[FTS_MIRROR_MAX_CHUNKS_PER_TICK]!.content_hash).toBe(
      `hash-${accession}-${String(FTS_MIRROR_MAX_CHUNKS_PER_TICK).padStart(4, "0")}`
    );
    // storeDocument must not run again on the FTS-only resume.
    expect(vi.mocked(storeDocument)).toHaveBeenCalledTimes(1);
  });

  it("finishes a small filing in one tick and advances to embedded", async () => {
    const { getSecIngestTask } = await import("../src/lib/db-rag-ingest");
    const { storeDocument } = await import("../src/lib/vector-db");
    vi.mocked(storeDocument).mockClear();
    vi.mocked(storeDocument).mockResolvedValue({
      skipped: false,
      attempted: 3,
      indexed: 3,
      documentComplete: true
    } as any);

    const accession = "0000320193-26-000098";
    const { task } = await seedEmbedQueued({ accession, chunks: 3, storeAlreadyDone: true });
    const worker = new SecIngestWorker();
    await worker.processTask(task);

    const after = getSecIngestTask(task.id)!;
    expect(after.checkpoint).toBe("embedded");
    expect(after.status).toBe("pending");
    const rows = getDb()
      .prepare("SELECT COUNT(*) AS n FROM document_chunks_fts WHERE accession = ?")
      .get(`${accession}:1:document.html`) as { n: number };
    expect(rows.n).toBe(3);
    expect(vi.mocked(storeDocument)).not.toHaveBeenCalled();
  });

  // 2026-08-23 P0 fix: an incomplete storeDocument result used to ALWAYS throw the generic
  // "Ingestion budget or capacity exceeded mid-task" message, which the runTick catch then
  // dead-lettered with retryable:true — misclassifying a permanent embed rejection (HTTP 400) the
  // same as a transient one (429/connection failure) and requeuing it forever on every worker
  // restart (see the errorLike requeue test above). The worker now fails the task directly with a
  // real errorType/message and classifies retryable-vs-not by what the failure actually is.
  it("dead-letters immediately (not retryable) on a permanent embed rejection (HTTP 400), with the real reason recorded", async () => {
    const { getSecIngestTask } = await import("../src/lib/db-rag-ingest");
    const { storeDocument } = await import("../src/lib/vector-db");
    vi.mocked(storeDocument).mockClear();
    vi.mocked(storeDocument).mockResolvedValue({
      skipped: false,
      attempted: 10,
      indexed: 0,
      documentComplete: false,
      error: "Embedding API failed (isOpenRouter=false): 400 {\"error\":\"invalid input\"}"
    } as any);

    const accession = "0000320193-26-000097";
    const { task } = await seedEmbedQueued({ accession, chunks: 10 });
    const worker = new SecIngestWorker();
    await expect(worker.processTask(task)).resolves.toBeUndefined();

    const after = getSecIngestTask(task.id)!;
    expect(after.checkpoint).toBe("embed_queued");
    expect(after.status).toBe("dead_letter");
    expect(after.lastErrorType).toBe("embed-permanent-error");
    expect(after.lastError).toContain("400");
    const rows = getDb()
      .prepare("SELECT COUNT(*) AS n FROM document_chunks_fts WHERE accession = ?")
      .get(`${accession}:1:document.html`) as { n: number };
    expect(rows.n).toBe(0);
  });

  it("retries (not dead-lettered) on a transient embed failure (HTTP 429), recorded with the real reason", async () => {
    const { getSecIngestTask } = await import("../src/lib/db-rag-ingest");
    const { storeDocument } = await import("../src/lib/vector-db");
    vi.mocked(storeDocument).mockClear();
    vi.mocked(storeDocument).mockResolvedValue({
      skipped: false,
      attempted: 10,
      indexed: 0,
      documentComplete: false,
      error: "Embedding API failed (isOpenRouter=false): 429 {\"error\":\"rate limited\"}"
    } as any);

    const accession = "0000320193-26-000095";
    const { task } = await seedEmbedQueued({ accession, chunks: 10 });
    const worker = new SecIngestWorker();
    await expect(worker.processTask(task)).resolves.toBeUndefined();

    const after = getSecIngestTask(task.id)!;
    expect(after.checkpoint).toBe("embed_queued");
    expect(after.status).toBe("retry_wait");
    expect(after.lastErrorType).toBe("embed-transient-error");
    expect(after.lastError).toContain("429");
  });

  it("retries (not dead-lettered) on a connection failure with no HTTP status at all", async () => {
    const { getSecIngestTask } = await import("../src/lib/db-rag-ingest");
    const { storeDocument } = await import("../src/lib/vector-db");
    vi.mocked(storeDocument).mockClear();
    vi.mocked(storeDocument).mockResolvedValue({
      skipped: false,
      attempted: 10,
      indexed: 0,
      documentComplete: false,
      error: "fetch failed"
    } as any);

    const accession = "0000320193-26-000094";
    const { task } = await seedEmbedQueued({ accession, chunks: 10 });
    const worker = new SecIngestWorker();
    await expect(worker.processTask(task)).resolves.toBeUndefined();

    const after = getSecIngestTask(task.id)!;
    expect(after.status).toBe("retry_wait");
    expect(after.lastErrorType).toBe("embed-transient-error");
  });

  it("runTick claims at most SEC_INGEST_TASKS_PER_TICK tasks across all running jobs", async () => {
    const { SEC_INGEST_TASKS_PER_TICK } = await import("../src/lib/rag/sec-ingest-worker");
    const processed: string[] = [];
    const worker = new SecIngestWorker();
    worker.processTask = async (task) => {
      processed.push(task.id);
    };

    for (let i = 0; i < 3; i++) {
      const job = createSecIngestJob({
        idempotencyKey: `tick-cap-${i}-${randomUUID()}`,
        corpusRevision: "corp-v1"
      });
      transitionSecIngestJob(job.id, "running");
      for (let t = 0; t < 3; t++) {
        enqueueSecIngestTask({
          jobId: job.id,
          accession: `0000320193-26-00020${i}${t}`,
          cik: "0000320193",
          symbol: "AAPL",
          payload: { url: "https://www.sec.gov/x", docType: "10-K", filedAt: "2026-07-15" }
        });
      }
    }

    await worker.runTick();
    expect(processed).toHaveLength(SEC_INGEST_TASKS_PER_TICK);
    expect(SEC_INGEST_TASKS_PER_TICK).toBe(5);
  });

  it("does not claim FTS / ingest work while a strategy run is in flight", async () => {
    const { insertStrategyRun, hasInFlightStrategyWork, finishStrategyRun } = await import(
      "../src/lib/db-execution"
    );
    const processed: string[] = [];
    const worker = new SecIngestWorker();
    worker.processTask = async (task) => {
      processed.push(task.id);
    };

    const job = createSecIngestJob({
      idempotencyKey: `tick-strategy-${randomUUID()}`,
      corpusRevision: "corp-v1"
    });
    transitionSecIngestJob(job.id, "running");
    enqueueSecIngestTask({
      jobId: job.id,
      accession: "0000320193-26-000301",
      cik: "0000320193",
      symbol: "RJF",
      payload: { url: "https://www.sec.gov/x", docType: "10-K", filedAt: "2026-07-15" }
    });

    const runId = randomUUID();
    const userId = `sec-yield-${randomUUID()}`;
    insertStrategyRun(runId, userId);
    expect(hasInFlightStrategyWork()).toBe(true);
    await worker.runTick();
    expect(processed).toHaveLength(0);

    finishStrategyRun(runId, "failed", "test release", userId);
    expect(hasInFlightStrategyWork()).toBe(false);
  });

  it("treats a queued Manual Run request as in-flight strategy work", async () => {
    const { hasInFlightStrategyWork } = await import("../src/lib/db-execution");
    const { queueStrategyRunRequest } = await import("../src/lib/strategy-run-requests");
    const userId = `queued-run-${randomUUID()}`;
    const queued = queueStrategyRunRequest({ userId, manual: true });
    expect(queued.deduped).toBe(false);
    expect(hasInFlightStrategyWork()).toBe(true);
    getDb()
      .prepare("UPDATE strategy_run_requests SET status = 'failed', finished_at = ? WHERE id = ?")
      .run(new Date().toISOString(), queued.request.id);
    expect(hasInFlightStrategyWork()).toBe(false);
  });

  it("defers a daily write-fuse skip instead of throwing capacity-exceeded", async () => {
    const { getSecIngestTask } = await import("../src/lib/db-rag-ingest");
    const { storeDocument } = await import("../src/lib/vector-db");
    vi.mocked(storeDocument).mockClear();
    vi.mocked(storeDocument).mockResolvedValue({
      skipped: true,
      attempted: 10,
      indexed: 0,
      writeUnitBudgetSkipped: 10,
      documentComplete: false
    } as any);

    const accession = "0000320193-26-000096";
    const { task } = await seedEmbedQueued({ accession, chunks: 10 });
    const worker = new SecIngestWorker();
    await worker.processTask(task);

    const after = getSecIngestTask(task.id)!;
    expect(after.checkpoint).toBe("embed_queued");
    expect(after.status).toBe("retry_wait");
    expect(after.lastErrorType).toBe("wu_exhausted_deferred");
    const rows = getDb()
      .prepare("SELECT COUNT(*) AS n FROM document_chunks_fts WHERE accession = ?")
      .get(`${accession}:1:document.html`) as { n: number };
    expect(rows.n).toBe(0);
  });

  it("parks runTick (no claim) when Qdrant daily point fuse is exhausted", async () => {
    process.env.QDRANT_URL = "http://127.0.0.1:6333";
    process.env.RAG_VECTOR_WRITE_BACKEND = "qdrant";
    process.env.RAG_MAX_DAILY_INGEST_POINTS = "1";
    const { recordRagUsage } = await import("../src/lib/rag-metering");
    // Spend the entire daily point fuse so hasRagIngestPointsBudget("local", 1, "qdrant") is false.
    recordRagUsage({
      userId: "local",
      operation: "upsert",
      provider: "qdrant",
      batchCount: 5,
      tokensIn: 0,
      tokensOut: 5
    });

    const processed: string[] = [];
    const worker = new SecIngestWorker();
    worker.processTask = async (task) => {
      processed.push(task.id);
    };

    const job = createSecIngestJob({
      idempotencyKey: `tick-qdrant-fuse-${randomUUID()}`,
      corpusRevision: "corp-v1"
    });
    transitionSecIngestJob(job.id, "running");
    enqueueSecIngestTask({
      jobId: job.id,
      accession: "0000320193-26-000401",
      cik: "0000320193",
      symbol: "AAPL",
      payload: { url: "https://www.sec.gov/x", docType: "10-K", filedAt: "2026-07-15" }
    });

    await worker.runTick();
    expect(processed).toHaveLength(0);

    delete process.env.RAG_VECTOR_WRITE_BACKEND;
    delete process.env.QDRANT_URL;
    delete process.env.RAG_MAX_DAILY_INGEST_POINTS;
  });

  it("defers embed_queued when storeDocument reports ingestPointsBudgetExhausted", async () => {
    const { getSecIngestTask } = await import("../src/lib/db-rag-ingest");
    const { storeDocument } = await import("../src/lib/vector-db");
    vi.mocked(storeDocument).mockClear();
    vi.mocked(storeDocument).mockResolvedValue({
      skipped: true,
      attempted: 10,
      indexed: 0,
      writeUnitBudgetSkipped: 10,
      ingestPointsBudgetExhausted: true,
      ingestPointsBudgetExhaustedUntil: "2026-09-18T12:00:00.000Z",
      documentComplete: false
    } as any);

    const accession = "0000320193-26-000402";
    const { task } = await seedEmbedQueued({ accession, chunks: 10 });
    const worker = new SecIngestWorker();
    await worker.processTask(task);

    const after = getSecIngestTask(task.id)!;
    expect(after.checkpoint).toBe("embed_queued");
    expect(after.status).toBe("retry_wait");
    expect(after.lastErrorType).toBe("wu_exhausted_deferred");
    expect(after.lastError).toMatch(/Qdrant daily point/i);
  });

  it("parks embed_queued before any embed when the daily text budget is already spent", async () => {
    const { getSecIngestTask } = await import("../src/lib/db-rag-ingest");
    const { storeDocument, hasIngestTextBudget } = await import("../src/lib/vector-db");
    vi.mocked(storeDocument).mockClear();
    vi.mocked(hasIngestTextBudget).mockReturnValueOnce(false);

    const accession = "0000320193-26-000403";
    const { task } = await seedEmbedQueued({ accession, chunks: 10 });
    const worker = new SecIngestWorker();
    await worker.processTask(task);

    const after = getSecIngestTask(task.id)!;
    expect(vi.mocked(storeDocument)).not.toHaveBeenCalled();
    expect(after.checkpoint).toBe("embed_queued");
    expect(after.status).toBe("retry_wait");
    expect(after.lastErrorType).toBe("wu_exhausted_deferred");
    expect(after.lastError).toMatch(/text embed budget/i);
  });

  it("defers embed_queued when storeDocument reports ingestTextBudgetExhausted", async () => {
    const { getSecIngestTask } = await import("../src/lib/db-rag-ingest");
    const { storeDocument } = await import("../src/lib/vector-db");
    vi.mocked(storeDocument).mockClear();
    vi.mocked(storeDocument).mockResolvedValue({
      skipped: true,
      attempted: 10,
      indexed: 0,
      budgetSkipped: 10,
      ingestTextBudgetExhausted: true,
      ingestTextBudgetExhaustedUntil: "2026-09-18T12:00:00.000Z",
      documentComplete: false
    } as any);

    const accession = "0000320193-26-000404";
    const { task } = await seedEmbedQueued({ accession, chunks: 10 });
    const worker = new SecIngestWorker();
    await worker.processTask(task);

    const after = getSecIngestTask(task.id)!;
    expect(after.checkpoint).toBe("embed_queued");
    expect(after.status).toBe("retry_wait");
    expect(after.lastErrorType).toBe("wu_exhausted_deferred");
    expect(after.lastError).toMatch(/text embed budget/i);
  });

});
