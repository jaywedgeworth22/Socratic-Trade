import { describe, expect, it } from "vitest";
import { HOLD_REASON_LABELS, classifyHoldReasonFromCodes } from "../src/lib/hold-reason";
import type { HumanReviewReasonCode } from "../src/lib/types";

// Root cause (2026-09-25, board 687a5fb4, lane G3): the owner's performance report found Autopilot
// ("decide") proposals landing "Awaiting approval" with no structured way to tell why. This suite
// covers the pure classifier that buckets the underlying HumanReviewReasonCode receipts into the
// coarser, aggregable holdReason used by the run summary, the console approval card, and
// GET /api/ops/performance's funnel.
describe("classifyHoldReasonFromCodes", () => {
  it("classifies initial_red_team as red_team_unavailable", () => {
    expect(classifyHoldReasonFromCodes(["initial_red_team"])).toBe("red_team_unavailable");
  });

  it("classifies final_size_red_team as red_team_unavailable", () => {
    expect(classifyHoldReasonFromCodes(["final_size_red_team"])).toBe("red_team_unavailable");
  });

  it("classifies pre_veto_override as policy_revert", () => {
    expect(classifyHoldReasonFromCodes(["pre_veto_override"])).toBe("policy_revert");
  });

  it("classifies override_resolution as policy_revert", () => {
    expect(classifyHoldReasonFromCodes(["override_resolution"])).toBe("policy_revert");
  });

  it("classifies a standalone rationale_collapse as other", () => {
    expect(classifyHoldReasonFromCodes(["rationale_collapse"])).toBe("other");
  });

  it("classifies no codes at all as other (safe default)", () => {
    expect(classifyHoldReasonFromCodes([])).toBe("other");
  });

  it("prefers red_team_unavailable over policy_revert when both are present", () => {
    const codes: HumanReviewReasonCode[] = ["pre_veto_override", "initial_red_team"];
    expect(classifyHoldReasonFromCodes(codes)).toBe("red_team_unavailable");
  });

  it("prefers policy_revert over other when both a policy code and rationale_collapse are present", () => {
    const codes: HumanReviewReasonCode[] = ["rationale_collapse", "override_resolution"];
    expect(classifyHoldReasonFromCodes(codes)).toBe("policy_revert");
  });

  it("has a label for every HoldReasonCode", () => {
    expect(Object.keys(HOLD_REASON_LABELS).sort()).toEqual(
      ["funding_sell", "other", "policy_revert", "red_team_unavailable"].sort()
    );
  });
});
