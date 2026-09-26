import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  accountEquity,
  adjustHighWaterMarkForExternalFlow,
  applyExternalFlowsToHighWaterMark,
  evaluateDrawdownBreaker,
  impliedDrawdownPct,
  recomputeHighWaterMarkFromTransferFlows
} from "../src/lib/risk-breaker";
import type { RiskRules } from "../src/lib/types";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-risk-breaker-${randomUUID()}.db`)}`;
});

describe("evaluateDrawdownBreaker (pure)", () => {
  it("no breach when neither limit is configured", () => {
    expect(evaluateDrawdownBreaker({ equity: 5000, highWaterMark: 10000, startOfDayEquity: 9000 })).toEqual({ breached: false });
  });

  it("breaches on trailing drawdown at/over the limit, not below it", () => {
    // 10000 HWM → 8500 equity = 15% drawdown.
    expect(evaluateDrawdownBreaker({ equity: 8500, highWaterMark: 10000, startOfDayEquity: 10000, maxDrawdownPct: 15 }).breached).toBe(true);
    expect(evaluateDrawdownBreaker({ equity: 8501, highWaterMark: 10000, startOfDayEquity: 10000, maxDrawdownPct: 15 }).breached).toBe(false); // 14.99% < 15%
    const r = evaluateDrawdownBreaker({ equity: 8000, highWaterMark: 10000, startOfDayEquity: 10000, maxDrawdownPct: 15 });
    expect(r.breached).toBe(true);
    expect(r.reason).toContain("drawdown");
  });

  it("ignores drawdown when maxDrawdownPct<=0 or highWaterMark<=0", () => {
    expect(evaluateDrawdownBreaker({ equity: 1, highWaterMark: 10000, startOfDayEquity: 10000, maxDrawdownPct: 0 }).breached).toBe(false);
    expect(evaluateDrawdownBreaker({ equity: 1, highWaterMark: 0, startOfDayEquity: 10000, maxDrawdownPct: 15 }).breached).toBe(false);
  });

  it("breaches on daily loss at/over the notional limit, not below it", () => {
    // start-of-day 10000 → equity 9000 = $1000 loss.
    expect(evaluateDrawdownBreaker({ equity: 9000, highWaterMark: 10000, startOfDayEquity: 10000, maxDailyLossNotional: 1000 }).breached).toBe(true);
    expect(evaluateDrawdownBreaker({ equity: 9001, highWaterMark: 10000, startOfDayEquity: 10000, maxDailyLossNotional: 1000 }).breached).toBe(false);
    expect(evaluateDrawdownBreaker({ equity: 9000, highWaterMark: 10000, startOfDayEquity: 10000, maxDailyLossNotional: 1000 }).reason).toContain("daily-loss");
  });

  it("drawdown takes PRIORITY when both are breached", () => {
    const r = evaluateDrawdownBreaker({ equity: 7000, highWaterMark: 10000, startOfDayEquity: 10000, maxDrawdownPct: 15, maxDailyLossNotional: 1000 });
    expect(r.breached).toBe(true);
    expect(r.reason).toContain("drawdown"); // not the daily-loss reason
  });

  it("a profitable day with no peak drawdown never breaches", () => {
    expect(evaluateDrawdownBreaker({ equity: 11000, highWaterMark: 11000, startOfDayEquity: 10000, maxDrawdownPct: 15, maxDailyLossNotional: 1000 }).breached).toBe(false);
  });
});

