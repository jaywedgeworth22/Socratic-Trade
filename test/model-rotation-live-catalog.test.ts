/**
 * Live-catalog / per-slug-cooldown regression tests for model-rotation.ts (review finding
 * llm-10, confirmed 2026-08-20).
 *
 * BEFORE this fix: `applyRotationUserModelAllowlist` checked a HARDCODED, PERMANENT
 * `DEAD_OPENROUTER_ROTATION_MODELS` list (`kimi-latest`, `claude-fable-latest`) BEFORE ever
 * consulting the live `/models/user` catalog, so both models were excluded from rotation
 * forever -- even though OpenRouter's live catalog serves both today
 * (`anthropic/claude-fable-latest`, `~moonshotai/kimi-latest`).  No code path could ever re-admit
 * them.  The cited justification (`anthropic/claude-fable-latest` 404ing) was also never the
 * wire slug `normalizeOpenRouterModelId` actually sends.
 *
 * AFTER this fix: the live catalog is authoritative -- a slug it lists is always kept.  A
 * per-slug, TTL'd 404 cooldown (`recordOpenRouterModelNotFound` / `isOpenRouterModelCoolingDown`
 * / `clearOpenRouterModelCooldowns`) replaces the static list and is consulted ONLY in the
 * fail-open paths (catalog unreachable, or a live allowlist that matched nothing), and only for
 * slugs that actually 404'd recently.
 *
 * These tests were written to FAIL against the pre-fix code and PASS after -- see this change's
 * handoff report for the captured failing-first evidence (model-rotation.ts was reverted to its
 * pre-fix committed content via `git show HEAD:...`, not `git stash`, to avoid touching any
 * other file a concurrently-running peer agent had modified in this same worktree).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyRotationAvailabilityFailOpen,
  applyRotationUserModelAllowlist,
  clearOpenRouterModelCooldowns,
  isOpenRouterModelCoolingDown,
  MODEL_ROTATION_POOL,
  OPENROUTER_MODEL_NOT_FOUND_COOLDOWN_MS,
  recordOpenRouterModelNotFound
} from "../src/lib/model-rotation";
import { clearOpenRouterUserModelAvailabilityCache, getOpenRouterUserModelAvailability } from "../src/lib/openrouter-model-availability";

afterEach(() => {
  clearOpenRouterModelCooldowns();
  clearOpenRouterUserModelAvailabilityCache();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("live catalog wins over the (removed) permanent dead-slug list", () => {
  // Verification item (a): a live catalog listing both slugs keeps BOTH in the rotation pool.
  // This is the core regression -- it FAILS on the pre-fix code, which drops both unconditionally.
  it("keeps BOTH claude-fable-latest and kimi-latest when the live /models/user catalog lists them", () => {
    // 2026-09-18: gpt-5.4-mini was removed from the curated catalog. Use a different openai row
    // (gpt-6-astra) to exercise the same live-catalog-includes-it path; the structural assertion
    // — claude-fable-latest + kimi-latest are kept when the live catalog lists them — is the
    // property that matters, not which OpenAI slug is present.
    const liveCatalog = new Set([
      "anthropic/claude-fable-latest",
      "~moonshotai/kimi-latest",
      "openai/gpt-6-astra",
      "google/gemini-3.7-flash"
    ]);
    const result = applyRotationUserModelAllowlist(MODEL_ROTATION_POOL, liveCatalog);
    expect(result.emptiedByAllowlist).toBe(false);
    expect(result.pool).toContain("claude-fable-latest");
    expect(result.pool).toContain("kimi-latest");
    expect(result.pool).toContain("gpt-6-astra");
    expect(result.skipped).not.toContain("claude-fable-latest");
    expect(result.skipped).not.toContain("kimi-latest");
  });

  it("still excludes a model the live catalog genuinely does not list (the allowlist itself is unchanged)", () => {
    // 2026-09-18: gpt-5.4-mini / gpt-mini-latest removed. Use openai/gpt-6-astra as the lone live
    // hit; the allowlist-keeps-only-live-listed-model invariant is unchanged.
    const liveCatalog = new Set(["openai/gpt-6-astra"]);
    const result = applyRotationUserModelAllowlist(MODEL_ROTATION_POOL, liveCatalog);
    expect(result.pool).toEqual(["gpt-6-astra"]);
    expect(result.skipped).toContain("claude-fable-latest");
    expect(result.skipped).toContain("kimi-latest");
  });

  it("a live-catalog hit wins even while the SAME slug is simultaneously cooling down from a past 404", () => {
    recordOpenRouterModelNotFound("claude-fable-latest");
    expect(isOpenRouterModelCoolingDown("claude-fable-latest")).toBe(true);
    // 2026-09-18: use gpt-6-astra (in curated catalog) instead of the removed gpt-5.4-mini.
    const liveCatalog = new Set(["anthropic/claude-fable-latest", "openai/gpt-6-astra"]);
    const result = applyRotationUserModelAllowlist(MODEL_ROTATION_POOL, liveCatalog);
    // The live catalog says it's servable right now -- that wins over a stale cooldown.
    expect(result.pool).toContain("claude-fable-latest");
    expect(result.pool).toContain("gpt-6-astra");
  });
});

describe("per-slug 404 cooldown -- fail-open paths only", () => {
  // Verification item (b): after recording an observed 404, the fail-open path drops it.
  it("drops a model from the fail-open pool only after an OBSERVED 404 is recorded for it", () => {
    expect(isOpenRouterModelCoolingDown("claude-fable-latest")).toBe(false);
    const before = applyRotationAvailabilityFailOpen(MODEL_ROTATION_POOL);
    expect(before).toContain("claude-fable-latest");
    expect(before.length).toBe(MODEL_ROTATION_POOL.length); // nothing dropped -- nothing recorded

    recordOpenRouterModelNotFound("claude-fable-latest");
    expect(isOpenRouterModelCoolingDown("claude-fable-latest")).toBe(true);
    const after = applyRotationAvailabilityFailOpen(MODEL_ROTATION_POOL);
    expect(after).not.toContain("claude-fable-latest");
    // Only the recorded slug cools -- kimi-latest, never recorded, is untouched.
    expect(after).toContain("kimi-latest");
    expect(after.length).toBe(before.length - 1);
  });

  it("keys the cooldown by the NORMALIZED wire slug -- kimi-latest and moonshotai/kimi-latest share one entry", () => {
    recordOpenRouterModelNotFound("moonshotai/kimi-latest"); // vendor-prefixed, no tilde
    expect(isOpenRouterModelCoolingDown("kimi-latest")).toBe(true); // catalog id
    expect(isOpenRouterModelCoolingDown("~moonshotai/kimi-latest")).toBe(true); // tilde'd wire id
    expect(isOpenRouterModelCoolingDown("moonshotai/kimi-latest")).toBe(true); // recorded spelling
    const after = applyRotationAvailabilityFailOpen(MODEL_ROTATION_POOL);
    expect(after).not.toContain("kimi-latest");
  });

  // Verification item (c): once the TTL elapses, the model is admitted again.
  it("admits the model again once the cooldown TTL elapses", () => {
    vi.useFakeTimers();
    const start = Date.now();
    recordOpenRouterModelNotFound("claude-fable-latest");
    expect(isOpenRouterModelCoolingDown("claude-fable-latest")).toBe(true);

    vi.setSystemTime(start + OPENROUTER_MODEL_NOT_FOUND_COOLDOWN_MS - 1);
    expect(isOpenRouterModelCoolingDown("claude-fable-latest")).toBe(true); // still cooling, 1ms short

    vi.setSystemTime(start + OPENROUTER_MODEL_NOT_FOUND_COOLDOWN_MS);
    expect(isOpenRouterModelCoolingDown("claude-fable-latest")).toBe(false); // TTL elapsed -- lazily pruned

    const readmitted = applyRotationAvailabilityFailOpen(MODEL_ROTATION_POOL);
    expect(readmitted).toContain("claude-fable-latest");
    expect(readmitted.length).toBe(MODEL_ROTATION_POOL.length);
  });

  it("clearOpenRouterModelCooldowns wipes all recorded cooldowns (test-only reset)", () => {
    recordOpenRouterModelNotFound("claude-fable-latest");
    recordOpenRouterModelNotFound("kimi-latest");
    expect(isOpenRouterModelCoolingDown("claude-fable-latest")).toBe(true);
    expect(isOpenRouterModelCoolingDown("kimi-latest")).toBe(true);
    clearOpenRouterModelCooldowns();
    expect(isOpenRouterModelCoolingDown("claude-fable-latest")).toBe(false);
    expect(isOpenRouterModelCoolingDown("kimi-latest")).toBe(false);
  });
});

describe("getOpenRouterUserModelAvailability injectable fetcher", () => {
  // Verification item (d): the injected fetcher drives the result with zero network access.
  it("drives the live-catalog result from an injected fetcher without touching the real fetch", async () => {
    const calls: unknown[] = [];
    const fakeFetch = vi.fn(async (url: unknown) => {
      calls.push(url);
      return new Response(
        JSON.stringify({
          data: [{ id: "anthropic/claude-fable-latest" }, { id: "~moonshotai/kimi-latest" }, { id: "openai/gpt-5.4-mini" }]
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }) as unknown as typeof fetch;
    // Deliberately no `vi.stubGlobal("fetch", ...)` -- if the implementation ever fell through
    // to the real global fetch instead of the injected one, `calls` would stay empty and the
    // modelIds assertions below would fail (there is no key valid against the real API).
    const result = await getOpenRouterUserModelAvailability("sk-fake-test-key", `fetcher-test-${Math.random()}`, fakeFetch);
    expect(calls.length).toBe(1);
    expect(result.status).toBe("available");
    if (result.status === "available") {
      expect(result.modelIds.has("anthropic/claude-fable-latest")).toBe(true);
      expect(result.modelIds.has("~moonshotai/kimi-latest")).toBe(true);
      expect(result.modelIds.has("openai/gpt-5.4-mini")).toBe(true);
    }
  });

  it("an injected fetcher plus applyRotationUserModelAllowlist end-to-end keeps both models, network-free", async () => {
    const fakeFetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: [{ id: "anthropic/claude-fable-latest" }, { id: "~moonshotai/kimi-latest" }, { id: "openai/gpt-5.4-mini" }]
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    ) as unknown as typeof fetch;
    const availability = await getOpenRouterUserModelAvailability("sk-fake-test-key", `fetcher-e2e-${Math.random()}`, fakeFetch);
    expect(availability.status).toBe("available");
    if (availability.status !== "available") return;
    const result = applyRotationUserModelAllowlist(MODEL_ROTATION_POOL, availability.modelIds);
    expect(result.pool).toContain("claude-fable-latest");
    expect(result.pool).toContain("kimi-latest");
  });

  it("still short-circuits to not_checked under NODE_ENV=test when no fetcher is injected (unchanged default behavior)", async () => {
    expect(process.env.NODE_ENV).toBe("test");
    const result = await getOpenRouterUserModelAvailability("sk-fake-test-key", `no-fetcher-test-${Math.random()}`);
    expect(result.status).toBe("not_checked");
  });
});
