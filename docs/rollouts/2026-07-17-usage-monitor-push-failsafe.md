# 2026-07-17 - usage-monitor-push-failsafe

## Summary

Added a proper circuit breaker in front of every real network attempt to the API Usage Monitor
(`usage.jays.services`) and bounded the in-memory failure-retry buffer, so a receiver outage can
neither be hammered nor grow ST's own memory without limit. No change to what telemetry is sent
(event shape, `sourceApp`/`project`/`provider`/pricing fields) or to the security posture (bearer
token, base URL config) — delivery/retry behavior only.

## Why

Owner-directed incident response: `usage.jays.services` (API-usage-monitor) was OOM-down for ~2
days. Both Congress.Trade and Socratic-Trade kept pushing telemetry to the dead endpoint (~35
req/s of ~70KB POSTs aggregate across both apps) and ran up a 200GB Render bandwidth overage on
the receiver side. This change is the Socratic-Trade side of the fix (a companion agent handles
Congress.Trade).

Investigation of `src/lib/usage-monitor-push.ts` found the live-push flush loop already had a
capped exponential retry (`Math.min(60_000, flushDelayMs() * 2 ** retryAttempt)`), but two gaps
remained:

1. It was a retry-delay, not a true circuit breaker — it never fully suppressed an attempt, it
   just spaced them up to 60s apart, forever, with no distinction between "still trying" and
   "confirmed dead, back off harder."
2. `usage-monitor-replay.ts` (the crash-durable DB-backed replay lane added in PR #1563 / #1596)
   calls `sendUsageMonitorBatch` directly on its own fixed 60s interval, independent of the live
   queue's backoff — during an outage this alone is 3 network attempts every 60s (llm/rag/
   provider-dispatch lanes), on top of the live queue's own attempts, run independently by every
   ST process (dev + prod) with real monitor credentials configured. That's the second, separate
   hammer that a live-queue-only backoff couldn't stop.
3. The live queue's own failure-retry buffer (`state.queue`, entries retained after a failed
   `postBatch`) was unbounded — a multi-day outage combined with ongoing LLM/RAG/broker-balance
   activity would grow it without limit.

## Design

**Circuit breaker** (`src/lib/usage-monitor-push.ts`): a single breaker (`state.breaker`:
`consecutiveFailures`, `openUntil` epoch ms, `probing` flag) shared by both real network call
sites — `postBatch` (live queue flush) and `sendUsageMonitorBatch` (durable replay). Every call
site is gated by `breakerAllowsAttempt()` immediately before constructing the request:

- Closed (`openUntil === 0`): attempts proceed normally.
- After `USAGE_MONITOR_BREAKER_THRESHOLD` (default 3) consecutive failures across *either* lane,
  the circuit opens for `USAGE_MONITOR_BREAKER_BASE_MS` (default 30s), doubling per additional
  failure and capped at `USAGE_MONITOR_BREAKER_MAX_MS` (default 15 min).
- While open, `breakerAllowsAttempt` returns `false` with **no fetch call at all** — this is what
  stops replay's fixed 60s interval from turning into a continuous probe: the timer still fires,
  but the network call itself is skipped.
- Once the window elapses, exactly one concurrent caller is let through as a half-open probe
  (`probing` flag prevents a second simultaneous probe from live-push and replay racing at the
  exact expiry moment). Success fully closes the circuit (`consecutiveFailures = 0`); failure
  reopens it with the next backoff step.
- The live queue's own retry scheduling (`flushUsageMonitor`) now derives its next-attempt delay
  from `state.breaker.openUntil` instead of a separate `retryAttempt` counter (removed) — the two
  mechanisms are unified into one.

**Bounded failure buffer**: `state.queue` (post-failure retained events) and `state.pendingQueue`
(not-yet-attempted events) are trimmed on every push and every failed flush via
`trimBufferedEvents()`:
- TTL: entries older than `USAGE_MONITOR_QUEUE_TTL_MS` (default 1h) are dropped, keyed off
  **buffer residency time** (`receivedAt`, set when the item entered the in-memory buffer), not
  the event's own business `occurredAt` — a replayed/backfilled event can legitimately carry an
  old `occurredAt` and must not look stale on arrival (this was caught by a test regression during
  implementation — see Verification).