describe("adjustHighWaterMarkForExternalFlow (pure)", () => {
  it("raises HWM by a deposit (new capital is not a trading peak, but it must not erase a hole)", () => {
    expect(adjustHighWaterMarkForExternalFlow({ highWaterMark: 100, equityBeforeFlow: 80, flow: 20 })).toBe(120);
    expect(adjustHighWaterMarkForExternalFlow({ highWaterMark: 100, equityBeforeFlow: 100, flow: 50 })).toBe(150);
  });

  it("lowers HWM proportionally on withdrawal so a cash-out at the peak is 0% drawdown", () => {
    // Peak $101.62, withdraw down to $28 — the Roth false-drawdown case.
    const hwm = adjustHighWaterMarkForExternalFlow({
      highWaterMark: 101.62,
      equityBeforeFlow: 101.62,
      flow: -73.62
    });
    expect(hwm).toBeCloseTo(28, 2);
    expect(impliedDrawdownPct(28, hwm)).toBeCloseTo(0, 2);
  });

  it("preserves drawdown percentage when withdrawing from a hole", () => {
    // 20% DD ($100 HWM, $80 equity), withdraw $40 → remaining $40, HWM scales to $50 → still 20%.
    const hwm = adjustHighWaterMarkForExternalFlow({
      highWaterMark: 100,
      equityBeforeFlow: 80,
      flow: -40
    });
    expect(hwm).toBeCloseTo(50, 2);
    expect(impliedDrawdownPct(40, hwm)).toBeCloseTo(20, 2);
  });

  it("is a no-op when flow is 0 or not finite", () => {
    expect(adjustHighWaterMarkForExternalFlow({ highWaterMark: 100, equityBeforeFlow: 90, flow: 0 })).toBe(100);
    expect(adjustHighWaterMarkForExternalFlow({ highWaterMark: 100, equityBeforeFlow: 90, flow: Number.NaN })).toBe(100);
  });
});

describe("applyExternalFlowsToHighWaterMark / recomputeHighWaterMarkFromTransferFlows (pure)", () => {
  it("applies deposit then withdrawal in order against a synthetic book", () => {
    const hwm = applyExternalFlowsToHighWaterMark({
      highWaterMark: 100,
      equityBeforeFlows: 100,
      flows: [50, -30]
    });
    // $100 + $50 deposit → HWM $150; withdraw $30 → HWM $150 * (120/150) = $120.
    expect(hwm).toBeCloseTo(120, 2);
  });

  it("rebuilds HWM from a transfer ledger + current equity (Roth-shaped cash-out)", () => {
    const result = recomputeHighWaterMarkFromTransferFlows({
      flows: [101.62, -73.62],
      currentEquity: 28
    });
    expect(result.netTransfers).toBeCloseTo(28, 2);
    expect(result.highWaterMark).toBeCloseTo(28, 2);
    expect(result.reconstructedEquity).toBeCloseTo(28, 2);
    expect(impliedDrawdownPct(28, result.highWaterMark)).toBeCloseTo(0, 2);
  });

  it("ratchets to current equity when leftover market P&L is a new peak", () => {
    const result = recomputeHighWaterMarkFromTransferFlows({
      flows: [100],
      currentEquity: 130
    });
    expect(result.highWaterMark).toBeCloseTo(130, 2);
    expect(result.netTransfers).toBeCloseTo(100, 2);
  });

  it("keeps a trading hole after deposits when current equity is below flow-adjusted HWM", () => {
    const result = recomputeHighWaterMarkFromTransferFlows({
      flows: [100],
      currentEquity: 80
    });
    expect(result.highWaterMark).toBeCloseTo(100, 2);
    expect(impliedDrawdownPct(80, result.highWaterMark)).toBeCloseTo(20, 2);
  });

  it("treats an empty ledger as a rebaseline to current equity", () => {
    const result = recomputeHighWaterMarkFromTransferFlows({ flows: [], currentEquity: 28.35 });
    expect(result.highWaterMark).toBeCloseTo(28.35, 2);
    expect(result.netTransfers).toBe(0);
  });
});

describe("accountEquity", () => {
  it("prefers composed cash + equity + option market value", () => {
    expect(accountEquity({ cash: 5000, equityMarketValue: 3000, optionMarketValue: 500, totalMarketValue: 1 })).toBe(8500);
  });
  it("falls back to totalMarketValue when the composed value is non-positive", () => {
    expect(accountEquity({ cash: 0, equityMarketValue: 0, optionMarketValue: 0, totalMarketValue: 4200 })).toBe(4200);
  });
});

