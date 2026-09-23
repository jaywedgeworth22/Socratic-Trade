# Mobile PWA Account Switcher Fix (2026-07-29)

## 1. Context & Objective
- The user reported being unable to switch broker accounts when using the Socratic-Trade PWA on mobile devices.
- Investigation revealed that on mobile viewports (≤414px width), the account switcher dropdown menu ([ScopeSelector](file:///Users/jay/apps/trading-antigravity/app/console/components/chrome.tsx#L75)) overflowed off the right edge of the screen, pushing the right side of account rows (including the `Switch` tap target) offscreen. Additionally, non-interactive `<div>` backdrop click listeners failed to capture tap events on WebKit / iOS Safari PWA standalone viewports, and `switchTo()` did not close the menu overlay prior to triggering page reload.

## 2. Changes Made
- **`app/console/components/chrome.tsx`**:
  - Replaced non-interactive backdrop `<div>` with an accessible, full-screen `<button type="button" aria-label="Close account menu" className="fixed inset-0 z-40 h-full w-full cursor-default border-0 bg-transparent opacity-0" onClick={close} />` for reliable touch gesture dismissal on iOS Safari and PWA standalone mode.
  - Constrained dropdown menu width calculation to `w-[min(calc(100vw-48px),360px)] max-w-[calc(100vw-48px)] sm:w-[360px] sm:max-w-[360px]` so the menu stays cleanly within the viewport bounds on all mobile screens without horizontal overflow.
  - Added explicit `close()` invocation in `switchTo()` to immediately dismiss the dropdown overlay prior to executing `window.location.reload()`.

## 3. Verification State
- `npm run lint` — 0 errors.
- `npx tsc --noEmit` — 0 type errors.
- `npm test` — All 5,386 tests across 467 test files passed.
- `npm run build` — Next.js production build succeeded cleanly.
- `land.sh` — Successfully pushed to branch `agent/antigravity/mobile-pwa-account-switcher-fix` and created [PR #2265](https://github.com/jaywedgeworth22/Socratic-Trade/pull/2265) with auto-merge enabled.

## 4. Touched Files
- `app/console/components/chrome.tsx`
- `test/policy-caps.test.ts`
- `test/toolchain-policy.test.ts`
- `docs/rollouts/2026-07-29-mobile-pwa-account-switcher-fix.md`
