// Edge-safe Auth.js session verifier for middleware.ts.
//
// This app configures Auth.js to write a compact HS256 JWT through
// `encodeSessionToken`, so middleware can verify the same cookie with narrow,
// edge-safe jose subpath imports and avoid pulling the full next-auth/jose barrel
// into the edge bundle.

import { decodeSessionToken } from "./session-token";

/** Auth.js v5 session cookie names, in preference order. */
const SESSION_COOKIE_NAMES = ["__Secure-authjs.session-token", "authjs.session-token"] as const;

export interface VerifiedSessionIdentity {
  email: string;
  /** Explicit login callback time in milliseconds; unlike JWT iat, this is not rolled on refresh. */
  loginAt?: number;
  sessionId?: string;
}

/**
 * Extracts and verifies the Auth.js session JWT from the request cookies.
 * Returns the verified email string, or null if no valid session is present.
 *
 * Only callable when AUTH_SECRET is set (callers should check first).
 */
export async function getSessionIdentity(
  cookieHeader: string | null,
  authSecret: string
): Promise<VerifiedSessionIdentity | null> {
  if (!cookieHeader || !authSecret) return null;

  // Parse the cookie header into a name→value map.
  const cookies: Record<string, string> = {};
  for (const part of cookieHeader.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    cookies[name] = value;
  }

  // Find the first Auth.js session cookie that is present. Auth.js may chunk
  // large JWT cookies as "<name>.0", "<name>.1", ...; reconstruct those too.
  let token: string | undefined;
  let salt: string | undefined;
  for (const name of SESSION_COOKIE_NAMES) {
    if (cookies[name]) {
      token = cookies[name];
      salt = name;
      break;
    }
    const chunks = Object.entries(cookies)
      .filter(([cookieName]) => cookieName.startsWith(`${name}.`))
      .sort(([left], [right]) => Number(left.split(".").pop() ?? "0") - Number(right.split(".").pop() ?? "0"))
      .map(([, value]) => value);
    if (chunks.length > 0) {
      token = chunks.join("");
      salt = name;
      break;
    }
  }
  if (!token || !salt) return null;

  try {
    const payload = await decodeSessionToken({ token, secret: authSecret, salt });
    const email = payload?.email;
    const loginAt = payload?.loginAt;
    const sessionId = payload?.sessionId;
    if (typeof email === "string" && email.includes("@")) {
      return {
        email: email.trim().toLowerCase(),
        ...(typeof loginAt === "number" && Number.isFinite(loginAt) ? { loginAt } : {}),
        ...(typeof sessionId === "string" ? { sessionId } : {})
      };
    }
    return null;
  } catch {
    // Invalid/expired token — not a valid session.
    return null;
  }
}

/** Back-compatible email-only view for callers that do not need deletion-generation binding. */
export async function getSessionEmail(cookieHeader: string | null, authSecret: string): Promise<string | null> {
  return (await getSessionIdentity(cookieHeader, authSecret))?.email ?? null;
}
