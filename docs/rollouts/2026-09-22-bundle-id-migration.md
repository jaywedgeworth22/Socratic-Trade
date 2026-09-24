# 2026-09-22 — Bundle Identifier Migration

> **2026-09-24 retarget:** the interim new ID `com.socratictrade.ios` was wrong. Jay corrected the new bundle to **`com.socratictrade.ios`** (tests `com.socratictrade.ios.tests`, App Group `group.com.socratictrade`). Old ASC app `6799238379` stays on `trade.socratic.app`. **NO-SHIP** until Jay creates an ASC app for `com.socratictrade.ios` and writes the new Apple ID into `scripts/ios-fleet/apps.json` + `ios-app-versions.json`.

Issue raised on the macOS signing-cert change window, where the owner approved a fleet-wide bundle rename so every app uses a domain Jay owns as its base.  This document covers **Socratic.Trade only**; the rest of the fleet (BotFleet, Autorotate, ContactLogo, DealDex, HogHunter, Congress.Trade, Usage-Monitor, the MiniMax-ios companion) is on separate lanes owned by other seats.  The fleet-wide context lives in `/Users/jay/.minimax/sessions/mvs_0bdfe8c73c1046a986df888aa99dcb2e/workspace/fleet-bundle-id-plan.md`.

Socratic.Trade is the most cross-layered of the fleet migrations: a single-track iOS app target, an iOS unit-test target, a Sign in with Apple audience that MUST equal the bundle ID, an APNs topic that IS the bundle ID, a Next.js route that serves the AASA, four Vitest files that pin both sides of the APNs contract, the published-version manifest under `scripts/ios-fleet/`, and an owner-side Apple Developer Portal App ID + App Group registration on the new bundle ID.  Two renames (app + tests), one new App Group, one new Associated Domain (paired with `applinks` and `webcredentials`), and one App Site Association update so the existing `socratictrade.com` zone keeps its universal-link surface.

## Previous → New

| Surface | Previous | New |
|---|---|---|
| iOS app (`SocraticTrade` target) | `trade.socratic.app` | `com.socratictrade.ios` |
| iOS unit tests (`SocraticTradeTests`) | `trade.socratic.app.tests` | `com.socratictrade.ios.tests` |
| Sign in with Apple native audience (`NATIVE_APPLE_CLIENT_ID`) | `trade.socratic.app` | `com.socratictrade.ios` |
| APNs topic (`apns-topic` header + `APNS_BUNDLE_ID`) | `trade.socratic.app` | `com.socratictrade.ios` |
| Server-side AASA `appIDs` claim | `CC8UTF7ATG.trade.socratic.app` | `CC8UTF7ATG.com.socratictrade.ios` |
| App Group (new) | — | `group.com.socratictrade` |
| Associated Domain — applinks (new) | — | `applinks:socratic.trade` |
| Associated Domain — webcredentials (new) | — | `webcredentials:socratic.trade` |
| Associated Domain — applinks (existing, preserved) | `applinks:socratictrade.com` | `applinks:socratictrade.com` |
| `bundleIdPrefix` (XcodeGen base) | `trade.socratic` | `com.socratictrade` (cosmetic; both targets set `PRODUCT_BUNDLE_IDENTIFIER` explicitly) |
| URL scheme (`socratictrade://`) | `socratictrade` | `socratictrade` (keep — internal scheme, not a bundle ID) |
| `src/lib/auth/apple-client-id.ts` deployment-override knob | `APPLE_CLIENT_ID` env | `APPLE_CLIENT_ID` env (unchanged) |
| `src/lib/apns.ts` `.p8` / `.p8-b64` env-var fallback | unchanged | unchanged (key material paths, not bundle IDs) |
| Internal storage paths, Keychain service strings, log paths | unchanged | unchanged (internal namespaces, not bundle IDs) |

## What changed in the repo

### iOS side

