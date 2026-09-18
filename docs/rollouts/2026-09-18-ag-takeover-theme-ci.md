# GROK takeover of MM #3379 theme CI

## Context & Objective

Board `6aa1e66e`.  PR #3379 failed hosted tsc: `Cannot find module '@/app/ui/theme'`.  ST `tsconfig` maps `@/*` to `./src/*`, so that alias cannot reach `app/ui/theme.tsx`.

## Changes Made

- `app/console/lib/useConsoleTheme.ts` and `app/console/ui/ticker-logo.tsx` import `../../ui/theme`.
- `app/ui/toaster.tsx` feeds Sonner `resolvedTheme` (`light` | `dark`) so a stored `system` choice does not pass an unsupported toaster theme.
- Default remains light until the user picks Dark or System.

## Decisions & Trade-offs

- Kept MM/AG's single resolver.  Did not restore the old `console:theme` localStorage key.
- Extra-ship no.  No Coolify Deploy.

## Verification State

- Import path matches `tsconfig` `@/*` → `./src/*`.  Hosted `verify` is the tsc gate (local npm registry ETIMEDOUT).

## Next Steps & Blockers

- Push `origin/mm/ag-takeover-2056ceab` and re-arm squash auto-merge.
- Close duplicate AG PR #3375 after #3379 merges.
