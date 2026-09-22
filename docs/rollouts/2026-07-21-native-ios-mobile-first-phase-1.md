# 2026-07-21 — Native iOS mobile-first Phase 1

> **2026-09-22 [MM] archaeology note:** historical references to `trade.socratic.app` (the iOS app, the SIWA audience, and the test bundle) are kept verbatim as the IDs that were live at rollout time.  Renamed on 2026-09-22 to `trade.socratic.ios` / `trade.socratic.ios.tests` (PR forthcoming).  See `docs/rollouts/2026-09-22-bundle-id-migration.md`.

## Summary

Replaced the native iOS one-list starter surface with a stable five-tab product shell:

- **Home:** agent state and controls, portfolio, performance/benchmark, scheduler, attention
  summary, and Account & Settings from the toolbar.
- **Proposals:** dedicated proposal cards, rationale/context, proposal performance, per-proposal
  operations, and exact typed confirmation for live brokerage approvals.
- **Markets:** market session, positions, broker orders, editable watchlist, and price-alert
  creation/deletion.
- **Activity:** daily execution stats, scheduler timing, recent fills, and audited mobile command
  history.
- **Coach:** a concise snapshot-derived portfolio brief, prioritized readiness/performance/alert
  insights, and a backend `strategy.run_once` action without pretending there is a client-side chat
  or inference service.

The app now decodes every current snapshot section needed by these screens: positions, orders,
alerts, daily stats, performance and benchmark/fills, connected accounts/capabilities, market
session, and scheduler state. Snapshot surfaces distinguish initial loading, retryable errors,
empty content, active refresh, and stale data.

## Selective PR composition

PR #1790 was used as a correctness source, not merged:

- adopted typed HTTP failures so only 401/403 invalidate authentication;
- adopted complete SSE-frame parsing and ignored heartbeat/comment frames;
- retained reload coalescing so an SSE burst cannot stack snapshot requests;
- retained the backend-compatible live approval payload and exact confirmation phrase.

PR #1851 was used only for vetted native project identity:

- canonical bundle identifier `trade.socratic.app`;
- owner development team `CC8UTF7ATG` with automatic Release signing enabled;
- Sign in with Apple entitlement;
- `socratictrade` URL scheme.

The PR's unrelated web/CI changes were not included. Its session-JWT-in-callback-query flow and
manual cookie injection were explicitly rejected; the native app continues to authenticate by
posting Apple's identity token directly to the existing mobile auth endpoint.

## Architecture and behavior decisions

- `ios/project.yml` is the single canonical XcodeGen project definition. The generated
  `.xcodeproj` is intentionally ephemeral and is not part of this change.
- The deployment target is iOS 26, matching the owner's single-user device fleet. The app keeps
  its proven `ObservableObject` ownership model while views are split into focused SwiftUI types.
- Each tab owns a `NavigationStack`, preserving independent native navigation history.
- Settings and deletion are sheet-presented from Home and own their actions/dismissal.
- Mobile commands use per-operation busy identifiers. A proposal action, watchlist edit, or Run
  once cannot disable an unrelated Stop command.
- The backend remains the sole authority for credentials, inference, policy validation,
  revalidation, and order placement. The post-review safety patch also makes
  Stop/close-only/liquidating commands execute immediately, cancels queued risk-increasing mobile
  commands after a protective transition, and re-reads durable state at the final broker-placement
  boundary.
- Background refresh, push delivery, and on-device inference remain deferred; no unused background
  modes were declared merely because PR #1851 contained them.

## Parent-review safety remediation

- The account-deletion request now matches the current server contract, where `expiresAt` is not
  returned; the confirm request no longer implies that the server validates an unused request ID.
- A failed or older-than-three-minutes snapshot disables new state-changing commands. Backend Stop,
  close-only/liquidating transitions, and proposal rejection remain available as protective actions.
- Run once and Start are also gated on account/universe readiness. The three-minute timeline
  refreshes the whole snapshot surface, so controls actually disable when freshness expires.
- Concurrent snapshot requests carry a generation guard so an older response cannot overwrite a
  newer view and relabel stale state as fresh.
- Transport/decode retries reuse the same command idempotency key until the outcome is resolved;
  changed payload intent receives a new key. A focused XCTest covers the tracker contract.
- Live account activation requires an explicit account/broker/environment confirmation. Proposal
  review now includes persisted proposer attribution and Red Team availability/verdict/reason.
- Primary command controls use 44-point touch targets and adaptive horizontal/vertical layouts;
  metric values no longer shrink/truncate at larger Dynamic Type sizes.
- The server-side Apple audience fallback is now the canonical `trade.socratic.app` identifier,
  with a focused resolver test. No callback-query JWT or manual cookie injection was introduced.

## Post-review remediation

PR #1859 is open with additional safety and contract work: deletion preview is read-only and final
confirmation performs admission checks/preparation; command retries reconcile terminal outcomes;
PWA/native deletion clients use the current GET preview contract; protective commands preempt queued
risk-increasing work; and the app includes its production app-icon catalog. Unknown proposal
execution modes render as unknown rather than paper. The server placement guard is covered by a
focused stop-preemption test.

## Files

