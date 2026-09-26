// cpuprofile-summary.ts — turn a V8 `.cpuprofile` into "which function pinned the event loop".
//
// Shared by the stall profiler (src/lib/stall-profiler.ts), which writes the result beside each
// profile as `<name>.top.json`, and by `scripts/ops/summarize-cpuprofile.mjs`, which prints the
// same table for any `.cpuprofile` an operator copies off the box.  The script imports this file
// directly through Node 24's built-in TypeScript stripping, so this module must stay
// self-contained: NO imports, and only erasable TypeScript syntax (no enums, no namespaces, no
// parameter properties).
//
// Conventions (match Chrome DevTools so numbers agree with what an operator sees there):
//   * a sample's duration is the gap to the NEXT sample (the last one runs to `endTime`);
//   * self time of a function = time its frame was the leaf of a sampled stack;
//   * total time = time it appeared anywhere on the stack, counted once per sample even when
//     it recurses or calls itself through another frame;
//   * `(idle)` is the loop waiting in epoll, `(program)` is VM-native work with no JS frame, and
//     `(garbage collector)` is GC.  `(root)` and `(idle)` are never reported as culprits; GC and
//     `(program)` are, because a stall inside either is a real finding.
//   * `.cpuprofile` line/column numbers are 0-based; everything this module prints is 1-based,
//     `url:line:col`.  The column matters: Next.js server chunks are minified onto one line.

export type CpuProfileCallFrame = {
  functionName: string;
  url: string;
  lineNumber: number;
  columnNumber: number;
  scriptId?: string | number;
};

export type CpuProfileNode = {
  id: number;
  callFrame: CpuProfileCallFrame;
  hitCount?: number;
  children?: number[];
};

export type CpuProfile = {
  nodes: CpuProfileNode[];
  startTime: number;
  endTime: number;
  samples?: number[];
  timeDeltas?: number[];
};

export type FunctionTiming = {
  function: string;
  location: string;
  selfMs: number;
  selfPct: number;
  totalMs: number;
  totalPct: number;
};

export type HotStack = {
  selfMs: number;
  selfPct: number;
  /** Leaf first, each `fn@url:line:col`. */
  frames: string[];
};

export type BusyRun = {
  startOffsetMs: number;
  durationMs: number;
  topSelf: FunctionTiming[];
};

export type CpuProfileSummary = {
  durationMs: number;
  sampleCount: number;
  avgSampleIntervalMs: number;
  busyMs: number;
  idleMs: number;
  gcMs: number;
  programMs: number;
  /** The longest stretch with no `(idle)` sample — during a stall, the stall itself. */
  longestBusyRun: BusyRun | null;
  topSelf: FunctionTiming[];
  topTotal: FunctionTiming[];
  hotStacks: HotStack[];
};

export type SummarizeOptions = {
  /** Rows in topSelf / topTotal.  Default 40. */
  top?: number;
  /** Number of hottest leaf stacks.  Default 10. */
  hotStacks?: number;
  /** Frames kept per hot stack.  Default 40. */
  stackDepth?: number;
  /** Rows in longestBusyRun.topSelf.  Default 10. */
  runTop?: number;
};

const ROOT = "(root)";
const IDLE = "(idle)";
const GC = "(garbage collector)";
const PROGRAM = "(program)";

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function displayName(frame: CpuProfileCallFrame): string {
  return frame.functionName && frame.functionName.length > 0 ? frame.functionName : "(anonymous)";
}

function displayLocation(frame: CpuProfileCallFrame): string {
  if (!frame.url) return "(native)";
  const line = (frame.lineNumber ?? -1) + 1;
  const col = (frame.columnNumber ?? -1) + 1;
  if (line <= 0) return frame.url;
  return col > 0 ? `${frame.url}:${line}:${col}` : `${frame.url}:${line}`;
}

function isSynthetic(name: string): boolean {
  return name === ROOT || name === IDLE || name === GC || name === PROGRAM;
}

/** `fn@url:line:col`, or just the name for V8's synthetic `(program)` / `(garbage collector)`. */
export function formatFunctionTiming(timing: Pick<FunctionTiming, "function" | "location">): string {
  if (isSynthetic(timing.function) && timing.location === "(native)") return timing.function;
  return `${timing.function}@${timing.location}`;
}

