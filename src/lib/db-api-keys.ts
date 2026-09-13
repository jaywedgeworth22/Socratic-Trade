// db-api-keys.ts — field-level encryption, user API keys, connected accounts,
// synthetic stops, watchlist, price alerts, notify prefs, chat turns, memory,
// and the catch-all listUsers helper.
import "server-only";
import crypto from "crypto";
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { getDb, audit } from "./db";
import { normalizeSymbol } from "./money";
import { registerPlanTierLookup } from "./provider-tier-plan";
import type {
  AccountCapabilities,
  ChatTurn,
  ChatTurnRole,
  ConnectedAccount,
  EquityPosition,
  MemoryItem,
  NotifyChannelId,
  NotifyPrefs,
  NotifyPrefsSecrets,
  PriceAlert,
  PriceAlertOp,
  PriceAlertStatus,
  StopPlanStyle,
  WatchlistItem
} from "./types";
import { STOP_PLAN_STYLES } from "./types";
import { invalidateDashboardSnapshotCache } from "./dashboard-snapshot-cache";

// ── Field-Level Encryption ──────────────────────────────────────────────────

// Load .env.local and local development secrets files for local system development (production uses Infisical)
if (process.env.NODE_ENV !== "test" && !process.env.VITEST && process.env.NODE_ENV !== "production" && !process.env.COOLIFY_PROD_PHASE2) {
  const envPaths = [
    resolve(process.cwd(), ".env.local"),
    "/Users/jay/.secrets/global-api-keys.env",
    "/Users/jay/.secrets/global-api-keys"
  ];
  for (const envPath of envPaths) {
    try {
      if (existsSync(envPath)) {
        const content = readFileSync(envPath, "utf8");
        for (const line of content.split("\n")) {
          const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
          if (match && match[1]) {
            const key = match[1];
            if (!process.env[key]) {
              let value = match[2] || "";
              if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
              if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
              process.env[key] = value;
            }
          }
        }
      }
    } catch {
      // Ignore error
    }
  }
}

const IS_TEST_ENV = process.env.NODE_ENV === "test" || !!process.env.VITEST;

/** A valid ENCRYPTION_KEY is a 64-char hex string (32 bytes) — anything else can't key AES-256-GCM. */
export function isValidEncryptionKeyHex(value: string | undefined): value is string {
  return !!value && /^[0-9a-f]{64}$/i.test(value.trim());
}

const RAW_ENCRYPTION_KEY = process.env.ENCRYPTION_KEY?.trim();
const ENCRYPTION_KEY_CONFIGURED = isValidEncryptionKeyHex(RAW_ENCRYPTION_KEY);

if (!IS_TEST_ENV && !ENCRYPTION_KEY_CONFIGURED) {
  // Deterministic dev/local warning path. PRODUCTION instead REFUSES to boot for this same
  // condition — see assertEncryptionKeyConfiguredInProduction below, called from
  // instrumentation.ts before any request is served. A per-process random key here means every
  // credential encrypted during this run becomes unreadable the moment the process restarts.
  console.warn(
    RAW_ENCRYPTION_KEY
      ? "[db-api-keys] ENCRYPTION_KEY is set but is not a valid 64-char hex string (32 bytes) — " +
        "falling back to a per-process random key for THIS RUN ONLY. Credentials encrypted now " +
        "will be UNREADABLE after restart. Regenerate with: openssl rand -hex 32."
      : "[db-api-keys] ENCRYPTION_KEY is not set — using a per-process random key for THIS RUN " +
        "ONLY. Credentials encrypted now will be UNREADABLE after restart. Set ENCRYPTION_KEY " +
        "(openssl rand -hex 32) for any environment where data must persist across restarts."
  );
}

// Fallback to a memory-only key when unset/invalid (keys will be lost on restart!). Production
// never reaches this silently — see assertEncryptionKeyConfiguredInProduction. (Calls
// isValidEncryptionKeyHex directly, rather than reusing ENCRYPTION_KEY_CONFIGURED, so TS narrows
// RAW_ENCRYPTION_KEY to `string` in the true branch.)
const ENCRYPTION_KEY = isValidEncryptionKeyHex(RAW_ENCRYPTION_KEY) ? Buffer.from(RAW_ENCRYPTION_KEY, "hex") : crypto.randomBytes(32);
const ALGORITHM = "aes-256-gcm";

/**
 * Refuse to boot in PRODUCTION when ENCRYPTION_KEY is missing or malformed. A real-money trading
 * app must never silently mint a per-process ephemeral encryption key: stored broker
 * credentials/OAuth tokens would become unreadable after every restart, and any legacy plaintext
 * rows would have no path to ever get encrypted. Call from the Node-runtime boot hook
 * (instrumentation.ts's `register()`), before any request is served or any credential is read.
 * Intentionally independent of whether the DB already holds ciphertext — see the separate,
 * broader-than-production `assertEncryptionKeyAvailable` in db.ts for that (dev+prod) check.
 */
export function assertEncryptionKeyConfiguredInProduction(env: NodeJS.ProcessEnv = process.env): void {
  if (env.NODE_ENV !== "production") return;
  if (isValidEncryptionKeyHex(env.ENCRYPTION_KEY?.trim())) return;
  throw new Error(
    "ENCRYPTION_KEY is missing or invalid in production. Refusing to boot: a per-process " +
    "ephemeral encryption key would make stored broker/API credentials unreadable after every " +
    "restart. Set ENCRYPTION_KEY to a 64-char hex string (openssl rand -hex 32) before starting."
  );
}

/** Prefix marking the current (v1) ciphertext envelope, so a future key-rotation/format change can
 *  add v2 alongside it without breaking existing rows. Bump this (and add a v2 branch to
 *  decryptValue) the next time the envelope format changes — never repurpose v1. */
const CIPHERTEXT_VERSION_PREFIX = "v1:";

/**
 * AES-256-GCM encrypt a string to the versioned `v1:iv:authTag:ciphertext` (all hex after the
 * prefix) envelope. Uses the process `ENCRYPTION_KEY` (or a memory-only key when unset/invalid).
 * Exported so other at-rest secrets (e.g. Robinhood OAuth tokens in mcp-oauth.ts) reuse the SAME
 * field-level encryption + the legacy-plaintext-tolerant `decryptValue` below, rather than
 * duplicating the crypto.
 */
export function encryptValue(text: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, ENCRYPTION_KEY, iv);
  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");
  const authTag = cipher.getAuthTag().toString("hex");
  return `${CIPHERTEXT_VERSION_PREFIX}${iv.toString("hex")}:${authTag}:${encrypted}`;
}

/**
 * Strict detector for "is this value already one of our AES-GCM envelopes" — versioned or
 * legacy-bare. Used by the migration sweep AND by `decryptValue` (P0-5: reject plaintext).
 * Validates each part's exact hex shape (12-byte iv, 16-byte authTag, hex ciphertext) rather
 * than just counting colons, so a plaintext secret that happens to contain two colons is never
 * mistaken for ciphertext.
 */
export function isEncryptedValue(value: string): boolean {
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

/**
 * Decrypt a value produced by `encryptValue`. Handles TWO encrypted shapes:
 *   1. Current `v1:iv:tag:ct` envelope (the CIPHERTEXT_VERSION_PREFIX above).
 *   2. The PRE-VERSIONING bare `iv:tag:ct` envelope (no prefix).
 *
 * P0-5 (2026-08-05): legacy PLAINTEXT is NO LONGER returned. Non-envelope input yields `""`
 * (fail closed for credential consumers). Boot-time `migrateLegacyPlaintextCredentials` re-encrypts
 * leftover plaintext rows via `isEncryptedValue` + `encryptValue` and never needs this fallback.
 * Exported for reuse by other at-rest secret stores (see encryptValue).
 */
export function decryptValue(encryptedText: string): string {
  if (!encryptedText || !isEncryptedValue(encryptedText)) {
    return "";
  }
  try {
    const versioned = encryptedText.startsWith(CIPHERTEXT_VERSION_PREFIX);
    const body = versioned ? encryptedText.slice(CIPHERTEXT_VERSION_PREFIX.length) : encryptedText;
    const parts = body.split(":");
    const iv = Buffer.from(parts[0], "hex");
    const authTag = Buffer.from(parts[1], "hex");
    const encrypted = parts[2];
    const decipher = crypto.createDecipheriv(ALGORITHM, ENCRYPTION_KEY, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encrypted, "hex", "utf8");
    decrypted += decipher.final("utf8");
    return decrypted;
  } catch (e) {
    console.error("Failed to decrypt field:", e);
    return "";
  }
}

export interface CredentialEncryptionMigrationResult {
  apiKeysMigrated: number;
  connectedAccountFieldsMigrated: number;
}

/**
 * One-time, idempotent sweep that re-encrypts any legacy PLAINTEXT credential rows in place, now
 * that a valid ENCRYPTION_KEY is available. Safe to call on every boot: already-encrypted rows
 * (current `v1:` envelope OR the pre-versioning bare envelope) are left untouched via
 * isEncryptedValue; only genuine plaintext rows (from before field-level encryption existed) are
 * re-written. Every run that actually migrates something is audited. Covers the two tables this
 * module owns (`user_api_keys`, `connected_accounts`); Robinhood OAuth token blobs in `settings`
 * are re-encrypted by mcp-oauth.ts's own migration using the same encryptValue/decryptValue.
 */
export function migrateLegacyPlaintextCredentials(): CredentialEncryptionMigrationResult {
  const db = getDb();
  let apiKeysMigrated = 0;
  let connectedAccountFieldsMigrated = 0;

  const apiKeyRows = db.prepare("SELECT id, api_key FROM user_api_keys").all() as { id: string; api_key: string }[];
  for (const row of apiKeyRows) {
    if (!row.api_key || isEncryptedValue(row.api_key)) continue;
    db.prepare("UPDATE user_api_keys SET api_key = ? WHERE id = ?").run(encryptValue(row.api_key), row.id);
    apiKeysMigrated++;
  }

  const accountRows = db
    .prepare("SELECT id, api_key, api_secret FROM connected_accounts")
    .all() as { id: string; api_key: string | null; api_secret: string | null }[];
  for (const row of accountRows) {
    const sets: string[] = [];
    const params: string[] = [];
    if (row.api_key && !isEncryptedValue(row.api_key)) {
      sets.push("api_key = ?");
      params.push(encryptValue(row.api_key));
      connectedAccountFieldsMigrated++;
    }
    if (row.api_secret && !isEncryptedValue(row.api_secret)) {
      sets.push("api_secret = ?");
      params.push(encryptValue(row.api_secret));
      connectedAccountFieldsMigrated++;
    }
    if (sets.length > 0) {
      params.push(row.id);
      db.prepare(`UPDATE connected_accounts SET ${sets.join(", ")} WHERE id = ?`).run(...params);
    }
  }

  if (apiKeysMigrated > 0 || connectedAccountFieldsMigrated > 0) {
    audit("credential_encryption_migration", { apiKeysMigrated, connectedAccountFieldsMigrated });
  }
  return { apiKeysMigrated, connectedAccountFieldsMigrated };
}

/**
 * Boot-time entry point for the sweep above: only runs when a REAL (non-ephemeral) ENCRYPTION_KEY
 * is configured. Re-encrypting plaintext rows under a throwaway per-process key would make that
 * data LESS recoverable, not more (the key vanishes on the next restart) — so this deliberately
 * no-ops on the ephemeral fallback rather than migrating anything.
 */
export function migrateLegacyPlaintextCredentialsIfKeyConfigured(): CredentialEncryptionMigrationResult | null {
  if (!ENCRYPTION_KEY_CONFIGURED) return null;
  return migrateLegacyPlaintextCredentials();
}

// ── Multi-User API Key Storage ──────────────────────────────────────────────

export interface UserApiKey {
  id: string;
  userId: string;
  service: string;
  apiKey: string;
  label?: string;
  /** Declared vendor plan tier (free/power/starter/…). Null/undefined = unknown → free-safe defaults. */
  planTier?: string;
  createdAt: string;
  updatedAt: string;
}

export type ApiKeySource = "user" | "env" | "none";

const API_KEY_ENV_MAP: Record<string, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  xai: "XAI_API_KEY",
  gemini: "GEMINI_API_KEY",
  mistral: "MISTRAL_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  moonshot: "MOONSHOT_API_KEY",
  kimi: "MOONSHOT_API_KEY",
  minimax: "MINIMAX_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  finnhub: "FINNHUB_API_KEY",
  fmp: "FMP_API_KEY",
  alphavantage: "ALPHAVANTAGE_API_KEY",
  roic: "ROIC_API_KEY",
  filingapi: "FILINGAPI",
  marketstack: "MARKETSTACK_API_KEY",
  fred: "FRED_API_KEY",
  sec_edgar_user_agent: "SEC_EDGAR_USER_AGENT",
  massive: "MASSIVE_API_KEY",
  massive_s3_endpoint: "MASSIVE_S3_ENDPOINT",
  massive_bucket: "MASSIVE_BUCKET",
  massive_access_key_id: "MASSIVE_ACCESS_KEY_ID",
  massive_secret_access_key: "MASSIVE_SECRET_ACCESS_KEY",
  pinecone: "PINECONE_API_KEY",
  voyage: "VOYAGE_API_KEY",
  siliconflow: "SILICONFLOW_API_KEY",
  alpaca_paper_api_key: "ALPACA_PAPER_API_KEY",
  alpaca_paper_secret_key: "ALPACA_PAPER_SECRET_KEY",
  apify: "APIFY_API_TOKEN",
  fintechstudios: "FINTECH_STUDIOS_API_KEY",
  powerintell: "FINTECH_STUDIOS_API_KEY",
  tiingo: "TIINGO_API_KEY",
  twelvedata: "TWELVEDATA_API_KEY",
  logodev: "LOGO_DEV_TOKEN",
  logodev_secret: "LOGO_DEV_SECRET_KEY",
  marketaux: "MARKETAUX_API_KEY",
  earningscalls: "EARNINGSCALLS_API_KEY",
  rapidapi: "RAPIDAPI_KEY"
};

const API_KEY_SERVICE_ALIASES: Record<string, string> = {
  alpha_vantage: "alphavantage",
  alphavantage_api_key: "alphavantage",
  finnhub_api_key: "finnhub",
  fmp_api_key: "fmp",
  filing_api: "filingapi",
  filingapi_key: "filingapi",
  filingapi_dev: "filingapi",
  openai_api_key: "openai",
  anthropic_api_key: "anthropic",
  xai_api_key: "xai",
  grok: "xai",
  grok_api_key: "xai",
  xai: "xai",
  gemini: "gemini",
  gemini_api_key: "gemini",
  google_gemini: "gemini",
  google_gemini_api_key: "gemini",
  mistral: "mistral",
  mistral_api_key: "mistral",
  deepseek: "deepseek",
  deepseek_api_key: "deepseek",
  moonshot: "moonshot",
  moonshot_api_key: "moonshot",
  moonshotai: "moonshot",
  moonshotai_api_key: "moonshot",
  kimi: "moonshot",
  kimi_api_key: "moonshot",
  minimax: "minimax",
  minimax_api_key: "minimax",
  openrouter: "openrouter",
  openrouter_api_key: "openrouter",
  marketstack_api_key: "marketstack",
  fred_api_key: "fred",
  fintech_studios: "fintechstudios",
  fintech_studios_api_key: "fintechstudios",
  powerintell_api_key: "fintechstudios",
  power_intell: "fintechstudios",
  power_intell_api_key: "fintechstudios",
  sec_edgar: "sec_edgar_user_agent",
  sec_edgar_user_agent: "sec_edgar_user_agent",
  massive_api_key: "massive",
  pinecone_api_key: "pinecone",
  voyage_api_key: "voyage",
  siliconflow_api_key: "siliconflow",
  alpaca_paper_api_key: "alpaca_paper_api_key",
  alpaca_paper_secret_key: "alpaca_paper_secret_key",
  apify_api_token: "apify",
  tiingo_api_key: "tiingo",
  twelve_data: "twelvedata",
  twelve_data_api_key: "twelvedata",
  twelvedata_api_key: "twelvedata",
  logo_dev: "logodev",
  logo_dev_token: "logodev",
  logodev_token: "logodev",
  logo_dev_secret: "logodev_secret",
  logo_dev_secret_key: "logodev_secret",
  logodev_secret_key: "logodev_secret",
  marketaux_api_key: "marketaux",
  earnings_calls: "earningscalls",
  earningscalls_api_key: "earningscalls",
  rapid_api: "rapidapi",
  rapidapi_key: "rapidapi"
};

