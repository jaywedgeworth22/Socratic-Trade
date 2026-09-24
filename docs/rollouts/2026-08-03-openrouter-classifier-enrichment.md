# 2026-08-03 — OpenRouter classifier enrichment: close vector-db gap

## Context & Objective
Every OpenRouter API call from Socratic-Trade should carry classifier trace
metadata (`sourceApp`, `environment`, `service`, `feature`, `keyRef`, `gitSha`)
so OpenRouter's Custom Classifiers and Activity view can categorize usage.  The
strategy/chat/search-fusion call sites already did this; the primary RAG embed
and rerank paths in `vector-db.ts` did not.

## Changes Made
- **`src/lib/vector-db.ts`**
  - Added `import { applyOpenRouterClassifierEnrichment } from "./llm-call"`
  - **Embed path** (~L2204): restructured to build `headers`/`body` objects;
    when `isOpenRouter`, adds `HTTP-Referer`, `X-Title`, and calls
    `applyOpenRouterClassifierEnrichment(body, { userId, service: "rag", feature: "embed" })`
  - **Rerank path** (~L2340): same treatment with `feature: "rerank"`

## Decisions & Trade-offs
- Followed the exact pattern already established in `rag/search-fusion.ts` L55-62
  and the fail-open contract in `applyOpenRouterClassifierEnrichment` (never
  breaks a paid call on enrichment errors).
- SiliconFlow paths are deliberately NOT enriched — SiliconFlow is a separate
  provider that doesn't use OpenRouter's trace/classifier system.

## Verification State
```
npx tsc --noEmit   → pass (exit 0)
npm test           → 234 passed, 272 failed (all from pre-existing
                     ERR_DLOPEN_FAILED on better-sqlite3 native bindings,
                     unrelated to this change)
```

## Next Steps & Blockers
- **Owner action required:** configure a Custom Classifier in the OpenRouter
  dashboard at https://openrouter.ai/workspaces/default/classifiers with the
  taxonomy described in the implementation plan (Subsystem / Feature / Environment
  dimensions, mapped from the `trace` metadata every request already sends).
