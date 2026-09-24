import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/admin";
import {
  asRecord,
  normalizeCoolifyResources,
  normalizeHetznerServerResponse,
  readNonNegativeNumber,
  readPositiveNumber,
  readText,
} from "@/lib/server-metrics-shapes";
import { getActionRunners } from "@/lib/server-metrics-runners";
import {
  SERVER_METRICS_CACHE_TTL_MS,
  SERVER_METRICS_FAILURE_RETRY_MS,
  SERVER_METRICS_MAX_STALE_MS,
  serverMetricsRuntime,
  type ServerMetricsCacheEntry,
  type ServerMetricsConfigurationState,
  type ServerMetricsMetricValue,
  type ServerMetricsPayload,
  type ServerMetricsResourcesObservation,
  type ServerMetricsUnobservedHostFact,
} from "@/lib/server-metrics-runtime";
import os from "os";
import fs from "fs";

export const dynamic = "force-dynamic";

const MAX_PROVIDER_RESPONSE_BYTES = 512 * 1024;

interface RefreshResult {
  payload: ServerMetricsPayload;
  attemptedProviderReads: number;
  successfulProviderReads: number;
  hetznerMetricsReadFailed: boolean;
}

export async function GET(request: Request) {
  const denied = requireAdmin(request);
  if (denied) return denied;

  const configuration = readConfiguration();
  const isRuntimeProduction = process.env.NODE_ENV === "production";
  const isProd = readTargetEnvironment() === "production";
  const hasAnyProviderConfiguration = [
    configuration.hetznerToken,
    configuration.hetznerServerId,
    configuration.coolifyToken,
    configuration.coolifyServerUuid,
  ].some(Boolean);

  if (!isRuntimeProduction && !hasAnyProviderConfiguration) {
    return jsonResponse(await localPayload(configuration.states));
  }

  const cacheKey = [
    isProd ? "production" : "remote",
    configuration.states.hetzner,
    configuration.hetznerServerId ?? "",
    configuration.states.coolify,
    configuration.coolifyServerUuid ?? "",
  ].join(":");
  const now = Date.now();

  if (serverMetricsRuntime.remoteCache?.key === cacheKey && serverMetricsRuntime.remoteCache.expiresAt > now) {
    return jsonResponse(withCacheAge(serverMetricsRuntime.remoteCache.payload, now));
  }

  if (serverMetricsRuntime.remoteRefreshInFlight?.key !== cacheKey) {
    const previous = serverMetricsRuntime.remoteCache?.key === cacheKey
      ? serverMetricsRuntime.remoteCache
      : undefined;
    const promise = refreshRemoteMetrics(configuration, isProd, previous)
      .finally(() => {
        if (serverMetricsRuntime.remoteRefreshInFlight?.promise === promise) {
          serverMetricsRuntime.remoteRefreshInFlight = undefined;
        }
      });
    serverMetricsRuntime.remoteRefreshInFlight = { key: cacheKey, promise };
  }

  return jsonResponse(await serverMetricsRuntime.remoteRefreshInFlight!.promise);
}

function readConfiguration() {
  const hetznerToken = readText(process.env.HETZNER_API_TOKEN);
  const hetznerServerId = readText(process.env.HETZNER_SERVER_ID);
  // Prefer the read-only Coolify stats token. Never use COOLIFY_AGENTS (full deploy/admin)
  // for the website server-stats panel. COOLIFY_API_TOKEN is accepted only as a legacy
  // alias that Infisical should set to the same read-only value as COOLIFY_SERVER_STATS.
  const coolifyToken =
    readText(process.env.COOLIFY_SERVER_STATS) || readText(process.env.COOLIFY_API_TOKEN);
  const coolifyServerUuid = readText(process.env.COOLIFY_SERVER_UUID);

  return {
    hetznerToken,
    hetznerServerId,
    coolifyToken,
    coolifyServerUuid,
    states: {
      hetzner: configurationState(hetznerToken, hetznerServerId),
      coolify: configurationState(coolifyToken, coolifyServerUuid),
    },
  };
}

function readTargetEnvironment(): "production" | "remote" {
  return readText(process.env.SERVER_METRICS_TARGET_ENVIRONMENT)?.toLowerCase() === "production"
    ? "production"
    : "remote";
}

function configurationState(
  first: string | undefined,
  second: string | undefined,
): ServerMetricsConfigurationState {
  if (first && second) return "configured";
  if (first || second) return "partial";
  return "missing";
}

