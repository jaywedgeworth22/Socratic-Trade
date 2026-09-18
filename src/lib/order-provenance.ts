import { isBracketOrderClass } from "./broker-side";
import { getDb } from "./db";
import { getInternalSetting, setInternalSetting } from "./db-settings";
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

/** Returns a skip reason when automated stale-exit cancel-replace must not touch this order. */
export function autoReplaceProvenanceSkipReason(
  order: EquityOrder,
  lookup?: AppPlacedLookup
): AutoReplaceProvenanceSkipReason | null {
  if (isBracketOrderClass(order.orderClass)) return "bracket_leg";
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
