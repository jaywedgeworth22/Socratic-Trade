// apns.ts — Apple Push Notification service provider client (server-side only).
//
// WHY node:http2 AND NOT fetch: APNs speaks HTTP/2 exclusively. Node's global fetch (undici) does
// not negotiate HTTP/2 to APNs, so a fetch-based provider client cannot work at all. Everything
// here goes through the built-in `node:http2` module.
//
// ENVIRONMENT (the classic silent-failure bug): the SAME auth key works for both APNs
// environments; only the ENDPOINT differs.
//   sandbox    -> https://api.sandbox.push.apple.com   (Xcode / debug builds)
//   production -> https://api.push.apple.com           (TestFlight AND App Store)
// TestFlight is PRODUCTION. Device tokens are environment-specific — a sandbox token is answered
// `400 BadDeviceToken` by the production endpoint and vice versa — so the endpoint is chosen from
// the environment stored on the token row (db-device-tokens.ts), never guessed from NODE_ENV.
//
// AUTH: a provider JWT, ES256-signed with the .p8 key, header { alg: "ES256", kid: APNS_KEY_ID },
// claims { iss: APNS_TEAM_ID, iat }. Apple REQUIRES the same token be reused for at least 20
// minutes and refreshed before 60; minting one per send earns `429 TooManyProviderTokenUpdates`.
// The token is therefore cached per (team, key) and refreshed at 50 minutes.
//
// SECRETS: read by name from the process env, which is how every other provider credential in this
// app arrives (the Infisical runner injects them — see secrets-source.ts). Never logged.
//   key id, team id, bundle id (the APNs topic),
//   plus the .p8 material via the APNS p8 env var, or the private-key / private-key-b64 env vars.
//
// FAIL SOFT: nothing in this module may take down a caller. The notify channel that uses it
// (src/lib/notify.ts) treats a throw as an ordinary channel failure, and an unconfigured
// credential set makes the channel report "not configured" rather than erroring.

// Bare specifiers (not "node:crypto"/"node:http2") on purpose: this module is reachable from the
// src/lib/db.ts barrel, which Next also compiles into the client/edge bundles. A `node:`-scheme
// request is handled by webpack's scheme plugin BEFORE resolve.alias runs, so the config's
// `"node:crypto": false` alias cannot neutralize it there and the build fails with
// `UnhandledSchemeError`. Bare specifiers go through resolve.fallback, where next.config.mjs maps
// crypto/http2 to `false` for non-server bundles (and to the real builtins on the server).
import crypto from "crypto";
import http2 from "http2";

export const APNS_ENDPOINTS = {
  sandbox: "https://api.sandbox.push.apple.com",
  production: "https://api.push.apple.com"
} as const;

/** Apple: reuse a provider token for >= 20 minutes, refresh before 60. 50 sits safely inside. */
export const APNS_TOKEN_REFRESH_MS = 50 * 60_000;

/** APNs caps `apns-collapse-id` at 64 bytes. */
export const APNS_COLLAPSE_ID_MAX = 64;

/** Just the env shape loadApnsConfig reads — narrower than NodeJS.ProcessEnv so a test can pass a
 *  small literal without having to fake NODE_ENV. */
export type ApnsEnvSource = Record<string, string | undefined>;

export interface ApnsConfig {
  keyId: string;
  teamId: string;
  /** Primary APNs topic — usually APNS_BUNDLE_ID (trade.socratic.ios after the rename). */
  bundleId: string;
  /** PEM text of the .p8 signing key, decoded from APNS_PRIVATE_KEY_B64. */
  privateKeyPem: string;
}

/** Current iOS app bundle / APNs topic after the 2026-09-22 rename. */
export const CURRENT_APNS_BUNDLE_ID = "trade.socratic.ios";

/** Legacy iOS app bundle / APNs topic — keep accepting+sending until old TF is retired. */
export const LEGACY_APNS_BUNDLE_ID = "trade.socratic.app";

/**
 * Bundle IDs the server will register and send against during the coexistence window.
 * Always includes both native topics; also honors APNS_BUNDLE_ID + comma-separated
 * APNS_BUNDLE_IDS so ops can extend without a code change.
 */