- `ios/project.yml`
- `ios/SocraticTrade/ActivityView.swift`
- `ios/SocraticTrade/AppComponents.swift`
- `ios/SocraticTrade/CoachView.swift`
- `ios/SocraticTrade/HomeView.swift`
- `ios/SocraticTrade/Info.plist`
- `ios/SocraticTrade/LoginView.swift`
- `ios/SocraticTrade/MarketsView.swift`
- `ios/SocraticTrade/MobileAPIClient.swift`
- `ios/SocraticTrade/MobileControlView.swift`
- `ios/SocraticTrade/MobileModels.swift`
- `ios/SocraticTrade/MobileStore.swift`
- `ios/SocraticTrade/PreviewSupport.swift`
- `ios/SocraticTrade/ProposalsView.swift`
- `ios/SocraticTrade/README.md`
- `ios/SocraticTrade/SocraticTrade.entitlements`
- `ios/SocraticTrade/SocraticTradeApp.swift`
- `ios/SocraticTradeTests/MobileModelsTests.swift`
- `ios/SocraticTrade/Assets.xcassets/Contents.json`
- `ios/SocraticTrade/Assets.xcassets/AppIcon.appiconset/Contents.json`
- `ios/SocraticTrade/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png`
- `app/api/mobile/auth/apple/route.ts`
- `src/lib/auth/apple-client-id.ts`
- `src/lib/auth/__tests__/apple-client-id.test.ts`
- `app/api/mobile/account-deletion/request/route.ts`
- `app/api/mobile/account-deletion/confirm/route.ts`
- `app/api/mobile/commands/route.ts`
- `app/mobile/mobile-pwa-client.tsx`
- `src/lib/mobile-api.ts`
- `src/lib/strategy.ts`
- `src/lib/system-state-placement-guard.ts`
- `test/mobile-account-deletion-route.test.ts`
- `test/mobile-stop-preemption.test.ts`
- `docs/EFFORT-LOG.md`
- `STATUS.md`
- `PLAN.md`
- `docs/rollouts/2026-07-21-native-ios-mobile-first-phase-1.md`

## Verification

Passed:

```bash
plutil -lint ios/SocraticTrade/Info.plist ios/SocraticTrade/SocraticTrade.entitlements
xcodegen generate --spec ios/project.yml
xcodebuild -quiet -project ios/SocraticTrade.xcodeproj -scheme SocraticTrade \
  -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath /tmp/socratic-mobile-first-derived CODE_SIGNING_ALLOWED=NO \
  ONLY_ACTIVE_ARCH=YES ARCHS=arm64 build
xcodebuild -quiet -project ios/SocraticTrade.xcodeproj -scheme SocraticTrade \
  -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath /tmp/socratic-mobile-first-derived CODE_SIGNING_ALLOWED=NO \
  ONLY_ACTIVE_ARCH=YES ARCHS=arm64 build-for-testing
xcodebuild -showBuildSettings -project /tmp/socratic-mobile-first-release-final-20260721/SocraticTrade.xcodeproj \
  -scheme SocraticTrade -configuration Release -destination 'generic/platform=iOS Simulator'
xcodebuild -quiet -project /tmp/socratic-mobile-first-release-final-20260721/SocraticTrade.xcodeproj \
  -scheme SocraticTrade -configuration Release -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath /tmp/socratic-mobile-first-release-final-derived-20260721 \
  CODE_SIGNING_ALLOWED=NO ONLY_ACTIVE_ARCH=YES ARCHS=arm64 build
```

Release build settings report `CODE_SIGNING_ALLOWED=YES`, `CODE_SIGNING_REQUIRED=YES`,
`CODE_SIGN_STYLE=Automatic`, `DEVELOPMENT_TEAM=CC8UTF7ATG`, and
`PRODUCT_BUNDLE_IDENTIFIER=trade.socratic.app`. The Release simulator compile also passes.

`build-for-testing` compiled the focused XCTest target successfully. No matching iOS Simulator
runtime is installed (`xcrun simctl list runtimes` returned none), so the
tests could not be executed in this worktree. The generic application build is green.

The generated `ios/SocraticTrade.xcodeproj` was moved out of the worktree after verification;
the pre-existing tracked `xcuserdata` files were restored untouched. Regenerate this intentionally
ephemeral project from the canonical `ios/project.yml` spec.

The scoped Apple client-ID helper Vitest was run separately because the consolidated branch also
aligns the native bundle audience used by the mobile Apple-auth endpoint.

Parent-review verification additionally passed:

```bash
npx vitest run src/lib/auth/__tests__/apple-client-id.test.ts
xcodebuild -quiet -project ios/SocraticTrade.xcodeproj -scheme SocraticTrade \
  -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath /tmp/socratic-ios26-final.CBq5Qz/DerivedData \
  CODE_SIGNING_ALLOWED=NO build-for-testing
```

The final canonical iOS 26 build produced both app and XCTest products for arm64 and x86_64. The
sole deprecated scene-phase callback was migrated to the current two-argument `onChange` form; the
incremental final build is warning-free.

The post-review focused Node gate passed `tsc --noEmit`, 7/7 targeted Vitest tests (including mobile
deletion, stop preemption, and Apple audience), scoped ESLint with zero errors, JSON/plist asset
validation, and `git diff --check`. No simulator runtime is installed, so XCTest execution remains
unavailable.

## Follow-ups

1. Clear review/check gates and merge PR #1859 through the protected flow; do not deploy manually.
2. Run the XCTest suite and a touch/dynamic-type/VoiceOver pass once an iOS simulator runtime or
   physical device is available.
3. Add push/background refresh and notification delivery in separate entitlement-aware phases.
4. Add a richer Coach conversation only after defining an authenticated server contract; do not
   move trading inference or authority onto the phone.
