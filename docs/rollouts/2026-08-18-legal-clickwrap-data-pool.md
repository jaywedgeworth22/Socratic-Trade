# 2026-08-18 — Legal clickwrap, mandatory data-pool, keep multi-user

## Context & Objective

Owner cut 2026-08-17 items 9–11 (from the blind-spots audit): ship a versioned
dismissible legal notice, make market-data pooling accept-or-cannot-use, and keep
Socratic-Trade multi-user-capable for friends/family.  One PR because the three
items share the consent/settings surfaces.  Do not sell ST.  Do not steal
#2792 / #2798 / #2800 / #2794.

## Changes Made

Combined first-use gate (web + iOS) records a versioned legal clickwrap and
mandatory data-pool accept.  After accept, the notice does not reappear until a
version bump.  Unset users no longer silently share.  `/welcome` stays on.
Privacy names self-serve deletion, 7-day backup TTL, and the shared RAG corpus.
Green/Red prompts carry the same “not investment advice / you set authority”
sentence (`agentic-strategy@2.11.0`).

- `src/lib/legal-notice.ts`
- `src/lib/db-settings.ts`
- `src/lib/landing-page.ts`
- `src/lib/strategy-prompts.ts`
- `src/lib/mobile-api.ts`
- `app/api/consent/route.ts`
- `app/api/legal-notice/route.ts`
- `app/api/mobile/consent/route.ts`
- `app/console/components/consent-gate.tsx`
- `app/console/components/shell.tsx`
- `app/console/settings/legal.tsx`
- `app/console/settings/sharing.tsx`
- `app/console/settings/page.tsx`
- `app/login/page.tsx`
- `app/privacy-policy/page.tsx`
- `app/welcome/page.tsx`
- `app/how-it-works/page.tsx`
- `app/settings-search.ts`
- `ios/SocraticTrade/SocraticTradeApp.swift` (`LegalConsentSheet` lives here so CI's committed `.pbxproj` compiles it — do not add a new `.swift` file without regenerating XcodeGen)
- `ios/SocraticTrade/LoginView.swift`
- `ios/SocraticTrade/HomeView.swift`
- `ios/SocraticTrade/MobileModels.swift`
- `ios/SocraticTrade/MobileAPIClient.swift`
- `ios/SocraticTrade/MobileStore.swift`
- `test/data-pool-consent.test.ts`
- `test/legal-notice-consent.test.ts`
- `test/per-user-policy-isolation.test.ts`
- `test/strategy-prompt-safety.test.ts`
- `docs/data-pool-consent.md`
- `docs/phase-11-multi-user.md`
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`

## Decisions & Trade-offs

- **Mandatory share**, not default-share-all: `hasDataPoolConsent` is false until
  an explicit accept at `DATA_POOL_CONSENT_VERSION` (bumped to 2).  Decline is
  rejected by the API.  Settings shows required status, not an off toggle.
- **One blocking notice**, not a forever strip: owner asked for dismissible +
  no reappear after accept, versioned like Coach.  Accept is the dismiss.
- **Learned-context sharing stays optional.**  Only the market-data pool is
  mandatory.  Privacy still names the shared RAG/fact corpus.
- **Backup TTL** is the production Litestream snapshot retention (168h / 7 days
  in `litestream.coolify.yml`), not the older 48h R2 survival note.
- **`/welcome` stays reachable** by default (`landingPageEnabled` unset → true).
  Isolation for a second `ALLOWED_EMAILS` address is tested, not removed.
- No Stripe / IAP / paywall.
- **User-visible copy is product language only.**  Owner ruling 2026-08-18: no
  coordinator/owner asides in iOS or console UI (no remotes, surfaces,
  Infisical, owner cuts, `ALLOWED_EMAILS`, or other-agent notes).  Isolation
  and backup TTL stay in Privacy as ordinary sentences.  Code comments and
  this rollout may still name the internals.

## Verification State

Local (this Cloud VM):

```
npm run lint                 # 0 errors (grandfathered warnings)
npx tsc --noEmit             # pass
npx vitest run test/data-pool-consent.test.ts test/legal-notice-consent.test.ts \
  test/per-user-policy-isolation.test.ts test/strategy-prompt-safety.test.ts \
  test/dormant-features.test.ts test/settings-tree-scope.test.ts \
  test/settings-search-index.test.ts
# 7 files / 32 tests pass
npm run build                # pass; /welcome is a static route
```

CI on `1b9e84ca` (after inlining the iOS sheet + merging `origin/main`):

- iOS unsigned `xcodebuild`: pass — https://github.com/jaywedgeworth22/Socratic-Trade/actions/runs/32089276473
- `verify-hosted` (lint + tsc + full vitest + next build): pass — https://github.com/jaywedgeworth22/Socratic-Trade/actions/runs/32089276341

First CI iOS job on `d9ee5cc9` failed because a new `LegalConsentSheet.swift` was
not in the committed `.pbxproj`.  The sheet is now inlined in
`SocraticTradeApp.swift`.

## Next Steps & Blockers

- Re-run iOS CI after the inline-sheet commit.  Existing production users
  (including the owner) will see the gate once on next visit because unset/v1
  records no longer count as current-version accept.
- Counsel-drafted Terms/Privacy still not in this PR — copy is product-legal,
  not a lawyer pass.
- Leave #2792 / #2798 / #2800 / #2794 to their owners.

## Zero-Code Findings

None.  This is the implementation of the 2026-08-17 owner cut.