export function resolveAcceptedApnsBundleIds(env: ApnsEnvSource = process.env): string[] {
  const ids: string[] = [CURRENT_APNS_BUNDLE_ID, LEGACY_APNS_BUNDLE_ID];
  const primary = (env.APNS_BUNDLE_ID ?? "").trim();
  if (primary && !ids.includes(primary)) ids.push(primary);
  for (const part of (env.APNS_BUNDLE_IDS ?? "").split(",")) {
    const id = part.trim();
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

export function isAcceptedApnsBundleId(
  bundleId: string,
  env: ApnsEnvSource = process.env
): boolean {
  return resolveAcceptedApnsBundleIds(env).includes(bundleId.trim());
}

function looksLikePem(value: string): boolean {
  return value.includes("BEGIN") && value.includes("PRIVATE KEY");
}

/** Accept raw PEM, escaped-newline PEM, or standard base64 of the .p8. */
export function decodeApnsPrivateKeyPem(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const unescaped = trimmed.includes("\\n") ? trimmed.replace(/\\n/g, "\n") : trimmed;
  if (looksLikePem(unescaped)) return unescaped;
  try {
    const decoded = Buffer.from(trimmed, "base64").toString("utf8");
    if (looksLikePem(decoded)) return decoded;
  } catch {
    return null;
  }
  return null;
}

/** Read the APNs credential set from the environment. Returns null when ANY part is missing —
 *  the caller degrades to "push unavailable" rather than half-configuring a send. The private key
 *  is decoded here but NOT parsed: a malformed key surfaces as a send-time channel error,
 *  not a boot/config crash.
 *
 *  Reads the key id, team id, bundle id, and the .p8 material via the APNS p8
 *  env var, or the private-key / private-key-b64 env vars. */
export function loadApnsConfig(env: ApnsEnvSource = process.env): ApnsConfig | null {
  const keyId = (env.APNS_KEY_ID ?? "").trim();
  const teamId = (env.APNS_TEAM_ID ?? "").trim();
  const bundleId = (env.APNS_BUNDLE_ID ?? "").trim();
  const rawKey = (env.APNS_P8 ?? env.APNS_PRIVATE_KEY ?? env.APNS_PRIVATE_KEY_B64 ?? "").trim();
  if (!keyId || !teamId || !bundleId || !rawKey) return null;
  const privateKeyPem = decodeApnsPrivateKeyPem(rawKey);
  if (!privateKeyPem) return null;
  return { keyId, teamId, bundleId, privateKeyPem };
}

/** True when a complete APNs credential set is present. */
export function apnsConfigured(config: ApnsConfig | null | undefined): config is ApnsConfig {
  return !!config && !!config.keyId && !!config.teamId && !!config.bundleId && !!config.privateKeyPem;
}

// ── Provider JWT (ES256), cached per (team, key) ──────────────────────────────

type CachedProviderToken = { jwt: string; issuedAtMs: number };
const providerTokenCache = new Map<string, CachedProviderToken>();

function base64Url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function providerTokenCacheKey(config: ApnsConfig): string {
  return `${config.teamId}:${config.keyId}`;
}

/**
 * The current provider JWT for `config`, minting a new one only when the cached one is missing or
 * older than APNS_TOKEN_REFRESH_MS. `nowMs` is injectable so the reuse window is directly testable.
 *
 * Signed with `dsaEncoding: "ieee-p1363"` — JOSE ES256 requires the raw r||s concatenation, NOT
 * Node's default DER/ASN.1 envelope (Apple rejects a DER signature as InvalidProviderToken).
 */
export function getApnsProviderToken(config: ApnsConfig, nowMs: number = Date.now()): string {
  const cacheKey = providerTokenCacheKey(config);
  const cached = providerTokenCache.get(cacheKey);
  if (cached && nowMs - cached.issuedAtMs < APNS_TOKEN_REFRESH_MS) return cached.jwt;

  const iat = Math.floor(nowMs / 1000);
  const header = base64Url(JSON.stringify({ alg: "ES256", kid: config.keyId }));
  const claims = base64Url(JSON.stringify({ iss: config.teamId, iat }));
  const signingInput = `${header}.${claims}`;
  const key = crypto.createPrivateKey({ key: config.privateKeyPem, format: "pem" });
  const signature = crypto.sign("sha256", Buffer.from(signingInput), { key, dsaEncoding: "ieee-p1363" });
  const jwt = `${signingInput}.${base64Url(signature)}`;
  providerTokenCache.set(cacheKey, { jwt, issuedAtMs: nowMs });
  return jwt;
}

/** Drop the cached JWT — called when APNs answers 403 ExpiredProviderToken so the next send mints
 *  a fresh one instead of replaying the rejected token. Also the test reset hook. */
export function invalidateApnsProviderToken(config?: ApnsConfig): void {
  if (config) providerTokenCache.delete(providerTokenCacheKey(config));
  else providerTokenCache.clear();
}

// ── Transport ─────────────────────────────────────────────────────────────────

export interface ApnsHttpRequest {
  /** Origin, e.g. https://api.push.apple.com */
  origin: string;
  /** Path, e.g. /3/device/<token> */
  path: string;
  headers: Record<string, string>;
  body: string;
}

export interface ApnsHttpResponse {
  status: number;
  body: string;
}

/** Injectable so tests never open a socket to Apple. */
export type ApnsTransport = (request: ApnsHttpRequest, timeoutMs: number) => Promise<ApnsHttpResponse>;

/** Real HTTP/2 transport. One short-lived session per request: APNs delivery volume here is a
 *  handful of alerts per user per day, so connection reuse would buy nothing while a cached
 *  half-open session is a real source of stuck sends. */
export const httpTwoApnsTransport: ApnsTransport = (request, timeoutMs) =>
  new Promise<ApnsHttpResponse>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };
    const session = http2.connect(request.origin);
    const cleanup = () => {
      try {
        session.close();
      } catch {
        /* already closing */
      }
    };
    session.on("error", (error) => finish(() => { cleanup(); reject(error); }));

    const stream = session.request({
      ":method": "POST",
      ":path": request.path,
      ...request.headers
    });
    stream.setEncoding("utf8");
    stream.setTimeout(timeoutMs, () => {
      finish(() => {
        try {
          stream.close(http2.constants.NGHTTP2_CANCEL);
        } catch {
          /* already closed */
        }
        cleanup();
        reject(new Error(`APNs request timed out after ${timeoutMs}ms`));
      });
    });

    let status = 0;
    let body = "";
    stream.on("response", (headers) => {
      status = Number(headers[":status"] ?? 0);
    });
    stream.on("data", (chunk: string) => {
      body += chunk;
    });
    stream.on("error", (error) => finish(() => { cleanup(); reject(error); }));
    stream.on("end", () => finish(() => { cleanup(); resolve({ status, body }); }));
    stream.end(request.body);
  });

