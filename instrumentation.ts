// Next.js instrumentation hook - runs once at server startup.
// See: https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation

export async function onRequestError(...args: unknown[]) {
  if (process.env.SENTRY_DSN) {
    const Sentry = await import("@sentry/nextjs");
    Sentry.captureRequestError(...(args as Parameters<typeof Sentry.captureRequestError>));
  }
  if (process.env.NEXT_RUNTIME !== "edge") {
    try {
      const { datadogLogsEnabled } = await import("./src/lib/datadog-env");
      if (!datadogLogsEnabled()) return;
      const { emitDatadogRequestError } = await import("./src/lib/datadog-logs");
      const [error, request] = args;
      emitDatadogRequestError(error, request as { path?: string; method?: string } | undefined);
    } catch {
      // Datadog is optional telemetry and must never fail the request error hook.
    }
  }
}

export async function register() {
  if (typeof window !== "undefined") return;

  if (process.env.NEXT_RUNTIME === "edge") {
    if (process.env.SENTRY_DSN) {
      await import("./sentry.edge.config");
    }
    return;
  }

  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // next.config.mjs also sets this, but instrumentation is the guaranteed server-boot hook across
  // build modes/containers (the prod box moved to Coolify; the 2026-07-06 IPv6-blackhole fix — see
  // docs/rollouts/2026-07-06-api-health-timeouts.md — must hold there too). Run this FIRST, before
  // any other import below can trigger a network call. webpackIgnore: this file is also compiled for
  // the edge runtime above, and webpack has no "node:dns" handling for that target's bundle — the
  // comment keeps this a real runtime dynamic import instead of a build-time bundle attempt.
  const dns = await import(/* webpackIgnore: true */ "node:dns");
  dns.setDefaultResultOrder("ipv4first");

  // Process-exit receipts + the "no spontaneous exit 0" tripwire (production-gated;
  // no-op in dev/tests). Installed before anything below can exit or receive a stop
  // signal. See src/lib/exit-guard.ts and docs/rollouts/2026-08-02-exit0-outage-audit.md.
  const { installProcessExitGuard } = await import("./src/lib/exit-guard");
  installProcessExitGuard();

  // Fail fast if this deployment requires a secrets manager but wasn't launched through one
  // (REQUIRE_SECRETS_MANAGER set, but not started via start:secrets). Default off →
  // no effect on local dev / tests / CI. Runs before anything reads a credential.
  const { assertSecretsManagerIfRequired } = await import("./src/lib/secrets-source");
  assertSecretsManagerIfRequired();

  // Fail fast in PRODUCTION if ENCRYPTION_KEY is missing/malformed — a trading app must never
  // silently mint a per-process ephemeral encryption key (stored credentials would become
  // unreadable after every restart). No effect in dev/test (a deterministic warning fires there
  // instead — see db-api-keys.ts). Runs before anything reads/writes a credential.
  const { assertEncryptionKeyConfiguredInProduction } = await import("./src/lib/db-api-keys");
  assertEncryptionKeyConfiguredInProduction();

  const { assertAuthSecretConfiguredInLiveBootstrap } = await import("./src/lib/auth-secret-guard");
  assertAuthSecretConfiguredInLiveBootstrap();

  if (process.env.SENTRY_DSN) {
    await import("./sentry.server.config");
    try {
      const profilingPkg = "@sentry/profiling-node";
      const { nodeProfilingIntegration } = (await import(
        /* webpackIgnore: true */ profilingPkg
      )) as { nodeProfilingIntegration: () => any };
      const Sentry = await import("@sentry/nextjs");
      Sentry.addIntegration(nodeProfilingIntegration());
    } catch {
      // Native profiler is optional.  Missing binary must not take down Sentry.init.
    }
  }

  const { datadogApmEnabled, datadogLogsEnabled } = await import("./src/lib/datadog-env");
  if (datadogApmEnabled() || datadogLogsEnabled()) {
    const { startDatadogServer } = await import("./src/lib/datadog-server");
    await startDatadogServer();
  }

  // Migrate the operator's env broker/LLM keys into the `local` primary user's stores, so key
  // resolution is uniformly per-user (no special `local` env branch). Idempotent.
  const { migrateLocalEnvCredentials } = await import("./src/lib/db");
  migrateLocalEnvCredentials();
  const { migrateLocalRobinhoodToken } = await import("./src/lib/mcp-oauth");
  migrateLocalRobinhoodToken();

  // One-time, idempotent re-encryption of any legacy PLAINTEXT credential rows now that a real
  // (non-ephemeral) ENCRYPTION_KEY is confirmed available. No-ops silently when only the
  // per-process ephemeral fallback key is active (dev without ENCRYPTION_KEY set) — re-encrypting
  // under a throwaway key would make that data less recoverable, not more.
  const { migrateLegacyPlaintextCredentialsIfKeyConfigured } = await import("./src/lib/db-api-keys");
  migrateLegacyPlaintextCredentialsIfKeyConfigured();

  const { startObservability } = await import("./src/lib/observability");
  await startObservability();

  // Production keeps all process-level workers on by default. Local development and tests fail
  // closed unless DEV_BACKGROUND_WORKERS=on is explicit, preventing a UI-only dev server from
  // launching broker/provider/RAG work against a credentialed or copied database.
  const { startServerBackgroundWorkers } = await import("./src/lib/background-worker-startup");
  await startServerBackgroundWorkers();

  // Warm up Qdrant if configured and enabled for reads, so the first real retrieval doesn't block
  // on cold-cache fault-in.
  const { warmupQdrantHotTenants } = await import("./src/lib/vector-db");
  warmupQdrantHotTenants().catch(() => {});
}
