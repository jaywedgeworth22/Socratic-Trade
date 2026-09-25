// Canonical model identity — collapse a route-qualified or versioned model ID
// onto the catalog display slug (column 1 of src/lib/llm-model-catalog.ts).
//
// Under OpenRouter routing an LLM call may record a wire slug
// (`google/gemini-3.5-flash-lite`, `anthropic/claude-sonnet-latest`) while
// settings persist the display slug (`gemini-flash-lite-latest`,
// `claude-sonnet-latest`).  Cost, latency, P&L, reviewer efficacy, Usage, and
// Results must merge every version of a line onto that display slug.

import { displaySlugFor } from "./llm-model-catalog";

/** Bare catalog identity for a (possibly route-qualified) model id. Empty string for null/blank.
 *  Case-preserving: model ids are conventionally lowercase, and the benchmark/catalog lookup keys
 *  match case, so this must not lowercase. */
export function canonicalModelId(model: string | null | undefined): string {
  if (!model) return "";
  const fromCatalog = displaySlugFor(model);
  if (fromCatalog) return fromCatalog;

  let name = model.trim();
  name = name.replace(/^~/, "");
  if (name.includes("/")) {
    name = name.split("/").pop() || name;
  }
  name = name.replace(/^~/, "").replace(/^xai\//i, "").replace(/^meta-llama\//i, "").replace(/^moonshotai\//i, "");
  if (!name) return "";

  const lower = name.toLowerCase();

  if (/claude.*sonnet/i.test(lower)) return "claude-sonnet-latest";
  if (/claude.*haiku/i.test(lower)) return "claude-haiku-latest";
  if (/claude.*opus/i.test(lower)) return "claude-opus-latest";
  if (/claude.*fable/i.test(lower)) return "claude-fable-latest";

  if (/grok.*build/i.test(lower)) return "grok-build-0.1";
  if (/grok/i.test(lower)) return "grok-latest";

  if (/gemini.*flash.*lite/i.test(lower)) return "gemini-flash-lite-latest";
  if (/gemini.*flash/i.test(lower)) return "gemini-flash-latest";
  if (/gemini.*pro/i.test(lower)) return "gemini-pro-latest";

  if (/deepseek.*(r1|reasoner)/i.test(lower)) return "deepseek-r1";
  if (/deepseek.*(flash|chat)/i.test(lower)) return "deepseek-flash-latest";
  if (/deepseek.*pro/i.test(lower)) return "deepseek-pro-latest";

  if (/mistral.*small/i.test(lower)) return "mistral-small-latest";
  if (/mistral.*medium/i.test(lower)) return "mistral-medium-latest";
  if (/mistral.*large/i.test(lower)) return "mistral-large-latest";

  if (/(kimi|moonshot)/i.test(lower)) return "kimi-latest";

  if (/llama/i.test(lower)) return "llama-3.3-70b-instruct";

  if (/gpt.*sol/i.test(lower)) return "gpt-5.6-sol";
  if (/gpt.*terra/i.test(lower)) return "gpt-5.6-terra";
  if (/gpt.*luna/i.test(lower)) return "gpt-5.6-luna";
  if (/gpt-4o-mini/i.test(lower)) return "gpt-4o-mini";
  if (/gpt.*mini/i.test(lower) && !/gpt-4o/i.test(lower)) return "gpt-mini-latest";
  if (/gpt.*nano/i.test(lower)) return "gpt-5.4-nano";
  if (/gpt-4o/i.test(lower)) return "gpt-4o";

  return name;
}

/**
 * True when two model ids name the SAME model line once canonicalized — a catalog display id, an
 * OpenRouter wire slug and a namespaced policy id (`openrouter/google/gemini-flash-latest`) of one
 * model all match.  Used to keep a proposer from reviewing its own opening (the Red Team must be a
 * different model: src/lib/model-rotation.ts `planRotationImplicitFallbacks`, src/lib/red-team.ts
 * fallback attempts).  Blank ids never match anything.
 */
export function isSameModelLine(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = canonicalModelId(a);
  return left !== "" && left === canonicalModelId(b);
}
