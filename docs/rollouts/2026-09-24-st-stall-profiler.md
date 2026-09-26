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
~600 from parallel fleet work, so treat that number as indicative only.  **That benchmark ran with
this module's profiler alone; it does not cover the combined cost with `@sentry/profiling-node`'s
own continuous profiler also active (see Coexistence below and the review-round section), which
is unverified in production.**  The bridged design is what keeps the per-minute cost at
milliseconds instead of seconds.

**Coexistence with other profilers.**  Nothing else in the app opens a `node:inspector` session
(grepped `src`, `app`, `scripts`, `instrumentation.ts`, `sentry*.ts`).  `@sentry/profiling-node`
(attached in `instrumentation.ts` when `SENTRY_DSN` is set) uses its own native `v8::CpuProfiler`
via the separate `@sentry/node-cpu-profiler` addon (`CpuProfilerBindings`), not `node:inspector`,
so the two never contend for the same session.  **Corrected 2026-09-25 (review round): this was
previously described here as "created once at addon init" and, in the Zero-Code Findings below,
as "eager and long-lived" -- both wrong.**  `sentry.server.config.ts` sets
`profileSessionSampleRate` + `profileLifecycle: "trace"`, which (`getProfilingMode` in
`@sentry/profiling-node` 10.75.0) selects continuous "current" mode with trace lifecycle:
`_startTraceLifecycleProfiling()` starts a profiling chunk on the first active span and, once
started, a `CHUNK_INTERVAL_MS` (60s) timer unconditionally stops and restarts that chunk via
`_stopChunkProfiling()` / `_startChunkProfiling()` for as long as at least one span stays active
-- i.e. Sentry's own profiler DOES restart on a fixed interval in this app's actual configuration,
the same class of behavior this module's bridged-restart design exists to avoid for itself.
Whether that native-binding restart pays the same multi-second heap-walk cost this module
measured for `node:inspector`'s `Profiler.start`/`Profiler.stop` is NOT verified here -- it is a
different code path (a purpose-built addon, not the general-purpose Inspector protocol), so it
may or may not be equally expensive.  See the review-round section for the open next step.
dd-trace profiling is off (`DD_PROFILING_ENABLED=false` default in `src/lib/datadog-server.ts`).
V8 supports several `CpuProfiler`s per isolate, each with its own sampler, so the two profilers
do not conflict over the *session* -- they can, however, both be doing sampling/restart work on
the same CPU at the same time, which is the combined-overhead question flagged above and in the
review round.  Sentry's only other `node:inspector` use is `inspector.url()` (no session); its
LocalVariables integration (which would open a `Debugger` session and pause on every exception) is
gated on `includeLocalVariables: true`, which `sentry.server.config.ts` does not set.  Keep it
that way: with pause-on-exception, an exception flood such as the suspected Zod error flood would
itself be a stall source.  This module opens exactly one `node:inspector` session per process,
pinned on `globalThis` against Next.js module duplication.

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

**Re-sync (2026-09-25):** merged `origin/main` again to pick up #3761 (warnings/rotation), #3774
(CI bot trust), #3778 (Qdrant scroll bound) — none touch this lane's files (checked via
`git diff --name-only` against the merged-in commits); only `STATUS.md`/`docs/EFFORT-LOG.md`
overlapped and both sides' entries were kept.  Re-ran on the merged tree: `npx tsc --noEmit`
clean; `npm run lint` exit 0, `836 problems (0 errors, 836 warnings)`; targeted
`npx vitest run test/stall-profiler.test.ts test/cpuprofile-summary.test.ts
test/lane-deadline-stall-attribution.test.ts` — 3 files, 55 tests passed.  Full `npm test`/
`npm run build` left to the required `verify` CI check per this sweep's load-aware protocol.
Hold label `do-not-automerge` kept; auto-merge not armed.

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
- **Open from the review round (section 7 below):** Sentry's own continuous profiler restarts its
  profiling chunk on a 60s timer whenever this app's config is live (`profileSessionSampleRate` +
  `profileLifecycle: "trace"`), a genuinely different code path than the `node:inspector` restart
  this lane bridges, and it was never measured for the same heap-walk cost.  Verify (watch
  production CPU%/stall frequency for a week, or briefly flip `profileLifecycle` to `"manual"` and
  compare) and, if confirmed expensive, bridge it or disable it in production -- an owner/product
  decision, not made here.  Also unverified: the combined CPU overhead of this module's sampler
  running alongside Sentry's, since the +1.4% figure above was measured with this module alone.
