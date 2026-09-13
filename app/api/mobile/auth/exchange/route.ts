import { NextResponse } from "next/server";
import { sessionTokenForCurrentCookie } from "@/lib/auth/session-cookie-names";
import { consumeMobileAuthHandoff } from "@/lib/mobile-auth-handoff";
import { enforceRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { APPLE_AUTH_MAX_BYTES, PayloadTooLargeError, readJsonWithLimit } from "@/lib/bounded-body";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  const clientIp = request.headers.get("cf-connecting-ip")?.trim() || "unknown-ip";
  const limited = enforceRateLimit(clientIp, "mobile/auth/exchange", RATE_LIMITS.oauth);
  if (limited) return limited;

  try {
    const body = (await readJsonWithLimit(request, APPLE_AUTH_MAX_BYTES)) as {
      code?: unknown;
      codeVerifier?: unknown;
    };
    if (typeof body.code !== "string" || typeof body.codeVerifier !== "string") {
      return NextResponse.json({ error: "Missing mobile authentication code." }, { status: 400 });
    }
    const handoff = consumeMobileAuthHandoff({ code: body.code, codeVerifier: body.codeVerifier });
    if (!handoff) {
      return NextResponse.json({ error: "Mobile authentication code is invalid or expired." }, { status: 401 });
    }

    const reissued = await sessionTokenForCurrentCookie({
      sessionToken: handoff.sessionToken,
      cookieName: handoff.cookieName,
      secret: process.env.AUTH_SECRET,
    });
    if (!reissued) {
      return NextResponse.json({ error: "Mobile authentication code is invalid or expired." }, { status: 401 });
    }

    const response = NextResponse.json({ success: true });
    response.cookies.set(reissued.cookieName, reissued.token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: reissued.maxAge ?? 30 * 24 * 60 * 60,
      ...(process.env.AUTH_COOKIE_DOMAIN?.trim() ? { domain: process.env.AUTH_COOKIE_DOMAIN.trim() } : {})
    });
    return response;
  } catch (err) {
    if (err instanceof PayloadTooLargeError) {
      return NextResponse.json({ error: "Request body too large" }, { status: 413 });
    }
    if (err instanceof SyntaxError) {
      return NextResponse.json({ error: "Malformed JSON body" }, { status: 400 });
    }
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
