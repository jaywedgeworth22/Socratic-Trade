# Socratic-Trade — Architecture & Backend Audit

**Date:** 2026-08-17  
**Auditor:** Cursor Cloud (read-only)  
**Baseline:** `main` `4980322b48b797d88c8e1de7226fb50f680c45a9`  
**Scope:** Framework, API boundaries, state machines, queues, persistence, caching, concurrency, failure recovery, scalability, latency, production durability.  
**Out of scope:** Product fixes, UI restyles, PWA work, iOS ship, new provider keys.

This is a point-in-time evidence audit of current `main`, not a standing task list.  Older reviews (`docs/audit-2026-06-29.md`, `docs/reviews/2026-06-20-failure-mode-brainstorm.md`, `docs/architecture-blueprint.md`) are treated as historical unless the cited code still matches.

---

## 1. Executive conclusion

Socratic-Trade is a **single-process, single-writer trading system**: Next.js 16 App Router, one Coolify container, one `better-sqlite3` connection, WAL, Litestream 0.5.12 to Backblaze B2, weekly R2 cold snapshots.  The money path (approve / place / reconcile / halt) is substantially hardened after the June–August 2026 incident series.  Most June 2026 “critical” findings (unauthenticated APIs, non-atomic approve, missing CI, ephemeral `ENCRYPTION_KEY`) are **closed**.

**No active P0 in current code.**  The remaining material risk is operational and architectural:

1. **Backup depth is degraded.**  Litestream L2/L3 compaction is detected as wedged; L0 + daily L9 remain the restore floor.  Root cause is dual Litestream writers during rolling deploys, not application SQL.
2. **Ingest and trading share one event loop and one SQLite file.**  FTS mirroring is now sliced, but a single oversized row can still pin HTTP and the scheduler.
3. **Crash recovery is uneven.**  `strategy_runs` and mobile commands are swept; durable `strategy_run_requests` and `task_journal` rows can stay `running` forever after a kill.
4. **Horizontal scale is not supported.**  Leases, rate limits, and SSE are process-local.  That is correct for today’s one-box fleet and becomes a P0 if a second live replica is ever started.

Highest-leverage next work is **ops** (Litestream fencing + B2 L1 cleanup, already tracked) and **small crash-recovery hygiene** (stale `strategy_run_requests` sweep).  Do not start a database rewrite in this window.

---

## 2. Method

| Step | What ran |
|------|----------|
| Repo snapshot | `git log -3`, `STATUS.md`, `PLAN.md`, `docs/EFFORT-LOG.md`, latest `docs/rollouts/*` |
| Code | `src/lib/db*.ts`, scheduler/leases/queues, `app/api/**`, `middleware.ts`, `instrumentation.ts`, Litestream/Coolify scripts, health/ready |
| Cross-check | `gh issue list` / `gh pr list` on 2026-08-17; closed incident issues #2714, #2715, #2709, #2746, #2748, #2749, #2750, #2771, #2799 |
| Live ops | Not required for this code audit.  Production confirmation of Litestream tiers still uses `bash scripts/fetch-prod-ops-snapshot.sh` (needs `OPS_DIAGNOSTIC_TOKEN`) |
| Parallel review | Four read-only explore passes (persistence, queues, API/execution, cache/concurrency) then parent verification of cited lines |

Severity:

| Sev | Meaning |
|-----|---------|
| **P0** | Money loss, data loss, or production-down **now** if the stated condition is true |
| **P1** | Likely production incident, money-path correctness gap, or DR failure under load/crash |
| **P2** | Correctness, scale, or ops debt that will bite as load or replica count grows |
| **P3** | Hygiene, observability, or defense-in-depth |

Effort: **S** (hours, localized) / **M** (a focused PR + tests) / **L** (cross-module or ops-irreversible).

---

## 3. System map (current, not the 2026-06 blueprint)

```text
Browser / iOS
    │  session cookie or CF Access JWT
    ▼
Next.js 16 middleware  ── CSRF on mutating /api/* ── rate-limit (in-process Map)
    │
    ▼
Route handlers (app/api/**) ── resolveRequestUserId() ── user_id scoped SQL
    │
    ├─ Money path: claimProposalForExecution (.immediate) → broker.ts choke point
    │                 → refId persisted → Alpaca/RH/Tradier → reconcile sweeps
    │
    ├─ Autonomy: instrumentation.ts → startServerBackgroundWorkers()
    │              ├─ scheduler 60s + single-leader lease
    │              ├─ SEC ingest worker 5s (cap 5 tasks/tick)
    │              ├─ usage-monitor replay ~60s
    │              ├─ server-knob supervisor 30s
    │              └─ optional WS streams
    │
    └─ Persistence: getDb() singleton, WAL, busy_timeout=60s, schema v83
                     Litestream replicate -exec next start  → B2 (60s RPO)
                     weekly better-sqlite3 backup()         → R2 retain 1
```

**Framework facts (verified):**

- Next `^16.3.1`.  `next.config.mjs` does **not** set `output: "standalone"`.  The image copies the full `/app` tree and starts via `scripts/coolify-prod-start.sh`.
- `serverExternalPackages`: `better-sqlite3`, Pinecone, Voyage.  Webpack aliases those plus `node:*` to `false` on the edge/client graph.
- Boot contract is `instrumentation.ts` `register()`: IPv4-first DNS, exit-guard, secrets-manager assert, production `ENCRYPTION_KEY` assert, credential migrations, then workers.  Dev/test workers stay off unless `DEV_BACKGROUND_WORKERS=on`.
- Container: `PORT=4000`, Docker `HEALTHCHECK` curls `/api/health` every 30s with a 5s timeout and 90s start period (`Dockerfile:75-76`).
- Execution mode is **account environment only** (`broker/paper` or `broker/live`).  No local simulator.  `docs/architecture-blueprint.md` still describes the retired Test/Paper/Brokerage tri-state and is marked superseded (2026-07-03).

---

## 4. Findings

### F1 — Litestream L2/L3 compaction wedge (detection shipped; root cause open)

