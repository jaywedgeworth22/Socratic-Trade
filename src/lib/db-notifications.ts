// db-notifications.ts — notification events + alert lifecycle (acknowledge, auto-ack, repeat-dedup)
import "server-only";
import crypto from "crypto";
import { audit, getDb } from "./db";
import type {
  NotificationEvent,
  NotificationEventType,
  NotificationStatus
} from "./types";

type RawNotificationEvent = {
  id: string;
  created_at: string;
  type: string;
  title: string;
  status: string;
  webhook_url: string | null;
  payload: string;
  error: string | null;
  connected_account_id: string | null;
  acknowledged_at: string | null;
};

/** Older-than-this a run_failed row of the same (account, error signature) is treated as a fresh
 *  occurrence rather than a repeat of the same still-unresolved condition. */
const RUN_FAILED_DEDUP_WINDOW_MS = 6 * 60 * 60_000;

/** Auto-ack sweep bounds: only look at recent-ish rows, and only a bounded batch per call, since
 *  it runs inline on every dashboard snapshot build (no cron). Rows outside this window/limit get
 *  swept next call once they age back into it — the sweep is cheap and idempotent to re-run. */
const SWEEP_MAX_AGE_DAYS = 30;
const SWEEP_BATCH_LIMIT = 200;

function normalizeRunFailedSignature(title: string, payload: unknown): string {
  const record = payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {};
  // Always anchor on the title — it's the only field guaranteed to carry the symbol (e.g.
  // "AAPL order placement uncertain — verify with broker" vs "TSLA order placement uncertain —
  // verify with broker"). A generic error/summary ("fetch failed") is identical across symbols, so
  // basing the signature on summary/error alone collapsed unrelated per-symbol alerts into one.
  const detail = record.summary ?? record.error;
  const raw = detail != null ? `${title} ${String(detail)}` : String(title ?? "");
  return raw
    // Strip run/proposal-specific UUIDs so the same recurring failure (e.g. the same provider/model
    // error text) normalizes to one signature across runs instead of a fresh one every time.
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<id>")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .slice(0, 300);
}

/**
 * True for run_failed rows whose underlying condition is NOT resolved by a later successful run —
 * a genuinely-uncertain placement (broker unreachable, a human must verify) or a terminal broker
 * decline. These must never be cleared by sweepAutoAcknowledgeNotifications' "latest run succeeded"
 * heuristic. Marker-driven: new emitters carry a `payload.reconcile` discriminator; only "uncertain"
 * and "declined" stay protected. A "not_placed" alert ("safe to retry") IS sweepable and self-clears
 * once the account runs successfully; a confirmed "placed"/"recovered" fill notification is a
 * `type: "fill"` row and never reaches here.
 *
 * The pre-marker blanket rule ("any run_failed carrying a proposalId/orderId is protected") was
 * dropped: it would wrongly protect the new sweepable not_placed alert, which also carries
 * proposalId/refId. Legacy rows persisted before the marker existed fall back to matching the
 * enumerated titles/summaries.
 *
 * Real run_failed emission sites (enumerated, not guessed) in src/lib/strategy.ts:
 *   - :2228 (autonomous) / :4057 (approval) — title `${symbol} order placement uncertain — verify
 *     with broker`, payload { …, reconcile: "uncertain" }.
 *   - :2254 (autonomous) / :4071 (approval) — title `${symbol} order declined by broker (${state})`,
 *     payload { …, reconcile: "declined" }.
 *   - :2399 — the ONLY order-agnostic run_failed emitter — title "Strategy run failed",
 *     payload { runId, summary }: a plain LLM/provider run-level failure with no order at stake and
 *     no reconcile marker, so it remains sweepable.
 *   - reconcile-path emitters (order confirmed NOT placed) carry reconcile: "not_placed" and are
 *     deliberately sweepable.
 *   - (lane G3, 2026-09-25) the account-questionnaire hold's first detection — title
 *     `${accountNumber} needs your action on Robinhood`, payload { …, reconcile:
 *     "account_action_required" }: a STANDING account-level broker gate (see
 *     broker-account-questionnaire.ts) that a later successful run does NOT resolve — a sell can
 *     still succeed while entries stay paused — so it must stay protected like "uncertain"/
 *     "declined", never auto-acked just because SOME later run completed.
 */
