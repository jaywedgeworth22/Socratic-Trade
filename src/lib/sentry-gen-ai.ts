/**
 * gen_ai.* / db spans for LLM, embed, and vector-store HTTP that does not go
 * through the OpenAI / Vercel AI / LangChain SDKs (this app speaks those
 * providers over fetch). Official `@sentry/nextjs` AI integrations stay
 * registered in sentry.server.config.ts for any SDK path that does exist.
 *
 * Never records prompt/message contents — financial/PII.
 */

import type * as SentryNs from "@sentry/nextjs";

type SentryMod = typeof SentryNs;

let cached: Promise<SentryMod | null> | undefined;

function resolveSentryMod(mod: unknown): SentryMod | null {
  if (!mod || typeof mod !== "object") return null;
  const rec = mod as SentryMod & { default?: SentryMod };
  if (typeof rec.startSpan === "function" || typeof rec.getActiveSpan === "function") return rec;
  if (typeof rec.default?.startSpan === "function") return rec.default;
  return rec.default ?? rec;
}

function loadSentry(): Promise<SentryMod | null> {
  if (!process.env.SENTRY_DSN && !process.env.NEXT_PUBLIC_SENTRY_DSN) {
    return Promise.resolve(null);
  }
  if (!cached) {
    cached = import("@sentry/nextjs")
      .then((mod) => resolveSentryMod(mod))
      .catch(() => null);
  }
  return cached;
}

export type GenAiOperation = "chat" | "embeddings" | "rerank";

export function inferGenAiSystem(url: string): string {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host.includes("openrouter.ai")) return "openrouter";
    if (host.includes("api.openai.com")) return "openai";
    if (host.includes("api.anthropic.com")) return "anthropic";
    if (host.includes("api.x.ai")) return "xai";
    if (host.includes("googleapis.com")) return "google";
    if (host.includes("mistral.ai")) return "mistral";
    if (host.includes("deepseek.com")) return "deepseek";
    if (host.includes("moonshot")) return "moonshot";
    if (host.includes("minimax")) return "minimax";
    if (host.includes("voyageai.com") || host.includes("api.voyage")) return "voyage";
    if (host.includes("pinecone.io")) return "pinecone";
    if (host.includes("earningscalls")) return "earningscalls";
    if (host.includes("siliconflow")) return "siliconflow";
    return host;
  } catch {
    return "unknown";
  }
}

/** Pull only `model` from a JSON body. Never reads messages/input/prompt. */
export function extractModelName(body: unknown): string | undefined {
  if (typeof body !== "string" || body.length === 0 || body.length > 1_000_000) return undefined;
  try {
    const parsed = JSON.parse(body) as { model?: unknown };
    return typeof parsed.model === "string" && parsed.model.trim() ? parsed.model.trim() : undefined;
  } catch {
    return undefined;
  }
}

function operationFromUrl(url: string): GenAiOperation {
  const lower = url.toLowerCase();
  if (lower.includes("/embeddings") || lower.includes("/embed")) return "embeddings";
  if (lower.includes("rerank")) return "rerank";
  return "chat";
}

let lastGenAiSpanRecord: { span: any; timestamp: number } | null = null;

export async function withGenAiSpan<T>(
  url: string,
  init: RequestInit | undefined,
  fn: () => Promise<T>,
  opts?: { operation?: GenAiOperation; model?: string; system?: string }
): Promise<T> {
  const Sentry = await loadSentry();
  const operation = opts?.operation ?? operationFromUrl(url);
  const system = opts?.system ?? inferGenAiSystem(url);
  const model = opts?.model ?? extractModelName(init?.body);
  if (!Sentry?.startSpan) return fn();
  return Sentry.startSpan(
    {
      op: `gen_ai.${operation}`,
      name: `gen_ai.${operation} ${model ?? system}`,
      attributes: {
        "gen_ai.operation.name": operation,
        "gen_ai.system": system,
        ...(model ? { "gen_ai.request.model": model } : {})
      }
    },
    async (span?: any) => {
      const activeSpan = span ?? Sentry.getActiveSpan?.();
      if (activeSpan) {
        lastGenAiSpanRecord = { span: activeSpan, timestamp: Date.now() };
      }
      const result = await fn();
      if (result && typeof result === "object") {
        if ("ok" in result && (result as { ok?: boolean }).ok === false) {
          const status = (result as { status?: number }).status;
          activeSpan?.setStatus?.({ code: 2, message: `HTTP ${status ?? "error"}` });
        }
        if (typeof (result as any).json === "function") {
          const origJson = (result as any).json.bind(result);
          (result as any).json = async () => {
            const data = await origJson();
            try {
              if (data && typeof data === "object" && "usage" in data) {
                const u = (data as { usage?: any }).usage;
                const promptTokens = u?.prompt_tokens ?? u?.input_tokens;
                const completionTokens = u?.completion_tokens ?? u?.output_tokens;
                const attrs: Record<string, string | number> = {};
                if (typeof promptTokens === "number" && Number.isFinite(promptTokens)) {
                  attrs["gen_ai.usage.input_tokens"] = promptTokens;
                }
                if (typeof completionTokens === "number" && Number.isFinite(completionTokens)) {
                  attrs["gen_ai.usage.output_tokens"] = completionTokens;
                }
                if (Object.keys(attrs).length > 0) {
                  activeSpan?.setAttributes?.(attrs);
                }
              }
            } catch {
              // best-effort
            }
            return data;
          };
        }
      }
      return result;
    }
  );
}

export async function withSentrySpan<T>(
  name: string,
  op: string,
  fn: () => Promise<T>,
  attributes?: Record<string, string | number | boolean>
): Promise<T> {
  const Sentry = await loadSentry();
  if (!Sentry?.startSpan) return fn();
  return Sentry.startSpan({ op, name, attributes }, fn);
}

/** Attach token counts to the active span. Never includes prompt text. */
export function setGenAiUsageOnActiveSpan(usage: {
  provider?: string;
  model?: string;
  promptTokens?: number;
  completionTokens?: number;
}): void {
  void loadSentry().then((Sentry) => {
    try {
      const activeSpan = Sentry?.getActiveSpan?.();
      const span = activeSpan ?? (lastGenAiSpanRecord && (Date.now() - lastGenAiSpanRecord.timestamp < 30000) ? lastGenAiSpanRecord.span : null);
      if (!span) return;
      const attrs: Record<string, string | number> = {};
      if (usage.provider) attrs["gen_ai.system"] = usage.provider;
      if (usage.model) attrs["gen_ai.request.model"] = usage.model;
      if (typeof usage.promptTokens === "number" && Number.isFinite(usage.promptTokens)) {
        attrs["gen_ai.usage.input_tokens"] = usage.promptTokens;
      }
      if (typeof usage.completionTokens === "number" && Number.isFinite(usage.completionTokens)) {
        attrs["gen_ai.usage.output_tokens"] = usage.completionTokens;
      }
      if (Object.keys(attrs).length > 0) span.setAttributes(attrs);
    } catch {
      // Fail-soft
    }
  });
}
