# GROK takeover of MM #3381 test CI

## Context & Objective

Board `6aa1e66e`.  PR #3381 hosted tsc failed: `setDbForTesting` does not exist, and `TradingPolicy` has no `agenticAllowed` / `enabled` / `strategy` fields.  AG also dropped `maxWorkers: 1`, which this suite cannot do (shared SQLite).

## Changes Made

- Route tests use `resetDbForTesting` and `DEFAULT_POLICY` plus `systemState`.
- Approve mock returns `{ status: "placed" }` (`ExecuteProposalResult`).
- Restore `maxWorkers: 1`.  Keep the outbound-fetch mock and test-broker REJECT/PARTIAL.

## Decisions & Trade-offs

- Parallel vitest workers are not unique value; they race the file DB.  Fetch mock is the unique value.
- Extra-ship no.  No Coolify Deploy.

## Verification State

- Hosted `verify` is the tsc/test gate.  Local npm registry ETIMEDOUT.

## Next Steps & Blockers

- Push `origin/mm/ag-takeover-df5759df` and re-arm squash auto-merge.
- Close duplicate AG PR #3374 after #3381 merges.
