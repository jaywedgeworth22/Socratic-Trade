# 2026-07-11 — Admin authorization fail-closed hardening

PR: <https://github.com/jaywedgeworth22/Socratic-Trade/pull/1410> (ready, not merged)

Branch: `codex/admin-fail-closed`

Worktree: `/Users/jay/.codex/worktrees/socratic-admin-fail-closed`

## Summary

The shared `requireAdmin` / `checkAdmin` gate now fails closed unless a caller supplies a
middleware-verified admin identity or a valid admin token. The previous default accepted every
request whenever `NODE_ENV !== "production"`.

Middleware now forwards an explicit identity-source marker alongside the authenticated email.
Email-based admin authorization accepts only Cloudflare Access or Auth.js session provenance. The
auth-unconfigured `PRIMARY_USER_EMAIL` fallback is marked `local-fallback` and denied even when it
names the primary operator or appears in `ADMIN_USER_EMAILS`. Client-supplied email and provenance
headers are both stripped before forwarding.

The reviewed hostname-based local opt-in was removed completely: a request URL is caller-influenced
metadata, not proof of a loopback transport. There is no unauthenticated admin bypass in any
environment. Local operator access uses a verified session or `ADMIN_REINDEX_TOKEN`.

## Why

`NODE_ENV` distinguishes build/runtime modes; it is not an authorization signal. A staging process,
test harness, misconfigured deployment, or unset environment could previously inherit admin access
without an allowlisted identity or token. The first attempted replacement combined an explicit flag
with the request URL hostname, but hostname is spoofable at the handler boundary and still does not
prove the request originated on the local transport. Verified identity-source provenance closes the
separate synthetic-primary-email path without relying on either environment or hostname.

## Compatibility impact

- Production, development, test, staging-like, and unset environments all use the same gate.
- The local primary-email fallback still supports ordinary auth-unconfigured development flows, but
  it cannot enter an admin handler without a valid admin token.
- Verified primary/allowlisted admin emails continue to work when middleware provenance is
  Cloudflare Access or Auth.js session.
- The timing-safe `ADMIN_REINDEX_TOKEN` path remains unchanged and is the explicit local admin path
  when no verified login provider is configured.
- Direct handler tests/tools that previously injected only `x-authenticated-user-email` must also
  model verified middleware provenance or use the admin token; email alone is intentionally denied.

## Files

- `middleware.ts`
- `src/lib/auth/admin.ts`
- `src/lib/auth/identity.ts` (provenance comment correction)
- `src/lib/auth/strip-identity.ts`
- `src/lib/request-user.ts` (provenance comment correction)
- `app/api/admin/backtest-ic/route.ts`
- `app/api/admin/congress-score-eval/route.ts`
- `app/api/admin/congress-share/route.ts`
- `app/api/admin/emit-test/route.ts`
- `app/api/admin/learning-ledger/route.ts`
- `app/api/admin/refresh-websource/route.ts`
- `app/api/admin/reindex-10k/route.ts`
- `app/api/admin/reindex-8k/route.ts`
- `app/api/admin/robinhood-probe/route.ts`
- `app/api/admin/trigger-test/route.ts`
- `app/api/admin/tuning-dry-run/route.ts`
- `test/admin-gate.test.ts`
- `test/security-admin-timing-safe.test.ts`
- `test/server-metrics.test.ts`
- `test/strip-identity.test.ts`
- `.env.example`
- `docs/phase-11-multi-user.md`
- `docs/EFFORT-LOG.md`
- `STATUS.md`
- `PLAN.md`
- `docs/rollouts/2026-07-11-admin-auth-fail-closed.md`
- `/Users/jay/apps/TRADING-EFFORT-LOG.md` (branch-neutral live board)

## Verification

- `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run test/admin-gate.test.ts test/security-admin-timing-safe.test.ts test/middleware-auth.test.ts test/strip-identity.test.ts test/server-metrics.test.ts test/request-user.test.ts`
  — PASS, 6 files / 60 tests. This includes middleware-to-handler coverage proving that auth-env-unset
  primary fallback provenance is denied after forged client provenance is stripped.
- `git diff --name-only -- '*.ts' '*.tsx' | xargs env PATH=/opt/homebrew/opt/node@24/bin:$PATH npx eslint`
  — PASS, no errors or warnings. An earlier invocation placed the `PATH=...` assignment directly
  after `xargs`; BSD `xargs` treated it as an executable name and exited before ESLint ran. The
  corrected `xargs env ...` invocation above is authoritative.
- `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx tsc --noEmit` — PASS after adding the explicit helper
  parameter type surfaced by the first compiler run.
- `git diff --check` — PASS.
- `rg -n 'allowNonProd' . --glob '!node_modules/**' --glob '!.git/**'` — no code, test, or live
  callsites remain; matches are limited to historical audit/rollout documents describing the old
  behavior.
- Final current-main (`8fca436d`) Node 24 gate:
  - `npm run lint` — 0 errors / 407 grandfathered warnings.
  - `npx tsc --noEmit` — clean.
  - `npm test` — 325 files / 3,616 tests passed.
  - `npm run build` — production build passed with existing middleware/Sentry/cache warnings only.

Head `98651cc1` is pushed in READY PR #1410; hosted checks are pending. No merge, auto-merge, or
production mutation was requested.

Current-main reconciliation: `origin/main@432ca6fe` merged after #1400 landed. The only source
conflict was `test/server-metrics.test.ts`; the resolved file keeps all current Hetzner/Coolify,
malformed-sample, and degraded-provider assertions while attaching verified Auth.js provenance to
authorized admin requests. STATUS and effort histories were union-merged. The final combined gate is
green: focused 6 files / 64 tests, touched-file ESLint clean, full lint 0 errors / 404 inherited
warnings, TypeScript clean, 325 files / 3,620 tests, and production build clean.

## Follow-ups / risks

- Production verification completed 2026-07-11T16:41Z at exact release SHA `d3859025`, which
  contains merge `2a52e2ac`; process start was 16:28:17Z and the scheduler lease was current.
  Plain and spoofed unauthenticated admin requests both returned 401 at the edge. No manual deploy.
- Concurrent `codex/admin-rate-limits` also edits several admin routes. The coordinator must review
  the overlapping route-comment-only hunks while reconciling the branches; auth behavior remains
  owned by this lane.
- Reviewed implementation commit `96b87d89` was created, then current `origin/main@8fca436d` was
  merged in two conflict-free steps. Intersections were additive status/effort docs only; auth code
  did not overlap. The final merge remains staged for commit after the green gate above.
- Main merge, deploy, and production environment mutation were not run.
