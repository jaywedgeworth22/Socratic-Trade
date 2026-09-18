# 2026-09-17 - rth-deploy-latch-monitor-margin

## Context & Objective

Sentry issue **FLEET-INFRA-C3** (`https://jays-services.sentry.io/issues/7698533487/`)
regressed again at 2026-09-17T21:35Z as `Cron failure: ci-rth-deploy-latch` /
`A missed check-in was detected`.  The after-close drain is healthy.  GitHub's
`schedule` trigger for `.github/workflows/rth-deploy-latch.yml` is delivered
hours late, so the 15-minute Crons margin is structurally guaranteed to page
every weekday.  Goal: stop that false page without changing the latch, the
drain, or Coolify.

## Changes Made

Widened the Sentry Crons `checkin_margin` for workflow `RTH Deploy Latch` from
15 minutes to 600 minutes (10h), via the existing per-workflow
`CHECKIN_MARGIN_OVERRIDES` map in `scripts/sentry-ci-report.py`.  `Deploy
freshness` stays at 600 (#3194 / FLEET-INFRA-C1).  Every other monitor keeps
the 15-minute default.  The workflow crontab (`20 21 * * 1-5`) and
`scripts/rth-deploy-drain.sh` are unchanged.

Evidence:

- Monitor `ci-rth-deploy-latch` (`f7c796da-0697-421d-b5df-25b0101e18cf`):
  crontab `20 21 * * 1-5`, `checkin_margin` 15, `max_runtime` 60.  16 missed
  events since 2026-08-28.  0 users.  Seer actionability low.  Every weekday
  misses at 21:35Z and auto-resolves when the late OK lands (~23:14-23:54Z).
- Scheduled Actions runs (`gh run list --workflow rth-deploy-latch.yml
  --event schedule`) all start late, then finish in ~20s on `ubuntu-latest`:
  2026-09-16 23:40Z, 09-15 23:32Z, 09-14 23:53Z, 09-11 23:21Z, 09-10 23:14Z
  (typical delay 114-154 min).  Worst in the retained window: 2026-08-28
  05:28Z (~8h after the prior 21:20Z slot).  One real job failure
  (2026-09-03 23:19Z) is a separate error check-in, not this miss.
- #3302 (`fd300985`, 2026-09-17 12:26Z) already sends `in_progress` on
  `workflow_run` `requested`.  That only helps after GitHub creates the run.
  A 23:40Z start cannot cover a 21:35Z miss.  #3302 also changed the slug
  from `ci-{slugify(name)}` to `ci-{APP}-{slugify(name)}`, so the next
  scheduled check-in upserts `ci-socratic-trade-rth-deploy-latch`.  The
  open C3 issue is the pre-#3302 slug and will go silent.

Files touched:

- `scripts/sentry-ci-report.py` — `CHECKIN_MARGIN_OVERRIDES["RTH Deploy Latch"] = 600`
- `test/sentry-ci-report-workflows.test.ts` — assert only freshness + latch are 600
- `STATUS.md` / `PLAN.md` / `docs/EFFORT-LOG.md` — handoff rows
- `docs/rollouts/2026-09-17-rth-deploy-latch-monitor-margin.md` — this note

## Decisions & Trade-offs

600 minutes matches #3194 and sits above the measured 8h worst delay while
still paging Saturday ~07:20Z if Friday's drain never starts.  The drain's
job is "ship a weekday-RTH merge after the 16:00 ET close"; a 2-8h GitHub
delay still lands after close.  The freshness watchdog (600 min, 20-min
cron) remains the silent-freeze page.

Do not copy this onto 30-min macos iOS-ship crons (FLEET-INFRA-CC / DA / CX).
Those drop most ticks; a 100-105 minute margin already failed.

Deliberately NOT `"Fixes FLEET-INFRA-C3"`: the live upsert after #3302 goes
to `ci-socratic-trade-rth-deploy-latch`.  Resolve C3 only after that new
monitor has an OK under the 600-minute config, then ignore/resolve the
orphaned pre-#3302 issue.

Out of scope: Coolify webhook, `rth-deploy-drain.sh` nudge-exit, extra
post-close ticks, and dispatching this workflow (that would nudge Coolify).

## Verification State

```
python3 -m py_compile scripts/sentry-ci-report.py   # clean
node --input-type=module -e '...parse CHECKIN_MARGIN_OVERRIDES...'
# OVERRIDE_PARSE_OK { Deploy freshness: 600, RTH Deploy Latch: 600 }
# LATCH_CRON_OK 20 21 * * 1-5
```

Did not run `npm run lint` / `npx tsc --noEmit` / full `npm test` / `npm run
build` on this seat (no `node_modules` in the shallow clone).  Hosted
`verify` is the JS gate.  The new vitest assertion is the same parse as the
node check above.  Did not `workflow_dispatch` `rth-deploy-latch.yml`.
Did not PUT the Sentry monitor by hand; the next scheduled check-in upserts
the new margin.

## Next Steps & Blockers

1. Merge this PR.  Do not dispatch the latch to "verify".
2. Wait for the next weekday scheduled run (GitHub typically ~23:14-23:54Z).
   Confirm monitor `ci-socratic-trade-rth-deploy-latch` upserts
   `checkin_margin: 600` and lands `ok`.
3. Ignore/resolve FLEET-INFRA-C3 (`ci-rth-deploy-latch`) as the pre-#3302
   orphan.  Do not rematch it with a second margin PR.
4. If a weekday 21:20Z slot has no Actions run by ~07:20Z the next day,
   treat that as a real silent drain and page.

Blockers: none.  Reporter-only.  Extra-ship no.  No Coolify.

## Zero-Code Findings

The latch Dockerfile assert and drain script were not the failure mode.
This is GitHub schedule delivery vs a 15-minute Crons margin, the same
class #3194 already fixed for `Deploy freshness`.
