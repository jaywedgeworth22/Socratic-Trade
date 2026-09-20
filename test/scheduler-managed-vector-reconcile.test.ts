import { beforeEach, describe, expect, it, vi } from "vitest";

const schedulerMocks = vi.hoisted(() => ({
  settings: new Map<string, unknown>(),
  getInternalSetting: vi.fn(),
  setInternalSetting: vi.fn(),
  reconcileManagedVectorRecords: vi.fn(),
  hasInFlightStrategyWork: vi.fn(() => false)
}));

vi.mock("../src/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/db")>();
  return {
    ...actual,
    getInternalSetting: schedulerMocks.getInternalSetting,
    setInternalSetting: schedulerMocks.setInternalSetting
  };
});

vi.mock("../src/lib/vector-db", () => ({
  managedVectorLedgerAuthority: vi.fn(),
  getCurrentVectorProviderAuthority: vi.fn(),
  reconcileManagedVectorRecords: schedulerMocks.reconcileManagedVectorRecords
}));

vi.mock("../src/lib/db-execution", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/db-execution")>();
  return {
    ...actual,
    hasInFlightStrategyWork: schedulerMocks.hasInFlightStrategyWork
  };
});

import {
  isManagedVectorReconcileDue,
  MANAGED_VECTOR_RECONCILE_LAST_ATTEMPT_KEY,
  MANAGED_VECTOR_RECONCILE_LAST_SUCCESS_KEY,
  MANAGED_VECTOR_RECONCILE_RETRY_INTERVAL_MS,
  MANAGED_VECTOR_RECONCILE_SUCCESS_INTERVAL_MS,
  reconcileManagedVectorRecordsIfDue
} from "../src/lib/scheduler";

const NOW = Date.parse("2026-07-14T12:00:00.000Z");

beforeEach(() => {
  schedulerMocks.settings.clear();
  schedulerMocks.getInternalSetting.mockReset().mockImplementation((key: string) => schedulerMocks.settings.get(key));
  schedulerMocks.setInternalSetting.mockReset().mockImplementation((key: string, value: unknown) => {
    schedulerMocks.settings.set(key, value);
  });
  schedulerMocks.reconcileManagedVectorRecords.mockReset();
  schedulerMocks.hasInFlightStrategyWork.mockReset().mockReturnValue(false);
});