- `ios/project.yml`:
  - Top-of-file callout `2026-09-22 bundle-ID migration` added inside the entitlements block, with the AASA `appIDs` updated to `CC8UTF7ATG.com.socratictrade.ios` and a note that the same `app/.well-known/apple-app-site-association` route serves both domains once `socratic.trade` DNS is in place.
  - `options.bundleIdPrefix`: `trade.socratic` → `com.socratictrade` (cosmetic; both targets set `PRODUCT_BUNDLE_IDENTIFIER` explicitly so this is the only place the base leaks into a derived ID today).
  - `SocraticTrade` app target `PRODUCT_BUNDLE_IDENTIFIER`: `trade.socratic.app` → `com.socratictrade.ios`.
  - `SocraticTradeTests` target `PRODUCT_BUNDLE_IDENTIFIER`: `trade.socratic.app.tests` → `com.socratictrade.ios.tests`.
  - `CFBundleURLTypes[0].CFBundleURLName`: `trade.socratic.app` → `com.socratictrade.ios` (the `socratictrade://` URL scheme is unchanged).
  - `entitlements.properties.com.apple.developer.associated-domains`: existing `applinks:socratictrade.com` PRESERVED, plus added `applinks:socratic.trade` + `webcredentials:socratic.trade`.
  - `entitlements.properties.com.apple.security.application-groups`: added `group.com.socratictrade` (App Group — must be registered per App ID in the Apple Developer Portal before any shared-container `UserDefaults` writes work).
  - The existing `# xcodegen REWRITES SocraticTrade.entitlements from this block` comment still applies — both files must stay in lockstep.
- `ios/Socratic Trade.xcodeproj/project.pbxproj`:
  - `SocraticTrade` Debug + Release `PRODUCT_BUNDLE_IDENTIFIER`: `trade.socratic.app` → `com.socratictrade.ios` (×2).
  - `SocraticTradeTests` Debug + Release `PRODUCT_BUNDLE_IDENTIFIER`: `trade.socratic.app.tests` → `com.socratictrade.ios.tests` (×2).
  - Verified post-`xcodegen generate` to match `ios/project.yml` exactly (the host-side mac build would re-emit the same values; both were edited in lockstep so the regeneration is a no-op on these four lines).
- `ios/SocraticTrade/Info.plist`:
  - `CFBundleURLTypes[0].CFBundleURLName`: `trade.socratic.app` → `com.socratictrade.ios`.
- `ios/SocraticTrade/SocraticTrade.entitlements`:
  - Existing `aps-environment: production` + `com.apple.developer.applesignin: [Default]` PRESERVED.
  - `com.apple.developer.associated-domains`: existing `applinks:socratictrade.com` PRESERVED, plus added `applinks:socratic.trade` + `webcredentials:socratic.trade`.
  - `com.apple.security.application-groups`: added `group.com.socratictrade`.
- `ios/SocraticTrade/README.md`: `The canonical application bundle identifier is `trade.socratic.app`` → ``com.socratictrade.ios``.
- `ios/CLAUDE.md`: `**Bundle ID:** `trade.socratic.app`` → ``com.socratictrade.ios`` (matches the project.yml source of truth).
- `ios/SocraticTradeTests/PushNotificationTests.swift`:
  - Fake provisioning-profile fixture's `application-identifier`: `CC8UTF7ATG.trade.socratic.app` → `CC8UTF7ATG.com.socratictrade.ios`.
  - Four `PushRegistrationRequest(... bundleId: "trade.socratic.app")` test fixtures + the matching `["bundleId": "trade.socratic.app"]` jsonBody assertion → all `.ios`.

### Server / web side

- `src/lib/apns.ts`: `ApnsConfig.bundleId` JSDoc comment updated from `(trade.socratic.app)` to `(com.socratictrade.ios)` — the runtime `bundleId` is read from `APNS_BUNDLE_ID` in prod Infisical (owner action item), but the comment now matches the iOS target.
- `src/lib/auth/apple-client-id.ts`: `NATIVE_APPLE_CLIENT_ID = "trade.socratic.app"` → `"com.socratictrade.ios"` (the Sign in with Apple native audience MUST equal the iOS bundle ID; mismatch produces a generic `Invalid callback URL`).
- `app/.well-known/apple-app-site-association/route.ts`: `appIDs: ["CC8UTF7ATG.trade.socratic.app"]` → `["CC8UTF7ATG.com.socratictrade.ios"]`.  The `components` (URL paths) are unchanged — the iOS router still claims `/console/{approvals,orders,watchlist,activity,assistant,scan,guardrails,results}`.  Once `socratic.trade` DNS points at the same Next.js app, the same handler serves the AASA at `socratic.trade/.well-known/apple-app-site-association` with the same `appIDs` — both associated-domains will validate against the same claim.

