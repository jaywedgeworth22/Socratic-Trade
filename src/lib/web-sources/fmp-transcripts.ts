// FMP earnings-call transcript ingestion -> shared RAG corpus.
//
// Safety invariants:
//  - Default OFF until the operator confirms FMP endpoint access and transcript storage/display rights.
//  - Uses only the current stable transcript-dates + transcript-body endpoints.
//  - Authentication is an HTTP header. API keys, response bodies, and request URLs are never logged.
//  - Every actual FMP request crosses fetchWithRetry; HTTP 200 outcomes are metered only after
//    bounded JSON validation, so malformed provider bodies cannot create false-green telemetry.
//  - A transcript's call date is event metadata, NOT an availability timestamp. Point-in-time retrieval
//    uses the first time this app observed non-empty transcript content.
//  - Empty/transient responses never enter the ingestion ledger and therefore remain retryable.

import crypto from "crypto";
import { CircuitOpenError } from "../api-circuit-breaker";
import { fetchWithRetry, apiKeyFingerprint } from "../data-providers";
import { audit, getDb, hasIngestedAccession } from "../db";
import { rankHighInterestSymbols } from "../rag/demand-first-symbols";
import { resolveApiKeyWithSource } from "../db-api-keys";
import { logApiHealth } from "../db-health";
import {
  cancelUndispatchedProviderReservation,
  markProviderDispatchStarted,
  reserveProviderDispatch,
  settleProviderDispatch
} from "../db-provider-dispatch";
import { ingestedAccessionCountForDocType } from "../db-learning";
import {
  deleteInternalSetting,
  getInternalSetting,
  setInternalSetting
} from "../db-settings";
import {
  getFmpTranscriptVersion,
  observeFmpTranscriptVersion,
  runWithActiveVectorCommitProof,
  setFmpTranscriptVersionState
} from "../db-vector-commits";
import { normalizeSymbol } from "../money";
import {
  assertOperationLeaseOwnership,
  OPERATION_LEASE_GROUPS,
  runWithOperationLease,
  throwIfOperationLeaseCancelled,
  type OperationLeaseClaim,
  type OperationLeaseAware
} from "../operation-lease";
import { resolveProviderQuota, withProviderLimit } from "../provider-rate-limit";

export const FMP_TRANSCRIPT_DOC_TYPE = "earnings-transcript";
export const FMP_TRANSCRIPT_SOURCE = "fmp-earnings-transcript";

const FMP_STABLE_BASE = "https://financialmodelingprep.com/stable";
const LAST_ATTEMPT_KEY = "webSource:fmpTranscripts:lastAttemptAt";
const NEXT_ATTEMPT_KEY = "webSource:fmpTranscripts:nextAttemptAt";
const CURSOR_KEY = "webSource:fmpTranscripts:cursor";
const CAPABILITY_KEY = "webSource:fmpTranscripts:capability";
const BODY_RETRY_ACCESSION_KEY = "webSource:fmpTranscripts:bodyRetryAccession";
const EMBED_RETRY_ACCESSION_KEY = "webSource:fmpTranscripts:embedRetryAccession";
const OBSERVATION_PREFIX = "webSource:fmpTranscripts:observation:";
const DEFAULT_TTL_HOURS = 24;
const DEFAULT_RETRY_MINUTES = 60;
const DEFAULT_NOT_ENTITLED_RETRY_HOURS = 24;
const DEFAULT_REQUESTS_PER_RUN = 12;
const DEFAULT_TRANSCRIPTS_PER_SYMBOL = 2;
const DEFAULT_HTTP_RETRIES = 1;
const DEFAULT_RETRY_DELAY_MS = 600;
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_DATES_RESPONSE_BYTES = 1_000_000;
const DEFAULT_TRANSCRIPT_RESPONSE_BYTES = 8_000_000;
const MIN_TRANSCRIPT_CHARS = 100;
const MAX_DATES_ROWS = 5_000;
const MAX_BODY_ROWS = 20;
const OVERSIZED_RESPONSE_ERROR = "HTTP 200 response exceeded the configured byte limit.";
const INVALID_JSON_RESPONSE_ERROR = "HTTP 200 response body was invalid or incomplete JSON/UTF-8.";
const INVALID_PAYLOAD_RESPONSE_ERROR = "HTTP 200 response body did not match the expected FMP endpoint schema.";

export type FmpTranscriptCapability =
  | "disabled"
  | "unknown"
  | "available"
  | "endpoint_not_entitled"
  | "access_denied";

export interface FmpTranscriptCapabilityObservation {
  status: Exclude<FmpTranscriptCapability, "disabled" | "unknown">;
  checkedAt: string;
  httpStatus?: number;
}

export interface FmpTranscriptStatus {
  featureEnabled: boolean;
  storageRightsConfirmed: boolean;
  enabled: boolean;
  due: boolean;
  capability: FmpTranscriptCapability;
  lastCapability?: FmpTranscriptCapabilityObservation;
  lastAttemptAt?: string;
  nextAttemptAt?: string;
  ingestedCount: number;
}

export interface FmpTranscriptRef {
  symbol: string;
  year: number;
  quarter: number;
  /** The earnings-call date reported by FMP. This is not an availability timestamp. */
  callDate?: string;
}

export interface FmpTranscriptBody extends FmpTranscriptRef {
  content: string;
}

export interface FmpTranscriptObservation {
  accession: string;
  symbol: string;
  year: number;
  quarter: number;
  /** First time the transcript-period row was returned by the dates endpoint. */
  discoveredAt: string;
  /** First time this app actually received non-empty transcript content. PIT anchor for RAG. */
  firstContentSeenAt?: string;
  /** Provider-reported call date. Event metadata only. */
  callDate?: string;
}

export interface RefreshFmpTranscriptsResult {
  enabled: boolean;
  capability: FmpTranscriptCapability;
  disabledReason?: "feature_off" | "storage_rights_unconfirmed";
  requests: number;
  symbolsAttempted: number;
  transcriptsAttempted: number;
  ingested: number;
  skippedExisting: number;
  retryableEmpty: number;
  deferredForRequestBudget: number;
  deferredForProviderQuota: number;
  deferredForEmbedBudget: number;
  errors: string[];
}

export interface RefreshFmpTranscriptOptions {
  /** Bypass cadence only. The default-off feature gate still applies. */
  force?: boolean;
  /** Explicit run cap for bounded admin/tests; normal scheduler calls use the env/default cap. */
  maxRequests?: number;
  userId?: string;
}

interface RequestBudget {
  remaining: number;
  used: number;
}

type FmpRequestFailureKind =
  | "request_budget"
  | "provider_quota"
  | "endpoint_not_entitled"
  | "access_denied"
  | "response_too_large"
  | "transient"
  | "permanent";

type FmpRequestResult =
  | { ok: true; payload: unknown; receivedAt: string }
  | { ok: false; kind: FmpRequestFailureKind; status?: number; circuitOpen?: boolean };

class ResponseTooLargeError extends Error {
  constructor() {
    super("Provider response exceeded the configured byte limit.");
    this.name = "ResponseTooLargeError";
  }
}

class InvalidEndpointPayloadError extends Error {
  constructor() {
    super("Provider response did not match the expected endpoint schema.");
    this.name = "InvalidEndpointPayloadError";
  }
}

type FmpEndpointPayloadKind = "dates" | "body";

