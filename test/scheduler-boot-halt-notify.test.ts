import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { getPolicy, listNotificationEvents, setAutoResumeOnBoot, setPolicy } from "../src/lib/db";
import { reconcileAutonomyOnBoot } from "../src/lib/scheduler";
import { DEFAULT_POLICY } from "../src/lib/defaults";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-boot-halt-notify-${randomUUID()}.db`)}`;
});

afterEach(() => {
  delete process.env.AUTONOMY_RESUME_ON_BOOT;
});

// Small delay to let the fire-and-forget notification promise (queued via .catch(), not awaited by
// reconcileAutonomyOnBoot) settle before assertions read the notification_events table.
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("reconcileAutonomyOnBoot — boot-halt notification", () => {
  it("halts an active account and records a boot-halt notification when autoResumeOnBoot is off", async () => {
    const userId = `boot-notify-${randomUUID()}`;
    setAutoResumeOnBoot(userId, false);
    setPolicy({ ...DEFAULT_POLICY, accountNumber: "ACC1", systemState: "active" }, userId);

    await reconcileAutonomyOnBoot();
    await flushMicrotasks();

    expect(getPolicy(userId).systemState).toBe("halted");

    const events = listNotificationEvents(userId, 50);
    const bootHaltEvents = events.filter((e) => e.type === "autonomy_halted_on_boot");
    expect(bootHaltEvents.length).toBe(1);
    expect(bootHaltEvents[0].title.toLowerCase()).toContain("autonomy halted on boot");
  });

  it("does not halt or notify when the user's autoResumeOnBoot is enabled", async () => {
    const userId = `boot-notify-resume-${randomUUID()}`;
    setAutoResumeOnBoot(userId, true);
    setPolicy({ ...DEFAULT_POLICY, accountNumber: "ACC1", systemState: "active" }, userId);

    await reconcileAutonomyOnBoot();
    await flushMicrotasks();

    expect(getPolicy(userId).systemState).toBe("active");

    const events = listNotificationEvents(userId, 50);
    const bootHaltEvents = events.filter((e) => e.type === "autonomy_halted_on_boot");
    expect(bootHaltEvents.length).toBe(0);
  });

  it("does not halt or notify any user when AUTONOMY_RESUME_ON_BOOT=1 is set", async () => {
    const userId = `boot-notify-env-${randomUUID()}`;
    setAutoResumeOnBoot(userId, false);
    setPolicy({ ...DEFAULT_POLICY, accountNumber: "ACC1", systemState: "active" }, userId);
    process.env.AUTONOMY_RESUME_ON_BOOT = "1";

    await reconcileAutonomyOnBoot();
    await flushMicrotasks();

    expect(getPolicy(userId).systemState).toBe("active");

    const events = listNotificationEvents(userId, 50);
    const bootHaltEvents = events.filter((e) => e.type === "autonomy_halted_on_boot");
    expect(bootHaltEvents.length).toBe(0);
  });
});
