// Sentry integration must be INERT when no Sentry env vars are set: instrumentation
// register()/onRequestError() must not throw or load the SDK, and the scheduler's Sentry Crons
// check-in must be a no-op. The positive-path tests (env set) run LAST in this file on purpose:
// the `imported` flag below proves the disabled paths never even evaluate the @sentry/nextjs
// module, which only holds until the first test that legitimately triggers the import.
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const sentryMock = vi.hoisted(() => ({
  imported: false,
  captureCheckIn: vi.fn(() => "check-in-id"),
  captureRequestError: vi.fn()
}));

vi.mock("@sentry/nextjs", () => {
  sentryMock.imported = true;
  return {
    captureCheckIn: sentryMock.captureCheckIn,
    captureRequestError: sentryMock.captureRequestError
  };
});

const SENTRY_ENV_VARS = [
  "SENTRY_DSN",
  "NEXT_PUBLIC_SENTRY_DSN",
  "SENTRY_CRONS_ENABLED",
  "SENTRY_ORG",
  "SENTRY_PROJECT",
  "SENTRY_AUTH_TOKEN",
  "SENTRY_TRACES_SAMPLE_RATE"
] as const;

function clearSentryEnv() {
  for (const key of SENTRY_ENV_VARS) delete process.env[key];
}

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-sentry-inert-${randomUUID()}.db`)}`;
  clearSentryEnv();
});

afterEach(() => {
  clearSentryEnv();
  delete process.env.NEXT_RUNTIME;
  vi.clearAllMocks();
});

describe("sentry integration is inert without env vars", () => {
  it("instrumentation register() resolves without throwing (no NEXT_RUNTIME)", async () => {
    const { register } = await import("../instrumentation");
    await expect(register()).resolves.toBeUndefined();
    expect(sentryMock.imported).toBe(false);
  });

  it("instrumentation register() resolves without throwing on the edge runtime", async () => {
    process.env.NEXT_RUNTIME = "edge";
    const { register } = await import("../instrumentation");
    await expect(register()).resolves.toBeUndefined();
    expect(sentryMock.imported).toBe(false);
  });

  it("onRequestError is a no-op and never loads the SDK without SENTRY_DSN", async () => {
    const { onRequestError } = await import("../instrumentation");
    await expect(
      onRequestError(new Error("boom"), { path: "/x", method: "GET", headers: {} }, {
        routerKind: "App Router",
        routePath: "/x",
        routeType: "render"
      })
    ).resolves.toBeUndefined();
    expect(sentryMock.imported).toBe(false);
    expect(sentryMock.captureRequestError).not.toHaveBeenCalled();
  });

  it("scheduler module imports cleanly and reports default state without Sentry env", async () => {
    const scheduler = await import("../src/lib/scheduler");
    expect(scheduler.getSchedulerState("local")).toEqual({ lastRunAt: null, nextRunAt: null });
    // Boot interlock is DB-only and must work with zero Sentry configuration.
    await expect(scheduler.reconcileAutonomyOnBoot()).resolves.toBeUndefined();
    expect(sentryMock.imported).toBe(false);
  });

  it("scheduler cron check-in is a no-op without env vars", async () => {
    const { sendSentrySchedulerCheckIn } = await import("../src/lib/scheduler");
    await expect(sendSentrySchedulerCheckIn()).resolves.toBeUndefined();
    expect(sentryMock.imported).toBe(false);
    expect(sentryMock.captureCheckIn).not.toHaveBeenCalled();
  });

  it("scheduler cron check-in stays off when only ONE of the two gates is set", async () => {
    const { sendSentrySchedulerCheckIn } = await import("../src/lib/scheduler");

    process.env.SENTRY_DSN = "https://public@example.ingest.sentry.io/1";
    await sendSentrySchedulerCheckIn(); // SENTRY_CRONS_ENABLED missing
    expect(sentryMock.captureCheckIn).not.toHaveBeenCalled();

    clearSentryEnv();
    process.env.SENTRY_CRONS_ENABLED = "1";
    await sendSentrySchedulerCheckIn(); // SENTRY_DSN missing
    expect(sentryMock.captureCheckIn).not.toHaveBeenCalled();
    expect(sentryMock.imported).toBe(false);
  });

  // --- positive paths below: these DO import the (mocked) SDK; keep them last ---

  it("scheduler cron check-in fires with monitorSlug 'scheduler-tick' when both gates are set", async () => {
    const { sendSentrySchedulerCheckIn, SENTRY_CRON_MONITOR_SLUG } = await import("../src/lib/scheduler");
    process.env.SENTRY_DSN = "https://public@example.ingest.sentry.io/1";
    process.env.SENTRY_CRONS_ENABLED = "1";

    await expect(sendSentrySchedulerCheckIn()).resolves.toBe("check-in-id");
    expect(SENTRY_CRON_MONITOR_SLUG).toBe("scheduler-tick");
    expect(sentryMock.captureCheckIn).toHaveBeenCalledTimes(1);
    expect(sentryMock.captureCheckIn).toHaveBeenCalledWith(
      { monitorSlug: "scheduler-tick", status: "ok" },
      expect.objectContaining({ schedule: { type: "interval", value: 1, unit: "minute" } })
    );
  });

  it("scheduler cron check-in can open in_progress and close error with the same checkInId", async () => {
    const { sendSentrySchedulerCheckIn } = await import("../src/lib/scheduler");
    process.env.SENTRY_DSN = "https://public@example.ingest.sentry.io/1";
    process.env.SENTRY_CRONS_ENABLED = "1";

    await expect(sendSentrySchedulerCheckIn("in_progress")).resolves.toBe("check-in-id");
    await expect(sendSentrySchedulerCheckIn("error", "check-in-id")).resolves.toBe("check-in-id");
    expect(sentryMock.captureCheckIn).toHaveBeenNthCalledWith(
      1,
      { monitorSlug: "scheduler-tick", status: "in_progress" },
      expect.objectContaining({ maxRuntime: 10 })
    );
    expect(sentryMock.captureCheckIn).toHaveBeenNthCalledWith(
      2,
      { monitorSlug: "scheduler-tick", status: "error", checkInId: "check-in-id" },
      expect.objectContaining({ maxRuntime: 10 })
    );
  });

  it("scheduler cron check-in never throws even when the SDK call fails", async () => {
    const { sendSentrySchedulerCheckIn } = await import("../src/lib/scheduler");
    process.env.SENTRY_DSN = "https://public@example.ingest.sentry.io/1";
    process.env.SENTRY_CRONS_ENABLED = "1";
    sentryMock.captureCheckIn.mockImplementationOnce(() => {
      throw new Error("sentry exploded");
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(sendSentrySchedulerCheckIn()).resolves.toBeUndefined();
    consoleError.mockRestore();
  });

  it("onRequestError forwards to Sentry.captureRequestError when SENTRY_DSN is set", async () => {
    const { onRequestError } = await import("../instrumentation");
    process.env.SENTRY_DSN = "https://public@example.ingest.sentry.io/1";
    const err = new Error("boom");
    const request = { path: "/x", method: "GET", headers: {} };
    const context = { routerKind: "App Router", routePath: "/x", routeType: "render" };
    await onRequestError(err, request, context);
    expect(sentryMock.captureRequestError).toHaveBeenCalledTimes(1);
    expect(sentryMock.captureRequestError).toHaveBeenCalledWith(err, request, context);
  });
});
