import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// F04 rollup follow-up (2026-09-08, board c630ceed). PR #3187 (2026-09-07) cooldown-gated the
// "RAG ingest text budget reached" Sentry warning behind shouldEmitRagIngestBudgetSentry, but
// the only test that landed with it (rag-ingest-budget-sentry-cooldown.test.ts) covers just the
// fail-soft persistence-error edge case — nothing asserted the actual rollup behavior: that a
// second throttled batch inside the cooldown window is suppressed, that the one event which does
// escape still carries the skip count and remaining budget, that the per-batch structured audit
// line is NOT throttled, and that emission resumes once the window elapses. This suite covers
// that gap. Fixes SOCRATIC-TRADE-27, SOCRATIC-TRADE-2E.
const mocks = vi.hoisted(() => {
  const upsert = vi.fn();
  const index = vi.fn(() => ({ upsert }));
  return {
    upsert,
    index,
    listIndexes: vi.fn(),
    createIndex: vi.fn(),
    describeIndex: vi.fn(),
    embed: vi.fn(),
    sendNotification: vi.fn(),
    captureMessage: vi.fn(),
    scopes: [] as Array<{
      tags: Record<string, unknown>;
      context: unknown;
      fingerprint: unknown;
      level: unknown;
    }>
  };
});

vi.mock("@pinecone-database/pinecone", () => ({
  Pinecone: vi.fn(function Pinecone() {
    return {
      listIndexes: mocks.listIndexes,
      createIndex: mocks.createIndex,
      describeIndex: mocks.describeIndex,
      Index: mocks.index
    };
  })
}));

vi.mock("voyageai", () => ({
  VoyageAIClient: vi.fn(function VoyageAIClient() {
    return { embed: mocks.embed };
  })
}));

vi.mock("../src/lib/notifications", () => ({ sendNotification: mocks.sendNotification }));

// Real @sentry/nextjs is never installed in the test env; this mock lets captureRagSentryMessage
// take its normal (non-early-return) path so the rollup gate around it is actually exercised.
vi.mock("@sentry/nextjs", () => ({
  captureMessage: mocks.captureMessage,
  withScope: (callback: (scope: {
    setLevel: (level: unknown) => void;
    setTag: (key: string, value: unknown) => void;
    setFingerprint: (fp: unknown) => void;
    setContext: (name: string, ctx: unknown) => void;
  }) => void) => {
    const recorded = {
      tags: {} as Record<string, unknown>,
      context: undefined as unknown,
      fingerprint: undefined as unknown,
      level: undefined as unknown
    };
    callback({
      setLevel: (level: unknown) => {
        recorded.level = level;
      },
      setTag: (key: string, value: unknown) => {
        recorded.tags[key] = value;
      },
      setFingerprint: (fp: unknown) => {
        recorded.fingerprint = fp;
      },
      setContext: (_name: string, ctx: unknown) => {
        recorded.context = ctx;
      }
    });
    mocks.scopes.push(recorded);
  }
}));

function context() {
  return [{
    text: "Management discussed revenue growth and customer demand.",
    metadata: { symbol: "AAPL", source: "fmp-earnings-transcript", timestamp: "2026-04-20" }
  }];
}

/** storeContextsImpl fires captureRagSentryMessage through settleRagSideEffect, which — with no
 *  leaseGuard (the case for every call in this suite, matching the shared/operator ingest path
 *  in production) — is deliberately fire-and-forget (`void effect`, vector-db.ts) so an
 *  observability call can never block or fail RAG/trading control flow. Once a throttled batch
 *  fully exhausts the budget (documentsToStore.length === 0, the sustained/backfill condition
 *  SOCRATIC-TRADE-2E actually is), storeContexts returns right after firing that side effect
 *  with no further awaits, so the mocked capture can still be in flight when `await
 *  storeContexts(...)` resolves. Poll instead of asserting immediately. */
async function waitForCaptureCount(expected: number): Promise<void> {
  await vi.waitFor(() => {
    expect(mocks.captureMessage).toHaveBeenCalledTimes(expected);
  }, { timeout: 2000, interval: 10 });
}

/** Fresh temp SQLite file per test (not per file) so the rolling-24h ingest-usage counter and
 *  the cooldown marker can never leak between tests that intentionally share userId "local" —
 *  "local" (not a random per-test userId) matters here because a non-"local" userId routes
 *  storeContexts through the private-scope / per-user-write-claim path instead of the shared
 *  operator path this bug actually lives on (see effectiveStoreScope in vector-db.ts). */
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.scopes.length = 0;
  process.env.DATABASE_URL = `file:${join(tmpdir(), `socratic-ingest-budget-rollup-${randomUUID()}.db`)}`;
  process.env.PINECONE_API_KEY = "pinecone-rollup-test";
  process.env.VOYAGE_API_KEY = "voyage-rollup-test";
  process.env.PINECONE_INDEX_READY_WAIT_MS = "0";
  process.env.VECTOR_EMBED_BATCH_DELAY_MS = "0";
  process.env.RAG_INGEST_MAX_TEXTS_PER_DAY = "1";
  process.env.SENTRY_DSN = "https://fake@o0.ingest.sentry.io/0";
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.SILICONFLOW_API_KEY;
  mocks.listIndexes.mockResolvedValue({ indexes: [{ name: "socratic-trade" }] });
  mocks.createIndex.mockResolvedValue(undefined);
  mocks.describeIndex.mockResolvedValue({ metric: "cosine" });
  mocks.embed.mockResolvedValue({ data: [{ embedding: [0.1, 0.2] }] });
  mocks.upsert.mockResolvedValue(undefined);
  mocks.sendNotification.mockResolvedValue({});
});

