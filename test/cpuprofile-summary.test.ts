// The `.top.json` sidecar and `scripts/ops/summarize-cpuprofile.mjs` must name the culprit of an
// event-loop stall in a form an operator can read with `cat` over SSH (board e7b49943 / 687a5fb4).
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  summarizeCpuProfile,
  formatCpuProfileSummary,
  formatFunctionTiming
} from "../src/lib/cpuprofile-summary";
import { buildCpuProfile, IDLE } from "./helpers/cpuprofile-fixture";

const tick = { fn: "processTicksAndRejections", url: "node:internal/process/task_queues", line: 105, col: 5 };
const scan = { fn: "scanStaleLimits", url: "file:///app/.next/server/chunks/881.js", line: 1, col: 40211 };
const parse = { fn: "parseTransactions", url: "file:///app/.next/server/chunks/412.js", line: 1, col: 9001 };
const zod = { fn: "_parse", url: "file:///app/node_modules/zod/lib/types.js", line: 3120, col: 17 };

describe("summarizeCpuProfile", () => {
  const profile = buildCpuProfile([
    { stack: IDLE, ms: 2_000 },
    { stack: [tick, scan], ms: 300 },
    // The stall: 40s pinned inside a Zod parse flood reached through parseTransactions.
    { stack: [tick, parse, zod], ms: 30_000 },
    { stack: [tick, parse], ms: 10_000 },
    { stack: [{ fn: "(garbage collector)" }], ms: 1_000 },
    { stack: IDLE, ms: 1_000 }
  ]);
  const summary = summarizeCpuProfile(profile, { top: 40 });

  it("ranks self time and reports 1-based url:line:col locations", () => {
    expect(summary.topSelf[0].function).toBe("_parse");
    expect(summary.topSelf[0].location).toBe("file:///app/node_modules/zod/lib/types.js:3120:17");
    expect(summary.topSelf[0].selfMs).toBeGreaterThanOrEqual(29_900);
    expect(summary.topSelf[0].selfMs).toBeLessThanOrEqual(30_100);
    expect(summary.topSelf[1].function).toBe("parseTransactions");
    expect(formatFunctionTiming(summary.topSelf[0])).toBe(
      "_parse@file:///app/node_modules/zod/lib/types.js:3120:17"
    );
  });

  it("never lists (root) or (idle) as a culprit, but keeps GC visible", () => {
    const names = summary.topSelf.map((t) => t.function);
    expect(names).not.toContain("(root)");
    expect(names).not.toContain("(idle)");
    expect(names).toContain("(garbage collector)");
    expect(summary.idleMs).toBeGreaterThanOrEqual(2_900);
    expect(summary.gcMs).toBeGreaterThanOrEqual(990);
  });

  it("counts total time once per sample even for a caller and its callee", () => {
    const parseTotal = summary.topTotal.find((t) => t.function === "parseTransactions");
    expect(parseTotal?.totalMs).toBeGreaterThanOrEqual(39_900);
    expect(parseTotal?.totalMs).toBeLessThanOrEqual(40_100);
    const tickTotal = summary.topTotal.find((t) => t.function === "processTicksAndRejections");
    expect(tickTotal?.totalMs).toBeGreaterThanOrEqual(40_200);
    expect(tickTotal?.totalMs).toBeLessThanOrEqual(40_400);
  });

  it("counts recursion once in total time", () => {
    const rec = { fn: "walk", url: "file:///app/x.js", line: 10, col: 1 };
    const p = buildCpuProfile([{ stack: [rec, rec, rec], ms: 1_000 }]);
    const s = summarizeCpuProfile(p);
    const walk = s.topTotal.find((t) => t.function === "walk");
    expect(walk?.totalMs).toBeGreaterThanOrEqual(990);
    expect(walk?.totalMs).toBeLessThanOrEqual(1_010);
  });

  it("finds the longest busy run and its culprit", () => {
    expect(summary.longestBusyRun).not.toBeNull();
    expect(summary.longestBusyRun!.durationMs).toBeGreaterThanOrEqual(41_000);
    expect(summary.longestBusyRun!.startOffsetMs).toBeGreaterThanOrEqual(1_900);
    expect(summary.longestBusyRun!.topSelf[0].function).toBe("_parse");
  });

  it("returns the full leaf stack for the hottest stacks", () => {
    expect(summary.hotStacks[0].frames[0]).toBe("_parse@file:///app/node_modules/zod/lib/types.js:3120:17");
    expect(summary.hotStacks[0].frames).toContain("parseTransactions@file:///app/.next/server/chunks/412.js:1:9001");
    expect(summary.hotStacks[0].frames.at(-1)).toBe(
      "processTicksAndRejections@node:internal/process/task_queues:105:5"
    );
  });

  it("caps the lists at the requested size", () => {
    const small = summarizeCpuProfile(profile, { top: 2, hotStacks: 1 });
    expect(small.topSelf).toHaveLength(2);
    expect(small.topTotal).toHaveLength(2);
    expect(small.hotStacks).toHaveLength(1);
  });

  it("tolerates a profile without samples by falling back to hitCount", () => {
    const { samples: _s, timeDeltas: _t, ...legacy } = profile;
    void _s;
    void _t;
    const s = summarizeCpuProfile(legacy);
    expect(s.topSelf[0].function).toBe("_parse");
  });

  it("formats a readable table", () => {
    const text = formatCpuProfileSummary(summary);
    expect(text).toMatch(/TOP \d+ BY SELF TIME/);
    expect(text).toMatch(/TOP \d+ BY TOTAL TIME/);
    expect(text).toContain("_parse@file:///app/node_modules/zod/lib/types.js:3120:17");
    expect(text).toMatch(/longest busy run/i);
  });
});

describe("scripts/ops/summarize-cpuprofile.mjs", () => {
  it("prints the same table for a .cpuprofile on disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "agentic-cpuprofile-"));
    const file = join(dir, "stall.cpuprofile");
    writeFileSync(
      file,
      JSON.stringify(buildCpuProfile([{ stack: [parse, zod], ms: 5_000 }, { stack: IDLE, ms: 500 }]))
    );
    const out = execFileSync(process.execPath, [resolve("scripts/ops/summarize-cpuprofile.mjs"), file], {
      encoding: "utf8"
    });
    expect(out).toMatch(/TOP \d+ BY SELF TIME/);
    expect(out).toContain("_parse@file:///app/node_modules/zod/lib/types.js:3120:17");
  });

  it("exits non-zero with usage when no file is given", () => {
    let failed = false;
    try {
      execFileSync(process.execPath, [resolve("scripts/ops/summarize-cpuprofile.mjs")], {
        encoding: "utf8",
        stdio: "pipe"
      });
    } catch (err) {
      failed = true;
      expect(String((err as { stderr?: string }).stderr)).toMatch(/usage/i);
    }
    expect(failed).toBe(true);
  });
});
