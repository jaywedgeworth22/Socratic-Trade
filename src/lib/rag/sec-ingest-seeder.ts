// sec-ingest-seeder.ts — turns the frozen SEC/RAG universe manifest into SecIngestWorker jobs/tasks.
//
// This is the "discovery" stage the checkpoint state machine itself does not do: SecIngestWorker's
// tasks start life already at checkpoint 'discovered' (see enqueueSecIngestTask in db-rag-ingest.ts)
// and its first checkpoint ('discovered' -> 'fetched') only FETCHES a document whose accession/url is
// already known. Something has to translate "issuer N in the manifest" into "these accessions, these
// primary-document URLs" — that's this module, via fetchRecentFilings (EDGAR submissions API).
//
// Baseline scope per issuer: latest 10-K + latest 4 10-Qs, primary document only (no exhibits) — one
// task per document, sequence=1 (matches the worker's multi-document vectorDocId scheme, which only
// matters when a single accession queues more than one document).
//
// IDEMPOTENCY: one job per issuer per (corpusRevision, manifest snapshotId). The job's
// idempotencyKey is buildSecIngestJobKey({corpusRevision, universeSnapshotId, scope: {cik}}) — a
// stable natural key already enforced UNIQUE at the DB layer (sec_ingest_jobs.idempotency_key), so
// createSecIngestJob is a safe no-op replay. Each task's key is similarly derived from
// (accession, sequence, documentName) and enforced UNIQUE per job — re-seeding never duplicates rows.
//
// DEAD-LETTER DISCIPLINE: once a job's intake is sealed (sealSecIngestJobIntake), enqueueSecIngestTask
// refuses to add more tasks to it — by construction, a sealed job can never be re-driven by a later
// seed call. This function treats "intake already closed" as the sole re-seed guard: it skips
// re-fetching EDGAR and re-enqueuing entirely for that issuer, whether the job finished (complete),
// finished with permanently dead-lettered documents (complete_with_errors), or is still actively
// working through its already-sealed task list (running). A genuinely new attempt (e.g. after a
// parser fix) requires a new corpusRevision or manifest snapshotId — a new natural key, not a mutation
// of the old job. This is the guard against the non-terminating backfill loop that burned a sister
// app $1,153: nothing here ever retries a dead-lettered document automatically.
import path from "node:path";
import fs from "node:fs";
import {
  createSecIngestJob,
  enqueueSecIngestTask,
  sealSecIngestJobIntake,
  transitionSecIngestJob,
  buildSecIngestJobKey
} from "../db-rag-ingest";
import { fetchRecentFilings } from "../web-sources/sec-filings";
import { blockingUniverseValidationIssues, validateSecUniverseManifest, type FrozenSecUniverseManifest } from "./universe-manifest";
import { assertOperationLeaseOwnership, type OperationLeaseClaim } from "../operation-lease";
import { collectSecIngestPrioritySets, resolveSecIngestPriority } from "./sec-ingest-priority";

/** Stable, versioned identity for the baseline "latest 10-K + latest 4 10-Qs" backfill scope. Bump
 *  this (not the numbers below) if the baseline scope itself ever changes, so old and new scopes
 *  get distinct jobs instead of silently redefining an already-sealed job's contract. */
export const SEC_INGEST_BASELINE_CORPUS_REVISION = "sec-ingest-baseline-10k-4x10q-v1";

const DEFAULT_TEN_K_LIMIT = 1;
const DEFAULT_TEN_Q_LIMIT = 4;

/** Job-level terminal states. A job can in principle reach failed_terminal/canceled without its
 *  intake ever having been sealed (e.g. an external caller fails it before this seeder finishes) —
 *  enqueueSecIngestTask would throw against any of these, so this is checked alongside
 *  `intakeClosedAt` rather than relying on the seal check alone. */
const SEC_INGEST_JOB_TERMINAL_STATUSES = new Set(["complete", "complete_with_errors", "failed_terminal", "canceled"]);

