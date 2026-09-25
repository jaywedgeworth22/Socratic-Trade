// Disclosure RAG embedding — congressional trades + insider filings.
//
// Converts structured disclosure records into natural-language RAG documents and
// upserts them into the shared vector store. Gated by RAG_EMBED_DISCLOSURES (default
// off) so the structured storage pipeline is completely unaffected when the flag is
// absent or set to "off".
//
// Pattern mirrors sec8k.ts: fire-and-forget, best-effort, never throws into callers.
// vector-db is loaded via dynamic import so the heavy embedding stack (Voyage/Pinecone)
// is only pulled in when the flag is on and there is data to embed.

import type { CongressTrade } from "./types";
import type { InsiderFiling } from "./sec";
import type { ContextDocument } from "../vector-db";
import { envFlagOn } from "../rag/env-flag";
import { resolveSourceBool } from "../source-settings";

// ── Flag ─────────────────────────────────────────────────────────────────────

/**
 * Returns true when RAG_EMBED_DISCLOSURES is truthy via Settings override or env.
 * Default is off. Accepts "true"/"1"/"yes"/"on" through the shared source-settings resolver.
 */
export function disclosureRagEnabled(): boolean {
  return resolveSourceBool("RAG_EMBED_DISCLOSURES");
}

// ── Text builders ────────────────────────────────────────────────────────────

function formatAmount(low?: number, high?: number): string {
  if (low == null && high == null) return "";
  if (low != null && high != null) {
    return `Amount range: $${low.toLocaleString()}–$${high.toLocaleString()} USD. `;
  }
  if (low != null) return `Amount range: at least $${low.toLocaleString()} USD. `;
  return `Amount range: up to $${high!.toLocaleString()} USD. `;
}

function tradeToDoc(trade: CongressTrade): ContextDocument {
  const amount = formatAmount(trade.amountLow, trade.amountHigh);
  const disclosed = trade.disclosedAt ? `Disclosed: ${trade.disclosedAt}. ` : "";
  const text =
    `${trade.member} (${trade.chamber}) disclosed a ${trade.side.toUpperCase()} of ${trade.symbol}. ` +
    `${amount}` +
    `Trade date: ${trade.tradedAt}. ` +
    `${disclosed}` +
    `Source: ${trade.source}.`;

  const acceptanceDatetime = trade.disclosedAt ?? trade.tradedAt;

  return {
    text,
    metadata: {
      symbol: trade.symbol,
      source: "congress-disclosure",
      timestamp: acceptanceDatetime,
      accession: `${trade.symbol}|${trade.member}|${trade.side}|${trade.tradedAt}`,
      doc_type: "congress-trade",
      acceptance_datetime: acceptanceDatetime
    }
  };
}

