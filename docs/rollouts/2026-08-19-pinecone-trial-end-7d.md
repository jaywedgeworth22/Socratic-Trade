# 2026-08-19 — Pinecone trial end in 7 days

## Context & Objective

Owner: set the app's Standard-trial end date to 7 days from 2026-08-19 21:59 CT.
Pinecone's console still shows the original 21-day trial (11/21 on the screenshot).
This change is the **app calendar** that paces the daily write fuse and snaps to
free-tier caps.  It does not change Pinecone's own trial length or credit.

## Changes Made

Moved `PINECONE_CURRENT_TRIAL_ENDS_AT` from `2026-08-30T00:00:00.000Z` to
`2026-08-27T00:00:00.000Z`.  At the owner's request instant that is 7 remaining
days (`ceil` of ~6d 21h).  Infisical prod `PINECONE_TRIAL_ENDS_AT` is now present
(len=24).  It was missing before; the code default would have applied after
deploy either way.  The explicit env wins on the next boot.

Touched files:

- `src/lib/pinecone-trial-window.ts`
- `.env.example`
- `test/pinecone-trial-window.test.ts`
- `STATUS.md`, `PLAN.md`, `docs/EFFORT-LOG.md`, this note

## Decisions & Trade-offs

- Date is UTC midnight 2026-08-27 so remainingDays=7 from 2026-08-19 21:59 CT.
  Aug 26 00:00 UTC would have been only ~6 remaining days.
- Did not raise or lower `RAG_PINECONE_MAX_WRITE_UNITS_PER_DAY`.
- Did not change Pinecone's console / plan.  Agents cannot extend that trial.
- Pacing unit tests that assert 14 remaining days keep an explicit
  `PINECONE_TRIAL_ENDS_AT=2026-08-30` pin so the algorithm math stays stable.

## Verification State

```bash
cd ~/apps/trading-cursor-trial-end
npm run lint          # 0 errors
npx tsc --noEmit      # clean
./node_modules/.bin/vitest run \
  test/pinecone-trial-window.test.ts \
  test/pinecone-monthly-pace.test.ts \
  test/pinecone-wu-breaker.test.ts
# 3 files / 31 passed
```

```
./node_modules/.bin/vitest run
# 615 files passed / 1 skipped; 7075 tests passed / 51 skipped
./node_modules/.bin/next build --webpack
# Next.js 16.3.0 webpack build succeeded
```

PR: https://github.com/jaywedgeworth22/Socratic-Trade/pull/2940

## Next Steps & Blockers

- After merge: confirm Connections / ingest still treat the trial as active
  until 2026-08-27T00:00:00.000Z, then free-tier snap (60k WU/day, 1.6M/month).
- Infisical change takes effect on the next container boot (auto-deploy on merge).

## Zero-Code Findings

- The Pinecone console card (Standard trial, $80.83 / $300, 11 / 21 days,
  Upgrade now) is vendor UI.  Setting `PINECONE_TRIAL_ENDS_AT` does not rewrite
  that card.
