# 2026-07-17 — Visual-tour findings fix wave (MONET)

## Summary

Fixed the actionable findings from CLAUDE's 2026-07-17 visual tour
(`scratchpad/visual-tour-findings.md`) via four parallel Sonnet subagent lanes on disjoint
file sets, reconciled and verified by the MONET main loop.

**Fixed:**
1. **[P1] Outcomes "PRACTICE MONEY (PAPER BROKER)" framing removed** — direct violation of the
   "an account is an account / no paper-mode framing" ruling. Section retitled to the neutral,
   factual "Account P&L" (paper vs brokerage stated as the account's own environment, never a
   "practice" tier); the module comment and the equity-chart aria-label were de-"practice"-d
   too. It also now gates on a connected account (was rendering $0/dash tiles with no account) —
   empty state: "Connect a broker account to see its P&L here." (`app/console/results/page.tsx`)
2. **[P3] Usage h1 canon** — h1 was "LLM usage & cost" while the rail says "Usage". Added an
   optional `title` prop to the shared `LlmUsageClient` (default preserves the admin mount's
   "LLM usage & cost"); `/console/usage` now passes `title="Usage"`. Used a literal string + the
   established server-component comment (not `destinationLabel()`, which throws from a server
   component). (`app/admin/llm-usage/llm-usage-client.tsx`, `app/console/usage/page.tsx`)
3. **[P2] Admin raw "HTTP 403" banner** — new shared `app/admin/lib/probe-error.ts`
   (`describeProbeStatus`/`describeProbeNetworkError`, audience-aware) replaces the raw
   `HTTP ${status}` string with human copy ("Operator access required — this data needs an admin
   API identity the current session doesn't have.") across all five admin clients + the admin
   dashboard's per-card chips; raw status preserved in a `title` tooltip. Auth model unchanged.
4. **[P2] Mobile (375px) chrome** — account switcher no longer clips to "N.." (min-width floor
   + tightened mobile gaps, no overflow at 375px); icon-only mobile Run-once is now an outline
   variant so it doesn't read as a twin of the filled "Start" (mobile Run-once access kept); the
   bottom-bar overflow item "Tabs" → "More" (+ sheet header/titles). (`chrome.tsx`, `shell.tsx`,
   `nav.tsx`)
5. **[P2] Stale model-ID placeholder** — Strategy fallback-model input `e.g. gpt-4o,
   claude-3-5-sonnet-20240620` → `e.g. gpt-5.4-mini, claude-sonnet-5` (real current catalog IDs).
   Placeholder STRING only — model-ID canonicalization deferred to the in-flight #1703 lane.
6. **[P2] Scan empty-state deep link** — "choose a base index in Settings" → "…in Guardrails"
   (the Universe card actually lives on Guardrails after the IA split). (`app/console/scan/page.tsx`)
7. **[P3] Guardrails raw identifier leak** — the `drawdownBreakerAction` enum key was in
   user-facing hint text in `field-defs.ts` (not page.tsx); reworded to plain English.
8. **[P3] Journal duplicate rows + raw dotted types + bogus chip** — `notification.delivery`
   audit kind added to `OPS_AUDIT_KINDS` (folds the delivery wrapper into the System bucket
   instead of a duplicate card); `humanizeKind` now strips `.` as well as `_` (no `Foo.bar` in
   the UI); a `STATUS_LESS_AUDIT_KINDS` set stops pure preference logs (data_pool_consent) from
   getting a fabricated "Completed" chip. +3 tests. (`src/lib/dashboard-feed.ts`)
9. **[P3] Brand string** — welcome hero "Socratic-Trade" → "Socratic Trade" (dot form is the
   domain; product name uses a space). (`app/welcome/page.tsx`)
10. **[P3] earningscalls Sentry probe noise** — the integration is configured but pre-subscription
    (known permanent HTTP 405 until the owner finishes the RapidAPI plan), yet every 405 logged a
    health failure that tripped a Sentry alert. Added `suppressHealthStatuses: [405]` to the one
    `earningsCallsGet` fetch (same pattern FMP capability probes already use for 402/403). Genuine
    failures (500/timeout/real 401 after subscribing) still alert. (`src/lib/earningscalls-transcripts.ts`)

**Investigated, deliberately NOT changed (reported as correct-by-design / not-reproducing):**
- **"Vetoed by Bear risk" label** — KEPT. The deterministic bear veto (`strategy-risk.ts`:
  rule-based FCF/debt/regime thresholds, zero LLM calls) is a genuinely distinct mechanism from
  the LLM Red Team; the single-adversary consolidation docs explicitly retained it. Renaming
  would erase a real distinction.
- **Dark-mode reality ribbon** — did NOT reproduce. `.con-reality-*` already uses only
  theme-aware `--con-*` tokens (dark overrides since 2026-07-02); verified empirically in a dark
  dev server. No cosmetic no-op edit made.

**Surfaced to owner (NOT coded — decisions / possible real bugs, not UI fixes):**
- Production apex serves the bare sign-in page; the good `/welcome` landing exists but anonymous
  visitors never reach it (likely deliberate GTM flag-gating — owner call + login-page polish).
- tradingLiveness: one active-autonomy account's `oldestCompletedRunAgeSeconds` ≈ 6+ days across
  market days — either intentionally paused (then "active" count misleads) or a silent stall the
  liveness dimension doesn't flag. Worth an owner look.
- usage-monitor bridge Sentry (SOCRATIC-TRADE-W) = the Render app outage the owner already resized.

## Files

See PR diff. New: `app/admin/lib/probe-error.ts`. Modified: results/usage/scan/strategy/guardrails
console pages + field-defs, chrome/nav/shell, welcome, 5 admin clients + admin page,
`src/lib/dashboard-feed.ts`, `src/lib/earningscalls-transcripts.ts`, `test/dashboard-feed.test.ts`.

## Verification

- `npx tsc --noEmit` clean; `npm run lint` 0 errors (493 grandfathered warnings); full suite
  **403 files / 4,724 tests pass** (incl. 3 new dashboard-feed tests); build via land.sh.
- Live dev server (Node 24): Results shows "Account P&L" + empty state, no "practice" text;
  Usage h1 = "Usage"; mobile 375px bottom bar shows "More", switcher reads full account label,
  scrollWidth == 375 (no overflow); admin pages show no raw "HTTP 403".

## Follow-ups

- Model-ID canonicalization on the fallback inputs (picker vs free-text) — #1703 lane.
- `KNOWN_GLOBAL_AUDIT_KINDS` has a dead `"consent"` entry (real kind is `data_pool_consent`) —
  pre-existing, unrelated; flagged not fixed.
- Owner-decision items above.
