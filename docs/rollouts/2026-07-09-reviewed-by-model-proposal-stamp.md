# 2026-07-09 - reviewed-by-model-proposal-stamp

## Summary

- Resumed the `reviewedByModel` proposal stamp task and verified the changes.
- Stamped `reviewedByModel` on trade proposals during the Red Team review loop, persisted it in closed lots, propagated it to the model stats API, and aggregated realized performance symmetrically for the Reviewer role.

## Why

- Correctly attributes realized performance to Reviewer (Red Team / Bear) models by proposal-level stamping.
- Previously, Red Team performance was aggregated via per-run llm_step audits rather than per-proposal outcomes, leading to partial/stale performance metrics for reviewers.

## Files

- [src/lib/types.ts](file:///Users/jay/Code/Socratic-Trade/src/lib/types.ts)
- [src/lib/strategy.ts](file:///Users/jay/Code/Socratic-Trade/src/lib/strategy.ts)
- [src/lib/performance.ts](file:///Users/jay/Code/Socratic-Trade/src/lib/performance.ts)
- [app/api/llm-usage/model-stats/route.ts](file:///Users/jay/Code/Socratic-Trade/app/api/llm-usage/model-stats/route.ts)
- [src/lib/model-stats.ts](file:///Users/jay/Code/Socratic-Trade/src/lib/model-stats.ts)
- [test/model-stats.test.ts](file:///Users/jay/Code/Socratic-Trade/test/model-stats.test.ts)

## Verification

- `npx tsc --noEmit` (clean)
- `npm run lint` (clean, 0 errors)
- `npx vitest run test/model-stats.test.ts` (17/17 passed)
- `npm test` (727/727 passed)
- `npm run build` (Next.js build succeeded)

## Follow-ups

- None. Both proposer and reviewer models are now symmetrically tracked in performance stats.
