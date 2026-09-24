import { asRecord, readText } from "./server-metrics-shapes";
import type {
  ServerMetricsActionRunner,
  ServerMetricsActionRunners,
} from "./server-metrics-runtime";

/**
 * The one repository this panel can speak for.
 *
 * It queries no other repo, so it claims none. The removed fallback array named runners for
 * Congress.Trade, Congress-Trading-Shared and API-Usage-Monitor, which this endpoint has never
 * queried and therefore could neither confirm nor refute.
 */
export const ACTION_RUNNER_REPO = "jaywedgeworth22/Socratic-Trade";

const RUNNER_REQUEST_TIMEOUT_MS = 5_000;

function readRunnerId(value: unknown, fallback: string): string {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return readText(value) ?? fallback;
}

function readRunnerLabels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((label) => {
    const name = readText(asRecord(label)?.name) ?? readText(label);
    return name ? [name] : [];
  });
}

/**
 * Read the self-hosted runners registered to this repository.
 *
 * Every path returns either a measured list — including a genuinely EMPTY list, which is a real
 * and important answer — or an explicit `unavailable` result naming the credential or HTTP
 * status that blocked the read. There is deliberately no fallback list.
 *
 * This replaces a hardcoded array of six invented runners that was returned whenever the token
 * was missing, the request failed, the response was not ok, the shape was unexpected, or the
 * live list came back empty. Socratic-Trade production has never had a GitHub token set, so
 * that array was served on 100% of production requests, reporting six machines that do not
 * exist — five of them attributed to `ci-cpx32`, a CI box deleted 2026-07-31 — as
 * "running:healthy". The repo forbids fabricated data in anything user-facing: real data, or
 * an explicit blank, never a plausible-looking default.
 */
export async function getActionRunners(): Promise<ServerMetricsActionRunners> {
  const token = readText(process.env.GH_TOKEN)
    || readText(process.env.GITHUB_TOKEN)
    || readText(process.env.GITHUB_MCP_TOKEN);

  if (!token) {
    return {
      state: "unavailable",
      repo: ACTION_RUNNER_REPO,
      reason: "no-github-token",
      detail: "No GitHub token is configured for this deployment, so the runners registered to "
        + `${ACTION_RUNNER_REPO} were never queried.  Set GH_TOKEN or GITHUB_TOKEN to a token `
        + "with repository administration read access to see the live list.",
    };
  }

  try {
    const response = await fetch(
      `https://api.github.com/repos/${ACTION_RUNNER_REPO}/actions/runners`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "Socratic-Trade infrastructure monitor",
        },
        signal: AbortSignal.timeout(RUNNER_REQUEST_TIMEOUT_MS),
      },
    );
    if (!response.ok) {
      return {
        state: "unavailable",
        repo: ACTION_RUNNER_REPO,
        reason: "github-api-error",
        detail: `The GitHub Actions runners API answered HTTP ${response.status} for `
          + `${ACTION_RUNNER_REPO}.  A 401 or 403 usually means the configured token expired or `
          + "lost its repository administration scope.",
      };
    }
    const json: unknown = await response.json().catch(() => undefined);
    const rawRunners = asRecord(json)?.runners;
    if (!Array.isArray(rawRunners)) {
      return {
        state: "unavailable",
        repo: ACTION_RUNNER_REPO,
        reason: "unexpected-shape",
        detail: "The GitHub Actions runners API answered without a runners array, so the "
          + "registered runners could not be read.",
      };
    }

    const runners: ServerMetricsActionRunner[] = [];
    let omittedCount = 0;
    for (const item of rawRunners) {
      const rec = asRecord(item);
      const name = readText(rec?.name);
      const status = readText(rec?.status);
      if (!name || !status) {
        omittedCount += 1;
        continue;
      }
      runners.push({
        id: readRunnerId(rec?.id, name),
        name,
        // GitHub reports reachability ("online" / "offline"), not health. Pass its word
        // through untranslated: the old code rewrote "online" as "running:healthy", which
        // asserted a health check nobody ran and hid a registered-but-wedged runner.
        status,
        busy: typeof rec?.busy === "boolean" ? rec.busy : null,
        labels: readRunnerLabels(rec?.labels),
      });
    }
    return { state: "known", repo: ACTION_RUNNER_REPO, runners, omittedCount };
  } catch {
    return {
      state: "unavailable",
      repo: ACTION_RUNNER_REPO,
      reason: "request-failed",
      detail: `The GitHub Actions runners API could not be reached for ${ACTION_RUNNER_REPO}.  `
        + "The request timed out or the network call failed.",
    };
  }
}
