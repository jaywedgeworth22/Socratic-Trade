import { getBrokerGateway } from "./broker";
import { messageFromUnknownError } from "./recoverable-issue";
import type { BrokerageAccount, TradingPolicy } from "./types";

/**
 * The arming preconditions for `systemState: "active"` — THE checks the console's Start button
 * (POST /api/strategy/enable) runs, extracted verbatim so the ops account-control route
 * (POST /api/ops/account-control, action `set_system_state`) runs the SAME checks instead of a
 * second copy that could drift.  Messages and order are unchanged from the route; they are pinned
 * by test/strategy-enable-route.test.ts.
 *
 * Scope is whatever account `policy` resolves to: the console passes the selected account's policy
 * (`getPolicy(userId)`), the ops route passes an explicit account's (`getPolicy(userId, id)`).  The
 * broker read goes through `getBrokerGateway(policy, userId)`, which resolves credentials from
 * `policy.connectedAccountId`, so it is always that account's own broker login.
 *
 * Correctness checks only (an account to arm, something to trade, a broker that answers and allows
 * agentic orders) — no confirmation ceremony, per the product philosophy in AGENTS.md.
 */
export type AutonomyArmingCheck =
  | { ok: true; account: BrokerageAccount }
  | { ok: false; message: string };

/**
 * The synchronous half of the arming checks (an account to arm, something to trade), in the same
 * order and with the same messages.  Exported so a caller that awaited the broker half can re-run
 * it inside its write transaction against a freshly read policy: a concurrent edit that empties the
 * universe while the broker check is in flight must not end up armed.
 */
export function checkAutonomyArmingPolicyPreconditions(policy: TradingPolicy): string | undefined {
  if (!policy.accountNumber) return "Select an account before enabling autonomy.";
  if (policy.includedIndices.length === 0 && policy.additionalSymbols.length === 0) {
    return "Select at least one base index or additional watchlist symbol before enabling autonomy.";
  }
  return undefined;
}

export async function verifyAutonomyArmingPreconditions(policy: TradingPolicy, userId: string): Promise<AutonomyArmingCheck> {
  const policyProblem = checkAutonomyArmingPolicyPreconditions(policy);
  if (policyProblem) return { ok: false, message: policyProblem };
  let accounts: BrokerageAccount[];
  try {
    accounts = await getBrokerGateway(policy, userId).getAccounts();
  } catch (error) {
    return { ok: false, message: `Selected broker account is not reachable: ${messageFromUnknownError(error)}` };
  }
  const account = accounts.find((item) => item.accountNumber === policy.accountNumber);
  if (!account) return { ok: false, message: "Selected account is not available." };
  if (!account.agenticAllowed) return { ok: false, message: "Selected account is not agentic_allowed." };
  return { ok: true, account };
}
