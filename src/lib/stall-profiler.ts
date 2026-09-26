// stall-profiler.ts — capture a V8 CPU profile of every production event-loop stall.
//
// WHY THIS EXISTS (2026-09-24, seat CLAUDE, board 687a5fb4; stall class board e7b49943).
// Production (one Node 24 process, Next.js 16, Coolify on a shared 8-vCPU Hetzner box) keeps
// pinning its event loop during RTH: CPU at 100-120%, the loop ~97% blocked in 40-140s chunks
// ("event_loop_stall broker timeout 59529ms/61s window (97%)", "79s/98% synthetic-stop monitor
// timeout", "62s/97% stale-limit-scan broker timeout"), /api/health timing out, and an operator
// restarting the container about every 20 minutes -- 11 recurrences on 2026-09-24 alone, on at
// least 5 shas since 2026-09-11.  src/lib/event-loop-lag.ts proves the loop is blocked, but every
// lane that logs the stall is a VICTIM of it, so nothing names the culprit.  tini as PID 1, the
// SQLITE_BUSY pin (#3383), and RTH ingest isolation + Cheerio yields (#3448) did not fix it.
//
// This module keeps a low-rate V8 sampling profiler running continuously, cuts it into ~60s
// windows, and keeps a window only when the lag sampler saw >= 5s of stall inside it.  The V8
// sampler runs on its own thread, so it keeps recording stacks WHILE the main thread is pinned;
// JS only has to run between blocked chunks to cut and save the profile.  Each saved profile
// gets a `<name>.top.json` sidecar with the top functions by self/total time as `url:line:col`,
// the longest busy run, and the hottest full stacks, readable with `cat`.
//
// THE ONE NON-OBVIOUS DECISION -- the bridged restart.  The naive rotation (Profiler.stop then
// Profiler.start every window) is itself a stall generator: when the inspector's last profile
// stops, V8 disposes its CpuProfiler, and the next Profiler.start builds a new one that walks
// the entire heap to log existing code.  Measured locally on Node 24.21 (2026-09-24):
//   * 4 MB heap: start 57-70 ms;
//   * 575 MB heap of plain objects: first start 3,415 ms, a later restart 10,816 ms;
//   * 631 MB heap with 20k compiled functions: first start 55,943 ms, restart 32,071 ms.
// Rotating that way would inject multi-second-to-minute blocks every 60s into the very process
// we are trying to diagnose.  So every rotation is bracketed by a short-lived "keepalive"
// `console.profile()` on the V8 console: while it runs, the inspector's profile count never
// reaches zero, the CpuProfiler is never disposed, and stop+start costs ~2-5 ms regardless of
// heap size (same measurements: 0.1-0.4 ms start, 1-4 ms stop).  The keepalive's own profile is
// discarded.  Two guards make sure we never fall back to the expensive path silently:
//   1. V8 emits `Profiler.consoleProfileStarted` synchronously inside console.profile(); if it
//      did not arrive, we refuse to stop at all and self-disable instead.
//   2. If a bridged Profiler.start ever takes longer than `maxStartMs` (1s), we save the current
//      evidence and self-disable.
// The only heap walk left is the very first Profiler.start at boot, on a small young heap.
//
// Scope discipline: observability only.  Nothing here may throw into the app, delay boot, or
// change a trading decision.  Every entry point is wrapped; any unexpected failure logs ONCE and
// self-disables.  Writes are rate-limited (<= 1 per 2 min), capped by count (30) and bytes
// (300 MB), skipped when the volume has < 1 GiB free, and written tmp-then-rename.
// Kill switch: STALL_PROFILER=0.  Default ON only when NODE_ENV=production; always OFF under
// vitest (the tests drive StallProfiler with an injected fake session and never start V8's).
//
// Coexistence: nothing else in this app opens a node:inspector session.  @sentry/profiling-node
// (attached in instrumentation.ts when SENTRY_DSN is set) uses its own native v8::CpuProfiler with
// eager logging, not the inspector; dd-trace profiling is off (DD_PROFILING_ENABLED=false).  V8
// supports several CpuProfilers per isolate (each has its own sampler), so they do not conflict.
// This module opens exactly one session per process, pinned on globalThis so Next.js module
// duplication cannot open a second.

