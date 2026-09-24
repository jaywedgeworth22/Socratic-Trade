# Socratic-Trade — Multi-Expert Full-App Review (GROK4)

> **2026-09-22 [MM] archaeology note:** historical reference to the iOS bundle ID `trade.socratic.app` is preserved verbatim as the ID that was live at review time.  Renamed on 2026-09-22 to `com.socratictrade.ios` (PR forthcoming); the SIWA native audience (`NATIVE_APPLE_CLIENT_ID`), APNs topic, and AASA `appIDs` claim all moved with it.  See `docs/rollouts/2026-09-22-bundle-id-migration.md`.

**Date:** 2026-07-20  
**Branch / worktree:** `agent/ios-phase-5` @ `code-socratictrade/grok`  
**Mode:** Read-only multi-agent panel (12 specialists). No production mutations.  
**Identity:** GROK4 (Slack / agent-sync)  
**Prior baseline:** `docs/reviews/2026-07-04-composite-expert-review.md` (Fable + Monet) — this review re-validates open items and adds post–July-4 surface area (iOS, Coolify/Hetzner, OpenRouter universal routing, dual-embed cutover, mobile).

---

## Panel

| Lane | Expertise |
|------|-----------|
| 1 | UI/UX — desktop console + iPhone Safari |
| 2 | iOS SwiftUI native client |
| 3 | LLM cost / OpenRouter / metering |
| 4 | Alert storms, API budgets, runaway coordination |
| 5 | Hetzner + Coolify production ops |
| 6 | RAG + embeddings + provenance |
| 7 | Money path — strategy, broker, stops, signals |
| 8 | ML / LLM learning & self-improvement loops |
| 9 | Cascading market-data APIs |
| 10 | Security + multi-user isolation |
| 11 | Architecture + code quality |
| 12 | Product IA / operator intuitiveness |

---

## Executive summary

Socratic-Trade is a **mature real-money trading monolith** with unusually strong approval receipts, glossary honesty, placement/reconcile hardening, and a sophisticated RAG stack. The 2026-07-04 composite review’s biggest learning-loop holes (episodic memory read, outcome writer, Red Team measurement) are **largely closed in code**. What remains is a different class of problem:

1. **Trust false positives** — budget/credit skips finish as `status: "completed"` and UI can say “did nothing on purpose.”
2. **Operational RAG cliff** — prod is on bge-m3 with a minority corpus (~1.6k vs ~8.7k Voyage); dense retrieval is sparse by design until full re-embed.
3. **Cost-control misalignment after universal OpenRouter** — Usage-Monitor enforcement keys vendor families (`openai`/`anthropic`) while spend is booked as `openrouter`.
4. **iOS is a starter, not shippable** — SIWA audience mismatch, live approve without typed confirm, broken account-deletion decode.
5. **Protection gaps on shorts / Robinhood defaults** — continuous broker-held covers missing; RH stops opt-in; add-to-loser rule blind for market entries.
6. **Security residual** — CF Access email header trust without JWT; Alpaca `baseUrl` + user webhooks as SSRF class; wrong `ENCRYPTION_KEY` fails open.
7. **Dual phone products + dual nav nouns** — `/mobile` vs responsive `/console` still diverge.

Highest ROI is not more features: **honest run outcomes**, **finish embed cutover**, **fix budget identity**, **iOS money-path parity**, **short/RH protection truth**, **origin/SSRF hardening**.

---

## Cross-panel P0 (do first)

### Trust / spend / coordination

| ID | Finding | Evidence | Suggested fix | Effort |
|----|---------|----------|---------------|--------|
| T1 | Budget / market-closed / broker-unhealthy / Usage-Monitor skips finish as `completed` | `strategy.ts` early exits + `finishStrategyRun(..., "completed")`; `trading-liveness` treats completed as healthy; auto-tune fires on completed | Distinct statuses: `skipped_budget`, `skipped_market`, `skipped_broker`; never “on purpose” for skips; liveness/auto-tune only real decision completions | M |
| T2 | Daily LLM budget skip silent in run summary | `skipLlmDueToBudget` + generic “Evaluated N proposals” | Surface “over daily LLM/RAG budget” in summary + Activity chip | S |
| T3 | Usage-Monitor Phase-2 enforce keys vendor family, spend is `openrouter` | `usage-budget.ts` `providerForModel` → `openai`/`anthropic`; `llm-provider.ts` always `provider: "openrouter"` | Enforce on `openrouter` (and/or total); align push + advisory | S–M |
| T4 | DB LLM key shadows rotated env; multi-key spend | `resolveLlmCredential` DB-before-env; STATUS 2026-07-20 | Operator replaces DB key; never mint keys; which-key UI already helps | Ops + S |
| T5 | SiliconFlow bge-m3 embed price 10× undercount (this tree) | `rag-metering.ts` `"BAAI/bge-m3": { embed: 0.00001 / 10 }` | Land/verify #1771 | S |

