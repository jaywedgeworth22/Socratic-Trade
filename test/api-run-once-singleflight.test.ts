import { describe, it, expect, vi, beforeEach } from "vitest";
import { runOnce } from "../app/console/lib/api";

// We need to mock the global fetch or the internal request function.
// api.ts uses a global fetch.
describe("runOnce singleflighting", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("coalesces concurrent calls to a single fetch", async () => {
    let fetchCount = 0;
    const mockFetch = vi.fn().mockImplementation(() => {
      fetchCount++;
      return new Promise((resolve) => {
        setTimeout(() => {
          resolve({
            ok: true,
            status: 202,
            json: async () => ({ status: "queued", runId: "r_123" }),
            headers: new Headers({ "content-type": "application/json" })
          });
        }, 50);
      });
    });
    vi.stubGlobal("fetch", mockFetch);

    const p1 = runOnce();
    const p2 = runOnce();
    const p3 = runOnce();

    expect(p1).toBe(p2);
    expect(p1).toBe(p3);

    const [res1, res2, res3] = await Promise.all([p1, p2, p3]);

    expect(fetchCount).toBe(1);
    expect(res1).toEqual({ status: "queued", runId: "r_123" });
    expect(res2).toEqual({ status: "queued", runId: "r_123" });
    expect(res3).toEqual({ status: "queued", runId: "r_123" });

    // After resolving, a new call should trigger a new fetch
    const p4 = runOnce();
    expect(p4).not.toBe(p1);
    await p4;
    expect(fetchCount).toBe(2);
  });
});
