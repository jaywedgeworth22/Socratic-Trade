import crypto, { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

// POST/DELETE /api/mobile/push/register — session-authenticated device-token registration.
// Identity comes from the middleware-set x-authenticated-user-email header (never the body), the
// same seam every other /api/mobile route uses.

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-apns-route-${randomUUID()}.db`)}`;
  process.env.APNS_KEY_ID = "KEY123456";
  process.env.APNS_TEAM_ID = "CC8UTF7ATG";
  process.env.APNS_BUNDLE_ID = "trade.socratic.ios";
  process.env.APNS_PRIVATE_KEY_B64 = Buffer.from(
    crypto.generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString()
  ).toString("base64");
});

const hexToken = (seed: string) => crypto.createHash("sha256").update(seed).digest("hex");

function request(email: string, method: string, body: unknown): Request {
  return new Request("https://socratictrade.com/api/mobile/push/register", {
    method,
    headers: { "x-authenticated-user-email": email, "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

describe("POST /api/mobile/push/register", () => {
  it("registers a token, enables the apns channel, and never echoes the raw token", async () => {
    const { POST } = await import("../app/api/mobile/push/register/route");
    const { userIdForEmail } = await import("../src/lib/auth/identity");
    const { getNotifyPrefs, listActiveDeviceTokens } = await import("../src/lib/db");
    const email = `reg-${randomUUID()}@example.com`;
    const token = hexToken("route-register");

    const res = await POST(request(email, "POST", { token, environment: "production" }));
    const json = (await res.json()) as { ok: boolean; device: { token: string; environment: string } };

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.device.token).not.toBe(token); // masked, never the credential itself
    expect(json.device.environment).toBe("production");

    const userId = userIdForEmail(email);
    expect(listActiveDeviceTokens(userId).map((d) => d.token)).toEqual([token]);
    expect(getNotifyPrefs(userId).channels).toContain("apns");
  });

  it("is idempotent — re-POSTing the same token succeeds without duplicating it", async () => {
    const { POST } = await import("../app/api/mobile/push/register/route");
    const { userIdForEmail } = await import("../src/lib/auth/identity");
    const { listActiveDeviceTokens } = await import("../src/lib/db");
    const email = `idem-${randomUUID()}@example.com`;
    const token = hexToken("route-idempotent");

    for (let i = 0; i < 3; i++) {
      const res = await POST(request(email, "POST", { token, environment: "sandbox" }));
      expect(res.status).toBe(200);
    }
    expect(listActiveDeviceTokens(userIdForEmail(email))).toHaveLength(1);
  });

  it("REASSIGNS a token registered by a second account (shared device switching users)", async () => {
    const { POST } = await import("../app/api/mobile/push/register/route");
    const { userIdForEmail } = await import("../src/lib/auth/identity");
    const { listActiveDeviceTokens } = await import("../src/lib/db");
    const first = `first-${randomUUID()}@example.com`;
    const second = `second-${randomUUID()}@example.com`;
    const token = hexToken("route-shared-device");

    await POST(request(first, "POST", { token, environment: "production" }));
    await POST(request(second, "POST", { token, environment: "production" }));

    expect(listActiveDeviceTokens(userIdForEmail(first))).toHaveLength(0);
    expect(listActiveDeviceTokens(userIdForEmail(second)).map((d) => d.token)).toEqual([token]);
  });

  it("does NOT re-enable the apns channel a user turned off (the app re-registers every launch)", async () => {
    const { POST } = await import("../app/api/mobile/push/register/route");
    const { userIdForEmail } = await import("../src/lib/auth/identity");
    const { getNotifyPrefs, setNotifyPrefs } = await import("../src/lib/db");
    const email = `optout-${randomUUID()}@example.com`;
    const token = hexToken("route-opt-out");
    const userId = userIdForEmail(email);

    await POST(request(email, "POST", { token, environment: "production" }));
    expect(getNotifyPrefs(userId).channels).toContain("apns");

    // The owner turns "iPhone push" off in Settings -> Delivery.
    setNotifyPrefs(userId, { channels: getNotifyPrefs(userId).channels.filter((c) => c !== "apns") });

    // Every subsequent app launch re-registers the same live token. The off-switch must hold.
    await POST(request(email, "POST", { token, environment: "production" }));
    await POST(request(email, "POST", { token, environment: "production" }));
    expect(getNotifyPrefs(userId).channels).not.toContain("apns");
  });

  it("re-enables the channel when a device comes back after sign-out (disabled row = fresh opt-in)", async () => {
    const { POST, DELETE } = await import("../app/api/mobile/push/register/route");
    const { userIdForEmail } = await import("../src/lib/auth/identity");
    const { getNotifyPrefs } = await import("../src/lib/db");
    const email = `rejoin-${randomUUID()}@example.com`;
    const token = hexToken("route-rejoin");
    const userId = userIdForEmail(email);

    await POST(request(email, "POST", { token, environment: "production" }));
    await DELETE(request(email, "DELETE", { token }));
    expect(getNotifyPrefs(userId).channels).not.toContain("apns");

    await POST(request(email, "POST", { token, environment: "production" }));
    expect(getNotifyPrefs(userId).channels).toContain("apns");
  });

  it("rejects a malformed token, a bad environment, and a mismatched bundle id", async () => {
    const { POST } = await import("../app/api/mobile/push/register/route");
    const email = `bad-${randomUUID()}@example.com`;
    const token = hexToken("route-bad");

    expect((await POST(request(email, "POST", { token: "nope", environment: "production" }))).status).toBe(400);
    expect((await POST(request(email, "POST", { token, environment: "staging" }))).status).toBe(400);
    expect((await POST(request(email, "POST", { token, environment: "production", bundleId: "com.someone.else" }))).status).toBe(400);
  });
});

describe("DELETE /api/mobile/push/register", () => {
  it("unregisters the caller's own device and drops the channel when the last one goes", async () => {
    const { POST, DELETE } = await import("../app/api/mobile/push/register/route");
    const { userIdForEmail } = await import("../src/lib/auth/identity");
    const { getNotifyPrefs, listActiveDeviceTokens } = await import("../src/lib/db");
    const email = `signout-${randomUUID()}@example.com`;
    const token = hexToken("route-signout");

    await POST(request(email, "POST", { token, environment: "production" }));
    const res = await DELETE(request(email, "DELETE", { token }));
    const json = (await res.json()) as { ok: boolean; removed: boolean };

    expect(json).toEqual({ ok: true, removed: true });
    const userId = userIdForEmail(email);
    expect(listActiveDeviceTokens(userId)).toHaveLength(0);
    expect(getNotifyPrefs(userId).channels).not.toContain("apns");
  });

  it("never lets one account unregister another account's device", async () => {
    const { POST, DELETE } = await import("../app/api/mobile/push/register/route");
    const { userIdForEmail } = await import("../src/lib/auth/identity");
    const { listActiveDeviceTokens } = await import("../src/lib/db");
    const owner = `owner-${randomUUID()}@example.com`;
    const attacker = `attacker-${randomUUID()}@example.com`;
    const token = hexToken("route-cross-account");

    await POST(request(owner, "POST", { token, environment: "production" }));
    const res = await DELETE(request(attacker, "DELETE", { token }));

    expect((await res.json()) as unknown).toEqual({ ok: true, removed: false });
    expect(listActiveDeviceTokens(userIdForEmail(owner))).toHaveLength(1);
  });
});
