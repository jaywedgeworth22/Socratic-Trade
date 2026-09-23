"use client";

/** Delivery channels — where out-of-app alerts actually go (ntfy.sh,
 *  webhook, email, SMS). Reads GET /api/notifications (channel availability +
 *  saved prefs), writes POST /api/notifications, and exercises every enabled
 *  channel via the existing test endpoint. A channel can only be enabled when
 *  the server operator has configured its provider (e.g. email needs a Resend
 *  key) — unavailable ones say so instead of failing silently.
 *
 *  Auto-saves like every other settings card (owner-directed 2026-07-09):
 *  channel toggles save on change, each channel's target field saves on
 *  blur. saveDeliveryPrefs is a whole-object POST, so every write sends the
 *  full merged prefs (saved ∪ any other in-progress local edits) — never
 *  just the one changed field — so a toggle never drops a pending target
 *  edit in a sibling field, and vice versa. */

import { useCallback, useEffect, useState } from "react";
import { savePolicy, sendTestNotification, ConsoleApiError } from "../lib/api";
import { useAutoSave } from "../lib/useAutoSave";
import { useConsoleData } from "../lib/useConsoleData";
import { useToast } from "../ui/toast";
import { SaveStatus } from "../ui/save-status";
import { Btn, Card, Field, TextInput, Toggle } from "../ui/primitives";
import { SENTENCE_GAP } from "../lib/format";
import {
  fetchDeliverySettings,
  saveDeliveryPrefs,
  EMPTY_DELIVERY_PREFS,
  type DeliveryChannelDescriptor,
  type DeliveryPrefs
} from "./lib";

const CHANNEL_TITLE: Record<DeliveryChannelDescriptor["id"], string> = {
  apns: "Native notifications on your iPhone.  Your devices register themselves when you allow notifications in the Socratic-Trade app.",
  push: "Alerts via ntfy.sh — subscribe to a topic in the ntfy app or any ntfy-compatible client.",
  pushover: "Pushover push notifications to your phone.  Paste your own application API token + user key below — no server setup needed.",
  webhook: "An HTTPS POST with a JSON payload to any URL you control (chat webhooks get rich embeds).",
  email: "An email per alert.  Needs the server operator to have configured an email provider.",
  sms: "A text message per alert.  Uses your own Twilio credentials below, or the server operator's if none are saved here; carrier rates may apply."
};

type TargetField = "pushTarget" | "pushoverTarget" | "webhookUrl" | "email" | "phone";

/** Per-user channel credential fields (write-only secrets; server stores them
 *  encrypted and only ever returns presence flags). */
type SecretField = "pushoverAppToken" | "twilioAccountSid" | "twilioAuthToken" | "twilioFrom";

const SECRET_FIELD_META: Record<SecretField, { label: string; placeholder: string; hint: string; setFlag: "pushoverAppTokenSet" | "twilioAccountSidSet" | "twilioAuthTokenSet" | "twilioFromSet" }> = {
  pushoverAppToken: {
    label: "Pushover application API token",
    placeholder: "azGDORePK8gMaC0QOYAMyEEuzJnyUi",
    hint: "Your own Pushover app token — create one at pushover.net/apps.  Stored encrypted; never shown again.",
    setFlag: "pushoverAppTokenSet"
  },
  twilioAccountSid: {
    label: "Twilio Account SID",
    placeholder: "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    hint: "From your Twilio console.  Stored encrypted; never shown again.",
    setFlag: "twilioAccountSidSet"
  },
  twilioAuthToken: {
    label: "Twilio Auth Token",
    placeholder: "••••••••",
    hint: "From your Twilio console.  Stored encrypted; never shown again.",
    setFlag: "twilioAuthTokenSet"
  },
  twilioFrom: {
    label: "Twilio sender number (From)",
    placeholder: "+14155551234",
    hint: "Your Twilio phone number that alerts are sent from.",
    setFlag: "twilioFromSet"
  }
};

