# Rollout: GitHub issue batch — prompt fencing, headline first-seen, placement 4xx

**Date:** 2026-08-05  
**Author:** GROK  
**Branch:** `grok/issues-batch-prompt-evidence`

## Context & Objective

Open GitHub issues for Socratic-Trade are almost entirely **effort-board mirrors**
(label `effort-board`; read-only). Many titles already say COMPLETED but stay open
until the board reconciler advances state. This session:

1. Unstuck open GROK PRs (#2443–#2445 phantom/real conflicts).
2. Implemented a high-value unfinished batch from planned/unclaimed issues:

| Issue | Work |
|-------|------|
| **#838** | Extend prompt fencing beyond the money path |
| **#837** | Headline first-seen timestamps for evidence-age receipts |
| **#1319** | Approval-path HTTP 4xx → `rejected_by_broker` (parity with autonomous lane) |

## Changes Made

### #838 — Prompt fencing off the money path
- `src/lib/outcome-engine.ts` — post-mortem lesson LLM user payload runs through
  `containPromptDataTree` + injection scan; audit `outcome_postmortem_prompt_safety`.
- `src/lib/post-mortem.ts` — reflection LLM user payload same pattern; audit
  `post_mortem_prompt_safety`.
- Framework-review and strategy-tuning already fenced (no change).

### #837 — Headline first-seen
- Migration **v66** `headline_first_seen` table (`user_id`, `fingerprint`, `symbol`,
  `first_seen`, `last_seen`).
- `src/lib/headline-first-seen.ts` — fingerprint + getOrRecord + prune helper.
- `src/lib/prompt-safety.ts` — `EvidenceAgeInput`/`EvidenceAgeAnomaly` kind includes
  `"headline"`.
- `src/lib/strategy.ts` — for each compacted prompt headline, record first-seen and
  push into `evidenceAgeInputs` so same-day news is receipted.

### #1319 residual — Approval placement classification
- Autonomous lane already short-circuited `OrderValidationError` and `HTTP 4xx`.
- Approval path in `strategy-execution.ts` now matches: validation → `blocked`,
  HTTP 4xx → `rejected_by_broker` (no `order_placement_uncertain`).

### PR unstick (same session, separate branches)
- #2443 Tradier sandbox quotes — phantom conflict, merged main + push.
- #2445 iOS Sign-In/SSE — phantom conflict, merged main + push.
- #2444 auto-pause — real `strategy.ts` conflict resolved with
  `skipped_broker_unhealthy` + auto-pause logic.

## Decisions & Trade-offs
- Headlines get first-seen from **this app’s observation**, not publisher time
  (providers only give bare titles). That matches the issue: close the receipt gap,
  not invent media timestamps.
- Containment remains advisory/quarantine-only (owner philosophy): never blocks
  generation.
- Issue mirrors are **not** closed via `gh issue close` — the effort-board reconciler
  owns that when board rows move to Completed.

## Verification State
```bash
npx tsc --noEmit                    # clean
npx vitest run test/headline-first-seen.test.ts test/prompt-safety.test.ts  # 45/45
```

## Next Steps & Blockers
- Land this branch via `scripts/land.sh`.
- Re-arm auto-merge on open PRs as `verify-hosted` goes green.
- Remaining high-value unclaimed issues (next sessions): #1320 stale-exit
  replacement_pending_cancel, #1321 synthetic-stop dedup, #1317 congress share
  retry storm, #1160 P1 mechanical, #953 admin health pass.
- Board hygiene: many COMPLETED/IN-PROGRESS rows are stale mirrors (board update
  will close them when reconciler runs).

## Zero-Code Findings
- 166 open issues, **all** labeled `effort-board` (0 non-mirror product issues).
- P0 #1159 largely already shipped (rate-limit chat/scan, timingSafeEqual admin,
  RH OAuth encryptValue). Residual: strict decryptValue reject-plaintext +
  tamper-evident audit chain if still desired.
