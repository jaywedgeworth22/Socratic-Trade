// Stall-triggered CPU profiler (board 687a5fb4, stall class e7b49943).
//
// Every case drives the controller with an injected fake inspector session, a fake console
// bridge, and a manual clock.  No test here starts a real V8 profiler: `resolveStallProfilerConfig`
// refuses under VITEST, and the controller only ever talks to the injected session.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  StallProfiler,
  resolveStallProfilerConfig,
  pruneStallProfiles,
  startStallProfiler,
  type StallProfilerConfig,
  type InspectorSessionLike,
  type ConsoleBridgeLike
} from "../src/lib/stall-profiler";
import {
  onEventLoopStall,
  startEventLoopLagSampler,
  _resetEventLoopLagForTest
} from "../src/lib/event-loop-lag";
import { buildCpuProfile, IDLE } from "./helpers/cpuprofile-fixture";

const culprit = { fn: "_parse", url: "file:///app/node_modules/zod/lib/types.js", line: 3120, col: 17 };
const caller = { fn: "parseTransactions", url: "file:///app/.next/server/chunks/412.js", line: 1, col: 9001 };

function stalledProfile() {
  return buildCpuProfile([
    { stack: IDLE, ms: 1_000 },
    { stack: [caller, culprit], ms: 45_000 },
    { stack: IDLE, ms: 1_000 }
  ]);
}

type Call = { method: string; params?: Record<string, unknown> };

class FakeSession implements InspectorSessionLike {
  calls: Call[] = [];
  events: string[] = [];
  listeners = new Map<string, Array<(message: unknown) => void>>();
  nextProfile = stalledProfile();
  failOn: string | null = null;
  /** Simulated duration of the next `Profiler.start` (advances the fake clock). */
  startCostMs = 0;
  clock: { t: number } | null = null;
  disconnected = false;

  async post(method: string, params?: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ method, params });
    this.events.push(method);
    if (this.failOn === method) throw new Error(`fake ${method} failure`);
    if (method === "Profiler.start" && this.clock) this.clock.t += this.startCostMs;
    if (method === "Profiler.stop") return { profile: this.nextProfile };
    return {};
  }
  on(event: string, listener: (message: unknown) => void): void {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
  }
  emit(event: string, message: unknown): void {
    for (const l of this.listeners.get(event) ?? []) l(message);
  }
  disconnect(): void {
    this.disconnected = true;
  }
  count(method: string): number {
    return this.calls.filter((c) => c.method === method).length;
  }
}

/** Mirrors V8: `console.profile(label)` synchronously emits Profiler.consoleProfileStarted. */
class FakeBridge implements ConsoleBridgeLike {
  constructor(private session: FakeSession, private emits = true) {}
  profile(label: string): void {
    this.session.events.push(`bridge.profile:${label}`);
    if (this.emits) this.session.emit("Profiler.consoleProfileStarted", { params: { title: label } });
  }
  profileEnd(label: string): void {
    this.session.events.push(`bridge.profileEnd:${label}`);
  }
}

function makeConfig(dir: string, over: Partial<StallProfilerConfig> = {}): StallProfilerConfig {
  return {
    enabled: true,
    dir,
    windowMs: 60_000,
    tickMs: 5_000,
    sampleIntervalUs: 10_000,
    stallThresholdMs: 5_000,
    resumeTriggerMs: 30_000,
    maxProfiles: 30,
    maxTotalBytes: 300 * 1024 * 1024,
    maxProfileBytes: 64 * 1024 * 1024,
    minWriteIntervalMs: 120_000,
    maxWindowMs: 300_000,
    minFreeBytes: 1024 * 1024 * 1024,
    maxStartMs: 1_000,
    ...over
  };
}

