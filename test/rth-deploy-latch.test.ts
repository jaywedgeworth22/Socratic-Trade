import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  COOLIFY_WATCH_PATHS_LIVE,
  COOLIFY_WATCH_PATHS_OMITTED,
  ISSUE_2811_DOCS_ONLY_PATHS,
  isDocsOnlyChange,
  isImageNoopChange
} from "../src/lib/deploy-image-impact";
import { isMarketOpen } from "../src/lib/market-calendar";
import {
  commitMessageRequestsHotfix,
  decideRthDeployLatchFromEnv,
  describeRthDeployLatchDecision,
  envFlagEnabled,
  evaluateRthDeployLatch,
  fetchGithubCommitFiles,
  fetchGithubCommitMessage,
  latchCommitSha,
  resolveChangedFilesForLatch,
  resolveCommitMessageForLatch
} from "../src/lib/rth-deploy-latch";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

// June 2026 is EDT (UTC-4).  2026-06-10 is a Wednesday.
function etDate(isoDate: string, etHour: number, etMinute = 0): Date {
  const utcHour = etHour + 4;
  return new Date(`${isoDate}T${String(utcHour).padStart(2, "0")}:${String(etMinute).padStart(2, "0")}:00Z`);
}

const wednesdayRth = etDate("2026-06-10", 10, 0);
const wednesdayOpen = etDate("2026-06-10", 9, 30);
const wednesdayClose = etDate("2026-06-10", 16, 0);
const wednesdayEvening = etDate("2026-06-10", 17, 30);
const wednesdayPremarket = etDate("2026-06-10", 8, 0);
const saturdayMidday = etDate("2026-06-13", 12, 0);
const thanksgivingMorning = new Date("2026-11-26T15:00:00Z"); // 10:00 ET, holiday
const blackFridayAfternoon = new Date("2026-11-27T19:00:00Z"); // 14:00 ET, early close
const blackFridayMorning = new Date("2026-11-27T16:00:00Z"); // 11:00 ET, still RTH

describe("envFlagEnabled", () => {
  it("accepts 1 / true / yes / on and ignores surrounding space", () => {
    expect(envFlagEnabled("1")).toBe(true);
    expect(envFlagEnabled(" true ")).toBe(true);
    expect(envFlagEnabled("YES")).toBe(true);
    expect(envFlagEnabled("on")).toBe(true);
    expect(envFlagEnabled("0")).toBe(false);
    expect(envFlagEnabled("HOTFIX=1")).toBe(false);
    expect(envFlagEnabled("")).toBe(false);
    expect(envFlagEnabled(undefined)).toBe(false);
  });
});

describe("commitMessageRequestsHotfix", () => {
  it("matches a standalone HOTFIX=1 token in subject or body", () => {
    expect(commitMessageRequestsHotfix("HOTFIX=1 fix the broker 422")).toBe(true);
    expect(commitMessageRequestsHotfix("fix the broker 422\n\nHOTFIX=1\n")).toBe(true);
    expect(commitMessageRequestsHotfix("docs: rollout\n\nHOTFIX=1.")).toBe(false);
    expect(commitMessageRequestsHotfix("not a hotfix")).toBe(false);
    expect(commitMessageRequestsHotfix("CHOTFIX=1 sneaky")).toBe(false);
    expect(commitMessageRequestsHotfix("HOTFIX=10")).toBe(false);
    expect(commitMessageRequestsHotfix(undefined)).toBe(false);
  });
});