function finiteNumber(raw: unknown): number | undefined {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : undefined;
  if (typeof raw !== "string" || !raw.trim() || !/^-?\d+(?:\.\d+)?$/.test(raw.trim())) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function positiveNumber(raw: unknown, fallback: number): number {
  const parsed = finiteNumber(raw);
  return parsed !== undefined && parsed > 0 ? parsed : fallback;
}

function positiveInt(raw: unknown, fallback: number, max: number): number {
  return Math.min(max, Math.max(1, Math.floor(positiveNumber(raw, fallback))));
}

function nonNegativeInt(raw: unknown, fallback: number, max: number): number {
  const parsed = finiteNumber(raw);
  return parsed !== undefined && parsed >= 0
    ? Math.min(max, Math.floor(parsed))
    : fallback;
}

function ttlMs(): number {
  return positiveNumber(process.env.FMP_TRANSCRIPT_TTL_HOURS, DEFAULT_TTL_HOURS) * 60 * 60_000;
}

function retryMs(): number {
  return positiveNumber(process.env.FMP_TRANSCRIPT_RETRY_MINUTES, DEFAULT_RETRY_MINUTES) * 60_000;
}

function notEntitledRetryMs(): number {
  return positiveNumber(
    process.env.FMP_TRANSCRIPT_NOT_ENTITLED_RETRY_HOURS,
    DEFAULT_NOT_ENTITLED_RETRY_HOURS
  ) * 60 * 60_000;
}

function maxRequestsPerRun(): number {
  return nonNegativeInt(process.env.FMP_TRANSCRIPT_MAX_REQUESTS_PER_RUN, DEFAULT_REQUESTS_PER_RUN, 500);
}

function maxTranscriptsPerSymbol(): number {
  return positiveInt(process.env.FMP_TRANSCRIPT_MAX_PER_SYMBOL, DEFAULT_TRANSCRIPTS_PER_SYMBOL, 8);
}

/**
 * Latest-only until that period is stored; extra history only for held/watchlist
 * names.  Universe-tail names do not spend the run re-fetching already-stored calls.
 */
export function fmpTranscriptCapThisVisit(opts: {
  latestStored: boolean;
  highInterest: boolean;
  maxPerSymbol: number;
}): number {
  if (!opts.latestStored) return 1;
  if (opts.highInterest) return Math.max(1, opts.maxPerSymbol);
  return 0;
}

function httpRetries(): number {
  return nonNegativeInt(process.env.FMP_TRANSCRIPT_HTTP_RETRIES, DEFAULT_HTTP_RETRIES, 3);
}

function retryDelayMs(): number {
  const value = finiteNumber(process.env.FMP_TRANSCRIPT_RETRY_DELAY_MS);
  return value !== undefined && value >= 0 ? Math.min(10_000, value) : DEFAULT_RETRY_DELAY_MS;
}

function timeoutMs(): number {
  return positiveInt(process.env.FMP_TRANSCRIPT_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 120_000);
}

function datesResponseBytes(): number {
  return positiveInt(
    process.env.FMP_TRANSCRIPT_DATES_MAX_RESPONSE_BYTES,
    DEFAULT_DATES_RESPONSE_BYTES,
    10_000_000
  );
}

function transcriptResponseBytes(): number {
  return positiveInt(
    process.env.FMP_TRANSCRIPT_BODY_MAX_RESPONSE_BYTES,
    DEFAULT_TRANSCRIPT_RESPONSE_BYTES,
    25_000_000
  );
}

function flagOn(raw: string | undefined): boolean {
  return ["1", "true", "on", "yes"].includes(String(raw ?? "").trim().toLowerCase());
}

export function fmpTranscriptStorageRightsConfirmed(
  raw: string | undefined = process.env.FMP_TRANSCRIPT_STORAGE_RIGHTS_CONFIRMED
): boolean {
  return flagOn(raw);
}

/**
 * Two explicit opt-ins for the transcript *machinery* (rights + feature flags).
 * Even when both are on, requestFmpJson is hard-blocked — Socratic-Trade never
 * opens a socket to FMP (owner 2026-08-04). Keep the dual-opt-in so rights /
 * inventory / purge tooling and contract tests stay meaningful.
 */
export function fmpTranscriptsEnabled(
  featureRaw: string | undefined = process.env.WEB_SOURCE_FMP_TRANSCRIPTS,
  rightsRaw: string | undefined = process.env.FMP_TRANSCRIPT_STORAGE_RIGHTS_CONFIRMED
): boolean {
  return flagOn(featureRaw) && fmpTranscriptStorageRightsConfirmed(rightsRaw);
}

export interface FmpTranscriptRightsGenerationClaim {
  generation: number;
}

export interface FmpTranscriptDerivedProvenance {
  source: typeof FMP_TRANSCRIPT_SOURCE;
  docType: typeof FMP_TRANSCRIPT_DOC_TYPE;
  vectorId?: string;
  accession?: string;
}

export type FmpTranscriptDerivedArtifactType = "chat-turn" | "strategy-decision" | "strategy-proposal" | "audit-event";

interface FmpTranscriptRightsGateRow {
  generation: number;
  status: "active" | "revoked";
  updated_at: string;
}

interface FmpTranscriptDerivedArtifactRow {
  id: string;
  artifact_type: FmpTranscriptDerivedArtifactType;
  artifact_id: string;
  user_id: string;
  generation: number;
  provenance: string;
  created_at: string;
}

const FMP_DERIVED_PROVIDER_WORK_LEASE_MS = 30 * 60_000;

function fmpDerivedProviderWorkLeaseExpiresAt(now = Date.now()): string {
  return new Date(now + FMP_DERIVED_PROVIDER_WORK_LEASE_MS).toISOString();
}

/**
 * The versioned migration installs this schema at boot so account-deletion triggers cover it. This
 * defensive ensure also supports isolated/legacy databases before any provider work. A revoked row
 * is never reactivated merely because an environment flag later changes.
 */
function ensureFmpTranscriptRightsGate(database = getDb()): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS fmp_transcript_rights_gate (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
      generation INTEGER NOT NULL CHECK(generation > 0),
      status TEXT NOT NULL CHECK(status IN ('active','revoked')),
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS fmp_transcript_derived_artifacts (
      id TEXT PRIMARY KEY,
      artifact_type TEXT NOT NULL CHECK(artifact_type IN ('chat-turn','strategy-decision','strategy-proposal','audit-event')),
      artifact_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      generation INTEGER NOT NULL CHECK(generation > 0),
      provenance TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(artifact_type, artifact_id)
    );
    CREATE TABLE IF NOT EXISTS fmp_transcript_derived_provider_work (
      id TEXT PRIMARY KEY,
      artifact_type TEXT NOT NULL CHECK(artifact_type IN ('strategy-decision')),
      artifact_id TEXT NOT NULL,
      user_id TEXT,
      vector_id TEXT,
      provider_authority TEXT,
      ledger_authority TEXT,
      generation INTEGER NOT NULL CHECK(generation > 0),
      status TEXT NOT NULL CHECK(status IN ('pending','complete')),
      created_at TEXT NOT NULL,
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_fmp_transcript_derived_artifacts_type
      ON fmp_transcript_derived_artifacts (artifact_type, artifact_id);
    CREATE INDEX IF NOT EXISTS idx_fmp_transcript_derived_provider_work_status
      ON fmp_transcript_derived_provider_work (status, created_at);
  `);
  const providerWorkColumns = database.prepare(
    "PRAGMA table_info(fmp_transcript_derived_provider_work)"
  ).all() as Array<{ name: string }>;
  if (!providerWorkColumns.some((column) => column.name === "lease_expires_at")) {
    database.exec("ALTER TABLE fmp_transcript_derived_provider_work ADD COLUMN lease_expires_at TEXT");
  }
  if (!providerWorkColumns.some((column) => column.name === "terminal_outcome")) {
    database.exec("ALTER TABLE fmp_transcript_derived_provider_work ADD COLUMN terminal_outcome TEXT");
  }
  if (!providerWorkColumns.some((column) => column.name === "user_id")) {
    database.exec("ALTER TABLE fmp_transcript_derived_provider_work ADD COLUMN user_id TEXT");
  }
  if (!providerWorkColumns.some((column) => column.name === "vector_id")) {
    database.exec("ALTER TABLE fmp_transcript_derived_provider_work ADD COLUMN vector_id TEXT");
  }
  if (!providerWorkColumns.some((column) => column.name === "provider_authority")) {
    database.exec("ALTER TABLE fmp_transcript_derived_provider_work ADD COLUMN provider_authority TEXT");
  }
  if (!providerWorkColumns.some((column) => column.name === "ledger_authority")) {
    database.exec("ALTER TABLE fmp_transcript_derived_provider_work ADD COLUMN ledger_authority TEXT");
  }
  database.exec(`
    UPDATE fmp_transcript_derived_provider_work
    SET user_id = (
      SELECT a.user_id FROM fmp_transcript_derived_artifacts a
      WHERE a.artifact_type = fmp_transcript_derived_provider_work.artifact_type
        AND a.artifact_id = fmp_transcript_derived_provider_work.artifact_id
    )
    WHERE user_id IS NULL;
    UPDATE fmp_transcript_derived_provider_work
    SET lease_expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+30 minutes')
    WHERE status = 'pending' AND lease_expires_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_fmp_transcript_derived_provider_work_lease
      ON fmp_transcript_derived_provider_work (status, lease_expires_at);
  `);
  const existing = database.prepare(`
    SELECT generation, status, updated_at
    FROM fmp_transcript_rights_gate WHERE singleton = 1
  `).get() as FmpTranscriptRightsGateRow | undefined;
  if (existing) return;
  const now = new Date().toISOString();
  database.prepare(`
    INSERT INTO fmp_transcript_rights_gate (singleton, generation, status, updated_at)
    VALUES (1, 1, ?, ?)
  `).run(fmpTranscriptStorageRightsConfirmed() ? "active" : "revoked", now);
}

function readFmpTranscriptRightsGate(database = getDb()): FmpTranscriptRightsGateRow {
  ensureFmpTranscriptRightsGate(database);
  const row = database.prepare(`
    SELECT generation, status, updated_at
    FROM fmp_transcript_rights_gate WHERE singleton = 1
  `).get() as FmpTranscriptRightsGateRow | undefined;
  if (!row) throw new Error("FMP transcript rights gate is unavailable.");
  return row;
}

/** Capture the durable generation only while both operator rights and the durable gate allow use. */
export function captureFmpTranscriptRightsGeneration(): FmpTranscriptRightsGenerationClaim | undefined {
  if (!fmpTranscriptStorageRightsConfirmed()) return undefined;
  const row = readFmpTranscriptRightsGate();
  return row.status === "active" ? { generation: row.generation } : undefined;
}

/** Explicit operator reactivation seam. Purge never calls this and flags alone cannot reactivate. */
export function activateFmpTranscriptRightsGeneration(): FmpTranscriptRightsGenerationClaim {
  if (!fmpTranscriptStorageRightsConfirmed()) {
    throw new Error("FMP transcript storage/display rights must be confirmed before rights activation.");
  }
  const database = getDb();
  ensureFmpTranscriptRightsGate(database);
  return database.transaction(() => {
    const current = readFmpTranscriptRightsGate(database);
    if (current.status === "active") return { generation: current.generation };
    const next = current.generation + 1;
    database.prepare(`
      UPDATE fmp_transcript_rights_gate
      SET generation = ?, status = 'active', updated_at = ? WHERE singleton = 1
    `).run(next, new Date().toISOString());
    return { generation: next };
  }).immediate();
}

export function assertFmpTranscriptRightsGeneration(
  claim: FmpTranscriptRightsGenerationClaim,
  database = getDb()
): void {
  const current = readFmpTranscriptRightsGate(database);
  if (
    !fmpTranscriptStorageRightsConfirmed() ||
    current.status !== "active" ||
    current.generation !== claim.generation
  ) {
    throw new Error("FMP transcript rights generation is revoked or stale.");
  }
}

function revokeFmpTranscriptRightsGeneration(database = getDb()): FmpTranscriptRightsGenerationClaim {
  ensureFmpTranscriptRightsGate(database);
  return database.transaction(() => {
    const current = readFmpTranscriptRightsGate(database);
    if (current.status === "revoked") return { generation: current.generation };
    const next = current.generation + 1;
    database.prepare(`
      UPDATE fmp_transcript_rights_gate
      SET generation = ?, status = 'revoked', updated_at = ? WHERE singleton = 1
    `).run(next, new Date().toISOString());
    return { generation: next };
  }).immediate();
}

function exactString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Extract only explicit source/doc-type identity; never infer licensed provenance from raw text. */
export function fmpTranscriptDerivedProvenance(values: readonly unknown[]): FmpTranscriptDerivedProvenance[] {
  const exact = new Map<string, FmpTranscriptDerivedProvenance>();
  for (const value of values) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const row = value as Record<string, unknown>;
    const source = exactString(row.source);
    const docType = exactString(row.doc_type ?? row.docType)?.toLowerCase();
    // FMP-derived means FMP-SOURCED. The "earnings-transcript" doc type is shared with the
    // independently-gated EarningsCalls.dev producer (source "earningscalls-dev" — see
    // earningscalls-gate.ts), so doc type alone only implies FMP when the row carries NO
    // explicit source identity (conservative fallback for legacy rows). A row that declares a
    // different source is that source's rights lane, not FMP's — classifying it here made the
    // strategy throw "FMP-derived strategy context has no active rights generation" whenever
    // an EarningsCalls chunk was retrieved without the FMP rights claim (Codex review, PR #1680).
    const fmpDerived =
      source === FMP_TRANSCRIPT_SOURCE ||
      (source === undefined && docType === FMP_TRANSCRIPT_DOC_TYPE);
    if (!fmpDerived) continue;
    const vectorId = exactString(row.chunk_id ?? row.chunkId ?? row.vectorId ?? row.id);
    const accession = exactString(row.accession ?? row.doc_id);
    const key = `${vectorId ?? ""}\u0000${accession ?? ""}`;
    exact.set(key, {
      source: FMP_TRANSCRIPT_SOURCE,
      docType: FMP_TRANSCRIPT_DOC_TYPE,
      ...(vectorId ? { vectorId } : {}),
      ...(accession ? { accession } : {})
    });
  }
  return [...exact.values()].sort((a, b) =>
    `${a.vectorId ?? ""}:${a.accession ?? ""}`.localeCompare(`${b.vectorId ?? ""}:${b.accession ?? ""}`)
  );
}

export function persistFmpTranscriptDerivedArtifact<T>(input: {
  claim: FmpTranscriptRightsGenerationClaim;
  artifactType: FmpTranscriptDerivedArtifactType;
  artifactId: string | ((value: T) => string);
  userId: string;
  provenance: readonly FmpTranscriptDerivedProvenance[];
  providerWorkId?: string;
  providerVectorId?: string;
  providerAuthority?: string;
  ledgerAuthority?: string;
  write: () => T;
}): T {
  const provenance = fmpTranscriptDerivedProvenance(input.provenance);
  if (provenance.length === 0) return input.write();
  const database = getDb();
  ensureFmpTranscriptRightsGate(database);
  return database.transaction(() => {
    assertFmpTranscriptRightsGeneration(input.claim, database);
    const value = input.write();
    const artifactId = typeof input.artifactId === "function" ? input.artifactId(value) : input.artifactId;
    if (!artifactId.trim()) throw new Error("FMP derived artifact identity is required.");
    database.prepare(`
      INSERT INTO fmp_transcript_derived_artifacts (
        id, artifact_type, artifact_id, user_id, generation, provenance, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(artifact_type, artifact_id) DO UPDATE SET
        user_id = excluded.user_id,
        generation = excluded.generation,
        provenance = excluded.provenance,
        created_at = excluded.created_at
    `).run(
      crypto.randomUUID(),
      input.artifactType,
      artifactId,
      input.userId,
      input.claim.generation,
      JSON.stringify(provenance),
      new Date().toISOString()
    );
    if (input.providerWorkId) {
      if (input.artifactType !== "strategy-decision") {
        throw new Error("Only strategy decisions may reserve FMP-derived provider work.");
      }
      const providerVectorId = input.providerVectorId?.trim();
      if (!providerVectorId) {
        throw new Error("FMP-derived provider work requires an exact vector identity.");
      }
      const providerAuthority = input.providerAuthority?.trim();
      const ledgerAuthority = input.ledgerAuthority?.trim();
      if (!providerAuthority || !ledgerAuthority) {
        throw new Error("FMP-derived provider work requires exact provider and ledger authority.");
      }
      database.prepare(`
        INSERT INTO fmp_transcript_derived_provider_work (
          id, artifact_type, artifact_id, user_id, vector_id, provider_authority, ledger_authority,
          generation, status, created_at, completed_at, lease_expires_at, terminal_outcome
        ) VALUES (?, 'strategy-decision', ?, ?, ?, ?, ?, ?, 'pending', ?, NULL, ?, NULL)
        ON CONFLICT(id) DO UPDATE SET
          artifact_id = excluded.artifact_id,
          user_id = excluded.user_id,
          vector_id = excluded.vector_id,
          provider_authority = excluded.provider_authority,
          ledger_authority = excluded.ledger_authority,
          generation = excluded.generation,
          status = 'pending',
          created_at = excluded.created_at,
          completed_at = NULL,
          lease_expires_at = excluded.lease_expires_at,
          terminal_outcome = NULL
      `).run(
        input.providerWorkId,
        artifactId,
        input.userId,
        providerVectorId,
        providerAuthority,
        ledgerAuthority,
        input.claim.generation,
        new Date().toISOString(),
        fmpDerivedProviderWorkLeaseExpiresAt()
      );
    }
    return value;
  }).immediate();
}

/** Prove both rights generation and the unexpired durable work token at every provider boundary. */
export function assertFmpTranscriptDerivedProviderWorkOwnership(
  workId: string,
  claim: FmpTranscriptRightsGenerationClaim,
  database = getDb()
): void {
  assertFmpTranscriptRightsGeneration(claim, database);
  ensureFmpTranscriptRightsGate(database);
  const row = database.prepare(`
    SELECT generation, status, lease_expires_at
    FROM fmp_transcript_derived_provider_work WHERE id = ?
  `).get(workId) as {
    generation: number;
    status: "pending" | "complete";
    lease_expires_at: string | null;
  } | undefined;
  const expiresAt = Date.parse(row?.lease_expires_at ?? "");
  if (
    !row ||
    row.generation !== claim.generation ||
    row.status !== "pending" ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= Date.now()
  ) {
    throw new Error("FMP transcript derived provider-work lease is stale or lost.");
  }
}

/** Terminal provider-work receipt. It may settle after revocation so a blocked purge can retry. */
export function completeFmpTranscriptDerivedProviderWork(
  workId: string,
  terminalOutcome: "completed" | "no_provider_write" | "provider_write_unknown" = "completed"
): void {
  if (!workId.trim()) return;
  const database = getDb();
  ensureFmpTranscriptRightsGate(database);
  database.prepare(`
    UPDATE fmp_transcript_derived_provider_work
    SET status = 'complete', completed_at = ?, terminal_outcome = ?
    WHERE id = ? AND status = 'pending'
  `).run(new Date().toISOString(), terminalOutcome, workId);
}

/** Keep a live async provider call distinguishable from a process that died after reserving it. */
export function renewFmpTranscriptDerivedProviderWork(
  workId: string,
  claim: FmpTranscriptRightsGenerationClaim
): boolean {
  if (!workId.trim()) return false;
  const database = getDb();
  ensureFmpTranscriptRightsGate(database);
  return database.transaction(() => {
    assertFmpTranscriptDerivedProviderWorkOwnership(workId, claim, database);
    const now = new Date().toISOString();
    return database.prepare(`
      UPDATE fmp_transcript_derived_provider_work
      SET lease_expires_at = ?
      WHERE id = ? AND generation = ? AND status = 'pending'
        AND lease_expires_at IS NOT NULL AND lease_expires_at > ?
    `).run(fmpDerivedProviderWorkLeaseExpiresAt(), workId, claim.generation, now).changes === 1;
  }).immediate();
}

/**
 * After rights have been revoked, a lease with no heartbeat is a crash receipt rather than a
 * permanent purge blocker. The subsequent provider-first purge removes any vector whose final
 * upsert outcome was unknown. Live work renews this lease from strategy.ts until it settles.
 */
function expireAbandonedFmpTranscriptDerivedProviderWork(database = getDb()): number {
  const gate = readFmpTranscriptRightsGate(database);
  if (gate.status !== "revoked" || fmpTranscriptStorageRightsConfirmed()) return 0;
  const now = new Date().toISOString();
  return database.prepare(`
    UPDATE fmp_transcript_derived_provider_work
    SET status = 'complete', completed_at = ?, terminal_outcome = 'lease_expired'
    WHERE status = 'pending' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?
  `).run(now, now).changes;
}

export function recordFmpTranscriptDerivedAudit(input: {
  claim: FmpTranscriptRightsGenerationClaim;
  kind: string;
  payload: unknown;
  userId: string;
  connectedAccountId?: string;
  provenance: readonly FmpTranscriptDerivedProvenance[];
}): string {
  const id = crypto.randomUUID();
  persistFmpTranscriptDerivedArtifact({
    claim: input.claim,
    artifactType: "audit-event",
    artifactId: id,
    userId: input.userId,
    provenance: input.provenance,
    write: () => {
      getDb().prepare(`
        INSERT INTO audit_events (id, user_id, connected_account_id, created_at, kind, payload)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        id,
        input.userId,
        input.connectedAccountId ?? null,
        new Date().toISOString(),
        input.kind,
        JSON.stringify(input.payload)
      );
      return id;
    }
  });
  return id;
}