- Cap: total buffered events beyond `USAGE_MONITOR_QUEUE_MAX_EVENTS` (default 500) are dropped,
  oldest-failed-retries first, then oldest not-yet-attempted.
- This is safe to trim aggressively: LLM/RAG/provider-dispatch events dropped here are still
  recoverable — `usage-monitor-replay.ts` redelivers them independently from the durable DB
  ledgers (`llm_usage`, `rag_usage`, `provider_usage_outbox`) regardless of what this fast-path,
  in-memory buffer holds. Only ephemeral broker-balance snapshots (`pushBrokerBalance`) have no DB
  backstop, and losing a stale one is harmless — the next portfolio fetch pushes a fresh reading.

**User-facing path**: unchanged and confirmed non-blocking. `pushLlmUsage`, `pushRagUsage`,
`pushBrokerBalance`, and `recordProviderCall` (the hot-path call in `data-providers.ts`'s
`fetchWithRetry`) are synchronous, non-throwing functions that only mutate in-memory state and
schedule an unref'd timer — they never awaited network I/O before this change and still don't.
Added an explicit test that proves this even while the breaker is open (swaps in a fetch stub
that never resolves and asserts the ledger call sites return in <20ms and the stub is never
actually invoked).

All five new thresholds are env-overridable with a one-line comment each:
`USAGE_MONITOR_BREAKER_THRESHOLD`, `USAGE_MONITOR_BREAKER_BASE_MS`,
`USAGE_MONITOR_BREAKER_MAX_MS`, `USAGE_MONITOR_QUEUE_MAX_EVENTS`, `USAGE_MONITOR_QUEUE_TTL_MS`.

## Files

- `src/lib/usage-monitor-push.ts` — breaker + bounded buffer; `postBatch` and
  `sendUsageMonitorBatch` both gated; `flushUsageMonitor` retry scheduling now breaker-driven;
  removed the old standalone `retryAttempt` counter; new test seam
  `__usageMonitorDebugState()`.
- `test/usage-monitor-push.test.ts` — 6 new tests: breaker opens + suppresses, half-open
  recovery, user-path non-blocking proof, buffer cap, TTL-by-residency, TTL-does-not-key-off-
  business-occurredAt regression.
- `test/usage-monitor-replay.test.ts` — 1 new test proving the breaker is shared: tripping it via
  the live-push lane suppresses a subsequent replay attempt with zero network calls.

No changes to `src/lib/usage-monitor-replay.ts`, event schema/shape, or any call site
(`data-providers.ts`, `alpaca.ts`, `robinhood.ts`, `llm-usage.ts`, `rag-metering.ts`).

## Review round (codex-connector on PR #1711, 4 findings — all addressed)

1. **[P1] Live push had no per-attempt timeout.** A monitor that accepts the TCP connection but
   never responds would leave `postBatch`'s `client.send` awaiting forever — the attempt never
   records a failure, so the breaker never trips and the queue never drains: exactly the half-up
   prod outage. FIXED: `postBatch` now wraps the send in an `AbortController` timeout
   (`USAGE_MONITOR_PUSH_TIMEOUT_MS`, default 10s), converting a hang into a recorded failure that
   feeds the breaker. Mirrors the replay lane's existing `REPLAY_SEND_TIMEOUT_MS`. New test drives
   a fetch that only settles on abort and asserts the flush returns bounded, the breaker records
   the failure, and it trips.
2. **[P2] `callVolume` aggregation map was unbounded.** The queue cap only bounded
   `pendingQueue`+`queue`; `callVolume` (keyed by provider/service/keySource/userId) is drained
   each flush, but while the breaker is open the next flush can be up to `breakerMaxMs` away, so
   high-cardinality per-user keys could accumulate for that whole window. FIXED: `recordProviderCall`
   caps distinct lanes at `USAGE_MONITOR_CALLVOLUME_MAX_KEYS` (default 2000), evicting
   oldest-inserted lanes (Map insertion order) to make room. New distinct-key-count test.
