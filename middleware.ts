// Edge auth gate (Phase-11 M6). Runs before every non-static request.
//
// Identity sources (first match wins):
//   1. Cloudflare Access header (when CF_ACCESS_TRUST_EMAIL_HEADER=1) — the header is NEVER
//      trusted on its own: CF_ACCESS_TEAM_DOMAIN + CF_ACCESS_AUD must also be configured, and the
//      request's Cf-Access-Jwt-Assertion is verified against the team's JWKS (audience-checked)
//      before the header email is trusted. See getCfEmail / verifyCfAccessAssertion below.
//   2. Auth.js v5 session JWT cookie — verified with the same edge-safe HS256
//      helper configured in src/lib/auth/auth.ts.
//   3. Dev/local fallback to PRIMARY_USER_EMAIL — ONLY when auth is NOT configured.
//
// Fail-closed signal ("authConfigured"):
//   authConfigured = !!AUTH_SECRET || isFlagOn(CF_ACCESS_TRUST_EMAIL_HEADER)
//
// This deliberately does NOT use `process.env.NODE_ENV === "production"` because
// Next.js inlines NODE_ENV at BUILD time in the edge runtime — so at runtime in the
// live deployment isProd is always false, causing every request to fail OPEN to the
// primary-email fallback (the IDOR bug this rework closes).
//
// When authConfigured=true and no verified identity is found → FAIL CLOSED (401 for
// /api/*, redirect to /login for pages). When authConfigured=false (local dev
// / tests with no auth env) → fall back to PRIMARY_EMAIL, preserving existing behavior.
// Cloudflare Tunnel may still front the app, but Cloudflare Access email headers are
// not trusted as an app login source.

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { createRemoteJWKSet } from "jose/jwks/remote";
import { jwtVerify } from "jose/jwt/verify";
import {
  AUTHENTICATED_IDENTITY_SOURCE_HEADER,
  AUTHENTICATED_SESSION_ISSUED_AT_HEADER,
  AUTHENTICATED_IDENTITY_SOURCES,
  stripClientIdentityHeaders,
  type AuthenticatedIdentitySource
} from "./src/lib/auth/strip-identity";
import { checkSameOrigin } from "./src/lib/auth/csrf";
import { isAdminEmail } from "./src/lib/auth/admin-emails";
import { getSessionIdentity } from "./src/lib/auth/session-edge";
import { isLiveBootstrap } from "./src/lib/auth-secret-guard";

const PRIMARY_EMAIL = (process.env.PRIMARY_USER_EMAIL || "mail@jays.services").trim().toLowerCase();
// The primary operator's aliases — additional addresses that map to the same primary account. Kept in sync
// with src/lib/auth/identity.ts (which does the email→userId mapping in the Node runtime).
const PRIMARY_SET = new Set(
  [PRIMARY_EMAIL, ...(process.env.PRIMARY_USER_EMAIL_ALIASES || "").split(",")]
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
);
const ALLOWED = (process.env.ALLOWED_EMAILS || "")
  .split(",")
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

// Paths that never require a user identity.
const PUBLIC_PREFIXES = [
  "/api/health",
  "/api/live",
  "/api/ops",
  "/api/webhooks",
  "/api/csp-report",
  "/api/framework",
  "/access-denied",
  "/login",
  "/logout",
  // Crawler/metadata files: these MUST be anonymously reachable or robots
  // rules never reach crawlers (a robots.txt that 307s to /login parses as
  // "no rules"). Discovered live 2026-07-11: production redirected all three.
  "/robots.txt",
  "/sitemap.xml",
  // Kill-switch worker for leftover PWA installs.  Must stay anonymous so a
  // controlling worker can fetch the update instead of an auth HTML redirect.
  "/sw.js",
  // Apple's CDN fetches this anonymously to verify the universal-link claim; behind auth it
  // 307s to /login and the domain never claims the iOS app (app/.well-known/...
  // apple-app-site-association/route.ts).
  "/.well-known/apple-app-site-association",
  "/welcome",
  "/strategy",
  "/framework",
  // Sentry browser tunnel (next.config.mjs tunnelRoute). Must stay anonymous
  // so ad-blocked clients can still deliver envelopes. Matcher also excludes it.
  "/monitoring",
  "/how-it-works",
  "/design/socratic-trade",
  "/privacy-policy",
  "/terms-and-conditions",
  "/api/mobile/auth/apple",
  // GET OAuth initiator for the native iOS web-auth flow (see the
  // /api/auth/signin/<provider> translation below) — must be reachable signed-out.
  "/api/mobile/auth-start",
];
const AUTHJS_PUBLIC_PATHS = new Set([
  "/api/auth/csrf",
  "/api/auth/error",
  "/api/auth/providers",
  "/api/auth/robinhood/callback",
  "/api/auth/session",
  "/api/auth/signin",
  "/api/auth/signout"
]);

