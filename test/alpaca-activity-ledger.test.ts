// 2026-09-24 (board 687a5fb4): the Roth IRA HWM recompute reported zero transfers after ~$96
// had been withdrawn.  The ledger read used an `activity_types` filter (carrying "DIVTX", which
// is not an Alpaca type) and swallowed any non-2xx as `[]`.  These tests pin the honest reader:
// `category=non_trade_activity`, an explicit ok/error result, and no silent empty list.
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  fetchAlpacaAccountActivitiesDetailed,
  fetchAlpacaDailyEquityHistory,
  fetchAlpacaNonTradeActivities
} from "../src/lib/alpaca-account-insights";
import { upsertConnectedAccount } from "../src/lib/db";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-alpaca-ledger-${randomUUID()}.db`)}`;
});

const originalBase = process.env.ALPACA_TRADING_BASE_URL;

async function seedLiveIra(userId: string): Promise<string> {
  const id = `${userId}-roth-${randomUUID()}`;
  upsertConnectedAccount({
    id,
    userId,
    broker: "alpaca",
    environment: "live",
    accountNumber: "294709855",
    label: "Roth IRA",
    apiKey: "ira-key-id",
    apiSecret: "ira-key-secret",
    isActive: false
  });
  return id;
}

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalBase === undefined) delete process.env.ALPACA_TRADING_BASE_URL;
  else process.env.ALPACA_TRADING_BASE_URL = originalBase;
});