function isBrokerVerificationRunFailed(title: string, payload: unknown): boolean {
  const record = payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {};
  const reconcile = typeof record.reconcile === "string" ? record.reconcile : undefined;
  if (reconcile === "uncertain" || reconcile === "declined" || reconcile === "account_action_required") return true;
  if (reconcile === "not_placed" || reconcile === "placed" || reconcile === "recovered") return false;
  // Legacy fallback: rows persisted before the reconcile marker existed carry only the title/summary.
  const text = `${title} ${typeof record.summary === "string" ? record.summary : ""}`.toLowerCase();
  return (
    text.includes("needs your action on robinhood") ||
    text.includes("verify with broker") ||
    text.includes("placement uncertain") ||
    text.includes("declined by broker")
  );
}

/**
 * How long a claimed-but-unresolved option-alert reservation stays authoritative before it is treated
 * as ABANDONED and reclaimable. A live delivery (`sendNotification`) completes in well under a second;
 * this window only ever reclaims a reservation whose owner crashed between claiming and recording a
 * `status='sent'` event (or reaching the finally-release). Kept comfortably longer than any real
 * delivery so an in-flight send is never stolen (Codex review, PR #1738).
 */
const OPTION_ALERT_RESERVATION_TTL_MS = 10 * 60 * 1000;

/**
 * Atomically claim the right to deliver a single option alert. Backed by a UNIQUE constraint on
 * (user_id, connected_account_id, symbol, alert_type): the INSERT OR IGNORE either inserts the row
 * (returns true — THIS caller owns delivery) or no-ops because a concurrent request already claimed
 * it (returns false — skip). better-sqlite3 is synchronous, so the reclaim-insert-and-read-changes
 * runs to completion within one event-loop tick, making the claim race-free against concurrent
 * dashboard snapshot builds. Release the claim (`releaseOptionAlertReservation`) if the send does not
 * actually deliver, so a disabled/failed alert stays deliverable on a later cycle.
 *
 * ABANDONED-reservation reclaim (Codex review, PR #1738): a process that dies AFTER the INSERT but
 * BEFORE recording a `status='sent'` event (or the finally-release) would otherwise leave the row
 * resting forever and permanently suppress this alert. The pre-insert DELETE reclaims any reservation
 * older than the TTL. This can never double-send a genuinely-delivered alert: delivered alerts are
 * deduped upstream by the permanent `status='sent'` check (the caller never even reaches this claim
 * for one already sent), so a reclaim only ever frees an orphan that produced no delivery.
 */
