import { NextRequest, NextResponse } from "next/server";
import { resolveRequestUserId } from "@/lib/request-user";
import { dataSourceFetch, resolveDataSourceProxy } from "@/lib/data-source-fetch";
import { safeProxyHostForLog } from "@/lib/proxy-fetch";
import { enforceRateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/** Canary target: returns the caller's egress IP as plain text. Same check CT's
 *  rollout docs used to prove residential egress (curl --proxy ... api.ipify.org). */
const CANARY_URL = "https://api.ipify.org";
const CANARY_TIMEOUT_MS = 8_000;

/**
 * POST — live canary through the caller's EFFECTIVE proxy resolution (their own
 * settings when set, else the operator default). Reports the egress IP the canary
 * saw, so the UI can show "your data-source traffic currently exits as <ip>".
 * Rate-limited: it performs a real outbound request.
 */
export async function POST(request: NextRequest) {
  const userId = resolveRequestUserId(request, {});
  const limited = enforceRateLimit(userId, "settings-proxy-test", { limit: 10, windowMs: 60_000 });
  if (limited) return limited;

  const resolution = resolveDataSourceProxy(userId);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CANARY_TIMEOUT_MS);
  const started = Date.now();
  try {
    const res = await dataSourceFetch(CANARY_URL, { cache: "no-store", signal: controller.signal }, { userId });
    const text = (await res.text()).trim();
    return NextResponse.json({
      ok: res.ok,
      status: res.status,
      latencyMs: Date.now() - started,
      source: resolution.source,
      failureMode: resolution.failureMode,
      proxyHost: resolution.proxyUrl ? safeProxyHostForLog(resolution.proxyUrl) : null,
      egressIp: res.ok && text.length <= 64 ? text : null,
      error: res.ok ? undefined : `Canary returned HTTP ${res.status}.`
    });
  } catch (err) {
    return NextResponse.json({
      ok: false,
      latencyMs: Date.now() - started,
      source: resolution.source,
      failureMode: resolution.failureMode,
      proxyHost: resolution.proxyUrl ? safeProxyHostForLog(resolution.proxyUrl) : null,
      error: err instanceof Error ? err.message : String(err)
    });
  } finally {
    clearTimeout(timeout);
  }
}
