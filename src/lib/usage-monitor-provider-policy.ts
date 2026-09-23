// Provider families intentionally excluded from Socratic-Trade's Usage Monitor feed.
// These integrations remain active for trading, reads, and health; they simply have no
// separate subscription or meaningful quota/cost record to track in Usage Monitor.
const RETIRED_PROVIDER_ROOTS = ["alpaca", "robinhood", "tradier"] as const;

export function suppressUsageMonitorProvider(provider: string): boolean {
  const normalized = provider.trim().toLowerCase();
  return RETIRED_PROVIDER_ROOTS.some(
    (root) => normalized === root || normalized.startsWith(`${root}-`)
  );
}