function harness(over: Partial<StallProfilerConfig> = {}, opts: { bridgeEmits?: boolean; freeBytes?: number | null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "agentic-stall-profiles-"));
  const clock = { t: Date.parse("2026-09-24T14:30:00.000Z") };
  const session = new FakeSession();
  session.clock = clock;
  const bridge = new FakeBridge(session, opts.bridgeEmits ?? true);
  let stalled = 0;
  const logs: string[] = [];
  let resumeListener: ((lagMs: number) => void) | null = null;
  let scheduled: (() => void) | null = null;
  let cancelled = false;
  const profiler = new StallProfiler(makeConfig(dir, over), {
    session,
    bridge,
    now: () => clock.t,
    stalledMsSince: () => stalled,
    log: (m) => logs.push(m),
    freeBytes: () => (opts.freeBytes === undefined ? 50 * 1024 * 1024 * 1024 : opts.freeBytes),
    schedule: (fn) => {
      scheduled = fn;
      return { cancel: () => (cancelled = true) };
    },
    subscribeStallResume: (_min, fn) => {
      resumeListener = fn;
      return () => (resumeListener = null);
    },
    startLagSampler: () => {}
  });
  return {
    dir,
    clock,
    session,
    profiler,
    logs,
    setStalled: (ms: number) => (stalled = ms),
    advance: (ms: number) => (clock.t += ms),
    resume: (lagMs: number) => resumeListener?.(lagMs),
    hasResumeListener: () => resumeListener !== null,
    scheduled: () => scheduled,
    cancelled: () => cancelled,
    files: () => readdirSync(dir).sort()
  };
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("resolveStallProfilerConfig", () => {
  const noAppData = { exists: () => false, tmpdir: () => "/tmp/x" };

  it("is ON by default in production and writes under /app/data/profiles when that volume exists", () => {
    const cfg = resolveStallProfilerConfig({ NODE_ENV: "production" }, { exists: (p) => p === "/app/data", tmpdir: () => "/t" });
    expect(cfg.enabled).toBe(true);
    expect(cfg.dir).toBe("/app/data/profiles");
    expect(cfg.windowMs).toBe(60_000);
    expect(cfg.stallThresholdMs).toBe(5_000);
    expect(cfg.maxProfiles).toBe(30);
    expect(cfg.maxTotalBytes).toBe(300 * 1024 * 1024);
    expect(cfg.minWriteIntervalMs).toBe(120_000);
  });

  it("falls back to os.tmpdir() when /app/data is absent", () => {
    const cfg = resolveStallProfilerConfig({ NODE_ENV: "production" }, noAppData);
    expect(cfg.dir).toBe(join("/tmp/x", "stall-profiles"));
  });

  it("STALL_PROFILER=0 is a kill switch in production", () => {
    expect(resolveStallProfilerConfig({ NODE_ENV: "production", STALL_PROFILER: "0" }, noAppData).enabled).toBe(false);
    expect(resolveStallProfilerConfig({ NODE_ENV: "production", STALL_PROFILER: "off" }, noAppData).enabled).toBe(false);
  });

  it("is OFF in dev unless STALL_PROFILER=1", () => {
    expect(resolveStallProfilerConfig({ NODE_ENV: "development" }, noAppData).enabled).toBe(false);
    expect(resolveStallProfilerConfig({ NODE_ENV: "development", STALL_PROFILER: "1" }, noAppData).enabled).toBe(true);
  });

  it("is always OFF under vitest so a test can never start a real profiler", () => {
    expect(resolveStallProfilerConfig({ NODE_ENV: "production", VITEST: "true", STALL_PROFILER: "1" }, noAppData).enabled).toBe(false);
  });

  it("honors overrides and clamps nonsense", () => {
    const cfg = resolveStallProfilerConfig(
      {
        NODE_ENV: "production",
        STALL_PROFILER_DIR: "/data/p",
        STALL_PROFILER_THRESHOLD_MS: "2500",
        STALL_PROFILER_SAMPLE_US: "5",
        STALL_PROFILER_MAX_FILES: "0",
        STALL_PROFILER_MAX_MB: "abc"
      },
      noAppData
    );
    expect(cfg.dir).toBe("/data/p");
    expect(cfg.stallThresholdMs).toBe(2_500);
    expect(cfg.sampleIntervalUs).toBeGreaterThanOrEqual(1_000);
    expect(cfg.maxProfiles).toBeGreaterThanOrEqual(1);
    expect(cfg.maxTotalBytes).toBe(300 * 1024 * 1024);
  });
});

