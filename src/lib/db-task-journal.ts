// db-task-journal.ts — the "task brain" cron journal: one unified ledger recording every
// scheduled/background lane fire (scheduler lanes, maintenance passes, per-account tasks).
//
// Pattern references: OpenClaw's "Task Brain" (2026.3 unified SQLite task ledger) and
// Hivekeep's cron journal (`get_cron_journal`). Before this table, scheduled-work state was
// spread across internal_settings markers, strategy_runs, due_jobs, and audit_events — there
// was no single place to answer "what did the scheduler do, lane by lane, in the last hour".
//
// Hard rule: journaling is OBSERVABILITY, never on the money path. Every writer in this
// module is wrapped so a journal failure (locked DB mid-deploy, write-fence abort during
// account deletion, schema not yet migrated) can never break the lane being journaled.
import "server-only";
import crypto from "crypto";
import { getDb } from "./db";

export type TaskJournalStatus = "running" | "ok" | "error" | "skipped";

export interface TaskJournalEntry {
  id: string;
  taskName: string;
  status: TaskJournalStatus;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  userId?: string;
  connectedAccountId?: string;
  summary?: string;
  error?: string;
  metadata?: Record<string, unknown>;
}

type RawRow = {
  id: string;
  task_name: string;
  status: TaskJournalStatus;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  user_id: string | null;
  connected_account_id: string | null;
  summary: string | null;
  error: string | null;
  metadata: string | null;
};

function rowToEntry(row: RawRow): TaskJournalEntry {
  let metadata: Record<string, unknown> | undefined;
  if (row.metadata) {
    try {
      metadata = JSON.parse(row.metadata) as Record<string, unknown>;
    } catch {
      metadata = undefined;
    }
  }
  return {
    id: row.id,
    taskName: row.task_name,
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? undefined,
    durationMs: row.duration_ms ?? undefined,
    userId: row.user_id ?? undefined,
    connectedAccountId: row.connected_account_id ?? undefined,
    summary: row.summary ?? undefined,
    error: row.error ?? undefined,
    metadata
  };
}

const MAX_SUMMARY_CHARS = 500;
const MAX_ERROR_CHARS = 500;

