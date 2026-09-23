# 2026-07-14: Codex autofix — draftMode sync + unpriced growth lifecycle (PR #1587)

## Summary
Addressed two of three Codex review findings on PR #1587. The third (architecturally significant) was deferred to the maintainer via a PR comment.

## Changes

### P2 — Sync draftMode on account switch (`app/console/components/policy-form.tsx`)
- Added `useEffect` that calls `setDraftMode(policyMode)` when `policyMode` changes.
- Without this, switching accounts left `draftMode` holding the prior account's cap mode ("money"/"pct"). The first keystroke flipped the displayed input back to the stale mode, risking the user editing or saving the wrong cap type.
- Added `useEffect` to the React import.

### P1 — Keep unpriced fill growth pending (`src/lib/strategy-execution.ts`)
- In `reconciledFillStatus`, moved the `merged.unresolvedGrowth` check **before** the `existing?.status === "filled" && merged.truth` early return.
- Previously, a broker snapshot with a larger cumulative filled quantity but no average price was treated as terminal `"filled"` (because `merged.truth` returned the prior truth), dropping out of `listPendingBrokerReconciliationFills` with the extra shares never reconciled.
- Now returns `"partially_filled"` when we have prior truth plus unresolved growth, or `"pending_reconciliation"` when we have no truth at all.

### Deferred — P1 final-size holds vs sell-to-fund ordering
- The broker-minimum final-size review (which can add a `final_size_red_team` human-review hold) runs inside the per-proposal loop, *after* sell-to-fund planning has generated funding sells.
- Two options proposed to the maintainer: move final-size review before sell-to-fund, or cancel/recompute funding sells after the hold is added.
- Comment posted: https://github.com/jaywedgeworth22/Socratic-Trade/pull/1587#issuecomment-4972913768

## Files touched
- `app/console/components/policy-form.tsx` — added `useEffect` import + sync logic
- `src/lib/strategy-execution.ts` — reordered `unresolvedGrowth` check
- `STATUS.md` — updated with current state

## Verification
- `npx tsc --noEmit`: clean
- `npm test`: 4124 tests pass (368 test files)
- `npm run build`: clean
- `npm run lint`: 0 errors (pre-existing warnings only)

## Follow-up
- Wait for maintainer response on the final-size/sell-to-fund ordering question.
- If the maintainer chooses an approach, implement in a follow-up commit.
- Once CI passes on the push, auto-merge will land the PR when `verify` goes green.
