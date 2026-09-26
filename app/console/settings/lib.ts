/** Typed fetch helpers for the Settings sub-sections (brokers, API keys,
 *  models, delivery channels). Self-contained on purpose — the shared console
 *  client (app/console/lib/api.ts) stays untouched; only its ConsoleApiError
 *  is reused so every settings error surfaces through the same toast pattern.
 *  Every function talks to REAL existing endpoints — nothing here simulates. */

import { ConsoleApiError, redirectToLogin } from "../lib/api";
import { beginConsoleMutation, endConsoleMutation, isConsoleMutationMethod } from "../lib/mutation-busy";

async function parseBody(res: Response): Promise<unknown> {
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return res.json().catch(() => undefined);
  }
  return res.text().catch(() => undefined);
}

function messageFrom(payload: unknown, fallback: string): string {
  if (typeof payload === "string" && payload.trim()) return payload.trim();
  if (payload && typeof payload === "object") {
    const p = payload as Record<string, unknown>;
    if (typeof p.message === "string" && p.message) return p.message;
    if (typeof p.error === "string" && p.error) return p.error;
  }
  return fallback;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const track = isConsoleMutationMethod(init?.method);
  if (track) beginConsoleMutation();
  let res: Response;
  try {
    res = await fetch(url, {
      cache: "no-store",
      ...init,
      headers: { "content-type": "application/json", ...(init?.headers ?? {}) }
    });
  } catch {
    throw new ConsoleApiError("Network error — the server could not be reached.", 0);
  } finally {
    if (track) endConsoleMutation();
  }
  const payload = await parseBody(res);
  if (!res.ok) {
    // Same fail-closed destination as lib/api.ts's own `request<T>` — this file is a separate
    // client (see header) but a dead session is a dead session regardless of which wrapper
    // noticed it first.
    if (res.status === 401) redirectToLogin();
    throw new ConsoleApiError(messageFrom(payload, `Request failed (${res.status}).`), res.status, payload);
  }
  return payload as T;
}

// ── Source / data-plane feature settings ────────────────────────────────────

export interface SourceFeatureRow {
  id: string;
  group: string;
  label: string;
  description: string;
  type: "boolean" | "number" | "string";
  defaultValue: boolean | number | string;
  min?: number;
  max?: number;
  advanced?: boolean;
  caveat?: string;
  value: boolean | number | string;
  source: "user" | "server" | "env" | "default";
}

export interface SourceFeaturesResponse {
  ok: boolean;
  groups: Record<string, { title: string; blurb: string }>;
  settings: SourceFeatureRow[];
}

export function fetchSourceFeatures(): Promise<SourceFeaturesResponse> {
  return request<SourceFeaturesResponse>("/api/settings/source-features");
}

export function patchSourceFeatures(
  settings: Record<string, boolean | number | string | null>
): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>("/api/settings/source-features", {
    method: "PATCH",
    body: JSON.stringify({ settings })
  });
}

export type LlmBudgetLimitSource = "user" | "policy" | "env" | "none";

export interface LlmBudgetResponse {
  ok: boolean;
  tokenBudget: number | null;
  costBudgetUsd: number | null;
  effective: {
    tokenLimit: number | null;
    costLimitUsd: number | null;
    tokenSource: LlmBudgetLimitSource;
    costSource: LlmBudgetLimitSource;
  };
  today: { tokens: number; costUsd: number };
  enforced: boolean;
}

export function fetchLlmBudget(): Promise<LlmBudgetResponse> {
  return request<LlmBudgetResponse>("/api/settings/llm-budget");
}

export function patchLlmBudget(body: {
  tokenBudget?: number | null;
  costBudgetUsd?: number | null;
}): Promise<LlmBudgetResponse> {
  return request<LlmBudgetResponse>("/api/settings/llm-budget", {
    method: "PATCH",
    body: JSON.stringify(body)
  });
}

// ── Broker connections ───────────────────────────────────────────────────────

/** Where the browser must go to start Robinhood OAuth (full-page redirect —
 *  the flow returns to the legacy dashboard, which finishes the account sync). */
export const ROBINHOOD_OAUTH_START_URL = "/api/auth/robinhood/start";

export interface RobinhoodMcpHealth {
  ok: boolean;
  configured: boolean;
  authenticated: boolean;
  tools: string[];
  checkedAt: string;
  error?: string;
}

/** GET /api/broker/mcp/health — is the Robinhood MCP OAuth session usable? */
export function fetchRobinhoodHealth(): Promise<RobinhoodMcpHealth> {
  return request<RobinhoodMcpHealth>("/api/broker/mcp/health");
}

/** POST /api/connected-accounts {broker:"robinhood"} — after OAuth, pull the
 *  real agentic account from the live MCP into connected accounts. Idempotent
 *  server-side (re-sync reuses the existing row). */
