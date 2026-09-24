# 2026-08-21 - ios-ci-unhang

## 1. Context & Objective

Nobody had claimed the six adaptive-tabs follow-ups in
`docs/rollouts/2026-08-21-ios-adaptive-tabs-followups.md`.  A Cursor Remote Control
attempt (`bc-c04cab0c`, "Ios adaptive tabs follow-ups") died at setup with "No
self-hosted workers were available for this repo" -- `usePrivateWorker: true` and
`privateWorkerId: null`.  This hosted Linux session can do the CI slice (item C)
and close item D on paper.  Items A screenshots, B rename, E auto-fill, and F knobs
still need a Mac or an owner decision.

## 2. Changes Made

Redirect `xcodebuild` stdout/stderr onto a file so `SWBBuildService` cannot inherit
the GitHub Actions step pipe and hold a finished build open until `timeout-minutes`
cancels it.  Add an `xcodebuild test` step on the same Mac job so the 45 Tab/layout
XCTests (and the rest of `SocraticTradeTests`) actually execute.  Lock item D with a
vitest: `PrivacyInfo.xcprivacy` is already in the checked-in pbxproj Copy Bundle
Resources as of #3012.

Touched files:

- `.github/workflows/ios-build.yml`
- `test/ios-privacy-manifest.test.ts`
- `docs/rollouts/2026-08-21-ios-adaptive-tabs-followups.md`
- `docs/rollouts/2026-08-21-ios-ci-unhang.md`
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`

## 3. Decisions & Trade-offs

- Did not make `ios-build` a required check.  Warm runs on `main` later today already
  conclude `success` in ~40s, but the 04:16-06:56 UTC cluster on #2794/#2987 was
  `cancelled`.  Flip the `main-protection` ruleset (board `830c892f`) only after this
  PR's job itself concludes `success`.
- Did not add a new file under `scripts/`.  `scripts/**` is in Coolify `watch_paths`;
  a helper there would bounce production.  The wrapper stays inline in the workflow.
- Test destination is discovered (`iPhone 17 Pro`, then `iPhone 16 Pro`, then any
  available iPhone) so a missing named device cannot skip the lane.
- Did not rename `WrappingHStackTests.swift` (item B).  That needs `xcodegen generate`
  on a Mac; this tree does not hand-edit `project.pbxproj`.
- Did not take screenshots (item A visual half).  Linux has no simulator.
- Did not change auto-fill (item E).  That is the owner's call.
- Timeout went 30 -> 40 minutes to cover a cold build plus tests.  Raising the timeout
  is not the hang fix; the file redirect is.

## 4. Verification State

Local (this Linux cloud VM):

```
npm run lint                    # exit 0 (warnings only)
npx tsc --noEmit                # exit 0
npx vitest run test/ios-privacy-manifest.test.ts
                                # 1 file / 3 tests passed
```

Full local `npm test` was started and showed unrelated network flakes (Yahoo/Finnhub 404s, 30s gather timeouts) before finishing.  GitHub `verify` on this PR is the JS suite of record.

Mac runner (the proof for item C and item A's XCTest half) -- run 32529663287, concluded `success` in ~2 minutes (21:41:21Z -> 21:43:10Z), not `cancelled`:

```
Using simulator: iPhone 17 Pro
** BUILD SUCCEEDED **
Test Suite 'TabPreferencesTests' passed ... Executed 30 tests, with 0 failures
** TEST SUCCEEDED **
Executed 232 tests, with 0 failures (0 unexpected)
```

Job URL: https://github.com/jaywedgeworth22/Socratic-Trade/actions/runs/32529663287

## 5. Next Steps & Blockers

- Owner can now make `ios-build` a required check (board `830c892f`).  This PR's job concluded `success`.
- Mac seat: rename `WrappingHStackTests.swift` -> `LayoutMathTests.swift`, run
  `xcodegen generate`, restore `objectVersion = 100`.
- Mac seat: iPad Air 11" portrait + landscape screenshots, borrowed-slot check, Mac
  window-drag fallback.  CI cannot see the bar.
- Owner: keep or drop tab auto-fill (item E).

## 6. Zero-Code Findings

**Why Remote Control would not start.**  Cursor Remote Control is a *Cursor* private
worker (`usePrivateWorker`), not the GitHub Actions runner `mac-xcode26-socratic`.
The failed agent `https://cursor.com/agents/bc-c04cab0c-e939-437a-9802-7082dbe78d77`
and the archived sibling `bc-9c25fd74` ("Adaptive wide screen layout") both have
`usePrivateWorker: true` and `privateWorkerId: null`.  This repo has no registered
Cursor self-hosted worker.  A hosted cloud agent (this run, no private worker) is
what actually boots.  Leave Remote Control off unless a Cursor private worker is
installed and online for this repo.  The GitHub Mac runner does not count.

**Item D was already closed.**  #3012 (`c614391c`) added `PrivacyInfo.xcprivacy in
Resources` to the checked-in pbxproj.  `scripts/ios-ship-testflight.sh` still does
not run `xcodegen`; it no longer has to for this file.