function isPublicPath(pathname: string): boolean {
  if (PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + "/"))) return true;
  if (AUTHJS_PUBLIC_PATHS.has(pathname)) return true;
  return pathname.startsWith("/api/auth/callback/") || pathname.startsWith("/api/auth/signin/");
}

/** True for `/login` and its subpaths. The mobile/console host-routing blocks below must
 *  exempt this (same test as PUBLIC_PREFIXES' own "/login" entry) so a client-side 401
 *  redirect (app/console/lib/api.ts's redirectToLogin, a plain relative `window.location.href
 *  = "/login?..."` navigation) actually reaches the sign-in page on those hosts instead of
 *  being rewritten to the protected `/console/login` (which does not exist as a route and, more
 *  importantly, is not public — an unauthenticated request to it hits the page-level fail-closed
 *  branch below, which redirects back to `/login`, which the host block rewrites to
 *  `/console/login` again: an infinite loop that never shows the sign-in page). */
function isLoginPath(pathname: string): boolean {
  return pathname === "/login" || pathname.startsWith("/login/");
}

/** Token-gated peer-read market routes. Handlers still call verifySecuritiesImportToken.
 *  Keep this list explicit so /api/market/flatfile stays session-gated. */
function isPeerMarketReadPath(pathname: string): boolean {
  return (
    pathname === "/api/market/spx" ||
    pathname === "/api/market/quotes" ||
    pathname.startsWith("/api/market/prices/") ||
    pathname.startsWith("/api/market/intraday/")
  );
}

/**
 * The operator PAGE tree (`/admin`, `/admin/...`) — NOT the `/api/admin/*` routes, which each run
 * their own `requireAdmin()` (and one of which, `/api/admin/securities/import`, deliberately uses a
 * different bearer-token auth model that this gate must not pre-empt).
 *
 * Before this gate existed, every page under `app/admin/**` was reachable by ANY authenticated,
 * allowlisted user: the pages are client components whose data probes 403 individually, so a
 * non-admin saw the full admin chrome, nav and page structure and only the numbers were withheld.
 * Gating the tree here covers all ten pages at one point, including `app/admin/page.tsx`.
 */
function isAdminPagePath(pathname: string): boolean {
  return pathname === "/admin" || pathname.startsWith("/admin/");
}