3. **[P2] TTL only trimmed on enqueue / failed flush.** An event could age past its TTL while
   sitting in the buffer with no new telemetry arriving, and still reach the send path. FIXED:
   `flushUsageMonitor` now calls `trimBufferedEvents` at flush entry. New test: a lone event past
   its TTL is dropped by the flush itself, with no intervening push.
4. **[P2] HMR could retain the old queue shape.** `queue` entries changed from raw
   `UsageMonitorEvent` to the `{ event, receivedAt }` wrapper (and `pendingQueue` gained
   `receivedAt`), but `STATE_VERSION` wasn't bumped, so a hot-reload from the pre-change module
   would feed old-shape entries into the new flush path. FIXED: bumped `STATE_VERSION` 3→4 and
   added `normalizeRetainedQueues()`, which coerces any retained raw-event / receivedAt-less entry
   into the current wrapper shape on adoption (dev-only concern, cheap to make safe). New test
   seeds a pre-v4 raw-event `queue` + receivedAt-less `pendingQueue`, reloads the module, and
   asserts both flush cleanly.

## Review round 2 (codex-connector on PR #1711, 1 finding — observability truthfulness)

**[P2] The replay lane didn't record `usage-monitor` health, so the admin health row could lie.**
Only `postBatch` (the live-push lane) wrote `logApiHealth({ service: "usage-monitor", ... })`. If
the durable-replay worker (`sendUsageMonitorBatch`) was the FIRST lane to hit a down monitor, its
failure opened the shared breaker WITHOUT recording a health failure — and then every later
live-push flush was suppressed by the now-open breaker before `postBatch` ever ran, so the admin
connections-health row stayed "healthy"/stale for the entire backoff window while the monitor was
actually down. That is the same class of stale-observability bug this whole incident was about.
FIXED: factored the health write into a shared `recordUsageMonitorHealth(ok, startedAt, err?)`
helper (best-effort, never throws — `logApiHealth` already swallows its own errors, and the helper
adds a defensive guard so it can never break a fire-and-forget caller). BOTH lanes now call it —
`postBatch` and `sendUsageMonitorBatch` — on success (recovery) and failure, recorded before the
shared breaker update to mirror `postBatch`'s existing ordering. `sendUsageMonitorBatch` gained an
error binding (`catch (err)`) so the failure's `errorText` is preserved. New test
(`usage-monitor-replay.test.ts`): a replay-lane failure records a `usage-monitor` health FAILURE
row (`ok = 0`, not just a breaker trip), and a subsequent replay success records recovery
(`ok = 1`). No change to what telemetry is sent or the breaker/buffer behavior.

## Review round 3 (codex-connector on PR #1711, 1 finding — breaker correctness)

**[P2] A schema-INVALID local event falsely tripped the shared breaker.** The shared client's
`send` calls `UsageTelemetryBatchSchema.parse` synchronously BEFORE any fetch, so a schema-invalid
event throws a ZodError with zero receiver contact. `pushBrokerBalance` admitted `NaN`/`Infinity`
via `typeof x === "number"` (both are `"number"`), the schema's `.finite()` rejects them, and both
`postBatch` and `sendUsageMonitorBatch` caught that pre-fetch ZodError and called
`breakerRecordResult(false)` — so a repeated poison event kept incrementing the breaker until it
falsely OPENED and suppressed valid live + replay telemetry for the backoff window. A local
bad-data error must never be read as "receiver down". FIXED, belt and suspenders:

- **Admission guard (belt):** `pushBrokerBalance` now gates `cash`/`buyingPower`/`equity` on
  `Number.isFinite(...)` instead of `typeof === "number"`, so a NaN/Infinity reading never enters
  the buffer in the first place.