describe("StallProfiler", () => {
  it("arms V8 sampling at the configured interval", async () => {
    const h = harness();
    expect(await h.profiler.start()).toBe(true);
    expect(h.session.events.slice(0, 3)).toEqual(["Profiler.enable", "Profiler.setSamplingInterval", "Profiler.start"]);
    expect(h.session.calls[1].params).toEqual({ interval: 10_000 });
    expect(h.scheduled()).not.toBeNull();
    expect(h.hasResumeListener()).toBe(true);
    expect(h.profiler.status().state).toBe("running");
  });

  it("does nothing before the window ends", async () => {
    const h = harness();
    await h.profiler.start();
    h.advance(30_000);
    h.setStalled(20_000);
    await h.profiler.tick();
    expect(h.session.count("Profiler.stop")).toBe(0);
  });

  it("discards a quiet window with a BRIDGED restart (never an unbridged stop/start)", async () => {
    const h = harness();
    await h.profiler.start();
    h.session.events.length = 0;
    h.advance(60_000);
    h.setStalled(1_200);
    await h.profiler.tick();
    // The keepalive profile brackets stop/start so V8 never disposes its CpuProfiler; a fresh
    // CpuProfiler re-walks the whole heap (measured 3.4-56 s on a 575-631 MB heap).
    expect(h.session.events.map((e) => e.replace(/:.*$/, ""))).toEqual([
      "bridge.profile",
      "Profiler.stop",
      "Profiler.start",
      "bridge.profileEnd"
    ]);
    expect(h.files()).toEqual([]);
    expect(h.profiler.status().written).toBe(0);
  });

  it("writes the profile and a cat-able .top.json when the window held >= 5s of stall", async () => {
    const h = harness();
    await h.profiler.start();
    h.advance(61_000);
    h.setStalled(59_529);
    await h.profiler.tick();
    const files = h.files();
    expect(files).toHaveLength(2);
    const profileFile = files.find((f) => f.endsWith(".cpuprofile"))!;
    const topFile = files.find((f) => f.endsWith(".top.json"))!;
    expect(profileFile).toMatch(/^stall-20260924T143101Z-59529ms\.cpuprofile$/);
    expect(topFile).toBe(profileFile.replace(/\.cpuprofile$/, ".top.json"));
    const written = JSON.parse(readFileSync(join(h.dir, profileFile), "utf8"));
    expect(Array.isArray(written.nodes)).toBe(true);
    const top = JSON.parse(readFileSync(join(h.dir, topFile), "utf8"));
    expect(top.stalledMs).toBe(59_529);
    expect(top.trigger).toBe("window");
    expect(top.topSelf[0].function).toBe("_parse");
    expect(top.topSelf[0].location).toBe("file:///app/node_modules/zod/lib/types.js:3120:17");
    expect(top.topTotal.length).toBeGreaterThan(0);
    // One entry per line so `cat` over SSH stays readable.
    expect(readFileSync(join(h.dir, topFile), "utf8")).toMatch(/\n {4}\{"function":"_parse"/);
    expect(h.logs.some((l) =>
      l.startsWith(`[stall-profiler] wrote ${join(h.dir, profileFile)} stalledMs=59529 topSelf=_parse@file:///app/node_modules/zod/lib/types.js:3120:17`)
    )).toBe(true);
    expect(h.profiler.status().written).toBe(1);
  });

  it("rate-limits writes to one per 2 minutes by EXTENDING the window instead of losing the stall", async () => {
    const h = harness();
    await h.profiler.start();
    h.advance(60_000);
    h.setStalled(10_000);
    await h.profiler.tick();
    expect(h.profiler.status().written).toBe(1);
    const stopsAfterFirst = h.session.count("Profiler.stop");

    h.advance(60_000); // 60s after the first write: stalled again, but inside the 2-minute limit
    h.setStalled(8_000);
    await h.profiler.tick();
    expect(h.session.count("Profiler.stop")).toBe(stopsAfterFirst); // window kept open
    expect(h.profiler.status().written).toBe(1);

    h.advance(60_000); // now 120s since the first write
    h.setStalled(8_000);
    await h.profiler.tick();
    expect(h.profiler.status().written).toBe(2);
    const tops = h.files().filter((f) => f.endsWith(".top.json"));
    const second = JSON.parse(readFileSync(join(h.dir, tops[1]), "utf8"));
    expect(second.windowMs).toBeGreaterThanOrEqual(120_000);
  });

  it("gives up extending at maxWindowMs and discards (bounded profile size)", async () => {
    const h = harness({ minWriteIntervalMs: 10 * 60_000, maxWindowMs: 180_000 });
    await h.profiler.start();
    h.advance(60_000);
    h.setStalled(10_000);
    await h.profiler.tick(); // write #1
    for (let i = 0; i < 3; i++) {
      h.advance(60_000);
      await h.profiler.tick();
    }
    expect(h.profiler.status().written).toBe(1);
    expect(h.profiler.status().skipped).toBeGreaterThanOrEqual(1);
    expect(h.logs.some((l) => /skipped .*rate-limited/.test(l))).toBe(true);
  });

  it("stops and writes immediately when the loop resumes after a >30s block (fallback)", async () => {
    const h = harness();
    await h.profiler.start();
    h.advance(20_000 + 35_000);
    h.setStalled(35_000);
    h.resume(35_000);
    await flush();
    expect(h.profiler.status().written).toBe(1);
    const top = JSON.parse(readFileSync(join(h.dir, h.files().find((f) => f.endsWith(".top.json"))!), "utf8"));
    expect(top.trigger).toBe("resume");
    expect(top.resumeLagMs).toBe(35_000);
  });

  it("refuses an unbridged restart and self-disables when the keepalive profile does not start", async () => {
    const h = harness({}, { bridgeEmits: false });
    await h.profiler.start();
    h.advance(60_000);
    h.setStalled(10_000);
    await expect(h.profiler.tick()).resolves.toBeUndefined();
    // It stops profiling once to shut down, but never restarts.
    expect(h.session.count("Profiler.start")).toBe(1);
    expect(h.profiler.status().state).toBe("failed");
    expect(h.logs.filter((l) => l.includes("disabled")).length).toBe(1);
    expect(h.cancelled()).toBe(true);
    expect(h.hasResumeListener()).toBe(false);
    expect(h.session.disconnected).toBe(true);
    // Later ticks are inert and never throw.
    h.advance(60_000);
    await h.profiler.tick();
    expect(h.logs.filter((l) => l.includes("disabled")).length).toBe(1);
  });

  it("self-disables (after saving the evidence) if a restart ever costs a heap walk", async () => {
    const h = harness();
    await h.profiler.start();
    h.session.startCostMs = 3_400;
    h.advance(60_000);
    h.setStalled(10_000);
    await h.profiler.tick();
    expect(h.profiler.status().written).toBe(1);
    expect(h.profiler.status().state).toBe("failed");
    expect(h.logs.some((l) => /disabled.*Profiler\.start took 3400ms/.test(l))).toBe(true);
  });

  it("never throws into the app when the inspector errors", async () => {
    const h = harness();
    await h.profiler.start();
    h.session.failOn = "Profiler.stop";
    h.advance(60_000);
    h.setStalled(10_000);
    await expect(h.profiler.tick()).resolves.toBeUndefined();
    expect(h.profiler.status().state).toBe("failed");
  });

  it("reports failure (not a throw) when arming fails", async () => {
    const h = harness();
    h.session.failOn = "Profiler.enable";
    await expect(h.profiler.start()).resolves.toBe(false);
    expect(h.profiler.status().state).toBe("failed");
    expect(h.logs.filter((l) => l.includes("disabled")).length).toBe(1);
  });

  it("skips (without disabling) when free disk space is low", async () => {
    const h = harness({}, { freeBytes: 200 * 1024 * 1024 });
    await h.profiler.start();
    h.advance(60_000);
    h.setStalled(10_000);
    await h.profiler.tick();
    expect(h.files()).toEqual([]);
    expect(h.profiler.status().state).toBe("running");
    expect(h.logs.some((l) => /skipped .*free/.test(l))).toBe(true);
  });

  it("skips a profile larger than the per-file cap", async () => {
    const h = harness({ maxProfileBytes: 1_000 });
    await h.profiler.start();
    h.advance(60_000);
    h.setStalled(10_000);
    await h.profiler.tick();
    expect(h.files()).toEqual([]);
    expect(h.profiler.status().state).toBe("running");
  });

  it("stop() tears everything down idempotently", async () => {
    const h = harness();
    await h.profiler.start();
    h.profiler.stop("test");
    h.profiler.stop("test");
    expect(h.cancelled()).toBe(true);
    expect(h.session.disconnected).toBe(true);
    expect(h.profiler.status().state).toBe("stopped");
  });
});

describe("pruneStallProfiles", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agentic-stall-prune-"));
  });

  function seed(n: number, bytes: number) {
    for (let i = 0; i < n; i++) {
      const base = `stall-202609${String(10 + Math.floor(i / 24)).padStart(2, "0")}T${String(i % 24).padStart(2, "0")}0000Z-6000ms`;
      writeFileSync(join(dir, `${base}.cpuprofile`), Buffer.alloc(bytes));
      writeFileSync(join(dir, `${base}.top.json`), "{}");
    }
  }

  it("keeps the newest N profiles and their sidecars", () => {
    seed(35, 10);
    writeFileSync(join(dir, "unrelated.txt"), "keep me");
    const result = pruneStallProfiles(dir, { maxProfiles: 30, maxTotalBytes: 1e9 });
    const left = readdirSync(dir);
    expect(left.filter((f) => f.endsWith(".cpuprofile"))).toHaveLength(30);
    expect(left.filter((f) => f.endsWith(".top.json"))).toHaveLength(30);
    expect(left).toContain("unrelated.txt");
    expect(result.removed.length).toBe(10);
    expect(existsSync(join(dir, "stall-20260910T000000Z-6000ms.cpuprofile"))).toBe(false);
    expect(existsSync(join(dir, "stall-20260911T100000Z-6000ms.cpuprofile"))).toBe(true);
  });

  it("enforces the byte cap oldest-first", () => {
    seed(10, 1_000);
    pruneStallProfiles(dir, { maxProfiles: 30, maxTotalBytes: 3_500 });
    const left = readdirSync(dir).filter((f) => f.endsWith(".cpuprofile")).sort();
    expect(left).toHaveLength(3);
    expect(left[2]).toBe("stall-20260910T090000Z-6000ms.cpuprofile");
  });

  it("sweeps orphaned .tmp files from an interrupted write", () => {
    writeFileSync(join(dir, "stall-20260910T000000Z-6000ms.cpuprofile.tmp"), "partial");
    pruneStallProfiles(dir, { maxProfiles: 30, maxTotalBytes: 1e9 });
    expect(readdirSync(dir)).toEqual([]);
  });

  it("keeps the cap when the controller writes into a full directory", async () => {
    const h = harness();
    dir = h.dir;
    seed(30, 10);
    await h.profiler.start();
    h.advance(60_000);
    h.setStalled(10_000);
    await h.profiler.tick();
    expect(h.files().filter((f) => f.endsWith(".cpuprofile"))).toHaveLength(30);
    expect(h.files().some((f) => f.startsWith("stall-20260924T"))).toBe(true);
  });
});

