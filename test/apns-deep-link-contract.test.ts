// The APNs contract between the two halves of push, checked from the TypeScript side.
//
// Server and app were built in parallel against a written contract, which is exactly the setup
// where a mismatch is invisible: the server sends a URL, the phone shrugs, and nothing anywhere
// says so — no exception, no log line, no failing test. These assertions read the iOS source
// itself, so a rename or a reshaped URL on either side breaks a build instead of a tap.
//
// The iOS half of the same contract lives in
// ios/SocraticTradeTests/PushNotificationTests.swift (PushDeepLinkContractTests): it asserts every
// URL in the table routes to the stated tab. This file asserts the server actually EMITS those
// URLs, for exactly those event types.

import crypto, { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { getDb, registerDeviceToken, setNotifyPrefs, listActiveDeviceTokens } from "../src/lib/db";
import { invalidateApnsProviderToken, type ApnsConfig, type ApnsHttpRequest, type ApnsTransport } from "../src/lib/apns";
import type { NotifyConfig } from "../src/lib/notify";
import { sendNotification } from "../src/lib/notifications";
import { pushDeepLink, pushRoutingData } from "../src/lib/push-deep-links";
import { NOTIFICATION_EVENT_TYPES, type NotificationEventType } from "../src/lib/types";

const REPO_ROOT = join(__dirname, "..");
const SWIFT_CONTRACT = join(REPO_ROOT, "ios/SocraticTradeTests/PushNotificationTests.swift");
const SWIFT_CLIENT = join(REPO_ROOT, "ios/SocraticTrade/MobileAPIClient.swift");
const SWIFT_PUSH = join(REPO_ROOT, "ios/SocraticTrade/PushNotifications.swift");
const SWIFT_ROUTER = join(REPO_ROOT, "ios/SocraticTrade/DeepLink.swift");

const read = (path: string) => readFileSync(path, "utf8");

interface ContractRow {
  event: string;
  url: string;
  tab: string;
  proposalId?: string;
}

/** Parse the Swift contract table. The rows are the shared artifact; neither language owns it. */
function iosContractRows(): ContractRow[] {
  const source = read(SWIFT_CONTRACT);
  const pattern = /^\s*Row\("([a-z_]+)",\s*"([^"]+)",\s*\.(\w+)(?:,\s*"([^"]+)")?\)/gm;
  const rows: ContractRow[] = [];
  for (const match of source.matchAll(pattern)) {
    rows.push({ event: match[1], url: match[2], tab: match[3], ...(match[4] ? { proposalId: match[4] } : {}) });
  }
  return rows;
}

/** A representative payload per event type — the shape the real senders build (see the
 *  `sendNotification({ type: ... })` call sites in strategy.ts / strategy-execution.ts /
 *  alerts.ts). Anything not listed carries no routing ids, which is the point: it must still
 *  produce a URL the app can route. */
const PROPOSAL_ID = "6a1f0f1e-2f2a-4c8b-9d0e-3b7a5c1d2e4f";
const PAYLOADS: Partial<Record<NotificationEventType, unknown>> = {
  pending_approval: { proposalId: PROPOSAL_ID, proposal: { symbol: "AAPL", side: "buy" } },
  proposal_withdrawn: { proposalId: PROPOSAL_ID, proposal: { symbol: "AAPL", side: "buy" } },
  fill: { proposalId: PROPOSAL_ID, fill: { symbol: "AAPL", side: "buy", status: "filled" } },
  limit_order_stale: { symbol: "NVDA" },
  price_alert: { alert: { id: "alert-42", symbol: "TSLA" }, currentPrice: 1 }
};

