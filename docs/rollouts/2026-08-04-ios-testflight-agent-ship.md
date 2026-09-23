# 2026-08-04 — iOS TestFlight agent ship (Socratic-Trade)

## Context & Objective

Enable agents to push native iOS updates all the way to the owner's iPhone via
TestFlight without opening the Xcode GUI. Cross-app with Congress.Trade and
Usage Monitor (same fleet scripts under `/Users/jay/apps/ios-fleet/`).

## Changes Made

- Added `scripts/ios-ship-testflight.sh` wrapper (app key `socratic`).
- Added `ios/ExportOptions-appstore.plist` and `ios/ExportOptions-export-ipa.plist`.
- Documented ship path in `ios/SocraticTrade/README.md`.
- Fleet registry entry: bundle `trade.socratic.app`, scheme `SocraticTrade`, team `CC8UTF7ATG`.

## Decisions & Trade-offs

- Prefer pure `xcodebuild` + optional `altool` over Fastlane (no extra Ruby dep).
- Build number defaults to `YYYYMMDDHHmm` for unique TestFlight builds.
- Upload tries Xcode session export first, then ASC API key via `~/.secrets/`.
- Public App Store submit remains a deliberate owner action (not automated).

## Verification State

- `bash /Users/jay/apps/ios-fleet/ship-testflight.sh socratic --repo-root <wt> --dry-run`
- Archive/export attempted on Mac with distribution identity present.
- Full TestFlight processing requires App Store Connect app record + ASC API key
  or Xcode session (owner one-time setup).

## Next Steps & Blockers

- Owner: drop ASC API key at `~/.secrets/appstore-connect.env` if not using Xcode session.
- Owner: ensure App Store Connect app exists for `trade.socratic.app`.
- Owner: install TestFlight once on the phone and accept the build.

## Verification receipts (2026-08-04)

- `bash scripts/ios-ship-testflight.sh --export-only` produced a signed IPA via
  `xcodebuild archive` + `exportArchive` with `-allowProvisioningUpdates`.
- Upload to TestFlight still requires App Store Connect app records + ASC API key
  at `~/.secrets/appstore-connect.env` (auth was `none` on this Mac at ship time).
