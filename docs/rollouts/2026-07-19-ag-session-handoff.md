# 2026-07-19 — AG Session Handoff to Claude

## Summary

This note captures the exact state of all open work items at the end of this Antigravity (AG) session so that the Claude lane can pick up immediately with no re-discovery.

---

## ✅ Completed This Session

### PR #1778 — EarningsCalls Sentry suppression + SQLite busy_timeout
- **Branch:** `agent/earningscalls-sentry-and-sqlite-fixes`
- **Status:** Pushed, verified (418 test files / 4,881 tests all green, tsc clean, full `npm run build` clean), PR open at https://github.com/jaywedgeworth22/Socratic-Trade/pull/1778, `--auto` merge armed.
- **CI:** Checks (classify, gitleaks) were still running at handoff. Auto-merge will fire once they pass.
- **What it fixes:**
  1. 30-second SQLite `busy_timeout` to survive Coolify build-time disk thrash.
  2. Suppresses Sentry 401/403 health alerts for the dormant EarningsCalls integration.
  3. Fixes `priceForModel()` prefix strip for 3-part `openrouter/vendor/model` IDs (was falling back to $15/M default).
  4. Test isolation fixes (`resetTriggersForTesting`, DB table truncation) preventing vitest deadlocks.
- **Rollout note:** `docs/rollouts/2026-07-18-earningscalls-sentry-and-sqlite-fixes.md`
- **After it merges:** No manual Coolify step needed — auto-deploy is ON. Verify via `https://socratictrade.com/api/health`.

---

## 🔴 Not Started — Needs Claude to Pick Up

### 1. RAG Ingestion Limit Increases (High Priority)

**Context:** This was the original motivation for this AG session. The SEC filings embedding pipeline is rate-limited, and the owner wants the ingest batch limits increased so more filings are embedded per scheduler tick.

**Research completed (by this session's research subagent):** See the findings below in the "SEC Pipeline Research" section. The key finding is that `VECTOR_EMBED_BATCH_DELAY_MS ≤ 5000` (paid-key signal) controls the body-ingest gate, and the per-tick limit is configurable.

**What Claude needs to do:**
1. Look at `src/lib/web-sources/sec-filings.ts` — specifically the `VECTOR_EMBED_BATCH_DELAY_MS` check and `MAX_INGEST_PER_RUN` (or equivalent) constant.
2. Look at what the owner wants: likely either (a) increase how many filings are processed per cron tick, or (b) decrease the delay between embeddings. Confirm with owner.
3. Implement the increase, write a test if needed, land via `scripts/land.sh`.

**Escape hatch known:** To force re-indexing of already-ingested filings, delete rows from `ingested_accessions`:
```sql
DELETE FROM ingested_accessions WHERE doc_type IN ('10-K', '10-Q');
```
This causes `refreshFilingBodies` to re-discover and re-embed them on the next tick.

---

### 2. Codex PR #1735 — Unresolved P2 (`agent/ag-recovery-v48-migration`)

From the agent-sync poll:
> `[CODEX->FLEET] sync-1 ¶ repo: Socratic-Trade ¶ claim: codex/pr1735-proposal-attribution ... ¶ state: WIP ¶ reason: PR #1735 unresolved P2; local-only commit, no push`

**What Claude needs to do:**
1. Check PR #1735 on GitHub for the specific P2 thread that is unresolved.
2. Coordinate with Codex or resolve the thread directly.
3. This is blocking the SEC RAG table recovery migration from landing.

---

### 3. Firecrawl Historical Credits Ingestion (Codex claimed)

From agent-sync:
> `[CODEX->FLEET] sync-firecrawl-history claim: codex/firecrawl-historical-credits; isolated worktree from latest origin/main; files src/lib/adapters/firecrawl.ts, tests, catalog/docs, effort mirror. Official GET /v2/team/credit-usage/historical?byApiKey=false; non-money metadata only, discard key IDs, strict bounded completeness, optional failure non-pruning. No merge/deploy.`

**Status:** Codex owns this. Claude should monitor #agent-sync but NOT start duplicate work.

---

### 4. `better-sqlite3` Node ABI Mismatch (Worktree Hygiene)

**Root cause:** The antigravity worktree (`/Users/jay/apps/trading-antigravity`) had `better-sqlite3` compiled against Node ABI 147 (Node 22) instead of ABI 137 (Node 24). This caused all SQLite-touching tests to fail.

**How it was fixed:** `rm -rf node_modules/better-sqlite3 && npm install better-sqlite3` with `PATH` pointing to `/opt/homebrew/opt/node@24/bin`.

**If this recurs:** Run:
```bash
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
npm rebuild better-sqlite3
```

---

## SEC Pipeline Research Findings (for RAG Limit work)

Full findings saved to: `/Users/jay/.gemini/antigravity/brain/0c0d3144-b582-44c4-adc2-ba36efa66647/sec_pipeline_research.md`

**Key facts:**
- **`ingested_accessions`** table is the sole de-dup gate for SEC embeddings (PK: `accession` + `doc_type`).
- **`storeDocument()`** in `src/lib/vector-db.ts` handles Pinecone upserts with the embedding model.
- **Model routing:** Determined by env vars; Voyage vs. BGE-M3 (SiliconFlow/OpenRouter). Different models use different revision tags and are isolated via Pinecone metadata filters (not namespaces).
- **Rate limiting:** Token bucket + daily cost limits enforced via SQLite `settings` rows in `rag-metering.ts` / `run-budget.ts`.
- **Chunk size:** ~480 tokens max per chunk, 12% overlap for prose. Tables kept atomic.
- **No bulk reindex script exists.** The only escape hatch is deleting `ingested_accessions` rows.

---

## Worktree State at Handoff

- **Branch:** `agent/earningscalls-sentry-and-sqlite-fixes`
- **Ahead of main:** Merge commit + 6 fixup commits (all pushed, PR open).
- **Working tree:** Clean (only `package-lock.json` modification from reinstalling `better-sqlite3`, which was restored to index state before `land.sh`).
- **Node version:** Node 24.18.0 (ABI 137). Use `export PATH="/opt/homebrew/opt/node@24/bin:$PATH"` before any npm/test commands.

---

## Effort Log Update Needed

After PR #1778 merges and Coolify deploys, update:
1. `/Users/jay/apps/TRADING-EFFORT-LOG.md` — move the EarningsCalls/SQLite row to **Deployed**.
2. `docs/EFFORT-LOG.md` — same row update.
3. Add a new **Planned** row for "RAG Ingestion Limit Increases" before starting that work.

---

## Agent-Sync Coordination Notes

- Post a `[AG->FLEET]` message in #agent-sync acknowledging this handoff and stating the work is now transitioning to the Claude lane.
- Before starting new work, run: `AGENT_TAG=CLAUDE /usr/bin/python3 /Users/jay/apps/agent-sync-poll.py`
- Slack channel ID: `C0BEZDJDNKV`
