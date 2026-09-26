import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_POLICY } from "../src/lib/defaults";

// 2026-09-24 fix (board 687a5fb4): a prod run failed with "Green Team proposal failed using
// OpenRouter mistral-medium-3-5: Your OpenRouter key doesn't have access to this model or
// region." An OpenRouter 403 (key/region lacks access to an otherwise-real slug) is just as
// PERMANENT as a 404 for that key/region — it must cool the slug (recordOpenRouterModelNotFound)
// the same way, and — because an unavailable Red Team review holds every opening for human
// approval even under Autopilot (red-team-routing.ts fails opens closed by design) — the Red
// reviewer needs the same failover chain the Green proposer already had (issue #2577). These
// tests pin the fix at the debateProposal (Red) call site: 403 cools + fails over to an alternate
// configured model; 429 fails over WITHOUT cooling (rate limits are transient); the chain still
// fails closed once every planned attempt is exhausted.

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-red-team-access-error-${randomUUID()}.db`)}`;
});

beforeEach(async () => {
  const { clearOpenRouterModelCooldowns } = await import("../src/lib/model-rotation");
  const { resetLlmProviderCooldownsForTests } = await import("../src/lib/llm-provider-cooldown");
  clearOpenRouterModelCooldowns();
  // The 429 test below deliberately trips the SEPARATE provider/vendor-lane transient cooldown
  // (llm-provider-cooldown.ts's own rate/quota cooldown, keyed on provider+model+userId — not the
  // per-slug 404/403 cooldown this suite is otherwise testing). Without resetting it here, that
  // cooldown survives into a later test in this same file (same default userId "local") and
  // causes planLlmProviderAttempts to silently skip the primary attempt, undercounting
  // calledModels for an unrelated test.
  resetLlmProviderCooldownsForTests();
}, 120_000);

afterEach(async () => {
  vi.unstubAllGlobals();
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_URL;
  const { clearOpenRouterModelCooldowns } = await import("../src/lib/model-rotation");
  const { resetLlmProviderCooldownsForTests } = await import("../src/lib/llm-provider-cooldown");
  clearOpenRouterModelCooldowns();
  resetLlmProviderCooldownsForTests();
});

const buyProposal = (): any => ({
  symbol: "AAPL",
  side: "buy",
  type: "market",
  timeInForce: "gfd",
  marketHours: "regular_hours",
  rationale: "momentum",
  confidenceScore: 90,
  tradeThesisTag: "t",
  entryMarketRegime: "t"
});

