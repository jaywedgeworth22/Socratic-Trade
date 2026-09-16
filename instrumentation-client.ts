// Browser / client runtime Sentry init. Mirrors sentry.server.config.ts:
// env-gated (off unless NEXT_PUBLIC_SENTRY_DSN is set), PII disabled, and every
// event run through redactForTelemetry — this is a financial app, so nothing
// user-facing (account numbers, keys, tokens) may leave the browser.
import * as Sentry from "@sentry/nextjs";
import { redactForTelemetry } from "./src/lib/telemetry-sanitize";

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

/**
 * Third-party noise only. Keep this list SHORT and every entry justified — a broad
 * pattern here silently hides our own bugs, and on a live trading app a swallowed
 * client error is worse than a noisy one. Nothing thrown by code in this repo
 * belongs here; if an app error is noisy, fix the app error.
 *
 * Exported so test/instrumentation-client.test.ts can assert these stay narrow.
 */
export const SENTRY_CLIENT_IGNORE_ERRORS: RegExp[] = [
  // SOCRATIC-TRADE-2J. Cloudflare's edge-injected Web Analytics/RUM beacon reads
  // the Chromium-only `chrome` global with no typeof guard, so it throws on
  // Safari. A third-party script we do not ship and cannot patch.
  // The apostrophe class covers both U+0027 and U+2019: the events we have carry
  // the straight one, but the message is a browser string we do not control and
  // a one-character miss here silently un-fixes the issue.
  /Can['’]t find variable: chrome/,
  /\bchrome is not defined\b/,
  // Benign layout-loop notices browsers emit, which Sentry's own docs call out as
  // non-actionable; not errors in any user-visible sense.
  /^ResizeObserver loop/
];

/** Errors whose top frame is a browser extension are, by construction, not ours. */
export const SENTRY_CLIENT_DENY_URLS: RegExp[] = [
  /^chrome-extension:\/\//i,
  /^moz-extension:\/\//i,
  /^safari-(web-)?extension:\/\//i
];

if (dsn) {
  // Designer 2026-09-04 update: ST web Session Replay defaults to 10%
  // session / 100% error, mask-all.  Kill switch:
  // NEXT_PUBLIC_SENTRY_REPLAY_ENABLED=false.  Override rates via sample-rate
  // env; do not rely on Coolify-only documentation.
  const replayRaw = process.env.NEXT_PUBLIC_SENTRY_REPLAY_ENABLED?.trim();
  const replayDisabled = replayRaw ? /^(false|0|off|no)$/i.test(replayRaw) : false;
  const replaySessionSampleRate = Number(
    process.env.NEXT_PUBLIC_SENTRY_REPLAY_SESSION_SAMPLE_RATE ?? "0.1"
  );
  const replayErrorSampleRate = Number(
    process.env.NEXT_PUBLIC_SENTRY_REPLAY_ERROR_SAMPLE_RATE ?? "1.0"
  );
  const feedbackRaw = process.env.NEXT_PUBLIC_SENTRY_FEEDBACK_ENABLED?.trim();
  const feedbackDisabled = feedbackRaw ? /^(false|0|off|no)$/i.test(feedbackRaw) : false;

  Sentry.init({
    dsn,
    environment:
      process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT || process.env.NODE_ENV,
    tracesSampleRate: Number(process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE ?? "0.2"),
    enableLogs: true,
    sendDefaultPii: false,
    tracePropagationTargets: [
      "localhost",
      /^https:\/\/([\w-]+\.)?socratictrade\.com/,
      /^https:\/\/([\w-]+\.)?congress\.trade/,
      /^https:\/\/([\w-]+\.)?jays\.services/,
      /^https:\/\/usage\.jays\.services/,
    ],
    ignoreErrors: SENTRY_CLIENT_IGNORE_ERRORS,
    denyUrls: SENTRY_CLIENT_DENY_URLS,
    replaysSessionSampleRate: !replayDisabled ? replaySessionSampleRate : 0,
    replaysOnErrorSampleRate: !replayDisabled ? replayErrorSampleRate : 0,
    integrations: [
      ...(!replayDisabled
        ? [Sentry.replayIntegration({ maskAllText: true, blockAllMedia: true })]
        : []),
      ...(!feedbackDisabled
        ? [
            Sentry.feedbackIntegration({
              colorScheme: "light",
              autoInject: false,
              showBranding: false,
              buttonLabel: "Report a Problem",
              submitButtonLabel: "Send",
              formTitle: "Report a Problem",
            }),
          ]
        : []),
    ],
    beforeSend(event) {
      return redactForTelemetry(event) as typeof event;
    }
  });
}

/** Open the Sentry user feedback dialog programmatically. */
export function openSentryFeedback(): void {
  try {
    const SentryWithFeedback = Sentry as unknown as { getFeedback?: () => { createForm?: () => Promise<{ appendToDom: () => void; open: () => void }> } };
    const feedback = SentryWithFeedback.getFeedback?.();
    if (feedback?.createForm) {
      void feedback.createForm().then((form) => {
        form.appendToDom();
        form.open();
      }).catch(() => {});
      return;
    }

    if (typeof window !== "undefined") {
      const windowFeedback = (window as unknown as { Sentry?: { getFeedback?: () => { createForm?: () => Promise<{ appendToDom: () => void; open: () => void }> } } }).Sentry?.getFeedback?.();
      if (windowFeedback?.createForm) {
        void windowFeedback.createForm().then((form) => {
          form.appendToDom();
          form.open();
        }).catch(() => {});
      }
    }
  } catch {
    // Safe no-op if feedback is not initialized or fails
  }
}

if (typeof window !== "undefined") {
  (window as unknown as { openSentryFeedback?: typeof openSentryFeedback }).openSentryFeedback = openSentryFeedback;
}

const rumApplicationId =
  process.env.NEXT_PUBLIC_DD_APPLICATION_ID ||
  process.env.NEXT_PUBLIC_DD_RUM_APPLICATION_ID;
const rumClientToken =
  process.env.NEXT_PUBLIC_DD_CLIENT_TOKEN ||
  process.env.NEXT_PUBLIC_DD_RUM_CLIENT_TOKEN;
if (rumApplicationId && rumClientToken) {
  void import("./src/lib/datadog-env").then(({ resolvePublicRumConfig }) =>
    import("./src/lib/datadog-rum").then(({ startDatadogRum }) => startDatadogRum(resolvePublicRumConfig()))
  );
}

// App Router navigation instrumentation. Safe to export unconditionally — it is a
// no-op when Sentry was not initialized above.
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
