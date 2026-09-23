/**
 * Owner directive (2026-08-04): Socratic-Trade must NEVER call QuiverQuant,
 * Unusual Whales, or FMP directly.
 *
 * - Congressional disclosures, FMP-class fundamentals/analyst snapshots that
 *   App A already stores, and alt-data latency observations live on
 *   Congress.Trade (App A). This app consumes them via the App A client
 *   (`src/lib/api-clients/congress.ts`) and the Congress.Trade enrichment tier.
 * - Unusual Whales has never been a production ST producer; it stays banned so
 *   it cannot be reintroduced as a direct lane.
 *
 * Keep this module tiny and import it at every choke point that would otherwise
 * open a socket to those hosts. There is intentionally no emergency override.
 */

export type RetiredDirectVendor = "fmp" | "quiverquant" | "unusual_whales";

export const RETIRED_DIRECT_VENDORS: readonly RetiredDirectVendor[] = [
  "fmp",
  "quiverquant",
  "unusual_whales"
] as const;

/** Always false — direct access is permanently retired for this app. */
export function isDirectVendorAccessAllowed(_vendor: RetiredDirectVendor): boolean {
  return false;
}

export function directVendorRetirementMessage(vendor: RetiredDirectVendor): string {
  return (
    `${vendor} direct access is retired in Socratic-Trade; ` +
    `consume congressional / FMP-class data via Congress.Trade`
  );
}

/** Host substrings that must never be fetched by this app. */
export const RETIRED_DIRECT_VENDOR_HOSTS: readonly string[] = [
  "financialmodelingprep.com",
  "api.quiverquant.com",
  "api.unusualwhales.com",
  "unusualwhales.com"
] as const;

export function isRetiredDirectVendorUrl(url: string): boolean {
  const lower = url.toLowerCase();
  return RETIRED_DIRECT_VENDOR_HOSTS.some((host) => lower.includes(host));
}

/**
 * Health-lane / Connections service names that are intentionally retired for
 * product use. Admin Connections health must show these as muted OFF — never
 * red STOPPED — even when historical failure rows exist in api_health_log.
 *
 * Includes FMP native + RapidAPI / transcript variants and Quiver / UW.
 */
export function isIntentionalOffHealthService(service: string): boolean {
  const s = service.trim().toLowerCase();
  if (!s) return false;
  if (s === "fmp" || s.startsWith("fmp-") || s.startsWith("fmp_")) return true;
  if (s === "quiverquant" || s === "quiver" || s.startsWith("quiver")) return true;
  if (
    s === "unusual_whales" ||
    s === "unusual-whales" ||
    s.includes("unusualwhales") ||
    s.includes("unusual_whales")
  ) {
    return true;
  }
  return false;
}

/** Short operator-facing reason for Connections health OFF chip / detail. */
export function intentionalOffHealthReason(service: string): string {
  const s = service.trim().toLowerCase();
  if (s === "fmp" || s.startsWith("fmp-") || s.startsWith("fmp_")) {
    return "FMP direct access is retired in Socratic-Trade; FMP-class latency lives on Congress.Trade";
  }
  if (s === "quiverquant" || s === "quiver" || s.startsWith("quiver")) {
    return "QuiverQuant direct access is retired; congressional / alt-data via Congress.Trade";
  }
  if (
    s === "unusual_whales" ||
    s === "unusual-whales" ||
    s.includes("unusualwhales") ||
    s.includes("unusual_whales")
  ) {
    return "Unusual Whales is not a Socratic-Trade producer (permanently retired)";
  }
  return directVendorRetirementMessage("fmp");
}
