/**
 * src/lib/user-proxy-settings.ts
 *
 * Per-user data-source proxy settings (owner request 2026-09-25: "make it so
 * each user can put their own proxy settings in"). When a user has proxying
 * enabled, THAT user's market-data/provider egress (quote cascade, enrichment
 * providers, screeners) exits through their proxy instead of the operator
 * default (RESIDENTIAL_PROXY_* env / the Mango WireGuard default).
 *
 * Storage mirrors the user_api_keys pattern: one row per user in
 * user_proxy_settings (DDL in src/lib/db.ts), password encrypted at rest with
 * the same encryptValue()/ENCRYPTION_KEY machinery as API keys
 * (src/lib/db-api-keys.ts). The API only ever returns a masked view.
 *
 * Validation notes:
 * - A proxy legitimately lives on a PRIVATE address (the fleet's own proxy is
 *   10.99.0.2 on the WireGuard mesh), so RFC1918 is allowed. Loopback,
 *   link-local/metadata (169.254.0.0/16), and "localhost" are blocked: a proxy
 *   on loopback would silently route the user's provider traffic through THIS
 *   server, and 169.254.169.254 is the cloud metadata endpoint.
 * - The proxy address is where we CONNECT; what the proxy then reaches is the
 *   user's own responsibility (it is their proxy).
 */

import "server-only";
import net from "net";
import { getDb } from "./db";
import { decryptValue, encryptValue } from "./db-api-keys";
import { formatProxyUrl, type ProxyFailureMode } from "./proxy-fetch";

export interface UserProxySettingsInput {
  enabled: boolean;
  protocol: "http" | "https";
  host: string;
  port?: number | null;
  username?: string | null;
  /** Plaintext on input; encrypted before storage. undefined = keep existing (PATCH semantics). */
  password?: string | null;
  failureMode: ProxyFailureMode;
}

export interface UserProxySettingsView {
  enabled: boolean;
  protocol: "http" | "https";
  host: string;
  port: number | null;
  username: string | null;
  hasPassword: boolean;
  failureMode: ProxyFailureMode;
  updatedAt: string;
}

interface UserProxySettingsRow {
  user_id: string;
  enabled: number;
  protocol: string;
  host: string;
  port: number | null;
  username: string | null;
  password: string | null;
  failure_mode: string;
  created_at: string;
  updated_at: string;
}

export interface ResolvedUserProxy {
  proxyUrl: string;
  failureMode: ProxyFailureMode;
}

// ── Validation ──────────────────────────────────────────────────────────────

/** True for loopback / link-local / metadata / "localhost" — never valid proxy destinations. */
export function isBlockedProxyHost(rawHost: string): boolean {
  const host = rawHost.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) return true;
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  const family = net.isIP(host);
  if (family === 4) {
    const parts = host.split(".").map((p) => Number(p));
    const [a, b] = parts;
    if (a === 127) return true; // loopback
    if (a === 0) return true; // "this" network
    if (a === 169 && b === 254) return true; // link-local incl. cloud metadata
    return false; // other IPv4, incl. RFC1918 (WireGuard mesh), is allowed
  }
  if (family === 6) {
    if (host === "::1" || host === "::") return true;
    const firstGroup = host.split(":")[0];
    const g0 = parseInt(firstGroup || "0", 16);
    if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
    return false;
  }
  // DNS name: charset/shape only — it may only resolve on the server (e.g. a wg hostname).
  if (host.length > 253) return true;
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(host)) return true;
  return false;
}

export function validateProxySettingsInput(input: unknown): { ok: true; value: UserProxySettingsInput } | { ok: false; error: string } {
  if (!input || typeof input !== "object") return { ok: false, error: "Body must be an object." };
  const raw = input as Record<string, unknown>;

  const enabled = raw.enabled !== false; // default on when settings are saved
  const protocolRaw = typeof raw.protocol === "string" ? raw.protocol.trim().toLowerCase().replace(/:$/, "") : "http";
  if (protocolRaw !== "http" && protocolRaw !== "https") {
    return { ok: false, error: "protocol must be http or https." };
  }
  const host = typeof raw.host === "string" ? raw.host.trim() : "";
  if (!host) return { ok: false, error: "host is required." };
  if (host.includes("://") || host.includes("/") || host.includes("@")) {
    return { ok: false, error: "host must be a bare host or IP — no scheme, path, or credentials." };
  }
  if (isBlockedProxyHost(host)) {
    return { ok: false, error: "host must not be localhost, loopback, or a link-local/metadata address." };
  }

  let port: number | null = null;
  if (raw.port !== undefined && raw.port !== null && raw.port !== "") {
    const n = typeof raw.port === "number" ? raw.port : Number(raw.port);
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
      return { ok: false, error: "port must be an integer between 1 and 65535." };
    }
    port = n;
  }

  const username = typeof raw.username === "string" && raw.username.trim() ? raw.username.trim() : null;
  const password = typeof raw.password === "string" && raw.password ? raw.password : null;
  if (username && raw.password === undefined) {
    // Caller set a username but said nothing about the password: ambiguous whether
    // this means "keep stored password" (PATCH) or "no password" (fresh row). The
    // route resolves this against the stored row; validation just passes it through.
  }
  if (!username && password) {
    return { ok: false, error: "password requires a username." };
  }

  const failureRaw = typeof raw.failureMode === "string" ? raw.failureMode.trim().toLowerCase() : "fail_soft";
  if (failureRaw !== "fail_soft" && failureRaw !== "fail_closed") {
    return { ok: false, error: 'failureMode must be "fail_soft" or "fail_closed".' };
  }

  return {
    ok: true,
    value: {
      enabled,
      protocol: protocolRaw,
      host,
      port,
      username,
      password,
      failureMode: failureRaw
    }
  };
}