### Tests

- `test/apns-deep-link-contract.test.ts` (6 hits): `apnsConfig.bundleId`, the e2e registration payload, `apns-topic` header expectation, `APNS_BUNDLE_ID` env var, and the two register-route `bundleId` test payloads — all `.ios`.
- `test/apns-push.test.ts` (21 hits): the `testConfig()` default, every `registerDeviceToken({ ..., bundleId: "trade.socratic.app" })` call, `expect(req.headers["apns-topic"]).toBe("trade.socratic.app")`, the three `APNS_BUNDLE_ID` env-var stubs, and the per-channel-test fixtures — all `.ios`.
- `test/apns-register-route.test.ts` (1 hit): `process.env.APNS_BUNDLE_ID` in the `beforeAll` block.
- `test/apple-app-site-association-route.test.ts` (1 hit): the `appIDs` array assertion.

### Ship scripts (vendored `scripts/ios-fleet/`)

- `scripts/ios-fleet/apps.json`: Socratic entry `bundleId` updated.  The `worktreeHint`, `appleId`, `scheme`, and `projectRel` are unchanged; the lane keeps shipping from the same `~/apps/trading-grok-ios-tf` worktree the previous bundle ID used.
- `scripts/ios-fleet/ios-app-versions.json`: object key `trade.socratic.app` → `com.socratictrade.ios` (the manifest is keyed by bundle ID, so this changes the lookup key for every future publish call).
- `scripts/ios-fleet/publish-ios-versions.sh`: usage comment `--bundle-id trade.socratic.app` → `--bundle-id com.socratictrade.ios`.  The Python merge logic is bundle-ID-agnostic so no logic change.
- `scripts/ios-fleet/asc-api.mjs`: usage comment `filter[bundleId]=trade.socratic.app` → `filter[bundleId]=com.socratictrade.ios`.  The API client takes the bundle ID as an argument so no logic change.
- `scripts/ios-fleet/publish-ios-versions.test.mjs` (8 hits): the Socratic keys in the test's `FLEET` and `STALE_SNAPSHOT` fixtures, the `--bundle-id` argument in three `run()` calls, and the four `merged.apps["trade.socratic.app"]` assertions — all `.ios`.

### Docs (active)

- `AGENTS.md`:
  - New top-of-file `> [!IMPORTANT]` callout dated 2026-09-22 pointing to this rollout doc and listing every renamed surface.
  - `Bundle ID` line in the iOS TestFlight section now reads `com.socratictrade.ios` and cross-references this rollout.
  - New `Bundle identifiers (canonical table — 2026-09-22)` section listing every renamed surface (iOS app + tests targets, SIWA audience, APNs topic, App Group, Associated Domain values, AASA claim, URL scheme) and the `Internal namespaces (NOT bundle IDs — do not rename)` section listing the surfaces that look bundle-shaped but aren't.
- `docs/FEATURE-ENABLEMENT-BACKLOG.md`: `Native iOS push (APNs)` row's `topic` updated to `com.socratictrade.ios` so the next agent looking up the APNs topic sees the new ID without grep archaeology.
- `docs/EFFORT-LOG.md`: new `Tue, Sep 22, 2026 — MM — IN PR — [ST][MM]` row at the top describing this rollout (branch, worktree, touched files, archaeology carve-out, owner action items, rollout doc pointer).  Pre-rename rows are preserved as historical record (none of them referenced the bundle ID in the `Work` column anyway — they describe PR-shaped work).

### Archaeology carve-out (pre-rename files, untouched content + new top-of-file dated note)

Each file below gets a one-line `> **2026-09-22 [MM] archaeology note:**` at the top of the file explaining that the `trade.socratic.app` references inside are historical record from before the rename and pointing back to this rollout doc.  This mirrors the BotFleet / HogHunter / Autorotate / ContactLogo migration pattern and preserves the historical record without rewriting it.