describe("fetchAlpacaNonTradeActivities", () => {
  it("reads category=non_trade_activity from the LIVE host with no activity_types filter", async () => {
    delete process.env.ALPACA_TRADING_BASE_URL;
    const accountId = await seedLiveIra("u-ledger-live");
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(String(url));
      return new Response(
        JSON.stringify([
          { id: "20260909000000000::a", activity_type: "CSW", date: "2026-09-09", net_amount: "-62.69", status: "executed" },
          { id: "20260909000000001::b", activity_type: "WH", date: "2026-09-09", net_amount: "-6.96", status: "executed" }
        ])
      );
    });
    const result = await fetchAlpacaNonTradeActivities("u-ledger-live", { connectedAccountId: accountId });
    expect(result.ok).toBe(true);
    expect(result.activities).toHaveLength(2);
    expect(result.query).toBe("category=non_trade_activity");
    expect(urls[0]).toContain("https://api.alpaca.markets/v2/account/activities?");
    expect(urls[0]).toContain("category=non_trade_activity");
    expect(urls[0]).not.toContain("activity_types");
    expect(urls[0]).not.toContain("DIVTX");
  });

  it("reports a 4xx as ok:false with the broker's trimmed reason — never an empty 'no transfers' list", async () => {
    const accountId = await seedLiveIra("u-ledger-403");
    vi.stubGlobal(
      "fetch",
      async () => new Response(JSON.stringify({ code: 40310000, message: "request is not authorized" }), { status: 403 })
    );
    const result = await fetchAlpacaNonTradeActivities("u-ledger-403", { connectedAccountId: accountId });
    expect(result.ok).toBe(false);
    expect(result.httpStatus).toBe(403);
    expect(result.error).toContain("HTTP 403");
    expect(result.error).toContain("request is not authorized");
    expect(result.error).not.toMatch(/ira-key-id|ira-key-secret/);
  });

  it("falls back to documented activity types only when Alpaca rejects the category parameter itself", async () => {
    const accountId = await seedLiveIra("u-ledger-422");
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      const href = String(url);
      urls.push(href);
      if (href.includes("category=")) {
        return new Response(JSON.stringify({ code: 42210000, message: "invalid category" }), { status: 422 });
      }
      return new Response(JSON.stringify([{ id: "x", activity_type: "CSD", date: "2026-08-03", net_amount: "101.62" }]));
    });
    const result = await fetchAlpacaNonTradeActivities("u-ledger-422", { connectedAccountId: accountId });
    expect(result.ok).toBe(true);
    expect(result.fallbackFrom).toContain("HTTP 422");
    expect(result.activities).toHaveLength(1);
    expect(urls).toHaveLength(2);
    expect(decodeURIComponent(urls[1])).toContain("activity_types=CSD,CSW,ACATC");
    expect(decodeURIComponent(urls[1])).not.toContain("DIVTX,");
  });

  it("reports a transport failure as ok:false (flows unknown), not as zero flows", async () => {
    const accountId = await seedLiveIra("u-ledger-down");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("socket hang up")));
    const result = await fetchAlpacaNonTradeActivities("u-ledger-down", { connectedAccountId: accountId });
    expect(result.ok).toBe(false);
    expect(result.activities).toEqual([]);
    expect(result.error).toContain("socket hang up");
  });

  it("reports a failure on a LATER page as ok:false instead of a silently short ledger", async () => {
    const accountId = await seedLiveIra("u-ledger-page2");
    vi.stubGlobal("fetch", async (url: string) => {
      if (String(url).includes("page_token=p2")) return new Response("upstream timeout", { status: 504 });
      return new Response(
        JSON.stringify([
          { id: "p1", activity_type: "CSW", date: "2026-09-18", net_amount: "-26.77" },
          { id: "p2", activity_type: "CSW", date: "2026-09-09", net_amount: "-69.65" }
        ])
      );
    });
    const result = await fetchAlpacaAccountActivitiesDetailed("u-ledger-page2", {
      connectedAccountId: accountId,
      category: "non_trade_activity",
      pageSize: 2
    });
    expect(result.ok).toBe(false);
    expect(result.httpStatus).toBe(504);
    expect(result.activities).toHaveLength(2);
  });

  it("marks the ledger truncated when paging stops at maxPages on a full page", async () => {
    const accountId = await seedLiveIra("u-ledger-trunc");
    let n = 0;
    vi.stubGlobal("fetch", async () => {
      n += 1;
      return new Response(JSON.stringify([{ id: `a${n}`, activity_type: "DIV", date: "2026-08-15", net_amount: "0.01" }]));
    });
    const result = await fetchAlpacaAccountActivitiesDetailed("u-ledger-trunc", {
      connectedAccountId: accountId,
      category: "non_trade_activity",
      pageSize: 1,
      maxPages: 2
    });
    expect(result.ok).toBe(true);
    expect(result.pages).toBe(2);
    expect(result.truncated).toBe(true);
  });

  it("returns credentialMissing (not an empty ledger) when the account has no private key", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const result = await fetchAlpacaNonTradeActivities("u-ledger-nobody", { connectedAccountId: "missing" });
    expect(result.ok).toBe(false);
    expect(result.credentialMissing).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("fetchAlpacaDailyEquityHistory", () => {
  it("maps Alpaca's left-labeled daily windows to New York calendar days and skips null closes", async () => {
    const accountId = await seedLiveIra("u-history");
    let captured = "";
    vi.stubGlobal("fetch", async (url: string) => {
      captured = String(url);
      return new Response(
        JSON.stringify({
          // 2026-09-08 00:00 EDT, 2026-09-09 00:00 EDT, 2026-09-10 00:00 EDT
          timestamp: [1_788_840_000, 1_788_926_400, 1_789_012_800],
          equity: [98, null, 28.35],
          profit_loss: [0, 0, 0],
          profit_loss_pct: [0, 0, 0],
          base_value: 98,
          timeframe: "1D"
        })
      );
    });
    const points = await fetchAlpacaDailyEquityHistory("u-history", {
      connectedAccountId: accountId,
      start: "2026-09-01T00:00:00Z",
      end: "2026-09-24T00:00:00Z"
    });
    expect(captured).toContain("/v2/account/portfolio/history?");
    expect(captured).toContain("timeframe=1D");
    expect(captured).toContain("start=2026-09-01");
    expect(points).toEqual([
      { day: "2026-09-08", equity: 98 },
      { day: "2026-09-10", equity: 28.35 }
    ]);
  });

  it("returns undefined for a body that is not the documented shape", async () => {
    const accountId = await seedLiveIra("u-history-bad");
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ equity: "28.00" })));
    const points = await fetchAlpacaDailyEquityHistory("u-history-bad", {
      connectedAccountId: accountId,
      start: "2026-09-01T00:00:00Z"
    });
    expect(points).toBeUndefined();
  });
});
