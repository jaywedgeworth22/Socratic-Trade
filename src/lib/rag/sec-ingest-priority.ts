// Money-path priority overlay for SecIngest task enqueue.
// Claim already orders by priority DESC (db-rag-ingest); the baseline seeder historically
// left priority at the default 0, so the desk's held/watchlist/scan names waited behind the
// broad universe. These constants are the contract for that overlay.

import { listUsers, listWatchlistSymbols } from "../db-api-keys";
import { listRecentlyHeldSymbolsAllUsers, listRecentlyHeldSymbolValuesAllUsers } from "../db-fills";
import { normalizeSymbol } from "../money";
import { getTechnicalWatchlist } from "../web-sources/technical";

/** Higher = claimed sooner. Keep gaps so a later tier can land in between without reshuffling. */
export const SEC_INGEST_PRIORITY = {
  HELD: 100,
  WATCHLIST: 80,
  RECENT_SCAN: 60,
  UNIVERSE_LATEST: 40,
  DEEPEN: 10
} as const;

export type SecIngestPriorityTier = keyof typeof SEC_INGEST_PRIORITY;

export type SecIngestPriorityOptions = {
  now?: number;
  /** When true (deepen/history pass), symbols that miss held/watchlist/scan get DEEPEN instead of UNIVERSE_LATEST. */
  deepen?: boolean;
};

function addNormalized(target: Set<string>, raw: string): void {
  const symbol = normalizeSymbol(raw);
  if (symbol) target.add(symbol);
}

/**
 * Build the three money-path symbol sets once per seed run.
 * Failures in any source are swallowed so a flaky watchlist/fills read cannot block enqueue.
 */
export function collectSecIngestPrioritySets(options?: { now?: number }): {
  held: Set<string>;
  watchlist: Set<string>;
  recentScan: Set<string>;
} {
  const now = options?.now ?? Date.now();
  const held = new Set<string>();
  const watchlist = new Set<string>();
  const recentScan = new Set<string>();

  try {
    const byValue = [...listRecentlyHeldSymbolValuesAllUsers(30, now).entries()]
      .filter(([, value]) => value > 0)
      .sort((a, b) => b[1] - a[1]);
    for (const [symbol] of byValue) addNormalized(held, symbol);
  } catch {
    try {
      for (const symbol of listRecentlyHeldSymbolsAllUsers(30, now)) addNormalized(held, symbol);
    } catch {
      // leave held empty
    }
  }

  try {
    for (const userId of listUsers()) {
      try {
        for (const item of listWatchlistSymbols(userId)) addNormalized(watchlist, item.symbol);
      } catch {
        // ignore per-user watchlist errors
      }
    }
  } catch {
    // leave watchlist empty
  }

  try {
    for (const symbol of getTechnicalWatchlist()) addNormalized(recentScan, symbol);
  } catch {
    // leave recentScan empty
  }

  return { held, watchlist, recentScan };
}

/**
 * Resolve enqueue priority for a symbol. Held wins over watchlist over recent scan;
 * everything else is UNIVERSE_LATEST (baseline seed) or DEEPEN (history pass).
 */
export function resolveSecIngestPriority(
  symbol: string,
  sets: { held: Set<string>; watchlist: Set<string>; recentScan: Set<string> },
  options?: { deepen?: boolean }
): number {
  const normalized = normalizeSymbol(symbol);
  if (normalized && sets.held.has(normalized)) return SEC_INGEST_PRIORITY.HELD;
  if (normalized && sets.watchlist.has(normalized)) return SEC_INGEST_PRIORITY.WATCHLIST;
  if (normalized && sets.recentScan.has(normalized)) return SEC_INGEST_PRIORITY.RECENT_SCAN;
  return options?.deepen ? SEC_INGEST_PRIORITY.DEEPEN : SEC_INGEST_PRIORITY.UNIVERSE_LATEST;
}

/** Convenience: collect sets + resolve in one call (fine for single-symbol paths; prefer collect once in bulk seeders). */
export function secIngestPriorityForSymbol(symbol: string, options?: SecIngestPriorityOptions): number {
  const sets = collectSecIngestPrioritySets({ now: options?.now });
  return resolveSecIngestPriority(symbol, sets, { deepen: options?.deepen });
}
