# 2026-08-21 - ios-adaptive-tabs-mac-qa (GROK, local Mac)

> **2026-09-22 [MM] archaeology note:** historical references to the simulator boot target `trade.socratic.app` (the four `xcrun simctl` commands) are kept verbatim as the bundle ID that was live at QA time.  Renamed on 2026-09-22 to `com.socratictrade.ios` (PR forthcoming); the same `xcrun simctl terminate booted com.socratictrade.ios` / `xcrun simctl launch booted com.socratictrade.ios` shape applies — only the bundle ID string changes.  See `docs/rollouts/2026-09-22-bundle-id-migration.md`.

Paste this whole file to a **local Grok** seat on the Mac.  Cursor local is down.
Cursor Cloud is Linux and cannot take these shots.  You are the Mac eyes.

Two spaces between sentences in every file, commit, Slack post, and Apple Note.

## PASTE THIS TO GROK (first message)

You are local Grok on Jay's Mac for Socratic-Trade.  Cursor local is not working.
Do not wait on Cursor.  Do not work in ~/Code/Socratic-Trade or any main
integration worktree.

Job: adaptive-tabs leftover **item A visual QA only**.  Take screenshots.  Do
not change product code unless a shot proves overflow or sparse chrome, and
even then ask Jay first.

Read, in this order, then do the commands in this file:

1. AGENTS.md (fleet rules; skip the Mac-worktree table if you already know it)
2. STATUS.md (top Current Status only)
3. docs/rollouts/2026-08-21-ios-adaptive-tabs-followups.md
4. This file (the rest)

