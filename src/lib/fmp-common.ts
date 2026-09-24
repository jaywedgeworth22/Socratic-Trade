import { directVendorRetirementMessage, isDirectVendorAccessAllowed } from "./retired-direct-vendors";

export function getFmpApiKey(): string {
  // Key may still exist in env/DB for historical Connections UI, but direct FMP
  // access is retired — never treat the key as usable for outbound calls.
  throw new Error(directVendorRetirementMessage("fmp"));
}

export function scrubUrl(url: string, apiKey?: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.searchParams.has("apikey")) {
      parsed.searchParams.set("apikey", "REDACTED");
    }
    return parsed.toString();
  } catch {
    if (apiKey) {
      return url.replaceAll(apiKey, "REDACTED");
    }
    return url;
  }
}

/**
 * Shared FMP capability adapter — permanently no-op.
 * Owner: Socratic-Trade does not call FMP; Congress.Trade owns that quota and
 * exposes fundamentals/analyst/congressional data via App A read paths.
 */
export async function requestFmp<T>(
  endpoint: string,
  _params: Record<string, string | number> = {},
  _options: {
    service?: string;
    suppressStatuses?: number[];
    userId?: string;
  } = {}
): Promise<T | null> {
  if (!isDirectVendorAccessAllowed("fmp")) {
    const normalizedEndpoint = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
    console.warn(`[FMP] blocked retired direct call: ${normalizedEndpoint} — ${directVendorRetirementMessage("fmp")}`);
    return null;
  }
  return null;
}
