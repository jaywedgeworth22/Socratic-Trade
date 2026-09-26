import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import RawDatabase from "better-sqlite3";
import { beforeAll, describe, expect, it } from "vitest";
import { estimateReviewNotional } from "../src/lib/alpaca";
import { DEFAULT_POLICY } from "../src/lib/defaults";
import { evaluateTradeProposal } from "../src/lib/policy";
import type { EquityPosition, Portfolio, TradeProposal, TradingPolicy } from "../src/lib/types";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-hardening-${randomUUID()}.db`)}`;
});

// ── Migration framework (PRAGMA user_version) ────────────────────────────────
describe("runMigrations — versioned schema migrations", () => {
  it("stamps the baseline, runs newer migrations once in order, and is idempotent", async () => {
    const { runMigrations } = await import("../src/lib/db");
    const db = new RawDatabase(":memory:");
    let v2 = 0;
    let v3 = 0;
    const migs = [
      { version: 3, name: "three", up: (d: RawDatabase.Database) => { d.exec("CREATE TABLE t3(x)"); v3++; } },
      { version: 2, name: "two", up: (d: RawDatabase.Database) => { d.exec("CREATE TABLE t2(x)"); v2++; } }
    ];

    expect(runMigrations(db, migs, 1)).toBe(3);
    expect([v2, v3]).toEqual([1, 1]);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name IN ('t2','t3')").all()).toHaveLength(2);
    expect(Number(db.pragma("user_version", { simple: true }))).toBe(3);

    // Re-run: nothing re-applies.
    expect(runMigrations(db, migs, 1)).toBe(3);
    expect([v2, v3]).toEqual([1, 1]);
    db.close();
  });

  it("applies only migrations newer than the current version", async () => {
    const { runMigrations } = await import("../src/lib/db");
    const db = new RawDatabase(":memory:");
    db.pragma("user_version = 2");
    let ran = 0;
    const migs = [
      { version: 2, name: "two", up: () => { ran++; } },
      { version: 4, name: "four", up: (d: RawDatabase.Database) => { d.exec("CREATE TABLE t4(x)"); ran++; } }
    ];
    expect(runMigrations(db, migs, 1)).toBe(4);
    expect(ran).toBe(1); // only v4 ran
    db.close();
  });

  it("safely handles tableExists and columnExists for missing and present tables/columns", async () => {
    const { tableExists, columnExists } = await import("../src/lib/db");
    const db = new RawDatabase(":memory:");

    expect(tableExists(db, "non_existent_table")).toBe(false);
    expect(columnExists(db, "non_existent_table", "col")).toBe(false);

    db.exec("CREATE TABLE test_table (id TEXT PRIMARY KEY, alpha INTEGER);");
    expect(tableExists(db, "test_table")).toBe(true);
    expect(columnExists(db, "test_table", "id")).toBe(true);
    expect(columnExists(db, "test_table", "alpha")).toBe(true);
    expect(columnExists(db, "test_table", "beta")).toBe(false);
    db.close();
  });

  it("applies all versioned migrations cleanly on a blank database without baseline tables", async () => {
    const { applyVersionedMigrations, getSchemaVersion, getDb } = await import("../src/lib/db");
    const blankDb = new RawDatabase(":memory:");
    expect(Number(blankDb.pragma("user_version", { simple: true }))).toBe(0);

    // Issue #2964: All migrations must execute without throwing "no such table" errors on an empty schema
    expect(() => applyVersionedMigrations(blankDb)).not.toThrow();
    expect(getSchemaVersion(blankDb)).toBe(getSchemaVersion(getDb()));
    blankDb.close();
  });

  it("recovers a legacy v49 database missing SEC insider transactions before v50 alters it", async () => {
    const { applyVersionedMigrations, getDb } = await import("../src/lib/db");
    const db = getDb();
    db.exec("DROP TABLE IF EXISTS sec_insider_transactions");
    db.pragma("user_version = 49");

    expect(() => applyVersionedMigrations(db)).not.toThrow();
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sec_insider_transactions'").get()).toBeTruthy();
  });

  it("purges legacy product Test Accounts through the concrete v25 migration", async () => {
    const {
      applyVersionedMigrations,
      getDb,
      getSchemaVersion,
      listConnectedAccounts,
      upsertConnectedAccount
    } = await import("../src/lib/db");
    const db = getDb();
    expect(getSchemaVersion(db)).toBe(93);

    upsertConnectedAccount({
      id: "legacy-product-test",
      userId: "local",
      broker: "test",
      environment: "paper",
      accountNumber: "TEST",
      label: "Test Account",
      isActive: true
    });

    // DELETE catches missing account/user columns as well as proving the account itself is removed.
    db.pragma("user_version = 24");
    expect(() => applyVersionedMigrations(db)).not.toThrow();
    expect(getSchemaVersion(db)).toBe(93);

    expect(listConnectedAccounts("local").some((account) => account.broker === "test")).toBe(false);
  });

  it("migrates only the legacy $500 daily default to 20% of NAV", async () => {
    const { applyVersionedMigrations, getDb, getSchemaVersion } = await import("../src/lib/db");
    const db = getDb();
    const now = new Date().toISOString();
    db.prepare(
      "INSERT OR REPLACE INTO user_settings (id, user_id, key, value, updated_at) VALUES (?, ?, 'policy', ?, ?)"
    ).run("cap-default", "cap-default-user", JSON.stringify({ maxDailyNotional: 500 }), now);
    db.prepare(
      "INSERT OR REPLACE INTO user_settings (id, user_id, key, value, updated_at) VALUES (?, ?, 'policy', ?, ?)"
    ).run("cap-explicit", "cap-explicit-user", JSON.stringify({ maxDailyNotional: 1_000 }), now);

    db.pragma("user_version = 25");
    applyVersionedMigrations(db);
    expect(getSchemaVersion(db)).toBe(93);


    const migrated = JSON.parse((db.prepare("SELECT value FROM user_settings WHERE id = ?").get("cap-default") as { value: string }).value);
    const preserved = JSON.parse((db.prepare("SELECT value FROM user_settings WHERE id = ?").get("cap-explicit") as { value: string }).value);
    expect(migrated).toMatchObject({ maxDailyPctOfNav: 20 });
    expect(migrated.maxDailyNotional).toBeUndefined();
    expect(preserved).toMatchObject({ maxDailyNotional: 1_000 });
    expect(preserved.maxDailyPctOfNav).toBeUndefined();
  });

  it("preserves pre-token committed vector rows for explicit backfill", async () => {
    const { applyVersionedMigrations, getDb, getSchemaVersion } = await import("../src/lib/db");
    const db = getDb();
    const at = "2026-07-14T12:00:00.000Z";
    const accession = "FMP-EARNINGS-TRANSCRIPT:AAPL:2026:Q1";
    const versionId = `${accession}:VERSION:legacy-upgrade`;
    const commitId = "vcommit:test:legacy-upgrade";
    db.prepare(`
      INSERT OR REPLACE INTO vector_ingest_commits (
        id, tenant_scope, user_id, source, accession, document_key, content_version,
        retrieval_metadata_version, parser_revision, embed_revision, expected_vectors,
        state, attempt_token, attempt_generation, lease_expires_at, created_at, updated_at, committed_at
      ) VALUES (?, 'shared:operator', 'local', 'fmp-earnings-transcript', ?, ?, 'content',
        'legacy', 'fmp-transcript-v1', 'v1', 1, 'committed', NULL, 0, NULL, ?, ?, ?)
    `).run(commitId, versionId, accession, at, at, at);
    db.prepare(`
      INSERT OR REPLACE INTO chunk_occurrences (
        vector_id, content_hash, symbol, source, accession, section, ordinal, accepted_at,
        tenant_scope, content_version, commit_id, receipt_state, created_at
      ) VALUES ('occ:test:legacy-upgrade', 'hash', 'AAPL', 'fmp-earnings-transcript', ?,
        'body', 1, ?, 'shared:operator', 'content', ?, 'committed', ?)
    `).run(versionId, at, commitId, at);
    db.prepare(`
      INSERT OR REPLACE INTO fmp_transcript_versions (
        version_id, accession, content_sha256, symbol, fiscal_year, fiscal_quarter,
        first_content_seen_at, state, vector_commit_id, chunk_count, observed_at, indexed_at, updated_at
      ) VALUES (?, ?, 'hash', 'AAPL', 2026, 1, ?, 'committed', ?, 1, ?, ?, ?)
    `).run(versionId, accession, at, commitId, at, at, at);
    db.prepare(`
      INSERT OR REPLACE INTO ingested_accessions (accession, doc_type, ticker, indexed_at, chunk_count)
      VALUES (?, 'earnings-transcript', 'AAPL', ?, 1)
    `).run(accession, at);

    db.pragma("user_version = 29");
    applyVersionedMigrations(db);

    expect(getSchemaVersion(db)).toBe(93);

    expect(db.prepare(`
      SELECT state, attempt_token, ledger_authority FROM vector_ingest_commits WHERE id = ?
    `).get(commitId)).toEqual({ state: "committed", attempt_token: null, ledger_authority: null });
    expect(db.prepare(`
      SELECT state, vector_commit_id FROM fmp_transcript_versions WHERE version_id = ?
    `).get(versionId)).toEqual({ state: "committed", vector_commit_id: commitId });
    expect(db.prepare(`
      SELECT receipt_state FROM chunk_occurrences WHERE vector_id = 'occ:test:legacy-upgrade'
    `).get()).toEqual({ receipt_state: "committed" });
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM ingested_accessions
      WHERE accession = ? AND doc_type = 'earnings-transcript'
    `).get(accession)).toEqual({ count: 1 });
  });

  it("preserves null or blank token lifecycle rows for explicit backfill", async () => {
    const { applyVersionedMigrations, getDb, getSchemaVersion } = await import("../src/lib/db");
    const db = getDb();
    const at = "2026-07-14T12:00:00.000Z";
    const commits = [
      { id: "vcommit:test:blank-receipts", state: "receipts_persisted", token: "  " },
      { id: "vcommit:test:null-committed", state: "committed", token: null },
      { id: "vcommit:test:null-pending", state: "pending", token: null }
    ] as const;
    for (const [index, commit] of commits.entries()) {
      db.prepare(`
        INSERT OR REPLACE INTO vector_ingest_commits (
          id, tenant_scope, user_id, source, accession, document_key, content_version,
          retrieval_metadata_version, parser_revision, embed_revision, expected_vectors,
          state, attempt_token, attempt_generation, lease_expires_at, created_at, updated_at, committed_at
        ) VALUES (?, 'shared:operator', 'local', 'fmp-earnings-transcript', ?, ?, 'content',
          'metadata', 'parser', 'embed', 1, ?, ?, 0, '2099-01-01T00:00:00.000Z', ?, ?, ?)
      `).run(commit.id, `VERSION:${commit.id}`, `document:${commit.id}`, commit.state, commit.token, at, at, at);
      db.prepare(`
        INSERT OR REPLACE INTO chunk_occurrences (
          vector_id, content_hash, symbol, source, accession, section, ordinal, accepted_at,
          tenant_scope, content_version, commit_id, receipt_state, created_at
        ) VALUES (?, 'hash', 'AAPL', 'fmp-earnings-transcript', ?, 'body', 1, ?,
          'shared:operator', 'content', ?, 'committed', ?)
      `).run(`occ:test:tokenless:${index}`, `VERSION:${commit.id}`, at, commit.id, at);
    }

    db.pragma("user_version = 31");
    applyVersionedMigrations(db);

    expect(getSchemaVersion(db)).toBe(93);

    expect(db.prepare(`
      SELECT id, state, attempt_token, lease_expires_at
      FROM vector_ingest_commits
      WHERE id IN (?, ?, ?) ORDER BY id
    `).all(...commits.map((commit) => commit.id))).toEqual([
      {
        id: "vcommit:test:blank-receipts",
        state: "receipts_persisted",
        attempt_token: "  ",
        lease_expires_at: "2099-01-01T00:00:00.000Z"
      },
      {
        id: "vcommit:test:null-committed",
        state: "committed",
        attempt_token: null,
        lease_expires_at: "2099-01-01T00:00:00.000Z"
      },
      {
        id: "vcommit:test:null-pending",
        state: "pending",
        attempt_token: null,
        lease_expires_at: "2099-01-01T00:00:00.000Z"
      }
    ]);
    expect(db.prepare(`
      SELECT receipt_state FROM chunk_occurrences
      WHERE commit_id IN (?, ?, ?) ORDER BY commit_id
    `).all(...commits.map((commit) => commit.id))).toEqual([
      { receipt_state: "committed" },
      { receipt_state: "committed" },
      { receipt_state: "committed" }
    ]);
  });

  it("rebuilds equal activation times by committed_at then commit_id", async () => {
    const { applyVersionedMigrations, getDb, getSchemaVersion } = await import("../src/lib/db");
    const db = getDb();
    const suffix = randomUUID();
    const tenantScope = "shared:operator";
    const source = `timeline-tie-${suffix}`;
    const documentKey = `document-${suffix}`;
    const validFrom = "2026-07-14T12:00:00.000Z";
    const commits = [
      { id: `vcommit:timeline:${suffix}:a`, committedAt: "2026-07-14T12:00:01.000Z" },
      { id: `vcommit:timeline:${suffix}:b`, committedAt: "2026-07-14T12:00:02.000Z" },
      { id: `vcommit:timeline:${suffix}:c`, committedAt: "2026-07-14T12:00:02.000Z" }
    ];
    for (const commit of commits) {
      db.prepare(`
        INSERT INTO vector_ingest_commits (
          id, tenant_scope, user_id, source, accession, document_key, content_version,
          retrieval_metadata_version, parser_revision, embed_revision, expected_vectors,
          state, attempt_token, attempt_generation, lease_expires_at, created_at, updated_at, committed_at
        ) VALUES (?, ?, 'local', ?, ?, ?, 'content', 'metadata', 'parser', 'embed', 0,
          'committed', ?, 1, NULL, ?, ?, ?)
      `).run(
        commit.id,
        tenantScope,
        source,
        `${documentKey}:${commit.id}`,
        documentKey,
        `attempt:${commit.id}`,
        commit.committedAt,
        commit.committedAt,
        commit.committedAt
      );
      db.prepare(`
        INSERT INTO vector_document_versions (
          commit_id, tenant_scope, source, document_key, valid_from, valid_to, updated_at
        ) VALUES (?, ?, ?, ?, ?, NULL, ?)
      `).run(commit.id, tenantScope, source, documentKey, validFrom, commit.committedAt);
    }

    db.pragma("user_version = 32");
    applyVersionedMigrations(db);

    expect(getSchemaVersion(db)).toBe(93);

    expect(db.prepare(`
      SELECT commit_id FROM vector_document_heads
      WHERE tenant_scope = ? AND source = ? AND accession = ?
    `).get(tenantScope, source, documentKey)).toEqual({ commit_id: commits[2].id });
    expect(db.prepare(`
      SELECT commit_id, valid_to FROM vector_document_versions
      WHERE commit_id IN (?, ?, ?) ORDER BY commit_id
    `).all(...commits.map((commit) => commit.id))).toEqual([
      { commit_id: commits[0].id, valid_to: validFrom },
      { commit_id: commits[1].id, valid_to: validFrom },
      { commit_id: commits[2].id, valid_to: null }
    ]);
  });

  it("backstops a legacy settings policy when versioned migrations run before the global copy", async () => {
    const { applyVersionedMigrations, migrateGlobalPolicyToLocalUser } = await import("../src/lib/db");
    const db = new RawDatabase(":memory:");
    db.exec(`
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE user_settings (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE account_strategy_state (policy TEXT NOT NULL);
      CREATE TABLE strategy_profiles (policy TEXT NOT NULL);
      CREATE TABLE socratic_decisions (id TEXT PRIMARY KEY);
      CREATE TABLE chunk_occurrences (vector_id TEXT PRIMARY KEY, accepted_at TEXT);
    `);
    const now = new Date().toISOString();
    db.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('policy', ?, ?)").run(
      JSON.stringify({ maxDailyNotional: 500 }),
      now
    );
    db.prepare("INSERT INTO user_settings (id, user_id, key, value, updated_at) VALUES (?, ?, 'policy', ?, ?)").run(
      "legacy-user-policy",
      "legacy-user",
      JSON.stringify({ maxDailyNotional: 500 }),
      now
    );
    db.prepare("INSERT INTO account_strategy_state (policy) VALUES (?)").run(JSON.stringify({ maxDailyNotional: 500 }));
    db.prepare("INSERT INTO strategy_profiles (policy) VALUES (?)").run(JSON.stringify({ maxDailyNotional: 500 }));
    db.pragma("user_version = 25");

    expect(applyVersionedMigrations(db)).toBe(93);


    for (const json of [
      (db.prepare("SELECT value AS json FROM settings WHERE key = 'policy'").get() as { json: string }).json,
      (db.prepare("SELECT value AS json FROM user_settings WHERE id = 'legacy-user-policy'").get() as { json: string }).json,
      (db.prepare("SELECT policy AS json FROM account_strategy_state").get() as { json: string }).json,
      (db.prepare("SELECT policy AS json FROM strategy_profiles").get() as { json: string }).json
    ]) {
      const migrated = JSON.parse(json);
      expect(migrated).toMatchObject({ maxDailyPctOfNav: 20 });
      expect(migrated.maxDailyNotional).toBeUndefined();
    }

    migrateGlobalPolicyToLocalUser(db, now);

    const legacy = JSON.parse((db.prepare("SELECT value FROM settings WHERE key = 'policy'").get() as { value: string }).value);
    const copied = JSON.parse((db.prepare("SELECT value FROM user_settings WHERE user_id = 'local' AND key = 'policy'").get() as { value: string }).value);
    expect(legacy).toMatchObject({ maxDailyPctOfNav: 20 });
    expect(legacy.maxDailyNotional).toBeUndefined();
    expect(copied).toEqual(legacy);
    db.close();
  });

  it("does not reinterpret an intentional fixed $500 cap after migration v26", async () => {
    const { applyVersionedMigrations } = await import("../src/lib/db");
    const db = new RawDatabase(":memory:");
    db.exec(`
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE user_settings (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE account_strategy_state (policy TEXT NOT NULL);
      CREATE TABLE strategy_profiles (policy TEXT NOT NULL);
      CREATE TABLE socratic_decisions (id TEXT PRIMARY KEY);
      CREATE TABLE chunk_occurrences (vector_id TEXT PRIMARY KEY, accepted_at TEXT);
    `);
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO user_settings (id, user_id, key, value, updated_at) VALUES (?, ?, 'policy', ?, ?)"
    ).run("cap-intentional-500", "cap-intentional-user", JSON.stringify({ maxDailyNotional: 500 }), now);
    db.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('policy', ?, ?)").run(JSON.stringify({ maxDailyNotional: 500 }), now);
    db.prepare("INSERT INTO account_strategy_state (policy) VALUES (?)").run(JSON.stringify({ maxDailyNotional: 500 }));
    db.prepare("INSERT INTO strategy_profiles (policy) VALUES (?)").run(JSON.stringify({ maxDailyNotional: 500 }));
    db.pragma("user_version = 26");

    expect(applyVersionedMigrations(db)).toBe(93);


    for (const json of [
      (db.prepare("SELECT value AS json FROM settings WHERE key = 'policy'").get() as { json: string }).json,
      (db.prepare("SELECT value AS json FROM user_settings WHERE id = 'cap-intentional-500'").get() as { json: string }).json,
      (db.prepare("SELECT policy AS json FROM account_strategy_state").get() as { json: string }).json,
      (db.prepare("SELECT policy AS json FROM strategy_profiles").get() as { json: string }).json
    ]) {
      const preserved = JSON.parse(json);
      expect(preserved).toMatchObject({ maxDailyNotional: 500 });
      expect(preserved.maxDailyPctOfNav).toBeUndefined();
    }
    expect(
      (db.prepare("PRAGMA table_info(socratic_decisions)").all() as Array<{ name: string }>).map((column) => column.name)
    ).toEqual(expect.arrayContaining(["green_team_rationale", "sizing_snapshot"]));
    db.close();
  });

  it("preserves an explicitly configured large dollar cap instead of treating it as a sentinel", async () => {
    const { mergePolicy } = await import("../src/lib/db-profiles");
    const merged = mergePolicy({ ...DEFAULT_POLICY, maxDailyNotional: 750_000, maxDailyPctOfNav: undefined });
    expect(merged.maxDailyNotional).toBe(750_000);
    expect(merged.maxDailyPctOfNav).toBeUndefined();
  });

  it("migrates active replacement uniqueness to user scope and collapses same-user duplicates", async () => {
    const { applyVersionedMigrations } = await import("../src/lib/db");
    const db = new RawDatabase(":memory:");
    db.exec(`
      CREATE TABLE order_replacements (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        account_number TEXT NOT NULL,
        original_order_id TEXT NOT NULL,
        status TEXT NOT NULL,
        replacement_order_id TEXT,
        error TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE chunk_occurrences (vector_id TEXT PRIMARY KEY, accepted_at TEXT);
      INSERT INTO order_replacements
        (id, user_id, account_number, original_order_id, status, updated_at)
      VALUES
        ('older', 'user-1', 'ACCOUNT', 'ORDER', 'cancel_requested', '2026-07-14T00:00:00.000Z'),
        ('newer', 'user-1', 'ACCOUNT', 'ORDER', 'replacement_submitted', '2026-07-14T00:01:00.000Z');
    `);
    db.pragma("user_version = 27");

    expect(applyVersionedMigrations(db)).toBe(93);

    expect(db.prepare(`
      SELECT status, COUNT(*) AS count
      FROM order_replacements
      WHERE user_id = 'user-1' AND account_number = 'ACCOUNT' AND original_order_id = 'ORDER'
      GROUP BY status
      ORDER BY status
    `).all()).toEqual([
      { status: "failed", count: 1 },
      { status: "replacement_submitted", count: 1 }
    ]);

    expect(() => db.prepare(`
      INSERT INTO order_replacements
        (id, user_id, account_number, original_order_id, status, updated_at)
      VALUES ('cross-user', 'user-2', 'ACCOUNT', 'ORDER', 'cancel_requested', '2026-07-14T00:02:00.000Z')
    `).run()).not.toThrow();
    expect(() => db.prepare(`
      INSERT INTO order_replacements
        (id, user_id, account_number, original_order_id, status, updated_at)
      VALUES ('same-user', 'user-1', 'ACCOUNT', 'ORDER', 'cancel_requested', '2026-07-14T00:03:00.000Z')
    `).run()).toThrow();
    db.close();
  });

  it("purges pre-user-scope broker-minimum cooldown rows at migration v40", async () => {
    const { applyVersionedMigrations } = await import("../src/lib/db");
    const db = new RawDatabase(":memory:");
    const now = new Date().toISOString();
    db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)");
    db.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)")
      .run("subMinimumOrderAlertSent:LEGACY-ACCOUNT:AAPL", JSON.stringify(now), now);
    db.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)")
      .run("unrelated:setting", JSON.stringify(now), now);
    db.pragma("user_version = 39");

    expect(applyVersionedMigrations(db)).toBe(93);

    // v40 purges legacy broker-minimum cooldown keys; later migrations (v58) may seed
    // unrelated settings such as earningscalls_burst_pending — assert the purge, not a frozen key set.
    const keys = (db.prepare("SELECT key FROM settings ORDER BY key").all() as Array<{ key: string }>).map((row) => row.key);
    expect(keys).not.toContain("subMinimumOrderAlertSent:LEGACY-ACCOUNT:AAPL");
    expect(keys).toContain("unrelated:setting");
    db.close();
  });

  it("backfills a legacy fixed/atr opening_order_id into position_stop_plan_open_brackets at migration v43 (Codex review, PR #1667)", async () => {
    const { applyVersionedMigrations } = await import("../src/lib/db");
    const db = new RawDatabase(":memory:");
    const now = new Date().toISOString();
    // Minimal position_stop_plans shape as it existed under the OLD (pre-v43) single-scalar design —
    // a row already sitting at "fixed" with a tracked opening_order_id, recorded before this table
    // existed to track it, must not lose that reference once v43 creates the new tracking table.
    db.exec(`
      CREATE TABLE position_stop_plans (
        user_id TEXT NOT NULL,
        account_number TEXT NOT NULL,
        symbol TEXT NOT NULL,
        style TEXT NOT NULL,
        rationale TEXT,
        avg_cost REAL NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        side TEXT NOT NULL DEFAULT 'long',
        opening_order_id TEXT,
        PRIMARY KEY (user_id, account_number, symbol)
      );
    `);
    db.prepare(
      `INSERT INTO position_stop_plans (user_id, account_number, symbol, style, rationale, avg_cost, updated_at, side, opening_order_id)
       VALUES ('local', 'LEGACY-ACCT', 'AAPL', 'fixed', 'pre-v43 row', 190, ?, 'long', 'legacy-bracket-order-1')`
    ).run(now);
    // A non-fixed/atr row, and a fixed row with NO tracked order id, must NOT be backfilled.
    db.prepare(
      `INSERT INTO position_stop_plans (user_id, account_number, symbol, style, rationale, avg_cost, updated_at, side, opening_order_id)
       VALUES ('local', 'LEGACY-ACCT', 'TSLA', 'trailing', NULL, 400, ?, 'long', NULL)`
    ).run(now);
    db.prepare(
      `INSERT INTO position_stop_plans (user_id, account_number, symbol, style, rationale, avg_cost, updated_at, side, opening_order_id)
       VALUES ('local', 'LEGACY-ACCT', 'MSFT', 'atr', NULL, 300, ?, 'long', NULL)`
    ).run(now);
    db.pragma("user_version = 45");

    expect(applyVersionedMigrations(db)).toBe(93);

    expect(
      db.prepare(
        "SELECT symbol, order_id FROM position_stop_plan_open_brackets WHERE user_id = 'local' AND account_number = 'LEGACY-ACCT'"
      ).all()
    ).toEqual([{ symbol: "AAPL", order_id: "legacy-bracket-order-1" }]);
    db.close();
  });

  it("creates socratic_coach_note_archive at migration v55 (fresh DB, legacy upgrade, and idempotent re-run)", async () => {
    const { applyVersionedMigrations, getDb, getSchemaVersion } = await import("../src/lib/db");

    // Fresh DB (the shared beforeAll DATABASE_URL) already migrated through v55 by getDb().
    const db = getDb();
    expect(getSchemaVersion(db)).toBeGreaterThanOrEqual(55);
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'socratic_coach_note_archive'").get()
    ).toBeTruthy();
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_socratic_coach_note_archive_user_decision'").get()
    ).toBeTruthy();

    // Legacy v52 on-disk DB gains the table when versioned migrations re-run.
    const legacy = new RawDatabase(":memory:");
    legacy.pragma("user_version = 52");
    expect(applyVersionedMigrations(legacy)).toBe(93);
    expect(
      legacy.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'socratic_coach_note_archive'").get()
    ).toBeTruthy();

    // Idempotent: a row survives a second run, and re-running does not error or duplicate the table.
    const now = new Date().toISOString();
    legacy.prepare(
      `INSERT INTO socratic_coach_note_archive (id, user_id, decision_id, connected_account_id, note, note_seq, archived_at)
       VALUES ('archive-1', 'local', 'decision-1', NULL, 'aged-off note', 0, ?)`
    ).run(now);
    expect(() => applyVersionedMigrations(legacy)).not.toThrow();
    expect(legacy.prepare("SELECT COUNT(*) AS count FROM socratic_coach_note_archive").get()).toEqual({ count: 1 });
    legacy.close();
  });
});

// ── ENCRYPTION_KEY fail-fast ─────────────────────────────────────────────────
describe("encryption-key boot guard", () => {
  it("detects ciphertext and fails fast only when the key is ephemeral and not under test", async () => {
    const { getDb, upsertConnectedAccount, hasEncryptedCredentials, assertEncryptionKeyAvailable } = await import("../src/lib/db");
    const db = getDb();

    expect(hasEncryptedCredentials(db)).toBe(false);
    expect(() => assertEncryptionKeyAvailable(db, { ephemeral: true, isTest: false })).not.toThrow();

    upsertConnectedAccount({
      id: randomUUID(),
      userId: "local",
      broker: "alpaca",
      environment: "paper",
      accountNumber: "PA-TEST",
      label: "Test",
      apiKey: "super-secret-key",
      isActive: true
    });
    expect(hasEncryptedCredentials(db)).toBe(true);

    expect(() => assertEncryptionKeyAvailable(db, { ephemeral: true, isTest: false })).toThrow(/ENCRYPTION_KEY is not set/);
    expect(() => assertEncryptionKeyAvailable(db, { ephemeral: false, isTest: false })).not.toThrow();
    expect(() => assertEncryptionKeyAvailable(db, { ephemeral: true, isTest: true })).not.toThrow();
  });
});

// ── Alpaca review notional (no fabricated $100) ──────────────────────────────
describe("estimateReviewNotional — never fabricates a price", () => {
  it("uses dollarAmount directly", () => {
    expect(estimateReviewNotional({ dollarAmount: 2500, quantity: 9 }, undefined).estimatedNotional).toBe(2500);
  });
  it("uses quantity * (limit ?? stop ?? quote)", () => {
    expect(estimateReviewNotional({ quantity: 10, limitPrice: 50 }, 999).estimatedNotional).toBe(500);
    expect(estimateReviewNotional({ quantity: 10, stopPrice: 40 }, 999).estimatedNotional).toBe(400);
    expect(estimateReviewNotional({ quantity: 10 }, 30).estimatedNotional).toBe(300);
  });
  it("fails CLOSED (over-cap + alert) when no price is available for an OPENING order — never $100", () => {
    // Opening orders (buy/short, or unspecified side) keep the over-cap sentinel: an un-sizable open is blocked.
    const r = estimateReviewNotional({ quantity: 500 }, undefined);
    expect(r.estimatedNotional).toBe(Number.MAX_SAFE_INTEGER);
    expect(r.estimatedNotional).not.toBe(50000);
    expect(r.alerts.length).toBeGreaterThan(0);
    expect(estimateReviewNotional({ quantity: 500 }, 0).estimatedNotional).toBe(Number.MAX_SAFE_INTEGER);
    expect(estimateReviewNotional({ side: "buy", quantity: 500 }, undefined).estimatedNotional).toBe(Number.MAX_SAFE_INTEGER);
    expect(estimateReviewNotional({ side: "short", quantity: 500 }, undefined).estimatedNotional).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("does NOT use the over-cap sentinel for an EXIT with no price — returns 0 (exits aren't notional-capped)", () => {
    // Regression: a risk-exit SELL/cover with no live quote previously got MAX_SAFE_INTEGER, which
    // corrupted the displayed notional (~$9 quadrillion) and the net-exposure projection, blocking the exit.
    for (const side of ["sell", "cover"] as const) {
      const r = estimateReviewNotional({ side, quantity: 500 }, undefined);
      expect(r.estimatedNotional).toBe(0);
      expect(r.estimatedNotional).not.toBe(Number.MAX_SAFE_INTEGER);
      expect(r.alerts.length).toBeGreaterThan(0);
    }
  });

  it("falls back to referencePrice for an exit when the live quote is missing", () => {
    // The entry anchor is a real captured price (not fabricated), good enough for an exempt exit's display.
    expect(estimateReviewNotional({ side: "sell", quantity: 10, referencePrice: 42 }, undefined).estimatedNotional).toBe(420);
    // Opening orders do NOT use referencePrice — an un-sizable open must still fail closed.
    expect(estimateReviewNotional({ side: "buy", quantity: 10, referencePrice: 42 }, undefined).estimatedNotional).toBe(Number.MAX_SAFE_INTEGER);
    // A live quote / explicit order price still wins over the anchor for an exit.
    expect(estimateReviewNotional({ side: "sell", quantity: 10, referencePrice: 42 }, 50).estimatedNotional).toBe(500);
  });
});

// ── Policy: universe/blocklist gate is opening-only (exits always allowed) ────
describe("evaluateTradeProposal — universe gate skips exits", () => {
  const portfolio: Portfolio = { accountNumber: "A1", totalMarketValue: 10000, buyingPower: 5000, equityMarketValue: 5000, optionMarketValue: 0, cash: 5000 };
  const positions: EquityPosition[] = [{ symbol: "MSFT", quantity: 5, averageCost: 200, marketValue: 1000, sector: "Technology" }];
  const policy: TradingPolicy = {
    ...DEFAULT_POLICY,
    systemState: "active",
    strategyAuthority: "decide",
    accountNumber: "A1",
    includedIndices: [],
    additionalSymbols: ["AAPL"] // MSFT deliberately NOT in the allowed universe
  };
  const base = { type: "market" as const, timeInForce: "gfd" as const, marketHours: "regular_hours" as const, rationale: "t", tradeThesisTag: "t", entryMarketRegime: "t" };
  const ctx = { policy, portfolio, positions, dailyNotionalUsed: 0, dailyOrderCount: 0, estimatedNotional: 100 };
  const universeReason = (d: { reasons?: string[] }) => (d.reasons ?? []).some((r) => r.includes("not in the allowed universe"));

  it("blocks an opening BUY of an out-of-universe symbol", () => {
    const buy: TradeProposal = { ...base, symbol: "MSFT", side: "buy", quantity: 5 };
    expect(universeReason(evaluateTradeProposal(buy, ctx))).toBe(true);
  });

  it("does NOT block an exit SELL of the same out-of-universe symbol", () => {
    const sell: TradeProposal = { ...base, symbol: "MSFT", side: "sell", quantity: 5 };
    expect(universeReason(evaluateTradeProposal(sell, ctx))).toBe(false);
  });
});
