import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-ops-hwm-${randomUUID()}.db`)}`;
});

const OPS_TOKEN = "ops-hwm-test-token";
const ACCOUNT_ID = "2931b94a-6d4a-49f5-882c-0219d9627d41";

// Warm the route's module graph once with a generous budget: the first cold transform of the
// db/migration graph can exceed the per-test timeout on a loaded machine.
beforeAll(async () => {
  await import("../app/api/ops/hwm/recompute/route");
}, 240_000);

async function loadRoute() {
  vi.resetModules();
  return import("../app/api/ops/hwm/recompute/route");
}

describe("POST /api/ops/hwm/recompute", () => {
  const originalOps = process.env.OPS_DIAGNOSTIC_TOKEN;

  beforeEach(() => {
    process.env.OPS_DIAGNOSTIC_TOKEN = OPS_TOKEN;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalOps === undefined) delete process.env.OPS_DIAGNOSTIC_TOKEN;
    else process.env.OPS_DIAGNOSTIC_TOKEN = originalOps;
  });

  it("rejects callers without a valid ops token", async () => {
    const { POST } = await loadRoute();
    const response = await POST(
      new Request("http://localhost/api/ops/hwm/recompute", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ connectedAccountId: ACCOUNT_ID })
      })
    );
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(JSON.stringify(body)).not.toMatch(/api[-_]?key|secret/i);
  });

  it("requires connectedAccountId", async () => {
    const { POST } = await loadRoute();
    const response = await POST(
      new Request("http://localhost/api/ops/hwm/recompute", {
        method: "POST",
        headers: { "content-type": "application/json", "x-ops-token": OPS_TOKEN },
        body: JSON.stringify({})
      })
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("connectedAccountId");
  });

  it("rebuilds a cash-flow-aware HWM from CSD/CSW + current equity and persists it", async () => {
    vi.resetModules();
    process.env.OPS_DIAGNOSTIC_TOKEN = OPS_TOKEN;
    const db = await import("../src/lib/db");
    db.upsertConnectedAccount({
      id: ACCOUNT_ID,
      userId: "local",
      broker: "alpaca",
      environment: "live",
      accountNumber: "294709855",
      label: "Roth IRA",
      apiKey: "key-id",
      apiSecret: "key-secret",
      isActive: false
    });
    db.setInternalSetting("risk:hwm:local:294709855:live", 101.62);

    vi.stubGlobal("fetch", async (url: string) => {
      const href = String(url);
      if (href.includes("/v2/account/activities")) {
        return new Response(
          JSON.stringify([
            { id: "csw-1", activity_type: "CSW", date: "2026-09-01", net_amount: "-73.62" },
            { id: "csd-1", activity_type: "CSD", date: "2026-08-01", net_amount: "101.62" }
          ])
        );
      }
      if (href.includes("/v2/account")) {
        return new Response(JSON.stringify({ equity: "28.00", portfolio_value: "28.00", account_number: "294709855" }));
      }
      return new Response("not found", { status: 404 });
    });

    const { POST } = await import("../app/api/ops/hwm/recompute/route");
    const response = await POST(
      new Request("http://localhost/api/ops/hwm/recompute", {
        method: "POST",
        headers: { "content-type": "application/json", "x-ops-token": OPS_TOKEN },
        body: JSON.stringify({ connectedAccountId: ACCOUNT_ID })
      })
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.oldHwm).toBeCloseTo(101.62, 2);
    expect(body.newHwm).toBeCloseTo(28, 2);
    expect(body.equity).toBeCloseTo(28, 2);
    expect(body.netTransfers).toBeCloseTo(28, 2);
    expect(body.transferCount).toBe(2);
    expect(body.impliedDrawdownPct).toBeCloseTo(0, 2);
    expect(JSON.stringify(body)).not.toMatch(/key-id|key-secret|APCA-API/);
    expect(db.getInternalSetting<number>("risk:hwm:local:294709855:live")).toBeCloseTo(28, 2);
  });

  // 2026-09-24 (board 687a5fb4): realistic Roth IRA ledger + Alpaca daily closes.
  type Stub = { ledger?: unknown; ledgerStatus?: number; history?: unknown; historyStatus?: number; equity?: string };
  function stubAlpaca(stub: Stub) {
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      const href = String(url);
      urls.push(href);
      if (href.includes("/v2/account/activities")) {
        return new Response(JSON.stringify(stub.ledger ?? []), { status: stub.ledgerStatus ?? 200 });
      }
      if (href.includes("/v2/account/portfolio/history")) {
        return new Response(JSON.stringify(stub.history ?? { message: "not found" }), { status: stub.historyStatus ?? 200 });
      }
      if (href.endsWith("/v2/account")) {
        return new Response(JSON.stringify({ equity: stub.equity ?? "1.68", portfolio_value: stub.equity ?? "1.68", account_number: "x" }));
      }
      return new Response("not found", { status: 404 });
    });
    return urls;
  }

  const nyMidnight = (day: string) => Math.floor(Date.parse(`${day}T04:00:00Z`) / 1000);
  const rothHistory = {
    timestamp: ["2026-08-03", "2026-08-20", "2026-09-08", "2026-09-09", "2026-09-17", "2026-09-18", "2026-09-24"].map(nyMidnight),
    equity: [101.62, 99.1, 98, 28.35, 28.45, 1.68, 1.68],
    profit_loss: [0, 0, 0, 0, 0, 0, 0],
    profit_loss_pct: [0, 0, 0, 0, 0, 0, 0],
    base_value: 101.62,
    timeframe: "1D"
  };
  const rothLedger = [
    { id: "20260918000000000::d", activity_type: "CSW", date: "2026-09-18", net_amount: "-26.77", description: "IRA distribution 987654321", status: "executed" },
    { id: "20260909000000001::c", activity_type: "WH", date: "2026-09-09", net_amount: "-6.96", description: "Federal withholding", status: "executed" },
    { id: "20260909000000000::b", activity_type: "CSW", date: "2026-09-09", net_amount: "-62.69", description: "IRA distribution", status: "executed" },
    { id: "20260815000000000::e", activity_type: "DIV", date: "2026-08-15", net_amount: "0", symbol: "SPY", status: "executed" },
    { id: "20260803000000000::a", activity_type: "CSD", date: "2026-08-03", net_amount: "101.62", description: "IRA contribution", status: "executed" }
  ];

  async function seedRoth(id: string, accountNumber: string, hwm: number) {
    vi.resetModules();
    process.env.OPS_DIAGNOSTIC_TOKEN = OPS_TOKEN;
    const db = await import("../src/lib/db");
    db.upsertConnectedAccount({
      id,
      userId: "local",
      broker: "alpaca",
      environment: "live",
      accountNumber,
      label: "Roth IRA",
      apiKey: "key-id",
      apiSecret: "key-secret",
      isActive: false
    });
    db.setInternalSetting(`risk:hwm:local:${accountNumber}:live`, hwm);
    return db;
  }

  async function post(body: Record<string, unknown>) {
    const { POST } = await import("../app/api/ops/hwm/recompute/route");
    return POST(
      new Request("http://localhost/api/ops/hwm/recompute", {
        method: "POST",
        headers: { "content-type": "application/json", "x-ops-token": OPS_TOKEN },
        body: JSON.stringify(body)
      })
    );
  }

  it("replays the Roth IRA distributions + withholding against Alpaca daily closes (real drift, no phantom drawdown)", async () => {
    const id = randomUUID();
    const db = await seedRoth(id, "ROTH-HIST", 30);
    const urls = stubAlpaca({ ledger: rothLedger, history: rothHistory });
    const response = await post({ connectedAccountId: id });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.persisted).toBe(true);
    expect(body.method).toBe("daily-history");
    expect(body.newHwm).toBeCloseTo(1.74, 2);
    expect(body.impliedDrawdownPct).toBeLessThan(5);
    expect(body.capitalIn).toBeCloseTo(101.62, 2);
    expect(body.capitalOut).toBeCloseTo(-96.42, 2);
    expect(body.transferCount).toBe(4);
    expect(body.unexplainedEquityChanges).toEqual([]);
    expect(body.ledger.query).toBe("category=non_trade_activity");
    expect(urls.some((u) => u.includes("category=non_trade_activity"))).toBe(true);
    expect(urls.some((u) => u.includes("DIVTX"))).toBe(false);
    expect(JSON.stringify(body)).not.toMatch(/key-id|key-secret|APCA-API/);
    expect(db.getInternalSetting<number>("risk:hwm:local:ROTH-HIST:live")).toBeCloseTo(1.74, 2);
  });

  it("refuses to touch the HWM when the activity ledger cannot be read (502 flowsUnavailable)", async () => {
    const id = randomUUID();
    const db = await seedRoth(id, "ROTH-DOWN", 101.62);
    stubAlpaca({ ledger: { code: 42210000, message: "invalid activity type" }, ledgerStatus: 422, history: rothHistory });
    const response = await post({ connectedAccountId: id });
    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.persisted).toBe(false);
    expect(body.flowsUnavailable).toBe(true);
    expect(body.error).toContain("HWM not changed");
    expect(db.getInternalSetting<number>("risk:hwm:local:ROTH-DOWN:live")).toBeCloseTo(101.62, 2);
  });

  it("reports an empty ledger that cannot explain the equity path (409) instead of silently resetting to equity", async () => {
    const id = randomUUID();
    const db = await seedRoth(id, "ROTH-EMPTY", 30);
    stubAlpaca({ ledger: [], history: rothHistory });
    const response = await post({ connectedAccountId: id });
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.persisted).toBe(false);
    expect(body.unexplainedEquityChange.method).toBe("daily-history");
    expect(body.unexplainedEquityChange.proposedHwm).toBeCloseTo(101.62, 2);
    expect(body.unexplainedEquityChange.days.map((d: { day: string }) => d.day)).toEqual(["2026-09-09", "2026-09-18"]);
    expect(db.getInternalSetting<number>("risk:hwm:local:ROTH-EMPTY:live")).toBe(30);

    // The operator can still choose explicitly: reset to equity (treat the falls as cash-outs)…
    stubAlpaca({ ledger: [], history: rothHistory });
    const reset = await post({ connectedAccountId: id, acceptEquityReset: true });
    expect(reset.status).toBe(200);
    const resetBody = await reset.json();
    expect(resetBody.newHwm).toBeCloseTo(1.68, 2);
    expect(resetBody.warnings.join(" ")).toContain("acceptEquityReset");

    // …or keep the replayed HWM (treat them as real losses).
    stubAlpaca({ ledger: [], history: rothHistory });
    const keep = await post({ connectedAccountId: id, acceptUnexplained: true });
    expect(keep.status).toBe(200);
    expect((await keep.json()).newHwm).toBeCloseTo(101.62, 2);
  });

  it("without daily history, refuses a ledger that shows no contribution for a funded account (the 2026-09-24 read)", async () => {
    const id = randomUUID();
    const db = await seedRoth(id, "ROTH-NOHIST", 30);
    stubAlpaca({ ledger: [], historyStatus: 500 });
    const response = await post({ connectedAccountId: id });
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.unexplainedEquityChange.method).toBe("ledger-only");
    expect(body.unexplainedEquityChange.reason).toContain("no contribution or deposit");
    expect(db.getInternalSetting<number>("risk:hwm:local:ROTH-NOHIST:live")).toBe(30);
  });

  it("surfaces an unrecognized non-trade type in the response without applying it", async () => {
    const id = randomUUID();
    await seedRoth(id, "ROTH-UNK", 30);
    stubAlpaca({
      ledger: [...rothLedger, { id: "20260910000000000::z", activity_type: "SWP", date: "2026-09-10", net_amount: "-0.05", status: "executed" }],
      history: rothHistory
    });
    const response = await post({ connectedAccountId: id });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.unclassified.map((u: { activityType: string }) => u.activityType)).toEqual(["SWP"]);
    expect(body.warnings.join(" ")).toContain("SWP");
    expect(body.newHwm).toBeCloseTo(1.74, 2);
  });
});
