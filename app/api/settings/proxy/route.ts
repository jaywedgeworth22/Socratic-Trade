import { NextRequest, NextResponse } from "next/server";
import { resolveRequestUserId } from "@/lib/request-user";
import {
  deleteUserProxySettings,
  getUserProxySettingsView,
  upsertUserProxySettings,
  validateProxySettingsInput
} from "@/lib/user-proxy-settings";
import { resolveDataSourceProxy, PROXY_EXCLUDED_SERVICES } from "@/lib/data-source-fetch";
import { safeProxyHostForLog } from "@/lib/proxy-fetch";

export const dynamic = "force-dynamic";

/** Effective-resolution summary for the settings UI. Host[:port] only — a proxy
 *  URL can embed credentials and must never round-trip to the client. */
function effectivePayload(userId: string) {
  const resolution = resolveDataSourceProxy(userId);
  return {
    source: resolution.source,
    failureMode: resolution.failureMode,
    proxyHost: resolution.proxyUrl ? safeProxyHostForLog(resolution.proxyUrl) : null
  };
}

function payloadFor(userId: string) {
  return {
    ok: true,
    settings: getUserProxySettingsView(userId) ?? null,
    effective: effectivePayload(userId),
    excludedServices: [...PROXY_EXCLUDED_SERVICES]
  };
}

/** GET — the caller's own proxy settings (masked) + what egress will actually use. */
export async function GET(request: NextRequest) {
  const userId = resolveRequestUserId(request, {});
  return NextResponse.json(payloadFor(userId));
}

/**
 * PUT — { enabled?, protocol?, host, port?, username?, password?, failureMode? }.
 * Omit password to keep the stored one; pass "" / null to clear it.
 */
export async function PUT(request: NextRequest) {
  const userId = resolveRequestUserId(request, {});
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Body must be JSON." }, { status: 400 });
  }
  const parsed = validateProxySettingsInput(body);
  if (!parsed.ok) {
    return NextResponse.json({ ok: false, error: parsed.error }, { status: 400 });
  }
  const view = upsertUserProxySettings(userId, parsed.value);
  return NextResponse.json({ ok: true, settings: view, effective: effectivePayload(userId) });
}

/** DELETE — remove the caller's proxy override; egress falls back to the operator default. */
export async function DELETE(request: NextRequest) {
  const userId = resolveRequestUserId(request, {});
  deleteUserProxySettings(userId);
  return NextResponse.json(payloadFor(userId));
}
