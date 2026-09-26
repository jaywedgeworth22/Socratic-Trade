# 2026-09-24 — Warnings crash, rotation failover, exit de-risk default (lane C)

## 1. Context & Objective

Owner-directed trading-performance program (board `687a5fb4`), lane C.  Three related
production/reliability fixes bundled in one PR per the workflow brief:

1. A prod strategy run failed with exactly `"k.warnings is not iterable"`.
2. A prod run failed with `"Green Team proposal failed using OpenRouter mistral-medium-3-5: Your
   OpenRouter key doesn't have access to this model or region."` — an OpenRouter 403 access error
   had no failover, and the Red Team reviewer had no rotation-pool safety net at all (issue #2577
   only fixed Green).
3. `deRiskExitsOnAdversaryUnavailable` defaulted OFF, so a risk-**reducing** exit was held for
   human approval whenever the adversary review was unavailable — the unsafe direction, per owner
   ruling 2026-09-24.

## 2. Changes Made

### (1) Warnings crash

`extractScan` (`market-scan-freshness.ts`) cast an audit payload's `scan`/`marketScan` field
straight to `MarketScan` with no shape validation.  Since 2026-08-01 (`audit-bounded-run.ts`),
every `strategy_run` audit's `marketScan` field is actually a **bounded summary**
(`{ omitted: true, source, generatedAt, scannedSymbols, returnedQuotes, candidateCount,
topSymbols }`) — it has no `warnings`, `topCandidates`, `sectorBySymbol`, or `quotesBySymbol`.
`newestPersistedMarketScan` could hand this shape back as "the last completed scan", and
`strategy-gather.ts`'s `withLastGoodWarning` then did `warnings: [...scan.warnings, warning]`,
which throws when `scan.warnings` is `undefined`.

Fix, in three layers (validate at the source, default what's legitimately optional, defend at
the crash site itself):

- `market-scan-freshness.ts`: new `isUsableMarketScan` type guard — rejects `omitted === true`
  and any payload missing a required `MarketScan` field (`source`, `generatedAt`,
  `scannedSymbols`, `returnedQuotes`, `topCandidates` array, `sectorBySymbol`/`quotesBySymbol`
  objects).  `extractScan` now uses it, and defaults a genuinely-usable-but-legacy scan's missing
  `warnings` to `[]` rather than rejecting it outright.
- `strategy-gather.ts`: `withLastGoodWarning` defends the spread itself
  (`Array.isArray(scan.warnings) ? scan.warnings : []`) — belt-and-suspenders independent of the
  extractScan-level fix.
- `strategy-tuning.ts`: grepped for other spreads/iterations of `.warnings` over deserialized
  objects and found the same unchecked-cast pattern — `proposeStrategyTuning` reads
  `latestAuditByKind("strategy_run", ...).payload as LatestDecisionPayload`, and
  `compactMarketScan(latestDecision.marketScan)` would crash on `scan.topCandidates.slice(10)` the
  first time it read a real post-2026-08-01 `strategy_run` row.  Hardened with the same
  `Array.isArray(scan.topCandidates)` guard, and exported the function for a focused unit test.

### (2) Rotation model-access-error failover

Mostly implemented by a previous interrupted attempt of this same lane; this session reviewed it
line-by-line against the task, verified it correct, and closed the remaining gaps (see §3).

- `model-rotation.ts`: `recordOpenRouterModelNotFound` now cools a slug on OpenRouter 403
  ("doesn't have access to this model or region") exactly like 404 — **never** on 429 (transient
  rate limit).  `implicitGreenRotationFallbacks` (seat-agnostic despite the name) now also
  excludes any slug currently cooling down from a recent 404/403.  `resolveModelRotationForRun`
  returns a new `redRotationPool` (mirrors the existing `greenRotationPool`) whenever the RED seat
  is rotating and the pool is non-empty.
- `strategy.ts`: builds `implicitRedFallbacks` from `redRotationPool` the same way it already
  built `implicitGreenFallbacks` from `greenRotationPool` — owner-configured
  `redTeamFallbackModels` win unchanged; the implicit chain only fills in when unset.  The Bull
  (Green) attempt loop's 404-only cooldown-recording site now also records on 403.
