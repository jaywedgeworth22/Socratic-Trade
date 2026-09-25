// market-scan-freshness.ts — scheduler lane guaranteeing Market Scan data is refreshed at
// least every MARKET_SCAN_FRESHNESS_MAX_AGE_HOURS, including over weekends when no strategy
// run fires (isRunAllowedNow/isTradingDay block trading on non-trading days, and scanMarket
// otherwise has no scheduled caller — see docs/rollouts/2026-08-01-data-cascade-freshness-handoff.md).
//
// This is a DATA-FRESHNESS lane, not a trading lane: it deliberately does NOT pass through
// isRunAllowedNow/isTradingDay, never places an order, and never invokes the LLM — it only
// calls scanMarket (a read-only screener/enrichment fetch) and persists the result under the
// `market_scan` audit kind (the same kind app/api/scan/route.ts already writes on an
// interactive refresh; dashboard.ts already reads the newer of `market_scan` and
// `strategy_run` — see fullMarketScan/`latestScan` there).
//
// Cost posture: on a trading day, run the full enrichment scan (fundamentals are still worth
// refreshing). On a non-trading day, run in `enrichmentMode: "skip"` seeded from the newest
// persisted scan's quotesBySymbol — a keyless price/breadth refresh that burns no keyed
// provider quota, mirroring the interactive /api/scan path.
import { audit, getPolicy, latestAuditByKind, newerAuditEntry, type AuditEventRow, latestAuditStampByKind } from "./db";
import { dynamicIndexUniversesForPolicy } from "./index-universes";
import { isTradingDay } from "./market-calendar";
import { scanMarket } from "./market";
import { allowedSymbolsForPolicy } from "./policy";
import { interactiveScanKey, marketScanQuotesFromAudit, runScanSingleFlight } from "./scan-singleflight";
import type { MarketScan } from "./types";

const DEFAULT_MAX_AGE_HOURS = 20;
const FRESHNESS_USER_ID = "local"; // sole-user app today; see AGENTS.md "Sole user, no compat tax"

/** `MARKET_SCAN_FRESHNESS_MAX_AGE_HOURS` env knob: how stale the newest persisted scan may get
 *  before this lane refreshes it. `0` disables the lane entirely. Unset/invalid falls back to
 *  the 20h default (comfortably inside a ~60h Friday-close-to-Monday-open weekend gap). */
export function marketScanFreshnessMaxAgeHours(): number {
  const raw = process.env.MARKET_SCAN_FRESHNESS_MAX_AGE_HOURS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_MAX_AGE_HOURS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_MAX_AGE_HOURS;
}

/**
 * True when `candidate` has the shape of a real, usable MarketScan — as opposed to a
 * `BoundedMarketScanSummary` (audit-bounded-run.ts's `{ omitted: true, ... }` compaction that
 * EVERY `strategy_run` audit stores in place of the full scan since 2026-08-01, or any other
 * malformed/partial audit payload). Checks the fields this lane and its callers actually read
 * (`withLastGoodWarning`'s `scan.warnings` spread, `refreshTopCandidateQuotes`'s
 * `scan.topCandidates`) — a payload missing any of them is not a scan this lane can safely hand
 * back as "the last completed scan".
 */
function isUsableMarketScan(candidate: unknown): candidate is MarketScan {
  if (!candidate || typeof candidate !== "object") return false;
  const c = candidate as Record<string, unknown>;
  // The bounded-audit marker (audit-bounded-run.ts) — an omitted:true summary is NEVER a usable
  // last-good scan, even though it happens to also carry `source`/`generatedAt`/etc.
  if (c.omitted === true) return false;
  return (
    typeof c.source === "string" &&
    typeof c.generatedAt === "string" &&
    typeof c.scannedSymbols === "number" &&
    typeof c.returnedQuotes === "number" &&
    Array.isArray(c.topCandidates) &&
    Boolean(c.sectorBySymbol) && typeof c.sectorBySymbol === "object" &&
    Boolean(c.quotesBySymbol) && typeof c.quotesBySymbol === "object"
  );
}

