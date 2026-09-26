#!/usr/bin/env npx tsx
// Real node:inspector integration check for the stall profiler's Session/console wiring.
//
// Every test in test/stall-profiler.test.ts drives `StallProfiler` with a FakeSession/FakeBridge
// by design (src/lib/stall-profiler.ts must never touch a real V8 profiler under vitest -- see
// that module's header comment), so `createInspectorBindings()` -- the function that actually
// opens a node:inspector Session and wires up Profiler.post()/console.profile()/profileEnd() --
// was never exercised by the committed suite (review round, board 687a5fb4, 2026-09-25).  This
// script calls the real function and drives it through the exact bridged-restart sequence
// `StallProfiler.restart()` performs in production, on one tiny short-lived profile, and exits
// non-zero on any failure or timeout so a regression here (e.g. swapped err/result callback args
// in the post() Promise wrapper, or a typo in the console.profile/profileEnd binding) fails CI
// instead of only failing silently in production.
//
//   npx tsx scripts/ops/verify-stall-profiler-bindings.ts
//
// Run via tsx (same as scripts/assert-rth-deploy-latch.ts), not plain node: stall-profiler.ts's
// own relative imports (./event-loop-lag, ./cpuprofile-summary) omit extensions, which Node's
// native ESM loader refuses to resolve even with TypeScript stripping.

import { createInspectorBindings } from "../../src/lib/stall-profiler";

const TIMEOUT_MS = 15_000;

function describeError(err: unknown): string {
  return err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
}

function isCpuProfile(value: unknown): boolean {
  return (
    !!value &&
    typeof value === "object" &&
    Array.isArray((value as { nodes?: unknown }).nodes) &&
    typeof (value as { startTime?: unknown }).startTime === "number"
  );
}

async function main(): Promise<void> {
  const failures: string[] = [];
  const fail = (message: string) => failures.push(message);

  const { session, bridge } = await createInspectorBindings();
  try {
    let sawConsoleProfileStarted = false;
    let observedTitle: unknown;
    session.on("Profiler.consoleProfileStarted", (message) => {
      sawConsoleProfileStarted = true;
      observedTitle = (message as { params?: { title?: unknown } } | null)?.params?.title;
    });

    await session.post("Profiler.enable");
    await session.post("Profiler.setSamplingInterval", { interval: 1_000 });
    await session.post("Profiler.start");

    // Exercise the exact bridged-restart sequence StallProfiler.restart() performs: a keepalive
    // console.profile() must fire Profiler.consoleProfileStarted synchronously, then stop+start
    // must round-trip a real profile without throwing, then profileEnd() must not throw.
    const label = "verify-stall-profiler-bindings";
    bridge.profile(label);
    if (!sawConsoleProfileStarted || observedTitle !== label) {
      fail(
        "console.profile() did not synchronously emit Profiler.consoleProfileStarted with the " +
          "expected title -- the bridged-restart guard in StallProfiler.restart() would refuse " +
          "every rotation and self-disable in production"
      );
    }

    let stopped: { profile?: unknown } | undefined;
    try {
      stopped = (await session.post("Profiler.stop")) as { profile?: unknown } | undefined;
      await session.post("Profiler.start");
    } catch (err) {
      fail(`Profiler.stop()/Profiler.start() threw: ${describeError(err)}`);
    } finally {
      bridge.profileEnd(label);
    }
    if (!failures.length && !isCpuProfile(stopped?.profile)) {
      fail("Profiler.stop() did not return a real .cpuprofile (nodes[] / startTime)");
    }

    await session.post("Profiler.stop").catch(() => {});
    await session.post("Profiler.disable").catch(() => {});
  } finally {
    try {
      session.disconnect();
    } catch {
      // best effort cleanup
    }
  }

  if (failures.length) {
    for (const message of failures) process.stderr.write(`FAIL: ${message}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write("OK: real node:inspector Session + console.profile/profileEnd bindings work.\n");
}

const watchdog = setTimeout(() => {
  process.stderr.write(`FAIL: timed out after ${TIMEOUT_MS}ms (a real node:inspector call likely hung)\n`);
  process.exit(1);
}, TIMEOUT_MS);
watchdog.unref?.();

main()
  .catch((err) => {
    process.stderr.write(`FAIL: ${describeError(err)}\n`);
    process.exitCode = 1;
  })
  .finally(() => clearTimeout(watchdog));