function getDiskStats(): { diskTotalBytes?: number; diskFreeBytes?: number; diskUsedBytes?: number; diskUsedPct?: number } {
  try {
    if (typeof fs.statfsSync === "function") {
      const stats = fs.statfsSync("/");
      const total = stats.bsize * stats.blocks;
      const free = stats.bsize * stats.bavail;
      const used = total - free;
      if (total > 0) {
        const pct = Math.round((used / total) * 100);
        return {
          diskTotalBytes: total,
          diskFreeBytes: free,
          diskUsedBytes: used,
          diskUsedPct: Math.max(0, Math.min(100, pct)),
        };
      }
    }
  } catch {
    /* statfs unavailable */
  }
  return {};
}

async function localPayload(
  configuration: ServerMetricsPayload["configuration"],
): Promise<ServerMetricsPayload> {
  return {
    isProd: false,
    usesLocalHost: true,
    degraded: false,
    stale: false,
    cacheAgeSeconds: 0,
    configuration,
    hostInfo: {
      name: os.hostname(),
      os: `${os.type()} ${os.release()} (${os.arch()})`,
      cpus: os.cpus().length,
      memoryTotalBytes: os.totalmem(),
      memoryFreeBytes: os.freemem(),
      uptimeSeconds: os.uptime(),
      loadAvg: os.loadavg(),
      ...getDiskStats(),
    },
    unobservedHostFacts: [],
    // Coolify is never queried on this path, so the empty list below is the ABSENCE of a
    // measurement, not a measurement of zero. The six invented "action-runner" rows that used
    // to live here described machines that never existed.
    resources: [],
    resourcesObservation: {
      state: "unavailable",
      reason: "coolify-not-configured",
      detail: "Coolify was not queried on this runtime, so the running services on this host "
        + "are unknown.  This is a local development runtime with no infrastructure "
        + "provider credentials configured.",
    },
    actionRunners: await getActionRunners(),
    metrics: emptyMetrics(),
    asOf: new Date().toISOString(),
  };
}

async function refreshRemoteMetrics(
  configuration: ReturnType<typeof readConfiguration>,
  isProd: boolean,
  previous: ServerMetricsCacheEntry | undefined,
): Promise<ServerMetricsPayload> {
  const refreshedAt = Date.now();
  const result = await loadRemoteMetrics(configuration, isProd, refreshedAt);

  if (
    previous
    && previous.discardAt > refreshedAt
    && result.attemptedProviderReads > 0
    && result.successfulProviderReads === 0
  ) {
    const failureWarnings = result.payload.warnings ?? [];
    const payload: ServerMetricsPayload = {
      ...previous.payload,
      degraded: true,
      stale: true,
      staleScope: "all",
      error: "Infrastructure providers are unavailable; showing the last successful snapshot.",
      warnings: uniqueStrings([
        ...(previous.payload.warnings ?? []),
        ...failureWarnings,
        "The displayed infrastructure snapshot is stale.",
      ]),
    };
    serverMetricsRuntime.remoteCache = {
      key: previous.key,
      payload,
      expiresAt: refreshedAt + SERVER_METRICS_FAILURE_RETRY_MS,
      discardAt: previous.discardAt,
    };
    return withCacheAge(payload, refreshedAt);
  }

  if (
    previous
    && previous.discardAt > refreshedAt
    && result.hetznerMetricsReadFailed
  ) {
    const payload: ServerMetricsPayload = {
      ...result.payload,
      metrics: previous.payload.metrics,
      asOf: previous.payload.asOf,
      degraded: true,
      stale: true,
      // Only the metric SERIES is stale here; host facts, services and runners in this payload
      // are current. One undifferentiated STALE chip made readers discount the fresh half too.
      staleScope: "metrics",
      error: "Hetzner metrics are unavailable; showing the last successful metric series.",
      warnings: uniqueStrings([
        ...(result.payload.warnings ?? []),
        "The displayed infrastructure metrics are stale.",
      ]),
    };
    serverMetricsRuntime.remoteCache = {
      key: previous.key,
      payload,
      expiresAt: refreshedAt + SERVER_METRICS_FAILURE_RETRY_MS,
      discardAt: previous.discardAt,
    };
    return withCacheAge(payload, refreshedAt);
  }

  const ttl = result.attemptedProviderReads > 0 && result.successfulProviderReads === 0
    ? SERVER_METRICS_FAILURE_RETRY_MS
    : SERVER_METRICS_CACHE_TTL_MS;
  serverMetricsRuntime.remoteCache = {
    key: [
      isProd ? "production" : "remote",
      configuration.states.hetzner,
      configuration.hetznerServerId ?? "",
      configuration.states.coolify,
      configuration.coolifyServerUuid ?? "",
    ].join(":"),
    payload: result.payload,
    expiresAt: refreshedAt + ttl,
    discardAt: refreshedAt + SERVER_METRICS_MAX_STALE_MS,
  };
  return result.payload;
}

