# 2026-08-17 — Effort-board hygiene

## Context & Objective
In Progress on the live Socratic-Trade board still listed work that had already merged. Zero open PRs. GitHub effort issues stayed `state:in-progress` because the committed mirror had not moved those rows.

## Changes Made
- Rebuilt In Progress to leftover real work only.
- Moved verified-merged rows to Completed/Recently completed. First lines preserved (effort-key).
- Renamed Historical archive headings that contained the words "In Progress" so the issue sync would not treat them as live.

## Decisions & Trade-offs
Docs-only. No product code. Rows were moved, not deleted.

## Verification State
- `gh pr list --state open` was empty at inventory time.
- Merged PRs checked via `gh pr view` before moving rows.

## Next Steps & Blockers
Land this mirror so `effort-issues-sync` closes stale issues. Then pick leftover product work from the session control board.

## Zero-Code Findings
Most "IN PROGRESS" first lines were already COMPLETED/MERGED in the same bullet.