describe("evaluateRthDeployLatch", () => {
  it("blocks weekday regular trading hours", () => {
    expect(isMarketOpen(wednesdayRth)).toBe(true);
    const decision = evaluateRthDeployLatch({ now: wednesdayRth });
    expect(decision).toMatchObject({ allowed: false, reason: "rth-blocked", sessionIsRth: true });
  });

  it("blocks at the 09:30 ET open and allows at the 16:00 ET close", () => {
    expect(evaluateRthDeployLatch({ now: wednesdayOpen }).allowed).toBe(false);
    expect(evaluateRthDeployLatch({ now: wednesdayClose })).toMatchObject({
      allowed: true,
      reason: "non-rth"
    });
  });

  it("allows evenings, pre-market, weekends, and full-close holidays", () => {
    expect(evaluateRthDeployLatch({ now: wednesdayEvening }).reason).toBe("non-rth");
    expect(evaluateRthDeployLatch({ now: wednesdayPremarket }).reason).toBe("non-rth");
    expect(evaluateRthDeployLatch({ now: saturdayMidday }).reason).toBe("non-rth");
    expect(evaluateRthDeployLatch({ now: thanksgivingMorning }).reason).toBe("non-rth");
  });

  it("allows after the 13:00 ET early close and still blocks the shortened session", () => {
    expect(evaluateRthDeployLatch({ now: blackFridayMorning })).toMatchObject({
      allowed: false,
      reason: "rth-blocked"
    });
    expect(evaluateRthDeployLatch({ now: blackFridayAfternoon })).toMatchObject({
      allowed: true,
      reason: "non-rth"
    });
  });

  it("HOTFIX=1 env ships during RTH", () => {
    expect(evaluateRthDeployLatch({ now: wednesdayRth, hotfixEnv: "1" })).toMatchObject({
      allowed: true,
      reason: "hotfix",
      sessionIsRth: true
    });
  });

  it("HOTFIX=1 in the commit message ships during RTH", () => {
    expect(
      evaluateRthDeployLatch({
        now: wednesdayRth,
        commitMessage: "HOTFIX=1 alpaca penny 422"
      })
    ).toMatchObject({ allowed: true, reason: "hotfix" });
  });

  it("RTH_DEPLOY_OVERRIDE=1 is the explicit owner-request escape", () => {
    expect(evaluateRthDeployLatch({ now: wednesdayRth, overrideEnv: "1" })).toMatchObject({
      allowed: true,
      reason: "owner-override"
    });
  });

  it("describeRthDeployLatchDecision covers every reason", () => {
    const reasons = ["non-rth", "hotfix", "owner-override", "rth-blocked", "image-noop"] as const;
    for (const reason of reasons) {
      const allowed = reason !== "rth-blocked" && reason !== "image-noop";
      const text = describeRthDeployLatchDecision({
        allowed,
        reason,
        sessionIsRth: !allowed,
        detail: "detail"
      });
      expect(text).toContain(reason);
      expect(text).toContain(allowed ? "allow" : "block");
    }
  });
});

describe("resolveCommitMessageForLatch", () => {
  it("prefers COMMIT_MESSAGE over GitHub", async () => {
    const fetchImpl = async () => {
      throw new Error("should not fetch");
    };
    const message = await resolveCommitMessageForLatch(
      { COMMIT_MESSAGE: "from env", SOURCE_COMMIT: "abc1234" },
      () => "from git",
      fetchImpl as unknown as typeof fetch
    );
    expect(message).toBe("from env");
  });

  it("falls back to GitHub then git log", async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify({ commit: { message: "from github" } }), { status: 200 });
    const fromGithub = await resolveCommitMessageForLatch(
      { SOURCE_COMMIT: "23412af", GITHUB_REPOSITORY: "jaywedgeworth22/Socratic-Trade" },
      () => "from git",
      fetchImpl as unknown as typeof fetch
    );
    expect(fromGithub).toBe("from github");

    const fromGit = await resolveCommitMessageForLatch(
      { SOURCE_COMMIT: "not-a-sha" },
      () => "from git",
      async () => new Response("nope", { status: 404 })
    );
    expect(fromGit).toBe("from git");
  });
});

describe("latchCommitSha", () => {
  it("reads Coolify and GitHub sha aliases", () => {
    expect(latchCommitSha({ COOLIFY_COMMIT_SHA: "23412aff916ae918287421bac35fd12f8c300f59" })).toBe(
      "23412aff916ae918287421bac35fd12f8c300f59"
    );
    expect(latchCommitSha({ SOURCE_COMMIT: "not-a-sha" })).toBe("");
  });
});

