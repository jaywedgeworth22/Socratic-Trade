/**
 * Datadog LLM Observability for OpenRouter / OpenAI-compatible fetch.
 *
 * One LLM span per provider HTTP call, never prompt/message contents.
 * Tool / embed / retrieval spans are not emitted (those are free, but noise).
 * Daily in-process cap keeps the org under the 40k LLM-span / month Free allotment
 * (~1,300 / day).  Fail-soft: missing tracer or a cap miss just runs the fetch.
 *
 * Do not put gen_ai.* attributes on Datadog APM traces — that auto-activates
 * paid APM LLM billing.  Sentry gen_ai spans stay in sentry-gen-ai.ts.
 */

import { inferGenAiSystem, extractModelName } from "./sentry-gen-ai";
import { datadogApmEnabled, resolveDatadogService } from "./datadog-env";

export const DD_LLMOBS_DAILY_CAP = 1_200;
export const DD_LLMOBS_ML_APP = "socratic-trade";

const LLM_HOST_HINTS = [
  "openrouter.ai",
  "api.openai.com",
  "api.anthropic.com",
  "api.x.ai",
  "googleapis.com",
  "mistral.ai",
  "deepseek.com",
  "api.minimax.io",
  "moonshot.cn",
  "api.moonshot.cn",
];

type LlmObsApi = {
  wrap?: (
    opts: Record<string, unknown>,
    fn: () => Promise<unknown>
  ) => (() => Promise<unknown>) | Promise<unknown>;
  annotate?: (opts: Record<string, unknown>) => void;
};

let emittedDay = "";
let emittedCount = 0;

function utcDay(): string {
  return new Date().toISOString().slice(0, 10);
}

export function resetDatadogLlmObsForTests(): void {
  emittedDay = "";
  emittedCount = 0;
}

export function datadogLlmObsEmittedForTests(): number {
  return emittedCount;
}

export function isLlmProviderUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return LLM_HOST_HINTS.some((hint) => host.includes(hint));
  } catch {
    return false;
  }
}

function underDailyCap(): boolean {
  const today = utcDay();
  if (emittedDay !== today) {
    emittedDay = today;
    emittedCount = 0;
  }
  if (emittedCount >= DD_LLMOBS_DAILY_CAP) return false;
  emittedCount += 1;
  return true;
}

function loadLlmObs(): LlmObsApi | null {
  const tracer = (globalThis as { _ddtrace?: { llmobs?: LlmObsApi } })._ddtrace;
  if (tracer?.llmobs && typeof tracer.llmobs.wrap === "function") return tracer.llmobs;
  return null;
}

export function datadogLlmObsInitOptions(): Record<string, unknown> {
  return {
    mlApp: DD_LLMOBS_ML_APP,
    agentlessEnabled: !process.env.DD_AGENT_HOST && !process.env.DD_TRACE_AGENT_URL,
  };
}

export async function withDatadogLlmObs<T>(
  url: string,
  init: RequestInit | undefined,
  fn: () => Promise<T>
): Promise<T> {
  if (!datadogApmEnabled() || !isLlmProviderUrl(url)) return fn();
  if (!underDailyCap()) return fn();
  const llmobs = loadLlmObs();
  if (!llmobs?.wrap) return fn();

  const model = extractModelName(init?.body) ?? "unknown";
  const provider = inferGenAiSystem(url);
  let wrapped: (() => Promise<unknown>) | Promise<unknown>;
  try {
    wrapped = llmobs.wrap(
      {
        kind: "llm",
        name: `${provider}.chat`,
        modelName: model,
        modelProvider: provider,
        sessionId: resolveDatadogService(),
      },
      async () => {
        const result = await fn();
        try {
          const isError =
            result &&
            typeof result === "object" &&
            "ok" in result &&
            (result as { ok?: boolean }).ok === false;
          const status =
            result && typeof result === "object" && "status" in result
              ? (result as { status?: number }).status
              : undefined;
          llmobs.annotate?.({
            tags: {
              ml_app: DD_LLMOBS_ML_APP,
              fleet: "core",
              ...(status ? { http_status: String(status) } : {}),
            },
            ...(isError ? { error: { message: `HTTP ${status ?? "error"}` } } : {}),
          });
        } catch {
          // annotation is best-effort
        }
        return result;
      }
    );
  } catch {
    // Tracer configuration threw synchronously; execute uninstrumented
    return fn();
  }

  // Once wrapped, execute directly so underlying rejections are not retried
  return (typeof wrapped === "function" ? await wrapped() : await wrapped) as T;
}