async function setupWithFallback(accountNumber: string, redTeamFallbackModels: string[] = ["anthropic/claude-opus-4-8"]) {
  const { setPolicy, setStrategyPrompt } = await import("../src/lib/db");
  process.env.OPENROUTER_API_KEY = "test-key";
  process.env.OPENROUTER_API_URL = "https://openrouter.ai/v1/chat/completions";
  setPolicy({
    ...DEFAULT_POLICY,
    accountNumber,
    llmModel: "openai/gpt-4.1-mini",
    redTeamLlmModel: "mistralai/mistral-medium-3.5",
    redTeamFallbackModels
  });
  setStrategyPrompt("BASE STRATEGY");
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const APPROVE_VERDICT = JSON.stringify({ verdict: "approve", reason: "Served by the alternate reviewer." });

describe("debateProposal — OpenRouter access-error (403) failover", () => {
  it("cools the primary slug and serves the review from the configured fallback model", async () => {
    const { debateProposal } = await import("../src/lib/red-team");
    const { isOpenRouterModelCoolingDown } = await import("../src/lib/model-rotation");
    await setupWithFallback("RT_403_FAILOVER");
    const calledModels: string[] = [];
    vi.stubGlobal("fetch", async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
      calledModels.push(body.model ?? "");
      if ((body.model ?? "").includes("claude")) return jsonResponse({ choices: [{ message: { content: APPROVE_VERDICT } }] }, 200);
      return jsonResponse(
        { error: { message: "Your OpenRouter key doesn't have access to this model or region." } },
        403
      );
    });

    const result = await debateProposal(buyProposal(), undefined);

    expect(result.available).toBe(true);
    expect(result.verdict).toBe("approve");
    expect(calledModels.length).toBe(2);
    expect(calledModels[0]).toContain("mistral");
    expect(calledModels[1]).toContain("claude");
    // The 403'd slug is now cooling down for THIS user's future rotation picks (model-rotation.ts).
    // A 403 is a fact about one key/region, so it is scoped to the user whose key saw it (review
    // round 2026-09-25); another user's rotation is untouched.
    expect(isOpenRouterModelCoolingDown("mistralai/mistral-medium-3.5", Date.now(), "local")).toBe(true);
    expect(isOpenRouterModelCoolingDown("mistralai/mistral-medium-3.5", Date.now(), "someone-else")).toBe(false);
    // The reviewer that actually served the verdict is recorded, not the primary that 403'd.
    expect(result.model).toContain("claude");
  });

  it("does NOT cool the slug on a 429 rate limit, but still fails over to the fallback for this run", async () => {
    const { debateProposal } = await import("../src/lib/red-team");
    const { isOpenRouterModelCoolingDown } = await import("../src/lib/model-rotation");
    await setupWithFallback("RT_429_NO_COOL");
    const calledModels: string[] = [];
    vi.stubGlobal("fetch", async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
      calledModels.push(body.model ?? "");
      if ((body.model ?? "").includes("claude")) return jsonResponse({ choices: [{ message: { content: APPROVE_VERDICT } }] }, 200);
      return jsonResponse({ error: { message: "Rate limit exceeded." } }, 429);
    });

    const result = await debateProposal(buyProposal(), undefined);

    expect(result.available).toBe(true);
    expect(calledModels.length).toBe(2);
    // Transient — must NOT be treated as a permanent access error and cooled.
    expect(isOpenRouterModelCoolingDown("mistralai/mistral-medium-3.5", Date.now(), "local")).toBe(false);
  });

  it("fails closed with a clear, actionable reason once every planned attempt 403s — and cools every attempted slug", async () => {
    const { debateProposal } = await import("../src/lib/red-team");
    const { isOpenRouterModelCoolingDown } = await import("../src/lib/model-rotation");
    await setupWithFallback("RT_403_EXHAUST");
    const calledModels: string[] = [];
    vi.stubGlobal("fetch", async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
      calledModels.push(body.model ?? "");
      return jsonResponse(
        { error: { message: "Your OpenRouter key doesn't have access to this model or region." } },
        403
      );
    });

    const result = await debateProposal(buyProposal(), undefined);

    expect(result.available).toBe(false);
    expect(result.failureKind).toBe("provider_error");
    // Clear, actionable message — not a bare "unavailable".
    expect(result.reason).toContain("doesn't have access to this model or region");
    expect(calledModels.length).toBe(2); // both the primary AND the configured fallback were tried
    // Review round 2026-09-25: the exhaustion message names EVERY reviewer model it tried, not just
    // the last error, so an operator can see the failover actually ran.
    expect(result.reason).toContain("Tried 2 reviewer models");
    expect(result.reason).toMatch(/mistral-medium/);
    expect(result.reason).toMatch(/claude-opus/);
    expect(isOpenRouterModelCoolingDown("mistralai/mistral-medium-3.5", Date.now(), "local")).toBe(true);
    expect(isOpenRouterModelCoolingDown("anthropic/claude-opus-4-8", Date.now(), "local")).toBe(true);
  });

  it("does NOT cool the slug on a moderation-flagged 403 (one prompt, not the model), but still fails over", async () => {
    const { debateProposal } = await import("../src/lib/red-team");
    const { isOpenRouterModelCoolingDown } = await import("../src/lib/model-rotation");
    await setupWithFallback("RT_403_MODERATION");
    const calledModels: string[] = [];
    vi.stubGlobal("fetch", async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
      calledModels.push(body.model ?? "");
      if ((body.model ?? "").includes("claude")) return jsonResponse({ choices: [{ message: { content: APPROVE_VERDICT } }] }, 200);
      return jsonResponse(
        {
          error: {
            code: 403,
            message: 'mistralai/mistral-medium-3.5 requires moderation on OpenRouter. Your input was flagged for "violence".',
            metadata: { reasons: ["violence"], flagged_input: "...", provider_name: "Mistral", model_slug: "mistralai/mistral-medium-3.5" }
          }
        },
        403
      );
    });

    const result = await debateProposal(buyProposal(), undefined);

    expect(result.available).toBe(true);
    expect(calledModels.length).toBe(2);
    expect(isOpenRouterModelCoolingDown("mistralai/mistral-medium-3.5", Date.now(), "local")).toBe(false);
    expect(isOpenRouterModelCoolingDown("mistralai/mistral-medium-3.5")).toBe(false);
  });
});

