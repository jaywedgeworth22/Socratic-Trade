# 2026-09-18 - console-card-focus-ring

## Summary

- Collapsible console cards (`<Card collapsible>`) no longer opt out of the global keyboard focus ring, and the disclosure header now has an explicit, inset `:focus-visible` outline.
- Closes the last live item on board `bf05f16a` (phone build / a11y finding).

## Why

- The collapsible Card `<summary>` carried Tailwind's `focus:outline-none`.  Board `bf05f16a` (DeepSeek 2026-08-21, re-confirmed by CLAUDE 2026-09-18) flagged that this strips the focus ring, leaving keyboard focus invisible on every collapsible card.
- Verified against the compiled CSS before changing anything: Tailwind v4 emits `.focus\:outline-none:focus` inside `@layer utilities`, while `app/console/console.css` is imported unlayered by `app/console/layout.tsx`, and unlayered author CSS beats a layered rule regardless of specificity.  So `.console-root :focus-visible` was in fact still winning and the ring did show on the current build.  The defect was latent, not live: one CSS reorganisation (wrapping console.css in a layer, or a Tailwind version that changes the emitted rule) would have made focus invisible with nothing in the tests to notice.  This change removes the dead opt-out and states the intent explicitly rather than leaving it to a cascade accident.
- The other two concerns in the same DeepSeek comment (32x32 avatar trigger, sub-44px segmented toggles) were verified as already fixed on `main` by CLAUDE on 2026-09-18 (`.con-bar-ctl` / `.con-segmented-btn` get `min-height/min-width: 44px` under `@media (pointer: coarse)`).  The 320px scope-selector collapse was NOT verified (needs a real viewport) and stays open on the row.

## Files

- `app/console/ui/primitives.tsx` - drop `focus:outline-none` from the collapsible Card `<summary>`.
- `app/console/console.css` - `.con-disclosure > summary:focus-visible` with a 2px accent outline, inset (`outline-offset: -2px`) so the card border does not clip it.
- `test/console-a11y.test.ts` - two source-level guards: the `<summary>` must not strip its outline, and console.css must carry the explicit ring rule.

## Verification

- `npx vitest run test/console-a11y.test.ts` - 6 passed.
- Inspected `.next/static/css/*.css` from an existing build to confirm the layering claim above.
- Full `verify` runs in CI on this PR.

## Follow-ups

- 320px viewport: account scope selector collapse still needs a real-device or Playwright check; left open on `bf05f16a`.
- Board `bf05f16a` also lists overlay scroll-lock / `dvh` / `visualViewport` sizing and iOS input-zoom (font-size below 16px) items from the original review; those were not re-audited in this pass.
