# 2026-07-13: Login UI updates and Apple Sign-in, Model Stats Drawer

## Summary
- Replaced the text in the login page with Socratic-Trade Candlestick logo.
- Adjusted the UI to only show the logo and the sign-in buttons.
- Implemented a Drawer UX for the Model Stats.
- Grouped Model Stats by provider with vertically aligned row labels on mobile devices.
- Removed parenthetical model names for Anthropic, Google, and xAI.

## Files
- `app/login/page.tsx`
- `app/ui/llm-model-catalog.ts`
- `app/api/mobile/auth/apple/route.ts`
- `ios/SocraticTrade/LoginView.swift`
- `ios/SocraticTrade/MobileStore.swift`
- `ios/SocraticTrade/MobileAPIClient.swift`
- `app/console/components/model-stats-drawer.tsx`
- `app/console/ui/usage-monitor.tsx`

## Verification
- Local build, lint, typecheck and test passed.
- Pushed and PR opened.
## 2026-07-13: UI Overlap Fixes
- Addressed overlapping text in the "Broker Connections" section by allowing the buttons to wrap with `flex-wrap` and making the title shrink/wrap properly.
- Wrapped the "Currently Loaded Account" and "Other Accounts" elements in `flex-col` so they do not overlap their labels.
- Reduced the height of the `HeaderLogo` on the login page slightly and enabled it to shrink proportionally using `max-width` and `object-fit: contain`.

