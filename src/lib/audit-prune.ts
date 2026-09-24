// audit-prune.ts — retention pruning for audit_events and the provider
// observability tables.
//
// Production finding (2026-08-01): audit_events held 493k rows / 718 MB
// (HALF the 1.43 GB DB) with no retention at all; provider_dispatch_attempts
// (304k/109 MB) and provider_usage_outbox (261k/60 MB) were likewise
// unbounded. Every retained byte is also replicated daily into R2 snapshots
// + WAL, directly driving the ~3 GB/day backup growth.
//
// Policy:
//   - High-volume observability kinds (per-tick/per-symbol noise) → 14 days.
//   - Everything else (trading-critical forensics, orders, policy, runs) → 90 days.
//   - provider_dispatch_attempts / provider_usage_outbox → 14 days.
//   - Red Team veto/override kinds (AUDIT_PRUNE_NEVER_PRUNED_KINDS) → never.
// Bounded batches per run so a first-ever prune (which deletes hundreds of
// thousands of rows) cannot hold the write lock long enough to stall trading;
// the lane runs daily and drains the backlog over a few passes.
//
// Production finding (2026-09-18): this 90-day default had been silently deleting
// `proposal_rejected_by_red_team` and the related override kinds since this file
// shipped (2026-08-02) — they were never on the 14-day observability list, so they
// fell into the "everything else" 90-day bucket even though getRedTeamEfficacy
// (src/lib/performance.ts) rebuilds the ENTIRE lifetime Red Team veto scorecard from
// exactly those rows. Any account older than 90 days had already lost real veto
// history before this exemption landed — see
// docs/rollouts/2026-09-18-stats-veto-retention.md. AUDIT_PRUNE_NEVER_PRUNED_KINDS
// below exempts them permanently; do not fold them back into the default bucket.
//
// NOTE: deletes free pages into SQLite's freelist but the FILE (and thus
// litestream snapshots) only shrinks after a VACUUM — that is a deliberate
// operator action (full rewrite = one large WAL burst), not automated here.

import { getDb } from "./db";
import { sweepEmbedStage } from "./db-embed-stage";
import { sweepPortfolioSnapshots } from "./db-fills";
import { getInternalSetting, setInternalSetting } from "./db-settings";

/** Kinds whose volume is observability noise (deduped now, but history is heavy). */
export const AUDIT_PRUNE_OBSERVABILITY_KINDS: readonly string[] = [
  "broker_protective_stop_skipped",
  "fill_reconciliation_pending_price",
  "rag_retrieval_stage_trace",
  "rag_retrieval_quality",
  "disclosure_rag_embed",
  "signal_snapshot",
  "candidates_considered",
  "usage_budget_status",
  "synthetic_stop_skipped_resting_exit",
  "socratic_outcome_recorded",
  "strategy_rag_prompt_consumption",
  "strategy_evidence_pack",
  "strategy_source_coverage",
  "r2_usage.check",
  "r2_usage.digest",
];

/**
 * Kinds that feed user-facing model stats scorecards (Results page "Red Team veto efficacy"
 * card, Model Stats drawer latency p50, and reviewer column, via getRedTeamEfficacy in
 * src/lib/performance.ts and listAuditByKind in model-stats/route.ts) — exempt from the default
 * 90-day retention. Unlike the observability kinds above, these are the SOLE, irreplaceable
 * source for user-facing latency and veto efficacy metrics, not noise volume being traded off
 * against disk: once a row is gone, its history is permanently invisible to the scorecard.
 */
export const AUDIT_PRUNE_NEVER_PRUNED_KINDS: readonly string[] = [
  "proposal_rejected_by_red_team",
  "red_team_veto_override_requested",
  "red_team_veto_overridden",
  "socratic_override_applied",
  "llm_call_latency"
];

export const AUDIT_PRUNE_OBSERVABILITY_DAYS = 14;
export const AUDIT_PRUNE_DEFAULT_DAYS = 90;
export const AUDIT_PRUNE_PROVIDER_DAYS = 14;
export const AUDIT_PRUNE_BATCH_LIMIT = 50_000; // rows per run across all classes

const LAST_RUN_KEY = "auditprune:lastRunAt";
const INTERVAL_MS = 24 * 3600_000;

export interface AuditPruneResult {
  auditObservability: number;
  auditDefault: number;
  providerDispatch: number;
  providerOutbox: number;
  /** embed_stage rows removed by the 35-day retention window (db-embed-stage.ts — orphans
   * whose source document was superseded before any retry consumed them). */
  embedStageExpired: number;
  /** embed_stage rows removed oldest-first by the defensive 2 GiB size cap (one audit row). */
  embedStageCapPruned: number;
  /** portfolio_snapshots removed by the retention window (90 days). */
  portfolioSnapshotsPruned: number;
}