describe("managed-vector reconciliation cadence", () => {
  it("allows a fresh run, then suppresses success until 24 hours have elapsed", () => {
    expect(isManagedVectorReconcileDue(NOW)).toBe(true);
    expect(isManagedVectorReconcileDue(NOW + MANAGED_VECTOR_RECONCILE_SUCCESS_INTERVAL_MS - 1, undefined, new Date(NOW).toISOString())).toBe(false);
    expect(isManagedVectorReconcileDue(NOW + MANAGED_VECTOR_RECONCILE_SUCCESS_INTERVAL_MS, undefined, new Date(NOW).toISOString())).toBe(true);
  });

  it("persists success and does not invoke again before the 24-hour success cadence", async () => {
    schedulerMocks.reconcileManagedVectorRecords.mockResolvedValue({ skipped: false });

    expect(await reconcileManagedVectorRecordsIfDue(NOW)).toEqual({ status: "success", result: { skipped: false } });
    expect(await reconcileManagedVectorRecordsIfDue(NOW + MANAGED_VECTOR_RECONCILE_SUCCESS_INTERVAL_MS - 1)).toBeNull();
    expect(schedulerMocks.reconcileManagedVectorRecords).toHaveBeenCalledTimes(1);
    expect(await reconcileManagedVectorRecordsIfDue(NOW + MANAGED_VECTOR_RECONCILE_SUCCESS_INTERVAL_MS)).toEqual({ status: "success", result: { skipped: false } });
    expect(schedulerMocks.reconcileManagedVectorRecords).toHaveBeenCalledTimes(2);
  });

  it("retries a failed run no more than hourly and does not leak its error", async () => {
    const error = new Error("provider failed with Bearer sk123456789012345");
    schedulerMocks.reconcileManagedVectorRecords.mockRejectedValue(error);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(await reconcileManagedVectorRecordsIfDue(NOW)).toEqual({ status: "failed" });
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0]?.[0]).not.toContain("sk123456789012345");
    expect(await reconcileManagedVectorRecordsIfDue(NOW + MANAGED_VECTOR_RECONCILE_RETRY_INTERVAL_MS - 1)).toBeNull();
    expect(schedulerMocks.reconcileManagedVectorRecords).toHaveBeenCalledTimes(1);
    expect(await reconcileManagedVectorRecordsIfDue(NOW + MANAGED_VECTOR_RECONCILE_RETRY_INTERVAL_MS)).toEqual({ status: "failed" });
    expect(schedulerMocks.reconcileManagedVectorRecords).toHaveBeenCalledTimes(2);
    expect(schedulerMocks.settings.get(MANAGED_VECTOR_RECONCILE_LAST_SUCCESS_KEY)).toBeUndefined();
    expect(schedulerMocks.settings.get(MANAGED_VECTOR_RECONCILE_LAST_ATTEMPT_KEY)).toBe(new Date(NOW + MANAGED_VECTOR_RECONCILE_RETRY_INTERVAL_MS).toISOString());
    errorSpy.mockRestore();
  });

  it("treats a lease-busy result as an hourly-retryable attempt", async () => {
    schedulerMocks.reconcileManagedVectorRecords.mockResolvedValue({ skipped: true });

    expect(await reconcileManagedVectorRecordsIfDue(NOW)).toEqual({ status: "busy", result: { skipped: true } });
    expect(await reconcileManagedVectorRecordsIfDue(NOW + MANAGED_VECTOR_RECONCILE_RETRY_INTERVAL_MS - 1)).toBeNull();
    expect(await reconcileManagedVectorRecordsIfDue(NOW + MANAGED_VECTOR_RECONCILE_RETRY_INTERVAL_MS)).toEqual({ status: "busy", result: { skipped: true } });
    expect(schedulerMocks.reconcileManagedVectorRecords).toHaveBeenCalledTimes(2);
    expect(schedulerMocks.settings.get(MANAGED_VECTOR_RECONCILE_LAST_SUCCESS_KEY)).toBeUndefined();
  });

  it("uses one in-process flight even when the second call is due", async () => {
    let resolveReconcile!: (value: { skipped?: boolean }) => void;
    schedulerMocks.reconcileManagedVectorRecords.mockReturnValue(new Promise((resolve) => {
      resolveReconcile = resolve;
    }));

    const first = reconcileManagedVectorRecordsIfDue(NOW);
    const second = reconcileManagedVectorRecordsIfDue(NOW + MANAGED_VECTOR_RECONCILE_RETRY_INTERVAL_MS);
    await vi.waitFor(() => expect(schedulerMocks.reconcileManagedVectorRecords).toHaveBeenCalledTimes(1));

    resolveReconcile({ skipped: false });
    const results = await Promise.all([first, second]);
    expect(results).toEqual([
      { status: "success", result: { skipped: false } },
      { status: "success", result: { skipped: false } }
    ]);
    expect(schedulerMocks.reconcileManagedVectorRecords).toHaveBeenCalledWith({ dryRun: true });
    expect(schedulerMocks.settings.get(MANAGED_VECTOR_RECONCILE_LAST_SUCCESS_KEY)).toBe(new Date(NOW).toISOString());
  });

  it("retries SQLITE_BUSY on lastAttempt/lastSuccess writes and does not re-run the provider pass", async () => {
    const busy = Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
    let attemptWrites = 0;
    let successWrites = 0;
    schedulerMocks.reconcileManagedVectorRecords.mockResolvedValue({ skipped: false });
    schedulerMocks.setInternalSetting.mockImplementation((key: string, value: unknown) => {
      if (key === MANAGED_VECTOR_RECONCILE_LAST_ATTEMPT_KEY) {
        attemptWrites += 1;
        if (attemptWrites === 1) throw busy;
      }
      if (key === MANAGED_VECTOR_RECONCILE_LAST_SUCCESS_KEY) {
        successWrites += 1;
        if (successWrites === 1) throw busy;
      }
      schedulerMocks.settings.set(key, value);
    });

    expect(await reconcileManagedVectorRecordsIfDue(NOW)).toEqual({ status: "success", result: { skipped: false } });
    expect(attemptWrites).toBe(2);
    expect(successWrites).toBe(2);
    expect(schedulerMocks.reconcileManagedVectorRecords).toHaveBeenCalledTimes(1);
    expect(schedulerMocks.settings.get(MANAGED_VECTOR_RECONCILE_LAST_ATTEMPT_KEY)).toBe(new Date(NOW).toISOString());
    expect(schedulerMocks.settings.get(MANAGED_VECTOR_RECONCILE_LAST_SUCCESS_KEY)).toBe(new Date(NOW).toISOString());
  });

  it("skips whole-index inventory while a strategy run is in flight and does not consume the attempt marker", async () => {
    schedulerMocks.hasInFlightStrategyWork.mockReturnValue(true);
    schedulerMocks.reconcileManagedVectorRecords.mockResolvedValue({ skipped: false });

    expect(await reconcileManagedVectorRecordsIfDue(NOW)).toEqual({ status: "busy", result: { skipped: true } });
    expect(schedulerMocks.reconcileManagedVectorRecords).not.toHaveBeenCalled();
    expect(schedulerMocks.settings.get(MANAGED_VECTOR_RECONCILE_LAST_ATTEMPT_KEY)).toBeUndefined();
    expect(schedulerMocks.settings.get(MANAGED_VECTOR_RECONCILE_LAST_SUCCESS_KEY)).toBeUndefined();
  });
});
