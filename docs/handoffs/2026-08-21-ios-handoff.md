# DEEPSEEK iOS Review — Handoff to Implementing Agent

Source: full review in `/tmp/deepseek-review-ios.md`.  Base: clean checkout at `41a7a438d` (origin/main).  Docs-only handoff; nothing here is implemented.  Board items to comment on (do NOT re-file): `830c892f` (CI gate), `410bda84` (build compliance), `ce75f8d0` (network/decode), `89249c60` (contract drift), `64f21332` (parity), `2056ceab` (contrast).

---

## 1) Implement first — items with anchors

1. **P1 — Required CI gate must compile AND test Swift.** `.github/workflows/ci.yml` (no xcodebuild anywhere), `.github/workflows/ios-build.yml:40-92` (build-only, non-required), ruleset `main-protection` requires only `verify` (`gh api repos/jaywedgeworth22/Socratic-Trade/rulesets/17945518` → `required_status_checks: [verify]`).
2. **P1 — Privacy manifest (ITMS-91053 risk).** `ios/project.yml` (no `PrivacyInfo.xcprivacy` in `sources:`); UserDefaults used at `ios/SocraticTrade/MobileStore.swift:150-163`, `ios/SocraticTrade/MobileControlView.swift:94`, `ios/SocraticTrade/CoachView.swift:10`.
3. **P1 — Crash: `Dictionary(uniqueKeysWithValues:)`.** `ios/SocraticTrade/MobileStore.swift:46`.
4. **P1 — Staleness gate disables Approve on one failed reload; no polling fallback.** `ios/SocraticTrade/MobileStore.swift:265-268` (`isSnapshotStale`), `:309` (`canSubmit` guard), `:350` (`snapshotLoadFailed = true`), `:355-396` (`startEvents` reconnect loop, no periodic reload).
5. **P2 — All-or-nothing snapshot decode.** `ios/SocraticTrade/MobileModels.swift:64-74` (arrays via `decodeIfPresent([X].self)`; non-optional `Position.symbol/quantity/marketValue` at `:255-264`; same risk in `MobileCommand` `:600-619`).
6. **P2 — Contract test program (89249c60).** Pattern to copy: `ios/SocraticTradeTests/PushNotificationTests.swift:290-395` (`PushDeepLinkContractTests` table) + `test/apns-deep-link-contract.test.ts` which parses the Swift file.  Decoders to cover: `MobileSnapshot`, `FullPolicy`, `MarketScanResponse`, `SymbolDeskInfo`.
7. **P2 — Tone tokens fail WCAG AA.** `ios/SocraticTrade/AppComponents.swift:13-15` (`Color.green/.orange/.red`) rendered as 11-12pt text in `StatusPill` (`:571-572`) and `MetricTile`.
8. **P3 — Version record drift: project.yml `1.0.8` vs TestFlight `1.0.68`.** `ios/project.yml:23-27`; fleet train `/Users/jay/apps/ios-fleet/README.md:89-97`; ship script passes `MARKETING_VERSION` on the xcodebuild line, and `--sync-project-version` is a documented no-op because `xcodegen generate` rewrites the pbxproj from project.yml.

## 2) Recommended fix approach per item

