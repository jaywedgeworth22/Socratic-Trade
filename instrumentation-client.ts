// Browser / client runtime Sentry init. Mirrors sentry.server.config.ts:
// env-gated (off unless NEXT_PUBLIC_SENTRY_DSN is set), PII disabled, and every
// event run through redactForTelemetry — this is a financial app, so nothing
// user-facing (account numbers, keys, tokens) may leave the browser.
import * as Sentry from "@sentry/nextjs";
import { redactForTelemetry } from "./src/lib/telemetry-sanitize";

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

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