function extractScan(payload: unknown): MarketScan | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const scan = (payload as { scan?: unknown }).scan ?? (payload as { marketScan?: unknown }).marketScan;
  if (!isUsableMarketScan(scan)) return undefined;
  // `warnings` is required on MarketScan but some genuinely-usable older persisted rows (pre-dates
  // the field, or a partial write) still lack it — default rather than reject, and default HERE
  // (not just at the `withLastGoodWarning` spread site) so every caller of `extractScan` /
  // `newestPersistedMarketScan` gets a scan whose `warnings` is always a real array.
  return Array.isArray(scan.warnings) ? scan : { ...scan, warnings: [] };
}

/**
 * The newest persisted MarketScan across BOTH audit kinds that can carry one — a scheduled/
 * interactive `market_scan` audit (payload `{ scan }`) and a `strategy_run` audit's embedded
 * `result.marketScan` — account-scoped preferred, falling back to user-wide (mirrors the
 * lookup dashboard.ts already does for `snapshot.latestScan`). Compares the two kinds' latest
 * rows independently rather than picking "whichever audit row is newest, period": a strategy_run
 * that skipped (e.g. kill switch) is still the newer AUDIT ROW but carries no marketScan, and
 * must not mask an older-but-still-usable market_scan. Returns undefined only when NEITHER kind
 * has ever produced a usable scan payload.
 */
export function newestPersistedMarketScan(
  userId: string,
  connectedAccountId?: string
): { scan: MarketScan; entry: AuditEventRow } | undefined {
  const scanAudit = (connectedAccountId ? latestAuditByKind("market_scan", userId, connectedAccountId) : undefined)
    ?? latestAuditByKind("market_scan", userId);
  const runAudit = (connectedAccountId ? latestAuditByKind("strategy_run", userId, connectedAccountId) : undefined)
    ?? latestAuditByKind("strategy_run", userId);

  const fromScan = scanAudit && extractScan(scanAudit.payload) ? { scan: extractScan(scanAudit.payload)!, entry: scanAudit } : undefined;
  const fromRun = runAudit && extractScan(runAudit.payload) ? { scan: extractScan(runAudit.payload)!, entry: runAudit } : undefined;
  if (!fromScan) return fromRun;
  if (!fromRun) return fromScan;
  return newerAuditEntry(fromScan.entry, fromRun.entry) === fromRun.entry ? fromRun : fromScan;
}

/** Deterministic single-flight key for this lane's own scan, stable across repeated calls with
 *  the same policy/universe so a lane invocation still in flight (audit not yet persisted) never
 *  causes a second tick to kick off a duplicate scanMarket call — see runScanSingleFlight. */
function freshnessScanKey(policy: ReturnType<typeof getPolicy>, symbols: string[], dynamicUniverses: ReturnType<typeof dynamicIndexUniversesForPolicy>): string {
  return interactiveScanKey({
    userId: FRESHNESS_USER_ID,
    accountNumber: policy.accountNumber,
    symbols,
    candidateLimit: policy.marketScanCandidateLimit,
    outlierReserve: policy.marketScanOutlierReserve,
    dynamicUniverses,
    scoringWeights: policy.scoringWeights,
    universeFloor: policy.universeFloor,
    // No broker call in this lane (see module comment) — positions are always empty, which also
    // keeps this key stable across ticks instead of chasing a live portfolio it never fetches.
    positions: []
  });
}

/**
 * Scheduler entry point: refresh the persisted Market Scan when it has gone stale, independent
 * of trading gates. Self-guarded — never throws into the tick.
 */
/** Serve HTTP before grinding: the scheduler's first tick fires at boot+ε, and this lane running
 *  a cold full scan on that tick was the 2026-08-02 prod wedge. Enforced at the scheduler call
 *  site (which passes process.uptime()); unit callers omit the arg and are exempt. */
export const FRESHNESS_BOOT_GRACE_SECONDS = 300;
/** Hard ceiling on one freshness scan — a scan that cannot finish inside this is exactly the
 *  wedge shape this lane must never re-create. */
export const FRESHNESS_SCAN_DEADLINE_MS = 10 * 60_000;