function keyRowToApiKey(row: {
  id: string;
  user_id: string;
  service: string;
  api_key: string;
  label: string | null;
  plan_tier?: string | null;
  created_at: string;
  updated_at: string;
}): UserApiKey {
  return {
    id: row.id,
    userId: row.user_id,
    service: row.service,
    apiKey: decryptValue(row.api_key),
    label: row.label ?? undefined,
    planTier: row.plan_tier ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function normalizeApiKeyService(service: string): string {
  const normalized = service.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return API_KEY_SERVICE_ALIASES[normalized] ?? normalized;
}

export function apiKeyEnvVarForService(service: string): string | undefined {
  const canonical = normalizeApiKeyService(service);
  if (canonical === "massive" && !process.env.MASSIVE_API_KEY && process.env.MASSIVE_API_KEY_ALT) {
    return "MASSIVE_API_KEY_ALT";
  }
  if (canonical === "filingapi") {
    for (const envVar of ["FILINGAPI", "FILINGAPI_KEY", "FILING_API_KEY"] as const) {
      if ((process.env[envVar] ?? "").trim()) return envVar;
    }
    return "FILINGAPI";
  }
  return API_KEY_ENV_MAP[canonical];
}

export function listSupportedApiKeyServices(): string[] {
  return Object.keys(API_KEY_ENV_MAP);
}

type UserApiKeyRow = {
  id: string;
  user_id: string;
  service: string;
  api_key: string;
  label: string | null;
  plan_tier: string | null;
  created_at: string;
  updated_at: string;
};

const USER_API_KEY_SELECT =
  "SELECT id, user_id, service, api_key, label, plan_tier, created_at, updated_at FROM user_api_keys";

export function getUserApiKey(userId: string, service: string): UserApiKey | undefined {
  const canonical = normalizeApiKeyService(service);
  const statement = getDb().prepare(`${USER_API_KEY_SELECT} WHERE user_id = ? AND service = ?`);
  const row =
    (statement.get(userId, canonical) as UserApiKeyRow | undefined) ??
    (canonical !== service ? (statement.get(userId, service) as UserApiKeyRow | undefined) : undefined);
  if (!row) return undefined;
  return keyRowToApiKey(row);
}

export function listUserApiKeys(userId: string): UserApiKey[] {
  const rows = getDb()
    .prepare(`${USER_API_KEY_SELECT} WHERE user_id = ? ORDER BY service`)
    .all(userId) as UserApiKeyRow[];
  return rows.map(keyRowToApiKey).filter((k) => k.apiKey !== DELETED_KEY_TOMBSTONE);
}

export function upsertUserApiKey(
  userId: string,
  service: string,
  apiKey: string,
  label?: string,
  planTier?: string | null
): UserApiKey {
  const canonical = normalizeApiKeyService(service);
  const now = new Date().toISOString();
  const id = `${userId}_${canonical}`;
  const encryptedKey = encryptValue(apiKey);
  const existing = getUserApiKey(userId, canonical);
  // Preserve prior plan_tier when the caller omits it (key replace without re-picking tier).
  const nextTier =
    planTier === undefined ? (existing?.planTier ?? null) : planTier === null || planTier === "" ? null : planTier;
  getDb()
    .prepare(
      `INSERT INTO user_api_keys (id, user_id, service, api_key, label, plan_tier, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, service) DO UPDATE SET
         api_key = excluded.api_key,
         label = excluded.label,
         plan_tier = excluded.plan_tier,
         updated_at = excluded.updated_at`
    )
    .run(id, userId, canonical, encryptedKey, label ?? null, nextTier, now, now);
  if (userId === LOCAL_USER && credTierForService(canonical) === "per-user-only") {
    const vars = ALL_SERVICE_ENV_VARS[canonical] ?? (API_KEY_ENV_MAP[canonical] ? [API_KEY_ENV_MAP[canonical]] : []);
    for (const envVar of vars) {
      if (process.env[envVar] !== undefined) {
        delete process.env[envVar];
      }
    }
  }
  return {
    id,
    userId,
    service: canonical,
    apiKey,
    label,
    planTier: nextTier ?? undefined,
    createdAt: now,
    updatedAt: now
  };
}

/**
 * Update only the declared plan tier for an existing key (no re-paste of the secret).
 * Returns undefined when no non-tombstone key row exists for the service.
 */
export function setUserApiKeyPlanTier(
  userId: string,
  service: string,
  planTier: string | null
): UserApiKey | undefined {
  const canonical = normalizeApiKeyService(service);
  const existing = getUserApiKey(userId, canonical);
  const now = new Date().toISOString();
  const nextTier = planTier === null || planTier === "" ? null : planTier;

  // Existing real key (or env-plan marker): just update plan_tier.
  if (existing && existing.apiKey !== DELETED_KEY_TOMBSTONE) {
    getDb()
      .prepare(
        `UPDATE user_api_keys SET plan_tier = ?, updated_at = ? WHERE user_id = ? AND service = ?`
      )
      .run(nextTier, now, userId, canonical);
    return { ...existing, planTier: nextTier ?? undefined, updatedAt: now };
  }

  // No user key yet: allow a tier-only row when an env credential exists for this service
  // (shared-operator-infra market data). Marker is never returned as a secret.
  const envVar = apiKeyEnvVarForService(canonical);
  const envKey = envVar ? (process.env[envVar] ?? "").trim() : "";
  if (!envKey) return undefined;

  const id = `${userId}_${canonical}`;
  const encryptedMarker = encryptValue(ENV_PLAN_TIER_MARKER);
  getDb()
    .prepare(
      `INSERT INTO user_api_keys (id, user_id, service, api_key, label, plan_tier, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, service) DO UPDATE SET
         api_key = excluded.api_key,
         label = excluded.label,
         plan_tier = excluded.plan_tier,
         updated_at = excluded.updated_at`
    )
    .run(id, userId, canonical, encryptedMarker, "plan tier for server key", nextTier, now, now);
  return {
    id,
    userId,
    service: canonical,
    apiKey: ENV_PLAN_TIER_MARKER,
    label: "plan tier for server key",
    planTier: nextTier ?? undefined,
    createdAt: now,
    updatedAt: now
  };
}

export const DELETED_KEY_TOMBSTONE = "__DISABLED__";

/**
 * Marker stored in user_api_keys.api_key when the operator only declares a plan tier for an
 * env-backed service (no secret paste). resolveApiKeyWithSource treats this like "no user key"
 * and falls through to ROIC_API_KEY / TIINGO_API_KEY / etc.
 */
export const ENV_PLAN_TIER_MARKER = "__ENV_PLAN_TIER__";

function isNonSecretKeyMarker(value: string | undefined | null): boolean {
  return value === DELETED_KEY_TOMBSTONE || value === ENV_PLAN_TIER_MARKER;
}

export function deleteUserApiKey(userId: string, service: string): void {
  const canonical = normalizeApiKeyService(service);
  const db = getDb();

  if (credTierForService(canonical) === "shared-operator-infra") {
    db.prepare("DELETE FROM user_api_keys WHERE user_id = ? AND service = ?").run(userId, canonical);
    if (canonical !== service) {
      db.prepare("DELETE FROM user_api_keys WHERE user_id = ? AND service = ?").run(userId, service);
    }
    return;
  }

  const now = new Date().toISOString();
  const id = `${userId}_${canonical}`;
  const encryptedKey = encryptValue(DELETED_KEY_TOMBSTONE);
  db.prepare(
    `INSERT INTO user_api_keys (id, user_id, service, api_key, label, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'disabled by user', ?, ?)
     ON CONFLICT(user_id, service) DO UPDATE SET api_key = excluded.api_key, label = excluded.label, updated_at = excluded.updated_at`
  ).run(id, userId, canonical, encryptedKey, now, now);
  if (canonical !== service) {
    const aliasId = `${userId}_${service}`;
    db.prepare(
      `INSERT INTO user_api_keys (id, user_id, service, api_key, label, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'disabled by user', ?, ?)
       ON CONFLICT(user_id, service) DO UPDATE SET api_key = excluded.api_key, label = excluded.label, updated_at = excluded.updated_at`
    ).run(aliasId, userId, service, encryptedKey, now, now);
  }

  if (userId === LOCAL_USER) {
    const vars = ALL_SERVICE_ENV_VARS[canonical] ?? (API_KEY_ENV_MAP[canonical] ? [API_KEY_ENV_MAP[canonical]] : []);
    for (const envVar of vars) {
      if (process.env[envVar] !== undefined) {
        delete process.env[envVar];
      }
    }
  }
}

// ── Credential tiers (multi-user key resolution) ────────────────────────────
//
// The app behaves multi-user with a default `local` operator user. Tier decides whether the env
// fallback is a GLOBAL fallback (operator-funded shared resource) or operator-only (a credential a
// non-`local` user must not borrow):
//
//   per-user-only         → env serves ONLY `local` (and no-userId background callers, which map
//                           to `local`). A non-`local` user with no stored key fails closed. This
//                           is reserved for isolation/cost-critical credentials: BROKER keys
//                           (trades execute under an account) and LLM keys (operator-funded spend;
//                           LLM additionally gets a gated operator failover — see
//                           resolveLlmCredential). It is also the safe DEFAULT for any unlisted
//                           service, so a newly-added credential fails closed rather than leaking.
//   shared-operator-infra → env stays a GLOBAL fallback for everyone, because the resource is
//                           operator-funded and non-personal: MARKET DATA (public quotes/bars/
//                           fundamentals — cached in a shared tier benefiting all; a user's own key
//                           still overrides and stays private/pooled), the RAG corpus, the macro
//                           feed, the congressional scraper, notifications. Per-user keys here add
//                           onboarding friction for no isolation benefit.
//
// Bootstrap secrets (ENCRYPTION_KEY, DATABASE_URL, Sentry/Langfuse, webhook/admin tokens, RH OAuth
// app config) never flow through this resolver — they are read directly at startup.
export type CredTier = "per-user-only" | "shared-operator-infra";

export const LOCAL_USER = "local";

// Wire operator plan-tier → quota resolver (provider-rate-limit.resolveProviderQuota).
// Side-effect on module load after LOCAL_USER + DELETED_KEY_TOMBSTONE + getUserApiKey exist.
registerPlanTierLookup((service) => {
  try {
    const fromRow = (userId: string): string | null => {
      const row = getUserApiKey(userId, service);
      if (!row || row.apiKey === DELETED_KEY_TOMBSTONE) return null;
      return row.planTier ?? null;
    };
    const localTier = fromRow(LOCAL_USER);
    if (localTier) return localTier;
    // Connections saves under the logged-in user id.  Scheduler/quota lookups used
    // to only read "local", so an Individual ROIC pick looked saved in Settings
    // but still ran as Free (2 quarters / 5 rpm).
    for (const userId of listUsers()) {
      if (userId === LOCAL_USER) continue;
      const tier = fromRow(userId);
      if (tier) return tier;
    }
    return localTier;
  } catch {
    return null;
  }
});

// Per-user-only (env = `local` operator only): the LLM keys (openai, anthropic, xai, gemini,
// mistral), alpaca_paper_api_key, alpaca_paper_secret_key — and any UNLISTED service (the
// fail-closed default). Everything below is operator-funded shared infrastructure where env is a
// justified global fallback for all users.
const API_KEY_TIER: Record<string, CredTier> = {
  finnhub: "shared-operator-infra",
  fmp: "shared-operator-infra",
  alphavantage: "shared-operator-infra",
  roic: "shared-operator-infra",
  filingapi: "shared-operator-infra",
  marketstack: "shared-operator-infra",
  fred: "shared-operator-infra",
  massive: "shared-operator-infra",
  massive_s3_endpoint: "shared-operator-infra",
  massive_bucket: "shared-operator-infra",
  massive_access_key_id: "shared-operator-infra",
  massive_secret_access_key: "shared-operator-infra",
  sec_edgar_user_agent: "shared-operator-infra",
  pinecone: "shared-operator-infra",
  voyage: "shared-operator-infra",
  siliconflow: "shared-operator-infra",
  logodev: "shared-operator-infra",
  logodev_secret: "shared-operator-infra",
  marketaux: "shared-operator-infra",
  earningscalls: "shared-operator-infra",
  rapidapi: "shared-operator-infra"
};

export function credTierForService(service: string): CredTier {
  return API_KEY_TIER[normalizeApiKeyService(service)] ?? "per-user-only";
}

export function resolveApiKeyWithSource(service: string, userId?: string): { key?: string; source: ApiKeySource; envVar?: string; service: string } {
  const canonical = normalizeApiKeyService(service);
  const envVar = apiKeyEnvVarForService(canonical);

  // FMP keys must never resolve in Socratic.Trade product code (owner: FMP is CT-only).
  // Admin Connections may still show a retired catalog row; storage POST is rejected.
  if (canonical === "fmp" || canonical.startsWith("fmp")) {
    return { source: "none", envVar, service: canonical };
  }

  // 1. A per-user stored key for a specific user ID always wins (not markers / tombstones).
  if (userId) {
    const userKey = getUserApiKey(userId, canonical);
    if (userKey?.apiKey === DELETED_KEY_TOMBSTONE) return { source: "none", envVar, service: canonical };
    if (userKey?.apiKey && !isNonSecretKeyMarker(userKey.apiKey)) {
      return { key: userKey.apiKey, source: "user", envVar, service: canonical };
    }
  }

  const envKey = envVar ? process.env[envVar]?.trim() : undefined;

  // 2. shared-operator-infra: global env fallback first, then fallback to `local` user's key.
  if (credTierForService(canonical) === "shared-operator-infra") {
    // Check global env key first.  Trim so Infisical/Coolify trailing newlines cannot 401.
    if (envKey) return { key: envKey, source: "env", envVar, service: canonical };

    // Fall back to the Socratic.Trade owner's ('local') key as the system default, since background
    // jobs and global operations run off these keys.
    if (userId !== "local") {
      const localKey = getUserApiKey("local", canonical);
      if (localKey?.apiKey && !isNonSecretKeyMarker(localKey.apiKey)) {
        return { key: localKey.apiKey, source: "env", envVar, service: canonical };
      }
    }

    return { source: "none", envVar, service: canonical };
  }

  // 3. per-user-only: NO env fallback for anyone — not even `local`. For background callers (userId undefined)
  // or `local`, resolve against `local`'s stored key. Non-local users with no stored key fail closed.
  if (!userId || userId === LOCAL_USER) {
    const localKey = getUserApiKey(LOCAL_USER, canonical);
    if (localKey?.apiKey === DELETED_KEY_TOMBSTONE) return { source: "none", envVar, service: canonical };
    if (localKey?.apiKey && !isNonSecretKeyMarker(localKey.apiKey)) {
      return { key: localKey.apiKey, source: "user", envVar, service: canonical };
    }
  }

  return { source: "none", envVar, service: canonical };
}

/**
 * Resolves the API key for a given service, checking per-user storage first, then the env
 * fallback — global for shared-operator-infra services, `local`-only for per-user-only ones.
 */
export function resolveApiKey(service: string, userId?: string): string | undefined {
  return resolveApiKeyWithSource(service, userId).key;
}

/**
 * Resolve Alpha Vantage's key — SINGLE KEY ONLY. The former multi-key pool (rotate across several
 * free keys to multiply the 25/day quota — see src/lib/alpha-vantage-key-pool.ts) was retired:
 * Alpha Vantage's burst limit appears to key off the source IP rather than the presented
 * `apikey=`, so extra keys never multiplied real throughput — they only added rotation/exhaustion
 * churn. AV is now bounded purely by the per-provider pacer (withProviderLimit, a serial >=1.1s
 * lane) plus the one key's daily-cap stop. Precedence: per-user stored key -> singular
 * `ALPHAVANTAGE_API_KEY` -> first entry of a legacy `ALPHAVANTAGE_API_KEYS` (back-compat only, no
 * longer pooled) -> none.
 *
 * The return shape ({ keys: string[] }) is unchanged so the data-providers call site and the
 * AlphaVantageKeyPool it still constructs are untouched — that pool now simply runs with a
 * one-key list (currentKey/allExhausted/markExhausted all degenerate to single-key behavior).
 * Deliberately DUPLICATES (rather than generalizes) resolveApiKeyWithSource's per-user-then-env
 * precedence, scoped only to alphavantage, so that widely-shared function's signature stays
 * untouched.
 */
export function resolveAlphaVantageKeyPool(userId?: string): { keys: string[]; source: ApiKeySource; envVar: string } {
  if (userId) {
    const userKey = getUserApiKey(userId, "alphavantage");
    if (userKey?.apiKey) return { keys: [userKey.apiKey], source: "user", envVar: "ALPHAVANTAGE_API_KEY" };
  }

  // Check global env first.
  const singular = process.env.ALPHAVANTAGE_API_KEY?.trim();
  if (singular) return { keys: [singular], source: "env", envVar: "ALPHAVANTAGE_API_KEY" };

  // Back-compat: a legacy multi-key ALPHAVANTAGE_API_KEYS still boots, using only its FIRST key
  // (no pooling). New deployments should use the singular ALPHAVANTAGE_API_KEY.
  const pluralRaw = process.env.ALPHAVANTAGE_API_KEYS?.trim();
  if (pluralRaw) {
    const first = pluralRaw.split(",").map((k) => k.trim()).filter(Boolean)[0];
    if (first) return { keys: [first], source: "env", envVar: "ALPHAVANTAGE_API_KEYS" };
  }

  // 1b. shared-operator-infra fallback: use the `local` user's stored key if available.
  // Mirror of the pattern in resolveApiKeyWithSource.
  if (userId !== "local") {
    const localKey = getUserApiKey("local", "alphavantage");
    if (localKey?.apiKey) return { keys: [localKey.apiKey], source: "env", envVar: "ALPHAVANTAGE_API_KEY" };
  }

  return { keys: [], source: "none", envVar: "ALPHAVANTAGE_API_KEY" };
}

function rankConnectedAlpacaAccounts(
  accounts: ReturnType<typeof listConnectedAccounts>
): ReturnType<typeof listConnectedAccounts> {
  const ranked = [
    accounts.find((a) => a.isActive && a.environment === "live"),
    accounts.find((a) => a.isActive),
    accounts.find((a) => a.environment === "live"),
    accounts.find((a) => a.environment === "paper"),
    ...accounts
  ];
  const seen = new Set<string>();
  return ranked.filter((account): account is NonNullable<(typeof ranked)[number]> => {
    if (!account || seen.has(account.id)) return false;
    seen.add(account.id);
    return true;
  });
}

function resolveConnectedAlpacaMarketData(userId: string, requireSecret = true): { apiKey: string; secretKey?: string } | undefined {
  const alpacaAccs = listConnectedAccounts(userId).filter((a) => a.broker === "alpaca");
  if (alpacaAccs.length === 0) return undefined;

  for (const account of rankConnectedAlpacaAccounts(alpacaAccs)) {
    const detailed = getConnectedAccount(account.id, userId);
    if (!detailed?.apiKey || (requireSecret && !detailed.apiSecret)) continue;
    return { apiKey: detailed.apiKey, secretKey: detailed.apiSecret };
  }
  return undefined;
}

/**
 * Resolve Alpaca credentials for MARKET DATA (snapshots/news) — NOT trading. A user with their own
 * Alpaca key gets their individual data (private/pooled, source "user"); otherwise the operator's
 * paper key (`local` store → env) serves as the SHARED market-data source (source "env" → shared
 * cache) for background refreshes and tenants without their own key. Alpaca market data is identical
 * for paper and live accounts, so the operator's paper key is a fine shared source.
 *
 * SECURITY: the trading gateway (`alpaca.ts`) does NOT use this — it resolves Alpaca strictly
 * per-user (`resolveApiKey`, per-user-only tier) so no one ever TRADES on the operator's account.
 * This helper exposes the operator's key only for read-only market-data endpoints.
 */
export function resolveAlpacaMarketData(userId?: string): { apiKey?: string; secretKey?: string; source: ApiKeySource } {
  let userKeyOnly: { apiKey: string; secretKey?: string; source: ApiKeySource } | undefined;

  if (userId) {
    const connected = resolveConnectedAlpacaMarketData(userId);
    if (connected) return { ...connected, source: "user" };

    const connectedKeyOnly = resolveConnectedAlpacaMarketData(userId, false);
    if (connectedKeyOnly) userKeyOnly = { ...connectedKeyOnly, source: "user" };

    const ownLive = getUserApiKey(userId, "alpaca_api_key")?.apiKey ?? getUserApiKey(userId, "apca_api_key_id")?.apiKey;
    const ownLiveSecret = getUserApiKey(userId, "alpaca_secret_key")?.apiKey ?? getUserApiKey(userId, "apca_api_secret_key")?.apiKey;
    if (ownLive && ownLiveSecret) return { apiKey: ownLive, secretKey: ownLiveSecret, source: "user" };

    const own = getUserApiKey(userId, "alpaca_paper_api_key")?.apiKey;
    const ownSecret = getUserApiKey(userId, "alpaca_paper_secret_key")?.apiKey;
    if (own && ownSecret) return { apiKey: own, secretKey: ownSecret, source: "user" };
    if (own && !userKeyOnly) userKeyOnly = { apiKey: own, source: "user" };
  }

  const localConnected = resolveConnectedAlpacaMarketData(LOCAL_USER);
  if (localConnected) return { ...localConnected, source: "env" };
  const localConnectedKeyOnly = resolveConnectedAlpacaMarketData(LOCAL_USER, false);

  // Check live market data credentials first for real-time SIP/IEX feeds
  const liveKey = process.env.ALPACA_LIVE_API_KEY?.trim() ?? process.env.APCA_API_KEY_ID?.trim() ?? process.env.ALPACA_API_KEY?.trim();
  const liveSecret = process.env.ALPACA_LIVE_SECRET_KEY?.trim() ?? process.env.APCA_API_SECRET_KEY?.trim() ?? process.env.ALPACA_SECRET_KEY?.trim();
  if (liveKey && liveSecret) return { apiKey: liveKey, secretKey: liveSecret, source: "env" };

  const opKey = getUserApiKey(LOCAL_USER, "alpaca_api_key")?.apiKey ?? getUserApiKey(LOCAL_USER, "alpaca_paper_api_key")?.apiKey ?? process.env.ALPACA_PAPER_API_KEY?.trim();
  const opSecret = getUserApiKey(LOCAL_USER, "alpaca_secret_key")?.apiKey ?? getUserApiKey(LOCAL_USER, "alpaca_paper_secret_key")?.apiKey ?? process.env.ALPACA_PAPER_SECRET_KEY?.trim();
  if (userKeyOnly) return userKeyOnly;
  if (localConnectedKeyOnly) return { ...localConnectedKeyOnly, source: "env" };
  if (opKey && opSecret) return { apiKey: opKey, secretKey: opSecret, source: "env" };
  if (opKey) return { apiKey: opKey, source: "env" };
  return { source: "none" };
}

/**
 * Resolve Alpaca credentials for the process-level background WebSocket stream workers
 * (news, trade_updates — see src/lib/streams/alpaca-*-stream.ts). These are single
 * long-lived connections keyed to the `local` operator, not a per-request user, so they need
 * the environment (paper vs live) alongside the key/secret to pick the right WS host — unlike
 * resolveAlpacaMarketData, which only serves read-only market-data REST calls where paper vs
 * live doesn't matter.
 *
 * Prefers connected Alpaca accounts (the modern, actively-maintained credential store —
 * same one Connections writes to) over the legacy standalone
 * `alpaca_paper_api_key`/`alpaca_paper_secret_key` user-API-key pair, which is not updated by
 * the connected-accounts UI and can silently go stale (confirmed in production: the legacy
 * pair was last touched 2026-06-22, while the account's real key was rotated 2026-06-29).
 */
export function resolveAlpacaStreamAccount(
  userId: string = "local"
): { apiKey: string; apiSecret?: string; environment: "paper" | "live" } | undefined {
  const alpacaAccounts = rankConnectedAlpacaAccounts(listConnectedAccounts(userId).filter((account) => account.broker === "alpaca"));
  for (const account of alpacaAccounts) {
    const detailed = getConnectedAccount(account.id, userId);
    if (detailed?.apiKey) {
      return { apiKey: detailed.apiKey, apiSecret: detailed.apiSecret, environment: detailed.environment === "live" ? "live" : "paper" };
    }
  }
  const legacyKey = getUserApiKey(userId, "alpaca_paper_api_key")?.apiKey ?? (userId === LOCAL_USER ? process.env.ALPACA_PAPER_API_KEY?.trim() : undefined);
  const legacySecret = getUserApiKey(userId, "alpaca_paper_secret_key")?.apiKey ?? (userId === LOCAL_USER ? process.env.ALPACA_PAPER_SECRET_KEY?.trim() : undefined);
  if (legacyKey) return { apiKey: legacyKey, apiSecret: legacySecret, environment: "paper" };
  return undefined;
}

// ── LLM credential resolution (per-user-first, operator-funded failover) ─────
//
// LLM keys (openai/anthropic) are per-user-only in the generic resolver above, so `local` keeps
// using the env key and non-`local` users never silently borrow it there. But the owner wants a
// flag-gated OPERATOR-FUNDED FAILOVER: when a real tenant has no LLM key of their own, fall back
// to the operator's env key so the app still works for them — for now (the operator may disable
// this later). Because that means a tenant spends the operator's budget, the failover is paired
// with per-user usage tracking (see llm-usage.ts): every call records who spent and on whose key.
export type LlmKeySource = "user" | "operator" | "none";

/** Whether the operator's env LLM key may serve non-`local` tenants as a failover (disabled outside test). */
export function llmOperatorFallbackEnabled(): boolean {
  const envVal = process.env.LLM_OPERATOR_FALLBACK;
  if (envVal !== undefined) {
    const v = envVal.trim().toLowerCase();
    return v === "1" || v === "true" || v === "yes" || v === "on";
  }
  return process.env.NODE_ENV === "test";
}

/**
 * A stable, non-reversible fingerprint of an API key — `sha256(key)` truncated. Lets the usage
 * ledger measure usage per distinct ATTACHED key without ever storing the secret. Returns undefined
 * for an empty key.
 */
export function keyFingerprint(key: string | undefined): string | undefined {
  if (!key) return undefined;
  return crypto.createHash("sha256").update(key).digest("hex").slice(0, 16);
}

/** Leading / trailing characters `maskApiKeyPreview` reveals, and the shortest key that earns a
 *  preview. At 12 revealed characters a 13-char key hides only one — but no real provider key is
 *  that short, and this threshold is the convention the admin usage ledger already ships
 *  (`maskApiKey` in llm-usage.ts, which now delegates here). */
const PREVIEW_HEAD = 8;
const PREVIEW_TAIL = 4;
const PREVIEW_MIN_LENGTH = PREVIEW_HEAD + PREVIEW_TAIL + 1;

/**
 * An IDENTIFYING, non-usable rendering of an API key: first 8 and last 4 characters with the middle
 * elided (`sk-or-v1-...ab12`). Enough to answer "WHICH key is this?" when several exist for the same
 * provider — the recurring cost of agents provisioning their own keys instead of using the one the
 * owner set spend guardrails on — without ever showing a value anyone could authenticate with.
 *
 * Returns undefined for an absent/empty key and for one too short to elide (see PREVIEW_MIN_LENGTH),
 * so callers must decide what to show instead rather than getting a near-complete secret by default.
 * THE canonical mask: `llm-usage.ts`'s `maskApiKey` and the Connections preview both come through here.
 */
export function maskApiKeyPreview(key: string | undefined | null): string | undefined {
  const trimmed = key?.trim();
  if (!trimmed || trimmed.length < PREVIEW_MIN_LENGTH) return undefined;
  return `${trimmed.slice(0, PREVIEW_HEAD)}...${trimmed.slice(-PREVIEW_TAIL)}`;
}

/**
 * Resolve an LLM provider key for a user. `source` distinguishes the user's own key from the
 * operator-funded failover, and `keyRef` is the non-secret fingerprint of the resolved key so the
 * caller can attribute usage/cost PER ATTACHED key. A non-`local` tenant only reaches the env key
 * when the failover is enabled.
 */
export function resolveLlmCredential(service: "openai" | "anthropic" | "xai" | "gemini" | "mistral" | "deepseek" | "meta" | "moonshot" | "minimax" | "openrouter", userId?: string): { key?: string; source: LlmKeySource; keyRef?: string } {
  const canonical = normalizeApiKeyService(service);
  if (userId) {
    const userKey = getUserApiKey(userId, canonical);
    if (userKey?.apiKey === DELETED_KEY_TOMBSTONE) return { source: "none" };
    if (userKey?.apiKey) return { key: userKey.apiKey, source: "user", keyRef: keyFingerprint(userKey.apiKey) };
  }
  // Operator-funded failover for ANY user (flag-gated). `local`'s own env key is migrated into its
  // per-user store at boot, so `local` resolves "user" above; this serves users without their own
  // key. No `local` special case — when the failover is off, everyone (incl. `local`) needs a key.
  if (!llmOperatorFallbackEnabled()) return { source: "none" };
  const envVar = apiKeyEnvVarForService(canonical);
  let envKey = envVar ? process.env[envVar] : undefined;
  if (!envKey) {
    const localKey = getUserApiKey(LOCAL_USER, canonical)?.apiKey;
    if (localKey && localKey !== DELETED_KEY_TOMBSTONE) {
      envKey = localKey;
    }
  }

  if (process.env.NODE_ENV === "test" && !envKey) {
    if (canonical === "openrouter") {
      const fallbacks = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "XAI_API_KEY", "GEMINI_API_KEY", "MISTRAL_API_KEY", "DEEPSEEK_API_KEY", "META_API_KEY", "MOONSHOT_API_KEY", "MINIMAX_API_KEY"];
      for (const f of fallbacks) {
        if (process.env[f]) {
          envKey = process.env[f];
          break;
        }
      }
    } else {
      if (process.env.OPENROUTER_API_KEY) {
        envKey = process.env.OPENROUTER_API_KEY;
      }
    }
  }

  return envKey ? { key: envKey, source: "operator", keyRef: keyFingerprint(envKey) } : { source: "none" };
}

/** Every LLM provider `resolveLlmCredential` understands. The single source of truth for "is an LLM connected". */
export const LLM_PROVIDER_SERVICES = ["openai", "anthropic", "xai", "gemini", "mistral", "deepseek", "meta", "moonshot", "minimax", "openrouter"] as const;
export type LlmProviderService = (typeof LLM_PROVIDER_SERVICES)[number];

/**
 * True when AT LEAST ONE supported LLM provider resolves a usable credential for this user — their own
 * per-user key OR the operator-funded failover (see resolveLlmCredential). This is the gate for the two
 * LLM-driven actions (strategy session + chat): when it returns false the app must error rather than
 * silently degrade to a rule-based stub. Mirrors the same check the `/api/chat/providers` route exposes.
 */
export function userHasAnyLlmCredential(userId?: string): boolean {
  return LLM_PROVIDER_SERVICES.some((service) => Boolean(resolveLlmCredential(service, userId).key));
}

// Per-user-only credentials whose env values belong to the primary (`local`) operator. At boot we
// migrate them into `local`'s per-user key store so there is NO special `local` env branch in the
// resolvers above — every user, `local` included, resolves broker/LLM keys from the per-user store.
const LOCAL_ENV_MIGRATION_SERVICES = [
  "openai",
  "anthropic",
  "xai",
  "gemini",
  "mistral",
  "deepseek",
  "moonshot",
  "minimax",
  "openrouter",
  "alpaca_paper_api_key",
  "alpaca_paper_secret_key",
  "pinecone",
  "voyage",
  "siliconflow",
  "apify",
  "fintechstudios",
  "powerintell",
  "tiingo",
  "twelvedata",
  "logodev",
  "logodev_secret"
] as const;

const ALL_SERVICE_ENV_VARS: Record<string, string[]> = {
  openai: ["OPENAI_API_KEY"],
  anthropic: ["ANTHROPIC_API_KEY"],
  xai: ["XAI_API_KEY"],
  gemini: ["GEMINI_API_KEY"],
  mistral: ["MISTRAL_API_KEY"],
  deepseek: ["DEEPSEEK_API_KEY"],
  moonshot: ["MOONSHOT_API_KEY", "KIMI_API_KEY", "MOONSHOTAI_API_KEY"],
  minimax: ["MINIMAX_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  alpaca_paper_api_key: ["ALPACA_PAPER_API_KEY"],
  alpaca_paper_secret_key: ["ALPACA_PAPER_SECRET_KEY"],
  pinecone: ["PINECONE_API_KEY"],
  voyage: ["VOYAGE_API_KEY"],
  siliconflow: ["SILICONFLOW_API_KEY"],
  apify: ["APIFY_API_TOKEN", "APIFY_API_KEY"],
  fintechstudios: ["FINTECH_STUDIOS_API_KEY", "POWERINTELL_API_KEY", "POWER_INTELL_API_KEY"],
  powerintell: ["FINTECH_STUDIOS_API_KEY", "POWERINTELL_API_KEY", "POWER_INTELL_API_KEY"],
  tiingo: ["TIINGO_API_KEY"],
  twelvedata: ["TWELVEDATA_API_KEY", "TWELVE_DATA_API_KEY"],
  filingapi: ["FILINGAPI", "FILINGAPI_KEY", "FILING_API_KEY"],
  logodev: ["LOGO_DEV_TOKEN", "LOGO_DEV_API_KEY"],
  logodev_secret: ["LOGO_DEV_SECRET_KEY", "LOGO_DEV_SECRET"],
  marketaux: ["MARKETAUX_API_KEY"],
  earningscalls: ["EARNINGSCALLS_API_KEY", "EARNINGSCALLS_RAPIDAPI_KEY"],
  rapidapi: ["RAPIDAPI_KEY"]
};

/** Purge all LLM and user-providable interface keys from process.env so process.env stays clean. */
export function purgeProcessEnvUserKeys(): void {
  for (const svc of LOCAL_ENV_MIGRATION_SERVICES) {
    const vars = ALL_SERVICE_ENV_VARS[svc] ?? (API_KEY_ENV_MAP[svc] ? [API_KEY_ENV_MAP[svc]] : []);
    for (const envVar of vars) {
      if (process.env[envVar] !== undefined) {
        delete process.env[envVar];
      }
    }
  }
}

/**
 * Native Gemini / DeepSeek keys must not be auto-copied from Infisical/Coolify env onto the
 * primary Connections account. Production strategy/Red Team already prefer OpenRouter when that
 * key exists; env-seeded native rows kept reappearing after the owner deleted them because every
 * deploy re-injected GEMINI_API_KEY / DEEPSEEK_API_KEY and migrate treated a delete-tombstone as
 * empty. Env values (if present) are still purged below so they cannot silently serve after a
 * delete. A user who actually pastes a native key keeps it.
 */
const DO_NOT_AUTO_SEED_FROM_ENV = new Set(["gemini", "deepseek"]);

/**
 * One-time, idempotent migration of the operator's env broker/LLM keys into the `local` user's
 * per-user key store. Safe to call repeatedly (only seeds a service `local` doesn't already have a
 * key for) and on every boot. Never overwrites a delete tombstone. Returns which services were
 * seeded (and which env-seeded Gemini/DeepSeek ghosts were tombstoned). Call from the server boot
 * hook, NOT the hot resolver path. Shared-tier keys (market data, RAG, macro) are NOT migrated —
 * they stay a global env fallback for all users.
 */
export function migrateLocalEnvCredentials(): { migrated: string[]; tombstoned: string[] } {
  const migrated: string[] = [];
  const tombstoned: string[] = [];

  for (const svc of DO_NOT_AUTO_SEED_FROM_ENV) {
    const row = getUserApiKey(LOCAL_USER, svc);
    if (row && row.apiKey !== DELETED_KEY_TOMBSTONE && row.label === "migrated from env") {
      try {
        deleteUserApiKey(LOCAL_USER, svc);
        tombstoned.push(svc);
      } catch {
        /* best-effort */
      }
    }
  }

  for (const svc of LOCAL_ENV_MIGRATION_SERVICES) {
    if (DO_NOT_AUTO_SEED_FROM_ENV.has(svc)) continue;
    const vars = ALL_SERVICE_ENV_VARS[svc] ?? (API_KEY_ENV_MAP[svc] ? [API_KEY_ENV_MAP[svc]] : []);
    let envVal: string | undefined;
    for (const v of vars) {
      const val = process.env[v]?.trim();
      if (val) {
        envVal = val;
        break;
      }
    }
    const currentKey = getUserApiKey(LOCAL_USER, svc)?.apiKey;
    // A delete tombstone is a user decision. Coolify re-injects env on every deploy; do not
    // treat "__DISABLED__" as "missing" and write the env value back onto Connections.
    if (currentKey === DELETED_KEY_TOMBSTONE) continue;
    if (envVal && !currentKey) {
      try {
        upsertUserApiKey(LOCAL_USER, svc, envVal, "migrated from env");
        migrated.push(svc);
      } catch {
        /* best-effort */
      }
    }
  }
  // Purge process.env of all user-providable and LLM keys post-migration
  purgeProcessEnvUserKeys();
  return { migrated, tombstoned };
}

// ── Connected accounts ──────────────────────────────────────────────────────

function parseCapabilities(raw: unknown): AccountCapabilities | undefined {
  if (!raw || typeof raw !== "string") return undefined;
  try { return JSON.parse(raw) as AccountCapabilities; } catch { return undefined; }
}

export function listConnectedAccounts(userId: string = "local"): ConnectedAccount[] {
  const rows = getDb()
    .prepare("SELECT * FROM connected_accounts WHERE user_id = ? ORDER BY created_at ASC")
    .all(userId) as Record<string, unknown>[];
  return rows.map(r => ({
    id: String(r.id),
    userId: String(r.user_id),
    broker: String(r.broker) as ConnectedAccount["broker"],
    environment: String(r.environment) as "live" | "paper",
    accountNumber: r.account_number != null ? String(r.account_number) : undefined,
    label: String(r.label),
    taxationType: r.taxation_type != null ? (String(r.taxation_type) as ConnectedAccount["taxationType"]) : undefined,
    baseUrl: r.base_url != null ? String(r.base_url) : undefined,
    capabilities: parseCapabilities(r.capabilities),
    isActive: r.is_active === 1,
    isDraining: r.is_draining === 1,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at)
  }));
}

export function getActiveConnectedAccount(userId: string = "local"): ConnectedAccount | undefined {
  const row = getDb()
    .prepare("SELECT * FROM connected_accounts WHERE user_id = ? AND is_active = 1 LIMIT 1")
    .get(userId) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return {
    id: String(row.id),
    userId: String(row.user_id),
    broker: String(row.broker) as ConnectedAccount["broker"],
    environment: String(row.environment) as "live" | "paper",
    accountNumber: row.account_number != null ? String(row.account_number) : undefined,
    label: String(row.label),
    taxationType: row.taxation_type != null ? (String(row.taxation_type) as ConnectedAccount["taxationType"]) : undefined,
    apiKey: row.api_key ? decryptValue(String(row.api_key)) : undefined,
    apiSecret: row.api_secret ? decryptValue(String(row.api_secret)) : undefined,
    baseUrl: row.base_url != null ? String(row.base_url) : undefined,
    capabilities: parseCapabilities(row.capabilities),
    isActive: row.is_active === 1,
    isDraining: row.is_draining === 1,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

/**
 * A connected account for a specific broker, for use as a MARKET-DATA credential source rather than
 * an execution destination — e.g. Tradier price-history (see history.ts's
 * resolveTradierHistoryCredential): the owner connects Tradier as a broker to trade through it, and
 * that SAME connection's access token also becomes the app's Tradier price-history source, rather
 * than requiring a duplicate, separate "Tradier API key" entry in Settings.
 *
 * Deliberately NOT restricted to `is_active = 1` — `isActive` means "the currently loaded/executing
 * broker" (Settings' single-active-account UI only ever loads one broker at a time), which is an
 * ORTHOGONAL concept to "this credential exists and can source data." A user trading through Alpaca
 * as their active account can still connect Tradier purely as a shared data source; requiring it to
 * ALSO be the active execution broker would silently disable Tradier history for exactly that
 * legitimate setup (Codex review, PR #1673). Prefers the active row when the connected broker
 * happens to also be Tradier, otherwise falls back to the most recently updated connected Tradier
 * account for this user.
 */
export function getConnectedAccountByBroker(broker: ConnectedAccount["broker"], userId: string = "local"): ConnectedAccount | undefined {
  const row = getDb()
    .prepare("SELECT * FROM connected_accounts WHERE user_id = ? AND broker = ? ORDER BY is_active DESC, updated_at DESC LIMIT 1")
    .get(userId, broker) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return {
    id: String(row.id),
    userId: String(row.user_id),
    broker: String(row.broker) as ConnectedAccount["broker"],
    environment: String(row.environment) as "live" | "paper",
    accountNumber: row.account_number != null ? String(row.account_number) : undefined,
    label: String(row.label),
    taxationType: row.taxation_type != null ? (String(row.taxation_type) as ConnectedAccount["taxationType"]) : undefined,
    apiKey: row.api_key ? decryptValue(String(row.api_key)) : undefined,
    apiSecret: row.api_secret ? decryptValue(String(row.api_secret)) : undefined,
    baseUrl: row.base_url != null ? String(row.base_url) : undefined,
    capabilities: parseCapabilities(row.capabilities),
    isActive: row.is_active === 1,
    isDraining: row.is_draining === 1,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

// Fetch a specific connected account by id (scoped to the owning user), with decrypted
// keys — used by the scheduler to run a non-active account autonomously.
export function getConnectedAccount(id: string, userId: string = "local"): ConnectedAccount | undefined {
  const row = getDb()
    .prepare("SELECT * FROM connected_accounts WHERE id = ? AND user_id = ? LIMIT 1")
    .get(id, userId) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return {
    id: String(row.id),
    userId: String(row.user_id),
    broker: String(row.broker) as ConnectedAccount["broker"],
    environment: String(row.environment) as "live" | "paper",
    accountNumber: row.account_number != null ? String(row.account_number) : undefined,
    label: String(row.label),
    taxationType: row.taxation_type != null ? (String(row.taxation_type) as ConnectedAccount["taxationType"]) : undefined,
    apiKey: row.api_key ? decryptValue(String(row.api_key)) : undefined,
    apiSecret: row.api_secret ? decryptValue(String(row.api_secret)) : undefined,
    baseUrl: row.base_url != null ? String(row.base_url) : undefined,
    capabilities: parseCapabilities(row.capabilities),
    isActive: row.is_active === 1,
    isDraining: row.is_draining === 1,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

// Insert or update a connected account. The `ON CONFLICT(id) DO UPDATE ... WHERE user_id = excluded.user_id`
// guard makes the UPDATE branch a no-op when the existing row belongs to a DIFFERENT user, so a caller
// who supplies someone else's account `id` (e.g. the deterministic `test-<userId>` id, derivable from a
// known email) can neither overwrite that row's broker/key fields nor hijack it — the conflicting write
// silently does nothing. Creates with a fresh id are unaffected; legitimate same-user edits still apply.
export function upsertConnectedAccount(account: Omit<ConnectedAccount, "createdAt" | "updatedAt">): void {
  const now = new Date().toISOString();
  const encryptedApiKey = account.apiKey?.trim() ? encryptValue(account.apiKey.trim()) : null;
  const encryptedApiSecret = account.apiSecret?.trim() ? encryptValue(account.apiSecret.trim()) : null;
  const database = getDb();
  database.transaction(() => {
    if (account.isActive) {
      database.prepare("UPDATE connected_accounts SET is_active = 0 WHERE user_id = ?").run(account.userId);
    }
    const capabilitiesJson = account.capabilities ? JSON.stringify(account.capabilities) : null;
    database
      .prepare(
        `INSERT INTO connected_accounts (id, user_id, broker, environment, account_number, label, api_key, api_secret, taxation_type, base_url, capabilities, is_active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
          broker = excluded.broker,
          environment = excluded.environment,
          account_number = excluded.account_number,
          label = excluded.label,
          api_key = COALESCE(excluded.api_key, connected_accounts.api_key),
          api_secret = COALESCE(excluded.api_secret, connected_accounts.api_secret),
          taxation_type = COALESCE(excluded.taxation_type, connected_accounts.taxation_type),
          base_url = COALESCE(excluded.base_url, connected_accounts.base_url),
          capabilities = COALESCE(excluded.capabilities, connected_accounts.capabilities),
          is_active = excluded.is_active,
          is_draining = 0,
          updated_at = excluded.updated_at
         WHERE connected_accounts.user_id = excluded.user_id`
      )
      .run(
        account.id,
        account.userId,
        account.broker,
        account.environment,
        account.accountNumber ?? null,
        account.label,
        encryptedApiKey,
        encryptedApiSecret,
        account.taxationType ?? null,
        account.baseUrl ?? null,
        capabilitiesJson,
        account.isActive ? 1 : 0,
        now,
        now
      );

  })();
}

/**
 * Rename a connected account's user-facing display label. Deliberately narrow: it touches ONLY
 * `label` — not the broker identifier (`account_number`), not credentials, and NOT `updated_at`
 * (see the ordering note below), so a cosmetic rename can never re-run connect-time validation,
 * disturb the broker-sourced account number that per-account trade history and
 * `policy.accountNumber` key off of, or reorder credential resolution. User-scoped; returns false
 * if no row matched (unknown id, or another user's row).
 */
export function renameConnectedAccount(id: string, label: string, userId: string = "local"): boolean {
  const trimmed = label.trim();
  if (!trimmed) throw new Error("Account name cannot be empty.");
  if (trimmed.length > 120) throw new Error("Account name is too long (max 120 characters).");
  // Update ONLY `label` — deliberately NOT `updated_at`. `getConnectedAccountByBroker` resolves
  // which same-broker row backs shared data-source fetches (e.g. Tradier price history) with
  // `ORDER BY is_active DESC, updated_at DESC`; bumping updated_at on a purely cosmetic rename
  // would promote a renamed inactive row over the intended latest credential, silently swapping
  // an old/sandbox token in for history fetches (Codex review, PR #1727).
  const result = getDb()
    .prepare("UPDATE connected_accounts SET label = ? WHERE id = ? AND user_id = ?")
    .run(trimmed, id, userId);
  return result.changes > 0;
}

export function setActiveConnectedAccount(id: string, userId: string = "local"): void {
  const db = getDb();
  db.transaction(() => {
    const row = db
      .prepare("SELECT id, is_draining FROM connected_accounts WHERE id = ? AND user_id = ?")
      .get(id, userId) as { id: string; is_draining: number } | undefined;
    if (!row) throw new Error("Connected account not found.");
    if (row.is_draining === 1) {
      throw new Error("This account is disconnected and being wound down — it can no longer be made active.");
    }
    db.prepare("UPDATE connected_accounts SET is_active = 0 WHERE user_id = ?").run(userId);
    db.prepare("UPDATE connected_accounts SET is_active = 1 WHERE id = ? AND user_id = ?").run(id, userId);
  })();
  // Drop every cached snapshot for this user.  The next dashboard/mobile
  // read must assemble against the new active pointer — a 10s stale hit
  // (or an in-flight compute for the previous account) is why iOS looked
  // like it refused to switch to Alpaca Paper after Tradier Sandbox.
  invalidateDashboardSnapshotCache(userId);
}

export function purgeConnectedAccount(id: string, userId: string = "local"): boolean {
  const database = getDb();
  const row = database
    .prepare("SELECT account_number FROM connected_accounts WHERE id = ? AND user_id = ?")
    .get(id, userId) as { account_number: string | null } | undefined;
  if (!row) return false;
  const acct = row.account_number;
  // Delete the account and purge its trading records in one transaction, so removing an account never
  // leaves orphaned fills/snapshots/proposals/stops still feeding P&L or exposure for an account that
  // no longer exists. Account-delete is an explicit user action — its broker-scoped history goes with it.
  const run = database.transaction(() => {
    const result = database.prepare("DELETE FROM connected_accounts WHERE id = ? AND user_id = ?").run(id, userId);
    if (acct) {
      for (const table of ["fill_events", "portfolio_snapshots", "trade_proposals", "synthetic_trailing_stops", "broker_protective_stops", "position_stop_plans", "order_replacements", "pending_bracket_teardowns", "position_stop_plan_open_brackets"]) {
        database.prepare(`DELETE FROM ${table} WHERE account_number = ? AND user_id = ?`).run(acct, userId);
      }
    }
    // Purge the account's per-account isolated state, keyed by connected_account_id (= this id):
    // live strategy state, run history, performance-learning rows, audit/notification trail.
    for (const table of [
      "account_strategy_state",
      "strategy_runs",
      "skipped_candidate_counterfactuals",
      "counterfactual_learning_watermarks",
      "learning_mutations",
      "audit_events",
      "notification_events",
      "option_alert_reservations"
    ]) {
      database.prepare(`DELETE FROM ${table} WHERE connected_account_id = ? AND user_id = ?`).run(id, userId);
    }
    // Release this account's run lock if held (in-memory scheduler state clears on next restart).
    database.prepare("DELETE FROM settings WHERE key = ?").run(`strategy_run_lock:${userId}:${id}`);
    return result.changes > 0;
  });
  return run();
}

export function deleteConnectedAccount(id: string, userId: string = "local"): boolean {
  const database = getDb();
  // We mark it as draining rather than deleting immediately.
  // The scheduler will handle reconciling pending actions and then call purgeConnectedAccount.
  const result = database
    .prepare("UPDATE connected_accounts SET is_draining = 1, is_active = 0 WHERE id = ? AND user_id = ?")
    .run(id, userId);
  return result.changes > 0;
}

// ── Synthetic trailing stops (R2 scaffolding) ──────────────────────────────────
export interface SyntheticTrailingStop {
  id: string;
  userId: string;
  accountNumber: string;
  symbol: string;
  side: "long" | "short";
  quantity: number;
  entryPrice: number;
  /** Highest price since entry for a long (lowest for a short) — the trail anchor. */
  extremePrice: number;
  trailPercent?: number;
  trailAmount?: number;
  status: "active" | "triggered" | "cancelled";
  lastPrice?: number;
  /**
   * Count of prior protective-exit attempts whose broker order was POSITIVELY confirmed dead.
   * Monotonic — advances only via advanceSyntheticStopGeneration, is never reset backwards, and is
   * deliberately untouched by upsertSyntheticStop. The fire path appends "-g<generation>" to the
   * deterministic client_order_id when > 0 (generation 0 keeps the original unsuffixed format), so a
   * legitimately re-armed stop places under a fresh id while the id stays deterministic WITHIN one
   * arming cycle — the broker's client_order_id dedupe remains the last-resort double-sell guard.
   */
  fireGeneration: number;
  /**
   * client_order_id of the most recent exit attempt whose outcome is not yet confirmed dead.
   * Persisted just after the claim and BEFORE the broker placement call, so a placement that throws
   * after the broker accepted still remembers the possibly-live order's id: an ambiguous retry
   * reuses it verbatim and fails safe toward a 422 collision instead of a duplicate sell. Cleared
   * only by advanceSyntheticStopGeneration (i.e. only once that order is confirmed dead).
   */
  lastAttemptRefId?: string;
  createdAt: string;
  updatedAt: string;
  suspectPrice?: number;
  suspectCount?: number;
  /**
   * 'trailing' (default, incl. legacy rows predating this column): extreme_price ratchets with the
   * high/low-water mark — unchanged behavior. 'fixed': a static-trigger row backing a "fixed"/"atr"
   * stop plan between strategy runs (item 7) — the monitor re-pins extreme_price to entry_price
   * every tick instead of persisting the ratchet, so evaluateStop yields a fixed distance from entry
   * rather than a trail. See synthetic-stops.ts's registration/purge/fire-loop handling.
   */
  kind?: "trailing" | "fixed";
}

function mapSyntheticStop(r: Record<string, unknown>): SyntheticTrailingStop {
  return {
    id: String(r.id),
    userId: String(r.user_id),
    accountNumber: String(r.account_number),
    symbol: String(r.symbol),
    side: String(r.side) as "long" | "short",
    quantity: Number(r.quantity),
    entryPrice: Number(r.entry_price),
    extremePrice: Number(r.extreme_price),
    trailPercent: r.trail_percent != null ? Number(r.trail_percent) : undefined,
    trailAmount: r.trail_amount != null ? Number(r.trail_amount) : undefined,
    status: String(r.status) as SyntheticTrailingStop["status"],
    lastPrice: r.last_price != null ? Number(r.last_price) : undefined,
    fireGeneration: r.fire_generation != null ? Number(r.fire_generation) : 0,
    lastAttemptRefId: r.last_attempt_ref_id != null ? String(r.last_attempt_ref_id) : undefined,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    suspectPrice: r.suspect_price != null ? Number(r.suspect_price) : undefined,
    suspectCount: r.suspect_count != null ? Number(r.suspect_count) : 0,
    kind: r.kind === "fixed" ? "fixed" : "trailing"
  };
}

export function upsertSyntheticStop(
  stop: Omit<SyntheticTrailingStop, "createdAt" | "updatedAt" | "fireGeneration" | "lastAttemptRefId"> & {
    createdAt?: string;
    fireGeneration?: number;
    lastAttemptRefId?: string;
  }
): void {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      // The status CASE is a money-path guard: an upsert must NEVER resurrect a 'triggered' row back
      // to 'active'. A triggered stop has (or may have) a protective exit order at the broker; blindly
      // re-arming it re-fires the same stop on every monitor tick on top of that resting exit (the
      // 2026-07-08 MU incident: ~280 duplicate market sells stopped only by client_order_id dedupe).
      // The ONLY legitimate re-arm path is revertSyntheticStopClaim, called after the triggering exit
      // order is confirmed dead (placement threw / broker-confirmed terminal without closing the position).
      //
      // fire_generation and last_attempt_ref_id are deliberately ABSENT from the DO UPDATE SET: the
      // routine upserts (auto-register, per-tick extreme/lastPrice persistence) must never reset the
      // exit-attempt ledger — generation moves only forward (advanceSyntheticStopGeneration) and the
      // possibly-live attempt id is recorded/cleared only by recordSyntheticStopAttempt / the advance.
      `INSERT INTO synthetic_trailing_stops (id, user_id, account_number, symbol, side, quantity, entry_price, extreme_price, trail_percent, trail_amount, status, last_price, fire_generation, last_attempt_ref_id, created_at, updated_at, suspect_price, suspect_count, kind)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, account_number, symbol) DO UPDATE SET
        side = excluded.side,
        quantity = excluded.quantity,
        entry_price = excluded.entry_price,
        extreme_price = excluded.extreme_price,
        trail_percent = excluded.trail_percent,
        trail_amount = excluded.trail_amount,
        status = CASE
          WHEN synthetic_trailing_stops.status = 'triggered' AND excluded.status = 'active'
          THEN synthetic_trailing_stops.status
          ELSE excluded.status
        END,
        last_price = excluded.last_price,
        updated_at = excluded.updated_at,
        suspect_price = excluded.suspect_price,
        suspect_count = excluded.suspect_count,
        kind = excluded.kind`
    )
    .run(
      stop.id, stop.userId, stop.accountNumber, stop.symbol, stop.side, stop.quantity,
      stop.entryPrice, stop.extremePrice, stop.trailPercent ?? null, stop.trailAmount ?? null,
      stop.status, stop.lastPrice ?? null, stop.fireGeneration ?? 0, stop.lastAttemptRefId ?? null,
      stop.createdAt ?? now, now, stop.suspectPrice ?? null, stop.suspectCount ?? 0, stop.kind ?? "trailing"
    );
}

/**
 * Record the protective-exit attempt the fire path is about to place: persists the client_order_id
 * (refId) BEFORE the broker call, so even a placement that throws after the broker accepted leaves a
 * durable memory of the possibly-live order. Does not touch fire_generation.
 */
export function recordSyntheticStopAttempt(id: string, refId: string, userId: string = "local"): void {
  getDb()
    .prepare("UPDATE synthetic_trailing_stops SET last_attempt_ref_id = ?, updated_at = ? WHERE id = ? AND user_id = ?")
    .run(refId, new Date().toISOString(), id, userId);
}

/**
 * Advance the exit generation after POSITIVE confirmation that the prior attempt's broker order is
 * dead (order list fetched, no live exit order, the recorded client_order_id absent from live
 * states, no fill still pending reconciliation). Increment-only — generation never moves backwards.
 * Also clears last_attempt_ref_id: the order it remembered is confirmed dead, so there is no longer
 * a possibly-live attempt to guard against, and the next fire records a fresh id at claim time.
 */
export function advanceSyntheticStopGeneration(id: string, userId: string = "local"): void {
  getDb()
    .prepare("UPDATE synthetic_trailing_stops SET fire_generation = fire_generation + 1, last_attempt_ref_id = NULL, updated_at = ? WHERE id = ? AND user_id = ?")
    .run(new Date().toISOString(), id, userId);
}

export function listSyntheticStops(accountNumber: string, userId: string = "local", status: SyntheticTrailingStop["status"] = "active"): SyntheticTrailingStop[] {
  const rows = getDb()
    .prepare("SELECT * FROM synthetic_trailing_stops WHERE user_id = ? AND account_number = ? AND status = ? ORDER BY created_at ASC")
    .all(userId, accountNumber, status) as Record<string, unknown>[];
  return rows.map(mapSyntheticStop);
}

export function deleteSyntheticStop(id: string, userId: string = "local"): void {
  getDb().prepare("DELETE FROM synthetic_trailing_stops WHERE id = ? AND user_id = ?").run(id, userId);
}

/**
 * Atomic compare-and-swap claim of an active synthetic stop.
 */
export function claimSyntheticStop(id: string, userId: string = "local"): boolean {
  const info = getDb()
    .prepare("UPDATE synthetic_trailing_stops SET status = 'triggered', updated_at = ? WHERE id = ? AND user_id = ? AND status = 'active'")
    .run(new Date().toISOString(), id, userId);
  return info.changes === 1;
}

/** Re-arm a claimed stop after a failed placement so it can retry on a later tick. */
export function revertSyntheticStopClaim(id: string, userId: string = "local"): void {
  getDb()
    .prepare("UPDATE synthetic_trailing_stops SET status = 'active', updated_at = ? WHERE id = ? AND user_id = ? AND status = 'triggered'")
    .run(new Date().toISOString(), id, userId);
}

/** Purge stops whose position no longer exists (size hit 0). `liveSymbols` must be upper-cased. */
export function purgeSyntheticStops(accountNumber: string, liveSymbols: Set<string>, userId: string = "local"): number {
  let purged = 0;
  for (const stop of listSyntheticStops(accountNumber, userId)) {
    if (!liveSymbols.has(stop.symbol.toUpperCase())) {
      deleteSyntheticStop(stop.id, userId);
      purged++;
    }
  }
  return purged;
}

// ── Broker-held protective stops (Robinhood fixed / Alpaca+Robinhood trailing) ─

export interface BrokerProtectiveStop {
  id: string;
  userId: string;
  accountNumber: string;
  symbol: string;
  brokerOrderId: string;
  quantity: number;
  stopPrice: number;
  status: string;
  /** 'fixed' = stop at stopLossPct below entry; 'trailing' = native Alpaca trailing_stop or a
   *  Robinhood stop-market the reconciler ratchets upward each tick. */
  kind: "fixed" | "trailing";
  /** Configured trail distance (% below the high-water mark) — set only on 'trailing' rows. */
  trailPercent?: number;
  createdAt: string;
  updatedAt: string;
}

function mapBrokerProtectiveStop(r: Record<string, unknown>): BrokerProtectiveStop {
  return {
    id: String(r.id),
    userId: String(r.user_id),
    accountNumber: String(r.account_number),
    symbol: String(r.symbol),
    brokerOrderId: String(r.broker_order_id),
    quantity: Number(r.quantity),
    stopPrice: Number(r.stop_price),
    status: String(r.status),
    kind: r.kind === "trailing" ? "trailing" : "fixed",
    trailPercent: r.trail_percent == null ? undefined : Number(r.trail_percent),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at)
  };
}

export function upsertBrokerProtectiveStop(
  stop: Omit<BrokerProtectiveStop, "createdAt" | "updatedAt" | "kind" | "trailPercent"> &
    { createdAt?: string; kind?: "fixed" | "trailing"; trailPercent?: number }
): void {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO broker_protective_stops (id, user_id, account_number, symbol, broker_order_id, quantity, stop_price, status, kind, trail_percent, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, account_number, symbol) DO UPDATE SET
        broker_order_id = excluded.broker_order_id,
        quantity = excluded.quantity,
        stop_price = excluded.stop_price,
        status = excluded.status,
        kind = excluded.kind,
        trail_percent = excluded.trail_percent,
        updated_at = excluded.updated_at`
    )
    .run(
      stop.id, stop.userId, stop.accountNumber, stop.symbol, stop.brokerOrderId,
      stop.quantity, stop.stopPrice, stop.status, stop.kind ?? "fixed", stop.trailPercent ?? null,
      stop.createdAt ?? now, now
    );
}

export function listBrokerProtectiveStops(accountNumber: string, userId: string = "local"): BrokerProtectiveStop[] {
  // Include live-resting stops, stops mid-teardown ('pending_cancel'), and halted right-size retry
  // markers ('pending_replace'). Rows are hard-deleted on a successful cancel, so these are the only
  // statuses that ever persist — returning all is effectively "every active row". Filtering to
  // status='resting' (the original behavior) hid a pending_cancel row from the reconcile loop's retry
  // pass, so a failed cancel could never be retried and the stop would orphan at the broker; omitting
  // 'pending_replace' likewise hid the halted right-size marker (Codex review, PR #1738), so section 1
  // never re-queued the symbol and section 4 never re-placed — the position could stay unprotected
  // until unhalted. Callers that must act on resting-only rows (e.g. mismatch replacement) still check
  // `status === 'resting'` themselves.
  const rows = getDb()
    .prepare("SELECT * FROM broker_protective_stops WHERE user_id = ? AND account_number = ? AND status IN ('resting', 'pending_cancel', 'pending_replace') ORDER BY created_at ASC")
    .all(userId, accountNumber) as Record<string, unknown>[];
  return rows.map(mapBrokerProtectiveStop);
}

export function deleteBrokerProtectiveStop(id: string, userId: string = "local"): void {
  getDb().prepare("DELETE FROM broker_protective_stops WHERE id = ? AND user_id = ?").run(id, userId);
}

// ── listUsers ────────────────────────────────────────────────────────────────

export function listUsers(): string[] {
  const rows = getDb()
    .prepare(
      `SELECT user_id FROM user_settings
       UNION
       SELECT user_id FROM strategy_profiles
       UNION
       SELECT user_id FROM user_api_keys
       UNION
       SELECT user_id FROM connected_accounts
       UNION
       SELECT user_id FROM user_watchlist
       UNION
       SELECT user_id FROM price_alerts`
    )
    .all() as Array<{ user_id: string }>;
  const users = rows.map((r) => r.user_id).filter(Boolean);
  return users.length > 0 ? Array.from(new Set(users)) : ["local"];
}

// ── Watchlist ────────────────────────────────────────────────────────────────

type RawWatchlistRow = { symbol: string; added_at: string };

export function addWatchlistSymbol(userId: string, symbol: string): WatchlistItem {
  const addedAt = new Date().toISOString();
  getDb()
    .prepare("INSERT OR IGNORE INTO user_watchlist (user_id, symbol, added_at) VALUES (?, ?, ?)")
    .run(userId, symbol, addedAt);
  const row = getDb()
    .prepare("SELECT symbol, added_at FROM user_watchlist WHERE user_id = ? AND symbol = ?")
    .get(userId, symbol) as RawWatchlistRow;
  return { symbol: row.symbol, addedAt: row.added_at };
}

export function removeWatchlistSymbol(userId: string, symbol: string): boolean {
  const result = getDb().prepare("DELETE FROM user_watchlist WHERE user_id = ? AND symbol = ?").run(userId, symbol);
  return result.changes > 0;
}

export function listWatchlistSymbols(userId: string): WatchlistItem[] {
  const rows = getDb()
    .prepare("SELECT symbol, added_at FROM user_watchlist WHERE user_id = ? ORDER BY symbol ASC")
    .all(userId) as RawWatchlistRow[];
  return rows.map((row) => ({ symbol: row.symbol, addedAt: row.added_at }));
}

// ── Price alerts ─────────────────────────────────────────────────────────────

type RawPriceAlertRow = {
  id: string;
  user_id: string;
  symbol: string;
  op: string;
  price: number;
  note: string;
  status: string;
  created_at: string;
  triggered_at: string | null;
  triggered_price: number | null;
};

function mapPriceAlert(row: RawPriceAlertRow): PriceAlert {
  return {
    id: row.id,
    userId: row.user_id,
    symbol: row.symbol,
    op: row.op as PriceAlertOp,
    price: row.price,
    note: row.note,
    status: row.status as PriceAlertStatus,
    createdAt: row.created_at,
    triggeredAt: row.triggered_at,
    triggeredPrice: row.triggered_price
  };
}

export function createPriceAlert(alert: PriceAlert): PriceAlert {
  getDb()
    .prepare(
      `INSERT INTO price_alerts
       (id, user_id, symbol, op, price, note, status, created_at, triggered_at, triggered_price)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      alert.id,
      alert.userId,
      alert.symbol,
      alert.op,
      alert.price,
      alert.note,
      alert.status,
      alert.createdAt,
      alert.triggeredAt,
      alert.triggeredPrice
    );
  return alert;
}

export function listPriceAlerts(userId: string, status: "all" | "armed" | "triggered" = "all"): PriceAlert[] {
  const rows =
    status === "all"
      ? (getDb()
          .prepare("SELECT * FROM price_alerts WHERE user_id = ? ORDER BY created_at DESC")
          .all(userId) as RawPriceAlertRow[])
      : (getDb()
          .prepare("SELECT * FROM price_alerts WHERE user_id = ? AND status = ? ORDER BY created_at DESC")
          .all(userId, status) as RawPriceAlertRow[]);
  return rows.map(mapPriceAlert);
}

export function listArmedPriceAlerts(userId: string): PriceAlert[] {
  return listPriceAlerts(userId, "armed");
}

export function deletePriceAlert(userId: string, id: string): boolean {
  const result = getDb().prepare("DELETE FROM price_alerts WHERE id = ? AND user_id = ?").run(id, userId);
  return result.changes > 0;
}

export function markPriceAlertTriggered(id: string, userId: string, triggeredPrice: number): PriceAlert | null {
  const triggeredAt = new Date().toISOString();
  const result = getDb()
    .prepare(
      `UPDATE price_alerts
       SET status = 'triggered', triggered_at = ?, triggered_price = ?
       WHERE id = ? AND user_id = ? AND status = 'armed'`
    )
    .run(triggeredAt, triggeredPrice, id, userId);
  if (result.changes === 0) return null;
  const row = getDb().prepare("SELECT * FROM price_alerts WHERE id = ? AND user_id = ?").get(id, userId) as RawPriceAlertRow | undefined;
  return row ? mapPriceAlert(row) : null;
}

// ── Notification preferences ──────────────────────────────────────────────────

const NOTIFY_CHANNEL_IDS: readonly NotifyChannelId[] = ["push", "webhook", "email", "sms", "pushover", "apns"];

function isNotifyChannelId(value: unknown): value is NotifyChannelId {
  return typeof value === "string" && (NOTIFY_CHANNEL_IDS as readonly string[]).includes(value);
}

export function getNotifyPrefs(userId: string = "local"): NotifyPrefs {
  const row = getDb().prepare("SELECT * FROM notification_prefs WHERE user_id = ?").get(userId) as
    | { user_id: string; channels: string; push_target: string; pushover_target: string; webhook_url: string; email: string; phone: string;
        pushover_app_token?: string; twilio_account_sid?: string; twilio_auth_token?: string; twilio_from?: string;
        watchlist_digest_enabled?: number;
        updated_at: string | null }
    | undefined;
  if (!row) {
    return { userId, channels: [], pushTarget: "", pushoverTarget: "", webhookUrl: "", email: "", phone: "",
      pushoverAppTokenSet: false, twilioAccountSidSet: false, twilioAuthTokenSet: false, twilioFromSet: false,
      watchlistDigestEnabled: false, updatedAt: null };
  }
  let channels: NotifyChannelId[] = [];
  try {
    const parsed = JSON.parse(row.channels) as unknown;
    if (Array.isArray(parsed)) channels = parsed.filter(isNotifyChannelId);
  } catch {
    channels = [];
  }
  return {
    userId: row.user_id,
    channels,
    pushTarget: row.push_target,
    pushoverTarget: row.pushover_target ?? "",
    webhookUrl: row.webhook_url,
    email: row.email,
    phone: row.phone,
    pushoverAppTokenSet: Boolean(row.pushover_app_token),
    twilioAccountSidSet: Boolean(row.twilio_account_sid),
    twilioAuthTokenSet: Boolean(row.twilio_auth_token),
    twilioFromSet: Boolean(row.twilio_from),
    watchlistDigestEnabled: row.watchlist_digest_enabled === 1,
    updatedAt: row.updated_at
  };
}

/** Server-side only: decrypted per-user channel credentials. Empty string =
 *  not set — callers fall back to the server env. Never serialize to clients. */
export function getNotifyPrefsSecrets(userId: string = "local"): NotifyPrefsSecrets {
  const row = getDb().prepare("SELECT pushover_app_token, twilio_account_sid, twilio_auth_token, twilio_from FROM notification_prefs WHERE user_id = ?").get(userId) as
    | { pushover_app_token: string; twilio_account_sid: string; twilio_auth_token: string; twilio_from: string }
    | undefined;
  const dec = (v: string | undefined): string => (v ? decryptValue(v) : "");
  return {
    pushoverAppToken: dec(row?.pushover_app_token),
    twilioAccountSid: dec(row?.twilio_account_sid),
    twilioAuthToken: dec(row?.twilio_auth_token),
    twilioFrom: dec(row?.twilio_from),
  };
}

export function setNotifyPrefs(
  userId: string,
  partial: { channels?: unknown; pushTarget?: unknown; pushoverTarget?: unknown; webhookUrl?: unknown; email?: unknown; phone?: unknown;
             pushoverAppToken?: unknown; twilioAccountSid?: unknown; twilioAuthToken?: unknown; twilioFrom?: unknown;
             watchlistDigestEnabled?: unknown }
): NotifyPrefs {
  const next: NotifyPrefs = { ...getNotifyPrefs(userId), userId };
  if (Array.isArray(partial.channels)) {
    next.channels = [...new Set(partial.channels.filter(isNotifyChannelId))];
  }
  if (typeof partial.pushTarget === "string") next.pushTarget = partial.pushTarget.trim();
  if (typeof partial.pushoverTarget === "string") next.pushoverTarget = partial.pushoverTarget.trim();
  if (typeof partial.webhookUrl === "string") next.webhookUrl = partial.webhookUrl.trim();
  if (typeof partial.email === "string") next.email = partial.email.trim();
  if (typeof partial.phone === "string") next.phone = partial.phone.trim();
  if (typeof partial.watchlistDigestEnabled === "boolean") next.watchlistDigestEnabled = partial.watchlistDigestEnabled;
  next.updatedAt = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO notification_prefs (user_id, channels, push_target, pushover_target, webhook_url, email, phone, watchlist_digest_enabled, updated_at)
       VALUES (@userId, @channels, @pushTarget, @pushoverTarget, @webhookUrl, @email, @phone, @watchlistDigestEnabled, @updatedAt)
       ON CONFLICT(user_id) DO UPDATE SET
         channels = excluded.channels, push_target = excluded.push_target, pushover_target = excluded.pushover_target, webhook_url = excluded.webhook_url,
         email = excluded.email, phone = excluded.phone, watchlist_digest_enabled = excluded.watchlist_digest_enabled, updated_at = excluded.updated_at`
    )
    .run({
      userId,
      channels: JSON.stringify(next.channels),
      pushTarget: next.pushTarget,
      pushoverTarget: next.pushoverTarget,
      webhookUrl: next.webhookUrl,
      email: next.email,
      phone: next.phone,
      watchlistDigestEnabled: next.watchlistDigestEnabled ? 1 : 0,
      updatedAt: next.updatedAt
    });

  // Secret credential fields: undefined = keep stored value, "" = clear,
  // non-empty = encrypt + replace. Values are never returned to clients —
  // the UI round-trips presence flags (next.*Set) only.
  const secretFields: Array<[string, unknown]> = [
    ["pushover_app_token", partial.pushoverAppToken],
    ["twilio_account_sid", partial.twilioAccountSid],
    ["twilio_auth_token", partial.twilioAuthToken],
    ["twilio_from", partial.twilioFrom],
  ];
  for (const [column, value] of secretFields) {
    if (value === undefined) continue;
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    getDb()
      .prepare(`UPDATE notification_prefs SET ${column} = ? WHERE user_id = ?`)
      .run(trimmed === "" ? "" : encryptValue(trimmed), userId);
    audit("notify.prefs.secret_set", { userId, column, action: trimmed === "" ? "cleared" : "replaced" }, userId);
  }

  audit("notify.prefs.set", { userId, channels: next.channels }, userId);
  return getNotifyPrefs(userId);
}

// ── Chat turns ────────────────────────────────────────────────────────────────

interface RawChatTurnRow {
  id: string;
  user_id: string;
  role: string;
  text: string;
  citations: string;
  intent: string | null;
  redacted: number;
  model: string | null;
  client_turn_id: string | null;
  created_at: string;
}

function mapChatTurn(row: RawChatTurnRow): ChatTurn {
  let citations: string[] = [];
  try {
    const parsed = JSON.parse(row.citations) as unknown;
    if (Array.isArray(parsed)) citations = parsed.filter((c): c is string => typeof c === "string");
  } catch {
    citations = [];
  }
  const role: ChatTurnRole = row.role === "assistant" ? "assistant" : "user";
  return {
    id: row.id,
    userId: row.user_id,
    role,
    text: row.text,
    citations,
    intent: row.intent,
    redacted: row.redacted === 1,
    model: row.model ?? null,
    clientTurnId: row.client_turn_id ?? null,
    createdAt: row.created_at
  };
}

export function insertChatTurn(turn: ChatTurn): ChatTurn {
  getDb()
    .prepare(
      "INSERT INTO chat_turns (id, user_id, role, text, citations, intent, redacted, model, client_turn_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .run(turn.id, turn.userId, turn.role, turn.text, JSON.stringify(turn.citations), turn.intent ?? null, turn.redacted ? 1 : 0, turn.model ?? null, turn.clientTurnId ?? null, turn.createdAt);
  return turn;
}

/** Per-user idempotency lookup: the turn previously recorded with this client-generated id, if any. */
export function findChatTurnByClientId(userId: string, clientTurnId: string): ChatTurn | null {
  const row = getDb()
    .prepare("SELECT * FROM chat_turns WHERE user_id = ? AND client_turn_id = ? ORDER BY created_at ASC, rowid ASC LIMIT 1")
    .get(userId, clientTurnId) as RawChatTurnRow | undefined;
  return row ? mapChatTurn(row) : null;
}

export function listChatTurns(userId: string, limit: number = 100): ChatTurn[] {
  const rows = getDb()
    .prepare("SELECT * FROM chat_turns WHERE user_id = ? ORDER BY created_at ASC, rowid ASC")
    .all(userId) as RawChatTurnRow[];
  const mapped = rows.map(mapChatTurn);
  return limit > 0 && mapped.length > limit ? mapped.slice(mapped.length - limit) : mapped;
}

/**
 * EVERY user's chat turns, most recent `limit` across the whole table, in chronological order.
 * Unscoped by design and therefore admin-only: the sole caller is the requireAdmin-gated
 * `/api/admin/transcript`. Ordinary per-caller reads must keep using `listChatTurns(userId, ...)`.
 */
export function listAllChatTurns(limit: number = 100): ChatTurn[] {
  const n = Math.max(1, Number(limit) || 1);
  const rows = getDb()
    .prepare("SELECT * FROM chat_turns ORDER BY created_at DESC, rowid DESC LIMIT ?")
    .all(n) as RawChatTurnRow[];
  return rows.map(mapChatTurn).reverse();
}

/** Keep only the most recent `keep` turns for a user (FIFO cap); returns rows deleted. */
export function trimChatTurns(userId: string, keep: number): number {
  return getDb()
    .prepare(
      `DELETE FROM chat_turns WHERE user_id = ? AND id NOT IN (
         SELECT id FROM chat_turns WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?
       )`
    )
    .run(userId, userId, keep).changes;
}

export function clearChatTurns(userId: string): number {
  return getDb().prepare("DELETE FROM chat_turns WHERE user_id = ?").run(userId).changes;
}

// ── Memory ────────────────────────────────────────────────────────────────────

interface RawMemoryRow {
  id: string;
  user_id: string;
  kind: string;
  subject: string;
  value: string;
  source: string;
  confidence: number;
  hard: number;
  asserted_at: string;
  superseded_by: string | null;
}

function mapMemory(row: RawMemoryRow): MemoryItem {
  return {
    id: row.id,
    userId: row.user_id,
    kind: row.kind as MemoryItem["kind"],
    subject: row.subject,
    value: row.value,
    source: row.source,
    confidence: row.confidence,
    hard: row.hard === 1,
    assertedAt: row.asserted_at,
    supersededBy: row.superseded_by
  };
}

export function insertMemory(item: MemoryItem): MemoryItem {
  getDb()
    .prepare(
      "INSERT INTO user_memory (id, user_id, kind, subject, value, source, confidence, hard, asserted_at, superseded_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .run(item.id, item.userId, item.kind, item.subject, item.value, item.source, item.confidence, item.hard ? 1 : 0, item.assertedAt, item.supersededBy);
  return item;
}

export function findLiveMemoryBySubject(userId: string, kind: string, subject: string): MemoryItem | null {
  const row = getDb()
    .prepare(
      "SELECT * FROM user_memory WHERE user_id = ? AND kind = ? AND subject = ? AND superseded_by IS NULL ORDER BY asserted_at DESC LIMIT 1"
    )
    .get(userId, kind, subject) as RawMemoryRow | undefined;
  return row ? mapMemory(row) : null;
}

export function listLiveMemory(userId: string): MemoryItem[] {
  const rows = getDb()
    .prepare("SELECT * FROM user_memory WHERE user_id = ? AND superseded_by IS NULL ORDER BY asserted_at DESC")
    .all(userId) as RawMemoryRow[];
  return rows.map(mapMemory);
}

export function supersedeMemory(oldId: string, newId: string): void {
  getDb().prepare("UPDATE user_memory SET superseded_by = ? WHERE id = ?").run(newId, oldId);
}

export function touchMemory(id: string, assertedAt: string, confidence: number): MemoryItem | null {
  getDb().prepare("UPDATE user_memory SET asserted_at = ?, confidence = ? WHERE id = ?").run(assertedAt, confidence, id);
  const row = getDb().prepare("SELECT * FROM user_memory WHERE id = ?").get(id) as RawMemoryRow | undefined;
  return row ? mapMemory(row) : null;
}

export function deleteMemory(userId: string, id: string): boolean {
  return getDb().prepare("DELETE FROM user_memory WHERE id = ? AND user_id = ?").run(id, userId).changes > 0;
}

// ── Take-profit trim ratchet ────────────────────────────────────────────────
// Monotonic "band" already trimmed per open profitable position, so a partial take-profit trims once
// per take-profit band instead of laddering out every run. See take_profit_trims (db.ts migrate()).

export interface TakeProfitTrimBand {
  /** Highest take-profit band already trimmed for the lot. */
  band: number;
  /** Position cost basis when the band was recorded — ratchet resets when the live basis differs (rebuy). */
  avgCost: number;
}

/** Map of symbol → {band, avgCost} of the highest already-trimmed take-profit band (empty when none). */
export function getTakeProfitTrimBands(accountNumber: string, userId: string = "local"): Record<string, TakeProfitTrimBand> {
  const rows = getDb()
    .prepare("SELECT symbol, band, avg_cost FROM take_profit_trims WHERE user_id = ? AND account_number = ?")
    .all(userId, accountNumber) as Array<{ symbol: string; band: number; avg_cost: number }>;
  const out: Record<string, TakeProfitTrimBand> = {};
  for (const r of rows) out[r.symbol] = { band: Number(r.band) || 0, avgCost: Number(r.avg_cost) || 0 };
  return out;
}

/** Record (upsert) the highest take-profit band trimmed for a position lot (band + its cost basis). */
export function recordTakeProfitTrimBand(
  accountNumber: string,
  symbol: string,
  band: number,
  avgCost: number,
  userId: string = "local",
  now: string = new Date().toISOString()
): void {
  getDb()
    .prepare(
      `INSERT INTO take_profit_trims (user_id, account_number, symbol, band, avg_cost, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, account_number, symbol)
       DO UPDATE SET band = excluded.band, avg_cost = excluded.avg_cost, updated_at = excluded.updated_at`
    )
    .run(userId, accountNumber, symbol, Math.max(0, Math.floor(band)), Number.isFinite(avgCost) ? avgCost : 0, now);
}

/** Clear ratchet state for the given symbols (e.g. positions that have closed). No-op on empty input. */
export function clearTakeProfitTrimBands(accountNumber: string, symbols: string[], userId: string = "local"): void {
  if (symbols.length === 0) return;
  const placeholders = symbols.map(() => "?").join(",");
  getDb()
    .prepare(`DELETE FROM take_profit_trims WHERE user_id = ? AND account_number = ? AND symbol IN (${placeholders})`)
    .run(userId, accountNumber, ...symbols);
}

// ── Per-position stop plan ──────────────────────────────────────────────────
// The LLM's chosen stop-loss TYPE for an open position, set at opening-fill time and read by every
// stop-enforcement layer for the position's life. Modeled directly on the take-profit trim ratchet
// above. See position_stop_plans (db.ts migrate()).

export interface PositionStopPlan {
  style: StopPlanStyle;
  rationale?: string;
  /** Position cost basis when the plan was recorded — resets on a close+rebuy (different lot). */
  avgCost: number;
  /**
   * Direction of the lot the plan was recorded against — "long" for an opening buy, "short" for an
   * opening short. Compared alongside avgCost by filterFullStopPlansByLiveBasis so a long's plan can
   * never leak onto a short opened later in the same symbol at a coincidentally similar basis (or
   * vice versa) — closing a long and shorting the same name is a distinct lot, not a continuation
   * (Codex review, PR #1371). Optional only for backward-compat with rows written before this field
   * existed; such a row never matches any live position (side is undefined) and simply ages out via
   * the normal stale-plan cleanup.
   */
  side?: "long" | "short";
  /**
   * Order ID of the MOST RECENT broker-native bracket (Alpaca order_class "bracket", Tradier
   * "otoco") placed while this plan's style has sat at "fixed"/"atr" — undefined for
   * trailing/none/default, or on an account/broker without native bracket support. Display-only —
   * a same-style scale-in places an ADDITIONAL bracket without replacing an earlier one, so this
   * single field can't represent (and is not used to drive) sibling-leg teardown; that's tracked
   * separately, across ALL brackets for the symbol, in position_stop_plan_open_brackets (see
   * trackOpenBracketOrder/enqueueTeardownForAllOpenBrackets and pending_bracket_teardowns in db.ts).
   */
  openingOrderId?: string;
  /**
   * Exit Contract (Phase B1): resolved stop distance (%) written at fill from the same number
   * enrichOpeningProposal used for the opening bracket. Null/undefined on legacy rows — callers
   * MUST fall back to account-policy / ATR recompute (see `persistedOrFallbackStopPct`).
   */
  resolvedStopPct?: number;
  /** Absolute stop trigger price at fill (when a bracket stop was attached). */
  stopPrice?: number;
  /** ATR-derived % captured at fill for atr-style plans (informational / future revision). */
  entryAtrPct?: number;
  /** Trailing distance % when style is trailing. */
  trailPercent?: number;
  /** Take-profit price when a bracket TP was attached at fill. */
  takeProfitPrice?: number;
  /** ISO timestamp for a time-stop (Phase C); nullable substrate only in B1. */
  maxHoldingUntil?: string;
  /** Falsifiable kill-condition prose (Phase C); nullable substrate only in B1. */
  invalidation?: string;
}

/** Optional Exit Contract fields accepted by `recordStopPlan` (Phase B1). */
export interface ExitContractWrite {
  resolvedStopPct?: number | null;
  stopPrice?: number | null;
  entryAtrPct?: number | null;
  trailPercent?: number | null;
  takeProfitPrice?: number | null;
  maxHoldingUntil?: string | null;
  invalidation?: string | null;
}

/**
 * Prefer a persisted Exit Contract stop distance when present and finite; otherwise the
 * already-computed account/ATR/beta fallback. Never invents a distance — null contract → fallback.
 */
export function persistedOrFallbackStopPct(
  plan: PositionStopPlan | undefined,
  fallbackPct: number
): number {
  const persisted = plan?.resolvedStopPct;
  if (typeof persisted === "number" && Number.isFinite(persisted) && persisted > 0) return persisted;
  return fallbackPct;
}

/**
 * Derive Exit Contract numerics from an opening proposal + lot basis at fill time.
 * Uses bracket legs when present; for trailing plans, uses `trailPercent` when set.
 */
export function deriveExitContractFromOpening(input: {
  side: "buy" | "short";
  avgCost: number;
  bracketStopLoss?: number;
  bracketTakeProfit?: number;
  trailPercent?: number;
  atrStopPct?: number;
  invalidation?: string;
  maxHoldingDays?: number;
  filledAt?: string;
}): ExitContractWrite {
  const out: ExitContractWrite = {};
  const avg = input.avgCost;
  const stop = input.bracketStopLoss;
  if (typeof stop === "number" && Number.isFinite(stop) && stop > 0 && avg > 0) {
    out.stopPrice = stop;
    const pct =
      input.side === "short"
        ? ((stop - avg) / avg) * 100
        : ((avg - stop) / avg) * 100;
    if (Number.isFinite(pct) && pct > 0) out.resolvedStopPct = pct;
  }
  if (typeof input.bracketTakeProfit === "number" && Number.isFinite(input.bracketTakeProfit) && input.bracketTakeProfit > 0) {
    out.takeProfitPrice = input.bracketTakeProfit;
  }
  if (typeof input.trailPercent === "number" && Number.isFinite(input.trailPercent) && input.trailPercent > 0) {
    out.trailPercent = input.trailPercent;
    // Trailing distance is also the resolved distance for trail-style plans.
    if (out.resolvedStopPct == null) out.resolvedStopPct = input.trailPercent;
  }
  if (typeof input.atrStopPct === "number" && Number.isFinite(input.atrStopPct) && input.atrStopPct > 0) {
    out.entryAtrPct = input.atrStopPct;
    if (out.resolvedStopPct == null) out.resolvedStopPct = input.atrStopPct;
  }
  if (typeof input.invalidation === "string" && input.invalidation.trim()) {
    out.invalidation = input.invalidation.trim().slice(0, 1000);
  }
  if (typeof input.maxHoldingDays === "number" && Number.isFinite(input.maxHoldingDays) && input.maxHoldingDays > 0) {
    const base = input.filledAt ? Date.parse(input.filledAt) : Date.now();
    if (Number.isFinite(base)) {
      out.maxHoldingUntil = new Date(base + input.maxHoldingDays * 86_400_000).toISOString();
    }
  }
  return out;
}

/** Map of symbol → its recorded per-position stop plan (empty when none set — every position then
 *  falls back to the account's default stop precedence, unchanged from before this feature). */
export function getStopPlans(accountNumber: string, userId: string = "local"): Record<string, PositionStopPlan> {
  const rows = getDb()
    .prepare(
      `SELECT symbol, style, rationale, avg_cost, side, opening_order_id,
              resolved_stop_pct, stop_price, entry_atr_pct, trail_percent,
              take_profit_price, max_holding_until, invalidation
       FROM position_stop_plans WHERE user_id = ? AND account_number = ?`
    )
    .all(userId, accountNumber) as Array<{
      symbol: string;
      style: string;
      rationale: string | null;
      avg_cost: number;
      side: string | null;
      opening_order_id: string | null;
      resolved_stop_pct: number | null;
      stop_price: number | null;
      entry_atr_pct: number | null;
      trail_percent: number | null;
      take_profit_price: number | null;
      max_holding_until: string | null;
      invalidation: string | null;
    }>;
  const out: Record<string, PositionStopPlan> = {};
  for (const r of rows) {
    const style = (STOP_PLAN_STYLES as readonly string[]).includes(r.style) ? (r.style as StopPlanStyle) : "default";
    const finite = (n: number | null | undefined): number | undefined =>
      typeof n === "number" && Number.isFinite(n) ? n : undefined;
    out[r.symbol] = {
      style,
      rationale: r.rationale ?? undefined,
      avgCost: Number(r.avg_cost) || 0,
      side: r.side === "long" || r.side === "short" ? r.side : undefined,
      openingOrderId: r.opening_order_id ?? undefined,
      ...(finite(r.resolved_stop_pct) != null ? { resolvedStopPct: finite(r.resolved_stop_pct) } : {}),
      ...(finite(r.stop_price) != null ? { stopPrice: finite(r.stop_price) } : {}),
      ...(finite(r.entry_atr_pct) != null ? { entryAtrPct: finite(r.entry_atr_pct) } : {}),
      ...(finite(r.trail_percent) != null ? { trailPercent: finite(r.trail_percent) } : {}),
      ...(finite(r.take_profit_price) != null ? { takeProfitPrice: finite(r.take_profit_price) } : {}),
      ...(r.max_holding_until ? { maxHoldingUntil: r.max_holding_until } : {}),
      ...(r.invalidation ? { invalidation: r.invalidation } : {})
    };
  }
  return out;
}

/**
 * Filter the account's persisted per-position stop plans down to the ones that actually apply to
 * the CURRENT lot. Ratchet-style basis check (mirrors planTakeProfitTrims' lastBand-keyed-to-avgCost
 * pattern): a persisted plan only counts if its recorded avgCost still matches the LIVE position's
 * averageCost. Without this, a symbol closed and re-bought before any run ever observed it flat
 * (e.g. a fast broker/manual close+reopen the app's own clearStopPlans sweep never caught between
 * ticks) could have its stale "none"/"trailing"/fixed plan silently govern a completely different
 * lot (Codex review, PR #1371). A symbol with no CURRENT position at all has no basis to compare and
 * is skipped too — a persisted row only ever makes sense for a scale-in add to an already-open
 * position. Colocated here (not in strategy.ts, which re-exports it) so both strategy.ts and
 * synthetic-stops.ts can share it without depending on each other.
 */
export function filterStopPlansByLiveBasis(
  plans: Record<string, PositionStopPlan>,
  positions: EquityPosition[]
): Record<string, StopPlanStyle> {
  const out: Record<string, StopPlanStyle> = {};
  for (const [sym, plan] of Object.entries(filterFullStopPlansByLiveBasis(plans, positions))) {
    out[sym] = plan.style;
  }
  return out;
}

/**
 * Same live-basis filter as `filterStopPlansByLiveBasis`, but preserves the FULL `PositionStopPlan`
 * (rationale + avgCost included) rather than narrowing to just the style — for a display-only
 * consumer (the dashboard/Positions table) that needs the rationale text too, not just the
 * enforcement-relevant style (Codex review, PR #1371: the dashboard read `getStopPlans` directly,
 * unfiltered, so it could still label a closed-and-rebought symbol's NEW position with the OLD
 * lot's plan).
 */
export function filterFullStopPlansByLiveBasis(
  plans: Record<string, PositionStopPlan>,
  positions: EquityPosition[]
): Record<string, PositionStopPlan> {
  const liveBySymbol = new Map(
    positions
      .filter((p) => Math.abs(p.quantity) > 0.000001)
      .map((p) => [normalizeSymbol(p.symbol), { avgCost: p.averageCost, side: (p.quantity > 0 ? "long" : "short") as "long" | "short" }])
  );
  const out: Record<string, PositionStopPlan> = {};
  for (const [sym, plan] of Object.entries(plans)) {
    if (plan.style === "default") continue;
    const s = normalizeSymbol(sym);
    const live = liveBySymbol.get(s);
    if (!live) continue;
    if (Math.abs(plan.avgCost - live.avgCost) >= 0.005) continue;
    // A plan recorded before the `side` field existed (undefined) can't be verified against the
    // live position's direction — treat as a mismatch (skip) rather than assume a match, since a
    // false "match" is exactly the stale-plan-leak this filter exists to prevent.
    if (plan.side !== live.side) continue;
    out[s] = plan;
  }
  return out;
}

/**
 * Track a broker-native bracket order placed while a "fixed"/"atr" plan is active for a symbol —
 * appended to `position_stop_plan_open_brackets`, NOT overwriting anything. A same-style scale-in
 * (e.g. "fixed" -> "fixed") places a BRAND-NEW, independently-resting bracket sized ONLY to its own
 * added shares (Alpaca: orderArgs.qty from that order's own quantity; Tradier: each exit leg sized
 * to that order's wholeQty) — it does NOT replace or resize the PRIOR bracket, which is still the
 * genuine, still-needed protection for the pre-existing lot. So every distinct bracket order id gets
 * its own row here, and NONE of them are torn down until the whole family is (see
 * enqueueTeardownForAllOpenBrackets) — tearing down a same-style scale-in's prior bracket would
 * cancel a live, correct stop-loss/take-profit and leave that earlier lot with NO protection at all
 * (Codex review, PR #1667, catching an incomplete first attempt at this same fix). Never throws:
 * plan bookkeeping must never block the write that's actually recording the plan. De-duplicates on
 * (symbol, order_id) so a retried/replayed fill-recording call can't double-track the same bracket.
 */
function trackOpenBracketOrder(accountNumber: string, symbol: string, userId: string, orderId: string): void {
  try {
    const already = getDb()
      .prepare(
        `SELECT 1 FROM position_stop_plan_open_brackets WHERE user_id = ? AND account_number = ? AND symbol = ? AND order_id = ?`
      )
      .get(userId, accountNumber, symbol, orderId);
    if (already) return;
    getDb()
      .prepare(
        `INSERT INTO position_stop_plan_open_brackets (id, user_id, account_number, symbol, order_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(crypto.randomUUID(), userId, accountNumber, symbol, orderId, new Date().toISOString());
  } catch {
    // best-effort — a missed tracking row leaves that one bracket forever untracked for future
    // teardown, but never breaks the plan write itself
  }
}

/**
 * Enqueues a teardown (via pending_bracket_teardowns, reconciler in broker-protective-stops.ts) for
 * EVERY broker-native bracket ever tracked for this symbol while it sat in the fixed/atr family — not
 * just the latest — then clears the tracking rows. Called ONLY when the plan genuinely LEAVES the
 * fixed/atr family entirely (a real style change to trailing/none/default, or the position closes),
 * never on a same-style scale-in (see trackOpenBracketOrder's doc comment for why). Never throws.
 */
export function enqueueTeardownForAllOpenBrackets(accountNumber: string, symbol: string, userId: string): void {
  try {
    const rows = getDb()
      .prepare(`SELECT order_id FROM position_stop_plan_open_brackets WHERE user_id = ? AND account_number = ? AND symbol = ?`)
      .all(userId, accountNumber, symbol) as Array<{ order_id: string }>;
    if (rows.length === 0) return;
    const db = getDb();
    const insertTeardown = db.prepare(
      `INSERT INTO pending_bracket_teardowns (id, user_id, account_number, symbol, order_id, created_at, attempts)
       VALUES (?, ?, ?, ?, ?, ?, 0)`
    );
    const now = new Date().toISOString();
    for (const row of rows) {
      insertTeardown.run(crypto.randomUUID(), userId, accountNumber, symbol, row.order_id, now);
    }
    db.prepare(`DELETE FROM position_stop_plan_open_brackets WHERE user_id = ? AND account_number = ? AND symbol = ?`)
      .run(userId, accountNumber, symbol);
  } catch {
    // best-effort — a missed teardown enqueue leaves resting bracket legs for a human/later sweep
    // to notice, never breaks the plan write itself
  }
}

/**
 * Record (upsert) the stop plan for a position lot. Invalid/unrecognized styles fall back to
 * "default". `openingOrderId` should be set ONLY when this write is establishing a fresh "fixed"/
 * "atr" plan whose opening fill placed a broker-native bracket (Alpaca/Tradier) — omitted for
 * trailing/none/default, or when no bracket was placed. When this write is landing IN the
 * fixed/atr family, the bracket order id is tracked (never torn down by itself — see
 * trackOpenBracketOrder). When this write is a genuine transition OUT of the fixed/atr family,
 * every bracket ever tracked for this symbol is enqueued for teardown together (see
 * enqueueTeardownForAllOpenBrackets).
 */
export function recordStopPlan(
  accountNumber: string,
  symbol: string,
  style: string,
  rationale: string | undefined,
  avgCost: number,
  userId: string = "local",
  now: string = new Date().toISOString(),
  side: "long" | "short" = "long",
  openingOrderId?: string,
  contract: ExitContractWrite = {}
): void {
  const safeStyle = (STOP_PLAN_STYLES as readonly string[]).includes(style) ? style : "default";
  if (safeStyle === "fixed" || safeStyle === "atr") {
    // A "fixed" <-> "atr" transition is DELIBERATELY treated the same as a same-style scale-in —
    // never torn down here. A codex-autofix run on this PR briefly added a teardown for exactly
    // this transition (mirroring Codex's own suggested remedy), but that's a real regression, not
    // a fix: a fixed and an atr bracket are computed differently, but mechanically they're the
    // SAME kind of thing — an independent broker-native bracket sized ONLY to its own lot's
    // quantity, with nothing else ever recreating equivalent protection for an earlier lot.
    // Tearing down the earlier tracked bracket on a fixed<->atr transition would cancel a still-
    // resting, still-valid stop-loss/take-profit for the pre-existing shares, leaving them with NO
    // protection at all — reintroducing the exact P1 this whole redesign exists to prevent. See the
    // reasoning posted on PR #1667's review thread. Teardown fires ONLY when the plan genuinely
    // LEAVES the whole distance-bracket family (trailing/none/default, or close) — that's the only
    // time nothing else is still relying on the old brackets.
    if (openingOrderId) trackOpenBracketOrder(accountNumber, symbol, userId, openingOrderId);
  } else {
    enqueueTeardownForAllOpenBrackets(accountNumber, symbol, userId);
  }
  const finiteOrNull = (n: number | null | undefined): number | null =>
    typeof n === "number" && Number.isFinite(n) ? n : null;
  getDb()
    .prepare(
      `INSERT INTO position_stop_plans (
         user_id, account_number, symbol, style, rationale, avg_cost, updated_at, side, opening_order_id,
         resolved_stop_pct, stop_price, entry_atr_pct, trail_percent, take_profit_price, max_holding_until, invalidation
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, account_number, symbol)
       DO UPDATE SET
         style = excluded.style,
         rationale = excluded.rationale,
         avg_cost = excluded.avg_cost,
         updated_at = excluded.updated_at,
         side = excluded.side,
         opening_order_id = excluded.opening_order_id,
         resolved_stop_pct = excluded.resolved_stop_pct,
         stop_price = excluded.stop_price,
         entry_atr_pct = excluded.entry_atr_pct,
         trail_percent = excluded.trail_percent,
         take_profit_price = excluded.take_profit_price,
         max_holding_until = excluded.max_holding_until,
         invalidation = excluded.invalidation`
    )
    .run(
      userId,
      accountNumber,
      symbol,
      safeStyle,
      rationale ?? null,
      Number.isFinite(avgCost) ? avgCost : 0,
      now,
      side,
      openingOrderId ?? null,
      finiteOrNull(contract.resolvedStopPct ?? null),
      finiteOrNull(contract.stopPrice ?? null),
      finiteOrNull(contract.entryAtrPct ?? null),
      finiteOrNull(contract.trailPercent ?? null),
      finiteOrNull(contract.takeProfitPrice ?? null),
      contract.maxHoldingUntil ?? null,
      contract.invalidation ?? null
    );
}

/** Clear stop plans for the given symbols (e.g. positions that have closed). No-op on empty input.
 *  A closed position needs every bracket ever tracked for it torn down (see
 *  enqueueTeardownForAllOpenBrackets), regardless of what style it was last recorded at. */
export function clearStopPlans(accountNumber: string, symbols: string[], userId: string = "local"): void {
  if (symbols.length === 0) return;
  const placeholders = symbols.map(() => "?").join(",");
  for (const symbol of symbols) {
    enqueueTeardownForAllOpenBrackets(accountNumber, symbol, userId);
  }
  getDb()
    .prepare(`DELETE FROM position_stop_plans WHERE user_id = ? AND account_number = ? AND symbol IN (${placeholders})`)
    .run(userId, accountNumber, ...symbols);
}

/** A bracket teardown queued by enqueueTeardownForAllOpenBrackets, awaiting the sweep. */
export interface PendingBracketTeardown {
  id: string;
  accountNumber: string;
  symbol: string;
  orderId: string;
  createdAt: string;
  attempts: number;
}

/** List pending bracket teardowns for an account (oldest first). */
export function listPendingBracketTeardowns(accountNumber: string, userId: string = "local"): PendingBracketTeardown[] {
  const rows = getDb()
    .prepare(
      `SELECT id, account_number, symbol, order_id, created_at, attempts
       FROM pending_bracket_teardowns WHERE user_id = ? AND account_number = ? ORDER BY created_at ASC`
    )
    .all(userId, accountNumber) as Array<{ id: string; account_number: string; symbol: string; order_id: string; created_at: string; attempts: number }>;
  return rows.map((r) => ({ id: r.id, accountNumber: r.account_number, symbol: r.symbol, orderId: r.order_id, createdAt: r.created_at, attempts: r.attempts }));
}

/** Remove a pending bracket teardown once resolved (legs cancelled, already terminal, or aged out). */
export function removePendingBracketTeardown(id: string): void {
  getDb().prepare("DELETE FROM pending_bracket_teardowns WHERE id = ?").run(id);
}

/** Record a failed/inconclusive teardown attempt (bumps the retry counter the sweep uses to age out). */
export function bumpPendingBracketTeardownAttempts(id: string): void {
  getDb().prepare("UPDATE pending_bracket_teardowns SET attempts = attempts + 1 WHERE id = ?").run(id);
}

/** A broker-native bracket order tracked by trackOpenBracketOrder, not yet torn down. */
export interface OpenBracketOrder {
  id: string;
  accountNumber: string;
  symbol: string;
  orderId: string;
  createdAt: string;
}

/** List every bracket order still tracked (not yet torn down) for a symbol, oldest first. Test/
 *  observability accessor — production code drives entirely off trackOpenBracketOrder/
 *  enqueueTeardownForAllOpenBrackets. */
export function listOpenBracketOrders(accountNumber: string, symbol: string, userId: string = "local"): OpenBracketOrder[] {
  const rows = getDb()
    .prepare(
      `SELECT id, account_number, symbol, order_id, created_at
       FROM position_stop_plan_open_brackets WHERE user_id = ? AND account_number = ? AND symbol = ? ORDER BY created_at ASC`
    )
    .all(userId, accountNumber, symbol) as Array<{ id: string; account_number: string; symbol: string; order_id: string; created_at: string }>;
  return rows.map((r) => ({ id: r.id, accountNumber: r.account_number, symbol: r.symbol, orderId: r.order_id, createdAt: r.created_at }));
}

// ── Durable pre-network intent for broker protective-stop placement ───────────
// (the broker_stop_placement_intents migration, src/lib/db.ts). One row per (user, account, symbol)
// — see that migration's comment
// for the crash/duplicate-placement rationale. Written BEFORE the broker call in
// reconcileBrokerProtectiveStops, deleted on every definite outcome; a call that throws leaves the
// row so the next tick can adopt the order it already placed instead of duplicating it.

export interface BrokerStopPlacementIntent {
  userId: string;
  accountNumber: string;
  symbol: string;
  clientOrderId: string;
  quantity: number;
  stopPrice: number;
  kind: "fixed" | "trailing";
  trailPercent?: number;
  createdAt: string;
}

export function upsertBrokerStopPlacementIntent(intent: Omit<BrokerStopPlacementIntent, "createdAt">): void {
  getDb()
    .prepare(
      `INSERT INTO broker_stop_placement_intents
         (user_id, account_number, symbol, client_order_id, quantity, stop_price, kind, trail_percent, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, account_number, symbol) DO UPDATE SET
         client_order_id = excluded.client_order_id,
         quantity = excluded.quantity,
         stop_price = excluded.stop_price,
         kind = excluded.kind,
         trail_percent = excluded.trail_percent,
         created_at = excluded.created_at`
    )
    .run(
      intent.userId, intent.accountNumber, intent.symbol, intent.clientOrderId,
      intent.quantity, intent.stopPrice, intent.kind, intent.trailPercent ?? null, new Date().toISOString()
    );
}

export function getBrokerStopPlacementIntent(accountNumber: string, symbol: string, userId: string = "local"): BrokerStopPlacementIntent | undefined {
  const row = getDb()
    .prepare("SELECT * FROM broker_stop_placement_intents WHERE user_id = ? AND account_number = ? AND symbol = ?")
    .get(userId, accountNumber, symbol) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return {
    userId: String(row.user_id),
    accountNumber: String(row.account_number),
    symbol: String(row.symbol),
    clientOrderId: String(row.client_order_id),
    quantity: Number(row.quantity),
    stopPrice: Number(row.stop_price),
    kind: row.kind === "trailing" ? "trailing" : "fixed",
    trailPercent: row.trail_percent == null ? undefined : Number(row.trail_percent),
    createdAt: String(row.created_at)
  };
}

export function deleteBrokerStopPlacementIntent(accountNumber: string, symbol: string, userId: string = "local"): void {
  getDb().prepare("DELETE FROM broker_stop_placement_intents WHERE user_id = ? AND account_number = ? AND symbol = ?").run(userId, accountNumber, symbol);
}
