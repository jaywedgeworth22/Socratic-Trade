# 2026-09-21 — observability group: @sentry/nextjs + @sentry/profiling-node 10.74.0 -> 10.75.0 (PR #3443, MUSE sweep)

## Context & Objective

Dependabot opened PR #3443 to bump the observability group: `@sentry/nextjs` `^10.74.0` -> `^10.75.0`
and `@sentry/profiling-node` `10.74.0` -> `10.75.0` (a SemVer **minor** release, not a patch) (branch
`dependabot/npm_and_yarn/observability-43c28a6599`, commit `21860abc`).  The commit touched only
`package.json` and `package-lock.json`.  Codex review (P1, thread on `package.json:47`) flagged the
missing mandatory handoff records (`STATUS.md` + the tracked `docs/EFFORT-LOG.md` mirror) that
`AGENTS.md` requires of every commit/push, including bot-authored ones.  This round (MUSE fleet
PR-merge sweep) adds those records, merges current `origin/main`, and closes the review thread so
the PR can land.

## Changes Made

- `PLAN.md` — new dated entry for the bump (round-3; AGENTS.md requires a PLAN.md entry at every commit boundary).
- `STATUS.md` — new dated snapshot entry for the bump and this sweep round.
- `docs/EFFORT-LOG.md` — new `[Socratic.Trade][MUSE]` row, marked `IN PR #3443`.
- `docs/rollouts/2026-09-21-observability-sentry-10-75-bump.md` — this note.
- `package.json` / `package-lock.json` — the Dependabot commit `21860abc` itself plus the
  main-merge (picks up #3445 jose 6.2.12, #3426, #3427; both bumps verified present in the merged
  manifest: `@sentry/nextjs` `^10.75.0` / `@sentry/profiling-node` `10.75.0`, lockfile 10.75.0).

The main merge auto-resolved cleanly - no conflicts.

## Decisions & Trade-offs

- **Minor release, no source change required.**  10.74.0 -> 10.75.0 increments the SemVer minor
  component (correction: an earlier revision of this note called it a patch-level same-minor bump,
  which understated the change - Codex P2).  Nothing in `src/**` references Sentry internals that
  changed between these minors, so no migration or code change is needed; the bump stays
  compatible with the existing `src/lib/sentry*.ts` usage.
- **`PLAN.md` updated (round-3).**  The round-1/round-2 rationale that a dependency bump
  needs no PLAN.md entry was wrong — AGENTS.md requires a PLAN.md entry at every commit
  boundary, so the round-3 commit added one at the top of PLAN.md.  The earlier
  "intentionally not updated / patch-level" wording below is superseded and retained only
  for history.
