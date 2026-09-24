# 2026-09-01 — Sentry Structured Logs & Next.js Config Tuning (Antigravity, `ag/sentry-logs-and-config-tuning`)

## Context & Objective
Enables Sentry Structured Logs across server, edge, and browser runtimes in Socratic-Trade, aligns baseline distributed tracing default to 0.2, tunes Session Replay defaults (100% on error, 1% session sample rate when opted in), and removes irrelevant `automaticVercelMonitors: true` from next.config.mjs.

## Changes Made
- **Enabled Structured Logs**: Added `enableLogs: true` across `sentry.server.config.ts`, `sentry.edge.config.ts`, and `instrumentation-client.ts`.
- **Trace Sampling Rate Alignment**: Raised default fallback `tracesSampleRate` from 0.1 to 0.2 across all three runtime configs.
- **Replay Tuning**: Set default `replaysSessionSampleRate` to 0.01 (1%) and `replaysOnErrorSampleRate` to 1.0 (100%) when replay is enabled.
- **Removed Vercel Monitored Flag**: Cleaned up `next.config.mjs` withSentryConfig options.

### Touched Files
- `next.config.mjs`
- `instrumentation-client.ts`
- `sentry.server.config.ts`
- `sentry.edge.config.ts`
- `docs/EFFORT-LOG.md`
- `docs/rollouts/2026-09-01-sentry-logs-and-config-tuning.md`

## Decisions & Trade-offs
- Strict privacy masking is maintained: `redactForTelemetry`, `maskAllText: true`, `blockAllMedia: true`, and `sendDefaultPii: false`.

## Verification State
- `npx tsc --noEmit` — passed with 0 errors.

## Next Steps & Blockers
- None.
