# Scan Table Column Settings, Alignments, and Scroll Layout Improvements

## Context & Objective
Refactored the console Market Scan candidates table (`ScanTable`) and column definitions (`SCAN_COLUMNS`) based on user feedback to simplify column customization, enforce clean data alignments, narrow the score column, improve sentiment fallback, and eliminate horizontal scroll overflow.

## Changes Made
- **Vertical Column Settings Popover**: Changed `columnChooserRows` container in `app/console/scan/scan-table.tsx` to a single vertical column (`flex flex-col gap-1` with `w-full flex items-center justify-between` per row) so each setting (checkbox, label, up/down move arrows) occupies its own full-width row instead of wrapping into a two-column grid.
- **Default Sort**: Verified and preserved default sorting of `score` descending (Score large to small).
- **Score Column Width**: Reduced the width of the `Score` column header and cells (`w-16 px-2` / `w-20 px-2`) to keep it compact and narrow.
- **Column Alignment Rules**:
  - `align` property added to `ScanColumn` in `app/console/scan/columns.tsx`.
  - All column headers (`th`) centered (`!text-center text-center` with flex button `justify-center mx-auto`).
  - Datapoints (`td`):
    - `Symbol` (logo/ticker): Left-aligned (`align: "left"`, `!text-left text-left justify-start`).
    - `Price`: Right-aligned (`align: "right"`, `!text-right text-right justify-end`).
    - All other columns (`Score`, `Chg`, `Vol`, `P/E`, `EPS gr`, `Div`, `Sentiment`, `Rating`, `Congress`, `Sector`, and `Watch` button): Centered (`align: "center"`, `!text-center text-center justify-center`).
- **Sentiment Column Fallback**: Updated `SCAN_COLUMNS` sentiment render (`sortValue` & `render`) and `sentimentTitle` in `src/lib/dashboard-ui.ts` to fall back to `q.insiderSentiment` when `q.sentiment` (news-tone) is not recorded, ensuring insider sentiment chip is displayed instead of `-` when available.
- **Horizontal Scroll Fix**: Replaced `w-full min-w-max` on `table` in `scan-table.tsx` with `min-w-full` to eliminate phantom overflow and prevent horizontal scroll from extending way past the actual table content.

## Touched Files
- [columns.tsx](file:///Users/jay/Code/Socratic-Trade/app/console/scan/columns.tsx)
- [scan-table.tsx](file:///Users/jay/Code/Socratic-Trade/app/console/scan/scan-table.tsx)
- [dashboard-ui.ts](file:///Users/jay/Code/Socratic-Trade/src/lib/dashboard-ui.ts)
- [scan-table-columns.test.ts](file:///Users/jay/Code/Socratic-Trade/test/scan-table-columns.test.ts)
- [STATUS.md](file:///Users/jay/Code/Socratic-Trade/STATUS.md)

## Verification
- `npx vitest run test/scan-table-columns.test.ts` (all 6 tests passing)
- `npx tsc --noEmit`
- `npm run lint`
- `npm test`
- `npm run build`
