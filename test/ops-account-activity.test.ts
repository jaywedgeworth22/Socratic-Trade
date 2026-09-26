// GET /api/ops/account-activity — read-only view of what Alpaca's non-trade ledger reports for
// one connected account (board 687a5fb4, 2026-09-24 Roth IRA incident).
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "../app/api/ops/account-activity/route";
import { setInternalSetting, upsertConnectedAccount } from "../src/lib/db";
import { clampActivityDays } from "../src/lib/ops-account-activity";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-ops-account-activity-${randomUUID()}.db`)}`;
});

const OPS_TOKEN = "ops-activity-test-token";
const ACCOUNT_NUMBER = "294709855";

const rothLedger = [
  {
    id: "20260918000000000::1b0e3a52-0000-4000-8000-000000000004",
    activity_type: "CSW",
    date: "2026-09-18",
    net_amount: "-26.77",
    description: "IRA distribution to checking 000123456789",
    status: "executed",
    activity_sub_type: "NORMAL"
  },
  {
    id: "20260909000000001::1b0e3a52-0000-4000-8000-000000000003",
    activity_type: "WH",
    date: "2026-09-09",
    net_amount: "-6.96",
    description: "Federal tax withholding",
    status: "executed"
  },
  {
    id: "20260909000000000::1b0e3a52-0000-4000-8000-000000000002",
    activity_type: "CSW",
    date: "2026-09-09",
    net_amount: "-62.69",
    description: "IRA distribution",
    status: "executed"
  },
  {
    id: "20260816000000000::1b0e3a52-0000-4000-8000-000000000005",
    activity_type: "FEE",
    date: "2026-08-16",
    net_amount: "-0.01",
    description: "REG/TAF fee",
    status: "executed"
  },
  {
    id: "20260815000000000::1b0e3a52-0000-4000-8000-000000000006",
    activity_type: "DIV",
    date: "2026-08-15",
    net_amount: "0.12",
    symbol: "SPY",
    status: "executed"
  },
  {
    id: "20260803000000000::1b0e3a52-0000-4000-8000-000000000001",
    activity_type: "CSD",
    date: "2026-08-03",
    net_amount: "101.62",
    description: "IRA contribution tax year 2026",
    status: "executed"
  }
];

async function seed(): Promise<string> {
  const id = randomUUID();
  upsertConnectedAccount({
    id,
    userId: "local",
    broker: "alpaca",
    environment: "live",
    accountNumber: ACCOUNT_NUMBER,
    label: "Roth IRA",
    apiKey: "ira-key-id",
    apiSecret: "ira-key-secret",
    isActive: false
  });
  setInternalSetting(`risk:hwm:local:${ACCOUNT_NUMBER}:live`, 1.68);
  return id;
}

async function get(query: string, token: string | null = OPS_TOKEN) {
  return GET(
    new Request(`http://localhost/api/ops/account-activity${query}`, {
      headers: token ? { "x-ops-token": token } : {}
    })
  );
}

describe("GET /api/ops/account-activity", () => {
  const originalOps = process.env.OPS_DIAGNOSTIC_TOKEN;
  const originalBase = process.env.ALPACA_TRADING_BASE_URL;

  beforeEach(() => {
    process.env.OPS_DIAGNOSTIC_TOKEN = OPS_TOKEN;
    delete process.env.ALPACA_TRADING_BASE_URL;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalOps === undefined) delete process.env.OPS_DIAGNOSTIC_TOKEN;
    else process.env.OPS_DIAGNOSTIC_TOKEN = originalOps;
    if (originalBase === undefined) delete process.env.ALPACA_TRADING_BASE_URL;
    else process.env.ALPACA_TRADING_BASE_URL = originalBase;
  });

  it("rejects callers without the ops token", async () => {
    const id = await seed();
    const response = await get(`?connectedAccountId=${id}`, null);
    expect(response.status).toBe(401);
  });

  it("requires connectedAccountId", async () => {
    await seed();
    const response = await get("");
    expect(response.status).toBe(400);
  });

  it("lists non-trade rows with classification and a per-type summary, without ids or account numbers", async () => {
    const id = await seed();
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(String(url));
      return new Response(JSON.stringify(rothLedger));
    });
    const response = await get(`?connectedAccountId=${id}&days=90`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.environment).toBe("live");
    expect(body.tradingHost).toBe("api.alpaca.markets");
    expect(body.tradingBaseOverridden).toBe(false);
    expect(body.window.days).toBe(90);
    expect(urls[0]).toContain("category=non_trade_activity");
    expect(urls[0]).toContain(`after=${body.window.after}`);
    expect(body.ledger).toMatchObject({ ok: true, query: "category=non_trade_activity", truncated: false });

    expect(body.activities[0]).toEqual({
      date: "2026-09-18",
      activityType: "CSW",
      activitySubType: "NORMAL",
      classification: "capital",
      netAmount: -26.77,
      status: "executed",
      description: "IRA distribution to checking #####"
    });
    expect(body.activities.map((row: { activityType: string }) => row.activityType)).toEqual(["CSW", "WH", "CSW", "FEE", "DIV", "CSD"]);

    const byType = Object.fromEntries(
      body.summary.byType.map((entry: { activityType: string; count: number; netAmount: number; classification: string }) => [
        entry.activityType,
        entry
      ])
    );
    expect(byType.CSW).toMatchObject({ count: 2, classification: "capital" });
    expect(byType.CSW.netAmount).toBeCloseTo(-89.46, 2);
    expect(byType.WH).toMatchObject({ count: 1, classification: "capital" });
    expect(byType.DIV).toMatchObject({ classification: "income" });
    expect(byType.FEE).toMatchObject({ classification: "expense" });
    expect(body.summary.capitalIn).toBeCloseTo(101.62, 2);
    expect(body.summary.capitalOut).toBeCloseTo(-96.42, 2);
    expect(body.summary.unclassified).toEqual([]);
    expect(body.drawdownHwm.highWaterMark).toBeCloseTo(1.68, 2);

    const text = JSON.stringify(body);
    expect(text).not.toContain(ACCOUNT_NUMBER);
    expect(text).not.toContain("1b0e3a52");
    expect(text).not.toMatch(/ira-key-id|ira-key-secret|APCA-API/);
  });

  it("returns 502 with the broker's status and reason when the ledger read fails (never an empty 200)", async () => {
    const id = await seed();
    vi.stubGlobal(
      "fetch",
      async () => new Response(JSON.stringify({ code: 40310000, message: "forbidden for this account" }), { status: 403 })
    );
    const response = await get(`?connectedAccountId=${id}`);
    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.ledger.ok).toBe(false);
    expect(body.ledger.httpStatus).toBe(403);
    expect(body.ledger.error).toContain("forbidden for this account");
    expect(body.activities).toEqual([]);
    expect(JSON.stringify(body)).not.toMatch(/ira-key-id|ira-key-secret/);
  });

  it("clamps days to the supported range", async () => {
    expect(clampActivityDays(null)).toBe(365);
    expect(clampActivityDays("0")).toBe(365);
    expect(clampActivityDays("99999")).toBe(1825);
    expect(clampActivityDays("30")).toBe(30);
  });
});
