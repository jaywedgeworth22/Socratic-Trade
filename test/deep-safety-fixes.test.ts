import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  claimProposalForExecution,
  claimSyntheticStop,
  getDb,
  getPolicy,
  getProposal,
  getSocraticDecisionCase,
  insertProposal,
  revertSyntheticStopClaim,
  setPolicy,
  transitionProposalIfPending,
  updateProposalStatus,
  upsertSocraticDecisionCase,
  upsertSyntheticStop,
  listSyntheticStops
} from "../src/lib/db";
import { reconcileAutonomyOnBoot } from "../src/lib/scheduler";
import { DEFAULT_POLICY } from "../src/lib/defaults";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-deepfix-${randomUUID()}.db`)}`;
});

function seedProposed(userId = "local", withDecisionCase = false): string {
  const id = randomUUID();
  insertProposal({
    id,
    userId,
    runId: "r1",
    accountNumber: "ACC1",
    proposal: {
      side: "buy",
      symbol: "AAPL",
      type: "market",
      dollarAmount: 1000,
      timeInForce: "gfd",
      marketHours: "regular_hours",
      rationale: "Atomic claim test.",
      tradeThesisTag: "test",
      entryMarketRegime: "test"
    },
    decision: { approved: true, reasons: [] },
    estimatedNotional: 1000,
    status: "proposed"
  });
  if (withDecisionCase) {
    upsertSocraticDecisionCase({
      id,
      userId,
      proposalId: id,
      runId: "r1",
      accountNumber: "ACC1",
      symbol: "AAPL",
      side: "buy",
      status: "proposed",
      authority: "decide",
      thesis: "test",
      rationale: "test",
      action: "BUY AAPL $1,000"
    });
  }
  return id;
}

// ── Fix T4: executeProposal double-execution (atomic CAS claim) ──────────────
describe("claimProposalForExecution — atomic proposal claim", () => {
  it("only the first concurrent claim of a 'proposed' row wins; the loser sees false", () => {
    const id = seedProposed("local", true);
    expect(claimProposalForExecution(id, "placing", "local", { refId: "rid-1" })).toBe(true);
    // Second claim loses — status is no longer 'proposed'.
    expect(claimProposalForExecution(id, "placing", "local", { refId: "rid-2" })).toBe(false);
    const row = getProposal(id, "local");
    expect(row?.status).toBe("placing");
  });

  it("fails closed when the proposal has no Socratic intent receipt", () => {
    const id = seedProposed();
    expect(claimProposalForExecution(id, "placing", "local", { refId: "rid-missing-case" })).toBe(false);
    expect(getProposal(id, "local")?.status).toBe("proposed");
  });

  it("rolls back a fallback case when the proposal CAS loses", () => {
    const id = seedProposed();
    expect(
      claimProposalForExecution(id, "placing", "local", {
        refId: "rid-lost-fallback",
        createSocraticDecisionCase: () => {
          upsertSocraticDecisionCase({
            id,
            userId: "local",
            proposalId: id,
            status: "proposed",
            authority: "decide",
            thesis: "test",
            rationale: "test",
            action: "BUY AAPL $1,000"
          });
          // Deterministically emulate a competing terminal transition between fallback creation and
          // the claim UPDATE. The transaction must roll back both writes when its CAS sees zero rows.
          getDb().prepare("UPDATE trade_proposals SET status = 'blocked' WHERE id = ? AND user_id = ?").run(id, "local");
        }
      })
    ).toBe(false);
    expect(getProposal(id, "local")?.status).toBe("proposed");
    expect(getSocraticDecisionCase(id, "local")).toBeUndefined();
  });

  it("refuses to claim a proposal that is not 'proposed'", () => {
    const id = seedProposed();
    updateProposalStatus(id, "blocked", undefined, undefined, undefined, "local");
    expect(claimProposalForExecution(id, "placing", "local")).toBe(false);
    expect(getProposal(id, "local")?.status).toBe("blocked");
  });

  it("can persist blocked policy decisions when status changes", () => {
    const id = seedProposed();
    updateProposalStatus(
      id,
      "blocked",
      undefined,
      undefined,
      undefined,
      "local",
      undefined,
      undefined,
      { approved: false, reasons: ["Symbol is not in the allowed universe."] }
    );

    const row = getProposal(id, "local");
    expect(row?.status).toBe("blocked");
    expect(row?.decision).toMatchObject({
      approved: false,
      reasons: ["Symbol is not in the allowed universe."]
    });
  });

  it("is scoped by userId (cannot claim another user's proposal)", () => {
    const id = seedProposed("local");
    expect(claimProposalForExecution(id, "placing", "someone-else")).toBe(false);
    expect(getProposal(id, "local")?.status).toBe("proposed");
  });
});