const CHANNEL_SECRET_FIELDS: Partial<Record<DeliveryChannelDescriptor["id"], SecretField[]>> = {
  pushover: ["pushoverAppToken"],
  sms: ["twilioAccountSid", "twilioAuthToken", "twilioFrom"]
};

interface TestResult {
  channel: string;
  ok: boolean;
  skipped?: string;
  error?: string;
}

/** The OLDER, separate webhook mechanism: policy.notificationSettings.webhookUrl
 *  (written via savePolicy, distinct from the Webhook CHANNEL's own target field
 *  above, which lives in NotifyPrefs and is written via saveDeliveryPrefs). This
 *  one fires for every enabled event in Event notifications, unconditionally —
 *  it does not depend on the Webhook channel toggle. Moved here from Event
 *  notifications in the 2026-07-16 IA restructure (UI move only — same
 *  savePolicy write path, same commit-on-blur / revert-on-error semantics) so
 *  both webhook knobs sit together instead of splitting across two cards. */
function WebhookUrlRow() {
  const { snapshot, refresh } = useConsoleData();
  const autoSave = useAutoSave();
  const [localWebhook, setLocalWebhook] = useState<string | null>(null);
  if (!snapshot) return null;

  const current = snapshot.policy.notificationSettings;
  const webhook = localWebhook ?? current.webhookUrl ?? "";

  const commitWebhook = () => {
    const next = webhook.trim();
    if (next === (current.webhookUrl ?? "")) return; // unchanged → no write
    const prev = webhook;
    // Server validates (400 on a non-URL); revert the field on failure.
    autoSave.save(() => savePolicy({ notificationSettings: { webhookUrl: next } }).then(() => refresh()), {
      onError: () => setLocalWebhook(prev),
      errorTitle: "Webhook not saved"
    });
  };

  return (
    <div className="mt-2 max-w-md">
      <Field label="Webhook URL (optional)" hint="Rich embeds for chat webhooks; generic JSON otherwise." htmlFor="webhook">
        <TextInput
          id="webhook"
          value={webhook}
          placeholder="https://…"
          title="Every enabled event in Event notifications above is also POSTed to this URL.  Chat webhooks (Discord/Slack) get rich embeds; anything else gets plain JSON.  Saves when you click away."
          onChange={(e) => setLocalWebhook(e.target.value)}
          onBlur={commitWebhook}
        />
      </Field>
    </div>
  );
}

