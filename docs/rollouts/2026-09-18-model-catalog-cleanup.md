# 2026-09-18 — model-catalog cleanup

## Summary

- Curated LLM catalog (`src/lib/llm-model-catalog.ts`) drops from 32 to 21 rows.
- 11 strictly-dominated rows removed; one corrected label and one tier swap.
- `MODEL_PRICE_PER_M` (`src/lib/llm-usage.ts`) re-verified against live OpenRouter; eight entries corrected (two of them materially).
- iOS `DeskModels.swift` mirror updated; test updated to match the new `gpt-6-astra-pro` label format.
- One follow-up correction appended to `docs/rollouts/2026-09-09-model-catalog-account-labels.md` (rather than rewritten) per `AGENTS.md` "leave a paper trail when a later change supersedes part of an earlier rollout".

## Why

- The catalog had accumulated rows that no provider/offering evaluation would actually pick — every removed row is strictly dominated by a same-provider sibling still in the catalog on every axis (price, quality, context, reasoning).
- The dropdown labels on a few rows implied a routing distinction that does not exist (every catalog row routes through OpenRouter whenever a credential is configured; "via OpenRouter" on a single row is misleading).
- The price table was drifted from live OpenRouter — Claude verified each entry, found multiple material mis-pricings (Kimi K3's input was the cache-HIT rate, not the real rate).

## Files

- `app/console/lib/models.ts` — remove the 11 display-name rows for the retired models.
- `app/console/settings/learning-review.tsx` — comment-only: default `learningReviewModel` is now `claude-fable-latest`, not `claude-fable-5`.
- `app/ui/llm-model-catalog.ts` — `meta` picker header is "Meta", not "Meta (via OpenRouter)".
- `docs/manager-model-options.md` — append 2026-09-18 cleanup section.
- `docs/rollouts/2026-09-09-model-catalog-account-labels.md` — append a correction note (paper trail, not edit-in-place).
- `docs/rollouts/2026-09-18-model-catalog-cleanup.md` — this file.
- `ios/SocraticTrade/DeskModels.swift` — mirror removed models and the `gpt-6-astra-pro` retag explanation.
- `src/lib/defaults.ts` — comment-only.
- `src/lib/llm-model-catalog.ts` — remove the 11 catalog rows, retag `gpt-6-astra-pro` label, swap Mistral `\$`/`\$\$` tier fields.
- `src/lib/llm-usage.ts` — corrected `MODEL_PRICE_PER_M` for the eight entries above; old prices for the 11 removed rows kept under a clearly commented "retired" block so any already-recorded historical usage still resolves to a cost estimate.
- `src/lib/model-reasoning-recommendations.ts` — Green Team chip moved from GPT-5.6 Terra to GPT-5.6 Sol.
- `src/lib/model-rotation.ts` — comment-only.
- `test/learning-review.test.ts` — assert the new `gpt-6-astra-pro` catalog label format.
- `test/llm-model-catalog.test.ts` — drop tests for the 11 retired rows; update label assertions for GPT-6 Astra Pro and Mistral tiers.

## Removed catalog rows (each dominated by a same-provider sibling in the catalog)

| Display name removed | Same-provider sibling that dominates it |
|---|---|
| GPT-5.4 Nano | GPT-5.4 (same provider, cheaper per token, larger context) |
| GPT Mini (5.4) | GPT-5.4 (same provider, dominant on every axis) |
| GPT-5.6 Terra | GPT-5.6 Sol (same input price, cheaper output, stronger model; Sol now carries both Green and Red recommendation chips) |
| GPT-4o | GPT-5.5 (same provider, dominant on every axis) |
| GPT-4o mini | GPT-5.4 (same provider, dominant on every axis) |
| Grok Build 0.1 | Grok 4.5 (same provider, dominant on every axis) |
| MiniMax M2.7 | MiniMax M3 (same price, five times the context) |
| DeepSeek R1 | DeepSeek Pro (same provider, dominant on every axis) |
| Llama 4 Maverick | MiniMax M3 (same-or-cheaper price, larger context) |
| Llama 4 Scout | Muse Spark 1.3 (same provider, dominant on every axis) |
| Llama 3.3 70B | MiniMax M3 (same provider, dominant on every axis) |

## Price corrections (live OpenRouter, 2026-09-18)

| Model | Old (input/output per M) | Real (input/output per M) |
|---|---|---|
| GPT-5.6 Sol | \$5 / \$30 | \$2 / \$10 |
| GPT-5.6 Luna | \$1 / \$6 | \$0.20 / \$1.20 |
| Claude Sonnet 5 | \$3 / \$15 | \$2 / \$10 |
| Kimi K3 | \$0.30 / \$1.20 | \$1.95 / \$10.92 (old was Kimi's cache-HIT input price, not the real rate) |
| DeepSeek Flash | drift corrected | re-verified |
| DeepSeek Pro | drift corrected | re-verified |
| Gemini Flash Lite | drift corrected | re-verified |
| Muse Glimmer 30B | drift corrected | re-verified |

## Verification

- `npx tsc --noEmit` — clean against `origin/main` baseline (no new errors caused by this diff; the 89 pre-existing `lucide-react` declaration-file errors are unchanged on `main`).
- `node node_modules/vitest/dist/cli.js run test/llm-model-catalog.test.ts test/learning-review.test.ts` — 57 / 57 passing.
- Full suite (`npm test`) — runs in hosted CI; this worktree has `node_modules` populated but `node_modules/.bin` is empty, so the targeted invocation used the direct CLI path.
- Build (`npm run build`) — runs in hosted CI; local `node_modules/.bin` is empty so `next` is not on PATH here. CI gate is the source of truth.

## Follow-ups

- The 11 retired prices are kept under a clearly commented "retired" block in `MODEL_PRICE_PER_M` so any already-recorded historical usage still resolves to a cost estimate; remove the block once all usage rows older than 2026-09-18 have aged out.
- `docs/rollouts/2026-09-09-model-catalog-account-labels.md` should be left untouched (per `AGENTS.md`) — the appended correction note is the paper trail.
- No deploy action: same-owner same-app change, no production-flag change, no migration, no schema. Auto-deploy on merge to `main` if the lane's gate is green.

## Blockers

- None.

## Replaced Docs

- `docs/rollouts/2026-09-09-model-catalog-account-labels.md` — appended correction (not replaced) per the rule "leave a paper trail when a later change supersedes part of an earlier rollout".