- Follow-up option, not built: a worker-thread watchdog using `inspector.Session
  .connectToMainThread()` could cut a profile DURING a block that never ends (the process killed
  mid-stall).  The observed stalls end between chunks, so the in-thread design covers them.
- Lane E1 may add `getStallProfilerStatus()` to the ops snapshot.

## 6. Zero-Code Findings

- The naive rotating-profiler design costs a full heap walk per restart (table above); anything
  that repeatedly starts a fresh V8 `CpuProfiler` in lazy-logging mode on a large heap produces
  exactly the multi-second-to-minute, CPU-bound, main-thread blocks seen in production.  **Corrected
  2026-09-25 (review round): this originally said "Nothing in this repo does that today (Sentry's
  profiler is eager and long-lived)" -- that is wrong.  `@sentry/profiling-node`, as this app
  configures it (`profileSessionSampleRate` + `profileLifecycle: "trace"`), restarts its own
  profiling chunk on a 60s timer for as long as a span stays active (see the corrected Coexistence
  section above) -- a genuinely different native code path than the `node:inspector` restart this
  table measures, so it is not established to be equally expensive, but it is not "long-lived"
  either, and it was not ruled out as a contributor to the production stalls this lane exists to
  diagnose.**  It is worth keeping in mind while reading the first captured profiles: if `topSelf`
  is `(program)` with no JS frame, suspect VM-internal work such as a profiler start or a GC --
  and check whether a Sentry profiling-chunk restart landed in the same window.

## 7. Review Round (2026-09-25)

