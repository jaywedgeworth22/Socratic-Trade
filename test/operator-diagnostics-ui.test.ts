import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AUDIT_QUERY_PATH,
  BACKTEST_IC_DEFAULTS,
  BACKTEST_IC_PATH,
  LEARNING_LEDGER_PATH,
  TUNING_DRY_RUN_PATH,
  backtestIcUrl,
  describeOperatorFetchError,
  filterAuditEvents,
  formatAuditPayloadPreview,
  formatIc,
  formatSigned,
  formatWeight,
  invariantViolationText,
  learningLedgerUrl,
  weightCompareRows
} from "../app/console/lib/operator-diagnostics";

describe("operator diagnostic URL builders", () => {
  it("keeps the four existing route paths", () => {
    expect(TUNING_DRY_RUN_PATH).toBe("/api/admin/tuning-dry-run");
    expect(LEARNING_LEDGER_PATH).toBe("/api/admin/learning-ledger");
    expect(BACKTEST_IC_PATH).toBe("/api/admin/backtest-ic");
    expect(AUDIT_QUERY_PATH).toBe("/api/audit");
  });

  it("emits the backtest-ic query params the server already reads", () => {
    const url = new URL(backtestIcUrl(BACKTEST_IC_DEFAULTS), "https://socratictrade.com");
    expect(url.pathname).toBe("/api/admin/backtest-ic");
    expect(url.searchParams.get("horizonDays")).toBe("5");
    expect(url.searchParams.get("auditLimit")).toBe("500");
    expect(url.searchParams.get("oos")).toBe("true");
    expect(url.searchParams.get("trainFraction")).toBe("0.7");
    expect(url.searchParams.get("costRoundTripBps")).toBe("20");
    expect(url.searchParams.get("taxRate")).toBe("0.24");
    expect(url.searchParams.get("topK")).toBe("3");
  });

  it("can omit walk-forward OOS without inventing extra params", () => {
    const url = new URL(backtestIcUrl({ oos: false }), "https://socratictrade.com");
    expect(url.searchParams.get("oos")).toBe("false");
    expect([...url.searchParams.keys()].sort()).toEqual([
      "auditLimit",
      "costRoundTripBps",
      "horizonDays",
      "oos",
      "taxRate",
      "topK",
      "trainFraction"
    ]);
  });

  it("forwards learning-ledger list filters the server already honors", () => {
    expect(learningLedgerUrl()).toBe("/api/admin/learning-ledger");
    const url = new URL(learningLedgerUrl({ subsystem: "scoring_weights", limit: 50 }), "https://socratictrade.com");
    expect(url.searchParams.get("subsystem")).toBe("scoring_weights");
    expect(url.searchParams.get("limit")).toBe("50");
  });
});

describe("operator diagnostic display helpers", () => {
  it("filters audit events by kind locally", () => {
    const events = [
      { id: "1", createdAt: "2026-08-17T00:00:00Z", kind: "auto_weight_apply", payload: {} },
      { id: "2", createdAt: "2026-08-17T00:01:00Z", kind: "strategy_run", payload: {} }
    ];
    expect(filterAuditEvents(events, "weight").map((event) => event.id)).toEqual(["1"]);
    expect(filterAuditEvents(events, "  ").map((event) => event.id)).toEqual(["1", "2"]);
  });

  it("compares weight vectors without inventing missing factors", () => {
    const rows = weightCompareRows({ liquidity: 1.4, momentum: 1.2 }, { liquidity: 1.5 });
    const liquidity = rows.find((row) => row.key === "liquidity");
    const momentum = rows.find((row) => row.key === "momentum");
    expect(liquidity?.label).toBe("Liquidity");
    expect(liquidity?.before).toBe(1.4);
    expect(liquidity?.after).toBe(1.5);
    expect(liquidity?.delta).toBeCloseTo(0.1);
    expect(momentum?.after).toBeUndefined();
    expect(momentum?.delta).toBeUndefined();
    expect(formatWeight(1.4)).toBe("1.40");
    expect(formatSigned(0.1)).toBe("+0.10");
    expect(formatIc(0.1234)).toBe("0.123");
  });

  it("truncates audit payload previews and reads invariant text", () => {
    expect(formatAuditPayloadPreview({ a: 1 })).toBe("{\"a\":1}");
    expect(formatAuditPayloadPreview("x".repeat(200), 10)).toBe("xxxxxxxxxx…");
    expect(invariantViolationText("bare")).toBe("bare");
    expect(invariantViolationText({ message: "named" })).toBe("named");
  });

  it("describes rate-limit and in-flight failures without dropping the server reason", () => {
    expect(describeOperatorFetchError(429, { retryAfterSeconds: 12 })).toContain("12s");
    expect(describeOperatorFetchError(409)).toMatch(/already running/);
    expect(describeOperatorFetchError(404, { reason: "not_found" })).toBe("not_found");
    expect(describeOperatorFetchError(403)).toMatch(/Operator access required/);
  });
});

describe("operator diagnostic UI wiring", () => {
  const files = [
    ["app/console/lib/operator-diagnostics.ts", TUNING_DRY_RUN_PATH],
    ["app/console/lib/operator-diagnostics.ts", LEARNING_LEDGER_PATH],
    ["app/console/lib/operator-diagnostics.ts", BACKTEST_IC_PATH],
    ["app/console/lib/operator-diagnostics.ts", AUDIT_QUERY_PATH],
    ["app/console/strategy/tuning-dry-run.tsx", "fetchTuningDryRun"],
    ["app/console/lessons/learning-ledger.tsx", "fetchLearningLedger"],
    ["app/console/lessons/learning-ledger.tsx", "revertLearningLedgerEntry"],
    ["app/console/activity/audit-log.tsx", "fetchAuditEvents"],
    ["app/admin/backtest-ic/backtest-ic-client.tsx", "fetchBacktestIc"],
    ["app/console/strategy/page.tsx", "TuningDryRunPanel"],
    ["app/console/lessons/page.tsx", "LearningLedgerPanel"],
    ["app/console/activity/page.tsx", "AuditFeed"],
    ["app/console/activity/audit-feed.tsx", "AuditLogPanel"],
    ["app/admin/admin-shell.tsx", "/admin/backtest-ic"]
  ] as const;

  for (const [path, marker] of files) {
    it(`${path} references ${marker}`, () => {
      const source = readFileSync(join(process.cwd(), path), "utf8");
      expect(source).toContain(marker);
    });
  }
});
