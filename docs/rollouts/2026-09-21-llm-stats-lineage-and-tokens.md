# 2026-09-21 LLM Stats Lineage, Token Usage, and Lifetime Retention

## Context & Objective
Preserve historical cost and latency stats across model upgrades and prevent premature data loss by lifting the 90-day window to lifetime queries, exempting `llm_call_latency` from audit pruning, and establishing predecessor lineage roll-forward.  Additionally, capture and surface token usage metrics across historical records and forward-looking model statistics in both API and Console drawer UI.

## Changes Made
- **Catalog Lineage & Predecessors (`src/lib/llm-model-catalog.ts`)**:
  - Added `lineage` family tags and `predecessors` arrays across catalog entries (`LlmCatalogEntry`).
  - Exported `getPredecessorModelIds` to retrieve predecessor models in priority order.
- **Audit Retention Exemption (`src/lib/audit-prune.ts`)**:
  - Added `"llm_call_latency"` to `AUDIT_PRUNE_NEVER_PRUNED_KINDS` so daily SQLite prune passes preserve latency audit records indefinitely.
- **Token Aggregation & Roll-Forward Engine (`src/lib/model-stats.ts`)**:
  - Expanded `UsageRowLike` and `ModelRoleStats` with token metrics (`totalTokens`, `avgTokensPerCall`, `promptTokens`, `completionTokens`) and inheritance metadata (`inheritedFrom`, `isInherited`, `inheritedClosedTrades`).
  - Implemented predecessor lineage roll-forward when direct samples (< 3 calls), closed trades (< 20 trades), or matured vetoes (< 20 vetoes) are below statistical significance.
  - Allowed `string | null` in `ClosedLotLike` to safely accept raw closed lot inputs.
- **API Route Lifetime Query (`app/api/llm-usage/model-stats/route.ts`)**:
  - Defaulted `sinceDays` to `0` (all-time lifetime query) instead of hardcoded 90 days.
  - Increased `listAuditByKind("llm_call_latency", 10000, userId)` limit from 2,000 to 10,000.
  - Passes token metrics directly from `getLlmUsageSummary`.
- **Console Drawer UI (`app/console/components/model-stats-drawer.tsx`)**:
  - Added time range selector (`All Time`, `90 Days`, `30 Days`) using the `Segmented` primitive.
  - Added a `Tokens / call` column showing formatted averages and breakdown tooltip.
  - Added inheritance indicator chips and badges when metrics are rolled forward from predecessor models.
- **Backfill Script & Tests**:
  - Created `scripts/ops/backfill-pruned-latency-audits.ts` for idempotent recovery of pruned latency audit rows from snapshots.
  - Added unit test `test/backfill-latency-audits.test.ts`.
  - Added unit tests in `test/model-stats.test.ts` and `test/audit-hygiene.test.ts`.

### Touched Files
- `src/lib/llm-model-catalog.ts`
- `src/lib/audit-prune.ts`
- `src/lib/model-stats.ts`
- `app/api/llm-usage/model-stats/route.ts`
- `app/console/components/model-stats-drawer.tsx`
- `scripts/ops/backfill-pruned-latency-audits.ts`
- `test/model-stats.test.ts`
- `test/audit-hygiene.test.ts`
- `test/backfill-latency-audits.test.ts`
- `docs/EFFORT-LOG.md`
- `/Users/jay/apps/TRADING-EFFORT-LOG.md`
- `STATUS.md`

## Decisions & Trade-offs
- **Historical Tokens**: `llm_usage` table already recorded `prompt_tokens`, `completion_tokens`, and `total_tokens`.  Lifting `sinceDays = 0` makes all past token usage available immediately without schema changes.
- **Lineage Roll-Forward Gating**: When a model shifts (e.g., GPT-5.6 Sol succeeding Terra), direct outcomes start at 0.  Combining predecessor lots ensures models don't spend months in "needs >= 20 closed trades" cold-start amnesia.  Inherited stats are explicitly badged with "from <Model>" so data provenance is 100% transparent.
- **Non-Destructive Backfill**: The backfill script uses `INSERT OR IGNORE` to safely restore older latency audit events without conflicting with existing data.

## Verification State
- `npm run lint`: Passed (0 errors, 821 grandfathered warnings).
- `npx tsc --noEmit`: Clean pass (0 type errors).
- `npm test`: Target test suites passed (`test/model-stats.test.ts`, `test/audit-hygiene.test.ts`, `test/backfill-latency-audits.test.ts`, `test/model-stats-drawer.test.ts`).  Full vitest run passed 7,957 tests.
- `npm run build`: Full Next.js production build succeeded cleanly.

## Next Steps & Blockers
- None.  Ready for commit, push, PR creation, and auto-merge.
