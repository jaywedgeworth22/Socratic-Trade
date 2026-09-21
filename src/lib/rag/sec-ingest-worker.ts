import {
  claimSecIngestTasks,
  advanceSecIngestTask,
  deferSecIngestTask,
  failSecIngestTask,
  heartbeatSecIngestTask,
  reconcileSecIngestJob,
  releaseSecIngestTaskForResume,
  requeueSecIngestDeadLetters,
  SecIngestTask
} from "../db-rag-ingest";
import { pineconeWuExhaustedUntil } from "../pinecone-wu-breaker";
import { pineconeBackfillPaceGate } from "../pinecone-monthly-pace";
import { hasRagIngestPointsBudget, ragIngestPointsBudgetDeferUntil } from "../rag-metering";
import { vectorWriteBackend } from "../vector-store/qdrant-write";
import { politeFetchText } from "../web-sources/http";
import { timeSync, yieldEventLoop } from "../slow-sync-guard";
import { shouldDeferRagIngestDuringRth } from "../sqlite-event-loop";
import { parseFilingHtml } from "../web-sources/sec-parser";
import { ingestCompanyFacts, parseAndSaveForm4 } from "../web-sources/sec-facts";
import { storeDocument, classifyEmbedFailure } from "../vector-db";
import { readLocalArtifact, writeLocalArtifact } from "../web-sources/sec-filings";
import { insertDocumentChunkFtsBatch, countDocumentChunkFts, ftsMirrorResumeOffset, getDb } from "../db";
import { hasInFlightStrategyWork } from "../db-execution";
import { serverKnobBool } from "../server-knobs";
import { chunkDocument } from "./chunk";
import { buildSecDocument } from "./sec-document";
import {
  FTS_MIRROR_HEARTBEAT_MS,
  FTS_MIRROR_MAX_CHUNKS_PER_TICK,
  FTS_MIRROR_TICK_BUDGET_MS,
  planFtsMirrorSlice
} from "./fts-mirror-bound";

interface CachedFtsRows {
  rows: Array<{
    contentHash: string;
    symbol: string;
    source: string;
    accession: string;
    text: string;
  }>;
  cachedAt: number;
}

const ftsRowsCache = new Map<string, CachedFtsRows>();

function getFtsCacheKey(taskId: string, cik: string, accession: string, sequence: number): string {
  return `${taskId}:${cik}:${accession}:${sequence}`;
}

export function clearFtsRowsCacheForTests(): void {
  ftsRowsCache.clear();
}

/** Hard cap on tasks one tick may claim+process.  Prod has ~500 running jobs; claiming
 *  5 per job let a single tick lease thousands of facts_extracted rows and hang for
 *  hours on chunkDocument, so later jobs never ran (2156 pending since 2026-08-10). */
export const SEC_INGEST_TASKS_PER_TICK = 5;

export class SecIngestWorker {
  private active = false;
  private intervalId: NodeJS.Timeout | null = null;
  private workerId = `worker:${crypto.randomUUID().slice(0, 8)}`;
  private tickInFlight = false;

  constructor(private intervalMs = 5000) {}

  async start() {
    if (this.active) return;
    this.active = true;
    // Prod dead-lettered ~1k embed_queued filings as "Ingestion budget or capacity
    // exceeded mid-task" instead of parking them.  Requeue only that misclassified
    // error so they resume when the daily WU fuse has room.  Other dead letters stay.
    try {
      const revived = requeueSecIngestDeadLetters({
        errorTypeLike: "worker-error",
        errorLike: "Ingestion budget or capacity exceeded%"
      });
      if (revived.requeuedTasks > 0) {
        console.warn(
          `[SecIngestWorker] requeued ${revived.requeuedTasks} budget-misclassified dead letters (${revived.reopenedJobs} jobs reopened)`
        );
      }
    } catch (error) {
      console.warn(
        "[SecIngestWorker] budget-dead-letter requeue failed:",
        error instanceof Error ? error.message : String(error)
      );
    }
    // Serialize ticks: fetching/embedding routinely outlasts intervalMs, and an unguarded
    // interval would start overlapping runTick() calls that claim extra batches and run
    // EDGAR/Voyage/Pinecone work concurrently. Skip the tick while one is still in flight.
    this.intervalId = setInterval(() => {
      // Server-knob park: while SEC_INGEST_WORKER_ENABLED resolves off, the loop stays alive but
      // skips ticks, so an Admin > Operations flip resumes ingest within one interval + knob-cache
      // TTL — no redeploy.  Cheap: the knob read is cached (~15s) between ticks.
      if (!secIngestWorkerEnabled()) return;
      if (process.env.NODE_ENV !== "test" && shouldDeferRagIngestDuringRth()) return;
      if (this.tickInFlight) return;
      this.tickInFlight = true;
      void this.runTick()
        .catch((err) => console.error("[SecIngestWorker] Tick failed:", err instanceof Error ? err.message : String(err)))
        .finally(() => {
          this.tickInFlight = false;
        });
    }, this.intervalMs);
  }

