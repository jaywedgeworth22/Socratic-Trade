import { PayloadTooLargeError, readJsonWithLimit } from "@/lib/bounded-body";
import { authorizeOpsRequest } from "@/lib/ops-auth";
import { parseOpsAccountControlRequest, runOpsAccountControl } from "@/lib/ops-account-control";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const OPS_ACCOUNT_CONTROL_MAX_BYTES = 16 * 1024;

/**
 * Token-gated account control for ONE explicitly named connected account — never the console's
 * selected account.  Runs in the server process so the broker mutation lease, caches and
 * Infisical-injected credentials are the live ones.
 *
 * Headers: `x-ops-token: <secret>` OR `Authorization: Bearer <secret>`
 * Body (JSON, at most 16 KiB):
 *   { "action": "list_working_orders",   "connectedAccountId": "<uuid>" }
 *   { "action": "cancel_working_orders", "connectedAccountId": "<uuid>", "orderIds"?: ["..."], "dryRun"?: true }
 *   { "action": "set_system_state",      "connectedAccountId": "<uuid>", "systemState": "active"|"close_only"|"halted", "dryRun"?: true }
 *
 * Every call that resolves an account is audited as `ops_account_control` (actor "ops-token").
 * Responses never include credentials, raw broker bodies, or full account numbers.
 * Operator wrapper: scripts/ops/account-control.sh.  Runbook: docs/runbooks/ops-account-control.md.
 */
export async function POST(request: Request) {
  if (!authorizeOpsRequest(request)) {
    return NextResponse.json(
      { ok: false, error: "Unauthorized. Set OPS_DIAGNOSTIC_TOKEN and pass x-ops-token or Authorization: Bearer." },
      { status: 401 }
    );
  }

  let raw: unknown;
  try {
    raw = await readJsonWithLimit<unknown>(request, OPS_ACCOUNT_CONTROL_MAX_BYTES);
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      return NextResponse.json({ ok: false, error: "Request body too large" }, { status: 413 });
    }
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = parseOpsAccountControlRequest(raw);
  if (!parsed.ok) return NextResponse.json({ ok: false, error: parsed.error }, { status: 400 });

  const outcome = await runOpsAccountControl(parsed.request);
  return NextResponse.json(outcome.body, { status: outcome.status });
}