function clamp(value: string | undefined, max: number): string | null {
  if (!value) return null;
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/**
 * Open a journal row for a lane fire. Returns the row id, or null when journaling itself
 * failed (callers must treat null as "journaling off" and still run their lane).
 */
export function recordTaskStart(input: {
  taskName: string;
  userId?: string;
  connectedAccountId?: string;
  metadata?: Record<string, unknown>;
  now?: string;
}): string | null {
  try {
    const id = crypto.randomUUID();
    getDb()
      .prepare(
        `INSERT INTO task_journal (
          id, task_name, status, started_at, user_id, connected_account_id, metadata
        ) VALUES (?, ?, 'running', ?, ?, ?, ?)`
      )
      .run(
        id,
        input.taskName,
        input.now ?? new Date().toISOString(),
        input.userId ?? null,
        input.connectedAccountId ?? null,
        input.metadata ? JSON.stringify(input.metadata) : null
      );
    return id;
  } catch {
    return null;
  }
}

/**
 * Close a journal row. duration_ms is derived from started_at so callers can't misreport it.
 * No-op when id is null (journaling was off at start) or the row no longer exists.
 */
export function recordTaskEnd(
  id: string | null,
  outcome: { status: Exclude<TaskJournalStatus, "running">; summary?: string; error?: string },
  now: Date = new Date()
): void {
  if (!id) return;
  try {
    const finishedAt = now.toISOString();
    const row = getDb().prepare("SELECT started_at FROM task_journal WHERE id = ?").get(id) as
      | { started_at: string }
      | undefined;
    if (!row) return;
    const startedMs = Date.parse(row.started_at);
    const durationMs = Number.isFinite(startedMs) ? Math.max(0, now.getTime() - startedMs) : null;
    getDb()
      .prepare(
        `UPDATE task_journal
         SET status = ?, finished_at = ?, duration_ms = ?, summary = ?, error = ?
         WHERE id = ? AND status = 'running'`
      )
      .run(
        outcome.status,
        finishedAt,
        durationMs,
        clamp(outcome.summary, MAX_SUMMARY_CHARS),
        clamp(outcome.error, MAX_ERROR_CHARS),
        id
      );
  } catch {
    // never throw — see module header
  }
}

export interface TaskJournalQuery {
  taskName?: string;
  userId?: string;
  connectedAccountId?: string;
  status?: TaskJournalStatus;
  since?: string;
  limit?: number;
}

/** Recent journal rows, newest first. Read path may throw normally (callers are queries). */
export function listTaskJournal(query: TaskJournalQuery = {}): TaskJournalEntry[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (query.taskName) {
    clauses.push("task_name = ?");
    params.push(query.taskName);
  }
  if (query.userId) {
    clauses.push("user_id = ?");
    params.push(query.userId);
  }
  if (query.connectedAccountId) {
    clauses.push("connected_account_id = ?");
    params.push(query.connectedAccountId);
  }
  if (query.status) {
    clauses.push("status = ?");
    params.push(query.status);
  }
  if (query.since) {
    clauses.push("started_at >= ?");
    params.push(query.since);
  }
  const limit = Math.max(1, Math.min(500, Math.floor(query.limit ?? 100)));
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = getDb()
    .prepare(`SELECT * FROM task_journal ${where} ORDER BY started_at DESC LIMIT ?`)
    .all(...params, limit) as RawRow[];
  return rows.map(rowToEntry);
}

export interface TaskJournalLaneSummary {
  taskName: string;
  fires: number;
  errors: number;
  skipped: number;
  lastStatus: TaskJournalStatus | null;
  lastStartedAt: string | null;
  avgDurationMs: number | null;
  maxDurationMs: number | null;
}

/** Per-lane aggregate over a lookback window — the ops-snapshot "task brain" view. */
export function getTaskJournalSummary(sinceIso: string): TaskJournalLaneSummary[] {
  try {
    const rows = getDb()
      .prepare(
        `SELECT
           task_name AS taskName,
           COUNT(*) AS fires,
           SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors,
           SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) AS skipped,
           AVG(duration_ms) AS avgDurationMs,
           MAX(duration_ms) AS maxDurationMs,
           MAX(started_at) AS lastStartedAt
         FROM task_journal
         WHERE started_at >= ?
         GROUP BY task_name
         ORDER BY lastStartedAt DESC`
      )
      .all(sinceIso) as Array<{
      taskName: string;
      fires: number;
      errors: number;
      skipped: number;
      avgDurationMs: number | null;
      maxDurationMs: number | null;
      lastStartedAt: string | null;
    }>;
    return rows.map((row) => {
      const last = getDb()
        .prepare(
          "SELECT status FROM task_journal WHERE task_name = ? AND started_at = ? ORDER BY rowid DESC LIMIT 1"
        )
        .get(row.taskName, row.lastStartedAt) as { status: TaskJournalStatus } | undefined;
      return {
        taskName: row.taskName,
        fires: row.fires,
        errors: row.errors,
        skipped: row.skipped,
        lastStatus: last?.status ?? null,
        lastStartedAt: row.lastStartedAt,
        avgDurationMs: row.avgDurationMs === null ? null : Math.round(row.avgDurationMs),
        maxDurationMs: row.maxDurationMs
      };
    });
  } catch {
    return [];
  }
}

// 'skipped' rows are heartbeats that found nothing to do (HEARTBEAT_OK in OpenClaw terms) —
// high-volume and low-value, so they age out fast. ok/error rows are the actual history.
export const TASK_JOURNAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
export const TASK_JOURNAL_SKIPPED_RETENTION_MS = 24 * 60 * 60 * 1_000;
/** Cap one tick's DELETE so retention cannot hold the write lock across the whole table. */
export const TASK_JOURNAL_PRUNE_BATCH_LIMIT = 500;

/** Delete aged rows. Returns rows deleted. Never throws. Bounded per call — the scheduler
 *  drains a backlog across ticks rather than pinning the event loop on one unbounded DELETE. */
export function pruneTaskJournal(now: Date = new Date()): number {
  try {
    const okCutoff = new Date(now.getTime() - TASK_JOURNAL_RETENTION_MS).toISOString();
    const skippedCutoff = new Date(now.getTime() - TASK_JOURNAL_SKIPPED_RETENTION_MS).toISOString();
    const info = getDb()
      .prepare(
        `DELETE FROM task_journal WHERE id IN (
           SELECT id FROM task_journal
           WHERE (status = 'skipped' AND started_at < ?)
              OR (status != 'skipped' AND started_at < ?)
           LIMIT ${TASK_JOURNAL_PRUNE_BATCH_LIMIT}
         )`
      )
      .run(skippedCutoff, okCutoff);
    return info.changes;
  } catch {
    return 0;
  }
}
