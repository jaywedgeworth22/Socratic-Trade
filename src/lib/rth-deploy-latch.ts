// Coolify deploy latch — weekday RTH + image-noop / docs-only.
//
// Auto-deploy stays on (GitHub webhook -> Coolify).  The latch rejects the
// IMAGE BUILD during Mon–Fri 09:30–16:00 ET (13:00 ET on NYSE early-close
// days) unless HOTFIX=1 or an explicit owner override is set, and also
// rejects docs-only / dockerignored trees so stop-old-then-start cannot
// 503 origin for a no-op (#2811, ~34 min).  A failed build must not swap
// the named container.  Do not move this check into
// scripts/coolify-prod-start.sh and do not enable Coolify rolling.

import { isImageNoopChange, parseChangedFiles } from "./deploy-image-impact";
import { isMarketOpen } from "./market-calendar";

export type RthDeployLatchReason =
  | "non-rth"
  | "hotfix"
  | "owner-override"
  | "rth-blocked"
  | "image-noop";

export type RthDeployLatchInput = {
  now?: Date;
  hotfixEnv?: string | null;
  overrideEnv?: string | null;
  commitMessage?: string | null;
};

export type RthDeployLatchDecision = {
  allowed: boolean;
  reason: RthDeployLatchReason;
  sessionIsRth: boolean;
  detail: string;
};

const HOTFIX_TOKEN = /(?:^|[\s,;|/])HOTFIX\s*=\s*1(?:[\s,;|/]|$)/m;

export function envFlagEnabled(value: string | undefined | null): boolean {
  const normalized = (value ?? "").trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

/** True when the commit subject or body contains a standalone HOTFIX=1 token. */
export function commitMessageRequestsHotfix(message: string | undefined | null): boolean {
  if (!message) return false;
  return HOTFIX_TOKEN.test(message);
}

export function evaluateRthDeployLatch(input: RthDeployLatchInput = {}): RthDeployLatchDecision {
  const now = input.now ?? new Date();
  const sessionIsRth = isMarketOpen(now);
  const hotfix = envFlagEnabled(input.hotfixEnv) || commitMessageRequestsHotfix(input.commitMessage);
  if (hotfix) {
    return {
      allowed: true,
      reason: "hotfix",
      sessionIsRth,
      detail: "HOTFIX=1 (env or commit message) overrides the weekday RTH Coolify build latch."
    };
  }
  if (envFlagEnabled(input.overrideEnv)) {
    return {
      allowed: true,
      reason: "owner-override",
      sessionIsRth,
      detail: "RTH_DEPLOY_OVERRIDE=1 is an explicit owner request; the weekday RTH latch is skipped."
    };
  }
  if (!sessionIsRth) {
    return {
      allowed: true,
      reason: "non-rth",
      sessionIsRth,
      detail: "Outside regular US equity trading hours (evenings, weekends, holidays, or after an early close)."
    };
  }
  return {
    allowed: false,
    reason: "rth-blocked",
    sessionIsRth,
    detail: "Weekday regular US equity hours (09:30-16:00 ET, or until 13:00 ET on NYSE early-close days). Set HOTFIX=1 or RTH_DEPLOY_OVERRIDE=1 to ship now; otherwise Coolify keeps the last healthy container and the evening drain retries."
  };
}

export async function fetchGithubCommitMessage(
  sha: string,
  repo: string,
  fetchImpl: typeof fetch = fetch
): Promise<string | undefined> {
  const trimmedSha = sha.trim();
  const trimmedRepo = repo.trim();
  if (!/^[0-9a-f]{7,40}$/i.test(trimmedSha)) return undefined;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(trimmedRepo)) return undefined;
  const url = `https://api.github.com/repos/${trimmedRepo}/commits/${trimmedSha}`;
  try {
    const response = await fetchImpl(url, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "socratic-trade-rth-deploy-latch"
      }
    });
    if (!response.ok) return undefined;
    const body = (await response.json()) as {
      commit?: { message?: unknown };
      files?: Array<{ filename?: unknown }>;
    };
    return typeof body.commit?.message === "string" ? body.commit.message : undefined;
  } catch {
    return undefined;
  }
}

export async function fetchGithubCommitFiles(
  sha: string,
  repo: string,
  fetchImpl: typeof fetch = fetch
): Promise<string[] | undefined> {
  const trimmedSha = sha.trim();
  const trimmedRepo = repo.trim();
  if (!/^[0-9a-f]{7,40}$/i.test(trimmedSha)) return undefined;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(trimmedRepo)) return undefined;
  const url = `https://api.github.com/repos/${trimmedRepo}/commits/${trimmedSha}`;
  try {
    const response = await fetchImpl(url, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "socratic-trade-rth-deploy-latch"
      }
    });
    if (!response.ok) return undefined;
    const body = (await response.json()) as { files?: Array<{ filename?: unknown }> };
    if (!Array.isArray(body.files)) return undefined;
    const names = body.files
      .map((file) => (typeof file.filename === "string" ? file.filename : ""))
      .filter((name) => name.length > 0);
    // GitHub paginates at 300 files.  A truncated list must not skip a
    // runtime path that landed after the first page.
    if (names.length >= 300) return undefined;
    return names.length > 0 ? names : undefined;
  } catch {
    return undefined;
  }
}

