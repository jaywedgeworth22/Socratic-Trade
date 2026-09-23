# FMP earnings-call transcripts: safe default-off producer

Date: 2026-07-13

## Summary

Adds a production-inert earnings-call transcript producer using FMP's current stable transcript-dates
and transcript-body endpoints. The producer is explicitly default off pending endpoint-plan and content-
rights confirmation. It has its own cadence, retry window, exact request-attempt budget, bounded JSON
reads, and fair rotating symbol cursor while sharing the durable RAG-write lease with filing producers.

Retrieval is separately rights-aware. Disabling future ingestion while rights remain confirmed keeps
existing evidence usable; withdrawing rights confirmation excludes transcript chunks from Strategy,
Coach/chat, and other broad RAG queries. Chunk hashes remain content-derived, while the existing
occurrence ledger carries ticker-period provenance separately. The source status exposes
feature/rights/capability/cadence/count state without exposing credentials or content.

Every actual FMP attempt crosses the application's tracked provider wrapper, including HTTP/network
failures and explicit retries. Authentication is sent in the `apikey` header; no API key, response body,
or credential-bearing URL is logged. The provider-reported call date remains event metadata, while RAG
point-in-time filtering uses the first time the app observed non-empty body content.

The owner's FMP Starter dashboard is below its rate and bandwidth limits. The stable transcript probes
nevertheless return HTTP 402 because transcript access is a plan capability, not quota exhaustion. The
connector records this as `endpoint_not_entitled`, stops after the first 402, schedules one bounded
recheck, and isolates transcript health/circuit state from ordinary FMP market-data health while usage
attribution remains `fmp`. The admin RAG card says `Plan excludes endpoint`, never `over limit`.

Round-8 review rejected the Round-7 content-only completion model. A new ticker/period could receive a
locally manufactured occurrence vector ID even though only another occurrence's canonical vector existed;
the source could therefore report complete while filtered retrieval returned nothing. It also found lossy
UTF-8/schema-less HTTP-200 success and non-fatal local receipt writes.

The remediated boundary materializes every completed occurrence as its own deterministic Pinecone record
with ticker/accession/PIT metadata. Exact embeddings may be reused from a bounded model/revision/text cache,
but vector identities and metadata are never reused or invented. `documentComplete` now requires exact
Pinecone cardinality and an atomic `document_chunks`/`chunk_occurrences` receipt transaction. HTTP-200
success requires fatal UTF-8, bounded JSON, and endpoint-specific dates/body schema validation first;
embedded provider errors and wrong endpoint rows produce one bounded redacted failure and no green event.

Round-9 adds the missing cross-cutting guarantees: crash-durable provider dispatch/quota/outbox rows,
two-phase managed-vector receipts with fail-closed retrieval, immutable transcript content versions,
operator scope and SEC lease propagation, bounded provider-authoritative rights inventory/purge, v1
embedding-space isolation, source-neutral Strategy copy, and account-deletion coverage. Within this app,
generic FMP and transcript calls share credential-wide authority. Production remains blocked until the
same guarantee is genuinely shared across every app using the credential and commercial rights are
confirmed.

## Files changed

- `src/lib/web-sources/fmp-transcripts.ts` — discovery, body ingestion, PIT observations, metering,
  fatal UTF-8/endpoint-envelope validation before HTTP-success telemetry,
  retry/budget/cadence/cursor/shared-lease controls, and exact ticker-period completion receipts.
- `src/lib/data-providers.ts` — exposes the tracked/redacted provider request boundary and separates
  optional capability health lanes from usage-provider attribution; tracked calls accept a cooperative
  lease/abort guard, can defer successful provider-call telemetry for body validation, stop before
  post-loss business telemetry, and reserve generic FMP calls in the same durable credential lane.
- `src/lib/db-provider-dispatch.ts`, `src/lib/usage-monitor-push.ts`,
  `src/lib/usage-monitor-replay.ts`, `src/lib/rag-metering.ts` — atomic request/cost reservations,
  dispatch/outcome/outbox durability, crash reconciliation, deterministic replay projection, and shared
  Voyage cost estimation.
- `src/lib/db-vector-commits.ts`, `src/lib/db.ts` — migration/schema and exact managed-vector,
  transcript-version, and receipt state transitions.
- `src/lib/notify.ts`, `src/lib/notifications.ts`, `src/lib/usage-limit-alerts.ts` — optional caller
  ownership guards and abort signals fence each real channel attempt, retry wait, later channel,
  operator fallback, notification-event, and audit boundary before/after awaits.
- `src/lib/web-sources/index.ts`, `src/lib/scheduler.ts` — status export and scheduler wiring serialized
  with the filing producer against the shared vector-ingest lease/budgets.
- `src/lib/strategy.ts`, `src/lib/prompt-safety.ts`, `src/lib/vector-db.ts` — transcript retrieval,
  rights-aware explicit and broad filtering, flag-aware corpus coverage, exact Voyage response mapping,
  lease cancellation through bootstrap/write/alert boundaries, per-occurrence Pinecone materialization,
  exact embedding reuse, required transactional receipts, prompt-safety documentation, and staleness horizon.
- `src/lib/web-sources/sec-filings.ts` — applies the same exact `documentComplete`/cardinality source-ledger
  boundary and shared lease guard to the long-document writer.
- `src/lib/account-deletion.ts` — removes new user-scoped vector/provider receipts and linked occurrences.
- `app/dashboard-types.ts`, `app/api/admin/rag-coverage/route.ts`, `app/admin/page.tsx`,
  `app/admin/rag-coverage/rag-coverage-client.tsx` — typed source status, capability wording, and labels.
- `.env.example`, `docs/design/earnings-rag.md` — operator contract and default-off configuration.
- `test/fmp-transcripts.test.ts`, `test/fmp-transcripts-telemetry.test.ts`,
  `test/rag-doc-type-coverage.test.ts`, `test/vector-db-retrieval.test.ts`,
  `test/vector-db-chunk-cap.test.ts`, `test/vector-db-embedding-integrity.test.ts`,
  `test/vector-db-lease-fencing.test.ts`, `test/vector-db-document-receipts.test.ts`,
  `test/sec-filings.test.ts`, `test/notification-status-truth.test.ts`,
  `test/usage-limit-alerts.test.ts` — focused safety, metering, retrieval-rights, exact mapping,
  real-dispatcher/fallback delayed-loss fencing, invalid-byte/envelope HTTP 200 telemetry,
  per-occurrence retrieval/PIT/citation, SQLite rollback, completion, and dedup regressions.
- `test/provider-dispatch-durability.test.ts`, `test/usage-monitor-replay.test.ts`,
  `test/account-deletion.test.ts` — atomic quota/cost, immutable outcomes, crash-unknown replay,
  idempotency, and deletion coverage for the new ledgers.

## Verification

Run from the repository root with the supported Node 24 runtime:

```bash
env PATH=/opt/homebrew/opt/node@24/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin npm run lint
env PATH=/opt/homebrew/opt/node@24/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin npx tsc --noEmit --pretty false
env PATH=/opt/homebrew/opt/node@24/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin npx vitest run test/fmp-transcripts.test.ts test/fmp-transcripts-telemetry.test.ts test/vector-db-chunk-cap.test.ts test/vector-db-retrieval.test.ts --testTimeout=60000
env PATH=/opt/homebrew/opt/node@24/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin npx vitest run test/rag-doc-type-coverage.test.ts --testTimeout=120000 --hookTimeout=120000
env PATH=/opt/homebrew/opt/node@24/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin npx vitest run test/scheduler-cadence.test.ts test/scheduler-lease.test.ts test/scheduler-single-leader-default.test.ts test/provider-operation-boundaries.test.ts --testTimeout=120000 --hookTimeout=120000
```

