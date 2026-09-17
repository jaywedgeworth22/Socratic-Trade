import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const workflowsDir = join(repoRoot, ".github", "workflows");
const reporterPath = join(workflowsDir, "sentry-ci-report.yml");
const reporterSource = readFileSync(reporterPath, "utf8");
const reporterScript = readFileSync(join(repoRoot, "scripts", "sentry-ci-report.py"), "utf8");

function workflowName(source: string): string {
  const match = source.match(/^name:\s*["']?([^"'\n]+)["']?\s*$/m);
  if (!match) throw new Error("workflow is missing a top-level name");
  return match[1].trim();
}

function workflowCron(source: string): string | undefined {
  const match = source.match(/^\s+- cron:\s*["']?([^"'\n#]+)["']?/m);
  return match?.[1].trim();
}

function independentlyRunnable(source: string): boolean {
  const onBlock = source.match(/^on:\s*\n((?:^[ \t].*(?:\n|$))*)/m)?.[1] ?? "";
  const triggers = [...onBlock.matchAll(/^  ([a-zA-Z_]+):/gm)].map((match) => match[1]);
  return triggers.some((trigger) => trigger !== "workflow_call");
}

function observedWorkflowNames(source: string): string[] {
  const block = source.match(/workflow_run:\s*\n\s+workflows:\s*\n([\s\S]*?)\n\s+types:/);
  if (!block) throw new Error("Sentry reporter is missing workflow_run.workflows");
  return [...block[1].matchAll(/^\s+-\s+(.+)$/gm)].map((match) => match[1].trim());
}

function cronMappings(source: string): Record<string, string> {
  const block = source.match(/CRON_SCHEDULES\s*=\s*\{([\s\S]*?)\n\}/);
  if (!block) throw new Error("Sentry reporter script is missing CRON_SCHEDULES");
  return Object.fromEntries(
    [...block[1].matchAll(/^\s+"([^"]+)":\s*"([^"]+)",?$/gm)].map((match) => [
      match[1],
      match[2],
    ])
  );
}

function checkinMarginOverrides(source: string): Record<string, number> {
  const block = source.match(/CHECKIN_MARGIN_OVERRIDES\s*=\s*\{([\s\S]*?)\n\}/);
  if (!block) throw new Error("Sentry reporter script is missing CHECKIN_MARGIN_OVERRIDES");
  return Object.fromEntries(
    [...block[1].matchAll(/^\s+"([^"]+)":\s*(\d+),?$/gm)].map((match) => [
      match[1],
      Number(match[2]),
    ])
  );
}

const activeWorkflowFiles = readdirSync(workflowsDir)
  .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
  .filter((name) => name !== "sentry-ci-report.yml")
  // Reusable-only workflows execute inside their caller's run and do not emit an independent
  // workflow_run event. Observing the caller covers their failure; listing the reusable name here
  // would create a false assurance because the reporter can never receive that event.
  .filter((name) => independentlyRunnable(readFileSync(join(workflowsDir, name), "utf8")));

describe("Sentry CI workflow coverage", () => {
  it("observes every active workflow and no retired workflow", () => {
    const activeNames = activeWorkflowFiles.map((name) =>
      workflowName(readFileSync(join(workflowsDir, name), "utf8"))
    );

    expect(observedWorkflowNames(reporterSource).sort()).toEqual(activeNames.sort());
    expect(activeNames).not.toContain("Deploy");
    expect(activeNames).not.toContain("Sync Preview Lanes");
    expect(activeNames).not.toContain("_merge-shepherd-impl");
    expect(existsSync(join(workflowsDir, "deploy.yml"))).toBe(false);
  });

  it("maps every active scheduled workflow to its exact source cron", () => {
    const scheduled = Object.fromEntries(
      activeWorkflowFiles.flatMap((name): Array<[string, string]> => {
        const source = readFileSync(join(workflowsDir, name), "utf8");
        const cron = workflowCron(source);
        return cron ? [[workflowName(source), cron]] : [];
      })
    );

    expect(cronMappings(reporterScript)).toEqual(scheduled);
    expect(cronMappings(reporterScript)).not.toHaveProperty("merge-shepherd");
  });

  it("widens only GitHub schedule-delay monitors to 600 minutes", () => {
    expect(checkinMarginOverrides(reporterScript)).toEqual({
      "Deploy freshness": 600,
      "RTH Deploy Latch": 600,
    });
  });
});
