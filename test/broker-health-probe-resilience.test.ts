import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Board 687a5fb4 (2026-09-24, lane B `st-run-resilience`).  Production, Alpaca Paper, last 50
// runs 2026-09-22 13:39Z -> 09-24 19:20Z: 23 `skipped_broker_unhealthy`, 21 of them
// "…auto-paused: Broker health check timed out: checkBrokerHealth timeout" and 2 "Broker
// connectivity failure: Timed out waiting for alpaca.getAccount after 16000+8000ms.".  Both are
// TIMEOUT shapes that coincided with RTH event-loop stalls, and both halted Autopilot on the
// FIRST occurrence because the streak gate only recognised socket tokens in the prose.
//
// Covered here:
//   * a probe timeout (either shape) is streak-eligible — one does not halt, three consecutive do;
//   * a probe timeout attributed to a stalled event loop never counts toward (nor resets) the
//     streak, and carries an honest "broker not at fault" reason;
//   * an auto-owned pause lifts on the next healthy probe;
//   * a manual owner pause never auto-lifts — including an owner Pause issued on top of an
//     auto-pause, an owner Pause that lands while the probe is in flight, and a restart with
//     autoResumeOnBoot off.

const dir = mkdtempSync(join(tmpdir(), "agentic-probe-resilience-"));
process.env.DATABASE_URL = `file:${join(dir, "test.db")}`;
process.env.ENCRYPTION_KEY = "a".repeat(64);

const ACCOUNT = {
  id: "conn-probe",
  broker: "alpaca" as const,
  environment: "paper" as const,
  accountNumber: "PA-PROBE",
  label: "Paper",
  capabilities: undefined
};

function fundedPortfolio() {
  return {
    accountNumber: ACCOUNT.accountNumber,
    totalMarketValue: 50_000,
    buyingPower: 50_000,
    equityMarketValue: 0,
    optionMarketValue: 0,
    cash: 50_000
  };
}

/** The exact production error: `awaitWithFirstCallRetry` exhausting first+retry for getAccount. */
async function alpacaAccountTimeoutError(): Promise<unknown> {
  const { awaitWithFirstCallRetry } = await import("../src/lib/inflight-deadline");
  try {
    await awaitWithFirstCallRetry(() => new Promise<never>(() => undefined), {
      firstMs: 5,
      retryMs: 5,
      onFinalTimeout: () => {
        throw new Error("Timed out waiting for alpaca.getAccount after 16000+8000ms.");
      }
    });
  } catch (err) {
    return err;
  }
  throw new Error("expected the retry helper to time out");
}

async function freshActivePolicy(userId: string) {
  const { getPolicy, setPolicy } = await import("../src/lib/db");
  const policy = getPolicy(userId);
  policy.systemState = "active";
  setPolicy(policy, userId);
  return getPolicy(userId);
}

