# 2026-09-24 — Strategy Run Halt And Restart Resilience (Lane B `st-run-resilience`)

Seat CLAUDE, board `687a5fb4`, branch `claude/st-run-resilience`.

## 1. Context & Objective

Production, Alpaca Paper, last 50 strategy runs (2026-09-22 13:39Z → 09-24 19:20Z): only 14
completed.  23 were `skipped_broker_unhealthy` — 21x "Broker cannot place orders — autonomous
strategy auto-paused: Broker health check timed out: checkBrokerHealth timeout" and 2x "Broker
connectivity failure: Timed out waiting for alpaca.getAccount after 16000+8000ms." — and 11 were
"Process restarted mid-run — marked failed by stale-run sweep".  The timeouts coincide with RTH
event-loop stalls (the process was frozen, not Alpaca), and operators restart the container about
every 20 minutes during those stalls.  Objective: stop first-strike halts on probe timeouts, stop
blaming the broker for a frozen process, make sure pauses lift (auto) or stick (owner) correctly,
and give a restart-killed run that provably placed nothing exactly one retry.

## 2. Changes Made

**Root cause (halts).**  `applyBrokerOrderPlacementPause` only applied the
`BROKER_CONNECTIVITY_HALT_STREAK = 3` gate when `isTransientNetworkError(reason)` matched, and that
classifier matches socket tokens (`fetch failed`, `ECONNRESET`, …), not the prose "timed out".  Both
production timeout shapes therefore auto-halted Autopilot on the FIRST occurrence, fired a
kill-switch notification, and auto-resumed a tick later — 21 flaps in two days.  The scheduler also
wrapped the probe in a plain `withDeadline`, so the expiry could not say whether the 30s went to
Alpaca or to a pinned event loop.

**Root cause (restarts).**  `markStaleRunningRuns` marked restart-killed runs failed and nothing
re-queued them.  Worse, its audit-activity grace counted rows the DEAD process wrote before this
process booted, holding every killed run in `running` for up to 30 more minutes — by which time the
next cadence run had started, so the lost run could never be retried anyway.

- **Structural timeout flag.**  `withDeadline` and `awaitWithFirstCallRetry` (final timeout) now tag
  the error they manufacture with `__deadlineTimeout` (`markDeadlineTimeout` /
  `isDeadlineTimeoutError`).  `checkBrokerHealth` sets `HealthSignals.probeTimedOut` from that flag
  (plus the lane-expiry marker and AbortError/TimeoutError by name) — no prose regex, and
  `isTransientNetworkError` is NOT widened (GROK lesson 2026-09-18).
- **Streak for timeouts.**  `applyBrokerOrderPlacementPause` counts `probeTimedOut` toward the same
  3-in-a-row streak as a dead socket.  A healthy probe still resets it.
- **Process-stall attribution.**  The scheduler probe now uses `withLaneDeadline` (lane
  `broker-health-probe`), and `checkBrokerHealth` measures its own window with the lag sampler.
  When ≥75% of a timed-out probe window was event-loop stall (`PROBE_STALL_ATTRIBUTION_RATIO`, pinned
  equal to `LANE_STALL_ATTRIBUTION_RATIO` by a test), the health signal carries `processStall` and
  the reason "App process was stalled (event loop blocked Xs of Ys); broker not at fault".  The tick
  skips its strategy launch, the streak is neither incremented nor reset, and an audit row
  `broker_health_probe_process_stalled` plus the `broker-health-gate` journal row record it.  An
  in-run stalled probe finishes the run as the generic `skipped` (audit `run_skipped_process_stalled`)
  instead of `skipped_broker_unhealthy`.  No new run status was added (see Decisions).
- **Pause ownership.**  `applyBrokerOrderPlacementPause` now decides against the durable policy,
  re-read right before it writes, and writes only `systemState`.  Before, it decided on the caller's
  snapshot (read before a probe of up to 30s) and persisted the whole snapshot: an owner Pause that
  landed mid-probe was claimed as an auto-pause (and later auto-resumed), any setting the owner
  edited in that window was reverted, and a Manual Run once could persist its run-scoped
  `strategyAuthority: "propose"`.  New `releaseBrokerPlacementPauseToOwner` drops the auto-resume
  marker when the owner pauses (`/api/strategy/pause`, mobile `strategy.stop`) and at the boot
  interlock when `autoResumeOnBoot` is off, so an owner halt is never auto-lifted.
- **Broker-lane ceiling reconciled.**  `SCHEDULER_BROKER_TIMEOUT_MS` was 15s, below the 16s first
  wait of the Alpaca reads it wraps.  It is now first+retry+6s = 30s (same as the inner broker I/O
  deadline and the health probe).  The awaited material-event drain keeps its own 15s
  (`MATERIAL_EVENT_DRAIN_TIMEOUT_MS`) so tick latency does not grow.
- **One-time restart retry.**  `sweepStaleRunningRuns` returns the restart-killed rows it
  transitioned; new `src/lib/strategy-run-retry.ts` queues ONE `strategy_run_requests` row for the
  killed run's account when all hold: scheduler-launched run (no request row — never a Manual Run
  once, never a retry), no `trade_proposals` / `fill_events` / `socratic_decisions` rows for the run,
  no run-scoped trigger override, no live lease, account `active`, session open
  (`isRunAllowedNow`), no newer or running run on the account, no open request for the user.  Pre-boot
  runs now only get the audit-activity grace for rows written since this process booted.  Migration
  92 adds `strategy_run_requests.connected_account_id` + `retry_of_run_id` with a partial UNIQUE
  index (at most one retry per killed run).  The drain runs a retry non-manually on that account,
  re-validates it first (10-minute max queue age), and never adopts a retry interrupted by another
  restart.  Receipts: `strategy_run_retry_enqueued` / `_skipped` / `_dropped`.

