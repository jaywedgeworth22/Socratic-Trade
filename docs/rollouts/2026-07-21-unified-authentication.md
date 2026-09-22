# Unified Authentication Rollout

> **2026-09-22 [MM] archaeology note:** historical references to `trade.socratic.app` and the `socratictrade://` URL scheme are kept verbatim as they were live at rollout time.  The bundle ID was renamed on 2026-09-22 to `trade.socratic.ios` (PR forthcoming); `CFBundleURLName` in `ios/SocraticTrade/Info.plist` carries the new ID, and the `socratictrade://` URL scheme is unchanged.  See `docs/rollouts/2026-09-22-bundle-id-migration.md`.

- **Summary**: Implemented Unified Authentication across iOS and Web, bridging Google, GitHub, and Apple Sign-In seamlessly. Corrected iOS bundle identifier to `trade.socratic.app`, added Apple Sign-In entitlements, and fixed Next.js `metadataBase` fallback logic.
- **Why**: The iOS app previously only supported Apple Sign-In natively. To support Google and GitHub, we used `ASWebAuthenticationSession` to initiate an OAuth flow on the web backend, capturing and injecting the resulting stateless JWT back into the iOS native cookie jar. The bundle ID mismatch and missing entitlements previously caused `AKAuthenticationError Code=-7026`.
- **Files Touched**:
  - `ios/project.yml`: Added `socratictrade://` URL scheme, set `PRODUCT_BUNDLE_IDENTIFIER: trade.socratic.app`, and linked `SocraticTrade.entitlements`.
  - `ios/SocraticTrade/SocraticTrade.entitlements`: Added `com.apple.developer.applesignin` entitlement.
  - `ios/SocraticTrade/LoginView.swift`: Added Google/GitHub buttons; implemented `ASWebAuthenticationSession` flow; fixed `handleAuthorization` scope.
  - `ios/SocraticTrade/MobileStore.swift`: Added `loginWithToken(jwt:)` to manually inject the returned session token into `HTTPCookieStorage`.
  - `app/api/mobile/auth-redirect/route.ts`: Built the custom intercept route to hand off the token from the Next.js server to the iOS URL scheme.
  - `app/layout.tsx`, `app/robots.ts`, `app/sitemap.ts`: Changed `??` to `||` for `NEXT_PUBLIC_SITE_URL` fallback to avoid `ERR_INVALID_URL` on build.
  - `.gitignore`: Added `xcuserdata/` to ignore local Xcode user state.
- **Verification**:
  - `xcodebuild -project SocraticTrade.xcodeproj -scheme SocraticTrade -destination 'generic/platform=iOS Simulator'` clean build succeeded.
  - `npx tsc --noEmit`: clean.
  - `npm test`: 420 test files, 4,900 unit tests passed.
  - `npm run build`: compiled cleanly with 34/34 static pages generated.
  - Pushed to PR #1851 with auto-merge enabled.
- **Follow-ups**:
  - The website Apple Sign-In logic is already built-in, but requires an Apple Services ID. The owner must generate the Web Client ID in the Apple Developer Portal and inject `AUTH_APPLE_ID` and `AUTH_APPLE_SECRET` into the Coolify server's `.env`.
