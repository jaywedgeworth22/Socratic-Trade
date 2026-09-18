import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../src/lib/db-api-keys", () => ({
  listUsers: vi.fn(() => ["u1"]),
  listWatchlistSymbols: vi.fn(() => [{ symbol: "MSFT" }])
}));
vi.mock("../src/lib/db-fills", () => ({
  listRecentlyHeldSymbolValuesAllUsers: vi.fn(() => new Map([["AAPL", 12_000], ["MSFT", 100]])),
  listRecentlyHeldSymbolsAllUsers: vi.fn(() => ["AAPL", "MSFT"])
}));
vi.mock("../src/lib/web-sources/technical", () => ({
  getTechnicalWatchlist: vi.fn(() => ["NVDA", "MSFT"])
}));
vi.mock("../src/lib/money", () => ({
  normalizeSymbol: (s: string) => s.trim().toUpperCase()
}));

import {
  SEC_INGEST_PRIORITY,
  collectSecIngestPrioritySets,
  resolveSecIngestPriority,
  secIngestPriorityForSymbol
} from "../src/lib/rag/sec-ingest-priority";

describe("sec-ingest-priority", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("exposes the money-path ladder", () => {
    expect(SEC_INGEST_PRIORITY.HELD).toBe(100);
    expect(SEC_INGEST_PRIORITY.WATCHLIST).toBe(80);
    expect(SEC_INGEST_PRIORITY.RECENT_SCAN).toBe(60);
    expect(SEC_INGEST_PRIORITY.UNIVERSE_LATEST).toBe(40);
    expect(SEC_INGEST_PRIORITY.DEEPEN).toBe(10);
  });

  it("prefers held over watchlist over recent scan over universe", () => {
    const sets = collectSecIngestPrioritySets();
    expect(resolveSecIngestPriority("AAPL", sets)).toBe(SEC_INGEST_PRIORITY.HELD);
    // MSFT is held (and watchlist + scan) — held wins
    expect(resolveSecIngestPriority("MSFT", sets)).toBe(SEC_INGEST_PRIORITY.HELD);
    expect(resolveSecIngestPriority("NVDA", sets)).toBe(SEC_INGEST_PRIORITY.RECENT_SCAN);
    expect(resolveSecIngestPriority("XYZ", sets)).toBe(SEC_INGEST_PRIORITY.UNIVERSE_LATEST);
    expect(resolveSecIngestPriority("XYZ", sets, { deepen: true })).toBe(SEC_INGEST_PRIORITY.DEEPEN);
  });

  it("treats watchlist-only names as 80", async () => {
    const fills = await import("../src/lib/db-fills");
    vi.mocked(fills.listRecentlyHeldSymbolValuesAllUsers).mockReturnValue(new Map());
    vi.mocked(fills.listRecentlyHeldSymbolsAllUsers).mockReturnValue([]);
    const sets = collectSecIngestPrioritySets();
    expect(resolveSecIngestPriority("MSFT", sets)).toBe(SEC_INGEST_PRIORITY.WATCHLIST);
  });

  it("secIngestPriorityForSymbol matches resolve after collect", () => {
    expect(secIngestPriorityForSymbol("aapl")).toBe(SEC_INGEST_PRIORITY.HELD);
    expect(secIngestPriorityForSymbol("zzzz", { deepen: true })).toBe(SEC_INGEST_PRIORITY.DEEPEN);
  });
});
