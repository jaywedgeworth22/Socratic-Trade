# 2026-09-18 - ci-monitor-margin

## Context & Objective

Sentry issue **FLEET-INFRA-DB** (`https://jays-services.sentry.io/issues/7739795875/`)
opened at 2026-09-18T08:02Z as `Cron failure: ci-socratic-trade-ci` /
`A missed check-in was detected`.  The scheduled `CI` workflow is healthy.
GitHub's `schedule` trigger for `.github/workflows/ci.yml` is delivered hours
late, and main-push runs share the `ci-CI-refs/heads/main` concurrency group,
so the 15-minute Crons margin pages the 07:47Z nightly canary.  Goal: stop
that false page without changing the CI cron, the verify suite, or Coolify.

## Changes Made

Widened the Sentry Crons `checkin_margin` for workflow `CI` from 15 minutes
to 600 minutes (10h), via the existing per-workflow `CHECKIN_MARGIN_OVERRIDES`
map in `scripts/sentry-ci-report.py`.  `Deploy freshness`, `RTH Deploy Latch`,
`Cleanup Actions Caches`, and `Effort Issues Sync` stay at 600 (#3194 /
#3387 / #3389 / #3390).  Every other monitor keeps the 15-minute default.
The workflow crontabs (`47 7 * * *` nightly canary and `17 * * * *` hourly
backstop) and the verify jobs are unchanged.

Evidence:

- Monitor `ci-socratic-trade-ci` (`d510d384-9ce2-4c18-ba25-b9a7f06e5d68`):
  crontab `47 7 * * *`, `checkin_margin` 15, `max_runtime` 60.  1 missed
  event (first seen 2026-09-18T08:02Z).  0 users.  Seer actionability
  super_low.  Last check-in 2026-09-18T04:49:47Z ok (~17s).  Next expected
  2026-09-19T07:47:00Z.
- Scheduled Actions runs (`gh api .../ci.yml/runs?event=schedule`) succeed.
  Nightly-canary-length runs (full hosted suite, ~20-32 min) start late:
  2026-09-17 12:46Z, 09-16 12:49Z, 09-15 12:53Z, 09-14 14:24Z (typical
  delay ~5h; worst retained ~6h 37m after the 07:47Z slot).  Hourly
  `17 * * * *` backstop ticks are usually ~15s skips.
- No 2026-09-18 `47 7 * * *` `schedule` run existed at the 08:02Z miss.
  Last scheduled success is `35308437859` (09-18 04:49Z, 17s hourly skip).
  Main push `35321123883` started 07:47:17Z on the same concurrency group;
  push `35322526054` at 08:04Z would cancel a pending scheduled tick.
- Reporter already sends `in_progress` on `workflow_run` `requested` and
  check-ins only for `event == schedule`.  in_progress cannot cover a run
  that does not exist yet.  Slug is already `ci-socratic-trade-ci`.

Files touched:

- `scripts/sentry-ci-report.py` — `CHECKIN_MARGIN_OVERRIDES["CI"] = 600`
- `test/sentry-ci-report-workflows.test.ts` — assert freshness + latch + cleanup + effort sync + CI are 600
- `STATUS.md` / `PLAN.md` / `docs/EFFORT-LOG.md` — handoff rows
- `docs/rollouts/2026-09-18-ci-monitor-margin.md` — this note

## Decisions & Trade-offs

600 minutes matches #3194 / #3387 / #3389 / #3390 and sits above the
measured 6h 37m worst nightly delay while still paging ~17:47Z if no
scheduled CI check-in arrives.  The hourly backstop can also satisfy the
widened window; the monitor already receives those check-ins today.

Do not copy this onto 30-min macos iOS-ship crons (FLEET-INFRA-CC / DA / CX).
Those drop most ticks; a 100-105 minute margin already failed.

Deliberately NOT `"Fixes FLEET-INFRA-DB"`: the 600-minute config upserts on
the next scheduled check-in.  Resolve DB only after `ci-socratic-trade-ci`
has an OK under that config.

Out of scope: changing `ci.yml`, dispatching CI, and rematching Playwright
Smoke (`17 9 * * *`, still 15).  Sibling daily-cron margin PRs already
landed.

## Verification State

```
python3 -m py_compile scripts/sentry-ci-report.py   # clean
node --input-type=module -e '...parse CHECKIN_MARGIN_OVERRIDES...'
# OVERRIDE_PARSE_OK { Deploy freshness: 600, RTH Deploy Latch: 600, Cleanup Actions Caches: 600, Effort Issues Sync: 600, CI: 600 }
# CI_CRON_OK 47 7 * * *
```

Did not run `npm run lint` / `npx tsc --noEmit` / full `npm test` / `npm run
build` on this seat (no `node_modules` in the shallow clone).  Hosted
`verify` is the JS gate.  The new vitest assertion is the same parse as the
node check above.  Did not `workflow_dispatch` `ci.yml`.  Did not PUT the
Sentry monitor by hand; the next scheduled check-in upserts the new margin.

## Next Steps & Blockers

1. Merge this PR.  Do not dispatch CI to "verify".
2. Wait for the next scheduled run (hourly `:17` or the late nightly canary
   ~12:46-14:24Z).  Confirm monitor `ci-socratic-trade-ci` upserts
   `checkin_margin: 600` and lands `ok`.
3. Then ignore/resolve FLEET-INFRA-DB.  Do not rematch it with a second
   margin PR.
4. If a 07:47Z slot has no scheduled Actions check-in by ~17:47Z the same
   day, treat that as a real silent canary and page.

Blockers: none.  Reporter-only.  Extra-ship no.  No Coolify.

## Zero-Code Findings

The verify suite was not the failure mode.  This is GitHub schedule delivery
(plus main-push concurrency on the same group) vs a 15-minute Crons margin,
the same class #3194 already fixed for `Deploy freshness`, #3387 for
`RTH Deploy Latch`, #3389 for `Cleanup Actions Caches`, and #3390 for
`Effort Issues Sync`.
