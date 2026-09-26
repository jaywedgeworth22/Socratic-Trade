import { getDb, listConnectedAccounts, listUsers, peekPolicy, listFillEvents } from "./db";
import {
  calculatePnl,
  getPerformanceSummary,
  getThesisScorecard,
  getRedTeamEfficacy,
  type ClosedLot,
  type PnlResult,
  type ThesisStat,
  type RedTeamEfficacy
} from "./performance";
import { yieldEventLoop } from "./slow-sync-guard";
import type { FillSource, HoldReasonCode } from "./types";

/**
 * Token-gated, read-only realized-performance rollup for remote diagnostics
 * (`GET /api/ops/performance` — mirrors `/api/ops/snapshot`'s ops-auth gate).
 *
 * Deliberately reuses the SAME FIFO lot-matching (`calculatePnl`) and scorecard
 * functions the app already ships (`getPerformanceSummary`, `getThesisScorecard`,
 * `getRedTeamEfficacy`) rather than re-deriving P&L math.  `liveFills`/`paperFills`
 * are fetched ONCE per account and `calculatePnl` runs ONCE per source — the
 * results are threaded through as `PrefetchedFills`/`PrefetchedPnl` so
 * `getPerformanceSummary` and `getThesisScorecard` never recompute FIFO
 * matching a second time (same C2 contract `performance.ts` already documents
 * for its own callers).
 *
 * This process's event loop is already known to stall under load (see
 * `docs/rollouts/2026-08-09-event-loop-stall-instrumentation.md` and
 * `docs/rollouts/2026-09-12-issue-3221-event-loop-stalls.md`), so every NEW query this
 * module adds (proposal funnel, block reasons) is bounded: a status GROUP BY
 * scoped to `(user_id, account_number, created_at)` — covered by the existing
 * `idx_trade_proposals_user_account_created` index — and a row-capped scan for
 * block reasons (`MAX_BLOCK_REASON_ROWS`).  The equity curve reuses
 * `getPerformanceSummary`'s `live/paperEquityCurve`, which is already sourced
 * from `listDailyPortfolioSnapshots` (one row per calendar day, capped at
 * `DAILY_SNAPSHOT_DAY_CAP` — see `db-fills.ts`) — no new query.
 *
 * `days` bounds only the IN-MEMORY windowing of trade stats / the proposal funnel / the equity
 * curve (thesis/Red-Team/model attribution are lifetime by design, matching the app's own
 * scorecards).  It deliberately does NOT truncate `listFillEvents` or `calculatePnl`'s FIFO lot
 * replay — `db-fills.ts`'s own doc comment on `listFillEvents` explains why a windowed ledger
 * read corrupts the walk (an exit whose entry falls outside the window would find no lot to
 * close). So per-account cost is bounded by that ACCOUNT's total ledger size, not by `days`, and
 * the unfiltered request (no `account` param — the endpoint's own documented default; see
 * `scripts/fetch-prod-ops-performance.sh`) repeats that per-account cost once per connected
 * account across every user, all inside one request. `buildOpsPerformanceSnapshot` is `async`
 * and calls `yieldEventLoop()` (this codebase's established fix for exactly this incident class —
 * see `slow-sync-guard.ts`, `sec-ingest-worker.ts`, `db-learning.ts`) once per account so that
 * work — however large — is never one unbroken synchronous stretch; it cannot reduce the total
 * work, only keep this process able to serve `/api/health` and other requests while it runs.
 *
 * No live quotes are fetched (mirrors `/api/connected-accounts/[id]/performance`):
 * `unrealized` P&L is real only when a broker sync recently wrote a portfolio
 * snapshot's mark; this endpoint never calls a broker, so every account's
 * `pricesUnavailable` is always `true` and unrealized figures read 0 from an
 * empty `currentPrices` map — same disclosed limitation as that route.
 */

export const OPS_PERFORMANCE_DEFAULT_DAYS = 90;
export const OPS_PERFORMANCE_MIN_DAYS = 1;
export const OPS_PERFORMANCE_MAX_DAYS = 3650;

