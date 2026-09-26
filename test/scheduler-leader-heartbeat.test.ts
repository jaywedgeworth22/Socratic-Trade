import { beforeEach, describe, expect, it, vi } from "vitest";

const schedulerMocks = vi.hoisted(() => ({
  acquireOrRenewLeadership: vi.fn(),
  sweepStaleRunsAndRetry: vi.fn(),
  setInternalSetting: vi.fn()
}));

vi.mock("../src/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/db")>();
  return { ...actual, setInternalSetting: schedulerMocks.setInternalSetting };
});

// The stale-run sweep (plus the one-time restart retry, board 687a5fb4) must still run on a
// follower, before the leader gate.
vi.mock("../src/lib/strategy-run-retry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/strategy-run-retry")>();
  return { ...actual, sweepStaleRunsAndRetry: schedulerMocks.sweepStaleRunsAndRetry };
});

vi.mock("../src/lib/scheduler-lease", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/scheduler-lease")>();
  return { ...actual, acquireOrRenewLeadership: schedulerMocks.acquireOrRenewLeadership };
});

import { _runSchedulerTickForTest } from "../src/lib/scheduler";

beforeEach(() => {
  vi.unstubAllEnvs();
  schedulerMocks.acquireOrRenewLeadership.mockReset();
  schedulerMocks.sweepStaleRunsAndRetry.mockReset().mockReturnValue({ repaired: 0, retry: { enqueued: 0, skipped: 0 } });
  schedulerMocks.setInternalSetting.mockReset();
});

describe("scheduler leader heartbeat ordering", () => {
  it("does not refresh scheduler:lastTick when this process is only a follower", async () => {
    vi.stubEnv("SCHEDULER_SINGLE_LEADER", "1");
    schedulerMocks.acquireOrRenewLeadership.mockReturnValue(false);

    await _runSchedulerTickForTest();

    expect(schedulerMocks.sweepStaleRunsAndRetry).toHaveBeenCalledTimes(1);
    expect(schedulerMocks.acquireOrRenewLeadership).toHaveBeenCalledTimes(1);
    expect(schedulerMocks.setInternalSetting).not.toHaveBeenCalled();
  });
});
