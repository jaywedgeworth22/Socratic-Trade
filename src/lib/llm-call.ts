// Shared LLM request shaping for the strategy/analysis call sites (Bull proposer, Bear/Red-Team
// reviewer, strategy tuning, proposal re-validation, post-mortem reflection). It turns a single
// provider-agnostic request spec into the correct wire body + auth headers for whichever transport
// `resolveLlmEndpoint` picked, and extracts the model's text/JSON back out uniformly.
//
// Why this exists: those call sites historically hand-built an OpenAI-shaped body (Bearer auth,
// `response_format` / `text.format`, `choices[].message.content`). Anthropic's Messages API is a
// different shape (top-level `system`, `max_tokens`, `x-api-key`, forced tool-use for guaranteed
// JSON, content-block responses). Centralizing the per-transport shaping here lets Claude be a
// first-class Green/Red team model everywhere those sites run, instead of OpenAI-only.

import { reasoningCapabilityForModel, withLlmRequestBounds, type LlmTransport } from "./llm-request";
import type { LlmEndpoint } from "./llm-provider";
import type { LlmReasoningEffort } from "./types";
import { getGitSha } from "./git-sha";
import { jsonrepair } from "jsonrepair";
import { openrouterRequestEnrichment } from "@jaywedgeworth22/congress-trading-shared";

const CLASSIFIER_SOURCE_APP = "socratic-trade";

/** Deploy environment tag for the OpenRouter `trace` object — same resolution as
 *  `usage-monitor-push.ts`'s `usageMonitorEnv()`, duplicated here (not imported) to keep this
 *  request-shaping module decoupled from the telemetry-push module. */
function classifierEnvironment(): string {
  return process.env.USAGE_MONITOR_ENV?.trim() || process.env.NODE_ENV || "development";
}

/** Deployed commit sha, when the runtime exposes one — `undefined` (never a new required env var)
 *  otherwise, e.g. local dev. See `runtimeReleaseIdentity`'s env probe list. */
function classifierGitSha(): string | undefined {
  return getGitSha();
}

/** Call-site classifier tag threaded into an OpenRouter request's `user`/`session_id`/`trace`. */
export interface LlmClassifierTag {
  userId?: string;
  /** Non-secret key fingerprint already computed by the caller (resolveLlmEndpoint's/
   *  resolveLlmCredential's `keyRef`) — reused verbatim, never a new lookup. */
  keyRef?: string;
  /** Broad subsystem bucket, e.g. "strategy" | "rag" | "chat" | "memory". Defaults to "llm". */
  service?: string;
  /** Fine-grained call-site tag — reuse the exact string already passed to the neighbouring
   *  `recordLlmUsage`'s `context` (e.g. "red-team", "post-mortem", "chat-salience"). */
  feature?: string;
}

/**
 * Merge OpenRouter classifier enrichment (`user`/`session_id` + flat `trace`) into a request body
 * that is about to be sent to OpenRouter. No-op for every other provider — call only when
 * `endpoint.provider === "openrouter"`.
 *
 * Never breaks the call: static-context validation errors (e.g. malformed input) and any other
 * unexpected throw are caught and logged, degrading to the un-enriched `base` body rather than
 * failing a paid LLM request over telemetry metadata.
 */
/**
 * The owner's OpenRouter "Socratic Trade Classifier" (Classifiers beta, Gemini Flash Lite) reads
 * `trace.feature`/`trace.service` and maps them into a FIXED taxonomy — and when `trace.feature`
 * is absent or unrecognized it guesses, with a configured default of "assistant-chat". Our
 * internal call-site tags (ledger `context` names like "strategy"/"learning-review") are NOT
 * taxonomy values, which is why the OpenRouter dashboard showed the decision engine's spend as
 * "assistant chat" (2026-08-10). Translate at this single choke point; internal ledger names
 * stay unchanged.
 */
