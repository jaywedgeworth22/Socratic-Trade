import { describe, expect, it, afterEach, vi } from "vitest";
import {
  isReasoningModel,
  resolveOpenAiModel,
  withLlmRequestBounds,
  resolveLlmWireOutputCap,
  interactiveStrategyReasoningEffort,
  isDisallowedInteractiveStrategyReasoningConfig,
  reasoningCapabilityForModel,
  normalizeReasoningEffortForModel,
  strategyLlmTimeoutMs,
  greenFailoverExhaustedSuffix,
  isFailoverLlmStatus,
  isRetryableLlmStatus,
  llmFetch,
  llmFetchCapturing,
  ALL_LLM_REASONING_EFFORTS,
  LLM_MODEL_ROTATION_SENTINEL,
  LLM_OUTPUT_TOKEN_CAPS,
  LLM_REQUEST_DEFAULTS,
  LLM_TIMEOUT_MS,
  ROTATION_UI_REASONING_CAPABILITY,
  type LlmCallOutcome
} from "../src/lib/llm-request";

describe("llm-request — model resolution", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("classifies reasoning vs classic models", () => {
    expect(isReasoningModel("gpt-5.4-mini")).toBe(true);
    expect(isReasoningModel("openai/gpt-5.5")).toBe(true);
    expect(isReasoningModel("o4-mini")).toBe(true);
    expect(isReasoningModel("openai/gpt-4.1-mini")).toBe(false);
    expect(isReasoningModel("openai/gpt-4o-mini")).toBe(false);
    expect(isReasoningModel("openai/gpt-4o")).toBe(false);
    expect(isReasoningModel(undefined)).toBe(false);
  });

  it("resolves ONLY the explicit per-user policy model — no env, no default (owner 2026-07-07)", () => {
    // No model is a default for anything, ever. An explicit choice is used verbatim; a blank/unset
    // policy resolves to "" (unconfigured — callers fail closed), NOT the OPENAI_MODEL env and NOT
    // any hardcoded default.
    vi.stubEnv("OPENAI_MODEL", "openai/gpt-4o-mini");
    expect(resolveOpenAiModel({ llmModel: "openai/gpt-5.5" })).toBe("openai/gpt-5.5");
    expect(resolveOpenAiModel({ llmModel: "  " })).toBe("");
    expect(resolveOpenAiModel(null)).toBe("");
    vi.unstubAllEnvs();
    expect(resolveOpenAiModel(null)).toBe("");
  });

  it("disallows the slowest gpt-5.5 high-reasoning combo for interactive strategy runs", () => {
    expect(isDisallowedInteractiveStrategyReasoningConfig("openai/gpt-5.5", "high")).toBe(true);
    expect(isDisallowedInteractiveStrategyReasoningConfig("openai/gpt-5.5", "xhigh")).toBe(true);
    expect(isDisallowedInteractiveStrategyReasoningConfig("openai/gpt-5.5", "medium")).toBe(false);
    expect(isDisallowedInteractiveStrategyReasoningConfig("gpt-5.4-mini", "high")).toBe(false);
    expect(interactiveStrategyReasoningEffort("openai/gpt-5.5", "high")).toBe("medium");
    expect(interactiveStrategyReasoningEffort("openai/gpt-5.5", "xhigh")).toBe("medium");
    expect(interactiveStrategyReasoningEffort("openai/gpt-5.5", "low")).toBe("low");
    expect(interactiveStrategyReasoningEffort("openai/gpt-4o-mini", "high")).toBeUndefined();
  });

  it("keeps current native model reasoning controls aligned with their aliases", () => {
    expect(reasoningCapabilityForModel("claude-opus-5-5")?.provider).toBe("anthropic");
    expect(reasoningCapabilityForModel("claude-opus-5.5")?.provider).toBe("anthropic");
    expect(reasoningCapabilityForModel("claude-opus-5")?.provider).toBe("anthropic");
    for (const model of ["grok-4.6", "grok-latest", "x-ai/grok-4.6"]) {
      expect(reasoningCapabilityForModel(model)?.options.map((option) => option.value)).toEqual(["low", "medium", "high", "xhigh"]);
      expect(normalizeReasoningEffortForModel(model, "none")).toBe("low");
    }
    expect(reasoningCapabilityForModel("google/gemini-3.8-flash")?.options.map((option) => option.value)).toEqual(["low", "medium", "high"]);
  });

  it("maps provider-specific reasoning controls by model family", () => {
    expect(reasoningCapabilityForModel("gpt-5.6-sol")?.options.map((o) => o.value)).toEqual(["none", "low", "medium", "high", "xhigh", "max"]);
    expect(reasoningCapabilityForModel("gpt-5.6-terra")?.options.map((o) => o.value)).toEqual(["none", "low", "medium", "high", "xhigh", "max"]);
    expect(reasoningCapabilityForModel("gpt-5.6-luna")?.options.map((o) => o.value)).toEqual(["none", "low", "medium", "high", "xhigh", "max"]);
    expect(reasoningCapabilityForModel("o1")?.options.map((o) => o.value)).toEqual(["low", "medium", "high"]);
    expect(reasoningCapabilityForModel("claude-fable-5")?.options.map((o) => o.value)).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(reasoningCapabilityForModel("xai/grok-4.3")?.options.map((o) => o.value)).toEqual(["none", "low", "medium", "high"]);
    expect(reasoningCapabilityForModel("gemini-2.5-flash")?.options.map((o) => o.value)).toEqual(["none", "minimal", "low", "medium", "high"]);
    expect(reasoningCapabilityForModel("gemini-flash-latest")?.options.map((o) => o.value)).toEqual(["low", "medium", "high"]);
    expect(reasoningCapabilityForModel("google/gemini-3.7-flash")?.options.map((o) => o.value)).toEqual(["low", "medium", "high"]);
    expect(reasoningCapabilityForModel("gemini-3.1-pro-preview")?.options.map((o) => o.value)).toEqual(["minimal", "low", "medium", "high"]);
    // Mistral (benchmark 2026-07-08 provider 400s): ONLY medium-3-5 has a reasoning
    // capability, and only high|none. small-2603 rejects the reasoning prompt mode outright,
    // and no other family id is evidence-backed — they all get a plain chat body instead.
    expect(reasoningCapabilityForModel("mistral-medium-3-5")?.options.map((o) => o.value)).toEqual(["none", "high"]);
    expect(reasoningCapabilityForModel("mistral-small-latest")).toBeUndefined();
    expect(reasoningCapabilityForModel("mistral-large-2512")).toBeUndefined();
    expect(reasoningCapabilityForModel("magistral-medium-2506")).toBeUndefined();
    expect(reasoningCapabilityForModel("deepseek-v4-pro")?.options.map((o) => o.value)).toEqual(["none", "high", "max"]);
  });

  it("normalizes unsupported effort values to the nearest provider-supported setting", () => {
    expect(normalizeReasoningEffortForModel("gpt-5.6-sol", "max")).toBe("max");
    expect(normalizeReasoningEffortForModel("gpt-5.6-luna", "minimal")).toBe("none");
    expect(normalizeReasoningEffortForModel("o1", "xhigh")).toBe("high");
    expect(normalizeReasoningEffortForModel("gemini-3.1-pro-preview", "none")).toBe("minimal");
    expect(normalizeReasoningEffortForModel("anthropic/claude-opus-4-8", undefined)).toBe("medium");
    // DeepSeek high-effort thinking is OPT-IN: a sub-high request (incl. the undefined default and the
    // app's "medium") resolves to the FAST "none" tier, NOT a silent upgrade to the slow "high" tier
    // that spends a long hidden-reasoning phase and blew the 60s request timeout. Only an explicit
    // high/xhigh/max enables thinking. The settings UI resolves through this same function, so the
    // effort shown always equals the effort sent.
    expect(normalizeReasoningEffortForModel("deepseek-v4-pro", undefined)).toBe("none");
    expect(normalizeReasoningEffortForModel("deepseek-v4-pro", "medium")).toBe("none");
    expect(normalizeReasoningEffortForModel("deepseek-v4-pro", "low")).toBe("none");
    expect(normalizeReasoningEffortForModel("deepseek-v4-pro", "high")).toBe("high");
    expect(normalizeReasoningEffortForModel("deepseek-v4-pro", "xhigh")).toBe("max");
    // Mistral Medium 3.5 follows the same opt-in rule (provider allows only high|none): the
    // default/medium request resolves to "none", never a silent upgrade to the expensive
    // "high" tier the rank-distance normalization would otherwise pick.
    expect(normalizeReasoningEffortForModel("mistral-medium-3-5", undefined)).toBe("none");
    expect(normalizeReasoningEffortForModel("mistral-medium-3-5", "medium")).toBe("none");
    expect(normalizeReasoningEffortForModel("mistral-medium-3-5", "high")).toBe("high");
    expect(normalizeReasoningEffortForModel("mistral-medium-3-5", "xhigh")).toBe("high");
    expect(normalizeReasoningEffortForModel("mistral-small-latest", "high")).toBeUndefined();
  });

  it("the rotation sentinel never gains a REAL capability — server paths keep failing closed on it", () => {
    // The synthetic rotation capability is UI-only (ROTATION_UI_REASONING_CAPABILITY below);
    // reasoningCapabilityForModel — the function every wire-shaping path derives from — must keep
    // returning undefined for the raw sentinel so a leaked "__rotate__" can never shape a request.
    expect(reasoningCapabilityForModel(LLM_MODEL_ROTATION_SENTINEL)).toBeUndefined();
    expect(normalizeReasoningEffortForModel(LLM_MODEL_ROTATION_SENTINEL, "high")).toBeUndefined();
  });

  it("exports the UI-only rotation capability with the full generic effort ladder", () => {
    expect(ROTATION_UI_REASONING_CAPABILITY.provider).toBe("rotation");
    expect(ROTATION_UI_REASONING_CAPABILITY.options.map((o) => o.value)).toEqual([...ALL_LLM_REASONING_EFFORTS]);
    expect(ROTATION_UI_REASONING_CAPABILITY.settingLabel).toBe("Reasoning / Thinking Effort");
  });

  it("strategyProposal is a literal 4000, independent of the shared 1500 default (P1 fix: prod Roth truncated to zero proposals 2026-07-09)", () => {
    expect(LLM_REQUEST_DEFAULTS.maxOutputTokens).toBe(1500);
    expect(LLM_OUTPUT_TOKEN_CAPS.strategyProposal).toBe(4000);
    // Every OTHER cap is untouched — still tied to the shared default.
    expect(LLM_OUTPUT_TOKEN_CAPS.strategyTuning).toBe(LLM_REQUEST_DEFAULTS.maxOutputTokens);
    expect(LLM_OUTPUT_TOKEN_CAPS.adversaryReview).toBe(2500);
    expect(LLM_OUTPUT_TOKEN_CAPS.postMortemReflection).toBe(LLM_REQUEST_DEFAULTS.maxOutputTokens);
    expect(LLM_OUTPUT_TOKEN_CAPS.proposalRevalidation).toBe(LLM_REQUEST_DEFAULTS.maxOutputTokens);
    expect(LLM_OUTPUT_TOKEN_CAPS.learningReview).toBe(LLM_REQUEST_DEFAULTS.maxOutputTokens);
  });

  it("widens the strategy LLM timeout only for thinking-enabled reasoning models", () => {
    // Non-reasoning model: base bound regardless of the requested effort.
    expect(strategyLlmTimeoutMs("openai/gpt-4o-mini", "high")).toBe(LLM_TIMEOUT_MS);
    // DeepSeek at the default (medium => none, thinking OFF): base bound (fast, no widening).
    expect(strategyLlmTimeoutMs("deepseek-v4-pro", "medium")).toBe(LLM_TIMEOUT_MS);
    // DeepSeek with an explicit high effort (thinking ON): widened past the base.
    expect(strategyLlmTimeoutMs("deepseek-v4-pro", "high")).toBeGreaterThan(LLM_TIMEOUT_MS);
    // OpenAI reasoning model actually thinking at medium: widened.
    expect(strategyLlmTimeoutMs("openai/gpt-5.5", "medium")).toBeGreaterThan(LLM_TIMEOUT_MS);
    // MiniMax and Muse always reason on the wire and reserve medium reasoning headroom even though
    // they expose no configurable reasoning capability, so their timeout must widen at every effort.
    for (const model of ["minimax-m3", "minimax/minimax-m3", "MiniMax-M3", "muse-spark-1.3", "meta/muse-spark-1.3"]) {
      expect(strategyLlmTimeoutMs(model, undefined)).toBeGreaterThan(LLM_TIMEOUT_MS);
      expect(strategyLlmTimeoutMs(model, "none")).toBeGreaterThan(LLM_TIMEOUT_MS);
    }
    // Both bounds are env-tunable.
    vi.stubEnv("STRATEGY_LLM_TIMEOUT_MS", "30000");
    vi.stubEnv("STRATEGY_LLM_REASONING_TIMEOUT_MS", "200000");
    expect(strategyLlmTimeoutMs("openai/gpt-4o-mini", "high")).toBe(30000);
    expect(strategyLlmTimeoutMs("deepseek-v4-pro", "high")).toBe(200000);
    expect(strategyLlmTimeoutMs("minimax/minimax-m3", undefined)).toBe(200000);
  });
});

