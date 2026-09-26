/**
 * src/lib/proxy-fetch.ts
 *
 * Residential-proxy egress for market-data/provider traffic. This is a
 * Node/undici port of Congress.Trade's app/src/shared/proxyFetch.ts (Deno),
 * mirroring its env contract so both apps are operated the same way:
 *
 *   RESIDENTIAL_PROXY_URL        full proxy URL, e.g. http://10.99.0.2:8888.
 *                                The sentinels "off" / "none" / "direct" disable
 *                                proxying entirely, including the default fallback.
 *   RESIDENTIAL_PROXY_HOST / _PORT / _USERNAME / _PASSWORD / _PROTOCOL
 *                                same thing as parts (CT formatProxyUrl parity).
 *   HTTPS_PROXY / HTTP_PROXY     honored as a last env fallback, same as CT.
 *   RESIDENTIAL_PROXY_FAILURE_MODE
 *                                "fail_soft" (default) | "fail_closed" — see
 *                                data-source-fetch.ts for exact semantics.
 *
 * As in CT, when nothing is configured the effective default is the GL.iNet
 * Mango HTTP CONNECT proxy on the WireGuard mesh (http://10.99.0.2:8888), so a
 * missed env var cannot silently run provider traffic from the datacenter IP
 * that upstream anti-bot filters are blocking. Diagnostics pass
 * { allowDefault: false } to tell "operator configured" apart from "defaulted"
 * (with the default in place, a naive "configured" check is unconditionally
 * true and a missed env var becomes undetectable — the trap CT documented).
 *
 * Unlike CT (Deno.createHttpClient), proxied requests here go through undici's
 * ProxyAgent. Proxied calls use undici's own fetch rather than the global
 * (Next-patched) fetch: Next's patched fetch is not guaranteed to forward a
 * per-request `dispatcher`, and these call sites are all server-side,
 * cache:"no-store" provider traffic.
 */

import "server-only";
import { ProxyAgent, fetch as undiciFetch } from "undici";

/** Canonical residential proxy URL — same Mango/WireGuard default CT uses.
 *  Reachable only from the Coolify host's WireGuard interface. */
export const DEFAULT_RESIDENTIAL_PROXY_URL = "http://10.99.0.2:8888";

/** Sentinel values that explicitly disable proxying (env-level kill switch). */
const PROXY_OFF_SENTINELS = new Set(["off", "none", "direct"]);

export type ProxyFailureMode = "fail_soft" | "fail_closed";

export function isProxyOffSentinel(value: string | undefined): boolean {
  return value !== undefined && PROXY_OFF_SENTINELS.has(value.trim().toLowerCase());
}

/**
 * Formats host, port, username, and password into a standard HTTP proxy URL.
 * (Same shape as CT's formatProxyUrl.)
 */
export function formatProxyUrl(opts: {
  host?: string;
  port?: string | number;
  username?: string;
  password?: string;
  protocol?: string;
}): string | undefined {
  if (!opts.host) return undefined;
  const portStr = opts.port ? `:${opts.port}` : "";
  const proto = opts.protocol ? opts.protocol.replace(/:$/, "") : "http";
  const auth =
    opts.username && opts.password
      ? `${encodeURIComponent(opts.username)}:${encodeURIComponent(opts.password)}@`
      : "";
  return `${proto}://${auth}${opts.host.trim()}${portStr}`;
}

export interface ResidentialProxyEnv {
  RESIDENTIAL_PROXY_URL?: string;
  RESIDENTIAL_PROXY_FAILURE_MODE?: string;
  RESIDENTIAL_PROXY_HOST?: string;
  RESIDENTIAL_PROXY_PORT?: string | number;
  RESIDENTIAL_PROXY_USERNAME?: string;
  RESIDENTIAL_PROXY_PASSWORD?: string;
  RESIDENTIAL_PROXY_PROTOCOL?: string;
  HTTP_PROXY?: string;
  HTTPS_PROXY?: string;
}

function readEnv(env?: ResidentialProxyEnv): ResidentialProxyEnv {
  return env ?? process.env;
}

/**
 * Resolve the effective residential proxy URL.
 *
 * Precedence (mirrors CT's resolveResidentialProxyUrl):
 *   1. RESIDENTIAL_PROXY_URL (full URL, or an off-sentinel)
 *   2. RESIDENTIAL_PROXY_HOST (+ _PORT/_USERNAME/_PASSWORD/_PROTOCOL)
 *   3. HTTPS_PROXY / HTTP_PROXY
 *   4. DEFAULT_RESIDENTIAL_PROXY_URL, unless opts.allowDefault === false
 *
 * Returns undefined when proxying is disabled via an off-sentinel, or when
 * nothing is configured and allowDefault === false (the diagnostics shape).
 */
