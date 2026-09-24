# 2026-09-24 — LLM stats console review-findings sweep (PR #3452)

## 1. Context & Objective

PR #3452 (`minimax/llm-stats-and-held-20260923`) adds the admin LLM stats console: alias-aggregated
per-model-family usage/cost/latency with all-time + last-90d windows, per the owner rule 2026-09-23
(every LLM call kept forever; opus generations collapse into one bucket).  The PR was red
(`verify` + `verify-hosted` failed), had a merge conflict, and carried open Sentry/Codex review
threads.  This round (fleet PR-merge sweep round 3, MUSE lane) resolves the conflict, fixes the CI
breakage, and addresses every review thread in code.

## 2. Changes Made

- **Merge conflict** in `src/lib/llm-model-catalog.ts` (PR added `claude-opus-5.5` /
  `anthropic/claude-opus-5.5` aliases; main added `lineage`/`predecessors`): resolved by keeping
  both — aliases plus the MM pricing comment on the PR side, `lineage: "anthropic-opus"` and
  `predecessors` on the main side.
- **OpenAILLM latency/status wiring** (`src/lib/chat/llm.ts`): `OpenAILLM.run()` now captures
  `startedAt`/`chatStatus` and passes `latencyMs` + `status` to `recordChatUsage` on the success
  path, the abort/deadline break paths (`canceled`/`timeout`), and the transport-failure path
  (records the failed row, then rethrows) — parity with `AnthropicLLM.run()`.  This closes the
  Sentry HIGH + Codex P1 finding that Jay's INSTINCT re-open marked fixed for Anthropic only.
- **New test** `test/chat-llm-openai-usage-status.test.ts`: success / error-rethrow / timeout /
  pre-step-canceled coverage for `OpenAILLM`, mirroring the Anthropic test.
- **Side-by-side windows** (`app/admin/llm-stats/llm-stats-client.tsx`): removed the
  all-time-vs-90d toggle; the page now renders both windows simultaneously in two columns
  (`xl:grid-cols-2`), each with its own stat cards and alias table — what the owner rule and the
  module header comments always required.  Timeouts/source-models columns dropped to fit the
  narrower tables (source models are a hover tooltip; family renders as a muted suffix).
- **Admin navigation** (`app/admin/admin-shell.tsx`): added the `LLM Stats` nav item
  (`/admin/llm-stats`, `Gauge` icon) after `LLM Usage & Cost` — the route was previously
  undiscoverable.
- **gpt-5 alias regex** (`src/lib/llm-stats.ts`): broadened to `/\bgpt-5(?:[.\d-][^\s]*)?$/i` per the
  Sentry MEDIUM finding so future gpt-5 variants (dated builds, new codenames) roll into the
  `gpt-5` family.  `gpt-nano` / `gpt-mini` patterns still win on order (verified by test).
- **Ledger materialization** (`src/lib/llm-stats.ts`): `aggregateLlmStats` now aggregates per
  model in SQL (`GROUP BY model, provider, cost_source`) and merges alias buckets in JS, plus a
  narrow latency-sample query — the unbounded all-time window materializes O(distinct models)
  instead of O(all LLM calls).  Semantics are exact (sums, status counts, distinct
  source-model/provider sets, nearest-rank latency percentiles unchanged).
- **Handoff records**: this note, `STATUS.md`, `docs/EFFORT-LOG.md`, `PLAN.md` entries.

## 3. Decisions & Trade-offs

- The Opus 5.5 pricing comment added by the MM commit pins **$4/$20 per MTok** (2026-09-23
  DuckDuckGo check).  PR #3705 (same sweep, still open at the time of this round) transitions the
  catalog to native `claude-opus-5-5` at **$4.50/$22.50** and adds the `claude-opus-5-5` /
  `claude-opus-5.5` aliases.  Whichever PR merges second must reconcile the price pin and the
  overlapping alias entries in `src/lib/llm-model-catalog.ts` and `src/lib/llm-usage.ts`.
- Kept the pre-existing `claude-opus-latest` → `claude-sonnet-latest` budget-downgrade behavior
  untouched; only the new Opus 5.5 entries were in scope for Jay's #3705 ruling (handled in the
  #3705 lane, not here).
- The two-column console layout narrows the tables; per-row timeouts/canceled counts were judged
  acceptable to drop from the table (errors retained) in favor of the mandated side-by-side
  comparison.

## 4. Verification State

On the merged tree (`/tmp/socratic-prsweep-r3/w3452`, Mac):

- `npx tsc --noEmit` — clean.
- `npm run lint` — 0 errors (829 warnings, repo-pre-existing `no-explicit-any` backlog).
- Targeted vitest: `test/llm-stats-alias-aggregator.test.ts` (9),
  `test/chat-llm-anthropic-usage-status.test.ts` (5),
  `test/chat-llm-openai-usage-status.test.ts` (4) — 18/18 pass.
- `npm test` (full suite) — 751 files / 8239 tests passed; 2 files / 14 tests failed, both
  fixed in this round: `test/persistence-hardening.test.ts` (11 failures — the PR adds
  migration v91 `llm_usage_latency_status`, the test hardcoded the latest version as
  `toBe(90)`; updated to `toBe(91)`) and `test/copy-rules-lint.test.ts` (3 failures —
  sentence-gap + Central-time violations in the new `app/admin/llm-stats/llm-stats-client.tsx`;
  fixed with `{SENTENCE_GAP}` at the sentence boundaries and
  `timeZone: "America/Chicago"` on the generated-at stamp).  Both files re-run green, 42/42.
- `npm run build` — success (EXIT=0).

## 5. Next Steps & Blockers

- Push the fix commit to `minimax/llm-stats-and-held-20260923`; `verify` CI re-runs on the new
  head.  Merge (squash) once green, per the standing owner auto-merge rule.
- Reply to / resolve the Codex + Sentry review threads after the fixes land.
- Reconcile the Opus 5.5 price pin ($4/$20 vs #3705's $4.50/$22.50) when #3705 merges.

## 6. Zero-Code Findings

None — code changed (see above).
