// Fail-closed Datadog APM preload.  Must load before Next.js so dd-trace can patch it.
// NODE_OPTIONS uses --import (not --require) so toolchain-policy stays intact.
import { createRequire } from "node:module";

function flagOff(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off";
}

/** APM-only container IDs mint extra Infrastructure Free host slots. */
const FLEET_DD_HOSTNAME = "fleet-hetzner-nbg1";

function onCoolify() {
  return Boolean(
    process.env.COOLIFY_RESOURCE_UUID ||
      process.env.COOLIFY_CONTAINER_NAME ||
      process.env.COOLIFY_FQDN ||
      process.env.COOLIFY_APP_NAME ||
      process.env.COOLIFY_URL
  );
}

function attachFleetHostname() {
  if (String(process.env.DD_HOSTNAME || "").trim()) return;
  if (!onCoolify()) return;
  process.env.DD_HOSTNAME = FLEET_DD_HOSTNAME;
}

try {
  if (flagOff(process.env.DD_TRACE_ENABLED) || flagOff(process.env.DD_APM_TRACING_ENABLED)) {
    // no-op
  } else {
    const apiKey = String(process.env.DD_API_KEY || process.env.DATADOG_API_KEY || "").trim();
    const agent = String(
      process.env.DD_AGENT_HOST ||
        process.env.DD_TRACE_AGENT_URL ||
        process.env.DD_TRACE_AGENT_HOSTNAME ||
        process.env.DD_TRACE_URL ||
        ""
    ).trim();
    if (apiKey || agent) {
      process.env.DD_SERVICE = process.env.DD_SERVICE || "socratic-trade";
      process.env.DD_SITE = process.env.DD_SITE || "us5.datadoghq.com";
      process.env.DD_ENV =
        process.env.DD_ENV || process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || "production";
      if (!process.env.DD_VERSION) {
        const version =
          process.env.SOURCE_COMMIT || process.env.COOLIFY_COMMIT_SHA || process.env.COOLIFY_COMMIT || "";
        if (version) process.env.DD_VERSION = version;
      }
      if (!process.env.DD_LOGS_INJECTION) process.env.DD_LOGS_INJECTION = "true";
      if (!process.env.DD_PROFILING_ENABLED) process.env.DD_PROFILING_ENABLED = "false";
      if (!process.env.DD_APPSEC_ENABLED) process.env.DD_APPSEC_ENABLED = "false";
      if (apiKey && !agent && !process.env.DD_TRACE_EXPERIMENTAL_EXPORTER) {
        process.env.DD_TRACE_EXPERIMENTAL_EXPORTER = "agentless";
      }
      // Host tag only.  dd-trace init `hostname` is the Agent address, not DD_HOSTNAME.
      attachFleetHostname();
      const sampleRate = Number(process.env.DD_TRACE_SAMPLE_RATE || "0.1");
      const require = createRequire(import.meta.url);
      require("dd-trace").init({
        logInjection: true,
        runtimeMetrics: true,
        profiling: false,
        appsec: false,
        startupLogs: false,
        sampleRate: Number.isFinite(sampleRate) ? sampleRate : 0.1
      });
    }
  }
} catch (error) {
  try {
    const message = error && error.message ? error.message : error;
    console.warn("[datadog] preload no-op:", message);
  } catch {
    // ignore
  }
}
