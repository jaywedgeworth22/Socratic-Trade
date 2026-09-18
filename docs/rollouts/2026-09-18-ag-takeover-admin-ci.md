# GROK takeover of MM #3378 admin CI

## Context & Objective

Board `6aa1e66e`.  MiniMax cherry-picked AG `ag/eb883289` onto `mm/ag-takeover-eb883289` (PR #3378).  Hosted `verify` failed on two real tests, not a truncated lucide-react.d.ts.  GROK continues the MM remote (no rebrand) and unsticks CI.

## Changes Made

- `test/operator-diagnostics-ui.test.ts` — `/admin/backtest-ic` lives in `app/admin/admin-shell.tsx` after the layout/shell split, not `layout.tsx`.
- `app/admin/page.tsx` — CPU-load caveat `title` uses `SENTENCE_GAP` so the peer-locked copy-rules budget stays 46 (was 47).
- `app/admin/admin-shell.tsx` — render `activeItem.label` in the top bar so the nav lookup is used.

## Decisions & Trade-offs

- Did not raise the copy-rules cap.  The extra violation was one new sentence in a title attribute; gap it.
- Local `npm ci` hit registry ETIMEDOUT (cache missing `zwitch-2.0.4.tgz`).  Copy-rules and the wiring marker were checked with the standalone lint script.  Hosted `verify` is the typecheck/test gate.
- Extra-ship no.  No Coolify Deploy.

## Verification State

- `node scripts/copy-rules-lint.mjs` path via `lintFiles(collectFiles(["app"]))`: lockedTotal 46, unlocked 0.
- `app/admin/admin-shell.tsx` contains `/admin/backtest-ic`.

## Next Steps & Blockers

- Push to `origin/mm/ag-takeover-eb883289` and re-arm squash auto-merge (not `--admin`).
- Close duplicate AG PR #3376 after #3378 merges.