function filingToDoc(filing: InsiderFiling): ContextDocument {
  const text =
    `Insider filing for ${filing.symbol} by ${filing.owner}. ` +
    `Open-market purchases: ${filing.buyTx} transaction(s) (${filing.buyShares} shares). ` +
    `Open-market sales: ${filing.sellTx} transaction(s) (${filing.sellShares} shares). ` +
    `Filed: ${filing.filedAt}. Accession: ${filing.accession}.`;

  return {
    text,
    metadata: {
      symbol: filing.symbol,
      source: "insider-filing",
      timestamp: filing.filedAt,
      accession: filing.accession,
      doc_type: "insider-filing",
      acceptance_datetime: filing.filedAt
    }
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface EmbedDisclosuresResult {
  attempted: number;
  indexed: number;
  skipped?: boolean;
  error?: string;
}

/**
 * Convert congress trades + insider filings into RAG documents and upsert them
 * into the vector store. Returns immediately (skipped: true) when the flag is off.
 * Never throws — always returns a result object or logs and returns an error string.
 */
export async function embedDisclosures(
  trades: CongressTrade[],
  filings: InsiderFiling[],
  userId = "local"
): Promise<EmbedDisclosuresResult> {
  if (!disclosureRagEnabled()) {
    return { attempted: 0, indexed: 0, skipped: true };
  }

  const docs: ContextDocument[] = [
    ...trades.map(tradeToDoc),
    ...filings.map(filingToDoc)
  ];

  if (docs.length === 0) {
    return { attempted: 0, indexed: 0 };
  }

  // Pre-flight: skip the storeContexts call entirely when the daily text embed budget is
  // already spent — mirroring the hasIngestTextBudget() check in ingestFiling() (sec-filings.ts).
  // Without this check the scheduler invokes storeContexts every ~30 min and triggers a
  // cooldown-gated Sentry warning on every tick for the rest of the 24h budget window.
  const { hasIngestTextBudget } = await import("../vector-db");
  if (!hasIngestTextBudget(userId)) {
    return { attempted: docs.length, indexed: 0, skipped: true };
  }

  try {
    const { storeContexts } = await import("../vector-db");
    // R10 (2026-07-01 RAG backlog): content_hash dedup, gated on the same
    // VECTOR_STORECONTEXTS_DEDUP flag as the 8-K summary path — a disclosure batch commonly
    // re-embeds the same congress-trade/insider-filing text across refresh cycles.
    const result = await storeContexts(
      docs,
      userId,
      envFlagOn("VECTOR_STORECONTEXTS_DEDUP", true) ? { dedupKeyPrefix: "disclosure" } : undefined
    );

    // Best-effort audit — never let audit failures propagate. Awaited (cheap local write) so
    // callers/tests observe a consistent audit state, but any failure is swallowed.
    try {
      await recordEmbedAudit(result);
    } catch {
      /* best-effort */
    }

    return {
      attempted: result.attempted,
      indexed: result.indexed,
      skipped: result.skipped,
      error: result.error
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const { logError, recordEmbedFailure } = await import("../sentry-metrics");
    recordEmbedFailure("disclosure-rag", "embed-failed");
    logError("embed.failed", { provider: "disclosure-rag", error_type: "embed-failed" });
    return { attempted: docs.length, indexed: 0, error: msg };
  }
}

// ── Audit hygiene (#2553c) ────────────────────────────────────────────────────

/** Internal-settings watermark for the no-op rollup below. */
export const DISCLOSURE_RAG_NOOP_ROLLUP_KEY = "disclosureRag:noopRollup";
const NOOP_AUDIT_INTERVAL_MS = 24 * 3600_000;

interface NoopRollupState {
  cycles: number;
  attempted: number;
  lastAuditAt?: string;
}

/**
 * Write the `disclosure_rag_embed` audit row — unless the run was a pure no-op (every document
 * deduped before embedding: indexed=0, not skipped, no error). Content-hash dedup makes that the
 * COMMON case, and it used to write an identical "Attempted: 310 · Indexed: 0" audit row every
 * refresh cycle (1–3 min). No-op cycles now accumulate into an internal-settings watermark and
 * flush as at most ONE daily rollup row carrying the suppressed-cycle count, so the receipt that
 * the lane is alive survives without the per-minute noise.
 */
async function recordEmbedAudit(result: { attempted: number; indexed: number; skipped?: boolean; error?: string }): Promise<void> {
  const { audit, getInternalSetting, setInternalSetting } = await import("../db");
  const isNoop = !result.error && !result.skipped && result.indexed === 0;
  if (!isNoop) {
    audit("disclosure_rag_embed", {
      ok: !result.error,
      attempted: result.attempted,
      indexed: result.indexed,
      skipped: result.skipped
    });
    return;
  }
  const state = getInternalSetting<NoopRollupState>(DISCLOSURE_RAG_NOOP_ROLLUP_KEY) ?? { cycles: 0, attempted: 0 };
  const cycles = state.cycles + 1;
  const attempted = state.attempted + result.attempted;
  const lastAuditMs = state.lastAuditAt ? Date.parse(state.lastAuditAt) : NaN;
  if (Number.isFinite(lastAuditMs) && Date.now() - lastAuditMs < NOOP_AUDIT_INTERVAL_MS) {
    setInternalSetting(DISCLOSURE_RAG_NOOP_ROLLUP_KEY, { cycles, attempted, lastAuditAt: state.lastAuditAt });
    return;
  }
  audit("disclosure_rag_embed", {
    ok: true,
    indexed: 0,
    attempted: result.attempted,
    dedupedCycles: cycles,
    dedupedAttempted: attempted,
    rollup: true
  });
  setInternalSetting(DISCLOSURE_RAG_NOOP_ROLLUP_KEY, { cycles: 0, attempted: 0, lastAuditAt: new Date().toISOString() });
}
