// LANE B: scheduled market-scan freshness lane — guarantees Market Scan data is refreshed at
// least every MARKET_SCAN_FRESHNESS_MAX_AGE_HOURS, including over weekends when no strategy run
// fires. See src/lib/market-scan-freshness.ts.
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MarketScan } from "../src/lib/types";

const scanMarketMock = vi.fn();

// Stub scanMarket only — every other market.ts export stays real. Prevents this suite from
// making real Nasdaq/Yahoo/provider calls (same rationale as test/approval-lock.test.ts).
vi.mock("../src/lib/market", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/market")>();
  return {
    ...actual,
    scanMarket: (...args: unknown[]) => scanMarketMock(...args)
  };
});

import { audit, getDb, latestAuditByKind } from "../src/lib/db";
import {
  FRESHNESS_BOOT_GRACE_SECONDS,
  marketScanFreshnessMaxAgeHours,
  newestPersistedMarketScan,
  resetFreshnessGateForTests,
  runMarketScanFreshnessIfDue
} from "../src/lib/market-scan-freshness";
import { latestAuditStampByKind } from "../src/lib/db";
import { resetScanSingleFlightForTests } from "../src/lib/scan-singleflight";

function makeScan(generatedAt: string): MarketScan {
  return {
    source: "test",
    generatedAt,
    scannedSymbols: 1,
    returnedQuotes: 1,
    topCandidates: [],
    sectorBySymbol: {},
    quotesBySymbol: {
      AAPL: { symbol: "AAPL", price: 100, score: 1 }
    },
    warnings: []
  };
}

// A known Saturday/Sunday/Monday (America/New_York), well clear of any DST or holiday edge.
const SATURDAY = Date.parse("2026-08-01T16:00:00.000Z");
const MONDAY = Date.parse("2026-08-03T16:00:00.000Z");

/** Write an audit row whose `created_at` is exactly `timestampMs` — audit() stamps `new
 *  Date().toISOString()` internally with no injectable clock, so the wall clock has to move. */
function auditAt(kind: string, payload: unknown, userId: string, timestampMs: number): void {
  vi.setSystemTime(timestampMs);
  audit(kind, payload, userId);
}

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-market-scan-freshness-${randomUUID()}.db`)}`;
});

