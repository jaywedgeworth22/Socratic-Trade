import { describe, it, expect, vi, beforeEach } from "vitest";
import { setPolicy, setDbForTesting } from "../src/lib/db";
import { POST } from "../app/api/orders/replace-market/route";

vi.mock("../src/lib/account-mutation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/account-mutation")>();
  return {
    ...actual,
    withAccountMutation: vi.fn().mockImplementation(async (opts, fn) => {
      try {
        const val = await fn({ assertOwned: vi.fn() });
        return { acquired: true, value: val };
      } catch (err) {
        throw err;
      }
    })
  };
});

vi.mock("../src/lib/order-replacement", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/order-replacement")>();
  return {
    ...actual,
    replaceStaleLimitOrderWithMarket: vi.fn().mockResolvedValue({ replacementOrderId: "new-order-id" })
  };
});

describe("POST /api/orders/replace-market", () => {
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

  it("should replace order", async () => {
    const req = new Request("http://localhost/api/orders/replace-market", { 
      method: "POST", 
      body: JSON.stringify({ orderId: "old-123" }) 
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.replacementOrderId).toBe("new-order-id");
  });

  it("should block if system is stopped", async () => {
    setPolicy({
      accountNumber: "TEST_ACCOUNT",
      agenticAllowed: true,
      enabled: false,
      systemState: "halted",
      strategy: "momentum",
      llmBudget: 10,
      riskAmount: 100
    }, "local");

    const req = new Request("http://localhost/api/orders/replace-market", { 
      method: "POST", 
      body: JSON.stringify({ orderId: "old-123" }) 
    });
    const res = await POST(req);
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.error).toBe("system_stopped");
  });
});
