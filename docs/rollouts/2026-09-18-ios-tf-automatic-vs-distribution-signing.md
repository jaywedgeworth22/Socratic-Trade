# 2026-09-18 — iOS TestFlight: Automatic vs Apple Distribution signing conflict

## Context & Objective

After #3399 fixed objectVersion 100, hosted `ios-ship` runs 35329480758 / 35329482010 still failed
archive rc=65 with:

> SocraticTrade is automatically signed for development, but a conflicting code signing identity
> Apple Distribution has been manually specified.

`CODE_SIGN_STYLE=Automatic` and a manual `CODE_SIGN_IDENTITY=Apple Distribution` (in both
`project.yml` Release and `ship-testflight.sh` xcodebuild) are incompatible on Xcode 26 CI.

## Changes Made

- Removed Release `CODE_SIGN_IDENTITY: Apple Distribution` from `ios/project.yml` (Congress.Trade
  pattern: Automatic only; distribution cert from `ios-appstore-gm-prepare.sh` + ASC API key).
- Removed `CODE_SIGN_IDENTITY="Apple Distribution"` from `scripts/ios-fleet/ship-testflight.sh`
  archive invocation.
- Regenerated `ios/Socratic Trade.xcodeproj/project.pbxproj` (Release back to iPhone Developer +
  Automatic; objectVersion 100 unchanged).
- Refreshed `scripts/ios-fleet.sha256` pin for `ship-testflight.sh`.

Files touched:

- `ios/project.yml`
- `ios/Socratic Trade.xcodeproj/project.pbxproj`
- `scripts/ios-fleet/ship-testflight.sh`
- `scripts/ios-fleet.sha256`
- `docs/rollouts/2026-09-18-ios-tf-automatic-vs-distribution-signing.md`

## Decisions & Trade-offs

- Reverted #3399's manual Distribution identity override; Congress.Trade ships with Automatic only
  and does not set `CODE_SIGN_IDENTITY` on archive.
- Did not switch to Manual signing (larger diff; not fleet standard).
- Did not mint new ASC profiles or keys. `force_ship=0`.

## Verification State

```bash
bash scripts/ios-fleet-pin.sh --check
grep 'objectVersion = 100' "ios/Socratic Trade.xcodeproj/project.pbxproj"
grep 'Apple Distribution' "ios/Socratic Trade.xcodeproj/project.pbxproj" && exit 1 || echo "no manual Distribution in pbxproj"
cd ios && xcodegen generate && python3 xcodegen-post.py
```

Local gate: ios-only; hosted `ios-build` + `ios-ship` on the PR are authoritative.

## Next Steps & Blockers

- Merge PR after `verify` + `ios-build` green; watch next `ios-ship` archive on main.
- If archive still searches for App Development profiles, capture `archive.log` — next lever is
  Manual signing for Release only, not re-adding `Apple Distribution` under Automatic.

## Zero-Code Findings

Root cause: #3399 added `CODE_SIGN_IDENTITY=Apple Distribution` to fix pre-objectVersion dev-profile
lookup; on Xcode 26.6 that combination with `CODE_SIGN_STYLE=Automatic` is a hard provisioning
settings conflict (rc=65), not a missing profile.
