# Issue #3225: Console singleflighting, deadline retry, 401 handling, AbortController, Error Boundary

**Context & Objective**: 
Implemented 5 client-side resiliency and UX fixes to the console dashboard to prevent duplicate requests, retry spin-loops, silent session failures, and unhandled errors.

**Changes Made**:
- **api.ts**: Added promise coalescing to `runOnce()` so dual desktop+mobile `RunOnceButton` instances sharing the `console:run-once` event don't fire duplicate POST requests.
- **useConsoleData.tsx**: Added exponential backoff (capped at 30s) + ±20% jitter on deadline retries in `runLoop()` to prevent hammering a degraded backend. Added `sessionExpiredRef` guard at the top of the loop.
- **use-live-scan.ts, chat.tsx**: Added 401 HTTP intercepts that directly call `redirectToLogin()`.  GROK 2026-09-15: `readErrorMessage` now treats 401 as a status before JSON parse so a JSON body cannot skip the redirect.
- **PLAN.md / STATUS.md / docs/EFFORT-LOG.md**: land-sweep handoff for the 401 JSON fix.
- **symbol-drilldown.tsx**: Migrated `useHistory`, `useOnDemandEnrichment`, and `desk` fetches to use `AbortController` (cancelling requests on unmount instead of just ignoring the result) and added 401 intercepts to all three.
- **app/error.tsx**: Wired `Sentry.captureException(error)` and `window.DD_RUM?.addError(error)` into the dashboard's error boundary.
- **next.config.mjs**: Corrected a broken import for `withSentryConfig` (`@sentry/nextjs` instead of `@sentry/nextjs/config`) to allow `npm run build` to succeed.
- **tests**: Added `test/api-run-once-singleflight.test.ts` to assert concurrent coalescing.

**Decisions & Trade-offs**:
- The deadline backoff uses a maximum of 30s to keep it slightly under the `FETCH_DEADLINE_MS` (35s) so retries are spread out but still happen.
- `window.DD_RUM` is cast to `any` in `app/error.tsx` since Datadog's typings aren't ambiently available to the Next.js client bundle.

**Verification State**:
- `npm run lint` & `npx tsc --noEmit` pass.
- `npm test` passes.
- `npm run build` successfully compiles the optimized Next.js app.

**Next Steps & Blockers**:
None. The code is ready for PR #3225 and squash-merge.
