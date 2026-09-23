# 2026-07-18 — SEC ingest backfill: manifest schema fix + seeder + worker wiring

Branch: `claude/sec-ingest-worker-wiring` (worktree
`/Users/jay/Code/Socratic-Trade/.claude/worktrees/agent-af7fb4212d148a06c`). Not yet pushed.

## Summary

Wires the dormant SEC ingest backfill architecture end-to-end. Before this change the durable
checkpoint state machine (`src/lib/rag/sec-ingest-worker.ts` over `sec_ingest_jobs`/`sec_ingest_tasks`,
migration v23) was fully built but nothing instantiated the worker and nothing seeded jobs
(`docs/rollouts/2026-07-17-pr1669-parser-thread-pickup.md` flagged exactly this: "No production
enqueuer sets payload.acceptanceDateTime yet (the worker is not instantiated in production)").
Separately, `scripts/eval/generate-universe-manifest.ts` wrote a BARE ARRAY while
`validateSecUniverseManifest` requires a versioned `FrozenSecUniverseManifest` object — the committed
`data/rag-universe-manifest.json` (1,000 issuers) failed its own validator (Codex audit items 2/3/4).

Three deliverables:

1. **Manifest generator + committed artifact fixed.** The generator now emits the exact
   `FrozenSecUniverseManifest` shape and self-validates before writing; the committed manifest was
   regenerated in place via a deterministic, network-free conversion; a new vitest validates the
   committed file in CI on every run.
2. **Manifest→jobs seeder** (`src/lib/rag/sec-ingest-seeder.ts`): idempotent, dead-letter-disciplined
   seeding of one job per issuer (baseline scope: latest 10-K + latest 4 10-Qs, primary document only).
3. **Worker startup wiring + admin route**: `SecIngestWorker` starts from
   `background-worker-startup.ts` gated on `SEC_INGEST_WORKER_ENABLED` (default OFF), with clean
   shutdown; `POST/GET /api/admin/sec-ingest` runs the seeder and reports receipts.

## Why / decisions

- **Committed-manifest conversion is a local transform, not a re-fetch.** The 1,000 issuers frozen in
  #1495 are preserved byte-for-byte in identity (cik/ticker/title/order); only the envelope and
  per-issuer schema fields were added. Fields the legacy array never captured are represented
  HONESTLY rather than fabricated:
  - `exchange: "UNKNOWN"` (explicit sentinel; the schema requires a non-empty string and there is no
    offline exchange source in the repo — verified: `data-providers.ts` sector/industry/exchange are
    live-fetch or mock-only).
  - `sector`/`industry`: `null` (schema-legal).
  - `marketCapUsd`/`dollarVolumeUsd`: the explicit placeholder `1` (schema requires positive numbers;
    a uniform `1` cannot be mistaken for a real measurement, unlike a plausible-looking fake). The
    `selectionMethod` string documents all of this in the artifact itself, and the single source
    receipt (`legacy-frozen-array-v1`) carries the sha256 of the exact legacy file bytes converted
    plus the original freeze commit datetime (`7400166e`, 2026-07-12T20:33:39-05:00).
  - `inclusionReason` mapping: legacy `top-prominence` → `market-cap-liquidity` (the legacy value is
    not in the schema's enum; the legacy generator used it for both the masked DB-history tranche and
    the SEC-prominence fill — that distinction was not preserved in the committed file, so both map to
    the one honest common category). `index-member` → `index-member` unchanged.
- **The regenerating generator sources every new field honestly**: `exchange` from SEC's own
  `company_tickers_exchange.json` (new second source receipt), `marketCapUsd`/`dollarVolumeUsd`
  (price×volume) from live Yahoo quotes (the app's established no-key floor provider),
  `sector`/`industry` stay `null` (no honest source wired; NOT hash-faked like the old
  `MOCK_METRICS` path), and issuers with no usable quote are **quarantined with a reason** instead of
  being assigned a number. `securityType` defaults to `operating-company` (FPI detection would need
  1,000 per-CIK submissions probes; a mis-tag only means discovery finds no 10-K/10-Qs).
- **Task granularity follows the worker's actual contract** (read from
  `src/lib/rag/sec-ingest-worker.ts` + `test/sec-ingest-worker.test.ts`): tasks enter at checkpoint
  `discovered` with accession/cik/symbol/sequence/documentName columns and a payload carrying
  `url` (fetched at the `discovered` stage, worker line ~108), `docType` (parser form hint + doc
  metadata, ~161/213), `filedAt` (`published_at`, ~215), and `acceptanceDateTime` (point-in-time
  as-of stamp, ~219/274 — the field the 07-17 rollout note demanded enqueuers set). One task per
  document, `sequence: 1`, `documentName` = EDGAR `primaryDoc` (feeds the worker's
  `vectorDocId = accession:sequence:documentName` collision-safety scheme). Discovery uses the
  existing `fetchRecentFilings(cik, docTypes, limitPerType)` EDGAR submissions helper
  (`sec-filings.ts:250`), which returns exactly these fields.
- **Seeder idempotency via the DB's own natural keys**: job key =
  `buildSecIngestJobKey({corpusRevision, universeSnapshotId, scope:{cik, baseline}})` (UNIQUE
  `idempotency_key`, replay-conflict-checked by `createSecIngestJob`); task key =
  `buildSecIngestTaskKey({accession, sequence, documentName})` (UNIQUE `(job_id, task_key)`,
  `ON CONFLICT DO NOTHING` + immutable-match check). `SEC_INGEST_BASELINE_CORPUS_REVISION =
  "sec-ingest-baseline-10k-4x10q-v1"` names the scope; changing scope means bumping the revision →
  new jobs, never mutating sealed ones.
- **Dead-letter discipline (hard requirement — a sister app burned $1,153 on a non-terminating
  backfill loop):**
  - After enqueue the seeder **seals intake** (`sealSecIngestJobIntake`) — the DB layer then refuses
    any further task insertion for that job, permanently.
  - A re-seed **skips sealed/terminal jobs entirely** (no EDGAR calls, no enqueue attempts): tested.
  - Dead-lettered tasks are terminal at the DB layer (not claimable, not retried) and the seeder
    never transitions them: tested (`never re-seeds or revives a dead-lettered document`).
  - **Completion criteria is "all tasks terminal (complete OR dead_letter)"** — this is literally
    `reconcileSecIngestJob`'s rule (active = pending+leased+retry_wait must be 0; dead letters close
    the job as `complete_with_errors`). The worker now calls `reconcileSecIngestJob` after each
    job's tick and the admin GET reconciles on read, so finished jobs actually reach a terminal
    status instead of sitting `running` forever. The GET response's `allTerminal` field is the
    operator's "backfill done" signal — it counts dead-lettered jobs as done, never as work.
  - One deliberate non-seal: if EDGAR discovery returns **zero** filings for an issuer, intake stays
    OPEN (not sealed) because `fetchRecentFilings` collapses "no filings exist" and "transient
    network failure" into the same empty array — sealing would permanently close discovery on a
    transient miss. These issuers are surfaced in the result (`issuersWithNoFilings`) for operator
    review; a later seed retries ONLY discovery for them (no dead-letter re-drive involved — there
    are no tasks yet).
