# 2026-07-11 — Expensive admin-operation abuse/cost controls

PR: <https://github.com/jaywedgeworth22/Socratic-Trade/pull/1409> (merged as `9552b648`)

## Summary

Added one shared admission layer for eight expensive operator actions:

- paid SEC 8-K and 10-K reindexes;
- factor-IC backtest and strategy-tuning dry run;
- Congress score evaluation and manual daily share;
- forced web-source refresh; and
- Robinhood MCP diagnostic probe.

Each operation has a named per-admin sliding-window budget. Over-budget requests return HTTP 429
with `Retry-After`, `code=rate_limited`, and `retryAfterSeconds`; duplicate/conflicting work returns
HTTP 409 with `code=operation_in_flight` and `activeOperation`. A single-flight claim is acquired
before quota debit, so repeated 409 attempts do not consume rate budget. Shared manual admin requests
use process-wide single-flight groups, including one group shared by both paid RAG reindex routes.
Analysis and broker probes use per-admin exclusion because their state is user-scoped. These route-level
claims do not coordinate with scheduler/background entrants; that underlying-boundary convergence is a
separate planned lane and is not overstated as protection here.

## Why

These routes already required admin authorization, but authorization alone did not stop an accidental
double-click, retry loop, or admin script from running concurrent paid provider fan-out, forced TTL
bypasses, broker calls, or long database scans. The guard rejects duplicates before the expensive
callback starts while preserving normal interactive retries and operator ownership of the action.

The rate key is derived only from `resolveRequestUserId(request)`, which consumes the
middleware-established trusted email header and ignores query/body/user-ID hints. The guard is invoked
only after the route's existing `requireAdmin` check. `src/lib/auth/admin.ts` was deliberately not
changed because a separate fail-closed authorization lane owns it.

## Limits and concurrency

| Operation | Budget | Single-flight scope/group |
| --- | ---: | --- |
| `reindex-8k` | 2/hour | all manual admin requests, `rag-reindex` |
| `reindex-10k` | 2/hour | all manual admin requests, `rag-reindex` |
| `backtest-ic` | 10/5 min | per admin |
| `tuning-dry-run` | 6/10 min | shared per-user tuning guard (also `/api/strategy/tune`) |
| `congress-score-eval` | 6/10 min | per admin |
| `congress-share` | 2/hour | all manual admin requests |
| `refresh-websource` | 4/10 min | all manual admin requests |
| `robinhood-probe` | 20/5 min | per admin |

Authorization and explicit validation/config rejection paths happen before quota admission. Empty 10-K
symbol lists, missing Congress credentials, unknown web-source IDs, and a disabled Robinhood adapter do
not debit the operator budget. Routes whose historical contract treats an absent/malformed body as a real
default action (full 8-K reindex, monitored-universe Congress share, or Congress refresh) still enter
admission normally. Only the expensive action is wrapped; cached/status GET handlers on the reindex and
Congress score routes retain their existing behavior.

## Files

- `src/lib/admin-operation-guard.ts` — named budgets, trusted-identity rate keys, explicit 429/409
  responses, and exception-safe single-flight release.
- `src/lib/operation-guard-response.ts` — app-local HTTP adapter using the released shared 429/409
  builders/status mapping while retaining `Response`, `Retry-After`, error, and legacy fields.
- `package.json`, `package-lock.json` — exact pin to the clean-install-verified shared `v1.5.0` tag.
- `src/lib/tuning-singleflight.ts` — owner-token single-flight shared by public tuning and the admin
  dry run.
- `app/api/strategy/tune/route.ts` — replaces the route-private set with the shared tuning guard.
- `app/api/admin/reindex-8k/route.ts`
- `app/api/admin/reindex-10k/route.ts`
- `app/api/admin/backtest-ic/route.ts`
- `app/api/admin/tuning-dry-run/route.ts`
- `app/api/admin/congress-score-eval/route.ts`
- `app/api/admin/congress-share/route.ts`
- `app/api/admin/refresh-websource/route.ts`
- `app/api/admin/robinhood-probe/route.ts`
- `test/admin-operation-guard.test.ts` — budget, trusted identity, per-admin/manual concurrency,
  duplicate-spam quota preservation, cross-reindex exclusion, throw/owner-token release coverage,
  and shared-schema validation for representative 429/409 bodies.