/** Bound on blocked-proposal rows scanned for the top-block-reasons rollup, per account. */
const MAX_BLOCK_REASON_ROWS = 1000;
/** Bound on held ("proposed" / Awaiting approval) proposal rows scanned for the holdReasons
 *  rollup, per account — same rationale as MAX_BLOCK_REASON_ROWS. */
const MAX_HOLD_REASON_ROWS = 1000;
/** Bound on Red Team veto audit rows scanned per account — the app's own default (5000) is sized
 *  for a single-account request; this endpoint can iterate every account for every user. */
const OPS_RED_TEAM_AUDIT_LIMIT = 500;

export interface OpsTradeStats {
  windowDays: number;
  tradeCount: number;
  /** % of closed lots with pnl > 0, 0-100.  0 when tradeCount is 0 (never fabricated as N/A). */
  winRate: number;
  /** Mean pnl (USD) over winning lots; undefined when there are no winners. */
  avgWinUsd?: number;
  /** Mean |pnl| (USD) over losing lots, reported positive; undefined when there are no losers. */
  avgLossUsd?: number;
  /** sum(winning pnl) / abs(sum(losing pnl)).  undefined when there are no losers (no denominator);
   *  Infinity is never emitted — an all-winners window is reported via `tradeCount`/`winRate` instead. */
  profitFactor?: number;
  /** Mean pnl (USD) per closed lot across the WHOLE window (winners and losers). */
  expectancyUsd: number;
}

export interface OpsModelAttributionRow {
  model: string;
  trades: number;
  winRate: number;
  totalPnlUsd: number;
}

export interface OpsProposalFunnel {
  windowDays: number;
  /** Every status observed in the window, most-common first. */
  counts: Array<{ status: string; count: number }>;
  /** Primary (first) block reason per blocked proposal, tallied and truncated to 160 chars —
   *  reasons that embed a dynamic amount/symbol will not merge into one bucket; this is a
   *  diagnostic rollup, not a canonicalized taxonomy. */
  topBlockReasons: Array<{ reason: string; count: number }>;
  /** True when `topBlockReasons` was truncated by MAX_BLOCK_REASON_ROWS (more blocked proposals
   *  exist in the window than were scanned for reasons — counts.blocked is still exact). */
  blockReasonRowsCapped: boolean;
  /** Coarse cause bucket per held ("proposed" / Awaiting approval) proposal — see `HoldReasonCode`
   *  in types.ts. A held proposal persisted before this field existed carries no `holdReason` and
   *  is simply not counted here (counts.proposed is still exact). */
  holdReasons: Array<{ reason: HoldReasonCode; count: number }>;
  /** True when `holdReasons` was truncated by MAX_HOLD_REASON_ROWS (more held proposals exist in
   *  the window than were scanned — counts for the "proposed" status is still exact). */
  holdReasonRowsCapped: boolean;
}

export interface OpsEquityCurvePoint {
  date: string;
  equity: number;
  cash: number | null;
}

export interface OpsPerformanceAccount {
  connectedAccountId: string;
  userId: string;
  label: string;
  broker: string;
  environment: FillSource;
  systemState: string;
  accountNumber: string | null;
  pricesUnavailable: true;
  liveRealizedPnl: number;
  paperRealizedPnl: number;
  liveUnrealizedPnl: number;
  paperUnrealizedPnl: number;
  tradeStats: OpsTradeStats;
  thesisScorecard: ThesisStat[];
  redTeamEfficacy: RedTeamEfficacy;
  modelAttribution: OpsModelAttributionRow[];
  proposalFunnel: OpsProposalFunnel;
  equityCurve: OpsEquityCurvePoint[];
  /** Set instead of throwing when this one account's rollup failed — the rest of the snapshot
   *  still returns (mirrors ops-snapshot's per-account try/catch). Note this is coarser than
   *  `redTeamEfficacy`'s own isolation: a Red Team audit-read failure alone never sets this — it
   *  falls back to an empty `redTeamEfficacy` while the rest of the account's fields (P&L, trade
   *  stats, funnel, equity curve) still compute normally. See `safeRedTeamEfficacy`. */
  error?: string;
}

export interface OpsPerformanceSnapshot {
  asOf: string;
  windowDays: number;
  accounts: OpsPerformanceAccount[];
}

