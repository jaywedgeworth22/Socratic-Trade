import { getPolicy, setPolicy } from "@/lib/db";
import { releaseBrokerPlacementPauseToOwner } from "@/lib/broker-health";
import { resolveRequestUserId } from "@/lib/request-user";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const userId = resolveRequestUserId(request);
  const current = getPolicy(userId);
  const next = { ...current, enabled: false, systemState: "halted" as const };
  setPolicy(next, userId);
  // An owner Pause on top of a broker-health auto-pause makes the halt the owner's: a later
  // healthy probe must never auto-resume it (board 687a5fb4).
  releaseBrokerPlacementPauseToOwner({
    userId,
    connectedAccountId: current.connectedAccountId,
    accountNumber: current.accountNumber,
    source: "api/strategy/pause"
  });
  return NextResponse.json(next);
}
