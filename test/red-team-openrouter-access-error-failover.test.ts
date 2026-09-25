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

async function setupWithFallback(accountNumber: string) {
  const { setPolicy, setStrategyPrompt } = await import("../src/lib/db");
  process.env.OPENROUTER_API_KEY = "test-key";
  process.env.OPENROUTER_API_URL = "https://openrouter.ai/v1/chat/completions";
  setPolicy({
    ...DEFAULT_POLICY,
    accountNumber,
    llmModel: "openai/gpt-4.1-mini",
    redTeamLlmModel: "mistralai/mistral-medium-3.5",
    redTeamFallbackModels: ["anthropic/claude-opus-4-8"]
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
    // The 403'd slug is now cooling down for future rotation picks (model-rotation.ts).
    expect(isOpenRouterModelCoolingDown("mistralai/mistral-medium-3.5")).toBe(true);
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
    expect(isOpenRouterModelCoolingDown("mistralai/mistral-medium-3.5")).toBe(false);
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
    expect(isOpenRouterModelCoolingDown("mistralai/mistral-medium-3.5")).toBe(true);
    expect(isOpenRouterModelCoolingDown("anthropic/claude-opus-4-8")).toBe(true);
  });
});
