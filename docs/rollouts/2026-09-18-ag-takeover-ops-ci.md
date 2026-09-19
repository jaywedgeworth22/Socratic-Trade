# GROK takeover of MM #3382 ops CI

## Context & Objective

Board `6aa1e66e`.  PR #3382 hosted tsc failed: `alertLivenessWarning` passed `type: "liveness_warning"` into `deliverSystemAlertToAdmins`, whose union was only `"provider_degraded" | "storage_warning"`.

## Changes Made

- `src/lib/db-health.ts` — add `"liveness_warning"` to the alert type union.

## Decisions & Trade-offs

- Extra-ship no.  No Coolify Deploy.

## Verification State

- Hosted `verify` is the tsc gate.  Local npm registry ETIMEDOUT.

## Next Steps & Blockers

- Push `origin/mm/ag-takeover-e793466a` and re-arm squash auto-merge.
- Close duplicate AG PR #3373 after #3382 merges.