export type RthDeployLatchEnv = Record<string, string | undefined>;

/** Coolify injects SOURCE_COMMIT; health/release also see COOLIFY_COMMIT_SHA. */
const LATCH_COMMIT_SHA_KEYS = [
  "SOURCE_COMMIT",
  "COOLIFY_COMMIT",
  "COOLIFY_COMMIT_SHA",
  "GIT_COMMIT_SHA",
  "GITHUB_SHA",
  "APP_RELEASE_SHA"
] as const;

export function latchCommitSha(env: RthDeployLatchEnv): string {
  for (const key of LATCH_COMMIT_SHA_KEYS) {
    const value = env[key]?.trim();
    if (value && /^[0-9a-f]{7,40}$/i.test(value)) return value;
  }
  return "";
}

function latchNowFromEnv(env: RthDeployLatchEnv): Date {
  const raw = env.RTH_DEPLOY_LATCH_NOW?.trim();
  if (!raw) return new Date();
  const parsed = new Date(raw);
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error(`RTH_DEPLOY_LATCH_NOW is not a valid date: ${raw}`);
  }
  return parsed;
}

export async function resolveCommitMessageForLatch(
  env: RthDeployLatchEnv,
  readGitLog?: () => string | undefined,
  fetchImpl: typeof fetch = fetch
): Promise<string | undefined> {
  const fromEnv = env.COMMIT_MESSAGE ?? env.COOLIFY_COMMIT_MESSAGE;
  if (fromEnv && fromEnv.trim()) return fromEnv;
  const sha = latchCommitSha(env);
  const repo = (env.GITHUB_REPOSITORY ?? "jaywedgeworth22/Socratic-Trade").trim();
  if (sha) {
    const fromGithub = await fetchGithubCommitMessage(sha, repo, fetchImpl);
    if (fromGithub) return fromGithub;
  }
  return readGitLog?.();
}

export async function resolveChangedFilesForLatch(
  env: RthDeployLatchEnv,
  fetchImpl: typeof fetch = fetch
): Promise<string[] | undefined> {
  const fromEnv = parseChangedFiles(env.CHANGED_FILES);
  if (fromEnv.length > 0) return fromEnv;
  const sha = latchCommitSha(env);
  const repo = (env.GITHUB_REPOSITORY ?? "jaywedgeworth22/Socratic-Trade").trim();
  if (!sha) return undefined;
  return fetchGithubCommitFiles(sha, repo, fetchImpl);
}

export async function decideRthDeployLatchFromEnv(
  env: RthDeployLatchEnv = process.env,
  readGitLog?: () => string | undefined,
  fetchImpl: typeof fetch = fetch
): Promise<RthDeployLatchDecision> {
  const files = await resolveChangedFilesForLatch(env, fetchImpl);
  if (files && isImageNoopChange(files)) {
    return {
      allowed: false,
      reason: "image-noop",
      sessionIsRth: isMarketOpen(latchNowFromEnv(env)),
      detail: "Changed paths cannot affect the Coolify runtime image (docs-only / dockerignored trees).  Refusing the rebuild so stop-old-then-start cannot take socratictrade.com down for a no-op, as #2811 did for ~34 minutes."
    };
  }
  const commitMessage = await resolveCommitMessageForLatch(env, readGitLog, fetchImpl);
  return evaluateRthDeployLatch({
    now: latchNowFromEnv(env),
    hotfixEnv: env.HOTFIX,
    overrideEnv: env.RTH_DEPLOY_OVERRIDE,
    commitMessage
  });
}

export function describeRthDeployLatchDecision(decision: RthDeployLatchDecision): string {
  switch (decision.reason) {
    case "non-rth":
      return `RTH deploy latch: allow (${decision.reason}). ${decision.detail}`;
    case "hotfix":
      return `RTH deploy latch: allow (${decision.reason}). ${decision.detail}`;
    case "owner-override":
      return `RTH deploy latch: allow (${decision.reason}). ${decision.detail}`;
    case "rth-blocked":
      return `RTH deploy latch: block (${decision.reason}). ${decision.detail}`;
    case "image-noop":
      return `RTH deploy latch: block (${decision.reason}). ${decision.detail}`;
    default: {
      const exhaustive: never = decision.reason;
      return `RTH deploy latch: unknown reason ${String(exhaustive)}`;
    }
  }
}
