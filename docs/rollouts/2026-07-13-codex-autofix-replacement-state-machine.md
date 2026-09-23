# [codex-autofix] Address 4 Codex review findings on PR #1526

**Date:** 2026-07-13
**Branch:** `agent/ag-update-status-effort-log`
**PR:** [#1526](https://github.com/jaywedgeworth22/Socratic-Trade/pull/1526)

## Summary

Codex review (chatgpt-codex-connector[bot]) flagged 19 threads on PR #1526 (X0.3 Exit
Replacement State Machine). This round addresses 4 clear correctness bugs; 15 remaining
threads are architecturally significant and posted to the maintainer for guidance.

## Changes

### Thread 1 (P1): Exempt mobile Apple sign-in from auth middleware

**File:** `middleware.ts`

`/api/mobile/auth/apple` was missing from `PUBLIC_PREFIXES`. When the iOS app calls this
endpoint to bootstrap a session, no session cookie exists yet, so the middleware returned
401 before the handler could verify the Apple token and set the session cookie.

**Fix:** Added `/api/mobile/auth/apple` to the `PUBLIC_PREFIXES` array.

### Thread 4 (P1): Decode Apple login response with matching type

**File:** `ios/SocraticTrade/MobileAPIClient.swift`

`loginWithApple` was typed to return `[String: String]`, but the server response includes
a Bool `success` field (`{ success: true, email }`). `JSONDecoder` fails on every
successful response trying to decode a Bool as a String.

**Fix:** Created `AppleLoginResponse` struct with `let success: Bool` and `let email: String?`.
Changed return type from `[String: String]` to `AppleLoginResponse`.

### Thread 2 (P2): Start mobile events after successful login

**File:** `ios/SocraticTrade/MobileStore.swift`

After `loginWithApple` succeeds, the store sets `isAuthenticated = true` and calls
`load()` but never calls `startEvents()`. Without the SSE subscription, command/dashboard
changes won't live-refresh until app restart.

**Fix:** Added `startEvents()` after `await load()` in the login success path.

### Thread 5 (P2): Mark replacement row failed if live preflight rejects

**File:** `src/lib/order-replacement.ts`

All other precondition checks in `replaceStaleLimitOrderWithMarket` call
`markReplacementError` before throwing, marking the row `failed` so the active-row
check and partial unique index don't block future attempts. The `assertLivePreflight`
call at line 187 was the only one that threw without marking the row, leaving it stuck
as `cancel_requested`.

**Fix:** Wrapped `assertLivePreflight` in a try-catch that calls `markReplacementError`
before rethrowing, consistent with every other precondition check.

## Files changed

- `middleware.ts` — Added `/api/mobile/auth/apple` to PUBLIC_PREFIXES
- `ios/SocraticTrade/MobileAPIClient.swift` — Added `AppleLoginResponse` struct, fixed return type
- `ios/SocraticTrade/MobileStore.swift` — Added `startEvents()` call after login
- `src/lib/order-replacement.ts` — Wrapped `assertLivePreflight` in try-catch with markReplacementError
- `package-lock.json` — Minor lockfile update from npm install

## Verification

```bash
npx tsc --noEmit    # clean
npm test            # 350 files, 3934 tests — all passed
npm run build       # clean
```

## Remaining threads (left open — asked maintainer)

15 P2 threads remain open across 4 files. All are architecturally significant state-machine
changes or persistence design decisions in:
- `src/lib/order-replacement.ts` (10 threads)
- `src/lib/db-api-keys.ts` (1 thread)
- `src/lib/congress-share.ts` (1 thread)
- `app/api/mobile/auth/apple/route.ts` (1 thread)
- `ios/SocraticTrade/MobileStore.swift` (1 thread)
- `ios/SocraticTrade/MobileAPIClient.swift` (1 thread)

See PR comment for full breakdown.

## Follow-ups

- Branch is ready for auto-deploy once remaining threads are triaged by maintainer
- [codex-autofix] commits on this PR: 4 (under the 10-round cap)
