# Blind-spots audit — Socratic-Trade

**Date:** 2026-08-17  
**Seat:** Cursor Cloud (read-only; report-only PR)  
**Tree:** `4980322b` on `main` at branch start (`fix(rag): stop treating the Pinecone Standard trial as the Starter 2M monthly wall`, #2799)  
**Audience:** owner + next agent.  This is not a conventional architecture / trading / RAG / security / UX review.

## 1. Context and method

Socratic-Trade already has a dense review corpus (architecture, strategy, RAG, security, cockpit UX, iOS parity).  Those tracks keep rediscovering the same money-path and retrieval issues.  This panel asked a different question: **which assumptions will bite second, after the well-reviewed systems look healthy?**

Method:

1. Read `STATUS.md`, `PLAN.md`, `docs/EFFORT-LOG.md`, `docs/FEATURE-ENABLEMENT-BACKLOG.md`, and the 2026-08-12+ rollout cluster.
2. Snapshot live GitHub issues and PRs (`gh issue list` / `gh pr list`, 2026-08-17 ~23:40Z) so claims are not stale.
3. Verify every finding against current code, not older review prose.
4. Exclude domains already covered by conventional architecture / trading / RAG / security / UX reviews, except where a second-order risk sits *beside* those systems.

Severity:

| Level | Meaning |
|-------|---------|
| **Critical** | Enforceability or calendar cliff that can fail without a code bug |
| **High** | User or operator outcome changes if ignored through the next product step |
| **Medium** | Real gap; cost is delayed or conditional |
| **Low** | Hygiene / future-user risk; do not prioritize over High |

Improvements are concrete and scoped.  This PR does not implement them.

## 2. What this audit deliberately does not restate

Already handled, in flight, or recently closed — do **not** treat these as new work:

| Topic | Current state (2026-08-17) |
|-------|----------------------------|
| FilingAPI.dev as a live dependency | Retired on `main` (#2787 / `b4666e74`).  Open PRs #2788 / #2792 / #2798 are leftovers or mute-noise, not a product dependency. |
| Pinecone Starter 2M monthly wall | Fixed on `main` (#2799).  Do not re-page that breaker. |
| Pinecone write-fuse / 15-WU remainder | **In flight:** #2800. |
| Console chip AA, stacked Escape, tooltip/columns/meter | **In flight:** #2795 (closes the 2026-08-06 #2561 cluster). |
| iOS privacy manifest / #2560 leftovers | **In flight:** #2794. |
| Curl-only admin surfaces | **In flight:** #2793 (#2563). |
| Green-team slug / lease-lost mislabel | Closed #2770; landed. |
| `VECTOR_ASOF_STRICT` | Prod Infisical **on** (2026-08-16).  Live desk still omits `asOf` — known, not a new finding. |
| PWA as a product | Owner retired it 2026-08-16.  `/mobile` redirects to `/console`. |
| ROIC Individual harvest | Live; local-first persist (#2763). |
| Settings-search catalog unwired | Wired on `main` (#2791 / #2558). |
| Conventional trading / RAG / security / UX reviews | See `docs/reviews/` (2026-06 through 2026-08-06). |
| Purchases / Stripe / StoreKit | **Landed on `main` after this register:** #2809.  Confirms ST has no checkout stack (invite-only).  Complements F-PROD-1 / F-LEG-7; does not contradict them. |
| Cross-app coordination (ST/CT/UM/CTS/DealDex) | **Landed on `main` after this register:** #2802.  Complements F-VEN-3 (shared Hetzner fate). |

## 3. Live GitHub snapshot (2026-08-17)

Open PRs at audit time (all Cursor/Grok, none of this branch):

- #2800 pinecone 15-WU remainder
- #2798 mute retired FilingAPI leftover 401s
- #2797 CT/UM lane backoff (#2550)
- #2796 silent deploy-freeze alert + CT OCR isolate (#2545)
- #2795 console a11y batch
- #2794 iOS release-readiness leftovers
- #2793 curl-only UI
- #2792 / #2788 FilingAPI keep-vs-retire forks (product already retired on `main`)
- #2785 favicon crop

Open issues that look **stale relative to merged work** (effort-board mirrors or leftover product issues):

- #2774 / #2752 Review UX — #2757 already merged.
- #2789 FilingAPI retire — #2787 already on `main`.
- #2686 quote-sheet / card tap — server side live; left open for a post-#2692 / #2742 TestFlight.
- Many `effort-board` + `state:in-progress` issues are ledger mirrors, not actionable bugs.

That hygiene problem is itself a finding (F-DOC-2).

## 4. Findings

### Legal / regulatory fintech

#### F-LEG-1 — No clickwrap at account creation

**Severity:** Critical  
**Evidence:** `app/login/page.tsx` offers Google / GitHub / Apple with no Terms or Privacy link and no “by continuing you agree” copy.  iOS `LoginView.swift` `privacyNote` (lines 196–205) only says the app stores a session.  Terms §1 (`app/terms-and-conditions/page.tsx:28`) claims “By accessing or using… you agree,” which is browsewrap, not clickwrap.  Pages were added for Twilio SMS (`docs/rollouts/2026-07-10-privacy-terms-pages.md`) and are labeled boilerplate, not counsel-drafted.

**User / outcome impact:** Limitation of liability, broker-delegation language, and SMS terms are hard to enforce against a user who never saw them.  App Review and any future multi-user opening both expect an in-app legal path.

**Improvement:** First-sign-in clickwrap on web + iOS: links to `/terms-and-conditions` and `/privacy-policy`, required accept, persist `{version, acceptedAt, userId}` server-side.  Re-prompt when Terms version bumps (same pattern as `DATA_POOL_CONSENT_VERSION`).

**Already tracked?** No.  Pages exist; acceptance does not.

#### F-LEG-2 — Authenticated desk has no investment-advice framing

**Severity:** High  
**Evidence:** Grep of `app/console/**` finds zero `disclaimer`, `not investment`, `terms-and-conditions`, or `privacy-policy`.  Console metadata (`app/console/layout.tsx:5-7`) is “autonomy desk” with no qualifier.  Public `/welcome` and `/how-it-works` *do* disclose.  Coach chat is versioned and enforced (`src/lib/chat/prompt.ts:7-30`, `src/lib/chat/llm.ts` appends `DISCLAIMER`).  Strategy prompts (`src/lib/strategy-prompts.ts`) have **no** equivalent “not investment advice / software tool / user-configured authority” language.

**User / outcome impact:** The surface that actually proposes and can execute trades is the one without the regulatory framing.  Coach (which cannot trade) is stricter than Green/Red (which can).  That inversion is the product-legal blind spot.

**Improvement:** Persistent one-line strip on console shell + iOS root (“Not investment advice.  You set authority.”).  Settings → Legal.  Add the same sentence to the strategy system prompt and every proposal receipt.  Do not block Autopilot — annotate it.

**Already tracked?** No.  iOS parity reviews did not cover legal copy.

#### F-LEG-3 — Privacy Policy is SMS-complete and GDPR/CCPA-empty

**Severity:** High (if any non-owner user exists or will)  
**Evidence:** `app/privacy-policy/page.tsx` §§1–8 cover collection, SMS, retention-as-contact-us, and children’s privacy.  No legal basis, no data-subject rights table, no CCPA/CPRA “do not sell” statutory language beyond a sentence, no cookie/analytics section, no subprocessors / DPA list, no international-transfer clause.  Production hosts on Hetzner NBG1 (EU).  Account deletion is implemented (`src/lib/account-deletion.ts`) and tested, but Privacy §6–7 still say “contact us.”

**User / outcome impact:** An EU-hosted multi-user app with OAuth identities, broker credentials, and a shared market-data pool cannot rely on Twilio-era boilerplate if a second user ever signs in.

**Improvement:** Counsel addenda: legal bases, US state rights, EU DSAR mapping to `account-deletion.ts`, subprocessors (OpenRouter, Pinecone, Alpaca, Resend, Twilio, Hetzner, Cloudflare, Infisical, Sentry, Langfuse), retention schedule, transfer mechanism.  Point §7 at the in-app typed-delete flow.

**Already tracked?** Mentioned as gap in older audits.  Not in `FEATURE-ENABLEMENT-BACKLOG.md`.

#### F-LEG-4 — Shared market-data pool defaults to ON before explicit accept

**Severity:** Medium–High  
**Evidence:** `src/lib/db-settings.ts:130-168` — unset users (`version === 0`, `acceptedAt == null`) return `hasDataPoolConsent === true`.  The first-run gate still re-prompts, but API / ingest paths that call `hasDataPoolConsent` share before the UI answer.  Owner decision 2026-08-05 (broken-looking fundamentals when default was false).

**User / outcome impact:** In opt-in jurisdictions this is sharing-by-default.  A user who never reaches the console gate still contributes to the pool.

**Improvement:** Default `hasDataPoolConsent` to false until explicit accept at `DATA_POOL_CONSENT_VERSION`.  Keep the gate.  Document the default in Privacy §4–5.  If the owner wants share-by-default for the primary account only, gate on `PRIMARY_EMAIL`, not “unset.”

**Already tracked?** Yes, as a product decision — not as a legal risk.

#### F-LEG-5 — IRA wash-sale default asserts IRS reporting behavior

**Severity:** Medium  
**Evidence:** `src/lib/defaults.ts:20` `iraWashSaleHandling: "disregard"`.  `src/lib/policy.ts` `IRA_WASH_SALE_DISREGARD_NOTE` = `"Wash Sale (Technically, but IRA purchase unreported to IRS)"`.  Tax UI chips say “not tax advice,” but the executed-trade annotation characterizes IRS reporting.

**User / outcome impact:** New accounts inherit a tax judgment.  Copy that names IRS reporting is tax-adjacent advice even with a chip nearby.

**Improvement:** Soften to “may have tax consequences — consult a tax professional.”  Default new non-owner accounts to `block` or `annotate` only.  Keep owner `disregard` as an explicit override (matches product philosophy).

**Already tracked?** Owner decision in code comments.  No legal follow-up.

#### F-LEG-6 — 13F / Form 4 / ARK influence proposals with thin receipt disclosure

**Severity:** Medium  
**Evidence:** Catalog marks sources observe-only (`src/lib/data-catalog.ts` 13F row).  Scan tooltips say the app does not auto-copy books.  Strategy still feeds those bulletins into the LLM under tags such as `Insider-Accumulation` (`src/lib/strategy-prompts.ts` playbook).  Proposal cards do not have to name which idea-source class fired.

**User / outcome impact:** A user (or a future regulator) can reasonably read Autopilot as “copy smart money” even though ingest is observe-only.  The gap is the receipt, not the ingest.

**Improvement:** On each proposal, list influencing idea-source classes (13F / Form 4 / ARK / congress) or “none.”  Marketing and App Store copy: observe-only signals, not a recommendation to copy any filer.

**Already tracked?** Ingest “observe only” is documented (2026-08-15/16 rollouts).  Receipt disclosure is not.

#### F-LEG-7 — Marketing JSON-LD says the product is free; in-app EULA is unreachable

**Severity:** Medium  
**Evidence:** `app/welcome/page.tsx:106` `offers: { price: "0", priceCurrency: "USD" }`.  Public footers omit Terms/Privacy links (disclaimer + email only, lines 229–240).  ASC custom EULA was patched 2026-08-16; iOS login has no Terms / Privacy / EULA links.  Landing pages are **ON** by default (`LANDING_PAGE_ENABLED` unset → true).

**User / outcome impact:** SEO and App Store discovery advertise autonomy + free while the signed-in product has weaker disclosure density.  App Review often requires in-app legal links.

**Improvement:** Footer links on every public page.  Settings → Legal on iOS.  Align JSON-LD `offers` with actual monetization (omit or mark “private software” if there is no public price).

**Already tracked?** ASC EULA write yes; in-app links no.

---

### Product strategy

#### F-PROD-1 — Public site implies a SaaS; the runtime is a single-operator desk

**Severity:** High  
**Evidence:** Landing default-on (`src/lib/landing-page.ts`, backlog).  Multi-user API-key storage is still commented as “scaffolding for future multi-user support” (`src/lib/db.ts` ~3660).  No Stripe under `src/`.  Owner philosophy (AGENTS.md) is real trading, owner’s risk, iOS + website — not a marketplace.  PWA retired but `app/mobile/**` still exists as a redirect shell.

**User / outcome impact:** Agents and future contributors optimize for “users” (consent defaults, landing SEO, IAP-shaped copy) while the only paying risk-taker is the owner.  That mismatch produces the legal gaps above *and* keeps default-off flags looking like shipped product.

**Improvement:** One owner decision note: “ST is single-operator software until explicitly opened.”  Either 404 `/welcome` in prod or retitle it as a personal desk.  Fence or delete leftover `app/mobile/**` once redirect is proven.  Publish a one-page iOS ↔ web parity matrix so “shipped” has one meaning.

**Already tracked?** PWA-off yes.  Product-identity doc no.

#### F-PROD-2 — Feature-flag surface looks like a product catalog

**Severity:** Medium  
**Evidence:** `docs/FEATURE-ENABLEMENT-BACKLOG.md` lists ready-but-off items (`USAGE_BUDGET_ENFORCE`, FMP rights, `SEC_INGEST_WORKER_ENABLED`, Kalshi live orders, Sentry replay, Apple web Sign-In).  `GET /api/admin/rag-coverage` → `dormantFeatures`.  Several “live” flags were flipped in a 48-hour burst (2026-08-12/13) without a single “what a stranger would think is on” page.

**User / outcome impact:** Agents enable the next dormant flag because the backlog says “ready.”  Cost, rights, and legal preconditions are easy to skip when the list reads like a ship checklist.

**Improvement:** Split the backlog into **owner-only ops knobs** vs **user-visible capabilities**.  A capability is not “shipped” until it has a console/iOS control or an honest “off” label.  Do not flip rights/cost gates from an audit.

---

### Accessibility (beyond #2795)

#### F-A11Y-1 — Settings errors are toast-only; fields are not associated

**Severity:** High  
**Evidence:** `app/console/ui/primitives.tsx` `Field` (lines 253–262) has `label` + optional `hint`, no `error` / `aria-invalid` / `aria-describedby`.  `app/console/settings/page.tsx` save failures go to `toast.push("neg", …)`.  Toasts share one `aria-live="polite"` region (`app/console/ui/toast.tsx:47`) with success.

**User / outcome impact:** A failed guardrail or tax save can vanish for a screen-reader user, or arrive after a success toast.  The user thinks the setting stuck.

**Improvement:** `Field` grows optional `error`.  Set `aria-invalid` + `aria-describedby`.  Focus the first invalid control.  Split toast live regions: `assertive` for `neg`, `polite` for `pos`.

**Already tracked?** Not in #2795.

#### F-A11Y-2 — No skip link; charts and several tables are visual-only

**Severity:** Medium  
**Evidence:** `app/console/components/shell.tsx:207` `<main>` has no `id`.  No “Skip to content” in console or marketing layouts.  Equity / symbol SVGs use `role="img"` with a first→last money summary (`app/console/components/equity-chart.tsx:66-73`, `symbol-drilldown.tsx`).  Watchlist and Results `<th>` omit `scope="col"` (Scan table already has it).

**User / outcome impact:** Keyboard users re-tab the rail on every route.  Screen-reader users get a two-point chart summary and inconsistently headed tables on money screens.

**Improvement:** Skip link + `id="main-content"`.  `scope="col"` on remaining tables.  Timeframe controls as `tablist`.  Visually hidden endpoint table or CSV for charts.  Do not block on a full data-viz overhaul.

#### F-A11Y-3 — iOS UIKit chrome ignores Dynamic Type

**Severity:** Medium  
**Evidence:** `ios/SocraticTrade/AppTypography.swift` documents `relativeTo:` for SwiftUI content, then sets nav / tab / segmented fonts via `AppFont.uiFont(17|34|10|13)` with no `UIFontMetrics`.

**User / outcome impact:** Larger Text scales the desk body and leaves chrome at 10–17 pt — the opposite of what a trader with low vision needs on the tab bar.

**Improvement:** `UIFontMetrics(forTextStyle:).scaledFont(for:)` on appearance proxies, or move chrome to SwiftUI so `.appHeadline` scales.

**Note:** Web `fmtSignedMoney` already prefixes `+` (`app/console/lib/format.ts:76-78`), so color-only P&L is weaker on the website than older reviews claimed.  iOS `MetricTile` tint is still color-primary — pair with an accessibility label, not a restyle of #2795 chips.

---

### Internationalization

#### F-I18N-1 — Display locale is hard-locked to en-US USD + America/Chicago

**Severity:** Medium (future-user; owner ruling is intentional)  
**Evidence:** `app/console/lib/format.ts:6-10, 64-66` — Central Time for every timestamp; `Intl.NumberFormat("en-US", { currency: "USD" })`.  iOS `AppComponents.swift` formats `.currency(code: "USD")`.  `app/layout.tsx` `lang="en"`.  No `*.lproj`, no message catalog.  Relative copy is English literals (`"just now"`, `"Today"`).

**User / outcome impact:** A non-US locale still sees US grouping, `$`, and CT labels.  Market-hours logic *should* stay America/New_York; display TZ and currency should not be the same constant.  There is no localization pipeline if App Store adds a locale.

**Improvement:** One `getDisplayLocale()` / user preference.  Keep market calendar on NY.  Extract relative-time strings to `messages/en.json` + `en.lproj` *before* any second locale.  Do not “i18n the desk” as a project — just stop scattering literals.

---

### Developer experience

#### F-DX-1 — `land.sh` cannot run in Cloud and does not match CI

**Severity:** High  
**Evidence:** `scripts/land.sh:46-52` dies unless Node is 24.x.  Cloud VM default is Node 22; AGENTS.md says not to force 24.  `land.sh` also dies in the main integration worktree and on `main`.  Verify steps are tsc → test → build (`:154-174`).  CI required gate is **lint → tsc → test → build** (`.github/workflows/ci.yml:287`).  `VITEST_MAX_THREADS` is exported (`:163`) but `vitest.config.ts:31` hard-sets `maxWorkers: 1` — the env var is dead.

**User / outcome impact:** Cloud agents invent a parallel landing path.  Local `land.sh` can go green while CI fails on lint.  Agents believe they have 4 test workers.

**Improvement:** `LAND_CLOUD=1` (or `/workspace` detect) allows Node 22 with a loud banner.  Insert `npm run lint` as step 1.  Wire `--maxWorkers` to the env var or delete it.

#### F-DX-2 — Required CI never runs Playwright or Swift tests

**Severity:** High  
**Evidence:** `vitest.config.ts:49-56` excludes `test/e2e/**`.  `.github/workflows/e2e.yml` is a separate nightly.  `.github/workflows/ios-build.yml:71-78` is `xcodebuild build` only — comment at line 7: “XCODE BUILDS ONLY.”  AGENTS.md already documents the 2026-08-13 duplicate-initializer merge that passed the JS gate and failed to compile Swift.  Compile-only CI would have caught that one; it still would not catch a Swift *logic* regression.

**User / outcome impact:** Money-path Playwright and iOS desk/policy tests can fail after merge.  The documented Swift compile trap is only half-closed.

**Improvement:** Path-filtered `xcodebuild test` on the Mac runner when `ios/**` changes.  One Playwright smoke (login shell or health) on `verify`, or a required `e2e-smoke` job.  Optional `scripts/verify-ios.sh` hooked from `land.sh` when `ios/**` is in the diff.

#### F-DX-3 — Union-merge handoff files are a knowledge hazard

**Severity:** Medium  
**Evidence:** `.gitattributes` sets `merge=union` on `STATUS.md`, `PLAN.md`, `docs/EFFORT-LOG.md`.  `PLAN.md:62-77` already warns that union-merge *interleaves* concurrent edits so a heading can wear another agent’s body.  Sizes at audit: `STATUS.md` 2014, `PLAN.md` 2224, `EFFORT-LOG.md` 4475, `AGENTS.md` 780, **1154** rollout notes.  `STATUS.md` still contains a 2026-08-07 “Current” block after 2026-08-17 headers.  `AGENTS.md` retires previews then later documents `cursor.jays.services` port 4103.

**User / outcome impact:** Every session re-derives state.  Stale preview / FilingAPI lines cause wrong actions even when binding rules say otherwise.  Effort-board GitHub mirrors stay `in-progress` after merge (F-DOC-2).

**Improvement:** Keep `STATUS.md` to one “Current” block (≤200 lines); archive the rest.  `PLAN.md` entries older than ~30 days → `docs/plan-archive/`.  Delete the preview hostname table from `AGENTS.md`.  Do not disable union-merge without an owner call — it exists to unblock auto-merge.

---

### Test architecture

#### F-TEST-1 — Serial suite + no coverage + holiday-forced calendar

**Severity:** Medium  
**Evidence:** `vitest.config.ts:31` `maxWorkers: 1`.  `env.AGENTIC_TEST_FORCE_TRADING_DAY: "1"` (`:42-43`) forces `isTradingDay()` true (`src/lib/market-calendar.ts:93-106`).  No `coverage` script; `eslint.config.mjs` ignores `coverage/**` but nothing generates it.  Congress 60-day fixtures already aged out once (`test/web-sources.test.ts:227-228`, 2026-08-15).

**User / outcome impact:** Full gate is slow, so people skip it.  Scheduler/holiday bugs cannot fail CI.  Coverage regressions are invisible.  Rolling-window fixtures will flake again.

**Improvement:** Shared `recentMdY()` / frozen-clock helper as the only legal way to write windowed dates.  One CI job with `AGENTIC_TEST_FORCE_TRADING_DAY` unset against a fixture calendar.  Non-blocking `@vitest/coverage-v8` baseline.  Profile the slowest files before raising `maxWorkers`.

#### F-TEST-2 — “Money-path” tests mock the broker and RAG

**Severity:** Medium  
**Evidence:** `test/strategy-money-path-f-g.test.ts` and `test/e2e-money-path.test.ts` mock `@/lib/vector-db` and use `getTestGateway`.  Alpaca penny rounding, socket death, and bracket stripping live in isolated suites, not through `runStrategyOnce` + a real gateway class.

**User / outcome impact:** The path that moves money is the one least like production.  Adapter bugs pass unit tests and fail live (the 2026-08-16 Alpaca `24.865` → 422 class).

**Improvement:** One recorded-HTTP fixture test per live gateway (`executeProposal` → Alpaca / Tradier / Robinhood MCP) with the LLM stubbed.  Keep `TestBrokerGateway` for the bulk suite.

---

### Observability

#### F-OBS-1 — One public `/api/health` serves liveness, budget, and autonomy

**Severity:** Medium  
**Evidence:** `app/api/health/route.ts:42-58` — 503 on critical DB/dependency failure can restart the container; a spurious 503 re-halts autonomy.  Trading liveness is degraded-only (never 503).  Low OpenRouter credits flip `dependencies.openrouter.ok=false` but never 503.  External monitors have already paired deploy 503s with a “credits low” keyword (`docs/rollouts/2026-08-14-stale-quotes-origin-timeouts.md`).  OpenRouter is documented as the single LLM+embed choke (`src/lib/openrouter-credits.ts:3-8`).

**User / outcome impact:** The owner is paged for the wrong failure class.  A restart-me signal and a spend signal share a URL.

**Improvement:** Liveness (200/503) vs readiness JSON flags.  Document UptimeRobot against JSON paths, not status + keyword.  #2798 (FilingAPI mute) is related noise, not this split.

#### F-OBS-2 — Traces exist for Langfuse; users never get a support id

**Severity:** Medium  
**Evidence:** `src/lib/observability.ts:47-74` starts OpenTelemetry **only** when Langfuse is configured.  `app/global-error.tsx` / `app/error.tsx` show Next `error.digest` on root crashes only.  API 4xx/5xx bodies are bare `{ error: "..." }`.  `/api/ops/snapshot` is token-gated and excellent for agents — not for a phone screenshot.

**User / outcome impact:** “Approve hung” / “run failed” cannot be joined to Sentry, audit, or ops snapshot without archaeology.

**Improvement:** Short `ref` on every API error; echo it in console/iOS toasts.  Structured JSON logs on money-path boundaries (`runId`, `accountId`, `ref`).  Leave Langfuse as the LLM trace sink.

---

### Vendor lock-in and cost

#### F-VEN-1 — Pinecone trial ends 2026-08-30; storage — not WU — is the cliff

**Severity:** Critical (calendar)  
**Evidence:** `src/lib/pinecone-trial-window.ts:17-28` — trial ends `2026-08-30T00:00:00.000Z` (13 days from this audit).  Post-trial snap: 60k WU/day, 1.6M monthly.  Design `docs/designs/2026-08-16-proposer-corpus-storage.md` says the binding constraint is **storage (~250k records)**, not daily WU; the index is already far above free-tier storage.  #2799 fixed the false Starter-2M breaker.  #2800 is the 15-WU remainder deadlock.

**User / outcome impact:** After 2026-08-30, either paid Pinecone storage, aggressive prune, or Green/Red retrieval degrades.  A WU-only plan misses the bill.

**Improvement:** Ops-gated record count on `/api/health`.  Land proposer-corpus split (rev 3) before the snap.  Owner pick: pay Standard, prune to highlights, or accept retrieval loss.  Watch #2800.

**Already tracked?** Design yes.  Calendar owner decision not closed.

#### F-VEN-2 — OpenRouter is a single prepaid fuse for think + embed

**Severity:** High  
**Evidence:** `src/lib/openrouter-credits.ts:3-8` states it: every LLM call **and** all RAG embedding.  Health exposes balance for an external watchdog; there is no in-app failover.  `USAGE_BUDGET_ENFORCE` remains default-off (`docs/FEATURE-ENABLEMENT-BACKLOG.md:36`).  `src/lib/llm-usage.ts:117-143` prices unknown models at `$15/1M` (better than the old $0 hole) but the table is hand-maintained.

**User / outcome impact:** One exhausted prepaid balance stops strategy, chat, post-mortems, and ingest together.  That incident already happened (Voyage RCA, 2026-07-18).  Unpriced new slugs still drift the ledger.

**Improvement:** Weekly diff of `MODEL_PRICE_PER_M` against the OpenRouter catalog.  Credit-*slope* alert, not only a $3 floor.  Keep a tested non-OpenRouter embed path (`RAG_EMBED_PROVIDER`).  Owner decision on `USAGE_BUDGET_ENFORCE` — advisory-in-prompt matches product philosophy better than a hard skip.

#### F-VEN-3 — ROIC Individual window + one Hetzner box + SQLite writer

**Severity:** Medium  
**Evidence:** STATUS 2026-08-16: “couple of weeks left” on ROIC Individual; harvest persists to `earningscalls_transcripts` first.  Single host `<PROD_ORIGIN_IP>` runs ST + CT + UM + Coolify (AGENTS.md).  `src/lib/db.ts` WAL + 60s busy_timeout; dispatch requires `BEGIN IMMEDIATE`.  Litestream L2/L3 wedge from dual-writer rolling deploys is an owner residual.

**User / outcome impact:** Individual expiry ends transcript *depth* if the local archive is incomplete.  One box failure takes trading, peer apps, and the control plane.  SQLite write storms still get mislabeled as vendor outages when classification regresses.

**Improvement:** Finish the harvest cursor before the Individual expiry date.  Keep `local-db-fault-classification.test.ts` in the required gate.  Write a one-page restore RTO (Litestream L9 + R2 weekly) that assumes the Coolify box is gone, not just the container.

---

### Documentation and knowledge continuity

#### F-DOC-1 — Binding rules and live state live in the same overflowing files

**Severity:** Medium  
**Evidence:** `AGENTS.md` is 780 lines of durable rules *plus* retired preview tables *plus* host history.  `STATUS.md` / `PLAN.md` are append-only union-merge logs.  1154 rollout notes.  Agents are required to read all of them before non-trivial work.

**User / outcome impact:** Token burn and stale-action risk.  This is a bus-factor problem: the owner is the only person who knows which paragraph is still true.

**Improvement:** `AGENTS.md` = durable rules only (already the stated intent).  Move host/IP history to `docs/ops-host.md`.  `STATUS.md` = snapshot.  Rollouts stay chronological.  A generated “last 7 days” index would beat another hand-written Current block.

#### F-DOC-2 — Effort-board GitHub mirrors and leftover issues outlive the work

**Severity:** Medium  
**Evidence:** Open issues #2774, #2789, #2752 describe work already on `main`.  Planned-bucket issues #1154–#1158 are multi-row leftovers.  The 2026-08-17 hygiene pass moved some rows; the GitHub mirror lag remains.

**User / outcome impact:** The next audit (and this one, until `gh` was checked) will re-open finished work.

**Improvement:** Mirror job should close `state:completed` issues when the EFFORT-LOG row moves.  Human/agent closeout: if the PR is merged, close the product issue in the same session.

---

### Code quality (maintainability, not style)

#### F-CQ-1 — Megamodules and warn-only `any` on the money path

**Severity:** Medium  
**Evidence:** `strategy.ts` 7689, `vector-db.ts` 7718, `data-providers.ts` 7003, `db.ts` 4759 (schema + migrate still concentrated).  Schema is at migration **83**.  `@typescript-eslint/no-explicit-any` is **warn** (`eslint.config.mjs`).  `db.ts` barrel split (2026-06-21) is the successful pattern; `strategy.ts` is only partially extracted.

**User / outcome impact:** Merge conflicts, review fatigue, and “where do I change X?” scale worse than the test count.  Warnings do not fail CI.

**Improvement:** Continue the barrel split for `strategy.ts` (prompts / execution / LLM loop).  Promote `no-explicit-any` to error for `src/lib/{broker,policy,db-execution}*`.  Do not boil the ocean.

#### F-CQ-2 — Schema migrations are one-way under auto-deploy

**Severity:** Medium  
**Evidence:** `src/lib/db.ts:3224-3251` applies `user_version` upward inside `BEGIN IMMEDIATE`.  No `migrateDown`.  Auto-deploy on every `main` push (2026-07-10).  A bad migration 84 ships with the next squash merge and cannot be reversed in place.  Rolling deploy already crash-looped incoming containers on migration 72 (comment at `:3241-3246`).

**User / outcome impact:** The blast radius of a schema mistake is “restore from L9 / weekly R2,” not “revert the PR.”

**Improvement:** Expand-contract migrations only (add nullable, backfill, then constrain).  Document “no destructive ALTER on the same PR that starts reading the new shape.”  A dry-run `user_version` check in CI against a copied prod schema would catch the next 72.

---

### Additional domains conventional reviews skip

#### F-OPS-1 — No market-hours change freeze

**Severity:** Medium  
**Evidence:** Auto-deploy is on.  Coolify rolling can run two Litestream writers (empty-tier wedge RCA, 2026-08-14).  Merges land through RTH when `verify` flips green.  There is no “do not deploy 9:30–16:00 ET” latch.

**User / outcome impact:** A docs-only merge is harmless.  A migration or scheduler change during the cash session competes with Autopilot for the SQLite writer and can re-halt autonomy on a 503 restart.

**Improvement:** Owner latch: block Coolify deploys during RTH except `HOTFIX=1`, or require `do-not-automerge` on money-path PRs until the close.  This is process, not a new feature.

#### F-OPS-2 — Account deletion erases the tax-year record

**Severity:** Medium  
**Evidence:** `src/lib/account-deletion.ts` `DELETE_TABLES_BY_USER_ID` includes `fill_events`, `trade_proposals`, `portfolio_snapshots`, `strategy_runs`.  Coverage tests ensure new user-scoped tables get deleted.  There is no Form 8949 / lot-history export.  Privacy §6 retains data “as needed to comply with legal obligations” but the implemented path is wipe.

**User / outcome impact:** GDPR-style erasure and US tax-record retention (typically years, not days) are in tension.  A user who hits typed-delete loses the only in-app lot history.  The broker may still have fills; the desk will not.

**Improvement:** Export-then-delete: CSV of fills / lots / wash-sale annotations before wipe.  Retention hold flag for the primary operator.  Do not silently keep data after delete.

#### F-OPS-3 — Supply-chain and license inventory is Apache-2 + implicit npm

**Severity:** Low  
**Evidence:** Root `LICENSE` is Apache 2.0.  No `license-checker` / SBOM in CI.  Fleet already hit `congress-trading-shared` lockfile-vs-manifest drift (2026-08-06 review A/B1).

**User / outcome impact:** A copyleft or unlicensed native addon can land via a routine bump.  App Store and any future distribution care.

**Improvement:** CI assert that `package-lock.json` resolved tags match `package.json` pins (shared package).  Periodic license allow-list.  Not urgent for a private desk.

#### F-OPS-4 — FINRA 26-10 is acknowledged; broker phase-in is not modeled

**Severity:** Low  
**Evidence:** `src/lib/policy.ts:534-547` enforces a static $2,000 margin minimum and explicitly defers broker-specific intraday margin through 2027-10-20.  PDT count still exists in `db-execution.ts` for brokers that have not phased in.

**User / outcome impact:** A live margin account can pass the app gate and still be rejected or restricted by the broker during the 26-10 phase-in.  The code is honest; the UI may not surface “broker may still apply PDT/intraday rules.”

**Improvement:** One sentence on the account capabilities sheet when `marginEnabled`.  No second PDT engine.

---

## 5. Cross-cutting second-order risks

These are not extra bugs.  They are how the findings compound.

1. **Calendar cluster (next 2–3 weeks).**  Pinecone trial snap (2026-08-30), ROIC Individual expiry (“couple of weeks” from 2026-08-16), and Litestream L2 residual all land in the same window.  Treating them as three separate agent tickets will thrash the box.
2. **Legal posture vs product philosophy.**  The owner accepts 100% trading risk and rejects paternalism.  That does **not** remove clickwrap, in-app disclaimers, or Privacy completeness.  Those protect *enforceability and App Review*, not the owner from himself.
3. **Single prepaid fuse + single box + auto-deploy.**  OpenRouter credits, Hetzner, and merge-to-live are three single points.  Health 503 that restarts the container turns a monitor false-positive into a trading halt.
4. **Docs as a fourth runtime.**  Union-merge logs plus 1154 rollouts mean agents implement against stale FilingAPI / preview / 2M-WU sentences unless they `gh`-check first.  This audit’s method (live issues/PRs) should be the default, not a special review.
5. **Coach vs Green inversion.**  The non-trading chat is disclaimer-versioned; the trading loop is not.  That is the finding a conventional UX review will keep missing because the console *looks* careful.

## 6. Suggested next actions (not this PR)

Do not open ten fix PRs from this list.  Suggested order if the owner wants follow-through:

| Priority | Action | Closes |
|----------|--------|--------|
| 1 | Owner: Pinecone post-trial (pay / prune / accept loss) + finish ROIC archive | F-VEN-1, F-VEN-3 |
| 2 | Clickwrap + console/iOS legal strip + strategy-prompt sentence | F-LEG-1, F-LEG-2, F-LEG-7 |
| 3 | `land.sh` lint + Cloud Node 22; iOS `xcodebuild test` when `ios/**` changes | F-DX-1, F-DX-2 |
| 4 | Health liveness vs budget split; error `ref` on API + toast | F-OBS-1, F-OBS-2 |
| 5 | Settings field errors; skip link | F-A11Y-1, F-A11Y-2 |
| 6 | Privacy counsel pass + data-pool default false for unset users | F-LEG-3, F-LEG-4 |
| 7 | STATUS/AGENTS trim; close stale GitHub mirrors | F-DOC-1, F-DOC-2, F-DX-3 |

Leave #2794 / #2795 / #2800 / #2798 to their existing branches.

## 7. What already looks solid (so this is not a dunk)

- Terms §2 and Privacy §1 already say not investment advice, not RIA, not broker-dealer.
- Coach disclaimer is versioned and server-enforced.
- Tax UI repeats “not tax advice.”
- Paper vs live labeling is honest (`PAPER` / `BROKERAGE`).
- 13F/Form 4 ingest is observe-only in the catalog.
- Account deletion has runtime schema coverage tests.
- Temp DB hygiene (`agentic-vitest-*` + 6h sweep) fixed a real disk leak.
- Lease-lost must not page as Pinecone (`test/local-db-fault-classification.test.ts`).
- `/api/ops/snapshot` is the right cloud-agent diagnostic.
- Notify skips paid Resend when Pushover can deliver.
- Display timestamps are DST-safe Central Time (owner ruling, implemented via `Intl`).
- FINRA 26-10 is named in policy instead of pretending PDT still rules every broker.
- Sentry session replay stays default-off and masked.

## 8. Files used as evidence (read-only)

`app/login/page.tsx`, `app/welcome/page.tsx`, `app/terms-and-conditions/page.tsx`, `app/privacy-policy/page.tsx`, `app/console/layout.tsx`, `app/console/lib/format.ts`, `app/console/ui/primitives.tsx`, `app/console/ui/toast.tsx`, `app/console/components/shell.tsx`, `app/console/settings/page.tsx`, `src/lib/db-settings.ts`, `src/lib/defaults.ts`, `src/lib/policy.ts`, `src/lib/chat/prompt.ts`, `src/lib/strategy-prompts.ts`, `src/lib/account-deletion.ts`, `src/lib/pinecone-trial-window.ts`, `src/lib/openrouter-credits.ts`, `src/lib/llm-usage.ts`, `src/lib/observability.ts`, `src/lib/db.ts`, `src/lib/market-calendar.ts`, `src/lib/dormant-features.ts`, `app/api/health/route.ts`, `vitest.config.ts`, `scripts/land.sh`, `.github/workflows/ci.yml`, `.github/workflows/ios-build.yml`, `.gitattributes`, `ios/SocraticTrade/LoginView.swift`, `ios/SocraticTrade/AppTypography.swift`, `docs/FEATURE-ENABLEMENT-BACKLOG.md`, `LICENSE`.

## 9. Zero-code findings

No production code was changed.  Outcome: a dated blind-spots register with live GitHub cross-checks, written so the next agent can pick a row without re-deriving the panel.