// ── Send ──────────────────────────────────────────────────────────────────────

/** What the caller should DO about a send outcome. */
export type ApnsDisposition =
  /** Accepted by APNs. */
  | "delivered"
  /** 410 Unregistered / 400 BadDeviceToken — the token is dead; delete or disable it. */
  | "token_dead"
  /** 403 (and 401) — the provider token/topic/key is wrong. A config problem; surface it loudly. */
  | "auth_error"
  /** 429 / 5xx / network error — worth retrying. */
  | "retryable"
  /** Any other 4xx — a permanent problem with THIS request (bad payload, bad topic). */
  | "permanent";

export interface ApnsSendResult {
  ok: boolean;
  disposition: ApnsDisposition;
  status?: number;
  /** APNs `reason` string from the JSON error body (e.g. "BadDeviceToken"), when present. */
  reason?: string;
  error?: string;
}

export interface ApnsAlert {
  title: string;
  body: string;
  /** Universal-link URL the iOS app routes on tap (https://socratictrade.com/...). */
  url?: string;
  /** APNs collapse id — a later notification with the same id REPLACES the earlier one on the
   *  lock screen instead of stacking. Truncated to Apple's 64-byte cap. */
  collapseId?: string;
  /** Extra routing data delivered alongside the alert. Must stay small (APNs payload cap 4KB). */
  data?: Record<string, unknown>;
}