Round-5 results before current-main reconciliation: targeted lint 0 errors / 31 inherited warnings;
TypeScript clean; baseline 57/57; all FMP/vector 207/207; provider-boundary 119/119; adjacent SEC
66/66; notification 70/70; diff-check clean. Full `npm test` and `npm run build` remain required after
fresh independent review and origin/main reconciliation.

Round-6 remediation results before fresh re-review/current-main reconciliation: new hostile subset
23/23; notification/FMP/lease regression set 119/119; all FMP/vector 209/209; TypeScript clean;
targeted ESLint 0 errors / 27 inherited warnings. Diff-check is recorded below after documentation.

Round-7 remediation results before fresh re-review/current-main reconciliation: FMP regressions 33/33;
provider/health 128/128; all FMP/vector 212/212; TypeScript clean; targeted ESLint 0 errors / 3
inherited warning-class findings. Final diff-check is recorded below.

### Review history and Round-8 remediation

The first independent review rejected the draft. Its remediation:

1. parses FMP's documented `period: "Q1".."Q4"` body shape while retaining numeric-quarter
   compatibility and rejecting loose period strings;
2. gives an invalid-embedding accession one durable priority retry, then advances the symbol cursor
   while leaving the accession incomplete for a later universe rotation;
3. treats actual SDK abort rejections and aborted Voyage retry sleeps as lease loss before provider
   health, audit, alert, or last-ingest writes;
4. records `storeDocument.attempted` as the completed transcript chunk count so a retry after
   partial progress cannot permanently understate coverage.

Round-3 review rejected the resulting draft for four remaining gaps: Voyage response cardinality/index
mapping could misbind or silently omit documents; lease fencing did not cover all tracked-fetch and
Pinecone bootstrap boundaries; store error/empty outcomes lacked the same one-priority-retry/fairness
policy as malformed embeddings; and the documentation overstated closure. Round-4 adversarial review
then found two residuals: delayed notification/usage-alert work could continue after ownership moved,
and the completion audit's `chunks` field reported only this-attempt indexing rather than the document's
total durable chunk count.

Round-5 remediation now:

1. validates every Voyage document batch as an exact bijection: exact cardinality, all-positional or
   all-indexed shape, integer in-range unique indices, and valid embeddings; any malformed entry rejects
   the entire batch before Pinecone;
2. re-proves ownership around tracked fetch, retry sleep, Pinecone list/create/ready/describe/upsert,
   notification, usage-alert, and Sentry boundaries; guarded alert paths are awaited rather than detached;
3. applies one durable priority retry to store error, empty, incomplete, and invalid-embedding outcomes,
   then rotates fairly without writing a false completion row;
4. requires `storeDocument.documentComplete === true` before source completion and persists/audits
   `chunks` as total attempted durable document chunks with `indexedThisAttempt` as the explicit delta.

Hostile regressions use temporary SQLite databases and lose ownership inside delayed index-failure,
budget-notification, missing-client-notification, ready-wait, describe, and upsert boundaries. They
compare health/audit/notification/settings snapshots at loss with final state and require equality.

Round-5 Node 24 verification:

```bash
env PATH=/opt/homebrew/opt/node@24/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin \
  npx vitest run test/fmp-transcripts.test.ts test/fmp-transcripts-telemetry.test.ts \
  test/vector-db-chunk-cap.test.ts test/vector-db-retrieval.test.ts \
  --testTimeout=60000 --hookTimeout=60000
env PATH=/opt/homebrew/opt/node@24/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin \
  npx vitest run test/vector-db*.test.ts test/fmp-transcripts.test.ts \
  test/fmp-transcripts-telemetry.test.ts --testTimeout=60000 --hookTimeout=60000
env PATH=/opt/homebrew/opt/node@24/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin \
  npx vitest run test/data-providers.test.ts test/api-circuit-breaker.test.ts \
  test/provider-operation-boundaries.test.ts --testTimeout=60000 --hookTimeout=60000
env PATH=/opt/homebrew/opt/node@24/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin \
  npx vitest run test/sec-filings.test.ts test/sec8k-full-body.test.ts \
  test/disclosure-rag.test.ts --testTimeout=60000 --hookTimeout=60000
env PATH=/opt/homebrew/opt/node@24/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin \
  npx vitest run test/notification-lifecycle.test.ts test/notification-status-truth.test.ts \
  test/notify-push-sanitize.test.ts test/notify.test.ts test/persistence-notification.test.ts \
  test/policy-notification-events.test.ts test/usage-limit-alerts.test.ts \
  --testTimeout=60000 --hookTimeout=60000
env PATH=/opt/homebrew/opt/node@24/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin npx tsc --noEmit
git diff --check
```

Results: 57/57 baseline; 207/207 full FMP/vector; 119/119 provider-boundary; 66/66 adjacent
SEC; 70/70 notification; TypeScript and diff-check clean. Targeted ESLint over all touched source and
hostile tests reports 0 errors / 31 inherited warning-class findings.

Round-6 independent review rejected Round 5 on two residual fences. The wrapper checked ownership
before and after `notify()`, but the real dispatcher itself could continue a retry, later channel, and
per-channel `notify.sent`/`notify.error` audit after ownership moved; the operator-email fallback used
that same unguarded dispatcher. Separately, terminal FMP response-body cancellation swallowed cancel
errors and returned without a post-await ownership proof, allowing cursor/capability writes after a
lease was stolen during delayed body discard. The prior notification test used an audit-free injected
dispatcher, so it could not detect the real internal write.

Round-6 remediation:

1. adds optional `assertActive` plus `AbortSignal` control to the real dispatcher without changing
   ordinary callers; ownership is checked before/after every channel attempt, retry, channel advance,
   and per-channel audit;
2. combines caller cancellation with per-request notification timeouts and makes retry waits abortable;
3. propagates the same controls through `sendNotification`, the legacy webhook, additional-delivery
   control, RAG connection alerts, usage alerts, and the direct operator-email fallback;
4. re-proves FMP operation ownership after terminal response-body discard and immediately after both
   dates/body request-helper returns before cursor, capability, observation, or other caller state.

New hostile tests use the real dispatcher with two enabled channels and three attempts, lose ownership
inside a delayed send and a 60-second retry wait, and require one request plus no late audit/event rows.
The fallback test loses ownership inside the real Resend path and compares the durable snapshot at loss
with final state. FMP tests use a delayed `ReadableStream.cancel()` at both dates and body HTTP 402
boundaries, steal the SQLite lease while cancellation is pending, and require no cursor/capability write.

Round-6 Node 24 verification:

```bash
env PATH=/opt/homebrew/opt/node@24/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin \
  npx vitest run test/notification-status-truth.test.ts test/usage-limit-alerts.test.ts \
  test/fmp-transcripts-telemetry.test.ts --testTimeout=60000 --hookTimeout=60000
env PATH=/opt/homebrew/opt/node@24/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin \
  npx vitest run test/connection-health-routing.test.ts test/fmp-transcripts.test.ts \
  test/fmp-transcripts-telemetry.test.ts test/notification-lifecycle.test.ts \
  test/notification-status-truth.test.ts test/notify-push-sanitize.test.ts test/notify.test.ts \
  test/persistence-notification.test.ts test/policy-notification-events.test.ts \
  test/usage-limit-alerts.test.ts test/vector-db-lease-fencing.test.ts \
  --testTimeout=60000 --hookTimeout=60000
env PATH=/opt/homebrew/opt/node@24/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin \
  npx vitest run test/vector-db*.test.ts test/fmp-transcripts.test.ts \
  test/fmp-transcripts-telemetry.test.ts --testTimeout=60000 --hookTimeout=60000
env PATH=/opt/homebrew/opt/node@24/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin npx tsc --noEmit --pretty false
env PATH=/opt/homebrew/opt/node@24/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin npm run lint
env PATH=/opt/homebrew/opt/node@24/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin \
  npx eslint src/lib/notify.ts src/lib/notifications.ts src/lib/usage-limit-alerts.ts \
  src/lib/vector-db.ts src/lib/web-sources/fmp-transcripts.ts \
  test/notification-status-truth.test.ts test/usage-limit-alerts.test.ts \
  test/fmp-transcripts-telemetry.test.ts
git diff --check
```

Results: 23/23 hostile subset; 119/119 notification/FMP/lease set; 209/209 full FMP/vector;
TypeScript clean; targeted ESLint 0 errors / 27 inherited warning-class findings; full `npm run lint`
0 errors / 453 inherited warnings; diff-check clean.
Fresh independent re-review, origin/main reconciliation, and the full post-reconciliation lint/test/build
gate remain required before PR creation.

Round-7 independent review rejected Round 6 on two P2 truth gaps:

1. `fetchWithRetry` wrote a green `fmp-transcripts` health row and successful `fmp` usage count as soon
   as it received HTTP 200, before `readBoundedJson` rejected malformed or oversized response bodies;
2. a new accession completed entirely from content dedup wrote the ingestion ledger but incremented
   `skippedExisting` and emitted no `fmp_transcript_ingest` audit, obscuring a successful completion.

Round-7 remediation:

1. adds a narrow `deferSuccessUsage` transport option alongside the existing deferred-success health
   control; HTTP failures and transport failures remain wrapper-owned, while FMP owns exactly one
   post-validation health and usage outcome for each HTTP 200 attempt;
2. writes constant error text for malformed/incomplete or oversized HTTP 200 bodies, never provider
   content, request URLs, or API keys, and checks lease ownership before every manual telemetry write;
3. counts a newly completed all-dedup accession in `ingested`, persists the total attempted chunk count,
   and emits the standard ingestion audit with `indexedThisAttempt: 0` and
   `deduplicatedCompletion: true`;
4. adds hostile temporary-DB/mocked-transport regressions for malformed JSON, declared-oversized JSON,
   no false-green row, one failed usage event, secret/body/URL absence, and all-dedup completion truth.

Round-7 Node 24 verification:

```bash
env PATH=/opt/homebrew/opt/node@24/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin \
  npx vitest run test/fmp-transcripts-telemetry.test.ts test/fmp-transcripts.test.ts
env PATH=/opt/homebrew/opt/node@24/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin \
  npx vitest run test/data-providers.test.ts test/api-circuit-breaker.test.ts \
  test/provider-operation-boundaries.test.ts test/fmp-transcripts-telemetry.test.ts \
  --testTimeout=60000 --hookTimeout=60000
env PATH=/opt/homebrew/opt/node@24/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin \
  npx vitest run test/vector-db*.test.ts test/fmp-transcripts.test.ts \
  test/fmp-transcripts-telemetry.test.ts --testTimeout=60000 --hookTimeout=60000
env PATH=/opt/homebrew/opt/node@24/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin \
  npx tsc --noEmit --pretty false
env PATH=/opt/homebrew/opt/node@24/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin \
  npx eslint src/lib/data-providers.ts src/lib/web-sources/fmp-transcripts.ts \
  test/fmp-transcripts.test.ts test/fmp-transcripts-telemetry.test.ts
git diff --check
```

Results: 33/33 focused FMP regressions; 128/128 provider/health; 212/212 full FMP/vector;
TypeScript and diff-check clean; targeted ESLint 0 errors / 3 inherited warnings. The first TypeScript run caught a
test-only `HeadersInit` union mismatch in the new parameterized fixture; the fixtures now use explicit
`Headers`, and the rerun is clean. One non-authoritative quoted-glob smoke selected only the two FMP
files; the unquoted command above was rerun and is the recorded 16-file/212-test result.

Round-8 independent review then rejected Round 7 on three remaining boundaries:

1. content-hash dedup could mark a later ticker/accession/date occurrence complete without a real
   Pinecone record carrying that occurrence's metadata;
2. replacement UTF-8 decoding and JSON-only validation could accept corrupt bytes or a valid JSON
   provider-error/wrong-endpoint envelope before green telemetry;
3. `document_chunks` and `chunk_occurrences` failures were swallowed after Pinecone success, allowing
   a false source-level completion without required local receipts.

Round-8 remediation:

1. removes content-only completion from `storeDocument`; every chunk occurrence is upserted under a
   deterministic occurrence ID with its own symbol, source accession, chunk ID, and PIT metadata;
2. adds a bounded process-local exact embedding cache keyed by model + embedding revision + final input,
   so identical content can skip Voyage while still producing distinct per-occurrence Pinecone records;
3. accepts a Voyage batch only as an exact bijection and never manufactures a missing vector ID;
4. requires exact `indexed === attempted` plus a nested-safe SQLite transaction covering both local
   receipt tables before setting `documentComplete:true`; receipt faults return the bounded
   `document-receipt-write-failed` error and remain retryable;
5. uses fatal UTF-8 and endpoint-specific dates/body schema validation before one green health/usage
   event; malformed bytes/JSON, oversize bodies, embedded errors, and wrong-endpoint rows write one
   constant redacted failure and no green;
6. fast-forwards the lane to current `origin/main@86971ec4`, preserving TypeScript 7 and the merged
   crash-durable persisted LLM/RAG replay work.

Round-8 tests use mocked Voyage/Pinecone/FMP transports plus temporary SQLite only. They prove that
identical AAPL/MSFT text produces two real vector IDs, the failed MSFT write cannot complete or write an
occurrence receipt, both records retrieve with their own citation/PIT metadata after success, pre-PIT
retrieval excludes the later call, and a forced `chunk_occurrences` SQL fault rolls back the preceding
`document_chunks` write before an idempotent retry succeeds with one reused embedding.

Round-8 Node 24 verification after fast-forwarding to `origin/main@86971ec4`:

```bash
PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run \
  test/vector-db-chunk-cap.test.ts test/vector-db-document-receipts.test.ts \
  test/fmp-transcripts.test.ts test/fmp-transcripts-telemetry.test.ts test/sec-filings.test.ts \
  --testTimeout=60000 --hookTimeout=60000
PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run \
  test/fmp-transcripts.test.ts test/fmp-transcripts-telemetry.test.ts test/data-providers.test.ts \
  test/provider-rate-limit.test.ts test/provider-operation-boundaries.test.ts \
  test/connection-health-routing.test.ts test/notification-status-truth.test.ts \
  test/usage-limit-alerts.test.ts test/vector-db-chunk-cap.test.ts \
  test/vector-db-document-receipts.test.ts test/vector-db-embedding-integrity.test.ts \
  test/vector-db-lease-fencing.test.ts test/vector-db-retrieval.test.ts test/vector-db.test.ts \
  test/rag-doc-type-coverage.test.ts test/scheduler-cadence.test.ts \
  test/scheduler-single-leader-default.test.ts test/sec-filings.test.ts \
  test/usage-monitor-push.test.ts test/usage-monitor-replay.test.ts \
  --testTimeout=120000 --hookTimeout=120000
PATH=/opt/homebrew/opt/node@24/bin:$PATH npx tsc --noEmit --pretty false
PATH=/opt/homebrew/opt/node@24/bin:$PATH npx eslint <all changed TypeScript and focused tests>
git diff --check
```