- `red-team.ts`: the Red attempt loop's 404-only cooldown-recording site now also records on 403
  (mirrors Green exactly).  The model that actually served the review was already recorded on
  `RedTeamDebateResult.model` — no new field needed.

### (3) Exit de-risk default flip

- `defaults.ts`: `DEFAULT_POLICY.tuning.deRiskExitsOnAdversaryUnavailable` is now `true` (was
  absent/`undefined`, which the routing helper treated as `false`).
- `red-team-routing.ts`: `routeOnAdversaryUnavailable`'s exit branch inverted from
  `!== true` (default OFF) to `=== false` (default ON, explicit opt-out only).  Openings are
  still unconditionally held (unchanged) — only the exit branch flipped.
- `types.ts`: updated the `deRiskExitsOnAdversaryUnavailable` doc comment (still vestigial on the
  live path per the §3.5 single-adversary consolidation, but the default/rationale changed).
- `mergePolicy` (`db-profiles.ts`, unmodified) already deep-merges `tuning`, so every
  already-stored policy that never set this key inherits the new default on its next read — no
  migration needed.

### Files touched

- `src/lib/market-scan-freshness.ts`
- `src/lib/strategy-gather.ts`
- `src/lib/strategy-tuning.ts`
- `src/lib/model-rotation.ts`
- `src/lib/red-team.ts`
- `src/lib/red-team-routing.ts`
- `src/lib/strategy.ts`
- `src/lib/defaults.ts`
- `src/lib/types.ts`
- `test/market-scan-freshness.test.ts` (new cases)
- `test/strategy-gather.test.ts` (new case)
- `test/strategy-tuning-compact-market-scan.test.ts` (new file)
- `test/model-rotation.test.ts` (new cases)
- `test/red-team-openrouter-access-error-failover.test.ts` (new file)
- `test/model-defaults-derisk-exits.test.ts` (new file — the file
  `test/redteam-failure-routing.test.ts` already referenced in a comment but that did not exist
  yet from the previous interrupted attempt)