export interface ApnsSendInput extends ApnsAlert {
  deviceToken: string;
  environment: keyof typeof APNS_ENDPOINTS;
  /**
   * Per-device APNs topic (bundle id). During the bundle-rename coexistence window
   * each registered device keeps its own topic; fall back to config.bundleId.
   */
  topic?: string;
}

export interface ApnsSendDeps {
  config: ApnsConfig;
  transport?: ApnsTransport;
  timeoutMs?: number;
  nowMs?: number;
}

function classify(status: number, reason: string | undefined): ApnsDisposition {
  if (status === 200) return "delivered";
  if (status === 410) return "token_dead";
  if (status === 400 && reason === "BadDeviceToken") return "token_dead";
  if (status === 403 || status === 401) return "auth_error";
  if (status === 429 || status >= 500) return "retryable";
  return "permanent";
}

function parseReason(body: string): string | undefined {
  if (!body) return undefined;
  try {
    const parsed = JSON.parse(body) as { reason?: unknown };
    return typeof parsed.reason === "string" ? parsed.reason : undefined;
  } catch {
    return undefined;
  }
}

/** Build the APNs alert payload. Kept separate from the send so its shape is directly testable. */
export function buildApnsPayload(alert: ApnsAlert): Record<string, unknown> {
  return {
    aps: {
      alert: { title: alert.title, body: alert.body },
      sound: "default",
      "interruption-level": "active"
    },
    ...(alert.url ? { url: alert.url } : {}),
    ...(alert.data ?? {})
  };
}

/**
 * Deliver one alert to one device token. Never throws for an APNs-level failure — the outcome
 * (including transport errors) comes back as an ApnsSendResult so the caller can fail soft.
 */
export async function sendApnsPush(input: ApnsSendInput, deps: ApnsSendDeps): Promise<ApnsSendResult> {
  const transport = deps.transport ?? httpTwoApnsTransport;
  const timeoutMs = deps.timeoutMs ?? 5000;
  const origin = APNS_ENDPOINTS[input.environment];

  let jwt: string;
  try {
    jwt = getApnsProviderToken(deps.config, deps.nowMs ?? Date.now());
  } catch (error) {
    // A malformed/unusable .p8 lands here. Config problem, not a dead token.
    return {
      ok: false,
      disposition: "auth_error",
      error: `APNs provider token could not be signed: ${error instanceof Error ? error.message : String(error)}`
    };
  }

  const headers: Record<string, string> = {
    authorization: `bearer ${jwt}`,
    "apns-topic": (input.topic?.trim() || deps.config.bundleId),
    "apns-push-type": "alert",
    "apns-priority": "10",
    "content-type": "application/json"
  };
  if (input.collapseId) {
    headers["apns-collapse-id"] = input.collapseId.slice(0, APNS_COLLAPSE_ID_MAX);
  }

  let response: ApnsHttpResponse;
  try {
    response = await transport(
      {
        origin,
        path: `/3/device/${input.deviceToken}`,
        headers,
        body: JSON.stringify(buildApnsPayload(input))
      },
      timeoutMs
    );
  } catch (error) {
    return {
      ok: false,
      disposition: "retryable",
      error: error instanceof Error ? error.message : String(error)
    };
  }

  const reason = parseReason(response.body);
  const disposition = classify(response.status, reason);
  if (disposition === "auth_error" && reason === "ExpiredProviderToken") {
    // Replaying the rejected JWT would fail identically — force a fresh mint next send.
    invalidateApnsProviderToken(deps.config);
  }
  return {
    ok: disposition === "delivered",
    disposition,
    status: response.status,
    ...(reason ? { reason } : {}),
    ...(disposition === "delivered" ? {} : { error: `APNs HTTP ${response.status}${reason ? `: ${reason}` : ""}` })
  };
}
