/**
 * src/lib/data-source-fetch.ts
 *
 * Single egress decision point for market-data/provider traffic: WHICH fetch
 * implementation a data-source call uses, and what happens when the proxy is
 * down. Everything else (qdrant, litestream, APNs, Sentry, OpenRouter, broker
 * order APIs, localhost, Coolify-internal hosts) never touches this module and
 * stays on direct egress — proxying is opt-in per call site, so a new internal
 * service can never accidentally start routing through the residential proxy.
 *
 * Resolution order:
 *   1. The request's user proxy (user_proxy_settings, per-user — owner request
 *      2026-09-25) when configured and enabled.
 *   2. Operator env: RESIDENTIAL_PROXY_URL / RESIDENTIAL_PROXY_HOST(+parts) /
 *      HTTPS_PROXY / HTTP_PROXY (CT parity — see proxy-fetch.ts).
 *   3. DEFAULT_RESIDENTIAL_PROXY_URL (Mango on the WireGuard mesh), unless
 *      disabled with RESIDENTIAL_PROXY_URL=off.
 *
 * Failure behavior when the proxy is down (explicit, per user setting or
 * RESIDENTIAL_PROXY_FAILURE_MODE):
 *   fail_soft   default, CT parity: proxy-leg transport error → rate-limited
 *               warning + this request retried on direct egress. Trading-safe:
 *               a dead home proxy degrades data freshness/identity, never the
 *               app's ability to serve.
 *   fail_closed proxy-leg transport error → the error propagates; the provider
 *               reads as down and the cascade moves to the next source. No
 *               request ever leaves from the datacenter IP. Pick this when
 *               re-identifying the datacenter IP to a blocking source is worse
 *               than missing data.
 *
 * Only PROXY-LEG failures trigger fallback: when the proxy answers with an
 * HTTP error (e.g. tinyproxy 502 because the UPSTREAM is unreachable), that
 * response is returned as-is — direct egress would get the same upstream
 * answer and would only re-expose the datacenter IP.
 */

import "server-only";
import {
  createProxiedFetch,
  isProxyLegError,
  resolveProxyFailureMode,
  resolveResidentialProxyUrl,
  safeProxyHostForLog,
  warnProxyFallback,
  type ProxyFailureMode,
  type ResidentialProxyEnv
} from "./proxy-fetch";
import { resolveUserProxy } from "./user-proxy-settings";

/** Services that call fetchWithRetry but are NOT third-party market data —
 *  they keep direct egress even when a proxy is configured. */
export const PROXY_EXCLUDED_SERVICES: ReadonlySet<string> = new Set([
  "usage-monitor" // pushes to usage.jays.services — our own infra, not a data source
]);

export type DataSourceProxySource = "user" | "env" | "default" | "none";

export interface DataSourceProxyResolution {
  proxyUrl?: string;
  source: DataSourceProxySource;
  failureMode: ProxyFailureMode;
}

/** Test-only dependency injection point; production callers never pass this. */
export interface DataSourceFetchDeps {
  env?: ResidentialProxyEnv;
  resolveUserProxyFn?: typeof resolveUserProxy;
  directFetch?: typeof fetch;
  proxiedFetchFactory?: (proxyUrl: string) => typeof fetch;
}

export function resolveDataSourceProxy(
  userId?: string,
  deps: DataSourceFetchDeps = {}
): DataSourceProxyResolution {
  const userProxy = (deps.resolveUserProxyFn ?? resolveUserProxy)(userId);
  if (userProxy) {
    return { proxyUrl: userProxy.proxyUrl, source: "user", failureMode: userProxy.failureMode };
  }

  const env = deps.env;
  const configured = resolveResidentialProxyUrl(env, { allowDefault: false });
  if (configured) {
    return { proxyUrl: configured, source: "env", failureMode: resolveProxyFailureMode(env) };
  }
  const withDefault = resolveResidentialProxyUrl(env);
  if (withDefault) {
    return { proxyUrl: withDefault, source: "default", failureMode: resolveProxyFailureMode(env) };
  }
  return { source: "none", failureMode: resolveProxyFailureMode(env) };
}

/** True when the request TARGET is loopback or a literal private/internal IP —
 *  such targets always bypass the proxy no matter what is configured. */
export function isInternalFetchTarget(url: string | URL): boolean {
  let host: string;
  try {
    host = new URL(typeof url === "string" ? url : url.toString()).hostname.toLowerCase();
  } catch {
    return false; // unparseable: let fetch itself fail normally
  }
  host = host.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) return true;
  if (host === "::1" || host === "::") return true;
  const parts = host.split(".");
  if (parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p))) {
    const [a, b] = parts.map(Number);
    if (a === 127 || a === 0) return true;
    if (a === 10) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;
  }
  return false;
}

/**
 * Fetch a data-source URL with per-user/operator residential-proxy egress
 * applied. Drop-in for `fetch` at data-source call sites.
 */
export async function dataSourceFetch(
  url: string | URL,
  init?: RequestInit,
  opts?: { userId?: string; service?: string },
  deps: DataSourceFetchDeps = {}
): Promise<Response> {
  const directFetch = deps.directFetch ?? globalThis.fetch;

  if (opts?.service && PROXY_EXCLUDED_SERVICES.has(opts.service)) {
    return directFetch(url, init);
  }
  if (isInternalFetchTarget(url)) {
    return directFetch(url, init);
  }

  const resolution = resolveDataSourceProxy(opts?.userId, deps);
  if (!resolution.proxyUrl) {
    return directFetch(url, init);
  }

  const proxiedFetch = (deps.proxiedFetchFactory ?? ((proxyUrl: string) => createProxiedFetch(proxyUrl)))(
    resolution.proxyUrl
  );
  try {
    return await proxiedFetch(url, init);
  } catch (error) {
    if (!isProxyLegError(error)) throw error;
    if (resolution.failureMode === "fail_closed") {
      throw new Error(
        `data-source proxy ${safeProxyHostForLog(resolution.proxyUrl)} unreachable and failure mode is fail_closed: ` +
          `${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    }
    warnProxyFallback(resolution.proxyUrl, error);
    return directFetch(url, init);
  }
}
