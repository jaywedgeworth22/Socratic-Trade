# 2026-08-12 — Console false load-failure, phone-correct load graphic, iOS candlestick splash, Lato everywhere

## 1. Context & Objective

Owner report, four parts in one message: (a) the website shows "SOCRATIC TRADE / Couldn't load the
autonomy desk / The dashboard is taking too long to respond. Retrying…" on **every** load now, while
the iOS app on the same account went "Stale" for a few minutes and then flipped to green "Updated" —
"why does it update and website have issue?"; (b) make the website's loading graphic work at iOS
screen sizes; (c) put "SOCRATIC TRADE" in candlesticks at the top of the iOS app while it loads, then
slide it away (owner attached a screenshot of the existing icon + spinner + "Socratic-Trade" splash);
(d) make the iOS font Lato everywhere, and offer Lato on the website too — "maybe could be default
and one of the options in settings".

Owner decisions taken in-conversation before implementing: download the official OFL Lato files for
both platforms, and make Lato the **site-wide** default plus a named picker option.

## 2. Changes Made

### (a) The false "Couldn't load the autonomy desk" — root cause and fix

**This was a real client-side bug, not a server problem.** `/api/dashboard` and the iOS app's
`/api/mobile/snapshot` call the *same* `getDashboardSnapshot`, so there was never a server-side
split between the two clients. The difference was entirely in how each client handles a slow load:

| | web console | native iOS |
|---|---|---|
| gives up and shows an error at | **15s** (`FIRST_LOAD_WATCHDOG_MS`) | never — no such timer |
| aborts the request at | 35s (`FETCH_DEADLINE_MS`) | 30s (`URLRequest.timeoutInterval`) |
| server's own acknowledged worst case | **~24s** (sequential broker chain) | same |

The 15s watchdog set `error`, and the shell rendered its full-screen failure card the moment `error`
was non-null and no snapshot had arrived — so any first load landing in the routine **15–24s band**
showed a failure screen *while the request was still in flight and about to succeed*. iOS, with no
equivalent timer, simply waited and rendered the snapshot — exactly the "stale for a few minutes,
then Updated" the owner saw. The watchdog's original job ("don't sit on the logo forever if the fetch
hangs") had already been taken over by `FETCH_DEADLINE_MS`, which aborts and retries a genuinely hung
attempt, so the watchdog no longer needed to manufacture an error to be safe.

- `app/console/lib/console-load-state.ts` — **new.** Pure `deriveConsoleLoadState()`. The rule:
  *an error while a fetch is still in flight is not a failure.* Returns `loading` / `slow` / `failed`
  / `ready`. Extracted as a pure module specifically so it is testable — see §4.
- `app/console/lib/useConsoleData.tsx` — the 15s timer is now a **slow notice**, not an error
  (`FIRST_LOAD_SLOW_NOTICE_MS`); added `fetching` state (tracks whether `runLoop` is actively
  attempting, including its own deadline retries) and `slowFirstLoad`; the context value now derives
  `loading`/`slowFirstLoad` through `deriveConsoleLoadState`. `ConsoleData` gains `retrying` and
  `slowFirstLoad`.
- `app/console/components/shell.tsx` — the load screen stays up through a slow load and adds one
  muted line ("Still loading — your broker is answering slowly.  Hang tight.") instead of being
  replaced by the error card. The error card is now only reached when nothing is in flight.

### (b) Loading graphic at phone viewports — `app/console/components/intro-canvas.tsx`

- **Measure the overlay, not `window.inner*`.** `wrap` is `position:fixed;inset:0`, so its rect *is*
  the box the canvas fills; `window.innerHeight` is the **visual** viewport, which on iOS Safari
  excludes the collapsed URL bar and disagreed by 60–90px. The chart's `midY`/`amp` were built from
  the taller number while the canvas was the shorter one, pushing the candles down and clipping the
  low wicks off the bottom of every iPhone. Desktop never showed it because there the two agree.
- **DPR 3 on phones.** The cap was 2; every iPhone since the X is 3, and the candles are thin
  round-capped strokes — the one shape that shows softness. The cap exists to bound desktop fill
  rate, so it is now `3` only when the viewport is phone-sized.
