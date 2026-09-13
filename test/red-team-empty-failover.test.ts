import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DEFAULT_POLICY } from "../src/lib/defaults";

// Prod incident 2026-07-28..30: the configured Red Team reviewer started returning HTTP-200
// responses with EMPTY or malformed content (provider-side glitch). Every one of those declared
// the whole review "unavailable" — even with a healthy fallback reviewer configured — because
// only HTTP errors/timeouts failed over. These tests pin the fix: empty/ambiguous/unparseable/
// malformed-shape content now fails over to the next planned reviewer, and the chain remains
// fail-CLOSED (unavailable) only once every planned attempt has failed.

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-red-team-failover-${randomUUID()}.db`)}`;
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_URL;
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
    redTeamLlmModel: "openai/gpt-4.1-mini",
    redTeamFallbackModels: ["anthropic/claude-opus-4-8"]
  });
  setStrategyPrompt("BASE STRATEGY");
}

function chatResponse(content: string): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content } }] }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

const FALLBACK_VERDICT = JSON.stringify({ verdict: "approve", reason: "Served by the fallback reviewer." });

/** Stub where the PRIMARY model misbehaves (per `primaryContent`) and the fallback returns a
 *  valid verdict. Returns the list of model names actually called, in order. */
function stubPrimaryFailure(primaryContent: string | null): string[] {
  const calledModels: string[] = [];
  vi.stubGlobal("fetch", async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
    calledModels.push(body.model ?? "");
    if ((body.model ?? "").includes("claude")) return chatResponse(FALLBACK_VERDICT);
    return chatResponse(primaryContent ?? "");
  });
  return calledModels;
}

describe("debateProposal — malformed-content failover (prod 2026-07-28..30 'Red Team unavailable' storm)", () => {
  it("empty content from the primary fails over to the fallback reviewer, which serves the verdict", async () => {
    const { debateProposal } = await import("../src/lib/red-team");
    await setupWithFallback("RT_FO_EMPTY");
    const calledModels = stubPrimaryFailure("");

    const result = await debateProposal(buyProposal(), undefined);
    expect(result.available).toBe(true);
    expect(result.verdict).toBe("approve");
    expect(result.rejected).toBe(false);
    expect(result.failureKind).toBeUndefined();
    expect(calledModels.length).toBe(2);
    expect(calledModels[0]).toContain("gpt-4.1-mini");
    expect(calledModels[1]).toContain("claude");
  });

  it("multiple conflicting verdict blocks from the primary fail over instead of declaring unavailable", async () => {
    const { debateProposal } = await import("../src/lib/red-team");
    await setupWithFallback("RT_FO_AMBIG");
    const ambiguous =
      JSON.stringify({ verdict: "reject", reason: "Overbought." }) +
      "\n" +
      JSON.stringify({ verdict: "approve", reason: "But momentum." });
    const calledModels = stubPrimaryFailure(ambiguous);

    const result = await debateProposal(buyProposal(), undefined);
    expect(result.available).toBe(true);
    expect(result.verdict).toBe("approve");
    expect(calledModels.length).toBe(2);
  });

  it("unparseable primary output fails over to the fallback reviewer", async () => {
    const { debateProposal } = await import("../src/lib/red-team");
    await setupWithFallback("RT_FO_UNPARSE");
    const calledModels = stubPrimaryFailure("The market is very interesting today {{{ not json at all");

    const result = await debateProposal(buyProposal(), undefined);
    expect(result.available).toBe(true);
    expect(result.verdict).toBe("approve");
    expect(calledModels.length).toBe(2);
  });

  it("a parseable-but-wrong-shape primary verdict fails over to the fallback reviewer", async () => {
    const { debateProposal } = await import("../src/lib/red-team");
    await setupWithFallback("RT_FO_SHAPE");
    const calledModels = stubPrimaryFailure(JSON.stringify({ rejected: false, reason: "legacy shape" }));

    const result = await debateProposal(buyProposal(), undefined);
    expect(result.available).toBe(true);
    expect(result.verdict).toBe("approve");
    expect(calledModels.length).toBe(2);
  });

  it("non-JSON body (e.g. HTML proxy error) from the primary fails over to the fallback reviewer", async () => {
    const { debateProposal } = await import("../src/lib/red-team");
    await setupWithFallback("RT_FO_HTML");
    const calledModels: string[] = [];
    vi.stubGlobal("fetch", async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
      calledModels.push(body.model ?? "");
      if ((body.model ?? "").includes("claude")) return chatResponse(FALLBACK_VERDICT);
      return new Response("<html><body>502 Bad Gateway</body></html>", {
        status: 200,
        headers: { "content-type": "text/html" }
      });
    });

    const result = await debateProposal(buyProposal(), undefined);
    expect(result.available).toBe(true);
    expect(result.verdict).toBe("approve");
    expect(calledModels.length).toBe(2);
  });

  it("fail-closed is preserved: when EVERY planned attempt returns empty content the review is unavailable", async () => {
    const { debateProposal } = await import("../src/lib/red-team");
    await setupWithFallback("RT_FO_EXHAUST");
    const calledModels: string[] = [];
    vi.stubGlobal("fetch", async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
      calledModels.push(body.model ?? "");
      return chatResponse("");
    });

    const result = await debateProposal(buyProposal(), undefined);
    expect(result.available).toBe(false);
    expect(result.rejected).toBe(false); // never silently rejects at the function level
    expect(result.verdict).toBeUndefined();
    expect(result.failureKind).toBe("malformed_response");
    expect(calledModels.length).toBe(2); // primary AND fallback were both tried before failing closed
  });

  it("fail-closed is preserved: when EVERY planned attempt returns malformed non-JSON body, the review is unavailable", async () => {
    const { debateProposal } = await import("../src/lib/red-team");
    await setupWithFallback("RT_FO_HTML_EXHAUST");
    const calledModels: string[] = [];
    vi.stubGlobal("fetch", async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
      calledModels.push(body.model ?? "");
      return new Response("<html><body>502 Bad Gateway</body></html>", {
        status: 200,
        headers: { "content-type": "text/html" }
      });
    });

    const result = await debateProposal(buyProposal(), undefined);
    expect(result.available).toBe(false);
    expect(result.rejected).toBe(false);
    expect(result.verdict).toBeUndefined();
    expect(result.failureKind).toBe("malformed_response");
    expect(calledModels.length).toBe(2);
  });
});

