import { signIn } from "@/lib/auth/auth";
import { sameOriginCallback } from "@/lib/mobile-auth-start";
import { resolvePublicAppOrigin } from "@/lib/public-origin";
import { NextResponse } from "next/server";
import { cookies } from "next/headers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Providers the web OAuth flow supports.  Apple sign-in is native-only on iOS
// (/api/mobile/auth/apple) and is deliberately not in this set.
const WEB_AUTH_PROVIDERS = new Set(["google", "github", "twitter"]);

// Auth.js signIn() aborts the handler by throwing Next's redirect control error.
// That throw IS the success path here — only real errors may fall through.
function isNextRedirectError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    typeof (error as { digest?: unknown }).digest === "string" &&
    ((error as { digest: string }).digest.startsWith("NEXT_REDIRECT"))
  );
}


// GET initiator for the native iOS web-auth flow.  ASWebAuthenticationSession can
// only perform a top-level GET navigation, but Auth.js v5 initiates OAuth solely on
// POST (a GET of /api/auth/signin/<provider> is an UnknownAction that lands on
// /access-denied?error=Configuration).  This route bridges the gap: it validates the
// provider + callback, then calls the server-side signIn(), which sets the state/PKCE
// cookies and redirects to the provider's authorization URL.  middleware.ts rewrites
// the legacy GET /api/auth/signin/<provider> entry (used by already-shipped iOS
// builds) to this route.
export async function GET(request: Request) {
  const url = new URL(request.url);
  // Never request.url (INTERNAL container origin) and never X-Forwarded-Host
  // (client-influenceable) — see src/lib/mobile-auth-start.ts.
  const origin = resolvePublicAppOrigin(request);
  const provider = url.searchParams.get("provider") ?? "";
  const codeChallenge = new URL(callbackUrl).searchParams.get("code_challenge");
  if (codeChallenge) {
    (await cookies()).set("__Secure-mobile-challenge", codeChallenge, { httpOnly: true, secure: process.env.NODE_ENV === "production", path: "/", maxAge: 600 });
  }
  const callbackUrl = sameOriginCallback(url.searchParams.get("callbackUrl"), origin);
  const loginFallback = new URL(`/login?callbackUrl=${encodeURIComponent(callbackUrl)}`, origin);

  if (!WEB_AUTH_PROVIDERS.has(provider)) {
    return NextResponse.redirect(loginFallback);
  }

  try {
    await signIn(provider, { redirectTo: callbackUrl });
  } catch (error) {
    if (isNextRedirectError(error)) throw error;
    // Provider unconfigured or initiation failed: land on the login page with the
    // mobile callback preserved so the user can still finish sign-in by hand.
    console.error(`auth-start: signIn(${provider}) failed`, error);
    return NextResponse.redirect(loginFallback);
  }

  // signIn always redirects; this is unreachable in practice.
  return NextResponse.redirect(loginFallback);
}
