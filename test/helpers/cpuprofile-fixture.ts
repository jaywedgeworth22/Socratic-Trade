// Builds a synthetic V8 `.cpuprofile` (the `Profiler.Profile` shape `Profiler.stop` returns) from a
// list of timed call stacks, so stall-profiler and summary tests never have to start a real V8
// profiler.  Each segment contributes `ms / intervalMs` consecutive samples of its leaf frame.
import type { CpuProfile, CpuProfileCallFrame, CpuProfileNode } from "../../src/lib/cpuprofile-summary";

export type FixtureFrame = { fn: string; url?: string; line?: number; col?: number };
export type FixtureSegment = { stack: FixtureFrame[]; ms: number };

export const IDLE: FixtureFrame[] = [{ fn: "(idle)" }];

function callFrame(frame: FixtureFrame): CpuProfileCallFrame {
  return {
    functionName: frame.fn,
    url: frame.url ?? "",
    // `.cpuprofile` line/column numbers are 0-based; fixtures speak 1-based like an editor.
    lineNumber: (frame.line ?? 1) - 1,
    columnNumber: (frame.col ?? 1) - 1,
    scriptId: "0"
  };
}

function frameKey(frame: FixtureFrame): string {
  return `${frame.fn}|${frame.url ?? ""}|${frame.line ?? 1}|${frame.col ?? 1}`;
}

/** Stacks are listed outermost-first (root side first, leaf last). */
export function buildCpuProfile(segments: FixtureSegment[], intervalMs = 10): CpuProfile {
  const nodes: CpuProfileNode[] = [
    { id: 1, callFrame: callFrame({ fn: "(root)" }), hitCount: 0, children: [] }
  ];
  const childIndex = new Map<string, number>();
  const byId = new Map<number, CpuProfileNode>([[1, nodes[0]]]);
  const samples: number[] = [];
  const timeDeltas: number[] = [];
  const intervalUs = Math.round(intervalMs * 1000);

  for (const segment of segments) {
    let parentId = 1;
    for (const frame of segment.stack) {
      const key = `${parentId}>${frameKey(frame)}`;
      let id = childIndex.get(key);
      if (id === undefined) {
        id = nodes.length + 1;
        const node: CpuProfileNode = { id, callFrame: callFrame(frame), hitCount: 0, children: [] };
        nodes.push(node);
        byId.set(id, node);
        byId.get(parentId)!.children!.push(id);
        childIndex.set(key, id);
      }
      parentId = id;
    }
    const count = Math.max(1, Math.round(segment.ms / intervalMs));
    for (let i = 0; i < count; i++) {
      samples.push(parentId);
      timeDeltas.push(intervalUs);
      byId.get(parentId)!.hitCount = (byId.get(parentId)!.hitCount ?? 0) + 1;
    }
  }

  const startTime = 1_000_000;
  const endTime = startTime + timeDeltas.reduce((a, b) => a + b, 0) + intervalUs;
  return { nodes, startTime, endTime, samples, timeDeltas };
}
