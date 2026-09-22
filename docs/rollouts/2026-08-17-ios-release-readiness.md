# 2026-08-17 — iOS release-readiness leftovers (#2560)

> **2026-09-22 [MM] archaeology note:** historical reference to `APNS_BUNDLE_ID = trade.socratic.app` is kept verbatim as the topic that was live at rollout time.  Renamed on 2026-09-22 to `trade.socratic.ios` (PR forthcoming).  See `docs/rollouts/2026-09-22-bundle-id-migration.md`.

## Context & Objective

Issue #2560 listed four P1 iOS release-readiness gaps from the 2026-08-06 review.
Three of those already landed on `main` in later waves.  This pass implements the
remaining in-repo gaps (privacy manifest, Safari console handoffs, honest alert
copy) and leaves a clear owner step for the Apple APNs `.p8`.

## Changes Made

Investigation (do not re-open the already-shipped work):

- Close Only / Wind Down are on Home `StrategyControlsCard` and stay available as
  protective commands (`MobileStore` whitelist).  Tests now pin the show/hide
  matrix per `systemState`.
- APNs is wired end-to-end (`PushNotifications.swift`, `src/lib/apns.ts`,
  `device_push_tokens`, AASA + universal-link tap routing).  `price_alert` already
  has a push deep-link contract.  Missing piece is **prod Infisical credentials**,
  not code.
- `ITSAppUsesNonExemptEncryption=false` is already in `ios/project.yml` and
  `Info.plist`.  Display name is `Socratic Trade` in both.

This branch:

- Adds `ios/SocraticTrade/PrivacyInfo.xcprivacy` (no tracking; UserDefaults
  CA92.1; email / name / user id / device id / product interaction for app
  functionality).  `project.yml` lists it as an explicit resources file so
  `xcodegen generate` on the Mac ship copies it into the bundle.
- Adds `ConsoleHandoff` URLs for `/console/connections` and `/console/strategy`.
  Those paths stay **out** of AASA + `DeepLink` so `openURL` opens Safari instead
  of looping back into a missing phone screen.  Home readiness + Settings empty
  accounts now have tappable Open Connections / Open Strategy buttons.
- Softens Markets empty-alert copy so it does not promise off-app watch unless
  the user turns on Alerts (and the operator has configured APNs).

Touched files:

- `ios/SocraticTrade/PrivacyInfo.xcprivacy` (new)
- `ios/SocraticTrade/DeepLink.swift`
- `ios/SocraticTrade/HomeView.swift`
- `ios/SocraticTrade/MarketsView.swift`
- `ios/SocraticTradeTests/DeepLinkTests.swift`
- `ios/SocraticTradeTests/AgentControlPlanTests.swift`
- `ios/project.yml`
- `ios/CLAUDE.md`
- `test/ios-privacy-manifest.test.ts` (new)
- `test/apple-app-site-association-route.test.ts`
- `docs/FEATURE-ENABLEMENT-BACKLOG.md`
- `docs/phase-6-customization-risk-notifications.md`
- `docs/phase-11-multi-user.md`
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`
- `docs/rollouts/2026-08-17-ios-release-readiness.md`

## Decisions & Trade-offs

- Did **not** invent or commit APNs credentials.  The channel already fails soft
  as "not configured".
- Did **not** claim `/console/connections` or `/console/strategy` in AASA.  The
  phone cannot edit those pages; claiming them would make the new buttons no-ops.
- Did **not** hand-edit `project.pbxproj` (hook + XcodeGen rule).  The Mac ship
  runs `xcodegen generate` from `project.yml`, which is how the privacy manifest
  enters the target.  Cloud VM has no `xcodegen`.
- Close-only / Wind-down UI was already present; this pass only pins tests so
  the original #2560 finding cannot regress silently.

## Verification State

```bash
npm run lint          # exit 0 (warnings only; no errors)
npx tsc --noEmit      # exit 0
npx vitest run test/ios-privacy-manifest.test.ts \
  test/apple-app-site-association-route.test.ts \
  test/apns-deep-link-contract.test.ts
                      # 3 files / 16 tests passed
npm run build         # Next.js 16.3.1 webpack, exit 0
```

Full `npm test` was started in this Cloud VM and hung after many unrelated
network failures (SEC company_tickers 404, FRED, TwelveData, vector-db
receipts).  Those files are outside this change.  GitHub `verify` is the
authoritative full-suite run.

`xcodebuild` is not available in this Cloud VM.  iOS compile happens on the Mac
ship / `ios-compile` CI job.  Next `xcodegen generate` on that Mac copies
`PrivacyInfo.xcprivacy` into Copy Bundle Resources.

## Next Steps & Blockers

**Owner — Apple portal secret (required for live push):**

1. In Apple Developer → Keys, create (or reuse) an APNs Auth Key (`.p8`) for
   team `CC8UTF7ATG`.  Enable Apple Push Notifications.  Do not use the Sign in
   with Apple `.p8`.
2. Set these in **ST prod Infisical** (no values in git, no second key):
   - `APNS_KEY_ID`
   - `APNS_TEAM_ID` = `CC8UTF7ATG`
   - `APNS_BUNDLE_ID` = `trade.socratic.app`
   - `APNS_P8` (PEM text) or `APNS_PRIVATE_KEY_B64`
3. Restart the Coolify app so `loadApnsConfig()` sees a complete set.
4. On a TestFlight device: Account & Settings → Turn On Alerts, then confirm a
   `pending_approval` or `price_alert` arrives.

Until that set is present, iOS can register a token but the server will audit
push as skipped / not configured.  Email and Pushover still deliver if those
channels are on.

After merge: next TestFlight ship should run `xcodegen generate` so
`PrivacyInfo.xcprivacy` is in Copy Bundle Resources.  Confirm the uploaded
binary is no longer `MISSING_EXPORT_COMPLIANCE` (plist already has the flag).

## Zero-Code Findings

None beyond the already-landed Close-only / APNs / encryption-flag work named
above.