export function resolveResidentialProxyUrl(
  env?: ResidentialProxyEnv,
  opts?: { allowDefault?: boolean }
): string | undefined {
  const source = readEnv(env);

  const direct = source.RESIDENTIAL_PROXY_URL?.trim();
  if (direct) {
    if (isProxyOffSentinel(direct)) return undefined;
    return direct;
  }

  const host = source.RESIDENTIAL_PROXY_HOST?.trim();
  if (host) {
    return formatProxyUrl({
      host,
      port: source.RESIDENTIAL_PROXY_PORT,
      username: source.RESIDENTIAL_PROXY_USERNAME?.trim() || undefined,
      password: source.RESIDENTIAL_PROXY_PASSWORD || undefined,
      protocol: source.RESIDENTIAL_PROXY_PROTOCOL?.trim() || undefined
    });
  }

  const legacy = source.HTTPS_PROXY?.trim() || source.HTTP_PROXY?.trim();
  if (legacy) {
    if (isProxyOffSentinel(legacy)) return undefined;
    return legacy;
  }

  if (opts?.allowDefault === false) return undefined;
  return DEFAULT_RESIDENTIAL_PROXY_URL;
}

/** Resolve the proxy failure mode from env; default fail_soft (CT parity). */
export function resolveProxyFailureMode(env?: ResidentialProxyEnv): ProxyFailureMode {
  const raw = (env ?? process.env).RESIDENTIAL_PROXY_FAILURE_MODE?.trim().toLowerCase();
  return raw === "fail_closed" ? "fail_closed" : "fail_soft";
}

const agentCache = new Map<string, ProxyAgent>();

/** Cached undici ProxyAgent per proxy URL (mirrors CT's cached Deno clients). */
export function getProxyAgent(proxyUrl: string): ProxyAgent {
  const cleanUrl = proxyUrl.trim();
  let agent = agentCache.get(cleanUrl);
  if (!agent) {
    agent = new ProxyAgent({ uri: cleanUrl });
    agentCache.set(cleanUrl, agent);
  }
  return agent;
}

/**
 * Wrap a fetch function so requests egress through the given HTTP(S) proxy.
 * Returns baseFetch unchanged when no proxy URL is given (CT parity).
 */
export function createProxiedFetch(
  proxyUrl: string | undefined,
  baseFetch: typeof fetch = undiciFetch as unknown as typeof fetch
): typeof fetch {
  if (!proxyUrl || !proxyUrl.trim()) return baseFetch;
  const agent = getProxyAgent(proxyUrl);
  return (async function proxiedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const withDispatcher = { ...(init ?? {}), dispatcher: agent } as RequestInit;
    return baseFetch(input, withDispatcher);
  }) as typeof fetch;
}

/**
 * Error codes that mean the PROXY LEG of a proxied request failed (the proxy
 * itself was unreachable or reset us). When tinyproxy is up but the upstream
 * is down/blocked, tinyproxy answers with an HTTP 502/503 response — that is a
 * response, not a throw, and is deliberately NOT treated as proxy-down (no
 * direct fallback would change the upstream's answer anyway, and falling back
 * would re-expose the datacenter IP for no benefit).
 */
export const PROXY_LEG_ERROR_CODES: ReadonlySet<string> = new Set([
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "ECONNRESET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET"
]);

function errorCodeChain(err: unknown, depth = 0): string[] {
  if (depth > 4 || !(err instanceof Error)) return [];
  const codes: string[] = [];
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string") codes.push(code);
  const cause = (err as { cause?: unknown }).cause;
  if (cause) codes.push(...errorCodeChain(cause, depth + 1));
  return codes;
}

/** True when the thrown error indicates the proxy leg itself failed. */
export function isProxyLegError(err: unknown): boolean {
  return errorCodeChain(err).some((code) => PROXY_LEG_ERROR_CODES.has(code));
}

// Rate-limited warn logging so a dead proxy does not spam one line per request.
const lastProxyWarnAt = new Map<string, number>();
const PROXY_WARN_INTERVAL_MS = 60_000;

export function warnProxyFallback(proxyUrl: string, err: unknown, now: number = Date.now()): void {
  const last = lastProxyWarnAt.get(proxyUrl) ?? 0;
  if (now - last < PROXY_WARN_INTERVAL_MS) return;
  lastProxyWarnAt.set(proxyUrl, now);
  const host = safeProxyHostForLog(proxyUrl);
  const message = err instanceof Error ? err.message : String(err);
  console.warn(
    `[data-source-proxy] residential proxy ${host} unreachable (${message}); ` +
      `fail_soft: falling back to direct egress for this request. ` +
      `Set RESIDENTIAL_PROXY_FAILURE_MODE=fail_closed to make this an error instead.`
  );
}

/** Host[:port] only — never log credentials embedded in a proxy URL. */
export function safeProxyHostForLog(proxyUrl: string): string {
  try {
    const u = new URL(proxyUrl);
    return u.host;
  } catch {
    return "(unparseable proxy URL)";
  }
}

/** Test hook: drop cached agents + warn timestamps. */
export function __resetProxyFetchForTests(): void {
  agentCache.clear();
  lastProxyWarnAt.clear();
}
