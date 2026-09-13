# Rollout: API Security Hardening — Open Redirect Sanitization, Public Auth Rate Limiting & Defensive JSON Parsing

**Date:** 2026-09-13  
**Lane:** Antigravity (`~/apps/trading-antigravity`)  
**Branch:** `ag/issue-3224-api-security-hardening`  
**Issue:** #3224  

---

## 1. Context & Objective

An audit of the API surface and authentication handlers identified potential vulnerabilities and denial-of-service risks: unsanitized `callbackUrl` values could permit protocol-relative open redirects (`//evil.com`), public mobile authentication endpoints executed cryptographic operations without rate limiting, public mobile token exchange parsed unbounded JSON payloads, several route handlers crashed with unhandled 500 `SyntaxError`s on malformed JSON bodies, and raw error messages reflected upstream API details in chat responses.  This change hardens these endpoints with strict redirect validation, IP-based sliding-window rate limiting, payload byte caps, defensive JSON body parsing, and error redaction.

---

## 2. Changes Made

- **`src/lib/auth/callback-url.ts` & `app/login/page.tsx`**:
  - Implemented `sanitizeCallbackUrl(url)` to enforce relative-path-only redirects and reject protocol-relative URLs (`//evil.com`), Windows slash redirects (`/\evil.com`), and cross-origin targets.
  - Applied `sanitizeCallbackUrl` to `rawCallbackUrl` in `LoginPage`.

- **`src/lib/auth/auth.ts`**:
  - Added a strict `redirect({ url, baseUrl })` callback inside NextAuth configuration to ensure post-login redirects remain strictly on the same origin or safe relative paths.

- **`app/api/mobile/auth/apple/route.ts`**:
  - Added IP-based rate limiting via `cf-connecting-ip` (fallback to conservative bucket) with `RATE_LIMITS.oauth` before entering cryptographic verification.

- **`app/api/mobile/auth/exchange/route.ts`**:
  - Added IP-based rate limiting via `cf-connecting-ip` with `RATE_LIMITS.oauth`.
  - Capped request body size using `readJsonWithLimit(request, APPLE_AUTH_MAX_BYTES)`.
  - Added error handlers returning HTTP 413 on `PayloadTooLargeError` and HTTP 400 on `SyntaxError`.

- **`app/api/proposals/from-draft/route.ts`**:
  - Applied `RATE_LIMITS.orders` rate limiting to prevent unthrottled broker quote cascades and balance queries.

- **`app/api/orders/cancel/route.ts`**:
  - Replaced unhandled `await request.json()` with `await request.json().catch(() => null)` returning HTTP 400 on invalid JSON payloads.

- **`app/api/profiles/route.ts`**:
  - Replaced unhandled `await request.json()` with `await request.json().catch(() => null)` returning HTTP 400 on invalid JSON payloads.

- **`app/api/consent/route.ts`**:
  - Standardized JSON parsing to return HTTP 400 on invalid JSON bodies.

- **`app/api/chat/route.ts`**:
  - Applied `safeErrorMessage(e)` from `@/lib/telemetry-sanitize` to redact bearer tokens, API keys, and sensitive paths in chat 500 error responses.

- **`instrumentation.ts`**:
  - Kept type-checking compatibility for optional `@sentry/profiling-node` import.

- **Tests**:
  - `test/login-callback-url-sanitize.test.ts`: Verified relative path acceptance and rejection of protocol-relative, Windows slash, and cross-origin targets.
  - `test/api-security-hardening.test.ts`: Verified HTTP 400 on malformed JSON across cancel, profiles, and consent routes; verified 413 and 429 on mobile exchange; verified 429 on Apple auth and from-draft routes; verified error secret redaction.

---

## 3. Decisions & Trade-offs

- **IP Header Extraction**: Public routes extract client IP from `cf-connecting-ip` and fallback to a single conservative bucket (`unknown-ip`) rather than parsing spoofable `x-forwarded-for` headers, preventing callers from rotating headers to bypass limits.
- **Fail-Open Rate Limiter**: The sliding window rate limiter continues to fail open on internal errors to never block legitimate traffic due to limiter faults, while failing closed (HTTP 429) when limits are legitimately exceeded.

---

## 4. Verification State

All local gate checks passed cleanly:
- `npm run lint`: 0 errors (809 grandfathered warnings).
- `npx tsc --noEmit`: Clean, 0 type errors.
- `npx vitest run test/login-callback-url-sanitize.test.ts test/api-security-hardening.test.ts test/apple-auth-route.test.ts`: 3 test files passed, 19 tests passed.

---

## 5. Next Steps & Blockers

- Proceed with Issue #3225: Console singleflighting (eliminate duplicate strategy runs from dual RunOnceButtons & fix deadline retry spin loop).
- Monitor PR #3284 (Issue #3223), PR #3283 (Issue #3222), and PR #3282 (Issue #3221) auto-merge progression.

---

## 6. Zero-Code Findings

- None.