1. **CI gate:** Add a `macos` job to `ci.yml`'s `verify` workflow running `xcodebuild test -project 'ios/Socratic Trade.xcodeproj' -scheme SocraticTrade -destination 'platform=iOS Simulator,name=iPhone 17 Pro' CODE_SIGNING_ALLOWED=NO` on the existing `mac-xcode26-socratic` runner (keep the fork-PR guard from ios-build.yml:36-38), OR add a test step to ios-build.yml and ask the owner to add `ios-build` to the ruleset required checks (rulesets are owner-side; repo workflow alone can't make it required).  Prefer the ci.yml job: it makes Swift part of the SAME required check and cannot be skipped.
2. **Privacy manifest:** Create `ios/SocraticTrade/PrivacyInfo.xcprivacy` with `NSPrivacyAccessedAPITypes` = `NSPrivacyAccessedAPICategoryUserDefaults` reason `CA92.1` ONLY (Apple rejects unused reasons; the app does not use file-timestamp/disk-space/boot-time APIs).  Declare it in `project.yml` `sources:` (or the target's `info`), then `xcodegen generate` and verify it survives a regen (xcodegen drops unlisted files silently).
3. **Crash:** One line — `Dictionary(commands.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })`.  Add a unit test that feeds duplicate-id commands through `CommandAttemptTracker.reconcile` (currently aborts).
4. **Staleness:** Split the two causes: keep `snapshotLoadFailed` for the banner/empty state, but make `canSubmit` gate on age only (`now.timeIntervalSince(lastUpdatedAt) > 180`), so one transient 502 cannot disable Approve/Run/Watchlist/Policy.  Add a periodic reload (~60s) in `startEvents` when `isStreamConnected == false && isAuthenticated` so a dead stream self-heals without pull-to-refresh.  Keep `account.activate`/`order.cancel` exemptions as-is.
5. **Decode resilience:** Decode each list element with a `try?` helper that drops malformed rows (small generic `lossyArray(_:from:)`), applied at minimum to `positions`, `orders`, `recentCommands`, `notifications`, `pendingProposals` in `MobileSnapshot.init`.  Keep `catalog`'s existing `try?` fallback pattern (MobileModels.swift:58).  Do NOT make production models `Encodable` to satisfy tests (see 08-20-ios-test-target-repair.md).
6. **Contract tests:** Check in a `Fixtures/mobile-snapshot-contract.json` captured from the current `app/api/mobile/snapshot/route.ts` output shape (and one for `FullPolicy`/`symbol-desk`/`scan`), decode it in Swift tests, AND add a vitest test that regenerates/compares the fixture against the live route (mirror how `test/apns-deep-link-contract.test.ts` parses the Swift table).  This is the one pattern in the repo that genuinely ties both sides together — reuse it.
7. **Contrast:** Replace system colors with dark-toned light-theme tokens (green ≈ `#1a7f37`, orange ≈ `#9a6700`, red ≈ `#b3261e`; keep dark-theme variants via `UIColor { traits in … }` like `AppPalette.accent` at `:7-12`).  Add a unit test asserting each token vs white background ≥ 4.5:1 (hardcode hex, compute ratio — no SwiftUI needed).
8. **Version drift:** Repo-side: update `MARKETING_VERSION`/`CURRENT_PROJECT_VERSION` in `project.yml` to the latest shipped (1.0.68 / `202608182121`) and add a `scripts/` guard (or extend `ios-fleet-pin.sh`) that fails the ship if project.yml lags the fleet train.  Fleet-side (`/Users/jay/apps/ios-fleet/ship-testflight.sh`) should also write project.yml; flag to owner since that dir is untracked shared tooling.

## 3) Tests that must fail first + verification commands

- **Item 3:** new `CommandAttemptTracker` duplicate-id test aborts before fix → passes after.
- **Item 4:** new test: simulate failed load (`snapshotLoadFailed = true`) then assert `canSubmit("proposal.approve")` is true when `lastUpdatedAt` is < 180s old (currently false) → flips after fix.
- **Item 5:** new fixture with one malformed row in `positions` — `MobileSnapshot` currently fails to decode → decodes with the row dropped after fix.
- **Item 6:** the new TS fixture test fails against the live route if the route drifted; the Swift decode test fails on a rename.
- **Item 7:** new contrast-ratio test fails for `Color.green` etc. → passes with tokens.
- **Item 1:** failing-first proof = a PR that only breaks a Swift test must NOT merge (today it does; the ios-build.yml check is not required).

Verification for every Swift change:
```bash
xcodebuild build -project 'ios/Socratic Trade.xcodeproj' -scheme SocraticTrade \
  -destination 'generic/platform=iOS' CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO
xcodebuild test -project 'ios/Socratic Trade.xcodeproj' -scheme SocraticTrade \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' CODE_SIGNING_ALLOWED=NO
```
(Current state on this checkout: both build and test-target compile pass, exit 0.)  Web-adjacent (items 1, 6): `npm run lint`, `npx tsc --noEmit`, `npx vitest run test/apns-deep-link-contract.test.ts` (and the new fixture test), `npm test`.  Do not skip the Swift half of the gate on the strength of tsc/vitest — they prove nothing about Swift (AGENTS.md iOS build-loop section).

## 4) Pitfalls / related code to touch carefully

- **xcodegen owns the project.**  Never hand-edit `ios/Socratic Trade.xcodeproj/project.pbxproj`, `SocraticTrade.entitlements`, or `Info.plist` — xcodegen rewrites all three from `project.yml` on every `generate`.  New files (PrivacyInfo.xcprivacy, fixtures) must be added under `sources:`/listed or they compile/regenerate-away silently.  After `xcodegen generate`, restore `objectVersion = 100` / `preferredProjectObjectVersion = 100` if it emitted 77 (ios/CLAUDE.md:7).
- **Test-target wiring is load-bearing:** `PRODUCT_MODULE_NAME: SocraticTrade`, `TEST_HOST`, `BUNDLE_LOADER` in `project.yml` fixed the never-runnable test target — do not touch.
- **Item 4 touches the heart of command gating** — keep the protective-command exemptions (`strategy.stop/close_only/liquidating`, `proposal.reject` at MobileStore.swift:788-793) and the `account.activate`/`order.cancel` stale-exemptions (`:296-308`) intact; `order.cancel` relies on the server-side `requireWorkingOrder` re-validation.
- **Item 5:** the snapshot cache stores raw bytes and is re-decoded on cold launch (MobileStore.swift:149-163); a lenient decode changes what a stale cache can render — re-run `MobileModelsTests`/`DeskModelsTests` fully.
- **Item 6:** fixtures must be generated from the ROUTE, not from Swift assumptions; `compactMobileMarketScan` (src/lib/mobile-scan.ts) trims `latestScan` — include that shape.
- **Item 1:** the verify workflow is GitHub-hosted (ubuntu-latest) and must not gain self-hosted labels; the mac runner (`mac-xcode26-socratic`) is the ONLY registered self-hosted runner and is ST's — don't add more.
- **Version bump (item 8):** the fleet README says bump `MARKETING_VERSION` in pbxproj — that gets wiped by xcodegen; the real edit point is `project.yml`.  Coordinate the fleet-script change with the owner; do not edit `/Users/jay/apps/ios-fleet` from this repo's PR.

## 5) What to avoid

- **Already fixed — do not re-touch:** sign-out/disk-snapshot restore (3b343933 — `clearLocalSession` at MobileStore.swift:691-716 removes cache keys; `init` at :165-178 uses the saved timestamp; tests in MobileModelsTests.swift:413-491); nested `riskRules` stop-loss decode (DeskModels.swift:368-374); Coach markdown rendering + no-remote-image/HTML security (CoachMarkdown.swift); Scan column-header removal and last-good-on-503 (`keepingLastGood`); `StoreTransientAlerts` modal error/success surfacing; the parity copy renames (Max Per Order / Max Spend Per Day / Max Opening Orders Per Day / Stop-Loss (Base %) / Short Stop-Loss / Always Include (Symbols) / Ask-first / "execute in Autopilot"); "Exit Only" command-name vs "Exit-only"/"Winding down" state-word casing (tests in UserFacingCopyTests.swift:219-254 pin this — do not "unify").
- **Board duplicates:** comment on `830c892f`, `410bda84`, `ce75f8d0`, `89249c60`, `64f21332`, `2056ceab` rather than filing new findings; `3b343933` should be closed (both halves landed).
- **Do not** add paper/live ceremony, "Mock" options, or re-introduce any fake-execution path; do not touch `app/mobile/**` (PWA retired); never create/mint provider keys; never print secrets (`~/.secrets` names only).
- **Do not** rename `PolicyTightening.Cap` titles or `DeskCopy` canonical sentences without updating BOTH the read-only rows and the edit controls (UserFacingCopyTests.swift:301-314 guards the pairing).
- **Do not** make `MobileSnapshot`-family models `Encodable` just to seed tests — seed the cache with raw response bytes (the 08-20 test-target fix).