export function DeliveryChannelsCard() {
  const toast = useToast();
  const autoSave = useAutoSave();
  const [channels, setChannels] = useState<DeliveryChannelDescriptor[] | null>(null);
  const [saved, setSaved] = useState<DeliveryPrefs>(EMPTY_DELIVERY_PREFS);
  // Sticky optimistic overlay: seeded from the loaded snapshot, updated
  // immediately on toggle/blur for instant feedback, reverted per-field by
  // useAutoSave's onError if a write fails.
  const [local, setLocal] = useState<DeliveryPrefs | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [testBusy, setTestBusy] = useState(false);
  const [results, setResults] = useState<TestResult[] | null>(null);
  // In-progress secret edits, keyed by field. Kept OUT of the persisted prefs
  // object until blur — undefined keys are dropped by JSON.stringify, so an
  // untouched secret input never clears the stored server-side value.
  const [secretDrafts, setSecretDrafts] = useState<Partial<Record<SecretField, string>>>({});

  const load = useCallback(async () => {
    try {
      const body = await fetchDeliverySettings();
      setChannels(body.channels ?? []);
      const prefs = { ...EMPTY_DELIVERY_PREFS, ...body.prefs, channels: body.prefs?.channels ?? [] };
      setSaved(prefs);
      setLocal(prefs);
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof ConsoleApiError ? error.message : "Could not load delivery channels.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const prefs = local ?? saved;
  const busy = autoSave.saving || testBusy;

  // Persist the full merged prefs object (whole-object POST) and adopt the
  // server's response as the new saved/local baseline.
  const persist = (next: DeliveryPrefs, opts: { onError: () => void; successToast?: { title: string; detail?: string } }) => {
    autoSave.save(
      async () => {
        const { prefs: persisted } = await saveDeliveryPrefs(next);
        const merged = { ...EMPTY_DELIVERY_PREFS, ...persisted, channels: persisted?.channels ?? [] };
        setSaved(merged);
        setLocal(merged);
      },
      opts
    );
  };

  const toggleChannel = (id: string, on: boolean) => {
    const prevChannels = prefs.channels;
    const nextChannels = on ? Array.from(new Set([...prefs.channels, id])) : prefs.channels.filter((c) => c !== id);
    const next = { ...prefs, channels: nextChannels };
    setLocal(next);
    const label = channels?.find((c) => c.id === id)?.label ?? id;
    persist(next, {
      onError: () => setLocal((l) => (l ? { ...l, channels: prevChannels } : l)),
      successToast: { title: `${label} delivery ${on ? "on" : "off"}` }
    });
  };

  const toggleDigest = (on: boolean) => {
    const prevValue = prefs.watchlistDigestEnabled ?? false;
    const next = { ...prefs, watchlistDigestEnabled: on };
    setLocal(next);
    persist(next, {
      onError: () => setLocal((l) => (l ? { ...l, watchlistDigestEnabled: prevValue } : l)),
      successToast: { title: `Daily Watchlist Digest ${on ? "on" : "off"}` }
    });
  };

  const targetValue = (field: TargetField) => prefs[field];
  const setTarget = (field: TargetField, value: string) => setLocal((l) => ({ ...(l ?? prefs), [field]: value }));

  const commitSecret = (field: SecretField) => {
    const value = (secretDrafts[field] ?? "").trim();
    if (!value) return; // untouched or whitespace → no write, never clear by accident
    const next = { ...prefs, [field]: value };
    persist(next, {
      onError: () => undefined,
      successToast: { title: `${SECRET_FIELD_META[field].label} saved` }
    });
    setSecretDrafts((d) => ({ ...d, [field]: "" }));
  };

  const clearSecret = (field: SecretField) => {
    const next = { ...prefs, [field]: "" };
    persist(next, {
      onError: () => undefined,
      successToast: { title: `${SECRET_FIELD_META[field].label} removed` }
    });
  };

  const commitTarget = (field: TargetField) => {
    const raw = targetValue(field);
    const trimmed = raw.trim();
    const savedValue = saved[field];
    if (trimmed === savedValue) {
      // No real change (or just whitespace trimmed) — no write, but normalize
      // the visible value.
      if (trimmed !== raw) setLocal((l) => (l ? { ...l, [field]: trimmed } : l));
      return;
    }
    const next = { ...prefs, [field]: trimmed };
    setLocal(next);
    persist(next, {
      onError: () => setLocal((l) => (l ? { ...l, [field]: savedValue } : l))
    });
  };

  const sendTest = async () => {
    setTestBusy(true);
    setResults(null);
    try {
      // Fires against whatever's already saved on the server — channels now
      // auto-save on toggle and targets on blur, so there's nothing to
      // persist first.
      const { results: r } = await sendTestNotification();
      setResults(r);
      const sent = r.filter((x) => x.ok).length;
      if (sent > 0) toast.push("pos", `Test sent via ${sent} channel${sent > 1 ? "s" : ""}`, "Check that it actually arrived before trusting real-money alerts.");
      else toast.push("warn", "No channel delivered", "Check the toggles, targets, and the server's provider keys.");
    } catch (error) {
      toast.push("neg", "Test failed", error instanceof ConsoleApiError ? error.message : String(error));
    } finally {
      setTestBusy(false);
    }
  };

  return (
    <Card
      title="Delivery channels"
      action={
        <div className="flex items-center gap-3">
          <SaveStatus status={autoSave.status} />
          <Btn
            size="sm"
            disabled={busy || channels === null}
            onClick={() => void sendTest()}
            title="Fires a test alert through every enabled, saved channel so you can confirm it reaches you."
          >
            {testBusy ? "Sending…" : "Send test"}
          </Btn>
        </div>
      }
    >
      <p className="mb-3 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
        Where alerts leave the app — one setup for your whole login, across every account. Which events fire is chosen
        in Event notifications above; this is how they reach you. Without any channel, events are still recorded in
        Activity, just not pushed anywhere.
      </p>

      <div
        className="con-row mb-3 flex items-center justify-between gap-4 rounded-control border border-[color:var(--con-line)] px-3 py-2.5"
        title="Sends a summary of your whole watchlist once a day, shortly after the US market closes.  Uses only data the app already collected — no extra provider calls."
      >
        <div>
          <div className="text-[length:var(--con-fs-sm)] font-semibold">Daily Watchlist Digest</div>
          <p className="mt-0.5 max-w-xl text-[length:var(--con-fs-xs)] leading-relaxed text-[color:var(--con-muted)]">
            {prefs.watchlistDigestEnabled
              ? <>Sends once a day, after US market close (3:15pm Central).{SENTENCE_GAP}Covers every symbol on your watchlist using only data the app already collected — the last market scan and each symbol&apos;s recent trade proposals.</>
              : <>Off — no digest is sent.{SENTENCE_GAP}Delivered through the channels enabled above.</>}
          </p>
        </div>
        <Toggle
          checked={prefs.watchlistDigestEnabled ?? false}
          disabled={busy}
          label="Daily Watchlist Digest"
          onChange={(next) => toggleDigest(next)}
        />
      </div>

      {loadError && (
        <p className="mb-3 rounded-control border border-[color:var(--con-warn-border)] bg-[color:var(--con-warn-soft)] p-2.5 text-[length:var(--con-fs-xs)]">
          {loadError}{" "}
          <button type="button" className="font-semibold underline" onClick={() => void load()} title="Try loading the channels again.">
            Retry
          </button>
        </p>
      )}

      {channels === null && !loadError && (
        <p className="text-[length:var(--con-fs-sm)] text-[color:var(--con-faint)]">Loading channels…</p>
      )}

      {channels !== null && (
        <div className="flex flex-col gap-2">
          {channels.map((ch) => {
            const on = prefs.channels.includes(ch.id);
            const target = targetValue(ch.targetField as TargetField);
            return (
              <div
                key={ch.id}
                className="rounded-control border border-[color:var(--con-line)] p-3 transition-colors hover:bg-[color:var(--con-surface-2)] focus-within:bg-[color:var(--con-surface-2)]"
              >
                <div className="flex items-center justify-between gap-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[length:var(--con-fs-sm)] font-semibold" title={CHANNEL_TITLE[ch.id]}>
                      {ch.label}
                    </span>
                    {ch.id === "push" && ch.available && ch.provider === "pushover" && (
                      <span
                        className="rounded-full border border-[color:var(--con-pos-border)] bg-[color:var(--con-pos-soft)] px-2 py-0.5 text-[length:var(--con-fs-2xs)] font-bold uppercase tracking-wide text-[color:var(--con-pos)]"
                        title="Push via Pushover — paste your Pushover user key as the target.  Server needs PUSHOVER_APP_TOKEN + NOTIFY_PUSH_PROVIDER=pushover."
                      >
                        pushover
                      </span>
                    )}
                    {!ch.available && (
                      <span
                        className="text-[length:var(--con-fs-xs)] text-[color:var(--con-warn)]"
                        title="No credentials for this channel yet — add your own below, or ask the server operator to configure it."
                      >
                        not configured
                      </span>
                    )}
                  </div>
                  <Toggle
                    checked={on}
                    disabled={!ch.available || busy}
                    onChange={(next) => toggleChannel(ch.id, next)}
                    label={`${ch.label} channel`}
                  />
                </div>
                {/* App-managed target (iPhone push): there is nothing for the user to type — the
                    devices register themselves — so show the explanation, not an empty input. */}
                {on && ch.available && ch.managedTarget && (
                  <p className="mt-2 max-w-md text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">{ch.hint}</p>
                )}
                {on && ch.available && !ch.managedTarget && (
                  <div className="mt-2 max-w-md">
                    <Field label={ch.targetLabel} hint={ch.hint} htmlFor={`ch-${ch.id}`}>
                      <TextInput
                        id={`ch-${ch.id}`}
                        value={typeof target === "string" ? target : ""}
                        placeholder={ch.placeholder}
                        onChange={(e) => setTarget(ch.targetField as TargetField, e.target.value)}
                        onBlur={() => commitTarget(ch.targetField as TargetField)}
                        title={ch.hint}
                      />
                    </Field>
                  </div>
                )}
                {/* Per-user channel credentials (Pushover app token, Twilio set).
                    Always visible for these channels — they are how you make an
                    unavailable channel work without any server-side setup. */}
                {(CHANNEL_SECRET_FIELDS[ch.id] ?? []).length > 0 && (
                  <div className="mt-2 flex max-w-md flex-col gap-2 border-t border-[color:var(--con-line)] pt-2">
                    {(CHANNEL_SECRET_FIELDS[ch.id] ?? []).map((field) => {
                      const meta = SECRET_FIELD_META[field];
                      const isSet = Boolean(prefs[meta.setFlag]);
                      return (
                        <Field
                          key={field}
                          label={meta.label}
                          hint={meta.hint}
                          htmlFor={`cred-${field}`}
                        >
                          <div className="flex items-center gap-2">
                            <TextInput
                              id={`cred-${field}`}
                              type="password"
                              autoComplete="off"
                              value={secretDrafts[field] ?? ""}
                              placeholder={isSet ? "Saved — enter to replace" : meta.placeholder}
                              onChange={(e) => setSecretDrafts((d) => ({ ...d, [field]: e.target.value }))}
                              onBlur={() => commitSecret(field)}
                              title={meta.hint}
                            />
                            {isSet && (
                              <Btn
                                size="sm"
                                variant="ghost"
                                disabled={busy}
                                onClick={() => clearSecret(field)}
                                title={`Remove the saved ${meta.label} (the channel falls back to the server env if one is configured).`}
                              >
                                Remove
                              </Btn>
                            )}
                          </div>
                        </Field>
                      );
                    })}
                  </div>
                )}
                {/* The older, always-on legacy webhook (see WebhookUrlRow above) sits under this
                    channel's toggle regardless of whether the toggle is on — it's a separate
                    field, not the channel's own target. */}
                {ch.id === "webhook" && <WebhookUrlRow />}
              </div>
            );
          })}
        </div>
      )}

      {results && (
        <ul className="mt-3 flex flex-col gap-1 text-[length:var(--con-fs-xs)]">
          {results.length === 0 && <li className="text-[color:var(--con-muted)]">No channels enabled — toggle one above first.</li>}
          {results.map((r, i) => (
            <li
              key={i}
              className={r.ok ? "text-[color:var(--con-pos)]" : "text-[color:var(--con-muted)]"}
              title={r.ok ? "The test message was accepted by the provider." : r.skipped ? "Skipped — the channel is off, has no target, or its provider isn't configured." : r.error ?? "The provider rejected the test."}
            >
              {r.ok ? "✓" : "—"} {r.channel}
              {r.skipped ? ` (${r.skipped.replace(/_/g, " ")})` : r.ok ? " — sent" : ` — failed${r.error ? `: ${r.error}` : ""}`}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
