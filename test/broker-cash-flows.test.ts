import { describe, expect, it } from "vitest";
import {
  BROKER_TRANSFER_ACTIVITY_TYPE_LIST,
  classifyAlpacaActivityType,
  flowsFromAlpacaActivities,
  listAlpacaTransferFlows,
  resolveExternalCashFlows,
  summarizeNonTradeActivities
} from "../src/lib/broker-cash-flows";
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

// 2026-09-24 (board 687a5fb4): realistic Alpaca non-trade payloads (category=non_trade_activity).
// Shapes follow Alpaca's NonTradeActivity schema: id "<yyyymmddhhmmssSSS>::<uuid>", date,
// net_amount (string), description, status, created_at.
describe("broker-cash-flows classification (IRA contributions, distributions, withholding)", () => {
  const rothLedger: AlpacaAccountActivity[] = [
    {
      id: "20260803000000000::1b0e3a52-0000-4000-8000-000000000001",
      activity_type: "CSD",
      date: "2026-08-03",
      net_amount: "101.62",
      description: "IRA contribution 2026 ACH 123456789",
      status: "executed",
      created_at: "2026-08-03T13:05:00Z"
    },
    {
      id: "20260909000000000::1b0e3a52-0000-4000-8000-000000000002",
      activity_type: "CSW",
      date: "2026-09-09",
      net_amount: "-62.69",
      description: "IRA distribution normal",
      status: "executed",
      created_at: "2026-09-09T14:00:00Z"
    },
    {
      id: "20260909000000001::1b0e3a52-0000-4000-8000-000000000003",
      activity_type: "WH",
      date: "2026-09-09",
      net_amount: "-6.96",
      description: "Federal tax withholding on distribution",
      status: "executed",
      created_at: "2026-09-09T14:00:01Z"
    },
    {
      id: "20260815000000000::1b0e3a52-0000-4000-8000-000000000004",
      activity_type: "DIV",
      date: "2026-08-15",
      net_amount: "0.12",
      symbol: "SPY",
      per_share_amount: "1.75",
      qty: "0.0686",
      status: "executed"
    },
    {
      id: "20260816000000000::1b0e3a52-0000-4000-8000-000000000005",
      activity_type: "FEE",
      date: "2026-08-16",
      net_amount: "-0.01",
      description: "REG/TAF fee",
      status: "executed"
    }
  ];

  it("counts an IRA contribution, distribution, and its tax withholding as external capital", () => {
    const flows = flowsFromAlpacaActivities(rothLedger);
    expect(flows.get("2026-08-03")).toBeCloseTo(101.62, 2);
    // Distribution + withholding: both left the account, neither is trading P&L.
    expect(flows.get("2026-09-09")).toBeCloseTo(-69.65, 2);
    const listed = listAlpacaTransferFlows(rothLedger);
    expect(listed.map((f) => f.activityType)).toEqual(["CSD", "DIV", "FEE", "CSW", "WH"]);
  });

  it("keeps dividends and fees as flows (pre-existing semantics) and classifies them", () => {
    expect(classifyAlpacaActivityType("DIV")).toBe("income");
    expect(classifyAlpacaActivityType("divtxex")).toBe("income");
    expect(classifyAlpacaActivityType("FEE")).toBe("expense");
    expect(classifyAlpacaActivityType("WH")).toBe("capital");
    expect(classifyAlpacaActivityType("ACATC")).toBe("capital");
    expect(classifyAlpacaActivityType("FILL")).toBe("position");
    expect(classifyAlpacaActivityType("SPLIT")).toBe("position");
    expect(flowsFromAlpacaActivities(rothLedger).get("2026-08-15")).toBeCloseTo(0.12, 2);
    expect(flowsFromAlpacaActivities(rothLedger).get("2026-08-16")).toBeCloseTo(-0.01, 2);
  });

  it("never lists DIVTX (not an Alpaca type); DIVTXEX is the real tax-exempt dividend code", () => {
    expect(BROKER_TRANSFER_ACTIVITY_TYPE_LIST as readonly string[]).not.toContain("DIVTX");
    expect(BROKER_TRANSFER_ACTIVITY_TYPE_LIST as readonly string[]).toContain("DIVTXEX");
    expect(BROKER_TRANSFER_ACTIVITY_TYPE_LIST as readonly string[]).toContain("ACATC");
    expect(BROKER_TRANSFER_ACTIVITY_TYPE_LIST as readonly string[]).toContain("WH");
  });

  it("ignores canceled rows and a cash ACAT (ACATC) in counts as capital", () => {
    const rows: AlpacaAccountActivity[] = [
      { id: "a", activity_type: "CSW", date: "2026-09-10", net_amount: "-50", status: "canceled" },
      { id: "b", activity_type: "ACATC", date: "2026-09-11", net_amount: "250", status: "executed" }
    ];
    const flows = flowsFromAlpacaActivities(rows);
    expect(flows.has("2026-09-10")).toBe(false);
    expect(flows.get("2026-09-11")).toBeCloseTo(250, 2);
    const summary = summarizeNonTradeActivities(rows);
    expect(summary.capitalIn).toBeCloseTo(250, 2);
    expect(summary.capitalOut).toBeCloseTo(0, 2);
    expect(summary.byType.find((t) => t.activityType === "CSW")?.canceledCount).toBe(1);
  });

  it("surfaces an unrecognized non-trade type instead of silently applying or dropping it", () => {
    const rows: AlpacaAccountActivity[] = [
      ...rothLedger,
      { id: "z", activity_type: "SWP", date: "2026-09-12", net_amount: "-3.10", description: "sweep", status: "executed" }
    ];
    const summary = summarizeNonTradeActivities(rows);
    expect(summary.unclassified.map((u) => u.activityType)).toEqual(["SWP"]);
    expect(summary.unclassified[0].netAmount).toBeCloseTo(-3.1, 2);
    // Not applied as a flow.
    expect(flowsFromAlpacaActivities(rows).has("2026-09-12")).toBe(false);
    expect(summary.capitalIn).toBeCloseTo(101.62, 2);
    expect(summary.capitalOut).toBeCloseTo(-69.65, 2);
    expect(summary.netCountedFlows).toBeCloseTo(101.62 - 69.65 + 0.12 - 0.01, 2);
  });
});