| Field | Detail |
|-------|--------|
| **Severity** | **P1** |
| **Status** | Residual / owner-ops.  Detection merged.  Repair is not a code change. |
| **Evidence** | `docs/rollouts/2026-08-14-empty-tier-wedge-detection.md`: Coolify rolling deploys briefly run two Litestream writers on one B2 prefix; 0.5.12 has no fencing; colliding `MaxTXID` breaks `ltx.IsContiguous` so 1→2 promotion dies.  Health now grades empty higher tiers (`src/lib/runtime-health.ts` `assessLitestreamTierFreshness`; `app/api/health/route.ts` ~379–392).  Replica config: `litestream.coolify.yml` `sync-interval: 60s`, snapshot `24h` / retain `168h`, validation hourly, **not** `verify-compaction: true`. |
| **Impact** | Live trading DB is fine.  Deep PITR/compaction is not.  Restores fall back to L0 + daily L9.  B2 L1 object count grows.  A second overlapping deploy can re-wedge a repaired prefix. |
| **Verify** | `GET /api/health` → `checks.storage.litestreamTiers`, `litestreamTiersDegraded`, `litestreamTierDegradedReasons`.  Ops snapshot.  B2 list `trading-live/app.db` L1/L2/L3 file counts. |
| **Fix** | Keep Coolify **non-overlapping** deploys (STATUS 2026-08-16: consistent names + 60s start already on).  One-time B2 delete of colliding L1 objects after an owner-authorized backup.  Do not upgrade Litestream past 0.5.12 until the 0.5.14 tcp_mem regression is proven gone. |
| **Effort / risk** | M ops.  B2 delete is irreversible without the L9/R2 floor. |
| **Dependencies** | Owner B2 key; Coolify deploy strategy; L9 snapshots healthy. |
| **Tracked** | Yes — #2709 merged (detection); #2697 / effort #2776 still open for wedge + Pushover; rollouts 2026-08-13/14/16.  **Do not re-file as a new app bug.** |

---

### F2 — Dual live writer is a standing P0 invariant, not a current code defect

| Field | Detail |
|-------|--------|
| **Severity** | **P0 if violated**; **P2 while the single-container contract holds** |
| **Status** | Operational invariant.  Mitigations exist; they are procedural. |
| **Evidence** | `scripts/coolify-prod-start.sh` comments: flip `DB_BOOTSTRAP=live` only after Mac `pm2 trading` + `litestream` are stopped — otherwise two schedulers trade the same broker accounts.  App runs under `litestream replicate -exec "node_modules/.bin/next start"`.  Scheduler lease TOCTOU is documented (`src/lib/scheduler-lease.ts:6-11`).  Single-leader defaults **ON**. |
| **Impact** | Two live processes = duplicate autonomy ticks and/or Litestream L1 collisions (F1).  Real orders can double. |
| **Verify** | One Coolify replica for `socratic-app`.  No Mac `pm2 trading`.  Health `schedulerLease.owner` is a single pid. |
| **Fix** | Keep the invariant.  If replicas ever go above 1, stop: this architecture cannot share one SQLite file. |
| **Effort / risk** | S (ops checklist).  L if someone “just adds a replica.” |
| **Dependencies** | Coolify replica count; Mac process list. |
| **Tracked** | `AGENTS.md`, `docs/rollouts/2026-08-16-asc-eula-coolify.md`. |

---

### F3 — Durable `strategy_run_requests` have no stale-`running` sweep

| Field | Detail |
|-------|--------|
| **Severity** | **P1** |
| **Status** | **Open.  New relative to the 2026-08-15 durable-run work.** |
| **Evidence** | Claim is a CAS from `queued` → `running` with no `lease_expires_at` and no reclaim (`src/lib/strategy-run-requests.ts:112-137`).  Dedup blocks a second manual run while any row is `queued` or `running` (lines 68–91).  Contrast: `strategy_runs` are swept every tick **before** the leader gate (`src/lib/scheduler.ts:416-425` `markStaleRunningRuns`).  Mobile commands also have a stale sweep. |
| **Impact** | Kill/deploy mid durable Run-once leaves `status='running'`.  The owner cannot queue another manual run.  Account deletion waits on `activeStrategyRunRequests`.  The scheduler drain only claims `queued` rows, so the stuck row never finishes. |
| **Verify** | `SELECT id, user_id, status, started_at FROM strategy_run_requests WHERE status='running';`  Repro: `POST /api/strategy/run`, kill the process after 202, confirm the row stays `running` across ticks. |
| **Fix** | `markStaleRunningStrategyRunRequests()` mirroring `markStaleRunningRuns` (30 min + optional live `strategy_runs` cross-check).  Run it in the same pre-leader sweep lane. |
| **Effort / risk** | S / low.  Pattern exists twice. |
| **Dependencies** | None.  Do not block on Litestream work. |
| **Tracked** | Durable queue: `docs/rollouts/2026-08-15-durable-strategy-run.md`.  **This gap is not called out there or in STATUS.**  No open issue. |

---

### F4 — Synchronous SQLite + FTS still share the trading event loop

| Field | Detail |
|-------|--------|
| **Severity** | **P1** under ingest load; **P2** on a quiet desk |
| **Status** | Residual after #2715.  Bounds landed; architecture unchanged. |
| **Evidence** | `getDb()` is a process singleton; `better-sqlite3` is sync (`src/lib/db.ts:84-99`).  `busy_timeout = 60000`, `synchronous = NORMAL`, WAL.  FTS insert comments record a 702-chunk 10-K at ~165 ms/row and 119 s stretches (`src/lib/db-learning.ts:1618-1625`).  Worker now slices 20 chunks / 6 s and heartbeats (`src/lib/rag/sec-ingest-worker.ts` ~457–468).  One oversized row still pins the loop. |
| **Impact** | During universe ingest: HTTP 503s, scheduler heartbeat delay, leader abdication after consecutive heartbeat write failures, Coolify health flaps if `/api/health` exceeds the 5 s Docker timeout. |
| **Verify** | Enable `SEC_INGEST_WORKER_ENABLED`, ingest a large 10-K, watch `[worker] ftsMirrorSlice` durations and `schedulerAgeSeconds`.  Correlate `local_db_contention` audits. |
| **Fix** | Keep current slice + adaptive batches.  Next step is a **sidecar ingest process** or worker thread for FTS, not another timeout bump.  `busy_timeout` increases already failed to fix `SQLITE_BUSY_SNAPSHOT`. |
| **Effort / risk** | L for a sidecar.  M to keep tightening batches. |
| **Dependencies** | F1 (do not VACUUM / compact during a live ingest soak).  Worker still default-parked in some rollouts — confirm the live knob before load tests. |
| **Tracked** | #2715 closed.  Rollouts 2026-08-09/13/14.  #2165 still open for the broader SEC/RAG worker program. |

---

