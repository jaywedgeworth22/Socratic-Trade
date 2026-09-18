# 2026-09-18 — iOS TestFlight archive fix (objectVersion + distribution signing)

## Context & Objective

Hosted `ios-ship.yml` run 35321123865 failed archive with rc=65: Xcode 26.6 could not read
`ios/Socratic Trade.xcodeproj` (`objectVersion = 77`) and then looked for an iOS App
Development profile instead of using the imported Apple Distribution identity.  PR #3144
(Sentry) regressed the checked-in pbxproj from objectVersion 100 to 77 when xcodegen ran
without the post-patch Congress.Trade already uses.

## Changes Made

- Added `ios/xcodegen-post.py` and `postGenCommand` in `ios/project.yml` (Congress pattern).
- Regenerated `ios/Socratic Trade.xcodeproj/project.pbxproj` at objectVersion 100.
- Release target config: `CODE_SIGN_IDENTITY = Apple Distribution` (Debug stays iPhone Developer).
- `scripts/ios-fleet/ship-testflight.sh`: run `xcodegen-post.py` after xcodegen; pass
  `CODE_SIGN_IDENTITY=Apple Distribution` on `xcodebuild archive`.
- `.github/workflows/ios-build.yml`: call `xcodegen-post.py` instead of inline sed.
- `.github/workflows/ios-ship.yml`: ensure objectVersion 100 before ship when gate passes.
- `ios/CLAUDE.md`: document postGenCommand.

Files touched:

- `ios/xcodegen-post.py` (new)
- `ios/project.yml`
- `ios/Socratic Trade.xcodeproj/project.pbxproj`
- `scripts/ios-fleet/ship-testflight.sh`
- `scripts/ios-fleet.sha256`
- `.github/workflows/ios-build.yml`
- `.github/workflows/ios-ship.yml`
- `ios/CLAUDE.md`
- `docs/rollouts/2026-09-18-ios-testflight-archive-fix.md`

## Decisions & Trade-offs

- Did not mint new ASC profiles or keys; reuse existing Infisical/GH signing path.
- `CODE_SIGN_IDENTITY=Apple Distribution` on archive is belt-and-suspenders with the Release
  pbxproj setting; matches the dist cert `ios-appstore-gm-prepare.sh` imports.
- `force_ship=0`; no extra-ship dispatch.

## Verification State

```bash
cd ios && xcodegen generate && python3 xcodegen-post.py
grep 'objectVersion = 100' "ios/Socratic Trade.xcodeproj/project.pbxproj"
grep 'Apple Distribution' "ios/Socratic Trade.xcodeproj/project.pbxproj"
bash scripts/ios-fleet-pin.sh --check
```

Local gate (no Swift compile on this seat):

- `npm run lint` — not run (ios-only change)
- `npx tsc --noEmit` — not run (ios-only change)

Hosted `ios-build` + `ios-ship` on the PR are the authoritative Swift/archive verify.

## Next Steps & Blockers

- Merge PR after `verify` + `ios-build` green; watch next `ios-ship` archive on main.
- If archive still fails, capture `archive.log` from the ship artifact path on the runner.

## Zero-Code Findings

Failure (1): `objectVersion = 77` in checked-in pbxproj since #3144; Xcode 26 reports
"data couldn't be read because it isn't in the correct format."

Failure (2): Release had `CODE_SIGN_IDENTITY = iPhone Developer`, so automatic signing on
archive searched for App Development profiles CI does not provision; distribution cert was
already imported but unused for the Release configuration.
