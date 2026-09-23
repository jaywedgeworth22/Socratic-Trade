# Rollout Note: 2026-08-04 — iOS Sign in with Apple constraint + mobile SSE events

## 1. Context & Objective

Owner ran the native iOS app and hit console noise that looked like app breakage:

1. **Auto Layout conflict** on `ASAuthorizationAppleIDButton` (`host width == 392` vs Apple's internal `width <= 375`).
2. **SSE failure** on `GET https://socratictrade.com/api/mobile/events` with `NSURLErrorDomain Code=-1017` ("cannot parse response"), often paired with `Connection reset by peer` and partial bytes.

Goal: fix both on the client, land the previously claimed-but-unmerged Apple button cap, and stop treating routine SSE reconnects as user-facing errors when a snapshot already exists.

## 2. Changes Made

### Diagnosis

| Log | Severity | Cause |
|-----|----------|--------|
| `Unable to simultaneously satisfy constraints` … `ASAuthorizationAppleIDButton` width `<= 375` vs host `392` | Real (console spam; recovered by breaking Apple's max-width) | SwiftUI stretched the UIKit host to the full login column; Apple's button caps at 375pt |
| `cannot parse response` / `-1017` on `/api/mobile/events` | Real (stream drops; app already reconnects) | SSE used the JSON helper defaults: `Accept: application/json` and `timeoutInterval = 30` (only ~5s above the server's 25s heartbeat), which is brittle behind Cloudflare/QUIC |
| `cannot add handler to 0 from 0`, PointerUI, `quic_crypto_queue_append` | Noise | System / simulator / network-stack chatter — ignore |

Note: Antigravity documented the Apple width fix on 2026-08-03 (`docs/rollouts/2026-08-03-xcode-app-settings-and-apple-signin-constraint-fix.md`) and marked the effort **Completed**, but the `LoginView` change never reached `main` (commit stayed on `agent/antigravity/mobile-pwa-feedback` only). This rollout actually lands it.

### Code

- **`ios/SocraticTrade/LoginView.swift`**: cap `SignInWithAppleButton` with `.frame(maxWidth: 375)` so the UIKit host cannot be forced wider than Apple's internal max.
- **`ios/SocraticTrade/MobileAPIClient.swift`**: dedicated `eventsRequest()` with `Accept: text/event-stream`, `Cache-Control: no-cache`, and `timeoutInterval = 120` (heartbeat is 25s).
- **`ios/SocraticTrade/MobileStore.swift`**: SSE reconnect loop only surfaces unauthorized errors, or network errors when there is still no snapshot (quiet reconnect when data is already on screen).
- **`ios/SocraticTrade/Info.plist`**: wire `CFBundleShortVersionString` / `CFBundleVersion` to `$(MARKETING_VERSION)` / `$(CURRENT_PROJECT_VERSION)` and set display name `Socratic-Trade` (project already had marketing version keys).
- **`ios/SocraticTradeTests/MobileModelsTests.swift`**: assert SSE request Accept + long timeout.

### Files touched

- `ios/SocraticTrade/LoginView.swift`
- `ios/SocraticTrade/MobileAPIClient.swift`
- `ios/SocraticTrade/MobileStore.swift`
- `ios/SocraticTrade/Info.plist`
- `ios/SocraticTradeTests/MobileModelsTests.swift`
- `STATUS.md`
- `docs/EFFORT-LOG.md`
- `/Users/jay/apps/TRADING-EFFORT-LOG.md`
- `docs/rollouts/2026-08-04-ios-signin-constraint-and-sse-events.md`

## 3. Decisions & Trade-offs

- Client-only fix for SSE; server route already returns a correct `text/event-stream` with 25s comments. No Coolify/Cloudflare change in this PR.
- Do **not** follow `.frame(maxWidth: 375)` with another `.frame(maxWidth: .infinity)` on the same button — that re-expands the UIKit host and revives the constraint fight.
- Residual: proxy/QUIC resets can still close long-lived streams; the client already reconnects every 5s. That is acceptable for a control remote that also reloads snapshots on each frame.

## 4. Verification State

```bash
# generic device build (no simulator runtimes installed on this host)
xcodebuild -project "ios/Socratic Trade.xcodeproj" -scheme SocraticTrade \
  -destination 'generic/platform=iOS' build

# JS gate still required by land.sh even for iOS-only edits
npm run lint && npx tsc --noEmit && npm test && npm run build
```

- No iOS Simulator runtimes available on the build host (`xcrun simctl list` empty under iOS 27.0); unit test `testEventsRequestUsesSSEAcceptAndLongTimeout` is source-verified and will run in Xcode when a simulator/device is selected.
- Owner: rebuild the app in Xcode and confirm the constraint warning is gone on Login and that `/api/mobile/events` no longer spams `-1017` every ~30s while signed in.

## 5. Next Steps & Blockers

- Rebuild/run on device or Simulator from this branch (or main after merge).
- If `-1017` persists after the client fix, inspect Coolify/Caddy buffering for the SSE path and HTTP/3 behavior; consider a short poll fallback when `isStreamConnected` stays false for >N seconds (out of scope here).

## 6. Zero-Code Findings

- System logs (`PointerUI`, `cannot add handler to 0 from 0`, QUIC queue caps) are unrelated to app logic.
- Unauthenticated `curl` of `/api/mobile/events` correctly returns HTTP 401 `Unauthorized` (middleware gate).


## Follow-up: Xcode project document format → 26.3

Xcode File Inspector showed **Project Format: Xcode 16.0-compatible** because
`objectVersion` / `preferredProjectObjectVersion` were **77** (Xcode 16). Bumped both
to **100** (same as Congress.Trade + Usage-Monitor Xcode 26 projects). `LastUpgradeCheck`
was already `2630`. `ios/project.yml` keeps `xcodeVersion: "26.3"` and notes that
XcodeGen 2.46 still emits 77, so re-apply 100 after regenerate.
