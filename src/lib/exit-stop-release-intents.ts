// Durable intent rows for "an approved exit released the app's own resting protective stop"
// (src/lib/exit-stop-release.ts).  Kept in its own tiny module so both the release sequence and
// the protective-stop reconciler (src/lib/broker-protective-stops.ts) can read and write it
// without an import cycle.
//
// Storage: the key/value `settings` table via the internal-setting helpers, keyed
// `exit_stop_release:<userId>:<accountNumber>:<SYMBOL>` — the same pattern the owner-cancel
// tombstones use (order-provenance.ts).  No schema migration: open lane PRs already claim the
// next migration numbers, and a version collision would silently skip a migration in prod.
//
// Lifecycle (one row per user + account + symbol; the account-mutation lease serializes writers):
//   releasing       -> written BEFORE the first broker cancel.  The stop rows still exist.
//   released        -> every released stop is confirmed cancelled (or filled) and its
//                      broker_protective_stops row is gone.  The exit has not been sent yet.
//   exit_submitted  -> the exit placement returned (or threw).  Protection for any remainder is
//                      owed; the reconciler picks this row up immediately.
//   restore_pending -> a reconcile pass ran but could not yet restore protection (halted,
//                      order list unavailable, trailing stop not armable).  Retried every pass.
// A row in `releasing` or `released` is only treated as abandoned (process died mid-sequence)
// once it is older than EXIT_STOP_RELEASE_STALE_MS.  The row is deleted once protection is
// restored, the position is closed, or live exit orders cover the whole position.

import { normalizeSymbol } from "./money";
import {
  deleteInternalSetting,
  getInternalSetting,
  listInternalSettingKeysByPrefix,
  setInternalSetting
} from "./db-settings";

export const EXIT_STOP_RELEASE_KEY_PREFIX = "exit_stop_release:";

/**
 * A `releasing`/`released` row older than this is abandoned: the release sequence runs inside one
 * account-mutation lease and finishes in seconds (cancel settle polling is capped at ~10s per stop),
 * so a row this old means the process died or the lease was lost between the cancel and the exit.
 */
export const EXIT_STOP_RELEASE_STALE_MS = 90_000;

export type ExitStopReleasePhase = "releasing" | "released" | "exit_submitted" | "restore_pending";

export interface ReleasedStopSnapshot {
  rowId: string;
  brokerOrderId: string;
  quantity: number;
  stopPrice: number;
  kind: "fixed" | "trailing";
  trailPercent?: number;
  /** The broker's CURRENT trigger for the order when it was released (a native trail moves it). */
  brokerStopPrice?: number;
}

export interface ExitStopReleaseIntent {
  userId: string;
  accountNumber: string;
  connectedAccountId?: string;
  symbol: string;
  exitSide: "sell" | "cover";
  lane: "autopilot" | "approval";
  proposalId?: string;
  runId?: string;
  phase: ExitStopReleasePhase;
  stops: ReleasedStopSnapshot[];
  /** Reconcile passes that ran without restoring protection (restore_pending retries). */
  restoreAttempts: number;
  createdAt: string;
  updatedAt: string;
}

function accountPrefix(userId: string, accountNumber: string): string {
  return `${EXIT_STOP_RELEASE_KEY_PREFIX}${userId}:${accountNumber}:`;
}

export function exitStopReleaseKey(userId: string, accountNumber: string, symbol: string): string {
  return `${accountPrefix(userId, accountNumber)}${normalizeSymbol(symbol)}`;
}

export function getExitStopReleaseIntent(
  userId: string,
  accountNumber: string,
  symbol: string
): ExitStopReleaseIntent | undefined {
  return getInternalSetting<ExitStopReleaseIntent>(exitStopReleaseKey(userId, accountNumber, symbol));
}

export function putExitStopReleaseIntent(intent: ExitStopReleaseIntent): void {
  setInternalSetting(exitStopReleaseKey(intent.userId, intent.accountNumber, intent.symbol), {
    ...intent,
    symbol: normalizeSymbol(intent.symbol),
    updatedAt: new Date().toISOString()
  });
}

export function updateExitStopReleasePhase(
  userId: string,
  accountNumber: string,
  symbol: string,
  phase: ExitStopReleasePhase,
  patch: Partial<Pick<ExitStopReleaseIntent, "restoreAttempts">> = {}
): ExitStopReleaseIntent | undefined {
  const current = getExitStopReleaseIntent(userId, accountNumber, symbol);
  if (!current) return undefined;
  const next: ExitStopReleaseIntent = { ...current, ...patch, phase, updatedAt: new Date().toISOString() };
  setInternalSetting(exitStopReleaseKey(userId, accountNumber, symbol), next);
  return next;
}

export function deleteExitStopReleaseIntent(userId: string, accountNumber: string, symbol: string): void {
  deleteInternalSetting(exitStopReleaseKey(userId, accountNumber, symbol));
}

/** Every release intent recorded for this user + account (any phase). */
export function listExitStopReleaseIntents(userId: string, accountNumber: string): ExitStopReleaseIntent[] {
  const out: ExitStopReleaseIntent[] = [];
  for (const key of listInternalSettingKeysByPrefix(accountPrefix(userId, accountNumber))) {
    const row = getInternalSetting<ExitStopReleaseIntent>(key);
    if (row && typeof row.symbol === "string") out.push(row);
  }
  return out;
}

/**
 * True when the reconciler owes this intent a protection restore on THIS pass: the exit was
 * submitted (or a previous pass could not restore yet), or the sequence was abandoned mid-way.
 */
export function exitStopReleaseNeedsRestore(intent: ExitStopReleaseIntent, nowMs: number = Date.now()): boolean {
  if (intent.phase === "exit_submitted" || intent.phase === "restore_pending") return true;
  const updated = Date.parse(intent.updatedAt);
  return !Number.isFinite(updated) || nowMs - updated >= EXIT_STOP_RELEASE_STALE_MS;
}
