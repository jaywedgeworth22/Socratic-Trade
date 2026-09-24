// db.ts — core: DB initialisation, schema/migrations, getDb(), audit().
// Every function that was previously here has been extracted into focused modules;
// this file re-exports them all so every existing `import ... from "./db"` (or
// `"../lib/db"`, `"@/lib/db"`, etc.) continues to resolve without any changes.

import "server-only";
import Database from "better-sqlite3";
import { mkdirSync } from "fs";
import { dirname, resolve } from "path";
import { resetDrizzleForTesting } from "./db/client";
import crypto from "crypto";
import { DEFAULT_POLICY, DEFAULT_SCORING_WEIGHTS, DEFAULT_STRATEGY_PROMPT } from "./defaults";
import { SQLITE_BUSY_PIN_MS } from "./sqlite-event-loop";
import type { NotificationEventType, TradingPolicy } from "./types";

let db: Database.Database | undefined;
const SP500_DEFAULT_UNIVERSE_MIGRATION_KEY = "migration:sp500_default_universe:2026-06-19";

export function accountSubjectToken(userId: string): string {
  // User IDs are already opaque (or the literal local operator id). This non-PII lookup token must
  // survive ENCRYPTION_KEY/audit-salt rotation; a rotatable secret would orphan completed fences.
  return crypto.createHash("sha256").update(`account-subject:v1|${String(userId)}`, "utf8").digest("hex");
}

function accountSettingMatchesSubject(key: unknown, subjectToken: unknown): number {
  if (typeof key !== "string" || typeof subjectToken !== "string") return 0;
  if (key.startsWith("account_user_operation:")) {
    return key.slice("account_user_operation:".length).startsWith(`${subjectToken}:`) ? 1 : 0;
  }
  // Canonical ownership registry for rows in the otherwise-global `settings` table. Keep the user
  // segment immediately after one of these prefixes; optional account/provider/hash suffixes are
  // allowed. The same matcher powers both the deletion sweep and the prepared/completed write
  // fence, so adding a new user-owned internal setting cannot be fixed in one path but missed in
  // the other.
  for (const prefix of [
    "strategy_run_lock:",
    "robinhood_mcp_oauth_token:",
    "robinhood_mcp_oauth_state:",
    "llm_budget_reservation:",
    "providerTier:status:",
    "providerTier:lastCheckAt:",
    "risk:hwm:",
    "risk:sod:",
    "learning_review:lastRunDate:",
    "learning_review:lastFingerprint:",
    "learning_review:lastReviewedAt:",
    "learning_review:lastConfig:",
    "learning_review:legacySeedDone:",
    "last_auto_tune_at:",
    "regime:current:",
    "regime:macro-unavailable-notified:",
    "congress_score_verdict:",
    "reflection_signature:",
    "model_rotation:",
    "stale_limit_order_alert:",
    "subMinimumOrderAlertSent:",
    "usageLimitAlert:lastSent:",
    "recoverable_issue:",
    "last_macro_sent:"
  ]) {
    if (!key.startsWith(prefix)) continue;
    let candidate = key.slice(prefix.length);
    while (candidate) {
      if (accountSubjectToken(candidate) === subjectToken) return 1;
      const separator = candidate.lastIndexOf(":");
      if (separator < 0) break;
      candidate = candidate.slice(0, separator);
    }
  }
  // A few provider-health keys predate the user-first convention. They are still account-owned;
  // recognize the final segment without treating global env/operator lanes as user data.
  if (key.startsWith("healthAlertSent:") && key.includes(":user:")) {
    return accountSubjectToken(key.slice(key.lastIndexOf(":user:") + ":user:".length)) === subjectToken ? 1 : 0;
  }
  if (key.startsWith("vectorStore:connectionAlert:")) {
    const candidate = key.slice(key.lastIndexOf(":") + 1);
    return accountSubjectToken(candidate) === subjectToken ? 1 : 0;
  }
  return 0;
}

export function databasePath(): string {
  const value = process.env.DATABASE_URL ?? "file:./data/app.db";
  return resolve(value.replace(/^file:/, ""));
}

export function getDb(): Database.Database {
  if (db) return db;
  const path = databasePath();
  mkdirSync(dirname(path), { recursive: true });
  db = new Database(path);
  db.function("account_subject_token", { deterministic: true }, (value: unknown) => accountSubjectToken(String(value ?? "")));
  db.function("account_setting_matches_subject", { deterministic: true }, accountSettingMatchesSubject);
  db.pragma("journal_mode = WAL");
  // Short pin, not a 60s sleep. better-sqlite3 waits for SQLITE_BUSY ON THE EVENT LOOP,
  // so a 60s busy_timeout (raised 5s → 30s → 60s to hide "database is locked") froze
  // GET /api/live and GET /api/health for the whole wait — Traefik 503 while Docker
  // still said healthy. WAL readers *can* proceed during a writer only if the loop is
  // free to run them. Async writers keep the 60s lock budget via sqliteYieldRetry.
  db.pragma(`busy_timeout = ${SQLITE_BUSY_PIN_MS}`);
  db.pragma("synchronous = NORMAL");
  // Larger page cache + memory-mapped I/O: the dashboard replays fill/proposal history on every
  // request, so a ~20MB page cache (negative = KB) and 256MB mmap keep those hot reads off the
  // syscall path with a fixed, modest memory ceiling.
  db.pragma("cache_size = -20000");
  db.pragma("mmap_size = 268435456");
  // Enforce declared foreign keys (SQLite leaves this off by default). Inert today (no FKs are
  // declared) but the correct default so any future FK constraint actually enforces.
  db.pragma("foreign_keys = ON");
  migrate(db);
  applyVersionedMigrations(db);
  installAccountWriteFenceTriggers(db);
  assertEncryptionKeyAvailable(db);
  return db;
}

export function resetDbForTesting(): void {
  if (db) {
    try {
      db.close();
    } catch {}
    db = undefined;
  }
  // Drop the cached Drizzle wrapper too — it captures the underlying Database handle
  // at construction time, so resetting only the raw sqlite connection would leave a
  // dangling wrapper that throws "The database connection is not open" on the next
  // query. Test-only helper, no production effect (resetDrizzleForTesting is a no-op
  // outside the test runtime in practice — getDrizzle is module-private to tests).
  resetDrizzleForTesting();
}

// ── Versioned migrations ─────────────────────────────────────────────────────
// migrate() is the idempotent baseline (CREATE TABLE IF NOT EXISTS + ALTER-if-missing)
// representing the schema through SCHEMA_BASELINE. Any NEW schema change must be appended
// to MIGRATIONS with a higher version so it applies once, in order, recorded via
// PRAGMA user_version — replacing the old habit of adding another unversioned ALTER to
// migrate() (no ordering/stamp; diverged across worktrees).
const SCHEMA_BASELINE = 1;
export type Migration = { version: number; name: string; up: (db: Database.Database) => void };

function quoteSqlIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

/**
 * Safe table-existence check using sqlite_master.
 * PRAGMA table_info on a non-existent table returns an empty array rather than throwing,
 * which causes naive column-existence checks to misidentify missing tables as missing columns.
 */
export function tableExists(database: Database.Database, tableName: string): boolean {
  const row = database
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName);
  return !!row;
}

/**
 * Safe column-existence check that first verifies the table exists via sqlite_master
 * before inspecting PRAGMA table_info.
 */
export function columnExists(database: Database.Database, tableName: string, columnName: string): boolean {
  if (!tableExists(database, tableName)) return false;
  const cols = database.prepare(`PRAGMA table_info(${quoteSqlIdentifier(tableName)})`).all() as Array<{ name: string }>;
  return cols.some((c) => c.name === columnName);
}