Results: focused FMP/SEC/vector/receipt set 88/88; broader 20-file regression set 380/380;
TypeScript clean; scoped ESLint 0 errors / 79 inherited warning-class findings; tracked diff-check
clean. A stale assertion briefly expected an unplanned revision 2; the implementation and corrected
test keep `embed_rev=1` until a bounded inventory/backfill, completeness check, cutover, rollback window,
and v1 deletion can occur. No provider, corpus, Infisical, or production call/write was made.

### Round-9 nine-finding durability and rights remediation

A current-snapshot hostile audit rejected Round 8 for nine cross-cutting gaps: managed vectors could
become provider-visible without exact durable commit receipts; provider attempts/quota were not crash-
durable; the authority was not credential-wide; transcript corrections overwrote point-in-time truth;
vector IDs/scopes did not encode the complete identity; rights-off had no deterministic inventory/purge;
an unplanned global v2 population could mix embedding spaces; SEC did not carry the shared producer
lease through storage; and Strategy copy named the vendor instead of the evidence type.

Round-9 remediation:

1. adds migration 27 tables for atomic provider dispatch reservations/outcomes/outbox rows, managed
   vector commits, and immutable FMP transcript content versions;
2. reserves request units and estimated cost transactionally before every FMP/Voyage/Pinecone boundary,
   marks the exact dispatch immediately around fetch/SDK calls, settles independently of business lease,
   releases only proven undispatched reservations, and converts crash-left dispatches to `unknown`;
3. projects deterministic provider-attempt events in `usage-monitor-push.ts` and drains the durable
   provider outbox alongside LLM/RAG ledgers in `usage-monitor-replay.ts`; durable attempts suppress the
   older in-memory aggregate so one request is not double-counted;
4. routes generic FMP enrichment and transcript calls through the same credential fingerprint/window
   ledger inside Socratic-Trade; a true cross-app shared store remains an activation requirement;
5. writes managed Pinecone records as `pending`, persists exact local content/occurrence receipts,
   promotes the complete provider set, then commits local queryability. Retrieval excludes pending
   records server-side and validates every managed identity/version field against SQLite, failing closed
   on missing receipts, marker deletion, metadata tampering, or local validation faults;
6. uses full SHA-256 occurrence IDs over tenant/source/accession/content version/section/ordinal/parser/
   embedding revisions; keeps `embed_rev=1`; and adds deterministic dry-run reconciliation that deletes
   incomplete/extra provider sets or finalizes only exact complete sets;
7. records distinct corrected transcript bodies as immutable content versions with their own
   `first_content_seen_at`; exact replays are idempotent, ingestion is restricted to the local operator,
   and SEC passes the shared RAG lease guard into `storeDocument`;
8. adds bounded provider-authoritative rights inventory (including receiptless vectors) and dry-run-
   default provider-first purge with zero-residue verification before one local transaction. Exact
   source/doc-tagged audits are deleted; unattributable aggregate decisions are retained explicitly
   rather than guessed. Provider usage rows contain no transcript content and remain billing truth;
9. extends account deletion for new user-scoped provider/vector rows and linked occurrences, and makes
   Strategy wording evidence-source-neutral.

The rights scan hard-fails at `FMP_TRANSCRIPT_RIGHTS_SCAN_MAX_RECORDS` rather than returning a partial
inventory. `PROVIDER_DISPATCH_{VOYAGE,PINECONE}_PER_MIN=0` pauses that lane; empty/unset values use safe
defaults. The same authority ID on isolated databases does not create cross-app serialization.

Node 24 verification during Round 9 (all mocked providers and temporary SQLite):

```bash
PATH=/opt/homebrew/opt/node@24/bin:$PATH npx tsc --noEmit
PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run \
  test/provider-dispatch-durability.test.ts test/usage-monitor-replay.test.ts \
  test/fmp-transcripts.test.ts test/fmp-transcripts-telemetry.test.ts \
  test/vector-db-document-receipts.test.ts test/vector-db-lease-fencing.test.ts \
  test/vector-db-chunk-cap.test.ts test/sec-filings.test.ts test/data-providers.test.ts \
  test/milestone-4-challenger.test.ts
PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run \
  test/vector*.test.ts test/rag*.test.ts test/disclosure-rag.test.ts \
  test/fmp-transcripts*.test.ts test/sec*.test.ts test/web-sources-sec*.test.ts \
  test/data-providers.test.ts test/usage-monitor-*.test.ts test/account-deletion*.test.ts \
  test/strategy-rag-quickwins-wiring.test.ts
PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run lint
PATH=/opt/homebrew/opt/node@24/bin:$PATH npm test
PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run build
git diff --check
```

The first focused run passed 239/240 and exposed one missing explicit receipt-marker check; after the
fix its regression is 4/4 green. The adjacent rerun is 51 files / 732 tests green, and the dedicated
account-deletion behavior/coverage set is 7/7 green. Full lint passes with 0 errors / 459 inherited
warnings, TypeScript is clean, the full suite passes 367 files / 4,126 tests, and diff-check is clean.
The old-base production build fails during webpack resolution of existing `@/lib/*` imports because
`86971ec4` still carries the unsupported TypeScript 7 alias hack; fetched `origin/main@4432c2bc` removes
that hack and restores the supported TypeScript gate. Current-main reconciliation plus a repeated full
gate, including a successful build, and fresh hostile review remain mandatory before a ready PR.

No live FMP request or production corpus write is part of verification. Tests use an isolated SQLite
database, mocked transcript responses, and an injected usage-monitor collector.

### Round-10 current-main reconciliation

The complete Round-9 dirty tree was first captured in local-only checkpoint `52cfcbec` with parent
`86971ec4`. Fetched `origin/main@4432c2bc` was then merged in `0713a254` with zero conflicts, preserving
both the incoming production-worker gates and supported TypeScript repair. Neither commit was pushed and
no PR exists. Node 24 `npm ci` installed Node 24.18.0, npm 11.16.0, TypeScript 6.0.3, and
`@types/node` 24.13.3 without changing the lockfile.

The first current-main full suite passed 369 files / 4,144 tests. The following production build exposed
a real current-main blocker: `data-providers.ts` imported `node:crypto`, and that module reached the Edge
bundle through `market -> strategy -> scheduler -> background-worker-startup`. The credential fingerprint
now uses awaited `globalThis.crypto.subtle.digest("SHA-256", ...)`; all production and test callers await
it, and an exact known SHA-256 digest regression proves the result without storing or logging credentials.
Focused post-fix verification passed 3 files / 148 tests, TypeScript, a scoped lint with 0 errors / 6
inherited warnings, and a diagnostic production build with the real TypeScript phase.

Final ordered Node 24 verification:

```bash
PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run lint
PATH=/opt/homebrew/opt/node@24/bin:$PATH npx tsc --noEmit --pretty false
PATH=/opt/homebrew/opt/node@24/bin:$PATH npm test
PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run build
git diff --check
```

