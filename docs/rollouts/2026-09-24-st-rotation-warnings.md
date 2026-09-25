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
