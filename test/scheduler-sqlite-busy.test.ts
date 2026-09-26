// Regression: #3385 leftover from #3383.  Scheduler lastTick / boot setPolicy still ran
// synchronous sqlite writes after the serving busy_timeout dropped to 100ms.  A SQLITE_BUSY
// on lastTick was counted as a health failure and could abdicate a live leader; a BUSY on
// boot audit retried in the same envelope as setPolicy and could double-audit the halt.
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_POLICY } from "../src/lib/defaults";

const triggerMocks = vi.hoisted(() => ({
  drainMaterialEventQueue: vi.fn()
}));

const dbMocks = vi.hoisted(() => ({
  lastTickBusyThrows: 0,
  lastTickCalls: 0,
  lastTickHardError: null as Error | null,
  haltSetPolicyCalls: 0,
  bootAuditBusyThrows: 0,
  bootAuditCalls: 0,
  markerDeleteBusyThrows: 0,
  ownerOverrideAuditBusyThrows: 0
}));

const leaseMocks = vi.hoisted(() => ({
  acquireOrRenewLeadership: vi.fn(() => true),
  releaseLease: vi.fn()
}));

vi.mock("../src/lib/triggers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/triggers")>();
  return { ...actual, drainMaterialEventQueue: triggerMocks.drainMaterialEventQueue };
});

vi.mock("../src/lib/scheduler-lease", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/scheduler-lease")>();
  return {
    ...actual,
    acquireOrRenewLeadership: leaseMocks.acquireOrRenewLeadership,
    releaseLease: leaseMocks.releaseLease
  };
});

vi.mock("../src/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/db")>();
  return {
    ...actual,
    setInternalSetting: (key: string, value: unknown) => {
      if (key === "scheduler:lastTick") {
        dbMocks.lastTickCalls += 1;
        if (dbMocks.lastTickHardError) throw dbMocks.lastTickHardError;
        if (dbMocks.lastTickBusyThrows > 0) {
          dbMocks.lastTickBusyThrows -= 1;
          throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
        }
      }
      return actual.setInternalSetting(key, value);
    },
    setPolicy: (policy: { systemState?: string }, userId: string, accountId?: string) => {
      if (policy.systemState === "halted") dbMocks.haltSetPolicyCalls += 1;
      return actual.setPolicy(policy as never, userId, accountId);
    },
    deleteInternalSetting: (key: string) => {
      if (key.startsWith("broker:placement-paused:") && dbMocks.markerDeleteBusyThrows > 0) {
        dbMocks.markerDeleteBusyThrows -= 1;
        throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
      }
      return actual.deleteInternalSetting(key);
    },
    audit: (kind: string, payload: unknown, userId?: string, accountId?: string) => {
      if (kind === "broker_placement_pause_owner_override" && dbMocks.ownerOverrideAuditBusyThrows > 0) {
        dbMocks.ownerOverrideAuditBusyThrows -= 1;
        throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
      }
      if (kind === "autonomy_halted_on_boot") {
        dbMocks.bootAuditCalls += 1;
        if (dbMocks.bootAuditBusyThrows > 0) {
          dbMocks.bootAuditBusyThrows -= 1;
          throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
        }
      }
      return actual.audit(kind, payload, userId, accountId);
    }
  };
});

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-sched-busy-${randomUUID()}.db`)}`;
  triggerMocks.drainMaterialEventQueue.mockReset().mockResolvedValue(undefined);
  leaseMocks.acquireOrRenewLeadership.mockReset().mockReturnValue(true);
  leaseMocks.releaseLease.mockReset();
  dbMocks.lastTickBusyThrows = 0;
  dbMocks.lastTickCalls = 0;
  dbMocks.lastTickHardError = null;
  dbMocks.haltSetPolicyCalls = 0;
  dbMocks.bootAuditBusyThrows = 0;
  dbMocks.bootAuditCalls = 0;
  dbMocks.markerDeleteBusyThrows = 0;
  dbMocks.ownerOverrideAuditBusyThrows = 0;
  const host = globalThis as {
    __schedulerHealthFailures?: number;
    __tickInFlight?: boolean;
    __tickStartedAtMs?: number;
    __tickGeneration?: number;
    __tickSentryCheckInId?: string;
  };
  host.__schedulerHealthFailures = 0;
  host.__tickInFlight = false;
  host.__tickStartedAtMs = undefined;
  host.__tickGeneration = 0;
  host.__tickSentryCheckInId = undefined;
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("scheduler heartbeat SQLITE_BUSY (#3385)", () => {
  it("does not incrementHealthFailures or releaseLease after a yielded-busy-then-SUCCESS lastTick write", async () => {
    vi.stubEnv("SCHEDULER_SINGLE_LEADER", "1");
    vi.stubEnv("SCHEDULER_HEALTH_FAILURE_THRESHOLD", "1");
    dbMocks.lastTickBusyThrows = 2;

    const { _runSchedulerTickForTest, _schedulerTickHealthCheck } = await import("../src/lib/scheduler");
    const db = await import("../src/lib/db");
    await _runSchedulerTickForTest();

    expect(dbMocks.lastTickCalls).toBe(3);
    expect(typeof db.getInternalSetting("scheduler:lastTick")).toBe("string");
    expect(_schedulerTickHealthCheck().failures).toBe(0);
    expect(leaseMocks.releaseLease).not.toHaveBeenCalled();
  });

  it("still abdicates when the heartbeat write fails with a non-busy error", async () => {
    vi.stubEnv("SCHEDULER_SINGLE_LEADER", "1");
    vi.stubEnv("SCHEDULER_HEALTH_FAILURE_THRESHOLD", "1");
    dbMocks.lastTickHardError = Object.assign(new Error("disk I/O error"), { code: "SQLITE_IOERR" });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const { _runSchedulerTickForTest, _schedulerTickHealthCheck } = await import("../src/lib/scheduler");
    await _runSchedulerTickForTest();

    expect(_schedulerTickHealthCheck().failures).toBe(1);
    expect(leaseMocks.releaseLease).toHaveBeenCalledTimes(1);
  });
});

