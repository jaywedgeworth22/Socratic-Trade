# Handoff: Socratic-Trade post-Codex/AG audit + app evaluation → MONET

- **From:** CLAUDE (Fable/Opus), isolated worktree branch `claude/adoring-hopper-4ff51e`
- **To:** MONET
- **Date:** 2026-07-15
- **Owner directive:** evaluate the app after Codex/Antigravity changes; ensure their
  improvements are merged to production; find UI/UX and framework/backend improvements;
  keep the effort board honest; verify `congress-trading-shared` currency and API-Usage-Monitor
  integration; ensure every worktree with helpful work is merged.
- **Method:** two multi-agent workflows (branch-disposition + board/integration audit over 73
  branches; a 5-lane app evaluation with adversarial per-finding verification). All findings
  below are ADVERSARIALLY VERIFIED against `src/` unless explicitly marked otherwise. Product
  philosophy respected throughout: advisory guardrails only, no paper-mode, no hard blocks,
  account boundary is the one hard rule.

---

## 0. State at handoff (all VERIFIED this session)

- **Production is current and healthy.** `socratictrade.com/api/health` = `main@294694ae`
  (== origin/main HEAD), DB ok, scheduler leased + ticking (~4s age), litestream replicating
  (1s age), all providers green (massive/fmp paid, pinecone, voyage, tiingo, twelvedata,
  yahoo, usage-monitor). No zombie deploys in the Coolify queue.
- **No open PRs on Socratic-Trade.** Every Codex/AG PR through #1624 is merged and auto-deployed.
- **`congress-trading-shared` is current on BOTH consumers.** Socratic-Trade and Congress.Trade
  both pin the identical shared commit `0bc26ab9` = shared `main` HEAD = v1.7.1. No drift.
- **Effort boards** reserved (Socratic live `/Users/jay/apps/TRADING-EFFORT-LOG.md` + repo
  mirror `docs/EFFORT-LOG.md`) with an In-Progress row for this sweep; agent-sync claim posted.

### Two fixes already LANDED by CLAUDE this session (no action needed from you)

