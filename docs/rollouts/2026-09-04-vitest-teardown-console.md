# 2026-09-04 — Vitest EnvironmentTeardownError after #3162 (onUserConsoleLog RPC)

## Context & Objective

Main verify on SHA `80515c15` (#3162) failed after every test passed:
`EnvironmentTeardownError: [vitest-worker]: Closing rpc while "onUserConsoleLog" was pending`,
attributed to `test/economic-calendar-prompt-wiring.test.ts`.  Prior seat timed out
mid-investigation with no commit.  Goal is a minimal fix so verify is green and
worker teardown is clean.

## Changes Made

`onConsoleLog: () => false` (added in #3046) still intercepts console and forwards each
log over worker RPC.  Returning false only suppresses reporter printing.  A strategy
file that logs while the worker is closing leaves `onUserConsoleLog` pending and
fails the suite with `Errors 1` even though 7761 tests passed.

The real off-switch is `disableConsoleIntercept: true`.  Console then writes to
stdout/stderr directly, so there is no RPC to race.  `setup-peer-lane-cleanup.ts`
noops `console.log` / `info` / `debug` so CI stays quiet; `warn` / `error` stay
intact because other tests spy on them.

### Files

- `vitest.config.ts` — `disableConsoleIntercept: true`; drop `onConsoleLog: () => false`
- `test/setup-peer-lane-cleanup.ts` — quiet log/info/debug without touching warn/error
- `test/vitest-console-intercept.test.ts` — regression pin so the #3046 handler cannot return
- `STATUS.md`, `PLAN.md`, `docs/EFFORT-LOG.md`

## Decisions & Trade-offs

- Do not special-case `economic-calendar-prompt-wiring.test.ts`.  That file is a heavy
  `runStrategyOnce` logger; the RPC race can hit any file that logs during teardown
  (same flake already noted on #3142).
- Do not raise `teardownTimeout` or swallow the unhandled rejection.  That hides the
  race instead of removing it.
- Image-noop for Coolify (`vitest.config.ts` / `test/**` / docs are outside
  `watch_paths`).  No Coolify mutate.  No extra-ship.  No merge from this lane.

## Verification State

```bash
npx vitest run \
  test/vitest-console-intercept.test.ts \
  test/economic-calendar-prompt-wiring.test.ts
# Test Files  2 passed (2)
# Tests  3 passed (3)
# Duration  6.67s
# No EnvironmentTeardownError.

npx eslint vitest.config.ts test/setup-peer-lane-cleanup.ts \
  test/vitest-console-intercept.test.ts
# exit 0
```

Node v24.16.0.  Full `npm run lint` / `npx tsc --noEmit` / `npm test` / `npm run build` not re-run on this seat (prior land.sh timed out mid-gate).  Authoritative remaining gate is GitHub `verify` on the PR.  Image-noop (`vitest.config.ts` / `test/**` / docs are outside Coolify `watch_paths`).

## Next Steps & Blockers

- PR: https://github.com/jaywedgeworth22/Socratic-Trade/pull/3163  SHA `4fba321ff`.
- CI `verify` is the remaining gate (full tsc / vitest / next build).  Do not merge, Coolify-nudge, or extra-ship from this seat.
