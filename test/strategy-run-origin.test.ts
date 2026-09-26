import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

// Board 687a5fb4 review round (2026-09-25, follow-up to PR #3752).
//
// 1. The restart retry decided "scheduler-launched" from the ABSENCE of a strategy_run_requests
//    row.  The iOS `strategy.run_once` command calls runStrategyOnce(userId, { manual: true })
//    directly and writes no request row, so a propose-only owner run killed by a restart could come
//    back as an autonomous (decide-authority) retry.  runStrategyOnce now writes the run's origin on
//    its strategy_runs row, and only `autonomous` runs are retry-eligible.
// 2. runStrategyOnce had no draining guard: deleteConnectedAccount leaves the account's strategy
//    state `active` while the drain lane winds its open orders down, and only the scheduler loop
//    skipped draining accounts.  A non-manual run on a draining account now refuses before any
//    broker or LLM work.

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-run-origin-${randomUUID()}.db`)}`;
});

function originOf(db: typeof import("../src/lib/db"), runId: string): string | null {
  const row = db.getDb().prepare("SELECT origin FROM strategy_runs WHERE id = ?").get(runId) as { origin: string | null } | undefined;
  if (!row) throw new Error(`no strategy_runs row for ${runId}`);
  return row.origin;
}

describe("runStrategyOnce records the run's origin on its run row", () => {
  // Generous: the first import pulls the whole strategy module graph (slow on a loaded host).
  beforeAll(async () => {
    await import("../src/lib/strategy");
  }, 240_000);

  it("an iOS/web Manual Run once is recorded as manual, whatever else is passed", async () => {
    const { runStrategyOnce } = await import("../src/lib/strategy");
    const db = await import("../src/lib/db");
    // No account selected: the run row is written, then the run fails fast — no broker, no LLM.
    const userId = `origin-manual-${randomUUID()}`;
    const mobile = await runStrategyOnce(userId, { manual: true });
    expect(mobile.status).toBe("failed");
    expect(originOf(db, mobile.runId)).toBe("manual");

    const drainedManual = await runStrategyOnce(userId, { manual: true, runId: randomUUID() });
    expect(originOf(db, drainedManual.runId)).toBe("manual");
  });

  it("scheduler and trigger shapes are autonomous; drained requests and overrides are not", async () => {
    const { runStrategyOnce } = await import("../src/lib/strategy");
    const db = await import("../src/lib/db");
    const userId = `origin-auto-${randomUUID()}`;
    const trigger = await runStrategyOnce(userId);
    expect(originOf(db, trigger.runId)).toBe("autonomous");
    const override = await runStrategyOnce(userId, { runStateOverride: "close_only" });
    expect(originOf(db, override.runId)).toBe("run_state_override");
    const drained = await runStrategyOnce(userId, { runId: randomUUID() });
    expect(originOf(db, drained.runId)).toBe("request");
  });
});

describe("runStrategyOnce refuses autonomous runs on a draining account", () => {
  it("fails a non-manual run on a disconnected (draining) account before any broker work", async () => {
    const { runStrategyOnce } = await import("../src/lib/strategy");
    const db = await import("../src/lib/db");
    const { DEFAULT_POLICY } = await import("../src/lib/defaults");
    const userId = `origin-draining-${randomUUID()}`;
    const accountId = `acct-${randomUUID()}`;
    db.upsertConnectedAccount({
      id: accountId,
      userId,
      broker: "test",
      environment: "paper",
      accountNumber: "PA-DRAIN",
      label: "Draining",
      isActive: true
    });
    db.setPolicy({ ...DEFAULT_POLICY, accountNumber: "PA-DRAIN", systemState: "active" }, userId, accountId);
    db.deleteConnectedAccount(accountId, userId);

    const result = await runStrategyOnce(userId, { connectedAccountId: accountId });
    expect(result.status).toBe("failed");
    expect(result.summary).toMatch(/being disconnected/);
    expect(result.proposals).toEqual([]);
  });
});
