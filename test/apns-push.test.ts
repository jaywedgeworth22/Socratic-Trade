import crypto from "node:crypto";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import {
  APNS_ENDPOINTS,
  APNS_TOKEN_REFRESH_MS,
  apnsConfigured,
  buildApnsPayload,
  getApnsProviderToken,
  invalidateApnsProviderToken,
  loadApnsConfig,
  sendApnsPush,
  type ApnsConfig,
  type ApnsHttpRequest,
  type ApnsHttpResponse,
  type ApnsTransport
} from "../src/lib/apns";
import {
  countActiveDeviceTokens,
  getDeviceToken,
  getNotifyPrefs,
  listActiveDeviceTokens,
  maskDeviceToken,
  normalizeDeviceToken,
  registerDeviceToken,
  setNotifyPrefs,
  setPolicy,
  getPolicy,
  unregisterDeviceToken,
  getDb
} from "../src/lib/db";
import { channelsForNotify, notify, type NotifyConfig } from "../src/lib/notify";
import { sendNotification } from "../src/lib/notifications";
import { pushCollapseId, pushDeepLink } from "../src/lib/push-deep-links";
import { DEFAULT_NOTIFICATION_SETTINGS } from "../src/lib/defaults";

// A throwaway P-256 key generated per test run. This is NOT a credential — the real .p8 lives in
// Infisical (APNS_PRIVATE_KEY_B64) and is never read by tests.
const testKeyPem = crypto
  .generateKeyPairSync("ec", { namedCurve: "P-256" })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();

const testConfig = (): ApnsConfig => ({
  keyId: "KEY123456",
  teamId: "CC8UTF7ATG",
  bundleId: "trade.socratic.ios",
  privateKeyPem: testKeyPem
});

const hexToken = (seed: string) => crypto.createHash("sha256").update(seed).digest("hex");

function recordingTransport(responder: (req: ApnsHttpRequest) => ApnsHttpResponse): {
  transport: ApnsTransport;
  calls: ApnsHttpRequest[];
} {
  const calls: ApnsHttpRequest[] = [];
  const transport: ApnsTransport = async (req) => {
    calls.push(req);
    return responder(req);
  };
  return { transport, calls };
}

const okResponse: ApnsHttpResponse = { status: 200, body: "" };

const notifyConfig = (apns: ApnsConfig | null): NotifyConfig => ({
  timeoutMs: 1000,
  retryAttempts: 1,
  retryDelayMs: 0,
  push: { ntfyServer: "https://ntfy.example" },
  pushover: { pushoverToken: "" },
  email: { provider: "resend", resendKey: "", from: "" },
  sms: { twilioSid: "", twilioToken: "", twilioFrom: "" },
  apns
});

beforeEach(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-apns-${randomUUID()}.db`)}`;
  invalidateApnsProviderToken();
  getDb();
});

// ── Registry ──────────────────────────────────────────────────────────────────