function disabledReason(): RefreshFmpTranscriptsResult["disabledReason"] {
  if (!flagOn(process.env.WEB_SOURCE_FMP_TRANSCRIPTS)) return "feature_off";
  if (!flagOn(process.env.FMP_TRANSCRIPT_STORAGE_RIGHTS_CONFIRMED)) return "storage_rights_unconfirmed";
  return undefined;
}

/** Independent producer cadence. Disabled means never due, including when no marker exists. */
export function isFmpTranscriptRefreshDue(now: number = Date.now()): boolean {
  if (!fmpTranscriptsEnabled()) return false;
  const next = getInternalSetting<string>(NEXT_ATTEMPT_KEY);
  if (!next) return true;
  const nextMs = Date.parse(next);
  return !Number.isFinite(nextMs) || now >= nextMs;
}

/** Ticker-inclusive durable identifier: two companies' same fiscal period can never collide. */
export function transcriptAccession(symbol: string, year: number, quarter: number): string {
  const normalized = validSymbol(symbol);
  if (!normalized) throw new Error("Invalid transcript symbol.");
  if (!Number.isInteger(year) || year < 1900 || year > 2200) throw new Error("Invalid transcript year.");
  if (!Number.isInteger(quarter) || quarter < 1 || quarter > 4) throw new Error("Invalid transcript quarter.");
  return `FMP-EARNINGS-TRANSCRIPT:${normalized}:${year}:Q${quarter}`;
}

export function transcriptContentVersion(content: string): { contentSha256: string; versionIdSuffix: string } {
  const contentSha256 = crypto.createHash("sha256").update(content, "utf8").digest("hex");
  return { contentSha256, versionIdSuffix: `VERSION:${contentSha256}` };
}

/** Start immediately after the prior attempted symbol, wrapping once, without sorting away demand order. */
export function rotateSymbolsAfterCursor(symbols: string[], cursor: string | undefined): string[] {
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const raw of dataArray(symbols, 100_000)) {
    const symbol = validSymbol(raw);
    if (!symbol || seen.has(symbol)) continue;
    seen.add(symbol);
    unique.push(symbol);
  }
  const normalizedCursor = cursor ? validSymbol(cursor) : "";
  const index = normalizedCursor ? unique.indexOf(normalizedCursor) : -1;
  if (index < 0 || index === unique.length - 1) return index < 0 ? unique : [...unique];
  return [...unique.slice(index + 1), ...unique.slice(0, index + 1)];
}

function validSymbol(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const value = normalizeSymbol(raw);
  return /^[A-Z0-9][A-Z0-9.-]{0,19}$/.test(value) ? value : "";
}

function validYear(raw: unknown): number | undefined {
  const value = finiteNumber(raw);
  const upper = new Date().getUTCFullYear() + 1;
  return value !== undefined && Number.isInteger(value) && value >= 1990 && value <= upper
    ? value
    : undefined;
}

function validQuarter(raw: unknown): number | undefined {
  if (typeof raw === "string") {
    const period = /^Q([1-4])$/i.exec(raw.trim());
    if (period) return Number(period[1]);
  }
  const value = finiteNumber(raw);
  return value !== undefined && Number.isInteger(value) && value >= 1 && value <= 4
    ? value
    : undefined;
}

function validDate(raw: unknown): string | undefined {
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  const value = raw.trim();
  // Provider values without a timezone are retained only at day precision. They are event metadata,
  // never the point-in-time availability gate, so inventing a local/UTC clock time would add no value.
  const dateOnly = /^(\d{4}-\d{2}-\d{2})(?:[ T].*)?$/.exec(value)?.[1];
  if (dateOnly && !/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) {
    const parsedDay = Date.parse(`${dateOnly}T00:00:00.000Z`);
    const normalized = Number.isFinite(parsedDay) ? new Date(parsedDay).toISOString() : undefined;
    return normalized?.startsWith(dateOnly) ? normalized : undefined;
  }
  if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

/** Snapshot JSON-shaped data without invoking caller-controlled getters, iterators, or coercions. */
function dataRecord(raw: unknown): Record<string, unknown> | undefined {
  try {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(raw);
    const value = Object.create(null) as Record<string, unknown>;
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!("value" in descriptor)) return undefined;
      value[key] = descriptor.value;
    }
    return value;
  } catch {
    // Direct parser callers may hand us a hostile Proxy even though JSON.parse cannot create one.
    return undefined;
  }
}

function dataArray(raw: unknown, maxRows: number): unknown[] {
  try {
    if (!Array.isArray(raw)) return [];
    const length = Object.getOwnPropertyDescriptor(raw, "length")?.value;
    if (!Number.isSafeInteger(length) || length < 0 || length > maxRows) return [];
    const rows: unknown[] = [];
    for (let index = 0; index < length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(raw, String(index));
      if (!descriptor || !("value" in descriptor)) return [];
      rows.push(descriptor.value);
    }
    return rows;
  } catch {
    // JSON.parse cannot create a Proxy, but exported parser callers may still pass one.
    return [];
  }
}

function payloadRows(payload: unknown, maxRows: number): unknown[] {
  try {
    if (Array.isArray(payload)) return dataArray(payload, maxRows);
  } catch {
    return [];
  }
  return dataArray(dataRecord(payload)?.data, maxRows);
}

function hasEmbeddedProviderError(record: Record<string, unknown>, rejectMessage: boolean): boolean {
  for (const [rawKey, value] of Object.entries(record)) {
    const key = rawKey.toLowerCase().replace(/[\s_-]+/g, "");
    if (key === "error" || key === "errors" || key === "errormessage" || key === "errorcode") {
      return true;
    }
    if (rejectMessage && key === "message" && typeof value === "string" && value.trim().length > 0) {
      return true;
    }
    if (key === "success" && value === false) return true;
    if ((key === "status" || key === "statuscode") && (finiteNumber(value) ?? 0) >= 400) return true;
  }
  return false;
}

function endpointPayloadRows(payload: unknown, maxRows: number): unknown[] | undefined {
  try {
    let rawRows: unknown;
    if (Array.isArray(payload)) rawRows = payload;
    else {
      const record = dataRecord(payload);
      if (!record || !Object.hasOwn(record, "data")) return undefined;
      // FMP can report quota/auth/provider failures inside an HTTP 200 JSON envelope. A `data`
      // property must never mask those markers and turn the attempt green.
      if (hasEmbeddedProviderError(record, true)) return undefined;
      rawRows = record.data;
    }
    if (!Array.isArray(rawRows)) return undefined;
    const length = Object.getOwnPropertyDescriptor(rawRows, "length")?.value;
    if (!Number.isSafeInteger(length) || length < 0 || length > maxRows) return undefined;
    const rows: unknown[] = [];
    for (let index = 0; index < length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(rawRows, String(index));
      if (!descriptor || !("value" in descriptor)) return undefined;
      rows.push(descriptor.value);
    }
    return rows;
  } catch {
    return undefined;
  }
}

/** Validate the endpoint envelope and stable row schema before an HTTP 200 becomes green telemetry. */
export function isValidFmpEndpointPayload(payload: unknown, kind: FmpEndpointPayloadKind): boolean {
  const rows = endpointPayloadRows(payload, kind === "dates" ? MAX_DATES_ROWS : MAX_BODY_ROWS);
  if (!rows) return false;
  return rows.every((raw) => {
    const row = dataRecord(raw);
    if (!row) return false;
    if (hasEmbeddedProviderError(row, false)) return false;
    const symbolValue = row.symbol;
    const symbolValid = symbolValue === undefined || Boolean(validSymbol(symbolValue));
    const yearValid = validYear(row.year ?? row.fiscalYear) !== undefined;
    const quarterValid = validQuarter(row.quarter ?? row.fiscalQuarter ?? row.period) !== undefined;
    if (!symbolValid || !yearValid || !quarterValid) return false;
    if (kind === "body") {
      return Boolean(validSymbol(symbolValue)) && typeof row.content === "string";
    }
    // A transcript-body row is not a valid dates response merely because it also carries a period.
    return !Object.hasOwn(row, "content") && (row.date === undefined || typeof row.date === "string");
  });
}

/** Parse the current stable transcript-dates response; malformed rows are ignored, not invented. */
export function parseFmpTranscriptDates(payload: unknown, requestedSymbol: string): FmpTranscriptRef[] {
  const fallbackSymbol = validSymbol(requestedSymbol);
  if (!fallbackSymbol) return [];
  const byPeriod = new Map<string, FmpTranscriptRef>();
  for (const raw of payloadRows(payload, MAX_DATES_ROWS)) {
    const row = dataRecord(raw);
    if (!row) continue;
    const symbol = validSymbol(row.symbol ?? fallbackSymbol);
    const year = validYear(row.year ?? row.fiscalYear);
    const quarter = validQuarter(row.quarter ?? row.fiscalQuarter ?? row.period);
    if (!symbol || symbol !== fallbackSymbol || year === undefined || quarter === undefined) continue;
    const ref: FmpTranscriptRef = {
      symbol,
      year,
      quarter,
      ...(validDate(row.date) ? { callDate: validDate(row.date) } : {})
    };
    byPeriod.set(`${symbol}:${year}:Q${quarter}`, ref);
  }
  return [...byPeriod.values()].sort((a, b) => {
    const byDate = Date.parse(b.callDate ?? "") - Date.parse(a.callDate ?? "");
    if (Number.isFinite(byDate) && byDate !== 0) return byDate;
    return b.year - a.year || b.quarter - a.quarter;
  });
}

/** Parse the current stable transcript body response and require useful non-empty content. */
export function parseFmpTranscriptBody(payload: unknown, expected: FmpTranscriptRef): FmpTranscriptBody | undefined {
  for (const raw of payloadRows(payload, MAX_BODY_ROWS)) {
    const row = dataRecord(raw);
    if (!row) continue;
    const symbol = validSymbol(row.symbol);
    const year = validYear(row.year ?? row.fiscalYear);
    const quarter = validQuarter(row.quarter ?? row.fiscalQuarter ?? row.period);
    const content = typeof row.content === "string" ? row.content.trim() : "";
    if (
      symbol !== expected.symbol ||
      year !== expected.year ||
      quarter !== expected.quarter ||
      content.length < MIN_TRANSCRIPT_CHARS
    ) continue;
    return {
      symbol,
      year,
      quarter,
      content,
      ...(validDate(row.date) ?? expected.callDate ? { callDate: validDate(row.date) ?? expected.callDate } : {})
    };
  }
  return undefined;
}

function observationKey(accession: string): string {
  return `${OBSERVATION_PREFIX}${accession}`;
}