Results: lint 0 errors / 458 inherited warning-class findings; TypeScript clean; full suite 369 files /
4,145 tests; production build clean with `Running TypeScript`, `Finished TypeScript`, and 32 generated
static pages; diff-check clean. A fresh current-main hostile review found no remaining P0/P1/P2 code
finding across atomic provider reservations and immutable outcomes, crash-`unknown` reconciliation and
outbox replay, two-phase managed-vector receipts and fail-closed retrieval, corrected-body PIT versions,
operator-only ingestion, scheduler dual gating, bounded rights inventory/provider-first purge, and account
deletion. The implementation is locally code-ready. Activation is not ready: endpoint entitlement,
commercial persistence/embedding/display rights, and one genuinely shared cross-app transactional quota
authority remain hard gates.

Round-10 touched `src/lib/data-providers.ts`, `src/lib/web-sources/fmp-transcripts.ts`,
`test/data-providers.test.ts`, `STATUS.md`, `PLAN.md`, `docs/phase-9-web-sources.md`, this rollout note,
and both effort-log mirrors. No FMP/provider request, Infisical read/write, vector/corpus/R2 mutation,
activation, push, PR, deployment, or production write occurred.

### Round-11 landing review and managed-commit cardinality correction

The independent landing pass found one release-blocking flaw missed by Round 10. `storeContexts` may
legitimately trim a document set to a nonzero prefix when the rolling Voyage text budget or Pinecone
write-unit fuse has only partial capacity. The managed commit previously compared `indexed` only with
that already-trimmed `documentsToStore` array, then invoked callbacks that persisted all original chunk
receipts and promoted the written prefix to `ingest_state=committed`. The source correctly returned
`documentComplete:false`, but the prefix could still match the falsely committed relational receipt and
enter retrieval before a complete retry.

`storeDocument` now passes its immutable original occurrence count as `expectedRecordCount`.
`storeContexts` invokes neither receipt persistence nor provider promotion unless the post-budget
document set and successful upsert count both equal that exact count. A nonzero partial prefix therefore
remains provider-`pending`, has no local `chunk_occurrences`, fails committed-receipt retrieval, and keeps
the source document retryable. Regression coverage exercises both the ingest-text budget and Pinecone
write-unit budget on generic SEC documents; it also restores capacity and proves the deterministic retry
commits the exact complete set.

Verification used Node 24.18.0 / npm 11.16.0 and no live provider or production state:

```bash
PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run test/vector-db-document-receipts.test.ts
PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run lint
PATH=/opt/homebrew/opt/node@24/bin:$PATH npx tsc --noEmit --pretty false
PATH=/opt/homebrew/opt/node@24/bin:$PATH npm test
PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run build
git diff --check
```

Results: exact receipt regression 6/6; related focused set 6 files / 106 tests; lint 0 errors / 458
inherited warnings; TypeScript clean; full suite 369 files / 4,147 tests; production build clean with
`Running TypeScript`, `Finished TypeScript`, and 32 static pages; diff-check clean. A scoped hostile
re-review found no remaining P0/P1/P2 in the managed-vector budget/receipt/retry path. The remediation
remains local, uncommitted, and unpushed for root review. No PR, merge, deploy, flag change, FMP/provider
call, corpus mutation, or Infisical mutation occurred; the activation blockers below are unchanged.

### Round-13/14 receipt, privacy, retrieval, and account-erasure hardening

Round 12 revoked the prior release claim after proving that committed replay could be demoted before an
early return, concurrent writers could mutate one commit attempt, SEC 8-K could record an incomplete
budget result as ingested, and empty/duplicate occurrence cases were under-specified. The current local
remediation preserves committed generations, serializes exact commit attempts, requires exact completion
at every filing caller, and retains immutable point-in-time versions. Retrieval now makes tenant scope
authoritative, explicitly stores local decision/experience memory as private, filters legacy account
memory before receipt/rerank/prompt handling, and raises bounded provider topK by the locally proven stale
managed-generation upper bound while reporting cap saturation as degraded.

Account deletion now performs provider erasure before local receipt/secret deletion. Preparing deletion
fences new durable dispatch even before idempotency replay; only the exact prepared request crosses the
erasure boundary. The operation waits for current dispatches, holds the shared RAG-write lease, inventories
the provider index within a hard bound using Pinecone without requiring an unrelated Voyage credential,
deletes exact private/legacy account vectors, fetch-verifies their
absence, rechecks blockers, and then commits local deletion. The local operator's public SEC/web corpus is
preserved, and globally deduplicated `document_chunks` text is deleted only when no surviving occurrence
still references the hash. Any provider or verification error leaves the prepared request and local keys
retryable. If a process dies after provider deletion but before the local transaction, the next attempt
recovers exact private content hashes from durable occurrence receipts even though provider inventory is empty.

Files touched by the current local snapshot:

- `app/api/account/deletion/route.ts`
- `app/api/mobile/account-deletion/confirm/route.ts`
- `src/lib/account-deletion.ts`
- `src/lib/db-provider-dispatch.ts`
- `src/lib/db-vector-commits.ts`
- `src/lib/db.ts`
- `src/lib/experience-memory.ts`
- `src/lib/socratic-memory.ts`
- `src/lib/vector-db.ts`
- `src/lib/web-sources/fmp-transcripts.ts`
- `src/lib/web-sources/sec-filings.ts`
- `src/lib/web-sources/sec8k.ts`
- `test/account-deletion.test.ts`
- `test/experience-memory.test.ts`
- `test/fmp-transcripts.test.ts`
- `test/mobile-api.test.ts`
- `test/outcome-engine.test.ts`
- `test/persistence-hardening.test.ts`
- `test/provider-dispatch-durability.test.ts`
- `test/sec-filings.test.ts`
- `test/sec8k-full-body.test.ts`
- `test/socratic-db.test.ts`
- `test/vector-db-asof-server-filter.test.ts`
- `test/vector-db-backlog-c-integration.test.ts`
- `test/vector-db-chunk-cap.test.ts`
- `test/vector-db-document-receipts.test.ts`
- `test/vector-db-retrieval.test.ts`
- `test/vector-db-scope.test.ts`
- `test/vector-db.test.ts`
- `test/web-sources-sec8k.test.ts`
- `STATUS.md`, `PLAN.md`, `docs/EFFORT-LOG.md`, `docs/phase-9-web-sources.md`, and this rollout note

Current Node 24 verification (mocked providers and temporary SQLite only):

```bash
PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run \
  test/vector-db-scope.test.ts test/vector-db.test.ts \
  test/vector-db-asof-server-filter.test.ts test/vector-db-asof-strict.test.ts \
  test/vector-db-document-receipts.test.ts test/vector-db-retrieval.test.ts \
  test/vector-db-backlog-c-integration.test.ts test/vector-db-chunk-cap.test.ts \
  test/experience-memory.test.ts test/socratic-db.test.ts test/outcome-engine.test.ts \
  test/account-deletion.test.ts test/account-deletion-coverage.test.ts test/mobile-api.test.ts \
  test/provider-dispatch-durability.test.ts test/fmp-transcripts.test.ts test/sec-filings.test.ts \
  test/sec8k-full-body.test.ts test/web-sources-sec8k.test.ts test/persistence-hardening.test.ts
PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run \
  test/vector-db-scope.test.ts test/account-deletion.test.ts
PATH=/opt/homebrew/opt/node@24/bin:$PATH npx tsc --noEmit --pretty false
git diff --check
```

Results: 20 files / 256 tests green; post-review privacy/deletion subset 2 files / 22 tests green;
TypeScript and diff-check clean. Independent hostile review and the serialized repository lint/test/build
gate remain pending. Draft PR #1586 stays HOLD; its current hosted green checks cover an older pushed
snapshot, not this dirty local remediation. No FMP/provider/corpus/R2/Infisical/production mutation ran.