function clampDays(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return OPS_PERFORMANCE_DEFAULT_DAYS;
  return Math.min(OPS_PERFORMANCE_MAX_DAYS, Math.max(OPS_PERFORMANCE_MIN_DAYS, Math.floor(n)));
}

/** Static fallback for `getRedTeamEfficacy` failures — same shape it returns for a genuine
 *  zero-veto account, so nothing downstream needs a new "unavailable" variant; `coverage` is the
 *  only field that says so explicitly. */
const RED_TEAM_EFFICACY_UNAVAILABLE: RedTeamEfficacy = {
  totalVetoes: 0,
  maturedVetoes: 0,
  unresolvableVetoes: 0,
  maturedCoveragePct: 0,
  coverage: "unavailable (read failed)",
  vetoValueAddRate: 0,
  survivorRiskHitRate: 0,
  avgReturnPct: 0,
  byModel: [],
  records: []
};

/** `getRedTeamEfficacy` -> `listAuditByKind` (`db-learning.ts`) does an unguarded
 *  `JSON.parse(row.payload)` per `audit_events` row for this account/user. One malformed payload
 *  row (partial write, historical bad row) throws there and would otherwise propagate out of
 *  `buildOpsPerformanceSnapshot` uncaught, 500ing this whole diagnostic endpoint for every
 *  account of every user — exactly the tool an operator reaches for during an incident. Wrap it
 *  here (never inside a catch/fallback branch that could itself be reached by the same throw)
 *  and fall back to a static empty shape, mirroring `ops-snapshot.ts`'s own defensive
 *  `JSON.parse`-with-fallback pattern over the same `audit_events` table. */
function safeRedTeamEfficacy(
  userId: string,
  options: { connectedAccountId?: string; auditLimit?: number }
): RedTeamEfficacy {
  try {
    return getRedTeamEfficacy(userId, options);
  } catch {
    return RED_TEAM_EFFICACY_UNAVAILABLE;
  }
}

/** Pure arithmetic over an already-computed `ClosedLot[]` (from `calculatePnl`) — never
 *  re-derives pnl/returnPct itself.  `sinceIso` filters to lots that EXITED in the window;
 *  lots without an `exitAt` (legacy rows) are excluded from the windowed count. */
function computeTradeStats(closedLots: ClosedLot[], sinceIso: string, windowDays: number): OpsTradeStats {
  const windowed = closedLots.filter((lot) => typeof lot.exitAt === "string" && lot.exitAt >= sinceIso);
  const tradeCount = windowed.length;
  if (tradeCount === 0) {
    return { windowDays, tradeCount: 0, winRate: 0, expectancyUsd: 0 };
  }
  let winSum = 0;
  let winCount = 0;
  let lossSum = 0; // positive magnitude
  let lossCount = 0;
  let totalPnl = 0;
  for (const lot of windowed) {
    totalPnl += lot.pnl;
    if (lot.pnl > 0) {
      winSum += lot.pnl;
      winCount += 1;
    } else if (lot.pnl < 0) {
      lossSum += -lot.pnl;
      lossCount += 1;
    }
  }
  return {
    windowDays,
    tradeCount,
    winRate: Number(((winCount / tradeCount) * 100).toFixed(1)),
    avgWinUsd: winCount > 0 ? Number((winSum / winCount).toFixed(2)) : undefined,
    avgLossUsd: lossCount > 0 ? Number((lossSum / lossCount).toFixed(2)) : undefined,
    profitFactor: lossSum > 0 ? Number((winSum / lossSum).toFixed(2)) : undefined,
    expectancyUsd: Number((totalPnl / tradeCount).toFixed(2))
  };
}

/** Group ALL (not window-filtered — an account's model attribution is inherently
 *  lifetime) closed lots by `entryModel` (proposal.proposedByModel).  Pure arithmetic over
 *  already-computed pnl/returnPct, same category as `computeTradeStats` above — not P&L math. */