// --- Security response headers -------------------------------------------------
//
// Applied to EVERY response the middleware returns (allowed, 401, 403, redirects). X-Frame-Options
// and Referrer-Policy are unconditional and safe. CSP is DEFAULT-OFF: it only emits when CSP_ENABLED
// is truthy, and defaults to report-only (Content-Security-Policy-Report-Only) unless CSP_REPORT_ONLY
// is explicitly falsy — so it can never block the dashboard's inline/eval/Next resources by default.
// A conservative starter policy is used; tighten it once report-only telemetry confirms no breakage.
function isFlagOn(value: string | undefined): boolean {
  if (value === undefined) return false;
  const v = value.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function isFlagExplicitlyOff(value: string | undefined): boolean {
  if (value === undefined) return false;
  const v = value.trim().toLowerCase();
  return v === "0" || v === "false" || v === "no" || v === "off";
}

/** The CSP directive string. Kept intentionally permissive (unsafe-inline/eval, https:) because Next.js
 *  ships inline bootstrap scripts and styled-jsx; this is a starting point for report-only telemetry,
 *  NOT a hardened enforcing policy. Override via CSP_POLICY when you have a tightened one.
 *  Default policy always includes report-uri /api/csp-report so CSP_ENABLED=on starts collecting. */
function cspPolicy(): string {
  const custom = process.env.CSP_POLICY?.trim();
  if (custom) return custom;
  return [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    "connect-src 'self' https:",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "report-uri /api/csp-report"
  ].join("; ");
}

/** Set the standard security headers on `res` and return it. Mutates in place for convenience.
 *  Exported so tests can assert the header set without driving the full edge middleware. */
export function withSecurityHeaders(res: NextResponse): NextResponse {
  res.headers.set("X-Frame-Options", "DENY");
  res.headers.set("X-Content-Type-Options", "nosniff");
  res.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  // Permissions-Policy: restrict powerful browser features to self. A conservative starting
  // policy that disables camera/mic/geolocation/payment by default; tighten per use case.
  res.headers.set(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), payment=()"
  );
  // Strict-Transport-Security: only emit in production (Next.js dev server on localhost is not TLS).
  // Browsers ignore HSTS on localhost anyway, but this is cleaner.
  if (process.env.NODE_ENV === "production") {
    res.headers.set("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
  }
  if (isFlagOn(process.env.CSP_ENABLED)) {
    const reportOnly = !isFlagExplicitlyOff(process.env.CSP_REPORT_ONLY);
    const header = reportOnly ? "Content-Security-Policy-Report-Only" : "Content-Security-Policy";
    res.headers.set(header, cspPolicy());
  }
  return res;
}

// Auth is "configured" (armed) when at least one real identity source is active.
// This is the reliable fail-closed signal — it does not depend on NODE_ENV.
function isAuthConfigured(): boolean {
  return Boolean(process.env.AUTH_SECRET) || isFlagOn(process.env.CF_ACCESS_TRUST_EMAIL_HEADER);
}

// --- Cloudflare Access JWT verification -----------------------------------------
//
// `cf-access-authenticated-user-email` is a PLAIN, spoofable HTTP header. It is only trustworthy
// when Cloudflare Access itself terminates the connection and the origin is unreachable any other
// way (e.g. a Tunnel with no public IP). This origin IS directly reachable, so the header alone is
// NEVER trusted: CF_ACCESS_TRUST_EMAIL_HEADER additionally requires CF_ACCESS_TEAM_DOMAIN +
// CF_ACCESS_AUD to be configured, and every request must carry a `Cf-Access-Jwt-Assertion` that
// verifies against the team's JWKS (https://<team>.cloudflareaccess.com/cdn-cgi/access/certs) with
// a matching audience. Any missing config or failed verification makes the header IGNORED — fail
// closed, never a degraded/partial trust.

/** Whether Cloudflare Access header trust is fully armed: the trust flag AND both pieces of config
 *  needed to validate the accompanying JWT. The flag alone is intentionally not sufficient. */
function isCfAccessConfigured(): boolean {
  return Boolean(process.env.CF_ACCESS_TEAM_DOMAIN?.trim()) && Boolean(process.env.CF_ACCESS_AUD?.trim());
}

/** Normalize a team domain to the full JWKS host: a bare team name ("acme") becomes
 *  "acme.cloudflareaccess.com"; anything that already looks like a domain is used as-is (covers
 *  Cloudflare Access custom hostnames). */
function normalizeCfTeamDomain(raw: string): string {
  const trimmed = raw.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  return trimmed.includes(".") ? trimmed : `${trimmed}.cloudflareaccess.com`;
}

// Cache the remote JWKS resolver at module scope (survives across requests within the same warm
// edge isolate) so every request doesn't re-create a fresh jose JWKS fetcher; jose's own resolver
// additionally caches the fetched key set internally.
const cfAccessJwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function getCfAccessJwks(teamDomain: string): ReturnType<typeof createRemoteJWKSet> {
  let jwks = cfAccessJwksCache.get(teamDomain);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`https://${teamDomain}/cdn-cgi/access/certs`));
    cfAccessJwksCache.set(teamDomain, jwks);
  }
  return jwks;
}

/** Verify a `Cf-Access-Jwt-Assertion` against the configured team's JWKS with an audience check.
 *  Returns the verified email claim, or null on ANY failure (missing config, expired/invalid
 *  signature, wrong issuer/audience, network error) — every failure path ignores the assertion
 *  rather than trusting it. */
async function verifyCfAccessAssertion(assertion: string): Promise<string | null> {
  const teamDomainRaw = process.env.CF_ACCESS_TEAM_DOMAIN?.trim();
  const aud = process.env.CF_ACCESS_AUD?.trim();
  if (!teamDomainRaw || !aud) return null;
  const teamDomain = normalizeCfTeamDomain(teamDomainRaw);
  try {
    const jwks = getCfAccessJwks(teamDomain);
    const { payload } = await jwtVerify(assertion, jwks, {
      issuer: `https://${teamDomain}`,
      audience: aud
    });
    const email = payload.email;
    return typeof email === "string" && email.includes("@") ? email.trim().toLowerCase() : null;
  } catch {
    return null;
  }
}

