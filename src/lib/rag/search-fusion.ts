import { getDb, resolveApiKey } from "../db";
import { siliconflowBaseUrl } from "../siliconflow-base";
import { retrieveContextDetailed, getClients } from "../vector-db";
import { applyOpenRouterClassifierEnrichment } from "../llm-call";
import { providerRequestIdFromPayload } from "../llm-usage";
import { meterEmbed } from "../rag-metering";
import { deconstructQuery } from "./query-deconstruct";
import { routeRetrievalIntent } from "./intent-router";
import { hashContent } from "./chunk";
import crypto from "crypto";

export interface FusionResult {
  content_hash: string;
  chunk_id: string;
  symbol: string;
  source: string;
  accession: string;
  text: string;
  score: number;
}

function getHash(text: string): string {
  return hashContent(text);
}

function getJaccardSimilarity(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().split(/\s+/));
  const wordsB = new Set(b.toLowerCase().split(/\s+/));
  const intersection = new Set([...wordsA].filter(x => wordsB.has(x)));
  const union = new Set([...wordsA, ...wordsB]);
  return union.size === 0 ? 0 : intersection.size / union.size;
}

/**
 * Embed texts through the same BAAI/bge-m3 HTTP path as vector-db (OpenRouter preferred,
 * SiliconFlow fallback). Precedence matches `activeEmbeddingProvider` so search-fusion MMR
 * never diverges into a second embedding space when both keys exist.
 * Returns `null` when neither is configured — caller uses Jaccard MMR fallback.
 * (Exported for the usage-compliance test suite; production callers stay module-internal.)
 */