The tab bar is already on origin/main (#2987 squash 9298c29).  Screenshots do
**not** need PR #3027.  Start from origin/main on a **new** worktree
~/apps/trading-grok-tabs.  ~/apps/trading-grok and ~/apps/trading-grok-drain
may already be on the RTH-drain effort -- do not clobber them.

Launch DEBUG with -ASCScreenshots so you get MobileStore.preview, not LoginView.
A login screenshot is useless.  Light theme.  Save under /tmp/st-adaptive-tabs/.

Do not redo B/C/D.  Do not change auto-fill (E) or knobs (F).  Do not hand-edit
project.pbxproj.  Do not mint keys.  Do not TestFlight / HOTFIX / bounce Coolify.
Do not rebase or force-push anyone else's branch.

Claim on Slack #agent-sync (C0BEZDJDNKV) before you start.  Git email must be
12656028+jaywedgeworth22@users.noreply.github.com.

## 0. Why you, not Cursor

- Cursor local: owner says it is not working.
- Cursor Cloud / this writer: Linux, no Simulator, no Mac Catalyst window.
- Remote Control: needs a private worker this repo does not have (failed
  agent bc-c04cab0c).
- CI Mac runner: proved XCTest (232/0) and BUILD SUCCEEDED.  It cannot see
  the tab bar.  BUILD SUCCEEDED is not visual QA.

## 1. Seat / tree

```bash
# NEVER edit in ~/Code/Socratic-Trade or any main integration worktree.
# Prefer a fresh worktree.  trading-grok / trading-grok-drain may be dirty
# on the RTH-drain effort (board 99ab01c7).
git -C ~/apps/trading-grok status 2>/dev/null || true
git -C ~/apps/trading-grok-drain status 2>/dev/null || true

# From any clean linked worktree or the integration repo (read-only fetch):
git fetch origin
git worktree add ~/apps/trading-grok-tabs origin/main
cd ~/apps/trading-grok-tabs
git checkout -B grok/ios-adaptive-tabs-mac-qa
git status               # must be clean besides your new branch
git config user.email    # must be 12656028+jaywedgeworth22@users.noreply.github.com
# if not:
# git config user.email "12656028+jaywedgeworth22@users.noreply.github.com"

bash scripts/slack-sync.sh post "repo: Socratic-Trade | [GROK] taking adaptive-tabs item A screenshots (iPad Air 11 + Mac window) from origin/main.  New worktree ~/apps/trading-grok-tabs.  Not touching E/F.  Not clobbering trading-grok-drain."
```

If `git worktree add` refuses because the path exists, use
`~/apps/trading-grok-tabs-2` or inspect the existing dir first.  Do not
`reset --hard` another seat.

## 2. PR #3027 is optional (main already merged)

https://github.com/jaywedgeworth22/Socratic-Trade/pull/3027
Branch `cursor/ios-layout-math-tests-rename-3110`.  HEAD as of 2026-08-21
23:05Z: `bf172407`.  Auto-merge is armed (`--squash --auto`) but
`mergeStateStatus` was **DIRTY**; resolved 2026-08-21 by merging
`origin/main` `b2ca4c14` (commit `a37a7b2e`).  Both EFFORT-LOG rows and both
`.gitleaksignore` fingerprints were kept.  Re-check before you babysit.

The six greens you may see (gitleaks, xcodebuild, pin, auto-merge helpers)
are **not** the merge gate.  The required check is **`verify`**.  CI run
`32534748893` was still `in_progress` at 23:06Z on that HEAD.

Screenshots do not wait on this PR.  Take the shots from origin/main first.

If you babysit after shots (optional):

```bash
gh pr view 3027 --json state,mergeable,mergeStateStatus,autoMergeRequest,statusCheckRollup
# Find the CI run whose headSha equals the PR head.  Do not watch a stale SHA.
gh run list --branch cursor/ios-layout-math-tests-rename-3110 --workflow=CI --limit 5
```

Main is already merged on this branch.  If it goes DIRTY again, merge
`origin/main` (no rebase, no force-push) and keep every other agent's
EFFORT-LOG row.  Do not `--admin`.  Do not land from the main integration
worktree.

## 3. What is already done (do not redo)

| Item | State | Proof |
|---|---|---|
| Tab bar + iPad layout | on `main` | #2987 squash `9298c29` |
| C hang + XCTest lane | on `main` | #3023 `7ba178e1`, Mac 32529663287, 232/0 |
| A tests | on `main` | same job; 30 `TabPreferencesTests` |
| D PrivacyInfo in bundle | on `main` | #3012 `c614391c` + vitest |
| B rename to `LayoutMathTests.swift` | #3027, conflicting | Mac 32534166394; class names unchanged |

Canonical leftovers: `docs/rollouts/2026-08-21-ios-adaptive-tabs-followups.md`.
Design: `docs/rollouts/2026-08-21-ios-adaptive-tabs-ipad-layout.md`.

## 4. Screenshots (the actual job)

`BUILD SUCCEEDED` is not visual QA.  A screenshot of the **login** screen is
useless.  DEBUG already has a preview store:

- launch arg `-ASCScreenshots`
- or env `ASC_SCREENSHOTS=1`
- or UserDefaults `ascScreenshots`
- see `SocraticTradeApp.isScreenshotMode` -> `MobileStore.preview`
  (`ios/SocraticTrade/PreviewSupport.swift`)

That is how you see Home + the tab bar without signing in.  Do not mint
keys.  Do not put credentials in the transcript.

Expected Home in preview: authenticated Jay, Primary Brokerage, AAPL/NVDA
positions, a pending MSFT proposal.  Light theme (product default).

```bash
xcrun simctl ui booted appearance light   # after the sim is booted
```

### 4a. Build and install on iPad Air 11"

Discover the exact simulator name first (do not invent one):

```bash
xcrun simctl list devices available | grep -i 'iPad Air'
# Expected-ish: iPad Air 11-inch (M3).  Use whatever 11-inch Air is actually there.
```

```bash
IPAD='iPad Air 11-inch (M3)'   # replace with the name from the list
cd ~/apps/trading-grok-tabs    # this worktree

xcodebuild build \
  -project 'ios/Socratic Trade.xcodeproj' \
  -scheme SocraticTrade \
  -destination "platform=iOS Simulator,name=$IPAD" \
  -derivedDataPath /tmp/st-tabs-dd \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO

xcrun simctl boot "$IPAD" || true
xcrun simctl bootstatus "$IPAD" -b
APP=$(find /tmp/st-tabs-dd -name 'Socratic Trade.app' -path '*Debug-iphonesimulator*' | head -1)
echo "APP=$APP"
test -n "$APP"
xcrun simctl install booted "$APP"
xcrun simctl terminate booted trade.socratic.app || true
xcrun simctl launch booted trade.socratic.app -ASCScreenshots
# if the UI is still LoginView, the arg did not land; try:
# xcrun simctl terminate booted trade.socratic.app
# xcrun simctl launch --setenv ASC_SCREENSHOTS=1 booted trade.socratic.app
sleep 3
xcrun simctl ui booted appearance light
```

Portrait (~820 pt): expect **6 tabs + More** and **2 card columns**.

```bash
mkdir -p /tmp/st-adaptive-tabs
xcrun simctl io booted screenshot /tmp/st-adaptive-tabs/ipad-11-portrait-home.png
```

Rotate, then landscape (~1180 pt): expect **8 tabs + More** and **3 columns**.

```bash
# Simulator app: Device > Rotate.  simctl has no reliable orientation verb
# on every Xcode.  Then:
xcrun simctl io booted screenshot /tmp/st-adaptive-tabs/ipad-11-landscape-home.png
```

If the bar still shows four tabs, you are not in screenshot mode or you
booted an iPhone destination.  Stop and fix that before taking more shots.

### 4b. Borrowed slot

Still in `-ASCScreenshots` on the iPad (either orientation is fine; landscape
shows more of the bar):

1. Open **More**.
2. Open **Coach** (or any unpinned screen).
3. Confirm it occupies the slot **immediately before More** (displaces Activity
   by default).
4. Confirm More's badge still covers Activity's unread count.

```bash
xcrun simctl io booted screenshot /tmp/st-adaptive-tabs/ipad-borrowed-slot-coach.png
```

Pin that screen and confirm the slot is given back (Coach stays, Activity
returns to More or the bar per the model).  Screenshot that too
(`/tmp/st-adaptive-tabs/ipad-pinned-coach.png`).

### 4c. Mac Catalyst window drag

```bash
cd ~/apps/trading-grok-tabs

xcodebuild build \
  -project 'ios/Socratic Trade.xcodeproj' \
  -scheme SocraticTrade \
  -destination 'platform=macOS,variant=Mac Catalyst' \
  -derivedDataPath /tmp/st-tabs-mac-dd \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO

MACAPP=$(find /tmp/st-tabs-mac-dd -name 'Socratic Trade.app' | head -1)
echo "MACAPP=$MACAPP"
test -n "$MACAPP"
# Kill a leftover instance so the launch arg is not ignored.
pkill -f 'Socratic Trade' || true
open "$MACAPP" --args -ASCScreenshots
# if that still shows login:
# open --env ASC_SCREENSHOTS=1 "$MACAPP"
```

Drag the window from wide to narrow:

- Too narrow for the chosen set: bar shows the **DEFAULT** four
  (Home, Proposals, Assets, Activity), and must **not** write the stored picks.
- Widen: the owner's / auto-fill set comes back.

```bash
# After you have the window where you want it:
screencapture -w /tmp/st-adaptive-tabs/mac-wide.png
screencapture -w /tmp/st-adaptive-tabs/mac-narrow-defaults.png
```

### 4d. What "done" looks like

Four shots minimum, all light theme, none of them LoginView:

1. iPad Air 11" portrait Home -- 6 + More, 2 columns
2. iPad Air 11" landscape Home -- 8 + More, 3 columns
3. Borrowed slot (Coach before More)
4. Mac narrow fallback to defaults (plus the wide shot if you have it)

Write the paths into this rollout note and into
`docs/rollouts/2026-08-21-ios-adaptive-tabs-followups.md` item A.  Open a
**new** PR from `grok/ios-adaptive-tabs-mac-qa` with the shots attached
(GitHub comment or committed under `docs/rollouts/screenshots/` if you must
keep them in-repo -- prefer the comment + /tmp paths Jay can open).  Do not
push shots onto #3027.

Fleet rule: do not claim visual QA from `BUILD SUCCEEDED`.

## 5. Do not do these

- Do not work in `~/Code/Socratic-Trade`.
- Do not reuse or reset `~/apps/trading-grok-drain`.
- Do not hand-edit `project.pbxproj` / entitlements / xibs.  `project.yml`
  then `xcodegen generate`, then restore `objectVersion = 100` if it emitted
  77.
- Do not delete `hasCustomSelection` / auto-fill (item E) unless the owner
  vetoes after seeing the landscape "8 tabs" shot.
- Do not retune `TabBarCapacity` / `ContentColumns` knobs (item F) unless a
  shot shows overflow or sparse empty chrome -- then ask, do not patch first.
- Do not make `ios-build` a required check (board `830c892f`) -- ruleset / owner.
- Do not ship TestFlight, HOTFIX, or bounce Coolify.  `ios/**` is outside
  `watch_paths`.
- Do not mint provider keys.
- Do not start Cursor Remote Control / private workers.
- Do not rebase or force-push `cursor/ios-layout-math-tests-rename-3110`.

## 6. Close-out

Update in the same change on **your** branch:

1. `STATUS.md` -- screenshots taken, what they showed, any veto for E/F.
2. `docs/EFFORT-LOG.md` -- move the leftovers / Grok screenshot row; do not
   delete other rows.  The live board at `/Users/jay/apps/TRADING-EFFORT-LOG.md`
   gets the same one-line status if you can write it.
3. This file + `docs/rollouts/2026-08-21-ios-adaptive-tabs-followups.md` item A.
4. `PLAN.md` one-liner.
5. Slack: `repo: Socratic-Trade | [GROK] item A shots at /tmp/st-adaptive-tabs; E/F left for owner.`
6. Apple Note title `[ST, Grok] adaptive tabs visual QA` (folder Coding).

Gate if you touch code (you should not need to):

```bash
npm run lint
npx tsc --noEmit
npm test
npm run build
```

If you only add docs + attach shots, still run `npx tsc --noEmit` and the
privacy vitest (`npx vitest run test/ios-privacy-manifest.test.ts`).  Swift
proof is the Mac `xcodebuild` / Simulator, not the JS gate.

Open the shots PR ready for review (not draft).  Do not `gh pr merge --admin`.