const CLASSIFIER_FEATURE_TAXONOMY: Record<string, string> = {
  strategy: "green-team",
  // The Bear side argues within the Socratic proposal debate — it is not the Red Team reviewer.
  "strategy-bear": "green-team",
  "red-team": "red-team",
  "strategy-tuning": "tuning",
  "learning-review": "framework-review",
  "post-mortem": "post-mortem",
  "outcome-postmortem": "post-mortem",
  "proposal-revalidation": "revalidation",
  "rag-query-deconstruct": "search-fusion-mmr",
  chat: "chat",
  "chat-salience": "chat-salience",
  "memory-salience": "memory-salience",
  embed: "embed",
  rerank: "rerank",
  "search-fusion-mmr": "search-fusion-mmr"
};

/** Subsystem taxonomy: strategy | rag | chat | memory | monitoring. Derived from the resolved
 *  feature; an explicit caller-passed service wins only when it is itself a taxonomy value. */
const CLASSIFIER_SUBSYSTEM_BY_FEATURE: Record<string, string> = {
  "green-team": "strategy",
  "red-team": "strategy",
  tuning: "strategy",
  "post-mortem": "strategy",
  revalidation: "strategy",
  "framework-review": "strategy",
  embed: "rag",
  rerank: "rag",
  "search-fusion-mmr": "rag",
  chat: "chat",
  "chat-salience": "memory",
  "memory-salience": "memory"
};

const CLASSIFIER_SUBSYSTEMS = new Set(["strategy", "rag", "chat", "memory", "monitoring"]);

export function resolveClassifierTaxonomy(tag: LlmClassifierTag): { feature?: string; service: string } {
  const feature = tag.feature ? CLASSIFIER_FEATURE_TAXONOMY[tag.feature] ?? tag.feature : undefined;
  // Never emit an off-taxonomy subsystem (the old "llm" filler): explicit-and-valid wins, then
  // derive from the resolved feature, then the taxonomy's safest default.
  const service =
    tag.service && CLASSIFIER_SUBSYSTEMS.has(tag.service)
      ? tag.service
      : (feature && CLASSIFIER_SUBSYSTEM_BY_FEATURE[feature]) || "strategy";
  return { feature, service };
}

export function applyOpenRouterClassifierEnrichment(base: Record<string, unknown>, tag: LlmClassifierTag): void {
  try {
    const taxonomy = resolveClassifierTaxonomy(tag);
    const enrichment = openrouterRequestEnrichment({
      sourceApp: CLASSIFIER_SOURCE_APP,
      environment: classifierEnvironment(),
      service: taxonomy.service,
      feature: taxonomy.feature,
      keyRef: tag.keyRef,
      gitSha: classifierGitSha(),
      // OpenRouter documents a 128-char cap on `user`; truncate rather than let the shared
      // builder's max(128) validation throw and needlessly degrade to an un-enriched request.
      user: tag.userId === undefined ? undefined : tag.userId.slice(0, 128),
    });
    if (enrichment.user !== undefined) base.user = enrichment.user;
    if (enrichment.session_id !== undefined) base.session_id = enrichment.session_id;
    base.trace = enrichment.trace;
  } catch (err) {
    console.warn(
      "[llm-call] OpenRouter classifier enrichment failed; sending the request un-enriched:",
      err instanceof Error ? err.message : String(err)
    );
  }
}

/**
 * OpenRouter `require_parameters` (docs 2026-08-18, default false): when true,
 * endpoints that do not advertise EVERY request field never receive the call,
 * then chat/completions 404s "No endpoints found matching your request" in
 * ~80ms.  `allow_fallbacks` only covers 5xx / rate-limit within a model — it
 * does not revive that empty set.
 *
 * Coolify receipts 2026-08-18 (sha cda485ff, SELECT-only): Green 404'd valid
 * public slugs `google/gemini-3.7-flash` (86ms) and `mistralai/mistral-medium-3-5`
 * (82ms).  7d also `mistralai/mistral-small-2603`.  Those ids exist on
 * /api/v1/models.  Live #2771 set require_parameters=true on every OpenRouter
 * body; strategy also sends response_format + max_completion_tokens +
 * classifier user/session_id/trace.  That is today's Green fail, not a missing
 * tilde and not an account allowlist miss.
 *
 * Keep require_parameters only for the #2771 nano case: OpenAI reasoning models
 * send `max_completion_tokens`, and the native OpenAI endpoint may only list
 * `max_tokens` (that was a 400, not today's 404).  Gemini / Mistral / Claude
 * omit the flag so OpenRouter's default false can pick an endpoint.
 */
