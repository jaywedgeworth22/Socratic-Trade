import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_DD_SERVICE,
  DEFAULT_DD_SITE,
  datadogApmEnabled,
  datadogLogsEnabled,
  datadogRumEnabled,
  resolveDatadogApiKey,
  resolveDatadogEnv,
  resolveDatadogSite,
  resolveLogsIntakeUrl,
  resolvePublicRumConfig,
  resolveTraceSampleRate,
  shouldUseAgentlessExporter
} from "../src/lib/datadog-env";

const DD_ENV_KEYS = [
  "DD_API_KEY",
  "DATADOG_API_KEY",
  "DD_SITE",
  "NEXT_PUBLIC_DD_SITE",
  "DD_SERVICE",
  "DD_ENV",
  "DD_VERSION",
  "DD_TRACE_ENABLED",
  "DD_APM_TRACING_ENABLED",
  "DD_AGENT_HOST",
  "DD_TRACE_AGENT_URL",
  "DD_TRACE_AGENT_HOSTNAME",
  "DD_TRACE_URL",
  "DD_TRACE_SAMPLE_RATE",
  "DD_TRACE_EXPERIMENTAL_EXPORTER",
  "DD_LOGS_ENABLED",
  "DD_LOGS_MIN_LEVEL",
  "NEXT_PUBLIC_DD_APPLICATION_ID",
  "NEXT_PUBLIC_DD_CLIENT_TOKEN",
  "NEXT_PUBLIC_DD_RUM_APPLICATION_ID",
  "NEXT_PUBLIC_DD_RUM_CLIENT_TOKEN",
  "NEXT_PUBLIC_DD_RUM_ENABLED",
  "NEXT_PUBLIC_DD_SESSION_SAMPLE_RATE",
  "NEXT_PUBLIC_DD_SESSION_REPLAY_ENABLED",
  "NEXT_PUBLIC_DD_SESSION_REPLAY_SAMPLE_RATE",
  "DD_RUM_ENABLED",
  "DD_HOSTNAME",
  "DD_APPLICATION_ID",
  "DD_CLIENT_TOKEN",
  "DD_RUM_APPLICATION_ID",
  "DD_RUM_CLIENT_TOKEN",
  "DD_SESSION_REPLAY_ENABLED"
] as const;

const saved = new Map<string, string | undefined>();

function clearDatadogEnv() {
  for (const key of DD_ENV_KEYS) delete process.env[key];
}

beforeEach(() => {
  saved.clear();
  for (const key of DD_ENV_KEYS) saved.set(key, process.env[key]);
  clearDatadogEnv();
});

afterEach(() => {
  clearDatadogEnv();
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("datadog env resolution", () => {
  it("defaults site and service to the existing us5 / socratic-trade account", () => {
    expect(resolveDatadogSite()).toBe(DEFAULT_DD_SITE);
    expect(DEFAULT_DD_SITE).toBe("us5.datadoghq.com");
    expect(DEFAULT_DD_SERVICE).toBe("socratic-trade");
  });

  it("canonicalizes Coolify DD_ENV=prod to production", () => {
    process.env.DD_ENV = "prod";
    expect(resolveDatadogEnv()).toBe("production");
  });

  it("is fail-closed without an API key or agent host", () => {
    expect(resolveDatadogApiKey()).toBeUndefined();
    expect(datadogApmEnabled()).toBe(false);
    expect(datadogLogsEnabled()).toBe(false);
    expect(datadogRumEnabled()).toBe(false);
    expect(resolvePublicRumConfig()).toBeNull();
    expect(shouldUseAgentlessExporter()).toBe(false);
  });

  it("accepts DATADOG_API_KEY as an alias of DD_API_KEY", () => {
    process.env.DATADOG_API_KEY = "dd-key-from-alias";
    expect(resolveDatadogApiKey()).toBe("dd-key-from-alias");
    expect(datadogApmEnabled()).toBe(true);
    expect(datadogLogsEnabled()).toBe(true);
    expect(shouldUseAgentlessExporter()).toBe(true);
  });

  it("uses the official us5 logs intake host when DD_SITE is unset", () => {
    expect(resolveLogsIntakeUrl()).toBe("https://http-intake.logs.us5.datadoghq.com/api/v2/logs");
  });

  it("honors explicit off flags even when a key is present", () => {
    process.env.DD_API_KEY = "present";
    process.env.DD_TRACE_ENABLED = "false";
    process.env.DD_LOGS_ENABLED = "0";
    expect(datadogApmEnabled()).toBe(false);
    expect(datadogLogsEnabled()).toBe(false);
  });

  it("enables APM from an agent host without an API key", () => {
    process.env.DD_AGENT_HOST = "172.17.0.1";
    expect(datadogApmEnabled()).toBe(true);
    expect(datadogLogsEnabled()).toBe(false);
    expect(shouldUseAgentlessExporter()).toBe(false);
  });

  it("clamps the APM sample rate and keeps replay off unless opted in", () => {
    process.env.DD_TRACE_SAMPLE_RATE = "2";
    expect(resolveTraceSampleRate()).toBe(1);
    process.env.NEXT_PUBLIC_DD_APPLICATION_ID = "app-id";
    process.env.NEXT_PUBLIC_DD_CLIENT_TOKEN = "pub-token";
    const rum = resolvePublicRumConfig();
    expect(rum).not.toBeNull();
    expect(rum?.sessionReplayEnabled).toBe(false);
    expect(rum?.sessionReplaySampleRate).toBe(0);
    expect(rum?.site).toBe(DEFAULT_DD_SITE);
  });

  it("enables RUM from server DD_* tokens unless DD_RUM_ENABLED is off", () => {
    process.env.DD_APPLICATION_ID = "app-id";
    process.env.DD_CLIENT_TOKEN = "pub-token";
    expect(datadogRumEnabled()).toBe(true);
    process.env.DD_RUM_ENABLED = "false";
    expect(datadogRumEnabled()).toBe(false);
    expect(resolvePublicRumConfig()).toBeNull();
  });

  it("turns RUM session replay on only when the existing opt-in flag is true", () => {
    process.env.NEXT_PUBLIC_DD_APPLICATION_ID = "app-id";
    process.env.NEXT_PUBLIC_DD_CLIENT_TOKEN = "pub-token";
    process.env.NEXT_PUBLIC_DD_SESSION_REPLAY_ENABLED = "true";
    process.env.NEXT_PUBLIC_DD_SESSION_REPLAY_SAMPLE_RATE = "20";
    const rum = resolvePublicRumConfig();
    expect(rum?.sessionReplayEnabled).toBe(true);
    expect(rum?.sessionReplaySampleRate).toBe(20);
  });
});
