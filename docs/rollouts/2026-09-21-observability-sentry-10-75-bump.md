# 2026-09-21 — observability group: @sentry/nextjs + @sentry/profiling-node 10.74.0 -> 10.75.0 (PR #3443, MUSE sweep)

## Context & Objective

Dependabot opened PR #3443 to bump the observability group: `@sentry/nextjs` `^10.74.0` -> `^10.75.0`
and `@sentry/profiling-node` `10.74.0` -> `10.75.0` (branch
`dependabot/npm_and_yarn/observability-43c28a6599`, commit `21860abc`).  The commit touched only
`package.json` and `package-lock.json`.  Codex review (P1, thread on `package.json:47`) flagged the
missing mandatory handoff records (`STATUS.md` + the tracked `docs/EFFORT-LOG.md` mirror) that
`AGENTS.md` requires of every commit/push, including bot-authored ones.  This round (MUSE fleet
PR-merge sweep) adds those records, merges current `origin/main`, and closes the review thread so
the PR can land.

## Changes Made

- `STATUS.md` — new dated snapshot entry for the bump and this sweep round.
- `docs/EFFORT-LOG.md` — new `[Socratic.Trade][MUSE]` row, marked `IN PR #3443`.
- `docs/rollouts/2026-09-21-observability-sentry-10-75-bump.md` — this note.
- `package.json` / `package-lock.json` — the Dependabot commit `21860abc` itself plus the
  main-merge (picks up #3445 jose 6.2.12, #3426, #3427; both bumps verified present in the merged
  manifest: `@sentry/nextjs` `^10.75.0` / `@sentry/profiling-node` `10.75.0`, lockfile 10.75.0).

The main merge auto-resolved cleanly - no conflicts.

## Decisions & Trade-offs

- **Patch-level same-minor bump, no source change.**  Sentry JS 10.75.0 is a same-minor release;
  nothing in `src/**` references Sentry internals that changed, so no migration or code change.
- **`PLAN.md` intentionally not updated.**  A patch-level dependency bump changes no scope,
  timeline, or approach.
- **Classified runtime dependency-only.**  `package.json`/`package-lock.json` are Coolify runtime
  `watch_paths`, so on merge this is image-deploy material subject to the weekday RTH latch -
  not a docs-only update.  (Same classification Codex required on PR #3178.)
- **No local re-run of the lint/tsc/test/build gates this round.**  The dependency content is
  unchanged from the commit CI already verified; the merge introduced no new dependency lines.
  The required `verify` CI check re-runs on push and is the authoritative gate.

## Verification State

The dependency-diff portion of the PR touches only `package.json` + `package-lock.json`
(lockfile resolves `@sentry/nextjs` and `@sentry/profiling-node` at 10.75.0; parsed and verified
in the merged tree).  The required `verify` CI check runs lint -> tsc -> test -> build
(`.github/workflows/ci.yml:311-314`) on the pushed commit and is the authoritative gate.

## Next Steps & Blockers

- None.  Auto-merge is armed; the required `verify` check gates the merge.  The Codex P1 thread
  is resolved by this round's handoff records.
- Reminder for whoever merges: merging to `main` auto-deploys.  This diff touches
  `package.json`/`package-lock.json`, which **are** in `socratic-app`'s `watch_paths`, so it is a
  real (non-noop) deploy - subject to the weekday RTH image-build latch unless it lands in the
  evening/weekend window.

## Zero-Code Findings

Codex's finding was documentation-only; no correctness defect was reported in the dependency bump
itself.  The version range and lockfile resolution were checked and are consistent.