async function loadRemoteMetrics(
  configuration: ReturnType<typeof readConfiguration>,
  isProd: boolean,
  refreshedAt: number,
): Promise<RefreshResult> {
  const warnings: string[] = [];
  const providerErrors: string[] = [];
  let attemptedProviderReads = 0;
  let successfulProviderReads = 0;
  let hetznerMetricsReadFailed = false;

  if (configuration.states.hetzner === "partial") {
    warnings.push("Hetzner configuration is incomplete; both API token and server ID are required.");
  } else if (configuration.states.hetzner === "missing") {
    warnings.push("Hetzner is not configured.");
  }
  if (configuration.states.coolify === "partial") {
    warnings.push("Coolify configuration is incomplete; both API token and server UUID are required.");
  } else if (configuration.states.coolify === "missing") {
    warnings.push("Coolify is not configured.");
  }

  let coolifyServerFetch: ProviderFetchResult = {};
  let coolifyResourcesFetch: ProviderFetchResult = {};
  if (
    configuration.states.coolify === "configured"
    && configuration.coolifyToken
    && configuration.coolifyServerUuid
  ) {
    const headers = {
      Authorization: `Bearer ${configuration.coolifyToken}`,
      "User-Agent": "Socratic-Trade infrastructure monitor",
      Accept: "application/json",
    };
    const serverUrl = `https://host.jays.services/api/v1/servers/${configuration.coolifyServerUuid}`;
    attemptedProviderReads += 2;
    [coolifyServerFetch, coolifyResourcesFetch] = await Promise.all([
      fetchProviderJson("Coolify server metadata", serverUrl, headers),
      fetchProviderJson("Coolify resources", `${serverUrl}/resources`, headers),
    ]);
    successfulProviderReads += Number(coolifyServerFetch.payload !== undefined);
    successfulProviderReads += Number(coolifyResourcesFetch.payload !== undefined);
  }

  let hetznerServerFetch: ProviderFetchResult = {};
  let hetznerMetricsFetch: ProviderFetchResult = {};
  if (
    configuration.states.hetzner === "configured"
    && configuration.hetznerToken
    && configuration.hetznerServerId
  ) {
    const headers = {
      Authorization: `Bearer ${configuration.hetznerToken}`,
      Accept: "application/json",
    };
    const serverUrl = `https://api.hetzner.cloud/v1/servers/${configuration.hetznerServerId}`;
    const start = new Date(refreshedAt - 60 * 60 * 1000).toISOString();
    const end = new Date(refreshedAt).toISOString();
    const metricsUrl = `${serverUrl}/metrics?type=cpu&type=disk&type=network&start=${start}&end=${end}`;
    attemptedProviderReads += 2;
    [hetznerServerFetch, hetznerMetricsFetch] = await Promise.all([
      fetchProviderJson("Hetzner server metadata", serverUrl, headers),
      fetchProviderJson("Hetzner metrics", metricsUrl, headers),
    ]);
    if (
      hetznerMetricsFetch.payload !== undefined
      && !asRecord(asRecord(asRecord(hetznerMetricsFetch.payload)?.metrics)?.time_series)
    ) {
      hetznerMetricsFetch = {
        error: "Hetzner metrics returned an invalid metrics envelope.",
      };
    }
    hetznerMetricsReadFailed = hetznerMetricsFetch.payload === undefined;
    successfulProviderReads += Number(hetznerServerFetch.payload !== undefined);
    successfulProviderReads += Number(hetznerMetricsFetch.payload !== undefined);
  }

  for (const error of [
    coolifyServerFetch.error,
    coolifyResourcesFetch.error,
    hetznerServerFetch.error,
    hetznerMetricsFetch.error,
  ]) {
    if (error) providerErrors.push(error);
  }

  const coolifyServer = asRecord(coolifyServerFetch.payload);
  const coolifyMeta = asRecord(coolifyServer?.server_metadata);
  const normalizedHetzner = hetznerServerFetch.payload === undefined
    ? { server: {}, warnings: [] as string[] }
    : normalizeHetznerServerResponse(hetznerServerFetch.payload);
  const normalizedResources = coolifyResourcesFetch.payload === undefined
    ? { resources: [], warnings: [] as string[] }
    : normalizeCoolifyResources(coolifyResourcesFetch.payload);
  const coreCount = normalizedHetzner.server.cpus ?? readPositiveNumber(coolifyMeta?.cpus);
  const rawTimeSeries = asRecord(asRecord(hetznerMetricsFetch.payload)?.metrics)?.time_series;
  const parsedMetrics = parseHetznerTimeSeries(rawTimeSeries, coreCount);

  warnings.push(
    ...providerErrors,
    ...normalizedHetzner.warnings,
    ...normalizedResources.warnings,
    ...parsedMetrics.warnings,
  );

  const actionRunners = await getActionRunners();

  const hostInfo = compactRecord({
    name: normalizedHetzner.server.name ?? coolifyHostName(coolifyServer),
    status: normalizedHetzner.server.status,
    os: readText(coolifyMeta?.os),
    cpus: coreCount,
    memoryTotalBytes: normalizedHetzner.server.memoryGb
      ? normalizedHetzner.server.memoryGb * 1024 * 1024 * 1024
      : readPositiveNumber(coolifyMeta?.memory_bytes),
    // Non-negative, not positive: 0 bytes free is an active OOM condition and must not be
    // laundered into "Utilization unavailable".
    memoryFreeBytes: readNonNegativeNumber(coolifyMeta?.memory_free_bytes),
    uptimeSeconds: readNonNegativeNumber(coolifyMeta?.uptime_seconds),
    serverType: normalizedHetzner.server.serverType,
    location: normalizedHetzner.server.location,
    ip: normalizedHetzner.server.ip,
  });
  if (!hostInfo.status) hostInfo.status = "unknown";

  const resourcesObservation = describeResourcesObservation(
    configuration.states.coolify,
    coolifyResourcesFetch.payload !== undefined,
  );

  const unobservedHostFacts = describeUnobservedHostFacts({
    coolifyState: configuration.states.coolify,
    coolifyRead: coolifyServerFetch.payload !== undefined,
    hostInfo,
  });

  const finalWarnings = uniqueStrings(warnings);
  // A runner read that FAILED is a provider error like any other. A runner read that was never
  // attempted because no token is configured is a known gap rendered in place, not a fault, so
  // it must not flip the header chip to DEGRADED forever.
  const runnersErrored = actionRunners.state === "unavailable"
    && actionRunners.reason !== "no-github-token";
  const degraded = finalWarnings.length > 0 || runnersErrored;
  return {
    attemptedProviderReads,
    successfulProviderReads,
    hetznerMetricsReadFailed,
    payload: {
      isProd,
      usesLocalHost: false,
      degraded,
      stale: false,
      cacheAgeSeconds: 0,
      configuration: configuration.states,
      monitoredTarget: compactRecord({
        hetznerServerId: configuration.hetznerServerId,
        coolifyServerUuid: configuration.coolifyServerUuid,
      }) as ServerMetricsPayload["monitoredTarget"],
      hostInfo,
      unobservedHostFacts,
      resources: normalizedResources.resources,
      resourcesObservation,
      actionRunners,
      metrics: parsedMetrics.metrics,
      asOf: new Date(refreshedAt).toISOString(),
      ...(providerErrors.length > 0
        ? { error: "One or more infrastructure providers could not be queried." }
        : {}),
      ...(finalWarnings.length > 0 ? { warnings: finalWarnings } : {}),
    },
  };
}

