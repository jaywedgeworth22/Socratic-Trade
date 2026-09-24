// Per-turn chat flow:
//   1. Append the user message to the transcript (redact-on-write) — skipped when the client's
//      clientTurnId is already recorded, so a Retry never duplicates the prompt in the transcript.
//   2. Ingest the message into salience memory (what to remember).
//   3. Assemble context (hard constraints first) into the system prompt.
//   4. Run the provider's tool loop — read-only / draft tools only, via an executeTool callback
//      that has NO execution capability (draft_order returns a ticket, never a fill).
//   5. Return { text, draft?, citations, usedMemories } — never executes a trade.
// Ported from reference/atlas-public-src/bff/orchestrator.mjs.

import { audit, findChatTurnByClientId, getPolicy, listPendingProposals } from "../db";
import { getReflectionSummary } from "../post-mortem";
import { getBrokerGateway } from "../broker";
import { getPerformanceSummary, getRegimeScorecard, getThesisScorecard } from "../performance";
import { fetchDailyOHLC } from "../history";
import { fetchYahooFinanceQuote } from "../yahoo-finance";
import { citationStalenessEnabled, defaultDedupeSimilarity, defaultMinScore, defaultRelevanceFloor, isStale, retrieveContextDetailed } from "../vector-db";
import { resolveRetrievalAsOf } from "../rag/retrieval-asof";
import type { RetrieveOptions } from "../vector-db";
import { derivePromptRagConsumption, stableRagEvidenceRef } from "../rag/evidence-consumption";
import { createAlert as alertsCreateAlert, listAlerts as alertsListAlerts } from "../alerts";
import { getEnrichmentProvider } from "../data-providers";
import { getMarketSignals } from "../market-signals";
import { callRobinhoodMcpTool, robinhoodMcpDataEnabled } from "../robinhood";
import { getMcpAccessToken } from "../mcp-oauth";
import { addToWatchlist, listWatchlist as wlList } from "../watchlist";
import { canonicalTicker } from "../rag/chunk";
import { appendTurn, listTurns } from "../chat-history";
import { ingestMessage, retrieve } from "../memory/store";
import { extractLearnedCandidatesLLM } from "../memory/salience-llm";
import { ingestLearned, retrieveLearnedContext } from "../learned-context/store";
import { applyEvidenceBudget } from "../evidence-budget";
import { createEvidencePack, createEvidenceRef, type EvidenceSourceFamily } from "../evidence-pack";
import { containPromptText, type PromptContainmentResult, type PromptTextSource } from "../prompt-safety";
import { captureCoachLearning } from "./coach-learning";
import { classifyIntent, getLLM } from "./llm";
import { buildSystem, DISCLAIMER, PROMPT_VERSION } from "./prompt";
import { buildTools, type ToolDeps } from "./tools";
import type { ChatDraft, ChatLLM, ChatQuote, ChatReply, LlmRunArgs, ToolSchema } from "./types";
import { emitDashboardEvent } from "../events";
import {
  assertUserOperationClaim,
  runWithUserWriteEpoch,
  withUserWriteOperation
} from "../user-write-fence";
import {
  assertFmpTranscriptRightsGeneration,
  captureFmpTranscriptRightsGeneration,
  FMP_TRANSCRIPT_DOC_TYPE,
  FMP_TRANSCRIPT_SOURCE,
  fmpTranscriptDerivedProvenance,
  persistFmpTranscriptDerivedArtifact,
  recordFmpTranscriptDerivedAudit,
  type FmpTranscriptDerivedProvenance
} from "../web-sources/fmp-transcripts";
import {
  EARNINGSCALLS_TRANSCRIPT_SOURCE,
  earningsCallsTranscriptsEnabled
} from "../earningscalls-gate";
import {
  ROIC_TRANSCRIPT_SOURCE,
  roicTranscriptsEnabled
} from "../roic-transcripts-gate";

function toolEvidenceFamily(name: string): EvidenceSourceFamily {
  if (name === "kb_search") return "filings";
  if (name === "get_quote" || name === "get_market_signals") return "market";
  if (name === "get_fundamentals") return "fundamentals";
  if (name === "get_positions" || name === "get_portfolio" || name === "get_portfolio_pnl") return "portfolio";
  if (name === "get_performance_summary") return "learning";
  return "other";
}

