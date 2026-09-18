# GROK takeover of AG #3372 entry paths (unique remainder)

## Context & Objective

Board `6aa1e66e`.  MM `mm/ag-takeover-620ef423` was empty vs main.  AG `ag/620ef423` still had one unique commit, but cherry-picking it onto current main regresses `callbackUrl` to `next` and duplicates `hasLlmKey`.  Land only the unique remainder that does not fight #3296.

## Changes Made

- `app/login/page.tsx` — already-authenticated visits redirect to `callbackUrl` (or `/console`).  Keep the `callbackUrl` query name.
- `ios/SocraticTrade/HomeView.swift` — first-run account gap says connections are configured on the website.
- `src/lib/auth/auth.ts` — Auth.js error page is `/login` so first-run OAuth failures do not dump onto access-denied.

## Decisions & Trade-offs

- Did not take `?next=` or plain-text API 401.  Those regress JSON 401 + `callbackUrl` already on main.
- Did not take a second `hasLlmKey` field.  Main already has it.
- Extra-ship no.  No Coolify Deploy.

## Verification State

- Three-dot vs `origin/main` is only the three files above.
- Hosted `verify` is the gate.  Local npm registry ETIMEDOUT.

## Next Steps & Blockers

- Open PR from `grok/ag-takeover-620ef423`.  Close #3372 as superseded.
