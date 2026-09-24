# OpenAI Model Tier Slug Mapping

**Date**: 2026-07-24  
**Author**: ANTIGRAVITY  
**PR**: [#2219](https://github.com/jaywedgeworth22/Socratic-Trade/pull/2219)

---

## 1. Context & Objective
Fixed an OpenRouter model resolution issue where generic model tier aliases (e.g. `gpt-sol-latest`, `gpt-terra-latest`, `gpt-mini-latest`) were generating auto-router fallback wire IDs such as `~openai/gpt-latest`, causing OpenRouter dispatch errors (404 / Invalid Model ID).

## 2. Changes Made
- Updated `normalizeOpenRouterModelId()` in `src/lib/llm-provider.ts` to map OpenAI model tiers directly to explicit versioned OpenRouter wire IDs:
  - `gpt-sol-latest` -> `openai/gpt-5.6-sol`
  - `gpt-terra-latest` -> `openai/gpt-5.6-terra`
  - `gpt-luna-latest` -> `openai/gpt-5.6-luna`
  - `gpt-mini-latest` -> `openai/gpt-5.4-mini`
  - `gpt-nano-latest` -> `openai/gpt-5.4-nano`
  - `gpt-4o-latest` -> `openai/gpt-4o-latest`
- Updated assertion in `test/dashboard-feed.test.ts` to align with `cellTitle` output format.

## 3. Touched Files
- `src/lib/llm-provider.ts`
- `test/dashboard-feed.test.ts`
- `STATUS.md`
- `docs/EFFORT-LOG.md`
- `/Users/jay/apps/TRADING-EFFORT-LOG.md`

## 4. Verification State
- `tsc --noEmit` exit 0
- `npx vitest run test/openrouter-model-availability.test.ts` exit 0
- `npx vitest run test/dashboard-feed.test.ts` exit 0
- PR [#2219](https://github.com/jaywedgeworth22/Socratic-Trade/pull/2219) opened and pushed.