/** Extract the verified email from a Cloudflare Access request, if present. Requires
 *  CF_ACCESS_TRUST_EMAIL_HEADER on AND CF_ACCESS_TEAM_DOMAIN/CF_ACCESS_AUD configured AND a
 *  Cf-Access-Jwt-Assertion that verifies against the team's JWKS with the configured audience —
 *  the cf-access-authenticated-user-email header is NEVER trusted by itself. */
async function getCfEmail(req: NextRequest): Promise<string | null> {
  if (!isFlagOn(process.env.CF_ACCESS_TRUST_EMAIL_HEADER)) return null;
  const headerEmail = req.headers.get("cf-access-authenticated-user-email");
  if (!headerEmail) return null;
  if (!isCfAccessConfigured()) {
    // Flag on but not fully configured: fail closed by ignoring the header entirely, rather than
    // falling back to a degraded/partial trust of an unverifiable claim.
    console.error(
      "CF_ACCESS_TRUST_EMAIL_HEADER is on but CF_ACCESS_TEAM_DOMAIN/CF_ACCESS_AUD are not both set " +
        "— ignoring the cf-access-authenticated-user-email header (fail closed)."
    );
    return null;
  }
  const assertion = req.headers.get("cf-access-jwt-assertion");
  if (!assertion) return null;
  const verifiedEmail = await verifyCfAccessAssertion(assertion);
  if (!verifiedEmail) return null;
  // Defense in depth: the verified JWT's own email claim must match the header Access also set —
  // the JWT is the source of truth, the header is corroboration, not an independent trust source.
  if (verifiedEmail !== headerEmail.trim().toLowerCase()) return null;
  return verifiedEmail;
}

function isEmailAllowed(email: string, fromCf: boolean): boolean {
  if (PRIMARY_SET.has(email)) return true; // primary operator + aliases
  // Empty ALLOWED_EMAILS defers to the upstream CF Access gate ONLY when CF actually
  // provided the identity for this request. When the identity came from an Auth.js session
  // cookie (even if CF_ACCESS_TRUST_EMAIL_HEADER is configured), empty means "only the
  // primary user" — otherwise any OAuth account bypassing CF can reach the origin.
  if (ALLOWED.length === 0) return fromCf;
  return ALLOWED.includes(email);
}