function frameLabel(frame: CpuProfileCallFrame): string {
  return formatFunctionTiming({ function: displayName(frame), location: displayLocation(frame) });
}

function functionKey(frame: CpuProfileCallFrame): string {
  return `${frame.functionName}\u0000${frame.url}\u0000${frame.lineNumber}\u0000${frame.columnNumber}`;
}

/**
 * Per-sample durations in microseconds, DevTools-style: each sample lasts until the next one.
 * Negative deltas (V8 occasionally records samples slightly out of order) clamp to zero.
 */
function sampleDurationsUs(profile: CpuProfile): { ids: number[]; durations: number[] } | null {
  const samples = profile.samples;
  const deltas = profile.timeDeltas;
  if (!Array.isArray(samples) || !Array.isArray(deltas) || samples.length === 0) return null;
  const n = samples.length;
  const stamps = new Array<number>(n);
  let t = profile.startTime;
  for (let i = 0; i < n; i++) {
    t += deltas[i] ?? 0;
    stamps[i] = t;
  }
  const durations = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const next = i + 1 < n ? stamps[i + 1] : Math.max(profile.endTime, stamps[i]);
    durations[i] = Math.max(0, next - stamps[i]);
  }
  return { ids: samples, durations };
}

export function summarizeCpuProfile(profile: CpuProfile, options: SummarizeOptions = {}): CpuProfileSummary {
  const top = Math.max(1, options.top ?? 40);
  const hotCount = Math.max(0, options.hotStacks ?? 10);
  const depth = Math.max(1, options.stackDepth ?? 40);
  const runTop = Math.max(1, options.runTop ?? 10);

  const nodes = Array.isArray(profile.nodes) ? profile.nodes : [];
  const byId = new Map<number, CpuProfileNode>();
  const parentOf = new Map<number, number>();
  for (const node of nodes) byId.set(node.id, node);
  for (const node of nodes) for (const child of node.children ?? []) parentOf.set(child, node.id);

  // ---- self time per node (µs) -----------------------------------------------------------
  const selfUs = new Map<number, number>();
  const timed = sampleDurationsUs(profile);
  let sampleCount = 0;
  if (timed) {
    sampleCount = timed.ids.length;
    for (let i = 0; i < timed.ids.length; i++) {
      const id = timed.ids[i];
      selfUs.set(id, (selfUs.get(id) ?? 0) + timed.durations[i]);
    }
  } else {
    // Legacy shape without samples/timeDeltas: spread wall time evenly over hitCounts.
    const hits = nodes.reduce((sum, node) => sum + (node.hitCount ?? 0), 0);
    sampleCount = hits;
    const per = hits > 0 ? Math.max(0, profile.endTime - profile.startTime) / hits : 0;
    for (const node of nodes) if (node.hitCount) selfUs.set(node.id, node.hitCount * per);
  }

  let totalUs = 0;
  for (const us of selfUs.values()) totalUs += us;
  const pct = (us: number) => (totalUs > 0 ? round1((us / totalUs) * 100) : 0);
  const ms = (us: number) => Math.round(us / 1000);

  // ---- synthetic buckets -----------------------------------------------------------------
  let idleUs = 0;
  let gcUs = 0;
  let programUs = 0;
  for (const [id, us] of selfUs) {
    const name = byId.get(id)?.callFrame.functionName;
    if (name === IDLE) idleUs += us;
    else if (name === GC) gcUs += us;
    else if (name === PROGRAM) programUs += us;
  }

  // ---- subtree totals (iterative post-order: deep recursive stacks must not overflow) --------
  const roots = nodes.filter((node) => !parentOf.has(node.id));
  const order: number[] = [];
  const walk = roots.map((node) => node.id);
  while (walk.length > 0) {
    const id = walk.pop()!;
    order.push(id);
    for (const child of byId.get(id)?.children ?? []) walk.push(child);
  }
  const subtreeUs = new Map<number, number>();
  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i];
    let sum = selfUs.get(id) ?? 0;
    for (const child of byId.get(id)?.children ?? []) sum += subtreeUs.get(child) ?? 0;
    subtreeUs.set(id, sum);
  }

  // ---- per-function self and total (outermost occurrence only, so recursion counts once) ----
  type Acc = { frame: CpuProfileCallFrame; selfUs: number; totalUs: number };
  const byFunction = new Map<string, Acc>();
  const acc = (frame: CpuProfileCallFrame): Acc => {
    const key = functionKey(frame);
    let entry = byFunction.get(key);
    if (!entry) {
      entry = { frame, selfUs: 0, totalUs: 0 };
      byFunction.set(key, entry);
    }
    return entry;
  };
  for (const [id, us] of selfUs) {
    const node = byId.get(id);
    if (node) acc(node.callFrame).selfUs += us;
  }
  const active = new Map<string, number>();
  const stack: Array<{ id: number; exit: boolean }> = roots.map((node) => ({ id: node.id, exit: false }));
  while (stack.length > 0) {
    const { id, exit } = stack.pop()!;
    const node = byId.get(id);
    if (!node) continue;
    const key = functionKey(node.callFrame);
    if (exit) {
      active.set(key, (active.get(key) ?? 1) - 1);
      continue;
    }
    if (!active.get(key)) acc(node.callFrame).totalUs += subtreeUs.get(id) ?? 0;
    active.set(key, (active.get(key) ?? 0) + 1);
    stack.push({ id, exit: true });
    for (const child of node.children ?? []) stack.push({ id: child, exit: false });
  }

  const reportable = [...byFunction.values()].filter((entry) => {
    const name = entry.frame.functionName;
    return name !== ROOT && name !== IDLE;
  });
  const toTiming = (entry: Acc): FunctionTiming => ({
    function: displayName(entry.frame),
    location: displayLocation(entry.frame),
    selfMs: ms(entry.selfUs),
    selfPct: pct(entry.selfUs),
    totalMs: ms(entry.totalUs),
    totalPct: pct(entry.totalUs)
  });
  const topSelf = reportable
    .filter((entry) => entry.selfUs > 0)
    .sort((a, b) => b.selfUs - a.selfUs)
    .slice(0, top)
    .map(toTiming);
  const topTotal = reportable
    .filter((entry) => entry.totalUs > 0)
    .sort((a, b) => b.totalUs - a.totalUs)
    .slice(0, top)
    .map(toTiming);

  // ---- hottest leaf stacks ---------------------------------------------------------------
  const stackOf = (id: number): string[] => {
    const frames: string[] = [];
    let cursor: number | undefined = id;
    while (cursor !== undefined && frames.length < depth) {
      const node = byId.get(cursor);
      if (!node) break;
      if (node.callFrame.functionName !== ROOT) frames.push(frameLabel(node.callFrame));
      cursor = parentOf.get(cursor);
    }
    return frames;
  };
  const hotStacks: HotStack[] = [...selfUs.entries()]
    .filter(([id, us]) => {
      const name = byId.get(id)?.callFrame.functionName;
      return us > 0 && name !== ROOT && name !== IDLE;
    })
    .sort((a, b) => b[1] - a[1])
    .slice(0, hotCount)
    .map(([id, us]) => ({ selfMs: ms(us), selfPct: pct(us), frames: stackOf(id) }));

  // ---- longest busy run (no (idle) sample inside it) ---------------------------------------
  let longestBusyRun: BusyRun | null = null;
  if (timed) {
    let bestStart = -1;
    let bestEnd = -1;
    let bestUs = 0;
    let runStart = -1;
    let runUs = 0;
    for (let i = 0; i <= timed.ids.length; i++) {
      const idle = i === timed.ids.length || byId.get(timed.ids[i])?.callFrame.functionName === IDLE;
      if (idle) {
        if (runStart >= 0 && runUs > bestUs) {
          bestUs = runUs;
          bestStart = runStart;
          bestEnd = i;
        }
        runStart = -1;
        runUs = 0;
        continue;
      }
      if (runStart < 0) runStart = i;
      runUs += timed.durations[i];
    }
    if (bestStart >= 0) {
      let offsetUs = 0;
      for (let i = 0; i < bestStart; i++) offsetUs += timed.durations[i];
      const runSelf = new Map<string, Acc>();
      for (let i = bestStart; i < bestEnd; i++) {
        const node = byId.get(timed.ids[i]);
        if (!node) continue;
        const key = functionKey(node.callFrame);
        let entry = runSelf.get(key);
        if (!entry) {
          entry = { frame: node.callFrame, selfUs: 0, totalUs: 0 };
          runSelf.set(key, entry);
        }
        entry.selfUs += timed.durations[i];
      }
      longestBusyRun = {
        startOffsetMs: ms(offsetUs),
        durationMs: ms(bestUs),
        topSelf: [...runSelf.values()]
          .filter((entry) => entry.frame.functionName !== ROOT)
          .sort((a, b) => b.selfUs - a.selfUs)
          .slice(0, runTop)
          .map((entry) => ({
            function: displayName(entry.frame),
            location: displayLocation(entry.frame),
            selfMs: ms(entry.selfUs),
            selfPct: bestUs > 0 ? round1((entry.selfUs / bestUs) * 100) : 0,
            totalMs: 0,
            totalPct: 0
          }))
      };
    }
  }

  return {
    durationMs: ms(totalUs),
    sampleCount,
    avgSampleIntervalMs: sampleCount > 0 ? round1(totalUs / sampleCount / 1000) : 0,
    busyMs: ms(totalUs - idleUs),
    idleMs: ms(idleUs),
    gcMs: ms(gcUs),
    programMs: ms(programUs),
    longestBusyRun,
    topSelf,
    topTotal,
    hotStacks
  };
}

