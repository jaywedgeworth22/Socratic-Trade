#!/usr/bin/env node
// Print the stall profiler's "which function pinned the loop" table for a .cpuprofile.
//
//   node scripts/ops/summarize-cpuprofile.mjs <file.cpuprofile | file.top.json> [--top N] [--json]
//
// Works on any V8 .cpuprofile (the stall profiler's, `node --cpu-prof`, or a DevTools export).
// Given a `.top.json` sidecar it reads the sibling `.cpuprofile` when present, else prints the
// summary the sidecar already carries.  Inside the production container:
//
//   docker exec $C node scripts/ops/summarize-cpuprofile.mjs /app/data/profiles/<name>.cpuprofile
//
// The summarizer lives in src/lib/cpuprofile-summary.ts and is imported directly through Node 24's
// built-in TypeScript stripping (no build step, no tsx), so this table and the .top.json the app
// writes can never drift apart.
import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { formatCpuProfileSummary, summarizeCpuProfile } from "../../src/lib/cpuprofile-summary.ts";

function usage(message) {
  if (message) process.stderr.write(`${message}\n`);
  process.stderr.write(
    "usage: node scripts/ops/summarize-cpuprofile.mjs <file.cpuprofile | file.top.json> [--top N] [--json]\n"
  );
  process.exit(2);
}

const args = process.argv.slice(2);
let file;
let top = 40;
let asJson = false;
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--json") asJson = true;
  else if (arg === "--top") {
    const n = Number(args[++i]);
    if (!Number.isFinite(n) || n < 1) usage("--top needs a positive number");
    top = Math.floor(n);
  } else if (arg === "-h" || arg === "--help") usage();
  else if (!file) file = arg;
  else usage(`unexpected argument: ${arg}`);
}
if (!file) usage();
if (!existsSync(file)) usage(`no such file: ${file}`);

let header;
let profilePath = file;
if (file.endsWith(".top.json")) {
  const sidecar = JSON.parse(readFileSync(file, "utf8"));
  header = {
    file: sidecar.file,
    trigger: sidecar.trigger,
    stalledMs: sidecar.stalledMs,
    window: sidecar.windowStartedAt && `${sidecar.windowStartedAt} .. ${sidecar.windowEndedAt} (${sidecar.windowMs}ms)`
  };
  const sibling = file.replace(/\.top\.json$/, ".cpuprofile");
  if (existsSync(sibling)) {
    profilePath = sibling;
  } else {
    // The sidecar alone still carries the summary; print it as-is.
    const summary = {
      durationMs: sidecar.durationMs ?? 0,
      sampleCount: sidecar.sampleCount ?? 0,
      avgSampleIntervalMs: sidecar.avgSampleIntervalMs ?? 0,
      busyMs: sidecar.busyMs ?? 0,
      idleMs: sidecar.idleMs ?? 0,
      gcMs: sidecar.gcMs ?? 0,
      programMs: sidecar.programMs ?? 0,
      longestBusyRun: sidecar.longestBusyRun ?? null,
      topSelf: (sidecar.topSelf ?? []).slice(0, top),
      topTotal: (sidecar.topTotal ?? []).slice(0, top),
      hotStacks: sidecar.hotStacks ?? []
    };
    process.stdout.write(asJson ? `${JSON.stringify(summary, null, 2)}\n` : formatCpuProfileSummary(summary, header));
    process.exit(0);
  }
}

let profile;
try {
  profile = JSON.parse(readFileSync(profilePath, "utf8"));
} catch (err) {
  usage(`cannot parse ${profilePath}: ${err instanceof Error ? err.message : String(err)}`);
}
if (!profile || !Array.isArray(profile.nodes)) usage(`${profilePath} is not a V8 .cpuprofile (no nodes[])`);

const summary = summarizeCpuProfile(profile, { top });
if (asJson) {
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
} else {
  process.stdout.write(formatCpuProfileSummary(summary, header ?? { file: basename(profilePath) }));
}
