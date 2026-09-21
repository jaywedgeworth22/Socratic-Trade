// Auth.js v5 (next-auth@beta) configuration.
//
// Strategy: JWT sessions (stateless — no DB adapter needed). The `jwt` callback
// embeds the verified email into the token; the `session` callback exposes it to
// server components / route handlers that call `auth()`.
//
// Required env vars to ACTIVATE (see .env.example):
//   AUTH_SECRET        — openssl rand -base64 32
//
// Optional OAuth providers (at least one required for sign-in):
//   AUTH_GOOGLE_ID / AUTH_GOOGLE_SECRET — Google Cloud Console OAuth 2.0 client
//   AUTH_GITHUB_ID / AUTH_GITHUB_SECRET — GitHub OAuth App (Settings → Developer)
//   AUTH_APPLE_ID / AUTH_APPLE_SECRET   — Apple Services ID + client-secret JWT
//     Note: Apple only sends the user's email on the FIRST authorization. The email
//     is stored in the session JWT cookie (30-day lifetime). If the session expires and
//     the user re-authorizes with Apple alone, sign-in will fail (Apple won't re-send
//     the email). Keep at least one other provider active or ensure the session lifetime
//     covers normal usage patterns.
//
// When AUTH_SECRET is NOT set the Auth.js path is simply never triggered
// (authConfigured returns false in middleware.ts and the primary-email fallback
// remains active).

import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import GitHub from "next-auth/providers/github";
import Apple from "next-auth/providers/apple";
import Twitter from "next-auth/providers/twitter";
import type { Account, Profile, Session, User } from "next-auth";
import type { JWT } from "next-auth/jwt";
import type { Provider } from "next-auth/providers";
import { canonicalizeLegacyAuthEnv } from "../public-origin";
import { isAppleWebAuthConfigured, resolveAppleClientSecret } from "./apple-web";
import { normalizeAuthEmail, selectVerifiedGitHubEmail, type GitHubEmail } from "./github-email";
import { cookies } from "next/headers";
import { getDrizzle } from "../db/client";
import { sessions } from "../db/schema";
import { randomUUID } from "node:crypto";
import { decodeSessionToken, encodeSessionToken } from "./session-token";

type EmailProfile = Profile & {
  email?: string | null;
  name?: string | null;
  picture?: string | null;
  avatar_url?: string | null;
  login?: string | null;
};
type SessionWithProvider = Session & { loginProvider?: string };

canonicalizeLegacyAuthEnv(process.env);

const providers: Provider[] = [];

if (process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET) {
  providers.push(
    Google({
      clientId: process.env.AUTH_GOOGLE_ID,
      clientSecret: process.env.AUTH_GOOGLE_SECRET
    })
  );
}

if (process.env.AUTH_GITHUB_ID && process.env.AUTH_GITHUB_SECRET) {
  providers.push(
    GitHub({
      clientId: process.env.AUTH_GITHUB_ID,
      clientSecret: process.env.AUTH_GITHUB_SECRET,
      authorization: { params: { scope: "read:user user:email" } }
    })
  );
}

if (process.env.AUTH_TWITTER_ID && process.env.AUTH_TWITTER_SECRET) {
  providers.push(
    Twitter({
      clientId: process.env.AUTH_TWITTER_ID,
      clientSecret: process.env.AUTH_TWITTER_SECRET
    })
  );
}

if (isAppleWebAuthConfigured()) {
  const appleSecret = resolveAppleClientSecret();
  if (appleSecret && process.env.AUTH_APPLE_ID) {
    providers.push(
      Apple({
        clientId: process.env.AUTH_APPLE_ID,
        clientSecret: appleSecret
      })
    );
  }
}