import {
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  statfsSync,
  unlinkSync,
  writeFileSync,
  existsSync
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { onEventLoopStall, stalledMsSince, startEventLoopLagSampler } from "./event-loop-lag";
import {
  formatFunctionTiming,
  summarizeCpuProfile,
  type CpuProfile
} from "./cpuprofile-summary";

const MB = 1024 * 1024;

/** A window younger than this is never cut (guards a resume trigger racing the window tick). */
const MIN_WINDOW_MS = 1_000;
/** A repeated skip reason is logged at most this often. */
const SKIP_LOG_INTERVAL_MS = 10 * 60_000;

export type StallProfilerConfig = {
  enabled: boolean;
  /** Where profiles land.  Default /app/data/profiles (persistent volume) else os.tmpdir(). */
  dir: string;
  /** Rotation window: a window with too little stall is discarded at this age. */
  windowMs: number;
  /** How often the window is checked (cheap: one clock read + a ring-buffer sum). */
  tickMs: number;
  /** V8 sampling interval in microseconds (Profiler.setSamplingInterval). */
  sampleIntervalUs: number;
  /** Keep a window only if the lag sampler saw at least this much stall inside it. */
  stallThresholdMs: number;
  /** Cut and save immediately when the loop resumes after a block at least this long. */
  resumeTriggerMs: number;
  /** Keep the newest N profiles. */
  maxProfiles: number;
  /** ...and at most this many bytes of profiles + sidecars. */
  maxTotalBytes: number;
  /** A single profile + sidecar larger than this is skipped. */
  maxProfileBytes: number;
  /** At most one write per this interval; a stalled window inside it is extended, not lost. */
  minWriteIntervalMs: number;
  /** An extended (rate-limited) window is cut and discarded at this age. */
  maxWindowMs: number;
  /** Never write when the volume would drop below this much free space. */
  minFreeBytes: number;
  /** A bridged Profiler.start slower than this means the heap is being walked: self-disable. */
  maxStartMs: number;
  disabledReason?: string;
};

export const STALL_PROFILER_DEFAULTS = {
  windowMs: 60_000,
  tickMs: 5_000,
  sampleIntervalUs: 10_000,
  stallThresholdMs: 5_000,
  resumeTriggerMs: 30_000,
  maxProfiles: 30,
  maxTotalBytes: 300 * MB,
  maxProfileBytes: 64 * MB,
  minWriteIntervalMs: 120_000,
  maxWindowMs: 300_000,
  minFreeBytes: 1024 * MB,
  maxStartMs: 1_000
} as const;

function intEnv(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

type ConfigProbe = { exists?: (path: string) => boolean; tmpdir?: () => string };

export function resolveStallProfilerConfig(
  env: NodeJS.ProcessEnv = process.env,
  probe: ConfigProbe = {}
): StallProfilerConfig {
  const exists = probe.exists ?? existsSync;
  const tmp = probe.tmpdir ?? tmpdir;
  const d = STALL_PROFILER_DEFAULTS;

  const flag = (env.STALL_PROFILER ?? "").trim().toLowerCase();
  let enabled: boolean;
  let disabledReason: string | undefined;
  if (env.VITEST) {
    enabled = false;
    disabledReason = "vitest (tests inject a fake session; never profile the test runner)";
  } else if (["0", "off", "false", "no"].includes(flag)) {
    enabled = false;
    disabledReason = "STALL_PROFILER=0";
  } else if (["1", "on", "true", "yes"].includes(flag)) {
    enabled = true;
  } else {
    enabled = env.NODE_ENV === "production";
    if (!enabled) disabledReason = "not production (set STALL_PROFILER=1 to enable)";
  }

  const configuredDir = env.STALL_PROFILER_DIR?.trim();
  let dir: string;
  if (configuredDir) dir = configuredDir;
  else {
    let hasAppData = false;
    try {
      hasAppData = exists("/app/data");
    } catch {
      hasAppData = false;
    }
    dir = hasAppData ? "/app/data/profiles" : join(tmp(), "stall-profiles");
  }

  const windowMs = intEnv(env.STALL_PROFILER_WINDOW_MS, d.windowMs, 10_000, 600_000);
  const maxTotalBytes = intEnv(env.STALL_PROFILER_MAX_MB, d.maxTotalBytes / MB, 16, 10_000) * MB;
  return {
    enabled,
    dir,
    windowMs,
    tickMs: Math.min(d.tickMs, Math.max(1_000, Math.floor(windowMs / 4))),
    sampleIntervalUs: intEnv(env.STALL_PROFILER_SAMPLE_US, d.sampleIntervalUs, 1_000, 100_000),
    stallThresholdMs: intEnv(env.STALL_PROFILER_THRESHOLD_MS, d.stallThresholdMs, 500, 600_000),
    resumeTriggerMs: d.resumeTriggerMs,
    maxProfiles: intEnv(env.STALL_PROFILER_MAX_FILES, d.maxProfiles, 1, 500),
    maxTotalBytes,
    maxProfileBytes: Math.min(d.maxProfileBytes, Math.floor(maxTotalBytes / 3)),
    minWriteIntervalMs: d.minWriteIntervalMs,
    maxWindowMs: Math.max(d.maxWindowMs, windowMs * 2),
    minFreeBytes: d.minFreeBytes,
    maxStartMs: d.maxStartMs,
    disabledReason
  };
}

/** The slice of node:inspector's in-thread Session this module uses, promise-shaped. */
export type InspectorSessionLike = {
  post(method: string, params?: Record<string, unknown>): Promise<unknown>;
  on(event: string, listener: (message: unknown) => void): void;
  disconnect(): void;
};

/** V8's own console (node:inspector `console`), used only for the keepalive profile. */
export type ConsoleBridgeLike = {
  profile(label: string): void;
  profileEnd(label: string): void;
};

export type StallProfilerFs = {
  mkdirSync(path: string, options: { recursive: true }): unknown;
  readdirSync(path: string): string[];
  statSync(path: string): { size: number };
  unlinkSync(path: string): void;
  writeFileSync(path: string, data: string): void;
  renameSync(from: string, to: string): void;
};

const nodeFs: StallProfilerFs = {
  mkdirSync: (path, options) => mkdirSync(path, options),
  readdirSync: (path) => readdirSync(path),
  statSync: (path) => statSync(path),
  unlinkSync: (path) => unlinkSync(path),
  writeFileSync: (path, data) => writeFileSync(path, data),
  renameSync: (from, to) => renameSync(from, to)
};

export type StallProfilerDeps = {
  session: InspectorSessionLike;
  bridge: ConsoleBridgeLike;
  now: () => number;
  stalledMsSince: (sinceMs: number) => number;
  log: (message: string) => void;
  fs?: StallProfilerFs;
  /** Free bytes on the volume holding `dir`, or null when unknown. */
  freeBytes?: (dir: string) => number | null;
  schedule?: (fn: () => void, everyMs: number) => { cancel(): void };
  subscribeStallResume?: (minLagMs: number, fn: (lagMs: number) => void) => () => void;
  startLagSampler?: () => void;
};

export type StallProfilerState = "disabled" | "idle" | "running" | "failed" | "stopped";

export type StallProfilerStatus = {
  state: StallProfilerState;
  reason?: string;
  dir?: string;
  written: number;
  skipped: number;
  lastWrittenPath?: string;
  lastWriteAt?: string;
  windowStartedAt?: string;
};

type Trigger = "window" | "resume";

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function compactStamp(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

function isCpuProfile(value: unknown): value is CpuProfile {
  return (
    !!value &&
    typeof value === "object" &&
    Array.isArray((value as { nodes?: unknown }).nodes) &&
    typeof (value as { startTime?: unknown }).startTime === "number"
  );
}

function readTitle(message: unknown): string | undefined {
  const params = (message as { params?: { title?: unknown } } | null)?.params;
  return typeof params?.title === "string" ? params.title : undefined;
}

function defaultFreeBytes(dir: string): number | null {
  try {
    const stats = statfsSync(dir);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
}

function defaultSchedule(fn: () => void, everyMs: number): { cancel(): void } {
  const timer = setInterval(fn, everyMs);
  timer.unref?.();
  return { cancel: () => clearInterval(timer) };
}

function isFlat(value: unknown): boolean {
  if (value === null || typeof value !== "object") return true;
  return Object.values(value as Record<string, unknown>).every((v) => v === null || typeof v !== "object");
}

/**
 * JSON with one table row per line, so `cat <name>.top.json` over SSH reads like a table.
 * Arrays put each element on its own line (flat rows compact); objects nest with indentation.
 */
export function stringifyForCat(value: unknown, indent = ""): string {
  const inner = `${indent}  `;
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const rows = value.map((item) =>
      isFlat(item) ? `${inner}${JSON.stringify(item) ?? "null"}` : `${inner}${stringifyForCat(item, inner)}`
    );
    return `[\n${rows.join(",\n")}\n${indent}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return "{}";
    const rows = entries.map(([key, v]) => `${inner}${JSON.stringify(key)}: ${stringifyForCat(v, inner)}`);
    return `{\n${rows.join(",\n")}\n${indent}}`;
  }
  return JSON.stringify(value) ?? "null";
}

const PROFILE_FILE_RE = /^(stall-.+?)\.(cpuprofile|top\.json)(\.tmp)?$/;

/**
 * Retention for the profile directory.  Only files this module writes (`stall-*.cpuprofile`,
 * `stall-*.top.json`, and their `.tmp` staging names) are ever touched.  Orphaned `.tmp` files
 * from an interrupted write are always removed; then whole profile+sidecar pairs are deleted
 * oldest-first (names sort chronologically) until both limits hold.
 */
export function pruneStallProfiles(
  dir: string,
  limits: { maxProfiles: number; maxTotalBytes: number },
  fs: StallProfilerFs = nodeFs
): { removed: string[]; keptProfiles: number; keptBytes: number } {
  const removed: string[] = [];
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return { removed, keptProfiles: 0, keptBytes: 0 };
  }
  const groups = new Map<string, { files: string[]; bytes: number }>();
  for (const name of names) {
    const match = PROFILE_FILE_RE.exec(name);
    if (!match) continue;
    if (match[3]) {
      try {
        fs.unlinkSync(join(dir, name));
        removed.push(name);
      } catch {
        // Best effort: a racing delete is fine.
      }
      continue;
    }
    let size = 0;
    try {
      size = fs.statSync(join(dir, name)).size;
    } catch {
      size = 0;
    }
    const group = groups.get(match[1]) ?? { files: [], bytes: 0 };
    group.files.push(name);
    group.bytes += size;
    groups.set(match[1], group);
  }
  const ordered = [...groups.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  let count = ordered.length;
  let total = ordered.reduce((sum, [, group]) => sum + group.bytes, 0);
  const maxProfiles = Math.max(0, limits.maxProfiles);
  const maxBytes = Math.max(0, limits.maxTotalBytes);
  for (const [, group] of ordered) {
    if (count <= maxProfiles && total <= maxBytes) break;
    for (const file of group.files) {
      try {
        fs.unlinkSync(join(dir, file));
        removed.push(file);
      } catch {
        // Best effort.
      }
    }
    count -= 1;
    total -= group.bytes;
  }
  return { removed, keptProfiles: count, keptBytes: total };
}

/**
 * The rotation / decision / retention engine.  All I/O and time are injected so the tests can
 * drive it with a fake session and a manual clock; `startStallProfiler` wires the real ones.
 */
export class StallProfiler {
  private readonly config: StallProfilerConfig;
  private readonly deps: StallProfilerDeps;
  private readonly fs: StallProfilerFs;
  private state: StallProfilerState = "idle";
  private reason: string | undefined;
  private windowStartedAt = 0;
  private lastWriteAt: number | undefined;
  private lastWrittenPath: string | undefined;
  private written = 0;
  private skipped = 0;
  private busy = false;
  private bridgeSeq = 0;
  private lastBridgeStarted: string | null = null;
  private timer: { cancel(): void } | null = null;
  private unsubscribe: (() => void) | null = null;
  private readonly skipLoggedAt = new Map<string, number>();

  constructor(config: StallProfilerConfig, deps: StallProfilerDeps) {
    this.config = config;
    this.deps = deps;
    this.fs = deps.fs ?? nodeFs;
  }

  status(): StallProfilerStatus {
    return {
      state: this.state,
      reason: this.reason,
      dir: this.config.dir,
      written: this.written,
      skipped: this.skipped,
      lastWrittenPath: this.lastWrittenPath,
      lastWriteAt: this.lastWriteAt === undefined ? undefined : new Date(this.lastWriteAt).toISOString(),
      windowStartedAt:
        this.state === "running" ? new Date(this.windowStartedAt).toISOString() : undefined
    };
  }

  /** Arm the profiler.  Resolves false (never rejects) when arming fails. */
  async start(): Promise<boolean> {
    if (this.state !== "idle") return this.state === "running";
    const cfg = this.config;
    try {
      this.deps.session.on("Profiler.consoleProfileStarted", (message) => {
        const title = readTitle(message);
        if (title) this.lastBridgeStarted = title;
      });
      await this.deps.session.post("Profiler.enable");
      await this.deps.session.post("Profiler.setSamplingInterval", { interval: cfg.sampleIntervalUs });
      const t0 = this.deps.now();
      await this.deps.session.post("Profiler.start");
      const initialStartMs = this.deps.now() - t0;
      this.windowStartedAt = this.deps.now();
      this.state = "running";
      (this.deps.startLagSampler ?? startEventLoopLagSampler)();
      const subscribe = this.deps.subscribeStallResume ?? onEventLoopStall;
      this.unsubscribe = subscribe(cfg.resumeTriggerMs, (lagMs) => {
        void this.tick("resume", lagMs);
      });
      this.timer = (this.deps.schedule ?? defaultSchedule)(() => {
        void this.tick("window");
      }, cfg.tickMs);
      this.deps.log(
        `[stall-profiler] armed dir=${cfg.dir} windowMs=${cfg.windowMs} sampleUs=${cfg.sampleIntervalUs} ` +
          `thresholdMs=${cfg.stallThresholdMs} resumeTriggerMs=${cfg.resumeTriggerMs} ` +
          `maxProfiles=${cfg.maxProfiles} maxMB=${Math.round(cfg.maxTotalBytes / MB)} ` +
          `(initial Profiler.start ${initialStartMs}ms)`
      );
      return true;
    } catch (err) {
      this.fail(`arming failed: ${describeError(err)}`);
      return false;
    }
  }

  /**
   * Periodic window check ("window") or the lag sampler's resume signal ("resume").  Never
   * rejects: any failure self-disables the profiler.
   */
  async tick(trigger: Trigger = "window", resumeLagMs?: number): Promise<void> {
    if (this.state !== "running" || this.busy) return;
    this.busy = true;
    try {
      await this.rotateIfDue(trigger, resumeLagMs);
    } catch (err) {
      this.fail(describeError(err));
    } finally {
      this.busy = false;
    }
  }

  /** Tear down (idempotent).  Used on shutdown and by tests. */
  stop(reason = "stopped"): void {
    if (this.state === "stopped" || this.state === "failed") return;
    this.state = "stopped";
    this.reason = reason;
    this.teardown();
  }

  private async rotateIfDue(trigger: Trigger, resumeLagMs?: number): Promise<void> {
    const cfg = this.config;
    const now = this.deps.now();
    const windowStartedAt = this.windowStartedAt;
    const windowAge = now - windowStartedAt;
    if (windowAge < MIN_WINDOW_MS) return;
    if (trigger === "window" && windowAge < cfg.windowMs) return;

    const stalledMs = this.deps.stalledMsSince(windowStartedAt);
    const stalled = stalledMs >= cfg.stallThresholdMs;
    if (trigger === "resume" && !stalled) return;

    const sinceLastWrite = this.lastWriteAt === undefined ? Infinity : now - this.lastWriteAt;
    const rateLimited = stalled && sinceLastWrite < cfg.minWriteIntervalMs;
    // Rate-limited: keep sampling into the same window so this stall is still in the profile
    // when a write is allowed again, instead of throwing the evidence away.
    if (rateLimited && windowAge < cfg.maxWindowMs) return;

    const { profile, startMs } = await this.restart();
    this.windowStartedAt = this.deps.now();

    if (stalled) {
      if (rateLimited) {
        this.skip(
          "rate-limited",
          `stalled window stalledMs=${stalledMs} windowMs=${windowAge}: rate-limited (last write ` +
            `${sinceLastWrite}ms ago, limit ${cfg.minWriteIntervalMs}ms) and the window reached ` +
            `maxWindowMs=${cfg.maxWindowMs}`
        );
      } else {
        this.write(profile, { stalledMs, windowStartedAt, windowEndedAt: now, trigger, resumeLagMs });
      }
    }

    if (startMs > cfg.maxStartMs) {
      throw new Error(
        `Profiler.start took ${startMs}ms (> ${cfg.maxStartMs}ms): the bridged restart is walking ` +
          `the heap, which would itself stall the loop`
      );
    }
  }

  private bridgeObserved(label: string): boolean {
    return this.lastBridgeStarted === label;
  }

  /** Bridged stop+start: the keepalive console profile keeps V8's CpuProfiler alive. */
  private async restart(): Promise<{ profile: CpuProfile; startMs: number }> {
    const label = `stall-profiler-bridge-${++this.bridgeSeq}`;
    this.lastBridgeStarted = null;
    this.deps.bridge.profile(label);
    if (!this.bridgeObserved(label)) {
      throw new Error(
        "keepalive console.profile() did not start (no Profiler.consoleProfileStarted); refusing " +
          "an unbridged restart, which makes V8 re-walk the whole heap on the live event loop"
      );
    }
    let profile: unknown;
    let startMs = 0;
    try {
      const stopped = (await this.deps.session.post("Profiler.stop")) as { profile?: unknown } | undefined;
      profile = stopped?.profile;
      const t0 = this.deps.now();
      await this.deps.session.post("Profiler.start");
      startMs = this.deps.now() - t0;
    } finally {
      try {
        this.deps.bridge.profileEnd(label);
      } catch {
        // The keepalive's own profile is discarded either way.
      }
    }
    if (!isCpuProfile(profile)) throw new Error("Profiler.stop returned no profile");
    return { profile, startMs };
  }

  private write(
    profile: CpuProfile,
    meta: {
      stalledMs: number;
      windowStartedAt: number;
      windowEndedAt: number;
      trigger: Trigger;
      resumeLagMs?: number;
    }
  ): void {
    const cfg = this.config;
    const summary = summarizeCpuProfile(profile, { top: 40 });
    const base = `stall-${compactStamp(meta.windowEndedAt)}-${meta.stalledMs}ms`;
    const profileFile = `${base}.cpuprofile`;
    const sidecar = {
      file: profileFile,
      writtenAt: new Date(this.deps.now()).toISOString(),
      trigger: meta.trigger,
      stalledMs: meta.stalledMs,
      resumeLagMs: meta.resumeLagMs,
      windowStartedAt: new Date(meta.windowStartedAt).toISOString(),
      windowEndedAt: new Date(meta.windowEndedAt).toISOString(),
      windowMs: meta.windowEndedAt - meta.windowStartedAt,
      thresholdMs: cfg.stallThresholdMs,
      sampleIntervalUs: cfg.sampleIntervalUs,
      pid: process.pid,
      howTo:
        "Locations are url:line:col (1-based).  Full table: node scripts/ops/summarize-cpuprofile.mjs " +
        "<this file>.  Flame graph: open the .cpuprofile in Chrome DevTools > Performance or speedscope.app.",
      ...summary
    };
    const profileJson = JSON.stringify(profile);
    const sidecarJson = `${stringifyForCat(sidecar)}\n`;
    const bytes = Buffer.byteLength(profileJson) + Buffer.byteLength(sidecarJson);
    if (bytes > cfg.maxProfileBytes) {
      this.skip(
        "too-large",
        `stalled window stalledMs=${meta.stalledMs}: profile is ${Math.round(bytes / MB)}MB ` +
          `(> ${Math.round(cfg.maxProfileBytes / MB)}MB per-file cap)`
      );
      return;
    }

    this.fs.mkdirSync(cfg.dir, { recursive: true });
    const free = (this.deps.freeBytes ?? defaultFreeBytes)(cfg.dir);
    if (free !== null && free - bytes < cfg.minFreeBytes) {
      this.skip(
        "low-disk",
        `stalled window stalledMs=${meta.stalledMs}: only ${Math.round(free / MB)}MB free on ${cfg.dir} ` +
          `(floor ${Math.round(cfg.minFreeBytes / MB)}MB + ${Math.round(bytes / MB)}MB profile)`
      );
      return;
    }

    // Make room first (count and bytes include the pair about to land) so the cap always holds.
    pruneStallProfiles(
      cfg.dir,
      { maxProfiles: cfg.maxProfiles - 1, maxTotalBytes: cfg.maxTotalBytes - bytes },
      this.fs
    );
    const profilePath = join(cfg.dir, profileFile);
    this.writeAtomic(profilePath, profileJson);
    this.writeAtomic(join(cfg.dir, `${base}.top.json`), sidecarJson);

    this.lastWriteAt = this.deps.now();
    this.lastWrittenPath = profilePath;
    this.written += 1;
    const topSelf = summary.topSelf[0] ? formatFunctionTiming(summary.topSelf[0]) : "(none)";
    this.deps.log(
      `[stall-profiler] wrote ${profilePath} stalledMs=${meta.stalledMs} topSelf=${topSelf} ` +
        `trigger=${meta.trigger} windowMs=${meta.windowEndedAt - meta.windowStartedAt} ` +
        `busyRunMs=${summary.longestBusyRun?.durationMs ?? 0}`
    );
  }

  private writeAtomic(path: string, data: string): void {
    const staging = `${path}.tmp`;
    this.fs.writeFileSync(staging, data);
    this.fs.renameSync(staging, path);
  }

  private skip(kind: string, detail: string): void {
    this.skipped += 1;
    const now = this.deps.now();
    const last = this.skipLoggedAt.get(kind);
    if (last !== undefined && now - last < SKIP_LOG_INTERVAL_MS) return;
    this.skipLoggedAt.set(kind, now);
    this.deps.log(`[stall-profiler] skipped ${detail}`);
  }

  private fail(reason: string): void {
    if (this.state === "failed" || this.state === "stopped") return;
    this.state = "failed";
    this.reason = reason;
    this.teardown();
    this.deps.log(`[stall-profiler] disabled after failure (no further profiles this process): ${reason}`);
  }

  private teardown(): void {
    try {
      this.timer?.cancel();
    } catch {
      // ignore
    }
    this.timer = null;
    try {
      this.unsubscribe?.();
    } catch {
      // ignore
    }
    this.unsubscribe = null;
    for (const method of ["Profiler.stop", "Profiler.disable"]) {
      try {
        void this.deps.session.post(method).catch(() => {});
      } catch {
        // ignore
      }
    }
    try {
      this.deps.session.disconnect();
    } catch {
      // ignore
    }
  }
}

// ---- process singleton -------------------------------------------------------------------

type RawInspectorSession = {
  connect(): void;
  disconnect(): void;
  post(method: string, params: object, callback: (err: Error | null, result?: unknown) => void): void;
  on(event: string, listener: (message: unknown) => void): unknown;
};

type InspectorModuleLike = {
  Session: new () => RawInspectorSession;
  console?: unknown;
};

type ProfilerHost = {
  __stallProfiler?: StallProfiler;
  __stallProfilerStarting?: Promise<StallProfilerStatus>;
  __stallProfilerStatus?: StallProfilerStatus;
};

const profilerHost = globalThis as unknown as ProfilerHost;

async function createInspectorBindings(): Promise<{ session: InspectorSessionLike; bridge: ConsoleBridgeLike }> {
  // webpackIgnore: resolved by Node at runtime, never bundled (same pattern as node:dns in
  // instrumentation.ts).  Throws ERR_INSPECTOR_NOT_AVAILABLE on a Node built without inspector.
  const inspector = (await import(/* webpackIgnore: true */ "node:inspector")) as unknown as InspectorModuleLike;
  const v8Console = inspector.console as
    | { profile?: (label: string) => void; profileEnd?: (label: string) => void }
    | undefined;
  const profile = v8Console?.profile;
  const profileEnd = v8Console?.profileEnd;
  if (typeof profile !== "function" || typeof profileEnd !== "function") {
    throw new Error("node:inspector console.profile is unavailable");
  }
  const raw = new inspector.Session();
  raw.connect();
  return {
    session: {
      post: (method, params) =>
        new Promise((resolve, reject) => {
          raw.post(method, params ?? {}, (err, result) => (err ? reject(err) : resolve(result)));
        }),
      on: (event, listener) => {
        raw.on(event, listener);
      },
      disconnect: () => raw.disconnect()
    },
    bridge: {
      profile: (label) => profile.call(v8Console, label),
      profileEnd: (label) => profileEnd.call(v8Console, label)
    }
  };
}

/**
 * Boot entry point (instrumentation.ts).  Idempotent and HMR-safe: at most one inspector session
 * per process.  Never rejects; resolves the resulting status.
 */
export function startStallProfiler(env: NodeJS.ProcessEnv = process.env): Promise<StallProfilerStatus> {
  if (profilerHost.__stallProfilerStarting) return profilerHost.__stallProfilerStarting;
  const starting = (async (): Promise<StallProfilerStatus> => {
    try {
      const config = resolveStallProfilerConfig(env);
      if (!config.enabled) {
        profilerHost.__stallProfilerStatus = {
          state: "disabled",
          reason: config.disabledReason,
          written: 0,
          skipped: 0
        };
        return profilerHost.__stallProfilerStatus;
      }
      const bindings = await createInspectorBindings();
      const profiler = new StallProfiler(config, {
        ...bindings,
        now: () => Date.now(),
        stalledMsSince,
        log: (message) => console.warn(message)
      });
      profilerHost.__stallProfiler = profiler;
      await profiler.start();
      return profiler.status();
    } catch (err) {
      const reason = `unavailable: ${describeError(err)}`;
      try {
        console.warn(`[stall-profiler] disabled: ${reason}`);
      } catch {
        // never throw into boot
      }
      profilerHost.__stallProfilerStatus = { state: "failed", reason, written: 0, skipped: 0 };
      return profilerHost.__stallProfilerStatus;
    }
  })();
  profilerHost.__stallProfilerStarting = starting;
  return starting;
}

/** Current status for diagnostics (e.g. a future ops-snapshot field). */
export function getStallProfilerStatus(): StallProfilerStatus {
  return (
    profilerHost.__stallProfiler?.status() ??
    profilerHost.__stallProfilerStatus ?? { state: "idle", written: 0, skipped: 0 }
  );
}
