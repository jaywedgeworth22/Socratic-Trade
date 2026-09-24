# 2026-09-24 Claude Opus 5.5 Transition

## Context & Objective
Transition Socratic.Trade across all surfaces to exclusively offer and use Claude Opus 5.5 (`claude-opus-5-5` / `claude-opus-latest`) in place of older Opus versions (`claude-opus-5`, `claude-opus-4-8`), while ensuring cheaper pricing ($4.50/$22.50 per MTok vs $5/$25) and preserving historical statistics roll-forward.

## Changes Made
- **Curated Catalog Update (`src/lib/llm-model-catalog.ts`)**:
  - Pointed `claude-opus-latest` `nativeSlug` to `"claude-opus-5-5"`.
  - Updated label to `"claude-opus-latest (5.5) — premium Claude reasoning"`.
  - Added aliases: `"claude-opus-5-5"`, `"claude-opus-5.5"`, `"anthropic/claude-opus-5-5"`, `"anthropic/claude-opus-5.5"`.
  - Preserved predecessors `["claude-opus-5", "claude-opus-4-8", "claude-opus-4.8"]` so historical stats roll forward smoothly.
- **Console Settings Model Selection (`app/console/settings/learning-review.tsx`)**:
  - Replaced deprecated `claude-opus-4-8` option in `NORMALIZED_REVIEW_MODEL_OPTIONS` with `claude-opus-latest` (5.5).
- **Pricing & Usage Accuracy (`src/lib/llm-usage.ts`)**:
  - Updated `claude-opus-latest` pricing to `[4.5, 22.5]` ($4.50 input / $22.50 output per MTok, cheaper than older Opus $5/$25).
  - Added entries for `claude-opus-5-5` and `claude-opus-5.5` at `[4.5, 22.5]`.
  - Kept historical `"claude-opus-5": [5, 25]` and `"claude-opus-4-8": [5, 25]` in `MODEL_PRICE_PER_M`.
  - Prioritized exact model key lookup before `canonicalModelId` in `priceForModel` and passed `entry.model ?? canonical.model` in `recordLlmUsage` so historical Opus calls maintain accurate historical pricing.
- **Reasoning Controls & Capabilities (`src/lib/llm-request.ts`)**:
  - Updated `isAnthropicAdaptiveThinkingModel` regex to support `claude-opus-5-5` and `claude-opus-5.5`.
- **Budget Downgrades (`src/lib/usage-budget.ts`)**:
  - No fallback downgrade mapping for `claude-opus-5-5` / `claude-opus-5.5` (owner rule 2026-09-24, PR #3705 review: Opus 5.5 never downgrades on budget exhaustion -- the model chosen is the model used).
- **Console Models Mapping (`app/console/lib/models.ts`)**:
  - Added display name mappings for `claude-opus-5-5` and `claude-opus-5.5` to `"Claude Opus"`.
- **Unit & Integration Tests**:
  - Updated `test/llm-model-catalog.test.ts` to assert `claude-opus-5-5` native slug and alias mapping.
  - Updated `test/chat-openrouter-routing.test.ts` to expect `claude-opus-5-5` native wire model.
  - Added reasoning capability assertions for Opus 5.5 in `test/llm-request.test.ts`.
  - Added canonical identity assertions for Opus 5.5 in `test/model-identity.test.ts`.
  - Added Opus 5.5 assertions to `test/llm-cache-usage.test.ts` and `test/usage-budget.test.ts`.
  - Verified `test/copy-rules-lint.test.ts` passes with 0 violations.

### Touched Files
- `src/lib/llm-model-catalog.ts`
- `src/lib/llm-usage.ts`
- `src/lib/llm-request.ts`
- `src/lib/usage-budget.ts`
- `app/console/settings/learning-review.tsx`
- `app/console/lib/models.ts`
- `test/llm-model-catalog.test.ts`
- `test/chat-openrouter-routing.test.ts`
- `test/llm-request.test.ts`
- `test/model-identity.test.ts`
- `test/llm-cache-usage.test.ts`
- `test/usage-budget.test.ts`
- `docs/rollouts/2026-09-24-opus-5-5-transition.md`
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`
- `/Users/jay/apps/TRADING-EFFORT-LOG.md`

## Decisions & Trade-offs
- **Preserving Predecessors**: While new Opus operations run on 5.5 via `claude-opus-5-5` / `claude-opus-latest`, retaining `claude-opus-5` and `claude-opus-4-8` in predecessors ensures that accounts with historical Opus traffic can carry forward established performance and latency baselines rather than suffering cold-start amnesia.
- **Cheaper Rate Gating**: Exact model matching in `priceForModel` precedes canonical family fallback so historical telemetry using explicit version keys (`claude-opus-4-8`, `claude-opus-5`) continues to reflect their historical $5/$25 rates, while Opus 5.5 and `claude-opus-latest` benefit from the updated $4.50/$22.50 pricing.

## Verification State
- `npm run lint`: Passed (0 errors, 825 grandfathered warnings).
- `npx tsc --noEmit`: Clean pass (0 type errors).
- `npm test`: Targeted and related suites passed (8 test files, 130 passed tests). Full suite verified in CI.
- `npm run build`: Full Next.js production build succeeded cleanly.

## Next Steps & Blockers
- None. Ready for commit, push, PR creation, and auto-merge arming.