function computeModelAttribution(closedLots: ClosedLot[]): OpsModelAttributionRow[] {
  const byModel = new Map<string, { trades: number; wins: number; pnl: number }>();
  for (const lot of closedLots) {
    const model = lot.entryModel?.trim();
    if (!model) continue;
    const cur = byModel.get(model) ?? { trades: 0, wins: 0, pnl: 0 };
    cur.trades += 1;
    if (lot.pnl > 0) cur.wins += 1;
    cur.pnl += lot.pnl;
    byModel.set(model, cur);
  }
  return Array.from(byModel.entries())
    .map(([model, s]) => ({
      model,
      trades: s.trades,
      winRate: Number(((s.wins / s.trades) * 100).toFixed(1)),
      totalPnlUsd: Number(s.pnl.toFixed(2))
    }))
    .sort((a, b) => b.trades - a.trades || a.model.localeCompare(b.model));
}

/** Status funnel + top block reasons for one account's proposals in the window.  Both queries are
 *  scoped by (user_id, account_number, created_at) — covered by the existing
 *  idx_trade_proposals_user_account_created index — and the reasons scan is row-capped. */
function queryProposalFunnel(userId: string, accountNumber: string, sinceIso: string, windowDays: number): OpsProposalFunnel {
  const countRows = getDb()
    .prepare(
      `SELECT status, COUNT(*) AS n FROM trade_proposals
       WHERE user_id = ? AND account_number = ? AND created_at >= ?
       GROUP BY status`
    )
    .all(userId, accountNumber, sinceIso) as Array<{ status: string; n: number }>;
  const counts = countRows
    .map((row) => ({ status: row.status, count: row.n }))
    .sort((a, b) => b.count - a.count || a.status.localeCompare(b.status));

  const blockedCount = countRows.find((row) => row.status === "blocked")?.n ?? 0;
  const blockedRows =
    blockedCount > 0
      ? (getDb()
          .prepare(
            `SELECT decision FROM trade_proposals
             WHERE user_id = ? AND account_number = ? AND status = 'blocked' AND created_at >= ?
             ORDER BY created_at DESC LIMIT ?`
          )
          .all(userId, accountNumber, sinceIso, MAX_BLOCK_REASON_ROWS) as Array<{ decision: string }>)
      : [];

  const reasonCounts = new Map<string, number>();
  for (const row of blockedRows) {
    let reason: string | undefined;
    try {
      const parsed = JSON.parse(row.decision) as { reasons?: unknown };
      if (Array.isArray(parsed.reasons) && typeof parsed.reasons[0] === "string" && parsed.reasons[0].trim()) {
        reason = parsed.reasons[0].trim().slice(0, 160);
      }
    } catch {
      // malformed decision JSON — skip this row's reason, the count is still in `counts`
    }
    if (!reason) continue;
    reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
  }
  const topBlockReasons = Array.from(reasonCounts.entries())
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason))
    .slice(0, 10);

  // holdReasons: same shape of query as the block-reasons rollup above, but over "proposed"
  // (Awaiting approval) rows' `proposal.holdReason` (see hold-reason.ts) instead of `decision`.
  const proposedCount = countRows.find((row) => row.status === "proposed")?.n ?? 0;
  const heldRows =
    proposedCount > 0
      ? (getDb()
          .prepare(
            `SELECT proposal FROM trade_proposals
             WHERE user_id = ? AND account_number = ? AND status = 'proposed' AND created_at >= ?
             ORDER BY created_at DESC LIMIT ?`
          )
          .all(userId, accountNumber, sinceIso, MAX_HOLD_REASON_ROWS) as Array<{ proposal: string }>)
      : [];
  const holdReasonCounts = new Map<HoldReasonCode, number>();
  for (const row of heldRows) {
    let holdReason: HoldReasonCode | undefined;
    try {
      const parsed = JSON.parse(row.proposal) as { holdReason?: unknown };
      if (
        parsed.holdReason === "red_team_unavailable" ||
        parsed.holdReason === "funding_sell" ||
        parsed.holdReason === "policy_revert" ||
        parsed.holdReason === "other"
      ) {
        holdReason = parsed.holdReason;
      }
    } catch {
      // malformed proposal JSON — skip this row, counts.proposed above is still exact
    }
    if (!holdReason) continue;
    holdReasonCounts.set(holdReason, (holdReasonCounts.get(holdReason) ?? 0) + 1);
  }
  const holdReasons = Array.from(holdReasonCounts.entries())
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));

  return {
    windowDays,
    counts,
    topBlockReasons,
    blockReasonRowsCapped: blockedRows.length >= MAX_BLOCK_REASON_ROWS && blockedCount > MAX_BLOCK_REASON_ROWS,
    holdReasons,
    holdReasonRowsCapped: heldRows.length >= MAX_HOLD_REASON_ROWS && proposedCount > MAX_HOLD_REASON_ROWS
  };
}

