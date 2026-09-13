import { cancelWorkingOrder, OrderCancelPreconditionError } from "@/lib/order-cancel";
import { resolveRequestUserId } from "@/lib/request-user";
import { enforceRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * POST /api/orders/cancel — the console's manual cancel.
 *
 * All of the behaviour (lease-interleave receipt, time-bounded cancel-dust advisory, audit trail,
 * dashboard event, dust notification) lives in `src/lib/order-cancel.ts` so the mobile
 * `order.cancel` command executes the SAME path rather than a second, drifting one. This route is
 * the HTTP shell: auth, rate limit, status mapping.
 *
 * No typed confirmation, by design: cancelling is risk-REDUCING and stays available even while the
 * system is stopped. Typed confirmation is the ceremony for opening live risk, not closing it.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { orderId?: unknown } | null;
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const { orderId } = body;
  const userId = resolveRequestUserId(request);
  const limited = enforceRateLimit(userId, "orders/cancel", RATE_LIMITS.orders);
  if (limited) return limited;
  try {
    const result = await cancelWorkingOrder({ userId, orderId: String(orderId ?? ""), source: "console" });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof OrderCancelPreconditionError) {
      return new NextResponse(error.message, { status: error.status });
    }
    throw error;
  }
}
