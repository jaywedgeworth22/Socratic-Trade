#!/usr/bin/env tsx
/**
 * Backfill pruned llm_call_latency audit events from a backup or cold-snapshot SQLite database.
 *
 * Background:
 * Prior to exempting "llm_call_latency" in AUDIT_PRUNE_NEVER_PRUNED_KINDS, audit pruning
 * purged latency rows older than 90 days during the daily scheduled audit prune pass.
 * This tool restores those records idempotently by reading `llm_call_latency` audit events
 * from an uncompressed historical database snapshot and inserting them with INSERT OR IGNORE
 * into the target database.
 *
 * Usage:
 *   npx tsx scripts/ops/backfill-pruned-latency-audits.ts --source /path/to/backup.db [--target data/app.db]
 *   npx tsx scripts/ops/backfill-pruned-latency-audits.ts --dry-run --source /path/to/backup.db
 */

import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

function parseArgs() {
  const args = process.argv.slice(2);
  let source = "";
  let target = process.env.DB_PATH || path.join(process.cwd(), "data", "app.db");
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--source" && i + 1 < args.length) {
      source = args[++i];
    } else if (args[i] === "--target" && i + 1 < args.length) {
      target = args[++i];
    } else if (args[i] === "--dry-run") {
      dryRun = true;
    }
  }

  return { source, target, dryRun };
}

export function backfillLatencyAudits(options: { sourcePath: string; targetPath: string; dryRun?: boolean }) {
  const { sourcePath, targetPath, dryRun = false } = options;

  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Source database does not exist at: ${sourcePath}`);
  }
  if (!fs.existsSync(targetPath)) {
    throw new Error(`Target database does not exist at: ${targetPath}`);
  }

  const sourceDb = new Database(sourcePath, { readonly: true });
  const targetDb = new Database(targetPath, { readonly: dryRun });

  try {
    // Check if source has audit_events table
    const tableCheck = sourceDb
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='audit_events'")
      .get();
    if (!tableCheck) {
      throw new Error(`Source database does not contain an audit_events table: ${sourcePath}`);
    }

    const rows = sourceDb
      .prepare(
        "SELECT id, user_id, connected_account_id, created_at, kind, payload FROM audit_events WHERE kind = 'llm_call_latency' ORDER BY created_at ASC"
      )
      .all() as Array<{
        id: string;
        user_id: string;
        connected_account_id: string | null;
        created_at: string;
        kind: string;
        payload: string;
      }>;

    console.log(`Found ${rows.length} llm_call_latency records in source database.`);

    if (rows.length === 0) {
      return { found: 0, inserted: 0, skipped: 0 };
    }

    if (dryRun) {
      console.log(`[DRY RUN] Would attempt to insert ${rows.length} records into ${targetPath}.`);
      return { found: rows.length, inserted: 0, skipped: 0 };
    }

    const insertStmt = targetDb.prepare(
      "INSERT OR IGNORE INTO audit_events (id, user_id, connected_account_id, created_at, kind, payload) VALUES (?, ?, ?, ?, ?, ?)"
    );

    let inserted = 0;
    const insertTx = targetDb.transaction((records: typeof rows) => {
      for (const row of records) {
        const info = insertStmt.run(
          row.id,
          row.user_id,
          row.connected_account_id,
          row.created_at,
          row.kind,
          row.payload
        );
        if (info.changes > 0) {
          inserted++;
        }
      }
    });

    insertTx(rows);
    const skipped = rows.length - inserted;

    console.log(`Backfill complete: ${inserted} inserted, ${skipped} already existed in target.`);
    return { found: rows.length, inserted, skipped };
  } finally {
    sourceDb.close();
    targetDb.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { source, target, dryRun } = parseArgs();
  if (!source) {
    console.error("Error: --source <path-to-backup.db> is required.");
    console.error("Usage: npx tsx scripts/ops/backfill-pruned-latency-audits.ts --source /path/to/backup.db [--target data/app.db] [--dry-run]");
    process.exit(1);
  }

  try {
    backfillLatencyAudits({ sourcePath: source, targetPath: target, dryRun });
  } catch (err) {
    console.error("Backfill failed:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
