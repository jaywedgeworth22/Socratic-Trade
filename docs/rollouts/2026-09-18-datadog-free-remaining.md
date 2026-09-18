# 2026-09-18 — Datadog remaining: ST RUM stay dark + DD_HOSTNAME

## Context & Objective

Board `f03c5542`.  Stay on Infrastructure Free (us5).  Sentry remains the app error path.  Do not start RUM send that turns Free into an invoice.

## Changes Made

- Diagnosed ST RUM `is_active=false`: the existing `Socratic Trade` app is the only RUM application.  Infisical has server `DD_APPLICATION_ID` + `DD_CLIENT_TOKEN` and no `NEXT_PUBLIC_DD_*` pair, so `instrumentation-client.ts` does not boot.  `DatadogRumBoot` can still see the server pair at SSR.
- Set Infisical `DD_RUM_ENABLED=false` and `NEXT_PUBLIC_DD_RUM_ENABLED=false` so runtime boot stays fail-closed.  Did not mint a second RUM app.  Did not copy tokens into `NEXT_PUBLIC_*`.
- Set Infisical `DD_HOSTNAME=fleet-hetzner-nbg1`.  Preload attaches that host tag on Coolify only.  dd-trace `init({ hostname })` is the Agent address and is left alone.
- Files: `scripts/datadog-preload.mjs`, `test/datadog-inert.test.ts`, `test/datadog-env.test.ts`.

## Decisions & Trade-offs

RUM is not on Free.  Trial expired 2026-09-07.  Hourly RUM usage is empty.  Activating send is how Free becomes an invoice.  Fail-closed is correct.

## Verification State

- `npx vitest run test/datadog-env.test.ts test/datadog-inert.test.ts`

## Next Steps & Blockers

Coolify restart (or the next image) must pick up Infisical `DD_HOSTNAME`.  SSH from this Mac to the box timed out on port 22; Coolify API is the restart path.

## Zero-Code Findings

CT Infisical holds the same RUM application id as ST.  That is why CT health said `rum: true` with no Congress.Trade RUM application.  CT kill-switch is a sibling PR.
