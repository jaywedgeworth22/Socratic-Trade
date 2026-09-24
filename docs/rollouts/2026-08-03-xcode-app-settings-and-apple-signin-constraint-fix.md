# Rollout Note: 2026-08-03 — Xcode App Settings & Apple Sign-In Layout Constraint Fix

## 1. Context & Objective
The user requested:
1. Setting the Xcode App Category, Display Name, and Build Version properly for `SocraticTrade.xcodeproj`.
2. Debugging and fixing the layout constraint conflict warning on `ASAuthorizationAppleIDButton`:
   ```
   Unable to simultaneously satisfy constraints...
   ASAuthorizationAppleIDButton: width == 392 vs width <= 375
   ```

## 2. Changes Made
- **Xcode App Configuration (`ios/SocraticTrade.xcodeproj/project.pbxproj` & `ios/SocraticTrade/Info.plist`)**:
  - **App Category**: Configured `LSApplicationCategoryType` / `INFOPLIST_KEY_LSApplicationCategoryType` = `"public.app-category.finance"` (Finance).
  - **Display Name**: Configured `CFBundleDisplayName` / `INFOPLIST_KEY_CFBundleDisplayName` = `"Socratic-Trade"`.
  - **Build & Versioning**: Configured `MARKETING_VERSION` = `1.0.0`, `CURRENT_PROJECT_VERSION` = `1`, `CFBundleShortVersionString` = `$(MARKETING_VERSION)`, `CFBundleVersion` = `$(CURRENT_PROJECT_VERSION)`.
- **Apple Sign-In Autolayout Constraint Fix (`ios/SocraticTrade/LoginView.swift`)**:
  - Added `.frame(maxWidth: 375)` to `SignInWithAppleButton`.
  - Root cause: Apple's internal `ASAuthorizationAppleIDButton` has a hard-coded maximum width constraint (`width <= 375`). When embedded in a SwiftUI host stretching to fill container widths > 375pt (e.g. 392pt), SwiftUI's `UIKitPlatformViewHost` forced `minX == 0` and `trailing == 0` (width == 392pt), conflicting with Apple's internal 375pt constraint.
  - Adding `.frame(maxWidth: 375)` keeps the host container within 375pt, eliminating the autolayout constraint conflict warning completely.

## 3. Verification State
- `xcodebuild -project ios/SocraticTrade.xcodeproj -scheme SocraticTrade -destination 'generic/platform=iOS' build` -> `** BUILD SUCCEEDED **`.
- `npx tsc --noEmit` -> Passed with 0 errors.

## 4. Files Touched
- `ios/SocraticTrade/LoginView.swift`
- `ios/SocraticTrade/Info.plist`
- `ios/SocraticTrade.xcodeproj/project.pbxproj`
- `STATUS.md`
- `docs/EFFORT-LOG.md`
- `/Users/jay/apps/TRADING-EFFORT-LOG.md`
- `docs/rollouts/2026-08-03-xcode-app-settings-and-apple-signin-constraint-fix.md`
