/**
 * POST /api/strategy/enable — the console's Start button.  Pins its arming checks (messages,
 * statuses, and the selected-account scope) now that they live in src/lib/autonomy-arming.ts and
 * are shared with the ops account-control route.  A drift in either caller shows up here.
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { TradingPolicy } from "../src/lib/types";

beforeAll(async () => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-strategy-enable-route-${randomUUID()}.db`)}`;
  // Warm the import graph so the first test's time budget is not spent on a cold module load.
  await import("../app/api/strategy/enable/route");
  await import("../src/lib/db");
}, 300_000);

const broker = vi.hoisted(() => ({
  accounts: new Map<string, unknown[]>(),
  readThrows: new Set<string>(),
  reads: [] as string[]
}));

vi.mock("../src/lib/broker", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/broker")>();
  return {
    ...actual,
    getBrokerGateway: (policy: TradingPolicy) => {
      const accountNumber = policy.accountNumber ?? "";
      return {
        getAccounts: async () => {
          broker.reads.push(accountNumber);
          if (broker.readThrows.has(accountNumber)) throw new Error("socket hang up");
          return broker.accounts.get(accountNumber) ?? [{ accountNumber, label: "acct", agenticAllowed: true }];
        }
      };
    }
  };
});

async function seed(opts: { withAccount?: boolean; universe?: boolean } = {}) {
  const { upsertConnectedAccount, setPolicy, getPolicy } = await import("../src/lib/db");
  const { DEFAULT_POLICY } = await import("../src/lib/defaults");
  const { userIdForEmail } = await import("../src/lib/auth/identity");
  const email = `enable-${randomUUID()}@example.com`;
  const userId = userIdForEmail(email);
  const accountNumber = `ACC${randomUUID().slice(0, 8)}`;
  const otherId = randomUUID();
  const otherAccountNumber = `OTH${randomUUID().slice(0, 8)}`;
  // A second, NON-selected account: the console Start must never read or arm it.
  upsertConnectedAccount({ id: otherId, userId, broker: "tradier", environment: "paper", accountNumber: otherAccountNumber, label: "Other", isActive: false });
  let accountId: string | undefined;
  if (opts.withAccount !== false) {
    accountId = randomUUID();
    upsertConnectedAccount({ id: accountId, userId, broker: "alpaca", environment: "paper", accountNumber, label: "Selected", isActive: true });
  }
  const universe = opts.universe === false ? { includedIndices: [], additionalSymbols: [] } : {};
  if (accountId) setPolicy({ ...getPolicy(userId, accountId), ...universe, systemState: "halted" }, userId, accountId);
  else setPolicy({ ...DEFAULT_POLICY, ...universe, systemState: "halted" }, userId);
  return { email, userId, accountId, accountNumber, otherId, otherAccountNumber };
}

async function enable(email: string) {
  const { POST } = await import("../app/api/strategy/enable/route");
  const res = await POST(
    new Request("http://localhost/api/strategy/enable", { method: "POST", headers: { "x-authenticated-user-email": email } })
  );
  return { status: res.status, text: await res.text() };
}

beforeEach(() => {
  broker.accounts.clear();
  broker.readThrows.clear();
  broker.reads.length = 0;
});

describe("POST /api/strategy/enable (console Start)", () => {
  it("refuses with no selected account", async () => {
    const seeded = await seed({ withAccount: false });
    // Only the non-selected account exists; getPolicy(userId) has no selected account number.
    const res = await enable(seeded.email);
    expect(res.status).toBe(400);
    expect(res.text).toBe("Select an account before enabling autonomy.");
    expect(broker.reads).toEqual([]);
  });

  it("refuses an empty universe", async () => {
    const seeded = await seed({ universe: false });
    const res = await enable(seeded.email);
    expect(res.status).toBe(400);
    expect(res.text).toBe("Select at least one base index or additional watchlist symbol before enabling autonomy.");
  });

  it("refuses an unreachable broker, a missing account, and a non-agentic account", async () => {
    const seeded = await seed();
    broker.readThrows.add(seeded.accountNumber);
    expect(await enable(seeded.email)).toEqual({ status: 400, text: "Selected broker account is not reachable: socket hang up" });
    broker.readThrows.clear();
    broker.accounts.set(seeded.accountNumber, [{ accountNumber: "ELSEWHERE", label: "x", agenticAllowed: true }]);
    expect(await enable(seeded.email)).toEqual({ status: 400, text: "Selected account is not available." });
    broker.accounts.set(seeded.accountNumber, [{ accountNumber: seeded.accountNumber, label: "x", agenticAllowed: false }]);
    expect(await enable(seeded.email)).toEqual({ status: 400, text: "Selected account is not agentic_allowed." });
    const { getPolicy } = await import("../src/lib/db");
    expect(getPolicy(seeded.userId).systemState).toBe("halted");
  });

  it("arms the SELECTED account only and reads only its broker", async () => {
    const seeded = await seed();
    const res = await enable(seeded.email);
    expect(res.status).toBe(200);
    expect((JSON.parse(res.text) as TradingPolicy).systemState).toBe("active");
    const { getPolicy } = await import("../src/lib/db");
    expect(getPolicy(seeded.userId, seeded.accountId).systemState).toBe("active");
    expect(getPolicy(seeded.userId, seeded.otherId).systemState).toBe("halted");
    expect(broker.reads).toEqual([seeded.accountNumber]);
  });
});