- **iOS URL-bar resize absorption.** Safari fires `resize` on the tiniest scroll as the URL bar
  collapses; recomputing the model mid-flight made the candles jump. Height-only deltas ≤120px are
  ignored while the animation runs (a real rotation moves the *width* too and still applies). Also
  listens on `visualViewport`, which fires in cases the window event misses.
- **Safe-area-aware landing box.** The page is `viewport-fit=cover`, so in a home-screen install the
  top bar sits below the notch. The first-ever-visit fallback (`?? 10`) assembled the wordmark up
  under the notch and then visibly dropped it; it now reads `env(safe-area-inset-top)` via a
  throwaway probe (`SAFE_TOP`) and offsets by it.

### (c) iOS candlestick launch screen — `ios/SocraticTrade/SocraticTradeApp.swift`

- `LaunchStateView` replaced: the teal rounded-square icon + `ProgressView` + "Socratic-Trade" label
  (the owner's screenshot) is now the **candlestick "SOCRATIC TRADE" wordmark at the top of the
  screen**, ticking, on the app background — then the whole overlay **slides up and away**
  (`.move(edge: .top).combined(with: .opacity)`, 0.55s), uncovering the app. Reduced motion gets a
  cross-fade instead of travel.
- Sized by the **same formula as the web `MobileBrandRow`** (88% of width, clamped 16–34pt via
  `WORDMARK_AR` 13.081), so the native splash and the web load screen are the same mark at the same
  size.
- `minimumSplashElapsed` (1.2s) floor: a warm launch returns in ~200ms and would otherwise show the
  wordmark for a single frame, reading as a flicker. The splash leaves when **both** the floor and
  the load are done, so a slow launch is never held back.
- **Launch-screen flash fixed.** `UILaunchScreen: {}` paints **white** while the app background is
  `systemGroupedBackground` (#F2F2F7), so every cold launch flashed white. New
  `Assets.xcassets/LaunchBackground.colorset` pins #F2F2F7 — *deliberately the same value in both
  appearances*, because the launch screen renders before SwiftUI can apply the app's forced `.light`
  scheme, so a dark variant would flash dark instead.

### (d) `CandleWordmarkView` was rendering the wordmark upside down — pre-existing bug, fixed

Caught on the first simulator run: the shipped native wordmark (visible on the login screen today)
renders **vertically mirrored** — S reads as `2`, R as `K`, A as `Y`, T as `⊥`. `alphaAt` applied
`row = H - 1 - yy` "because the buffer is still physical bottom-up". It isn't: row 0 of a
`CGBitmapContext` buffer is the **top**, and the `translate`/`scale` above already put user space in
top-origin coordinates — so the conversion was a second flip. Every candle column got its letter's
rows reversed. The web original (`candle-ticker.ts`) samples a top-origin canvas with no flip and was
correct the whole time. Fixed to `row = yy`. It survived review because a mirrored wordmark is still
roughly wordmark-shaped at a glance.

### (e) Lato — web and iOS

Self-hosted, **not** `next/font/google`: merging to `main` auto-deploys, and `next/font/google`
fetches at *build* time, so an unreachable `fonts.gstatic.com` would fail the container build and
freeze production over a typeface. The committed woff2s are the exact files Google serves.

- `app/fonts/` — **new.** 8 woff2 (400/400-italic/700/900 × latin + latin-ext), `LATO-OFL.txt`, and
  `lato.ts` (`next/font/local`, `display: swap`, `variable: --font-lato`, `adjustFontFallback: "Arial"`
  so the pre-swap fallback doesn't reflow).
- `app/layout.tsx` — `lato.variable` on `<html>` (the console mounts deep inside `<body>`, so the var
  has to be at the root).
- `app/globals.css` — `--font-sans` now resolves `var(--font-lato)`. **Note:** this slot previously
  named `"Inter"`, which was never actually loaded anywhere in the app — no `@font-face`, no
  `next/font`, nothing in `public/` — so the site had silently been rendering in the device's system
  UI font. Lato is the first real webfont this stack has ever resolved.
- `app/console/console.css` — new `--con-font-lato`; `--con-font-ui` resolves to it;
  `[data-console-font="lato"]` / `[data-textbox-font="lato"]` rules added.
- `app/console/lib/useConsoleFont.ts`, `useConsoleTextBoxFont.ts` — added an explicit **"Lato"**
  option alongside "Site". `"site"` keeps its storage key (so saved prefs still resolve) and now means
  "follow the default, which is Lato today"; `"lato"` pins the face regardless of what the default
  becomes. Validators switched from hardcoded unions to `OPTIONS.some(...)` so they can't drift again.
- `ios/SocraticTrade/Fonts/` — **new.** Lato Regular/Italic/Bold/Black TTFs + `LATO-OFL.txt`.
- `ios/SocraticTrade/AppTypography.swift` — **new.** `AppFont` (PostScript names, verified against the
  shipped TTFs) + `.app*` twins of every semantic text style, built with
  `Font.custom(_:size:relativeTo:)` so **Dynamic Type still scales** (a plain `.custom(_:size:)` would
  have frozen text at one size and broken accessibility for the sake of a typeface). `AppAppearance
  .applyFonts()` covers nav bars / tab items / segmented controls, which UIKit draws and which never
  see SwiftUI's `.font`.
- All 120 `.font(.style)` call sites across 11 Swift files mechanically swapped to the `.app*` twins;
  root `.environment(\.font, .appBody)` covers unstyled `Text`. Two deliberate exclusions, both
  commented in place: SF Symbol sizing stays `.system` (symbols *are* glyphs in the system font), and
  `ActivityView`'s column-aligned figures stay on the system mono face (Lato ships no monospaced
  face, so `.monospaced()` on it would silently go proportional and break the alignment).
- `ios/SocraticTrade/Info.plist` + `ios/project.yml` — `UIAppFonts` with **bare filenames**. XcodeGen
  emits `Fonts/` as a PBXGroup, not a folder reference, so the Resources phase copies each .ttf to the
  **bundle root**; a `Fonts/` prefix resolves to nothing and fails *silently* (no error anywhere, every
  style just falls back to SF Pro). Verified against the built bundle.

### Files touched

```
app/console/lib/console-load-state.ts            (new)
app/console/lib/useConsoleData.tsx
app/console/components/shell.tsx
app/console/components/intro-canvas.tsx
app/console/lib/useConsoleFont.ts
app/console/lib/useConsoleTextBoxFont.ts
app/console/console.css
app/globals.css
app/layout.tsx
app/fonts/lato.ts                                (new)
app/fonts/*.woff2, app/fonts/LATO-OFL.txt        (new, 88KB)
test/console-load-state.test.ts                  (new)
ios/SocraticTrade/SocraticTradeApp.swift
ios/SocraticTrade/AppTypography.swift            (new)
ios/SocraticTrade/CandleWordmarkView.swift
ios/SocraticTrade/AppComponents.swift
ios/SocraticTrade/ActivityView.swift
ios/SocraticTrade/{Home,Markets,Login,Proposals,Insights,MobileControl,SymbolInfoSheet,AdminPortal}View.swift
ios/SocraticTrade/Info.plist
ios/SocraticTrade/Fonts/*.ttf, LATO-OFL.txt      (new, 2.6MB)
ios/SocraticTrade/Assets.xcassets/LaunchBackground.colorset/Contents.json  (new)
ios/SocraticTradeTests/AppTypographyTests.swift  (new)
ios/project.yml
ios/Socratic Trade.xcodeproj/project.pbxproj     (xcodegen regen; objectVersion re-pinned to 100)
```

## 3. Decisions & Trade-offs

- **The slow notice keeps the 15s timing but changes its meaning.** 15s is still the right moment to
  reassure; it is simply no longer the moment to declare failure. Raising the threshold instead would
  have left a silent 24s stare on genuinely slow loads.
- **`error` still gets set by the 35s deadline path.** That is what flips the freshness strip to
  "delayed" once a snapshot exists, and removing it would regress that. The fix is that the *shell*
  no longer treats a set `error` as failure while an attempt is running.
- **Server-side slowness itself is untouched and remains open.** `getDashboardSnapshot`'s broker chain
  is sequential (accounts 6s → portfolio/positions/orders 8s → quotes 6s, then benchmark 4s) and can
  legitimately take ~24s. This change makes the client honest about that; it does not make it faster.
  Parallelising that chain is a real follow-up (§5).
- **Self-hosted Lato over `next/font/google`** — build-time network dependency vs. ~88KB (web) and
  2.6MB (iOS bundle) of committed binaries. Given auto-deploy-on-merge, a build that can fail on an
  external host was the worse trade.
- **`"site"` kept as a storage key** rather than renamed to `"lato"` — no migration, no lost prefs,
  and the two now mean genuinely different things (follow-the-default vs. pin-this-face).
- **The wordmark sampler still rasterises Arial Bold, not Lato,** on both platforms. `WORDMARK_AR`
  (13.081) is a measured constant shared by the web canvas, the web header logo, and the iOS view;
  changing the sampled face would silently invalidate it and desync all three. The candlestick mark is
  a logo, not body text — out of scope for the typeface swap.
- **The 1.2s splash floor is a deliberate delay** on warm launches. Without it the brand moment the
  owner asked for is a single-frame flicker.

## 4. Verification State

Web (in `~/apps/trading-monet`, Node 24 on PATH):

```bash
npx tsc --noEmit        # clean
npm run lint            # 0 errors (762 warnings — the grandfathered backlog, unchanged)
npm test                # 555 files passed | 1 skipped; 6449 tests passed | 51 skipped
npm run build           # exit 0; 8 Lato woff2 emitted to .next/static/media/
```

iOS:

```bash
xcodegen generate                                  # + objectVersion re-pinned to 100 per AGENTS.md
xcodebuild build   -scheme SocraticTrade …         # succeeded
xcodebuild test    -scheme SocraticTrade …         # ** TEST SUCCEEDED ** — 40 tests, 0 failures
```

Live verification, not just green gates:

- **iOS simulator (iPhone 17 Pro).** Launched and screenshotted the real launch sequence: the
  candlestick wordmark renders at the top and slides away; Lato is visibly applied across the login
  screen and chrome. The mirrored-wordmark bug was **found this way** — the first screenshot read
  "2OCKY.IIC ⊥KVDE"; the post-fix screenshot reads "SOCRATIC TRADE".
- **Built bundle inspected** — `Lato-*.ttf` present at the bundle root and `UIAppFonts` matching
  exactly (this is what caught the `Fonts/` prefix mistake before it shipped).
- **Browser at 375×812 (mobile preset).** `/console` load screen: candles fill the viewport with wicks
  intact and assemble the wordmark at the top of the mobile brand row. Runtime check confirmed
  `--font-lato` resolving, `body` and `.console-root` both computing to Lato, 9 Lato faces in
  `document.fonts`, and the new "Lato" option present on the settings font picker.
- `test/console-load-state.test.ts` — 7 tests, including an explicit regression case for the shipped
  bug (`error` set + `fetching: true` must never be `failed`).

The repo's vitest setup is node-only (no jsdom / testing-library), which is *why* the broken rule
lived inside a React hook uncovered for as long as it did. Extracting it to a pure module was the
minimum change that makes it testable without adding a DOM test stack.

## 5. Next Steps & Blockers

- **Follow-up (real, not cosmetic): parallelise `getDashboardSnapshot`'s broker chain.** ~24s worst
  case is the actual reason the console ever hit the watchdog. `gateway.getAccounts` → portfolio /
  positions / orders → `getEquityQuotes` are sequential; the last two do not depend on each other.
  Filed as a follow-up, deliberately out of scope here.
- **iOS ships on the next TestFlight build** (`bash scripts/ios-ship-testflight.sh`) — the splash,
  Lato, and the wordmark fix are all native-side and are not delivered by the web auto-deploy.
- **App bundle grows ~2.6MB** from the four TTFs. If that ever matters, subsetting to latin-only or
  dropping Black would recover most of it.
- No blockers.

## 6. Zero-Code Findings

- The "Couldn't load the autonomy desk" thread in `docs/rollouts/2026-07-19-ag-to-claude-handoff.md`
  concluded the message came from **Coolify's own dashboard UI**, not the app. That was wrong — the
  string is `app/console/components/shell.tsx:140`, in our console. Anyone re-reading that note should
  treat this one as the correction.
- Production was healthy throughout (`/api/health` 200, `ok: true`, scheduler ticking 7s prior,
  litestream fine). There was never a server-side outage behind the owner's report.
