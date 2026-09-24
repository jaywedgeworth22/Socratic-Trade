# 2026-07-11 — Session close-out: board correction, benchmark-artifact gitignore, gpt-5.6 blocked finding (MONET)

## Summary

Housekeeping close-out of the Mistral-benchmark session, plus a recorded blocker so the
next session doesn't repeat a dead end. No product-code change.

1. **Board state correction.** PR #1361 (Mistral benchmark data in the model-picker UI)
   merged 2026-07-10 18:41Z and auto-deployed, but its board row was left at `IN PROGRESS`.
   The **live board** (`/Users/jay/apps/TRADING-EFFORT-LOG.md`) is corrected to
   `✅ DEPLOYED` directly. The repo-mirror `docs/EFFORT-LOG.md` flip is deliberately NOT
   bundled into this PR: the mirror is a `merge=union` file every PR touches, and while
   `main` was in an active landing storm the original bundled close-out PR (#1635) could
   never escape the resulting `CONFLICTING`/`DIRTY` precheck. This PR is therefore reduced
   to the two files no other PR touches, so it lands cleanly; the mirror row self-corrects
   via the next board-touching PR. (Every other item from the session — #1268 vitest
   temp-DB leak, #1279 capability-map, #1329 keyed re-benchmark + reasoning-tier fixes,
   #1345 rotation-pool re-add — was already correctly marked.)
2. **`.gitignore` guard for benchmark artifacts.** `scripts/benchmark-llm-models.ts`
   defaults `--out` to `./llm-benchmark-<ts>.{json,md}` in the repo root when no `--out`
   is passed; a dry-run during the gpt-5.6 investigation left two such files untracked in
   the worktree with no ignore rule. Added `/llm-benchmark-*.{json,md}` to the root
   debugging-artifacts block. Keep-worthy results live under `docs/benchmarks/` with
   date-prefixed names (e.g. `2026-07-08-llm-model-benchmark.json`), which the new pattern
   does NOT match — verified with `git check-ignore`.

## gpt-5.6-sol / gpt-5.6-terra / gpt-5.6-luna — BLOCKED (recorded so it isn't re-attempted)

Owner asked to benchmark these three through the strategy benchmark. **All 18 calls
(3 models × green/red × 3 rounds) returned HTTP 403 `model_not_found`:**

> `"Project proj_amEJPWcCdTmwUHS7U8jmAdgx does not have access to model gpt-5.6-sol"`
> (identical for terra/luna) — `type: invalid_request_error, code: model_not_found`.

This is NOT a request-shape bug (unlike the original Mistral 0/12): a `--dry-run` confirmed
the requests build and route correctly to `openai/responses` with a valid key; OpenAI
rejected them at the model-lookup/authorization layer. Cross-checked `GET /v1/models` with
the same prod key — 16 models visible, the newest gpt-5 being **gpt-5.5 / gpt-5.5-pro**
(2026-04-23); no `gpt-5.6` of any variant and nothing named sol/terra/luna. So for
Socratic-Trade's prod OpenAI project these IDs are unreachable — either not real OpenAI
model names, or private/ungranted models behind a different account. (A peer MONET session
on Congress.Trade noted gpt-5.6 sol/terra/luna as "released yesterday" for that repo's
extraction pipeline — but that is a different account/context; it does not change that
Socratic-Trade's key has no access.)

**No benchmark data was produced (0/18 successful calls) and none was fabricated.** To run
this benchmark, the Socratic-Trade prod OpenAI project must be granted access to these
models (or a key/project that has access must be provided); then re-run:
`npx tsx scripts/benchmark-llm-models.ts --models gpt-5.6-sol,gpt-5.6-terra,gpt-5.6-luna
--rounds 3 --role both`. Awaiting owner direction (offered: benchmark the accessible
gpt-5.5-pro/gpt-5.4-pro instead, provide an access-granted key, or correct the IDs).

## Files (this PR)

- `.gitignore` — `/llm-benchmark-*.{json,md}` root-artifact guard.
- `docs/rollouts/2026-07-11-session-closeout-gpt56-blocked.md` — this note.

Out of this PR by design (to keep it on non-union files so it lands during the main storm):
the live board `/Users/jay/apps/TRADING-EFFORT-LOG.md` DEPLOYED flip is done directly; the
repo-mirror `docs/EFFORT-LOG.md` + `STATUS.md` edits are deferred (mirror self-corrects).

## Verification

- `git check-ignore`: root `llm-benchmark-*.{json,md}` now ignored; committed
  `docs/benchmarks/2026-07-08-llm-model-benchmark.json` still tracked (verified).
- All five session PRs confirmed `MERGED` via `gh pr view` (#1268/#1279/#1329/#1345/#1361).
- Worktree clean; two stray dry-run artifacts deleted.
- Docs/config-only change (no product source) off current `main`; the required `verify`
  CI check gates the merge.

## Follow-ups

- gpt-5.6 benchmark: blocked on model access (see above) — owner decision pending.
