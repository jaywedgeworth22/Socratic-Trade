# 2026-07-17 - openrouter-model-stats-canonicalization

## Summary

- Implemented server-side model ID canonicalization (`cleanModelId`) inside `aggregateModelStats` and `normalizeBenchmarkSummaries` in [model-stats.ts](file:///Users/jay/Code/Socratic-Trade/src/lib/model-stats.ts).
- Modified model stats assertions in [model-stats.test.ts](file:///Users/jay/Code/Socratic-Trade/test/model-stats.test.ts) to verify that qualified model IDs (e.g. `xai/grok-4.3`) are correctly canonicalized and aggregated under their bare catalog names (e.g. `grok-4.3`).

## Why

- Under universal OpenRouter routing, model calls record qualified model IDs (e.g. `openai/gpt-4o`, `google/gemini-2.5-flash`), which splits usage history and stats from direct-provider rows and historical offline benchmarks (which use bare IDs like `gpt-4o`).
- Without canonicalization, lookup of live stats in the Model Stats drawer (which keys on catalog model IDs using bare names) fails, displaying empty dashes (`—`) for active models.
- Canonicalizing model IDs to their bare base names ensures all live and historical stats align perfectly in the Model Stats drawer lookup.

## Files

- [src/lib/model-stats.ts](file:///Users/jay/Code/Socratic-Trade/src/lib/model-stats.ts)
- [test/model-stats.test.ts](file:///Users/jay/Code/Socratic-Trade/test/model-stats.test.ts)

## Verification

- `node node_modules/typescript/bin/tsc --noEmit` (passed)
- `npx vitest run test/model-stats.test.ts` (passed)
- `npm run lint` (passed)

## Follow-ups

- Coordinate with Monet on branch `monet/usage-canonical-model-merge` for client-side usage page merging.
