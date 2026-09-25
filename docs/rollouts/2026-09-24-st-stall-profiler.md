# 2026-09-24 — Stall-Triggered CPU Profiler (CLAUDE, Lane A)

Board: umbrella `687a5fb4` (owner-directed fix sweep, 2026-09-24); stall class `e7b49943`.
Branch `claude/st-stall-profiler`, worktree `~/apps/trading-claude-st-stall-profiler`.

## 1. Context & Objective

Production keeps pinning its one Node 24 process during RTH: CPU at 100-120%, the event loop
~97% blocked in 40-140s chunks (`event_loop_stall broker timeout 59529ms/61s window (97%)`,
`79s/98% synthetic-stop monitor timeout`, `62s/97% stale-limit-scan broker timeout`),
`/api/health` timing out, and an operator restarting the container about every 20 minutes.
There were 11 recurrences on 2026-09-24 alone, on at least 5 shas since 2026-09-11.  The root
cause is unknown because every lane that logs the stall is a victim of it.  tini as PID 1, the
SQLITE_BUSY pin (#3383), and RTH ingest isolation + Cheerio yields (#3448) did not fix it.  The
unconfirmed lead is a Zod-validation error flood from congress.trade `GET /api/transactions`
(board `77d339f7`).

Objective: make the NEXT RTH stall name its culprit automatically, with no operator action
beyond reading a file.

## 2. Changes Made

A continuous, low-rate V8 sampling profiler runs in-process through `node:inspector`.  It is cut
into ~60s windows.  A window is kept only when `src/lib/event-loop-lag.ts` saw >= 5s of stall in
it.  Kept windows land in `/app/data/profiles` (the persistent volume) as
`stall-<UTC stamp>-<stalledMs>ms.cpuprofile` plus a `.top.json` sidecar that is readable with
`cat`: the top 40 functions by self time and by total time as `fn@url:line:col`, the longest busy
run (the stall itself) with its own top self-time list, and the 10 hottest full leaf stacks.  The
V8 sampler thread keeps recording while the main thread is pinned, so JS only has to run between
blocked chunks to cut and save.  As a fallback, the lag sampler's first tick after a block of
>= 30s cuts and saves immediately, before the loop can block again or the container is restarted.

Each write logs one line:

```
[stall-profiler] wrote /app/data/profiles/stall-20260924T143101Z-59529ms.cpuprofile stalledMs=59529 topSelf=_parse@file:///app/node_modules/zod/lib/types.js:3120:17 trigger=window windowMs=61000 busyRunMs=59400
```

Boot logs one `[stall-profiler] armed dir=... (initial Profiler.start Nms)` line.  A failure logs
one `[stall-profiler] disabled after failure ...` line and the profiler stays off for the life of
the process.

Files:

- `src/lib/stall-profiler.ts` (new): config resolution, the `StallProfiler` rotation / decision /
  write engine with injected session, clock, and fs, retention (`pruneStallProfiles`), the
  process singleton `startStallProfiler()`, and `getStallProfilerStatus()`.
- `src/lib/cpuprofile-summary.ts` (new): dependency-free `.cpuprofile` summarizer shared by the
  app and the ops script.
- `scripts/ops/summarize-cpuprofile.mjs` (new): prints the same table for any `.cpuprofile`
  (imports the `.ts` summarizer through Node 24's built-in type stripping; no build step).
- `src/lib/event-loop-lag.ts`: `onEventLoopStall(minLagMs, fn)` listener registry, notified from
  the sampler tick after the sample is recorded, each listener isolated in try/catch.
- `instrumentation.ts`: arms the profiler after Sentry init and before the scheduler and
  background workers; fire-and-forget, wrapped, never blocks boot.
- `test/stall-profiler.test.ts`, `test/cpuprofile-summary.test.ts`,
  `test/helpers/cpuprofile-fixture.ts` (new).
- `node_modules`: the tracked symlink committed by accident in b583b2c65 / #3452 was removed with
  `git rm --cached` on this branch, but `origin/main` dropped it independently before merge, so
  the final PR diff no longer carries that change.
- Docs: this note, `STATUS.md`, `docs/EFFORT-LOG.md`.

Knobs (all optional): `STALL_PROFILER=0|1` (default ON only when `NODE_ENV=production`, always
OFF under vitest), `STALL_PROFILER_DIR`, `STALL_PROFILER_THRESHOLD_MS` (5000),
`STALL_PROFILER_WINDOW_MS` (60000), `STALL_PROFILER_SAMPLE_US` (10000),
`STALL_PROFILER_MAX_FILES` (30), `STALL_PROFILER_MAX_MB` (300).

## 3. Decisions & Trade-offs

**Changed from the recommended design: the restart is bridged.**  The brief recommended
`Profiler.stop` then `Profiler.start` each window.  Measured locally on Node 24.21, that is itself
a stall generator.  When the inspector's last profile stops, V8 disposes its `CpuProfiler`, and
the next `Profiler.start` builds a new one that walks the entire heap to log existing code:

| Heap | First `Profiler.start` | Later plain restart | Bridged rotation (profile + stop + start + profileEnd) |
|---|---|---|---|
| 4 MB | 70 ms | 57 ms | ~4 ms |
| 575 MB of plain objects | 3,415 ms | 10,816 ms | ~6 ms |
| 603-631 MB of objects + 20k compiled functions (two runs) | 8,077-55,943 ms | 3,873-32,071 ms | ~1-241 ms |

The Mac was at load average ~600 from parallel fleet work during these runs, so absolute numbers
swing between runs; the ratio (seconds vs milliseconds) does not.  Re-verified after the restart
(2026-09-25, Node 24.21, 303 MB heap with 20k compiled functions): first `Profiler.start` 903 ms,
plain stop+start 659 ms, bridged start 0.02-0.04 ms (whole bridged rotation 0.1-0.9 ms), and
`Profiler.consoleProfileStarted` arrived synchronously inside `console.profile()` every time.  A plain `Profiler.stop` on the
function-heavy heap also cost 328-607 ms, because it disposes the profiler and its code map.

Rotating the naive way would inject multi-second-to-minute blocks every 60s into the process we
are diagnosing.  So each rotation starts a short keepalive `console.profile()` on V8's own
console (`node:inspector` `console`), then does stop + start, then ends the keepalive.  While the
keepalive runs the inspector's profile count never reaches zero, the `CpuProfiler` is never
disposed, and no heap walk happens (bridged `Profiler.start` measured 0.1-0.4 ms on every heap
above).  The keepalive's profile is discarded.  Two guards prevent a
silent fallback to the expensive path: (1) V8 emits `Profiler.consoleProfileStarted`
synchronously inside `console.profile()`; if it did not arrive we refuse to stop at all and
self-disable; (2) if a bridged `Profiler.start` ever takes > 1s we save the current evidence and
self-disable.  The only heap walk left is the first start at boot, on a small young heap.

**Rate limit extends instead of discarding.**  With <= 1 write per 2 minutes, a stalled window
that lands inside the limit is kept open (sampling continues) and written when the limit allows,
up to a 5-minute window cap.  Recurrent stalls therefore never lose evidence to the rate limit.

**Synchronous writes, tmp-then-rename.**  At most one write per 2 minutes, a few MB each, to
local NVMe: a few ms.  Synchronous writes land before the loop can block again or the container
is replaced, which async writes would not guarantee.  An interrupted write leaves only a `.tmp`
that the next prune sweeps.

**Disk safety.**  Retention keeps the newest 30 profile pairs and <= 300 MB total, pruned BEFORE
each write with the incoming pair reserved, so the cap always holds.  A single pair over 64 MB is
skipped.  A write that would leave < 1 GiB free on the volume is skipped (the volume also holds
the SQLite DB and the Litestream state).  Only `stall-*` files are ever touched.

**`url:line:col`, not just `url:line`.**  Next.js server chunks are minified onto one line, so
the column is what identifies the function.  Frames under `node_modules` that Next does not bundle
(`serverExternalPackages`, e.g. better-sqlite3) keep readable names.

**Overhead.**  Sampling at 10ms is 100 stack samples per second on V8's sampler thread, the same
order as Sentry's continuous profiler (99 Hz) and dd-trace's defaults, which are designed to run
permanently in production at low single-digit percent CPU.  Code-event logging while a profile is
active has a small JIT-time cost.  Each rotation serializes and parses the discarded window
(~6,000 samples, a few ms) once a minute.  A local CPU-time micro-benchmark (JSON round-trips)
measured +1.4% with the profiler on; repeat runs were noisy because this Mac was at load average
~600 from parallel fleet work, so treat that number as indicative only.  The bridged design is
what keeps the per-minute cost at milliseconds instead of seconds.

**Coexistence with other profilers.**  Nothing else in the app opens a `node:inspector` session
(grepped `src`, `app`, `scripts`, `instrumentation.ts`, `sentry*.ts`).  `@sentry/profiling-node`
(attached in `instrumentation.ts` when `SENTRY_DSN` is set) uses its own native
`v8::CpuProfiler`, created once at addon init with EAGER logging and sampling at 99 Hz; dd-trace
profiling is off (`DD_PROFILING_ENABLED=false` default in `src/lib/datadog-server.ts`).  V8
supports several `CpuProfiler`s per isolate, each with its own sampler, so there is no conflict.
Sentry's only other `node:inspector` use is `inspector.url()` (no session); its LocalVariables
integration (which would open a `Debugger` session and pause on every exception) is gated on
`includeLocalVariables: true`, which `sentry.server.config.ts` does not set.  Keep it that way:
with pause-on-exception, an exception flood such as the suspected Zod error flood would itself be
a stall source.  This module opens exactly one session per process, pinned on `globalThis`
against Next.js module duplication.

**The lag sampler now starts at boot.**  `startStallProfiler` calls the idempotent
`startEventLoopLagSampler()`; previously it started on the first safety-lane tick.  No lane
behavior changes.

**Not done here (file ownership):** exposing `getStallProfilerStatus()` in the ops snapshot
(`src/lib/ops-snapshot.ts` is Lane E1's file).

## 4. Verification State

Commands (Node 24, `export PATH=/opt/homebrew/opt/node@24/bin:$PATH`):

```bash
npx vitest run test/stall-profiler.test.ts test/cpuprofile-summary.test.ts test/lane-deadline-stall-attribution.test.ts
npm run lint
npx tsc --noEmit
npm test
npm run build
```

Results (2026-09-25, Node v24.21.0, this Mac at load average 250-700 from parallel fleet work):

- Targeted: `test/stall-profiler.test.ts`, `test/cpuprofile-summary.test.ts`,
  `test/lane-deadline-stall-attribution.test.ts` — 3 files, 55 tests passed.
- `npm run lint` — exit 0, `830 problems (0 errors, 830 warnings)` (grandfathered warnings; the
  files this lane touched add none — the one warning in `instrumentation.ts` is the pre-existing
  Sentry `any`).
- `npx tsc --noEmit` — clean.
- `npm test` (via `scripts/land.sh`) — `Test Files 756 passed | 1 skipped (757)`,
  `Tests 8311 passed | 51 skipped (8362)`.  The first land attempt failed ONE unrelated test,
  `test/data-providers.test.ts` "keeps FMP_MAX_SYMBOLS as an explicit operator throttle", at
  72,417 ms against the 60 s `testTimeout` under load ~700; it passed in isolation
  (`npx vitest run test/data-providers.test.ts -t FMP_MAX_SYMBOLS`) and on the re-run.
- `npm run build` (`next build --webpack`, via `scripts/land.sh`) — clean.
- Empirical bridge check (scratch script, not committed): 303 MB heap with 20k compiled
  functions — first `Profiler.start` 903 ms, plain restart 659 ms, bridged start 0.02-0.04 ms,
  `Profiler.consoleProfileStarted` synchronous.

PR #3756.  `scripts/land.sh` arms auto-merge by default; it was disarmed immediately
(`gh pr merge 3756 --disable-auto`) because this sweep's review stage arms it.

## 5. Next Steps & Blockers

After this deploys (merges auto-deploy after the RTH latch), on the next stall:

```bash
ssh coolify 'C=$(docker ps -q -f name=d83b1aykr03uwr32yhgzaiay|head -1); docker exec $C ls -lt /app/data/profiles | head; docker exec $C cat /app/data/profiles/<newest>.top.json'
```

Also useful inside the container:

```bash
docker logs $C 2>&1 | grep '\[stall-profiler\]' | tail
docker exec $C node scripts/ops/summarize-cpuprofile.mjs /app/data/profiles/<newest>.cpuprofile
docker cp $C:/app/data/profiles/<newest>.cpuprofile .   # open in Chrome DevTools > Performance or speedscope.app
```

- Confirm the boot line `[stall-profiler] armed ... (initial Profiler.start Nms)` appears and N is
  small.  If it says `disabled`, read the reason; the app is unaffected.
- If `topSelf` points into a minified `.next/server/chunks/*.js`, use the hot stack's outer
  frames (often a readable `node_modules` or `node:` frame) or map the column with that build's
  source map.  Enabling server source maps for production is a possible follow-up.
- Check that production does NOT set `SENTRY_PROFILER_LOGGING_MODE=lazy`: in lazy mode Sentry's
  own profiler would do the heap walk above on every start, which is a candidate stall source on
  its own.
- Follow-up option, not built: a worker-thread watchdog using `inspector.Session
  .connectToMainThread()` could cut a profile DURING a block that never ends (the process killed
  mid-stall).  The observed stalls end between chunks, so the in-thread design covers them.
- Lane E1 may add `getStallProfilerStatus()` to the ops snapshot.

## 6. Zero-Code Findings

- The naive rotating-profiler design costs a full heap walk per restart (table above); anything
  that repeatedly starts a fresh V8 `CpuProfiler` in lazy-logging mode on a large heap produces
  exactly the multi-second-to-minute, CPU-bound, main-thread blocks seen in production.  Nothing
  in this repo does that today (Sentry's profiler is eager and long-lived), but it is worth
  keeping in mind while reading the first captured profiles: if `topSelf` is `(program)` with no
  JS frame, suspect VM-internal work such as a profiler start or a GC.