export interface SeedSecIngestJobsOptions {
  /** Path to the manifest JSON on disk. Defaults to data/rag-universe-manifest.json. Ignored when
   *  `manifest` is provided directly (tests). */
  manifestPath?: string;
  /** Pre-loaded, pre-validated manifest — bypasses reading/validating from disk (tests). */
  manifest?: FrozenSecUniverseManifest;
  /** Skip the first N issuers by manifest rank. */
  offset?: number;
  /** Consider at most this many issuers (after offset). Omit for "all remaining". */
  limit?: number;
  /** Restrict to these CIKs (10-digit, zero-padded) rather than a rank range. */
  issuerCiks?: string[];
  corpusRevision?: string;
  tenKLimit?: number;
  tenQLimit?: number;
  /** Inherited from an outer admin operation guard; checked between issuers so a lost/cancelled
   *  lease stops the run promptly instead of continuing to hammer EDGAR. */
  operationLeaseClaim?: OperationLeaseClaim;
  /** History/deepen pass: symbols outside held/watchlist/scan get priority DEEPEN (10) instead of UNIVERSE_LATEST (40). */
  deepen?: boolean;
}

export interface SeedSecIngestIssuerResult {
  cik: string;
  ticker: string;
  rank: number;
  jobId: string;
  /** True when this issuer's job already had its intake sealed by a prior seed call — no EDGAR
   *  discovery or enqueue was attempted this run. */
  alreadySeeded: boolean;
  tasksEnqueued: number;
  /** True when EDGAR discovery ran but returned zero 10-K/10-Q filings. Intake is deliberately left
   *  OPEN (not sealed) in this case — see the module comment on why a zero result must not be
   *  treated as permanent. */
  noFilingsFound?: boolean;
}

export interface SeedSecIngestJobsResult {
  manifestSnapshotId: string;
  corpusRevision: string;
  considered: number;
  alreadySeeded: number;
  newlySeeded: number;
  totalTasksEnqueued: number;
  /** CIKs where discovery ran but found nothing — surfaced so an operator can decide whether that's
   *  a genuine no-10-K/10-Q issuer (e.g. a foreign private issuer on 20-F/40-F) or worth retrying. */
  issuersWithNoFilings: string[];
  issuers: SeedSecIngestIssuerResult[];
}