export function shouldRequireOpenRouterParameters(body: Record<string, unknown>): boolean {
  if (typeof body.max_completion_tokens !== "number") return false;
  const model = typeof body.model === "string" ? body.model : "";
  return reasoningCapabilityForModel(model)?.provider === "openai";
}

export function applyOpenRouterProviderRouting(base: Record<string, unknown>): void {
  const existingProvider =
    base.provider && typeof base.provider === "object" && !Array.isArray(base.provider)
      ? (base.provider as Record<string, unknown>)
      : {};
  const requireParameters = shouldRequireOpenRouterParameters(base);
  const provider: Record<string, unknown> = {
    ...existingProvider,
    allow_fallbacks: existingProvider.allow_fallbacks ?? true
  };
  if (requireParameters) provider.require_parameters = true;
  else delete provider.require_parameters;
  base.provider = provider;
}

/** A JSON schema plus the name/description used to label it (OpenAI json_schema / Anthropic tool). */
export interface LlmJsonSchema {
  name: string;
  schema: Record<string, unknown>;
  description?: string;
}

export interface LlmRequestSpec {
  /** The resolved model id (from the endpoint) that this body targets. */
  model: string;
  systemPrompt: string;
  /** The user turn — already serialized (JSON string or plain text). */
  userContent: string;
  maxOutputTokens: number;
  reasoningEffort?: LlmReasoningEffort;
  /**
   * Sampling temperature for non-reasoning/deterministic-sampling paths (ignored by models that
   * reject custom temperature — reasoning models steer via `reasoningEffort` instead; see
   * `withLlmRequestBounds`). Defaults to `LLM_REQUEST_DEFAULTS.deterministicTemperature` (0) when
   * omitted, preserving every existing call site's greedy-decode behavior. Set explicitly for
   * per-role sampling (composite review B/medium/S): the Bear/debate adversary roles run at a
   * non-zero temperature so a single same-family, temperature-0 critique doesn't always find the
   * exact same (or no) objection — see the Bear/debateProposal call sites.
   */
  temperature?: number;
  /**
   * Structured-output schema. When present:
   * - OpenAI/compatible (non-DeepSeek, non-Gemini) → strict `json_schema` (unless `openAiJsonObject`);
   * - Gemini → strict `json_schema`, but with `type: [T,"null"]` / anyOf-with-null rewritten to
   *   Gemini's single-type + `nullable:true` dialect first (see `toGeminiJsonSchema`); falls back to
   *   `json_object` only if a construct can't be translated;
   * - DeepSeek → `json_object` (it rejects strict json_schema);
   * - Anthropic → a single forced tool whose `input_schema` is this schema (reliable JSON).
   * Omit for free-text output (e.g. the post-mortem reflection paragraph).
   */
  schema?: LlmJsonSchema;
  /**
   * Force OpenAI-compatible providers to use `json_object` instead of strict `json_schema`, even
   * when a `schema` is supplied. Anthropic still uses the schema as a forced tool. Used by the
   * Red-Team debate, which historically asked OpenAI for a bare JSON object (prompt-described shape)
   * rather than a strict schema — this preserves that behavior while letting Claude enforce a tool.
   */
  openAiJsonObject?: boolean;
  userId?: string;
  /** Non-secret key fingerprint already resolved by the caller (e.g. `resolveLlmEndpoint`'s
   *  `keyRef`) — threaded into the OpenRouter classifier `trace.keyRef`. */
  keyRef?: string;
  /** Call-site tag reused verbatim as the OpenRouter classifier `trace.feature` — pass the same
   *  string already given to the neighbouring `recordLlmUsage`'s `context`. Falls back to a
   *  regex-inferred tag when omitted, so untouched call sites still get a best-effort feature. */
  feature?: string;
  /** Broad subsystem bucket for the OpenRouter classifier `trace.service` (e.g. "strategy",
   *  "rag", "chat", "memory"). Defaults to "llm". */
  service?: string;
}