describe("fetchGithubCommitFiles", () => {
  it("maps filenames and refuses a truncated 300-file page", async () => {
    const files = await fetchGithubCommitFiles(
      "23412af",
      "jaywedgeworth22/Socratic-Trade",
      async () =>
        new Response(JSON.stringify({ files: ISSUE_2811_DOCS_ONLY_PATHS.map((filename) => ({ filename })) }), {
          status: 200
        })
    );
    expect(files).toEqual([...ISSUE_2811_DOCS_ONLY_PATHS]);

    const truncated = await fetchGithubCommitFiles(
      "23412af",
      "jaywedgeworth22/Socratic-Trade",
      async () =>
        new Response(JSON.stringify({ files: Array.from({ length: 300 }, (_, i) => ({ filename: `docs/${i}.md` })) }), {
          status: 200
        })
    );
    expect(truncated).toBeUndefined();
  });
});

describe("resolveChangedFilesForLatch", () => {
  it("prefers CHANGED_FILES over GitHub", async () => {
    const files = await resolveChangedFilesForLatch(
      { CHANGED_FILES: "PLAN.md\nSTATUS.md", SOURCE_COMMIT: "23412af" },
      async () => {
        throw new Error("should not fetch");
      }
    );
    expect(files).toEqual(["PLAN.md", "STATUS.md"]);
  });
});

describe("fetchGithubCommitMessage", () => {
  it("rejects malformed sha or repo and swallows HTTP failures", async () => {
    expect(await fetchGithubCommitMessage("HEAD", "jaywedgeworth22/Socratic-Trade")).toBeUndefined();
    expect(await fetchGithubCommitMessage("abc1234", "not a repo")).toBeUndefined();
    const failed = await fetchGithubCommitMessage(
      "abc1234",
      "jaywedgeworth22/Socratic-Trade",
      async () => new Response("nope", { status: 403 })
    );
    expect(failed).toBeUndefined();
  });
});

describe("deploy image impact", () => {
  it("records the live Coolify watch_paths list (already applied; do not PATCH)", () => {
    expect([...COOLIFY_WATCH_PATHS_LIVE]).toEqual([
      "Dockerfile",
      ".dockerignore",
      "package.json",
      "package-lock.json",
      "next.config.mjs",
      "postcss.config.mjs",
      "tsconfig.json",
      "middleware.ts",
      "instrumentation.ts",
      "instrumentation-client.ts",
      "sentry.server.config.ts",
      "sentry.edge.config.ts",
      "litestream.coolify.yml",
      "src",
      "src/**",
      "app",
      "app/**",
      "public",
      "public/**",
      "scripts",
      "scripts/**"
    ]);
    expect([...COOLIFY_WATCH_PATHS_OMITTED]).toEqual([
      "docs/**",
      "STATUS.md",
      "PLAN.md",
      "docs/rollouts",
      "ios/",
      "test/"
    ]);
    expect(COOLIFY_WATCH_PATHS_LIVE.some((path) => path.startsWith("docs"))).toBe(false);
  });

  it("treats #2811 as docs-only and image-noop", () => {
    expect(isDocsOnlyChange([...ISSUE_2811_DOCS_ONLY_PATHS])).toBe(true);
    expect(isImageNoopChange([...ISSUE_2811_DOCS_ONLY_PATHS])).toBe(true);
  });

  it("does not skip a docs/benchmarks change (Next imports those JSON files)", () => {
    expect(isImageNoopChange(["docs/benchmarks/foo.json"])).toBe(false);
    expect(isImageNoopChange(["docs/rollouts/x.md", "src/lib/strategy.ts"])).toBe(false);
  });
});

describe("decideRthDeployLatchFromEnv", () => {
  it("honors RTH_DEPLOY_LATCH_NOW so CI is not wall-clock dependent", async () => {
    const blocked = await decideRthDeployLatchFromEnv({
      RTH_DEPLOY_LATCH_NOW: wednesdayRth.toISOString()
    });
    expect(blocked.allowed).toBe(false);
    const evening = await decideRthDeployLatchFromEnv({
      RTH_DEPLOY_LATCH_NOW: wednesdayEvening.toISOString(),
      HOTFIX: "0"
    });
    expect(evening.allowed).toBe(true);
    const noop = await decideRthDeployLatchFromEnv({
      RTH_DEPLOY_LATCH_NOW: wednesdayEvening.toISOString(),
      HOTFIX: "1",
      CHANGED_FILES: ISSUE_2811_DOCS_ONLY_PATHS.join("\n")
    });
    expect(noop).toMatchObject({ allowed: false, reason: "image-noop" });
  });
});

