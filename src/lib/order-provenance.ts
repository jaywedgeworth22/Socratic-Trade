import { isBracketOrderClass } from "./broker-side";
import { getDb } from "./db";
import {
  deleteInternalSetting,
  getInternalSetting,
  listInternalSettingKeysByPrefix,
  setInternalSetting
} from "./db-settings";
import { normalizeSymbol } from "./money";
import type { EquityOrder } from "./types";

const OWNER_CANCELLED_PROTECTIVE_STOP_PREFIX = "owner_cancelled_protective_stop:";
const APP_MANAGED_STOP_CLIENT_PREFIXES = ["protstop-", "sstop-"] as const;

export type AutoReplaceProvenanceSkipReason = "bracket_leg" | "not_app_placed" | "owner_cancelled_stop";

export type AppPlacedLookup = {
  userId: string;
  accountNumber: string;
};

function scopedAccount(accountNumber: string): string {
  return accountNumber && accountNumber.trim() !== "" ? accountNumber : "__unassigned__";
}

/** App-minted client_order_id prefixes.  Alpaca also assigns UUIDs to owner-UI orders. */
export function isAppManagedProtectiveStopClientOrderId(clientOrderId: string | undefined): boolean {
  const ref = String(clientOrderId ?? "").trim().toLowerCase();
  return APP_MANAGED_STOP_CLIENT_PREFIXES.some((prefix) => ref.startsWith(prefix));
}

export function isAppMintedClientOrderPrefix(clientOrderId: string | undefined): boolean {
  return isAppManagedProtectiveStopClientOrderId(clientOrderId);
}

function hasTrackedAppOrderIntent(
  clientOrderId: string,
  userId: string,
  accountNumber: string,
  brokerOrderId?: string
): boolean {
  const ref = clientOrderId.trim();
  if (!ref) return false;
  const db = getDb();
  const account = scopedAccount(accountNumber);
  const proposal = db
    .prepare("SELECT 1 FROM trade_proposals WHERE user_id = ? AND account_number = ? AND ref_id = ? LIMIT 1")
    .get(userId, account, ref);
  if (proposal) return true;
  const intent = db
    .prepare(
      "SELECT 1 FROM broker_stop_placement_intents WHERE user_id = ? AND account_number = ? AND client_order_id = ? LIMIT 1"
    )
    .get(userId, account, ref);
  if (intent) return true;
  const synth = db
    .prepare(
      "SELECT 1 FROM synthetic_trailing_stops WHERE user_id = ? AND account_number = ? AND last_attempt_ref_id = ? LIMIT 1"
    )
    .get(userId, account, ref);
  if (synth) return true;
  const replacement = db
    .prepare(
      "SELECT 1 FROM order_replacements WHERE user_id = ? AND account_number = ? AND replacement_ref_id = ? LIMIT 1"
    )
    .get(userId, account, ref);
  if (replacement) return true;
  if (brokerOrderId) {
    const stop = db
      .prepare(
        "SELECT 1 FROM broker_protective_stops WHERE user_id = ? AND account_number = ? AND broker_order_id = ? LIMIT 1"
      )
      .get(userId, account, brokerOrderId);
    if (stop) return true;
  }
  return false;
}

/**
 * App-placed only when the client_order_id uses an app-minted prefix, or a tracked
 * intent / protective-stop / proposal / replacement row matches.  A nonempty Alpaca
 * UUID is not enough — the owner UI mints those too.
 */
export function isAppPlacedBrokerOrder(
  order: Pick<EquityOrder, "clientOrderId" | "id">,
  lookup?: AppPlacedLookup
): boolean {
  if (isAppMintedClientOrderPrefix(order.clientOrderId)) return true;
  const ref = typeof order.clientOrderId === "string" ? order.clientOrderId.trim() : "";
  if (!ref || !lookup) return false;
  try {
    return hasTrackedAppOrderIntent(ref, lookup.userId, lookup.accountNumber, order.id);
  } catch {
    return false;
  }
}

/** Legs of one bracket/OTO/OCO are created together; Alpaca stamps them within milliseconds.
 *  Exported so order-role-context.ts's bracket-sibling grouping uses the same "created together"
 *  window as this file's own contingent-leg detection instead of a second, driftable constant. */
export const CONTINGENT_SIBLING_WINDOW_MS = 5_000;

function brokerWireSide(side: EquityOrder["side"] | undefined): "buy" | "sell" | "" {
  const normalized = String(side ?? "").trim().toLowerCase();
  if (normalized === "buy" || normalized === "cover") return "buy";
  if (normalized === "sell" || normalized === "short") return "sell";
  return "";
}

