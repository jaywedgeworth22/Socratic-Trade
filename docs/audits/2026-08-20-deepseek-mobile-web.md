# Mobile Website Review — Socratic-Trade console at phone widths (320–430px)

Reviewer: DeepSeek review subagent (repo `/Users/jay/apps/trading-deepseek`, clean at `origin/main`, branch `deepseek/lane`).  Date: 2026-08-21.  Read-only; no repo files modified.

## Summary

The merged `phone-touch-viewport` cluster (#b809 / board `bf05f16a`) genuinely landed most of its four promised fixes — the coarse-pointer 44px floor, the 16px input floor, icon-only run-state, and the `useOverlay` scroll-lock/visualViewport/history primitive are all present and wired into every overlay.  But the "44px floor on **every** interactive class" and "account scope keeps readable width" promises are not fully true: one chrome control (the avatar trigger) is hard-capped at 32×32 by an inline style that beats the CSS floor, a family of interactive controls (Segmented toggles, native checkboxes, collapsible-card summaries, theme picker) sit below 44px, and at 320px the arithmetic still squeezes the account scope to near-zero.  The density finding (`acc07df6`) is almost entirely still open — no phone type-scale, ~70px equity chart, a scan card wall with no sort/filter and no virtualization, both desktop+phone trees mounted, two infinite gradient orbs animating under the opaque console.  The web-side half of the entry-path finding (`620ef423`) is confirmed still open: a bare-401 API wall with no 401 special-casing in the console fetch client means an expired session freezes the console on stale data with no route back to /login — worse on a phone, where the only cue is a "delayed" freshness label.  The console is auth-walled, so all console claims below are from static analysis; the only live measurements possible were on the anonymous /login surface (clean, no overflow).

## Strengths

- The 44px coarse-pointer floor covers the important chrome/nav/action classes: `.con-btn, .con-start/stop-btn, .con-bar-ctl, .con-cmdk-trigger, .con-icon-btn, .con-toggle, .con-nav-item, .con-scope-row, .con-cmdk-item, .ac-expand-toggle, .con-tab-item, .con-watch-btn, .con-toast-dismiss` (`app/console/console.css:460-485`).  The scan watch star and toast dismiss were explicitly added.
- 16px input anti-zoom floor at ≤640px includes the command-palette search and a broad `input:not([type=checkbox]):not([type=radio])...` catch-all (`console.css:712-722`).
- `useOverlay` (`app/console/ui/use-overlay.ts`) is a coherent shared primitive: ref-counted body scroll-lock, `visualViewport` CSS vars (`--con-vv-height`, `--con-vv-offset-top`), and `pushState`/`popstate` back-gesture dismissal — wired into Sheet, SymbolDrawer, CommandPalette, TabsSheet, and (scroll-lock only, `history:false`) ConsentGate.  Sheets/drawer/palette all size against the vv vars, so keyboard-open on iOS/Android is handled as well as CSS can.
- `interactiveWidget: "resizes-content"` on the console layout (`app/console/layout.tsx:13`) plus `themeColor` kept in lockstep with `--con-bg` (lines 16-19).
- No `100vh` anywhere in console code — `100dvh`, `vv-height` and `min-h-dvh` throughout.  No `user-scalable=no` in the viewport meta (zoom stays enabled — a11y win; verified live: `width=device-width, initial-scale=1, viewport-fit=cover`).
- Icon-only run-state below `sm` (`console.css:536-543`, `chrome.tsx:346`) — the run-state label no longer crowds the scope at 360–390px.
- Bottom tab bar: measured-offset TabsSheet via ResizeObserver (`nav.tsx:348-369`), `bottom:0` invariant documented, and the Safari chrome-gap fix documented with an explicit "negative bottom is forbidden" note (`2026-08-18-mobile-tabbar-chrome-gap.md`).
- Every console table is wrapped in `overflow-x-auto` (scan, results, orders, positions, watchlist, model-stats, markdown), so tables scroll inside their container rather than overflowing the page.
- Watchlist, Orders and Scan all have real `lg:hidden` phone card variants; focus traps are stack-aware and Escape/Tab correct; `prefers-reduced-motion` collapses animations and settles infinite ones.
- Playwright covers `mobile-chrome` (iPhone 13, 390×844) plus a landmark/skip-link smoke (`playwright.config.ts:59-63`).

## Findings

### 1. **P1** | **Expired session freezes the console on stale data with no route back — worse on mobile** | `middleware.ts:444-445`, `app/console/lib/useConsoleData.tsx` (no 401 branch), `app/console/lib/api.ts` (no 401 branch)
What's wrong: Middleware answers unauthenticated `/api/*` with a bare 401 and page routes with a `/login` redirect that **drops the destination** (no `?next=`).  The console fetch client (`useConsoleData.runFetch`/`fetchDashboard`) has zero 401 special-casing — a grep for `401`/`/login`/`location` in `useConsoleData.tsx` and `api.ts` returns nothing — so an expired Auth.js session leaves the poll looping against 401s forever: the shell keeps the last snapshot, the freshness strip shows "delayed", and Run once reports a generic "The run failed".  On a phone there is no visible cue to re-authenticate and no way back to /login except typing the URL.  This confirms and deepens board finding `620ef423` (P1, still open, web-side): the "polls stale data forever" and "destination dropped" claims are both live in the current tree.
Fix: Special-case HTTP 401 in the console fetch client: stop polling, show an explicit "Session expired — sign in again" surface, and route to `/login` carrying the current path; carry the destination through sign-in (`?next=` or a callback URL) so push deep links land where they were aimed.
Effort: M

### 2. **P2** | **Avatar trigger stays 32×32 on touch — the one chrome control the 44px floor misses** | `app/console/components/chrome.tsx:903` (`style={{ width: 32, height: 32, minWidth: 32, minHeight: 32, maxWidth: 32, maxHeight: 32 }}`), vs `console.css:460-485`
What's wrong: The inline `minWidth: 32/minHeight: 32` overrides the coarse-pointer `.con-bar-ctl { min-width: 44px; min-height: 44px }` rule (inline styles beat class rules regardless of order).  The comment at `chrome.tsx:854` ("Button is a 44px target on phones") is false, and the `phone-touch-viewport` rollout claims `con-bar-ctl` was wired onto "scope/state/**avatar** triggers" — the avatar got the class but the inline style defeats it.  This is exactly the "44px floor actually landed everywhere" check the review was asked to run: it did not land here.
Fix: Delete the inline size style (or set it only below `sm`/for non-coarse pointers); let the `.con-bar-ctl` coarse floor apply.  Re-verify the profile dropdown anchor math (`chrome.tsx:891-913`) after un-capping.
Effort: S

### 3. **P2** | **Interactive controls still below 44px: Segmented, native checkboxes, disclosure summaries, theme picker** | `app/console/ui/primitives.tsx:399-403` (Segmented), `app/console/components/policy-form.tsx:245` (usage), `app/console/guardrails/page.tsx:442-448,495-501` (checkboxes), `primitives.tsx:38` (`summary.focus:outline-none`), `chrome.tsx:931-952` (theme buttons)
What's wrong: The coarse floor's class list is fixed and does not cover: (a) `Segmented` buttons — `px-2 py-1 text-xs` ≈ 26px tall, and they are the money-critical Dollar/Percent cap-mode toggles on Guardrails; (b) native `<input type=checkbox>` rows in Guardrails universe/order-type lists — the 16px floor explicitly excludes checkboxes and the labels have no padding, so the target is the ~20px text line; (c) collapsible `Card` `<summary>` — no floor class, and `focus:outline-none` removes the keyboard focus ring entirely (keyboard users get no focus indicator when tabbing to a collapsible card, on every page using `collapsible`: readiness-checklist, approval-card, proposal-scorecard, guardrails, strategy); (d) the UserMenu theme picker buttons (~28px).  All of these are reachable on phones.
Fix: Add a `.con-segmented > button` (or a `min-height:44px` on the row), a padded checkbox-row class, restore a visible `:focus-visible` ring on `summary` (and give it a 44px touch floor), and let the theme buttons inherit the floor.  Audit once more with a coarse-pointer DevTools pass.
Effort: S–M

### 4. **P2** | **At 320px the account scope still collapses to a sliver; nothing guards horizontal overflow** | `app/console/components/shell.tsx:397` (chrome row), `chrome.tsx:207` (scope `min-w-0 flex-1`), `console.css` (no `overflow-x` anywhere in console.css or globals.css), `app/console/components/policy-form.tsx:244` (`min-w-[18rem]`)
What's wrong: The icon-only run-state fix freed the scope at 360–390px, but the fixed-width controls (state chip ≈ 60–70px, ⌘K trigger 44px, inbox 44px, avatar 32px, icon-only Run once ≈ 44px, STOP ≈ 44px, 6 gaps × 6px, 24px padding) total ≈ 250–280px, leaving the `min-w-0 flex-1` scope selector with ~8–60px at 320px — enough for a truncated sliver or an overflow.  Because neither `globals.css` nor `console.css` sets `overflow-x: hidden/clip` on `body`/`.console-root`/`main`, any over-budget row becomes a page-level horizontal scroll trap (swipe-back gesture fights the page on iOS).  The Guardrails cap-row control cluster `min-w-[18rem]` (288px) exceeds the ~256px content width at 320px and is not wrapped in an overflow container.
Fix: Measure at 320px (DevTools/device) and trim one chrome control below `sm` (e.g. fold the ⌘K trigger into the More/Tabs sheet on phones — it is keyboard-dead anyway on touch); add `overflow-x: clip` on `.console-root` as a guard; audit `min-w-*` clusters for the 320px content width.
Effort: M (needs on-device verification at 320px — arithmetic only here, see Verification)

### 5. **P2** | **No phone type scale: 424 uses of 11px, 188 of 12.5px, 13 of 10px render at desktop size on a 6-inch screen** | `app/console/console.css:89-100` (tokens), verified counts across `app/console/**`
What's wrong: Board finding `acc07df6` (P2, open) is confirmed still open: there is no `@media (max-width:…)` bump for any `--con-fs-*` token.  Counts in the current tree: `con-fs-xs` (11px) 424 uses, `con-fs-sm` (12.5px) 188, `con-fs-2xs` (10px) 13 — including 10px for the Coach composer's live-data footnote (`app/console/assistant/chat.tsx:660`) and chrome mode text (`chrome.tsx:311`), which the token's own comment says should never be "anything the owner must read to act".  The equity chart is the poster child: `viewBox 640×140` with `h-auto w-full` (`app/console/components/equity-chart.tsx:11,68`) renders ~85px tall at 390px and ~70px at 320px — the same sub-100px chart the finding called out.
Fix: Introduce a phone breakpoint type-scale bump (e.g. xs→12px, sm→13.5–14px on ≤640px) and enforce a minimum equity-chart height; replace 10px interactive/reading text with `--con-fs-xs`.
Effort: M

### 6. **P2** | **Mobile Scan cards have no sort or filter and are unvirtualized; both trees still mount** | `app/console/scan/scan-table.tsx:486-549` (desktop tree `hidden lg:block` — still mounted + TableVirtuoso still runs), `scan-table.tsx:550-564` (mobile card wall maps **all** rows), `scan-table.tsx:468` (column picker `hidden ... lg:flex`)
What's wrong: The phone card list is sorted only by the initial state (score desc) — the sort headers and column picker live inside the desktop tree and are unreachable below `lg`, so a user cannot re-sort or filter on a phone.  The mobile wall renders every candidate with no virtualization (a 250-symbol scan = 250 mounted cards), and the desktop virtualized table is still mounted and measuring underneath it (CSS `hidden`, not one-tree-per-breakpoint — the `acc07df6` recommendation was "render one tree per breakpoint instead of mounting both").  Watchlist has the same dual-mount pattern (`watchlist/page.tsx:223,306`) though with a small plain table.
Fix: On phones, render only the card list; virtualize it (or cap to top-N with a "show more"); add a minimal phone sort control (tap the score/price header chips) or accept score-desc and say so.
Effort: M

### 7. **P2** | **Coach composer is single-line on phones — on-screen keyboards cannot produce Shift+Enter** | `app/console/assistant/chat.tsx:606-607` (`if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }`), hint hidden on mobile (`chat.tsx:661` `hidden sm:inline`)
What's wrong: The `acc07df6` sub-claim ("Enter always sends with no way to type a newline") is half-fixed: Shift+Enter does insert a newline, but iOS/Android keyboards have no Shift key — pressing the return key sends.  The explanatory hint is hidden below `sm`.  Mobile users get a hard single-line composer (it auto-resizes up to 9rem but can never gain a newline).
Fix: On coarse pointers (or ≤640px), make Enter insert a newline and rely on the explicit Send button; keep Enter-to-send on desktop.  Un-hide the hint on phones.
Effort: S

### 8. **P3** | **Two infinite gradient orbs keep animating under the opaque console** | `app/globals.css:155-175` (`body::before/::after` with `animation: orb1 24s ... infinite`, `orb2 28s ... infinite reverse`)
What's wrong: `acc07df6`'s frontend-perf sub-claims (dweb-14/16) verified open: the full-viewport `body::before/::after` mesh animations run on every page forever, including /console where `.console-root`'s opaque `--con-bg` background completely hides them — pure GPU/battery cost on phones.
Fix: `content: none` (or `animation: none`) when the console root is present (`.console-root body::before` can't be selected directly — gate via a `body.has-console` class or scope the orbs to non-console pages).
Effort: S

### 9. **P3** | **No landscape handling** | `app/console/console.css` (no `orientation` media queries anywhere)
What's wrong: Nothing compacts the sticky top chrome (RealityBanner + ChromeBar + MobileFreshnessBar ≈ 110px+) or the bottom sheet for landscape phones (~320×480 visible): the sticky chrome can consume a third of the viewport, and `.ac-actions` sits at `bottom: calc(3.5rem + env(safe-area-inset-bottom))` (`console.css:1020-1028`) regardless of orientation.
Fix: Add `@media (orientation: landscape) and (max-height: 500px)` compaction (hide the freshness bar, tighten chrome padding).
Effort: S–M

### 10. **P3** | **Stale "~40px tap target" comment hides a cascade dependency in order row actions** | `app/console/orders/page.tsx:161-200` (`max-lg:min-h-10` on Replace/Cancel)
What's wrong: The buttons use `max-lg:min-h-10` (40px) with a comment claiming a ~40px bump.  They only reach 44px because unlayered `console.css` `.con-btn { min-height:44px }` outranks Tailwind's layered `min-h-10` in the cascade — if console.css is ever layered or Tailwind unlayered, order actions silently drop to 40px (and 40px was already below the 44px standard the cluster promised).
Fix: Change to `min-h-11` (44px) or delete the class and rely on the coarse floor; fix the comment.
Effort: S

### 11. **P3** | **iOS scroll-lock / keyboard edge cases the cluster itself flagged as possibly insufficient** | `app/console/ui/use-overlay.ts:28-51` (body `position: fixed` + vv-offset-top anchoring), `console.css:986-1004` (bottom sheet anchored at `--con-vv-offset-top`)
What's wrong: Not a new defect — a reference: the rollout's own "Next Steps" named `mweb-06` (tab-bar offsets) and `mweb-09` (typed-confirm keyboard) as needing follow-up "if visualViewport alone is insufficient on iOS Safari".  The `position:fixed` body + visualViewport offset pattern is the known iOS Safari fragile spot (URL-bar collapse timing, keyboard-inset races on older iOS).  These were never re-verified on-device.
Fix: On-device iOS Safari pass: open the ControlSheet's typed Wind-down confirm with the keyboard up; verify the sheet and input sit above the keyboard and the scroll position restores exactly on close.
Effort: S (verification) / M (if a fix is needed)

### 12. **P4** | **TabsSheet gap/floor constants are magic numbers that could drift from the real bar height** | `app/console/components/nav.tsx:165-167` (`TABS_SHEET_GAP = 0`, `TABS_SHEET_TOP_GAP = 16`, `TABS_SHEET_BAR_FLOOR = 56`)
What's wrong: Cosmetic risk only — the sheet's `bottom` uses the measured `barOffset` (correct), but the constants are undocumented magic; if the bar's padding strategy changes again (it already changed once — the 22% inset), the floor can go stale.  Also, the sheet's max-height uses `100dvh` as a fallback in one branch of the `min()` (`nav.tsx:240`), which double-counts nothing today but is the exact class of CSS the codebase elsewhere avoids.
Fix: Fold the floor into the measurement or comment the three constants with the geometry they encode.
Effort: S

## Quick wins (top 5)

1. Delete the avatar's inline 32px style so the coarse-pointer floor applies (`chrome.tsx:903`) — the rollout's own promise, one-line fix.
2. Special-case 401 in the console fetch client → stop polling and route to `/login` with the destination carried through (P1 `620ef423` web-side; prevents the silent stale-data freeze).
3. Add `overflow-x: clip` on `.console-root` + a 44px/padded class for Guardrails checkbox rows and `Segmented` buttons (cheap, closes the two biggest 44px-floor gaps).
4. Gate the two gradient orbs off when the console root is present (globals.css) — free battery/GPU on phones.
5. On ≤640px make the Coach composer's Enter insert a newline (Send button stays explicit) and un-hide the hint (`chat.tsx:606-607,661`).

## Verification notes

- `board list --app socratic-trade --status open` — 60 of 242 shown; full JSON pulled for the three referenced findings: `bf05f16a` (P1 phone-touch-viewport, 15 raw findings), `acc07df6` (P2 phone-layout-density, 9 raw findings), `620ef423` (P1 entry paths, 11 raw findings).  No duplicate findings filed (review is read-only).
- Read: `STATUS.md`, `docs/rollouts/2026-08-18-mobile-tabbar-chrome-gap.md`, `docs/rollouts/2026-08-19-phone-touch-viewport.md`, `docs/rollouts/2026-08-20-web-ios-parity-fixes.md`, `docs/EFFORT-LOG.md` head, `playwright.config.ts`.
- Static analysis (full reads): `app/console/console.css` (1467 lines), `chrome.tsx`, `nav.tsx`, `shell.tsx`, `sheet.tsx`, `use-overlay.ts`, `focus-trap.ts`, `primitives.tsx`, `tooltip-trigger.ts`, `symbol-drawer.tsx`, `command-palette.tsx`, `scan-table.tsx`, `equity-chart.tsx`, `assistant/chat.tsx` (composer), `app/layout.tsx`, `app/console/layout.tsx`, `middleware.ts:400-465`, `useConsoleData.tsx:120-175`; partial/greps: `approval-card.tsx`, `watchlist/page.tsx`, `orders/page.tsx`, `guardrails/page.tsx`, `policy-form.tsx`, `readiness-checklist.tsx`, `consent-gate.tsx`, `notification-inbox.tsx`, `toast.tsx`, `alert-center.tsx`, `results/page.tsx`, `globals.css:130-180`.
- Grep counts: `con-fs-xs` (11px) 424, `con-fs-sm` (12.5px) 188, `con-fs-2xs` (10px) 13 across `app/console`.
- Live probes (headless Chrome, `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --headless=new --dump-dom`): `https://socratictrade.com/console` at 390×844 → redirects to the Sign-in page (console is auth-walled, as expected); `/login` at 320/390/430 → no fixed-width overflow (only a 262px logo with `max-width:100%` and sonner toast CSS media queries); live viewport meta confirmed `width=device-width, initial-scale=1, viewport-fit=cover` (no `user-scalable` restriction — zoom stays enabled).
- Screenshots captured (`/tmp/login-320.png`, `/tmp/login-390.png`) but could not be inspected — this model (deepseek-v4-flash) does not accept image input.
- Lighthouse mobile audit: **not completed** — `npx lighthouse ... --preset=mobile` was rejected by this CLI version (choices: perf/experimental/desktop); the re-run without `--preset` was dispatched but the session was interrupted before results.
- **Not completed**: live DOM measurement of the console chrome at 320/390/430px.  `npm ci` finished and a production `next build` (the playwright-sanctioned unauthenticated smoke recipe: `PRIMARY_USER_EMAIL` + no `AUTH_SECRET` + `ENCRYPTION_KEY` + `DATABASE_URL=file:/tmp/st-review.db`) was running when the review was interrupted and its job was lost.  Consequently finding #4 (320px scope collapse) rests on layout arithmetic, not measurement — flagged accordingly; everything else is static-verified against the current tree.
- Board references, current state: `bf05f16a` (P1) — 4-part fix landed; remaining gaps are findings #2, #3, #4, #9.  `acc07df6` (P2) — findings #5, #6, #8; sub-claims fixed since filing: Shift+Enter newline now exists (but mobile-unreachable, finding #7) and watchlist mobile cards exist.  `620ef423` (P1) — still open, finding #1 (web-side half).
