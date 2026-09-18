# Current Status

## 2026-09-18 GROK — #3385 sqliteYieldRetry remainder (scheduler writes + synthetic-stop delete/audit)

#3383 is live (`2fc699c328`) and dropped serving `busy_timeout` to 100ms.  Three scheduler writes still ran synchronously: `scheduler:lastTick`, managed-vector lastAttempt/lastSuccess, and boot `setPolicy`.  A SQLITE_BUSY on lastTick after the short pin was counted as a health failure and could abdicate a live leader.  Boot halt shared one envelope between idempotent `setPolicy` and non-idempotent `audit`.  Three synthetic-stop plan-purge paths still mixed `deleteSyntheticStop` and `audit` in one `sqliteYieldRetry` callback, so a BUSY on audit could duplicate `synthetic_stop_purged_by_plan`.  Each write now has its own yield-retry envelope.  PR #3408, squash auto-merge armed.  Extra-ship no.  Stay out of `broker-protective-stops.ts`.  No Coolify Deploy.
Rollout: `docs/rollouts/2026-09-18-3385-sqlite-yield-remainder.md`.

## 2026-09-18 CLAUDE — Post-cancel protective-stop bookkeeping after the #3383 pin (money path)

`#3383` dropped the serving `busy_timeout` 60000ms -> 100ms, so a sync SQLite write that used to
WAIT now THROWS.  `#3386` repaired that class in `synthetic-stops.ts`; `broker-protective-stops.ts`
was never converted.  In `cancelBrokerProtectiveStop` the post-cancel delete sat inside the broker
`try`, so a `SQLITE_BUSY` audited a SUCCESSFUL cancel as `broker_protective_stop_cancel_error` and
re-persisted `pending_cancel` for an order already gone at the broker.  Broker call and bookkeeping
are now split; bookkeeping goes through `sqliteYieldRetry`.  Failing-first proven.  **Money path —
do NOT auto-merge, needs a human read.**  Extra-ship no.  No Coolify Deploy.
Rollout: `docs/rollouts/2026-09-18-protective-stop-post-cancel-sqlite-busy.md`.
## 2026-09-18 CLAUDE — Public trading-liveness reports the cause (board 64413d84)

`/api/health` said `degraded: 1` without saying why, so a JSON-path monitor could not separate a
failing autopilot account from out-of-session silence.  Added identity-free
`maxConsecutiveFailedRuns` and `degradedReasons` to `PublicTradingLiveness`.  The session-calendar
half of the row was already on `main` and was verified, not re-implemented.  Degradation thresholds
are unchanged, so no alert starts or stops firing.  Extra-ship no.  No Coolify Deploy.
Rollout: `docs/rollouts/2026-09-18-liveness-degradation-cause-fields.md`.

## 2026-09-18 CURSOR — iOS TestFlight Automatic vs Distribution signing (PR pending)

`ios-ship` rc=65 after #3399: Automatic signing conflicted with manual `Apple Distribution` in
Release + `ship-testflight.sh`.  Reverted to Congress.Trade pattern (Automatic only; no archive
identity override).  Branch `fix/ios-tf-automatic-vs-distribution-signing`.  Extra-ship no.
Rollout: `docs/rollouts/2026-09-18-ios-tf-automatic-vs-distribution-signing.md`.

## 2026-09-18 GROK — Datadog remaining: ST RUM stay dark + DD_HOSTNAME (board f03c5542)

Infrastructure Free us5.  Trial expired 2026-09-07.  RUM hourly usage is empty.  The existing `Socratic Trade` RUM app stays `is_active=false` on purpose — do not mint a second app and do not start send.  Infisical now has `DD_RUM_ENABLED=false` and `DD_HOSTNAME=fleet-hetzner-nbg1`.  Preload sets the host tag on Coolify only; dd-trace `init({ hostname })` is the Agent address.  Extra-ship no.  Sentry stays the app error path.
Rollout: `docs/rollouts/2026-09-18-datadog-free-remaining.md`.
## 2026-09-18 GROK — MM AG takeover #3379 theme CI (board 6aa1e66e)

Hosted tsc failed on `@/app/ui/theme` (alias is `src/*`).  Relative import from console chrome/ticker-logo.  Default stays light.  Extra-ship no.  No Coolify Deploy.
Rollout: `docs/rollouts/2026-09-18-ag-takeover-theme-ci.md`.

## 2026-09-18 CURSOR — Effort Issues Sync Crons margin (FLEET-INFRA-C0)

Sentry `ci-effort-issues-sync` false-pages every day at 06:27Z.  The board-mirror job itself succeeds on `ubuntu-latest` in ~12-30s; GitHub just starts the `12 6 * * *` schedule 5-6.5h late (typical 11:12-11:44Z, worst retained 2026-09-14 12:37Z).  Same class as #3194 / FLEET-INFRA-C1, #3387 / FLEET-INFRA-C3, and #3389 / FLEET-INFRA-BY.  Raise `CHECKIN_MARGIN_OVERRIDES["Effort Issues Sync"]` to 600.  Cron and sync script unchanged.  Extra-ship no.  No Coolify Deploy.  Do not `workflow_dispatch` the sync.  #3302 already moved the live slug to `ci-socratic-trade-effort-issues-sync`; do not close C0 on merge.
Rollout: `docs/rollouts/2026-09-18-effort-issues-sync-monitor-margin.md`.
## 2026-09-18 GROK — MM AG takeover #3378 admin CI (board 6aa1e66e)

Hosted verify failed on operator wiring + copy-rules, not lucide-react.  Point the backtest-ic marker at `admin-shell.tsx`, gap the CPU caveat title, show the active admin nav label.  Continue `mm/ag-takeover-eb883289`.  Extra-ship no.  No Coolify Deploy.
Rollout: `docs/rollouts/2026-09-18-ag-takeover-admin-ci.md`.

## 2026-09-18 CURSOR — Cleanup Actions Caches Crons margin (FLEET-INFRA-BY)

Sentry `ci-cleanup-actions-caches` false-pages every day at 03:20Z.  The prune job itself succeeds on `ubuntu-latest` in ~12s; GitHub just starts the `5 3 * * *` schedule 4.5-7h late (typical 07:35-08:48Z, worst retained 2026-08-29 09:57Z).  Same class as #3194 / FLEET-INFRA-C1 and #3387 / FLEET-INFRA-C3.  Raise `CHECKIN_MARGIN_OVERRIDES["Cleanup Actions Caches"]` to 600.  Cron and prune script unchanged.  Extra-ship no.  No Coolify Deploy.  Do not `workflow_dispatch` the cleanup.  #3302 already moved the live slug to `ci-socratic-trade-cleanup-actions-caches`; do not close BY on merge.
Rollout: `docs/rollouts/2026-09-18-cleanup-actions-caches-monitor-margin.md`.

## 2026-09-17 CURSOR — RTH Deploy Latch Crons margin (FLEET-INFRA-C3)

Sentry `ci-rth-deploy-latch` false-pages every weekday at 21:35Z.  The drain job itself succeeds; GitHub just starts the `20 21 * * 1-5` schedule 2-8h late (typical 23:14-23:54Z).  Same class as #3194 / FLEET-INFRA-C1.  Raise `CHECKIN_MARGIN_OVERRIDES["RTH Deploy Latch"]` to 600.  Cron and drain script unchanged.  Extra-ship no.  No Coolify Deploy.  Do not `workflow_dispatch` the latch (that nudges Coolify).  #3302 already moved the live slug to `ci-socratic-trade-rth-deploy-latch`; do not close C3 on merge.
Rollout: `docs/rollouts/2026-09-17-rth-deploy-latch-monitor-margin.md`.

## 2026-09-17 CURSOR-BUGBOT — post-claim fire writes after #3383 pin

#3383 is live (`2fc699c328`).  Serving `busy_timeout` is 100ms.  After `claimSyntheticStop()`, `recordSyntheticStopAttempt` / `insertFillEvent` / `revertSyntheticStopClaim` stayed unwrapped and `recordSyntheticStopAttempt` was outside the place try/catch.  SQLITE_BUSY on that write leaves `triggered` with no `last_attempt_ref_id` until the 15-min re-arm grace — naked position after a real trigger.  Wrap each post-claim statement in `sqliteYieldRetry` and move the attempt record inside the try so a throw reverts.  Extra-ship no.  No Coolify Deploy.
Rollout: `docs/rollouts/2026-09-17-post-claim-sqlite-busy-fire.md`.

## 2026-09-17 GROK — PR #3383 tip-fix: fake timers vs yieldEventLoop (board e7b49943)

Hosted `verify` on #3383 timed out (`test/synthetic-stops.test.ts` and sibling reprice files at 60s/30s).  Cause: `runSyntheticStopMonitor` now `await yieldEventLoop()` (`setImmediate`), and those tests used full `vi.useFakeTimers()` which never flushes it.  Tests now fake `Date` only; `isSqliteBusy` does not retry a stamped non-BUSY sqlite code.  Pin+yield production behavior unchanged.  Extra-ship no.  No Coolify Deploy.
Rollout: `docs/rollouts/2026-09-17-sqlite-busy-event-loop-pin.md`.

## 2026-09-17 GROK — SQLITE_BUSY event-loop pin+yield (board e7b49943)

ST production stalls ~every 30 minutes: Traefik 503 on `/api/health` while Docker still says healthy.  Docker restart recovers briefly; Coolify Deploy is not the recovery.  WIP lands as-is on `grok/rth-event-loop-stall` (worktree `~/apps/trading-grok-rth-stall`): serving `busy_timeout` is a 100ms pin; async callers keep the 60s lock budget via `sqliteYieldRetry`; safety lanes yield; RTH RAG ingest defers.  Extra-ship no.  No Coolify Deploy.  Do not restart production from this lane.
Rollout: `docs/rollouts/2026-09-17-sqlite-busy-event-loop-pin.md`.

## 2026-09-15 GROK — PR #3283 observability review threads

Merged origin/main (phantom).  Sentry gen_ai usage is parsed from a cloned body while the span is open; span handle is request-scoped via AsyncLocalStorage.  Red Team JSON catch rethrows abort/transport.  PLAN.md records the implementation.  Merge is live — no Coolify Deploy.
Rollout: `docs/rollouts/2026-09-13-issue-3222-llm-observability-resilience.md`.
## 2026-09-15 GROK — PR #3284 Qdrant fuse review P1s

Merged origin/main (phantom).  Budget/capacity now use the caller userId, skip the pending→committed promotion, and `storeContexts` gates before embed.  FTS cache key includes task id.  Merge is live — no Coolify Deploy.
Rollout: `docs/rollouts/2026-09-13-issue-3223-qdrant-fuses-fts-optimization.md`.
## 2026-09-15 GROK — PR #3282 land-sweep (review threads + health-buffer CI)

Unstuck #3282 against `origin/main` (real conflict only in `instrumentation.ts`, took main's Sentry profiling import).  Codex P1s: watchdog abort no longer rethrows from `tick()` (pre-leader `throwIfAborted` used to become an unhandled rejection); manual cancel tears down any open brackets on the symbol; `getLaneHealth` no longer sync-flushes the health buffer (reads merge pending rows; failed flushes are restored); Tradier listing keeps a tagged container when `side` is omitted; Alpaca MCP-only bracket teardown throws so the pending row is not deleted as success.  Vitest flushes the health buffer immediately so table assertions stay honest.  Merge is live — no Coolify Deploy.  Worktree `~/apps/trading-grok-land-sweep`.
Rollout: `docs/rollouts/2026-09-12-issue-3221-event-loop-stalls.md`.

## 2026-09-13 ANTIGRAVITY — PR #3282 (Issue #3221: Event-loop stalls, Watchdog AbortController, isTradingDay timezone)

Addressed Issue #3221 via PR #3282 (auto-merge enabled):
1. **Buffered \`api_health_log\`**: Buffered outbound API health writes in memory with a 5-second flush window (or 50 items) and made retention-pruning conditional on \`COUNT(*) > HEALTH_LOG_LANE_CAP\`, eliminating synchronous SQLite main-thread locking. Reads in \`getLaneHealth\` and \`listHealthLanes\` flush pending rows for guaranteed consistency.
2. **Scheduler Watchdog \`AbortController\`**: Attached an \`AbortController\` pipeline (\`__tickAbortController\`) to \`tickGuardHost\` so \`runSchedulerTickWatchdog()\` unwedges hung ticks by aborting active work before subsequent ticks launch.
3. **\`market-hours.ts\` ET Timezone**: Replaced local-server UTC date accessors with explicit \`America/New_York\` formatting so Friday late trading sessions do not get misclassified as Saturday weekend days.
4. **Optimized \`hasLiveStrategyRunLease\`**: Swapped the full-table-scanning \`LIKE\` clause for an index-bounded range query (\`key >= ? AND key < ?;\`), leveraging SQLite index \`sqlite_autoindex_settings_1\`.
5. **Defensive Bracket Teardown**: Refined \`order-cancel.ts\` to verify that a cancelled order belongs to open brackets before triggering teardown of sibling legs.
Rollout: \`docs/rollouts/2026-09-12-issue-3221-event-loop-stalls.md\`.

## 2026-09-12 ANTIGRAVITY — PR #3230 (Issue #3220: Tradier bracket orders & cancellation fixes — MERGED)

Merged PR #3230 to address Issue #3220:
1. Emits primary entry order alongside bracket exit legs in \`getEquityOrders\` mapping while stripping the \`tag\` on exit legs to avoid false-positive error matching.
2. Flagged \`TradierBrokerGateway\` with \`ordersListIncludesTerminal = true\` to prevent \`uncertain\` order wedging in \`reconcilePlacementError\`.
3. Translated Tradier HTTP 200 validation envelopes as terminal errors.
4. Audited Alpaca MCP bracket sibling cancellations when REST credentials are not provided.
5. Triggered teardown of sibling bracket legs upon manual cancellation.
Rollout: \`docs/rollouts/2026-09-12-issue-3220-tradier-broker-fixes.md\`.
## 2026-09-15 GROK — PR #3296 401 JSON still redirects

Sentry thread on `use-live-scan.ts`: `readErrorMessage` parsed JSON before the 401 check, so a JSON 401 body would skip `redirectToLogin()`.  Status is checked first now.  Merge is live — no Coolify Deploy.
Rollout: `docs/rollouts/2026-09-14-issue-3225-console-singleflight-deadline-retry.md`.

## 2026-09-13 ANTIGRAVITY — API Security Hardening: Open Redirect Sanitization, Public Auth Rate Limiting & Defensive JSON Parsing (Issue #3224)

Hardened web and mobile API endpoints against open redirects, denial-of-service, and error leakage.  Implemented `sanitizeCallbackUrl` in `src/lib/auth/callback-url.ts` and wired into `app/login/page.tsx`, rejecting protocol-relative (`//evil.com`) and cross-origin targets.  Added strict `redirect` callback in NextAuth (`src/lib/auth/auth.ts`).  Enforced IP-based rate limiting on public mobile auth routes (`/api/mobile/auth/apple` and `/api/mobile/auth/exchange`) and bounded exchange request bodies with `APPLE_AUTH_MAX_BYTES` (returning HTTP 413 on overflow).  Added `RATE_LIMITS.orders` rate limiting to `POST /api/proposals/from-draft`.  Defensively caught JSON parse errors across `/api/orders/cancel`, `/api/profiles`, and `/api/consent`, returning HTTP 400 instead of unhandled 500 crashes.  Sanitized error reflections in `/api/chat` using `safeErrorMessage` to redact sensitive credentials.  Verified gate: `npm run lint` (0 errors), `npx tsc --noEmit` (clean), and 19 vitest tests passing.
Rollout: `docs/rollouts/2026-09-13-issue-3224-api-security-hardening.md`.
## 2026-09-13 ANTIGRAVITY — Datadog LLMObs duplicate invocation fix, Red Team failover resilience & Sentry GenAI token metrics (Issue #3222)

Resolved issue #3222: decoupled `llmobs.wrap` tracer setup from execution in `withDatadogLlmObs` so errors do not retry `fn()` and double-bill LLM providers; added safe JSON parsing to `red-team.ts` so HTML proxy responses fail over cleanly to candidate fallback reviewers instead of failing closed immediately; annotated HTTP error status codes on Datadog and Sentry GenAI spans; intercepted `response.json()` to capture `gen_ai.usage.input_tokens` and `gen_ai.usage.output_tokens` directly before span finalization; added Moonshot to LLM host hints; resolved `@sentry/profiling-node` import in Next.js instrumentation. Verified with lint (0 errors), tsc (0 errors), and vitest (16 passed).
Rollout: `docs/rollouts/2026-09-13-issue-3222-llm-observability-resilience.md`.
## 2026-09-13 ANTIGRAVITY — Qdrant Write Spend Fuses, Distance Metric Assertions & SEC FTS Ingest Worker (Issue #3223)

Implemented backend-neutral daily ingestion point budget tracking in `rag-metering.ts` (default: 50k points/24h) and Qdrant collection point capacity breakers (`QDRANT_MAX_POINTS` / `RAG_QDRANT_MAX_POINTS`) in `qdrant-write.ts` to prevent runaway disk saturation.  Added `assertQdrantCollectionMetric` on Qdrant retrieval paths to validate `Cosine` distance metric configurations and record audit events on mismatches.  Exported `HttpProviderError` preserving response status code and headers during embedding rate limits so `retryAfterMs` can inspect and honor `Retry-After` headers.  Eliminated redundant SEC filing disk reads and JSON parsing by adding in-memory chunk caching in `sec-ingest-worker.ts`, and made FTS chunk mirror limits configurable.  Verified gate: `npm run lint` (0 errors), `npx tsc --noEmit` (clean), and all 73 vitest tests green.
Rollout: `docs/rollouts/2026-09-13-issue-3223-qdrant-fuses-fts-optimization.md`.
## 2026-09-13 FX — same-repo pull_request auto-merge

`auto-merge-prs.yml` and `auto-merge-shared-dependency.yml` no longer use `pull_request_target`.  Forks are skipped.  Branch `fx/automerge-fork-guard`.

## 2026-09-12 ANTIGRAVITY — Comprehensive Full-Stack Audit & System Diagnostics

Executed an exhaustive, multi-subagent audit across the entire codebase covering Trading Execution & Persistence, Security & API Routes, AI Strategy & Vector Retrieval, and Web Console & iOS Client.  Identified 3 Critical trading bugs (Tradier bracket entry dropping in `equityRowsFromTradierOrder`, missing `ordersListIncludesTerminal` on Tradier, and HTTP 200 rejection envelope misclassification), 2 Critical console bugs (duplicate strategy runs from mounted desktop/mobile `RunOnceButton` listeners and an un-backed-off deadline retry spin loop), 2 Critical AI engine bugs (`withDatadogLlmObs` duplicate execution on failure, and Red Team unhandled JSON parse failure aborting fallback models), plus over 15 High/Medium vulnerabilities, storage bloat drivers, and event-loop stall sources.  Logged and triaged all findings into 8 dedicated GitHub issues (#3220–#3227) with detailed reproduction mechanics and remediation steps.  Effort logs updated on both branch-neutral live board (`/Users/jay/apps/TRADING-EFFORT-LOG.md`) and repo mirror (`docs/EFFORT-LOG.md`).
Rollout: `docs/rollouts/2026-09-12-codebase-full-audit.md`.

## 2026-09-10 GROK — PR #3208 fixer tip (tini PID1 / HEALTHCHECK curl self-timeout)

Codex P1 on `fixer/healthcheck-no-zombies` (board `e7b49943`).  STATUS/PLAN now record
the production-image approach: runtime `tini` as PID1 (`ENTRYPOINT ["tini", "--"]`) so
Docker HEALTHCHECK children are reaped; keep main's `--timeout=15s --retries=5` (PR #3201)
and add `curl --max-time 14 --connect-timeout 2` so curl exits itself before Docker's
15s SIGKILL.  Probe stays `GET /api/live` (never `/api/health`).  `infisical-run` (Node)
does not `wait()` hung curls, which piled up as zombies (CPU 105%, Traefik 503).  Rollout
completed with mandated Next Steps & Blockers plus exact CI receipts (`verify` /
`verify-hosted` pass on PR head `b4259ec57`, run `34508795886`).  Dockerfile-only; no
weekday image build.  Deployer squash AM after cash close / non-RTH; this lane does not
merge.  Extra-ship no.  FTS hang is separate #3202.
Rollout: `docs/rollouts/2026-09-09-healthcheck-tini-reap.md`.

## 2026-09-09 GROK — PR #3194 fixer tip (deploy-freshness monitor margin handoff)

Codex P1 on `claude/fix-deploy-freshness-monitor-margin`.  STATUS/PLAN/rollout
handoff + mandated rollout sections + honest Python-only verification
(`python3 -m py_compile scripts/sentry-ci-report.py` clean; full lint/tsc/test/build
N/A for pure monitor-config/docs; hosted `verify-hosted` remains the JS gate) +
two-space prose in new comments/rollout.  Tip commit uses Jay for author and
committer.  Deployer squash AM stays armed; this lane does not merge.  Extra-ship no.
Rollout: `docs/rollouts/2026-09-08-ci-deploy-freshness-monitor-margin.md`.

## 2026-09-09 GROK — PR #3201 fixer tip (verification receipts + 15s HEALTHCHECK refs)
## 2026-09-09 GROK — PR #3203 fixer tip (75% stall bar + skipped late logging + full verify)

Codex P1+P2 on `claude/broker-timeout-safety-monitors`.  STATUS.md and `docs/EFFORT-LOG.md` now
match `LANE_STALL_ATTRIBUTION_RATIO=0.75` (were still saying 25%).  `journalLane` preserves a
skipped envelope with no value, and `withLaneDeadline` late-logs `SKIPPED LATE` instead of
claiming the protective pass completed.  Full AGENTS.md gate recorded in the rollout.
Deployer squash AM stays armed; this lane does not merge.  Extra-ship no.

## 2026-09-09 CLAUDE — Safety-lane "broker timeout" is event-loop starvation, not the broker

Codex P1+P2 on `claude/healthcheck-tolerate-eventloop-stall`.  Remaining 5s HEALTHCHECK timeout
references in `Dockerfile`, `app/api/live/route.ts`, and `docs/deployment.md` now match the live
15s directive (historical 5s incident numbers stay).  Full AGENTS.md gate recorded in
`docs/rollouts/2026-09-09-healthcheck-eventloop-tolerance.md`.  Deployer squash AM stays armed;
this lane does not merge.  Extra-ship no.

Root cause is the non-convergent FTS mirror loop in **PR #3202**, not this lane: total ms over deadline rose
**28.6x** (120,110 → 3,430,064) and the tail **7.4x** (25,088 → 185,633 ms) from 09-07 to 09-08, the exact day
event-loop pinning jumped to 1,317,546 ms/day, while ingest run counts did not rise and slow ingest runs fell.
The SQLite lock-contention hypothesis was tested and refuted here: only 14.2 % of timeouts had a
`database is locked` event within 15 s, and at 300 s the co-occurrence was *below* chance.

This branch ships **no competing fix** — only the observability gap that remains regardless: `withDeadline`
could not distinguish "the broker did not answer" from "we could not process the answer", which is what sent
PR #3189 after Tradier retries that could not help (57 of 71 and 53 of 66 occurrences landed *after* it merged).
New `src/lib/event-loop-lag.ts` sampler, `withLaneDeadline` attribution, and an `event_loop_stall` failure
category.  **No safety monitor was weakened:** deadline unchanged at 15,000 ms, no interval lengthened, work
still never cancelled, failures still recorded and still escalating to `lane_degraded`; re-attribution needs
≥75 % measured stall (`LANE_STALL_ATTRIBUTION_RATIO=0.75`).  tsc clean, eslint 0 errors, 11/11 new tests, 50/50 related regression tests.
Rollout: `docs/rollouts/2026-09-09-safety-lane-stall-attribution.md`.
## 2026-09-09 CLAUDE — FTS mirror never converged, pinning the event loop into a public 503

`/api/live` measured from inside the Docker network at **8.60s, then 0.09s, then 0.03s** —
all HTTP 200 — while `/api/health` took **8.41s** against 0.43s on 09-07.  The container
healthcheck (5s timeout, 3 retries) timed out repeatedly, Docker marked the container
`unhealthy` (`FailingStreak: 5`) and Traefik pulled a healthy container out of rotation.
App internals were fine throughout (`db: ok`, scheduler age 60s, streams authenticated,
Litestream replicating).  Container CPU 107% with host disk `%util 0.10`, so the process was
CPU-bound in-process, not IO-bound.

Root cause: `mirrorFtsChunksBounded` resumed from `countDocumentChunkFts()` — a `COUNT(*)`
of `document_chunks_fts_index` — and used that count as a POSITIONAL offset into the chunk
array.  The index PK leads with `content_hash`, so byte-identical chunks inside one filing
collapse to one row; from the first duplicate the count trails the position permanently and
the same slice is re-mirrored on every ingest tick forever.  `better-sqlite3` is
synchronous, so every pass held the serving loop.  Production proof across six days:
`hsy-20260329.htm` restarted at offset **400/508 on all 29 logged slices** (one pinned
**36,511 ms**), `hsy-20251231.htm` at 732/1291, `abnb-20260630.htm` at 355/448,
`dash-20250630.htm` at 358 across 58 slices — and reading production `app.db` read-only,
`countDocumentChunkFts` returns exactly 400, 732 and 355 for those occurrences.  Because
`mirror.complete` never became true, `insertIngestedAccession` never ran and the worker
re-queued the same filings forever.  09-08 alone: **198 slices, 1,317,546 ms — 22 minutes —
of pinned event loop**, against 239,114 ms on 09-07.  This is a regression by accumulation,
not by commit: every document that hits a duplicate joins a set retried forever.

Second defect on the same path: `countDocumentChunkFts` filters on
`(symbol, source, accession)` but the only index leads with `content_hash`, so it ran
`SCAN document_chunks_fts_index USING COVERING INDEX` — **78–105 ms** per call, measured on
production's 689,047 rows, once per document per tick.

Fix: `ftsMirrorResumeOffset()` resumes on CONTENT (first row whose hash is not yet indexed),
which makes progress provably monotonic and the loop terminating; plus migration 88 adding
`idx_document_chunks_fts_index_occurrence`.  A side-index key alone is not accepted as proof
of mirroring — each key is JOINed to its live FTS row and kept only when `fts_rowid` still
owns all four identity columns, so a stale key (an explicitly supported state, since FTS5
reuses the max rowid after a DELETE) cannot mask absent content and silently ledger a filing
with text that was never indexed.  That was a P2 from `chatgpt-codex-connector` on PR #3202,
evaluated as real and fixed rather than waved through; the regression test fails without it.
Measured at production scale: **105.26 ms → 3.04 ms median, 34.6x**, plan `SCAN` → `SEARCH`.  Ruled out with evidence:
the `storeContexts` 870/870 dedup (indexed, 2–4 ms), PR #3192 (lane averages 13 ms), a heavy
`/api/health` (re-measured at 45 ms), and SQLite lock contention (zero `database is locked`
events during the measured stall burst; 09-07 had *more* lock events than 09-08 yet 5.5x
less pinning; and a busy-wait sleeps rather than burning the 107% CPU observed).  No timeout
widened — that shipped separately in PR #3201.  Rollout:
`docs/rollouts/2026-09-09-fts-mirror-nonconvergence.md`.
## 2026-09-09 GROK — PR #3204 fixer tip (multipart retry, drill cleanup, fail-closed counts)

Codex P1+P2 on `claude/backup-methodology`.  CompleteMultipartUpload 200+`<Error>` bodies now
retry inside `withS3Retry`.  The Litestream restore drill installs an EXIT cleanup trap and
no longer pipes `integrity_check` through `head`.  Unreadable live `COUNT(*)` (null) fails
closed as `snapshot_live_count_unreadable`.  Full AGENTS.md gate recorded in the rollout.
Deployer squash AM stays armed; this lane does not merge.  Extra-ship no.

## 2026-09-09 CLAUDE — Backup methodology: policy, archive depth, whole-attempt bounds, proven restore

Branch `claude/backup-methodology`, worktree `~/apps/trading-claude-backup`.  Rollout:
`docs/rollouts/2026-09-09-backup-methodology.md`.  Policy: **`docs/backup-policy.md`** (new,
canonical).

**Verified live 2026-09-09, not carried forward.**

- **Tier 1, Litestream to Backblaze B2 — HEALTHY.**  `litestreamStatus: replicating`,
  `litestreamDegradedReasons: []`, tier 0 `ageSeconds: 1`.  `rclone size`:
  `trading-live/` 5,910 objects / 56.343 GiB; bucket total 5,918 / 90.579 GiB.  **Correction:
  the PITR window is 7 days, not 30** — `retention: 720h` is in `litestream.yml`, a local-dev
  file pointing at a Mac path that exists on no current machine; production is
  `litestream.coolify.yml`, `retention: 168h`.
- **Tier 3, weekly cold archive to R2 — STILL NOT ADVANCING.**  `objectCount = 1`,
  `payloadSize = 9,679,310,848`, sole key `cold-snapshots/app-2026-08-30.db`, `r2Weekly.ok
  = false`, `ageSeconds = 902823`.  #3192 fixed the snapshot step and thereby exposed the next
  fault: the first run under it (2026-09-08T15:36Z) finished the snapshot and died in the
  **upload** after 670 s with a bare `fetch failed`; `week-2026-09-06` then hit `attempts = 31`
  and went terminally `unresolvable`.  Three defects: the deadline covered only the snapshot
  step, a single transient failure discarded the whole attempt, and `err.message` recorded
  nothing classifiable because Node's `fetch` hides the reason in `error.cause`.
- **Tier 2, host-side 6-hourly dumps — BROKEN, and not in this repo.**  Not in the brief; it
  exists and it is down.  `/data/backups/socratic/` holds one dump
  (`socratic-app-20260906T121501Z.db`, 10,607,546,368 bytes, finished 2026-09-07T11:59Z, ~23.7 h
  to write); every tick since logged `SKIP already running (lock held)`.  It uses
  `sqlite3 .backup` — **the same page-1 restart loop #3192 diagnosed one layer up** — and the
  hardened script installed 2026-09-08T03:24Z now bounds it at 30 minutes, so a ~24 h copy will
  be killed and deleted on every tick forever, silently.  `fleet-backup-verify-weekly.sh`
  already caught it on 2026-09-06 (`file is not a database (26)`) into a log nobody reads.
  Fix handed to the owner in `docs/backup-policy.md` §8.1.
- **Backblaze growth: the ~535 GB board figure is STALE.**  Re-measured: all three `hetzner/`
  prefixes together are **41.280 GiB** across 18 objects.  **No prune needed, none proposed.**
- **A restore had been tested once** — 2026-08-18, B2 to scratch, 4.9 GB
  (`docs/rollouts/2026-08-17-litestream-restore-drill.md`).  Manual, never repeated, and the DB
  has since more than doubled to 10.98 GB.  `scripts/litestream-restore-drill.sh` was unrunnable
  (Mac path, R2 instead of B2).

**Shipped.**  `docs/backup-policy.md`: four tiers with cadence/retention/RPO/RTO, why the
two-provider split exists, what is **not** covered (~17.1 GB of non-DB volume data, Infisical
`ENCRYPTION_KEY`, the buckets themselves, PITR beyond tier 1), verification cadences, alerting,
restore runbooks, owner decisions.  Cold archive: retain **1 → 4** and
`R2_COLD_SNAPSHOT_RETAIN` can now RAISE retention (it was clamped to `min(env, 1)`, write-only
downward) — which also means the legacy 9.68 GB object is simply kept, so no deletion approval
is needed; **pre-upload artifact verification** (`PRAGMA integrity_check` plus non-empty
assertions on `audit_events`, `trade_proposals`, `portfolio_snapshots`, `connected_accounts`,
`settings`, `llm_usage`, in both live and copy) that refuses to upload an unverified file;
**whole-attempt deadline** (`R2_COLD_SNAPSHOT_ATTEMPT_DEADLINE_MIN`, 90 min) threaded as an
`AbortSignal` so an over-deadline upload is aborted, not abandoned; bounded per-request retries;
`describeRequestError` cause-chain unwrapping.  New
`scripts/ops/verify-cold-snapshot-restore.mjs` (download, gunzip, integrity_check, row-count
assertions, receipt, discard; no DELETE path).  `scripts/litestream-restore-drill.sh` repointed
at production and B2 with a free-space precheck and a real non-zero exit on failure.

**RESTORE IS NOW PROVEN — a real round trip, not an inference.**  Ran
`scripts/ops/verify-cold-snapshot-restore.mjs` against production R2 on 2026-09-09:
`cold-snapshots/app-2026-08-30.db`, 9,679,310,848 bytes, downloaded in **127 s**, opened with
better-sqlite3, `PRAGMA integrity_check` = **`ok`**, and every key table populated —
`audit_events` 262,290, `trade_proposals` 803, `portfolio_snapshots` 1,755,
`connected_accounts` 7, `settings` 664, `llm_usage` 2,491.  Each trails the live counts
(360,059 / 831 / 1,877 / 7 / 937 / 2,989) exactly as a 2026-08-30 snapshot should.  Total
615 s.  Scratch copy discarded.  **The cold archive tier is restorable; it is stale, not
broken.**  The drill also surfaced a real bug in the new script — opening the restored file
read-only leaves `-shm`/`-wal` sidecars behind — now fixed in the same lane.

Verification: `npx tsc --noEmit` clean, `npx vitest run test/r2-cold-snapshot.test.ts` 64 passed
(24 new), `npx eslint` clean on both touched files.

**Review round 1 — five findings from `sentry` and `chatgpt-codex-connector`, all real, all
fixed in one batch.**  Three were in code this lane had just written.  (1) Orphaned multipart
upload: a deadline firing while `CreateMultipartUpload` was in flight left `uploadId`
undefined, so cleanup skipped the abort while the create could still land — the failure path
now settles the create promise first, **bounded** at 10 s because the hang may be the create
itself (the first version of this fix hung, and the new upload-deadline test caught it).
(2) Child deadlines started a fresh 45-minute timer regardless of remaining attempt budget, so
a child could outlive the parent already reporting failure — both children now get
`min(snapshotDeadline, remaining)`.  (3) `R2_COLD_SNAPSHOT_ATTEMPT_DEADLINE_MIN` was not
enforced below the 120-minute job lease, the exact overlap the deadline exists to prevent —
now clamped to lease − 15 min, with the snapshot-step deadline clamped to the attempt
deadline.  (4) The documented container invocation of the Litestream drill was not runnable:
the runtime image ships no `sqlite3` CLI and Litestream sits on PID 1's `PATH` only —
corrected to run on the host (the R2 drill, using bundled `better-sqlite3`, is the one that
runs in the container).  (5) Sharpest of the five: a negative row delta failed the drill,
contradicting this lane's own policy — rows are legitimately deleted between the replica point
and the live read, so the delta is now informational in both directions and pass/fail is
non-emptiness plus integrity.  64 tests passing (24 new); `tsc` and `eslint` clean.  Production stayed read-only: no restart, no
deploy, no env change, no host script edit, no object deleted anywhere.
## 2026-09-09 CLAUDE — Safety-lane "broker timeout" is event-loop starvation, not the broker

The two protective scheduler lanes (`synthetic-stop-monitor`, `stale-limit-scan`) time out against a 15s
`withDeadline` and report `runSyntheticStopMonitor timeout` / `stale-limit-scan broker timeout` (71 / 66
occurrences, still firing at `2026-09-09T14:41:56.548Z`).  Production `task_journal` shows the message is
wrong about its own cause.  `stale-limit-scan` @ `2026-09-08T19:51:57.566Z` ran **185,633 ms** carrying the
inner error `Timed out waiting for alpaca.getOrders after 16000+8000ms.` — the broker call self-terminated at
24,000 ms, leaving **161,633 ms outside all broker I/O**.  `synthetic-stop-monitor` @ `2026-09-09T13:45:41.103Z`
ran **196,840 ms** and finished `ok evaluated=6` — the pass succeeded 182 s after the deadline blamed the
broker.  Passes with `evaluated=0` still took 30–134 s against a 30 s transport ceiling.  The two independent
lanes start within 2–3 ms and match durations to ~100 ms across 130 s runs — one shared process-wide stall.
p50 is ~800 ms and p95 ~1.4 s, so the deadline is generous; only a bimodal tail is broken.

Root cause is the non-convergent FTS mirror loop in **PR #3202**, not this lane: total ms over deadline rose
**28.6x** (120,110 → 3,430,064) and the tail **7.4x** (25,088 → 185,633 ms) from 09-07 to 09-08, the exact day
event-loop pinning jumped to 1,317,546 ms/day, while ingest run counts did not rise and slow ingest runs fell.
The SQLite lock-contention hypothesis was tested and refuted here: only 14.2 % of timeouts had a
`database is locked` event within 15 s, and at 300 s the co-occurrence was *below* chance.

This branch ships **no competing fix** — only the observability gap that remains regardless: `withDeadline`
could not distinguish "the broker did not answer" from "we could not process the answer", which is what sent
PR #3189 after Tradier retries that could not help (57 of 71 and 53 of 66 occurrences landed *after* it merged).
New `src/lib/event-loop-lag.ts` sampler, `withLaneDeadline` attribution, and an `event_loop_stall` failure
category.  **No safety monitor was weakened:** deadline unchanged at 15,000 ms, no interval lengthened, work
still never cancelled, failures still recorded and still escalating to `lane_degraded`; re-attribution needs
≥25 % measured stall.  tsc clean, eslint 0 errors, 11/11 new tests, 50/50 related regression tests.
Rollout: `docs/rollouts/2026-09-09-safety-lane-stall-attribution.md`.

## 2026-09-09 CODEX — Model catalog refresh and concise account labels

Merged as PR #3196 (`3aa643cacd25688eb6c948f686e4410b834617ff`).  Final hosted run `34338996582` on `9968619e4` passed `npm run lint`, `npx tsc --noEmit`, `npm test` (719 suites / 7,928 tests passed; 1 suite / 51 tests skipped), and `npm run build`; security checks passed and all 14 review threads were resolved.  Desktop/mobile header fixture QA passed.  Production verified at `3aa643cac`: containment check passed with `ok=true`, `db=ok`, and scheduler age 19 seconds.  Local dependencies remain incomplete after registry ETIMEDOUT, so no local full-gate claim.  Rollout: `docs/rollouts/2026-09-09-model-catalog-account-labels.md`.
## 2026-09-08 CLAUDE — Transport blips stop paging as provider outages

Twelve Sentry issues titled `"<service> connection failed"` (`SOCRATIC-TRADE-1X`, `-22`, `-28`,
`-1W`, `-1Z`, `-20`, `-2F`, `-2A`, `-25`, `-24`, `-23`, `-1S`) ran 2026-08-13 → 2026-09-08 across a
dozen unrelated integrations, and two paged PagerDuty (#108 `roic`, #112 `congress-share`).  The
common thread was the health path, not any vendor: Node's `fetch()` collapses a dead keep-alive
socket, a DNS hiccup, or an `ECONNRESET` into a bare `"fetch failed"` that matched none of
`db-health.ts`'s soft-failure shapes, so a burst lane firing five requests seconds apart during one
upstream hiccup tripped `HEALTH_REASON_CONSECUTIVE_FAILURES` and captured at Sentry `error`.

`db-health.ts` now carries a third failure class between "expected limit" and "hard".  A transport
blip is stamped `[transient-network] ` and still counts toward the hard streak — a genuinely
unreachable provider must still page — but a streak made entirely of blips captures at `warning`
and withholds the operator push until the same unbroken streak has been failing for
`HEALTH_TRANSIENT_ESCALATION_MS` (10 min, override `HEALTH_TRANSIENT_ESCALATION_MINUTES`).  Every
capture is tagged `health.failure_class` (`transient-network` | `hard`).  `fetchWithRetry` now
replays a transport error only for a read-only method (one existing query-shaped POST opts back in)
and jitters both its transport and 429 backoffs.

RAG lanes keep their own alerter: `alertRagConnectionFailure` applies `isTransientNetworkErrorText` (with nested-cause flattening via `describeNetworkError`) as a level-only check — warning for a short blip, error after `HEALTH_TRANSIENT_ESCALATION_MS`.  `ragLimitStatus`'s soft `"transient"` arm was **narrowed** to drop `fetch failed` / `UND_ERR_SOCKET` (widening it was rejected; leaving them there soft-stamped the row and blocked escalation).  An `ECONNRESET`/`ENOTFOUND`/`EAI_AGAIN`/`socket hang up` / wrapped Pinecone `fetch failed` therefore no longer pages as an unclassified broken request on first sight (`SOCRATIC-TRADE-1X`, 56 events, and `-22`), but a persistent RAG transport outage still reaches `error` / PagerDuty after the escalation window.

API-health path only.  No order-placement, brokerage, or money-path code touched; `tradier.ts`,
`congress-share`'s POST import, and the deliberate `retries: 0` call sites are all unchanged.

Blockers: none.  Next: after deploy, confirm the twelve issues keep receiving `warning` events and
stop producing `error`-level ones.  `SOCRATIC-TRADE-1W` (`congress.trade`) is expected to stay
noisy — its remaining events are HTTP 5xx, which stay hard by design.

Rollout: `docs/rollouts/2026-09-08-transient-network-health-classification.md`.


## 2026-09-08 CLAUDE — R2 weekly cold snapshot stalled 9 days, silently

`checks.storage.r2Weekly` was the only red check on `/api/health`: `archive_stale`,
`ageSeconds` ~797627, newest archive `cold-snapshots/app-2026-08-30.db`.  Litestream/B2
continuous replication was healthy throughout — what stopped was the independent archive
tier.

Root cause: the snapshot step **hung, it never failed**.  better-sqlite3 `backup()` wraps
SQLite's online-backup API, which restarts from page 1 on every write from a different
connection; `app.db` is written continuously and has reached ~10.7 GB, so the copy can
never converge.  Production proof: `week-2026-09-06` sat at `attempts=27`,
`last_error=NULL`, with 55 lifetime `r2_cold_snapshot.start` rows, 5 `.success` (newest
2026-08-30T03:30Z) and **zero `.error` ever**; the in-flight temp file measured exactly
5666406400 bytes at 09:06:00Z, 09:09:46Z and 09:14:00Z while its mtime advanced every few
seconds.  Reproduced locally on better-sqlite3 13.0.3: 2698 restarts in 15s, never
converged; `VACUUM INTO` on the same source under the same writer finished in 117 ms with
`integrity_check` = ok.  Because it hung, `failDueJob` never ran, `lastFailure` was never
written and no advisory fired — and nothing watched `checks.storage.r2Weekly`.

Fix: snapshot via `VACUUM INTO` in a child process (read-only source, minimal env, no
secrets), every attempt bounded by `R2_COLD_SNAPSHOT_DEADLINE_MIN` (default 45 min, under
the 2h lease) with a real kill, `logError` on failure, and `reportR2WeeklyFreshness()` in
the scheduler lane emitting ONE Sentry event per `r2Weekly` state transition.  PR #3168 and
#3135 are ruled out — no run since 2026-08-30 ever reached the prune or the upload.

Bucket capacity, read live 2026-09-08T07:10Z: `objectCount=1`, `payloadSize=9679310848`
(~96.8% of the 10 GB free tier), sole key `cold-snapshots/app-2026-08-30.db`.  Not the
cause; it does gate how the first successful run should land — owner decision recorded in
`docs/rollouts/2026-09-08-r2-cold-snapshot-hang.md`.  No object was deleted.

Branch `claude/r2-cold-snapshot-freshness`.  Rollout:
`docs/rollouts/2026-09-08-r2-cold-snapshot-hang.md`.

## 2026-09-08 GROK — PR #3189 fixer tip (manual vs auto halt + full verify)

Codex round-3 on PR #3189 (`claude/scheduler-broker-error-classification`). Two open threads, both addressed on the tip; Deployer squash AM stays armed; this lane does not merge; extra-ship no.

- P2 `PRRT_kwDOS7mOVM6gD05C`: `applyBrokerOrderPlacementPause` already returned `still_paused` for a manual owner halt without writing an auto-resume marker, but `isHaltedPauseAction` treated every `still_paused` as auto-halted. `logHealthGateSkip` therefore emitted `(auto-halted)` and `halted: true` for an owner-controlled pause. `still_paused` now carries `autoOwned`; the helper is true only for `"halted"` or auto-owned `still_paused`. Dedup stays stable for both kinds of pause.
- P1 `PRRT_kwDOS7mOVM6gD05D`: run the full AGENTS.md sequence (lint then tsc then test then build) and record the actual results in the rollout; do not claim complete if any step is unfinished.

Worktree: `~/apps/trading-claude-scheduler-errors` (only checkout of this PR branch). Rollout: `docs/rollouts/2026-09-07-scheduler-broker-error-classification.md` (round-3 section).

**Blockers:** none for the tip-fix itself. Merge stays with Deployer.
**Next action:** push the tip, resolve both Codex threads, leave auto-merge armed.

## 2026-09-07 CLAUDE — Scheduler/broker error classification, backoff, and observability

Production evidence from `/app/data/litestream-runtime.log` (2026-08-29..2026-09-07, ~9 days):
1,364 "Tradier order capability probe failed" lines, 79/78/75 scheduler broker-timeout lines
(synthetic-stop monitor / stale-limit-scan timeouts + `SocketError: other side closed`), and 92
"[vector-db] Error storing contexts: TypeError: fetch failed" lines on the post-2026-09-01 Qdrant
write path. Fixed a regex gap in `tradier.ts` `probeOrderCapability` that mis-sorted Tradier's
actual "Unexpected server error" wording into a generic unthrottled fallback; added
category-aware exponential-backoff caching there. Added de-duplicated health-gate skip logging
and lane-failure classification + degraded-subsystem surfacing in `scheduler.ts` for the
synthetic-stop-monitor / stale-limit-order lanes. Added a safe opt-in read/preview-only retry to
Tradier's `trackHealth` (never on a real order-placing write). Added bounded retry-with-backoff
to the Qdrant write path (`qdrant-write.ts`) and fixed a `storeContexts` catch-block bug that
hardcoded `provider: "pinecone"` regardless of the actual write backend. Scope is strictly
classification/backoff/observability — no trading-decision logic changed. Complements (does not
duplicate) PR #3174's whole-tick watchdog. Rollout:
`docs/rollouts/2026-09-07-scheduler-broker-error-classification.md`.

## 2026-09-07 CLAUDE — PR #3189 round-2 Codex/Sentry triage (same branch, before merge)

Fixed five real findings from round-1 review, one batch. (1) Race condition (flagged
independently by both `sentry` and `chatgpt-codex-connector`): `recordLaneRecovery` was attached
to the raw `staleExitWork`/`stopMonitorWork` promise instead of the `withDeadline`-raced one, so a
lane that timed out (recording a failure) but later succeeded in the background would silently
clear that same failure streak — a lane that always times out but always eventually succeeds
could never reach `lane_degraded`. Both lanes now key recovery/failure off the same deadline-raced
promise. (2) `recordLaneFailure`'s `alreadyDegraded` check required the failure category to match,
so a category change while degraded silently reset `degraded` to false with nothing having
recovered; now preserved across category changes. (3) Tradier's exponential probe backoff applied
to successes too, so a long healthy streak could ride the TTL to the 60-minute ceiling and mask a
real regression for up to an hour; success now always uses the base 2-minute TTL. (4) The
health-gate skip dedup used `pauseResult.action === "halted"`, the ONE-TICK transition marker, not
the durable halt state (`"still_paused"` on every later tick) — new `isHaltedPauseAction` helper
fixes the resulting per-tick account_skip_started re-emission. (5) `cancelBracketSiblingLegs`'s
GET was never actually opted into `retryTransient` despite the rollout note claiming it was — now
fixed to match. Five new regression tests across `test/scheduler-lane-observability.test.ts` and
`test/tradier.test.ts` (125 total across the 7 targeted files, all green). `npx tsc --noEmit`
clean, `npm run lint` 0 errors, `npm run build` clean (after `npm install` resynced this
worktree's stale `node_modules`, same `ERR_PACKAGE_PATH_NOT_EXPORTED` seen on the sibling
ingest-errors/congress-401 lanes). Merged `origin/main` after PR #3187 landed
(STATUS.md/PLAN.md/docs/EFFORT-LOG.md conflicts auto-resolved, `src/lib/vector-db.ts` also
auto-merged cleanly against #3187's changes); re-confirmed tsc/targeted-vitest/build clean
post-merge.

**Blockers:** none.
**Next action:** none — all 7 round-1 review threads resolved, auto-merge armed, this PR merges
once CI reports green.

## 2026-09-07 CLAUDE — Restart-sweep adoption grace + R7 index-metric guard on the Qdrant read path

Two P1 money-path regressions from PR #3138 (2026-09-01) and its follow-up #3158.  (1) The immediate restart sweep in `markStaleRunningRuns` selects every run that started before this process booted, however young, and its only liveness grace was the process-local `isStrategyRunExecutionLive` map plus an audit probe a seconds-old run has not populated — so a run another node had legitimately adopted was marked `failed` mid-flight and its request row freed for a duplicate.  Fix:  new `hasLiveStrategyRunLease` reads the durable strategy run lock (owner === run id, renewed every 60s with a 5-minute TTL by `startStrategyLockGuard`) and spares such a run, but only on the pre-boot arm — a time-stale wedged run is still swept.  (2) `assertIndexMetric`, the R7 cosine-metric guard, stopped running once `RAG_VECTOR_READ_QDRANT` defaulted true; it now runs on both read backends whenever a Pinecone client exists, without reintroducing the `indexExists` preflight.  The committed-receipts gate now fails closed explicitly on an unknown provider authority.  Auto-merge deliberately NOT armed:  merging auto-deploys live-money production, and board `bdc2b662` is an open P0 on agent code reaching live trading unreviewed.  Rollout:  `docs/rollouts/2026-09-07-restart-sweep-grace.md`.

## 2026-09-07 CLAUDE — iOS hard-crash fix: duplicate command ids trap `Dictionary(uniqueKeysWithValues:)` (board `3b3df6ca`, dup `d9f81e44`)

`CommandAttemptTracker.reconcile(_:)` in `ios/SocraticTrade/MobileStore.swift` built its id→command lookup with `Dictionary(uniqueKeysWithValues: commands.map { ($0.id, $0) })`.  That initializer calls `fatalError` (uncatchable) on any duplicate key, and the server can legitimately report the same command id twice in one snapshot (overlapping poll windows).  Replaced with `Dictionary(_:uniquingKeysWith:)`: last-wins by `updatedAt` (ISO8601 sorts lexicographically), independent of array order, plus a `SentrySDK.capture(message:)` warning when a collision actually occurs so real upstream duplication is visible instead of silently swallowed.  New regression test `testReconcileDoesNotCrashOnDuplicateCommandIdsAndKeepsTheFreshestByUpdatedAt` in `ios/SocraticTradeTests/MobileModelsTests.swift` feeds two entries sharing an id (stale one listed last) and asserts the fresher one wins.  `grep -rn "uniqueKeysWithValues"` across the repo found exactly this one call site.  Build/test verified on the Mac Catalyst destination (this Mac has no iOS Simulator runtime installed — `xcrun simctl list runtimes` is empty — so a device/simulator run was not possible; Mac Catalyst compiles and runs the identical Swift sources).  31/31 tests passed.  Merging to `main` does NOT ship this fix to users — the iOS app ships separately via TestFlight, so a new TestFlight build/release is still required.  Rollout: `docs/rollouts/2026-09-07-ios-dup-command-id-crash.md`.
## 2026-09-07 CLAUDE — SEC ingest error classification (P0 9f875d62 + P1 41fba175 + P1 3cbfcbef)

Fixed three error-handling defects in the RAG/SEC ingest path filed 2026-08-23.  (1) P0:
`sec-ingest-worker.ts`'s embed_queued checkpoint mislabeled every non-budget `storeDocument`
failure (including permanent HTTP 400s) as `"Ingestion budget or capacity exceeded mid-task"`
and blindly requeued it forever via the worker's own dead-letter cleanup; now classifies the
real failure (`classifyEmbedFailure` in `vector-db.ts`) and dead-letters a permanent failure
immediately instead of retry-looping it.  (2) P1: `retrieveFusedContext` (`search-fusion.ts`)
let a query-embed failure silently degrade to lexical-only recall with zero signal; now marks
the result degraded (`wasDenseRecallDegraded`) and emits a structured `rag.dense_recall_degraded`
error log + metric — deliberately proceeds degraded rather than hard-failing, since this path
backs chat/dossier answer quality broadly.  (3) P1: `refreshFilingBodiesUnlocked`
(`sec-filings.ts`) checked `skipped` before `error`, so a failure that also returned
`skipped: true` was silently counted as a benign skip instead of an error — refresh reported
success while having failed.  Also cooldown-gated and gave a distinct fingerprint lane to the
uncapped "RAG ingest text budget reached" Sentry warning (SOCRATIC-TRADE-27: 8,036 events in 2
days burying the 5 real "embed connection failed" events), and made a genuinely unclassified
embed/connection failure log at `error` level instead of always `warning`.  Branch
`claude/ingest-error-classification`, worktree `~/apps/trading-claude-ingest-errors`.  `npx tsc
--noEmit` clean, `npm run lint` 0 errors, full vitest suite green.  Rollout:
`docs/rollouts/2026-09-07-sec-ingest-error-classification.md`.

## 2026-09-07 CLAUDE — PR #3187 round-2 Codex triage (same branch, before merge)

Fixed four real findings from Codex round-1 review, one batch: (1) `classifyEmbedFailure`
classified 408 (Request Timeout) as permanent alongside 429; 408 now also transient, since the
provider never evaluated the request. (2) `retrieveFusedContext` has zero non-test production
callers (`test/rag-production-path-contract.test.ts` "audit R1" pins strategy/chat to
`retrieveContextDetailed` directly), so the defect-2 degradation signal never reached any real
production path; `reportRetrievalStatus` in `vector-db.ts` now emits it centrally on
`lookup_failed` for every caller of the shared `retrieveContextDetailed` function. (3) that
central emission and the existing `search-fusion.ts` wrapper both now exclude `budget_skipped`
from the Sentry/metric emission — a deliberate budget skip is not a provider failure and must not
flood Sentry. (4) `shouldEmitRagIngestBudgetSentry`'s cooldown persistence is now wrapped
fail-soft so a SQLite contention throw cannot escape into `storeContextsImpl` and reject an
otherwise-successful budget-skip. Regression tests added for all four
(`test/pinecone-metadata-and-rag-limits.test.ts`, `test/rag-retrieval-status.test.ts`,
`test/search-fusion.test.ts`, new `test/rag-ingest-budget-sentry-cooldown.test.ts`). `npx tsc
--noEmit` clean (pre-existing unrelated `app/console/components/nav.tsx` errors on `origin/main`
excepted), `npm run lint` 0 errors, `npm run build` clean, targeted vitest (128 tests across the
7 affected files) green; whole-repo `npm test` was kicked off but did not finish in-session, so
CI's `verify` check is the full-suite gate of record.

**Blockers:** none.
**Next action:** none — all 8 round-1 review threads resolved, auto-merge armed, this PR merges
once CI reports green.

## 2026-09-07 CLAUDE — Web 401 routes to /login; alpaca-account-insights classify + bounded retry (board `30809a0c` / `ab03d8c9`)

Primary (P1, live, board `30809a0c`):  a web API 401 never routed the signed-out user to
`/login` — `useConsoleData.tsx`'s polled `GET /api/dashboard` treated a 401 exactly like a
network blip, so the trading desk kept rendering the last-good snapshot as though it were
live with only a small "delayed" freshness chip.  `app/console/lib/api.ts`'s `request<T>`
and `fetchDashboard` now redirect to `/login?callbackUrl=<location>` on ANY 401 — the same
fail-closed destination `middleware.ts` already uses for a page-level 401 — idempotently
and never from `/login` itself (no bounce loop).  `useConsoleData.tsx` stops its poll/
background-refresh loop and exposes `sessionExpired`; `shell.tsx` replaces the entire
console shell with an explicit "Your session has expired" notice the instant that flips,
so stale trading data cannot keep rendering as live while the navigation is in flight.
Secondary, lower priority (board `ab03d8c9`, Sentry `SOCRATIC-TRADE-28`,
"alpaca-account-insights connection failed", 9 events/12 days — low-volume, not a
money-path emergency):  `src/lib/alpaca-account-insights.ts`'s `getJson` call site now
classifies a transient transport error (the shared `network-errors.ts`/
`provider-rate-limit.ts` helpers `data-providers.ts` already uses) with one bounded retry
before it counts as a health failure, and logs its own request-timeout abort soft — the
shared `db-health.ts` pipeline itself is untouched (concurrently owned by
`claude/congress-share-401-observability`).  New tests:
`test/console-session-expired.test.ts`, additions to `test/alpaca-account-insights.test.ts`.
Verification:  `npx tsc --noEmit` clean, targeted `npx eslint` 0 errors on changed files,
targeted `npx vitest run` 35/35 passed; full-repo gate results in the PR body.  Rollout:
`docs/rollouts/2026-09-07-web-401-routes-to-login.md`.
## 2026-09-07 CLAUDE — Remove redundant postcss override (recurring Dependabot failure)

Every Dependabot Updates job touching postcss failed since 2026-08-24 (recurred
08-24 x3, 08-25, 08-31, 09-07) with `postcss / dependency_file_not_resolvable /
"Override for postcss@8.5.28 conflicts with direct dependency."`.  Root cause:
`package.json` pinned postcss identically in both the direct devDependency
(`^8.5.15`) and the `overrides` block (`^8.5.15`) -- Dependabot cannot bump one
side without the other going stale, and flags the pair as unresolvable.
Checked whether the override was load-bearing before removing it.  It was:
npm's top-level `overrides` is transitive by design and was forcing EVERY
postcss occurrence (including `next`'s own exact `8.5.23` dependency) down to
the shared `8.5.15` -- confirmed via the pre-change lockfile, which had exactly
one `postcss` entry (`8.5.15`) tree-wide, no nested copy under `next` at all.
None of that forcing was protecting against something OLDER than what the
dependents wanted, though -- `@tailwindcss/postcss` declares `^8.5.16`, `vite`
declares `^8.5.26` (both newer than the override), and `next` declares an
exact `8.5.23` (also newer).
Removed the redundant `overrides.postcss` entry (kept `overrides.axios`).
Post-removal, `npm ls postcss` shows the devDependency + `@tailwindcss/postcss`
+ `vite` dedupe to `postcss@8.5.28`, and `next` now gets its own real nested
`8.5.23` copy (previously forced to 8.5.15) -- a likely-correctness-improving
but real behavior change, verified by a clean `npm run build` (Tailwind/PostCSS
pipeline exercised end-to-end) and this repo's `verify-hosted` CI full-suite
gate passing on the PR head.  `npx tsc --noEmit` clean, `npm run lint` 0 errors
/ 801 grandfathered warnings (same baseline as `main`).  Branch
`claude/postcss-override-conflict`, worktree `~/apps/trading-claude-postcss`.
Rollout:
`docs/rollouts/2026-09-07-postcss-override-conflict.md`.

`CommandAttemptTracker.reconcile(_:)` in `ios/SocraticTrade/MobileStore.swift` built its id→command lookup with `Dictionary(uniqueKeysWithValues: commands.map { ($0.id, $0) })`.  That initializer calls `fatalError` (uncatchable) on any duplicate key, and the server can legitimately report the same command id twice in one snapshot (overlapping poll windows).  Fixed by folding duplicates through a shared, deterministic `MobileCommand.foldDuplicate` (freshest by `updatedAt`; an exact-timestamp tie prefers the terminal state), applied in both the tracker and the proposal-card command lookup, with the Sentry duplicate warning gated on tracked pending attempts so a persistent server duplicate cannot re-report on every poll and flood the quota.  Regression tests in `ios/SocraticTradeTests/MobileModelsTests.swift` cover the duplicate crash, the equal-timestamp tie-break (both array orders), and the shared fold rule.  This autofix round (2026-09-07) resolves the Codex PR-review threads on commits `c375c55a`/`8f681793`; handoff docs updated (STATUS.md, docs/EFFORT-LOG.md, PLAN.md, rollout note).  Swift compile + XCTest is the hosted `.github/workflows/ios-build.yml` `xcodebuild (unsigned)` check on the PR (no local xcodebuild) — its result is recorded in the rollout note when green.  Web gate run in this lane:  `npm run lint` PASS, `npx tsc --noEmit` PASS, `npm run build` PASS; `npm test` 7782 passed / 51 skipped / 9 failed (the 9 are the pre-existing LLM key-routing failures this seat reproduces on a pristine branch, unrelated to this change).  Merging to `main` does NOT ship this fix to users — the iOS app ships separately via TestFlight, so a new TestFlight build/release is still required.  Rollout:  `docs/rollouts/2026-09-07-ios-dup-command-id-crash.md`.
## 2026-09-07 Autofix (codex-autofix) — observability group dependency bump (PR #3178)

Dependabot bumped the observability group on branch `dependabot/npm_and_yarn/observability-bc808230b8` (commit `437e08531`):  `@opentelemetry/instrumentation` 0.221.0 -> 0.222.0, `@opentelemetry/sdk-trace-node` 2.10.0 -> 2.11.0, `@sentry/nextjs` 10.71.0 -> 10.73.0, `@sentry/profiling-node` 10.71.0 -> 10.73.0 (7 updates total incl. transitive lockfile).  This is a runtime dependency-only change:  production deps + lockfile are runtime watch paths, so merge triggers a production image build; it does not behave like a docs-only update.  This lane authored no product source; it adds the required handoff records (STATUS.md / docs/EFFORT-LOG.md / rollout note / PLAN.md) and swaps the `next.config.mjs` Sentry import to `@sentry/nextjs/config` (the root `withSentryConfig` re-export is deprecated in Sentry 10.73 and removed in v11).  Verification:  `npx tsc --noEmit` PASS, `npm run build` PASS; the local `npm test` run has 9 pre-existing LLM key-routing failures that reproduce on the pristine branch in this seat's env (no relation to this change); the repo `verify` CI gate is authoritative.  Rollout:  `docs/rollouts/2026-09-07-codex-autofix-observability-group-bump.md`.
## 2026-09-07 Autofix (codex-autofix) — eslint-config-next 16.3.4 handoff records (PR #3181)

Dependabot bumped `eslint-config-next` 16.3.1 -> 16.3.4 on branch `dependabot/npm_and_yarn/eslint-config-next-16.3.4` (commit `fbc0f4fe1`).  No runtime code authored by this lane.  Codex review required the repo's handoff records before landing, so this entry records the dependency upgrade in the snapshot and the cross-agent ledger (`docs/EFFORT-LOG.md`).  Round 2 recorded the verification outcomes Codex asked for (tsc/lint/build pass; the 5 LLM-key-sensitive test files fail only under the runner's injected Anthropic env and pass scrubbed; CI `verify`/`verify-hosted` green).  Round 3 added the remaining Codex handoff items:  a PLAN.md entry and a Decisions & Trade-offs section in the rollout note.  Rollout:  `docs/rollouts/2026-09-07-codex-autofix-eslint-config-next-16-3-4.md`.

## 2026-09-07 — Vitest 5.0.0 upgrade recorded (dependabot PR #3179, codex-autofix)

Dependabot bumped the testing group's `vitest` from `^4.1.11` to `^5.0.0` (commit
`37e8850d`); dev-dependency only, no runtime path.  This doc-only follow-up answers the
Codex P1 finding that a dependency bump must be recorded in handoff state:  it adds this
STATUS.md snapshot, a `docs/EFFORT-LOG.md` row, and a rollout note.  Verification state:
the `verify` / `verify-hosted` CI gate (`npx tsc --noEmit` → `npm test` → `npm run build`)
runs on the PR, and a green gate is required before auto-merge.  Rollout:
`docs/rollouts/2026-09-07-vitest-5-bump.md`.
## 2026-09-07 CLAUDE — congress-share 401 observability + auth circuit breaker (board `8620cad8`)

ST's highest-volume live prod error: `[congress-share] import failed: HTTP 401` — 3,096 occurrences over nine days (2026-08-29 to 2026-09-07), `console.error`-only, no Sentry/health/alert/backoff.  Diagnosed via non-secret fingerprint comparison (length + sha256 prefix, no values printed): ST Infisical prod `CONGRESS_TRADE_TOKEN` does NOT match CT Infisical prod `INGEST_TOKEN` nor `ADMIN_TOKEN` — **CONFIRMED token drift**, owner action required to resync (see rollout note).  Independent of the token, fixed the observability hole: `shareWithCongressTrade` (`src/lib/congress-share.ts`) now logs every attempt via the existing `logApiHealth` pipeline (same mechanism "roic"/"congress.trade" already use for Sentry + `/api/health` degraded dependency), and an auth-specific circuit breaker trips on 401/403 (permanent failure) to stop hammering CT, with a shadow health-log replay so the 5-consecutive-failure Sentry threshold still fires promptly.  Added `EXPECTED_BACKEND_LANES` entry for the admin Connections UI.  Branch `claude/congress-share-401-observability`, worktree `~/apps/trading-claude-congress-401`.  Rollout: `docs/rollouts/2026-09-07-congress-share-401-observability.md`.

## 2026-09-07 CLAUDE — PR #3183 round-2 Codex triage (same branch, before merge)

Fixed four real findings from Codex round-1 review, one batch, plus one already-addressed test
fix already on the branch. (1) test isolation — already fixed by prior commit `bb0ef9689`
(reads the N most-recent health-log rows instead of asserting an absolute count that only held
in isolation). (2) The auth breaker had no identity for the token that tripped it, so an operator
resyncing `CONGRESS_TRADE_TOKEN` before the 6h cooldown elapsed stayed blocked for the remainder
— `CongressAuthBreakerState` now stores a non-secret sha256-prefix fingerprint of the tripping
token; `activeCongressAuthBreakerState` auto-clears a breaker keyed to a since-resynced token. (3)
The nightly batch only checked the breaker at the final `shareWithCongressTrade` POSTs —
`fetchCongressPriceNeeds` (itself an authenticated App A request), SPX/per-ticker OHLC fetches,
and the screener refs fetch all still ran hourly for the whole cooldown; `runCongressDailyShareUnlocked`
now gates the entire collection phase up front. (4) Concurrent overlapping callers (scan-hook +
nightly batch) each treated an expired cooldown as their own independent probe, recreating a 401
burst; added `claimCongressAuthBreakerProbe` — an atomic (no `await` between read and write)
durable claim so exactly one caller probes per cooldown boundary. Also documented
`CONGRESS_SHARE_AUTH_BREAKER_COOLDOWN_MS` in `.env.example` and `docs/congress-trade-share.md`
(both Safety/gating prose and the Configuration table). One self-inflicted bug caught before
push: `import { createHash } from "node:crypto"` broke `npm run build` (webpack could not bundle
the `node:` scheme via `scheduler.ts` → `background-worker-startup.ts`) — fixed to the repo's own
bare `"crypto"` convention (matches `db-health.ts`). Six new regression tests in
`test/congress-share.test.ts` (61 total, all green). `npx tsc --noEmit` clean, `npm run lint` 0
errors, `npm run build` clean. Whole-repo `npm test` was kicked off but did not finish
in-session — CI's `verify` check is the full-suite gate of record.

**Blockers:** none.
**Next action:** none — all 6 round-1 review threads resolved, auto-merge armed, this PR merges
once CI reports green. Owner action to resync `CONGRESS_TRADE_TOKEN` between ST/CT Infisical prod
remains outstanding (unrelated to this PR's code, tracked in the original rollout note).

## 2026-09-07 Autofix (codex-autofix) — next-react 16.3.4 handoff records (PR #3177)

Dependabot bumped `next` 16.3.3 → 16.3.4 in the next-react group on branch `dependabot/npm_and_yarn/next-react-aafae73067` (commit `671c800e`).  No runtime code authored by this lane.  Codex review required the repo's handoff records before landing, so this entry records the dependency upgrade in the snapshot and the cross-agent ledger (`docs/EFFORT-LOG.md`).  Rollout:  `docs/rollouts/2026-09-07-codex-autofix-next-react-16-3-4.md`.

## 2026-08-31 GROK — Hung scheduler-tick watchdog (Firefighter SOCRATIC-TRADE-4)

Live SHA `189f5a31` stayed up while Autopilot died:  `scheduler-tick` missed check-in (lastSeen 13:36Z), `schedulerLastTick` 13:30:42Z, lease expired 13:32:12Z, `schedulerStale` / `tradingLivenessDegraded` true, market open, `/api/health` 15s timeout.  Root cause:  `__tickInFlight` skipped every later interval while `tickInner` awaited a hung lane, and Sentry was told `ok` at tick start.  Fix:  15s watchdog unwedge (2 min budget, generation token), honest `in_progress`/`ok`/`error` Crons, `lastTick` on finish, deadlines on drain + `checkBrokerHealth`, do not await strategy runs on the tick path.  No extra-ship.  No Coolify mutate.  Rollout:  `docs/rollouts/2026-08-31-hung-scheduler-tick-watchdog.md`.
## 2026-09-04 GROK — R2 weekly gzip freshen (skip-prune + inventory)

Gzip upload path already on main via #3135 (`cold-snapshots/app-<ISO-date>.db.gz`,
retain=1, KEY_PATTERN matches `.db` and `.db.gz`).  Live Litestream replica is B2
`jays-socratic-trade-eu`; R2 is weekly DR only.  Read-only inventory 2026-09-04
(SocraticTrade.com / `socratic-trade-bucket`): object_count=1, bucket_size ~9.68 GB;
sole key `cold-snapshots/app-2026-08-30.db` size=9679310848 (~9.02 GiB);
`trading-live/` empty (0); `weekly/` empty (0).  This lane adds
`R2_COLD_SNAPSHOT_SKIP_PRUNE` so a freshen can land `.db.gz` without deleting the
legacy 9 GiB object (Jay has not approved that delete).  Read-only inventory
script; no live prune; no Coolify; no extra-ship; no merge from this lane.
Branch `grok/r2-weekly-gzip-freshen`.  Rollout:
`docs/rollouts/2026-09-04-r2-weekly-gzip-freshen.md`.
## 2026-09-04 BF-Fixer — Gather internal time budget (P0 06df80cf)

Leftover `claude/gather-budget` had zero unique commits; `/tmp/st-gather` is gone.
Reconstructed on `origin/main` `de236a63d`: internal enrichment-wave budget so gather
returns a live tape before the 8-minute wall, plus one `skipped_broker_unhealthy`
row when the scheduler health gate auto-halts an active account (equity 0).
Abort + last-good (#3013/#3018) stay.  Not #3138/#3158/#3162.  No extra-ship.
No TestFlight.  Branch `grok/gather-budget`, worktree `~/apps/trading-grok-gather-budget`.
Rollout: `docs/rollouts/2026-09-04-gather-internal-budget.md`.

## 2026-09-04 GROK — Vitest teardown flake after #3162

Main verify on `80515c15` failed with `EnvironmentTeardownError` /
`onUserConsoleLog` pending in `test/economic-calendar-prompt-wiring.test.ts`
after 7761 passing tests.  `#3046`'s `onConsoleLog: () => false` still
forwards logs over RPC.  Fix: `disableConsoleIntercept: true` plus quiet
log/info/debug in the existing setup file.  Targeted vitest 3/3 in 6.67s,
eslint on touched files exit 0.  Branch `grok/vitest-teardown-console`,
worktree `~/apps/trading-grok-verify-flake`.  PR: https://github.com/jaywedgeworth22/Socratic.Trade/pull/3163
SHA `4fba321ff`.  No Coolify.  No extra-ship.  No merge from this lane.
Remaining gate: GitHub `verify`.  Rollout:
`docs/rollouts/2026-09-04-vitest-teardown-console.md`.

## 2026-09-03 GROK — Cash-flow-matched S&P overlay

Owner asked where vs-S&P lives and for the overlay graph of account vs S&P if the same cash
had been added and withdrawn.  Numbers already existed as TWR % on Results (web) and Home /
Results / Insights (iOS).  The dollar overlay was computed as unused index series.  This
lane draws account $ vs same-cash SPY $, with every deposit/withdrawal as a breakpoint and
a daily last-snapshot curve so early transfers survive.  Branch `grok/spy-cashflow-chart`,
worktree `~/apps/trading-grok-spy-chart`, board `7b71186c`.  Rollout:
`docs/rollouts/2026-09-03-spy-cashflow-chart.md`.

## 2026-09-01 GROK — Qdrant Stage 2 write/delete/inventory cutover

Owner-directed full Qdrant integration.  Stage 1 reads already serve (`RAG_VECTOR_READ_QDRANT`, PR #3138).  Stage 2 routes upserts, deletes, payload patches, and metadata inventory to self-hosted collection `socratic-trade` via new `src/lib/vector-store/qdrant-write.ts` and knob `RAG_VECTOR_WRITE_QDRANT` (default true when `QDRANT_URL` is set).  Runtime default no longer calls Pinecone upsert/deleteMany/list/fetch, does not wrap those paths in `withRagApiHealth("pinecone")`, and does not park ingest on `pineconeWuExhaustedUntil` or the daily Pinecone WU fuse.  Provider authority on the Qdrant path comes from durable SQLite commits (`durableProviderAuthority`) so writes do not no-op.  Point ids stay uuid5(`st:{ns}:{pc_id}`) with payload `pc_id`/`ns` so Stage 1 reads keep matching.  Metering is provider `"qdrant"` with zero phantom WUs.  `@pinecone-database/pinecone` stays installed behind the pinecone backend flag.  Did not run a Pinecone delta copy (would burn remaining read units).  Branch `grok/qdrant-write-cutover`, worktree `~/apps/trading-grok-qdrant-writes`, issue #3151, boards 97b5894b / 9e19673a / dc98d716 / c741db8e.  Rollout: `docs/rollouts/2026-09-01-qdrant-write-cutover.md`.
## 2026-09-01 GROK — Litestream structural: L2/L3 off, honest detector, scheduled L1 trim

Owner-directed: stop the trim-and-heal cycle.  Product compaction is L0 + bounded L1 +
24h snapshots.  Litestream 0.5.12 has no disable-L2 flag; `litestream.coolify.yml`
`levels: [{interval: 30s}]` is the off switch (`Config.Levels` is L1..N).  No
compaction-backoff yaml key either -- removing L2/L3 is the backoff (the storm was
re-downloading the whole L1 chain every 5 minutes).

Detector: per-level log recovery (L1 complete does not clear L2 fail).  Health pages
stale L9 even when L0 age is 0.  Leftover L2/L3 objects do not page
(`LITESTREAM_PRODUCT_DISABLED_TIERS`).  Boot log rotation (#3135) is enough.

L1 boundary-trim is a first-class scheduled unit in-repo (`scripts/ops/litestream-l1-boundary-trim.timer`,
00:04 UTC).  Do not fight tonight's transient oneshots.  Host install is remaining ops.
Do not bounce Coolify.  Do not FORCE_RESTORE.  Do not touch live B2 `trading-live/**`.

Branch `grok/litestream-structural`, worktree `~/apps/trading-grok-litestream-struct`,
issue #3153, boards 081c8ecf / 1e3df744.  Rollout:
`docs/rollouts/2026-09-01-litestream-structural.md`.
## 2026-09-01 GROK — Money-path orders: MCP write idempotency, Alpaca `stop` wire, provenance

Owner-directed fix of three live-order bugs (#3152 / efd2a783, ef0dccb3, d4cb5e75, d36c2233).  MCP place/cancel no longer REST-falls-back after an 8s timeout or 5xx (reconcile by `client_order_id` / order id; fallback only on tool-not-found or 4xx-before-send).  Writes map `stop_market` to Alpaca `stop`.  Auto-replace treats a nonempty Alpaca UUID as owner-placed unless the id has prefix `protstop-`/`sstop-` or a tracked intent row.  No live orders from this Mac.  Branch `grok/money-path-orders`, worktree `~/apps/trading-grok-money-path`.  Rollout: `docs/rollouts/2026-09-01-money-path-orders.md`.
## 2026-09-01 GROK — Qdrant Stage 2 write/delete/inventory cutover

Owner-directed full Qdrant integration.  Stage 1 reads already serve (`RAG_VECTOR_READ_QDRANT`, PR #3138).  Stage 2 routes upserts, deletes, payload patches, and metadata inventory to self-hosted collection `socratic-trade` via new `src/lib/vector-store/qdrant-write.ts` and knob `RAG_VECTOR_WRITE_QDRANT` (default true when `QDRANT_URL` is set).  Runtime default no longer calls Pinecone upsert/deleteMany/list/fetch, does not wrap those paths in `withRagApiHealth("pinecone")`, and does not park ingest on `pineconeWuExhaustedUntil` or the daily Pinecone WU fuse.  Provider authority on the Qdrant path comes from durable SQLite commits (`durableProviderAuthority`) so writes do not no-op.  Point ids stay uuid5(`st:{ns}:{pc_id}`) with payload `pc_id`/`ns` so Stage 1 reads keep matching.  Metering is provider `"qdrant"` with zero phantom WUs.  `@pinecone-database/pinecone` stays installed behind the pinecone backend flag.  Did not run a Pinecone delta copy (would burn remaining read units).  Branch `grok/qdrant-write-cutover`, worktree `~/apps/trading-grok-qdrant-writes`, issue #3151, boards 97b5894b / 9e19673a / dc98d716 / c741db8e.  Rollout: `docs/rollouts/2026-09-01-qdrant-write-cutover.md`.

## 2026-09-01 GROK — Sentry fleet adoption remainder (tunnel, iOS DSN, profiling, logger, gen_ai)

Remaining ST Sentry work after AG #3146 (`enableLogs`, Replay 0.01/1.0, traces 0.2, no Vercel monitors).  Enables `tunnelRoute: "/monitoring"` with middleware matcher + public-prefix exclusion so ad-blockers cannot drop browser envelopes.  iOS `SentryTelemetry.swift` no longer hardcodes a DSN fallback — Info.plist `SENTRY_DSN` only, skip init if missing; Cocoa Session Replay with mask-all-text / mask-all-images / no screenshots; `releaseName`/`dist` from `CFBundleShortVersionString`/`CFBundleVersion`.  Server continuous profiling via `@sentry/profiling-node` on `sentry.server.config.ts` only (`profileLifecycle: "trace"`).  Sparse `Sentry.logger` + Application Metrics from existing `src/lib/sentry-metrics.ts` on scheduler tick/overrun, rag.rejected, embed.failed, broker.call.  OpenRouter/Voyage/Pinecone/earningscalls HTTP wrapped in `gen_ai.*` / `db` spans without prompt contents.  Official `@sentry/nextjs` AI integrations stay registered for any SDK path.

**Coolify (not in this PR):** set `NEXT_PUBLIC_SENTRY_REPLAY_ENABLED=true` at **build time** to actually emit web Replay.  The code default stays off.  iOS TestFlight ship must pass `SENTRY_DSN` as an xcodebuild setting or Cocoa stays inert.

Branch `grok/sentry-fleet-adoption`, worktree `~/apps/trading-grok-sentry-adopt`.  Rollout: `docs/rollouts/2026-09-01-sentry-fleet-adoption.md`.
## 2026-08-31 ANTIGRAVITY — Default RAG reads to Qdrant, decouple from Pinecone & immediate restart sweep

Fixed strategy run failures from Pinecone rate limits (429 / WU exhaustion) and orphaned process restart runs.  Defaulted `RAG_VECTOR_READ_QDRANT` to `true` across server knobs and `vectorReadBackend()` so retrieval natively queries self-hosted Qdrant on Hetzner without Pinecone prerequisites; fully decoupled `retrieveContextDetailed`, `denseTierQuery`, and `denseResults` from Pinecone client and index objects; resolved provider authority fallback from durable SQLite commits; broke `db-execution` circular dependency via standalone `strategy-run-execution-registry.ts`; handled Pinecone 429 rate limits gracefully during hourly background reconciliation; updated `markStaleRunningRuns` to immediately sweep dead runs from previous process lifecycles upon startup.  Full verification gate passed: lint, tsc, 7,696 vitest tests (700 files), Next.js build.  Rollout: `docs/rollouts/2026-08-31-qdrant-default-strategy-fix.md`.

## 2026-09-01 CLAUDE — L1 boundary-trim hardened, and Congress.Trade found wedged too

Closes the three guard gaps the #3140 review raised, plus two defects that only showed up
when the tool was run for real against a 2,400-object level.  The repo copy is resynced
byte-identical to the hardened host tool — sha256 `a6bfc2bf…8087`, 9721 bytes, mode 755,
verified on both sides.

Guards: `--app {socratic,congress,usage-monitor}` replaces the Socratic-only bucket/prefix
constants; a **relative** truncation guard aborts under 50% of the previous snapshot (the
100 MB absolute floor cannot reject a truncated ~4.5 GB snapshot, and the boundary is read
from the filename, which looks authoritative regardless of content); contiguity is walked
across the **entire** kept set for internal txid gaps (twins allowed) with its own exit code,
because L2 stays wedged on non-contiguous input no matter how much L1 is trimmed;
`--max-snapshot-age-hours` (default 48, scheduled units pass 6) makes a late nightly abort
loudly instead of trimming to a stale boundary; and a new guard aborts when nothing is
superseded while L1 still holds more than 200 objects.

Two fixes came out of running it:

**Deletes are batched.**  The per-object `rclone delete --include` loop re-listed the whole
prefix on every call — O(n^2), measured at ~12s per delete on CT, about 8 hours for 2,362
objects.  Now chunks of 500 names go through one `rclone delete --files-from --transfers 16
--checkers 16` per chunk.

**Deletes are hides, NOT `--b2-hard-delete`, and that is deliberate.**  The host's scoped
`fleet-backup-writer` key may hide a version but returns `Unknown 401 (401 unauthorized)` on
`b2_delete_file_version` — so with the flag set rclone reported progress while deleting
**nothing**, and roughly 800 "deletes" against CT were a complete no-op.  A hide is enough to
unwedge compaction (litestream stops seeing the object immediately) and the bucket lifecycle
rule `daysFromHidingToDeleting=1` frees the bytes about a day later.  Hard deletes need the
B2 master key, so same-hour space reclamation means running the trim from an operator
workstation.  The ~73 GB hide-marker overhang (199.59 GB billed vs 126.49 GB logical) is
still the reason the distinction matters — the host just cannot avoid it.

Consequently the tool **no longer trusts its own exit codes**: after applying it re-lists L1
and reports `APPLIED app=X deleted=N survived=M batch_errors=E` from what actually remains,
naming survivors.  Exit codes: 0 ok/no-op, 1 objects survived, 2 no snapshot, 3 guard,
4 restore hole, 5 kept-chain gaps, 6 boundary did not advance.

**Congress.Trade had never been trimmed at all.**  Its L1 held 2,413 objects, 2,362 of them
(24.6 GB) superseded by the fresh 2026-09-01T00:00:02Z snapshot, leaving 51 (12 MB) — and its
L2 held **zero** objects, the same wedge state ST was in.  Six transient one-shot units
(`l1trim-st-*`, `l1trim-ct-*`) are armed for 2026-09-02 00:04/00:20/00:40 UTC with
`--max-snapshot-age-hours 6`, two retries of headroom for a late snapshot; they replace the
single `l1-boundary-trim-oneshot`, now stopped.  Transient on purpose — they expire on reboot
rather than quietly becoming a nightly policy, since trimming below a snapshot costs sub-daily
PITR granularity and the app's 168h snapshot retention stays authoritative.  Docs-and-script
only; no runtime code touched.  Rollout: `docs/rollouts/2026-09-01-l1-trim-hardening.md`.

**The fixed tool then worked.**  CT re-run at 07:46:53Z reported
`APPLIED app=congress deleted=2361 survived=0 batch_errors=0`, and the bucket recount agrees:
CT L1 went **2,413 -> 82** (82 = the 51 originally-kept objects plus new arrivals), in minutes
rather than the ~8 hours the per-object loop projected.  `--b2-versions` shows **2,444**
versions against those 82 listed entries — the trimmed objects are hidden, not gone, and stay
recoverable until the `daysFromHidingToDeleting=1` reaper runs.  That single listing shows both
the cost (bytes billed ~24h longer) and the safety margin (a mistaken trim is reversible inside
that window) of the hide-based approach.

**Next action:** deletion is proven, **recovery is not** — CT's L2 is still at zero objects, as
is ST's, and ST has not been trimmed with this build (L1 at 255).  A trim that removes objects
without restarting compaction has fixed nothing, so confirm `msg="compaction complete" …
level=2` and an advancing L2 `<min>` TXID on both apps after the 00:04-00:40 UTC window.  Do
not read the ~24h lag in freed bytes as failure; the host can only hide.


## 2026-09-01 CLAUDE — L2 unwedge: snapshot-boundary L1 trim tool landed (PR #3140, `271e5ff8e`)
## 2026-09-01 CLAUDE — PR #3139 plist comment: actually fix the XML `--` bug

PR #3139 claimed moving the template comment above `<!DOCTYPE>` down into `<dict>` fixed
`plistlib.loads` raising `ExpatError: not well-formed` on
`scripts/com.jay.provider-knob-sync.plist` — it did not.  XML comments cannot contain the
sequence `--` anywhere in their body regardless of position, and the relocated comment
still had two literal `--apply` mentions (lines 8 and 18).  `chatgpt-codex-connector`
caught this and was right: `plistlib.load` on the PR's head still raised the identical
error.  Reworded both `--apply` mentions to "the apply flag" (no `--` sequence remains in
the comment); the real `--apply` CLI argument in `<key>ProgramArguments</key>` is untouched
since it's a `<string>` value, not comment text.  Verified with `python3 -c "import
plistlib; plistlib.load(open('scripts/com.jay.provider-knob-sync.plist','rb'))"` on both
`/usr/bin/python3` and `/opt/homebrew/bin/python3` — parses clean now, raised before.  No
repo test/CI step runs plistlib against this file.  Rollout:
`docs/rollouts/2026-09-01-pr-3139-plist-comment-fix.md`.

## 2026-09-01 CLAUDE — L2 unwedge: snapshot-boundary L1 trim tool landed

Litestream level-2 compaction has been wedged since 2026-08-29 with no alert — L0/L1
replication and `/api/live` stayed green the whole time, so the only signal was `level=2`
lines in container logs.  Root cause is the mega-upload, not the Backblaze download cap:
L2 folds the whole remaining L1 chain into one object, so while it is stalled L1 grows and
each retry is a larger multipart upload that dies.  The cap DID reset at 00:00Z (zero cap
errors 00:00–01:39Z) and L2 still failed 19 times in that window, every one on the upload;
the first cap-exceeded came only at 01:39:33Z.  Lands
`scripts/litestream-l1-boundary-trim.py` — byte-identical to the installed host tool
(sha256 `b1a05816…f1d2`) — which deletes L1 objects already contained in the newest L9
snapshot, dry-run by default, refusing to leave a restore hole.  Deletes and listings are
Class A/C, so it works while downloads are capped.  A one-shot timer is armed for
2026-09-02 00:02Z, right after the nightly snapshot advances the boundary; it is
deliberately NOT a recurring timer, because trimming below a snapshot costs sub-daily PITR
granularity and the app's 168h snapshot retention stays authoritative.  Docs-and-script
only; no runtime code touched.  Rollout:
`docs/rollouts/2026-09-01-l2-unwedge-boundary-trim.md`.

Codex review found three real guard gaps, all accepted and none fixed here — the script is
landed as a verbatim mirror of the installed host copy, so hardening it must change repo and
host together, which is a production write outside this unit.  They are: snapshot integrity
(the 100 MB floor cannot catch a truncated ~4.5 GB snapshot whose filename still supplies the
boundary), kept-chain contiguity (only the first kept object is checked, and internal L1 gaps
are a demonstrated wedge), and scheduled-run freshness (the 48h guard accepts yesterday's
snapshot, so a late nightly makes the 00:02Z one-shot under-heal and then lapse).  Covered
meanwhile by the "Pre-flight before `--apply`" checklist in `docs/litestream.md`.

**Next action:** after 2026-09-02 00:02Z confirm a `compaction complete … level=2` line and
the L2 `<min>` TXID advancing past `0000000000134700`.  If it still fails, the suspect is a
poisoned L2/L3 object — that is `scripts/litestream-l1-suffix-heal.py`'s job, since
boundary-trim never touches those levels.

## 2026-08-31 GROK — Top-to-bottom full-stack audit (web, iOS, backend)

Report-only.  Branch `grok/full-stack-audit`, worktree `~/apps/trading-grok-full-audit`, board `52592a4d`, tree `ff7a562d9`.  Nine-agent scan plus orchestrator file:line verification.  Catalog: `docs/reviews/2026-08-31-grok-full-stack-audit.md`.  Still open on `main`: Alpaca `stop_market` write (`d4cb5e75`), MCP place timeout REST fallback (`ef0dccb3`), any-`client_order_id` provenance (`d36c2233`), oldest-500 fills, iOS `uniqueKeysWithValues`, web 401 freeze.  Guardrails Discard and `/mobile` redirect are fixed.  Do not implement in this PR.  Do not steal Claude `06df80cf`.  Do not HOTFIX during RTH.  Rollout: `docs/rollouts/2026-08-31-grok-full-stack-audit.md`.

## 2026-08-31 CLAUDE — Backup remediation: gzip weekly R2 cold snapshot + log rotation

The weekly R2 cold snapshot now gzip-streams during upload
(`cold-snapshots/app-YYYY-MM-DD.db.gz`, ~2.5-4 GB expected vs 9.7 GB raw at ~90%
of the R2 free tier); retention prunes across both `.db` and `.db.gz` so the
legacy `app-2026-08-30.db` deletes after the first gzipped success.  Restore
now needs `gunzip` first — recipe in `docs/litestream.md`.  Container boot
rotates `/app/data/litestream-runtime.log` (was 237 MB) at 64 MB, keeping the
newest 16 MB.  Docs: B2 lifecycle hide-14d/delete-1d hard-caps B2 restore depth
at ~15 days; all three apps run litestream in-container; 2026-08-31 L1 suffix
heal precedent recorded.  PR #3135 merged (squash `0d69d9063`); the deploy is
correctly deferred by the weekday RTH latch (Monday; build refused 14:39 UTC
with `rth-blocked`) and the post-close 21:20 UTC drain ships it — do not HOTFIX
or hand-trigger.  Next action: after the drain, `bash scripts/verify-deploy-sha.sh
0d69d9063`; then verify the first `.gz` upload after Sunday 03:17 UTC and the
rotation line on that boot.  Rollout:
`docs/rollouts/2026-08-31-backup-remediation.md`.

## 2026-08-30 BF-Fixer — PR #3120 Codex thread unstick

HEAD `bab1cb840` was MERGEABLE but BLOCKED on five unresolved Codex threads.
Fail-closed snapshot decode for missing/wrong-shape `readiness` and `policy`.
Auth-redirect carries cookie salt and exchange reissues a verified token.
Connections-health merges `earningscalls` onto `earningscalls-dev-rapidapi`.
Ops-snapshot pin rollout path corrected to `app/admin/connections/`.  No
extra-ship.  No TestFlight.  Rollout:
`docs/rollouts/2026-08-30-pr-3120-codex-threads.md`.

## 2026-08-30 GROK — PR #3120 CI unblock (ops-snapshot trial pin)

`verify-hosted` on #3120 failed `test/ops-snapshot.test.ts` (`trial.active`
expected true, got false).  Not an ios ship-seq failure.  Merged `origin/main`
(`f385fb037` / #3111) so the snapshot fixture is pinned to now+7d.  PR intent
unchanged: iOS auth-redirect + resilient workspace decoding, EarningsCalls.dev
and ROIC.ai labels.  No squash-merge.  No extra-ship.  No `--force-ship`.
Rollout: `docs/rollouts/2026-08-30-pr-3120-ops-snapshot-pin.md`.

## 2026-08-30 GROK — PR #3111 CI unblock (asc-seq stderr)

`verify-hosted` on #3111 failed `test/ops-snapshot.test.ts` (`trial.active`
expected true after the 2026-08-27 / 2026-08-30 calendar pins expired).  Merged
`origin/main` and pinned the snapshot fixture to now+7d.  PR intent unchanged:
surface `asc-seq` stderr; unverified die-text names the local sequence that
exists.  No extra-ship.  No `--force-ship`.  Rollout:
`docs/rollouts/2026-08-30-asc-seq-surface-stderr.md`.

## 2026-08-27 MONET — iOS OAuth return-to-app + workspace decode (owner re-report; grok dispatch dead)

Owner re-reported both iOS auth issues after #3116/#3117.  Re-diagnosed with live production evidence: (A) auth-start clamped callbacks against the INTERNAL container origin, collapsing the mobile handoff to "/" — the OAuth sheet landed on the signed-in website; (B) "Couldn't load your workspace" is a decode failure — server equity-curve points carry `timestamp`, shipped Swift `EquityCurvePoint` required `date`, and the hard-try `performance` decode blanked the whole snapshot.  Fixes: public-origin resolution (`src/lib/mobile-auth-start.ts`), mobile-wire `date` alias (`src/lib/mobile-equity-curve-compat.ts` — fixes installed builds on deploy), Swift dual-key decode + defensive performance decode.  Grok local agent was owner-directed to implement but both headless dispatch modes died (8317 refused; leader-socket silent) — MONET landed directly.  Rollout: `docs/rollouts/2026-08-27-ios-auth-redirect-workspace-decode.md`.
## 2026-08-28 ANTIGRAVITY — Kalshi First-Class Event Accounts, Real-Time Paper Data, & Universal Shorting/Options Trading

Added full first-class Kalshi account connectivity (demo & live) with customized event-contract settings, guardrails, portfolio, order execution, and LLM prompt views; removed delayed Alpaca paper keys from Infisical and guaranteed real-time market data performance for paper accounts; built universal financial-grade shorting and options trading across all supported brokers (Alpaca, Tradier, Webull, Public, Test). Verified with clean lint, type check, 7,639+ passing tests, and full Next.js production build. Rollout: `docs/rollouts/2026-08-28-kalshi-and-options-expansion.md`.

## 2026-08-28 CLAUDE — Qdrant self-host live + full non-Voyage corpus copy

Owner-directed: Qdrant v1.19.0 runs as Coolify service `qdrant-st` on the upgraded Hetzner box — Tailscale-mesh-only :6333, API-key auth, mem 6g / cpu 3 caps.  Collection `socratic-trade` holds **801,239 points** copied from Pinecone and verified (exact counts + sampled payloads); voyage-era records excluded per owner rule (7,708 = 0.95%, plus 95 untagged legacy — both invisible to current bge-m3 retrieval anyway).  Gotcha for future bulk work: corpus ids are 155 chars, so GET fetches beyond ~40 ids answer HTTP 414 — the landed script batches by encoded URL length.  Creds canonical in ST Infisical prod (`QDRANT_URL` / `QDRANT_API_KEY`) per the owner's 2026-08-28 Infisical-first policy.  **Pinecone remains the serving store** — no runtime code changed; cutover is gated on the vector-db.ts adapter + shadow-read + Recall@8 parity + a pre-cutover delta copy.  Qdrant volume has NO off-box backup yet (board follow-up: snapshot cron -> B2).  Rollout: `docs/rollouts/2026-08-28-qdrant-st.md`.

## 2026-08-27 CLAUDE — iOS workspace-load failure: snapshot latency + first-load retry

Root cause of "Couldn't load your workspace" after Apple sign-in: iOS makes ONE 30s snapshot attempt with no retry while `getDashboardSnapshot` chained three sequential broker deadlines (24s bundle → 16s options → 16s quotes) — past 30s in the current degraded-liveness window, and a fresh sign-in has no cached snapshot.  Fix: options now fetch concurrently with the bundle (helps installed builds on deploy), and iOS retries the first load once (45s window) before failing.  The web console got this hardening 2026-08-12; its "parallelise the broker chain" follow-up is now landed.  Rollout: `docs/rollouts/2026-08-27-ios-snapshot-latency.md`.

## 2026-08-27 CLAUDE — iOS Google/GitHub sign-in fixed server-side (GET OAuth initiator)

iOS Google/GitHub sign-in never worked: `beginWebAuth` opens `GET /api/auth/signin/<provider>`, but Auth.js v5 initiates OAuth only on POST — the GET throws `UnknownAction`, maps to `error=Configuration`, and parks the auth sheet on `/access-denied` (prod logs show it firing continuously; predates the beta.32 bump).  Fix: new public `app/api/mobile/auth-start/route.ts` calls the server-side `signIn()` (sets PKCE/state cookies, 307s to the provider), `middleware.ts` translates the legacy GET so **already-installed TestFlight builds work without an app update**, and `LoginView.swift` now targets auth-start directly.  Verified live on a dev server: legacy URL → auth-start → 307 `accounts.google.com` with PKCE cookies.  7 new tests in `test/mobile-auth-start.test.ts`.  Related lanes in flight: workspace-load-after-Apple-sign-in root-cause, Usage-Monitor Litestream/B2 retry storm (that is what has been eating the shared Backblaze daily cap — 119 failed multipart compactions in 2h; ST already cut sync-interval to 300s in #3107).  Rollout: `docs/rollouts/2026-08-27-ios-web-oauth-get-initiator.md`.

## 2026-08-26 CURSOR — CI autofix: APNs contract missing roic_status_advisory

#3107 (`f22b92ed`) registered `roic_status_advisory` on `NOTIFICATION_EVENT_TYPES` so ROIC.ai can sit under EarningsCalls.dev in Settings, but left the iOS contract table in `PushNotificationTests.swift` one row short.  `verify-hosted` failed `test/apns-deep-link-contract.test.ts` (covers every event type exactly once); the required `verify` gate then failed because hosted failed.  Autofix hit its 60-turn cap.  Fix: add the Activity/notifications Row next to `earningscalls_entitlement_blocked`.  `pushDeepLink` already catch-alls that URL.  Branch `cursor/ci-autofix-automation-9634` stacked on `agent/antigravity-ui-fixes`.  Rollout: `docs/rollouts/2026-08-26-roic-apns-contract.md`.

## 2026-08-26 ANTIGRAVITY — Guardrail capabilities, market hours hints, unmanaged shorts, and stop fallbacks

Pass live account capabilities into `mergeAccountCapabilities` in Guardrails page so Alpaca connected accounts preserve live shorting capabilities; align broker-specific `syntheticStopHoursHint` in `market-hours.ts` with executable order windows (Robinhood/Tradier 7:00 AM, Public 8:00 AM, eToro regular-only); fallback `shortTrailFallback` to `stopLossPct` when short stop loss is unconfigured in `src/lib/synthetic-stops.ts`; check effective stop distance configuration in `deriveUnmanagedShorts` in `app/console/lib/derive.ts`.  Rollout: `docs/rollouts/2026-08-26-reviewer-fixes-guardrails-stophours.md`.

## 2026-08-25 CURSOR — AppUpdatePromptTests pbxproj leftover after #3102

COMPLETED (merged to `main`) #3103 squash `64a06e78`.  #3102 squash `df75ca6f` landed the Swift pin/copy + DealDex registry.  This leftover committed the generated `AppUpdatePromptTests.swift` pbxproj refs so TestFlight (no xcodegen) stays in sync.  Hosted leftover `ios-build` `32809716228` and head `32810441765` ** TEST SUCCEEDED ** (242/0).  `verify-hosted` `32809716125` success.  Do not `--force-ship`.  Do not dispatch `ios-ship.yml` unless the owner asks.  Do not claim website deploy without `scripts/verify-deploy-sha.sh`.  `ios/**` is outside Coolify `watch_paths`.  Rollout: `docs/rollouts/2026-08-25-app-update-prompt-pbxproj.md`.

## 2026-08-25 CURSOR — AppUpdatePrompt Apple IDs off Swift (live DealDex net.dealdex)

COMPLETED (merged to `main`) #3102 squash `df75ca6f`.  One pinned `AppUpdatePrompt.swift` stays the ios-fleet copy.  Dropped `knownAppleIds` (stale `online.dealdex`).  Prompt reads versions / `appleId` from `jaywedgeworth22/ios-app-versions` and the local `ios-app-versions.json` mirror.  `apps.json` live DealDex is `net.dealdex` 6802474288.  Do not treat `online.dealdex` as live.  Do not upload `me.grok.dealdex`.  No Swift package.  No `testers.json`.  No `--force-ship`.  No spend.  Hosted `ios-build` `32808123472` ** TEST SUCCEEDED ** (242/0).  Generated pbxproj leftover is the stanza above.  Rollout: `docs/rollouts/2026-08-25-app-update-prompt-apple-ids.md`.

## 2026-08-25 CURSOR — Playwright smoke: dismiss ConsentGate before More

COMPLETED (merged to `main`) #3100 squash `1662cdcd`.  Hosted Playwright Smoke `32805872756` succeeded (classify + smoke).  Spec accepts the first-use legal dialog, then keeps the #3097 More vs rail Scan asserts.  Not TestFlight.  Do not dispatch `ios-ship.yml`.  Rollout: `docs/rollouts/2026-08-25-smoke-dismiss-consent.md`.

## 2026-08-25 CURSOR — Console honesty: Discard, approve typed-confirm, Coach chips

COMPLETED (merged to `main`) #3093 squash `5a2080cf`.  Guardrails Discard clears universe + policy drafts.  Approve 409 opens typed-confirm.  Coach chips prefill.  Leftover UX: iOS Open Guardrails, Open Connections copy, Tradier (paper).  Playwright `smoke` on this sha was the ConsentGate overlay; #3100 / run `32805872756` is green.  Rollout: `docs/rollouts/2026-08-25-console-discard-approve-chips.md`.

## 2026-08-25 CURSOR — Playwright mobile-chrome smoke: Scan is in More

COMPLETED (merged to `main`) #3097 squash `c2ed2c85`.  Default pins omit Scan; smoke opens More on the phone bar.  Overlay leftover closed by #3100 (`1662cdcd`, smoke `32805872756` green).  Rollout: `docs/rollouts/2026-08-25-mobile-smoke-scan-more.md`.

## 2026-08-25 CURSOR — Datadog Logs + APM + RUM on the existing us5 account

Owner: reuse the existing Datadog account only.  No new org, API key, or paid add-on.  This repo had zero Datadog SDK wiring; host agent on `fleet-hetzner-nbg1` saw syslog/USM `service:node`, not the Next.js app.  Coolify container stdout was not ingested.  Implementation is fail-closed: missing `DD_API_KEY` / agent host / RUM tokens is a no-op and must not crash prod.  Server logs (warn+) go to the official us5 HTTP intake.  APM uses the host agent when `DD_AGENT_HOST` is set, otherwise official agentless exporter.  Coolify `NODE_OPTIONS --import ./scripts/datadog-preload.mjs` after Infisical so `dd-trace` loads before Next.  Browser RUM boots from `instrumentation-client.ts` plus a hidden runtime boot so Infisical tokens work without a rebuild.  Session Replay / Profiling / AppSec stay off.  Sentry + PagerDuty (Firefighter moderate+) are unchanged.  Designer copy/layout and Oracle RAG/Pinecone are untouched.  Coolify deploy is not this PR.  Branch `cursor/datadog-logs-apm-rum-6ce3`, PR #3094.  Rollout: `docs/rollouts/2026-08-25-datadog-logs-apm-rum.md`.

## 2026-08-25 CURSOR — Hosted TestFlight 1.0.69 installable (PR #3089)

COMPLETED.  #3089 squash `ef725f26` vendored in-repo `scripts/ios-fleet/` and imported existing ASC/P12 GitHub secrets.  Merge-push ship `32794753487` archived then cancelled mid-upload.  Next hosted `macos-latest` tick `32796413908` (`event: schedule`) uploaded **1.0.69 (202608250109)** for `trade.socratic.app`; ASC `internal=IN_BETA_TESTING` ("TestFlight internal testers can install this build").  Git sha recorded `b9421cbf` (#3090 on top of #3089); `ios/**` was unchanged by #3090 so the binary includes #3028 chrome (gear, bell, Admin tab).  Do not run local `xcodebuild`.  Do not restart `mac-xcode26-socratic`.  Website/Coolify is not this deploy.  Playwright `smoke` failure on `b9421cbf` is #3090, not this ship.  Rollout: `docs/rollouts/2026-08-24-ios-hosted-testflight-ship.md`.

## 2026-08-23 — Toggle Switch Touch Styling, Account Extended Hours Hints & Active Short Management

1. **Toggle Switch Styling Fix:** Removed `.con-toggle` from the direct `min-height: 44px; min-width: 44px;` coarse-pointer rule that deformed pill toggles into 44x44px round circles on touch/mobile screens; moved the touch target to a centered `::before` pseudo-element expanding tap area to 44x44px while keeping the 36x20px visual pill and 14px slider thumb intact.
2. **Account Extended Hours Hints:** Added helper `getBrokerMarketHours(broker)` and injected explicit market hours (pre-market and after-hours) for schedule and protective stop settings, dynamically customized for the active connected account (e.g. Alpaca 4:00 AM – 9:30 AM ET & 4:00 PM – 8:00 PM ET; Robinhood 7:00 AM – 9:30 AM ET & 4:00 PM – 8:00 PM ET; Tradier 7:00 AM – 9:30 AM ET & 4:00 PM – 8:00 PM ET; eToro regular-only).
3. **Active Open Short Position Management:** Ensured held short positions (`quantity < 0`) remain fully managed with proactive stop-loss covers, take-profit trims, and synthetic stops even when `shortSellingEnabled` is toggled off (which now strictly gates opening new short positions).
Rollout: `docs/rollouts/2026-08-23-toggle-styling-extended-hours-short-management.md`.

The `litestream tier 2 empty wedged` alert was cleared by the L1-suffix heal.
Live root cause: B2 L1 had **4 non-contiguous TXID holes** (`85fd4->92b5`,
`92b7->ad55b`, `ad572->b08a1`, `b08e7->ca40b`), so Compact could not walk L1 into
L2 and L2/L3 sat empty (0 objects) while L1 kept advancing (~560 files).

Heal (ops, no product code, no Coolify bounce): kept the newest **48 contiguous
L1** files, deleted **514 stale L1** files (~1.5 GB) via the **S3 API** using the
container's own `AWS_*` env (the repo heal script's native-B2 key `401`'d — it is
stale).  Never touched L0/L9/cold-snapshots.  Verified from `litestream-runtime.log`:
L2 produced its first object since 2026-08-18 at 17:02:43Z, then kept compacting
every 5m; L3 followed at 17:10:23Z.  L1 post-heal: 0 holes.

`/api/health` clears on the next 30-min remote-inventory collection (the stale
snapshot still said `litestreamTiersDegraded: true` immediately after).

Follow-ups: (1) owner refresh native B2 master key OR accept S3 backend for
`scripts/litestream-l1-suffix-heal.py`; (2) watch L1 stays contiguous (closed
while Coolify stays stop-old-first/no-rolling).  Rollout:
`docs/rollouts/2026-08-22-litestream-l2l3-unwedge.md`.
## 2026-08-23 CURSOR — Full-stack review filed (docs only)

Owner-directed top-to-bottom of website (desktop+mobile), iOS, pipeline, RAG/embed/ingest, recent fills, broker, errors, connections.  Findings on the Mac board + GH #3056–#3067.  Review `docs/reviews/2026-08-23-cursor-full-stack-review.md`.  Live `/api/health` ok sha `2de5856fd`, `tradingLiveness` degraded (~3d).  No product code in this lane.

## 2026-08-22 ANTIGRAVITY — Full system fixes & native iOS website parity (PR pending)

- Pruned dead dependencies (`@xyflow/react`, `lightweight-charts`) from `package.json`.
- Fixed `/console/settings` stale link in assistant chat to `/console/connections#api-keys`.
- Adjusted mobile safe-area bottom offset for `PolicySaveBar` in policy form.
- Standardized API error payloads to `{ error, message }` in proposals approve/reject routes.
- Appended Migration 87 (`composite_query_indexes`) for composite query index optimization across fill events, notification events, and historical fundamentals.
- Embedded interactive `EquityChartView` using native Swift Charts (`import Charts`) into `PortfolioOverviewCard` and `ResultsView`.
- Added haptic sensory feedback (`AppHaptics`) on proposal actions & order cancellations, and exponential backoff with jitter on SSE stream reconnection.
- Verified full verification gates: `npm run lint` (0 errors), `npx tsc --noEmit` (0 errors), `npm test` (677 files / 7,504 tests pass), `npm run build` (succeeded), `xcodebuild build` (BUILD SUCCEEDED).
- Rollout: `docs/rollouts/2026-08-22-full-system-fixes-and-ios-parity.md`.
## 2026-08-22 ANTIGRAVITY — Admin Operations knobs blur-commit & empty-default fallback fix (PR pending)

- Closed Issue #2958: Eliminated per-keystroke PATCH calls and silent fallback overwrites on cleared numeric inputs.
- Unified `OperationsClient`, `TaxSettingsCard`, `LearningReviewCard`, and `StrategyPage` scoring weights to use raw text drafts and blur-commit.
- Added pure resolver functions in `app/console/lib/number-commit.ts` with comprehensive unit tests in `test/console-settings-number-commit.test.ts`.
- Branch: `agent/ag-operations-knobs-blur-commit`. Rollout: `docs/rollouts/2026-08-22-operations-knobs-blur-commit.md`.
## 2026-08-22 ANTIGRAVITY — Hardened SQLite migrations with tableExists and columnExists guards (PR pending)

- Closed Issue #2964: Fixed SQLite `PRAGMA table_info` missing-table trap where non-existent tables returned `[]` and triggered fatal `ALTER TABLE` / `no such table` runtime exceptions.
- Exported standardized `tableExists` and `columnExists` helpers in `src/lib/db.ts`.
- Hardened migrations v2 through v86 against non-existent tables, ensuring full safety on blank schemas, minimal test harnesses, and fresh database initializations.
- Added comprehensive unit tests in `test/persistence-hardening.test.ts` verifying all migrations replay cleanly from scratch on blank in-memory databases.
- Branch: `agent/ag-migration-table-info-guards`. Rollout: `docs/rollouts/2026-08-22-migration-table-info-guards.md`.

## 2026-08-22 CURSOR — Owner ST favicon + ASC listing + Android master

Website tab icon is the owner transparent candlestick ST.  ASC listing PNG is opaque black (`graphics/asc-app-icon-1024.png`).  Android launcher master is the same transparent 1024.  iOS home-screen App Icon is unchanged.  GitHub login callback remains `https://socratictrade.com/api/auth/callback/github` on an OAuth App.  Branch `cursor/favicon-asc-android`.  Rollout: `docs/rollouts/2026-08-22-favicon-asc-android.md`.

## 2026-08-22 GROK — Litestream L2/L3 + cascade last-resort + RAG hydrate (IN PR #3041)

Branch `grok/litestream-cascade-rag` in `~/apps/trading-grok-litestream-cascade`.  Boards 1e3df744 / b88b6675 / f7ffb62f.  Diagnosis: `docs/audits/2026-08-22-cascade-rag-diagnosis.md`.

Live `/api/health` still `storageDegraded` (L2/L3 since 2026-08-18).  Mac heal python is stuck SYN_SENT to B2 after ~2h — do not bounce Coolify.  Do not flip `RAG_PINECONE_WRITE_CLASS`.  Keepout: Claude gather-budget 06df80cf.

Cascade: Yahoo `analystBySource` aliases `analystRating`; WAVE_B drops news; RapidAPI skips news-only; paid Wave B intersects WAVE_B only.  `/api/quote` returns the Yahoo floor after 1.5s quoteSummary grace instead of waiting the 6s cascade.

RAG: PR B + 8-K sidecar + EarningsCalls signal/FTS + analog cards + thin Red pack that **prioritizes 1A/MD&A over facts/Form 4 cards** + hydrate 4k cap + live `chunks.json` + Form4/13F/ARK corpus snapshots.  Deep dossier reserves Item 7 MD&A.  Scout hydrates a capped 1A when local text exists.  Full-body ingest skips extra signal-section Pinecone writes (no write-class flip).  Webpack land blocker: `runtime-health.ts` uses bare `fs`/`http`/`path`.
## 2026-08-22 GROK — Kimi leftover: CT peer intraday uses stored operator token

Re-landed the only unique slice from retired-KIMI ST #3044.  CI/pin-check/lockfile/png deletes from that PR are already on main or harmful.  Peer `/api/market/intraday` now passes `operatorPeerRead` and uses the operator (`local`) *stored* MCP token, not a live `ROBINHOOD_MCP_AUTH_TOKEN` env bypass.  Board `6a7fbecc`.  Branch `grok/kimi-integrate`.
## 2026-08-24 CURSOR — Alpaca Paper Approve greyed after Retry Red Team (MERGED + DEPLOYED)

PR #3049 squash `06a5418b` merged 2026-08-24 09:29Z.  Live sha `dcfd04d72999cfd39bdf8b7351a2e474806944e1` (2026-08-24 ~20:12Z container start) contains the fix (`scripts/verify-deploy-sha.sh 06a5418b` PASS).  CI: `verify` + `verify-hosted` + `ios-build` (unsigned) SUCCESS on the PR.

Owner report: Alpaca Paper pending cards, Retry Red Team hung, Approve greyed.  Paper is `close_only` / Exit-only / Autopilot.

Fixed: (1) web Approve no longer shares `busy` with Retry; iOS `proposal.approve` stays available on a stale snapshot (server re-validates); (2) Retry applies half-size / reject-hold / unavailable-hold (llm-06); (3) owner Approve of an opening in Exit-only is the override — agent still will not open on its own; halted + liquidating still block openings.

**Website + API are live now.**  Docs handoff merged #3087 (`3fcf876e`).  Re-verified 2026-08-24 23:45Z: `verify-deploy-sha.sh 06a5418b` PASS, `/api/health` ok, scheduler 50s.  Alpaca Paper is now `active` / Autopilot (not Exit-only); last Paper runs at 19:54Z are deploy-restart stale-run-sweep failures, separate from this approve fix.

Native iOS Approve/stale-gate + banner cannot ship from this Cloud seat.  `ios-ship.yml` on `macos-latest` dies in ~15s (`missing /Users/jay/apps/ios-fleet/ship-testflight.sh`); last 80 scheduled ticks are red.  Repo GitHub Actions secrets have no App Store Connect key (those stay on the Mac `~/.secrets/appstore-connect.env`).  `ios-build` on #3049 was green (unsigned compile only).  Website / mobile-web Approve is the live path until a Mac or restored fleet-ship runner uploads TestFlight.

Rollout: `docs/rollouts/2026-08-22-alpaca-paper-approve-greyed.md`.

## 2026-08-22 CURSOR — Alpaca Paper Approve greyed after Retry Red Team (IN PR — superseded)

## 2026-08-22 ANTIGRAVITY — Test DB isolation & UI sparkline gradient cleanup (PR pending)

- Isolated test SQLite DB in `test/api-keys-tombstone.test.ts` per repo convention (`agentic-api-keys-tombstone-${randomUUID()}.db`).
- Added `afterAll` hook in `test/encryption-key-guard.test.ts` to unstub envs and reset modules cleanly.
- Resolved React gradient ID collision in `ServerMetricsClient` sparkline chart by switching static `chartGrad` to dynamic `useId()`.
- Rollout: `docs/rollouts/2026-08-22-test-isolation-and-ui-cleanup.md`.

## 2026-08-22 GROK — 5M WU snap + RAG panel MERGED (#3037 `f5500b610`)

Honor 5M monthly until 2026-08-27, then snap 60k/20k/1.6M.  Cursor #3038 stacked (numberless monthly-WU 429s ignored during trial).  Live `/api/health` still `a84ce0bed` — not Deployed yet.

Expert panel: highlights/signal/analog in Pinecone; full files local.  Cut: `docs/audits/2026-08-22-panel-synthesis.md`.  Do not flip write-class until PR B.  Builder only if §5 gates pass.  Boards 603fef7b / 596abb59 completed.

## 2026-08-21 CURSOR — local Grok kickoff for adaptive-tabs screenshots

Cursor local is down.  Paste-ready Mac brief: `docs/rollouts/2026-08-21-ios-adaptive-tabs-mac-qa.md`.  Grok starts from `origin/main` in a new `~/apps/trading-grok-tabs` worktree (do not clobber `~/apps/trading-grok-drain`).  Launch DEBUG with `-ASCScreenshots`.  Do not redo B/C/D.  #3027 is optional (`origin/main` merged onto it) -- shots do not wait on it.

## 2026-08-21 CURSOR — adaptive-tabs leftover B: LayoutMathTests.swift + Mac xcodegen

Independent re-check of `docs/rollouts/2026-08-21-ios-adaptive-tabs-followups.md`: items C, D, and the XCTest half of A were already on `main` (#3023 `7ba178e1`, #3012 `c614391c`, Mac job 32529663287 `success`, 232/0).  Item B was still open.  PR #3027: file is `ios/SocraticTradeTests/LayoutMathTests.swift` (class names unchanged).  Mac job 32534166394 `success` (xcodegen 2.46.0, BUILD/TEST SUCCEEDED); generated pbxproj committed from the artifact.  Merged `origin/main` `b2ca4c14` into this branch (`a37a7b2e`); GitHub DIRTY state was an auto-merge of EFFORT-LOG + `.gitleaksignore`, both sides kept.  Do not block screenshots on it.  Screenshots / auto-fill veto / knobs need a local Grok Mac seat (Cursor local is down).  Paste-ready brief: `docs/rollouts/2026-08-21-ios-adaptive-tabs-mac-qa.md` -- start from `origin/main` in `~/apps/trading-grok-tabs`, not the drain worktree.  Rollout: `docs/rollouts/2026-08-21-ios-layout-math-tests-rename.md`.
## 2026-08-22 CURSOR — PR #3028 merged to `main` (iOS wide layout / Admin tab / gear-bell)

Squash `a851a68d` (`a851a68da16b9c7ec722897a3ab4f378e0117111`) at 2026-08-22 01:14:36Z.
https://github.com/jaywedgeworth22/Socratic.Trade/pull/3028

Shipped on `main`: regular-width `.sidebarAdaptable` TabView plus the existing card-column
scaffold; compact keeps the phone bar; `gearshape` trailing on every tab; bell leading
opens the Activity notification inbox; Assets price-alert composer removed; Admin Portal
is an `isAdmin`-gated `AppTab` with a native rail and a fenced WKWebView that intercepts
`/console`.

iOS-only.  `ios/**` is outside Coolify `watch_paths`.  No Coolify bounce.  Do not label
this Deployed to production.  TestFlight is separate and only if the owner wants it
(`scripts/ios-ship-testflight.sh`); this close-out did not ship.

Confirmed CI (`gh pr view 3028` + `gh run list` / `gh run view`): `ios-build` 32536626553
on earlier SHA `b747872d` was 237 XCTests / 0 failures.  Later rematch head `8471509c`
failed `ios-build` 32541612565 (`invalid redeclaration of 'NotificationHistoryRow'`).
Owner fix `ac9bafd5`.  PR head `04300371`: CI 32541767856 success (`verify` +
`verify-hosted`); `ios-build` 32541767843 success.  Squash-push `ios-build` 32542852732
success (unsigned xcodebuild job; XCTest count not re-read from that log).  Merge-push
CI 32542852729 cancelled.  TestFlight ship workflow 32542852734 failed; not retried.

Rollout: `docs/rollouts/2026-08-21-ios-wide-layout-admin-tab.md`.

## 2026-08-21 CURSOR — iOS wide layout, Admin tab, gear/bell chrome

Owner ask: iPad Air 11" / variable Mac windows, settings gear top-right on every tab, larger
settings sheet on iPad/Mac, Admin Portal as an admin-only tab on all devices, delete Assets
price alerts, bell top-left for notifications, and stop Admin "Back to Console" from loading
the website inside the native webview.

PR #3028 (`cursor/ios-wide-layout-admin-tab-0e2b`).  Regular width uses `.sidebarAdaptable` TabView
plus the existing card-column scaffold (reflows when a Mac window is dragged).  Compact keeps
the phone bar.  Gear is `gearshape` on every tab; bell opens the same notification inbox as
Activity.  Admin is a first-class `AppTab` gated on `currentUser.isAdmin`; native rail of the
eleven website admin pages with a fenced WKWebView that intercepts `/console`.  Linux VM has
no xcodebuild — first Swift compile is CI.  iOS-only; no Coolify deploy.

Head after owner `origin/main` merges: `472f3cfe` (pulled in #3032).  CI on that SHA was green:
`verify`/`verify-hosted` run 32540455277 success; `ios-build` run 32540455303 success (unsigned
xcodebuild + simulator tests).  Auto-merge is armed.  While that CI ran, #3031 landed on
`main` (`d588387b`) and GitHub went CONFLICTING.  Real conflicts in `ActivityView.swift` and
`MobileControlView.swift`.  Resolution: keep #3031's five Activity sections; keep this PR's
`NotificationsInboxView` (Unread/All bell sheet); Assets More copy stays without price alerts.
Do not TestFlight from this PR.

Rollout: `docs/rollouts/2026-08-21-ios-wide-layout-admin-tab.md`.
Local receipts: `npm run lint` 0 errors, `npx tsc --noEmit` clean, `npm run build` ok.
Local `npm test` aborted (network 404s / single worker); CI `verify` is the JS test of
record.
## 2026-08-21 CURSOR — Activity layout redesign (Alerts Center first)

Owner: Activity/Runs were headache-inducing.  Website + iOS Activity are now five Title Case tabs in this order: Alerts Center, Notifications, Strategy Runs, Order Fills, Audit Log.  Default Alerts Center.  Former All unified feed is Audit Log.  Failed runs show wrapping English.  APNs is auto-included when the user has a live device.  Admins get system alerts.  Alpaca session close is no longer stamped Delayed Quote.  Push `?tab=` is additive so another agent's deep-link pairing is not smashed.

PR #3031 on `cursor/activity-layout-redesign-085b`, squash `d588387b` on `main`.  `ios-build` green (233/0).  Merged.  Do not HOTFIX during RTH.  Rollout: `docs/rollouts/2026-08-21-activity-layout-redesign.md`.
PR #3031 merged to `main` as squash `d588387b` at 00:47:48Z.  `verify` + `ios-build` were green on `0e2d4dcf` (233 XCTests / 0 failures).  Live `/api/health` at 00:49Z still served `c6f33086` (#3032) — website auto-deploy is queued, not claimed.  iOS ships only via TestFlight.  Rollout: `docs/rollouts/2026-08-21-activity-layout-redesign.md`.

# Current Status
## 2026-08-21 GROK — Stop paging Starter 2M Pinecone write units

Owner: the 2M monthly write-unit pages keep firing and ingest should continue.  Live Pinecone is a Standard trial (unlimited WUs, $300, 21 days from 2026-08-09).  Infisical daily fuse is already 5M; monthly budget was unset (off).  #2799 ignored 2M only when the error body contained `429`; Pinecone's official monthly-quota text often does not, so hourly `Pinecone connection failed` still went out.

Matcher now treats the monthly-quota phrase as WU exhaustion.  Breaker parks only when `PINECONE_MONTHLY_WU_BUDGET` is set.  After the trial calendar, Infisical knobs stay (no invented 1.6M Starter wall).  Branch `grok/pinecone-wu-cap`, worktree `~/apps/trading-grok-pinecone-wu`, board `7b0bf414`.  Rollout: `docs/rollouts/2026-08-21-pinecone-wu-no-starter-wall.md`.
## 2026-08-21 GROK — website login provider family (leftover after #3008)

Owner: make Apple / Google / GitHub one branded family.  iOS did that in #3008
(Google Light/Dark chrome, official marks, custom Apple button).  The website
still painted a teal Google button (`bg-accent` + color G — a Google Don't) plus
an outlined GitHub and a black Apple.  Shared `.login-provider-btn` now matches
the iOS metrics and colour table.  Branch `grok/login-unify-web`.  Board
`02b5cf01`.  Rollout: `docs/rollouts/2026-08-21-web-login-provider-family.md`.

## 2026-08-21 MONET - handoff written: quiescent-cutover deploy (design only, unclaimed)

Owner asked to drop the daytime deploy ban and instead cut over only when nothing is mid-flight.
Design handoff written rather than improvised into the deploy path of a live trading app.

The note leads with the constraint that decides the whole design: this is a SINGLE-WRITER SQLITE
process, so two containers cannot run at once and literal blue-green is off the table.  The
achievable promise is "never cut a run in half", not "zero downtime" -- and those are different
promises that should be agreed with the owner before anyone builds.

It also corrects a premise (the build never stopped the container -- the build itself was refused),
records what already exists so it is not rebuilt, and flags that `hasInFlightStrategyWork()` is
unscoped and unbounded, so one stuck 'running' row would make the app never quiescent.

One decision is deliberately left to the owner: what happens when the drain cap expires with a
run still in flight.  That is a real-money risk call and it is the whole point of the feature.

## 2026-08-21 CURSOR — adaptive-tabs follow-ups: unhang ios-build + run XCTests

Nobody had claimed `docs/rollouts/2026-08-21-ios-adaptive-tabs-followups.md`.  Remote Control cannot start this work: Cursor wants a private worker and this repo has none (failed agent `bc-c04cab0c`).  Hosted Linux did the CI slice.

PR #3023 merged to `main` as squash `7ba178e1` at 22:00:50Z.  Mac job `xcodebuild (unsigned)` concluded **success** in ~2 minutes (run 32529663287): BUILD SUCCEEDED, TEST SUCCEEDED, 232 XCTests / 0 failures including all 30 `TabPreferencesTests`, simulator iPhone 17 Pro.  Hang gone.  Item D already on `main` (#3012); vitest locks the pbxproj line.  Screenshots, the `WrappingHStackTests.swift` rename, and the auto-fill veto still need a Mac or the owner.  `ios-build` can now be made a required check (board `830c892f`).  Rollout: `docs/rollouts/2026-08-21-ios-ci-unhang.md`.

## 2026-08-21 CURSOR — Scan card tap + honest iOS last/next run

Owner: whole scan card opens company info; iOS company name darker than industry; Roth IRA Home said "not scheduled" for Last Run and Next Run on Autopilot.  Last run now comes from `strategy_runs` (never cadence copy).  Next run is filled for an active account even after restart / cash close.

PR #3019 on `cursor/ios-scan-card-schedule-e224`, rebased/merged onto `origin/main` `e3278a5f`.  iOS ships via TestFlight only.  API half needs a post-close (or HOTFIX) deploy for live Home stamps.  Rollout: `docs/rollouts/2026-08-21-ios-scan-card-schedule.md`.

## 2026-08-21 CURSOR — strategy gather timeout all day (Roth + Paper)

Ops snapshot 19:18Z: scheduler ticking, LLM keys present, last completed runs 2026-08-20 20:16Z (Roth) and 20:22Z (Paper).  Today every recent run is `failed · strategy gather timeout` (Paper 27 consecutive, Roth 12) plus a few stale-run sweeps on process restart.  Live sha `e0a4959a73a7` (started 19:06Z) is still the RTH-latched image — #2852/#2854 are already in that sha.

Root cause is the 8-minute gather `withDeadline` racing without an AbortController.  Timed-out Nasdaq/enrichment/broker walks keep running; the next account starts another full scan; the pile-up makes every later gather miss 8 minutes.  `market-scan-freshness` avg 115s / max 66m is the same scan competing on the event loop.

Fix: abort the abandoned gather, stop cascade/enrichment waves on that signal (including the keyed Finnhub wave — Wave B, free-tier key, not a paid Finnhub plan; the first revision dropped `signal` on `paidContext`), and if a last completed tape exists continue the run with that real scan plus a 45s quote refresh so Green can start.  Do not HOTFIX during cash hours — merge waits for the after-close drain.

Owner rematch of `origin/main` (#3008 / #3019) left `<<<<<<<` markers in the rollout Verification block.  Those are resolved on this branch.  Required `verify` must be green on the current head before squash-merge.  Parent owns Coolify.

Rollout: `docs/rollouts/2026-08-21-gather-timeout-abort.md`.

# Current Status

## 2026-08-21 GROK — RTH drain actually nudges Coolify

Live sha e0a4959a73a7 is 39 commits behind main.  Weekday Coolify builds are RTH-latched on purpose (keep last healthy container).  The 21:20 UTC drain then exited 0 without a nudge because GITHUB_TOKEN cannot redeliver hooks and COOLIFY_DEPLOY_WEBHOOK_URL was unset.

Drain now uses GH_PAT for redeliver, Coolify /api/v1/deploy with COOLIFY_DEPLOY as fallback, and fails the job when neither works.  Do not HOTFIX during cash hours.  Next after-close drain (or workflow_dispatch after 16:00 ET) should advance live sha.

Rollout: docs/rollouts/2026-08-21-rth-drain-nudge.md.  Board 99ab01c7.

# Current Status

## 2026-08-21 CURSOR — native weekly value + momentum screens

Option 3 of the Perplexity-ritual ask: ST now builds those weekly screens from its own tape.  Value = large-cap ≥ $10b, price > $5, volume ≥ 500k, trailing P/E > 0 and ≤ 10, within 10% of the 52-week low.  Momentum = the same floor ranked by 5-day return, with ROC/RSI/MAs when bars exist.  Full `quotesBySymbol` universe (not the ranked cut).  Missing fields exclude the name.  Dashboard is cache/value-only; scheduler + `GET /api/scan/weekly-digest?refresh=1` do the bar work.  Cards on Macro + Scan; thin iOS Scan card; Green gets `weeklyScreens` as advisory DATA (`agentic-strategy@2.15.0`).  No Perplexity scrape/key, no auto-trade, no scoring/policy change.

**Risk:** first Swift compile is CI-only.  Momentum is empty until grouped-daily or per-symbol OHLC lands.

PR #3009 (`cursor/weekly-market-screens-2b0c`) is rebased onto `origin/main` `86773171` (#3010 deploy-latch CJS fix).  Cloud-proxy pushes do not fire `pull_request`, so `verify` is dispatched via `workflow_dispatch`.  Rollout: `docs/rollouts/2026-08-21-weekly-market-screens.md`.

## 2026-08-21 MONET - P0: deploys have been failing for ~5 hours, prod serving stale code

Every deployment from 2026-08-21T05:07Z onward failed on a top-level await in
scripts/assert-rth-deploy-latch.ts, so the day's merged fixes -- including money-path changes --
never reached production.  The running container kept serving healthy, so nothing external showed
a problem; it was found only by reading Coolify diagnostics while chasing something else.

package.json declares "type": "module", but the Dockerfile runs the latch at line 53 and copies
package.json at line 54 -- deliberately, so a docs-only no-op fails in seconds rather than after a
30-minute npm ci.  tsx therefore sees no package.json, falls back to CJS, and a top-level await is
fatal there.  It runs fine locally and fails only in the image, which is why it shipped.

Fixed by moving the await into an async main() with a catch that exits 1, so a crash can never
silently allow a build.  A regression test now parses the Dockerfile and transpiles every
build-time script that runs before package.json exists.

VERIFY AFTER MERGE: the next deployment must succeed and the live sha must advance past 313603752.

## 2026-08-21 CURSOR — three-column LLM catalog (display / OpenRouter / native)

Owner table is now the single catalog in `src/lib/llm-model-catalog.ts`.  Settings, pickers, logs, and iOS Coach store **display slugs**.  Live OpenRouter calls send column 2 via `normalizeOpenRouterModelId` / `openRouterSlugFor`.  Direct-provider stubs use `nativeSlugFor` so a future native path cannot send an OpenRouter vendor path.  Older persisted ids (`gpt-5.4-mini`, `claude-sonnet-5`, `grok-4.5`, `deepseek-v4-flash`, `gemini-3.5-flash-lite`, …) alias onto the new display slugs.  Models not on the owner list are no longer advertised.  Congress.Trade has no cheap parallel catalog in a Cursor CT lane — follow-up only.

**Risk:** some owner wire slugs (untilded `*-latest`, `google/gemini-flash-latest`, period-form `mistralai/mistral-medium-3.5`) may 404 on OpenRouter today.  Owner said do not keep sending the dated ids the table replaced.

MERGED to `main` as #3003 squash `36f0a3c8` at 09:56 UTC (auto-deploy).  Rollout: `docs/rollouts/2026-08-21-llm-model-slugs.md`.
## 2026-08-21 MONET - web adopts iOS's Title Case, closing the parity work

The web half of iOS/web parity.  Web was the drifted side on four of the 21 audited divergences: the fleet copy doc names "Run Once", "Price Alerts", "Current Policy" and "Win Rate" as canonical and every one of those is the iOS spelling.

The distinction that mattered: run STATE words are values and stay sentence case on both platforms.  "Winding down" and "Exit-only" were deliberately untouched, and derive.ts's RunStateWord union is unchanged.  Title-Casing a state word because the button beside it is Title Case would have desynced web from iOS in the opposite direction.

Also reversed one implementer decision on review -- "Wind Down - This Sells" back to "Wind Down - this sells", because the appended clause is a warning phrase rather than part of the control's name.  The Title Case rule governs what a control is CALLED, not everything printed on it.

## 2026-08-21 CLAUDE - adaptive tab bar MERGED; the unfinished half is written down

PR #2987 merged to `main` as `9298c29` at 06:56 UTC.  Owner ask delivered in full: more than
four tabs on iPad and wide Mac windows, fall back to the defaults when too narrow, Home
required, the slot before More swapped out by whatever is opened from the More list, plus the
iPad Air 11" layout pass carried into Mac Catalyst.

No deploy fires - `ios/**` and `docs/**` are both outside Coolify `watch_paths`, and the iOS
app only changes when the TestFlight ship script runs.

**Three things the merge does NOT prove, and I would rather they be loud than tidy:** the 45
XCTests are compiled but have never been executed (nothing in this repo runs `xcodebuild
test`); there is no screenshot of the new iPad layout; and `xcodebuild (unsigned)` hangs on
every iOS PR (PR #2794 has the identical `cancelled` outcome), which is a runner-side
`SWBBuildService` pipe hang that raising the timeout would not fix.

Handoff with all six open items, each claimable on its own:
`docs/rollouts/2026-08-21-ios-adaptive-tabs-followups.md`.  Items A, B and D need a Mac -
a cloud session cannot do them, those containers are Linux and hit the same wall.

## 2026-08-21 CLAUDE - the tab bar now knows how wide the window is

Owner ask: more than four tabs on iPad and on a wide Mac window, Home required, and the slot
before More swapped out by whatever you open from the More list.  All four are in, plus the
iPad Air 11" layout pass they asked for on top.

`TabBarCapacity` turns the live width into a slot count: compact width keeps four, iPad Air
11" gets six portrait / eight landscape, and a Mac window recomputes as it is dragged.  Home
can no longer be unpinned.  The slot before More is borrowed - opening a screen from More
takes it, pinning that screen makes it permanent and gives the slot back - and More carries an
aggregate badge so a displaced Activity's unread count never vanishes.  Too narrow for the
chosen set falls back to the DEFAULTS and writes nothing, so widening restores the owner's
picks exactly.

One decision worth flagging because it is not literally in the ask: until the owner pins or
unpins anything the bar AUTO-FILLS to what fits.  Without it a fresh iPad would still show
four tabs and the feature would only exist for someone who went looking for it.

Layout: `SnapshotScaffold` picks 1/2/3 card columns from its own measured width, and one
column is the existing `LazyVStack` untouched - the iPhone is deliberately unchanged.  Cards
drop into the shortest column; the freshness banner and each screen's hero span.  Six
hardcoded two-column metric grids now widen with the CARD they sit in rather than the screen.
Coach keeps a readable measure instead of stretching a chat to 1148pt.

**The Swift compiles** - the Mac runner printed `** BUILD SUCCEEDED **` twice on this branch
(05:22:30 and 06:21:48), and `verify` is green.  Nothing could be compiled locally: this is a
Linux remote container with no xcodebuild, swiftc, xcodegen, or simulator, and the repo's
four-command gate compiles no Swift anyway.

**The `xcodebuild` CHECK still reads `cancelled`, and it is not this change.**  I got the
reason wrong the first time and said a cold cache made the build overrun the 30-minute
timeout; the second attempt built in 21 minutes with nine minutes to spare and was cancelled
anyway.  The step never exits after xcodebuild returns - `SWBBuildService` outlives it,
inherits the step's stdout pipe, and the runner waits on the pipe.  Raising the timeout would
not fix it.  PR #2794 (someone else's iOS PR, merged to main at 04:35 the same day) has the
identical `cancelled` outcome, so this is red on base too; it merges because `ios-build` is
not a required check.  Proposed patch (redirect xcodebuild output to a file so the daemon
inherits a file, not the pipe) is in the rollout note - NOT applied, it is CI infrastructure
outside this ask and affects every iOS PR.

**Still open, stated plainly:** the XCTests are compiled but have never been executed
(`ios-build.yml` runs `xcodebuild build`, not `test`), there is no screenshot, and the
`WrappingHStackTests.swift` -> `LayoutMathTests.swift` rename needs `xcodegen` on a Mac.

Rollout: `docs/rollouts/2026-08-21-ios-adaptive-tabs-ipad-layout.md`.
## 2026-08-20 CLAUDE - login screen: hero wordmark, one set of provider buttons, fuller legal copy

Owner screenshot review of the iOS sign-in screen.  Four changes, mirrored on the website login where the surface is shared: a new first value bullet ("Configure strategic framework and guardrails"), the candlestick wordmark scaled from a 24pt top-bar glyph to a headline that fills the content column, all three provider buttons rendered at identical width/height/radius, and the owner's expanded disclaimer (account at SocraticTrade.com, Terms/Privacy linked below, AI output not guaranteed though the framework is user-defined, educational/experimental/informational use only).

The Apple button was narrower than the other two for a concrete reason worth recording: `ASAuthorizationAppleIDButton` hard-caps its width at 375pt, and the login content column was 400pt.  Fix is to narrow the column to 352, not to stretch the Apple host -- a prior comment in `LoginView.swift` already warned that stretching it past the cap trips unsatisfiable autoresizing constraints.

Label-size parity inside the Apple button is NOT achievable without replacing it with a custom control, which would put Sign in with Apple branding compliance on us at App Review.  Google/GitHub labels went 15 -> 17pt medium to close most of the gap; the remaining difference is Apple's own.

Verified with a simulator screenshot, not just a green build.  Copy and layout only -- no auth, session, or order path touched.  Rollout: `docs/rollouts/2026-08-20-login-hero-and-legal-copy.md`.

## 2026-08-20 DEEPSEEK - full-stack review: desktop web, mobile web, iOS (zero-code)

New fleet seat; lane `~/apps/trading-deepseek` on `deepseek/lane`; board umbrella `682e7e3467cd4def97a13ee67335cbb1`.  Top-to-bottom review of the console site (desktop + phone widths) and the native iOS app, complementing the 2026-08-18 expert review and the open Kimi board findings.  Headlines: (1) prod is 8 commits behind main (live `e0a4959a` vs `41a7a438d`; live login page still ships the 1 MB pre-crop icon — mobile LCP 8.3 s vs desktop 1.0 s); (2) the merge ruleset requires only `verify` — ios-build is not a gate (board 830c892f, fix is a one-line ruleset change); (3) CSP is report-only with unsafe-inline/unsafe-eval; (4) no custom 404 pages — `/console/proposals` renders Next's stock 404; (5) all three OAuth providers hardcode `redirectTo: "/"` so sign-in drops deep-link destinations; (6) state checks: riskRules decoder fix + sign-out session clearing are on main (89249c60/3b343933 need board state updates); privacy manifest still absent (410bda84).  New findings filed: da8a93bf (404s), 34b8fbe7 (CSP), 436a9b98 (prod lag + icon).  Full outline: `docs/reviews/2026-08-20-deepseek-full-review.md`.  Docs-only PR; no code changed.

## 2026-08-20 MONET - iOS/web parity resolved case by case, not synced one way

Owner instruction was explicit that neither platform is assumed superior, and the audit bore that out: of 21 divergences, 9 adopt web, 6 KEEP BOTH, 4 adopt iOS, and 2 needed a third wording because both sides were wrong.  A blanket sync would have been wrong on 12 of 21.

Web turned out to be the drifted side on Title Case -- the fleet copy doc names "Run Once", "Price Alerts", "Current Policy" and "Win Rate" as canonical, and every one of those is the iOS spelling.

Two of my own instructions were wrong and the implementer pushed back rather than complying: unhyphenated "Exit Only" is a consistent COMMAND name (parallel to "Wind Down"), not an orphan spelling, because the app deliberately runs Title Case commands alongside sentence-case state words -- and it then found the identical casing defect the audit had missed.  It also caught that renaming only the read-only Guardrails rows would have left the EDIT controls on the same screen calling one field by a different name.

Known limit: every screen changed sits behind the OAuth login wall, so there is no visual proof of the changed screens -- only BUILD SUCCEEDED, 190 passing iOS tests, and a clean launch.
## 2026-08-20 MONET - timed-out work is now cancelled, and slow lanes stop spawning duplicates

`withDeadline` was a bare Promise.race: on timeout the caller proceeded while the underlying broker call kept running with its socket open for the life of the process.  That is the leading candidate for why an aged process degrades (fresh serves /api/health in 0.61s, a 5h-old one took 55s).  It now aborts on the timeout branch only.

More serious: both scheduler in-flight guards released on the RACED promise rather than the real work, so any broker lane slower than the 15s deadline got a duplicate launched on top of it every 60s tick, forever -- on the stale-exit lane that means duplicate remediation attempts against LIVE ORDERS.

Order placement, cancel and replace are deliberately NOT abortable, enforced structurally by never passing a signal on those paths -- an aborted placement may still have reached the broker.

Honest scope: this removes a leaked-work accumulator and a duplicate-launch path.  It is NOT proven to be what stopped runs completing; that still needs one production query (see #2967).

One premise from the investigation did not hold and was deliberately not implemented: the Alpaca gateway has no fetch to thread a signal into, and the obvious axios-interceptor workaround attaches to a different module instance than the bundled SDK uses.  Filed as #2970 rather than shipping something that silently does nothing in production.

## 2026-08-20 MONET - `realized-pnl-ledger` up for review

Accounting reads no longer take the OLDEST 500 fills.  `listFillEvents` defaults to the whole ledger; a numeric limit remains for display windows and returns the NEWEST N.  I rejected the cluster plan's "flip to newest-DESC everywhere" - for a stateful FIFO replay, truncating at either end is wrong: cutting the tail freezes P&L, cutting the head strands exits whose opening lot was never loaded.

**Two members bite TODAY, independent of ledger size:** the tuner's `recentFills` was a LEADING slice of an oldest-first array, so the paid LLM review argued weight nudges from the account's FIRST 20 trades under a "recent" label; and decision grading resolved on the first partial exit, scoring a -$100 round trip as a +$40 win.  Both fixed with failing-first proof.

**`perf-11` is deliberately NOT closed** - regrouping win rate from per-lot to per-round-trip changes a number feeding every scorecard, the Kelly payoff split, the conviction calibration and the tuner's weight-shift gate at once.  `aggregateRoundTrip` is now exported as the primitive it needs, but the grouping key is an owner decision.

Rebased onto merged #2950; three overlaps hand-reconciled (both sides' `PerformanceSummary` fields kept - a textual merge would have dropped one).  Gate: lint 0 errors, tsc clean, 7205 tests, build 0.  Rollout: `docs/rollouts/2026-08-20-realized-pnl-ledger.md`.
## 2026-08-20 CURSOR-BUGBOT — #2853 drain adopt steals a frozen-but-live Manual Run

#2853 adopted a `strategy_run_requests` row when the in-process heartbeat was older than 90s.  An event-loop freeze (SQLite `busy_timeout` 60s; measured >120s back-to-back) stops the 15s beat without killing `runStrategyOnce`.  Drain then `releaseStrategyLock` and starts a second gather/place on the same run id.  The still-running worker can already have passed `assertOwned` before `placeEquityOrder`, so the adopted run double-places.

Fix: treat a map entry on this process as live, regardless of beat age.  Only a missing entry (process restart) is an orphan.  Rollout: `docs/rollouts/2026-08-20-drain-adopt-live-heartbeat.md`.
## 2026-08-20 MONET - the two-space sentence rule now renders on the web

The defect was not missing gaps in source.  Two literal ASCII spaces typed into JSX collapse to ONE at render, so the source looked compliant and the screen was not -- which is exactly how this stayed broken while looking fixed.

Measured 698 real violations across 73 files (the review estimated ~600) and fixed 652.  The 46 remaining are entirely inside files held by peer PRs #2795 / #2793 / #2828.  `scripts/copy-rules-lint.mjs` ships with the fix and asserts on RENDERED output via a renderCollapse() implementation of the CSS whitespace rule, so this cannot silently regress.

Worth knowing for anyone doing mass regex edits on TSX: building the fixer produced three bugs in the fixer, and only running the app's test suite caught them.  Two altered executable code, one corrupted numbered headings on the public legal pages.  Do not trust a non-AST regex pass on source without running the tests.
## 2026-08-20 MONET - LLM cost is now the provider's number, not our price table

The review told us to add `usage:{include:true}` to every OpenRouter request.  That parameter is deprecated and inert -- usage is always returned now -- so it was deliberately NOT added; adding it would also risk the endpoint-filtering 404 class, since `require_parameters:true` filters on advertised request fields.  The real defect was read-side: `usage.cost` was arriving on every response and being thrown away.

The number that justifies the work: on 100k in / 20k out of claude-opus-5 the price table said $1.00 where the transport billed $0.25.  A 4x overstatement on a single call, and the whole Usage page was derived from that table.  Billed and estimated are now separate columns and separate sums, never added together and labelled billed.

Also landed in the same change: late post-soft-timeout replies are metered rather than only audited, the approval receipt no longer claims "not a failover" when a fallback actually answered, rotation reads the live catalog instead of a hardcoded dead list, and the Red Team payload is compacted to its documented subset.

Two defects found that the review did not have: migrations 2 and 14 use `PRAGMA table_info` as an existence check (returns empty, not an error, for a missing table -- filed #2964), and a test fixture matching on a substring of the entire payload caused genuine cross-test contamination.

## 2026-08-20 MONET - R2 is not storing one week; the B2 restore is proven

Owner asked why R2 exceeds a one-week snapshot.  `socratic-trade-bucket` holds TWO unrelated sets: `cold-snapshots/app-<date>.db` (LIVE weekly second-provider DR, retain 1, DB ~4.2 GB) and `trading-live/**` - the ENTIRE pre-cutover litestream replica kept since active replication moved to Backblaze B2 on 2026-08-07, including the ~90k-object L1 backlog the config itself notes.  The second set is the surprise, and it is now prunable: the owner confirmed the B2 restore has been PROVEN, lifting the config's own blocker.

**FOOTGUN before anyone prunes:** both replicas use the IDENTICAL object path `trading-live/app.db`; only bucket + endpoint differ (R2 `socratic-trade-bucket` = dead/prunable, B2 `jays-socratic-trade-eu` = LIVE).  A prune against the wrong endpoint destroys the active backup.  `cold-snapshots/` must survive.

Prune NOT executed here - no object-level R2 delete tooling and deleting backups needs an explicit human decision.  Runbook in `docs/rollouts/2026-08-20-r2-historic-prune-unblocked.md`.
## 2026-08-20 MONET - the operator page tree had no server-side gate

Confirmed, not inferred: every file under `app/admin/**` had zero executable auth checks, and middleware authenticated and allowlisted but never checked admin role.  Any authenticated allowlisted user could load the full operator tree; only the individual data probes 403'd, so a non-admin saw all the chrome and structure.  Now gated once at the edge for `/admin` and `/admin/**`, sharing one predicate with `requireAdmin` so the two cannot drift.

Corrected the review while fixing it: `/api/chat-history` is the shared Coach history read by web AND iOS, not an admin endpoint missing a gate -- gating it would have broken chat for every non-admin.  Added a separate cross-user admin transcript route instead, which makes the nav's "every chat turn" label true rather than needing a reword.

Exploitability today is narrow (with an empty ALLOWED_EMAILS only the primary operator can authenticate, and primary is always admin).  It matters the moment a second allowlist entry exists.  Recorded so nobody reads it as a live breach.

Presentation half of that cluster stays open and belongs to #2795 / #2793.

## 2026-08-20 CURSOR-BUGBOT — owner-cancel protective-stop tombstone on cancel timeout

#2949 only wrote the do-not-replace tombstone after `cancelEquityOrder` returned.  #2886's 30s cancel deadline can throw after the broker already accepted the cancel.  Reconcile then treated the cancelled stop as a stale resting row and re-placed protection the owner had just removed.

Fix: persist the tombstone on cancel throw when the order is a tracked / app-managed protective stop.  Leave the tracked row if the ACK was lost.  Rollout: `docs/rollouts/2026-08-20-owner-cancel-stop-tombstone-timeout.md`.
## 2026-08-20 CURSOR-BUGBOT — Alpaca MCP getEquityOrders hid just-filled orders

#2886 scoped REST `getEquityOrders` to open + 24h closed, but the MCP success path still called `get_orders` with `status:"open"`.  `ordersListIncludesTerminal` stayed true, so `reconcilePlacementError` / `flagStalePlacingIntents` treat a missing refId as never-placed.  A market fill that leaves `open` before the place deadline returns is then safe-to-retry — a second submit.  REST-only Alpaca is fine.  MCP now requests `status:"all"` (bounded 500).  Rollout: `docs/rollouts/2026-08-20-alpaca-mcp-orders-include-terminal.md`.
## 2026-08-20 MONET - console numeric fields commit on blur, and stop writing a fallback

Two console numeric fields PATCHed on every keystroke and wrote a fallback value when cleared.  On a real-money app those are risk/strategy knobs, so the silent wrong write was the harm.  Fixed to local draft + commit on blur; blank or unparseable now commits nothing and reverts to the last saved value.  No confirmation ceremony added -- guardrail values stay the owner's adjustable preferences.

Test strength is stated honestly rather than overclaimed: the commit decision is tested behaviorally through exported pure functions, but the blur wiring is asserted against source text, because the repo has no DOM test tooling and adding a harness is its own decision.

Third site with the identical bug (`app/admin/operations/operations-client.tsx:208`) filed as #2958 and NOT fixed -- peer PRs hold that area.

## 2026-08-20 CURSOR-BUGBOT — #2953 peer quotes/intraday 401 at the edge

#2953 added `/api/market/quotes` and `/api/market/intraday/[symbol]` on the same
`APP_B_INGEST_TOKEN` path as `/api/market/prices` and `/api/market/spx`, but the
middleware bearer pass-through stayed on those two older paths.  A peer call with
only the ingest token never reaches `verifySecuritiesImportToken`; the edge
returns 401.  CT swallows 401s and falls back, so wiring the FMP replacement
would keep writing `missed_window` with no visible auth error.

Fix: extend the existing pass-through.  `/api/market/flatfile` stays session-gated.
Handlers still validate the token.  Rollout:
`docs/rollouts/2026-08-20-peer-quotes-intraday-middleware.md`.
## 2026-08-20 CURSOR-BUGBOT — #2953 intraday provider failure must be 502

`GET /api/market/intraday/{symbol}` documented that empty `bars` means a confirmed empty window and that only non-200 is a provider failure.  `fetchIntradayBars` returned `null` for credential miss, HTTP 403/timeout, AND a genuine empty Alpaca page, and the route mapped `null` to `200 { bars: [] }`.  Congress.Trade therefore treated an Alpaca 403 the same as a weekend and skipped its fallback — the same silent `missed_window` blanking #2953 was shipped to stop.

Fix: discriminate `ok` vs `unavailable`.  Confirmed empty stays 200 `[]`.  Provider failure is 502.  Did not touch #2957 middleware, #2947, or #2952.

**IN PR.**  Branch `cursor/intraday-provider-fail-502`.  Rollout: `docs/rollouts/2026-08-20-intraday-provider-fail-502.md`.

## 2026-08-20 CLAUDE — ST->CT price service (PR pending, DO NOT MERGE YET)

FMP is banned for market data (owner ruling 2026-08-20); it stays valid only as a
latency-race competitor being timed.  New `src/lib/market-realtime.ts` plus token-gated
peer routes `/api/market/quotes` and `/api/market/intraday/[symbol]` replace it for CT.
Intraday bars are the important half: CT schedules snapshots retrospectively, so a live
quote can never honestly answer a past due-time.  Robinhood first, Alpaca fallback,
delayed Yahoo opt-in and flagged.  ROIC rejected (daily-only, 4h cache).

Gates: lint 0 errors, tsc clean, 639 files / 7191 tests, build ok.

BLOCKER: production recovered from the 08:17Z outage on the LAST GOOD IMAGE (77d7d7b6)
and is four merges behind origin/main.  Do not add a build to that queue until it
catches up.  Receipt: `docs/rollouts/2026-08-20-ct-price-service.md`.

# Current Handoff

## 2026-08-20 MONET - iOS test target compiles again, three stale tests fixed (owner-directed)

`xcodebuild test` was failing at BUILD on clean main (5 errors - `MobileModelsTests` encoded a `Decodable`-only `MobileSnapshot`), so no iOS test ran at all and three stale `DeskModelsTests` assertions sat invisible.  That is `qa-01`/`qa-02` from the review happening for real: the required gate never runs the Swift tests.

Fixed test-side, not model-side: `MobileStore` caches the RAW response bytes and never re-encodes, so the tests now seed the cache the same way; adding `Encodable` would have bent a production model to satisfy a test.  The two catalog assertions were STALE - #2887 deliberately removed the `"Mock (offline)"` option, its provider branch and its availability bypass (keyless offline = the mock/demo path the rules forbid), so `provider(for:)` falls through to `openai` and `firstAvailable` returns nil with no keys.  The self-contradictory scan test now follows the implementation's joined-warnings form, which is also the honest one - the second warning is what tells the owner they are looking at a stale fallback scan.

Verified: `xcodebuild test -only-testing:SocraticTradeTests/DeskModelsTests` exit 0, zero failures, 59s.  **Next: `qa-01`/`qa-02` are now actionable - add `xcodebuild test` to CI so a red Swift target cannot hide again.**  Rollout: `docs/rollouts/2026-08-20-ios-test-target-repair.md`.

## 2026-08-20 MONET - `pnl-basis-labels` up for review

Every performance number now says what it measures.  Basis and window travel with the value through `performance.ts` / `benchmark.ts` to both the console and iOS, so "Unrealized P&L" stops meaning three different things across Results, Home and the phone; an empty sample reads as no-data rather than a confident `0%`; and mark-to-market sums a book with shorts on `|basis|` instead of netting short against long (`costBasis` changed meaning net -> gross; identical for an all-long book, and the single consumer was grep-confirmed).  `-` (unavailable) vs `n/a` (computed no-ratio) preserved.

**Not closed, stated openly:** `perf-17` - the SPY benchmark is total-return or price-return depending on which history provider answered, and an intraday tip is compared against an EOD close.  Confirmed by reading the provider cascade, not papered over; normalising that is its own change.  Also open: the coach tool context still passes raw win rate with no sample count.

Gate: lint 0 errors, tsc clean, 7140 tests, build 0, `xcodebuild build` 0.  Rollout: `docs/rollouts/2026-08-20-pnl-basis-labels.md`.
## 2026-08-20 CURSOR-BUGBOT — Tradier 24h filter drops live pending_cancel GTC stops

#2886's default `getEquityOrders` keeps only `open` / `pending` / `partially_filled` / `held` plus terminal orders created in the last 24h.  `pending_cancel` and `pending_replace` are live in `isLiveOrderState` (they can still fill) but were treated as terminal.  A week-old GTC equity stop mid-cancel is dropped, `liveExitOrderCoverage` sees no exit, and the synthetic-stop monitor can double-sell.  Same miss can let account-drain purge while that order is still live.

Fix: keep any `isLiveOrderState` row regardless of age.  Still apply the 24h window to true terminal rows.  Distinct from #2947 (5-page cap).  Did not change Alpaca or page count.

**IN PR #2952.**  Branch `cursor/tradier-live-pending-cancel-scope`.  Rollout: `docs/rollouts/2026-08-20-tradier-live-pending-cancel-scope.md`.

## 2026-08-20 CURSOR-BUGBOT — owner-cancel protective-stop tombstone on lookup miss

`cancelWorkingOrder` only tombstoned an owner-cancelled app-managed stop when the advisory pre-cancel broker read returned the order.  Console cancel is fail-open on that read (timeout, throw, or a working GTC stop missing from scoped `getEquityOrders`).  The broker cancel still ran, but `cancelledSymbol` stayed empty, so the do-not-replace tombstone and `broker_protective_stops` delete were skipped.  The next reconcile tick then treated the cancelled stop as a stale resting row and re-placed protection the owner had just removed.

Fix: take the symbol from the tracked `broker_protective_stops` row when the lookup has no order.  Did not touch #2861.  Did not change cancel fail-open doctrine.

**IN PR #2949.**  Branch `cursor/owner-cancel-stop-tombstone-lookup`.  Rollout: `docs/rollouts/2026-08-20-owner-cancel-stop-tombstone-lookup.md`.

## 2026-08-20 MONET - `prompt-trust-boundary` up for review

Untrusted content can no longer reach the always-trusted strategy prompt unlabelled.  The trust boundary now lives AT THE SINK: `mergeStrategyDirectiveBlock` requires `source`, runs containment itself and returns `{ prompt, contained }`, so a future caller cannot write an unscanned directive by forgetting a helper (the required parameter proved itself by breaking the one stale 4-arg call site at compile time).  Coach URL lessons are contained at ingest and dropped + audited on a real hijack idiom; the forgeable unauthenticated `POST /api/chat-history` is deleted; a `MockLLM` semantic-gate fallback is audited instead of silent; the revalidation rationale is contained and the reviewer prompt carries a data-not-command clause.

**Owner text is never altered** - containment keys on provenance, so `owner-coach` passes byte-for-byte.  `learningReviewMode: "decide"` auto-apply and `learningReviewEnabled` are untouched: the second review round established that as an owner choice with an existing off-switch, and re-gating it would be paternalism.  Gate: lint 0 errors, tsc clean, 7146 tests, build 0.  Rollout: `docs/rollouts/2026-08-20-prompt-trust-boundary.md`.
## 2026-08-20 CURSOR — Stale hosting/stack copy sweep (docs only)

Swept current-truth docs and GitHub About for Vercel / Cloudflare Workers /
PWA-as-current / retired preview hosts.  README and GitHub About already
point at Coolify / socratictrade.com — left those alone.  Fixed PLAN.md
Current Status + acceptance checks, leftover AGENTS.md preview/PWA/Mac-pm2
present-tense, ops-diagnostics `trading.jays.services`, and matching
ops/litestream/UX-program current-truth lines.  No product code.

**IN PR #2945.**  Branch `cursor/stale-hosting-docs-b392`.  Rollout:
`docs/rollouts/2026-08-20-stale-hosting-docs.md`.
## 2026-08-20 CURSOR-BUGBOT — Tradier 5-page order cap hides GTC equity stops

#2886 scoped default `getEquityOrders` to 5 Tradier pages.  Newest-first option/combo pages can fill that window and hide a later-page GTC equity protective stop.  `liveExitOrderCoverage` then sees no exit and the synthetic-stop monitor double-sells.  Fix: walk 50 pages again; keep the 24h *terminal* filter.  Did not change Alpaca (already splits `status:open`).  Did not touch #2861.

PR **#2947**.  Branch `cursor/tradier-orders-page-cap-4f2a`.  Rollout: `docs/rollouts/2026-08-20-tradier-orders-page-cap.md`.

## 2026-08-20 MONET — `web-ios-contract-drift` up for review, and main's iOS test target is RED

Contract fixture now pins `GET /api/policy` to the Swift `FullPolicy` decoder from both sides, so a rename fails CI instead of silently blanking a phone list.  `api-01` was already fixed on main by #2863 mid-flight, so this branch drops its competing decode and keeps main's.  **`qa-04` (a `/api/mobile/snapshot` contract test) is still OPEN.**

**Unrelated breakage found:** `xcodebuild test` does not compile on a clean `origin/main` - `ios/SocraticTradeTests/MobileModelsTests.swift:403/425/445` call `JSONEncoder().encode()` on a non-`Encodable` type (5 errors; that file arrived in #2863).  The app builds fine; only the test target is red, and the required gate never runs it, so it went unnoticed - findings `qa-01`/`qa-02` exactly.  Reported to the fleet, not claimed.  Until it is repaired, Swift contract assertions ship committed but unrunnable.

## 2026-08-20 CURSOR — Rebase #2818 onto current main (delayed Yahoo stamp)

Rebase-only of PR **#2818** (`cursor/delayed-yahoo-fallback-stamp-c120`) onto
`origin/main` `ce31c367`.  Scope stayed stamp user-facing **Delayed Quote** on
approval cards and keep trading.  Conflicts were only
`ios/SocraticTrade/DataSourcesSettings.swift` and
`ios/SocraticTrade/HomeView.swift`; kept main (coordinator-copy cleanup and
#2857 Desk subtitle fold already landed).  Did not absorb other clusters.
Do not merge from this rebase.

Branch `cursor/delayed-yahoo-fallback-stamp-c120`.  Rollout:
`docs/rollouts/2026-08-18-delayed-yahoo-fallback-stamp.md`.
## 2026-08-20 CURSOR — Rebase #2841 onto current main (after #2892/#2876/#2942)

PR **#2841** rebased onto `origin/main` `1d6bbf68`.  Scope unchanged: header inbox, Activity unread, last-100 `notification_events`.  Conflicts in nav/shell/copy tests kept this PR's unread badges plus main's skip-link / `sheetId` / scan+portfolio copy tests.  Snapshot uses one last-100 `buildNotificationHistory` row (also carries `status` / `acknowledgedAt` so older #2942 payloads still decode).  One iOS inbox (`NotificationHistoryItem`); did not keep a second `MobileNotification` list.  Did not absorb #2892/#2876/#2942/#2834.  Not merging.

Branch `cursor/notification-history-parity-4bbc`.  Rollout: `docs/rollouts/2026-08-18-notification-history-parity.md`.

## 2026-08-19 MONET — `per-account-visibility` landed for review (tranche-1 cluster)

Screens no longer label one account's data as every account's.  Broker rows in Settings read real per-account policy state and a real per-account pending count (both were previously the active account's, with every other row mislabelled "Inactive" even while trading, and the count dead code that always read 0); the decisions index keeps its by-design all-accounts fetch and gains an account chip; `mobileCommandBacklog` was global across USERS and is now user-scoped.  Each finding was classified wrong-scope vs wrong-label before fixing, so a wrong query is never papered over with a label change.  Full gate green (lint 0 errors, tsc clean, 7071 tests, build 0).  Rollout: `docs/rollouts/2026-08-19-per-account-visibility.md`.
## 2026-08-20 CURSOR — Rebase #2813 onto current main (ROIC Individual archive)

PR **#2813** (`cursor/roic-individual-archive-9ad4`) rebased onto `origin/main` `d3e2c9ee` (#2892).  Scope unchanged: skip ROIC HTTP when cache/artifacts already cover; persist `earningscalls_transcripts` + `data/roic-artifacts`; ops `roicArchive`.  Conflicts were `src/lib/web-sources/roic-transcripts.ts` and `test/roic-transcripts.test.ts` -- kept this PR's `while (queue.length > 0)` cached-tail drain and main's #2848 strategy-run pause plus the existing #2820 write-class tests.  Did not absorb other clusters.  Did not merge.  Did not spend the Individual key.

Rollout: `docs/rollouts/2026-08-18-roic-individual-archive.md`.
## 2026-08-20 CURSOR — #2854 rebased onto main (`ce31c367`)
## 2026-08-20 CURSOR — #2854 rebased onto main (`eefc4f82`)

#2854 was CONFLICTING/DIRTY against `origin/main` (Jay landing open issue PRs tonight).  First rebase onto `ce31c367`/`44e9ef06` was phantom.  After #2813 landed, the only real conflict was `test/roic-transcripts.test.ts`.  Kept this PR's `shouldSkipWholeIndexInventory` test and main's `planRoicSymbolWork` skip-covered test.  Did not absorb #2813 product.  Gather skip + 502/429 fail-open only.  Did not flip `RAG_PINECONE_WRITE_CLASS`.  Did not prune.  Did not merge.

PR **#2854**.  Branch `cursor/gather-no-pinecone-inventory-befc`.  Rollout: `docs/rollouts/2026-08-19-gather-no-pinecone-inventory.md`.
## 2026-08-20 CURSOR — Rebase #2841 onto current main (notification history)

PR **#2841** (`cursor/notification-history-parity-4bbc`) rebased onto `origin/main` `ce31c367`.  Scope unchanged: website header inbox + Activity unread, iOS Activity notifications, last-100 `notification_events` on the mobile snapshot.  Three conflicts: `app/api/mobile/snapshot/route.ts`, `docs/phase-6-customization-risk-notifications.md`, `ios/SocraticTradeTests/MobileModelsTests.swift`.  Kept this PR's inbox fields and main's `latestScan` / alert-fingerprint acceptance.  Did not absorb other clusters.  Did not merge.

Branch `cursor/notification-history-parity-4bbc`.  Rollout: `docs/rollouts/2026-08-18-notification-history-parity.md`.

## 2026-08-20 CURSOR — Rematch #2798 onto current main (alert-noise leftover)

PR **#2798** (`cursor/alert-noise-retired-boot-64c1`) rematched onto `origin/main` after
#2799/#2800 landed the overlapping FilingAPI omit and hard-stop-only ops `ok`.  Unique leftover
on this PR: 5-minute connection-alert mute on `DB_BOOTSTRAP=live` boot, plus
`getServiceHealthSummaries` stamps `intentionalOff` so leftover 401 rows cannot paint retired
vendors STOPPED.  Merge kept main's `pineconeIngest` snapshot and `stoppedReasonKind`
hard-stop check.  Boot-grace uses `process.uptime()` so `db.ts` cannot pull `node:fs` into
client webpack (old `verify-hosted` failure).  Local lint/tsc/38 targeted tests/`next build` green.
Implements the 2026-08-17 audit gaps the owner asked to fix.  Website honors `?proposal=` / `?symbol=`.  iOS Assets honors `?symbol=` and Activity lists snapshot alerts (`run_failed` / `kill_switch` visible).  Exit-only copy, Lessons width, Watchlist cards, skip link, assertive error toasts, TypedConfirm `htmlFor`, More `aria-expanded`, 44pt scan star, swipe VO action, offline banner, PWA UI tree deleted (redirect + `/api/mobile` kept), Playwright iPhone-13 project + landmark smoke.  iOS More Postures when Stop is primary; Connections Safari handoff.  **IN PR #2942.**  Local lint 0 errors, `tsc` clean, focused vitest 11/11.  Dispatched `verify` on `d52b354a` was green (run 32329145996).  Merged `origin/main` `ee1286e0` (phantom DIRTY).  Next: re-kick `verify` on the new head and merge.  Rollout: `docs/rollouts/2026-08-20-web-ios-parity-fixes.md`.

Branch `cursor/alert-noise-retired-boot-64c1`.  Rollout: `docs/rollouts/2026-08-17-alert-noise-retired-boot.md`.

## 2026-08-17 CURSOR — Alert-noise leftover after the 4:23pm CT burst

Owner All Messages 4:23–4:38pm CT.  Live ST is healthy after the 21:35:38Z Coolify restart of
`5f9b4aaf`.  Most cards were boot probes, expected fuses, or leftover FilingAPI 401s.  This
branch stamps retired vendors OFF in health summaries, aligns ops-snapshot `ok` with hard-stop
only, and mutes connection pages for the first 5 minutes of a `DB_BOOTSTRAP=live` boot.

Branch `cursor/alert-noise-retired-boot-64c1`.  Rollout: `docs/rollouts/2026-08-17-alert-noise-retired-boot.md`.
## 2026-08-19 CURSOR — Pinecone trial end in 7 days

Owner: set the Standard-trial calendar to 7 days from 2026-08-19 21:59 CT.  Default +
Infisical `PINECONE_TRIAL_ENDS_AT` is now `2026-08-27T00:00:00.000Z` (remainingDays=7
at that instant).  Pinecone's own console trial is unchanged.  Daily WU fuse unchanged.

Branch `cursor/pinecone-trial-end-7d-c9a3`.  Rollout:
`docs/rollouts/2026-08-19-pinecone-trial-end-7d.md`.

## 2026-08-20 CURSOR — OCR CPU ceiling 5 of 8 vCPU (#2545)

Owner: cap OCR as high as is reasonably advisable so other apps still function.
Default isolation cap is now **5.0 / 8 vCPUs** (cpu-shares 256): above the
2026-08-12 unconstrained peak of 2.83 cores, 3 cores reserved for Coolify SSH +
ST + UM + CT web.  6.0+ is the class that starved the exec stream.  CT compose
still pins `scan-cpu-worker` at 2.0 (throttles below that peak) -- durable fix
is raise that compose line to `5.0`.  Did not touch prod.

Branch `cursor/deploy-freshness-ocr-isolate-d4cf`.  PR #2796.  Rollout:
`docs/rollouts/2026-08-17-deploy-freshness-ocr-isolate.md`.

## 2026-08-17 CURSOR — Deploy freshness alert + CT OCR isolation (#2545)

P0 silent-freeze class from 2026-08-06: Coolify SSH exec died mid-build while
webhooks stayed 200 and `/api/health` stayed green on the old sha.  This branch
adds a 20-minute freshness cron (oldest undeployed main commit >1h pages
Sentry / optional `#agent-sync`) and a dry-run-default `docker update` CPU cap
for CT OCR/scan workers that never restarts and never touches ST.  Remaining
host constraint: durable isolation is Coolify/CT-repo; this repo cannot set
those or a Coolify retry-on-255.  Did not touch prod.

Branch `cursor/deploy-freshness-ocr-isolate-d4cf`.  PR #2796.  Rollout:
`docs/rollouts/2026-08-17-deploy-freshness-ocr-isolate.md`.
## 2026-08-20 CURSOR — Web / iOS parity P1+P2 fixes (`cursor/web-ios-parity-fixes-e83a`)

Implements the 2026-08-17 audit gaps the owner asked to fix.  Website honors `?proposal=` / `?symbol=`.  iOS Assets honors `?symbol=` and Activity lists snapshot alerts (`run_failed` / `kill_switch` visible).  Exit-only copy, Lessons width, Watchlist cards, skip link, assertive error toasts, TypedConfirm `htmlFor`, More `aria-expanded`, 44pt scan star, swipe VO action, offline banner, PWA UI tree deleted (redirect + `/api/mobile` kept), Playwright iPhone-13 project + landmark smoke.  iOS More Postures when Stop is primary; Connections Safari handoff.  Next: verify gate + review.  Rollout: `docs/rollouts/2026-08-20-web-ios-parity-fixes.md`.
## 2026-08-20 CURSOR — Cross-app coordination follow-ups (ST slice)

Audit #2802 follow-ups.  ST pin-check now understands vendor-era CT + the UM
triangle and fails closed when CT is unreadable or reintroduces the npm dep
(still not a required merge check).  Call-volume windows persist to settings
on drain and replay after a crash.  Peer-serving OHLC misses tag
`congress-read`.  Infisical merge-order + congress/Quiver docs refreshed.
Peer PRs: Congress.Trade #2064, Usage-Monitor #1245, FLEET #44, CTS #278,
DealDex #93 (pointer only).
Did not mint a Massive key.  Did not collapse STATUS/PLAN.

Branch `cursor/cross-app-coordination-followups-1212`.  ST PR **#2941**.
Rollout: `docs/rollouts/2026-08-20-cross-app-coordination-followups.md`.

## 2026-08-19 MONET — `run-scoped-account` landed for review (tranche-1 cluster)

Run-scoped code no longer reads the console-active account.  `debateProposal`, `retryProposalRedTeam` and `applyApprovedPending` now resolve the account from the run's own policy via the new `resolveRunAccountScope(userId, policy)` (account required — no active-account default), so a two-account setup can no longer review account A's proposal against account B's venue, execution mode or strategy prompt, and switching the active account mid-run leaves in-flight reviews pinned.  `retry-red-team.ts` was NOT in the plan — the audit found it and it is fixed here.  Full gate green (lint 0 errors, tsc clean, 7056 tests, build 0); failing-first proven 7/7.  PR body carries the full 21-site `getActiveConnectedAccount` inventory.  Sibling cluster `per-account-visibility` lands next.  Rollout: `docs/rollouts/2026-08-19-run-scoped-account.md`.

## 2026-08-20 CURSOR — Alert repeat lock (`cursor/alert-repeat-lock-2b9b`)

Cluster `alert-repeat-lock`.  **IN PR #2877.**  Rebased onto `origin/main` `0382e83f`.  Same alert (user + type + fingerprint) is not delivered more than once per 60s.  `price_alert` is now in the existing sent-row repeat-dedup set, keyed by alert id.  `provider_degraded` / `budget_alert` / `kill_switch` share that 60s lock.  Health and usage-limit no longer re-send Pushover on a channel the user already has.  Usage-limit 6h cooldown no longer latches on skipped/failed.  Did not revert #2865.  Did not take `alert-push-delivery`.  Next action: merge #2877 when `verify` is green.  Rollout: `docs/rollouts/2026-08-20-alert-repeat-lock.md`.

## 2026-08-19 MONET — Review board exported into the repo (peers were blocked on a private artifact URL)

The claude.ai artifact board is private to the owner's session by design, so peer agents got a 404.  The same board is now committed: `docs/reviews/2026-08-18-audit-board.html` (self-contained, open directly) and `docs/reviews/2026-08-18-work-items.json` (machine-readable: `clusters[]` with `member_uids` + `plan`, `p1_verdicts[]`, `gap_findings[]`, `findings_index{}`).  **Claim work by cluster key**, not by finding count.  Making the artifact itself public is an owner action (share menu) and is not required for anyone to work.

## 2026-08-19 CURSOR — Price alert evaluation (`cursor/fix-price-alert-evaluation-1a3d`)

Part II cluster `price-alert-evaluation`.  `checkPriceAlerts` now uses user-scoped `fetchFreshQuotesCascade`, logs/audits cascade failures, skips stale quotes via `quoteAgeSecForStalenessGate`, and shares `isValidAppSymbol` for create validation.  Four new evaluation tests.  Did not take on alert-push-delivery.  PR open on branch `cursor/fix-price-alert-evaluation-1a3d`.  Rollout: `docs/rollouts/2026-08-19-price-alert-evaluation.md`.
## 2026-08-19 CURSOR — Home proposal rows (`home-proposal-rows`)

Expert review cluster `home-proposal-rows`: Home latest-run rows now use persisted `trade_proposals.id` on the strategy trace, shared `proposalChipTone` / `isProposalRowApprovable` helpers, honest warn tones for error/failed/blocked, Approve only on real pending/proposed ids, and a keyboard-operable row button with `SymbolButton` outside the activation target.  Empty `latest.proposals` falls back to `pendingProposals`.  Web console only.

PR **(pending)**.  Branch `cursor/home-proposal-rows-8a57`.  Rollout: `docs/rollouts/2026-08-19-home-proposal-rows.md`.
## 2026-08-19 CURSOR — Session-aware market cache freshness (`market-cache-freshness` / mdi-01)

Replaced calendar-day cache TTL with session-boundary logic: Friday 10:00 ET screener/OHLC/enrichment writes now expire on their naive TTL (not Monday open).  TTL extension only fires after today's regular or early-close session ends.  `isBarSeriesFresh` now compares the latest bar to the most recently completed trading session instead of a 3-calendar-day window.  Added `getEarlyCloses(year)` for half-day closes.

PR on branch `cursor/market-cache-freshness-5ee3`.  Rollout: `docs/rollouts/2026-08-19-market-cache-freshness.md`.
## 2026-08-19 CURSOR — Order provenance guard (`order-provenance-guard`)

Part II cluster: stale-exit auto-remediation no longer cancel-replaces bracket legs or owner-placed GTC sells; owner-cancelled app-managed protective stops stay cancelled (tombstone honored by reconciler).  Branch `cursor/order-provenance-guard-197e`.  Rollout: `docs/rollouts/2026-08-19-order-provenance-guard.md`.
## 2026-08-19 CURSOR — Copy: guardrail claims match advisory engine (`copy-claims-and-rulings`)

Cluster from Part II expert review.  Added `src/lib/guardrail-copy.ts` as the single source for guardrail-semantics sentences; macro / Guardrails / public pages / iOS `DeskCopy` now describe advisory pre-vetoes (not hard veto).  Stripped paper/live ceremony: `Alpaca (paper)`, lowercase paper chip, no iOS Live pill or brokerage activation confirm, Mock removed from Coach pickers.  Terms §8 mirrors Privacy shared pool; `LEGAL_NOTICE_VERSION=2`.  Engine + AUTOPILOT path unchanged.

Branch `cursor/copy-guardrail-claims-19ca`.  Rollout: `docs/rollouts/2026-08-19-copy-guardrail-claims.md`.
## 2026-08-20 CURSOR — Wire dead tax / webhook / preset controls (`dead-controls`)

Expert review cluster: wired `taxSettings.subtractFromResults` into Results realized P&L, extended Send test to probe `policy.notificationSettings.webhookUrl` (Discord embed path), and added Preset create/rename/delete on Strategy via `/api/profiles`.  Branch `cursor/wire-dead-controls-8b69`.  Rollout: `docs/rollouts/2026-08-20-wire-dead-controls.md`.
## 2026-08-19 CURSOR — Account write guards (`cursor/account-write-guards-940d`)

Expert review tranche-1 cluster `account-write-guards`: `strategyAuthority` now stays pinned on profile activate/copy/import (mirrors existing `systemState` guard).  `setActiveConnectedAccount` rejects draining rows; `upsertConnectedAccount` clears `is_draining` on reconnect.  No new TypedConfirm ceremony.  PR open on branch `cursor/account-write-guards-940d`.  Rollout: `docs/rollouts/2026-08-19-account-write-guards.md`.
## 2026-08-19 CURSOR — Coach fail-closed tool inputs + abort in-flight turns

Implements review cluster `coach-tools-and-turns`.  `draft_order` no longer coerces invalid `side`/`order_type` to buy/market; limit orders require a positive `limit_usd`.  `kb_search` clamps `k` to [1, 20].  Chat LLM transports thread `args.abortSignal` so Cancel and the 120s deadline can abort in-flight provider calls.

PR **#2874**.  Branch `cursor/coach-tools-fail-closed-1c54`.  Rollout: `docs/rollouts/2026-08-19-coach-tools-fail-closed.md`.
## 2026-08-19 CURSOR — iOS session snapshot, edit alerts, nested stop-loss decode

Part II clusters `ios-state-outcome-truth` + `web-ios-contract-drift` (stop-loss only).  `clearLocalSession` now wipes the UserDefaults snapshot; init uses the persisted capture time; guardrail/command feedback is modal alerts (not a scroll-top banner `load()` clears); `FullPolicy` reads stop percents from nested `riskRules`.  No TF upload.  PR on `cursor/ios-session-stop-loss-03c2`.  Rollout: `docs/rollouts/2026-08-19-ios-session-stop-loss.md`.
## 2026-08-19 CURSOR — CI docs-only fast path excludes build-imported benchmarks JSON

Expert review `qa-test-strategy:qa-03` (narrowed `merge-gate-blindspots`): classify regex in `ci.yml` / `e2e.yml` treated all `docs/**` as documentation, but `app/api/llm-usage/model-stats/route.ts` imports `docs/benchmarks/*.json` at build time.  Changed paths under `docs/benchmarks/` now force the full verify/smoke gate.  No Swift required gate; `land.sh` unchanged (no docs-only regex there).

Branch `cursor/fix-ci-docs-benchmarks-skip-e4ac`.  Rollout: `docs/rollouts/2026-08-19-ci-benchmarks-docs-only-fix.md`.
## 2026-08-19 CURSOR — Identity fail-closed in live bootstrap (`identity-fails-open`)

Expert review cluster `identity-fails-open` (sec-01): live prod without `AUTH_SECRET` silently made every anonymous request the owner.  Added `assertAuthSecretConfiguredInLiveBootstrap()` at boot (alongside `ENCRYPTION_KEY`), gated middleware `PRIMARY_EMAIL` fallback on `DB_BOOTSTRAP !== "live"`, and made `resolveRequestUser` refuse anonymous / `local-fallback` provenance in live bootstrap.  Dev/test without `AUTH_SECRET` unchanged.

PR **#TBD**.  Branch `cursor/identity-fails-open-535a`.  Rollout: `docs/rollouts/2026-08-19-identity-fails-open.md`.
## 2026-08-19 CURSOR — Broker I/O deadlines + scoped order history (`broker-io-deadlines`)

Part II cluster: Alpaca quotes/place/cancel and Tradier fetch now have deadlines; scheduler stop-monitor and stale-limit lanes wrap in `withDeadline(15s)` so in-flight keys cannot latch on a hung socket; default `getEquityOrders` returns open + 24h terminal history instead of walking `status:"all"`.  Explicit `{ fullHistory: true }` retains the legacy walk.  Did not change 16s+8s read retry budgets on getAccounts/getPositions/getEquityOrders pages.  Did not touch order-replacement provenance.

PR **#2886**.  Branch `cursor/broker-io-deadlines-85a9`.  SHA `54ed4a3c`.  Rollout: `docs/rollouts/2026-08-19-broker-io-deadlines.md`.
## 2026-08-19 CURSOR — Phone touch viewport cluster (`phone-touch-viewport`)

Expert review Part II cluster: chrome bar budget at 360–390px, 44px touch floor on all interactive classes, 16px input anti-zoom, overlay scroll-lock + dvh/visualViewport + history back.  PR branch `cursor/phone-touch-viewport-b809`.  Rollout: `docs/rollouts/2026-08-19-phone-touch-viewport.md`.  Next: owner phone-width spot-check; mweb-06/mweb-09 may need follow-up.
## 2026-08-19 CURSOR — Placement outcome truth (`placement-outcome-truth`)

PR open on `cursor/placement-outcome-truth-6d4a`.  Introduces `src/lib/placement-outcome.ts` so approve reports `placed` only when the broker actually received an order.  Mobile `proposal.approve` no longer stamps `succeeded` for busy/blocked/not_placed; iOS decodes `result.status` and mirrors web approval-card tones.  HTTP 429/408 on the approval path land as `not_placed`, not `rejected_by_broker`.  Rollout: `docs/rollouts/2026-08-19-placement-outcome-truth.md`.
## 2026-08-19 CURSOR — FTS indexed mirror idempotency + strategy-run yield (`event-loop-pins`)

Part II cluster `event-loop-pins`: FTS idempotency no longer full-scans the corpus (`document_chunks_fts_index` + rowid DELETE).  `persistLocalComplete` and filing-body ingest mirror through `mirrorFtsChunksBounded` (`planFtsMirrorSlice` + `yieldEventLoop` + `hasInFlightStrategyWork`).  PR **#2885** branch `cursor/event-loop-pins-fts-indexed-mirror-5b2a` rebased onto latest `origin/main`; `test/persistence-hardening.test.ts` retargeted 84→85 for migration v85.  Awaiting green `verify`.  Rollout: `docs/rollouts/2026-08-19-fts-indexed-mirror-idempotency.md`.
## 2026-08-19 CURSOR — Green Bull strict schema (`green-request-schema`)

Part II cluster `green-request-schema`: `exitPlan` was in Bull `properties` but missing from `BULL_PROPOSAL_REQUIRED_KEYS`, so OpenAI strict mode 400'd every Green seat.  Added `exitPlan` to required keys, invariant test (properties ⊆ required), and `json_object` post-parse completeness via `filterRepairedProposals`.  Branch `cursor/green-bull-schema-769b`.  Rollout: `docs/rollouts/2026-08-19-green-bull-schema.md`.
## 2026-08-19 CURSOR — console-ships-too-much cluster (server DB boundary + snapshot projection)

PR **#2884** (`cursor/console-ships-too-much-6790`).  `server-only` on all `src/lib/db*` modules; `venue-contract-pure.ts` so `brokers.tsx` no longer pulls the DB layer; dashboard snapshot drops raw `audit[]`, trims `quotesBySymbol` and order history, and ack/cancel/replace invalidate the 10s cache.  Connections client chunk grep: 0 `getDb` / `better-sqlite3` hits after `npm run build`.  Rollout: `docs/rollouts/2026-08-19-console-ships-too-much.md`.
## 2026-08-19 CURSOR — Day P&L cash-flow cluster (perf-02/03/08)

Expert review cluster `cash-flow-and-trading-day`: Home Day P&L no longer zeroes on directional-trade days (fills passed into inference); short/cover cash sign fixed in `cash-flows.ts`; Alpaca account activities wired as broker flow source for benchmark + `dayPnlHints`; shared Central trading-day helper (`trading-day.ts`) reused by risk-breaker + daily cap roll.  PR **#2878**.  Branch `cursor/fix-day-pnl-cash-flows-56a3`.  Rollout: `docs/rollouts/2026-08-19-day-pnl-cash-flow-cluster.md`.

## 2026-08-19 MONET — Full-app review Part II: adversarial re-verify + gap coverage + deduped fix plan

`docs/reviews/2026-08-18-full-app-expert-review.md` now carries Part II.  Second round re-attacked all 40 P1s: **27 upheld with a proven repro, 11 narrowed, 2 already fixed, 0 refuted outright**.  Two Part I headlines (mine) were WRONG and are corrected: `tsx-01` is **not** "MCP-fallback duplicate orders" — reusing the same `client_order_id` is what makes Alpaca refuse the second submission, the harm is a live order misfiled as `rejected_by_broker`, and the MCP transport is unreachable in production (no UI creates an `alpaca-mcp` account; the host allowlist blocks it) so it is **P3**.  The oldest-500 fill cap (`perf-01`/`berel-02`) needs >500 fills per (account, source) — unconfirmed on the prod DB — so **P2**; settle it with `SELECT source, COUNT(*) FROM fill_events GROUP BY source`.

Five new lanes read what Part I skimmed and found P1s it missed: Coach `draft_order` coerces `short`/`cover` to **buy** (`src/lib/chat/tools.ts:92`); "Import from account" arms Autopilot on a live account with no guard (`app/console/guardrails/page.tsx:1021`); a draining account can be reactivated as the live trade target (`src/lib/db-api-keys.ts:1323`); price alerts stop evaluating when no account is active (`src/lib/alerts.ts:68`); unauthenticated `POST /api/chat-history` accepts forged turns.  Everything folds into **45 clusters** (22 tranche-1) with implementation plans.  Work from the clusters, not the finding count.  Also LIVE-21: the paired uptime flaps are origin stalls, not restarts (uptime continuous) — and prod being 2 merges behind main is correct (watch paths; those merges are iOS/docs only).
## 2026-08-19 CURSOR — #2854 rebased onto main (`52add2ae`)

#2854 was CONFLICTING/DIRTY after #2856 / #2857 (and #2858 on main).  Live is still `a8a0a65b`.  This morning's first post-open run hit Roth + Paper `strategy gather timeout` at 8 minutes, 0 proposed, Green never started.  #2831 400-failover was not exercised.  #2852 Robinhood ≤10 is already live.  #2854 (skip whole-index Pinecone inventory during strategy work + congress 502 / Massive 429 fail-open) is the remaining gather PR and is NOT live.

Rebased `cursor/gather-no-pinecone-inventory-befc` onto `origin/main` `52add2ae`.  `git merge-tree --write-tree` was already clean.  Overlap vs later main was only `STATUS.md` / `PLAN.md` / `docs/EFFORT-LOG.md` (union).  No iOS files.  Kept the gather skip + 502/429 fail-open.  Did not flip `RAG_PINECONE_WRITE_CLASS`.  Did not prune.  Did not reopen #2840.  Did not touch #2841 / #2849 / #2850 / #2856 / #2857.  Did not open a second PR.  Do not merge / deploy / bounce / TF.

PR **#2854**.  Branch `cursor/gather-no-pinecone-inventory-befc`.  Rollout: `docs/rollouts/2026-08-19-gather-no-pinecone-inventory.md`.

## 2026-08-18 MONET — Full-app expert-panel review landed (desktop web + mobile web + iOS)

`docs/reviews/2026-08-18-full-app-expert-review.md`: 17 expert lanes + 17 verifiers + prior-review cross-check + a by-hand live pass.  336 panel findings (40 P1 / 148 P2 / 148 P3), 20 live-pass items, 50 verifier-added items, 15 prior items still open, 53 resolved.  Top of the list: MCP-fallback duplicate orders (`tsx-01`), stale-exit remediation cancel-replacing bracket legs with MARKET (`tsx-02`), iOS approve reported "succeeded" on blocked/error (`api-02`), fill ledger keeps the OLDEST 500 fills so P&L freezes (`perf-01`), Bull strict schema `exitPlan` missing from `required` = the Green 400s (`llm-01`), no `AUTH_SECRET` boot guard (`sec-01`), Friday cache freeze (`mdi-01`), FTS full-scan per chunk = the loop pin (`berel-01`).  Hotfix #2851 (Connections `process.uptime` crash) is live; root-cause split is LIVE-01.  Sequencing in report §11.  Rollout: `docs/rollouts/2026-08-18-full-app-expert-review.md`.

## 2026-08-19 CURSOR — iOS Home / Guardrails parity vs live web `a8a0a65b`

Hypothesis held: #2855/#2856 are on `main` (`a8a0a65b`).  TF **1.0.68** is behind that binary, so Guardrails → Universe → Indices still prints `sp500, nasdaqComposite, dow30, nyseComposite` on the phone.  Current `main` iOS already uses `DeskCopy.joinedIndexList` on Guardrails and Desk Current Policy — no leftover raw-slug join.  Remaining leaks on this tree: #2849 Desk subtitle still open, and Home / Guardrails / Insights still pointed at a nonexistent iOS **Strategy** page (web universe edits are on Guardrails).

This PR folds #2849 (`SectionHeading("Desk")` only) and retargets empty-universe copy at Guardrails with the same `S&P 500` example web uses.  Did not add iOS index checkboxes, Scan source chips, or Smart Money.  Did not merge / deploy / bounce / TF.  HOLD `5674dfaf`.  Did not touch #2841 / #2854 / #2840.

PR **#2857**.  Branch `cursor/ios-web-parity-502f`.  SHA `e2f56f21`.  Rollout: `docs/rollouts/2026-08-19-ios-web-parity.md`.

## 2026-08-19 CURSOR — Indices common names on every surface

#2855 merged (`b27de85c`).  Live Guardrails → Universe → Indices still printed `sp500, nasdaqComposite, dow30, nyseComposite`.  Jay does not distinguish rows vs Guardrails — both use **Indices** and the shared names (S&P 500, Nasdaq Composite, Dow 30, NYSE Composite, Nasdaq 100, Russell 2000, FT Wilshire 5000, S&P 100).  Web selected-set + checkbox grid, policy-diff, Scan `${id}-universe` chips, iOS Guardrails, and Desk Current Policy now go through `formatIndexUniverseList` / `indexUniverseLabel`.  Storage / API slugs stay.  Did not merge / deploy / bounce / TF.  HOLD `5674dfaf`.  Did not touch #2841 / #2849 / #2854 / #2840.  Did not reopen #2855.

PR **#2856**.  Branch `cursor/indices-common-names-3381`.  Rollout: `docs/rollouts/2026-08-19-indices-common-names.md`.

## 2026-08-19 CURSOR — Indices labels (`S&P 500`, not `sp500`)

**MERGED #2855** `b27de85c`.  Follow-up: live Guardrails Indices selected-set + Scan chips still leaked slugs — `cursor/indices-common-names-3381`.
## 2026-08-19 CURSOR — Gather crumbs: no Pinecone inventory + 502/429 fail-open

#2852 is merged (`c7b775c5`) — keep the Robinhood ≤10 chunk.  Same Roth `9d71dda4` window also did thousands of Pinecone list/fetch, congress.trade 502, and Massive 429.  No OpenRouter strategy/completion call.  Only run-scoped audits: `usage_budget_status` at +10s, then the crash.  Robinhood `too many symbols (max 10, got 250)` at +18s remains the first hard fail.

Do not inventory the whole index during gather.  Do not flip `RAG_PINECONE_WRITE_CLASS`.  Do not prune.  Do not reopen #2840.  502/429 must not latch gather or skip Green.  New PR.  Do not merge / deploy / bounce.  Do not touch #2850 / #2849 / #2841.

PR **#2854**.  Rebased onto `52add2ae`.  Branch `cursor/gather-no-pinecone-inventory-befc`.  Rollout: `docs/rollouts/2026-08-19-gather-no-pinecone-inventory.md`.  Do not merge / deploy / bounce.

## 2026-08-19 CURSOR — Robinhood max-10 quote chunk (rebased onto #2853)

#2853 is merged (`df1f5a37`).  This PR was CONFLICTING/DIRTY against that main.  Rebased `cursor/robinhood-quote-chunk-befc` onto `df1f5a37`.  The only real conflict was `docs/phase-7-strategy.md` (both added a 2026-08-19 stanza).  Kept #2853 drain/heartbeat/adopt and the ≤10 Robinhood chunk.  `strategy.ts` / quote-cascade did not conflict.

#2848 is live.  Roth `9d71dda4` wrote 00:58:57Z, llm=0, then `stalled_no_progress` at 01:29:44Z.  ASC: robinhood `too many symbols (max 10, got 250)` at 00:59:15Z (18s after start).  congress.trade HTTP 404 at 01:01:53Z.  One OpenRouter embed document.  Zero completion `llm_usage`.  account-miss 404 did not fire.

Root cause: `getEquityQuotes` sent the full scan universe in one MCP `get_equity_quotes`.  Robinhood rejected the batch, so gather never priced through Robinhood.  Do not shrink the universe to 10.  Chunk requests to 10.  congress.trade 404 is secondary and must not latch the free enrichment wave.  Do not reopen #2840 / #2853.  Do not touch #2850 / #2849 / #2841 / strategy picks.  Do not merge / deploy / bounce / TF.

PR **#2852**.  Branch `cursor/robinhood-quote-chunk-befc`.  Rollout: `docs/rollouts/2026-08-19-robinhood-quote-chunk.md`.

## 2026-08-19 CURSOR — Manual Run once drain must resume a claimed worker

**MERGED #2853** `df1f5a37`.  #2848 was live (`c55c2e64`).  Roth `9d71dda4` wrote 00:58:57Z, sat `running` llm=0, then sweep-failed 01:29:44Z `stalled_no_progress` (~31m).  Drain now resumes a claimed request with no heartbeat on the same run id.  Remaining gather-pricing hole is #2852.

## 2026-08-18 MONET — HOTFIX: `/console/connections` crashed client-side after #2848

Prod `c55c2e64` (live 00:51Z) renders "Dashboard error: process.uptime is not a function" on Connections.  `src/lib/db-execution.ts` module-scope `process.uptime()` reaches the browser bundle via `app/console/settings/brokers.tsx -> venue-contract -> source-settings -> db-api-keys -> db` (webpack stubs sqlite, not `process.uptime`).  Fix = lazy guarded accessor + regression test that fails on the old code.  Root cause (server DB modules in the client bundle; Turbopack `npm run dev` 500s every route after that page compiles) is a P1 in the MONET full-app review, not fixed here.  Branch `monet/hotfix-connections-process-uptime`.  Rollout: `docs/rollouts/2026-08-18-connections-process-uptime-hotfix.md`.

## 2026-08-18 CURSOR — #2848 verify hang + same-process stall labeled restart

verify-hosted: 7010 passed, 1 failed.  `test/alpaca-mcp.test.ts:214` timed out 60000ms — the 16s live first wait plus a never-settling first `getAccount` hung fake-timer advance.  Mock a short `alpacaAccountReadBudgetMs` in that test only.  Keep the live 16s wait and ROIC/FTS pause.

Same process `4abfb7fa` (`processStartedAt` 23:10:43Z, uptime ~34m) sweep-failed Roth `b3b83913` as "Process restarted mid-run".  That run started at 23:13:25Z on this process and sat llm=0.  Restart only when `started_at` predates boot; a same-process 30m stall is `stalled_no_progress`.  Do not merge.

## 2026-08-18 CURSOR — Manual Run once starved by ROIC / FTS on the event loop

#2847 is live (`4abfb7fa`).  The request lock is gone: Roth Manual Run once wrote `b3b83913` at 23:13:25Z.  That run sat ~17m with llm=0 and never reached Green.  Not a #2831 miss.  `roic-transcript-refresh` was already in-flight (23:11:45Z, RJF 2024Q2→2022Q4); 78 `ftsMirrorSlice` 6–13s; `getEquityQuotes` 6s ×28; alpaca-broker 6.5–7.4s.  Bounding the FTS tick is not enough if ROIC still owns the loop.

#2848 rebase onto `4abfb7fa`: keep 16s wait-above-p95 and FTS 2s / 1-row bound; **also** skip / pause ROIC and FTS while any `strategy_runs`/`strategy_run_requests` row is queued or running, and yield between ROIC periods.  Do not reopen #2840.  Do not hide the embed 8193 error with copy.  Do not merge.  Do not deploy.  Do not bounce Coolify.  Do not touch #2841 / #2812 / strategy picks.

PR **#2848**.  Branch `cursor/getaccounts-loop-budget-befc`.  Rollout: `docs/rollouts/2026-08-18-getaccounts-loop-budget.md`.
## 2026-08-19 CURSOR — iOS Scan last-good / seed-first rebased onto #2848 (`c55c2e64`)

#2850 rebased onto current `main` (`c55c2e64`).  Did not rewrite #2848.  Live unblocker for TF 1.0.68 is still seed-first `GET /api/scan` (names before Yahoo whole-set).  iOS `latestScan` kept for the next TF.  Do not merge / deploy / bounce / second TestFlight.  Do not touch #2848 / #2849 / #2841 / #2840.

## 2026-08-19 CURSOR — iOS Scan keeps last-good on a 503 refresh

Live `4abfb7fa` web `/console/scan`: Refresh scan once (not Run once) 503s, then paints the last-good universe from Aug 18, 2026, 7:25:13 PM (70 names / 5069 quotes / 5073 scanned).  Public `GET /api/scan` is 401.  TF 1.0.68 already has #2830 ScanView but iOS only called live `/api/scan` and replaced the table with the empty 503 body.  Snapshot had no `latestScan`.

Why Refresh 503s: after an empty Nasdaq screener, interactive `/api/scan` Yahoo-priced the whole ~5k allowed set inside the 35s budget.  That miss also dies as a generic 503 (often edge HTML, no `warnings` JSON) before the seed web already shows.  One bad row in `quotesBySymbol` also voided the whole seed.

Fix: seed before Yahoo whole-set; keep valid seed rows; compact `latestScan` on `/api/mobile/snapshot`; iOS paints that universe and keeps it on a failed refresh.  Did not merge.  Did not deploy.  Did not bounce.  Did not start a second TestFlight.  Did not click Manual Run.  Did not touch #2848 / #2849 / #2841 / #2840.

PR **#2850**.  Branch `cursor/ios-scan-last-good-503-b104`.  Rollout: `docs/rollouts/2026-08-19-ios-scan-last-good-503.md`.

ASC follow-up (testers on TF **1.0.68** `202608182121` / `581467e1`, which already includes #2830+#2831): this is not a stale binary.  That client already calls `GET /api/scan` and decodes structured `scan_quotes_unavailable`.  Live Refresh still 503s without names (`4abfb7fa` scan path; live process is now `c55c2e64` = #2848 on top — scan/iOS files unchanged).  `/api/mobile/snapshot` on that live sha has no `latestScan`.  The 1.0.68 client times out at 25s vs the 35s server budget.  Do not start a second TestFlight.  Do not merge/deploy/bounce.  Do not touch #2848/#2849/#2841/#2840.  The 1.0.68-compatible fix is making `/api/scan` return names (seed before Yahoo) — already in #2850, not live.

## 2026-08-18 CURSOR — sweep-failed orphan leaves Manual Run once locked

#2845 is merged and live (`d4299bec`).  Do not amend it.  After that deploy, Manual Run once did not create a `strategy_run`.  ASC: 0 new Roth rows after 22:06:43Z.  Orphan `0e5ccd66` was stale-swept failed at 22:13:05Z (0 LLM) while `strategy_run_requests` stayed `status=running`.  That leftover request is the lock (`queueStrategyRunRequest` dedupes on `queued`/`running`; the worker never wrote the request terminal).  22:10:15Z `getPortfolioBundle` `8000+7000ms` is a separate slow first-read (#2848), not this lock.

Fix closes the matching open request on the sweep and `finishStrategyRun` write paths, heals already-terminal mismatches on the next tick, and heals this user's orphan on the next Manual Run once click.  Do not hide the lock by ignoring `running`.  Do not merge.  Do not deploy.  Do not bounce Coolify.  Do not touch #2841 / #2840 / #2812.

PR **#2847**.  Branch `cursor/sweep-request-orphan-lock-befc`.  Rollout: `docs/rollouts/2026-08-18-sweep-failed-request-lock.md`.
## 2026-08-18 CURSOR — 6s getAccounts abort vs live p95 + ftsMirrorSlice loop pin

ASC + Trading Ops, same process `581467e1`.  Exact log: `gateway.getAccounts timed out after 6000ms — serving degraded snapshot` then `Failed to fetch accounts… 6000ms` (11 times since 4:12pm CT).  Same window aborted portfolio/positions/orders at 8s and getEquityQuotes at 6s.  alpaca-broker 500/500 ok, 0 failures, min 97ms / avg ~3085ms / max 14416ms, 191/500 ≥6s.  Latest ~4:40pm CT 98–413ms ok; ~30s earlier several ok at 6570–6600ms — the SDK finished AFTER the 6s abort.  `/api/health` 200 at ~4.2s.  Event loop loaded (`ftsMirrorSlice` 6–12s).  No sidecar.

Fix: first wait 16s on getAccounts / portfolio / getAccount / getEquityQuotes / option positions; shrink FTS tick so it cannot pin the 6s race.  Do not hide with copy.  Do not bounce Coolify.  Do not merge.  Do not touch #2841 / #2840 / #2812 / strategy logic.

PR **#2848**.  Branch `cursor/getaccounts-loop-budget-befc`.  Rollout: `docs/rollouts/2026-08-18-getaccounts-loop-budget.md`.

## 2026-08-18 CURSOR — getAccounts 6s timeout blocks Run once after deploy

Live after #2831 (`581467e1`, `processStartedAt` 2026-08-18T21:12:26Z): Manual Run once on Paper and Roth showed `Timed out waiting for gateway.getAccounts after 6000ms`.  Ops snapshot 21:37:42Z: both accounts are Alpaca REST (not MCP); no strategy run queued after the swap; `dashboard.getAccounts` recoverable_issue on Roth 21:31:18Z / 21:36:26Z and Paper 21:32:56Z.  Same class already fired before the swap (20:02Z, 20:15Z).  Console Run once preflights `accountReadiness`, which fail-closes on that dashboard 6s race.

Fix: first-call retry + 15s combined budget on the in-flight `getAccounts` / portfolio bundle; Alpaca REST `getAccount` retries a hung first SDK call; MCP fetch aborts at 8s and falls back to REST.  Real 401 / credential throws still fail immediately.  Do not bounce Coolify.  Do not merge from this seat.

Branch `cursor/getaccounts-post-deploy-timeout-befc`.  Rollout: `docs/rollouts/2026-08-18-getaccounts-post-deploy-timeout.md`.

## 2026-08-18 CURSOR — rag-embed DeepInfra batch-window 400 (hotfix)

Live `VECTOR_EMBED_BATCH_SIZE=32` POSTed 32 ingest texts to OpenRouter `baai/bge-m3`.  DeepInfra sums the whole `input[]` against 8192; a batch hit 8193 and 400'd `embed documents` from 19:12:49Z.  That is a batch-sum, not one unchunked 10-K.  #2812 stopped the 503; it did not embed those docs.  Hybrid producer still condenses first (`chunkDocument` 480 / `VECTOR_CONTEXT_MAX_CHARS`); packing is a batch-window fix after that step.  `storeContexts` packs already-condensed texts under ~7500 `approxTokens` and embeds each group on its own lane so one over-limit singleton cannot skip the rest of a count-32 batch.  Local archive / store-more is unchanged.  No second filing chunker.  No extra table vectors.  Did not flip `RAG_PINECONE_WRITE_CLASS` or prune.  Did not re-clamp the #2800 fuse.  Infisical can keep the count at 32.  Did not drop rag-embed from health.

**MERGED #2840** `5674dfaf`.  Hybrid condense-first stayed; packing is after that step.  One over-limit condensed text no longer skips the rest of a count-32 batch.  Do not flip write-class or prune.  Do not re-clamp the #2800 fuse.  Leave Infisical `VECTOR_EMBED_BATCH_SIZE=32`.  Confirm live `rag-embed` on real ingest batches, not only tiny probes.  Rollout: `docs/rollouts/2026-08-18-rag-embed-batch-window.md`.
## 2026-08-18 CURSOR — Green 400 failover rebased onto #2830 (`13b60747`)

PR **#2831** was CONFLICTING/DIRTY after #2830 merged (`13b60747`).  Rebased `cursor/green-400-failover-terra-2639` onto `origin/main`.  Docs auto-merged.  Did not recreate the PR.  Did not touch #2812 health-gate, #2840 rag-embed chunking, or #2841 notification history.  Runtime unchanged: 400 is failover-eligible, exhausted suffix counts stored calls only, terra is not first Green pick.

## 2026-08-18 CURSOR — Green 400 failover rebased onto #2812 (`12e8dcd`)

PR **#2831** was CONFLICTING after #2812 merged (`12e8dcd`).  Rebased `cursor/green-400-failover-terra-2639` onto `origin/main`.  Sole conflict was `docs/phase-7-strategy.md` — kept both this Green 400 stanza and #2812's rag-embed soft-degrade stanza.  Did not revert #2812 (rag-embed must not 503) or #2829/#2800.  Runtime unchanged: 400 is failover-eligible, exhausted suffix counts stored calls only, terra is not first Green pick.

Branch `cursor/green-400-failover-terra-2639`.  Rollout: `docs/rollouts/2026-08-18-green-400-failover.md`.
## 2026-08-18 GROK — Live prod triage + Alpaca getAccount cache
## 2026-08-18 GROK — Week-error expert triage + iOS Scan/Home

Owner: team of experts on all errors last 7d + iOS Scan/Home shots.  Live sha `12e8dcd` (#2812).  Health 200.  Paper Autopilot still degraded (Green 400s).  Scan empty since 8/13.  L2/L3 wedged 13h (owner-ops).

Sentry 7d: Pinecone terminated 360 (1T), OpenRouter embed 21 (1X), rerank 14 (22), CT SSE 13 (1V), NEW integrity rejection 9 (27 = #2812 remapping thrown batches, not missing key).  Do not mint OpenRouter.

Owner follow-up: data cascade + OpenRouter still failing.  #2831's PR-attached `verify` stayed cancelled (dispatch green does not count).  This PR now also carries Green 400 failover and the Nasdaq UA/retry transport so Scan has a universe and the enrichment cascade can run.  Cursor **#2840** still owns embed 8192 pack (32-text / 8193 tok bge-m3 400s).

Branch `grok/prod-triage-2026-08-18`.  Issue #2833.  Rollouts: `docs/rollouts/2026-08-18-openrouter-and-cascade.md`, `docs/rollouts/2026-08-18-prod-triage-alpaca-account-cache.md`.
## 2026-08-18 CURSOR — IRA Ignore/Block already existed; they were not wired
## 2026-08-18 CURSOR — IRA Ignore / Auto / Block + optional min-loss

Owner: min-loss should be optional, and Auto must be a choosable IRA option (not only Ignore vs Block).  `iraWashSaleHandling` is now `block | auto | disregard`.  Blank `washSaleMinLossUsd` means every loss is in play (no hidden $50 IRA default).  Ignore does not steer Green.  Auto proceeds and Green weighs priced lock costs.  Block refuses.

Prompt `agentic-strategy@2.14.0`.  Branch `cursor/ira-wash-sale-factor-a1df`.  PR #2842.  Rollout: `docs/rollouts/2026-08-18-ira-wash-sale-existing-options.md`.
## 2026-08-18 CURSOR — notification history + web/iOS inbox parity
## 2026-08-18 CURSOR — notification history rebased onto main (#2830)

PR **#2841** was CONFLICTING/DIRTY against `origin/main` after #2830 (`13b60747`) and docs #2832.  Rebased `cursor/notification-history-parity-4bbc` onto that SHA.  Sole conflict: `ios/SocraticTradeTests/UserFacingCopyTests.swift` — kept #2830 `testScanCopyDoesNotTreatWatchlistAsTheUniverse` and this PR's `testNotificationHistoryCopyStaysOrdinary`.  Silent auto-merge also duplicated `acknowledgeNotifications` in `MobileStore.swift`; dropped the extra copy.  History work unchanged: shared `notification_events`, website bell inbox, iOS Activity Notifications, last 100, ack via `POST /api/notifications/ack`.  Did not touch #2831/#2812/#2840, trading, broker, OpenRouter, RAG, or the health gate.  Not merging.  Not deploying.

Branch `cursor/notification-history-parity-4bbc`.  Rollout: `docs/rollouts/2026-08-18-notification-history-parity.md`.

## 2026-08-18 CURSOR — rag-embed soft-degrade rebased onto main (hotfix)

PR **#2812** MERGED as `12e8dcd`.  One dead rag-embed stays HTTP 200 (`ok: false`, `degraded: true`); pinecone still 503s.  Did not revert #2800/#2829.

Local after rebase: lint/tsc/focused health+embed tests/build green.  Linux VM: no xcodebuild.  Full `npm test` still hits leftover SiliconFlow + SEC/Yahoo 404s (untouched).  Rollout: `docs/rollouts/2026-08-18-rag-embed-soft-degrade.md`.
## 2026-08-18 CURSOR — Nasdaq screener UA + retry so Scan returns names

`fetchNasdaqScreener` in `src/lib/market.ts` now uses the same `BROWSER_UA` + Origin/Referer + `fetchWithRetry` as nasdaq quote/calendar.  That is the 8s stub `"Mozilla/5.0"` abort that zeroed every scan since 2026-08-13T22:30Z (last good 513 quotes).  If Nasdaq still returns 0, Yahoo prices the whole allowed set so Scan ranks names again.  iOS `MobileStore` switch is exhaustive for `.scanQuotesUnavailable` (unsigned `xcodebuild` miss); Scan shows the abort warning, not silent No Candidates.  Rebased onto `origin/main` `7b073b65` (includes #2812 and #2832).  Did not revert #2812 / #2829 / #2800.  Does not block #2831.  UA/retry path not reverted.

PR **#2830**.  Branch `cursor/scan-empty-screener-a128`.  Rollout: `docs/rollouts/2026-08-18-scan-empty-screener.md`.
## 2026-08-18 CURSOR — Green 400 must actually fail over (First Green after #2829)

#2829 is live (`6429d984`) and stopped the account-miss liar on 404.  It did not make Green complete.  Paper `PA33IDTHMFK9` run `7f5890a5-bc21-4474-87eb-9b595de04ed1` (19:33–19:38Z) picked `gpt-5.6-terra` → `openai/gpt-5.6-terra`, HTTP 400 "Provider returned error" (881ms), then claimed "Failover chain exhausted (3 Green Team endpoints)" after ONE stored `llm_call_latency`.  Red `deepseek-reasoner` never ran.  Roth had no `strategy_run` after process start 19:12:31Z.

Root cause: `isFailoverLlmStatus` left 400 out (404/403 only), and the exhausted sentence used planned seats, not stored calls.  Terra is on public `/models` but OpenRouter 400s it; fail-open still lets it win first pick.

Fix: 400 is failover-eligible (not a same-model retry, not an account miss).  Exhausted copy cites stored attempts only.  Terra is demoted from first Green pick when Gemini Flash / Mistral Medium class seats remain; those preferred seats lead implicit fallbacks.  Did not revert #2829 or #2800.  Did not rewrite the 400 sentence.

Branch `cursor/green-400-failover-terra-2639`.  Rollout: `docs/rollouts/2026-08-18-green-400-failover.md`.

## 2026-08-18 CURSOR — Pinecone daily-fuse deadlock (rebased onto hybrid)

#2800 rebased onto `origin/main` (`cda485ff`, includes hybrid #2820 `ea68c1fc`).  Verified: the trip was local-MTD remainder math, not the 2.5M fuse and not a spent Standard trial.  Live card was used 0 of 15 estimated WUs, attempted 28, skipped 1.  Local month-to-date WUs (including pre-hybrid full-body writes) were treated as Pinecone's bill; leftover lifetime units collapsed the daily fuse below one document.  Hybrid processed writes stay; write-class stays full-body; prune stays dry-run.  Did not raise a post-trial 2.5M/60k ceiling.

Branch `cursor/pinecone-write-deadlock-64c1`.  Rollout: `docs/rollouts/2026-08-17-pinecone-write-deadlock.md`.
## 2026-08-18 CURSOR — OpenRouter rotation alias miss is not "not on your account"
## 2026-08-18 CURSOR — OpenRouter "No endpoints" 404 is not "not on your account"
## 2026-08-18 CURSOR — OpenRouter 404s are not "not on your account"
## 2026-08-18 CURSOR — Today's Green 404s are valid public slugs, not tilde seats

Coolify receipts (sha `cda485ff`, SELECT-only, no raw OpenRouter JSON).  Mapper on that sha is still 404 → “isn't available on your OpenRouter account.”

Today's Green fails are **not** the missing-tilde seats.  Claude/Grok/Kimi/mini-latest were skipped (`skippedNoCredential`; that array also includes availability-filtered models) and never called.  Tilde restore will not by itself clear today's Green 404s.

Actual 404s, ~80ms, OpenRouter, `key_source=user`:
- 17:12:09Z Alpaca Paper `PA33IDTHMFK9` run `20072a55-2805-4d7a-8fa0-a1dff8c766cc`: pick `gemini-flash-latest` → called `google/gemini-3.7-flash` HTTP 404 86ms.  Failover chain exhausted (3 endpoints); only one `llm_call_latency`.  Red `gpt-5.6-luna` never called.
- 17:01:57Z Roth IRA `294709855` run `a9f29155-e139-4259-8666-25b0cf5f901c`: pick `mistral-medium-latest` → `mistralai/mistral-medium-3-5` HTTP 404 82ms.

Not 401/402/403/429.  Credits not involved.  Both slugs exist on public `/api/v1/models`.  7d 404s: `google/gemini-3.7-flash` ×2, `mistralai/mistral-medium-3-5` ×2, `mistralai/mistral-small-2603` ×1.  Fits #2771 `require_parameters=true` emptying the endpoint set.

PR **#2829** primary: omit `require_parameters` except the nano `max_completion_tokens` case; classifier must not use the account sentence for bare 404 / “No endpoints found”.  Secondary: restore `~` / dated public ids for skipped Claude/Grok/Kimi/mini-latest.  Keep `__rotate__`.  No dashboard adds.  No Stripe/IAP.

PR **#2829**.  Branch `cursor/openrouter-rotation-alias-fb04`.  Rollout: `docs/rollouts/2026-08-18-openrouter-rotation-alias-failopen.md`.

## 2026-08-18 CURSOR — IRA accounts must not tax-loss harvest

Owner screenshot: Autopilot sold NWG on the Roth with Green rationale "Harvesting unrealized loss… as part of tax loss harvesting strategy."  Roth/Traditional cannot deduct that loss.  Root cause: `taxContext` always included `harvestableLosses`, and Green was told it traded a taxable account whenever any tax block existed.

Fix: IRA prompt language forbids harvest; empty harvest candidates; omit harvest / LT-window fields on IRA runs; overlay account `taxationType` in strategy the same way the dashboard already did.  Prompt `agentic-strategy@2.12.0`.

Branch `cursor/ira-no-tax-loss-harvest-a1df`.  Rollout: `docs/rollouts/2026-08-18-ira-no-tax-loss-harvest.md`.
## 2026-08-18 CURSOR — Mobile tab bar: shrink Safari chrome gap + white underlay

Owner iPhone Safari screenshot: a grey-blue (`--con-bg` `#f1f4f6`) band sat between
the console tab labels and the floating URL chrome, and the same color showed
around the URL pill. Browser pad is now `calc(env(safe-area-inset-bottom) * 0.22)`
(~78% of the band gone). Bar + `::after` are solid `--con-surface` so the
remainder matches the tab strip. Did **not** repeat the 2026-08-05 negative-bottom
shift (that hid labels). Standalone/PWA still uses the full env() pad.

PR **#2828**.  Branch `cursor/mobile-tabbar-chrome-gap-23d5`.  lint + tsc +
`npm run build` passed.  Focused nav tests 9/9.  Full vitest not green on this
VM (unrelated live-HTTP tests).  Rollout:
`docs/rollouts/2026-08-18-mobile-tabbar-chrome-gap.md`.

## 2026-08-18 CURSOR — iOS UX owner cut (rebased onto main)

Rebased #2825 `cursor/ios-ux-owner-cut-bdae` onto `main` (`995b7eee` #2815).  Kept IRA wash-sale N/A, lowercase “rotate models”, full jargon sweep, Ask-First ↔ Autopilot + % NAV caps on device.  Kept #2815 legal clickwrap / Terms+Privacy, #2821 Daily AI Budget, and #2821 Data Sources number rows.  No coordinator notes in the UI.  Did not steal reserved PRs.  Do not merge until GitHub mergeable is CLEAN.  Rollout: `docs/rollouts/2026-08-18-ios-ux-owner-cut.md`.

## 2026-08-18 CURSOR — Per-user LLM daily budget (Settings + iOS)

**MERGED #2821 `972e3763`.**  Live store is `user_settings.llm_daily_budget` via `GET|PATCH /api/settings/llm-budget`.  Resolution: user setting → legacy `policy.tuning` → retired env `TRIGGER_LLM_DAILY_*`.  Explicit `0` = no cap.  When a cap is set and today's ledger cannot be read, skip LLM/RAG/chat (`ledger_unavailable`).  `RAG_RUN_BUDGET_*` is a Data Sources setting.  System secrets stay Infisical.  Console/iOS copy is product language only.  Rollout: `docs/rollouts/2026-08-18-user-llm-daily-budget.md`.
## 2026-08-18 CURSOR — Litestream restore drill (report only)

ASC scratch-only B2 restore on `fleet-hetzner-nbg1` (2026-08-18 UTC).  No bounce, no `FORCE_RESTORE`, no Mac pm2, both scratches off the live volume, site stayed up.  **VERIFIED:** two B2 scratches (4.9G, integrity ok, L0 txid `80781` @ 01:14:43Z), later live compare seconds/~31 rows ahead, decrypt `fred` last-4 `6dd4`, one Socratic Litestream writer, host 6h local backups, R2 weekly retain=1 (exactly one `cold-snapshots/` object).  Nothing from this drill remains BLOCKED or NOT VERIFIED.  `R2_ARCHIVE_KEEP_GENERATIONS=2` is unused on ST.  Separate Coolify 503 ~00:15–00:49Z after #2810/#2811 is not the restore proof.

Receipts flipped on **#2823** (`55a8613d`) after #2822 merged the stale BLOCKED / NOT VERIFIED rows.  This follow-up is docs-only **#2824** (`cursor/restore-receipts-followup-2cd9`).  Coolify `watch_paths` now omits `docs/**`, `STATUS.md`, `PLAN.md` — should not rebuild.  Rollout: `docs/rollouts/2026-08-17-litestream-restore-drill.md`.
## 2026-08-18 CURSOR — Paper/live pooling truth + paper cost = OOS 20 bps

Owner cut 2026-08-17: paper→live pooling stays.  Delete the leftover 20-paper+5-live transfer
gate from current-truth docs.  Paper execution-cost default rises from 1 bp to the shared
`OOS_ROUND_TRIP_COST_BPS` / `PAPER_DEFAULT_BASE_SLIPPAGE_BPS` (20).  No `autoApplyWeights`.
Code already had no 20+5 evaluator (`learning-transfer.ts` deleted 2026-07-23).

PR **#2819**.  Branch `cursor/paper-live-docs-cost-68d3`.  Rollout:
`docs/rollouts/2026-08-18-paper-live-pooling-cost.md`.  Did not touch #2792/#2798/#2800/#2794.
lint 0 errors, tsc clean, 278 focused tests pass, `npm run build` clean.

## 2026-08-18 CURSOR — Hybrid AND prune (processed operational index)

Owner cut after #2811: condense-first for Pinecone, store-more locally, then prune junk so Green/Red retrieve (scout k=1 / deep k=8 + 24k) sees useful vectors.  Minimum PR A split is on this branch: local-complete FTS + extractive highlights + form-aware signal sections + speaker-turn slices write as their own complete `storeDocument`s.  `RAG_PINECONE_WRITE_CLASS` still defaults to `full-body` (not flipped; PR B hydrate is not in this PR).  Safe prune deletes raw-HTML / junk / dupes / low-value only; useful full-body only-copies stay.  2.5M fuse + $45 reserve unchanged.  No Stripe.  Did not retarget #2792 / #2798 / #2800 / #2794.

Branch `cursor/hybrid-and-prune-7f41`.  PR #2820, rebased onto `main` (`522b2454` #2824).  Rollout: `docs/rollouts/2026-08-18-hybrid-and-prune.md`.  Next: dry-run prune against prod inventory when ready — do not `--apply` yet.  Do not flip write-class until PR B.
## 2026-08-18 CURSOR — Legal clickwrap + mandatory data-pool + keep multi-user

Owner cut 2026-08-17 items 9–11.  Versioned dismissible legal notice (clickwrap +
desk sentence + Green/Red prompt).  Data-pool is accept-or-cannot-use; unset users
do not silently share.  `/welcome` stays on; a second `ALLOWED_EMAILS` address
stays isolated.  No Stripe/IAP.  PR **#2815**.  Branch `cursor/legal-clickwrap-data-pool-1016`.
`LegalConsentSheet` is inlined in `SocraticTradeApp.swift` so the committed
`.pbxproj` compiles it.  Rollout: `docs/rollouts/2026-08-18-legal-clickwrap-data-pool.md`.
CI green on `1b9e84ca` (iOS + verify-hosted).  User-visible copy is product
language only (no remotes/surfaces/`ALLOWED_EMAILS`/Infisical asides).
## 2026-08-18 CURSOR — iOS UX owner cut (IRA wash-sale, copy, bidirectional caps)

Owner cut 2026-08-17 ~8:45pm CT; live Guardrails screenshot confirmed 2026-08-18.  IRA/Roth no longer shows Wash-Sale Guard yes or Handling auto.  `__rotate__` displays as lowercase “rotate models”.  Swept every user-facing iOS string: no `/api/policy`, snapshot, phone-safe, `policy.patch`, console-only, APNs/SSE/sandbox, or dunder tokens.  Ask-First ↔ Autopilot and raise/lower / % NAV caps on the phone.  Typed `AUTOPILOT` / live `CONFIRM` only.  Notes for Jay stay in the PR.  Did not touch reserved PRs.  `xcodebuild` not on this VM.

PR **#2825**.  Branch `cursor/ios-ux-owner-cut-bdae`.  lint + tsc + `npm run build` passed.  Full vitest hung on unrelated env/network failures (no JS product files in this PR).  `xcodebuild` not available on this VM.  Rollout: `docs/rollouts/2026-08-18-ios-ux-owner-cut.md`.

## 2026-08-18 CURSOR — Litestream restore drill (report only)

ASC scratch-only B2 restore on `fleet-hetzner-nbg1` (2026-08-18 UTC).  No bounce, no `FORCE_RESTORE`, no Mac pm2, both scratches off the live volume, site stayed up.  **VERIFIED:** two B2 scratches (4.9G, integrity ok, L0 txid `80781` @ 01:14:43Z), later live compare seconds/~31 rows ahead, decrypt `fred` last-4 `6dd4`, one Socratic Litestream writer, host 6h local backups, R2 weekly retain=1 (exactly one `cold-snapshots/` object).  Nothing from this drill remains BLOCKED or NOT VERIFIED.  `R2_ARCHIVE_KEEP_GENERATIONS=2` is unused on ST.  Separate Coolify 503 ~00:15–00:49Z after #2810/#2811 is not the restore proof.

Receipts flipped on **#2823** (`55a8613d`) after #2822 merged the stale BLOCKED / NOT VERIFIED rows.  This follow-up is docs-only **#2824** (`cursor/restore-receipts-followup-2cd9`).  Coolify `watch_paths` now omits `docs/**`, `STATUS.md`, `PLAN.md` — should not rebuild.  Rollout: `docs/rollouts/2026-08-17-litestream-restore-drill.md`.
## 2026-08-18 CURSOR — rag-embed soft-degrade (no 503 / no autonomy halt)

One dead rag-embed used to 503 `/api/health` after 5 hard failures, Coolify restarted Docker, and the boot interlock re-halted Green/Red.  `rag-embed` and `rag-rerank` now degrade like OpenRouter credits (`ok: false`, `degraded: true`, HTTP 200).  `pinecone` and `alpaca-broker` stay critical.  A thrown document-embed batch skips that batch and continues later ones; a thrown query embed returns empty retrieval.  Rebased onto `6429d984` (#2800 + #2829 kept).  Did not steal #2792/#2798/#2800/#2794.

PR **#2812**.  Branch `cursor/rag-embed-soft-degrade-ed6d`.  Rollout: `docs/rollouts/2026-08-18-rag-embed-soft-degrade.md`.
## 2026-08-18 CURSOR — Delayed Yahoo fallback stamp; keep trading

Owner: stamp user-facing **Delayed Quote** on approval cards when quotes are
delayed Yahoo fallback.  No coordinator notes on the card or in iOS UI
(no “full surfaces not just the remote”, no Infisical/remote/owner-cut asides).
Openings must still go through.  Do not fail-closed.  Do not block Green/Red.
Did not steal #2792/#2798/#2800/#2794.  No Stripe.

PR **#2818**.  Branch `cursor/delayed-yahoo-fallback-stamp-c120`.  Rollout:
`docs/rollouts/2026-08-18-delayed-yahoo-fallback-stamp.md`.

## 2026-08-18 CURSOR — Litestream restore drill (report only)

ASC scratch-only B2 restore on `fleet-hetzner-nbg1` (2026-08-18 UTC).  No bounce, no `FORCE_RESTORE`, no Mac pm2, both scratches off the live volume, site stayed up.  **VERIFIED:** two B2 scratches (4.9G, integrity ok, L0 txid `80781` @ 01:14:43Z), later live compare seconds/~31 rows ahead, decrypt `fred` last-4 `6dd4`, one Socratic Litestream writer, host 6h local backups, R2 weekly retain=1 (exactly one `cold-snapshots/` object).  Nothing from this drill remains BLOCKED or NOT VERIFIED.  `R2_ARCHIVE_KEEP_GENERATIONS=2` is unused on ST.  Separate Coolify 503 ~00:15–00:49Z after #2810/#2811 is not the restore proof.

PR **#2822**.  Branch `cursor/litestream-restore-drill-2cd9`.  Rollout: `docs/rollouts/2026-08-17-litestream-restore-drill.md`.
## 2026-08-18 CURSOR — iOS owner-note UI copy

Owner: coordinator/owner comments do not belong in the iOS UI.  Notes for Jay stay in PRs/docs.  Concrete leak on `main`: Home Desk subtitle `full surfaces, not just the remote`.  Removed that subtitle and the same class of leaked strings (control-remote setup line, Infisical footer, `/api/policy` / `policy.patch` / "not a second copy here" / "phone-safe").  Did not steal #2792/#2798/#2800/#2794 (those own FilingAPI, alert-noise, Pinecone writes, and iOS console handoffs).

PR **#2814**.  Branch `cursor/ios-no-owner-note-ui-5139`.  Rollout: `docs/rollouts/2026-08-18-ios-no-owner-note-ui.md`.

## 2026-08-18 CURSOR — Finish ROIC Individual local archive

Owner cut 2026-08-17: archive, not renew-vs-expire.  Harvest #2763 already persisted bodies, but every tick still listed each symbol on ROIC (prod `roic-transcript-refresh` 1,356 fires / 0 skipped).  This branch skips cached list/fetch, writes `data/roic-artifacts`, hydrates SQLite from disk, and reports `roicArchive` on the ops snapshot.

Last published coverage (2026-08-16): 608 transcripts / 565 tickers vs a 1,000-issuer universe.  Most names still have only the latest call.  Did not re-walk from this empty cloud checkout.  No Stripe.  Left #2800 / #2798 / #2794 / #2792 alone.

PR **#2813**.  Branch `cursor/roic-individual-archive-9ad4`.  Rebased onto `d3e2c9ee` (#2892).  Rollout: `docs/rollouts/2026-08-18-roic-individual-archive.md`.
## 2026-08-18 CURSOR — Coolify RTH deploy latch (`HOTFIX=1` escape)
## 2026-08-18 CURSOR — Coolify RTH latch + skip docs-only rebuilds (#2811 503)
## 2026-08-18 CURSOR — Coolify RTH latch + skip docs-only + `/api/live`
## 2026-08-18 CURSOR — Coolify RTH latch; `watch_paths` already live

Jay wanted auto-deploy only outside RTH unless `HOTFIX=1`.  ASC refined
tonight's 503: #2810 ~7m, #2811 ~6m, `processStartedAt` 00:49:27Z is #2811
completing.  7:22–7:43pm CT #2810 was up (litestream log, no ERROR) while
public 503 continued — `running:unhealthy` / Traefik.  ASC then applied
`watch_paths` live on `socratic-app` (`d83b1aykr03uwr32yhgzaiay`): runtime
trees only; omitted `docs/**`, `STATUS.md`, `PLAN.md`, `ios/`, `test/`.
App stayed healthy.  No bounce.  Auto-deploy still on.  Stop-old-first
kept.  `health_check_start_period` still 60.  **Do not re-apply from this
PR.**  Still shipping the in-repo RTH latch + `/api/live` HEALTHCHECK.
Rebased onto `main` after #2824.  Did not bounce, `FORCE_RESTORE`, or PATCH
Coolify.  Did not touch #2792/#2798/#2800/#2794.

PR **#2817**.  Branch `cursor/rth-deploy-latch-c039`.
Rollout: `docs/rollouts/2026-08-18-rth-deploy-latch.md`.

## 2026-08-18 CURSOR — Health JSON monitors + OPS token + R2 retain=1

UptimeRobot/Pushover must page on `schedulerStale`, `tradingLiveness.degraded`,
and `litestreamTiersDegraded` — not on HTTP 200 of `/api/health`.  Those flags
never 503.  Pinecone / alpaca-broker stay critical.  rag-embed degrade not
rewritten.  `OPS_DIAGNOSTIC_TOKEN` is required (no `ADMIN_REINDEX_TOKEN`
fallback); existing prod token works, did not mint a second.  Host-verified:
weekly retain is already 1 (`R2_COLD_SNAPSHOT_DEFAULT_RETAIN=1`,
`R2_COLD_SNAPSHOT_RETAIN` unset, `cold-snapshots/` has exactly
`app-2026-08-16.db`).  `R2_ARCHIVE_KEEP_GENERATIONS=2` is unused leftover
(`weekly/` prefix empty) and does not drive weekly retain — left alone.
Did not delete live R2 objects.  No Coolify edits.  Did not steal
#2792/#2798/#2800/#2794.

Branch `cursor/health-json-monitors-ac72` rebased onto `main` 2026-08-18
(PR #2816).  Runbook:
`docs/runbooks/uptime-health-json-monitors.md`.  Rollout:
`docs/rollouts/2026-08-18-health-json-monitors.md`.
## 2026-08-18 CURSOR — Litestream restore drill (report only)

ASC scratch-only B2 restore on `fleet-hetzner-nbg1` (2026-08-18 UTC).  No bounce, no `FORCE_RESTORE`, no Mac pm2, both scratches off the live volume, site stayed up.  **VERIFIED:** two B2 scratches (4.9G, integrity ok, L0 txid `80781` @ 01:14:43Z), later live compare seconds/~31 rows ahead, decrypt `fred` last-4 `6dd4`, one Socratic Litestream writer, host 6h local backups, R2 weekly retain=1 (exactly one `cold-snapshots/` object).  Nothing from this drill remains BLOCKED or NOT VERIFIED.  `R2_ARCHIVE_KEEP_GENERATIONS=2` is unused on ST.  Separate Coolify 503 ~00:15–00:49Z after #2810/#2811 is not the restore proof.

Receipts flipped on **#2823** (`55a8613d`) after #2822 merged the stale BLOCKED / NOT VERIFIED rows.  This follow-up is docs-only **#2824** (`cursor/restore-receipts-followup-2cd9`).  Coolify `watch_paths` now omits `docs/**`, `STATUS.md`, `PLAN.md` — should not rebuild.  Rollout: `docs/rollouts/2026-08-17-litestream-restore-drill.md`.

## 2026-08-18 CURSOR — Pinecone store-more vs condense-first (report only)

Owner: $230.44 of $300 trial left, 12 days; likely Builder ~Aug 30; keep using Pinecone, do not prune.  Question: is more storage better for Green/Red, or is condensing the corpus?  **Hybrid: condense-first for Pinecone, store-more locally.**  Builder is 10 GB / 5M WU (hard cap), not unlimited raw 10-Ks.  Do not flip write-class.  Do not raise the 2.5M fuse (pacer already ~4.8M/day).  FilingAPI stays #2792.

PR on `cursor/pinecone-store-vs-condense-ce2b`.  Audit: `docs/audits/2026-08-18-pinecone-store-vs-condense.md`.  Rollout: `docs/rollouts/2026-08-18-pinecone-store-vs-condense.md`.

## 2026-08-17 CURSOR — Blind-spots audit (report-only)

Red-team panel across legal/fintech, product identity, a11y (beyond #2795), i18n, DX, tests, observability, vendor/cost, docs, and ops calendars.  Live `gh` snapshot so FilingAPI / Pinecone 2M / PWA / ASOF claims stay current.  Register: `docs/audits/2026-08-17-blind-spots.md`.  Branch `cursor/blind-spots-audit-299e`.  Rollout: `docs/rollouts/2026-08-17-blind-spots.md`.

## 2026-08-17 CURSOR — Purchases / Stripe / StoreKit audit (report only)

Read-only.  ST has no user-facing SKU: no Stripe SDK/routes/webhooks, no StoreKit/IAP, no paywall.  Access is allowlist + mailto.  App Review 3.1.1 PASS (no web checkout inside iOS).  PWA leftover is not a live surface.  No implementation PR — do not invent a money path.  CT already owns fleet Stripe + IAP.

PR **#2809**.  Branch `cursor/purchases-stripe-storekit-audit-f1c0`.  Audit:
`docs/audits/2026-08-17-purchases-stripe-storekit.md`.  Rollout:
`docs/rollouts/2026-08-17-purchases-stripe-storekit-audit.md`.

## 2026-08-17 CURSOR — Cross-app coordination audit (report only)

Portfolio audit of ST / CT / UM / CTS / DealDex / fleet protocols.  No code
fixes.  Pins currently match CTS `v2.5.2`, but ST's pin-check still reads CT
`app/package.json` dependencies (CT is vendor-only now) so the gate is a
no-op.  ST trades if CT or UM dies; the three Coolify apps share Hetzner
fate; CT Senate ingest still needs the Mac.  DealDex is protocol-only.

PR **#2802**.  Branch `cursor/cross-app-coordination-audit-1212`.  Audit:
`docs/audits/2026-08-17-cross-app-coordination.md`.  Rollout:
`docs/rollouts/2026-08-17-cross-app-coordination-audit.md`.
## 2026-08-17 CURSOR — Pinecone daily-fuse deadlock (not a spent trial)

Owner correction after the 4:32–4:38pm CT cards.  Pinecone should still be writing.  The live
card was **used 0 of 15 estimated WUs, attempted 28, skipped 1** plus Siliconflow **0 or 1 of
1 texts** — a deadlock, not the 2.5M daily fuse and not the Standard trial wall.  Local
month-to-date WUs were treated as Pinecone's bill; remaining lifetime WUs collapsed the daily
fuse below one document, so used stayed 0.  "Expected ingest park" was agent slang for that
skip.  It was wrong.

HTTP 429 on a backup lane is not a success and not a reason to abandon the source.  Cboe is
serving ^VIX; Yahoo stays in the cascade for when Cboe dies.  Do not re-probe Yahoo while
Cboe is up (that is what burns the backup into 429s).

There is no OpenRouter files-endpoint prepaid-minimum outage.  ST `/api/health`
`openrouterCredits.ok` is true (threshold $3 only).  Owner has >$50 on OpenRouter.  CT
autopilot is still halted on a **stored** `error_class:billing` string — leftover, not a
live balance check.  Fix that in Congress.Trade; do not repeat the prepaid line.

Branch `cursor/pinecone-write-deadlock-64c1`.  Rollout: `docs/rollouts/2026-08-17-pinecone-write-deadlock.md`.
## 2026-08-17 CURSOR — Web / mobile-web / iOS parity audit (report-only)

Owner asked for a UX + a11y + parity audit of desktop website, mobile website, and native iOS.  PWA is out of scope except leftover coupling.  Report: `docs/audits/2026-08-17-web-ios-parity.md`.  No product code.  Highest findings: web ignores `?proposal=` / `?symbol=`; iOS ignores `?symbol=`; iOS Activity has no Alert Center so `run_failed` taps land empty; dead `app/mobile/components` tree still in repo.

Branch `cursor/web-ios-parity-audit-e83a`.  Rollout: `docs/rollouts/2026-08-17-web-ios-parity-audit.md`.
## 2026-08-17 CURSOR — Trading-outcomes audit (report-only)

Read-only audit of macro/regime, Green/Red/Bull, proposal→fill, risk, backtests, benchmarks, slippage, leakage, paper/live pooling, and learning.  No trades.  No money-path edits.

Highest P1s: propose-time regime uses 24h-cached VIX while the vol brake uses live VIX; `compareGreenRedParity` is never called in production; paper lessons pool into live (owner-directed) while Phase 7 still describes a transfer gate; `oosPurgeEmbargo` defaults off and IC sample caps at 500; paper cost default is 1 bps vs OOS 20 bps; #2280 slice 2 (PIT masking) still blocks LLM-in-history eval.

Report: `docs/audits/2026-08-17-trading-outcomes.md`.  Branch `cursor/trading-outcomes-audit-c37a`.  Rollout: `docs/rollouts/2026-08-17-trading-outcomes-audit.md`.
## 2026-08-17 CURSOR — Architecture & backend audit (docs-only)

Read-only audit of framework, API, queues, persistence, caching, concurrency, recovery, and durability against `main` `4980322b`.  No product fixes.  Report: `docs/audits/2026-08-17-architecture-backend.md`.  PR #2807, branch `cursor/architecture-backend-audit-6186`.  Headline: no active P0 in code; new gap is stale `strategy_run_requests` (F3); Litestream L2/L3 wedge remains owner-ops (F1, already tracked).  Rollout: `docs/rollouts/2026-08-17-architecture-backend-audit.md`.
## 2026-08-20 CURSOR — RAG P0 follow-ups (parsed-text SEC, chat asOf, production eval)

Implemented the audit P0s on `cursor/rag-learning-recall-audit-f94a` / PR #2803.  `buildSecDocument` is the one SEC writer (no raw HTML).  `getCikForTicker` uses ticker→CIK and refuses the sentinel.  Chat `searchKnowledge` always passes `asOf`.  Eval harness + contract test score `retrieveContextDetailed`.

Report: `docs/audits/2026-08-17-rag-learning-recall.md`.  Rollout: `docs/rollouts/2026-08-20-rag-p0-followups.md`.

Local gate: lint 0 errors, `tsc --noEmit` clean, touched-file vitest green, `npm run build` exit 0.  Full `npm test` in this Cloud VM had 37 unrelated env failures (Yahoo/SEC 404, Voyage-vs-SiliconFlow, notify/host-metrics).  Next: wait for `verify` on #2803.  P1 leftovers stay open (transcript FTS, 8-K feed dual-class, memory decay/lifecycle, learning vector retry).  Do not enable `SEC_INGEST_WORKER_ENABLED` until a staging ingest proves `buildSecDocument` text is tag-free.

## 2026-08-17 CURSOR — RAG / learning / recall audit (report-only)

Read-only audit of ingest, SEC/ROIC/transcripts/news, chunk/embed, retrieval, grounding, PIT, lineage, learning ledger, memory, evals, and failure recovery.  Highest gaps: worker embeds raw HTML; transcripts have no FTS backstop; golden harness scores a different retriever than Green/Red; memory decay/lifecycle unwired; chat/desk omit `asOf` so prod `VECTOR_ASOF_STRICT` is a no-op there.

Branch `cursor/rag-learning-recall-audit-f94a`.  PR #2803.  Report: `docs/audits/2026-08-17-rag-learning-recall.md`.  Rollout: `docs/rollouts/2026-08-17-rag-learning-recall-audit.md`.
## 2026-08-17 CURSOR — Security / reliability audit (report-only)

Read-only audit of auth, secrets, tenant isolation, supply chain, PII, Litestream/DR,
deploy, alerting, fail-open/closed, spend, and SLOs.  Live health 200 on sha `4980322b`;
Litestream replicating; restore still unproven on B2.  No code changes.

Branch `cursor/security-reliability-audit-d8f6`, PR #2806.  Report:
`docs/audits/2026-08-17-security-reliability.md`.  Rollout:
`docs/rollouts/2026-08-17-security-reliability-audit.md`.
## 2026-08-17 CURSOR — Brokers + data-cascade reliability audit (report-only)

Read-only audit at `main` `4980322b`.  No broker mutations.  Report:
`docs/audits/2026-08-17-brokers-data-cascade.md`.

Highest remaining defects: Alpaca still sends `type: "stop_market"` (Tradier maps to
`"stop"`; protective stops use that type; the current test pins the wrong wire word);
Tradier plain-order prices skip `roundCents`; Marketstack history and ROIC financials
skip `admitProviderRequests`; ROIC/Yahoo quote-only `asOf` is fetch time.

FilingAPI: `main` is retired (#2787).  Owner reversal #2792 (soft-skip 401, CONFLICTING)
is the live product question — do not claim Plus checkout and do not treat retirement
as final.  #2788 re-retires.  #2798 mutes leftover 401s.  #2800 skips `vix-yahoo`
re-probe while Cboe serves.

Already closed on this HEAD: T sub-penny 422 (#2751), UND_ERR_SOCKET single-blip halt
(#2720), RH MCP extra args (#2576), ROIC 714-row crash loop (#2750).

Branch `cursor/brokers-data-cascade-audit-bed0`.  PR #2805.
Rollout: `docs/rollouts/2026-08-17-brokers-data-cascade-audit.md`.
## 2026-08-17 CURSOR — Remove leftover installable PWA

Owner never uses the PWA and asked to disable/delete it.  2026-08-16 only
redirected `/mobile` and left the standalone manifest, `appleWebApp`, and dead
PWA client in place.  This branch deletes the PWA client, stops advertising an
installable web app, 410s `/manifest.webmanifest`, unregisters leftover service
workers, and keeps `/api/mobile/*` + responsive `/console` + native iOS.

Branch `cursor/retire-pwa-72cb`.  PR #2801.
Rollout: `docs/rollouts/2026-08-17-retire-pwa.md`.

## 2026-08-17 CURSOR — Pinecone trial is not the Starter 2M monthly wall

Owner: the app thinks monthly Pinecone write units are at the free-tier limit, and Pushover
is still firing for Litestream plus leftover health noise.  Live Pinecone is a Standard trial
(usage-billed ~$300 through 2026-08-30).  It does **not** have the Starter 2M WU / month cap.

A leftover `pinecone:wuExhaustedUntil` marker (or a 2M-shaped 429) parked every vector write
until the 1st of next month.  The gate runs before any upsert, so success could never clear
it.  A leftover `PINECONE_MONTHLY_WU_BUDGET=2000000` (or the post-trial 1.6M snap) also paged
the monthly pace guard.  Litestream L0–L3/L9 were already advancing; the remaining page was a
healed `compaction failed` line still in the log tail.  Public `/api/health` still listed
retired FilingAPI as `ok: false`.

Branch `cursor/pinecone-wu-trial-alerts-c9a3`.  Rollout:
`docs/rollouts/2026-08-17-pinecone-trial-wu-alerts.md`.

## 2026-08-17 CURSOR — Settings search in the command palette (#2558)

`searchSettings` / `SETTINGS_FIELDS` existed but no UI imported them.  ⌘K now returns catalog hits that deep-link to live section hashes.  Phantom `defaultLandingAccount` (and its "for safety" copy) is gone.

Branch `cursor/settings-search-palette-6e98`.  Rollout: `docs/rollouts/2026-08-17-settings-search-palette.md`.
## 2026-08-17 CURSOR — iOS release-readiness leftovers (#2560)

Close-only / Wind Down and APNs client+server already landed on main.  Remaining
in-repo gaps: `PrivacyInfo.xcprivacy`, Safari handoffs from Home/Settings to
`/console/connections` and `/console/strategy` (not AASA-claimed), honest
price-alert copy, and a pin that `ITSAppUsesNonExemptEncryption=false` matches
`project.yml`.  Do not invent APNS_* credentials — owner adds the Apple .p8 set
in Infisical when ready.

Branch `cursor/ios-release-readiness-2560-b532`.  Rollout:
`docs/rollouts/2026-08-17-ios-release-readiness.md`.
## 2026-08-17 CURSOR — P3 curl-only diagnostics get UI entry (#2563)

Four existing routes were curl-only: tuning-dry-run, learning-ledger, backtest-ic, `/api/audit`.
This branch adds console/admin paths and does not change server behavior.

- Strategy: Weight Tuning Preview (`GET /api/admin/tuning-dry-run`)
- Lessons: Learning Ledger (`GET/POST /api/admin/learning-ledger`)
- Admin: Factor Backtest (`GET /api/admin/backtest-ic`)
- Activity: Audit tab (`GET /api/audit`)

Branch `cursor/p3-curl-only-ui-2563-814a`.  PR #2793.  Rollout: `docs/rollouts/2026-08-17-curl-only-ui-entry.md`.
## 2026-08-17 CURSOR — Console a11y batch (#2561)

P1/P2 from the 2026-08-06 product review: light-theme chip text now meets WCAG AA on soft fills; Sheet and TabsSheet use the stack-aware focus trap so Escape closes only the topmost surface; tooltips are keyboard-reachable and announced; the scan Columns popover has aria-expanded/controls + Escape/focus; Meter can take an accessible name; dark `--con-faint` has AA headroom; Toggle `label` is required.

Branch `cursor/console-a11y-batch-08ac`.  PR #2795.  Rollout: `docs/rollouts/2026-08-17-console-a11y-batch.md`.  No trading/money-path changes.
## 2026-08-17 CURSOR — CT+UM lane backoff (#2550)

ST consumers of Congress.Trade and Usage-Monitor now widen backoff when those
lanes are slow (p50 > 2s) and treat SSE flaps as soft.  Console stays up.  No
CT/UM server changes.  Vitest `setupFiles` resets peer-lane samples after each
test so `maxWorkers: 1` cannot leak a slow p50 into later files.

Branch `cursor/ct-um-lane-backoff-7cf2`.  Rollout: `docs/rollouts/2026-08-17-ct-um-lane-backoff.md`.

## 2026-08-17 CURSOR — FilingAPI optional key, degrade on 401 (retarget #2778)

Owner reversed the #2787 retirement.  Keep `FilingApiEnrichmentProvider`, the `filingapi` health lane, and the capability-matrix entry.  Stop using the dead stored `FILINGAPI` key (prod 401): missing / invalid / 401 is a soft skip, health stays green, ROIC + SEC EDGAR cover the fields.  A later valid key is used again.  Do not buy Plus.  Do not charge Stripe.

#2787 already merged the retirement to `main` (`b4666e74`).  Follow-up branch `cursor/filingapi-soft-skip-de61` reverts that squash and implements the skip.  Rollout: `docs/rollouts/2026-08-17-filingapi-soft-skip.md`.

## 2026-08-17 CURSOR — Green-Team empty/malformed failover + credits hint (#2577)

Aug 6: five Green Team runs died on OpenRouter `Empty response` across rotated models while the credits-low monitor flapped.  Green Team **is** the Bull proposer and already failed over on empty HTTP-200s when `llmFallbackModels` was set (#2313 / 2026-07-31).  Remaining gaps: malformed HTTP-200 JSON did not fail over; a rotating Green seat with no owner fallbacks was a single-model chain; `run_failed` never named a below-threshold OpenRouter balance.

Branch `cursor/green-empty-failover-credits-7003`.  Rollout: `docs/rollouts/2026-08-17-green-empty-failover-credits.md`.
## 2026-08-17 CURSOR — Website favicon cropped offset ST

Issue #2731.  Website tab icon is the iOS App Icon's offset candlestick ST (S higher than T), cropped so it barely fits, transparent background.  Generator: `node scripts/generate-favicon-st.mjs`.  iOS App Icon was not written.  Branch `cursor/favicon-crop-st-e6ee`.  Rollout: `docs/rollouts/2026-08-17-favicon-crop-st.md`.

## 2026-08-17 GROK — Effort-board hygiene

In Progress rebuilt to leftover real work. Verified-merged rows moved to Completed. Landing this mirror so GitHub effort issues close.

## Current (2026-08-17 GROK — strategy-run slugs + lease-lost mislabel)

Owner screenshot 8:34–8:38am CT.  Green Team failed on OpenRouter `mistralai/mistral-medium-3.5` (invalid; public slug is `mistral-medium-3-5`) and `gpt-5.4-nano` 400 Provider returned error (slug is correct; OpenAI endpoint is status -2 and does not advertise `max_completion_tokens`, Azure is healthy).  Pinecone + OpenRouter rerank "connection failed" at 13:34Z are `ProviderDispatchLeaseLostError` during the UptimeRobot 1m23s blip, not vendor outages.  Last-2d Pinecone Sentry otherwise is the known WU-fuse park.

Branch `grok/strategy-run-model-slugs`, issue #2770.  Rollout: `docs/rollouts/2026-08-17-strategy-run-model-slugs.md`.

## Current (2026-08-16 GROK — VECTOR_ASOF_STRICT on)

Owner: flip fail-closed dated retrieval.  Infisical ST prod `VECTOR_ASOF_STRICT=on` (was `off`).  Coolify restart `fwqascvivxvc7342hkw3aizk` finished; `https://socratictrade.com/api/health` is 200.  Live desk still omits `asOf`.  Branch `grok/asof-strict-on`.  Rollout: `docs/rollouts/2026-08-16-asof-strict-on.md`.

## Current (2026-08-16 GROK — ROIC Individual harvest)

Owner: get all we can from ROIC Individual (couple of weeks left) — breadth across the universe plus depth on names of most interest.  Expert panel already decided storage in `docs/designs/2026-08-16-proposer-corpus-storage.md` rev 3 (#2760).  No second panel.

This branch implements the transcript slice of that decision:

- Persist every fetched call into `earningscalls_transcripts` first (survives Individual expiry).
- Do not skip the ROIC walk when the Pinecone write fuse is spent.
- `latest` → one newest call for the demand-first universe.
- `deepen` → 20 quarters for held / watchlist / technical.
- `archive` → 20 quarters for everyone else, local cache only.
- Pinecone: extractive `earnings-summary` for latest/deepen; full-body only for the newest high-interest call (transcript exception until FTS exists).

#2750 `1867addd` single-flight is on `main`; Coolify deploy was in_progress at harvest start.  FilingAPI still owner Plus.

Rollout: `docs/rollouts/2026-08-16-roic-harvest.md`.

## Current (2026-08-16 GROK — 48h money-path + ingest)

Owner: explain rotation fail-open and 422s, then fix those plus Red timeout, and unstick SEC/ROIC/RAG ingest (Pinecone stay builder/free-ready).

- Rotation fail-open: when `/models/user` times out we still used the full catalog, including `kimi-latest` / `claude-fable-5` whose OpenRouter slugs 404.  Fail-open now drops those known-dead ids.
- 422: Alpaca HTTP reject.  Sub-penny limits on T (`24.865`) now round to `$0.01` at the Alpaca boundary.
- Red Team: same `llmFetchCapturing` + `strategyLlmTimeoutMs` path as Green (no 45s hard abort).  Adversary output cap 2500.
- Ingest: cherry-picked ROIC single-flight.  Requeue ~1k `embed_queued` dead letters that were misclassified budget-exceeded.  Budget skip defers 1h instead of dead-lettering.  Worker tick now claims at most 5 tasks across all jobs (prod had 521 running jobs claiming 5 each, so 2156 Aug-10 `facts_extracted` never ran).  Sibling #2748 owns the daily WU fuse park.

Branch `grok/48h-money-path-ingest`, issue #2749.  Rollout: `docs/rollouts/2026-08-16-48h-money-path-ingest.md`.
## Current (2026-08-16 GROK — ROIC single-flight + L2 shrink)

Owner: continue Litestream L2/L3, FilingAPI, and ROIC universe ingest until they actually work.

Branch `grok/roic-singleflight`, worktree `~/apps/trading-grok-ops-roic`.

#2741 is live (`4bd3bcc0` contains `b28a76ad`).  The new 6h due check wrote `lastAttemptAt` only at the end of a walk, so every 60s tick started another ROIC refresh.  Prod stacked 714 running `roic-transcript-refresh` rows and crashed about every 22 minutes (`last_restart_type=crash`).  Stopped the app, stamped `lastAttemptAt`, aborted the stacked journal rows, and restarted the existing image.  This PR single-flights the walk, stamps start immediately, persists the cursor after each symbol, and treats `lastAttempt` as a 30-minute in-flight window (a leftover cursor still resumes).

Litestream: L1 shrink keep-400 is in progress on B2 so the first L2 compact is small enough to finish.  L9 snapshots remain the restore floor.

FilingAPI: Infisical `FILINGAPI` is the same dead 32-char trial key (401).  Free signup is claimed.  Do not charge the owner's Stripe (that is ST's merchant account).  Owner Plus checkout on filingapi.dev is still required.

ROIC coverage before the pile-up: 46 transcripts across USB / OXY / SHEL (Individual 20-quarter depth).  After this lands the cursor can walk the rest of the universe without crashing the box.

Rollout: `docs/rollouts/2026-08-16-roic-singleflight.md`.
## Current (2026-08-16 GROK — iOS Proposals for Review TestFlight)

#2740 `c1db7d12` is on TestFlight **1.0.36 (202608162123)**, ASC
`IN_BETA_TESTING`.  Home tile title is **Proposals for Review** above the
count.  Cron ship run `31970196190`.  Owner: install that build on the phone.

## Current (2026-08-16 GROK — overlay regime match hotfix)

#2743 shipped Overlays, but live apply passed `determineMarketRegime` labels (`Risk-On (Low Volatility)`) into a router that matches enums (`risk-on`).  Only `any` overlays could fire.  Branch `grok/overlay-regime-match`.  Rollout: `docs/rollouts/2026-08-16-overlay-regime-match.md`.
## Current (2026-08-16 GROK — 13F + ARK + Form 4 operational)

#2735 closed.  Live `f0fd2b70` after #2736 + #2747 + #2758:
Form 4 537 (340 ticker), 13F 413 / 12/12 ISO quarter-ends, ARK 222
across ARKK/Q/W/G/F/X as-of 2026-08-14.  Observe-only.

## Current (2026-08-16 GROK — 48h prod error triage, Pinecone daily write fuse)

Pinecone trial is healthy ($238 of $300).  The "Usage limit hit" is the app's
rolling-24h write fuse at the trial cap of 2.5M estimated WUs, not a Pinecone
outage.  Retrieval still works.  Did not raise the cap.

Park incremental ingest when the fuse is spent.  Trial ingest stays full-steam
until ~$45 remains, then paces to the trial end.  On 2026-08-30 UTC snaps to
free-tier 60k WU/day.  ROIC/FMP/SEC now take the **latest** transcript and
latest 10-K/10-Q for the universe first, then extra history only for
held/watchlist/technical names.  Expert consensus: keep full bodies in SQLite
FTS + artifacts; do not LLM-summarize ingest; after trial put only extractive
highlights + N best sections in Pinecone.  Branch `grok/prod-error-triage-48h`.

Rollout: `docs/rollouts/2026-08-16-prod-error-triage-48h.md`.
## Current (2026-08-16 GROK — review UX: approve speed, prices, retry red team, agent controls)

Owner: Approve hung on "Sending approve…".  Review cards hid live vs proposed
price.  Red Team timeout had no retry.  Start Agent and Stop Agent both showed
while Autopilot was only paused for a closed market.  PWA unused.

Approve quotes the proposal + holdings only (no full screener).  Cards show
Proposed / Now / Target / Delay.  Retry Red Team on a failed critic.
Agent Controls use one primary action.  `/mobile` redirects to `/console`.

Branch `grok/review-ux-parity`, worktree `~/apps/trading-grok-review-ux`.
Rollout: `docs/rollouts/2026-08-16-review-ux-parity.md`.
## Current (2026-08-16 GROK — ASC EULA + Coolify rolling already off)

Owner authorized ASC writes and the Coolify rolling steps.  ST custom EULA
was patched to two spaces.  What's New cannot be edited on first version
`1.0.0` (Apple STATE_ERROR).  Coolify `socratic-app` already has consistent
container names and a 60s health-check start period — no flip.  B2 L2 cleanup
was not authorized in this ask.  Receipt:
`docs/rollouts/2026-08-16-asc-eula-coolify.md`.
## Current (2026-08-16 GROK — ARK official CSV fallback)

#2747 is live.  13F is complete in prod (413 rows, 12/12 filers, ISO
quarter-ends).  ARK stayed 0 because `ark-funds.com` document-table is a
Cloudflare 403 and the throw skipped the working
`assets.ark-funds.com` CSV fallback.

Branch `grok/ark-csv-fallback`.  Use the official CSV URL when the table
is blocked.  Empty ARK retries after 2 minutes, not 1 hour.

## Current (2026-08-16 GROK — 13F/ARK ops fix)

#2736 is live (schema 83) but not fully operational.  Prod receipts:
Form 4 537 (340 with ticker), 13F 210 rows / 7 of 12 filers with
`period_end` = accession CIK, ARK 0 rows with `fetchedAt` set so TTL
locked the retry.

Fixes on `grok/idea-sources-ops-fix` (worktree
`~/apps/trading-grok-idea-sources-ops`, issue #2735): parse `06-30-2026`
and namespaced `<ns1:infoTable>`, pick unnamed info-table XML, do not
treat `form13f_YYYYMMDD.xml` as the cover, skip persist without a real
quarter-end, stay due when `okFilers` is incomplete or ARK count is 0.

Rollout: `docs/rollouts/2026-08-16-idea-sources-ops-fix.md`.

## Current (2026-08-16 GROK — iOS Proposals for Review + price delay)

MERGED #2740 as `c1db7d12` (auto-deploy on).  Home tile title is
**Proposals for Review** above the count, nothing under the number.
Review cards show proposed / now / target / delay.  Strategy prompt
`agentic-strategy@2.10.0` has Green/Red debate `exitPlan` when the
target is omitted.  Native TestFlight is the remaining owner-visible
step.  Rollout: `docs/rollouts/2026-08-15-ios-proposals-for-review.md`.
## Current (2026-08-16 GROK — ticker desk sheet)

Tapping a ticker on the website (desktop and phone widths) and iOS now
shows the current lot (qty, avg cost, open P&L), the persisted exit plan,
pending ideas, last Green/Red call, and a size+direction mention of the
same name on another of the user's accounts with a switch control.  PWA
is not a product surface (owner 2026-08-16) — no further `/mobile` work.
No extra broker fan-out; peer lots are last recorded snapshots.

Branch `grok/ticker-desk-sheet`.  Rollout:
`docs/rollouts/2026-08-16-ticker-desk-sheet.md`.
## Current (2026-08-16 GROK — ROIC single-flight + L2 shrink)

Owner: continue Litestream L2/L3, FilingAPI, and ROIC universe ingest until they actually work.

Branch `grok/roic-singleflight`, worktree `~/apps/trading-grok-ops-roic`.

#2741 is live (`4bd3bcc0` contains `b28a76ad`).  The new 6h due check wrote `lastAttemptAt` only at the end of a walk, so every 60s tick started another ROIC refresh.  Prod stacked 714 running `roic-transcript-refresh` rows and crashed about every 22 minutes (`last_restart_type=crash`).  Stopped the app, stamped `lastAttemptAt`, aborted the stacked journal rows, and restarted the existing image.  This PR single-flights the walk, stamps start immediately, persists the cursor after each symbol, and treats `lastAttempt` as a 30-minute in-flight window (a leftover cursor still resumes).

Litestream: L1 shrink keep-400 is in progress on B2 so the first L2 compact is small enough to finish.  L9 snapshots remain the restore floor.

FilingAPI: Infisical `FILINGAPI` is the same dead 32-char trial key (401).  Free signup is claimed.  Do not charge the owner's Stripe (that is ST's merchant account).  Owner Plus checkout on filingapi.dev is still required.

ROIC coverage before the pile-up: 46 transcripts across USB / OXY / SHEL (Individual 20-quarter depth).  After this lands the cursor can walk the rest of the universe without crashing the box.

Rollout: `docs/rollouts/2026-08-16-roic-singleflight.md`.

## Current (2026-08-16 GROK — overlay CRUD + Polymarket deepen + ASOF receipt)

Owner: (1) full overlay product + expansions; (2) defer weekly hard-delete; (3) no Reddit/X — deepen Polymarket including sector/macro tilts; (4) run VECTOR_ASOF_STRICT coverage.

Branch `grok/overlay-poly-asof`, worktree `~/apps/trading-grok-overlay-poly`.

Overlays: Strategy → Overlays card (enable, max active, starters, CRUD, would-fire preview).  Starters seed disabled.

Polymarket: company + curated sector/theme + US macro block.  Tilt is a label from question kind × Yes price.  No 0-100 score.

ASOF dry-run on live `socratic-trade`: 13076 scanned, 13076 epoch'd, 0 undated, 0 errors.  Did not flip the flag.

Rollout: `docs/rollouts/2026-08-16-overlay-poly-asof.md`.  Receipt: `docs/rollouts/2026-08-16-asof-strict-coverage.md`.

## Current (2026-08-16 GROK — Litestream L1 suffix + FilingAPI + ROIC universe)

Owner: actually unstick L2/L3, fix FilingAPI (mint if the global key is dead), and ingest ROIC.ai earnings calls across the universe with useful history, stored so the LLM can read many accurately.

Branch `grok/litestream-filingapi-roic`, worktree `~/apps/trading-grok-ops-roic`.

Litestream: live log still `non-contiguous (431e5-43206)->(43225-43247)`.  B2 L1 had 5959 files / 18 holes / 11 twins.  Deleted the prefix before the newest contiguous suffix (`4a86` onward).  L0/L9 untouched.

FilingAPI: handoff and Infisical are the same 32-char key; vendor 401 Invalid API key.  Free-trial signup is already claimed on the owner's emails.  Added a real re-probe and env trim.  A live key still needs a Plus checkout on filingapi.dev.

ROIC: retrieval no longer strips ROIC chunks when FMP/EarningsCalls are off.  List-first, skip-if-stored, speaker sections + earnings-summary digest, universe cursor, Individual 20 quarters, Infisical max-per-run 120.

Rollout: `docs/rollouts/2026-08-16-litestream-filingapi-roic.md`.

## Current (2026-08-15 GROK — 13F + ARK + Form 4 idea sources)

Owner: run 13F, ARK daily holdings, and Form 4 as thoroughly as possible and
fully operational.  Official SEC EDGAR + official ARK CSVs only.  Observe-only
(no auto-copy).  eToro CopyTrader stays off.

Branch `grok/idea-sources-13f-ark-form4`, worktree
`~/apps/trading-grok-idea-sources`.  Rollout:
`docs/rollouts/2026-08-15-idea-sources-13f-ark-form4.md`.

## Current (2026-08-14 GROK — unstick PR #2707 Kalshi/exits/options)

Rematched `origin/main` (merge-tree clean; GitHub CONFLICTING was phantom).
verify-hosted run 31762430767 failed `npm run build` with
`UnhandledSchemeError: Reading from "node:crypto"` via
`kalshi.ts` -> `kalshi-macro.ts` -> `strategy.ts` -> `scheduler.ts`.
Fixed `src/lib/kalshi.ts` to `import crypto from "crypto"` (same Next/webpack
scheme-plugin trap documented in `apns.ts`). Branch
`grok/st-kalshi-exits-options`, worktree
`~/apps/trading-grok-kalshi-exits`. Rollout:
`docs/rollouts/2026-08-14-kalshi-node-crypto-webpack.md`.
## Current (2026-08-15 GROK — stop ghost Gemini/DeepSeek keys)

Connections kept showing Gemini and DeepSeek keys after the owner removed them.  Cause: Infisical ST prod `/` still has `GEMINI_API_KEY` / `DEEPSEEK_API_KEY`; every Coolify boot ran `migrateLocalEnvCredentials`, which copied them onto `local` and treated a delete tombstone as empty.  Prod rows are labeled `migrated from env` (2026-07-24).

The last-48h failed Gemini/DeepSeek calls were **OpenRouter** (`llm_usage.provider=openrouter`), not native.  Strategy/Red Team prefer OpenRouter when that key exists.

Fix on `grok/stop-ghost-native-keys`, issue #2728 / PR #2729: never remigrate a tombstone; do not auto-seed Gemini/DeepSeek; tombstone existing `migrated from env` rows on boot.  Owner then had the Infisical source deleted: ST prod `/` no longer has `GEMINI_API_KEY` or `DEEPSEEK_API_KEY`.  `infisical-secrets-safe.sh set` refuses LLM runtime names.  Rollout: `docs/rollouts/2026-08-15-stop-ghost-native-keys.md`.
## Current (2026-08-14 GROK — ban grepping secrets files for KEY=value lines)

Owner: change agent rules so nobody dumps `~/.secrets/global-api-keys` into a
transcript.  Rotation is already done; do not re-litigate it.

Added the handoff-file grep trap to AGENT-SYNC, TEMPLATE-AGENTS, this
`AGENTS.md`, and the secret-safety skill.  Names only: `grep -oE`.
Branch `grok/secret-file-grep-ban`.

Rollout: `docs/rollouts/2026-08-14-secret-file-grep-ban.md`.

## Current (2026-08-15 GROK — account-config Title Case)

Capabilities sheet on Connections was mixing Title Case chips (`Connected`, `Disabled`) with sentence-case values (`Whole shares`, `regular + extended`).  Labels and chips now match: `Fractional Shares`, `Whole Shares`, `Regular + Extended`, `Orders · Level N`.

Branch `grok/account-config-title-case`, issue #2726.  Rollout: `docs/rollouts/2026-08-15-account-config-title-case.md`.

## Current (2026-08-15 GROK — model family identity for Results / benchmarks / history)

Owner: Gemini 3.7 Flash must roll up as `gemini-flash-latest` (same for every Flash Lite, every Pro, every Opus, every Sonnet, and so on).  `canonicalModelId` already had the family table; Results and Red-Team efficacy still keyed off the wire slug (`google/gemini-3.7-flash`), so history split.

Branch `grok/model-family-identity`, issue #2724.  Red stamps the catalog family on the verdict.  Efficacy, critic-failure attribution, closed-lot models, and the approval-card compare path all go through `canonicalModelId`.  Usage merge and model-stats already did; they now also merge two reviewer-perf rows that canonicalize onto the same family.

Rollout: `docs/rollouts/2026-08-15-model-family-identity.md`.

## Current (2026-08-14 GROK — bound per-document FTS mirror + durable resume)

#2680's 250ms yield inside `insertDocumentChunkFtsBatch` did not bound wall-clock.  Live receipts after that "fix": `ftsMirrorBatch 279522ms (933 chunks)`, then 103s / 98s / 91s.  Every `embed_queued` task failed to advance (`Failed to advance checkpoint` + `Ingestion budget or capacity exceeded mid-task`).  Queue 3501 pending / 16 complete (~0.5%).  Lease is 60s and was heartbeated only during `storeDocument`.

**Fix (this branch `grok/bound-fts-mirror`, issue #2715):** slice FTS at **20 chunks or 6s wall, whichever first** (`20 * (279522/933) = 5991.9ms`).  Resume from durable FTS row count.  Heartbeat the lease across the mirror.  Release immediately so the next tick continues.  `insertDocumentChunkFtsBatch` keeps its internal 250ms yield; the worker never feeds it 933 chunks.

**This PR does not re-enable the worker.**  Re-enable `SEC_INGEST_WORKER_ENABLED` is the owner's call after this lands.  Do not flip Infisical.  Do not restart prod.

Rollout: `docs/rollouts/2026-08-14-bound-fts-mirror.md`.
## Current (2026-08-13 GROK — r5 residue: advisory-tail reword + parked owner decisions)

After Monet #2682 (real toggles) and Claude's yielded `r4-toggles-superseded` salvage, the
only well-specified leftover that does **not** collide with the sibling `grok/claude-r4-pickup`
lane is the shared `risk_advisory` tail.  Old copy ("the agent is still in control") is a lie
for owner-initiated actions (cancel-dust).  Reworded to "nothing was blocked or changed" in
SMS/push + Discord fallback, with tests + a force-include merge-gate adapted to #2682 names.

Claude's settings-surface sweep found no other lying toggles (FMP "intent only" caveat is
honest; Autopilot glossary is accurate).  Parked for the owner, not invented: Reddit/X keys,
`VECTOR_ASOF_STRICT` flip (honesty copy only), r5 design slices, settings/page.tsx label
until r4 PR merges.  Branch `grok/claude-r5-residue`.  Rollout:
`docs/rollouts/2026-08-13-pickup-r5-residue.md`.
## Current (2026-08-14 GROK — Monet backend r5 pickup)

Owner asked to finish Monet's "Backend updates (ST - Monet)" chat after the usage cap.  Ingestion/FTS hotfix (#2680) and toggles (#2682) were already live.  Round 5 is on `grok/monet-backend-r5` as **#2721** (locks / memory decay / overlays / chat cancel / scorecard alpha; migrations 79–81).  Prompt version `agentic-strategy@2.6.0`.

2026-08-15: rematched `origin/main` (includes #2720) then `verify-hosted` failed on `test/web-sources.test.ts` after midnight UTC — the live-flow stub's `06/16/2026` disclosedAt aged out of the 60-day window.  Fixture dates are now relative to `Date.now()`.  #2689 is held (superseded by this stack).  #2691 is independent residue.

Rollout: `docs/rollouts/2026-08-14-monet-backend-r5.md`.

## Current (2026-08-13 GROK — Claude r4 leftover pickup)

Claude hit quota mid Round 4.  `origin/agent/claude` is gone; five local r4 commits sat on
`~/apps/trading-claude` at `40d5c087`.  r3 already merged as #2666.  Toggles slice yielded to
Monet and merged as #2682 (migration 78).  APNs claimed migration 77.

Picked up in a new worktree (`~/apps/trading-grok-r4`, branch `grok/claude-r4-pickup`) from
`origin/main` `77bbb77f`.  Cherry-picked oldest-first:

1. `1ac172a9` outcome benchmarks (`^GSPC` + GICS sector, ETF fallback)
2. `9f7f870f` ATR-derived `secondaryBuy` pullback
3. `293d4bb5` server-knob Operations panel
4. `cb645a02` congress-stream level-based resume + honest effect copy
5. `40d5c087` strategist prompt data-age stamps

No schema bump in these five (main stays at 78).  Conflicts: `vector-db.ts` kept main's
`resolveSourceBool` and r4's `serverKnobBool`; `STRATEGY_PROMPT_VERSION` bumped to
`agentic-strategy@2.5.0` because main already used 2.4.0 for the venue-contract prompt.
Advisory-tail reword / settings-surface sweep is NOT in these five commits (it rode Monet
#2682) — left alone.

Rollout: `docs/rollouts/2026-08-13-claude-r4-pickup.md`.
## Current (2026-08-16 GROK — ticker desk sheet)

Tapping a ticker on web, PWA, and iOS now shows the current lot (qty, avg
cost, open P&amp;L), the persisted exit plan (stop / take-profit / trail /
harvest band / kill condition), pending ideas with their rationale, and a
size+direction mention of the same name on another of the user's accounts
with a switch control.  No extra broker fan-out; peer lots are last
recorded snapshots.  RAG/full debate left for v2.

Branch `grok/ticker-desk-sheet`.  Rollout:
`docs/rollouts/2026-08-16-ticker-desk-sheet.md`.

## Current (2026-08-14 GROK — stale ~1200s quotes + origin timeouts)

Production 2026-08-13/14: Autopilot openings warned "quote was ~1200s old",
UptimeRobot Connection-Timeout'd `socratictrade.com` (and the paired OpenRouter
credits keyword monitor) every ~15-20 min, and Coolify logs showed Alpaca
`fetch failed` + `UND_ERR_SOCKET` / "other side closed" then auto-halt.

Branch `grok/prod-error-triage`, worktree `~/apps/trading-grok-prod-triage`,
issue #2714.  Retry dead sockets (fetch + Alpaca SDK); require 3 consecutive
transient connectivity failures before auto-halt; treat budget aborts as soft
health; bound `/api/health` credits check to 1.5s; dedup Pinecone WU Sentry;
don't page stale-quote warnings after the regular session.

Not in this branch (owner/ops): filingapi 401 (do not mint a key); Litestream
L2/L3 empty wedge (visible via #2709); congress.trade latency probes.

Rollout: `docs/rollouts/2026-08-14-stale-quotes-origin-timeouts.md`.

## Current (2026-08-14 GROK — Monet loading-graphic / Lato leftover closed)

Owner pickup of Monet's "iOS loading graphic and font..." session.  Product code
was already on `main` (#2667 `73dab29d`).  The dropped session's last step — a
computed-font check on live `socratictrade.com` — is now done: production login
at 375×812 computes `lato` on `body` and the Google sign-in button, eight `woff2`
files serve `font/woff2`, and `--font-sans` resolves through `--font-lato`.

Native splash / unflipped wordmark / iOS Lato are already on TestFlight
`1.0.13 (202608140722)` (`VALID`, `IN_BETA_TESTING`).  Last ship SHA `f9c89b9a`
contains #2667.  #2692 later added iOS quote-sheet work (different lane); the
splash / wordmark / Lato the owner asked for are already in 1.0.13, so no new
ship was cut for this pickup.  Production 503 Monet saw was the known SEC ingest stall, not this change;
site was 200 when this pickup started.

Rollout: `docs/rollouts/2026-08-14-pickup-monet-loading-fonts.md`.
Next action: owner updates TestFlight on the phone.  No code blockers.
## Current (2026-08-14 GROK — Monet App / Issue Audit owner decisions)

Four Monet leftovers.  Implementable one done; the rest stay owner-only.

1. TestFlight invite — OWNER ONLY.  Not uniformly INVITED: John (`jo…comcast.net`) is INSTALLED on all four apps; Jay (`ma…jays.services`) is INSTALLED on Congress.Trade.  Other testers still INVITED.  Did not accept.
2. Litestream Coolify rolling + B2 write keys — OWNER ONLY.  Did not flip deploy strategy or mint B2 keys.
3. Congress.Trade trial — already 2 weeks in user-facing copy (#1835).  Offer verified 14 days (Infisical `STRIPE_TRIAL_DAYS`, ASC intro `TWO_WEEKS`).  Stale runbook fixed on `grok/ct-trial-copy`.
4. ASC listings — EULA only on Socratic Trade; betaAppReviewDetails names/notes empty on CT + both Usage apps.  Documented; did not write ASC.

Monet merge table all MERGED: #2680 #2681 #2682 #2684 #2685 #2687 #2709 #2712.

Branch `grok/audit-owner-decisions`, worktree `~/apps/trading-grok-audit-decisions`.
Rollout: `docs/rollouts/2026-08-14-monet-audit-owner-decisions.md`.

## Current (2026-08-13 GROK — quote Key Stats dashes + tappable fill/position cards)

Owner screenshot: GOOG iOS sheet showed $343.94 / +0.5% / volume / Alphabet, but P/E, EPS, yield, beta, 52W High/Low were all "—".  Footer proved the live chart fetch worked.

Root cause (not a cosmetic dash):
1. `fetchYahooFinanceQuote` already received `fiftyTwoWeekHigh=404.47` / `fiftyTwoWeekLow=197.46` on chart meta and **dropped them**.  `fastQuoteEnrichment` never mapped them.
2. PE/EPS/div/beta are not on the keyless chart.  They come from crumb-authed Yahoo quoteSummary inside the full cascade.  Wave A Yahoo can finish in 1–3s; the cascade then waits for paid/scarce providers; the 6s budget times out and discards the already-fetched fields.
3. `/api/quote` never read or wrote `symbol_field_latest`, so previously saved fundamentals stayed invisible and a successful open never updated the store.
4. v7 `/finance/quote` is HTTP 401 without a crumb — not a keyless floor.

Fix: map 52w on the chart floor; dedicated `enrichYahooFinanceSymbol` layer; durable seed + persist; entire iOS fill/position cards (and PWA position cards) open the same sheet.  n/a vs — convention kept.

Branch `grok/quote-stats-and-card-taps`.  Rollout: `docs/rollouts/2026-08-13-quote-stats-and-card-taps.md`.
## Current (2026-08-14 MONET — AGENTS.md records the "local gate does not compile Swift" trap)

Docs-only, branch `monet/agents-swift-gate-trap`.  The four-command verify gate
(`npm run lint` / `npx tsc --noEmit` / `npm test` / `npm run build`) and
`scripts/land.sh` compile **zero Swift**, so a fully green local run proves nothing
about `ios/**` — the first Swift compilation of any iOS change happens in CI.

This is recorded because it cost a real CI cycle on 2026-08-13.  Merging `main` into
`monet/apns-push` produced a duplicate `@Binding private var pendingDeepLink` and a
second `init(pendingDeepLink:)` in `MobileControlView.swift`, and **git did not flag a
conflict**: both sides had added the same declaration at slightly different offsets, so
the text merge kept both copies and reported success.  6,563 vitest tests and a clean
`next build` passed while the iOS app did not compile at all.  The compiler's third
error, `ambiguous use of 'Preview'`, named an innocent file — the `#Preview` block was
fine and singular, and only became ambiguous because there were suddenly two
initializers to choose between.

"Verify before claiming done" now carries a CAUTION block with the exact `xcodebuild
build` and `xcodebuild test` invocations to run whenever a change **or a merge** touches
`ios/**`.  A merge is the highest-risk case precisely because you did not write the code
and have no reason to suspect it.

## Current (2026-08-14 MONET — empty compaction level reads as a wedge)

Deep compaction has produced nothing since ~2026-08-08 and the per-tier backup
monitor called it healthy.  The terminal stage of a compaction wedge is not a
frozen level, it is an EMPTY one: litestream retention keeps pruning the wedged
level's pre-wedge objects while the wedge produces no replacements, so level 2
went 171 objects (2026-08-12, frozen) to 0 objects (2026-08-14, empty) — and
`fileCount <= 0` was classified `not-observable` / `no-activity-recorded` with
the detail "This is normal for a level Litestream has not needed to produce".
`/api/health` returned `litestreamDegradedReasons: []` for six days.

Production snapshot read 2026-08-14T03:46Z (`durable_state`, namespace
`litestream`): `status: "ok"`, `levelErrors: {}`, L1 fileCount 2032 / newest
03:46:05Z / txid `00000000000468d8`, **L2 fileCount 0**, **L3 fileCount 0**, L9
fileCount 2 / newest 00:00:06Z.  The listing SUCCEEDED — not a visibility
failure.

**PR #2709 MERGED** 2026-08-14T05:38Z as `a8f3ad86`; merge to `main`
auto-deploys to production.  Adds a third tier state `"empty"` carrying a verdict
(`wedged` / `upstream-wedged` / `expected`) and the feeder evidence behind it.
An empty level is graded against its IMMEDIATE feeder, and duration comes from
the feeder's file count via `CompactDB`'s one-file-per-interval-boundary
guarantee: `floor((K-1)/2) * interval`.  L2 today is
`floor(2031/2) x 30s = 8h27m` against a 2h threshold -> wedged; L3 ->
`upstream-wedged` with copy naming L2 as the fix.  Suppressed on a fresh
replica, an idle database, a superseded level, an all-empty prefix, and any
stale / failed / inconsistent listing.  New `checks.storage.litestreamTiersDegraded`
and `litestreamTierDegradedReasons`; `/api/health` `ok` deliberately does NOT
flip to 503.

Adversarial review round 2 found and fixed the one path that could silence the
new alarm: `supersededBy` scanned every higher level, including level 9.  Level 9
is a whole-DB snapshot (`CompactDB` shortcuts it to `db.Snapshot`), so its txid
tracks the live database rather than level 3 — and in the window right after each
daily snapshot that turned the L2 wedge into `expected/superseded degraded=false`
with a false "promoted rather than lost" sentence.  It now consults only levels
with a non-null `LITESTREAM_FEEDER_TIER`, pinned by a test on the production shape
plus a positive test proving `superseded` still fires where it is genuinely true.

**Blocker / next action is the OWNER's, not code:** the root cause is that every
Coolify rolling deploy briefly runs two litestream writers against the same B2
prefix; 0.5.12 has no fencing, colliding `MaxTXID` breaks `ltx.IsContiguous`, and
the level-1 -> level-2 promotion fails permanently.  Repair needs a deploy-strategy
change plus a one-time B2 delete.  This branch only makes it visible.

Rollout: `docs/rollouts/2026-08-14-empty-tier-wedge-detection.md`.

## Current (2026-08-13 GROK pickup — land leftover `monet/ship-pipeline-fix`)

Monet hit quota with this branch finished and **no PR**.  GROK landed it from
`~/apps/trading-monet-shipfix` without redesign.  Merged `origin/main` (`#2684`
honest server stats) cleanly.  READY PR **#2687**, squash auto-merge armed,
waiting required `verify`.  Local land.sh gates: tsc clean, 6600 passed /
51 skipped (567 files + 1 skipped), build clean.

Unchanged Monet scope: refuse bot merges without an elevated token + hourly
fail-closed CI backstop; cron path-gate so backend-only commits do not ship
TestFlight; strip `[AG]` anywhere in release notes; ios-fleet sha256 pin;
version snapshot.  Rollout:
`docs/rollouts/2026-08-13-ios-ship-pipeline-repair.md`.

## Current (2026-08-13 ~3:45pm CT MONET — iOS ship pipeline repair)

Bot-merged PRs land on `main` and dispatch NOTHING — not CI, not ios-ship.  ST is
not exempt: PR #2675 (merged by `github-actions[bot]`, sha `ca38bb2979`) has 27
runs on that sha and zero are `event: push`, while #2680 (human-merged) gets the
full set.  Cause is GitHub's `GITHUB_TOKEN` recursion guard; `auto-merge-prs.yml`
claimed to prefer `GH_PAT`/`SHEPHERD_TOKEN` but neither secret exists, so the
fallback chain always resolved to `GITHUB_TOKEN`.

Fixed on branch `monet/ship-pipeline-fix` (worktree `~/apps/trading-monet-shipfix`):
auto-merge workflows + `merge-shepherd.sh` refuse to merge without an elevated
token (self-activating the moment the owner adds one); `ci.yml` gains an hourly
backstop cron with a fail-closed redundancy skip; `ios-ship.yml` drops the
undocumented 1h rate override (fleet standing gate is 2.5h — ASC upload gaps went
2.80h/2.58h before it, 1.60h/1.34h after) and gains `fetch-depth: 0`; a sha256 pin
(`scripts/ios-fleet.sha256` + `ios-fleet-pin.sh`) guards the untracked shared
tooling; `ios/project.yml` + pbxproj now record the actually-shipped 1.0.6 instead
of a stale 1.0.1.

Shared, UNVERSIONED tooling edits (live for all four fleet apps immediately;
backup at `/Users/jay/apps/ios-fleet/.backup-monet-20260813/`): `ensure-tf-ready`
now targets the build THIS run uploaded instead of "newest" (which is the previous
ship for the first minutes after upload), and renders the mandatory TestFlight
"What to Test" note.  Notes publishing is OPT-IN and defaults to a dry render —
owner sign-off needed before any tester sees auto-generated copy.

**Review round 2 (blockers fixed before landing).**  (1) The `*/30` cron had no
path gate and was already shipping backend-only commits — run `31723515355`
archived and shipped `39c6acee` (an alerts fix, zero files under `ios/`) to
testers.  `scripts/ios-scheduled-ship-gate.sh` + a 13-assertion offline test now
gate the scheduled path, and the test runs in CI on every PR.  (2) The
release-notes agent-name filter was start-anchored while the fleet writes tags at
the END — CT has 48 subjects with a non-leading `[AG]` and zero leading ones, so
`[AG]` would have published to TestFlight.  Markers are now stripped anywhere and
the deny-list gained a bracketed-`AG` backstop; verified zero leaks across 1500
subjects per repo.  (3) Version snapshot re-read at review time: 1.0.8 /
202608132022 (the train moved past 1.0.6 before the first commit was authored).

Gates (node 24): lint 0 errors / 764 warnings (grandfathered), `tsc --noEmit`
clean, vitest 563 files passed + 1 skipped and 6520 tests passed + 51 skipped,
`npm run build` clean, ios ship-gate bash suite 13/13.  Rollout:
`docs/rollouts/2026-08-13-ios-ship-pipeline-repair.md`.
## Current (2026-08-13 ~3:50pm CT MONET — durable litestream remote-inventory cache)

PR #2665's per-tier backup monitor (`docs/rollouts/2026-08-12-backup-tier-monitor-real-coverage.md`)
never actually reported in production: `checks.storage.litestreamTierCoverage` stayed
`remoteInventoryState: "missing"` forever, forcing all 4 remote-only tiers permanently
`not-observable`. Root cause (re-confirmed via read-only `task_journal` evidence before
touching code): the collector scheduler lane genuinely worked (932 runs/24h, 0 errors), but
`getLitestreamRemoteInventory()`'s snapshot lived in a bare module-level variable, and Next's
build gives the scheduler and the API routes SEPARATE instantiations of
`src/lib/litestream-remote-inventory.ts` — the writer's assignment and the reader's lookup were
never the same variable. Fix: persist the snapshot through the existing
`src/lib/db-durable-state.ts` `durable_state` primitive (no migration needed). `lastAttemptAtMs`
(the 30-min collection gate) deliberately stays in-memory — reasoning + evidence in the rollout
note and in a code comment at the call site. Two new tests use `vi.resetModules()` + fresh
`await import(...)` to force genuinely separate module instances and prove the fix; both
confirmed to fail against the pre-fix source. Full local gate green: tsc clean, 566/567 test
files (6569/6620 tests, pre-existing skips), build succeeds, lint 0 errors. Worktree
`/Users/jay/apps/trading-monet-inventory`, branch `monet/durable-inventory-cache`. Rollout:
`docs/rollouts/2026-08-13-durable-inventory-cache.md`.
## Current (2026-08-13 GROK — pickup Monet+Claude quota-cap)

Owner-directed: Monet and Claude hit the session limit (resets 7pm CT).  Inventory +
team of agents on leftover work.  Already merged today (not re-done): #2684 honest
stats, #2682 real toggles, #2681 APNs, #2680 FTS yield, #2667 load/Lato, #2662 order
cancel, #2666 r3.  In flight: unstick #2685+#2683 (phantom), land
`monet/ship-pipeline-fix`, land Claude r4 leftover, quote Key-Stats dashes + tappable
fill/position cards, CT/UM CF-account leftover.  Rollout:
`docs/rollouts/2026-08-13-pickup-monet-claude-cap.md`.

## Current (2026-08-13 MONET — litestream compaction visibility: make a silent backup failure loud)

Step 3 of a diagnosed fix (Steps 1/2 — disabling Coolify rolling replacement, a one-time B2
delete of poison L1 objects — are the owner's, not implemented here). Background: level-2 deep
compaction has been frozen in production since 2026-08-08T14:35Z (two concurrent `litestream
replicate` processes per Coolify rolling deploy emit L1 objects with identical MaxTXID,
permanently failing `ltx.IsContiguous`) and ran silently for five days — `/api/health` stayed
`ok: true`, `litestreamDegradedReasons: []`, the whole time.  Branch
`monet/compaction-visibility`, worktree `~/apps/trading-monet-compaction`.

Three additive signals, one correction: (1) `litestream.coolify.yml` gains `validation: interval:
1h` — **at the TOP LEVEL, not nested under `dbs:`** as the originating task brief said; verified
against the pinned v0.5.12 Go source that `Validation` is a field on the top-level `Config`
struct, not `DBConfig` — nesting it would have silently done nothing.  Deliberately did NOT add
`verify-compaction: true` (would re-list the ~90k-object L1 backlog after every compaction — the
same request/socket-churn class that wedged deploys via tcp_mem exhaustion on 2026-07-10).  (2) A
third, independent detection signal that needs no S3/B2 credentials and does not depend on the
remote-inventory pipeline (which has a separate known bug in flight on `monet/durable-inventory-cache`
— not touched here): litestream owns the container's real stdout via `-exec`, so
`scripts/coolify-prod-start.sh`'s single `run_app litestream replicate ...` line now tees its
combined output to `$DATA_DIR/litestream-runtime.log` (`> >(tee -a ...) 2>&1` — process
substitution, not a `| tee` pipe, so `$!`/SIGTERM-forwarding/exit-code propagation are unchanged;
verified via a full local dry-run with fake litestream/next binaries before landing).
`src/lib/runtime-health.ts` gains `scanLitestreamRuntimeLogFile` (bounded 256 KiB tail read,
never throws) scanning for litestream's own `compaction failed`/`validation error detected`
lines; wired into `/api/health` as `checks.storage.litestreamCompactionLogFailureCount` (count
only — raw lines never hit the public body) and `alertStorageWarning`.  (3) No new
`NotificationEventType`/migration: reuses `alertStorageWarning`'s existing free-text
`warningType` exactly like the 7 other storage alerts already do, so this is unaffected by
whichever order it lands relative to `monet/real-toggles` (#2682, open at time of writing,
removing that function's force-include pattern).  Currently INERT in production — the
`.litestream-disabled` kill-switch marker (dropped today for an unrelated OOM incident) short-
circuits before the new tee line.

Zero-code finding: searched `docs/rollouts/*.md` + `STATUS.md` for claims the L2 wedge was
"cleared"/"fixed" by the two earlier `rm -rf .app.db-litestream/ltx` resets — found none; every
existing entry already correctly says the resets never touched B2 (confirmed against litestream's
`DB.ResetLocalState` source: local-only, no B2 call).  No doc corrections were needed.

14 new tests (11 unit in `test/runtime-health.test.ts`, 3 integration in
`test/connection-health-routing.test.ts`), verified to fail without the implementation (`git
stash` the 4 non-test files, re-run, 14 failed/50 passed, `git stash pop`).  Gates (all green):
tsc clean; lint 764 problems/0 errors (grandfathered backlog, no new warnings on touched lines);
full `npm test` 566 files/6581 tests passed, 51 skipped; `npm run build` exit 0, 40/40 static
pages.  Rollout: `docs/rollouts/2026-08-13-litestream-compaction-visibility.md`.
## Current (2026-08-13 ~3:20pm CT MONET - HONEST SERVER STATS: fabricated CI runners deleted)

`/admin/server` was showing six GitHub Actions runners that do not exist -- `socratic-ci`,
`socratic-ci-2`, `congress-ci`, `shared-ci`, `usage-ci` (all tagged `ci-cpx32`, a box deleted
2026-07-31) and `github-runner` -- every one pinned to `running:healthy`.  They were hardcoded
string literals at two sites in `app/api/admin/server-metrics/route.ts`, returned on five
paths including a successful-but-empty live list.  No GitHub token exists in ST prod, so
production served them on 100% of requests.  Real truth: ST has ONE runner,
`mac-xcode26-socratic`.

Replaced with a discriminated result (`state: known | unavailable` + machine `reason` + human
`detail`), modelled on `assessLitestreamTierFreshness`.  Also fixed: `"unhealthy".includes("healthy")`
painting every unhealthy container green, the status label truncating the health half off, the
hardcoded "litestream is replicating to R2" claim in the Security card, and four host cards
that were blank with no stated reason.  `AGENTS.md` note blaming "stale Coolify-side
registration" corrected -- it was our own code.

Adversarial review then caught the same class of bug reintroduced one card over: the Services
card rendered an empty `resources` array as "coolify reported no services for this server" even
when Coolify was never configured or the read failed -- and the failed-read case renders on an
otherwise fresh-looking page, because the Hetzner reads succeeding keeps the stale-cache
branches from firing.  Fixed with a matching `resourcesObservation: known | unavailable+reason`
and a three-state Services panel.  Two smaller honesty fixes rode along: the Security card no
longer claims live provider reads on the local path, and the CPU meter now states that its
per-core scaling is unverified.

Owner action: supply `GH_TOKEN` to ST prod Infisical if the runners card should show live data
(agents must not mint one).  Branch `monet/honest-server-stats`.  Rollout:
`docs/rollouts/2026-08-13-honest-server-stats.md`.  UM/CT follow-ups recorded in that note.

## Current (2026-08-13 MONET — real toggles: banned force-include notification pattern removed)

Owner ruling 2026-08-12: "ALL toggles must be real" — no force-included notification events,
ever. Ten call sites across eight files (`lookahead-audit.ts`, `signal-health.ts`,
`db-health.ts` x3, `scheduler.ts`, `earningscalls-transcripts.ts`, `usage-limit-alerts.ts`,
`broker-health.ts`, `strategy.ts` x3) injected a specific event type into that send's effective
`enabledEvents` regardless of the user's stored setting, silently overriding an OFF toggle
forever. All removed; every site now passes the real `policy` through unmodified.

Replaced with a one-time versioned migration (`src/lib/db.ts`, version 78,
`notification_enabled_events_backfill`): backfills the eight previously-force-included event
types into any LEGACY stored `enabledEvents` array that predates them (only touches rows with an
explicit array already present; a row with no `notificationSettings` key at all already defaults
to every current type via `mergePolicy`). After the backfill the Settings toggle is genuinely the
user's — on by default, off if/when they turn it off, and it STAYS off. (Originally landed as
version 77; `monet/apns-push` (#2681) merged first and claimed 77 for `device_push_tokens` —
renumbered to 78 and rebased, see the rollout note's "collision with #2681" section.)

Rewrote one existing test (`test/guard-enablement.test.ts`) that explicitly pinned the OLD
force-include behavior as a "regression" test; added new regression coverage proving
`signal_health` and `lookahead_leak` are NOT delivered when switched off
(`test/signal-health.test.ts`, `test/lookahead-audit.test.ts`), plus a dedicated migration test
(`test/db-migration-notification-backfill.test.ts`). Bumped 12 hardcoded schema-version
assertions in `test/persistence-hardening.test.ts` from 76 to 78 (77 is now `device_push_tokens`
from #2681).

Branch `monet/real-toggles`, worktree `~/apps/trading-monet-toggles`. Gates (foreground, waited
on): tsc clean; `npm test` 6573 passed / 51 skipped (568 files); lint 0 errors; build clean. PR
https://github.com/jaywedgeworth22/Socratic.Trade/pull/2682, opened ready, auto-merge armed
(squash) — merges on green `verify`. Rollout:
`docs/rollouts/2026-08-13-remove-force-include-notifications.md`.
## Current (2026-08-13 ~2:20pm CT CLAUDE — HOTFIX: adaptive FTS-mirror batching)

The ingestion re-enable reproduced the 08-10 event-loop stall (ftsMirrorBatch 119s pinned
stretch on a 702-chunk 10-K; site flapped 503 for hours).  Relief: worker off + restart (site
healthy 19:13Z).  Cure in this PR: adaptive group sizing against a 250ms synchronous-stretch
budget (pure policy fn + tests).  Worker re-enables after deploy.  Blockers: ct-deploy-guard
has been eating ST webhook deploys — verify the deploy lands, retrigger via API if not.

## Current (2026-08-13 GROK — Fleet Pushover/Sentry/Uptime triage)

Owner screenshot 8:06–8:44am CT plus 7d Uptime/Sentry.  Four distinct app bugs, not one outage.

1. Robinhood MCP option/historicals calls sent extra `symbol`/`symbols` (and legacy `span`) against `additionalProperties:false` schemas — GH #2576 / SOCRATIC-TRADE-K.
2. Pinecone upserts 2 bytes over the 40960 metadata cap (SOCRATIC-TRADE-1T).
3. OpenRouter embed 429 "engine overloaded" paged as both connection-failed and usage-limit (SOCRATIC-TRADE-1X).
4. CT senate scout 503 is a Mac-scout handshake false positive; server `pollSenate` via senate-relay is live.

ST 503s pair with the keyword "OpenRouter credits low" monitor because that monitor hit the same `/api/health` URL and treated 5xx as down.  Allowed 4xx/5xx on that keyword monitor so only the credits substring pages.

Branch `grok/fleet-alerts-aug13`.  Rollout: `docs/rollouts/2026-08-13-fleet-alert-triage.md`.

## Current (2026-08-14 GROK — ban grepping secrets files for KEY=value lines)

Owner: change agent rules so nobody dumps `~/.secrets/global-api-keys` into a
transcript.  Rotation is already done; do not re-litigate it.

Added the handoff-file grep trap to AGENT-SYNC, TEMPLATE-AGENTS, this
`AGENTS.md`, and the secret-safety skill.  Names only: `grep -oE`.
Branch `grok/secret-file-grep-ban`.

Rollout: `docs/rollouts/2026-08-14-secret-file-grep-ban.md`.

## Current (2026-08-13 GROK — Settings Saving… + ROIC Individual actually binds)

Owner: ROIC paid first tier (Individual) was set in Settings; dropdown snapped
back to Free for 20–30s with no busy state.  The save did land.  They want the
desk to show when a write is in flight, not look idle.

Optimistic plan-tier + Data Sources values; card Saving…/Saved; global Saving…
chip in the top bar for any console mutation.  Plan-tier lookup now reads the
logged-in user, not only `local`, so Individual is 300/min and 20 transcript
quarters.  Branch `grok/settings-busy-feedback`.

Rollout: `docs/rollouts/2026-08-13-settings-busy-feedback.md`.
## Current (2026-08-13 ANTIGRAVITY — Framework & Dashboard Loading Performance Optimizations)

**Branch `ag/framework-dashboard-perf` (Framework & Dashboard Loading Optimizations):**
1. **Framework Loading**: Removed artificial `150ms` delay in `FrameworkViewer` (`app/framework/framework-viewer.tsx`) and added in-memory session caching so return visits within the same session render instantly.
2. **Dashboard Assembly**: Raced independent macro data dependencies (`fetchMacroData`, `getMarketSignals`, `fetchMacroHistory`, `fetchMassiveNews`) in parallel via `Promise.all` alongside the broker chain in `src/lib/dashboard.ts`.
3. **Verification**: `npm run lint` clean (0 errors), `npx tsc --noEmit` clean, `npm test` 87/87 test files (673 passed), `npm run build` clean.
Rollout: `docs/rollouts/2026-08-13-framework-and-dashboard-perf.md`.

## Current (2026-08-13 ANTIGRAVITY — Dashboard Parallelization and Litestream Generic Disable)

## Current (2026-08-12 ~11:30pm CT GROK — SEC TTL was a 10-year pause; paid RAG knobs on)

Owner: is `SEC_FILING_INGEST_TTL_HOURS` too long, and run the clean-text reindex so every
advanced feature current tiers can run is on.

**Yes, it was too long — live Infisical was still `87600` (the 2026-08-10 emergency pause).**
Catalog default 168h was the old Voyage-free weekly pin.  Paid OpenRouter/bge-m3 wants 24h.
Claude had flipped the worker + max-per-run back on 2026-08-12 but left the 10-year TTL, so
`isFilingIngestDue` (one global last-attempt stamp) kept ingest dark.

Infisical prod now: TTL `24`, `VECTOR_EMBED_CLEAN_TEXT=on`, `RAG_MULTIQUERY=on`, `RAG_HYDE=on`,
`RAG_EMBED_DISCLOSURES=on`.  Worker already on; max-per-run stays 25.  Left off: FMP transcript
rights, full 8-K body, `VECTOR_ASOF_STRICT`.

Code (branch `grok/rag-advanced-enable`, worktree `~/apps/trading-grok-rag-enable`): catalog
default 24h; Settings user overrides now actually drive clean-text / multi-query / HyDE.
Reindex `POST /api/admin/reembed` after the queued main deploy picks up Infisical.  Do not
purge rev-1 until that run completes with zero failures.

Rollout: `docs/rollouts/2026-08-12-rag-advanced-enable.md`.
## Current (2026-08-13 ANTIGRAVITY — Dashboard Parallelization and Litestream Generic Disable)

**Branch `ag/rebase-2646` (Dashboard Refactor & Litestream Kill Switch):**
1. **Litestream Crash Loop Fix**: Added a generic `LITESTREAM_DISABLE_MARKER` to `scripts/coolify-prod-start.sh` to allow manual disabling of Litestream during memory leak incidents. 
2. **Dashboard Performance**: Refactored `getDashboardSnapshot` in `src/lib/dashboard.ts` to parallelize `getAccounts` and `getPortfolio` fetches when the account number is known, significantly reducing dashboard load times.
3. **Verification**: `npx tsc --noEmit` clean, `npm run lint` clean, `npm test` clean, `npm run build` clean.
4. **Ops**: The `.litestream-disabled` marker was dropped on the prod server's data volume to disable the crash-loop immediately on the next start. B2 generation wiping is pending owner coordination.
Rollout: `docs/rollouts/2026-08-13-dashboard-parallelization-and-litestream-disable.md`.

## Current (2026-08-12 ~9:20pm CT MONET - console false load-failure, phone-correct load graphic, iOS candlestick splash, Lato everywhere)

Owner-reported four-parter, all landed on `monet/loading-fonts`.  The headline is a real bug: the
console showed "Couldn't load the autonomy desk" on essentially every load while the iOS app on the
same account loaded fine.  Both clients call the SAME `getDashboardSnapshot`, so this was never a
server split - the console's 15s first-load watchdog SET `error`, and the shell rendered its
full-screen failure card on `error` alone, so any first load in the routine 15-24s band (the
server's own sequential broker-chain worst case) showed a failure screen while the request was
still in flight and about to succeed.  iOS has no such timer and simply waited.  Fixed via a new
pure `console-load-state.ts` ("an error while a fetch is still in flight is not a failure") with the
15s timer demoted to a reassurance line under the load screen; 7 regression tests - the rule was
untestable inside the React hook (node-only vitest, no jsdom), which is why it shipped.  Server-side
slowness itself is UNTOUCHED and remains the real follow-up: parallelising the sequential
accounts -> portfolio/positions/orders -> quotes chain.

Also: the intro canvas now measures the fixed overlay instead of `window.innerHeight` (they
disagree by 60-90px on iOS Safari, which pushed the chart down and clipped its low wicks on every
iPhone), DPR 3 on phones, iOS URL-bar resize absorption, safe-area-aware landing box.  iOS
`LaunchStateView` (icon + spinner + "Socratic.Trade") is now the candlestick SOCRATIC TRADE wordmark
at the top that slides away, sized by the web `MobileBrandRow` formula, plus a `LaunchBackground`
colorset that kills the white cold-launch flash.  Found and fixed a shipped bug along the way:
`CandleWordmarkView` rendered the wordmark VERTICALLY MIRRORED (S as 2, R as K, A as Y) from a
double row-flip in `alphaAt` - visible on the login screen in the current build.  Lato is now
self-hosted (deliberately NOT `next/font/google`: a build-time fetch would freeze auto-deploy) as
the site-wide default plus a named picker option, and bundled on iOS with Dynamic-Type-preserving
`.app*` twins across all 120 call sites.  Worth knowing: `--font-sans` named "Inter" but never
loaded it anywhere - no @font-face, no next/font, nothing in public/ - so the site had been
rendering in the device system font all along; Lato is the first real webfont it has ever resolved.

Gates: tsc clean, lint 0 errors, 6449 tests green, build clean, xcodebuild 40 iOS tests green.
Verified live, not just green: iOS simulator screenshots of the real launch sequence (that is how
the mirrored wordmark was caught), the built .app bundle inspected for font placement, and the
console load screen at 375x812 with Lato confirmed resolving at runtime.
Rollout: `docs/rollouts/2026-08-12-load-screens-and-lato.md`.  Blockers: none.

## Current (2026-08-12 ~7:45pm CT CLAUDE — round 3 landed: scorecard, lookahead audit, PIT chain, Polymarket)

Four backlog features land in this PR (details in the four r3 rollout notes): the unified
ProposalScorecard (deterministic receipts: MA alignment, sniper points, gate checklist, signal
attribution summing to 100, decision chain with a persistence-time validator), the
truncated-replay lookahead audit (weekly lane; momentum/liquidity + RAG evidence replayed with
history cut at decision time; honest unverifiable labels; 90-day windowed verdict), the PIT
fundamentals revision chain (restatements never rewrite history; as-of reads with a strict
knob), and keyless Polymarket prediction-market context in the strategist prompt.  All slices
adversarially verified; 13 integration fixes applied; full suite 6423 green + build clean before
push.  This deploy also activates the owner-directed ingestion re-enable (SEC worker on, filing
cap 25) — first sync stretch is being watched for the 2026-08-10 event-loop-pinning recurrence.
Blockers: none.

## Current (2026-08-12 ~3:05pm CT CLAUDE — r3: keyless Polymarket prediction-market context)

Round 3 slice (implementable subset of the social-sentiment lesson: real-money crowd odds as LLM
context; Reddit/X stay OUT of scope, blocked on owner API keys).  New `src/lib/polymarket-provider.ts`
— keyless (no credential ever created/held), hits `gamma-api.polymarket.com/public-search`
(live-verified shape in the file header), matches markets to a symbol via the existing
`scoreHeadlineRelevance` rubric (`news-relevance.ts`, incl. the ambiguous-company-name
corroboration gate), keeps up to 3 currently-active company-relevant markets per symbol
(question/implied probability/volume), 10-minute in-process cache, bounded per-run symbol count,
fails open to no-data on any error.  Wired into `strategy.ts`'s `proposeTrades` at the same seam
`prompt-headlines.ts` and `getUpcomingEconomicEventsForPrompt` use — prompt-time only (candidates
entering the LLM call), never the scan-wide enrichment cascade, so it never fires on a
budget/threshold-skipped run.  New `MarketQuote.polymarketLines`; new catalog knobs
`POLYMARKET_CONTEXT` (default true) / `POLYMARKET_MIN_RELEVANCE` (default 0.5).  Dependency-health
and evidence-pack-family both investigated and found to need ZERO new registration (health map is
derived dynamically from logged calls; the new prompt field nests inside the existing "market"
family evidence ref) — see the rollout note.  Gates: tsc clean; 18 new tests
(`test/polymarket-provider.test.ts`) + 29 adjacent-seam tests green; lint 0 errors on touched
files.  Rollout: docs/rollouts/2026-08-12-r3-polymarket-context.md.  Local slice commit on
`agent/claude`; lands via the round-3 integration lane.  Blockers: none.

## Current (2026-08-12 ~2:10pm CT CLAUDE — r3: truncated-replay lookahead audit)

Round 3 slice (freqtrade lookahead-analysis port, scoped per the gap analysis to the two
genuinely reconstructable subsystems).  New `src/lib/lookahead-audit.ts` (pure/IO split mirroring
backtest.ts) + `db-lookahead-audit.ts` (migration 75, `lookahead_audit_findings`, deletion-covered):
a weekly durable per-user due-job samples matured `signal_snapshot` decisions past a watermark,
recomputes the momentum/liquidity factor sub-scores from daily OHLC truncated to each decision
date (through the existing pure `scoreFactors`, mirroring decision-time field availability via
per-field `sources` provenance), and replays RAG evidence by rebuilding the deterministic filings
query (now shared via `deterministicFilingsRetrievalQuery`; queryHash-guarded so builder drift
degrades to honest 'unverifiable') with asOf pinned + strictAsOf, diffing chunk ids against the
persisted candidate-pool `used:true` rows — Jaccard threshold for benign reranker drift, ANY
post-asOf chunk a hard mismatch.  value/quality/volatility/sentiment/positioning/diversification
are ALWAYS 'unverifiable' with stored backtestSafety receipts (the coverage gap is visible, never
silently implied clean); below 20 qualifying observations the aggregate verdict is an honest
'insufficient_sample'.  Advisory `lookahead_leak` notification fires on mismatch classifications
only; compact con-* receipts panel on Results.  `LOOKAHEAD_AUDIT_*` knobs (default ON, documented
kill switch in .env.example).  Gates: tsc clean; test/lookahead-audit.test.ts 17/17;
persistence-hardening + account-deletion-coverage updated for v75 (25/25); adjacent suites 99/99.
Rollout: docs/rollouts/2026-08-12-r3-lookahead-audit.md.  Local slice commit on `agent/claude`;
lands via the round-3 integration lane.  Blockers: none.

## Current (2026-08-12 ~1:15pm CT CLAUDE — r3: unified ProposalScorecard)

Round 3 slice (dsa Dashboard-contract lesson): one typed, deterministic `ProposalScorecard`
unifying the decision receipts already on `TradeProposal` — core conclusion (derived from the
existing rationale, no new LLM call), MA/volume data perspective (recycled from the ATR
precompute's bars, honestly omitted when absent), sniper price levels (referencePrice + bracket
legs; secondary entry ONLY via the new `secondaryBuyPullbackPct` owner knob), an action checklist
that RENDERS already-computed gate state (entry-drift, wash-sale, daily-cap, red-team,
dataAdjustments — never a new authority), four-bucket signal attribution summing to exactly 100,
and an append-only decision chain stamped at the existing override/human-approval sites with a
persistence-time validator that receipts (never drops) malformed chains.  Outcome engine now
grades sniper stop/take levels against the daily closes it already fetches
(`outcome.sniperAccuracy`, close-basis disclosed).  Rendered collapsible on the approval card and
read-only in the decision trace.  Gates: tsc clean; targeted suites 182/182 (23 new).  Rollout:
docs/rollouts/2026-08-12-r3-proposal-scorecard.md.  Local slice commit on `agent/claude`; lands
via the round-3 integration lane.  Blockers: none.
## Current (2026-08-12 GROK — broker cascade + Webull/eToro/Public + CopyTrader intel)

**Branch `grok/broker-webull-etoro-public`:** connected brokers (Tradier / Alpaca / Robinhood)
now sit in front of paid history providers; Public + eToro gateways + Webull connect stub;
CopyTrader observe/allowlist framework (official eToro API only).  Owner must mint keys.
Rollout: `docs/rollouts/2026-08-12-broker-cascade-and-copy-intel.md`.
## Current (2026-08-12 MONET - APNs native push, MERGED end to end + contract reconciled)

**2026-08-13 update - merged `origin/main` `39c6acee` into the branch.**  Five conflicts, all
resolved deliberately: `device_push_tokens` moved from migration **75 to 77** (main landed 75
`lookahead_audit_findings` + 76 `fundamental_revisions`; two `CREATE TABLE`s under one version
number would be unreachable for any DB that already ran the other), 12 schema-version assertions
in `test/persistence-hardening.test.ts` retargeted, `project.pbxproj` **regenerated with xcodegen**
from the merged `project.yml` (verified it still substitutes `$(MARKETING_VERSION)` /
`$(CURRENT_PROJECT_VERSION)`), and `MobileControlView.apply(_:)` **taken from main in full**.  That
last one was a real bug, not formatting: this branch's older `apply()` predates deep-link proposal
focus and silently discarded `destination.proposalId`, so every `pending_approval` push - which
`pushDeepLink()` emits as `/console/approvals?proposal=<id>` and the parser correctly turns into
`.proposal(id:)` - would have opened the Proposals list with nothing highlighted.  It would have
compiled and passed every test.  Also corrected: the rollout note's claim that no AASA file exists
is stale - #2662 landed `app/.well-known/apple-app-site-association/route.ts` and its
`middleware.ts` `PUBLIC_PREFIXES` entry, so universal links and push taps now share one parser.
`.gitignore` gained `*.p8` (an APNs auth key is team-wide; a loose `.p8` in the repo root was
untracked but not ignored).

Branch `monet/apns-push` (worktree `~/apps/trading-monet-apns`), forked from `origin/main`
`5784c1cf`.  Merges the two parallel halves - `monet/apns-server` (`c4bd3acb`) and
`monet/apns-ios` (`f697bd32`) - with **zero conflicts** (disjoint by construction; even
`project.pbxproj` merged clean, so no xcodegen regen or objectVersion re-patch was needed) and
makes the contract between them real.

- **Server half:** push is a NEW DELIVERY CHANNEL in the EXISTING notification system - one more
  `NotifyChannelId` in `src/lib/notify.ts`'s `CHANNELS`, same `sendNotification` -> `notify` path,
  same `enabledEvents` gate.  Migration 75 `device_push_tokens` (token is PRIMARY KEY, registration
  REASSIGNS on conflict so a shared phone switching accounts cannot leak the previous user's
  alerts; `environment` stored, never inferred).  `src/lib/apns.ts` uses `node:http2` (fetch cannot
  speak HTTP/2 to APNs), caches the ES256 provider JWT at 50 min, retires tokens on 410 / 400
  BadDeviceToken, surfaces 403 loudly.  `POST`/`DELETE /api/mobile/push/register`, session-authed.
- **iOS half:** `aps-environment: production` in BOTH `SocraticTrade.entitlements` and
  `project.yml`; the environment is read out of `embedded.mobileprovision` at runtime, never
  `#if DEBUG` (TestFlight IS production - guessing sandbox is a silent 400 forever).  Permission on
  first Proposals visit; taps route through the same `DeepLink` parser as `onOpenURL`; sign-out
  withdraws the token BEFORE cookies are cleared.
- **Contract fixes made in the merge** (the point of this phase): the catch-all deep link was
  `/console`, which the iOS router REJECTS (it needs `/console/<screen>`) - so 17 of the 24 event
  types tapped to nowhere, silently.  Now `/console/activity`, which routes and is where the
  notification is actually listed.  Also dropped `pushLinkOrigin`'s `NEXT_PUBLIC_APP_ORIGIN`
  fallback: the app pins the host to exactly `socratictrade.com`, so an unrelated env var could
  have turned every tap into a no-op.  The register body, environment literals, auth, payload key,
  and sign-out DELETE all lined up already and were left alone.
- **Pinned by a cross-language contract test:** one table row per `NotificationEventType` in
  `ios/SocraticTradeTests/PushNotificationTests.swift`; Swift asserts each URL routes to the stated
  tab, and `test/apns-deep-link-contract.test.ts` parses those rows and asserts `pushDeepLink()`
  emits exactly them - set-equal to `NOTIFICATION_EVENT_TYPES`, so a NEW event type fails the test
  until the app names it.  Mutation-checked (reverting the catch-all fails 2 of 11).

Verified (foreground): `xcodebuild ... test` -> `** TEST SUCCEEDED **`, **Executed 73 tests, 0
failures** (70 before); `npx tsc --noEmit` exit 0; **full** `npx vitest run` -> 554 files passed /
1 skipped, **6419 tests passed** / 51 skipped; `npm run build` exit 0; `npm run lint` 0 errors.
End-to-end delivery is STILL unverified - it needs a TestFlight build on a real device plus the
deployed server.  Post-deploy: confirm all four `APNS_*` values exist in ST prod Infisical, or
Settings -> Delivery shows "iPhone push - not configured" and sends nothing (by design).
Rollout: `docs/rollouts/2026-08-12-apns-push.md` (replaces the two per-branch notes).
## Current (2026-08-12 MONET - backup tier monitor: real coverage, previous version had none)

Branch `monet/backup-tier-monitor-real` (worktree `~/apps/trading-monet-tierfix`).

`assessLitestreamTierFreshness()` shipped 2026-08-11/12 claiming per-compaction-level backup
freshness for levels 0/1/2/3/9.  Verified on the live container today: it reported
`state: "unknown"` for ALL FIVE tiers on every health check - zero coverage, while presenting
itself as a five-tier breakdown.  Two independent causes:

1. It read local `<statePath>/ltx/<level>/`, but litestream 0.5.12 keeps ONLY level 0 on disk
   (`/app/data/.app.db-litestream/ltx/` has exactly one entry, `0`).  Levels 1/2/3/9 exist only
   in the B2 replica and could never be observed that way.
2. `ltx/0` holds 1,078 files; the shared scan returned `null` past a 256-entry bound, so even
   level 0 - the one readable level - degraded to "unknown".

The level-2 wedge it was built for was running the whole time (`compaction failed ...
non-contiguous transaction ids`; levels 1/2/3 frozen since 2026-08-08/10 while level 0 advanced).

Fixed by grading each level from a source that is actually valid: level 0 from local LTX in real
time, levels 1/2/3/9 from a new scheduled 30-minute remote replica inventory
(`src/lib/litestream-remote-inventory.ts`; `litestream ltx -level N -json`, never inline - the
`-level all` form measures 143s/14.1MB).  Anything else now reports an explicit
`state: "not-observable"` with a reason instead of a bare "unknown".  Degradation requires a
level to be past threshold AND behind level 0's txid, so an idle database cannot false-alarm.

Gates: tsc clean, lint 0 errors, `npm test` 6383 passed / 51 skipped (551 files), build passes.
Does NOT clear the underlying wedged level-2 compaction - still open ops work.
Rollout: `docs/rollouts/2026-08-12-backup-tier-monitor-real-coverage.md`.

## Current (2026-08-12 CLAUDE - connection-health alert noise, root-caused)

Branch `claude/health-alert-noise` (worktree `/private/tmp/fx-st-health`).  Sentry carried ~28
distinct `"<name> connection failed"` issues, almost none of which were real outages.  Seven
verified causes fixed together, kept individually reviewable in the diff:

1. **Streak gate** - the alert gated on `lane.stoppedWorking`, which is ALSO set by two soft
   heuristics that a low-frequency lane's FIRST failure satisfies.  Now requires the hard
   `HEALTH_REASON_CONSECUTIVE_FAILURES` streak.
2. **Fingerprints** - pinned to stable lane ids so display-name drift stops fragmenting one lane
   into six issues.
3. **429 asymmetry** - RAG 429s now skip Sentry the way db-health always did; `alertUsageLimitHit`
   escalation intact.
4. **Re-probe loop** - all synthetic probe failures log soft, breaking alert -> 6h cooldown ->
   re-probe forever.
5. **Retired vendors** - FMP / Quiver / UW excluded from the alert path.
6. **Timeouts** - usage-monitor budget + knobs reads 2500ms -> 8000ms and soft-logged (both are
   fail-open).
7. **Local-fault mislabel** - `storeContexts` receipt/finalize SQLite faults attributed via a new
   cause-chain-walking `localDbFaultReason` instead of "RAG vector store failed".

congress.trade 502s (SOCRATIC-TRADE-B/8/1P) and the filingapi 401 (SOCRATIC-TRADE-1G) confirmed
still alerting, with explicit regression guards.  Rollout:
`docs/rollouts/2026-08-12-health-alert-noise.md`.
## Current (2026-08-12 CLAUDE — CI scripts: Sentry `app` tag + branchless fingerprint, effort-sync transport retry)

Two python-only CI-support fixes on branch `claude/ci-report-app-tag`
(worktree `/private/tmp/fx-st-ci`):

1. `scripts/sentry-ci-report.py` had no app identifier, so ST's events in the
   SHARED `fleet-infra` Sentry project deduped into Congress.Trade's
   identically-named workflow issues ("CI", "Security", "Effort Issues Sync").
   Adds `APP = "socratic-trade"` to the message, tags, and fingerprint.
   Fingerprint is now `[ci-failure, app, workflow]` — branch is a tag only,
   because merge-queue refs are unique per attempt and were minting a throwaway
   Sentry issue per queued run.
2. `scripts/sync-effort-issues.py` `http_request` caught only `HTTPError`, so
   today's `SSL: CERTIFICATE_VERIFY_FAILED` reaching api.github.com killed the
   whole run.  Adds bounded exponential-backoff transport retry for idempotent
   methods only — a `POST` is never replayed, since a truncated create response
   means the issue already exists and a retry would duplicate it.

Crons `monitor_slug` deliberately left un-namespaced: renaming orphans live
Sentry monitors, and there is no collision to fix.  Gates and a 15-check
behavioral harness recorded in the rollout note.

Rollout: `docs/rollouts/2026-08-12-ci-report-app-tag.md`.
## Current (2026-08-12 MONET — iOS parity wave 3: cancel a working order from the phone)

Branch `monet/ios-order-cancel` (worktree `~/apps/trading-monet-wave3`).  Integration branch:
merges `monet/ios-parity-wave2` and `monet/order-cancel-server` (both clean, no conflicts) and
adds the iOS half of roadmap item #3 on top.

- Open orders were the phone's last see-but-cannot-act money surface.  `OrderRow` on the Assets
  screen now carries a **Cancel Order** button plus swipe-to-cancel, both opening the same
  confirmation dialog — the same ceremony the alert-delete row already uses.  No typed
  confirmation: the server requires none for cancel even on a live brokerage account, because
  cancelling prevents an execution rather than causing one.
- The control appears only on WORKING orders.  `OrderCancellation.isWorkingState` mirrors the
  server's `isWorkingOrderState` exactly (`ACTIVE_BROKER_ORDER_STATES` +
  `EXTRA_WORKING_ORDER_STATES`), so it matches the precondition `cancelWorkingOrder` enforces.
  `done_for_day` is excluded (terminal, but returned forever in Alpaca history); `pending_cancel`
  stays cancellable, matching the console — a stuck broker cancel is a reason to ask again.
- Payload `{ orderId, accountNumber }` where the account number is
  `readiness.selectedAccountNumber` — the server's stale-view guard, so a cancel queued while
  looking at one account cannot land on another.  Submitted through the normal `store.submit`
  path (busy guard + per-order idempotency key + snapshot reload); gated on the wave-2 control
  catalog so an older server hides the control instead of collecting a 400.

Round-2 review close-out (all three reviewer items closed; rollout §7):

- **The queued-loosening gap is CLOSED server-side.**  `policy.patch` now accepts an OPTIONAL
  `expectedCurrent` precondition — the same shape as `order.cancel`'s `expectedAccountNumber` —
  carrying the values the client believed were current for the fields it is patching.  Validated
  at queue time (scalar patchable fields only; unknown/wrong-typed/non-object is a 400) and
  compared at EXECUTION time before anything merges: a mismatch audits
  `mobile_policy_patch_precondition_mismatch` and throws `PolicyPatchPreconditionError` (409), so
  the whole patch is refused rather than partially or silently applied.  Without it, a tightening
  tapped against a $10,000 cap could execute as a LOOSENING minutes later, behind a draining
  `strategy.run_once`, if the console lowered that cap meanwhile.  A patch with NO
  `expectedCurrent` behaves exactly as before (proven by a test that performs the same mid-flight
  edit and asserts the legacy write still lands) — the web console is unaffected.  The iOS
  tightening UI now sends the precondition, so the "These controls only tighten" footer is true
  end to end.
- **Cancel is exempt from the >180 s snapshot-staleness gate**, like `account.activate`: a flaky
  connection is exactly when someone reaches for cancel, and the server re-validates
  (`requireWorkingOrder: true` -> 404/409), so a stale tap gets an honest error, never a wrong
  cancel.  Still requires a loaded snapshot and still respects the control catalog.
- **The deep-link focus ring is transient again** — it clears on any tab change and expires four
  seconds after the link lands, instead of marking one proposal card out for the whole session.

Verified: iOS 68/68 XCTests (56 merged base, +8 cancel, +2 round-1, +2 here), `npx tsc --noEmit`
clean, `npm run lint` 0 errors, full `npx vitest run` 6369 passed / 51 skipped (552 files).

Next: owner action only — TestFlight shipping.  Follow-ups: render the server's `dustWarning`
on the card after a cancel; replace-at-market from the phone.

Rollout: `docs/rollouts/2026-08-12-ios-parity-wave3.md`.

## Current (2026-08-12 MONET — iOS parity wave 2: guardrail tightening, control catalog, universal links)

Branch `monet/ios-parity-wave2` (worktree `~/apps/trading-monet-wave2`).  Three items, all on
server capabilities that already exist:

1. **Tighten Guardrails** in the account/settings sheet — submits the existing `policy.patch`
   mobile command.  Autopilot -> Ask-First, and 75/50/25% reductions of `maxOrderNotional` /
   `maxDailyNotional`.  Tighten-only is a pure predicate (`PolicyTightening`), and it refuses
   entirely when a competing percent-of-NAV cap is stored, because the server's
   `normalizeExclusivePolicyCaps` would delete that cap and change which rule binds.  No new
   confirmation ceremony: same weight as Close Only / Wind Down.
2. **`snapshot.catalog` decoded** (`mobileControlCatalog()`), gating non-protective commands
   through `MobileStore.serverAdvertises`.  Missing catalog or empty `commands` falls back to
   the app's built-in controls; protective halts are never catalog-gated.
3. **Universal links + deep-link routing** — the app's first `onOpenURL`.
   `https://socratictrade.com/console/{approvals,approvals/<id>,orders,watchlist,activity}`
   routes to the matching tab (reusing the existing More-stack rerouting for unpinned tabs);
   `socratictrade://` stays auth-callback-only.  Entitlement + `project.yml` claim
   `applinks:socratictrade.com`; the domain half is `app/.well-known/apple-app-site-association/
   route.ts`, added to middleware `PUBLIC_PREFIXES` so Apple's anonymous fetch is not redirected
   to /login.

Verified: iOS 56/56 XCTests (was 37), `npx tsc --noEmit` clean, new vitest file green,
`npm run build` clean (AASA prerendered static).

Next: owner action — no App Store Connect / Apple credential work was performed; the associated
domain only takes effect once a build carrying the entitlement ships.

Rollout: `docs/rollouts/2026-08-12-ios-parity-wave2.md`.
## Current (2026-08-12 MONET — mobile `order.cancel` command, server side)

Roadmap item #3, server half.  The phone could see working orders (`/api/mobile/snapshot` already
filters by `isWorkingOrderState`) but could not kill one.  Now it can.

- The console's cancel logic was extracted out of `app/api/orders/cancel/route.ts` into
  `src/lib/order-cancel.ts` (`cancelWorkingOrder`), so mobile runs the SAME path — lease-interleave
  receipt, time-bounded cancel-dust advisory, `order_cancel` audit, dashboard event, dust
  notification — instead of a second implementation drifting against the gateway.  The route is now
  the HTTP shell; console behaviour is unchanged and its three existing route tests pass untouched.
- New mobile command `order.cancel`, payload `{ orderId, accountNumber? }`.  Immediate (bypasses the
  sequential worker, so it cannot land behind a 30-minute `strategy.run_once`) but deliberately NOT
  protective — it must not cancel the operator's other queued work the way stop/close_only do.
- No typed confirmation: cancelling closes risk, it does not open it.
- Account isolation: every cancel is scoped to the requesting user's own selected account through
  their own credentials; a caller-named account that is not the selected one is refused before any
  broker I/O (`order_cancel_account_mismatch`), and the mobile lane additionally resolves the order
  in that account first (fail-open on an unavailable read, receipted).
- Replace-at-market is NOT included; requirements for it are listed in the rollout note.

Branch `monet/order-cancel-server`, worktree `~/apps/trading-monet-cancel`.  No iOS files touched.
Rollout: `docs/rollouts/2026-08-12-order-cancel-command.md`.

## Current (2026-08-12 GROK — iOS watchlist wrap + account switch + admin + P&L)

Owner Assets screenshot + follow-up.  Four bugs on one branch
`grok/ios-watchlist-chip-wrap` (worktree `~/apps/trading-grok-watchlist-chips`):

1. Watchlist chips wrap mid-ticker — content-sized `WrappingHStack` (#2657).
2. Use-account looks dead, then snaps — keep Switching pill until snapshot.
3. Tradier Sandbox `$0` P&L — unrealized from positions; realized "—" without fills.
4. Admin Portal stuck — loading UI, cookie timeout, same-host subframe allow.
5. Alpaca Paper "won't switch" — activate now invalidates the dashboard snapshot cache.

Rollout: `docs/rollouts/2026-08-12-ios-watchlist-chip-wrap.md`.

## Current (2026-08-12 ~7:30am CT CLAUDE — external-repo lessons round 2: alpha grading, signal health, cancel-dust)

Round 2 of the owner's external-repo lessons request (broad sweep: TradingAgents, ai-hedge-fund,
freqtrade, qlib, RD-Agent, FinMem).  Three definitive wins land in this PR, each built by a
dedicated agent, adversarially verified, and integration-fixed:

1. **Opt-in benchmark-alpha outcome grading** (`policy.outcomeGradingMode`, default raw,
   byte-identical): alpha mode grades decisions against SPY over the same window, cites alpha in
   the post-mortem prompt, writes divergence receipts (raw won / alpha lost = beta-not-skill),
   and keeps an :alpha stat ledger in retrieval-usefulness weighting.
2. **Live signal-health monitor**: daily lane computing rank IC of the LLM's own confidence vs
   matured outcomes (90-day window), quantile buckets, top-K churn, gross-vs-net; edge-triggered
   drift alarms via notify(); optional auto-throttle knob (default OFF); Signal Health card on
   Results (migration 74 — first migration shipping under the new BEGIN IMMEDIATE boot path).
3. **Cancel-dust advisory** (advisory ONLY, never blocks): partial-fill cancels that would
   strand a below-broker-minimum fragment warn in the cancel sheet + audit; pre-fetch is
   time-bounded so the emergency cancel lever can never wait on a hung broker read.

Gates: tsc clean, targeted suites 82/82; full lint/test/build via land.sh at push.  Rollout:
docs/rollouts/2026-08-12-external-lessons-round2.md.  Blockers: none.
## Current (2026-08-12 ~6:40am CT CLAUDE — HOTFIX: boot migrations vs rolling deploys)

PR #2652's auto-deploy failed (deployment pyqxv16i): the incoming container crash-looped on
SQLITE_BUSY loading the instrumentation hook and Coolify rolled back (prod stayed up on the old
build).  Root cause: runMigrations used better-sqlite3's default DEFERRED transaction — under a
rolling deploy the outgoing container commits continuously, and the WAL snapshot upgrade throws
an instant SQLITE_BUSY that busy_timeout does not cover.  Fix: apply migrations via BEGIN
IMMEDIATE (apply.immediate()) so the 60s busy_timeout works; new child-process contention
regression test.  This PR's own deploy applying migration 72 is the live proof.  Blockers: none.

## Current (2026-08-12 ~6:20am CT CLAUDE — symbol drawer everywhere + iOS fills redesign)

Owner requests: ticker/logo clicks open the Market Scan company drawer on every surface
("all aspects of the site anywhere really"), and the iOS Activity fill cards get bolder/larger
text + a denser layout (screenshot critique).  Branch `claude/ui-symbol-drawer-fills`.

Web: closed every remaining un-wired symbol render (order cancel/replace sheets, live-approve
sheets, decisions rows via a stretched-link restructure, admin data-catalog + rag-coverage with
SymbolDrawerProvider newly mounted in the admin layout).  Fixed a real crash the sweep exposed:
SymbolDrilldownSheet's unconditional useConsoleData() throw outside the console shell — new
useConsoleDataOptional(), with an honest "not available here" exposure state.  Mobile PWA
deferred honestly (drawer depends on con-* tokens the PWA does not load).

iOS: FillActivityRow/CommandActivityRow typography bumped (ticker title3 bold, notional title3
semibold, date footnote) with tighter AppCard padding; new SymbolInfoSheet (same /api/quote
cascade as the web drawer) tappable from fills, positions, orders, watchlist, flow chips,
alerts, and proposals; 44pt remove target restored; derived marketCap removed (no fabrication).

Verified: tsc/lint/targeted vitest green; xcodebuild green (incl. post-merge with #2647 tabs +
parity wave); browser check — AAPL click opens the "AAPL details" con-drawer with live data;
admin routes 200.  Rollout: docs/rollouts/2026-08-12-ui-symbol-drawer-fills.md.  Blockers: none.

## Current (2026-08-12 ~5:40am CT CLAUDE — dsa-lessons round 1: digest, relevance, receipts)

Owner asked for lessons from ZhuLinsen/daily_stock_analysis (62k-star LLM stock-analysis repo),
then broadened to a moderately broad GitHub sweep.  Research ran as two 15-agent workflows
(readers -> synthesis -> per-lesson gap analysts); full verdicts + sketches in
`docs/reviews/2026-08-12-dsa-lessons-gap-analysis.md`.  This lane (branch `agent/claude`) lands
round 1 — three implemented lessons, each built + adversarially verified + integration-fixed:

1. **Opt-in daily watchlist digest** (default OFF; Settings -> Delivery): typed report context
   (latest persisted scan quote + proposal trajectory per symbol) -> full/medium/brief renderers ->
   notify() `bodyTiers` picking the largest tier per channel via new `CHANNEL_CAPABILITIES`
   (also retires the latent pushover/ntfy truncation gap).  New `trade_proposals.symbol` column
   + index (migration + backfill).  Fires once per CT day at/after 15:15 CT via a watermark lane.
2. **News entity-relevance gating** (default ON, real off-switch via `NEWS_RELEVANCE_*` knobs):
   AV `relevance_score` and Marketaux `match_score` were documented-but-discarded — now parsed and
   gated (match_score normalized /100 — it was ~12-82, making the 0-1 knob inert until the
   integration fix); leaf rubric `news-relevance.ts` with ambiguous-company-name corroboration;
   stream path drops only zero-evidence associations on multi-symbol articles.
3. **Proposal repair-ladder receipts** (money-path, surgical): `TradeProposal.dataAdjustments`
   kind-prefixed receipts; deterministic session-vs-phrasing guard (never blocks/rewrites);
   `confidenceCapDataDegraded` tuning knob; existing bracket-fallback disclosures now also write
   receipts; approval card renders them.

Gates: lint 0 errors; tsc clean; targeted suites 76/76; full test+build via land.sh at push.
Next: round-2 implementation (benchmark-alpha grading, signal-health monitor, cancel-dust
advisory) on this lane after merge; UI lane (`claude/ui-symbol-drawer-fills`) lands separately.
Blockers: none.

## Current (2026-08-12 MONET — iOS parity wave 1: decision-critical fields, protective controls, swipe actions, admin portal)

**Branch `monet/ios-parity-wave1`** (stacked on `monet/ios-customizable-tabs`, PR #2647): First
wave of the iOS parity roadmap — all zero-backend, rendering already-decoded snapshot data and
dispatching existing command types.  (1) Proposal cards now show price drift (reference → current
price with signed %), last revalidation time, and the Red Team failure kind when the verdict is
unavailable (console `describeRedTeamFailureKind` wording).  (2) Home gains Close Only + Wind Down
protective controls beside Stop (`strategy.close_only` / `strategy.liquidating`, same
CommandButton/store.submit pattern, no added ceremony).  (3) `policy.runDuringExtendedHours` is now
decoded and a pure `deriveRunStateWord` mirrors the console's `deriveStateInfo` vocabulary — the
app can no longer say "Running" while the console says "Paused · market closed" (7 new XCTests).
(4) Swipe-to-reject on proposal cards (reject ONLY, never approve) and swipe-to-delete on alert
rows via a new ScrollView-compatible `swipeRevealAction`; watchlist swipe skipped (chip grid, not
rows — one-tap remove already exists).  (5) Triggered alerts show `triggeredAt`/`triggeredPrice`.
(6) Account sheet rows show capabilities + draining state.  (7) New `AdminPortalView` (admin-only
row) hosts /admin in a navigation-fenced WKWebView with native-session cookie handoff.  28/28
tests pass.  Rollout: `docs/rollouts/2026-08-12-ios-parity-wave1.md`.

## Current (2026-08-12 MONET — iOS customizable tab bar + xcodegen version-regression root cause)

**Branch `monet/ios-customizable-tabs`:** The iOS app's tab bar is now owner-customizable with
the exact web mobile-tabs semantics (`app/console/lib/mobile-tabs.ts` parity: pin/unpin, min 2 /
max 4, canonical-order bar, always-present More surface keeping every screen reachable), using
the native system `TabView` so the Liquid Glass appearance is preserved.  Programmatic tab jumps
to unpinned screens reroute into the More stack.  8 new XCTests pin the contract.  Along the
way, found and killed the ROOT CAUSE of the 2026-08-11 version regression: `xcodegen generate`
was rewriting Info.plist's version keys to literal `1.0`/`1` because `project.yml` never
declared them — now declared as `$(MARKETING_VERSION)`/`$(CURRENT_PROJECT_VERSION)` so any
future regen preserves substitution.  A parallel expert-panel workflow is reviewing web↔iOS
parity and reports separately.  Rollout: `docs/rollouts/2026-08-12-ios-customizable-tabs.md`.

## Current (2026-08-11 MONET — litestream per-tier backup status: health check + admin panel)

**Branch `monet/backup-status-panel` (committed locally, not pushed — see rollout note for why).**
Tonight's litestream incident (stuck level-1 B2 compaction anchor, silently wedged 27+ hours —
see the escalation trail above and `docs/rollouts/2026-08-09-event-loop-stall-instrumentation.md`)
exposed a real gap: `checks.storage.litestream*` on `/api/health` only ever observes level 0
(continuous sync) via the IPC socket, so it would NOT have caught this. Added: (1)
`assessLitestreamTierFreshness()` in `src/lib/runtime-health.ts` — per-compaction-level (0/1/9)
freshness via local `ltx/<level>/` file mtimes, with documented thresholds (10min/4h/30h) and a
graceful "unknown" state everywhere litestream isn't configured this way; (2) wired additively
into `checks.storage.litestreamTiers` on `/api/health` (existing fields untouched) + folds into
`storageDegraded` + per-tier `alertStorageWarning`; (3) new admin panel `app/admin/backups/` (nav
entry "Backup Status") showing Continuous Sync / Compaction / Daily Snapshot per-tier health,
backed by new admin route `app/api/admin/backup-status/route.ts`; (4) tests in
`test/runtime-health.test.ts` (unit), `test/connection-health-routing.test.ts` (integration,
reproduces the exact incident shape against the real route), `test/backup-status-route.test.ts`
(new, admin route). `npx tsc --noEmit` clean, `npm run lint` 0 errors, targeted vitest run (57
tests across the 4 touched/related files) green. Full `npm test`/`npm run build` run before
commit — see the rollout note for final counts. Does NOT fix the underlying stuck B2 anchor
itself (that's separate ops work, still open). Rollout:
`docs/rollouts/2026-08-11-litestream-tier-backup-status.md`.
## Current (2026-08-11 ANTIGRAVITY — Desktop Web & Mobile PWA UX Enhancements)
## Current (2026-08-12 ANTIGRAVITY — OSS lessons, Strategy ID fixes, & Dashboard additions)

1. **Bug fixes**:
   - Fixed `proposalId` loop re-assignment in `src/lib/strategy.ts` (Issue #2593) which caused orphaned receipts.
   - Applied `roundCents` to `bracketForm` in `src/lib/tradier.ts` (Issue #2578) to fix sub-penny bracket routing.
   - Verified that `onClick` was already correctly implemented for account deletion in `MobileHomeTab.tsx` (Issue #2592).
2. **Dashboard Features**:
   - Added `MarketAnalysisCard` in `app/console/page.tsx` to display macro regime and market breadth.
3. **Documentation**:
   - Updated `docs/oss-lessons.md` with integration learnings from `daily_stock_analysis`.

**Verification**: `npx tsc --noEmit` clean, `npm run lint` clean (fixed 1 let->const error), `npm test` clean, `npm run build` clean.

## Previous (2026-08-11 ANTIGRAVITY — Desktop Web & Mobile PWA UX Enhancements)

**Branch `ag/desktop-mobile-ux-enhancements`:**
1. **Desktop Web UX**:
   - `command-palette.tsx`: Added global hotkeys (`Cmd+K`/`Ctrl+K` command palette toggle, `A` Proposals jump, `R` strategy run-once dispatch, `1-6` tab navigation). Added `<kbd>` badges and `action:run-once` command item.
   - `approval-card-skeleton.tsx` & `portfolio-overview-skeleton.tsx`: Created animated pulse skeleton loading components matching approval cards and portfolio overview metrics.
   - `console.css`: Synchronized `.dark` design token values with `app/globals.css`.
2. **Mobile Web PWA UX**:
   - Refactored `mobile-pwa-client.tsx` into modular components under `app/mobile/components/` (`MobileHeader.tsx`, `MobileNavBar.tsx`, `MobileHomeTab.tsx`, `MobileProposalsTab.tsx`).
   - Implemented `usePreventScrollChaining` hook for WebKit boundary top check (`scrollTop === 0` set to `1`) and CSS `overscroll-behavior-y: contain` to prevent iOS Safari body scroll chaining.
3. **Verification**: `npx tsc --noEmit` clean, `npm run lint` clean (0 errors), `npm test` (83 files / 739 tests passed), `npm run build` clean.

## Current (2026-08-12 ~12:20am CT MONET — new app icon: dollar-sign candlesticks)

Owner supplied a reference image (3D-rendered candlesticks arranged as a "$", green/pink
palette, light gray grid background) and asked for it as the app icon with a lightened
background. Replaced `ios/SocraticTrade/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png`
(previously a "ST" wordmark built from candlesticks) with a processed version of the owner's
image: background lightened via a saturation-based blend (candlestick colors untouched, smooth
ramp rather than a hard threshold to avoid speckling in the soft-shadow areas), resized to the
required 1024x1024, confirmed opaque RGB (no alpha — required for App Store icons). Single-file
change, no other icon sizes to update (this appiconset uses Xcode's unified single-size format).
## Current (2026-08-12 ~12:08am CT MONET — litestream reset executed; leak appears resolved, monitoring continues)

Escalation trigger from the previous entry fired (kill gap compressed to 5m35s). Owner approved
proceeding. Executed the previously-planned fix: `docker stop` (clean, 30s), cleared the local
litestream LTX metadata directly on the host volume path (`litestream reset`'s documented effect
— never touches the DB file or B2), Coolify `start` (image reused, no rebuild). ~6 min outage.
Post-restart: litestream started with zero errors (previously every fresh start hit a checksum
mismatch within 2-3 min, without exception), memory at 374MiB ~4 min in (previous fresh starts
were multi-GB by this point). Strong early signal, NOT yet confirmed as fixed — several hours of
clean operation spanning a level-9 snapshot cycle is the real bar. Full detail + what to check if
it recurs: `docs/rollouts/2026-08-09-event-loop-stall-instrumentation.md` ("Fix executed" section,
bottom).

## Current (2026-08-11 MONET — iOS version regression fix)

PR #2637 accidentally hardcoded `ios/SocraticTrade/Info.plist`'s `CFBundleShortVersionString`
to the literal `"1.0"` and `CFBundleVersion` to `"1"`, replacing what used to be
`$(MARKETING_VERSION)`/`$(CURRENT_PROJECT_VERSION)` build-variable substitution. This silently
broke the owner's version regimen (App Store "Version" goes 1.0.0 -> 1.0.1 -> 1.0.2 per release,
separate from the internal build number): bumping `MARKETING_VERSION` in the Xcode project would
no longer have actually changed what ships. Restored both fields to variable-substitution form
and set `MARKETING_VERSION`=1.0.1 / `CURRENT_PROJECT_VERSION`=2 in both `project.pbxproj`
(Debug+Release) and `project.yml` — this is the first build after 1.0.0/1.0 already shipped to
TestFlight. `preferredProjectObjectVersion`/`TARGETED_DEVICE_FAMILY` from #2637 left untouched
(legitimate fixes, not part of this regression). Rollout:
`docs/rollouts/2026-08-11-ios-version-regimen-fix.md`.

## Current (2026-08-11 ANTIGRAVITY — System Audit & iOS Resiliency Rollout)

**Branch `agent/antigravity-review`:** Top-to-bottom audit across Desktop Web, Mobile Web (PWA), iOS App (SwiftUI), Backend Pipelines (SEC EDGAR ingest, RAG vector engine), Database Concurrency, Latency Monitoring, and Competitor Benchmarking. Artifact `implementation_plan.md` created; review note `[ST, Antigravity] Comprehensive System Audit & Improvements` created and pinned in Apple Notes (folder `Coding`). Native iOS client updated with exponential backoff retry loop (`MobileAPIClient.swift`) and raw JSON disk caching (`MobileStore.swift`) for instant `<50ms` offline startup. All gates verified green (Xcode build, tsc, lint, vitest). Rollout: `docs/rollouts/2026-08-11-system-audit-and-ios-resiliency.md`.

## Current (2026-08-11 ~9:40am CT MONET — litestream kill cadence ACCELERATING: 51→78→49→20→19 min gaps)

Since the root-cause deploy below, 6 more OOM kills logged (all `exitCode=137`, all auto-recovered
in ~1s, site health unaffected each time). The gap between kills has compressed from ~50-80 min
down to ~19-20 min over the last 3 cycles — consistent with the confirmed root cause (the stuck B2
compaction anchor persists in the replica's own state across restarts, so un-compacted WAL keeps
growing across the whole incident, not per-container). **Escalation trigger set:** if the gap
compresses under ~10 minutes, stop deferring to "daylight" and actively clear the stuck B2
generation now (see next steps in the rollout note) regardless of local time. Full timeline +
reasoning: `docs/rollouts/2026-08-09-event-loop-stall-instrumentation.md` (escalation section,
bottom).

## Current (2026-08-11 ~4:30am CT MONET — litestream leak root cause CONFIRMED, not yet fixed)

The all-night litestream OOM-leak (open since 2026-08-09) has a confirmed root cause now, not
just a hypothesis: litestream's B2 replica is stuck compacting from txid `2324d` — every retry's
multipart upload fails with `file checksum mismatch` on close (~every 100s), the anchor never
advances, so each retry re-uploads a larger accumulated range, which is why memory climbs and why
peak-per-kill severity keeps growing (2.05→4.82GB across 9 kills so far). No existing kill-switch
applies (the only one is R2-specific and explicitly no-ops on B2). Site serving health remains
unaffected throughout (Docker `restart: unless-stopped` recovers every crash in seconds) — this
is not an outage, but the leak itself remains open. Full evidence + next steps for daylight fix:
`docs/rollouts/2026-08-09-event-loop-stall-instrumentation.md` (root-cause section, bottom).

## Current (2026-08-10 GROK — default light theme)

Branch `grok/default-light-theme`: light is product default (web + iOS). Dark only via explicit choice. Rollout: `docs/rollouts/2026-08-10-default-light-theme.md`.

## Prior

## Current (2026-08-10 GROK — iOS invalid SF Symbol)
## Current (2026-08-11 MONET — server-metrics panel repair + canonical Oracle→Hetzner doc correction)

**No branch (config + docs, direct on `main` — repo-side changes on `monet/*`, see below):**
ST's admin server-stats panel was fully broken (`degraded: true, stale: true`, Coolify 401 +
Hetzner 404×2) because `AGENTS.md`/`CLAUDE.md` — and therefore this session's own initial
answer to the owner — had never caught up with the 2026-08-07 emergency cutover off Oracle Cloud
(Oracle suspended the account without reason, `docs/rollouts/2026-08-06-ios-login-522-oracle-down.md`)
to a brand-new Hetzner box (`docs/rollouts/2026-08-07-hetzner-fleet-cutover.md`). Three stale
values found and corrected: `HETZNER_SERVER_ID` (wrong box) and `COOLIFY_SERVER_UUID` (wrong
UUID) in ST's Infisical, plus a dead 401 `COOLIFY_SERVER_STATS` token in BOTH ST's Infisical and
the `~/.secrets/global-api-keys.env` handoff file (fixed from the box's own dedicated, working,
read-only-scoped token at `/root/.coolify-api-token-stats` — deliberately did NOT substitute the
broader `COOLIFY_AGENTS` token, preserving the read-only/admin scope separation). Panel verified
fully live post-fix: `degraded: false, stale: false, cacheAgeSeconds: 0`, real resources
(`socratic-app`, `congress-trade`, `usage-monitor`). `AGENTS.md`'s hosting section rewritten to
lead with the real current host: `167.233.254.55` / `fleet-hetzner-nbg1` / Hetzner `cx43` (8 vCPU
AMD EPYC-Rome, 16 GB RAM, 160 GB NVMe) / Coolify server UUID `jxzqcs3h6g1wiipnnblhismp` / Hetzner
hardware serial `159792099`. UM's own panel not independently re-verified (no admin credential
available this session) — UM's hardcoded fallback defaults already match the correct live
values, so it should work unless UM's own Infisical has a stale explicit override. Rollout:
`docs/rollouts/2026-08-11-server-metrics-panel-hetzner-config-repair.md`.

## Prior (2026-08-10 GROK — iOS invalid SF Symbol)

**Branch `grok/ios-bell-badge-symbol`:** Assets toolbar used nonexistent SF Symbol
`bell.badge.plus` (console: `No symbol named 'bell.badge.plus' found in system
symbol set` — blank create-alert icon). Replaced with valid `bell.badge`. Rest of
the owner’s console dump (QUIC / `nw_connection_*` / PointerUI / “cannot add
handler”) is system noise. Rollout:
`docs/rollouts/2026-08-10-ios-invalid-sf-symbol-bell-badge.md`.

## Prior (2026-08-10 ~2:00am CT GROK — unstick open PR #2597)

**Only open PR after #2603 merged:** #2597 `grok/always-auto-merge-prs` — fleet policy always-auto-merge for non-draft same-repo PRs + `do-not-automerge` hold. Blockers fixed this pass: real `AGENTS.md` conflict (kept main's Apple Notes close-out), `sentry-ci-report.yml` missing the new workflow name (failed `test/sentry-ci-report-workflows.test.ts`), Codex P1s (disable auto on hold label; `GH_PAT`/`SHEPHERD_TOKEN` preferred so post-merge workflows fire; squash-only; fail when arming fails). Next: green `verify` → auto-merge → Coolify auto-deploy. Rollout: `docs/rollouts/2026-08-10-always-auto-merge-prs.md`.

## Prior (2026-08-09 ~11:45pm CT MONET — event-loop stall instrumentation)

**Branch `monet/sec-worker-edgar-403` (stacked):** Uptime Robot incidents on socratictrade.com — next-server pins 100%+ CPU 11-85s during filing ingests (event loop held by synchronous extract/chunk/score segments chained by the trial knobs). Shipped warn-only timeSync wrappers (extractFilingText / tradeHighlightChunksFromText / chunkDocument) + yieldEventLoop between filings/tasks. Prod names the hot spot in [slow-sync] logs; targeted fix follows. OpenRouter credits $55.50/$165 left (decision traffic, not embeds). Rollout: `docs/rollouts/2026-08-09-event-loop-stall-instrumentation.md`.

## Prior (2026-08-09 MONET — EDGAR 403 worker hardening)
## Current (2026-08-09 MONET — EDGAR 403 worker hardening)

**Branch `monet/sec-worker-edgar-403`:** minutes after the trial knobs + full-universe seed went
live, every SEC ingest worker fetch 403'd (`www.sec.gov/Archives`), dead-lettering ~50 tasks.
Root causes: worker fetched with NO User-Agent (SEC hard-403s undeclared tools; the refresh lane
passes UA explicitly and kept working), prod lacked `SEC_EDGAR_USER_AGENT` (now set in Infisical),
secLimiter only reacted to 429 (SEC signals blocks with 403), and the worker burned stage attempts
into an IP-level block. Fixes: UA auto-injection for `.sec.gov` in `politeFetch`; `report403()`
global cooldown (`SEC_403_COOLDOWN_SECONDS`, default 600s) + `pausedUntilIso()`; worker defers
(attempt refunded, `edgar_403_deferred`) instead of failing; `requeueSecIngestDeadLetters` + admin
`{action:"requeue-dead-letter"}`. 35 tests green incl. 2 new; tsc clean. Post-deploy: requeue
dead letters, watch checkpoints advance. Rollout:
`docs/rollouts/2026-08-09-edgar-403-worker-hardening.md`.

## Prior (2026-08-09 MONET — trial knobs LIVE in prod + EDGAR shard-field fix)
## Current (2026-08-09 MONET — trial knobs LIVE in prod + EDGAR shard-field fix)

**Branch `monet/sec-shard-field-fix`:** the trial knob set from the throughput audit is now
APPLIED in prod (Infisical + Coolify restart; all 7 values verified in the serving process env):
delay 0ms, batch 32, texts/day 250k, WU/day 2.5M, SEC per-run 200, TTL 6h, ingest worker ON.
`data/rag-universe-manifest.json` copied onto the prod data volume (the `/app/data` volume mount
shadows the image's `data/`, so the seeder 500'd ENOENT). First full-universe seed then exposed a
real bug: `SubmissionsJson.filings.files[]` used invented field names `filingStart/filingEnd`;
real EDGAR shards carry `filingFrom/filingTo`, so the shard-pagination sort threw
`undefined.localeCompare` and aborted the seed (test fixture had the same wrong names — suite
green, prod broken). Fixed with real names + `?? ""` guard. Re-seed after this deploys. Rollout:
`docs/rollouts/2026-08-09-trial-knobs-applied-and-edgar-shard-fix.md`. Next: re-run seed, watch
`GET /api/admin/sec-ingest` receipts + `rag_usage` daily volume (expect ~4k → 100k+ records/day).

## Prior (2026-08-09 MONET — Pinecone trial throughput audit + monthly WU pace guard)

**Branch `monet/pinecone-trial-maximize` (commit-only; landing operator lands):** owner wants the
Pinecone Standard trial used close to full extent, then a drop to free/$20 without a repeat of the
hourly-429 mess. (A) Throughput audit — every ingest limiter inventoried with TRIAL vs AFTER values
for the owner to apply in Infisical (no secrets read/written). Headline: `VECTOR_EMBED_BATCH_DELAY_MS`
(default 21s, a Voyage-3-RPM artifact) is applied unconditionally between embed batches and pins
ingest at ~1,371 chunks/h even on OpenRouter bge-m3 — the single biggest lever. OpenRouter embed
spend is NOT the constraint (~$0.0013 per 1k chunks); post-trial Pinecone STORAGE is. (B) New
`src/lib/pinecone-monthly-pace.ts` — persisted calendar-month WU counter (fed from
`meterPineconeUpsert`, resets on month roll), linear month-end projection with a 0.2 elapsed floor
(mirrors `r2-usage.ts`), `PINECONE_MONTHLY_WU_BUDGET` default 0 = OFF. When projected pace exceeds
the budget the SEC ingest **backfill queue** stops claiming new tasks; incremental filing ingest and
all retrieval are structurally un-gated. ONE advisory + audit per calendar month. Number exposed at
`/api/admin/rag-coverage` → `providerUsage.pinecone.monthlyWriteUnitPace` even when off. Gates: tsc
clean; 12 test files / 162 tests green (new `test/pinecone-monthly-pace.test.ts` 10/10); lint 0
errors. Rollout: `docs/rollouts/2026-08-09-pinecone-trial-throughput-and-monthly-pace.md`.
## Current (2026-08-09 MONET — "Pinecone connection failed / database is locked" mislabel)

**Branch `monet/pinecone-lock-mislabel` (commit-only; landing operator lands):** the hourly
owner-visible push titled "Pinecone connection failed" with body `inventory fetch: database is
locked` was OUR SQLite, not Pinecone. Root cause: `settleProviderDispatch`
(`src/lib/db-provider-dispatch.ts`) opened a DEFERRED transaction that SELECTs before it UPDATEs,
so promoting the WAL read snapshot to a write returns `SQLITE_BUSY_SNAPSHOT` ("database is
locked") instantly WITHOUT consulting `busy_timeout` — which is why the 60s ceiling never absorbed
it; every ledger transaction now opens `BEGIN IMMEDIATE` (repro receipts in the rollout note).
Second fix: new `src/lib/local-db-fault.ts` classifies local-SQLite failure signatures, and
`withRagApiHealth` no longer writes a provider failure row or a `provider_degraded` push for them —
it records a `local_db_contention` audit row and, past 5 occurrences in 6h, ONE advisory titled
"Storage Warning: local database contention" (never a vendor name); `alertConnectionFailure` gets
the same guard for non-RAG lanes. Real Pinecone HTTP/network errors behave exactly as before.
Gates: tsc clean; 22 test files / 236 tests green (new `test/local-db-fault-classification.test.ts`
7/7, both new assertions verified to fail without the fix); lint 0 errors. Rollout:
`docs/rollouts/2026-08-09-pinecone-lock-mislabel.md`.

## Current (2026-08-09 MONET — durable embed stage: embed-once guarantee)

**Branch `monet/embed-stage` (stacked on `monet/pinecone-wu-breaker` / PR #2596; commit-only —
landing operator lands):** owner directive — a paid OpenRouter document embedding must never be
paid for twice. New SQLite `embed_stage` table (durable L2 under the process-local L1 cache):
`storeContextsImpl` persists each paid vector (Float32 BLOB, keyed
content_hash-of-embed-input + model + embed-rev) AFTER provider validation and BEFORE the
Pinecone upsert; upsert success deletes the rows (managed commits defer to after
markCommitted); upsert failure keeps them and every retry path replays them with ZERO provider
calls — durable across restarts. WU-breaker gate still blocks everything (incl. stage-consume)
until it lifts; stage replays on resume. Retention: 35d orphan sweep + 2 GiB oldest-first cap in
the daily audit-prune lane. Receipts: `embed_stage_replay` audit (embeds avoided per store call),
`embedsFromStage` on results + lastIngest. Gates: tsc clean; 33 test files / 376 tests green
(incl. new `test/embed-stage.test.ts` 11/11); lint 0 errors. Rollout:
`docs/rollouts/2026-08-09-embed-stage.md`.

## Current (2026-08-09 MONET — Pinecone monthly WU exhaustion breaker)

**Branch `monet/pinecone-wu-breaker` (commit-only; landing operator lands):** prod Pinecone
upserts 429 hourly on the exhausted 2M/month write-unit quota (10-K backfill), re-embedding
the same docs through paid OpenRouter every cycle. New breaker: detection in
`withRagApiHealth` trips a marker (`pinecone:wuExhaustedUntil` = 1st of next month UTC,
ONE storage_warning + audit, health row soft `[expected-limit]`), early gate in
`storeContexts`/`storeDocument` refuses writes BEFORE any embed spend
(`wuExhausted` typed skip, ≤1 audit/day), sec_ingest tasks park cleanly via new
`deferSecIngestTask` (retry_wait at marker expiry, stage attempt refunded — no retry storm
or dead-letter), sec-filings bulk loop stops at the first gated filing. Auto-clears on
expiry AND on any successful Pinecone write (plan upgrade); Connections pinecone lane shows
yellow `LIMIT` "monthly write units exhausted · resumes <date>" instead of red STOPPED.
Gates: tsc clean; 16 test files / 201 tests green (incl. new
`test/pinecone-wu-breaker.test.ts`, 9 tests); lint 0 errors. Rollout:
`docs/rollouts/2026-08-09-pinecone-wu-breaker.md`.

## Current (2026-08-07 GROK — Litestream → Backblaze B2)

**Active SQLite backup target is Backblaze B2** (`jays-socratic-trade-eu`, eu-central-003).
Infisical ST prod `AWS_*` repointed to scoped key `fleet-socratic-backup`; prior R2
credentials preserved as `AWS_R2_HISTORIC_*` (R2 objects left in place — historic).
Code: `litestream.coolify.yml` (force-path-style, 7d retention, 60s sync); R2 free-tier
kill-switch no longer pauses litestream when endpoint is B2. Host spare forensic
`app.db.*` copies pruned after integrity_check=ok. Branch `grok/litestream-b2-backup`.
Rollout: `docs/rollouts/2026-08-07-litestream-b2-backup.md`.
# Status

## Current (2026-08-08 MONET — review-fix wave E: owner mobile punch list)

**Branch `monet/review-fixes-e` (isolated worktree, commit-only — landing operator lands):**
owner iPhone-Safari punch list. New owner-wide `SENTENCE_GAP` (NBSP+space) sentence separator
applied to this wave's copy; Proposals empty state merged to one paragraph naming the ⚡
lightning Run-once button; Orders header de-chipped (env + account chips duplicated the top
banner) with Refresh on the h1 row and a merged intro; mobile tab bar restored to
`bottom:0` + env(safe-area-inset-bottom) only (the 2026-08-05 chrome-gap shift itself hid the
labels under Safari's URL chrome and its ≥48px underlay was the grey buffer — reverted);
Positions weight is now the UNSIGNED share of gross exposure (kills "-0.0%" short artifacts;
fmtPct never renders negative zero); Orders LAST PRICE gains a durable `symbol_field_latest`
final fallback (`orderPriceFallbacks` on the snapshot, age-tagged "· 23h old") and the mobile
card label is one-line "Last". Gates: tsc clean; 12 test files / 161 tests green; lint 0
errors. Rollout: `docs/rollouts/2026-08-08-review-fixes-e-mobile-punchlist.md`.

## Current (2026-08-08 MONET — review-fixes wave D: mobile #2559 #2551)

**PWA Market metric now renders the real session** (type drift `{label,isOpen}` → raw
`"closed"|"regular"|"pre"|"post"` token, capitalized like iOS), **iOS stream indicator
turns green on `: ping` heartbeats** (`events(onConnect:onEvent:)`), and **PWA proposal
cards get the console Wave-A2 collapsed receipt** (2–3 line thesis with [Sizing]/[Risk]/
[Stale quote] blocks stripped; "Show full reasoning" expands to full text; approve/reject
untouched). Branch `monet/review-fixes-d` (IN PR — landing operator runs full gate).
Rollout: `docs/rollouts/2026-08-08-mobile-review-fixes-d.md`.
## Current (2026-08-08 MONET — review-fix wave C: feed/alerts/critic)

**#2553/#2555/#2552 (branch `monet/review-fixes-c`):** ingest/embed audit kinds fold into the
activity feed's System collapse; duplicate "BUY X"/"TRADE X" sibling rows merged at derive time
(pre-insert proposalId orphans); no-op disclosure-embed audits roll up to at most one daily row;
alert center gains a single expandable "N provider lanes degraded" rollup + reversible per-condition
24h mutes ("muted N" count); critic-failure chips name the cause (model + kind, not_configured
distinct) and Results shows a critic failure rate (30d) stat. Gates: tsc clean, focused vitest
14 files / 143 tests green, lint 0 errors. Rollout:
`docs/rollouts/2026-08-08-review-fixes-c-feed-alerts-critic.md`.
## Current (2026-08-08 MONET — data-integrity fixes #2557 #2548)

**Results math stops trusting unverifiable inputs (display/aggregation only):** inferred
transfers must reconcile against their own sub-period's equity delta (else "inferred —
unverified" chip, excluded from TWR/day-P&L; kills the phantom $36.5k-withdrawal +56% TWR);
dead/stale SPY series renders a first-class "benchmark unavailable" state + advisory audit
instead of fake 0.00%; open lots are reconciled against live broker positions ("ledger
mismatch" chip; mismatched symbols excluded from wash-sale/early-exit/harvest figures with a
footnote). Branch `monet/review-fixes-b`; landing operator runs full gate + `land.sh`.
Rollout: `docs/rollouts/2026-08-08-data-integrity-flow-sanity-ledger.md`.
## Current (2026-08-08 MONET — review fixes wave A)

**Review-fixes wave A (#2547 #2549 #2554 #2556 #2562):** real `/console/decisions` index
(Home "All Decisions" no longer 404s); one shared run-state vocabulary (`StateInfo.word`)
across console chrome / Guardrails / PWA header (+ `runDuringExtendedHours` on the mobile
snapshot); unmanaged-shorts advisory banner (Home positions + Guardrails Short selling);
#2547 verified NOT a drift (v2.5.1 annotated tag == locked commit `b454ccb8`, lock-only
install zero-diff); #2562 copy/polish batch (a–n: intro-canvas theme colors + content
shield, "Deployed today" chip, feed state dedup, ••last4 mask, full-symbol logo fallback,
`--con-shadow-up` token, fs-2xs tokens, etc.). Branch `monet/review-fixes-a` (isolated
worktree; landing operator runs full gates). Rollout:
`docs/rollouts/2026-08-08-review-fixes-a.md`.

## Current (2026-08-08 MONET — weekly R2 cold snapshot)

**Weekly cold DB snapshot to the idle R2 bucket (second-provider DR):** durable due-job
(Sunday ~03:17 UTC) runs better-sqlite3 `backup()` → 100 MB-part multipart upload to
`cold-snapshots/app-<date>.db` in the `AWS_R2_HISTORIC_*` bucket, prunes to newest 4,
Class A ≥50% budget guard, silent no-op without creds. Branch `monet/r2-cold-snapshot`.
Rollout: `docs/rollouts/2026-08-08-r2-cold-snapshot.md`.

## Current (2026-08-08 GROK — settings ntfy label)

**Settings → Delivery:** first channel renamed **ntfy.sh** (was "Phone push"); removed "recommended · free" badge. Branch `grok/settings-ntfy-label`.

## Current (2026-08-07) — docs / GitHub surface refresh

**README + `docs/deployment.md` + strategic-framework + GitHub About** brought in line with
supported brokers (**Alpaca**, **Tradier**, **Robinhood**), Hetzner Coolify host, app uuid
`socratic-app`, dockerfile + auto-deploy on main, no Test-mode/local sim, fleet UI copy pointer.
Branch `grok/docs-github-refresh`.

---

## Current (2026-08-06 MONET representation-weighted model rotation)

**"__rotate__" now samples representation-weighted instead of round-robin** (owner request:
underrepresented models 2x as likely as overrepresented, which can still be picked). Weights come
from the rotation's own committed `model_rotation_pick` audits (30d window, per user/account/seat;
below-median or zero-usage = weight 2, else 1); commit-late + same-model guarantee + fail-closed
behavior unchanged; injectable RNG for deterministic tests. Branch `monet/rotation-weighted`
(committed, NOT yet pushed — landing operator runs the full gate + `land.sh`). Rollout:
`docs/rollouts/2026-08-06-rotation-representation-weighted.md`.

## Current (2026-08-06 MONET full-product review + deploy-freeze repair)
## Current (2026-08-07 GROK — iOS login brand parity)

**iOS login restyled to match website** (`app/login/page.tsx`): candlestick "SOCRATIC TRADE" wordmark (`CandleWordmarkView`, port of `candle-ticker.ts`), accent-dot value bullets, plain `--bg` surface, Google/GitHub/Apple button order and styles. PR [#2574](https://github.com/jaywedgeworth22/Socratic.Trade/pull/2574) (branch `grok/ios-login-brand`, auto-merge armed). `xcodebuild` BUILD SUCCEEDED. Rollout: `docs/rollouts/2026-08-07-ios-login-brand.md`.

## Prior (2026-08-06 MONET full-product review + deploy-freeze repair)


## Production host (2026-08-07)

**Hetzner** `167.233.254.55` (Coolify + all apps). ST live with L9 repaired DB. CT/UM live on fresh schema. See `docs/rollouts/2026-08-07-hetzner-fleet-cutover.md`.

**MONET (this seat; posts earlier today were tagged CLAUDE before the owner re-ruled the seat) ran the owner-requested full-product review** (live signed-in prod session +
12-agent workflow): findings in `docs/reviews/2026-08-06-claude-full-product-review.md`,
handoff in `docs/rollouts/2026-08-06-claude-full-product-review.md`, issues labeled
`product-review-2026-08-06`. Highest-urgency discoveries:

- **Deploy freeze (P0): all five 2026-08-06 deploys failed** — Coolify's SSH exec stream
  dies mid-build (exit 255, "disconnected by user"), correlated with CT OCR load on the
  shared box; prod sat on `6b47a886` while main advanced 4 merges. Zombie helper
  `onlrw5mgf4s2pw9he4udt2kg` (13.5h) removed; webhook redelivered; retry on a quiet box
  progressed past every earlier failure point (see rollout note for final status).
- **Litestream→R2 was PAUSED (P0)** since Aug 4 (free-tier kill-switch). **Superseded
  2026-08-07 GROK:** active replica → **Backblaze B2** (see Current header); R2 left
  historic. Cross-app R2 free-tier noise may still alert but must not stop B2 backups.
- **Results page shows +56.47% vs SPY on a flat account (P1)** — phantom inferred
  $36.5k withdrawal + SPY series silently 0.00% everywhere; and the tax open-lots ledger
  contradicts live positions (T long 91 sh vs actual short −1.881). Overlaps GROK's
  `grok/fix-account-return-pct`.
- **Two unmanaged shorts (P1)**: PG/T shorts sit unprotected because every enforcement
  layer skips shorts while `shortSellingEnabled` is off (`app/console/lib/derive.ts`).
- **Shared-package drift (P1)**: manifest pins `congress-trading-shared#v2.5.1`, lockfile
  ships 2.5.0 — the filingDate member-skill dependency is not actually deployed.

## Current (2026-08-06 GROK user source settings)
## Current (2026-08-06 GROK — iOS login 522 / Oracle host down)

**iOS Sign-In failures (Apple 522 banner; Google/GitHub CF interstitial) are a production origin outage, not OAuth wiring.** UptimeRobot + curl confirm Cloudflare **522** on socratictrade.com / congress.trade / usage.jays.services / host.jays.services; Tailscale `usage-monitor-oracle` offline; public IP no ping; OCI API keys 401 so agents cannot SOFTRESET. **Owner action: OCI Console reboot in us-phoenix-1.** Branch `grok/ios-login-522-and-anchor`: iOS 26 `ASPresentationAnchor` deprecation fix + clearer 521–523 error copy. Rollout: `docs/rollouts/2026-08-06-ios-login-522-oracle-down.md`.

## Prior (2026-08-06 GROK user source settings)

**Per-user source knobs + FMP toggles restored; plan tiers for all market-data sources (branch `grok/plan-tiers-all-sources`).** Rollouts: `docs/rollouts/2026-08-06-user-source-settings-ui.md`, `docs/rollouts/2026-08-06-plan-tiers-all-data-sources.md`.

## 2026-08-05 GROK — multi-period TWR

## 2026-07-06 — Learned-context copy fix + browse/delete archive (CLAUDE, `agent/claude`)
Owner flagged awkward empty-state copy on the Learned Context approval queue and asked why the AI
doesn't auto-learn and let the user review/delete afterward. Answer: it mostly already does — the
`fact` tier is silent passthrough, never queued; only `risk`/`strategy-directive` (numeric limits,
sizing, leverage, authority) confirms first, and that's deliberate (ingested-document/inference
safety, not paternalism — see `docs/chat-multiuser-learning-design.md`). What was genuinely
missing: the "browse + delete what was silently learned" surface the design doc promised but never
built. Shipped both: reworded the empty-state copy; added `deleteLearnedContext` (ownership-scoped,
also the shared-contribution erasure path) in `src/lib/db-learning.ts`, new `GET
/api/learned-context` + `DELETE /api/learned-context/[id]` routes, client helpers, and a new
collapsed-by-default `LearnedFactsArchive` browse/delete component in
`app/console/approvals/learned-context.tsx` wired into the approvals page. New
`test/learned-context-delete.test.ts` (7 tests: ownership isolation, foreign-user 404, shared-row
erasure, audit trail, superseded-row exclusion). 8-angle adversarial review found no
correctness/security bugs (two correctness-adjacent candidates investigated and refuted with
concrete evidence — see rollout note). Branch had drifted far behind `origin/main`
(Coolify/Hetzner migration, mobile fixes, RAG/sizing/prompt-safety work); merged by hand after
reviewing every flagged overlap, re-verified full quartet on the merged tree: tsc clean, lint 0
errors, 283 files / 2843 tests green, build clean. **Merged as PR #998** (`1c0c20d3`).
**Deployed to production** 2026-07-06 21:30:29Z via `~/apps/trading-publish.sh` — verified
`/api/health` 200, `pm2 trading` stable (0 unstable restarts post-deploy), and the new
`/api/learned-context` route live (401 unauthenticated, not 404/500, confirming it shipped). See
`docs/rollouts/2026-07-06-learned-context-archive.md`.

erasure, audit trail, superseded-row exclusion). Full suite 258 files / 2518 tests green, tsc
clean, lint 0 errors. Owner asked for production release this pass — see PR/deploy details below
once landed. See `docs/rollouts/2026-07-06-learned-context-archive.md`.
## 2026-07-06 — Mobile console width overflow fix (PR open)
- **2026-08-05 — GROK — IN PROGRESS — Multi-period TWR: split at each deposit/withdrawal, chain account+SPY sub-period returns (branch `grok/twr-subperiod-spy-chain`).** Owner: $100 for 10d then $10 for 100d must be separate regimes geometrically linked.

## Active (GROK 2026-08-06)

- **Plan-tier research** (`grok/plan-tier-research`): correcting Connections quota maps from live vendor docs (ROIC 5/min free, Twelve Grow floor 55, Marketstack monthly, AV premium ladder). Rollout: `docs/rollouts/2026-08-06-plan-tier-research.md`. Owner: do not invent limits — re-verify on site.

## 2026-08-05 GROK — account return % fix

- **2026-08-05 — GROK — IN PROGRESS — Fix inflated account % return (synthetic paper curve + live tip TWR; isAllCash cash-first; capital-weighted closed-lot return).** Branch `grok/fix-account-return-pct`. Owner: Sandbox/Alpaca Paper/etc showed ~+50% despite ~$100k start and slight drawdown.

## Current (2026-08-06 GROK provider-neutral data sources + ROIC)

**Settings Data sources card (no FMP-special toggles); ROIC key+tier+fixed transcript API (branch `grok/roic-provider-tiers`).**
Connections: plan tiers for market data; ROIC free/starter/individual/professional quotas; env-key plan tier without re-paste; v3 earnings-calls fetch. Rollout: `docs/rollouts/2026-08-06-provider-neutral-data-sources-ui.md`.

## Current (2026-08-05 GROK multi-source RAG)

**Earnings transcripts + SEC full bodies + trade highlights in RAG (branch `grok/rag-multi-source-ingest`).**
Full 8-K/10-K/10-Q/earnings-transcript stay native; extractive `document-summary` /
`earnings-summary` abstracts for LLM proposal use; routing + coverage expanded; Infisical
8-K full-body + EarningsCalls daily knobs on. Rollout: `docs/rollouts/2026-08-05-rag-multi-source-ingest.md`.
## Current (2026-08-05 GROK API key plan tiers)

**Plan-tier dropdowns on Connections API keys (branch `grok/data-sources-overhaul`).** Optional market-data keys declare free/power/starter/…; persist `user_api_keys.plan_tier` (v70); `provider-tier-plan.ts` → `resolveProviderQuota` when env knobs unset; FMP marked Retired · CT-only. Rollout: `docs/rollouts/2026-08-05-api-key-plan-tiers.md`.

## Current (2026-08-05 GROK FMP/Quiver health OFF)

**FMP/Quiver intentional OFF on admin Connections + FMP policy defaults false (branch `grok/data-sources-overhaul`).** Retired vendors show muted OFF chip (not red STOPPED), excluded from stopped/degraded counts; DEFAULT_POLICY fmp* toggles false; Settings FMP card retired→Congress.Trade; keys POST rejects FMP. Rollout: `docs/rollouts/2026-08-05-fmp-quiver-health-off.md`.

## Current (2026-08-05 GROK provenance stamps)

**Provenance completeness on scan/cache/history (branch `grok/data-sources-overhaul`).** Cascade stamps sharesOutstanding+headlines; mergeQuoteData/bar fieldObservations; OHLC + history_cache_eod.source (v71); macro fieldSources; calendar observations. Rollout: `docs/rollouts/2026-08-05-provenance-stamps-completeness.md`.


**2026-08-05 — GROK team: data sources overhaul (IN PR).** Capability matrix + ROIC transcript scheduler; FMP/Quiver health OFF; soft expected-limit health; plan-tier key dropdowns; provenance stamps; CT FMP latency family OFF grey (Congress.Trade #1417). Branch `grok/data-sources-overhaul`. Rollouts under `docs/rollouts/2026-08-05-*-*.md` + umbrella `data-sources-overhaul`.

## Current (2026-08-05 GROK You're set card center)

**Collapsed readiness card vertical center (branch `grok/youre-set-card-vertical-center`).** Closed collapsible cards get balanced header padding + min-height so "YOU'RE SET" sits centered. Rollout: `docs/rollouts/2026-08-05-youre-set-card-vertical-center.md`.
## Current (2026-08-05 GROK mobile tab bar chrome gap)

**Mobile tab bar: close 80% of Safari chrome gap + continuous surface (branch `grok/mobile-tabbar-gap-and-chrome-bg`).** Measure gap above floating URL chrome; shift `.con-tabbar` down 80%; solid surface underlay for remaining gap + under translucent chrome so colder `--con-bg` no longer flashes around the address bar. Rollout: `docs/rollouts/2026-08-05-mobile-tabbar-chrome-gap.md`.

## Current (2026-08-05 GROK symbol-field-store)

**Durable shared `symbol_field_latest` (branch `grok/symbol-field-store`).** Per-field `as_of` + `fetched_at` for every market field on every symbol ever seen; cascade and scan write; interactive scan seeds from store so strategy_run audit bounding no longer blanks PE/EPS/div. Rollout: `docs/rollouts/2026-08-05-symbol-field-latest-store.md`.

## 2026-08-05 GROK — issues/effort sweep
- Open PRs armed: #2489 (P2.7/P2.8), #2445 (iOS SSE), #2443 (Tradier quotes).
- Residual branch `grok/issues-activity-audit-residual`: B4 Settings TOC + congress-share IfDue single-flight + evidence_age (id,timestamp) dedup + board hygiene.
- Confirmed already on main: #2459 batch, Coach→Insights, safeTopCandidates, most activity-audit P2/P3.

## 2026-08-05 GROK — P0 security residual tranche

- **P0-5** decryptValue rejects plaintext; OAuth legacy path gated by isEncryptedValue.
- **P0-4** audit hash chain schema v67 + verifyAuditChain.
- Confirmed already on main: P0-1/2/3, P1-1..7 mechanical.
- Branch `grok/p0-security-p1-mechanical`.

**2026-08-04 — GROK: Tradier Sandbox venue-aligned quotes (branch `grok/tradier-sandbox-venue-quotes`).**
Paper Tradier keeps ~15m delayed sandbox quotes as execution-authoritative (no fresher Alpaca/Yahoo
overlay); staleness ages `fetchedAt` not trade-time delay. Alpaca paper stays real-time cascade.
Rollout: `docs/rollouts/2026-08-04-tradier-sandbox-venue-quotes.md`.

## Current (2026-08-05 GROK closeout)

- Merged #2488 #2459 #2489 #2445 #2443. Closed issues #838 #837 #1319 #1320 #1321 #1322.
## Current (2026-08-05 GROK)

**2026-08-05 — GROK: issue batch #838/#837/#1319 (branch `grok/issues-batch-prompt-evidence`).**
Prompt fencing on outcome post-mortem + reflection LLM; headline first-seen v66 for
evidence-age receipts; approval-path HTTP 4xx → rejected_by_broker. Also unstuck PRs
#2443/#2444/#2445. Rollout: `docs/rollouts/2026-08-05-issues-prompt-safety-headline-placement.md`.

**2026-08-04 — GROK: auto-pause strategy when broker cannot place orders (branch `grok/auto-pause-unplaceable-broker`).** If order path is down (Tradier OMS 500s, Alpaca trading_blocked, infra place failures, unfunded), flip `systemState` to `halted` with auto-resume marker so cadence stops burning LLM on unplaceable proposals; recover when probe healthy. Rollout: `docs/rollouts/2026-08-04-auto-pause-unplaceable-broker.md`.
**2026-08-04 — GROK: expert panel UX — Run once single primary (PR-A6).** Branch `grok/ux-expert-review-dup-run-once`. Owner: two Run once within ~1 inch. Four-expert review of web+iOS; chrome/home owns one primary; removed cadence/readiness/Guardrails/Insights duplicates; Zap icon; Approve live always labeled; iOS LIVE/PAPER + tappable attention. Review: `docs/reviews/2026-08-04-expert-panel-web-ios-ux.md`. Rollout: `docs/rollouts/2026-08-04-ux-run-once-single-primary.md`.

**2026-08-04 — GROK: iOS Sign-In constraint + SSE events (-1017).** Branch `grok/ios-constraint-and-sse-fix`. Cap Apple Sign-In button at 375pt; dedicated SSE request (`Accept: text/event-stream`, 120s idle timeout); quiet reconnect when snapshot already loaded. AG's 2026-08-03 constraint fix never reached main — lands here. Rollout: `docs/rollouts/2026-08-04-ios-signin-constraint-and-sse-events.md`.


## Current (2026-08-05 GROK activity-audit)

- P2.7/P2.8: multi-poll cancel settle + `protective_exit_failing` notification (branch `grok/activity-audit-p2-7-8`, issues #1320/#1321). Rollout: `docs/rollouts/2026-08-05-activity-audit-p2-7-8.md`.
- Unstuck phantom-conflict open PRs #2459 #2445 #2443 (merge main + re-arm auto-merge; CI re-running).
## Current (2026-08-05 GROK)

- Framework proposals: all 3 prod rows set to **rejected** after agent review (PG/T hard accounting gates; BAC unfilled red-team override). UI reopen/change-of-mind on branch `grok/framework-proposal-review`. Rollout: `docs/rollouts/2026-08-05-framework-proposal-review-reopen.md`.
## Current (2026-08-04 GROK)

- iOS TestFlight agent ship: `bash scripts/ios-ship-testflight.sh` (fleet README `/Users/jay/apps/ios-fleet/README.md`).

**2026-08-04 — GROK: UX Wave B IA (B1/B2/B4) — PR #2425.** Branch `grok/ux-wave-b-ia`.
Plain nav labels Home/Scan/Activity/Results/Macro via `DESTINATIONS` + `destinationLabel`;
Guardrails Autonomy panel (`#autonomy`) with run state/authority/cadence/readiness + chrome Run
controls; Settings sticky TOC. B3 via #2426 on main; no policy defaults; A4 `defaultOpen={false}`
preserved. Supersedes #2413/#2419. Rollout: `docs/rollouts/2026-08-04-ux-wave-b-ia.md`.
**2026-08-04 — UX PR-A2 approval density (GROK, branch `grok/ux-a2-approval-density`).** Approval cards default collapsed (side/symbol/size, Live/Paper, AI-critic chip, 2–3 line thesis); "Show full reasoning" restores full receipt; sticky mobile Approve/Reject above tab bar. No approve-API changes. Rollout: `docs/rollouts/2026-08-04-ux-a2-approval-density.md`.
**2026-08-04 — GROK: UX PR-B1 plain nav labels (branch `grok/ux-b1-plain-nav`).** Owner D2:
Thesis→Home, Evidence→Scan, Journal→Activity, Outcomes→Results, Regime→Macro. `desc`
tooltips keep metaphor; home CTAs use `destinationLabel`; mobile pins already by href.
Rollout: `docs/rollouts/2026-08-04-ux-b1-plain-nav-labels.md`.
**2026-08-04 — GROK: retire direct FMP / QuiverQuant / Unusual Whales.** Owner:
Socratic.Trade must not call those vendors. Congressional disclosures/analytics from
Congress.Trade (default ON); **fundamentals from multi-source cascade** (Yahoo/Finnhub/
ROIC/SEC/… — App A fundamentals default OFF). Hard ban at registration + request choke
points. Branch `grok/no-direct-fmp-quiver-uw` (PR #2398).
Rollout: `docs/rollouts/2026-08-04-retire-direct-fmp-quiver-uw.md`.

**2026-08-04 — Final Verification of Model Slugs (AG).** Branch `agent/antigravity/openrouter-classifiers`. Replaced all legacy `-latest` model slugs with Provider Native Slugs (`gpt-5.6-sol`, `gpt-4o`, etc.) across the codebase. Cleaned up duplicate properties in model configuration files. Fixed test regressions in history tests by adding DB isolation to `historyTestDb` shared per-file. Fixed `isGpt56Model` regex. Gates verified: tsc clean, lint clean, full test suite passes. Landed cleanly via `land.sh`.
Rollout: `docs/rollouts/2026-08-04-model-slug-test-fixes.md`.

**2026-08-04 — GROK: UX PR-A4 + PR-A5 (guardrails Advanced collapsed + PWA Proposals noun).**
PR #2411, branch `grok/ux-a4-a5-quick`, auto-merge armed. Advanced rulebook `defaultOpen={false}`; Essentials open; PWA
heading Approvals → Proposals. Display-only. lint+tsc clean. Rollout:
`docs/rollouts/2026-08-04-ux-a4-a5-guardrails-nouns.md`.


# STATUS — current repo snapshot

**2026-08-04 — GROK: Congress filing-date member skill → ST.** Prefer CT `filingDate`
copy-trade skill (shared package v2.5.0 dual performance); restore `memberSkill` weight
0.2; persist raw avgExcess/winRate/scoredCount on quotes + signal_snapshot. Branch
`grok/congress-filing-skill`. Rollout:
`docs/rollouts/2026-08-04-congress-filing-member-skill.md`.
**2026-08-04 — GROK: quote cascade freshness + never block on stale.** Cascade accept = maxQuoteAgeSec (120s) so ~15m delayed feeds no longer stop the cascade; if still stale, convert opening to limit at proposal.referencePrice (never block/escalate). Branch `grok/fix-quote-freshness`.

**2026-08-04 — GROK: UX B3+E2+E3 polish (branch `grok/ux-b3-e-polish`).** Strategy page collapsible sections (Models + Instructions open; Scoring weights collapsed; Presets open). Login page three value bullets matching iOS. Command palette trigger always visible on mobile chrome (icon-only below sm). Healthy mobile freshness collapses to one line. No policy changes. Rollout: `docs/rollouts/2026-08-04-ux-b3-e-polish.md`.


**2026-08-04 — GROK: retire direct FMP/Quiver/UW; fundamentals multi-source.** Hard ban
on direct FMP/Quiver/UW. Congress.Trade for disclosures/analytics (default ON);
fundamentals from the multi-provider cascade (App A fundamentals default OFF). PR #2398.
**2026-08-05 — iOS Light App Icon Sync (ANTIGRAVITY, branch `agent/antigravity`).** Replaced the canvas-drawn `icon.svg` with the iOS App Icon (PNG) across `public/icon.png`, `public/icons/icon-192.png`, `public/icons/icon-512.png`, and `public/icons/apple-touch-icon-180.png`. Updated `app/manifest.ts` and `app/layout.tsx` to serve the static PNGs instead of the SVG to fix visual glitches/inconsistencies. Rollout: `docs/rollouts/2026-08-05-ios-light-app-icon-sync.md`.

Rollout: `docs/rollouts/2026-08-04-retire-direct-fmp-quiver-uw.md`.
**2026-08-04 — Full-Bleed Pure White App Icon Assets (ANTIGRAVITY, branch `agent/antigravity`).** Updated `public/icon.svg` canvas to 100% full-bleed white background (`#ffffff` without transparent corners), updated `app/manifest.ts` PWA `background_color`/`theme_color` to `#ffffff`, and regenerated all PNG icons (`apple-touch-icon-180.png`, `icon-192.png`, `icon-512.png`, and iOS Xcode `AppIcon-1024.png`). Verified `tsc` clean and asset rendering. Rollout: `docs/rollouts/2026-08-04-full-bleed-white-app-icon.md`.

**2026-08-04 — GROK: PR drain complete; prod deploy unblocked via slim Dockerfile.** Merged open PRs #2367-#2371, #2375, #2381. Prod stuck on 6ad913d5 because Coolify timed out on multi-GB `COPY --chown`. Fix: `.dockerignore` + prune + chown-in-RUN (`grok/docker-slim-deploy`). Rollout: `docs/rollouts/2026-08-04-docker-slim-deploy.md`.

**2026-08-04 — GROK: paper-account learning parity (Learning Review).** Owner: paper
trades are first-class for model/task comparison unless a definite paper-exclusive
cause applies. Prompt rule + portfolio-scoped decision lessons + environment on review
items. Branch `grok/paper-learning-parity`. Rollout:
`docs/rollouts/2026-08-04-paper-learning-parity.md`.

**2026-08-04 — GROK: deploy 178 failed (missing better-sqlite3 .node); fixing native rebuild.**
PRs drained; slim image builds (1.45GB) but healthcheck 500: `better_sqlite3.node` missing after
`npm rebuild` no-op post-prune. Branch `grok/docker-sqlite-native`: prune --ignore-scripts,
global node-gyp, clean rebuild, assert load. Prod still on 6ad913d5 (healthy). Rollout:
`docs/rollouts/2026-08-04-docker-sqlite-native.md`.

2026-08-01 were moved to `docs/status-archive.md`.

Last updated: 2026-08-05 (GROK: UX program Waves A–E complete).
Last updated: 2026-08-04 (GROK: UX Wave C speed C1–C4).
Last updated: 2026-08-04 (GROK: UX Wave B IA landing).
Last updated: 2026-08-04 (GROK: UX PR-A3 first-run readiness checklist — PR #2417).
Last updated: 2026-08-04 (GROK: UX Wave D mobile/iOS/PWA).

**2026-08-04 — GROK: UX Wave D mobile/iOS/PWA parity (branch `grok/ux-wave-d-mobile`).**
D1 brand teal `#12616f` / dark `#58c7d3`; D2 Home readiness checklist + ready hero with
Review→Proposals tab switch; D3 per-proposal command feedback (iOS MobileStore + ProposalsView,
PWA card strip); D4 humanized command labels, Ask-first/Autopilot, Proposals section title,
control-remote framing. Rollout: `docs/rollouts/2026-08-04-ux-wave-d-mobile.md`.


## UX Wave C speed (2026-08-04, GROK)

**IN PR** branch `grok/ux-wave-c-speed`. C1 snapshot TTL cache (userId×accountNumber, 10s,
invalidate on policy/approve/reject); C2 FIFO `calculatePnl` once + PrefetchedPnl to
scorecards/tax; C3 scan `TableVirtuoso`; C4 `React.memo` leaves + home `useMemo` derives.
Rollout: `docs/rollouts/2026-08-04-ux-wave-c-speed.md`. Program:
`docs/design/ux-improvement-program.md` §Wave C.

## UX improvement program (2026-08-04, GROK)

Sequenced PR plan: `docs/design/ux-improvement-program.md`.
**PR-A1 honest skip statuses** — IN PR #2418 (`grok/ux-a1-honest-skips`): granular
`skipped_budget` / `skipped_market_closed` / `skipped_broker_unhealthy`; Thesis/Activity
chips; liveness/auto-tune honesty. Rollout: `docs/rollouts/2026-08-04-ux-a1-honest-skips.md`.
PR-0: `docs/rollouts/2026-08-04-ux-improvement-program.md`.
Sequenced PR plan: `docs/design/ux-improvement-program.md`. **Wave B IA** (B1 plain labels,
B2 Autonomy panel, B4 Settings TOC) on branch `grok/ux-wave-b-ia` — rollout
`docs/rollouts/2026-08-04-ux-wave-b-ia.md`. Wave A slices remain claimable. Program rollout:
`docs/rollouts/2026-08-04-ux-improvement-program.md`.
Sequenced PR plan for web console + PWA + iOS after a full-product review:
`docs/design/ux-improvement-program.md`. Wave A/B/C/D slices claimed by implementer
fleet — coordinate via effort board. Rollout:
`docs/rollouts/2026-08-04-ux-improvement-program.md`.
`docs/design/ux-improvement-program.md`. **PR-A3 first-run checklist IN PR**
(`grok/ux-a3-checklist` / #2417 — `deriveReadinessChecklist` + Thesis hero).
Program rollout: `docs/rollouts/2026-08-04-ux-improvement-program.md`. A3 rollout:
`docs/rollouts/2026-08-04-ux-a3-first-run-checklist.md`.
`docs/design/ux-improvement-program.md`. Wave D (mobile/iOS/PWA) implemented on
`grok/ux-wave-d-mobile`. Remaining A/B/C slices stay Planned/UNASSIGNED until claimed.
Rollouts: `docs/rollouts/2026-08-04-ux-improvement-program.md`,
`docs/rollouts/2026-08-04-ux-wave-d-mobile.md`.


## UX program complete (2026-08-05, GROK)

All sequenced UX waves A–E from `docs/design/ux-improvement-program.md` are **merged to main** (auto-deploy). Key PRs: #2411 A4+A5, #2413 B1, #2414 A2, #2417 A3, #2418 A1, #2423 C, #2424/#2431 D, #2425 B2/B4, #2426 B3+E. Rollout: `docs/rollouts/2026-08-05-ux-program-complete.md`. Deferred: E1 empty-state system, unauth apex→welcome.

## Where things stand

**2026-08-04 — Multi-Source Quote Cascade & Staleness Resolution (ANTIGRAVITY).** Implemented a 5-level redundant quote cascade resolving active broker gateway → Alpaca snapshots → Yahoo batch → Yahoo single → ROIC.ai profile. Converted the quote staleness policy check into a non-blocking gate that mutates opening orders to limit orders to defend the price (buy capped at min(limit, ref), short capped at max(limit, ref)), appends warning text to rationale, writes a `quote_staleness_warn` audit trail, and alerts the user via `provider_degraded` push. Full tests and builds check out clean. Rollouts: `docs/rollouts/2026-08-04-multi-source-quote-cascade.md`, `docs/rollouts/2026-08-04-non-blocking-quote-staleness-gate.md`.
**2026-08-04 — Multi-Source Quote Cascade & Staleness Resolution (ANTIGRAVITY).** Added a redundant multi-source quote cascade in `src/lib/quotes-cascade.ts` checking broker quotes, Alpaca snapshots, Yahoo batch, and Yahoo single quote APIs in series. Integrated it across the strategy run loop, proposal approvals, and chat draft promotion. Added a unit test suite to verify the cascade level routing. Full type check and lints pass. Rollout: `docs/rollouts/2026-08-04-multi-source-quote-cascade.md`.

**2026-08-04 — EOD Quote History Cache SQLite Migration (ANTIGRAVITY).** Migrated the legacy flat-file JSON EOD quote caching (`data/history-5y/`, etc.) in `src/lib/history.ts` to a fully SQLite-backed table `history_cache_eod` to resolve test failures and ensure robust silent-caching. Replaced `fetchLocalFlatFileHistory` with `fetchHistoryCacheEod`. Updated the `test/history.test.ts` suite to seed the SQLite DB directly. Full tests pass. Rollout: `docs/rollouts/2026-08-04-history-cache-eod-migration.md`.

**2026-08-03 — Subdomain Host Routing & EOD Quote Caching Upgrade (ANTIGRAVITY, branch `agent/antigravity`).** Added `mobile.socratictrade.com` $\rightarrow$ `/mobile` and `console.socratictrade.com` $\rightarrow$ `/console` host-level routing in `middleware.ts`. Upgraded EOD price history in `src/lib/history.ts`: added `isBarSeriesFresh` staleness detection, `mergeOHLCBars` merging for stale flat files, auto-persistence of fresh provider bars into SQLite `imported_price_eod` and disk, and `eod_cache_stale` audit logging. All gates green (`tsc`, `lint`, vitest 27/27, Next.js `build`). Rollout: `docs/rollouts/2026-08-03-eod-quote-caching-and-subdomain-routing.md`.

**2026-08-03 — iOS/mobile account switch hangs (MONET, branch `monet/ios-account-switch-fix`).**
Owner screenshots: Roth IRA spinner stuck, Sandbox still Active, Home stale + 2 queued · 1
running. Root cause: `account.activate` waited on the global sequential mobile worker behind
`strategy.run_once`, and clients also blocked switch when the snapshot was stale. Fix: run
`account.activate` immediately (same path as stop), allow switch on stale snapshot (iOS + PWA),
clear iOS busy spinner from the terminal POST before snapshot reload. Focused mobile tests
16/16; full gates via land.sh. Rollout:
`docs/rollouts/2026-08-03-ios-account-switch-immediate.md`.
**2026-08-03 — Console RAG Evidence Card Deduplication (ANTIGRAVITY, branch `agent/antigravity/mobile-pwa-feedback`).** Fixed duplicate RAG evidence rendering (`sec-edgar` and `Retrieved 10 K` cards showing identical document receipt & score) in proposal drawer by deduplicating RAG attributions against `decision.evidence` in `deriveEvidenceRows` (`app/console/page.tsx`). Rollout: `docs/rollouts/2026-08-03-dedupe-evidence-cards.md`.

**2026-08-03 — Console dashboard `topCandidates.slice` white-screen (GROK, branch
`agent/grok-fix-dashboard-topcandidates`).** Owner report: main `/console` showed
`Dashboard error` / `undefined is not an object (evaluating 'r.topCandidates.slice')`.
Root cause: `deriveEvidenceRows` assumed every truthy `latestScan` had array
`topCandidates`. Fix: `safeTopCandidates` + snapshot normalization in `dashboard.ts`.
Rollout: `docs/rollouts/2026-08-03-console-topcandidates-slice-crash.md`.

**2026-08-03 — Xcode App Settings & Apple Sign-In Layout Constraint Fix (ANTIGRAVITY).** Configured Xcode App Category (`public.app-category.finance`), Display Name (`Socratic.Trade`), Marketing Version (`1.0.0`), and Build Version (`1`) across `Info.plist` and `project.pbxproj`. Fixed `ASAuthorizationAppleIDButton` layout constraint collision warning (`width == 392` vs `width <= 375`) in `LoginView.swift` by capping `SignInWithAppleButton` width to 375pt. `xcodebuild` succeeded clean. Rollout: `docs/rollouts/2026-08-03-xcode-app-settings-and-apple-signin-constraint-fix.md`.

**2026-08-02 — Exit-0 outage root-caused + exit-code hardening (MONET, branch
`monet/exit0-outage-audit`).** The 15:29Z "clean exit 0, stayed down" outage was an
**unpaired docker-API stop**, with the 0 fabricated by a pid-1 signal-re-raise bug in the
infisical wrappers plus in-container npm swallowing SIGTERM (sandbox-reproduced in the
real image; every deploy had been hard-killing next-server). Fixed: wrappers exit 128+N,
boot script now supervises the app (spontaneous clean exit → 40, every exit logged,
`node_modules/.bin/next start` direct — npm banned from the exec chain), new
production-gated `src/lib/exit-guard.ts` re-tags spontaneous in-app exit(0) → 43 with
call-site receipts. Restart policy is already `unless-stopped` — evaluated, **no flip**
(it restarts any spontaneous exit; the outage class is API stops, now covered by rule +
honest codes). `docker events` forensics verified broken (~256-event ring ≈ minutes on
this box) — journalctl is the durable source. Contract + traps codified in AGENTS.md
("Production exit-code contract"). Rollout:
`docs/rollouts/2026-08-02-exit0-outage-audit.md`. Next prod stop/deploy should log
`app exited with code 143 after forwarded SIGTERM` as live confirmation.

**2026-08-02 — 5-Year Local Flat-File Price History Priority (ANTIGRAVITY).** Added `fetchLocalFlatFileHistory(symbol)` as the #1 primary tier in `src/lib/history.ts` (`fetchDailyOHLC`) and `fetchGroupedBarsLocal(date)` in `src/lib/market-signals/massive.ts`. Any pre-hoarded 5-year Massive flat files (`data/history-5y/`, `data/massive-history/`) are read directly from disk without hitting external REST APIs, providing instant zero-cost history for backtests and Congress.Trade EOD price feeds (`/api/market/prices/[symbol]`, `/api/market/spx`). Rollout: `docs/rollouts/2026-08-02-local-flatfile-history-priority.md`.

**2026-08-02 — Mobile PWA owner-feedback round (Monet, cloud session).** Branch
`agent/antigravity/mobile-pwa-feedback` (applying patch from Monet): PWA gets
an Accounts section (switch broker account via `account.activate`, sign-out link to switch Google/Apple
login), per-proposal realtime approve/reject feedback (tapped button spins; card follows its queued
command through queued/running/succeeded/failed instead of failures hiding in the Command Log), and the
delete-account panel is collapsed behind a neutral link so it stops mimicking error banners. tsc clean,
mobile test file 10/10, lint 0 errors. Landed as #2351 (`44069368`).
Rollout: `docs/rollouts/2026-08-02-mobile-pwa-owner-feedback.md`.

**2026-08-02 — Data-provider hardening, Round 1 (MONET, `monet/data-cascade-freshness`,
merged as #2353).** Implemented the free-tier research doc's own recommendations: Tiingo
now ALSO an OHLC-history source in `history.ts` (was enrichment-only — a configured key
delivered none of the promised adjusted-history value until this landed), dead Stooq tier
removed (confirmed PoW-bot-walled), keyless Treasury.gov yield-curve fallback (3M/2Y/10Y +
curves, no FRED key needed), Cboe VIX9D, SEC-XBRL `revenueGrowth`. Full gates green.
Rollout: `docs/rollouts/2026-08-02-data-provider-hardening.md`.

**2026-08-02 — Data-provider hardening, Round 2/3 (MONET, `monet/data-cascade-providers-round2`).**
Closes out the rest of the same research doc: 3 new key-gated fundamentals/news providers
(Wisesheets, SimFin, Marketaux — all dormant until their env key is set), 2 new keyless
sources (BLS macro fallback wired into the Macro board, Nasdaq earnings-calendar backfill),
an S&P 500 constituents mirror (built, not yet wired to replace the static universe list —
see the rollout note), Yahoo 429 hardening, and Alpha Vantage/Finnhub earnings-calendar
fallbacks. USAspending.gov investigated and correctly NOT implemented (no free
recipient→ticker crosswalk exists). Full gates green: lint 0 errors, tsc clean, 5891/5891
tests, build clean. Rollout: `docs/rollouts/2026-08-02-data-provider-round2.md`.

| | |
|---|---|
| `main` | `44069368` — Codex remediation (#2341), npm `allowScripts` fixes (#2345, #2349), mobile PWA feedback round (#2351) |
| In flight (AG) | `agent/ag-ios-throttle` — Automated trailing TestFlight builds (cron + reduced throttle).
| Production (`socratictrade.com`) | `c117afb9` verified live ~05:35Z — SECOND organic cutover since the repair; `b7d88e42` builds next (serialized) |
| Deploy mechanism | auto-deploy on push to `main` — **repaired 2026-08-02** (webhook HMAC secret was mismatched; see blocker 1) |
| Core trading health | DB ok, scheduler ticking, 3 active accounts / 0 degraded. ~~litestream replicating~~ **CORRECTED 2026-08-06 (MONET): litestream→R2 is PAUSED (kill-switch since Aug 4) — no continuous DB backup; owner decision to resume** |
| Data providers | Honesty rule (2026-08-13): `dataProvidersDegraded` only when the probe disagrees with the paid/configured plan or the provider is not working.  Massive `history_cap_blocked` on ~2.5y is healthy when Settings is Stocks Basic.  ~~FMP plan probe 403~~ (stale: FMP retired on ST 2026-08-04). |

## Blockers

1. **RESOLVED 2026-08-02 — auto-deploy was broken by a webhook HMAC mismatch.** Every push
   to `refs/heads/main` was answered by Coolify with
   `[{"status":"failed","message":"Invalid signature."}]` (visible only in the GitHub hook
   delivery RESPONSE BODY — the hook page showed green 200s throughout), so no deployment
   was ever created; the queue sat empty and the single 2026-08-01 deploy was the owner's
   manual click. Repair: synced the GitHub hook secret to the Coolify app's
   `manual_webhook_secret_github`, deleted the exact-duplicate second hook, redelivered the
   newest main push -> a real deployment was created immediately, and
   `scripts/verify-deploy-sha.sh 19dfd51b` reported **PASS** (~04:47Z). Merge==live is
   trustworthy again. Also fixed: AGENTS.md's stale Coolify uuid (the app is `socratic-app`
   now). Full receipts + recurrence warning:
   `docs/rollouts/2026-08-02-deploy-webhook-secret-repair.md`.

2. **RESOLVED — npm `EALLOWSCRIPTS` on the shared git dep (and the earlier explanation
   here was wrong).** A clean-shell reproduction with the repo's exact files PASSES: the
   repo as committed installs fine, and a stale `allowScripts` tag was NOT the trigger.
   The real triggers (npm 11.16.0+, upstream bug npm/cli#9783, open, unfixed through npm
   12.0.2): an `allow-scripts=...` line in ANY `.npmrc` layer, or an inherited
   `npm_config_allow_scripts` env var — npm forwards it into its git-dep preparation
   subprocess, which rejects it as a flag. This Mac had live `npx`-launched processes
   exporting `npm_config_allow_scripts=@wasp.sh/wasp-cli`; any shell descending from that
   lineage fails every `npm ci` instantly. If EALLOWSCRIPTS appears: check
   `env | grep npm_config_allow_scripts` and relaunch the contaminated parent — and NEVER
   add `allow-scripts` to `.npmrc`, even though npm's own error message suggests it.
   Also fixed forward: `allowScripts` git-dep keys in tag form (`#vX.Y.Z`) can never match
   (npm compares against the resolved 40-char SHA), which npm 12 escalates from a warning
   to a hard block on the dep's `prepare` — the key is now committish-free
   (`"github:jaywedgeworth22/congress-trading-shared": true`, verified: coverage warning
   gone). #2345's lockfile regen also fixed a real silent bug: the old lockfile pinned the
   v2.3.0 commit while package.json said v2.4.x, so `npm ci` was silently shipping the old
   shared package. Verified 2026-08-02: plain `npm ci` = exit 0, 575 packages, clean shell.
   (An earlier copy of this blocker blamed a stale `allowScripts` tag — corrected above;
   the union merge briefly duplicated both versions here, de-spliced 2026-08-02.)

3. **Two provider lanes are degraded and need an owner decision, not an agent fix.**
   FMP's plan probe returns 403 (subscription state) and Massive is history-capped to the
   free tier. Agents must not provision replacement keys. Several optional/telemetry lanes
   (Usage Monitor, VIX-Yahoo, Nasdaq Quote, some RapidAPI lanes) are also down; those are
   fallback tiers and the cascade still serves real data.

## Next action

- Watch that `c117afb9` (and subsequent merges) deploy organically via the repaired
  webhook — `bash scripts/verify-deploy-sha.sh` after merging.
- (Retracted: the `schedulerLease.owner` "residual" flagged earlier does not exist — the
  landed code already strips the pid for unauthenticated callers; prod serves the bare
  instance uuid. Observation was made against the pre-deploy payload.)
- Owner decisions pending: FMP subscription, Massive plan tier; and whether hook-secret
  re-sync should be added to the Coolify app-recreate recipe (see the 2026-08-02 rollout
  note — if recreation regenerated the secret, this failure recurs on the next recreate).

## Conventions that bite (do not re-derive these)

- **Board files are `merge=union`.** `.gitattributes` union-merges `STATUS.md`,
  `PLAN.md`, and `docs/EFFORT-LOG.md` so concurrent PRs do not conflict on them. The cost
  is that union **interleaves** both sides instead of conflicting, which silently produces
  duplicated rows and entries spliced under the wrong heading. `docs/EFFORT-LOG.md` had 13
  exact-duplicate blocks from this (deduped 2026-08-01) and `STATUS.md` had one agent's
  notes filed under another's heading (preserved as evidence in `docs/status-archive.md`).
  Keep entries to a single line where you can, and re-read your own row after a merge.
- **Node 24 is required.** The Mac's default `node` is v26 and mass-fails the suite on a
  `export PATH="/opt/homebrew/opt/node@24/bin:$PATH"`.

**2026-08-04 — Model slug migration tests and UI mapping fixes (Antigravity).**
Fixed `gpt-5.4-mini` regex inclusion in reasoning model capabilities which was causing test suite failures under Node 24. Also cleaned up `MODEL_DISPLAY_NAME` in `app/console/lib/models.ts` to strictly follow user-provided slugs, completely removing any legacy `-latest` suffixes. Verified tests locally.

**2026-08-04 — Revert accidental marketScan in from-draft preview (Antigravity).**
Fixed `test/chat-draft-policy.test.ts` test regression. A previous commit accidentally added a `fetchFreshQuotesCascade` call to the preview evaluation in `app/api/proposals/from-draft/route.ts`. Since the mock test broker returns real time quotes, this caused the "scan-less" preview to actually fetch a fresh quote and skip the expected `staleness_gate` block in tests. Reverted the addition so the preview returns to its scan-less state. All 10/10 tests pass, `land.sh` executed.
## Current (2026-08-07 GROK)

- **Fix paper vs-SPY +50%**: deposit+invest sparse snapshots without fills no longer count as alpha (`grok/fix-paper-spy-return-again`).


## Current (2026-08-31 CLAUDE)

- **Qdrant self-host audit landed (board 601d581c):** collection green/801,239 pts, now fully payload-indexed (16 fields), mem 10g, snapshots persist on volume; runbook keyword monitors 803872370-72 now page on schedulerStale/tradingLivenessDegraded/litestreamTiersDegraded.  Pinecone read units exhausted — Qdrant cutover (golden set -> adapter -> shadow-read -> delta copy) is the critical path.  Details: `docs/rollouts/2026-08-31-qdrant-rag-error-ux-audit.md`.

- **Qdrant read cutover stage 1 in flight (2026-08-31 CLAUDE):** reads switchable to self-hosted Qdrant via RAG_VECTOR_READ_QDRANT knob/env; prod flips at deploy (Pinecone read units exhausted — RAG was silently dead).  Writes stay Pinecone until stage 2.  Sep 1: delta copy + sentinel backfill + golden eval per scripts/qdrant/DELTA-RUNBOOK.md.

## 2026-09-09 — [CLAUDE] Healthcheck tolerance for event-loop stalls (PR #3201)

Production served a public 503 while healthy: `/api/live` intermittently took 8.60s against a 5s container healthcheck timeout, so Docker marked the container unhealthy and Traefik stopped routing.  Widened to timeout=15s / retries=5 (detection bound ~225s).

This is MITIGATION.  The root cause is the non-convergent FTS mirror loop fixed in PR #3202; stalls up to 36,511ms were measured, which a 15s timeout still cannot absorb.  Next action: land PR #3202.