function pad(value: string | number, width: number): string {
  const text = String(value);
  return text.length >= width ? text : " ".repeat(width - text.length) + text;
}

/** Plain-text report — what `scripts/ops/summarize-cpuprofile.mjs` prints. */
export function formatCpuProfileSummary(summary: CpuProfileSummary, header?: Record<string, unknown>): string {
  const lines: string[] = [];
  if (header) {
    for (const [key, value] of Object.entries(header)) {
      if (value !== undefined && value !== null) lines.push(`${key}: ${value}`);
    }
  }
  const share = (n: number) => (summary.durationMs > 0 ? `${round1((n / summary.durationMs) * 100)}%` : "0%");
  lines.push(
    `profile: ${summary.durationMs}ms, ${summary.sampleCount} samples @ ~${summary.avgSampleIntervalMs}ms; ` +
      `busy ${summary.busyMs}ms (${share(summary.busyMs)}), idle ${summary.idleMs}ms, ` +
      `gc ${summary.gcMs}ms, program ${summary.programMs}ms`
  );
  if (summary.longestBusyRun) {
    const run = summary.longestBusyRun;
    lines.push("");
    lines.push(`longest busy run: ${run.durationMs}ms starting +${run.startOffsetMs}ms (top self inside it)`);
    for (const row of run.topSelf) {
      lines.push(`  ${pad(row.selfMs, 8)}ms ${pad(row.selfPct.toFixed(1), 5)}%  ${formatFunctionTiming(row)}`);
    }
  }
  const table = (title: string, rows: FunctionTiming[]) => {
    lines.push("");
    lines.push(`TOP ${rows.length} BY ${title}`);
    lines.push(`  ${pad("selfMs", 8)} ${pad("self%", 6)} ${pad("totalMs", 8)} ${pad("total%", 6)}  function@url:line:col`);
    for (const row of rows) {
      lines.push(
        `  ${pad(row.selfMs, 8)} ${pad(row.selfPct.toFixed(1), 6)} ${pad(row.totalMs, 8)} ${pad(row.totalPct.toFixed(1), 6)}  ` +
          formatFunctionTiming(row)
      );
    }
  };
  table("SELF TIME", summary.topSelf);
  table("TOTAL TIME", summary.topTotal);
  if (summary.hotStacks.length > 0) {
    lines.push("");
    lines.push(`HOT STACKS (top ${summary.hotStacks.length} leaf stacks by self time, leaf first)`);
    for (const hot of summary.hotStacks) {
      lines.push(`  ${hot.selfMs}ms (${hot.selfPct.toFixed(1)}%)`);
      for (const frame of hot.frames) lines.push(`      at ${frame}`);
    }
  }
  return lines.join("\n") + "\n";
}