- **Startup wiring follows the repo's established two-layer convention**: `background-worker-startup`
  gates the whole family on production/`DEV_BACKGROUND_WORKERS` and calls each starter
  unconditionally; the individual worker self-gates on its own env flag inside `start()` (mirrors
  `startCongressStream`/`CONGRESS_STREAM_ENABLED`). `SEC_INGEST_WORKER_ENABLED` accepts
  `1/true/on/yes` (default OFF). Singleton + shutdown hooks are `globalThis`-pinned (mirrors
  `durable-state.ts`) so HMR/test module re-evaluation can't double-start intervals or leak signal
  handlers; SIGTERM/SIGINT stop the poll interval.
- **Admin route mirrors `reindex-10k`**: `requireAdmin(request, { requireTokenInProd: true })`,
  `withAdminOperationGuard` with a new `sec-ingest-seed` operation (durable lease group
  `sec-ingest-seed` added to `OPERATION_LEASE_GROUPS`; 6/hour rate budget, manual-admin scope) so a
  duplicate click can't run two EDGAR discovery sweeps concurrently; the lease claim is passed into
  the seeder and ownership is asserted between issuers.

## Files

- `scripts/eval/generate-universe-manifest.ts` — rewritten to emit + self-validate the versioned schema.
- `scripts/eval/convert-universe-manifest-v1-to-v2.ts` — NEW one-time, network-free legacy-array →
  v2 conversion (the script that produced the regenerated committed artifact).
- `data/rag-universe-manifest.json` — regenerated in place (1,000 issuers preserved; now schema v2,
  passes `validateSecUniverseManifest` with zero issues).