- **Classified runtime dependency-only.**  `package.json`/`package-lock.json` are Coolify runtime
  `watch_paths`, so on merge this is image-deploy material subject to the weekday RTH latch -
  not a docs-only update.  (Same classification Codex required on PR #3178.)
- **Local gate re-run this round (see Round 2 below).**  The round-1 text deferred to CI; Codex
  P1 requires the gates run and recorded locally, so the full `lint` -> `tsc` -> `test` -> `build`
  sequence was run on the merged tree after a fresh `npm install`, in order, with results below.

## Verification State

The dependency-diff portion of the PR touches only `package.json` + `package-lock.json`
(lockfile resolves `@sentry/nextjs` and `@sentry/profiling-node` at 10.75.0 - verified with
`node -e "const l=require('./package-lock.json');console.log(l.packages['node_modules/@sentry/nextjs'].version,l.packages['node_modules/@sentry/profiling-node'].version)"`
-> `10.75.0 10.75.0`).  Local gate results (mandated order, fresh `npm install`, on the
round-2 tree that also merges post-#3446 `origin/main`):

```
- `npm run lint` -> PASS (exit 0; 0 errors, 821 grandfathered warnings)
- `npx tsc --noEmit` -> PASS (exit 0, clean)
- `npm test` -> 7 failed / 8162 passed / 51 skipped (8220 tests); 1 file failed /
                    746 passed / 1 skipped (748 files); Duration 2642.07s.  All 7 failures are in
                    `test/market-hours.test.ts` (the `previousTradingDayStart` /
                    `nextTradingDayStart` / `nextMarketOpenHint` suites).  Root cause is
                    environmental, proven 2026-09-21: the functions return ET-midnight
                    instants while the tests assert on *local-time* date components
                    (`getFullYear()/getMonth()/getDate()`); on the Mac's America/Chicago
                    clock ET midnight is 23:00 the prior local day, so the assertions
                    shift by one.  Re-ran the file under `TZ=America/New_York` and
                    `TZ=UTC`: 39/39 pass in both.  CI runners are UTC and the required
                    `verify` check is green on this tree.  Unrelated to this
                    dependency-only diff (no `src/`, `app/`, `test/`, or `ios/` file touched).
- `npm run build` -> PASS (`.next/BUILD_ID` written; the regenerated
                    `ios/SocraticTradeTests/Fixtures/policy-contract.json` churn was reverted,
                    not committed)
```

The required `verify` CI check re-runs on push and is the authoritative gate for the new head.
It is `success` on the current head (`4235968f`).

**Round-4 update (2026-09-21):** The local gate quartet above was recorded on the round-2 tree
(post-#3446 merge).  The tree has since advanced through: (a) the post-#3444 main merge
(`262d6ead`, bringing #3444's vitest 5.0.1 which had its own green `verify` CI), (b) the round-3
docs commit (`68adb16e`, PLAN.md entry + timezone root-cause), and (c) the round-4 docs commit
(`4235968f`, this note's PLAN.md consistency fix).  Changes (b) and (c) are documentation-only;
the required `verify` CI check is green on the final head (`4235968f`), which is the
authoritative gate for the exact tree being merged.

## Next Steps & Blockers

- No code blockers.  The local `npm test` shows 7 failures that are proven
  machine-timezone artifacts (39/39 pass under `TZ=America/New_York` and `TZ=UTC`;
  see Verification State), and the authoritative required `verify` CI check is
  green on this head.  Auto-merge is armed and gates on `verify`.
- Round-3 doc fixes (Codex P1s 2026-09-21 14:35/14:39Z): this note now carries the
  mandatory `PLAN.md` entry reference and the corrected timezone-root-cause
  attribution above, replacing the earlier vague "time-sensitive" wording and the
  bare "None" blockers line.
- Reminder for whoever merges: merging to `main` auto-deploys.  This diff touches
  `package.json`/`package-lock.json`, which **are** in `socratic-app`'s `watch_paths`, so it is a
  real (non-noop) deploy - subject to the weekday RTH image-build latch unless it lands in the
  evening/weekend window.

## Zero-Code Findings

Codex's finding was documentation-only; no correctness defect was reported in the dependency bump
itself.  The version range and lockfile resolution were checked and are consistent.

## Round 2 — MUSE sweep (2026-09-21): answer codex-autofix review of the round-1 push

The repo's codex-autofix loop reviewed the round-1 push and raised three findings, all addressed:

1. *"Run the required gates before declaring the bump ready"* (P1).  Accepted - the round-1 note
   deferred to CI; the full local gate is now run and recorded in `## Verification State` above,
   on the round-2 tree (which also merges post-#3446 `origin/main`).
2. *"List the updated handoff docs in the commit message"* (P1).  This round's commit *subject*
   names the updated docs (`STATUS.md`, `docs/EFFORT-LOG.md`,
   `docs/rollouts/2026-09-21-observability-sentry-10-75-bump.md`) - subjects matter because this
   repo sets `squash_merge_commit_message: COMMIT_MESSAGES`, so commit bodies never reach the
   squash message.  Belt and suspenders: auto-merge is armed with an explicit `commitHeadline` /
   `commitBody` via the `enablePullRequestAutoMerge` GraphQL mutation, so the permanent history
   names the docs regardless of composition.
3. *"Classify 10.75.0 as a minor release"* (P2).  Accepted - corrected in place above; the earlier
   "patch-level same-minor" wording understated the change.

## Round 6 — MUSE sweep (2026-09-21): commit message names handoff docs

Codex P1 (17:11Z) flagged that the round-5 commit message did not name the handoff docs.
This commit's message explicitly names them: PLAN.md, STATUS.md, docs/EFFORT-LOG.md,
docs/rollouts/2026-09-21-observability-sentry-10-75-bump.md.  The final squash message
(armed via auto-merge) also names all four.