describe("startStallProfiler under vitest", () => {
  it("stays disabled without touching node:inspector", async () => {
    const status = await startStallProfiler();
    expect(status.state).toBe("disabled");
  });
});

describe("event-loop-lag stall listeners", () => {
  beforeEach(() => {
    _resetEventLoopLagForTest();
    vi.useFakeTimers();
  });
  afterEach(() => {
    _resetEventLoopLagForTest();
    vi.useRealTimers();
  });

  it("notifies once the loop resumes after a block longer than the listener's floor", () => {
    const seen: number[] = [];
    onEventLoopStall(30_000, (lagMs) => seen.push(lagMs));
    startEventLoopLagSampler();
    vi.advanceTimersByTime(500); // healthy tick
    // Simulate a 35s pinned loop: wall time jumps without the interval firing.
    vi.setSystemTime(Date.now() + 35_000);
    vi.advanceTimersByTime(500);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeGreaterThanOrEqual(35_000);
  });

  it("ignores stalls below the floor and isolates a throwing listener", () => {
    const seen: number[] = [];
    onEventLoopStall(30_000, () => {
      throw new Error("listener bug");
    });
    onEventLoopStall(30_000, (lagMs) => seen.push(lagMs));
    startEventLoopLagSampler();
    vi.setSystemTime(Date.now() + 10_000);
    vi.advanceTimersByTime(500);
    expect(seen).toHaveLength(0);
    vi.setSystemTime(Date.now() + 40_000);
    expect(() => vi.advanceTimersByTime(500)).not.toThrow();
    expect(seen).toHaveLength(1);
  });

  it("unsubscribes", () => {
    const seen: number[] = [];
    const off = onEventLoopStall(1_000, (lagMs) => seen.push(lagMs));
    off();
    startEventLoopLagSampler();
    vi.setSystemTime(Date.now() + 5_000);
    vi.advanceTimersByTime(500);
    expect(seen).toHaveLength(0);
  });
});
