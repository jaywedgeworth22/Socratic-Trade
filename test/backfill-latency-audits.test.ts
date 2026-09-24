import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { backfillLatencyAudits } from "../scripts/ops/backfill-pruned-latency-audits";

describe("backfillLatencyAudits", () => {
  let sourcePath: string;
  let targetPath: string;

  beforeEach(() => {
    sourcePath = join(tmpdir(), `test-source-${randomUUID()}.db`);
    targetPath = join(tmpdir(), `test-target-${randomUUID()}.db`);

    // Setup source db
    const sourceDb = new Database(sourcePath);
    sourceDb.exec(`
      CREATE TABLE audit_events (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        connected_account_id TEXT,
        created_at TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL
      );
    `);
    // Insert some records: 2 latency, 1 other
    sourceDb
      .prepare(
        "INSERT INTO audit_events (id, user_id, connected_account_id, created_at, kind, payload) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .run("lat-1", "user-1", null, "2026-05-01T00:00:00Z", "llm_call_latency", '{"durationMs": 1200}');
    sourceDb
      .prepare(
        "INSERT INTO audit_events (id, user_id, connected_account_id, created_at, kind, payload) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .run("lat-2", "user-1", null, "2026-05-02T00:00:00Z", "llm_call_latency", '{"durationMs": 1500}');
    sourceDb
      .prepare(
        "INSERT INTO audit_events (id, user_id, connected_account_id, created_at, kind, payload) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .run("other-1", "user-1", null, "2026-05-01T00:00:00Z", "order_placed", '{"symbol": "AAPL"}');
    sourceDb.close();

    // Setup target db
    const targetDb = new Database(targetPath);
    targetDb.exec(`
      CREATE TABLE audit_events (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        connected_account_id TEXT,
        created_at TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL
      );
    `);
    // Seed lat-1 already in target
    targetDb
      .prepare(
        "INSERT INTO audit_events (id, user_id, connected_account_id, created_at, kind, payload) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .run("lat-1", "user-1", null, "2026-05-01T00:00:00Z", "llm_call_latency", '{"durationMs": 1200}');
    targetDb.close();
  });

  afterEach(() => {
    try {
      if (fs.existsSync(sourcePath)) fs.unlinkSync(sourcePath);
    } catch {}
    try {
      if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath);
    } catch {}
  });

  it("handles dry-run without writing to target", () => {
    const result = backfillLatencyAudits({ sourcePath, targetPath, dryRun: true });
    expect(result.found).toBe(2);

    const targetDb = new Database(targetPath, { readonly: true });
    const count = targetDb.prepare("SELECT count(*) as c FROM audit_events").get() as { c: number };
    targetDb.close();
    expect(count.c).toBe(1);
  });

  it("idempotently inserts missing latency audits and skips existing rows", () => {
    const result = backfillLatencyAudits({ sourcePath, targetPath, dryRun: false });
    expect(result.found).toBe(2);
    expect(result.inserted).toBe(1); // lat-2 inserted
    expect(result.skipped).toBe(1); // lat-1 already existed

    const targetDb = new Database(targetPath, { readonly: true });
    const rows = targetDb.prepare("SELECT id FROM audit_events ORDER BY id").all() as Array<{ id: string }>;
    targetDb.close();
    expect(rows.map((r) => r.id)).toEqual(["lat-1", "lat-2"]);
  });
});