Files:

- `src/lib/inflight-deadline.ts`
- `src/lib/execution-mode.ts` (two optional `HealthSignals` fields)
- `src/lib/broker-health.ts`
- `src/lib/scheduler.ts`
- `src/lib/safety-maintenance.ts`
- `src/lib/db-execution.ts`
- `src/lib/db.ts` (migration 92)
- `src/lib/strategy-run-retry.ts` (new)
- `src/lib/strategy-run-requests.ts`
- `src/lib/strategy.ts` (in-run skip branch only, ~6 lines — shared C/D file, kept minimal)
- `src/lib/mobile-api.ts` (release marker on `strategy.stop`)
- `app/api/strategy/pause/route.ts`
- `test/broker-health-probe-resilience.test.ts` (new, 16 cases)
- `test/strategy-run-restart-retry.test.ts` (new, 14 cases)
- `test/scheduler-leader-heartbeat.test.ts` (mock the new sweep entry point)
- `test/persistence-hardening.test.ts` (schema version 91 → 92)
- `STATUS.md`, `docs/EFFORT-LOG.md`, this note
- `node_modules` tracked symlink removed from the index (`git rm --cached`), committed by
  accident in b583b2c65 (#3452); `.gitignore` already ignores it.

## 3. Decisions & Trade-offs

- **No new run status.**  iOS decodes `StrategyRunItem.status` as a plain `String` (no strict enum,
  so no decode failure), but `ActivityView.swift` maps unknown statuses to "Completed" with the
  positive color.  A `skipped_process_stalled` status would render as a green "Completed" on the
  shipped app.  The generic `skipped` renders "Skipped" everywhere; the audit kind carries the
  distinction.  The scheduler-gate stall skip writes no `strategy_runs` row (same as every
  non-halting gate skip — the cadence is not advanced, so the next tick launches).
- **Retry disables on ANY proposal/fill/decision row**, stricter than "placed": a `proposed` row
  awaiting approval would otherwise be duplicated by the retry.
- **No broker-side order listing before a retry.**  Strategy placement persists the `placing`
  trade_proposals row (run_id + refId = clientOrderId) BEFORE the broker call and skips the call if
  that insert fails, so "zero proposal rows" already proves the run never called `placeEquityOrder`.
  refIds are random UUIDs, not run-prefixed, so a by-run broker listing is not possible without
  changing the refId format in the placement path (lanes C/D).
- **Manual and API-requested runs are never retried** — owner-initiated work stays owner-initiated,
  and a propose-only manual run must not come back as an autonomous one.
- **Queue interplay.**  `queueStrategyRunRequest` dedupes per user, so a Manual Run once click while a
  retry is queued (at most one tick) is deduped onto the retry.  Accepted: short window, and it keeps
  the queue single-flight per user.
- **Migration version 92.**  Parallel lanes that add a migration will conflict textually at the end of
  `MIGRATIONS`; the later lander renumbers.
- **Broker-lane ceiling 15s → 30s** lengthens the worst case of the awaited in-run maintenance pass,
  deliberately: the pass now waits for a read that is still legitimately retrying instead of racing
  ahead of it.  The void scheduler lanes only change attribution.

## 4. Verification State

Host load average was 400–700 during this session (parallel lanes), so wall-clock numbers are
inflated.

- `npx vitest run test/broker-health-probe-resilience.test.ts` — 16 passed.
- `npx vitest run test/strategy-run-restart-retry.test.ts` — 14 passed.
- Regression proof: with the two core fixes reverted in place (streak condition, pre-boot activity
  floor), "does not halt on the first alpaca.getAccount timeout", "does not halt on the first
  scheduler probe-deadline expiry", and "sweeps a pre-boot run promptly…" fail; restored, they pass.
- Related suites (broker-health-auto-pause, transient-network-resilience, stale-running-runs,
  stale-running-runs-adoption-grace, scheduler-boot-halt-notify, route-strategy-pause,
  scheduler-lane-observability, scheduler-stale-exit-inflight-guard, broker-io-deadlines,
  inflight-deadline, persistence-hardening, strategy-run-drain-handoff, mobile-api,
  strategy-run-status, scheduler-tick-reentrancy, scheduler-leader-heartbeat) — green after pointing
  the heartbeat test's mock at `sweepStaleRunsAndRetry`.
- `npx tsc --noEmit` clean; eslint on changed files 0 errors.
- Full gate (`npm run lint` → `npx tsc --noEmit` → `npm test` → `npm run build`): see the PR body.

## 5. Next Steps & Blockers

- Money-path adjacent: lead runs the adversarial review before arming auto-merge.
- After deploy, watch `audit_events` for `broker_health_probe_process_stalled`,
  `strategy_run_retry_enqueued` / `_skipped` / `_dropped`, and `broker_placement_auto_halted` with
  `probeTimedOut` — the auto-halt count should fall to real three-in-a-row outages.
- Lane A (event-loop stall profiler) owns the stall itself; this lane only stops misattributing it.

## 6. Zero-Code Findings

- The brief's pointer `safety-maintenance.ts:271-317` is actually `broker-health.ts` (the streak
  logic); `safety-maintenance.ts` holds `withLaneDeadline` and the lane ceiling.
- iOS (`ios/SocraticTrade/MobileModels.swift`, `ActivityView.swift`) decodes run status as `String`
  and defaults unknown values to "Completed" — any future new run status needs an iOS release first.
- The web console hides "Stop Agent" while an account is halted, so an owner cannot convert an
  auto-pause to a manual halt from the console; the API and mobile `strategy.stop` can, and now do.
