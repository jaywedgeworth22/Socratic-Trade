import { describe, expect, it } from "vitest";
import { flowsFromAlpacaActivities, listAlpacaTransferFlows, resolveExternalCashFlows } from "../src/lib/broker-cash-flows";
import type { AlpacaAccountActivity } from "../src/lib/alpaca-account-insights";

describe("broker-cash-flows", () => {
  it("maps CSD/CSW activities to signed per-day flows", () => {
    const activities: AlpacaAccountActivity[] = [
      { id: "1", activity_type: "CSD", date: "2026-06-10", net_amount: "5000" },
      { id: "2", activity_type: "CSW", date: "2026-06-10", net_amount: "-1200" }
    ];
    const flows = flowsFromAlpacaActivities(activities);
    expect(flows.get("2026-06-10")).toBeCloseTo(3800, 2);
  });

  it("lists signed transfer rows in chronological order including CSD/CSW", () => {
    const activities: AlpacaAccountActivity[] = [
      { id: "2", activity_type: "CSW", date: "2026-06-11", net_amount: "-1200" },
      { id: "1", activity_type: "CSD", date: "2026-06-10", net_amount: "5000" },
      { id: "fill", activity_type: "FILL", date: "2026-06-10", net_amount: "99" }
    ];
    const listed = listAlpacaTransferFlows(activities);
    expect(listed.map((row) => row.id)).toEqual(["1", "2"]);
    expect(listed[0].amount).toBeCloseTo(5000, 2);
    expect(listed[1].amount).toBeCloseTo(-1200, 2);
  });

  it("prefers broker ledger over inference when activities exist", () => {
    const equity = [
      { timestamp: "2026-06-09T20:00:00Z", equity: 100_000, cash: 100_000, positionsValue: 0, source: "live" as const },
      { timestamp: "2026-06-10T16:00:00Z", equity: 105_000, cash: 105_000, positionsValue: 0, source: "live" as const }
    ];
    const activities: AlpacaAccountActivity[] = [{ id: "d", activity_type: "CSD", date: "2026-06-10", net_amount: "5000" }];
    const resolved = resolveExternalCashFlows({ equityCurve: equity, fills: [], brokerActivities: activities });
    expect(resolved.source).toBe("broker");
    expect(resolved.flows.get("2026-06-10")).toBeCloseTo(5000, 2);
  });
});
