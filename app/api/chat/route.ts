import { resolveRequestUserId } from "@/lib/request-user";
import { buildProductionDeps, makeOrchestrator } from "@/lib/chat/orchestrator";
import {
  AnthropicLLM,
  getLLM,
  llmForModel,
  MockLLM,
  OpenAILLM,
  type ChatProvider,
  type LlmUsageOpts
} from "@/lib/chat/llm";
import { resolveLlmCredential } from "@/lib/db";
import { modelCredentialService } from "@/lib/llm-provider";
import { enforceRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { isOverLlmBudget } from "@/lib/llm-budget";
import { LLM_REQUIRED_CHAT_MESSAGE } from "@/lib/llm-required";
import { ALL_LLM_REASONING_EFFORTS } from "@/lib/llm-request";
import type { LlmReasoningEffort } from "@/lib/types";
import { NextResponse } from "next/server";
import { registerChatTurn, releaseChatTurn } from "@/lib/chat/turn-registry";
import { getPolicy } from "@/lib/db";
import { safeErrorMessage } from "@/lib/telemetry-sanitize";

/** The explicit offline path: the deterministic MockLLM, intentionally keyless. Anything else is a real
 *  provider and must resolve a credential. An empty/absent hint is NOT mock and is accepted only when
 *  an explicit operator CHAT_LLM_MODEL exists. */
function isOfflineMockRequest(modelHint: string | undefined, providerHint: string | undefined): boolean {
  return modelHint?.toLowerCase() === "mock" || providerHint === "mock";
}

/**
 * Resolve the credential service this request will ACTUALLY use.  Explicit models follow
 * llmForModel's OpenRouter-first/native-fallback precedence; legacy provider hints and CHAT_LLM keep
 * their direct-provider behavior.  The 412 gate therefore checks the same tenant-scoped key that
 * execution will use instead of disabling a model that OpenRouter can serve.
 */
function resolveChatCredentialService(modelHint: string | undefined, providerHint: string | undefined, userId: string): ChatProvider {
  if (modelHint) return modelCredentialService(modelHint, userId);
  if (providerHint === "openai" || providerHint === "anthropic") return providerHint;
  return process.env.CHAT_LLM === "anthropic" || process.env.CHAT_LLM === "minimax" || process.env.CHAT_LLM === "openrouter"
    ? process.env.CHAT_LLM
    : "openai";
}

export const dynamic = "force-dynamic";

function usageOpts(userId: string, source: "user" | "operator" | "none", keyRef?: string): LlmUsageOpts {
  return { userId, keySource: source === "operator" ? "operator" : "user", keyRef, context: "chat" };
}

/**
 * Build an LLM from the per-request provider hint, scoped to `userId`. The key resolves
 * per-user-first with the operator env key as a flag-gated failover (resolveLlmCredential), and
 * usage is attributed to the user (per attached key). Returns null for an unrecognized hint so the
 * caller falls through to the explicitly configured operator model (also per-user via getLLM).
 */
function llmFromProvider(hint: string | undefined, userId: string, reasoningEffort?: LlmReasoningEffort) {
  // No hardcoded chat model default (owner 2026-07-07: no model is a default for anything). The chat
  // model must be explicit — the client's per-request model (routed by llmForModel above) or the
  // operator's CHAT_LLM_MODEL. Without one, return null; the route's model-required gate has already
  // rejected the request, so this can never silently pick or fall back to a model.
  const chatModel = process.env.CHAT_LLM_MODEL?.trim();
  if (hint === "openai") {
    if (!chatModel) return null;
    const { key, source, keyRef } = resolveLlmCredential("openai", userId);
    if (key) return new OpenAILLM(key, chatModel, undefined, usageOpts(userId, source, keyRef), "openai", reasoningEffort);
  }
  if (hint === "anthropic") {
    if (!chatModel) return null;
    const { key, source, keyRef } = resolveLlmCredential("anthropic", userId);
    if (key) return new AnthropicLLM(key, chatModel, undefined, usageOpts(userId, source, keyRef), reasoningEffort);
  }
  if (hint === "mock") return new MockLLM();
  return null;
}

export async function POST(request: Request) {
  // Identity comes from the trusted header (resolveRequestUserId ignores the body), so rate-limit
  // BEFORE parsing the request body — an over-limit caller must not be able to force server-side
  // JSON parsing/allocation of an oversized payload just to be rejected. Returns 429 + Retry-After.
  const userId = resolveRequestUserId(request);
  const limited = enforceRateLimit(userId, "chat", RATE_LIMITS.chat);
  if (limited) return limited;
  const body = (await request.json().catch(() => ({}))) as {
    message?: unknown;
    userId?: unknown;
    provider?: unknown;
    model?: unknown;
    clientTurnId?: unknown;
    reasoningEffort?: unknown;
  };
  if (typeof body.message !== "string" || !body.message.trim()) {
    return NextResponse.json({ error: "message is required" }, { status: 400 });
  }
  // Optional idempotency key: the client generates one per send and REUSES it on Retry, so a retried
  // request doesn't record the user turn twice. Fail loud on a malformed value rather than silently
  // dropping the idempotency the caller asked for.
  let clientTurnId: string | undefined;
  if (body.clientTurnId !== undefined) {
    if (typeof body.clientTurnId !== "string" || !body.clientTurnId.trim() || body.clientTurnId.trim().length > 64) {
      return NextResponse.json({ error: "clientTurnId must be a non-empty string of at most 64 characters" }, { status: 400 });
    }
    clientTurnId = body.clientTurnId.trim();
  }

  const modelHint = typeof body.model === "string" && body.model.trim() ? body.model.trim() : undefined;
  const providerHint = typeof body.provider === "string" ? body.provider : undefined;
  if (
    body.reasoningEffort !== undefined &&
    (typeof body.reasoningEffort !== "string" || !ALL_LLM_REASONING_EFFORTS.includes(body.reasoningEffort as LlmReasoningEffort))
  ) {
    return NextResponse.json({ error: "reasoningEffort must be a supported effort value" }, { status: 400 });
  }
  const reasoningEffort: LlmReasoningEffort | undefined =
    typeof body.reasoningEffort === "string" && ALL_LLM_REASONING_EFFORTS.includes(body.reasoningEffort as LlmReasoningEffort)
      ? (body.reasoningEffort as LlmReasoningEffort)
      : undefined;
  if (!modelHint && providerHint !== "mock" && !process.env.CHAT_LLM_MODEL?.trim()) {
    return NextResponse.json(
      { error: "model_required", message: "Choose a chat model explicitly; Coach has no hidden model default." },
      { status: 400 }
    );
  }

  // Chat is LLM-driven: gate it on a resolvable credential FOR THE PROVIDER THIS REQUEST WILL CALL
  // (the user's own key OR the operator failover) — not "any provider". The explicit offline Mock model
  // is the only keyless path; a real-provider model (or no hint with an explicit operator model)
  // requires that provider's key. Gating on the resolved provider (not userHasAnyLlmCredential) closes
  // the fail-loud hole where an Anthropic-only user requesting an OpenAI model passed and llmForModel
  // silently returned MockLLM. Without the key we 412 with a clear "connect a provider" message.
  if (!isOfflineMockRequest(modelHint, providerHint)) {
    const provider = resolveChatCredentialService(modelHint, providerHint, userId);
    if (!resolveLlmCredential(provider, userId).key) {
      return NextResponse.json({ error: "llm_credential_required", message: LLM_REQUIRED_CHAT_MESSAGE }, { status: 412 });
    }
    // Enforce the daily LLM/RAG budget ceiling on chat too (default OFF → no-op when no limit is set).
    // Without this, once a user is over budget the strategy/revalidation/reflection paths are blocked
    // but dashboard chat keeps spending — chat is a real LLM (and RAG) spender and must count too.
    if (isOverLlmBudget(userId)) {
      return NextResponse.json(
        { error: "llm_budget_exceeded", message: "Daily LLM budget ceiling reached — chat is paused until the next daily reset." },
        { status: 429 }
      );
    }
  }

  try {
    // Always per-user. Precedence: an explicit model (routed to its provider across all five
    // providers), else a legacy provider hint, else the explicitly configured operator model — each keyed to this
    // user. (No shared singleton — that would pin one user's key/attribution for everyone.)
    const llm =
      (modelHint ? llmForModel(modelHint, userId, { reasoningEffort }) : undefined) ??
      llmFromProvider(providerHint, userId, reasoningEffort) ??
      getLLM(userId, { reasoningEffort });
    const orchestrate = makeOrchestrator(buildProductionDeps(), llm);
    const turnKey = `chat:${userId}:${clientTurnId ?? globalThis.crypto.randomUUID()}`;
    let handle;
    try {
      handle = registerChatTurn({ turnKey, userId });
    } catch (err) {
      if (err instanceof Error && "status" in err && (err as Error & { status: number }).status === 409) {
        return NextResponse.json({ error: "chat_turn_in_flight", turnKey }, { status: 409 });
      }
      throw err;
    }
    const policy = getPolicy(userId);
    const deadlineMs = Date.now() + Math.max(15_000, Number(process.env.CHAT_TURN_DEADLINE_MS ?? 120_000));
    try {
      const reply = await orchestrate({
        userId,
        message: body.message,
        clientTurnId,
        abortSignal: handle.controller.signal,
        deadlineMs,
        minStageBudgetMs: policy.tuning?.chatStageMinBudgetMs
      });
      return NextResponse.json({ ...reply, turnKey });
    } finally {
      releaseChatTurn(turnKey);
    }
  } catch (e) {
    const message = safeErrorMessage(e);
    console.error("[chat] orchestrator error:", message);
    return NextResponse.json({ error: "chat_failed", message }, { status: 500 });
  }
}