describe("recordAndEvaluateDrawdownBreaker (stateful HWM + start-of-day persistence)", () => {
  const rules: RiskRules = { maxDrawdownPct: 20, maxDailyLossNotional: 1500 };
  const base = { accountNumber: "ACCT-RB", source: "paper" as const, riskRules: rules, userId: "local" };

  it("seeds HWM + start-of-day on first observation and does not breach", async () => {
    const { recordAndEvaluateDrawdownBreaker } = await import("../src/lib/risk-breaker");
    const r = recordAndEvaluateDrawdownBreaker({ ...base, equity: 10000, now: new Date("2026-06-26T14:00:00Z") });
    expect(r.breached).toBe(false);
    expect(r.highWaterMark).toBe(10000);
    expect(r.startOfDayEquity).toBe(10000);
  });

  it("ratchets the HWM UP and never down; drawdown is measured from the peak", async () => {
    const { recordAndEvaluateDrawdownBreaker } = await import("../src/lib/risk-breaker");
    recordAndEvaluateDrawdownBreaker({ ...base, equity: 12000, now: new Date("2026-06-26T15:00:00Z") }); // new peak
    const drop = recordAndEvaluateDrawdownBreaker({ ...base, equity: 11000, now: new Date("2026-06-26T16:00:00Z") }); // dip
    expect(drop.highWaterMark).toBe(12000); // HWM stayed at peak, not lowered to 11000
    // 12000 → 9000 = 25% > 20% → breach measured from the 12000 peak, not from a lower later value.
    const breach = recordAndEvaluateDrawdownBreaker({ ...base, equity: 9000, now: new Date("2026-06-26T17:00:00Z") });
    expect(breach.highWaterMark).toBe(12000);
    expect(breach.breached).toBe(true);
    expect(breach.reason).toContain("drawdown");
  });

  it("keeps the SAME start-of-day equity across intraday calls, then resets on a new day", async () => {
    const { recordAndEvaluateDrawdownBreaker } = await import("../src/lib/risk-breaker");
    const acct = { ...base, accountNumber: "ACCT-SOD" };
    const open = recordAndEvaluateDrawdownBreaker({ ...acct, equity: 20000, now: new Date("2026-06-26T14:30:00Z") });
    expect(open.startOfDayEquity).toBe(20000);
    // Later same day, lower equity → SOD unchanged (daily loss accrues from the day's open).
    const later = recordAndEvaluateDrawdownBreaker({ ...acct, equity: 19000, now: new Date("2026-06-26T19:00:00Z") });
    expect(later.startOfDayEquity).toBe(20000);
    // 20000 → 18400 = $1600 loss > $1500 daily limit → breach (drawdown not hit: 8% < 20%).
    const breach = recordAndEvaluateDrawdownBreaker({ ...acct, equity: 18400, now: new Date("2026-06-26T20:00:00Z") });
    expect(breach.breached).toBe(true);
    expect(breach.reason).toContain("daily-loss");
    // New day → SOD re-seeds to that day's first observed equity.
    const nextDay = recordAndEvaluateDrawdownBreaker({ ...acct, equity: 18400, now: new Date("2026-06-27T14:30:00Z") });
    expect(nextDay.startOfDayEquity).toBe(18400);
  });

  it("is scoped per (account, source) — independent HWM/SOD", async () => {
    const { recordAndEvaluateDrawdownBreaker } = await import("../src/lib/risk-breaker");
    recordAndEvaluateDrawdownBreaker({ ...base, accountNumber: "ACCT-A", equity: 50000, now: new Date("2026-06-26T14:00:00Z") });
    const b = recordAndEvaluateDrawdownBreaker({ ...base, accountNumber: "ACCT-B", equity: 1000, now: new Date("2026-06-26T14:00:00Z") });
    expect(b.highWaterMark).toBe(1000); // ACCT-B is independent of ACCT-A's 50000 peak
    // Same account, different source is also independent.
    const live = recordAndEvaluateDrawdownBreaker({ ...base, accountNumber: "ACCT-A", source: "live", equity: 2000, now: new Date("2026-06-26T14:00:00Z") });
    expect(live.highWaterMark).toBe(2000);
  });

  it("is a no-op (never breaches) when the account configured no circuit-breaker limits", async () => {
    const { recordAndEvaluateDrawdownBreaker } = await import("../src/lib/risk-breaker");
    const r = recordAndEvaluateDrawdownBreaker({ accountNumber: "ACCT-NOLIMIT", source: "paper", equity: 100, riskRules: {}, userId: "local", now: new Date("2026-06-26T14:00:00Z") });
    expect(r.breached).toBe(false); // huge drop from no prior HWM, but no limits configured
  });

  it("does not replay historical flows on the first observation (ops recompute is the heal)", async () => {
    const { recordAndEvaluateDrawdownBreaker } = await import("../src/lib/risk-breaker");
    const acct = { ...base, accountNumber: "ACCT-FIRST-OBS" };
    const first = recordAndEvaluateDrawdownBreaker({
      ...acct,
      equity: 28,
      now: new Date("2026-09-17T14:00:00Z"),
      externalFlows: [{ amount: 101.62, day: "2026-08-01" }, { amount: -73.62, day: "2026-09-01" }]
    });
    expect(first.highWaterMark).toBe(28);
    expect(first.breached).toBe(false);
  });

  it("lowers HWM on a later withdrawal so a cash-out is not a trailing-drawdown breach", async () => {
    const { recordAndEvaluateDrawdownBreaker } = await import("../src/lib/risk-breaker");
    const acct = { ...base, accountNumber: "ACCT-CASH-OUT", riskRules: { maxDrawdownPct: 15 } };
    const seed = recordAndEvaluateDrawdownBreaker({
      ...acct,
      equity: 101.62,
      now: new Date("2026-09-16T14:00:00Z")
    });
    expect(seed.highWaterMark).toBeCloseTo(101.62, 2);
    const afterWithdraw = recordAndEvaluateDrawdownBreaker({
      ...acct,
      equity: 28,
      now: new Date("2026-09-17T14:00:00Z"),
      externalFlows: [{ amount: -73.62, day: "2026-09-17" }]
    });
    expect(afterWithdraw.highWaterMark).toBeCloseTo(28, 2);
    expect(afterWithdraw.breached).toBe(false);
  });

  it("raises HWM by a later deposit and does not treat the deposit as recovered drawdown", async () => {
    const { recordAndEvaluateDrawdownBreaker } = await import("../src/lib/risk-breaker");
    const acct = { ...base, accountNumber: "ACCT-DEPOSIT-HOLE", riskRules: { maxDrawdownPct: 15 } };
    recordAndEvaluateDrawdownBreaker({ ...acct, equity: 100, now: new Date("2026-09-16T14:00:00Z") });
    recordAndEvaluateDrawdownBreaker({ ...acct, equity: 80, now: new Date("2026-09-16T18:00:00Z") });
    const afterDeposit = recordAndEvaluateDrawdownBreaker({
      ...acct,
      equity: 100,
      now: new Date("2026-09-17T14:00:00Z"),
      externalFlows: [{ amount: 20, day: "2026-09-17" }]
    });
    expect(afterDeposit.highWaterMark).toBeCloseTo(120, 2);
    expect(afterDeposit.breached).toBe(true);
  });
});