function containPromptData(
  value: unknown,
  source: PromptTextSource,
  path: string,
  receipts: Array<{ path: string; result: PromptContainmentResult }>,
  depth = 0
): unknown {
  if (typeof value === "string") {
    const result = containPromptText({ source, text: value });
    if (result.status !== "clean" && result.status !== "trusted") receipts.push({ path, result });
    return result.sanitizedText;
  }
  if (depth >= 8 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item, index) => containPromptData(item, source, `${path}[${index}]`, receipts, depth + 1));
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      containPromptData(item, source, `${path}.${key}`, receipts, depth + 1)
    ])
  );
}

export function makeOrchestrator(deps: ToolDeps, llm?: ChatLLM) {
  const tools = buildTools();
  const toolSchemas: ToolSchema[] = Object.entries(tools).map(([name, t]) => ({
    name,
    description: t.description,
    input_schema: t.input_schema
  }));

  return async function handleTurn(args: {
    userId: string;
    message: string;
    clientTurnId?: string;
    abortSignal?: AbortSignal;
    deadlineMs?: number;
    minStageBudgetMs?: number;
    onStage?: LlmRunArgs["onStage"];
  }): Promise<ChatReply> {
    return withUserWriteOperation(args.userId, "chat-turn", async (operationClaim) => {
    const { userId, message, clientTurnId } = args;
    const writeEpoch = operationClaim.epoch;
    const assertTurnActive = () => assertUserOperationClaim(operationClaim);
    const fmpRightsClaim = captureFmpTranscriptRightsGeneration();
    const fmpProvenance: FmpTranscriptDerivedProvenance[] = [];
    const rememberFmpProvenance = (values: readonly unknown[]) => {
      const next = fmpTranscriptDerivedProvenance([...fmpProvenance, ...values]);
      fmpProvenance.splice(0, fmpProvenance.length, ...next);
    };
    const policy = getPolicy(userId);
    const connectedAccountId = policy.connectedAccountId;
    const writeAudit = (kind: string, payload: Record<string, unknown>) =>
      runWithUserWriteEpoch(userId, writeEpoch, () => audit(kind, payload, userId, connectedAccountId));
    const turnDeps: ToolDeps = {
      ...deps,
      createAlert(targetUserId, input) {
        if (targetUserId !== userId) throw new Error("Chat tool user identity mismatch.");
        return runWithUserWriteEpoch(userId, writeEpoch, () => deps.createAlert(targetUserId, input));
      },
      watchlistAdd(targetUserId, symbol) {
        if (targetUserId !== userId) throw new Error("Chat tool user identity mismatch.");
        return runWithUserWriteEpoch(userId, writeEpoch, () => deps.watchlistAdd(targetUserId, symbol));
      }
    };
    const turnKey = `chat:${userId}:${clientTurnId ?? globalThis.crypto.randomUUID()}`;
    // Per-user model: an injected llm (already user-scoped by the route) or one resolved for THIS
    // user — so the per-user key, operator failover, and usage attribution always apply.
    const model = llm ?? getLLM(userId);
    writeAudit("chat.turn", { userId, message_len: message.length, prompt_version: PROMPT_VERSION, turnKey });
    // Prior turns (redacted) for multi-turn context — fetched BEFORE appending the current message.
    const history = listTurns(userId, 10, connectedAccountId).map((t) => ({ role: t.role, text: t.text }));
    // Idempotent user-turn recording: a Retry reuses the same clientTurnId, so when that id is
    // already in the transcript we skip the duplicate append but STILL run the provider call —
    // the retry's whole point is getting the reply the failed attempt never produced.
    const alreadyRecorded = clientTurnId != null && findChatTurnByClientId(userId, clientTurnId) != null;
    if (!alreadyRecorded) appendTurn(userId, { role: "user", text: message, clientTurnId: clientTurnId ?? null, connectedAccountId }, writeEpoch);

    const mem = ingestMessage(userId, message, writeEpoch);
    // Coach → durable learning: explicit strategy directives ("from now on…") and pasted article
    // URLs are captured into learned_context / the approval queue (and optionally lesson vectors).
    // Awaited so the reply can honestly say what was written vs queued for approval. SSRF-safe for URLs.
    let learningCapture: ChatReply["learningCapture"] = null;
    try {
      const capture = await captureCoachLearning({
        userId,
        message,
        writeEpoch,
        connectedAccountId,
        indexVectors: true
      });
      assertTurnActive();
      if (capture.detected && capture.receipt) {
        learningCapture = {
          kind: capture.kind ?? "directive",
          tier: capture.tier,
          pendingId: capture.pendingId,
          writtenId: capture.writtenId,
          receipt: capture.receipt
        };
        writeAudit("chat.coach_learning", {
          userId,
          turnKey,
          kind: capture.kind,
          tier: capture.tier,
          pendingId: capture.pendingId,
          writtenId: capture.writtenId,
          url: capture.url ?? null,
          dropped: capture.dropped
        });
      }
    } catch (e) {
      console.warn("[orchestrator] coach learning capture failed:", e);
    }
    // Extract learned-context candidates from the message for both the write path (ingest) and
    // the read path (retrieve facts already in store to inject into the system prompt).
    // extractLearnedCandidatesLLM is regex (extractLearnedCandidates) unless LLM_SALIENCE_EXTRACTOR=on
    // AND a credential resolves for this user — falls back to regex on any LLM-path failure, and
    // validates any LLM-proposed symbol against the real known-ticker universe (see salience-llm.ts).
    const learnedCandidates = await extractLearnedCandidatesLLM(message, userId);
    assertTurnActive();
    // Fire-and-forget write path: the semantic classifier runs 3+ sequential LLM calls — awaiting
    // it on the hot path would add 1–3 s of latency to every chat turn. Errors are benign: advisory
    // writes, never critical. The chat hard-cap (risk-adjacent prose is DROPPED) holds inside
    // ingestLearned regardless.
    for (const candidate of learnedCandidates) {
      ingestLearned(userId, candidate, "chat", { writeEpoch }).catch((e) => {
        console.warn("[orchestrator] learned-context ingest failed:", e);
      });
    }
    // Read path: inject already-stored facts for symbols mentioned in this message so the model
    // sees prior advisory context it (or the strategy loop) has learned.
    const learnedSymbols = learnedCandidates.map((c) => c.symbol).filter((s): s is string => s != null);
    const learnedFacts = learnedSymbols.length > 0
      ? retrieveLearnedContext(userId, learnedSymbols, undefined, {
          connectedAccountId
        })
      : [];
    const memories = retrieve(userId);
    const contextContainment: Array<{ path: string; result: PromptContainmentResult }> = [];
    const memorySummary = memories
      .map((m, index) =>
        containPromptData(
          `- ${m.hard ? "[HARD] " : ""}${m.subject}: ${m.value}`,
          "learned",
          `memory[${index}]`,
          contextContainment
        )
      )
      .join("\n");
    const learnedContextSummary = learnedFacts
      .map((fact, index) => containPromptData(fact, "learned", `learned[${index}]`, contextContainment))
      .join("\n");
    const contextRefs = [
      createEvidenceRef({
        kind: "chat-memory",
        subject: connectedAccountId ?? userId,
        source: {
          family: "learning",
          name: "salience-memory",
          status: memorySummary ? "success" : "no_data",
          observedAt: null,
          asOf: null,
          retrievedAt: new Date().toISOString(),
          provenance: { provider: "chat-memory", locator: connectedAccountId ?? null, upstreamHash: null, lineage: ["memory-store"] }
        },
        content: memorySummary
      }),
      createEvidenceRef({
        kind: "chat-learned-context",
        subject: connectedAccountId ?? userId,
        source: {
          family: "learning",
          name: "relational-learning",
          status: learnedContextSummary ? "success" : "no_data",
          observedAt: null,
          asOf: null,
          retrievedAt: new Date().toISOString(),
          provenance: { provider: "learned-context", locator: connectedAccountId ?? null, upstreamHash: null, lineage: ["account-scoped-learning"] }
        },
        content: learnedContextSummary
      })
    ];
    const contextBudget = applyEvidenceBudget(
      [
        { ref: contextRefs[0]!, text: memorySummary, priority: 100 },
        { ref: contextRefs[1]!, text: learnedContextSummary, priority: 90 }
      ],
      { maxCharacters: 12_000, maxTokenEstimate: 3_000, familyQuotas: { learning: { maxCharacters: 12_000, maxTokenEstimate: 3_000 } } }
    );
    const boundedById = new Map(contextBudget.included.map((item) => [item.evidenceId, item.text]));
    const boundedMemory = boundedById.get(contextRefs[0]!.id) ?? "";
    const boundedLearned = boundedById.get(contextRefs[1]!.id) ?? "";
    const contextPack = createEvidencePack({ decisionKey: turnKey, evidence: contextRefs });
    const contextManifest = {
      contractVersion: contextPack.contractVersion,
      packHash: contextPack.packHash,
      refs: contextPack.evidence.map((ref) => ({
        id: ref.id,
        contentHash: ref.contentHash,
        kind: ref.kind,
        source: ref.source.name,
        status: ref.source.status
      }))
    };
    writeAudit(
      "chat.evidence_pack",
      {
        turnKey,
        ...contextManifest,
        budget: {
          usedCharacters: contextBudget.usedCharacters,
          usedTokenEstimate: contextBudget.usedTokenEstimate,
          receipts: contextBudget.receipts.filter((receipt) => receipt.originalCharacters > 0)
        },
        containment: contextContainment.map(({ path, result }) => ({
          path,
          status: result.status,
          patterns: result.findings.map((finding) => finding.pattern)
        }))
      }
    );

    // The only path to a tool — it has no execution capability.
    const executeTool = async (name: string, input: unknown) => {
      const tool = tools[name];
      if (!tool) return { error: "UNKNOWN_TOOL", name };
      assertTurnActive();
      writeAudit("tool.call", { userId, tool: name, turnKey });
      const raw = await tool.execute(input, { userId, deps: turnDeps });
      assertTurnActive();
      const containment: Array<{ path: string; result: PromptContainmentResult }> = [];
      const source: PromptTextSource = name === "kb_search" ? "rag" : "unknown";
      let sanitized = containPromptData(raw, source, `tool.${name}`, containment);
      const kbChunks = (value: unknown): Array<Record<string, unknown>> => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return [];
        const chunks = (value as Record<string, unknown>).chunks;
        return Array.isArray(chunks)
          ? chunks.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
          : [];
      };
      if (name === "kb_search" && kbChunks(sanitized).length > 0) {
        const exactFmp = fmpTranscriptDerivedProvenance(kbChunks(sanitized));
        if (exactFmp.length > 0) {
          let generationActive = Boolean(fmpRightsClaim);
          if (fmpRightsClaim) {
            try {
              assertFmpTranscriptRightsGeneration(fmpRightsClaim);
            } catch {
              generationActive = false;
            }
          }
          if (!generationActive) {
            // Retrieval may have started just before revocation. Do not expose licensed chunks to
            // the model once the durable generation is stale. EarningsCalls.dev-sourced transcript
            // rows share the doc type but are gated by their OWN predicate (key + kill-switch,
            // already enforced by vector-db's post-fetch guard) — a stale FMP generation must not
            // collaterally strip them.
            const safeChunks = kbChunks(sanitized).filter((row) => {
              if (row.source === EARNINGSCALLS_TRANSCRIPT_SOURCE) return earningsCallsTranscriptsEnabled();
              if (row.source === ROIC_TRANSCRIPT_SOURCE) return roicTranscriptsEnabled();
              return row.source !== FMP_TRANSCRIPT_SOURCE &&
                String(row.doc_type ?? "").toLowerCase() !== FMP_TRANSCRIPT_DOC_TYPE;
            });
            sanitized = { ...(sanitized as Record<string, unknown>), chunks: safeChunks };
          } else {
            rememberFmpProvenance(exactFmp);
          }
        }
      }
      const failed = Boolean(
        sanitized && typeof sanitized === "object" && !Array.isArray(sanitized) && "error" in sanitized
      );
      const retrievedAt = new Date().toISOString();
      const ref = createEvidenceRef({
        kind: `chat-tool-result:${name}`,
        subject: connectedAccountId ?? userId,
        source: {
          family: toolEvidenceFamily(name),
          name,
          status: failed ? "failed" : "success",
          observedAt: null,
          asOf: null,
          retrievedAt,
          provenance: { provider: "chat-tool", locator: name, upstreamHash: null, lineage: ["chat", "tool-loop"] }
        },
        content: JSON.stringify(sanitized)
      });
      const pack = createEvidencePack({ decisionKey: `${turnKey}:tool:${name}:${retrievedAt}`, evidence: [ref] });
      // This proves only that KB rows were serialized into a tool result. The chat transport may
      // still stop at MAX_STEPS or fail before a subsequent provider request includes that result,
      // so do not call this model consumption. The audit stays identifier/count-only.
      const ragToolResultAssembly = name === "kb_search" && kbChunks(sanitized).length > 0
        ? derivePromptRagConsumption(
            kbChunks(sanitized).flatMap((row) => {
              const text = typeof row.text === "string" ? row.text : "";
              const symbol = typeof row.symbol === "string" ? row.symbol : "CHAT";
              return text
                ? [{
                    ...(typeof row.chunk_id === "string" ? { chunkId: row.chunk_id } : {}),
                    symbol,
                    ...(typeof row.source === "string" ? { source: row.source } : {}),
                    ...(typeof row.doc_type === "string" ? { docType: row.doc_type } : {}),
                    ...(typeof row.section === "string" ? { title: row.section } : {}),
                    ...(typeof row.url === "string" ? { url: row.url } : {}),
                    ...(typeof row.as_of === "string" ? { publishedAt: row.as_of } : {}),
                    ...(typeof row.score === "number" ? { score: row.score } : {}),
                    text,
                    serializedText: text
                  }]
                : [];
            }),
            kbChunks(sanitized).flatMap((row) => typeof row.text === "string"
              ? [row.text]
              : []),
            { retrievalAttempted: true }
          )
        : undefined;
      writeAudit(
        "chat.tool_evidence_pack",
        {
          turnKey,
          tool: name,
          packHash: pack.packHash,
          ref: { id: ref.id, contentHash: ref.contentHash, family: ref.source.family, status: ref.source.status },
          ...(ragToolResultAssembly
            ? {
                ragToolResultAssembly: {
                  outcome: "assembled",
                  retrievedCandidateCount: ragToolResultAssembly.retrievedCandidateCount,
                  uniqueCandidateCount: ragToolResultAssembly.uniqueCandidateCount,
                  duplicateCandidateCount: ragToolResultAssembly.duplicateCandidateCount,
                  retrievalFailureCount: ragToolResultAssembly.retrievalFailureCount,
                  serialized: ragToolResultAssembly.consumed,
                  omitted: ragToolResultAssembly.retrievedButNotConsumed
                }
              }
            : {}),
          containment: containment.map(({ path, result }) => ({
            path,
            status: result.status,
            patterns: result.findings.map((finding) => finding.pattern)
          }))
        }
      );
      return sanitized;
    };

    assertTurnActive();
    const result = await model.run({
      system: buildSystem(boundedMemory, boundedLearned, {
        manifest: contextManifest,
        budgetReceipts: contextBudget.receipts.filter((receipt) => receipt.originalCharacters > 0)
      }),
      message,
      tools: toolSchemas,
      executeTool,
      context: { memorySummary: boundedMemory },
      history,
      abortSignal: args.abortSignal,
      deadlineMs: args.deadlineMs,
      minStageBudgetMs: args.minStageBudgetMs ?? policy.tuning?.chatStageMinBudgetMs,
      onStage: (stage) => {
        args.onStage?.(stage);
        emitDashboardEvent({
          type: "chat-turn",
          userId,
          at: new Date().toISOString(),
          detail: { turnKey, ...stage }
        });
      }
    });
    assertTurnActive();
    rememberFmpProvenance(result.citations ?? []);
    if (fmpProvenance.length > 0) {
      if (!fmpRightsClaim) throw new Error("FMP-derived chat result has no active rights generation.");
      assertFmpTranscriptRightsGeneration(fmpRightsClaim);
    }

    // Server-side disclaimer guarantee (provider-independent): the system prompt asks for it, but we
    // never rely on the model to remember it — append if missing so compliance holds on every provider.
    let text = result.text.includes(DISCLAIMER) ? result.text : `${result.text}\n\n${DISCLAIMER}`;
    // Prepend an honest durable-learning receipt when coach capture fired (before the disclaimer).
    if (learningCapture?.receipt) {
      const body = text.includes(DISCLAIMER)
        ? text.slice(0, text.lastIndexOf(DISCLAIMER)).trimEnd()
        : text.trimEnd();
      const disclaimer = text.includes(DISCLAIMER) ? `\n\n${DISCLAIMER}` : "";
      text = `${learningCapture.receipt}\n\n${body}${disclaimer}`;
    }

    // Extract a draft (if any) for the UI; the assistant never executes.
    const draftCall = result.toolCalls?.find((c) => c.name === "draft_order" && c.result && !c.result.error);
    const draft = (draftCall?.result as ChatDraft) ?? null;

    const usedModel = model.modelName;
    const reply: ChatReply = {
      text,
      draft,
      citations: result.citations ?? [],
      usedMemories: memories.map((m) => ({ subject: m.subject, value: m.value, hard: m.hard })),
      memory: { written: mem.written.length, held: mem.held.length },
      intent: classifyIntent(message).intent,
      promptVersion: PROMPT_VERSION,
      model: usedModel,
      learningCapture
    };
    const persistAssistantTurn = () => appendTurn(userId, {
      role: "assistant",
      text: reply.text,
      citations: reply.citations.map((c) => c.chunk_id ?? c.source),
      intent: reply.intent,
      model: usedModel,
      connectedAccountId
    }, writeEpoch);
    if (fmpProvenance.length > 0 && fmpRightsClaim) {
      persistFmpTranscriptDerivedArtifact({
        claim: fmpRightsClaim,
        artifactType: "chat-turn",
        artifactId: (turn) => turn.id,
        userId,
        provenance: fmpProvenance,
        write: persistAssistantTurn
      });
      runWithUserWriteEpoch(userId, writeEpoch, () => recordFmpTranscriptDerivedAudit({
        claim: fmpRightsClaim,
        kind: "chat.reply",
        payload: { userId, turnKey, has_draft: !!draft, citations: reply.citations.length },
        userId,
        connectedAccountId,
        provenance: fmpProvenance
      }));
    } else {
      persistAssistantTurn();
      writeAudit("chat.reply", { userId, turnKey, has_draft: !!draft, citations: reply.citations.length });
    }
    return reply;
    });
  };
}

