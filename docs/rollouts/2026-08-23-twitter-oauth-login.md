# 2026-08-23 — X (Twitter) OAuth 2.0 Login Integration

## Context & Objective

Added X (Twitter) as an official login provider in Socratic-Trade using Auth.js v5 (NextAuth). Extracted `ST_X_CLIENT_ID` and `ST_X_CLIENT_SECRET` from `~/.secrets/global-api-keys` and saved them securely into Infisical (`AUTH_TWITTER_ID` and `AUTH_TWITTER_SECRET`) for production and local runtimes.

## Changes Made

- **Infisical Secret Configuration**: Mapped `ST_X_CLIENT_ID` and `ST_X_CLIENT_SECRET` from global keys into Infisical project `39d93bb7-76f9-498c-8b50-a7def52e072f` as `AUTH_TWITTER_ID` and `AUTH_TWITTER_SECRET`.
- `src/lib/auth/auth.ts`: 
  - Added Twitter OAuth 2.0 provider configuration (`next-auth/providers/twitter`).
  - Added `account?.provider === "twitter"` check to `signIn` callback to ensure sign-in fails closed if no verified email is returned.
- `app/login/page.tsx`:
  - Added `twitterConfigured` check (`!!(AUTH_TWITTER_ID && AUTH_TWITTER_SECRET)`).
  - Added "Sign in with X" button with standard SVG mark (`XIcon`).
  - Updated fallback copy and provider status messages.

## Decisions & Trade-offs

- Mapped variable names: The global file uses `ST_X_CLIENT_ID` and `ST_X_CLIENT_SECRET` to prevent collisions with other apps. Auth.js / NextAuth in Socratic-Trade expects `AUTH_TWITTER_ID` and `AUTH_TWITTER_SECRET`. Infisical stores them under `AUTH_TWITTER_*`.
- Email requirement: X OAuth 2.0 must have "Request email from users" enabled in the X Developer Portal so NextAuth receives the email address required for Socratic-Trade session management and account matching.

## Verification State

- **Infisical Secret Verification**: Verified `AUTH_TWITTER_ID` and `AUTH_TWITTER_SECRET` injection via `node scripts/infisical-run.mjs`.
- **Build Gate Verification**:
  - `npm run lint` — 0 errors
  - `npx tsc --noEmit` — clean typecheck
  - `npm test` — vitest test suite passed
  - `npm run build` — Next.js build completed successfully

## Next Steps & Blockers

- Merge PR to `main` and deploy.
- Verify live sign-in flow on `https://socratictrade.com/login` with the pre-registered X callback URL `https://socratictrade.com/api/auth/callback/twitter`.
