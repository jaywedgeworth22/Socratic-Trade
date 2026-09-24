# 2026-07-10 — Server & infrastructure metrics dashboard page

## Summary

- Added a new **Server & Infrastructure** metrics view to the operator admin dashboard page (`/admin/server`).
- Built Next.js API route `/api/admin/server-metrics` that fetches and merges:
  - **Hetzner Cloud API** details & metrics (CPU, disk I/O, network traffic) using `HETZNER_API_TOKEN` and `HETZNER_SERVER_ID`.
  - **Coolify API** server metadata & resource container statuses using `COOLIFY_API_TOKEN` and `COOLIFY_SERVER_UUID`.
  - **Node.js Local Fallback** using native `os` module for host resource metadata when API tokens are not configured (seamless local development experience).
- Integrated the metrics page link into the `/admin` operator hub grid.
- Stored the production API tokens securely in Infisical (`HETZNER_API_TOKEN`, `HETZNER_SERVER_ID`, `COOLIFY_API_TOKEN`, `COOLIFY_SERVER_UUID`).

## Why

- The owner requested real-time visibility of server-level load (CPU, RAM, disk, network) and Coolify application health directly on the Socratic Trade admin dashboard, avoiding the need to log into the Coolify UI or Hetzner console during active trading sessions.

## Files

- [route.ts](file:///Users/jay/Code/Socratic-Trade/app/api/admin/server-metrics/route.ts) [NEW] — operator API route for fetching and structuring metrics.
- [page.tsx](file:///Users/jay/Code/Socratic-Trade/app/admin/server/page.tsx) [NEW] — server metrics page wrapper.
- [server-metrics-client.tsx](file:///Users/jay/Code/Socratic-Trade/app/admin/server/server-metrics-client.tsx) [NEW] — client visualizer page showing resource utilization and running container list.
- [page.tsx](file:///Users/jay/Code/Socratic-Trade/app/admin/page.tsx) [MODIFY] — added Server & infrastructure link to operator hub grid.
- [server-metrics.test.ts](file:///Users/jay/Code/Socratic-Trade/test/server-metrics.test.ts) [NEW] — unit tests for the metrics API endpoint (verification of admin checks, development fallback, and API parser logic).

## Verification

- Automated tests: `npx vitest run test/server-metrics.test.ts` passed (3/3).
- Full verification gate ran:
  - `npx tsc --noEmit` -> clean.
  - `npm run lint` -> 0 errors.
