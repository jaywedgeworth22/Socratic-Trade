import { beforeAll, describe, expect, it } from "vitest";
import { getDb, getNotifyPrefs, setNotifyPrefs } from "../src/lib/db";
import { describeChannels, formatNotifyEmailText, NOTIFY_EMAIL_SENT_BY, notify, type NotifyConfig } from "../src/lib/notify";

// notify()'s webhook channel now re-validates the target with a real DNS lookup on every
// send (SSRF/rebinding hardening — src/lib/egress-guard.ts). These tests use the
// IANA-reserved, never-resolving `h.example` host on purpose (so they stay hermetic and
// don't depend on real network/DNS access), so every send here injects a stub resolver
// standing in for a normal public address (Google public DNS — definitely not
// private/loopback/link-local).
const resolveHost = async () => ["8.8.8.8"];

const baseCfg = (): NotifyConfig => ({
  timeoutMs: 1000,
  retryAttempts: 3,
  retryDelayMs: 0, // no real backoff waits in tests
  push: { ntfyServer: "https://ntfy.example" },
  pushover: { pushoverToken: "" },
  email: { provider: "resend", resendKey: "rk_test", from: "alerts@example.com" },
  sms: { twilioSid: "AC1", twilioToken: "tok", twilioFrom: "+10000000000" }
});

describe("notify multi-channel delivery", () => {
  beforeAll(() => {
    process.env.DATABASE_URL = `file:${process.env.TMPDIR ?? "/tmp"}/notify-test-${Date.now()}.db`;
    getDb();
  });

  it("prefs round-trip: channels filtered to known set, targets trimmed", () => {
    const saved = setNotifyPrefs("u1", {
      channels: ["webhook", "bogus", "sms"],
      webhookUrl: "  https://h.example/x  ",
      phone: " +14155551234 "
    });
    expect([...saved.channels].sort()).toEqual(["sms", "webhook"]);
    expect(saved.webhookUrl).toBe("https://h.example/x");
    expect(saved.phone).toBe("+14155551234");
    expect([...getNotifyPrefs("u1").channels].sort()).toEqual(["sms", "webhook"]);
  });

  it("delivers to each enabled channel that has a target; records targetless skips", async () => {
    setNotifyPrefs("u2", {
      channels: ["webhook", "email", "sms", "push"],
      webhookUrl: "https://h.example/hook",
      email: "you@example.com",
      phone: "+14155551234"
    });
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL) => {
      calls.push(String(url));
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;

    const results = await notify("u2", { title: "T", body: "B", kind: "price_alert" }, { config: baseCfg(), fetchImpl, resolveHost });
    const byChannel = Object.fromEntries(results.map((r) => [r.channel, r]));
    expect(byChannel.webhook?.ok).toBe(true);
    expect(byChannel.email?.ok).toBe(true);
    expect(byChannel.sms?.ok).toBe(true);
    expect(byChannel.push?.skipped).toBe("no_target");
    expect(calls.length).toBe(3);
  });

  it("records a channel failure without throwing", async () => {
    setNotifyPrefs("u3", { channels: ["webhook"], webhookUrl: "https://h.example/hook" });
    const fetchImpl = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    const results = await notify("u3", { title: "T", body: "B" }, { config: baseCfg(), fetchImpl, resolveHost });
    expect(results[0]!.ok).toBe(false);
    expect(results[0]!.error).toContain("HTTP 500");
  });

  it("retries a transient delivery failure and then succeeds (no dropped alert)", async () => {
    setNotifyPrefs("u4", { channels: ["webhook"], webhookUrl: "https://h.example/hook" });
    let attempts = 0;
    const fetchImpl = (async () => {
      attempts++;
      if (attempts < 3) throw new TypeError("fetch failed"); // the exact transient prod error
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;
    const results = await notify("u4", { title: "T", body: "B", kind: "block" }, { config: baseCfg(), fetchImpl, resolveHost });
    expect(results[0]!.ok).toBe(true);
    expect(attempts).toBe(3); // failed twice, delivered on the third — the alert is NOT dropped
  });

  it("does NOT retry a permanent (4xx) delivery failure", async () => {
    setNotifyPrefs("u5", { channels: ["webhook"], webhookUrl: "https://h.example/hook" });
    let attempts = 0;
    const fetchImpl = (async () => {
      attempts++;
      return new Response("bad", { status: 400 });
    }) as unknown as typeof fetch;
    const results = await notify("u5", { title: "T", body: "B", kind: "block" }, { config: baseCfg(), fetchImpl, resolveHost });
    expect(results[0]!.ok).toBe(false);
    expect(attempts).toBe(1); // 4xx is permanent — retrying just wastes attempts
  });

  it("skips Resend when Pushover can deliver", async () => {
    setNotifyPrefs("u-prefer-pushover", {
      channels: ["email", "pushover"],
      email: "ops@example.test",
      pushoverTarget: "u1userkey"
    });
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL) => {
      calls.push(String(url));
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;
    const cfg = { ...baseCfg(), pushover: { pushoverToken: "pv-token" } };
    const results = await notify(
      "u-prefer-pushover",
      { title: "Storage Warning: litestream tier 2 stale", body: "Deep compaction is stale." },
      { config: cfg, fetchImpl, resolveHost }
    );
    expect(results.find((r) => r.channel === "pushover")?.ok).toBe(true);
    expect(calls).toEqual(["https://api.pushover.net/1/messages.json"]);
  });

  it("email body ends with a Socratic-Trade sign-off", async () => {
    setNotifyPrefs("u-email-signoff", { channels: ["email"], email: "ops@example.test" });
    const calls: Array<{ text?: string; subject?: string }> = [];
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body)) as { text?: string; subject?: string });
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;

    const results = await notify(
      "u-email-signoff",
      { title: "Storage Warning: litestream tier 2 stale", body: "Deep compaction is stale." },
      { config: baseCfg(), fetchImpl, resolveHost }
    );
    expect(results[0]?.ok).toBe(true);
    expect(calls[0]?.subject).toBe("[Socratic-Trade] Storage Warning: litestream tier 2 stale");
    expect(calls[0]?.text).toBe(
      formatNotifyEmailText("Storage Warning: litestream tier 2 stale", "Deep compaction is stale.")
    );
    expect(calls[0]?.text).toMatch(/\n\(sent by Socratic-Trade\)$/);
    expect(formatNotifyEmailText("T", "B")).toBe(`T\n\nB\n\n${NOTIFY_EMAIL_SENT_BY}`);
  });

  it("describeChannels reflects admin availability", () => {
    const cfg = baseCfg();
    expect(describeChannels(cfg).find((c) => c.id === "sms")?.available).toBe(true);
    const noSms = describeChannels({ ...cfg, sms: { twilioSid: "", twilioToken: "", twilioFrom: "" } });
    expect(noSms.find((c) => c.id === "sms")?.available).toBe(false);
  });
});
