# 2026-09-18 — #3385 sqliteYieldRetry remainder (scheduler writes + synthetic-stop delete/audit)

## Context & Objective

PR #3383 merged as `2fc699c32878291859eff7d241f0ee0801ef7a22` and pinned serving-process `busy_timeout` at 100ms, with `sqliteYieldRetry` restoring the 60s lock budget via yields.  Two Sentry review findings remained in the merged code: scheduler writes still ran synchronously after that pin, and three synthetic-stop plan-purge paths still mixed a delete with a non-idempotent audit inside one retry callback.  This follow-up is issue #3385.  Extra-ship no.  Stay out of `broker-protective-stops.ts` (CLAUDE #3404).  No Coolify Deploy.

## Changes Made

Scheduler writes that must tolerate contention now go through `sqliteYieldRetry`.  A SQLITE_BUSY on `scheduler:lastTick` after the 100ms pin yields and retries; a later success does not increment health failures or `releaseLease`.  Managed-vector lastAttempt/lastSuccess timestamps are each their own envelope so a BUSY on lastSuccess cannot re-stamp lastAttempt or re-run the provider pass.  Boot halt splits `setPolicy` from `audit("autonomy_halted_on_boot")` the same way synthetic-stop re-arm already splits generation advance from audit.  `reconcileAutonomyOnBoot` is async; `startScheduler` awaits it before the first tick so a restored DB cannot resume `active` accounts during the yield.

The three plan-purge blocks in `synthetic-stops.ts` (plan `"none"`, fixed-kind no longer wanted, trailing excluded by fixed/atr or a no-trail reset) now run `deleteSyntheticStop` and `audit` in separate `sqliteYieldRetry` calls.  A BUSY on audit cannot duplicate the delete or the audit row.

- `src/lib/scheduler.ts` — import `sqliteYieldRetry`; wrap lastTick / managed-vector timestamps; split boot setPolicy vs audit; await boot halt before arming the interval
- `src/lib/synthetic-stops.ts` — split the three plan-purge delete+audit envelopes
- `test/scheduler-sqlite-busy.test.ts` (new) — heartbeat BUSY-then-success does not abdicate; non-busy heartbeat failure still does; boot audit BUSY does not double-audit
- `test/synthetic-stops-purge-audit-sqlite-busy.test.ts` (new) — each of the three purge paths: BUSY on audit after delete does not re-delete or double-audit
- `test/scheduler-managed-vector-reconcile.test.ts` — lastAttempt/lastSuccess BUSY retries without re-running the provider pass
- `test/deep-safety-fixes.test.ts`, `test/scheduler-boot-halt-notify.test.ts`, `test/sentry-inert.test.ts` — await the now-async boot interlock
- `STATUS.md`, `PLAN.md`, `docs/EFFORT-LOG.md`

## Decisions & Trade-offs

- Do not wrap `broker-protective-stops.ts`.  That file is CLAUDE's #3404 / 6b059b9e lane.
- Do not reuse `~/apps/trading-grok-rth-stall` or `grok/rth-event-loop-stall`.  That tip is merged and 193 behind.
- `setPolicy` is idempotent (halt twice is still halted).  `audit` is not.  Sharing one retry envelope was the bug; splitting is the fix.  Making audit idempotent with a unique key is extra-ship.
- Boot halt has to be async because `sqliteYieldRetry` yields.  `startScheduler` keeps the old invariant that reconcile finishes before the first tick; a throw during boot does not arm the interval (fail-closed: do not resume `active` if we could not halt).
- Non-busy heartbeat errors still increment failures and still abdicate at the threshold.  Only a yielded-busy-then-success is exempt.

## Verification State

- Node v24.21.0
- `node node_modules/vitest/vitest.mjs run test/scheduler-sqlite-busy.test.ts test/synthetic-stops-purge-audit-sqlite-busy.test.ts test/scheduler-managed-vector-reconcile.test.ts test/sqlite-event-loop-stall.test.ts test/deep-safety-fixes.test.ts test/scheduler-boot-halt-notify.test.ts test/scheduler-leader-heartbeat.test.ts test/sentry-inert.test.ts test/synthetic-stops.test.ts test/scheduler-tick-watchdog.test.ts --testTimeout=30000` — **10 files / 133 tests passed** (12.47s)
- `node node_modules/eslint/bin/eslint.js src/lib/scheduler.ts src/lib/synthetic-stops.ts test/scheduler-sqlite-busy.test.ts test/synthetic-stops-purge-audit-sqlite-busy.test.ts` — 0 errors (2 inherited unused-import warnings in `scheduler.ts`)
- `npx tsc --noEmit` on this Mac used a borrowed `node_modules` missing lucide-react `.d.ts` / `next/package.json` (48 errors, none in touched files).  Hosted `verify` does a real install.

## Next Steps & Blockers

- PR #3408.  Squash auto-merge armed.  Hosted `verify` must go green before merge.
- Do not merge from this lane during weekday RTH unless the owner sets `HOTFIX=1` / `RTH_DEPLOY_OVERRIDE=1`.  Evening/weekend auto-deploy still applies after merge.
- Do not Coolify Deploy from this lane.

## Zero-Code Findings

None.  The two findings were already filed as #3385 against the merged #3383 tree.
