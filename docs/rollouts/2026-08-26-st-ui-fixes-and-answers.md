# 2026-08-26 — Socratic-Trade UI Fixes & Investigation

## Context & Objective
The user requested multiple UI fixes across Socratic-Trade: fixing the reality banner spacing, fixing the mobile "More" tab links, reducing the iOS login disclaimer size, and asked several questions regarding system states (Backblaze usage, Alpaca kill switch, Learning Review, and disabled Earnings Transcripts).

## Changes Made
- `app/console/components/chrome.tsx`: Fixed the gap spacing in the reality banner for paper accounts by wrapping the bullet point in a span.
- `app/console/components/nav.tsx`: Fixed mobile `TabsSheet` "More" tab links to programmatically navigate `router.push(href)` and cleanly close the sheet without interrupting Next.js client-side navigation.
- `ios/SocraticTrade/LoginView.swift`: Reduced the iOS login disclaimer text and links by 2 font sizes (`JustifiedText` to size 10, `.font(.system(size: 10))`).

## Decisions & Trade-offs
- The Apple Login issue is purely UI/server connectivity side; without logs or specific errors, there is no reproducible bug identified in the iOS auth codebase. Code explicitly defers `isSigningIn = false` and properly retains delegates. 

## Verification State
- `npm run lint` and `npx tsc --noEmit` locally.
- iOS UI builds and changes are ready to be verified via TestFlight once the PR merges and the iOS build Action triggers.

## Next Steps & Blockers
- Merge PR and trigger deployments.
- Await user feedback if iOS login fails on the new TestFlight build.
