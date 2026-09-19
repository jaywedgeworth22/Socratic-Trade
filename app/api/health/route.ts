import { getInternalSetting, getServiceHealthSummaries, databasePath, resolveApiKeyWithSource, alertStorageWarning } from "@/lib/db";
import { isHardStoppedHealthSummary } from "@/lib/db-health";
import { isIntentionalOffHealthService } from "@/lib/retired-direct-vendors";
import { activeEmbeddingProvider } from "@/lib/vector-db";
import type { RagEmbedRerankProvider } from "@/lib/rag-metering";
import { qdrantConfigured, vectorReadBackend } from "@/lib/vector-store/qdrant-read";
import { vectorWriteBackend } from "@/lib/vector-store/qdrant-write";
import { getProviderTierStatus, isDataProvidersDegraded } from "@/lib/provider-tier";
import { lookupRegisteredPlanTier } from "@/lib/provider-tier-plan";
import { getLitestreamRemoteInventory } from "@/lib/litestream-remote-inventory";
import { getR2WeeklyHealthStatus } from "@/lib/r2-cold-snapshot";
import {
  assessLitestreamRuntimeHealth,
  assessLitestreamTierFreshness,
  defaultLitestreamRuntimeLogPath,
  defaultLitestreamStatePath,
  getLitestreamRuntimeHealth,
  LITESTREAM_PRODUCT_DISABLED_TIERS,
  runtimeReleaseIdentity,
  scanLitestreamRuntimeLogFile
} from "@/lib/runtime-health";
import { getLease } from "@/lib/scheduler-lease";
import { getTradingLivenessSummary, toPublicTradingLiveness } from "@/lib/trading-liveness";
import { getOpenRouterCreditStatus } from "@/lib/openrouter-credits";
import { authorizeOpsRequest } from "@/lib/ops-auth";
import { statSync, statfsSync } from "fs";
import { dirname } from "path";

export const dynamic = "force-dynamic";

/**
 * Drop the `<pid>:` prefix from a scheduler-lease owner (`${process.pid}:${randomUUID()}`, see
 * scheduler-lease.ts). The uuid half is what makes "did the leader change / is this the same
 * process?" answerable; the pid half is host detail an anonymous caller has no use for. Owners
 * written in some other format are returned untouched.
 */
function leaseOwnerWithoutPid(owner: string): string {
  return owner.replace(/^\d+:/, "");
}