### Round-15 deletion-generation, trigger, and rights-derived-artifact hardening

The next hostile pass found that a tenant could request shared scope before `storeDocument` derived its
managed identity, a private write could outlive account deletion because only the lower-level upsert was
claimed, a receiptless provider ghost could survive when physical-index identity was unavailable, and one
clean provider read was insufficient under eventual consistency. It also found that pre-change Auth.js
cookies had no post-deletion login claim, lock contention returned a failed strategy result that the trigger
still acknowledged, and the settings fence covered only four key families.

The remediation forces every nonlocal document/context write private before tenant and commit IDs exist,
holds one durable account-operation claim across the complete managed-document workflow, requires current
physical provider authority even with no local receipts, and uses repeated exact fetch plus managed/default/
private inventory with a consecutive-clean stability threshold. One canonical settings ownership matcher is
now shared by deletion counts, deletion cleanup, and prepared/completed SQLite triggers for provider-tier,
risk, learning-review, auto-tune, regime, model rotation, OAuth, run lock, budget, health/usage alert, and
other user-owned internal rows. Auth.js generation resolution rejects missing or pre-cutoff provider-login
claims once a tombstone exists. Event-trigger claims return to the durable queue whenever `runStrategyOnce`
does not complete, with a real held-lock regression. Transcript rights generations additionally track exact
derived chat, prompt-safety audit, decision/framework, and provider-work provenance so withdrawal blocks new
writes and removes only proven derived artifacts after external work is terminal.

Current Node 24 verification uses mocked providers and temporary SQLite only:

```bash
PATH=/opt/homebrew/opt/node@24/bin:$PATH npx tsc --noEmit
PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run \
  test/vector-db-scope.test.ts test/account-deletion.test.ts test/fmp-transcripts.test.ts \
  test/persistence-hardening.test.ts test/vector-db-document-receipts.test.ts \
  test/sec-filings.test.ts test/web-sources-sec8k.test.ts test/sec8k-full-body.test.ts \
  test/scheduler-managed-vector-reconcile.test.ts test/trigger-durability.test.ts \
  test/trigger-lock-contention.test.ts test/middleware-auth.test.ts test/mcp-oauth.test.ts \
  test/mobile-api.test.ts test/strip-identity.test.ts test/provider-dispatch-durability.test.ts \
  test/vector-db-chunk-cap.test.ts test/vector-db-retrieval.test.ts test/vector-db.test.ts \
  test/token-budget-ceiling.test.ts
PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run test/fmp-rights-derived-artifacts.test.ts
git diff --check
```

Results: 20 files / 302 tests and 1 file / 4 tests green; TypeScript and diff-check clean. Fetched
`origin/main@2dabc7f8` already owns migrations 27-28, so this dirty snapshot must be checkpointed, merged,
and renumbered to transcript/vector migrations 29-39 before the ordered lint/TypeScript/full-test/build gate.
PR #1586 remains draft. No FMP/provider/corpus/R2/Infisical/activation/production mutation ran.

### Round-16 current-main reconciliation and final identity/settings review

Fetched `origin/main@2dabc7f8` was merged additively. Its Socratic narrative and user-scoped order-
replacement migrations remain versions 27-28; this lane's provider/vector/fence/account-generation
migrations are renumbered 29-39. Main's atomic proposal-plus-decision persistence is combined with the
transcript lane's rights-generation artifact ledger and asynchronous provider-work receipt, so no proposal
can reach placement without its decision receipt and rights withdrawal can still identify derived state.

The hostile pass found two remaining P2 ownership gaps. Cloudflare Access had priority in middleware but
did not forward a provider-session timestamp, so even a fresh Access login could not leave a deleted base
generation. Middleware now extracts `iat` from the trusted Access assertion only when its embedded email
matches the trusted Access email; request resolution applies the same fresh/post-cutoff generation rule to
Auth.js and Cloudflare identities. Separately, broker-minimum notification cooldowns omitted user identity;
their keys now begin with user ID and are part of the canonical settings ownership matcher used by both
SQLite write fences and account erasure.

Verification used Node 24 with mocked providers and temporary SQLite only:

```bash
PATH=/opt/homebrew/opt/node@24/bin:$PATH npx tsc --noEmit
PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run \
  test/persistence-hardening.test.ts test/socratic-db.test.ts \
  test/fmp-rights-derived-artifacts.test.ts test/account-deletion.test.ts \
  test/middleware-auth.test.ts test/broker-minimum-guard.test.ts \
  test/strategy-money-path-f-g.test.ts test/final-size-red-autonomous.test.ts \
  test/finalized-sizing-review.test.ts
git diff --check
```

Results: TypeScript clean; 9 files / 99 tests green; diff-check clean. Fresh hostile re-review and the
ordered full lint/TypeScript/test/build gate remain required before PR #1586 leaves draft. No feature flag,
FMP/provider request, corpus/vector write, Infisical mutation, activation, or production write occurred.

### Round-17 final authority, erasure-stability, and retrieval-recall hardening

Round 16's Cloudflare Access `iat` design was rejected after checking the token lifecycle: an Access
application token can refresh without a fresh IdP login. Middleware now treats it only as authorization;
post-deletion identity regeneration requires a matching signed Auth.js session with a post-cutoff
`loginAt`. Migration 40 clears all unowned legacy broker-minimum cooldown keys once; new keys are
user-first and therefore covered by the canonical settings write fence and eraser.

The final transcript hostile review found two provider-erasure P1s and one retrieval P2. Each licensed
decision-memory write now resolves and records the exact physical Pinecone authority, logical SQLite
ledger authority, immutable generation-bound vector ID, and durable heartbeat lease before upsert.
Every provider boundary re-proves the rights/work lease and store-time provider/ledger identity. Exact
private purge and verification select the recorded historical namespace and reject current-provider or
manifest mismatch, preserving local receipts when a rotated credential makes the old provider
unreachable. Provider absence must be observed cleanly for a configurable consecutive window; a vector
that disappears and reappears resets the streak, and SQLite provenance is not removed on failure.

Private and shared retrieval now query separate bounded pools and combine them only for ranking. The
regression deliberately gives shared evidence a low dense score behind a saturated private tier, then
proves the reranker can still promote it. Migration 41 installs the FMP rights gate, derived-provenance
ledger, and provider-work receipts in the versioned schema so account-deletion coverage and automatic
user write-fence triggers see them at boot; the producer's idempotent schema ensure remains only as a
legacy/isolated-database defense.

Files added or materially changed in this round: `src/lib/socratic-memory.ts`,
`src/lib/vector-db.ts`, `src/lib/web-sources/fmp-transcripts.ts`, `src/lib/db.ts`,
`src/lib/account-deletion.ts`, `middleware.ts`, `src/lib/request-user.ts`,
`src/lib/broker-minimum-guard.ts`, `test/fmp-rights-derived-artifacts.test.ts`,
`test/vector-db-scope.test.ts`, `test/socratic-db.test.ts`,
`test/persistence-hardening.test.ts`, `test/account-deletion-coverage.test.ts`,
`test/db-migration-old-schema.test.ts`, and the status/phase/effort documents.

Current Node 24 verification (mocked providers and temporary SQLite only):