/**
 * True when `order` is a member of a multi-leg (bracket/OTO/OCO) order group — a contingent leg
 * the app must never treat as a standalone working order (stale alert, auto cancel-replace).
 * However the broker's flat order list labels it:
 *   - state "held" (waiting on its parent entry to fill) — whatever its order_class;
 *   - a bracket-family order_class ("bracket" / "oco" / "oto");
 *   - NO order_class, but a bracket-family sibling in the same listing on the same symbol, on
 *     the opposite wire side, created within a few seconds — Alpaca's leg rows can arrive
 *     without the class, and the 2026-07-08 PG take-profit leg (c6e5334f, Alpaca-minted client
 *     id) looked like an ordinary sell to the stale-exit remediation, which cancelled it and
 *     sold 12 PG the account never held.
 * Deliberately conservative: a false positive only means "the app leaves this order alone".
 */
export function isContingentOrderLeg(
  order: EquityOrder,
  siblings: readonly EquityOrder[] = [],
  options: { brokerEvidenceOnly?: boolean } = {}
): boolean {
  if (String(order.state ?? "").trim().toLowerCase() === "held") return true;
  if (isBracketOrderClass(order.orderClass)) return true;
  // A nearby opposite-side bracket order is only a heuristic, not proof of
  // parentage. Automatic remediation must stay conservative, but a manually
  // confirmed replacement must not be blocked by an unrelated order.
  if (options.brokerEvidenceOnly) return false;
  const symbol = normalizeSymbol(order.symbol);
  const side = brokerWireSide(order.side);
  const createdMs = Date.parse(order.createdAt);
  if (!side || !Number.isFinite(createdMs)) return false;
  return siblings.some((sibling) => {
    if (sibling === order || sibling.id === order.id) return false;
    if (!isBracketOrderClass(sibling.orderClass)) return false;
    if (normalizeSymbol(sibling.symbol) !== symbol) return false;
    const siblingSide = brokerWireSide(sibling.side);
    if (!siblingSide || siblingSide === side) return false;
    const siblingMs = Date.parse(sibling.createdAt);
    return Number.isFinite(siblingMs) && Math.abs(siblingMs - createdMs) <= CONTINGENT_SIBLING_WINDOW_MS;
  });
}

/**
 * Returns a skip reason when automated stale-exit cancel-replace must not touch this order.
 * `siblings` is the broker order listing the order came from — required to recognise a leg whose
 * row carries no order_class (see isContingentOrderLeg).
 */
export function autoReplaceProvenanceSkipReason(
  order: EquityOrder,
  lookup?: AppPlacedLookup,
  siblings: readonly EquityOrder[] = [],
  options: { brokerEvidenceOnly?: boolean } = {}
): AutoReplaceProvenanceSkipReason | null {
  if (isContingentOrderLeg(order, siblings, options)) return "bracket_leg";
  if (!isAppPlacedBrokerOrder(order, lookup)) return "not_app_placed";
  if (lookup && hasOwnerCancelledProtectiveStop(lookup.userId, lookup.accountNumber, order.symbol)) return "owner_cancelled_stop";
  return null;
}

function ownerCancelledProtectiveStopKey(userId: string, accountNumber: string, symbol: string): string {
  return `${OWNER_CANCELLED_PROTECTIVE_STOP_PREFIX}${userId}:${accountNumber}:${normalizeSymbol(symbol)}`;
}

/** Tombstone: the owner manually cancelled an app-managed protective stop for this symbol. */
export function recordOwnerCancelledProtectiveStop(userId: string, accountNumber: string, symbol: string): void {
  setInternalSetting(ownerCancelledProtectiveStopKey(userId, accountNumber, symbol), {
    cancelledAt: new Date().toISOString()
  });
}

export function hasOwnerCancelledProtectiveStop(userId: string, accountNumber: string, symbol: string): boolean {
  return Boolean(getInternalSetting(ownerCancelledProtectiveStopKey(userId, accountNumber, symbol)));
}

/**
 * Retire the tombstone.  The tombstone means "do not re-place the stop on the position the
 * owner just un-protected" — it is scoped to THAT position and must not outlive it.  The only
 * caller is the protective-stop reconciler's flat-position sweep; see
 * `broker-protective-stops.ts` for why a flat symbol is positive evidence rather than a failed
 * broker read.
 */
export function clearOwnerCancelledProtectiveStop(userId: string, accountNumber: string, symbol: string): void {
  deleteInternalSetting(ownerCancelledProtectiveStopKey(userId, accountNumber, symbol));
}

/** Every symbol currently carrying an owner-cancel tombstone for this user + account. */
export function listOwnerCancelledProtectiveStopSymbols(userId: string, accountNumber: string): string[] {
  const prefix = `${OWNER_CANCELLED_PROTECTIVE_STOP_PREFIX}${userId}:${accountNumber}:`;
  return listInternalSettingKeysByPrefix(prefix)
    .map((key) => key.slice(prefix.length))
    .filter((symbol) => symbol.length > 0);
}