- `test/rag-universe-manifest-committed.test.ts` — NEW: CI-validates the committed artifact.
- `src/lib/rag/sec-ingest-seeder.ts` — NEW seeder module.
- `src/lib/rag/sec-ingest-worker.ts` — + `reconcileSecIngestJob` per tick; + self-gated
  `startSecIngestWorker`/`stopSecIngestWorker`/`secIngestWorkerEnabled` singleton wiring.
- `src/lib/background-worker-startup.ts` — 4th starter (`startSecIngestWorker`), interface + loader +
  call.
- `src/lib/operation-lease.ts` — + `SEC_INGEST_SEED` lease group.
- `src/lib/admin-operation-guard.ts` — + `sec-ingest-seed` operation limit + fixed durable group.
- `app/api/admin/sec-ingest/route.ts` — NEW admin route (GET receipts / POST seed).
- `test/sec-ingest-seeder.test.ts` — NEW: idempotency, worker-contract, dead-letter, scoping,
  open-intake-on-empty-discovery, invalid-manifest refusal, flag-gate tests (7 tests).
- `test/background-worker-startup.test.ts` — 4th starter spy + assertions.
- `.env.example` — `SEC_INGEST_WORKER_ENABLED=off` documented in the RAG section.

## Verification

Run on this branch (Node 24 via `/opt/homebrew/opt/node@24/bin`):

```bash
npx tsx scripts/eval/convert-universe-manifest-v1-to-v2.ts   # wrote the regenerated manifest
npx tsx scripts/eval/validate-rag-universe.ts                # PASS (zero issues)
npx vitest run test/sec-ingest-seeder.test.ts                # 7 passed
npx vitest run test/sec-ingest-worker.test.ts test/rag-ingest-worker.test.ts \
  test/rag-universe-manifest.test.ts test/rag-universe-manifest-committed.test.ts \
  test/background-worker-startup.test.ts                     # 5 files, 45 passed
npx tsc --noEmit                                             # clean (see note)
```

Notes: full `tsc --noEmit` on this worktree takes several minutes (no incremental cache, `.next/types`
absent — the known-stale caveat in AGENTS.md did not trigger). One real error it caught mid-work
(`FetchedSource` shape misuse in the new generator code) was fixed before commit. No full
`npm run build` per task instructions (CI `verify` runs it).

## Operator quickstart (production)

1. Set `SEC_INGEST_WORKER_ENABLED=on` (Infisical) and deploy/restart — the worker starts polling but
   does nothing until jobs exist.
2. Seed a slice: `POST /api/admin/sec-ingest` body `{"action":"seed","offset":0,"limit":25}`
   (x-admin-token required in prod). Re-POST the same window any time — idempotent.
3. Watch: `GET /api/admin/sec-ingest` → per-job checkpoint/status counts, `totalDeadLetterTasks`,
   `allTerminal`.
4. Budget interplay: embeds still flow through `storeDocument`, so
   `RAG_INGEST_MAX_TEXTS_PER_DAY`/`RAG_PINECONE_MAX_WRITE_UNITS_PER_DAY` bound daily spend; a
   budget-exhausted task fails retryable and backs off (bounded by `max_stage_attempts=6` per stage,
   then dead-letters).

## Follow-ups / risks

- The committed manifest carries sentinel `exchange:"UNKNOWN"` and placeholder market-cap/volume
  values (documented in-artifact). Run the updated `generate-universe-manifest.ts` (network) when a
  real refresh is wanted; the seeder does not read those fields, so the backfill is unaffected.
- The seeder's EDGAR discovery (2 submissions calls per issuer) runs inside one admin request; for
  the full 1,000-issuer universe prefer windowed seeding (`limit` ≤ ~50 per call) to stay inside the
  request timeout. Calls are serialized through the existing SEC limiter (`politeFetch`).
- `securityType` in the regenerated manifest defaults to `operating-company` (no FPI probe); FPI
  issuers will simply discover zero 10-K/10-Qs and stay in `issuersWithNoFilings` for operator review.
- The worker claims 5 tasks per job per 5s tick across ALL running jobs; with hundreds of running
  jobs, EDGAR fetches remain serialized by the shared limiter, but embed spend ramps with the
  number of seeded jobs — seed in windows.
- `rag-ingest-worker.test.ts` (the OTHER ingest worker) is unrelated to this change but was run green
  as a guard because it shares `db-rag-ingest` primitives.
