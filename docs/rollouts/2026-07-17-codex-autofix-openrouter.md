# Codex autofix: 4/5 review findings fixed on PR #1703

**Date:** 2026-07-17
**Agent:** `[codex-autofix]` (Claude Code)
**PR:** [#1703](https://github.com/jaywedgeworth22/Socratic-Trade/pull/1703) — `antigravity/openrouter-universal-routing`

## Summary

Addressed 4 of 5 unresolved Codex review threads on PR #1703 (the universal OpenRouter routing change). One architecturally-significant finding was left open with a question to the maintainer.

## Findings fixed

### 1. P1 — Strip legacy `openrouter/` namespace (thread `PRRT_kwDOS7mOVM6Rqh88`)
**File:** `src/lib/llm-provider.ts`
**Fix:** Added `model.replace(/^openrouter\//i, "")` after the provider-prefixing block in `resolveLlmEndpoint` so that legacy saved model IDs like `"openrouter/google/gemini-2.5-flash"` are sent to OpenRouter as `"google/gemini-2.5-flash"`.

### 2. P1 — GPT-5 reasoning handling after OpenRouter qualification (thread `PRRT_kwDOS7mOVM6Rqh8-`)
**File:** `src/lib/llm-request.ts`
**Fix:** `isReasoningModel` now calls `lowerModel(model)` instead of `(model ?? "").trim()` before the regex test. This strips the `openai/` prefix so that `openai/gpt-5.4-mini` correctly matches `/^(gpt-5|o\d)/i`. Every other model-checking helper in `reasoningCapabilityForModel` already used `lowerModel`; `isReasoningModel` was the sole outlier.

### 3. P2 — Normalize routed model IDs before cost accounting (thread `PRRT_kwDOS7mOVM6Rqh9B`)
**File:** `src/lib/llm-usage.ts`
**Fix:** `priceForModel` now strips the routing prefix (everything before the first `/`) from the model ID before exact/prefix-matching against the price table. `"openai/gpt-5.6-luna"` → `"gpt-5.6-luna"` correctly matches the defined price.

### 4. P2 — Treat whitespace-only company names as absent (thread `PRRT_kwDOS7mOVM6Rqh9F`)
**File:** `src/lib/db-securities-import.ts`
**Fix:** Changed `r.companyName ?? null` to `r.companyName?.trim() || null` so whitespace-only strings are treated as null and cannot overwrite a stored valid company name via the upsert's `COALESCE`.

## Finding left open

### P1 — Preserve existing provider credentials (thread `PRRT_kwDOS7mOVM6Rqh86`)
**Status:** QUESTION ASKED — posted PR comment asking the maintainer how to handle users with existing OpenAI/Anthropic/Gemini/xAI/Mistral/DeepSeek keys but no saved OpenRouter key. Three options proposed: auto-fallback to native provider, credential migration, or error-as-guidance in Settings. Maintainer's answer pending.

## Verification

All three verification gates passed:
```bash
npx tsc --noEmit   # clean
npm test           # exit code 0 (all tests pass)
npm run build      # succeeds
```

## Files touched

- `src/lib/llm-provider.ts` — strip `openrouter/` prefix
- `src/lib/llm-request.ts` — `isReasoningModel` uses `lowerModel`
- `src/lib/llm-usage.ts` — `priceForModel` strips routing prefix
- `src/lib/db-securities-import.ts` — trim whitespace-only company names
- `STATUS.md` — added current status entry
- `docs/rollouts/2026-07-17-codex-autofix-openrouter.md` — this note

## Follow-ups

- Maintainer response on credential migration strategy
- Thread `PRRT_kwDOS7mOVM6Rqh86` left unresolved pending maintainer answer — now RESOLVED as of subsequent manual fix
- Auto-merge enabled via `gh pr merge 1703 --squash --auto`

---

## 2026-07-17 — Autofix round 2: triage remaining 1 thread

**Summary:** Triaged the only remaining unresolved Codex thread — the P2 "Wire FMP toggles into provider execution" finding. Asked maintainer how to proceed since wiring settings to runtime providers is architecturally significant.

### Thread handled

- **P2 — Wire FMP toggles into provider execution** (thread `PRRT_kwDOS7mOVM6Rt6NY`): Posted PR comment #5001522334 asking whether to wire in this PR or stage separately, and what toggle-off behavior should be. Left unresolved pending maintainer reply.

### Files touched

- `STATUS.md` — updated current status entry

### Outcome

Auto-merge already enabled from prior round. No code changes this round — the one actionable thread was already resolved by a prior autofix or manual fix. The remaining P2 is an architectural question, not a clear bug.