describe("broker-health probe timeouts and process stalls", () => {
  // Generous: the first import pulls the whole db/strategy module graph (slow on a loaded host).
  beforeAll(async () => {
    const { getDb } = await import("../src/lib/db");
    getDb();
    await import("../src/lib/broker-health");
    await import("../src/lib/scheduler");
  }, 240_000);

  beforeEach(async () => {
    const { getDb } = await import("../src/lib/db");
    getDb().exec("DELETE FROM settings; DELETE FROM audit_events; DELETE FROM strategy_runs;");
    const lag = await import("../src/lib/event-loop-lag");
    lag._resetEventLoopLagForTest();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    const lag = await import("../src/lib/event-loop-lag");
    lag._resetEventLoopLagForTest();
  });

  it("tags the retry helper's final timeout and withDeadline's expiry structurally", async () => {
    const { isDeadlineTimeoutError, withDeadline } = await import("../src/lib/inflight-deadline");
    const err = await alpacaAccountTimeoutError();
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("Timed out waiting for alpaca.getAccount after 16000+8000ms.");
    expect(isDeadlineTimeoutError(err)).toBe(true);

    const expired = await withDeadline(new Promise<never>(() => undefined), 5, "checkBrokerHealth timeout").catch(
      (e: unknown) => e
    );
    expect((expired as Error).message).toBe("checkBrokerHealth timeout");
    expect(isDeadlineTimeoutError(expired)).toBe(true);

    // A real rejection is NOT a timeout.
    expect(isDeadlineTimeoutError(new Error("Timed out waiting for nothing"))).toBe(false);
  });

  it("checkBrokerHealth marks the alpaca.getAccount 16000+8000ms timeout as a probe timeout", async () => {
    const { checkBrokerHealth } = await import("../src/lib/broker-health");
    const timeout = await alpacaAccountTimeoutError();
    const health = await checkBrokerHealth("local", ACCOUNT, {
      getAccounts: async () => {
        throw timeout;
      },
      getPortfolio: async () => fundedPortfolio()
    } as never);
    expect(health.isHealthy).toBe(false);
    expect(health.category).toBe("connectivity");
    expect(health.probeTimedOut).toBe(true);
    expect(health.processStall).toBeUndefined();
    expect(health.reason).toBe("Broker connectivity failure: Timed out waiting for alpaca.getAccount after 16000+8000ms.");
  });

  it("does not halt on the first alpaca.getAccount timeout; halts after three consecutive", async () => {
    const { applyBrokerOrderPlacementPause, checkBrokerHealth, getBrokerPlacementPauseMarker, BROKER_CONNECTIVITY_HALT_STREAK } =
      await import("../src/lib/broker-health");
    const { getPolicy } = await import("../src/lib/db");
    const userId = "local";
    const accountScope = `acct-getaccount-${randomUUID()}`;
    const policy = await freshActivePolicy(userId);
    const timeout = await alpacaAccountTimeoutError();
    const gateway = {
      getAccounts: async () => {
        throw timeout;
      },
      getPortfolio: async () => fundedPortfolio()
    } as never;

    for (let i = 1; i < BROKER_CONNECTIVITY_HALT_STREAK; i++) {
      const health = await checkBrokerHealth(userId, ACCOUNT, gateway);
      const result = await applyBrokerOrderPlacementPause({ userId, accountScope, health, policy });
      expect(result.action).toBe("none");
      expect(getPolicy(userId).systemState).toBe("active");
      expect(getBrokerPlacementPauseMarker(userId, accountScope)).toBeUndefined();
    }
    const health = await checkBrokerHealth(userId, ACCOUNT, gateway);
    const halted = await applyBrokerOrderPlacementPause({ userId, accountScope, health, policy });
    expect(halted.action).toBe("halted");
    expect(getPolicy(userId).systemState).toBe("halted");
    expect(getBrokerPlacementPauseMarker(userId, accountScope)?.autoResume).toBe(true);
  });

  it("does not halt on the first scheduler probe-deadline expiry; halts after three consecutive", async () => {
    const { applyBrokerOrderPlacementPause, healthSignalsFromProbeFailure } = await import("../src/lib/broker-health");
    const { withLaneDeadline } = await import("../src/lib/safety-maintenance");
    const { getPolicy } = await import("../src/lib/db");
    const userId = "local";
    const accountScope = `acct-deadline-${randomUUID()}`;
    const policy = await freshActivePolicy(userId);

    const expiry = await withLaneDeadline(new Promise<never>(() => undefined), 10, "checkBrokerHealth timeout", "broker-health-probe", {
      wraps: "call"
    }).catch((e: unknown) => e);
    const health = healthSignalsFromProbeFailure(expiry);
    expect(health.isHealthy).toBe(false);
    expect(health.probeTimedOut).toBe(true);
    expect(health.processStall).toBeUndefined();
    expect(health.reason).toMatch(/^Broker health check timed out: checkBrokerHealth timeout/);

    expect((await applyBrokerOrderPlacementPause({ userId, accountScope, health, policy })).action).toBe("none");
    expect((await applyBrokerOrderPlacementPause({ userId, accountScope, health, policy })).action).toBe("none");
    expect(getPolicy(userId).systemState).toBe("active");
    expect((await applyBrokerOrderPlacementPause({ userId, accountScope, health, policy })).action).toBe("halted");
    expect(getPolicy(userId).systemState).toBe("halted");
  });

  it("a healthy probe between timeouts resets the streak (consecutive means consecutive)", async () => {
    const { applyBrokerOrderPlacementPause, healthSignalsFromProbeFailure } = await import("../src/lib/broker-health");
    const { getPolicy } = await import("../src/lib/db");
    const userId = "local";
    const accountScope = `acct-reset-${randomUUID()}`;
    const policy = await freshActivePolicy(userId);
    const { withDeadline } = await import("../src/lib/inflight-deadline");
    const expired = await withDeadline(new Promise<never>(() => undefined), 5, "checkBrokerHealth timeout").catch((e: unknown) => e);
    const timeout = healthSignalsFromProbeFailure(expired);

    await applyBrokerOrderPlacementPause({ userId, accountScope, health: timeout, policy });
    await applyBrokerOrderPlacementPause({ userId, accountScope, health: timeout, policy });
    await applyBrokerOrderPlacementPause({ userId, accountScope, health: { isHealthy: true }, policy });
    await applyBrokerOrderPlacementPause({ userId, accountScope, health: timeout, policy });
    expect((await applyBrokerOrderPlacementPause({ userId, accountScope, health: timeout, policy })).action).toBe("none");
    expect(getPolicy(userId).systemState).toBe("active");
  });

  it("attributes a stall-dominated scheduler probe expiry to the process with an honest reason", async () => {
    const { healthSignalsFromProbeFailure } = await import("../src/lib/broker-health");
    const expiry = Object.assign(new Error("checkBrokerHealth timeout — event-loop stall 27000ms of 30000ms (90%) dominated the window"), {
      __laneDeadlineExpiry: true as const,
      elapsedMs: 30_000,
      stalledMs: 27_000,
      stallRatio: 0.9
    });
    const health = healthSignalsFromProbeFailure(expiry);
    expect(health.isHealthy).toBe(false);
    expect(health.processStall).toEqual({ stalledMs: 27_000, elapsedMs: 30_000 });
    expect(health.reason).toBe("App process was stalled (event loop blocked 27s of 30s); broker not at fault");
  });

  it("checkBrokerHealth attributes a timeout to the process when the lag sampler saw the loop blocked", async () => {
    const { checkBrokerHealth } = await import("../src/lib/broker-health");
    const lag = await import("../src/lib/event-loop-lag");
    const timeout = await alpacaAccountTimeoutError();
    const health = await checkBrokerHealth("local", ACCOUNT, {
      getAccounts: async () => {
        await new Promise((resolve) => setTimeout(resolve, 60));
        // The whole wait was one pinned loop: a sample far longer than the window, clamped to it.
        lag._recordEventLoopLagForTest(Date.now(), 60_000);
        throw timeout;
      },
      getPortfolio: async () => fundedPortfolio()
    } as never);
    expect(health.isHealthy).toBe(false);
    expect(health.processStall).toBeDefined();
    expect(health.processStall!.stalledMs).toBeGreaterThan(0);
    expect(health.reason).toMatch(/^App process was stalled \(event loop blocked \d+s of \d+s\); broker not at fault$/);
  });

  it("a stall-attributed probe never counts toward, nor resets, the halt streak", async () => {
    const { applyBrokerOrderPlacementPause, healthSignalsFromProbeFailure, processStallHealthSignals, brokerConnectivityStreakKey } =
      await import("../src/lib/broker-health");
    const { getPolicy, getInternalSetting, listAudit } = await import("../src/lib/db");
    const { withDeadline } = await import("../src/lib/inflight-deadline");
    const userId = "local";
    const accountScope = `acct-stall-${randomUUID()}`;
    const policy = await freshActivePolicy(userId);
    const stalled = processStallHealthSignals(28_000, 30_000);
    const expired = await withDeadline(new Promise<never>(() => undefined), 5, "checkBrokerHealth timeout").catch((e: unknown) => e);
    const timeout = healthSignalsFromProbeFailure(expired);

    // Ten stall-attributed probes in a row: no halt, no streak.
    for (let i = 0; i < 10; i++) {
      expect((await applyBrokerOrderPlacementPause({ userId, accountScope, health: stalled, policy })).action).toBe("none");
    }
    expect(getPolicy(userId).systemState).toBe("active");
    expect(getInternalSetting(brokerConnectivityStreakKey(userId, accountScope))).toBeUndefined();

    // timeout, stall, timeout, stall -> streak 2 (stalls neither counted nor reset), still active.
    await applyBrokerOrderPlacementPause({ userId, accountScope, health: timeout, policy });
    await applyBrokerOrderPlacementPause({ userId, accountScope, health: stalled, policy });
    await applyBrokerOrderPlacementPause({ userId, accountScope, health: timeout, policy });
    await applyBrokerOrderPlacementPause({ userId, accountScope, health: stalled, policy });
    expect(getInternalSetting(brokerConnectivityStreakKey(userId, accountScope))).toBe(2);
    expect(getPolicy(userId).systemState).toBe("active");
    // Third real timeout halts.
    expect((await applyBrokerOrderPlacementPause({ userId, accountScope, health: timeout, policy })).action).toBe("halted");

    const kinds = listAudit(100, userId).map((a) => a.kind);
    expect(kinds.filter((k) => k === "broker_placement_auto_halted")).toHaveLength(1);
  });

  it("in-run skip for a stalled probe is a generic 'skipped' with an honest reason, not broker_unhealthy", async () => {
    const { brokerHealthRunSkip, processStallHealthSignals } = await import("../src/lib/broker-health");
    const { strategyRunStatusLabel } = await import("../src/lib/strategy-run-status");
    const stalled = brokerHealthRunSkip(processStallHealthSignals(25_000, 26_000));
    expect(stalled.status).toBe("skipped");
    expect(stalled.auditKind).toBe("run_skipped_process_stalled");
    expect(stalled.summary).toMatch(/App process was stalled \(event loop blocked 25s of 26s\); broker not at fault/);
    // Web label must not call it a broker problem (classifier reads the summary of `skipped`).
    expect(strategyRunStatusLabel(stalled.status, stalled.summary)).toBe("Skipped");

    const broker = brokerHealthRunSkip({ isHealthy: false, reason: "Account equity (0) is too low to trade", category: "equity" });
    expect(broker.status).toBe("skipped_broker_unhealthy");
    expect(broker.auditKind).toBe("run_skipped_broker_unhealthy");
    expect(broker.summary).toBe(
      "Broker health check failed: Account equity (0) is too low to trade. Skipping strategy run to avoid consuming budget."
    );
  });

  it("an auto-owned pause lifts automatically on the next healthy probe", async () => {
    const { applyBrokerOrderPlacementPause, getBrokerPlacementPauseMarker, healthSignalsFromProbeFailure } = await import(
      "../src/lib/broker-health"
    );
    const { getPolicy, listAudit } = await import("../src/lib/db");
    const { withDeadline } = await import("../src/lib/inflight-deadline");
    const userId = "local";
    const accountScope = `acct-lift-${randomUUID()}`;
    const policy = await freshActivePolicy(userId);
    const expired = await withDeadline(new Promise<never>(() => undefined), 5, "checkBrokerHealth timeout").catch((e: unknown) => e);
    const timeout = healthSignalsFromProbeFailure(expired);
    for (let i = 0; i < 3; i++) await applyBrokerOrderPlacementPause({ userId, accountScope, health: timeout, policy });
    expect(getPolicy(userId).systemState).toBe("halted");

    // Still unhealthy -> stays paused and auto-owned.
    const still = await applyBrokerOrderPlacementPause({ userId, accountScope, health: timeout, policy });
    expect(still).toMatchObject({ action: "still_paused", autoOwned: true });

    const resumed = await applyBrokerOrderPlacementPause({ userId, accountScope, health: { isHealthy: true }, policy });
    expect(resumed.action).toBe("resumed");
    expect(getPolicy(userId).systemState).toBe("active");
    expect(policy.systemState).toBe("active");
    expect(getBrokerPlacementPauseMarker(userId, accountScope)).toBeUndefined();
    expect(listAudit(50, userId).map((a) => a.kind)).toContain("broker_placement_auto_resumed");
  });

  it("an owner Pause issued on top of an auto-pause is never auto-lifted", async () => {
    const { applyBrokerOrderPlacementPause, getBrokerPlacementPauseMarker } = await import("../src/lib/broker-health");
    const { getPolicy, listAudit } = await import("../src/lib/db");
    const { POST } = await import("../app/api/strategy/pause/route");
    const userId = "local";
    const policy = await freshActivePolicy(userId);
    // Use the scope the pause route will resolve for this user's policy.
    const accountScope = policy.connectedAccountId ?? `${policy.accountNumber}:unknown`;

    const halted = await applyBrokerOrderPlacementPause({
      userId,
      connectedAccountId: policy.connectedAccountId,
      accountScope,
      health: { isHealthy: false, reason: "Broker reports orders cannot be placed", category: "order_capability" },
      policy
    });
    expect(halted.action).toBe("halted");
    expect(getBrokerPlacementPauseMarker(userId, accountScope)).toBeDefined();

    const res = await POST(new Request("http://localhost/api/strategy/pause", { method: "POST" }));
    expect(res.status).toBe(200);
    // Owner intent now owns the halt: the auto-resume marker is gone.
    expect(getBrokerPlacementPauseMarker(userId, accountScope)).toBeUndefined();
    expect(listAudit(50, userId).map((a) => a.kind)).toContain("broker_placement_pause_owner_override");

    const afterHealthy = await applyBrokerOrderPlacementPause({
      userId,
      connectedAccountId: policy.connectedAccountId,
      accountScope,
      health: { isHealthy: true },
      policy: getPolicy(userId)
    });
    expect(afterHealthy.action).toBe("none");
    expect(getPolicy(userId).systemState).toBe("halted");
  });

  it("an owner Pause that lands while the probe is in flight is not claimed as an auto-pause", async () => {
    const { applyBrokerOrderPlacementPause, getBrokerPlacementPauseMarker } = await import("../src/lib/broker-health");
    const { getPolicy, setPolicy } = await import("../src/lib/db");
    const userId = "local";
    const accountScope = `acct-race-${randomUUID()}`;
    // The scheduler read this snapshot BEFORE its (up to 30s) probe…
    const staleSnapshot = await freshActivePolicy(userId);
    // …and the owner paused, and edited a setting, while the probe was in flight.
    setPolicy({ ...getPolicy(userId), systemState: "halted", runCadenceMinutes: 45 }, userId);

    const result = await applyBrokerOrderPlacementPause({
      userId,
      accountScope,
      health: { isHealthy: false, reason: "Broker reports orders cannot be placed", category: "order_capability" },
      policy: staleSnapshot
    });
    expect(result).toMatchObject({ action: "still_paused", autoOwned: false });
    expect(getBrokerPlacementPauseMarker(userId, accountScope)).toBeUndefined();
    expect(getPolicy(userId).runCadenceMinutes).toBe(45);

    const healthy = await applyBrokerOrderPlacementPause({ userId, accountScope, health: { isHealthy: true }, policy: staleSnapshot });
    expect(healthy.action).toBe("none");
    expect(getPolicy(userId).systemState).toBe("halted");
  });

  it("an auto-halt writes only systemState — it never reverts an owner edit made during the probe", async () => {
    const { applyBrokerOrderPlacementPause } = await import("../src/lib/broker-health");
    const { getPolicy, setPolicy } = await import("../src/lib/db");
    const userId = "local";
    const accountScope = `acct-lost-update-${randomUUID()}`;
    const staleSnapshot = await freshActivePolicy(userId);
    setPolicy({ ...getPolicy(userId), runCadenceMinutes: 55 }, userId);

    const result = await applyBrokerOrderPlacementPause({
      userId,
      accountScope,
      health: { isHealthy: false, reason: "Broker reports orders cannot be placed", category: "order_capability" },
      policy: staleSnapshot
    });
    expect(result.action).toBe("halted");
    const stored = getPolicy(userId);
    expect(stored.systemState).toBe("halted");
    expect(stored.runCadenceMinutes).toBe(55);
    expect(staleSnapshot.systemState).toBe("halted");
  });

  it("a restart with autoResumeOnBoot off turns an auto-pause into a durable halt", async () => {
    const { applyBrokerOrderPlacementPause, getBrokerPlacementPauseMarker } = await import("../src/lib/broker-health");
    const { getPolicy, setAutoResumeOnBoot } = await import("../src/lib/db");
    const { reconcileAutonomyOnBoot } = await import("../src/lib/scheduler");
    const userId = `boot-auto-pause-${randomUUID()}`;
    setAutoResumeOnBoot(userId, false);
    const policy = await freshActivePolicy(userId);
    const accountScope = policy.connectedAccountId ?? `${policy.accountNumber}:unknown`;
    await applyBrokerOrderPlacementPause({
      userId,
      connectedAccountId: policy.connectedAccountId,
      accountScope,
      health: { isHealthy: false, reason: "Broker reports orders cannot be placed", category: "order_capability" },
      policy
    });
    expect(getBrokerPlacementPauseMarker(userId, accountScope)).toBeDefined();

    await reconcileAutonomyOnBoot();

    expect(getBrokerPlacementPauseMarker(userId, accountScope)).toBeUndefined();
    const healthy = await applyBrokerOrderPlacementPause({
      userId,
      connectedAccountId: policy.connectedAccountId,
      accountScope,
      health: { isHealthy: true },
      policy: getPolicy(userId)
    });
    expect(healthy.action).toBe("none");
    expect(getPolicy(userId).systemState).toBe("halted");
  });

  it("keeps the probe stall bar identical to the lane stall bar", async () => {
    const { PROBE_STALL_ATTRIBUTION_RATIO } = await import("../src/lib/broker-health");
    const { LANE_STALL_ATTRIBUTION_RATIO } = await import("../src/lib/safety-maintenance");
    expect(PROBE_STALL_ATTRIBUTION_RATIO).toBe(LANE_STALL_ATTRIBUTION_RATIO);
  });

  it("scheduler broker-lane ceiling exceeds the Alpaca read first+retry budget it wraps", async () => {
    const { SCHEDULER_BROKER_TIMEOUT_MS } = await import("../src/lib/safety-maintenance");
    const { ALPACA_ACCOUNT_READ_FIRST_MS, ALPACA_ACCOUNT_READ_RETRY_MS } = await import("../src/lib/inflight-deadline");
    const { SCHEDULER_HEALTH_PROBE_TIMEOUT_MS } = await import("../src/lib/scheduler");
    expect(SCHEDULER_BROKER_TIMEOUT_MS).toBeGreaterThan(ALPACA_ACCOUNT_READ_FIRST_MS + ALPACA_ACCOUNT_READ_RETRY_MS);
    expect(SCHEDULER_HEALTH_PROBE_TIMEOUT_MS).toBeGreaterThan(ALPACA_ACCOUNT_READ_FIRST_MS + ALPACA_ACCOUNT_READ_RETRY_MS);
  });
});
