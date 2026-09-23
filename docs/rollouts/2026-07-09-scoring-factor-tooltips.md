# 2026-07-09 — Scoring-factor weight tooltips

PR: https://github.com/jaywedgeworth22/Socratic-Trade/pull/1205 (`monet/scoring-factor-tooltips`)

## Summary

Owner-directed display-only change (no scoring-logic changes). Added a hover
tooltip to each of the eight "Scoring-factor weights" controls on the Strategy
console page, explaining what the factor measures and how raising its weight
shifts candidate ranking. Also appended one sentence to the card's intro
paragraph clarifying that the weights are relative (ratios matter, not
absolute numbers).

## Why

The eight scoring-factor fields (`liquidity`, `momentum`, `value`, `quality`,
`volatility`, `sentiment`, `positioning`, `diversification`) previously
rendered with the raw lowercase `ScoringWeights` key as the label and only a
numeric "default X" hint underneath — no explanation of what each factor
measures or which direction "more weight" pushes candidate ranking. Owner
asked for a mouseover explanation on each control; explicitly a display-only
change, not a scoring-math change.

## Files

- `app/console/strategy/page.tsx`:
  - New `FACTOR_META: Record<keyof ScoringWeights, { name: string; tip: string }>`
    constant (next to `WEIGHT_KEYS`) with a capitalized display name + one
    explanatory sentence per factor.
  - Imported `Tooltip` from `../ui/primitives` (already used elsewhere in the
    console — no new tooltip infra).
  - Each `Field`'s `label` prop now renders the capitalized factor name plus a
    small "ⓘ" affordance, both wrapped in `<Tooltip content={meta.tip}>` (plus
    a visually-hidden `sr-only` span carrying the same text for screen
    readers, since hover-only tooltips don't reach them). The existing
    numeric `hint="default X"` line is unchanged and still renders under the
    input.
  - The intro `<p>` for the "Scoring-factor weights" card gained one sentence:
    "Weights are relative — raising one factor increases its share of the
    score and lowers the others'; only the ratios between factors matter, not
    the absolute numbers."
- `STATUS.md` — new snapshot entry.
- `docs/EFFORT-LOG.md` + `/Users/jay/apps/TRADING-EFFORT-LOG.md` — Completed
  effort-log row.

No scoring/ranking logic (`src/lib/scoring.ts` or wherever `ScoringWeights`
is consumed) was touched — this PR only changes what's rendered in the
console.

## Verification

Run from `/Users/jay/apps/trading-monet-score-tips` (fresh worktree off
`origin/main`, `npm ci`'d):

```bash
npx tsc --noEmit   # clean, no errors
npm run lint       # 0 errors (367 pre-existing warnings, none in touched file)
npm test           # 306 files / 3168 tests passed
npm run build      # succeeded, /console/strategy compiled
```

Checked `test/` for any assertion on the raw lowercase factor-key labels
(`liquidity`, `momentum`, etc. as rendered `<label>` text) — none found; the
handful of hits in `test/` are unrelated string literals inside scoring/RAG
logic tests, not DOM assertions against `app/console/strategy/page.tsx`.

## Concurrency note

Task brief flagged PR #1202 (Proposer/Reviewer/Strategist rename) as possibly
landing mid-work and also touching `app/console/strategy/page.tsx`. In
practice #1202 (`e1df5ed2`) was already merged to `main` before this worktree
was created (`git worktree add ... origin/main` picked it up as the branch
base), so there was no live overlap to resolve — the scoring card region
(~389-433 pre-#1202, ~427-471 post) was untouched by #1202's edits (model
pickers, summary line, `AiReviewPanel`), confirming the brief's file-region
analysis was correct.

## Follow-ups

None identified. The "if WEIGHT_KEYS has a key not in this list" fallback
in the code path is defensive only — `ScoringWeights` (`src/lib/types.ts`)
has exactly the 8 keys covered by `FACTOR_META`, so the fallback is dead
code today; left in place in case the type gains a 9th factor later.