export async function middleware(req: NextRequest): Promise<NextResponse> {
  const { pathname } = req.nextUrl;
  const host = (req.headers.get("host") || "").toLowerCase().split(":")[0];

  // Host-level routing: admin.socratictrade.com / admin.socratic.trade
  if (host === "admin.socratictrade.com" || host === "admin.socratic.trade") {
    if (pathname === "/") {
      return NextResponse.redirect(new URL("/admin", req.url));
    }
    const adminSubroutes = ["/server", "/connections", "/llm-usage", "/rag-coverage", "/transcript"];
    if (adminSubroutes.includes(pathname)) {
      return NextResponse.redirect(new URL(`/admin${pathname}`, req.url));
    }
  }

  // Host-level routing: mobile.socratictrade.com / mobile.socratic.trade
  // PWA retired (owner 2026-08-16/17) — send this host to the website console.
  if (host === "mobile.socratictrade.com" || host === "mobile.socratic.trade") {
    if (pathname === "/" || pathname === "/mobile" || pathname.startsWith("/mobile/")) {
      return NextResponse.redirect(new URL("/console", req.url));
    }
    if (
      !pathname.startsWith("/console") &&
      !pathname.startsWith("/api") &&
      !pathname.startsWith("/_next") &&
      !pathname.startsWith("/favicon") &&
      !isLoginPath(pathname)
    ) {
      return NextResponse.redirect(new URL(`/console${pathname}`, req.url));
    }
  }

  // Apex (and every other host): leftover PWA paths go to the website console.
  // Do not match /api/mobile/* — that is the native iOS command gateway.
  if (pathname === "/mobile" || pathname.startsWith("/mobile/")) {
    return withSecurityHeaders(NextResponse.redirect(new URL("/console", req.url)));
  }

  if (pathname === "/manifest.webmanifest") {
    return withSecurityHeaders(
      new NextResponse(null, {
        status: 410,
        headers: { "cache-control": "no-store" }
      })
    );
  }

  // Host-level routing: console.socratictrade.com / console.socratic.trade
  if (host === "console.socratictrade.com" || host === "console.socratic.trade") {
    if (pathname === "/") {
      return NextResponse.redirect(new URL("/console", req.url));
    }
    if (
      !pathname.startsWith("/console") &&
      !pathname.startsWith("/api") &&
      !pathname.startsWith("/_next") &&
      !pathname.startsWith("/favicon") &&
      !isLoginPath(pathname)
    ) {
      return NextResponse.redirect(new URL(`/console${pathname}`, req.url));
    }
  }

  // The native iOS app's ASWebAuthenticationSession opens GET /api/auth/signin/<provider>
  // directly, but Auth.js v5 only initiates OAuth on POST — that GET is an UnknownAction
  // that dead-ends on /access-denied?error=Configuration.  Translate it into the
  // GET-initiating /api/mobile/auth-start route so already-shipped iOS builds can sign in.
  if (req.method === "GET" && pathname.startsWith("/api/auth/signin/")) {
    const provider = pathname.slice("/api/auth/signin/".length);
    if (provider && !provider.includes("/")) {
      const target = new URL("/api/mobile/auth-start", req.url);
      target.searchParams.set("provider", provider);
      const callbackUrl = new URL(req.url).searchParams.get("callbackUrl");
      if (callbackUrl) target.searchParams.set("callbackUrl", callbackUrl);
      return withSecurityHeaders(NextResponse.redirect(target));
    }
  }

  const isMobileAuthExchangePath = pathname === "/api/mobile/auth/exchange";


  if (isPublicPath(pathname)) {
    // Public (no auth) — but still strip client-supplied identity headers so a forged
    // identity can never reach a handler that reads it.
    const headers = stripClientIdentityHeaders(new Headers(req.headers));
    return withSecurityHeaders(NextResponse.next({ request: { headers } }));
  }

  // CSRF: reject cross-site state-changing requests to /api/*
  // (PUBLIC_PREFIXES already returned above, so webhooks are unaffected).
  if (pathname.startsWith("/api/")) {
    const csrf = checkSameOrigin({
      method: req.method,
      url: req.url,
      secFetchSite: req.headers.get("sec-fetch-site"),
      origin: req.headers.get("origin"),
      referer: req.headers.get("referer"),
      forwardedHost: req.headers.get("x-forwarded-host"),
      host: req.headers.get("host")
    });
    if (!csrf.ok) {
      return withSecurityHeaders(
        new NextResponse(JSON.stringify({ ok: false, error: "Cross-site request blocked (CSRF)." }), {
          status: 403,
          headers: { "content-type": "application/json" }
        })
      );
    }
  }

  // The mobile exchange is intentionally unauthenticated, but it must still pass
  // the CSRF gate above. Its one-time code and device verifier authorize the
  // session handoff; the browser-origin check prevents login CSRF/session fixation.
  if (isMobileAuthExchangePath) {
    const headers = stripClientIdentityHeaders(new Headers(req.headers));
    return withSecurityHeaders(NextResponse.next({ request: { headers } }));
  }

  // --- Identity resolution ---

  // Track the identity source so isEmailAllowed can distinguish CF-provided identities
  // (where empty ALLOWED_EMAILS defers to CF's own allowlist) from Auth.js session
  // identities (where empty ALLOWED_EMAILS means "only the primary user").
  let trustedEmail: string | null = null;
  let identitySource: AuthenticatedIdentitySource | null = null;
  let sessionIssuedAt: number | null = null;
  let fromCf = false;

  // Source 1: Cloudflare Access header.
  const cfEmail = await getCfEmail(req);
  if (cfEmail) {
    trustedEmail = cfEmail;
    identitySource = AUTHENTICATED_IDENTITY_SOURCES.cloudflareAccess;
    fromCf = true;
  }

  // Source 2: Auth.js v5 session JWT (verified with the shared edge-safe helper).
  // Even when Cloudflare supplied the access identity, inspect a signed Auth.js session for the
  // SAME email. Cloudflare application tokens can refresh without a fresh IdP login, so their
  // `iat` is not account-recreation proof. A matching Auth.js `loginAt` is the provider-login
  // timestamp; a missing/mismatched cookie leaves the request on the Cloudflare-only path and a
  // deleted identity will fail closed in resolveRequestUser().
  if (process.env.AUTH_SECRET) {
    const cookieHeader = req.headers.get("cookie");
    const identity = await getSessionIdentity(cookieHeader, process.env.AUTH_SECRET);
    if (!trustedEmail && identity?.email) {
      trustedEmail = identity.email;
      sessionIssuedAt = identity.loginAt ?? null;
      identitySource = AUTHENTICATED_IDENTITY_SOURCES.authJsSession;
    } else if (
      trustedEmail &&
      identity?.email === trustedEmail &&
      identity.loginAt != null
    ) {
      sessionIssuedAt = identity.loginAt;
      identitySource = AUTHENTICATED_IDENTITY_SOURCES.authJsSession;
    }
  }

  // Source 3: Dev/local fallback — ONLY when auth is NOT configured and this is not a live bootstrap.
  if (!trustedEmail && !isAuthConfigured() && !isLiveBootstrap()) {
    trustedEmail = PRIMARY_EMAIL;
    identitySource = AUTHENTICATED_IDENTITY_SOURCES.localFallback;
  }

  // --- Authorization ---

  if (trustedEmail) {
    if (!isEmailAllowed(trustedEmail, fromCf)) {
      // Authenticated upstream, but not permitted in this app.
      return withSecurityHeaders(
        pathname.startsWith("/api/")
          ? new NextResponse("Forbidden", { status: 403 })
          : NextResponse.redirect(new URL("/access-denied", req.url))
      );
    }
  } else if (pathname.startsWith("/api/admin/") && (req.headers.has("x-admin-token") || (req.headers.get("authorization") ?? "").trim().toLowerCase().startsWith("bearer "))) {
    // Allow unauthenticated requests with an x-admin-token or bearer token to reach the admin route handlers.
    // The middleware does NOT validate the token; the route handler's `requireAdmin()` or custom auth (like verifySecuritiesImportToken) will strictly validate it.
  } else if (
    isPeerMarketReadPath(pathname) &&
    (req.headers.get("authorization") ?? "").trim().toLowerCase().startsWith("bearer ")
  ) {
    // Allow unauthenticated requests with a bearer token to reach the token-gated market READ handlers
    // (congress.trade cache-aside price pulls, plus the #2953 quotes/intraday peer routes). The
    // middleware does NOT validate the token; the route handler's verifySecuritiesImportToken
    // (APP_B_INGEST_TOKEN) strictly validates it. /api/market/flatfile stays session-gated.
  } else {
    // No verified identity and auth is configured (or armed) → FAIL CLOSED.
    if (pathname.startsWith("/api/")) {
      return withSecurityHeaders(
        new NextResponse(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json" }
        })
      );
    }
    const loginUrl = new URL("/login", req.url);
    loginUrl.searchParams.set("callbackUrl", req.nextUrl.pathname + req.nextUrl.search);
    return withSecurityHeaders(NextResponse.redirect(loginUrl));
  }

  // --- Admin role gate for the operator page tree ---
  //
  // Same allowlist the route handlers use (`src/lib/auth/admin.ts` shares `isAdminEmail` from the
  // edge-safe module imported above), so the pages and their data agree about who is an admin.
  //
  // Provenance: the route gate additionally rejects the auth-unconfigured `local-fallback` source,
  // because it also serves token-scripted, cost-side-effecting backfills. This page gate accepts the
  // identity middleware itself just resolved. That is not a weaker perimeter in production: a live
  // boot cannot reach the fallback at all — `assertAuthSecretConfiguredInLiveBootstrap` refuses to
  // start without a real identity source, and the Source 3 branch above is additionally guarded by
  // `!isLiveBootstrap()`. It only preserves local development, where auth is unconfigured by design.
  if (isAdminPagePath(pathname) && !isAdminEmail(trustedEmail)) {
    return withSecurityHeaders(NextResponse.redirect(new URL("/access-denied", req.url)));
  }

  // Strip spoofable client-supplied identity hints, then forward the resolved identity + provenance.
  const headers = stripClientIdentityHeaders(new Headers(req.headers));
  headers.set("x-authenticated-user-email", trustedEmail || "");
  // Preserve provenance separately from the email. Node handlers use this trusted middleware-set
  // marker to distinguish verified identities from the auth-unconfigured local fallback.
  if (identitySource) headers.set(AUTHENTICATED_IDENTITY_SOURCE_HEADER, identitySource);
  if (sessionIssuedAt !== null) {
    headers.set(AUTHENTICATED_SESSION_ISSUED_AT_HEADER, new Date(sessionIssuedAt).toISOString());
  }
  return withSecurityHeaders(NextResponse.next({ request: { headers } }));
}

export const config = {
  // Run on everything except Next internals and static image assets.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|monitoring|.*\\.(?:png|jpg|jpeg|gif|svg|ico|webp)$).*)"]
};
