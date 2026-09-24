// Out-of-app delivery for triggered alerts (and any future server-originated notice). Pluggable
// channels — phone push (ntfy/Pushover), webhook, email (Resend), SMS (Twilio) — each gated by
// admin config (server env) except webhook, which only needs a user-supplied URL. The user picks
// channels + per-channel targets in Settings (notification_prefs table); the dispatcher delivers to
// every enabled channel that is both admin-available and has a target. All network calls go through
// an injectable `fetchImpl` so tests stay offline. Ported from reference/atlas-public-src/bff/notify.

import {
  apnsConfigured,
  loadApnsConfig,
  sendApnsPush,
  type ApnsConfig,
  type ApnsTransport
} from "./apns";
import {
  audit,
  disableDeviceToken,
  getNotifyPrefs,
  getNotifyPrefsSecrets,
  listActiveDeviceTokens,
  maskDeviceToken,
  touchDeviceToken
} from "./db";
import { validateWebhookUrl, type HostResolver } from "./egress-guard";
import { pushCollapseId, pushDeepLink, pushRoutingData } from "./push-deep-links";
import type {
  NotifyChannelDescriptor,
  NotifyChannelId,
  NotifyChannelResult,
  NotifyMessage,
  NotifyPrefs
} from "./types";

export interface NotifyConfig {
  timeoutMs: number;
  /** Total delivery attempts per channel (>=1). A transient failure ("fetch failed"/timeout/5xx/429)
   *  is retried up to this many times so a single network blip never silently drops a critical alert
   *  (block / run_failed / LLM-timeout). Non-transient failures (4xx, bad URL) are NOT retried. */
  retryAttempts: number;
  /** Base backoff between retries in ms (multiplied by the attempt number). 0 disables the wait. */
  retryDelayMs: number;
  push: { ntfyServer: string };
  pushover: { pushoverToken: string };
  email: { provider: "resend"; resendKey: string; from: string };
  sms: { twilioSid: string; twilioToken: string; twilioFrom: string };
  /** Native iOS push credentials (APNS_* env). `null` when the operator has not configured APNs —
   *  the channel then reports "not configured" instead of failing sends. Optional on the type so
   *  existing hand-built NotifyConfig literals (tests, callers) stay valid. */
  apns?: ApnsConfig | null;
}

/** Optional cooperative cancellation/fencing for a durable caller. Existing callers omit both. */
export interface NotifyDispatchDeps {
  config?: NotifyConfig;
  fetchImpl?: typeof fetch;
  prefs?: NotifyPrefs;
  /** Re-proves durable ownership before and after every async or persistent delivery boundary. */
  assertActive?: () => void;
  /** Aborts an in-flight request or retry wait when the caller's durable ownership moves. */
  signal?: AbortSignal;
  /** Injectable DNS resolver for the webhook channel's egress guard (SSRF hardening — see
   *  src/lib/egress-guard.ts). Defaults to real DNS; tests inject a stub so they never
   *  depend on real network/DNS and can simulate rebinding. */
  resolveHost?: HostResolver;
  /** Injectable APNs HTTP/2 transport so tests never open a socket to Apple. */
  apnsTransport?: ApnsTransport;
}

/** Admin-side delivery config from env. End-user secrets never live here — only in notification_prefs. */
export function loadNotifyConfig(): NotifyConfig {
  const timeoutMs = Number(process.env.NOTIFY_TIMEOUT_MS ?? 5000);
  const retryAttempts = Number(process.env.NOTIFY_RETRY_ATTEMPTS ?? 3);
  const retryDelayMs = Number(process.env.NOTIFY_RETRY_DELAY_MS ?? 400);
  return {
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 5000,
    retryAttempts: Number.isFinite(retryAttempts) && retryAttempts >= 1 ? Math.floor(retryAttempts) : 3,
    retryDelayMs: Number.isFinite(retryDelayMs) && retryDelayMs >= 0 ? retryDelayMs : 400,
    push: {
      ntfyServer: process.env.NOTIFY_NTFY_SERVER ?? "https://ntfy.sh"
    },
    pushover: {
      // Subject-app token (PUSHOVER_ST_API_TOKEN) is the live ST identity; PUSHOVER_APP_TOKEN
      // remains the generic alias.  Either one is enough to send.
      pushoverToken: process.env.PUSHOVER_APP_TOKEN || process.env.PUSHOVER_ST_API_TOKEN || ""
    },
    email: {
      provider: "resend",
      resendKey: process.env.RESEND_API_KEY ?? "",
      from: process.env.NOTIFY_EMAIL_FROM ?? ""
    },
    sms: {
      twilioSid: process.env.TWILIO_ACCOUNT_SID ?? "",
      twilioToken: process.env.TWILIO_AUTH_TOKEN ?? "",
      twilioFrom: process.env.TWILIO_FROM ?? ""
    },
    apns: loadApnsConfig()
  };
}