describe("device-token registry", () => {
  it("registers idempotently and normalizes Apple's token formatting", () => {
    const userId = `u-${randomUUID()}`;
    const token = hexToken("idempotent");
    const first = registerDeviceToken({ userId, token, environment: "production", bundleId: "trade.socratic.ios" });
    const again = registerDeviceToken({ userId, token, environment: "production", bundleId: "trade.socratic.ios" });

    expect(again.createdAt).toBe(first.createdAt); // re-register keeps first-seen time
    expect(countActiveDeviceTokens(userId)).toBe(1);
    // "<0123 abcd>" style Data.description output normalizes to bare lowercase hex.
    expect(normalizeDeviceToken(`<${token.slice(0, 32).toUpperCase()} ${token.slice(32)}>`)).toBe(token);
    expect(normalizeDeviceToken("not-a-token")).toBeNull();
  });

  it("REASSIGNS a token re-registered under a different user (shared device, account switch)", () => {
    const alice = `alice-${randomUUID()}`;
    const bob = `bob-${randomUUID()}`;
    const token = hexToken("shared-device");

    registerDeviceToken({ userId: alice, token, environment: "production", bundleId: "trade.socratic.ios" });
    expect(listActiveDeviceTokens(alice).map((d) => d.token)).toEqual([token]);

    registerDeviceToken({ userId: bob, token, environment: "production", bundleId: "trade.socratic.ios" });

    // The device now belongs to Bob ALONE — Alice's alerts must never reach it again.
    expect(listActiveDeviceTokens(alice)).toHaveLength(0);
    expect(listActiveDeviceTokens(bob).map((d) => d.token)).toEqual([token]);
    expect(getDeviceToken(token)?.userId).toBe(bob);
    // And exactly one row exists — no duplicate leaking the old owner.
    const rows = getDb().prepare("SELECT COUNT(*) AS n FROM device_push_tokens WHERE token = ?").get(token) as { n: number };
    expect(rows.n).toBe(1);
  });

  it("re-registering a previously disabled token re-enables it", () => {
    const userId = `u-${randomUUID()}`;
    const token = hexToken("reinstall");
    registerDeviceToken({ userId, token, environment: "sandbox", bundleId: "trade.socratic.ios" });
    expect(unregisterDeviceToken(userId, token)).toBe(true);
    expect(countActiveDeviceTokens(userId)).toBe(0);

    registerDeviceToken({ userId, token, environment: "sandbox", bundleId: "trade.socratic.ios" });
    expect(countActiveDeviceTokens(userId)).toBe(1);
    expect(getDeviceToken(token)?.disabledAt).toBeNull();
  });

  it("unregister is scoped to the owner — one account cannot retire another's device", () => {
    const owner = `owner-${randomUUID()}`;
    const other = `other-${randomUUID()}`;
    const token = hexToken("scoped-unregister");
    registerDeviceToken({ userId: owner, token, environment: "production", bundleId: "trade.socratic.ios" });

    expect(unregisterDeviceToken(other, token)).toBe(false);
    expect(countActiveDeviceTokens(owner)).toBe(1);
  });

  it("masks tokens for logging", () => {
    const token = hexToken("mask");
    const masked = maskDeviceToken(token);
    expect(masked).not.toContain(token);
    expect(masked).toBe(`${token.slice(0, 6)}...${token.slice(-4)}`);
  });
});

// ── Provider JWT ──────────────────────────────────────────────────────────────

describe("APNs provider token", () => {
  it("reuses the SAME jwt inside the refresh window and mints a new one after it", () => {
    const config = testConfig();
    const t0 = 1_700_000_000_000;
    const first = getApnsProviderToken(config, t0);

    // Apple requires >= 20 minutes of reuse; anything inside the window must be byte-identical.
    expect(getApnsProviderToken(config, t0 + 60_000)).toBe(first);
    expect(getApnsProviderToken(config, t0 + 19 * 60_000)).toBe(first);
    expect(getApnsProviderToken(config, t0 + APNS_TOKEN_REFRESH_MS - 1)).toBe(first);

    // ...and it must refresh before Apple's 60-minute expiry.
    expect(APNS_TOKEN_REFRESH_MS).toBeLessThan(60 * 60_000);
    const refreshed = getApnsProviderToken(config, t0 + APNS_TOKEN_REFRESH_MS + 1);
    expect(refreshed).not.toBe(first);
  });

  it("signs ES256 with the kid/iss claims Apple expects", () => {
    const config = testConfig();
    const jwt = getApnsProviderToken(config, 1_700_000_000_000);
    const [header, claims, signature] = jwt.split(".");
    expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({ alg: "ES256", kid: config.keyId });
    const parsedClaims = JSON.parse(Buffer.from(claims, "base64url").toString());
    expect(parsedClaims.iss).toBe(config.teamId);
    expect(parsedClaims.iat).toBe(1_700_000_000);
    // JOSE ES256 = raw r||s (64 bytes), never a DER envelope.
    expect(Buffer.from(signature, "base64url")).toHaveLength(64);
  });
});

// ── Send: endpoint selection, response handling ───────────────────────────────

