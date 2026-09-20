/**
 * Model rotation ("__rotate__" testing option) — the sentinel that rotates the Proposer (green)
 * and/or Reviewer (red) model through the eligible curated models, one per strategy run, so
 * comparative live history accrues across models (proposals stamp `proposedByModel`).
 *
 * Covers: the pure representation-weighting rule (below-median and zero-usage models carry weight
 * 2, at/above-median weight 1 — an underrepresented model is twice as likely to be picked, an
 * overrepresented one still can be), proportional sampling with an injectable RNG (deterministic
 * picks + ~2:1 distribution sanity), the curated-pool exclusions, the credential-missing skip
 * (rotation never picks a model whose provider key doesn't resolve), commit-late pick auditing
 * (the audit IS the representation ledger — aborted runs never skew the weights), the same-model
 * guarantee across seats, per-account/per-seat representation scoping, the resolveOpenAiModel
 * safety net, and that the sentinel passes /api/policy validation.
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { resetDbForTesting } from "../src/lib/db";

beforeAll(() => {
  resetDbForTesting();
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-model-rotation-${randomUUID()}.db`)}`;
});

afterEach(() => {
  resetDbForTesting();
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const LLM_ENV = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "XAI_API_KEY", "GEMINI_API_KEY", "MISTRAL_API_KEY", "DEEPSEEK_API_KEY", "OPENROUTER_API_KEY"];

function noEnvKeys() {
  vi.stubEnv("LLM_OPERATOR_FALLBACK", "off");
  for (const k of LLM_ENV) vi.stubEnv(k, "");
}

/** Small deterministic PRNG (mulberry32) so sampling tests are reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("rotationRepresentationWeights (2x underrepresented rule)", () => {
  const pool = ["m0", "m1", "m2"];

  it("assigns weight 2 below the median and weight 1 at or above it", async () => {
    const { rotationRepresentationWeights } = await import("../src/lib/model-rotation");
    const counts = new Map([
      ["m0", 1],
      ["m1", 2],
      ["m2", 3]
    ]);
    expect(rotationRepresentationWeights(pool, counts)).toEqual([2, 1, 1]);
  });

  it("treats zero-usage models as maximally underrepresented (weight 2) even when the median is 0", async () => {
    const { rotationRepresentationWeights } = await import("../src/lib/model-rotation");
    // Median of [0, 0, 5] is 0 — the two unserved models are NOT below it, yet they must still be
    // favored. A model absent from the counts map is zero-usage too.
    const counts = new Map([
      ["m0", 0],
      ["m2", 5]
    ]);
    expect(rotationRepresentationWeights(pool, counts)).toEqual([2, 2, 1]);
  });

  it("degrades to uniform on empty stats (all weight 2) and on equal representation (all weight 1)", async () => {
    const { rotationRepresentationWeights } = await import("../src/lib/model-rotation");
    expect(rotationRepresentationWeights(pool, new Map())).toEqual([2, 2, 2]);
    const equal = new Map([
      ["m0", 4],
      ["m1", 4],
      ["m2", 4]
    ]);
    expect(rotationRepresentationWeights(pool, equal)).toEqual([1, 1, 1]);
  });

  it("normalizes garbage counts (negative / non-finite -> zero) and returns [] for an empty pool", async () => {
    const { rotationRepresentationWeights } = await import("../src/lib/model-rotation");
    expect(rotationRepresentationWeights([], new Map())).toEqual([]);
    const counts = new Map([
      ["m0", -3],
      ["m1", Number.NaN],
      ["m2", 2]
    ]);
    expect(rotationRepresentationWeights(pool, counts)).toEqual([2, 2, 1]);
  });
});

describe("weightedRotationPick (proportional sampling)", () => {
  const pool = ["m0", "m1", "m2", "m3"];

  it("returns undefined on an empty pool and is deterministic for a fixed rng", async () => {
    const { weightedRotationPick } = await import("../src/lib/model-rotation");
    expect(weightedRotationPick({ pool: [], counts: new Map(), random: () => 0 })).toBeUndefined();
    // All-zero counts -> uniform weight 2 each; r = 0 lands in the first slice, r near 1 in the last.
    const first = weightedRotationPick({ pool, counts: new Map(), random: () => 0 });
    expect(first).toMatchObject({ model: "m0", weight: 2, representation: 0 });
    const last = weightedRotationPick({ pool, counts: new Map(), random: () => 0.999999 });
    expect(last!.model).toBe("m3");
  });

  it("clamps a misbehaving rng instead of failing the pick", async () => {
    const { weightedRotationPick } = await import("../src/lib/model-rotation");
    expect(weightedRotationPick({ pool, counts: new Map(), random: () => Number.NaN })!.model).toBe("m0");
    expect(weightedRotationPick({ pool, counts: new Map(), random: () => 7 })!.model).toBe("m3");
    expect(weightedRotationPick({ pool, counts: new Map(), random: () => -1 })!.model).toBe("m0");
  });

  it("samples underrepresented models ~twice as often as overrepresented ones (seeded rng)", async () => {
    const { weightedRotationPick } = await import("../src/lib/model-rotation");
    // m0/m1 unserved (weight 2), m2/m3 well-represented (weight 1) -> expected pick shares
    // 1/3, 1/3, 1/6, 1/6.
    const counts = new Map([
      ["m2", 9],
      ["m3", 9]
    ]);
    const random = mulberry32(0xc0ffee);
    const tally = new Map<string, number>();
    const draws = 6000;
    for (let i = 0; i < draws; i++) {
      const pick = weightedRotationPick({ pool, counts, random })!;
      tally.set(pick.model, (tally.get(pick.model) ?? 0) + 1);
    }
    const under = (tally.get("m0") ?? 0) + (tally.get("m1") ?? 0);
    const over = (tally.get("m2") ?? 0) + (tally.get("m3") ?? 0);
    expect(under + over).toBe(draws);
    // Underrepresented share ~2/3 (deterministic for the seed; loose bounds for clarity).
    expect(under / draws).toBeGreaterThan(0.62);
    expect(under / draws).toBeLessThan(0.71);
    // Per-model ratio between one underrepresented and one overrepresented model ~2:1.
    const ratio = (tally.get("m0") ?? 0) / (tally.get("m2") ?? 1);
    expect(ratio).toBeGreaterThan(1.7);
    expect(ratio).toBeLessThan(2.3);
    // Overrepresented never means excluded — weight 1, not 0.
    expect(tally.get("m2")!).toBeGreaterThan(0);
    expect(tally.get("m3")!).toBeGreaterThan(0);
  });
});

describe("MODEL_ROTATION_POOL (curated catalog minus exclusions)", () => {
  it("excludes only the unsuitable models and nothing else from the curated catalog", async () => {
    const { MODEL_ROTATION_POOL } = await import("../src/lib/model-rotation");
    const { CURATED_LLM_MODEL_IDS } = await import("../app/ui/llm-model-catalog");
    // mistral-small-2603 / mistral-medium-3-5 were re-added 2026-07-10 (owner directive, after
    // the keyed re-benchmark proved both complete real calls) — only grok-build-0.1 (coding
    // specialist, soft-timeouts as a Green strategist) stays excluded.
    const excluded = ["grok-build-0.1"];
    for (const model of excluded) expect(MODEL_ROTATION_POOL).not.toContain(model);
    // Keep-in-sync check: the pool is exactly the curated catalog minus the exclusions.
    expect(new Set(MODEL_ROTATION_POOL)).toEqual(new Set(CURATED_LLM_MODEL_IDS.filter((id) => !excluded.includes(id))));
    expect(MODEL_ROTATION_POOL).toContain("gpt-6-astra");
    expect(MODEL_ROTATION_POOL).toContain("gpt-5.6-sol");
    expect(MODEL_ROTATION_POOL).toContain("claude-fable-latest");
    expect(MODEL_ROTATION_POOL).toContain("grok-latest");
    expect(MODEL_ROTATION_POOL).toContain("mistral-small-latest");
    expect(MODEL_ROTATION_POOL).toContain("mistral-medium-latest");
    expect(MODEL_ROTATION_POOL).toContain("kimi-latest");
  });

  // CHANGED (review finding llm-10, 2026-08-20): fail-open used to drop a hardcoded
  // `DEAD_OPENROUTER_ROTATION_MODELS` list (kimi-latest, claude-fable-5) UNCONDITIONALLY —
  // even though OpenRouter's live catalog serves both today, so nothing could ever re-admit
  // them.  Fail-open now drops ONLY slugs with an ACTIVELY RECORDED 404 cooldown (see
  // test/model-rotation-live-catalog.test.ts for full cooldown-lifecycle coverage); with no
  // cooldown recorded, fail-open must keep the pool unchanged.
  it("fail-open after /models/user timeout keeps every model when nothing has actually 404'd", async () => {
    const { applyRotationAvailabilityFailOpen, clearOpenRouterModelCooldowns, MODEL_ROTATION_POOL } = await import(
      "../src/lib/model-rotation"
    );
    clearOpenRouterModelCooldowns();
    const safe = applyRotationAvailabilityFailOpen(MODEL_ROTATION_POOL);
    expect(safe).toContain("kimi-latest");
    expect(safe).toContain("claude-fable-latest");
    expect(safe).toContain("gpt-6-astra");
    expect(safe).toContain("gpt-5.6-sol");
    expect(safe).toContain("gemini-flash-latest");
    expect(safe.length).toBe(MODEL_ROTATION_POOL.length);
  });

  it("keeps the pool when /models/user lists versioned ids but omits *-latest aliases", async () => {
    const { applyRotationUserModelAllowlist, MODEL_ROTATION_POOL } = await import("../src/lib/model-rotation");
    const versionedOnly = new Set([
      "openai/gpt-6-astra",
      "anthropic/claude-haiku-4.5",
      "google/gemini-3.7-flash",
      "deepseek/deepseek-v4-flash-0731",
      "mistralai/mistral-small-2603",
      "openai/gpt-5.6-luna",
      "anthropic/claude-sonnet-4.6",
      "google/gemini-3.5-flash-lite",
      "x-ai/grok-4.5",
      "openai/gpt-5.6-sol",
      "anthropic/claude-opus-4.6",
      "google/gemini-3.1-pro-preview",
      "deepseek/deepseek-v4-pro-0813",
      "mistralai/mistral-medium-3-5",
      "deepseek/deepseek-reasoner"
    ]);
    const result = applyRotationUserModelAllowlist(MODEL_ROTATION_POOL, versionedOnly);
    expect(result.emptiedByAllowlist).toBe(false);
    expect(result.pool.length).toBeGreaterThan(0);
    expect(result.pool).toContain("claude-haiku-latest");
    expect(result.pool).toContain("gemini-flash-latest");
    expect(result.pool).toContain("mistral-small-latest");
    expect(result.pool).toContain("grok-latest");
    expect(result.pool).toContain("gpt-6-astra");
    expect(result.pool).toContain("gpt-5.6-sol");
    expect(result.pool).not.toContain("kimi-latest");
    expect(result.pool).not.toContain("claude-fable-latest");
  });

  // CHANGED (review finding llm-10): the fail-open floor here used to always subtract the
  // hardcoded dead-slug list.  It now subtracts only slugs actually cooling down, so with no
  // cooldown recorded it fails open to the FULL credential pool.
  it("fail-opens to the full credential pool when the live allowlist matches nothing and nothing is cooling down", async () => {
    const { applyRotationUserModelAllowlist, clearOpenRouterModelCooldowns, MODEL_ROTATION_POOL } = await import(
      "../src/lib/model-rotation"
    );
    clearOpenRouterModelCooldowns();
    const result = applyRotationUserModelAllowlist(MODEL_ROTATION_POOL, new Set(["acme/not-a-catalog-model"]));
    expect(result.emptiedByAllowlist).toBe(true);
    expect(result.pool.length).toBe(MODEL_ROTATION_POOL.length);
    expect(result.pool).toContain("gpt-6-astra");
    expect(result.pool).toContain("gpt-5.6-sol");
    expect(result.pool).toContain("kimi-latest");
    expect(result.pool).toContain("claude-fable-latest");
  });
});

describe("eligibleRotationPool (credential-missing skip)", () => {
  it("keeps only models whose provider credential resolves", async () => {
    noEnvKeys();
    const userId = `rot-cred-${randomUUID()}`;
    const { upsertUserApiKey } = await import("../src/lib/db");
    const { eligibleRotationPool } = await import("../src/lib/model-rotation");
    upsertUserApiKey(userId, "openai", "sk-test-openai", "test");
    upsertUserApiKey(userId, "anthropic", "sk-test-anthropic", "test");
    const { pool, skipped } = await eligibleRotationPool(userId);
    expect(pool.length).toBeGreaterThan(0);
    
    // GPT and Claude models should be kept (in pool) since openai/anthropic keys are active
    expect(pool).toContain("gpt-6-astra");
    expect(pool).toContain("gpt-5.6-sol");
    expect(pool).toContain("claude-opus-latest");
    
    // Gemini and DeepSeek models should be skipped since gemini/deepseek keys are missing
    expect(skipped).toContain("gemini-flash-latest");
    expect(skipped).toContain("deepseek-pro-latest");
  });

  it("keeps the credential-filtered pool when OpenRouter /models/user returns 429", async () => {
    noEnvKeys();
    const userId = `rot-or-429-${randomUUID()}`;
    const { upsertUserApiKey } = await import("../src/lib/db");
    upsertUserApiKey(userId, "openrouter", "sk-test-openrouter", "test");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 429 })));
    const { eligibleRotationPool } = await import("../src/lib/model-rotation");
    const result = await eligibleRotationPool(userId);
    expect(result.availability).toBe("unavailable");
    expect(result.availabilityError).toBe("http_429");
    expect(result.pool.length).toBeGreaterThan(0);
    expect(result.pool).toContain("gpt-6-astra");
    expect(result.pool).toContain("gpt-5.6-sol");
  });

  it("keeps a non-empty pool when a live /models/user list has versioned ids and no *-latest aliases", async () => {
    noEnvKeys();
    const userId = `rot-or-alias-${randomUUID()}`;
    const { upsertUserApiKey } = await import("../src/lib/db");
    upsertUserApiKey(userId, "openrouter", "sk-test-openrouter", "test");
    vi.stubEnv("NODE_ENV", "production");
    const { clearOpenRouterUserModelAvailabilityCache } = await import("../src/lib/openrouter-model-availability");
    clearOpenRouterUserModelAvailabilityCache();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            data: [
              { id: "anthropic/claude-haiku-4.5" },
              { id: "google/gemini-3.7-flash" },
              { id: "mistralai/mistral-small-2603" },
              { id: "x-ai/grok-4.5" },
              { id: "openai/gpt-6-astra" },
              { id: "openai/gpt-5.6-sol" }
            ]
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      )
    );
    const { eligibleRotationPool } = await import("../src/lib/model-rotation");
    const result = await eligibleRotationPool(userId);
    expect(result.availability).toBe("checked");
    expect(result.availabilityError).toBeUndefined();
    expect(result.pool.length).toBeGreaterThan(0);
    expect(result.pool).toContain("claude-haiku-latest");
    expect(result.pool).toContain("gemini-flash-latest");
    expect(result.pool).toContain("grok-latest");
    expect(result.pool).not.toContain("kimi-latest");
    expect(result.pool).not.toContain("claude-fable-latest");
    vi.unstubAllGlobals();
    clearOpenRouterUserModelAvailabilityCache();
  });
});

describe("resolveModelRotationForRun", () => {
  it("returns no override (only a no-op commit) when neither seat holds the sentinel", async () => {
    noEnvKeys();
    const { resolveModelRotationForRun } = await import("../src/lib/model-rotation");
    const { commit, ...override } = await resolveModelRotationForRun({
      userId: `rot-none-${randomUUID()}`,
      accountId: "acct-1",
      runId: randomUUID(),
      policy: { llmModel: "gpt-6-astra", redTeamLlmModel: "claude-haiku-4.5" }
    });
    expect(override).toEqual({});
    expect(typeof commit).toBe("function");
    expect(() => commit()).not.toThrow(); // no-op — nothing to persist
  });

  it("rotates the green seat per run with representation-weighted sampling, never returning the sentinel", async () => {
    noEnvKeys();
    const userId = `rot-green-${randomUUID()}`;
    const accountId = "acct-green";
    const { upsertUserApiKey } = await import("../src/lib/db");
    const { resolveModelRotationForRun, eligibleRotationPool, LLM_MODEL_ROTATION_SENTINEL } = await import("../src/lib/model-rotation");
    upsertUserApiKey(userId, "openai", "sk-test", "test");
    upsertUserApiKey(userId, "anthropic", "sk-test", "test");
    const { pool } = await eligibleRotationPool(userId);
    const random = mulberry32(42);
    for (let i = 0; i < 12; i++) {
      const out = await resolveModelRotationForRun({
        userId,
        accountId,
        runId: randomUUID(),
        policy: { llmModel: LLM_MODEL_ROTATION_SENTINEL },
        random
      });
      expect(out.llmModel).toBeTruthy();
      expect(out.llmModel).not.toBe(LLM_MODEL_ROTATION_SENTINEL);
      expect(pool).toContain(out.llmModel!); // always a concrete eligible model
      expect(out.redTeamLlmModel).toBeUndefined(); // red seat not rotating
      expect(out.redTeamReasoningEffort).toBeUndefined(); // ...so its effort is untouched too
      // Per-team reasoning (2026-07-10): a rotating seat auto-sets the served model's curated
      // recommended effort on the run-scoped override.
      expect(out.llmReasoningEffort).toBeTruthy();
      expect(out.greenRotationPool).toEqual(pool);
      out.commit(); // commit-late: the representation ledger only grows once the run serves the LLM
    }
  });

  it("weights the pick by committed history: an overrepresented model becomes half as likely, but can still be picked", async () => {
    noEnvKeys();
    const userId = `rot-weight-${randomUUID()}`;
    const accountId = "acct-weight";
    const { upsertUserApiKey } = await import("../src/lib/db");
    const { resolveModelRotationForRun, eligibleRotationPool, greenFirstPickPool, LLM_MODEL_ROTATION_SENTINEL } = await import("../src/lib/model-rotation");
    upsertUserApiKey(userId, "openai", "sk-test", "test");
    const { pool } = await eligibleRotationPool(userId);
    const firstPick = greenFirstPickPool(pool);
    const n = firstPick.length;
    expect(n).toBeGreaterThanOrEqual(3);
    expect(firstPick[0]).not.toBe("gpt-5.6-sol");
    // An r on the uniform/weighted boundary: with all-zero stats (uniform weight 2, total 2n) it
    // lands in firstPick[0]'s slice (r * 2n < 2 for n >= 3); once firstPick[0] carries the only
    // committed pick (weight 1, total 2n - 1) the same r clears that halved slice
    // (r * (2n-1) = 1.5 >= 1) and lands in firstPick[1]'s.
    const r = 1.5 / (2 * n - 1);
    const baseline = await resolveModelRotationForRun({
      userId,
      accountId,
      runId: randomUUID(),
      policy: { llmModel: LLM_MODEL_ROTATION_SENTINEL },
      random: () => r
    });
    expect(baseline.llmModel).toBe(firstPick[0]);
    baseline.commit(); // firstPick[0] is now the only represented model -> weight 1, everything else 2
    const shifted = await resolveModelRotationForRun({
      userId,
      accountId,
      runId: randomUUID(),
      policy: { llmModel: LLM_MODEL_ROTATION_SENTINEL },
      random: () => r
    });
    expect(shifted.llmModel).toBe(firstPick[1]);
    // Overrepresented is NOT excluded: r = 0 still lands in firstPick[0]'s (weight-1) slice.
    const still = await resolveModelRotationForRun({
      userId,
      accountId,
      runId: randomUUID(),
      policy: { llmModel: LLM_MODEL_ROTATION_SENTINEL },
      random: () => 0
    });
    expect(still.llmModel).toBe(firstPick[0]);
  });

  it("rotates both seats independently, audits every pick with its weighting receipts, and scopes representation per account", async () => {
    noEnvKeys();
    const userId = `rot-both-${randomUUID()}`;
    const { upsertUserApiKey, getDb } = await import("../src/lib/db");
    const { resolveModelRotationForRun, eligibleRotationPool, LLM_MODEL_ROTATION_SENTINEL } = await import("../src/lib/model-rotation");
    upsertUserApiKey(userId, "openai", "sk-test", "test");
    const { pool } = await eligibleRotationPool(userId);
    const runId = randomUUID();
    const out = await resolveModelRotationForRun({
      userId,
      accountId: "acct-A",
      runId,
      policy: { llmModel: LLM_MODEL_ROTATION_SENTINEL, redTeamLlmModel: LLM_MODEL_ROTATION_SENTINEL },
      random: () => 0
    });
    expect(out.llmModel).toMatch(/^gpt-/);
    expect(out.redTeamLlmModel).toMatch(/^gpt-/);
    // Same-model guarantee end-to-end: red samples from the pool MINUS green's pick, so one run
    // never serves the same model to both seats.
    expect(out.redTeamLlmModel).not.toBe(out.llmModel);
    // Per-team reasoning (2026-07-10): each rotated seat carries ITS served model's curated
    // recommended effort (unknown -> medium) on the run-scoped override.
    const { recommendedReasoningEffortForModel } = await import("../src/lib/model-reasoning-recommendations");
    expect(out.llmReasoningEffort).toBe(recommendedReasoningEffortForModel(out.llmModel));
    expect(out.redTeamReasoningEffort).toBe(recommendedReasoningEffortForModel(out.redTeamLlmModel, "red"));
    out.commit(); // pick audits are only written on commit (Finding 3: commit-late)
    const audits = getDb()
      .prepare("SELECT payload FROM audit_events WHERE kind = 'model_rotation_pick' AND user_id = ?")
      .all(userId) as Array<{ payload: string }>;
    const parsed = audits.map(
      (row) =>
        JSON.parse(row.payload) as {
          runId: string;
          seat: string;
          model: string;
          weight: number;
          representation: number;
          reasoningEffort?: string;
        }
    );
    expect(parsed.filter((p) => p.runId === runId).map((p) => p.seat).sort()).toEqual(["green", "red"]);
    for (const pick of parsed) {
      // The weighting receipts are part of the pick's audit trail.
      expect([1, 2]).toContain(pick.weight);
      expect(pick.representation).toBe(0); // first-ever picks: no prior representation
      expect(pick.model).not.toBe(LLM_MODEL_ROTATION_SENTINEL);
      // The served effort is part of the pick's audit trail.
      expect(pick.reasoningEffort).toBe(
        recommendedReasoningEffortForModel(pick.model, pick.seat === "red" ? "red" : "green")
      );
    }
    // A different account starts from its OWN (empty) representation, independent of acct-A's
    // committed picks: on the uniform/weighted boundary r (see the weighting test above), acct-B
    // still resolves firstPick[0] — leaked acct-A history (or leaked red-seat history) would shift it.
    const { greenFirstPickPool } = await import("../src/lib/model-rotation");
    const firstPick = greenFirstPickPool(pool);
    const r = 1.5 / (2 * firstPick.length - 1);
    const other = await resolveModelRotationForRun({
      userId,
      accountId: "acct-B",
      runId: randomUUID(),
      policy: { llmModel: LLM_MODEL_ROTATION_SENTINEL },
      random: () => r
    });
    expect(other.llmModel).toBe(firstPick[0]);
    expect(other.llmModel).toBe(out.llmModel); // acct-A's first pick was firstPick[0] too (r = 0)
  });

  it("fails the rotating seats closed (empty override models, not the sentinel) when no credential resolves at all", async () => {
    noEnvKeys();
    const { resolveModelRotationForRun, LLM_MODEL_ROTATION_SENTINEL } = await import("../src/lib/model-rotation");
    const { commit, ...override } = await resolveModelRotationForRun({
      userId: `rot-nokeys-${randomUUID()}`,
      accountId: "acct-1",
      runId: randomUUID(),
      policy: { llmModel: LLM_MODEL_ROTATION_SENTINEL, redTeamLlmModel: LLM_MODEL_ROTATION_SENTINEL }
    });
    // No-defaults (owner 2026-07-07): an empty pool resolves the rotating seats to "" — the normal
    // unconfigured/fail-closed state — never the raw "__rotate__" sentinel nor a removed default.
    expect(override).toEqual({ llmModel: "", redTeamLlmModel: "", emptyReason: "empty_pool" });
    expect(typeof commit).toBe("function");
    expect(() => commit()).not.toThrow(); // no-op — no pointer to advance on an empty pool
  });

  it("defers the pick audit — the representation ledger — until commit() is called (commit-late)", async () => {
    noEnvKeys();
    const userId = `rot-commit-${randomUUID()}`;
    const accountId = "acct-commit";
    const { upsertUserApiKey, getDb } = await import("../src/lib/db");
    const { resolveModelRotationForRun, LLM_MODEL_ROTATION_SENTINEL } = await import("../src/lib/model-rotation");
    upsertUserApiKey(userId, "openai", "sk-test", "test");
    const auditCount = () =>
      (getDb()
        .prepare("SELECT COUNT(*) AS n FROM audit_events WHERE kind = 'model_rotation_pick' AND user_id = ?")
        .get(userId) as { n: number }).n;
    const out = await resolveModelRotationForRun({
      userId,
      accountId,
      runId: randomUUID(),
      policy: { llmModel: LLM_MODEL_ROTATION_SENTINEL }
    });
    expect(out.llmModel).toBeTruthy();
    // Resolve alone must NOT write the pick audit (nothing may skew the next run's weights yet).
    expect(auditCount()).toBe(0);
    // commit() (the run reached the LLM) writes it.
    out.commit();
    expect(auditCount()).toBe(1);
  });

  it("holds representation when a run aborts before commit — an aborted run never skews the weights (Finding 3)", async () => {
    noEnvKeys();
    const userId = `rot-abort-${randomUUID()}`;
    const accountId = "acct-abort";
    const { upsertUserApiKey, getDb } = await import("../src/lib/db");
    const { resolveModelRotationForRun, eligibleRotationPool, greenFirstPickPool, LLM_MODEL_ROTATION_SENTINEL } = await import("../src/lib/model-rotation");
    upsertUserApiKey(userId, "openai", "sk-test", "test");
    const { pool } = await eligibleRotationPool(userId);
    const firstPick = greenFirstPickPool(pool);
    expect(firstPick.length).toBeGreaterThanOrEqual(3);
    // Uniform/weighted boundary r (see the weighting test): uniform stats -> firstPick[0]; after ONE
    // committed firstPick[0] pick -> firstPick[1].
    const r = 1.5 / (2 * firstPick.length - 1);
    const random = () => r;
    // Run 1 resolves a pick but ABORTS before commit (e.g. account unavailable / over budget).
    const first = await resolveModelRotationForRun({ userId, accountId, runId: randomUUID(), policy: { llmModel: LLM_MODEL_ROTATION_SENTINEL }, random });
    // Run 2: the aborted run recorded nothing, so the same rng resolves the SAME model.
    const second = await resolveModelRotationForRun({ userId, accountId, runId: randomUUID(), policy: { llmModel: LLM_MODEL_ROTATION_SENTINEL }, random });
    expect(first.llmModel).toBe(firstPick[0]);
    expect(second.llmModel).toBe(first.llmModel);
    const auditCount = () =>
      (getDb()
        .prepare("SELECT COUNT(*) AS n FROM audit_events WHERE kind = 'model_rotation_pick' AND user_id = ?")
        .get(userId) as { n: number }).n;
    expect(auditCount()).toBe(0); // no representation recorded by the aborted runs
    // Run 2 now actually serves the LLM and commits -> firstPick[0] is represented (weight halved), so
    // the same rng shifts run 3 to the next underrepresented model.
    second.commit();
    const third = await resolveModelRotationForRun({ userId, accountId, runId: randomUUID(), policy: { llmModel: LLM_MODEL_ROTATION_SENTINEL }, random });
    expect(third.llmModel).toBe(firstPick[1]);
    expect(third.llmModel).not.toBe(first.llmModel);
  });
});

describe("recommendedReasoningEffortForModel (curated rotation efforts)", () => {
  it("uses role-aware GPT-5.6 efforts while preserving provider-safe defaults", async () => {
    const { recommendedReasoningEffortForModel, reasoningAdviceForModel } = await import("../src/lib/model-reasoning-recommendations");
    expect(recommendedReasoningEffortForModel("deepseek-v4-flash")).toBe("none");
    expect(recommendedReasoningEffortForModel("deepseek-v4-pro")).toBe("none");
    // 2026-09-18 catalog cleanup: gpt-5.4-mini / gpt-5.6-terra removed. The remaining curated
    // GPT rows (gpt-6-astra, gpt-6-astra-pro, gpt-5.6-sol, gpt-5.6-luna) carry the same role-aware
    // recommendation contract.
    expect(recommendedReasoningEffortForModel("gpt-5.6-luna", "chat")).toBe("low");
    expect(recommendedReasoningEffortForModel("gpt-5.6-sol", "red")).toBe("high");
    expect(recommendedReasoningEffortForModel("claude-fable-latest")).toBe("medium");
    expect(recommendedReasoningEffortForModel("some-custom-model")).toBe("medium");
    expect(recommendedReasoningEffortForModel(undefined)).toBe("medium");
    // mistral-medium-latest's advice carries the 2026-07-10 benchmark tradeoff: None is fast/cheap
    // but proposes nothing, High actually proposes but is far slower/costlier.
    expect(reasoningAdviceForModel("mistral-medium-latest")).toMatch(/EMPTY proposal list/);
    expect(reasoningAdviceForModel("mistral-medium-latest")).toMatch(/\$0\.07/);
  });

  it("every rotation-pool model's recommended effort survives the interactive clamp unchanged", async () => {
    // Rotation must never auto-set an effort the interactive strategy path would then silently
    // rewrite (e.g. recommending high for gpt-5.5, or medium for a DeepSeek that treats it as off).
    const { MODEL_ROTATION_POOL } = await import("../src/lib/model-rotation");
    const { recommendedReasoningEffortForModel } = await import("../src/lib/model-reasoning-recommendations");
    const { interactiveStrategyReasoningEffort, reasoningCapabilityForModel } = await import("../src/lib/llm-request");
    for (const model of MODEL_ROTATION_POOL) {
      const recommended = recommendedReasoningEffortForModel(model);
      const served = interactiveStrategyReasoningEffort(model, recommended);
      if (reasoningCapabilityForModel(model)) expect(served, model).toBe(recommended);
      else expect(served, model).toBeUndefined();
    }
  });
});

describe("implicitGreenRotationFallbacks", () => {
  it("takes the next two unused pool models after the primary", async () => {
    const { implicitGreenRotationFallbacks, ROTATION_IMPLICIT_GREEN_FAILOVERS } = await import("../src/lib/model-rotation");
    expect(ROTATION_IMPLICIT_GREEN_FAILOVERS).toBe(2);
    expect(implicitGreenRotationFallbacks(["a", "b", "c", "d"], "b")).toEqual(["a", "c"]);
    expect(implicitGreenRotationFallbacks(["a", "b", "c"], "a", ["c"])).toEqual(["b"]);
    expect(implicitGreenRotationFallbacks(["a"], "a")).toEqual([]);
  });

  it("greenFirstPickPool returns the full pool now that UNSERVABLE_OPENROUTER_FIRST_PICKS is empty", async () => {
    // 2026-09-18: gpt-5.6-terra (the only historical unservable-first-pick) was removed from the
    // curated catalog and the unservable list is empty. greenFirstPickPool therefore returns the
    // pool unchanged. The implicit-fallback invariant still binds the rotation to
    // gemini-flash-latest + mistral-medium-latest as the two seats below claude-haiku.
    const {
      greenFirstPickPool,
      implicitGreenRotationFallbacks,
      MODEL_ROTATION_POOL,
      UNSERVABLE_OPENROUTER_FIRST_PICKS
    } = await import("../src/lib/model-rotation");
    expect(UNSERVABLE_OPENROUTER_FIRST_PICKS).toEqual([]);
    const firstPick = greenFirstPickPool(MODEL_ROTATION_POOL);
    expect(new Set(firstPick)).toEqual(new Set(MODEL_ROTATION_POOL));
    expect(firstPick).toContain("gemini-flash-latest");
    expect(firstPick).toContain("mistral-medium-latest");
    const fallbacks = implicitGreenRotationFallbacks(MODEL_ROTATION_POOL, "claude-haiku-latest");
    expect(fallbacks).toEqual(["gemini-flash-latest", "mistral-medium-latest"]);
    expect(fallbacks).not.toContain("gpt-5.6-sol");
  });
});

describe("sentinel handling at the edges", () => {
  it("resolveOpenAiModel treats the sentinel as unset (safety net for non-run consumers)", async () => {
    vi.stubEnv("OPENAI_MODEL", "");
    const { resolveOpenAiModel, LLM_MODEL_ROTATION_SENTINEL } = await import("../src/lib/llm-request");
    // No-defaults: the sentinel (like any unset model) resolves to "" — fail closed, never a default.
    expect(resolveOpenAiModel({ llmModel: LLM_MODEL_ROTATION_SENTINEL })).toBe("");
    expect(resolveOpenAiModel({ llmModel: "gpt-6-astra" })).toBe("gpt-6-astra");
  });

  it("PUT /api/policy accepts and persists the sentinel for both seats", async () => {
    const { PUT } = await import("../app/api/policy/route");
    const { getPolicy } = await import("../src/lib/db");
    const { DEFAULT_REQUEST_USER_ID } = await import("../src/lib/request-user");
    const response = await PUT(
      new Request("http://localhost/api/policy", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ llmModel: "__rotate__", redTeamLlmModel: "__rotate__" })
      })
    );
    expect(response.status).toBe(200);
    const saved = getPolicy(DEFAULT_REQUEST_USER_ID);
    expect(saved.llmModel).toBe("__rotate__");
    expect(saved.redTeamLlmModel).toBe("__rotate__");
  });
});
