> **2026-09-18 GROK — #3385 sqliteYieldRetry remainder (`grok/3385-sqlite-yield`, board `0e9f0d16`).**  Follow-up to merged #3383.  Wrap scheduler lastTick / managed-vector timestamps / boot setPolicy in `sqliteYieldRetry`; split boot audit and the three synthetic-stop plan-purge delete+audit envelopes.  Heartbeat BUSY-then-success must not abdicate.  Extra-ship no.  Keepout: `broker-protective-stops.ts`, `~/apps/trading-grok-rth-stall`.  Rollout: `docs/rollouts/2026-09-18-3385-sqlite-yield-remainder.md`.
> **2026-09-18 GROK — MM AG takeover #3379 theme CI (board 6aa1e66e).**  `@/app/ui/theme` is not a valid alias.  Relative import; toaster uses resolvedTheme.  Extra-ship no.  No Coolify Deploy.  Rollout: `docs/rollouts/2026-09-18-ag-takeover-theme-ci.md`.
> **2026-09-18 CURSOR — Effort Issues Sync Crons margin (FLEET-INFRA-C0).**  Daily `12 6 * * *` board mirror always succeeds; GitHub starts it 5-6.5h late so the 15-minute Sentry margin pages at 06:27Z.  Same override as #3194 / #3387 / #3389: `CHECKIN_MARGIN_OVERRIDES["Effort Issues Sync"] = 600`.  Cron unchanged.  Extra-ship no.  No Coolify.  Do not resolve C0 on merge — #3302 upserts `ci-socratic-trade-effort-issues-sync`.  Rollout: `docs/rollouts/2026-09-18-effort-issues-sync-monitor-margin.md`.
> **2026-09-18 GROK — MM AG takeover #3378 admin CI (board 6aa1e66e).**  Real hosted failures: wiring marker after layout/shell split, copy-rules lockedTotal 47.  Gap the CPU title; point the test at `admin-shell.tsx`.  Extra-ship no.  No Coolify Deploy.  Rollout: `docs/rollouts/2026-09-18-ag-takeover-admin-ci.md`.
> **2026-09-18 CURSOR — Cleanup Actions Caches Crons margin (FLEET-INFRA-BY).**  Daily `5 3 * * *` prune always succeeds; GitHub starts it 4.5-7h late so the 15-minute Sentry margin pages at 03:20Z.  Same override as #3194 / #3387: `CHECKIN_MARGIN_OVERRIDES["Cleanup Actions Caches"] = 600`.  Cron unchanged.  Extra-ship no.  No Coolify.  Do not resolve BY on merge — #3302 upserts `ci-socratic-trade-cleanup-actions-caches`.  Rollout: `docs/rollouts/2026-09-18-cleanup-actions-caches-monitor-margin.md`.
> **2026-09-17 CURSOR — RTH Deploy Latch Crons margin (FLEET-INFRA-C3).**  Weekday `20 21 * * 1-5` drain always succeeds; GitHub starts it 2-8h late so the 15-minute Sentry margin pages at 21:35Z.  Same override as #3194: `CHECKIN_MARGIN_OVERRIDES["RTH Deploy Latch"] = 600`.  Cron unchanged.  Extra-ship no.  No Coolify.  Do not resolve C3 on merge — #3302 upserts `ci-socratic-trade-rth-deploy-latch`.  Rollout: `docs/rollouts/2026-09-17-rth-deploy-latch-monitor-margin.md`.
> **2026-09-17 CURSOR-BUGBOT — wrap post-claim synthetic-stop fire writes.**  After #3383's 100ms pin, unwrapped `recordSyntheticStopAttempt` (outside try) leaves a claimed stop `triggered` with no `last_attempt_ref_id` on SQLITE_BUSY.  Yield-retry each post-claim write; revert on throw.  Extra-ship no.  No Coolify Deploy.  Rollout: `docs/rollouts/2026-09-17-post-claim-sqlite-busy-fire.md`.
> **2026-09-17 GROK — PR #3383 tip-fix: fake timers vs `yieldEventLoop`.**  Hosted verify timed out because full `vi.useFakeTimers()` swallowed `setImmediate`.  Tests fake `Date` only; `isSqliteBusy` ignores stamped non-BUSY codes.  Pin+yield unchanged.  Extra-ship no.  No Coolify Deploy.  Rollout: `docs/rollouts/2026-09-17-sqlite-busy-event-loop-pin.md`.
> **2026-09-17 GROK — SQLITE_BUSY event-loop pin+yield (`grok/rth-event-loop-stall`, board `e7b49943`).**  Serving-process `better-sqlite3` `busy_timeout=60000` pins the Node event loop on `SQLITE_BUSY`, so health/API stall ~every 30 minutes (Traefik 503; Docker still healthy).  Land the existing WIP: 100ms native pin + `sqliteYieldRetry` (60s budget via yields) + safety-lane yields + RTH RAG deferral.  Extra-ship no.  No Coolify Deploy.  Do not restart production from this lane.  Rollout: `docs/rollouts/2026-09-17-sqlite-busy-event-loop-pin.md`.
> **2026-09-15 GROK — PR #3283 LLM observability resilience land-sweep.**  Implementation of issue #3222 is in this PR: Datadog LLMObs wrap no longer double-invokes on error, Red Team JSON parse failovers, Sentry gen_ai token attrs from a cloned body while the span is open, request-scoped span via AsyncLocalStorage.  Merge is live — no Coolify Deploy.
> **2026-09-15 GROK — Land remaining OPEN ST PRs (`~/apps/trading-grok-land-sweep`, board `c6ee03aa`).**  Squash auto-merge to main; no `--admin`; no Coolify Deploy.  #3282 is the hard lane: real `instrumentation.ts` conflict plus Codex P1s and hosted-test failures from the health-log buffer.  Sibling OPEN PRs: #3296 #3284 #3283 #3281.  Already merged: #3294 #3293 #3292.
> **2026-09-15 GROK — PR #3296 401 JSON still redirects (`grok/3296-401-json` → `ag/issue-3225-console-singleflight-deadline-retry`).**  `readErrorMessage` checks 401 before parsing JSON so session expiry always calls `redirectToLogin()`.  Merge is live — no Coolify Deploy.
> **2026-09-12 ANTIGRAVITY — Full-Stack Codebase Audit & System Diagnostics (`ag/app-analysis-and-improvements`).**  Conducted a comprehensive multi-agent audit across the entire platform.  Identified 3 Critical trading bugs (#3220), 2 Critical console bugs (#3225), 2 Critical AI bugs (#3222), and 5 High/Medium vulnerability & reliability areas (#3221, #3223, #3224, #3226, #3227).  Detailed remediation roadmaps documented in `docs/rollouts/2026-09-12-codebase-full-audit.md` and tracked on the effort ledger.
> **2026-09-10 GROK — PR #3208 tini PID1 / HEALTHCHECK curl self-timeout (`fixer/healthcheck-no-zombies`, board `e7b49943`).**  Traefik 503 `no available server` while Node still answered in-container: hung `curl /api/live` HEALTHCHECK probes SIGKILL'd; `infisical-run` as PID1 did not reap, so zombie curls piled up.  Runtime image installs `tini` as ENTRYPOINT; keep `--timeout=15s --retries=5` and add `curl --max-time 14 --connect-timeout 2`.  Probe stays `/api/live`.  Dockerfile is an image build — Deployer image-deploys after cash close / non-RTH; do not bounce during RTH.  FTS hang is separate #3202.  Extra-ship no.  Do not merge from this tip lane.  Rollout: `docs/rollouts/2026-09-09-healthcheck-tini-reap.md`.
> **2026-09-09 GROK — PR #3194 Deploy-freshness Crons margin: per-workflow 10h tolerance (`claude/fix-deploy-freshness-monitor-margin`).**  Monitoring approach change:  Sentry Crons `checkin_margin` for `Deploy freshness` alone is now 600 min via `CRON_CHECKIN_MARGIN_MINUTES` in `scripts/sentry-ci-report.py` (default 15 min unchanged elsewhere).  GitHub `schedule` delivery for this every-20-minute cron measured ~9.5% over 211h (median gap 210.5 min, max ~8h03m), so the old 15-minute margin false-paged a healthy workflow; 10h sits above observed gaps while still alerting inside the 14h silent-deploy-freeze this watchdog exists to catch.  Workflow crontab unchanged.  Do not resolve FLEET-INFRA-C1 purely on merge — wait for an OK check-in under the new margin.  Extra-ship no.  Do not merge from this tip lane.  Rollout: `docs/rollouts/2026-09-08-ci-deploy-freshness-monitor-margin.md`.

## 2026-09-09 CLAUDE — Safety-lane deadline attribution: the "broker timeout" is event-loop starvation

Branch `claude/broker-timeout-safety-monitors`, worktree `~/apps/trading-claude-brokertimeout`.

The root cause of the `runSyntheticStopMonitor timeout` / `stale-limit-scan broker timeout` family belongs to
**PR #3202**'s non-convergent FTS mirror loop, not to this lane.  This lane therefore ships **attribution only**
and no competing fix.

Evidence: 161,633 ms of a 185,633 ms `stale-limit-scan` elapsed outside all broker I/O (its Alpaca call had
already self-terminated at 24,000 ms); a 196,840 ms `synthetic-stop-monitor` pass finished `ok evaluated=6`;
ms-over-deadline rose 28.6x on 09-08 in step with the event-loop pinning curve while ingest volume did not.
SQLite lock contention was tested and refuted.

Shipped: `src/lib/event-loop-lag.ts` sampler, `withLaneDeadline` attribution in `safety-maintenance.ts`, and an
`event_loop_stall` category in `classifyLaneFailure`.  **No safety monitor weakened** — the deadline is unchanged
at 15,000 ms, no interval was lengthened, protective work is still never cancelled, and failures still escalate
to `lane_degraded`.  Rollout: `docs/rollouts/2026-09-09-safety-lane-stall-attribution.md`.


## 2026-09-09 CODEX — Model catalog refresh and concise account labels

Merged as PR #3196 (`3aa643cacd25688eb6c948f686e4410b834617ff`).  Final hosted run `34338996582` on `9968619e4` passed `npm run lint`, `npx tsc --noEmit`, `npm test` (719 suites / 7,928 tests passed; 1 suite / 51 tests skipped), and `npm run build`; security checks passed and all 14 review threads were resolved.  Desktop/mobile header fixture QA passed.  Production verified at `3aa643cac`: containment check passed with `ok=true`, `db=ok`, and scheduler age 19 seconds.  Local dependencies remain incomplete after registry ETIMEDOUT, so no local full-gate claim.  Rollout: `docs/rollouts/2026-09-09-model-catalog-account-labels.md`.
# Active Implementation Plan

> **2026-09-09 CLAUDE — FTS mirror non-convergence pinned the event loop into a public 503 (`claude/eventloop-stall-fix`).**  `/api/live` 8.60s/0.09s/0.03s back-to-back and `/api/health` 8.41s (0.43s on 09-07); Docker `FailingStreak: 5`, Traefik dropped a healthy container.  CPU 107% with disk `%util 0.10` — CPU-bound in-process.  `mirrorFtsChunksBounded` resumed from a `COUNT(*)` and used it as a POSITIONAL chunk offset; duplicate chunk text collapses on the `content_hash`-keyed PK, so the offset never advanced and the same slice was re-mirrored forever (hsy-20260329 stuck at 400/508 across all 29 slices, one pinning 36,511 ms; 198 slices / 22 minutes pinned on 09-08).  Fix: resume on CONTENT via `ftsMirrorResumeOffset()` (provably monotonic, and each side-index key validated against its live FTS row so a stale key cannot mask absent content — Codex P2, real, fixed) plus migration 88 `idx_document_chunks_fts_index_occurrence` (78–105 ms `SCAN` → `SEARCH`; 105.26 ms → 3.04 ms, 34.6x at production scale).  Ruled out: `storeContexts` dedup, PR #3192, a heavy `/api/health`, and SQLite lock contention.  Rollout: `docs/rollouts/2026-09-09-fts-mirror-nonconvergence.md`.
> **2026-09-09 CLAUDE — Backup methodology: policy, archive depth, whole-attempt bounds, proven restore (`claude/backup-methodology`).**  End-to-end audit of all four backup tiers, then the fixes.  Tier 1 (Litestream/B2) healthy; PITR window is **7 days**, not 30 (`retention: 720h` lives in the unused local-dev `litestream.yml`).  Tier 3 (weekly R2 cold archive) still at `objectCount = 1` and 10.4 days stale: #3192 fixed the snapshot step and exposed the next fault — the first run under it died in the **unbounded upload** with a bare `fetch failed`, and the job went terminally `unresolvable` at `attempts = 31`.  Tier 2 (host 6-hourly `sqlite3 .backup`) is BROKEN by the same page-1 restart loop one layer up, and its new 30-minute bound will now kill a ~24 h copy silently on every tick — handed to the owner, host script, not this repo.  The ~535 GB Backblaze figure is stale (41.280 GiB actual); no prune needed.  Shipped `docs/backup-policy.md` (canonical), cold retention 1 → 4 with the write-only-downward clamp removed, pre-upload artifact verification that refuses to upload an unverified file, a whole-attempt deadline that ABORTS in-flight S3 requests, bounded per-request retries, `fetch failed` cause unwrapping, and `scripts/ops/verify-cold-snapshot-restore.mjs`.  Nothing deleted anywhere.  Rollout: `docs/rollouts/2026-09-09-backup-methodology.md`.

> **2026-09-08 CLAUDE — Transport blips stop paging as provider outages (`claude/sentry-getjson-soft-failures`, board `c630ceed`).**  Twelve Sentry issues titled `"<service> connection failed"` across a dozen unrelated integrations, two of which paged PagerDuty (#108 `roic`, #112 `congress-share`).  Node's `fetch()` collapses a dead socket, a DNS hiccup, or an `ECONNRESET` into a bare `"fetch failed"` that matched none of `db-health.ts`'s soft-failure shapes, so a burst of blips read as a hard outage and captured at Sentry `error`.  Adds a THIRD failure class: `[transient-network] ` rows still count toward the hard consecutive-failure streak, but a streak made entirely of blips captures at `warning` and withholds the operator push until it has lasted `HEALTH_TRANSIENT_ESCALATION_MS`.  `fetchWithRetry` gains an idempotency gate and jittered backoff.  Observability and retry shaping only — no trading, brokerage, or money-path behavior changes.  Rollout:  `docs/rollouts/2026-09-08-transient-network-health-classification.md`.
> **2026-09-08 CLAUDE — R2 weekly cold snapshot archive stall (`claude/r2-cold-snapshot-freshness`).**  `checks.storage.r2Weekly` red for 9 days with zero noise.  better-sqlite3 `backup()` restarts on every write from another connection, so it never converges on the ~10.7 GB live DB — 27 attempts, no `.success`, no `.error`.  Replace the snapshot step with `VACUUM INTO` in a child process, bound every attempt with `R2_COLD_SNAPSHOT_DEADLINE_MIN`, and add a Sentry watchdog on the `r2Weekly` health state (one event per transition).  No R2 delete.  Rollout: `docs/rollouts/2026-09-08-r2-cold-snapshot-hang.md`.
> **2026-09-08 GROK — PR #3189 fixer tip: distinguish manual pauses from auto-halts; full AGENTS.md verify (`claude/scheduler-broker-error-classification`).**  Codex P2: `still_paused` now carries `autoOwned` so `isHaltedPauseAction` / `logHealthGateSkip` emit `(auto-halted)` / `halted: true` only for an auto-halt we own, not a manual owner halt.  Codex P1: run lint then tsc then test then build and record the results honestly.  Do not merge.  Extra-ship no.  Rollout: `docs/rollouts/2026-09-07-scheduler-broker-error-classification.md`.
> **2026-09-07 CLAUDE — PR #3189 round-2 Codex/Sentry triage: deadline-race recovery fix, degraded-state preservation, success-TTL fix, durable halt-state tracking, bracket-lookup retry (`claude/scheduler-broker-error-classification`).**  Five real round-1 findings fixed in one batch.  `recordLaneRecovery` now keys off the SAME `withDeadline`-raced promise as `recordLaneFailure` (both the stale-limit-order and synthetic-stop-monitor lanes) instead of the raw work promise — a lane that times out but later succeeds in the background could previously never reach `lane_degraded`, since the late success silently cleared the just-recorded failure streak (independently flagged by both `sentry` and `chatgpt-codex-connector`).  `recordLaneFailure` now preserves `degraded` status across a failure-category change instead of resetting it.  Tradier's exponential probe backoff now applies only to failures, never successes (a healthy streak could previously ride the TTL to 60 minutes and mask a real regression).  New `isHaltedPauseAction` helper tracks the durable halt state instead of the one-tick transition marker.  `cancelBracketSiblingLegs`'s GET is now actually opted into `retryTransient` (the original rollout note claimed it already was).  Rollout: `docs/rollouts/2026-09-07-scheduler-broker-error-classification.md`.
> **2026-09-07 CLAUDE — Scheduler/broker error classification, backoff, and observability (`claude/scheduler-broker-error-classification`).**  Production evidence (`litestream-runtime.log`, 2026-08-29..2026-09-07): 1,364 "Tradier order capability probe failed" (regex gap — fixed, plus exponential-backoff caching), 79/78/75 scheduler broker-timeout lines (classification + degraded-subsystem escalation, de-duplicated health-gate skip log), 92 Qdrant write-path "TypeError: fetch failed" (bounded retry + fixed a hardcoded `provider: "pinecone"` mislabel).  Classification/backoff/observability only — no trading-decision logic changed.  Complements PR #3174's whole-tick watchdog without duplicating it.  Rollout: `docs/rollouts/2026-09-07-scheduler-broker-error-classification.md`.
> **2026-09-07 CLAUDE — PR #3183 round-2 Codex triage: breaker token-fingerprint invalidation, nightly collection gate, half-open probe serialization (`claude/congress-share-401-observability`).**  Four real round-1 findings fixed in one batch.  `CongressAuthBreakerState` stores a non-secret sha256-prefix token fingerprint so a breaker tripped by an old bearer token auto-clears the instant `CONGRESS_TRADE_TOKEN` is resynced, rather than blocking the resynced token for the rest of the 6h cooldown.  `runCongressDailyShareUnlocked` now checks the breaker BEFORE the expensive collection phase (App A price-needs, OHLC fetches, screener refs), not just at the final POSTs — a tripped breaker previously still let that whole phase run hourly for the entire cooldown.  New `claimCongressAuthBreakerProbe` atomically serializes the single post-cooldown half-open probe so concurrent callers (scan-hook + nightly batch) cannot each treat an expired cooldown as their own probe.  Also documented the `CONGRESS_SHARE_AUTH_BREAKER_COOLDOWN_MS` knob in `.env.example` + `docs/congress-trade-share.md`.  Rollout: `docs/rollouts/2026-09-07-congress-share-401-observability.md`.
> **2026-09-07 CLAUDE — congress-share 401 observability + auth circuit breaker (`claude/congress-share-401-observability`, board `8620cad8`).**  3,096x `HTTP 401` over 9 days, console.error only.  Token drift CONFIRMED (fingerprint-only diagnosis, owner resync needed).  Wired `shareWithCongressTrade` into the existing `logApiHealth` pipeline (Sentry + `/api/health` degraded dependency, same mechanism as roic/congress.trade) and added a 401/403-specific circuit breaker so a permanent auth failure stops hammering CT instead of retrying at full cadence forever.  Rollout: `docs/rollouts/2026-09-07-congress-share-401-observability.md`.

> **2026-09-07 CLAUDE — SEC ingest error classification + RAG retrieval degradation signal (`claude/ingest-error-classification`, PR #3187).**  Retry/dead-letter policy change: `classifyEmbedFailure` (`vector-db.ts`) now lets the SEC ingest worker dead-letter a genuinely permanent embed rejection (HTTP 400) immediately instead of retry-looping it forever under a generic "budget exceeded" label; 429 AND 408 both classify as transient (a 408 means the provider never evaluated the request, so it is not "byte-identical content that can never succeed" the way a 400 is).  Retrieval degradation strategy: the query-embed failure signal (`rag.dense_recall_degraded` structured log + `embed.failed` metric) is now emitted centrally inside `retrieveContextDetailed` itself (`reportRetrievalStatus`, `vector-db.ts`) rather than only inside `search-fusion.ts`'s `retrieveFusedContext` wrapper — `retrieveFusedContext` has no non-test production caller (confirmed via `test/rag-production-path-contract.test.ts` "audit R1", which pins strategy/chat to `retrieveContextDetailed` and forbids `retrieveFusedContext` there by design), so every real production caller (chat orchestrator, strategy, proposer-dossier, experience-memory, lookahead-audit) previously got no signal at all on a query-embed failure.  A deliberate `budget_skipped` is explicitly excluded from this emission (in both the new central path and the existing `search-fusion.ts` wrapper) — it is not a provider/lookup failure, so it must not flood Sentry or inflate the embed-failure metric.  Also: `shouldEmitRagIngestBudgetSentry`'s cooldown persistence is now fail-soft (a SQLite contention throw no longer escapes into `storeContextsImpl`'s control flow and rejects an otherwise-successful budget-skip).  Rollout:  `docs/rollouts/2026-09-07-sec-ingest-error-classification.md`.
> **2026-09-07 CLAUDE — Web 401 routes to /login (`claude/web-401-routes-to-login`, board `30809a0c` / `ab03d8c9`).**  A 401 from any console API call now redirects to `/login?callbackUrl=...` (`app/console/lib/api.ts`), matching `middleware.ts`'s existing fail-closed page redirect — idempotent, never bounces from `/login`.  `useConsoleData.tsx` stops polling and exposes `sessionExpired`; `shell.tsx` takes over the whole console shell with an explicit expired-session notice instead of leaving stale trading data rendering as live.  Secondary: `alpaca-account-insights.ts`'s `getJson` classifies transient transport errors with one bounded retry (SOCRATIC-TRADE-28, low-volume).  `db-health.ts` untouched.  Rollout:  `docs/rollouts/2026-09-07-web-401-routes-to-login.md`.
> **2026-09-07 CLAUDE — Remove redundant postcss override (`claude/postcss-override-conflict`).**  Fixes the recurring Dependabot postcss failure ("Override ... conflicts with direct dependency", recurred 6x since 2026-08-24).  The override WAS load-bearing for `next` (npm overrides are transitive; it was forcing `next`'s own exact `8.5.23` dependency down to the shared `8.5.15` -- confirmed via the pre-change lockfile having a single tree-wide postcss entry, no nested `next` copy).  Removed anyway: nothing in the tree wanted postcss OLDER than 8.5.15, only newer (`@tailwindcss/postcss` wants `^8.5.16`, `vite` wants `^8.5.26`, `next` wants `8.5.23`).  Post-removal: devDependency/`@tailwindcss/postcss`/`vite` dedupe to `8.5.28`; `next` gets its own real nested `8.5.23` (a real, verified behavior change, not a no-op).  No scope/timeline change.  Rollout:  `docs/rollouts/2026-09-07-postcss-override-conflict.md`.
> **2026-09-07 CLAUDE — iOS hard-crash fix: duplicate server command ids trap `Dictionary(uniqueKeysWithValues:)` (PR #3182, branch `claude/ios-dup-command-ids`, board `3b3df6ca`, dup `d9f81e44`).**  P1 crash fix: `CommandAttemptTracker.reconcile` in `ios/SocraticTrade/MobileStore.swift` built its id→command lookup with `Dictionary(uniqueKeysWithValues:)`, which calls `fatalError` (uncatchable) on any duplicate key; the server can legitimately report the same command id twice in one snapshot (overlapping poll windows).  The fix folds duplicates deterministically through a shared `MobileCommand.foldDuplicate` (freshest by `updatedAt`, terminal state wins an exact-timestamp tie), applies the same fold to the proposal-card command lookup so it cannot disagree with the tracker, and gates the Sentry duplicate warning on tracked pending attempts so a persistent server-side duplicate cannot re-report itself on every poll.  New regression tests cover the duplicate crash, the equal-timestamp tie-break, and the shared fold rule.  Remaining action:  merging to `main` does NOT ship this fix to users — the iOS app needs a future TestFlight build/release.  Rollout:  `docs/rollouts/2026-09-07-ios-dup-command-id-crash.md`.
> **2026-09-07 [codex-autofix] — Observability group dependency bump, handoff records + Sentry config import (PR #3178, branch `dependabot/npm_and_yarn/observability-bc808230b8`).**  No roadmap scope change; this is Dependabot's 7-update `observability` group bump, a runtime dependency-only change (production deps + lockfile are runtime watch paths).  This lane adds the mandatory handoff records (STATUS.md / docs/EFFORT-LOG.md / rollout note / this PLAN.md entry) and swaps the `next.config.mjs` Sentry import to `@sentry/nextjs/config` because the root `withSentryConfig` re-export is deprecated in Sentry 10.73 and removed in v11.  Rollout:  `docs/rollouts/2026-09-07-codex-autofix-observability-group-bump.md`.
> **2026-09-07 codex-autofix — eslint-config-next 16.3.4 handoff records (PR #3181).**  Dependabot bumped `eslint-config-next` 16.3.1 -> 16.3.4 (commit `fbc0f4fe1`, branch `dependabot/npm_and_yarn/eslint-config-next-16.3.4`).  Doc-only codex-autofix handoff:  adds the STATUS.md, docs/EFFORT-LOG.md, PLAN.md, and rollout-note records the repo pre-commit protocol requires before landing.  No runtime code change and no scope or timeline change.  Auto-merge (squash) lands the PR once the required checks pass and the Codex review threads resolve.  Rollout:  `docs/rollouts/2026-09-07-codex-autofix-eslint-config-next-16-3-4.md`.
> **2026-08-31 GROK — Hung scheduler-tick watchdog (`grok/hung-scheduler-tick-watchdog`).**  Firefighter SOCRATIC-TRADE-4:  process up, tick dead.  In-process watchdog unwedge + honest Sentry Crons + drain/health deadlines + strategy runs off the tick await.  No extra-ship.  No Coolify mutate.  Rollout:  `docs/rollouts/2026-08-31-hung-scheduler-tick-watchdog.md`.
> **2026-09-04 GROK — R2 weekly gzip freshen (`grok/r2-weekly-gzip-freshen`).**  Gzip already on main (#3135).  Add `R2_COLD_SNAPSHOT_SKIP_PRUNE` so the first `.db.gz` land does not DeleteObject `cold-snapshots/app-2026-08-30.db`.  Read-only inventory script.  Docs: R2 weekly vs B2 live replica.  No Coolify.  No extra-ship.  No merge from this lane.  Rollout: `docs/rollouts/2026-09-04-r2-weekly-gzip-freshen.md`.
> **2026-09-04 BF-Fixer — Gather internal time budget (`grok/gather-budget`, board 06df80cf).**  Do not raise the 8-minute cap.  Trim keyed/scarce enrichment when remaining wall time is too small; persist one `skipped_broker_unhealthy` row when the scheduler auto-halts an active account.  Not ST #3138/#3158/#3162.  No extra-ship.  No TestFlight.  Rollout: `docs/rollouts/2026-09-04-gather-internal-budget.md`.
> **2026-09-04 GROK — Vitest teardown flake (`grok/vitest-teardown-console`).**  Main verify after #3162 failed on `EnvironmentTeardownError` / pending `onUserConsoleLog` with every test green.  `onConsoleLog: () => false` still sends the RPC.  Set `disableConsoleIntercept: true`.  No Coolify.  No extra-ship.  Rollout: `docs/rollouts/2026-09-04-vitest-teardown-console.md`.
> **2026-09-03 GROK — Cash-flow-matched S&P overlay (`grok/spy-cashflow-chart`, board 7b71186c).**  Draw account dollars vs a same-deposit/withdrawal S&P tracker on Results + Home (web) and Home + Results (iOS).  Daily last-snapshot curve so early transfers are not dropped.  TWR % tiles stay.  Rollout: `docs/rollouts/2026-09-03-spy-cashflow-chart.md`.
> **2026-09-01 GROK — Qdrant Stage 2 write/delete/inventory cutover (`grok/qdrant-write-cutover`, issue #3151).**  Default `RAG_VECTOR_WRITE_QDRANT` true when `QDRANT_URL` is set.  Upserts, deletes, inventory, and hourly reconcile go to collection `socratic-trade`.  Pinecone WU breaker no longer parks ingest.  Provider authority from durable SQLite commits.  Package `@pinecone-database/pinecone` kept behind the pinecone backend flag.  Rollout: `docs/rollouts/2026-09-01-qdrant-write-cutover.md`.
> **2026-09-01 GROK — Litestream structural: stop L2 mega-compaction (`grok/litestream-structural`, issue #3153, boards 081c8ecf / 1e3df744).**  Product is L0 + bounded L1 + 24h snapshots.  0.5.12 has no disable-L2 flag: yaml `levels:` with one 30s entry is the off switch.  No backoff yaml key; removing L2/L3 is the backoff.  Honest per-level detector.  L1 trim is a persistent 00:04 UTC timer in-repo (do not fight tonight's transient oneshots; host install is remaining ops).  Do not bounce Coolify / FORCE_RESTORE / touch live B2 `trading-live`.  Rollout: `docs/rollouts/2026-09-01-litestream-structural.md`.
> **2026-09-01 GROK — Money-path orders (`grok/money-path-orders`, #3152).**  Fix MCP write double-submit on timeout, map Alpaca write `stop_market` -> `stop`, and stop treating owner-UI UUIDs as app-placed.  No live placement from this Mac.  Rollout: `docs/rollouts/2026-09-01-money-path-orders.md`.
> **2026-09-01 GROK — Qdrant Stage 2 write/delete/inventory cutover (`grok/qdrant-write-cutover`, issue #3151).**  Default `RAG_VECTOR_WRITE_QDRANT` true when `QDRANT_URL` is set.  Upserts, deletes, inventory, and hourly reconcile go to collection `socratic-trade`.  Pinecone WU breaker no longer parks ingest.  Provider authority from durable SQLite commits.  Package `@pinecone-database/pinecone` kept behind the pinecone backend flag.  Rollout: `docs/rollouts/2026-09-01-qdrant-write-cutover.md`.
> **2026-08-31 ANTIGRAVITY — Default RAG vector reads to Qdrant & strategy run fixes (`agent/ag-pinecone-qdrant-strategy-fix`).**  Default `RAG_VECTOR_READ_QDRANT` to true; decouple retrieval from Pinecone client/index prerequisites; gracefully catch Pinecone 429s in background reconciliation; immediately sweep dead prior-process strategy runs on boot without waiting 30 minutes.  Rollout: `docs/rollouts/2026-08-31-qdrant-default-strategy-fix.md`.
> **2026-09-01 CLAUDE - L1 boundary-trim hardening + Congress.Trade wedge (`claude/l1-trim-hardening`, PR #3142).**  Closes the three guard gaps #3140 left open, plus two defects found by running the tool for real against a 2,400-object level.  Repo copy resynced byte-identical to the hardened host tool (sha256 `a6bfc2bf...8087`, 9721 bytes, mode 755).  Adds `--app {socratic,congress,usage-monitor}`; a relative truncation guard (abort under 50% of the previous snapshot - the 100 MB absolute floor cannot reject a truncated ~4.5 GB snapshot); full kept-chain contiguity (twins allowed) with its own exit code, since L2 stays wedged on non-contiguous input; `--max-snapshot-age-hours` (default 48, scheduled units pass 6); and an abort when nothing is superseded while L1 exceeds 200 objects.  **Deletes are now BATCHED** (500-name `--files-from` chunks; the old per-object `--include` loop re-listed the whole prefix each call, ~12s per delete, ~8h for 2,362 objects) and are **HIDES, not `--b2-hard-delete`** - the host's scoped key returns 401 on `b2_delete_file_version`, so the flag made rclone report progress while deleting NOTHING (~800 no-op deletes on CT).  A hide unwedges compaction immediately and lifecycle `daysFromHidingToDeleting=1` frees bytes ~a day later; hard deletes need the B2 master key, i.e. an operator workstation.  **Do NOT re-add `--b2-hard-delete` on the host.**  The tool now re-lists after applying and reports `deleted=`/`survived=` from the bucket rather than exit codes.  Exit codes 0-6 documented.  **CT had never been trimmed:** 2,413 L1 objects, 2,362 (24.6 GB) superseded, 51 (12 MB) kept, L2 at ZERO - same wedge as ST.  Six TRANSIENT one-shots armed 2026-09-02 00:04/00:20/00:40 UTC.  **Do NOT convert these into a permanent nightly timer** - transient units expire on reboot by design; trimming below a snapshot costs sub-daily PITR granularity and the 168h snapshot retention stays authoritative.  Rollout: `docs/rollouts/2026-09-01-l1-trim-hardening.md`.
> **2026-09-01 CLAUDE - Litestream L2 unwedge: snapshot-boundary L1 trim (`claude/l2-unwedge-boundary-trim`, PR #3140, merged `271e5ff8e`).**  L2 compaction wedged since 2026-08-29 with no alert.  Root cause is the mega-upload, not the Backblaze cap: L2 folds the WHOLE remaining L1 chain into one object, so while stalled L1 grows and each retry is a larger upload that dies.  The cap DID reset at 00:00Z (zero cap errors 00:00-01:39Z) and L2 still failed 19 times in that window, every one on the upload.  Lands `scripts/litestream-l1-boundary-trim.py` verbatim from the installed host tool.  **On-demand heal only - do NOT make it a recurring nightly timer:** trimming L1 below a snapshot costs sub-daily PITR granularity for the trimmed span, and the app's configured 168h snapshot retention stays authoritative.  Run it right after the nightly snapshot (~00:00Z), which is what advances the boundary.  Three guard gaps from Codex review (snapshot-integrity, kept-chain contiguity, scheduled-run freshness) are accepted and carried as a paired repo+host follow-up.  Rollout: `docs/rollouts/2026-09-01-l2-unwedge-boundary-trim.md`.
> **2026-09-01 CLAUDE - PR #3139 plist comment: actually fix the XML `--` bug (`fix/plist-comment`, PR #3139).**  The PR's original fix (relocating the comment below `<!DOCTYPE>`) did not fix `plistlib.loads` raising `ExpatError` on `scripts/com.jay.provider-knob-sync.plist` because XML comments cannot contain `--` anywhere, and the comment still had two literal `--apply` mentions.  Reworded both to "the apply flag"; verified `plistlib.load` now parses clean (it raised before).  Also adds the rollout-doc update AGENTS.md requires for script changes.  Do not merge from this lane.  Rollout: `docs/rollouts/2026-09-01-pr-3139-plist-comment-fix.md`.
> **2026-09-01 CLAUDE - Litestream L2 unwedge: snapshot-boundary L1 trim (`claude/l2-unwedge-boundary-trim`, PR #3140).**  L2 compaction wedged since 2026-08-29 with no alert.  Root cause is the mega-upload, not the Backblaze cap: L2 folds the WHOLE remaining L1 chain into one object, so while stalled L1 grows and each retry is a larger upload that dies.  The cap DID reset at 00:00Z (zero cap errors 00:00-01:39Z) and L2 still failed 19 times in that window, every one on the upload.  Lands `scripts/litestream-l1-boundary-trim.py` verbatim from the installed host tool.  **On-demand heal only - do NOT make it a recurring nightly timer:** trimming L1 below a snapshot costs sub-daily PITR granularity for the trimmed span, and the app's configured 168h snapshot retention stays authoritative.  Run it right after the nightly snapshot (~00:00Z), which is what advances the boundary.  Three guard gaps from Codex review (snapshot-integrity, kept-chain contiguity, scheduled-run freshness) are accepted and carried as a paired repo+host follow-up.  Rollout: `docs/rollouts/2026-09-01-l2-unwedge-boundary-trim.md`.
> **2026-08-31 GROK — Top-to-bottom full-stack audit (`grok/full-stack-audit`, board 52592a4d).**  Docs-only catalog of still-open P0/P1s across desktop `/console`, phone `/console`, iOS, and backend.  Do not implement here.  Claim existing board rows for money-path fixes.  Review: `docs/reviews/2026-08-31-grok-full-stack-audit.md`.  Rollout: `docs/rollouts/2026-08-31-grok-full-stack-audit.md`.
> **2026-08-31 CLAUDE — Backup remediation (`claude/backup-remediation`, PR #3135).**  Weekly R2 cold snapshot is now gzip-streamed (`cold-snapshots/app-<date>.db.gz`, retain=1 across `.db`+`.db.gz`; restore needs gunzip first — recipe in `docs/litestream.md`); boot rotates `/app/data/litestream-runtime.log` at 64 MB (keep newest 16 MB, one `.1` generation).  B2 lifecycle (hide-14d + delete-1d) hard-caps B2 restore depth at ~15 days; the R2 cold snapshot is second-provider DR (retain=1, at most ~7 days old), so no provider holds a point older than ~15 days.  No compression knob.  Rollout: `docs/rollouts/2026-08-31-backup-remediation.md`.
> **2026-08-30 BF-Fixer — PR #3120 Codex thread unstick (`ag/st-auth-and-transcripts`).**  Fail-closed readiness/policy decode; cookie-salt reissue on legacy sessions; canonicalize earningscalls onto earningscalls-dev-rapidapi; fix ops-snapshot rollout path.  No extra-ship.  No TestFlight.  Rollout: `docs/rollouts/2026-08-30-pr-3120-codex-threads.md`.
> **2026-08-30 GROK — PR #3120 CI unblock (`ag/st-auth-and-transcripts`).**  Keep iOS auth-redirect + workspace decode fallbacks + EarningsCalls.dev / ROIC.ai labels.  Merge `origin/main` (`f385fb037`) so ops-snapshot trial window is now+7d.  No squash-merge.  No extra-ship.  No `--force-ship`.  Rollout: `docs/rollouts/2026-08-30-pr-3120-ops-snapshot-pin.md`.
> **2026-08-30 GROK — PR #3111 CI unblock (`compiler/asc-seq-surface-stderr`).**  Keep asc-seq stderr + honest unverified die-text.  Merge main; pin ops-snapshot trial window to now+7d so `trial.active` cannot calendar-rot.  No extra-ship.  No `--force-ship`.  Rollout: `docs/rollouts/2026-08-30-asc-seq-surface-stderr.md`.
> **2026-08-29 CLAUDE - iOS sign-in repair: OAuth return-to-app + workspace decode (`monet/ios-auth-redirect-workspace-decode`, PR #3124).**  Owner re-reported iOS login broken after #3116/#3117.  Two independent causes, both fixed server-side so already-installed TestFlight builds are repaired on deploy (no app update).  (A) `/api/mobile/auth-start` clamped `callbackUrl` against `request.url`, which inside the container is the INTERNAL origin - every absolute mobile callback collapsed to `/` and the OAuth sheet landed on the signed-in website instead of firing `socratictrade://auth`.  Origin now comes from the existing `resolvePublicAppOrigin()`; forwarded headers are NEVER trusted here (a first cut used `x-forwarded-host` and Codex review correctly flagged it as an open redirect on `loginFallback`).  (B) "Couldn't load your workspace" is a decode failure, not Apple auth: the server keys equity-curve points on `timestamp` while shipped Swift required `date`, and Swift aborts the whole-snapshot decode - latent until the FIRST curve point exists, which is why it appeared with no code change.  Mobile wire now aliases `date`; Swift decodes either key and `performance` degrades to nil.  Do not rename the shared `EquityCurvePoint` type (the console consumes `timestamp`).  Rollout: `docs/rollouts/2026-08-27-ios-auth-redirect-workspace-decode.md`.
> **2026-08-26 CURSOR — CI autofix for #3107 APNs contract (`cursor/ci-autofix-automation-9634`).**  `roic_status_advisory` was added to TS notification types without the iOS contract Row.  Stacked fix on `agent/antigravity-ui-fixes`.  Rollout: `docs/rollouts/2026-08-26-roic-apns-contract.md`.
> **2026-08-25 CURSOR — AppUpdatePromptTests pbxproj leftover COMPLETED (`64a06e78` #3103).**  Generated `AppUpdatePromptTests.swift` refs committed so TestFlight (no xcodegen) stays in sync.  Leftover `ios-build` `32809716228` / `32810441765` 242/0.  `verify-hosted` `32809716125` success.  Do not `--force-ship`.  Rollout: `docs/rollouts/2026-08-25-app-update-prompt-pbxproj.md`.
> **2026-08-25 CURSOR — AppUpdatePrompt Apple IDs off Swift COMPLETED (`df75ca6f` #3102).**  Keep ios-fleet pin/copy.  Drop `knownAppleIds`.  Live DealDex is `net.dealdex` 6802474288.  No Swift package / `testers.json` / `--force-ship` / spend.  Hosted `ios-build` `32808123472` 242/0.  Rollout: `docs/rollouts/2026-08-25-app-update-prompt-apple-ids.md`.
> **2026-08-25 CURSOR — Playwright smoke dismiss ConsentGate COMPLETED (`1662cdcd` #3100, smoke `32805872756` green).**  First-use legal overlay accepted when shown, then More vs rail Scan.  Rollout: `docs/rollouts/2026-08-25-smoke-dismiss-consent.md`.
> **2026-08-25 CURSOR — Playwright mobile Scan/More smoke (`cursor/mobile-smoke-scan-more-0e2b`, #3097 `c2ed2c85`).**  `getByText("Scan").first()` matched the hidden desktop rail on iPhone.  Open More on mobile; rail link on desktop.  Overlay leftover closed by #3100.  Rollout: `docs/rollouts/2026-08-25-mobile-smoke-scan-more.md`.
> **2026-08-25 CURSOR — Hosted TestFlight 1.0.69 COMPLETED (`ef725f26` #3089, ship `32796413908`).**  Do not run `xcodebuild` locally.  Do not restart `mac-xcode26-socratic`.  In-repo `scripts/ios-fleet/` + copied ASC/P12 secrets.  Internal testers can install 1.0.69 (202608250109).  Rollout: `docs/rollouts/2026-08-24-ios-hosted-testflight-ship.md`.
> **2026-08-25 CURSOR — Datadog Logs + APM + RUM (`cursor/datadog-logs-apm-rum-6ce3`).**  Existing us5 account only.  Fail-closed without `DD_API_KEY` / agent host / RUM tokens.  Do not mint secrets or enable paid add-ons.  Do not replace Sentry/PagerDuty.  Do not change Designer copy or Oracle RAG/Pinecone.  Coolify deploy is not this lane.  Rollout: `docs/rollouts/2026-08-25-datadog-logs-apm-rum.md`.
> **2026-08-25 CURSOR — Console honesty + leftover UX (`cursor/console-discard-approve-chips-1ffb`, PR #3093).**  Rebased onto `origin/main` `c2ed2c85` (#3097 Scan-via-More smoke, after #3094 Datadog and #3096 1.0.69 docs).  Kept the e2e assertion from main.  Did not edit Datadog files.  Discard / approve typed-confirm / Coach chips plus iOS Open Guardrails, Open Connections copy, Tradier (paper).  No Desk/IRA rewrite.  Rollout: `docs/rollouts/2026-08-25-console-discard-approve-chips.md`.
> **2026-08-24 CURSOR — Hosted macos-latest TestFlight (`cursor/ios-hosted-testflight-ship-0e2b`, PR #3089).**  Do not run `xcodebuild` locally.  Do not restart `mac-xcode26-socratic`.  Vendor `scripts/ios-fleet/` like Congress.Trade, import ASC/P12 from GitHub Actions secrets (copy existing team credentials, do not mint), ship #3028 via `gh workflow run ios-ship.yml`.  2026-08-25: Sentry observer + `CRON_SCHEDULES` retargeted off `(Mac runner)` names after `verify-hosted` failed.  Rollout: `docs/rollouts/2026-08-24-ios-hosted-testflight-ship.md`.
> **2026-08-23 ANTIGRAVITY — Active Management for Held Shorts When Short Selling Disabled (`agent/ag-manage-existing-shorts`).**  Position management across strategy proactive risk exits, take-profit trims, synthetic stop monitor, broker protective stops, and console UI to manage and protect existing short positions (`quantity < 0`) regardless of the `shortSellingEnabled` toggle. The toggle now strictly gates opening new short positions (`proposal.side === "short"`), while held shorts receive full stop-loss protection, trailing stops, and resting broker buy-stops on Alpaca. Rollout: `docs/rollouts/2026-08-23-manage-existing-shorts.md`.

> **2026-08-22 CURSOR — Alpaca Paper Approve greyed after Retry Red Team — COMPLETED / Deployed to production 2026-08-24 (PR #3049, squash `06a5418b`, live sha `dcfd04d7`, docs #3087).**  Website/API live.  Retry no longer greys Approve.  Retry applies the Red verdict.  Owner Approve of an opening in Exit-only is the override; the agent still will not open on its own.  Halted and liquidating still block openings.  Native iOS stale-gate is not on TestFlight: `ios-ship.yml` on `macos-latest` missing `/Users/jay/apps/ios-fleet`; no ASC GitHub secrets.  Rollout: `docs/rollouts/2026-08-22-alpaca-paper-approve-greyed.md`.
> **2026-08-21 GROK — 5M this week then free-tier snap (`grok/pinecone-free-snap`).**  Honor Builder-sized 5M monthly until 2026-08-27T00:00:00.000Z, then snap 60k/20k/1.6M.  Expert panel: highlights/signal/analog cards in Pinecone; full filings/transcripts/history local.  Do not flip write-class until PR B.  Builder only if `docs/audits/2026-08-22-panel-synthesis.md` §5 gates pass.  Rollout: `docs/rollouts/2026-08-21-pinecone-free-snap.md`.
> **2026-08-21 GROK (local Mac) — adaptive-tabs item A screenshots.**  Cursor local is down.  Paste-ready brief: `docs/rollouts/2026-08-21-ios-adaptive-tabs-mac-qa.md`.  Start from `origin/main` in a new `~/apps/trading-grok-tabs` worktree (do not clobber `trading-grok-drain`).  Shots do not need #3027 (`origin/main` merged onto the rename branch).  Do not redo B/C/D.  E/F stay owner calls.
> **2026-08-21 CURSOR — LayoutMathTests.swift rename + Mac CI xcodegen (`cursor/ios-layout-math-tests-rename-3110`).**  Adaptive-tabs leftover item B.  Prior items C/D/A-tests already on main (#3023/#3012).  `ios-build.yml` generates from `project.yml` on the Mac runner.  Screenshots / auto-fill / knobs still open.  Rollout: `docs/rollouts/2026-08-21-ios-layout-math-tests-rename.md`.
> **2026-08-21 CURSOR — Activity layout redesign (`cursor/activity-layout-redesign-085b`, PR #3031).**  Five Title Case Activity tabs (Alerts Center first).  All → Audit Log.  Plain-English run failures.  APNs-first delivery + admin system-alert fanout.  Alpaca session-close vs Delayed Quote.  iOS chips/rail parity with additive `?tab=` deep links.  Rematched onto `origin/main` `cd4c700d` (#3018).  Rollout: `docs/rollouts/2026-08-21-activity-layout-redesign.md`.
> **2026-08-21 CURSOR — iOS wide layout + Admin tab + chrome (PR #3028, `cursor/ios-wide-layout-admin-tab-0e2b`).**  Adaptive regular-width shell (sidebar-adaptable TabView, larger settings/inbox sheets).  Gear top-trailing and bell top-leading on every tab.  Admin Portal is an `isAdmin`-gated tab with a native rail; WKWebView intercepts "Back to Console".  Assets price-alert composer removed.  Merging `origin/main` after #3031: keep Activity redesign + this PR's `NotificationsInboxView`.  Rollout: `docs/rollouts/2026-08-21-ios-wide-layout-admin-tab.md`.
> **2026-08-22 CURSOR — iOS wide layout + Admin tab + chrome (PR #3028, squash `a851a68d`).**  Adaptive regular-width shell, gear/bell chrome, Admin tab, console-return fence.  COMPLETED (merged to `main`).  iOS-only; TestFlight only if the owner asks.  No Coolify bounce.  Rollout: `docs/rollouts/2026-08-21-ios-wide-layout-admin-tab.md`.
> **2026-08-21 CURSOR — Activity layout redesign (`cursor/activity-layout-redesign-085b`, PR #3031, squash `d588387b`).**  Five Title Case Activity tabs (Alerts Center first).  All → Audit Log.  Plain-English run failures.  APNs-first delivery + admin system-alert fanout.  Alpaca session-close vs Delayed Quote.  iOS chips/rail parity with additive `?tab=` deep links.  Merged to `main`.  Rollout: `docs/rollouts/2026-08-21-activity-layout-redesign.md`.
> **2026-08-21 CURSOR — Activity layout redesign (`cursor/activity-layout-redesign-085b`, PR #3031, squash `d588387b`).**  Five Title Case Activity tabs (Alerts Center first).  All → Audit Log.  Plain-English run failures.  APNs-first delivery + admin system-alert fanout.  Alpaca session-close vs Delayed Quote.  iOS chips/rail parity with additive `?tab=` deep links.  Merged; website auto-deploy not yet claimed (live sha still `c6f33086`).  Rollout: `docs/rollouts/2026-08-21-activity-layout-redesign.md`.
> **2026-08-21 GROK — Stop paging Starter 2M Pinecone WUs (`grok/pinecone-wu-cap`).**  Standard trial is unlimited; matcher no longer requires `429` in the body; monthly budget 0 means continue; no post-trial 1.6M snap.  Rollout: `docs/rollouts/2026-08-21-pinecone-wu-no-starter-wall.md`.
> **2026-08-21 CURSOR — Abort abandoned strategy gather (`cursor/gather-timeout-abort-0388`).**  Today's Roth + Paper failures are `strategy gather timeout`, not LLM/key/scheduler.  The 8m deadline left the scan running; overlapping gathers then all missed the cap.  Abort on timeout, honor the signal in cascade/enrichment including the keyed Finnhub wave (Wave B, free-tier key), last completed tape + 45s quote refresh so Green still starts.  Do not HOTFIX during RTH.  Rollout: `docs/rollouts/2026-08-21-gather-timeout-abort.md`.
> **2026-08-21 CURSOR — Unhang ios-build + run XCTests (`cursor/ios-ci-unhang-ac14`).**  Adaptive-tabs follow-up item C: redirect `xcodebuild` off the Actions pipe; add a simulator test step.  Item D already on main via #3012; vitest locks the pbxproj resource.  Do not flip `ios-build` to required until this PR's Mac job concludes `success`.  Rollout: `docs/rollouts/2026-08-21-ios-ci-unhang.md`.
> **2026-08-21 CURSOR — Unhang ios-build + run XCTests (`cursor/ios-ci-unhang-ac14`, PR #3023).**  Adaptive-tabs follow-up item C verified: Mac job 32529663287 `success` in ~2 min, 232 XCTests / 0 failures.  Item D already on main via #3012.  `ios-build` can now be made required (board `830c892f`).  Screenshots / rename / auto-fill still open.  Rollout: `docs/rollouts/2026-08-21-ios-ci-unhang.md`.
> **2026-08-21 CURSOR — Scan card tap + honest iOS last/next run (`cursor/ios-scan-card-schedule-e224`).**  Full-card scan hit target (iOS + website phone cards).  iOS company name darker than industry.  Scheduler presentation hydrates last run from `strategy_runs` and publishes next run while Autopilot/active, including after restart or the cash close.  Rollout: `docs/rollouts/2026-08-21-ios-scan-card-schedule.md`.
> **2026-08-21 CURSOR — Abort abandoned strategy gather (`cursor/gather-timeout-abort-0388`).**  Today's Roth + Paper failures are `strategy gather timeout`, not LLM/key/scheduler.  The 8m deadline left the scan running; overlapping gathers then all missed the cap.  Abort on timeout, honor the signal in cascade/enrichment, last completed tape + 45s quote refresh so Green still starts.  Do not HOTFIX during RTH.  Rollout: `docs/rollouts/2026-08-21-gather-timeout-abort.md`.
> **2026-08-21 CURSOR — Three-column LLM catalog (`agent/cursor/llm-model-slugs`).**  Persist display slugs; OpenRouter live `model` is column 2; `nativeSlugFor` is column 3 for a future direct path.  Aliases keep older stored ids working.  Congress.Trade catalog is a follow-up.  Rollout: `docs/rollouts/2026-08-21-llm-model-slugs.md`.
> **2026-08-21 CLAUDE - Width-aware iOS/Mac tab bar + iPad Air 11" layout (`claude/dynamic-menu-tabs-ipad-mac-phddkr`).**  Owner ask in full: >4 tabs on iPad and wide Mac windows, fall back to the defaults when too narrow, Home required, and the slot before More swapped out by whatever is opened from the More list.  Plus the iPad Air 11" layout pass, carried into Mac Catalyst.  `TabBarCapacity` (compact 4; 820pt -> 6; 1180pt -> 8; ceiling 8) drives `TabPreferences.resolve`; the narrow fallback writes nothing so the owner's picks survive; an uncustomized bar auto-fills to what fits.  `SnapshotScaffold` picks 1/2/3 card columns - one column is the existing `LazyVStack`, so the iPhone is unchanged.  NOT compiled here (Linux container, no xcodebuild/xcodegen/simulator); `ios-build.yml` on the Mac runner is the verification of record.  Web console `MOBILE_TABS_MAX` deliberately untouched.  Rollout: `docs/rollouts/2026-08-21-ios-adaptive-tabs-ipad-layout.md`.
> **2026-08-17 CURSOR — Web / iOS / mobile-web parity audit (`cursor/web-ios-parity-audit-e83a`).** Report-only.  Clients are desktop `/console`, phone-width `/console`, and native iOS.  PWA stays retired.  Implementation slices A–F are listed in `docs/audits/2026-08-17-web-ios-parity.md` §16.  Do not start those in this PR.  Rollout: `docs/rollouts/2026-08-17-web-ios-parity-audit.md`.
> **2026-08-20 DEEPSEEK — Full-stack review (desktop web, mobile web, iOS) — DOCS ONLY, IN PR (branch `deepseek/lane`).**  Zero-code review; deliverable is the prioritized outline in `docs/reviews/2026-08-20-deepseek-full-review.md` + board findings (da8a93bf, 34b8fbe7, 436a9b98) + state comments on 830c892f/89249c60/3b343933/620ef423.  Recommended next units (claim on the board first): ios-build as required check (S), CSP enforcement (M), console not-found pages (S), privacy manifest (S), sign-in deep-link destination (S).  Does not take any of the open Kimi money-path items.
> **2026-08-20 CURSOR-BUGBOT — #2853 drain must not adopt a frozen-but-live worker (`cursor/drain-adopt-live-heartbeat`).** Map presence is liveness; a stale beat timestamp is an event-loop freeze, not a dead worker.  Rollout: `docs/rollouts/2026-08-20-drain-adopt-live-heartbeat.md`.
> **2026-08-20 CURSOR-BUGBOT — Owner-cancel stop tombstone on cancel timeout (`cursor/cancel-timeout-stop-tombstone`).** Persist the do-not-replace tombstone when `cancelEquityOrder` throws (e.g. #2886 deadline) so reconcile cannot re-place a stop the owner just cancelled.  Rollout: `docs/rollouts/2026-08-20-owner-cancel-stop-tombstone-timeout.md`.
> **2026-08-20 CURSOR-BUGBOT — Alpaca MCP getEquityOrders must include terminal orders (`cursor/alpaca-mcp-orders-include-terminal`).** #2886 scoped the REST fallback to open+24h closed but left MCP `get_orders` at `status:"open"` while `ordersListIncludesTerminal` stays true.  A just-filled market order is invisible; reconcile says `not_placed` and retries.  REST path unchanged.  Rollout: `docs/rollouts/2026-08-20-alpaca-mcp-orders-include-terminal.md`.
> **2026-08-20 CURSOR-BUGBOT — #2953 peer quotes/intraday middleware pass-through (`cursor/peer-quotes-intraday-middleware`).** Same bearer exception as `/api/market/prices` and `/api/market/spx`.  Flatfile stays session-gated.  Rollout: `docs/rollouts/2026-08-20-peer-quotes-intraday-middleware.md`.
> **2026-08-20 CURSOR-BUGBOT — Tradier live pending_cancel scope (`cursor/tradier-live-pending-cancel-scope`).** Default getEquityOrders 24h filter must keep `isLiveOrderState` rows (pending_cancel / pending_replace), not a 4-state subset.  Distinct from #2947 page cap.  Rollout: `docs/rollouts/2026-08-20-tradier-live-pending-cancel-scope.md`.
> **2026-08-20 CURSOR-BUGBOT — #2953 intraday provider failure is 502 (`cursor/intraday-provider-fail-502`).** Empty bars only when a provider confirmed the window; credential/HTTP/timeout is 502 so CT can fall back.  Did not touch #2957/#2947/#2952.  Rollout: `docs/rollouts/2026-08-20-intraday-provider-fail-502.md`.
> **2026-08-20 CURSOR-BUGBOT — Owner-cancel stop tombstone on lookup miss (`cursor/owner-cancel-stop-tombstone-lookup`).** Use the tracked `broker_protective_stops` symbol when the advisory cancel lookup is empty so reconcile cannot re-place a stop the owner just cancelled.  Did not touch #2861.  Rollout: `docs/rollouts/2026-08-20-owner-cancel-stop-tombstone-lookup.md`.
> **2026-08-20 CURSOR — Stale hosting/stack copy sweep (`cursor/stale-hosting-docs-b392`).** Docs/metadata only.  Production is Coolify at socratictrade.com (README + GitHub About already said so — kept).  PLAN Current Status / acceptance still had Mac pm2 + `trading-beta`.  AGENTS leftover present-tense preview/PWA/Mac-pm2.  PWA UI retired #2801.  No product code.  Rollout: `docs/rollouts/2026-08-20-stale-hosting-docs.md`.
> **2026-08-20 CURSOR-BUGBOT — Tradier order-list page cap (`cursor/tradier-orders-page-cap-4f2a`).** #2886 default 5-page walk can hide a GTC equity protective stop; restore 50-page walk and keep the 24h terminal filter.  Did not touch Alpaca or #2861.  Rollout: `docs/rollouts/2026-08-20-tradier-orders-page-cap.md`.
> **2026-08-20 CURSOR-BUGBOT — Tradier order-list page cap (`cursor/tradier-orders-page-cap-4f2a`, #2947).** #2886 default 5-page walk can hide a GTC equity protective stop; restore 50-page walk and keep the 24h terminal filter.  Did not touch Alpaca or #2861.  Rollout: `docs/rollouts/2026-08-20-tradier-orders-page-cap.md`.
> **2026-08-20 CURSOR — Rebase #2818 (`cursor/delayed-yahoo-fallback-stamp-c120`).** Rebase-only onto `origin/main` `ce31c367`.  Stamp **Delayed Quote** on approval cards; keep trading.  Conflicts: DataSourcesSettings + HomeView — kept main.  Do not merge.  Rollout: `docs/rollouts/2026-08-18-delayed-yahoo-fallback-stamp.md`.
> **2026-08-20 CURSOR — #2854 rebased onto main (`ce31c367`).** CONFLICTING/DIRTY was phantom (`merge-tree` clean).  Kept gather inventory skip + 502/429 fail-open.  Did not absorb other clusters.  Do not merge.  Rollout: `docs/rollouts/2026-08-19-gather-no-pinecone-inventory.md`.
> **2026-08-20 CURSOR — #2854 rebased onto main (`eefc4f82`).** Real conflict was `test/roic-transcripts.test.ts` vs #2813.  Kept gather `shouldSkipWholeIndexInventory` test + main's skip-covered ROIC test.  Did not absorb #2813 product.  Do not merge.  Rollout: `docs/rollouts/2026-08-19-gather-no-pinecone-inventory.md`.

> **2026-08-20 CURSOR — Rebase #2841 onto `1d6bbf68` (`cursor/notification-history-parity-4bbc`).** After #2892/#2876/#2942/#2834.  Same inbox scope only.  One last-100 snapshot field.  Not merging.  Rollout: `docs/rollouts/2026-08-18-notification-history-parity.md`.
> **2026-08-20 CURSOR — Rebase #2841 onto current main (`cursor/notification-history-parity-4bbc`).** Rebased onto `origin/main` `ce31c367`.  Same notification-history scope only.  Kept main's `latestScan` snapshot field and this PR's last-100 inbox.  Not merging.  Rollout: `docs/rollouts/2026-08-18-notification-history-parity.md`.
> **2026-08-20 CURSOR — Rematch #2798 onto current main (`cursor/alert-noise-retired-boot-64c1`).** Unique leftover after #2799/#2800: 5 min live-boot connection-alert mute + stamp `intentionalOff` in `getServiceHealthSummaries`.  Kept main's `pineconeIngest` and kind-based hard-stop.  Rollout: `docs/rollouts/2026-08-17-alert-noise-retired-boot.md`.
> **2026-08-17 CURSOR — Alert-noise leftover (`cursor/alert-noise-retired-boot-64c1`).** Owner 4:23–4:38pm CT burst was mostly the 21:35Z Coolify restart plus leftover FilingAPI 401s and expected-limit 429s. Stamp retired vendors OFF in health summaries; ops-snapshot `ok` matches hard-stop only; mute connection pages for 5 min on live boot. Do not raise Pinecone/Anthropic/AV budgets. Rollout: `docs/rollouts/2026-08-17-alert-noise-retired-boot.md`.
> **2026-08-20 CURSOR — Web / iOS parity P1+P2 (`cursor/web-ios-parity-fixes-e83a`, #2942).** Implements audit #2804 findings: web/iOS deep-link focus, iOS Activity alerts, Exit-only copy, a11y, Watchlist cards, PWA UI deletion, Playwright 390 landmark smoke.  P3 backlog stays open (replace-at-market, widgets, wash-sale, Insights rename).  Dispatched verify green on `d52b354a`; merged `origin/main` `ee1286e0`.  Rollout: `docs/rollouts/2026-08-20-web-ios-parity-fixes.md`.

> **2026-08-19 CURSOR — Pinecone trial end in 7 days (`cursor/pinecone-trial-end-7d-c9a3`).** Owner: move the app Standard-trial snap from 2026-08-30 to 2026-08-27T00:00:00.000Z (7 days from 2026-08-19 21:59 CT). Infisical `PINECONE_TRIAL_ENDS_AT` + code default. Pinecone console trial unchanged. Daily WU fuse unchanged. Rollout: `docs/rollouts/2026-08-19-pinecone-trial-end-7d.md`.

> **2026-08-20 CURSOR — OCR CPU ceiling 5 of 8 (`cursor/deploy-freshness-ocr-isolate-d4cf`, #2545).** Default isolation cap is 5.0 vCPU (cpu-shares 256): as high as is reasonably advisable on the shared cx43.  Leaves 3 cores for Coolify/ST/UM.  CT compose `scan-cpu-worker` is still 2.0 -- raise that line to 5.0 for the durable cap.  Do not take prod down.  Rollout: `docs/rollouts/2026-08-17-deploy-freshness-ocr-isolate.md`.

> **2026-08-17 CURSOR — Deploy freshness + shared-box OCR isolation (`cursor/deploy-freshness-ocr-isolate-d4cf`, #2545).** Standing cron pages when the oldest undeployed main commit is >1h old (silent-freeze class: webhook 200s, health green on old sha).  Isolation script dry-runs a no-restart CPU cap on CT OCR/scan workers.  Remaining constraint: Coolify/CT-repo limits and retry-on-255 are not settable from this repo.  Do not take prod down.  Rollout: `docs/rollouts/2026-08-17-deploy-freshness-ocr-isolate.md`.
> **2026-08-20 CURSOR — Web / iOS parity P1+P2 (`cursor/web-ios-parity-fixes-e83a`).** Implements audit #2804 findings: web/iOS deep-link focus, iOS Activity alerts, Exit-only copy, a11y, Watchlist cards, PWA UI deletion, Playwright 390 landmark smoke.  P3 backlog stays open (replace-at-market, widgets, wash-sale, Insights rename).  Rollout: `docs/rollouts/2026-08-20-web-ios-parity-fixes.md`.
> **2026-08-20 CURSOR — Cross-app coordination follow-ups (`cursor/cross-app-coordination-followups-1212`).** ST slice of audit #2802 §7: vendor-era pin triangle, durable call-volume replay, `congress-read` usage label, Infisical merge-order, congress/Quiver doc refresh.  Peer CT/UM items stay on those repos.  Do not promote pin-check to required yet.  Do not mint a second Massive key.  Rollout: `docs/rollouts/2026-08-20-cross-app-coordination-followups.md`.

> **2026-08-20 CURSOR — Alert repeat lock (`cursor/alert-repeat-lock-2b9b`).** Cluster `alert-repeat-lock`.  **IN PR #2877.**  60s same-fingerprint delivery lock on `price_alert` (by id) plus `provider_degraded` / `budget_alert` / `kill_switch`.  Reuses `notification_events` sent rows.  Health/usage same-channel fallback no longer double-sends.  Did not revert #2865 or take `alert-push-delivery`.  Rollout: `docs/rollouts/2026-08-20-alert-repeat-lock.md`.

> **2026-08-19 CURSOR — Price alert evaluation (`cursor/fix-price-alert-evaluation-1a3d`).** Part II cluster `price-alert-evaluation`.  User-scoped `fetchFreshQuotesCascade`, logged `alert.check_error`, staleness gate, `isValidAppSymbol`.  Did not take on alert-push-delivery.  Rollout: `docs/rollouts/2026-08-19-price-alert-evaluation.md`.
> **2026-08-19 CURSOR — Session-aware market cache freshness (`cursor/market-cache-freshness-5ee3`).** Expert review cluster `market-cache-freshness` / mdi-01.  Friday intraday cache writes keep naive TTL; bar freshness is session-counted; early-close table added.  Sibling `quote-value-provenance` is a separate PR.  Rollout: `docs/rollouts/2026-08-19-market-cache-freshness.md`.
> **2026-08-20 CURSOR — Wire dead controls (`cursor/wire-dead-controls-8b69`).** Expert review `dead-controls` cluster: Results net-of-tax toggle, policy webhook Send test, Strategy preset CRUD.  Rollout: `docs/rollouts/2026-08-20-wire-dead-controls.md`.
> **2026-08-19 CURSOR — Account write guards (`cursor/account-write-guards-940d`).** Expert review tranche-1 `account-write-guards`.  Pin `strategyAuthority` on copy paths; block draining reactivation.  No new TypedConfirm.  Rollout: `docs/rollouts/2026-08-19-account-write-guards.md`.
> **2026-08-19 CURSOR — #2854 rebased onto main (`52add2ae`).** CONFLICTING/DIRTY after #2856/#2857/#2858.  `merge-tree` was clean; overlap was STATUS/PLAN/EFFORT-LOG only, not iOS.  Kept gather inventory skip + 502/429 fail-open.  Live still `a8a0a65b`; this morning's Roth/Paper runs hit 8m `strategy gather timeout`, Green never started.  Do not flip write-class or prune.  Do not touch #2841/#2849/#2850/#2856/#2857.  Do not merge / deploy / bounce / TF.  Rollout: `docs/rollouts/2026-08-19-gather-no-pinecone-inventory.md`.
> **2026-08-19 CURSOR — Broker I/O deadlines (`cursor/broker-io-deadlines-85a9`).** Part II `broker-io-deadlines`: deadlines on Alpaca quotes/place/cancel + Tradier fetch; scheduler protective lanes use `withDeadline`; default `getEquityOrders` scoped to open + 24h terminal.  Rollout: `docs/rollouts/2026-08-19-broker-io-deadlines.md`.
> **2026-08-19 CURSOR — Phone touch viewport (`cursor/phone-touch-viewport-b809`).** Review cluster `phone-touch-viewport`: chrome budget, 44px touch targets, overlay scroll-lock/history/visualViewport.  Did not take phone-layout-density or visual-tokens-theme-contrast.  Rollout: `docs/rollouts/2026-08-19-phone-touch-viewport.md`.
> **2026-08-19 CURSOR — FTS indexed mirror idempotency (`cursor/event-loop-pins-fts-indexed-mirror-5b2a`).** Part II `event-loop-pins`: side-key index + bounded mirror/yield/strategy gate on `persistLocalComplete` and filing-body ingest.  Did not flip write-class or prune.  Rollout: `docs/rollouts/2026-08-19-fts-indexed-mirror-idempotency.md`.
> **2026-08-19 CURSOR — Day P&L cash-flow cluster (`cursor/fix-day-pnl-cash-flows-56a3`).** Expert review `cash-flow-and-trading-day`: broker Alpaca activities as flow source; inference fallback with real fills + short/cover sign fix; shared Central trading-day helper for Day P&L, risk-breaker, and daily cap roll.  Rollout: `docs/rollouts/2026-08-19-day-pnl-cash-flow-cluster.md`.

> **2026-08-19 CURSOR — iOS web parity (`cursor/ios-web-parity-502f`, #2857).** #2856 is live on `main` (`a8a0a65b`); TF 1.0.68 is behind.  No leftover iOS slug join on current main.  Folds #2849 Desk subtitle; Home / Insights / Guardrails no longer send users to a missing Strategy page.  Do not merge / deploy / bounce / TF.  HOLD `5674dfaf`.  Do not touch #2841 / #2854 / #2840.  Rollout: `docs/rollouts/2026-08-19-ios-web-parity.md`.

> **2026-08-19 CURSOR — Indices common names (`#2856` `a8a0a65b` MERGED).** TF 1.0.68 is still the pre-#2855 binary.  Follow-up iOS chrome is `cursor/ios-web-parity-502f`.

> **2026-08-19 CURSOR — Indices labels (`#2855` `b27de85c` MERGED).** Follow-up is `cursor/indices-common-names-3381`.

> **2026-08-19 CURSOR — Robinhood quote chunk (`cursor/robinhood-quote-chunk-befc`, #2852).** Rebased onto #2853 `df1f5a37`.  Live `9d71dda4` died on `too many symbols (max 10, got 250)` 18s into gather.  Chunk Robinhood quote/tradability/fundamentals to 10.  Do not shrink the universe.  congress.trade 404 must not latch the free wave.  Do not reopen #2840 / #2848 / #2853.  Do not touch #2850 / #2849 / #2841.  Do not merge / deploy / bounce / TF.  Rollout: `docs/rollouts/2026-08-19-robinhood-quote-chunk.md`.
> **2026-08-19 CURSOR — Gather no Pinecone inventory + 502/429 fail-open (`cursor/gather-no-pinecone-inventory-befc`).** Same `9d71dda4` terminal.  Fold in #2852 (`c7b775c5`); do not replace the ≤10 Robinhood chunk.  Pause whole-index Pinecone list/fetch while a run is queued/running.  congress.trade 502 and Massive 429 fail-open.  No OpenRouter strategy/completion in that window — only `usage_budget_status` then the crash.  Do not flip write-class or prune.  Do not reopen #2840.  Do not touch #2850 / #2849 / #2841.  Do not merge / deploy / bounce.  Rollout: `docs/rollouts/2026-08-19-gather-no-pinecone-inventory.md`.
> **2026-08-19 CURSOR — Gather no Pinecone inventory + 502/429 fail-open (`cursor/gather-no-pinecone-inventory-befc`, #2854).** Same `9d71dda4` terminal.  Fold in #2852 (`c7b775c5`); do not replace the ≤10 Robinhood chunk.  Pause whole-index Pinecone list/fetch while a run is queued/running.  congress.trade 502 and Massive 429 fail-open.  No OpenRouter strategy/completion in that window — only `usage_budget_status` then the crash.  Do not flip write-class or prune.  Do not reopen #2840.  Do not touch #2850 / #2849 / #2841.  Do not merge / deploy / bounce.  Rollout: `docs/rollouts/2026-08-19-gather-no-pinecone-inventory.md`.

> **2026-08-19 CURSOR — Robinhood quote chunk (`#2852` `c7b775c5` MERGED).** Live `9d71dda4` died on `too many symbols (max 10, got 250)` 18s into gather.  Chunk Robinhood quote/tradability/fundamentals to 10.  Follow-up gather crumbs are `cursor/gather-no-pinecone-inventory-befc`.

> **2026-08-19 CURSOR — Manual Run once drain handoff (`#2853` `df1f5a37` MERGED).** Drain resumes a claimed Manual Run once with no live heartbeat.  Remaining gather-pricing hole is #2852.

> **2026-08-18 CURSOR — getAccounts loop budget + ROIC/FTS yield (`cursor/getaccounts-loop-budget-befc`, #2848).** VERIFY_FAIL: alpaca-mcp getAccount retry hung 60s under the 16s live wait.  Mock a short first-call budget in that test.  Sweep must not call a same-process stall a restart (Roth `b3b83913`).  Keep ROIC/FTS pause + 16s wait.  Do not skip the test.  Do not merge / deploy / bounce.  Rollout: `docs/rollouts/2026-08-18-getaccounts-loop-budget.md`.

> **2026-08-18 CURSOR — sweep-failed request lock (`#2847` `4abfb7fa` MERGED).** Leftover `running` request after sweep-failed `0e5ccd66` no longer locks Manual Run once.  Roth wrote `b3b83913` at 23:13:25Z.  Follow-up starvation is #2848.
> **2026-08-19 CURSOR — iOS Scan last-good on 503 (`cursor/ios-scan-last-good-503-b104`).** Live web Refresh keeps last-good; iOS did not.  503 cause: empty-screener Yahoo whole-set of ~5k names misses the 35s / edge budget before seed.  Seed first; snapshot `latestScan`; iOS keeps the universe.  Do not merge / deploy / bounce / second TestFlight / Manual Run.  Do not touch #2848/#2849/#2841/#2840.  Rollout: `docs/rollouts/2026-08-19-ios-scan-last-good-503.md`.
> **2026-08-19 CURSOR — iOS Scan last-good on 503 (`cursor/ios-scan-last-good-503-b104`, #2850).** Live web Refresh keeps last-good; iOS did not.  503 cause: empty-screener Yahoo whole-set of ~5k names misses the 35s / edge budget before seed.  Seed first; snapshot `latestScan`; iOS keeps the universe.  Do not merge / deploy / bounce / second TestFlight / Manual Run.  Do not touch #2848/#2849/#2841/#2840.  Rollout: `docs/rollouts/2026-08-19-ios-scan-last-good-503.md`.
> **2026-08-19 CURSOR — iOS Scan last-good on 503 (`cursor/ios-scan-last-good-503-b104`, #2850, rebased onto `c55c2e64`).** ASC: TF 1.0.68 `581467e1` already has #2830.  Live `/api/scan` still 503s without names.  Seed-first `/api/scan` is the 1.0.68 unblocker; iOS `latestScan` kept for the next TF.  Do not merge / deploy / bounce / second TestFlight.  Do not touch #2848/#2849/#2841/#2840.  Rollout: `docs/rollouts/2026-08-19-ios-scan-last-good-503.md`.

> **2026-08-18 CURSOR — sweep-failed request lock (`cursor/sweep-request-orphan-lock-befc`, #2847).** #2845 live; 0 new Roth `strategy_runs` after 22:06:43Z.  Orphan `0e5ccd66` sweep-failed 22:13:05Z (0 LLM) left the request `running`.  Close on sweep / `finishStrategyRun`; heal on tick and on the next click.  Portfolio `8000+7000ms` is a separate lock.  Do not merge / deploy / bounce.  Do not touch #2841.  Rollout: `docs/rollouts/2026-08-18-sweep-failed-request-lock.md`.

> **2026-08-18 CURSOR — getAccounts post-deploy timeout (`cursor/getaccounts-post-deploy-timeout-befc`).** Dashboard 6s `getAccounts` race fail-closes Manual Run once via `accountReadiness`.  Paper/Roth are Alpaca REST.  First-call retry + 15s combined budget; do not hide a real broker-down.  Do not bounce Coolify.  Rollout: `docs/rollouts/2026-08-18-getaccounts-post-deploy-timeout.md`.

> **2026-08-18 CURSOR — rag-embed DeepInfra batch-window (`#2840` `5674dfaf` MERGED).** Live 32-text embed POSTs 400 at 8193 tokens on baai/bge-m3 (batch-sum, not one unchunked 10-K).  Hybrid condense-first stayed; token-pack is after that step.  Isolate one over-limit condensed text; do not fail the companions.  Do not flip write-class or prune.  Do not re-clamp the #2800 fuse.  Rollout: `docs/rollouts/2026-08-18-rag-embed-batch-window.md`.
> **2026-08-18 GROK — Live prod triage (`grok/prod-triage-2026-08-18`, #2833).** Rematch #2831/#2830 so Autopilot and Scan can recover.  Unclaimed code: coalesce Alpaca `getAccount` (Roth dashboard 6s timeout).  Do not rewrite Cursor money-path PRs.  Do not touch L2/L3 B2.  Rollout: `docs/rollouts/2026-08-18-prod-triage-alpaca-account-cache.md`.
> **2026-08-18 GROK — Week-error expert triage (`grok/prod-triage-2026-08-18`, #2833 / #2834).** Team inventory of last-7d errors + iOS shots.  This PR: Alpaca getAccount cache + iOS Scan/Home honesty.  Do not rewrite #2830/#2831/#2817.  Do not mint OpenRouter.  L2/L3 owner-ops.  Rollouts: `docs/rollouts/2026-08-18-prod-triage-alpaca-account-cache.md`, `docs/rollouts/2026-08-18-week-error-expert-triage.md`.
> **2026-08-18 GROK — OpenRouter + data cascade (`grok/prod-triage-2026-08-18`, #2834).** Owner: cascade and OpenRouter failing.  This PR now takes stuck #2831 (Green 400 failover) and #2830 (Nasdaq UA + Yahoo fallback) because PR-attached verify never went green.  Leave #2840 embed 8192 pack to Cursor.  Do not mint OpenRouter keys.  Rollout: `docs/rollouts/2026-08-18-openrouter-and-cascade.md`.
> **2026-08-18 CURSOR — IRA Ignore/Block were already the options (`cursor/ira-wash-sale-factor-a1df`).** Did not add a third mode.  Ignore still steered Green and fed fake forfeited-deduction dollars; min-loss was hidden on IRA and unused on the buyer path.  Wiring + prompt `agentic-strategy@2.13.0` now match the existing settings.  Rollout: `docs/rollouts/2026-08-18-ira-wash-sale-existing-options.md`.
> **2026-08-18 CURSOR — IRA Ignore / Auto / Block + optional min-loss (`cursor/ira-wash-sale-factor-a1df`).** Owner: min-loss is optional; Auto must be a choosable IRA option.  Prompt `agentic-strategy@2.14.0`.  Rollout: `docs/rollouts/2026-08-18-ira-wash-sale-existing-options.md`.
> **2026-08-18 CURSOR — notification history + web/iOS inbox (`cursor/notification-history-parity-4bbc`).** Reopen later alerts on both surfaces from existing `notification_events`.  Header inbox + Activity Alert Center on web; Activity Notifications on iOS.  Last 100.  No new push backend.  Leave trading / OpenRouter / RAG / health alone.  Rollout: `docs/rollouts/2026-08-18-notification-history-parity.md`.
> **2026-08-18 CURSOR — notification history rebased onto main (`cursor/notification-history-parity-4bbc`, #2841).** Rebased onto `origin/main` `13b60747` (#2830 + #2832).  Kept #2830 scan-copy tests and this PR's inbox copy test.  Dropped silent-duplicate `acknowledgeNotifications`.  History work unchanged.  Not merging.  Rollout: `docs/rollouts/2026-08-18-notification-history-parity.md`.

> **2026-08-18 CURSOR — rag-embed soft-degrade rebase (`cursor/rag-embed-soft-degrade-ed6d`, #2812).** Rebased onto `origin/main` `6429d984`.  One dead rag-embed must not 503 Docker or halt Green/Red.  Kept #2800 fuse fix and #2829 `require_parameters` narrowing.  Sole conflict was `docs/phase-7-strategy.md`.  Rollout: `docs/rollouts/2026-08-18-rag-embed-soft-degrade.md`.
> **2026-08-18 CURSOR — iOS Scan empty table is a quote miss (`cursor/scan-empty-screener-a128`).** Owner 12:03pm CT: iOS Scan showed "0 names · 2 watched" / "No Candidates" after a 200 `topCandidates: []`.  Watchlist is not the universe.  Empty screener + expired seed now 503s; iOS shows scan counts + warnings.  Yahoo-fallback covers the whole allowed set.  Not stacked on #2829 / #2800 / reserved PRs.  Rollout: `docs/rollouts/2026-08-18-scan-empty-screener.md`.
> **2026-08-18 CURSOR — iOS Scan empty table is a quote miss (`cursor/scan-empty-screener-a128`, #2830).** Live cause: stub `"Mozilla/5.0"` UA + bare 8s abort on `fetchNasdaqScreener`.  Now `BROWSER_UA` + `fetchWithRetry`.  Yahoo whole-set fallback if Nasdaq still fails.  503 last resort.  Rebased onto `origin/main` (`6429d984`).  Rollout: `docs/rollouts/2026-08-18-scan-empty-screener.md`.
> **2026-08-18 CURSOR — iOS Scan empty table is a quote miss (`cursor/scan-empty-screener-a128`, #2830).** Coolify `d0359642`: 505 scanned / 0 quotes / abort, written as `market_scan`.  Last good `2f2a8e11`.  Not empty-universe / not ranker-zero / not #2829.  `BROWSER_UA` + `fetchWithRetry`; Yahoo whole-set; 503 + `market_scan_failed`; iOS shows warnings + counts.  Rollout: `docs/rollouts/2026-08-18-scan-empty-screener.md`.
> **2026-08-18 CURSOR — iOS Scan empty table is a quote miss (`cursor/scan-empty-screener-a128`, #2830).** Abort cause: 8s `controller.abort()` in `fetchNasdaqScreener` (no reason; timer held through 8000-row JSON) plus stub `"Mozilla/5.0"` UA.  Not the 20s deadline.  `BROWSER_UA` + clear timer on headers + Yahoo whole-set + 503.  Not #2829.  Rollout: `docs/rollouts/2026-08-18-scan-empty-screener.md`.
> **2026-08-18 CURSOR — iOS Scan empty table is a quote miss (`cursor/scan-empty-screener-a128`, #2830).** Root cause: 8s stub-UA abort in `fetchNasdaqScreener` (`setTimeout(() => controller.abort(), 8000)` + `"Mozilla/5.0"`, no Origin/Referer).  Not the 20s deadline.  Shared `BROWSER_UA` helper (scan + congress-share), 15s timeout, one abort retry, Yahoo whole-set, 503 if both miss.  Not #2829.  Rollout: `docs/rollouts/2026-08-18-scan-empty-screener.md`.
> **2026-08-18 CURSOR — Nasdaq screener UA + retry so Scan returns names (`cursor/scan-empty-screener-a128`, #2830).** `fetchNasdaqScreener` now uses the same `BROWSER_UA` + Origin/Referer + `fetchWithRetry` as nasdaq quote/calendar.  Yahoo-fallbacks the whole allowed set if Nasdaq returns 0.  Not an empty-state-copy PR.  Not #2829.  Rollout: `docs/rollouts/2026-08-18-scan-empty-screener.md`.
> **2026-08-18 CURSOR — Nasdaq screener UA + retry so Scan returns names (`cursor/scan-empty-screener-a128`, #2830).** `fetchNasdaqScreener` uses `BROWSER_UA` + Origin/Referer + `fetchWithRetry`.  Yahoo whole allowed set if Nasdaq returns 0.  iOS exhaustive `.scanQuotesUnavailable`.  Rebased onto `7b073b65` (includes #2812).  Did not revert #2812 / #2829 / #2800.  Does not block #2831.  Rollout: `docs/rollouts/2026-08-18-scan-empty-screener.md`.
> **2026-08-18 CURSOR — Green 400 failover rebased onto #2830 (`cursor/green-400-failover-terra-2639`, #2831).** Rebased onto `origin/main` `13b60747`.  400 stays failover-eligible; exhausted suffix counts stored calls; terra is not first Green pick.  Did not touch #2812/#2840/#2841.  Rollout: `docs/rollouts/2026-08-18-green-400-failover.md`.
> **2026-08-18 CURSOR — Green 400 failover rebased onto #2812 (`cursor/green-400-failover-terra-2639`, #2831).** Rebased onto `origin/main` `12e8dcd`.  Sole conflict `docs/phase-7-strategy.md` — kept #2812 rag-embed soft-degrade.  400 stays failover-eligible; exhausted suffix counts stored calls; terra is not first Green pick.  Do not revert #2812/#2829/#2800.  Rollout: `docs/rollouts/2026-08-18-green-400-failover.md`.
> **2026-08-18 CURSOR — rag-embed soft-degrade rebase (`cursor/rag-embed-soft-degrade-ed6d`, #2812).** MERGED as `12e8dcd`.  One dead rag-embed must not 503 Docker or halt Green/Red.  Kept #2800 fuse fix and #2829 `require_parameters` narrowing.  Rollout: `docs/rollouts/2026-08-18-rag-embed-soft-degrade.md`.
> **2026-08-18 CURSOR — Green 400 must actually fail over (`cursor/green-400-failover-terra-2639`).** First Green after #2829 (`6429d984`) still died on one OpenRouter 400 (`openai/gpt-5.6-terra` "Provider returned error") while claiming 3 endpoints and never calling Red.  Add 400 to `isFailoverLlmStatus` (not `isRetryableLlmStatus`).  Count stored Green calls for the exhausted suffix.  Do not pick terra first when Gemini Flash / Mistral Medium seats remain.  Do not revert #2829/#2800.  Do not rewrite the 400 sentence.  Rollout: `docs/rollouts/2026-08-18-green-400-failover.md`.

> **2026-08-18 CURSOR — Pinecone daily-fuse deadlock (`cursor/pinecone-write-deadlock-64c1`, #2800).** Rebased onto main (hybrid #2820 live).  Do not clamp the trial daily fuse to leftover local-MTD remainder (that is the 15-WU / 1-text skip).  Local MTD is not Pinecone's bill — pre-hybrid full-body writes can make it look spent.  Keep Yahoo VIX as failover; do not re-probe it while Cboe is serving.  Do not flip write-class or `--apply` prune.  Rollout: `docs/rollouts/2026-08-17-pinecone-write-deadlock.md`.

> **2026-08-18 CURSOR — OpenRouter rotation alias miss (`cursor/openrouter-rotation-alias-fb04`).** Green "not on your OpenRouter account" is a false classification.  Family-match `/models/user`, fail-open if the allowlist would empty a keyed pool, honest copy unless chat 404/403 body is model-not-found / no-access, failover 404/403 to the next Green/Red model.  Keep rotate.  No dashboard adds, no Stripe.  Rollout: `docs/rollouts/2026-08-18-openrouter-rotation-alias-failopen.md`.
> **2026-08-18 CURSOR — OpenRouter rotation alias miss (`cursor/openrouter-rotation-alias-fb04`, #2829).** Green "not on your OpenRouter account" is a false classification.  Family-match `/models/user`, fail-open if the allowlist would empty a keyed pool, honest copy unless chat 404/403 body is model-not-found / no-access, failover 404/403 to the next Green/Red model.  Keep rotate.  No dashboard adds, no Stripe.  Rollout: `docs/rollouts/2026-08-18-openrouter-rotation-alias-failopen.md`.
> **2026-08-18 CURSOR — OpenRouter "No endpoints" 404 is not an account miss (`cursor/openrouter-rotation-alias-fb04`, #2829).** Primary: #2771 `require_parameters=true` + any-404 account sentence.  Narrow require_parameters to OpenAI reasoning + `max_completion_tokens`; 404 "No endpoints found matching your request" is a routing miss.  Secondary: `/models/user` alias fail-open.  Keep rotate.  No dashboard adds, no Stripe.  Rollout: `docs/rollouts/2026-08-18-openrouter-rotation-alias-failopen.md`.
> **2026-08-18 CURSOR — OpenRouter 404s are not an account miss (`cursor/openrouter-rotation-alias-fb04`, #2829).** Two causes: #2771 `require_parameters` routing 404s, and untilded `-latest` wire ids (`anthropic/claude-sonnet-latest` is not in the live catalog; `~anthropic/claude-sonnet-latest` / `anthropic/claude-sonnet-5` are).  Prefer dated public ids; `~` optional on availability.  Classifier: no-endpoint 404 ≠ account; `model_not_found` = bad slug.  Keep rotate.  No dashboard adds, no Stripe.  Rollout: `docs/rollouts/2026-08-18-openrouter-rotation-alias-failopen.md`.
> **2026-08-18 CURSOR — Today's Green 404s are gemini/mistral public slugs (`cursor/openrouter-rotation-alias-fb04`, #2829).** Coolify: Paper 17:12Z `google/gemini-3.7-flash` 404 86ms; Roth 17:01Z `mistralai/mistral-medium-3-5` 404 82ms.  Both exist on /models.  Primary: stop sending `require_parameters=true` on those bodies (#2771).  Classifier: that 404 is not an account miss.  Tilde restore is secondary — those seats were skipped, not called.  Keep rotate.  No dashboard adds, no Stripe.  Rollout: `docs/rollouts/2026-08-18-openrouter-rotation-alias-failopen.md`.
> **2026-08-18 CURSOR — IRA no tax-loss harvest (`cursor/ira-no-tax-loss-harvest-a1df`).** Green was harvesting losers on the Roth (NWG).  IRA runs no longer get taxable harvest instructions or `harvestableLosses`.  Taxable accounts unchanged.  Rollout: `docs/rollouts/2026-08-18-ira-no-tax-loss-harvest.md`.
> **2026-08-18 CURSOR — Mobile tab bar Safari chrome gap (`cursor/mobile-tabbar-chrome-gap-23d5`).** Browser pad is 22% of `env(safe-area-inset-bottom)` (~78% of the grey-blue band gone). Solid `--con-surface` bar + `::after` under the URL chrome. No negative-bottom shift. Standalone/PWA keeps the full env() pad. Rollout: `docs/rollouts/2026-08-18-mobile-tabbar-chrome-gap.md`.
> **2026-08-18 CURSOR — iOS UX owner cut (`cursor/ios-ux-owner-cut-bdae`, #2825).** Rebased onto `main` (`995b7eee`).  IRA wash-sale N/A; lowercase “rotate models”; full jargon sweep; Ask-First ↔ Autopilot + % NAV on device.  Kept #2815 legal clickwrap and #2821 budget rows.  Did not steal reserved PRs.  Rollout: `docs/rollouts/2026-08-18-ios-ux-owner-cut.md`.
> **2026-08-18 CURSOR — Per-user LLM daily budget in Settings/iOS — MERGED #2821 `972e3763`.** Live cap is `user_settings.llm_daily_budget`.  When set, spend primitives + chat + strategy skip fail-closed.  `RAG_RUN_BUDGET_*` is a Data Sources setting.  System secrets stay Infisical.  Rollout: `docs/rollouts/2026-08-18-user-llm-daily-budget.md`.

> **2026-08-18 CURSOR — Litestream restore drill (`cursor/restore-receipts-followup-2cd9`, #2824).** Docs-only pin after #2823 flipped decrypt + R2 retain=1 to VERIFIED (#2822 had merged the stale BLOCKED / NOT VERIFIED rows).  Coolify `watch_paths` now omits `docs/**`, `STATUS.md`, `PLAN.md` — should not rebuild.  Rollout: `docs/rollouts/2026-08-17-litestream-restore-drill.md`.
> **2026-08-18 CURSOR — Paper/live pooling truth + paper cost = OOS 20 bps (`cursor/paper-live-docs-cost-68d3`).** Owner cut 2026-08-17: paper→live pooling stays; delete the leftover 20-paper+5-live transfer gate from current-truth docs. Paper execution-cost default rises from 1 bp to the shared `OOS_ROUND_TRIP_COST_BPS` / `PAPER_DEFAULT_BASE_SLIPPAGE_BPS` (20). No `autoApplyWeights`. No Stripe. Did not touch #2792/#2798/#2800/#2794. Rollout: `docs/rollouts/2026-08-18-paper-live-pooling-cost.md`.


> **2026-08-18 CURSOR — Hybrid AND prune (`cursor/hybrid-and-prune-7f41`).** Implement the #2811 hybrid: processed operational writes (highlights + signal sections + speaker turns) via a minimum writer split.  Do not flip `RAG_PINECONE_WRITE_CLASS` until PR B hydrate exists.  Prune junk/HTML/dupes/low-value only; keep useful only-copies.  Keep 2.5M fuse + $45 reserve.  No Stripe.  Leave #2800 remainder deadlock alone.  Rollout: `docs/rollouts/2026-08-18-hybrid-and-prune.md`.
> **2026-08-18 CURSOR — Legal clickwrap + mandatory data-pool (`cursor/legal-clickwrap-data-pool-1016`).** Owner cut items 9–11.  Versioned dismissible clickwrap; mandatory market-data share; keep `/welcome` and second-email isolation.  No Stripe/IAP.  Rollout: `docs/rollouts/2026-08-18-legal-clickwrap-data-pool.md`.
> **2026-08-18 CURSOR — Legal clickwrap + mandatory data-pool (`cursor/legal-clickwrap-data-pool-1016`, PR #2815).** Owner cut items 9–11.  Versioned dismissible clickwrap; mandatory market-data share; keep `/welcome` and second-email isolation.  No Stripe/IAP.  iOS sheet inlined in `SocraticTradeApp.swift` (pbxproj).  Rollout: `docs/rollouts/2026-08-18-legal-clickwrap-data-pool.md`.
> **2026-08-18 CURSOR — rag-embed soft-degrade (`cursor/rag-embed-soft-degrade-ed6d`, #2812).** One dead rag-embed must not 503 Docker, restart the container, re-halt Green/Red, or park later embed batches.  Degrade `rag-embed`/`rag-rerank` like OpenRouter credits.  `pinecone` + `alpaca-broker` stay critical.  Rebased onto `6429d984`; kept #2800/#2829.  Did not steal #2792/#2798/#2800/#2794.  Rollout: `docs/rollouts/2026-08-18-rag-embed-soft-degrade.md`.
> **2026-08-18 CURSOR — Delayed Yahoo fallback stamp (`cursor/delayed-yahoo-fallback-stamp-c120`).** When the quote cascade falls to delayed Yahoo, stamp **delayed fallback** on website + iOS approval cards and KEEP TRADING.  Age the fetch snapshot, not the 15m print.  Do not fail-closed openings.  Do not skip Green/Red.  Do not steal #2792/#2798/#2800/#2794.  Rollout: `docs/rollouts/2026-08-18-delayed-yahoo-fallback-stamp.md`.
> **2026-08-18 CURSOR — Delayed Yahoo fallback stamp (`cursor/delayed-yahoo-fallback-stamp-c120`).** When the quote cascade falls to delayed Yahoo, stamp user-facing **Delayed Quote** on website + iOS approval cards and KEEP TRADING.  No coordinator notes in card/iOS copy.  Age the fetch snapshot, not the 15m print.  Do not fail-closed openings.  Do not skip Green/Red.  Do not steal #2792/#2798/#2800/#2794.  Rollout: `docs/rollouts/2026-08-18-delayed-yahoo-fallback-stamp.md`.
> **2026-08-18 CURSOR — Litestream restore drill (`cursor/litestream-restore-drill-2cd9`, #2822).** Report only.  ASC re-verified decrypt (`fred` last-4 `6dd4`) and R2 weekly retain=1.  Nothing from this drill remains BLOCKED or NOT VERIFIED.  Do not change product code.  Do not touch live Coolify.  Do not add rolling/zero-downtime.  Rollout: `docs/rollouts/2026-08-17-litestream-restore-drill.md`.
> **2026-08-18 CURSOR — iOS owner-note UI copy (`cursor/ios-no-owner-note-ui-5139`).** Product copy only on iOS.  Remove Home Desk `full surfaces, not just the remote` and the same class of leaked coordinator strings.  Do not steal #2792/#2798/#2800/#2794.  Rollout: `docs/rollouts/2026-08-18-ios-no-owner-note-ui.md`.
> **2026-08-18 CURSOR — ROIC Individual local archive (`cursor/roic-individual-archive-9ad4`).** Resume-from-cache only: skip list/fetch when `earningscalls_transcripts` or `data/roic-artifacts` already cover the phase.  Persist artifacts + call-index.  Ops `roicArchive` lists remaining gaps.  Renew-vs-expire still open.  No Stripe.  Do not touch FilingAPI / #2800 / #2798 / #2794 / #2792.  Rollout: `docs/rollouts/2026-08-18-roic-individual-archive.md`.
> **2026-08-18 CURSOR — ROIC Individual local archive (`cursor/roic-individual-archive-9ad4`, PR #2813).** Resume-from-cache only: skip list/fetch when `earningscalls_transcripts` or `data/roic-artifacts` already cover the phase.  Persist artifacts + call-index.  Ops `roicArchive` lists remaining gaps.  Rebased 2026-08-20 onto `d3e2c9ee` (#2892); kept #2848 pause.  Renew-vs-expire still open.  No Stripe.  Did not absorb other clusters.  Rollout: `docs/rollouts/2026-08-18-roic-individual-archive.md`.
> **2026-08-18 CURSOR — Health JSON monitors (`cursor/health-json-monitors-ac72`).** Page UptimeRobot/Pushover on `schedulerStale`, `tradingLiveness.degraded`, `litestreamTiersDegraded` while HTTP 200 stays up.  Do not 503 those flags.  OPS token required (no admin fallback).  R2 weekly retain=1.  Runbook: `docs/runbooks/uptime-health-json-monitors.md`.
> **2026-08-18 CURSOR — Health JSON monitors (`cursor/health-json-monitors-ac72`, PR #2816).** Page UptimeRobot/Pushover on `schedulerStale`, `tradingLiveness.degraded`, `litestreamTiersDegraded` while HTTP 200 stays up.  Do not 503 those flags.  OPS token required (no admin fallback).  Live leftover `R2_ARCHIVE_KEEP_GENERATIONS=2` is ignored; weekly keep-generations is 1 in code.  No Coolify edits and no live R2 deletes.  Runbook: `docs/runbooks/uptime-health-json-monitors.md`.
> **2026-08-18 CURSOR — Health JSON monitors (`cursor/health-json-monitors-ac72`, PR #2816).** Page UptimeRobot/Pushover on `schedulerStale`, `tradingLiveness.degraded`, `litestreamTiersDegraded` while HTTP 200 stays up.  Do not 503 those flags.  OPS token required (no admin fallback).  Weekly R2 retain is already verified at 1; unused `R2_ARCHIVE_KEEP_GENERATIONS=2` does not drive it.  No Coolify edits and no live R2 deletes.  Runbook: `docs/runbooks/uptime-health-json-monitors.md`.

> **2026-08-18 CURSOR — Health JSON monitors (`cursor/health-json-monitors-ac72`, PR #2816).** Rebased onto `main`.  Page UptimeRobot/Pushover on `schedulerStale`, `tradingLiveness.degraded`, `litestreamTiersDegraded` while HTTP 200 stays up.  Do not 503 those flags.  OPS token required (no admin fallback).  Weekly R2 retain is already verified at 1; unused `R2_ARCHIVE_KEEP_GENERATIONS=2` does not drive it.  No Coolify edits and no live R2 deletes.  Runbook: `docs/runbooks/uptime-health-json-monitors.md`.
> **2026-08-18 CURSOR — Coolify RTH deploy latch (`cursor/rth-deploy-latch-c039`).**  Weekday regular US equity hours refuse the Coolify **image build** unless `HOTFIX=1` or `RTH_DEPLOY_OVERRIDE=1`.  Failed builds do not swap the running container.  Evenings/weekends still auto-deploy.  Drain workflow retries after the cash close.  Do not steal #2792/#2798/#2800/#2794.  Rollout: `docs/rollouts/2026-08-18-rth-deploy-latch.md`.
> **2026-08-18 CURSOR — Coolify RTH + image-noop latch (`cursor/rth-deploy-latch-c039`, #2817).**  Weekday RTH refuses the image build unless `HOTFIX=1` / `RTH_DEPLOY_OVERRIDE=1`.  Docs-only / image-noop (the #2811 503 class) is also refused before `npm ci`.  Keep consistent-name; no rolling / no dual Litestream writer.  Build then stop-old-start-new.  Do not bounce prod, `FORCE_RESTORE`, or PATCH Coolify from this agent.  Rollout: `docs/rollouts/2026-08-18-rth-deploy-latch.md`.
> **2026-08-18 CURSOR — Coolify RTH + image-noop latch + `/api/live` (`cursor/rth-deploy-latch-c039`, #2817).**  Weekday RTH refuses the image build unless `HOTFIX=1` / `RTH_DEPLOY_OVERRIDE=1`.  Docs-only / image-noop is refused before `npm ci`.  Keep stop-old-first and consistent-name; no rolling.  Docker HEALTHCHECK is `/api/live` so a finished deploy cannot leave Traefik `running:unhealthy` for ~20 extra minutes while the process is up (#2810 window).  Do not bounce prod, `FORCE_RESTORE`, or PATCH Coolify.  Rollout: `docs/rollouts/2026-08-18-rth-deploy-latch.md`.
> **2026-08-18 CURSOR — Coolify RTH latch; `watch_paths` already live (`cursor/rth-deploy-latch-c039`, #2817).**  ASC applied `watch_paths` on `socratic-app` (`d83b1aykr03uwr32yhgzaiay`); do not re-apply.  Auto-deploy on.  Stop-old-first kept.  `health_check_start_period` 60.  This PR still blocks weekday RTH image builds unless `HOTFIX=1` and points HEALTHCHECK at `/api/live`.  Do not bounce prod, `FORCE_RESTORE`, or PATCH Coolify.  Rollout: `docs/rollouts/2026-08-18-rth-deploy-latch.md`.
> **2026-08-18 CURSOR — Coolify RTH latch; `watch_paths` already live (`cursor/rth-deploy-latch-c039`, #2817).**  ASC applied `watch_paths` on `socratic-app` (`d83b1aykr03uwr32yhgzaiay`); do not re-apply.  Auto-deploy on.  Stop-old-first kept.  `health_check_start_period` 60.  This PR still blocks weekday RTH image builds unless `HOTFIX=1` and points HEALTHCHECK at `/api/live`.  Rebased onto `main` after #2824.  Do not bounce prod, `FORCE_RESTORE`, or PATCH Coolify.  Rollout: `docs/rollouts/2026-08-18-rth-deploy-latch.md`.

> **2026-08-18 CURSOR — Litestream restore drill (`cursor/restore-receipts-followup-2cd9`, #2824).** Docs-only pin after #2823 flipped decrypt + R2 retain=1 to VERIFIED (#2822 had merged the stale BLOCKED / NOT VERIFIED rows).  Coolify `watch_paths` now omits `docs/**`, `STATUS.md`, `PLAN.md` — should not rebuild.  Rollout: `docs/rollouts/2026-08-17-litestream-restore-drill.md`.

> **2026-08-18 CURSOR — Pinecone store vs condense (`cursor/pinecone-store-vs-condense-ce2b`).** Report only.  Recommended default is hybrid: processed proposer corpus in Pinecone, full bodies local, hydrate after A+B.  Do not fill Builder with raw 10-K/Q/transcripts.  Do not flip `RAG_PINECONE_WRITE_CLASS`.  Do not raise the 2.5M WU fuse.  Audit: `docs/audits/2026-08-18-pinecone-store-vs-condense.md`.

> **2026-08-17 CURSOR — Blind-spots audit (`cursor/blind-spots-audit-299e`).** Read-only red-team register across legal/fintech, product identity, a11y-beyond-#2795, i18n, DX, tests, observability, vendor/cost, docs, and ops calendars.  No production code.  `docs/audits/2026-08-17-blind-spots.md`.  Rollout: `docs/rollouts/2026-08-17-blind-spots.md`.

> **2026-08-17 CURSOR — Purchases / Stripe / StoreKit audit (`cursor/purchases-stripe-storekit-audit-f1c0`).** Report only.  ST is invite-only with no checkout stack.  Do not implement Stripe or StoreKit unless the owner decides to sell.  Audit: `docs/audits/2026-08-17-purchases-stripe-storekit.md`.

> **2026-08-17 CURSOR — Cross-app coordination audit (`cursor/cross-app-coordination-audit-1212`).** Report only.  Pins match CTS `v2.5.2`; ST pin-check is a no-op against vendor-era CT.  Independent-failure matrix and P1–P3 portfolio fixes in `docs/audits/2026-08-17-cross-app-coordination.md`.  Do not implement those fixes in this PR.
> **2026-08-17 CURSOR — Web / iOS / mobile-web parity audit (`cursor/web-ios-parity-audit-e83a`).** Report-only.  Clients are desktop `/console`, phone-width `/console`, and native iOS.  PWA stays retired.  Implementation slices A–F are listed in `docs/audits/2026-08-17-web-ios-parity.md` §16.  Do not start those in this PR.  Rollout: `docs/rollouts/2026-08-17-web-ios-parity-audit.md`.
> **2026-08-17 CURSOR — Trading-outcomes audit (`cursor/trading-outcomes-audit-c37a`).** Read-only.  Report at `docs/audits/2026-08-17-trading-outcomes.md`.  No money-path changes.  Follow-ups are test/eval only (Tier A in the report) plus a Phase 7 paper/live doc reconciliation.  Do not enable `autoApplyWeights` or LLM historical eval from this note.  Rollout: `docs/rollouts/2026-08-17-trading-outcomes-audit.md`.
> **2026-08-17 CURSOR — Architecture & backend audit (`cursor/architecture-backend-audit-6186`).** Docs-only.  No product fixes, no schema, no runtime change.  Report at `docs/audits/2026-08-17-architecture-backend.md`.  Follow-up implementation is a later PR (F3 stale run-request sweep first).  Rollout: `docs/rollouts/2026-08-17-architecture-backend-audit.md`.
> **2026-08-17 CURSOR — RAG / learning / recall audit (`cursor/rag-learning-recall-audit-f94a`).** Report-only.  Evidence, severity, quantitative eval recs, and a gold-set plan in `docs/audits/2026-08-17-rag-learning-recall.md`.  No product-code change.  P0 follow-ups (not this PR): parsed-text SEC worker, production-eval merge gate on `retrieveContextDetailed`, `asOf` on chat/desk.  Rollout: `docs/rollouts/2026-08-17-rag-learning-recall-audit.md`.
> **2026-08-20 CURSOR — RAG P0 follow-ups (`cursor/rag-learning-recall-audit-f94a`, #2803).** `buildSecDocument` (no raw HTML), ticker→CIK without sentinel, chat `asOf` default now, eval harness on `retrieveContextDetailed`.  Rollout: `docs/rollouts/2026-08-20-rag-p0-followups.md`.

> **2026-08-17 CURSOR — RAG / learning / recall audit (`cursor/rag-learning-recall-audit-f94a`).** Report-only.  Evidence, severity, quantitative eval recs, and a gold-set plan in `docs/audits/2026-08-17-rag-learning-recall.md`.  P0 follow-ups landed 2026-08-20.  Rollout: `docs/rollouts/2026-08-17-rag-learning-recall-audit.md`.
> **2026-08-17 CURSOR — Security / reliability audit (report-only, `cursor/security-reliability-audit-d8f6`).** Evidence-backed findings in `docs/audits/2026-08-17-security-reliability.md`.  No runtime change.  Owner-gated follow-ups: B2 restore drill + decrypt, Coolify single Litestream writer, ops-token split, JSON-field paging.  Rollout: `docs/rollouts/2026-08-17-security-reliability-audit.md`.
> **2026-08-17 CURSOR — Brokers + data-cascade audit (`cursor/brokers-data-cascade-audit-bed0`).** Report-only.  Evidence at `docs/audits/2026-08-17-brokers-data-cascade.md`.  Accounts for #2792 FilingAPI soft-skip vs merged #2787 retirement.  No broker mutations.  Follow-ups are listed in the audit, not implemented here.  Rollout: `docs/rollouts/2026-08-17-brokers-data-cascade-audit.md`.
> **2026-08-17 CURSOR — Remove leftover installable PWA (`cursor/retire-pwa-72cb`).** Delete the unused `/mobile` client, drop the standalone web-app manifest and `appleWebApp`, 410 `/manifest.webmanifest`, unregister leftover service workers, keep `/api/mobile/*` for iOS and responsive `/console`. Rollout: `docs/rollouts/2026-08-17-retire-pwa.md`.

> **2026-08-17 CURSOR — Pinecone trial WU + Litestream/FilingAPI alert noise (`cursor/pinecone-wu-trial-alerts-c9a3`).** Standard trial is usage-billed, not the Starter 2M monthly wall. Clear/ignore the monthly WU breaker and monthly pace budget while the trial is open. Ignore healed Litestream compaction-fail lines. Omit retired vendors from public `/api/health` dependencies. Do not raise the daily WU fuse. Rollout: `docs/rollouts/2026-08-17-pinecone-trial-wu-alerts.md`.
> **2026-08-17 CURSOR — Pinecone daily-fuse deadlock (`cursor/pinecone-write-deadlock-64c1`).** Do not clamp the trial daily fuse to leftover local-MTD remainder (that is the 15-WU / 1-text skip). Keep Yahoo VIX as failover; do not re-probe it while Cboe is serving. 429s are not a healthy expected outcome. CT OpenRouter prepaid-minimum is a leftover stored halt — owner has >$50. Rollout: `docs/rollouts/2026-08-17-pinecone-write-deadlock.md`.

> **2026-08-17 CURSOR — Pinecone trial WU + Litestream/FilingAPI alert noise (`cursor/pinecone-wu-trial-alerts-c9a3`).** Merged as #2799 `4980322b`. Standard trial is usage-billed, not the Starter 2M monthly wall. Daily remainder clamp is the follow-up above. Rollout: `docs/rollouts/2026-08-17-pinecone-trial-wu-alerts.md`.

> **2026-08-17 CURSOR — Settings search in ⌘K (`cursor/settings-search-palette-6e98`, #2558).** Wire the existing `searchSettings` catalog into the command palette; drop phantom `defaultLandingAccount`. Rollout: `docs/rollouts/2026-08-17-settings-search-palette.md`.
> **2026-08-17 CURSOR — iOS release-readiness leftovers (`cursor/ios-release-readiness-2560-b532`, #2560).** Close-only/Wind-down + APNs already on main. Add privacy manifest, Safari console handoffs, honest alert copy. Owner still owns Infisical `APNS_*` (.p8). Rollout: `docs/rollouts/2026-08-17-ios-release-readiness.md`.
> **2026-08-17 CURSOR — P3 curl-only UI entry (`cursor/p3-curl-only-ui-2563-814a`, #2563).**
> Wire existing `tuning-dry-run`, `learning-ledger`, `backtest-ic`, and `/api/audit`
> into Strategy / Lessons / Admin / Activity.  No server-behavior change.  Rollout:
> `docs/rollouts/2026-08-17-curl-only-ui-entry.md`.
> **2026-08-17 CURSOR — Console a11y batch (`cursor/console-a11y-batch-08ac`, #2561).** Light chip tokens darkened one step for AA on soft fills; Sheet + TabsSheet + scan Columns popover adopt `useFocusTrap`; tooltip tabIndex/aria-describedby; Meter `label`; dark faint lift; Toggle `label` required. Presentation only — no trading/money-path changes. Rollout: `docs/rollouts/2026-08-17-console-a11y-batch.md`.
> **2026-08-17 CURSOR — CT+UM lane backoff (`cursor/ct-um-lane-backoff-7cf2`, #2550).** Latency-aware backoff on ST's UM knobs/budget/push and CT HTTP/SSE. Flaps are soft; reconnect storms capped. No CT/UM server edits. Rollout: `docs/rollouts/2026-08-17-ct-um-lane-backoff.md`.

> **2026-08-17 CURSOR — FilingAPI optional key, degrade on missing/401 (`cursor/filingapi-soft-skip-de61`, #2778 retarget).** Owner reversed #2787. Keep the filingapi.dev integration. Do not buy Plus / do not charge Stripe. A dead or missing key skips the lane (no health fail); ROIC + EDGAR stay the fallback. A later valid key is used again. Rebased onto `main` `cde3deee` so #2792 is mergeable. Rollout: `docs/rollouts/2026-08-17-filingapi-soft-skip.md`.

> **2026-08-17 CURSOR — Green-Team empty/malformed failover + credits hint (`cursor/green-empty-failover-credits-7003`, #2577).** Green Team is the Bull proposer; empty HTTP-200 failover already existed when `llmFallbackModels` is set. Close the remaining Aug 6 gaps: malformed HTTP-200 JSON failover, implicit rotation-pool fallbacks (2) when Green is rotating with no owner fallbacks, and a credits-exhausted hint on strategy `run_failed` when the OpenRouter check is below threshold. Rollout: `docs/rollouts/2026-08-17-green-empty-failover-credits.md`.
> **2026-08-17 CURSOR — website favicon cropped offset ST (`cursor/favicon-crop-st-e6ee`).**  Restore the #1626 candlestick ST for the website only: S higher than T, tight crop, transparent canvas.  iOS dollar-sign App Icon untouched.  Issue #2731.  Rollout: `docs/rollouts/2026-08-17-favicon-crop-st.md`.
> **2026-08-17 CURSOR — website favicon cropped offset ST (`cursor/favicon-crop-st-e6ee`).**  Website favicon is the iOS App Icon's offset candlestick ST (S higher than T), cropped tight, transparent canvas.  App Icon file untouched.  Issue #2731.  Rollout: `docs/rollouts/2026-08-17-favicon-crop-st.md`.

> **2026-08-17 GROK — strategy-run slugs + lease-lost mislabel (`grok/strategy-run-model-slugs`).**  Wire Mistral Medium as `mistralai/mistral-medium-3-5`.  Attach OpenRouter `require_parameters` + `allow_fallbacks` so GPT-5.4 nano does not 400 on the down OpenAI endpoint.  Stop paging dispatch-lease-lost as Pinecone/rerank connection failures.  Issue #2770.  Rollout: `docs/rollouts/2026-08-17-strategy-run-model-slugs.md`.


> **2026-08-16 GROK — VECTOR_ASOF_STRICT on (`grok/asof-strict-on`).**  Infisical prod flipped `off` → `on`.  Coolify restart finished healthy.  Live desk still omits `asOf`.  Rollout: `docs/rollouts/2026-08-16-asof-strict-on.md`.

> **2026-08-16 GROK — ROIC Individual harvest (`grok/roic-harvest`).**  Use the remaining Individual window for universe breadth plus 20-quarter depth on high-interest names, then archive the rest locally.  Storage follows approved proposer-corpus rev 3 (#2760): extractive highlights in Pinecone, full bodies in `earningscalls_transcripts`.  No second panel.  Rollout: `docs/rollouts/2026-08-16-roic-harvest.md`.
> **2026-08-16 GROK — ROIC single-flight (`grok/roic-singleflight`).**  Every 60s tick started another universe walk because `lastAttemptAt` was written only at the end.  714 stacked journal rows crashed prod ~every 22 minutes.  Single-flight + start watermark + incremental cursor.  L1 keep-400 shrink still running so L2 can compact.  FilingAPI still needs an owner Plus key.  Rollout: `docs/rollouts/2026-08-16-roic-singleflight.md`.
> **2026-08-16 GROK — overlay regime match hotfix (`grok/overlay-regime-match`).**  Live apply now passes the classified enum; router also accepts persisted labels.  Overlay text is contained as `coach` and scanned as untrusted.  Rollout: `docs/rollouts/2026-08-16-overlay-regime-match.md`.

> **2026-08-16 GROK — overlay CRUD + Polymarket deepen + ASOF (`grok/overlay-poly-asof`).**  Full overlay UI on Strategy; Polymarket sector/theme + macro tilts; ASOF dry-run receipt (13076/13076 epoch'd).  No Reddit/X.  Weekly hard-delete deferred.  Rollout: `docs/rollouts/2026-08-16-overlay-poly-asof.md`.  Merged #2743.
> **2026-08-16 GROK — latest-first RAG + proposer corpus design (`grok/prod-error-triage-48h`).**  Cover latest transcript + latest 10-K/10-Q for the universe first, then deepen held/watchlist.  Expert consensus: extractive highlights (no ingest LLM) in Pinecone; full bodies stay local.  Do not flip write-class until ingest/FTS/ledger are split — `storeDocument` completeness currently gates FTS + abstracts.  Design: `docs/designs/2026-08-16-proposer-corpus-storage.md`.  Rollout: `docs/rollouts/2026-08-16-prod-error-triage-48h.md`.
> **2026-08-16 GROK — review UX parity (`grok/review-ux-parity`).** Fast
> approve (no full-universe scan).  Proposed / Now / Target / Delay on website
> + iOS.  Retry Red Team.  State-aware Start/Stop.  PWA `/mobile` ->
> `/console`.  Rollout: `docs/rollouts/2026-08-16-review-ux-parity.md`.


> **2026-08-16 GROK — ASC EULA + Coolify rolling already off (`grok/asc-eula-100`).**  Owner-authorized ASC writes.  Coolify `socratic-app` already has consistent container names + 60s start period.  What's New blocked on first versions.  Rollout: `docs/rollouts/2026-08-16-asc-eula-coolify.md`.
> **2026-08-16 GROK — ticker desk sheet (`grok/ticker-desk-sheet`).** Ticker
> tap on iOS + website (desktop/mobile viewports) shows current lot, exit
> plan, pending rationale, last Green/Red call, and other-account
> size+direction with switch.  PWA is out of scope (owner).  RAG dump is v2.
> Rollout: `docs/rollouts/2026-08-16-ticker-desk-sheet.md`.
> **2026-08-16 GROK — ROIC single-flight (`grok/roic-singleflight`).**  Every 60s tick started another universe walk because `lastAttemptAt` was written only at the end.  714 stacked journal rows crashed prod ~every 22 minutes.  Single-flight + start watermark + incremental cursor.  L1 keep-400 shrink still running so L2 can compact.  FilingAPI still needs an owner Plus key.  Rollout: `docs/rollouts/2026-08-16-roic-singleflight.md`.

> **2026-08-16 GROK — overlay CRUD + Polymarket deepen + ASOF (`grok/overlay-poly-asof`).**  Full overlay UI on Strategy; Polymarket sector/theme + macro tilts; ASOF dry-run receipt (13076/13076 epoch'd).  No Reddit/X.  Weekly hard-delete deferred.  Rollout: `docs/rollouts/2026-08-16-overlay-poly-asof.md`.

> **2026-08-16 GROK — Litestream L1 suffix + FilingAPI + ROIC universe (`grok/litestream-filingapi-roic`).**  Delete non-contiguous L1 so L2/L3 can rebuild.  FilingAPI key is a dead trial (401); free signup already claimed — owner Plus checkout.  ROIC ingest is list-first + speaker-section RAG + universe cursor; retrieval admits ROIC without FMP rights.  Rollout: `docs/rollouts/2026-08-16-litestream-filingapi-roic.md`.

> **2026-08-14 GROK — unstick #2707 webpack `node:crypto`.** Merged origin/main
> (clean). `src/lib/kalshi.ts` now imports bare `crypto` so Next/webpack
> resolve.fallback applies. Rollout:
> `docs/rollouts/2026-08-14-kalshi-node-crypto-webpack.md`.

> **2026-08-14 GROK — bound per-document FTS mirror (`grok/bound-fts-mirror`).**  #2680's 250ms yield did not bound wall-clock (933 chunks / 279522ms).  Slice at 20 chunks or 6s per tick, resume from FTS row count, heartbeat during FTS.  Do not re-enable the worker in this PR.  Issue #2715.  Rollout: `docs/rollouts/2026-08-14-bound-fts-mirror.md`.
> **2026-08-13 GROK — r5 residue (`grok/claude-r5-residue`).** After #2682, implement the leftover `risk_advisory` tail reword + merge-gate.  Do not redo r4 (sibling `grok/claude-r4-pickup`).  Do not flip `VECTOR_ASOF_STRICT` or mint Reddit/X keys.  Owner-decision list in `docs/rollouts/2026-08-13-pickup-r5-residue.md`.
> **2026-08-14 GROK — Monet backend r5 pickup (`grok/monet-backend-r5`).** Finish Monet's Backend-updates chat: land leftover r4 #2689 + residue #2691, then r5 locks/memory/overlays/chat-SSE/scorecard-alpha (migrations 79–81). Rollout: `docs/rollouts/2026-08-14-monet-backend-r5.md`.

> **2026-08-13 GROK — Claude r4 leftover pickup (`grok/claude-r4-pickup`).** Cherry-pick five unpushed r4 slices (benchmarks, ATR pullback, ops panel, opspanel fixes, data-age) onto current main.  No new schema version (main already at 78).  Prompt version lands as `agentic-strategy@2.5.0`.  Advisory-tail leftover stays with Monet #2682.  Rollout: `docs/rollouts/2026-08-13-claude-r4-pickup.md`.
> **2026-08-14 GROK — stale ~1200s quotes + origin timeouts (`grok/prod-error-triage`, #2714).** Alpaca keep-alive sockets from Hetzner die (`UND_ERR_SOCKET`); cascade falls to Yahoo delayed (~15-20m); one `fetch failed` auto-halts Autopilot; `/api/health` 8s credits fetch stacks into UptimeRobot Connection Timeouts (and the paired credits-low keyword monitor). Retry dead sockets; 3-streak connectivity halt; abort=soft; 1.5s health credits budget; WU Sentry 6h dedup. Residual: filingapi 401 (owner key), Litestream L2 (owner), CT probes. Rollout: `docs/rollouts/2026-08-14-stale-quotes-origin-timeouts.md`.
> **2026-08-14 GROK — Monet audit owner decisions (`grok/audit-owner-decisions`).**
> Docs-only closeout of four leftovers.  CT trial already matches the 2-week
> offer.  TestFlight accept, Coolify rolling+B2, and ASC listing writes stay
> owner-only.  Merge table #2680–#2682, #2684, #2685, #2687, #2709, #2712 all
> MERGED.  Rollout: `docs/rollouts/2026-08-14-monet-audit-owner-decisions.md`.

> **2026-08-13 GROK — fleet alert triage (`grok/fleet-alerts-aug13`).** Fix RH MCP extra args (#2576), cap Pinecone metadata under 40960, classify engine-overloaded 429s as transient (no usage-limit page), and stop the ST-health keyword monitor from pairing 503 deploys as "credits low." CT senate scout handshake reuse is the follow-up in the CT lane. Rollout: `docs/rollouts/2026-08-13-fleet-alert-triage.md`.


> **2026-08-10 GROK — always-auto-merge workflow (PR #2597).** Non-draft same-repo PRs arm squash auto-merge; `do-not-automerge` disables armed merges; sentry coverage updated. Lands via this unstick pass.

> [!WARNING]
> **Read the blockquote entries below with suspicion; some are spliced.** This file is
> `merge=union` in `.gitattributes` (with `STATUS.md` and `docs/EFFORT-LOG.md`) so that
> concurrent PRs do not conflict on it. Union-merge *interleaves* both sides of a
> concurrent edit instead of raising a conflict, so an entry can end up filed under a
> different agent's heading. There is a live example a few lines down: the
> **2026-07-29 — Expose portfolio errors in UI (ANTIGRAVITY)** heading is followed by text
> about `done_for_day` order history on a `cursor/pending-orders-*` branch — a different
> agent's entry, wearing this one's title. Trust the linked `docs/rollouts/` note over the
> heading it appears under.
>
> This file has also drifted from a *plan* into an append-only log (2,000+ lines). For what
> is actually true right now, read `STATUS.md` (snapshot: state, blockers, next action) and
> `docs/EFFORT-LOG.md` (effort board). Flagged 2026-08-01 during the Codex-review
> remediation; the restructure is deliberately left as an owner call, since collapsing this
> history is not something an agent should do unilaterally.

> **2026-07-29 — Adjusted Day P&L for Cash Flows (ANTIGRAVITY, branch `agent/ag-day-pnl`).**
> Updated `deriveDayPnl` to correctly handle intraday cash deposits and withdrawals by reusing the `inferExternalCashFlows` helper. The dashboard will now compute P&L correctly by netting out any cash flows, preventing the UI from misattributing cash deposits as profit. Tests and build passed. Rollout: `docs/rollouts/2026-07-29-day-pnl-cash-flow-adjusted.md`.

> **2026-07-29 — Expose portfolio errors in UI (ANTIGRAVITY, branch `agent/ag-portfolio-error`).**
> `done_for_day` history as open/working; ops `?orders=1` for live vs listed
> diagnosis. Branch `cursor/pending-orders-open-count-0aef`. Rollout:
> `docs/rollouts/2026-07-27-pending-orders-done-for-day.md`.
> **2026-07-26 — Free-first enrichment cascade + coverage report (CURSOR).** Prefer
> free/keyless + RapidAPI failover before paid native keys; coverage Admin/ops. Follow-up:
> FilingAPI.dev, SEC XBRL default ON, RapidAPI yh-finance / real-time-finance-data /
> seeking-alpha (pricing-page Subscribe links in rollout). Branch
> `cursor/free-cascade-coverage-0aef`. Rollout:
> `docs/rollouts/2026-07-26-free-cascade-coverage.md`.
> **2026-07-27 — Dormant features readiness (CURSOR).** Substrate so remaining default-off
> capabilities can be enabled safely: `dormantFeatures` checklist on `/api/admin/rag-coverage`,
> `LANDING_PAGE_ENABLED` unset=ON with explicit off-switch, CSP report-uri collector, and
> `VECTOR_EMBED_CLEAN_TEXT` bumping `embed_rev` 1→2. **2026-08-12 owner:** MULTIQUERY/HyDE/clean-text
> /disclosure embed are ON in Infisical on paid OpenRouter+bge-m3 (run-budget still on). Still do
> **not** flip ASOF_STRICT, FMP dual-gate, SEC8K full body, or legacy purge without preconditions.
> Branch
> `cursor/dormant-features-impl-1c6c`. Checklist: `docs/FEATURE-ENABLEMENT-BACKLOG.md`.
> **2026-07-25 — Fix vs-SPY benchmark (CURSOR).** Correct cash-flow-aware TWR vs SPY so all-cash
> deposits/resets are not alpha and Home shows You / SPY decomposition. Branch
> `cursor/fix-vs-spy-benchmark-9833`. Rollout: `docs/rollouts/2026-07-25-fix-vs-spy-benchmark.md`.
> **2026-07-22 — PR #1792 typecheck repair (CODEX).** The provider-generic health-lane merge
> resolution is now aligned with the current durable dispatch API in `28a09b84`; run hosted
> verification, let auto-merge land it, and confirm the exact post-merge deployment receipt.
> **2026-07-24 - RAG enablement + Exit Contract B1 + prune (CURSOR).** Safe RAG flags default ON
> (`docs/FEATURE-ENABLEMENT-BACKLOG.md`). Exit Phase B: B1 substrate landed; B3 interim already on
> main (#1786); B4–B6 + Phase C remain Planned. Wave-2 coaching/reflection DISCARD (branches
> deleted). Stale no-PR origin tips pruned (19). Next: Infisical mirror if desired; Exit B4 before
> live shorts; full verify gate on PR.

> **2026-07-24 - Effort-board accuracy audit (CURSOR).** Cleared empty In Progress; corrected
> Planned/Completed status claims against merged PRs. Active product backlog remains: RAG/feature
> enablement (`docs/FEATURE-ENABLEMENT-BACKLOG.md`), Exit-strategy Phases B/C, and remaining
> activity-audit P2 items that are still unmerged. Stale w2 coaching/reflection branches still exist
> on origin without PRs if someone wants to land them.


> **2026-07-22 — Approval Busy/red-team/UptimeRobot repair (CODEX, branch
> `codex/trade-approval-redteam-uptime-20260722`).** Keep the per-account strategy lock as the
> correctness fence, but retry its side-effect-free Busy response in the approval client so a user
> does not have to race a long LLM run. Use OpenRouter's account-filtered model list before choosing
> rotation slots; explicit unavailable model selections remain fail-closed and require owner choice.
> Keep the external monitor on public `/api/health`; do not expose authenticated `/api/ready` just for
> monitoring. Verify the dedicated branch with the ordered lint/tsc/test/build gate, then land via
> `scripts/land.sh` if the owner wants deployment.
> **2026-07-24 - Resolve open efforts + stale issue mirrors (CURSOR).** Board hygiene moves
> already-merged In Progress rows to Completed; restores ruleset `check-pin` required alongside
> `verify`; drains Sentry CI spam blocking runners. Four open PRs still await `verify`. RAG
> enablement remains Planned (re-embed proof). Rollout:
> `docs/rollouts/2026-07-24-resolve-open-efforts.md`.

> **2026-07-22 — PR #1792 typecheck repair (CODEX).** The provider-generic health-lane merge
> resolution is now aligned with the current durable dispatch API in `28a09b84`; run hosted
> verification, let auto-merge land it, and confirm the exact post-merge deployment receipt.
> **2026-07-23 - Unstick remaining open PRs (CURSOR).** Five open PRs (#1901/#1902/#1792/#1819/#1842)
> refreshed onto current `main`, conflict-resolved where real, auto-merge armed. Effort board
> corrected for already-merged rows (#1892 and related). Next: wait hosted verify → auto-merge;
> then RAG enablement remains Planned (telemetry/eval before `RAG_CORPUS_WIDE_LEXICAL`).
> **2026-07-24 - Unstick remaining open PRs round 2 (CURSOR).** Four open PRs
> (#1902/#1792/#1819/#1842) rebased onto current `main` after peer force-pushes; CI/merge fixes
> pushed; auto-merge armed. #1901/#1980/#1981 already on `main`. Effort-board stale In Progress
> rows corrected (#1847/#1828/#1839/#1981/check-pin/which-key/retired-provider). Next: hosted
> `verify` green → auto-merge; RAG enablement remains Planned.

> **2026-07-22 — Retired-provider Usage Monitor cleanup — COMPLETED via #1901 (CURSOR note).**
> Broker runtime retained; Usage Monitor emissions for retired broker families removed.
> **2026-07-22 - RAG review remediation follow-up (CODEX).** PR #1892's latest review pass found
> five correctness gaps. Keep local FTS recall active when paid rerank/hybrid budget degradation
> trips; classify source-backed 8-K rows without a `sec_filings` join; include immutable occurrence
> coordinates in chat evidence refs; require vector IDs or accession coordinates in golden selectors;
> and allocate identical serialized evidence to one occurrence. Verify focused tests, TypeScript,
> lint, then the full required gate before pushing the existing PR ref.

> **2026-07-21 - RAG strategic-performance implementation (CODEX team).** Execute in ordered,
> isolated PRs: (1) repair the managed-ingestion stale Voyage prerequisite and add a production-mode
> OpenRouter regression; (2) add a production-path point-in-time financial retrieval evaluator; (3)
> add a pure corpus-wide FTS5 candidate source; (4) integrate dense+lexical union before exactly one
> rerank, using the new decoupled/default-off adaptive rerank policy and typed stage telemetry; (5)
> align evidence manifests with exact prompt consumption and add declared-use evidence receipts;
> (6) certify counts and evaluation gates before any legacy purge or model/infrastructure change.
> Rerank policy + telemetry modules are locally green on `codex/rag-strategy-program-20260721`;
> ingestion, evaluator, and lexical modules are active parallel lanes. Production re-embed remains
> externally owned; CODEX will not launch competing corpus writes.
> **2026-07-22 integration update:** Steps 1-6 are implemented on the current-main integration tree:
> provider-aware managed ingestion, strict production-path/PIT evaluation, committed/current
> tenant-safe corpus-wide FTS recall, one-pass dense+lexical fusion, independently routed/default-off
> adaptive reranking, stage telemetry, exact consumption, structured/narrative routing, bounded parent
> context, Pinecone hosted-inference comparison, and Turso/Assistant capability probes. Independent
> review findings are remediated, and the final ordered local gate is green: lint (0 errors / 615
> warnings), TypeScript, 434 files / 5,015 tests, and production build. Current-main Node 24 landing
> verification passes TypeScript, 439 files / 5,027 tests, and production build; ready PR #1892 is
> open. Remaining: required hosted checks, merge/auto-deploy receipt, and live exact-SHA verification.
> Production activation stays off.
> **2026-07-22 PR review update:** Centralize immutable id-less evidence identity so prompt
> consumption and Socratic attribution use identical accession/section/ordinal/content/namespace/
> tenant coordinates. Focused tests, TypeScript, scoped lint, and the final Node 24 ordered gate are
> green (lint 0 errors / 613 warnings, TypeScript, 439 files / 5,028 tests, production build); push
> the remediation to PR #1892 and resolve its review thread. Follow-up review now moves lexical
> metadata predicates ahead of the bounded FTS cap, matches filing text only, and separates the
> credentialed retrieval user from the generated isolated evaluation run id; rerun focused checks,
> push, and resolve all three new review threads.
> **2026-07-21 — Managed RAG ingestion authority repair (CODEX, branch `codex/rag-ingestion-gate-20260721`).**
> Repair the stale `storeDocument` provider gate left by the Voyage SDK purge: require Pinecone
> initialization plus the actual active embedding provider credential, while preserving the explicit
> test-only Voyage path. Add a production-mode OpenRouter/Pinecone regression. This is a code-path
> prerequisite only; no re-embed, purge, secret, or production operation is included.
> **2026-07-22 — RAG Turso/libSQL + Pinecone Assistant shadow benchmarks (CODEX, branch `codex/rag-shadow-benchmarks-20260722`).** Land the default-off read-only harness only after focused test/lint/TypeScript checks. Do not add a libSQL runtime dependency or route production retrieval to Turso until an explicit shadow comparison has a configured remote target and measured recall/latency/cost receipt. Pinecone Assistant remains a pre-existing-assistant contextual-retrieval baseline; no file/corpus migration or production use follows from this work without evidence/PIT/tenant-erasure acceptance.
> **Handoff 2026-07-22 — Robinhood cap resilience deployment.** The implementation is committed
> (`9c208190`) and latest `origin/main` is merged (`e943e9b9`), but landing stopped in the full
> Vitest gate because `better-sqlite3` was compiled under Node 26 while the required Node 24 runtime
> loaded it. Rebuild dependencies under Node 24, rerun `scripts/land.sh`, then complete PR checks,
> protected merge, Coolify SHA verification, and live Robinhood save/proposal verification. Full
> command sequence: `docs/rollouts/2026-07-22-robinhood-cap-resilience-handoff.md`.

> **2026-07-22 — Robinhood guardrail cap resilience (CODEX, branch
> `codex/robinhood-cap-fix`).** Make policy saves independent of transient broker account-list
> failures when account readiness is unchanged, while retaining verification for account selection
> and autonomy activation. Resolve effective opening order/daily caps against current buying power
> or NAV so oversized absolute settings cannot produce infeasible proposals; make percentage mode
> the default for blank dual-mode settings while preserving explicit legacy dollar settings. Focused
> regressions, lint, TypeScript, and production build are green. Full Vitest completion remains
> pending because the repo config serializes the suite and the shared host was under concurrent load.
> Next: land through the normal PR gate and verify the exact production SHA plus a Robinhood save.

> **2026-07-22 — Usage telemetry v2 + shared-package pin-check combined landing (PR #1889).** The
> reviewed #1890 workflow correction is subsumed into #1889 to avoid two serialized full CI cycles.
> Keep auto-merge off until the combined final head passes hosted `gitleaks`, `check-pin`, required
> `verify`, and zero-thread review. PRs #1890 and #1780 are closed as superseded; their branches are
> retained. After #1889 merges, verify the exact Coolify release and one new authenticated strict-v2
> ACK.
> **2026-07-22 — Mobile auth exchange CSRF follow-up (CODEX, PR #1888).** Keep
> `/api/mobile/auth/exchange` unauthenticated for the native client, but do not classify it as a
> public-prefix early return: it must pass `checkSameOrigin` before the one-time code/verifier
> handoff. Verify the focused middleware/route tests and required hosted gate, then merge and
> verify the exact auto-deployed SHA.
> **2026-07-22 — Collapse duplicate pending CI verifies (CODEX, branch
> `codex/ci-queue-collapse`).** Keep `cancel-in-progress: false` so an active suite can finish,
> but remove the per-SHA concurrency suffix so GitHub retains only the newest pending run per
> workflow/ref. Verify the workflow regression, open a ready PR, arm auto-merge, and monitor the
> queue without interrupting the three active full suites.

> **2026-07-19 - Three new RapidAPI-backed enrichment providers (CLAUDE, branch
> `claude/model-availability-session-handoff-362fd3`).** No roadmap scope change; market-data
> redundancy only. Owner-directed: add Mboum Finance, YH Finance 15, and an Alpha Vantage
> RapidAPI transport (OVERVIEW fundamentals) as a dormant-unless-`RAPIDAPI_KEY`-set, quota-safe
> failover tier registered AFTER the free Yahoo scrape in `getEnrichmentProvider`. New
> `src/lib/rapidapi-quota.ts` enforces a per-provider daily cap (Mboum 16/day, YH Finance 15
> 3/day, AV-RapidAPI 500/day) AND a combined 900/day ceiling across all three, mirroring
> `alpha-vantage-key-pool.ts`'s persisted budget pattern. tsc clean, lint 0 new warnings, 33 + 13
> new tests green. Not yet landed — `scripts/land.sh` is a separate phase. Details:
> `docs/rollouts/2026-07-19-rapidapi-yahoo-av-providers.md`.
> **2026-07-21 - Native iOS mobile-first Phase 1 (CODEX, branch
> `codex/mobile-first-ios-20260721`).** Implementation and review remediation are complete in the
> isolated worktree; PR #1859 is open for protected landing. Phase 1 keeps the backend authoritative:
> native Apple audience, read-only deletion preview/final deletion admission, immediate protective
> mobile commands, and the final broker-placement state fence are server-side contract/safety work.
> Google/GitHub browser authentication uses a short-lived verifier-bound opaque handoff rather
> than a session credential in the custom callback URL.
> Release signing
> is configured for team `CC8UTF7ATG`; the XcodeGen spec is canonical and its
> generated, checked-in `.xcodeproj` is direct-buildable. Deferred after landing: device/simulator interaction QA
> on a machine with an installed
> iOS runtime, notification/background-refresh work, and any richer Coach conversation
> contract that requires a new server API.
> **2026-07-22 - Usage telemetry v2 producer adoption (CODEX, branch
> `codex/usage-telemetry-v2-20260721`).** Exact-pin shared `v2.0.0`, replace v1 wire fields with the
> strict v2 batch/event contract, freeze and legacy-drain each existing replay watermark through a
> high-water mark before strict-v2 cutover, preserve durable replay identity and old in-memory
> buffer recovery, verify cold HTTPS install plus focused/full Node 24 gates, then land only after
> the receiver's current Oracle revision has a committed exact-SHA receipt. After merge, require
> Coolify exact-SHA health and an authenticated receiver ACK before closing.

> **2026-07-20 - Corpus re-embed scoped-purge gate fix (CURSOR, branch
> `cursor/critical-bug-management-0770`).** Critical-bug sweep found that a symbol-scoped
> corpus re-embed could persist a full-docType completion stamp and thereby authorize
> `purge-legacy` to delete all legacy vectors for that docType. Patch `corpus-reembed` so
> scoped runs never stamp full-corpus completion; keep purge blocked until an unscoped run
> completes under the active embedding revision. Focused regression added in
> `test/corpus-reembed.test.ts`; run the ordered local gate, open PR, and do not run
> production `purge-legacy` until this fix is live and full-corpus completion is independently
> verified.
> **2026-07-21 - Stop placement intent authoritative-absence fix (CURSOR,
> branch `cursor/critical-bug-management-8edd`).** Narrow money-path repair from the hourly
> high-severity bug scan: a broker protective-stop placement intent created before a timed-out broker
> call must not be cleared just because a non-authoritative/live-only order list lacks the
> `clientOrderId`. Only gateways with `ordersListIncludesTerminal === true` may treat absence as
> confirmed-dead and place fresh; Robinhood-style lists keep the intent and skip the symbol to avoid
> duplicate sell stops. Focused and full gates passed; PR publication/hosted checks next.
> **2026-07-22 - RAG parent-context expansion (CODEX, branch `codex/rag-parent-expansion-20260722`).**
> Keep child chunks as the only dense/lexical/rerank candidates. Default-off
> `RAG_PARENT_CONTEXT_EXPANSION` maps final survivors back to their bounded parent context only
> after ranking, deduping sibling parents deterministically and preserving child id, score, metadata,
> and strict point-in-time semantics. The local helper and retrieval wiring are focused-test/TS/lint
> verified; tune only after the production-path evaluator shows an evidence gain within the global
> prompt budget. Do not alter the external corpus/re-embed train for this work.
> **2026-07-22 — RAG evidence-consumption receipt correction (CODEX evidence sublane).** Complete locally: strategy derives durable use only from the post-containment/post-budget prompt serialization; retrieved-but-not-consumed chunks remain diagnostic-only; stable refs propagate through strategy/chat without new raw query/prompt telemetry. Next: umbrella RAG lane reviews and lands this isolated commit after its current integration sequencing.

> **2026-07-21 - CI Runner Migration (Antigravity, branch `agent/antigravity-ci-fix`).** Replaced failing self-hosted runner `trading-live` with `ubuntu-latest` across all CI workflows (`.github/workflows/*.yml`) in Socratic.Trade. The Mac self-hosted runner environment was corrupted after Hetzner failure. Scheduled to land via `scripts/land.sh` to unblock 38 pending PRs.
> **2026-07-21 - CI queue recovery (GROK + CODEX, branch `monet/ci-runner-and-queue-fixes`).** Remove all workflow targets for absent `trading-live`; keep PR code on the two Coolify `socratic-ci` runners and trusted CI-failure reporting on `socratic-deploy`; remove smoke from PR events; keep an active required verification alive while GitHub collapses superseded pending heads; and repair the six stale current-main test assertions that would otherwise fail the first durable run. Land this dependency first, verify its exact production SHA, then drain PRs serially in review/dependency order without runner-service restarts.
> **2026-07-21 - CI queue recovery (GROK + CODEX, branch `monet/ci-runner-and-queue-fixes`).** Remove all workflow targets for absent `trading-live`; keep PR code on the two Coolify `socratic-ci` runners and trusted CI-failure reporting on `socratic-deploy`; remove smoke from PR events; keep an active required verification alive while GitHub collapses superseded pending heads; remove synthetic production enrichment fallback data; make bracket permission side-specific; and repair the focused tests exposed by the first durable run. Land this dependency first, verify its exact production SHA, then drain PRs serially in review/dependency order without runner-service restarts.
> **2026-07-24 - Coolify/Hetzner runners only (CURSOR, branch `cursor/coolify-runners-only-14e5`).** Owner correction: do not use GitHub-hosted Actions. CI runs on ci-cpx32 systemd runners; deploy/reviews on the Coolify prod host. Route `sentry-ci-report` off missing `socratic-deploy` onto `socratic-ci`; sudo-free `gh` + Playwright without `--with-deps`; add `scripts/monitor-coolify-runners.sh` for frequent Coolify/Hetzner health checks.
> **2026-07-19 - Land the #1771/#1773/#1777 chain, then run the corpus re-embed to completion
> (owner-directed pickup, multiple lanes).** Next actions, in order: (1) land **#1771**
> (SiliconFlow bge-m3 embed-price 10x undercount fix — auto-merge armed, no open findings,
> queued on the single-lane Hetzner CI runner); (2) land **#1773** (this session-handoff note —
> 6 Codex P2 threads fixed and resolved this pass); (3) land **#1777** (`corpus-reembed`
> hardening — purge-gate exploit, live-identity double-embed, and insider-Form-4 PIT fixes;
> this is what the 2026-07-18 FLEET HOLD on `purge-legacy`/scoped re-embeds is waiting on).
> (4) Once #1777 is live, run the full 4-docType corpus re-embed (`sec-filings`,
> `earningscalls-transcripts`, `insider-form4`, `experience-memory`) via `POST
> /api/admin/reembed` to completion and independently reverify via `describe-index-stats`/`GET
> /api/admin/reembed` before ever running `purge-legacy`. **Verified 2026-07-19 (live Pinecone
> `describe-index-stats` on `socratic-trade`): the re-embed is genuinely incomplete** — legacy
> (Voyage) namespace ~8.7k vectors intact (no purge run), managed (bge-m3) namespace only ~1.6k
> and growing solely via normal ingest cadence, not a completed backfill. Details:
> `docs/rollouts/2026-07-19-monet-session-handoff.md`, `docs/rollouts/2026-07-18-corpus-reembed.md`.

> **2026-07-18 - PR #1760 review closeout (CODEX, branch `codex/pr1760-review-fixes`).** Resolve all
> four actionable review threads in an isolated Codex lane: retain both shared-package HMAC and
> documented bearer webhook authentication, keep proposal attribution in policy namespace and align
> the missed usage-budget assertions, and delete unsafe review/worktree artifacts. PR #1760 raced to
> auto-merge as `b2f22ccf`; all four threads are answered/resolved and corrective PR #1761 now carries
> the fixes on top of that exact main. Local Node 24 gates are green (lint, TypeScript, 4,837 tests,
> build). Finish self-hosted checks, merge #1761, and production-verify the exact auto-deployed SHA.

> **2026-07-18 - Admin Server Stats reliability (CODEX, branch `codex/socratic-infra-panel-reliability`).** No roadmap scope change; infrastructure observability only. Final hardening adds bounded provider JSON and Coolify normalization, validated Hetzner metric envelopes with stale-series retention, strict client-envelope validation, and the coordinated `Server Stats` naming. Focused Node 24 tests are 19/19; the independent P2 warning-expansion finding is fixed and re-review is pending. Serialize the exact-tree full gate, then publish through PR/required checks/protected merge, Coolify auto-deploy, and exact production-SHA health verification. In-app Browser QA remains unavailable because the listed browser-control runtime was not callable; local SSR smoke returned HTTP 200 with `Server Stats` content.
> **2026-07-18 - Admin smoke memory headroom (CODEX).** Lower the CI-only Playwright Node heap
> ceiling from 2560 MiB to 2048 MiB after the admin PR's webServer exited 137 under the 3 GiB
> runner cap; rerun required checks and verify merge/deploy.

## 2026-07-18 — Admin console shell parity (CODEX)

- [x] Match the admin frame to the normal console chrome geometry and tokens.
- [x] Keep logo/name and a functional profile popover visible on admin pages.
- [x] Keep account scope, Start/Resume/STOP, and Run once controls absent from admin.
- [x] Preserve admin tabs as the left rail and normalize all admin labels to title case.
- [x] Rename the server panel to Server Stats without changing `/admin/server` or API routes.
- [x] Keep the mobile admin header within narrow viewports by hiding the full brand at small breakpoints.
- [x] Prevent profile-menu logout prefetch from triggering the side-effectful `/logout` GET.
- [x] Run Node 24 lint, TypeScript, full Vitest, and production build gates.
- [ ] Land through `scripts/land.sh`, then verify the auto-deployed production SHA and health.
> **2026-07-18 - PR #1735 proposed-model attribution P2 (CODEX, local-only branch `codex/pr1735-proposal-attribution`).**
> Preserve the exact policy/OpenRouter identifier for `TradeProposal.proposedByModel`, separately
> from canonicalized usage telemetry, so approval-card primary and fallback provenance remains
> truthful. Focused primary/fallback strategy regressions, TypeScript, and scoped lint pass; keep
> the resulting commit local and unpushed pending owner direction.

> **2026-07-18 - PR #1735 review cleanup round 2 (CODEX on `agent/ag-recovery-v48-migration`).**
> Address the fresh Codex comments by preserving company-name display casing in securities imports
> and restoring the missing lockfile peer dependency entries. Focused import tests and clean-install
> dry-run are green; push back to PR #1735, resolve the threads, and let hosted checks arbitrate.

> **2026-07-18 - PR #1735 verify cleanup (CODEX on `agent/ag-recovery-v48-migration`).**
> Merged latest `origin/main` and fixed the missed attribution assertions that were still expecting
> provider-qualified IDs after the branch canonicalized OpenRouter telemetry to bare model IDs.
> Focused failing test set is green; push back to PR #1735 and let hosted checks arbitrate full-suite
> readiness.
> **2026-07-18 - PR #1736 review cleanup (CODEX on `monet/model-identity-shared`).**
> Merged latest `origin/main`, kept the shared model-identity helper behavior, and restored
> case-insensitive usage aggregation by using a lowercase aggregation key with case-preserving
> display/canonical output. Focused usage-model merge tests are green; push back to PR #1736 and
> let hosted checks arbitrate full-suite readiness.
> **2026-07-18 - CI event-SHA checkout pin (CODEX, PR #1742 integrated into PR #1739).**
> Classifier checkouts now pin the event SHA. Security deliberately keeps full history for Gitleaks.
> Diff/YAML/actionlint checks passed; final gate and deployment follow the parent routing PR.

> **2026-07-18 - CI shallow-checkout recovery (CODEX, PR #1741 integrated into PR #1739).**
> Classify jobs compare base/head endpoint trees after shallow fetches. Security deliberately keeps
> full history for Gitleaks. Diff/YAML/actionlint checks passed; final gate follows the parent PR.

> **2026-07-18 - Coolify CI runner routing unblock (CODEX, branch `codex/coolify-ci-runner-routing`).**
> Route required PR checks and PR-visible helper workflows from GitHub-hosted `ubuntu-latest` to the
> dedicated Coolify Hetzner CI lane (`[self-hosted, socratic-ci]`), recover the exited runner
> containers through the Coolify service API, and make Gitleaks compatible with the `/_work`
> self-hosted workspace. Bound the heavy Node jobs to a 2560 MiB heap inside the runner's 3 GiB
> container cap so TypeScript and the Playwright build can complete. This is an
> infrastructure unblock for the six clean/auto-merge-armed PRs whose jobs currently fail before
> runner assignment. Keep Coolify production configured on `main` with auto-deploy enabled. After
> this lands, rerun checks on #1728/#1733/#1735/#1736/#1737/#1738 and let auto-merge/deploy proceed.
> Playwright gets a CI-only 600-second server-start allowance because the runner's low CPU shares are
> intentional; local timeout remains 240 seconds. Gate bot-triggered Codex autofix jobs to same-repo
> PR heads before a persistent runner, checkout, write token, or model secret is admitted. Compensate
> for Coolify's same-container `restart: always` lifecycle by clearing only the ephemeral `/_work`
> directory before each `EPHEMERAL=1` runner registration. Keep failure telemetry independent of
> the observed CI runner by routing its short failure/schedule-only job to `socratic-deploy`. Keep
> all other work on the dedicated CI label; reject generic-Linux routing and checkout timeouts below
> the measured 3m31s-3m57s clean checkout duration. Reject fork PRs at job admission before CI/E2E
> classifiers or the token-bearing package-pin check reach the persistent runner. Pin the manually
> dispatched merge-shepherd implementation to this repository's trusted `main` workflow before it
> inherits write permissions and secrets.

> **2026-07-17 - OpenRouter Model Stats Canonicalization (Antigravity, branch `antigravity/openrouter-universal-routing`).** Implemented server-side model-id canonicalization (`cleanModelId`) inside `aggregateModelStats` and `normalizeBenchmarkSummaries` in `src/lib/model-stats.ts` to strip provider prefixes (like `openai/`, `google/`, etc.) from qualified OpenRouter model IDs. This ensures that usage, latency, closed trades, and benchmark summaries are aggregated and mapped back to their bare catalog model base names (e.g., `gpt-5.6-terra`, `gemini-3.5-flash`), preventing stats split and lookup mismatch in the Model Stats drawer. Verified via vitest and compiler checks. Rollout: `docs/rollouts/2026-07-17-openrouter-model-stats-canonicalization.md`.
## 2026-07-16 — OpenRouter Catalog Integration & JSON Repair (ANTIGRAVITY)

Added OpenRouter models to `app/ui/llm-model-catalog.ts` so they can be selected for Green and Red teams. Local response healing via `jsonrepair` integrated globally via `extractJsonPayload` without model-specific fallback calls. `better-sqlite3` native modules rebuilt for Node 24. Tests passed, ready for `main` deployment.

> **2026-07-17 - SEC/RAG Backfill: Advanced RAG Backfill Improvements (Antigravity/AG, branch `agent/ag-rag-backfill-p3`).** Implemented Advanced RAG Backfill improvements (RAG-B08, RAG-B09, RAG-B10, RAG-B13, RAG-B14). Optimized the SEC filings discovery pipeline to check stashed SQLite filings first, dynamically skip online discovery if enough stashed filings satisfy the run's cap, and globally sort the queue breadth-first (newest 10-K, then newest 10-Q). Implemented dynamic raw-artifact local caching in the queue worker to bypass duplicate network fetches. Added a two-stage RAG query (scouting all candidates dynamically with `limit = 1` and deep-scanning finalists + holdings with `limit = 8`), grouping narrative chunks and structured facts/Form-4 transactions cards into prompt-injected symbol dossiers. Expanded the admin coverage dashboard at `/api/admin/rag-coverage` to query the entire database directly and report model, parser, and date ranges. Fully verified type safety, Next.js build, and 51/51 tests passing. Ready to push and merge.

> **2026-07-16 - SEC/RAG Backfill: Phase 3 — HTML Parsing and Chunker (Antigravity/AG, branch `agent/ag-rag-backfill-p3`).** Implements cheerio-based HTML parser (`parseFilingHtml` in `src/lib/web-sources/sec-parser.ts`) to strip script/style/hidden tags, normalize Item/Part section headers, and reconstruct clean pipe-delimited Markdown tables (grouping/splitting large tables to fit token caps). Updated chunker in `src/lib/rag/chunk.ts` to be section-aware (resetting overlap across sections) and use token-aware estimation. Integrated this parser in `ingestFiling` inside `src/lib/web-sources/sec-filings.ts` to ingest bodies with parser revision `sec-edgar-filing-v2`. Verified via newly added unit test suite in `test/sec-parser.test.ts` (100% green), existing `sec-filings` tests, and a successful Next.js production build check. Opening PR.

> **2026-07-15 - SEC/RAG Backfill: Phase 2 — Discovery and Archive (Antigravity/AG).** Implements Phase 2 (Discovery and Archive) of the SEC/RAG 1,000-stock high-yield backfill plan. Built a host-wide `SecRateLimiter` class (token bucket, 4 req/sec default) with dynamic 429 `Retry-After` backoff handling. Integrated this rate limiter into `politeFetch` calls in `http.ts` for all `.sec.gov` requests. Implemented a local raw-artifact caching layer in `sec-filings.ts` to check, save, and retrieve SEC documents locally before hitting the network. Added historical submissions JSON shard traversal (supporting filings listed in `filings.files` when limit is not met by `recent`). Created the `fetchFilingDirectory` helper to download and parse `index.json` directory structures for future exhibit resolution. Verified via newly added test suite in `test/sec-backfill-p2.test.ts` (100% green), existing `sec-filings` tests, and a successful Next.js production build check. Merged as PR #1665.
> **2026-07-16 - Public-page renderer decision + legacy `app/ui` primitives slim-down (MONET,
> branch `monet/vigilant-fermi-220244`).** Settles the "two renderers, one brand core" question
> for every remaining legacy glass-token consumer (WS-E follow-up to the 2026-07-16 UI wave):
> ALL public/marketing surfaces (welcome, how-it-works, framework, privacy-policy,
> terms-and-conditions) plus the root error boundary and `app/ui/theme.tsx` deliberately KEEP
> the distinct public renderer — no con-* migration (console.css is `.console-root`-scoped and
> unlayered; the brand core is already shared via `--brand-accent` + the radius canon).
> `app/ui/primitives.tsx` slims to its real consumers (Card, Button, buttonClass); the
> design-sync-only exports, dead `ThemeToggle`, and 8 dead globals.css utilities are deleted.
> Display-only; no scope/timeline impact on other lanes. Rollout:
> `docs/rollouts/2026-07-16-public-renderer-decision-legacy-primitives-slim.md`.

> **2026-07-15 - SEC/RAG Backfill: Phase 2 — Discovery and Archive (Antigravity/AG, branch `agent/ag-rag-backfill-p2`).** Implemented Phase 2 (Discovery and Archive) of the SEC/RAG 1,000-stock high-yield backfill plan. Built a host-wide `SecRateLimiter` class (token bucket, 4 req/sec default) with dynamic 429 `Retry-After` backoff handling. Integrated this rate limiter into `politeFetch` calls in `http.ts` for all `.sec.gov` requests. Implemented a local raw-artifact caching layer in `sec-filings.ts` to check, save, and retrieve SEC documents locally before hitting the network. Added historical submissions JSON shard traversal (supporting filings listed in `filings.files` when limit is not met by `recent`). Created the `fetchFilingDirectory` helper to download and parse `index.json` directory structures for future exhibit resolution. Verified via newly added test suite in `test/sec-backfill-p2.test.ts` (100% green), existing `sec-filings` tests, and a successful Next.js production build check. PR #1665 created and auto-merge armed.

> **2026-07-15 - Durable state: persist in-memory rate-limiters/cooldowns across restarts (MONET,
> branch `monet/durable-state-restart-survival`).** Owner directive after fleet-wide auto-deploy went
> live: any in-memory guard against a real external cap or duplicate-action risk must survive a
> mid-session container replacement. New shared `createDurableMap` primitive
> (`src/lib/durable-state.ts`); persisted `RequestQuota`, the usage-budget alert cooldown, and the
> congress-share send throttle after a 32-site discovery sweep. Two other candidates
> (`order-replacement.ts`, `triggers.ts`) turned out to already be independently and more completely
> solved by another agent while this branch was in flight — deferred to those, dropped the redundant
> local wiring. Full gate green; landing via PR next. Rollout:
> `docs/rollouts/2026-07-10-durable-state-restart-survival.md`.

> **2026-07-15 - Primary-account Usage Monitor credential bridge writer
> (CODEX).** Implement the default-off writer half of API Usage Monitor PR
> #286: read only the fixed primary `local` user's Gemini and DeepSeek rows;
> publish active values then a strict manifest-last monotonic complete set to
> fixed ST `prod` `/usage-monitor/st-primary/v1`; retain delete-free revoked
> tombstones; reconcile through the single-leader scheduler and immediate
> tracked-key triggers; document least-privilege writer/read-only reader
> identities. Focused/integration checks and the serialized full gate are green;
> hostile writer findings are fixed. API Usage Monitor reader PR #293 is live
> and healthy at `c6c4c8f` with the compatible bridge-only unexpanded-value
> contract, so publish this default-off writer through a ready PR, hosted
> checks, protected merge, and Coolify auto-deploy observation. Identity
> creation, production configuration, secret mutation, and activation remain
> out of scope.

> **2026-07-15 - Open-PR cleanup and production verification (CODEX).** PR #1586 and PR #1612
> are merged and production health reports exact `main@3c015a52`. Stale overlapping PRs #1610 and
> #1611 are closed as superseded; the open PR list is empty. FMP transcripts remain default-off until
> entitlement/rights and activation/backfill authority are confirmed.
>
> **2026-07-13 - FMP transcript producer (CODEX).** Add a production-inert, default-off,
> rights-confirmed FMP earnings-call transcript source with tracked stable-endpoint requests,
> independent cadence/lease/cursor/budgets, ticker-period identities, first-observed PIT timing,
> retryable incomplete states, content-derived dedup plus occurrence identity, rights-aware
> Strategy/Coach retrieval,
> source status, and focused telemetry/safety tests. Do not enable production until the FMP plan
> exposes both endpoints and the agreement permits persistence/embedding/display. Speaker/Q&A
> segmentation and cited derived briefs require entitled representative fixtures before broad corpus
> rollout. Starter is below its advertised rate/bandwidth limits but not entitled to transcripts;
> surface that as a plan exclusion, never as quota exhaustion. See
> `docs/rollouts/2026-07-13-fmp-transcripts-safe.md`.
> Round-9 closes the subsequent nine-finding durability/rights review: atomic provider request/cost
> reservations precede every FMP/Voyage/Pinecone boundary; dispatch outcomes survive lease loss and
> crash-left calls reconcile to durable `unknown` outbox events; managed vectors remain pending until
> exact provider plus relational receipts commit and retrieval validates every identity/version field.
> Transcript revisions retain full SHA-256 content versions and first-content-seen PIT rows, ingestion
> is operator-only, SEC uses the same lease guard, embedding revision stays at v1 pending a real corpus
> migration, Strategy language is source-neutral, and rights tooling performs bounded dry-run inventory
> plus provider-first verified purge. Account deletion covers the new user-scoped receipts/outbox rows.
> Generic FMP and transcript calls share authority within Socratic.Trade; production remains blocked on
> confirmed commercial rights and a genuinely shared cross-app transactional quota authority. Round-10
> captures the complete implementation in local checkpoint `52cfcbec`, cleanly merges
> `origin/main@4432c2bc` in `0713a254`, and uses an awaited Edge-safe Web Crypto SHA-256 credential
> fingerprint after the first current-main production build exposed a transitive `node:crypto` import.
> The final Node 24 gate is green: lint 0 errors / 458 inherited warnings; TypeScript clean; 369 files /
> 4,145 tests; production build with the real TypeScript phase and 32 static pages; diff-check clean. Fresh
> hostile review found no remaining P0/P1/P2 code issue. This lane is locally code-ready; no push or PR is
> authorized yet, and activation/backfill remains blocked on an entitled plan, commercial rights, and the
> shared authority. A future PR, merge/autodeploy, and live verification require explicit follow-through.
> Round-11 landing review found and locally remediated one missed managed-commit cardinality defect:
> nonzero ingest/write-budget prefixes can no longer commit full-document receipts or become retrievable.
> The immutable original occurrence count now gates receipt persistence and provider promotion; partial
> prefixes remain pending with zero receipts and a later SEC retry commits the exact full set. Node 24:
> exact regression 6/6, related focused tests 106/106, lint 0 errors / 458 inherited warnings, TypeScript
> clean, 369 files / 4,147 tests, production build with real TypeScript and 32 static pages, diff-check
> clean. Hostile re-review found no remaining P0/P1/P2 in scope. Root review is pending; still no push/PR.
> Round-12 then rejected publication on committed-replay demotion, same-commit writer races, an SEC 8-K
> false-complete path, and zero/partial occurrence gaps. Round-13/14 now preserve committed generations,
> serialize exact commit attempts, gate every filing caller on `documentComplete`, reject empty documents,
> compensate Pinecone topK for locally proven stale managed generations, and make tenant scope authoritative.
> Personal decision/experience memory is private even for the local operator; provider-first account deletion
> inventories and fetch-verifies the subject's vectors before deleting local secrets/receipts, while preserving
> shared public corpus and globally deduplicated chunk text still referenced by it. Current Node 24 focused
> evidence is 20 files / 256 tests plus 2 privacy/deletion files / 22 tests, TypeScript clean, and diff-check
> clean. Round-15 then makes nonlocal/shared scope impossible, holds a durable account-operation claim across
> every private document provider/receipt write, requires current provider authority plus consecutive-clean
> account erasure verification, tracks and purges transcript-derived artifacts/provider work, rejects legacy
> Auth.js cookies after an account-generation tombstone, retries lock-contended trigger events, and centralizes
> ownership/fencing for all user-scoped internal settings. Current targeted proof is 20 files / 302 tests plus
> 4 derived-rights tests, TypeScript, and diff-check. Checkpoint this snapshot, merge `origin/main@2dabc7f8`,
> renumber transcript/vector migrations behind main's versions 27-28, then run the ordered lint/TypeScript/test/
> build gate and fresh hostile review. Draft PR #1586 stays HOLD until those gates pass; do not enable
> transcripts or run a corpus backfill regardless of code-merge state.
> Round-16 reconciles `origin/main@2dabc7f8`: main keeps migrations 27-28 and the transcript/vector
> lane is renumbered 29-39; proposal plus Socratic-decision writes remain atomic while FMP-derived
> decisions keep rights-generation/provider-work receipts. Hostile review found and the branch fixes
> two additional P2s: Cloudflare Access assertion `iat` now participates in post-deletion identity
> generation, and broker-minimum alert cooldowns are user-scoped for the shared settings fence/eraser.
> Node 24 TypeScript and the merged targeted set (9 files / 99 tests) are green. Fresh hostile re-review
> and the ordered full gate remain before #1586 can leave draft.
> Rounds 17-20 supersede the Access-token freshness design with signed Auth.js `loginAt`, bind licensed
> private derivative writes and purge receipts to immutable rights generation plus exact provider/ledger
> authority, and require consecutive clean provider observations before deleting local evidence. Treat
> an acknowledged zero-write as `no_provider_write`, but any provider error/timeout after dispatch as
> `provider_write_unknown` and therefore an exact purge obligation. Filter tenant-, receipt-, and
> transcript-rights-ineligible records inside each provider tier before the fair 1,000-document rerank
> cap so stale generations cannot crowd out current evidence; carry tier identity through multi-query RRF
> and apply one final fair cap before reranking. Chunk relational receipt lookups below SQLite's portable
> host-parameter ceiling so the legal six-tier/60,000-candidate provider pool cannot fail closed by
> accidentally discarding every managed match. Round 21 removes transitive `node:` imports exposed by
> the production build: immutable derivative IDs use edge-safe Web Crypto SHA-256, the already-tested
> abort-aware retry pause owns erasure backoff, and document construction requires the precomputed ID
> to remain paired with its rights generation. Current-main reconciliation includes `origin/main@58de276e`
> after PR #1607 merged. The doc-type coverage integration test now supplies deterministic encryption, the
> vector authority mocks required by the licensed-memory path, the required proposal regime field, and
> realistic timeout headroom; the Infisical signal-forwarding fixture supplies its own fake app identity/login.
> Focused verification is green at 15/15 and 37/37, and `docs/BRANCH-INTEGRATION-LEDGER.md` records branch
> dispositions for future agents. Round-23 fixes the final focused rights review: transcript retrieval requires
> the durable active rights gate, derived Socratic-memory dedup hashes are included in rights purge, and unrelated
> Pinecone upserts no longer block transcript erasure. Focused remediation verification is green at 31/31.
> Round-24 closes the focused strategy/regime and suite-load compatibility fallout: Red Team prompt stubs now
> distinguish review calls from Green/strategy calls, vector-authority mocks match the current licensed-memory
> contract, heavy strategy cases have realistic timeout headroom, and the Infisical signal-forwarding regression
> has enough full-suite load margin. Focused verification is green at 23/23 for regime/drawdown, 37/37 for
> Infisical, 15/15 for RAG doc-type coverage, 31/31 for transcript rights/retrieval, and standalone TypeScript.
> Local full/grouped gates are currently host-pressure limited rather than assertion-limited: grouped tests ended
> with 143 and repeated production builds were OS-killed with 137 while other agent runners respawned. Push the
> current branch and let hosted `verify` provide the authoritative full lint/test/build result, then mark ready, merge,
> and verify the automatic production deployment without enabling transcript ingestion or backfill.
> Round-25 removes a DB-barrel import cycle from the FMP transcript module; the RAG doc-type focused test now passes
> without the prior `FMP_TRANSCRIPT_SOURCE` TDZ warning. The FMP rights-derived artifact hook has 120s setup headroom
> and passes focused 10/10; standalone TypeScript is clean after the import split.
> Hosted gitleaks then failed on the historical deterministic `ENCRYPTION_KEY` fixture commit even though the current
> tree uses `"0".repeat(64)`; `.gitleaksignore` now includes the exact false-positive fingerprint for a normal recheck.
> Round-27 fixes the hosted vector chunk-cap test fixture by adding the durable active transcript-rights gate row to
> its DB mock; focused verification passes 14/14.
> **2026-07-14 - Infisical JSON-export production compatibility (CODEX).** PR #1594 merged,
> but its automatic Coolify deployment failed health checks and rolled back because pinned
> Infisical CLI v0.43.98 emits `export --format json` as an array of secret records while the
> merged runner expected a flat object. Parse only validated `{ key, value }` records, reject
> malformed or duplicate keys without exposing output, repeat the full Node 24 landing gate,
> and verify the exact corrective merge SHA in production before releasing dependent work.
> **2026-07-15 - FMP coverage and market-data reliability (CODEX).** Make interactive Market Scan
> return within an HTTP budget by keeping paced deep ingestion off the request path, reusing the
> latest completed strategy scan's slow facts while refreshing prices, coalescing identical
> refreshes, and bounding the Nasdaq fetch; preserve full enrichment in scheduled/strategy
> work and bounded on-demand ticker detail. Replace Socratic.Trade's legacy FMP v4 calls with stable,
> header-authenticated profile and insider-search routes; map the useful ratios/profile fields already
> paid for; keep congressional truth in Congress.Trade; and document the plan/entitlement boundary for
> scheduled statements, metrics, estimates, calendars, news, and transcripts. Transcripts stay disabled
> while the current subscription returns HTTP 402. Complete focused/full gates, browser QA, ready PR,
> hosted verification, protected merge, and exact auto-deploy verification. See
> `docs/rollouts/2026-07-15-fmp-market-data-reliability.md` and `docs/fmp-capabilities.md`.
> Local browser QA is green. The first landing gate passed 4,375 tests/build and opened ready PR #1618.
> `main` advanced during that gate through PR #1616's broader FMP adapters; `d3efc9a6` is now reconciled,
> the shared adapter path has header auth plus durable endpoint accounting, and scoped lint/TypeScript
> plus 5 files / 163 overlap tests pass. The final land gate passed 381 files / 4,377 tests and build;
> refreshed head `8949ebd8` is pushed to ready PR #1618. Require hosted checks, protected merge, then
> verify the exact auto-deployed release.
> Hosted review then found three P2s: unbounded BlackRock discovery, incomplete scan single-flight
> identity, and immortal hung quote entries. Abort propagation plus a hard scan deadline, complete
> scan keys, and a 30-second quote lease are implemented; scoped lint/TypeScript and 26 review tests
> pass. Final exact-tree land passed 381 files / 4,381 tests and build; code head `3df82396` was pushed.
> All review threads and hosted gates passed. PR #1618 squash-merged as `28eab7cb`; Coolify deployment
> `a140o5e4sh3vh7ylqzzwu1qr` finished on that exact SHA, and production health verifies the release,
> current scheduler lease, FMP/Congress dependencies, and Litestream replication. This lane is complete.

> **2026-07-14 - Infisical JSON-export production compatibility (CODEX) — COMPLETE.** The
> initial PR #1594 deployment failed closed and rolled back safely; corrective PR #1604 merged
> as `f54e43aaba1589af2467b4ec2fc2be5eb461e1e8`, and Coolify deployment
> `rkh3ifiyp2dbtvv7xz7rtnbn` finished on that exact SHA. Public production health is green for
> the app/DB, current scheduler lease, Litestream replication with a valid sync timestamp, and
> Congress/usage-monitor dependencies. The remaining cached-CLI version check is nonblocking P3.
> See `docs/rollouts/2026-07-14-infisical-export-json-compat.md`.

> **2026-07-14 - Local Infisical bootstrap wiring (CODEX).** Resolve the Socratic and shared
> machine identities before the Infisical runner authenticates, with process env > `.env.local` >
> secure global-file precedence; support both the owner-provided `INFIISICAL_ST_*` spelling and its
> corrected alias plus `INFISICAL_CT_SHARED_*`; normalize only in process memory; default known
> nonsecret project IDs without forcing a shared overlay; reject incomplete pairs; and prove no
> unrelated global key or long-lived credential reaches the app child. Review found three P1s and
> three P2s: same-source token-before-pair selection, Next reload reintroduction, runner-lifetime
> credential retention, broad CLI inheritance, ambient path override, and overbroad global aliases.
> All are remediated with pair-first resolution, immediate auth scrubbing, minimal CLI environments,
> a fixed global path, a narrow ST/CT-shared allowlist, and an argv-safe post-injection wrapper whose
> real `@next/env` regressions are green in normal and watch paths. Descriptor-level file hardening
> and managed-only inert parsing also remain green. JSON export preserves exact values, CLI domain
> routing remains explicit, preload hooks execute only after masking, and signal/argv/NUL/conflicting
> alias/shell-block regressions are green. The branch is rebased on `origin/main@acd67a5c`; a force-quit-
> contaminated npm Git-dependency cache initially installed declarations without runtime bundles, but
> isolated installs proved the immutable shared-package release healthy and a disposable-cache reinstall
> restored all CJS/ESM/type artifacts. The exact-tree Node 24 gate is green: lint 0 errors / 459 inherited
> warnings, TypeScript, 369 files / 4,161 tests, and a production build with all 32 static pages. Publish
> through `scripts/land.sh`, require hosted verification, then verify the automatic production rollout.
> See `docs/rollouts/2026-07-14-infisical-bootstrap-wiring.md`.
> **2026-07-14 - Final open-PR reconciliation (CODEX).** Reconcile PR #1589 with current
> `origin/main`, correct stale merged/closed PR and effort-board state, resolve all review threads,
> run the documentation branch through the canonical Node 24 gate, update the existing PR head
> without rewriting history, and squash-merge after hosted checks. Then finish PR #1586 and verify
> the exact auto-deployed production release. See
> `docs/rollouts/2026-07-14-pr-resolution-cleanup.md`.
> **2026-07-14 - Adopt immutable congress-trading-shared v1.7.1 (CODEX).** Replace the
> exact `v1.6.0` commit pin with the immutable `v1.7.1` commit
> `0bc26ab9311a396f3f6b5cba0fb54fa7558a42b4` across `package.json`, npm
> `allowScripts`, and `package-lock.json`; regenerate through Node 24 with a fresh
> disposable cache; prove non-empty JS/MJS/DTS/DMTS artifacts and both require/import
> resolution; then run the serialized lint, standalone TypeScript, full test, and
> production-build gate on current `origin/main`. Land through `scripts/land.sh`, require
  > hosted verification and protected squash merge, then verify the exact automatic production
  > rollout and dependency health. Ready PR #1607 merged as `58de276e`; production verification is included
  > in the final all-PR release check after #1586 lands.
> See `docs/rollouts/2026-07-14-shared-v171-consumer.md`.

> **2026-07-14 - TypeScript gate repair (CODEX).** Replace PR #1531's split TypeScript 7 CLI /
> TypeScript 5 compiler-API arrangement with one supported TypeScript 6.0.3 graph; remove the
> postinstall mutation, module-resolution hooks, Next override, and `ignoreBuildErrors` bypass;
> enforce Node 24 across hosted/self CI, landing, and Node declarations; and prevent unsupported
> automated compiler/runtime-type upgrades. Hostile-review remediation is complete: parsed lock/YAML
> and active-source policy coverage is 5/5, clean-install/lock determinism, scoped lint, standalone
> TypeScript, Bash 3/runtime guards, YAML parsing, and diff-check pass. The earlier repo-wide lint,
> 4,041-test run, and two production builds prove the restored Next `Running TypeScript` phase. Fresh
> review accepted the remediation and the final ordered full gate is green (lint, TypeScript,
> 4,043 tests, and a production build with the real TypeScript phase). Reconcile current main, then
> publish a ready PR and require hosted verification.
> See `docs/rollouts/2026-07-13-typescript-toolchain-gate-repair.md`.
> **2026-07-13 - Development background-worker safety gate (CODEX).** Preserve production's
> default-on scheduler/usage-replay/stream boot while making every non-production runtime fail
> closed unless `DEV_BACKGROUND_WORKERS=on` is explicit. Centralize the decision and startup receipt,
> test both disabled and explicit opt-in paths without importing real workers, document the flag,
> and require disposable local smoke plus the full ordered gate before a ready PR. Independent
> review and the Node 24 local gate are green; publish through `scripts/land.sh`, require hosted
> verify, then confirm the production boot receipt and scheduler health after auto-deploy. This prevents
> UI-only localhost QA from launching broker/provider/RAG work against copied or credentialed data.
> See `docs/rollouts/2026-07-13-development-background-workers.md`.

> **2026-07-13 - Account-relative daily risk and decision clarity (CODEX).** Replace the fixed $500
> daily-opening default with one canonical dollar-or-percent mode (20% NAV default), preserve
> explicit legacy dollar choices, and route the resolved value through policy gates, approval-time
> rechecks, prompts, capital posture, mobile data, and AI strategy review. Persist app-computed
> notional/NAV arithmetic; clear impossible Alpaca whole-share bracket fields before fractional
> submission; and render Green Team, sizing/risk, Red Team, and deterministic outcome as distinct
> sections with explicit verdict wording. PR #1561 merged as `3e105e17`; required hosted checks passed
> and that exact release is healthy in production. A review posted after auto-merge found three P2
> gaps. The active follow-up persists Green/sizing receipts across refreshes, makes v26 cover every
> legacy policy store without reinterpreting later intentional dollar choices, and separates a Red
> override request from a final applied override. It also reruns Red exactly once after a
> broker-minimum size mutation, preserves independent human-review reasons, atomically commits the
> broker intent with its Socratic case, synchronizes lifecycle truth transactionally, serializes
> same-decision vector updates, and keeps uncertain submissions in `placing`. The latest hostile
> blockers are implemented: `filled` orders remain in caps and every success/count/UI/outcome
> consumer; independent holds have structured owner-facing reasons; lifecycle sync preserves
> learned fields; and an atomic approval claim requires a proposed Socratic case. The final two
> race/recovery defects are closed: chat draft idempotency spans proposed through filled under an
> immediate transaction, and stale broker-filled orders finalize an existing pending receipt with
> proposal/case truth atomically. A final audit also handles terminal partial executions everywhere,
> makes direct broker receipt + lifecycle commits atomic/recoverable, scopes replacement dedupe, and
> binds legacy chat-case repair to the historical account. The final price/quantity review is also
> closed: unpriced broker receipts store zero rather than estimates, cumulative execution is
> monotonic, replacement partials remain refId-recoverable, and the active replacement index is
> user-scoped. Current `main@07c2da3f` is integrated and independent re-review reports no P0-P2
> findings on that snapshot. The later hosted review found one P1 ordering gap: sell-to-fund could
> liquidate a holding before a broker-minimum-adjusted buy entered a final-size Red hold. The fix
> now correlation-gates and caches tradability, broker minimum, exact-size Red, policy, and override
> preflight before funding notional is calculated. Correlation-dropped, broker-unplaceable,
> human-held, and non-funding policy-blocked openings fund `$0`; a valid cumulative buying-power
> shortfall remains eligible. Regressions cover both no-sale-on-hold and exact cumulative funding,
> and placement reuses the cached shape. Hosted autofix also synchronized account-switch cap-mode drafts and kept unpriced
> fill growth pending. The prior ordered Node 24 gate is green: lint 0 errors / 458 inherited warnings,
> standalone TypeScript clean, 368 files / 4,124 tests, and a production build with the real
> TypeScript phase plus 32 static pages. `scripts/land.sh` repeated current-main TypeScript, all
> 4,124 tests, and the build before opening ready PR #1587. The local ordering remediation passes
> TypeScript and 3 focused files / 20 tests. The combined-tree ordered Node 24 gate is green:
> lint exit 0, standalone TypeScript clean, 368 files / 4,128 tests, and a production build with
> the real TypeScript phase plus 32 static pages. Push, resolve the review, merge after hosted
> verification, and verify the exact production release.
> The last hosted P2 is also closed: final-size owner consent carries the exact broker estimate it
> covers. A fresh upward estimate above the greater of 1% or $0.01 is persisted and re-queued for
> one new click; downward/immaterial drift remains within the approved envelope. Focused final-size
> verification is green (3 files / 21 tests plus standalone TypeScript); the repeated full gate
> passes lint, TypeScript, 368 files / 4,128 tests, and the production build.
> See `docs/rollouts/2026-07-13-account-relative-risk-and-decision-clarity.md` and
> `docs/rollouts/2026-07-13-account-relative-risk-postmerge-review.md`.
> Continuation: `docs/rollouts/2026-07-14-final-size-red-and-lifecycle-truth.md`.

> **2026-07-13 - Decision-evidence architecture program (CODEX, owner-directed).** Implement the
> complete source-to-decision boundary before adding more feeds: wider bounded enrichment;
> field-level provenance/freshness/failures and upstream-family arbitration; exact candidate
> enforcement; immutable Green/Red evidence parity; point-in-time RAG, prompt-data containment and
> global context budgets; account-scoped relational/vector learning with independently validated
> paper-to-live transfer (later deleted; pooling is current retrieval); source coverage, shadow
> ablation and outcome-linked value telemetry; and
> the same evidence contract for strategy review, learning review, Framework, and Coach. Remove the
> product Test Account and purge its simulated outcomes, while retaining real broker paper accounts
> (pooling, not a 20+5 transfer gate). Add GPT-5.6 Luna/Terra/Sol plus role-specific
> effort controls across every LLM surface; curate out full GPT-5.4/5.5 but keep Mini/Nano and legacy
> custom IDs. Implementation, current-main reconciliation, and the full verification gate are
> complete; PR #1544 merged as `60703dfe` and that exact release is healthy in production. See
> `docs/reviews/2026-07-13-decision-evidence-architecture.md` and
> `docs/rollouts/2026-07-13-evidence-architecture-gpt56.md`.
## SEC/RAG 1,000-stock implementation train

**Status: In progress; corpus writes gated**

**2026-07-22 routing boundary:** strategy callers must declare information needs. Current
prices, portfolio/positions, orders, SEC XBRL facts, and Form 4 transactions stay deterministic;
only filing/transcript/lesson/research narrative is eligible for semantic retrieval. Unknown needs
fail closed. Next integration is to make the same contract the shared entry point for chat and the
evidence-consumption receipt, without changing the trading verdict path.

- **[~] Wave A — prerequisite truth:** the versioned/checksummed universe acceptance contract and durable
  job/task state with leases, strict transitions, retries, dead-letter/quarantine, verification receipts, and
  replay invariants merged in PR #1543 after local/hosted gates. Corrected universe selection, census truth, and
  adversarial integration remain in progress. Three post-merge P2 durability findings (failure reasons, checksum
  immutability, lease config) are locally green on `codex/sec-rag-foundation-postmerge` in ready PR #1559.
  Production is verified on foundation release `cbe3e532`; hosted follow-up acceptance and corpus gates remain.
- **[~] Wave B — source correctness:** discover recent plus historical submission shards and filing exhibits;
  archive immutable raw artifacts; enforce one aggregate SEC limiter; parse DOM/iXBRL sections, tables, units,
  contexts, and footnotes; chunk against provider token budgets.
- **[~] Wave C — structured and searchable evidence:** normalize XBRL, insider, ownership, offering, and event
  facts; add a true corpus-wide lexical index; fuse dense/lexical recall, rerank wide, diversify, and return
  typed evidence packets with strict point-in-time filtering. The read-only FTS5 source in
  `src/lib/rag/corpus-wide-lexical.ts` is now wired default-off beside dense recall before one rerank,
  with tenant, rights, committed-version, and stale-legacy guards.
- **[ ] Wave D — evaluation and consumption:** build real-EDGAR parser/fact/retrieval/grounding fixtures and
  metrics; replace the generic three-chunk strategy blob with issuer-scoped scout/deep dossiers and verified
  evidence references.
  - **[~] Production-path retrieval evaluator (2026-07-21):** `eval:rag-production` calls
    `retrieveContextDetailedWithStatus` with immutable authoritative-as-of timestamps, real vector-id
    diagnostics plus stable provenance relevance selectors, machine-readable relevance/PIT/coverage/latency/usage receipts, and explicit comparison labels.
    Curate version-controlled JSON cases from frozen EDGAR evidence and run controlled shadow comparisons before changing defaults.
  - **[~] Hosted-inference candidate (2026-07-21):** benchmark Pinecone `/embed` and `/rerank` directly
    against frozen candidate pools before assuming self-hosted or routed BGE/Cohere is best. This is bounded
    by absolute CLI caps, read-only, account-availability-gated, and it never touches the production index.
- **[ ] Wave E — controlled operations:** only after gates, run shadow 10 -> 25 -> 100 -> 300 -> 1,000 breadth-
  first waves with cost/rate/failure breakers, reconciliation, dual-read/write, rollback, and freshness SLOs.

The highest-yield backfill order remains: freeze the exact 1,000-CIK universe plus a private priority overlay;
archive immutable raw SEC artifacts broadly; embed 10-K/10-Q decision sections, material 8-K exhibits, and only
entitled transcripts selectively; retain XBRL/fundamentals as structured facts; checkpoint by CIK/accession; and
expand only after each 10 -> 25 -> 100 -> 300 -> 1,000 wave passes coverage, citation, PIT, cost, and failure gates.
The production bulk worker must consume historical submissions shards rather than recent-only discovery. Crash
repair must combine provider-page ghost cleanup with a local keyset whole-commit verifier; never page an exact-set
commit reconciliation in a way that can split one commit across pages, and never rewrite PIT intervals/heads during
repair. No 1,000-stock provider or corpus write is authorized yet.

Node 24 remains the supported runtime. Node 26 is installed on the host but is not adopted while `.nvmrc`, CI,
production, and the `better-sqlite3` native ABI are pinned to 24.

## Codex Audit Wave 0: Base Guardrails
**Status: In Progress**

- **[x] PR 1: X0.1 & X0.2 Safety Maintenance & Draining Fence**
  - X0.1 Safety Maintenance Coordinator: Run all side-effecting sweeps (fill reconciliation, stale intents, stale exits, synthetic stops) strictly before strategy admission, with strict network deadlines (15s). Ensures side effects execute exactly once per tick and never hang the singleflight guard.
  - X0.2 Draining Fence: Hard pre-placement veto if the account's state is `draining` or `deleted`. Capture `accountNumber` and `policyRevision` onto the `strategy_runs` snapshot.
  *(Completed 2026-07-12)*
- **[x] PR 2: X0.3 Exit Replacement State Machine**
  - Migrated limit order market-replacements to a robust, database-backed state machine.
  - Added original order detail columns (symbol, side, type, quantity, filled quantity) to SQLite schema and reconstructed orders when missing from broker.
  - Implemented auto-mode-off continuation and full reconciliation/recovery for in-flight `replacement_submitted` rows.
  *(Completed 2026-07-13)*
- **[ ] PR 3: X0.4 Strict P&L Fence**

# Improvement Plan - Socratic Trade

Eight-phase roadmap to make the dashboard genuinely autonomous, more accurate,
measurable, customizable, and easier to operate. The current codebase is treated
as partially complete; implementation should preserve working controls while
filling the missing pieces.

> **2026-07-14 - Decision-detail dissent deduplication (CODEX).** No roadmap scope
> change. `/console/decisions/[id]` now shows a structured Red Team verdict once,
> filters only exact/generated copies of that explanation from the generic dissent
> list, preserves distinct policy or override objections, and keeps approve-at-half
> and rejection status explicit on the canonical card without repeating rationale. See
> `docs/rollouts/2026-07-14-decision-dissent-dedup.md`.

> **2026-07-12 - SEC/RAG 1,000-stock high-yield backfill architecture (CODEX).** The approved planning
> direction is “archive broadly, embed selectively”: catalog all SEC filings; preserve selected immutable
> originals; keep XBRL, insider, ownership, and financing facts structured; embed sectioned narrative, tables,
> and material exhibits with occurrence-level provenance; and expose derived summaries only as cited children.
> The current recent-10-K/10-Q scheduler is not the bulk runner. Round-8 FMP/RAG hardening now materializes
> each new `storeDocument` occurrence as its own vector; before a 1,000-issuer write, reconcile any legacy
> content-hash occurrence loss and finish artifact/job state, historical/exhibit discovery, DOM/iXBRL tables, PIT dates,
> true lexical recall, real-corpus evaluation, coverage truth, and config drift. Then use a shadow corpus and
> gated 10 -> 25 -> 100 -> 300 -> 1,000 breadth-first waves. See
> `docs/reviews/2026-07-12-sec-rag-1000-stock-backfill-plan.md` and
> `docs/rollouts/2026-07-12-sec-rag-1000-stock-backfill-plan.md`.
> **2026-07-12 - Capability & Platform Expansion program, Phase 1 (CLAUDE, owner-directed,
> team-of-agents).** New program alongside this roadmap, not a replacement for it: seven
> workstreams (iOS honest-reset-then-build, web-app consistency, trading-framework
> calibration, short-selling+leverage, options groundwork, Kalshi, eToro), all landing
> dormant/default-off per-account double gates in the proven short-selling shape. Phase 1
> (recon/design/feasibility/synthesis) is complete; full plan, package train, sequencing
> waves, owner-decision list, and dissent are in
> `docs/reviews/2026-07-12-capability-program-plan.md` — not duplicated here. Builds on the
> existing Tradier broker capability work (`docs/broker-capability-plan.md`). See
> `docs/rollouts/2026-07-12-capability-program-phase1.md`.

> **2026-07-11 - Team names back to Green Team / Red Team (CLAUDE).** Copy-only rename: console
> surfaces that had drifted to "Proposer"/"Reviewer" seat labels now lead with Green Team / Red
> Team everywhere user-visible; internal identifiers and prompts untouched. Also fixed stale help
> copy claiming a blank Red Team self-reviews (it fails closed to human approval). See
> `docs/rollouts/2026-07-11-team-names-green-red.md`.

> **2026-07-11 - Trading-framework doc + public /framework page + AI-scrape hardening (CLAUDE).**
> No trading-behavior change; documentation + one new public marketing surface + edge/app
> anti-extraction hardening. New `docs/trading-framework.md` (net-new, framework-level map of the
> whole pipeline: 8-stage summary, per-layer detail, invariants, honest weaknesses; explicitly does
> not supersede strategic-framework/phase-7/single-adversary docs). New human-eyes-only page at
> `/framework` (how-it-works page pattern, three themed SVG diagrams) whose prose is served only via
> a gated content API — never present in HTML or client chunks; UA gates in page+API, robots/noai/
> TDMRep directives, no-store, sitemap-excluded, unlinked. Cloudflare zone: `ai_bots_protection=block`
> + a `/framework*`+`/api/framework*` WAF UA-block rule (live already; Bot Fight Mode deliberately NOT
> enabled — webhook/ops traffic risk). Middleware change is two PUBLIC_PREFIXES lines. 9 new focused
> tests. See `docs/rollouts/2026-07-11-framework-page.md`.
> **2026-07-11 - Whole-app audit and prioritized correctness fixes (CODEX, in progress).** No roadmap
> phase change. The current-main audit added 34 reproducible findings to both effort boards (8 P0,
> 18 P1, 8 P2). The first P0 account-scope slice is implemented: account switching passes through the
> dirty guard, account editors remount, account-scoped policy/prompt writes carry an owned target,
> prompt+policy persistence is atomic after validation, and same-tab card writes serialize. This
> branch also implements synthetic-stop account targeting, mobile initial/command truth, and
> Robinhood OAuth exact-state/origin integrity. The mobile refresh race has a bounded/coalesced core
> fix; SSE-outage fallback polling remains. Remaining rows stay separately prioritized rather than
> being folded into an unsafe monolithic change. See
> `docs/rollouts/2026-07-11-app-wide-audit-account-scope.md`.

> **2026-07-11 - Durable provider/dataset operation leases (CODEX).** No product-roadmap or
> scheduler-loop change; reliability/cost correctness only. The manual admin guards and background
> entrants now converge on four durable SQLite owner-token lease groups below the route layer:
> RAG reindex/filing ingest, Congress daily share, Congress refresh, and SEC 8-K refresh. Claims are
> acquired before admin rate debit, heartbeated for long operations, owner-checked on release, and
> passed opaquely into core boundaries. Ownership loss aborts cooperatively, and non-force cadence is
> rechecked after acquisition. Background contention is a typed benign skip with no cadence marker
> advancement; admin contention remains a shared-contract HTTP 409. The intentionally detached 8-K
> embedding tail remains a documented pending/retry-job follow-up. Final current-main Node 24 gate is
> green (focused 130, lint 0 errors, typecheck, full 3,759 tests, build); ready-PR delivery remains. See
> `docs/rollouts/2026-07-11-provider-operation-leases.md`.

> **2026-07-11 - Truthful notification delivery status (CODEX).** No product-roadmap change;
> delivery observability and preference correctness only. One gated orchestration path now owns
> push/webhook/email/SMS delivery for ordinary, price-alert, and provider-health events; callers
> supply only their richer body text. Status derives from every actual result, unexpected bridge
> failures cannot masquerade as neutral skips, partial failures remain visible, and the legacy
> policy-webhook lane emits normal channel telemetry. The operator fallback email remains an extra
> gated lane. The branch is reconciled through strategy merge `main@0dda52db`; the final Node 24 gate
> is green: focused 7 files / 96 tests, repository lint, TypeScript, full 342 files / 3,816 tests,
> production build, and diff-check. Ready replacement PR, #1442 supersession, hosted checks, merge,
> and production verification remain. See
> `docs/rollouts/2026-07-11-notification-status-truth.md`.

> **2026-07-11 - Runtime release and recovery-path observability (CODEX).** No roadmap scope
> change; this is an operations-observability slice. `/api/health` gains a public-safe source
> revision/process identity and hard-deadline, size-capped Litestream daemon status/last-sync
> inspection over its local IPC socket. Production explicitly enables the v0.5.12 socket and skips
> the non-verifying metadata-file fallback; staleness requires evidence of newer local DB/WAL activity.
> See `docs/rollouts/2026-07-11-runtime-release-backup-health.md`.
> **2026-07-11 - Strategy lease correctness + default-on scheduler (CODEX).** No roadmap scope
> change; this closes a money-path concurrency hole in the existing Phase 1 lock design. Approval
> and autonomous runs heartbeat unique account leases, snapshot one account for every later read/write,
> and re-prove ownership after each long await before unrelated persistence. Durable non-placement and
> broker outcomes remain in failed run receipts when ownership disappears; approval cannot report a
> persisted block as `busy`. Scheduler signal shutdown retains the leader lease until TTL while detached
> broker work may exist, and account-scoped auto-tuning runs only after completed strategy runs under its
> own renewed account lease and LLM reservation. A final independent review additionally fixed the
> account-bound strategy prompt, propagated account scope into walk-forward evidence, honored a lost
> proposal-transition race, and computes tuning time only after the strategy run finishes. PR #1429
> passed local and hosted gates with zero unresolved threads and merged as `0dda52db`; production now
> reports that exact release with healthy scheduler/Litestream/dependency checks. The final Node 24 gate was green: focused
> 11 files / 129 tests, repository lint, TypeScript, full 341 files / 3,801 tests, production build,
> and diff-check. See
> `docs/rollouts/2026-07-11-strategy-lease-correctness.md`.
> **2026-07-11 - Alpha Vantage admin health lane canonicalization (CODEX).** No roadmap scope
> change; operator-observability correctness only. The connections-health expected-lane inventory now
> uses the provider's canonical `alpha-vantage:env` identity, preventing a synthetic empty
> `alphavantage:env` card beside the real lane. Authenticated route coverage locks the one-lane
> invariant. No provider, secret, pacing, rotation, or quota semantics changed. See
> `docs/rollouts/2026-07-11-alpha-vantage-health-lane-canonicalization.md`.
> **2026-07-11 - Expensive admin-operation abuse/cost controls (CODEX).** No product-roadmap
> scope change; operator/security hardening only. Paid reindexes, expensive analysis, forced
> refresh/share, and broker probes now have named per-admin budgets and single-flight exclusion,
> returning explicit 429/409 responses before duplicate work reaches providers or long DB scans.
> Explicit validation/config rejection precedes quota admission; historical default-action body semantics
> remain unchanged. Process-wide groups cover manual admin route calls, while
> scheduler/background convergence at the underlying operation boundaries is explicitly planned rather
> than claimed complete. These are anti-repeat budgets, not hard per-request spend ceilings. Node 24
> PR #1409 is merged as `9552b648`; the later Tradier merge `e3d04221` restored all eight guarded
> route wrappers that #1409's merge had dropped. The released, clean-install-verified shared package
> `v1.5.0` is exact-pinned in follow-up PR #1426, whose app-local HTTP adapter delegates stable
> rejection body/status construction to the shared builders while retaining HTTP headers and legacy
> fields. It also keeps real Auth.js provenance coverage instead of a bypass mock. The current-main
> Node 24 gate is green: focused 29/29, lint 0 errors, tsc, 3,740/3,740 tests, and build. Refreshed
> hosted checks and the matched Congress.Trade peer pin remain pending. See
> fields. It also keeps real Auth.js provenance coverage instead of a bypass mock. The final
> `main@e395e65a` Node 24 gate is green: focused 29/29, lint 0 errors, tsc, 3,746/3,746 tests, and
> build. Antigravity's ready Congress.Trade PR #296 carries the exact matched pin with 940 tests
> green; its peer check becomes green after #1426 lands first. See
> `docs/rollouts/2026-07-11-admin-operation-abuse-controls.md`.
> **2026-07-11 - Usage telemetry delivery identity (CODEX).** No product-roadmap or trading-path
> change. The API Usage Monitor integration now supplies fixed-length explicit IDs for local ledger
> events, broker balance snapshots, and each aggregated provider-call window so same-flush credential
> lanes cannot collide under the shared five-field fallback. Ledger timestamps are reused on replay,
> and failed/ambiguous batches retain their exact events for bounded in-memory retry. See
> `docs/rollouts/2026-07-11-usage-telemetry-delivery-ids.md`.
> **2026-07-13 - Crash-durable usage telemetry replay (CODEX).** No product-roadmap or trading-path
> change. Every new usage event now declares `project:"socratic-trade"` while retaining the raw
> provider identity. A startup/one-minute worker reconstructs historical and new LLM/RAG events
> from their durable ledgers using existing row IDs/timestamps, ordered monotonic settings
> watermarks, acknowledged-only advancement, and idempotent one-row overlap. No schema or new env
> configuration is required. The producer checkpoint is blocked from merge/deploy until the API
> Usage Monitor receiver backfill is deployed. See
> `docs/rollouts/2026-07-13-usage-monitor-durable-replay.md`.
> **2026-07-11 - Admin authorization fail-closed hardening (CODEX).** No roadmap scope change;
> security/correctness only. The shared admin gate now denies by default in every environment unless
> the caller has a middleware-proven Cloudflare Access/Auth.js admin email or valid admin token. The
> former broad `NODE_ENV !== "production"` bypass is removed without a hostname-based replacement;
> the auth-unconfigured primary-email fallback never grants admin access. Current-main Node 24 gate
> is green (lint 0 errors/407 warnings, tsc, 325 files/3,616 tests, build). See
> `docs/rollouts/2026-07-11-admin-auth-fail-closed.md`.

> **2026-07-10 - Settings IA restructure: global-only Settings (CLAUDE).** No roadmap scope
> change; console IA only. `/console/settings` now carries ONLY global (user/browser/operator/
> reference/danger) settings; account-scoped config lives on Framework (`/console/strategy`):
> the Settings Models card was DELETED (Framework's pickers with reasoning-effort controls are
> the single source of truth — the "mandatory explicit Settings picks" in the 2026-07-07 note
> below are now mandatory explicit *Framework* picks), Tax treatment moved to the bottom of
> Framework (still account-scoped, THIS ACCOUNT chip), and `requireTypedConfirmation` was
> promoted to a user-level policy field so Advanced action confirmation genuinely spans all
> accounts. See `docs/rollouts/2026-07-10-settings-global-only.md`.
> **2026-07-07 - Single-adversary consolidation IMPLEMENTED (MONET).** Roadmap-relevant change to
> the Phase-7 strategy engine's adversarial review: the two adversarial LLM passes (in-flow Bear +
> escalated `debateProposal`) are consolidated into ONE post-sizing Red Team review per risk-adding
> opening, per `docs/single-adversary-consolidation.md` as amended by the owner's 2026-07-07
> revision — three-way down-only verdict (approve / approve-at-half / reject), exits structurally
> exempt, fail-closed + visible on every failure mode, and NO model defaults anywhere (both team
> models are now mandatory explicit Settings picks; the `RED_TEAM_LLM_PROVIDER` env override and
> every silent fallback are gone — supersedes older notes below that describe blank-reviewer
> inheritance). Branch `monet/single-adversary-consolidation`, supersedes draft PR #1035. See
> `docs/rollouts/2026-07-07-single-adversary-consolidation-impl.md`.
> **2026-07-09 - Red Team efficacy Results wiring (Codex).** No roadmap scope change. The
> active-account dashboard snapshot now carries `redTeamEfficacy` plus the override split from
> persisted audit history, and Results renders the scorecard with honest 20/50 sample gating for
> reviewer rows plus explicit `unattributed` history when no reviewer model was persisted. This is
> read-side only and deliberately stays out of `src/lib/red-team.ts` / `src/lib/strategy.ts`.
> See `docs/rollouts/2026-07-09-red-team-efficacy-console.md`. Production close-out:
> PR #1175 shipped with PR #1174 in Coolify deploy `krk1db6x` at `main@8bc0967f`.
> **2026-07-09 - Home evidence symbol drawer parity (Codex).** No roadmap scope
> change. The remaining console-side universal ticker drawer gap is closed by
> rendering market-scan candidate evidence cards through the existing `SymbolButton`,
> passing the current quote into the shared drawer. See
> `docs/rollouts/2026-07-09-home-evidence-symbol-drawer.md`.
> **2026-07-09 - Guardrails tooltip sweep (Codex).** No roadmap scope change.
> Guardrails Universe and Autonomy controls now carry native titles for the
> remaining bare checkbox/text/select/button controls. See
> `docs/rollouts/2026-07-09-guardrails-tooltip-sweep.md`.
> **2026-07-09 - Shared-dep proper-usage cleanup refresh (Codex).** No roadmap
> scope change. Dirty Cursor PR #1105 was refreshed onto current `origin/main`
> via `codex/refresh-shared-dep-usage` without editing Cursor's branch: event
> checks use shared `CONGRESS_EVENT_TYPES`, outbound share payload typing derives
> from shared `SharePayload`, and stale shared imports were removed. See
> `docs/rollouts/2026-07-09-shared-dep-proper-usage.md`.
> **2026-07-09 - Scoring-factor weight tooltips (MONET).** No roadmap scope
> change, display-only. Each of the 8 "Scoring-factor weights" controls on the
> Strategy console page now carries a hover tooltip explaining what the factor
> measures and which direction more weight pushes candidate ranking, plus one
> sentence clarifying the weights are relative. No scoring-math changes. See
> `docs/rollouts/2026-07-09-scoring-factor-tooltips.md`.
> **2026-07-09 - Model Stats drawer widened on desktop (MONET).** No roadmap
> scope change, display-only. The shared `Sheet` component gained an opt-in
> `wide` prop (920px desktop max-width vs. the 560px default; mobile bottom
> sheet unaffected), used only by the Model Stats drawer's 4-column table.
> No other `Sheet` call-site changed. See
> `docs/rollouts/2026-07-09-model-stats-drawer-wide.md`.

> **2026-07-06 - Learned-context copy fix + browse/delete archive (Claude).** No roadmap change.
> Reworded the awkward/overclaiming empty-state copy on the Learned Context approval queue
> (`app/console/approvals/learned-context.tsx`) and built the "browse + delete what was silently
> learned" surface the 2026-07-02 learned-context design doc promised but never shipped: a new
> `GET /api/learned-context` + `DELETE /api/learned-context/[id]`, an ownership-scoped
> `deleteLearnedContext` in `src/lib/db-learning.ts`, and a collapsed-by-default
> `LearnedFactsArchive` component on the Approvals page. See
> `docs/rollouts/2026-07-06-learned-context-archive.md`.

> **2026-07-08 - Live bulk approval typed-confirm flow (Codex).** No roadmap change.
> This closes the deliberately deferred #807 approval-triage gap: selected LIVE proposals can now
> be approved in bulk, with one aggregate typed-confirm sheet only when
> `policy.requireTypedConfirmation` is enabled. Bulk reject stays the existing inline one-click
> confirm, and every approval still uses the existing per-item endpoint so partial blocked/failed
> outcomes remain visible. See `docs/rollouts/2026-07-08-live-bulk-typed-confirm.md`.
> Production close-out: PR #1174 shipped with PR #1175 in Coolify deploy `krk1db6x`
> at `main@8bc0967f`.
> **2026-07-06 - Coolify/Hetzner hosting migration + Cursor promoted to peer agent lane
> (Claude cloud).** No roadmap scope change; infrastructure/ops only. Self-hosted Coolify
> stood up on Hetzner behind `jays.services` to offload local agent/dev-server resource
> usage; in progress toward hosting preview lanes + eventually production. Separately,
> `AGENTS.md` corrected to treat Cursor as a full peer agent lane (DeepSeek-driven) rather
> than "not a 4th agent lane." See `docs/rollouts/2026-07-06-coolify-migration.md`.

> **2026-07-05 - Console live-data build-out slice (Codex subagent, issue #471).** No roadmap
> change. This branch is delivering the smallest reliable piece of the planned CODEX live-data row:
> reuse the existing `/api/events/stream` for console push refreshes, surface stream/freshness
> state, and improve overview mark-to-market / risk utilization / open-blotter / intraday equity
> using existing components first. Merged forward to current `origin/main` and verified on the
> current tree; lightweight-charts adoption and broader live-stream fanout stay deferred until
> this slice lands cleanly.

> **2026-07-04 - Shared public dependency hardening (Codex).** No roadmap scope change. Socratic
> now consumes `congress-trading-shared` from the public HTTPS git tag instead of GitHub Packages,
> and CI/deploy setup returns to plain `npm ci`. This removes package-read token requirements for
> the shared contract dependency while preserving the cross-app pin check. Merged as PR #444 and
> deployed to production at `1e1a15bc`.

> **2026-07-04 - Console scan column customization parity (Codex subagent).** `/console/scan`
> now matches the legacy dashboard's browser-local column behavior for the current console scan
> columns: visibility toggles, reorder controls, Reset, and saved visible-column order/state.
> No roadmap scope change; this closes the documented scan-column parity gap from
> `docs/reviews/2026-07-03-console-parity-open-items.md`.
> **2026-07-04 - Approvals triage + alert center focused slice (Codex).** No roadmap scope change.
> `/console/approvals` now covers the first operational triage layer from issue #470: sort/filter,
> visible-row multi-select, bulk reject, and safe non-LIVE bulk approve through the existing
> proposal endpoints; LIVE typed-confirm remains per-item only. The console's alert history also
> graduates into a reusable alert-center surface (summary buckets + search + better notification
> labeling) backed by existing notification/activity data, shown compactly on Approvals and fully on
> `Activity -> Alert center`. Remaining scope for the larger backlog row stays separate: unified
> owner inbox across more object types, keyboard triage, and any broader console/live-data/settings
> work.
> **2026-07-04 - Coach/framework primitives slice (Codex, issue #473).** No roadmap scope change.
> This branch is a focused primitive-wiring pass: the decision-trace coach flow can now attach a
> note while optionally promoting it into a lesson or linked framework proposal, framework review
> persists explicit owner rewrite/accept/reject verb semantics plus `ownerResponse`, and the trace
> surfaces linked run metadata when the originating run exists. 2026-07-05 update: the branch is
> now merge-forwarded to `origin/main` @ `0bfa4f1e` and fully green on focused + full verification
> (`test/socratic-db`, `tsc`, quiet lint, full `npm test`, full build`). This closes a narrow part of the
> console/coaching loop without touching live-data, settings IA, tooltip, Monet risk, or Claude
> memory/RAG lanes.

> 2026-07-03 (`claude/washsale-advisory-defaults`, Claude): **Wash-sale gate defaults flipped to
> non-blocking** — owner decision: `taxSettings.washSaleHandling` default `"block"` → `"auto"`,
> `taxSettings.iraWashSaleHandling` default `"block"` → `"disregard"`. Mid-task correction: "auto"
> no longer vetoes on a deterministic edge-vs-tax-cost threshold at all (that math re-arithmetized
> the LLM's own confidence/target outputs); it always proceeds, with the priced tax cost surfaced
> as receipt telemetry + strategist-prompt context instead. `block`/`ask` remain valid opt-ins; all
> receipt/annotation/audit machinery unchanged. No roadmap scope change — a guardrail-philosophy
> correction, part of "nothing is hard except the account" (see
> `docs/rollouts/2026-07-03-guardrail-philosophy-correction.md` on branch
> `claude/correct-drawdown-decision`). Landing deferred until the holiday-date test fix merges. See
> `docs/rollouts/2026-07-03-washsale-advisory-defaults.md`.
> 2026-07-03 (`claude/console-small-fixes`, Claude): **Console small fixes (t7/t18/t22/t39)** —
> four small verified-open items, no roadmap scope change: extracted the "0."-collapse raw-while-
> focused/commit-on-blur numeric-input pattern into a reusable `RawNumInput` (applied at the
> scoring-weight, tax-rate, and market-scan-shape inputs); exported `MARKET_REGIME_LABELS` from
> `src/lib/macro.ts` as an explicit persisted contract with dedicated exact-string test coverage;
> the account-deletion scope preview now warns when pending learned-context items would be
> discarded; and a `notify.bridge.error` ops-feed formatter humanizes notification-delivery
> failures. Pushed but landing deferred until the holiday-time-dependence test fix merges. See
> `docs/rollouts/2026-07-03-console-small-fixes.md`.
> **2026-07-03 — SUPERSEDING DIRECTIVE (owner): real trading, no fake modes.** This is a real
> trading app; the owner accepts 100% risk. **`policy.paperMode` and the local "Test mode" simulator
> (`test/local`, `usesLocalSimulation`, `getPaperPortfolioProjection`) have been removed** (rules in
> `AGENTS.md`; code removal landed — see `docs/rollouts/2026-07-03-remove-paper-default-test-mode.md`
> Step 2). An account is an account — its `environment` decides paper vs live; no connected account
> means the app can't place orders (no local-sim fallback). **Any older paper/Test-default language
> below this line is STALE** and does not describe target behavior —
> do not follow it. See `docs/EFFORT-LOG.md` +
> `docs/rollouts/2026-07-03-remove-paper-default-test-mode.md`.

> **2026-07-04 - Codex console/UI swimlane.** Branch `codex/console-ui-swimlane` executes the sync-21
> console assignment without using the sovereign review branch: approval receipt provenance
> (served model/failover, red-team trigger, sizing inputs, R:R geometry, linked citations), mobile
> LIVE phrase-gate parity, Sheet focus trap, read-only `/console/decisions/[id]` trace inspector with
> coach notes/framework `ownerResponse`, high-signal ticker drawer affordances, and Strategy custom
> model select parity. No roadmap scope change; this hardens the existing Autonomy Desk/console
> parity track. Merged as PR #442 and live in production HEAD `1e1a15bc`. See
> `docs/rollouts/2026-07-04-console-ui-swimlane.md`.

> **2026-07-03 - Socratic admin/RAG/settings parity pass (Codex).** The
> branch `codex/live-thesis-portfolio-framing` is the current broad follow-up
> for owner feedback after the Socratic UI launch: Pinecone index default
> `socratic-trade`, RAG ingest brakes, admin RAG/connection-health visibility,
> user/admin LLM usage split, `/old`, Auth.js legacy-host canonicalization for
> Google/GitHub redirects, right-side ticker drawer coverage, market-thesis
> framing on Home, Coach-page reframing, provider-specific model
> reasoning/thinking controls, lock/unlock authority language, and the first
> absolute-vs-percent mode switches. The remaining parity/open-item list is now
> tracked at `docs/reviews/2026-07-03-console-parity-open-items.md`. See
> `docs/rollouts/2026-07-03-socratic-admin-rag-settings-parity.md`.

> **2026-07-03 - AI Review inheritance, model catalog, and text-box fonts (Codex).**
> Account review does not have a separate account-level model. In Strategy -> AI Review,
> leaving the reviewer model blank now inherits Red Team when configured, otherwise Green Team.
> The UI no longer uses the old account-fallback label, and `/api/strategy/tune` trims empty
> model overrides before `proposeStrategyTuning` resolves the actual team model. The console
> now defaults editable text boxes to the site font, adds browser-local Site/System/Serif/Mono
> text-box font choices under Settings -> Appearance, refreshes current Gemini/Mistral/xAI/
> DeepSeek curated model choices, and wires DeepSeek V4 Thinking Mode. See
> `docs/rollouts/2026-07-03-ai-review-model-inheritance.md`.

> **2026-07-04 - RAG Sentry visibility + Pinecone hosted-model review (Codex).**
> The active branch `codex/rag-sentry-visibility` follows PR #351 and adds Sentry incident visibility
> for RAG provider failures, missing keys, Pinecone metric checks, ingest/WU budget trips, malformed
> embeddings, retrieval degradations, and unexpected RAG catch-block failures. It also documents why
> Pinecone-hosted `llama-text-embed-v2` / `multilingual-e5-large` should be benchmarked before any
> production migration.

> **2026-07-04 - Test Account + usage-limit email alerts (Codex).**
> Branch `codex/restore-test-account-option` restores an explicit local mock paper account option
> labeled `Test Account - Local Mock Paper Account`. It is addable for simulation/learning trades but
> is never default-created or default-selected. The same branch adds a shared usage-limit alert path:
> Pinecone daily Write Unit fuse trips, RAG ingest text caps, provider rate/quota/billing failures,
> and API Usage Monitor provider budget warnings now produce `budget_alert` notifications and try
> email-capable delivery. Treat the 50k/day Pinecone WU fuse as a runaway-write guard: normal
> incremental single-trader use should not hit it; if it does, inspect deduping/chunking/cadence
> before raising the cap.

> **2026-07-04 - RAG filing ingest smoke + deterministic vector ids (Codex).**
> Branch `codex/rag-filing-ingest-smoke-fix` verified production writes/searches the new
> `socratic-trade` Pinecone index by ingesting one MSFT 10-Q. The successful state is 95 vectors,
> 95 local `document_chunks`, and accession `0001193125-26-191507` recorded in
> `ingested_accessions`. The smoke surfaced a retry-safety bug: SEC filings without deterministic
> `doc_id` values generated UUID-based vector ids, so a timed-out partial ingest could leave duplicate
> vectors on retry. SEC filing ingestion now passes `ticker:accession:docType` as `doc_id`; preserve
> that invariant before any larger RAG backfill.

> **2026-07-04 - RAG quick-wins Wave-1 lane: wire dormant stages (Claude).**
> Branch `claude/w1-rag-quickwins` (one of four Wave-1 quick-win lanes off the 2026-07-04 composite
> expert review, section C). Wired `retrieveContextDetailed`'s already-built-but-never-called
> `minRelevanceScore`/`dedupeSimilarity` into both real call sites (`strategy.ts`,
> `chat/orchestrator.ts`); added `formatChunkWithProvenance()` so `strategy.ts` prefixes each
> retrieved chunk with a `[doc_type · section · symbol · date · rel N.NN]` header before joining
> into the prompt (chunk ids were already stable/real, left unchanged); confirmed
> `VECTOR_STORECONTEXTS_DEDUP` was already default-on from an earlier commit (the source review's
> "default OFF" was stale) and widened `hashContent` from 64-bit to 128-bit; stamped
> `embed_model`/`embed_rev` on every new vector in `cleanMetadata`; raised the rerank-path
> over-fetch cap to an env-tunable 150 (`VECTOR_RERANK_OVERFETCH_K`), non-rerank paths unchanged.
> All five items are env-tunable/opt-in-consistent, no hard gates. Verify green: lint 0 errors, tsc
> clean, 2388/2388 tests, build green. See `docs/rollouts/2026-07-04-rag-quickwins-wiring.md`.

> **2026-07-03 - Console polish + RAG quota/usage safeguards (Codex).**
> Branch `codex/console-actions-evidence-live` merged as PR #351. It extended the Socratic console polish pass and
> adds RAG quota protections before fresh Pinecone keys are connected: app-recorded RAG usage is labeled
> separately from provider totals, Pinecone query rows record Read Units when available, upsert rows
> record estimated Write Units, `storeContexts` enforces a daily Pinecone WU fuse before Voyage
> embedding, and docs now capture the recommended Voyage/Pinecone stack plus the earnings-report
> ingestion/summarization design. See `docs/reviews/2026-07-03-rag-stack-options.md` and
> `docs/design/earnings-rag.md`.

> **2026-07-03 — Socratic Trade autonomy UI/runtime implementation (Codex).** The branch
> `codex/socratic-trade-autonomy-mockup` reframes the product as an Autonomy Desk:
> live thesis, delegated actions, evidence/RAG contribution, dissent, outcome learning,
> coaching, and agent-authored framework-improvement proposals. Backing persistence now
> exists for Socratic decision cases and framework proposals; the strategy loop records
> proposed/placed/blocked/refused decisions, captures RAG attribution, accepts owner
> coaching notes, indexes each strategy-recorded decision as private institutional-memory
> RAG, and applies explicit Socratic override semantics for owner preference gates while
> preserving hard broker/account/integrity/tax refusals. Public `/welcome`, `/how-it-works`,
> and the coded `/design/socratic-trade` product overview now route by default and advertise
> `socratictrade.com` in sitemap/robots metadata. See
> `docs/rollouts/2026-07-03-socratic-autonomy-ui.md`.

> **2026-07-03 — Run-state UX correction (Codex).** The console header no
> longer hides Start/Resume behind a red STOP affordance. `RunStateButton`
> renders Start when halted, Resume when close-only, and STOP only when the
> strategy is active or winding down. The control sheet now leads with
> Start/Resume in paused states, keeps STOP/Wind down red, and uses primary/green
> tones for starting flows; the legacy autonomous-execution confirm was also
> changed from danger to primary. See
> `docs/rollouts/2026-07-03-run-state-ux.md`.

> **2026-07-03 - IRA wash-sale UI correction (Codex).** The settings and
> guardrails UI now make the IRA distinction explicit: same-account IRA wash
> sales are ignored/not applicable, so Roth/traditional IRA accounts no longer
> surface the taxable-account Block / Ask / Auto selector as the relevant
> control. The only IRA wash-sale choice shown is the existing cross-account
> taxable-loss replacement-buy setting (`taxSettings.iraWashSaleHandling`):
> block by default, or explicitly ignore/disregard with the audit annotation.
> Search/glossary copy now routes "Roth wash sale ignore" language to that IRA
> control. See `docs/rollouts/2026-07-03-ira-washsale-ui.md`.

> **2026-07-03 - Console universe index exclusivity fix (Codex).** The
> `/console/guardrails` Base indices checkboxes now call the same
> `toggleIncludedIndex` helper used by the original app and API normalizer, so
> mutually-exclusive full-overlap families replace their peer immediately:
> S&P 100 <-> S&P 500 and Nasdaq 100 <-> Nasdaq Composite. See
> `docs/rollouts/2026-07-03-universe-index-exclusivity.md`.

> **2026-07-03 - Sell to Fund Buys title-case copy fix (Codex).** The
> Guardrails Sell to Fund Buys selector and legacy dashboard Key Parameters
> selector now render the field label, option labels, and save-review summary
> in app-style Title Case while preserving the stored lowercase enum values.
> See `docs/rollouts/2026-07-03-sell-to-fund-title-case.md`.

> 2026-07-02 (`claude/strategy-attribution-macro-honesty`, Claude): **Per-proposal model
> attribution + macro placeholder honesty** — proposals now persist the failover-aware served
> model (`TradeProposal.proposedByModel` + `redTeamVerdict.model`; approval card reads
> persisted-first), and the no-FRED macro fallbacks blank every FRED field to "" instead of
> DEFAULT_MACRO placeholder constants (`pruneMacro` drops blanks from the prompt; the fabricated
> inverted curve no longer distorts `determineMarketRegime`). No roadmap scope change — two
> money-path-adjacent hardening follow-ups. See
> `docs/rollouts/2026-07-02-attribution-macro-honesty.md`.
> 2026-07-02 (`claude/console-data-followups`, Claude): **Console data follow-ups** —
> four small verified-open items, no scope change: broker order mappers now carry
> limit/stop/TIF into `EquityOrder` and `/console/orders` renders them (with a
> limit-vs-scan-price gap); the snapshot's congress cap keeps the most-recently
> DISCLOSED trades; `MarketQuoteSummary` carries the five factor fields so drilldown
> factor bars work beyond topCandidates; and Turbopack `next dev` is unbroken via
> `@source not "../docs";`. See `docs/rollouts/2026-07-02-console-data-followups.md`.
> 2026-07-02 (`claude/chat-idempotency`, Claude): **Chat retry idempotency** —
> `POST /api/chat` accepts an optional per-send `clientTurnId` (<=64 chars); the
> orchestrator dedupes the user-turn append on it (but still answers), so a client
> Retry no longer duplicates the prompt in the saved transcript. `chat_turns` gains a
> nullable `client_turn_id` (migration v10); both chat clients send a UUID per message
> and `/console/assistant` reuses it on Retry (its "history will show this twice"
> probe/toast is deleted). No roadmap scope change — hardening of the existing chat
> rail. See `docs/rollouts/2026-07-02-chat-idempotency.md`.
> 2026-07-02 (`claude/console-macro`, Claude): **Console parity port, Wave 2 —
> `/console/macro`** — the macro / market-regime board destination is built (new files
> only: `app/console/macro/{page.tsx,indicators.ts,trends.tsx}`), completing one of the
> four Wave-2 routes the foundation nav scaffolded. Legacy `app/ui/macro-panel.tsx`
> parity plus: hero regime card (meaning, classifier inputs, per-regime realized
> scorecard, how-the-strategist-uses-it), per-indicator plain-language explanations
> with dynamic banded readings, honest blanking of unsourced FRED placeholders, and
> the tooltips-everywhere/row-hover UX standard. Remaining Wave-2 routes
> (`/console/scan`, `/console/orders`, `/console/assistant`) are owned by parallel
> agents. See `docs/rollouts/2026-07-02-console-macro.md`.
> 2026-07-02 (`claude/ira-washsale-disregard`, Claude): **IRA wash-sale disregard setting** —
> owner-requested: the Rev. Rul. 2008-5 IRA hard block is now the DEFAULT of per-account
> `taxSettings.iraWashSaleHandling` ("block" default / "disregard" = proceed annotated with the
> verbatim "Wash Sale (Technically, but IRA purchase unreported to IRS)" note, audited via
> `wash_sale_ira_disregarded`, rendered on the approvals card + Activity). block->disregard is
> LOOSER (typed word on LIVE). Extends the tax-guardrail track; taxable-buyer machinery
> untouched. See `docs/rollouts/2026-07-02-ira-washsale-disregard.md`.
> 2026-07-02 (`claude/console-scan`, Claude): **Console parity-port Wave 2 — Scan
> destination** — `/console/scan` now exists (the Wave-1 nav link is live): a sortable
> Market Scan table over the latest scan's candidates with tooltips + per-field
> provenance from `EnrichmentSources`, the P/E `n/a`-vs-`—` convention, a sticky symbol
> column for mobile, an honest freshness model (newest of page-refreshed `GET /api/scan`
> vs the last strategy run's captured scan), and a Smart Money tab (congress + insider
> feeds with source metadata). New files only, all under `app/console/scan/`. No roadmap
> scope change — one of the four Wave-2 destinations delivered (macro/orders/assistant
> owned by parallel agents). See `docs/rollouts/2026-07-02-console-scan.md`.
> 2026-07-02 (`claude/console-assistant`, Claude): **/console Assistant destination** —
> ported the legacy AI Assistant chat into the console as `/console/assistant`
> (new files only under `app/console/assistant/`; parallel console-port lane).
> Chat + persisted transcript, grouped model picker with per-provider key gating,
> and an improved draft→approval handoff: drafts auto-run the policy dry-run
> preview and stage into the existing Approvals rail instead of an in-chat
> approve/reject. No roadmap scope change — part of the console feature-parity
> track. See `docs/rollouts/2026-07-02-console-assistant.md`.
> 2026-07-02 (`claude/washsale-modes-escalation`, Claude): **Wash-sale handling modes +
> Decide-mode escalation** — owner-locked spec. Account-scoped
> `taxSettings.washSaleHandling` (block default / ask = priced pending-approval card in
> both authorities / auto = deterministic edge >= 3x tax-cost guard, logged, never
> silent); IRA-replacement rebuys hard-blocked in every mode (Rev. Rul. 2008-5); narrow
> escalation framework routing ask-mode wash sales + time-context gate failures
> (daily/hourly notional, order cap, quote staleness; Decide only) to pending cards that
> RE-RUN the full gate at approval via a server-stored override token (wash-sale gate
> only — no client-settable bypass). Guardrails Tax rules select (LOOSER classification
> on block->ask/auto). No roadmap scope change — extends the tax-guardrail track. See
> `docs/rollouts/2026-07-02-washsale-modes-escalation.md`.
> 2026-07-02 (`claude/console-drilldown-plus`, Claude): **Console symbol drilldown,
> Wave 2** — the console company drawer is now a strict superset of the legacy
> `app/ui/symbol-drilldown.tsx` drawer: full parity (11 derived-metric tiles reusing
> `src/lib/derived-metrics`, 7-factor breakdown, legacy-threshold signal summary,
> evidence/headlines, per-field provenance) PLUS account exposure (position P&L,
> pending proposals → Approvals, recent orders), analyst rating distribution +
> price-target range bar, signal/earnings-proximity chips, and a collapsible deep-
> fundamentals table — tooltips on everything, light+dark, honest empty states, and
> unchanged `SymbolButton`/`SymbolDrilldownSheet` APIs for the parallel Wave-2 agents
> (extended with one OPTIONAL `quote?: MarketQuote` override so screens rendering
> freshly fetched /api/scan rows — the Scan lane, per the Codex finding on #327 — can
> make the drilldown match the row instead of the snapshot's last run).
> No roadmap scope change — a Wave-2 deliverable of the Console parity-port track.
> See `docs/rollouts/2026-07-02-console-drilldown-plus.md`.
> 2026-07-02 (`claude/console-learned-context`, Claude): **Learned-context approval
> inbox ported to /console** — the legacy "Pending Learned Changes" queue now lives on
> `/console/approvals` as a Learned context section (own data source; approve/reject
> with optimistic UI, confirm sheet showing the exact AI-LEARNED block with the honest
> approval-date stamp, full provenance + tooltips + row hover per the owner's new UX
> standard). Console feature-parity track only — no roadmap scope change. Follow-ups:
> sharing prefs in Settings, nav/needs-attention count. See
> `docs/rollouts/2026-07-02-console-learned-context.md`.
> 2026-07-02 (`claude/console-parity-tail`, Claude): **Console parity tail** — the
> closing lane of the parallel legacy→console port: Run-once blocked-reason routing
> (why + one-click route to the fix), chrome sign-out with signed-in identity,
> allocation bars on Home (position/sector lenses), a new `/console/watchlist`
> destination with price alerts (existing /api/watchlist + /api/alerts), the blocking
> shared-data-pool consent gate ported un-weakened into the console shell, a Data
> sharing settings card (pool consent + learned-context include/contribute flags),
> a DANGER account-deletion flow mirroring the server's gates, admin-only OPERATOR
> links in Settings, and pending learned-context items folded into the single red
> Approvals badge. Owner-skipped: ⌘K palette, Strategy Flow visualizer. Console track
> only — no roadmap scope change. See `docs/rollouts/2026-07-02-console-parity-tail.md`.
> 2026-07-02 (`claude/console-orders`, Claude): **Console Wave 2 — Orders destination**
> — `/console/orders` implemented (one of the parallel Wave-2 lanes on the #321
> foundation): open working orders for the active account with stale-limit detection
> mirroring the server's `listStaleLimitOrders` rule, a replace-at-market flow against
> `POST /api/orders/replace-market` (LIVE typed-confirmation ritual preserved), a NEW
> cancel flow over the pre-existing `POST /api/orders/cancel` (legacy had no cancel UI),
> and a finished-orders history table. New files confined to `app/console/orders/**`.
> Deferred: surfacing `limitPrice`/`timeInForce` on `EquityOrder` (src/lib owner) so the
> limit-vs-market gap can be shown. See `docs/rollouts/2026-07-02-console-orders.md`.
> 2026-07-02 (`claude/console-settings-expansions`, Claude): **/console/settings
> expansions** — the settings lane of the parallel legacy→console port. Adds broker
> connect/manage (Robinhood OAuth + Alpaca key-pair, disconnect with explicit confirm),
> API-key CRUD (/api/keys; write-only, source-attributed), LLM model pickers
> (llmModel/redTeamLlmModel via native grouped selects, provider availability from
> /api/chat/providers, saved through PUT /api/policy), full delivery-channels editor
> (/api/notifications port), and a searchable help/glossary — all as new
> `app/console/settings/*` modules; plus the owner's cross-cutting UX standard
> (hover tooltips on virtually everything, row hover highlights). Console track only —
> no roadmap scope change. See `docs/rollouts/2026-07-02-console-settings-expansions.md`.
> 2026-07-02 (`claude/console-port-foundation`, Claude): **Console parity-port
> foundation (Wave 1)** — the legacy-dashboard feature parity port into `/console` is
> now an explicit multi-agent track: Wave 1 (this branch) ships the shared primitives
> (`app/console/ui/ticker-logo.tsx`, `provider-logo.tsx` (+`ModelBadge`),
> `symbol-drilldown.tsx`, `app/console/lib/models.ts`), nav scaffolding for four
> upcoming routes (`/console/scan`, `/console/macro`, `/console/orders`,
> `/console/assistant` — pages land in Wave 2 via parallel agents), the owner-requested
> model-attribution approval-card redesign (green-team proposer block with the vendor
> logo + LARGE confidence number; red-team reviewer block), positions logos+drilldown,
> and a console-wide tooltips-everywhere + row-hover UX standard in `console.css`.
> Fast-follow on the roadmap: persist `proposedByModel` per proposal (needs the
> src/lib/strategy.ts owner). See `docs/rollouts/2026-07-02-console-port-foundation.md`.
> 2026-07-02 (`claude/console-qa-fixes`, Claude): **12 owner QA fixes on /console** —
> policy saves no longer rejected by a stale stored gpt-5.5/high config; SPY benchmark
> is deposit/withdrawal-aware (inferred flows + time-weighted return, honestly labeled);
> Results shows the selected account's bucket with an explicit compare toggle; new
> account-scoped `taxSettings.washSaleMinLossUsd` lockout floor; danger red reserved for
> reality/STOP/destructive confirms (LIVE word chip on primaries); unsaved-changes
> guards; Activity run-event consolidation + account scoping + humanized ops events in a
> System bucket; AI strategy review panel ported to the console. No roadmap scope
> change — a QA/hardening pass on the Console track. See
> `docs/rollouts/2026-07-02-console-qa-fixes.md`.
> 2026-07-02 (`claude/console-ground-up-ui`): **Ground-up "Console" UI** — a complete,
> parallel greenfield interface at `/console` (new `app/console/` route group, new files
> only; the legacy dashboard is untouched and remains the default UI). Synthesized from
> three blind design studies (novice/operator/explainability-first — see
> `app/console/README.md`); wired to the real dashboard snapshot + mutation endpoints;
> light+dark theming required and implemented. This adds a candidate replacement UI
> track without changing any existing phase's scope. See
> `docs/rollouts/2026-07-02-console-ground-up-ui.md`.
> 2026-07-02 (`claude/sentry-monitoring`, Claude): **Sentry monitoring completed** —
> added the env-gated Sentry Crons scheduler heartbeat (`scheduler-tick` monitor,
> `SENTRY_DSN` + `SENTRY_CRONS_ENABLED=1`, try/catch-wrapped, after the single-leader
> gate) closing the dead-scheduler-but-health-200 gap, plus `test/sentry-inert.test.ts`
> pinning the whole integration as a no-op with zero Sentry env. Inert until the owner
> creates the Sentry project + sets env vars. No roadmap change; see
> `docs/rollouts/2026-07-02-sentry-monitoring.md`.

> 2026-07-01 (`chat-a-llm-money-path`): Audit Chat A — LLM & prompting (money-path),
> all 8 items. Hardened the autonomous strategy path: inline Bear red-team now fails
> CLOSED (un-critiqued Bull proposals route to human in decide mode, not auto-executed);
> Bull/Bear prompts extracted to a versioned `strategy-prompts.ts` + deterministic
> offline eval (`npm run eval:strategy-offline`) + `trade_proposals.prompt_version`
> stamp; Anthropic prompt caching; default-off ordered cross-provider failover
> (`policy.llmFallbackModels`); truncation-aware Bull cap; strict red-team `json_schema`;
> default-off rationale-collapse gate; removed a dead Anthropic endpoint branch. All but
> the fail-closed safety fix are default-off flags. Verified tsc/lint/test(1692)/build +
> eval green. See `docs/rollouts/2026-07-01-strategy-llm-money-path.md`.

> 2026-07-01 (`claude/wonderful-bell-32958a`): **Design spec — single-adversary ("Red Team")
> consolidation.** `docs/single-adversary-consolidation.md` proposes collapsing today's two
> adversarial LLM passes (in-flow Bear + standalone `debateProposal`) into one hardened Red
> Team: reviews the finalized trade, fails closed + visible when unavailable, never blocks a
> risk-reducing exit, provably independent of the proposer. Design-only (not implemented);
> decisions O1–O4 resolved (spec §9); Codex review refinements folded in as §12 R1–R20. Owning
> phase doc: `docs/phase-7-strategy.md` §F. See
> `docs/rollouts/2026-07-01-single-adversary-consolidation-spec.md`.

> 2026-07-01 (`claude/audit-work-split-f-g-o67jj2`): **Follow-up Codex review on the durable budget** —
> three findings were **fixed in code with tests** (not deferred): (a) an EXPLICIT per-user policy budget
> of `0` now opts OUT of an operator env default (`0` = no limit, not "block everything") — `resolveLimit`
> only inherits the env default on `undefined`/blank; (b) RAG (Voyage/Pinecone) spend from the
> `rag_usage` ledger now counts toward the same ceiling as `llm_usage`, so RAG-only spend can trip the
> cap (previously it could not); (c) the retrieval RAG meters (`meterEmbed`/`meterPineconeQuery`/
> `meterRerank` in `retrieveContextDetailed`) now book under the requesting `userId` instead of defaulting
> to `"local"` — otherwise a non-`local` user's retrieval spend was never counted against *their* ceiling,
> silently defeating (b) for the multi-user case. Covered by `test/llm-budget-enforcement.test.ts` and
> `test/rag-metering.test.ts`. A later pass added three more **fixed-in-code** items: (d) over-budget
> `generateReflectionSummary` no longer skips the non-LLM excursion enrichment (budget suppresses only
> the LLM reflection now); (e) a run that crosses the budget mid-run (revalidation/RAG spend) re-reads
> the budget before `proposeTrades` and gracefully skips instead of surfacing as a FAILED run; (f)
> `embedQueryCached` only caches VALID embeddings, so a transient malformed Voyage response no longer
> poisons the query LRU. Covered by `test/post-mortem.test.ts` and `test/query-embedding-cache.test.ts`.
>
> **Future considerations (deferred, not blocking PR #293)** — the durable per-user LLM budget now
> enforces at the spend primitives and is user-editable in Settings; known limitations left for a
> follow-up:
> 1. ~~**Concurrent-run budget reservation.**~~ **DONE (2026-07-01).** A per-USER LLM budget
>    **reservation** now closes this: `reserveLlmBudget`/`reserveLlmRunBudget`/`releaseLlmReservation` in
>    `src/lib/llm-budget.ts`, CAS'd in the `settings` KV row like `acquireStrategyLock` (no migration,
>    5-min TTL, fail-closed → skip LLM, default-OFF). `runStrategyOnce` reserves its worst-case estimate
>    at the budget gate and releases in the `finally`, so a concurrent same-user run sees the hold and
>    skips LLM instead of both overshooting. See `docs/rollouts/2026-07-01-llm-budget-reservation-toctou.md`.
> 2. ~~**Chat-path spend coverage.**~~ **DONE.** `/api/chat` calls `isOverLlmBudget(userId)` and
>    returns 429 when a cap is set and the day is spent (or the ledger cannot be read).
> 3. **Multi-account budget target.** The ceiling is keyed by `userId`, so it is a per-*user* daily cap
>    that spans all of that user's accounts, not a per-*account* cap. If a user runs several accounts and
>    the intent is an independent budget per account, the gate would need to key on the account id (and
>    the ledger read filter + the Settings UI would need a per-account budget field). Today it is
>    deliberately per-user so one runaway account can't drain a shared daily allowance unnoticed.
> 4. **(Earlier-noted) `strategy.ts` god-module split** (~3k lines) remains a separate large refactor.
> See `docs/rollouts/2026-07-01-llm-budget-durable-enforcement.md` and
> `docs/rollouts/2026-07-01-fg-codex-review-fixes.md`.
> 2026-07-01 (`claude/audit-work-split-f-g-o67jj2`): audit workstreams **F**
> (UX/IA/aesthetics) and **G** (security/risk/testing/ops) implemented together via
> 4 parallel agents on disjoint files. F: first-class `redTeamVerdict` + "Bear
> Review" block, Bear-veto audit, visible ⌘K, Macro/Tax tab overflow, tap-to-expand
> rationale, EmptyState/skeleton + elevation/blur/icon token scales, `docs/design/
> visual-system.md`, phase-8 IA fix. G: chat/scan rate limits, OAuth-token at-rest
> encryption, constant-time admin compare + CSP/security headers (default-off),
> drawdown/correlation-gate verification, an e2e money-path test + default-safe
> live-order pre-flight guard, a default-off per-user/day token-budget ceiling +
> query-embedding LRU, an **account-deletion coverage fix** (4 user-scoped tables
> were escaping deletion), and Langfuse prompt-version/veto stamping. All new
> behavior is default-off; paper/Test mode unchanged. Deferred (noted): the
> `strategy.ts` god-module split and interval-scheduler budget wiring. Verify quartet
> green locally (1720 tests); see `docs/rollouts/2026-07-01-{ux-ia-aesthetics,
> security-hardening,strategy-money-path-f-g,cost-ops-controls}.md`.
> 2026-07-01 (`claude/trading-audit-d-e-dpw0h7`, follow-on): closed issue #306's
> non-mechanical follow-ups from Chats D+E. **Scope correction:** the "FMP as a second
> short-interest source with a ≥5pp disagreement bulletin" item below was removed as
> non-deliverable — FMP publishes no short-interest data (no `/short_interest` endpoint;
> verified against FMP's API docs + official MCP surface). Yahoo `shortPercentOfFloat` is the
> single real source; a real second source would need Massive/Finnhub. **UPDATE 2026-07-01 (PR
> #309): the real second source is now DELIVERED via Massive REST** — `MassiveEnrichmentProvider`
> computes short % of float from Massive's FINRA short interest / free float and emits the ≥5pp
> disagreement bulletin, gated on `MASSIVE_API_KEY` (default-inert without it). See
> `docs/rollouts/2026-07-01-massive-short-interest-second-source.md`. Also: scoped the
> default-off enrichment circuit breaker to trip per **credential lane** (a dead env lane no
> longer disables a healthy user lane), and locked in `extractUnderlyingPrice`'s
> `{ quotes: [...] }` envelope parsing with a regression test. See
> `docs/rollouts/2026-07-01-followon-fmp-breaker-quotes.md`.
> 2026-07-01 (`claude/trading-audit-d-e-dpw0h7`): audit work-split Chats D+E
> (data-source breadth + request-path/bundle performance), two parallel agents +
> orchestrator integration. **D (data sources):** `daysToEarnings` and
> `institutionOwnershipPct` from the existing Yahoo `quoteSummary` call (zero added
> cost); synthetic Yahoo bid/ask now provenance-tagged `yahoo-finance-synthetic` so
> `hasAskData`/marketable-limit math no longer treats it as a real quoted ask
> (correctness fix); a default-off Robinhood options/IV enrichment tier
> (`RobinhoodOptionsEnrichmentProvider`); a default-off active per-provider circuit
> breaker; FMP as a second short-interest source with a ≥5pp disagreement bulletin;
> and a default-off Finnhub `stock/recommendation`-drop lever (5→4 calls/symbol).
> **E (performance):** collapse ~9 redundant `listFillEvents` replays to one live +
> one paper per dashboard request; batch proposal lookups (`getProposalsByIds`); cap
> the unified feed at 60; `next/dynamic` code-split of `StrategyFlow`/`SymbolDrilldown`
> (verified `@xyflow/react` out of the dashboard first-load JS); sqlite
> `cache_size`/`mmap_size` pragmas; Playwright-CI `.next/cache` restore. All new
> behavior behind default-off env flags; E is a pure refactor (identical outputs). The
> monolithic-snapshot re-render refactor is tracked as a deferred follow-up. No roadmap
> change; see `docs/rollouts/2026-07-01-data-sources-breadth.md` and
> `docs/rollouts/2026-07-01-performance-efficiency.md`.
> 2026-07-01 (`claude/affectionate-franklin-a52935`): Alpaca account-editor
> "Custom Endpoint" checkbox fix - a live Alpaca account (`environment: "live"`)
> ended up with `base_url` stuck on Alpaca's paper endpoint, causing a
> production 401 on the readiness check. Root cause: checking "Use a Custom
> Alpaca Endpoint" in `dashboard-client.tsx`'s account editor copied the
> current (possibly-stale-default) `baseUrl` into the custom field with
> nothing typed, and also disabled the auto-derivation that keeps `baseUrl` in
> sync with the inferred paper/live environment as the account
> number/API key are filled in. Fixed to start the custom field empty on
> check. No roadmap change; see
> `docs/rollouts/2026-07-01-alpaca-custom-endpoint-checkbox-fix.md`.
> 2026-07-01 (`agent/claude-backlog-b-learning-b`): **Learning-loop BROADER BACKLOG (P1 + P2).**
> Backend/API/tests-only pass on `docs/reviews/2026-07-01-learning-loop-expansion.md`, building ON
> #300's ledger / tuning-invariants / `pairedICDiffStats` (no duplication). P1: (P1-1) read-only
> `dryRunAutonomousWeightTuning` + shared side-effect-free evaluator + `GET /api/admin/tuning-dry-run`;
> (P1-2) opt-in purged-&-embargoed walk-forward split (`policy.tuning.oosPurgeEmbargo`, default-off
> byte-identical); (P1-3) shadow / forward-A-B ledger (`shadowWeightLedger`) reusing #300's
> `learning_mutations` with a distinct `auto_weight_shadow` trigger; (P1-4) HARD look-ahead unit test
> (`isPointInTimeForwardExit`) + SOFT survivorship proxy (`certifyForwardResolution`). P2: (P2-1/2)
> missed-opportunity HIT-RATE over winners+losers, shrunk to base rate, benchmark-parity both legs
> (`missedOpportunityRequireHitRate`); (P2-3) signed top-bucket congress gate
> (`congressRequireTopBucketPositive`); (P2-4) IC-weight shrinkage λ (`icWeightShrinkage`); (P2-5)
> drawdown guard (`autoApplyDrawdownGuard`, candidate/baseline OOS drawdown curves); (P2-6) OOS
> starvation floor (`minOosTestDates`); (P2-7) `tuning_apply_provenance` audit per apply; (P2-8)
> `refreshCongressScoreVerdict` cadence refresher + fixtured test. Also the composed paired-t gate E2E
> #300 deferred. D-1 (multiplicity) deferred with docs; P1-5 verified already-shipped in #296 (skip);
> admin ledger UI skipped (redesign thread owns UI). Every knob default off/no-op with a per-flag
> byte-identical proof; red-team/inline-Bear + `app/` UI untouched. Verify quartet green (tsc / lint
> 0-err / 195 files 1977 tests / build). See `docs/rollouts/2026-07-01-learning-loop-backlog.md` +
> `docs/phase-7-strategy.md` §3.E.8–E.15.
>
> 2026-07-01 (`claude/settings-navigation-redesign-a3k1yv`): **settings & navigation IA
> redesign proposal** (docs-only, no code). Large-team workflow (`wf_000ecc50-7eb`, 48
> agents) using the owner-requested two-track method (one informed team + two blind
> greenfield teams that never saw the current UI + one pattern-led team → adjudication →
> red-team → artifacts). Canonical target: account = primary object; 7+4 tabs collapse to
> 6 verb destinations + off-rail Settings + Assistant overlay; Strategy consolidates to one
> editable home; money-reality vs authority split into two dials; settings split by scope
> first; copy-on-bind presets; server-side write-time scope validation. Deliverable
> `docs/settings-navigation-redesign.md` (+ appendix corpus). Complements — does not replace
> — the settings-and-universe-overhaul field-completeness program. No roadmap phase changed.
> **Owner approved the design + answered all 7 open questions (later 2026-07-01); a second workflow
> (`wf_598c6d71-77d`, 16 agents) built the full implementation-ready spec under
> `docs/settings-navigation-redesign/spec/`** (11 sections + grounding + reconciliation; start at
> `spec/00-README.md`). Still docs-only. Next: clickable prototype, then delivery-plan PR #1 (relabels +
> scope-surfacing). See `docs/rollouts/2026-07-01-settings-navigation-redesign.md`.
> **PR #1 landed (2026-07-01, `claude/settings-navigation-redesign-a3k1yv-mce45j`):** first app code —
> vocabulary relabels (`Stop`→`STOP` w/ never-sells tooltip, handler unchanged; `Notifications`→`Alert
> history`/`Alert delivery`; `Display`→`Appearance`; `Data`→`Data & Privacy`) + settings-header
> `THIS ACCOUNT`/`ALL ACCOUNTS` scope tags. No flag, no data path. New `app/settings-scope.ts` (shared
> scope-tag SSOT) + `test/scope-tag-render.test.ts`. tsc/lint/test/build green. Next: PR #2 (`DestinationTab`
> mapping + localStorage shim behind `NAV_V2`). See `docs/rollouts/2026-07-01-nav-v2-pr1-relabels-scope-surfacing.md`.
> **PRs #2–#6 landed (2026-07-01, PR #305, same branch restarted from main):** DestinationTab mapping +
> localStorage shim (`app/nav-destinations.ts`); settings field catalog + search index + Essentials + scope
> (`app/settings-search.ts`); Settings Glossary old→new table + relocation map; `/strategy`→`/how-it-works`
> gated redirect; TuningCard de-dup behind `STRATEGY_CONSOLIDATION`. All behind `NAV_V2`/sub-flags or safe
> structural changes — flags off ⇒ prod byte-identical. The physical settings/Strategy modal teardown is
> staged to the shell (PR #9). Stopped before PR #7 (real-money execution gate) pending go-ahead.
> tsc/lint/test(2020)/build green. See `docs/rollouts/2026-07-01-nav-v2-pr2-6-batch.md`.
> **PR #7 built (2026-07-01, own PR after #305): the ⛔ real-money gate — view/execution decouple.** Subagent
> map found most of it already existed (autonomy-reset-on-boot, per-account scheduler fan-out, view-only
> pointer incl. mobile, copy-preset preserves state, API auth ignores body). Remaining coupling closed in
> `db-profiles.ts`: fail-closed fresh-seed (no auto-arm, view-pointer independent), ambient mirror made
> config-only (`copyPolicyConfigToActiveAccount` preserves run-state), explicit
> `assertConnectedAccountOwnedByUser` write guard. Not flag-gated; real-money — preview-QA before merge.
> tsc/lint/test(2032)/build green. See `docs/rollouts/2026-07-01-nav-v2-pr7-execution-gate.md`.
> **PR #8 built (2026-07-01, stacked on #7 in PR #310): wash-sale provenance + Test-account filter.**
> `tax.ts` adds per-symbol provenance (`WashSaleLock {account, clearDate}`) and excludes Test/sim accounts
> from contribution (a simulated loss can no longer lock a real taxable account). Chose the parallel-accessor
> option: Set-returning helpers are projections of the provenance map, so the authoritative enforcement gate
> (`policy.ts` `.has`) stays byte-identical. Tests: washsale-test-account-excluded, washsale-provenance;
> chat-draft updated. Real-money tax safety. tsc/lint/test(2090)/build green. See
> `docs/rollouts/2026-07-01-nav-v2-pr8-washsale-provenance.md`.
> 2026-07-01 (`agent/claude-followon-b-learning`): **Learning-loop follow-on guardrails.**
> Focused pass on `docs/reviews/2026-07-01-learning-loop-expansion.md` on top of Workstream B
> (#296): (P0-4) a UNIFIED append-only learning-mutation ledger (`learning_mutations` table +
> `db-learning-ledger.ts` CRUD + `learning-ledger.ts` record/revert) that GENERALIZES #296's
> tuning-specific audited revert into one ledger + one `requireAdmin` revert route
> (`/api/admin/learning-ledger`); (P0-2) effect-size + PAIRED-t significance on the autonomous
> OOS gate (pure `pairedICDiffStats` on the shared-fold per-date IC-difference series;
> `policy.tuning.minOosICImprovement` + `minOosPairedTStat`, both default no-op); (P0-3) a
> FAIL-CLOSED tuning-config invariant guard (`tuning-invariants.ts`) that skips (never throws)
> the autonomous apply on a bad config and warns (never blocks) the manual tune route. Ledger
> RECORDING is passive/always-on (audit trail only); every behavior-changing knob defaults
> off/no-op. Red-team/inline-Bear untouched. Verify quartet green (tsc / lint 0-err / 1793
> tests / build). See `docs/rollouts/2026-07-01-learning-loop-followon.md` +
> `docs/phase-7-strategy.md` §3.E.5–E.7.
>
> 2026-07-01 (`claude/competent-elion-c82938`): Workstream C2 — API Usage Monitor
> integration. Wired App B's usage ledgers (`recordLlmUsage`/`recordRagUsage`) +
> market-data/broker call paths to push real usage/cost to `usage.jays.services`
> via a new fire-and-forget forwarder (the shared push client had zero callers —
> audit §6.9 / top-10 #9); added the audit's cost-aware feedback loop (monitor
> `GET /api/budget-status` + App B budget client: alerts by default, model-downgrade/
> cycle-skip behind default-off `USAGE_BUDGET_ENFORCE`). All default-off,
> fire-and-forget, fail-open — App B runs standalone without the monitor. Hand-rolled
> the push (App B's pinned shared pkg 1.0.0 lacks the `usageTelemetry` export; publish
> + pin-bump deferred). No roadmap-phase change. See
> `docs/usage-monitor-integration.md` +
> `docs/rollouts/2026-07-01-usage-monitor-integration.md`.

> 2026-07-01 (`agent/claude-backlog-c-rag`): RAG expansion backlog, broader pass - implemented
> all remaining P1/P2 items from `docs/reviews/2026-07-01-rag-knowledge-expansion.md`: **R5**
> consolidated per-retrieval telemetry (`recordRetrievalQuality()`, hashed query, default off);
> **R6** shared `envFlagOn` parser (fixes `RAG_EMBED_DISCLOSURES` to accept `true/1/yes`); **R7**
> index-metric assertion at bootstrap (warn+audit only, never throws); **R9** query-embedding LRU
> (vector-only, never Pinecone results, default off); **R10** `content_hash` dedup for
> `storeContexts` (opt-in `dedupKeyPrefix`, wired into 8-K summary + disclosure ingesters);
> **R11** faithfulness/citation-grounding eval (`scripts/eval/faithfulness.ts`, deterministic +
> optional off-by-default LLM judge); **R12** centralized default cosine floor
> (`applyDefaultFloors`); **R13** provenance-complete citations (additive `doc_type`/`section`) +
> optional advisory `isStale` label, backend/payload only; **R14** near-duplicate suppression
> (Jaccard-shingle, opt-in); **R15** offline corpus coverage & freshness report
> (`scripts/eval/corpus-coverage.ts`); **R16** per-run RAG budget ceiling (degrades rerank/hybrid
> only, never core recall); **R17** fixed train/serve text skew (`VECTOR_EMBED_CLEAN_TEXT`,
> embeds clean text, stored/cited text unchanged). R3/R8 already shipped (#297/#299), verified not
> re-implemented. Every item default-off/opt-in, proven byte-identical when unset. Read/
> retrieval-only, no UI touched. See `docs/rollouts/2026-07-01-rag-backlog.md`.
> 2026-07-01 (`agent/claude-followon-c-rag`): RAG follow-on, focused pass on the two items
> Workstream C's own rollout note deferred - **R4** (retrieval regression net: a pure
> `rankPool` helper extracted from `retrieveContextDetailed`'s post-recall pipeline, exercised
> by 19 network-free tests pinning the as-of/rerank/hybrid fail-safes) and **R1 part 2**
> (`VECTOR_ASOF_STRICT`, default off - drops undated chunks under an active `asOf` instead of
> the lenient default, with a drop-count audit; golden as-of tuple proven end-to-end). Both
> byte-identical to current behavior unless explicitly opted in. See
> `docs/rollouts/2026-07-01-rag-followon.md`.
> 2026-07-01 (`agent/claude-workstream-c-rag-v2`): RAG/embedding Workstream C - closed the 3
> highest-leverage gaps the 2026-06-30 audit found in the RAG pipeline (no retrieval-quality
> eval, reranker discarding its own relevance score, char-cap/doc_type/salience hygiene
> issues): a new recall@k/MRR eval harness (28-case golden fixture, no live network calls)
> gates future retrieval-pipeline changes; rerank relevance scores are now captured +
> surfaced with an opt-in post-rerank floor; char-cap alignment + write-time doc_type
> lowercasing landed; the salience extractor's first-match-only ticker-binding bug was fixed
> and a default-off structured-output LLM extractor with real ticker validation was added.
> Hybrid BM25/RRF was evaluated (measured delta table) and stays off by default - reranking
> alone already reaches the eval ceiling on the golden fixture. All behavior changes are
> default-off/opt-in; no order/execution-path code touched. A parallel 16-agent expert
> design review (`docs/reviews/2026-07-01-rag-knowledge-expansion.md`) landed corrections
> mid-implementation, folded in per the rollout note. See
> `docs/rollouts/2026-07-01-rag-eval-and-rerank.md` for full item-by-item status and explicit
> follow-ups (R1 strict as-of mode, R3/R4/R5/R6/R7/R9/R10/R11, R12-R17 P2 backlog).
> 2026-07-01 (`agent/claude-workstream-b-learning-v2`): **Workstream B — learning
> loop / auto-tuning.** Wired the audit's "built-but-unwired" learning loops into the
> money path behind default-off `policy.tuning.*` flags, with the 16-expert-panel
> corrections folded in (B1–B8): opt-in autonomous factor-weight apply (stricter OOS
> gate + write-scope safety + scheduler-hosted cadence + audited revert); congress
> go/no-go gating with a three-way verdict (no data-poverty kill-switch); missed-
> opportunity per-factor scan nudge; ≥5 + SPY-relative recurringFactor; factor
> attribution stamped at entry (no momentum default); confidence-calibration→sizing
> (isotonic, reduce-only); per-regime IC report (application off — samples too thin);
> and a REAL fix — paper/test protective EXITS now pay execution cost. Verify quartet
> green (tsc/lint/1710 tests/build). See
> `docs/rollouts/2026-07-01-learning-loop-autotuning.md` + `docs/phase-7-strategy.md` §3.E.
>
> 2026-07-01 (`claude/affectionate-franklin-a52935`): broker capability fan-out -
> 4 parallel Opus agents (Workflow tool, isolated worktrees) implemented
> independent items from `docs/broker-capability-plan.md`'s cheap/high-value
> list: broker-gateway health logging (`alpaca-broker`/`robinhood-broker`
> services), Alpaca portfolio-history/calendar/clock/account-activities
> (`alpaca-account-insights.ts`), a Robinhood-realized-P&L cross-check
> (`robinhood-pnl-crosscheck.ts`), and 3 new read-only chat-assistant tools
> (earnings calendar, option chain, instrument search) backed by Robinhood MCP
> data. Merged all 4 branches with zero conflicts, merged current
> `origin/main` through the mobile API/PWA work, addressed review fixes, and
> re-verified as one change (172 files / 1671 tests). Robinhood options-trading support and
> eToro/Public.com/IBKR integration deliberately excluded — real feature work
> and Codex-coordination-sensitive, respectively, not "cheap." No roadmap
> change; see `docs/rollouts/2026-07-01-broker-capability-fanout.md`.
> 2026-07-01 (`claude/elastic-rosalind-a2a48a`): Workstream C1 — Congress.Trade
> integration repair (App B side). Adopted App A's subscription-model SSE
> (`/api/stream?subscription=` — the old consumer never connected), made the
> inbound import receiver explicitly acknowledge non-persisted datasets (the
> "drops 4 of 7" is correct-by-design, not a bug), exact-pinned the shared pkg to
> 1.0.0 with a real peer-divergence CI check, applied the shared `resolveTickerAlias`
> on outbound rows, and made outbound payload validation drop-invalid-rows. App A
> exact-pin + local-alias-retirement ship in a separate Congress.Trade PR. No
> shared-pkg source/publish change needed. See
> `docs/rollouts/2026-07-01-congress-integration-repair.md`.
> 2026-07-01 (`docs/improvement-audit-2026-06-30`): comprehensive audit
> re-baseline - historical auth IDOR is no longer the active P0; near-term
> priorities shift to money-path correctness (Bear red-team fail-closed,
> synthetic quote avoidance, end-to-end proposal execution tests), built-but-
> unwired learning guardrails (factor tuning, congress go/no-go, rationale
> collapse), RAG evaluation/corpus depth, usage-telemetry push integration, and
> dashboard decomposition. See `docs/reviews/2026-06-30-improvement-audit.md`.
> 2026-07-01 (`agent/claude-congress-webhook-parity` / PR #283, [codex-autofix]):
> Congress bare-tx ingest fix - the "envelope itself is one trade" last-resort
> branch in `applyCongressEvent` was pushing the whole envelope into
> `coerceCongressTrade`, so a bare App A transaction over SSE (whose `type` was
> stamped with the SSE event name by `applySseMessage`) had its trade side
> shadowed and was dropped as `no-trades`. Now strips envelope keys
> (`type`/`event`/`id`/`data`) before coercing, with a regression test. No
> roadmap change; see `docs/rollouts/2026-06-30-congress-webhook-sse-parity.md`.

> 2026-07-01 (`claude/stock-data-pricing-comparison-2wzg8u`): market-data
> freshness decision + plan (docs-only). Recorded that the engine is
> broker/strategy-neutral and already runs "delayed bulk + real-time hot-set on
> demand"; real-time only matters at the 60s exit layer and the order-submission
> instant. New deferred workstream: enable/tune the already-built but default-OFF
> gates (`maxQuoteAgeSec`, `maxEntryDriftPct`, `marketableLimitEntries`), add a
> hot-set quote-source router (broker → FMP real-time → stamped-stale DB
> fallback), and an optional poll→push trailing-stop stream. No new data feed
> required. See `docs/market-data-freshness-decision.md` +
> `docs/market-data-freshness-implementation-plan.md`.

> 2026-06-30 (`claude/affectionate-franklin-a52935`): broker reliability +
> capability audit - broker-agnostic order-placement confirmation
> (`isRejectedOrCanceledState` in `broker-side.ts`; a non-throwing but
> broker-declined order no longer records proposal status "placed"), a
> Robinhood order-id fabrication fix, the share-class symbol fix extended into
> `data-providers.ts`'s Alpaca enrichment providers and the news stream (same
> bug, independent code path), a production-data-confirmed root cause for the
> "Alpaca news never worked" report (a credential issue that self-resolved
> 2026-06-30 ~10:01 UTC — not a code bug), and `docs/broker-capability-plan.md`
> - a 5-broker (Alpaca/Robinhood/eToro/Public.com/IBKR) capability audit +
> MCP evaluation + prioritized roadmap, including a live enumeration of the
> Robinhood MCP surface (43 tools, 34 unused). No roadmap change; the plan
> doc's own roadmap (options trading, new-broker integration, enabling
> disabled streams) is future work, not started. See
> `docs/rollouts/2026-06-30-broker-reliability-and-capability-audit.md`.
> 2026-06-30 (`claude/affectionate-franklin-a52935`): Alpaca share-class symbol
> mapping fix - live orders for tickers like `BRK-B` failed with HTTP 422
> "asset not found" because our canonical hyphenated symbol format (Robinhood
> convention) was passed to Alpaca unconverted; Alpaca requires dot notation
> (`BRK.B`). Added `toAlpacaSymbol`/`fromAlpacaSymbol` conversions at every
> Alpaca boundary (order placement, quotes, order/position mappers). No
> roadmap change; see
> `docs/rollouts/2026-06-30-alpaca-share-class-symbol-mapping.md`.
> 2026-07-01 (`ci/hosted-runner-and-concurrency`): CI runner-bottleneck fix -
> added cancel-in-progress concurrency groups to `ci.yml`/`security.yml`/
> `e2e.yml` and moved `verify`/`gitleaks`/`smoke` to `ubuntu-latest`, since
> the single self-hosted `trading-live-mac` runner was serializing all CI
> and queueing PRs behind unrelated branches. `deploy.yml`/
> `sync-previews.yml` stay self-hosted (they touch the production box
> directly). No roadmap change; see
> `docs/rollouts/2026-07-01-ci-hosted-runner-migration.md`.
> 2026-07-01 (`chore/shared-package-drift-fixes`, PR #280): cross-app
> dependency hygiene - `congress-trade-client.ts` now imports the shared
> `MAX_REFS_BATCH` constant instead of a hardcoded `500`; removed the unused,
> shape-conflicting `congress-shared-aliases.ts`; added a weekly
> `shared-package-pin-check.yml` workflow that warns if our git-pinned
> `congress-trading-shared` commit falls behind that repo's `main`. No
> roadmap change; see
> `docs/rollouts/2026-07-01-congress-trading-shared-drift-fixes.md`.
> 2026-07-01 (`codex/mobile-command-api-rebase-20260701`): rebased the stale
> mobile/PWA command API worktree onto current main as an additive mobile
> control surface. The backend remains source of truth via `mobile_commands`,
> `/api/mobile/*`, and SSE; account deletion reuses the audited M7 deletion
> lifecycle instead of the older short-lived settings deletion request. This
> advances Phase 11 with a new M8 foundation note; see
> `docs/rollouts/2026-06-23-mobile-pwa-command-api.md`.
> 2026-06-30 (`codex/prod-build-hotfix-20260630`): production build/start hotfix -
> after PR #270, the live box needed a manual repair because the default Next 16
> Turbopack build did not emit the production files consumed by the existing
> `next start` PM2 runtime. With the route export repair now landed in PR #275,
> this branch keeps deploys repeatable by using `next build --webpack` and
> webpack-compatible server-only crypto imports. No roadmap change; see
> `docs/rollouts/2026-06-30-prod-build-hotfix.md`.
> 2026-06-30 (`codex/strategy-timeout-sizing-guardrails-20260630`): strategy
> timeout and sizing guardrails - keep the interactive LLM call cap at 60s,
> reject `gpt-5.5` + high reasoning in Settings, runtime-clamp stale
> `gpt-5.5`/high configs to medium, add a 5% preferred opening-order headroom
> under the hard policy max, and stop chat draft promotion from staging
> already blocked policy decisions. No roadmap change; see
> `docs/rollouts/2026-06-30-strategy-timeout-sizing-guardrails.md`.
>
> 2026-06-30 (`codex/fix-policy-route-export`): production build fix - moved
> `stripNullsDeep` out of `app/api/policy/route.ts` because Next 16 rejects
> non-route exports from app route modules. Antigravity strategy-review/test
> quote fallback work has since landed on `origin/main` as PR #274 and is
> included via the merged base, not this fix diff. No roadmap change; see
> `docs/rollouts/2026-06-30-policy-route-export-fix.md`.
>
> 2026-06-30 (`codex/prod-merge-sweep-20260630`): production merge sweep -
> integrates the pending Settings scope/help overhaul, Settings review-action
> polish, Market Scan source-label cleanup, and the now-landed Alpaca
> broker-held/order-lifecycle work into one deployment path. The sweep fixes two
> review blockers before PR: broker-filled
> orders with only pending local reconciliation remain Working instead of
> dereferencing a nonexistent filled event, and legacy Strategy Studio model
> choices are migrated into every connected account before global user policy is
> reduced to true user-level fields. No roadmap change; see
> `docs/rollouts/2026-06-30-prod-merge-sweep.md`.
> 2026-06-30 (`codex/robinhood-public-oauth-20260630`): Robinhood MCP reconnect -
> live diagnostics showed public `/api/auth/robinhood/start` returns a valid
> Robinhood authorize URL, while stale state rows indicate the logged-in
> Robinhood leg is not returning to the public callback. Added an explicit
> same-machine loopback callback opt-in so reconnect can start from
> `socratictrade.com` without requiring app login on localhost. No roadmap
> change; see `docs/rollouts/2026-06-30-robinhood-public-oauth-loopback.md`.
> 2026-06-30 (`codex/market-scan-source-labels`): Latest Decisions and Market
> Scan source subtitles now share alias-aware source-list formatting, so
> `congress`, `congress.trade`, and repeated Congress.Trade segments display
> once as `Congress.Trade`, and `yahoo-finance-delayed-quotes` displays as
> `Yahoo Finance`. No roadmap change; see
> `docs/rollouts/2026-06-30-market-scan-source-labels.md`.
> 2026-06-30 (`codex/merge-antigravity-20260630`): strategy review persistence
> & test quote fallback — incorporates `agent/antigravity-strategy-review-decisions`,
> saving Strategy Studio LLM review proposals in local storage so they survive
> page refresh/modal closure, adding a discard button, and making test broker
> quote fetching fall back to a simulated Test-mode price instead of crashing
> when Yahoo Finance is rate-limited. No roadmap change; see
> `docs/rollouts/2026-06-30-antigravity-strategy-review-localstorage.md`.
>
> 2026-06-30 (`codex/strategy-llm-timeout-diagnostics`): strategy LLM timeout
> diagnostics - production run `64016e66-bb6d-4efc-bb23-2d11b7d054c5` failed
> during the Green Team `gpt-5.5` high-reasoning request before any Red Team,
> proposal, broker, or notification work. Runs now audit LLM step start/failure
> rows, preserve failed step context in the final strategy audit, and surface
> provider/model-specific timeout guidance. Red Team transport failures fallback
> to Bull proposals with an auditable reason. No roadmap change; see
> `docs/rollouts/2026-06-30-strategy-llm-timeout-diagnostics.md`.
>
> 2026-06-30 (`codex/settings-help-overhaul`): Settings scope/help overhaul —
> Strategy Studio now lives under Account Settings -> Strategy, Settings opens
> the correct scope tier for requested account/user sections, Green/Red model
> choices plus reasoning effort are account-scoped strategy fields with a legacy
> user-level seed, and compact field help plus a System Help Settings Glossary
> explain advanced knobs like "Min lots for weight shift" without long tab
> footers. No roadmap change; see
> footers. Follow-up refresh centralizes the Strategy/Assistant model catalog,
> adds Claude to the strategy-review picker, removes old curated OpenAI
> `gpt-4o`/`o1`/`o3` options, and switches DeepSeek curated choices to
> `deepseek-v4-flash` / `deepseek-v4-pro`. No roadmap change; see
> `docs/rollouts/2026-06-30-settings-scope-help-overhaul.md`.

> 2026-06-30 (`codex/alpaca-held-order-guard`): Alpaca broker-held exit guard -
> production KO sell approval failed because an existing Alpaca bracket sell leg
> already reserved all 29 KO shares. Strategy now subtracts active broker-held
> sell/cover orders from available exit quantity before autonomous placement or
> manual approval, blocking duplicate exits before broker submission. The same
> branch also clarifies broker order lifecycle display (`Submitted`/`Working`
> until filled), reconciles broker-paper pending fills on the scheduler, excludes
> pending broker-paper fills from paper P&L/projections, and adds a configurable
> stale limit-order alert (`staleLimitOrderMinutes`, default 15). Stale working
> limit orders can now be intentionally replaced from Activity by canceling,
> re-checking broker state, and submitting the remaining quantity as a market
> order; live Brokerage replacement requires typed confirmation. No roadmap
> change; see `docs/rollouts/2026-06-30-alpaca-held-order-guard.md`.
> 2026-06-30 (`codex/settings-review-polish`): Settings/Strategy Studio polish
> moved LLM Strategy Review controls into an advisory panel instead of a
> header/corner action, unified the strategy-review model picker across review
> surfaces, and tightened Settings scope/account-selector spacing. No roadmap
> change; see `docs/rollouts/2026-06-30-settings-review-polish.md`.
>
> 2026-06-30 (`codex/test-account-readiness`): Test/local readiness no longer
> blocks Start on dashboard portfolio display read errors. Broker-backed
> Paper/Brokerage modes still require account and portfolio reads. No roadmap
> change; see `docs/rollouts/2026-06-30-test-account-readiness.md`.
>
> 2026-06-30 (`codex/strategy-review-diff`): Strategy Studio review proposals
> now render before/after diffs for prompt replacements, scoring weights, and
> risk/automation settings. The LLM tuning prompt also asks models to describe
> below-gate scoring weights as "no scoring-weight changes" instead of exposing
> JSON-null schema language. No roadmap change; see
> `docs/rollouts/2026-06-30-strategy-review-diff.md`.
>
> 2026-06-30 (`fix/merge-pr-205` / PR #237): Alpaca shared market-data fallback —
> review-thread follow-up now lets shared/background scans use the operator's
> connected Alpaca account when a tenant has no complete Alpaca market-data
> credential, keeps REST market data off `alpaca-mcp` execution rows, prefers
> current connected operator key-only credentials before stale stored/env keys,
> preserves tenant key-only credentials before operator key-only fallbacks, and
> preserves FMP health logging for non-403 optional endpoint failures. Also
> ignores hidden worktree and build directories in ESLint config to prevent local
> linting errors. Trading resolution remains per-user/fail-closed.
> No roadmap change; see `docs/rollouts/2026-06-27-alpaca-key-fallback-fmp-warnings.md`
> and `docs/rollouts/2026-06-30-ci-worktree-eslint-ignores.md`.
> 2026-06-30 (`codex/notification-direct-bridge`): direct notification delivery
> now covers legacy operational events (`fill`, `block`, `pending_approval`,
> `kill_switch`, `run_failed`, `proposal_withdrawn`) through the existing
> `sendNotification(...)` choke point, while preserving the legacy
> `notification_events` feed and avoiding duplicate direct webhook posts when a
> policy webhook is configured. No roadmap change; see
> `docs/rollouts/2026-06-30-notification-direct-bridge.md`.
> 2026-06-30 (`codex/audit-log-strategy-ui`): Robinhood MCP quote params,
> LLM-audited strategy steps, account-filtered Activity/Audit feeds, and Settings
> split polish. The 01:33 test-account run failed to get Robinhood quotes because
> `get_equity_quotes` was called with unsupported `account_number`; the call now
> sends only `symbols`, with a regression test. Generic audit rows preserve JSON
> fallback details when no compact summary field exists. No roadmap change; see
> `docs/rollouts/2026-06-30-audit-log-strategy-ui.md`.

> 2026-06-30 (`codex/blocked-proposal-decision-persistence`): blocked proposals
> now persist the policy/tradability decision reasons when they move to
> `blocked`, with a Latest Decisions fallback for older blocked rows. This is the
> safe replacement for stale PR #256's unique persistence behavior; no roadmap
> change. See `docs/rollouts/2026-06-30-blocked-proposal-decision-persistence.md`.

>
> 2026-06-30 (`cursor/trim-openai-strategy-options-f06c` / PR #253):
> custom model selector review fix — trimmed OpenAI options remain reachable via
> Custom because the selector now seeds an out-of-list model id, and
> `next-env.d.ts` is kept on the build-generated route-types path. No roadmap
> change; see `docs/rollouts/2026-06-29-claude-green-red-team.md`.
>
> 2026-06-30 (`feat/tiered-settings` / PR #252): tiered settings review fix —
> stale user-level policy fields in legacy account rows are stripped before the
> user-level overlay, so cleared fields like `redTeamLlmModel` cannot reappear
> from inactive account state. No roadmap change; see
> `docs/rollouts/2026-06-29-tiered-settings.md`.

> 2026-06-30 (`codex/provider-degraded-checkbox`): Provider Degraded
> notification setting - Settings now saves the `provider_degraded` event because
> policy API validation uses the shared notification-event runtime list instead
> of a stale local allowlist. No roadmap change; see
> `docs/rollouts/2026-06-30-provider-degraded-notification-setting.md`.

> 2026-06-29 (`agent/antigravity`): sticky top bar & slide-over offsets —
> made the dashboard top bar sticky and offset the SlideOver components (Activity Log, etc.)
> so they slide in below the top bar instead of overlapping or rendering behind it.
> See `docs/rollouts/2026-06-29-sticky-top-bar-and-slideover-offsets.md`.
>
> 2026-06-30 (`fix/page-title` / PR #251): Congress.Trade shared contract package —
> App A/B wire types, API path constants, and Zod schemas are now imported from
> `@jaywedgeworth22/congress-trading-shared` instead of being duplicated locally.
> The package is pinned to shared commit `220677a`; CI/deploy install steps use a
> shared install helper plus read-only deploy key for npm's private git dependency.
> No roadmap change; see
> `docs/rollouts/2026-06-30-congress-trading-shared.md`.
>
> 2026-06-30 (`codex/agentic-shared-registry-semver-20260630` / PR #279): switched the
> shared dependency from the git+deploy-key pin to the private **GitHub Packages**
> registry (semver range). Install helper now authenticates with `NODE_AUTH_TOKEN`
> (fallback `GITHUB_TOKEN`); CI/e2e/deploy/preview-sync jobs carry `packages: read`.
> Supersedes the deploy-key model in the entry above. No roadmap change; see
> `docs/rollouts/2026-06-30-shared-dep-github-packages.md`.
>
> 2026-06-30 (`codex/browser-title`): browser tab title correction —
> root and welcome metadata now emit the document title `Socratic Trade`
> exactly. No roadmap change; see
> `docs/rollouts/2026-06-30-browser-title.md`.

> 2026-06-29 (`antigravity/multi-agent-optimizations`): multi-agent optimizations —
> implemented a set of 18 system optimizations and UX improvements spanning DB indexing,
> scheduler lease locks, serial SEC 8-K crawls, cache GC sweeps, faster 10-K parsing, stop
> cancel/drift reconciliation, zero-NAV & sizer boundaries, backtest timeline fixes, WCAG AA contrast,
> responsive mobile tabs, ARIA accessible model pickers, P&L bar charts, and button standardization.
> No roadmap change; see `docs/rollouts/2026-06-29-multi-agent-system-optimizations.md`.
> 2026-06-29 (`cursor/complete-sentry-setup-8bed`, Cursor): **Sentry integration
> completed** — browser-runtime init (`instrumentation-client.ts`),
> `global-error.tsx` → `Sentry.captureException`, and the `withSentryConfig` build
> wrapper (source-map upload gated on `SENTRY_AUTH_TOKEN`) are now enabled,
> finishing the server/edge-only setup. Env-gated, redacted, `sendDefaultPii:false`;
> Session Replay opt-in. No roadmap change; see
> `docs/rollouts/2026-06-29-sentry-browser-and-build-wrapper.md`.
>
> 2026-06-29 (`cursor/claude-green-red-team-f06c`, Cursor): **Claude as a
> first-class Green/Red Team model** — `claude-*` models are now selectable for
> both the Bull proposer and Bear reviewer (not just chat), via a new
> `anthropic-messages` transport in `resolveLlmEndpoint` and a shared request
> builder (`src/lib/llm-call.ts`) that uses Anthropic forced tool-use for
> guaranteed JSON while leaving OpenAI-compatible providers unchanged. No roadmap
> change; see `docs/rollouts/2026-06-29-claude-green-red-team.md`.
>
> 2026-06-29 (`main`, Cursor): **Strategy engine improvements** — Bear debate
> now receives structured market data (technical indicators, factor breakdowns,
> smart-money signals, macro context) to independently fact-check the Bull.
> Market holiday/early-close calendar prevents runs on closed days. "Do nothing"
> threshold (`minProposalScoreThreshold`) skips the LLM when all candidates score
> below the bar. See `docs/rollouts/2026-06-29-strategy-engine-improvements.md`.
>
> 2026-06-29 (`codex/profile-menu`): profile menu and header cleanup —
> Auth.js sessions now retain display identity metadata, the dashboard snapshot
> exposes provider avatar/name/login provider, and the header consolidates
> Activity, System Help, theme toggle, and Sign Out under a profile menu with
> photo-or-initials fallback. No roadmap change; see
> `docs/rollouts/2026-06-29-profile-menu.md`.
>
> 2026-06-29 (`codex/google-auth-infisical-note`): CI runner billing unblock —
> GitHub-hosted `ubuntu-latest` jobs are failing before startup due account
> billing/spending-limit errors, so CI verify, Playwright smoke, and Security now
> target the existing self-hosted `trading-live` runner for same-repo branches/PRs
> only. No roadmap change; see
> `docs/rollouts/2026-06-29-self-hosted-ci-billing-block.md`.
> 2026-06-29 (`cursor/ci-autofix-automation-6dbc`): self-hosted gitleaks cleanup —
> Security now removes stale macOS gitleaks installer temp files before invoking
> the pinned action, preserving scan behavior while avoiding persistent-runner
> temp-file collisions. No roadmap change; see
> `docs/rollouts/2026-06-29-gitleaks-temp-cleanup.md`.
>
> 2026-06-28 (`codex/thin-boot-strip`): first-paint loader selection —
> replaced the Quiet Tiles SSR loading shell with option 4, the thin boot strip:
> a single lightweight animated strip plus one screen-reader status and the
> existing explicit failure alert. No roadmap change; see
> `docs/rollouts/2026-06-28-thin-boot-strip-loading.md`.
>
> 2026-06-28 (`codex/robinhood-mcp-discovery-auth`): Robinhood MCP OAuth discovery —
> reconnect now follows Robinhood's documented Trading MCP link first and discovers OAuth
> endpoints from the MCP auth challenge when the official MCP URL is configured. Manual
> auth/token endpoint env remains a fallback/custom-provider path. No roadmap change; see
> `docs/rollouts/2026-06-28-robinhood-mcp-oauth-discovery.md`.
>
> 2026-06-28 (`codex/proposal-dashboard-ui-fixes`): proposal/dashboard polish —
> proposal reference prices now stay tied to the decision-time market quote rather
> than below-market limit entries, fresh proposal performance chips wait 15
> minutes, approval errors refresh with broker-placement failure copy, the Market
> Scan column chooser supports ordering with `Sector` before `Sec RS` by default,
> Symbol drilldowns use a fixed identity header and keep close-only history, Macro
> header copy is aligned, and Performance Unrealized uses current positions'
> mark-to-cost P&L. No roadmap change; see
> `docs/rollouts/2026-06-28-proposal-dashboard-ui-fixes.md`.
>
> 2026-06-28 (`codex/proposal-age-alpaca-sizing`): proposal age and Alpaca sizing fixes —
> proposal cards now show age for decisions under 24 hours old, the risk settings/API
> clear hidden mutually-exclusive dollar/% caps, and Alpaca bracket orders no longer
> attempt native whole-share brackets for sub-one-share dollar amounts. This addresses
> the recent $50-$70 proposals on a ~$100k account, which were caused by a stale hidden
> `$100` max-order cap binding ahead of the visible `5% NAV` setting. No roadmap change;
> see `docs/rollouts/2026-06-28-proposal-age-alpaca-sizing.md`.
>
> 2026-06-28 (`codex/google-auth-primary`): Google auth primary —
> Cloudflare Tunnel remains supported, but Cloudflare Access headers are no longer
> trusted as app login. `AUTH_SECRET` is the fail-closed auth switch, Google/Auth.js
> sessions are the identity source, `/logout` stays inside the app, and empty
> `ALLOWED_EMAILS` allows only the primary operator/aliases. No roadmap change; see
> `docs/rollouts/2026-06-28-google-auth-primary.md`.
>
> 2026-06-28 (`codex/github-login`): GitHub login added —
> Auth.js now renders GitHub when `AUTH_GITHUB_ID`/`AUTH_GITHUB_SECRET` are set,
> requires a verified GitHub email via `user:email`, and maps Google/GitHub
> sign-ins with the same verified email to the same app account. No roadmap change;
> see `docs/rollouts/2026-06-28-github-login.md`.
>
> 2026-06-28 (`codex/robinhood-mcp-resource-param`): Robinhood MCP OAuth resource indicator —
> production still used the public callback and dynamic client registration, but reconnect
> continued to land on Robinhood `/oauth/error`. OAuth authorization and token requests now
> include `ROBINHOOD_MCP_RESOURCE` (defaulting to `ROBINHOOD_MCP_URL`) so the grant is bound
> to the MCP protected resource. No roadmap change; see
> `docs/rollouts/2026-06-28-robinhood-mcp-resource-indicator.md`.
>
> 2026-06-28 (`codex/quiet-tiles-loading`): first-paint dashboard loader polish —
> replaced the duplicated visible loading labels with quiet skeleton tiles,
> kept one screen-reader status plus an explicit failure alert, and updated
> app-facing metadata/welcome wording to dashboard language. No roadmap change;
> see `docs/rollouts/2026-06-28-quiet-tiles-loading.md`.
>
> 2026-06-28 (`codex/settings-connection-status`): Settings header polish —
> moved the admin-only `Connection Status` link beside `Manage Accounts`, removed
> the old bottom status card in Settings -> Connections, and made OpenAI an
> ordinary `LLM` catalog row instead of a required/special provider. No roadmap
> change; see `docs/rollouts/2026-06-28-settings-connection-status.md`.
>
> 2026-06-28 (`codex/settings-connection-status`): Help/Data Sources cleanup —
> made the Help action visibly labeled, removed temporary app-name and stale
> provider wording from Help, linked Data Sources entries to provider/API-key
> pages, and documented that Help/Data Sources copy must stay aligned with
> provider/source changes. No roadmap change; see
> `docs/rollouts/2026-06-28-help-data-sources-copy.md`.
>
> 2026-06-26 (`claude/portfolio-market-scan-ui-27azkz`): operator-driven mobile-UX + correctness pass —
> Portfolio/Readiness/header, Market Scan (icons + universe: top-N + outliers + holdings), Congress/
> Insider (future-date rejection, Congress.Trade casing, time span), System Help + Settings rework,
> Accounts/Edit-Account, 3-way banner, Hide-Test-account, shared-pool default ON, Alpaca account-mismatch
> hardening. No roadmap change; see `docs/rollouts/2026-06-26-portfolio-market-scan-ui-overhaul.md`.
>
> 2026-06-27 (`codex/account-mismatch-selector`): account-selection polish/fix —
> hidden Test now filters both Settings -> Accounts and the command-bar selector, strategy-run
> audits are scoped by `connectedAccountId` for Latest Decisions/Strategy Tuning, and selected
> Alpaca connected accounts no longer fall back to generic paper keys when stored credentials are
> missing. No roadmap change; see `docs/rollouts/2026-06-27-account-mismatch-selector.md`.
>
> 2026-06-27 (`codex/robinhood-balance-failover-audit`): Robinhood account health/fallback visibility —
> production diagnosis showed active execution on Alpaca Roth IRA while the stored Robinhood Agentic
> row lacked MCP OAuth, so balances could not refresh. Settings -> Accounts now labels that as
> `OAuth Needed` with Reconnect, cash-only Robinhood portfolio payloads parse to nonzero balances,
> and broker/data fallbacks emit throttled `recoverable_issue` Activity events. No roadmap change;
> see `docs/rollouts/2026-06-27-robinhood-balance-failover-audit.md`.
>
> 2026-06-27 (`codex/robinhood-oauth-callback-host`): Robinhood OAuth callback host fix —
> production callbacks no longer use loopback `localhost` redirect URIs when the app is
> hosted behind the Cloudflare tunnel. OAuth start remains authenticated, callback is public
> but state-bound, and callback success returns to the public site origin. No roadmap change;
> see `docs/rollouts/2026-06-27-robinhood-oauth-callback-host.md`.
>
> 2026-06-27 (`codex/readiness-oauth-needed`): account readiness hardening —
> the readiness strip and Start/Run blockers now use a server-derived
> `accountReadiness` result instead of `policy.accountNumber` alone. Broker
> OAuth health, selected-account enumeration, broker `agenticAllowed`, and
> portfolio/balance read failures can all mark Account as
> not ready while preserving stored rows for account management. No roadmap
> change; see `docs/rollouts/2026-06-27-account-readiness-broker-health.md`.
>
> 2026-06-27 (`codex/account-ui-logout-oauth`): account UI/logout OAuth hardening —
> Settings and the command-bar controls now keep the Manage Accounts path visible and
> legible, Robinhood reconnect copy is concise, Cloudflare Access logout uses the
> public app origin instead of localhost, and Robinhood OAuth callback completion
> preserves the initiating public redirect/client. No roadmap change; see
> `docs/rollouts/2026-06-27-account-ui-logout-oauth.md`.
>
> 2026-06-27 (`codex/congress-score-eval-clean`): Congress.Trade score/eval —
> added a confidence-capped, direction-aware Congress composite, strict PIT export
> evaluator, and forward evidence fields. The score remains advisory: weak/proxy-only
> analytics do not promote candidates, and real historical validation still requires
> an App A PIT export. No roadmap change; see
> `docs/rollouts/2026-06-27-congress-score-evaluation.md`.
>
> 2026-06-27 (`codex/congress-pit-readiness-gate`): App A PIT readiness contract —
> App B now fails closed on App A export envelopes with
> `validationReadiness.historicalValidationReady=false` and drops PIT rows marked
> unsafe via `pitValidity`, matching Congress.Trade PR #96. No roadmap change; see
> `docs/rollouts/2026-06-27-congress-pit-readiness-gate.md`.

## Current Status

2026-08-21 (Cursor): native weekly value + momentum screens now sit on Macro/Scan (and a thin iOS Scan card) as advisory DATA from the account scan tape.  They do not change scoring weights, policy, or sizing.  Prompt `agentic-strategy@2.15.0`.  Rollout: `docs/rollouts/2026-08-21-weekly-market-screens.md`.

Hosting topology: production is **[socratictrade.com](https://socratictrade.com)**
on Coolify app `socratic-app` (Hetzner fleet box).  Mac `~/apps/trading-live` /
pm2 `trading` / port `4000` and every `*.jays.services` preview hostname
(including `trading-beta`) are retired.  Local review is `npm run dev` in your
own worktree plus the verify CI gate.  See `docs/deployment.md`.

Secrets/config topology (2026-06-25): `.env.local` is git-ignored and is **not** a
secret source (only the secret-free `.env.example` is tracked), and **Infisical is
the authoritative source of truth for secret values** — the app launches through
the Infisical runner (`npm run start:secrets`), which injects them at startup, and
`REQUIRE_SECRETS_MANAGER=1` makes prod refuse to boot off a local `.env.local`. See
`docs/secrets.md` and `docs/deployment.md` → "Configuration & secrets". (The former
GCP runner was removed — Infisical is the single path.) The box authenticates with the machine
identity's **Client ID + Client Secret** (universal auth, long-lived; the runner mints a short-lived
token each launch — a raw `INFISICAL_TOKEN` is only a fallback and the Client Secret is NOT that
token). Current Coolify production injects that identity through `scripts/coolify-prod-start.sh`;
the retired Mac rollback cutover remains scripted in `scripts/infisical-prod-cutover.sh`. Shared
App-A/B secrets are pulled via an app-wins overlay
(`INFISICAL_SHARED_PROJECT_ID` + its own Client ID/Secret). This documents existing behavior; no phase
scope, timeline, or approach changed.

| # | Phase | Spec | Status |
|---|-------|------|--------|
| 1 | Autonomy loop | `docs/phase-1-autonomy-loop.md` | Mostly implemented; hardening/tests remain |
| 2 | Correctness fixes | `docs/phase-2-correctness.md` | Partially implemented; sector attribution incomplete |
| 3 | Performance tracking | `docs/phase-3-performance.md` | Partially implemented; paper portfolio projection, short/cover P&L branches, broker-backed pending-fill reconciliation, and persisted `executionMode` for proposals/snapshots/fills exist. Remaining: deeper attribution/tax reporting and broader broker-paper/live lifecycle tests |
| 4 | Market data and scoring | `docs/phase-4-market-data-scoring.md` | Multi-factor scoring + TTL cache live; Finnhub/FMP/Alpha Vantage/Yahoo enrichment and VIX macro context are wired. 2026-06-16: `fcfYield`/`debtToEquity`/`epsGrowth` now feed `valueScore`/`qualityScore` and the Market Scan table. 2026-06-16 (web-sources): fixed a real bug where the scan merge dropped those fields + `senateTrades` (extracted exhaustive `applyEnrichment`); congressional + SEC-insider overlays now populate `senateTrades`/`insiderSentiment`. 2026-06-19: optional `webull-unofficial` quote enrichment is available for read-only market fields only, disabled by default and never used for execution/fills. 2026-06-19: quote-source attribution now derives broker providers (`alpaca-quotes`, `robinhood-quotes`), OHLC cache sharing is explicit, shared history fills can fulfill pending misses, and Massive grouped daily VWAP can enrich scan rows when available. 2026-06-23: quote-resolvable custom Additional Watchlist symbols missing from the Nasdaq screener are carried into Market Scan via Yahoo quote-only rows, with concrete warnings when a custom ticker cannot be priced; broad dynamic base universes now include S&P 100/OEF, Russell 2000/IWM, Nasdaq Composite, NYSE Composite, and an FT Wilshire 5000 free-screener proxy, then rank down before enrichment/LLM prompting; the candidate cap and below-cutoff outlier reserve are per-user policy settings instead of env-only defaults. 2026-06-24: MCP/provider evaluation documented; direct APIs remain the production hot path, while MCP is recommended for provider research, field exploration, and trial benchmarking only unless normalized through the cache/provenance layer. |
| 5 | Frontend refactor and charts | `docs/phase-5-dashboard-refactor.md` | Partially implemented; dashboard charts, market-scan columns, activity feed, kill-switch confirmation, actionable scan empty states, readable activity summaries, custom ticker validation, and visible runtime/render error surfaces are live |
| 6 | Customization and notifications | `docs/phase-6-customization-risk-notifications.md` | Partially implemented; profiles, risk controls, webhook settings, multi-channel direct delivery, and legacy-event direct-delivery bridge exist; notification polish remains |
| 7 | AI strategy learning loop | `docs/phase-7-strategy.md` | In progress; trade-thesis metadata, red-team debate hook, and learning-loop scaffolding exist. Outcome-aware thesis/regime/sector scorecards, Bayesian shrinkage, `candidates_considered`, `signal_snapshot`, chosen+skipped EvidenceDigest, signal-efficacy, confidence-calibration, durable skipped-name counterfactual materialization, and a 20-lot tuner gate are live. 2026-06-23: broker-paper scorecards/tuning/post-mortem now read the paper bucket with explicit `executionMode` instead of live/Test heuristics. 2026-06-25 correction: persisted MAE/MFE per closed lot (post-mortem `upsertFillExcursionsByKey`), the tuner's consumption of materialized missed opportunities, and true candidate-vs-baseline OOS validation for proposed scoring weights are all LIVE — the OOS gate now also surfaces a "not out-of-sample validated" caution when it cannot evaluate. Remaining: richer per-document digests and more tests around red-team fallback behavior. |
| 8 | Cockpit UI and Strategy Studio | `docs/phase-8-cockpit-ui.md` | Cockpit shell, tabs, Strategy Studio, and strategy tuning API are live. 2026-06-16: full redesign on branch `ui-redesign` — Tailwind 4 + Recharts + Motion, dark/light themes, command bar + Portfolio rail + tabbed workspace, slide-over feeds, modal settings, learning-loop charts. 2026-06-19/20: first-run setup state, Test/Paper/Brokerage legibility, mobile scroll recovery, compact mobile portfolio summary, grouped Operate universe controls with a one-time S&P 500 default migration, Smart Money ticker drawer fallback, and a persisted ticker-logo display preference are live. 2026-06-23: Strategy Studio owns editable Green/Red Team model choices, Run once works as a stopped-system manual proposal check, workspace/feed tabs persist across browser refresh, Macro/Market Scan hover text and title-case headings were expanded, provider/API errors are translated to plain English, the mode banner can be compacted but not hidden, a readiness strip is visible, live approval requires typed server confirmation, Settings base-index buttons support S&P/Nasdaq mutually-exclusive families plus broad dynamic universe counts, Market Scan exposes a direct gauge shortcut to Settings -> Data for candidate cap/outlier reserve controls, and the Accounts list stacks/actions better on mobile after desktop/tablet/mobile screenshot QA. 2026-06-24: shared ticker buttons now give Macro movers/news tickers the same hover/click drilldown behavior as Market Scan. 2026-06-27: unauthenticated Robinhood MCP rows show `OAuth Needed`/Reconnect rather than plain Connected, recoverable broker fallbacks render as Activity diagnostics, and the Account readiness strip/Start/Run blockers now fail closed when broker OAuth, credentials, selected-account availability, agentic eligibility, or balance/portfolio reads are broken. Remaining: replace browser prompt with a richer in-app confirmation modal and broaden mobile/keyboard e2e coverage |
| 9 | Backend web sources (scraped signals) | `docs/phase-9-web-sources.md` | 2026-06-16/17 (branch `web-sources`): `src/lib/web-sources/` reads no-free-API signals server-side — Senate eFD + Capitol Trades **congressional trades**, **SEC EDGAR Form 4** insider, and **FINRA daily short-volume** — with polite cached fetch, persistent daily refresh, scheduler hook, event candidate union, source attribution, scan/prompt/UI wiring, and a never-fabricate guarantee. Also: fixed the dropped-enrichment-field bug, plumbed technical/risk fields, `signal_snapshot` audit, thesis×regime + signal-efficacy + confidence-calibration learning, 20-lot gate, edge-aware sizing. Follow-ups now tracked in Phase 10 |
| 10 | Stronger signals, learning & UI (v2 plan) | `docs/phase-10-signals-learning-ui-v2.md` | In progress on `phase-10`: positioning/smart-money deterministic sub-score, sector scorecard, full EvidenceDigest for chosen+skipped, SEC 8-K bulletins with item-label enrichment, market breadth/internals, expanded FRED/macro metrics, Macro tab, Fama-French, Cboe SKEW/VVIX, CFTC COT, Congress.Trade confidence-capped composite + PIT export evaluator with App A `validationReadiness` / `pitValidity` fail-closed gates, technical signals, keyed OHLC cascade, batched Voyage/Pinecone RAG scaffold with paced/capped 8-K ingestion, 2026-06-20 tenant-safe RAG metadata/filter/backoff hardening with raw-user credential lookup preservation, symbol drilldown with 0-100 signal thresholds, price chart with VWAP overlay, Market Scan `vs VWAP`, first-pass prompt compaction, factor-bucket scorecards, current-scan skipped counterfactual summaries, durable/mature-horizon skipped-name counterfactual rows, configurable red-team conviction threshold, and an optional de-risk-in-crisis opening-exposure cap are live. Remaining: real App A PIT export validation once App A marks `historicalValidationReady=true`, broader adaptive prompt compaction/cache layout, production-grade filing/news digests, analyst/earnings revisions, SEC XBRL facts, post-mortem/tuning use of missed-opportunity rows, full learning-matrix UI, and broader scoring-threshold settings. |
| 11 | Multi-user & API-key management (plan) | `docs/phase-11-multi-user.md` | In progress: default-user scaffolding exists; connected accounts now keep API keys server-only in dashboard snapshots, encrypt stored credentials, preserve credentials on metadata edits, route Alpaca through the active connected account, sync Robinhood through MCP OAuth/status instead of manual keys, support Alpaca MCP client connections alongside REST, keep account connection buttons persistent in UI for multi-broker setups, derive Alpaca paper vs brokerage environment dynamically via account number `PA...` or API key `PK...`, enforce required account numbers for Alpaca, preserve user-entered Alpaca account labels in the Accounts list while showing Paper/Brokerage as environment metadata, derive execution state as Test vs Paper vs Brokerage, present supported account connect buttons in Accounts, keep Paper accounts optional and user-selected, expose a hardened Robinhood MCP HTTP/SSE transport plus `/api/broker/mcp/health`, use that health check to distinguish stored Robinhood rows from authenticated MCP sessions (`OAuth Needed` + Reconnect), expose server-side `accountReadiness` so broker visibility/backfill cannot masquerade as selected-account usability, ship Settings → Connections for provider keys and connection status, let users choose separate Green Team and Red Team OpenAI/xAI models in Strategy Studio with Green fallback, route major provider/LLM calls through `resolveApiKey(service,userId)`, scope strategy locks, paper projections, learning scorecards, tax reads, notifications, reflections, dashboard callbacks, and prompt cache keys by user, route high-impact API handlers through verified middleware identity via `resolveRequestUser`, explicitly share public/env-key market data while keeping user-keyed history private by default, track pending public OHLC misses so later shared fills can refresh prior requesters without spending another user's key, and add Infisical wrappers, local Gitleaks scanning, Sentry runtime hooks, redacted Langfuse LLM traces, npm Dependabot, Litestream scripts, and Playwright smoke tests. 2026-06-24: direct Alpaca Add Account no longer shows the endpoint explainer, live default endpoint is `https://api.alpaca.markets` while Paper remains `https://paper-api.alpaca.markets/v2`, and Alpaca account-type parsing is best-effort from broker-returned account subtype fields. 2026-06-27: broker/data fallbacks in the account dashboard path now emit throttled `recoverable_issue` audit events. 2026-06-28: site auth now relies on Auth.js Google sessions instead of Cloudflare Access headers; `AUTH_SECRET` arms fail-closed auth, `/logout` redirects to app `/login`, and empty `ALLOWED_EMAILS` allows only primary operator aliases. GitHub CI/e2e/security workflows are deferred until push credentials include `workflow` scope. M3 complete (2026-06-21): per-user policy/profiles/prompt/tuning fully scoped; global settings seeds removed; one-time migration to copy legacy global rows to 'local' user; DELETE /api/profiles/[id] route added; two-user isolation verified by test/per-user-policy-isolation.test.ts. M6 real identity/auth is implemented with Auth.js Google fail-closed middleware, request-scoped SSR snapshots, `/login`, `/logout`, and visible signed-in/Sign out UI. M7 account deletion is implemented with preview/prepare/final-delete API, multi-step Settings -> Data UI, broker/Google/Apple limitations, in-flight trading blockers, per-user OAuth/token cleanup, and hashed deletion audit. Remaining: complete data isolation audit for any newer fills/snapshots/proposals/learning tables and add provider-account-id identity mapping before Apple private-relay identities become first-class. |
| 10 | Stronger signals, learning & UI (v2 plan) | `docs/phase-10-signals-learning-ui-v2.md` | In progress on `phase-10`: positioning/smart-money deterministic sub-score, sector scorecard, full EvidenceDigest for chosen+skipped, SEC 8-K bulletins with item-label enrichment, market breadth/internals, expanded FRED/macro metrics, Macro tab, Fama-French, Cboe SKEW/VVIX, CFTC COT, technical signals, keyed OHLC cascade, batched Voyage/Pinecone RAG scaffold with paced/capped 8-K ingestion, 2026-06-20 tenant-safe RAG metadata/filter/backoff hardening with raw-user credential lookup preservation, symbol drilldown with 0-100 signal thresholds, price chart with VWAP overlay, Market Scan `vs VWAP`, first-pass prompt compaction, factor-bucket scorecards, current-scan skipped counterfactual summaries, durable/mature-horizon skipped-name counterfactual rows, configurable red-team conviction threshold, and an optional de-risk-in-crisis opening-exposure cap are live. Remaining: broader adaptive prompt compaction/cache layout, production-grade filing/news digests, analyst/earnings revisions, SEC XBRL facts, post-mortem/tuning use of missed-opportunity rows, full learning-matrix UI, and broader scoring-threshold settings. |
| 11 | Multi-user & API-key management (plan) | `docs/phase-11-multi-user.md` | In progress: default-user scaffolding exists; connected accounts now keep API keys server-only in dashboard snapshots, encrypt stored credentials, preserve credentials on metadata edits, route Alpaca through the active connected account, sync Robinhood through MCP OAuth/status instead of manual keys, support Alpaca MCP client connections alongside REST, keep account connection buttons persistent in UI for multi-broker setups, derive Alpaca paper vs brokerage environment dynamically via the account number PA prefix, state the Alpaca Paper/Brokerage default endpoints before asking for custom endpoints, enforce required account numbers for Alpaca, derive execution state as Test vs Paper vs Brokerage, present supported account connect buttons in Accounts, keep Paper accounts optional and user-selected, expose a hardened Robinhood MCP HTTP/SSE transport plus `/api/broker/mcp/health`, use that health check silently behind the Robinhood connect action instead of a persistent disconnected status card, ship Settings → Connections for provider keys and connection status, let users choose separate Green Team and Red Team OpenAI/xAI models in Strategy Studio with Green fallback, route major provider/LLM calls through `resolveApiKey(service,userId)`, scope strategy locks, paper projections, learning scorecards, tax reads, notifications, reflections, dashboard callbacks, and prompt cache keys by user, route high-impact API handlers through verified middleware identity via `resolveRequestUser`, explicitly share public/env-key market data while keeping user-keyed history private by default, track pending public OHLC misses so later shared fills can refresh prior requesters without spending another user's key, and add Infisical wrappers, local Gitleaks scanning, Sentry runtime hooks, redacted Langfuse LLM traces, npm Dependabot, Litestream scripts, and Playwright smoke tests. GitHub CI/e2e/security workflows are deferred until push credentials include `workflow` scope. M3 complete (2026-06-21): per-user policy/profiles/prompt/tuning fully scoped; global settings seeds removed; one-time migration to copy legacy global rows to 'local' user; DELETE /api/profiles/[id] route added; two-user isolation verified by test/per-user-policy-isolation.test.ts. M6 real identity/auth is implemented with Cloudflare Access/Auth.js fail-closed middleware, request-scoped SSR snapshots, `/login`, `/logout`, and visible signed-in/Sign out UI. M7 mobile foundation adds `/api/mobile/*`, a durable audited mobile command queue, `/mobile` PWA, SwiftUI starter client, SSE status updates, and a multi-step account deletion/reset flow for Google/Apple-authenticated users. Remaining: complete data isolation audit for any newer fills/snapshots/proposals/learning tables and broaden mobile e2e coverage. |
| 12 | Architecture Blueprint | docs/architecture-blueprint.md | Completed 2026-06-20: Blueprint R1–R5 requirements (tri-state execution safety, trailing stop-loss engine, IRA taxation policy settings, multi-tenant RAG & rate limits, prompt compaction & reasoning) are fully implemented, tested, and verified. |

**Client / hosting correction (2026-08-20):** the phase-11 cells above still mention `/mobile` PWA as a live foundation.  That UI was retired in #2801 (`/mobile` redirects to `/console`).  Live clients are `/console` (desktop + phone widths) and native iOS.  `/api/mobile/*` stays the iOS API.  Production is Coolify at socratictrade.com, not Mac pm2 and not Vercel.

## Integrations (outside the phase roadmap)

- **congress.trade data-share — push** (2026-06-22, `docs/congress-trade-share.md`):
  outbound, default-OFF forwarding of this app's company refs + daily closes +
  the `^GSPC` series to `congress.trade` (App A)'s idempotent import endpoint, so
  the *shared* daily FMP quota is spent once. After-scan refs hook + once-per-day
  nightly `prices`/`spx` batch + an admin trigger route. Gated on
  `CONGRESS_TRADE_TOKEN` + `CONGRESS_SHARE_ENABLED`; token is server-only. As of
  2026-06-30, the outbound payload types, API path constants, and runtime schema
  checks come from `@jaywedgeworth22/congress-trading-shared`.
- **congress.trade — receive/consume** (2026-06-22, `docs/congress-trade-consume.md`,
  contract `docs/push-to-app-b.md`): default-OFF cache-aside reads of App A's
  `/api/market/*` (history first tier), App A as the congressional source via
  `/api/transactions` (token-gated), and a push receiver (webhook + SSE) feeding the
  scan's web-signal overlay. Shared transaction/event contracts now come from
  `@jaywedgeworth22/congress-trading-shared`. Inert until App A's read endpoints are live.
  Round 3 (pending App A slots): push `volume`+`insider`+`shortVolume` on the nightly batch.
- **congress.trade — return-path + analytics ownership reply** (2026-06-24,
  `docs/congress-trade-app-b-reply.md`): accepted App A's analytics ownership split
  (they own congressional-trade analytics, App B owns market/price analytics) with a
  **pull/pull** transport (no aggregate pushing either way); specified the inbound
  return-path contract App A is waiting on. Both follow-up PRs are now **BUILT**
  (additive + default-OFF):
  (1) `feat/securities-import-receiver` — `POST /api/admin/securities/import`
  (bearer `APP_B_INGEST_TOKEN`, default-closed) + a local EOD cache
  (`imported_*` tables, `db-securities-import.ts`) wired as an opt-in, density-guarded
  `fetchDailyOHLC` tier, to land App A's price/spx/ref gap-fills — **BUILT 2026-06-25**
  (`docs/rollouts/2026-06-25-app-b-securities-import-fundamentals-price-targets.md`).
  (2) `congress-share.ts` `fundamentals[]`/`analyst[]` push for App A's PR #46 slots —
  built earlier via `marketQuoteToFundamentals`/`marketQuoteToAnalyst` (sourced from the
  scan's `MarketQuote`, gated `CONGRESS_SHARE_FUNDAMENTALS_ENABLED`). Numeric price targets,
  previously null, are now ALSO fillable via the opt-in FMP `price-target-consensus` provider
  (`FMP_PRICE_TARGETS_ENABLED`) — **BUILT 2026-06-25**; they thread through the enrichment
  surface onto the quote and into `marketQuoteToAnalyst`.
  (3) **Fundamentals/analyst read-back tier** — App A now exposes
  `GET /api/market/fundamentals|analyst/:ticker` (the donated tables finally have readers);
  App B reads them via `getAppAFundamentals`/`getAppAAnalyst` + a
  `CongressTradeEnrichmentProvider` seated ahead of the paid fundamentals providers, gated by its OWN
  `CONGRESS_TRADE_FUNDAMENTALS_ENABLED` (separate from the price-read `CONGRESS_TRADE_READS_ENABLED`), with a
  `CONGRESS_TRADE_MAX_STALE_DAYS` freshness cap and `NEWS_CACHE_TTL_MS` caching
  — **BUILT 2026-06-25** (`docs/congress-trade-consume.md` §1b,
  `docs/rollouts/2026-06-25-crossapp-consumer-reads.md`). Paid-call elimination is an **opt-in coverage
  hint** (`ENRICHMENT_SHORT_CIRCUIT_ENABLED`): the cascade hands paid providers a per-symbol set of the
  fields App A already covers (+ the analyst source) so they skip only the redundant SUB-calls (e.g. FMP's
  ratios-ttm / grades-consensus / price-target calls) while still fetching their unique fields
  (insider/senate); no whole provider is skipped → no field lost; default OFF. App A reads are merged
  across all fresh rows, freshness-gated by the data `date`, and negative-cached 1h (transport errors are
  NOT cached). A→B push wired (`APP_B_IMPORT_URL`+`APP_B_INGEST_TOKEN` on App A; App B needs the same token
  + `SECURITIES_IMPORT_HISTORY_TIER_ENABLED`).
- **congress.trade — App A handoff: new analytics endpoints + adjusted-close fix** (2026-06-25,
  `docs/rollouts/2026-06-25-app-a-handoff-integration.md`): consumes three new App A endpoints
  now live/merging (App A PRs #77/#79/#80): `GET /api/analytics/conviction` (composite 0–100
  conviction score, gated by `CONGRESS_ANALYTICS_ENABLED`), `GET /api/analytics/ticker/{T}/backtest`
  (per-ticker post-buy return stats, on-demand), and `GET /api/analytics/conflicts` (committee
  conflict-of-interest disclosures). Conviction + conflictCount wired into the daily
  `refreshCongressAnalytics` parallel fetch and the `CongressAnalytics` overlay. Yahoo adjusted-close
  fix: `fetchYahoo` now prefers `indicators.adjclose` (split+dividend-adjusted) over raw close for
  correct multi-year returns pushed to App A. **2026-06-26 update:** conviction + conflict bulletins
  now emitted in `web-sources/index.ts`; `congressAnalyticsScore` gates on `convictionDirection=BUY`
  and adds a `convictionBoost` so conviction-only tickers reach the scan candidate set. **Deferred:**
  ticker-change/delisting map (App A priority #3); bulk-snapshot bootstrap; congress-share bypass
  for adjusted-close when CONGRESS_TRADE_READS_ENABLED tier precedes Yahoo.

## Fleet-infra tooling (host-side, no product-roadmap change)

- **Retired deploy safety + CI Sentry coverage** (2026-07-11,
  `.github/workflows/sentry-ci-report.yml`, `scripts/sentry-ci-report.py`,
  `docs/rollouts/2026-07-11-retired-deploy-ci-observability.md`): removed the
  obsolete Mac/PM2 GitHub Actions deploy workflow so Coolify remains the only
  automatic production path, and synchronized Sentry failure/cron observation
  with the active workflow fleet. This is CI/operations hardening only; it does
  not change product scope, phase order, or acceptance criteria.

- **Effort-log union-merge safety net** (2026-07-10,
  `scripts/effort-log-union-merge.py`,
  `docs/rollouts/2026-07-10-effort-log-union-merge-safety.md`): a stdlib-only,
  row-level, invariant-checked reconciler that merges the machine-local live
  effort board against the repo mirror (`docs/EFFORT-LOG.md`) **without ever
  dropping a live-only row**. This is host-side coordination tooling only — it
  changes no product code, ships no user-facing behavior, and does **not** alter
  the phase roadmap or acceptance checks above. **Follow-up (out of this PR's
  scope):** wire it into the always-on host-side `~/.claude-merge-shepherd/run.sh`
  30-minute driver so live/mirror reconciliation runs automatically; that cron
  lives outside this repo and touching it needs an owner-supervised session.

## Build Order

### Current landing closure (2026-07-14)

- Finish PR #1586 with immutable generation-bound transcript derivative IDs, exact provider/ledger
  receipts, heartbeat-fenced writes, active-generation retrieval, provider-first consecutive-clean
  erasure, account-deletion coverage, and independent private/shared rerank candidate pools.
- Treat Cloudflare Access application-token timestamps as authorization-token freshness only; require
  a matching signed Auth.js `loginAt` for post-deletion identity regeneration.
- Complete the ordered Node 24 gate and hostile re-review, merge #1607 and #1586 through their PRs,
  then verify zero open PRs plus the exact final production release. Transcript activation remains a
  separate owner/config decision gated on endpoint entitlement and commercial storage/display rights.

1. Phase 1 hardening: scheduler starts once, run lock works, market-hours state is visible.
2. Phase 2 correctness: estimated notional is authoritative and sector attribution covers all scan rows.
3. Phase 3 performance: snapshots, fills, Test vs broker-routed P&L, and run attribution.
4. Phase 4 data/scoring: provider abstraction, quote enrichment, TTL cache, factor scores.
5. Phase 5 dashboard: typed components, charts, visible loading/error states, better universe/watchlist UX.
6. Phase 6 customization: profiles, deterministic risk rules, webhook notifications.
7. Phase 7 strategy loop: persist learning metrics, harden red-team debate fallback, and keep short/cover disabled for Live until broker/accounting behavior is proven.
8. Phase 8 cockpit UX: harden strategy tuning tests, polish pane density, and add persisted tuning history if audit needs justify it.

## Acceptance Checks

- Required handoff verification: `npx tsc --noEmit`, `npm test`, then
  `npm run build`. GitHub Actions CI (`verify` workflow at `.github/workflows/ci.yml`)
  mirrors this sequence and is live — PRs cannot merge until `verify` goes green.
  The security, e2e, and deploy workflows remain in `ci-pending/` (require additional
  credentials / environment setup before they can be promoted to `.github/workflows/`).
- The strategy can run autonomously while enabled, without opening the dashboard.
- `strategy_run` audit events are written inside `runStrategyOnce()` and only once per executed run.
- Daily limits count reviewed `estimated_notional`, including share-quantity market orders.
- Held positions can be attributed to sectors even when they are not top scan candidates.
- Performance summaries separate live and paper results.
- Scan candidates expose provider freshness, factor score breakdowns, and bid/ask data when available.
- Dashboard shows market session, scheduler state, performance charts, active profile, risk settings, and notification status.
- Desktop dashboard fits in one viewport with internal pane scrolling and tabbed workspaces.
- Mobile and tablet layouts use normal page scrolling with the fixed cockpit
  shell reserved for desktop widths.
- Strategy tuning proposals are review-only until the user explicitly applies them.
- Native iOS uses the shared backend command queue and status model;
  phones never store provider secrets, broker credentials, or MCP tokens.
  The `/mobile` PWA UI was retired in #2801 (`/mobile` redirects to `/console`).
- Policy enforcement deterministically handles daily limits, symbol limits, sector caps, stop-loss, and take-profit rules.
- Webhook notifications are attempted only when configured and every attempt is audited.
- Error/LLM observability stays opt-in and redacted by default for account, prompt, and credential data.
- The local SQLite database has a documented Litestream replicate/restore path before production reliance.
- Production hosting is Coolify at `socratictrade.com` only.  Preview / beta
  hostnames are retired.  Do not recreate `trading-beta` or per-agent
  `*.jays.services` preview lanes.
- Agent branch landing requires a clean worktree and refuses stale semantic overlap
  when the branch and `origin/main` both changed the same files since divergence.
- Root-level manual probe artifacts such as screenshots, one-off UI scripts, and
  accidental shell-output files stay ignored so the integration worktree remains
  reserved for review and merges.

## 2026-07-21 PR #1845
LLM cooldown + draining purge safety — see rollout note.

## 2026-09-09 — [CLAUDE] Healthcheck tolerance for event-loop stalls (PR #3201)

Production served a public 503 while healthy: `/api/live` intermittently took 8.60s against a 5s container healthcheck timeout, so Docker marked the container unhealthy and Traefik stopped routing.  Widened to timeout=15s / retries=5 (detection bound ~225s).

This is MITIGATION.  The root cause is the non-convergent FTS mirror loop fixed in PR #3202; stalls up to 36,511ms were measured, which a 15s timeout still cannot absorb.  Next action: land PR #3202.