/** Last audit row id proven to carry a usable scan — skips re-parsing a multi-MB payload every
 *  tick while the newest row is unchanged (steady state = two index seeks, zero parses). */
let lastUsableAuditRowId: string | undefined;

/** Test-only (per-file temp DBs make cached row ids stale across tests). */
export function resetFreshnessGateForTests(): void {
  lastUsableAuditRowId = undefined;
}

export async function runMarketScanFreshnessIfDue(now: number = Date.now(), uptimeSeconds?: number): Promise<void> {
  try {
    const maxAgeHours = marketScanFreshnessMaxAgeHours();
    if (maxAgeHours <= 0) return; // 0 disables the lane
    if (uptimeSeconds !== undefined && uptimeSeconds < FRESHNESS_BOOT_GRACE_SECONDS) return; // boot grace

    const policy = getPolicy(FRESHNESS_USER_ID);
    const maxAgeMs = maxAgeHours * 60 * 60_000;

    // FAST GATE — stamps only, no payloads. The old gate resolved BOTH kinds' full payloads
    // (multi-MB rows) on every tick just to compare timestamps. A fresh stamp alone cannot
    // prove freshness (a skipped strategy_run row carries no scan and must not mask an older
    // stale-but-usable one), so usability is verified once per newest-row CHANGE and cached.
    const stampOf = (kind: string) =>
      latestAuditStampByKind(kind, FRESHNESS_USER_ID, policy.connectedAccountId) ??
      latestAuditStampByKind(kind, FRESHNESS_USER_ID);
    const scanStamp = stampOf("market_scan");
    const runStamp = stampOf("strategy_run");
    const newestStamp = !scanStamp
      ? runStamp
      : !runStamp || Date.parse(scanStamp.createdAt) >= Date.parse(runStamp.createdAt)
        ? scanStamp
        : runStamp;
    if (newestStamp && now - Date.parse(newestStamp.createdAt) < maxAgeMs) {
      if (newestStamp.id === lastUsableAuditRowId) return; // fresh + already proven usable
      const freshCheck = newestPersistedMarketScan(FRESHNESS_USER_ID, policy.connectedAccountId);
      if (freshCheck && now - Date.parse(freshCheck.entry.createdAt) < maxAgeMs) {
        lastUsableAuditRowId = freshCheck.entry.id;
        return;
      }
      // Fresh stamp but no fresh USABLE scan — fall through and refresh.
    }

    const newest = newestPersistedMarketScan(FRESHNESS_USER_ID, policy.connectedAccountId);
    const ageMs = newest ? now - Date.parse(newest.entry.createdAt) : Number.POSITIVE_INFINITY;
    if (Number.isFinite(ageMs) && ageMs < maxAgeHours * 60 * 60_000) {
      lastUsableAuditRowId = newest!.entry.id;
      return; // still fresh
    }

    const symbols = allowedSymbolsForPolicy(policy);
    const dynamicUniverses = dynamicIndexUniversesForPolicy(policy);
    const tradingDay = isTradingDay(new Date(now));
    const seedEnrichment = !tradingDay && newest
      ? marketScanQuotesFromAudit(newest.entry.payload, newest.entry.createdAt, now)
      : undefined;

    const key = freshnessScanKey(policy, symbols, dynamicUniverses);
    const scan = await runScanSingleFlight(key, () =>
      scanMarket(symbols, [], policy.scoringWeights, FRESHNESS_USER_ID, dynamicUniverses, {
        candidateLimit: policy.marketScanCandidateLimit,
        outlierReserve: policy.marketScanOutlierReserve,
        universeFloor: policy.universeFloor,
        enrichmentMode: tradingDay ? undefined : "skip",
        seedEnrichment,
        signal: AbortSignal.timeout(FRESHNESS_SCAN_DEADLINE_MS)
      })
    );

    try {
      audit("market_scan", { scan }, FRESHNESS_USER_ID, policy.connectedAccountId);
    } catch {
      /* audit is diagnostic only */
    }
  } catch (err) {
    console.error("[market-scan-freshness] error:", err instanceof Error ? err.message : err);
  }
}