### RAG ops

| ID | Finding | Evidence | Suggested fix | Effort |
|----|---------|----------|---------------|--------|
| R1 | bge-m3 re-embed incomplete → dense retrieval sparse | STATUS live stats; `embedSpaceFilterForModel` excludes Voyage when on bge | Full `POST /api/admin/reembed` 4 docTypes; Pinecone reverify before any purge | Ops |
| R2 | Experience-memory re-embed overwrites Voyage ids (no dual residual) | `storeContexts` id not model-aware | Model-aware ids or accept one-way flip after full re-embed | M |
| R3 | 8-K / fundamentals / congress outside corpus re-embed | `CORPUS_REEMBED_DOC_TYPES` only 4 types | Extend re-embed or forced refresh under active revision | M |
| R4 | Wrong reindex path trap | `reindex-10k` / `reindex-all` ≠ full corpus re-embed | Operator runbook; admin UI warning | S |

### Money path

| ID | Finding | Evidence | Suggested fix | Effort |
|----|---------|----------|---------------|--------|
| M1 | Shorts: no continuous broker-held cover stop lane | `broker-protective-stops.ts` longs only, `side: "sell"` | Cover stops (or default synthetic short trail when `shortStopLossPct > 0`) | M |
| M2 | Add-to-loser stop rule blind for market/dollar openings | `policy.ts` `riskRuleReason` uses limit/stop else avgCost → drawdown 0 | Mark price from scan / position MV before avgCost | S |
| M3 | Robinhood continuous stops opt-in / default off | `robinhoodBrokerStops: false`; trail 0 | Surface “poll-only vs broker-resting” honestly; optional defaults for live RH | S–M |

### iOS

| ID | Finding | Evidence | Suggested fix | Effort |
|----|---------|----------|---------------|--------|
| I1 | SIWA audience ≠ bundle ID | App `trade.socratic.app` vs default `com.jays.SocraticTrade` | One canonical ID + entitlement + Infisical `APPLE_CLIENT_ID` | S |
| I2 | Live `proposal.approve` omits typed confirmation | iOS payload vs PWA `liveConfirmation` | Mirror PWA paste-disabled phrase | M |
| I3 | Account deletion success cannot decode; session uncleared | Expects `deletedUserId`; API returns `ok` + `logoutUrl` | Fix model + clear cookies + sign out | S |
| I4 | Not a buildable SIWA App Store target | No xcodegen project/entitlements in tree | Generate project, privacy, export compliance | M |

### Security

| ID | Finding | Evidence | Suggested fix | Effort |
|----|---------|----------|---------------|--------|
| S1 | CF Access email header trusted without JWT | `middleware.ts` + `CF_ACCESS_TRUST_EMAIL_HEADER` | Validate CF Access JWT or disable header trust | M |
| S2 | SSRF class: Alpaca `baseUrl` + alert webhooks | `alpaca.ts`, connect route, `notify.ts` / legacy webhook | Host allowlists / private-IP deny | M |
| S3 | Wrong `ENCRYPTION_KEY` fails open to empty decrypt | `db-api-keys.ts` decrypt → `""` | Boot decrypt self-test fail-closed | M |

### Hygiene (this worktree)

| ID | Finding | Evidence | Suggested fix | Effort |
|----|---------|----------|---------------|--------|
| H1 | `api-circuit-breaker.ts` contains a null byte | `file` → data; 1 null at ~offset 1708 | Restore from `origin/main`; re-verify tests | S |

---

## P1 by domain

### UI/UX & product IA

1. **Single live-approve sheet missing `tone="live"`** (bulk has it) — `approval-card.tsx`.
2. **Approval CTA not sticky on phone** — long card, money actions after multi-viewport scroll.
3. **Learned “risk observation” badged like money proposals but does not change behavior** — demote or wire into prompts.
4. **Two phone products** (`/mobile` vs `/console`) — different tokens, “Approvals” vs “Proposals”.
5. **Live account quiet by design** — ambient live chip without re-paternalizing.
6. **Guardrails Advanced `defaultOpen`** — complexity wall; close Advanced by default.
7. **Settings long dump** — sticky TOC / jump chips.
8. **Empty “completed” + “did nothing on purpose” when budget skipped** — trust breaker.
9. **Activity still says “simulated” for paper counts** — conflicts with removed local-sim philosophy.
10. **No first-run setup checklist** — keys copy over-promises optional LLM.
11. **Mobile shows raw `propose`/`decide`** — glossary says Ask-first/Autopilot.
12. **Autonomy split across chrome + Guardrails + Strategy** — need one Autonomy panel.
13. **Cmd+K undiscoverable on phone**.