- `test/admin-operation-route-wiring.test.ts` — all eight routes authenticate before entering the
  correct named guard.
- `test/admin-operation-route-behavior.test.ts` — invoked-handler coverage for auth ordering,
  explicit validation/config rejection without quota debit, 429 provider suppression, and cross-reindex
  409 provider suppression.
- `test/public-auth-rate-limit-hardening.test.ts` — adds same-user, both-direction cross-route
  concurrency coverage for public tuning versus the admin dry run.
- `STATUS.md`, `PLAN.md`, `docs/EFFORT-LOG.md`, `docs/ops-observability-security.md`, and this note.

## Verification

Current-main reconciliation after Tradier PR #1425 (`e3d04221`) found that merge had restored all
eight route wrappers dropped by #1409. Each current route still authenticates before guard admission,
so PR #1426 keeps the main route implementations and narrows to shared `v1.5.0` adoption plus tests.
The merge also reintroduced a test-only `requireAdmin: () => null` mock; the follow-up removes that
bypass and retains the verified Auth.js identity-source header plus allowlisted-email setup. The
current-main full gate passed; the earlier receipts remain preserved for audit history.

- Current-main focused verification: 4 files / 29 tests passed.
- Current-main ordered Node 24 gate: `npm run lint` (0 errors), `npx tsc --noEmit`, `npm test`
  (330 files / 3,740 tests), and `npm run build` all passed.
- Final pre-landing reconciliation merged `origin/main@e395e65a` cleanly. The repeated Node 24 gate
  passed: focused 4 files / 29 tests, lint 0 errors / 404 inherited warnings, TypeScript clean,
  331 files / 3,746 tests, and production build. Antigravity's ready Congress.Trade PR #296 uses
  exact `#v1.5.0` and resolves `2222baeb`; its 940-test app gate is green and its peer check is
  expected red until Socratic #1426 lands first. Congress merge/deploy remains separately owner-gated.

- `git diff --check` — passed.
- `PATH=/opt/homebrew/opt/node@24/bin:$PATH node --version` — `v24.18.0`.
- `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run test/admin-operation-guard.test.ts test/admin-operation-route-wiring.test.ts test/admin-operation-route-behavior.test.ts test/public-auth-rate-limit-hardening.test.ts` — 4 files, 29 tests passed.
- `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx eslint src/lib/admin-operation-guard.ts src/lib/operation-guard-response.ts src/lib/tuning-singleflight.ts app/api/admin/reindex-8k/route.ts app/api/admin/reindex-10k/route.ts app/api/admin/backtest-ic/route.ts app/api/admin/tuning-dry-run/route.ts app/api/admin/congress-score-eval/route.ts app/api/admin/congress-share/route.ts app/api/admin/refresh-websource/route.ts app/api/admin/robinhood-probe/route.ts app/api/strategy/tune/route.ts test/admin-operation-guard.test.ts test/admin-operation-route-wiring.test.ts test/admin-operation-route-behavior.test.ts test/public-auth-rate-limit-hardening.test.ts` — passed with no output (0 errors/warnings).
- `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx tsc --noEmit` — passed.
- Final current-main (`8fca436d`) Node 24 gate:
  - `npm run lint` — 0 errors / 408 grandfathered warnings.
  - `npx tsc --noEmit` — clean.
  - `npm test` — 328 files / 3,629 tests passed.
  - `npm run build` — production build passed with existing middleware/Sentry/cache warnings only.
- The first full gate was also green at prior main (327 files / 3,627 tests), but PR #1398 merged
  externally during that run. Its new main was merged without guard-code overlap and the full ordered
  gate above was repeated before landing.

Current-main reconciliation: `origin/main@432ca6fe` merged without textual conflicts. The incoming
admin-server source/tests are disjoint from guarded routes; only union-managed STATUS and effort
histories overlapped. Final combined verification is green: focused 4 files/29 tests, touched
ESLint clean, full lint 0 errors/405 inherited warnings, TypeScript clean, 328 files/3,633 tests,
and production build clean.