beforeEach(() => {
  // The lane always reads/writes user "local" (sole-user app; see market-scan-freshness.ts),
  // so every test shares that scope — start each test from a clean audit table rather than
  // relying on userId isolation.
  getDb().prepare("DELETE FROM audit_events").run();
  scanMarketMock.mockReset();
  scanMarketMock.mockResolvedValue(makeScan(new Date(MONDAY).toISOString()));
  resetScanSingleFlightForTests();
  resetFreshnessGateForTests();
  delete process.env.MARKET_SCAN_FRESHNESS_MAX_AGE_HOURS;
  vi.useFakeTimers();
  vi.setSystemTime(MONDAY);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("marketScanFreshnessMaxAgeHours", () => {
  it("defaults to 20 hours", () => {
    expect(marketScanFreshnessMaxAgeHours()).toBe(20);
  });

  it("reads the env override", () => {
    process.env.MARKET_SCAN_FRESHNESS_MAX_AGE_HOURS = "4";
    expect(marketScanFreshnessMaxAgeHours()).toBe(4);
  });

  it("falls back to the default on an invalid value", () => {
    process.env.MARKET_SCAN_FRESHNESS_MAX_AGE_HOURS = "not-a-number";
    expect(marketScanFreshnessMaxAgeHours()).toBe(20);
  });
});

describe("runMarketScanFreshnessIfDue", () => {
  it("env knob 0 disables the lane entirely", async () => {
    process.env.MARKET_SCAN_FRESHNESS_MAX_AGE_HOURS = "0";
    await runMarketScanFreshnessIfDue(MONDAY);
    expect(scanMarketMock).not.toHaveBeenCalled();
  });

  it("runs when no scan has ever been persisted", async () => {
    await runMarketScanFreshnessIfDue(MONDAY);
    expect(scanMarketMock).toHaveBeenCalledTimes(1);
  });

  it("does not run when the newest persisted scan is within the freshness window", async () => {
    auditAt("market_scan", { scan: makeScan(new Date(MONDAY - 60 * 60_000).toISOString()) }, "local", MONDAY - 60 * 60_000); // 1h old
    await runMarketScanFreshnessIfDue(MONDAY);
    expect(scanMarketMock).not.toHaveBeenCalled();
  });

  it("runs when the newest persisted scan exceeds the max age", async () => {
    auditAt("market_scan", { scan: makeScan(new Date(MONDAY - 21 * 60 * 60_000).toISOString()) }, "local", MONDAY - 21 * 60 * 60_000); // 21h old
    await runMarketScanFreshnessIfDue(MONDAY);
    expect(scanMarketMock).toHaveBeenCalledTimes(1);
  });

  it("honors a lower configured max age", async () => {
    process.env.MARKET_SCAN_FRESHNESS_MAX_AGE_HOURS = "2";
    auditAt("market_scan", { scan: makeScan(new Date(MONDAY - 3 * 60 * 60_000).toISOString()) }, "local", MONDAY - 3 * 60 * 60_000); // 3h old
    await runMarketScanFreshnessIfDue(MONDAY);
    expect(scanMarketMock).toHaveBeenCalledTimes(1);
  });

  it("prefers the newer of market_scan vs strategy_run when judging staleness", async () => {
    // Stale market_scan (25h) but a fresh strategy_run (30 min ago) should still read as fresh.
    auditAt("market_scan", { scan: makeScan(new Date(MONDAY - 25 * 60 * 60_000).toISOString()) }, "local", MONDAY - 25 * 60 * 60_000);
    auditAt(
      "strategy_run",
      {
        runId: "r1",
        status: "completed",
        summary: "ok",
        proposals: [],
        accountNumber: "ACC",
        marketScan: makeScan(new Date(MONDAY - 30 * 60_000).toISOString())
      },
      "local",
      MONDAY - 30 * 60_000
    );
    await runMarketScanFreshnessIfDue(MONDAY);
    expect(scanMarketMock).not.toHaveBeenCalled();
  });

  it("ignores a strategy_run audit whose payload has no embedded marketScan", async () => {
    // A skipped run has no marketScan — the lane must not mistake its recency for a fresh scan.
    auditAt("strategy_run", { runId: "r2", status: "skipped", summary: "Kill switch is active.", proposals: [] }, "local", MONDAY - 5 * 60_000);
    await runMarketScanFreshnessIfDue(MONDAY);
    expect(scanMarketMock).toHaveBeenCalledTimes(1);
  });

  it("runs full enrichment (no enrichmentMode override) on a trading day", async () => {
    await runMarketScanFreshnessIfDue(MONDAY);
    expect(scanMarketMock).toHaveBeenCalledTimes(1);
    const options = scanMarketMock.mock.calls[0][5] as { enrichmentMode?: string };
    expect(options.enrichmentMode).toBeUndefined();
  });

  it("runs enrichmentMode 'skip' seeded from the newest persisted scan on a non-trading day", async () => {
    auditAt("market_scan", { scan: makeScan(new Date(SATURDAY - 21 * 60 * 60_000).toISOString()) }, "local", SATURDAY - 21 * 60 * 60_000); // stale enough to trigger
    await runMarketScanFreshnessIfDue(SATURDAY);
    expect(scanMarketMock).toHaveBeenCalledTimes(1);
    const [symbols, positions, , , , options] = scanMarketMock.mock.calls[0] as [
      string[],
      unknown[],
      unknown,
      unknown,
      unknown,
      { enrichmentMode?: string; seedEnrichment?: Record<string, unknown> }
    ];
    expect(options.enrichmentMode).toBe("skip");
    expect(options.seedEnrichment).toEqual({ AAPL: { symbol: "AAPL", price: 100, score: 1 } });
    // Weekend lane never touches the broker for held positions (see module comment).
    expect(positions).toEqual([]);
    expect(Array.isArray(symbols)).toBe(true);
  });

  it("persists the fresh scan under the market_scan audit kind, readable back via latestAuditByKind", async () => {
    const fresh = makeScan(new Date(MONDAY).toISOString());
    scanMarketMock.mockResolvedValue(fresh);
    await runMarketScanFreshnessIfDue(MONDAY);
    const row = latestAuditByKind("market_scan", "local");
    expect(row).toBeDefined();
    expect((row!.payload as { scan: MarketScan }).scan.generatedAt).toBe(fresh.generatedAt);
  });

  it("does not throw when scanMarket rejects", async () => {
    auditAt("market_scan", { scan: makeScan(new Date(MONDAY - 21 * 60 * 60_000).toISOString()) }, "local", MONDAY - 21 * 60 * 60_000);
    scanMarketMock.mockRejectedValueOnce(new Error("provider down"));
    await expect(runMarketScanFreshnessIfDue(MONDAY)).resolves.toBeUndefined();
  });
});

describe("wedge fixes (2026-08-02 prod incident)", () => {
  it("boot grace: skips entirely when uptime is below the grace window, runs once past it", async () => {
    // Stale state that would normally trigger a refresh (empty audit table = infinitely stale).
    await runMarketScanFreshnessIfDue(SATURDAY, FRESHNESS_BOOT_GRACE_SECONDS - 1);
    expect(scanMarketMock).not.toHaveBeenCalled();
    await runMarketScanFreshnessIfDue(SATURDAY, FRESHNESS_BOOT_GRACE_SECONDS + 1);
    expect(scanMarketMock).toHaveBeenCalledTimes(1);
  });

  it("boot grace: unit callers that omit uptime are exempt (pre-existing call shape)", async () => {
    await runMarketScanFreshnessIfDue(SATURDAY);
    expect(scanMarketMock).toHaveBeenCalledTimes(1);
  });

  it("fast gate falls through when the fresh newest row is a scan-less strategy_run over a stale usable scan", async () => {
    const staleMs = SATURDAY - 30 * 60 * 60_000; // usable scan, 30h old (> 20h default)
    auditAt("market_scan", { scan: makeScan(new Date(staleMs).toISOString()) }, "local", staleMs);
    // Fresh-but-unusable newest row (skipped run, no marketScan payload).
    auditAt("strategy_run", { runId: "r-skip", status: "skipped", proposals: [] }, "local", SATURDAY - 60_000);
    vi.setSystemTime(SATURDAY);
    await runMarketScanFreshnessIfDue(SATURDAY);
    expect(scanMarketMock).toHaveBeenCalledTimes(1);
  });

  it("fresh usable scan short-circuits repeatedly without re-scanning (cached usability)", async () => {
    auditAt("market_scan", { scan: makeScan(new Date(SATURDAY - 60_000).toISOString()) }, "local", SATURDAY - 60_000);
    vi.setSystemTime(SATURDAY);
    await runMarketScanFreshnessIfDue(SATURDAY);
    await runMarketScanFreshnessIfDue(SATURDAY);
    await runMarketScanFreshnessIfDue(SATURDAY);
    expect(scanMarketMock).not.toHaveBeenCalled();
  });

  it("latestAuditStampByKind returns id+createdAt matching the full row, without payload", () => {
    auditAt("market_scan", { scan: makeScan(new Date(MONDAY).toISOString()) }, "stamp-scope", MONDAY);
    const stamp = latestAuditStampByKind("market_scan", "stamp-scope");
    expect(stamp).toBeDefined();
    expect(stamp).not.toHaveProperty("payload");
    const full = getDb().prepare("SELECT id, created_at FROM audit_events WHERE kind = 'market_scan' AND user_id = 'stamp-scope'").get() as { id: string; created_at: string };
    expect(stamp!.id).toBe(full.id);
    expect(stamp!.createdAt).toBe(full.created_at);
  });

  it("the freshness scan is given an abort deadline", async () => {
    await runMarketScanFreshnessIfDue(SATURDAY);
    expect(scanMarketMock).toHaveBeenCalledTimes(1);
    const options = scanMarketMock.mock.calls[0][5] as { signal?: AbortSignal };
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("newestPersistedMarketScan", () => {
  it("returns undefined when neither audit kind has ever been written", () => {
    expect(newestPersistedMarketScan("nobody-yet")).toBeUndefined();
  });

  it("picks whichever audit kind was written more recently, market_scan winning here", () => {
    auditAt(
      "strategy_run",
      { runId: "r3", status: "completed", summary: "ok", proposals: [], accountNumber: "ACC", marketScan: makeScan("2026-08-03T09:00:00.000Z") },
      "scope-a",
      MONDAY - 60 * 60_000
    );
    auditAt("market_scan", { scan: makeScan("2026-08-03T10:00:00.000Z") }, "scope-a", MONDAY);
    const newest = newestPersistedMarketScan("scope-a");
    expect(newest?.scan.generatedAt).toBe("2026-08-03T10:00:00.000Z");
  });

  it("falls back to the strategy_run's embedded marketScan when it is the more recent write", () => {
    auditAt("market_scan", { scan: makeScan("2026-08-03T09:00:00.000Z") }, "scope-b", MONDAY - 60 * 60_000);
    auditAt(
      "strategy_run",
      { runId: "r4", status: "completed", summary: "ok", proposals: [], accountNumber: "ACC", marketScan: makeScan("2026-08-03T10:00:00.000Z") },
      "scope-b",
      MONDAY
    );
    const newest = newestPersistedMarketScan("scope-b");
    expect(newest?.scan.generatedAt).toBe("2026-08-03T10:00:00.000Z");
  });

  it("does not let a newer but scan-less strategy_run (e.g. a skipped run) mask an older, usable market_scan", () => {
    auditAt("market_scan", { scan: makeScan("2026-08-03T09:00:00.000Z") }, "scope-c", MONDAY - 60 * 60_000);
    // Newer AUDIT ROW overall, but a skipped run carries no marketScan at all.
    auditAt(
      "strategy_run",
      { runId: "r5", status: "skipped", summary: "Kill switch is active.", proposals: [] },
      "scope-c",
      MONDAY
    );
    const newest = newestPersistedMarketScan("scope-c");
    expect(newest?.scan.generatedAt).toBe("2026-08-03T09:00:00.000Z");
  });

  // Real persisted shape (2026-09 prod crash: "k.warnings is not iterable"). Every `strategy_run`
  // audit since 2026-08-01 (audit-bounded-run.ts) stores its marketScan as a bounded
  // `{ omitted: true, source, generatedAt, scannedSymbols, returnedQuotes, candidateCount,
  // topSymbols }` summary, NOT the full scan — it has no `warnings`, `topCandidates`,
  // `sectorBySymbol`, or `quotesBySymbol` at all. A newer such row must never be treated as a
  // usable last-good scan, and must fall back to an older market_scan row that IS usable.
  it("never treats a strategy_run's bounded-summary marketScan (omitted:true) as a usable last-good scan", () => {
    auditAt("market_scan", { scan: makeScan("2026-08-03T09:00:00.000Z") }, "scope-omitted", MONDAY - 60 * 60_000);
    auditAt(
      "strategy_run",
      {
        runId: "r6",
        status: "completed",
        summary: "ok",
        proposals: [],
        accountNumber: "ACC",
        marketScan: {
          omitted: true,
          source: "test",
          generatedAt: "2026-08-03T10:00:00.000Z",
          scannedSymbols: 500,
          returnedQuotes: 480,
          candidateCount: 12,
          topSymbols: ["AAPL", "MSFT"]
        }
      },
      "scope-omitted",
      MONDAY
    );
    const newest = newestPersistedMarketScan("scope-omitted");
    expect(newest?.scan.generatedAt).toBe("2026-08-03T09:00:00.000Z");
    expect(Array.isArray(newest?.scan.warnings)).toBe(true);
  });

  it("returns undefined (never throws) when the ONLY persisted row is a bounded-summary strategy_run", () => {
    auditAt(
      "strategy_run",
      {
        runId: "r7",
        status: "completed",
        summary: "ok",
        proposals: [],
        accountNumber: "ACC",
        marketScan: { omitted: true, source: "test", generatedAt: "2026-08-03T10:00:00.000Z", scannedSymbols: 500, returnedQuotes: 480, candidateCount: 0, topSymbols: [] }
      },
      "scope-omitted-only",
      MONDAY
    );
    expect(newestPersistedMarketScan("scope-omitted-only")).toBeUndefined();
  });

  it("defaults a legacy/partial scan's missing `warnings` to [] instead of rejecting it outright", () => {
    const { warnings: _omit, ...legacyScanWithoutWarnings } = makeScan("2026-08-03T09:00:00.000Z");
    auditAt("market_scan", { scan: legacyScanWithoutWarnings }, "scope-legacy", MONDAY);
    const newest = newestPersistedMarketScan("scope-legacy");
    expect(newest?.scan.warnings).toEqual([]);
  });
});