/** Merge live+paper equity curves (already downsampled to <= 1 point/day inside
 *  getPerformanceSummary via listDailyPortfolioSnapshots), filter to the window, sort. */
function buildEquityCurve(
  liveCurve: Array<{ timestamp: string; equity: number; cash?: number }>,
  paperCurve: Array<{ timestamp: string; equity: number; cash?: number }>,
  sinceIso: string
): OpsEquityCurvePoint[] {
  return [...liveCurve, ...paperCurve]
    .filter((point) => point.timestamp >= sinceIso)
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
    .map((point) => ({
      date: point.timestamp.slice(0, 10),
      equity: point.equity,
      cash: typeof point.cash === "number" ? point.cash : null
    }));
}

export interface BuildOpsPerformanceInput {
  /** Narrow to one connectedAccountId (across every user) — omit for every account the ops
   *  snapshot covers, mirroring `/api/ops/snapshot`'s all-users iteration. */
  connectedAccountId?: string;
  days?: number;
}

export async function buildOpsPerformanceSnapshot(input: BuildOpsPerformanceInput = {}): Promise<OpsPerformanceSnapshot> {
  const windowDays = clampDays(input.days);
  const sinceIso = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();

  const accounts: OpsPerformanceAccount[] = [];
  for (const userId of listUsers()) {
    for (const account of listConnectedAccounts(userId)) {
      if (input.connectedAccountId && account.id !== input.connectedAccountId) continue;

      const base = {
        connectedAccountId: account.id,
        userId,
        label: account.label || account.broker,
        broker: account.broker,
        environment: account.environment,
        accountNumber: account.accountNumber ?? null
      };

      if (!account.accountNumber) {
        // Never connected / never synced a broker account number — nothing to compute.
        accounts.push({
          ...base,
          systemState: "unknown",
          pricesUnavailable: true,
          liveRealizedPnl: 0,
          paperRealizedPnl: 0,
          liveUnrealizedPnl: 0,
          paperUnrealizedPnl: 0,
          tradeStats: { windowDays, tradeCount: 0, winRate: 0, expectancyUsd: 0 },
          thesisScorecard: [],
          redTeamEfficacy: safeRedTeamEfficacy(userId, { connectedAccountId: account.id, auditLimit: OPS_RED_TEAM_AUDIT_LIMIT }),
          modelAttribution: [],
          proposalFunnel: { windowDays, counts: [], topBlockReasons: [], blockReasonRowsCapped: false, holdReasons: [], holdReasonRowsCapped: false },
          equityCurve: []
        });
        // Give the process a scheduling point between accounts even on this cheap branch, so an
        // unfiltered request over many never-synced accounts stays uniform with the branch below.
        await yieldEventLoop();
        continue;
      }

      try {
        const accountNumber = account.accountNumber;
        const policy = peekPolicy(userId, account.id);
        const systemState = policy.systemState;

        // Fetch each source's fills ONCE, compute FIFO ONCE per source, and thread the results
        // through as PrefetchedFills/PrefetchedPnl so getPerformanceSummary and
        // getThesisScorecard never recompute calculatePnl for the same book.
        const liveFills = listFillEvents(accountNumber, "live", undefined, userId);
        const paperFills = listFillEvents(accountNumber, "paper", undefined, userId);
        const livePnl: PnlResult = calculatePnl(liveFills, {});
        const paperPnl: PnlResult = calculatePnl(paperFills, {});
        const prefetched = { liveFills, paperFills };
        const prefetchedPnl = { live: livePnl, paper: paperPnl };

        // No currentPrices fetched (matches /api/connected-accounts/[id]/performance) — this is a
        // read-only ops diagnostic and never calls a broker for a live quote.
        const performance = getPerformanceSummary(accountNumber, {}, userId, prefetched, prefetchedPnl);

        // Scorecards/trade-stats key off the account's OWN book (environment), not a merged
        // live+paper FIFO match, which getThesisScorecard(source=undefined) would otherwise
        // recompute from scratch — see module doc comment.
        const source: FillSource = account.environment;
        const sourcePnl = source === "live" ? livePnl : paperPnl;

        const thesisScorecard = getThesisScorecard(accountNumber, source, {}, userId, prefetched, prefetchedPnl);
        const redTeamEfficacy = safeRedTeamEfficacy(userId, {
          connectedAccountId: account.id,
          auditLimit: OPS_RED_TEAM_AUDIT_LIMIT
        });
        const modelAttribution = computeModelAttribution(sourcePnl.closedLots);
        const tradeStats = computeTradeStats(sourcePnl.closedLots, sinceIso, windowDays);
        const proposalFunnel = queryProposalFunnel(userId, accountNumber, sinceIso, windowDays);
        const equityCurve = buildEquityCurve(performance.liveEquityCurve, performance.paperEquityCurve, sinceIso);

        accounts.push({
          ...base,
          systemState,
          pricesUnavailable: true,
          liveRealizedPnl: performance.liveRealizedPnl,
          paperRealizedPnl: performance.paperRealizedPnl,
          liveUnrealizedPnl: performance.liveUnrealizedPnl,
          paperUnrealizedPnl: performance.paperUnrealizedPnl,
          tradeStats,
          thesisScorecard,
          redTeamEfficacy,
          modelAttribution,
          proposalFunnel,
          equityCurve
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        accounts.push({
          ...base,
          systemState: "unknown",
          pricesUnavailable: true,
          liveRealizedPnl: 0,
          paperRealizedPnl: 0,
          liveUnrealizedPnl: 0,
          paperUnrealizedPnl: 0,
          tradeStats: { windowDays, tradeCount: 0, winRate: 0, expectancyUsd: 0 },
          thesisScorecard: [],
          redTeamEfficacy: safeRedTeamEfficacy(userId, { connectedAccountId: account.id, auditLimit: OPS_RED_TEAM_AUDIT_LIMIT }),
          modelAttribution: [],
          proposalFunnel: { windowDays, counts: [], topBlockReasons: [], blockReasonRowsCapped: false, holdReasons: [], holdReasonRowsCapped: false },
          equityCurve: [],
          error: message
        });
      }

      // The expensive step: a full-ledger listFillEvents + FIFO calculatePnl walk per source,
      // run above for EVERY account in an unfiltered request. Yield here — after each account,
      // win or error — so this request can never hold the event loop for its whole duration; see
      // the module doc comment and `slow-sync-guard.ts` for why this is this codebase's fix for
      // exactly this incident class. This does not shrink the total work, only breaks it up.
      await yieldEventLoop();
    }
  }

  return {
    asOf: new Date().toISOString(),
    windowDays,
    accounts
  };
}

// ── 60s in-memory cache (event loop already stalls under load — see module doc comment) ──────

const CACHE_TTL_MS = 60_000;

type CacheEntry = { expiresAt: number; value: OpsPerformanceSnapshot };
const snapshotCache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<OpsPerformanceSnapshot>>();

function cacheKey(input: BuildOpsPerformanceInput): string {
  return `${input.connectedAccountId ?? "*"}\0${clampDays(input.days)}`;
}

/** Cached wrapper around buildOpsPerformanceSnapshot — 60s TTL, single-flight per key so two
 *  concurrent requests for the same (account, days) never double the DB work. */
export async function getOrBuildOpsPerformanceSnapshot(input: BuildOpsPerformanceInput = {}): Promise<OpsPerformanceSnapshot> {
  const key = cacheKey(input);
  const now = Date.now();
  const hit = snapshotCache.get(key);
  if (hit && hit.expiresAt > now) return hit.value;

  const pending = inFlight.get(key);
  if (pending) return pending;

  const promise = (async () => {
    try {
      const value = await buildOpsPerformanceSnapshot(input);
      snapshotCache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, value });
      return value;
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, promise);
  return promise;
}

/** Test-only: full reset (mirrors dashboard-snapshot-cache.ts's resetDashboardSnapshotCacheForTests). */
export function resetOpsPerformanceCacheForTests(): void {
  snapshotCache.clear();
  inFlight.clear();
}
