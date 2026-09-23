# 2026-07-07 — as-of epoch Pinecone backfill executed (ops run, MONET)

Agent: MONET (cloud session worktree
`~/.claude/projects/Socratic-Trade/backfill-asof-epoch-09e06b`, branch
`monet/backfill-asof-epoch-09e06b` off `origin/main@8a53840b`).

## Summary

Executed the deferred **operational** follow-up from PR #1019 (server-side point-in-time
as-of filtering, `docs/rollouts/2026-07-06-server-asof-filter.md`): ran
`scripts/backfill-asof-epoch.ts` against the shared Pinecone index for the operator
("local") key, stamping the numeric `as_of_epoch_ms` metadata field onto every existing
vector that has a resolvable date. **No code changed** — this note records the ops run and
its results; the only repo diff is docs (this note, `STATUS.md`, `docs/EFFORT-LOG.md`).

## Results (three passes, in order)

| Pass | scanned | updated | skippedHasEpoch | skippedUndated | errors |
|---|---|---|---|---|---|
| Dry run (`BACKFILL_DRY_RUN=1`) | 341 | 309 (would-be) | 32 | 0 | 0 |
| Real run | 341 | **309** | 32 | 0 | **0** |
| Idempotency re-run (dry) | 341 | **0** | **341** | 0 | 0 |

- The 32 pre-existing epochs are vectors ingested after #1019 merged (ingest-time
  `cleanMetadata` now writes the epoch on upsert).
- `skippedUndated=0`: every vector in the corpus had a resolvable date via the
  `acceptance_datetime -> published_at -> as_of -> timestamp` chain — there are currently
  NO undated vectors relying on the fail-open `$exists:false` branch.
- Final state: **341/341 vectors carry a finite `as_of_epoch_ms`**, confirmed by the
  re-run reporting `updated=0, skippedHasEpoch=341`.

## Why

#1019's server-side filter ships default-OFF (`VECTOR_ASOF_SERVER_FILTER`), with the
rollout note prescribing: run this backfill (dry-run first) before flipping the flag, so
the topK-fill improvement actually applies to the pre-existing corpus. That gate is now
cleared. With `skippedUndated=0`, even the FAIL-CLOSED escalation (`VECTOR_ASOF_STRICT=on`)
would currently drop nothing for lack of an epoch.

## Execution details / decisions

- Ran from the existing deps-installed session worktree
  `~/Code/Socratic-Trade/.claude/worktrees/monet-xenodochial-dirac-26f036` (branch
  `claude/deferred-rag-closeout`, tree clean; the script + `backfillAsOfEpoch` there are
  byte-identical to `main`'s) because this session's worktree had no `node_modules` yet.
  The operator `PINECONE_API_KEY`/`VOYAGE_API_KEY` were exported from
  `~/apps/trading-claude/.env.local` (values never echoed). No `PINECONE_INDEX_NAME`
  override exists anywhere, so this hit the single default index — the same one prod uses.
- **Gotcha worth knowing:** `getClients()` in `src/lib/vector-db.ts` requires BOTH the
  Pinecone AND Voyage keys and returns `pc: null` if either is missing — the first attempt
  failed with "Pinecone key not configured" despite a valid `PINECONE_API_KEY` because
  `VOYAGE_API_KEY` wasn't exported. The backfill never embeds anything; the coupling is
  just how the client factory is written.
- One transient `PineconeConnectionError` (ECONNREFUSED, all three edge IPs) killed the
  first idempotency re-run attempt between the real run and verification; a retry ~20s
  later ran clean. Non-fatal, no data impact (the failed pass was a dry run).
- The `vector_asof_epoch_backfill` audit record was written (best-effort) to the
  xenodochial worktree's local `data/app.db`, NOT prod's — the authoritative record of the
  run is this note + the counts above.

## What this unlocks (NOT done here)

`VECTOR_ASOF_SERVER_FILTER=on` (and optionally `VECTOR_ASOF_STRICT=on` for
leakage-certified backtests) is now safe AND effective for the whole corpus. Flipping it
in production (Infisical env + `pm2 restart trading`) is the owner-run step and remains
default OFF everywhere. New ingests self-stamp the epoch, so no re-run is needed unless a
bulk import bypasses `cleanMetadata`; the script stays safe to re-run anytime (idempotent).

## Files

- `docs/rollouts/2026-07-07-asof-epoch-backfill-run.md` (this note, new)
- `STATUS.md` (new top entry)
- `docs/EFFORT-LOG.md` (effort row; live board `/Users/jay/apps/TRADING-EFFORT-LOG.md`
  updated in place)

## Verification (exact commands)

From the xenodochial worktree, with the two keys exported:

```bash
BACKFILL_DRY_RUN=1 npx tsx scripts/backfill-asof-epoch.ts   # 341 scanned / 309 would-update / 0 errors
npx tsx scripts/backfill-asof-epoch.ts                      # 309 updated / 0 errors
BACKFILL_DRY_RUN=1 npx tsx scripts/backfill-asof-epoch.ts   # 341 skippedHasEpoch / 0 updated (idempotent)
```

Docs-only PR gate: `npm run lint` / `npx tsc --noEmit` / `npm test` / `npm run build` run
via `scripts/land.sh` (results in the PR).

## Follow-ups

- Owner decision: flip `VECTOR_ASOF_SERVER_FILTER=on` in prod (and choose whether any
  backtest lane wants `VECTOR_ASOF_STRICT=on`). The corpus-side prerequisite is done.
- None otherwise; no code follow-ups.
