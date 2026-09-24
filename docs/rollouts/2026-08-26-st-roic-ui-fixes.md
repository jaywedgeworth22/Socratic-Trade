# 2026-08-26 — ROIC.ai and EarningsCalls.dev Settings and Admin UI updates

> **2026-09-22 [MM] archaeology note:** historical reference to `NATIVE_APPLE_CLIENT_ID = "trade.socratic.app"` (the SIWA native audience in `src/lib/auth/apple-client-id.ts`) is kept verbatim as the audience that was live at rollout time.  Renamed on 2026-09-22 to `com.socratictrade.ios` (PR forthcoming); `src/lib/auth/apple-client-id.ts` line 4 now exports the new ID.  See `docs/rollouts/2026-09-22-bundle-id-migration.md`.

## Context & Objective
The user noted that they have switched to ROIC.ai, and asked that the EarningsCalls alert be clarified to explicitly say `EarningsCalls.dev` and requested that `ROIC.ai` be added both below it in Settings and in the Admin page to display its request rates and status.

## Changes Made
- `app/console/settings/page.tsx`, `src/lib/dashboard-ui.ts`, `app/console/components/alert-center.tsx`: Updated notification strings from `EarningsCalls` to `EarningsCalls.dev` for clarity.
- `src/lib/types.ts`, `src/lib/db.ts`, `src/lib/db-notifications.ts`: Registered a new `roic_status_advisory` notification type so that ROIC.ai appears directly under EarningsCalls.dev in the alerts list.
- `app/api/admin/connections-health/route.ts`: Aliased `roic` to `roic.ai` and added it to `EXPECTED_BACKEND_LANES` so it explicitly appears in the Admin page's API Connections card with its 24h request rate and status.

## Decisions & Trade-offs
- No direct code changes to ROIC's execution engine were made; this was purely to enhance UI visibility and explicitly track its health rate in the admin panel.

## Next Steps
- Merge to main.
- `litestream.coolify.yml`: Reduced Litestream `sync-interval` from 60s to 300s to avoid exhausting the Backblaze B2 2,500/day free limit for Class C transactions.

### iOS Login Failures Fixed
- `app/login/page.tsx`: Replaced hardcoded `{ redirectTo: "/" }` with NextAuth's `callbackUrl` by reading it from `searchParams`. This fixes the Google and GitHub OAuth flow on the iOS app which was getting redirected to the website's dashboard instead of handing off the session token back to the native app via the `socratictrade://auth` scheme.
- `src/lib/auth/apple-client-id.ts`: Updated `resolveAppleClientId()` to `resolveAppleClientIds()` which returns an array of allowed audiences. It now always includes `trade.socratic.app` (the native app Bundle ID) while appending `APPLE_CLIENT_ID` (the web service ID) if it's set in the environment.
- `app/api/mobile/auth/apple/route.ts`: Updated the `jwtVerify` audience field to accept the array of valid audiences. This fixes Native Apple Sign In failures which were occurring because the token audience was checking against the web service ID instead of the native app Bundle ID.
