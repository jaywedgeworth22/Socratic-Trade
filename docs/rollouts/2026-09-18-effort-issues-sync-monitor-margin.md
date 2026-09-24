# 2026-09-18 - effort-issues-sync-monitor-margin

## Context & Objective

Sentry issue **FLEET-INFRA-C0** (`https://jays-services.sentry.io/issues/7695037114/`)
regressed again at 2026-09-18T06:27Z as `Cron failure: ci-effort-issues-sync` /
`A missed check-in was detected`.  The daily Effort Issues Sync board mirror
is healthy.  GitHub's `schedule` trigger for
`.github/workflows/effort-issues-sync.yml` is delivered hours late, so the
15-minute Crons margin is structurally guaranteed to page every day.  Goal:
stop that false page without changing the sync cron, the sync script, or
Coolify.

## Changes Made

Widened the Sentry Crons `checkin_margin` for workflow `Effort Issues Sync`
from 15 minutes to 600 minutes (10h), via the existing per-workflow
`CHECKIN_MARGIN_OVERRIDES` map in `scripts/sentry-ci-report.py`.  `Deploy
freshness`, `RTH Deploy Latch`, and `Cleanup Actions Caches` stay at 600
(#3194 / #3387 / #3389).  Every other monitor keeps the 15-minute default.
The workflow crontab (`12 6 * * *`) and `scripts/sync-effort-issues.py` are
unchanged.

Evidence:

- Monitor `ci-effort-issues-sync` (`f74a5a2c-38c9-4223-8195-a796ddd43bc3`):
  crontab `12 6 * * *`, `checkin_margin` 15, `max_runtime` 60.  24 missed
  events since 2026-08-27.  0 users.  Seer actionability super_low.  Every
  day misses at 06:27Z and auto-resolves when the late OK lands
  (~11:12-12:37Z).
- Scheduled Actions runs (`gh api .../effort-issues-sync.yml/runs?event=schedule`)
  all start late, then finish in ~12-30s on `ubuntu-latest`: 2026-09-17
  11:34Z, 09-16 11:25Z, 09-15 11:38Z, 09-13 11:44Z, 09-11 11:12Z (typical
  delay 5.0-5.5h).  Worst in the retained window: 2026-09-14 12:37Z (~6h
  25m after the 06:12Z slot).  All retained scheduled runs are `success`.
- No 2026-09-18 `schedule` run existed at the 06:27Z miss.  Last scheduled
  success is `35216405599` (09-17 11:34Z, 32s).  Reporter sent ok at
  11:35:15Z to the pre-#3302 slug.
- #3302 already sends `in_progress` on `workflow_run` `requested`.  That only
  helps after GitHub creates the run.  An 11:34Z start cannot cover a 06:27Z
  miss.  #3302 also changed the slug from `ci-{slugify(name)}` to
  `ci-{APP}-{slugify(name)}`, so the next scheduled check-in upserts
  `ci-socratic-trade-effort-issues-sync`.  The open C0 issue is the
  pre-#3302 slug and will go silent.

Files touched:

- `scripts/sentry-ci-report.py` — `CHECKIN_MARGIN_OVERRIDES["Effort Issues Sync"] = 600`
- `test/sentry-ci-report-workflows.test.ts` — assert freshness + latch + cleanup + effort sync are 600
- `STATUS.md` / `PLAN.md` / `docs/EFFORT-LOG.md` — handoff rows
- `docs/rollouts/2026-09-18-effort-issues-sync-monitor-margin.md` — this note

## Decisions & Trade-offs

600 minutes matches #3194 / #3387 / #3389 and sits above the measured 6h 25m
worst delay while still paging ~16:12Z if the daily sync never starts.
Board mirroring is not RTH-critical; a 5-6.5h GitHub delay still lands the
same day.

Do not copy this onto 30-min macos iOS-ship crons (FLEET-INFRA-CC / DA / CX).
Those drop most ticks; a 100-105 minute margin already failed.

Deliberately NOT `"Fixes FLEET-INFRA-C0"`: the live upsert after #3302 goes
to `ci-socratic-trade-effort-issues-sync`.  Resolve C0 only after that
new monitor has an OK under the 600-minute config, then ignore/resolve the
orphaned pre-#3302 issue.

Out of scope: changing `effort-issues-sync.yml`, the board-mirror script, and
dispatching this workflow.  Sibling 06:12Z misses on Congress.Trade
(FLEET-INFRA-23) and Usage-Monitor (FLEET-INFRA-CF) are not rematched from
this issue.

## Verification State

```
python3 -m py_compile scripts/sentry-ci-report.py   # clean
node --input-type=module -e '...parse CHECKIN_MARGIN_OVERRIDES...'
# OVERRIDE_PARSE_OK { Deploy freshness: 600, RTH Deploy Latch: 600, Cleanup Actions Caches: 600, Effort Issues Sync: 600 }
# EFFORT_CRON_OK 12 6 * * *
```

Did not run `npm run lint` / `npx tsc --noEmit` / full `npm test` / `npm run
build` on this seat (no `node_modules` in the shallow clone).  Hosted
`verify` is the JS gate.  The new vitest assertion is the same parse as the
node check above.  Did not `workflow_dispatch` `effort-issues-sync.yml`.
Did not PUT the Sentry monitor by hand; the next scheduled check-in upserts
the new margin.

## Next Steps & Blockers

1. Merge this PR.  Do not dispatch the sync to "verify".
2. Wait for the next scheduled run (GitHub typically ~11:12-12:37Z).
   Confirm monitor `ci-socratic-trade-effort-issues-sync` upserts
   `checkin_margin: 600` and lands `ok`.
3. Ignore/resolve FLEET-INFRA-C0 (`ci-effort-issues-sync`) as the
   pre-#3302 orphan.  Do not rematch it with a second margin PR.
4. If a 06:12Z slot has no Actions run by ~16:12Z the same day, treat that
   as a real silent sync and page.

Blockers: none.  Reporter-only.  Extra-ship no.  No Coolify.

## Zero-Code Findings

The board-mirror script and EFFORT-LOG parser were not the failure mode.
This is GitHub schedule delivery vs a 15-minute Crons margin, the same class
#3194 already fixed for `Deploy freshness`, #3387 for `RTH Deploy Latch`,
and #3389 for `Cleanup Actions Caches`.
