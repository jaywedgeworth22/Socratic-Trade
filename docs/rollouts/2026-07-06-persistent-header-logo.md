# 2026-07-06 — Persistent candlestick header logo (splash → top-bar brand handoff)

## Summary

Replaced the typed **"Socratic-Trade"** brand text in the console top bar with a
live **candlestick "SOCRATIC TRADE"** logo that ticks forever, and made the
first-load intro splash shrink into and hand off to that exact element.

- **New:** `app/console/ui/candle-ticker.ts` — shared wordmark sampler + the
  12-unit green-biased ticker + `drawTicker()`. Both the intro and the header
  logo import it, so they render the identical wordmark and can never drift.
- **New:** `app/console/ui/header-logo.tsx` — `<HeaderLogo>`, a small Canvas
  brand mark (~18px tall, ~248px wide) that ticks one column left per second,
  forever. Draws only candles (no background), so it sits on the header surface
  in both themes. `prefers-reduced-motion` → static frame. Marked
  `role="img" aria-label="Socratic Trade"` and tagged `data-brand-logo`.
- **Changed:** `app/console/components/shell.tsx` — the top-bar `<span>Socratic-Trade</span>`
  is now `<HeaderLogo/>` (same `hidden … lg:block` gating as the old text).
- **Changed:** `app/console/components/intro-canvas.tsx`:
  - **Background → transparent** (owner choice) instead of the hard-coded
    `#0b1018`, so the console/theme shows through the splash.
  - **Seamless handoff:** the final candles land on the REAL logo box. The intro
    measures `[data-brand-logo]`'s viewport rect each frame (until found) and uses
    it as the header target, so the shrink ends exactly on the persistent logo.
    Fallback (until the bar mounts) is a small computed top-left box.
  - **Shrunk** the final header (fallback `logoH` clamp `24–42` → `16–22`) to match
    the ~18px persistent logo.
  - **Fade at once:** `END = T4 + 0.2` (was `+1.6`) — the persistent logo owns the
    forever-tick, so the overlay hands off immediately instead of holding and
    double-drawing the wordmark.

## Behavior / decisions

- **One wordmark, two renderers:** `candle-ticker.ts` is the single source of the
  letter layout + ticker, so the splash's final frame and the persistent logo are
  the same mark. Handoff is a fade between them at the same on-screen box.
- **Theme:** the logo draws only saturated red/green candles on a transparent
  canvas; the bar surface (`--con-surface`) supplies light/dark, so the mark reads
  on both without theme-specific code.
- **Sizing:** measured logo box ≈ 248×18 px, i.e. between the old typed brand
  (~105px wide) and the previous large intro header — per owner's "shrink to
  between their current size and the typed-text width."
- **Transparent-background tradeoff (flagged to owner):** with a transparent
  splash the loaded console — and the first-visit consent modal — are visible
  behind the flying candles. A "match theme background" (`var(--con-bg)`) variant
  is a one-line switch if a cleaner splash is preferred.

## Verification

```
npx tsc --noEmit   # clean
npm run lint       # 0 errors
npm run build      # exit 0
```

Driven live (`npm run dev` + Playwright on `/console`, fresh session, 1280×800):
- Settled top bar shows the single clean candlestick "SOCRATIC TRADE" logo
  (measured 248×18 at x=16,y=52) beside the account selector and run controls.
- Handoff sequence (land → fade → settled) confirmed; the shortened `END` removes
  the earlier long double-draw.
- Logo renders on both dark and forced-light bars (candles theme-independent).

## Follow-ups

- If the owner prefers a cleaner splash, switch the overlay background from
  `transparent` to `var(--con-bg)` (theme-aware fill).
- Tunable: `HeaderLogo` `height` prop (currently 18) trades legibility vs width.
- The mobile top bar still hides the brand (`hidden … lg:block`, matching the old
  text); a compact mobile treatment could be added if wanted.
