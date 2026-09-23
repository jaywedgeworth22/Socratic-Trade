# 2026-08-21 - ios-layout-math-tests-rename

## 1. Context & Objective

Owner asked to confirm `docs/rollouts/2026-08-21-ios-adaptive-tabs-followups.md` was
already handled, or to finish it.  Independent re-check: items C, D, and the XCTest
half of A are already on `main` (#3023 squash `7ba178e1`, #3012 `c614391c`, Mac job
32529663287 `success`, 232/0).  Leftover item B (rename `WrappingHStackTests.swift` ->
`LayoutMathTests.swift`) was still open.  This note is that rename, done from Linux
by asking the Mac runner to run `xcodegen generate` instead of hand-editing
`project.pbxproj`.

## 2. Changes Made

Renamed the layout-math XCTest file.  XCTest class names stay so existing
`-only-testing:SocraticTradeTests/WrappingHStackTests` filters keep working.
`ios-build.yml` now runs XcodeGen 2.46.0 (PATH, or the GitHub release zip) before
build/test, then restores `objectVersion` / `preferredProjectObjectVersion` to 100,
and uploads the generated `project.pbxproj` as an artifact so a Linux seat can
commit it without the Cursor pbxproj write hook.

Touched files:

- `ios/SocraticTradeTests/LayoutMathTests.swift` (renamed from `WrappingHStackTests.swift`)
- `ios/project.yml`
- `ios/Socratic Trade.xcodeproj/project.pbxproj` (XcodeGen 2.46.0 on Mac job 32534166394)
- `.github/workflows/ios-build.yml`
- `test/ios-privacy-manifest.test.ts`
- `docs/rollouts/2026-08-21-ios-adaptive-tabs-followups.md`
- `docs/rollouts/2026-08-21-ios-adaptive-tabs-ipad-layout.md`
- `docs/rollouts/2026-08-21-ios-layout-math-tests-rename.md`
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`

## 3. Decisions & Trade-offs

- Did not hand-edit `project.pbxproj`.  The Cursor hook blocks it, and
  `ios/CLAUDE.md` says generate from `project.yml`.
- Kept XCTest class names.  The file name was the lie, not the suite names.
- Generate now runs on every `ios-build` job so a later Linux `git mv` inside
  `SocraticTradeTests/` compiles without a Mac laptop.  The ship script still
  does not generate; the checked-in pbxproj remains what TestFlight uses.
- Did not take item A screenshots (need a human + iPad Air 11" / Mac window).
- Did not change auto-fill (item E) or knobs (item F).  Those are owner calls.
- Did not flip `ios-build` to a required check (board `830c892f`).

## 4. Verification State

Independent re-check of prior work (this session, before the rename):

```
gh run view 32529663287 --json conclusion,status
# conclusion=success, Mac job 21:41:21Z -> 21:43:11Z
# https://github.com/jaywedgeworth22/Socratic-Trade/actions/runs/32529663287
```

Local (this Linux cloud VM):

```
npm run lint                    # exit 0 (warnings only)
npx tsc --noEmit                # exit 0
npx vitest run test/ios-privacy-manifest.test.ts
                                # 1 file / 4 tests passed (after pbxproj commit)
```

Mac `ios-build` on this PR — run 32534166394, concluded `success` in ~3 minutes
(22:44:00Z -> 22:46:46Z):

```
Using xcodegen: /opt/homebrew/bin/xcodegen
Version: 2.46.0
LayoutMathTests.swift in Sources
PrivacyInfo.xcprivacy in Resources
** BUILD SUCCEEDED **
** TEST SUCCEEDED **
```

Job URL: https://github.com/jaywedgeworth22/Socratic-Trade/actions/runs/32534166394

Generated `project.pbxproj` from that job's `generated-pbxproj` artifact is
committed on this branch (objectVersion 100, LayoutMathTests.swift, no
WrappingHStackTests.swift).

## 5. Next Steps & Blockers

- Mac / human: iPad Air 11" portrait + landscape screenshots, borrowed-slot check,
  Mac window-drag fallback (item A visual).  Local Grok brief:
  `docs/rollouts/2026-08-21-ios-adaptive-tabs-mac-qa.md` -- start from
  `origin/main`, not this PR (main merged onto the rename branch).
- Owner: keep or drop tab auto-fill (item E).  Tuning knobs only if the bar feels
  wrong (item F).
- Owner/ruleset: make `ios-build` required (board `830c892f`).

## 6. Zero-Code Findings

Item B could not be a filename-only pbxproj search-replace from this seat: the
Cursor `block-xcode-project-writes` hook rejects Edit/Write on `.pbxproj`.  That
is the correct rule.  The Mac `ios-build` runner is the generate machine.