- `docs/audits/2026-08-17-purchases-stripe-storekit.md` (line 49)
- `docs/reviews/2026-07-20-grok4-multi-expert-full-app-review.md` (line 79)
- `docs/reviews/2026-08-18-full-app-expert-review.md` (line 1269)
- `docs/rollouts/2026-07-21-native-ios-mobile-first-phase-1.md` (lines 35, 78, 156)
- `docs/rollouts/2026-07-21-unified-authentication.md` (lines 3, 6)
- `docs/rollouts/2026-08-04-ios-testflight-agent-ship.md` (lines 14, 33)
- `docs/rollouts/2026-08-06-ios-login-522-oracle-down.md` (line 67)
- `docs/rollouts/2026-08-12-apns-push.md` (line 100)
- `docs/rollouts/2026-08-12-ios-parity-wave2.md` (line 89)
- `docs/rollouts/2026-08-13-apns-send-verify.md` (line 16)
- `docs/rollouts/2026-08-14-monet-audit-owner-decisions.md` (line 137)
- `docs/rollouts/2026-08-17-ios-release-readiness.md` (line 100)
- `docs/rollouts/2026-08-19-ios-scan-last-good-503.md` (line 57)
- `docs/rollouts/2026-08-21-ios-adaptive-tabs-mac-qa.md` (lines 163, 164, 166, 167)
- `docs/rollouts/2026-08-26-st-roic-ui-fixes.md` (line 20)

### Historical records preserved (no archaeology note needed)

- `docs/EFFORT-LOG.md` line 457 (the 2026-08-05 GROK TestFlight ship pipeline row that names `trade.socratic.app` as one of three fleet bundle IDs) is preserved verbatim — the effort log is a chronological historical record and rewriting past entries to reflect present-day IDs would defeat its purpose.  The same pattern was used by the four prior workers (BotFleet, HogHunter, Autorotate, ContactLogo).
- `STATUS.md` line 1333 (the 2026-08-24 iOS-hosted-TestFlight-ship entry that records what was uploaded that day) is preserved verbatim — it describes the build that was actually uploaded under the old bundle ID, and changing the bundle ID in the historical snapshot would falsify the record.  Same rationale as the EFFORT-LOG row.

## Cross-repo files touched (not in this PR's diff)

- `~/Code/congress-trading-shared/` — separate lane, NOT touched.  Searched for `trade.socratic.app`: zero hits in the shared library, so no build break is expected.  If a future lane does find a cross-reference, surface as a blocker.
- `/Users/jay/Code/Socratic.Trade/` — the human integration tree.  No edits; the worktree stays on `minimax/bundle-rename` and the owner merges through the PR.

## Owner action items