function loadManifest(opts: SeedSecIngestJobsOptions): FrozenSecUniverseManifest {
  if (opts.manifest) return opts.manifest;
  const manifestPath = opts.manifestPath ?? path.resolve("data/rag-universe-manifest.json");
  const raw = fs.readFileSync(manifestPath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  // Only BLOCKING issues refuse the manifest — an advisory "warning" (e.g. a manifest frozen
  // before dataQuality existed) must not stop discovery from running against otherwise-valid data.
  const issues = blockingUniverseValidationIssues(validateSecUniverseManifest(parsed));
  if (issues.length > 0) {
    const first = issues[0]!;
    throw new Error(
      `Refusing to seed from an invalid SEC universe manifest (${manifestPath}): ${issues.length} issue(s), ` +
      `e.g. ${first.code} ${first.path}: ${first.message}`
    );
  }
  return parsed as FrozenSecUniverseManifest;
}

export async function seedSecIngestJobsFromManifest(
  opts: SeedSecIngestJobsOptions = {}
): Promise<SeedSecIngestJobsResult> {
  const manifest = loadManifest(opts);
  const corpusRevision = opts.corpusRevision ?? SEC_INGEST_BASELINE_CORPUS_REVISION;
  const tenKLimit = opts.tenKLimit ?? DEFAULT_TEN_K_LIMIT;
  const tenQLimit = opts.tenQLimit ?? DEFAULT_TEN_Q_LIMIT;

  let selected = manifest.issuers;
  if (opts.issuerCiks && opts.issuerCiks.length > 0) {
    const wanted = new Set(opts.issuerCiks);
    selected = selected.filter((issuer) => wanted.has(issuer.cik));
  }
  const offset = Math.max(0, Math.floor(opts.offset ?? 0));
  selected = opts.limit !== undefined ? selected.slice(offset, offset + Math.max(0, Math.floor(opts.limit))) : selected.slice(offset);

  const issuerResults: SeedSecIngestIssuerResult[] = [];
  const issuersWithNoFilings: string[] = [];
  let alreadySeeded = 0;
  let newlySeeded = 0;
  let totalTasksEnqueued = 0;

  // Money-path priority overlay: claim is ORDER BY priority DESC; without this every task
  // stays at default 0 and the desk's held/watchlist/scan names wait behind the universe tail.
  const prioritySets = collectSecIngestPrioritySets();
  const deepen = opts.deepen === true;

  for (const issuer of selected) {
    if (opts.operationLeaseClaim) assertOperationLeaseOwnership(opts.operationLeaseClaim);

    const idempotencyKey = buildSecIngestJobKey({
      corpusRevision,
      universeSnapshotId: manifest.snapshotId,
      scope: { cik: issuer.cik, baseline: "10k-4x10q" }
    });

    const job = createSecIngestJob({
      idempotencyKey,
      corpusRevision,
      universeSnapshotId: manifest.snapshotId,
      config: { cik: issuer.cik, ticker: issuer.ticker, rank: issuer.rank, baseline: "10k-4x10q" }
    });

    if (job.intakeClosedAt || SEC_INGEST_JOB_TERMINAL_STATUSES.has(job.status)) {
      alreadySeeded++;
      issuerResults.push({ cik: issuer.cik, ticker: issuer.ticker, rank: issuer.rank, jobId: job.id, alreadySeeded: true, tasksEnqueued: 0 });
      continue;
    }

    // Single submissions-API call for both docTypes: fetchRecentFilings accepts a per-docType
    // limit map, so this no longer issues two identical requests to the same CIK's EDGAR
    // submissions URL (previously one call for 10-K, one for 10-Q — ~1,000 requests saved per
    // full seed of the 1,000-issuer universe).
    const refs = await fetchRecentFilings(issuer.cik, ["10-K", "10-Q"], { "10-K": tenKLimit, "10-Q": tenQLimit });

    if (refs.length === 0) {
      // Leave intake open: fetchRecentFilings collapses "genuinely no filings" and "transient EDGAR
      // failure" to the same empty array, and sealing here would permanently close discovery on a
      // possibly-transient miss. A future seed call for this same issuer/manifest/corpusRevision will
      // simply retry discovery (job.intakeClosedAt is still null).
      issuersWithNoFilings.push(issuer.cik);
      issuerResults.push({ cik: issuer.cik, ticker: issuer.ticker, rank: issuer.rank, jobId: job.id, alreadySeeded: false, tasksEnqueued: 0, noFilingsFound: true });
      continue;
    }

    let tasksEnqueued = 0;
    refs.forEach((ref, index) => {
      const { inserted } = enqueueSecIngestTask({
        jobId: job.id,
        accession: ref.accession,
        cik: issuer.cik,
        symbol: issuer.ticker,
        sequence: 1,
        documentName: ref.primaryDoc || "document.html",
        ordinal: index,
        priority: resolveSecIngestPriority(issuer.ticker, prioritySets, { deepen }),
        payload: {
          url: ref.url,
          docType: ref.docType,
          filedAt: ref.filedAt,
          acceptanceDateTime: ref.acceptanceDateTime
        }
      });
      if (inserted) tasksEnqueued++;
    });

    // Seal against the job's ACTUAL task count (no explicit expected count): if a prior partial run
    // enqueued tasks EDGAR no longer returns, refs.length would mismatch and the seal would fail,
    // leaving a permanently unreconcilable open-intake job. sealSecIngestJobIntake's no-argument
    // form freezes expected_tasks at whatever intake actually produced.
    sealSecIngestJobIntake(job.id);
    transitionSecIngestJob(job.id, "running", { expected: "pending" });

    newlySeeded++;
    totalTasksEnqueued += tasksEnqueued;
    issuerResults.push({ cik: issuer.cik, ticker: issuer.ticker, rank: issuer.rank, jobId: job.id, alreadySeeded: false, tasksEnqueued });
  }

  return {
    manifestSnapshotId: manifest.snapshotId,
    corpusRevision,
    considered: selected.length,
    alreadySeeded,
    newlySeeded,
    totalTasksEnqueued,
    issuersWithNoFilings,
    issuers: issuerResults
  };
}
