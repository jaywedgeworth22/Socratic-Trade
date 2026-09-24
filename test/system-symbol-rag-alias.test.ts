import { describe, expect, it } from "vitest";
import { formatNotificationDisplay, isSystemSymbol, SYSTEM_SYMBOLS } from "../src/lib/dashboard-ui";
import type { NotificationEvent } from "../src/lib/types";

/** 2026-09-20 MM: bug — clicking the "RAG" chip in Alerts Center opened a phantom
 *  SymbolDrilldown for the AI feature (it tried to load RAG price history, no position
 *  message, etc.).  Root cause: formatNotificationDisplay's symbolFromTitle helper
 *  pulled the first all-caps token from the alert title and the RAG ingest alert title
 *  is "Usage limit hit: openrouter RAG ingest hit daily cap" — so "RAG" became the
 *  symbol.  The fix routes the denylisted system identifiers through a non-clickable
 *  Chip (with a RAG-specific open-RAG-info-drawer path) instead of the symbol drilldown.
 *
 *  These tests pin the behavior end-to-end at the model layer that drives the alert row. */
describe("system symbol denylist (RAG, FMP, OPENROUTER, …)", () => {
  it("isSystemSymbol matches every known system identifier", () => {
    expect(isSystemSymbol("RAG")).toBe(true);
    expect(isSystemSymbol("rag")).toBe(true);
    expect(isSystemSymbol("FMP")).toBe(true);
    expect(isSystemSymbol("OPENROUTER")).toBe(true);
    expect(isSystemSymbol("ALPACA")).toBe(true);
    expect(isSystemSymbol("API")).toBe(true);
    expect(isSystemSymbol("DB")).toBe(true);
    expect(isSystemSymbol("LLM")).toBe(true);
    expect(isSystemSymbol("MCP")).toBe(true);
  });

  it("isSystemSymbol does NOT match real tickers", () => {
    expect(isSystemSymbol("AAPL")).toBe(false);
    expect(isSystemSymbol("TSLA")).toBe(false);
    expect(isSystemSymbol("SPY")).toBe(false);
    expect(isSystemSymbol("QQQ")).toBe(false);
    expect(isSystemSymbol("BRK.B")).toBe(false);
    expect(isSystemSymbol(undefined)).toBe(false);
    expect(isSystemSymbol(null)).toBe(false);
    expect(isSystemSymbol("")).toBe(false);
    expect(isSystemSymbol("   ")).toBe(false);
  });

  it("SYSTEM_SYMBOLS is exposed and non-empty", () => {
    expect(SYSTEM_SYMBOLS.size).toBeGreaterThan(5);
    expect(SYSTEM_SYMBOLS.has("RAG")).toBe(true);
    expect(SYSTEM_SYMBOLS.has("FMP")).toBe(true);
  });
});

describe("formatNotificationDisplay symbol extraction", () => {
  it("does NOT extract RAG from the RAG ingest budget alert title (regression)", () => {
    // Exact title shape produced by src/lib/usage-limit-alerts.ts:alertUsageLimitHit().
    const event: NotificationEvent = {
      id: "rag-budget-1",
      createdAt: "2026-09-20T15:00:00.000Z",
      type: "budget_alert",
      title: "Usage limit hit: openrouter RAG ingest hit daily cap",
      status: "sent",
      payload: {
        provider: "openrouter",
        operation: "embed-budget",
        limitName: "RAG ingest text daily cap",
        status: "exceeded",
        used: 50000,
        limit: 50000
      }
    };
    const display = formatNotificationDisplay(event, {});
    expect(display.symbol).toBeUndefined();
  });

  it("does NOT extract FMP / OPENROUTER / API / DB from system-provider alert titles", () => {
    const fixtures: Array<Pick<NotificationEvent, "title" | "type" | "id">> = [
      { id: "fmp-1", type: "provider_degraded", title: "FMP connection failed: timeout" },
      { id: "or-1", type: "provider_degraded", title: "OPENROUTER rate limit exceeded" },
      { id: "api-1", type: "kill_switch", title: "API gateway returning 503" },
      { id: "db-1", type: "run_failed", title: "DB write timed out" },
      { id: "llm-1", type: "budget_alert", title: "LLM token daily cap reached" }
    ];
    for (const fixture of fixtures) {
      const display = formatNotificationDisplay(
        { ...fixture, createdAt: "2026-09-20T15:00:00.000Z", status: "sent", payload: {} } as NotificationEvent,
        {}
      );
      expect(display.symbol, `expected no symbol for title "${fixture.title}"`).toBeUndefined();
    }
  });

  it("STILL extracts real tickers from fill / proposal alert titles", () => {
    const fillEvent: NotificationEvent = {
      id: "fill-1",
      createdAt: "2026-09-20T15:00:00.000Z",
      type: "fill",
      title: "PLTR sell filled",
      status: "sent",
      payload: { fill: { symbol: "PLTR", side: "sell", source: "live", status: "filled" } }
    };
    expect(formatNotificationDisplay(fillEvent, {}).symbol).toBe("PLTR");
  });

  it("falls back to a real ticker when both fill.symbol and proposal.symbol are absent", () => {
    // No payload at all, only the title — must still resolve to a real ticker if one appears.
    const event: NotificationEvent = {
      id: "title-only",
      createdAt: "2026-09-20T15:00:00.000Z",
      type: "run_failed",
      title: "Run on NVDA timed out",
      status: "sent",
      payload: {}
    };
    expect(formatNotificationDisplay(event, {}).symbol).toBe("NVDA");
  });

  it("returns undefined when the only all-caps token in the title is a system identifier", () => {
    const event: NotificationEvent = {
      id: "rag-only",
      createdAt: "2026-09-20T15:00:00.000Z",
      type: "budget_alert",
      title: "RAG exhausted",
      status: "sent",
      payload: {}
    };
    expect(formatNotificationDisplay(event, {}).symbol).toBeUndefined();
  });
});
