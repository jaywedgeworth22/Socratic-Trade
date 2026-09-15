// db-learning.ts — audit-event helpers, counterfactual learning watermarks/candidates,
// learned-context fact-tier functions, and RAG ingestion (ingested_accessions).
import "server-only";
import { getDb } from "./db";
import { mergeHorizonRows } from "./outcome-horizons";
import { yieldEventLoop } from "./slow-sync-guard";
import type { LearnedContextRow, LearnedContextPendingRow, LearnedContextPendingStatus, SocraticOutcomeHorizonRow } from "./types";

// ── Audit-event helpers ────────────────────────────────────────────────────────

export function listAudit(
  limit = 100,
  userId: string = "local",
  connectedAccountId?: string,
  includeUserWide = false
): Array<{ id: string; createdAt: string; kind: string; payload: unknown; connectedAccountId?: string }> {
  const rows = (connectedAccountId
    ? getDb()
      .prepare(
        `SELECT id, connected_account_id, created_at, kind, payload
         FROM audit_events
         WHERE user_id = ? AND (connected_account_id = ?${includeUserWide ? " OR connected_account_id IS NULL" : ""})
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .all(userId, connectedAccountId, limit)
    : getDb()
      .prepare("SELECT id, connected_account_id, created_at, kind, payload FROM audit_events WHERE user_id = ? ORDER BY created_at DESC LIMIT ?")
      .all(userId, limit)) as Array<{ id: string; connected_account_id: string | null; created_at: string; kind: string; payload: string }>;
  return rows.map((row) => ({
    id: row.id,
    createdAt: row.created_at,
    kind: row.kind,
    payload: JSON.parse(row.payload),
    connectedAccountId: row.connected_account_id ?? undefined
  }));
}

export interface AuditEventRow {
  id: string;
  createdAt: string;
  kind: string;
  payload: unknown;
  connectedAccountId?: string;
}

/** Newer of two audit rows by `createdAt` (undefined-safe). For call sites that must judge
 *  freshness across two different audit KINDS, either of which can independently hold the
 *  most recent evidence (e.g. a scheduled `market_scan` vs an LLM `strategy_run`). */
export function newerAuditEntry(a: AuditEventRow | undefined, b: AuditEventRow | undefined): AuditEventRow | undefined {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(b.createdAt) > Date.parse(a.createdAt) ? b : a;
}

/** Stamp-only sibling of latestAuditByKind: id + created_at, payload NEVER read. Use this for
 *  staleness gates that run on a cadence — the payload of market_scan/strategy_run rows is
 *  multi-MB, and reading it just to compare a timestamp was the 2026-08-02 prod wedge's every-
 *  tick cost. Served by idx_audit_events_kind_user_created as a pure index seek. */
export function latestAuditStampByKind(
  kind: string,
  userId: string = "local",
  connectedAccountId?: string
): { id: string; createdAt: string } | undefined {
  const row = (connectedAccountId
    ? getDb()
      .prepare("SELECT id, created_at FROM audit_events WHERE kind = ? AND user_id = ? AND connected_account_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(kind, userId, connectedAccountId)
    : getDb()
      .prepare("SELECT id, created_at FROM audit_events WHERE kind = ? AND user_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(kind, userId)) as { id: string; created_at: string } | undefined;
  return row ? { id: row.id, createdAt: row.created_at } : undefined;
}

export function latestAuditByKind(
  kind: string,
  userId: string = "local",
  connectedAccountId?: string
): AuditEventRow | undefined {
  const row = (connectedAccountId
    ? getDb()
      .prepare("SELECT id, connected_account_id, created_at, kind, payload FROM audit_events WHERE kind = ? AND user_id = ? AND connected_account_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(kind, userId, connectedAccountId)
    : getDb()
      .prepare("SELECT id, connected_account_id, created_at, kind, payload FROM audit_events WHERE kind = ? AND user_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(kind, userId)) as { id: string; connected_account_id: string | null; created_at: string; kind: string; payload: string } | undefined;
  if (!row) return undefined;
  return {
    id: row.id,
    createdAt: row.created_at,
    kind: row.kind,
    payload: JSON.parse(row.payload),
    connectedAccountId: row.connected_account_id ?? undefined
  };
}

/**
 * Recent audit events of ONE kind, newest first. Unlike `listAudit` (all kinds, then the
 * caller filters), the LIMIT applies AFTER the kind filter — so a flood of newer audit rows
 * of other kinds can never push the requested kind's history out of the window (Codex review
 * on PR #365: `getRedTeamEfficacy` scanned the all-kind feed and could report zero/partial
 * veto history in busy accounts). When `connectedAccountId` is given, user-wide rows
 * (connected_account_id IS NULL) are included too: veto audits were historically written
 * user-wide, so an account-scoped query must not silently drop that legacy history.
 */
export function listAuditByKind(
  kind: string,
  limit = 100,
  userId: string = "local",
  connectedAccountId?: string
): Array<{ id: string; createdAt: string; kind: string; payload: unknown; connectedAccountId?: string }> {
  const rows = (connectedAccountId
    ? getDb()
      .prepare(
        `SELECT id, connected_account_id, created_at, kind, payload
         FROM audit_events
         WHERE kind = ? AND user_id = ? AND (connected_account_id = ? OR connected_account_id IS NULL)
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .all(kind, userId, connectedAccountId, limit)
    : getDb()
      .prepare(
        `SELECT id, connected_account_id, created_at, kind, payload
         FROM audit_events
         WHERE kind = ? AND user_id = ?
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .all(kind, userId, limit)) as Array<{ id: string; connected_account_id: string | null; created_at: string; kind: string; payload: string }>;
  return rows.map((row) => ({
    id: row.id,
    createdAt: row.created_at,
    kind: row.kind,
    payload: JSON.parse(row.payload),
    connectedAccountId: row.connected_account_id ?? undefined
  }));
}

/**
 * Fast count of recent audit events of a specific kind, without loading JSON payloads.
 * Used for real-time error rate gating (e.g. order_placement_uncertain checks).
 */
export function countRecentAuditEvents(
  kind: string,
  connectedAccountId: string,
  minutes: number,
  userId: string = "local"
): number {
  const sinceIso = new Date(Date.now() - minutes * 60000).toISOString();
  
  const row = getDb().prepare(
    `SELECT COUNT(*) as count 
     FROM audit_events 
     WHERE kind = ? AND user_id = ? AND (connected_account_id = ? OR connected_account_id IS NULL)
     AND created_at >= ?`
  ).get(kind, userId, connectedAccountId, sinceIso) as { count: number };
  
  return row.count;
}

/**
 * Recent audit rows of ANY of `kinds` created at/after `sinceIso`, newest first. One IN-query
 * (not N listAuditByKind calls) so the daily learning review's system-history digest — the set of
 * execution-failure kinds it checks lesson evidence against — is a single cheap read.
 */
export function listAuditByKindsSince(
  kinds: string[],
  sinceIso: string,
  userId: string = "local",
  limit = 200
): Array<{ id: string; createdAt: string; kind: string; payload: unknown }> {
  if (kinds.length === 0) return [];
  const placeholders = kinds.map(() => "?").join(",");
  const rows = getDb()
    .prepare(
      `SELECT id, created_at, kind, payload
       FROM audit_events
       WHERE user_id = ? AND kind IN (${placeholders}) AND created_at >= ?
       ORDER BY created_at DESC
       LIMIT ?`
    )
    .all(userId, ...kinds, sinceIso, limit) as Array<{ id: string; created_at: string; kind: string; payload: string }>;
  return rows.map((row) => ({ id: row.id, createdAt: row.created_at, kind: row.kind, payload: JSON.parse(row.payload) }));
}

export interface SignalSnapshotAuditRow {
  rowid: number;
  id: string;
  createdAt: string;
  payload: unknown;
}

export function listSignalSnapshotAuditAfter(
  userId: string = "local",
  watermark?: { lastAuditRowid?: number },
  limit = 100,
  connectedAccountId?: string
): SignalSnapshotAuditRow[] {
  const hasWatermark = typeof watermark?.lastAuditRowid === "number";
  // Per-account scoping: when an account id is given, only that account's snapshots count toward
  // its learning. rowid is globally monotonic, so `rowid > lastAuditRowid AND account = ?` advances
  // each account's watermark over its own rows independently.
  const accountClause = connectedAccountId ? " AND connected_account_id = ?" : "";
  const rows = hasWatermark
    ? (getDb()
        .prepare(
          `SELECT rowid, id, created_at, payload
           FROM audit_events
           WHERE user_id = ?
            AND kind = 'signal_snapshot'
            AND rowid > ?${accountClause}
           ORDER BY rowid ASC
           LIMIT ?`
        )
        .all(...(connectedAccountId
          ? [userId, watermark!.lastAuditRowid, connectedAccountId, limit]
          : [userId, watermark!.lastAuditRowid, limit])) as Array<{ rowid: number; id: string; created_at: string; payload: string }>)
    : (getDb()
        .prepare(
          `SELECT rowid, id, created_at, payload
           FROM audit_events
           WHERE user_id = ? AND kind = 'signal_snapshot'${accountClause}
           ORDER BY rowid ASC
           LIMIT ?`
        )
        .all(...(connectedAccountId ? [userId, connectedAccountId, limit] : [userId, limit])) as Array<{ rowid: number; id: string; created_at: string; payload: string }>);

  return rows.map((row) => ({ rowid: row.rowid, id: row.id, createdAt: row.created_at, payload: JSON.parse(row.payload) }));
}

export interface RagCandidatePoolAuditRow {
  id: string;
  createdAt: string;
  payload: unknown;
}

/**
 * `rag_candidate_pool` audit rows for one (runId, symbol) retrieval call — the lookahead audit's
 * join from a sampled decision back to the candidate pool its retrieval persisted (opt-in via
 * RAG_PERSIST_CANDIDATE_POOL; see rag/candidate-pool.ts). More than one row can exist per pair
 * when several retrieval passes ran for the same symbol in a run (filings vs episodic), so the
 * caller disambiguates by the record's queryHash. Symbol matching is case/whitespace-insensitive —
 * pool records store the raw retrieval `symbol` argument, not a normalized form.
 */
export function listRagCandidatePoolAudit(
  userId: string,
  runId: string,
  symbol: string,
  limit = 8
): RagCandidatePoolAuditRow[] {
  const rows = getDb()
    .prepare(
      `SELECT id, created_at, payload
       FROM audit_events
       WHERE user_id = ?
         AND kind = 'rag_candidate_pool'
         AND json_extract(payload, '$.runId') = ?
         AND UPPER(TRIM(json_extract(payload, '$.symbol'))) = ?
       ORDER BY created_at ASC
       LIMIT ?`
    )
    .all(userId, runId, symbol.trim().toUpperCase(), limit) as Array<{ id: string; created_at: string; payload: string }>;
  return rows.map((row) => ({ id: row.id, createdAt: row.created_at, payload: JSON.parse(row.payload) }));
}

// ── Counterfactual learning watermarks ────────────────────────────────────────

export interface CounterfactualLearningWatermark {
  userId: string;
  lastAuditRowid?: number;
  lastAuditCreatedAt?: string;
  lastAuditId?: string;
  updatedAt: string;
}

// Per-account watermarks: the table's PK is (user_id, connected_account_id). The account-agnostic
// (user-wide) watermark is stored with connected_account_id = '' (empty string, never NULL) so the
// composite PK stays well-defined — SQLite would treat multiple NULLs as distinct, breaking upserts.
export function getCounterfactualLearningWatermark(
  userId: string = "local",
  connectedAccountId?: string
): CounterfactualLearningWatermark | undefined {
  const row = getDb()
    .prepare("SELECT user_id, last_audit_rowid, last_audit_created_at, last_audit_id, updated_at FROM counterfactual_learning_watermarks WHERE user_id = ? AND connected_account_id = ?")
    .get(userId, connectedAccountId ?? "") as { user_id: string; last_audit_rowid: number | null; last_audit_created_at: string | null; last_audit_id: string | null; updated_at: string } | undefined;
  if (!row) return undefined;
  return {
    userId: row.user_id,
    lastAuditRowid: row.last_audit_rowid ?? undefined,
    lastAuditCreatedAt: row.last_audit_created_at ?? undefined,
    lastAuditId: row.last_audit_id ?? undefined,
    updatedAt: row.updated_at
  };
}

export function setCounterfactualLearningWatermark(input: {
  userId?: string;
  connectedAccountId?: string;
  lastAuditRowid?: number;
  lastAuditCreatedAt?: string;
  lastAuditId?: string;
  updatedAt?: string;
}): void {
  const userId = input.userId ?? "local";
  const connectedAccountId = input.connectedAccountId ?? "";
  const updatedAt = input.updatedAt ?? new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO counterfactual_learning_watermarks (user_id, connected_account_id, last_audit_rowid, last_audit_created_at, last_audit_id, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, connected_account_id) DO UPDATE SET
        last_audit_rowid = excluded.last_audit_rowid,
        last_audit_created_at = excluded.last_audit_created_at,
        last_audit_id = excluded.last_audit_id,
        updated_at = excluded.updated_at`
    )
    .run(userId, connectedAccountId, input.lastAuditRowid ?? null, input.lastAuditCreatedAt ?? null, input.lastAuditId ?? null, updatedAt);
}

// ── Skipped-candidate counterfactuals ─────────────────────────────────────────

export interface SkippedCounterfactualCandidateInput {
  userId?: string;
  connectedAccountId?: string;
  runId: string;
  symbol: string;
  snapshotAt: string;
  refPrice: number;
  horizonDays: number;
  targetDate: string;
  score?: number;
  sector?: string;
  regime?: string;
  dominantFactor?: string;
  bulletins?: string[];
  now?: string;
}

export interface SkippedCounterfactualRow {
  id: string;
  userId: string;
  runId: string;
  symbol: string;
  snapshotAt: string;
  refPrice: number;
  horizonDays: number;
  targetDate: string;
  status: "pending" | "matured" | "unresolvable";
  exitDate?: string;
  exitPrice?: number;
  returnPct?: number;
  score?: number;
  sector?: string;
  regime?: string;
  dominantFactor?: string;
  bulletins?: string[];
  /** Multi-horizon outcome rows (15m/1h/1d/1w) written at maturation; each row is individually
   * 'ok' or honestly 'unresolvable'. Absent on rows matured before the multi-horizon schema. */
  outcomes?: SocraticOutcomeHorizonRow[];
  /** Terminal reason when status === 'unresolvable' (e.g. "no_price_series",
   * "no_bar_at_or_after_target" — delisted/renamed symbols land here after the bounded recheck window). */
  resolutionReason?: string;
  lastCheckedAt?: string;
  createdAt: string;
  updatedAt: string;
}

type RawSkippedCounterfactualRow = {
  id: string;
  user_id: string;
  run_id: string;
  symbol: string;
  snapshot_at: string;
  ref_price: number;
  horizon_days: number;
  target_date: string;
  status: string;
  exit_date: string | null;
  exit_price: number | null;
  return_pct: number | null;
  score: number | null;
  sector: string | null;
  regime: string | null;
  dominant_factor: string | null;
  bulletins: string | null;
  outcomes: string | null;
  resolution_reason: string | null;
  last_checked_at: string | null;
  created_at: string;
  updated_at: string;
};

function toSkippedCounterfactualRow(row: RawSkippedCounterfactualRow): SkippedCounterfactualRow {
  return {
    id: row.id,
    userId: row.user_id,
    runId: row.run_id,
    symbol: row.symbol,
    snapshotAt: row.snapshot_at,
    refPrice: row.ref_price,
    horizonDays: row.horizon_days,
    targetDate: row.target_date,
    status: row.status === "matured" ? "matured" : row.status === "unresolvable" ? "unresolvable" : "pending",
    exitDate: row.exit_date ?? undefined,
    exitPrice: row.exit_price ?? undefined,
    returnPct: row.return_pct ?? undefined,
    score: row.score ?? undefined,
    sector: row.sector ?? undefined,
    regime: row.regime ?? undefined,
    dominantFactor: row.dominant_factor ?? undefined,
    bulletins: row.bulletins ? JSON.parse(row.bulletins) as string[] : undefined,
    outcomes: row.outcomes ? JSON.parse(row.outcomes) as SocraticOutcomeHorizonRow[] : undefined,
    resolutionReason: row.resolution_reason ?? undefined,
    lastCheckedAt: row.last_checked_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

/** Deterministic skipped-candidate-counterfactual row id — single-sourced here so callers that need
 * to reference the row before/without re-reading it (e.g. enqueueing its intraday sample due-jobs
 * right after insert) can derive the same id rather than duplicating the format. */
export function skippedCounterfactualId(userId: string, runId: string, symbol: string, horizonDays: number): string {
  return `${userId}:${runId}:${symbol}:${horizonDays}`;
}

export function insertSkippedCounterfactualCandidate(input: SkippedCounterfactualCandidateInput): boolean {
  const userId = input.userId ?? "local";
  const now = input.now ?? new Date().toISOString();
  const id = skippedCounterfactualId(userId, input.runId, input.symbol, input.horizonDays);
  const db = getDb();
  const existing = db
    .prepare("SELECT id FROM skipped_candidate_counterfactuals WHERE id = ? AND user_id = ?")
    .get(id, userId);
  if (existing) {
    // A row for this (runId, symbol, horizon) already exists — e.g. a Bear-veto/policy-block
    // early insert that carried only `regime`, later followed by the run's richer
    // signal_snapshot ingestion carrying score/sector/dominant-factor/bulletin evidence
    // (Codex review on PR #365: pure INSERT OR IGNORE let the early bare insert permanently
    // strip the matured row of the evidence metadata missed-opportunity analytics/tuning read).
    // Backfill ONLY evidence columns that are still NULL: the first write stays authoritative
    // for pricing/snapshot/status (never re-priced), existing evidence is never overwritten,
    // and updated_at is left alone so metadata backfill can't reorder maturation listings.
    if (
      input.score !== undefined ||
      input.sector !== undefined ||
      input.regime !== undefined ||
      input.dominantFactor !== undefined ||
      (input.bulletins && input.bulletins.length > 0)
    ) {
      db.prepare(
        `UPDATE skipped_candidate_counterfactuals SET
          score = COALESCE(score, ?),
          sector = COALESCE(sector, ?),
          regime = COALESCE(regime, ?),
          dominant_factor = COALESCE(dominant_factor, ?),
          bulletins = COALESCE(bulletins, ?)
         WHERE id = ? AND user_id = ?`
      ).run(
        input.score ?? null,
        input.sector ?? null,
        input.regime ?? null,
        input.dominantFactor ?? null,
        input.bulletins && input.bulletins.length > 0 ? JSON.stringify(input.bulletins) : null,
        id,
        userId
      );
    }
    return false;
  }
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO skipped_candidate_counterfactuals (
        id, user_id, connected_account_id, run_id, symbol, snapshot_at, ref_price, horizon_days,
        target_date, status, score, sector, regime, dominant_factor, bulletins,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      userId,
      input.connectedAccountId ?? null,
      input.runId,
      input.symbol,
      input.snapshotAt,
      input.refPrice,
      input.horizonDays,
      input.targetDate,
      input.score ?? null,
      input.sector ?? null,
      input.regime ?? null,
      input.dominantFactor ?? null,
      input.bulletins ? JSON.stringify(input.bulletins) : null,
      now,
      now
    );
  return result.changes > 0;
}

export function listPendingSkippedCounterfactuals(input: {
  userId?: string;
  nowDate: string;
  checkedBefore?: string;
  limit?: number;
}): SkippedCounterfactualRow[] {
  const userId = input.userId ?? "local";
  const limit = input.limit ?? 50;
  const rows = getDb()
    .prepare(
      `SELECT *
       FROM skipped_candidate_counterfactuals
       WHERE user_id = ?
        AND status = 'pending'
        AND target_date <= ?
        AND (last_checked_at IS NULL OR last_checked_at <= ?)
       ORDER BY target_date ASC, snapshot_at ASC, symbol ASC
       LIMIT ?`
    )
    .all(userId, input.nowDate, input.checkedBefore ?? new Date(0).toISOString(), limit) as RawSkippedCounterfactualRow[];
  return rows.map(toSkippedCounterfactualRow);
}

export function markSkippedCounterfactualChecked(id: string, userId: string = "local", checkedAt: string = new Date().toISOString()): void {
  getDb()
    .prepare("UPDATE skipped_candidate_counterfactuals SET last_checked_at = ?, updated_at = ? WHERE id = ? AND user_id = ? AND status = 'pending'")
    .run(checkedAt, checkedAt, id, userId);
}

/** Fresh (uncached) read of just the persisted `outcomes` column for one counterfactual row — used
 * immediately before a terminal write to re-merge against whatever a concurrent worker may have
 * already written (see the lost-update guard note on markSkippedCounterfactualMatured). */
function readPersistedCounterfactualOutcomes(id: string, userId: string): SocraticOutcomeHorizonRow[] | undefined {
  const row = getDb()
    .prepare("SELECT outcomes FROM skipped_candidate_counterfactuals WHERE id = ? AND user_id = ?")
    .get(id, userId) as { outcomes: string | null } | undefined;
  if (!row?.outcomes) return undefined;
  try {
    return JSON.parse(row.outcomes) as SocraticOutcomeHorizonRow[];
  } catch {
    return undefined;
  }
}

/**
 * Lost-update guard: `input.outcomes` may have been built from a pass-start snapshot held across
 * awaits (materializeSkippedCandidateCounterfactuals / outcome-engine's counterfactual worker path),
 * so a worker-sampled 15m/1h row written concurrently could otherwise be erased by this stale write.
 * Re-merge against the FRESH persisted row right before persisting — mergeHorizonRows'
 * existing-terminal-wins semantics make this idempotent/first-writer-wins regardless of write order.
 */
export function markSkippedCounterfactualMatured(input: {
  id: string;
  userId?: string;
  exitDate: string;
  exitPrice: number;
  returnPct: number;
  /** Multi-horizon outcome rows (15m/1h/1d/1w) measured alongside the headline horizon return. */
  outcomes?: SocraticOutcomeHorizonRow[];
  checkedAt?: string;
}): boolean {
  const userId = input.userId ?? "local";
  const checkedAt = input.checkedAt ?? new Date().toISOString();
  const mergedOutcomes = mergeHorizonRows(readPersistedCounterfactualOutcomes(input.id, userId), input.outcomes ?? []);
  const result = getDb()
    .prepare(
      `UPDATE skipped_candidate_counterfactuals
       SET status = 'matured',
        exit_date = ?,
        exit_price = ?,
        return_pct = ?,
        outcomes = ?,
        last_checked_at = ?,
        updated_at = ?
       WHERE id = ? AND user_id = ? AND status = 'pending'`
    )
    .run(
      input.exitDate,
      input.exitPrice,
      input.returnPct,
      mergedOutcomes.length > 0 ? JSON.stringify(mergedOutcomes) : null,
      checkedAt,
      checkedAt,
      input.id,
      userId
    );
  return result.changes > 0;
}

/**
 * Terminal kill-survivorship transition: a pending counterfactual whose price series never resolved
 * within the bounded recheck window (delisted / renamed / no provider coverage) becomes
 * status='unresolvable' WITH a reason, instead of sitting 'pending' forever and silently dropping
 * out of every matured-outcome denominator. Unresolvable rows keep their optional multi-horizon
 * outcome rows (each marked unresolvable with its own reason) so coverage math can count them.
 *
 * Lost-update guard: same re-merge-at-write-time treatment as markSkippedCounterfactualMatured above
 * — a worker-sampled 15m/1h row must survive this terminal write even if `input.outcomes` is stale.
 */
export function markSkippedCounterfactualUnresolvable(input: {
  id: string;
  userId?: string;
  reason: string;
  outcomes?: SocraticOutcomeHorizonRow[];
  checkedAt?: string;
}): boolean {
  const userId = input.userId ?? "local";
  const checkedAt = input.checkedAt ?? new Date().toISOString();
  const mergedOutcomes = mergeHorizonRows(readPersistedCounterfactualOutcomes(input.id, userId), input.outcomes ?? []);
  const result = getDb()
    .prepare(
      `UPDATE skipped_candidate_counterfactuals
       SET status = 'unresolvable',
        resolution_reason = ?,
        outcomes = ?,
        last_checked_at = ?,
        updated_at = ?
       WHERE id = ? AND user_id = ? AND status = 'pending'`
    )
    .run(input.reason, mergedOutcomes.length > 0 ? JSON.stringify(mergedOutcomes) : null, checkedAt, checkedAt, input.id, userId);
  return result.changes > 0;
}

/** Counterfactual rows by terminal/pending status — used to join unresolvable rows into scorecard
 * denominators (getRedTeamEfficacy, coverage disclosure). */
export function listSkippedCounterfactualsByStatus(
  userId: string = "local",
  status: "pending" | "matured" | "unresolvable",
  limit = 200,
  connectedAccountId?: string
): SkippedCounterfactualRow[] {
  const rows = (connectedAccountId
    ? getDb()
        .prepare(
          `SELECT * FROM skipped_candidate_counterfactuals
           WHERE user_id = ? AND status = ? AND connected_account_id = ?
           ORDER BY updated_at DESC LIMIT ?`
        )
        .all(userId, status, connectedAccountId, limit)
    : getDb()
        .prepare(
          `SELECT * FROM skipped_candidate_counterfactuals
           WHERE user_id = ? AND status = ?
           ORDER BY updated_at DESC LIMIT ?`
        )
        .all(userId, status, limit)) as RawSkippedCounterfactualRow[];
  return rows.map(toSkippedCounterfactualRow);
}

/** Status counts for the skipped-counterfactual pipeline. Unresolvable rows count in the total
 * denominator (kill-survivorship): resolvedPct = matured / (matured + unresolvable + due-pending
 * excluded — pending rows whose target date hasn't arrived are NOT "unresolved", just immature). */
export interface SkippedCounterfactualCoverage {
  total: number;
  matured: number;
  pending: number;
  unresolvable: number;
  /** matured / (matured + unresolvable) as a %, 0 when nothing terminal yet. */
  resolvedPct: number;
  /** Human disclosure line, e.g. "12/15 resolved (80%) — 3 unresolvable; may be survivor-biased". */
  disclosure: string;
}

export function getSkippedCounterfactualCoverage(
  userId: string = "local",
  connectedAccountId?: string
): SkippedCounterfactualCoverage {
  const rows = (connectedAccountId
    ? getDb()
        .prepare(
          `SELECT status, COUNT(*) AS n FROM skipped_candidate_counterfactuals
           WHERE user_id = ? AND connected_account_id = ? GROUP BY status`
        )
        .all(userId, connectedAccountId)
    : getDb()
        .prepare("SELECT status, COUNT(*) AS n FROM skipped_candidate_counterfactuals WHERE user_id = ? GROUP BY status")
        .all(userId)) as Array<{ status: string; n: number }>;
  const count = (status: string) => rows.find((r) => r.status === status)?.n ?? 0;
  const matured = count("matured");
  const pending = count("pending");
  const unresolvable = count("unresolvable");
  const terminal = matured + unresolvable;
  const resolvedPct = terminal > 0 ? Number(((matured / terminal) * 100).toFixed(1)) : 0;
  const disclosure =
    terminal > 0
      ? `${matured}/${terminal} resolved (${resolvedPct}%)${unresolvable > 0 ? ` — ${unresolvable} unresolvable; may be survivor-biased` : ""}${pending > 0 ? `; ${pending} still maturing` : ""}`
      : `0 resolved${pending > 0 ? `; ${pending} still maturing` : ""}`;
  return { total: matured + pending + unresolvable, matured, pending, unresolvable, resolvedPct, disclosure };
}

/**
 * Merge freshly-sampled intraday (15m/1h) horizon rows into a still-'pending' counterfactual's
 * `outcomes` column WITHOUT touching status/exit fields — used by the due-jobs intraday sampler
 * (outcome-engine.ts's drainDueIntradaySampleJobs), which resolves one horizon at a time and is not
 * the pipeline that closes the whole counterfactual (that's markSkippedCounterfactualMatured /
 * markSkippedCounterfactualUnresolvable, both status='pending'-gated same as this). A no-op once the
 * row has already gone terminal (matured/unresolvable) — those rows' outcomes are owned by their own
 * terminal writer, not by a late-arriving intraday sample.
 */
export function updateSkippedCounterfactualOutcomes(
  id: string,
  userId: string,
  outcomes: SocraticOutcomeHorizonRow[],
  updatedAt: string = new Date().toISOString()
): boolean {
  const result = getDb()
    .prepare(
      `UPDATE skipped_candidate_counterfactuals
       SET outcomes = ?, updated_at = ?
       WHERE id = ? AND user_id = ? AND status = 'pending'`
    )
    .run(JSON.stringify(outcomes), updatedAt, id, userId);
  return result.changes > 0;
}

/** One counterfactual row by its natural join key (runId, symbol) — the outcome engine joins
 * blocked/rejected/vetoed decision cases to their forward returns through this. */
export function getSkippedCounterfactualByRunSymbol(
  userId: string,
  runId: string,
  symbol: string
): SkippedCounterfactualRow | undefined {
  const row = getDb()
    .prepare(
      `SELECT * FROM skipped_candidate_counterfactuals
       WHERE user_id = ? AND run_id = ? AND symbol = ?
       ORDER BY horizon_days ASC LIMIT 1`
    )
    .get(userId, runId, symbol) as RawSkippedCounterfactualRow | undefined;
  return row ? toSkippedCounterfactualRow(row) : undefined;
}

/** Exact counterfactual row by its full natural key (runId, symbol, horizonDays) — used by the
 * durable due-jobs intraday sampler (outcome-engine.ts's drainDueIntradaySampleJobs), which carries
 * horizonDays explicitly in its job payload rather than guessing via min(horizon_days) the way
 * getSkippedCounterfactualByRunSymbol does. A (runId, symbol) pair can have more than one row across
 * different horizons (e.g. a Bear-veto early insert vs. the run's own signal-snapshot ingestion using
 * a different configured horizonDays) — this disambiguates to the exact owning row instead of always
 * picking the shortest horizon. */
export function getSkippedCounterfactualByRunSymbolHorizon(
  userId: string,
  runId: string,
  symbol: string,
  horizonDays: number
): SkippedCounterfactualRow | undefined {
  const row = getDb()
    .prepare(
      `SELECT * FROM skipped_candidate_counterfactuals
       WHERE user_id = ? AND run_id = ? AND symbol = ? AND horizon_days = ?
       LIMIT 1`
    )
    .get(userId, runId, symbol, horizonDays) as RawSkippedCounterfactualRow | undefined;
  return row ? toSkippedCounterfactualRow(row) : undefined;
}

export function listMaturedSkippedCounterfactuals(
  userId: string = "local",
  limit = 50,
  connectedAccountId?: string
): SkippedCounterfactualRow[] {
  const rows = (connectedAccountId
    ? getDb()
        .prepare(
          `SELECT *
           FROM skipped_candidate_counterfactuals
           WHERE user_id = ? AND status = 'matured' AND connected_account_id = ?
           ORDER BY return_pct DESC, updated_at DESC
           LIMIT ?`
        )
        .all(userId, connectedAccountId, limit)
    : getDb()
        .prepare(
          `SELECT *
           FROM skipped_candidate_counterfactuals
           WHERE user_id = ? AND status = 'matured'
           ORDER BY return_pct DESC, updated_at DESC
           LIMIT ?`
        )
        .all(userId, limit)) as RawSkippedCounterfactualRow[];
  return rows.map(toSkippedCounterfactualRow);
}

/**
 * Unbiased recent matured counterfactuals for source/factor evaluation. Unlike the dashboard helper
 * above, this orders by decision time rather than return, so negative outcomes cannot fall out of a
 * top-return slice and make a provider look better than it was. Multiple horizons remain explicit;
 * analysis callers choose one deterministically for each (run, symbol).
 */
export function listRecentMaturedSkippedCounterfactuals(
  userId: string = "local",
  limit = 500,
  connectedAccountId?: string
): SkippedCounterfactualRow[] {
  const rows = (connectedAccountId
    ? getDb()
        .prepare(
          `SELECT *
           FROM skipped_candidate_counterfactuals
           WHERE user_id = ? AND status = 'matured' AND connected_account_id = ?
           ORDER BY snapshot_at DESC, horizon_days ASC
           LIMIT ?`
        )
        .all(userId, connectedAccountId, limit)
    : getDb()
        .prepare(
          `SELECT *
           FROM skipped_candidate_counterfactuals
           WHERE user_id = ? AND status = 'matured'
           ORDER BY snapshot_at DESC, horizon_days ASC
           LIMIT ?`
        )
        .all(userId, limit)) as RawSkippedCounterfactualRow[];
  return rows.map(toSkippedCounterfactualRow);
}

/**
 * The MATURED counterfactual row for one (runId, symbol) veto key — the precise join input
 * for the Red Team efficacy scorecard. Unlike joining against `listMaturedSkippedCounterfactuals`
 * (a return_pct-DESC top slice), a keyed lookup can never drop the low/negative-return rows —
 * the exact avoided-loss cases `vetoValueAddRate` exists to count (Codex review on PR #365).
 * Multiple horizons can exist per key; the shortest horizon wins deterministically.
 */
export function getMaturedSkippedCounterfactualByRunSymbol(
  userId: string,
  runId: string,
  symbol: string
): SkippedCounterfactualRow | undefined {
  const row = getDb()
    .prepare(
      `SELECT *
       FROM skipped_candidate_counterfactuals
       WHERE user_id = ? AND run_id = ? AND symbol = ? AND status = 'matured'
       ORDER BY horizon_days ASC
       LIMIT 1`
    )
    .get(userId, runId, symbol) as RawSkippedCounterfactualRow | undefined;
  return row ? toSkippedCounterfactualRow(row) : undefined;
}

// ── Learned-context fact-tier CRUD ────────────────────────────────────────────

interface RawLearnedContextRow {
  id: string;
  user_id: string;
  scope: string;
  kind: string;
  subject: string;
  symbol: string | null;
  value: string;
  source: string;
  origin: string;
  risk_tier: string;
  confidence: number;
  contributor_user_id: string | null;
  connected_account_id: string | null;
  account_environment: string | null;
  learning_scope: string;
  transfer_state: string;
  regime?: string | null;
  thesis_tag?: string | null;
  dominant_factor?: string | null;
  asserted_at: string;
  superseded_by: string | null;
  expires_at: string | null;
}

export function mapLearnedContext(row: RawLearnedContextRow): LearnedContextRow {
  return {
    id: row.id,
    userId: row.user_id,
    scope: row.scope as LearnedContextRow["scope"],
    kind: row.kind as LearnedContextRow["kind"],
    subject: row.subject,
    symbol: row.symbol,
    value: row.value,
    source: row.source,
    origin: row.origin as LearnedContextRow["origin"],
    riskTier: row.risk_tier as LearnedContextRow["riskTier"],
    confidence: row.confidence,
    contributorUserId: row.contributor_user_id,
    connectedAccountId: row.connected_account_id,
    accountEnvironment: row.account_environment as LearnedContextRow["accountEnvironment"],
   learningScope: row.learning_scope as LearnedContextRow["learningScope"],
    transferState: row.transfer_state as LearnedContextRow["transferState"],
    regime: row.regime ?? null,
    thesisTag: row.thesis_tag ?? null,
    dominantFactor: row.dominant_factor ?? null,
    assertedAt: row.asserted_at,
    supersededBy: row.superseded_by,
    expiresAt: row.expires_at
  };
}

export function insertLearnedContext(row: LearnedContextRow): LearnedContextRow {
  getDb()
    .prepare(
      `INSERT INTO learned_context
        (id, user_id, scope, kind, subject, symbol, value, source, origin, risk_tier, confidence, contributor_user_id,
         connected_account_id, account_environment, learning_scope, transfer_state, regime, thesis_tag, dominant_factor,
         asserted_at, superseded_by, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      row.id,
      row.userId,
      row.scope,
      row.kind,
      row.subject,
      row.symbol,
      row.value,
      row.source,
      row.origin,
      row.riskTier,
      row.confidence,
      row.contributorUserId,
      row.connectedAccountId,
      row.accountEnvironment,
      row.learningScope,
      row.transferState,
      row.regime ?? null,
      row.thesisTag ?? null,
      row.dominantFactor ?? null,
      row.assertedAt,
      row.supersededBy,
      row.expiresAt
    );
  return row;
}

export function findLiveLearnedContextBySubject(
  userId: string,
  kind: string,
  subject: string,
  symbol: string | null,
  connectedAccountId: string | null = null,
  learningScope: LearnedContextRow["learningScope"] = "portfolio"
): LearnedContextRow | null {
  const row = getDb()
    .prepare(
      `SELECT * FROM learned_context
       WHERE user_id = ? AND kind = ? AND subject = ? AND ((symbol IS NULL AND ? IS NULL) OR symbol = ?)
         AND learning_scope = ?
         AND ((connected_account_id IS NULL AND ? IS NULL) OR connected_account_id = ?)
         AND superseded_by IS NULL
       ORDER BY asserted_at DESC LIMIT 1`
    )
    .get(userId, kind, subject, symbol, symbol, learningScope, connectedAccountId, connectedAccountId) as
      | RawLearnedContextRow
      | undefined;
  return row ? mapLearnedContext(row) : null;
}

/**
 * Live FACT rows for a decision: the user's own private rows plus, when includeShared is set,
 * other contributors' opted-in shared rows. Filtered to the given symbols (plus symbol-less
 * rows, which are general facts) and to non-expired rows. READ-ONLY — never mutates.
 */
export function listLearnedContextForDecision(
  userId: string,
  symbols: string[],
  includeShared = false,
  connectedAccountId?: string
): LearnedContextRow[] {
  const nowIso = new Date().toISOString();
  const normalizedSymbols = new Set(symbols.map((s) => s.toUpperCase()));
  const rows = includeShared
    ? (getDb()
        .prepare(
          `SELECT * FROM learned_context
           WHERE superseded_by IS NULL AND risk_tier = 'fact'
             AND (user_id = ? OR scope = 'shared')`
        )
        .all(userId) as RawLearnedContextRow[])
    : (getDb()
        .prepare(
          `SELECT * FROM learned_context
           WHERE superseded_by IS NULL AND risk_tier = 'fact' AND user_id = ?`
        )
        .all(userId) as RawLearnedContextRow[]);
  return rows
    .map(mapLearnedContext)
    .filter((r) => {
      if (r.learningScope === "legacy") return false;
      if (r.userId === userId) {
        if (r.learningScope === "portfolio") return true;
        if (r.learningScope === "research") return r.transferState === "validated";
        // Per-user pooling (owner directive, 2026-07-23): NULL connectedAccountId = new per-user
        // pooled lessons. Non-NULL = legacy account-scoped — include them for backward compat
        // when no specific account filter is requested, or when they match the requested account.
        return r.connectedAccountId === null ||
          (connectedAccountId === undefined ? true : r.connectedAccountId === connectedAccountId);
      }
      if (!includeShared || r.scope !== "shared") return false;
      // Shared portfolio facts retain the user's explicit sharing behavior. Account-derived rows
      // never cross a user/account boundary; shared research must pass transfer validation first.
      return r.learningScope === "portfolio" ||
        (r.learningScope === "research" && r.transferState === "validated");
    })
    .filter((r) => r.expiresAt === null || r.expiresAt > nowIso)
    .filter((r) => r.symbol === null || normalizedSymbols.has(r.symbol.toUpperCase()));
}

export function listLearnedContext(userId: string): LearnedContextRow[] {
  const rows = getDb()
    .prepare("SELECT * FROM learned_context WHERE user_id = ? AND superseded_by IS NULL ORDER BY asserted_at DESC")
    .all(userId) as RawLearnedContextRow[];
  return rows.map(mapLearnedContext);
}

export function supersedeLearnedContext(oldId: string, newId: string): void {
  getDb().prepare("UPDATE learned_context SET superseded_by = ? WHERE id = ?").run(newId, oldId);
}

/**
 * Set an expiry on a live learned_context row (the daily learning review's 'expire' verdict:
 * "was true, no longer is"). Expired rows stop informing decisions via the existing
 * `expiresAt` filter in listLearnedContextForDecision but remain in the table for provenance —
 * softer than deleteLearnedContext. Ownership-scoped; returns false on a no-op.
 */
export function expireLearnedContext(id: string, userId: string, expiresAtIso: string = new Date().toISOString()): boolean {
  const result = getDb()
    .prepare("UPDATE learned_context SET expires_at = ? WHERE id = ? AND user_id = ?")
    .run(expiresAtIso, id, userId);
  return result.changes > 0;
}

/**
 * Erase a learned-context row the user no longer wants remembered. Scoped to `user_id` — the
 * ORIGINAL contributor, never a reader — so this also serves as the erasure path for a user's own
 * shared-scope contributions (a shared row's `user_id` stays its author; another user who merely
 * reads it via `includeShared` can never delete it). Returns false on a no-op (missing id or
 * foreign ownership) so the route can 404 instead of silently succeeding.
 */
export function deleteLearnedContext(id: string, userId: string): boolean {
  const result = getDb().prepare("DELETE FROM learned_context WHERE id = ? AND user_id = ?").run(id, userId);
  return result.changes > 0;
}

// ── RAG ingestion de-dup helpers ──────────────────────────────────────────────
// Keyed by (accession, doc_type) — globally unique for SEC filings, so no user scoping needed.

export interface IngestedAccessionRow {
  accession: string;
  docType: string;
  ticker: string;
  indexedAt: string;
  chunkCount: number;
}

/** Return true if this (accession, docType) pair has already been embedded. */
export function hasIngestedAccession(accession: string, docType: string): boolean {
  const row = getDb()
    .prepare("SELECT 1 FROM sec_filings WHERE accession = ? AND form = ? AND status = 'complete'")
    .get(accession, docType);
  if (row != null) return true;

  const legacyRow = getDb()
    .prepare("SELECT 1 FROM ingested_accessions WHERE accession = ? AND doc_type = ?")
    .get(accession, docType);
  return legacyRow != null;
}

/** Record a successfully-ingested accession so it is never re-embedded. */
export function insertIngestedAccession(
  accession: string,
  docType: string,
  ticker: string,
  chunkCount: number,
  extras?: { pineconeWriteClass?: string; pineconeVectorCount?: number }
): void {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      "INSERT OR IGNORE INTO ingested_accessions (accession, doc_type, ticker, indexed_at, chunk_count) VALUES (?, ?, ?, ?, ?)"
    )
    .run(accession, docType, ticker, now, chunkCount);
  if (extras && (extras.pineconeWriteClass !== undefined || extras.pineconeVectorCount !== undefined)) {
    const writeClass = extras.pineconeWriteClass ?? "full-body";
    const vectorCount = extras.pineconeVectorCount ?? 0;
    try {
      getDb()
        .prepare(
          `UPDATE ingested_accessions
           SET pinecone_write_class = ?, pinecone_vector_count = ?
           WHERE accession = ? AND doc_type = ?`
        )
        .run(writeClass, vectorCount, accession, docType);
    } catch {
      // Columns land in migration 84; older test DBs that skipped versioned migrate stay compatible.
    }
  }

  // Preserve the original SEC filed_at/accepted_at from the scraper (if the row already
  // exists) rather than overwriting every field via insertSecFiling, which sets both
  // to 'now' from this code path.  The clearCache admin route (§ reindex-10k/route.ts)
  // orders the latest-10-per-form query by sec_filings.filed_at to match the set that
  // refreshFilingBodies will refetch from SEC, so losing the real SEC dates would make
  // the cache-clearing query select the wrong accessions and leave cleared-but-not-rebuilt
  // filings permanently missing from the vector store.
  const existing = getSecFiling(accession);
  if (existing) {
    getDb().prepare(
      "UPDATE sec_filings SET status = 'complete', chunk_count = ?, updated_at = ? WHERE accession = ?"
    ).run(chunkCount, now, accession);
  } else {
    insertSecFiling({
      accession,
      cik: "",
      ticker,
      form: docType,
      filedAt: now,
      acceptedAt: now,
      status: "complete",
      chunkCount,
    });
  }
}

/** List all ingested accessions (admin/diagnostic). */
export function listIngestedAccessions(limit = 200): IngestedAccessionRow[] {
  const rows = getDb()
    .prepare("SELECT accession, doc_type, ticker, indexed_at, chunk_count FROM ingested_accessions ORDER BY indexed_at DESC LIMIT ?")
    .all(limit) as Array<{ accession: string; doc_type: string; ticker: string; indexed_at: string; chunk_count: number }>;
  return rows.map((r) => ({ accession: r.accession, docType: r.doc_type, ticker: r.ticker, indexedAt: r.indexed_at, chunkCount: r.chunk_count }));
}

/**
 * Count ever-ingested `ingested_accessions` rows per doc type (all tickers, all time), keyed by a
 * LOWERCASED doc type — cheap single GROUP BY, no new table/migration. Raw counts only; see
 * `ingestedAccessionCountForDocType` for the prefix-tolerant lookup callers should actually use.
 */
export function ingestedAccessionCountsByDocType(): Record<string, number> {
  const rows = getDb()
    .prepare("SELECT LOWER(doc_type) AS doc_type, COUNT(*) AS n FROM ingested_accessions GROUP BY LOWER(doc_type)")
    .all() as Array<{ doc_type: string; n: number }>;
  const counts: Record<string, number> = {};
  for (const row of rows) counts[row.doc_type] = row.n;
  return counts;
}

/**
 * Count ever-ingested rows for ONE requested doc type (all tickers, all time).
 *
 * `doc_type` casing/naming in `ingested_accessions` is NOT uniform across writers — see
 * src/lib/web-sources/sec-filings.ts (stores the raw SEC form letter, e.g. "10-K"/"10-Q") vs.
 * src/lib/web-sources/sec8k.ts's FULL-BODY writer (stores the sentinel "8-K-body", not "8-K").
 * The prefix-tolerant lookup below (any stored type whose lowercased form starts with the
 * requested lowercased type) reconciles that split — e.g. "8-k-body" counts toward requested
 * "8-k"; "10-k" counts toward requested "10-k" exactly (no other stored type shares that prefix).
 *
 * IMPORTANT CAVEAT (found 2026-07-06, see docs/rollouts/2026-07-06-corpus-coverage-receipt.md):
 * this table is NOT a complete producer-existence signal for "8-k". The default-ON 8-K SUMMARY
 * writer (`refreshEightK`'s `storeContexts` call in sec8k.ts) writes retrievable "8-k" chunks to
 * the vector corpus but never calls `insertIngestedAccession` at all — only the default-OFF
 * full-body writer (`ingestEightKBody`) does. So in the default config this function returns 0 for
 * "8-k" even when the corpus has real, retrievable 8-K chunks. That is exactly why
 * `COVERAGE_CHECKED_DOC_TYPES` in strategy.ts (the corpus-coverage receipt's allowlist) EXCLUDES
 * "8-k" — the receipt only both-conditions-checks doc types (currently 10-k/10-q) whose ledger IS
 * complete. strategy.ts builds its own in-memory prefix lookup on top of the bulk
 * `ingestedAccessionCountsByDocType()` (rather than calling this function once per type) and feeds
 * it into `computeEmptyDocTypes` (prompt-safety.ts) as a `hasProducerForDocType` predicate. This
 * function itself remains a correct, useful admin/diagnostic "how many accessions has this
 * pipeline recorded for doc type X" count — including for "8-k", where it still answers "how many
 * full-body accessions" correctly, just not "does 8-k coverage exist at all."
 */
export function ingestedAccessionCountForDocType(requestedDocType: string): number {
  const counts = ingestedAccessionCountsByDocType();
  const requested = requestedDocType.toLowerCase();
  let total = 0;
  for (const [storedType, n] of Object.entries(counts)) {
    if (storedType.startsWith(requested)) total += n;
  }
  return total;
}

// ── document_chunks content-hash dedup ─────────────────────────────────────

/** Check whether a chunk with this content_hash has already been embedded. */
export function hasDocumentChunk(contentHash: string): boolean {
  const row = getDb()
    .prepare("SELECT 1 FROM document_chunks WHERE content_hash = ?")
    .get(contentHash);
  return row != null;
}

/** Batch-check which content_hashes are new (not yet stored). Returns the set of NEW hashes. */
export function filterNewDocumentChunks(
  hashes: Array<{ content_hash: string; symbol: string; source: string; chunk_id: string }>
): typeof hashes {
  if (hashes.length === 0) return [];
  // Build placeholders for IN clause — SQLite max is 999, well above any chunk batch.
  const placeholders = hashes.map(() => "?").join(",");
  const flatHashes = hashes.map((h) => h.content_hash);
  const existing = new Set<string>();
  const rows = getDb()
    .prepare(`SELECT content_hash FROM document_chunks WHERE content_hash IN (${placeholders})`)
    .all(...flatHashes) as Array<{ content_hash: string }>;
  for (const row of rows) existing.add(row.content_hash);
  return hashes.filter((h) => !existing.has(h.content_hash));
}

/** Record successfully-embedded chunks so their content_hash is never re-embedded. */
export function insertDocumentChunks(
  chunks: Array<{ content_hash: string; symbol: string; source: string; chunk_id: string }>
): void {
  if (chunks.length === 0) return;
  const stmt = getDb().prepare(
    "INSERT OR IGNORE INTO document_chunks (content_hash, symbol, source, chunk_id, created_at) VALUES (?, ?, ?, ?, ?)"
  );
  const now = new Date().toISOString();
  const insertMany = getDb().transaction((rows: typeof chunks) => {
    for (const c of rows) stmt.run(c.content_hash, c.symbol, c.source, c.chunk_id, now);
  });
  insertMany(chunks);
}

/** Per-symbol chunk coverage stats (admin/diagnostic). */
export interface ChunkCoverageRow {
  symbol: string;
  chunkCount: number;
  latestAt: string;
}

export function getChunkCoverage(): ChunkCoverageRow[] {
  const rows = getDb()
    .prepare(`
      SELECT symbol, COUNT(*) as chunk_count, MAX(created_at) as latest_at
      FROM (
        SELECT symbol, content_hash, created_at FROM chunk_occurrences
        UNION ALL
        SELECT symbol, content_hash, created_at FROM document_chunks
        WHERE content_hash NOT IN (SELECT DISTINCT content_hash FROM chunk_occurrences)
      )
      GROUP BY symbol
      ORDER BY chunk_count DESC
    `)
    .all() as Array<{ symbol: string; chunk_count: number; latest_at: string }>;
  return rows.map((r) => ({ symbol: r.symbol, chunkCount: r.chunk_count, latestAt: r.latest_at }));
}

export interface ChunkSourceBreakdownRow {
  symbol: string;
  source: string;
  chunkCount: number;
}

export function getChunkSourceBreakdown(): ChunkSourceBreakdownRow[] {
  const rows = getDb()
    .prepare(`
      SELECT symbol, source, COUNT(*) as chunk_count
      FROM (
        SELECT symbol, source, content_hash FROM chunk_occurrences
        UNION ALL
        SELECT symbol, source, content_hash FROM document_chunks
        WHERE content_hash NOT IN (SELECT DISTINCT content_hash FROM chunk_occurrences)
      )
      WHERE source NOT LIKE '________-____-____-____-____________#c%'
      GROUP BY symbol, source
    `)
    .all() as Array<{ symbol: string; source: string; chunk_count: number }>;
  return rows.map((r) => ({ symbol: r.symbol, source: r.source, chunkCount: r.chunk_count }));
}

// ── learned_context_pending CRUD (risk-tier confirmation queue; userId-scoped) ──
// Every helper is ownership-scoped (WHERE user_id = ?). A queued row is a risk-tier candidate that is
// NOT in the brain — it only ever influences anything via the explicit human approve path, which
// applies it SAFELY (advisory promote / prompt append) and NEVER auto-mutates numeric policy.
interface RawLearnedContextPendingRow {
  id: string;
  user_id: string;
  scope: string;
  kind: string;
  subject: string;
  symbol: string | null;
  value: string;
  source: string;
  origin: string;
  risk_tier: string;
  connected_account_id: string | null;
  account_environment: string | null;
  learning_scope: string;
  transfer_state: string;
  classifier_reason: string | null;
  created_at: string;
  status: string;
  resolved_at: string | null;
  review_note: string | null;
}

function mapLearnedContextPending(row: RawLearnedContextPendingRow): LearnedContextPendingRow {
  return {
    id: row.id,
    userId: row.user_id,
    scope: row.scope as LearnedContextPendingRow["scope"],
    kind: row.kind as LearnedContextPendingRow["kind"],
    subject: row.subject,
    symbol: row.symbol,
    value: row.value,
    source: row.source,
    origin: row.origin as LearnedContextPendingRow["origin"],
    riskTier: row.risk_tier as LearnedContextPendingRow["riskTier"],
    connectedAccountId: row.connected_account_id,
    accountEnvironment: row.account_environment as LearnedContextPendingRow["accountEnvironment"],
    learningScope: row.learning_scope as LearnedContextPendingRow["learningScope"],
    transferState: row.transfer_state as LearnedContextPendingRow["transferState"],
    classifierReason: row.classifier_reason,
    createdAt: row.created_at,
    status: row.status as LearnedContextPendingRow["status"],
    resolvedAt: row.resolved_at,
    reviewNote: row.review_note
  };
}

export function insertPendingLearnedContext(row: LearnedContextPendingRow): LearnedContextPendingRow {
  getDb()
    .prepare(
      `INSERT INTO learned_context_pending
        (id, user_id, scope, kind, subject, symbol, value, source, origin, risk_tier,
         connected_account_id, account_environment, learning_scope, transfer_state,
         classifier_reason, created_at, status, resolved_at, review_note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      row.id,
      row.userId,
      row.scope,
      row.kind,
      row.subject,
      row.symbol,
      row.value,
      row.source,
      row.origin,
      row.riskTier,
      row.connectedAccountId,
      row.accountEnvironment,
      row.learningScope,
      row.transferState,
      row.classifierReason,
      row.createdAt,
      row.status,
      row.resolvedAt,
      row.reviewNote ?? null
    );
  return row;
}

export function listPendingLearnedContext(
  userId: string,
  status: LearnedContextPendingStatus = "pending"
): LearnedContextPendingRow[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM learned_context_pending
       WHERE user_id = ? AND status = ?
       ORDER BY created_at DESC`
    )
    .all(userId, status) as RawLearnedContextPendingRow[];
  return rows.map(mapLearnedContextPending);
}

export function getPendingLearnedContext(id: string, userId: string): LearnedContextPendingRow | null {
  const row = getDb()
    .prepare("SELECT * FROM learned_context_pending WHERE id = ? AND user_id = ?")
    .get(id, userId) as RawLearnedContextPendingRow | undefined;
  return row ? mapLearnedContextPending(row) : null;
}

/**
 * Ownership-scoped status transition. Returns true only when a row owned by `userId` was actually
 * updated (changes > 0) — so another user's row is a no-op false, and the API layer maps that to 404.
 */
export function setPendingLearnedContextStatus(
  id: string,
  userId: string,
  status: LearnedContextPendingStatus
): boolean {
  const resolvedAt = status === "pending" ? null : new Date().toISOString();
  const result = getDb()
    .prepare("UPDATE learned_context_pending SET status = ?, resolved_at = ? WHERE id = ? AND user_id = ?")
    .run(status, resolvedAt, id, userId);
  return result.changes > 0;
}

/**
 * Ownership-scoped write of the daily Learning Review's "defer" explanation. Deliberately does NOT
 * touch `status`/`resolved_at` — a defer verdict leaves the item exactly as pending (the human queue
 * is unchanged); this only attaches the reviewer's note so the queue UI can show it. Returns true
 * only when a row owned by `userId` was actually updated.
 */
export function setPendingLearnedContextReviewNote(id: string, userId: string, note: string): boolean {
  const result = getDb()
    .prepare("UPDATE learned_context_pending SET review_note = ? WHERE id = ? AND user_id = ?")
    .run(note, id, userId);
  return result.changes > 0;
}

// ── RAG Backfill P1 (Identity and Manifest) Types & CRUD ──

export interface SecFiling {
  accession: string;
  cik: string;
  ticker: string;
  form: string;
  filedAt: string;
  acceptedAt: string;
  reportPeriod?: string;
  fy?: string;
  fp?: string;
  amendmentParent?: string;
  supersededBy?: string;
  status: string;
  chunkCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface SecArtifact {
  accession: string;
  sequence: number;
  documentName: string;
  sha256: string;
  type: string;
  byteCount: number;
  rawUri: string;
  parserVersion: string;
  createdAt: string;
}

export interface ChunkOccurrence {
  vectorId: string;
  contentHash: string;
  symbol: string;
  source: string;
  accession: string;
  sequence?: number;
  documentName?: string;
  section: string;
  ordinal: number;
  acceptedAt: string;
  createdAt: string;
}

export function insertSecFiling(filing: Omit<SecFiling, "createdAt" | "updatedAt">): void {
  const now = new Date().toISOString();
  getDb()
    .prepare(`
      INSERT INTO sec_filings (
        accession, cik, ticker, form, filed_at, accepted_at, report_period, fy, fp,
        amendment_parent, superseded_by, status, chunk_count, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(accession) DO UPDATE SET
        cik = excluded.cik,
        ticker = excluded.ticker,
        form = excluded.form,
        filed_at = excluded.filed_at,
        accepted_at = excluded.accepted_at,
        report_period = excluded.report_period,
        fy = excluded.fy,
        fp = excluded.fp,
        amendment_parent = excluded.amendment_parent,
        superseded_by = excluded.superseded_by,
        status = excluded.status,
        chunk_count = excluded.chunk_count,
        updated_at = ?
    `)
    .run(
      filing.accession,
      filing.cik,
      filing.ticker,
      filing.form,
      filing.filedAt,
      filing.acceptedAt,
      filing.reportPeriod || null,
      filing.fy || null,
      filing.fp || null,
      filing.amendmentParent || null,
      filing.supersededBy || null,
      filing.status,
      filing.chunkCount,
      now,
      now,
      now
    );
}

export function getSecFiling(accession: string): SecFiling | null {
  const row = getDb()
    .prepare(`
      SELECT accession, cik, ticker, form, filed_at, accepted_at, report_period, fy, fp,
             amendment_parent, superseded_by, status, chunk_count, created_at, updated_at
      FROM sec_filings WHERE accession = ?
    `)
    .get(accession) as any;
  if (!row) return null;
  return {
    accession: row.accession,
    cik: row.cik,
    ticker: row.ticker,
    form: row.form,
    filedAt: row.filed_at,
    acceptedAt: row.accepted_at,
    reportPeriod: row.report_period || undefined,
    fy: row.fy || undefined,
    fp: row.fp || undefined,
    amendmentParent: row.amendment_parent || undefined,
    supersededBy: row.superseded_by || undefined,
    status: row.status,
    chunkCount: row.chunk_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function updateSecFilingStatus(accession: string, status: string, chunkCount?: number): void {
  const now = new Date().toISOString();
  if (chunkCount !== undefined) {
    getDb()
      .prepare("UPDATE sec_filings SET status = ?, chunk_count = ?, updated_at = ? WHERE accession = ?")
      .run(status, chunkCount, now, accession);
  } else {
    getDb()
      .prepare("UPDATE sec_filings SET status = ?, updated_at = ? WHERE accession = ?")
      .run(status, now, accession);
  }
}

export function insertSecArtifact(artifact: Omit<SecArtifact, "createdAt">): void {
  const now = new Date().toISOString();
  getDb()
    .prepare(`
      INSERT INTO sec_artifacts (
        accession, sequence, document_name, sha256, type, byte_count, raw_uri, parser_version, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(accession, sequence, document_name) DO UPDATE SET
        sha256 = excluded.sha256,
        type = excluded.type,
        byte_count = excluded.byte_count,
        raw_uri = excluded.raw_uri,
        parser_version = excluded.parser_version
    `)
    .run(
      artifact.accession,
      artifact.sequence,
      artifact.documentName,
      artifact.sha256,
      artifact.type,
      artifact.byteCount,
      artifact.rawUri,
      artifact.parserVersion,
      now
    );
}

export function listSecArtifacts(accession: string): SecArtifact[] {
  const rows = getDb()
    .prepare(`
      SELECT accession, sequence, document_name, sha256, type, byte_count, raw_uri, parser_version, created_at
      FROM sec_artifacts WHERE accession = ? ORDER BY sequence ASC
    `)
    .all(accession) as any[];
  return rows.map((r) => ({
    accession: r.accession,
    sequence: r.sequence,
    documentName: r.document_name,
    sha256: r.sha256,
    type: r.type,
    byteCount: r.byte_count,
    rawUri: r.raw_uri,
    parserVersion: r.parser_version,
    createdAt: r.created_at,
  }));
}

export function insertChunkOccurrences(occurrences: ChunkOccurrence[]): void {
  if (occurrences.length === 0) return;
  const stmt = getDb().prepare(`
    INSERT OR IGNORE INTO chunk_occurrences (
      vector_id, content_hash, symbol, source, accession, sequence, document_name, section, ordinal, accepted_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertMany = getDb().transaction((rows: ChunkOccurrence[]) => {
    for (const o of rows) {
      stmt.run(
        o.vectorId,
        o.contentHash,
        o.symbol,
        o.source,
        o.accession,
        o.sequence ?? null,
        o.documentName ?? null,
        o.section,
        o.ordinal,
        o.acceptedAt,
        o.createdAt
      );
    }
  });
  insertMany(occurrences);
}

type FtsOccurrenceIdentity = {
  content_hash: string;
  symbol: string;
  source: string;
  accession: string;
};

function lookupDocumentChunkFtsRowid(
  contentHash: string,
  symbol: string,
  source: string,
  accession: string
): number | null {
  const row = getDb()
    .prepare(
      `SELECT fts_rowid FROM document_chunks_fts_index
       WHERE content_hash = ? AND symbol = ? AND source = ? AND accession = ?`
    )
    .get(contentHash, symbol, source, accession) as { fts_rowid: number } | undefined;
  return row?.fts_rowid ?? null;
}

/**
 * FTS5 reuses the current max rowid after a DELETE. A bulk wipe of
 * `document_chunks_fts` that leaves `document_chunks_fts_index` behind can
 * therefore point at a later filing's chunk. Only delete when the live row
 * still matches this occurrence.
 */
function ftsRowidStillOwnsOccurrence(
  rowid: number,
  contentHash: string,
  symbol: string,
  source: string,
  accession: string
): boolean {
  const live = getDb()
    .prepare(
      `SELECT content_hash, symbol, source, accession
       FROM document_chunks_fts
       WHERE rowid = ?`
    )
    .get(rowid) as FtsOccurrenceIdentity | undefined;
  return (
    live != null &&
    live.content_hash === contentHash &&
    live.symbol === symbol &&
    live.source === source &&
    live.accession === accession
  );
}

function upsertDocumentChunkFtsIndex(
  contentHash: string,
  symbol: string,
  source: string,
  accession: string,
  ftsRowid: number
): void {
  getDb()
    .prepare(
      `INSERT INTO document_chunks_fts_index
         (content_hash, symbol, source, accession, fts_rowid)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(content_hash, symbol, source, accession)
       DO UPDATE SET fts_rowid = excluded.fts_rowid`
    )
    .run(contentHash, symbol, source, accession, ftsRowid);
}

function replaceDocumentChunkFtsOccurrence(
  delByRowid: { run: (rowid: number) => unknown },
  ins: {
    run: (
      contentHash: string,
      symbol: string,
      source: string,
      accession: string,
      text: string
    ) => { lastInsertRowid: number | bigint };
  },
  contentHash: string,
  symbol: string,
  source: string,
  accession: string,
  text: string
): void {
  const existingRowid = lookupDocumentChunkFtsRowid(contentHash, symbol, source, accession);
  if (existingRowid != null && ftsRowidStillOwnsOccurrence(existingRowid, contentHash, symbol, source, accession)) {
    delByRowid.run(existingRowid);
  }
  const info = ins.run(contentHash, symbol, source, accession, text);
  upsertDocumentChunkFtsIndex(contentHash, symbol, source, accession, Number(info.lastInsertRowid));
}

/** Drop FTS rows and their index keys together. A leftover index rowid can be reused. */
export function deleteDocumentChunkFtsBySourceAccession(source: string, accession: string): void {
  const db = getDb();
  const dropBoth = db.transaction(() => {
    const rowids = db
      .prepare("SELECT fts_rowid FROM document_chunks_fts_index WHERE source = ? AND accession = ?")
      .all(source, accession) as { fts_rowid: number }[];
    const delFts = db.prepare("DELETE FROM document_chunks_fts WHERE rowid = ?");
    for (const { fts_rowid } of rowids) {
      delFts.run(fts_rowid);
    }
    db.prepare("DELETE FROM document_chunks_fts_index WHERE source = ? AND accession = ?").run(source, accession);
  });
  dropBoth();
}

export function insertDocumentChunkFts(
  contentHash: string,
  symbol: string,
  source: string,
  accession: string,
  text: string
): void {
  const db = getDb();
  // FTS5 is a virtual table — INSERT OR REPLACE does not deduplicate on content_hash.
  // Idempotency uses document_chunks_fts_index (PK on occurrence identity) so DELETE is
  // by fts rowid (O(1)) instead of a full-corpus scan on non-indexed FTS5 columns.
  const delByRowid = db.prepare(`DELETE FROM document_chunks_fts WHERE rowid = ?`);
  const ins = db.prepare(`
    INSERT INTO document_chunks_fts (content_hash, symbol, source, accession, text)
    VALUES (?, ?, ?, ?, ?)
  `);
  replaceDocumentChunkFtsOccurrence(
    delByRowid,
    ins,
    contentHash,
    symbol,
    source,
    accession,
    text
  );
}

/**
 * Batched form of `insertDocumentChunkFts`: groups of `INSERT_DOCUMENT_CHUNK_FTS_BATCH_SIZE`
 * chunks share one write transaction, with an event-loop yield between groups.
 *
 * History (2026-08-10 stall incident): the original per-chunk loop did one auto-commit
 * transaction per chunk — N sequential SQLite write-lock acquire/release cycles, each a chance
 * to contend with a concurrent litestream WAL checkpoint (`better-sqlite3` is synchronous, so a
 * lock wait there blocks the whole Node event loop, including the ingest worker's lease
 * heartbeat — surfacing as a lease-expiry "Failed to advance checkpoint" rather than an explicit
 * timeout). The FIRST fix wrapped the whole document in ONE transaction, which made it WORSE: a
 * 665-chunk filing held the event loop synchronously for 65,977ms with zero yield points inside
 * it — proven live in prod by the `[slow-sync] worker.ftsMirrorBatch` warning this function now
 * replaces. Small sub-batches with a yield between them bound any single synchronous stretch
 * while still cutting per-chunk transaction overhead by ~BATCH_SIZE.
 */
/** Fixed group sizes were still not enough (2026-08-13 recurrence): FTS5 tokenization cost is
 *  text-size-dependent, and a 702-chunk 10-K averaged ~165ms PER ROW — 40-row groups meant ~6.6s
 *  synchronous stretches back-to-back, 119s total with only ~18 yields ("ftsMirrorBatch took
 *  119287ms (yielded)"), which starved the HTTP server into edge 503s for hours. The group size
 *  is now ADAPTIVE against a wall-time budget per synchronous stretch: halve after a slow group,
 *  grow after fast ones, floor 1 / ceiling 40. Worst case one oversized row still pins for its
 *  own tokenization cost — unavoidable inside a synchronous FTS insert — but never a whole
 *  group of them. */
const FTS_BATCH_MAX_ROWS = 40;
const FTS_BATCH_MIN_ROWS = 1;
/** First group is one row so a slow 10-K tokenisation cannot pin 8 rows (6–12s) before a yield. */
const FTS_BATCH_START_ROWS = 1;
/** Keep in lockstep with `FTS_MIRROR_SYNC_STRETCH_BUDGET_MS` in fts-mirror-bound.ts. */
export const FTS_BATCH_STRETCH_BUDGET_MS = 250;

/** Pure sizing policy for the adaptive FTS mirror batches — exported for deterministic tests.
 *  Over budget halves (floor 1); under half the budget doubles (ceiling 40); in between holds. */
export function nextFtsBatchGroupSize(current: number, elapsedMs: number): number {
  if (elapsedMs > FTS_BATCH_STRETCH_BUDGET_MS) {
    return Math.max(FTS_BATCH_MIN_ROWS, Math.floor(current / 2));
  }
  if (elapsedMs < FTS_BATCH_STRETCH_BUDGET_MS / 2) {
    return Math.min(FTS_BATCH_MAX_ROWS, current * 2);
  }
  return current;
}

export async function insertDocumentChunkFtsBatch(
  rows: Array<{ contentHash: string; symbol: string; source: string; accession: string; text: string }>
): Promise<void> {
  if (rows.length === 0) return;
  const db = getDb();
  const delByRowid = db.prepare(`DELETE FROM document_chunks_fts WHERE rowid = ?`);
  const ins = db.prepare(`
    INSERT INTO document_chunks_fts (content_hash, symbol, source, accession, text)
    VALUES (?, ?, ?, ?, ?)
  `);
  const runGroup = db.transaction((group: typeof rows) => {
    for (const row of group) {
      replaceDocumentChunkFtsOccurrence(
        delByRowid,
        ins,
        row.contentHash,
        row.symbol,
        row.source,
        row.accession,
        row.text
      );
    }
  });
  let groupSize = FTS_BATCH_START_ROWS;
  let i = 0;
  while (i < rows.length) {
    const group = rows.slice(i, i + groupSize);
    const startedAt = Date.now();
    runGroup(group);
    const elapsed = Date.now() - startedAt;
    i += group.length;
    groupSize = nextFtsBatchGroupSize(groupSize, elapsed);
    if (i < rows.length) {
      await yieldEventLoop();
    }
  }
}

/** Durable resume cursor: how many FTS rows this occurrence already wrote. */
export function countDocumentChunkFts(input: {
  symbol: string;
  source: string;
  accession: string;
}): number {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM document_chunks_fts_index
       WHERE symbol = ? AND source = ? AND accession = ?`
    )
    .get(input.symbol, input.source, input.accession) as { n: number };
  return Number(row?.n ?? 0);
}

/**
 * Content-derived resume offset for the bounded FTS mirror.
 *
 * 2026-09-09 stall incident.  The mirror used to resume from `countDocumentChunkFts()` — a
 * COUNT of `document_chunks_fts_index` rows — and used that count as a POSITIONAL offset into
 * the chunk array.  Those two numbers are only equal when every chunk of a document has a
 * DISTINCT `content_hash`.  The index PK is `(content_hash, symbol, source, accession)`, so two
 * byte-identical chunks inside one filing (repeated table headers, boilerplate, empty sections)
 * collapse onto ONE index row.  From the first duplicate onward the count is permanently less
 * than the position, the offset can never advance past it, and the same slice is re-mirrored on
 * every ingest tick FOREVER — each pass pinning the synchronous event loop.
 *
 * Measured in production 2026-09-09: `hsy-20260329.htm` restarted at offset 400/508 on all 29
 * logged slices across six days (one pinned the loop 36,511ms), `hsy-20251231.htm` at 732/1291,
 * `abnb-20260630.htm` at 355/448, `dash-20250630.htm` at 358 across 58 slices.  Because
 * `mirror.complete` never became true, `insertIngestedAccession` never ran, so the worker kept
 * re-queuing the same filings.  09-08 alone spent 1,317,546ms — 22 minutes — pinned in 198
 * slices, which is what starved `/api/live` past the 5s Docker healthcheck timeout.
 *
 * Resuming on CONTENT instead of a count fixes it and makes progress provably monotonic: the
 * offset is the first row whose hash is not yet indexed, and mirroring that row indexes its
 * hash, so the next resume is strictly greater.  The loop therefore always terminates.
 *
 * A side-index key alone is NOT proof the content is mirrored.  `document_chunks_fts_index` can
 * hold a STALE key — an explicitly supported state, which is the whole reason
 * `ftsRowidStillOwnsOccurrence` exists: FTS5 reuses the current max rowid after a DELETE, so a
 * bulk wipe of `document_chunks_fts` that leaves the side index behind can point at a later
 * filing's chunk.  Trusting a stale key here would skip a chunk whose text is genuinely absent
 * from FTS and still report `complete`, letting the caller ledger the accession with missing
 * content — the SAME failure class this function was written to remove.  So the resume set is
 * built by JOINING each side-index row to its live FTS row and keeping only the hashes whose
 * `fts_rowid` still owns all four identity columns.  A stale key contributes nothing, the
 * affected chunk is re-mirrored, and `replaceDocumentChunkFtsOccurrence` repairs the key.
 */
export function ftsMirrorResumeOffset(
  rows: ReadonlyArray<{ contentHash: string }>,
  key: { symbol: string; source: string; accession: string }
): number {
  if (rows.length === 0) return 0;
  const indexedRows = getDb()
    .prepare(
      `SELECT idx.content_hash AS content_hash
         FROM document_chunks_fts_index AS idx
         JOIN document_chunks_fts AS fts ON fts.rowid = idx.fts_rowid
        WHERE idx.symbol = ? AND idx.source = ? AND idx.accession = ?
          AND fts.content_hash = idx.content_hash
          AND fts.symbol = idx.symbol
          AND fts.source = idx.source
          AND fts.accession = idx.accession`
    )
    .all(key.symbol, key.source, key.accession) as Array<{ content_hash: string }>;
  if (indexedRows.length === 0) return 0;
  const indexed = new Set(indexedRows.map((r) => r.content_hash));
  let offset = 0;
  while (offset < rows.length && indexed.has(rows[offset]!.contentHash)) offset++;
  return offset;
}