export function syncRobinhoodAccount(): Promise<{ ok: boolean; accountNumber?: string; label?: string }> {
  return request<{ ok: boolean; accountNumber?: string; label?: string }>("/api/connected-accounts", {
    method: "POST",
    body: JSON.stringify({ broker: "robinhood" })
  });
}

export interface AlpacaConnectBody {
  label?: string;
  accountNumber: string;
  apiKey: string;
  apiSecret?: string;
  taxationType?: "taxable" | "roth_ira" | "traditional_ira";
}

/** POST /api/connected-accounts {broker:"alpaca", ...}. The server infers
 *  paper vs live from the credentials ("PA…" account / "PK…" key = paper) and
 *  fills the default endpoint — no base URL needed here. */
export function connectAlpacaAccount(body: AlpacaConnectBody): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>("/api/connected-accounts", {
    method: "POST",
    body: JSON.stringify({ broker: "alpaca", ...body })
  });
}

export interface TradierConnectBody {
  label?: string;
  apiKey: string;
  environment: "paper" | "live";
  accountNumber?: string;
  taxationType?: "taxable" | "roth_ira" | "traditional_ira";
}

/** POST /api/connected-accounts {broker:"tradier", ...}. Single access token (no secret). The
 *  environment is an explicit selector (Sandbox=paper / Production=live) — Tradier tokens carry no
 *  PK/PA-style prefix — and the server derives the sandbox/production endpoint from it. */
export function connectTradierAccount(body: TradierConnectBody): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>("/api/connected-accounts", {
    method: "POST",
    body: JSON.stringify({ broker: "tradier", ...body })
  });
}

export interface KalshiConnectBody {
  label?: string;
  apiKey: string;
  apiSecret: string;
  environment: "paper" | "live";
  baseUrl?: string;
}

/** POST /api/connected-accounts {broker:"kalshi", ...}. Requires API Key ID (UUID) and RSA Private Key PEM. */
export function connectKalshiAccount(body: KalshiConnectBody): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>("/api/connected-accounts", {
    method: "POST",
    body: JSON.stringify({ broker: "kalshi", ...body })
  });
}

export type ExtraBrokerId = "etoro" | "public" | "webull";

export function connectKeyPairBroker(
  broker: ExtraBrokerId,
  body: {
    label?: string;
    apiKey?: string;
    apiSecret?: string;
    environment?: "paper" | "live";
    accountNumber?: string;
    taxationType?: "taxable" | "roth_ira" | "traditional_ira";
  }
): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>("/api/connected-accounts", {
    method: "POST",
    body: JSON.stringify({ broker, ...body })
  });
}

/** DELETE /api/connected-accounts/[id] — removes the connection (and its
 *  stored credentials) from this app. Nothing at the broker is touched. */
export function disconnectAccount(id: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/api/connected-accounts/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/** PATCH /api/connected-accounts/[id] {label} — rename an account's cosmetic display
 *  name only. The broker-sourced account number and credentials are untouched. */
export function renameAccount(id: string, label: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/api/connected-accounts/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify({ label })
  });
}

// ── API keys ─────────────────────────────────────────────────────────────────

/** One catalog entry from GET /api/keys. The key VALUE is never returned by
 *  the server — only whether one resolves and where it came from. */
export interface ApiKeyPlanTierOption {
  id: string;
  label: string;
  hint?: string;
}

export interface ApiKeyEntry {
  service: string;
  label: string;
  category: string;
  unlocks: string;
  docsUrl: string;
  envVar?: string;
  /** True when a key resolves for this user (own key or server env). */
  configured: boolean;
  /** "user" = your stored key, "env" = the server operator's env var, "none". */
  source: "user" | "env" | "none";
  /** Elided first-8/last-4 form of the key that ACTUALLY resolves ("sk-or-v1-...ab12") — never a
   *  usable value. Absent for a server key when you are not the operator, and for keys too short
   *  to elide safely. */
  preview?: string;
  /** Set only when YOU have a stored key. */
  updatedAt?: string;
  savedLabel?: string;
  /** UI text override (default is "key", e.g., "contact" for SEC) */
  credentialName?: string;
  /** Declared vendor plan tier (free/power/starter/…). Present for optional market-data keys. */
  planTier?: string;
  planTierOptions?: ApiKeyPlanTierOption[];
  /** ST product retired (e.g. FMP) — show badge, disable add when CT-only. */
  retired?: boolean;
  retiredNote?: string;
}

export function listApiKeys(): Promise<{ keys: ApiKeyEntry[] }> {
  return request<{ keys: ApiKeyEntry[] }>("/api/keys");
}

/** POST /api/keys — add or replace your key for a service. The value is sent
 *  once and stored server-side; it is never echoed back. */
export function saveApiKey(
  service: string,
  apiKey: string,
  label?: string,
  planTier?: string
): Promise<{ success: boolean }> {
  return request<{ success: boolean }>("/api/keys", {
    method: "POST",
    body: JSON.stringify({
      service,
      apiKey,
      ...(label?.trim() ? { label: label.trim() } : {}),
      ...(planTier ? { planTier } : {})
    })
  });
}

