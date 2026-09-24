# Rollout Note - 2026-07-13 - SEC/RAG Implementation Program

## Summary

Started the owner-directed implementation train for all nine packages in the 1,000-stock SEC/RAG plan. Reserved
the work on both effort boards, announced the fileset claim in `#agent-sync`, re-audited the merged P0/P1
baselines, and split the first code wave into three isolated lanes: durable ingest state, historical SEC
discovery/pacing, and DOM/iXBRL parsing/chunking.

## Why

Merged P0/P1 work supplied useful scaffolding but does not meet the plan's launch gates. The universe generator
mistakes SEC ticker-file order for prominence and has no dated eligibility receipt. The census cannot certify
target-slot, revision, provenance, or point-in-time completeness. Filing/artifact/occurrence tables exist, but
durable jobs, immutable raw objects, section/table lineage, and verified-complete receipts do not. The active
ingester still reads only recent exact-form filings and uses regex HTML stripping plus whitespace token counts.
The committed JSON has 1,000 unique CIKs/tickers, but zero aliases and all 1,000 rows lack exchange, security
type, effective date, market cap, and dollar-volume fields; title heuristics also surface non-operating vehicles
that need explicit classification instead of silent inclusion.

## Decisions

- Treat #1495/#1496/#1520/#1527 as baselines to harden, not proof that P0/P1 acceptance passed.
- Keep AG PR #1533's admin coverage and `src/lib/db-learning.ts` files out of this train until reconciled.
- Run fixture/local tests only during implementation; do not perform a production/provider/corpus write yet.
- Keep Node 24. The host default is Node 26.5.0, but `.nvmrc`, CI, production, and native-module ABI remain 24.
- Land a dependency-ordered PR train, with each package independently reviewable and rollbackable.

## Files

- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`
- `docs/reviews/2026-07-12-sec-rag-1000-stock-backfill-plan.md`
- `/Users/jay/apps/TRADING-EFFORT-LOG.md` (branch-neutral live board)
- `docs/rollouts/2026-07-13-sec-rag-program.md`
- `package.json`
- `scripts/eval/validate-rag-universe.ts`
- `src/lib/rag/universe-manifest.ts`
- `test/rag-universe-manifest.test.ts`
- `src/lib/db.ts`
- `src/lib/db-rag-ingest.ts`
- `test/rag-ingest-worker.test.ts`

The discovery and parser lane files will be appended after adversarial integration review.

## Verification

- `git status --short --branch` - clean baseline before board/docs edits.
- `gh pr view 1494 --json ...` - confirmed merged with green checks.
- `gh pr view 1533 --json ...` - confirmed open fileset KEEPOUT.
- `python3 /Users/jay/apps/codex-coordination-audit.py --repo /Users/jay/Code/Socratic-Trade` - read-only audit;
  reported the canonical live-board filename incorrectly, so no `--apply` was used.
- `node --version` - host default `v26.5.0`.
- `/opt/homebrew/opt/node@24/bin/node --version` - supported runtime `v24.18.0`.
- `jq` manifest audit - 1,000 unique CIKs, zero aliases, and 1,000/1,000 rows missing each required
  exchange/security-type/effective-date/market-cap/dollar-volume dimension.
- `npm run eval:validate-universe` - expected FAIL on the legacy bare-array manifest; proves the new gate does
  not mistake row count for acceptance.
- `npx vitest run test/rag-universe-manifest.test.ts test/rag-ingest-worker.test.ts` under Node 24 - 16/16 pass.
- Adversarial worker follow-up: primary-key collisions now fail visibly rather than being swallowed by broad
  conflict handling, and repeated expired leases dead-letter at the configured stage-attempt budget.
- Targeted ESLint for the new validator/state modules and tests - pass.
- `git diff --check` - pass.
- Initial serialized gate: lint 0 errors / 447 inherited warnings, TypeScript clean, and 352 files / 3,950 tests
  passed; the build caught a `node:crypto` Edge import trace from the new DB barrel export.
- Replaced that import with the repository's build-safe `crypto` form, reran the production build successfully,
  then reran the entire ordered Node 24 gate: lint 0 errors / 447 warnings, TypeScript clean, 352 files / 3,950
  tests passed, and production build passed.
- `#agent-sync` receipts: posted `gating now` before the full gate and `gate clear` only after the green rerun.
- Merged `origin/main@1a90281b`, then `scripts/land.sh` repeated clean TypeScript, 352 files / 3,950 tests, and
  production build; ready PR #1543 was opened. Hosted checks and review remain; nothing is merged or deployed.

## Follow-ups

- Open the first dependency PR for the universe acceptance contract and durable ingest state.
- Correct and re-review the rejected discovery/pacing and parser/chunker drafts before integration.
- Adversarially review the corrected universe/census lane before integration.
- Harden the universe/census acceptance receipt.
- Implement structured facts, lexical+dense retrieval, real-EDGAR evaluation, and strategy evidence packets.
- Run no shadow backfill until all prerequisite gates pass and breaker values are pinned.