describe("llm-request — withLlmRequestBounds", () => {
  it("classic models keep temperature and exact token cap (no reasoning_effort)", () => {
    const chat = withLlmRequestBounds({ model: "openai/gpt-4o-mini" }, "chat-completions", {
      maxOutputTokens: 1500,
      model: "openai/gpt-4o-mini"
    });
    expect(chat.temperature).toBe(0);
    expect(chat.max_completion_tokens).toBe(1500);
    expect("reasoning_effort" in chat).toBe(false);

    const resp = withLlmRequestBounds({ model: "openai/gpt-4o-mini" }, "responses", {
      maxOutputTokens: 1500,
      model: "openai/gpt-4o-mini"
    });
    expect(resp.temperature).toBe(0);
    expect(resp.max_output_tokens).toBe(1500);
    expect("reasoning" in resp).toBe(false);
  });

  it("reserves reasoning headroom for MiniMax and Muse through OpenRouter", () => {
    for (const model of ["minimax/minimax-m3", "meta/muse-spark-1.3", "meta/muse-glimmer-30b"]) {
      const request = withLlmRequestBounds({ model }, "chat-completions", { model, maxOutputTokens: 1500 });
      expect(request.max_completion_tokens).toBe(5500);
      expect(request).not.toHaveProperty("reasoning_effort");
    }
  });

  it("bounds Astra reasoning for direct and OpenRouter requests without custom temperature", () => {
    for (const model of ["gpt-6-astra", "openai/gpt-6-astra"]) {
      const chat = withLlmRequestBounds({ model }, "chat-completions", {
        maxOutputTokens: 1500,
        model,
        reasoningEffort: "medium"
      });
      expect(chat).not.toHaveProperty("temperature");
      expect(chat.reasoning_effort).toBe("medium");
      expect(chat.max_completion_tokens).toBe(5500);
    }
  });

  it("reasoning models drop temperature, add reasoning_effort, and raise the token cap", () => {
    const chat = withLlmRequestBounds({ model: "gpt-5.4-mini" }, "chat-completions", {
      maxOutputTokens: 1500,
      model: "gpt-5.4-mini",
      reasoningEffort: "medium"
    });
    expect("temperature" in chat).toBe(false);
    expect(chat.reasoning_effort).toBe("medium");
    expect(chat.max_completion_tokens).toBe(1500 + 4000); // medium headroom

    const resp = withLlmRequestBounds({ model: "openai/gpt-5.5" }, "responses", {
      maxOutputTokens: 1500,
      model: "openai/gpt-5.5",
      reasoningEffort: "low"
    });
    expect("temperature" in resp).toBe(false);
    expect(resp.reasoning).toEqual({ effort: "low" });
    expect(resp.max_output_tokens).toBe(1500 + 2000); // low headroom
  });

  it("provider reasoning models use their provider-specific wire shapes", () => {
    const gemini = withLlmRequestBounds({ model: "gemini-2.5-flash" }, "chat-completions", {
      maxOutputTokens: 1500,
      model: "gemini-2.5-flash",
      reasoningEffort: "none"
    });
    expect(gemini.reasoning_effort).toBe("none");
    expect(gemini.max_completion_tokens).toBe(1500);

    // Claude via OpenRouter (anthropic/... on chat-completions): OpenRouter's UNIFIED `reasoning`
    // param, NOT reasoning_effort, and no temperature (Anthropic reasoning rejects it) (Codex P1 #1703).
    // The thinking budget is EXPLICIT (= the reasoning headroom, medium=4000) so the VISIBLE slice
    // stays == the requested maxOutputTokens (1500), not a fraction of the cap that would truncate
    // the JSON at high effort (Codex P2 #1733).
    const claude = withLlmRequestBounds({ model: "anthropic/claude-sonnet-5" }, "chat-completions", {
      maxOutputTokens: 1500,
      model: "anthropic/claude-sonnet-5",
      reasoningEffort: "medium"
    });
    expect(claude.reasoning).toEqual({ max_tokens: 4000 });
    expect((claude.max_completion_tokens as number) - (claude.reasoning as { max_tokens: number }).max_tokens).toBe(1500);
    expect("reasoning_effort" in claude).toBe(false);
    expect("temperature" in claude).toBe(false);

    const xai = withLlmRequestBounds({ model: "xai/grok-4.3" }, "chat-completions", {
      maxOutputTokens: 1500,
      model: "xai/grok-4.3",
      reasoningEffort: "high"
    });
    expect(xai.reasoning_effort).toBe("high");
    // Reasoning-token headroom (composite review B/high/S) is no longer OpenAI-only: xAI bills
    // hidden reasoning tokens against the same max_completion_tokens cap as the visible JSON.
    expect(xai.max_completion_tokens).toBe(1500 + 8000);

    // mistral-medium-3-5 at an explicit high: reasoning_effort high and NOTHING else — the
    // 2026-07-10 keyed probe proved it rejects prompt_mode:"reasoning" ("Reasoning prompt mode
    // is not enabled for this model"; Mistral validates reasoning_effort before prompt_mode, so
    // the 2026-07-08 effort-value 400 masked this).
    const mistralHigh = withLlmRequestBounds({ model: "mistral-medium-3-5" }, "chat-completions", {
      maxOutputTokens: 1500,
      model: "mistral-medium-3-5",
      reasoningEffort: "xhigh" // normalizes to "high" — the provider's only reasoning tier
    });
    expect(mistralHigh.reasoning_effort).toBe("high");
    expect("prompt_mode" in mistralHigh).toBe(false);
    // Reasoning tier rejects greedy sampling (top_p-must-be-1 400) — no temperature, like the
    // other providers' thinking modes.
    expect("temperature" in mistralHigh).toBe(false);
    expect(mistralHigh.max_completion_tokens).toBe(1500 + 8000);

    // mistral-medium-3-5 at the default (medium => none): reasoning_effort "none" (a value the
    // provider explicitly supports), NO prompt_mode.
    const mistralOff = withLlmRequestBounds({ model: "mistral-medium-3-5" }, "chat-completions", {
      maxOutputTokens: 1500,
      model: "mistral-medium-3-5",
      reasoningEffort: "medium"
    });
    expect(mistralOff.reasoning_effort).toBe("none");
    expect("prompt_mode" in mistralOff).toBe(false);
    expect(mistralOff.max_completion_tokens).toBe(1500);

    // mistral-small-2603 rejects reasoning params entirely ("Reasoning prompt mode is not
    // enabled for this model") — it must get a plain temperature body with no reasoning keys.
    const mistralSmall = withLlmRequestBounds({ model: "mistral-small-latest" }, "chat-completions", {
      maxOutputTokens: 1500,
      model: "mistral-small-latest",
      reasoningEffort: "high"
    });
    expect("reasoning_effort" in mistralSmall).toBe(false);
    expect("prompt_mode" in mistralSmall).toBe(false);
    expect(mistralSmall.temperature).toBe(0);
    expect(mistralSmall.max_completion_tokens).toBe(1500);

    const deepseek = withLlmRequestBounds({ model: "deepseek-v4-pro" }, "chat-completions", {
      maxOutputTokens: 1500,
      model: "deepseek-v4-pro",
      reasoningEffort: "max"
    });
    expect(deepseek.reasoning_effort).toBe("max");
    expect(deepseek.thinking).toEqual({ type: "enabled" });
    expect("temperature" in deepseek).toBe(false);
    expect(deepseek.max_completion_tokens).toBe(1500 + 16000);

    const deepseekOff = withLlmRequestBounds({ model: "deepseek-v4-flash" }, "chat-completions", {
      maxOutputTokens: 1500,
      model: "deepseek-v4-flash",
      reasoningEffort: "none"
    });
    expect(deepseekOff.thinking).toEqual({ type: "disabled" });
    expect(deepseekOff.temperature).toBe(0);

    const anthropic = withLlmRequestBounds({ model: "anthropic/claude-opus-4-8" }, "anthropic-messages", {
      maxOutputTokens: 1500,
      model: "anthropic/claude-opus-4-8",
      reasoningEffort: "max"
    });
    expect(anthropic.thinking).toEqual({ type: "adaptive" });
    expect(anthropic.output_config).toEqual({ effort: "max" });
    expect("temperature" in anthropic).toBe(false);
  });

  it("a raw rotation sentinel gets a plain temperature body — no reasoning keys, no headroom", () => {
    const bounded = withLlmRequestBounds({ model: LLM_MODEL_ROTATION_SENTINEL }, "chat-completions", {
      maxOutputTokens: 1500,
      model: LLM_MODEL_ROTATION_SENTINEL,
      reasoningEffort: "high"
    });
    expect("reasoning_effort" in bounded).toBe(false);
    expect("thinking" in bounded).toBe(false);
    expect("prompt_mode" in bounded).toBe(false);
    expect(bounded.temperature).toBe(0);
    expect(bounded.max_completion_tokens).toBe(1500);
  });

  it("reasoning models default to medium effort when unspecified", () => {
    const chat = withLlmRequestBounds({ model: "gpt-5.4-nano" }, "chat-completions", {
      maxOutputTokens: 1000,
      model: "gpt-5.4-nano"
    });
    expect(chat.reasoning_effort).toBe("medium");
    expect(chat.max_completion_tokens).toBe(1000 + 4000);
  });

  it("resolveLlmWireOutputCap exposes the ACTUAL wire cap for LLM_OUTPUT_TOKEN_CAPS.strategyProposal, matching what withLlmRequestBounds embeds in the body", () => {
    // Non-reasoning: no headroom, wire cap == the raw strategyProposal cap.
    expect(resolveLlmWireOutputCap("chat-completions", { maxOutputTokens: LLM_OUTPUT_TOKEN_CAPS.strategyProposal, model: "openai/gpt-4o-mini" }))
      .toBe(LLM_OUTPUT_TOKEN_CAPS.strategyProposal);

    // Gemini at medium reasoning effort: +4000 headroom on top of the 4000 base cap — the exact
    // shape that starved prod Roth proposals on 2026-07-09 (this is the audit's headline example).
    const geminiBounds = { maxOutputTokens: LLM_OUTPUT_TOKEN_CAPS.strategyProposal, model: "gemini-3.1-pro-preview", reasoningEffort: "medium" as const };
    const geminiWireCap = resolveLlmWireOutputCap("chat-completions", geminiBounds);
    expect(geminiWireCap).toBe(LLM_OUTPUT_TOKEN_CAPS.strategyProposal + 4000);
    // The exported resolver must match exactly what withLlmRequestBounds actually puts on the wire.
    const geminiBody = withLlmRequestBounds({ model: geminiBounds.model }, "chat-completions", geminiBounds);
    expect(geminiBody.max_completion_tokens).toBe(geminiWireCap);

    // Anthropic messages: floored at ANTHROPIC_MIN_MAX_TOKENS (4096), not raw headroom math.
    expect(resolveLlmWireOutputCap("anthropic-messages", { maxOutputTokens: LLM_OUTPUT_TOKEN_CAPS.strategyProposal, model: "anthropic/claude-opus-4-8" }))
      .toBe(4096);
  });

  // Composite review B/high/S: "Reasoning-token headroom exists only for OpenAI — other providers'
  // reasoning calls starve the JSON answer." Assert, for EVERY reasoning-capable provider and EVERY
  // effort level it supports, that the effective visible-output budget (max_completion_tokens /
  // max_output_tokens / max_tokens minus the hidden-reasoning headroom) is always >= the requested
  // cap — i.e. hidden reasoning tokens never eat into the caller's requested visible budget.
  it("every provider x effort combination preserves the full requested visible-output budget", () => {
    const requestedCap = 1500;
    const modelsByProvider: Record<string, string> = {
      openai: "gpt-5.4-mini",
      xai: "xai/grok-4.3",
      gemini: "gemini-2.5-flash",
      mistral: "mistral-medium-3-5",
      deepseek: "deepseek-v4-pro",
      anthropic: "anthropic/claude-opus-4-8"
    };

    for (const [provider, model] of Object.entries(modelsByProvider)) {
      const capability = reasoningCapabilityForModel(model);
      expect(capability?.provider, `expected a reasoning capability for ${model}`).toBe(provider);
      for (const option of capability!.options) {
        const transport = provider === "anthropic" ? "anthropic-messages" : provider === "openai" ? "responses" : "chat-completions";
        const bounded = withLlmRequestBounds(
          { model },
          transport,
          { maxOutputTokens: requestedCap, model, reasoningEffort: option.value }
        );
        const effectiveCap =
          (bounded.max_completion_tokens as number | undefined) ??
          (bounded.max_output_tokens as number | undefined) ??
          (bounded.max_tokens as number | undefined);
        expect(
          effectiveCap,
          `provider=${provider} model=${model} effort=${option.value} must expose a token cap`
        ).toBeDefined();
        expect(
          effectiveCap!,
          `provider=${provider} effort=${option.value}: effective visible-output budget (${effectiveCap}) must be >= requested cap (${requestedCap})`
        ).toBeGreaterThanOrEqual(requestedCap);
      }
    }
  });
});