/**
 * Per-user effective config (owner directive 2026-07-31): Pushover/Twilio
 * credentials are user-specific and configured in Settings → Delivery
 * (notification_prefs, encrypted at rest). A stored user value WINS over the
 * server env; an unset field falls back to env, so operator-configured env
 * keeps working for users who haven't pasted their own.
 */
/** Operator Pushover user key: Settings target wins, then env. */
export function operatorPushoverUserKey(prefs: NotifyPrefs): string {
  return prefs.pushoverTarget?.trim() || process.env.PUSHOVER_USER_KEY?.trim() || "";
}

/** True when a Pushover send would actually be attempted. */
export function isPushoverDeliverable(prefs: NotifyPrefs, cfg: NotifyConfig): boolean {
  return Boolean(cfg.pushover.pushoverToken?.trim() && operatorPushoverUserKey(prefs));
}

export function loadUserNotifyConfig(userId: string, base: NotifyConfig = loadNotifyConfig()): NotifyConfig {
  const secrets = getNotifyPrefsSecrets(userId);
  return {
    ...base,
    pushover: {
      pushoverToken: secrets.pushoverAppToken || base.pushover.pushoverToken
    },
    sms: {
      twilioSid: secrets.twilioAccountSid || base.sms.twilioSid,
      twilioToken: secrets.twilioAuthToken || base.sms.twilioToken,
      twilioFrom: secrets.twilioFrom || base.sms.twilioFrom
    }
  };
}

interface ChannelSendContext {
  cfg: NotifyConfig;
  fetchImpl: typeof fetch;
  timeoutMs: number;
  signal?: AbortSignal;
  resolveHost?: HostResolver;
  /** The user this delivery belongs to — needed by channels whose target is app-managed rather
   *  than a prefs string (apns reads the device-token registry). */
  userId: string;
  apnsTransport?: ApnsTransport;
}

interface ChannelDef {
  available(cfg: NotifyConfig): boolean;
  target(prefs: NotifyPrefs): string;
  /** Optional override for channels whose delivery target is app-managed rather than a
   *  user-typed prefs string. Returning "" means "no target" (the channel is skipped). MUST NOT
   *  throw — a registry hiccup has to degrade to "no target", never break the dispatch loop. */
  resolveTarget?(ctx: { userId: string; prefs: NotifyPrefs }): string;
  describe(cfg: NotifyConfig): NotifyChannelDescriptor;
  send(target: string, msg: NotifyMessage, ctx: ChannelSendContext): Promise<void>;
}

function abortSignal(ms: number, callerSignal?: AbortSignal): AbortSignal | undefined {
  const timeoutSignal = typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
    ? AbortSignal.timeout(ms)
    : undefined;
  if (!callerSignal) return timeoutSignal;
  if (!timeoutSignal) return callerSignal;
  return typeof AbortSignal.any === "function"
    ? AbortSignal.any([callerSignal, timeoutSignal])
    : callerSignal;
}

/** Delivery failures worth retrying: transient network/timeout errors and 5xx/429 upstreams. A 4xx
 *  (bad target, auth) or a malformed-URL throw is permanent — retrying it just wastes attempts. */
function isTransientDeliveryError(message: string): boolean {
  return /fetch failed|timed? ?out|timeout|abort|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|network|socket|HTTP 429|HTTP 5\d\d/i.test(message);
}