describe("push deep links: the URLs the server emits are the ones the iOS router accepts", () => {
  const rows = iosContractRows();

  it("parses the iOS contract table (a silent parse failure would make this whole file vacuous)", () => {
    expect(rows.length).toBeGreaterThan(10);
    for (const row of rows) {
      expect(row.url.startsWith("https://socratictrade.com/console/")).toBe(true);
    }
  });

  it("covers every NotificationEventType exactly once — a new event type cannot skip the contract", () => {
    const listed = rows.map((row) => row.event).sort();
    expect(listed).toEqual([...NOTIFICATION_EVENT_TYPES].sort());
    expect(new Set(listed).size).toBe(listed.length);
  });

  it("emits exactly the URL the app is pinned to, for every event type", () => {
    for (const row of rows) {
      const payload = PAYLOADS[row.event as NotificationEventType] ?? {};
      expect(pushDeepLink(row.event, payload, "https://socratictrade.com"), row.event).toBe(row.url);
    }
  });

  // These are the parser's actual rules (ios/SocraticTrade/DeepLink.swift). Re-stating them here
  // as assertions over the emitted URL is what makes a server-side change fail on the server side,
  // where the change is being made, rather than only in the Xcode suite.
  it("every emitted URL satisfies the router's structural rules: https, the one claimed host, /console/<screen>", () => {
    const routableScreens = ["approvals", "orders", "watchlist", "activity"];
    // The screens really are the ones the Swift router switches on — not a list that drifted.
    for (const screen of routableScreens) {
      expect(read(SWIFT_ROUTER)).toContain(`"${screen}"`);
    }
    for (const row of rows) {
      const url = new URL(row.url);
      expect(url.protocol, row.event).toBe("https:");
      expect(url.host, row.event).toBe("socratictrade.com");
      const segments = url.pathname.split("/").filter(Boolean);
      // Exactly two: the router rejects bare `/console` and anything deeper than /console/<screen>
      // (except an /console/approvals/<id> form the server does not emit).
      expect(segments.length, `${row.event} -> ${row.url}`).toBe(2);
      expect(segments[0], row.event).toBe("console");
      expect(routableScreens, row.event).toContain(segments[1]);
    }
  });

  it("carries the proposal id the app extracts, in the query key the app reads", () => {
    for (const row of rows.filter((r) => r.proposalId)) {
      expect(new URL(row.url).searchParams.get("proposal"), row.event).toBe(row.proposalId);
    }
  });

  it("pins the deep-link origin to the single host the app claims", () => {
    // DeepLink.universalLinkHost is an exact-match check — `www.`, a subdomain, or http all mean
    // no routing at all, so the default origin is not a cosmetic choice. The router derives it
    // from the single production base URL so the origin can't drift from the API client; pin
    // both halves of that chain.
    expect(read(SWIFT_ROUTER)).toContain("universalLinkHost = MobileAPIClient.productionBaseURL.host!");
    expect(read(SWIFT_CLIENT)).toContain('productionBaseURL = URL(string: "https://socratictrade.com")!');
    expect(pushDeepLink("run_failed", {})).toBe("https://socratictrade.com/console/activity?tab=alerts");
  });

  it("delivers the link under a payload key the app actually reads", () => {
    // PushPayload.linkKeys, in priority order. The server writes `url` at the payload root.
    const linkKeys = read(SWIFT_PUSH).match(/linkKeys = \[([^\]]+)\]/);
    expect(linkKeys).not.toBeNull();
    expect(linkKeys?.[1]).toContain('"url"');
  });
});

// ── End-to-end: a real notification through the real channel to the wire ──────

const testKeyPem = crypto
  .generateKeyPairSync("ec", { namedCurve: "P-256" })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();

const apnsConfig: ApnsConfig = {
  keyId: "KEY123456",
  teamId: "CC8UTF7ATG",
  bundleId: "com.socratictrade.ios",
  privateKeyPem: testKeyPem
};

const notifyConfig: NotifyConfig = {
  timeoutMs: 1000,
  retryAttempts: 1,
  retryDelayMs: 0,
  push: { ntfyServer: "https://ntfy.example" },
  pushover: { pushoverToken: "" },
  email: { provider: "resend", resendKey: "", from: "" },
  sms: { twilioSid: "", twilioToken: "", twilioFrom: "" },
  apns: apnsConfig
};

const hexToken = (seed: string) => crypto.createHash("sha256").update(seed).digest("hex");

beforeEach(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-apns-contract-${randomUUID()}.db`)}`;
  invalidateApnsProviderToken();
  getDb();
});

