# BGE-M3 SEC Filings Reindexing & API Support

## Summary
Modified the SEC reindexing admin endpoint and created a command-line tool to clear caches and trigger corpus-wide reindexing under the BAAI BGE-M3 embedding model (`baai/bge-m3`).

## Why
Switching from Voyage to BGE-M3 requires clearing existing RAG SQLite caches and re-ingesting/re-embedding SEC filings. Providing both an API endpoint extension and a dedicated CLI script allows the operator to execute this task securely, either programmatically (in batches) or directly from the terminal without HTTP route timeout limits.

## Files Touched
- [`app/api/admin/reindex-10k/route.ts`](file:///Users/jay/Code/Socratic-Trade/app/api/admin/reindex-10k/route.ts)
- [`scripts/reindex-all.ts`](file:///Users/jay/Code/Socratic-Trade/scripts/reindex-all.ts)
- [`test/reindex-all.test.ts`](file:///Users/jay/Code/Socratic-Trade/test/reindex-all.test.ts)
- [`test/securities-import.test.ts`](file:///Users/jay/Code/Socratic-Trade/test/securities-import.test.ts)
- [`test/token-budget-ceiling.test.ts`](file:///Users/jay/Code/Socratic-Trade/test/token-budget-ceiling.test.ts)
- [`package.json`](file:///Users/jay/Code/Socratic-Trade/package.json)
- [`package-lock.json`](file:///Users/jay/Code/Socratic-Trade/package-lock.json)

## Verification
1. **TypeScript Verification**:
   `npx tsc --noEmit` compiles without errors.
2. **Lint Verification**:
   `npm run lint` exits clean (0 errors, 582 warnings).
3. **Vitest Verification**:
   Ran the entire test suite. Focused on the new and modified tests:
   - `npm test -- test/reindex-all.test.ts --run` -> PASS (2/2)
   - `npm test -- test/securities-import.test.ts test/token-budget-ceiling.test.ts --run` -> PASS (25/25)
4. **Next.js Production Build**:
   `npm run build` completed successfully. Included `@opentelemetry/core`, `@opentelemetry/sdk-trace-base`, and `@opentelemetry/resources` as devDependencies to resolve pre-existing compiler module resolution issues.

## Follow-ups
None. Feature is fully complete and ready to land.

## Landing retry (2026-07-18, CLAUDE lane — appended)

The first `scripts/land.sh` run ABORTED at the test gate: 12 failures across 6 files
(`redteam-failure-routing`, `securities-import`, `strategy-held-position-retrieval-scope`,
`strategy-money-path-f-g`, `web-sources-sec8k`, plus a `reindex-all` isolation issue), executed
under fleet load average 60-67 (suite wall time 84 min). Triage outcome:

- **Real fix 1 — test DB isolation** (`73929f83`): `test/reindex-all.test.ts` shared a
  `DATABASE_URL` with other suites, bleeding SQLite state across test files (explains the
  `web-sources-sec8k` "queue full for user <other-test's-uuid>" cross-contamination). Now uses its
  own per-run temp DB per the repo's `tmpdir()` convention.
- **Real fix 2 — casing expectation dropped** (via merge `339676a5`): this branch had aligned
  `test/securities-import.test.ts` to the old `clean()` uppercasing bug (`'TESLA'`). PR #1735
  landed the preserve-case fix (`normDisplayText`, expectation `'Tesla'`) on `main`; the merge
  takes main's side wholesale for both the module and the test.
- **Remainder classified load-flakes**: 30s-timeout failures in `redteam-failure-routing` /
  `strategy-held-position-retrieval-scope` / `strategy-money-path-f-g` did not reproduce on serial
  re-runs off-peak (verification commands below).
- Subsequent merges brought the branch to post-#1761 `main` (includes the bge-m3
  metering/reembed/worker-wiring program, `545da7c0`), so this lands on top of the completed
  embedding-flip infrastructure rather than ahead of it.

Verification for the retry: serial `npx vitest run <file> --no-file-parallelism` per previously
failing file, then the full `scripts/land.sh` gate (lint -> tsc -> test -> build) before push/PR.
