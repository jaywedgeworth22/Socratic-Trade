/**
 * AnthropicLLM.run() must stamp every usage row with wall-clock latency and an outcome status
 * (success / error / timeout / canceled) so the LLM stats console can render per-alias latency
 * percentiles and error rates. Transport is injected, so this runs offline.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const recordLlmUsage = vi.fn();
vi.mock("../src/lib/llm-usage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/llm-usage")>();
  return { ...actual, recordLlmUsage: (...a: unknown[]) => recordLlmUsage(...a) };
});

import { AnthropicLLM } from "../src/lib/chat/llm";
import type { LlmRunArgs } from "../src/lib/chat/types";

const baseArgs: LlmRunArgs = {
  system: "You are a trading assistant.",
  message: "Hello",
  tools: [],
  executeTool: async () => ({ ok: true })
};
const usage = { userId: "user-stats-1", keySource: "user" as const };
const okResponse = {
  content: [{ type: "text", text: "hi" }],
  stop_reason: "end_turn",
  usage: { input_tokens: 10, output_tokens: 5 }
};

function lastRow() {
  expect(recordLlmUsage).toHaveBeenCalledTimes(1);
  return recordLlmUsage.mock.calls[0]![0] as { latencyMs?: number; status?: string; provider: string };
}

beforeEach(() => recordLlmUsage.mockReset());

describe("AnthropicLLM usage latency + status", () => {
  it("records success with a non-negative latency", async () => {
    const llm = new AnthropicLLM("k", "claude-opus-5.5", async () => okResponse, usage);
    await llm.run(baseArgs);
    const row = lastRow();
    expect(row.provider).toBe("anthropic");
    expect(row.status).toBe("success");
    expect(typeof row.latencyMs).toBe("number");
    expect(row.latencyMs!).toBeGreaterThanOrEqual(0);
  });

  it("records error and rethrows when the transport fails", async () => {
    const llm = new AnthropicLLM("k", "claude-opus-5.5", async () => { throw new Error("anthropic 500"); }, usage);
    await expect(llm.run(baseArgs)).rejects.toThrow("anthropic 500");
    const row = lastRow();
    expect(row.status).toBe("error");
    expect(typeof row.latencyMs).toBe("number");
  });

  it("records timeout when the transport aborts on its own timeout", async () => {
    const llm = new AnthropicLLM(
      "k",
      "claude-opus-5.5",
      async () => { throw new DOMException("The operation was aborted due to timeout", "TimeoutError"); },
      usage
    );
    await expect(llm.run(baseArgs)).rejects.toThrow();
    expect(lastRow().status).toBe("timeout");
  });

  it("records canceled when the caller's signal aborted mid-request", async () => {
    const ac = new AbortController();
    const llm = new AnthropicLLM(
      "k",
      "claude-opus-5.5",
      async () => { ac.abort(); throw new DOMException("This operation was aborted", "AbortError"); },
      usage
    );
    await expect(llm.run({ ...baseArgs, abortSignal: ac.signal })).rejects.toThrow();
    expect(lastRow().status).toBe("canceled");
  });

  it("records canceled when the caller aborted before the first step", async () => {
    const ac = new AbortController();
    ac.abort();
    const transport = vi.fn(async () => okResponse);
    const llm = new AnthropicLLM("k", "claude-opus-5.5", transport, usage);
    await llm.run({ ...baseArgs, abortSignal: ac.signal });
    expect(transport).not.toHaveBeenCalled();
    expect(lastRow().status).toBe("canceled");
  });
});