// Rich public/ops probe — NOT the Coolify/Traefik backend probe.  Docker HEALTHCHECK
// and any Coolify HTTP health path must use GET /api/live.  A 503 here (critical
// Pinecone/RAG/Alpaca hard-stop) or a >5s response used to mark the named container
// running:unhealthy while Next was up; Traefik then had no healthy backend
// (2026-08-17 7:22-7:43pm CT after #2810).  UptimeRobot may still alert on this
// route.  This probes:
//   - DB reachability (the getInternalSetting read throws if SQLite is unwritable/locked), and
//   - scheduler liveness (age of the last tick heartbeat; stale ⇒ autonomy/stops aren't running).
// Returns 503 when a critical check fails so PM2/uptime tooling can act.
//
// TWO AUDIENCES. This route is in middleware's PUBLIC_PREFIXES, so everything it emits is
// world-readable — correct for the external uptime monitor that polls it and for the
// credential-less deploy-verify runbook (.claude/skills/deploy-verify/SKILL.md greps
// `.checks.db`, `.checks.schedulerAgeSeconds`, `.checks.storage.litestream*`). Three items are
// operator-only and are therefore gated on the SAME token as /api/ops/snapshot (`x-ops-token`,
// ops-auth.ts) rather than a second auth scheme:
//   - the OpenRouter prepaid balance in USD — publishing "the LLM budget is nearly exhausted"
//     hands an anonymous caller a precisely-timed, cheap window to drain what is (post-#1703
//     universal routing) the single point of failure for every LLM call and all RAG embedding,
//   - the host disk / SQLite byte counts — free capacity reconnaissance, and
//   - the raw scheduler-lease owner, which carries this container's OS pid.
// Gating is a PROJECTION only: `ok`, the 200/503 status, and every degraded flag are computed from
// the same values either way and are byte-identical between the two views. Do not fold any of this
// into the status logic — a spurious 503 restarts the container, which re-halts autonomy via the
// boot interlock (see the trading-liveness note below).
//
// Failure mode worth knowing: authorizeOpsRequest fails closed on an UNCONFIGURED secret — with
// OPS_DIAGNOSTIC_TOKEN unset it returns false for everyone, quietly, so the operator sees the
// public view too.  ADMIN_REINDEX_TOKEN is not a fallback.  That is the same condition that
// already makes /api/ops/snapshot unusable, so it is a token-provisioning problem, not a
// health-route one; the full lease owner is still on /api/ready (session-gated, no ops token
// needed) either way.
//
// External paging: HTTP 200/503 is liveness only (DB + pinecone / alpaca-broker hard-stops).
// schedulerStale, tradingLiveness.degraded, and storage.litestreamTiersDegraded are JSON flags
// that MUST stay 200 so a Coolify restart cannot "heal" them.  Page those with keyword/JSON
// monitors — see docs/runbooks/uptime-health-json-monitors.md.
export async function GET(request: Request) {
  const checks: Record<string, unknown> = {};
  let ok = true;
  const detailed = authorizeOpsRequest(request);

  const release = runtimeReleaseIdentity();
  checks.release = release;

  let lastTick: string | undefined;
  try {
    lastTick = getInternalSetting<string>("scheduler:lastTick"); // also proves the DB is reachable
    checks.db = "ok";
  } catch (error) {
    ok = false;
    checks.db = error instanceof Error ? error.message : "error";
  }

  const schedulerStaleMs = 5 * 60_000;
  if (lastTick) {
    const ageMs = Date.now() - new Date(lastTick).getTime();
    checks.schedulerLastTick = lastTick;
    checks.schedulerAgeSeconds = Math.round(ageMs / 1000);
    // Always emit the boolean so keyword/JSON monitors can key on `"schedulerStale":true`.
    // Never 503s — a restart cannot write a fresher tick if the scheduler is the thing that died.
    checks.schedulerStale = ageMs > schedulerStaleMs;
    if (checks.schedulerStale) {
      void alertStorageWarning("scheduler_stale", `Scheduler heartbeat is stale by ${Math.round(ageMs / 1000)} seconds.`);
    }
  } else {
    checks.schedulerLastTick = null;
    checks.schedulerAgeSeconds = null;
    // No heartbeat after the process has been up long enough to have ticked once.
    checks.schedulerStale = release.processUptimeSeconds > schedulerStaleMs / 1000;
    if (checks.schedulerStale) {
      void alertStorageWarning("scheduler_stale_boot", `Scheduler heartbeat is missing after ${release.processUptimeSeconds} seconds of uptime.`);
    }
  }

  // Scheduler lease state (additive; only meaningful when SCHEDULER_SINGLE_LEADER is on).
  // Surfaced here so ops tooling can confirm which process is the current leader and how old
  // the lease is. Never breaks the liveness probe.
  try {
    const lease = getLease();
    if (lease) {
      checks.schedulerLease = {
        owner: detailed ? lease.owner : leaseOwnerWithoutPid(lease.owner),
        acquiredAt: lease.acquiredAt,
        expiresAt: lease.expiresAt,
        ageSeconds: Math.round(lease.ageMs / 1000),
        expired: lease.expired
      };
    } else {
      checks.schedulerLease = null;
    }
  } catch {
    // never let lease reporting break the liveness probe
  }

  // Trading-liveness (handoff 6b.7): the heartbeat above proves the tick FUNCTION runs, not that
  // trading works — a scheduler that ticks while every run fails keeps this route green for hours.
  // Per active-autonomy account (policy.systemState === "active"), report the age of the most
  // recent COMPLETED strategy run and a consecutive-failed-runs count. `degraded`-only — NEVER
  // 503s (see trading-liveness.ts's header comment: a 503 here would trigger a container restart,
  // which re-halts autonomy via the boot interlock — the exact loop 6b.1 fixed). Always emitted
  // (zeros when there are no active-autonomy accounts) so JSON monitors can key the field.
  //
  // PUBLIC route (no requireAdmin): same convention as the dependencies section below — expose
  // ONLY a minimal aggregate, never the per-account rows. The full summary carries userId,
  // connectedAccountId, and a user-chosen label per account (plus run timestamps); those stay on
  // the authed ops snapshot (buildOpsSnapshot -> computeAccountTradingLiveness in
  // ops-snapshot.ts). Here we fold it down to counts + the oldest age, which is enough for an
  // external uptime probe without leaking account identity.
  try {
    const liveness = getTradingLivenessSummary();
    const publicLiveness = toPublicTradingLiveness(liveness);
    // Always emit so `tradingLiveness.degraded` exists for JSON-path monitors even when
    // every account is halted.  The boolean sibling is the unique keyword substring.
    checks.tradingLiveness = publicLiveness;
    checks.tradingLivenessDegraded = publicLiveness.degraded > 0;
    if (checks.tradingLivenessDegraded) {
      void alertStorageWarning("trading_liveness_degraded", `Trading liveness is degraded for ${publicLiveness.degraded} account(s).`);
    }
  } catch {
    checks.tradingLiveness = toPublicTradingLiveness(null);
    checks.tradingLivenessDegraded = false;
  }

  // Market-data tier honesty (nightly provider-tier check).  Surfaced so ops can see whether
  // Massive is answering at the plan Settings says we paid for.  A deliberate downgrade to
  // free or a lower paid SKU that MATCHES the configured plan is healthy — including Massive
  // `history_cap_blocked` on a ~2.5y window when the configured tier is Stocks Basic.  Degrade
  // only on a paid/expected mismatch or a probe failure.  Never 503s the liveness probe.
  try {
    const tiers = getProviderTierStatus();
    if (Object.keys(tiers).length > 0) {
      checks.dataProviders = tiers;
      const configuredPlans = {
        massive: lookupRegisteredPlanTier("massive"),
        fmp: lookupRegisteredPlanTier("fmp")
      };
      if (isDataProvidersDegraded(tiers, configuredPlans)) checks.dataProvidersDegraded = true;
    }
  } catch {
    // never let provider-tier reporting break the health probe
  }

  // Surface vector-store and embed-provider configuration status. After the Qdrant
  // cutover, "RAG configured" means the ACTIVE read backend is reachable plus the
  // active embed provider's key — a leftover Pinecone key is not required when
  // Qdrant is serving (PD #116 leftover: public health still advertised pineconeConfigured
  // and treated a missing Pinecone key as RAG-down).
  let ragEmbedProvider: RagEmbedRerankProvider | null = null;
  try {
    const pineconeKey = resolveApiKeyWithSource("pinecone");
    checks.pineconeConfigured = pineconeKey.source !== "none";
    checks.qdrantConfigured = qdrantConfigured();
    checks.ragVectorReadBackend = vectorReadBackend();
    checks.ragVectorWriteBackend = vectorWriteBackend();

    try {
      ragEmbedProvider = activeEmbeddingProvider();
      checks.ragEmbedProvider = ragEmbedProvider;
    } catch (error) {
      // RAG_EMBED_PROVIDER pinned to a keyless/invalid provider throws by design at embed time —
      // surface it here as a config problem without breaking the probe.
      checks.ragConfigured = false;
      checks.ragEmbedProviderError = error instanceof Error ? error.message : "invalid RAG embed provider";
    }
    if (ragEmbedProvider) {
      const activeKeyConfigured = resolveApiKeyWithSource(ragEmbedProvider, "local").source !== "none";
      const vectorStoreConfigured =
        checks.ragVectorReadBackend === "qdrant"
          ? checks.qdrantConfigured === true
          : pineconeKey.source !== "none";
      if (!vectorStoreConfigured || !activeKeyConfigured) {
        checks.ragConfigured = false;
      }
    }
  } catch {
    // do not break health check on key resolution
  }

  // Surface every backend dependency from health summaries.
  //
  // PUBLIC route (no requireAdmin): expose ONLY boolean/degraded status — never the raw
  // `lastFailureError` provider string (that detailed payload stays on the admin
  // connections-health route). A `degraded` flag captures the soft/cold-start case without
  // failing liveness; the detailed reason text is deliberately omitted here.
  try {
    const summaries = getServiceHealthSummaries();
    const dependencies: Record<string, { ok: boolean; degraded?: boolean }> = {};
    // Critical liveness is Alpaca plus the ACTIVE vector store. After the Qdrant
    // cutover Pinecone is leftover telemetry, not a 503 (PD #116). A hard-stopped
    // rag-embed/rag-rerank lane used to 503 this probe (bge-m3-metering-gate, 2026-07-18),
    // which Coolify treats as container death: restart -> boot interlock re-halts autonomy.
    // A dead embed cannot refill itself via restart, same as drained OpenRouter credits,
    // so those lanes DEGRADE only (ok=false + degraded=true). Retrieval already fail-opens;
    // ingest isolates per task. Still excluded from any 503 when RAG_EMBED_PROVIDER is
    // pinned-but-keyless (`ragEmbedProviderError` set).
    const criticalServices = new Set(["alpaca-broker"]);
    if (vectorReadBackend() !== "qdrant") criticalServices.add("pinecone");
    const softDegradeServices = new Set(["rag-embed", "rag-rerank"]);
    // Collapse (service, keySource) lanes to one entry per service. Prefer a CONFIGURED lane
    // (env/user) over a stale keySource:"none" lane so a service that later got a working key isn't
    // pinned failed forever by an old missing-key "none" lane (no future success is logged to "none").
    const configuredService = new Set<string>();
    for (const summary of summaries) {
      if (summary.intentionalOff || isIntentionalOffHealthService(summary.service)) continue;
      if (summary.keySource === "env" || summary.keySource === "user") configuredService.add(summary.service);
    }
    // Configured lanes that are NOT hard-stopped (env OR user). Critical liveness must not 503
    // when a user-stored broker key is healthy even if a stale env key is 401'ing — prod uses
    // Connections-page user keys for Alpaca; bad Infisical env credentials alone rolled back
    // every Coolify deploy (healthcheck requires HTTP 200 on /api/health).
    const configuredLaneHealthy = new Set<string>();
    for (const summary of summaries) {
      if (summary.intentionalOff || isIntentionalOffHealthService(summary.service)) continue;
      if (summary.keySource !== "env" && summary.keySource !== "user") continue;
      if (!isHardStoppedHealthSummary(summary)) configuredLaneHealthy.add(summary.service);
    }
    for (const summary of summaries) {
      // Retired vendors (FMP, Quiver, UW) keep historical failure rows. Public health must
      // not list them as live ok:false — that pages UptimeRobot / Pushover. FilingAPI is an
      // optional live lane: missing/401 keys are soft-stamped in db-health, not retired.
      if (summary.intentionalOff || isIntentionalOffHealthService(summary.service)) continue;
      const isGlobal = summary.keySource === "env" || summary.keySource === "none" || summary.keySource === null;
      if (!isGlobal) continue;
      // Ignore a stale "none"/null lane once the service has a real configured lane — otherwise it
      // would overwrite the healthy env lane and pin the service failed indefinitely.
      const isNoneLane = summary.keySource === "none" || summary.keySource === null;
      if (isNoneLane && configuredService.has(summary.service)) continue;

      // Only the HARD reason (>=5 consecutive failures) fails liveness. The SOFT heuristics
      // ("active this hour but no success yet") that a single cold-start 500 can trip mark the
      // service degraded but must NOT 503.
      const hardStopped = isHardStoppedHealthSummary(summary);
      const existing = dependencies[summary.service];
      // Prefer any healthy configured lane (including user keys not shown as "global" rows).
      const nextOk = !hardStopped || configuredLaneHealthy.has(summary.service);
      const nextDegraded =
        (summary.stoppedWorking && !hardStopped) ||
        (hardStopped && configuredLaneHealthy.has(summary.service)) ||
        (hardStopped && softDegradeServices.has(summary.service)) ||
        undefined;
      if (existing) {
        // Merge lanes for the same service: hard-stopped only wins when no configured lane is healthy.
        dependencies[summary.service] = {
          ok: (existing.ok && nextOk) || configuredLaneHealthy.has(summary.service),
          degraded: existing.degraded || nextDegraded || undefined
        };
      } else {
        dependencies[summary.service] = { ok: nextOk, degraded: nextDegraded || undefined };
      }

      // Hard-liveness deps: only app-unsafe/unusable dependencies 503 the public probe. Paid
      // market-data lanes (fmp/massive) degrade to Yahoo/others (the provider-tier section already
      // reports data-provider degradation), so they mark degraded but never fail liveness.
      //
      // rag-embed/rag-rerank (bge-m3-metering-gate 2026-07-18, lane rename 2026-07-19, soft-degrade
      // 2026-08-18): these two lanes are provider-generic and still REPORTED (ok=false + degraded)
      // when hard-stopped, but they never fail liveness. A 503 here restarts Docker and re-halts
      // Green/Red via the boot interlock — a restart cannot revive a dead embed provider.
      // Historical "voyage"/"voyage-rerank" rows stay informational, same as before.
      //
      // Env-lane hard-stop alone does NOT 503 when a user-keyed lane for the same service is
      // healthy (see configuredLaneHealthy) — otherwise bad Infisical env Alpaca keys block deploys
      // forever while trading still works through Connections user keys.
      const isCritical = criticalServices.has(summary.service);
      if (isCritical && hardStopped && !configuredLaneHealthy.has(summary.service)) {
        ok = false;
      }
    }
    checks.dependencies = dependencies;
  } catch {
    // never let connection health summaries break the health probe
  }

  // OpenRouter prepaid-credit balance. Universal routing (#1703) makes OpenRouter the single point
  // of failure for every LLM call AND all RAG embedding, so a drained balance = total decision-loop
  // outage (see docs/rollouts/2026-07-18-worktree-cleanup-voyage-rca.md). We surface the low-balance
  // SIGNAL on this PUBLIC probe so an EXTERNAL monitor (Uptime Robot) alerts when the money runs
  // low — a low balance sets dependencies.openrouter.ok=false (DEGRADE only; never 503, since a
  // restart can't refill credits and would just restart-loop). Cached + best-effort; a failed READ
  // never flips ok=false (see openrouter-credits.ts). Omitted entirely when no OpenRouter key is set.
  //
  // The USD FIGURES are operator-only (see the header comment) — the boolean is the alert, the
  // numbers are an attacker's countdown to a cheap total-outage window. `ok` MUST stay the first
  // serialized key of this object: the Uptime Robot keyword monitor matches the literal substring
  // `"openrouterCredits":{"ok":false` (docs/rollouts/2026-07-18-openrouter-credit-health-signal.md),
  // which is unchanged by this projection.
  try {
    // Bound the public probe.  A cache-miss credits fetch used to wait the
    // full 8s timeout and, stacked behind a busy scheduler tick, pushed
    // `/api/health` past UptimeRobot's 30s — pairing socratictrade.com
    // downtime with a false "OpenRouter credits low" on the same URL.
    const credits = await getOpenRouterCreditStatus(Date.now(), fetch, { maxWaitMs: 1_500 });
    if (credits) {
      const deps = (checks.dependencies ?? {}) as Record<string, { ok: boolean; degraded?: boolean }>;
      const existing = deps.openrouter;
      deps.openrouter = {
        ok: (existing ? existing.ok : true) && credits.ok,
        degraded: (existing?.degraded) || (credits.ok ? undefined : true)
      };
      checks.dependencies = deps;
      checks.openrouterCredits = {
        ok: credits.ok,
        ...(detailed
          ? { remainingUsd: credits.remainingUsd, totalUsd: credits.totalUsd, usedUsd: credits.usedUsd }
          : {}),
        thresholdUsd: credits.thresholdUsd,
        checkedAt: credits.checkedAt,
        ...(credits.error ? { error: credits.error } : {})
      };
    }
  } catch {
    // never let the credit check break the health probe
  }

  // Disk and database headroom check (purely advisory, never fails the health probe)
  try {
    const dbPath = databasePath();
    const walPath = `${dbPath}-wal`;
    const dbDir = dirname(dbPath);
    let latestLocalActivityAtMs = 0;

    let dbSizeBytes = 0;
    try {
      const dbStat = statSync(dbPath);
      dbSizeBytes = dbStat.size;
      latestLocalActivityAtMs = Math.max(latestLocalActivityAtMs, dbStat.mtimeMs);
    } catch {}

    let walSizeBytes = 0;
    try {
      const walStat = statSync(walPath);
      walSizeBytes = walStat.size;
      latestLocalActivityAtMs = Math.max(latestLocalActivityAtMs, walStat.mtimeMs);
    } catch {}

    let freeBytes = 0;
    let totalBytes = 0;
    try {
      const stats = statfsSync(dbDir);
      freeBytes = stats.bavail * stats.bsize;
      totalBytes = stats.blocks * stats.bsize;
    } catch {}

    const liveMode = process.env.DB_BOOTSTRAP === "live";
    const litestreamStatePath = process.env.LITESTREAM_STATE_PATH?.trim() || defaultLitestreamStatePath(dbPath);
    const freshness = await getLitestreamRuntimeHealth({
      dbPath,
      statePath: litestreamStatePath,
      // File metadata does not prove an R2 upload and may be expensive to scan. In live
      // mode the bounded IPC source is therefore the only accepted runtime signal.
      allowFileFallback: !liveMode
    });
    const litestreamAgeSeconds = freshness.state === "known" ? freshness.ageSeconds : null;
    const litestreamState = freshness.state;
    const litestreamAssessment = assessLitestreamRuntimeHealth(freshness, {
      liveMode,
      processUptimeSeconds: release.processUptimeSeconds,
      latestLocalActivityAtMs: latestLocalActivityAtMs || null
    });

    // Per-compaction-level freshness. This is the gap the IPC `/list` signal above cannot see:
    // it reports the database's overall last-sync time, which tracks level 0 and stays fresh
    // even while a higher compaction level is silently wedged — exactly what happened in
    // production on 2026-08-11 (level 1) and again on 2026-08-12 (level 2).
    //
    // Level 0 is read from local `ltx/0/` mtimes here and now. Levels 1/2/3/9 exist only in the
    // remote replica, so they are graded from the snapshot the scheduler collects every 30
    // minutes (src/lib/litestream-remote-inventory.ts) — this request performs NO S3/B2 calls
    // and spawns nothing. Levels with no snapshot report an explicit "not-observable" reason.
    const litestreamTiers = assessLitestreamTierFreshness(litestreamStatePath, {
      remoteInventory: getLitestreamRemoteInventory(),
      // L2/L3 are off in litestream.coolify.yml (single `levels:` entry = L1).
      // Leftover replica objects at those levels must not page as a wedge.
      disabledTiers: LITESTREAM_PRODUCT_DISABLED_TIERS
    });

    // A THIRD, independent signal: litestream's own log lines, captured to a local file by
    // scripts/coolify-prod-start.sh (it tees the `litestream replicate` process's combined
    // stdout/stderr so the app can read what litestream itself reports). Unlike the tier-freshness
    // check above, this needs no S3/B2 credentials and does not depend on the remote LTX inventory
    // — it still works even while every tier above reports "not-observable" (e.g. while the
    // separate remote-inventory scheduler-wiring bug leaves litestreamTiers blind). A non-empty
    // result here is direct evidence — litestream said "compaction failed" or "validation error
    // detected" recently — so, unlike a not-observable tier, it is a real alarm, not a coverage
    // gap: see the storageDegraded fold-in below.
    const litestreamRuntimeLogPath = process.env.LITESTREAM_RUNTIME_LOG_PATH?.trim()
      || defaultLitestreamRuntimeLogPath(dbPath);
    const litestreamCompactionLogFindings = scanLitestreamRuntimeLogFile(litestreamRuntimeLogPath);

    // Byte counts are operator-only (see the header comment); every litestream/backup-continuity
    // field below stays public because the credential-less deploy-verify runbook reads exactly
    // those, and `storageDegraded` (computed from the raw numbers, not from this object) keeps the
    // disk/WAL thresholds visible to an anonymous monitor without publishing the capacity itself.
    checks.storage = {
      ...(detailed ? { dbSizeBytes, walSizeBytes, freeBytes, totalBytes } : {}),
      litestreamAgeSeconds,
      litestreamState,
      litestreamStatus: freshness.state === "known" ? freshness.status : null,
      litestreamLastSyncAt: freshness.state === "known" ? freshness.lastSyncAt : null,
      litestreamTimestampState: freshness.state === "known" ? freshness.timestampState : null,
      litestreamSource: freshness.source,
      litestreamDegradedReasons: litestreamAssessment.reasons,
      litestreamTiers: litestreamTiers.tiers,
      // Deliberately NOT folded into `litestreamDegradedReasons` above: that array is typed
      // `LitestreamDegradationReason[]` and is produced solely by assessLitestreamRuntimeHealth
      // grading the IPC daemon signal. Tier verdicts are a different assessor with different
      // evidence, so they travel in their own flat, greppable pair — an external keyword monitor
      // can be pointed at `litestreamTiersDegraded` without either signal muddying the other.
      litestreamTiersDegraded: litestreamTiers.degraded,
      litestreamTierDegradedReasons: litestreamTiers.degradedReasons,
      // How much of the five-level breakdown is actually covered right now. Published so an
      // external monitor can distinguish "all five levels healthy" from "we can see one level
      // and are blind to four" — the state that silently held for a day before 2026-08-12.
      litestreamTierCoverage: {
        observed: litestreamTiers.observedTiers,
        notObservable: litestreamTiers.notObservableTiers,
        remoteInventoryState: litestreamTiers.remoteInventoryState,
        remoteInventoryCollectedAt: litestreamTiers.remoteInventoryCollectedAt
      },
      // Count only — the matched log lines themselves go to the (operator-only) alert, not this
      // world-readable body, since litestream's own error text could echo bucket/path detail.
      litestreamCompactionLogFailureCount: litestreamCompactionLogFindings.length,
      // Weekly R2 cold snapshot (second-provider DR). Local setting only — no R2 I/O on this
      // path. Public so Usage Monitor fleet backup (and humans) can see "R2 weekly is fine".
      // Deliberately NOT folded into storageDegraded / 503 (same contract as UM backup layers).
      r2Weekly: getR2WeeklyHealthStatus(),
    };

    // Thresholds:
    // Disk free space < 1 GB or WAL size > 500 MB or Litestream last-sync age > 1 hour (3600s)
    const diskLow = freeBytes > 0 && freeBytes < 1024 * 1024 * 1024;
    const walLarge = walSizeBytes > 500 * 1024 * 1024;

    if (diskLow || walLarge || litestreamAssessment.degraded || litestreamTiers.degraded || litestreamCompactionLogFindings.length > 0) {
      checks.storageDegraded = true;

      // Send a one-shot needs-attention notification/alert via the notifier if not sent recently
      if (diskLow) void alertStorageWarning("disk_space_low", `Free disk space is low: ${(freeBytes / 1024 / 1024).toFixed(2)} MB remaining.`);
      if (walLarge) void alertStorageWarning("wal_size_large", `SQLite WAL file size is large: ${(walSizeBytes / 1024 / 1024).toFixed(2)} MB.`);
      for (const reason of litestreamAssessment.reasons) {
        if (reason === "stale") {
          void alertStorageWarning("litestream_replication_stale", `Litestream WAL replication has not synced in ${Math.round((litestreamAgeSeconds ?? 0) / 60)} minutes.`);
        } else if (reason === "stopped") {
          void alertStorageWarning("litestream_replication_stopped", `Litestream reports replication status '${freshness.state === "known" ? freshness.status : "unknown"}'.`);
        } else if (reason === "never-synced") {
          void alertStorageWarning("litestream_replication_never_synced", "Litestream is running but has not reported a successful replica upload after the startup grace period.");
        } else if (reason === "file-unverified") {
          void alertStorageWarning("litestream_replication_unverified", "Only local Litestream metadata activity is visible in DB_BOOTSTRAP=live mode; successful R2 replication is not verified.");
        } else if (reason === "unavailable") {
          void alertStorageWarning("litestream_state_unreadable", "Litestream runtime status is unavailable in DB_BOOTSTRAP=live mode — replication freshness cannot be confirmed.");
        } else if (reason === "invalid-sync-time") {
          void alertStorageWarning("litestream_sync_time_invalid", "Litestream reported an invalid or materially future last-sync timestamp.");
        }
      }
      for (const tier of litestreamTiers.tiers) {
        if (tier.state === "known" && tier.degraded) {
          const where = tier.source === "local-ltx" ? "local LTX cache" : "remote replica";
          void alertStorageWarning(
            `litestream_tier_${tier.tier}_stale`,
            `Litestream "${tier.label}" (level ${tier.tier}) has not produced a new LTX file in the ${where} for ${Math.round(tier.ageSeconds / 60)} minutes (threshold ${Math.round(tier.thresholdSeconds / 60)} min), while level 0 kept advancing.`
          );
        } else if (tier.state === "empty" && tier.degraded) {
          // Distinct alert key from `_stale`: a level that holds NOTHING states a different fact
          // than one that stopped advancing, and the two should dedupe separately.
          void alertStorageWarning(
            `litestream_tier_${tier.tier}_empty_wedged`,
            `Litestream "${tier.label}" (level ${tier.tier}) holds zero objects in the remote replica.  ${tier.detail}`
          );
        }
      }
      if (litestreamCompactionLogFindings.length > 0) {
        const sample = litestreamCompactionLogFindings[0];
        void alertStorageWarning(
          "litestream_compaction_log_failure",
          `Litestream's own runtime log reports ${litestreamCompactionLogFindings.length} recent "${sample.marker}" line(s) — direct evidence a compaction or validation pass is failing, independent of the per-tier freshness check. Sample: ${sample.line}`
        );
      }
    }

    // Losing sight of a backup tier is not itself a backup failure, so it does NOT flip
    // storageDegraded — but in production it does mean the wedge detector is blind, which is
    // what went unnoticed for a day before 2026-08-12. Alert once, separately, and honestly.
    if (
      liveMode
      && litestreamTiers.notObservableTiers > 0
      && litestreamTiers.remoteInventoryState !== "ok"
      && litestreamTiers.remoteInventoryState !== "partial"
    ) {
      void alertStorageWarning(
        "litestream_tier_coverage_blind",
        `Litestream per-level backup monitoring is blind to ${litestreamTiers.notObservableTiers} of ${litestreamTiers.tiers.length} compaction levels (replica inventory: ${litestreamTiers.remoteInventoryState}). A wedged compaction at those levels would not be detected.`
      );
    }
  } catch {
    // never let storage monitoring break the health probe — still emit the monitor field
    if (!checks.storage || typeof checks.storage !== "object") {
      checks.storage = { litestreamTiersDegraded: false };
    } else if (!("litestreamTiersDegraded" in (checks.storage as object))) {
      (checks.storage as { litestreamTiersDegraded: boolean }).litestreamTiersDegraded = false;
    }
  }

  return Response.json({ ok, checks }, { status: ok ? 200 : 503 });
}