/**
 * Coolify's own host entry on this box is named `localhost` with ip `host.docker.internal`
 * (it is Coolify's self-reference, not a description of the monitored machine). Falling back to
 * it made a Hetzner-metadata outage render as "Host Server: localhost" on the production admin
 * panel — a plausible hostname standing in for a real failure.
 */
const COOLIFY_SELF_REFERENTIAL_HOST_NAMES = new Set(["localhost", "host.docker.internal"]);

function coolifyHostName(coolifyServer: Record<string, unknown> | undefined): string | undefined {
  const name = readText(coolifyServer?.name);
  if (!name || COOLIFY_SELF_REFERENTIAL_HOST_NAMES.has(name.toLowerCase())) return undefined;
  return name;
}

/**
 * Decide whether the service list is a measurement or the absence of one.
 *
 * An empty `resources` array is produced identically by "Coolify is not configured", "the
 * Coolify read failed" and "Coolify answered zero", and the card used to render all three as
 * the confident sentence "coolify reported no services for this server". Only the third case
 * is a measurement. The failed-read case is the one that matters: when Hetzner succeeds and
 * only this read fails, `successfulProviderReads > 0`, so neither stale-cache branch fires and
 * an otherwise fresh-looking page would assert an empty measurement it never took.
 */
function describeResourcesObservation(
  coolifyState: ServerMetricsConfigurationState,
  coolifyResourcesRead: boolean,
): ServerMetricsResourcesObservation {
  if (coolifyState === "missing") {
    return {
      state: "unavailable",
      reason: "coolify-not-configured",
      detail: "Coolify is not configured for this deployment, so no service list was "
        + "requested.  Coolify is the only source wired for running services and containers.",
    };
  }
  if (coolifyState === "partial") {
    return {
      state: "unavailable",
      reason: "coolify-partially-configured",
      detail: "Coolify configuration is incomplete, so no service list was requested.  Both "
        + "an API token and a server UUID are required before this panel will query it.",
    };
  }
  if (!coolifyResourcesRead) {
    return {
      state: "unavailable",
      reason: "coolify-request-failed",
      detail: "The Coolify resources endpoint could not be read on this refresh, so the "
        + "services running on this host are unknown.  The provider error is listed in the "
        + "warnings above.",
    };
  }
  return { state: "known" };
}