// Review round 2026-09-25 (P1): a fallback reviewer must never be the model that PROPOSED the
// trade.  Red's implicit rotation chain used to put Green's own pick first; the strategy loop now
// excludes it when planning, and debateProposal also refuses at call time so a Green FAILOVER onto
// a model in Red's chain is covered too.  Before #3761 the review was simply unavailable (held for
// human approval) in this situation; a self-review that auto-executes under Autopilot is worse.
describe("debateProposal: a fallback reviewer never reviews its own proposal", () => {
  it("skips a fallback that is the proposer and fails closed when nothing else remains", async () => {
    const { debateProposal } = await import("../src/lib/red-team");
    await setupWithFallback("RT_SELF_REVIEW_ONLY");
    const calledModels: string[] = [];
    vi.stubGlobal("fetch", async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
      calledModels.push(body.model ?? "");
      if ((body.model ?? "").includes("claude")) return jsonResponse({ choices: [{ message: { content: APPROVE_VERDICT } }] }, 200);
      return jsonResponse({ error: { message: "Your OpenRouter key doesn't have access to this model or region." } }, 403);
    });

    const result = await debateProposal({ ...buyProposal(), proposedByModel: "anthropic/claude-opus-4-8" }, undefined);

    expect(result.available).toBe(false);
    // The proposer was never asked to review itself: only the primary reviewer was called.
    expect(calledModels.length).toBe(1);
    expect(calledModels[0]).toContain("mistral");
    expect(result.reason).toContain("anthropic/claude-opus-4-8");
    expect(result.reason).toContain("proposed this trade");
  });

  it("skips the proposer (matched by model line, any spelling) and serves from the next fallback", async () => {
    const { debateProposal } = await import("../src/lib/red-team");
    await setupWithFallback("RT_SELF_REVIEW_NEXT", ["gemini-flash-latest", "anthropic/claude-opus-4-8"]);
    const calledModels: string[] = [];
    vi.stubGlobal("fetch", async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
      calledModels.push(body.model ?? "");
      if ((body.model ?? "").includes("claude") || (body.model ?? "").includes("gemini")) {
        return jsonResponse({ choices: [{ message: { content: APPROVE_VERDICT } }] }, 200);
      }
      return jsonResponse({ error: { message: "Upstream error." } }, 503);
    });

    // Green served the proposal via a namespaced spelling of the Gemini Flash line.
    const result = await debateProposal({ ...buyProposal(), proposedByModel: "openrouter/google/gemini-flash-latest" }, undefined);

    expect(result.available).toBe(true);
    expect(calledModels.some((model) => model.includes("gemini"))).toBe(false);
    expect(calledModels[calledModels.length - 1]).toContain("claude");
    expect(result.model).toContain("claude");
  });

  it("leaves the owner-chosen PRIMARY reviewer alone even when it matches the proposer", async () => {
    const { debateProposal } = await import("../src/lib/red-team");
    await setupWithFallback("RT_SELF_REVIEW_PRIMARY");
    const calledModels: string[] = [];
    vi.stubGlobal("fetch", async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
      calledModels.push(body.model ?? "");
      return jsonResponse({ choices: [{ message: { content: APPROVE_VERDICT } }] }, 200);
    });

    const result = await debateProposal({ ...buyProposal(), proposedByModel: "mistralai/mistral-medium-3.5" }, undefined);

    expect(result.available).toBe(true);
    expect(calledModels.length).toBe(1);
    expect(calledModels[0]).toContain("mistral");
  });
});