/** Auth + content headers for the endpoint's provider (Anthropic uses x-api-key, others Bearer). */
export function llmAuthHeaders(endpoint: Pick<LlmEndpoint, "provider" | "key">): Record<string, string> {
  if (endpoint.provider === "anthropic") {
    return {
      "content-type": "application/json",
      "x-api-key": endpoint.key ?? "",
      "anthropic-version": "2023-06-01",
      // Honour cache_control blocks on the system prompt (prompt caching). (Chat A item 3.)
      "anthropic-beta": "prompt-caching-2024-07-31"
    };
  }
  if (endpoint.provider === "openrouter") {
    return {
      "content-type": "application/json",
      authorization: `Bearer ${endpoint.key ?? ""}`,
      "HTTP-Referer": "https://socratictrade.com",
      "X-Title": "Socratic-Trade"
    };
  }
  return {
    "content-type": "application/json",
    authorization: `Bearer ${endpoint.key ?? ""}`
  };
}

/** Build the provider-correct request body (already bounded with token caps / sampling params). */
export function buildLlmRequestBody(
  endpoint: Pick<LlmEndpoint, "provider" | "transport">,
  spec: LlmRequestSpec
): Record<string, unknown> {
  const { transport } = endpoint;
  const { systemPrompt, userContent, schema, openAiJsonObject, userId, keyRef, service, feature } = spec;
  const bounds = {
    maxOutputTokens: spec.maxOutputTokens,
    model: spec.model,
    reasoningEffort: spec.reasoningEffort,
    temperature: spec.temperature
  };

  // Best-effort fallback for call sites that don't yet pass an explicit `feature` tag. Prefer the
  // caller-supplied tag (the exact string already used for `recordLlmUsage`'s `context`) — this
  // heuristic exists only so an un-migrated caller still gets a non-blank classifier feature.
  const inferredFeature = () => {
    const sys = (systemPrompt || "").toLowerCase();
    const schemaName = schema?.name || "";
    if (schemaName === "trade_proposals" || sys.includes("green team") || sys.includes("proposer")) {
      return "green-team";
    }
    if (schemaName === "red_team_verdict" || sys.includes("red team") || sys.includes("reviewer") || sys.includes("adversary")) {
      return "red-team";
    }
    if (schemaName === "tuned_parameters" || sys.includes("tuner") || sys.includes("tuning") || sys.includes("autotuning")) {
      return "tuning";
    }
    if (sys.includes("salience") || sys.includes("memory") || sys.includes("importance")) {
      return "memory-salience";
    }
    if (sys.includes("multi-query") || sys.includes("rag") || sys.includes("retrieval")) {
      return "rag";
    }
    if (sys.includes("framework review") || sys.includes("framework_review")) {
      return "framework-review";
    }
    if (sys.includes("post-mortem") || sys.includes("post_mortem")) {
      return "post-mortem";
    }
    if (sys.includes("revalidation") || sys.includes("proposal-revalidation")) {
      return "revalidation";
    }
    return "assistant-chat";
  };

  const injectCommonFields = (base: Record<string, unknown>) => {
    if (endpoint.provider === "openrouter") {
      // OpenRouter gets the shared classifier enrichment (user/session_id + flat trace) instead of
      // the old bare `metadata` field — see applyOpenRouterClassifierEnrichment's doc comment for
      // the fail-open contract (never breaks the call on an enrichment error).
      applyOpenRouterClassifierEnrichment(base, {
        userId,
        keyRef,
        service,
        feature: feature || inferredFeature()
      });
      return;
    }
    if (userId) {
      if (endpoint.provider === "openai" || endpoint.provider === "deepseek" || endpoint.provider === "gemini") {
        base.user = userId;
      } else if (endpoint.provider === "anthropic") {
        base.metadata = { ...(base.metadata as Record<string, unknown> || {}), user_id: userId };
      }
    }
  };

  if (transport === "anthropic-messages") {
    const base: Record<string, unknown> = {
      model: spec.model,
      // Prompt-caching: send the (stable) system prompt as a single ephemeral cache block so
      // Anthropic reuses the cached KV across repeated strategy/red-team calls. The per-run dynamic
      // data lives in the user message, not here, so the whole system prefix is cacheable. The
      // caching beta header is added in llmAuthHeaders. (Chat A item 3; finer-grained prefix/suffix
      // splitting can follow if a dynamic tail is ever moved into the system prompt.)
      system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: userContent }]
    };
    if (schema) {
      // Forced tool-use is Anthropic's structured-output mechanism: the model must call this single
      // tool, so its `input` comes back as schema-shaped JSON (no prose to strip / regex out).
      base.tools = [
        {
          name: schema.name,
          description: schema.description ?? `Return the result as ${schema.name}.`,
          input_schema: schema.schema
        }
      ];
      base.tool_choice = { type: "tool", name: schema.name };
    }
    injectCommonFields(base);
    const bounded = withLlmRequestBounds(base, transport, bounds);
    if (endpoint.provider === "openrouter") applyOpenRouterProviderRouting(bounded);
    return bounded;
  }

  const messages = [
    {
      role: "system",
      content: (endpoint.provider === "minimax" || /^(?:minimax\/)?minimax-/i.test(spec.model)) && schema
        ? `${systemPrompt}\n\nReturn only JSON matching this schema:\n${JSON.stringify(schema.schema)}`
        : systemPrompt
    },
    { role: "user", content: userContent }
  ];

  if (transport === "chat-completions") {
    const base: Record<string, unknown> = { model: spec.model, messages };
    if (endpoint.provider === "minimax") base.reasoning_split = true;
    const responseFormat = openAiChatResponseFormat(endpoint.provider, schema, openAiJsonObject, spec.model);
    if (responseFormat) base.response_format = responseFormat;
    injectCommonFields(base);
    const bounded = withLlmRequestBounds(base, transport, bounds);
    if (endpoint.provider === "openrouter") applyOpenRouterProviderRouting(bounded);
    return bounded;
  }

  // responses transport (OpenAI)
  const base: Record<string, unknown> = { model: spec.model, input: messages };
  const textFormat = openAiResponsesTextFormat(schema, openAiJsonObject);
  if (textFormat) base.text = { format: textFormat };
  injectCommonFields(base);
  const bounded = withLlmRequestBounds(base, transport, bounds);
  if (endpoint.provider === "openrouter") applyOpenRouterProviderRouting(bounded);
  return bounded;
}

