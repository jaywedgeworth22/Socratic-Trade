# Remove Redundant Paper Account Reality Chips

## Context & Objective
Removed redundant purple paper account reality chips (`PAPER · broker practice account`) from the console dashboard Strategy bar (`app/console/page.tsx`) and Strategy page header (`app/console/strategy/page.tsx`) per user feedback, avoiding visual clutter since the paper account status is already displayed in the top reality banner and account selector name.

## Changes Made
- **Console Dashboard (`app/console/page.tsx`)**: Removed `<Chip tone={reality.tone}>{reality.word} · {reality.phrase}</Chip>` from `<section className="con-strategy-bar">`.
- **Strategy Page (`app/console/strategy/page.tsx`)**: Removed `<Chip tone={reality.tone}>{reality.word} · {reality.phrase}</Chip>` from page header.

## Touched Files
- [page.tsx](file:///Users/jay/Code/Socratic-Trade/app/console/page.tsx)
- [page.tsx](file:///Users/jay/Code/Socratic-Trade/app/console/strategy/page.tsx)
- [STATUS.md](file:///Users/jay/Code/Socratic-Trade/STATUS.md)

## Verification
- `npx tsc --noEmit`
- `npm run lint`
- `npm test`
- `npm run build`
