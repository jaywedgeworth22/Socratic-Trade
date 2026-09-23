# 2026-07-29 Add Apache 2.0 License

## Context & Objective
The owner decided to open source Socratic-Trade. Added the Apache 2.0 License to the repository and removed the `"private": true` restriction from `package.json`.

## Changes Made
- Created `LICENSE` file containing the standard Apache 2.0 text.
- Modified `package.json` to replace `"private": true` with `"license": "Apache-2.0"`.

## Decisions & Trade-offs
Added standard 2026 Jay Wedgeworth copyright notice to the Apache license appendix.

## Verification State
- `npm run lint` passes
- `npx tsc --noEmit` passes
- `npm test` passes
- `npm run build` passes

## Next Steps & Blockers
Repo can now be toggled to public via the GitHub Settings UI.