async function verifiedGitHubEmail(accessToken: string | undefined, fallbackEmail?: string | null): Promise<string | undefined> {
  if (!accessToken) return undefined;
  try {
    const response = await fetch("https://api.github.com/user/emails", {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${accessToken}`,
        "x-github-api-version": "2022-11-28"
      }
    });
    if (!response.ok) return undefined;
    const emails = (await response.json()) as GitHubEmail[];
    return selectVerifiedGitHubEmail(emails, fallbackEmail);
  } catch {
    return undefined;
  }
}

// Cross-subdomain session cookie: only when AUTH_COOKIE_DOMAIN is set (e.g. ".socratictrade.com"),
// so a login on socratictrade.com is also recognized at admin.socratictrade.com. Unset (the default)
// keeps the standard host-only cookie — zero behavior change. Changing this in production re-scopes
// the session cookie, so existing sessions must sign in again once.
const authCookieDomain = process.env.AUTH_COOKIE_DOMAIN?.trim();

export const { handlers, signIn, signOut, auth } = NextAuth({
  trustHost: true,
  ...(authCookieDomain
    ? {
        cookies: {
          sessionToken: {
            name: process.env.NODE_ENV === "production" ? "__Secure-authjs.session-token" : "authjs.session-token",
            options: {
              httpOnly: true,
              sameSite: "lax" as const,
              path: "/",
              secure: process.env.NODE_ENV === "production",
              domain: authCookieDomain
            }
          }
        }
      }
    : {}),
  providers,
  session: { strategy: "jwt" },
  jwt: {
    encode: encodeSessionToken,
    decode: decodeSessionToken
  },
  callbacks: {
    async redirect({ url, baseUrl }: { url: string; baseUrl: string }) {
      // Allows relative callback URLs starting with a single '/' (not '//' or '/\')
      if (url.startsWith("/") && !url.startsWith("//") && !url.startsWith("/\\")) {
        return `${baseUrl}${url}`;
      }
      try {
        const parsed = new URL(url);
        if (parsed.origin === baseUrl) {
          return url;
        }
      } catch {
        // invalid URL
      }
      return baseUrl;
    },
    // Gate GitHub and Apple sign-ins.
    // - GitHub: the built-in provider picks the primary email from /user/emails without
    //   checking the `verified` flag. We call /user/emails ourselves to confirm the
    //   selected email is actually verified before allowing the session.
    // - Apple: only sends the email on the FIRST authorization. If null, the user is
    //   re-authorizing after their session expired — sign-in fails, no email to verify.
    async signIn({
      account,
      profile
    }: {
      account?: { provider?: string; access_token?: string } | null;
      profile?: { email?: string | null };
    }) {
      if (!profile?.email) return account?.provider === "github" || account?.provider === "apple" || account?.provider === "twitter" ? false : true;
      if (account?.provider === "github" && account.access_token) {
        const res = await fetch("https://api.github.com/user/emails", {
          headers: { Authorization: `Bearer ${account.access_token}`, "User-Agent": "authjs" }
        });
        if (!res.ok) return false; // fail closed on API error or rate-limit
        const emails: Array<{ email: string; verified: boolean }> = await res.json();
        const match = emails.find((e) => e.email.toLowerCase() === (profile.email as string).toLowerCase());
        if (!match?.verified) return false;
      }
      return true;
    },
    // Persist the email, name, picture, and login provider in the JWT so they survive
    // across requests without a DB lookup.
    async jwt({ token, user, account, profile }: { token: JWT; user?: User; account?: Account | null; profile?: EmailProfile }) {
      let email = normalizeAuthEmail(user?.email ?? profile?.email);
      if (account?.provider === "github" && !email) {
        email = await verifiedGitHubEmail(account.access_token, profile?.email);
      }
      if (email) {
        token.email = email;
      }
      const name = user?.name ?? profile?.name ?? profile?.login;
      const image = user?.image ?? profile?.picture ?? profile?.avatar_url;
      if (name) token.name = name;
      if (image) token.picture = image;
      if (account?.provider) token.loginProvider = account.provider;
      // Bind account recreation to an actual provider sign-in, not JWT rolling refresh. The
      // middleware forwards this trusted claim so a pre-deletion cookie cannot clear a tombstone.

      if (account?.provider) {
        token.loginAt = Date.now();
        token.sessionId = randomUUID();
        let mobileNonce = null;
        try {
          const cookieStore = await cookies();
          const challenge = cookieStore.get("__Secure-mobile-challenge");
          if (challenge?.value) {
            mobileNonce = challenge.value;
            cookieStore.delete("__Secure-mobile-challenge");
          }
        } catch (err) {}
        
        try {
          const db = getDrizzle();
          const expiresAt = Math.floor(Date.now() / 1000) + (30 * 24 * 60 * 60);
          db.insert(sessions).values({
            id: token.sessionId,
            email: token.email || "unknown",
            created_at: new Date().toISOString(),
            expires_at: expiresAt.toString(),
            mobile_nonce: mobileNonce
          }).run();
        } catch (err) {
          console.error("Failed to insert session", err);
        }
      }

      return token;
    },
    // Expose display identity on the `session` object returned by `auth()`.
    session({ session, token }: { session: Session; token: JWT }) {
      session.user = session.user ?? {};
      if (token.email && typeof token.email === "string") {
        session.user.email = token.email;
      }
      if (token.name && typeof token.name === "string") {
        session.user.name = token.name;
      }
      if (token.picture && typeof token.picture === "string") {
        session.user.image = token.picture;
      }
      if (token.loginProvider && typeof token.loginProvider === "string") {
        (session as SessionWithProvider).loginProvider = token.loginProvider;
      }
      return session;
    }
  },
  pages: {
    signIn: "/login",
    error: "/access-denied"
  }
});