describe("assert-rth-deploy-latch CLI", () => {
  it("exits 3 for the #2811 docs-only shape even in the evening with HOTFIX=1", () => {
    const run = spawnSync(
      "npx",
      ["tsx", "scripts/assert-rth-deploy-latch.ts"],
      {
        cwd: repoRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          RTH_DEPLOY_LATCH_NOW: wednesdayEvening.toISOString(),
          HOTFIX: "1",
          CHANGED_FILES: [
            "PLAN.md",
            "STATUS.md",
            "docs/EFFORT-LOG.md",
            "docs/audits/2026-08-18-pinecone-store-vs-condense.md",
            "docs/phase-7-strategy.md",
            "docs/rollouts/2026-08-18-pinecone-store-vs-condense.md"
          ].join("\n")
        }
      }
    );
    expect(run.status).toBe(3);
    expect(run.stderr).toContain("image-noop");
  });

  it("exits 2 during RTH and 0 with HOTFIX=1", () => {
    const run = (env: Record<string, string>) =>
      spawnSync(
        "npx",
        ["tsx", "scripts/assert-rth-deploy-latch.ts"],
        {
          cwd: repoRoot,
          encoding: "utf8",
          env: { ...process.env, ...env }
        }
      );

    const blocked = run({
      RTH_DEPLOY_LATCH_NOW: wednesdayRth.toISOString(),
      HOTFIX: "",
      RTH_DEPLOY_OVERRIDE: "",
      COMMIT_MESSAGE: "docs: no hotfix",
      CHANGED_FILES: "src/lib/strategy.ts"
    });
    expect(blocked.status).toBe(2);
    expect(blocked.stderr).toContain("rth-blocked");

    const hotfix = run({
      RTH_DEPLOY_LATCH_NOW: wednesdayRth.toISOString(),
      COMMIT_MESSAGE: "HOTFIX=1 broker 422",
      CHANGED_FILES: "src/lib/strategy.ts"
    });
    expect(hotfix.status).toBe(0);
    expect(hotfix.stdout).toContain("hotfix");
  });
});

describe("rth-deploy-drain.sh", () => {
  it("fails the scheduled job when Coolify cannot be nudged", () => {
    const drain = readFileSync(join(repoRoot, "scripts/rth-deploy-drain.sh"), "utf8");
    expect(drain).toMatch(/could not nudge Coolify/);
    expect(drain).toMatch(/exit 1/);
    expect(drain).not.toMatch(/could not nudge Coolify[\s\S]{0,200}exit 0/);
    expect(drain).toMatch(/COOLIFY_DEPLOY/);
    expect(drain).toMatch(/\/api\/v1\/deploy\?uuid=/);
  });
});

describe("Coolify build-time latch wiring", () => {
  it("fails the image build, not the running container", () => {
    const dockerfile = readFileSync(join(repoRoot, "Dockerfile"), "utf8");
    const start = readFileSync(join(repoRoot, "scripts/coolify-prod-start.sh"), "utf8");
    expect(dockerfile).toMatch(/assert-rth-deploy-latch\.ts/);
    expect(dockerfile).toMatch(/deploy-image-impact\.ts/);
    expect(dockerfile).toMatch(/tsx scripts\/assert-rth-deploy-latch\.ts/);
    expect(dockerfile.indexOf("tsx scripts/assert-rth-deploy-latch.ts"))
      .toBeLessThan(dockerfile.indexOf("COPY package.json package-lock.json"));
    expect(start).not.toMatch(/rth-deploy-latch|assert-rth-deploy-latch|FORCE_RESTORE/);
    expect(dockerfile).not.toMatch(/FORCE_RESTORE/);
    expect(existsSync(join(repoRoot, ".github/workflows/deploy.yml"))).toBe(false);
  });
});