// ── Codex #323 round 2: refusal-path writes must not revive non-pending rows ─
describe("transitionProposalIfPending — guarded refusal-path status writes", () => {
  it("re-queues a still-pending row: status stays 'proposed' and the fresh decision persists", () => {
    const id = seedProposed();
    const reescalated = {
      approved: false,
      reasons: ["needs your call at the new price"],
      escalations: [{ kind: "wash_sale_ask", symbol: "AAPL", token: "tok-fresh" }]
    } as never;
    expect(transitionProposalIfPending(id, "proposed", "local", { decision: reescalated })).toBe(true);
    const row = getProposal(id, "local");
    expect(row?.status).toBe("proposed");
    expect(row?.decision).toMatchObject({ reasons: ["needs your call at the new price"] });
  });

  it("refuses to resurrect a proposal rejected while the approval was in flight", () => {
    const id = seedProposed();
    updateProposalStatus(id, "rejected", undefined, undefined, undefined, "local");
    expect(
      transitionProposalIfPending(id, "proposed", "local", {
        decision: { approved: false, reasons: ["stale re-escalation"] }
      })
    ).toBe(false);
    expect(getProposal(id, "local")?.status).toBe("rejected");
  });

  it("does not overwrite a scheduler expiry with 'blocked'", () => {
    const id = seedProposed();
    updateProposalStatus(id, "expired", undefined, undefined, undefined, "local");
    expect(transitionProposalIfPending(id, "blocked", "local")).toBe(false);
    expect(getProposal(id, "local")?.status).toBe("expired");
  });

  it("is scoped by userId (cannot touch another user's proposal)", () => {
    const id = seedProposed("local");
    expect(transitionProposalIfPending(id, "blocked", "someone-else")).toBe(false);
    expect(getProposal(id, "local")?.status).toBe("proposed");
  });
});

// ── Fix T5: synthetic-stop re-entrancy (atomic stop claim) ───────────────────
describe("claimSyntheticStop / revertSyntheticStopClaim — atomic stop claim", () => {
  function seedActiveStop(symbol: string, userId = "local"): string {
    const id = randomUUID();
    upsertSyntheticStop({
      id,
      userId,
      accountNumber: "ACC1",
      symbol,
      side: "long",
      quantity: 10,
      entryPrice: 100,
      extremePrice: 110,
      trailPercent: 5,
      trailAmount: undefined,
      status: "active",
      lastPrice: 108
    });
    return id;
  }

  it("only the first claim of an active stop wins; a concurrent monitor sees false", () => {
    const id = seedActiveStop("AAPL");
    expect(claimSyntheticStop(id, "local")).toBe(true);
    expect(claimSyntheticStop(id, "local")).toBe(false); // already 'triggered'
    // No longer listed among active stops.
    expect(listSyntheticStops("ACC1", "local").some((s) => s.id === id)).toBe(false);
  });

  it("revert re-arms a claimed stop so a failed placement can retry", () => {
    const id = seedActiveStop("MSFT");
    expect(claimSyntheticStop(id, "local")).toBe(true);
    revertSyntheticStopClaim(id, "local");
    // Back to active → claimable again on the next tick.
    expect(listSyntheticStops("ACC1", "local").some((s) => s.id === id)).toBe(true);
    expect(claimSyntheticStop(id, "local")).toBe(true);
  });
});

// ── Fix T3 (boot interlock): autonomy must not silently resume on boot ───────
describe("reconcileAutonomyOnBoot — boot-time autonomy interlock", () => {
  const userId = "local";
  afterEach(() => {
    delete process.env.AUTONOMY_RESUME_ON_BOOT;
  });

  it("reverts a persisted 'active' systemState to 'halted' when not opted in", async () => {
    delete process.env.AUTONOMY_RESUME_ON_BOOT;
    setPolicy({ ...DEFAULT_POLICY, accountNumber: "ACC1", systemState: "active" }, userId);
    await reconcileAutonomyOnBoot();
    expect(getPolicy(userId).systemState).toBe("halted");
  });

  it("leaves 'active' alone when AUTONOMY_RESUME_ON_BOOT=1", async () => {
    process.env.AUTONOMY_RESUME_ON_BOOT = "1";
    setPolicy({ ...DEFAULT_POLICY, accountNumber: "ACC1", systemState: "active" }, userId);
    await reconcileAutonomyOnBoot();
    expect(getPolicy(userId).systemState).toBe("active");
  });

  it("does not touch non-'active' safe states (e.g. close_only)", async () => {
    delete process.env.AUTONOMY_RESUME_ON_BOOT;
    setPolicy({ ...DEFAULT_POLICY, accountNumber: "ACC1", systemState: "close_only" }, userId);
    await reconcileAutonomyOnBoot();
    expect(getPolicy(userId).systemState).toBe("close_only");
  });
});