### F5 — Quote cascade still serves delayed Yahoo as a fallback

| Field | Detail |
|-------|--------|
| **Severity** | **P1** for opening orders when live broker quotes are down; **P2** after hours (intentional) |
| **Status** | Residual after #2714 / PR #2720.  Socket retry + 3-streak halt shipped.  Fallback remains. |
| **Evidence** | After all cascade levels, any symbol without a *fresh* quote gets the freshest quote of any age (`src/lib/quotes-cascade.ts:419-430`).  Yahoo `regularMarketTime` of ~900–1200 s is the “20-minute stale” report, not a 20-minute TTL.  Policy converts stale openings to limits; it does not block. |
| **Impact** | After Alpaca `UND_ERR_SOCKET` (even post-retry), Autopilot can size/limit off a delayed print.  Limits reduce chase risk.  They do not restore tape truth. |
| **Verify** | Fail Alpaca in a test harness; call `fetchFreshQuotesCascade`; inspect `provider` + `asOf`.  Live: compare proposal “Now” vs broker tape during an Alpaca blip. |
| **Fix** | Owner call: fail-closed openings when only fallback remains, **or** stamp “delayed fallback” on approval cards and keep current behavior.  Do not “fix” weekend/close fallback — that path is why the fallback exists. |
| **Effort / risk** | S–M.  Product/philosophy, not a missing retry. |
| **Dependencies** | Owner preference.  Conflicts with “do not paternalize” if implemented as a hard block without an off-switch. |
| **Tracked** | #2714 closed.  Residual documented in `docs/rollouts/2026-08-14-stale-quotes-origin-timeouts.md`. |

---

### F6 — Production auth fail-open if `AUTH_SECRET` and CF Access are both unset

| Field | Detail |
|-------|--------|
| **Severity** | **P1** (latent misconfig).  **Not** a finding against a correctly armed prod box. |
| **Status** | Latent.  Tests cover the armed path.  No production boot assert. |
| **Evidence** | `isAuthConfigured()` is `AUTH_SECRET` OR `CF_ACCESS_TRUST_EMAIL_HEADER` (`middleware.ts:165-167`).  If neither is set, every request becomes `PRIMARY_EMAIL` (`middleware.ts:384-388`).  Fail-closed 401 only runs when auth **is** configured and no identity is present (lines 413–418).  `instrumentation.ts` asserts `ENCRYPTION_KEY` in production, not `AUTH_SECRET`. |
| **Impact** | A Coolify/Infisical miss that drops `AUTH_SECRET` (and CF trust) maps the public internet to the primary operator: approvals, policy, broker actions. |
| **Verify** | Staging: unset both; `curl /api/dashboard` must not be 200.  Prod: confirm Infisical has `AUTH_SECRET`.  Do not unset prod to test. |
| **Fix** | In `NODE_ENV=production` or `DB_BOOTSTRAP=live`, refuse boot when `!isAuthConfigured()`.  Keep the local fallback for `next dev`. |
| **Effort / risk** | S / medium (must not break intentional local fallback). |
| **Dependencies** | Infisical `AUTH_SECRET` already present on a healthy prod. |
| **Tracked** | Partially — `test/middleware-auth.test.ts`, `docs/rollouts/2026-06-22-auth-m6.md`.  No open issue for a production boot guard. |

---

### F7 — Fill insert and portfolio snapshot are not one transaction

| Field | Detail |
|-------|--------|
| **Severity** | **P2** (P1 only if reconcile never runs and `broker_order_id` is missing) |
| **Status** | Deferred since 2026-06-21.  Partial idempotency exists. |
| **Evidence** | `insertFillEvent` is a single INSERT (`src/lib/db-fills.ts:248-277`).  `insertPortfolioSnapshot` is a separate INSERT (lines 89–134).  Migration 16 unique on `(proposal_id, broker_order_id)` is caught and returned (lines 278–290).  `UNIQUE(proposal_id, source)` was explicitly dropped (`docs/rollouts/2026-06-22-scheduler-cadence-rehydrate.md`). |
| **Impact** | Crash between the two writes desyncs P&L history vs positions.  Retry without `broker_order_id` can double-book.  Broker-held stops have a narrower unique index. |
| **Verify** | Grep paired call sites.  Fault-inject between the two inserts in a unit test.  Query duplicate fills sharing `proposal_id` with null `broker_order_id`. |
| **Fix** | Wrap the paired writes in `db.transaction(() => …).immediate()`.  Add a deliberate idempotency key after a dedup migration. |
| **Effort / risk** | M.  Money-path — needs fill/reconcile tests. |
| **Dependencies** | Reconcile sweeps (`placement-reconcile`, `pending-fill-reconcile`).  Do not add the dropped `(proposal_id, source)` unique without a dedup plan. |
| **Tracked** | Yes — `docs/rollouts/2026-06-21-persistence-safety-hardening.md`, `docs/reviews/2026-06-20-failure-mode-brainstorm.md`.  Closed issue #494 was a broader “write-queue over SQLite” proposal, not this pair. |

---

### F8 — Audit hash chain tip-read + insert is not transactional

| Field | Detail |
|-------|--------|
| **Severity** | **P2** |
| **Status** | Open.  Chain exists; concurrency does not. |
| **Evidence** | `audit()` reads the per-user tip, hashes, then INSERTs in a separate statement (`src/lib/db.ts:3410-3448`).  No `.immediate()` wrapper.  `verifyAuditChain` will report a fork (`prev_chain_hash` mismatch) if two writers read the same tip. |
| **Impact** | Tamper-evidence can fork under concurrent `audit()` (scheduler + request + ingest).  Forensics become noisy.  Does not change orders. |
| **Verify** | Concurrent `audit()` from two overlapping ticks; run `verifyAuditChain(userId)`. |
| **Fix** | Wrap tip read + insert in `database.transaction(() => …).immediate()`. |
| **Effort / risk** | S.  Audit volume is high; each tx is tiny. |
| **Dependencies** | None. |
| **Tracked** | Chain added in `docs/rollouts/2026-08-05-p0-security-audit-chain-decrypt.md`.  Concurrency not addressed.  Effort #2499 marks the P0 security batch completed. |

---

### F9 — Scheduler `tick()` has no whole-tick re-entrancy guard