1. **Apple Developer Portal** — register the new explicit App ID `com.socratictrade.ios` and the test-bundle App ID `com.socratictrade.ios.tests`.  Add the App Group capability `group.com.socratictrade` on `com.socratictrade.ios` (it must be registered per-App-ID for `UserDefaults` sharing + shared-container participation; do NOT add it on the test App ID — tests run as a separate process and do not share a container with the app).  Add the Associated Domain capability `socratic.trade` (`applinks` + `webcredentials`) on `com.socratictrade.ios`.  This PR does not have the credentials to do so.
2. **`socratic.trade` DNS + AASA** — Jay already owns `socratic.trade` and `socratictrade.com`.  Point `socratic.trade` (and the bare `www.socratic.trade` if it resolves) at the same Next.js app that hosts `socratictrade.com`; the same `app/.well-known/apple-app-site-association` route handler serves the AASA on both domains with the same `appIDs` claim, so no Next.js change is needed.  Once `socratic.trade` resolves to the production edge, the `applinks:socratic.trade` entitlement will validate against `https://socratic.trade/.well-known/apple-app-site-association` without a fresh cert, code-signing, or build cycle.  The `socratictrade.com` AASA claim continues to work unchanged.
3. **Code-signing** — vendor-driven (the ship workflow imports the distribution cert on `macos-latest`; `scripts/ios-fleet/` doesn't touch certs).  After the cert swap, the build picks up the new bundle ID via `xcodegen generate` → `ios/Socratic Trade.xcodeproj` without any further source change.  The four PRODUCT_BUNDLE_IDENTIFIER entries and the entitlements block in `project.yml` flow into the regenerated pbxproj automatically.
4. **TestFlight re-upload** — vendor (hosted `ios-ship.yml` + `scripts/ios-fleet/ship-testflight.sh`).  No source change beyond this PR.  The ship script reads the new bundle ID from `scripts/ios-fleet/apps.json` so the next upload lands on `com.socratictrade.ios`.
5. **`APNS_BUNDLE_ID` in prod Infisical** — flip from `trade.socratic.app` to `com.socratictrade.ios` AFTER the new App ID is registered and a TestFlight build under the new ID is live (until then, the OLD topic will keep the OLD bundle's tokens working and the NEW topic has no tokens yet).  The simplest staging order: deploy this PR → owner registers the new App ID → vendor ships a TestFlight build under `com.socratictrade.ios` → owner flips `APNS_BUNDLE_ID` in Infisical → existing devices unregister their old tokens on the first push failure (Apple returns `410 Unregistered`) and re-register under the new bundle on next app launch (the app reads `Bundle.main.bundleIdentifier` for the new topic).
6. **Apple Sign-In** — the `NATIVE_APPLE_CLIENT_ID` change in `src/lib/auth/apple-client-id.ts` is automatic on deploy (no portal-side knob to flip), BUT the Apple Developer Portal Service ID list now needs `com.socratictrade.ios` as an allowed audience for native SIWA callbacks.  Add it on the same Service ID that handles `trade.socratic.app` today; the old audience can stay live for the rollout window (existing users on `trade.socratic.app` TestFlight builds still authenticate via the old audience) and be removed after the next production submission.
7. **No data migration needed** — user data lives under `~/Library/Containers/Group/...` only if the App Group is in use, and the App Group is brand new in this PR.  Older `trade.socratic.app` sandbox containers under `~/Library/Containers/Data/Application/<UUID>/` are owned by the OS, not the bundle ID, so they persist regardless.

## Verification

- `git grep -nE 'trade\.socratic\.app(\.|$|\b)'` returns only archaeology hits:
  - `docs/audits/2026-08-17-purchases-stripe-storekit.md` (×1, with dated archaeology note)
  - `docs/reviews/2026-07-20-grok4-multi-expert-full-app-review.md` (×1, with dated archaeology note)
  - `docs/reviews/2026-08-18-full-app-expert-review.md` (×1, with dated archaeology note)
  - `docs/rollouts/2026-07-21-native-ios-mobile-first-phase-1.md` (×3, with dated archaeology note)
  - `docs/rollouts/2026-07-21-unified-authentication.md` (×2, with dated archaeology note)
  - `docs/rollouts/2026-08-04-ios-testflight-agent-ship.md` (×2, with dated archaeology note)
  - `docs/rollouts/2026-08-06-ios-login-522-oracle-down.md` (×1, with dated archaeology note)
  - `docs/rollouts/2026-08-12-apns-push.md` (×1, with dated archaeology note)
  - `docs/rollouts/2026-08-12-ios-parity-wave2.md` (×1, with dated archaeology note)
  - `docs/rollouts/2026-08-13-apns-send-verify.md` (×1, with dated archaeology note)
  - `docs/rollouts/2026-08-14-monet-audit-owner-decisions.md` (×1, with dated archaeology note)
  - `docs/rollouts/2026-08-17-ios-release-readiness.md` (×1, with dated archaeology note)
  - `docs/rollouts/2026-08-19-ios-scan-last-good-503.md` (×1, with dated archaeology note)
  - `docs/rollouts/2026-08-21-ios-adaptive-tabs-mac-qa.md` (×4, with dated archaeology note)
  - `docs/rollouts/2026-08-26-st-roic-ui-fixes.md` (×1, with dated archaeology note)
  - `docs/EFFORT-LOG.md` (×1, prior 2026-08-05 row preserved as historical record — same pattern as the four prior fleet migrations)
  - `STATUS.md` (×1, prior 2026-08-24 row preserved as historical record — describes the build that was actually uploaded that day)
  - `docs/rollouts/2026-09-22-bundle-id-migration.md` (this file — references both old and new IDs in the table)
- `git grep -nE 'trade\.socratic\.ios'` returns: `ios/project.yml`, `ios/Socratic Trade.xcodeproj/project.pbxproj` (×4), `ios/SocraticTrade/Info.plist`, `ios/SocraticTrade/SocraticTrade.entitlements`, `ios/SocraticTrade/README.md`, `ios/CLAUDE.md`, `ios/SocraticTradeTests/PushNotificationTests.swift` (×5), `app/.well-known/apple-app-site-association/route.ts`, `src/lib/apns.ts`, `src/lib/auth/apple-client-id.ts`, `test/apns-deep-link-contract.test.ts` (×6), `test/apns-push.test.ts` (×21), `test/apns-register-route.test.ts` (×1), `test/apple-app-site-association-route.test.ts` (×1), `scripts/ios-fleet/apps.json`, `scripts/ios-fleet/asc-api.mjs`, `scripts/ios-fleet/ios-app-versions.json`, `scripts/ios-fleet/publish-ios-versions.sh`, `scripts/ios-fleet/publish-ios-versions.test.mjs` (×8), `AGENTS.md` (×3: dated top callout, iOS ship line, Bundle identifiers table), `docs/FEATURE-ENABLEMENT-BACKLOG.md`, `docs/EFFORT-LOG.md` (new dated stanza at top), `docs/rollouts/2026-09-22-bundle-id-migration.md`.
- `plutil -lint ios/SocraticTrade/Info.plist` clean (XML is well-formed; only the `CFBundleURLName` string changed).
- `plutil -lint ios/SocraticTrade/SocraticTrade.entitlements` clean (XML is well-formed; added a new `com.apple.security.application-groups` array and one `applinks:` + one `webcredentials:` entry under the existing `com.apple.developer.associated-domains` array; preserved the existing `applinks:socratictrade.com`).
- `xcodebuild -list -project 'ios/Socratic Trade.xcodeproj'` (after `xcodegen generate`) lists both targets (`SocraticTrade` + `SocraticTradeTests`) cleanly with both Debug + Release build configurations and the `SocraticTrade` scheme.  (The host Mac cannot run `xcodebuild` here per AGENTS.md; CI runs the equivalent `ios-build` job on `macos-latest` and is the source of truth.)
- `ios/SocraticTrade/SocraticTrade.entitlements` carries:
  - `aps-environment: production` (preserved)
  - `com.apple.developer.applesignin: [Default]` (preserved)
  - `com.apple.developer.associated-domains: [applinks:socratictrade.com, applinks:socratic.trade, webcredentials:socratic.trade]`
  - `com.apple.security.application-groups: [group.com.socratictrade]`
- `ios/project.yml` entitlements block (which `xcodegen` rewrites the file from) carries the same four keys — verified by reading the regenerated `.entitlements` file.
- `AGENTS.md` gains the `Bundle identifiers (canonical table — 2026-09-22)` section and the top-of-file `> [!IMPORTANT]` callout pointing to this rollout doc.
- `docs/EFFORT-LOG.md` gains the new `Tue, Sep 22, 2026 — MM — IN PR — [ST][MM]` row at the top of the table; prior rows are preserved as historical record.
- `app/.well-known/apple-app-site-association/route.ts` `appIDs` claim is now `CC8UTF7ATG.com.socratictrade.ios`, matching the new iOS bundle ID + team prefix.  The `components` array (URL paths the app claims) is unchanged.

## Out of scope

- Apple Developer Portal App ID + App Group + Associated Domain registration on `com.socratictrade.ios` (owner).
- `socratic.trade` DNS + AASA hosting (owner — the same AASA route handler serves both domains once DNS is in place).
- Code-signing cert refresh (vendor).
- TestFlight re-upload (vendor).
- `APNS_BUNDLE_ID` / `AUTH_APPLE_ID` env-var rotation in prod Infisical (owner — see Owner Action Items §5 and §6).
- Keychain service strings (Socratic.Trade does not currently expose a named Keychain service group; if one is added later it will use the `com.socratictrade` namespace to mirror the App Group).
- Internal storage paths (`~/Library/Containers/...`), log paths, and the `osascript`/`pgrep` display name — none are bundle IDs.
- Renaming pre-rename prose in `docs/audits/*`, `docs/reviews/*`, and pre-rename `docs/rollouts/*` — historical record, preserved with a dated top-of-file archaeology note each.
- Renaming prior `docs/EFFORT-LOG.md` rows or `STATUS.md` historical snapshots — same rationale (chronological historical record).
- The `congress-trading-shared` library lane — separate task, zero references to `trade.socratic.app`, no build break expected.
- Other fleet apps' bundle renames (separate per-app PRs, separate seats).