// 2026-09-24 (board 687a5fb4): the Roth IRA was halted for two weeks on "Trailing drawdown 72.10%
// from HWM $101.62" after the owner WITHDREW funds.  The breaker must not halt on a drop the
// ledger explains, must say so when it cannot tell, and must still enforce a real loss.
describe("recordAndEvaluateDrawdownBreaker — withdrawals, lagged ledger rows, unexplained drops", () => {
  const rules: RiskRules = { maxDrawdownPct: 15 };
  const base = { source: "live" as const, riskRules: rules, userId: "local" };

  it("does not breach when a same-run IRA distribution + withholding explains the drop", async () => {
    const { recordAndEvaluateDrawdownBreaker } = await import("../src/lib/risk-breaker");
    const acct = { ...base, accountNumber: "ROTH-EXPLAINED" };
    recordAndEvaluateDrawdownBreaker({ ...acct, equity: 101.62, now: new Date("2026-09-08T15:00:00Z") });
    recordAndEvaluateDrawdownBreaker({ ...acct, equity: 98, now: new Date("2026-09-08T19:00:00Z") });
    const r = recordAndEvaluateDrawdownBreaker({
      ...acct,
      equity: 28.35,
      now: new Date("2026-09-09T15:00:00Z"),
      externalFlows: [
        { amount: -62.69, day: "2026-09-09" },
        { amount: -6.96, day: "2026-09-09" }
      ]
    });
    expect(r.breached).toBe(false);
    expect(r.appliedExternalFlowTotal).toBeCloseTo(-69.65, 2);
    expect(r.unexplainedEquityChange).toBeUndefined();
    expect(r.deferHardAction).toBe(false);
    // 101.62 × 28.35/98 ≈ 29.40 — the 3.5% trading drift survives, the cash-out does not count.
    expect(r.highWaterMark).toBeCloseTo(29.4, 1);
  });

  it("holds a hard action for one run when the balance drops before the withdrawal row posts, then neutralizes it", async () => {
    const { recordAndEvaluateDrawdownBreaker } = await import("../src/lib/risk-breaker");
    const acct = { ...base, accountNumber: "ROTH-LAGGED" };
    recordAndEvaluateDrawdownBreaker({ ...acct, equity: 101.62, now: new Date("2026-09-09T14:00:00Z") });
    const dropRun = recordAndEvaluateDrawdownBreaker({
      ...acct,
      equity: 28.35,
      now: new Date("2026-09-09T16:00:00Z"),
      externalFlows: []
    });
    expect(dropRun.breached).toBe(true);
    expect(dropRun.deferHardAction).toBe(true);
    expect(dropRun.unexplainedEquityChange?.dropPct).toBeCloseTo(72.1, 1);
    expect(dropRun.unexplainedEquityChange?.flowsUnavailable).toBe(false);
    expect(dropRun.reason).toContain("held as advisory for one run");

    const posted = recordAndEvaluateDrawdownBreaker({
      ...acct,
      equity: 28.35,
      now: new Date("2026-09-09T18:00:00Z"),
      externalFlows: [{ amount: -73.27, day: "2026-09-09" }]
    });
    expect(posted.breached).toBe(false);
    expect(posted.highWaterMark).toBeCloseTo(28.35, 2);
    expect(posted.deferHardAction).toBe(false);
  });

  it("enforces a real loss on the next run (never defers the same drop twice)", async () => {
    const { recordAndEvaluateDrawdownBreaker } = await import("../src/lib/risk-breaker");
    const acct = { ...base, accountNumber: "REAL-LOSS" };
    recordAndEvaluateDrawdownBreaker({ ...acct, equity: 1000, now: new Date("2026-09-09T14:00:00Z") });
    const first = recordAndEvaluateDrawdownBreaker({ ...acct, equity: 700, now: new Date("2026-09-09T15:00:00Z"), externalFlows: [] });
    expect(first.breached).toBe(true);
    expect(first.deferHardAction).toBe(true);
    const second = recordAndEvaluateDrawdownBreaker({ ...acct, equity: 700, now: new Date("2026-09-09T16:00:00Z"), externalFlows: [] });
    expect(second.breached).toBe(true);
    expect(second.deferHardAction).toBe(false);
    expect(second.highWaterMark).toBeCloseTo(1000, 2);
  });

  it("does not launder a real loss into a withdrawal when a smaller cash-out posts afterwards", async () => {
    const { recordAndEvaluateDrawdownBreaker } = await import("../src/lib/risk-breaker");
    const acct = { ...base, accountNumber: "LOSS-THEN-WITHDRAW" };
    recordAndEvaluateDrawdownBreaker({ ...acct, equity: 100, now: new Date("2026-09-09T14:00:00Z") });
    recordAndEvaluateDrawdownBreaker({ ...acct, equity: 75, now: new Date("2026-09-09T15:00:00Z"), externalFlows: [] });
    const after = recordAndEvaluateDrawdownBreaker({
      ...acct,
      equity: 35,
      now: new Date("2026-09-09T16:00:00Z"),
      externalFlows: [{ amount: -40, day: "2026-09-09" }]
    });
    // 25% loss, then a neutral cash-out: HWM 100 × 35/75 ≈ 46.67 → still a 25% drawdown.
    expect(after.highWaterMark).toBeCloseTo(46.67, 1);
    expect(after.breached).toBe(true);
    expect(after.deferHardAction).toBe(false);
  });

  it("reports an unreadable ledger honestly and defers only once while it stays unreadable", async () => {
    const { recordAndEvaluateDrawdownBreaker } = await import("../src/lib/risk-breaker");
    const acct = { ...base, accountNumber: "LEDGER-DOWN" };
    recordAndEvaluateDrawdownBreaker({ ...acct, equity: 100, now: new Date("2026-09-09T14:00:00Z") });
    const down = { externalFlows: [], appliedActivityIds: [], advanceObservation: false, flowsUnavailable: true };
    const r1 = recordAndEvaluateDrawdownBreaker({ ...acct, ...down, equity: 50, now: new Date("2026-09-09T15:00:00Z") });
    expect(r1.flowsUnavailable).toBe(true);
    expect(r1.deferHardAction).toBe(true);
    expect(r1.unexplainedEquityChange?.flowsUnavailable).toBe(true);
    expect(r1.reason).toContain("ledger unreadable this run");
    const r2 = recordAndEvaluateDrawdownBreaker({ ...acct, ...down, equity: 50, now: new Date("2026-09-09T16:00:00Z") });
    expect(r2.deferHardAction).toBe(false);
    expect(r2.breached).toBe(true);
    expect(r2.reason).toContain("could not be read this run");
    const r3 = recordAndEvaluateDrawdownBreaker({ ...acct, ...down, equity: 50, now: new Date("2026-09-09T17:00:00Z") });
    expect(r3.deferHardAction).toBe(false);
    expect(r3.breached).toBe(true);
  });

  it("keeps the plain ratchet for accounts with no cash-flow ledger (non-Alpaca brokers)", async () => {
    const { recordAndEvaluateDrawdownBreaker } = await import("../src/lib/risk-breaker");
    const acct = { ...base, accountNumber: "NO-LEDGER" };
    recordAndEvaluateDrawdownBreaker({ ...acct, equity: 250_000, now: new Date("2026-09-09T14:00:00Z") });
    const r = recordAndEvaluateDrawdownBreaker({ ...acct, equity: 100_000, now: new Date("2026-09-09T15:00:00Z") });
    expect(r.breached).toBe(true);
    expect(r.unexplainedEquityChange).toBeUndefined();
    expect(r.deferHardAction).toBe(false);
  });

  it("treats a small drop with no flows as ordinary (no unexplained flag)", async () => {
    const { recordAndEvaluateDrawdownBreaker } = await import("../src/lib/risk-breaker");
    const acct = { ...base, accountNumber: "SMALL-DIP" };
    recordAndEvaluateDrawdownBreaker({ ...acct, equity: 100, now: new Date("2026-09-09T14:00:00Z") });
    const r = recordAndEvaluateDrawdownBreaker({ ...acct, equity: 84, now: new Date("2026-09-09T15:00:00Z"), externalFlows: [] });
    expect(r.breached).toBe(true);
    expect(r.unexplainedEquityChange).toBeUndefined();
    expect(r.deferHardAction).toBe(false);
  });
});

