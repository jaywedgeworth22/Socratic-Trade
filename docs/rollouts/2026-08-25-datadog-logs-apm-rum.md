# 2026-08-25 — Datadog Logs + APM + RUM (existing us5 account)

## Context & Objective

Socratic-Trade had no Datadog SDK.  The existing us5 org already runs a host agent on `fleet-hetzner-nbg1`, but that path only saw syslog/journald and Universal Service Monitoring `service:node` (GitHub Actions), not the Next.js app, and Coolify container stdout was not ingested.  This change adds fail-closed Logs + APM + browser RUM on that same account so the web console is observable without new Datadog spend, orgs, or paid add-ons.

## Changes Made

Server logs ship warn+ to the official HTTP intake (`http-intake.logs.us5.datadoghq.com`) when `DD_API_KEY` or `DATADOG_API_KEY` is present.  APM uses `dd-trace` via an ESM `--import` preload in `scripts/coolify-prod-start.sh` after Infisical (required so the Next plugin actually patches).  When no agent host is set, official `DD_TRACE_EXPERIMENTAL_EXPORTER=agentless` is used so traces can leave Docker.  Browser RUM boots from `instrumentation-client.ts` and a hidden runtime `<DatadogRumBoot>` so Infisical tokens work even when `NEXT_PUBLIC_*` was empty at `next build`.  Session Replay, Profiling, and AppSec stay off.  Sentry and PagerDuty (Firefighter moderate+) are unchanged.  Missing keys are a no-op and must not crash prod.

Touched files:

- `src/lib/datadog-env.ts`
- `src/lib/datadog-logs.ts`
- `src/lib/datadog-server.ts`
- `src/lib/datadog-rum.ts`
- `app/ui/datadog-rum-boot.tsx`
- `scripts/datadog-preload.mjs`
- `scripts/coolify-prod-start.sh`
- `instrumentation.ts`
- `instrumentation-client.ts`
- `app/layout.tsx`
- `app/global-error.tsx`
- `next.config.mjs`
- `.env.example`
- `package.json`
- `package-lock.json`
- `test/datadog-env.test.ts`
- `test/datadog-logs.test.ts`
- `test/datadog-inert.test.ts`
- `docs/ops-observability-security.md`
- `docs/rollouts/2026-08-25-datadog-logs-apm-rum.md`
- `docs/EFFORT-LOG.md`
- `STATUS.md`
- `PLAN.md`

## Decisions & Trade-offs

- Reuse official Datadog env names only.  Do not invent git secrets.  Default site is `us5.datadoghq.com` (the existing account).  Default service is `socratic-trade` (matches Sentry).
- Do not enable RUM on the Datadog org from this PR.  The client SDK no-ops without an application id + client token.  Owner can attach existing RUM credentials in Infisical when ready.
- Do not turn on Profiling, AppSec, IAST, Dynamic Instrumentation, or Session Replay.  Replay requires an existing `NEXT_PUBLIC_DD_SESSION_REPLAY_ENABLED=true` and a sample rate > 0.
- HTTP log intake is required because Coolify container stdout is not on the host agent today.  Min level is warn.  `console.log` is not wrapped.
- APM sample rate defaults to 0.1.  `/api/live` and `/api/health` request errors are not shipped.
- Preload uses `--import`, never `--require`, so `test/toolchain-policy.test.ts` stays green.
- `instrumentation.ts` APM init is a fallback for local `next start`.  Production Coolify preload is the path that actually patches Next.
- Designer UX copy/layout is untouched.  `global-error.tsx` only adds a silent RUM `addError`.  Oracle RAG / Pinecone is untouched.

## Verification State

Commands actually run:

```bash
npm run lint          # 0 errors, 773 grandfathered warnings
npx tsc --noEmit      # clean after RumPublicApi cast
npx vitest run test/datadog-env.test.ts test/datadog-logs.test.ts test/datadog-inert.test.ts test/toolchain-policy.test.ts test/sentry-inert.test.ts
                      # 5 files / 32 tests passed
node scripts/datadog-preload.mjs
                      # exit 0 with no keys (fail-closed)
npm run build         # Next.js 16.3.1 webpack succeeded (41/41 static pages)
```

First `npm run build` failed because `src/lib/datadog-logs.ts` imported `node:os` into a webpack graph that does not handle that scheme.  Hostname now comes from `DD_HOSTNAME` / `HOSTNAME` / `COMPUTERNAME`.  Client/edge webpack aliases stub `node:os`.  Rebuild succeeded.

Full `npm test` in this Cloud VM is slow and showed unrelated pre-existing failures (Yahoo/history network, `usesLocalHost` on the Cloud host, RAG coverage timeouts).  Those files were not changed.  CI `verify` is the suite of record.

## Next Steps & Blockers

- Confirm production Infisical already has `DD_API_KEY` (or `DATADOG_API_KEY`) and `DD_SITE=us5.datadoghq.com`.  If only the host agent should receive traces, set `DD_AGENT_HOST` to the Docker bridge reachable from the Coolify container.  Do not mint a second key.
- RUM stays inert until an existing application id + client token is present.  Do not create a new RUM application if that would add spend.
- Coolify deploy is not this PR.  After merge, weekday RTH latch still applies.
- Do not add Datadog as an `/api/health` dependency.

## Zero-Code Findings

Datadog MCP against the existing org: site `us5.datadoghq.com`; host agent on `fleet-hetzner-nbg1`; current APM is host-level USM (`service:node`), not Next.js; host logs are syslog/journald/agent noise; Coolify uuid `d83b1aykr03uwr32yhgzaiay` appears as a service name; RUM explorer is not enabled on the org.  This PR does not flip that org-level RUM switch.
