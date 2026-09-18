# 2026-09-18 - cleanup-actions-caches-monitor-margin

## Context & Objective

Sentry issue **FLEET-INFRA-BY** (`https://jays-services.sentry.io/issues/7695037058/`)
regressed again at 2026-09-18T03:20Z as `Cron failure: ci-cleanup-actions-caches` /
`A missed check-in was detected`.  The nightly Actions cache prune is healthy.
GitHub's `schedule` trigger for `.github/workflows/cleanup-caches.yml` is
delivered hours late, so the 15-minute Crons margin is structurally guaranteed
to page every day.  Goal: stop that false page without changing the prune
cron, the prune script, or Coolify.

## Changes Made

Widened the Sentry Crons `checkin_margin` for workflow `Cleanup Actions Caches`
from 15 minutes to 600 minutes (10h), via the existing per-workflow
`CHECKIN_MARGIN_OVERRIDES` map in `scripts/sentry-ci-report.py`.  `Deploy
freshness` and `RTH Deploy Latch` stay at 600 (#3194 / #3387).  Every other
monitor keeps the 15-minute default.  The workflow crontab (`5 3 * * *`) and
`scripts/prune-stale-actions-caches.py` are unchanged.

Evidence:

- Monitor `ci-cleanup-actions-caches` (`cb0a2dae-bbf8-43e6-b673-8684455ad62e`):
  crontab `5 3 * * *`, `checkin_margin` 15, `max_runtime` 60.  23 missed
  events since 2026-08-27.  0 users.  Seer actionability super_low.  Every
  day misses at 03:20Z and auto-resolves when the late OK lands
  (~07:35-08:48Z).
- Scheduled Actions runs (`gh api .../cleanup-caches.yml/runs?event=schedule`)
  all start late, then finish in ~12s on `ubuntu-latest`: 2026-09-17 08:34Z,
  09-16 08:29Z, 09-15 08:35Z, 09-14 08:48Z, 09-05 07:35Z (typical delay
  4.5-5.7h).  Worst in the retained window: 2026-08-29 09:57Z (~6h 52m after
  the 03:05Z slot).  All 20 retained scheduled runs are `success`.
- #3302 already sends `in_progress` on `workflow_run` `requested`.  That only
  helps after GitHub creates the run.  An 08:34Z start cannot cover a 03:20Z
  miss.  #3302 also changed the slug from `ci-{slugify(name)}` to
  `ci-{APP}-{slugify(name)}`, so the next scheduled check-in upserts
  `ci-socratic-trade-cleanup-actions-caches`.  The open BY issue is the
  pre-#3302 slug and will go silent.

Files touched:

- `scripts/sentry-ci-report.py` — `CHECKIN_MARGIN_OVERRIDES["Cleanup Actions Caches"] = 600`
- `test/sentry-ci-report-workflows.test.ts` — assert freshness + latch + cleanup are 600
- `STATUS.md` / `PLAN.md` / `docs/EFFORT-LOG.md` — handoff rows
- `docs/rollouts/2026-09-18-cleanup-actions-caches-monitor-margin.md` — this note

## Decisions & Trade-offs

600 minutes matches #3194 / #3387 and sits above the measured 6h 52m worst
delay while still paging ~13:05Z if the nightly prune never starts.  Cache
pruning is not RTH-critical; a 4.5-7h GitHub delay still lands the same day.

Do not copy this onto 30-min macos iOS-ship crons (FLEET-INFRA-CC / DA / CX).
Those drop most ticks; a 100-105 minute margin already failed.

Deliberately NOT `"Fixes FLEET-INFRA-BY"`: the live upsert after #3302 goes
to `ci-socratic-trade-cleanup-actions-caches`.  Resolve BY only after that
new monitor has an OK under the 600-minute config, then ignore/resolve the
orphaned pre-#3302 issue.

Out of scope: changing `cleanup-caches.yml`, the prune grouping rule, and
dispatching this workflow.

## Verification State

```
python3 -m py_compile scripts/sentry-ci-report.py   # clean
node --input-type=module -e '...parse CHECKIN_MARGIN_OVERRIDES...'
# OVERRIDE_PARSE_OK { Deploy freshness: 600, RTH Deploy Latch: 600, Cleanup Actions Caches: 600 }
# CLEANUP_CRON_OK 5 3 * * *
```

Did not run `npm run lint` / `npx tsc --noEmit` / full `npm test` / `npm run
build` on this seat (no `node_modules` in the shallow clone).  Hosted
`verify` is the JS gate.  The new vitest assertion is the same parse as the
node check above.  Did not `workflow_dispatch` `cleanup-caches.yml`.
Did not PUT the Sentry monitor by hand; the next scheduled check-in upserts
the new margin.

## Next Steps & Blockers

1. Merge this PR.  Do not dispatch the cleanup to "verify".
2. Wait for the next scheduled run (GitHub typically ~07:35-08:48Z).
   Confirm monitor `ci-socratic-trade-cleanup-actions-caches` upserts
   `checkin_margin: 600` and lands `ok`.
3. Ignore/resolve FLEET-INFRA-BY (`ci-cleanup-actions-caches`) as the
   pre-#3302 orphan.  Do not rematch it with a second margin PR.
4. If a 03:05Z slot has no Actions run by ~13:05Z the same day, treat that
   as a real silent prune and page.

Blockers: none.  Reporter-only.  Extra-ship no.  No Coolify.

## Zero-Code Findings

The prune script and cache grouping rule were not the failure mode.  This
is GitHub schedule delivery vs a 15-minute Crons margin, the same class
#3194 already fixed for `Deploy freshness` and #3387 for `RTH Deploy Latch`.