/**
 * Recursively rewrites a JSON Schema node so Gemini's OpenAI-compatible endpoint (an
 * OpenAPI-3.0-derived structured-output dialect) reliably accepts it. Three rewrites:
 *   1. `type: [T, "null"]` union-type arrays (the app's standard "optional numeric/string field"
 *      encoding — see the Bull trade-proposal schema's quantity/dollarAmount/limitPrice/stopPrice/
 *      bracketStopLoss/bracketTakeProfit in strategy.ts) → a single `type` plus `nullable: true`
 *      (Gemini's OpenAPI-3.0 dialect).
 *   2. An `anyOf` branch that is just `{ type: "null" }` (the app's "optional whole sub-object"
 *      encoding — see `autonomyOverrideSchema` in strategy.ts) — same fix, collapsed to the
 *      non-null branch with `nullable: true` added.
 *   3. `maxItems`/`minItems` on array nodes are STRIPPED from the wire schema and folded into the
 *      node's `description` instead. Root cause of the 2026-07-08 Roth Bull outage (400
 *      INVALID_ARGUMENT in ~1s, no field details): Gemini's structured-output validator expands an
 *      array's item subtree ONCE PER `maxItems` slot against an undocumented internal complexity
 *      budget, so `maxItems × <rich item schema>` overflows it — empirically, the 15-property Bull
 *      item schema passed at maxItems<=7 and was rejected at maxItems=8, while the SAME schema with
 *      two fewer properties passed at 8, and the Bear proposal schema (no maxItems, but the SAME
 *      nullable fields and anyOf) always passed. The count bound is advisory-for-the-model anyway:
 *      every consumer truncates deterministically app-side (`sanitizeProposals(..., maxProposals)`),
 *      so stripping it can never let extra proposals through — the description keeps the model
 *      aiming for the right count. (Constructs 1/2 are dialect-compat conversions kept from the
 *      earlier fix attempt; the raw unions were later shown to be accepted too, but the converted
 *      form is Gemini's documented dialect, so we keep emitting it.)
 *
 * Returns `unsupported: true` when the walk hits a shape this transform can't collapse into Gemini's
 * dialect (a `type` array or `anyOf` with more than one remaining non-null alternative — nothing in
 * this app's schemas does that today, but a future schema addition might), so the caller can fall back
 * to a bare `json_object` the same way the existing DeepSeek special case does, rather than forwarding
 * a schema Gemini is still likely to reject.
 */