/**
 * Explain, per field, why a host fact this panel renders is blank.
 *
 * Memory utilization, uptime and OS come only from `coolifyServer.server_metadata`, which is
 * `null` on the current Hetzner box because Coolify metrics collection is disabled for that
 * server. Host filesystem capacity has no source at all on the remote path — Hetzner's `disk`
 * metric series is I/O bandwidth, not capacity. Both used to render as a bare "Unavailable",
 * which reads as an intermittent outage rather than a wiring gap.
 */
function describeUnobservedHostFacts(input: {
  coolifyState: ServerMetricsConfigurationState;
  coolifyRead: boolean;
  hostInfo: Record<string, unknown>;
}): ServerMetricsUnobservedHostFact[] {
  const facts: ServerMetricsUnobservedHostFact[] = [];

  const coolifyGap = (): { reason: ServerMetricsUnobservedHostFact["reason"]; why: string } => {
    if (input.coolifyState !== "configured") {
      return {
        reason: "coolify-not-configured",
        why: "Coolify is not fully configured for this deployment, and it is the only source "
          + "wired for this value.",
      };
    }
    if (!input.coolifyRead) {
      return {
        reason: "coolify-unavailable",
        why: "The Coolify server record could not be read on this refresh, and it is the only "
          + "source wired for this value.",
      };
    }
    return {
      reason: "coolify-server-metadata-absent",
      why: "Coolify returned no server metadata for this host, which is what happens when its "
        + "metrics collection is disabled for the server.",
    };
  };

  if (input.hostInfo.memoryFreeBytes === undefined) {
    const gap = coolifyGap();
    facts.push({
      field: "memoryUtilization",
      reason: gap.reason,
      detail: `Memory utilization is not measured.  ${gap.why}`,
    });
  }
  if (input.hostInfo.uptimeSeconds === undefined) {
    const gap = coolifyGap();
    facts.push({
      field: "uptime",
      reason: gap.reason,
      detail: `Host uptime is not measured.  ${gap.why}`,
    });
  }
  if (input.hostInfo.os === undefined) {
    const gap = coolifyGap();
    facts.push({
      field: "os",
      reason: gap.reason,
      detail: `The host operating system is not reported.  ${gap.why}`,
    });
  }
  facts.push({
    field: "diskCapacity",
    reason: "not-collected-by-providers",
    detail: "Host filesystem capacity is not collected by this panel.  Neither the Hetzner "
      + "server API nor Coolify reports used and free disk for this host, and Hetzner's disk "
      + "metric series measures I/O bandwidth rather than capacity.",
  });

  return facts;
}