Landing and shared-contract follow-up: PR #1409 merged to `main` as `9552b648`. Shared package
`v1.5.0` was then released as lightweight tag `v1.5.0 -> 2222baeb`; clean tokenless tag install and
CJS+ESM builder/status smoke passed. The follow-up exact-pins that tag and delegates pure rejection
construction to the shared contract. Current `main@d3859025` already includes #1409, #1410, and
#1405; refreshed local/hosted verification is pending this follow-up commit.

Current-main integration audit found a release-blocking regression in `9552b648`: all eight route
files on `main` had lost their `withAdminOperationGuard` imports/wrappers even though the guard
library and wiring tests were present. This follow-up restores the eight wrappers at their original
post-auth/post-validation admission points and retains #1410's fail-closed provenance comments.
Route-wiring/behavior tests are mandatory before the follow-up lands.

The first combined focused rerun caught a second integration mismatch: #1410 correctly made
`requireAdmin` require verified, allowlisted identity provenance, while the cross-route tuning test
still supplied an arbitrary email under the retired development bypass. The fixture now marks the
request as an Auth.js session, allowlists that test email, and cleans environment stubs. Rerun:

- `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run test/admin-operation-guard.test.ts test/admin-operation-route-wiring.test.ts test/admin-operation-route-behavior.test.ts test/public-auth-rate-limit-hardening.test.ts`
  — 4 files / 29 tests passed.
- `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run lint` — passed with 0 errors / 404 inherited
  warnings.
- `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx tsc --noEmit` — passed.
- First `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm test` attempt — stopped after the native
  `better-sqlite3` binary reported ABI 147 (Node 26) versus required ABI 137 (Node 24). Cause: the
  earlier dependency refresh ran under the shell's default Node 26 and rebuilt the native module.
- `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm rebuild better-sqlite3` plus a Node 24 require/ABI
  smoke — passed (`v24.18.0`, ABI 137).
- Repeated `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm test` — 329 files / 3,684 tests passed.
- `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run build` — passed with the existing middleware,
  Sentry Edge, and webpack-cache warnings only.

Shared v1.5.0 adoption verification before current-main reconciliation:

- `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run test/admin-operation-guard.test.ts`
  — 1 file / 9 tests passed.
- `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx eslint src/lib/operation-guard-response.ts test/admin-operation-guard.test.ts`
  — passed with no output.
- Lock/install receipt: root dependency spec `#v1.5.0`, installed package version 1.5.0, resolved
  commit `2222baeb`; shared builders/status mapping/schema exports present.

## Follow-ups / boundaries

- Shared-contract follow-up completed: `congress-trading-shared` PR #144 merged and released as
  `v1.5.0`; this app now consumes its portable `rate_limited` / `operation_in_flight` body and
  429/409 status mapping through the local HTTP adapter.
- This is process-local state, consistent with the current single-Next-process deployment. A future
  multi-instance topology requires a shared rate-limit/lease backend.
- The single-flight groups coordinate manual admin route calls only. Scheduler/background entrants call
  the underlying share, filing-ingest, and web-refresh functions directly and can still overlap a manual
  request. A planned follow-up must move ownership-aware locking to those shared operation boundaries;
  this lane does not touch the scheduler while its lease work is active elsewhere.
- These are anti-repeat controls, not hard per-request spend ceilings. No request-size or batch-size
  semantics were changed: the 8-K reindex can still request the full dataset, the 10-K route accepts an
  operator-chosen symbol list/limit, and backtest query sizes remain operator inputs. Any default caps
  must stay explicit/adjustable rather than silently truncating a requested backfill.
- Public tuning preserves its legacy 409 compatibility fields (`error=strategy_tuning_in_progress` and
  `message`) while adding the stable `code`, `operation`, and `activeOperation` metadata.
- `app/api/admin/securities/import` is intentionally excluded: it is an external App-A-to-App-B
  bearer-token ingestion contract, not an interactive admin-identity route. Its payload/batch limits
  need sender-contract coordination and should not be keyed to the local admin user. Cheap/status
  reads (`rag-coverage`, connection health, usage, ledgers) and idempotent test emitters were also
  left unchanged.
- No strategy, broker/provider implementation, production configuration, or manual deployment action
  is included in the shared-contract adoption follow-up.
