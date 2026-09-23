# Usage Monitor durable ledger replay

## Summary

Socratic-Trade now tags every newly emitted usage-monitor event with
`project: "socratic-trade"` while preserving the producer's raw provider string. A bounded worker
replays persisted `llm_usage` and `rag_usage` rows at Node startup and every minute, closing the
process-crash gap left by the existing in-memory delivery retry queue.

This producer PR must not merge or deploy until the paired API Usage Monitor receiver backfill is
deployed. Existing rows already accepted under the same deterministic idempotency keys need the
receiver-side backfill to gain canonical provider/project attribution; producer replay alone cannot
mutate a receiver row that dedupes as already accepted.

## Delivery invariants

- The persisted ledger row remains the source of truth for provider, usage, cost, timestamp, and
  delivery identity. Provider aliases are not rewritten in Socratic-Trade.
- Replay uses the same `socratic-trade:<kind>:<sha256(kind + row ID)>` key as immediate delivery and
  reuses the row's exact `created_at` value.
- Each ledger has an independent settings-table watermark ordered by `(created_at, id)`. Equal
  timestamps therefore advance without omission.
- A watermark advances only after an acknowledged batch. Each later pass includes the last
  acknowledged row once, making the remote-ACK/local-watermark crash window safe through receiver
  idempotency.
- Watermark writes use a `BEGIN IMMEDIATE` read/compare/write transaction and never regress when two
  app processes overlap.
- One pass sends at most ten 100-event pages per ledger. The startup pass is asynchronous and the
  one-minute interval is unref'd and single-flight within a process.
- The worker uses the existing `USAGE_MONITOR_BASE_URL` + `USAGE_INGEST_TOKEN` gate. It adds no env
  variables, database columns, tables, or migrations.

## Files

- `instrumentation.ts`
- `src/lib/usage-monitor-push.ts`
- `src/lib/usage-monitor-replay.ts`
- `test/usage-monitor-push.test.ts`
- `test/usage-monitor-replay.test.ts`
- `docs/usage-monitor-integration.md`
- `docs/rollouts/2026-07-11-usage-telemetry-delivery-ids.md`
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`
- `/Users/jay/apps/TRADING-EFFORT-LOG.md` (live board)

## Verification

All commands used the repository-pinned Node 24 runtime.

- Focused Vitest: `test/usage-monitor-push.test.ts` + `test/usage-monitor-replay.test.ts` — 16/16
  passed.
- Scoped ESLint over the startup hook, push/replay modules, and focused tests — passed.
- `tsc --noEmit` — passed.
- `git diff --check` — passed.
- Production `next build --webpack` — passed. It retained the pre-existing Sentry Edge-runtime and
  generated-CSS warnings; no replay/instrumentation import warning or error appeared.

## Release state

Checkpoint only. No merge or deploy is authorized. Land and verify the API Usage Monitor receiver
backfill first, then refresh this branch against `origin/main`, rerun the required gate, and make a
separate Socratic-Trade landing decision.
