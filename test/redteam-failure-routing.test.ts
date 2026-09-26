import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_POLICY } from "../src/lib/defaults";
import { describeRedTeamFailureKind, routeOnAdversaryUnavailable } from "../src/lib/red-team-routing";

// Board item: "Bear/Red-Team unavailable -> policy-aware routing for ALL failure modes
// (propose -> human-approval; autonomous -> de-risk-only + 'RED TEAM FAILED' flag)".
//
// Part 1: pure unit tests for the extracted routing helper (routeOnAdversaryUnavailable /
// describeRedTeamFailureKind) — no DB, no network, deterministic.
describe("routeOnAdversaryUnavailable — pure routing helper", () => {
  it("holds an OPENING (buy) for human review with the failureKind in the note", () => {
    const routing = routeOnAdversaryUnavailable("buy", "timeout", "Red Team evaluation errored out.");
    expect(routing.holdForHuman).toBe(true);
    expect(routing.note).toContain("timeout");
    expect(routing.note).toContain("routed to human approval");
  });

  it("holds an OPENING (short) for human review", () => {
    const routing = routeOnAdversaryUnavailable("short", "provider_error", "Red Team debate unavailable — 500.");
    expect(routing.holdForHuman).toBe(true);
    expect(routing.note).toContain("provider error");
  });

  it("holds an OPENING even when deRiskExitsOnAdversaryUnavailable is opted in — openings are never exempted", () => {
    const routing = routeOnAdversaryUnavailable("buy", "timeout", "Red Team evaluation errored out.", true);
    expect(routing.holdForHuman).toBe(true);
  });

  // Owner ruling 2026-09-24 (board 687a5fb4): the default flipped from OFF to ON — see
  // src/lib/defaults.ts's DEFAULT_POLICY.tuning.deRiskExitsOnAdversaryUnavailable and
  // test/model-defaults-derisk-exits.test.ts for the merge-inheritance coverage. This file keeps
  // testing the PURE routeOnAdversaryUnavailable helper directly, so "default" here means the
  // boolean value mergePolicy now actually threads through (`true`), plus the bare-`undefined`
  // case for a caller that bypasses the merged policy entirely (same behavior as `true`).
  describe("default (policy.tuning.deRiskExitsOnAdversaryUnavailable is true, or undefined)", () => {
    it("does NOT hold a de-risking SELL — appends a loud 'RED TEAM FAILED' note instead", () => {
      const routing = routeOnAdversaryUnavailable("sell", "rate_limited", "429", true);
      expect(routing.holdForHuman).toBe(false);
      expect(routing.note).toContain("RED TEAM FAILED");
      expect(routing.note).toContain("rate limited");
      expect(routing.note).toContain("reduces risk");
    });

    it("does NOT hold a de-risking COVER — appends a loud 'RED TEAM FAILED' note instead", () => {
      const routing = routeOnAdversaryUnavailable("cover", "malformed_response", "bad shape", true);
      expect(routing.holdForHuman).toBe(false);
      expect(routing.note).toContain("RED TEAM FAILED");
      expect(routing.note).toContain("malformed response");
    });

    it("a bare undefined 4th arg (no policy override reached this call) also does NOT hold — matches the new merged-policy default, never silently reverts to the old hold-by-default", () => {
      const sell = routeOnAdversaryUnavailable("sell", "rate_limited", "429");
      expect(sell.holdForHuman).toBe(false);
      expect(sell.note).toContain("RED TEAM FAILED");

      const cover = routeOnAdversaryUnavailable("cover", "malformed_response", "bad shape", undefined);
      expect(cover.holdForHuman).toBe(false);
      expect(cover.note).toContain("RED TEAM FAILED");
    });

    it("handles an absent failureKind (legacy/unclassified unavailability) with a generic label", () => {
      const opening = routeOnAdversaryUnavailable("buy", undefined, "unknown error", true);
      expect(opening.holdForHuman).toBe(true);
      expect(opening.note).toContain("unavailable");

      const exit = routeOnAdversaryUnavailable("cover", undefined, "unknown error", true);
      expect(exit.holdForHuman).toBe(false);
      expect(exit.note).toContain("RED TEAM FAILED");
    });

    it("under propose authority (autoExecutes=false) a de-risk exit is NOT held but the note says 'surfaced for approval', never 'proceeding'", () => {
      const decide = routeOnAdversaryUnavailable("sell", "timeout", "timed out", true, true);
      expect(decide.holdForHuman).toBe(false);
      expect(decide.note).toContain("proceeding because this order reduces risk");

      const propose = routeOnAdversaryUnavailable("sell", "timeout", "timed out", true, false);
      expect(propose.holdForHuman).toBe(false); // routing decision itself is unchanged
      expect(propose.note).toContain("RED TEAM FAILED");
      expect(propose.note).toContain("surfaced for your approval");
      expect(propose.note).not.toContain("proceeding because"); // never falsely claims it proceeds
    });
  });

  describe("opted OUT (policy.tuning.deRiskExitsOnAdversaryUnavailable === false)", () => {
    it("holds a de-risking SELL for human review — the pre-2026-09-24 behavior, still available per-account", () => {
      const routing = routeOnAdversaryUnavailable("sell", "rate_limited", "429", false);
      expect(routing.holdForHuman).toBe(true);
      expect(routing.note).toContain("routed to human approval");
    });

    it("holds a de-risking COVER for human review", () => {
      const routing = routeOnAdversaryUnavailable("cover", "malformed_response", "bad shape", false);
      expect(routing.holdForHuman).toBe(true);
      expect(routing.note).toContain("routed to human approval");
    });
  });
});