| Field | Detail |
|-------|--------|
| **Severity** | **P2** |
| **Status** | Open.  Documented in the 2026-07-15 handoff.  Not fixed. |
| **Evidence** | `setInterval(tick, TICK_MS)` with `TICK_MS = 60_000` (`src/lib/scheduler.ts:56, 388-411`).  No `tickInFlight`.  SEC worker **does** have one (`src/lib/rag/sec-ingest-worker.ts:69-80`).  Money-path lanes have per-account locks (`MAX_CONCURRENCY = 3` at line 1023).  Fire-and-forget maintenance (`void journalLane(...)`) does not. |
| **Impact** | A tick that exceeds 60 s (multi-account LLM + broker I/O) overlaps the next tick.  Duplicate journal rows / web-source refreshes.  Not a double-place on the approve path (CAS + strategy lock). |
| **Verify** | Log tick duration.  `SELECT task_name, COUNT(*) FROM task_journal WHERE status='running' GROUP BY 1;` |
| **Fix** | `globalThis.__schedulerTickInFlight` coalesce (skip or run-once-more). |
| **Effort / risk** | S / low. |
| **Dependencies** | Complements F3 and F10. |
| **Tracked** | `docs/handoffs/2026-07-15-claude-to-monet-st-audit.md` §6b.8. |

---

### F10 — `task_journal` rows can remain `running` after a crash

| Field | Detail |
|-------|--------|
| **Severity** | **P2** (ops clarity).  Was P1 when ROIC stacked 714 walks — that pile-up is fixed. |
| **Status** | Residual after #2750. |
| **Evidence** | `journalLane` opens `running` and closes on settle (`src/lib/task-journal.ts:42-53`).  `pruneTaskJournal` deletes by age only (`src/lib/db-task-journal.ts:254-264`).  No stale-`running` sweep.  ROIC single-flight is process-local (`src/lib/web-sources/roic-transcripts.ts` `__roicTranscriptRefreshInFlight`). |
| **Impact** | Ops snapshot / task-brain over-counts `running`.  Misleading incident triage.  Not a second ROIC HTTP walk on one process. |
| **Verify** | SQL above.  Compare to `docs/rollouts/2026-08-16-roic-singleflight.md`. |
| **Fix** | Sweep `running` older than 2× max lane duration.  Optionally put ROIC under `withOperationLease(RAG_REINDEX)` for multi-process parity. |
| **Effort / risk** | S / low. |
| **Dependencies** | F2 (multi-process). |
| **Tracked** | #2746 / #2750 closed for the crash loop.  Journal hygiene not tracked. |

---

### F11 — `/api/health` does not fail the Docker HEALTHCHECK on a dead scheduler