describe("sendApnsPush", () => {
  it("picks the endpoint from the token's stored environment, not from the runtime", async () => {
    const config = testConfig();
    const seen: string[] = [];
    const transport: ApnsTransport = async (req) => {
      seen.push(req.origin);
      return okResponse;
    };

    await sendApnsPush(
      { deviceToken: hexToken("sandbox-dev"), environment: "sandbox", title: "t", body: "b" },
      { config, transport }
    );
    await sendApnsPush(
      { deviceToken: hexToken("prod-dev"), environment: "production", title: "t", body: "b" },
      { config, transport }
    );

    expect(seen).toEqual([APNS_ENDPOINTS.sandbox, APNS_ENDPOINTS.production]);
    // TestFlight is PRODUCTION — the production endpoint must be Apple's non-sandbox host.
    expect(APNS_ENDPOINTS.production).toBe("https://api.push.apple.com");
  });

  it("sends the topic, push type, and collapse id as headers and the deep link in the payload", async () => {
    const config = testConfig();
    const { transport, calls } = recordingTransport(() => okResponse);
    await sendApnsPush(
      {
        deviceToken: hexToken("headers"),
        environment: "production",
        title: "Approval needed",
        body: "BUY AAPL",
        url: "https://socratictrade.com/console/approvals?proposal=p1",
        collapseId: "approval-AAPL-buy",
        data: { kind: "pending_approval", proposalId: "p1" }
      },
      { config, transport }
    );

    const req = calls[0];
    expect(req.path).toBe(`/3/device/${hexToken("headers")}`);
    expect(req.headers["apns-topic"]).toBe("trade.socratic.ios");
    expect(req.headers["apns-push-type"]).toBe("alert");
    expect(req.headers["apns-collapse-id"]).toBe("approval-AAPL-buy");
    expect(req.headers.authorization.startsWith("bearer ")).toBe(true);
    const payload = JSON.parse(req.body);
    expect(payload.aps.alert).toEqual({ title: "Approval needed", body: "BUY AAPL" });
    expect(payload.url).toBe("https://socratictrade.com/console/approvals?proposal=p1");
    expect(payload.proposalId).toBe("p1");
  });

  it("truncates a collapse id to Apple's 64-byte cap", async () => {
    const config = testConfig();
    const { transport, calls } = recordingTransport(() => okResponse);
    await sendApnsPush(
      { deviceToken: hexToken("collapse"), environment: "production", title: "t", body: "b", collapseId: "x".repeat(200) },
      { config, transport }
    );
    expect(calls[0].headers["apns-collapse-id"]).toHaveLength(64);
  });

  it("classifies 410 Unregistered and 400 BadDeviceToken as a dead token", async () => {
    const config = testConfig();
    const gone: ApnsTransport = async () => ({ status: 410, body: JSON.stringify({ reason: "Unregistered" }) });
    const bad: ApnsTransport = async () => ({ status: 400, body: JSON.stringify({ reason: "BadDeviceToken" }) });

    const a = await sendApnsPush({ deviceToken: hexToken("a"), environment: "production", title: "t", body: "b" }, { config, transport: gone });
    const b = await sendApnsPush({ deviceToken: hexToken("b"), environment: "production", title: "t", body: "b" }, { config, transport: bad });

    expect(a.disposition).toBe("token_dead");
    expect(b.disposition).toBe("token_dead");
    expect(a.ok).toBe(false);
    expect(b.reason).toBe("BadDeviceToken");
  });

  it("classifies 429/5xx as retryable, 403 as an auth problem, other 4xx as permanent", async () => {
    const config = testConfig();
    const at = async (status: number, reason?: string): Promise<ApnsHttpResponse> => ({
      status,
      body: reason ? JSON.stringify({ reason }) : ""
    });
    const run = (status: number, reason?: string) =>
      sendApnsPush(
        { deviceToken: hexToken(`s${status}`), environment: "production", title: "t", body: "b" },
        { config, transport: async () => at(status, reason) }
      );

    expect((await run(429, "TooManyProviderTokenUpdates")).disposition).toBe("retryable");
    expect((await run(503, "ServiceUnavailable")).disposition).toBe("retryable");
    expect((await run(403, "InvalidProviderToken")).disposition).toBe("auth_error");
    expect((await run(400, "BadTopic")).disposition).toBe("permanent");
  });

  it("drops the cached jwt on 403 ExpiredProviderToken so the next send mints a fresh one", async () => {
    const config = testConfig();
    const t0 = 1_700_000_000_000;
    const before = getApnsProviderToken(config, t0);
    await sendApnsPush(
      { deviceToken: hexToken("expired"), environment: "production", title: "t", body: "b" },
      { config, transport: async () => ({ status: 403, body: JSON.stringify({ reason: "ExpiredProviderToken" }) }), nowMs: t0 }
    );
    // Same clock, but the cache was invalidated -> a new iat-identical token is re-minted rather
    // than the rejected one being replayed forever.
    expect(getApnsProviderToken(config, t0 + 1)).not.toBe(before);
  });

  it("never throws on a transport failure — it reports it as retryable", async () => {
    const config = testConfig();
    const result = await sendApnsPush(
      { deviceToken: hexToken("boom"), environment: "production", title: "t", body: "b" },
      {
        config,
        transport: async () => {
          throw new Error("socket hang up");
        }
      }
    );
    expect(result.ok).toBe(false);
    expect(result.disposition).toBe("retryable");
    expect(result.error).toContain("socket hang up");
  });

  it("reports a malformed signing key as an auth/config problem, not a crash", async () => {
    const result = await sendApnsPush(
      { deviceToken: hexToken("badkey"), environment: "production", title: "t", body: "b" },
      { config: { ...testConfig(), privateKeyPem: "-----BEGIN PRIVATE KEY-----\nnope\n-----END PRIVATE KEY-----" }, transport: async () => okResponse }
    );
    expect(result.ok).toBe(false);
    expect(result.disposition).toBe("auth_error");
  });

  it("payload keeps the alert body inside the aps dictionary", () => {
    expect(buildApnsPayload({ title: "T", body: "B" })).toMatchObject({
      aps: { alert: { title: "T", body: "B" } }
    });
  });
});

