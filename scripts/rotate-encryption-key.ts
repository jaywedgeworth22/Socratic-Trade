#!/usr/bin/env -S npx tsx
/**
 * ENCRYPTION_KEY rotation for Socratic-Trade.
 *
 * WHY THIS EXISTS: db-api-keys.ts's ENCRYPTION_KEY is a single module-level AES-256-GCM key with
 * NO key-versioning — decryptValue() only ever tries the current key. Swapping ENCRYPTION_KEY
 * without first re-encrypting every existing ciphertext row under the new key silently makes every
 * stored broker API key, connected-account secret, notification-channel token, and Robinhood OAuth
 * token undecryptable (decryptValue fails closed and returns ""). On a live trading app that means
 * broker credentials vanish with no error, breaking order placement for every affected account.
 *
 * This script re-encrypts every affected row from OLD_ENCRYPTION_KEY to NEW_ENCRYPTION_KEY inside a
 * single SQLite transaction, so it is all-or-nothing: if ANY row fails to decrypt under
 * OLD_ENCRYPTION_KEY (wrong key, already-rotated data, corruption), the whole transaction rolls back
 * and nothing is written. Re-running it after a successful rotation is intentionally NOT idempotent
 * against the OLD key — the rows are gone from the old key's readable set by design.
 *
 * Encryption logic (encryptValue/decryptValue/isEncryptedValue) is copied verbatim from
 * src/lib/db-api-keys.ts rather than imported, so this script has zero dependency on the Next.js
 * app's import graph (see eslint.config.mjs's comment on why importing db.ts pulls in a lot) and so
 * a change to the app's crypto is a deliberate, visible diff here too, not a silent drift.
 *
 * USAGE
 *   1. Back up the DB file first. Non-negotiable, and NOT enforced by this script — it has no way
 *      to tell a real backup from a stale one, so do not read a successful run as proof one exists.
 *      `cp data/app.db data/app.db.pre-rotation-$(date +%Y%m%d).bak`
 *   2. Dry run (decrypts every row under OLD key, re-encrypts in memory, verifies round-trip,
 *      writes NOTHING):
 *        DATABASE_URL=file:./data/app.db \
 *        OLD_ENCRYPTION_KEY=<current 64-hex ENCRYPTION_KEY> \
 *        NEW_ENCRYPTION_KEY=<new 64-hex, e.g. `openssl rand -hex 32`> \
 *        npx tsx scripts/rotate-encryption-key.ts --dry-run
 *   3. Apply (same env, single transaction, all-or-nothing):
 *        ...same env... npx tsx scripts/rotate-encryption-key.ts --apply
 *   4. ONLY AFTER a successful --apply, update ENCRYPTION_KEY in Infisical/Coolify to
 *      NEW_ENCRYPTION_KEY and redeploy.
 *   5. Post-deploy, verify with the current (new) key:
 *        DATABASE_URL=file:./data/app.db npx tsx scripts/rotate-encryption-key.ts --verify
 *      (reads ENCRYPTION_KEY from the environment, same as the app does)
 *
 * --verify is also useful standalone (no rotation involved) as a periodic health check that every
 * stored ciphertext row still decrypts under the currently-configured key.
 */

import Database from "better-sqlite3";
import crypto from "crypto";
import { resolve } from "path";
import { existsSync } from "fs";

const ALGORITHM = "aes-256-gcm";
const CIPHERTEXT_VERSION_PREFIX = "v1:";

function isValidKeyHex(value: string | undefined): value is string {
  return !!value && /^[0-9a-f]{64}$/i.test(value.trim());
}

function keyBuffer(hex: string): Buffer {
  return Buffer.from(hex.trim(), "hex");
}

// Verbatim copy of db-api-keys.ts's isEncryptedValue — format check only, not key-specific.
function isEncryptedValue(value: string): boolean {
  if (!value) return false;
  const body = value.startsWith(CIPHERTEXT_VERSION_PREFIX) ? value.slice(CIPHERTEXT_VERSION_PREFIX.length) : value;
  const parts = body.split(":");
  return (
    parts.length === 3 &&
    /^[0-9a-f]{24}$/i.test(parts[0]) &&
    /^[0-9a-f]{32}$/i.test(parts[1]) &&
    /^[0-9a-f]+$/i.test(parts[2])
  );
}

// Verbatim copy of db-api-keys.ts's encryptValue, parameterized by key instead of the module const.
function encryptValueWith(key: Buffer, text: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");
  const authTag = cipher.getAuthTag().toString("hex");
  return `${CIPHERTEXT_VERSION_PREFIX}${iv.toString("hex")}:${authTag}:${encrypted}`;
}