describe("llm-request — llmFetchCapturing (latency capture, never sever a slow reply)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns the response within the soft timeout and reports late=false", async () => {
    vi.stubGlobal("fetch", (async () => new Response("fast", { status: 200 })) as unknown as typeof fetch);
    const outcomes: LlmCallOutcome[] = [];
    const res = await llmFetchCapturing("https://x/llm", { method: "POST" }, { softTimeoutMs: 1000, onOutcome: (o) => outcomes.push(o) });
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 5)); // let the background outcome microtask run
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!).toMatchObject({ late: false, ok: true, status: 200 });
  });

  it("rejects at the soft timeout but STILL captures the late reply + its duration", async () => {
    vi.stubGlobal("fetch", (async () => {
      await new Promise((r) => setTimeout(r, 80));
      return new Response("late-reply", { status: 200 });
    }) as unknown as typeof fetch);
    const outcomes: LlmCallOutcome[] = [];
    // The caller (strategy tick) sees a timeout and moves on...
    await expect(
      llmFetchCapturing("https://x/llm", { method: "POST" }, { softTimeoutMs: 20, onOutcome: (o) => outcomes.push(o) })
    ).rejects.toThrow(/soft timeout/i);
    // ...but the request keeps running and the eventual reply is captured for debug.
    await new Promise((r) => setTimeout(r, 130));
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.late).toBe(true);
    expect(outcomes[0]!.ok).toBe(true);
    expect(outcomes[0]!.durationMs).toBeGreaterThanOrEqual(20);
    expect(outcomes[0]!.response).toBeDefined();
    expect(await outcomes[0]!.response!.text()).toBe("late-reply");
  });
});