- `test/redteam-failure-routing.test.ts` (previous attempt's edits, reviewed and kept)
- `test/guard-enablement.test.ts` (fixed a pre-existing `toEqual` exact-match assertion that would
  have broken on the new `deRiskExitsOnAdversaryUnavailable` default-tuning key)
- `STATUS.md`, `PLAN.md`, this rollout note, `docs/EFFORT-LOG.md` /
  `/Users/jay/apps/TRADING-EFFORT-LOG.md`

## 3. Decisions & Trade-offs

- **Picked up an interrupted attempt's uncommitted work rather than redoing it.**  Fixes (2) and
  (3) were already implemented (not fix (1) — `strategy-gather.ts`/`market-scan-freshness.ts` were
  untouched).  Reviewed the existing diff line-by-line against the task brief and the actual call
  sites (`isFailoverLlmStatus`, `mergePolicy`, `routeOnAdversaryUnavailable`'s opening branch) —
  it was correct.  The one real gap: `test/redteam-failure-routing.test.ts`'s comment referenced
  `test/model-defaults-derisk-exits.test.ts` for "merge-inheritance coverage" that did not exist —
  created it.
- **Also fixed `strategy-tuning.ts`'s `compactMarketScan`.**  Not in lane C's named file list, but
  the task explicitly asked to "grep for other spreads/iterations of `.warnings` ... and harden
  them" — this is the exact same unchecked-cast-of-an-audit-payload bug class, on a real,
  reachable path (`proposeStrategyTuning`), and the fix is a minimal, additive guard.  Exported
  the previously-unexported `compactMarketScan` only so it has a focused unit test independent of
  the heavy DB/LLM-mocked integration harness the rest of that module needs.
- **Did not touch `market.ts`'s several `.warnings` spreads/pushes.**  Traced each one — they
  operate on freshly-computed, statically-typed `MarketScan`/quote objects built within the same
  scan execution, never on a deserialized/audit-sourced payload, so they are not the same bug
  class and are out of `market.ts`'s (unowned by this lane) scope.
- **Cross-test state leak found and fixed in my own new red-team test file.**  My first version of
  `test/red-team-openrouter-access-error-failover.test.ts` had a 429 test bleed a
  `llm-provider-cooldown.ts` transient cooldown into a later test in the same file (same default
  `userId: "local"`), undercounting a later test's call count.  Fixed with
  `resetLlmProviderCooldownsForTests()` in `beforeEach`/`afterEach` alongside the existing
  `clearOpenRouterModelCooldowns()`.
- **No new field for "which model served the Red review."**  `RedTeamDebateResult.model` already
  records the concrete model that served (or last attempted) the review; the implicit fallback
  chain just gives it more models to legitimately succeed with.  No `redServedByFallback`-style
  field was needed.

## 4. Verification State

Targeted suites (all pass; some via multiple runs to separate real failures from environment
flakiness — see below):

```
npx vitest run test/market-scan-freshness.test.ts test/strategy-gather.test.ts \
  test/strategy-tuning-compact-market-scan.test.ts
# 3 files, 36 tests passed

npx vitest run test/model-rotation.test.ts test/model-rotation-live-catalog.test.ts \
  test/guard-enablement.test.ts
# all passed

npx vitest run test/red-team-openrouter-access-error-failover.test.ts
# 3 tests passed (after fixing the cross-test cooldown leak above)

npx vitest run test/model-defaults-derisk-exits.test.ts
# 7 tests passed
```

Full gate (`npm run lint` -> `npx tsc --noEmit` -> `npm test` -> `npm run build`) run before
landing — see the PR/commit for the exact tail output; this session's Mac was under extremely
heavy shared-box load throughout (`uptime` load averages observed in the 440–700 range on an
8–16 core box), which caused several spurious hook/test timeouts on synchronous, in-memory
assertions (module-import time under CPU starvation, not logic bugs) — reproduced, diagnosed, and
mitigated with generous explicit per-test timeouts on the new heavier test files rather than by
weakening any assertion.

**Pre-existing failure, NOT caused by this change — reproduced on a clean `origin/main` checkout
before any of this session's edits:** `test/redteam-failure-routing.test.ts`'s three
`runStrategyOnce`-driven integration tests (`"holds a high-conviction OPENING for human review
..."`, `"a de-risking SELL of an existing position proceeds to placement ..."`, `"appends a RED
TEAM FAILED note to a propose-mode card ..."`) time out at the vitest default 30s, both with this
branch's changes and on `origin/main` with none of them (confirmed via `git stash` back to a
clean tree and re-running the same file in isolation).  Left untouched per the standing
instruction not to "fix" unrelated failing tests — flagging here for the next person who
diagnoses it, since it is very likely just this session's contended host rather than an actual
regression on `origin/main`.

## 5. Next Steps & Blockers

- Land via `scripts/land.sh`; PR opens READY, not draft.  Per this task's harness instructions,
  auto-merge is **not** armed by this session — a later review stage arms it after an independent
  check.
- The `redteam-failure-routing.test.ts` timeout above is worth a second look on a quiet box (or
  with `--pool=forks --poolOptions.forks.singleFork` to remove worker contention) to confirm it
  really is environmental and not a slow-burning regression from an earlier, unrelated change on
  `origin/main`.
- No further code changes identified for this lane's scope.

## 6. Zero-Code Findings

None beyond what's captured in §3/§5 above — this was entirely a code-and-test lane.

## 7. Review Round (2026-09-25, Follow-Up PR To #3761)

**Context.**  PR #3761 merged to `main` before its independent adversarial review finished.  The
reviewers raised six findings against what is now on `main`.  Each was re-verified against the
code before acting.  Follow-up branch: `claude/st-rotation-warnings-review-fixes`.

### Fixed

- **P1 — Red's implicit fallback could make Green's own model review its opening.**  Verified:
  `resolveModelRotationForRun` returned `redRotationPool: pool` (the FULL pool) and strategy.ts fed
  it to `implicitGreenRotationFallbacks(pool, redPick)`, which only excluded Red's own pick and
  puts `PREFERRED_GREEN_FAILOVER_SEATS` first.  With Green on `gemini-flash-latest`, that model was
  Red's first fallback, so one 403/5xx/empty body on Red's pick meant the proposer reviewed its own
  opening — auto-executed under Autopilot, where before #3761 the review was unavailable and the
  opening was held.  The mirror case (Green's chain holding Red's model) predates #3761 (#2577).
  Fix, three layers: (a) new `planRotationImplicitFallbacks` in `model-rotation.ts` plans both
  chains together; Green's chain excludes Red's run model and pick, Red's chain excludes Green's
  run model and pick, compared by model line (`isSameModelLine`, new in `model-identity.ts`), and
  owner-configured fallbacks still win unchanged; (b) `redRotationPool` is now the Green-excluded
  pool Red was actually sampled from, and a RED-ONLY rotation no longer samples the Green seat's
  fixed model either; (c) `debateProposal` skips any FALLBACK reviewer whose model line matches
  `proposal.proposedByModel` (covers a Green failover onto a model in Red's chain, and an explicit
  chain that names the proposer).  The owner-chosen PRIMARY reviewer is deliberately left alone —
  one model for both seats is an owner choice (and a one-model pool degenerates to it by design).
- **P2 (two findings, same defect) — 403 cooldown was process-wide per slug.**  Verified: one
  module-level Map keyed only by wire slug, 6h TTL, now also written on 403.  Per OpenRouter a 403
  is per key (model restrictions / guardrails) or per request (moderation-flagged input), and
  `resolveLlmCredential` resolves a distinct OpenRouter key per user.  Fix: a 403 cools only under a
  `user <userId> <slug>` key (the same account-boundary scoping as `laneKey` in
  `llm-provider-cooldown.ts`), never on a moderation refusal (`isOpenRouterModerationRefusal`), and
  not at all without a user; a 404 stays catalog-wide.  `isOpenRouterModelCoolingDown`,
  `applyRotationAvailabilityFailOpen`, `applyRotationUserModelAllowlist` and
  `implicitGreenRotationFallbacks` take the user; `eligibleRotationPool` and the planner pass it.
- **P2 — `redRotationPool` had zero coverage.**  Verified by grep.  Added red-only, red-only with a
  fixed in-pool Green model, and both-seats tests in `test/model-rotation.test.ts`, plus planner
  tests for the exact reviewer scenario, the reverse direction, a fixed seat spelled differently,
  and owner-configured fallbacks.
- **P2 — Red exhaustion message did not list tried models.**  Verified: the fail-closed reason
  carried only the last attempt's humanized error.  `debateProposal` now appends
  `Tried N reviewer models: a, b.` when more than one was called, and names any fallback skipped
  because it proposed the trade.  The existing reason prefix is unchanged.
- **P2 — EFFORT-LOG still showed lane C as IN PR after #3761 merged.**  Verified.  Row flipped to
  Completed (merged 2026-09-25, `df9044f0`) and a review-fixes row added.

### Declined

None.  All six findings were real (the two cooldown findings describe one defect).

### Files touched (review round)

- `src/lib/model-identity.ts` — `isSameModelLine`.
- `src/lib/model-rotation.ts` — per-user 403 cooldown, moderation carve-out,
  `planRotationImplicitFallbacks`, Green-excluded `redRotationPool`, user-aware fail-open helpers.
- `src/lib/strategy.ts` — plans both implicit chains via the planner; scoped 403 recording.
- `src/lib/red-team.ts` — proposer-fallback skip, scoped 403 recording, tried-models receipt.
- `test/model-rotation.test.ts`, `test/red-team-openrouter-access-error-failover.test.ts`.
- `docs/EFFORT-LOG.md`, `STATUS.md`, this note.

### Environment note

While this round ran, every linked git worktree of this repo under `~/apps` (and the session
scratchpad) was being deleted within minutes by an unidentified external process under a load
average above 240; `~/.claude-disk-janitor/janitor.log` has no entry for it.  The round was
finished from a standalone `git clone --shared` at `~/apps/claude-st-rotfix/repo` instead of the
requested `~/apps/trading-claude-st-rotation-warnings-review-fixes` worktree, with frequent pushes.
