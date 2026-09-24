# Watchlist & Order Row Button Tooltip Alignment Fix

**Date:** 2026-07-14
**Branch:** `agent/ag-watchlist-tooltip-fix`
**PR:** https://github.com/jaywedgeworth22/Socratic-Trade/pull/1575

## Summary

Fixed edge cropping of action tooltips in the Watchlist and Order table rows by aligning them to the right.

## Why

1. **Watchlist & Order Tooltip Clipping**: Tooltips on buttons on the far right edge of tables (like the action menus in Watchlist and Orders) default to center alignment. When opened, they extend past the screen's right edge, causing clipping or scroll overflows. Changing them to align to the right keeps them cleanly inside the viewport.

## Files Touched

- `app/console/ui/primitives.tsx` — Added optional `align` prop to `Btn` and `IconButton` components, forwarded to the inner `Tooltip`.
- `app/console/watchlist/page.tsx` — Set `align="right"` on watchlist action tooltips.
- `app/console/orders/page.tsx` — Set `align="right"` on order row action tooltips.
- `STATUS.md` — Added entry.
- `docs/EFFORT-LOG.md` — Added In Progress entry.

## Verification

```bash
npm run lint         → clean (0 errors, 458 warnings)
npx tsc --noEmit     → clean (no errors outside test/ — pre-existing)
npm test             → 362 files / 4038 tests passed
npm run build        → compiled successfully, no errors (32/32 static pages generated)
```

## Follow-ups

- PR #1575 merged to `main` as `07c2da3f`; verify the automatic production deployment.