/** POST /api/keys with planTier only — update declared plan without re-pasting the secret. */
export function saveApiKeyPlanTier(service: string, planTier: string): Promise<{ success: boolean }> {
  return request<{ success: boolean }>("/api/keys", {
    method: "POST",
    body: JSON.stringify({ service, planTier })
  });
}

export function deleteApiKey(service: string): Promise<{ success: boolean; deleted: boolean }> {
  return request<{ success: boolean; deleted: boolean }>(`/api/keys?service=${encodeURIComponent(service)}`, {
    method: "DELETE"
  });
}

// ── Delivery channels (out-of-app alert delivery) ────────────────────────────

export interface DeliveryChannelDescriptor {
  id: "push" | "pushover" | "webhook" | "email" | "sms" | "apns";
  label: string;
  /** False when the server operator hasn't configured the channel's provider. */
  available: boolean;
  provider?: string | null;
  targetField: string;
  targetLabel: string;
  placeholder: string;
  hint: string;
  /** True when the delivery target is app-managed rather than user-typed (apns: the iOS app
   *  registers its own device tokens), so the UI shows an explanation instead of an input. */
  managedTarget?: boolean;
}

export interface DeliveryPrefs {
  channels: string[];
  pushTarget: string;
  pushoverTarget: string;
  webhookUrl: string;
  email: string;
  phone: string;
  /** Presence flags for per-user channel credentials (server never returns
   *  the secret values themselves). */
  pushoverAppTokenSet?: boolean;
  twilioAccountSidSet?: boolean;
  twilioAuthTokenSet?: boolean;
  twilioFromSet?: boolean;
  /** Write-only credential inputs: send a non-empty string to set/replace,
   *  "" to clear, and omit (undefined) to leave the stored value untouched. */
  pushoverAppToken?: string;
  twilioAccountSid?: string;
  twilioAuthToken?: string;
  twilioFrom?: string;
  /** Opt-in daily watchlist digest (default false) — see settings/delivery.tsx. */
  watchlistDigestEnabled?: boolean;
}

export const EMPTY_DELIVERY_PREFS: DeliveryPrefs = {
  channels: [],
  pushTarget: "",
  pushoverTarget: "",
  webhookUrl: "",
  email: "",
  phone: "",
  watchlistDigestEnabled: false
};

export function fetchDeliverySettings(): Promise<{ channels: DeliveryChannelDescriptor[]; prefs: DeliveryPrefs }> {
  return request<{ channels: DeliveryChannelDescriptor[]; prefs: DeliveryPrefs }>("/api/notifications");
}

export function saveDeliveryPrefs(prefs: DeliveryPrefs): Promise<{ prefs: DeliveryPrefs }> {
  return request<{ prefs: DeliveryPrefs }>("/api/notifications", {
    method: "POST",
    body: JSON.stringify(prefs)
  });
}


// ── Per-user data-source proxy ──────────────────────────────────────────────

export interface UserProxySettingsView {
  enabled: boolean;
  protocol: "http" | "https";
  host: string;
  port: number | null;
  username: string | null;
  hasPassword: boolean;
  failureMode: "fail_soft" | "fail_closed";
  updatedAt: string;
}

export interface ProxySettingsPayload {
  ok: boolean;
  settings: UserProxySettingsView | null;
  effective: {
    source: "user" | "env" | "default" | "none";
    failureMode: "fail_soft" | "fail_closed";
    proxyHost: string | null;
  };
  excludedServices: string[];
}

export interface ProxyTestResult {
  ok: boolean;
  status?: number;
  latencyMs?: number;
  source?: "user" | "env" | "default" | "none";
  failureMode?: "fail_soft" | "fail_closed";
  proxyHost?: string | null;
  egressIp?: string | null;
  error?: string;
}

export function fetchProxySettings(): Promise<ProxySettingsPayload> {
  return request<ProxySettingsPayload>("/api/settings/proxy");
}

export function saveProxySettings(body: {
  enabled: boolean;
  protocol: "http" | "https";
  host: string;
  port?: number | null;
  username?: string | null;
  password?: string;
  failureMode: "fail_soft" | "fail_closed";
}): Promise<ProxySettingsPayload> {
  return request<ProxySettingsPayload>("/api/settings/proxy", { method: "PUT", body: JSON.stringify(body) });
}

export function deleteProxySettings(): Promise<ProxySettingsPayload> {
  return request<ProxySettingsPayload>("/api/settings/proxy", { method: "DELETE" });
}

export async function testProxySettings(): Promise<ProxyTestResult> {
  // The test route returns 200 with ok:false on canary failure, so read the
  // payload directly rather than going through request<T>'s throw-on-!ok.
  return request<ProxyTestResult>("/api/settings/proxy/test", { method: "POST", body: "{}" });
}
