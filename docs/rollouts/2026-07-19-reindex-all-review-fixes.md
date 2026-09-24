# 2026-07-19 — PR #1775 review fixes: scoped-run progress isolation + CLI fail-fast guards

Branch `agent/ag-reindex-bge-m3` (PR #1775, AG's lane; fixes applied by CLAUDE under an
owner-directed instruction to resolve the findings before merging rather than deferring them).

## Summary

Resolved all six unresolved `chatgpt-codex-connector` review threads on PR #1775 — one P1 and
five P2s, every one of them a real operator-safety or data-loss issue on a destructive,
budget-spending script. The P1 turned out to be **broader than reported** and was fixed at the
library level rather than in the CLI.

> **Ownership correction (same session, before merge).** The P1 library fix described immediately
> below was implemented here first, then **removed from this PR** on discovering that PR #1777
> (`claude/corpus-reembed-hardening`) already implements the same fix as part of a broader hardening
> pass — independently arriving at the identical mechanism (`const scoped = …; if (opts.dryRun ||
> scoped) return;`) and the identical test-fixture change, plus things this PR did not address
> (`watermarkEmbedRevision` to discard watermarks from a different embedding space, cumulative
> resumed-run counts, and a dedicated `test/corpus-reembed-adversarial.test.ts`). Keeping both
> produced a textual conflict in `src/lib/rag/corpus-reembed.ts` for no benefit.
>
> **This PR therefore carries only the CLI guards.** `src/lib/rag/corpus-reembed.ts` and
> `test/corpus-reembed.test.ts` were reverted to match `main` exactly, so the two PRs no longer
> conflict and may land in either order. The analysis below is retained because it independently
> corroborates #1777's fix and documents the second failure mode (shared-watermark skip) for the
> record. **#1777 is the PR to land for the library fix.**

### P1 — a symbol-scoped run must not write corpus-wide progress

**Reported:** `--ticker AAPL --yes` marks the docType complete for the current embedding
revision; `purgeLegacyEmbeddingSpace` gates on exactly that flag, and `legacyVectorIdsFor`
selects legacy vectors by source tag with **no symbol scoping** — so a later `--purge-legacy`
deletes old vectors for symbols that were never re-embedded.

**Confirmed, and two things the report missed:**

1. **The API route is affected too.** `app/api/admin/reembed/route.ts:94` also passes `symbols`
   into `startCorpusReembedRun`. The suggested CLI-level guard ("reject ticker-scoped real runs
   here") would have left that path exposed. The fix therefore belongs in
   `src/lib/rag/corpus-reembed.ts`, which closes it for every caller.
2. **A second, independent data-loss bug on the same root cause.** `watermark` is a *single
   shared per-docType cursor*, not keyed by symbol. A scoped run advances it past the filtered
   set's highest row, so a later **full** run starts from that cursor and silently **skips every
   unprocessed document below it for all other symbols** — leaving them un-re-embedded, and then
   the purge gate deletes their legacy vectors. The two bugs compound.

**Fix:** a symbol-scoped run now persists **nothing** — no watermark advance, no status, no
completion flag — exactly matching the existing dry-run contract that the file already documents
and enforces. Its counts still come back in the run result. Corpus-wide progress may only be
advanced by a run that actually scanned the whole corpus.

**Known consequence (deliberate):** a scoped run started through the admin API's detached POST
is no longer observable via the GET progress poll, because it persists nothing. This is the same
tradeoff dry runs already make. Correctness on a delete-authorizing flag beats progress
visibility on a rare targeted operation; if scoped-run observability is wanted later, it should
be a separate progress key that the purge gate provably ignores — filed as a follow-up rather
than bolted on here.

### P2s — CLI fail-fast guards (`scripts/reindex-all.ts`)

This script accepts `--yes` to bypass its own prompts and drives destructive, budget-spending
operations, so every malformed flag now aborts instead of silently falling back to a **broader**
default. A typo must never widen the blast radius.

| Finding | Old behavior | Now |
|---|---|---|
| Invalid `--doc-types` | unknown value → `docTypes` stays `undefined` → selects **all** corpus types | aborts, lists known types |
| Invalid/missing `--max-texts` | `undefined` → treated as **no spend cap at all** | aborts (it is the operator's spend limiter) |
| Retired flags (`--clear-only`, `--ingest`, `--limit`) | silently ignored → falls through to a real re-embed | aborts, prints the supported flag set |
| Refused purge | printed a success badge, exited **0** | exits **1** with the refusal reason |
| Purge token | script supplied `purge-voyage-vectors` on the operator's behalf after a generic y/n | requires explicit `--purge-token <token>`; `--yes` does not waive it |
| `--ticker` + `--purge-legacy` | ticker silently ignored; purge is corpus-wide | refuses the combination outright |

Also removed two imports the rewrite left unused (`getDb`, `getVectorStoreStats`).

## Files

- `src/lib/rag/corpus-reembed.ts` — scoped runs skip both progress-write sites (`persistRunning`
  and the post-loop final status write); `isSymbolScoped` derived once from the normalized symbol
  list.
- `scripts/reindex-all.ts` — fail-fast arg validation (`fail()` helper), retired-flag rejection,
  `--purge-token` required for purges, refusal propagated as a non-zero exit, `--ticker` +
  `--purge-legacy` refused, unused imports dropped.
- `test/corpus-reembed.test.ts` — two new regression tests:
  - *"a symbol-scoped run persists no corpus-wide progress"* — the run still reports
    `embedded: 1 / completed: true` to its caller, but `getCorpusReembedProgress().persisted`
    stays `undefined`.
  - *"a completed symbol-scoped run does NOT authorize a legacy purge"* — reproduces the exact
    P1 chain and asserts the purge still refuses with `/has not completed/`.
  - The pre-existing budget/watermark-resume test previously used `symbols: ["BUDG"]` purely as a
    test-isolation device while asserting corpus-wide watermark persistence — behavior this fix
    deliberately removes. It now clears prior `sec-edgar` rows so the BUDG chunks *are* the whole
    corpus and runs unscoped, which exercises the real corpus-wide path it was always meant to
    cover.

## Verification

Run in `/Users/jay/Code/Socratic-Trade/.claude/worktrees/land-ag-reindex-bge-m3` with the node@24
PATH override (system node is v26 and ABI-breaks `better-sqlite3`):

- `npx vitest run test/corpus-reembed.test.ts` — **9 passed** (7 pre-existing + 2 new).
- `npx vitest run test/reindex-all.test.ts` — 2 passed.
- `npx eslint scripts/reindex-all.ts src/lib/rag/corpus-reembed.ts test/corpus-reembed.test.ts` —
  **0 errors** (remaining warnings are the grandfathered `no-unused-vars` class).
- `npx tsc --noEmit`, CLI guard smoke tests, and the full suite — see the PR thread replies for
  the results recorded at push time.

## Follow-ups

- Optional scoped-run observability: persist scoped progress under a separate key that
  `purgeLegacyEmbeddingSpace` provably never reads.
- `test/reindex-all.test.ts` is now partly vestigial — it re-implements the *old* script's
  cache-clearing SQL inline rather than exercising the CLI, and that `--clear-only` path no
  longer exists. Worth replacing with real CLI coverage (subprocess-invoked) or retiring.