| Field | Detail |
|-------|--------|
| **Severity** | **P2** (monitoring).  Deliberate, not an accident. |
| **Status** | By design vs `/api/ready`.  Easy to misread. |
| **Evidence** | Health sets `schedulerStale` after 5 minutes and keeps `ok` true (`app/api/health/route.ts:82-88`).  Trading liveness is degraded-only so a 503 cannot restart→re-halt autonomy (lines 113–118).  `/api/ready` **does** fail when autonomy is `active` / `close_only` / `liquidating` (`app/api/ready/route.ts:36-38`).  Dockerfile HEALTHCHECK uses `/api/health` with a **5 s** timeout (`Dockerfile:75-76`).  Sentry Crons are opt-in (`SENTRY_CRONS_ENABLED === "1"`, `src/lib/scheduler.ts:232-234`). |
| **Impact** | A wedged scheduler leaves the container “healthy.”  UptimeRobot stays green unless it parses `schedulerStale`.  Conversely, a slow health handler (credits fetch used to be 8 s) **can** fail the 5 s Docker check and restart the box. |
| **Verify** | Stop the timer in dev: health 200 + `schedulerStale: true`; ready 503 if autonomy is protective.  Confirm prod Sentry monitor or ops snapshot age. |
| **Fix** | Do **not** 503 health on stale ticks (restart loop).  Confirm an external probe on `schedulerAgeSeconds` or enable Sentry Crons.  Keep health handler budgets under 5 s (credits already 1.5 s after #2714). |
| **Effort / risk** | S ops. |
| **Dependencies** | UptimeRobot keyword monitors (credits-low pairing is a known trap). |
| **Tracked** | Health comments; `trading-liveness.ts` header; #2714 closed for the timeout stack. |

---

### F12 — Dual migration channels (`migrate()` tail + `MIGRATIONS`)

| Field | Detail |
|-------|--------|
| **Severity** | **P2** |
| **Status** | Structural debt.  Boot migrations themselves are safer after the 2026-08-12 IMMEDIATE hotfix. |
| **Evidence** | `getDb()` runs `migrate(db)` then `applyVersionedMigrations(db)` (`src/lib/db.ts:109-110`).  Versioned list is at **83** (`idea_sources_13f_ark_form4`).  `migrate()` still applies guarded `ALTER TABLE` / index adds on every boot.  `runMigrations` uses `BEGIN IMMEDIATE` after deploy `pyqxv16i` crash-looped on migration 72 (`src/lib/db.ts:3237-3247`; `test/db-migration-busy.test.ts`). |
| **Impact** | Agents add schema in the wrong channel.  Fresh vs existing DBs diverge.  Merge conflicts on `db.ts` remain the known split-vs-modified trap. |
| **Verify** | `getSchemaVersion()` vs last `MIGRATIONS` entry.  Grep `migrate()` tail for ALTERs not mirrored in `MIGRATIONS`. |
| **Fix** | Freeze `migrate()` as baseline-only.  CI assert no new ALTER outside `MIGRATIONS`. |
| **Effort / risk** | M.  Touches boot. |
| **Dependencies** | Every agent lane that edits `db.ts`. |
| **Tracked** | `docs/rollouts/2026-06-21-persistence-safety-hardening.md`, `docs/rollouts/2026-06-21-db-split-v2.md`. |

---

### F13 — In-process rate limits and caches reset on every deploy

| Field | Detail |
|-------|--------|
| **Severity** | **P2** |
| **Status** | Accepted single-box constraint.  Gaps on expensive routes. |
| **Evidence** | `src/lib/rate-limit.ts:1-11` — module `Map`, not distributed, fail-open on internal error.  `POST /api/strategy/run` has **no** `enforceRateLimit` (`app/api/strategy/run/route.ts:20-86`).  Dedup is one `queued`/`running` row per user (F3).  `/api/strategy/enable` also ungated.  Enrichment cache evicts **expired** keys only once size > 2000 (`src/lib/data-providers.ts:412-426`) — no LRU of live entries. |
| **Impact** | After restart, approve/scan burst windows reset.  A session can queue Run-once cheaply (202 + durable row) and burn LLM/broker.  Enable/disable autonomy can be hammered.  Heap can grow if >2000 symbols stay inside the 6 h TTL. |
| **Verify** | Loop `POST /api/strategy/run` — 202, no 429.  Hit approve 429, restart, burst again. |
| **Fix** | Add `enforceRateLimit` on `strategy/run` and `strategy/enable` (S).  LRU the enrichment map (S).  SQLite-backed limiter only if replicas are planned (L; they should not be). |
| **Effort / risk** | S for route limits. |
| **Dependencies** | F3 (stuck `running` already rate-limits the owner to zero). |
| **Tracked** | Rate-limit design: `docs/rollouts/2026-06-21-csrf-rate-limit-admin.md`.  Strategy-run gap not listed there. |

---

### F14 — Dashboard and strategy LLM deadlines do not abort the underlying fetch

| Field | Detail |
|-------|--------|
| **Severity** | **P2** |
| **Status** | By design after the 2026-07-06 IPv6-blackhole work.  Residual resource leak. |
| **Evidence** | `withDeadline` in `src/lib/dashboard.ts:108-114` races a fallback and **does not abort**.  `llmFetchCapturing` soft-times-out the caller while the fetch continues to `hardCapMs` default `max(2×soft, 300_000)` (`src/lib/llm-request.ts` ~438–459). |
| **Impact** | Hung broker/macro sockets and late LLM replies keep file descriptors and memory after the UI/tick has moved on.  Run lock is released on the soft path; the socket is not. |
| **Verify** | Throttle broker >6 s and poll dashboard.  Count handles.  Strategy: watch soft-timeout logs + late `onOutcome`. |
| **Fix** | Thread `AbortSignal` into broker/macro clients where the SDK allows.  Lower hard cap for non-reasoning models. |
| **Effort / risk** | M.  Must not break SDKs that ignore abort. |
| **Dependencies** | #2714 socket retry (already in). |
| **Tracked** | Dashboard comment + `docs/rollouts/2026-07-06-api-health-timeouts.md`. |

---

### F15 — Thin second-site DR and no automated VACUUM

| Field | Detail |
|-------|--------|
| **Severity** | **P2** |
| **Status** | Working as designed; shallow. |
| **Evidence** | R2 weekly `backup()` retain default **1** (`src/lib/r2-cold-snapshot.ts:59`).  Upload skips when R2 Class A budget >50%.  Audit prune frees pages but not file size without operator `VACUUM` (`src/lib/audit-prune.ts:18-20`; 2026-08-01: 493k audit rows / 718 MB).  `earningscalls_transcripts` is a global fetch-once cache with no `user_id` (`src/lib/db-earningscalls.ts:1-11`).  FTS + `chunk_occurrences` grow with ingest. |
| **Impact** | If B2 and the live volume both fail, R2 holds ~one weekly 4+ GB snapshot (up to ~2 weeks of loss).  A bloated DB makes every Litestream sync and deploy slower and raises lock contention (F4). |
| **Verify** | Health `checks.storage.r2Weekly`.  `PRAGMA page_count` vs `freelist_count`.  `SELECT COUNT(*), SUM(LENGTH(content)) FROM earningscalls_transcripts`. |
| **Fix** | Keep retain=1 unless R2 budget allows more.  Schedule VACUUM in a maintenance window with Litestream paused.  Corpus lifecycle per `docs/designs/2026-08-16-proposer-corpus-storage.md` (split writer → local hydrate → Infisical flip).  Do not flip write-class until FTS/ledger split exists. |
| **Effort / risk** | M ops for VACUUM.  L for corpus split. |
| **Dependencies** | F1 (do not VACUUM onto a wedged prefix).  #2760 design merged. |
| **Tracked** | `docs/rollouts/2026-08-08-r2-cold-snapshot.md`, `2026-08-02-storage-hygiene-execution.md`. |

---

### F16 — CSRF fail-open without browser origin signals; CSP default-off

| Field | Detail |
|-------|--------|
| **Severity** | **P2** CSRF (mitigated by SameSite + `Sec-Fetch-Site`).  **P3** CSP. |
| **Status** | Documented design. |
| **Evidence** | No Origin/Referer/`Sec-Fetch-Site` → CSRF `ok: true` (`src/lib/auth/csrf.ts:95-97`).  `cross-site` is rejected (lines 70–71).  Middleware applies CSRF to mutating `/api/*`.  CSP only when `CSP_ENABLED`; default report-only; policy includes `'unsafe-inline' 'unsafe-eval'` (`middleware.ts:124-159`). |
| **Impact** | Stolen session cookie + non-browser client can mutate without same-origin proof (intentional for curl/iOS).  Classic form CSRF from a modern browser is blocked.  XSS is not CSP-hardened in production unless the flag is on. |
| **Verify** | `test/csrf.test.ts`.  `curl -X POST` with session cookie, no Origin. |
| **Fix** | Optional double-submit token for browser sessions.  Collect CSP report-only, then nonce scripts. |
| **Effort / risk** | M / high for enforcing CSP (Next inline). |
| **Dependencies** | iOS/app clients that omit Origin. |
| **Tracked** | `docs/rollouts/2026-06-21-csrf-rate-limit-admin.md`. |

---

### F17 — Admin bearer and ops snapshot share a high-value secret surface

| Field | Detail |
|-------|--------|
| **Severity** | **P2** |
| **Status** | Working as designed; credential sensitivity. |
| **Evidence** | `/api/admin/*` with `x-admin-token` or Bearer bypasses session in middleware (`middleware.ts:401-404`); handlers use `timingSafeEqualStr`.  `OPS_DIAGNOSTIC_TOKEN` falls back to `ADMIN_REINDEX_TOKEN` (`src/lib/ops-auth.ts:17-23`).  `/api/ops/snapshot` walks every user, accounts, LLM models, runs, audit symbols (`src/lib/ops-snapshot.ts:307-325`).  Public `/api/health` still exposes scheduler age, dependency booleans, OpenRouter threshold (USD balances gated). |
| **Impact** | One leaked token is fleet-wide read (ops) or admin write.  Public health is reconnaissance, not a credential leak. |
| **Verify** | `scripts/fetch-prod-ops-snapshot.sh`.  Confirm Infisical has a distinct ops token. |
| **Fix** | Keep tokens distinct; rotate; log a service principal on token auth.  Do not put LLM keys in Infisical (already banned). |
| **Effort / risk** | S ops. |
| **Dependencies** | Cursor Cloud `OPS_DIAGNOSTIC_TOKEN` must match prod. |
| **Tracked** | `docs/rollouts/2026-06-29-ops-diagnostic-snapshot.md`. |

---

### F18 — Provider dispatch 2-minute lease vs long vendor calls

| Field | Detail |
|-------|--------|
| **Severity** | **P2** residual after #2771 |
| **Status** | Mislabel fixed.  Duration unchanged. |
| **Evidence** | `DEFAULT_PROVIDER_DISPATCH_LEASE_MS = 2 * 60_000` (`src/lib/db-provider-dispatch.ts:87-88`).  Lost lease is rethrown honestly in `vector-db.ts:1773-1780`.  Stale rows become `unknown` / `stale-owner-unresolved` and block account deletion until attestation (lines 509–521). |
| **Impact** | Deploy during a long Pinecone/rerank call: run retries, `unknown` dispatch rows, no vendor-outage page (after #2771). |
| **Verify** | Ops audit for `ProviderDispatchLeaseLostError`.  SQL `provider_dispatch_attempts WHERE status='unknown'`. |
| **Fix** | Only if recurrence is high: longer lease for known-slow writes, or settle inventory reads without an owner token. |
| **Effort / risk** | M (billing-truth path). |
| **Dependencies** | #2771 merged (`f75027c1` / later main). |
| **Tracked** | #2770 / #2771. |

---

### F19 — SSE and broker-read routes lack connection / read rate limits

| Field | Detail |
|-------|--------|
| **Severity** | **P3** |
| **Status** | Open, low urgency on a single-user prod box. |
| **Evidence** | `/api/events/stream` is one `ReadableStream` per GET, 25 s heartbeat, tenant filter, no max connections (`app/api/events/stream/route.ts:10-73`).  In-process bus (`src/lib/events.ts`).  `GET /api/orders` hits the broker with no `enforceRateLimit` (`app/api/orders/route.ts:8-14`).  Chat is JSON + 30/min, not SSE. |
| **Impact** | Authenticated FD/memory pressure; Alpaca list-order cost. |
| **Verify** | Open N EventSources.  Loop GET `/api/orders`. |
| **Fix** | Cap streams per `userId`.  Shared read limiter with quote/scan. |
| **Effort / risk** | S. |
| **Dependencies** | None. |
| **Tracked** | No. |

---

### F20 — `settings` KV and global caches are convention-scoped

| Field | Detail |
|-------|--------|
| **Severity** | **P2** for new features that stuff user state into `settings` without a user prefix |
| **Status** | Table-level isolation is strong.  KV is a footgun. |
| **Evidence** | Account write-fence triggers on `user_id` tables (`src/lib/db.ts:138-193`).  `getProposal` / `getConnectedAccount` use `id + user_id`.  `resolveRequestUserId` ignores body/query `userId`.  Scheduler lease and some locks live in `settings` (`src/lib/scheduler-lease.ts:3-4`; `strategy_run_lock:${userId}:${accountId}`).  Legacy global `policy` row still exists in comments/migration tail. |
| **Impact** | A new feature that writes secrets or policy to an unprefixed `settings` key leaks across users on the shared file.  Account deletion fences help during purge. |
| **Verify** | Grep `setInternalSetting` / settings INSERT.  IDOR suites: `test/request-user.test.ts`, `test/mobile-order-cancel.test.ts`, `test/middleware-auth.test.ts`. |
| **Fix** | Review rule: user-owned state → `user_settings` or embed `userId` in the key. |
| **Effort / risk** | Ongoing. |
| **Tracked** | `docs/rollouts/2026-06-21-per-user-policy-scoping.md`. |

---

### F21 — Health 503 on hard-stopped critical deps can restart-loop autonomy

| Field | Detail |
|-------|--------|
| **Severity** | **P2** |
| **Status** | Documented trade-off. |
| **Evidence** | Health 503s when DB fails or `pinecone` / `alpaca-broker` / `rag-embed` / `rag-rerank` hard-stop with no healthy lane (`app/api/health/route.ts` critical-deps path).  Trading liveness never 503s (F11).  Boot interlock re-halts autonomy unless `autoResumeOnBoot`. |
| **Impact** | Transient rag-embed failure → Docker HEALTHCHECK fail → restart → autonomy halted until the owner re-arms. |
| **Verify** | Force five rag-embed failures; watch health status + boot-halt audit. |
| **Fix** | Owner call: keep fail-closed (honest down) or degrade rag-embed like OpenRouter credits. |
| **Effort / risk** | S code; high ops semantics. |
| **Dependencies** | F11. |
| **Tracked** | Health route comments. |

---

### F22 — OpenRouter credits check fail-open on read errors

| Field | Detail |
|-------|--------|
| **Severity** | **P2** (observability) |
| **Status** | Intentional after #2714 killed timeout-induced false “credits low.” |
| **Evidence** | HTTP/network failure returns `ok: true` plus `error`, serving last cache (`src/lib/openrouter-credits.ts:85-90`).  Health wait budget 1.5 s. |
| **Impact** | A credits-API outage hides exhaustion.  Strategy fails with empty LLM bodies instead of a credits page. |
| **Verify** | Block `openrouter.ai/api/v1/credits`; health stays `ok` with `error` set. |
| **Fix** | Ops snapshot alert on `error` + stale cache age.  Do not 503 public health on this (keyword-monitor trap). |
| **Effort / risk** | S. |
| **Dependencies** | UptimeRobot pairing. |
| **Tracked** | #2714 closed. |

---

### F23 — `symbol_field_latest` is “right now,” not point-in-time

| Field | Detail |
|-------|--------|
| **Severity** | **P2** for eval/replay.  **P3** for the live desk (correct). |
| **Status** | Documented contract.  Live desk still omits `asOf` (STATUS 2026-08-16).  `VECTOR_ASOF_STRICT=on` in Infisical. |
| **Evidence** | `src/lib/db-fundamentals.ts:33-41` — only `getFundamentalAsOf` is PIT-safe.  Yahoo fallback and scan caches can make quote age opaque (F5, 5 min screener TTL in `src/lib/market.ts`). |
| **Impact** | Offline eval can leak restatements.  Production scan uses live data.  Strict ASOF does not help the desk if the client never sends `asOf`. |
| **Verify** | `test/symbol-field-latest.test.ts`.  Confirm live desk query params. |
| **Fix** | Route historical tools through `getFundamentalAsOf`.  Wire desk `asOf` if dated retrieval should apply to interactive scans. |
| **Effort / risk** | M. |
| **Dependencies** | Owner: desk `asOf` vs live-only. |
| **Tracked** | #2764 / `docs/rollouts/2026-08-16-asof-strict-on.md`. |

---

### F24 — Yahoo Level-4 cascade fans out unbounded `Promise.all`

| Field | Detail |
|-------|--------|
| **Severity** | **P3** |
| **Status** | Open. |
| **Evidence** | `src/lib/quotes-cascade.ts:343-345` maps every pending symbol in parallel.  Enrichment uses `CONCURRENCY = 5`. |
| **Impact** | Large illiquid leftovers can 429 Yahoo and blow the `/api/quote` 6 s budget. |
| **Verify** | Cascade 50+ missing symbols. |
| **Fix** | Chunk like enrichment. |
| **Effort / risk** | S. |
| **Dependencies** | F5. |
| **Tracked** | No. |

---

### F25 — Notifications have no durable outbox

| Field | Detail |
|-------|--------|
| **Severity** | **P3** |
| **Status** | Known. |
| **Evidence** | `notify()` retries in-process (`NOTIFY_RETRY_ATTEMPTS`, default 3).  No replay worker (unlike `usage-monitor-replay.ts`).  Scheduler fires some notifies fire-and-forget. |
| **Impact** | Deploy mid-push drops APNs/Pushover/email.  In-app `notification_events` still persist. |
| **Verify** | Grep failed channel audits.  No outbox table. |
| **Fix** | Reuse the usage-replay pattern for high-priority types. |
| **Effort / risk** | M. |
| **Dependencies** | APNs credentials (`APNS_*`). |
| **Tracked** | 2026-07-15 handoff §6b.9. |

---

### F26 — Next.js image is not `standalone`; health timeout is tight

| Field | Detail |
|-------|--------|
| **Severity** | **P3** |
| **Status** | Works.  Fragile under load. |
| **Evidence** | No `output: "standalone"` in `next.config.mjs`.  Image `COPY --from=build /app /app`, `CMD bash scripts/coolify-prod-start.sh`.  HEALTHCHECK timeout **5 s** vs health work that historically exceeded that (credits). |
| **Impact** | Larger image, slower deploys on a shared 16 GB box (`concurrent_builds=1`).  A future slow dependency on the health path restarts the trading process. |
| **Verify** | Time `curl -m 5 localhost:4000/api/health` under ingest. |
| **Fix** | Keep health budgets strict (already the rule).  Standalone output is optional and must not break `coolify-prod-start.sh` / Litestream `-exec`. |
| **Effort / risk** | M if changing the image contract. |
| **Dependencies** | F4, F11. |
| **Tracked** | Dockerfile comments (deploy 173 chown crash-loop). |

---

## 5. Strengths (do not “fix”)

| Area | Evidence |
|------|----------|
| **Identity** | CF Access JWT + JWKS + audience; Auth.js session; client identity headers stripped (`middleware.ts`, `src/lib/auth/strip-identity.ts`).  Fail-closed when armed. |
| **Money-path CAS** | `claimProposalForExecution` is `BEGIN IMMEDIATE` + `status='proposed'` (`src/lib/db-proposals.ts:530-608`).  `refId` persisted before broker call.  Alpaca `client_order_id`.  Reconcile sweeps. |
| **Single broker choke point** | Live preflight + order constraints + mutation lease (`src/lib/broker.ts`).  Cancels intentionally skip live preflight (risk-reducing). |
| **Execution philosophy** | `deriveExecutionState` has no fake-fill path (`src/lib/execution-mode.ts`).  Matches owner risk doctrine. |
| **Locks** | Strategy lock + heartbeat, account mutation lease, operation leases, provider dispatch owner tokens, SEC task leases, scheduler single-leader. |
| **Boot safety** | `reconcileAutonomyOnBoot`, `autoResumeOnBoot`, exit-guard retag 0→43, boot supervisor 40, no `npm run` in the container exec chain, IPv4-first DNS. |
| **Encryption** | Production refuses missing `ENCRYPTION_KEY`.  DB with encrypted creds fail-fasts in `getDb()`. |
| **Observability** | Multi-audience `/api/health`, Litestream empty-tier wedge, local-db-fault classifier (SQLite lock ≠ Pinecone), trading-liveness degraded-only, ops snapshot. |
| **Ingest hardening (2026-08)** | ROIC single-flight (#2750), SEC global claim cap 5 (#2749), FTS slice (#2715), Pinecone trial WU honesty (#2799), latest-first corpus (#2748). |
| **Tests** | Approval-lock, placement-reconcile, middleware-auth, CSRF, persistence-hardening, db-migration-busy, runtime-health, provider-dispatch-durability. |
| **CORS** | No `Access-Control-Allow-Origin` middleware.  Cookie APIs are same-origin. |

---

## 6. False alarms (do not re-open)

| Alarm | Reality |
|-------|---------|
| Unauthenticated mutating APIs / caller-picked `userId` | Fixed 2026-06.  `resolveRequestUserId` ignores body/query. |
| Non-atomic approve / double `placeEquityOrder` | `claimProposalForExecution` CAS + IMMEDIATE. |
| Local Test simulator / default `paperMode` | Removed 2026-07-03.  Blueprint doc is historical. |
| Scheduler auto-starts from a copied DB | `reconcileAutonomyOnBoot` + optional `autoResumeOnBoot`. |
| “Single-leader defaults OFF” | Defaults **ON** unless explicit `false/off/0/no`. |
| “20-minute quote cache” | Yahoo delayed `regularMarketTime` via cascade **fallback** (#2714). |
| “Pinecone connection failed” during deploy | Often `ProviderDispatchLeaseLostError` or local `SQLITE_BUSY` (#2771, `local-db-fault.ts`). |
| ROIC stacking every 60 s / 714 journal rows | Fixed #2750. |
| SEC worker 5 × N running jobs | Global remaining budget of 5 (#2749). |
| Manual run-once lost on restart | Durable 202 + `strategy_run_requests`.  Residual is F3 (stuck `running`). |
| Health 503 on stale scheduler | Only `/api/ready` when autonomy is protective. |
| Litestream “healthy” because L0 is fresh | Empty-tier wedge detection (#2709).  Compaction still broken (F1). |
| One Alpaca `fetch failed` halts Autopilot | Now 3-streak (`BROKER_CONNECTIVITY_HALT_STREAK = 3`). |
| `ALLOW_LIVE_TRADING` default ON | Owner doctrine.  Environment + typed live confirm are the gates. |
| `broker_mutation_unleased` still places | Advisory backstop, not a block. |
| Public `/api/health` | Required for UptimeRobot.  Sensitive fields token-gated. |
| Chat is not SSE | Chat is JSON; desk events are SSE. |
| No connection pool | Correct for SQLite + one writer. |
| `synchronous=NORMAL` | WAL pairing.  RPO is Litestream 60 s, not fsync-every-commit. |
| Global `earningscalls_transcripts` | Shared market data by design. |
| R2 kill-switch pausing backup | Applies to R2 replica; B2 active replica ignores the marker. |
| FilingAPI 401 on public health | Retired on `main` (#2787 / #2799 follow-ons).  Ignore leftover PRs that keep it. |
| June 2026 “zero tests for strategy/brokers/db” | Stale.  Thousands of vitest cases now cover those modules. |
| `docs/architecture-blueprint.md` tri-state | Superseded.  Do not implement Test mode from it. |

---

## 7. Issue / PR cross-check (2026-08-17)

Queried via `gh` (GitHub MCP was down in this environment).

| ID | State | Relevance |
|----|-------|-----------|
| **#2709** | Merged | Litestream empty-tier **detection**.  Root cause still owner (F1). |
| **#2697** / effort **#2776** | Open | “Fix ST Litestream wedge + prefer Pushover.”  Same F1 ops work. |
| **#2714** / **#2720** | Closed / merged | Stale quotes + origin timeouts.  Residual F5. |
| **#2715** / **#2719** | Closed / merged | FTS bound.  Residual F4. |
| **#2746** / **#2750** | Closed / merged | ROIC pile-up.  Residual F10. |
| **#2748** / **#2749** / **#2751** | Merged | WU fuse, worker cap 5, money-path ingest. |
| **#2770** / **#2771** | Merged into later main | Lease-lost mislabel.  Residual F18. |
| **#2799** | Merged at HEAD | Pinecone trial ≠ Starter 2M monthly wall. |
| **#2713** | Historical | R2 weekly on health — treat as landed if `checks.storage.r2Weekly` exists on `main`. |
| **#2165** | Open | SEC/RAG worker program.  Overlaps F4, not a duplicate of this audit. |
| **#2545** / PR **#2796** | Open | Deploy-pipeline freeze / OCR isolation.  Shared-box, not SQLite. |
| **#2550** / PR **#2797** | Open | CT/UM lane backoff.  Peer latency, not this process. |
| **#2576** | Open | Robinhood MCP extra properties.  Broker adapter, not architecture core. |
| **#494** | Closed | “Repository layer + write-queue over SQLite.”  Do not revive as the F4 fix without a new design. |
| **#2499** | Effort completed | P0 security batch (audit chain, decrypt).  F8 is the leftover concurrency gap. |
| Open PRs **#2792–#2800** | In flight | FilingAPI / favicon / a11y / Pinecone 15-WU remainder.  None supersede F3. |

Do **not** file a new GitHub issue that restates F1, F5 (as “20-minute cache”), F4 (as “unbounded FTS”), or ROIC stacking.

---

## 8. Recommended sequence

1. **Owner ops (F1, F2):** Confirm Coolify still non-rolling.  Repair B2 L1 contiguity when authorized.  Confirm one live replica and no Mac `pm2 trading`.
2. **Small code (F3, F8, F9, F13 run/enable limits):** Stale `strategy_run_requests` sweep; transactional `audit()`; tick coalesce; rate-limit Run-once / enable.  Independent of Litestream.
3. **Product call (F5, F6, F21):** Delayed-quote fail-closed vs annotate; production auth boot guard; health 503 vs degrade for rag-embed.
4. **Money-path hygiene (F7):** Fill + snapshot one transaction + idempotency key.  Test-heavy.
5. **Do not start:** Postgres migration, connection pool, second Coolify replica, Litestream 0.5.14, write-queue rewrite (#494), Test-mode resurrection.

---

## 9. Verification commands

```bash
# Code baseline
git rev-parse HEAD   # expect 4980322b… on the audited main; this PR is docs-only on top

# Focused regression packs (do not claim the full suite from this docs PR)
npx vitest run test/db-migration-busy.test.ts test/persistence-hardening.test.ts \
  test/runtime-health.test.ts test/middleware-auth.test.ts test/csrf.test.ts \
  test/approval-lock.test.ts test/placement-reconcile.test.ts \
  test/provider-dispatch-durability.test.ts test/local-db-fault-classification.test.ts \
  test/sec-ingest-worker.test.ts test/strategy-run-once-async-route.test.ts

# Public health shape (no secrets)
curl -sS https://socratictrade.com/api/health \
  | jq '{ok, checks:{db:.checks.db, schedulerAgeSeconds, schedulerStale, storage:.checks.storage}}'

# Prod ops (needs OPS_DIAGNOSTIC_TOKEN in the environment)
bash scripts/fetch-prod-ops-snapshot.sh

# Local SQL (dev db only — never the live volume)
sqlite3 data/app.db "SELECT status, COUNT(*) FROM strategy_run_requests GROUP BY status;"
sqlite3 data/app.db "SELECT status, COUNT(*) FROM sec_ingest_jobs GROUP BY status;"
sqlite3 data/app.db "SELECT task_name, status, COUNT(*) FROM task_journal WHERE status='running' GROUP BY 1,2;"
```

This audit did **not** run `npm run build` or the full vitest suite.  It is docs-only.  Commands above are the intended verification set for a follow-up implementation PR.

---

## 10. Priority table

| Sev | IDs | Theme |
|-----|-----|--------|
| **P0** | F2 (conditional) | Second live writer / second Litestream writer |
| **P1** | F1, F3, F4, F5, F6 | DR wedge; stuck Run-once; event-loop/SQLite; delayed quotes; auth misconfig |
| **P2** | F7–F18, F20–F23 | Transactions, tick overlap, health semantics, migrations, caches, CSRF/ops tokens, PIT |
| **P3** | F19, F24–F26 | SSE/read limits, Yahoo fanout, notify outbox, image/health timeout |

---

*Read-only audit.  No product code was changed.  Supporting handoff: `docs/rollouts/2026-08-17-architecture-backend-audit.md`.*