function parseHetznerTimeSeries(timeSeries: unknown, coreCount: number | undefined): {
  metrics: Record<string, ServerMetricsMetricValue[]>;
  warnings: string[];
} {
  const series = asRecord(timeSeries) ?? {};
  let omittedSamples = 0;
  const result = emptyMetrics();

  const getValues = (key: string): ServerMetricsMetricValue[] => {
    const raw = asRecord(series[key])?.values;
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((item) => {
      if (!Array.isArray(item) || item.length < 2) {
        omittedSamples += 1;
        return [];
      }
      const timestamp = toFiniteMetricNumber(item[0]);
      const value = toFiniteMetricNumber(item[1]);
      if (timestamp === undefined || value === undefined) {
        omittedSamples += 1;
        return [];
      }
      return [{ timestamp, value }];
    });
  };

  const keys = Object.keys(series);
  const cpuKey = keys.find((key) => key.startsWith("cpu")) ?? "cpu";
  const diskReadKey = keys.find((key) => key.includes("bandwidth.read")) ?? "disk.0.bandwidth.read";
  const diskWriteKey = keys.find((key) => key.includes("bandwidth.write")) ?? "disk.0.bandwidth.write";
  const netRxKey = keys.find((key) => key.includes("bandwidth.in") || key.includes("bandwidth.rx"))
    ?? "network.0.bandwidth.in";
  const netTxKey = keys.find((key) => key.includes("bandwidth.out") || key.includes("bandwidth.tx"))
    ?? "network.0.bandwidth.out";

  const rawCpu = getValues(cpuKey);
  // UNVERIFIED TRANSFORM (flagged 2026-08-13, deliberately left unchanged).
  // Every Hetzner CPU sample is divided by the core count before being plotted against a fixed
  // yMax of 100. The only support for that is an uncited comment in Usage-Monitor claiming the
  // series is an aggregate across cores; Hetzner documents `type=cpu` as percent of server CPU
  // (0-100), which would make this an 8x under-report on this 8-core cx43 and keep the meter
  // green through a saturation incident. Settling it needs one live sample, which needs the
  // Hetzner token, so it was not guessed at here. See
  // docs/rollouts/2026-08-13-honest-server-stats.md; the current behaviour is pinned by
  // test/server-metrics.test.ts (raw 40, 4 cores, asserts 10).
  result.cpu = coreCount
    ? rawCpu.map((point) => ({ ...point, value: point.value / coreCount }))
    : [];
  result.diskRead = getValues(diskReadKey);
  result.diskWrite = getValues(diskWriteKey);
  result.networkRx = getValues(netRxKey);
  result.networkTx = getValues(netTxKey);

  const warnings: string[] = [];
  if (rawCpu.length > 0 && !coreCount) {
    warnings.push("Hetzner aggregate CPU metrics were omitted because the server core count was unavailable.");
  }
  if (omittedSamples > 0) {
    warnings.push(`Hetzner metrics contained ${omittedSamples} malformed samples that were omitted.`);
  }
  return { metrics: result, warnings };
}

interface ProviderFetchResult {
  payload?: unknown;
  error?: string;
}

async function fetchProviderJson(
  label: string,
  url: string,
  headers: Record<string, string>,
): Promise<ProviderFetchResult> {
  try {
    const response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return { error: `${label} returned HTTP ${response.status}.` };
    try {
      return { payload: await readBoundedJson(response, MAX_PROVIDER_RESPONSE_BYTES) };
    } catch {
      return { error: `${label} returned invalid or oversized JSON.` };
    }
  } catch {
    return { error: `${label} was unavailable.` };
  }
}

async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error("response_too_large");
  if (!response.body) throw new Error("empty_response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error("response_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

function toFiniteMetricNumber(value: unknown): number | undefined {
  if (typeof value !== "number" && typeof value !== "string") return undefined;
  if (typeof value === "string" && !value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function emptyMetrics(): Record<string, ServerMetricsMetricValue[]> {
  return {
    cpu: [],
    diskRead: [],
    diskWrite: [],
    networkRx: [],
    networkTx: [],
  };
}

function compactRecord(values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function withCacheAge(payload: ServerMetricsPayload, now: number): ServerMetricsPayload {
  const asOf = Date.parse(payload.asOf);
  // An unparseable timestamp means the age is genuinely unknown. Defaulting it to 0 presented
  // a snapshot of unknown age as brand new, and the client hid the age suffix entirely.
  if (!Number.isFinite(asOf)) {
    const withoutAge: ServerMetricsPayload = { ...payload };
    delete withoutAge.cacheAgeSeconds;
    return withoutAge;
  }
  return { ...payload, cacheAgeSeconds: Math.max(0, Math.floor((now - asOf) / 1000)) };
}

function jsonResponse(payload: ServerMetricsPayload) {
  return NextResponse.json(payload, {
    status: 200,
    headers: { "Cache-Control": "private, no-store" },
  });
}
