# 2026-07-18 — Decision/status display truth (Codex items 22, 23, 24, 26, 29)

Branch: `claude/decision-status-truth-fix` (worktree
`/Users/jay/Code/Socratic-Trade/.claude/worktrees/agent-a76603c7aabd157d7`; the sibling
branch name `claude/decision-status-truth` was already checked out in another agent's
worktree, so this lane took the `-fix` suffix). Display-truth batch: every change makes a
UI/health surface stop asserting something that is no longer (or never was) true. No
trading behavior, gating, or scheduling changes anywhere in this diff.

## Summary (what changed)

Five Codex-audit product-truth findings, one commit:

- **Item 22 — Red Team "held for human approval" outlives the approval.**
  `redTeamVerdictLabel` (app/console/lib/red-team.ts) now accepts an optional third
  argument, `outcomeStatus` — the deterministic decision/proposal status recorded AFTER
  the review. When a review was unavailable (`verdict.available === false`) and the
  proposal was subsequently resolved, the label becomes past-tense and accurate:
  "Review unavailable; subsequently approved and executed" (filled/placed),
  "…; subsequently approved; execution pending confirmation" (placing),
  "…; subsequently blocked by policy before placement" (blocked),
  "…; subsequently rejected by the user" (rejected),
  "…; subsequently approved, but rejected by the broker" (rejected_by_broker),
  "…; subsequently approved, but never placed" (not_placed/placing_failed/error/failed),
  "…; left pending until it expired, unreviewed" (expired),
  "…; subsequently withdrawn before a decision" (withdrawn).
  Unresolved statuses (proposed/pending/planned/observed/undefined/unrecognized) keep the
  original live claim "Review unavailable — held for human approval", which is still true
  for them. Available verdicts are untouched — the reviewer-verdict wording never claims
  the later broker outcome (that separation predates this change and is preserved).

  Consumers audited (every `redTeamVerdictLabel` call site):
  - **Console home live thesis** (`app/console/page.tsx` ThesisNarrative) — now passes the
    in-scope `status` prop. This is the exact surface Codex flagged: it rendered
    "held for human approval" and "Deterministic outcome · Order filled" simultaneously.
  - **Decision trace page** (`app/console/decisions/[id]/page.tsx`) — the failed-review
    Dissent article previously hardcoded "review failed (…)"; it now renders the shared
    outcome-aware label + the failure-kind suffix, passing `decision.status`.
    The available-verdict chip is unchanged (outcome status is irrelevant to it by design).
  - **Approval card** (`app/console/components/approval-card.tsx`) and **mobile PWA**
    (`app/mobile/mobile-pwa-client.tsx`) — both render PENDING proposals only, where
    "held for human approval" is literally true; deliberately NOT passing a status
    (there is none — the proposal is still awaiting the human). No change.
  - **Console home dissent rows** (`deriveDissentRows` in page.tsx) — guarded by
    `redTeamVerdict?.available`, so the unavailable branch never reaches it. No change.
  - **Activity/Journal page** (`app/console/activity/page.tsx`) — does not render red-team
    labels at all (verified by grep); nothing to keep consistent there.

