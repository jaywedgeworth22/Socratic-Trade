# Rollout Note: ATR Stop & Short cover-buy fixes

## Summary
Fixed two bugs flagged by automated Codex review comments on PR #1705:
1. Passed `input.candidateAtrStopPctBySymbol` into `compactMarketScanForPrompt` so that candidate stop distances are actually included when constructing Green Team prompts.
2. Switched from inline `exitSide/side` order filtering to the centralized `isLiveExitOrder` helper when filtering open exit orders, ensuring Alpaca `buy` side orders covering short positions are correctly identified as active protection.

## Why
1. In PR #1705, the computed candidate ATR stop percentages were fetched but omitted when calling `compactMarketScanForPrompt`, causing candidates to lack stop-distance data in Green Team prompts.
2. Alpaca maps short-closing order side to `"buy"` rather than `"cover"`, so filtering by `exitSide = "cover"` for shorts missed these open exit orders, falsely marking positions as unprotected and causing redundant proposed exits.

## Files
- `src/lib/strategy.ts` (Modified)
- `STATUS.md` (Modified)
- `docs/EFFORT-LOG.md` (Modified)

## Verification
- Local TypeScript compilation check: `npx tsc --noEmit` (Passed cleanly)
- Unit tests: `npx vitest run test/strategy-active-protection-wiring.test.ts` (Passed cleanly)
- Full gate execution via `land.sh` which ran:
  1. `eslint .` (Passed cleanly)
  2. `npx tsc --noEmit` (Passed cleanly)
  3. `npm test` (All 4,758 tests across 405 files passed cleanly)
  4. `npm run build` (Next.js build succeeded and compiled cleanly)
- Open PR opened: [PR #1713](https://github.com/jaywedgeworth22/Socratic-Trade/pull/1713) with auto-merge enabled.

## Follow-ups
None. Once PR #1713 checks are complete, it will squash-merge to `main` and auto-deploy to production on the Hetzner box.
