import { describe, it, expect, beforeEach } from "vitest";
import { setPolicy, getPolicy, setDbForTesting } from "../src/lib/db";
import { POST } from "../app/api/strategy/pause/route";

describe("POST /api/strategy/pause", () => {
  beforeEach(() => {
    setDbForTesting();
    setPolicy({
      accountNumber: "TEST_ACCOUNT",
      agenticAllowed: true,
      enabled: true,
      strategy: "momentum",
      llmBudget: 10,
      riskAmount: 100
    }, "local");
  });

  it("should pause strategy", async () => {
    const req = new Request("http://localhost/api/strategy/pause", { method: "POST" });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.enabled).toBe(false);
    expect(data.systemState).toBe("halted");

    const policy = getPolicy("local");
    expect(policy.enabled).toBe(false);
    expect(policy.systemState).toBe("halted");
  });
});