- **Item 29 — "Running now" while the market is closed.**
  `deriveStateInfo` (app/console/lib/derive.ts) is now market-aware for `systemState ===
  "active"` only: market open (per `isRunAllowedNow` + the account's
  `runDuringExtendedHours`) keeps `Running · Ask-first`/`Running · Autopilot`; market
  closed renders **"Paused · market closed"** (tone muted) with a detail line that names
  the next open via the new `nextMarketOpenHint` helper and states that runs resume
  automatically. `StateInfo` gains an optional `marketOpen` field (undefined for
  close_only/liquidating/halted — those aren't on a market clock). Display truth only:
  `state` stays `"active"`, no scheduler/policy behavior changes. Consumers updated:
  - Console home "Run cadence" card (`app/console/page.tsx`): the "Running now." fallback
    line is replaced by the paused-state detail when the market is closed, and the state
    chip maps the new muted tone instead of forcing pos.
  - Header `StateChip` (`app/console/components/chrome.tsx`): stops pulsing the Autopilot
    dot while paused; label/detail flow through automatically.
  - Approvals header chip (`app/console/approvals/page.tsx`): maps muted tone.
  - Account-switcher rows (chrome.tsx `renderRow`): flow through automatically. (First
    commit shipped these rows extended-hours-blind — fixed by the adversarial-verification
    follow-up commit below: the `connectedAccountPolicies` projection now carries
    `runDuringExtendedHours`.)
  New pure helpers in `src/lib/market-hours.ts`: `isTradingDay`,
  `previousTradingDayStart`, `nextTradingDayStart`, `nextMarketOpenHint` (bounded walks,
  reuse `getMarketHolidays`). `nextMarketOpenHint` is deliberately coarse (tooltip-grade;
  it does not special-case the weekday 00:00–04:00 ET gap) and says so in its doc comment.

- **Item 23 — Day P&L silently compared against a 10-day-old baseline.**
  Display contract fixed: `deriveDayPnl` (app/console/lib/derive.ts) now returns
  `isStaleBaseline` — true when the baseline snapshot's calendar day predates the most
  recent prior TRADING day (`previousTradingDayStart`, holiday/weekend-aware, so a normal
  Friday→Monday read is NOT stale). The console home Day P&L tile then renders an explicit
  warning sub-line — "No recent baseline — comparing to Jul 7" (warn color) — with a
  tooltip stating the number spans a real gap and is directional only. The number itself
  still renders (honestly computed, honestly labeled) rather than being suppressed.
  **Root cause NOT fixed here (documented follow-up):** snapshots are persisted only
  inside strategy runs (`recordPortfolioSnapshot` call sites in `src/lib/strategy.ts` —
  pre-run and post-run). There is no independent market-close snapshot job, so any stretch
  without completed runs (halted account, provider outage, spend-ceiling suppression)
  starves the baseline. A proper fix is a per-account, idempotent, close-cadence-gated
  snapshot task in `src/lib/scheduler.ts`'s tick — but the scheduler tick is money-adjacent
  shared machinery and a snapshot writer needs broker portfolio fetches outside the run
  lease, which is beyond this display-truth batch's blast radius. See Follow-ups.

- **Item 26 — Scan header "75/50 candidates" reads as a cap violation.**
  The candidate set is additive by design (src/lib/market.ts): ranked top-N (≤ cap) +
  below-cutoff notable outliers + ALL held positions (never hidden regardless of rank).
  Changes:
  - `MarketScan.heldCandidateCount` (src/lib/types.ts): new optional field; populated in
    `src/lib/market.ts` as the count of held names forced in beyond both the ranked cut
    and the outlier reserve. Optional so legacy persisted scans stay valid.
  - New pure module `app/console/lib/scan.ts`: `scanCandidateBreakdown` +
    `formatScanCandidateBreakdown` — renders "50 ranked + 14 held + 11 outliers"; for
    legacy scans without the field it falls back to the old "75/50 candidates · 11
    outliers" form rather than guessing a held count.
  - `app/console/scan/page.tsx` header uses the breakdown, with a tooltip explaining that
    held positions are never hidden, so the total can exceed the cap.

- **Item 24 (minimal slice) — Massive "paid tier" reason conflates freshness with availability.**
  The nightly tier watchdog's probes are PLAN-CAPABILITY checks (can this key reach
  >2-year-old history? is a single call 429'd?), but the persisted reason "returned
  >2-year-old history (paid)" read like a data-freshness claim on a health surface.
  Changes in `src/lib/provider-tier.ts` (fields, not prose, per the brief):
  - New `ProviderTierSignal` union (`no_key | rate_limited_429 | history_depth_confirmed |
    history_cap_blocked | history_cap_empty | premium_gated_error | data_returned |
    probe_error | ambiguous`) and an optional `signal` field on `ProviderTierEntry`,
    persisted by `runProviderTierCheck` and carried through `/api/health`'s
    `checks.dataProviders` automatically.
  - Reason prose for the history probes rewritten to say explicitly "plan-access probe …
    this checks plan access, not today's data freshness".
  - NO decision-gating changes: the massive.ts free-tier clamp reads only `tier` (its own
    narrow inline type) and is untouched; notifications logic untouched.
  - Note: the admin API-connections client (`app/admin/connections/…`) does not currently
    render provider-tier data at all — the only reader is `/api/health` (verified by
    grep). So the "admin client" half of the item is a no-op today; if/when a tier panel
    is added there it should key off `signal`, not `reason`. Documented as follow-up.

## Why

Codex app-review items 22/23/26/29 + the item-24 minimal slice: production showed
"held for human approval" next to "Order filled", "Running now" hours after close,
a July 7 day-P&L baseline on July 17, "75/50 candidates", and a paid-tier health entry
whose evidence string sounded like stale data. All are the same failure class — a display
asserting a state whose moment has passed — and the repo philosophy is honest gap states
over pretty lies.

## Files touched

- `app/console/lib/red-team.ts` — outcome-aware unavailable-review label (item 22)
- `app/console/page.tsx` — live-thesis label wiring (22); Day P&L stale-gap display (23);
  run-cadence paused display + muted chip tone (29)
- `app/console/decisions/[id]/page.tsx` — failed-review label consistency (22)
- `app/console/lib/derive.ts` — `deriveStateInfo` market-awareness (29);
  `deriveDayPnl.isStaleBaseline` (23)
- `app/console/components/chrome.tsx` — StateChip pulse honesty (29)
- `app/console/approvals/page.tsx` — muted tone mapping (29)
- `src/lib/market-hours.ts` — trading-day calendar helpers (23, 29)
- `app/console/lib/scan.ts` — NEW: candidate-count decomposition (26)
- `app/console/scan/page.tsx` — breakdown header (26)
- `src/lib/market.ts` — compute `heldCandidateCount` (26)
- `src/lib/types.ts` — `MarketScan.heldCandidateCount` (26)
- `src/lib/provider-tier.ts` — `ProviderTierSignal` + honest probe prose (24)
- `test/console-red-team-labels.test.ts` — outcome-temporality suite (22)
- `test/market-hours.test.ts` — trading-day/next-open helper suites (23, 29)
- `test/console-live-data-derive.test.ts` — `deriveDayPnl` stale-gap + `deriveStateInfo`
  market-awareness suites (23, 29)
- `test/console-scan-breakdown.test.ts` — NEW: decomposition/format suite (26)
- `test/provider-tier.test.ts` — `signal` field assertions (24)
- `docs/rollouts/2026-07-18-decision-status-truth.md` — this note

## Verification (commands actually run)

```bash
export PATH=/opt/homebrew/opt/node@24/bin:$PATH   # node v24.18.0 (node26 ABI trap)
npx tsc --noEmit    # clean, exit 0 (run twice: mid-batch and final post-test-edit)
npx vitest run test/console-red-team-labels.test.ts test/market-hours.test.ts \
  test/console-live-data-derive.test.ts test/console-scan-breakdown.test.ts \
  test/provider-tier.test.ts
  # 5 files, 116 tests → one first-pass failure was a bug in MY new test (listed
  # "placing" as still-pending; the implementation correctly reads it as approved,
  # execution pending) — test corrected, all pass (console-red-team-labels 22/22).
npx vitest run test/market.test.ts test/market-preselection.test.ts \
  test/scan-settings.test.ts test/red-team.test.ts test/red-team-efficacy-ui.test.ts \
  test/scan-table-columns.test.ts test/scan-singleflight.test.ts
  # adjacent suites over the touched modules: 7 files, 72 tests — 71 passed; the one
  # failure was a 60s TIMEOUT in test/red-team.test.ts ("reports not_configured when NO
  # Red model is chosen"), a server-side debateProposal test this diff does not touch
  # (only the client display module app/console/lib/red-team.ts changed). Re-run in
  # isolation: 28/28 passed in 76s — load flake on the shared box, not a regression.
git config user.email   # 12656028+jaywedgeworth22@users.noreply.github.com (verified)
```

Full `npm test` / `npm run build` deliberately not run in this session (heavily loaded
shared machine; the required `verify` CI gate runs the full trio on the PR).

## Follow-ups / deferred

1. **Item 23 root cause — daily close snapshots.** Add a per-account, idempotent,
   market-close-cadence-gated portfolio snapshot writer to the scheduler tick so the day-
   P&L baseline stays fresh even when no strategy run completes (halted accounts, provider
   outages, spend-ceiling days). Reuse `recordPortfolioSnapshot`; guard with a per-account
   `lastCloseSnapshotAt` internal setting keyed to the trading date; needs a broker
   portfolio fetch outside the run path, hence deferred from this display-only batch.
2. **Item 24 fuller pass.** If provider freshness should genuinely be surfaced (e.g.
   latest bar timestamp per lane), that's a separate observation, not derivable from the
   tier probe; and if the admin connections page grows a tier panel, key it off
   `ProviderTierEntry.signal`. Decision gating unchanged in this pass by design.
3. ~~Account-switcher extended-hours fidelity (item 29).~~ RESOLVED same day by the
   adversarial-verification follow-up commit (see below) — the projection now carries
   `runDuringExtendedHours` and `deriveStateInfo` treats a missing value as "can't know"
   (no paused/running split) instead of defaulting to false.
4. **`nextMarketOpenHint` midnight-to-4am ET gap.** During 00:00–04:00 ET on a trading
   day it names the following day instead of "today". Tooltip-grade; documented in code.

## Adversarial-verification fixes (follow-up commit, same day)

The lane's adversarial verification of the first commit (3b8c8962) returned one MUST-FIX
and two advisories, all fixed in a follow-up commit on this branch:

- **MUST-FIX (item 29):** account-switcher rows receive the narrow
  `connectedAccountPolicies` projection (built in `src/lib/dashboard.ts` from
  `peekPolicy`), which carried only `systemState`/`strategyAuthority` — so
  `runDuringExtendedHours` defaulted to false and an extended-hours account showed
  "Paused · market closed" during pre/post sessions while genuinely RUNNING. Fixes:
  (a) the projection now includes `runDuringExtendedHours` (peekPolicy already returns
  the full policy); (b) the `DashboardSnapshot` type widens the Pick with the field kept
  OPTIONAL; (c) `deriveStateInfo` now treats `undefined` as "can't know" and skips the
  paused/running split entirely (undefined ≠ false) — an older payload keeps the plain
  "Running" claim rather than gaining a false "Paused" one. Regression tests: extended-
  hours account at pre AND post sessions ⇒ "Running · Ask-first" with `marketOpen: true`;
  undefined extended-hours at pre-market ⇒ no split, `marketOpen` undefined.
- **Advisory 1 (item 29):** the console-home hero state chip hadn't been taught the muted
  tone — "Paused · market closed" rendered green there. Aligned with the run-cadence and
  approvals chips.
- **Advisory 2:** the trading-day helper comment in `src/lib/market-hours.ts` claimed US
  market holidays are "fixed calendar dates" — false as prose (nth-weekday rules, Good
  Friday computus, observation shifts). Comment corrected to say the holiday set is
  RESOLVED per year to concrete Y-M-D strings, which is what makes calendar-day
  comparison valid; code unchanged.

Additional files touched by the follow-up commit: `src/lib/dashboard.ts`,
`app/dashboard-types.ts`, `app/console/lib/derive.ts`, `app/console/page.tsx` (hero chip
tone), `src/lib/market-hours.ts` (comment only), `test/console-live-data-derive.test.ts`,
this note.
