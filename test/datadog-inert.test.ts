import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const ddTraceMock = vi.hoisted(() => ({
  imported: false,
  init: vi.fn()
}));

vi.mock("dd-trace", () => {
  ddTraceMock.imported = true;
  return {
    default: { init: ddTraceMock.init },
    init: ddTraceMock.init
  };
});

const DD_ENV_KEYS = [
  "DD_API_KEY",
  "DATADOG_API_KEY",
  "DD_TRACE_ENABLED",
  "DD_APM_TRACING_ENABLED",
  "DD_AGENT_HOST",
  "DD_TRACE_AGENT_URL",
  "DD_TRACE_AGENT_HOSTNAME",
  "DD_TRACE_URL",
  "DD_LOGS_ENABLED",
  "NEXT_PUBLIC_DD_APPLICATION_ID",
  "NEXT_PUBLIC_DD_CLIENT_TOKEN",
  "SENTRY_DSN"
] as const;

function clearDatadogEnv() {
  for (const key of DD_ENV_KEYS) delete process.env[key];
}

beforeAll(() => {
  clearDatadogEnv();
});

afterEach(() => {
  clearDatadogEnv();
  delete process.env.NEXT_RUNTIME;
  globalThis.__tradingDatadogApmStarted = undefined;
  globalThis._ddtrace = undefined;
  vi.clearAllMocks();
  ddTraceMock.imported = false;
});

describe("datadog integration is inert without env vars", () => {
  it("instrumentation register() does not load dd-trace without keys", async () => {
    const { register } = await import("../instrumentation");
    await expect(register()).resolves.toBeUndefined();
    expect(ddTraceMock.imported).toBe(false);
    expect(ddTraceMock.init).not.toHaveBeenCalled();
  });

  it("startDatadogServer is a no-op without keys and does not load dd-trace", async () => {
    const { startDatadogServer } = await import("../src/lib/datadog-server");
    await expect(startDatadogServer()).resolves.toBeUndefined();
    expect(ddTraceMock.imported).toBe(false);
    expect(ddTraceMock.init).not.toHaveBeenCalled();
  });

  it("instrumentation register() stays inert on the edge runtime", async () => {
    process.env.NEXT_RUNTIME = "edge";
    process.env.DD_API_KEY = "should-not-load-on-edge";
    const { register } = await import("../instrumentation");
    await expect(register()).resolves.toBeUndefined();
    expect(ddTraceMock.imported).toBe(false);
  });

  it("onRequestError is a no-op without DD_API_KEY and never loads dd-trace", async () => {
    const { onRequestError } = await import("../instrumentation");
    await expect(
      onRequestError(new Error("boom"), { path: "/x", method: "GET", headers: {} }, {
        routerKind: "App Router",
        routePath: "/x",
        routeType: "render"
      })
    ).resolves.toBeUndefined();
    expect(ddTraceMock.imported).toBe(false);
  });

  it("preload script exits 0 without keys and does not need dd-trace", () => {
    const result = spawnSync(process.execPath, ["scripts/datadog-preload.mjs"], {
      encoding: "utf8",
      env: {
        ...process.env,
        DD_API_KEY: "",
        DATADOG_API_KEY: "",
        DD_AGENT_HOST: "",
        DD_TRACE_AGENT_URL: "",
        DD_TRACE_AGENT_HOSTNAME: "",
        DD_TRACE_URL: ""
      }
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("preload attaches Coolify traces to fleet-hetzner-nbg1 via DD_HOSTNAME, not init hostname", () => {
    const source = readFileSync("scripts/datadog-preload.mjs", "utf8");
    expect(source).toContain("fleet-hetzner-nbg1");
    expect(source).toContain("attachFleetHostname");
    expect(source).toContain("DD_HOSTNAME");
    expect(source).toContain("Host tag only");
  });

  it("coolify-prod-start arms Datadog via --import and never --require", () => {
    const source = readFileSync("scripts/coolify-prod-start.sh", "utf8");
    expect(source).toContain("maybe_arm_datadog");
    expect(source).toContain("--import ./scripts/datadog-preload.mjs");
    expect(source).not.toMatch(/--require(?:=|\s)/);
    expect(source).toContain("Datadog APM preload skipped (no DD_API_KEY / agent host)");
  });
});
