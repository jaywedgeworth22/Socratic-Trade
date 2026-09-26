/**
 * /api/policy enum validation for riskRules.drawdownBreakerAction (drawdown circuit-breaker response).
 * "halt" (default at runtime) and "close_only" persist; anything else 400s. Regression: a stored STRING
 * enum inside riskRules must NOT trip the numeric "risk rules must be non-negative numbers" sweep on
 * subsequent saves (the sweep merges `...current.riskRules`, so a stored non-numeric value used to make
 * every later save fail).
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-drawdown-action-api-${randomUUID()}.db`)}`;
});

function putRiskRules(riskRules: Record<string, unknown>) {
  return new Request("http://localhost/api/policy", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ riskRules })
  });
}

describe("/api/policy — riskRules.drawdownBreakerAction validation", () => {
  it("accepts and persists 'close_only'", async () => {
    const { PUT } = await import("../app/api/policy/route");
    const { getPolicy } = await import("../src/lib/db");
    const { DEFAULT_REQUEST_USER_ID } = await import("../src/lib/request-user");
    const response = await PUT(putRiskRules({ drawdownBreakerAction: "close_only" }));
    expect(response.status).toBe(200);
    expect((await response.json()).riskRules.drawdownBreakerAction).toBe("close_only");
    expect(getPolicy(DEFAULT_REQUEST_USER_ID).riskRules.drawdownBreakerAction).toBe("close_only");
  });

  it("accepts 'halt' and 'advisory' (the default action)", async () => {
    const { PUT } = await import("../app/api/policy/route");
    for (const ok of ["halt", "advisory"]) {
      const response = await PUT(putRiskRules({ drawdownBreakerAction: ok }));
      expect(response.status).toBe(200);
      expect((await response.json()).riskRules.drawdownBreakerAction).toBe(ok);
    }
  });

  it("rejects any other value with a clear 400", async () => {
    const { PUT } = await import("../app/api/policy/route");
    for (const bad of ["close-only", "stop", "off", 1, true]) {
      const response = await PUT(putRiskRules({ drawdownBreakerAction: bad }));
      expect(response.status).toBe(400);
      expect(await response.text()).toContain("riskRules.drawdownBreakerAction must be advisory, close_only, or halt.");
    }
  });

  it("does NOT trip the numeric risk-rules sweep — an unrelated later save still succeeds once it's stored", async () => {
    const { PUT } = await import("../app/api/policy/route");
    // Store the string enum first.
    expect((await PUT(putRiskRules({ drawdownBreakerAction: "close_only" }))).status).toBe(200);
    // A subsequent, unrelated numeric save must still pass — the stored string used to fail the
    // "risk rules must be non-negative numbers" sweep because it is merged from ...current.riskRules.
    const response = await PUT(putRiskRules({ maxDrawdownPct: 15 }));
    expect(response.status).toBe(200);
    const policy = await response.json();
    expect(policy.riskRules.maxDrawdownPct).toBe(15);
    expect(policy.riskRules.drawdownBreakerAction).toBe("close_only"); // preserved through the merge
  });

  // Review round 2026-09-25: the one-run unexplained-drop grace is an explicit owner preference.
  it("accepts riskRules.drawdownUnexplainedDropGrace as a boolean and rejects anything else", async () => {
    const { PUT } = await import("../app/api/policy/route");
    const on = await PUT(putRiskRules({ drawdownUnexplainedDropGrace: true }));
    expect(on.status).toBe(200);
    expect((await on.json()).riskRules.drawdownUnexplainedDropGrace).toBe(true);
    for (const bad of ["yes", 1, 0]) {
      const response = await PUT(putRiskRules({ drawdownUnexplainedDropGrace: bad }));
      expect(response.status).toBe(400);
      expect(await response.text()).toContain("riskRules.drawdownUnexplainedDropGrace must be true or false.");
    }
    const off = await PUT(putRiskRules({ drawdownUnexplainedDropGrace: false, maxDrawdownPct: 20 }));
    expect(off.status).toBe(200);
    expect((await off.json()).riskRules.drawdownUnexplainedDropGrace).toBe(false);
  });

  it("still rejects a genuinely negative numeric risk rule", async () => {
    const { PUT } = await import("../app/api/policy/route");
    const response = await PUT(putRiskRules({ maxDailyLossNotional: -50 }));
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("risk rules must be non-negative numbers.");
  });
});