describe("describeRedTeamFailureKind", () => {
  it("labels every failureKind and falls back for undefined", () => {
    expect(describeRedTeamFailureKind("not_configured")).toBe("not configured");
    expect(describeRedTeamFailureKind("timeout")).toBe("timeout");
    expect(describeRedTeamFailureKind("provider_error")).toBe("provider error");
    expect(describeRedTeamFailureKind("rate_limited")).toBe("rate limited");
    expect(describeRedTeamFailureKind("malformed_response")).toBe("malformed response");
    expect(describeRedTeamFailureKind(undefined)).toBe("unavailable");
  });
});

// Part 2: routing consistency driven through runStrategyOnce, mirroring the E2E pattern in
// test/strategy-money-path-f-g.test.ts (F1/F2). Verifies the debateProposal-unavailable branch in
// strategy.ts actually calls the helper above and wires its result end to end: an opening is held
// for human review with the failureKind visible in its persisted reason, and the parity audit event
// (strategy_red_team_unavailable) is emitted.
vi.mock("../src/lib/vector-db", () => ({
  managedVectorLedgerAuthority: vi.fn(),
  getCurrentVectorProviderAuthority: vi.fn(),
  findRelevantExperiences: async () => [],
  upsertExperiences: async () => {},
  retrieveContext: async () => [],
  retrieveContextDetailed: async () => [],
  defaultMinScore: () => 0.3,
  defaultRelevanceFloor: () => 0.3,
  defaultDedupeSimilarity: () => 0.6,
  formatChunkWithProvenance: (chunk: { text: string }) => chunk.text,
  storeContext: async () => {},
  storeContexts: async () => {}
}));

beforeEach(() => {
  vi.resetModules();
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-redteam-routing-${randomUUID()}.db`)}`;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  delete process.env.OPENROUTER_API_KEY;
});

const BULL_OPENING_PROPOSAL = {
  symbol: "AAPL",
  side: "buy",
  type: "market",
  dollarAmount: 100,
  timeInForce: "gfd",
  marketHours: "regular_hours",
  rationale: "Strong momentum with fundamental support.",
  tradeThesisTag: "Quality-Compounder",
  entryMarketRegime: "Neutral (Normal Volatility)",
  confidenceScore: 90
};

/** Fetch stub: the Bull/Bear OpenAI calls succeed and propose `proposals`; the Red Team debate
 *  (`debateProposal`, identified by its "Red Team Risk Agent" system prompt marker) returns a 429
 *  so the debate is unavailable with failureKind "rate_limited". Nasdaq quotes are stubbed too. */
