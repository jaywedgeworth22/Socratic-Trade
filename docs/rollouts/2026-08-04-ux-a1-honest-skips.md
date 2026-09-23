# Rollout: UX PR-A1 — Honest run skip statuses

**Date:** 2026-08-04  
**Author:** GROK  
**Branch:** `grok/ux-a1-honest-skips`  
**PR:** https://github.com/jaywedgeworth22/Socratic-Trade/pull/2418  
**Program:** `docs/design/ux-improvement-program.md` §PR-A1

## Context & Objective

Budget / market-closed / broker-unhealthy strategy skips must never look like successful
"completed" decision runs. Operators need distinct Thesis last-run + Activity chips.

## Changes Made

### Status model (explicit statuses, no SQLite migration)

`strategy_runs.status` is free-text; TypeScript unions expanded:

| Status | Meaning |
|--------|---------|
| `completed` | Decision cycle ran (LLM evaluated; may propose nothing) |
| `failed` | Hard error |
| `skipped_budget` | Pre-decision LLM/usage budget gate |
| `skipped_market_closed` | Market closed (holiday/weekend) |
| `skipped_broker_unhealthy` | Broker health check failed |
| `skipped` | Other pre-decision skip (e.g. unfunded equity) or legacy rows |

Central module: `src/lib/strategy-run-status.ts`
- `strategyRunStatusLabel(status, summary?)` → UI chips
- `classifyStrategyRunSkip` → maps legacy `skipped` + summary text
- `isStrategyRunSkipStatus` / `isStrategyRunDecisionCompletion`

### Engine

`src/lib/strategy.ts` finish paths write granular skip statuses. Skip *policy* unchanged.

### UI

- Thesis strategy bar + Run cadence: honest label, warn tone for skips
- Activity Runs: warn chips with class-specific labels
- `feedStatusLabel` maps new statuses
- Thesis headline does not claim "completed" after a skip

### Liveness / auto-tune

- Liveness only treats `status='completed'` as healthy — tests assert pure skips do not refresh it
- Auto-tune already gated on `status === "completed"` — tests cover all skip variants

### Files

- `src/lib/strategy-run-status.ts` (new)
- `src/lib/strategy.ts`, `src/lib/db-execution.ts`, `src/lib/types.ts`
- `src/lib/dashboard-ui.ts`, `src/lib/dashboard-feed.ts`, `src/lib/scheduler.ts`
- `app/console/lib/last-run.ts`, `app/console/page.tsx`, `app/console/activity/page.tsx`
- `app/console/decisions/[id]/page.tsx`, `app/dashboard-types.ts`
- `test/strategy-run-status.test.ts` (new) + last-run / liveness / auto-tune / money-path updates
- Docs: this file, `STATUS.md`, `docs/EFFORT-LOG.md`

## Decisions & Trade-offs

- Explicit DB statuses for new writes (acceptance prefers explicit when low-migration).
- Legacy `skipped` rows still get honest labels via summary classification.
- Market-closed inline cause suppressed on Thesis bar (Paused chip already present).

## Verification State

```bash
node_modules/.bin/vitest run \
  test/strategy-run-status.test.ts \
  test/console-last-run.test.ts \
  test/trading-liveness.test.ts \
  test/scheduler-followup-lease.test.ts
# Full gate: bash scripts/land.sh
```

## Next Steps & Blockers

- Land / auto-merge PR #2418 when verify green.
- Wave A next: PR-A2, PR-A3, PR-A4 (A4/A5 may already land in parallel).