export function pruneAuditEvents(now: Date = new Date(), batchLimit: number = AUDIT_PRUNE_BATCH_LIMIT): AuditPruneResult {
  const db = getDb();
  const obsCutoff = new Date(now.getTime() - AUDIT_PRUNE_OBSERVABILITY_DAYS * 24 * 3600_000).toISOString();
  const defCutoff = new Date(now.getTime() - AUDIT_PRUNE_DEFAULT_DAYS * 24 * 3600_000).toISOString();
  const provCutoff = new Date(now.getTime() - AUDIT_PRUNE_PROVIDER_DAYS * 24 * 3600_000).toISOString();
  const placeholders = AUDIT_PRUNE_OBSERVABILITY_KINDS.map(() => "?").join(", ");
  const neverPrunedPlaceholders = AUDIT_PRUNE_NEVER_PRUNED_KINDS.map(() => "?").join(", ");
  let remaining = batchLimit;
  const result: AuditPruneResult = {
    auditObservability: 0,
    auditDefault: 0,
    providerDispatch: 0,
    providerOutbox: 0,
    embedStageExpired: 0,
    embedStageCapPruned: 0,
    portfolioSnapshotsPruned: 0
  };

  result.auditObservability = db
    .prepare(
      `DELETE FROM audit_events WHERE id IN (
         SELECT id FROM audit_events
         WHERE kind IN (${placeholders}) AND created_at < ? LIMIT ?)`
    )
    .run(...AUDIT_PRUNE_OBSERVABILITY_KINDS, obsCutoff, remaining).changes;
  remaining -= result.auditObservability;

  if (remaining > 0) {
    // Red Team veto/override kinds are excluded here too, not just from the observability
    // bucket above — see AUDIT_PRUNE_NEVER_PRUNED_KINDS. Without the second NOT IN, they'd
    // fall straight into this "everything else" 90-day default.
    result.auditDefault = db
      .prepare(
        `DELETE FROM audit_events WHERE id IN (
           SELECT id FROM audit_events
           WHERE kind NOT IN (${placeholders}) AND kind NOT IN (${neverPrunedPlaceholders}) AND created_at < ? LIMIT ?)`
      )
      .run(...AUDIT_PRUNE_OBSERVABILITY_KINDS, ...AUDIT_PRUNE_NEVER_PRUNED_KINDS, defCutoff, remaining).changes;
    remaining -= result.auditDefault;
  }
  if (remaining > 0) {
    result.providerDispatch = db
      .prepare(`DELETE FROM provider_dispatch_attempts WHERE id IN (SELECT id FROM provider_dispatch_attempts WHERE created_at < ? LIMIT ?)`)
      .run(provCutoff, remaining).changes;
    remaining -= result.providerDispatch;
  }
  if (remaining > 0) {
    result.providerOutbox = db
      .prepare(`DELETE FROM provider_usage_outbox WHERE id IN (SELECT id FROM provider_usage_outbox WHERE created_at < ? LIMIT ?)`)
      .run(provCutoff, remaining).changes;
  }

  // embed_stage retention + defensive size cap (db-embed-stage.ts). Steady state deletes
  // nothing — rows normally live only between a paid embed and its successful Pinecone
  // delivery; this lane only reaps orphans (superseded documents) and a runaway table.
  const stageSweep = sweepEmbedStage(now);
  result.embedStageExpired = stageSweep.expired;
  result.embedStageCapPruned = stageSweep.capPruned;

  // portfolio_snapshots retention — bounded LIMIT batch inside sweepPortfolioSnapshots so a
  // first-ever backlog (hundreds of thousands of multi-kB JSON rows) drains across multiple
  // daily passes instead of holding the SQLite write lock. Pass the remaining budget so this
  // lane can't blow past the audit_events cap on a quiet day when only snapshots needed
  // pruning.
  if (remaining > 0) {
    result.portfolioSnapshotsPruned = sweepPortfolioSnapshots(now, 90, Math.min(remaining, 5_000));
  }

  return result;
}

export function isAuditPruneDue(now: number = Date.now()): boolean {
  const last = getInternalSetting<string>(LAST_RUN_KEY);
  if (!last) return true;
  const lastMs = Date.parse(last);
  if (!Number.isFinite(lastMs)) return true;
  return now - lastMs >= INTERVAL_MS;
}

/** Cadence-gated, self-guarded scheduler entrypoint (watermark-first). */
export function runAuditPruneIfDue(now: number = Date.now()): AuditPruneResult | null {
  try {
    if (!isAuditPruneDue(now)) return null;
    setInternalSetting(LAST_RUN_KEY, new Date(now).toISOString());
    return pruneAuditEvents(new Date(now));
  } catch (err) {
    console.error("[audit-prune] prune error:", err);
    return null;
  }
}