function makeUnavailableFetchStub(proposals: unknown[] = [BULL_OPENING_PROPOSAL]) {
  return async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    if ((href.includes("openrouter.ai") || href.includes("api.openai.com"))) {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      const systemContent = JSON.stringify(body);
      if (systemContent.includes("Red Team Risk Agent")) {
        return new Response("Too Many Requests", { status: 429 });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ proposals }) } }] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    if (href.includes("nasdaq.com")) {
      return new Response(
        JSON.stringify({
          data: {
            asof: "2026-06-30",
            table: {
              rows: [
                {
                  symbol: "AAPL",
                  lastsale: "$200",
                  pctchange: "1%",
                  volume: "1000000",
                  marketCap: "3000000000000",
                  sector: "Technology",
                  industry: "Consumer Electronics"
                }
              ]
            }
          }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    return new Response("not found", { status: 404 });
  };
}

async function seedTestAccountAndPolicy() {
  const { upsertConnectedAccount, setActiveConnectedAccount, setPolicy, upsertUserApiKey } = await import("../src/lib/db");
  upsertUserApiKey("local", "openrouter", "test-openai-key", "test fixture");
  const accountId = randomUUID();
  upsertConnectedAccount({
    id: accountId,
    userId: "local",
    broker: "test",
    environment: "paper",
    accountNumber: "TEST",
    label: "Test Account",
    isActive: true
  });
  setActiveConnectedAccount(accountId);
  setPolicy({
    ...DEFAULT_POLICY,
    systemState: "active",
    llmModel: "openai/gpt-4.1-mini",
    // Required explicit Red model (no-defaults world) — the stub answers it with a 429 so the
    // review is unavailable with failureKind "rate_limited".
    redTeamLlmModel: "openai/gpt-4.1-mini",
    includedIndices: [],
    additionalSymbols: ["AAPL"],
    strategyAuthority: "decide"
  });
}

describe("Red Team unavailable — opening routing + audit parity (decide authority)", () => {
  it("holds a high-conviction OPENING for human review with failureKind visible, and audits strategy_red_team_unavailable", async () => {
    process.env.OPENROUTER_API_KEY = "test-openai-key";
    vi.stubGlobal("fetch", makeUnavailableFetchStub());

    await seedTestAccountAndPolicy();
    const { runStrategyOnce } = await import("../src/lib/strategy");
    const { listRecentProposals, listAudit, listFillEvents } = await import("../src/lib/db");

    const result = await runStrategyOnce();
    expect(result.status).toBe("completed");

    // Held for human review, not auto-executed: no fill was booked, and the proposal is "proposed".
    expect(listFillEvents("TEST", undefined, 100, "local").find((f) => f.symbol === "AAPL")).toBeUndefined();
    const proposals = listRecentProposals("TEST", 100, "local");
    const aaplProposal = proposals.find((p) => p.proposal.symbol === "AAPL");
    expect(aaplProposal).toBeDefined();
    expect(aaplProposal?.status).toBe("proposed");

    // Deliverable B: failureKind stamped on the persisted redTeamVerdict.
    expect(aaplProposal?.proposal.redTeamVerdict?.available).toBe(false);
    expect(aaplProposal?.proposal.redTeamVerdict?.failureKind).toBe("rate_limited");

    // Deliverable D: the loud, human-facing reason includes the failureKind, not just a generic
    // "unavailable" message.
    expect(aaplProposal?.proposal.rationale).toMatch(/rate limited/i);

    // Regression: the "Why your approval is required" summary used to double its terminal
    // punctuation whenever the Red Team's own reason string already ended in a period (which it
    // always does — humanizeLlmError's rate-limit message ends "...check OpenRouter billing.").
    // The old template hard-appended another "." right after it: "...billing.. No model
    // critiqued...".
    const initialRedTeamReason = aaplProposal?.proposal.humanReviewReasons?.find((r) => r.code === "initial_red_team");
    expect(initialRedTeamReason?.summary).toBeDefined();
    expect(initialRedTeamReason?.summary).not.toMatch(/\.\./);
    expect(initialRedTeamReason?.summary).toContain("No model critiqued this opening");

    // lane G3: an initial_red_team hold (decide authority's fail-closed requiresHumanReview
    // branch) classifies as the "red_team_unavailable" holdReason bucket (hold-reason.ts).
    expect(aaplProposal?.proposal.holdReason).toBe("red_team_unavailable");

    // Deliverable B: audit parity with strategy_bear_review_unavailable.
    const unavailableAudits = listAudit(500).filter((e) => e.kind === "strategy_red_team_unavailable");
    expect(unavailableAudits.length).toBeGreaterThanOrEqual(1);
    const payload = unavailableAudits[0].payload as {
      symbol?: string;
      side?: string;
      failureKind?: string;
      heldForHuman?: boolean;
    };
    expect(payload.symbol).toBe("AAPL");
    expect(payload.side).toBe("buy");
    expect(payload.failureKind).toBe("rate_limited");
    expect(payload.heldForHuman).toBe(true);
  }, 30_000);
});

const SELL_PROPOSAL = {
  symbol: "AAPL",
  side: "sell",
  type: "market",
  quantity: 1,
  timeInForce: "gfd",
  marketHours: "regular_hours",
  rationale: "Take profit into strength.",
  tradeThesisTag: "Quality-Compounder",
  entryMarketRegime: "Neutral (Normal Volatility)",
  confidenceScore: 90
};

async function seedExistingAaplLongPosition() {
  const { insertFillEvent } = await import("../src/lib/db-fills");
  // Seed an existing AAPL long position (an open lot) so the sell is sizeable/not a phantom sell.
  // Cost basis is deliberately close to the stubbed $200 quote (< policy.riskRules.takeProfitPct's
  // default 20% band) so `planTakeProfitTrims`'s independent, price-driven take-profit-trim
  // mechanism does NOT ALSO fire a competing AAPL sell proposal here — that pipeline is unrelated to
  // this test's target (the debate-unavailable routing branch) and its proposal would otherwise
  // intermittently race/collide with (and sometimes clobber) the one asserted on below.
  insertFillEvent({
    userId: "local",
    accountNumber: "TEST",
    source: "paper",
    symbol: "AAPL",
    side: "buy",
    quantity: 5,
    price: 190,
    notional: 950,
    status: "filled"
  });
}

describe("Red Team unavailable — exits are STRUCTURALLY EXEMPT (§3.5: never reviewed, never holdable)", () => {
  it("a de-risking SELL of an existing position proceeds to placement with NO review call, no verdict, no unavailable audit — even while the reviewer is down", async () => {
    process.env.OPENROUTER_API_KEY = "test-openai-key";
    vi.stubGlobal("fetch", makeUnavailableFetchStub([SELL_PROPOSAL]));

    await seedTestAccountAndPolicy();
    await seedExistingAaplLongPosition();

    const { runStrategyOnce } = await import("../src/lib/strategy");
    const { listRecentProposals, listAudit } = await import("../src/lib/db");

    const result = await runStrategyOnce();
    expect(result.status).toBe("completed");

    // Single-adversary consolidation: exits NEVER reach the reviewer, so a reviewer outage can't
    // freeze a risk-reducing trade behind an approval queue — the sell places.
    const proposals = listRecentProposals("TEST", 100, "local");
    const aaplSell = proposals.find((p) => p.proposal.symbol === "AAPL" && p.proposal.side === "sell");
    expect(aaplSell).toBeDefined();
    expect(aaplSell?.status).toBe("filled");
    // No verdict is ever stamped on an exit (it was never reviewed) and no unavailable audit fires.
    expect(aaplSell?.proposal.redTeamVerdict).toBeUndefined();
    const unavailableAudits = listAudit(500).filter(
      (e) => e.kind === "strategy_red_team_unavailable" && (e.payload as { side?: string }).side === "sell"
    );
    expect(unavailableAudits).toHaveLength(0);
  }, 30_000);
});

describe("Red Team unavailable — propose authority surfaces the flag on the pending card", () => {
  it("appends a RED TEAM FAILED note to a propose-mode card so the approver sees the adversary never ran", async () => {
    process.env.OPENROUTER_API_KEY = "test-openai-key";
    vi.stubGlobal("fetch", makeUnavailableFetchStub());

    await seedTestAccountAndPolicy();
    const { setPolicy, getPolicy, listRecentProposals } = await import("../src/lib/db");
    setPolicy({ ...getPolicy("local"), strategyAuthority: "propose" });

    const { runStrategyOnce } = await import("../src/lib/strategy");
    const result = await runStrategyOnce();
    expect(result.status).toBe("completed");

    const proposals = listRecentProposals("TEST", 100, "local");
    const aaplProposal = proposals.find((p) => p.proposal.symbol === "AAPL");
    expect(aaplProposal).toBeDefined();
    expect(aaplProposal?.status).toBe("proposed");
    expect(aaplProposal?.proposal.rationale).toContain("RED TEAM FAILED");
    // lane G3: the "propose" authority branch classifies holdReason from whatever
    // HumanReviewReasonCode(s) it carries — an opening's Red-Team-unavailable hold still fires
    // here (routeOnAdversaryUnavailable holds every OPENING regardless of authority).
    expect(aaplProposal?.proposal.holdReason).toBe("red_team_unavailable");
  }, 30_000);
});