// ── Configuration ─────────────────────────────────────────────────────────────

describe("APNs configuration", () => {
  it("requires the full credential set — any missing part means unconfigured", () => {
    const base = {
      APNS_KEY_ID: "K1",
      APNS_TEAM_ID: "T1",
      APNS_BUNDLE_ID: "trade.socratic.ios",
      APNS_PRIVATE_KEY_B64: Buffer.from(testKeyPem).toString("base64")
    };
    expect(apnsConfigured(loadApnsConfig(base))).toBe(true);
    for (const key of Object.keys(base)) {
      const partial = { ...base, [key]: "" };
      expect(loadApnsConfig(partial)).toBeNull();
    }
  });

  it("decodes the base64 .p8 into usable PEM", () => {
    const config = loadApnsConfig({
      APNS_KEY_ID: "K1",
      APNS_TEAM_ID: "T1",
      APNS_BUNDLE_ID: "trade.socratic.ios",
      APNS_PRIVATE_KEY_B64: Buffer.from(testKeyPem).toString("base64")
    });
    expect(config?.privateKeyPem).toBe(testKeyPem);
    expect(getApnsProviderToken(config!, Date.now()).split(".")).toHaveLength(3);
  });

  it("accepts APNS_P8 as raw PEM so Infisical can store the .p8 without a base64 wrap", () => {
    const config = loadApnsConfig({
      APNS_KEY_ID: "K1",
      APNS_TEAM_ID: "T1",
      APNS_BUNDLE_ID: "trade.socratic.ios",
      APNS_P8: testKeyPem
    });
    expect(config?.privateKeyPem.trim()).toBe(testKeyPem.trim());
    expect(apnsConfigured(config)).toBe(true);
  });
});

// ── Deep links + collapse ids ─────────────────────────────────────────────────

describe("push deep links", () => {
  const origin = "https://socratictrade.com";

  it("emits routes the app actually has", () => {
    expect(pushDeepLink("pending_approval", { proposalId: "p-1" }, origin)).toBe(
      "https://socratictrade.com/console/approvals?proposal=p-1"
    );
    expect(pushDeepLink("pending_approval", {}, origin)).toBe("https://socratictrade.com/console/approvals");
    expect(pushDeepLink("fill", { fill: { symbol: "aapl" } }, origin)).toBe(
      "https://socratictrade.com/console/orders?symbol=AAPL"
    );
    expect(pushDeepLink("price_alert", { alert: { symbol: "TSLA", id: "a1" } }, origin)).toBe(
      "https://socratictrade.com/console/watchlist?symbol=TSLA"
    );
    expect(pushDeepLink("run_failed", { runId: "r1" }, origin)).toBe("https://socratictrade.com/console/activity?tab=alerts");
    // The catch-all is a TWO-segment console path, because the iOS router rejects bare `/console`.
    expect(pushDeepLink("learning_review", {}, origin)).toBe("https://socratictrade.com/console/activity?tab=notifications");
  });

  it("collapses the noisy repeats and leaves fills alone", () => {
    expect(pushCollapseId("pending_approval", { proposal: { symbol: "AAPL", side: "buy" } })).toBe("approval-AAPL-buy");
    expect(pushCollapseId("run_failed", { symbol: "BAC" })).toBe("run-failed-BAC");
    expect(pushCollapseId("price_alert", { alert: { id: "a1", symbol: "TSLA" } })).toBe("price-alert-a1");
    // Two fills are two events — neither may replace the other on the lock screen.
    expect(pushCollapseId("fill", { fill: { symbol: "AAPL" } })).toBeUndefined();
  });
});

