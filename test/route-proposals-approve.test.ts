import { describe, it, expect, vi, beforeEach } from "vitest";
import { setPolicy, setDbForTesting } from "../src/lib/db";
import { POST } from "../app/api/proposals/[id]/approve/route";
import { LiveApprovalConfirmationError } from "../src/lib/strategy-execution";

vi.mock("../src/lib/strategy-execution", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/strategy-execution")>();
  return {
    ...actual,
    executeProposal: vi.fn().mockResolvedValue({ success: true })
  };
});

describe("POST /api/proposals/[id]/approve", () => {
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

    const req = new Request("http://localhost/api/proposals/123/approve", { method: "POST", body: JSON.stringify({}) });
    const res = await POST(req, { params: Promise.resolve({ id: "123" }) });
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.error).toBe("system_stopped");
  });

  it("should execute proposal", async () => {
    const req = new Request("http://localhost/api/proposals/123/approve", { method: "POST", body: JSON.stringify({}) });
    const res = await POST(req, { params: Promise.resolve({ id: "123" }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
  });
});
