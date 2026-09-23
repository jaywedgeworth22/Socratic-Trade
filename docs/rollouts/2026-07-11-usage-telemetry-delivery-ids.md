# Usage telemetry delivery IDs

## Summary

Socratic-Trade now supplies fixed-length explicit idempotency keys for every usage-monitor delivery.
LLM and RAG events hash their durable local ledger-row IDs and carry the exact timestamp persisted
with that row, broker balance metrics share one snapshot identity with metric suffixes, and each
aggregated provider-call lane gets a unique window identity. Failed or ambiguous POSTs retain the
exact original events for bounded exponential-backoff retry, and HMR cancels old module timers before
reusing buffered state.

## Why

The cross-app fallback key intentionally remains based on source app, provider, metric type,
key reference, and occurrence time. Aggregated credential lanes in one flush share that time and
previously omitted `keyRef`, so distinct lane payloads could collide and one was silently dropped.
Explicit source identity fixes the producer without rekeying the shared compatibility contract.
Hashing the source identity also prevents an unexpectedly large upstream ID from exceeding the
monitor's idempotency-key limit. Empty IDs receive independent UUID-backed identities.

## Files

- `src/lib/usage-monitor-push.ts`
- `src/lib/llm-usage.ts`
- `src/lib/rag-metering.ts`
- `test/usage-monitor-push.test.ts`
- `docs/usage-monitor-integration.md`
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`
- `/Users/jay/apps/TRADING-EFFORT-LOG.md` (live board)

## Verification

- `PATH=/Users/jay/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH npm test -- test/usage-monitor-push.test.ts` — 11/11 pass under Node 24.
- Same runtime with `npm test -- test/usage-monitor-push.test.ts test/rag-metering.test.ts` — 18/18
  pass across the producer and RAG ledger suites.
- `npx tsc --noEmit` — pass under Node 24.
- Scoped ESLint over the three source files and focused test — pass.
- Initial test attempt under host Node 26 failed because the existing `better-sqlite3` binary was
  built for Node module ABI 137 (Node 24), while Node 26 requires ABI 147. Re-running with the repo's
  pinned Node 24 runtime passed; no dependency rebuild or source workaround was applied.
- Full lint/test/build gate — pending before PR handoff.

## Follow-ups

- Land the paired API Usage Monitor hardening first or alongside this producer fix; its ingest
  route now returns 409 for conflicting payloads instead of silently accepting one.
- No merge to Socratic-Trade `main` without an explicit landing decision because merge
  auto-deploys production.
- The former process-crash gap for LLM/RAG ledger rows is resolved locally by the bounded durable
  replay worker documented in `docs/rollouts/2026-07-13-usage-monitor-durable-replay.md`. Landing is
  intentionally blocked until the paired API Usage Monitor receiver backfill is deployed.
