# 2026-07-09 — Widen the Model Stats drawer on desktop

Branch: `monet/model-stats-drawer-wide`
PR: https://github.com/jaywedgeworth22/Socratic-Trade/pull/1213

## Summary

Owner-directed console-UI fix. The Model Stats drawer (opened via the
`BarChart2` icon button next to the Proposer/Reviewer model pickers) renders a
4-column table (Model / Cost per call / Latency / Realized performance). On
desktop it was cramped inside the shared `Sheet` component's fixed 560px
dialog width, forcing the table into horizontal scroll. Added an opt-in `wide`
prop on `Sheet` that widens the desktop dialog to `min(920px, calc(100vw -
32px))`, and turned it on only for this one drawer. Mobile bottom-sheet
behavior (full-width, bottom-anchored) is unaffected, and none of the other
~12 `Sheet` call-sites changed.

## Why

`Sheet` (`app/console/ui/sheet.tsx`) had no width/size prop — every caller got
the same 560px-max desktop dialog (`app/console/console.css` `.con-sheet`).
That's the right default for the majority of sheets (forms, confirmations,
single-column detail views), but the Model Stats table needs real horizontal
room for four columns of text (model name, cost+chip, latency+chip, win-rate
+avg-return+sample chip). Rather than widen `.con-sheet` globally (which would
change every other dialog — connect-broker forms, approval sheets, order
cancel/replace sheets, etc.), added a narrowly-scoped `wide` variant.

## Implementation

- `app/console/ui/sheet.tsx` — `Sheet` gained an optional `wide?: boolean`
  prop (documented inline). When true, `con-sheet-wide` is appended to the
  dialog's `className` alongside the existing `con-sheet` / `con-sheet-live`
  classes. Unset (the default) leaves every other call-site byte-for-byte
  unchanged.
- `app/console/console.css` — added `.con-sheet-wide { width: min(920px,
  calc(100vw - 32px)); }` directly after the base `.con-sheet` rule (desktop).
  The existing `@media (max-width: 767px)` block re-declares `.con-sheet {
  width: 100%; ... }` for the mobile bottom sheet; added a matching
  `.con-sheet-wide { width: 100%; }` *inside* that same media block so the
  wide variant doesn't leak a fixed max-width onto mobile. Both rules are
  single-class selectors (equal specificity), so cascade order decides:
  `.con-sheet-wide` is declared after `.con-sheet` in both the desktop block
  and the mobile media block, so it wins in both places — 920px on desktop,
  100% on mobile. Verified by reading the compiled cascade order (no browser
  available in this worktree's sandbox to screenshot).
- `app/console/components/model-stats-drawer.tsx` — `ModelStatsButton` now
  renders `<Sheet ... wide>` (single opt-in call-site). Kept the existing
  `overflow-x-auto` wrapper around the `<table>` as a safety net for narrow
  desktop widths — 920px comfortably fits the 4 columns without triggering it
  in the normal case.
- 920px was chosen (not a narrower 880px or wider 960px) as a round number
  that leaves headroom for the longest realistic row (a model name plus a
  "live · n=NN" chip in the cost/latency columns and a win-rate+avg-return
  string plus a sample-size chip in the performance column) while still
  respecting `calc(100vw - 32px)` on laptop-class viewports (~1280-1440px).

No other `Sheet` call-site (`brokers.tsx` x2, `policy-form.tsx`,
`replace-market-sheet.tsx`, `approval-card.tsx`, `approvals/page.tsx`,
`chrome.tsx` x3, `cancel-sheet.tsx`, `approvals/learned-context.tsx` x2) passes
`wide`, so all keep the default 560px desktop dialog.

## Files

- `app/console/ui/sheet.tsx`
- `app/console/console.css`
- `app/console/components/model-stats-drawer.tsx`
- `STATUS.md` — snapshot entry
- `docs/EFFORT-LOG.md` + `/Users/jay/apps/TRADING-EFFORT-LOG.md` — Completed
  effort-log row

## Verification

Run from `/Users/jay/apps/trading-monet-sheet-wide` (fresh worktree off
`origin/main`, `npm ci`'d):

```bash
npx tsc --noEmit   # clean, no errors
npm run lint       # 0 errors (368 pre-existing grandfathered warnings, none new)
npm test           # 306 files / 3168 tests passed
npm run build      # succeeded, all routes compiled incl. /console/strategy, /console/settings
```

Grepped `test/` for any assertion on the `con-sheet` class list or the `Sheet`
component's className output — none found, so no test updates were needed.

Did not have interactive browser access to this specific worktree from this
sandboxed session (the `preview_start` tool is scoped to the launching agent's
own directory), so visual confirmation relied on: (1) reading the CSS cascade
order by hand (documented above) rather than a screenshot, and (2) the
existing `overflow-x-auto` safety net on the table, which was already present
before this change and is unaffected by it.

## Follow-ups

None identified. If a future drawer needs a different width, follow the same
pattern (a differently-named boolean/enum prop plus a scoped CSS class) rather
than widening `.con-sheet` globally or adding a numeric width prop that every
caller would need to reason about.
