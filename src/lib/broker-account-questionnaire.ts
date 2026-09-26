// broker-account-questionnaire.ts — classifies a Robinhood order-placement rejection that means
// "the account itself needs owner action" (a suitability/compliance questionnaire Robinhood wants
// answered) as a durable ACCOUNT-LEVEL state, instead of a per-order failure retried every run.
//
// Root cause (2026-09-25, board 687a5fb4, lane G3): production evidence on the live Robinhood
// "Agentic" account showed 3 `placing_failed` rejections carrying the message "We're required to
// have you answer some questions about y[our...]" — a `non_field_errors` entry from Robinhood's
// `place_equity_order`. This is NOT a per-order sizing problem (see broker-minimum-guard.ts for
// that): no resizing, retry, or bump fixes it, because Robinhood is refusing NEW positions on this
// account until the owner answers its questions on robinhood.com — a broker-side account gate this
// app cannot satisfy in code. Retrying it every run just repeats the same guaranteed rejection.
//
// This is a CORRECTNESS fix, not a paternalistic cap: it changes what the app does with an order
// the broker has ALREADY refused for an account-level reason, so exits and existing management are
// never touched — only NEW entries pause, and only for the account the broker actually flagged.
import { getInternalSetting, setInternalSetting, deleteInternalSetting } from "./db";

const ACCOUNT_ACTION_REQUIRED_PREFIX = "robinhoodAccountActionRequired";

/** Robinhood's own wording for this class of rejection, matched tolerantly (broker copy can vary
 *  in punctuation/trailing text around this core phrase). Scoped to this one class deliberately —
 *  a generic "any 4xx pauses the account" gate would be far too broad and would swallow ordinary
 *  order-specific rejections that have nothing to do with account status. */
const ACCOUNT_QUESTIONNAIRE_PATTERN = /required to have you answer some questions/i;

export interface AccountActionRequiredState {
  reason: string;
  since: string;
}

/** Returns a human-readable account-action-required reason when `message` (a broker placement
 *  error) is Robinhood's account-questionnaire rejection, else undefined. Never guesses at other
 *  4xx text — only this one documented, evidence-backed pattern. */
export function detectRobinhoodAccountQuestionnaireError(message: string): string | undefined {
  if (!ACCOUNT_QUESTIONNAIRE_PATTERN.test(message)) return undefined;
  return "Robinhood requires you to answer account questions before it will accept new orders on this account. Log in to Robinhood and complete the questionnaire, then this will clear automatically the next time an order is accepted.";
}

function accountActionRequiredKey(userId: string, accountNumber: string): string {
  return `${ACCOUNT_ACTION_REQUIRED_PREFIX}:${userId}:${accountNumber}`;
}

/** Persists the account-level hold. Idempotent — a repeat detection while already marked just
 *  refreshes `since` to the latest occurrence rather than erroring or duplicating state. */
export function markAccountActionRequired(userId: string, accountNumber: string, reason: string): void {
  setInternalSetting(accountActionRequiredKey(userId, accountNumber), { reason, since: new Date().toISOString() });
}

/** Reads the account-level hold, or undefined when the account is not currently held. */
export function getAccountActionRequired(userId: string, accountNumber: string): AccountActionRequiredState | undefined {
  return getInternalSetting<AccountActionRequiredState>(accountActionRequiredKey(userId, accountNumber));
}

/** Clears the hold — called once an OPENING order for this account is actually accepted by the
 *  broker, which is the only reliable signal (from inside this app) that the owner resolved the
 *  questionnaire on Robinhood's side. Safe to call unconditionally when there is nothing to clear. */
export function clearAccountActionRequired(userId: string, accountNumber: string): void {
  deleteInternalSetting(accountActionRequiredKey(userId, accountNumber));
}

const ACCOUNT_ACTION_REQUIRED_ALERT_COOLDOWN_PREFIX = "accountActionRequiredAlertSent";
// This condition does not clear itself run to run (it is a standing broker-side account gate, not
// a transient outage), so re-notifying every run would just be noise until the owner acts — same
// rationale as SUB_MINIMUM_ALERT_COOLDOWN_MS in broker-minimum-guard.ts.
const ACCOUNT_ACTION_REQUIRED_ALERT_COOLDOWN_MS = 24 * 60 * 60_000; // 24 hours

/** Cooldown-gated: returns true (and marks the cooldown) at most once per (user, accountNumber)
 *  per `ACCOUNT_ACTION_REQUIRED_ALERT_COOLDOWN_MS` window. Callers must still skip placing new
 *  entries for this account regardless of this return value; it only gates whether an outward
 *  alert/notification fires this run. */
export function shouldAlertAccountActionRequired(userId: string, accountNumber: string): boolean {
  const key = `${ACCOUNT_ACTION_REQUIRED_ALERT_COOLDOWN_PREFIX}:${userId}:${accountNumber}`;
  const last = getInternalSetting<string>(key);
  if (last && Date.now() - Date.parse(last) < ACCOUNT_ACTION_REQUIRED_ALERT_COOLDOWN_MS) return false;
  setInternalSetting(key, new Date().toISOString());
  return true;
}
