import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-ops-hwm-${randomUUID()}.db`)}`;
});

const OPS_TOKEN = "ops-hwm-test-token";
const ACCOUNT_ID = "2931b94a-6d4a-49f5-882c-0219d9627d41";

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
});
