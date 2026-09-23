export const SERVER_METRICS_CACHE_TTL_MS = 120_000;
export const SERVER_METRICS_FAILURE_RETRY_MS = 30_000;
export const SERVER_METRICS_MAX_STALE_MS = 10 * 60_000;

export interface ServerMetricsMetricValue {
  timestamp: number;
  value: number;
}

export type ServerMetricsConfigurationState = "configured" | "partial" | "missing";

/**
 * Why the GitHub Actions runner list could not be read.
 *
 * This panel used to answer every one of these cases with the SAME hardcoded array of six
 * invented runners pinned to "running:healthy" — five of them attributed to `ci-cpx32`, a CI
 * box deleted 2026-07-31. No GitHub token has ever been set in the Socratic-Trade production
 * environment, so production took that branch on 100% of requests and the panel reported six
 * machines that do not exist as healthy. Modelled on `LitestreamTierUnobservableReason` in
 * src/lib/runtime-health.ts: a bare "unknown" reads as "we checked and found nothing", so
 * every unobservable result names the specific credential or HTTP status that blocked it.
 */
export type ServerMetricsRunnerUnavailableReason =
  | "no-github-token"
  | "github-api-error"
  | "unexpected-shape"
  | "request-failed";

/**
 * One registered self-hosted runner, reported exactly as GitHub reports it.
 *
 * `status` carries GitHub's own reachability word ("online" / "offline") verbatim. GitHub does
 * not run a health check on a runner, so this panel must never translate that into a
 * "running:healthy" style health verdict — the previous code did, which made a wedged runner
 * indistinguishable from a working one.
 */
export interface ServerMetricsActionRunner {
  id: string;
  name: string;
  status: string;
  busy: boolean | null;
  labels: string[];
}

export type ServerMetricsActionRunners =
  | { state: "known"; repo: string; runners: ServerMetricsActionRunner[]; omittedCount: number }
  | {
      state: "unavailable";
      repo: string;
      reason: ServerMetricsRunnerUnavailableReason;
      detail: string;
    };

/** Host facts this panel renders that the configured providers did not supply. */
export type ServerMetricsUnobservedHostField =
  | "memoryUtilization"
  | "uptime"
  | "os"
  | "diskCapacity";

export type ServerMetricsUnobservedHostReason =
  | "coolify-not-configured"
  | "coolify-unavailable"
  | "coolify-server-metadata-absent"
  | "not-collected-by-providers";

/**
 * A field the panel deliberately leaves blank, plus the reason it is blank.
 *
 * These are rendered in place of the value they replace rather than in the warning banner: a
 * permanently-present banner trains the reader to ignore it, while "Unavailable" with no
 * explanation reads as an intermittent outage. Naming the cause next to the empty value is
 * the difference between "the panel is broken" and "this provider does not report this".
 */
export interface ServerMetricsUnobservedHostFact {
  field: ServerMetricsUnobservedHostField;
  reason: ServerMetricsUnobservedHostReason;
  detail: string;
}

/** Why the Coolify service/container list could not be read. */
export type ServerMetricsResourcesUnavailableReason =
  | "coolify-not-configured"
  | "coolify-partially-configured"
  | "coolify-request-failed";

/**
 * Whether the service list in this payload is a MEASUREMENT or the absence of one.
 *
 * `resources: []` is ambiguous on its own and was being rendered as the flat claim "coolify
 * reported no services for this server" in all three of these cases:
 *   1. Coolify was never queried because it is not configured for this deployment,
 *   2. Coolify was queried and the read failed (HTTP error / unreachable), and
 *   3. Coolify answered, and the answer really was zero.
 * Only case 3 justifies that sentence. Case 2 is the dangerous one: when the Hetzner reads
 * succeed and only the Coolify resources read fails, neither stale-cache branch fires, so the
 * page renders a fresh-looking snapshot whose Services card asserts a measurement that never
 * happened — exactly the failure an operator opens this panel to catch. Same shape as
 * `ServerMetricsActionRunners` and `assessLitestreamTierFreshness` in src/lib/runtime-health.ts.
 */
export type ServerMetricsResourcesObservation =
  | { state: "known" }
  | {
      state: "unavailable";
      reason: ServerMetricsResourcesUnavailableReason;
      detail: string;
    };

/** Which half of a stale payload is actually stale. */
export type ServerMetricsStaleScope = "all" | "metrics";

export interface ServerMetricsPayload {
  isProd: boolean;
  usesLocalHost: boolean;
  degraded: boolean;
  stale: boolean;
  /**
   * Age of the snapshot in seconds, or absent when `asOf` could not be parsed. Never defaults
   * to 0 — a snapshot of unknown age must not render as brand new.
   */
  cacheAgeSeconds?: number;
  staleScope?: ServerMetricsStaleScope;
  configuration: {
    hetzner: ServerMetricsConfigurationState;
    coolify: ServerMetricsConfigurationState;
  };
  /** The identifiers actually queried, so the PRODUCTION chip is checkable rather than trusted. */
  monitoredTarget?: {
    hetznerServerId?: string;
    coolifyServerUuid?: string;
  };
  hostInfo: Record<string, unknown>;
  unobservedHostFacts: ServerMetricsUnobservedHostFact[];
  /** Coolify applications and services only. Action runners are a separate, separately-sourced list. */
  resources: unknown[];
  /** Whether `resources` is a measurement at all. Never infer "zero services" from `[]` alone. */
  resourcesObservation: ServerMetricsResourcesObservation;
  actionRunners: ServerMetricsActionRunners;
  metrics: Record<string, ServerMetricsMetricValue[]>;
  asOf: string;
  error?: string;
  warnings?: string[];
}

export interface ServerMetricsCacheEntry {
  key: string;
  payload: ServerMetricsPayload;
  expiresAt: number;
  discardAt: number;
}

interface ServerMetricsRefreshInFlight {
  key: string;
  promise: Promise<ServerMetricsPayload>;
}

/** One process-local cache shared by the admin route. */
export const serverMetricsRuntime: {
  remoteCache?: ServerMetricsCacheEntry;
  remoteRefreshInFlight?: ServerMetricsRefreshInFlight;
} = {};

/** Test-only reset; route modules may export only route handlers/configuration in Next 16. */
export function resetServerMetricsCacheForTests(): void {
  serverMetricsRuntime.remoteCache = undefined;
  serverMetricsRuntime.remoteRefreshInFlight = undefined;
}
