# Branch Integration Ledger

Purpose: durable branch disposition record so future agents do not repeat the same inventory when reconciling Socratic-Trade work into `main`.

Last updated: 2026-07-15 by CODEX.

## Rules For Future Agents

- Do not bulk-merge branches by name. Compare each branch to current `origin/main`, inspect open PR state, and honor the effort log.
- Treat this ledger as a starting point, not authority over newer GitHub state. Refresh `git fetch --all --prune` and `gh pr list` before changing code.
- `Completed` means merged to `main`; for this repo that also means production auto-deploy begins.
- Transcript ingestion and backfill remain disabled unless entitlement, commercial rights, and source gates are confirmed.

## Current Dispositions

| Branch or PR | Disposition | Reason / next action |
| --- | --- | --- |
| `origin/main@58de276e` | Integrated baseline | Local integration checkout fast-forwarded to current main after PR #1607. Use this as the baseline for branch comparison. |
| PR #1586 / `codex/fmp-transcripts-safe` | Active landing candidate | Reconciled locally with `origin/main@58de276e`. RAG doc-type coverage now pins deterministic test encryption, includes vector provider/ledger authority mocks, and carries the required proposal regime field. Infisical bootstrap signal forwarding has its own fake app identity/login path. Round-23 rights review fixes require the durable active transcript-rights gate for retrieval, purge derived Socratic-memory dedup hashes, and scope pending-upsert blockers to transcript operations. Round-24 strategy fixtures distinguish Green vs Red OpenAI calls and carry current vector authority mocks. Focused blocker tests are green under Node 24. Local full/grouped gates are host-pressure limited (143/137), so push the branch and let hosted verify/protected merge decide. |
| `origin/codex/fmp-transcripts-safe` | Stale remote PR head | Remote is behind the local landing candidate. Do not review remote checks as current until the local branch is pushed by the land script. |
| `codex/provider-operation-leases` | Hold / overlap | Contains overlapping provider-dispatch work. Do not merge wholesale into PR #1586; review selectively only if a specific current-main gap remains after #1586. |
| `codex/platform-plan-refresh` | Already represented / no independent landing | No separate code landing found beyond current docs/plans. Keep as historical planning context. |
| `codex/ios-build-foundation` | Already represented / no independent landing | Native iOS remains tracked separately in the effort board; no bulk merge from this branch. |
| `codex/rag-1000-stock-backfill-plan` | Already landed as planning/foundation | Planning/foundation landed through PR #1494 and follow-ups. Bulk corpus backfill is not authorized. |
| `codex/autofix-1543-residual` | Selective review only | No open PR. Inspect individual diffs only if a named regression reappears. |
| `ag/sse-deadlock-fix` / PR #1245 | Closed / stale | Do not reopen or merge without a fresh current-main reproduction. |
| `agent/unify-manual-scheduler-single-flight` / PR #1440 | Closed / stale | Do not reopen or merge without a fresh current-main reproduction. |

## Verification Snapshot

- `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run test/rag-doc-type-coverage.test.ts --reporter=dot` - passed, 15/15.
- `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run test/infisical-bootstrap.test.ts --reporter=dot` - passed, 37/37.
- `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run test/rag-doc-type-coverage.test.ts test/infisical-bootstrap.test.ts --reporter=dot` - passed, 52/52.
- `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run test/vector-db-retrieval.test.ts test/fmp-rights-derived-artifacts.test.ts --reporter=dot` - passed, 31/31.
- `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run test/regime-severity.test.ts --reporter=dot` - passed, 20/20.
- `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run test/strategy-moneypath-drawdown-flip.test.ts --reporter=dot` - passed, 3/3.
- `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx tsc --noEmit` - passed.
- Local grouped/full gates are blocked by workstation pressure: grouped tests ended 143 without assertion summaries; production builds ended 137 under respawning parallel agent runners.
- Hosted verification remains required before merge.
