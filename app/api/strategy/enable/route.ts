import { getPolicy, setPolicy } from "@/lib/db";
import { verifyAutonomyArmingPreconditions } from "@/lib/autonomy-arming";
import { resolveRequestUserId } from "@/lib/request-user";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * POST /api/strategy/enable — the console's Start button for the SELECTED account.  The arming
 * checks live in src/lib/autonomy-arming.ts so the ops account-control route runs the same ones.
 */
export async function POST(request: Request) {
  const userId = resolveRequestUserId(request);
  const policy = getPolicy(userId);
  const check = await verifyAutonomyArmingPreconditions(policy, userId);
  if (!check.ok) return new NextResponse(check.message, { status: 400 });
  const next = { ...policy, systemState: "active" as const };
  setPolicy(next, userId);
  return NextResponse.json(next);
}
