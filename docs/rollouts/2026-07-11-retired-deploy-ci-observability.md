# 2026-07-11 — retired deploy CI safety and observability

PR: <https://github.com/jaywedgeworth22/Socratic-Trade/pull/1398> (ready, not merged)

## Summary

- Deleted `.github/workflows/deploy.yml`. Although the Mac/PM2 production lane
  and workflow were disabled, the YAML still declared `push: main` and
  `workflow_dispatch` triggers; an accidental re-enable would restore a second
  scheduler against the same broker accounts.
- Updated `Sentry CI Report` to observe every active workflow and removed the
  retired `Deploy` and `Sync Preview Lanes` names.
- Added Sentry Cron mappings for all active scheduled workflows: `CI`, `Cleanup
  Actions Caches`, `Effort Issues Sync`, `Security`, `Playwright Smoke`, and
  `Shared package pin check`. `merge-shepherd` is observed for failures but has
  no cron mapping because the repository workflow is manual-only; its recurring
  driver is host-side launchd, not GitHub Actions schedule syntax.
- Replaced the obsolete Mac deployment and runner instructions in
  `docs/deployment.md` and `ci-pending/README.md` with the canonical Coolify
  auto-deploy path and an explicit single-scheduler rollback boundary.
- Added a structural Vitest regression that derives active workflow names and
  scheduled cron expressions from the workflow directory, compares them with
  the Sentry reporter configuration, and asserts that `deploy.yml` stays absent.
  After current main added `_merge-shepherd-impl`, the gate exposed an important
  distinction: reusable-only `workflow_call` definitions execute inside their
  caller and cannot emit a separate `workflow_run`. The regression now excludes
  reusable-only definitions while continuing to observe their independent caller.

## Why

Coolify's GitHub App is the canonical production deployer and automatically
deploys every push to `main`. Keeping the disabled GitHub Actions deployment
definition was not inert safety documentation: re-enabling it would restore its
main-push and manual triggers against the rollback Mac's PM2 `trading` process.
If that process and Coolify ran together, two schedulers could trade the same
connected accounts.

The Sentry observer was also stale: it watched the deleted preview-sync lane and
the retired deploy lane, while omitting active cache-cleanup, effort-sync,
nightly CI, and merge-shepherd workflows. Its cron map covered only three of the
six schedules currently defined in the repository.

## Files

- Deleted: `.github/workflows/deploy.yml`
- Updated: `.github/workflows/sentry-ci-report.yml`
- Updated: `scripts/sentry-ci-report.py`
- Added: `test/sentry-ci-report-workflows.test.ts`
- Replaced: `docs/deployment.md` (obsolete PM2 runbook -> current Coolify runbook)
- Updated: `docs/secrets.md` (Mac cutover marked rollback-only; Coolify injection is current)
- Replaced: `ci-pending/README.md` (obsolete deploy-runner setup -> workflow publishing note)
- Updated: `STATUS.md`, `PLAN.md`, `docs/EFFORT-LOG.md`
- Added: `docs/rollouts/2026-07-11-retired-deploy-ci-observability.md`

## Verification

- `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm ci` — passed; installed 767
  packages. npm reported four moderate audit findings and three existing
  allow-scripts review notices; no install failure.
- `python3 -m py_compile scripts/sentry-ci-report.py` — passed.
- `SENTRY_FLEET_DSN='' WORKFLOW_NAME='CI' WORKFLOW_CONCLUSION='success'
  WORKFLOW_EVENT='schedule' python3 scripts/sentry-ci-report.py` — passed through
  the intentional missing-DSN no-op path without exposing or contacting Sentry.
- Ruby `YAML.load_file` over every remaining `.github/workflows/*.{yml,yaml}` —
  all nine workflow files parsed.
- Focused Python structural assertion — passed: 8/8 active workflows observed,
  6/6 scheduled workflow cron mappings exact, `deploy.yml` absent, and no cron
  mapping for manual-only `merge-shepherd`.
- `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run
  test/sentry-ci-report-workflows.test.ts` — 1 file, 2 tests passed.
- First current-main gate stopped at TypeScript because the lane's stale `node_modules`
  lacked main-added `ts-morph`; the clean `npm ci` above repaired the dependency tree.
- First post-install full suite stopped at 3,603/3,604 because the parity regression
  incorrectly expected reusable-only `_merge-shepherd-impl` to emit an independent
  `workflow_run`. The source test and reporter comment were corrected; focused 2/2 passed.
- Final `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run lint` — passed with 0 errors
  and 408 grandfathered warnings.
- `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx tsc --noEmit` — clean.
- `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm test` — 325 files, 3,604 tests
  passed.
- `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run build` — Next.js webpack
  production build passed. Existing middleware-deprecation, Sentry Edge-runtime,
  and webpack cache-size warnings remained non-fatal.
- `git diff --check` — clean before commit.

## Follow-ups

- PR #1398 merged externally to `main` as `8fca436d` after hosted checks passed. The configured main
  auto-deploy was triggered, but this session has not independently verified the production revision.

- After the PR merges, confirm the next scheduled run of each mapped workflow
  produces the expected Sentry Cron monitor check-in.
- Do not add a `merge-shepherd` cron mapping unless a `schedule:` trigger is
  added to `.github/workflows/merge-shepherd.yml`; the host-side launchd cadence
  is not visible as a GitHub `workflow_run.event == schedule` event.