```bash
PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run \
  test/fmp-rights-derived-artifacts.test.ts test/socratic-db.test.ts \
  test/vector-db-scope.test.ts test/fmp-transcripts.test.ts
PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run \
  test/persistence-hardening.test.ts test/db-migration-old-schema.test.ts \
  test/account-deletion-coverage.test.ts test/account-deletion.test.ts \
  test/fmp-rights-derived-artifacts.test.ts test/socratic-db.test.ts \
  test/vector-db-scope.test.ts
PATH=/opt/homebrew/opt/node@24/bin:$PATH npx tsc --noEmit
git diff --check
```

Results: 4 files / 69 tests and 7 files / 71 tests green; TypeScript and diff-check clean. The ordered
full lint/TypeScript/test/build gate and fresh hostile re-review remain before PR #1586 leaves draft.
No FMP request, feature activation, provider/corpus write, Infisical mutation, or production action ran.

### Round-18 no-write settlement and bounded fair reranking

The next hostile pass found two P2 edge cases. A licensed provider-work reservation could settle after
dedup, an exhausted budget, or missing provider configuration without ever upserting a vector; requiring
its absent private-namespace manifest during purge would then block rights erasure forever. Provider work
now records one of `completed`, `no_provider_write`, or `provider_write_unknown`. Only proven no-write
receipts are excluded from provider inventory; unknown outcomes remain exact-delete obligations. Tests
cover both indexer settlement and successful rights purge without an invented private vector.

Separately, six independently over-fetched tiers could form a union larger than Voyage's 1,000-document
rerank contract. The union is now deduplicated and, only when needed, rank-round-robin capped so every
non-empty tier retains quota; selected candidates return to global cosine order for fail-open fallback.
`rerankMatches` also applies a final 1,000-document provider-contract defense. A 2,000-candidate
private/shared regression proves the reranker receives exactly 1,000 documents (500 from each tier) and
can promote low-dense-score shared evidence.

Verification:

```bash
PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run \
  test/fmp-rights-derived-artifacts.test.ts test/socratic-db.test.ts \
  test/vector-db-scope.test.ts test/vector-db-rerank-floor.test.ts \
  test/vector-db-rerank-overfetch.test.ts
PATH=/opt/homebrew/opt/node@24/bin:$PATH npx tsc --noEmit
PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run \
  test/persistence-hardening.test.ts test/db-migration-old-schema.test.ts \
  test/account-deletion-coverage.test.ts test/account-deletion.test.ts \
  test/fmp-rights-derived-artifacts.test.ts test/socratic-db.test.ts \
  test/vector-db-scope.test.ts
git diff --check
```

Results: 5 files / 46 tests and 7 files / 74 tests green; TypeScript and diff-check clean. Fresh hostile
re-review and the ordered full repository gate remain. No external provider/config/production mutation ran.

### Round-19 ambiguous-write erasure and eligibility-before-quota

The final hostile pass found two remaining edge cases. First, `storeContexts` can return zero indexed
records plus an error when a provider request timed out after dispatch; the remote upsert may still have
committed. Decision-memory work now classifies only a clean zero-index result as `no_provider_write`.
Zero-index plus any error stays `provider_write_unknown`, remains in private-vector inventory, and is
deleted and verified through the recorded provider/ledger authority before its local receipt is removed.

Second, the six-tier fair union previously applied its 1,000-document cap before relational eligibility.
High-scoring stale managed generations could therefore consume a tier's quota, get rejected afterward,
and hide lower-scoring current evidence from the reranker. Tenant visibility, committed-receipt validity,
and transcript-rights generation now filter each tier before quota allocation. Raw, visible, and
receipt-eligible counts remain attached to the in-memory pool for degraded-state telemetry, including
multi-query fusion. Multi-query RRF also retains provider-tier identity and applies a final fair 1,000-record
cap instead of truncating the fused rerank pool back to the single-query fetch count. Saturated regressions
supply 900 stale plus 100 current private records and 1,000
shared records; Voyage receives all 100 current private records, 900 shared records, and no stale record.
Another fans out two queries over 150 private plus 150 shared records and proves Voyage receives all 300.

Final hostile review then found that the eligibility pass could send the legal six-tier maximum of
60,000 vector IDs through one SQLite `IN (...)` receipt query. That exceeds SQLite's host-parameter
ceiling on common builds; the catch path would then reject all managed candidates. Receipt lookup now
deduplicates and batches IDs in groups of 900, leaving room for point-in-time binds under SQLite's
portable 999-variable ceiling. A real temporary-SQLite regression places the only committed match last
in a 60,000-ID pool and proves it survives all batches.

Files changed in this round: `src/lib/socratic-memory.ts`, `src/lib/vector-db.ts`,
`src/lib/db-vector-commits.ts`,
`src/lib/web-sources/fmp-transcripts.ts`,
`test/socratic-db.test.ts`, `test/fmp-rights-derived-artifacts.test.ts`,
`test/vector-db-scope.test.ts`, `test/vector-db-document-receipts.test.ts`,
`test/socratic-memory.test.ts`, `test/outcome-engine.test.ts`, `STATUS.md`, `PLAN.md`,
`docs/phase-9-web-sources.md`, both effort logs, and this rollout note.

Focused verification (Node 24, mocked providers and temporary SQLite only):

```bash
PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run \
  test/socratic-db.test.ts test/fmp-rights-derived-artifacts.test.ts \
  test/vector-db-scope.test.ts test/vector-db-document-receipts.test.ts \
  test/outcome-engine.test.ts test/rag-multi-query-retrieval.test.ts
PATH=/opt/homebrew/opt/node@24/bin:$PATH npx tsc --noEmit
git diff --check
```

Results: 6 files / 72 tests green; TypeScript and diff-check clean. Final hostile re-review and the
ordered full repository gate remain. No provider, corpus, configuration, or production mutation ran.

The first ordered repository run then passed lint (0 errors / 480 inherited warnings), TypeScript,
and 379 files / 4,362 tests before the production build rejected transitive `node:crypto` and
`node:timers/promises` imports. Licensed Socratic-memory IDs now use Web Crypto SHA-256 and global
`randomUUID`; document construction accepts that awaited immutable ID only when paired with the exact
rights generation. Erasure stability backoff reuses the module's existing abort-aware `retryPause`
instead of Node's timers/promises module. The deterministic SHA-256 fixture, adjacent decision/rights
tests (3 files / 20 tests), TypeScript, and a production build with the real TypeScript phase plus all
32 static pages pass. The ordered full gate must restart after this code change.

### Round-22 current-main PR landing

After PR #1607 merged shared package v1.7.1 to `origin/main@58de276e`, this branch was already
reconciled with current main but the remote PR head remained stale and draft. The doc-type coverage
strategy integration test also needed to mirror the new vector authority contract used by
`indexSocraticDecisionMemory`: it now pins deterministic encryption, provides provider and ledger authority,
supplies the required proposal regime field, and gives the six heavy strategy integration cases 75s timeouts.
The focused file passes 15/15 on Node 24.

The Infisical signal-forwarding test was also failing deterministically after the bootstrap hardening landed
because that fixture had no explicit fake app identity/login path. It now supplies a fake universal-auth pair,
fake project, and fake login token, keeping the test focused on runner-to-wrapper signal forwarding. The focused
Infisical bootstrap file passes 37/37 on Node 24.

Added `docs/BRANCH-INTEGRATION-LEDGER.md` with branch/PR dispositions for the current consolidation so future
agents do not re-inventory stale or overlapping branches.

### Round-23 rights-gate review fixes