export function getFmpTranscriptObservation(accession: string): FmpTranscriptObservation | undefined {
  const value = dataRecord(getInternalSetting<unknown>(observationKey(accession)));
  if (!value || value.accession !== accession) return undefined;
  const symbol = validSymbol(value.symbol);
  const year = validYear(value.year);
  const quarter = validQuarter(value.quarter);
  const discoveredAt = validDate(value.discoveredAt);
  const firstContentSeenAt = value.firstContentSeenAt === undefined
    ? undefined
    : validDate(value.firstContentSeenAt);
  const callDate = value.callDate === undefined ? undefined : validDate(value.callDate);
  if (!symbol || year === undefined || quarter === undefined || !discoveredAt) return undefined;
  if (value.firstContentSeenAt !== undefined && !firstContentSeenAt) return undefined;
  if (value.callDate !== undefined && !callDate) return undefined;
  return {
    accession,
    symbol,
    year,
    quarter,
    discoveredAt,
    ...(firstContentSeenAt ? { firstContentSeenAt } : {}),
    ...(callDate ? { callDate } : {})
  };
}

function observeReference(ref: FmpTranscriptRef, observedAt: string): FmpTranscriptObservation {
  const accession = transcriptAccession(ref.symbol, ref.year, ref.quarter);
  const current = getFmpTranscriptObservation(accession);
  const next: FmpTranscriptObservation = {
    accession,
    symbol: ref.symbol,
    year: ref.year,
    quarter: ref.quarter,
    discoveredAt: current?.discoveredAt ?? observedAt,
    ...(current?.firstContentSeenAt ? { firstContentSeenAt: current.firstContentSeenAt } : {}),
    ...(ref.callDate ?? current?.callDate ? { callDate: ref.callDate ?? current?.callDate } : {})
  };
  setInternalSetting(observationKey(accession), next);
  return next;
}

function observeContent(ref: FmpTranscriptRef, observedAt: string): FmpTranscriptObservation {
  const current = observeReference(ref, observedAt);
  if (current.firstContentSeenAt) return current;
  const next = { ...current, firstContentSeenAt: observedAt };
  setInternalSetting(observationKey(current.accession), next);
  return next;
}