**Note on landing.**  PR #3756 merged to `main` (squash commit `16698bef0`) before this
independent review reached it, and the source branch `claude/st-stall-profiler` was deleted on
merge (this repo's branch-delete-on-merge setting), so this review round lands as a **new PR** off
fresh `origin/main` (worktree `~/apps/claude-st-stall-profiler-review`, branch
`claude/st-stall-profiler-review`) rather than a push to the now-closed #3756.  All three findings
below are against code that is already live on `main`/production.

Three independent-reviewer findings against #3756.  All three were verified real against the
actual code (not against the rollout note's own claims -- those claims turned out to be part of
the problem for two of the three); two are fixed, one is a documented gap this session cannot
close without production access.

1. **P1 (`docs/rollouts/2026-09-24-st-stall-profiler.md`): the "Sentry profiling coexistence"
   claim was factually wrong.**  Confirmed by reading the installed `@sentry/profiling-node`
   10.75.0 source (`node_modules/@sentry/profiling-node/build/cjs/index.js`): `sentry.server.config.ts`
   sets `profileSessionSampleRate` + `profileLifecycle: "trace"`, which `getProfilingMode()` maps
   to continuous "current" mode, and `_startTraceLifecycleProfiling()` starts a profiling chunk on
   the first active span; once started, a hardcoded `CHUNK_INTERVAL_MS` (60,000 ms) `setTimeout`
   unconditionally calls `_stopChunkProfiling()` then `_startChunkProfiling()` again, for as long
   as at least one span stays active -- i.e. Sentry's own profiler DOES restart on a fixed 60s
   interval in this app's actual configuration.  The rollout note's claims that "Nothing in this
   repo does that today" and that Sentry's profiler is "created once at addon init" / "eager and
   long-lived" were wrong.  **Fixed**: corrected the Coexistence and Zero-Code-Findings sections
   above in place, with a `Corrected 2026-09-25` marker on each.  Not fixed (needs production
   access this session does not have, per this task's hard limits): whether Sentry's restart --
   through its own native `@sentry/node-cpu-profiler` addon, a different code path than the
   `node:inspector` Profiler domain this table measured -- pays a comparable heap-walk cost.  Left
   as an explicit next step (section 5 above).
2. **P2 (`instrumentation.ts`): combined overhead with Sentry's profiler is unverified.**
   Confirmed real and follows directly from finding 1: the rollout note's "+1.4%" overhead number
   came from a local JSON-round-trip micro-benchmark with only this module's profiler running, not
   with `@sentry/profiling-node`'s own continuous profiler also active, and the `maxStartMs=1s`
   self-disable guard bounds only a single bridged `Profiler.start` call's duration, not
   steady-state combined sampling/restart cost across both profilers.  **Declined as a code
   change**: closing this for real needs a production CPU measurement with both profilers live,
   which this session cannot take (no ssh, no production access, per this sweep's hard limits) and
   which no safe local substitute can honestly represent (this Mac's own load, ~250-700 from
   parallel fleet work, is not comparable to production's).  Speculating a mitigation (e.g. making
   the two profilers "mutually aware", or preemptively raising `STALL_PROFILER_SAMPLE_US`) without
   that data would change production profiling behavior on a guess, not evidence.  Documented as
   an explicit next step instead (section 5 above): watch production CPU% for a week after this
   deploys, or temporarily flip `sentry.server.config.ts`'s `profileLifecycle` to `"manual"` (or
   set `SENTRY_PROFILE_SESSION_SAMPLE_RATE=0`) and compare stall frequency/CPU.
3. **P2 (`src/lib/stall-profiler.ts:708`): `createInspectorBindings` -- the real `node:inspector`
   wiring -- had zero automated test coverage.**  Confirmed real: every test in
   `test/stall-profiler.test.ts` drives `StallProfiler` with a `FakeSession`/`FakeBridge` by
   design (the module must never start a real V8 profiler under vitest), and the one test that
   calls the real public entry point (`startStallProfiler()`, under `describe("startStallProfiler
   under vitest")`) hits the `env.VITEST` early-return and gets back `disabled` BEFORE
   `createInspectorBindings()` is ever called.  So a regression in the real `Session.post()`
   Promise wrapping or the `console.profile`/`profileEnd` binding -- exactly the reviewer's example
   of swapping the `post()` callback's `(err, result)` argument order -- would pass the entire
   suite unchanged and only fail silently in production.  Verified experimentally before fixing:
   swapped the callback argument order in a scratch copy, confirmed the new check below fails with
   the swap in place, reverted, confirmed it passes again.  **Fixed test-first**: exported
   `createInspectorBindings` (was module-private, no behavior change) and added
   `scripts/ops/verify-stall-profiler-bindings.ts`, a standalone script (run with `tsx`, not
   vitest, so the "never start a real V8 profiler under vitest" design constraint still holds)
   that calls the real function and drives it through the exact bridged-restart sequence
   `StallProfiler.restart()` performs in production (keepalive `console.profile()`, assert
   `Profiler.consoleProfileStarted` arrived synchronously, `Profiler.stop`/`Profiler.start`,
   assert a real `.cpuprofile` came back, `profileEnd()`), on one short-lived profile with a 15s
   watchdog; wired it into `.github/workflows/ci.yml`'s `verify-hosted` job (new step, alongside
   the existing bash-selftest checks for scripts vitest cannot cover) so a broken binding fails
   the required `verify` check instead of only failing silently in production.

Declined: none as false positives -- all three were confirmed real.  Finding 2 is declined as a
code change for the concrete reason above (no production access to measure it, and no honest
local substitute), not because it is false; it is documented with a specific next step instead.

Files touched this round: `src/lib/stall-profiler.ts` (export only, no behavior change),
`scripts/ops/verify-stall-profiler-bindings.ts` (new), `.github/workflows/ci.yml` (new
`verify-hosted` step), `docs/rollouts/2026-09-24-st-stall-profiler.md` (this note), `STATUS.md`,
`docs/EFFORT-LOG.md`.

Verification this round (worktree `~/apps/claude-st-stall-profiler-review`, branch
`claude/st-stall-profiler-review`, Node 24, `export PATH=/opt/homebrew/opt/node@24/bin:$PATH`):

```bash
npx tsx scripts/ops/verify-stall-profiler-bindings.ts   # OK against real code
# regression check (not committed): swapped the post() (err, result) callback args in
# createInspectorBindings, reran the script above -> FAIL; reverted -> OK again.
npx vitest run test/stall-profiler.test.ts test/cpuprofile-summary.test.ts
npm run lint
npx tsc --noEmit
```

Results recorded in the PR for this round; the required `verify` CI check (which now also runs
`verify-stall-profiler-bindings.ts`) is the binding gate for the full suite + build.