A focused read-only review of the current-main landing tree found three pre-merge rights-boundary defects.
Raw transcript retrieval could be re-enabled by the environment flag even if the durable
`fmp_transcript_rights_gate` remained revoked; retrieval now requires both the env confirmation and an active
durable generation. FMP-derived Socratic-memory writes store a `document_chunks` dedup receipt keyed by their
deterministic private vector ID; the rights inventory now includes those hashes and the verified purge deletes
them once provider absence is proven. Finally, transcript-rights purge now blocks only transcript-associated
Pinecone upsert operations (`upsert fmp transcript vectors`, `commit fmp transcript vectors`, and
`upsert fmp-derived private memory`) instead of every unrelated app-wide Pinecone upsert.

Verification:

```bash
PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run \
  test/vector-db-retrieval.test.ts test/fmp-rights-derived-artifacts.test.ts --reporter=dot
```

Results: 2 files / 31 tests green. No transcript flag, FMP request, live Pinecone call, corpus mutation,
Infisical mutation, merge, or production action ran in this step.

### Round-24 focused suite-load and strategy compatibility fixes

The current-main landing tree exposed two more test-contract drifts before a clean repository gate:
strategy/regime integration fixtures were still assuming the first OpenAI call was always Green, while
the current strategy runner can ask Red Team first; and the heavier strategy cases needed explicit
timeout headroom under parallel full-suite load. The mocks now detect Red Team review prompts, return an
approval payload for those calls, expose the current vector provider/ledger authority contract, and keep
the bull-prompt assertions tied to the actual Green request body. The drawdown-flip and regime suites
now pass together at 23/23 on Node 24.

The Infisical signal-forwarding regression also needed full-suite timing margin after the fake
universal-auth path was added. The fixture keeps its own fake app identity/project/login token and now
waits long enough for the wrapped runner's ready and termination markers under repository-wide load. The
focused Infisical bootstrap suite remains green at 37/37.

Additional verification completed before restarting the ordered full gate:

```bash
PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run \
  test/regime-severity.test.ts test/strategy-moneypath-drawdown-flip.test.ts --reporter=dot
PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run test/infisical-bootstrap.test.ts --reporter=dot
PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run lint
PATH=/opt/homebrew/opt/node@24/bin:$PATH npx tsc --noEmit
```

Results: regime/drawdown 2 files / 23 tests green; Infisical 37/37 green; lint exits 0 with inherited
warnings only; TypeScript is clean. The full repository `npm test` was restarted after these local fixes.

Later landing attempts hit host-level contention rather than assertion failures. A clean full `npm test`
run emitted no additional assertion summary but ended with SIGTERM 143 after long execution; a grouped
changed-suite run also ended 143 while the same files continued to pass individually. Multiple
`npm run build` attempts, including `NEXT_PRIVATE_BUILD_WORKER=1 NODE_OPTIONS=--max-old-space-size=4096`,
were OS-killed with 137 while other agent build/test processes respawned on the same workstation. Those
137/143 exits are recorded as local host-pressure blockers; hosted GitHub `verify` must be treated as the
authoritative full lint/test/build gate for the pushed PR head.

### Round-25 import-cycle cleanup and FMP rights hook headroom

The serialized full-suite diagnostic also exposed a test-time warning from Socratic lifecycle re-indexing:
`Cannot access 'FMP_TRANSCRIPT_SOURCE' before initialization`. `src/lib/web-sources/fmp-transcripts.ts`
now imports the exact owning DB modules (`db-api-keys`, `db-provider-dispatch`, `db-learning`,
`db-settings`, and `db-vector-commits`) instead of the broad `db` barrel. The RAG doc-type focused test
still passes 15/15 and the FMP TDZ warning no longer appears.

The migration-heavy FMP rights-derived artifact suite timed out in its `beforeAll` hook under host load
while applying 41 migrations. Its setup timeout is now 120s, and the focused file passes 10/10.

Verification:

```bash
PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run test/rag-doc-type-coverage.test.ts --reporter=dot
PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run test/fmp-rights-derived-artifacts.test.ts --reporter=dot
PATH=/opt/homebrew/opt/node@24/bin:$PATH npx tsc --noEmit
```

Results: RAG doc-type 15/15 green with no FMP TDZ warning; FMP rights-derived artifacts 10/10 green;
standalone TypeScript clean. Canonical local lint/full-test/build attempts remain blocked by host
SIGTERM/kill pressure, so PR publication still waits on a clean pushed/hosted gate or a quieter local
machine window.

### Round-26 hosted gitleaks false-positive suppression

Hosted PR #1586 gitleaks failed on the historical deterministic `ENCRYPTION_KEY` fixture introduced in
branch commit `dd63ba35`. The current tree already uses `"0".repeat(64)`, but gitleaks scans the
first-parent branch history, so the historical placeholder literal still needs an explicit false-positive
fingerprint. `.gitleaksignore` now records:

```text
dd63ba35cbd5023f3571992380454dad22225536:test/rag-doc-type-coverage.test.ts:generic-api-key:55
```

This is a branch-local fake test fixture, not a real secret. The next normal branch push should rerun
hosted gitleaks without rewriting PR history.

### Round-27 hosted vector chunk-cap fixture repair

Hosted verify then failed one test in `test/vector-db-chunk-cap.test.ts`: the product retrieval path now
requires an active durable transcript-rights generation before returning FMP transcript records, but this
isolated vector mock still returned only `{ ok: 1 }` for every DB query. The mock now returns
`{ generation: 1, status: "active" }` for `fmp_transcript_rights_gate` queries and supplies basic `all`
and `run` seams needed by current authority helpers.

Verification:

```bash
PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run test/vector-db-chunk-cap.test.ts --reporter=dot
```

Result: 1 file / 14 tests green.

No transcript flag, FMP request, corpus/vector provider write, Infisical mutation, merge, or
production action ran in this step. The remaining release path is the ordered Node 24 lint,
hosted TypeScript/full test/build gate, ready PR #1586, protected merge, and exact production verification.

The highest-yield 1,000-stock operational plan remains “archive broadly, embed selectively”: exact
1,000-CIK manifest plus private priority overlay; historical submissions-shard discovery; immutable raw
archive; structured XBRL/fundamentals; embedded 10-K/10-Q decision sections and material 8-K exhibits;
entitled transcripts only; CIK/accession checkpoints; and gated 10 -> 25 -> 100 -> 300 -> 1,000 waves.
Crash repair must not page an exact-set commit reconciliation across page boundaries: use a provider-page
ghost sweep plus a local keyset whole-commit verifier, preserving existing PIT intervals and heads. No
backfill is authorized until the source, coverage, evaluation, cost, and reconciliation gates pass.

## Follow-ups / enablement blockers

- Upgrade to, or otherwise obtain, a plan that exposes both `/stable/earning-call-transcript-dates`
  and `/stable/earning-call-transcript`; current Starter probes return typed HTTP 402.
- Confirm the FMP agreement permits the intended transcript storage, embedding, internal retrieval,
  and any user-facing excerpt display.
- Only then set both `WEB_SOURCE_FMP_TRANSCRIPTS=on` and
  `FMP_TRANSCRIPT_STORAGE_RIGHTS_CONFIRMED=on` in the intended environment, beginning with a small
  request cap while monitoring provider-call and RAG cost events in usage.jays.services.
- This change does not deploy, enable the flag, call FMP, or mutate the production vector corpus.
- Add fixture-backed speaker/Q&A pairing, deterministic numeric extraction, cited derived briefs, and
  transcript retrieval evaluation after an entitled endpoint provides representative fixtures; the
  default-off first producer intentionally stores source-faithful raw chunks instead of guessing at
  provider formatting.