describe("replayHighWaterMarkFromDailyHistory (ops recompute)", () => {
  const rothDaily = [
    { day: "2026-08-03", equity: 101.62 },
    { day: "2026-08-20", equity: 99.1 },
    { day: "2026-09-08", equity: 98 },
    { day: "2026-09-09", equity: 28.35 },
    { day: "2026-09-17", equity: 28.45 },
    { day: "2026-09-18", equity: 1.68 },
    { day: "2026-09-24", equity: 1.68 }
  ];
  const rothFlows = [
    { day: "2026-08-03", amount: 101.62 },
    { day: "2026-09-09", amount: -62.69 },
    { day: "2026-09-09", amount: -6.96 },
    { day: "2026-09-18", amount: -26.77 }
  ];

  it("rebuilds the Roth IRA HWM to its real trading drawdown, not the withdrawal", async () => {
    const { replayHighWaterMarkFromDailyHistory } = await import("../src/lib/risk-breaker");
    const r = replayHighWaterMarkFromDailyHistory({ flows: rothFlows, dailyEquity: rothDaily, currentEquity: 1.68 });
    expect(r.netTransfers).toBeCloseTo(101.62 - 62.69 - 6.96 - 26.77, 2);
    expect(r.highWaterMark).toBeCloseTo(1.74, 2);
    expect(impliedDrawdownPct(1.68, r.highWaterMark)).toBeLessThan(5);
    expect(r.unexplainedDrops).toEqual([]);
  });

  it("the flow-only replay it replaces leaves a phantom drawdown on a near-total cash-out", () => {
    const r = recomputeHighWaterMarkFromTransferFlows({ flows: rothFlows.map((f) => f.amount), currentEquity: 1.68 });
    expect(r.highWaterMark).toBeCloseTo(5.2, 1);
    expect(impliedDrawdownPct(1.68, r.highWaterMark)).toBeGreaterThan(60);
  });

  it("lists close-to-close falls with no ledger flow instead of silently absorbing them", async () => {
    const { replayHighWaterMarkFromDailyHistory } = await import("../src/lib/risk-breaker");
    const r = replayHighWaterMarkFromDailyHistory({ flows: [], dailyEquity: rothDaily, currentEquity: 1.68 });
    expect(r.unexplainedDrops.map((d) => d.day)).toEqual(["2026-09-09", "2026-09-18"]);
    expect(r.unexplainedDrops[0].dropPct).toBeCloseTo(71.07, 1);
    expect(r.highWaterMark).toBeCloseTo(101.62, 2);
  });
});