1. **Congress.Trade `Shared package pin check` false-positive → [PR #450](https://github.com/jaywedgeworth22/Congress.Trade/pull/450) MERGED.**
   The check was red on `main` since 2026-07-13 (Sentry FLEET-INFRA-16/-C/-3C) — a false
   positive: both repos pin the same shared commit, but CT's lockfile records it via `git+ssh://`
   and ST's via `git+https://`, and the check compared raw `resolved` strings. Fixed by
   normalizing to the ref after `#`. Real ref divergence still fails; registry versions pass
   through. Rollout: `Congress.Trade/docs/rollouts/2026-07-15-pin-check-transport-normalize.md`.
2. **`agent-sync-push` pm2 crash-loop repaired.** It had been crash-looping ~877k times for a day
   (`MODULE_NOT_FOUND: ws`) because the disk-janitor reaped its `node_modules`. Reinstalled deps,
   dropped a `.janitor-keep` marker to stop recurrence, restarted — now `slack: hello (connected)`.
   (This is fleet infra, not repo code; noted so you don't re-diagnose it. Sentry FLEET-INFRA-3A/-3B.)

---

## 1. Branch merge dispositions — "is every helpful worktree merged?"

**73 branches audited** (37 recent + 36 older). Bottom line: **main is not missing any
squash-merged PR content** — the "ahead of main" branches are overwhelmingly squash-merge
artifacts or superseded duplicates. But a **small set of genuinely-unmerged-valuable** work
exists. Nothing here is a regression risk to leave unmerged; these are opportunities.

### 1a. UNMERGED-VALUABLE / owner-decision branches (recent) — candidates to re-land

| Branch | What main lacks | Recommendation |
| --- | --- | --- |
| `codex/autofix-rag-limits-fix` (no PR) | Single commit removes a **factually false "Quiver Quant API Integration" completed-work claim** from `STATUS.md` + `docs/EFFORT-LOG.md` (falsely attributed to `agent/antigravity`). The Quiver provider was never built (confirmed in §3 data-streams: the Quiver* carrier fields have no producer). | Re-apply the STATUS/EFFORT-LOG correction on a fresh branch off main (old commit won't cherry-pick clean). **Do this together with the data-streams Quiver finding** so the docs and the code truth match. Low effort. |
| `ag/codex-autofix-1476` (no PR) | 4 of 5 accessibility fixes absent from main: missing `label`/`aria-label` on 3 `<Toggle>` instances in `app/console/settings/page.tsx` (Require-typed-confirmation, per-event notif toggles) + one layout fix. (Skip its 5th hunk — a color-token change already superseded by #1535.) | Land the 4 fixes as a fresh small PR. Low effort, real a11y win. |
| `ag/loading-animation` (PR #1246 CLOSED) | Only the loading piece is unlanded: `HeaderLogo({ speedMs })` configurable tick-speed prop + its use in `shell.tsx` `LoadingBrand`. Its SSE half is redundant with the merged #1339 and would regress. | **Owner decision** — cosmetic. If wanted, cherry-pick ONLY the `HeaderLogo`/`LoadingBrand` hunk, not the branch. |
| `agent/ag-update-status-effort-log` | ~95% superseded (order-replacement state machine, congress-share retry, Apple sign-in, login/header-logo redesign all landed via #1492). Small residual only. | Treat as SUPERSEDED; no separate land needed. Verify header-logo overlap is fully on main (it is, per #1492 file list). |
| `ag/sse-deadlock-fix` (no live PR) | Its STATUS/EFFORT-LOG/rollout content is stale; SSE fix itself superseded. | Confirm nothing unique remains, then it's a leftover. Low priority. |

### 1b. FLAGGED older branches — real unmerged features, never PR'd (2026-07-04, need rebase)

These three were tracked as "genuinely unlanded sub-lanes" on the effort board through
2026-07-05, then the tracking trail went cold — abandoned mid-landing-train, not deliberately
rejected. **They overlap with the RAG/learning findings in §4 — coordinate.**

- **`claude/w2-coaching-durable`** — adds a `socratic_coach_note_archive` table +
  `archiveCoachNotes`/`listArchivedCoachNotes`, **replacing the current silent `.slice(-20)`
  truncation** in `appendSocraticDecisionCoachNote`. **CONFIRMED: main still silently drops
  coach notes at `src/lib/db-socratic.ts:308` with no archive — real, unaddressed gap today.**
  Touches `performance.ts`, `counterfactual-learning.ts`, `market-calendar.ts`, `socratic-memory.ts`.
- **`claude/w2-reflection-decompose`** (3009 insertions, 37 files) — decomposes the one-blob
  reflection into discrete regime/thesis-conditioned lesson rows in `learned_context`, each
  embedded as a retrievable `doc_type="lesson"` vector (reuses already-merged episodic-retrieval
  machinery). Includes `test/reflection-decompose.test.ts` (283 lines, absent from main). This is
  the **producer** for one of the two orphaned episodic doc types flagged in §4.
- **`claude/delegation-standard-docs`** — adds a "Delegation & model economics" section to this
  repo's `AGENTS.md`. **CONFIRMED via grep: this repo's AGENTS.md has no such section** (unlike
  the other closed docs branches whose content is already present). Low-stakes docs fix.

  > **Caveat on all three:** their base files (`db-socratic.ts`, `learned_context/store.ts`,
  > etc.) have since evolved on main (new fields `greenTeamRationale`, `sizingSnapshot`, PR #1544
  > evidence rework), so landing them is a **rebase, not a fast-forward**. Decide per-branch:
  > rebase+land, or explicitly retire and strip the now-dead `coach-note`/`lesson` retrieval
  > branches (see §4 finding on orphaned doc types).

### 1c. Everything else = SAFE TO DELETE (merged artifacts / superseded / stale)

The remaining ~65 branches are squash-merge artifacts, closed-superseded duplicates, or stale
(hundreds of commits behind, predating major refactors). A few self-documented as dead
(`agent/codex` has a "DO NOT MERGE" rollout note; `claude/nav-v2-settings-ui-restructure`
superseded by the console port; `deploy-all-completed-prs` is actively regressive vs main's
shared-package SSE client). **None carries unmerged-valuable content.** Branch cleanup is
optional hygiene, not urgent — but if you prune, the full SAFE-TO-DELETE list is in the audit
workflow journal (see §7 for the path). Do NOT delete the three FLAGGED branches in §1b or the
UNMERGED candidates in §1a.

---

## 2. Effort-board hygiene — corrections to apply

Auto-deploy is ON (merge==production since 2026-07-10), so a merged PR's row should read
Completed/Deployed, not In-Progress. Audit of 54 CODEX/AG PRs merged since 2026-07-11 found:

**(a) Merged PRs with NO board row at all:**
- **PR #1482** "strategy deduplication and types" (`agent/ag-dedup-types`, merged 2026-07-12) — no mention anywhere.
- **PR #1614** "record final PR coordination cleanup" (`codex/final-coordination-cleanup`, merged 2026-07-15) — no row of its own.

**(b) Stale In-Progress/Planned rows for PRs that ALREADY merged:**
- **#1593** decision-dissent-dedup: `docs/EFFORT-LOG.md:1751` still "FINAL LAND GATE NEXT"; live board `:1721` correctly Completed. Repo mirror never updated.
- **#1594** infisical-bootstrap: both boards stale (`docs/EFFORT-LOG.md:1759`, `TRADING-EFFORT-LOG.md:1722`) — no completed row anywhere.
- **#1604** infisical JSON-export: both boards stale (`docs/EFFORT-LOG.md:1754`, `TRADING-EFFORT-LOG.md:1718`) — no completed row.
- **#1492** exit-replacement (landed 3 sub-efforts): 4 rows on BOTH boards still "In Progress (PR pending)" (`docs/EFFORT-LOG.md:3284-3287` + live `3313-3316`); two cite **dead PR numbers** #1525/#1526 (both CLOSED unmerged; real landing was #1492).
- **TS 7.0.2** correction: `docs/EFFORT-LOG.md:48` still "IN PROGRESS" though #1578 merged (completed row already exists at `:241`; live board top row already correct).

**(c) Rows falsely claiming merged/deployed:** none found.

**(d) Mirror drift + a verbatim duplicate:**
- #1593 completion detail exists only on the live board (see b).
- `docs/EFFORT-LOG.md` lines **1752 and 1756** are the SAME stale #1587 paragraph copy-pasted twice.

**Action:** these are all append-mostly corrections (never delete another agent's row — correct
in place and note it). Recommend a single hygiene pass fixing (a)–(d) on both boards together.

---

## 3. Data-stream depth & provider coverage (9 verified findings)

**Assessment:** the provider layer is strong after PR #1618 (disciplined first-wins cascade,
per-field provenance, durable FMP quota reservations, AV key pool, negative TTLs, circuit
breaker). The dominant problem is **"built-but-unwired" at both ends** — data fetched and paid
for that never reaches the LLM prompt or factor scores.

| # | Sev | Finding | Fix (effort) |
| --- | --- | --- | --- |
| 3.1 | **P1** | **FMP price targets** fetched only when `FMP_PRICE_TARGETS_ENABLED` (default off), and even when on, `targetMean/High/Low` are persisted to `MarketQuote` but **never enter the LLM prompt or scoring**. | Enable the flag in prod; add `tgtMean` + derived `upsidePct` to `compactCandidateForPrompt`, optional `valueScore` term. (S) |
| 3.2 | **P1** | **FMP ratios-ttm quality fields** (ROE, ROA, gross margin) — PR #1618 deliberately parses them (`data-providers.ts:2631-2635`) and the doc claims they're consumed, but **nothing reads them**. | Add `roa`/`grossMargin` to prompt; prefer real `returnOnEquity` over the eps*pb approximation; add quality-score term. (S) |
| 3.3 | **P1** | **Dead carrier fields with no producer:** 5 `Quiver*` fields + `revenueGrowth` + `freeCashFlowYield` are fully plumbed (types, takeScalar, persistence) but nothing produces them — **plus a still-false STATUS.md claim that the Quiver provider landed** (ties to §1a `autofix-rag-limits-fix`). | Either implement the QuiverQuant producer (account HAS API access; gov-contracts/lobbying/patents are differentiated signals no current provider gives) OR strip the dead fields + fix STATUS. (M) |
| 3.4 | P2 | **5 FMP capability adapter modules** (`fmp-alpha/beta/gamma/delta`, 18 endpoints — analyst grades, estimates, ETF holdings, macro, treasury, congress trades, transcripts) have **zero production consumers**. *(ALREADY_TRACKED: docs/fmp-capabilities.md items 2-3.)* | Wire in priority order: `fetchFinancialScores` → FMP row; `fetchAnalystGrades` → `ratingChange7d` prompt field; analyst estimates. (M) |
| 3.5 | P2 | **No forward economic-event awareness.** Strategist sees macro LEVELS + regime + `daysToEarnings` but nothing tells it "CPI/FOMC/NFP is tomorrow." | Daily ingest of FMP `/economic-calendar` (US high-impact) into a small table; inject compact `upcomingEvents` block next to the regime label. (M) |
| 3.6 | P2 | **News sentiment = a 45-word keyword lexicon** (`scoreHeadlines`, 21 pos + 24 neg, tanh-damped). Can't handle negation/attribution/relevance. | Pass 5-8 RAW headlines (source+age) to the prompt, let the strategist read them, demote numeric `newsSent` to tie-breaker. (M) |
| 3.7 | P2 | **Alpha Vantage** contributes ONLY `NEWS_SENTIMENT`, seated after AlpacaNews (which already supplies batched sentiment), and its 25/day free cap is exhausted daily (the recurring cap alert). *(ALREADY_TRACKED: broker-capability-plan §4/§10.)* | Deregister AV when an Alpaca data key is configured (one-line at `data-providers.ts:935`) or drop it. Kills real quota + alert noise. (S) |
| 3.8 | P2 | **FMP 290/min budget reserved per-app** while the credential is SHARED with Congress.Trade — both apps can burn the same real quota. *(Partially tracked.)* | Split by env (`PROVIDER_QUOTA_FMP_PER_MIN`, e.g. 190 here / 100 CT) until dispatch accounting moves into the shared package. **This is a cross-repo coordination item — your risk lane + the Congress.Trade eval lane both touch it.** (S) |
| 3.9 | P2 | **Options IV / put-call prompt fields permanently empty** unless `ROBINHOOD_OPTIONS_ENRICHMENT_ENABLED` (off) AND a RH MCP connection align; same for SEC XBRL. | One-time owner flag review; add a startup log line listing active enrichment flags so blind spots are visible. (S) |

---

## 4. RAG use & learning mechanics (8 verified findings)

**Assessment:** the loop is **much more closed than the 2026-06-30 audit found** — realized
outcomes reach future proposals through many wired channels (thesis/regime/factor/sector/
confidence scorecards + reflection + skipped-counterfactual regret rows in the Bull/Bear prompts,
LLM post-mortem lessons → `learned_context` audited daily, a fail-closed Red Team whose vetoes
are outcome-joined, an OOS-gated revertible factor-weight auto-tuner). Two structural gaps remain:
**measurement** and **memory hygiene**.

| # | Sev | Finding | Fix (effort) |
| --- | --- | --- | --- |
| 4.1 | **P1** | **Retrieval-usefulness scoring is unwired.** Every run persists exactly which analog/coaching vector ids entered the prompts (`experience_retrieval` audit + `ragAttributions` on decision cases) explicitly "so retrieval-usefulness scoring can join later" — but **no code performs the join.** Retrieval spend is unmeasured. *(ALREADY_TRACKED: expert-review item 26.)* | Build the scheduled join over decision cases × matured multi-horizon outcomes → per-doc-type/per-memory-kind usefulness stats feeding retrieval ranking. **This is the single highest-leverage step toward a genuinely self-measuring learner.** (M) |
| 4.2 | **P1** | **Two of three episodic doc types have no writer.** `retrieveDecisionExperiences` queries `['socratic-decision','coach-note','lesson']` and reserves an OWNER COACHING prompt block for `coach-note` — but nothing writes `coach-note` or `lesson` vectors. **These are the `w2-coaching-durable` + `w2-reflection-decompose` branches from §1b, implemented 2026-07-04, never merged.** *(ALREADY_TRACKED on the board.)* | Rebase + land both branches (expect PR #1544 conflicts), OR retire them and strip the dead retrieval branches. (M) |
| 4.3 | **P1** | **Live-account closed lots never write episodic memory.** `recordClosedLotExperience` fires at fill-record time, but live fills insert as `pending_reconciliation` (not accounting fills), so **the corpus that should matter most is paper-only.** *(ALREADY_TRACKED as a known v1 gap.)* | Re-fire `recordClosedLotExperience` when a `pending_reconciliation` sell/cover flips to filled during reconciliation (idempotent via the existing `exp:` key). **Highest-value + lowest-effort learning fix.** (S) |
| 4.4 | P2 | **Counterfactual feedback is one-sided** — only missed winners (`returnPct >= 3`) are injected as regret rows (`strategy.ts:3773`); vindicated skips (avoided losers) exist in data but are never shown. The model only ever learns "you're too cautious." | Inject a balanced block: top missed winners AND top avoided losers (`<= -3`), each SPY-relative (plumbing exists), labeled. (S) |
| 4.5 | P2 | **Episodic retrieval is one portfolio-level pass** (k≤10, sketch capped at 6 candidates) shared across every decision in the run — per-decision analog coverage is thin. | After 4.1 justifies the spend: per-finalist sub-queries (thesis-tag + regime + symbol) for the 2-3 names actually being decided. (M) |
| 4.6 | P2 | **Pinecone episodic/decision memory has no staleness/decay/expiry/correction** — unlike `learned_context` (which has supersede-on-write, expiry, the daily learning-review). Bad vectors live forever at full weight. | Min viable hygiene: recency-decay term in ordering; a `tainted` metadata flag writable by learning-review verdicts. (M) |
| 4.7 | P2 | **Retrieval quality evaluated only on hand-authored offline fixtures** (mocked Pinecone/Voyage, fake reranker) — no production recall/coverage truth. *(ALREADY_TRACKED: SEC-RAG plan RAG-B11/B13-B18.)* | Let the CODEX SEC-RAG lanes land; add one small NEW piece: stamp the active retrieval flag set per decision so eval can attribute. (S) |
| 4.8 | P2 | **Chunker mis-sizes real SEC docs** — counts tokens as whitespace words (`chunk.ts:90`), recognizes only pipe-delimited tables. *(ALREADY_TRACKED: RAG-B04/B05.)* | Land the RAG-B04/B05 lane; apply tokenizer-aware sizing in the SHARED chunk/embed path so decision/experience docs benefit too. (M) |

---

## 5. UI/UX & intuitiveness (4 verified findings)

**Assessment:** unusually mature — the 55-finding 2026-07-05 expert-panel audit is ~37 landed,
the "Decisions" nav collision is resolved, the decision-trace page explains what/why/dissent
well, a11y basics are solid. New issues found by direct inspection:

| # | Sev | Finding | Fix (effort) |
| --- | --- | --- | --- |
| 5.1 | **P1** | **Root `global-error.tsx` is hardcoded light-only** (`background:#f8fafc`, black button, no `prefers-color-scheme`). It replaces `<html>/<body>` so it can't use the theme systems. Dark is the default (`theme.tsx:14`), so a dark-mode user hitting a root crash gets a jarring white flash at the worst moment. **Exact mirror of the previously-fixed dark-only P0, in a file never touched for theme.** | Add an inline `<style>` with a `@media (prefers-color-scheme: dark)` block. Dependency-free. (S) |
| 5.2 | P2 | **Admin operator hub (`app/admin/*`, added 2026-07-06 after the audit) is a THIRD disconnected theme system** — legacy `ui` glass tokens, driven by the root `.dark` key, NOT the console's `console:theme`. If the owner sets a console theme differing from OS, `/admin` won't follow it — and can't, because the only `ThemeToggle` writing the root key is **orphaned dead code** (zero consumers, casualty of the /old dashboard deletion in #1018). | Port `/admin` to `con-*` tokens (inherits `console:theme`), OR render a working `ThemeToggle` on `/admin`. (M) |
| 5.3 | P2 | **Alert Center notifications have no link to the decision trace** that explains them. `NotificationEvent` (`types.ts:2293-2309`) carries no `decisionId/caseId`, and `alert-center.tsx:255-320` renders no `Link` to `/console/decisions/[id]` — even though the console home decision feed does. The surface most likely to prompt "why did this happen?" can't answer it. | Thread the originating decision/case id (available server-side when the event is written) into `NotificationEvent`; render a "View decision" link. (M) |
| 5.4 | P2 | **NAV_V2 IA redesign stalled 2 weeks** — owner-approved 11-section spec, PRs #1-8 landed inert plumbing (`nav-destinations.ts`, `settings-search.ts` fully unwired), then stopped. Current nav is still a 13-item thematically-labeled flat list. *(ALREADY_TRACKED: docs/settings-navigation-redesign/, PLAN.md:1050-1091.)* | Highest-leverage already-designed step: resume at PR #9 (nav shell) rather than start new IA work. (M-L) |

---

## 6. Backend / API / persistence hardening (2 verified, 1 refuted)

**Assessment:** notably mature — `middleware.ts` fail-closed edge auth gates every non-public
route (post-IDOR), all 13 admin routes use constant-time `requireAdmin()` with no env bypass,
webhooks use timing-safe HMAC, migrations are transactional/versioned, field encryption fails
closed, and the high-risk short/cover notional/PDT/P&L accounting is correct and well-tested.

- **P2 (CONFIRMED, NEW):** **TradingView webhook has no request-body size cap**, unlike its
  sibling congress webhook. It's reachable unauthenticated (`/api/webhooks` is public; the only
  default-on gate is a secret inside the JSON body, checked AFTER the body is read). Add the same
  content-length pre-check the congress webhook has; consider a shared helper. (S)
- **P2 (REFUTED):** a claim that account deletion never revokes bridge-published Gemini/DeepSeek
  keys was **narrower than stated** — `account-deletion.ts`'s `DELETE_TABLES_BY_USER_ID` sweep
  DOES delete `user_api_keys`. The residual (the Infisical bridge copy isn't proactively
  tombstoned on delete) is minor and the writer is default-off. Not a priority.

### 6b. Autonomous-loop & framework robustness (11 findings; P0 spot-verified by CLAUDE)

**Assessment:** the money-path *mechanics* are mature and well-tested — CAS single-leader lease,
boot autonomy interlock, crashed-run sweep, per-account run locks + re-entrancy guards,
broker-truth-first fill reconciliation with idempotency keys, opt-in Green AND Red failover
chains, durable usage-replay watermark, a real liveness probe. **The concentrated weakness is
that the loop is bad at making its own silence visible** — it halts on deploy, can stall without
paging, can starve on LLM quota without a distinct state, and can leave fills/notifications stuck
without escalation. Closing the observability-of-stalls gaps (6b.1/6b.2/6b.3/6b.7) raises effective
uptime more than any algorithmic change. None of the fixes remove owner control or add hard blocks.

> These findings came from a single self-skeptical Opus pass (not the adversarial-verify sub-pass
> the other lanes got). CLAUDE independently spot-verified the P0 against `src/` — confirmed exactly
> as stated. Treat P1s as high-confidence-but-unverified; MONET should confirm each before landing.

| # | Sev | Finding | Fix (effort) |
| --- | --- | --- | --- |
| 6b.1 | **P0** | **Every auto-deploy silently halts autonomy, with no owner notification.** `reconcileAutonomyOnBoot()` (`scheduler.ts:284-315`) reverts every `systemState:"active"` account to `"halted"` on process start unless per-user `autoResumeOnBoot` (default **false**, `db-settings.ts:288-289`) or `AUTONOMY_RESUME_ON_BOOT=1` is set — and it only writes `audit("autonomy_halted_on_boot")`, **no `sendNotification`** (CLAUDE-CONFIRMED). Since merge==auto-deploy==new container, **every merge to main silently turns the live bot off** and requires manual re-arm; 3 deploys happened 2026-07-15. The interlock is a legitimate owner safety feature — the defect is its unmanaged interaction with auto-deploy + zero signal that it fired. | Keep the interlock. (a) **Push-notify** on `autonomy_halted_on_boot` ("re-arm in Settings"); (b) distinguish operator deploy-restart (SIGTERM graceful marker → safe resume) from crash-loop (halt); (c) ask owner whether to just enable `autoResumeOnBoot` in prod now that auto-deploy is on. **Highest-leverage uptime fix.** (S/M) |
| 6b.2 | P1 | **No enabled dead-man's-switch for silent scheduler death.** The only push watchdog (Sentry Crons) is double-gated off (`SENTRY_DSN` + `SENTRY_CRONS_ENABLED=1`, both blank in `.env.example`); `/api/health` computes `schedulerStale`→503 but nothing polls it post-PM2-retirement. A wedged scheduler either goes unnoticed OR gets Coolify-restarted into a halted state (feeds 6b.1). | Enable Sentry Crons in prod (code exists, safe), OR add an external probe (CF Worker/uptime) paging via the existing PagerDuty MCP when `schedulerAgeSeconds` exceeds threshold. (S/M) |
| 6b.3 | P1 | **Pending-fill reconciliation never escalates aged-out orders.** `reconcilePendingFills` resolves a fill only if the broker still lists the order; on no match it `continue`s (`strategy-execution.ts:1232-1234`). Robinhood deliberately leaves `ordersListIncludesTerminal` false (`robinhood.ts:182`), so a RH order that executed but aged out of the window is **stuck at `pending_reconciliation` forever** — position/P&L understated, no age-based escalation. (This is also what blocks live episodic memory in §4.3.) Distinct from the #1420 "placing"-proposal fix. | On absent order + `ordersListIncludesTerminal !== true`, fall back to `getEquityPositions` to infer execution (position delta is truth); add age-based escalation (audit + notification) for any fill pending beyond N min. (M) |
| 6b.4 | P1 | **No provider-health-aware LLM cooldown — quota exhaustion is rediscovered every run.** Green/Red failover chains iterate fallbacks in order every run with no cross-run memory that a provider just 429'd; the circuit breaker is wired to DATA providers only, not LLM calls. On 2026-07-15's multi-provider exhaustion this wasted attempts/latency each run and produced no distinct "all providers exhausted / autonomy data-starved" state. Hard `insufficient_quota` 429s are treated identically to transient ones. | Short-lived per-provider LLM cooldown keyed on 429/quota (reuse `api-circuit-breaker`); distinguish billing 429s (already detected `llm-errors.ts:104`); one throttled "all LLM providers exhausted" alert when all are cooling. (M) |
| 6b.5 | P2 | **`run_failed` notifications are un-throttled; no consecutive-failure escalation.** Every failed run notifies once per cadence per account (alert fatigue during an outage), and there's no "N consecutive failures / no completed run in M cadences" escalation. (Ties to the notification-noise fixes already in-flight on `claude/todays-app-errors-716a45`.) | Per-(account,type) cooldown for `run_failed` + a separate escalation at K consecutive failures. (S) |
| 6b.6 | P2 | **Red Team fail-closed is a SPOF for autonomous *openings* during provider outages.** By owner design (R11) a failed/unavailable Red Team routes openings to human approval — correct for a blip, but in a multi-provider outage all autonomous openings halt even if Green succeeded. `redTeamFallbackModels` helps only if configured across INDEPENDENT providers (same-family fallbacks exhaust together; independence is nudged, not enforced). | Keep fail-closed. Surface a Settings warning when Green's + Red's providers share a family; emit one throttled alert when openings are mass-blocked by Red-unavailable. (S) |
| 6b.7 | P2 | **Heartbeat proves tick-function liveness, not trading liveness.** The heartbeat/abdication only detects DB-write failure; a scheduler that keeps ticking but whose runs never complete (persistent LLM/broker failure) keeps `/api/health` green while producing zero completed runs for hours. No signal derived from "last completed run age" or consecutive failures. | Add a "trading liveness" dimension to `/api/health`/ops snapshot: age of most recent COMPLETED run per active account + consecutive-failed counter, as `degraded` (not 503, to avoid the restart→halt loop). (S/M) |
| 6b.8 | P2 | **`tick()` has no whole-tick overlap guard.** `setInterval(tick, TICK_MS)` doesn't await tick; a tick exceeding 60s (multi-step LLM runs take 150s+) lets a second concurrent tick start. Critical side effects are guarded (run locks, single-flights), but several fire-and-forget maintenance passes (`checkAllUserPriceAlerts`, `refreshDueWebSources`, `drainMaterialEventQueue`) are not. | Add a `tickInFlight` guard at the top of `tick()` so overlapping ticks coalesce. Cheap insurance. (S) |
| 6b.9 | P3 | **Notification pushes lack durable replay across a mid-delivery restart.** `notify` has in-process bounded retry only; a deploy-restart mid-delivery drops in-flight pushes (kill-switch, run-failed). The in-app `notification_events` row persists, so it's low urgency, but time-sensitive pushes can be lost silently — unlike the usage ledger's durable outbox. | For high-priority types, record a delivery-outbox row on final failure and replay on next tick (reuse usage-replay pattern). (M) |
| 6b.10 | P3 | **Single-leader lease TOCTOU window** (documented, `scheduler-lease.ts:6-11`). Mitigated by TTL+steal + in-flight guards; on single-container Coolify prod effectively one process. *(ALREADY_TRACKED.)* | Accept as-is for single-container; revisit only if prod runs >1 replica. (L if ever) |
| 6b.11 | P3 | **Observability + multi-account isolation verified STRONG** (reported so they're not re-flagged). WHY-a-trade traceability is good locally (proposals persist rationale/regime/thesis/model + Red review; audit events; strategy_runs). Isolation is correct (per-account locks/caps/schedule/reconcile). Two minor notes: successful-run `llmSteps` timeline goes to Langfuse (external), not the local DB, so a fully-offline "replay the inputs the model saw" isn't possible; and `scopeAccount` collapses blank `account_number` to a shared `__unassigned__` bucket (safe today, latent risk if an account row ever lacks a number). | Optional: persist a compact per-run decision trace (served model + step reasons + evidence-pack hash) to the DB so WHY-analysis survives without Langfuse. (M, optional) |

---

## 7. API-Usage-Monitor integration

**Verdict: DEGRADED** (not broken — core plumbing is solid and correctly gated, but there's a
confirmed real-dollar double-counting bug plus a request-count double-emission).

**Healthy:** push reliability is genuinely well-built (`usage-monitor-push.ts` — default-off,
fire-and-forget, debounced batch, exp-backoff retry, SHA-256 idempotency keys, HMR-safe
`globalThis`-pinned queue). Crash-durable replay is correctly wired at startup
(`instrumentation.ts` → `startUsageMonitorReplay`, watermarked per-ledger under `BEGIN IMMEDIATE`,
drains `llm_usage`/`rag_usage`/`provider_usage_outbox`, reconciles orphaned in-flight calls to
`"unknown"`). `recordLlmUsage`/`recordRagUsage` are single-writer. The **ST-primary bridge writer
is correctly default-off and gated** (`INFISICAL_ST_PRIMARY_WRITER_ENABLED`); its counterpart
reader PRs **#286 and #293 (commit `c6c4c8f`) are confirmed MERGED to API-usage-monitor `main`**,
so the publication blocker is genuinely clear on the receiver side. No retired-endpoint refs.

**Gaps (with evidence):**

- **7.1 — P1 (real dollar double-count): Voyage RAG spend is pushed twice and summed twice.**
  Voyage embed/rerank in `vector-db.ts` is instrumented on BOTH the durable-dispatch lane
  (`withDurableRagProviderDispatch("voyage", …, {estimatedCostUsd: estimateVoyageDispatchCost(…)})`
  at `vector-db.ts:1930-1939` / `:1991-2004`, replayed as `service:"provider-dispatch"` with a
  **non-zero** cost) AND the pre-existing ledger lane (`meterEmbed`/`meterRerank` → `recordRagUsage`
  → `service:"rag"`, same pricing table, same token estimate, same input). On the receiver,
  `sumMonthToDateExternalCostByProvider`'s `add()` (`API-usage-monitor/.../external-usage-events.ts:662-698`)
  buckets purely by provider name and **ignores the `service` field**, so it sums across both
  service groups → **Voyage `spentUsd` ≈ 2× actual.** If a Voyage `monthlyBudgetUsd` is configured,
  its warning/exceeded status is unreliable (and could trigger premature model-downgrade/skip if
  `USAGE_BUDGET_ENFORCE=on`). FMP is NOT dollar-affected (its dispatch reservations pass
  `estimatedCostUsd: 0`). **Cross-repo fix** — either drop `estimatedCostUsd` from the two Voyage
  dispatch calls (dispatch becomes quota-only, which is arguably its correct scope since the ledger
  lane already owns accurate cost), OR key the receiver's aggregation by `(provider, service)` and
  pick one authoritative service per provider. Coordinate with the API-usage-monitor side.
- **7.2 — P2 (request-count double-emission, not a $ bug): FMP.** Every FMP HTTP call emits both a
  `service:"provider-dispatch"` row (durable reserve/settle) and a `service:"fmp"` row
  (`recordProviderCall` via `fetchWithRetry`). Both carry `costUsd:0`, so no dollar impact, but any
  `/api/providers` dashboard card that sums `requests` per-provider across services will double-count
  FMP call volume — verify before trusting pushed FMP rate-limit visibility. Decide if the dual
  emission is intentional (two concerns) or should collapse.
- **7.3 — LOW (owner heads-up): `~/Code/API-usage-monitor` local `cursor` checkout.** The `cursor`
  branch is a clean ancestor of `origin/main` (zero unmerged commits — no coordination risk from the
  branch). BUT the working tree has **untracked files that exist nowhere in git**: scratch scripts
  (`process_prs.py`, `retry_merge*.py`, `protection*.json` — stale, low value), a 9-line
  `src/lib/adapters/quiver.ts` placeholder stub, and a **substantial `safari-extension/` Xcode
  project** (real Swift + xcodeproj scaffold, in no commit/branch). None touch the ST-integration
  surface, so no clobber risk — but the Safari scaffold would be lost to a janitor/disk sweep.
  **One-line owner decision: commit, discard, or gitignore.**

**Doc status:** `docs/usage-monitor-integration.md` is accurate for push/replay/budget design and
the snapshot-channel dedup, but does NOT account for the provider-dispatch-vs-ledger double-emission
(7.1/7.2) — update it when 7.1 is fixed.

---

## 8. Suggested priority order for MONET

**Do-first (P0 — surfaced to owner separately):**
0. **§6b.1** — auto-deploy silently halts live autonomy with no notification. Every merge to main
   turns the bot off until manually re-armed, and nothing tells the owner. Add the boot-halt
   push-notification + decide whether to enable `autoResumeOnBoot` in prod. **CLAUDE-verified.**

**Do-now, high-value, low-effort (mostly S):**
1. **§4.3 / §6b.3** — re-fire `recordClosedLotExperience` when a `pending_reconciliation` fill
   flips to filled (live trades finally feed episodic memory AND aged-out fills stop silently
   understating position/P&L). Two findings, one reconciliation fix. Biggest learning win per line.
2. **§3.1 + §3.2** — wire FMP price targets + ROE/ROA/gross-margin into the prompt/scoring
   (already fetched and paid for; pure upside).
3. **§5.1** — `global-error.tsx` dark-mode fix.
4. **§3.7** — deregister Alpha Vantage when Alpaca key present (kills daily quota-exhaustion alert).
5. **§2** — one effort-board hygiene pass (both boards, corrections a-d).
6. **§4.4** — balanced counterfactuals (avoided-losers), so the model stops only learning "be bolder."
7. **§7.1** — Voyage RAG double-count (real ~2× dollar inflation in the usage monitor). Cross-repo;
   coordinate with the API-usage-monitor side. Do before anyone relies on a Voyage budget.

**High-value, medium-effort:**
8. **§4.1** — build the retrieval-usefulness join (the keystone for self-measurement).
9. **§4.2 / §1b** — decide the fate of `coaching-durable` + `reflection-decompose` (rebase+land vs retire).
10. **§3.3** — QuiverQuant producer (differentiated congress/lobbying/contracts signals) + fix the false STATUS claim.
11. **§3.5 / §3.6** — economic-calendar awareness + raw-headline sentiment.

**Autonomy uptime/observability (P1 — high leverage for a self-running bot):**
12. **§6b.2** enable the scheduler dead-man's-switch (Sentry Crons or external probe) ·
    **§6b.4** provider-health-aware LLM cooldown + "all providers exhausted" state ·
    **§6b.7** trading-liveness health dimension (last completed run age).

**Owner decisions / larger:**
13. **§5.4** NAV_V2 resume · **§5.2** admin theme unification · **§4.6** Pinecone memory hygiene ·
    **§3.8** cross-repo FMP budget split · **§6b.11** persist offline decision-replay trace ·
    **§7.3** commit-or-discard the untracked API-usage-monitor Safari-extension scaffold.

**Cleanup (optional):** §1a re-land candidates (`autofix-rag-limits-fix`, `codex-autofix-1476`);
§1c branch pruning (keep the §1b FLAGGED + §1a candidates).

### Coordination notes
- Respect swimlanes/keepouts: the CODEX SEC-RAG program owns the RAG ingest/eval lanes (§4.7/§4.8
  are theirs to land); AG owns `ios/SocraticTrade/**`. Reserve on the effort board + post to
  #agent-sync before starting any item here.
- Cross-repo items (§3.8 FMP budget split) touch Congress.Trade — there's a concurrent CLAUDE
  eval-deploy lane there; coordinate.
- Everything lands dormant/default-off where it touches money paths; auto-deploy means merge==live.

### Where the raw evidence lives (this session's workflows)
- Branch dispositions + board audit journal: `…/subagents/workflows/wf_ec234761-ba2/journal.jsonl`
- App-evaluation full findings (all verdicts + evidence): task output
  `…/tasks/wcowcxskh.output` (nested `result.lanes[]`).
- This handoff is the synthesized, verified version — trust it over the raw journals for
  action, but the journals have the full file:line citations if you need to double-check one.
