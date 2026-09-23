import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-usage-limit-alerts-${randomUUID()}.db`)}`;
  // Cloud / host env may carry live Pushover tokens; email-fallback cases must stay hermetic.
  vi.stubEnv("PUSHOVER_APP_TOKEN", "");
  vi.stubEnv("PUSHOVER_ST_API_TOKEN", "");
  vi.stubEnv("PUSHOVER_USER_KEY", "");
});

describe("usage limit alerts", () => {
  it("records a budget_alert and emails the operator fallback when a provider cap is hit", async () => {
    const userId = `limit-alert-${randomUUID()}`;
    const calls: Array<{ url: string; body: unknown }> = [];
    vi.stubEnv("RESEND_API_KEY", "rk_test");
    vi.stubEnv("NOTIFY_EMAIL_FROM", "alerts@example.test");
    vi.stubEnv("USAGE_LIMIT_ALERT_EMAIL", "owner@example.test");
    vi.stubGlobal(
      "fetch",
      (async (url: string | URL, init?: RequestInit) => {
        calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
        return new Response("ok", { status: 200 });
      }) as typeof fetch
    );

    const { alertUsageLimitHit } = await import("../src/lib/usage-limit-alerts");
    const { listNotificationEvents } = await import("../src/lib/db");

    await alertUsageLimitHit({
      userId,
      provider: "Pinecone",
      operation: "upsert-budget",
      limitName: "Write Unit daily fuse",
      status: "exceeded",
      used: 50_000,
      limit: 50_000,
      attempted: 62_000,
      skipped: 3,
      unit: "estimated WUs",
      recommendation: "Inspect chunking and deduping before raising the cap."
    });

    const events = listNotificationEvents(userId, 10);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "budget_alert",
      title: "Usage limit hit: Pinecone Write Unit daily fuse",
      status: "skipped"
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.resend.com/emails");
    expect(calls[0]?.body).toMatchObject({
      from: "alerts@example.test",
      to: ["owner@example.test"],
      subject: "[Socratic-Trade] Usage limit hit: Pinecone Write Unit daily fuse"
    });
    expect(String((calls[0]?.body as { text?: string }).text)).toContain("Inspect chunking and deduping");
    expect(String((calls[0]?.body as { text?: string }).text)).toMatch(/\n\(sent by Socratic-Trade\)$/);

    await alertUsageLimitHit({
      userId,
      provider: "Pinecone",
      operation: "upsert-budget",
      limitName: "Write Unit daily fuse",
      status: "exceeded"
    });
    expect(listNotificationEvents(userId, 10)).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });

  it("does not latch the 6h cooldown when the first attempt never delivered", async () => {
    const userId = `limit-alert-no-latch-${randomUUID()}`;
    const { alertUsageLimitHit } = await import("../src/lib/usage-limit-alerts");
    const { listNotificationEvents, getInternalSetting } = await import("../src/lib/db");

    await alertUsageLimitHit({
      userId,
      provider: "Pinecone",
      operation: "upsert-budget",
      limitName: "Write Unit daily fuse",
      status: "exceeded"
    });
    expect(listNotificationEvents(userId, 10)).toHaveLength(1);
    expect(listNotificationEvents(userId, 10)[0]?.status).toBe("skipped");
    expect(
      getInternalSetting(`usageLimitAlert:lastSent:${userId}:pinecone:upsert-budget:Write Unit daily fuse`)
    ).toBeUndefined();

    await alertUsageLimitHit({
      userId,
      provider: "Pinecone",
      operation: "upsert-budget",
      limitName: "Write Unit daily fuse",
      status: "exceeded"
    });
    expect(listNotificationEvents(userId, 10)).toHaveLength(2);
  });

  it("does not send Pushover a second time when the user already enabled that channel", async () => {
    const userId = `limit-alert-no-double-pushover-${randomUUID()}`;
    const calls: string[] = [];
    vi.stubEnv("PUSHOVER_APP_TOKEN", "pv-token");
    vi.stubEnv("PUSHOVER_USER_KEY", "u1userkey");
    vi.stubGlobal(
      "fetch",
      (async (url: string | URL) => {
        calls.push(String(url));
        return new Response("ok", { status: 200 });
      }) as typeof fetch
    );

    const { setNotifyPrefs } = await import("../src/lib/db");
    setNotifyPrefs(userId, { channels: ["pushover"], pushoverTarget: "u1userkey" });
    const { alertUsageLimitHit } = await import("../src/lib/usage-limit-alerts");
    await alertUsageLimitHit({
      userId,
      provider: "Pinecone",
      operation: "upsert-budget",
      limitName: "Write Unit daily fuse",
      status: "exceeded"
    });
    expect(calls).toEqual(["https://api.pushover.net/1/messages.json"]);
  });

  it("prefers Pushover over the operator email fallback", async () => {
    const userId = `limit-alert-pushover-${randomUUID()}`;
    const calls: string[] = [];
    vi.stubEnv("RESEND_API_KEY", "rk_test");
    vi.stubEnv("NOTIFY_EMAIL_FROM", "alerts@example.test");
    vi.stubEnv("USAGE_LIMIT_ALERT_EMAIL", "owner@example.test");
    vi.stubEnv("PUSHOVER_APP_TOKEN", "pv-token");
    vi.stubEnv("PUSHOVER_USER_KEY", "u1userkey");
    vi.stubGlobal(
      "fetch",
      (async (url: string | URL) => {
        calls.push(String(url));
        return new Response("ok", { status: 200 });
      }) as typeof fetch
    );

    const { alertUsageLimitHit } = await import("../src/lib/usage-limit-alerts");
    await alertUsageLimitHit({
      userId,
      provider: "Pinecone",
      operation: "upsert-budget",
      limitName: "Write Unit daily fuse",
      status: "exceeded"
    });
    expect(calls).toEqual(["https://api.pushover.net/1/messages.json"]);
  });

  it("fences the real operator-email fallback during a delayed send", async () => {
    const userId = `limit-alert-fenced-${randomUUID()}`;
    const controller = new AbortController();
    let active = true;
    let requestSignal: AbortSignal | undefined;
    let entered!: () => void;
    let release!: () => void;
    const fallbackEntered = new Promise<void>((resolve) => { entered = resolve; });
    const releaseFallback = new Promise<void>((resolve) => { release = resolve; });
    vi.stubEnv("RESEND_API_KEY", "rk_test");
    vi.stubEnv("NOTIFY_EMAIL_FROM", "alerts@example.test");
    vi.stubEnv("USAGE_LIMIT_ALERT_EMAIL", "owner@example.test");
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requestSignal = init?.signal ?? undefined;
      entered();
      await releaseFallback;
      // Ignore cancellation to prove the post-await ownership check fences the audit path.
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchImpl);

    const { alertUsageLimitHit } = await import("../src/lib/usage-limit-alerts");
    const { getDb } = await import("../src/lib/db");
    const snapshot = () => ({
      audits: getDb().prepare("SELECT kind, payload FROM audit_events ORDER BY rowid").all(),
      notifications: getDb().prepare(
        "SELECT type, status, payload, error FROM notification_events ORDER BY rowid"
      ).all(),
      settings: getDb().prepare(
        "SELECT key, value FROM settings WHERE key LIKE 'usageLimitAlert:%' ORDER BY key"
      ).all()
    });

    const pending = alertUsageLimitHit(
      {
        userId,
        provider: "Pinecone",
        operation: "upsert-budget",
        limitName: "Write Unit daily fuse",
        status: "exceeded"
      },
      {
        assertActive: () => {
          if (!active) throw new Error("lease lost during operator fallback");
        },
        signal: controller.signal
      }
    );

    await fallbackEntered;
    const rowsAtLoss = snapshot();
    active = false;
    controller.abort(new Error("lease lost during operator fallback"));
    expect(requestSignal?.aborted).toBe(true);
    release();

    await expect(pending).rejects.toThrow(/lease lost/i);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(snapshot()).toEqual(rowsAtLoss);
    expect(rowsAtLoss.audits.some((row) => (row as { kind?: string }).kind === "notify.sent")).toBe(false);
  });
});