/** Production tool wiring to the canonical private subsystems (broker quotes, RAG, alerts, watchlist). */
export function buildProductionDeps(): ToolDeps {
  return {
    async getQuote(symbol, userId): Promise<ChatQuote> {
      const fallback: ChatQuote = { symbol, price_usd: 0, as_of: "", source: "none" };
      try {
        const policy = getPolicy(userId);
        let price: number | undefined;
        let asOf: string | undefined;
        let source: string | undefined;
        // 1) Account-aware broker quote, when an account is selected. Its own try/catch so a broker
        // failure (auth, data plan, network) FALLS THROUGH to the market-data fallback below instead
        // of aborting the whole quote.
        if (policy.accountNumber) {
          try {
            const quotes = await getBrokerGateway(policy, userId).getEquityQuotes(policy.accountNumber, [symbol]);
            const q = quotes[symbol];
            if (q && typeof q.price === "number" && q.price > 0) {
              price = q.price;
              asOf = q.asOf;
              source = q.provider ?? "broker";
            }
          } catch {
            /* fall through to the keyless market-data fallback */
          }
        }
        // 2) Live market-data quote (Yahoo regularMarketPrice + its real timestamp). Preferred over the
        // daily-bar close so the "as of" reflects today's price, not the last completed daily bar
        // (which is often yesterday until the current session's bar posts).
        if (price == null) {
          const yq = await fetchYahooFinanceQuote(symbol);
          if (yq && yq.price > 0) {
            price = yq.price;
            asOf = yq.asOf;
            source = "yahoo-finance";
          }
        }
        // 3) Daily-close fallback (recent close) — last resort when no live quote is available. Works
        // with NO account selected too, so "what's X at" still gets answered instead of NO_QUOTE.
        if (price == null) {
          const bars = await fetchDailyOHLC(symbol, Date.now(), userId);
          const last = bars && bars.length ? bars[bars.length - 1] : undefined;
          if (last && typeof last.close === "number" && last.close > 0) {
            price = last.close;
            asOf = last.time != null ? String(last.time) : undefined;
            source = "yahoo-finance-delayed";
          }
        }
        if (price == null) return { ...fallback, error: "NO_QUOTE" };
        return { symbol, price_usd: price, as_of: asOf ?? new Date().toISOString(), source: source ?? "delayed" };
      } catch {
        return { ...fallback, error: "QUOTE_FAILED" };
      }
    },
    async searchKnowledge(args, userId) {
      const symbol = args.ticker ? canonicalTicker(args.ticker) : "";
      if (!symbol) return [];
      // Forward ALL retrieval options: as-of (point-in-time), the doc_type the intent classifier extracted
      // (previously dropped here), and the relevance floor. docType matching is casing-tolerant downstream.
      const options: RetrieveOptions = {
        // Live chat used to omit asOf, which made VECTOR_ASOF_STRICT a no-op.  Question
        // date wins when the tool supplies a parseable as_of; otherwise "now".
        asOf: resolveRetrievalAsOf(args.as_of),
        ...(args.doc_type ? { docType: [args.doc_type] } : {}),
        minScore: defaultMinScore(),
        // 2026-07-04 RAG quick-wins: wire the previously-dormant post-rerank relevance floor +
        // near-duplicate suppression (both existed since 2026-07-01 but no caller passed them).
        minRelevanceScore: defaultRelevanceFloor(),
        dedupeSimilarity: defaultDedupeSimilarity()
      };
      const chunks = await retrieveContextDetailed(args.query, symbol, args.k ?? 5, userId, options);
      // Real provenance — chunk_id is the actual vector id; as_of is the chunk's own date (not the query's).
      // R13 (2026-07-01 RAG backlog): additive doc_type/section/url provenance keys + an optional
      // advisory isStale label (RAG_CITATION_STALENESS, default off). Backend/payload only — no UI
      // consumes these yet; a parallel dashboard-redesign thread owns any citation rendering.
      const staleness = citationStalenessEnabled();
      return chunks.map((c) => ({
        chunk_id: c.id,
        evidence_ref: stableRagEvidenceRef({
          ...(c.id ? { chunkId: c.id } : {}),
          symbol,
          ...(c.source ? { source: c.source } : {}),
          ...(c.doc_type ? { docType: c.doc_type } : {}),
          ...(typeof c.metadata?.accession === "string" ? { accession: c.metadata.accession } : {}),
          ...(c.section ? { section: c.section, title: c.section } : {}),
          ...(typeof c.metadata?.chunk_ordinal === "number"
            ? { ordinal: c.metadata.chunk_ordinal }
            : typeof c.metadata?.ordinal === "number"
              ? { ordinal: c.metadata.ordinal }
              : {}),
          ...(typeof c.metadata?.content_hash === "string" ? { contentHash: c.metadata.content_hash } : {}),
          ...(typeof c.metadata?.vector_namespace === "string" ? { vectorNamespace: c.metadata.vector_namespace } : {}),
          ...(c.scope ? { scope: c.scope } : {}),
          ...(typeof c.metadata?.tenant_scope === "string" ? { tenantScope: c.metadata.tenant_scope } : {}),
          ...(c.url ? { url: c.url } : {}),
          ...(c.as_of ? { publishedAt: c.as_of } : {}),
          ...(typeof c.score === "number" ? { score: c.score } : {}),
          ...(typeof c.relevanceScore === "number" ? { relevanceScore: c.relevanceScore } : {})
        }),
        text: c.text,
        source: c.source ?? "kb",
        as_of: c.as_of,
        score: c.score,
        url: c.url,
        doc_type: c.doc_type,
        section: c.section,
        ...(staleness ? { isStale: isStale(c.as_of, c.doc_type) } : {})
      }));
    },
    createAlert(userId, input) {
      const result = alertsCreateAlert(userId, input);
      if ("error" in result) return result;
      return { symbol: result.symbol, op: result.op, price: result.price };
    },
    watchlistAdd(userId, symbol) {
      try {
        return { ok: true, item: addToWatchlist(userId, symbol) };
      } catch (e) {
        return { error: e instanceof Error ? e.message : "WATCHLIST_FAILED" };
      }
    },
    async getPositions(userId) {
      const policy = getPolicy(userId);
      if (!policy.accountNumber) return [];
      try {
        return await getBrokerGateway(policy, userId).getEquityPositions(policy.accountNumber);
      } catch {
        return [];
      }
    },
    async getPortfolio(userId) {
      const policy = getPolicy(userId);
      if (!policy.accountNumber) return null;
      try {
        return await getBrokerGateway(policy, userId).getPortfolio(policy.accountNumber);
      } catch {
        return null;
      }
    },
    listWatchlist(userId) {
      return wlList(userId);
    },
    listAlerts(userId) {
      return alertsListAlerts(userId, "armed");
    },
    listOpenProposals(userId) {
      const policy = getPolicy(userId);
      if (!policy.accountNumber) return [];
      return listPendingProposals(policy.accountNumber, userId);
    },
    async getFundamentals(symbol, userId) {
      try {
        const provider = getEnrichmentProvider(userId);
        const map = await provider.enrich([symbol]);
        const res = map[symbol];
        if (!res) return { error: "NO_FUNDAMENTALS" };
        return res;
      } catch (e) {
        return { error: "FAILED", message: e instanceof Error ? e.message : String(e) };
      }
    },
    async getMarketSignals(userId) {
      try {
        return await getMarketSignals(userId);
      } catch (e) {
        return { error: "FAILED", message: e instanceof Error ? e.message : String(e) };
      }
    },
    async getPortfolioPnl(userId) {
      const policy = getPolicy(userId);
      if (!policy.accountNumber) return null;
      try {
        // Derive current prices from open positions (marketValue / quantity) so unrealized P&L is real,
        // without spending extra quote calls.
        const positions = await getBrokerGateway(policy, userId).getEquityPositions(policy.accountNumber);
        const currentPrices: Record<string, number> = {};
        for (const p of positions) {
          if (p.quantity !== 0 && Number.isFinite(p.marketValue) && Number.isFinite(p.quantity)) {
            currentPrices[p.symbol] = p.marketValue / p.quantity;
          }
        }
        const s = getPerformanceSummary(policy.accountNumber, currentPrices, userId);
        return {
          liveRealizedPnl: s.liveRealizedPnl,
          paperRealizedPnl: s.paperRealizedPnl,
          liveUnrealizedPnl: s.liveUnrealizedPnl,
          paperUnrealizedPnl: s.paperUnrealizedPnl,
          liveWinRate: s.liveWinRate,
          paperWinRate: s.paperWinRate
        };
      } catch {
        return null;
      }
    },
    getPerformanceSummary(userId) {
      const policy = getPolicy(userId);
      if (!policy.accountNumber) return null;
      const byThesis = getThesisScorecard(policy.accountNumber, undefined, {}, userId).map((r) => ({
        key: r.thesisTag,
        trades: r.trades,
        winRate: r.winRate,
        avgReturnPct: r.avgReturnPct,
        totalPnl: r.totalPnl
      }));
      const byRegime = getRegimeScorecard(policy.accountNumber, undefined, {}, userId).map((r) => ({
        key: r.regime,
        trades: r.trades,
        winRate: r.winRate,
        avgReturnPct: r.avgReturnPct,
        totalPnl: r.totalPnl
      }));
      return { byThesis, byRegime };
    },
    getReflection(userId) {
      // Reflections are keyed per broker account now (with the legacy shared row as a
      // transitional fallback inside getReflectionSummary); chat answers from the ACTIVE
      // account's perspective, matching every other account-scoped chat tool here.
      return getReflectionSummary(userId, getPolicy(userId).accountNumber || undefined);
    },
    // Robinhood MCP-backed read-only research. Each returns a clear "not connected" result (never a
    // thrown error) when the adapter is off or the user has no stored token, so chat degrades to a
    // plain message instead of failing the turn. Purely discovery — none of these can place an order.
    async getEarningsCalendar(userId, args) {
      const notConnected = await robinhoodNotConnected(userId);
      if (notConnected) return notConnected;
      try {
        const raw = await callRobinhoodMcpTool(userId, "get_earnings_calendar", {
          ...(args.start_date ? { start_date: args.start_date } : {}),
          ...(args.days != null ? { days: args.days } : {}),
          ...(args.high_market_cap ? { filter: "high_market_cap" } : {})
        });
        return { earnings: raw };
      } catch (e) {
        return { error: "FAILED", message: e instanceof Error ? e.message : String(e) };
      }
    },
    async getOptionChain(userId, underlyingSymbol) {
      const notConnected = await robinhoodNotConnected(userId);
      if (notConnected) return notConnected;
      try {
        const raw = await callRobinhoodMcpTool(userId, "get_option_chains", { underlying_symbol: underlyingSymbol });
        return { symbol: underlyingSymbol, chains: raw };
      } catch (e) {
        return { error: "FAILED", message: e instanceof Error ? e.message : String(e) };
      }
    },
    async searchInstrument(userId, args) {
      const notConnected = await robinhoodNotConnected(userId);
      if (notConnected) return notConnected;
      try {
        const raw = await callRobinhoodMcpTool(userId, "search", {
          query: args.query,
          ...(args.asset_type ? { asset_type: args.asset_type } : {}),
          ...(args.limit != null ? { limit: args.limit } : {})
        });
        return { results: raw };
      } catch (e) {
        return { error: "FAILED", message: e instanceof Error ? e.message : String(e) };
      }
    },
    accountLabel: "Test (local)"
  };
}

// A "not connected" result (not a throw) when Robinhood MCP data is disabled or the user has no
// stored token — so the research tools return a plain message the model can relay to the user.
async function robinhoodNotConnected(userId: string): Promise<{ error: string; message: string } | null> {
  if (!robinhoodMcpDataEnabled()) {
    return { error: "NOT_CONNECTED", message: "Robinhood is not connected. Connect your Robinhood agentic account in Connections to enable this." };
  }
  const token = await getMcpAccessToken(userId);
  if (!token) {
    return { error: "NOT_CONNECTED", message: "Robinhood is not connected. Connect your Robinhood agentic account in Connections to enable this." };
  }
  return null;
}