describe("reconcileAutonomyOnBoot setPolicy/audit split (#3385)", () => {
  it("does not re-run setPolicy or double-audit when audit hits SQLITE_BUSY after a successful halt", async () => {
    const userId = `boot-busy-${randomUUID()}`;
    const db = await import("../src/lib/db");
    db.setPolicy({ ...DEFAULT_POLICY, accountNumber: "ACC1", systemState: "active" }, userId);
    dbMocks.haltSetPolicyCalls = 0;
    dbMocks.bootAuditBusyThrows = 1;

    const { reconcileAutonomyOnBoot } = await import("../src/lib/scheduler");
    await reconcileAutonomyOnBoot();

    expect(db.getPolicy(userId).systemState).toBe("halted");
    expect(dbMocks.haltSetPolicyCalls).toBe(1);
    expect(dbMocks.bootAuditCalls).toBe(2);
    const rows = db.getDb()
      .prepare("SELECT COUNT(*) as c FROM audit_events WHERE kind = ? AND user_id = ?")
      .get("autonomy_halted_on_boot", userId) as { c: number };
    expect(rows.c).toBe(1);
  });
});

// Review round (board 687a5fb4, 2026-09-25, follow-up to PR #3752): the halted-branch release of a
// broker-health auto-resume marker at boot ran as plain synchronous writes.  A SQLITE_BUSY there was
// swallowed by the per-account catch and the stale marker survived, so the next healthy probe
// auto-resumed an account whose owner had opted out of resuming after a restart.
describe("reconcileAutonomyOnBoot releases a broker auto-pause marker under SQLITE_BUSY", () => {
  async function autoPausedAccount() {
    const userId = `boot-marker-busy-${randomUUID()}`;
    const db = await import("../src/lib/db");
    const broker = await import("../src/lib/broker-health");
    db.setPolicy({ ...DEFAULT_POLICY, accountNumber: "ACC-MARKER", systemState: "active" }, userId);
    const accountScope = broker.brokerPauseAccountScope(undefined, "ACC-MARKER");
    const halted = await broker.applyBrokerOrderPlacementPause({
      userId,
      accountScope,
      health: { isHealthy: false, reason: "Broker reports orders cannot be placed", category: "order_capability" },
      policy: db.getPolicy(userId)
    });
    expect(halted.action).toBe("halted");
    db.setInternalSetting(broker.brokerConnectivityStreakKey(userId, accountScope), 2);
    expect(broker.getBrokerPlacementPauseMarker(userId, accountScope)).toBeDefined();
    return { userId, accountScope, db, broker };
  }

  function ownerOverrideAudits(db: typeof import("../src/lib/db"), userId: string): number {
    return (
      db.getDb()
        .prepare("SELECT COUNT(*) as c FROM audit_events WHERE kind = 'broker_placement_pause_owner_override' AND user_id = ?")
        .get(userId) as { c: number }
    ).c;
  }

  it("retries a busy marker delete instead of leaving the stale auto-resume marker behind", async () => {
    const { userId, accountScope, db, broker } = await autoPausedAccount();
    dbMocks.markerDeleteBusyThrows = 1;

    const { reconcileAutonomyOnBoot } = await import("../src/lib/scheduler");
    await reconcileAutonomyOnBoot();

    expect(dbMocks.markerDeleteBusyThrows).toBe(0);
    expect(broker.getBrokerPlacementPauseMarker(userId, accountScope)).toBeUndefined();
    expect(db.getInternalSetting(broker.brokerConnectivityStreakKey(userId, accountScope))).toBeUndefined();
    expect(ownerOverrideAudits(db, userId)).toBe(1);
    expect(db.getPolicy(userId).systemState).toBe("halted");
  });

  it("rolls the release back as one unit on a busy audit, then redoes it exactly once", async () => {
    const { userId, accountScope, db, broker } = await autoPausedAccount();
    dbMocks.ownerOverrideAuditBusyThrows = 1;

    const { reconcileAutonomyOnBoot } = await import("../src/lib/scheduler");
    await reconcileAutonomyOnBoot();

    expect(dbMocks.ownerOverrideAuditBusyThrows).toBe(0);
    expect(broker.getBrokerPlacementPauseMarker(userId, accountScope)).toBeUndefined();
    expect(db.getInternalSetting(broker.brokerConnectivityStreakKey(userId, accountScope))).toBeUndefined();
    expect(ownerOverrideAudits(db, userId)).toBe(1);
  });
});