export async function fetchAlternativeEmbedding(texts: string[], userId: string = "local"): Promise<number[][] | null> {
  const openrouterKey = resolveApiKey("openrouter", userId);
  const siliconflowKey = resolveApiKey("siliconflow", userId);
  // Match vector-db resolveActiveRagProvider: OpenRouter first, then SiliconFlow.
  const useOpenRouter = !!openrouterKey && !openrouterKey.startsWith("mock");
  const useSiliconFlow = !useOpenRouter && !!siliconflowKey && !siliconflowKey.startsWith("mock");
  if (!useSiliconFlow && !useOpenRouter) return null;

  const url = useSiliconFlow ? `${siliconflowBaseUrl()}/v1/embeddings` : "https://openrouter.ai/api/v1/embeddings";
  const model = useSiliconFlow ? "BAAI/bge-m3" : "baai/bge-m3";
  const apiKey = useSiliconFlow ? siliconflowKey : openrouterKey;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${apiKey}`
  };
  const body: Record<string, unknown> = { model, input: texts };
  if (!useSiliconFlow) {
    // OpenRouter attribution headers + classifier enrichment (user + flat trace), same as the
    // vector-db.ts OpenRouter embed path. Enrichment never breaks the call — see
    // applyOpenRouterClassifierEnrichment. SiliconFlow bypasses OpenRouter, so its classifier
    // context flows only via the pushed telemetry event (meterEmbed below).
    headers["HTTP-Referer"] = "https://socratictrade.com";
    headers["X-Title"] = "Socratic-Trade";
    applyOpenRouterClassifierEnrichment(body, { userId, service: "rag", feature: "search-fusion-mmr" });
  }
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    throw new Error(`Alternative embedding failed in search fusion (${useSiliconFlow ? "siliconflow" : "openrouter"}): ${response.status}`);
  }
  const res = await response.json();
  // Meter this paid embed call (usage-compliance WS1 gap #3), mirroring vector-db.ts's
  // meterEmbed call sites; the OpenRouter generation id rides along for monitor-side verification.
  meterEmbed(
    texts,
    model,
    userId,
    useSiliconFlow ? "siliconflow" : "openrouter",
    useSiliconFlow ? undefined : providerRequestIdFromPayload("openrouter", res)
  );
  return res.data.map((d: any) => d.embedding);
}

/**
 * Marks a FusionResult[] as having recalled without dense (vector) matches from at least one
 * sub-query because the embed/lookup itself failed — not because the corpus genuinely had no
 * semantic match. `retrieveFusedContext` proceeds lexical-only on this condition (see the P1
 * fix below) rather than hard-failing the whole hybrid query, but callers that care about
 * silent quality loss can check this instead of treating every result as equally trustworthy.
 */
export function wasDenseRecallDegraded(results: FusionResult[]): boolean {
  return Boolean((results as unknown as { __denseRecallDegraded?: boolean })?.__denseRecallDegraded);
}

function markDenseRecallDegraded<T extends FusionResult[]>(results: T): T {
  try {
    Object.defineProperty(results, "__denseRecallDegraded", {
      value: true,
      enumerable: false,
      configurable: true
    });
  } catch {
    // best-effort marker only — must never break retrieval
  }
  return results;
}

export async function retrieveFusedContext(
  query: string,
  symbol: string,
  limit: number = 5,
  userId: string = "local",
  options?: any
): Promise<FusionResult[]> {
  const db = getDb();
  const asOf = options?.asOf || options?.acceptance_datetime || null;

  // 1. Query Deconstruction / Expansion
  const subQueries = await deconstructQuery(query, userId);
  const k = 60;
  const scoreMap = new Map<string, number>();
  const chunkDetails = new Map<string, { content_hash: string; accession: string; symbol: string; source: string; text: string }>();

  // P1 fix (2026-09-07): a query-embed 400/429/connection failure used to return an empty
  // `vectorResults` array indistinguishable from "the corpus genuinely has no semantic match" —
  // this loop swallowed the failure into a bare console.warn and the fused result silently
  // proceeded lexical-only with no signal anywhere. Track it explicitly so we can fail loudly
  // (structured log, real telemetry) and mark the returned pool as degraded instead.
  let denseRecallDegraded = false;
  const denseRecallDegradedReasons = new Set<string>();
  // P2 fix (2026-09-07): `budget_skipped` means the caller deliberately reached its configured
  // RAG budget — retrieveContextDetailed never attempted an embed call, so it is not a
  // provider/lookup failure. It still counts toward `denseRecallDegraded` (dense recall genuinely
  // did not run, so wasDenseRecallDegraded() must say so) but must NOT feed the error-level
  // Sentry log or the embed.failed metric below: a persistently exhausted daily budget would
  // otherwise flood Sentry and falsely inflate provider-failure metrics on every fused retrieval,
  // even though no provider call ever failed. Only genuine failures ("lookup_failed", "threw")
  // are reportable.
  const reportableDegradationReasons = new Set<string>();
  const reportDenseRecallDegradation = (): void => {
    if (reportableDegradationReasons.size === 0) return;
    void import("../sentry-metrics").then(({ logError, recordEmbedFailure }) => {
      recordEmbedFailure("search-fusion", "dense-recall-degraded");
      logError("rag.dense_recall_degraded", {
        symbol,
        reasons: Array.from(reportableDegradationReasons).join(",") || "unknown",
        userId
      });
    }).catch(() => {
      // Observability must never affect retrieval control flow.
    });
  };

  // Process each sub-query
  for (const subQuery of subQueries) {
    // 2. Intent Routing for this sub-query
    const intent = routeRetrievalIntent(subQuery);

    let lexicalRows: any[] = [];
    if (intent === "lexical" || intent === "hybrid") {
      const cleanKeywords = subQuery
        .trim()
        .split(/\s+/)
        .map(w => `"${w.replace(/"/g, '""')}"`)
        .join(" OR ");

      try {
        // FTS5 bm25() returns SMALLER scores for better matches, so rank ascending before the
        // LIMIT — otherwise SQLite returns rows in unspecified/insertion order and RRF assigns
        // lexical ranks (and drops rows past 100) arbitrarily. The asOf variant groups (instead
        // of DISTINCT) so the aggregate MIN(bm25) rank is usable in ORDER BY.
        if (asOf) {
          lexicalRows = db.prepare(`
            SELECT f.content_hash, f.symbol, f.source, o.accession, f.text, MIN(bm25(document_chunks_fts)) AS rank
            FROM document_chunks_fts f
            JOIN chunk_occurrences o ON f.content_hash = o.content_hash AND f.symbol = o.symbol AND f.source = o.source
            WHERE f.symbol = ? AND f.text MATCH ? AND o.accepted_at <= ?
            GROUP BY f.content_hash, f.symbol, f.source, o.accession, f.text
            ORDER BY rank ASC
            LIMIT 100
          `).all(symbol, cleanKeywords, String(asOf));
        } else {
          lexicalRows = db.prepare(`
            SELECT content_hash, symbol, source, accession, text
            FROM document_chunks_fts
            WHERE symbol = ? AND text MATCH ?
            ORDER BY bm25(document_chunks_fts) ASC
            LIMIT 100
          `).all(symbol, cleanKeywords);
        }
      } catch (err) {
        try {
          if (asOf) {
            lexicalRows = db.prepare(`
              SELECT DISTINCT f.content_hash, f.symbol, f.source, o.accession, f.text
              FROM document_chunks_fts f
              JOIN chunk_occurrences o ON f.content_hash = o.content_hash AND f.symbol = o.symbol AND f.source = o.source
              WHERE f.symbol = ? AND f.text LIKE ? AND o.accepted_at <= ?
              LIMIT 100
            `).all(symbol, `%${subQuery}%`, String(asOf));
          } else {
            lexicalRows = db.prepare(`
              SELECT content_hash, symbol, source, accession, text
              FROM document_chunks_fts
              WHERE symbol = ? AND text LIKE ?
              LIMIT 100
            `).all(symbol, `%${subQuery}%`);
          }
        } catch (innerErr) {
          // ignore
        }
      }
    }

    let vectorResults: any[] = [];
    if (intent === "semantic" || intent === "hybrid") {
      const callerOnStatus = options?.onStatus;
      try {
        vectorResults = await retrieveContextDetailed(subQuery, symbol, 100, userId, {
          ...options,
          onStatus: (status: string) => {
            // "lookup_failed" (missing keys or a caught embed/provider error) and
            // "budget_skipped" both mean dense recall did NOT run for this sub-query — distinct
            // from "no_memory" (it ran cleanly and found nothing). Only those two make this
            // sub-query's empty vectorResults a degradation rather than a genuine empty corpus.
            if (status === "lookup_failed" || status === "budget_skipped") {
              denseRecallDegraded = true;
              denseRecallDegradedReasons.add(status);
              if (status === "lookup_failed") reportableDegradationReasons.add(status);
            }
            callerOnStatus?.(status);
          }
        });
      } catch (err) {
        denseRecallDegraded = true;
        denseRecallDegradedReasons.add("threw");
        reportableDegradationReasons.add("threw");
        console.warn("[search-fusion] Vector search failed (non-fatal):", err instanceof Error ? err.message : String(err));
      }
    }

    // Resolve content hash and accession for vector matches
    const vectorIds = vectorResults.map(r => r.id);
    const occurrenceMap = new Map<string, { content_hash: string; accession: string }>();

    if (vectorIds.length > 0) {
      const placeholders = vectorIds.map(() => "?").join(",");
      const occurrences = db.prepare(`
        SELECT vector_id, content_hash, accession
        FROM chunk_occurrences
        WHERE vector_id IN (${placeholders})
      `).all(...vectorIds) as any[];

      for (const o of occurrences) {
        occurrenceMap.set(o.vector_id, { content_hash: o.content_hash, accession: o.accession });
      }
    }

    // Accumulate RRF scores for lexical match rankings
    lexicalRows.forEach((row, index) => {
      const currentScore = scoreMap.get(row.content_hash) || 0;
      scoreMap.set(row.content_hash, currentScore + 1 / (k + index + 1));
      if (!chunkDetails.has(row.content_hash)) {
        chunkDetails.set(row.content_hash, {
          content_hash: row.content_hash,
          accession: row.accession,
          symbol: row.symbol,
          source: row.source,
          text: row.text
        });
      }
    });

    // Accumulate RRF scores for vector match rankings
    vectorResults.forEach((r, index) => {
      const hashAndAcc = occurrenceMap.get(r.id) || { content_hash: getHash(r.text), accession: "" };
      const currentScore = scoreMap.get(hashAndAcc.content_hash) || 0;
      scoreMap.set(hashAndAcc.content_hash, currentScore + 1 / (k + index + 1));
      if (!chunkDetails.has(hashAndAcc.content_hash)) {
        chunkDetails.set(hashAndAcc.content_hash, {
          content_hash: hashAndAcc.content_hash,
          accession: hashAndAcc.accession,
          symbol,
          source: r.source || "sec-edgar",
          text: r.text
        });
      }
    });
  }

  const rawCandidates = Array.from(scoreMap.entries())
    .map(([hash, score]) => ({
      ...chunkDetails.get(hash)!,
      score
    }));

  if (rawCandidates.length === 0) {
    reportDenseRecallDegradation();
    return denseRecallDegraded ? markDenseRecallDegraded([]) : [];
  }

  // Batch query to resolve chunk_ids for all unique content_hashes in rawCandidates
  const hashes = rawCandidates.map(c => c.content_hash);
  const placeholders = hashes.map(() => "?").join(",");
  const chunkRows = db.prepare(`
    SELECT content_hash, chunk_id
    FROM document_chunks
    WHERE content_hash IN (${placeholders})
  `).all(...hashes) as any[];

  const chunkIdMap = new Map<string, string>();
  for (const row of chunkRows) {
    chunkIdMap.set(row.content_hash, row.chunk_id);
  }

  // 3. Self-Measurement Feedback Loop (Retrieve stats and boost wins)
  const accessions = Array.from(new Set(rawCandidates.map(c => c.accession).filter(Boolean)));
  const boostMap = new Map<string, number>();

  if (accessions.length > 0) {
    try {
      const accPlaceholders = accessions.map(() => "?").join(",");
      const stats = db.prepare(`
        SELECT doc_id, SUM(wins) as wins, SUM(losses) as losses
        FROM retrieval_usefulness_stats
        WHERE user_id = ? AND doc_id IN (${accPlaceholders})
        GROUP BY doc_id
      `).all(userId, ...accessions) as any[];

      for (const row of stats) {
        const wins = Number(row.wins || 0);
        const losses = Number(row.losses || 0);
        const total = wins + losses;
        if (total > 0) {
          const winRatio = wins / total;
          // Apply a nudge boost up to +30% for high win documents
          boostMap.set(row.doc_id, 1.0 + winRatio * 0.3);
        }
      }
    } catch (err) {
      // stats table might not be populated or fail silently
    }
  }

  // Set chunk_id on each candidate, apply usefulness boost, and sort
  const candidates = rawCandidates.map(c => {
    const boost = boostMap.get(c.accession) || 1.0;
    return {
      ...c,
      chunk_id: chunkIdMap.get(c.content_hash) || `${c.symbol}#c000`, // Fallback if missing
      score: c.score * boost
    };
  }).sort((a, b) => b.score - a.score);

  // 4. Maximal Marginal Relevance (MMR) diversity filtering. Cosine MMR runs only when an
  // alternative HTTP embedding provider (SiliconFlow/OpenRouter) is actually configured for this
  // user; in the normal Voyage-only deployment the Jaccard fallback is selected deliberately up
  // front — never by sending the Voyage credential to a foreign endpoint and catching the 401.
  const lambda = 0.5;
  const selected: FusionResult[] = [];
  const selectedIndices = new Set<number>();
  const m = Math.min(Math.max(limit, 15), candidates.length);

  let queryVec: number[] | null = null;
  let candVectors: number[][] | null = null;
  try {
    const queryVecs = await fetchAlternativeEmbedding([query], userId);
    if (queryVecs) {
      const candTexts = candidates.slice(0, m).map(c => c.text);
      const cand = await fetchAlternativeEmbedding(candTexts, userId);
      if (cand) {
        queryVec = queryVecs[0];
        candVectors = cand;
      }
    }
  } catch (embedErr) {
    void import("../sentry-metrics").then(({ logWarn, recordEmbedFailure }) => {
      recordEmbedFailure("search-fusion", "mmr-embed-failed");
      logWarn("embed.failed", {
        provider: "search-fusion",
        error_type: "mmr-embed-failed",
        error: embedErr instanceof Error ? embedErr.message : String(embedErr)
      });
    });
  }

  if (queryVec && candVectors) {
    const qv = queryVec;
    const cv = candVectors;
    const cosineSim = (a: number[], b: number[]) => {
      let dot = 0;
      let normA = 0;
      let normB = 0;
      for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
      }
      return normA === 0 || normB === 0 ? 0 : dot / (Math.sqrt(normA) * Math.sqrt(normB));
    };

    while (selected.length < limit && selected.length < candidates.length) {
      let bestScore = -Infinity;
      let bestIndex = -1;

      for (let i = 0; i < m; i++) {
        if (selectedIndices.has(i)) continue;

        const relevance = cosineSim(cv[i], qv);
        let maxSimilarity = 0;

        for (const selIdx of selectedIndices) {
          const sim = cosineSim(cv[i], cv[selIdx]);
          if (sim > maxSimilarity) {
            maxSimilarity = sim;
          }
        }

        const score = lambda * relevance - (1 - lambda) * maxSimilarity;
        if (score > bestScore) {
          bestScore = score;
          bestIndex = i;
        }
      }

      if (bestIndex === -1) break;
      selectedIndices.add(bestIndex);
      selected.push(candidates[bestIndex]);
    }

    reportDenseRecallDegradation();
    return denseRecallDegraded ? markDenseRecallDegraded(selected) : selected;
  }

  // Fallback Jaccard MMR similarity (no alternative embedding provider configured, or its call failed)
  while (selected.length < limit && selected.length < candidates.length) {
    let bestScore = -Infinity;
    let bestIndex = -1;

    for (let i = 0; i < m; i++) {
      if (selectedIndices.has(i)) continue;

      const relevance = candidates[i].score; // Use boosted RRF score as relevance proxy
      let maxSimilarity = 0;

      for (const selIdx of selectedIndices) {
        const sim = getJaccardSimilarity(candidates[i].text, candidates[selIdx].text);
        if (sim > maxSimilarity) {
          maxSimilarity = sim;
        }
      }

      const score = lambda * relevance - (1 - lambda) * maxSimilarity;
      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }

    if (bestIndex === -1) break;
    selectedIndices.add(bestIndex);
    selected.push(candidates[bestIndex]);
  }

  reportDenseRecallDegradation();
  return denseRecallDegraded ? markDenseRecallDegraded(selected) : selected;
}