function endpoint(path: "earning-call-transcript-dates" | "earning-call-transcript", params: Record<string, string | number>): string {
  const url = new URL(`${FMP_STABLE_BASE}/${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  return url.toString();
}

function isTransientStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function retryAfterMs(response: Response): number {
  const raw = response.headers.get("retry-after")?.trim();
  if (!raw) return retryDelayMs();
  const seconds = finiteNumber(raw);
  if (seconds !== undefined && seconds >= 0) return Math.min(60_000, seconds * 1_000);
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.min(60_000, Math.max(0, at - Date.now())) : retryDelayMs();
}

async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
  const declared = finiteNumber(response.headers.get("content-length"));
  if (declared !== undefined && declared > maxBytes) {
    try {
      await response.body?.cancel();
    } catch {
      // The byte limit is authoritative even if this transport cannot cancel its stream cleanly.
    }
    throw new ResponseTooLargeError();
  }
  if (!response.body) throw new SyntaxError("Provider response body was empty.");

  const reader = response.body.getReader();
  // Replacement decoding would silently turn corrupt source bytes into U+FFFD and could still
  // produce syntactically valid JSON. Fatal decoding makes transport corruption a red attempt.
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new ResponseTooLargeError();
      }
      text += decoder.decode(next.value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(text);
}

async function discardResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The status is already authoritative. A transport-specific cancel failure must not mask it.
  }
}

async function retryPause(delayMs: number, signal: AbortSignal): Promise<void> {
  throwIfOperationLeaseCancelled(signal);
  if (delayMs <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(finish, delayMs);
    function finish() {
      signal.removeEventListener("abort", abort);
      resolve();
    }
    function abort() {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(signal.reason instanceof Error ? signal.reason : new Error("Operation lease ownership was lost."));
    }
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

async function requestFmpJson(
  _url: string,
  _apiKey: string,
  _keySource: string,
  _userId: string,
  _budget: RequestBudget,
  _retries: number,
  _maxResponseBytes: number,
  _payloadKind: FmpEndpointPayloadKind,
  _claim: OperationLeaseClaim,
  _leaseSignal: AbortSignal
): Promise<FmpRequestResult> {
  // Owner 2026-08-04: never open a socket to financialmodelingprep.com from this app.
  return { ok: false, kind: "access_denied", status: 403 };
}


function recordIngestedTranscript(accession: string, ticker: string, chunkCount: number, indexedAt: string): void {
  // This producer is not an SEC filing, so write only the generic ingestion ledger and do not
  // synthesize a misleading sec_filings row through insertIngestedAccession().
  getDb()
    .prepare(
      `INSERT INTO ingested_accessions (accession, doc_type, ticker, indexed_at, chunk_count)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(accession, doc_type) DO UPDATE SET
         ticker = excluded.ticker,
         indexed_at = excluded.indexed_at,
         chunk_count = excluded.chunk_count`
    )
    .run(accession, FMP_TRANSCRIPT_DOC_TYPE, ticker, indexedAt, chunkCount);
}

export function getFmpTranscriptCapability(): FmpTranscriptCapabilityObservation | undefined {
  const value = dataRecord(getInternalSetting<unknown>(CAPABILITY_KEY));
  const status = value?.status;
  const checkedAt = validDate(value?.checkedAt);
  const httpStatus = value?.httpStatus;
  if ((status !== "available" && status !== "endpoint_not_entitled" && status !== "access_denied") || !checkedAt) return undefined;
  if (httpStatus !== undefined && (
    typeof httpStatus !== "number" ||
    !Number.isInteger(httpStatus) ||
    httpStatus < 100 ||
    httpStatus > 599
  )) {
    return undefined;
  }
  return {
    status,
    checkedAt,
    ...(typeof httpStatus === "number" ? { httpStatus } : {})
  };
}

export function getFmpTranscriptStatus(now: number = Date.now()): FmpTranscriptStatus {
  const featureEnabled = flagOn(process.env.WEB_SOURCE_FMP_TRANSCRIPTS);
  const storageRightsConfirmed = fmpTranscriptStorageRightsConfirmed();
  const enabled = featureEnabled && storageRightsConfirmed;
  const lastCapability = getFmpTranscriptCapability();
  const lastAttemptAt = validDate(getInternalSetting<string>(LAST_ATTEMPT_KEY));
  const nextAttemptAt = validDate(getInternalSetting<string>(NEXT_ATTEMPT_KEY));
  return {
    featureEnabled,
    storageRightsConfirmed,
    enabled,
    due: enabled && isFmpTranscriptRefreshDue(now),
    capability: enabled ? lastCapability?.status ?? "unknown" : "disabled",
    ...(lastCapability ? { lastCapability } : {}),
    ...(lastAttemptAt ? { lastAttemptAt } : {}),
    ...(nextAttemptAt ? { nextAttemptAt } : {}),
    ingestedCount: ingestedAccessionCountForDocType(FMP_TRANSCRIPT_DOC_TYPE)
  };
}

export interface FmpTranscriptRightsInventory {
  /** Exact candidates from provider observations plus durable local receipts. */
  providerVectorIds: string[];
  /** Records actually fetched from the provider in this inventory pass (never inferred locally). */
  providerObservedVectorIds: string[];
  providerFmpNamespaceVectorIds: string[];
  providerManagedVectorIds: string[];
  providerDefaultVectorIds: string[];
  /** Exact generation-bound decision-memory identities, including their private namespace owner. */
  providerPrivateVectorRefs: FmpTranscriptPrivateVectorRef[];
  /** Provider candidates selected from immutable managed identity, local evidence, or legacy metadata fallback. */
  immutableCurrentSourceIds: string[];
  localVectorIds: string[];
  contentHashes: string[];
  commitIds: string[];
  activeHeadCommitIds: string[];
  documentVersionCommitIds: string[];
  reconcileObservationCommitIds: string[];
  versionIds: string[];
  ingestionRows: number;
  observationKeys: string[];
  derivedAuditIds: string[];
  derivedPromptSafetyAuditIds: string[];
  derivedChatTurnIds: string[];
  derivedDecisionIds: string[];
  derivedStrategyProposalIds: string[];
  derivedFrameworkProposalIds: string[];
  derivedArtifactIds: string[];
  pendingDerivedProviderWorkIds: string[];
  pendingPineconeUpsertAttemptIds: string[];
  rightsGate: { generation: number; status: "active" | "revoked"; updatedAt: string };
  authorityBlockers: string[];
  derivedArtifactPolicy: "scrub-exact-provenance";
}

export interface FmpTranscriptPrivateVectorRef {
  userId: string;
  vectorId: string;
  providerAuthority: string;
  ledgerAuthority: string;
}

interface VectorMetadataInventoryRow {
  id: string;
  metadata: Record<string, unknown>;
}

interface ManagedVectorReceiptEvidence {
  id: string;
  source: string;
  tenantScope: string;
  userId: string;
  providerAuthority?: string;
  ledgerAuthority?: string;
  vectorNamespace: "managed" | "fmp-transcripts";
}

interface ManagedVectorSourceCandidateInventory {
  candidateIds: string[];
  observedCandidateIds: string[];
  managedCandidateIds: string[];
  fmpNamespaceCandidateIds: string[];
  defaultCandidateIds: string[];
  privateVectorRefs: FmpTranscriptPrivateVectorRef[];
  immutableCurrentSourceIds: string[];
  authorityBlockers: string[];
}

interface ManagedVectorSourceHelpers {
  getCurrentVectorProviderAuthority(options: {
    userId?: string;
    leaseGuard?: import("../vector-db").VectorStoreLeaseGuard;
  }): Promise<string | undefined>;
  vectorTenantScope(userId?: string): string;
  managedVectorLedgerAuthority(): string;
  managedOccurrenceVectorPrefix(input: {
    ledgerAuthority?: string;
    providerAuthority: string;
    tenantScope?: string;
    source?: string;
  }): string;
  managedOccurrenceVectorIdMatches(input: {
    id: string;
    ledgerAuthority?: string;
    providerAuthority: string;
    tenantScope: string;
    source?: string;
  }): boolean;
  managedVectorReceiptEvidence(options: {
    source?: string;
    tenantScope?: string;
    userId?: string;
  }): ManagedVectorReceiptEvidence[];
  inventoryVectorRecordsByMetadata(options: {
    userId?: string;
    prefix?: string;
    source?: string;
    namespace?: "default" | "managed" | "private" | "fmp-transcripts";
    batchSize?: number;
    maxScanned?: number;
    leaseGuard?: import("../vector-db").VectorStoreLeaseGuard;
  }): Promise<VectorMetadataInventoryRow[]>;
  purgeVectorRecordsByMetadata(options: {
    userId?: string;
    prefix?: string;
    namespace?: "default" | "managed" | "private" | "fmp-transcripts";
    dryRun?: boolean;
    maxScanned?: number;
    leaseGuard?: import("../vector-db").VectorStoreLeaseGuard;
  }): Promise<{ ids: string[]; deleted: number }>;
  purgeVectorRecordIds(options: {
    userId?: string;
    ids: string[];
    namespace?: "default" | "managed" | "private" | "fmp-transcripts";
    leaseGuard?: import("../vector-db").VectorStoreLeaseGuard;
    expectedProviderAuthority?: string;
    ledgerAuthority?: string;
  }): Promise<{ ids: string[]; deleted: number }>;
  fetchExistingVectorRecordIds(options: {
    userId?: string;
    ids: string[];
    namespace?: "default" | "managed" | "private" | "fmp-transcripts";
    leaseGuard?: import("../vector-db").VectorStoreLeaseGuard;
    expectedProviderAuthority?: string;
    ledgerAuthority?: string;
  }): Promise<string[]>;
  purgeVectorNamespaceAll(options: {
    userId?: string;
    namespace: "fmp-transcripts";
    leaseGuard?: import("../vector-db").VectorStoreLeaseGuard;
  }): Promise<void>;
}

async function managedVectorSourceHelpers(): Promise<ManagedVectorSourceHelpers> {
  const vectorDb = await import("../vector-db") as unknown as Partial<ManagedVectorSourceHelpers>;
  if (
    typeof vectorDb.getCurrentVectorProviderAuthority !== "function" ||
    typeof vectorDb.vectorTenantScope !== "function" ||
    typeof vectorDb.managedVectorLedgerAuthority !== "function" ||
    typeof vectorDb.managedOccurrenceVectorPrefix !== "function" ||
    typeof vectorDb.managedOccurrenceVectorIdMatches !== "function" ||
    typeof vectorDb.managedVectorReceiptEvidence !== "function" ||
    typeof vectorDb.inventoryVectorRecordsByMetadata !== "function" ||
    typeof vectorDb.purgeVectorRecordsByMetadata !== "function" ||
    typeof vectorDb.purgeVectorRecordIds !== "function" ||
    typeof vectorDb.fetchExistingVectorRecordIds !== "function" ||
    typeof vectorDb.purgeVectorNamespaceAll !== "function"
  ) {
    throw new Error("Managed vector source-identity purge helpers are unavailable.");
  }
  return vectorDb as ManagedVectorSourceHelpers;
}

/**
 * Classify provider records without treating mutable metadata as source proof. Current v3 IDs
 * carry a provider/tenant/source identity; local receipts prove the pre-v3 v2 population. Only
 * a legacy record that has neither proof falls back to `metadata.source` for compatibility.
 */
async function inventoryManagedFmpTranscriptVectorCandidates(
  leaseGuard?: import("../vector-db").VectorStoreLeaseGuard
): Promise<ManagedVectorSourceCandidateInventory> {
  const vectorDb = await managedVectorSourceHelpers();
  const userId = "local";
  const tenantScope = vectorDb.vectorTenantScope(userId);
  const ledgerAuthority = vectorDb.managedVectorLedgerAuthority();
  const providerAuthority = await vectorDb.getCurrentVectorProviderAuthority({ userId, leaseGuard });
  const receiptEvidence = vectorDb.managedVectorReceiptEvidence({
    source: FMP_TRANSCRIPT_SOURCE,
    tenantScope,
    userId
  });
  const authorityBlockers = new Set<string>();
  // Without the current physical provider identity we cannot derive the immutable v3 prefix for
  // receiptless crash ghosts in the historical managed namespace. Dedicated-namespace deleteAll
  // is insufficient proof for that population, so rights erasure must remain pending rather than
  // silently deleting local receipts while provider vectors may survive.
  if (!providerAuthority) authorityBlockers.add("current-provider-authority-unreachable");
  for (const receipt of receiptEvidence) {
    if (!receipt.ledgerAuthority || receipt.ledgerAuthority !== ledgerAuthority) {
      authorityBlockers.add("historical-ledger-authority-unreachable");
    }
    if (!providerAuthority || !receipt.providerAuthority || receipt.providerAuthority !== providerAuthority) {
      authorityBlockers.add("historical-provider-authority-unreachable");
    }
  }
  // Receipt joins cannot see a crash-left commit with zero occurrences. Inspect every local FMP
  // commit before any destructive provider call so purging never erases the only route to an old
  // Pinecone project/ledger authority.
  const commitAuthorities = getDb().prepare(`
    SELECT id, provider_authority, ledger_authority
    FROM vector_ingest_commits
    WHERE source = ?
  `).all(FMP_TRANSCRIPT_SOURCE) as Array<{
    id: string;
    provider_authority: string | null;
    ledger_authority: string | null;
  }>;
  for (const commit of commitAuthorities) {
    if (!commit.ledger_authority || commit.ledger_authority !== ledgerAuthority) {
      authorityBlockers.add("historical-ledger-authority-unreachable");
    }
    if (!providerAuthority || !commit.provider_authority || commit.provider_authority !== providerAuthority) {
      authorityBlockers.add("historical-provider-authority-unreachable");
    }
  }
  const receiptIds = new Set(receiptEvidence.map((row) => row.id));
  const immutablePrefix = providerAuthority
    ? vectorDb.managedOccurrenceVectorPrefix({
        ledgerAuthority,
        providerAuthority,
        tenantScope,
        source: FMP_TRANSCRIPT_SOURCE
      })
    : undefined;
  const fmpNamespaceRows = await vectorDb.inventoryVectorRecordsByMetadata({
    userId,
    namespace: "fmp-transcripts",
    ...(immutablePrefix ? { prefix: immutablePrefix } : {}),
    maxScanned: rightsInventoryScanMaxRecords(),
    batchSize: 1000,
    leaseGuard
  });
  // Older v3 branch generations used the general managed namespace. The immutable prefix scopes
  // that compatibility inventory to this ledger/provider/source instead of scanning the corpus.
  const managedProviderRows = immutablePrefix ? await vectorDb.inventoryVectorRecordsByMetadata({
    userId,
    namespace: "managed",
    prefix: immutablePrefix,
    maxScanned: rightsInventoryScanMaxRecords(),
    batchSize: 1000,
    leaseGuard
  }) : [];
  const defaultProviderRows = await vectorDb.inventoryVectorRecordsByMetadata({
    userId,
    namespace: "default",
    source: FMP_TRANSCRIPT_SOURCE,
    maxScanned: rightsInventoryScanMaxRecords(),
    batchSize: 1000,
    leaseGuard
  });
  const derivedProviderRows = getDb().prepare(`
    SELECT user_id, vector_id, provider_authority, ledger_authority, status, terminal_outcome
    FROM fmp_transcript_derived_provider_work
    ORDER BY user_id, vector_id, provider_authority, ledger_authority
  `).all() as Array<{
    user_id: string | null;
    vector_id: string | null;
    provider_authority: string | null;
    ledger_authority: string | null;
    status: "pending" | "complete";
    terminal_outcome: string | null;
  }>;
  const privateVectorRefs = [...new Map(
    derivedProviderRows
      .filter((row) => {
        // This reservation settled before any Pinecone upsert (dedup, budget, or missing-provider
        // short circuit). Keep the local provenance row for scrubbing, but do not invent a provider
        // deletion obligation or require a namespace manifest for a vector that was never written.
        if (row.status === "complete" && row.terminal_outcome === "no_provider_write") return false;
        const identityPresent = Boolean(row.user_id?.trim() && row.vector_id?.trim());
        const authorityPresent = Boolean(row.provider_authority?.trim() && row.ledger_authority?.trim());
        if (!identityPresent) authorityBlockers.add("derived-private-vector-identity-missing");
        if (!authorityPresent) authorityBlockers.add("derived-private-vector-authority-missing");
        return identityPresent && authorityPresent;
      })
      .map((row) => {
        const ref = {
          userId: row.user_id!.trim(),
          vectorId: row.vector_id!.trim(),
          providerAuthority: row.provider_authority!.trim(),
          ledgerAuthority: row.ledger_authority!.trim()
        };
        return [
          `${ref.userId}\u0000${ref.vectorId}\u0000${ref.providerAuthority}\u0000${ref.ledgerAuthority}`,
          ref
        ] as const;
      })
  ).values()].sort((a, b) => (
    `${a.userId}:${a.vectorId}:${a.providerAuthority}:${a.ledgerAuthority}`
      .localeCompare(`${b.userId}:${b.vectorId}:${b.providerAuthority}:${b.ledgerAuthority}`)
  ));
  const candidateIds = new Set<string>();
  const observedCandidateIds = new Set<string>();
  const managedCandidateIds = new Set<string>();
  const fmpNamespaceCandidateIds = new Set<string>();
  const defaultCandidateIds = new Set<string>();
  const immutableCurrentSourceIds = new Set<string>();
  const refsByAuthority = new Map<string, FmpTranscriptPrivateVectorRef[]>();
  for (const ref of privateVectorRefs) {
    candidateIds.add(ref.vectorId);
    const key = `${ref.userId}\u0000${ref.providerAuthority}\u0000${ref.ledgerAuthority}`;
    const refs = refsByAuthority.get(key) ?? [];
    refs.push(ref);
    refsByAuthority.set(key, refs);
  }
  const privateObservations = await Promise.all([...refsByAuthority.values()].map(async (refs) => {
    const first = refs[0]!;
    try {
      return await vectorDb.fetchExistingVectorRecordIds({
        userId: first.userId,
        namespace: "private",
        ids: refs.map((ref) => ref.vectorId),
        expectedProviderAuthority: first.providerAuthority,
        ledgerAuthority: first.ledgerAuthority,
        leaseGuard
      });
    } catch {
      authorityBlockers.add("derived-private-provider-authority-unreachable");
      return [];
    }
  }));
  for (const id of privateObservations.flat()) observedCandidateIds.add(id);
  const classifyCurrentV3 = (row: VectorMetadataInventoryRow): boolean => Boolean(
    providerAuthority &&
    immutablePrefix &&
    row.id.startsWith(immutablePrefix) &&
    vectorDb.managedOccurrenceVectorIdMatches({
      id: row.id,
      ledgerAuthority,
      providerAuthority,
      tenantScope,
      source: FMP_TRANSCRIPT_SOURCE
    })
  );
  for (const row of fmpNamespaceRows) {
    candidateIds.add(row.id);
    observedCandidateIds.add(row.id);
    fmpNamespaceCandidateIds.add(row.id);
    if (classifyCurrentV3(row)) immutableCurrentSourceIds.add(row.id);
  }
  for (const receipt of receiptEvidence) {
    candidateIds.add(receipt.id);
    if (receipt.vectorNamespace === "fmp-transcripts") fmpNamespaceCandidateIds.add(receipt.id);
    else if (receipt.id.startsWith("occ:v3:")) managedCandidateIds.add(receipt.id);
    else defaultCandidateIds.add(receipt.id);
  }
  for (const row of managedProviderRows) {
    const isCurrentSource = Boolean(
      classifyCurrentV3(row)
    );
    if (isCurrentSource) {
      candidateIds.add(row.id);
      observedCandidateIds.add(row.id);
      managedCandidateIds.add(row.id);
      immutableCurrentSourceIds.add(row.id);
      continue;
    }
    if (receiptIds.has(row.id)) {
      candidateIds.add(row.id);
      observedCandidateIds.add(row.id);
      managedCandidateIds.add(row.id);
    }
  }
  for (const row of defaultProviderRows) {
    // Local receipt/commit evidence proves old default-namespace generations. Legacy IDs had no
    // immutable source token, so exact source/doc_type metadata is the bounded compatibility
    // fallback regardless of whether that generation happened to use the v2 ID prefix.
    if (
      receiptIds.has(row.id) ||
      row.metadata.source === FMP_TRANSCRIPT_SOURCE ||
      String(row.metadata.doc_type ?? "").toLowerCase() === FMP_TRANSCRIPT_DOC_TYPE
    ) {
      candidateIds.add(row.id);
      observedCandidateIds.add(row.id);
      defaultCandidateIds.add(row.id);
    }
  }
  return {
    candidateIds: [...candidateIds].sort(),
    observedCandidateIds: [...observedCandidateIds].sort(),
    managedCandidateIds: [...managedCandidateIds].sort(),
    fmpNamespaceCandidateIds: [...fmpNamespaceCandidateIds].sort(),
    defaultCandidateIds: [...defaultCandidateIds].sort(),
    privateVectorRefs,
    immutableCurrentSourceIds: [...immutableCurrentSourceIds].sort(),
    authorityBlockers: [...authorityBlockers].sort()
  };
}

function rightsInventoryScanMaxRecords(): number {
  return positiveInt(process.env.FMP_TRANSCRIPT_RIGHTS_SCAN_MAX_RECORDS, 250_000, 1_000_000);
}

function isFmpRagAttribution(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return row.source === FMP_TRANSCRIPT_SOURCE ||
    (typeof row.docType === "string" && row.docType.toLowerCase() === FMP_TRANSCRIPT_DOC_TYPE);
}

function isFmpDerivedEvidence(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (isFmpRagAttribution(row) || row.source === FMP_TRANSCRIPT_SOURCE) return true;
  const data = row.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  const payload = data as Record<string, unknown>;
  if (isFmpRagAttribution(payload)) return true;
  return Array.isArray(payload.fmpProvenance) && payload.fmpProvenance.some(isFmpRagAttribution);
}

function parseJsonArray(value: string): unknown[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function scrubFmpDecisionArtifacts(database: ReturnType<typeof getDb>): number {
  const rows = database.prepare(`
    SELECT id, rag_attributions, evidence FROM socratic_decisions
  `).all() as Array<{ id: string; rag_attributions: string; evidence: string }>;
  const update = database.prepare(`
    UPDATE socratic_decisions SET rag_attributions = ?, evidence = ?, updated_at = ? WHERE id = ?
  `);
  let changed = 0;
  for (const row of rows) {
    const rag = parseJsonArray(row.rag_attributions);
    const evidence = parseJsonArray(row.evidence);
    const nextRag = rag.filter((item) => !isFmpRagAttribution(item));
    const nextEvidence = evidence.filter((item) => !isFmpDerivedEvidence(item));
    if (nextRag.length === rag.length && nextEvidence.length === evidence.length) continue;
    update.run(JSON.stringify(nextRag), JSON.stringify(nextEvidence), new Date().toISOString(), row.id);
    changed += 1;
  }
  return changed;
}

function fmpDerivedDecisionIds(database: ReturnType<typeof getDb>): string[] {
  const rows = database.prepare(`
    SELECT id, rag_attributions, evidence FROM socratic_decisions ORDER BY id
  `).all() as Array<{ id: string; rag_attributions: string; evidence: string }>;
  return rows.filter((row) => (
    parseJsonArray(row.rag_attributions).some(isFmpRagAttribution) ||
    parseJsonArray(row.evidence).some(isFmpDerivedEvidence)
  )).map((row) => row.id);
}

function localFmpTranscriptRightsInventory(): Omit<
  FmpTranscriptRightsInventory,
  | "providerVectorIds"
  | "providerObservedVectorIds"
  | "providerFmpNamespaceVectorIds"
  | "providerManagedVectorIds"
  | "providerDefaultVectorIds"
  | "providerPrivateVectorRefs"
  | "immutableCurrentSourceIds"
  | "authorityBlockers"
> {
  const database = getDb();
  const rightsGate = readFmpTranscriptRightsGate(database);
  const derivedArtifacts = database.prepare(`
    SELECT id, artifact_type, artifact_id, user_id, generation, provenance, created_at
    FROM fmp_transcript_derived_artifacts ORDER BY artifact_type, artifact_id
  `).all() as FmpTranscriptDerivedArtifactRow[];
  const occurrences = database.prepare(`
    SELECT vector_id, content_hash, commit_id
    FROM chunk_occurrences WHERE source = ? ORDER BY vector_id
  `).all(FMP_TRANSCRIPT_SOURCE) as Array<{
    vector_id: string;
    content_hash: string;
    commit_id: string | null;
  }>;
  const derivedContentHashes = (database.prepare(`
    SELECT d.content_hash
    FROM document_chunks d
    JOIN fmp_transcript_derived_provider_work w ON w.vector_id = d.chunk_id
    WHERE w.vector_id IS NOT NULL
    ORDER BY d.content_hash
  `).all() as Array<{ content_hash: string }>).map((row) => row.content_hash);
  const versionIds = (database.prepare(`
    SELECT version_id FROM fmp_transcript_versions ORDER BY version_id
  `).all() as Array<{ version_id: string }>).map((row) => row.version_id);
  const commitIds = (database.prepare(`
    SELECT id FROM vector_ingest_commits WHERE source = ? ORDER BY id
  `).all(FMP_TRANSCRIPT_SOURCE) as Array<{ id: string }>).map((row) => row.id);
  const activeHeadCommitIds = (database.prepare(`
    SELECT commit_id FROM vector_document_heads WHERE source = ? ORDER BY commit_id
  `).all(FMP_TRANSCRIPT_SOURCE) as Array<{ commit_id: string }>).map((row) => row.commit_id);
  const documentVersionCommitIds = (database.prepare(`
    SELECT commit_id FROM vector_document_versions WHERE source = ? ORDER BY commit_id
  `).all(FMP_TRANSCRIPT_SOURCE) as Array<{ commit_id: string }>).map((row) => row.commit_id);
  const reconcileObservationCommitIds = (database.prepare(`
    SELECT o.commit_id
    FROM vector_reconcile_observations o
    JOIN vector_ingest_commits c ON c.id = o.commit_id
    WHERE c.source = ?
    ORDER BY o.commit_id
  `).all(FMP_TRANSCRIPT_SOURCE) as Array<{ commit_id: string }>).map((row) => row.commit_id);
  const observationKeys = (database.prepare(`
    SELECT key FROM settings
    WHERE key LIKE ? OR key IN (?, ?, ?, ?, ?, ?)
    ORDER BY key
  `).all(
    `${OBSERVATION_PREFIX}%`,
    LAST_ATTEMPT_KEY,
    NEXT_ATTEMPT_KEY,
    CURSOR_KEY,
    CAPABILITY_KEY,
    BODY_RETRY_ACCESSION_KEY,
    EMBED_RETRY_ACCESSION_KEY
  ) as Array<{ key: string }>).map((row) => row.key);
  // Legacy producer audits are identified by their dedicated kind. New strategy/chat audits are
  // joined through the exact-provenance artifact ledger; never substring-match arbitrary payloads.
  const legacyProducerAuditIds = (database.prepare(`
    SELECT id FROM audit_events
    WHERE kind LIKE 'fmp_transcript_%'
    ORDER BY id
  `).all() as Array<{ id: string }>).map((row) => row.id);
  const artifactAuditIds = derivedArtifacts
    .filter((row) => row.artifact_type === "audit-event")
    .map((row) => row.artifact_id);
  const derivedAuditIds = [...new Set([...legacyProducerAuditIds, ...artifactAuditIds])].sort();
  const derivedPromptSafetyAuditIds = artifactAuditIds.filter((id) => Boolean(database.prepare(`
    SELECT 1 AS ok FROM audit_events
    WHERE id = ? AND kind IN ('prompt_injection_suspected','prompt_injection_contained')
  `).get(id))).sort();
  const derivedChatTurnIds = derivedArtifacts
    .filter((row) => row.artifact_type === "chat-turn")
    .map((row) => row.artifact_id)
    .sort();
  const derivedStrategyProposalIds = derivedArtifacts
    .filter((row) => row.artifact_type === "strategy-proposal")
    .map((row) => row.artifact_id)
    .sort();
  const pendingPineconeUpsertAttemptIds = (database.prepare(`
    SELECT id FROM provider_dispatch_attempts
    WHERE provider = 'pinecone'
      AND operation IN (
        'upsert fmp transcript vectors',
        'commit fmp transcript vectors',
        'upsert fmp-derived private memory'
      )
      AND status IN ('reserved','dispatched','unknown')
    ORDER BY id
  `).all() as Array<{ id: string }>).map((row) => row.id);
  const pendingDerivedProviderWorkIds = (database.prepare(`
    SELECT id FROM fmp_transcript_derived_provider_work
    WHERE status = 'pending' ORDER BY id
  `).all() as Array<{ id: string }>).map((row) => row.id);
  const ingestionRows = (database.prepare(`
    SELECT COUNT(*) AS count FROM ingested_accessions WHERE doc_type = ?
  `).get(FMP_TRANSCRIPT_DOC_TYPE) as { count: number }).count;
  const derivedDecisionIds = [...new Set([
    ...fmpDerivedDecisionIds(database),
    ...derivedArtifacts
      .filter((row) => row.artifact_type === "strategy-decision")
      .map((row) => row.artifact_id)
  ])].sort();
  const derivedDecisionIdSet = new Set(derivedDecisionIds);
  const derivedFrameworkProposalIds = (database.prepare(`
    SELECT id, decision_id FROM socratic_framework_proposals
    WHERE decision_id IS NOT NULL ORDER BY id
  `).all() as Array<{ id: string; decision_id: string }> )
    .filter((row) => derivedDecisionIdSet.has(row.decision_id))
    .map((row) => row.id);
  return {
    localVectorIds: occurrences.map((row) => row.vector_id),
    contentHashes: [...new Set([
      ...occurrences.map((row) => row.content_hash),
      ...derivedContentHashes
    ])].sort(),
    commitIds,
    activeHeadCommitIds,
    documentVersionCommitIds,
    reconcileObservationCommitIds,
    versionIds,
    ingestionRows,
    observationKeys,
    derivedAuditIds,
    derivedPromptSafetyAuditIds,
    derivedChatTurnIds,
    derivedDecisionIds,
    derivedStrategyProposalIds,
    derivedFrameworkProposalIds,
    derivedArtifactIds: derivedArtifacts.map((row) => row.id).sort(),
    pendingDerivedProviderWorkIds,
    pendingPineconeUpsertAttemptIds,
    rightsGate: {
      generation: rightsGate.generation,
      status: rightsGate.status,
      updatedAt: rightsGate.updated_at
    },
    derivedArtifactPolicy: "scrub-exact-provenance"
  };
}

/** Provider inventory is authoritative and therefore includes receiptless crash ghosts. */
export async function inventoryFmpTranscriptRightsArtifacts(
  leaseGuard?: import("../vector-db").VectorStoreLeaseGuard
): Promise<FmpTranscriptRightsInventory> {
  const provider = await inventoryManagedFmpTranscriptVectorCandidates(leaseGuard);
  return {
    providerVectorIds: [...new Set(provider.candidateIds)].sort(),
    providerObservedVectorIds: [...new Set(provider.observedCandidateIds)].sort(),
    providerFmpNamespaceVectorIds: [...new Set(provider.fmpNamespaceCandidateIds)].sort(),
    providerManagedVectorIds: [...new Set(provider.managedCandidateIds)].sort(),
    providerDefaultVectorIds: [...new Set(provider.defaultCandidateIds)].sort(),
    providerPrivateVectorRefs: provider.privateVectorRefs,
    immutableCurrentSourceIds: [...new Set(provider.immutableCurrentSourceIds)].sort(),
    authorityBlockers: [...new Set(provider.authorityBlockers)].sort(),
    ...localFmpTranscriptRightsInventory()
  };
}

/**
 * Deterministic rights-off purge. Defaults to dry-run. A real run deletes provider vectors first,
 * verifies Pinecone has none left, then removes exact relational/observation/provenance-tagged
 * derived rows in one SQLite transaction.
 */
export async function purgeFmpTranscriptRightsArtifacts(options: { dryRun?: boolean } = {}): Promise<{
  dryRun: boolean;
  before: FmpTranscriptRightsInventory;
  after: FmpTranscriptRightsInventory;
  skipped?: boolean;
  operationLease?: import("../operation-lease").OperationLeaseBusy;
}> {
  const dryRun = options.dryRun !== false;
  if (dryRun) {
    const before = await inventoryFmpTranscriptRightsArtifacts();
    return { dryRun, before, after: before };
  }
  if (fmpTranscriptStorageRightsConfirmed()) {
    throw new Error("Withdraw FMP transcript storage/display rights before running a destructive rights purge.");
  }
  const guarded = await runWithOperationLease(
    { group: OPERATION_LEASE_GROUPS.RAG_REINDEX, operation: "purge-fmp-transcript-rights" },
    async (claim, signal) => {
      const assertLease = () => {
        throwIfOperationLeaseCancelled(signal);
        assertOperationLeaseOwnership(claim);
      };
      assertLease();
      const database = getDb();
      // This generation change serializes with every exact-provenance artifact transaction. A
      // writer either committed before this point (and is inventoried below) or its stale claim
      // fails without persisting after cleanup.
      revokeFmpTranscriptRightsGeneration(database);
      expireAbandonedFmpTranscriptDerivedProviderWork(database);
      const before = await inventoryFmpTranscriptRightsArtifacts({ signal, assertOwnership: assertLease });
      assertLease();
      if (before.authorityBlockers.length > 0) {
        throw new Error(`FMP transcript rights purge is blocked by unreachable historical authority (${before.authorityBlockers.join(",")}).`);
      }
      if (before.pendingDerivedProviderWorkIds.length > 0) {
        throw new Error(`FMP transcript rights purge is blocked by unresolved derived provider work (${before.pendingDerivedProviderWorkIds.join(",")}).`);
      }
      if (before.pendingPineconeUpsertAttemptIds.length > 0) {
        throw new Error(`FMP transcript rights purge is blocked by unresolved Pinecone upsert attempts (${before.pendingPineconeUpsertAttemptIds.join(",")}).`);
      }
      const selectedFmpNamespaceIds = [...new Set(before.providerFmpNamespaceVectorIds)].sort();
      const selectedManagedIds = [...new Set(before.providerManagedVectorIds)].sort();
      const selectedDefaultIds = [...new Set(before.providerDefaultVectorIds)].sort();
      const selectedPrivateRefs = before.providerPrivateVectorRefs;
      const selectedIds = [...new Set([
        ...selectedFmpNamespaceIds,
        ...selectedManagedIds,
        ...selectedDefaultIds,
        ...selectedPrivateRefs.map((ref) => ref.vectorId)
      ])].sort();
      const { purgeVectorNamespaceAll, purgeVectorRecordIds } = await managedVectorSourceHelpers();
      // Current/future licensed content is isolated in a dedicated namespace, so deleteAll is
      // authoritative even when provider listing omits a crash ghost.
      await purgeVectorNamespaceAll({
        userId: "local",
        namespace: "fmp-transcripts",
        leaseGuard: { signal, assertOwnership: assertLease }
      });
      assertLease();
      await purgeVectorRecordIds({
        userId: "local",
        namespace: "managed",
        ids: selectedManagedIds,
        leaseGuard: { signal, assertOwnership: assertLease }
      });
      await purgeVectorRecordIds({
        userId: "local",
        namespace: "default",
        ids: selectedDefaultIds,
        leaseGuard: { signal, assertOwnership: assertLease }
      });
      const privateRefsByAuthority = new Map<string, FmpTranscriptPrivateVectorRef[]>();
      for (const ref of selectedPrivateRefs) {
        const key = `${ref.userId}\u0000${ref.providerAuthority}\u0000${ref.ledgerAuthority}`;
        const refs = privateRefsByAuthority.get(key) ?? [];
        refs.push(ref);
        privateRefsByAuthority.set(key, refs);
      }
      for (const refs of privateRefsByAuthority.values()) {
        const first = refs[0]!;
        await purgeVectorRecordIds({
          userId: first.userId,
          namespace: "private",
          ids: refs.map((ref) => ref.vectorId),
          expectedProviderAuthority: first.providerAuthority,
          ledgerAuthority: first.ledgerAuthority,
          leaseGuard: { signal, assertOwnership: assertLease }
        });
      }
      assertLease();
      // Pinecone delete/list/fetch visibility is eventually consistent. A briefly absent vector can
      // reappear, so retain every local receipt until a bounded stability window is clean.
      const verifyAttempts = positiveInt(process.env.VECTOR_ERASURE_VERIFY_ATTEMPTS, 4, 10);
      const requiredClean = Math.min(
        verifyAttempts,
        positiveInt(process.env.VECTOR_ERASURE_VERIFY_CONSECUTIVE_CLEAN, 3, 10)
      );
      const verifyDelayMs = nonNegativeInt(process.env.VECTOR_ERASURE_VERIFY_DELAY_MS, 500, 30_000);
      let consecutiveClean = 0;
      let providerVerification = before;
      let remainingSelectedIds: string[] = selectedIds;
      for (let attempt = 0; attempt < verifyAttempts; attempt++) {
        if (attempt > 0 && verifyDelayMs > 0) {
          await retryPause(Math.min(30_000, verifyDelayMs * (2 ** (attempt - 1))), signal);
          assertLease();
        }
        providerVerification = await inventoryFmpTranscriptRightsArtifacts({ signal, assertOwnership: assertLease });
        assertLease();
        remainingSelectedIds = selectedIds.filter((id) => (
          providerVerification.providerObservedVectorIds.includes(id)
        ));
        const clean = remainingSelectedIds.length === 0 &&
          providerVerification.providerObservedVectorIds.length === 0 &&
          providerVerification.immutableCurrentSourceIds.length === 0 &&
          providerVerification.authorityBlockers.length === 0;
        consecutiveClean = clean ? consecutiveClean + 1 : 0;
        if (consecutiveClean >= requiredClean) break;
      }
      if (consecutiveClean < requiredClean) {
        throw new Error(
          `FMP transcript provider purge stability verification failed (` +
          `${remainingSelectedIds.length} selected vector(s) in final observation; ` +
          `${consecutiveClean}/${requiredClean} consecutive clean).`
        );
      }

      database.transaction(() => {
        for (const turnId of before.derivedChatTurnIds) {
          database.prepare("DELETE FROM chat_turns WHERE id = ?").run(turnId);
        }
        for (const auditId of before.derivedAuditIds) {
          database.prepare("DELETE FROM audit_events WHERE id = ?").run(auditId);
        }
        for (const frameworkId of before.derivedFrameworkProposalIds) {
          database.prepare("DELETE FROM socratic_framework_proposals WHERE id = ?").run(frameworkId);
        }
        scrubFmpDecisionArtifacts(database);
        database.prepare("DELETE FROM chunk_occurrences WHERE source = ?").run(FMP_TRANSCRIPT_SOURCE);
        for (const contentHash of before.contentHashes) {
          database.prepare(`
            DELETE FROM document_chunks
            WHERE content_hash = ?
              AND NOT EXISTS (SELECT 1 FROM chunk_occurrences WHERE content_hash = ?)
          `).run(contentHash, contentHash);
        }
        database.prepare(`
          DELETE FROM vector_document_heads
          WHERE commit_id IN (SELECT id FROM vector_ingest_commits WHERE source = ?)
        `).run(FMP_TRANSCRIPT_SOURCE);
        database.prepare(`
          DELETE FROM vector_reconcile_observations
          WHERE commit_id IN (SELECT id FROM vector_ingest_commits WHERE source = ?)
        `).run(FMP_TRANSCRIPT_SOURCE);
        database.prepare(`
          DELETE FROM vector_document_versions
          WHERE commit_id IN (SELECT id FROM vector_ingest_commits WHERE source = ?)
        `).run(FMP_TRANSCRIPT_SOURCE);
        database.prepare("DELETE FROM vector_ingest_commits WHERE source = ?").run(FMP_TRANSCRIPT_SOURCE);
        database.prepare("DELETE FROM fmp_transcript_versions").run();
        database.prepare("DELETE FROM ingested_accessions WHERE doc_type = ?").run(FMP_TRANSCRIPT_DOC_TYPE);
        for (const key of before.observationKeys) database.prepare("DELETE FROM settings WHERE key = ?").run(key);
        database.prepare("DELETE FROM fmp_transcript_derived_provider_work").run();
        database.prepare("DELETE FROM fmp_transcript_derived_artifacts").run();
      })();
      assertLease();
      const after = await inventoryFmpTranscriptRightsArtifacts({ signal, assertOwnership: assertLease });
      assertLease();
      const residual = after.providerVectorIds.length + after.providerObservedVectorIds.length + after.immutableCurrentSourceIds.length +
        after.providerManagedVectorIds.length + after.providerDefaultVectorIds.length +
        after.providerPrivateVectorRefs.length +
        after.localVectorIds.length + after.versionIds.length +
        after.commitIds.length +
        after.activeHeadCommitIds.length + after.documentVersionCommitIds.length +
        after.reconcileObservationCommitIds.length +
        after.ingestionRows + after.observationKeys.length + after.derivedAuditIds.length +
        after.derivedPromptSafetyAuditIds.length + after.derivedChatTurnIds.length +
        after.derivedDecisionIds.length + after.derivedStrategyProposalIds.length +
        after.derivedFrameworkProposalIds.length + after.derivedArtifactIds.length +
        after.pendingDerivedProviderWorkIds.length + after.pendingPineconeUpsertAttemptIds.length +
        after.authorityBlockers.length;
      if (after.rightsGate.status !== "revoked") {
        throw new Error("FMP transcript rights purge verification failed (rights gate reactivated).");
      }
      if (residual !== 0) throw new Error(`FMP transcript rights purge verification failed (${residual} artifact(s) remain).`);
      return { dryRun, before, after };
    }
  );
  if (guarded.acquired) return guarded.value;
  const snapshot = await inventoryFmpTranscriptRightsArtifacts();
  return {
    dryRun,
    before: snapshot,
    after: snapshot,
    skipped: true,
    operationLease: guarded.busy
  };
}

function recordCapability(
  status: FmpTranscriptCapabilityObservation["status"],
  checkedAt: string,
  httpStatus?: number
): void {
  setInternalSetting(CAPABILITY_KEY, {
    status,
    checkedAt,
    ...(httpStatus !== undefined ? { httpStatus } : {})
  } satisfies FmpTranscriptCapabilityObservation);
}

function emptyResult(enabled = fmpTranscriptsEnabled()): RefreshFmpTranscriptsResult {
  const reason = enabled ? undefined : disabledReason();
  return {
    enabled,
    capability: enabled ? "unknown" : "disabled",
    ...(reason ? { disabledReason: reason } : {}),
    requests: 0,
    symbolsAttempted: 0,
    transcriptsAttempted: 0,
    ingested: 0,
    skippedExisting: 0,
    retryableEmpty: 0,
    deferredForRequestBudget: 0,
    deferredForProviderQuota: 0,
    deferredForEmbedBudget: 0,
    errors: []
  };
}

function describeFailure(stage: "dates" | "body", symbol: string, request: FmpRequestResult & { ok: false }): string {
  const suffix = request.kind === "endpoint_not_entitled"
    ? ":endpoint_not_entitled"
    : request.kind === "access_denied"
      ? `:access_denied:${request.status ?? "unknown"}`
    : request.status
      ? `:http-${request.status}`
      : request.circuitOpen
        ? ":circuit-open"
        : `:${request.kind}`;
  return `${stage}:${symbol}${suffix}`;
}

function markDeferral(result: RefreshFmpTranscriptsResult, request: FmpRequestResult & { ok: false }): void {
  if (request.kind === "request_budget") result.deferredForRequestBudget += 1;
  if (request.kind === "provider_quota") result.deferredForProviderQuota += 1;
}

function clearBodyRetryAccession(accession: string): void {
  if (getInternalSetting<string>(BODY_RETRY_ACCESSION_KEY) === accession) {
    deleteInternalSetting(BODY_RETRY_ACCESSION_KEY);
  }
}

function clearEmbedRetryAccession(accession: string): void {
  if (getInternalSetting<string>(EMBED_RETRY_ACCESSION_KEY) === accession) {
    deleteInternalSetting(EMBED_RETRY_ACCESSION_KEY);
  }
}

/** Return true for the first consecutive store failure; false on the second so the cursor rotates. */
function prioritizeEmbedRetry(accession: string): boolean {
  if (getInternalSetting<string>(EMBED_RETRY_ACCESSION_KEY) === accession) {
    deleteInternalSetting(EMBED_RETRY_ACCESSION_KEY);
    return false;
  }
  setInternalSetting(EMBED_RETRY_ACCESSION_KEY, accession);
  return true;
}

function shouldRetrySoon(result: RefreshFmpTranscriptsResult): boolean {
  return (
    result.retryableEmpty > 0 ||
    result.deferredForRequestBudget > 0 ||
    result.deferredForProviderQuota > 0 ||
    result.deferredForEmbedBudget > 0 ||
    result.errors.some((error) => (
      error.endsWith(":transient") ||
      error.endsWith(":circuit-open") ||
      error.endsWith(":invalid-embeddings") ||
      error.endsWith(":failed") ||
      error.endsWith(":empty") ||
      error.endsWith(":incomplete") ||
      /:http-(?:408|409|425|429|5\d\d)$/.test(error)
    ))
  );
}

/**
 * Refresh a demand-ordered symbol list. This function never enables production by itself; with the
 * default flag state it returns before key lookup, lease acquisition, DB markers, or network work.
 */
export async function refreshFmpTranscripts(
  symbols: string[],
  now: number = Date.now(),
  options: RefreshFmpTranscriptOptions = {}
): Promise<OperationLeaseAware<RefreshFmpTranscriptsResult>> {
  if (!Number.isFinite(now)) throw new Error("Invalid FMP transcript refresh time.");
  if (options.userId !== undefined && options.userId !== "local") {
    throw new Error("FMP transcript ingestion is an operator-owned shared producer; user-scoped runs are not allowed.");
  }
  const base = emptyResult();
  if (!base.enabled) return base;
  const ordered = rotateSymbolsAfterCursor(symbols, getInternalSetting<string>(CURSOR_KEY));
  if (ordered.length === 0) return base;
  if (!options.force && !isFmpTranscriptRefreshDue(now)) return base;

  const guarded = await runWithOperationLease(
    { group: OPERATION_LEASE_GROUPS.RAG_REINDEX, operation: "scheduled-fmp-transcripts" },
    async (claim, signal) => {
      // Install/read the durable gate after acquiring the shared RAG lease and before any API-key,
      // settings, or provider work. A prior purge's revoked generation is not flag-reactivated.
      const rightsClaim = captureFmpTranscriptRightsGeneration();
      if (!rightsClaim) throw new Error("FMP transcript rights generation is revoked; explicit rights activation is required.");
      return refreshFmpTranscriptsUnlocked(ordered, now, options, claim, signal, rightsClaim);
    }
  );
  if (!guarded.acquired) return { ...base, operationLease: guarded.busy };
  return guarded.value;
}

async function refreshFmpTranscriptsUnlocked(
  orderedSymbols: string[],
  now: number,
  options: RefreshFmpTranscriptOptions,
  claim: OperationLeaseClaim,
  leaseSignal: AbortSignal,
  rightsClaim: FmpTranscriptRightsGenerationClaim
): Promise<RefreshFmpTranscriptsResult> {
  const result = emptyResult(true);
  if (!options.force && !isFmpTranscriptRefreshDue(now)) return result;
  assertOperationLeaseOwnership(claim);
  assertFmpTranscriptRightsGeneration(rightsClaim);
  const observedAt = new Date(now).toISOString();
  const userId = "local";
  const resolved = resolveApiKeyWithSource("fmp", userId);

  // Provisional retry marker first: a crash cannot make every 60-second scheduler tick restart the
  // same provider batch. A clean completion below advances it to the normal independent cadence.
  setInternalSetting(LAST_ATTEMPT_KEY, observedAt);
  setInternalSetting(NEXT_ATTEMPT_KEY, new Date(now + retryMs()).toISOString());

  if (!resolved.key) {
    result.errors.push("configuration:fmp-key-unavailable");
    setInternalSetting(NEXT_ATTEMPT_KEY, new Date(now + ttlMs()).toISOString());
    audit("fmp_transcript_refresh", { ...result, contentLogged: false, featureDefault: "off" });
    return result;
  }

  const budget: RequestBudget = {
    remaining: options.maxRequests === undefined
      ? maxRequestsPerRun()
      : nonNegativeInt(options.maxRequests, 0, 500),
    used: 0
  };
  const highInterest = new Set(rankHighInterestSymbols({ now }));

  symbolLoop: for (const symbol of orderedSymbols) {
    throwIfOperationLeaseCancelled(leaseSignal);
    assertOperationLeaseOwnership(claim);
    assertFmpTranscriptRightsGeneration(rightsClaim);
    if (budget.remaining <= 0) {
      result.deferredForRequestBudget += 1;
      break;
    }
    result.symbolsAttempted += 1;
    const dates = await requestFmpJson(
      endpoint("earning-call-transcript-dates", { symbol }),
      resolved.key,
      resolved.source,
      userId,
      budget,
      httpRetries(),
      datesResponseBytes(),
      "dates",
      claim,
      leaseSignal
    );
    // Defense in depth around every provider helper return: no caller-side cursor/capability write
    // may trust a result that settled after durable ownership moved.
    throwIfOperationLeaseCancelled(leaseSignal);
    assertOperationLeaseOwnership(claim);
    if (!dates.ok) {
      // Advance after an actual failed dates request so one bad ticker cannot starve the demand
      // list. Admission failures did not contact FMP and must retry this same symbol next run.
      if (dates.kind !== "request_budget" && dates.kind !== "provider_quota") {
        setInternalSetting(CURSOR_KEY, symbol);
      }
      markDeferral(result, dates);
      result.errors.push(describeFailure("dates", symbol, dates));
      if (dates.kind === "endpoint_not_entitled") {
        result.capability = "endpoint_not_entitled";
        recordCapability("endpoint_not_entitled", observedAt, dates.status ?? 402);
        break;
      }
      if (dates.kind === "access_denied") {
        result.capability = "access_denied";
        recordCapability("access_denied", observedAt, dates.status);
        break;
      }
      if (dates.kind === "request_budget" || dates.kind === "provider_quota") break;
      continue;
    }

    const refs = parseFmpTranscriptDates(dates.payload, symbol);
    if (refs.length === 0) {
      // A successful-but-empty dates response is not proof that this ticker will never have data.
      // Keep it retryable and never write a synthetic ingestion row.
      result.retryableEmpty += 1;
      result.errors.push(`dates:${symbol}:empty`);
      setInternalSetting(CURSOR_KEY, symbol);
      continue;
    }
    assertOperationLeaseOwnership(claim);
    for (const ref of refs) observeReference(ref, dates.receivedAt);

    const pendingRetry =
      getInternalSetting<string>(BODY_RETRY_ACCESSION_KEY) ??
      getInternalSetting<string>(EMBED_RETRY_ACCESSION_KEY);
    const retryIndex = pendingRetry
      ? refs.findIndex((ref) => transcriptAccession(ref.symbol, ref.year, ref.quarter) === pendingRetry)
      : -1;
    const refsInAttemptOrder = retryIndex > 0
      ? [refs[retryIndex]!, ...refs.slice(0, retryIndex), ...refs.slice(retryIndex + 1)]
      : refs;
    const latest = refs[0];
    const latestStored = latest
      ? hasIngestedAccession(
        transcriptAccession(latest.symbol, latest.year, latest.quarter),
        FMP_TRANSCRIPT_DOC_TYPE
      )
      : false;
    const cap = fmpTranscriptCapThisVisit({
      latestStored,
      highInterest: highInterest.has(symbol),
      maxPerSymbol: maxTranscriptsPerSymbol()
    });
    const refsToAttempt: FmpTranscriptRef[] = [];
    for (const ref of refsInAttemptOrder) {
      const accession = transcriptAccession(ref.symbol, ref.year, ref.quarter);
      // A parked retry still runs even when the latest-only cap would skip this name.
      if (pendingRetry && accession === pendingRetry) {
        refsToAttempt.push(ref);
        continue;
      }
      if (refsToAttempt.length >= cap) break;
      refsToAttempt.push(ref);
    }

    let retrySameSymbol = false;
    for (const ref of refsToAttempt) {
      const accession = transcriptAccession(ref.symbol, ref.year, ref.quarter);
      const { hasIngestTextBudget, hasVectorIngestWriteBudget } = await import("../vector-db");
      if (!hasIngestTextBudget(userId) || !hasVectorIngestWriteBudget(userId)) {
        result.deferredForEmbedBudget += 1;
        retrySameSymbol = true;
        break;
      }
      if (budget.remaining <= 0) {
        result.deferredForRequestBudget += 1;
        retrySameSymbol = true;
        break;
      }

      result.transcriptsAttempted += 1;
      const body = await requestFmpJson(
        endpoint("earning-call-transcript", { symbol: ref.symbol, year: ref.year, quarter: ref.quarter }),
        resolved.key,
        resolved.source,
        userId,
        budget,
        httpRetries(),
        transcriptResponseBytes(),
        "body",
        claim,
        leaseSignal
      );
      throwIfOperationLeaseCancelled(leaseSignal);
      assertOperationLeaseOwnership(claim);
      assertFmpTranscriptRightsGeneration(rightsClaim);
      if (!body.ok) {
        markDeferral(result, body);
        result.errors.push(describeFailure("body", ref.symbol, body));
        if (body.kind === "endpoint_not_entitled") {
          clearBodyRetryAccession(accession);
          result.capability = "endpoint_not_entitled";
          recordCapability("endpoint_not_entitled", observedAt, body.status ?? 402);
          break symbolLoop;
        }
        if (body.kind === "access_denied") {
          clearBodyRetryAccession(accession);
          result.capability = "access_denied";
          recordCapability("access_denied", observedAt, body.status);
          break symbolLoop;
        }
        if (body.kind === "request_budget" || body.kind === "provider_quota") {
          retrySameSymbol = true;
          break;
        }
        if (body.kind === "transient") {
          // Retry one failed body accession at the front of the very next run. If it fails again,
          // advance the symbol cursor so one unhealthy period cannot starve a large universe.
          if (getInternalSetting<string>(BODY_RETRY_ACCESSION_KEY) === accession) {
            deleteInternalSetting(BODY_RETRY_ACCESSION_KEY);
          } else {
            setInternalSetting(BODY_RETRY_ACCESSION_KEY, accession);
            retrySameSymbol = true;
          }
          break;
        }
        clearBodyRetryAccession(accession);
        continue;
      }

      clearBodyRetryAccession(accession);
      const transcript = parseFmpTranscriptBody(body.payload, ref);
      if (!transcript) {
        result.retryableEmpty += 1;
        result.errors.push(`body:${ref.symbol}:empty`);
        continue;
      }

      if (result.capability !== "available") {
        result.capability = "available";
        recordCapability("available", body.receivedAt, 200);
      }
      assertOperationLeaseOwnership(claim);
      observeContent(transcript, body.receivedAt);
      const { contentSha256, versionIdSuffix } = transcriptContentVersion(transcript.content);
      const versionId = `${accession}:${versionIdSuffix}`;
      const priorVersion = getFmpTranscriptVersion(accession, contentSha256);
      // An exact vector-set reuse is still a successful ingestion when it repairs either durable
      // completion ledger. Only a replay whose version AND source ledger were already complete is
      // a skip. This distinction makes the operator counters/audit trail reflect durable work,
      // even when no provider upsert is needed on the retry.
      const sourceLedgerWasComplete = Boolean(getDb().prepare(`
        SELECT 1 AS ok FROM ingested_accessions WHERE accession = ? AND doc_type = ?
      `).get(accession, FMP_TRANSCRIPT_DOC_TYPE));
      const versionLedgerWasComplete = priorVersion?.state === "committed";
      const completionLedgersWereAlreadyComplete = sourceLedgerWasComplete && versionLedgerWasComplete;
      const version = observeFmpTranscriptVersion({
        versionId,
        accession,
        contentSha256,
        symbol: transcript.symbol,
        year: transcript.year,
        quarter: transcript.quarter,
        callDate: transcript.callDate,
        observedAt: body.receivedAt
      });
      const retrievalAvailableAt = priorVersion && priorVersion.callDate !== version.callDate
        ? body.receivedAt
        : version.firstContentSeenAt;
      // Even byte-identical content must reach storeDocument: corrected call/publication metadata
      // creates a distinct retrieval generation. An exact content+metadata replay is still free;
      // storeDocument proves/reuses the committed generation without provider I/O.
      setFmpTranscriptVersionState(version.versionId, "indexing", { at: body.receivedAt });
      const { storeDocument } = await import("../vector-db");
      assertOperationLeaseOwnership(claim);
      assertFmpTranscriptRightsGeneration(rightsClaim);
      const stored = await storeDocument(
        {
          text: transcript.content,
          doc_id: version.versionId,
          ticker: transcript.symbol,
          title: `${transcript.symbol} earnings call ${transcript.year} Q${transcript.quarter}`,
          doc_type: FMP_TRANSCRIPT_DOC_TYPE,
          // The call date remains event metadata. If absent, the first observed availability is the
          // only honest publication timestamp we have.
          published_at: version.callDate ?? version.firstContentSeenAt,
          acceptance_datetime: retrievalAvailableAt,
          source: FMP_TRANSCRIPT_SOURCE,
          // Key-free provider locator. It is stored as metadata but never emitted to logs.
          url: endpoint("earning-call-transcript", {
            symbol: transcript.symbol,
            year: transcript.year,
            quarter: transcript.quarter
          })
        },
        userId,
        {
          contentVersion: contentSha256,
          documentKey: accession,
          parserRevision: "fmp-transcript-v1",
          leaseGuard: {
            assertOwnership: () => assertOperationLeaseOwnership(claim),
            signal: leaseSignal
          }
        }
      );
      assertOperationLeaseOwnership(claim);
      assertFmpTranscriptRightsGeneration(rightsClaim);

      if (stored.error) {
        setFmpTranscriptVersionState(version.versionId, "failed");
        result.errors.push(`embed:${transcript.symbol}:failed`);
        if (prioritizeEmbedRetry(accession)) {
          retrySameSymbol = true;
          break;
        }
        continue;
      }
      if ((stored.rejectedInvalidEmbeddings ?? 0) > 0) {
        setFmpTranscriptVersionState(version.versionId, "failed");
        // A partial vector write is not a complete transcript. Keep the same symbol/corpus period
        // retryable once so dedup can retain good chunks while rejected chunks are re-embedded.
        // A second consecutive rejection advances the symbol cursor; the accession remains
        // un-ingested and will be retried after the universe rotates instead of starving it.
        result.errors.push(`embed:${transcript.symbol}:invalid-embeddings`);
        if (prioritizeEmbedRetry(accession)) {
          retrySameSymbol = true;
          break;
        }
        continue;
      }
      const outOfCapacity =
        stored.unconfigured === true ||
        (stored.budgetSkipped ?? 0) > 0 ||
        (stored.writeUnitBudgetSkipped ?? 0) > 0;
      const reusedCommitted =
        stored.reusedCommitted === true && stored.documentComplete === true && stored.attempted > 0;
      if ((stored.indexed <= 0 && !reusedCommitted) || outOfCapacity) {
        setFmpTranscriptVersionState(version.versionId, "failed");
        if (outOfCapacity) {
          result.deferredForEmbedBudget += 1;
          retrySameSymbol = true;
          break;
        }
        result.errors.push(`embed:${transcript.symbol}:empty`);
        if (prioritizeEmbedRetry(accession)) {
          retrySameSymbol = true;
          break;
        }
        continue;
      }
      if (stored.documentComplete !== true || (!reusedCommitted && stored.indexed !== stored.attempted)) {
        setFmpTranscriptVersionState(version.versionId, "failed");
        // Defense in depth: source-level completion requires a real per-occurrence Pinecone write for
        // every chunk plus storeDocument's required local receipt transaction. Content-only dedup or
        // an unexplained partial result stays retryable even if a future caller mislabels it complete.
        result.errors.push(`embed:${transcript.symbol}:incomplete`);
        if (prioritizeEmbedRetry(accession)) {
          retrySameSymbol = true;
          break;
        }
        continue;
      }
      if (!stored.managedCommitProof) {
        setFmpTranscriptVersionState(version.versionId, "failed");
        result.errors.push(`embed:${transcript.symbol}:commit-proof-missing`);
        if (prioritizeEmbedRetry(accession)) {
          retrySameSymbol = true;
          break;
        }
        continue;
      }

      clearEmbedRetryAccession(accession);
      assertOperationLeaseOwnership(claim);
      // `attempted` is the complete document chunk count. A retry after a budget-limited partial
      // write may index only the remaining chunks; persisting only this run's indexed delta would
      // make the completion ledger/admin coverage permanently undercount the transcript.
      try {
        runWithActiveVectorCommitProof(stored.managedCommitProof, () => {
          recordIngestedTranscript(accession, transcript.symbol, stored.attempted, body.receivedAt);
          setFmpTranscriptVersionState(version.versionId, "committed", {
            vectorCommitId: stored.managedCommitProof!.commitId,
            chunkCount: stored.attempted,
            at: body.receivedAt
          });
        });
      } catch {
        setFmpTranscriptVersionState(version.versionId, "failed");
        result.errors.push(`embed:${transcript.symbol}:commit-proof-lost`);
        if (prioritizeEmbedRetry(accession)) {
          retrySameSymbol = true;
          break;
        }
        continue;
      }
      // A completed source/version ledger is not enough to call this a replay: a provider-authority
      // change or repaired provider set can require real new vectors. Only storeDocument's exact
      // committed-set proof turns an already-complete ledger into a true zero-write replay.
      const exactReplayWasAlreadyComplete = reusedCommitted && completionLedgersWereAlreadyComplete;
      const deduplicatedCompletion = reusedCommitted && !completionLedgersWereAlreadyComplete;
      if (exactReplayWasAlreadyComplete) result.skippedExisting += 1;
      else result.ingested += 1;
      audit("fmp_transcript_ingest", {
        accession,
        versionId: version.versionId,
        contentSha256,
        symbol: transcript.symbol,
        year: transcript.year,
        quarter: transcript.quarter,
        callDate: version.callDate,
        firstContentSeenAt: version.firstContentSeenAt,
        availabilityBasis: "first_observed_by_app",
        chunks: stored.attempted,
        indexedThisAttempt: stored.indexed,
        reusedCommitted,
        deduplicatedCompletion,
        exactReplayWasAlreadyComplete,
        contentLogged: false
      });
    }
    if (retrySameSymbol) break;
    setInternalSetting(CURSOR_KEY, symbol);
  }

  result.requests = budget.used;
  assertOperationLeaseOwnership(claim);
  if (result.capability === "endpoint_not_entitled" || result.capability === "access_denied") {
    setInternalSetting(NEXT_ATTEMPT_KEY, new Date(now + notEntitledRetryMs()).toISOString());
  } else if (!shouldRetrySoon(result)) {
    setInternalSetting(NEXT_ATTEMPT_KEY, new Date(now + ttlMs()).toISOString());
  }
  audit("fmp_transcript_refresh", {
    ...result,
    cursor: getInternalSetting<string>(CURSOR_KEY),
    contentLogged: false,
    featureDefault: "off"
  });
  return result;
}