// ── notify() channel wiring ───────────────────────────────────────────────────

describe("apns delivery channel", () => {
  it("includes native push when the user has a live device even if prefs omitted apns", () => {
    const userId = `u-${randomUUID()}`;
    registerDeviceToken({
      userId,
      token: hexToken("auto-apns"),
      environment: "production",
      bundleId: "trade.socratic.ios"
    });
    setNotifyPrefs(userId, { channels: ["pushover"], pushoverTarget: "u123" });
    const ids = channelsForNotify(userId, getNotifyPrefs(userId), notifyConfig(testConfig()));
    expect(ids[0]).toBe("apns");
    expect(ids).toContain("pushover");
  });

  it("delivers to every live device and retires the ones Apple rejects", async () => {
    const userId = `u-${randomUUID()}`;
    const live = hexToken("live-device");
    const dead = hexToken("dead-device");
    registerDeviceToken({ userId, token: live, environment: "production", bundleId: "trade.socratic.ios" });
    registerDeviceToken({ userId, token: dead, environment: "sandbox", bundleId: "trade.socratic.ios" });
    setNotifyPrefs(userId, { channels: ["apns"] });

    const transport: ApnsTransport = async (req) =>
      req.path.endsWith(dead) ? { status: 410, body: JSON.stringify({ reason: "Unregistered" }) } : okResponse;

    const results = await notify(
      userId,
      { title: "Approval needed", body: "BUY AAPL", kind: "pending_approval", data: { proposal: { symbol: "AAPL", side: "buy" }, proposalId: "p1" } },
      { config: notifyConfig(testConfig()), apnsTransport: transport }
    );

    expect(results).toEqual([{ channel: "apns", ok: true }]);
    // The 410'd token is retired; the working one survives.
    expect(listActiveDeviceTokens(userId).map((d) => d.token)).toEqual([live]);
    expect(getDeviceToken(dead)?.disabledReason).toContain("410");
  });

  it("retires a 400 BadDeviceToken (a sandbox token sent to the production endpoint)", async () => {
    const userId = `u-${randomUUID()}`;
    const token = hexToken("wrong-env");
    registerDeviceToken({ userId, token, environment: "production", bundleId: "trade.socratic.ios" });
    setNotifyPrefs(userId, { channels: ["apns"] });

    const results = await notify(
      userId,
      { title: "t", body: "b", kind: "fill" },
      {
        config: notifyConfig(testConfig()),
        apnsTransport: async () => ({ status: 400, body: JSON.stringify({ reason: "BadDeviceToken" }) })
      }
    );

    expect(results[0].ok).toBe(false);
    expect(countActiveDeviceTokens(userId)).toBe(0);
  });

  it("reports 'not configured' when the APNs credential set is missing — it does not crash", async () => {
    const userId = `u-${randomUUID()}`;
    registerDeviceToken({ userId, token: hexToken("unconfigured"), environment: "production", bundleId: "trade.socratic.ios" });
    setNotifyPrefs(userId, { channels: ["apns"] });

    const results = await notify(userId, { title: "t", body: "b", kind: "fill" }, { config: notifyConfig(null) });

    expect(results).toEqual([{ channel: "apns", ok: false, skipped: "not_configured" }]);
  });

  it("reports 'no target' when the user has no registered device", async () => {
    const userId = `u-${randomUUID()}`;
    setNotifyPrefs(userId, { channels: ["apns"] });

    const results = await notify(
      userId,
      { title: "t", body: "b", kind: "fill" },
      { config: notifyConfig(testConfig()), apnsTransport: async () => okResponse }
    );

    expect(results).toEqual([{ channel: "apns", ok: false, skipped: "no_target" }]);
  });

  it("a failing push never breaks the other channels", async () => {
    const userId = `u-${randomUUID()}`;
    registerDeviceToken({ userId, token: hexToken("failing"), environment: "production", bundleId: "trade.socratic.ios" });
    setNotifyPrefs(userId, { channels: ["apns", "push"], pushTarget: "topic-1" });

    const results = await notify(
      userId,
      { title: "t", body: "b", kind: "fill" },
      {
        config: notifyConfig(testConfig()),
        apnsTransport: async () => {
          throw new Error("apns exploded");
        },
        fetchImpl: async () => new Response("ok", { status: 200 })
      }
    );

    expect(results.find((r) => r.channel === "apns")?.ok).toBe(false);
    expect(results.find((r) => r.channel === "push")?.ok).toBe(true);
  });
});

