# 2026-07-04 — Backlog exhaustiveness + cross-agent assignment pass (all 4 apps)

## Summary

Owner-directed pass to (a) make the Socratic-Trade improvement/action backlog exhaustive,
(b) build equivalent GitHub-issue-linked backlogs for the other three apps
(Congress.Trade, congress-trading-shared, API-usage-monitor), and (c) assign the work
across the agent fleet: a large slate to CURSOR (Cursor background agents running
DeepSeek v4 Pro), solid slates to CODEX and AG (Antigravity/Gemini), a risk-lane slate to
MONET (Opus), and a small memory/RAG slate to CLAUDE.

Docs/boards only — zero app code changed in this PR.

## Why

The 2026-06-30 improvement audit's meta-theme was "built-but-unwired rigor", and most of
its items (plus the 147-finding expert review and the composite review) lived as prose
inside four umbrella issues rather than individually trackable/assignable rows. The
owner asked for the list to be exhaustive and for per-agent assignments. Per
`/Users/jay/apps/EFFORT-LOG-PROTOCOL.md`, backlog items become GitHub issues ONLY via
`docs/EFFORT-LOG.md` + `scripts/sync-effort-issues.py` (agents never write issues
directly), so the promotion happened on the boards.

## What changed (this repo)

- `docs/EFFORT-LOG.md`:
  - New Planned subsection "2026-07-04 backlog exhaustiveness pass" — 56 promoted rows:
    CURSOR 17, CODEX 6, AG 7, MONET 5, CLAUDE 6, unassigned owner-decision bucket 15.
    (A drafted 6th MONET row — regime-enum adoption in the risk gates — was dropped mid-pass
    because Monet shipped it as PR #449 while this branch was being written.)
    Sources cited per row (improvement-audit sections, expert reviews, console-parity
    open items, PLAN.md, code sweep).
  - Assignment annotations added to the bodies (never the first lines, which are the
    mirror's SHA1 identity keys) of the 10 pre-existing Planned rows (ticker drawer,
    settings tooltips, model dropdowns → CODEX; admin health, FRED → AG; stop-losses →
    MONET; Manager A/B → CLAUDE; per-model hit rates, SSE inbox → CODEX; factor bars →
    CURSOR).
  - Deduped the twice-logged "Wave-1 quick wins from the composite expert review"
    In Progress row (the issues-mirror dry-run had flagged the duplication); the removed
    copy's detail lives in PRs #364/#365/#366/#368 and their rollout notes.
- `STATUS.md`: new snapshot section.
- Live board `/Users/jay/apps/TRADING-EFFORT-LOG.md` updated first (summary form; repo
  mirror carries full row detail).

## Cross-repo half (separate PRs, same pass)

- **Congress.Trade**: merged Codex's docs-only bootstrap PR #137 (announced on
  #agent-sync first), then a `claude/effort-issues-mirror` PR adds the fleet-standard
  `scripts/sync-effort-issues.py` + `.github/workflows/effort-issues-sync.yml`
  (verbatim copies per protocol) and a populated `docs/EFFORT-LOG.md` (14 Planned rows:
  CODEX house-live-search; AG ticker-alias guard + push/SSE repair; CURSOR pin-check
  fixes/workflow hygiene/lint/vitest-config; CLAUDE sentry-ci-reporter; owner-decision
  rows incl. the two AGENTS.md "Open Decisions").
- **congress-trading-shared**: board reconciliation (merged PRs #3/#4/#7 rows →
  Completed, closing stale mirror issues #5/#6) + 10 Planned rows (CURSOR test-coverage
  slate incl. 37 untested schemas, publish.yml decommission, stale-branch deletion,
  CHANGELOG/engines; AG TICKER_ALIASES rename-vs-acquisition split + dependency-audit
  automation; CLAUDE local-clone-main repair; unassigned LICENSE decision).
- **API-usage-monitor**: board reconciliation (stale mirror issues #10/#12/#15 describe
  merged PRs #8/#9/#13 → Completed) + 11 Planned rows (CURSOR ci-tests/eslint/auth
  consolidation/README/branch-pruning; CODEX data retention + alert delivery channels;
  AG litestream + adapter resilience; unassigned OTLP-logs; OWNER OTLP env activation).

## Audit provenance

Four parallel read-only audit agents (Sonnet) — one per repo — cross-checked GitHub
issues, boards, review docs, rollout follow-ups, and code sweeps. Notable corrections
made during consolidation: the shared-package audit's "consumers never left the private
registry" finding was based on stale local checkouts and was discarded (Congress.Trade
PR #139 + Socratic-Trade #439/#444 verified against origin); the genuinely-new finds
include `usage-budget.ts` Phase-2 enforcement being fully built but never called,
Congress.Trade's `shared-package-pin-check.yml` pointing at the pre-rename peer repo
slug, and the shared repo's `publish.yml` still publishing to the retired registry on
any GitHub Release.

## Verification

- Docs-only change; `land.sh` runs the full local quartet (lint / tsc / tests / build)
  before push regardless — results recorded in the PR.
- Issue creation verified post-merge via the Issues API (counts in the PR/board
  changelog); other repos' verification recorded by their PR agents.

## 2026-07-05 addendum — full itemization

The owner reviewed the pass and flagged it as still non-exhaustive ("why aren't all tasks from
the composite review added"). Correct: the 56 rows were a curated promotion. A second pass ran
three enumeration agents over the expert design review (147 findings), the composite review, the
FULL 2026-06-30 audit (all §6 per-domain tables + completeness appendix), the 2026-07-01
learning-loop-expansion (B/P0/P1/P2/D backlog) and rag-knowledge-expansion (R1-R17) docs, and the
June residual reviews, classifying every finding as DONE / IN-FLIGHT / TRACKED / UNTRACKED
(uncertain → UNTRACKED). Result: ~220 additional individually-tracked Planned rows in
`docs/EFFORT-LOG.md` (subsections "2026-07-05 full itemization" and "Deep-sweep additions"),
each with lane tag, size, one-line description, and source ID. Notable: two live bugs
(partial-day ADV in the impact model; `checkRegimeFlip` non-atomic RMW hardcoded to user
'local'), the safety-critical P0 prerequisites of the factor-weight auto-apply lane, and a
Wave-3-coverage correction (the repo mirror previously omitted the Wave-3 In Progress lanes, so
their in-scope items were nearly double-promoted). Basket caveats recorded in the section header
(auto-apply must land with its P0 rows; the RAG eval harness's lint/regression-net prerequisites;
approvals-triage includes portfolio-impact preview; omnibox means search-anywhere).

## Follow-ups

- Agents pick up their lanes (announced on #agent-sync; assignments are reservations,
  re-negotiable there).
- The unassigned owner-decision bucket (15 rows here + LICENSE/premium-routes/login
  decisions in the other repos) needs owner triage.
- PLAN.md intentionally unchanged: this pass re-organizes tracking and assigns owners;
  it does not change scope, timeline, or approach.