### LLM cost / OpenRouter

14. Credit probe only for `local` key — multi-user 402 invisible on health.
15. Anthropic prompt-caching path dead on strategy (universal chat-completions).
16. Chat usage drops cache token fields → cost overstatement.
17. OpenRouter rerank undercount (no auto-chunk modeling).
18. Hardcoded price table ≠ OR bill / markup.
19. Failed OR attempts unmetered; failover multiplies paid tries.
20. No confirmed external UR monitor for credit (owner follow-up).
21. Early budget admission missing — full scan/broker work still paid when later skipped.

### Ops / Coolify / Hetzner

22. Dual-scheduler risk is procedural only (lease is SQLite-local).
23. R2 restore drill never recorded; marker write without integrity gate.
24. Auto-deploy recycles container → autonomy halt unless `autoResumeOnBoot`.
25. CI + prod share one box; zombie deploy freezes serial queue.
26. Disk / litestream degrade advisory only on `/api/health` — monitors watching `ok` miss backup death.
27. Infisical Cloud boot SPOF; DR scripts still Mac-centric.

### RAG / learning

28. Hybrid + multi-query/HyDE default-OFF.
29. Server as-of filter default-OFF; strict undated allowlist default-OFF.
30. `doc_type=news` never written.
31. Filings still hard-scoped to single symbol (cross-symbol only episodic).
32. No money-path faithfulness / `usedEvidence` gate.
33. **Coach notes still `slice(-20)`** — no archive, no `coach-note` vectors, no `ingestLearned` (retrieval already expects them).
34. **`lesson` vectors never written** — only SQL `learned_context` facts.
35. Reflection still one opaque blob; regime arg unused on learned-context retrieve.
36. Risk-tier approvals still never reach decision prompts.
37. Framework accept = label only (no policy/prompt actuation).
38. Per-model scoreboard exists; no bandit / calibration-by-model.
39. IC still 5d while outcomes multi-horizon; no Wilson `evidenceVerdict`.

### Trading / market data

40. Dashboard collapses short/cover to “Trade”.
41. Bracket permission ignores `shortStopLossPct` alone.
42. Halted: human cannot approve exits unless `protectWhileHalted` synthetic.
43. Alpaca trade_updates stream is single-operator/`local` only.
44. Partial/`placing` notional locks caps at full estimate.
45. Chat drafts cannot express short/cover.
46. **Keyword bag news sentiment moves scan scores**; missing treated as 50; AV model sentiment deregistered when Alpaca news present.
47. `maxFundamentalsAgeSec` gates on scan `generatedAt`, not field age.
48. Average volume can be stamped as session `volume` (Finnhub/RH).
49. Full parallel enrichment fan-out default-on (short-circuit gated).
50. Sentiment tooltip hardcodes Finnhub story regardless of source.
51. `MarketQuote.stale: true` never cleared.

### Security / multi-user

52. Ops snapshot = multi-tenant + static token (shares admin reindex token fallback).
53. TradingView webhook can fan-out to all active users when engine on.
54. Congress webhook bearer alternative + weak body bounds.
55. Shared operator infra keys across tenants (cost isolation).
56. Evidence bulletins only sanitized for first 3; rest raw into strategy prompt.
57. SSE global events without `userId` (activity leak hygiene).

### Architecture

58. `strategy.ts` ~6.1k + `vector-db.ts` ~6.8k god modules; strategy ↔ risk ↔ execution cycle.
59. Dual schema sources: full migrations in `db.ts` vs partial Drizzle (3 tables).
60. Dashboard “load the universe” BFF polled for every tab.
61. Config/env sprawl without typed registry.

---

## P2 highlights (selected)

- Approval progressive disclosure; duplicate learned-pending polls; NAV_V2 dead parallel IA.
- iOS: false logout on any non-2xx; SSE no poll fallback; no push/deep links; idempotency UUID per tap.
- OpenRouter credit flap near $10 threshold; provider rate limits many unlimited by default.
- No second-region backup; GitHub webhook CF allowlist drift; Sentry crons opt-in.
- Mock enrichment still exported (not on cascade) — re-wire landmine.
- Dual FCF field names; Finnhub div yield unit; PE n/a when eps missing.
- Missed-opportunity nudge up-only; argmax factor attribution; no exit counterfactuals / non-action case files.

---

## What improved since 2026-07-04 (do not re-open)

