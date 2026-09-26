import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const dir = mkdtempSync(join(tmpdir(), "broker-health-pause-"));
process.env.DATABASE_URL = `file:${join(dir, "test.db")}`;
process.env.ENCRYPTION_KEY = "a".repeat(64);

describe("broker-health auto-pause when orders cannot be placed", () => {
  beforeAll(async () => {
    const { getDb } = await import("../src/lib/db");
    getDb(); // migrate
  });

  beforeEach(async () => {
    const { getDb } = await import("../src/lib/db");
    getDb().exec("DELETE FROM settings; DELETE FROM audit_events; DELETE FROM strategy_runs;");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("classifies infrastructure place failures vs ordinary rejects", async () => {
    const { isOrderPlacementInfrastructureFailure } = await import("../src/lib/broker-health");
    expect(isOrderPlacementInfrastructureFailure("Tradier HTTP 500: An error occurred while communicating with the backend.")).toBe(true);
    expect(isOrderPlacementInfrastructureFailure('{"errors":["An unexpected error occurred. Please try again."]}')).toBe(true);
    expect(isOrderPlacementInfrastructureFailure("fetch failed")).toBe(true);
    expect(isOrderPlacementInfrastructureFailure("ECONNRESET")).toBe(true);
    expect(isOrderPlacementInfrastructureFailure("alpaca 403: insufficient buying power")).toBe(false);
    expect(isOrderPlacementInfrastructureFailure("You do not have enough buying power for this trade.")).toBe(false);
    expect(isOrderPlacementInfrastructureFailure("OrderValidationError: qty < 1")).toBe(false);
  });

  it("halts active policy when health is unhealthy and auto-resumes when healthy", async () => {
    const { getPolicy, setPolicy, listAudit } = await import("../src/lib/db");
    const {
      applyBrokerOrderPlacementPause,
      getBrokerPlacementPauseMarker,
      clearBrokerPlacementPauseMarker
    } = await import("../src/lib/broker-health");

    const userId = "local";
    const accountScope = "acct-test-1";
    const policy = getPolicy(userId);
    policy.systemState = "active";
    setPolicy(policy, userId);

    const halt = await applyBrokerOrderPlacementPause({
      userId,
      accountScope,
      health: {
        isHealthy: false,
        reason: "Tradier order path unavailable: HTTP 500 backend",
        category: "order_capability"
      },
      policy
    });
    expect(halt.action).toBe("halted");
    expect(getPolicy(userId).systemState).toBe("halted");
    const marker = getBrokerPlacementPauseMarker(userId, accountScope);
    expect(marker?.autoResume).toBe(true);
    expect(marker?.reason).toMatch(/Tradier order path/);

    // Still unhealthy → still paused, no double-flip noise
    policy.systemState = "halted";
    const still = await applyBrokerOrderPlacementPause({
      userId,
      accountScope,
      health: { isHealthy: false, reason: "still down", category: "order_capability" },
      policy
    });
    expect(still.action).toBe("still_paused");
    if (still.action === "still_paused") {
      expect(still.autoOwned).toBe(true);
    }

    // Healthy again → auto-resume
    const resume = await applyBrokerOrderPlacementPause({
      userId,
      accountScope,
      health: { isHealthy: true },
      policy
    });
    expect(resume.action).toBe("resumed");
    expect(getPolicy(userId).systemState).toBe("active");
    expect(getBrokerPlacementPauseMarker(userId, accountScope)).toBeUndefined();

    const kinds = listAudit(50, userId).map((a) => a.kind);
    expect(kinds).toContain("broker_placement_auto_halted");
    expect(kinds).toContain("broker_placement_auto_resumed");

    clearBrokerPlacementPauseMarker(userId, accountScope);
  });

  it("does not auto-resume an owner halt that has no placement-pause marker", async () => {
    const { getPolicy, setPolicy } = await import("../src/lib/db");
    const { applyBrokerOrderPlacementPause, getBrokerPlacementPauseMarker } = await import("../src/lib/broker-health");

    const userId = "local";
    const accountScope = "acct-owner-halt";
    const policy = getPolicy(userId);
    policy.systemState = "halted"; // owner stopped
    setPolicy(policy, userId);

    const result = await applyBrokerOrderPlacementPause({
      userId,
      accountScope,
      health: { isHealthy: true },
      policy
    });
    expect(result.action).toBe("none");
    expect(getPolicy(userId).systemState).toBe("halted");
    expect(getBrokerPlacementPauseMarker(userId, accountScope)).toBeUndefined();
  });

  it("does not claim ownership of halt when already halted without our marker", async () => {
    const { getPolicy, setPolicy } = await import("../src/lib/db");
    const { applyBrokerOrderPlacementPause, getBrokerPlacementPauseMarker } = await import("../src/lib/broker-health");

    const userId = "local";
    const accountScope = "acct-owner-halt-2";
    const policy = getPolicy(userId);
    policy.systemState = "halted";
    setPolicy(policy, userId);

    const result = await applyBrokerOrderPlacementPause({
      userId,
      accountScope,
      health: { isHealthy: false, reason: "OMS down", category: "order_capability" },
      policy
    });
    // already halted by owner — we report still_paused but do NOT write our auto-resume marker
    expect(result.action).toBe("still_paused");
    if (result.action === "still_paused") {
      expect(result.autoOwned).toBe(false);
    }
    expect(getBrokerPlacementPauseMarker(userId, accountScope)).toBeUndefined();
  });

  // The scheduler reads its policy snapshot, then awaits checkBrokerHealth (up to ~30s) before
  // calling applyBrokerOrderPlacementPause.  An operator (console Start/Stop, ops account-control)
  // can change systemState during that await; the decision and the write must use durable state.
  it("an operator halt or close_only made during the health probe is not converted into an auto-resumable halt", async () => {
    const { getPolicy, setPolicy } = await import("../src/lib/db");
    const { applyBrokerOrderPlacementPause, getBrokerPlacementPauseMarker } = await import("../src/lib/broker-health");
    const userId = "local";
    const accountScope = "acct-race-operator-state";
    for (const operatorState of ["halted", "close_only"] as const) {
      setPolicy({ ...getPolicy(userId), systemState: "active" }, userId);
      const snapshot = getPolicy(userId); // the tick's read, before the probe
      setPolicy({ ...getPolicy(userId), systemState: operatorState }, userId); // operator, during the probe
      const result = await applyBrokerOrderPlacementPause({
        userId,
        accountScope,
        health: { isHealthy: false, reason: "Tradier order path unavailable: HTTP 500 backend", category: "order_capability" },
        policy: snapshot
      });
      expect(result.action).not.toBe("halted");
      expect(getPolicy(userId).systemState).toBe(operatorState);
      expect(getBrokerPlacementPauseMarker(userId, accountScope)).toBeUndefined();
      // The caller's snapshot now reflects durable state, so the rest of the tick does too.
      expect(snapshot.systemState).toBe(operatorState);
    }
  });

  it("an operator close_only made during the probe of an auto-halted account is not resumed to active", async () => {
    const { getPolicy, setPolicy, setInternalSetting } = await import("../src/lib/db");
    const { applyBrokerOrderPlacementPause, getBrokerPlacementPauseMarker } = await import("../src/lib/broker-health");
    const userId = "local";
    const accountScope = "acct-race-close-only";
    setPolicy({ ...getPolicy(userId), systemState: "halted" }, userId);
    setInternalSetting(`broker:placement-paused:${userId}:${accountScope}`, {
      since: new Date().toISOString(),
      reason: "Tradier order capability probe failed",
      autoResume: true,
      priorState: "active"
    });
    const snapshot = getPolicy(userId); // halted, read before the probe
    setPolicy({ ...getPolicy(userId), systemState: "close_only" }, userId); // operator, during the probe

    const result = await applyBrokerOrderPlacementPause({ userId, accountScope, health: { isHealthy: true }, policy: snapshot });
    expect(result.action).toBe("none");
    expect(getPolicy(userId).systemState).toBe("close_only");
    expect(getBrokerPlacementPauseMarker(userId, accountScope)).toBeUndefined();
  });

  it("a healthy probe syncs an operator halt into the tick's snapshot so the tick does not launch a run", async () => {
    const { getPolicy, setPolicy } = await import("../src/lib/db");
    const { applyBrokerOrderPlacementPause } = await import("../src/lib/broker-health");
    const userId = "local";
    setPolicy({ ...getPolicy(userId), systemState: "active" }, userId);
    const snapshot = getPolicy(userId);
    setPolicy({ ...getPolicy(userId), systemState: "halted" }, userId);
    const result = await applyBrokerOrderPlacementPause({ userId, accountScope: "acct-race-healthy", health: { isHealthy: true }, policy: snapshot });
    expect(result.action).toBe("none");
    expect(snapshot.systemState).toBe("halted");
    expect(getPolicy(userId).systemState).toBe("halted");
  });

  it("auto-halt changes only systemState and keeps a console edit made during the probe", async () => {
    const { getPolicy, setPolicy } = await import("../src/lib/db");
    const { applyBrokerOrderPlacementPause, clearBrokerPlacementPauseMarker } = await import("../src/lib/broker-health");
    const userId = "local";
    const accountScope = "acct-race-console-edit";
    setPolicy({ ...getPolicy(userId), systemState: "active", runCadenceMinutes: 30 }, userId);
    const snapshot = getPolicy(userId);
    setPolicy({ ...getPolicy(userId), runCadenceMinutes: 17 }, userId); // console edit, during the probe

    const result = await applyBrokerOrderPlacementPause({
      userId,
      accountScope,
      health: { isHealthy: false, reason: "Tradier order path unavailable: HTTP 500 backend", category: "order_capability" },
      policy: snapshot
    });
    expect(result.action).toBe("halted");
    const after = getPolicy(userId);
    expect(after.systemState).toBe("halted");
    expect(after.runCadenceMinutes).toBe(17);
    expect(snapshot.systemState).toBe("halted");
    clearBrokerPlacementPauseMarker(userId, accountScope);
  });

  it("checkBrokerHealth fails closed when probeOrderCapability returns not ok", async () => {
    const { checkBrokerHealth } = await import("../src/lib/broker-health");
    const gateway = {
      getAccounts: async () => [{ accountNumber: "VA1", label: "Sandbox", agenticAllowed: true }],
      getPortfolio: async () => ({
        accountNumber: "VA1",
        totalMarketValue: 100_000,
        buyingPower: 100_000,
        equityMarketValue: 0,
        optionMarketValue: 0,
        cash: 100_000
      }),
      probeOrderCapability: async () => ({
        ok: false,
        reason: "Tradier order path unavailable: HTTP 500 backend"
      })
    };
    const health = await checkBrokerHealth(
      "local",
      {
        id: "conn-1",
        broker: "tradier",
        environment: "paper",
        accountNumber: "VA1",
        label: "Sandbox",
        capabilities: undefined
      },
      gateway as never
    );
    expect(health.isHealthy).toBe(false);
    expect(health.category).toBe("order_capability");
    expect(health.reason).toMatch(/Tradier order path/);
  });

  it("checkBrokerHealth treats probe ok + funded account as healthy", async () => {
    const { checkBrokerHealth } = await import("../src/lib/broker-health");
    const gateway = {
      getAccounts: async () => [{ accountNumber: "PA1", label: "Paper", agenticAllowed: true }],
      getPortfolio: async () => ({
        accountNumber: "PA1",
        totalMarketValue: 50_000,
        buyingPower: 50_000,
        equityMarketValue: 0,
        optionMarketValue: 0,
        cash: 50_000
      }),
      probeOrderCapability: async () => ({ ok: true })
    };
    const health = await checkBrokerHealth(
      "local",
      {
        id: "conn-2",
        broker: "alpaca",
        environment: "paper",
        accountNumber: "PA1",
        label: "Paper",
        capabilities: undefined
      },
      gateway as never
    );
    expect(health.isHealthy).toBe(true);
  });

  it("persists skipped_broker_unhealthy once when the scheduler gate auto-halts", async () => {
    const { getDb, listAudit } = await import("../src/lib/db");
    const {
      persistBrokerHealthSkipRun,
      shouldPersistBrokerHealthSkip
    } = await import("../src/lib/broker-health");

    expect(shouldPersistBrokerHealthSkip({ wasActive: true, pauseAction: "halted" })).toBe(true);
    expect(shouldPersistBrokerHealthSkip({ wasActive: true, pauseAction: "none" })).toBe(false);
    expect(shouldPersistBrokerHealthSkip({ wasActive: false, pauseAction: "halted" })).toBe(false);
    expect(shouldPersistBrokerHealthSkip({ wasActive: true, pauseAction: "still_paused" })).toBe(false);

    const runId = persistBrokerHealthSkipRun({
      userId: "local",
      connectedAccountId: "acct-equity-0",
      accountNumber: "PA1",
      reason: "Account equity (0) is too low to trade",
      halted: true
    });
    const row = getDb()
      .prepare("SELECT status, summary, connected_account_id FROM strategy_runs WHERE id = ?")
      .get(runId) as { status: string; summary: string; connected_account_id: string };
    expect(row.status).toBe("skipped_broker_unhealthy");
    expect(row.connected_account_id).toBe("acct-equity-0");
    expect(row.summary).toMatch(/auto-paused/);
    expect(row.summary).toMatch(/equity \(0\)/);
    const kinds = listAudit(50, "local").map((a) => a.kind);
    expect(kinds).toContain("run_skipped_broker_unhealthy");
  });
});
