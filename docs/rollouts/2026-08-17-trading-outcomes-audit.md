# 2026-08-17 — Trading-outcomes audit (report-only)

## Context & Objective

Owner asked for a quantitative / microstructure / risk / trading-systems / model-validation audit of Socratic-Trade's macro analysis, Green/Red/Bull process, proposal→execution outcomes, portfolio/risk, backtests, benchmarks, slippage/fees, causality/leakage, paper-vs-live parity, learning loops, and outcome accuracy.  Goal: a dated evidence report and a prioritized test/eval plan, without placing trades or changing money-path behavior.

## Changes Made

Read-only.  No execution, policy, or schema edits.

- Wrote `docs/audits/2026-08-17-trading-outcomes.md` (findings, severity, risks, metrics, fixes, Tier A/B/C eval plan).
- Pointed `docs/phase-7-strategy.md` at the paper/live doc-vs-retrieval contradiction.
- Pointed `docs/phase-3-performance.md` at residual cost / join / slippage gaps.
- Reserved the effort on `docs/EFFORT-LOG.md`, `STATUS.md`, and `PLAN.md`.
- Posted reservation to #agent-sync.

Files touched:

- `docs/audits/2026-08-17-trading-outcomes.md` (new)
- `docs/rollouts/2026-08-17-trading-outcomes-audit.md` (this note)
- `docs/phase-7-strategy.md`
- `docs/phase-3-performance.md`
- `docs/EFFORT-LOG.md`
- `STATUS.md`
- `PLAN.md`

## Decisions & Trade-offs

- Did not pull `/api/ops/snapshot` or production P&L.  This is a design/validation audit, not a live-desk RCA.
- Did not treat owner-directed paper→live pooling as a P0 bug.  It is a contract contradiction (Phase 7 still describes a transfer gate).  Reconciliation is an owner/docs follow-up.
- Did not implement Tier A tests in this PR.  Report-only, as requested.
- Related open work left alone: #2280 (PIT masking), #2563 / PR #2793 (curl-only diagnostics UI), #2786 (Green failover).

## Verification State

Docs-only.  Did not run `npm run lint`, `npx tsc --noEmit`, `npm test`, or `npm run build` — no TypeScript or runtime behavior changed.

Commands actually run:

- `git status` / `git log -5`
- `gh issue list` / `gh pr list` / `gh issue view 2280`
- Code reads and greps of the files listed in the audit §12
- Slack reservation to `C0BEZDJDNKV`

## Next Steps & Blockers

Next agent (or a follow-up PR): implement Tier A tests in the audit (§9), or the Phase 7 paper/live doc reconciliation.  Do not enable `autoApplyWeights` or an LLM-in-history eval until #2280 slice 2 and the cost/purge floors are addressed.

No blockers.  No money-path change to deploy.

## Zero-Code Findings

See the audit.  Headline P1s: stale propose-time VIX vs live brake; unenforced Green/Red parity; paper/live pooling vs Phase 7 text; `oosPurgeEmbargo` default off + 500-row IC cap; paper 1 bps vs OOS 20 bps; #2280 slice 2 still open.