- **Pre-send prune (suspenders):** the shared client does NOT surface a typed validation-vs-delivery
  error (both the pre-fetch batch parse and a garbage-response parse throw), so rather than guess
  from the error, both send paths now validate/prune the batch themselves via `isDeliverableEvent`
  (`UsageTelemetryEventSchema.safeParse(...).success`) BEFORE `client.send`. In the live path,
  `flushUsageMonitor` partitions poison OUT of the buffer (dropped, best-effort `console.warn`, never
  re-queued) so it can't re-fail forever; only valid events reach `postBatch`/the breaker. In the
  replay path, `sendUsageMonitorBatch` drops poison and returns `true` when nothing valid remains, so
  the durable caller advances its watermark past the bad row (quarantine) instead of re-failing it.
  The breaker now only ever sees genuine delivery outcomes (network error / timeout / non-2xx).

New tests: a NaN/Infinity broker balance is rejected at admission (never buffered); a poison event
injected into the buffer is dropped at flush WITHOUT tripping the breaker while the valid event in
the same batch still sends; a genuine receiver failure still trips the breaker; and (replay lane) an
all-poison batch is acked (`true`, watermark can advance) without receiver contact or a breaker trip.

## Review round 4 (codex-connector on PR #1711, 1 finding — bound the hung-receiver burst)

**[P2] A hung receiver could accumulate a burst of concurrent hanging POSTs before the breaker
opened.** The timer callback clears `state.flushTimer` before calling `flushUsageMonitor`, so while
a live flush was awaiting its (up to 10s) timeout send, telemetry enqueued in the meantime armed
MORE flush timers on the 2s cadence — each starting another concurrent hanging POST to the dead
receiver. The breaker only protects AFTER those sends' failures register, so several simultaneous
hanging requests could pile up in that window. FIXED (single-flight): the SEND is now serialized via
`state.inflightFlush`. `flushUsageMonitor` became a thin wrapper — if a flush is already in flight it
does NOT start a second concurrent send; it re-arms the timer (defer) so events buffered in the
meantime are picked up once the current send settles, and clears the marker in `finally`. The actual
flush body moved to a private `flushUsageMonitorOnce`. Net: at most ONE outstanding POST before the
breaker decision, so a hung receiver can't accumulate a burst. Enqueues are unaffected (they still
just buffer — only the SEND is serialized), and the finally-clear plus the bounded send timeout
guarantee no deadlock. No change to the breaker, timeout, buffer bounds, or poison handling. New
test: with a never-resolving send, five enqueues spread across the flush cadence result in the fetch
stub's concurrent in-flight count never exceeding 1, and once the timeout fires and the breaker
opens, a further flush makes no new network attempt.

## Verification

Node 24 (`.nvmrc`), fresh worktree `~/apps/trading-monet-usage-push-failsafe`, `npm ci`:

- `npx tsc --noEmit` — clean.
- Focused: `npx vitest run test/usage-monitor-push.test.ts test/usage-monitor-replay.test.ts` —
  34/34 (17 pre-existing + 17 new across breaker, bounded buffer, flush-entry TTL, callVolume cap,
  push timeout, HMR shape migration, replay-lane health truthfulness, poison-event isolation, and
  single-flight send serialization), all passing including the pre-existing tests that use
  historical/fixed `occurredAt` values (these initially broke when TTL was first keyed off
  `occurredAt` instead of buffer-residency time — fixed before finalizing).
- `npm run lint` — 0 errors (493 pre-existing grandfathered warnings, none new).
- `npm test` — 404 files / 4747 tests, all passing.
- `npm run build` — clean production build (exit 0).

## Follow-ups

- Congress.Trade's companion fix (separate agent/repo) is out of scope here.
- Consider: an explicit "circuit open" signal on the admin connections-health page (currently the
  page just shows the last real health check, which already reads "down" during an outage — no
  functional gap, just a possible future readability improvement).
- Not landed: branch `monet/usage-push-failsafe` is implementation-complete and gate-green but
  intentionally NOT pushed/PR'd/merged per the owner-directed task scope (owner gates landing; the
  coordinator re-pushes + resolves the review threads + merges).