describe("isFailoverLlmStatus", () => {
  it("fails over 404/403/402/400 to the next model without treating them as transient retries", () => {
    expect(isRetryableLlmStatus(404)).toBe(false);
    expect(isRetryableLlmStatus(403)).toBe(false);
    expect(isRetryableLlmStatus(402)).toBe(false);
    expect(isRetryableLlmStatus(400)).toBe(false);
    expect(isFailoverLlmStatus(404)).toBe(true);
    expect(isFailoverLlmStatus(403)).toBe(true);
    expect(isFailoverLlmStatus(402)).toBe(true);
    expect(isFailoverLlmStatus(400)).toBe(true);
    expect(isFailoverLlmStatus(429)).toBe(true);
    expect(isFailoverLlmStatus(401)).toBe(false);
  });
});

describe("greenFailoverExhaustedSuffix", () => {
  it("is empty until more than one stored Green call actually ran", () => {
    expect(greenFailoverExhaustedSuffix(0)).toBe("");
    expect(greenFailoverExhaustedSuffix(1)).toBe("");
    expect(greenFailoverExhaustedSuffix(3)).toBe("  Failover chain exhausted (3 Green Team endpoints).");
  });
});


describe("MiniMax provider error envelopes", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

  it.each([[1002, 429], [1004, 401], [1008, 402], [2013, 400], [1001, 504], [9999, 502]])(
    "normalizes provider code %i to HTTP %i before callers consume the body",
    async (code, status) => {
      const payload = { base_resp: { status_code: code, status_msg: "provider error" } };
      vi.stubGlobal("fetch", vi.fn(async () => Response.json(payload, { headers: { "x-request-id": "minimax-request" } })));
      const response = await llmFetch("https://api.minimax.io/v1/chat/completions");
      expect(response.ok).toBe(false);
      expect(response.status).toBe(status);
      expect(response.headers.get("x-request-id")).toBe("minimax-request");
      expect(await response.json()).toEqual(payload);
    }
  );

  it("captures envelope failures as failed outcomes for the strategy path", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ base_resp: { status_code: 1002, status_msg: "rate limit" } })));
    const outcomes: LlmCallOutcome[] = [];
    await llmFetchCapturing("https://api.minimax.io/v1/chat/completions", {}, { softTimeoutMs: 1000, onOutcome: (outcome) => outcomes.push(outcome) });
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ ok: false, status: 429 });
  });

  it("preserves successful MiniMax replies and unrelated provider responses", async () => {
    const success = Response.json({ base_resp: { status_code: 0 }, choices: [{ message: { content: "ok" } }] });
    vi.stubGlobal("fetch", vi.fn(async () => success));
    expect(await llmFetch("https://api.minimax.io/v1/chat/completions")).toBe(success);
    expect((await success.json()).choices[0].message.content).toBe("ok");
    const unrelated = Response.json({ base_resp: { status_code: 1002 } });
    vi.stubGlobal("fetch", vi.fn(async () => unrelated));
    expect(await llmFetch("https://api.openai.com/v1/chat/completions")).toBe(unrelated);
    expect(unrelated.bodyUsed).toBe(false);
  });

  it("preserves HTTP failures and streaming responses without reading their bodies", async () => {
    for (const response of [Response.json({ error: "bad key" }, { status: 401 }), new Response("data: {}\n\n", { headers: { "content-type": "text/event-stream" } })]) {
      vi.stubGlobal("fetch", vi.fn(async () => response));
      expect(await llmFetch("https://api.minimax.io/v1/chat/completions")).toBe(response);
      expect(response.bodyUsed).toBe(false);
    }
  });
});
