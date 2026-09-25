import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

// Owner ruling 2026-09-24 (board 687a5fb4): `deRiskExitsOnAdversaryUnavailable` flipped from
// default OFF to default ON — src/lib/defaults.ts's DEFAULT_POLICY.tuning now sets it `true`.
// mergePolicy (src/lib/db-profiles.ts) deep-merges `tuning`, so an ALREADY-STORED account policy
// that never explicitly set this key must inherit the new default on its next read, exactly like
// the 2026-07-28 guard-enablement precedent (test/guard-enablement.test.ts). An account that
// explicitly persisted `false` (the old, pre-2026-09-24 behavior) must keep it.
//
// See test/redteam-failure-routing.test.ts for coverage of the pure `routeOnAdversaryUnavailable`
// helper's own true/false branches — this file covers the MERGE/DEFAULT layer that feeds it.
//
// Generous per-test timeout: this suite's first module-graph import (db-profiles.ts -> db.ts and
// its whole dependency tree) can take well over vitest's 60s default under heavy shared-box load,
// even though every assertion here is a synchronous, in-memory call once loaded.

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-derisk-exits-default-${randomUUID()}.db`)}`;
});

describe("deRiskExitsOnAdversaryUnavailable — default + merge inheritance", () => {
  it(
    "DEFAULT_POLICY.tuning.deRiskExitsOnAdversaryUnavailable is true",
    async () => {
      const { DEFAULT_POLICY } = await import("../src/lib/defaults");
      expect(DEFAULT_POLICY.tuning?.deRiskExitsOnAdversaryUnavailable).toBe(true);
    },
    120_000
  );

  it(
    "a brand-new policy (mergePolicy({})) inherits the new default of true",
    async () => {
      const { mergePolicy } = await import("../src/lib/db-profiles");
      const merged = mergePolicy({});
      expect(merged.tuning?.deRiskExitsOnAdversaryUnavailable).toBe(true);
    },
    120_000
  );

  it(
    "an account whose STORED policy has a tuning object but never set this key still inherits true",
    async () => {
      const { mergePolicy } = await import("../src/lib/db-profiles");
      // Simulates a policy persisted before 2026-09-24 (has other explicit tuning keys, but this
      // one was never written) — the exact "stored policy that lacks the key" scenario the task
      // called out.
      const merged = mergePolicy({ tuning: { volTargeting: false } });
      expect(merged.tuning?.deRiskExitsOnAdversaryUnavailable).toBe(true);
      expect(merged.tuning?.volTargeting).toBe(false); // untouched explicit key still wins
    },
    120_000
  );

  it(
    "an account that explicitly opted OUT (false) keeps false through the merge — per-account override preserved",
    async () => {
      const { mergePolicy } = await import("../src/lib/db-profiles");
      const merged = mergePolicy({ tuning: { deRiskExitsOnAdversaryUnavailable: false } });
      expect(merged.tuning?.deRiskExitsOnAdversaryUnavailable).toBe(false);
    },
    120_000
  );

  it(
    "an account that explicitly opted IN (true, matching the new default) round-trips true",
    async () => {
      const { mergePolicy } = await import("../src/lib/db-profiles");
      const merged = mergePolicy({ tuning: { deRiskExitsOnAdversaryUnavailable: true } });
      expect(merged.tuning?.deRiskExitsOnAdversaryUnavailable).toBe(true);
    },
    120_000
  );

  it(
    "getPolicy for a never-configured user returns the new default (true) via the same merge path",
    async () => {
      const { getPolicy } = await import("../src/lib/db");
      const policy = getPolicy(`derisk-default-user-${randomUUID()}`);
      expect(policy.tuning?.deRiskExitsOnAdversaryUnavailable).toBe(true);
    },
    120_000
  );

  it(
    "setPolicy with an explicit false persists and reads back false (real DB round-trip, not just the pure merge function)",
    async () => {
      const { getPolicy, setPolicy } = await import("../src/lib/db");
      const { DEFAULT_POLICY } = await import("../src/lib/defaults");
      const userId = `derisk-optout-user-${randomUUID()}`;
      setPolicy(
        {
          ...DEFAULT_POLICY,
          accountNumber: "DERISK-OPTOUT",
          tuning: { ...DEFAULT_POLICY.tuning, deRiskExitsOnAdversaryUnavailable: false }
        },
        userId
      );
      const reread = getPolicy(userId);
      expect(reread.tuning?.deRiskExitsOnAdversaryUnavailable).toBe(false);
    },
    120_000
  );
});