| Area | Status |
|------|--------|
| Episodic experience write + retrieve at decision time | **Closed** in code |
| Outcome writer + multi-horizon | **Closed** |
| Red Team veto counterfactuals + efficacy | **Closed** |
| Lifecycle re-index of decision memory | **Closed** |
| Real post-mortem lessons at maturation | **Closed** |
| Bear `confidenceScore` strip bug | **Closed** (red-team redesign) |
| Provenance headers on RAG chunks | **Closed** |
| Relevance floor + dedupe | **Closed** |
| Scout/deep retrieval staging | **Closed** |
| Local sim / paper-as-fake-mode | **Removed** (product) |
| Many 2026-07-05 UI audit items | **Fixed** (cmd+K, bulk arm, mobile cards, etc.) |
| Stop placement intent + atomic recovered fills | **Landed** (recent) |
| OpenRouter credit on `/api/health` | **Landed** (degrade-only) |
| Which-key preview on Connections | **Landing / in progress** |
| Agents never create API keys | **Codified** in AGENTS.md |

---

## Highest-leverage improvement roadmap

### Wave A — Trust & spend (1–2 weeks, high owner ROI)

1. Run outcome taxonomy + UI chips (T1–T2).
2. Usage-Monitor / OpenRouter budget identity (T3).
3. Early budget admission before scan (lane 4 #4).
4. Kill “simulated” paper wording; fix Connections “keys optional” copy.
5. Confirm SiliconFlow price + external UR credit monitor.

### Wave B — RAG cutover ops (this week, operational)

1. Dry-run + full 4-docType re-embed; Pinecone reverify.
2. Spot-check strategy dossiers; only then consider purge-legacy.
3. Extend re-embed for 8-K/fundamentals (R3).
4. Land coach-note archive + coach/lesson vector writers (learning P0).

### Wave C — Money-path protection honesty (1–2 weeks)

1. Short continuous cover stops or synthetic default (M1).
2. Mark-price add-to-loser (M2).
3. RH protection state surface (M3).
4. Dashboard short/cover labels; bracket gate includes `shortStopLossPct`.

### Wave D — iOS ship path (2–3 weeks)

1. Bundle/SIWA alignment + live typed approve + deletion + sign-out.
2. Status-aware errors; SSE reconnect + poll.
3. PWA parity slice: close-only, positions, alerts, readiness.

### Wave E — Security hardening (parallel)

1. CF Access JWT (S1).
2. SSRF allowlists (S2).
3. ENCRYPTION_KEY boot probe (S3).
4. Split ops vs admin tokens; TV body cap.

### Wave F — Intuition / structure (ongoing)

1. First-run setup checklist; one Autonomy panel; quieter default nav.
2. One phone story (mobile vs console).
3. Slice dashboard BFF; continue strategy/vector-db decomposition.

---

## Operator sequence (no code)

```text
1. Pinecone describe-index-stats + GET /api/admin/reembed  → confirm dual-space reality
2. POST /api/admin/reembed (dryRun then real) for 4 docTypes → poll to completed
3. Reverify counts; do NOT purge-legacy until full
4. Connections: confirm which OpenRouter key preview is active (replace shadowed DB key if needed)
5. Confirm USAGE_BUDGET_ENFORCE behavior vs openrouter spend (expect mis-key until T3 fixed)
6. Confirm autoResumeOnBoot for primary after auto-deploy
7. One Coolify-path litestream restore drill (integrity + ENCRYPTION_KEY decrypt)
8. iOS: do not ship approvals until I1–I3 fixed
```

---

## Strengths to protect

- Real trading philosophy enforced in code (no local fake fills; paper = broker environment).
- Approval receipts: thesis, Red Team, three-outcomes, typed live confirm (web).
- Placement/reconcile + stop intent hardening trajectory.
- Single-leader scheduler default ON; usage-monitor push breaker (Render 200GB lesson).
- OpenRouter credit health degrades only (no restart loop on empty wallet).
- Trading liveness never 503s (avoids restart↔halt interlock).
- Multi-tenant fences on proposals/executes; client identity strip.
- Prompt containment on main untrusted fields (gaps remaining but foundation good).
- Aggressive money-path regression tests.

---

## Method & limits

- Pure code/doc review on this worktree; no live browser QA, no broker placement probes.
- Severity is expert judgment grounded in file evidence; re-verify line numbers after merges.
- STATUS/PLAN are session logs — operational claims (Pinecone counts, credit balance) re-check live before acting.
- Parallel agents may slightly overlap; P0 table is de-duplicated synthesis.

---

## Deliverable paths

- This document: `docs/reviews/2026-07-20-grok4-multi-expert-full-app-review.md`
- Effort board: `/Users/jay/apps/TRADING-EFFORT-LOG.md` + `docs/EFFORT-LOG.md` (GROK4 full multi-expert review)
- Slack: #agent-sync as **GROK4**

**Bottom line:** The product’s *decision quality stack* advanced materially since July 4; the next ceiling is **honest operational truth** (budget/RAG/protection state), **finishing the embed cutover**, and **shipping-grade mobile/iOS + security residuals** — not more strategy features.