function assertNotifyActive(deps: NotifyDispatchDeps): void {
  // Run the durable proof first: RAG callers wrap its failure in their typed lease-loss error.
  deps.assertActive?.();
  if (!deps.signal?.aborted) return;
  throw deps.signal.reason instanceof Error
    ? deps.signal.reason
    : new Error("Notification delivery ownership was lost.");
}

async function guardedNotifySleep(ms: number, deps: NotifyDispatchDeps): Promise<void> {
  assertNotifyActive(deps);
  if (ms <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(finish, ms);
    function finish() {
      deps.signal?.removeEventListener("abort", abort);
      resolve();
    }
    function abort() {
      clearTimeout(timer);
      deps.signal?.removeEventListener("abort", abort);
      reject(
        deps.signal?.reason instanceof Error
          ? deps.signal.reason
          : new Error("Notification retry ownership was lost.")
      );
    }
    deps.signal?.addEventListener("abort", abort, { once: true });
    if (deps.signal?.aborted) abort();
  });
  assertNotifyActive(deps);
}

async function postOrThrow(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  callerSignal?: AbortSignal
): Promise<Response> {
  const res = await fetchImpl(url, { ...init, signal: abortSignal(timeoutMs, callerSignal) });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}${detail ? ": " + detail.slice(0, 200) : ""}`);
  }
  return res;
}

// Duplicated (not imported) from notifications.ts's sanitizePushHeaderText to avoid a
// notify.ts <-> notifications.ts import cycle (notifications.ts already imports `notify` from
// this file). Keep the two copies in sync if the character set changes. See the ntfy branch of
// CHANNELS.push.send below for why this exists (ByteString-only HTTP header values).
const NTFY_TITLE_TRANSLITERATIONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/[\u2012\u2013\u2014\u2015]/g, "-"], // figure/en/em/horizontal-bar dashes
  [/\u2026/g, "..."], // horizontal ellipsis
  [/[\u2192\u21D2\u27F6\u279D\u27A1]/g, "->"], // rightwards arrow variants
  [/[\u2190\u21D0\u27F5]/g, "<-"], // leftwards arrow variants
  [/[\u2018\u2019]/g, "'"], // curly single quotes
  [/[\u201C\u201D]/g, '"'] // curly double quotes
];

export const NOTIFY_EMAIL_SENT_BY = "(sent by Socratic-Trade)";

/** Plain-text Resend body.  Footer names the sending app so a shared From address cannot hide it. */
export function formatNotifyEmailText(title: string, body: string): string {
  return `${title}\n\n${body}\n\n${NOTIFY_EMAIL_SENT_BY}`;
}

function sanitizeNtfyTitleHeader(text: string): string {
  if (!text) return text;
  let out = text;
  for (const [pattern, replacement] of NTFY_TITLE_TRANSLITERATIONS) {
    out = out.replace(pattern, replacement);
  }
  return out.replace(/[^\u0000-\u00FF]/g, "");
}

const CHANNELS: Record<NotifyChannelId, ChannelDef> = {
  webhook: {
    available: () => true,
    target: (p) => p.webhookUrl || "",
    describe: () => ({
      id: "webhook",
      label: "Webhook",
      available: true,
      targetField: "webhookUrl",
      targetLabel: "Webhook URL",
      placeholder: "https://example.com/hooks/alerts",
      hint: "We POST a JSON payload here when an alert fires."
    }),
    async send(url, msg, { fetchImpl, timeoutMs, signal, resolveHost }) {
      // Re-validate on every send (not just when the URL was saved) so a target that has
      // since been re-pointed at a private/internal address (DNS rebinding, or a stale
      // saved value) is still caught immediately before the outbound request. See
      // src/lib/egress-guard.ts.
      const check = await validateWebhookUrl(url, { resolveHost });
      if (!check.ok) throw new Error(check.error ?? "webhook URL is not allowed");
      await postOrThrow(
        fetchImpl,
        url,
        {
          method: "POST",
          headers: { "content-type": "application/json", "user-agent": "SocraticTrade-Alerts/1" },
          body: JSON.stringify({
            source: "socratic-trade",
            kind: msg.kind ?? "alert",
            title: msg.title,
            body: msg.body,
            data: msg.data ?? null,
            sent_at: new Date().toISOString()
          }),
          // Never transparently follow a redirect to an unvalidated target — a 3xx response is
          // surfaced as an opaque, non-ok response instead (postOrThrow then throws normally).
          redirect: "manual"
        },
        timeoutMs,
        signal
      );
    }
  },

  push: {
    available: () => true,
    target: (p) => p.pushTarget || "",
    describe: (cfg) => ({
      id: "push",
      label: "ntfy.sh",
      available: true,
      targetField: "pushTarget",
      targetLabel: "ntfy topic",
      placeholder: "alerts-yourname-7c3f",
      hint: `Free — no key needed. Install the ntfy app, subscribe to a hard-to-guess topic, then paste that exact topic here (server: ${cfg.push.ntfyServer}).`
    }),
    async send(target, msg, { cfg, fetchImpl, timeoutMs, signal }) {
      const base = cfg.push.ntfyServer.replace(/\/+$/, "");
      const topic = encodeURIComponent(target.replace(/^\/+/, ""));
      await postOrThrow(
        fetchImpl,
        `${base}/${topic}`,
        // ntfy carries the title as a raw HTTP header value, which the Fetch/Headers spec requires
        // to be ByteString (Latin-1 only) — an em dash or other non-Latin-1 char in msg.title (e.g.
        // from a provider-health alert string) throws `TypeError: Cannot convert argument to a
        // ByteString` here and silently drops the whole push send. Sanitize just the header value
        // (the body isn't header-encoded, so it can stay as-is).
        { method: "POST", headers: { "content-type": "text/plain", title: sanitizeNtfyTitleHeader(msg.title) }, body: msg.body },
        timeoutMs,
        signal
      );
    }
  },

  // Native iOS push. Unlike every other channel, its target is NOT a user-typed string: it is the
  // set of device tokens the iOS app registered via POST /api/mobile/push/register. The channel is
  // "available" when the operator configured the APNs credential set (APNS_* env) and has a target
  // when the user has at least one live device token.
  //
  // Per-event gating is NOT re-implemented here. Push sits behind the SAME gate as every other
  // channel: sendNotification (src/lib/notifications.ts) checks the user's
  // policy.notificationSettings.enabledEvents before it ever calls notify(), so an event the user
  // turned off never reaches this code. Adding a second enabledEvents-like concept for push would
  // be a parallel pipeline, which is exactly what this design avoids.
  apns: {
    available: (cfg) => apnsConfigured(cfg.apns),
    // Never used — resolveTarget below owns this channel's targeting.
    target: () => "",
    resolveTarget: ({ userId }) => {
      try {
        // The count, not the tokens: this string flows into skip/result bookkeeping, and a device
        // token must never end up in a log line or an audit row.
        const count = listActiveDeviceTokens(userId).length;
        return count > 0 ? String(count) : "";
      } catch {
        return "";
      }
    },
    describe: (cfg) => ({
      id: "apns",
      label: "iPhone push",
      available: apnsConfigured(cfg.apns),
      targetField: "",
      targetLabel: "Registered devices",
      placeholder: "",
      hint: "Alerts arrive as native iPhone notifications. Devices register themselves when you allow notifications in the Socratic-Trade app — there is nothing to paste here.",
      managedTarget: true
    }),
    async send(_target, msg, { cfg, timeoutMs, userId, apnsTransport }) {
      const config = cfg.apns;
      if (!apnsConfigured(config)) throw new Error("APNs is not configured.");
      const devices = listActiveDeviceTokens(userId);
      if (devices.length === 0) throw new Error("No registered devices.");

      const kind = msg.kind ?? "alert";
      const routing = pushRoutingData(kind, msg.data);
      const url = pushDeepLink(kind, msg.data);
      const collapseId = pushCollapseId(kind, msg.data);

      let delivered = 0;
      const failures: string[] = [];
      for (const device of devices) {
        const result = await sendApnsPush(
          {
            deviceToken: device.token,
            environment: device.environment,
            // Per-device topic so old TF (trade.socratic.app) and new TF
            // (trade.socratic.ios) both receive pushes during coexistence.
            topic: device.bundleId,
            title: msg.title,
            // APNs caps the whole payload at 4KB; a digest-sized body would blow it.
            body: msg.body.slice(0, CHANNEL_CAPABILITIES.apns.maxBodyChars),
            url,
            ...(collapseId ? { collapseId } : {}),
            data: { kind, ...routing }
          },
          { config, transport: apnsTransport, timeoutMs }
        );
        if (result.ok) {
          delivered += 1;
          touchDeviceToken(device.token);
          continue;
        }
        if (result.disposition === "token_dead") {
          // Apple says this install is gone (410 Unregistered) or the token is invalid for this
          // environment (400 BadDeviceToken). Retire it — retrying it forever is pure waste.
          disableDeviceToken(device.token, `apns ${result.status ?? ""} ${result.reason ?? ""}`.trim());
          audit("push.apns.token_retired", {
            userId,
            token: maskDeviceToken(device.token),
            environment: device.environment,
            status: result.status,
            reason: result.reason
          }, userId);
          continue;
        }
        if (result.disposition === "auth_error") {
          // A credential/topic problem affects EVERY device — say so loudly rather than burying it
          // as one device's failure.
          audit("push.apns.auth_error", { userId, status: result.status, reason: result.reason }, userId);
          console.error(`[apns] auth/config failure: HTTP ${result.status ?? "?"} ${result.reason ?? ""}`);
        }
        failures.push(`${maskDeviceToken(device.token)}: ${result.error ?? result.disposition}`);
      }

      if (delivered > 0) return;
      if (failures.length === 0) {
        // Every device was retired this pass — nothing left to deliver to, and nothing to retry.
        throw new Error("No live registered devices (all tokens retired).");
      }
      throw new Error(failures.join(" | "));
    }
  },

  pushover: {
    available: (cfg) => !!cfg.pushover.pushoverToken,
    target: (p) => operatorPushoverUserKey(p),
    describe: (cfg) => ({
      id: "pushover",
      label: "Pushover",
      available: CHANNELS.pushover.available(cfg),
      targetField: "pushoverTarget",
      targetLabel: "Pushover user key",
      placeholder: "u1a2b3c4d5...",
      hint: "Install Pushover, then paste your user key. Notices arrive on your phone."
    }),
    async send(target, msg, { cfg, fetchImpl, timeoutMs, signal }) {
      const form = new URLSearchParams({ token: cfg.pushover.pushoverToken, user: target, title: msg.title, message: msg.body });
      await postOrThrow(
        fetchImpl,
        "https://api.pushover.net/1/messages.json",
        { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form.toString() },
        timeoutMs,
        signal
      );
    }
  },

  email: {
    available: (cfg) => cfg.email.provider === "resend" && !!cfg.email.resendKey && !!cfg.email.from,
    target: (p) => p.email || "",
    describe: (cfg) => ({
      id: "email",
      label: "Email",
      available: CHANNELS.email.available(cfg),
      targetField: "email",
      targetLabel: "Email address",
      placeholder: "you@example.com",
      hint: "Alerts are emailed to this address."
    }),
    async send(to, msg, { cfg, fetchImpl, timeoutMs, signal }) {
      const subject = msg.title.startsWith("[Socratic-Trade]") ? msg.title : `[Socratic-Trade] ${msg.title}`;
      await postOrThrow(
        fetchImpl,
        "https://api.resend.com/emails",
        {
          method: "POST",
          headers: { authorization: `Bearer ${cfg.email.resendKey}`, "content-type": "application/json" },
          body: JSON.stringify({
            from: cfg.email.from,
            to: [to],
            subject,
            text: formatNotifyEmailText(msg.title, msg.body)
          })
        },
        timeoutMs,
        signal
      );
    }
  },

  sms: {
    available: (cfg) => !!cfg.sms.twilioSid && !!cfg.sms.twilioToken && !!cfg.sms.twilioFrom,
    target: (p) => p.phone || "",
    describe: (cfg) => ({
      id: "sms",
      label: "SMS",
      available: CHANNELS.sms.available(cfg),
      targetField: "phone",
      targetLabel: "Mobile number",
      placeholder: "+14155551234",
      hint: "Standard carrier message rates may apply."
    }),
    async send(to, msg, { cfg, fetchImpl, timeoutMs, signal }) {
      const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(cfg.sms.twilioSid)}/Messages.json`;
      const authToken = Buffer.from(`${cfg.sms.twilioSid}:${cfg.sms.twilioToken}`).toString("base64");
      const form = new URLSearchParams({ From: cfg.sms.twilioFrom, To: to, Body: `${msg.title}\n${msg.body}`.slice(0, 1500) });
      try {
        await postOrThrow(
          fetchImpl,
          url,
          { method: "POST", headers: { authorization: `Basic ${authToken}`, "content-type": "application/x-www-form-urlencoded" }, body: form.toString() },
          timeoutMs,
          signal
        );
      } catch (e) {
        const errStr = e instanceof Error ? e.message : String(e);
        if (errStr.includes("30034") || errStr.includes("Message cannot be sent")) {
          throw new Error("Twilio A2P 10DLC restriction: SMS blocked until sender registration is verified. " + errStr);
        }
        throw e;
      }
    }
  }
};

const CHANNEL_ORDER: NotifyChannelId[] = ["apns", "push", "pushover", "webhook", "email", "sms"];

/**
 * Per-channel body length budget for tiered delivery (NotifyMessage.bodyTiers). sms matches the
 * SMS channel's own existing `.slice(0, 1500)` above (kept in sync deliberately, not derived, so
 * a future change to one is easy to spot missing the other). email/webhook are "effectively
 * unbounded" for a digest-sized body — generous caps, not the provider's real limit.
 */
export const CHANNEL_CAPABILITIES: Record<NotifyChannelId, { maxBodyChars: number }> = {
  // APNs caps the ENTIRE payload (title + body + routing data + JSON overhead) at 4KB; 2000 chars
  // of body leaves generous headroom for the rest.
  apns: { maxBodyChars: 2000 },
  sms: { maxBodyChars: 1500 },
  pushover: { maxBodyChars: 1024 },
  push: { maxBodyChars: 4000 },
  email: { maxBodyChars: 100_000 },
  webhook: { maxBodyChars: 100_000 }
};

/**
 * Pick the LARGEST tier that fits `channelId`'s cap, falling back to the smallest available tier
 * (letting that channel's own existing truncation — e.g. sms's slice — handle the rest) when even
 * `brief` doesn't fit. Returns `msg.body` unchanged when bodyTiers is absent, so every existing
 * single-body caller is byte-for-byte unaffected.
 */
function selectTieredBody(msg: NotifyMessage, channelId: NotifyChannelId): string {
  const tiers = msg.bodyTiers;
  if (!tiers) return msg.body;
  const cap = CHANNEL_CAPABILITIES[channelId].maxBodyChars;
  const ordered = [tiers.full, tiers.medium, tiers.brief].filter(
    (t): t is string => typeof t === "string"
  );
  return ordered.find((t) => t.length <= cap) ?? ordered[ordered.length - 1] ?? msg.body;
}

/** UI metadata: which channels exist, which are admin-usable, and the target each needs. */
export function describeChannels(cfg: NotifyConfig = loadNotifyConfig()): NotifyChannelDescriptor[] {
  return CHANNEL_ORDER.map((id) => CHANNELS[id].describe(cfg));
}

/**
 * Deliver `msg` to every channel the user enabled that is both admin-available and has a target.
 * Native iOS push is included whenever this user has a live device token and APNs is configured,
 * even if `prefs.channels` omitted `apns` — account notices must reach the app, not only Pushover.
 * Returns a per-channel result list and, for ordinary callers, never throws — a failing channel is
 * recorded and the others run. A guarded caller's ownership/cancellation error is control flow and
 * is deliberately rethrown before retries, later channels, or per-channel audit writes.
 */
export function channelsForNotify(
  userId: string,
  prefs: NotifyPrefs,
  cfg: NotifyConfig
): NotifyChannelId[] {
  const requested: NotifyChannelId[] = [...(prefs.channels ?? [])];
  let hasTokens = false;
  try {
    hasTokens = listActiveDeviceTokens(userId).length > 0;
  } catch {
    hasTokens = false;
  }
  if (CHANNELS.apns.available(cfg) && hasTokens && !requested.includes("apns")) {
    requested.unshift("apns");
  }
  const skipEmail = isPushoverDeliverable(prefs, cfg);
  return skipEmail ? requested.filter((id) => id !== "email") : requested;
}

export async function notify(
  userId: string,
  msg: NotifyMessage,
  deps: NotifyDispatchDeps = {}
): Promise<NotifyChannelResult[]> {
  assertNotifyActive(deps);
  const cfg = deps.config ?? loadUserNotifyConfig(userId);
  const fetchImpl = deps.fetchImpl ?? fetch;
  const prefs = deps.prefs ?? getNotifyPrefs(userId);
  const results: NotifyChannelResult[] = [];
  const channelIds = channelsForNotify(userId, prefs, cfg);
  for (const id of channelIds) {
    assertNotifyActive(deps);
    const channel = CHANNELS[id];
    if (!channel.available(cfg)) {
      assertNotifyActive(deps);
      results.push({ channel: id, ok: false, skipped: "not_configured" });
      continue;
    }
    // App-managed targets (apns: the device-token registry) resolve per-user; everything else
    // reads the user's typed prefs value. resolveTarget is contractually non-throwing, but guard
    // anyway so one channel's registry hiccup can never abort delivery to the others.
    let target = "";
    try {
      target = channel.resolveTarget ? channel.resolveTarget({ userId, prefs }) : channel.target(prefs);
    } catch {
      target = "";
    }
    if (!target) {
      assertNotifyActive(deps);
      results.push({ channel: id, ok: false, skipped: "no_target" });
      continue;
    }
    // bodyTiers (watchlist digest, etc.) picks the largest tier that fits THIS channel's cap; a
    // plain single-body message (bodyTiers absent) passes msg.body through unchanged.
    const channelMsg: NotifyMessage = msg.bodyTiers ? { ...msg, body: selectTieredBody(msg, id) } : msg;
    // Deliver with bounded retry: a transient blip (the ~7% "fetch failed"/timeout to ntfy/resend seen
    // in prod) must not silently drop a critical alert. Permanent failures (4xx/bad target) fail fast.
    const attempts = Math.max(1, cfg.retryAttempts);
    let lastError = "";
    let delivered = false;
    let usedAttempts = 0;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      assertNotifyActive(deps);
      usedAttempts = attempt;
      try {
        await channel.send(target, channelMsg, {
          cfg,
          fetchImpl,
          timeoutMs: cfg.timeoutMs,
          signal: deps.signal,
          resolveHost: deps.resolveHost,
          userId,
          apnsTransport: deps.apnsTransport
        });
        assertNotifyActive(deps);
        delivered = true;
        break;
      } catch (e) {
        // A lease/cancellation failure must not be converted into an ordinary channel failure.
        assertNotifyActive(deps);
        lastError = e instanceof Error ? e.message : String(e);
        if (attempt < attempts && isTransientDeliveryError(lastError)) {
          await guardedNotifySleep(cfg.retryDelayMs * attempt, deps);
          continue;
        }
        break;
      }
    }
    assertNotifyActive(deps);
    if (delivered) {
      results.push({ channel: id, ok: true });
      assertNotifyActive(deps);
      audit("notify.sent", { userId, channel: id, kind: msg.kind ?? "alert", ...(usedAttempts > 1 ? { attempts: usedAttempts } : {}) }, userId);
    } else {
      results.push({ channel: id, ok: false, error: lastError });
      assertNotifyActive(deps);
      audit("notify.error", { userId, channel: id, error: lastError, attempts: usedAttempts }, userId);
    }
  }
  assertNotifyActive(deps);
  return results;
}
