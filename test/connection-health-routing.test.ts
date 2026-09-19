import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Use an isolated temp SQLite database per test file
beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `connection-health-routing-${randomUUID()}.db`)}`;
});

// The health route takes the Request so it can gate operator-only detail on `x-ops-token`
// (see app/api/health/route.ts). Every case below exercises the ANONYMOUS view — the liveness
// signal, degraded flags, and 200/503 status asserted here are identical in both views.
const anonymousHealthRequest = () => new Request("http://localhost/api/health");

async function load() {
  const db = await import("../src/lib/db");
  const health = await import("../src/lib/db-health");
  const notifyMod = await import("../src/lib/notify");
  const notificationsMod = await import("../src/lib/notifications");
  const healthRoute = await import("../app/api/health/route");
  return { db, health, notifyMod, notificationsMod, healthRoute };
}

describe("Connection Health & Failure Routing", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    // Stub environment variables for Resend/Notifications
    process.env.PRIMARY_USER_EMAIL = "admin@socratic.trade";
    process.env.RESEND_API_KEY = "re_test_key";
    process.env.NOTIFY_EMAIL_FROM = "alerts@socratic.trade";
    delete process.env.PUSHOVER_APP_TOKEN;
    delete process.env.PUSHOVER_ST_API_TOKEN;
    delete process.env.PUSHOVER_USER_KEY;
    
    // Clear out cooldown keys from DB
    const { db } = await load();
    db.getDb().prepare("DELETE FROM settings").run();
    db.getDb().prepare("DELETE FROM api_health_log").run();
    db.getDb().prepare("DELETE FROM notification_prefs").run();
    db.getDb().prepare("DELETE FROM notification_events").run();
    db.getDb().prepare("DELETE FROM audit_events").run();
  });

  afterEach(async () => {
    delete process.env.PRIMARY_USER_EMAIL;
    delete process.env.RESEND_API_KEY;
    delete process.env.NOTIFY_EMAIL_FROM;
    delete process.env.DB_BOOTSTRAP;
    delete process.env.LITESTREAM_SOCKET_PATH;
    delete process.env.LITESTREAM_STATE_PATH;
    delete process.env.LITESTREAM_RUNTIME_LOG_PATH;
    delete process.env.RAG_EMBED_PROVIDER;
    // Remove provider keys seeded by the provider-aware rag-embed criticality tests so
    // activeEmbeddingProvider() does not leak across cases.
    try {
      const { db } = await load();
      db.deleteUserApiKey("local", "openrouter");
      db.deleteUserApiKey("local", "siliconflow");
      db.deleteUserApiKey("local", "voyage");
    } catch { /* best-effort */ }
    vi.unstubAllGlobals();
  });

  it("routes a global connection failure to admin email fallback & Sentry", async () => {
    const { health, notifyMod, notificationsMod } = await load();

    // Mock notify & sendNotification
    const notifySpy = vi.spyOn(notifyMod, "notify").mockResolvedValue([]);
    const sendNotificationSpy = vi.spyOn(notificationsMod, "sendNotification").mockResolvedValue({} as any);

    // Call global failure alert (keySource: "env")
    await health.alertConnectionFailure("pinecone", "env", "u_tenant", "API Key Invalid");

    // No delivery happens outside sendNotification's enabled-event gate. The lazy fallback callback
    // is passed alongside the normal direct bridge and invoked by sendNotification after gating.
    expect(notifySpy).not.toHaveBeenCalled();
    expect(sendNotificationSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "provider_degraded",
        title: "pinecone connection failed"
      }),
      expect.objectContaining({
        userId: "local",
        directBody: expect.stringContaining("API Key Invalid"),
        additionalDelivery: expect.any(Function)
      })
    );
    const options = sendNotificationSpy.mock.calls[0]?.[1];
    await options?.additionalDelivery?.();
    expect(notifySpy).toHaveBeenCalledOnce();
    expect(notifySpy).toHaveBeenCalledWith(
      "local",
      expect.objectContaining({ title: "pinecone connection failed", body: expect.stringContaining("API Key Invalid") }),
      expect.objectContaining({ prefs: expect.objectContaining({ email: "admin@socratic.trade", channels: ["email"] }) })
    );
  });

  it("routes a user connection failure to user notifications only (no fallback email)", async () => {
    const { health, notifyMod, notificationsMod } = await load();

    const notifySpy = vi.spyOn(notifyMod, "notify").mockResolvedValue([]);
    const sendNotificationSpy = vi.spyOn(notificationsMod, "sendNotification").mockResolvedValue({} as any);

    // Call user failure alert (keySource: "user")
    await health.alertConnectionFailure("pinecone", "user", "u_tenant", "User Key Expired");

    // User delivery is also centralized inside the gate; there is no operator fallback callback.
    expect(notifySpy).not.toHaveBeenCalled();
    expect(sendNotificationSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "provider_degraded",
        title: "pinecone connection failed"
      }),
      expect.objectContaining({
        userId: "u_tenant",
        directBody: expect.stringContaining("User Key Expired")
      })
    );
    expect(sendNotificationSpy.mock.calls[0]?.[1]?.additionalDelivery).toBeUndefined();
  });

  it("does not add a Pushover fallback when the user already enabled that channel", async () => {
    const { db, health, notifyMod, notificationsMod } = await load();
    process.env.PUSHOVER_APP_TOKEN = "pv-token";
    process.env.PUSHOVER_USER_KEY = "u1userkey";
    db.setNotifyPrefs("local", { channels: ["pushover"], pushoverTarget: "u1userkey" });
    const notifySpy = vi.spyOn(notifyMod, "notify").mockResolvedValue([]);
    const sendNotificationSpy = vi.spyOn(notificationsMod, "sendNotification").mockResolvedValue({} as any);

    await health.alertConnectionFailure("pinecone", "env", "u_tenant", "API Key Invalid");

    expect(notifySpy).not.toHaveBeenCalled();
    expect(sendNotificationSpy).toHaveBeenCalledOnce();
    expect(sendNotificationSpy.mock.calls[0]?.[1]?.additionalDelivery).toBeUndefined();
    delete process.env.PUSHOVER_APP_TOKEN;
    delete process.env.PUSHOVER_USER_KEY;
  });

  it("does not add the operator fallback when a preferred email target already exists", async () => {
    const { db, health, notifyMod, notificationsMod } = await load();
    db.setNotifyPrefs("local", { channels: ["email"], email: "preferred@socratic.trade" });
    const notifySpy = vi.spyOn(notifyMod, "notify").mockResolvedValue([]);
    const sendNotificationSpy = vi.spyOn(notificationsMod, "sendNotification").mockResolvedValue({} as any);

    await health.alertConnectionFailure("finnhub", "env", null, "Provider unavailable");

    expect(notifySpy).not.toHaveBeenCalled();
    expect(sendNotificationSpy).toHaveBeenCalledOnce();
    expect(sendNotificationSpy.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        userId: "local",
        directBody: expect.stringContaining("Provider unavailable"),
        notifyDeps: expect.objectContaining({ config: expect.any(Object) })
      })
    );
    expect(sendNotificationSpy.mock.calls[0]?.[1]?.additionalDelivery).toBeUndefined();
  });

  it("records a storage-warning fallback delivery as sent without a duplicate", async () => {
    const { db, health } = await load();
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        calls.push(String(url));
        return new Response("ok", { status: 200 });
      })
    );

    await health.alertStorageWarning("disk_space", "Persistent volume is nearly full");

    expect(calls).toEqual(["https://api.resend.com/emails"]);
    const eventAuditRow = db
      .getDb()
      .prepare("SELECT payload FROM audit_events WHERE kind = 'notification' ORDER BY created_at DESC LIMIT 1")
      .get() as { payload: string } | undefined;
    expect(JSON.parse(eventAuditRow?.payload ?? "{}")).toMatchObject({ title: "Storage Warning: disk space", status: "sent" });
    const delivery = db
      .getDb()
      .prepare("SELECT payload FROM audit_events WHERE kind = 'notification.delivery' ORDER BY created_at DESC LIMIT 1")
      .get() as { payload: string } | undefined;
    expect(JSON.parse(delivery?.payload ?? "{}")).toMatchObject({
      notificationEventId: JSON.parse(eventAuditRow?.payload ?? "{}").id,
      status: "sent",
      results: [{ channel: "email", ok: true }]
    });
  });

  it("/api/health returns 200 when dependencies are healthy", async () => {
    const { healthRoute, db } = await load();
    
    // Seed some successful health logs
    db.logApiHealth({ service: "pinecone", ok: true, keySource: "env" });
    db.logApiHealth({ service: "rag-embed", ok: true, keySource: "env" });

    // Seed lastTick so scheduler is not stale
    db.setInternalSetting("scheduler:lastTick", new Date().toISOString());

    const response = await healthRoute.GET(anonymousHealthRequest());
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.checks.dependencies.pinecone.ok).toBe(true);
    expect(body.checks.dependencies["rag-embed"].ok).toBe(true);
  });

  it("/api/health does not flip dataProvidersDegraded on a matching free Massive plan", async () => {
    const { healthRoute, db } = await load();
    const { registerPlanTierLookupForTests } = await import("../src/lib/provider-tier-plan");
    db.setInternalSetting("scheduler:lastTick", new Date().toISOString());
    db.setInternalSetting("providerTier:status:local", {
      massive: {
        tier: "free",
        at: new Date().toISOString(),
        reason: "plan-access probe: ~2.5y blocked",
        signal: "history_cap_blocked"
      }
    });
    registerPlanTierLookupForTests((service) => (service === "massive" ? "free" : null));
    try {
      const response = await healthRoute.GET(anonymousHealthRequest());
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.checks.dataProviders.massive.tier).toBe("free");
      expect(body.checks.dataProvidersDegraded).toBeUndefined();
    } finally {
      registerPlanTierLookupForTests((service) => db.getUserApiKey("local", service)?.planTier ?? null);
    }
  });

  it("/api/health degrades when a paid Massive plan is history-capped or the probe fails", async () => {
    const { healthRoute, db } = await load();
    const { registerPlanTierLookupForTests } = await import("../src/lib/provider-tier-plan");
    db.setInternalSetting("scheduler:lastTick", new Date().toISOString());
    registerPlanTierLookupForTests((service) => (service === "massive" ? "starter" : null));
    try {
      db.setInternalSetting("providerTier:status:local", {
        massive: {
          tier: "free",
          at: new Date().toISOString(),
          reason: "plan-access probe: ~2.5y blocked HTTP 403",
          signal: "history_cap_blocked"
        }
      });
      let body = await (await healthRoute.GET(anonymousHealthRequest())).json();
      expect(body.ok).toBe(true);
      expect(body.checks.dataProvidersDegraded).toBe(true);

      db.setInternalSetting("providerTier:status:local", {
        massive: {
          tier: "unknown",
          at: new Date().toISOString(),
          reason: "recent probe network/timeout error",
          signal: "probe_error"
        }
      });
      body = await (await healthRoute.GET(anonymousHealthRequest())).json();
      expect(body.ok).toBe(true);
      expect(body.checks.dataProvidersDegraded).toBe(true);
    } finally {
      registerPlanTierLookupForTests((service) => db.getUserApiKey("local", service)?.planTier ?? null);
    }
  });

  it("/api/health returns 503 when a critical global dependency fails, but stays 200 for user failures", async () => {
    const { healthRoute, db } = await load();

    // Seed lastTick
    db.setInternalSetting("scheduler:lastTick", new Date().toISOString());

    // 1. Seed user failures (should not fail the global health check)
    for (let i = 0; i < 5; i++) {
      db.logApiHealth({ service: "pinecone", ok: false, errorText: "Bad Key", keySource: "user", userId: "u_tenant" });
    }

    let response = await healthRoute.GET(anonymousHealthRequest());
    expect(response.status).toBe(200); // Stays 200!
    let body = await response.json();
    expect(body.ok).toBe(true);

    // 2. Seed global/env failures for critical Pinecone (should fail the health check)
    for (let i = 0; i < 5; i++) {
      db.logApiHealth({ service: "pinecone", ok: false, errorText: "Global Error", keySource: "env" });
    }

    response = await healthRoute.GET(anonymousHealthRequest());
    expect(response.status).toBe(503); // Fails!
    body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.checks.dependencies.pinecone.ok).toBe(false);
  });

  it("/api/health stays 200 when Pinecone is hard-stopped but Qdrant is the read backend", async () => {
    process.env.QDRANT_URL = "http://127.0.0.1:6333";
    process.env.QDRANT_API_KEY = "test-qdrant-key";
    try {
      const { healthRoute, db } = await load();
      db.setInternalSetting("scheduler:lastTick", new Date().toISOString());
      for (let i = 0; i < 5; i++) {
        db.logApiHealth({ service: "pinecone", ok: false, errorText: "fetch failed", keySource: "env" });
      }
      const response = await healthRoute.GET(anonymousHealthRequest());
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.ok).toBe(true);
      expect(body.checks.qdrantConfigured).toBe(true);
      expect(body.checks.ragVectorReadBackend).toBe("qdrant");
      expect(body.checks.ragVectorWriteBackend).toBe("qdrant");
    } finally {
      delete process.env.QDRANT_URL;
      delete process.env.QDRANT_API_KEY;
    }
  });

  it("/api/health stays 200 when env lane hard-stops but a user-keyed lane for the same critical service is healthy", async () => {
    // Prod failure mode 2026-08-05: Infisical env Alpaca keys 401 (env lane hard-stopped) while
    // Connections user keys succeed — Coolify healthcheck required HTTP 200 and rolled every deploy.
    const { healthRoute, db } = await load();
    db.setInternalSetting("scheduler:lastTick", new Date().toISOString());

    for (let i = 0; i < 5; i++) {
      db.logApiHealth({
        service: "alpaca-broker",
        ok: false,
        errorText: "Request failed with status code 401",
        keySource: "env"
      });
    }
    for (let i = 0; i < 3; i++) {
      db.logApiHealth({
        service: "alpaca-broker",
        ok: true,
        latencyMs: 50,
        keySource: "user",
        userId: "local"
      });
    }

    const response = await healthRoute.GET(anonymousHealthRequest());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.checks.dependencies["alpaca-broker"].ok).toBe(true);
    // Env hard-stop is still visible as degraded so operators know the Infisical key is bad.
    expect(body.checks.dependencies["alpaca-broker"].degraded).toBe(true);
  });

  // rag-embed/rag-rerank (bge-m3-metering-gate 2026-07-18; lane rename 2026-07-19; soft-degrade
  // 2026-08-18). The lanes stay provider-generic and are still REPORTED, but they must NEVER 503
  // Docker: a restart cannot revive a dead embed and re-halts Green/Red via the boot interlock.
  // pinecone + alpaca-broker remain the only critical liveness deps.
  it("/api/health degrades a hard-stopped rag-embed/rag-rerank lane without 503 when OpenRouter is the active embed provider", async () => {
    const { healthRoute, db } = await load();

    db.setInternalSetting("scheduler:lastTick", new Date().toISOString());
    db.upsertUserApiKey("local", "openrouter", "or-test-key");

    for (let i = 0; i < 5; i++) {
      db.logApiHealth({ service: "rag-embed", ok: false, errorText: "OpenRouter down", keySource: "env" });
      db.logApiHealth({ service: "rag-rerank", ok: false, errorText: "OpenRouter down", keySource: "env" });
    }

    const response = await healthRoute.GET(anonymousHealthRequest());
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.checks.ragEmbedProvider).toBe("openrouter");
    expect(body.checks.dependencies["rag-embed"].ok).toBe(false);
    expect(body.checks.dependencies["rag-embed"].degraded).toBe(true);
    expect(body.checks.dependencies["rag-rerank"].ok).toBe(false);
    expect(body.checks.dependencies["rag-rerank"].degraded).toBe(true);
  });

  it("/api/health degrades a hard-stopped rag-embed lane without 503 when Voyage IS the active embed provider", async () => {
    const { healthRoute, db } = await load();

    db.setInternalSetting("scheduler:lastTick", new Date().toISOString());
    // Pin Voyage so a leftover env siliconflow/openrouter key cannot steal the lane.
    delete process.env.SILICONFLOW_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    try {
      db.deleteUserApiKey("local", "openrouter");
      db.deleteUserApiKey("local", "siliconflow");
    } catch { /* best-effort */ }
    db.upsertUserApiKey("local", "voyage", "voyage-test-key");
    process.env.RAG_EMBED_PROVIDER = "voyage";

    for (let i = 0; i < 5; i++) {
      db.logApiHealth({ service: "rag-embed", ok: false, errorText: "Voyage down", keySource: "env" });
    }

    const response = await healthRoute.GET(anonymousHealthRequest());
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.checks.ragEmbedProvider).toBe("voyage");
    expect(body.checks.dependencies["rag-embed"].ok).toBe(false);
    expect(body.checks.dependencies["rag-embed"].degraded).toBe(true);
  });

  it("/api/health still 503s on a hard-stopped pinecone lane (critical) even when rag-embed is also dead", async () => {
    const { healthRoute, db } = await load();

    db.setInternalSetting("scheduler:lastTick", new Date().toISOString());
    db.upsertUserApiKey("local", "openrouter", "or-test-key");

    for (let i = 0; i < 5; i++) {
      db.logApiHealth({ service: "pinecone", ok: false, errorText: "Pinecone down", keySource: "env" });
      db.logApiHealth({ service: "rag-embed", ok: false, errorText: "OpenRouter down", keySource: "env" });
    }

    const response = await healthRoute.GET(anonymousHealthRequest());
    expect(response.status).toBe(503);

    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.checks.dependencies.pinecone.ok).toBe(false);
    expect(body.checks.dependencies["rag-embed"].ok).toBe(false);
    expect(body.checks.dependencies["rag-embed"].degraded).toBe(true);
  });

  it("/api/health does not fail liveness on a hard-stopped legacy 'voyage' lane (pre-rename/back-compat rows are no longer critical)", async () => {
    const { healthRoute, db } = await load();

    db.setInternalSetting("scheduler:lastTick", new Date().toISOString());

    // The literal "voyage" service name is no longer written by withRagApiHealth's embed/rerank
    // call sites (see vector-db.ts), but recordMissingRagKey's missing-API-key path and historical
    // rows still use it — it must not gate liveness now that rag-embed/rag-rerank are the real lanes.
    for (let i = 0; i < 5; i++) {
      db.logApiHealth({ service: "voyage", ok: false, errorText: "Voyage down", keySource: "env" });
    }

    const response = await healthRoute.GET(anonymousHealthRequest());
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.ok).toBe(true);
    // Still REPORTED (visibility unaffected), just not in criticalServices.
    expect(body.checks.dependencies.voyage.ok).toBe(false);
  });

  it("/api/health survives a pinned-but-keyless RAG_EMBED_PROVIDER (reports the config error, no 503 loop)", async () => {
    const { healthRoute, db } = await load();

    db.setInternalSetting("scheduler:lastTick", new Date().toISOString());
    process.env.RAG_EMBED_PROVIDER = "openrouter"; // pinned, but no openrouter key configured

    // Even with a hard-stopped rag-embed lane, the pin misconfiguration must not 503 the container
    // into a restart loop — it is surfaced as ragEmbedProviderError/ragConfigured:false instead.
    for (let i = 0; i < 5; i++) {
      db.logApiHealth({ service: "rag-embed", ok: false, errorText: "Voyage down", keySource: "env" });
    }

    const response = await healthRoute.GET(anonymousHealthRequest());
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.checks.ragConfigured).toBe(false);
    expect(String(body.checks.ragEmbedProviderError)).toMatch(/RAG_EMBED_PROVIDER/);
  });

  it("/api/health remains 200 but lists degraded status for non-critical global dependencies", async () => {
    const { healthRoute, db } = await load();

    db.setInternalSetting("scheduler:lastTick", new Date().toISOString());

    // Seed global failures for non-critical "apify"
    for (let i = 0; i < 5; i++) {
      db.logApiHealth({ service: "apify", ok: false, errorText: "Global Error", keySource: "env" });
    }

    const response = await healthRoute.GET(anonymousHealthRequest());
    expect(response.status).toBe(200); // Stays 200 because apify is not critical

    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.checks.dependencies.apify.ok).toBe(false);
  });

  it("/api/health stays 200 when FilingAPI 401s (optional lane, soft skip)", async () => {
    const { healthRoute, db } = await load();

    db.setInternalSetting("scheduler:lastTick", new Date().toISOString());
    for (let i = 0; i < 5; i++) {
      db.logApiHealth({ service: "filingapi", ok: false, errorText: "Invalid API key", keySource: "env" });
    }

    const response = await healthRoute.GET(anonymousHealthRequest());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    // Optional lane: 401s are soft, so public health is ok (possibly degraded), never 503.
    const filing = body.checks.dependencies.filingapi;
    expect(filing).toBeDefined();
    expect(filing.ok).toBe(true);
  });

  it("/api/health reports the live recovery path degraded when Litestream cannot be observed", async () => {
    const { healthRoute, db } = await load();

    db.setInternalSetting("scheduler:lastTick", new Date().toISOString());
    process.env.DB_BOOTSTRAP = "live";
    process.env.LITESTREAM_SOCKET_PATH = join(tmpdir(), `missing-litestream-${randomUUID()}.sock`);
    process.env.LITESTREAM_STATE_PATH = join(tmpdir(), `missing-litestream-${randomUUID()}`);

    const response = await healthRoute.GET(anonymousHealthRequest());
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.checks.storage).toMatchObject({
      litestreamState: "unknown",
      litestreamSource: "none",
      litestreamDegradedReasons: ["unavailable"]
    });
    expect(body.checks.storageDegraded).toBe(true);
  });

  // The gap this exists to close: the pre-existing litestream* fields above only ever reflect
  // level 0 (continuous sync), so a stuck level-1 compactor left production silently unmonitored
  // for 27+ hours on 2026-08-11 (docs/rollouts/2026-08-09-event-loop-stall-instrumentation.md) —
  // level 0 kept succeeding the whole time. This reproduces that exact shape against the real
  // route: a fresh level-0 file (so the OLD signal stays non-degraded) alongside a stale
  // level-1 file, and asserts the NEW checks.storage.litestreamTiers field is what actually
  // flags it, and that it alone is sufficient to flip storageDegraded.
  it("/api/health flags a stuck level-1 compactor via litestreamTiers even while the pre-existing litestream* fields stay non-degraded", async () => {
    const { healthRoute, db } = await load();
    db.setInternalSetting("scheduler:lastTick", new Date().toISOString());

    const stateRoot = mkdtempSync(join(tmpdir(), "health-route-litestream-tiers-"));
    try {
      const writeTierFile = (tier: "0" | "1" | "9", mtime: Date) => {
        const dir = join(stateRoot, "ltx", tier);
        mkdirSync(dir, { recursive: true });
        const file = join(dir, `${tier}.ltx`);
        writeFileSync(file, "ltx");
        utimesSync(file, mtime, mtime);
      };
      const now = new Date();
      writeTierFile("0", new Date(now.getTime() - 30_000)); // 30s old — healthy
      writeTierFile("1", new Date(now.getTime() - 27 * 3_600_000)); // 27h old — wedged
      // No socket is listening and DB_BOOTSTRAP is not "live", so the pre-existing signal falls
      // back to a whole-tree file scan (source: "file") — its newest mtime is level 0's, which
      // is fresh, so the OLD mechanism stays non-degraded (see the "file signal diagnostic-only"
      // unit test in runtime-health.test.ts). Only the new per-tier field should catch level 1.
      process.env.LITESTREAM_SOCKET_PATH = join(stateRoot, "missing.sock");
      process.env.LITESTREAM_STATE_PATH = stateRoot;

      const response = await healthRoute.GET(anonymousHealthRequest());
      expect(response.status).toBe(200);
      const body = await response.json();

      expect(body.checks.storage.litestreamDegradedReasons).toEqual([]);
      expect(body.checks.storage.litestreamTiers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ tier: "0", state: "known", degraded: false }),
          expect.objectContaining({ tier: "1", state: "known", degraded: true }),
          // No local level-9 directory and no replica inventory in this test process: the
          // route must say it CANNOT see the level, not imply it looked and found nothing.
          expect.objectContaining({ tier: "9", state: "not-observable", reason: "remote-inventory-missing" })
        ])
      );
      expect(body.checks.storageDegraded).toBe(true);
    } finally {
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  // 2026-09-01 product: L2/L3 are off.  The 2026-08-14 empty-L2 wedge is still covered
  // in runtime-health.test.ts with disabledTiers: [].  The public route must not page
  // leftover empty L2/L3 as a wedge, or the next deploy would 200-with-storageDegraded
  // forever after we stop compacting those levels.
  it("/api/health does not page empty L2/L3 when those levels are product-disabled", async () => {
    const { healthRoute, db } = await load();
    db.setInternalSetting("scheduler:lastTick", new Date().toISOString());

    const inventoryMod = await import("../src/lib/litestream-remote-inventory");
    const stateRoot = mkdtempSync(join(tmpdir(), "health-route-empty-wedge-"));
    try {
      const now = Date.now();
      const dir = join(stateRoot, "ltx", "0");
      mkdirSync(dir, { recursive: true });
      const file = join(dir, "00000000000468d8-00000000000468d8.ltx");
      writeFileSync(file, "ltx");
      const fresh = new Date(now - 30_000);
      utimesSync(file, fresh, fresh);
      process.env.LITESTREAM_SOCKET_PATH = join(stateRoot, "missing.sock");
      process.env.LITESTREAM_STATE_PATH = stateRoot;

      // Persisted via durable_state, exactly as the scheduler writes it, so the route's own
      // module instance reads the same row (see PR #2683 — the module-level cache never
      // reached the route handlers).
      inventoryMod.setLitestreamRemoteInventoryCache({
        collectedAt: new Date(now - 4 * 60_000).toISOString(),
        status: "ok",
        levels: {
          "1": { level: 1, newestAt: new Date(now - 4 * 60_000).toISOString(), newestTxid: "00000000000468d8", fileCount: 2032 },
          "2": { level: 2, newestAt: "", newestTxid: null, fileCount: 0 },
          "3": { level: 3, newestAt: "", newestTxid: null, fileCount: 0 },
          "9": { level: 9, newestAt: new Date(now - 3.8 * 3_600_000).toISOString(), newestTxid: "0000000000043200", fileCount: 2 }
        },
        levelErrors: {},
        skippedReason: null
      });

      const response = await healthRoute.GET(anonymousHealthRequest());
      // A backup-compaction wedge is NOT a reason to 503: the route's own header comment records
      // that a spurious 503 restarts the container, and a restart cannot clear a wedged B2
      // compaction — the root cause is the rolling deploy's double-writer window, so restart
      // loops would deepen the damage.
      expect(response.status).toBe(200);
      const body = await response.json();

      // The pre-existing daemon-level signal stays silent, exactly as it did in production.
      expect(body.checks.storage.litestreamDegradedReasons).toEqual([]);
      expect(body.checks.storage.litestreamTiers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ tier: "1", state: "known", degraded: false }),
          expect.objectContaining({
            tier: "2",
            state: "empty",
            verdict: "expected",
            reason: "product-disabled",
            degraded: false
          }),
          expect.objectContaining({
            tier: "3",
            state: "empty",
            verdict: "expected",
            reason: "product-disabled",
            degraded: false
          }),
          expect.objectContaining({ tier: "9", state: "known", degraded: false })
        ])
      );
      expect(body.checks.storage.litestreamTiersDegraded).toBe(false);
      expect(body.checks.storage.litestreamTierDegradedReasons).toEqual([]);
      expect(body.checks.storageDegraded).toBeFalsy();
      // Five levels listed, five observed: an empty disabled level is still measured.
      expect(body.checks.storage.litestreamTierCoverage).toMatchObject({ observed: 5, notObservable: 0 });
    } finally {
      inventoryMod.setLitestreamRemoteInventoryCache(null);
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  // A THIRD, independent signal (2026-08-13): litestream's own log lines, teed to a local file
  // by scripts/coolify-prod-start.sh and scanned by src/lib/runtime-health.ts's
  // scanLitestreamRuntimeLogFile. This is deliberately independent of BOTH mechanisms above — it
  // needs no S3/B2 credentials and does not read the remote LTX inventory
  // (src/lib/litestream-remote-inventory.ts), so it still catches a wedge even while every tier
  // above reports "not-observable" (the shape production is actually in right now: the
  // remote-inventory scheduler has a separate known bug that leaves it permanently "missing").
  it("/api/health flags a wedged compactor from litestream's own teed log even when the tier system is fully blind", async () => {
    const { healthRoute, db } = await load();
    db.setInternalSetting("scheduler:lastTick", new Date().toISOString());
    process.env.PRIMARY_USER_EMAIL = "admin@socratic.trade";

    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        calls.push(String(url));
        return new Response("ok", { status: 200 });
      })
    );

    const logPath = join(tmpdir(), `litestream-runtime-${randomUUID()}.log`);
    writeFileSync(
      logPath,
      [
        'time=2026-08-08T14:35:12Z level=INFO msg="starting compaction monitor" level=2 interval=5m0s',
        'time=2026-08-08T14:40:12Z level=ERROR msg="compaction failed" level=2 error="write ltx file: extract timestamp from LTX header: non-contiguous transaction ids"'
      ].join("\n")
    );
    process.env.LITESTREAM_RUNTIME_LOG_PATH = logPath;
    // No socket, no state dir, no remote inventory in this test process: the pre-existing
    // litestream* fields AND the per-tier breakdown are both blind here, on purpose — proving
    // the log-based signal alone is what catches this.
    process.env.LITESTREAM_SOCKET_PATH = join(tmpdir(), `missing-litestream-${randomUUID()}.sock`);
    process.env.LITESTREAM_STATE_PATH = join(tmpdir(), `missing-litestream-${randomUUID()}`);

    try {
      const response = await healthRoute.GET(anonymousHealthRequest());
      expect(response.status).toBe(200);
      const body = await response.json();

      // Both pre-existing mechanisms are blind in this test process (no socket, no state dir, no
      // remote inventory) — the whole point of this test is that the log-based signal below is
      // what catches it, not either of these.
      expect(body.checks.storage.litestreamDegradedReasons).toEqual([]);
      expect(
        body.checks.storage.litestreamTiers.every((t: { state: string }) => t.state === "not-observable")
      ).toBe(true);
      expect(body.checks.storage.litestreamCompactionLogFailureCount).toBe(1);
      expect(body.checks.storageDegraded).toBe(true);

      // The route fires alertStorageWarning fire-and-forget (`void alertStorageWarning(...)`,
      // matching every other storage alert in this route) alongside whatever other dependency
      // alerts this health pass also triggers, so the response can resolve before delivery
      // finishes and other notification rows can interleave — poll for THIS one specifically
      // rather than asserting the most-recent row or a synchronous fetch-call count.
      const findOurEvent = () => {
        const rows = db
          .getDb()
          .prepare("SELECT payload FROM audit_events WHERE kind = 'notification' ORDER BY created_at DESC LIMIT 20")
          .all() as { payload: string }[];
        return rows
          .map((r) => JSON.parse(r.payload))
          .find((p) => p.title === "Storage Warning: litestream compaction log failure");
      };
      const payload = await vi.waitFor(() => {
        const found = findOurEvent();
        expect(found).toBeDefined();
        return found;
      });
      expect(payload.status).toBe("sent");
      expect(calls).toContain("https://api.resend.com/emails");
    } finally {
      try {
        unlinkSync(logPath);
      } catch {
        // best-effort
      }
    }
  });

  it("/api/health reports zero compaction-log findings when litestream's runtime log has no failure lines", async () => {
    const { healthRoute, db } = await load();
    db.setInternalSetting("scheduler:lastTick", new Date().toISOString());

    const logPath = join(tmpdir(), `litestream-runtime-healthy-${randomUUID()}.log`);
    writeFileSync(
      logPath,
      'time=2026-08-13T01:00:00Z level=INFO msg="compaction complete" level=1 txid=00000000000123ab size=4096\n'
    );
    process.env.LITESTREAM_RUNTIME_LOG_PATH = logPath;

    try {
      const response = await healthRoute.GET(anonymousHealthRequest());
      const body = await response.json();
      expect(body.checks.storage.litestreamCompactionLogFailureCount).toBe(0);
    } finally {
      try {
        unlinkSync(logPath);
      } catch {
        // best-effort
      }
    }
  });

  it("/api/health reports zero compaction-log findings when the log file does not exist at all (litestream not booted this way)", async () => {
    const { healthRoute, db } = await load();
    db.setInternalSetting("scheduler:lastTick", new Date().toISOString());
    process.env.LITESTREAM_RUNTIME_LOG_PATH = join(tmpdir(), `does-not-exist-${randomUUID()}.log`);

    const response = await healthRoute.GET(anonymousHealthRequest());
    const body = await response.json();
    expect(body.checks.storage.litestreamCompactionLogFailureCount).toBe(0);
  });

  // Alpha Vantage daily-cap exhaustion is a quota failure, not a transient connection blip: it
  // cannot clear before the provider's own daily reset, so re-alerting every generic 6h window is
  // pure noise for the SAME still-ongoing exhaustion (confirmed prod pattern: 1:31 AM and 8:02 AM
  // alerts for one exhausted key pool). `opts.cooldownUntil` lets the AV call site stretch the
  // suppression window to that reset instant instead of the fixed 6h; every other caller (no
  // cooldownUntil) keeps the fixed window unchanged.
  describe("alertConnectionFailure cooldown: quota-exhaustion vs generic", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("a quota-exhaustion cooldownUntil suppresses a second alert 7h later, same cap-day", async () => {
      const { health, notificationsMod } = await load();
      const sendNotificationSpy = vi.spyOn(notificationsMod, "sendNotification").mockResolvedValue({} as any);

      const start = Date.parse("2026-07-15T05:31:00Z"); // 1:31 AM ET
      vi.useFakeTimers();
      vi.setSystemTime(start);
      // Simulate the AV call site's actual reset-instant computation: ~12h away, well past a 7h check.
      const cooldownUntil = new Date(start + 12 * 60 * 60_000).toISOString();

      await health.alertConnectionFailure("alpha-vantage", "env", null, "entire key pool exhausted", { cooldownUntil });
      expect(sendNotificationSpy).toHaveBeenCalledTimes(1);

      // 7h later: past the GENERIC 6h window, but still well before this cap-day's reset.
      vi.setSystemTime(start + 7 * 60 * 60_000);
      await health.alertConnectionFailure("alpha-vantage", "env", null, "entire key pool exhausted", { cooldownUntil });
      expect(sendNotificationSpy).toHaveBeenCalledTimes(1); // still suppressed — no 8:02 AM repeat
    });

    it("a non-quota failure (no cooldownUntil) still re-alerts after the generic 6h window", async () => {
      const { health, notificationsMod } = await load();
      const sendNotificationSpy = vi.spyOn(notificationsMod, "sendNotification").mockResolvedValue({} as any);

      const start = Date.parse("2026-07-15T05:31:00Z");
      vi.useFakeTimers();
      vi.setSystemTime(start);

      await health.alertConnectionFailure("finnhub", "env", null, "HTTP 500");
      expect(sendNotificationSpy).toHaveBeenCalledTimes(1);

      vi.setSystemTime(start + 7 * 60 * 60_000); // 7h later — past the 6h generic window
      await health.alertConnectionFailure("finnhub", "env", null, "HTTP 500");
      expect(sendNotificationSpy).toHaveBeenCalledTimes(2); // re-alerts — behavior unchanged
    });

    it("alerts again once the cap-day's cooldownUntil instant itself has passed (next reset)", async () => {
      const { health, notificationsMod } = await load();
      const sendNotificationSpy = vi.spyOn(notificationsMod, "sendNotification").mockResolvedValue({} as any);

      const start = Date.parse("2026-07-15T05:31:00Z");
      vi.useFakeTimers();
      vi.setSystemTime(start);
      const firstReset = new Date(start + 2 * 60 * 60_000).toISOString(); // reset only 2h away

      await health.alertConnectionFailure("alpha-vantage", "env", null, "entire key pool exhausted", { cooldownUntil: firstReset });
      expect(sendNotificationSpy).toHaveBeenCalledTimes(1);

      // Still before the reset — stays suppressed.
      vi.setSystemTime(start + 60 * 60_000);
      await health.alertConnectionFailure("alpha-vantage", "env", null, "entire key pool exhausted", { cooldownUntil: firstReset });
      expect(sendNotificationSpy).toHaveBeenCalledTimes(1);

      // Past the reset instant — this is a NEW cap-day's exhaustion, so it alerts again.
      vi.setSystemTime(start + 2 * 60 * 60_000 + 1000);
      const nextReset = new Date(start + 26 * 60 * 60_000).toISOString();
      await health.alertConnectionFailure("alpha-vantage", "env", null, "entire key pool exhausted", { cooldownUntil: nextReset });
      expect(sendNotificationSpy).toHaveBeenCalledTimes(2);
    });

    it("falls back to the generic 6h window when cooldownUntil is already in the past", async () => {
      const { health, notificationsMod } = await load();
      const sendNotificationSpy = vi.spyOn(notificationsMod, "sendNotification").mockResolvedValue({} as any);

      const start = Date.parse("2026-07-15T05:31:00Z");
      vi.useFakeTimers();
      vi.setSystemTime(start);
      const pastReset = new Date(start - 1000).toISOString(); // already elapsed — defensive/malformed input

      await health.alertConnectionFailure("alpha-vantage", "env", null, "entire key pool exhausted", { cooldownUntil: pastReset });
      expect(sendNotificationSpy).toHaveBeenCalledTimes(1);

      // 1h later — well inside the generic 6h fallback window — stays suppressed.
      vi.setSystemTime(start + 60 * 60_000);
      await health.alertConnectionFailure("alpha-vantage", "env", null, "entire key pool exhausted", { cooldownUntil: pastReset });
      expect(sendNotificationSpy).toHaveBeenCalledTimes(1);
    });
  });
});
