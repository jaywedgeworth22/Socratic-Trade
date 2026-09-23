# 2026-07-12 — SEC/RAG 1,000-stock high-yield backfill plan

## Summary

Completed a docs-only, three-expert audit and implementation plan for importing SEC filings and related
structured disclosures for a frozen 1,000-issuer universe. The recommended design catalogs and archives broadly,
stores exact financial/ownership/transaction facts structurally, embeds only retrieval-worthy narrative/tables/
material exhibits, and keeps derived summaries subordinate to cited primary evidence.

The plan defines:

- current code blockers and effort-log work IDs `RAG-B01` through `RAG-B18`;
- form/item/exhibit yield and retain/structure/embed/skip policy;
- immutable artifacts, canonical manifests, occurrence-safe provenance, and durable job state;
- DOM/iXBRL parsing and tokenizer-aware prose/table chunking;
- intent-routed structured, dense, and corpus-wide lexical retrieval with wide reranking/diversity;
- 10 -> 25 -> 100 -> 300 -> 1,000 breadth-first shadow backfill waves;
- provider pacing, planning volume/cost, budget breakers, evaluation gates, cutover, rollback, and freshness;
- nine planned implementation rows in both effort-log mirrors.

No product source, provider configuration, corpus data, Pinecone index, production runtime, or deployment was
changed. No bulk backfill was started.

Delivery: commit `8fda1325`; ready PR
[#1494](https://github.com/jaywedgeworth22/Socratic-Trade/pull/1494); unmerged; production unchanged.

## Why

The merged cap/lookback increase makes more ingestion possible, but the current synchronous recent-filings path
cannot prove a complete or retrieval-safe 1,000-issuer corpus. The audit found bulk blockers: recent/exact-form-
only discovery, no historical 8-K exhibit importer, global text-hash dedup that erases later evidence
occurrences, regex table destruction, approximate token counting, coarse/partial completion state, point-in-time
timestamp risk, no raw archive, thin structured facts, dense-shortlist-only “hybrid” recall, early rerank
truncation, inaccurate coverage reporting, mocked evaluation, config drift, and non-aggregate SEC pacing.

The plan makes correctness, provenance, evaluation, and resumability gates to spend rather than assuming higher
caps solve them.

## Decisions

- Archive every filing manifest and selected immutable primary artifacts, but do not embed every byte.
- Use CIK as issuer identity and preserve ticker/share-class history.
- Store XBRL, insider, ownership, 13F-derived, and offering facts/events structurally.
- Split embedding-cache dedup from evidence-occurrence identity before mass ingestion.
- Use a dedicated resumable worker and shadow corpus, not an admin request or detached scheduler task.
- Complete one current document round for every issuer before deepening history.
- Keep `voyage-finance-2` until a real EDGAR benchmark proves a better model.
- Require real-corpus retrieval, grounding, numeric, point-in-time, idempotency, cost, and reconciliation gates.

## Files

- `docs/reviews/2026-07-12-sec-rag-1000-stock-backfill-plan.md` — primary architecture and execution plan.
- `docs/rollouts/2026-07-12-sec-rag-1000-stock-backfill-plan.md` — this chronological handoff.
- `docs/EFFORT-LOG.md` — plan state plus nine unassigned implementation packages.
- `/Users/jay/apps/TRADING-EFFORT-LOG.md` — branch-neutral mirror of this effort and backlog.
- `STATUS.md` — current local/unmerged/production-unchanged state.
- `PLAN.md` — roadmap decision and dependency order.
- `docs/phase-10-signals-learning-ui-v2.md` — XBRL/D3 RAG prerequisite and sequencing correction.
- `docs/design/full-filing-rag.md` — explicit pointer that the original recent-10-K/10-Q design is not the
  1,000-issuer bulk architecture.

## Verification

Actually run during the audit:

- `git status --short && git log -3 --oneline`
- `git fetch origin && git rev-parse --short HEAD && git rev-parse --short origin/main`
- `curl -fsS https://socratictrade.com/api/health` — production release matched `c9023ea6`; DB, scheduler,
  Pinecone, Voyage embeddings/rerank, and Litestream reported healthy; Alpha Vantage was noncritical degraded.
- Focused `rg`/`sed` review of SEC ingestion, chunking, vector storage/retrieval, strategy consumption, coverage,
  evaluation, current design docs, status, plan, phase doc, and relevant rollout notes.
- Three independent read-only expert reviews: SEC/source taxonomy, RAG/retrieval architecture, and backfill
  operations/economics; no expert lane changed files.
- `git diff --check` — passed after the initial documentation patch.
- First `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run lint` — environment failure,
  `eslint: command not found`, because the new isolated worktree had no installed dependencies.
- `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm ci` — passed; installed the locked dependency tree.
- `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run lint` — passed with 0 errors and 428 inherited warnings.
- `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx tsc --noEmit` — passed.
- `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm test` — passed, 350 files / 3,927 tests.
- `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run build` — passed; emitted the existing Next/Sentry Edge
  `process.features` warning and the Next middleware-deprecation warning.

## Follow-ups

1. Assign P0 corpus-truth/universe, occurrence/manifest, discovery/archive, and parser/chunker owners.
2. Run the authenticated production corpus/config/provider-quota census; the public health endpoint does not
   expose authoritative document/vector coverage.
3. Freeze the 1,000-CIK universe and 10/25-issuer canaries.
4. Build a 250-500-query real-EDGAR evaluation set before tuning or bulk writes.
5. Implement and verify the shadow worker/corpus, then request explicit approval for the 100-stock write.
6. Keep the existing production corpus readable and production trading/retrieval traffic reserved during all
   canaries.

## Risks

- Volume/cost estimates are planning ranges; parser and chunk distributions from the 25-issuer pilot supersede
  them.
- Pinecone import/WU and provider pricing must be rechecked in the account console before execution.
- Exact accepted-time recovery, third-party-subject filings, foreign filers, amendments, and malformed iXBRL
  require explicit hard cases; nominal coverage counts alone are insufficient.
- The live effort board contained an AG update to its adjacent ingestion row that was not yet present in this
  branch's tracked mirror; this change preserved that peer-owned row and did not claim or overwrite its lane.