/** Install fail-closed INSERT/UPDATE guards for every current user_id table plus user settings. */
export function installAccountWriteFenceTriggers(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS account_write_fences (
      subject_token TEXT PRIMARY KEY,
      generation TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('prepared','completed')),
      updated_at TEXT NOT NULL
    )
  `);
  const tables = (database.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all() as Array<{ name: string }>).filter(({ name }) => (
    database.prepare(`PRAGMA table_info(${quoteSqlIdentifier(name)})`).all() as Array<{ name: string }>
  ).some((column) => column.name === "user_id"));
  const noFence = new Set(["account_deletion_requests"]);
  const preparedUpdateAllowed = new Set([
    "api_health_log",
    "audit_events",
    "fill_events",
    "mobile_commands",
    "order_replacements",
    "provider_dispatch_attempts",
    "provider_usage_outbox",
    "rag_usage",
    "strategy_runs",
    "strategy_run_requests",
    "task_journal",
    "trade_proposals"
  ]);
  const preparedInsertAllowed = new Set([
    "api_health_log",
    "audit_events",
    "provider_usage_outbox",
    "rag_usage",
    "task_journal"
  ]);
  for (const { name } of tables) {
    if (noFence.has(name)) continue;
    const table = quoteSqlIdentifier(name);
    const triggerBase = name.replace(/[^A-Za-z0-9_]/g, "_");
    const insertStatuses = preparedInsertAllowed.has(name) ? "('completed')" : "('prepared','completed')";
    const updateStatuses = preparedUpdateAllowed.has(name) ? "('completed')" : "('prepared','completed')";
    database.exec(`
      CREATE TRIGGER IF NOT EXISTS account_write_fence_${triggerBase}_insert
      BEFORE INSERT ON ${table}
      WHEN NEW.user_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM account_write_fences f
        WHERE f.subject_token = account_subject_token(NEW.user_id)
          AND f.status IN ${insertStatuses}
      )
      BEGIN
        SELECT RAISE(ABORT, 'account-write-fenced');
      END;

      CREATE TRIGGER IF NOT EXISTS account_write_fence_${triggerBase}_update
      BEFORE UPDATE ON ${table}
      WHEN EXISTS (
        SELECT 1 FROM account_write_fences f
        WHERE (
          (NEW.user_id IS NOT NULL AND f.subject_token = account_subject_token(NEW.user_id)) OR
          (OLD.user_id IS NOT NULL AND f.subject_token = account_subject_token(OLD.user_id))
        ) AND f.status IN ${updateStatuses}
      )
      BEGIN
        SELECT RAISE(ABORT, 'account-write-fenced');
      END;
    `);
  }
  database.exec(`
    CREATE TRIGGER IF NOT EXISTS account_write_fence_settings_insert
    BEFORE INSERT ON settings
    WHEN EXISTS (
      SELECT 1 FROM account_write_fences f
      WHERE f.status IN ('prepared','completed')
        AND account_setting_matches_subject(NEW.key, f.subject_token) = 1
    )
    BEGIN
      SELECT RAISE(ABORT, 'account-write-fenced');
    END;

    CREATE TRIGGER IF NOT EXISTS account_write_fence_settings_update
    BEFORE UPDATE ON settings
    WHEN EXISTS (
      SELECT 1 FROM account_write_fences f
      WHERE f.status IN ('prepared','completed')
        AND (
          account_setting_matches_subject(NEW.key, f.subject_token) = 1 OR
          account_setting_matches_subject(OLD.key, f.subject_token) = 1
        )
    )
    BEGIN
      SELECT RAISE(ABORT, 'account-write-fenced');
    END;
  `);
  if (columnExists(database, "learned_context", "contributor_user_id")) {
    database.exec(`
      CREATE TRIGGER IF NOT EXISTS account_write_fence_learned_context_contributor_insert
      BEFORE INSERT ON learned_context
      WHEN NEW.contributor_user_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM account_write_fences f
        WHERE f.subject_token = account_subject_token(NEW.contributor_user_id)
          AND f.status IN ('prepared','completed')
      )
      BEGIN
        SELECT RAISE(ABORT, 'account-write-fenced');
      END;

      CREATE TRIGGER IF NOT EXISTS account_write_fence_learned_context_contributor_update
      BEFORE UPDATE ON learned_context
      WHEN EXISTS (
        SELECT 1 FROM account_write_fences f
        WHERE f.status IN ('prepared','completed') AND (
          (NEW.contributor_user_id IS NOT NULL AND f.subject_token = account_subject_token(NEW.contributor_user_id)) OR
          (OLD.contributor_user_id IS NOT NULL AND f.subject_token = account_subject_token(OLD.contributor_user_id))
        )
      )
      BEGIN
        SELECT RAISE(ABORT, 'account-write-fenced');
      END;
    `);
  }
}

/** Convert only the former product-default daily cap. Keeping this as a shared, idempotent helper
 * applies the same exact-value rule to every policy store that exists when migration v26 runs. */
function migrateLegacyDailyOpeningCapRows(database: Database.Database): number {
  const targets = [
    { table: "account_strategy_state", column: "policy", where: "1=1" },
    { table: "strategy_profiles", column: "policy", where: "1=1" },
    { table: "user_settings", column: "value", where: "key = 'policy'" },
    { table: "settings", column: "value", where: "key = 'policy'" }
  ] as const;
  let changed = 0;
  for (const target of targets) {
    if (!tableExists(database, target.table)) continue;
    const rows = database
      .prepare(`SELECT rowid, ${target.column} AS json FROM ${target.table} WHERE ${target.where}`)
      .all() as Array<{ rowid: number; json: string }>;
    const update = database.prepare(`UPDATE ${target.table} SET ${target.column} = ? WHERE rowid = ?`);
    for (const row of rows) {
      try {
        const policy = JSON.parse(row.json) as Record<string, unknown>;
        if (policy.maxDailyNotional !== 500 || (typeof policy.maxDailyPctOfNav === "number" && policy.maxDailyPctOfNav > 0)) continue;
        delete policy.maxDailyNotional;
        policy.maxDailyPctOfNav = 20;
        update.run(JSON.stringify(policy), row.rowid);
        changed += 1;
      } catch {
        // Corrupt JSON is already handled by the owning policy reader; a cap migration must not
        // make the database unbootable while trying to repair an unrelated row.
      }
    }
  }
  return changed;
}

/**
 * Event types that used to be force-included into a send's effective enabledEvents at send time
 * (banned pattern — owner ruling 2026-08-12, "ALL toggles must be real"): a stored
 * notificationSettings.enabledEvents array predating the type's addition to NOTIFICATION_EVENT_TYPES
 * would otherwise silently never receive it, so every one of these sites unconditionally injected
 * it into that send's policy, permanently overriding a user who had (or later set) the toggle off.
 * Migration 78 below backfills these into every stored array ONCE instead — see
 * backfillNotificationEnabledEventsRows. A future NotificationEventType that needs the same one-time
 * treatment should get its own versioned migration calling that helper with the new type(s); it must
 * NEVER be handled by resurrecting a force-include-at-send-time site.
 */
export const FORCE_INCLUDE_BACKFILL_EVENT_TYPES: readonly NotificationEventType[] = [
  "provider_degraded",
  "storage_warning",
  "autonomy_halted_on_boot",
  "budget_alert",
  "earningscalls_entitlement_blocked",
  "roic_status_advisory",
  "signal_health",
  "lookahead_leak",
  "risk_advisory"
];

/**
 * Backfill `eventTypes` into every stored policy's notificationSettings.enabledEvents, ONCE, but
 * only for rows where an explicit enabledEvents ARRAY is already present. A row with no
 * notificationSettings (or no enabledEvents key) at all already resolves every event type through
 * mergePolicy's DEFAULT_POLICY fallback — touching it here would be a no-op at best and would
 * needlessly freeze that row out of picking up defaults for event types added after this
 * migration runs. Mirrors migrateLegacyDailyOpeningCapRows's 4-store sweep (account_strategy_state,
 * strategy_profiles, user_settings, settings) so every place a policy can be persisted is covered.
 */
function backfillNotificationEnabledEventsRows(database: Database.Database, eventTypes: readonly NotificationEventType[]): number {
  const targets = [
    { table: "account_strategy_state", column: "policy", where: "1=1" },
    { table: "strategy_profiles", column: "policy", where: "1=1" },
    { table: "user_settings", column: "value", where: "key = 'policy'" },
    { table: "settings", column: "value", where: "key = 'policy'" }
  ] as const;
  let changed = 0;
  for (const target of targets) {
    // Defensive: every one of these exists by the time versioned migrations run against a real
    // boot (migrate()'s baseline DDL always runs first — see openDatabase). Some test fixtures
    // build a deliberately minimal schema and invoke applyVersionedMigrations directly without
    // that baseline, so a table can legitimately be absent there; skip rather than throw.
    const exists = database
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(target.table);
    if (!exists) continue;
    const rows = database
      .prepare(`SELECT rowid, ${target.column} AS json FROM ${target.table} WHERE ${target.where}`)
      .all() as Array<{ rowid: number; json: string }>;
    const update = database.prepare(`UPDATE ${target.table} SET ${target.column} = ? WHERE rowid = ?`);
    for (const row of rows) {
      try {
        const policy = JSON.parse(row.json) as Record<string, unknown>;
        const notificationSettings = policy.notificationSettings as Record<string, unknown> | undefined;
        const enabledEvents = notificationSettings?.enabledEvents;
        if (!notificationSettings || !Array.isArray(enabledEvents)) continue;
        const existing = new Set(enabledEvents as string[]);
        const missing = eventTypes.filter((type) => !existing.has(type));
        if (missing.length === 0) continue;
        notificationSettings.enabledEvents = [...enabledEvents, ...missing];
        update.run(JSON.stringify(policy), row.rowid);
        changed += 1;
      } catch {
        // Corrupt JSON is already handled by the owning policy reader; this backfill must not make
        // the database unbootable while trying to repair an unrelated row.
      }
    }
  }
  return changed;
}

const MIGRATIONS: Migration[] = [
  {
    // Per-attached-key LLM usage attribution: usage/cost measured per distinct key (user or
    // operator), not just per source. Idempotent — skips the column/index when already present.
    version: 2,
    name: "llm_usage_key_ref",
    up: (database) => {
      if (!tableExists(database, "llm_usage")) return;
      if (!columnExists(database, "llm_usage", "key_ref")) {
        database.exec("ALTER TABLE llm_usage ADD COLUMN key_ref TEXT");
      }
      database.exec("CREATE INDEX IF NOT EXISTS idx_llm_usage_key ON llm_usage (key_ref, created_at)");
    }
  },
  {
    version: 3,
    name: "execution_mode_columns",
    up: (database) => {
      const addColumnIfMissing = (table: string) => {
        if (!tableExists(database, table)) return;
        if (!columnExists(database, table, "execution_mode")) {
          database.exec(`ALTER TABLE ${table} ADD COLUMN execution_mode TEXT`);
        }
      };

      addColumnIfMissing("trade_proposals");
      addColumnIfMissing("portfolio_snapshots");
      addColumnIfMissing("fill_events");

      if (tableExists(database, "trade_proposals") && tableExists(database, "connected_accounts")) {
        database.exec(`
          UPDATE trade_proposals
          SET execution_mode = COALESCE(
            execution_mode,
            (
              SELECT CASE connected_accounts.environment
                WHEN 'paper' THEN 'broker/paper'
                WHEN 'live' THEN 'broker/live'
                ELSE NULL
              END
              FROM connected_accounts
              WHERE connected_accounts.user_id = trade_proposals.user_id
                AND connected_accounts.account_number = trade_proposals.account_number
              LIMIT 1
            ),
            CASE
              WHEN status = 'paper' THEN 'test/local'
              WHEN status IN ('placed', 'filled', 'placing', 'placing_failed') THEN 'broker/live'
              ELSE NULL
            END
          )
          WHERE execution_mode IS NULL;
        `);
      }

      if (tableExists(database, "portfolio_snapshots") && tableExists(database, "connected_accounts")) {
        database.exec(`
          UPDATE portfolio_snapshots
          SET execution_mode = COALESCE(
            execution_mode,
            (
              SELECT CASE connected_accounts.environment
                WHEN 'paper' THEN 'broker/paper'
                WHEN 'live' THEN 'broker/live'
                ELSE NULL
              END
              FROM connected_accounts
              WHERE connected_accounts.user_id = portfolio_snapshots.user_id
                AND connected_accounts.account_number = portfolio_snapshots.account_number
              LIMIT 1
            ),
            CASE
              WHEN source = 'paper' THEN 'test/local'
              WHEN source = 'live' THEN 'broker/live'
              ELSE NULL
            END
          )
          WHERE execution_mode IS NULL;
        `);
      }

      if (tableExists(database, "fill_events") && tableExists(database, "connected_accounts")) {
        database.exec(`
          UPDATE fill_events
          SET execution_mode = COALESCE(
            execution_mode,
            (
              SELECT CASE connected_accounts.environment
                WHEN 'paper' THEN 'broker/paper'
                WHEN 'live' THEN 'broker/live'
                ELSE NULL
              END
              FROM connected_accounts
              WHERE connected_accounts.user_id = fill_events.user_id
                AND connected_accounts.account_number = fill_events.account_number
              LIMIT 1
            ),
            CASE
              WHEN source = 'paper' THEN 'test/local'
              WHEN source = 'live' THEN 'broker/live'
              ELSE NULL
            END
          )
          WHERE execution_mode IS NULL;
        `);
      }

      if (tableExists(database, "trade_proposals")) {
        database.exec("CREATE INDEX IF NOT EXISTS idx_trade_proposals_execution_mode ON trade_proposals (user_id, account_number, execution_mode, created_at)");
      }
      if (tableExists(database, "portfolio_snapshots")) {
        database.exec("CREATE INDEX IF NOT EXISTS idx_portfolio_snapshots_execution_mode ON portfolio_snapshots (user_id, account_number, execution_mode, created_at)");
      }
      if (tableExists(database, "fill_events")) {
        database.exec("CREATE INDEX IF NOT EXISTS idx_fill_events_execution_mode ON fill_events (user_id, account_number, execution_mode, filled_at)");
      }
    }
  },
  {
    version: 4,
    name: "account_deletion_lifecycle",
    up: (database) => {
      database.exec(`
        CREATE TABLE IF NOT EXISTS account_deletion_requests (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          email TEXT,
          requested_at TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('prepared','completed','cancelled')),
          completed_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_account_deletion_requests_user_status ON account_deletion_requests (user_id, status, requested_at);

        CREATE TABLE IF NOT EXISTS account_deletion_audit (
          id TEXT PRIMARY KEY,
          subject_hash TEXT NOT NULL,
          requested_at TEXT NOT NULL,
          completed_at TEXT NOT NULL,
          counts_json TEXT NOT NULL,
          schema_version INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_account_deletion_audit_subject ON account_deletion_audit (subject_hash, completed_at);
      `);
    }
  },
  {
    // Record which model produced each assistant chat turn, so the transcript / admin view / hover can
    // show "via <model>". Idempotent — skips the column when already present.
    version: 5,
    name: "chat_turns_model",
    up: (database) => {
      if (!tableExists(database, "chat_turns")) return;
      if (!columnExists(database, "chat_turns", "model")) {
        database.exec("ALTER TABLE chat_turns ADD COLUMN model TEXT");
      }
    }
  },
  {
    version: 6,
    name: "performance_indexing_fixes",
    up: (database) => {
      // 1. Remove redundant index
      database.exec("DROP INDEX IF EXISTS idx_imported_price_eod_ticker");

      // 2. Index for joining strategy_runs and trade_proposals (Dashboard bottleneck)
      if (tableExists(database, "trade_proposals")) {
        database.exec("CREATE INDEX IF NOT EXISTS idx_trade_proposals_run_id ON trade_proposals (run_id)");
        database.exec("CREATE INDEX IF NOT EXISTS idx_trade_proposals_user_account_status_created ON trade_proposals (user_id, account_number, status, created_at DESC)");
        database.exec("CREATE INDEX IF NOT EXISTS idx_trade_proposals_user_account_created ON trade_proposals (user_id, account_number, created_at DESC)");
      }

      if (tableExists(database, "order_replacements")) {
        database.exec("CREATE INDEX IF NOT EXISTS idx_order_replacements_user_account_status ON order_replacements (user_id, account_number, status)");
        database.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_order_replacements_active_unique ON order_replacements (account_number, original_order_id) WHERE status NOT IN ('replacement_confirmed', 'failed', 'aborted')");
      }

      if (tableExists(database, "fill_events")) {
        database.exec("CREATE INDEX IF NOT EXISTS idx_fill_events_user_account_symbol_filled ON fill_events (user_id, account_number, symbol, filled_at DESC)");
      }

      if (tableExists(database, "portfolio_snapshots")) {
        database.exec("CREATE INDEX IF NOT EXISTS idx_portfolio_snapshots_user_account_source_created ON portfolio_snapshots (user_id, account_number, source, created_at DESC)");
      }

      if (tableExists(database, "audit_events")) {
        database.exec("CREATE INDEX IF NOT EXISTS idx_audit_events_user_account_kind ON audit_events (user_id, connected_account_id, kind)");
        database.exec("CREATE INDEX IF NOT EXISTS idx_audit_events_user_created ON audit_events (user_id, created_at DESC)");
        // latestAuditByKind/latestAuditStampByKind: kind-equality + created_at ordering. Without
        // this, those queries either walk user_created backwards row-by-row or drag every matching
        // row — multi-MB market_scan payloads included — through the sorter; on the production
        // 718MB audit_events table that was a minutes-long sync hold on the one DB connection
        // (2026-08-02 prod wedge, every 60s tick).
        database.exec("CREATE INDEX IF NOT EXISTS idx_audit_events_kind_user_created ON audit_events (kind, user_id, created_at DESC)");
      }

      if (tableExists(database, "skipped_candidate_counterfactuals")) {
        database.exec("CREATE INDEX IF NOT EXISTS idx_skipped_counterfactuals_user_account_status_return ON skipped_candidate_counterfactuals (user_id, connected_account_id, status, return_pct DESC, updated_at DESC)");
      }
    }
  },
  {
    version: 7,
    name: "account_scoped_strategy_models_backfill",
    up: (database) => backfillAccountScopedStrategyModels(database)
  },
  {
    version: 8,
    name: "mobile_commands",
    up: (database) => {
      database.exec(`
        CREATE TABLE IF NOT EXISTS mobile_commands (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          idempotency_key TEXT,
          command_type TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed','cancelled')),
          payload TEXT NOT NULL DEFAULT '{}',
          result TEXT,
          error TEXT,
          client TEXT,
          created_at TEXT NOT NULL,
          queued_at TEXT NOT NULL,
          started_at TEXT,
          finished_at TEXT,
          updated_at TEXT NOT NULL,
          UNIQUE(user_id, idempotency_key)
        );
        CREATE INDEX IF NOT EXISTS idx_mobile_commands_user_created ON mobile_commands (user_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_mobile_commands_status ON mobile_commands (status, queued_at);
      `);
    }
  },
  {
    // Stamp which versioned strategy prompt (STRATEGY_PROMPT_VERSION) produced each proposal, so a
    // proposal can be traced to the exact Bull/Bear prompt revision. Nullable — legacy rows stay null.
    version: 9,
    name: "trade_proposals_prompt_version",
    up: (database) => {
      if (!tableExists(database, "trade_proposals")) return;
      if (!columnExists(database, "trade_proposals", "prompt_version")) {
        database.exec("ALTER TABLE trade_proposals ADD COLUMN prompt_version TEXT");
      }
    }
  },
  {
    // Idempotency key for POST /api/chat: the client generates a per-send clientTurnId and REUSES it
    // on Retry, so a retried send doesn't record the user turn twice (the orchestrator appends the
    // user turn BEFORE the provider call). Nullable — legacy rows and assistant turns stay null.
    version: 10,
    name: "chat_turns_client_turn_id",
    up: (database) => {
      if (!tableExists(database, "chat_turns")) return;
      if (!columnExists(database, "chat_turns", "client_turn_id")) {
        database.exec("ALTER TABLE chat_turns ADD COLUMN client_turn_id TEXT");
      }
      database.exec("CREATE INDEX IF NOT EXISTS idx_chat_turns_user_client ON chat_turns (user_id, client_turn_id)");
    }
  },
  {
    // Durable due-jobs substrate (src/lib/db-jobs.ts): a generic claimable job queue so time-based
    // work (starting with 15m/1h intraday outcome sampling — outcome-horizons.ts) survives process
    // restarts instead of depending on a strategy run coincidentally landing inside the sampling
    // window. Lease/reclaim semantics (claimed_by + lease_expires_at) fix the gap the mobile_commands
    // queue (v8 above) has: a crashed 'running' row there is stuck forever; this table's claim path
    // reclaims a stale 'claimed' row whose lease expired instead of leaving it orphaned.
    version: 11,
    name: "due_jobs",
    up: (database) => {
      database.exec(`
        CREATE TABLE IF NOT EXISTS due_jobs (
          id TEXT PRIMARY KEY,
          job_type TEXT NOT NULL,
          dedupe_key TEXT,
          due_at TEXT NOT NULL,
          not_after TEXT,
          status TEXT NOT NULL CHECK(status IN ('pending','claimed','done','unresolvable')),
          payload TEXT NOT NULL DEFAULT '{}',
          claimed_by TEXT,
          claimed_at TEXT,
          lease_expires_at TEXT,
          attempts INTEGER NOT NULL DEFAULT 0,
          last_error TEXT,
          result TEXT,
          user_id TEXT,
          connected_account_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(job_type, dedupe_key)
        );
        CREATE INDEX IF NOT EXISTS idx_due_jobs_status_due ON due_jobs (status, due_at);
        CREATE INDEX IF NOT EXISTS idx_due_jobs_type_status ON due_jobs (job_type, status);
      `);
    }
  },
  {
    // Framework review now persists the owner's explicit verb ("accept" vs "rewrite" vs "reject")
    // alongside the free-text response so the console can distinguish a straight accept from an
    // accepted-with-rewrite outcome. Nullable for legacy rows.
    version: 12,
    name: "socratic_framework_owner_verb",
    up: (database) => {
      if (!tableExists(database, "socratic_framework_proposals")) return;
      if (!columnExists(database, "socratic_framework_proposals", "owner_verb")) {
        database.exec("ALTER TABLE socratic_framework_proposals ADD COLUMN owner_verb TEXT");
      }
    }
  },
  {
    version: 13,
    name: "processed_webhooks",
    up: (database) => {
      database.exec(`
        CREATE TABLE IF NOT EXISTS processed_webhooks (
          id TEXT PRIMARY KEY,
          processed_at TEXT NOT NULL
        );
      `);
    }
  },
  {
    // Per-account/broker LLM usage attribution: tag each usage row with the connected account it
    // was recorded for, so cost/tokens can be filtered by account (broker/environment derived via
    // join to connected_accounts). Nullable — pre-existing rows and account-less contexts stay
    // unattributed. Versioned ALTER (not a CREATE-only column add) per the 2026-07-02 "no such
    // column" boot-crash scar noted on the llm_usage CREATE TABLE below.
    version: 14,
    name: "llm_usage_connected_account",
    up: (database) => {
      if (!tableExists(database, "llm_usage")) return;
      if (!columnExists(database, "llm_usage", "connected_account_id")) {
        database.exec("ALTER TABLE llm_usage ADD COLUMN connected_account_id TEXT");
      }
      database.exec(
        "CREATE INDEX IF NOT EXISTS idx_llm_usage_account ON llm_usage (connected_account_id, created_at)"
      );
    }
  },
  {
    // Single-adversary consolidation R15: the hidden RED_TEAM_LLM_PROVIDER/RED_TEAM_LLM_MODEL env
    // override is being DELETED (owner directive 2026-07-07: Settings must tell the truth; no hidden
    // routing). A deployment that was actually serving its Red Team via that override — with a blank
    // per-account `redTeamLlmModel` — would silently flip to fail-closed (every opening routed to
    // human review) the moment the env reads disappear. Seed the first-class setting ONCE from the
    // env override that was serving, so a working safety setup keeps working and the owner can see —
    // and change — the real model in Settings. Only rows with a BLANK redTeamLlmModel are touched
    // (an explicit choice always wins), and nothing is seeded when the override was never active.
    // This is a migration of an operator's own explicit env configuration, NOT a new default: with
    // no env override set, blank stays blank and fails closed legibly.
    version: 15,
    name: "seed_red_team_model_from_env_override",
    up: (database) => {
      const envProvider = (process.env.RED_TEAM_LLM_PROVIDER ?? "").trim().toLowerCase();
      if (envProvider !== "anthropic") return;
      if (!tableExists(database, "account_strategy_state")) return;
      // The exact model the deleted override path was running (red-team.ts's debateViaAnthropic):
      // RED_TEAM_LLM_MODEL when set, else its hardcoded claude-haiku default.
      const servedModel = (process.env.RED_TEAM_LLM_MODEL ?? "").trim() || "claude-haiku-4-5-20251001";
      const rows = database
        .prepare("SELECT user_id, connected_account_id, policy FROM account_strategy_state")
        .all() as Array<{ user_id: string; connected_account_id: string; policy: string }>;
      const update = database.prepare(
        "UPDATE account_strategy_state SET policy = ? WHERE user_id = ? AND connected_account_id = ?"
      );
      for (const row of rows) {
        let policy: Record<string, unknown>;
        try {
          policy = JSON.parse(row.policy) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (!policy || typeof policy !== "object") continue;
        const existing = typeof policy.redTeamLlmModel === "string" ? policy.redTeamLlmModel.trim() : "";
        if (existing) continue; // explicit choice wins — never overwrite
        policy.redTeamLlmModel = servedModel;
        update.run(JSON.stringify(policy), row.user_id, row.connected_account_id);
        console.log(
          `[db] migration 15: seeded redTeamLlmModel="${servedModel}" for account ${row.connected_account_id} (user ${row.user_id}) from the retired RED_TEAM_LLM_PROVIDER env override — review it under Strategy → Models.`
        );
      }
    }
  },
  {
    // Durable double-fill backstop: a partial UNIQUE index on fill_events (proposal_id,
    // broker_order_id) so the inline/sweep check-then-insert can't double-book the same physical
    // broker order even if the single-process invariant is ever violated (concurrent scheduler +
    // approval, or a crash-retry across processes). Partial (WHERE both non-null) so pre-placement
    // rows and non-broker fills — which legitimately share NULLs — are never constrained. Existing
    // duplicate (proposal_id, broker_order_id) rows are collapsed FIRST (keep the earliest by rowid,
    // delete the rest, logged loudly) so the index can't fail to build on legacy double-books — a
    // duplicate for the same physical order IS a double-count bug, so collapsing it is the intended
    // consistency fix, not data loss. insertFillEvent treats the constraint violation as an
    // idempotent no-op (returns the already-booked fill).
    version: 16,
    name: "fill_events_dedupe_unique_index",
    up: (database) => {
      if (!tableExists(database, "fill_events")) return;
      const dupGroups = database
        .prepare(
          `SELECT proposal_id, broker_order_id, COUNT(*) AS c, MIN(rowid) AS keep_rowid
           FROM fill_events
           WHERE proposal_id IS NOT NULL AND broker_order_id IS NOT NULL
           GROUP BY proposal_id, broker_order_id
           HAVING c > 1`
        )
        .all() as Array<{ proposal_id: string; broker_order_id: string; c: number; keep_rowid: number }>;
      const deleteExtras = database.prepare(
        `DELETE FROM fill_events
         WHERE proposal_id = ? AND broker_order_id = ? AND rowid != ?`
      );
      for (const g of dupGroups) {
        const info = deleteExtras.run(g.proposal_id, g.broker_order_id, g.keep_rowid);
        console.warn(
          `[db] migration 16: collapsed ${info.changes} duplicate fill_events row(s) for (proposal_id=${g.proposal_id}, broker_order_id=${g.broker_order_id}) — kept rowid ${g.keep_rowid}. A duplicate for the same physical broker order is a double-count bug; the new UNIQUE index prevents recurrence.`
        );
      }
      database.exec(
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_fill_events_proposal_broker_order
         ON fill_events (proposal_id, broker_order_id)
         WHERE proposal_id IS NOT NULL AND broker_order_id IS NOT NULL`
      );
    }
  },
  {
    // Broker-held TRAILING stops: broker_protective_stops rows grow a `kind` ('fixed' | 'trailing')
    // and, for trailing rows, the configured `trail_percent`. Pre-existing rows are all the
    // Robinhood fixed stops — the 'fixed' default is exactly right for them. Idempotent — skips
    // each column when already present (fresh DBs get both from CREATE TABLE).
    version: 17,
    name: "broker_protective_stops_trailing_columns",
    up: (database) => {
      if (!tableExists(database, "broker_protective_stops")) return;
      if (!columnExists(database, "broker_protective_stops", "kind")) {
        database.exec("ALTER TABLE broker_protective_stops ADD COLUMN kind TEXT NOT NULL DEFAULT 'fixed'");
      }
      if (!columnExists(database, "broker_protective_stops", "trail_percent")) {
        database.exec("ALTER TABLE broker_protective_stops ADD COLUMN trail_percent REAL");
      }
    }
  },
  {
    // position_stop_plans grows a `side` column ('long' | 'short') so filterFullStopPlansByLiveBasis
    // can distinguish a closed long from a same-symbol short opened later at a similar cost basis —
    // matching on symbol+avgCost alone let a long's plan leak onto an unrelated short lot (Codex
    // review, PR #1371). Existing rows default to 'long' (every row written before this field existed
    // came from an opening buy — "none"/"trailing" plans on shorts came later); idempotent (skips
    // when already present — fresh DBs get it from CREATE TABLE).
    version: 18,
    name: "position_stop_plans_side_column",
    up: (database) => {
      if (!tableExists(database, "position_stop_plans")) return;
      if (!columnExists(database, "position_stop_plans", "side")) {
        database.exec("ALTER TABLE position_stop_plans ADD COLUMN side TEXT NOT NULL DEFAULT 'long'");
      }
    }
  },
  {
    version: 19,
    name: "sec_rag_manifest_tables",
    up: (database) => {
      // 1. Create sec_filings
      database.exec(`
        CREATE TABLE IF NOT EXISTS sec_filings (
          accession TEXT PRIMARY KEY,
          cik TEXT NOT NULL DEFAULT '',
          ticker TEXT NOT NULL DEFAULT '',
          form TEXT NOT NULL,
          filed_at TEXT NOT NULL,
          accepted_at TEXT NOT NULL,
          report_period TEXT,
          fy TEXT,
          fp TEXT,
          amendment_parent TEXT,
          superseded_by TEXT,
          status TEXT NOT NULL DEFAULT 'discovered',
          chunk_count INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_sec_filings_cik ON sec_filings (cik);
        CREATE INDEX IF NOT EXISTS idx_sec_filings_ticker ON sec_filings (ticker);
      `);

      // 2. Create sec_artifacts
      database.exec(`
        CREATE TABLE IF NOT EXISTS sec_artifacts (
          accession TEXT NOT NULL,
          sequence INTEGER NOT NULL,
          document_name TEXT NOT NULL,
          sha256 TEXT NOT NULL,
          type TEXT NOT NULL,
          byte_count INTEGER NOT NULL,
          raw_uri TEXT NOT NULL,
          parser_version TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (accession, sequence, document_name)
        );
      `);

      // 3. Create chunk_occurrences
      database.exec(`
        CREATE TABLE IF NOT EXISTS chunk_occurrences (
          vector_id TEXT PRIMARY KEY,
          content_hash TEXT NOT NULL,
          symbol TEXT NOT NULL,
          source TEXT NOT NULL,
          accession TEXT NOT NULL,
          sequence INTEGER,
          document_name TEXT,
          section TEXT NOT NULL,
          ordinal INTEGER NOT NULL,
          accepted_at TEXT NOT NULL,
          tenant_scope TEXT NOT NULL DEFAULT 'legacy',
          content_version TEXT NOT NULL DEFAULT 'legacy',
          commit_id TEXT,
          receipt_state TEXT NOT NULL DEFAULT 'legacy_committed'
            CHECK(receipt_state IN ('pending','committed','legacy_committed')),
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_chunk_occurrences_hash ON chunk_occurrences (content_hash);
        CREATE INDEX IF NOT EXISTS idx_chunk_occurrences_symbol ON chunk_occurrences (symbol);
        CREATE INDEX IF NOT EXISTS idx_chunk_occurrences_accession ON chunk_occurrences (accession);
      `);

      // 4. Backfill from ingested_accessions to sec_filings
      const hasIngested = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ingested_accessions'").get();
      if (hasIngested) {
        database.exec(`
          INSERT OR IGNORE INTO sec_filings (accession, cik, ticker, form, filed_at, accepted_at, status, chunk_count, created_at, updated_at)
          SELECT accession, '', ticker, doc_type, indexed_at, indexed_at, 'complete', chunk_count, indexed_at, indexed_at
          FROM ingested_accessions;
        `);
      }

      // 5. Backfill from document_chunks to chunk_occurrences
      const hasChunks = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='document_chunks'").get();
      if (hasChunks) {
        const rows = database.prepare("SELECT content_hash, symbol, source, chunk_id, created_at FROM document_chunks").all() as Array<{
          content_hash: string;
          symbol: string;
          source: string;
          chunk_id: string;
          created_at: string;
        }>;
        const insertOcc = database.prepare(`
          INSERT OR IGNORE INTO chunk_occurrences (vector_id, content_hash, symbol, source, accession, section, ordinal, accepted_at, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const r of rows) {
          const parts = r.chunk_id.split(":");
          const source = parts[0] || r.source || "sec";
          const symbol = parts[1] || r.symbol || "";
          const accession = parts[2] || "";
          const acceptedAt = parts[3] || r.created_at;
          const vectorId = `v1:${r.chunk_id}:v1`;
          insertOcc.run(vectorId, r.content_hash, symbol, source, accession, "body", 0, acceptedAt, r.created_at);
        }
      }
    }
  },
  {
    // Persist original order details for stale exit replacements (PR 2 follow-up)
    version: 20,
    name: "order_replacements_original_order_columns",
    up: (database) => {
      if (!tableExists(database, "order_replacements")) return;
      if (!columnExists(database, "order_replacements", "symbol")) {
        database.exec("ALTER TABLE order_replacements ADD COLUMN symbol TEXT");
      }
      if (!columnExists(database, "order_replacements", "side")) {
        database.exec("ALTER TABLE order_replacements ADD COLUMN side TEXT");
      }
      if (!columnExists(database, "order_replacements", "original_type")) {
        database.exec("ALTER TABLE order_replacements ADD COLUMN original_type TEXT");
      }
      if (!columnExists(database, "order_replacements", "original_quantity")) {
        database.exec("ALTER TABLE order_replacements ADD COLUMN original_quantity REAL");
      }
      if (!columnExists(database, "order_replacements", "original_filled_quantity")) {
        database.exec("ALTER TABLE order_replacements ADD COLUMN original_filled_quantity REAL");
      }
    }
  },
  {
    // Order-replacements indexes for the exit-replacement state machine (PR 2 follow-up).
    // These were originally added inside migration v6, but deployed databases already
    // have PRAGMA user_version past 6, so runMigrations skips that block and never
    // creates the indexes. Every database — fresh and existing — needs the UNIQUE
    // partial index as the concurrency guard against duplicate replacements.
    version: 21,
    name: "order_replacements_indexes_reapply",
    up: (database) => {
      if (!tableExists(database, "order_replacements")) return;
      // Before creating the UNIQUE partial index, collapse any duplicate active
      // rows that could already exist. Prioritize keeping the most progressed
      // row in the state machine (favoring rows with a replacement_order_id).
      const dupGroups = database
        .prepare(
          `WITH ranked AS (
             SELECT rowid, account_number, original_order_id,
                    ROW_NUMBER() OVER (
                      PARTITION BY account_number, original_order_id
                      ORDER BY
                        CASE status
                          WHEN 'replacement_submitted' THEN 1
                          WHEN 'replacement_claiming' THEN 2
                          WHEN 'cancel_confirmed' THEN 3
                          WHEN 'cancel_requested' THEN 4
                          ELSE 5
                        END ASC,
                        CASE WHEN replacement_order_id IS NOT NULL THEN 0 ELSE 1 END ASC,
                        rowid DESC
                    ) as rn
             FROM order_replacements
             WHERE status NOT IN ('replacement_confirmed', 'failed', 'aborted')
           )
           SELECT account_number, original_order_id, COUNT(*) AS c, MAX(CASE WHEN rn = 1 THEN rowid END) AS keep_rowid
           FROM ranked
           GROUP BY account_number, original_order_id
           HAVING COUNT(*) > 1`
        )
        .all() as Array<{ account_number: string; original_order_id: string; c: number; keep_rowid: number }>;
      const terminalizeExtras = database.prepare(
        `UPDATE order_replacements SET status = 'failed', error = 'superseded by duplicate active replacement', updated_at = ?
         WHERE account_number = ? AND original_order_id = ? AND rowid != ?
         AND status NOT IN ('replacement_confirmed', 'failed', 'aborted')`
      );
      const now = new Date().toISOString();
      for (const g of dupGroups) {
        const info = terminalizeExtras.run(now, g.account_number, g.original_order_id, g.keep_rowid);
        console.warn(
          `[db] migration 21: terminalized ${info.changes} duplicate order_replacements row(s) ` +
          `for (account_number=${g.account_number}, original_order_id=${g.original_order_id}) — kept rowid ${g.keep_rowid}.`
        );
      }
      database.exec("CREATE INDEX IF NOT EXISTS idx_order_replacements_user_account_status ON order_replacements (user_id, account_number, status)");
      database.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_order_replacements_active_unique ON order_replacements (account_number, original_order_id) WHERE status NOT IN ('replacement_confirmed', 'failed', 'aborted')");
    }
  },
  {
    version: 22,
    name: "order_replacements_claiming_state_schema",
    up: (database) => {
      if (!tableExists(database, "order_replacements")) {
        database.exec(`
          CREATE TABLE IF NOT EXISTS order_replacements (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            account_number TEXT NOT NULL,
            original_order_id TEXT NOT NULL,
            symbol TEXT,
            side TEXT,
            original_type TEXT,
            original_quantity REAL,
            original_filled_quantity REAL,
            replacement_ref_id TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('cancel_requested', 'cancel_confirmed', 'replacement_claiming', 'replacement_submitted', 'replacement_confirmed', 'failed', 'aborted')),
            remaining_quantity REAL,
            cancel_result TEXT,
            replacement_order_id TEXT,
            error TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_order_replacements_user_account_status ON order_replacements (user_id, account_number, status);
          CREATE UNIQUE INDEX IF NOT EXISTS idx_order_replacements_active_unique ON order_replacements (account_number, original_order_id) WHERE status NOT IN ('replacement_confirmed', 'failed', 'aborted');
        `);
        return;
      }
      // SQLite does not support ALTER TABLE DROP CONSTRAINT. To expand the CHECK
      // constraint on status to include 'replacement_claiming', we recreate the table.
      database.exec(`
        CREATE TABLE IF NOT EXISTS order_replacements_v22 (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          account_number TEXT NOT NULL,
          original_order_id TEXT NOT NULL,
          symbol TEXT,
          side TEXT,
          original_type TEXT,
          original_quantity REAL,
          original_filled_quantity REAL,
          replacement_ref_id TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('cancel_requested', 'cancel_confirmed', 'replacement_claiming', 'replacement_submitted', 'replacement_confirmed', 'failed', 'aborted')),
          remaining_quantity REAL,
          cancel_result TEXT,
          replacement_order_id TEXT,
          error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        INSERT INTO order_replacements_v22 SELECT * FROM order_replacements;
        DROP TABLE order_replacements;
        ALTER TABLE order_replacements_v22 RENAME TO order_replacements;

        CREATE INDEX IF NOT EXISTS idx_order_replacements_user_account_status ON order_replacements (user_id, account_number, status);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_order_replacements_active_unique ON order_replacements (account_number, original_order_id) WHERE status NOT IN ('replacement_confirmed', 'failed', 'aborted');
      `);
    }
  },
  {
    // Durable, stage-aware SEC/RAG backfill substrate. A generic due_job is not enough here:
    // ingestion must retain an immutable artifact identity, a resumable stage checkpoint, fenced
    // leases/heartbeats, per-stage attempts, typed failures, verification receipts, and measured
    // provider cost. No scheduler or production writer is wired by this migration; it only creates
    // the local durable state that a separately gated worker can use.
    version: 23,
    name: "sec_rag_ingest_jobs",
    up: (database) => {
      database.exec(`
        CREATE TABLE IF NOT EXISTS sec_ingest_jobs (
          id TEXT PRIMARY KEY,
          idempotency_key TEXT NOT NULL UNIQUE,
          corpus_revision TEXT NOT NULL,
          universe_snapshot_id TEXT,
          status TEXT NOT NULL CHECK(status IN (
            'pending', 'running', 'paused', 'complete', 'complete_with_errors',
            'failed_terminal', 'canceled'
          )),
          config_json TEXT NOT NULL DEFAULT '{}',
          expected_tasks INTEGER CHECK(expected_tasks IS NULL OR expected_tasks >= 0),
          last_error_type TEXT,
          last_error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          started_at TEXT,
          intake_closed_at TEXT,
          completed_at TEXT
        );

        CREATE TABLE IF NOT EXISTS sec_ingest_tasks (
          id TEXT PRIMARY KEY,
          job_id TEXT NOT NULL,
          task_key TEXT NOT NULL,
          accession TEXT NOT NULL,
          cik TEXT NOT NULL DEFAULT '',
          symbol TEXT NOT NULL DEFAULT '',
          sequence INTEGER,
          document_name TEXT,
          checkpoint TEXT NOT NULL CHECK(checkpoint IN (
            'discovered', 'fetched', 'validated', 'parsed', 'facts_extracted', 'chunked',
            'embed_queued', 'embedded', 'index_queued', 'indexed', 'verified', 'complete'
          )),
          status TEXT NOT NULL CHECK(status IN (
            'pending', 'leased', 'retry_wait', 'complete', 'dead_letter',
            'quarantined', 'superseded'
          )),
          priority INTEGER NOT NULL DEFAULT 0,
          ordinal INTEGER NOT NULL DEFAULT 0,
          payload_json TEXT NOT NULL DEFAULT '{}',
          total_attempts INTEGER NOT NULL DEFAULT 0 CHECK(total_attempts >= 0),
          stage_attempts INTEGER NOT NULL DEFAULT 0 CHECK(stage_attempts >= 0),
          max_stage_attempts INTEGER NOT NULL DEFAULT 6 CHECK(max_stage_attempts >= 1),
          next_retry_at TEXT,
          lease_owner TEXT,
          lease_token TEXT,
          lease_expires_at TEXT,
          heartbeat_at TEXT,
          raw_sha256 TEXT,
          normalized_sha256 TEXT,
          parser_revision TEXT,
          chunker_revision TEXT,
          embed_model TEXT,
          embed_revision TEXT,
          index_name TEXT,
          namespace TEXT,
          observed_bytes INTEGER NOT NULL DEFAULT 0 CHECK(observed_bytes >= 0),
          observed_tokens INTEGER NOT NULL DEFAULT 0 CHECK(observed_tokens >= 0),
          observed_chunks INTEGER NOT NULL DEFAULT 0 CHECK(observed_chunks >= 0),
          observed_vectors INTEGER NOT NULL DEFAULT 0 CHECK(observed_vectors >= 0),
          observed_write_units INTEGER NOT NULL DEFAULT 0 CHECK(observed_write_units >= 0),
          observed_cost_usd REAL NOT NULL DEFAULT 0 CHECK(observed_cost_usd >= 0),
          verification_json TEXT,
          last_error_type TEXT,
          last_error TEXT,
          last_error_json TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(job_id) REFERENCES sec_ingest_jobs(id) ON DELETE CASCADE,
          UNIQUE(job_id, task_key),
          CHECK(
            (status = 'leased' AND lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
            OR
            (status != 'leased' AND lease_owner IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL)
          ),
          CHECK((status = 'retry_wait' AND next_retry_at IS NOT NULL) OR status != 'retry_wait'),
          CHECK((status = 'complete' AND checkpoint = 'complete') OR status != 'complete'),
          CHECK(checkpoint != 'complete' OR (status = 'complete' AND verification_json IS NOT NULL))
        );

        CREATE TABLE IF NOT EXISTS sec_ingest_task_attempts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id TEXT NOT NULL,
          attempt_no INTEGER NOT NULL CHECK(attempt_no >= 1),
          checkpoint TEXT NOT NULL,
          lease_owner TEXT NOT NULL,
          lease_token TEXT NOT NULL,
          started_at TEXT NOT NULL,
          heartbeat_at TEXT NOT NULL,
          finished_at TEXT,
          outcome TEXT NOT NULL CHECK(outcome IN (
            'claimed', 'advanced', 'retry_wait', 'dead_letter', 'quarantined',
            'superseded', 'lease_expired'
          )),
          error_type TEXT,
          error TEXT,
          receipt_json TEXT,
          FOREIGN KEY(task_id) REFERENCES sec_ingest_tasks(id) ON DELETE CASCADE,
          UNIQUE(task_id, attempt_no),
          UNIQUE(task_id, lease_token)
        );

        -- Shared, cross-process SEC host coordination. Request policy and mutation logic live in
        -- the discovery/limiter module; the durable row belongs in this same SEC/RAG migration so
        -- every consumer coordinates against one host clock/circuit instead of per-process timers.
        CREATE TABLE IF NOT EXISTS sec_request_coordination (
          host TEXT PRIMARY KEY,
          next_allowed_at INTEGER NOT NULL DEFAULT 0,
          paused_until INTEGER NOT NULL DEFAULT 0,
          circuit_open_until INTEGER NOT NULL DEFAULT 0,
          consecutive_failures INTEGER NOT NULL DEFAULT 0,
          reservations INTEGER NOT NULL DEFAULT 0,
          responses INTEGER NOT NULL DEFAULT 0,
          successes INTEGER NOT NULL DEFAULT 0,
          client_errors INTEGER NOT NULL DEFAULT 0,
          rate_limited INTEGER NOT NULL DEFAULT 0,
          server_errors INTEGER NOT NULL DEFAULT 0,
          network_errors INTEGER NOT NULL DEFAULT 0,
          retries INTEGER NOT NULL DEFAULT 0,
          total_wait_ms INTEGER NOT NULL DEFAULT 0,
          last_request_at INTEGER,
          last_response_at INTEGER,
          last_status INTEGER,
          last_429_at INTEGER,
          updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_sec_ingest_jobs_status
          ON sec_ingest_jobs(status, created_at);
        CREATE INDEX IF NOT EXISTS idx_sec_ingest_tasks_claim
          ON sec_ingest_tasks(job_id, status, next_retry_at, lease_expires_at, priority DESC, ordinal ASC);
        CREATE INDEX IF NOT EXISTS idx_sec_ingest_tasks_accession
          ON sec_ingest_tasks(accession, document_name);
        CREATE INDEX IF NOT EXISTS idx_sec_ingest_attempts_task
          ON sec_ingest_task_attempts(task_id, attempt_no);
      `);
    }
  },
  {
    // Account-bound learning: autonomous outcomes from one broker account must not silently enter a
    // sibling account's prompt. Paper-derived rows are candidates until a separate transfer check
    // corroborates them; pre-migration autonomous rows are quarantined as `legacy` because their
    // originating account cannot be reconstructed reliably.
    version: 24,
    name: "learned_context_account_scope",
    up: (database) => {
      const addColumns = (table: "learned_context" | "learned_context_pending") => {
        if (!tableExists(database, table)) return;
        if (!columnExists(database, table, "connected_account_id")) {
          database.exec(`ALTER TABLE ${table} ADD COLUMN connected_account_id TEXT`);
        }
        if (!columnExists(database, table, "account_environment")) {
          database.exec(
            `ALTER TABLE ${table} ADD COLUMN account_environment TEXT CHECK(account_environment IS NULL OR account_environment IN ('paper','live'))`
          );
        }
        if (!columnExists(database, table, "learning_scope")) {
          database.exec(
            `ALTER TABLE ${table} ADD COLUMN learning_scope TEXT NOT NULL DEFAULT 'legacy' CHECK(learning_scope IN ('account','portfolio','research','legacy'))`
          );
        }
        if (!columnExists(database, table, "transfer_state")) {
          database.exec(
            `ALTER TABLE ${table} ADD COLUMN transfer_state TEXT NOT NULL DEFAULT 'not_applicable' CHECK(transfer_state IN ('not_applicable','candidate','validated','rejected'))`
          );
        }
      };

      addColumns("learned_context");
      addColumns("learned_context_pending");

      // User-authored and explicitly ingested context was intentionally account-agnostic before this
      // migration, so retain it as portfolio context. Autonomous rows lack enough provenance to know
      // which account produced them; keep them quarantined as legacy rather than guessing.
      if (tableExists(database, "learned_context")) {
        database.exec(`
          UPDATE learned_context
          SET learning_scope = CASE WHEN origin IN ('chat','ingest') THEN 'portfolio' ELSE 'legacy' END
          WHERE connected_account_id IS NULL;
          CREATE INDEX IF NOT EXISTS idx_learned_context_account_scope
            ON learned_context (user_id, connected_account_id, learning_scope, transfer_state, superseded_by);
        `);
      }

      if (tableExists(database, "learned_context_pending")) {
        database.exec(`
          UPDATE learned_context_pending
          SET learning_scope = CASE WHEN origin IN ('chat','ingest') THEN 'portfolio' ELSE 'legacy' END
          WHERE connected_account_id IS NULL;
          CREATE INDEX IF NOT EXISTS idx_learned_context_pending_account_scope
            ON learned_context_pending (user_id, connected_account_id, learning_scope, status, created_at);
        `);
      }
    }
  },
  {
    // Remove the old user-creatable local simulator. The `broker='test'` adapter remains available
    // only to tests that insert their fixture account after migrations have run; production boot
    // purges any legacy Test Account and its simulated outcomes so they cannot train real decisions.
    version: 25,
    name: "remove_product_test_accounts",
    up: (database) => {
      if (!tableExists(database, "connected_accounts")) return;
      const accounts = database
        .prepare("SELECT id, user_id, account_number FROM connected_accounts WHERE broker = 'test'")
        .all() as Array<{ id: string; user_id: string; account_number: string | null }>;
      for (const account of accounts) {
        if (account.account_number) {
          for (const table of [
            "fill_events",
            "portfolio_snapshots",
            "trade_proposals",
            "synthetic_trailing_stops",
            "broker_protective_stops",
            "position_stop_plans",
            "order_replacements"
          ]) {
            if (tableExists(database, table)) {
              database
                .prepare(`DELETE FROM ${table} WHERE account_number = ? AND user_id = ?`)
                .run(account.account_number, account.user_id);
            }
          }
        }
        for (const table of [
          "account_strategy_state",
          "strategy_runs",
          "skipped_candidate_counterfactuals",
          "counterfactual_learning_watermarks",
          "learning_mutations",
          "audit_events",
          "notification_events",
          "socratic_decisions",
          "learned_context",
          "learned_context_pending"
        ]) {
          if (tableExists(database, table)) {
            database
              .prepare(`DELETE FROM ${table} WHERE connected_account_id = ? AND user_id = ?`)
              .run(account.id, account.user_id);
          }
        }
        database.prepare("DELETE FROM connected_accounts WHERE id = ? AND user_id = ?").run(account.id, account.user_id);
        if (tableExists(database, "settings")) {
          database.prepare("DELETE FROM settings WHERE key = ?").run(`strategy_run_lock:${account.user_id}:${account.id}`);
        }
      }
    }
  },
  {
    // The former $500 value was a product default, not an account-relative risk posture. Convert
    // only that exact legacy default to the new 20%-of-NAV mode. Other dollar values (including a
    // user's explicit $1,000 setting) remain untouched and visible as dollar mode.
    version: 26,
    name: "daily_opening_cap_percent_default",
    up: (database) => {
      const changed = migrateLegacyDailyOpeningCapRows(database);
      if (changed > 0) console.log(`[db] migration 26: moved ${changed} legacy $500 daily cap row(s) to 20% of NAV`);
    }
  },
  {
    // Crash-durable provider dispatch/quota receipts and two-phase vector document commits. New
    // managed vectors are queryable only after their exact local receipt set and provider-side
    // committed metadata both succeed. Legacy occurrence rows retain an explicit legacy state.
    version: 29,
    name: "provider_dispatch_and_vector_commit_receipts",
    up: (database) => {
      if (tableExists(database, "chunk_occurrences")) {
        const addOccurrenceColumn = (name: string, sql: string) => {
          if (!columnExists(database, "chunk_occurrences", name)) database.exec(sql);
        };
        addOccurrenceColumn(
          "tenant_scope",
          "ALTER TABLE chunk_occurrences ADD COLUMN tenant_scope TEXT NOT NULL DEFAULT 'legacy'"
        );
        addOccurrenceColumn(
          "content_version",
          "ALTER TABLE chunk_occurrences ADD COLUMN content_version TEXT NOT NULL DEFAULT 'legacy'"
        );
        addOccurrenceColumn("commit_id", "ALTER TABLE chunk_occurrences ADD COLUMN commit_id TEXT");
        addOccurrenceColumn(
          "receipt_state",
          "ALTER TABLE chunk_occurrences ADD COLUMN receipt_state TEXT NOT NULL DEFAULT 'legacy_committed'"
        );
      }

      database.exec(`
        CREATE TABLE IF NOT EXISTS vector_ingest_commits (
          id TEXT PRIMARY KEY,
          tenant_scope TEXT NOT NULL,
          user_id TEXT NOT NULL,
          source TEXT NOT NULL,
          accession TEXT NOT NULL,
          document_key TEXT NOT NULL,
          content_version TEXT NOT NULL,
          retrieval_metadata_version TEXT NOT NULL DEFAULT 'legacy',
          parser_revision TEXT NOT NULL,
          embed_revision TEXT NOT NULL,
          expected_vectors INTEGER NOT NULL CHECK(expected_vectors >= 0),
          provider_authority TEXT,
          ledger_authority TEXT,
          vector_namespace TEXT NOT NULL DEFAULT 'managed',
          state TEXT NOT NULL CHECK(state IN ('pending','receipts_persisted','committed','aborted')),
          attempt_token TEXT,
          attempt_generation INTEGER NOT NULL DEFAULT 0,
          lease_expires_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          committed_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_vector_ingest_commits_state
          ON vector_ingest_commits (state, updated_at);
        CREATE INDEX IF NOT EXISTS idx_vector_ingest_commits_source
          ON vector_ingest_commits (source, accession, content_version);
        CREATE TABLE IF NOT EXISTS vector_private_namespace_manifests (
          tenant_scope TEXT PRIMARY KEY,
          ledger_authority TEXT NOT NULL,
          provider_authority TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);

      if (tableExists(database, "chunk_occurrences")) {
        database.exec(`
          CREATE INDEX IF NOT EXISTS idx_chunk_occurrences_commit
            ON chunk_occurrences (commit_id, receipt_state);
          CREATE INDEX IF NOT EXISTS idx_chunk_occurrences_tenant
            ON chunk_occurrences (tenant_scope, vector_id);
        `);
      }

      database.exec(`
        CREATE TABLE IF NOT EXISTS provider_dispatch_attempts (
          id TEXT PRIMARY KEY,
          authority_id TEXT NOT NULL,
          provider TEXT NOT NULL,
          operation TEXT NOT NULL,
          credential_ref TEXT NOT NULL,
          user_id TEXT NOT NULL,
          units INTEGER NOT NULL CHECK(units > 0),
          estimated_cost_usd REAL NOT NULL DEFAULT 0 CHECK(estimated_cost_usd >= 0),
          actual_cost_usd REAL,
          status TEXT NOT NULL CHECK(status IN ('reserved','dispatched','succeeded','failed','unknown','cancelled')),
          idempotency_key TEXT,
          outcome_code TEXT,
          created_at TEXT NOT NULL,
          dispatched_at TEXT,
          completed_at TEXT,
          dispatch_owner_token TEXT,
          dispatch_heartbeat_at TEXT,
          dispatch_lease_expires_at TEXT,
          updated_at TEXT NOT NULL,
          UNIQUE(authority_id, idempotency_key)
        );
        CREATE INDEX IF NOT EXISTS idx_provider_dispatch_quota
          ON provider_dispatch_attempts (authority_id, provider, credential_ref, created_at, status);
        CREATE INDEX IF NOT EXISTS idx_provider_dispatch_status
          ON provider_dispatch_attempts (status, updated_at);

        CREATE TABLE IF NOT EXISTS provider_usage_outbox (
          id TEXT PRIMARY KEY,
          attempt_id TEXT NOT NULL UNIQUE,
          provider TEXT NOT NULL,
          operation TEXT NOT NULL,
          credential_ref TEXT NOT NULL,
          user_id TEXT NOT NULL,
          outcome TEXT NOT NULL CHECK(outcome IN ('succeeded','failed','unknown')),
          requests INTEGER NOT NULL DEFAULT 1,
          estimated_cost_usd REAL NOT NULL DEFAULT 0,
          actual_cost_usd REAL,
          occurred_at TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_provider_usage_outbox_created
          ON provider_usage_outbox (created_at, id);

        CREATE TABLE IF NOT EXISTS fmp_transcript_versions (
          version_id TEXT PRIMARY KEY,
          accession TEXT NOT NULL,
          content_sha256 TEXT NOT NULL,
          symbol TEXT NOT NULL,
          fiscal_year INTEGER NOT NULL,
          fiscal_quarter INTEGER NOT NULL,
          call_date TEXT,
          first_content_seen_at TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('observed','indexing','committed','failed')),
          vector_commit_id TEXT,
          chunk_count INTEGER NOT NULL DEFAULT 0,
          observed_at TEXT NOT NULL,
          indexed_at TEXT,
          updated_at TEXT NOT NULL,
          UNIQUE(accession, content_sha256)
        );
        CREATE INDEX IF NOT EXISTS idx_fmp_transcript_versions_accession
          ON fmp_transcript_versions (accession, first_content_seen_at);
        CREATE INDEX IF NOT EXISTS idx_fmp_transcript_versions_state
          ON fmp_transcript_versions (state, updated_at);
      `);
    }
  },
  {
    // Cross-process ownership for deterministic provider vector ids. A fresh attempt can claim a
    // retryable commit only when no live lease exists; every receipt/finalization write is then
    // compare-and-swapped by the opaque token. Provider metadata carries the same token so a stale
    // writer fails closed even if an in-flight upsert completes after ownership changes.
    version: 30,
    name: "vector_commit_attempt_leases",
    up: (database) => {
      if (!tableExists(database, "vector_ingest_commits")) return;
      const addColumn = (name: string, sql: string) => {
        if (!columnExists(database, "vector_ingest_commits", name)) database.exec(sql);
      };
      addColumn("attempt_token", "ALTER TABLE vector_ingest_commits ADD COLUMN attempt_token TEXT");
      addColumn(
        "attempt_generation",
        "ALTER TABLE vector_ingest_commits ADD COLUMN attempt_generation INTEGER NOT NULL DEFAULT 0"
      );
      addColumn("lease_expires_at", "ALTER TABLE vector_ingest_commits ADD COLUMN lease_expires_at TEXT");
      database.exec(`
        CREATE INDEX IF NOT EXISTS idx_vector_ingest_commits_lease
          ON vector_ingest_commits (state, lease_expires_at);
      `);
    }
  },
  {
    // One authoritative committed generation per logical source document. A corrected content,
    // parser, embedding, or point-in-time metadata generation becomes queryable atomically only
    // after its complete receipt set is committed; the prior proven generation remains available
    // until that handoff succeeds.
    version: 31,
    name: "vector_document_active_heads",
    up: (database) => {
      if (tableExists(database, "vector_ingest_commits")) {
        if (!columnExists(database, "vector_ingest_commits", "document_key")) {
          database.exec("ALTER TABLE vector_ingest_commits ADD COLUMN document_key TEXT");
          database.exec("UPDATE vector_ingest_commits SET document_key = accession WHERE document_key IS NULL");
        }
      }
      database.exec(`
        CREATE TABLE IF NOT EXISTS vector_document_heads (
          tenant_scope TEXT NOT NULL,
          source TEXT NOT NULL,
          accession TEXT NOT NULL,
          commit_id TEXT NOT NULL UNIQUE,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (tenant_scope, source, accession)
        );
        CREATE INDEX IF NOT EXISTS idx_vector_document_heads_commit
          ON vector_document_heads (commit_id);

        CREATE TABLE IF NOT EXISTS vector_document_versions (
          commit_id TEXT PRIMARY KEY,
          tenant_scope TEXT NOT NULL,
          source TEXT NOT NULL,
          document_key TEXT NOT NULL,
          valid_from TEXT NOT NULL,
          valid_to TEXT,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_vector_document_versions_lookup
          ON vector_document_versions (tenant_scope, source, document_key, valid_from, valid_to);

        INSERT OR IGNORE INTO vector_document_versions (
          commit_id, tenant_scope, source, document_key, valid_from, valid_to, updated_at
        )
        SELECT c.id, c.tenant_scope, c.source, c.document_key,
               COALESCE(MIN(o.accepted_at), c.committed_at, c.updated_at), NULL, c.updated_at
        FROM vector_ingest_commits c
        LEFT JOIN chunk_occurrences o ON o.commit_id = c.id
        WHERE c.state = 'committed'
        GROUP BY c.id;

        DELETE FROM vector_document_heads;
      `);
      if (tableExists(database, "vector_document_versions")) {
        const documents = database.prepare(`
          SELECT DISTINCT tenant_scope, source, document_key FROM vector_document_versions
        `).all() as Array<{ tenant_scope: string; source: string; document_key: string }>;
        for (const document of documents) {
          const rows = database.prepare(`
            SELECT commit_id, valid_from FROM vector_document_versions
            WHERE tenant_scope = ? AND source = ? AND document_key = ?
            ORDER BY valid_from, commit_id
          `).all(document.tenant_scope, document.source, document.document_key) as Array<{
            commit_id: string;
            valid_from: string;
          }>;
          const updateInterval = database.prepare(`
            UPDATE vector_document_versions SET valid_to = ?, updated_at = ? WHERE commit_id = ?
          `);
          rows.forEach((row, index) => updateInterval.run(rows[index + 1]?.valid_from ?? null, row.valid_from, row.commit_id));
          const active = rows.at(-1);
          if (active) {
            database.prepare(`
              INSERT INTO vector_document_heads (tenant_scope, source, accession, commit_id, updated_at)
              VALUES (?, ?, ?, ?, ?)
            `).run(document.tenant_scope, document.source, document.document_key, active.commit_id, active.valid_from);
          }
        }
      }
    }
  },
  {
    // Persist the hash of every retrieval-significant metadata field so Pinecone metadata cannot
    // independently claim a valid PIT/citation version. Reconciliation anomalies require two
    // matching observations before an active committed head is invalidated.
    version: 32,
    name: "vector_retrieval_metadata_and_reconcile_observations",
    up: (database) => {
      if (tableExists(database, "vector_ingest_commits")) {
        if (!columnExists(database, "vector_ingest_commits", "retrieval_metadata_version")) {
          database.exec(`
            ALTER TABLE vector_ingest_commits
            ADD COLUMN retrieval_metadata_version TEXT NOT NULL DEFAULT 'legacy'
          `);
        }
      }
      database.exec(`
        CREATE TABLE IF NOT EXISTS vector_reconcile_observations (
          commit_id TEXT PRIMARY KEY,
          fingerprint TEXT NOT NULL,
          observation_count INTEGER NOT NULL CHECK(observation_count > 0),
          first_observed_at TEXT NOT NULL,
          last_observed_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS vector_reconcile_orphan_claims (
          commit_id TEXT PRIMARY KEY,
          claim_token TEXT NOT NULL,
          lease_expires_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_vector_reconcile_orphan_claims_lease
          ON vector_reconcile_orphan_claims (lease_expires_at);
      `);

      // Existing committed evidence remains available until a replacement generation is fully
      // written and atomically promoted. Tokenless legacy rows are rejected by the v3 receipt
      // validator and reported for explicit backfill; a schema migration must never create an
      // availability cliff by aborting the only proven copy of the corpus.
    }
  },
  {
    // Provider authority is deliberately nonsecret and nullable for backwards compatibility. It
    // binds a receipt set to the physical provider authority that produced it, while the timeline
    // rebuild repairs old equal-time ordering deterministically.
    version: 33,
    name: "vector_commit_provider_authority_and_deterministic_timeline",
    up: (database) => {
      if (tableExists(database, "vector_ingest_commits")) {
        if (!columnExists(database, "vector_ingest_commits", "provider_authority")) {
          database.exec("ALTER TABLE vector_ingest_commits ADD COLUMN provider_authority TEXT");
        }
      }

      if (tableExists(database, "vector_document_heads")) {
        database.prepare("DELETE FROM vector_document_heads").run();
      }
      if (tableExists(database, "vector_document_versions") && tableExists(database, "vector_ingest_commits")) {
        const documents = database.prepare(`
          SELECT DISTINCT v.tenant_scope, v.source, v.document_key
          FROM vector_document_versions v
          JOIN vector_ingest_commits c ON c.id = v.commit_id AND c.state = 'committed'
        `).all() as Array<{ tenant_scope: string; source: string; document_key: string }>;
        const updateInterval = database.prepare(`
          UPDATE vector_document_versions SET valid_to = ?, updated_at = ? WHERE commit_id = ?
        `);
        const insertHead = database.prepare(`
          INSERT INTO vector_document_heads (tenant_scope, source, accession, commit_id, updated_at)
          VALUES (?, ?, ?, ?, ?)
        `);
        for (const document of documents) {
          const rows = database.prepare(`
            SELECT v.commit_id, v.valid_from, c.committed_at
            FROM vector_document_versions v
            JOIN vector_ingest_commits c ON c.id = v.commit_id AND c.state = 'committed'
            WHERE v.tenant_scope = ? AND v.source = ? AND v.document_key = ?
            ORDER BY v.valid_from, c.committed_at, v.commit_id
          `).all(document.tenant_scope, document.source, document.document_key) as Array<{
            commit_id: string;
            valid_from: string;
            committed_at: string | null;
          }>;
          rows.forEach((row, index) => {
            updateInterval.run(rows[index + 1]?.valid_from ?? null, row.committed_at ?? row.valid_from, row.commit_id);
          });
          const active = rows.at(-1);
          if (active) {
            insertHead.run(
              document.tenant_scope,
              document.source,
              document.document_key,
              active.commit_id,
              active.committed_at ?? active.valid_from
            );
          }
        }
      }
    }
  },
  {
    // Bind each managed commit to the immutable local ledger whose namespace and vector-id prefix
    // own it. Nullable legacy rows remain quarantined/read-only until explicitly backfilled; they
    // must never be silently claimed by a newly minted ledger authority.
    version: 34,
    name: "vector_commit_ledger_authority",
    up: (database) => {
      if (tableExists(database, "vector_ingest_commits")) {
        if (!columnExists(database, "vector_ingest_commits", "ledger_authority")) {
          database.exec("ALTER TABLE vector_ingest_commits ADD COLUMN ledger_authority TEXT");
        }
      }
    }
  },
  {
    // Persist the exact provider namespace class for each commit and every direct-private tenant.
    // This makes rights/account erasure independent of an eventually-consistent provider list and
    // prevents a missing global setting from silently rotating away from historical namespaces.
    version: 35,
    name: "vector_namespace_manifests",
    up: (database) => {
      if (tableExists(database, "vector_ingest_commits")) {
        if (!columnExists(database, "vector_ingest_commits", "vector_namespace")) {
          database.exec("ALTER TABLE vector_ingest_commits ADD COLUMN vector_namespace TEXT NOT NULL DEFAULT 'managed'");
        }
      }
      database.exec(`
        CREATE TABLE IF NOT EXISTS vector_private_namespace_manifests (
          tenant_scope TEXT PRIMARY KEY,
          ledger_authority TEXT NOT NULL,
          provider_authority TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `);
    }
  },
  {
    // A non-PII subject tombstone is the database-level authority for account deletion. Runtime
    // guards improve diagnostics, but these triggers keep an uninstrumented/stale handler from
    // recreating user rows after deletion completes.
    version: 36,
    name: "account_write_fence_tombstones",
    up: (database) => {
      database.exec(`
        CREATE TABLE IF NOT EXISTS account_write_fences (
          subject_token TEXT PRIMARY KEY,
          generation TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('prepared','completed')),
          updated_at TEXT NOT NULL
        );
      `);

      if (tableExists(database, "settings")) {
        database.exec(`
          INSERT OR IGNORE INTO account_write_fences (subject_token, generation, status, updated_at)
          SELECT
            substr(key, length('account_write_epoch:') + 1),
            json_extract(value, '$.generation'),
            json_extract(value, '$.status'),
            COALESCE(json_extract(value, '$.updatedAt'), updated_at)
          FROM settings
          WHERE key LIKE 'account_write_epoch:%'
            AND json_valid(value) = 1
            AND json_type(value, '$.generation') = 'text'
            AND json_extract(value, '$.status') IN ('prepared','completed');
        `);
      }

      database.exec(`
        CREATE INDEX IF NOT EXISTS idx_account_write_fences_status
          ON account_write_fences (status, updated_at);
      `);
    }
  },
  {
    // Durable owner generations distinguish a live slow provider call from a process that died
    // after crossing the network boundary. Expiry records unknown billing truth, but remains an
    // account-deletion blocker until an operator attests the old process is gone.
    version: 37,
    name: "provider_dispatch_owner_leases",
    up: (database) => {
      if (!tableExists(database, "provider_dispatch_attempts")) return;
      if (!columnExists(database, "provider_dispatch_attempts", "dispatch_owner_token")) {
        database.exec("ALTER TABLE provider_dispatch_attempts ADD COLUMN dispatch_owner_token TEXT");
      }
      if (!columnExists(database, "provider_dispatch_attempts", "dispatch_heartbeat_at")) {
        database.exec("ALTER TABLE provider_dispatch_attempts ADD COLUMN dispatch_heartbeat_at TEXT");
      }
      if (!columnExists(database, "provider_dispatch_attempts", "dispatch_lease_expires_at")) {
        database.exec("ALTER TABLE provider_dispatch_attempts ADD COLUMN dispatch_lease_expires_at TEXT");
      }
      database.exec(`
        UPDATE provider_dispatch_attempts
        SET dispatch_owner_token = COALESCE(dispatch_owner_token, 'legacy-unleased:' || id),
            dispatch_heartbeat_at = COALESCE(dispatch_heartbeat_at, dispatched_at, updated_at),
            dispatch_lease_expires_at = COALESCE(
              dispatch_lease_expires_at,
              strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+15 minutes')
            )
        WHERE status = 'dispatched' AND dispatched_at IS NOT NULL;

        CREATE INDEX IF NOT EXISTS idx_provider_dispatch_lease
          ON provider_dispatch_attempts (status, dispatch_lease_expires_at);
      `);
    }
  },
  {
    // A private namespace lives in one physical Pinecone index. Persist that authority so an API
    // key/project rotation cannot make account deletion erase local evidence while leaving the old
    // project's private vectors unreachable.
    version: 38,
    name: "private_vector_provider_authority",
    up: (database) => {
      if (!tableExists(database, "vector_private_namespace_manifests")) return;
      if (!columnExists(database, "vector_private_namespace_manifests", "provider_authority")) {
        database.exec("ALTER TABLE vector_private_namespace_manifests ADD COLUMN provider_authority TEXT");
      }
      database.exec(`
        CREATE INDEX IF NOT EXISTS idx_private_vector_manifest_provider
          ON vector_private_namespace_manifests (provider_authority, ledger_authority)
      `);
    }
  },
  {
    // Re-created accounts receive a new opaque user-id generation. The prior generation's
    // completed fence is permanent, so stale cookies/mobile tokens can never gain access to the
    // new account merely because one newer session signed in.
    version: 39,
    name: "account_identity_generations",
    up: (database) => {
      database.exec(`
        CREATE TABLE IF NOT EXISTS account_identity_generations (
          base_subject_token TEXT PRIMARY KEY,
          current_user_id TEXT NOT NULL,
          generation INTEGER NOT NULL CHECK(generation >= 0),
          status TEXT NOT NULL CHECK(status IN ('active','deleted')),
          session_cutoff_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_account_identity_current_user
          ON account_identity_generations (current_user_id);
      `);
    }
  },
  {
    // Persist the exact Green Team text and deterministic sizing arithmetic carried by each
    // Socratic case. This migration is deliberately schema-only: by the time a database is stamped
    // v26, a fixed $500 cap may be an intentional user choice and must never be reinterpreted.
    version: 27,
    name: "socratic_decision_narrative_receipts",
    up: (database) => {
      if (!tableExists(database, "socratic_decisions")) return;
      if (!columnExists(database, "socratic_decisions", "green_team_rationale")) {
        database.exec("ALTER TABLE socratic_decisions ADD COLUMN green_team_rationale TEXT");
      }
      if (!columnExists(database, "socratic_decisions", "sizing_snapshot")) {
        database.exec("ALTER TABLE socratic_decisions ADD COLUMN sizing_snapshot TEXT");
      }
    }
  },
  {
    // Replacement dedupe is tenant-scoped. Migration v21/v22 created an unscoped partial UNIQUE
    // index, so replace it in place after collapsing any same-user duplicates that may predate the
    // corrected key. Cross-user rows with the same broker account/order remain valid.
    version: 28,
    name: "order_replacements_user_scoped_active_unique",
    up: (database) => {
      const tableExists = database
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'order_replacements'")
        .get();
      if (!tableExists) return;

      const dupGroups = database
        .prepare(
          `WITH ranked AS (
             SELECT rowid, user_id, account_number, original_order_id,
                    ROW_NUMBER() OVER (
                      PARTITION BY user_id, account_number, original_order_id
                      ORDER BY
                        CASE status
                          WHEN 'replacement_submitted' THEN 1
                          WHEN 'replacement_claiming' THEN 2
                          WHEN 'cancel_confirmed' THEN 3
                          WHEN 'cancel_requested' THEN 4
                          ELSE 5
                        END ASC,
                        CASE WHEN replacement_order_id IS NOT NULL THEN 0 ELSE 1 END ASC,
                        rowid DESC
                    ) AS rn
             FROM order_replacements
             WHERE status NOT IN ('replacement_confirmed', 'failed', 'aborted')
           )
           SELECT user_id, account_number, original_order_id,
                  MAX(CASE WHEN rn = 1 THEN rowid END) AS keep_rowid
           FROM ranked
           GROUP BY user_id, account_number, original_order_id
           HAVING COUNT(*) > 1`
        )
        .all() as Array<{ user_id: string; account_number: string; original_order_id: string; keep_rowid: number }>;
      const terminalizeExtras = database.prepare(
        `UPDATE order_replacements
         SET status = 'failed', error = 'superseded by duplicate active replacement', updated_at = ?
         WHERE user_id = ? AND account_number = ? AND original_order_id = ? AND rowid != ?
         AND status NOT IN ('replacement_confirmed', 'failed', 'aborted')`
      );
      const now = new Date().toISOString();
      for (const group of dupGroups) {
        terminalizeExtras.run(now, group.user_id, group.account_number, group.original_order_id, group.keep_rowid);
      }

      database.exec("DROP INDEX IF EXISTS idx_order_replacements_active_unique");
      database.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_order_replacements_active_unique ON order_replacements (user_id, account_number, original_order_id) WHERE status NOT IN ('replacement_confirmed', 'failed', 'aborted')"
      );
    }
  },
  {
    // The old broker-minimum cooldown key omitted user ownership
    // (`subMinimumOrderAlertSent:<account>:<symbol>`). It cannot be assigned safely when broker
    // account identifiers collide across users, and it only suppresses a repeat notification for
    // 24 hours, so clear all pre-user-scope rows once at rollout. New writes use the user-first key
    // and are fenced/erased by accountSettingMatchesSubject.
    version: 40,
    name: "purge_legacy_broker_minimum_alert_cooldowns",
    up: (database) => {
      if (!tableExists(database, "settings")) return;
      database.prepare("DELETE FROM settings WHERE key LIKE 'subMinimumOrderAlertSent:%'").run();
    }
  },
  {
    // Install licensed-transcript provenance/provider receipts in the versioned schema so account
    // deletion coverage and the generic user write-fence triggers can see them at boot. The
    // producer retains a defensive idempotent ensure for isolated/legacy databases.
    version: 41,
    name: "fmp_transcript_derived_rights_receipts",
    up: (database) => {
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
          completed_at TEXT,
          lease_expires_at TEXT,
          terminal_outcome TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_fmp_transcript_derived_artifacts_type
          ON fmp_transcript_derived_artifacts (artifact_type, artifact_id);
        CREATE INDEX IF NOT EXISTS idx_fmp_transcript_derived_provider_work_status
          ON fmp_transcript_derived_provider_work (status, created_at);
      `);
      if (tableExists(database, "fmp_transcript_derived_provider_work")) {
        for (const column of [
          ["user_id", "TEXT"],
          ["vector_id", "TEXT"],
          ["provider_authority", "TEXT"],
          ["ledger_authority", "TEXT"],
          ["lease_expires_at", "TEXT"],
          ["terminal_outcome", "TEXT"]
        ] as const) {
          if (!columnExists(database, "fmp_transcript_derived_provider_work", column[0])) {
            database.exec(
              `ALTER TABLE fmp_transcript_derived_provider_work ADD COLUMN ${column[0]} ${column[1]}`
            );
          }
        }
      }
      database.exec(`
        CREATE INDEX IF NOT EXISTS idx_fmp_transcript_derived_provider_work_lease
          ON fmp_transcript_derived_provider_work (status, lease_expires_at)
      `);
    }
  },
  {
    // Tracks a bracket order's ID (Alpaca native/order_class bracket, Tradier OTOCO) so a later
    // plan change away from fixed/atr can find and tear down that earlier opening's still-resting
    // sibling legs — see pending_bracket_teardowns' own comment above CREATE TABLE. Idempotent
    // (fresh DBs get both from CREATE TABLE).
    version: 42,
    name: "bracket_sibling_leg_teardown",
    up: (database) => {
      // Guard existence first (mirrors the chunk_occurrences/order_replacements migrations above) —
      // position_stop_plans is created by the main schema's CREATE TABLE, not by a numbered
      // migration, so a migration-only test harness that replays versions from an arbitrary
      // baseline against a minimal hand-built schema may not have it yet.
      if (tableExists(database, "position_stop_plans")) {
        if (!columnExists(database, "position_stop_plans", "opening_order_id")) {
          database.exec("ALTER TABLE position_stop_plans ADD COLUMN opening_order_id TEXT");
        }
      }
      database.exec(`
        CREATE TABLE IF NOT EXISTS pending_bracket_teardowns (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          account_number TEXT NOT NULL,
          symbol TEXT NOT NULL,
          order_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_pending_bracket_teardowns_account
          ON pending_bracket_teardowns(user_id, account_number);
      `);
    }
  },
  {
    // Handoff 3.5 (forward economic-event awareness): small rolling cache of upcoming
    // high-impact US economic-calendar events (FMP /economic-calendar via fmp-gamma).
    // Refreshed at most once per UTC day by src/lib/economic-calendar.ts (persisted
    // watermark in internal settings); CRUD in db-economic-events.ts. Shared market
    // data, not per-user state — no user_id column by design.
    version: 43,
    name: "economic_events",
    up: (database) => {
      database.exec(`
        CREATE TABLE IF NOT EXISTS economic_events (
          id TEXT PRIMARY KEY,
          event TEXT NOT NULL,
          event_date TEXT NOT NULL,
          country TEXT NOT NULL,
          impact TEXT,
          estimate REAL,
          previous REAL,
          fetched_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_economic_events_event_date
          ON economic_events (event_date);
      `);
    }
  },
  {
    // Handoff 6b.7 (trading-liveness health dimension): /api/health and the ops snapshot need,
    // per active-autonomy account, the age of the most recent COMPLETED strategy_runs row and a
    // consecutive-failed-runs count (src/lib/trading-liveness.ts). No new table — this only speeds
    // up the (user_id, connected_account_id, status, started_at DESC) scan that computation runs on
    // every /api/health hit, which previously had no covering index.
    version: 44,
    name: "strategy_runs_liveness_index",
    up: (database) => {
      // Defensive: some migration-regression tests build a minimal synthetic schema (just the
      // table(s) the specific historical migration under test needs) and then run every migration
      // from that point forward, including this one — strategy_runs won't exist there. Matches the
      // guard pattern at migration v28 (order_replacements_user_scoped_active_unique) above.
      const tableExists = database
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'strategy_runs'")
        .get();
      if (!tableExists) return;
      database.exec(`
        CREATE INDEX IF NOT EXISTS idx_strategy_runs_liveness
          ON strategy_runs (user_id, connected_account_id, status, started_at DESC);
      `);
    }
  },
  {
    // Handoff 4.1 (retrieval-usefulness join): close the self-measurement loop on episodic/RAG
    // retrieval spend. Every run already persists WHICH vector ids entered its prompts (the
    // `experience_retrieval` audit event in strategy.ts plus ragAttributions on socratic_decisions
    // rows) explicitly so usefulness scoring could join later — this migration adds the tables that
    // join writes into. `retrieval_usefulness_stats` holds per-(docType, memoryKind[, docId],
    // horizon) outcome aggregates credited by the scheduled incremental join
    // (src/lib/retrieval-usefulness.ts); `retrieval_usefulness_credited` is the per-decision ledger
    // that makes the join idempotent across passes (a case is credited exactly once, no matter how
    // often its row is later re-written by lessons/coach notes). CRUD lives in
    // db-retrieval-usefulness.ts. Advisory only: stats feed a bounded ranking nudge at retrieval
    // time — they never gate, exclude, or fail retrieval.
    version: 45,
    name: "retrieval_usefulness",
    up: (database) => {
      database.exec(`
        CREATE TABLE IF NOT EXISTS retrieval_usefulness_stats (
          user_id TEXT NOT NULL,
          doc_type TEXT NOT NULL,
          memory_kind TEXT NOT NULL,
          doc_id TEXT NOT NULL DEFAULT '',
          horizon TEXT NOT NULL,
          samples INTEGER NOT NULL DEFAULT 0,
          wins INTEGER NOT NULL DEFAULT 0,
          losses INTEGER NOT NULL DEFAULT 0,
          return_pct_sum REAL NOT NULL DEFAULT 0,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (user_id, doc_type, memory_kind, doc_id, horizon)
        );
        CREATE TABLE IF NOT EXISTS retrieval_usefulness_credited (
          user_id TEXT NOT NULL,
          decision_id TEXT NOT NULL,
          credited_at TEXT NOT NULL,
          PRIMARY KEY (user_id, decision_id)
        );
      `);
    }
  },
  {
    // Renumbered 43 -> 46 on merge (2026-07-16): main's economic_events/strategy_runs_liveness_index/
    // retrieval_usefulness already claimed 43/44/45 by the time this PR (#1667) merged. See
    // position_stop_plan_open_brackets' own comment above CREATE TABLE (adversarial review of PR
    // #1661/#1667, 2026-07-16, Codex P1): a single opening_order_id scalar can't represent multiple
    // concurrent brackets from same-style scale-ins, each still protecting its OWN lot.
    version: 46,
    name: "position_stop_plan_open_brackets",
    up: (database) => {
      database.exec(`
        CREATE TABLE IF NOT EXISTS position_stop_plan_open_brackets (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          account_number TEXT NOT NULL,
          symbol TEXT NOT NULL,
          order_id TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_position_stop_plan_open_brackets_symbol
          ON position_stop_plan_open_brackets(user_id, account_number, symbol);
      `);
      // Backfill: any position_stop_plans row already sitting at fixed/atr with a tracked
      // opening_order_id (recorded under the OLD single-scalar design, before this table existed —
      // e.g. a row written by PR #1661 in the window before this migration landed) has NO row here
      // yet. Without backfilling it, the FIRST later transition away from fixed/atr for that symbol
      // finds nothing in this new table, enqueues no teardown at all, and the upsert overwrites
      // opening_order_id with null — permanently losing the only reference to that bracket, and its
      // legs rest on the broker forever with no path back to them (Codex review, PR #1667).
      if (tableExists(database, "position_stop_plans")) {
        if (columnExists(database, "position_stop_plans", "opening_order_id")) {
          const legacyRows = database
            .prepare(
              `SELECT user_id, account_number, symbol, opening_order_id FROM position_stop_plans
               WHERE style IN ('fixed', 'atr') AND opening_order_id IS NOT NULL AND opening_order_id != ''`
            )
            .all() as Array<{ user_id: string; account_number: string; symbol: string; opening_order_id: string }>;
          const insertBackfill = database.prepare(
            `INSERT INTO position_stop_plan_open_brackets (id, user_id, account_number, symbol, order_id, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`
          );
          const now = new Date().toISOString();
          for (const row of legacyRows) {
            insertBackfill.run(crypto.randomUUID(), row.user_id, row.account_number, row.symbol, row.opening_order_id, now);
          }
        }
      }
    }
  },
  {
    version: 47,
    name: "sec_facts_and_transactions",
    up: (database) => {
      database.exec(`
        CREATE TABLE IF NOT EXISTS sec_facts (
          id TEXT PRIMARY KEY,
          cik TEXT NOT NULL,
          accession TEXT NOT NULL,
          concept TEXT NOT NULL,
          value REAL NOT NULL,
          unit TEXT,
          period TEXT,
          start_date TEXT,
          end_date TEXT NOT NULL,
          accepted_at TEXT NOT NULL,
          segment TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_sec_facts_cik_concept ON sec_facts(cik, concept);

        CREATE TABLE IF NOT EXISTS sec_insider_transactions (
          id TEXT PRIMARY KEY,
          cik TEXT NOT NULL,
          accession TEXT NOT NULL,
          insider_name TEXT NOT NULL,
          relationship TEXT NOT NULL,
          side TEXT NOT NULL,
          shares REAL NOT NULL,
          price REAL NOT NULL,
          period_of_report TEXT NOT NULL,
          is_10b5_1 INTEGER NOT NULL DEFAULT 0,
          transaction_code TEXT NOT NULL DEFAULT ''
        );
        CREATE INDEX IF NOT EXISTS idx_sec_insider_transactions_cik ON sec_insider_transactions(cik);
      `);
    }
  },
  {
    version: 48,
    name: "sec_eval_golden_set",
    up: (database) => {
      database.exec(`
        CREATE TABLE IF NOT EXISTS sec_eval_golden_set (
          id TEXT PRIMARY KEY,
          query TEXT NOT NULL,
          expected_cik TEXT NOT NULL,
          expected_accession TEXT NOT NULL,
          expected_text_snippet TEXT NOT NULL,
          category TEXT NOT NULL
        );
      `);
    }
  },
  {
    version: 49,
    name: "document_chunks_fts",
    up: (database) => {
      database.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS document_chunks_fts USING fts5(
          content_hash,
          symbol,
          source,
          accession,
          text
        );
      `);
    }
  },
  {
    version: 50,
    name: "sec_insider_transactions_transaction_code",
    up: (database) => {
      // A legacy v47 database may have advanced past the migration without
      // creating this table. Recover it before inspecting or altering columns.
      database.exec(`
        CREATE TABLE IF NOT EXISTS sec_insider_transactions (
          id TEXT PRIMARY KEY,
          cik TEXT NOT NULL,
          accession TEXT NOT NULL,
          insider_name TEXT NOT NULL,
          relationship TEXT NOT NULL,
          side TEXT NOT NULL,
          shares REAL NOT NULL,
          price REAL NOT NULL,
          period_of_report TEXT NOT NULL,
          is_10b5_1 INTEGER NOT NULL DEFAULT 0,
          transaction_code TEXT NOT NULL DEFAULT ''
        );
      `);
      // v47's CREATE TABLE now includes transaction_code for fresh databases; this backfills any
      // database that ran the original v47 before the column existed (PR #1669 review: insider
      // rows must preserve the SEC transaction code so P/S open-market trades are distinguishable
      // from grants/exercises/gifts). Guarded because ADD COLUMN fails if the column exists.
      if (!columnExists(database, "sec_insider_transactions", "transaction_code")) {
        database.exec("ALTER TABLE sec_insider_transactions ADD COLUMN transaction_code TEXT NOT NULL DEFAULT ''");
      }
    }
  },
  {
    // EarningsCalls.dev fetch-once-forever transcript cache (CRUD in db-earningscalls.ts;
    // producer in earningscalls-transcripts.ts). GLOBAL market data — no user_id column,
    // deliberately exempt from DELETE_TABLES_BY_USER_ID (transcripts are public-company
    // material shared across users, like economic_events). `content` NULL = negative-cache
    // row: a budget-costing call found no transcript yet; re-fetch allowed only after the
    // negative TTL. A row with content is immutable — a cache hit NEVER re-fetches.
    // NOTE (2026-07-17 merge): renumbered 50 -> 51 — branch's sec_insider_transactions_transaction_code took v50.
    version: 51,
    name: "earningscalls_transcripts",
    up: (database) => {
      database.exec(`
        CREATE TABLE IF NOT EXISTS earningscalls_transcripts (
          symbol TEXT NOT NULL,
          fiscal_year INTEGER NOT NULL,
          fiscal_quarter INTEGER NOT NULL,
          event_id INTEGER,
          event_date TEXT,
          content TEXT,
          fetched_at TEXT NOT NULL,
          source_meta TEXT,
          ingested_at TEXT,
          PRIMARY KEY (symbol, fiscal_year, fiscal_quarter)
        );
        CREATE INDEX IF NOT EXISTS idx_earningscalls_transcripts_ingest
          ON earningscalls_transcripts (ingested_at, fetched_at);
        CREATE TABLE IF NOT EXISTS earningscalls_symbol_checks (
          symbol TEXT PRIMARY KEY,
          checked_at TEXT NOT NULL,
          latest_event_id INTEGER,
          latest_event_date TEXT
        );
      `);
    }
  },
  {
    version: 52,
    name: "sec_rag_tables_recovery",
    up: (database) => {
      database.exec(`
        -- Backfill/recovery for databases which skipped version 47 due to migration collision
        CREATE TABLE IF NOT EXISTS sec_facts (
          id TEXT PRIMARY KEY,
          cik TEXT NOT NULL,
          accession TEXT NOT NULL,
          concept TEXT NOT NULL,
          value REAL NOT NULL,
          unit TEXT,
          period TEXT,
          start_date TEXT,
          end_date TEXT NOT NULL,
          accepted_at TEXT NOT NULL,
          segment TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_sec_facts_cik_concept ON sec_facts(cik, concept);

        CREATE TABLE IF NOT EXISTS sec_insider_transactions (
          id TEXT PRIMARY KEY,
          cik TEXT NOT NULL,
          accession TEXT NOT NULL,
          insider_name TEXT NOT NULL,
          relationship TEXT NOT NULL,
          side TEXT NOT NULL,
          shares REAL NOT NULL,
          price REAL NOT NULL,
          period_of_report TEXT NOT NULL,
          is_10b5_1 INTEGER NOT NULL DEFAULT 0,
          transaction_code TEXT NOT NULL DEFAULT ''
        );
        CREATE INDEX IF NOT EXISTS idx_sec_insider_transactions_cik ON sec_insider_transactions(cik);
      `);
    }
  },
  {
    // Durable pre-network intent for broker protective-stop placement (CRUD in db-api-keys.ts,
    // alongside broker_protective_stops). reconcileBrokerProtectiveStops previously called
    // gateway.placeEquityOrder with no persisted state beforehand — if the broker accepted the order
    // but the reply was lost (crash/timeout), a retry had no record a request was ever sent and could
    // place a SECOND full-size stop. A row here is written BEFORE the network call, keyed by the
    // stable client_order_id submitted, and deleted on every definite outcome (rejected/no-id/
    // success); a call that THROWS deliberately leaves the row so the next tick can look its
    // client_order_id up in the broker's own order list and adopt the order it already placed instead
    // of duplicating it. One row per (user, account, symbol) — a fresh placement attempt replaces any
    // stale row for that symbol.
    // NOTE (numbering): resolved at the 2026-07-18 merge of origin/main — v52 (sec_rag_tables_recovery,
    // PR #1735) is on main; this branch takes v53/v54 after it.
    version: 53,
    name: "broker_stop_placement_intents",
    up: (database) => {
      database.exec(`
        CREATE TABLE IF NOT EXISTS broker_stop_placement_intents (
          user_id TEXT NOT NULL,
          account_number TEXT NOT NULL,
          symbol TEXT NOT NULL,
          client_order_id TEXT NOT NULL,
          quantity REAL NOT NULL,
          stop_price REAL NOT NULL,
          kind TEXT NOT NULL,
          trail_percent REAL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (user_id, account_number, symbol)
        );
      `);
    }
  },
  {
    // A recovered/booked broker-held stop fill (bookBrokerHeldStopFill in broker-protective-stops.ts)
    // never sets proposal_id, so migration 16's partial UNIQUE index on (proposal_id, broker_order_id)
    // — which requires proposal_id NOT NULL — never covers it. Add a second partial UNIQUE index for
    // exactly that recovery path: (user_id, account_number, broker_order_id) WHERE proposal_id IS
    // NULL AND broker_order_id IS NOT NULL AND raw carries bookBrokerHeldStopFill's own
    // `brokerHeldProtectiveStop: true` marker. insertFillEvent treats a violation the same way it
    // already treats the proposal_id-scoped one: an idempotent no-op returning the already-booked
    // fill. Existing duplicates (if any) are collapsed first, same approach as migration 16.
    //
    // Scoped to that ONE marker deliberately, not every proposal-less fill: order-replacement.ts's
    // reconciliation intentionally books multiple proposal-less rows that can share the SAME
    // broker_order_id across different (user, account) scopes and even, by its own test coverage
    // ("does not let another tenant/account fill with the same broker order id suppress recovery"),
    // within the same (user, account) for a DIFFERENT replacement — it keys its own idempotency off
    // `raw.replacementRefId`, not the broker id, because broker order ids are not assumed globally
    // unique there. A broad (user_id, account_number, broker_order_id) index across ALL proposal-less
    // fills would silently collide with that design and drop a legitimate second fill.
    version: 54,
    name: "fill_events_no_proposal_broker_order_unique_index",
    up: (database) => {
      // Every real boot runs migrate()'s idempotent baseline (which creates fill_events,
      // and a later baseline ALTER adds its user_id column) before applyVersionedMigrations
      // ever runs, so fill_events always exists here in production/dev. The one exception is
      // test/persistence-hardening.test.ts, which hand-rolls a minimal fixture schema and
      // calls applyVersionedMigrations directly to exercise older migrations in isolation —
      // it never creates fill_events because it doesn't exercise this migration's table. Skip
      // rather than fabricate the table here: the baseline is the single source of truth for
      // fill_events' real-world schema (including columns added by other migrations), and
      // duplicating it here risks drifting from that truth.
      const fillEventsExists = database
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'fill_events'`)
        .get();
      if (!fillEventsExists) return;
      const dupGroups = database
        .prepare(
          `SELECT user_id, account_number, broker_order_id, COUNT(*) AS c, MIN(rowid) AS keep_rowid
           FROM fill_events
           WHERE proposal_id IS NULL AND broker_order_id IS NOT NULL
             AND json_extract(raw, '$.brokerHeldProtectiveStop') = 1
           GROUP BY user_id, account_number, broker_order_id
           HAVING c > 1`
        )
        .all() as Array<{ user_id: string; account_number: string; broker_order_id: string; c: number; keep_rowid: number }>;
      const deleteExtras = database.prepare(
        `DELETE FROM fill_events
         WHERE user_id = ? AND account_number = ? AND broker_order_id = ? AND proposal_id IS NULL
           AND json_extract(raw, '$.brokerHeldProtectiveStop') = 1 AND rowid != ?`
      );
      for (const g of dupGroups) {
        const info = deleteExtras.run(g.user_id, g.account_number, g.broker_order_id, g.keep_rowid);
        console.warn(
          `[db] migration 54: collapsed ${info.changes} duplicate broker-held-stop-recovery fill_events row(s) for (user_id=${g.user_id}, account_number=${g.account_number}, broker_order_id=${g.broker_order_id}) — kept rowid ${g.keep_rowid}.`
        );
      }
      database.exec(
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_fill_events_no_proposal_broker_order
         ON fill_events (user_id, account_number, broker_order_id)
         WHERE proposal_id IS NULL AND broker_order_id IS NOT NULL
           AND json_extract(raw, '$.brokerHeldProtectiveStop') = 1`
      );
    }
  },
  {
    // Append-only archive for coach notes aged off the live `socratic_decisions.coach_notes`
    // window (kept at COACH_NOTES_LIVE_CAP entries in db-socratic.ts). Before this migration, the
    // 21st note appended to a decision silently deleted the 1st with zero trace. `note_seq` is a
    // dense 0-based per-(user, decision) archive ordinal — an ordering/uniqueness device, not an
    // all-time index (pre-port history is unrecoverable). See db-socratic.ts applyCoachNoteAppend.
    // NOTE (numbering): renumbered from branch v53->v55 when merging origin/main (which claimed
    // v53 broker_stop_placement_intents and v54 fill_events_no_proposal_broker_order_unique_index).
    version: 55,
    name: "socratic_coach_note_archive",
    up: (database) => {
      database.exec(`
        CREATE TABLE IF NOT EXISTS socratic_coach_note_archive (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          decision_id TEXT NOT NULL,
          connected_account_id TEXT,
          note TEXT NOT NULL,
          note_seq INTEGER NOT NULL,
          archived_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_socratic_coach_note_archive_user_decision
          ON socratic_coach_note_archive (user_id, decision_id, note_seq);
      `);
    }
  },
  {
    // NOTE: renumbered to v56 so main's v55 socratic_coach_note_archive stays intact.
    version: 56,
    name: "document_abstracts",
    up: (database) => {
      database.exec(`
        CREATE TABLE IF NOT EXISTS document_abstracts (
          id TEXT PRIMARY KEY,
          source_type TEXT NOT NULL,
          ticker TEXT NOT NULL,
          accession_or_event_id TEXT NOT NULL,
          headline TEXT NOT NULL,
          summary_text TEXT NOT NULL,
          guidance_json TEXT,
          drivers_json TEXT,
          risks_json TEXT,
          source_chunk_ids TEXT NOT NULL,
          created_at TEXT NOT NULL,
          model_used TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_document_abstracts_ticker ON document_abstracts (ticker, source_type);
        CREATE INDEX IF NOT EXISTS idx_document_abstracts_accession ON document_abstracts (accession_or_event_id);
      `);
    }
  },
  {
    // EarningsCalls.dev (symbol, fiscal_year, fiscal_quarter) -> provider earnings-call id map
    // (burst/smart-daily program, docs/rollouts/2026-07-19-earningscalls-burst-smart-daily.md).
    // Populated by the id-resolution engine (GET /transcripts/recent listing pages + GET
    // /companies/ticker/{t} full call history), independent of whether a transcript was ever
    // FETCHED for that period. This is deliberately a SEPARATE table from
    // earningscalls_transcripts: a row here means "the provider told us this call's id exists",
    // not "we have (or tried to fetch) its content" — overloading the transcripts table's
    // content-NULL negative-cache semantics for this would incorrectly TTL-gate a plain id
    // lookup (recon memo finding). GLOBAL market data, no user_id column, same class as
    // earningscalls_transcripts/economic_events.
    // NOTE (numbering): renumbered to v57 after main's v56 document_abstracts (#1792 merge).
    version: 57,
    name: "earningscalls_event_index",
    up: (database) => {
      database.exec(`
        CREATE TABLE IF NOT EXISTS earningscalls_event_index (
          symbol TEXT NOT NULL,
          fiscal_year INTEGER NOT NULL,
          fiscal_quarter INTEGER NOT NULL,
          event_id INTEGER NOT NULL,
          event_date TEXT,
          source TEXT NOT NULL,
          discovered_at TEXT NOT NULL,
          PRIMARY KEY (symbol, fiscal_year, fiscal_quarter)
        );
        CREATE INDEX IF NOT EXISTS idx_earningscalls_event_index_symbol
          ON earningscalls_event_index (symbol, fiscal_year DESC, fiscal_quarter DESC);
      `);
    }
  },
  {
    // ONE-SHOT owner-directed burst arm (docs/rollouts/2026-07-19-earningscalls-burst-smart-daily.md):
    // seed earningscalls_burst_pending=25 so the scheduler's NEXT daily EarningsCalls pass runs the
    // 25-transcript burst automatically post-deploy (entitlement-probe-gated: a preview-blocked
    // detection refuses it same as any other pass; idempotent consume — the pass zeroes this
    // counter before doing any work, so it can never re-arm itself). INSERT OR IGNORE is what makes
    // this a genuine one-shot: it only takes effect on a database that has NEVER had this settings
    // row before (a fresh deploy), never overwriting a later admin re-arm or the app's own
    // post-consume zero on every subsequent migration run/restart.
    // NOTE (numbering): renumbered to v58 after main's v56 document_abstracts (#1792 merge).
    version: 58,
    name: "earningscalls_burst_seed",
    up: (database) => {
      // Partial-schema unit tests (and any legacy file that somehow lacks settings)
      // must still be able to run this one-shot seed without "no such table: settings".
      database.exec(`
        CREATE TABLE IF NOT EXISTS settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `);
      database
        .prepare(
          `INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?, ?, ?)`
        )
        .run("earningscalls_burst_pending", "25", new Date().toISOString());
    }
  },
  {
    // Per-user reflection pooling (owner directive, 2026-07-23): adds regime, thesis_tag, and
    // dominant_factor columns to learned_context so regime-conditioned retrieval can score rows
    // against the current market regime. No data migration needed — existing rows stay NULL.
    version: 59,
    name: "learned_context_regime_column",
    up: (database) => {
      const addColumns = (table: "learned_context" | "learned_context_pending") => {
        // Guard: when the persistence-hardening tests replay migrations from an early schema
        // version, learned_context may not exist yet — skip silently so v59 is idempotent.
        if (!tableExists(database, table)) return;
        if (!columnExists(database, table, "regime")) {
          database.exec(`ALTER TABLE ${table} ADD COLUMN regime TEXT`);
        }
        if (!columnExists(database, table, "thesis_tag")) {
          database.exec(`ALTER TABLE ${table} ADD COLUMN thesis_tag TEXT`);
        }
        if (!columnExists(database, table, "dominant_factor")) {
          database.exec(`ALTER TABLE ${table} ADD COLUMN dominant_factor TEXT`);
        }
      };
      addColumns("learned_context");
      addColumns("learned_context_pending");
    }
  },
  {
    // Exit-strategy Phase B1 (2026-07-24): persist parameterized Exit Contract columns on
    // position_stop_plans so every enforcement layer can read one resolved distance/price set
    // (with account-policy fallback when null). Nullable — legacy rows stay behavior-identical
    // until the next opening fill writes the contract. See docs/design/exit-strategy-intelligence.md.
    version: 60,
    name: "position_stop_plans_exit_contract",
    up: (database) => {
      if (!tableExists(database, "position_stop_plans")) return;
      const add = (name: string, ddl: string) => {
        if (!columnExists(database, "position_stop_plans", name)) {
          database.exec(`ALTER TABLE position_stop_plans ADD COLUMN ${ddl}`);
        }
      };
      add("resolved_stop_pct", "resolved_stop_pct REAL");
      add("stop_price", "stop_price REAL");
      add("entry_atr_pct", "entry_atr_pct REAL");
      add("trail_percent", "trail_percent REAL");
      add("take_profit_price", "take_profit_price REAL");
      add("max_holding_until", "max_holding_until TEXT");
      add("invalidation", "invalidation TEXT");
    }
  },

  {
    // Advisory cleanup / fundamentals PIT (fix-1792): time-series fundamentals snapshots
    // for as-of lookups. Numbered v61 after main v59 regime columns + v60 exit contract.
    version: 61,
    name: "historical_fundamentals",
    up: (database) => {
      database.exec(`
        CREATE TABLE IF NOT EXISTS historical_fundamentals (
          symbol TEXT NOT NULL,
          field TEXT NOT NULL,
          value REAL NOT NULL,
          provider TEXT NOT NULL,
          effective_at TEXT NOT NULL,
          fetched_at TEXT NOT NULL,
          PRIMARY KEY (symbol, field, provider, effective_at)
        );
      `);
    }
  },
  {
    version: 62,
    name: "task_journal",
    up: (database) => {
      database.exec(`
        CREATE TABLE IF NOT EXISTS task_journal (
          id TEXT PRIMARY KEY,
          task_name TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('running','ok','error','skipped')),
          started_at TEXT NOT NULL,
          finished_at TEXT,
          duration_ms INTEGER,
          user_id TEXT,
          connected_account_id TEXT,
          summary TEXT,
          error TEXT,
          metadata TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_task_journal_task_started ON task_journal (task_name, started_at);
        CREATE INDEX IF NOT EXISTS idx_task_journal_started ON task_journal (started_at);
        CREATE INDEX IF NOT EXISTS idx_task_journal_user_started ON task_journal (user_id, started_at);
      `);
    }
  },
  {
    version: 63,
    name: "pushover_target_column",
    up: (database) => {
      if (!tableExists(database, "notification_prefs")) return;
      if (!columnExists(database, "notification_prefs", "pushover_target")) {
        database.exec(`ALTER TABLE notification_prefs ADD COLUMN pushover_target TEXT NOT NULL DEFAULT '';`);
      }
    }
  },
  {
    version: 64,
    name: "notify_per_user_channel_credentials",
    up: (database) => {
      // Per-user delivery-channel credentials (owner directive 2026-07-31):
      // Pushover app token + Twilio set live in user settings, encrypted at rest
      // via db-api-keys' encryptValue; server env vars remain as fallback.
      if (!tableExists(database, "notification_prefs")) return;
      for (const col of ["pushover_app_token", "twilio_account_sid", "twilio_auth_token", "twilio_from"]) {
        if (!columnExists(database, "notification_prefs", col)) {
          database.exec(`ALTER TABLE notification_prefs ADD COLUMN ${col} TEXT NOT NULL DEFAULT '';`);
        }
      }
    }
  },
  {
    version: 65,
    name: "audit_and_provider_created_at_indexes",
    up: (database) => {
      // Retention pruning (audit-prune.ts) and time-window queries need these
      // indexes: created them manually in prod 2026-08-02 after the unindexed
      // prune pass ran minutes per batch; keeping them in schema so fresh DBs
      // get them too. CREATE INDEX IF NOT EXISTS is idempotent.
      if (tableExists(database, "audit_events")) {
        database.exec("CREATE INDEX IF NOT EXISTS idx_audit_events_created_at ON audit_events(created_at);");
      }
      if (tableExists(database, "provider_dispatch_attempts")) {
        database.exec("CREATE INDEX IF NOT EXISTS idx_pda_created_at ON provider_dispatch_attempts(created_at);");
      }
      if (tableExists(database, "provider_usage_outbox")) {
        database.exec("CREATE INDEX IF NOT EXISTS idx_puo_created_at ON provider_usage_outbox(created_at);");
      }
    }
  },
  {
    version: 66,
    name: "headline_first_seen",
    up: (database) => {
      // Issue #837: persist first-seen times for news headlines so evidence-age
      // receipts can cover the highest-volume untrusted Bull-prompt input
      // (provider titles previously carried no timestamp).
      database.exec(`
        CREATE TABLE IF NOT EXISTS headline_first_seen (
          user_id TEXT NOT NULL,
          fingerprint TEXT NOT NULL,
          symbol TEXT NOT NULL,
          first_seen TEXT NOT NULL,
          last_seen TEXT NOT NULL,
          PRIMARY KEY (user_id, fingerprint)
        );
        CREATE INDEX IF NOT EXISTS idx_headline_first_seen_last_seen
          ON headline_first_seen(last_seen);
      `);
    }
  },
  {
    version: 67,
    name: "audit_events_chain_hash",
    up: (database) => {
      // P0-4: tamper-evident per-user audit chain. Legacy rows keep NULL chain_hash;
      // new audit() inserts link prev→self. verifyAuditChain checks continuity.
      if (!tableExists(database, "audit_events")) return;
      if (!columnExists(database, "audit_events", "chain_hash")) {
        database.exec("ALTER TABLE audit_events ADD COLUMN chain_hash TEXT;");
      }
      if (!columnExists(database, "audit_events", "prev_chain_hash")) {
        database.exec("ALTER TABLE audit_events ADD COLUMN prev_chain_hash TEXT;");
      }
      database.exec(
        "CREATE INDEX IF NOT EXISTS idx_audit_events_user_chain ON audit_events (user_id, created_at DESC, id DESC);"
      );
    }
  },
  {
    // Activity-audit P3: historical fill_events with broker_order_id = literal 'undefined'
    // (or empty string) stayed pending forever and forced a no-op reconcile every run.
    // Insertion root cause was already fixed (PR #284); this is a one-time flip to terminal
    // status `unreconcilable`. Idempotent via user_version — re-runs are no-ops.
    // Numbered 68: main already claimed 67 for audit_events_chain_hash.
    version: 68,
    name: "fill_events_unreconcilable_bad_broker_order_id",
    up: (database) => {
      const table = database
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'fill_events'`)
        .get() as { name: string } | undefined;
      if (!table) return;
      const info = database
        .prepare(
          `UPDATE fill_events
           SET status = 'unreconcilable'
           WHERE status IN ('pending_reconciliation', 'partially_filled', 'pending')
             AND (broker_order_id = 'undefined' OR broker_order_id = '')`
        )
        .run();
      if (info.changes > 0) {
        database
          .prepare(
            "INSERT INTO audit_events (id, user_id, connected_account_id, created_at, kind, payload) VALUES (?, ?, ?, ?, ?, ?)"
          )
          .run(
            crypto.randomUUID(),
            "local",
            null,
            new Date().toISOString(),
            "fill_unreconcilable_backfill",
            JSON.stringify({
              count: info.changes,
              reason: "broker_order_id_unusable",
              note: "One-time flip of pending fills with broker_order_id literal 'undefined' or empty"
            })
          );
        console.log(
          `[db] migration 68: flipped ${info.changes} fill_events row(s) with unusable broker_order_id to unreconcilable`
        );
      }
    }
  },
  {
    // Shared, durable latest-value store: every market field for every symbol ever
    // seen, each row carrying its OWN as_of + fetched_at (not a scan-level stamp).
    // Strategy audits strip full MarketScan for size; this table is the recovery
    // path so interactive scans / other users still see last-known PE, EPS, etc.
    // Symbols that leave the universe keep their last rows until a newer write.
    // Numbered 69: main claimed 68 for fill_events_unreconcilable_bad_broker_order_id.
    version: 69,
    name: "symbol_field_latest",
    up: (database) => {
      database.exec(`
        CREATE TABLE IF NOT EXISTS symbol_field_latest (
          symbol TEXT NOT NULL,
          field TEXT NOT NULL,
          value_json TEXT NOT NULL,
          source TEXT NOT NULL,
          as_of TEXT NOT NULL,
          fetched_at TEXT NOT NULL,
          PRIMARY KEY (symbol, field)
        );
        CREATE INDEX IF NOT EXISTS idx_symbol_field_latest_fetched
          ON symbol_field_latest (fetched_at);
        CREATE INDEX IF NOT EXISTS idx_symbol_field_latest_as_of
          ON symbol_field_latest (as_of);
      `);
    }
  },
  {
    // Per-user declared plan tier for optional market-data API keys (free/power/starter/…).
    // Used by Connections dropdown + provider-tier-plan → quota hints when env knobs unset.
    version: 70,
    name: "user_api_keys_plan_tier",
    up: (database) => {
      if (!tableExists(database, "user_api_keys")) return;
      if (!columnExists(database, "user_api_keys", "plan_tier")) {
        database.exec("ALTER TABLE user_api_keys ADD COLUMN plan_tier TEXT");
      }
    }
  },
  {
    // Provenance on durable EOD history cache: which cascade tier wrote each bar.
    // `updated_at` is already fetched_at; `source` completes the (source, as_of=date, fetched_at)
    // triple required for every cached data point. See source-capability-matrix ohlcv_daily.
    version: 71,
    name: "history_cache_eod_source",
    up: (database) => {
      if (!tableExists(database, "history_cache_eod")) {
        database.exec(`
          CREATE TABLE IF NOT EXISTS history_cache_eod (
            ticker TEXT NOT NULL,
            date TEXT NOT NULL,
            open REAL,
            high REAL,
            low REAL,
            close REAL NOT NULL,
            volume REAL,
            vwap REAL,
            source TEXT NOT NULL DEFAULT 'unknown',
            updated_at TEXT NOT NULL,
            PRIMARY KEY (ticker, date)
          );
          CREATE INDEX IF NOT EXISTS idx_history_cache_eod_ticker ON history_cache_eod (ticker, date);
        `);
        return;
      }
      if (!columnExists(database, "history_cache_eod", "source")) {
        database.exec(
          `ALTER TABLE history_cache_eod ADD COLUMN source TEXT NOT NULL DEFAULT 'unknown'`
        );
      }
    }
  },
  {
    // Watchlist digest (dsa lesson: digest) needs a queryable per-symbol proposal lookback.
    // Previously `symbol` only lived inside the `proposal` JSON blob, requiring a full-table
    // json_extract scan per symbol lookup. Additive + guarded; one-time backfill mirrors the
    // trade_thesis_tag/entry_market_regime backfill above. insertProposal (db-proposals.ts)
    // populates the column going forward.
    version: 72,
    name: "trade_proposals_symbol_column",
    up: (database) => {
      if (!tableExists(database, "trade_proposals")) return;
      if (!columnExists(database, "trade_proposals", "symbol")) {
        database.exec("ALTER TABLE trade_proposals ADD COLUMN symbol TEXT");
        database.exec(
          "UPDATE trade_proposals SET symbol = UPPER(TRIM(json_extract(proposal, '$.symbol'))) WHERE json_extract(proposal, '$.symbol') IS NOT NULL"
        );
      }
      database.exec(
        "CREATE INDEX IF NOT EXISTS idx_trade_proposals_symbol_account_created ON trade_proposals (symbol, account_number, created_at)"
      );
    }
  },
  {
    // Watchlist digest opt-in (owner default OFF, Settings -> Delivery): same shape as the
    // pushover_target_column / notify_per_user_channel_credentials migrations above.
    version: 73,
    name: "notify_watchlist_digest_enabled",
    up: (database) => {
      if (!tableExists(database, "notification_prefs")) return;
      if (!columnExists(database, "notification_prefs", "watchlist_digest_enabled")) {
        database.exec(
          "ALTER TABLE notification_prefs ADD COLUMN watchlist_digest_enabled INTEGER NOT NULL DEFAULT 0;"
        );
      }
    }
  },
  {
    // Signal-health monitor (r2 lesson: health): rolling pure-arithmetic diagnostics of the LLM's
    // OWN confidenceScore against matured decision outcomes — rank IC + t-stat, quantile buckets,
    // top-K churn, gross-vs-net — one snapshot row per (user, UTC day, horizon), written by the
    // daily signal-health-refresh lane (src/lib/signal-health.ts). CRUD in db-signal-health.ts.
    // Rows exist only when the observation floor is met — an under-sampled day writes nothing
    // rather than a fabricated diagnostic.
    version: 74,
    name: "signal_health_snapshot",
    up: (database) => {
      database.exec(`
        CREATE TABLE IF NOT EXISTS signal_health_snapshot (
          user_id TEXT NOT NULL,
          period_end TEXT NOT NULL,
          horizon TEXT NOT NULL,
          rank_ic REAL NOT NULL,
          t_stat REAL NOT NULL,
          n_observations INTEGER NOT NULL,
          n_dates INTEGER NOT NULL,
          quantile_buckets TEXT NOT NULL,
          top_k_churn_pct REAL,
          gross_return_pct REAL NOT NULL,
          net_of_cost_return_pct REAL NOT NULL,
          rolling_rank_ic_slope REAL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (user_id, period_end, horizon)
        );
        CREATE INDEX IF NOT EXISTS idx_signal_health_user_horizon
          ON signal_health_snapshot (user_id, horizon, period_end DESC);
      `);
    }
  },
  {
    // Truncated-replay lookahead audit (freqtrade lookahead-analysis port): one finding row per
    // (user, decision, factor-or-field) — the decision-time value vs the value recomputed from
    // data truncated to the decision date, with an honest three-way classification
    // (clean | mismatch | unverifiable). Written by the weekly lookahead-audit due-job lane
    // (src/lib/lookahead-audit.ts); CRUD in db-lookahead-audit.ts. Unverifiable rows are
    // deliberate coverage-gap receipts (factors with no point-in-time source), not noise.
    version: 75,
    name: "lookahead_audit_findings",
    up: (database) => {
      database.exec(`
        CREATE TABLE IF NOT EXISTS lookahead_audit_findings (
          user_id TEXT NOT NULL,
          decision_id TEXT NOT NULL,
          run_id TEXT,
          symbol TEXT NOT NULL,
          factor_or_field TEXT NOT NULL,
          classification TEXT NOT NULL CHECK (classification IN ('clean', 'mismatch', 'unverifiable')),
          persisted_value REAL,
          recomputed_value REAL,
          delta REAL,
          detail TEXT,
          as_of TEXT,
          created_at TEXT NOT NULL,
          PRIMARY KEY (user_id, decision_id, factor_or_field)
        );
        CREATE INDEX IF NOT EXISTS idx_lookahead_findings_user_created
          ON lookahead_audit_findings (user_id, created_at DESC);
      `);
    }
  },
  {
    // Point-in-time fundamentals revision chain (qlib/ai-hedge-fund lookahead lesson), scoped to
    // SEC-XBRL-derived GAAP facts (debtToEquity, revenueGrowth today; future EPS/revenue fields can
    // reuse the same shape). Mirrors the sec_filings/learned_context superseded_by idiom: a NEW
    // filing for the SAME (symbol, field, fiscal_period_end) marks the prior LIVE row's
    // superseded_by (the successor's own filed_at — there is no synthetic id, and symbol/field/
    // fiscal_period_end are already fixed within a group) instead of overwriting it, so the old row
    // stays queryable. GLOBAL market data (no user_id column) — deliberately exempt from
    // DELETE_TABLES_BY_USER_ID, same class as sec_filings/symbol_field_latest/
    // historical_fundamentals: SEC filings are public-company facts, not account-private. CRUD in
    // db-fundamentals.ts (recordFundamentalRevision / getFundamentalAsOf).
    version: 76,
    name: "fundamental_revisions",
    up: (database) => {
      database.exec(`
        CREATE TABLE IF NOT EXISTS fundamental_revisions (
          symbol TEXT NOT NULL,
          field TEXT NOT NULL,
          fiscal_period_end TEXT NOT NULL,
          value REAL NOT NULL,
          form TEXT NOT NULL,
          filed_at TEXT NOT NULL,
          provider TEXT NOT NULL,
          superseded_by TEXT,
          created_at TEXT NOT NULL,
          PRIMARY KEY (symbol, field, fiscal_period_end, filed_at)
        );
        CREATE INDEX IF NOT EXISTS idx_fundamental_revisions_symbol_field_filed
          ON fundamental_revisions (symbol, field, filed_at);
      `);
    }
  },
  {
    // Native iOS push (APNs) device-token registry. One row per device token; the token is the
    // PRIMARY KEY because a token identifies exactly one install on one device and must belong to
    // exactly ONE user — re-registering it under a different account reassigns it (see
    // registerDeviceToken in db-device-tokens.ts) so a shared phone that switches accounts never
    // keeps receiving the previous user's alerts.
    //
    // `environment` is stored, not inferred: APNs device tokens are environment-specific (a
    // sandbox token is answered 400 BadDeviceToken by the production endpoint and vice versa), and
    // the endpoint is chosen from this column at send time.
    version: 77,
    name: "device_push_tokens",
    up: (database) => {
      database.exec(`
        CREATE TABLE IF NOT EXISTS device_push_tokens (
          token TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          environment TEXT NOT NULL CHECK(environment IN ('sandbox','production')),
          bundle_id TEXT NOT NULL,
          platform TEXT NOT NULL DEFAULT 'ios',
          created_at TEXT NOT NULL,
          last_seen_at TEXT NOT NULL,
          disabled_at TEXT,
          disabled_reason TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_device_push_tokens_user
          ON device_push_tokens (user_id, disabled_at);
      `);
    }
  },
  {
    // Owner ruling 2026-08-12 ("ALL toggles must be real"): removes the force-include-at-send-time
    // pattern for lookahead_leak, signal_health, provider_degraded, storage_warning,
    // autonomy_halted_on_boot, earningscalls_entitlement_blocked, budget_alert, and risk_advisory —
    // every one of those sites injected its event type into that send's effective enabledEvents so a
    // legacy stored array (predating the type) still delivered it, silently overriding a user who had
    // (or later set) the toggle off. This is the one-time backfill the removed sites' own comments
    // said they wanted: union FORCE_INCLUDE_BACKFILL_EVENT_TYPES into every already-explicit stored
    // enabledEvents array, once, so the Settings toggle becomes genuinely authoritative afterward — on
    // by default (matching the prior always-delivered behavior), off if/when the user turns it off,
    // and it STAYS off. See docs/rollouts/2026-08-13-remove-force-include-notifications.md.
    version: 78,
    name: "notification_enabled_events_backfill",
    up: (database) => {
      const changed = backfillNotificationEnabledEventsRows(database, FORCE_INCLUDE_BACKFILL_EVENT_TYPES);
      if (changed > 0) {
        console.log(`[db] migration 78: backfilled ${changed} legacy enabledEvents row(s) with previously force-included event types`);
      }
    }
  },
  {
    version: 79,
    name: "trade_locks",
    up: (database) => {
      database.exec(`
        CREATE TABLE IF NOT EXISTS trade_locks (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          connected_account_id TEXT NOT NULL,
          scope TEXT NOT NULL CHECK(scope IN ('account','symbol')),
          symbol TEXT NOT NULL DEFAULT '',
          side TEXT NOT NULL CHECK(side IN ('long','short','*')),
          reason TEXT NOT NULL,
          trigger TEXT NOT NULL,
          created_at TEXT NOT NULL,
          until TEXT NOT NULL,
          active INTEGER NOT NULL DEFAULT 1,
          UNIQUE(user_id, connected_account_id, scope, symbol, side, trigger)
        );
        CREATE INDEX IF NOT EXISTS idx_trade_locks_active
          ON trade_locks (user_id, connected_account_id, active, until);
      `);
    }
  },
  {
    version: 80,
    name: "vector_doc_lifecycle",
    up: (database) => {
      database.exec(`
        CREATE TABLE IF NOT EXISTS vector_doc_lifecycle (
          user_id TEXT NOT NULL,
          vector_id TEXT NOT NULL,
          doc_type TEXT NOT NULL,
          first_seen_at TEXT NOT NULL,
          last_retrieved_at TEXT,
          retrieval_count INTEGER NOT NULL DEFAULT 0,
          archived_at TEXT,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (user_id, vector_id)
        );
        CREATE INDEX IF NOT EXISTS idx_vector_doc_lifecycle_live
          ON vector_doc_lifecycle (user_id, archived_at, doc_type);
      `);
    }
  },
  {
    version: 81,
    name: "strategy_overlays",
    up: (database) => {
      database.exec(`
        CREATE TABLE IF NOT EXISTS strategy_overlays (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          name TEXT NOT NULL,
          market_regimes TEXT NOT NULL,
          instructions TEXT NOT NULL,
          priority INTEGER NOT NULL DEFAULT 100,
          enabled INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_strategy_overlays_user
          ON strategy_overlays (user_id, enabled, priority);
      `);
    }
  },
  {
    version: 82,
    name: "strategy_run_requests",
    up: (database) => {
      database.exec(`
        CREATE TABLE IF NOT EXISTS strategy_run_requests (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          manual INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL CHECK(status IN ('queued','running','completed','failed')),
          result TEXT,
          created_at TEXT NOT NULL,
          started_at TEXT,
          finished_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_strategy_run_requests_user_status
          ON strategy_run_requests (user_id, status, created_at);
      `);
    }
  },
  {
    version: 83,
    name: "idea_sources_13f_ark_form4",
    up: (database) => {
      database.exec(`
        CREATE TABLE IF NOT EXISTS sec_insider_transactions (
          id TEXT PRIMARY KEY,
          cik TEXT NOT NULL,
          accession TEXT NOT NULL,
          insider_name TEXT NOT NULL,
          relationship TEXT NOT NULL,
          side TEXT NOT NULL,
          shares REAL NOT NULL,
          price REAL NOT NULL,
          period_of_report TEXT NOT NULL,
          is_10b5_1 INTEGER NOT NULL DEFAULT 0,
          transaction_code TEXT NOT NULL DEFAULT '',
          symbol TEXT NOT NULL DEFAULT ''
        );
      `);
      if (!columnExists(database, "sec_insider_transactions", "symbol")) {
        database.exec("ALTER TABLE sec_insider_transactions ADD COLUMN symbol TEXT NOT NULL DEFAULT ''");
      }
      database.exec(`
        CREATE INDEX IF NOT EXISTS idx_sec_insider_transactions_symbol
          ON sec_insider_transactions(symbol);
        CREATE TABLE IF NOT EXISTS cusip_ticker_map (
          cusip TEXT PRIMARY KEY,
          ticker TEXT NOT NULL,
          source TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sec_13f_holdings (
          id TEXT PRIMARY KEY,
          filer_cik TEXT NOT NULL,
          filer_name TEXT NOT NULL,
          period_end TEXT NOT NULL,
          accession TEXT NOT NULL,
          cusip TEXT NOT NULL,
          ticker TEXT NOT NULL DEFAULT '',
          issuer_name TEXT NOT NULL,
          title_of_class TEXT NOT NULL DEFAULT '',
          shares REAL NOT NULL,
          value_usd REAL NOT NULL,
          ssh_prn_type TEXT NOT NULL DEFAULT 'SH',
          fetched_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_sec_13f_holdings_ticker_period
          ON sec_13f_holdings(ticker, period_end);
        CREATE INDEX IF NOT EXISTS idx_sec_13f_holdings_filer_period
          ON sec_13f_holdings(filer_cik, period_end);
        CREATE TABLE IF NOT EXISTS ark_holdings (
          id TEXT PRIMARY KEY,
          as_of TEXT NOT NULL,
          fund TEXT NOT NULL,
          ticker TEXT NOT NULL,
          company TEXT NOT NULL,
          cusip TEXT NOT NULL DEFAULT '',
          shares REAL NOT NULL,
          market_value_usd REAL NOT NULL,
          weight_pct REAL NOT NULL,
          fetched_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_ark_holdings_ticker_asof
          ON ark_holdings(ticker, as_of);
        CREATE INDEX IF NOT EXISTS idx_ark_holdings_fund_asof
          ON ark_holdings(fund, as_of);
      `);
    }
  },
  {
    version: 84,
    name: "ingested_accessions_pinecone_write_class",
    up: (database) => {
      if (!tableExists(database, "ingested_accessions")) return;
      if (!columnExists(database, "ingested_accessions", "pinecone_write_class")) {
        database.exec(
          "ALTER TABLE ingested_accessions ADD COLUMN pinecone_write_class TEXT NOT NULL DEFAULT 'full-body'"
        );
      }
      if (!columnExists(database, "ingested_accessions", "pinecone_vector_count")) {
        database.exec(
          "ALTER TABLE ingested_accessions ADD COLUMN pinecone_vector_count INTEGER NOT NULL DEFAULT 0"
        );
      }
    }
  },
  {
    version: 85,
    name: "document_chunks_fts_index",
    up: (database) => {
      database.exec(`
        CREATE TABLE IF NOT EXISTS document_chunks_fts_index (
          content_hash TEXT NOT NULL,
          symbol TEXT NOT NULL,
          source TEXT NOT NULL,
          accession TEXT NOT NULL,
          fts_rowid INTEGER NOT NULL,
          PRIMARY KEY (content_hash, symbol, source, accession)
        );
      `);
      if (!tableExists(database, "document_chunks_fts")) return;
      database.exec(`
        INSERT OR REPLACE INTO document_chunks_fts_index
          (content_hash, symbol, source, accession, fts_rowid)
        SELECT content_hash, symbol, source, accession, rowid
        FROM document_chunks_fts;
      `);
    }
  },
  {
    // Cost provenance on the LLM ledger.  `cost_usd` used to be exclusively a price-table
    // ESTIMATE; OpenRouter reports its own billed amount on every response (`usage.cost`), and
    // recordLlmUsage now prefers it.  Without this column a billed figure and an estimate are
    // indistinguishable in the table, so /console/usage cannot honestly label either.  Existing
    // rows stay NULL and are read as estimates — which is exactly what they were.
    version: 86,
    name: "llm_usage_cost_source",
    up: (database) => {
      // Table-existence guard first.  `PRAGMA table_info` on a MISSING table returns an empty
      // list rather than erroring, so without this the "column absent" branch is taken and the
      // ALTER dies with "no such table" — which is exactly how this migration broke
      // test/persistence-hardening.test.ts, where migrations are exercised against a database
      // that has not been through the baseline schema.  Matches the guard on migration 84.
      if (!tableExists(database, "llm_usage")) return;
      if (!columnExists(database, "llm_usage", "cost_source")) {
        database.exec("ALTER TABLE llm_usage ADD COLUMN cost_source TEXT");
      }
    }
  },
  {
    // Composite query indexes on performance-critical ledger and notification scan paths.
    // 1. notification_events: speed up user notifications timeline ordered fetches.
    // 2. fill_events: speed up ordered trade history queries per user/account.
    // 3. historical_fundamentals: speed up latest fundamental metrics per symbol & field.
    version: 87,
    name: "composite_query_indexes",
    up: (database) => {
      const hasNotifications = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='notification_events'").get();
      if (hasNotifications) {
        database.exec("CREATE INDEX IF NOT EXISTS idx_notification_events_user_created ON notification_events (user_id, created_at DESC)");
      }
      const hasFills = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='fill_events'").get();
      if (hasFills) {
        database.exec("CREATE INDEX IF NOT EXISTS idx_fill_events_user_account_filled ON fill_events (user_id, account_number, filled_at DESC)");
      }
      const hasFundamentals = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='historical_fundamentals'").get();
      if (hasFundamentals) {
        database.exec("CREATE INDEX IF NOT EXISTS idx_historical_fundamentals_symbol_field_effective ON historical_fundamentals (symbol, field, effective_at DESC)");
      }
    }
  },
  {
    // The FTS mirror resumes per OCCURRENCE — `WHERE symbol = ? AND source = ? AND accession = ?`
    // — but the only index on `document_chunks_fts_index` is its PK, which leads with
    // `content_hash`.  An occurrence lookup therefore cannot seek and SCANS the whole covering
    // index.  Measured on production 2026-09-09 (689,047 rows / 10.98 GB DB): `SCAN
    // document_chunks_fts_index USING COVERING INDEX`, 78-105 ms per call, and better-sqlite3 is
    // synchronous so every one of those milliseconds is the serving event loop.  The worker calls
    // it once per document per tick.  This index turns that SCAN into a SEARCH.
    version: 88,
    name: "document_chunks_fts_index_occurrence",
    up: (database) => {
      if (!tableExists(database, "document_chunks_fts_index")) return;
      database.exec(
        `CREATE INDEX IF NOT EXISTS idx_document_chunks_fts_index_occurrence
           ON document_chunks_fts_index (symbol, source, accession)`
      );
    }
  },
  {
    version: 89,
    name: "chat_turns_connected_account_id",
    up: (database) => {
      if (!tableExists(database, "chat_turns")) return;
      if (!columnExists(database, "chat_turns", "connected_account_id")) {
        database.exec("ALTER TABLE chat_turns ADD COLUMN connected_account_id TEXT");
      }
    }
  },
  {
    // 2026-09-20 MM comprehensive review: the audit-prune observability+default DELETE does
    // NOT constrain user_id (audit-prune.ts:115-132) but the only existing kind-prefixed
    // index is (kind, user_id, created_at DESC) — without a user_id bound, SQLite scans
    // kind-ranges across every user. Add a tighter (kind, created_at) compound so the prune
    // path can range-scan created_at inside a single kind without dragging user_id through
    // the sorter. Idempotent via IF NOT EXISTS.
    version: 90,
    name: "audit_events_kind_created_index",
    up: (database) => {
      if (!tableExists(database, "audit_events")) return;
      database.exec(
        "CREATE INDEX IF NOT EXISTS idx_audit_events_kind_created ON audit_events (kind, created_at)"
      );
    }
  },
  {
    // 2026-09-23 MM (llm-stats feature): the LLM stats console page needs per-call
    // latency_ms + status so it can render p50/p95/p99 latency and an error-rate column.
    // Both columns are nullable so legacy rows written before this migration stay valid;
    // the recorder (src/lib/llm-usage.ts) fills them in for every call from here on.  No
    // data eviction — owner rule: keep every LLM call forever for trade-outcome correlation
    // (proposals cross-referenced against which LLM family produced them, with enough sample
    // size per alias that single-generation versions don't each need their own bucket).
    version: 91,
    name: "llm_usage_latency_status",
    up: (database) => {
      if (!tableExists(database, "llm_usage")) return;
      if (!columnExists(database, "llm_usage", "latency_ms")) {
        database.exec("ALTER TABLE llm_usage ADD COLUMN latency_ms INTEGER");
      }
      if (!columnExists(database, "llm_usage", "status")) {
        database.exec("ALTER TABLE llm_usage ADD COLUMN status TEXT");
      }
      database.exec("CREATE INDEX IF NOT EXISTS idx_llm_usage_model_status ON llm_usage (model, status, created_at)");
      database.exec("CREATE INDEX IF NOT EXISTS idx_llm_usage_provider_status ON llm_usage (provider, status, created_at)");
    }
  }
];

/**
 * ONE-TIME migration (v7): PR #267 moved llmModel/redTeamLlmModel/llmReasoningEffort
 * from user-level (user_settings.policy) to account-level (account_strategy_state.policy).
 * Before that change there was exactly ONE user-level value per user, so every existing
 * account must inherit that single value. Backfill it into each account row — OVERWRITING
 * any value a row picked up from earlier lazy seeding, which may be stale (e.g. a model the
 * user has since cleared globally) — then strip the fields from user_settings.policy so the
 * runtime seed/overlay can't resurrect a cleared model. Without this, the first per-account
 * save rewrites user_settings without the model fields and any not-yet-saved account loses
 * its seed (the two cases chatgpt-codex-connector flagged on PR #267). Exported for unit
 * testing; the versioned-migration guard runs it exactly once at runtime.
 */
export function backfillAccountScopedStrategyModels(database: Database.Database): void {
  if (!tableExists(database, "user_settings") || !tableExists(database, "account_strategy_state")) return;
  const MODEL_FIELDS = ["llmModel", "redTeamLlmModel", "llmReasoningEffort"];
  const userPolicyRows = database
    .prepare("SELECT user_id, value FROM user_settings WHERE key = 'policy'")
    .all() as Array<{ user_id: string; value: string }>;

  const selectStateRows = database.prepare(
    "SELECT connected_account_id, policy FROM account_strategy_state WHERE user_id = ?"
  );
  const updateState = database.prepare(
    "UPDATE account_strategy_state SET policy = ? WHERE user_id = ? AND connected_account_id = ?"
  );
  const updateUserPolicy = database.prepare(
    "UPDATE user_settings SET value = ? WHERE user_id = ? AND key = 'policy'"
  );

  for (const row of userPolicyRows) {
    let userPolicy: Record<string, unknown>;
    try {
      userPolicy = JSON.parse(row.value) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!userPolicy || typeof userPolicy !== "object") continue;

    // The single legacy user-level value for each model field. Absent => the user had
    // no override and the effective value was the compiled default; rows must then drop
    // any stale copy so mergePolicy falls back to that same default.
    const legacy: Record<string, unknown> = {};
    let hadAny = false;
    for (const f of MODEL_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(userPolicy, f)) {
        legacy[f] = userPolicy[f];
        hadAny = true;
      }
    }

    const stateRows = selectStateRows.all(row.user_id) as Array<{
      connected_account_id: string;
      policy: string;
    }>;

    for (const sr of stateRows) {
      let accountPolicy: Record<string, unknown>;
      try {
        accountPolicy = JSON.parse(sr.policy) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (!accountPolicy || typeof accountPolicy !== "object") continue;
      let changed = false;
      for (const f of MODEL_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(legacy, f)) {
          if (accountPolicy[f] !== legacy[f]) {
            accountPolicy[f] = legacy[f];
            changed = true;
          }
        } else if (Object.prototype.hasOwnProperty.call(accountPolicy, f)) {
          delete accountPolicy[f];
          changed = true;
        }
      }
      if (changed) {
        updateState.run(JSON.stringify(accountPolicy), row.user_id, sr.connected_account_id);
      }
    }

    // Strip the now-account-scoped model fields from user_settings.policy so the
    // legacy seed (readLegacyStrategyModelFields) becomes a permanent no-op.
    if (hadAny) {
      for (const f of MODEL_FIELDS) delete userPolicy[f];
      updateUserPolicy.run(JSON.stringify(userPolicy), row.user_id);
    }
  }
}

/**
 * Apply migrations whose version exceeds the DB's user_version, in ascending order,
 * each inside a transaction that bumps user_version atomically (so a crash can't leave
 * a half-applied, mis-stamped schema). Returns the final version. Exported with explicit
 * args for unit testing.
 */
export function runMigrations(database: Database.Database, migrations: Migration[], baseline: number): number {
  let current = Number(database.pragma("user_version", { simple: true })) || 0;
  if (current < baseline) {
    database.pragma(`user_version = ${baseline}`);
    current = baseline;
  }
  for (const m of [...migrations].sort((a, b) => a.version - b.version)) {
    if (m.version <= current) continue;
    const apply = database.transaction(() => {
      m.up(database);
      database.pragma(`user_version = ${m.version}`);
    });
    // BEGIN IMMEDIATE, not the default DEFERRED: during a rolling deploy the outgoing container
    // commits continuously, and a deferred migration transaction that reads before writing dies
    // with an INSTANT SQLITE_BUSY on the WAL snapshot upgrade — busy_timeout never applies to
    // that path (proven in prod: deployment pyqxv16i, 2026-08-12, migration 72 crash-looped the
    // incoming container and Coolify rolled back).  Taking the write lock up front makes the
    // 60s busy_timeout do its job while the old container's short writes drain.
    apply.immediate();
    current = m.version;
    console.log(`[db] applied migration ${m.version} (${m.name})`);
  }
  return current;
}

/** Apply the application's concrete migration list. Exported for migration regression tests. */
export function applyVersionedMigrations(database: Database.Database): number {
  return runMigrations(database, MIGRATIONS, SCHEMA_BASELINE);
}

/** Current schema version (PRAGMA user_version). */
export function getSchemaVersion(database: Database.Database = getDb()): number {
  return Number(database.pragma("user_version", { simple: true })) || 0;
}

// ── ENCRYPTION_KEY boot guard ────────────────────────────────────────────────
/** True if the DB holds at least one AES-GCM ciphertext (the `iv:tag:ciphertext` shape) that a
 *  wrong/missing ENCRYPTION_KEY would silently decrypt to empty. Covers connected_accounts creds AND
 *  Robinhood OAuth token blobs in settings. Legacy plaintext values don't count. */
export function hasEncryptedCredentials(database: Database.Database): boolean {
  const row = database
    .prepare("SELECT COUNT(*) AS n FROM connected_accounts WHERE api_key GLOB '*:*:*' OR api_secret GLOB '*:*:*'")
    .get() as { n: number };
  if (row.n > 0) return true;
  // Robinhood OAuth token blobs are JSON in settings; the JSON itself contains colons, so match the
  // SECRET fields against the iv:tag:ct hex envelope rather than GLOB-ing the whole value. The
  // optional "v1:" prefix covers the versioned envelope format (see db-api-keys.ts's
  // CIPHERTEXT_VERSION_PREFIX) alongside the pre-versioning bare envelope still on disk.
  const envelope = /^(?:v1:)?[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$/i;
  const oauthRows = database
    .prepare("SELECT value FROM settings WHERE key GLOB 'robinhood_mcp_oauth_token:*'")
    .all() as { value: string }[];
  for (const r of oauthRows) {
    try {
      const blob = JSON.parse(r.value) as { accessToken?: unknown; refreshToken?: unknown };
      if (
        (typeof blob.accessToken === "string" && envelope.test(blob.accessToken)) ||
        (typeof blob.refreshToken === "string" && envelope.test(blob.refreshToken))
      ) {
        return true;
      }
    } catch {
      /* malformed settings row — ignore */
    }
  }
  return false;
}

/**
 * Fail loudly at boot rather than silently decrypting stored creds to '' (which a
 * per-process random ENCRYPTION_KEY fallback does). Triggers only when the key is absent
 * (ephemeral random fallback) AND the DB already holds ciphertext. `ephemeral` is read
 * from process.env at call time so it reflects any local dotenv-style file loaded during import.
 */
export function assertEncryptionKeyAvailable(
  database: Database.Database,
  opts: { ephemeral?: boolean; isTest?: boolean } = {}
): void {
  const ephemeral = opts.ephemeral ?? !process.env.ENCRYPTION_KEY;
  const isTest = opts.isTest ?? (process.env.NODE_ENV === "test" || !!process.env.VITEST);
  if (!ephemeral || isTest) return;
  if (hasEncryptedCredentials(database)) {
    throw new Error(
      "ENCRYPTION_KEY is not set but the database holds encrypted credentials. A per-process " +
      "random key cannot decrypt them (they would silently read as empty and be lost). Set " +
      "ENCRYPTION_KEY (hex) to the original key before starting. Refusing to boot."
    );
  }
}

/**
 * Per-user hash chain material for a single audit row (P0-4). Stable canonical
 * string — do not change field order without a chain version bump.
 */
export function auditChainMaterial(input: {
  prevHash: string;
  id: string;
  createdAt: string;
  kind: string;
  payloadJson: string;
  userId: string;
  connectedAccountId: string | null;
}): string {
  return [
    input.prevHash,
    input.id,
    input.createdAt,
    input.kind,
    input.payloadJson,
    input.userId,
    input.connectedAccountId ?? ""
  ].join("\n");
}

export function hashAuditChainMaterial(material: string): string {
  return crypto.createHash("sha256").update(material, "utf8").digest("hex");
}

/**
 * Verify the per-user audit hash chain for chained rows (chain_hash NOT NULL).
 * Legacy pre-migration rows (NULL chain_hash) are skipped.
 */
export function verifyAuditChain(
  userId: string = "local",
  limit: number = 5000
): { ok: boolean; checked: number; brokenId?: string; reason?: string } {
  const rows = getDb()
    .prepare(
      `SELECT id, created_at, kind, payload, user_id, connected_account_id, chain_hash, prev_chain_hash
       FROM audit_events
       WHERE user_id = ? AND chain_hash IS NOT NULL
       ORDER BY rowid ASC
       LIMIT ?`
    )
    .all(userId, Math.max(1, Math.min(limit, 50_000))) as Array<{
    id: string;
    created_at: string;
    kind: string;
    payload: string;
    user_id: string;
    connected_account_id: string | null;
    chain_hash: string;
    prev_chain_hash: string | null;
  }>;

  let expectedPrev: string | null = null;
  let checked = 0;
  for (const row of rows) {
    const prev = row.prev_chain_hash ?? "GENESIS";
    if (expectedPrev !== null && prev !== expectedPrev && prev !== "GENESIS") {
      return {
        ok: false,
        checked,
        brokenId: row.id,
        reason: `prev_chain_hash mismatch: expected ${expectedPrev.slice(0, 12)}… got ${(row.prev_chain_hash ?? "null").slice(0, 12)}…`
      };
    }
    const material = auditChainMaterial({
      prevHash: prev,
      id: row.id,
      createdAt: row.created_at,
      kind: row.kind,
      payloadJson: row.payload,
      userId: row.user_id,
      connectedAccountId: row.connected_account_id
    });
    const expected = hashAuditChainMaterial(material);
    if (expected !== row.chain_hash) {
      return {
        ok: false,
        checked,
        brokenId: row.id,
        reason: "chain_hash does not recompute from row material (payload/kind/timestamp tamper?)"
      };
    }
    expectedPrev = row.chain_hash;
    checked++;
  }
  return { ok: true, checked };
}

export function audit(kind: string, payload: unknown, userId: string = "local", connectedAccountId?: string): void {
  const db = getDb();
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const payloadJson = JSON.stringify(payload);
  const accountId = connectedAccountId ?? null;

  let prevHash = "GENESIS";
  try {
    const tip = db
      .prepare(
        `SELECT chain_hash FROM audit_events
         WHERE user_id = ? AND chain_hash IS NOT NULL
         ORDER BY rowid DESC LIMIT 1`
      )
      .get(userId) as { chain_hash: string } | undefined;
    if (tip?.chain_hash) prevHash = tip.chain_hash;
  } catch {
    // Pre-migration / minimal schema in unit tests without chain columns.
  }

  const chainHash = hashAuditChainMaterial(
    auditChainMaterial({
      prevHash,
      id,
      createdAt,
      kind,
      payloadJson,
      userId,
      connectedAccountId: accountId
    })
  );

  try {
    db.prepare(
      `INSERT INTO audit_events
        (id, user_id, connected_account_id, created_at, kind, payload, chain_hash, prev_chain_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, userId, accountId, createdAt, kind, payloadJson, chainHash, prevHash === "GENESIS" ? null : prevHash);
  } catch {
    // Fallback when chain columns are absent (tests that skipped migrations).
    db.prepare(
      "INSERT INTO audit_events (id, user_id, connected_account_id, created_at, kind, payload) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(id, userId, accountId, createdAt, kind, payloadJson);
  }
}

function migrate(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS account_write_fences (
      subject_token TEXT PRIMARY KEY,
      generation TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('prepared','completed')),
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_account_write_fences_status
      ON account_write_fences (status, updated_at);

    CREATE TABLE IF NOT EXISTS account_identity_generations (
      base_subject_token TEXT PRIMARY KEY,
      current_user_id TEXT NOT NULL,
      generation INTEGER NOT NULL CHECK(generation >= 0),
      status TEXT NOT NULL CHECK(status IN ('active','deleted')),
      session_cutoff_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_account_identity_current_user
      ON account_identity_generations (current_user_id);

    CREATE TABLE IF NOT EXISTS audit_events (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      kind TEXT NOT NULL,
      payload TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS strategy_runs (
      id TEXT PRIMARY KEY,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      status TEXT NOT NULL,
      summary TEXT,
      account_number TEXT,
      policy_revision TEXT
    );

    CREATE TABLE IF NOT EXISTS trade_proposals (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      account_number TEXT NOT NULL,
      created_at TEXT NOT NULL,
      proposal TEXT NOT NULL,
      decision TEXT NOT NULL,
      review TEXT,
      ref_id TEXT,
      order_id TEXT,
      status TEXT NOT NULL,
      trade_thesis_tag TEXT,
      entry_market_regime TEXT,
      execution_mode TEXT,
      error_message TEXT,
      prompt_version TEXT
    );

    CREATE TABLE IF NOT EXISTS strategy_profiles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      policy TEXT NOT NULL,
      prompt TEXT NOT NULL,
      scoring_weights TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    -- Per-account LIVE strategy state (policy + system_state), keyed by the stable
    -- connected_accounts.id. strategy_profiles is the user-level copyable LIBRARY;
    -- this is what an account is actually running. Seeded lazily on first read
    -- (migration-on-read in db-profiles.getPolicy) so existing single-account users
    -- are byte-identical day one. No hard FK — deletion is handled in code
    -- (deleteConnectedAccount / account-deletion purge), matching the per-account
    -- execution tables above.
    CREATE TABLE IF NOT EXISTS account_strategy_state (
      user_id TEXT NOT NULL,
      connected_account_id TEXT NOT NULL,
      policy TEXT NOT NULL,
      prompt TEXT,
      scoring_weights TEXT,
      system_state TEXT NOT NULL DEFAULT 'halted',
      derived_from_profile_id TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, connected_account_id)
    );

    CREATE TABLE IF NOT EXISTS portfolio_snapshots (
      id TEXT PRIMARY KEY,
      run_id TEXT,
      account_number TEXT NOT NULL,
      source TEXT NOT NULL,
      equity REAL NOT NULL,
      cash REAL NOT NULL,
      buying_power REAL NOT NULL,
      positions_value REAL NOT NULL,
      positions TEXT NOT NULL,
      created_at TEXT NOT NULL,
      execution_mode TEXT
    );

    CREATE TABLE IF NOT EXISTS order_replacements (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      account_number TEXT NOT NULL,
      original_order_id TEXT NOT NULL,
      symbol TEXT,
      side TEXT,
      original_type TEXT,
      original_quantity REAL,
      original_filled_quantity REAL,
      replacement_ref_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('cancel_requested', 'cancel_confirmed', 'replacement_claiming', 'replacement_submitted', 'replacement_confirmed', 'failed', 'aborted')),
      remaining_quantity REAL,
      cancel_result TEXT,
      replacement_order_id TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS fill_events (
      id TEXT PRIMARY KEY,
      proposal_id TEXT,
      run_id TEXT,
      account_number TEXT NOT NULL,
      source TEXT NOT NULL,
      symbol TEXT NOT NULL,
      side TEXT NOT NULL,
      quantity REAL NOT NULL,
      price REAL NOT NULL,
      notional REAL NOT NULL,
      status TEXT NOT NULL,
      broker_order_id TEXT,
      raw TEXT,
      filled_at TEXT NOT NULL,
      execution_mode TEXT
    );

    CREATE TABLE IF NOT EXISTS notification_events (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      webhook_url TEXT,
      payload TEXT NOT NULL,
      error TEXT
    );

    CREATE TABLE IF NOT EXISTS historical_fundamentals (
      symbol TEXT NOT NULL,
      field TEXT NOT NULL,
      value REAL NOT NULL,
      provider TEXT NOT NULL,
      effective_at TEXT NOT NULL,
      fetched_at TEXT NOT NULL,
      PRIMARY KEY (symbol, field, provider, effective_at)
    );

    -- Shared latest market fields (per-field as_of + fetched_at). See migration v69.
    CREATE TABLE IF NOT EXISTS symbol_field_latest (
      symbol TEXT NOT NULL,
      field TEXT NOT NULL,
      value_json TEXT NOT NULL,
      source TEXT NOT NULL,
      as_of TEXT NOT NULL,
      fetched_at TEXT NOT NULL,
      PRIMARY KEY (symbol, field)
    );
    CREATE INDEX IF NOT EXISTS idx_symbol_field_latest_fetched
      ON symbol_field_latest (fetched_at);
    CREATE INDEX IF NOT EXISTS idx_symbol_field_latest_as_of
      ON symbol_field_latest (as_of);

    -- history_cache_eod.source: which cascade tier last wrote the bar (migration v71).

    CREATE INDEX IF NOT EXISTS idx_portfolio_snapshots_account ON portfolio_snapshots (account_number, created_at);
    CREATE INDEX IF NOT EXISTS idx_fill_events_account ON fill_events (account_number, filled_at);
    CREATE INDEX IF NOT EXISTS idx_notification_events_created ON notification_events (created_at);

    -- Atomic dedupe reservations for option alerts. Dashboard snapshots invoke the option-alert
    -- check CONCURRENTLY, and each used to read the "already sent" set BEFORE any event row was
    -- inserted, so two concurrent requests could both deliver the same (account, symbol, alertType)
    -- alert. The UNIQUE constraint makes claiming the alert atomic: the first INSERT OR IGNORE wins
    -- (changes=1 => this caller delivers); a concurrent one no-ops (changes=0 => skip). Rows are
    -- released (deleted) when the send did NOT actually deliver, so a disabled/failed alert can
    -- still be delivered on a later cycle (matches the historical status='sent'-only dedupe).
    CREATE TABLE IF NOT EXISTS option_alert_reservations (
      user_id TEXT NOT NULL,
      connected_account_id TEXT NOT NULL DEFAULT '',
      symbol TEXT NOT NULL,
      alert_type TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(user_id, connected_account_id, symbol, alert_type)
    );

    -- Multi-user API key storage (scaffolding for future multi-user support)
    CREATE TABLE IF NOT EXISTS user_api_keys (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      service TEXT NOT NULL,
      api_key TEXT NOT NULL,
      label TEXT,
      plan_tier TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(user_id, service)
    );
    CREATE INDEX IF NOT EXISTS idx_user_api_keys_user ON user_api_keys (user_id);

    -- Multi-account storage
    CREATE TABLE IF NOT EXISTS connected_accounts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      broker TEXT NOT NULL,
      environment TEXT NOT NULL,
      account_number TEXT,
      label TEXT NOT NULL,
      api_key TEXT,
      api_secret TEXT,
      taxation_type TEXT,
      base_url TEXT,
      is_active INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL

    );
    CREATE INDEX IF NOT EXISTS idx_connected_accounts_user ON connected_accounts (user_id);

    -- Synthetic trailing-stop registry (R2). Tracks the high/low watermark + trail settings for
    -- positions whose broker can't host a native trailing stop (e.g. Robinhood MCP). The monitor
    -- computes triggers from this; placing the exit order is a separate, gated step.
    CREATE TABLE IF NOT EXISTS synthetic_trailing_stops (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      account_number TEXT NOT NULL,
      symbol TEXT NOT NULL,
      side TEXT NOT NULL,
      quantity REAL NOT NULL,
      entry_price REAL NOT NULL,
      extreme_price REAL NOT NULL,
      trail_percent REAL,
      trail_amount REAL,
      status TEXT NOT NULL DEFAULT 'active',
      last_price REAL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      suspect_price REAL,
      suspect_count INTEGER NOT NULL DEFAULT 0,
      UNIQUE(user_id, account_number, symbol)
    );
    CREATE INDEX IF NOT EXISTS idx_synthetic_stops_account ON synthetic_trailing_stops (user_id, account_number);

    -- Broker-held protective stops: the resting protective order id placed at the broker for an open
    -- position, so it can be cancelled when the position closes (no orphaned stops). One per (user,
    -- account, symbol). Distinct from synthetic_trailing_stops, which is the app-side monitor.
    -- kind 'fixed' = stop-market at stopLossPct below entry (Robinhood, opt-in);
    -- kind 'trailing' = native Alpaca trailing_stop (trail_percent) or a Robinhood stop-market the
    -- reconciler ratchets upward each tick (trail_percent records the configured trail distance).
    CREATE TABLE IF NOT EXISTS broker_protective_stops (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      account_number TEXT NOT NULL,
      symbol TEXT NOT NULL,
      broker_order_id TEXT NOT NULL,
      quantity REAL NOT NULL,
      stop_price REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'resting',
      kind TEXT NOT NULL DEFAULT 'fixed',
      trail_percent REAL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(user_id, account_number, symbol)
    );
    CREATE INDEX IF NOT EXISTS idx_broker_protective_stops_account ON broker_protective_stops (user_id, account_number);

    -- Take-profit trim ratchet: the highest take-profit "band" (floor(returnPct / takeProfitPct)) at
    -- which a partial trim has already been emitted for an open position. Monotonic per (user, account,
    -- symbol) so a partial take-profit trims once per band instead of laddering out every run; cleared
    -- when the position closes. One row per open profitable position.
    CREATE TABLE IF NOT EXISTS take_profit_trims (
      user_id TEXT NOT NULL,
      account_number TEXT NOT NULL,
      symbol TEXT NOT NULL,
      band INTEGER NOT NULL,
      -- Position cost basis at the time the band was recorded. The ratchet is keyed to this lot: if the
      -- current position's average cost no longer matches, it's a new lot (close+rebuy) and the band resets.
      avg_cost REAL NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, account_number, symbol)
    );

    -- Per-position stop plan: the LLM's chosen stop-loss TYPE (StopPlanStyle) for an open position,
    -- set at opening-fill time and read by every stop-enforcement layer for the position's life.
    -- Monotonic per (user, account, symbol) like take_profit_trims above; keyed to the lot's cost
    -- basis so a close+rebuy starts fresh instead of inheriting a stale plan. Cleared when the
    -- position closes. One row per open position that has an explicit (non-"default") plan.
    CREATE TABLE IF NOT EXISTS position_stop_plans (
      user_id TEXT NOT NULL,
      account_number TEXT NOT NULL,
      symbol TEXT NOT NULL,
      style TEXT NOT NULL,
      rationale TEXT,
      avg_cost REAL NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      side TEXT NOT NULL DEFAULT 'long',
      opening_order_id TEXT,
      resolved_stop_pct REAL,
      stop_price REAL,
      entry_atr_pct REAL,
      trail_percent REAL,
      take_profit_price REAL,
      max_holding_until TEXT,
      invalidation TEXT,
      PRIMARY KEY (user_id, account_number, symbol)
    );

    -- A "fixed"/"atr" stop plan on Alpaca/Tradier is enforced via a broker-NATIVE bracket order
    -- (order_class bracket/otoco) attached at opening-fill time; position_stop_plans.opening_order_id
    -- tracks that order's ID. When the plan later changes away from fixed/atr (reset to trailing/
    -- none/default, or the row is cleared on close), the bracket's still-resting take-profit/stop-
    -- loss legs from that EARLIER opening are not automatically torn down — enrichOpeningProposal
    -- only strips bracket fields from the NEW order being placed, and has no reach into an already-
    -- resting broker order (this was the long-deferred "OCO sibling-identity pairing" gap, PR #1331/
    -- #1371). recordStopPlan/clearStopPlans enqueue a row here (best-effort) whenever they detect
    -- this transition; reconcilePendingBracketTeardowns (broker-protective-stops.ts) sweeps it,
    -- asking the broker gateway to identify and cancel the sibling legs by the tracked order ID.
    CREATE TABLE IF NOT EXISTS pending_bracket_teardowns (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      account_number TEXT NOT NULL,
      symbol TEXT NOT NULL,
      order_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_pending_bracket_teardowns_account
      ON pending_bracket_teardowns(user_id, account_number);

    -- Every broker-native bracket order EVER placed for a (user, account, symbol) while its plan
    -- sits at "fixed"/"atr", appended on each fill — NOT just the latest. A single opening_order_id
    -- scalar column can't represent this: a same-style scale-in places a BRAND-NEW, independently
    -- resting bracket sized ONLY to its own added shares (Alpaca: orderArgs.qty from the order's own
    -- quantity; Tradier: each exit leg sized to that order's wholeQty) — it does NOT replace or
    -- resize the PRIOR bracket, which is still the genuine, still-needed protection for the
    -- pre-existing lot. Tearing down the prior bracket on a mere same-style scale-in (as an earlier,
    -- incomplete fix briefly did) would cancel a live, correct stop-loss/take-profit and leave that
    -- earlier lot with NO protection at all (Codex review, PR #1667). So rows here accumulate across
    -- same-style scale-ins and are ONLY ALL torn down together, via pending_bracket_teardowns, when
    -- the plan genuinely leaves the fixed/atr family (a real style change, or the position closes) —
    -- see enqueueTeardownForAllOpenBrackets in db-api-keys.ts.
    CREATE TABLE IF NOT EXISTS position_stop_plan_open_brackets (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      account_number TEXT NOT NULL,
      symbol TEXT NOT NULL,
      order_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_position_stop_plan_open_brackets_symbol
      ON position_stop_plan_open_brackets(user_id, account_number, symbol);

    -- Multi-user settings
    CREATE TABLE IF NOT EXISTS user_settings (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(user_id, key)
    );

    CREATE TABLE IF NOT EXISTS skipped_candidate_counterfactuals (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      symbol TEXT NOT NULL,
      snapshot_at TEXT NOT NULL,
      ref_price REAL NOT NULL,
      horizon_days INTEGER NOT NULL,
      target_date TEXT NOT NULL,
      status TEXT NOT NULL,
      exit_date TEXT,
      exit_price REAL,
      return_pct REAL,
      score REAL,
      sector TEXT,
      regime TEXT,
      dominant_factor TEXT,
      bulletins TEXT,
      last_checked_at TEXT,
      -- Multi-horizon outcome rows (JSON SocraticOutcomeHorizonRow[]) written at maturation, and the
      -- terminal-unresolvable reason (kill-survivorship: a delisted/renamed symbol becomes status
      -- 'unresolvable' with a reason after a bounded recheck window instead of pending forever).
      outcomes TEXT,
      resolution_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(user_id, run_id, symbol, horizon_days)
    );
    CREATE INDEX IF NOT EXISTS idx_skipped_counterfactuals_user_status_target ON skipped_candidate_counterfactuals (user_id, status, target_date);
    CREATE INDEX IF NOT EXISTS idx_skipped_counterfactuals_user_return ON skipped_candidate_counterfactuals (user_id, return_pct);

    CREATE TABLE IF NOT EXISTS counterfactual_learning_watermarks (
      user_id TEXT NOT NULL,
      connected_account_id TEXT NOT NULL DEFAULT '',
      last_audit_rowid INTEGER,
      last_audit_created_at TEXT,
      last_audit_id TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, connected_account_id)
    );

    -- Unified append-only ledger of EVERY autonomous learning mutation (panel P0-4). One canonical row per
    -- gated mutation (factor-weight applies today; any future auto-tuning), carrying before/after snapshots,
    -- the subsystem, the trigger/run id, the OOS/statistical evidence, and the flag in effect. Recording is
    -- passive/always-on (it only writes an audit trail; it changes no trading behavior). The admin revert
    -- route reads a row and restores before_state via setPolicy. Scoped by (user_id, connected_account_id,
    -- subsystem) so a revert cannot cross accounts or subsystems.
    CREATE TABLE IF NOT EXISTS learning_mutations (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      connected_account_id TEXT NOT NULL DEFAULT '',
      subsystem TEXT NOT NULL,
      trigger TEXT,
      run_id TEXT,
      flag TEXT,
      before_state TEXT NOT NULL,
      after_state TEXT NOT NULL,
      evidence TEXT,
      reverted_at TEXT,
      reverted_by TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_learning_mutations_lookup
      ON learning_mutations (user_id, connected_account_id, subsystem, created_at);

    CREATE TABLE IF NOT EXISTS market_data_demands (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      symbol TEXT NOT NULL,
      user_id TEXT NOT NULL,
      status TEXT NOT NULL,
      requested_at TEXT NOT NULL,
      last_requested_at TEXT NOT NULL,
      fulfilled_at TEXT,
      expires_at TEXT NOT NULL,
      UNIQUE(kind, symbol, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_market_data_demands_pending ON market_data_demands (kind, symbol, status, expires_at);
    CREATE INDEX IF NOT EXISTS idx_market_data_demands_user ON market_data_demands (user_id, status, expires_at);

    CREATE TABLE IF NOT EXISTS user_watchlist (
      user_id TEXT NOT NULL,
      symbol TEXT NOT NULL,
      added_at TEXT NOT NULL,
      PRIMARY KEY (user_id, symbol)
    );
    CREATE INDEX IF NOT EXISTS idx_user_watchlist_user ON user_watchlist (user_id);

    CREATE TABLE IF NOT EXISTS price_alerts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      symbol TEXT NOT NULL,
      op TEXT NOT NULL CHECK(op IN ('<', '>')),
      price REAL NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL CHECK(status IN ('armed', 'triggered')),
      created_at TEXT NOT NULL,
      triggered_at TEXT,
      triggered_price REAL
    );
    CREATE INDEX IF NOT EXISTS idx_price_alerts_user_status ON price_alerts (user_id, status, created_at);

    CREATE TABLE IF NOT EXISTS notification_prefs (
      user_id TEXT PRIMARY KEY,
      channels TEXT NOT NULL DEFAULT '[]',
      push_target TEXT NOT NULL DEFAULT '',
      pushover_target TEXT NOT NULL DEFAULT '',
      webhook_url TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS chat_turns (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('user','assistant')),
      text TEXT NOT NULL,
      citations TEXT NOT NULL DEFAULT '[]',
      intent TEXT,
      redacted INTEGER NOT NULL DEFAULT 0,
      model TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chat_turns_user ON chat_turns (user_id, created_at);
    -- client_turn_id (+ its index) is added ONLY by the versioned migration
    -- chat_turns_client_turn_id. Do NOT add migration-era columns or indexes to this
    -- baseline exec: it runs BEFORE applyVersionedMigrations, so on a pre-existing DB
    -- CREATE TABLE IF NOT EXISTS is a no-op and an index referencing a not-yet-ALTERed
    -- column crashes boot ("no such column") — took production down on 2026-07-02.

    CREATE TABLE IF NOT EXISTS llm_usage (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT,
      context TEXT NOT NULL DEFAULT 'unknown',
      key_source TEXT NOT NULL CHECK(key_source IN ('user','operator')),
      prompt_tokens INTEGER,
      completion_tokens INTEGER,
      total_tokens INTEGER,
      cost_usd REAL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_llm_usage_user ON llm_usage (user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_llm_usage_source ON llm_usage (key_source, created_at);

    CREATE TABLE IF NOT EXISTS rag_usage (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL DEFAULT 'local',
      operation TEXT NOT NULL CHECK(operation IN ('embed','rerank','query','upsert')),
      provider TEXT NOT NULL DEFAULT 'voyage',
      model TEXT,
      tokens_in INTEGER,
      tokens_out INTEGER,
      batch_count INTEGER NOT NULL DEFAULT 1,
      cost_est_usd REAL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_rag_usage_user ON rag_usage (user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_rag_usage_op ON rag_usage (operation, created_at);

    CREATE TABLE IF NOT EXISTS user_memory (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      subject TEXT NOT NULL,
      value TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'user_stated',
      confidence REAL NOT NULL DEFAULT 0.5,
      hard INTEGER NOT NULL DEFAULT 0,
      asserted_at TEXT NOT NULL,
      superseded_by TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_user_memory_user ON user_memory (user_id, superseded_by);

    CREATE TABLE IF NOT EXISTS ingested_accessions (
      accession TEXT NOT NULL,
      doc_type TEXT NOT NULL,
      ticker TEXT NOT NULL DEFAULT '',
      indexed_at TEXT NOT NULL,
      chunk_count INTEGER NOT NULL DEFAULT 0,
      pinecone_write_class TEXT NOT NULL DEFAULT 'full-body',
      pinecone_vector_count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (accession, doc_type)
    );
    CREATE TABLE IF NOT EXISTS document_chunks (
      content_hash TEXT NOT NULL,
      symbol TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT '',
      chunk_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (content_hash)
    );
    CREATE INDEX IF NOT EXISTS idx_document_chunks_symbol ON document_chunks (symbol);
    -- Durable "paid but not yet delivered" document-embedding stage (db-embed-stage.ts,
    -- 2026-08-09 embed-once directive). Rows exist only between a successful PAID embed batch
    -- and the successful Pinecone delivery of those vectors; a retry consumes them by exact
    -- (content_hash of the embed-input text, model, revision) instead of re-paying OpenRouter.
    -- vector = Float32Array bytes (dims * 4). Context columns are observability, not replay
    -- inputs — replay always re-runs storeContexts/storeDocument from the source document.
    CREATE TABLE IF NOT EXISTS embed_stage (
      content_hash TEXT NOT NULL,
      model TEXT NOT NULL,
      revision TEXT NOT NULL,
      dims INTEGER NOT NULL,
      vector BLOB NOT NULL,
      symbol TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT '',
      chunk_id TEXT NOT NULL DEFAULT '',
      user_scope TEXT NOT NULL DEFAULT 'local',
      created_at TEXT NOT NULL,
      PRIMARY KEY (content_hash, model, revision)
    );
    CREATE INDEX IF NOT EXISTS idx_embed_stage_created ON embed_stage (created_at);
    CREATE TABLE IF NOT EXISTS learned_context (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'private' CHECK(scope IN ('private','shared')),
      kind TEXT NOT NULL CHECK(kind IN ('pattern','decision','fact')),
      subject TEXT NOT NULL,
      symbol TEXT,
      value TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'inferred',
      origin TEXT NOT NULL CHECK(origin IN ('chat','autonomous','ingest')),
      risk_tier TEXT NOT NULL DEFAULT 'fact' CHECK(risk_tier IN ('fact','risk','strategy-directive')),
      confidence REAL NOT NULL DEFAULT 0.5,
      contributor_user_id TEXT,
      asserted_at TEXT NOT NULL,
      superseded_by TEXT,
      expires_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_learned_context_user ON learned_context (user_id, scope, superseded_by);
    CREATE INDEX IF NOT EXISTS idx_learned_context_symbol ON learned_context (symbol, scope, superseded_by);
    CREATE TABLE IF NOT EXISTS learned_context_pending (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'private' CHECK(scope IN ('private','shared')),
      kind TEXT NOT NULL CHECK(kind IN ('pattern','decision','fact')),
      subject TEXT NOT NULL,
      symbol TEXT,
      value TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'inferred',
      origin TEXT NOT NULL CHECK(origin IN ('chat','autonomous','ingest')),
      risk_tier TEXT NOT NULL CHECK(risk_tier IN ('risk','strategy-directive')),
      classifier_reason TEXT,
      created_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
      resolved_at TEXT,
      review_note TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_learned_context_pending_user ON learned_context_pending (user_id, status, created_at);

    CREATE TABLE IF NOT EXISTS socratic_decisions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      connected_account_id TEXT,
      run_id TEXT,
      proposal_id TEXT,
      account_number TEXT,
      symbol TEXT,
      side TEXT,
      status TEXT NOT NULL,
      authority TEXT NOT NULL,
      thesis TEXT NOT NULL,
      rationale TEXT NOT NULL,
      green_team_rationale TEXT,
      sizing_snapshot TEXT,
      action TEXT NOT NULL,
      thesis_tag TEXT,
      regime TEXT,
      confidence_score REAL,
      notional REAL,
      model TEXT,
      red_team TEXT,
      policy_decision TEXT,
      evidence TEXT NOT NULL DEFAULT '[]',
      rag_attributions TEXT NOT NULL DEFAULT '[]',
      dissent TEXT NOT NULL DEFAULT '[]',
      outcome TEXT,
      autonomy_override TEXT,
      lessons TEXT NOT NULL DEFAULT '[]',
      coach_notes TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_socratic_decisions_user_created ON socratic_decisions (user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_socratic_decisions_run ON socratic_decisions (user_id, run_id);
    CREATE INDEX IF NOT EXISTS idx_socratic_decisions_proposal ON socratic_decisions (user_id, proposal_id);

    CREATE TABLE IF NOT EXISTS socratic_framework_proposals (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      connected_account_id TEXT,
      decision_id TEXT,
      run_id TEXT,
      status TEXT NOT NULL,
      priority TEXT NOT NULL,
      subsystem TEXT NOT NULL,
      title TEXT NOT NULL,
      rationale TEXT NOT NULL,
      proposed_change TEXT NOT NULL,
      evidence TEXT NOT NULL DEFAULT '[]',
      owner_verb TEXT,
      owner_response TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_socratic_framework_user_status ON socratic_framework_proposals (user_id, status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_socratic_framework_run ON socratic_framework_proposals (user_id, run_id);

    CREATE TABLE IF NOT EXISTS api_health_log (
      id TEXT PRIMARY KEY,
      service TEXT NOT NULL,
      ts TEXT NOT NULL,
      ok INTEGER NOT NULL CHECK(ok IN (0,1)),
      latency_ms INTEGER,
      error_text TEXT,
      key_source TEXT,
      user_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_api_health_log_service_ts ON api_health_log (service, ts DESC);

    CREATE TABLE IF NOT EXISTS api_health_error_patterns (
      id TEXT PRIMARY KEY,
      service TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      error_text TEXT NOT NULL,
      first_seen TEXT NOT NULL,
      last_seen TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 1,
      key_source TEXT NOT NULL DEFAULT '',
      UNIQUE(service, fingerprint, key_source)
    );
    CREATE INDEX IF NOT EXISTS idx_api_health_error_patterns_service ON api_health_error_patterns (service, last_seen DESC);

    -- congress.trade (App A) return-path receiver: a local, writable EOD cache that App A's
    -- gap-fill push lands in (POST /api/admin/securities/import). App B's own price history is the
    -- live fetchDailyOHLC cascade, NOT a writable store — these three tables ARE that writable store
    -- so imported closes can warm a cache-aside tier and displace a re-fetch. Keyed ticker+date,
    -- idempotent upsert. 'origin' records who supplied the row (default 'app-a') so a round-trip of
    -- App B's own outbound push is never re-stored. See src/lib/db-securities-import.ts.
    CREATE TABLE IF NOT EXISTS imported_securities_ref (
      ticker TEXT PRIMARY KEY,
      company_name TEXT,
      sector TEXT,
      industry TEXT,
      asset_class TEXT,
      exchange TEXT,
      currency TEXT,
      market_cap REAL,
      cik TEXT,
      origin TEXT NOT NULL DEFAULT 'app-a',
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS imported_price_eod (
      ticker TEXT NOT NULL,
      date TEXT NOT NULL,
      close REAL NOT NULL,
      volume REAL,
      origin TEXT NOT NULL DEFAULT 'app-a',
      updated_at TEXT NOT NULL,
      PRIMARY KEY (ticker, date)
    );
    CREATE INDEX IF NOT EXISTS idx_imported_price_eod_ticker ON imported_price_eod (ticker, date);
    CREATE TABLE IF NOT EXISTS imported_spx_eod (
      date TEXT PRIMARY KEY,
      close REAL NOT NULL,
      volume REAL,
      origin TEXT NOT NULL DEFAULT 'app-a',
      updated_at TEXT NOT NULL
    );

    -- Socratic-Trade local caching for complete EOD bars (OHLCV), replacing the silent-failing flat-file cache.
    -- Upserted continuously during live strategy runs for fast replay, avoiding expensive API network loops.
    CREATE TABLE IF NOT EXISTS history_cache_eod (
      ticker TEXT NOT NULL,
      date TEXT NOT NULL,
      open REAL,
      high REAL,
      low REAL,
      close REAL NOT NULL,
      volume REAL,
      vwap REAL,
      source TEXT NOT NULL DEFAULT 'unknown',
      updated_at TEXT NOT NULL,
      PRIMARY KEY (ticker, date)
    );
    CREATE INDEX IF NOT EXISTS idx_history_cache_eod_ticker ON history_cache_eod (ticker, date);

    -- Server-side persistence for a POST /api/strategy/tune review (the paid LLM
    -- proposeStrategyTuning output): previously lived only in client React state, so a closed
    -- browser (or a disconnect before Apply) silently lost it. 'result' is the FULL response JSON
    -- (StrategyTuningProposal plus any appended tuning-invariant warnings). See db-tuning-reviews.ts.
    CREATE TABLE IF NOT EXISTS strategy_tuning_reviews (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      connected_account_id TEXT,
      model TEXT,
      reasoning_effort TEXT,
      generated_by TEXT NOT NULL,
      result TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','applied','dismissed')),
      created_at TEXT NOT NULL,
      resolved_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_strategy_tuning_reviews_user_account_status
      ON strategy_tuning_reviews (user_id, connected_account_id, status);

    -- Generic durable backing store for in-memory rate-limiter / circuit-breaker / cooldown state
    -- (src/lib/durable-state.ts's createDurableMap) that must survive a process restart — the app
    -- now auto-deploys on every merge to main, which replaces the running container mid-session, so
    -- any in-memory guard against a real external cap or a real safety cooldown needs to come back
    -- with its pre-restart state intact rather than resetting to "everything is fresh". One JSON
    -- value per (namespace, key); namespace scopes an owning module (e.g. "provider-request-quota",
    -- "order-remediation-cooldown"), key is that module's own key shape (e.g. "provider|credKey").
    CREATE TABLE IF NOT EXISTS durable_state (
      namespace TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (namespace, key)
    );
  `);

  // Migrate tables to include user_id
  const tablesWithUserId = [
    "strategy_runs",
    "trade_proposals",
    "strategy_profiles",
    "portfolio_snapshots",
    "fill_events",
    "notification_events",
    "audit_events"
  ];
  for (const table of tablesWithUserId) {
    const cols = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "user_id")) {
      database.exec(`ALTER TABLE ${table} ADD COLUMN user_id TEXT NOT NULL DEFAULT 'local'`);
      database.exec(`CREATE INDEX IF NOT EXISTS idx_${table}_user ON ${table} (user_id)`);
    }
  }

  const counterfactualWatermarkColumns = database.prepare("PRAGMA table_info(counterfactual_learning_watermarks)").all() as Array<{ name: string }>;
  if (!counterfactualWatermarkColumns.some((column) => column.name === "last_audit_rowid")) {
    database.exec("ALTER TABLE counterfactual_learning_watermarks ADD COLUMN last_audit_rowid INTEGER");
  }

  const columns = database.prepare("PRAGMA table_info(trade_proposals)").all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "account_number")) {
    database.exec("ALTER TABLE trade_proposals ADD COLUMN account_number TEXT NOT NULL DEFAULT ''");
  }
  // Phase 2: persist the reviewed estimated notional so daily accounting is accurate
  // for share-qty market orders (which have no limitPrice to derive notional from).
  if (!columns.some((column) => column.name === "estimated_notional")) {
    database.exec("ALTER TABLE trade_proposals ADD COLUMN estimated_notional REAL");
  }
  // Phase 7: persist thesis tags for learning loop
  if (!columns.some((column) => column.name === "trade_thesis_tag")) {
    database.exec("ALTER TABLE trade_proposals ADD COLUMN trade_thesis_tag TEXT");
    database.exec("ALTER TABLE trade_proposals ADD COLUMN entry_market_regime TEXT");
  }
  // Thesis-tag split-brain backfill (2026-07-10 audit fix): insertProposal historically left
  // these columns NULL while the same tags were already embedded in the proposal JSON, so the
  // learning loop's SQL reads saw an empty column even though the data existed. Self-guarding via
  // the WHERE clause (only touches rows still NULL with a JSON value present) -- safe to re-run
  // every startup, no separate "already applied" marker needed.
  database.exec(
    "UPDATE trade_proposals SET trade_thesis_tag = json_extract(proposal, '$.tradeThesisTag') WHERE trade_thesis_tag IS NULL AND json_extract(proposal, '$.tradeThesisTag') IS NOT NULL"
  );
  database.exec(
    "UPDATE trade_proposals SET entry_market_regime = json_extract(proposal, '$.entryMarketRegime') WHERE entry_market_regime IS NULL AND json_extract(proposal, '$.entryMarketRegime') IS NOT NULL"
  );
  // Proposal staleness: when a run's LLM re-validation re-checks a still-pending proposal,
  // stamp when and why it still stands so the queue can show "re-checked X ago" rather than
  // implying an old idea is still freshly recommended.
  if (!columns.some((column) => column.name === "last_revalidated_at")) {
    database.exec("ALTER TABLE trade_proposals ADD COLUMN last_revalidated_at TEXT");
    database.exec("ALTER TABLE trade_proposals ADD COLUMN revalidation_note TEXT");
  }
  if (!columns.some((column) => column.name === "error_message")) {
    database.exec("ALTER TABLE trade_proposals ADD COLUMN error_message TEXT");
  }
  // MAE/MFE persistence: add excursion columns to fill_events (additive, guarded).
  const fillEventColumns = database.prepare("PRAGMA table_info(fill_events)").all() as Array<{ name: string }>;
  if (!fillEventColumns.some((c) => c.name === "mae")) {
    database.exec("ALTER TABLE fill_events ADD COLUMN mae REAL");
  }
  if (!fillEventColumns.some((c) => c.name === "mfe")) {
    database.exec("ALTER TABLE fill_events ADD COLUMN mfe REAL");
  }

  // Synthetic-stop refire hardening (2026-07-08 MU incident, round 2): per-row exit-attempt state
  // (additive, guarded). fire_generation counts prior protective-exit attempts whose broker order
  // was POSITIVELY confirmed dead — it is monotonic (advance-only; nothing ever resets it back), and
  // the fire path appends "-g<generation>" to the deterministic client_order_id when it is > 0, so a
  // legitimately re-armed stop places under a fresh id instead of 422-colliding forever with a dead
  // order's id. last_attempt_ref_id remembers the client_order_id of the most recent attempt whose
  // outcome is NOT yet confirmed dead (e.g. placement threw after the broker accepted), so an
  // ambiguous retry reuses it verbatim and the broker's own dedupe fails safe toward a 422 instead
  // of a duplicate protective sell.
  const syntheticStopColumns = database.prepare("PRAGMA table_info(synthetic_trailing_stops)").all() as Array<{ name: string }>;
  if (!syntheticStopColumns.some((c) => c.name === "fire_generation")) {
    database.exec("ALTER TABLE synthetic_trailing_stops ADD COLUMN fire_generation INTEGER NOT NULL DEFAULT 0");
  }
  if (!syntheticStopColumns.some((c) => c.name === "last_attempt_ref_id")) {
    database.exec("ALTER TABLE synthetic_trailing_stops ADD COLUMN last_attempt_ref_id TEXT");
  }

  // Outcome engine (Wave 2): multi-horizon outcome rows + terminal-unresolvable reason on
  // skipped-candidate counterfactuals (additive, guarded). See docs/rollouts/2026-07-04-w2-outcome-engine.md.
  const skippedCfColumns = database.prepare("PRAGMA table_info(skipped_candidate_counterfactuals)").all() as Array<{ name: string }>;
  if (!skippedCfColumns.some((c) => c.name === "outcomes")) {
    database.exec("ALTER TABLE skipped_candidate_counterfactuals ADD COLUMN outcomes TEXT");
  }
  if (!skippedCfColumns.some((c) => c.name === "resolution_reason")) {
    database.exec("ALTER TABLE skipped_candidate_counterfactuals ADD COLUMN resolution_reason TEXT");
  }

  // R3: per-account tax treatment (taxable vs Roth/Traditional IRA) on existing DBs.
  const connectedAccountColumns = database.prepare("PRAGMA table_info(connected_accounts)").all() as Array<{ name: string }>;
  if (!connectedAccountColumns.some((column) => column.name === "taxation_type")) {
    database.exec("ALTER TABLE connected_accounts ADD COLUMN taxation_type TEXT");
  }
  if (!connectedAccountColumns.some((column) => column.name === "base_url")) {
    database.exec("ALTER TABLE connected_accounts ADD COLUMN base_url TEXT");
  }
  if (!connectedAccountColumns.some((column) => column.name === "capabilities")) {
    database.exec("ALTER TABLE connected_accounts ADD COLUMN capabilities TEXT");
  }

  // Per-account state isolation: tag user-level state tables with the connected
  // account they belong to (nullable — account-agnostic rows keep NULL). New per-account
  // state (policy/system_state) lives in account_strategy_state above; these columns let
  // run-state, performance-derived learning, audit and notifications be filtered per account.
  const addAccountColumn = (table: string) => {
    const cols = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "connected_account_id")) {
      database.exec(`ALTER TABLE ${table} ADD COLUMN connected_account_id TEXT`);
      database.exec(`CREATE INDEX IF NOT EXISTS idx_${table}_account ON ${table} (user_id, connected_account_id)`);
    }
  };
  for (const table of [
    "strategy_runs",
    "skipped_candidate_counterfactuals",
    "counterfactual_learning_watermarks",
    "audit_events",
    "notification_events"
  ]) {
    addAccountColumn(table);
  }

  // Bind the active account number and policy revision explicitly to the strategy run
  // so retrospective evaluation matches exactly what the run operated against.
  {
    const cols = database.prepare("PRAGMA table_info(strategy_runs)").all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "account_number")) {
      database.exec("ALTER TABLE strategy_runs ADD COLUMN account_number TEXT");
    }
    if (!cols.some((c) => c.name === "policy_revision")) {
      database.exec("ALTER TABLE strategy_runs ADD COLUMN policy_revision TEXT");
    }
  }

  // AI-review advisory column: a single-LLM-call reviewer attaches a per-proposal
  // recommendation (verdict + rationale + optional rewrite) to a pending framework
  // proposal WITHOUT changing the owner verb/status — the owner still makes the final
  // accept/reject/rewrite call. Nullable JSON; absent means "not yet AI-reviewed".
  {
    const cols = database.prepare("PRAGMA table_info(socratic_framework_proposals)").all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "ai_review")) {
      database.exec("ALTER TABLE socratic_framework_proposals ADD COLUMN ai_review TEXT");
    }
  }

  // Alert lifecycle (2026-07-09): acknowledge state on notification_events, so the Alert Center's
  // "Attention" pill can be cleared instead of growing forever (see docs/rollouts for the
  // triage that motivated this). Additive, guarded — existing rows keep acknowledged_at NULL
  // (unacknowledged) until acted on or resolved by the auto-ack sweep in db-notifications.ts.
  const notificationEventColumns = database.prepare("PRAGMA table_info(notification_events)").all() as Array<{ name: string }>;
  if (!notificationEventColumns.some((c) => c.name === "acknowledged_at")) {
    database.exec("ALTER TABLE notification_events ADD COLUMN acknowledged_at TEXT");
    database.exec("CREATE INDEX IF NOT EXISTS idx_notification_events_unacked ON notification_events (user_id, acknowledged_at)");
  }

  // Per-account watermarks need (user_id, connected_account_id) as the PK, but the original table
  // was created with user_id as the SOLE primary key — a nullable column alone can't express
  // per-account rows. Rebuild it once: the account-agnostic watermark becomes connected_account_id=''
  // (empty string, never NULL, so the composite PK upsert is well-defined). Idempotent — guarded on
  // whether connected_account_id is already part of the PK (pk flag > 0).
  {
    const wmCols = database
      .prepare("PRAGMA table_info(counterfactual_learning_watermarks)")
      .all() as Array<{ name: string; pk: number }>;
    const accountInPk = wmCols.some((c) => c.name === "connected_account_id" && c.pk > 0);
    if (!accountInPk) {
      database.exec(`
        CREATE TABLE counterfactual_learning_watermarks_new (
          user_id TEXT NOT NULL,
          connected_account_id TEXT NOT NULL DEFAULT '',
          last_audit_rowid INTEGER,
          last_audit_created_at TEXT,
          last_audit_id TEXT,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (user_id, connected_account_id)
        );
        INSERT OR IGNORE INTO counterfactual_learning_watermarks_new
          (user_id, connected_account_id, last_audit_rowid, last_audit_created_at, last_audit_id, updated_at)
          SELECT user_id, COALESCE(connected_account_id, ''), last_audit_rowid, last_audit_created_at, last_audit_id, updated_at
          FROM counterfactual_learning_watermarks;
        DROP TABLE counterfactual_learning_watermarks;
        ALTER TABLE counterfactual_learning_watermarks_new RENAME TO counterfactual_learning_watermarks;
      `);
    }
  }

  // Rename: legacy "dry_run" proposal status is now "paper".
  database.exec("UPDATE trade_proposals SET status = 'paper' WHERE status = 'dry_run'");

  // Credential-scoped health rows: add key_source + user_id to existing api_health_log tables.
  const healthLogCols = database.prepare("PRAGMA table_info(api_health_log)").all() as Array<{ name: string }>;
  if (healthLogCols.length > 0) {
    if (!healthLogCols.some((c) => c.name === "key_source")) {
      database.exec("ALTER TABLE api_health_log ADD COLUMN key_source TEXT");
    }
    if (!healthLogCols.some((c) => c.name === "user_id")) {
      database.exec("ALTER TABLE api_health_log ADD COLUMN user_id TEXT");
    }
  }
  // Create the composite index unconditionally here — after the column is guaranteed to exist
  // (either from CREATE TABLE on fresh DBs, or from ALTER TABLE above on upgrades).
  // Removed from the main exec block because CREATE TABLE is a no-op on existing tables,
  // so the index ran before ALTER TABLE added the column, causing "no such column: key_source".
  database.exec("CREATE INDEX IF NOT EXISTS idx_api_health_log_service_key ON api_health_log (service, key_source, ts DESC)");
  // api_health_error_patterns: recreate with correct schema when the table predates credential
  // scoping. Two things can be wrong on an existing DB:
  //   (a) key_source column missing entirely, or is TEXT (nullable) instead of TEXT NOT NULL DEFAULT ''
  //   (b) UNIQUE constraint is still (service, fingerprint) — the new ON CONFLICT target
  //       (service, fingerprint, key_source) won't match, so every error-pattern upsert silently
  //       no-ops and failures disappear from the panel.
  // Fix: recreate the table with the correct schema in both cases.
  const healthPatternCols = database.prepare("PRAGMA table_info(api_health_error_patterns)").all() as Array<{ name: string; notnull: number; dflt_value: string | null }>;
  if (healthPatternCols.length > 0) {
    const ksCol = healthPatternCols.find((c) => c.name === "key_source");
    const needsRebuild = !ksCol || ksCol.notnull === 0; // missing or nullable
    if (needsRebuild) {
      // When key_source column is absent, SELECT '''' literal; when nullable column exists use COALESCE.
      // Using COALESCE(key_source, '') on a table without that column raises "no such column".
      const ksExpr = ksCol ? "COALESCE(key_source, '')" : "''";
      database.exec(`
        CREATE TABLE api_health_error_patterns_v2 (
          id TEXT PRIMARY KEY,
          service TEXT NOT NULL,
          fingerprint TEXT NOT NULL,
          error_text TEXT NOT NULL,
          first_seen TEXT NOT NULL,
          last_seen TEXT NOT NULL,
          count INTEGER NOT NULL DEFAULT 1,
          key_source TEXT NOT NULL DEFAULT '',
          UNIQUE(service, fingerprint, key_source)
        );
        INSERT OR IGNORE INTO api_health_error_patterns_v2
          SELECT id, service, fingerprint, error_text, first_seen, last_seen, count, ${ksExpr}
          FROM api_health_error_patterns;
        DROP TABLE api_health_error_patterns;
        ALTER TABLE api_health_error_patterns_v2 RENAME TO api_health_error_patterns;
        CREATE INDEX IF NOT EXISTS idx_api_health_error_patterns_service ON api_health_error_patterns (service, last_seen DESC);
      `);
    }
  }

  // Learning Review "defer" verdict (2026-07-10): the daily reviewer LLM can now leave a pending
  // risk-tier candidate exactly as pending while explaining why it couldn't confidently decide.
  // Additive, guarded — existing rows keep review_note NULL until a review actually defers them.
  const learnedContextPendingColumns = database.prepare("PRAGMA table_info(learned_context_pending)").all() as Array<{ name: string }>;
  if (!learnedContextPendingColumns.some((c) => c.name === "review_note")) {
    database.exec("ALTER TABLE learned_context_pending ADD COLUMN review_note TEXT");
  }

  // Risk cap fix: track when orders were actually placed, not just proposed.
  const tradeProposalColumns = database.prepare("PRAGMA table_info(trade_proposals)").all() as Array<{ name: string }>;
  if (!tradeProposalColumns.some((c) => c.name === "placed_at")) {
    database.exec("ALTER TABLE trade_proposals ADD COLUMN placed_at TEXT");
  }

  // Account deletion race condition: require a draining state to clear broker lock/fills first.
  const connectedAccountDrainingColumns = database.prepare("PRAGMA table_info(connected_accounts)").all() as Array<{ name: string }>;
  if (!connectedAccountDrainingColumns.some((c) => c.name === "is_draining")) {
    database.exec("ALTER TABLE connected_accounts ADD COLUMN is_draining INTEGER DEFAULT 0");
  }

  // Exit-strategy Phase A: confirmation-based bad-tick acceptance (suspect_price, suspect_count)
  const syntheticStopCols = database.prepare("PRAGMA table_info(synthetic_trailing_stops)").all() as Array<{ name: string }>;
  if (!syntheticStopCols.some((c) => c.name === "suspect_price")) {
    database.exec("ALTER TABLE synthetic_trailing_stops ADD COLUMN suspect_price REAL");
  }
  if (!syntheticStopCols.some((c) => c.name === "suspect_count")) {
    database.exec("ALTER TABLE synthetic_trailing_stops ADD COLUMN suspect_count INTEGER NOT NULL DEFAULT 0");
  }

  // Fixed/ATR tick-cadence backstop (Codex review, item 7): fixed/atr stop plans previously had NO
  // protection between strategy runs (excluded from this table entirely — see synthetic-stops.ts).
  // `kind` discriminates a 'trailing' row (extreme ratchets with the high/low-water mark, unchanged
  // behavior) from a 'fixed' row (a static trigger price — the monitor pins extreme_price back to
  // entry_price every tick instead of persisting the ratchet, so the same evaluateStop/fire
  // machinery yields a fixed distance instead of a trail). Defaults existing/legacy rows to
  // 'trailing' (their only prior meaning) so this is purely additive.
  if (!syntheticStopCols.some((c) => c.name === "kind")) {
    database.exec("ALTER TABLE synthetic_trailing_stops ADD COLUMN kind TEXT NOT NULL DEFAULT 'trailing'");
  }

  const now = new Date().toISOString();
  // NOTE: We no longer seed global settings rows for 'policy' and 'strategyPrompt'.
  // These global rows are never read at runtime (all reads go through user_settings and
  // strategy_profiles by userId). The legacy seeds were removed in M3 (2026-06-21).
  migrateGlobalPolicyToLocalUser(database, now);
  ensureDefaultProfile(database, now);
  applySp500DefaultUniverseMigration(database, now);
}

/**
 * ONE-TIME migration (M3, 2026-06-21): copy any existing global-only 'policy' / 'strategyPrompt'
 * rows from the `settings` table into `user_settings` for the 'local' user, so that single-user
 * DBs that were seeded before the per-user migration lose nothing.
 *
 * Guard key prevents the copy from running more than once. After this runs, the global rows
 * become dead weight (never read at runtime) but are not deleted — they are harmless and their
 * presence cannot cause confusion because no runtime code reads them.
 */
const GLOBAL_POLICY_TO_LOCAL_MIGRATION_KEY = "migration:global_policy_to_local_user:2026-06-21";

export function migrateGlobalPolicyToLocalUser(database: Database.Database, now: string): void {
  const applied = database.prepare("SELECT value FROM settings WHERE key = ?").get(GLOBAL_POLICY_TO_LOCAL_MIGRATION_KEY);
  if (applied) return;

  const userId = "local";
  const policyRow = database.prepare("SELECT value FROM settings WHERE key = 'policy'").get() as { value: string } | undefined;
  const promptRow = database.prepare("SELECT value FROM settings WHERE key = 'strategyPrompt'").get() as { value: string } | undefined;

  // Only copy if the user doesn't already have their own user_settings row.
  if (policyRow) {
    const existing = database.prepare("SELECT id FROM user_settings WHERE user_id = ? AND key = 'policy'").get(userId);
    if (!existing) {
      database
        .prepare("INSERT OR IGNORE INTO user_settings (id, user_id, key, value, updated_at) VALUES (?, ?, ?, ?, ?)")
        .run(`${userId}_policy`, userId, "policy", policyRow.value, now);
    }
  }
  if (promptRow) {
    const existing = database.prepare("SELECT id FROM user_settings WHERE user_id = ? AND key = 'strategyPrompt'").get(userId);
    if (!existing) {
      database
        .prepare("INSERT OR IGNORE INTO user_settings (id, user_id, key, value, updated_at) VALUES (?, ?, ?, ?, ?)")
        .run(`${userId}_strategyPrompt`, userId, "strategyPrompt", promptRow.value, now);
    }
  }

  database
    .prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)")
    .run(GLOBAL_POLICY_TO_LOCAL_MIGRATION_KEY, JSON.stringify({ appliedAt: now }), now);
}

function ensureDefaultProfile(database: Database.Database, now: string): void {
  const userId = "local";
  const existing = database.prepare("SELECT COUNT(*) AS count FROM strategy_profiles WHERE user_id = ?").get(userId) as { count: number };
  if (existing.count === 0) {
    // Seed from user_settings (which migrateGlobalPolicyToLocalUser may have just populated)
    // or fall back to the compiled-in defaults. We no longer read from the global settings table.
    const userPolicyRow = database.prepare("SELECT value FROM user_settings WHERE user_id = ? AND key = 'policy'").get(userId) as { value: string } | undefined;
    const userPromptRow = database.prepare("SELECT value FROM user_settings WHERE user_id = ? AND key = 'strategyPrompt'").get(userId) as { value: string } | undefined;
    const rawPolicy = userPolicyRow?.value ?? JSON.stringify(DEFAULT_POLICY);
    const policy = mergePolicy(JSON.parse(rawPolicy) as Partial<TradingPolicy>);
    const prompt = userPromptRow ? (JSON.parse(userPromptRow.value) as string) : DEFAULT_STRATEGY_PROMPT;
    database
      .prepare(
        "INSERT INTO strategy_profiles (id, user_id, name, policy, prompt, scoring_weights, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run("default", userId, "Default Strategy", JSON.stringify(policy), prompt, JSON.stringify(policy.scoringWeights), 1, now, now);
    return;
  }

  const active = database.prepare("SELECT id FROM strategy_profiles WHERE user_id = ? AND active = 1 LIMIT 1").get(userId);
  if (!active) {
    database.prepare("UPDATE strategy_profiles SET active = 1, updated_at = ? WHERE id = (SELECT id FROM strategy_profiles WHERE user_id = ? ORDER BY created_at LIMIT 1)").run(now, userId);
  }
}

export function applySp500DefaultUniverseMigration(database: Database.Database, now: string): void {
  const applied = database
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(SP500_DEFAULT_UNIVERSE_MIGRATION_KEY);
  if (applied) return;

  const migratePolicyJson = (raw: string): TradingPolicy | undefined => {
    try {
      const policy = JSON.parse(raw) as Partial<TradingPolicy>;
      if (!isPristineEmptyUniversePolicy(policy)) return undefined;
      return mergePolicy({ ...policy, includedIndices: ["sp500"] });
    } catch {
      return undefined;
    }
  };

  // NOTE: The global settings.policy row is no longer updated here (M3, 2026-06-21).
  // It is a dead row after the migrateGlobalPolicyToLocalUser migration; the canonical
  // policy for each user lives in user_settings and strategy_profiles.

  const userSettingsPolicies = database
    .prepare("SELECT id, value FROM user_settings WHERE key = 'policy'")
    .all() as Array<{ id: string; value: string }>;
  const updateUserSetting = database.prepare("UPDATE user_settings SET value = ?, updated_at = ? WHERE id = ?");
  for (const row of userSettingsPolicies) {
    const migratedPolicy = migratePolicyJson(row.value);
    if (migratedPolicy) updateUserSetting.run(JSON.stringify(migratedPolicy), now, row.id);
  }

  const defaultProfiles = database
    .prepare("SELECT id, policy FROM strategy_profiles WHERE id = 'default'")
    .all() as Array<{ id: string; policy: string }>;
  const updateProfile = database.prepare("UPDATE strategy_profiles SET policy = ?, scoring_weights = ?, updated_at = ? WHERE id = ?");
  for (const row of defaultProfiles) {
    const migratedPolicy = migratePolicyJson(row.policy);
    if (migratedPolicy) {
      updateProfile.run(JSON.stringify(migratedPolicy), JSON.stringify(migratedPolicy.scoringWeights), now, row.id);
    }
  }

  database
    .prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)")
    .run(SP500_DEFAULT_UNIVERSE_MIGRATION_KEY, JSON.stringify({ appliedAt: now }), now);
}

function isPristineEmptyUniversePolicy(policy: Partial<TradingPolicy>): boolean {
  const additionalSymbols = policy.additionalSymbols ?? [];
  const blocklist = policy.blocklist ?? [];
  return (
    Array.isArray(policy.includedIndices) &&
    policy.includedIndices.length === 0 &&
    Array.isArray(additionalSymbols) &&
    additionalSymbols.length === 0 &&
    Array.isArray(blocklist) &&
    blocklist.length === 0
  );
}

// mergePolicy is needed by ensureDefaultProfile and applySp500DefaultUniverseMigration above,
// which run during migration (before modules are fully loaded). We keep a local copy here
// rather than importing from db-profiles to avoid a module-load-order issue at migrate() time.
// db-profiles.ts exports its own copy for runtime callers.
function mergePolicy(policy: Partial<TradingPolicy>): TradingPolicy {
  // Strip legacy paperMode/dryRun/paperStartingCash keys that may still be present in old stored
  // JSON — these fields were removed. An account's own `environment` (paper/live) is now the sole
  // source of truth for execution mode; there is no policy-level override.
  const legacy = policy as Partial<TradingPolicy> & { dryRun?: boolean; paperMode?: boolean; paperStartingCash?: number };
  const { dryRun: _legacyDryRun, paperMode: _legacyPaperMode, paperStartingCash: _legacyPaperStartingCash, ...policyWithoutLegacyFields } = legacy;
  const merged: TradingPolicy = {
    ...DEFAULT_POLICY,
    ...policyWithoutLegacyFields,
    scoringWeights: normalizeScoringWeights(policy.scoringWeights ?? DEFAULT_POLICY.scoringWeights),
    sectorCaps: policy.sectorCaps ?? DEFAULT_POLICY.sectorCaps,
    riskRules: { ...DEFAULT_POLICY.riskRules, ...(policy.riskRules ?? {}) },
    // Deep-merge tuning like riskRules: a stored policy inherits NEW default tuning keys (e.g. the
    // 2026-07-28 guard enablement) while any key it explicitly set still wins. Keep identical to
    // the copy in db-profiles.ts.
    tuning: { ...DEFAULT_POLICY.tuning, ...(policy.tuning ?? {}) },
    notificationSettings: {
      ...DEFAULT_POLICY.notificationSettings,
      ...(policy.notificationSettings ?? {}),
      enabledEvents:
        policy.notificationSettings?.enabledEvents ?? DEFAULT_POLICY.notificationSettings.enabledEvents
    }
  };
  const explicitDailyPct = typeof policyWithoutLegacyFields.maxDailyPctOfNav === "number" && policyWithoutLegacyFields.maxDailyPctOfNav > 0;
  const explicitDailyNotional = typeof policyWithoutLegacyFields.maxDailyNotional === "number" && policyWithoutLegacyFields.maxDailyNotional > 0;
  if (explicitDailyPct) delete merged.maxDailyNotional;
  else if (explicitDailyNotional) delete merged.maxDailyPctOfNav;
  if ((merged.maxOrderNotional ?? 0) > 100_000) merged.maxOrderNotional = 100_000;
  // FMP module toggles are user-selectable (owner 2026-08-06); defaults remain false.
  // Direct FMP HTTP stays hard-blocked in fmp-common until that ban is lifted.
  return merged;
}

function normalizeScoringWeights(weights: Partial<import("./types").ScoringWeights>): import("./types").ScoringWeights {
  return {
    ...DEFAULT_SCORING_WEIGHTS,
    ...Object.fromEntries(
      Object.entries(weights).map(([key, value]) => [key, Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : 0])
    )
  };
}

// ── Re-exports (barrel) ───────────────────────────────────────────────────────
// Every consumer of `import { X } from "./db"` continues to work unchanged.

export * from "./db-settings";
export * from "./db-learning";
export * from "./db-learning-ledger";
export * from "./db-profiles";
export * from "./db-execution";
export * from "./db-proposals";
export * from "./db-fills";
export * from "./db-notifications";
export * from "./db-fundamentals";
export * from "./db-api-keys";
export * from "./db-health";
export * from "./db-securities-import";
export * from "./db-socratic";
export * from "./db-jobs";
export * from "./db-rag-ingest";
export * from "./db-tuning-reviews";
export * from "./db-provider-dispatch";
export * from "./db-vector-commits";
export * from "./db-durable-state";
export * from "./db-economic-events";
export * from "./db-retrieval-usefulness";
export * from "./db-earningscalls";
export * from "./db-document-abstracts";
export * from "./db-task-journal";
export * from "./db-embed-stage";
export * from "./db-signal-health";
export * from "./db-lookahead-audit";
export * from "./db-device-tokens";
export * from "./db-trade-locks";
export * from "./db-memory-lifecycle";
export * from "./db-overlays";
export * from "./db-idea-sources";
