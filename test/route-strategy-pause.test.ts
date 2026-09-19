import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, it, expect, beforeEach } from "vitest";
import { resetDbForTesting, setPolicy, getPolicy } from "../src/lib/db";
import { DEFAULT_POLICY } from "../src/lib/defaults";
import { POST } from "../app/api/strategy/pause/route";

beforeAll(() => {
  // Per-run temp DB (canonical repo pattern): keeps this test off the production
  // ./data/app.db and matches every other test that exercises setPolicy.
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-route-strategy-pause-${randomUUID()}.db`)}`;
  resetDbForTesting();
});

describe("POST /api/strategy/pause", () => {
  beforeEach(() => {
    resetDbForTesting();
    setPolicy({ ...DEFAULT_POLICY, accountNumber: "TEST_ACCOUNT", systemState: "active" }, "local");
  });

  it("should pause strategy", async () => {
    const req = new Request("http://localhost/api/strategy/pause", { method: "POST" });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { systemState?: string; enabled?: boolean };
    expect(data.systemState).toBe("halted");
    expect(data.enabled).toBe(false);

    const policy = getPolicy("local") as { systemState: string; enabled?: boolean };
    expect(policy.systemState).toBe("halted");
    expect(policy.enabled).toBe(false);
  });
});
