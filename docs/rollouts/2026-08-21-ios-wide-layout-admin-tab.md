# 2026-08-21 - ios-wide-layout-admin-tab

## 1. Context & Objective

Owner asked for an iPad Air 11" / variable-window layout pass, settings gear top-right on
every tab, a larger settings sheet on iPad/Mac, Admin Portal as an admin-only tab on all
devices, deletion of the Assets price-alert composer, a bell top-left for notifications,
and a fix for Admin "Back to Console" loading the website inside the native webview.

This continues the 2026-08-21 adaptive tab bar (`TabBarCapacity` / `SnapshotScaffold`)
rather than replacing it.  The new work is chrome, Admin-as-tab, and the webview fence.

## 2. Changes Made

Regular-width windows (iPad, wide Mac Catalyst) opt into `.tabViewStyle(.sidebarAdaptable)`
so the system can convert the tab bar into a sidebar as the window grows.  Compact width
keeps the phone tab bar.  Card columns still come from `SnapshotScaffold` /
`ContentColumns` (iPad Air 11" portrait 2 columns, landscape 3).  Settings and the
notification inbox use `.presentationSizing(.form)` plus a 560x680pt floor on regular
width so they are not a tiny iPad card.

Every tab (including More and Admin) gets a leading bell and a trailing `gearshape`.
The bell opens the same persisted notification inbox Activity already showed.  The
Assets toolbar price-alert composer, `AlertsSection`, Home "Armed Price Alerts", and
Insights triggered-alert cards are gone.  Snapshot still decodes `alerts` so older
payloads do not break; there is no iOS create/delete entry point.

Admin Portal is `AppTab.admin`, offered only when `currentUser.isAdmin == true`.  On a
fresh iPad (six slots) auto-fill places it in the first extra slot.  On iPhone it lives
in More (and on Home Desk) until pinned.  The tab is a native rail of the eleven website
admin pages plus a fenced WKWebView.  Full navigations and Next.js `pushState` to
`/console` call `onBackToConsole` (Home tab) instead of painting the website.  Injected
CSS hides the web header/rail/"Back to Console" so native chrome is not duplicated.

- `ios/SocraticTrade/MobileControlView.swift` — `AppTab.admin`, admin-gated customizable
  list / auto-fill, sidebar-adaptable TabView, `.appChrome()` on every destination
- `ios/SocraticTrade/AppComponents.swift` — `AppLayout`, `AppChromeModifier`,
  `AdaptiveWideSheet`; SnapshotScaffold uses the same regular-width helper
- `ios/SocraticTrade/AdminPortalView.swift` — native rail + console-return intercept
- `ios/SocraticTrade/HomeView.swift` — gear CTA, settings extracted, price-alert row
  removed, Admin desk shortcut, settings no longer hosts the portal sheet
- `ios/SocraticTrade/MarketsView.swift` — price-alert UI deleted
- `ios/SocraticTrade/ActivityView.swift` — `NotificationsInboxView` for the bell
- `ios/SocraticTrade/InsightsView.swift` — triggered price-alert insight removed
- `ios/SocraticTrade/DeepLink.swift` — comment (Assets no longer hosts alerts)
- `ios/SocraticTradeTests/TabPreferencesTests.swift` — admin auto-fill / gate
- `ios/SocraticTradeTests/RunStateDerivationTests.swift` — console-return + page paths
- `ios/SocraticTradeTests/DeskModelsTests.swift` — Admin tab membership
- `ios/CLAUDE.md` — file map
- `docs/phase-8-cockpit-ui.md` — iOS chrome / Admin tab
- `STATUS.md`, `PLAN.md`, `docs/EFFORT-LOG.md` — this effort

## 3. Decisions & Trade-offs

UI-expert pass (this session inspected the live Swift, `app/console` chrome, and
`app/admin/layout.tsx`; no Task-spawn tool was available in the cloud agent):

1. **iOS chrome** — Settings lived only on Home (`person.crop.circle`).  Assets stole
   trailing for price alerts.  Coach/Scan already occupy trailing.  Recommendation:
   shared toolbar, gear as `confirmationAction` so it stays top-right next to those
   extras; bell leading, reusing `bell` / `bell.badge.fill`.
2. **Website console** — Header inbox + account control on every screen; Admin is an
   `isAdmin` link in chrome, not a buried sheet.  Match that on native.
3. **HIG / Admin** — Porting eleven React admin pages is out of scope.  Hybrid: native
   `NavigationLink` / sidebar list (the website NAV_ITEMS) + existing fenced WKWebView.
   Intercept `/console` both in `decidePolicyFor` and via a `pushState` script because
   Next.js client routing never becomes a full navigation (the actual bug).

Other decisions:

- Did not raise compact tab count when the user is an admin (5+More crowds an iPhone).
  Admin is always in More and auto-fills onto the bar from the fifth slot.
- Did not delete `/api/alerts` or website Watchlist price alerts.  Owner asked to remove
  the iOS Assets entry point.
- Did not add `/admin` to AASA / DeepLink.  The tab is in-app; claiming the path would
  swallow Safari operator links.
- New Swift files were avoided (checked-in pbxproj is explicit file refs; no xcodegen
  here).  Chrome lives in `AppComponents.swift`.

PR: [#3028](https://github.com/jaywedgeworth22/Socratic-Trade/pull/3028).

## 4. Verification State

Commands run in this Linux cloud VM (no `xcodebuild` / `swiftc` / `xcodegen`):

```bash
npm run lint          # exit 0 — 0 errors, 774 grandfathered warnings
npx tsc --noEmit      # exit 0
npm run build         # exit 0 — Next.js 16.3.1 webpack, TypeScript finished, 41 static pages
```

`npm test` (vitest) was started locally and aborted after ~15 minutes: a single
vitest worker plus outbound 404s (Yahoo, SEC `company_tickers.json`, Finnhub,
FRED) produced 30s timeouts in strategy/history tests that this iOS-only PR did
not touch.  CI `verify` on PR #3028 is the JS test of record.

iOS XCTest additions (`TabPreferencesTests`, `RunStateDerivationTests`,
`DeskModelsTests`) are not executed here.  First Swift compile is
`.github/workflows/ios-build.yml` on the Mac runner (`ios-build` on PR #3028).

`ios-build` run 32535072344 (head `cb44aeecef`, later docs-only commits did not
re-run the Mac job): BUILD SUCCEEDED, 237 XCTests, 1 failure.
`TabPreferencesTests.testAdminTabAppearsOnlyAfterTheSessionIsMarkedAdmin`
expected `[home, proposals, markets, activity, admin, insights]` and got
`[..., insights, admin]`.  Cause: `barTabs` filters `AppTab.allCases`, and
`.admin` was declared after `.results`, so canonical order buried it.  Fix:
declare `.admin` immediately after `.activity` so the first extra iPad slot
matches `autoFill`.  The follow-up commit is on this same PR.

Owner later merged `origin/main` onto this branch (`472f3cfe`, pulled in #3032).
CI on that SHA: `verify`/`verify-hosted` run 32540455277 success; `ios-build`
run 32540455303 success.  While those jobs ran, #3031 (`d588387b`) landed on
`main` and GitHub reported CONFLICTING.  `git merge-tree --write-tree` exit 1:
real conflicts in `ios/SocraticTrade/ActivityView.swift` and
`ios/SocraticTrade/MobileControlView.swift`.  Resolution kept #3031's five
Activity sections and this PR's `NotificationsInboxView` (Unread/All bell
sheet).  Assets More copy stays "Holdings, orders, and watchlist." (no price
alerts).  Activity More copy takes #3031's five-section line.

`ios-build` run 32536626553 (head `b747872d00fd92853ddba6b47a41b3eea1a5fd51`): BUILD
SUCCEEDED, TEST SUCCEEDED, 237 XCTests / 0 failures (confirmed from the job log).

After the #3031 rematch, `ios-build` 32541612565 on `8471509c` failed with
`invalid redeclaration of 'NotificationHistoryRow'` in `ActivityView.swift`
(lines 329 and 835).  Owner fix `ac9bafd5` dropped the duplicate.

PR #3028 squash-merged to `main` as `a851a68da16b9c7ec722897a3ab4f378e0117111`
(`a851a68d`) at 2026-08-22 01:14:36Z (`gh pr view 3028`).  PR head `04300371`:
CI run 32541767856 success (`verify` + `verify-hosted` jobs); `ios-build`
32541767843 success.  Push of the squash: `ios-build` 32542852732 success
(unsigned xcodebuild job concluded success; XCTest count not re-read from that
log).  Merge-push CI 32542852729 cancelled.  TestFlight ship workflow 32542852734
failed; not retried.  `ios/**` is outside Coolify `watch_paths`; this is not
Deployed to production.

## 5. Next Steps & Blockers

- Merged to `main`.  Do not reopen the iOS feature.
- TestFlight only if the owner asks (`scripts/ios-ship-testflight.sh`).  Do not
  bounce Coolify.
- Confirm Admin rail SF Symbols render on device/simulator.
- Screenshot iPad Air 11" portrait/landscape and a dragged Mac window (still open from
  the adaptive-tabs follow-ups).
- Website Watchlist still has price alerts; delete there only if the owner wants parity
  the other way.

## 6. Zero-Code Findings

The "Back to Console" bug is SPA `history.pushState` / `<Link href="/console">`, not a
hole in `isAllowed` (that already returned false for `/console` main-frame).  Cancelling
the policy is necessary but not sufficient; the script bridge is the actual fix.