// ── Storage ─────────────────────────────────────────────────────────────────

function rowToView(row: UserProxySettingsRow): UserProxySettingsView {
  return {
    enabled: row.enabled === 1,
    protocol: row.protocol === "https" ? "https" : "http",
    host: row.host,
    port: row.port,
    username: row.username,
    hasPassword: !!row.password,
    failureMode: row.failure_mode === "fail_closed" ? "fail_closed" : "fail_soft",
    updatedAt: row.updated_at
  };
}

/** Masked view for API responses — never includes the password. */
export function getUserProxySettingsView(userId: string): UserProxySettingsView | undefined {
  const row = getDb()
    .prepare("SELECT * FROM user_proxy_settings WHERE user_id = ?")
    .get(userId) as UserProxySettingsRow | undefined;
  return row ? rowToView(row) : undefined;
}

export function upsertUserProxySettings(userId: string, input: UserProxySettingsInput): UserProxySettingsView {
  const now = new Date().toISOString();
  const existing = getDb()
    .prepare("SELECT * FROM user_proxy_settings WHERE user_id = ?")
    .get(userId) as UserProxySettingsRow | undefined;

  // Password PATCH semantics: undefined input password keeps the stored one.
  let passwordEnc: string | null;
  if (input.password === undefined || input.password === null) {
    passwordEnc = input.username ? (existing?.password ?? null) : null;
  } else {
    passwordEnc = encryptValue(input.password);
  }

  getDb()
    .prepare(
      `INSERT INTO user_proxy_settings
         (user_id, enabled, protocol, host, port, username, password, failure_mode, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         enabled = excluded.enabled,
         protocol = excluded.protocol,
         host = excluded.host,
         port = excluded.port,
         username = excluded.username,
         password = excluded.password,
         failure_mode = excluded.failure_mode,
         updated_at = excluded.updated_at`
    )
    .run(
      userId,
      input.enabled ? 1 : 0,
      input.protocol,
      input.host,
      input.port,
      input.username,
      passwordEnc,
      input.failureMode,
      existing?.created_at ?? now,
      now
    );
  invalidateUserProxyCache(userId);
  const view = getUserProxySettingsView(userId);
  if (!view) throw new Error("user_proxy_settings upsert did not round-trip");
  return view;
}

export function deleteUserProxySettings(userId: string): void {
  getDb().prepare("DELETE FROM user_proxy_settings WHERE user_id = ?").run(userId);
  invalidateUserProxyCache(userId);
}

// ── Resolution (fetch-layer entry point) ────────────────────────────────────

// Short-TTL cache: the provider cascade can issue dozens of fetchWithRetry calls
// per scan; a synchronous SQLite read per call is cheap but not free.
const resolvedCache = new Map<string, { value: ResolvedUserProxy | undefined; expiresAt: number }>();
const RESOLVED_TTL_MS = 30_000;

export function invalidateUserProxyCache(userId?: string): void {
  if (userId === undefined) resolvedCache.clear();
  else resolvedCache.delete(userId);
}

/**
 * The user's own proxy, when configured AND enabled. Returns undefined when the
 * user has no row or has disabled it — the caller then falls through to the
 * operator/env proxy. Never throws on a corrupt row: a bad password blob reads
 * as "no user proxy" plus a warning, not a broken quote cascade.
 */
export function resolveUserProxy(userId: string | undefined): ResolvedUserProxy | undefined {
  if (!userId) return undefined;
  const now = Date.now();
  const cached = resolvedCache.get(userId);
  if (cached && cached.expiresAt > now) return cached.value;

  let value: ResolvedUserProxy | undefined;
  const row = getDb()
    .prepare("SELECT * FROM user_proxy_settings WHERE user_id = ?")
    .get(userId) as UserProxySettingsRow | undefined;
  if (row && row.enabled === 1) {
    let password: string | undefined;
    if (row.password) {
      try {
        password = decryptValue(row.password);
      } catch (err) {
        console.warn(
          `[user-proxy-settings] stored proxy password for user could not be decrypted; ignoring user proxy row:`,
          err instanceof Error ? err.message : err
        );
        resolvedCache.set(userId, { value: undefined, expiresAt: now + RESOLVED_TTL_MS });
        return undefined;
      }
    }
    const proxyUrl = formatProxyUrl({
      host: row.host,
      port: row.port ?? undefined,
      username: row.username ?? undefined,
      password,
      protocol: row.protocol
    });
    if (proxyUrl) {
      value = {
        proxyUrl,
        failureMode: row.failure_mode === "fail_closed" ? "fail_closed" : "fail_soft"
      };
    }
  }
  resolvedCache.set(userId, { value, expiresAt: now + RESOLVED_TTL_MS });
  return value;
}