// Same shape as db-api-keys.ts's decryptValue, EXCEPT: it throws on failure instead of swallowing
// it into "". Rotation must know the difference between "wrong key" and "empty string" — silently
// treating a decrypt failure as an empty value is exactly the fail-closed behavior that makes a bad
// rotation invisible in production; here we want it loud and transaction-aborting instead.
function decryptValueWith(key: Buffer, encryptedText: string): string {
  if (!encryptedText || !isEncryptedValue(encryptedText)) {
    throw new Error(`value is not a recognized ciphertext envelope: ${JSON.stringify(encryptedText.slice(0, 12))}...`);
  }
  const versioned = encryptedText.startsWith(CIPHERTEXT_VERSION_PREFIX);
  const body = versioned ? encryptedText.slice(CIPHERTEXT_VERSION_PREFIX.length) : encryptedText;
  const parts = body.split(":");
  const iv = Buffer.from(parts[0], "hex");
  const authTag = Buffer.from(parts[1], "hex");
  const encrypted = parts[2];
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  let decrypted = decipher.update(encrypted, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

function reencrypt(oldKey: Buffer, newKey: Buffer, value: string): string {
  const plaintext = decryptValueWith(oldKey, value);
  return encryptValueWith(newKey, plaintext);
}

function databasePath(): string {
  const value = process.env.DATABASE_URL ?? "file:./data/app.db";
  return resolve(value.replace(/^file:/, ""));
}

/**
 * Open the EXISTING database, never create one.
 *
 * better-sqlite3 creates an empty file for a path that does not exist, which is exactly the wrong
 * behavior here: a mistyped DATABASE_URL or a wrong working directory would silently produce a
 * fresh empty DB, and then every mode reports a cheerful false green — `--dry-run`/`--apply` say
 * "Nothing to do." and `--verify` says "0 FAILED" and exits 0. An operator following the runbook
 * would read that as "rotation succeeded", swap ENCRYPTION_KEY, and only find out later that the
 * real database was never touched and every stored credential is now unreadable. `fileMustExist`
 * turns that into a loud failure at the only moment it is still cheap to fix.
 */
function openDb(): Database.Database {
  const path = databasePath();
  if (!existsSync(path)) {
    console.error(`No database at ${path} — refusing to create one.`);
    console.error("Check DATABASE_URL and your working directory; this script never rotates an empty DB.");
    process.exit(1);
  }
  const db = new Database(path, { fileMustExist: true });
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 60000");
  return db;
}

interface RowPlan {
  table: string;
  id: string;
  column: string;
  currentValue: string;
}

interface SettingsRowPlan {
  key: string;
  field: "accessToken" | "refreshToken";
  currentValue: string;
}

function collectPlainColumnRows(db: Database.Database): RowPlan[] {
  const plans: RowPlan[] = [];

  for (const row of db.prepare("SELECT id, api_key FROM user_api_keys").all() as { id: string; api_key: string }[]) {
    if (row.api_key && isEncryptedValue(row.api_key)) {
      plans.push({ table: "user_api_keys", id: row.id, column: "api_key", currentValue: row.api_key });
    }
  }

  for (const row of db.prepare("SELECT id, api_key, api_secret FROM connected_accounts").all() as {
    id: string;
    api_key: string | null;
    api_secret: string | null;
  }[]) {
    if (row.api_key && isEncryptedValue(row.api_key)) {
      plans.push({ table: "connected_accounts", id: row.id, column: "api_key", currentValue: row.api_key });
    }
    if (row.api_secret && isEncryptedValue(row.api_secret)) {
      plans.push({ table: "connected_accounts", id: row.id, column: "api_secret", currentValue: row.api_secret });
    }
  }

  const NOTIFICATION_COLUMNS = ["pushover_app_token", "twilio_account_sid", "twilio_auth_token", "twilio_from"] as const;
  const notifCols = NOTIFICATION_COLUMNS.join(", ");
  type NotificationPrefsRow = { user_id: string } & Record<(typeof NOTIFICATION_COLUMNS)[number], string | null>;
  for (const row of db.prepare(`SELECT user_id, ${notifCols} FROM notification_prefs`).all() as NotificationPrefsRow[]) {
    for (const col of NOTIFICATION_COLUMNS) {
      const value = row[col];
      if (value && isEncryptedValue(value)) {
        plans.push({ table: "notification_prefs", id: row.user_id, column: col, currentValue: value });
      }
    }
  }

  return plans;
}

function collectSettingsRows(db: Database.Database): SettingsRowPlan[] {
  const plans: SettingsRowPlan[] = [];
  const prefix = "robinhood_mcp_oauth_token:";
  const rows = db
    .prepare("SELECT key, value FROM settings WHERE substr(key, 1, ?) = ?")
    .all(prefix.length, prefix) as { key: string; value: string }[];
  for (const row of rows) {
    let parsed: { accessToken?: string; refreshToken?: string };
    try {
      parsed = JSON.parse(row.value);
    } catch {
      continue; // not JSON — not a token blob this script understands, leave untouched
    }
    if (parsed.accessToken && isEncryptedValue(parsed.accessToken)) {
      plans.push({ key: row.key, field: "accessToken", currentValue: parsed.accessToken });
    }
    if (parsed.refreshToken && isEncryptedValue(parsed.refreshToken)) {
      plans.push({ key: row.key, field: "refreshToken", currentValue: parsed.refreshToken });
    }
  }
  return plans;
}

function runRotation(apply: boolean): void {
  const oldKeyHex = process.env.OLD_ENCRYPTION_KEY?.trim();
  const newKeyHex = process.env.NEW_ENCRYPTION_KEY?.trim();
  if (!isValidKeyHex(oldKeyHex) || !isValidKeyHex(newKeyHex)) {
    console.error("OLD_ENCRYPTION_KEY and NEW_ENCRYPTION_KEY must both be set to 64-char hex strings.");
    process.exit(1);
  }
  if (oldKeyHex === newKeyHex) {
    console.error("OLD_ENCRYPTION_KEY and NEW_ENCRYPTION_KEY are identical — refusing to run.");
    process.exit(1);
  }
  const oldKey = keyBuffer(oldKeyHex);
  const newKey = keyBuffer(newKeyHex);

  const db = openDb();
  const columnRows = collectPlainColumnRows(db);
  const settingsRows = collectSettingsRows(db);
  const total = columnRows.length + settingsRows.length;
  console.log(
    `Found ${columnRows.length} column value(s) and ${settingsRows.length} settings-blob field(s) ` +
      `to re-encrypt (${total} total).`
  );
  if (total === 0) {
    console.log("Nothing to do.");
    console.warn(
      `WARNING: ${databasePath()} holds no encrypted values. Do NOT read this as "rotation complete" — ` +
        "if you expected stored credentials here, you are pointed at the wrong database and swapping " +
        "ENCRYPTION_KEY now would make the real ones unreadable."
    );
    return;
  }

  const doRotation = db.transaction(() => {
    let done = 0;
    for (const plan of columnRows) {
      const rewritten = reencrypt(oldKey, newKey, plan.currentValue);
      if (apply) {
        const idColumn = plan.table === "notification_prefs" ? "user_id" : "id";
        db.prepare(`UPDATE ${plan.table} SET ${plan.column} = ? WHERE ${idColumn} = ?`).run(rewritten, plan.id);
      }
      done++;
    }
    for (const plan of settingsRows) {
      const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(plan.key) as { value: string } | undefined;
      if (!row) continue; // deleted concurrently — skip rather than fail the whole rotation
      const parsed = JSON.parse(row.value);
      parsed[plan.field] = reencrypt(oldKey, newKey, plan.currentValue);
      if (apply) {
        db.prepare("UPDATE settings SET value = ? WHERE key = ?").run(JSON.stringify(parsed), plan.key);
      }
      done++;
    }
    return done;
  });

  try {
    const done = doRotation.immediate();
    if (apply) {
      console.log(`Applied: re-encrypted ${done}/${total} value(s) under the new key. Transaction committed.`);
      console.log("Next: set ENCRYPTION_KEY to NEW_ENCRYPTION_KEY in Infisical/Coolify and redeploy, then run --verify.");
    } else {
      console.log(`Dry run OK: all ${done}/${total} value(s) decrypt under OLD_ENCRYPTION_KEY and re-encrypt cleanly.`);
      console.log("Nothing was written. Re-run with --apply to commit.");
    }
  } catch (error) {
    console.error("Rotation aborted, NOTHING was written (transaction rolled back).");
    console.error(String(error));
    process.exit(1);
  }
}

function runVerify(): void {
  const keyHex = process.env.ENCRYPTION_KEY?.trim();
  if (!isValidKeyHex(keyHex)) {
    console.error("ENCRYPTION_KEY must be set to a 64-char hex string to verify against.");
    process.exit(1);
  }
  const key = keyBuffer(keyHex);
  const db = openDb();
  const columnRows = collectPlainColumnRows(db);
  const settingsRows = collectSettingsRows(db);

  let ok = 0;
  let failed = 0;
  const failures: string[] = [];
  for (const plan of [...columnRows, ...settingsRows]) {
    const label = "table" in plan ? `${plan.table}.${plan.column} id=${plan.id}` : `settings ${plan.key}.${plan.field}`;
    try {
      decryptValueWith(key, plan.currentValue);
      ok++;
    } catch (error) {
      failed++;
      failures.push(`${label}: ${String(error)}`);
    }
  }

  console.log(`Verified ${ok + failed} ciphertext value(s): ${ok} decrypt OK, ${failed} FAILED under current ENCRYPTION_KEY.`);
  if (ok + failed === 0) {
    // Not an error — a DB with no stored credentials is a legitimate state — but "0 of 0 OK" is not
    // evidence a rotation worked, and it is what a wrong (but existing) database also looks like.
    console.warn(
      `WARNING: found no encrypted values at all in ${databasePath()}. ` +
        "That is only meaningful if you expect zero stored credentials; otherwise you are pointed at the wrong database."
    );
  }
  if (failed > 0) {
    console.error("Failures:");
    for (const line of failures) console.error(`  - ${line}`);
    process.exit(1);
  }
}

const mode = process.argv[2];
if (mode === "--dry-run") runRotation(false);
else if (mode === "--apply") runRotation(true);
else if (mode === "--verify") runVerify();
else {
  console.error("Usage: rotate-encryption-key.ts --dry-run | --apply | --verify");
  console.error("See the file header for the full runbook.");
  process.exit(1);
}