describe("end-to-end: a proposal awaiting approval, from sendNotification to the iOS destination", () => {
  it("puts the exact contract URL on the wire, and the app's parser turns it into the Proposals tab", async () => {
    const userId = `u-${randomUUID()}`;
    registerDeviceToken({
      userId,
      token: hexToken("contract-e2e"),
      environment: "production",
      bundleId: "com.socratictrade.ios"
    });
    setNotifyPrefs(userId, { channels: ["apns"] });

    const calls: ApnsHttpRequest[] = [];
    const transport: ApnsTransport = async (req) => {
      calls.push(req);
      return { status: 200, body: "" };
    };

    const event = await sendNotification(
      {
        type: "pending_approval",
        title: "AAPL buy awaiting approval",
        payload: PAYLOADS.pending_approval
      },
      { userId, notifyDeps: { config: notifyConfig, apnsTransport: transport } }
    );

    expect(event.status).toBe("sent");
    expect(calls).toHaveLength(1);

    // 1. The endpoint is the PRODUCTION gateway, because the registered token said production.
    //    (Sending a production token to the sandbox host is answered 400 BadDeviceToken.)
    expect(calls[0].origin).toBe("https://api.push.apple.com");
    expect(calls[0].path).toBe(`/3/device/${listActiveDeviceTokens(userId)[0].token}`);
    expect(calls[0].headers["apns-topic"]).toBe("com.socratictrade.ios");

    // 2. The payload carries the link at the root `url` key PushPayload reads first.
    const body = JSON.parse(calls[0].body) as Record<string, unknown>;
    const url = body.url as string;
    const row = iosContractRows().find((r) => r.event === "pending_approval");
    expect(row).toBeDefined();
    expect(url).toBe(row?.url);

    // 3. What DeepLink.destination(for:) does with it, re-expressed: /console/approvals with a
    //    `proposal` query id -> the Proposals tab, focused on that proposal.
    const parsed = new URL(url);
    expect(parsed.pathname).toBe("/console/approvals");
    expect(parsed.searchParams.get("proposal")).toBe(PROPOSAL_ID);
    expect(row?.tab).toBe("proposals");
    expect(row?.proposalId).toBe(PROPOSAL_ID);

    // 4. The same ids ride as top-level fields, so a client can route without parsing the URL.
    expect(body.kind).toBe("pending_approval");
    expect(body.proposalId).toBe(PROPOSAL_ID);
    expect(pushRoutingData("pending_approval", PAYLOADS.pending_approval).symbol).toBe("AAPL");
  });
});

// ── Registration: the request the app sends vs what the route accepts ─────────

describe("device registration: the iOS request is the request the server validates", () => {
  const iosClient = read(SWIFT_CLIENT);
  const iosPush = read(SWIFT_PUSH);

  it("uses the path and verbs the route exports", () => {
    expect(iosClient).toContain('request(path: "/api/mobile/push/register", method: "POST")');
    expect(iosClient).toContain('request(path: "/api/mobile/push/register", method: "DELETE")');
  });

  it('sends the environment strings the server switches on — "sandbox" and "production"', () => {
    // APNSEnvironment is a String enum, so the case names ARE the wire values.
    expect(iosPush).toMatch(/enum APNSEnvironment: String/);
    expect(iosPush).toMatch(/case sandbox\b/);
    expect(iosPush).toMatch(/case production\b/);
    expect(iosPush).toContain('["token": token, "environment": environment.rawValue]');
    expect(iosPush).toContain('body["bundleId"] = bundleId');
  });

  it("accepts that exact body, and refuses a guessed environment", async () => {
    const { POST, DELETE } = await import("../app/api/mobile/push/register/route");
    process.env.APNS_KEY_ID = "KEY123456";
    process.env.APNS_TEAM_ID = "CC8UTF7ATG";
    process.env.APNS_BUNDLE_ID = "com.socratictrade.ios";
    process.env.APNS_PRIVATE_KEY_B64 = Buffer.from(testKeyPem).toString("base64");

    const email = `contract-${randomUUID()}@example.com`;
    const call = (method: string, body: unknown) =>
      new Request("https://socratictrade.com/api/mobile/push/register", {
        method,
        headers: { "x-authenticated-user-email": email, "content-type": "application/json" },
        body: JSON.stringify(body)
      });

    // Exactly what PushRegistrationRequest.jsonBody produces: lowercase hex token, the
    // environment raw value, and the app's own bundle identifier.
    const token = hexToken("contract-register");
    const ok = await POST(call("POST", { token, environment: "production", bundleId: "com.socratictrade.ios" }));
    expect(ok.status).toBe(200);

    // The app can only ever send these two; anything else is a client bug and must not be stored.
    for (const environment of ["sandbox", "production"]) {
      expect((await POST(call("POST", { token, environment, bundleId: "com.socratictrade.ios" }))).status).toBe(200);
    }
    expect((await POST(call("POST", { token, environment: "prod" }))).status).toBe(400);

    // Sign-out: the client sends only the token, and the row goes.
    const removed = await DELETE(call("DELETE", { token }));
    expect(await removed.json()).toEqual({ ok: true, removed: true });
  });
});
