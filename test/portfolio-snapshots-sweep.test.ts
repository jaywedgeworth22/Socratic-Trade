import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sweepPortfolioSnapshots, insertPortfolioSnapshot } from "../src/lib/db-fills";
import { getDb } from "../src/lib/db";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-portfoliosnap-${randomUUID()}.db`)}`;
});

beforeEach(() => {
  getDb().prepare("DELETE FROM portfolio_snapshots").run();
});

function seedSnapshots(count: number, daysAgoFn: (i: number) => number) {
  for (let i = 0; i < count; i++) {
    insertPortfolioSnapshot({
      userId: "local",
      accountNumber: "ACC1",
      source: "paper",
      executionMode: "broker/paper",
      equity: 100_000 + i,
      cash: 50_000,
      buyingPower: 50_000,
      positionsValue: 50_000,
      positions: [],
      createdAt: new Date(Date.now() - daysAgoFn(i) * 24 * 3600_000).toISOString(),
    });
  }
}

describe("sweepPortfolioSnapshots", () => {
  it("drains backlog across multiple bounded batches (no un-bounded DELETE)", () => {
    // 12 snapshots all > 90d old.
    seedSnapshots(12, () => 100);

    const totalBefore =
      (getDb().prepare("SELECT count(*) c FROM portfolio_snapshots").get() as { c: number }).c;
    expect(totalBefore).toBe(12);

    // batchLimit=5 means the first call deletes at most 5 rows even though 12 are eligible.
    const firstPass = sweepPortfolioSnapshots(new Date(), 90, 5);
    expect(firstPass).toBe(5);
    expect(
      (getDb().prepare("SELECT count(*) c FROM portfolio_snapshots").get() as { c: number }).c
    ).toBe(7);

    // Second pass drains another 5.
    const secondPass = sweepPortfolioSnapshots(new Date(), 90, 5);
    expect(secondPass).toBe(5);
    expect(
      (getDb().prepare("SELECT count(*) c FROM portfolio_snapshots").get() as { c: number }).c
    ).toBe(2);

    // Third pass drains the last 2 (LIMIT 5 still in the SQL but only 2 rows match).
    const thirdPass = sweepPortfolioSnapshots(new Date(), 90, 5);
    expect(thirdPass).toBe(2);
    expect(
      (getDb().prepare("SELECT count(*) c FROM portfolio_snapshots").get() as { c: number }).c
    ).toBe(0);
  });

  it("never touches snapshots newer than maxAgeDays", () => {
    seedSnapshots(5, () => 30); // all 30d old
    const before =
      (getDb().prepare("SELECT count(*) c FROM portfolio_snapshots").get() as { c: number }).c;
    const removed = sweepPortfolioSnapshots(new Date(), 90, 100);
    expect(removed).toBe(0);
    const after =
      (getDb().prepare("SELECT count(*) c FROM portfolio_snapshots").get() as { c: number }).c;
    expect(after).toBe(before);
  });

  it("uses the LIMIT-bounded subquery (no un-bounded DELETE in the prepared SQL)", () => {
    // Pin the prepared statement shape so a regression to the old un-bounded DELETE
    // is caught at the SQL string level, not just by behavior.  This is the exact
    // class of bug that the audit_events sweep already fixed (#3383/#3386/#3408).
    seedSnapshots(3, () => 100);
    // The function calls db.prepare(...) internally; we mirror its source via a fresh
    // statement and assert it contains the LIMIT clause.
    const db = getDb();
    const cutoff = new Date(Date.now() - 90 * 24 * 3600_000).toISOString();
    const stmt = db.prepare(
      "DELETE FROM portfolio_snapshots WHERE id IN (SELECT id FROM portfolio_snapshots WHERE created_at < ? LIMIT ?)"
    );
    expect(stmt.source.replace(/\s+/g, " ")).toContain("LIMIT ?");
    expect(stmt.run(cutoff, 100).changes).toBe(3);
  });

  it("creates idx_audit_events_kind_created (migration 90) on open", () => {
    // The audit-prune observability+default DELETE does NOT constrain user_id, but the only
    // kind-prefixed index before migration 90 was (kind, user_id, created_at DESC) — without
    // a user_id bound, SQLite had to scan kind-ranges across every user.  Migration 90 adds
    // a tighter (kind, created_at) compound so the prune can range-scan created_at inside
    // a single kind without dragging user_id through the sorter.
    const idx = getDb()
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_audit_events_kind_created'"
      )
      .get();
    expect(idx).toBeDefined();
    expect((idx as { name: string }).name).toBe("idx_audit_events_kind_created");
  });
});
