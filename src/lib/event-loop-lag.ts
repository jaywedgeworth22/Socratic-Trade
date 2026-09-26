// event-loop-lag.ts — continuous event-loop stall accounting for the safety lanes.
//
// WHY THIS EXISTS (2026-09-09, seat CLAUDE).  The scheduler's two protective lanes —
// `synthetic-stop-monitor` and `stale-limit-scan` — race their work against a 15s
// `withDeadline` and, on expiry, report `runSyntheticStopMonitor timeout` /
// `stale-limit-scan broker timeout`.  Production evidence says that message is WRONG about
// the cause, and the wrong cause sent PR #3189 after broker retries that could not help:
//
//   * task_journal, `stale-limit-scan` @ 2026-09-08T19:51:57.566Z — duration 185_633ms with
//     error "Timed out waiting for alpaca.getOrders after 16000+8000ms."  The inner broker
//     call SELF-TERMINATED at 24_000ms, so 161_633ms of that lane elapsed outside all broker
//     I/O.  No network explanation reaches that number.
//   * task_journal, `synthetic-stop-monitor` @ 2026-09-09T13:45:41.103Z — duration 196_840ms,
//     status `ok`, summary `evaluated=6 triggered=0 exited=0`.  The monitor SUCCEEDED; it was
//     merely 13x past the deadline that had already logged it as a broker timeout.
//   * Passes with `evaluated=0` still took 30_000–134_000ms.  A pass with nothing to evaluate
//     makes two bounded reads whose transport ceiling is 30s each — it cannot spend 134s on
//     the network.
//   * The two lanes are independent (different endpoints, different call counts) yet their
//     slow runs start within 2-3ms of each other and match durations to ~100ms across 130s.
//     That is a shared process-wide stall, not two independent broker slowdowns.
//
// So the deadline is really a liveness probe on a blocked event loop, mislabelled as broker
// latency.  This module measures the stall directly so the lanes can say which one it was.
//
// Cost is one unref'd 500ms timer and a bounded ring buffer.  It changes NO lane behavior:
// nothing here cancels, retries, delays, or shortens a protective monitor pass.

/** Sampling period.  Small enough to attribute a multi-second pin, large enough to be free. */
const SAMPLE_PERIOD_MS = 500;
/** Lag below this is ordinary timer jitter, not a stall — do not record it as one. */
const LAG_FLOOR_MS = 50;
/** Ring capacity.  At one sample per 500ms this covers ~10 minutes of stall history, which
 *  comfortably outlives the 15s lane deadline it is queried against. */
const MAX_SAMPLES = 1_200;

type LagSample = { at: number; lagMs: number };

/** Called from the sampler's own tick, i.e. on the first callback after the loop frees. */
export type EventLoopStallListener = (lagMs: number, observedAt: number) => void;

type StallListenerEntry = { minLagMs: number; fn: EventLoopStallListener };

type LagHost = {
  __eventLoopLagSamples?: LagSample[];
  __eventLoopLagTimer?: NodeJS.Timeout;
  __eventLoopLagLastTickAt?: number;
  __eventLoopLagListeners?: StallListenerEntry[];
};

// globalThis-pinned so Next.js HMR module duplication cannot start a second sampler or split
// the history across two module instances (same pattern as the scheduler's own guards).
const lagHost = globalThis as unknown as LagHost;

function samples(): LagSample[] {
  return lagHost.__eventLoopLagSamples ?? (lagHost.__eventLoopLagSamples = []);
}

function listeners(): StallListenerEntry[] {
  return lagHost.__eventLoopLagListeners ?? (lagHost.__eventLoopLagListeners = []);
}

/**
 * Subscribe to "the loop just came back from a block of at least `minLagMs`".
 *
 * Added 2026-09-24 for the stall profiler (src/lib/stall-profiler.ts): the first sampler tick
 * after a long block is the earliest moment any JS can run again, which is exactly when a CPU
 * profile covering the block should be cut and saved — before the loop blocks again or an
 * operator restarts the container.  Listeners run synchronously inside the sampler tick, each in
 * its own try/catch, AFTER the sample is recorded (so `stalledMsSince` already includes it).  A
 * throwing listener can never stop the sampler.  The registry lives on globalThis for the same
 * HMR reason as the sampler itself.  Returns an unsubscribe function.
 */