describe("RAG ingest budget Sentry rollup", () => {
  it("captures the budget warning once, not once per throttled batch, inside the cooldown window", async () => {
    const { storeContexts } = await import("../src/lib/vector-db");

    const first = await storeContexts([...context(), ...context()], "local", {});
    const second = await storeContexts([...context(), ...context()], "local", {});
    const third = await storeContexts([...context(), ...context()], "local", {});

    expect(first.budgetSkipped).toBeGreaterThan(0);
    expect(second.budgetSkipped).toBeGreaterThan(0);
    expect(third.budgetSkipped).toBeGreaterThan(0);
    // Three throttled batches against the same persistent condition — one Sentry capture, not
    // three. This is the exact SOCRATIC-TRADE-27/-2E flood shape the cooldown exists to prevent.
    await waitForCaptureCount(1);
    expect(mocks.captureMessage).toHaveBeenCalledWith("RAG ingest text budget reached");
  }, 90_000); // 3 sequential storeContexts calls; bumped from the 60s default like the repo's
  // other real-SQLite-backed suites (see AGENTS.md's approval-lock note) to absorb shared-Mac
  // contention rather than flake under load.

  it("carries the skip count and remaining budget on the one event that does fire", async () => {
    const { storeContexts } = await import("../src/lib/vector-db");

    await storeContexts([...context(), ...context()], "local", {});

    await waitForCaptureCount(1);
    expect(mocks.scopes).toHaveLength(1);
    const rag = mocks.scopes[0]!.context as Record<string, unknown>;
    expect(rag).toMatchObject({
      operation: "embed-budget",
      lane: "rag-ingest-budget",
      limitPer24h: 1
    });
    expect(typeof rag.skipped).toBe("number");
    expect(rag.skipped as number).toBeGreaterThan(0);
    expect(typeof rag.skippedOccurrences).toBe("number");
    expect(typeof rag.allowed).toBe("number");
    expect(typeof rag.usedLast24h).toBe("number");
    // Grouped on the stable lane, never the rendered title — see captureRagSentryMessage.
    expect(mocks.scopes[0]!.fingerprint).toEqual(["rag", "rag-ingest-budget"]);
  });

  it("writes one structured audit line per throttled batch even while the Sentry warning is suppressed", async () => {
    const { storeContexts } = await import("../src/lib/vector-db");
    const { getDb } = await import("../src/lib/db");

    await storeContexts([...context(), ...context()], "local", {});
    await storeContexts([...context(), ...context()], "local", {});
    await storeContexts([...context(), ...context()], "local", {});

    const row = getDb()
      .prepare("SELECT count(*) as c FROM audit_events WHERE user_id = 'local' AND kind = 'vector_ingest_budget'")
      .get() as { c: number };

    // Every throttled batch gets its own durable audit row...
    expect(row.c).toBe(3);
    // ...independent of the Sentry cooldown, which still only let one event through.
    await waitForCaptureCount(1);
  }, 90_000); // 3 sequential storeContexts calls — see timeout note above.

  it("resumes emitting once the cooldown window has elapsed", async () => {
    const { storeContexts } = await import("../src/lib/vector-db");
    const { getInternalSetting, setInternalSetting } = await import("../src/lib/db");

    await storeContexts([...context(), ...context()], "local", {});
    await waitForCaptureCount(1);

    // Immediately retrying stays inside the (now 6h) window: still suppressed. The gate itself
    // (unlike the fire-and-forget Sentry capture) runs synchronously inside storeContexts, so
    // this negative check needs no waitFor — there is nothing in flight left to resolve.
    await storeContexts([...context(), ...context()], "local", {});
    expect(mocks.captureMessage).toHaveBeenCalledTimes(1);

    const key = "vectorStore:ingestBudgetAlert:local";
    expect(getInternalSetting<string>(key)).toBeTruthy();
    // Rewind the persisted cooldown marker past the window instead of mocking the clock —
    // shouldEmitRagIngestBudgetSentry reads/writes this exact key via getInternalSetting/
    // setInternalSetting (vector-db.ts), so this simulates the window having elapsed without
    // needing fake timers around better-sqlite3's synchronous calls.
    setInternalSetting(key, new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString());

    await storeContexts([...context(), ...context()], "local", {});
    await waitForCaptureCount(2);
  }, 90_000); // 3 sequential storeContexts calls — see timeout note above.
});