export function toGeminiJsonSchema(node: unknown): { schema: unknown; unsupported: boolean } {
  let unsupported = false;

  const isNullOnly = (candidate: unknown): boolean =>
    !!candidate &&
    typeof candidate === "object" &&
    !Array.isArray(candidate) &&
    (candidate as Record<string, unknown>).type === "null" &&
    Object.keys(candidate as Record<string, unknown>).length === 1;

  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk);
    if (!value || typeof value !== "object") return value;

    const obj = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    // Item-count bounds stripped off this node (rewrite 3 above) — folded into `description` below.
    let minItems: number | undefined;
    let maxItems: number | undefined;

    for (const [key, val] of Object.entries(obj)) {
      if (key === "maxItems" || key === "minItems") {
        // Gemini's validator multiplies the item subtree by the bound (complexity blow-up, see the
        // doc comment) — never forward it; keep the intent as prose for the model instead. A
        // non-numeric bound (malformed schema) is stripped without a prose fold.
        if (typeof val === "number" && Number.isFinite(val)) {
          if (key === "maxItems") maxItems = val;
          else minItems = val;
        }
        continue;
      }
      if (key === "type" && Array.isArray(val)) {
        const nonNullTypes = val.filter((t) => t !== "null");
        const hadNull = nonNullTypes.length !== val.length;
        if (nonNullTypes.length === 1) {
          result.type = nonNullTypes[0];
          if (hadNull) result.nullable = true;
        } else {
          // Either no non-null type at all (malformed) or more than one — no single Gemini `type`
          // this can collapse to.
          unsupported = true;
          result.type = val;
        }
        continue;
      }
      if (key === "anyOf" && Array.isArray(val)) {
        const branches = val as unknown[];
        const nonNullBranches = branches.filter((b) => !isNullOnly(b));
        const hadNull = nonNullBranches.length !== branches.length;
        if (nonNullBranches.length === 1) {
          const collapsed = walk(nonNullBranches[0]) as Record<string, unknown>;
          Object.assign(result, collapsed);
          if (hadNull) result.nullable = true;
        } else {
          // Zero or 2+ non-null branches remain — can't collapse to a single Gemini-shaped node.
          unsupported = true;
          result.anyOf = nonNullBranches.map(walk);
          if (hadNull) result.nullable = true;
        }
        continue;
      }
      result[key] = walk(val);
    }
    if (maxItems !== undefined || minItems !== undefined) {
      const bound =
        maxItems !== undefined && minItems !== undefined
          ? `between ${minItems} and ${maxItems}`
          : maxItems !== undefined
            ? `at most ${maxItems}`
            : `at least ${minItems}`;
      const constraint = `Return ${bound} items.`;
      const existing = typeof result.description === "string" && result.description.trim().length > 0 ? `${result.description.trim()} ` : "";
      result.description = `${existing}${constraint}`;
    }
    return result;
  };

  return { schema: walk(node), unsupported };
}