export function onEventLoopStall(minLagMs: number, fn: EventLoopStallListener): () => void {
  const entry: StallListenerEntry = { minLagMs: Math.max(LAG_FLOOR_MS, minLagMs), fn };
  listeners().push(entry);
  return () => {
    const list = listeners();
    const index = list.indexOf(entry);
    if (index >= 0) list.splice(index, 1);
  };
}

function notifyStallListeners(lagMs: number, observedAt: number): void {
  const list = lagHost.__eventLoopLagListeners;
  if (!list || list.length === 0) return;
  for (const entry of [...list]) {
    if (lagMs < entry.minLagMs) continue;
    try {
      entry.fn(lagMs, observedAt);
    } catch {
      // Observability must never break the sampler the safety lanes depend on.
    }
  }
}

/**
 * Start the sampler.  Idempotent — safe to call from every lane on every tick.
 *
 * The timer is `unref`'d so it can never hold the process open, and the callback does no I/O:
 * it only records how late it was relative to its own period.  A callback that fires 59.5s
 * after a 500ms interval means the loop was pinned for ~59s and nothing else ran either.
 */
export function startEventLoopLagSampler(): void {
  if (lagHost.__eventLoopLagTimer) return;
  lagHost.__eventLoopLagLastTickAt = Date.now();
  const timer = setInterval(() => {
    const now = Date.now();
    const expectedAt = (lagHost.__eventLoopLagLastTickAt ?? now) + SAMPLE_PERIOD_MS;
    const lagMs = now - expectedAt;
    lagHost.__eventLoopLagLastTickAt = now;
    if (lagMs < LAG_FLOOR_MS) return;
    const buf = samples();
    buf.push({ at: now, lagMs });
    if (buf.length > MAX_SAMPLES) buf.splice(0, buf.length - MAX_SAMPLES);
    notifyStallListeners(lagMs, now);
  }, SAMPLE_PERIOD_MS);
  timer.unref?.();
  lagHost.__eventLoopLagTimer = timer;
}

/**
 * Total event-loop stall observed since `sinceMs`.
 *
 * Includes an IN-PROGRESS term for a stall that is ending right now.  Without it there is a
 * race we would lose every time it matters: a blocked loop defers BOTH the sampler's interval
 * and the deadline's `setTimeout`, and when the loop frees they run in an arbitrary order.  If
 * the deadline's rejection ran first, the stall that caused it would not yet be in the buffer
 * and we would misreport the very event we exist to catch.  Measuring the gap since the last
 * observed tick closes that hole.
 */
export function stalledMsSince(sinceMs: number): number {
  const now = Date.now();
  let total = 0;
  for (const sample of samples()) {
    if (sample.at <= sinceMs) continue;
    // Clamp a sample that straddles `sinceMs` to the portion inside the window.
    total += Math.min(sample.lagMs, Math.max(0, sample.at - sinceMs));
  }
  const lastTickAt = lagHost.__eventLoopLagLastTickAt;
  if (typeof lastTickAt === "number") {
    const inProgress = now - lastTickAt - SAMPLE_PERIOD_MS;
    if (inProgress >= LAG_FLOOR_MS) total += Math.min(inProgress, Math.max(0, now - sinceMs));
  }
  return Math.max(0, Math.round(total));
}

/** Test-only: drop sampler state so cases cannot leak stall history into each other. */
export function _resetEventLoopLagForTest(): void {
  if (lagHost.__eventLoopLagTimer) clearInterval(lagHost.__eventLoopLagTimer);
  lagHost.__eventLoopLagTimer = undefined;
  lagHost.__eventLoopLagSamples = [];
  lagHost.__eventLoopLagLastTickAt = undefined;
  lagHost.__eventLoopLagListeners = [];
}

/** Test-only: inject an observed stall without having to actually pin the loop. */
export function _recordEventLoopLagForTest(at: number, lagMs: number): void {
  samples().push({ at, lagMs });
}
