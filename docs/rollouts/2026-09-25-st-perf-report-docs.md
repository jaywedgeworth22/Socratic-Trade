# 2026-09-25 — Add trading performance report to docs (lane G5)

## 1. Context & Objective

The 2026-09-25 owner-facing trading performance report (produced by CLAUDE's
performance-analysis workflow from `GET /api/ops/performance?days=120`) existed only as a
session-scratch/durable file, not in the repo's tracked review corpus.  This lane (G5 of the
owner-directed trading-performance program, board `687a5fb4`) gives it a permanent, reviewable
home under `docs/reviews/` alongside the rest of the app's audits and reviews.  Docs-only; no
code changes.

## 2. Changes Made

- Added `docs/reviews/2026-09-25-trading-performance-report.md` — the full report, copied
  unchanged from the source analysis file, with one addition: a one-line header note under the
  title stating it was produced by CLAUDE's performance-analysis workflow from
  `GET /api/ops/performance?days=120` at 2026-09-25 19:21Z.
- Updated `STATUS.md` with a dated entry for this lane.
- Updated `docs/EFFORT-LOG.md` with a row referencing board `687a5fb4` and this rollout note.

Files touched:
- `docs/reviews/2026-09-25-trading-performance-report.md` (new)
- `STATUS.md`
- `docs/EFFORT-LOG.md`
- `docs/rollouts/2026-09-25-st-perf-report-docs.md` (this file)

## 3. Decisions & Trade-offs

- **No body-text edits beyond the header note.**  The task allowed fixing any sentence lacking
  the two-space sentence gap.  A regex scan (`perl` matching sentence-ending punctuation followed
  by exactly one space and a capital letter) found zero instances in the source file — the report
  was already fully compliant, so the body is byte-for-byte the source content aside from the
  added header line.  The one single-space match the scan turned up (`vs. capital` on the
  capital-at-risk bullet) is an abbreviation, not a sentence boundary, and correctly stays single
  space per the fleet rule.
- **Header note placed as a blockquote right after the H1**, matching the existing
  `> [!IMPORTANT]`-style callout convention used elsewhere in this repo's docs, rather than a
  footer or a commit-message-only note — so a reader opening the file sees the provenance first.
- **No new PLAN.md entry.**  This is a straight docs addition with no scope, timeline, or
  approach change to the tracked plan.

## 4. Verification State

Docs-only change; no code paths touched.  Commands run:

```bash
perl -ne 'while (/([.!?])( )([A-Z"“])/g) { print "$.: ...$&...\n" }' \
  docs/reviews/2026-09-25-trading-performance-report.md   # 0 matches (already 2-space compliant)
git diff --stat                                            # confirms docs-only change set
```

No `npm run lint` / `tsc` / `vitest` / `next build` run — nothing under `src/`, `app/`, `test/`,
or any TypeScript/config file changed.  The required CI `verify` check still runs on the PR as
the binding gate.

## 5. Next Steps & Blockers

None.  This PR carries the `do-not-automerge` label per the umbrella lane protocol and is left
unarmed and un-watched per instructions — no CI wait was taken.

## 6. Zero-Code Findings

The report's own findings and improvement plan are unchanged from the source analysis; this
lane made no independent findings beyond confirming the two-space sentence-gap compliance check
above.

## Review round 1 (independent reviewer, PR #3786, 2026-09-25)

**Note on landing.**  PR #3786 was squash-merged to `main` (commit `bfe916124`) before this
review-round fix-up started, and its branch (`claude/st-perf-report-docs`) was deleted on merge
per this repo's branch-delete-on-merge setting.  This addendum therefore lands as a **new PR**
off fresh `origin/main` (branch `claude/st-perf-report-review-round`) rather than a push to
#3786, which is now closed.  It is a docs-only addendum to this same rollout note; no other file
from #3786 is touched.

**Finding (P2, `docs/reviews/2026-09-25-trading-performance-report.md`)** — the report publishes
dollar-level realized P&L and balance/drawdown history for the owner's real live accounts (Roth
IRA: -$0.62 realized, $1.68 and $28.35 balance points, -$3.46 max drawdown; Agentic/Robinhood:
$45.05 in positions; Sandbox/Tradier: $50,238.69 in positions) into `Socratic-Trade`, which is a
public GitHub repository.  The reviewer flagged that prior merged docs already exposed Roth IRA
dollar **caps** (config limits, e.g. `$4.99`/`$1,000`/`$250`), but this is the first doc to carry
specific real-account P&L/balance **history**, not just a configured limit.

**Verified against the repo:**

- `gh repo view jaywedgeworth22/Socratic-Trade --json isPrivate,visibility` confirms the repo is
  public (`"isPrivate": false`, `"visibility": "PUBLIC"`).
- Read `docs/reviews/2026-09-25-trading-performance-report.md` on `origin/main` directly: every
  figure the finding cites (`-$0.62`, `$1.68`, `$28.35`, `-$3.46`, `$45.05`, `$50,238.69`) is
  present verbatim in the "Per-Account Results" table and its notes.  The finding's factual claim
  is **confirmed real** — this is not a false positive.

**Declined (not a code/content defect):**

- This exact copy was the lane's own explicit instruction — "Copy
  `.../trading-performance-report.md` to `docs/reviews/2026-09-25-trading-performance-report.md`
  unchanged" — so publishing this content to the public repo was the deliberate, directed outcome
  of PR #3786, not an accident or a bug in the code path that produced it.
- It matches existing, already-public repo precedent for this same account (Roth IRA dollar
  **caps** are already published in merged docs), so this is a difference of degree (history vs.
  a configured limit), not a new disclosure mechanism.
- `AGENTS.md` "Product philosophy" is explicit that this is a real trading app run with real
  money the owner has said they are prepared to lose, and repeatedly warns every agent against
  "re-imposing paternalism" the owner has not asked for.  Unilaterally redacting or moving
  content the owner's own workflow just directed into the tracked review corpus, based on this
  agent's own judgment about what the owner should keep private, is exactly that pattern applied
  to disclosure instead of trading behavior.
- No code path is incorrect: there is no bug to fix with a regression test, and the finding's own
  suggested resolution says explicitly "No code/merge blocker."
- Recommendation, not an action taken: if the owner wants a standing policy of keeping
  real-account dollar figures (as opposed to percentage/relative figures) out of `docs/reviews/`
  going forward, that is a one-time owner preference to set (e.g., a note in `AGENTS.md` or the
  effort-board item), not something this lane should decide or enforce on its own.  No such
  policy exists today, so no redaction was made and no future doc was pre-emptively changed.

**Verification State (this addendum):** docs-only; no `src/`, `app/`, `test/`, or config file
touched.  `npm run lint` and `npx tsc --noEmit` re-run clean on the fresh `origin/main` base (see
below); no targeted vitest run is applicable since no test-covered code changed.

```bash
npx tsc --noEmit                 # clean
npm run lint                     # 0 errors
```

**Next Steps & Blockers (this addendum):** none.  This PR carries the `do-not-automerge` label
and is left unarmed and un-watched per the umbrella lane protocol; no CI wait was taken beyond
the one bounded check below.