function openAiChatResponseFormat(
  provider: LlmEndpoint["provider"],
  schema: LlmJsonSchema | undefined,
  openAiJsonObject: boolean | undefined,
  model?: string
): Record<string, unknown> | undefined {
  const isGemini = provider === "gemini" || (model && /^google\//i.test(model));
  const isDeepSeek = provider === "deepseek" || (model && /^deepseek\//i.test(model));
  const isMiniMax = provider === "minimax";

  // MiniMax's documented OpenAI-compatible request fields include messages, tools, sampling,
  // thinking, and max_completion_tokens, but not response_format/json_schema.  Omit the
  // undocumented field so native requests are accepted; callers still require and parse JSON
  // from their schema-bearing prompt.
  if (isMiniMax) return undefined;

  if (schema && !openAiJsonObject && isGemini) {
    const { schema: geminiSchema, unsupported } = toGeminiJsonSchema(schema.schema);
    if (unsupported) {
      console.warn(
        `[llm-call] Gemini schema "${schema.name}" has a construct toGeminiJsonSchema can't translate ` +
          "(type-union or anyOf with 2+ non-null branches) — falling back to json_object."
      );
      return { type: "json_object" };
    }
    return { type: "json_schema", json_schema: { name: schema.name, strict: true, schema: geminiSchema } };
  }
  if (schema && !openAiJsonObject && !isDeepSeek) {
    return { type: "json_schema", json_schema: { name: schema.name, strict: true, schema: schema.schema } };
  }
  if (schema || openAiJsonObject) return { type: "json_object" };
  return undefined;
}

function openAiResponsesTextFormat(
  schema: LlmJsonSchema | undefined,
  openAiJsonObject: boolean | undefined
): Record<string, unknown> | undefined {
  // strict:true matches the chat-completions branch — without it the Responses API treats the
  // schema as advisory and schema-drifting output can slip through as merely JSON-shaped data.
  // Every schema routed here (Bull/Bear proposals, red-team verdict, revalidation, tuning) is
  // strict-conformant: additionalProperties:false + full required lists, null via type unions.
  if (schema && !openAiJsonObject) return { type: "json_schema", name: schema.name, strict: true, schema: schema.schema };
  if (schema || openAiJsonObject) return { type: "json_object" };
  return undefined;
}

/**
 * True when the model stopped because it hit the output-token cap (a truncated answer), across
 * transports: OpenAI chat-completions `finish_reason:"length"`, OpenAI responses API
 * `incomplete_details.reason:"max_output_tokens"` / top-level `status:"incomplete"`, and Anthropic
 * Messages `stop_reason:"max_tokens"`. A truncated JSON answer usually fails to parse, so callers use
 * this to distinguish "output cap too small" from a genuine empty result.
 */
export function detectLlmTruncation(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const p = payload as {
    stop_reason?: unknown;
    choices?: unknown;
    status?: unknown;
    incomplete_details?: { reason?: unknown } | null;
    output?: unknown;
  };
  if (p.stop_reason === "max_tokens") return true;
  if (Array.isArray(p.choices) && p.choices.some((c) => (c as { finish_reason?: unknown } | null)?.finish_reason === "length")) return true;
  if (p.status === "incomplete" && p.incomplete_details?.reason === "max_output_tokens") return true;
  if (Array.isArray(p.output) && p.output.some((o) => (o as { status?: unknown } | null)?.status === "incomplete")) return true;
  return false;
}

/**
 * Extract the model's text answer across all transports, normalized to a string the caller can
 * `JSON.parse` (when a schema was used) or read directly (free text):
 * - OpenAI responses API: `output_text`, else the first text block in `output[]`.
 * - OpenAI/compatible chat-completions: `choices[0].message.content`.
 * - Mistral chat-completions at high reasoning effort: `choices[0].message.content` is a LIST of
 *   chunks (`{type:"thinking", thinking:[...]}` + `{type:"text", text}`) rather than a plain
 *   string — only the `"text"` chunk(s) are the answer.
 * - Anthropic Messages: a `tool_use` block's `input` (re-serialized to JSON) if present, else the
 *   concatenated `text` blocks.
 */
export function extractLlmText(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const root = payload as {
    output_text?: unknown;
    choices?: Array<{ message?: { content?: unknown } }>;
    output?: Array<{ content?: Array<{ text?: unknown }> }>;
    content?: Array<{ type?: string; text?: unknown; input?: unknown }>;
  };

  if (typeof root.output_text === "string" && root.output_text.length > 0) return root.output_text;

  const chatText = root.choices?.[0]?.message?.content;
  if (typeof chatText === "string" && chatText.length > 0) return chatText;

  // Mistral high-reasoning-effort chat-completions responses: `message.content` is a list of
  // chunks instead of a string (https://docs.mistral.ai/studio-api/conversations/reasoning).
  // Concatenate only the final-answer "text" chunk(s); skip "thinking" chunks (the reasoning
  // trace), mirroring how the Anthropic content-block case below skips non-text blocks.
  if (Array.isArray(chatText)) {
    const chunks = chatText as Array<{ type?: unknown; text?: unknown }>;
    const textJoined = chunks
      .filter((chunk) => chunk?.type === "text" && typeof chunk.text === "string")
      .map((chunk) => chunk.text as string)
      .join("");
    if (textJoined.length > 0) return textJoined;
  }

  // Anthropic Messages content blocks.
  if (Array.isArray(root.content)) {
    const toolUse = root.content.find((b) => b?.type === "tool_use" && b.input !== undefined);
    if (toolUse) return JSON.stringify(toolUse.input);
    const textJoined = root.content
      .filter((b) => b?.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join("");
    if (textJoined.length > 0) return textJoined;
  }

  const responseText = root.output
    ?.flatMap((item) => item.content ?? [])
    .find((item) => typeof item.text === "string")?.text;
  if (typeof responseText === "string") return responseText;

  // Fall back to an empty OpenAI chat string (preserves prior `typeof content === "string"` semantics).
  return typeof chatText === "string" ? chatText : undefined;
}

/**
 * Extract a JSON object/array payload from an LLM text response that may be wrapped in
 * markdown code fences or surrounded by prose. Root-cause fix for the `gemini-3.5-flash`
 * failure where a fenced / prose-wrapped reply made a bare `JSON.parse(text)` throw and
 * silently disabled the adversarial review (see docs/single-adversary-consolidation.md
 * §4.1 + review point R9).
 *
 * Strategy: (1) strip an enclosing ```json / ``` fence; (2) if the remainder still isn't
 * bare JSON, return the FIRST BALANCED `{…}` or `[…]` block, scanned string- and
 * escape-aware so braces inside string values don't miscount. This is deliberately NOT a
 * greedy first-`{`-to-last-`}` slice (R9): that corrupts output when prose contains a
 * stray bracket or multiple JSON-looking blocks. When no balanced block is found (e.g. a
 * truncated response), returns the trimmed/unfenced text unchanged so the caller's own
 * `JSON.parse` try/catch still governs the failure — never fabricates valid JSON.
 *
 * `repair` (default OFF) additionally runs local, deterministic jsonrepair when the
 * extracted payload still isn't valid JSON. Opt-in ONLY, per call site, because repair can
 * turn a TRUNCATED response into syntactically valid JSON — e.g. `{"verdict":"approve"`
 * becomes a well-formed approval object. On safety-critical parse paths (Red Team verdicts,
 * proposal revalidation, tuning payloads) that converts fail-closed "unavailable" handling
 * into fail-open acceptance, which is exactly the defect class Codex flagged on PR #1696.
 * Those sites MUST call this without `repair`; generative sites that opt in MUST re-validate
 * schema-required fields on the parsed result (repair proves syntax, never completeness).
 */
export function extractJsonPayload(text: string, options: { repair?: boolean } = {}): string {
  const unfenced = text
    .trim()
    .replace(/^```(?:json5?|jsonc)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  const primary = firstBalancedJson(unfenced) ?? unfenced;

  try {
    JSON.parse(primary);
    return primary;
  } catch {
    if (!options.repair) return primary; // caller's own JSON.parse governs the failure
    // Repair the ORIGINAL unfenced text before the balanced slice: firstBalancedJson only
    // understands double-quoted strings, so a single-quoted payload whose string values
    // contain '}' gets sliced MID-STRING — repairing that fragment silently truncates content
    // or drops trailing proposals (Codex P2, round 9). Full-text repair sees the whole payload;
    // the slice remains only as a fallback for prose-wrapped responses where full-text repair
    // cannot apply. Wrong-content beats no-content on this path: a full-text repair that
    // yields a non-object degrades to zero proposals downstream, which is the safe direction.
    try {
      const repairedFull = jsonrepair(unfenced);
      JSON.parse(repairedFull);
      return repairedFull;
    } catch {
      // fall through to the balanced slice
    }
    try {
      return jsonrepair(primary);
    } catch {
      // Unrepairable; let the caller's JSON.parse fail loudly
      return primary;
    }
  }
}

/** First balanced `{…}`/`[…]` block starting at the first opener, or undefined if none/unbalanced. */
function firstBalancedJson(text: string): string | undefined {
  const start = text.search(/[[{]/);
  if (start === -1) return undefined;
  const open = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth++;
    else if (ch === close && --depth === 0) return text.slice(start, i + 1);
  }
  return undefined; // unbalanced (e.g. truncated) — let the caller's JSON.parse fail loudly
}