  async stop() {
    this.active = false;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  /** One polling pass. Public (like `processTask`) so tests can drive a single tick
   *  deterministically instead of racing the 5s interval. */
  async runTick(options?: { allowRth?: boolean }) {
    // Live b3b83913: 78 ftsMirrorSlice ticks (6–13s) starved gather/Green.  Do not claim
    // more ingest / FTS work while a Manual Run once or strategy run is on this loop.
    if (hasInFlightStrategyWork()) return;

    // Defend event loop during active market hours (RTH). Multi-megabyte SEC HTML parsing
    // and vector embedding pin the Node thread, delaying quote cascades and trade execution.
    if (!options?.allowRth && process.env.NODE_ENV !== "test" && shouldDeferRagIngestDuringRth()) return;

    // Monthly write-unit PACE guard. This queue IS the bulk/backfill lane, so it is the one
    // producer the pace guard throttles: when the month-end projection exceeds
    // PINECONE_MONTHLY_WU_BUDGET we simply stop CLAIMING NEW tasks. Already-leased tasks are
    // untouched (their leases expire and they become claimable again once the throttle lifts or
    // the month rolls over), incremental filing ingest keeps running, and retrieval is never
    // affected. Default-off: with no budget configured this is an env read and nothing else.
    const paceGate = vectorWriteBackend() === "qdrant"
      ? { throttled: false as const }
      : await pineconeBackfillPaceGate("backfill");
    if (paceGate.throttled) return;

    // Qdrant daily point fuse: park the whole tick (no claim) instead of soft-skipping
    // thousands of storeDocument warns once the rolling 24h budget is spent.
    if (vectorWriteBackend() === "qdrant" && !hasRagIngestPointsBudget("local", 1, "qdrant")) {
      return;
    }

    const db = getDb();
    const activeJobs = db.prepare("SELECT id FROM sec_ingest_jobs WHERE status = 'running'").all() as any[];

    let remaining = SEC_INGEST_TASKS_PER_TICK;
    for (const job of activeJobs) {
      if (remaining <= 0) break;
      const tasks = claimSecIngestTasks(job.id, {
        owner: this.workerId,
        leaseMs: 60000,
        limit: remaining
      });

      for (const task of tasks) {
        // Each task chains synchronous extract/chunk/persist segments; yield between tasks so
        // queued HTTP requests get served (2026-08-10 event-loop stall incident).
        await yieldEventLoop();
        try {
          await this.processTask(task);
        } catch (err: any) {
          console.error(`[SecIngestWorker] Task ${task.id} failed:`, err.message);
          failSecIngestTask({
            taskId: task.id,
            owner: this.workerId,
            leaseToken: task.leaseToken || "",
            retryable: true,
            errorType: "worker-error",
            error: err.message
          });
        }
      }

      remaining -= tasks.length;

      // Nothing else flips a job from 'running' to a terminal status once its tasks finish — the
      // seeder seals intake up front but does not itself watch for completion. Reconcile here (cheap,
      // idempotent no-op unless intake is sealed and every task has reached a terminal status) so a
      // job whose tasks all completed/dead-lettered doesn't sit at 'running' forever.
      reconcileSecIngestJob(job.id);
    }
  }

  async processTask(task: SecIngestTask) {
    const leaseToken = task.leaseToken || "";
    const owner = task.leaseOwner || this.workerId;
    const documentName = task.documentName || "document.html";
    const sequence = task.sequence ?? 1;

    const heartbeat = () => {
      heartbeatSecIngestTask({
        taskId: task.id,
        owner,
        leaseToken,
        leaseMs: 60000
      });
    };

    // Multi-document accessions: a filing can queue several documents (primary HTML, exhibits,
    // ownership XML), each its own task with a distinct sequence/documentName. The vector
    // document id must carry that identity: storeDocument defaults its managed-ledger
    // documentKey to doc_id and keeps only ONE active head per (tenant_scope, source,
    // document_key), so a bare-accession id would let document B's commit supersede document
    // A's vectors — and every document's chunks would collide on `<accession>#c001` citations.
    const vectorDocId = `${task.accession}:${sequence}:${documentName}`;

    const checkpoint = task.checkpoint;

    if (checkpoint === "discovered") {
      heartbeat();
      let content = await readLocalArtifact(task.cik, task.accession, sequence, `raw-${documentName}`);
      if (!content) {
        try {
          content = await politeFetchText(task.payload.url as string);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          // EDGAR 403 = IP-level automated-access block, not a fault of this task. Mirror the
          // WU-breaker deferral (attempt refunded) instead of failing: exponential failure
          // backoff would burn all stage attempts into a block that outlives them and
          // dead-letter healthy filings — which is exactly what happened on 2026-08-09.
          if (/^HTTP 403 /.test(msg)) {
            const { secLimiter } = await import("../web-sources/sec-limiter");
            const until = secLimiter.pausedUntilIso() ?? new Date(Date.now() + 10 * 60_000).toISOString();
            deferSecIngestTask({
              taskId: task.id,
              owner,
              leaseToken,
              deferUntil: until,
              reasonType: "edgar_403_deferred",
              reason: `EDGAR 403 (automated-access block); deferred until ${until}`
            });
            return;
          }
          throw err;
        }
        await writeLocalArtifact(task.cik, task.accession, sequence, `raw-${documentName}`, content);
        // writeLocalArtifact swallows filesystem errors, so the await above does not prove the raw
        // filing was persisted. Verify before advancing: otherwise every retry starts from
        // `fetched`, reads a missing artifact, and dead-letters a recoverable filing.
        const persisted = await readLocalArtifact(task.cik, task.accession, sequence, `raw-${documentName}`);
        if (persisted === null || persisted.length !== content.length) {
          throw new Error("Raw artifact write verification failed (artifact missing or truncated)");
        }
      }

      const ok = advanceSecIngestTask({
        taskId: task.id,
        owner,
        leaseToken,
        expectedCheckpoint: "discovered",
        nextCheckpoint: "fetched",
        receipt: task.payload
      });
      if (!ok) throw new Error("Failed to advance checkpoint from discovered to fetched");
      return;
    }

    if (checkpoint === "fetched") {
      heartbeat();
      const content = await readLocalArtifact(task.cik, task.accession, sequence, `raw-${documentName}`);
      if (!content || content.length < 100) {
        throw new Error("Validation failed: empty or tiny content");
      }
      const ok = advanceSecIngestTask({
        taskId: task.id,
        owner,
        leaseToken,
        expectedCheckpoint: "fetched",
        nextCheckpoint: "validated",
        receipt: task.payload
      });
      if (!ok) throw new Error("Failed to advance checkpoint from fetched to validated");
      return;
    }

    if (checkpoint === "validated") {
      heartbeat();
      const content = await readLocalArtifact(task.cik, task.accession, sequence, `raw-${documentName}`);
      if (!content) throw new Error("Raw content artifact missing");

      let sections: any[];
      if (documentName.endsWith(".xml")) {
        sections = [{ itemCode: "0", itemTitle: "XML Document", text: content }];
      } else {
        // Yield before and after heavy Cheerio parsing so I/O, health checks, and timers can breathe
        await yieldEventLoop();
        // Form-aware title canonicalization: only a proven 10-K gets the 10-K
        // Item-code -> title map; other forms keep raw parsed titles.
        const parsed = parseFilingHtml(content, {
          formType: typeof task.payload.docType === "string" ? task.payload.docType : undefined
        });
        await yieldEventLoop();
        sections = parsed.sections;
      }
      await writeLocalArtifact(task.cik, task.accession, sequence, "sections.json", JSON.stringify(sections));

      const ok = advanceSecIngestTask({
        taskId: task.id,
        owner,
        leaseToken,
        expectedCheckpoint: "validated",
        nextCheckpoint: "parsed",
        receipt: task.payload
      });
      if (!ok) throw new Error("Failed to advance checkpoint from validated to parsed");
      return;
    }

    if (checkpoint === "parsed") {
      heartbeat();
      const content = await readLocalArtifact(task.cik, task.accession, sequence, `raw-${documentName}`);
      if (!content) throw new Error("Raw content artifact missing");

      if (documentName.endsWith(".xml")) {
        parseAndSaveForm4(content, task.cik, task.accession);
      } else {
        await ingestCompanyFacts(task.cik);
      }
      const ok = advanceSecIngestTask({
        taskId: task.id,
        owner,
        leaseToken,
        expectedCheckpoint: "parsed",
        nextCheckpoint: "facts_extracted",
        receipt: task.payload
      });
      if (!ok) throw new Error("Failed to advance checkpoint from parsed to facts_extracted");
      return;
    }

    if (checkpoint === "facts_extracted") {
      heartbeat();
      const rawContent = await readLocalArtifact(task.cik, task.accession, sequence, `raw-${documentName}`);
      const sectionsJson = await readLocalArtifact(task.cik, task.accession, sequence, "sections.json");
      if (!rawContent || !sectionsJson) throw new Error("Parsed/Raw artifacts missing");

      const sections = timeSync("worker.parseSectionsJson", `${Math.round(sectionsJson.length / 1024)}KB`, () => JSON.parse(sectionsJson));
      // Same builder as incremental ingestFiling: parsed section text, never raw HTML.
      const doc = buildSecDocument({
        rawContent,
        sections,
        documentName,
        ticker: task.symbol,
        docId: vectorDocId,
        title: `${task.symbol} ${task.payload.docType || "Filing"}`,
        docType: typeof task.payload.docType === "string" ? task.payload.docType : "filing",
        publishedAt: task.payload.filedAt as string,
        ...(typeof task.payload.acceptanceDateTime === "string" && task.payload.acceptanceDateTime
          ? { acceptanceDateTime: task.payload.acceptanceDateTime }
          : {})
      });

      const chunks = chunkDocument(doc, { maxTokens: 400, overlapRatio: 0.15 });
      await writeLocalArtifact(task.cik, task.accession, sequence, "chunks.json", JSON.stringify(chunks));
      // NOTE: FTS rows are deliberately NOT written here. Lexical indexing happens in the
      // embed_queued stage AFTER storeDocument commits, so retrieval can never surface chunks
      // from a document that failed or is still retrying its vector commit.

      const ok = advanceSecIngestTask({
        taskId: task.id,
        owner,
        leaseToken,
        expectedCheckpoint: "facts_extracted",
        nextCheckpoint: "chunked",
        receipt: task.payload
      });
      if (!ok) throw new Error("Failed to advance checkpoint from facts_extracted to chunked");
      return;
    }

    if (checkpoint === "chunked") {
      heartbeat();
      const ok = advanceSecIngestTask({
        taskId: task.id,
        owner,
        leaseToken,
        expectedCheckpoint: "chunked",
        nextCheckpoint: "embed_queued",
        receipt: task.payload
      });
      if (!ok) throw new Error("Failed to advance checkpoint from chunked to embed_queued");
      return;
    }

    if (checkpoint === "embed_queued") {
      heartbeat();
      const storeResultJson = await readLocalArtifact(task.cik, task.accession, sequence, "storeResult.json");
      const ftsAlreadyStarted =
        countDocumentChunkFts({ symbol: task.symbol, source: "sec-edgar", accession: vectorDocId }) > 0;
      const storeAlreadyDone = Boolean(storeResultJson) || ftsAlreadyStarted;

      // Monthly Pinecone write-unit breaker: park BEFORE spending a single embed token.
      // Skip the gate when storeDocument already completed this stage — FTS writes are
      // local SQLite and must not be blocked by a Pinecone quota we already paid.
      if (!storeAlreadyDone && vectorWriteBackend() === "pinecone") {
        const wuUntil = pineconeWuExhaustedUntil();
        if (wuUntil) {
          deferSecIngestTask({
            taskId: task.id,
            owner,
            leaseToken,
            deferUntil: wuUntil,
            reasonType: "wu_exhausted_deferred",
            reason: `Pinecone monthly write units exhausted; deferred until ${wuUntil}`
          });
          return;
        }
      }
      // Qdrant daily point fuse: same clean deferral as the Pinecone WU park — do not
      // soft-skip mid-store thousands of times once the rolling 24h budget is spent.
      if (!storeAlreadyDone && vectorWriteBackend() === "qdrant") {
        if (!hasRagIngestPointsBudget("local", 1, "qdrant")) {
          const until = ragIngestPointsBudgetDeferUntil();
          deferSecIngestTask({
            taskId: task.id,
            owner,
            leaseToken,
            deferUntil: until,
            reasonType: "wu_exhausted_deferred",
            reason: `Qdrant daily point ingest fuse spent; deferred until ${until}`
          });
          return;
        }
      }
      let doc: ReturnType<typeof buildSecDocument> | undefined;
      if (!storeAlreadyDone) {
        const rawContent = await readLocalArtifact(task.cik, task.accession, sequence, `raw-${documentName}`);
        const sectionsJson = await readLocalArtifact(task.cik, task.accession, sequence, "sections.json");
        if (!rawContent || !sectionsJson) throw new Error("Parsed/Raw artifacts missing");

        const sections = timeSync("worker.parseSectionsJson", `${Math.round(sectionsJson.length / 1024)}KB`, () => JSON.parse(sectionsJson));
        doc = buildSecDocument({
          rawContent,
          sections,
          documentName,
          ticker: task.symbol,
          docId: vectorDocId,
          title: `${task.symbol} ${task.payload.docType || "Filing"}`,
          docType: typeof task.payload.docType === "string" ? task.payload.docType : "filing",
          publishedAt: task.payload.filedAt as string,
          ...(typeof task.payload.acceptanceDateTime === "string" && task.payload.acceptanceDateTime
            ? { acceptanceDateTime: task.payload.acceptanceDateTime }
            : {})
        });
      }

      // Heartbeat across storeDocument AND the FTS mirror.  #2680 yielded inside the
      // batch helper but left this interval covering only storeDocument; a 88-279s
      // mirror then expired the 60s lease and checkpoint advance failed.
      const leaseHeartbeat = setInterval(heartbeat, FTS_MIRROR_HEARTBEAT_MS);
      leaseHeartbeat.unref?.();
      try {
        if (!storeAlreadyDone && doc) {
          const res = await storeDocument(doc, "local", {
            maxTokens: 400,
            overlapRatio: 0.15
          });

          if (!res.documentComplete) {
            // Breaker tripped mid-call (raced the gate above): same clean deferral, not a failure.
            if (res.wuExhausted) {
              deferSecIngestTask({
                taskId: task.id,
                owner,
                leaseToken,
                deferUntil: res.wuExhaustedUntil ?? new Date(Date.now() + 6 * 60 * 60_000).toISOString(),
                reasonType: "wu_exhausted_deferred",
                reason: `Pinecone monthly write units exhausted mid-store; deferred until ${res.wuExhaustedUntil ?? "next check"}`
              });
              return;
            }
            if (res.ingestPointsBudgetExhausted) {
              deferSecIngestTask({
                taskId: task.id,
                owner,
                leaseToken,
                deferUntil: res.ingestPointsBudgetExhaustedUntil ?? ragIngestPointsBudgetDeferUntil(),
                reasonType: "wu_exhausted_deferred",
                reason: `Qdrant daily point ingest fuse spent mid-store; deferred until ${res.ingestPointsBudgetExhaustedUntil ?? "next check"}`
              });
              return;
            }
            if ((res.writeUnitBudgetSkipped ?? 0) > 0 || (res.budgetSkipped ?? 0) > 0) {
              deferSecIngestTask({
                taskId: task.id,
                owner,
                leaseToken,
                deferUntil: new Date(Date.now() + 60 * 60_000).toISOString(),
                reasonType: "wu_exhausted_deferred",
                reason: "Daily write fuse or ingest text budget spent; deferred 1h"
              });
              return;
            }
            // A real embed/store failure, not a budget/quota condition — classify it by what it
            // actually is instead of collapsing it into the generic "budget or capacity exceeded"
            // message that every failure used to get. That message was then unconditionally
            // requeued on every worker restart (see requeueSecIngestDeadLetters call in start()
            // above), so a permanent HTTP 400 — which can never succeed on retry — was
            // dead-lettered and revived forever instead of being flagged (2026-08-23 P0; prod
            // dead-lettered ~1k filings, buried under 8,036 misleading "budget reached" Sentry
            // warnings in 2 days per SOCRATIC-TRADE-27/-1X).  Fail the task directly (rather than
            // throwing into the generic catch below, which always used retryable:true) so a
            // permanent failure dead-letters immediately with its real reason, and only a genuinely
            // transient one (429/connection/5xx) consumes a bounded retry.
            const failureReason =
              res.error?.trim() ||
              res.embedFailureMessage?.trim() ||
              "storeDocument returned an incomplete result with no error detail";
            const failureClass = classifyEmbedFailure(failureReason);
            failSecIngestTask({
              taskId: task.id,
              owner,
              leaseToken,
              retryable: failureClass !== "permanent",
              errorType: failureClass === "permanent" ? "embed-permanent-error" : "embed-transient-error",
              error: failureReason
            });
            return;
          }

          await writeLocalArtifact(task.cik, task.accession, sequence, "storeResult.json", JSON.stringify(res));
        }

        // Lexical (FTS) indexing happens HERE — only after storeDocument reported a complete
        // committed document — so hybrid retrieval can never surface chunks whose vector commit
        // failed or is still retrying. insertDocumentChunkFts is idempotent per occurrence
        // (delete+insert keyed on symbol/source/accession/hash).  The worker now feeds the
        // batch helper a bounded slice per tick; insertDocumentChunkFtsBatch keeps its
        // internal 250ms yield.  Resume cursor is the durable FTS row count.
        const cacheKey = getFtsCacheKey(task.id, task.cik, task.accession, sequence);
        let ftsRows = ftsRowsCache.get(cacheKey)?.rows;
        if (!ftsRows) {
          const chunksJson = await readLocalArtifact(task.cik, task.accession, sequence, "chunks.json");
          let ftsChunks: Array<{ content_hash: string; text: string }>;
          if (chunksJson) {
            ftsChunks = JSON.parse(chunksJson);
          } else {
            if (!doc) {
              const rawContent = await readLocalArtifact(task.cik, task.accession, sequence, `raw-${documentName}`);
              const sectionsJson = await readLocalArtifact(task.cik, task.accession, sequence, "sections.json");
              if (!rawContent || !sectionsJson) throw new Error("Parsed/Raw artifacts missing");
              const sections = timeSync("worker.parseSectionsJson", `${Math.round(sectionsJson.length / 1024)}KB`, () => JSON.parse(sectionsJson));
              doc = buildSecDocument({
                rawContent,
                sections,
                documentName,
                ticker: task.symbol,
                docId: vectorDocId,
                title: `${task.symbol} ${task.payload.docType || "Filing"}`,
                docType: typeof task.payload.docType === "string" ? task.payload.docType : "filing",
                publishedAt: task.payload.filedAt as string,
                ...(typeof task.payload.acceptanceDateTime === "string" && task.payload.acceptanceDateTime
                  ? { acceptanceDateTime: task.payload.acceptanceDateTime }
                  : {})
              });
            }
            ftsChunks = chunkDocument(doc, { maxTokens: 400, overlapRatio: 0.15 });
          }
          ftsRows = ftsChunks.map((chunk) => ({
            contentHash: chunk.content_hash,
            symbol: task.symbol,
            source: "sec-edgar",
            accession: vectorDocId,
            text: chunk.text
          }));
          if (ftsRowsCache.size >= 50) {
            const oldestKey = ftsRowsCache.keys().next().value;
            if (oldestKey) ftsRowsCache.delete(oldestKey);
          }
          ftsRowsCache.set(cacheKey, { rows: ftsRows, cachedAt: Date.now() });
        }

        const tickStartedAt = Date.now();
        // Resume on CONTENT, never on a row COUNT.  `document_chunks_fts_index` is keyed on
        // `content_hash`, so duplicate chunk text inside one filing collapses to a single row and
        // a count-derived offset stalls there permanently — the 2026-09-09 event-loop stall, where
        // hsy-20260329 restarted at 400/508 on all 29 logged slices across six days.
        const startOffset = ftsMirrorResumeOffset(ftsRows, {
          symbol: task.symbol,
          source: "sec-edgar",
          accession: vectorDocId
        });
        let offset = startOffset;
        while (offset < ftsRows.length) {
          if (hasInFlightStrategyWork()) break;
          const plan = planFtsMirrorSlice({
            totalChunks: ftsRows.length,
            offset,
            chunksDoneThisTick: offset - startOffset,
            elapsedMs: Date.now() - tickStartedAt
          });
          if (plan.chunkCount <= 0) break;
          await insertDocumentChunkFtsBatch(ftsRows.slice(plan.offset, plan.end));
          offset = plan.end;
          heartbeat();
          if (offset < ftsRows.length) await yieldEventLoop();
        }

        const ftsMirrorMs = Date.now() - tickStartedAt;
        if (ftsMirrorMs >= 1_000) {
          console.log(
            `[worker] ftsMirrorSlice took ${ftsMirrorMs}ms for ${vectorDocId} (${startOffset}->${offset}/${ftsRows.length} chunks, cap ${FTS_MIRROR_MAX_CHUNKS_PER_TICK}/${FTS_MIRROR_TICK_BUDGET_MS}ms)`
          );
        }

        const progress = {
          ftsMirrorOffset: offset,
          ftsMirrorTotal: ftsRows.length,
          vectorDocId
        };
        await writeLocalArtifact(
          task.cik,
          task.accession,
          sequence,
          "fts-progress.json",
          JSON.stringify(progress)
        );

        if (offset < ftsRows.length) {
          const released = releaseSecIngestTaskForResume({
            taskId: task.id,
            owner,
            leaseToken,
            reasonType: "fts_mirror_sliced",
            reason: `FTS mirror paused at ${offset}/${ftsRows.length} (tick budget ${FTS_MIRROR_TICK_BUDGET_MS}ms / ${FTS_MIRROR_MAX_CHUNKS_PER_TICK} chunks)`,
            receipt: { ...task.payload, ...progress }
          });
          if (!released.applied) {
            throw new Error("Failed to release embed_queued task after partial FTS mirror");
          }
          return;
        }

        const ok = advanceSecIngestTask({
          taskId: task.id,
          owner,
          leaseToken,
          expectedCheckpoint: "embed_queued",
          nextCheckpoint: "embedded",
          receipt: { ...task.payload, ...progress }
        });
        ftsRowsCache.delete(cacheKey);
        if (!ok) throw new Error("Failed to advance checkpoint from embed_queued to embedded");
        return;
      } finally {
        clearInterval(leaseHeartbeat);
      }
    }

    if (checkpoint === "embedded") {
      heartbeat();
      const ok = advanceSecIngestTask({
        taskId: task.id,
        owner,
        leaseToken,
        expectedCheckpoint: "embedded",
        nextCheckpoint: "index_queued",
        receipt: task.payload
      });
      if (!ok) throw new Error("Failed to advance checkpoint from embedded to index_queued");
      return;
    }

    if (checkpoint === "index_queued") {
      heartbeat();
      const ok = advanceSecIngestTask({
        taskId: task.id,
        owner,
        leaseToken,
        expectedCheckpoint: "index_queued",
        nextCheckpoint: "indexed",
        receipt: task.payload
      });
      if (!ok) throw new Error("Failed to advance checkpoint from index_queued to indexed");
      return;
    }

    if (checkpoint === "indexed") {
      heartbeat();
      const ok = advanceSecIngestTask({
        taskId: task.id,
        owner,
        leaseToken,
        expectedCheckpoint: "indexed",
        nextCheckpoint: "verified",
        receipt: task.payload
      });
      if (!ok) throw new Error("Failed to advance checkpoint from indexed to verified");
      return;
    }

    if (checkpoint === "verified") {
      heartbeat();
      const storeResultJson = await readLocalArtifact(task.cik, task.accession, sequence, "storeResult.json");
      if (!storeResultJson) throw new Error("storeResult artifact missing");
      const res = JSON.parse(storeResultJson);

      const ok = advanceSecIngestTask({
        taskId: task.id,
        owner,
        leaseToken,
        expectedCheckpoint: "verified",
        nextCheckpoint: "complete",
        observations: {
          chunks: res?.indexed ?? 0,
          tokens: (res?.attempted ?? 0) * 400
        },
        verification: { verified: true },
        receipt: task.payload
      });
      if (!ok) throw new Error("Failed to advance checkpoint from verified to complete");
      return;
    }
  }
}

// ── Process-level singleton wiring ──────────────────────────────────────────
// Mirrors the self-gated singleton pattern used by startCongressStream (congress-stream.ts) and the
// shutdown-hook registration pattern used by durable-state.ts: opt-in via env, idempotent start,
// globalThis-pinned so Next.js HMR / a test runner's module re-evaluation cannot spawn a second
// interval or register duplicate signal handlers on the one real process.

/** Opt-in gate (default OFF). The durable checkpoint state machine and DB primitives
 *  (db-rag-ingest.ts) are production-ready, but nothing seeds jobs automatically — jobs only exist
 *  after an explicit POST /api/admin/sec-ingest {action:"seed"} call. See
 *  docs/rollouts/2026-07-18-sec-ingest-worker-wiring.md. Now a server knob (Admin > Operations DB
 *  override > SEC_INGEST_WORKER_ENABLED env > off) so the loop can be parked/resumed at runtime. */
export function secIngestWorkerEnabled(): boolean {
  return serverKnobBool("SEC_INGEST_WORKER_ENABLED");
}

type SecIngestWorkerHost = typeof globalThis & {
  __secIngestWorkerInstance?: SecIngestWorker;
  __secIngestWorkerShutdownHooksRegistered?: boolean;
};
const host = globalThis as SecIngestWorkerHost;

function registerSecIngestShutdownHooksOnce(): void {
  if (host.__secIngestWorkerShutdownHooksRegistered) return;
  host.__secIngestWorkerShutdownHooksRegistered = true;
  const shutdown = () => {
    void stopSecIngestWorker();
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

/** Idempotent: start the SEC ingest worker loop once. Called unconditionally from
 *  background-worker-startup.ts. The loop itself checks secIngestWorkerEnabled() every tick and
 *  parks while it resolves off, so the SEC_INGEST_WORKER_ENABLED server knob can pause/resume the
 *  worker at runtime without a redeploy. */
export function startSecIngestWorker(): void {
  if (host.__secIngestWorkerInstance) return;
  const worker = new SecIngestWorker();
  host.__secIngestWorkerInstance = worker;
  registerSecIngestShutdownHooksOnce();
  void worker.start();
}

/** Stop the worker (tests / graceful shutdown). No-op if never started. */
export async function stopSecIngestWorker(): Promise<void> {
  const worker = host.__secIngestWorkerInstance;
  if (!worker) return;
  host.__secIngestWorkerInstance = undefined;
  await worker.stop();
}