// ── Per-event preference gating (the EXISTING enabledEvents gate) ─────────────

describe("push respects the user's existing per-event notification preferences", () => {
  const apnsDeps = (transport: ApnsTransport) => ({
    config: notifyConfig(testConfig()),
    apnsTransport: transport
  });

  it("does NOT push an event the user disabled", async () => {
    const userId = `u-${randomUUID()}`;
    registerDeviceToken({ userId, token: hexToken("gated-off"), environment: "production", bundleId: "trade.socratic.ios" });
    setNotifyPrefs(userId, { channels: ["apns"] });
    setPolicy(
      {
        ...getPolicy(userId),
        notificationSettings: {
          ...DEFAULT_NOTIFICATION_SETTINGS,
          enabledEvents: DEFAULT_NOTIFICATION_SETTINGS.enabledEvents.filter((t) => t !== "fill")
        }
      },
      userId
    );

    const { transport, calls } = recordingTransport(() => okResponse);
    const event = await sendNotification(
      { type: "fill", title: "BUY AAPL filled", payload: { fill: { symbol: "AAPL", side: "buy", status: "filled", quantity: 1, price: 1, notional: 1 } } },
      { userId, notifyDeps: apnsDeps(transport) }
    );

    expect(event.status).toBe("skipped");
    expect(event.error).toMatch(/disabled/i);
    expect(calls).toHaveLength(0); // no APNs request was ever made
  });

  it("DOES push the prioritized events the user left enabled", async () => {
    const userId = `u-${randomUUID()}`;
    registerDeviceToken({ userId, token: hexToken("gated-on"), environment: "production", bundleId: "trade.socratic.ios" });
    setNotifyPrefs(userId, { channels: ["apns"] });

    const { transport, calls } = recordingTransport(() => okResponse);
    const cases: Array<{ type: "pending_approval" | "kill_switch" | "fill" | "price_alert" | "run_failed"; payload: unknown; path: string }> = [
      { type: "pending_approval", payload: { proposalId: "p1", proposal: { symbol: "AAPL", side: "buy" } }, path: "/console/approvals?proposal=p1" },
      { type: "kill_switch", payload: { reason: "Volatility panic brake — halt new entries" }, path: "/console/activity?tab=alerts" },
      { type: "fill", payload: { fill: { symbol: "AAPL", side: "buy", status: "filled", quantity: 1, price: 1, notional: 1 } }, path: "/console/orders?symbol=AAPL" },
      { type: "price_alert", payload: { alert: { id: "a1", symbol: "TSLA" }, currentPrice: 1 }, path: "/console/watchlist?symbol=TSLA" },
      { type: "run_failed", payload: { runId: "r1", summary: "boom" }, path: "/console/activity?tab=alerts" }
    ];

    for (const c of cases) {
      const event = await sendNotification(
        { type: c.type, title: `${c.type} title`, payload: c.payload },
        { userId, notifyDeps: apnsDeps(transport) }
      );
      expect(event.status).toBe("sent");
    }

    expect(calls).toHaveLength(cases.length);
    expect(calls.map((call) => JSON.parse(call.body).url)).toEqual(cases.map((c) => `https://socratictrade.com${c.path}`));
  });

  it("a push failure does NOT fail the notification when another channel delivered", async () => {
    const userId = `u-${randomUUID()}`;
    registerDeviceToken({ userId, token: hexToken("softfail"), environment: "production", bundleId: "trade.socratic.ios" });
    setNotifyPrefs(userId, { channels: ["apns", "push"], pushTarget: "topic-2" });

    const event = await sendNotification(
      { type: "fill", title: "BUY AAPL filled", payload: { fill: { symbol: "AAPL", side: "buy", status: "filled", quantity: 1, price: 1, notional: 1 } } },
      {
        userId,
        notifyDeps: {
          config: notifyConfig(testConfig()),
          apnsTransport: async () => {
            throw new Error("apns down");
          },
          fetchImpl: async () => new Response("ok", { status: 200 })
        }
      }
    );

    // The trading-path caller sees a normal, non-throwing result — the push failure is recorded,
    // not propagated.
    expect(event.status).toBe("sent");
    expect(event.error).toMatch(/Partial delivery failure/);
  });
});
