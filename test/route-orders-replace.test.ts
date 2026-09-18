import { describe, it, expect, vi, beforeEach } from "vitest";
import { resetDbForTesting, setPolicy } from "../src/lib/db";
import { DEFAULT_POLICY } from "../src/lib/defaults";
import { POST } from "../app/api/orders/replace-market/route";

vi.mock("../src/lib/account-mutation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/account-mutation")>();
  return {
    ...actual,
    withAccountMutation: vi.fn().mockImplementation(async (_opts, fn) => {
      const val = await fn({ assertOwned: vi.fn() });
      return { acquired: true, value: val };
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

vi.mock("../src/lib/broker", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/broker")>();
  return {
    ...actual,
    getBrokerGateway: vi.fn().mockReturnValue({})
  };
});

vi.mock("../src/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/db")>();
  return {
    ...actual,
    getActiveConnectedAccount: vi.fn().mockReturnValue({
      accountNumber: "TEST_ACCOUNT",
      agenticAllowed: true
    })
  };
});

describe("POST /api/orders/replace-market", () => {
  beforeEach(() => {
    resetDbForTesting();
    setPolicy({ ...DEFAULT_POLICY, accountNumber: "TEST_ACCOUNT", systemState: "active" }, "local");
  });

  it("should replace order", async () => {
    const req = new Request("http://localhost/api/orders/replace-market", {
      method: "POST",
      body: JSON.stringify({ orderId: "old-123" })
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { replacementOrderId?: string };
    expect(data.replacementOrderId).toBe("new-order-id");
  });

  it("should block if system is stopped", async () => {
    setPolicy({ ...DEFAULT_POLICY, accountNumber: "TEST_ACCOUNT", systemState: "halted" }, "local");

    const req = new Request("http://localhost/api/orders/replace-market", {
      method: "POST",
      body: JSON.stringify({ orderId: "old-123" })
    });
    const res = await POST(req);
    expect(res.status).toBe(409);
    const data = (await res.json()) as { error?: string };
    expect(data.error).toBe("system_stopped");
  });
});
