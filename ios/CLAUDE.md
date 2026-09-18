# Socratic.Trade iOS

**Bundle ID:** `trade.socratic.app`
**Project:** `ios/Socratic Trade.xcodeproj` (space in the basename)
**Scheme / module:** `SocraticTrade`
**Team:** `CC8UTF7ATG`
**XcodeGen:** `ios/project.yml` — edit this, then `xcodegen generate` (runs `ios/xcodegen-post.py` via `postGenCommand` to rewrite objectVersion 77 → 100). Do not hand-edit `project.pbxproj`.
**Ship:** GitHub-hosted `macos-latest` via `.github/workflows/ios-ship.yml` (`gh workflow run ios-ship.yml`). Wrapper: `scripts/ios-ship-testflight.sh` -> in-repo `scripts/ios-fleet/`. Do not run `xcodebuild` locally. Do not restart the retired Mac runner.

Binding fleet rule: `/Users/jay/apps/AGENT-SYNC.md` § iOS agent build loop. Do not stand up or narrate Xcode MCP. Do not run local `xcodebuild` / `xcrun simctl`.

## Build & test

Swift compile + XCTest run on GitHub-hosted `macos-latest` (`.github/workflows/ios-build.yml`). That job generates from `ios/project.yml`, builds unsigned, and runs the simulator test target. Linux / cloud seats cannot compile Swift; wait for that check.

`BUILD SUCCEEDED` on `ios-build` is not visual QA.

## File structure

```
ios/
├── project.yml                         # XcodeGen source of truth
├── Socratic Trade.xcodeproj/           # generated — do not hand-edit
└── SocraticTrade/
    ├── PrivacyInfo.xcprivacy           # App Store privacy manifest (UserDefaults CA92.1)
    ├── SocraticTradeApp.swift          # App entry, deep links, launch
    ├── MobileStore.swift               # @Observable client store (auth, snapshot, commands)
    ├── MobileAPIClient.swift           # HTTP to /api/mobile
    ├── MobileModels.swift              # Decodable snapshot / command types
    ├── MobileControlView.swift         # Root tabs + more-stack
    ├── HomeView.swift                  # Home tab
    ├── MarketsView.swift               # Markets / watchlist
    ├── ActivityView.swift              # Activity tab
    ├── ProposalsView.swift             # Approvals / proposals
    ├── InsightsView.swift              # Insights
    ├── AdminPortalView.swift           # Admin tab: native rail + fenced WKWebView
    ├── LoginView.swift                 # Sign-in
    ├── DeepLink.swift                  # Universal-link + push tap routing
    ├── PushNotifications.swift         # APNs register / tap
    ├── OrderCancel.swift               # Working-order cancel helpers
    ├── PolicyTightening.swift          # Ask-First ↔ Autopilot + raise/lower caps
    ├── AppComponents.swift             # Shared rows / chrome (bell, gear, wide sheets)
    ├── AppTypography.swift             # Type ramp
    ├── CandleWordmarkView.swift        # Brand wordmark
    ├── SymbolInfoSheet.swift           # Ticker sheet
    └── PreviewSupport.swift            # SwiftUI previews
└── SocraticTradeTests/                 # XCTest
```

New views go next to the sibling they belong with. New files created outside XcodeGen `sources:` will not compile until `project.yml` lists them (this target includes the whole `SocraticTrade/` folder).

## Rules

- `@Observable` + `@MainActor` on stores. Never `ObservableObject`.
- `NavigationStack` + value-based `NavigationLink`. Never `NavigationView`.
- Light is the product default. Do not ship dark-first chrome.
- Two spaces between sentences in user-visible copy.
- Never hand-edit `.pbxproj`, `.entitlements`, `.xib`, `.storyboard`.
- Secrets stay in `~/.secrets/` / Infisical. Never print them.