export function reserveOptionAlert(
  userId: string,
  connectedAccountId: string,
  symbol: string,
  alertType: string
): boolean {
  const db = getDb();
  const cutoff = new Date(Date.now() - OPTION_ALERT_RESERVATION_TTL_MS).toISOString();
  db.prepare(
    `DELETE FROM option_alert_reservations
     WHERE user_id = ? AND connected_account_id = ? AND symbol = ? AND alert_type = ? AND created_at < ?`
  ).run(userId, connectedAccountId ?? "", symbol, alertType, cutoff);
  const info = db
    .prepare(
      `INSERT OR IGNORE INTO option_alert_reservations (user_id, connected_account_id, symbol, alert_type, created_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(userId, connectedAccountId ?? "", symbol, alertType, new Date().toISOString());
  return info.changes === 1;
}

/** Release a previously-claimed option-alert reservation so it can be delivered on a later cycle
 *  (used when the send was skipped/failed rather than actually delivered). */
export function releaseOptionAlertReservation(
  userId: string,
  connectedAccountId: string,
  symbol: string,
  alertType: string
): void {
  getDb()
    .prepare(
      `DELETE FROM option_alert_reservations
       WHERE user_id = ? AND connected_account_id = ? AND symbol = ? AND alert_type = ?`
    )
    .run(userId, connectedAccountId ?? "", symbol, alertType);
}

function rowToEvent(row: RawNotificationEvent): NotificationEvent {
  return {
    id: row.id,
    createdAt: row.created_at,
    type: row.type as NotificationEventType,
    title: row.title,
    status: row.status as NotificationStatus,
    webhookUrl: row.webhook_url ?? undefined,
    payload: JSON.parse(row.payload),
    error: row.error ?? undefined,
    connectedAccountId: row.connected_account_id ?? undefined,
    acknowledgedAt: row.acknowledged_at ?? undefined
  };
}

export function insertNotificationEvent(input: {
  userId?: string;
  connectedAccountId?: string;
  type: NotificationEventType;
  title: string;
  status: NotificationStatus;
  webhookUrl?: string;
  payload: unknown;
  error?: string;
}): NotificationEvent {
  const userId = input.userId ?? "local";
  const event: NotificationEvent = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    type: input.type,
    title: input.title,
    status: input.status,
    webhookUrl: input.webhookUrl,
    payload: input.payload,
    error: input.error,
    connectedAccountId: input.connectedAccountId
  };
  getDb()
    .prepare("INSERT INTO notification_events (id, user_id, connected_account_id, created_at, type, title, status, webhook_url, payload, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(event.id, userId, input.connectedAccountId ?? null, event.createdAt, event.type, event.title, event.status, event.webhookUrl ?? null, JSON.stringify(event.payload), event.error ?? null);

  // Repeat-dedup for run_failed: a recurring, still-unresolved condition (e.g. a broken model config
  // that fails every run cycle) would otherwise write a fresh Attention row forever. When this new
  // row's (connected_account_id + normalized error signature) matches an older UNACKNOWLEDGED
  // run_failed row from the last 6h, auto-acknowledge the older row — history is preserved (it stays
  // visible under "All"), but Attention shows only the newest occurrence.
  if (event.type === "run_failed") {
    const db = getDb();
    const signature = normalizeRunFailedSignature(event.title, event.payload);
    const acctKey = input.connectedAccountId ?? "";
    const cutoff = new Date(Date.now() - RUN_FAILED_DEDUP_WINDOW_MS).toISOString();
    const candidates = db
      .prepare(
        `SELECT id, title, payload FROM notification_events
         WHERE user_id = ? AND type = 'run_failed' AND acknowledged_at IS NULL AND id != ?
           AND created_at >= ? AND COALESCE(connected_account_id, '') = ?`
      )
      .all(userId, event.id, cutoff, acctKey) as Array<{ id: string; title: string; payload: string }>;
    const now = new Date().toISOString();
    for (const candidate of candidates) {
      let candidatePayload: unknown;
      try {
        candidatePayload = JSON.parse(candidate.payload);
      } catch {
        candidatePayload = {};
      }
      if (normalizeRunFailedSignature(candidate.title, candidatePayload) === signature) {
        db.prepare("UPDATE notification_events SET acknowledged_at = ? WHERE id = ? AND user_id = ? AND acknowledged_at IS NULL")
          .run(now, candidate.id, userId);
      }
    }
  }

  return event;
}

export function listNotificationEvents(userId: string = "local", limit: number = 50): NotificationEvent[] {
  const rows = getDb()
    .prepare("SELECT id, created_at, type, title, status, webhook_url, payload, error, connected_account_id, acknowledged_at FROM notification_events WHERE user_id = ? ORDER BY created_at DESC LIMIT ?")
    .all(userId, limit) as RawNotificationEvent[];
  return rows.map(rowToEvent);
}

/** Acknowledge specific notification_events rows, scoped to the requesting user. Rows belonging to
 *  another user (or already acknowledged) are silently skipped — returns the number actually changed. */
export function acknowledgeNotificationEvents(userId: string, ids: string[]): number {
  if (ids.length === 0) return 0;
  const now = new Date().toISOString();
  const placeholders = ids.map(() => "?").join(", ");
  const result = getDb()
    .prepare(`UPDATE notification_events SET acknowledged_at = ? WHERE user_id = ? AND acknowledged_at IS NULL AND id IN (${placeholders})`)
    .run(now, userId, ...ids);
  return result.changes;
}

/**
 * Resolve (auto-acknowledge) the "verify with broker" alert(s) for a proposal/order whose true
 * outcome has since been CONFIRMED (an order carrying our idempotency key was found at the broker, or
 * a fill for the proposal reached "filled"). This is the counterpart to isBrokerVerificationRunFailed:
 * the uncertain alert stays perpetual UNTIL a definite confirmation lands, at which point this clears
 * exactly the matching row(s) — never a different proposal's alert, and never a `declined` alert
 * (a declined order is a standing fact that must remain visible).
 *
 * Matching is by the exact globally-unique proposalId and/or refId UUID(s) in the row payload, so it
 * is surgical (MP-5) and user-scoped (MP-7). A row is treated as an uncertain alert iff its
 * payload carries `reconcile: "uncertain"`, or (legacy, pre-marker) its title reads "…placement
 * uncertain — verify with broker". Returns the number of rows acknowledged.
 */
export function resolveBrokerVerificationNotifications(
  userId: string,
  opts: { proposalId?: string; refId?: string; resolution: "recovered" | "placed" | "not_placed" }
): number {
  if (!opts.proposalId && !opts.refId) return 0;
  const db = getDb();
  const clauses: string[] = [];
  const params: unknown[] = [userId];
  if (opts.proposalId) {
    clauses.push("json_extract(payload, '$.proposalId') = ?");
    params.push(opts.proposalId);
  }
  if (opts.refId) {
    clauses.push("json_extract(payload, '$.refId') = ?");
    params.push(opts.refId);
  }
  const rows = db
    .prepare(
      `SELECT id, title, payload FROM notification_events
       WHERE user_id = ? AND type = 'run_failed' AND acknowledged_at IS NULL AND (${clauses.join(" OR ")})`
    )
    .all(...params) as Array<{ id: string; title: string; payload: string }>;
  const now = new Date().toISOString();
  let resolved = 0;
  for (const row of rows) {
    let payload: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(row.payload);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) payload = parsed as Record<string, unknown>;
    } catch {
      payload = {};
    }
    const reconcile = typeof payload.reconcile === "string" ? payload.reconcile : undefined;
    // Only an UNCERTAIN alert is resolvable on confirmation. A `declined` alert is a standing fact
    // (never auto-acked here); a `not_placed`/`placed`/plain-run-failed row is out of scope (those
    // self-clear via the normal sweep). Legacy rows (no marker) fall back to the title text.
    const isUncertain =
      reconcile === "uncertain" ||
      (reconcile === undefined && /verify with broker|placement uncertain/i.test(row.title));
    if (!isUncertain) continue;
    const info = db
      .prepare("UPDATE notification_events SET acknowledged_at = ? WHERE id = ? AND user_id = ? AND acknowledged_at IS NULL")
      .run(now, row.id, userId);
    resolved += info.changes;
  }
  if (resolved > 0) {
    audit("order_placement_uncertain_resolved", { proposalId: opts.proposalId, refId: opts.refId, resolution: opts.resolution, resolved }, userId);
  }
  return resolved;
}

/** The same "attention" criteria the Alert Center's default pill uses (kept in sync with
 *  app/console/components/alert-center.tsx's matchesFilter). Bulk-ack currently only supports this
 *  one filter — the caller passes it explicitly so the intent is visible at call sites. */
const ATTENTION_TYPES: readonly NotificationEventType[] = [
  "kill_switch",
  "run_failed",
  "budget_alert",
  "provider_degraded",
  "earningscalls_entitlement_blocked",
  "roic_status_advisory",
  "risk_advisory"
];

/** Bulk-acknowledge every currently-unacknowledged row matching the given filter, scoped to the
 *  requesting user. When connectedAccountId is provided, also scoped to that account (or
 *  account-less rows) — matches the Alert Center's own account-scoping (inScopeNotifications in
 *  app/console/components/alert-center.tsx), so "Acknowledge all" never silently acks alerts from
 *  another connected account that the user never saw in the current view. Returns the number of
 *  rows changed. */
export function acknowledgeAllNotificationEvents(userId: string, filter: "attention" = "attention", connectedAccountId?: string): number {
  void filter; // only "attention" is supported today — kept as a param for a legible call site + future filters.
  const now = new Date().toISOString();
  const typePlaceholders = ATTENTION_TYPES.map(() => "?").join(", ");
  const accountClause = connectedAccountId ? "AND (connected_account_id = ? OR connected_account_id IS NULL)" : "";
  const params: unknown[] = [now, userId, ...ATTENTION_TYPES];
  if (connectedAccountId) params.push(connectedAccountId);
  const result = getDb()
    .prepare(
      `UPDATE notification_events
       SET acknowledged_at = ?
       WHERE user_id = ? AND acknowledged_at IS NULL AND (type IN (${typePlaceholders}) OR status = 'failed') ${accountClause}`
    )
    .run(...params);
  return result.changes;
}

/**
 * Lazy auto-ack sweep — called from the dashboard snapshot build (cheap, no cron). Clears alerts
 * whose underlying condition is now PROVABLY resolved:
 *   1. pending_approval rows whose proposal left "proposed" status (approved/rejected/placed/
 *      withdrawn/expired/etc.) — the row is asking you to approve something that's no longer pending.
 *   2. run_failed rows for an account whose latest COMPLETED run finished after the alert fired —
 *      the account has since run successfully, so the failure it warned about is stale.
 * Bounded to rows newer than SWEEP_MAX_AGE_DAYS and a batch of SWEEP_BATCH_LIMIT per type per call —
 * older/larger backlogs (e.g. the 137 pending_approval orphans in prod) clear organically over a few
 * calls rather than in one large sweep. Returns the total number of rows acknowledged.
 */
export function sweepAutoAcknowledgeNotifications(userId: string = "local"): number {
  const db = getDb();
  const cutoff = new Date(Date.now() - SWEEP_MAX_AGE_DAYS * 24 * 60 * 60_000).toISOString();
  const now = new Date().toISOString();
  let acknowledged = 0;

  const pendingApprovalRows = db
    .prepare(
      `SELECT id, json_extract(payload, '$.proposalId') AS proposal_id
       FROM notification_events
       WHERE user_id = ? AND type = 'pending_approval' AND acknowledged_at IS NULL AND created_at >= ?
       ORDER BY created_at ASC
       LIMIT ?`
    )
    .all(userId, cutoff, SWEEP_BATCH_LIMIT) as Array<{ id: string; proposal_id: string | null }>;

  const resolvedPendingApprovalIds: string[] = [];
  for (const row of pendingApprovalRows) {
    if (!row.proposal_id) continue;
    const proposal = db
      .prepare("SELECT status FROM trade_proposals WHERE id = ? AND user_id = ?")
      .get(row.proposal_id, userId) as { status: string } | undefined;
    // "Left pending" = the proposal exists and is no longer sitting in "proposed" status. A missing
    // proposal row is left alone (nothing to prove the condition resolved) rather than auto-acked.
    if (proposal && proposal.status !== "proposed") resolvedPendingApprovalIds.push(row.id);
  }
  if (resolvedPendingApprovalIds.length > 0) {
    const placeholders = resolvedPendingApprovalIds.map(() => "?").join(", ");
    const result = db
      .prepare(`UPDATE notification_events SET acknowledged_at = ? WHERE id IN (${placeholders}) AND user_id = ? AND acknowledged_at IS NULL`)
      .run(now, ...resolvedPendingApprovalIds, userId);
    acknowledged += result.changes;
  }

  const runFailedRows = db
    .prepare(
      `SELECT id, created_at, connected_account_id, title, payload
       FROM notification_events
       WHERE user_id = ? AND type = 'run_failed' AND acknowledged_at IS NULL AND created_at >= ?
         AND connected_account_id IS NOT NULL
       ORDER BY created_at ASC
       LIMIT ?`
    )
    .all(userId, cutoff, SWEEP_BATCH_LIMIT) as Array<{ id: string; created_at: string; connected_account_id: string; title: string; payload: string }>;

  const resolvedRunFailedIds: string[] = [];
  for (const row of runFailedRows) {
    // Broker-verification/decline alerts are never "resolved" by a later successful run — skip them
    // regardless of what the account's latest completed run shows. See isBrokerVerificationRunFailed.
    let payload: unknown;
    try {
      payload = JSON.parse(row.payload);
    } catch {
      payload = {};
    }
    if (isBrokerVerificationRunFailed(row.title, payload)) continue;
    const latestCompletedRun = db
      .prepare(
        `SELECT started_at, finished_at FROM strategy_runs
         WHERE user_id = ? AND connected_account_id = ? AND status = 'completed'
         ORDER BY started_at DESC LIMIT 1`
      )
      .get(userId, row.connected_account_id) as { started_at: string; finished_at: string | null } | undefined;
    if (latestCompletedRun) {
      const resolvedAt = latestCompletedRun.finished_at ?? latestCompletedRun.started_at;
      if (resolvedAt > row.created_at) resolvedRunFailedIds.push(row.id);
    }
  }
  if (resolvedRunFailedIds.length > 0) {
    const placeholders = resolvedRunFailedIds.map(() => "?").join(", ");
    const result = db
      .prepare(`UPDATE notification_events SET acknowledged_at = ? WHERE id IN (${placeholders}) AND user_id = ? AND acknowledged_at IS NULL`)
      .run(now, ...resolvedRunFailedIds, userId);
    acknowledged += result.changes;
  }

  return acknowledged;
}
