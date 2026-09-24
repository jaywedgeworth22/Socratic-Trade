# UX / Product Improvement Program — Sequenced PR Plan

**Date:** 2026-08-04  
**Author:** GROK (session review → implementation program)  
**Status:** Waves A–E **COMPLETE on main** (2026-08-05, closeout #2448). Wave F remains owner-gated optional.  
**Current clients (2026-08-20):** the `/mobile` PWA UI is retired (#2801).  Live surfaces are `/console` (desktop + phone widths) and native iOS.  Treat Wave D / D1 "PWA as control remote" below as the August 4 program record, not current product truth.
**Source review:** Owner-requested top-to-bottom web + iOS + PWA review (2026-08-04 session)  
**Related priors:**  
- `docs/reviews/2026-07-05-ui-audit-and-design-system-unification.md`  
- `docs/reviews/2026-07-20-grok4-multi-expert-full-app-review.md`  
- `docs/reviews/ui-expert-guidance.md`  
- `IMPROVEMENTS-2026-07-07.md`  
- `docs/design/visual-system.md`  
- `docs/mobile-api-and-clients.md`

---

## Goal

Make Socratic-Trade **more intuitive, faster-feeling, and aesthetically coherent** across:

1. **Web console** (`/console/*`) — primary operator desk  
2. **Public / marketing** (`/welcome`, `/login`, landing)  
3. **Phone PWA** (`/mobile`)  
4. **Native iOS** (`ios/SocraticTrade`)

without diluting trading correctness, money-path honesty, or the “inspectable reasoning” product identity.

**North star (one sentence):** *Same mental model and brand on every surface; money actions always on top of reasoning; empty and skip states always teach the next step.*

---

## Non-goals (binding)

- No big-bang merge of `app/ui/*` and `app/console/ui/*` primitives.  
- No reintroduction of mock/local fake fills or paternalistic “protect the owner from risk” cages.  
- No new top-level destinations until something is removed or nested (15 is the ceiling).  
- No glassmorphism / animated-orb treatment on console data surfaces.  
- No minting of provider API keys.  
- Do not force-complete half-migrated `NAV_V2` unless a dedicated PR owns the full cutover.

---

## Decision gates (owner)

Claiming agents should stop and ask only when blocked on these:

| ID | Decision | Default if owner silent |
|----|----------|-------------------------|
| D1 | **Phone primary:** PWA as control remote vs full responsive console vs both | **Both ship**, PWA = control remote; console remains full desk; iOS mirrors PWA IA |
| D2 | **Nav plain labels:** rename Thesis→Home (or dual “Home · Thesis”), Evidence→Scan, Journal→Activity, Outcomes→Results | Prefer **plain labels** (Home / Scan / Activity / Results); keep descriptions for the sophisticated metaphor |
| D3 | **Unauthenticated `/`:** stay console-redirect vs soft welcome | Prefer **welcome when unauthenticated** and landing flag on |
| D4 | **iOS App Store push** this quarter? | If no: still brand + readiness checklist; defer Live Activities / push |

---

## Architecture principles for every PR

1. **Word-first money reality** — Live / Paper / No account never color-only.  
2. **Progressive disclosure** — default view answers “what now?”; expand for “why?”.  
3. **One vocabulary** — same nouns on web rail, PWA sections, iOS tabs.  
4. **Backend authority** — phone clients stay thin (`/api/mobile/*` commands).  
5. **Tokens, not hex** — brand via `--brand-accent` / shared palette; iOS maps to the same hue.  
6. **Verify gates** — `npm run lint` → `npx tsc --noEmit` → `npm test` → `npm run build` (iOS: xcodegen + xcodebuild as in `ios/README.md`).  
7. **Land via** `bash scripts/land.sh` from an agent worktree — never main integration tree.

---

## Wave map (summary)

| Wave | Theme | PRs | Parallelism |
|------|--------|-----|-------------|
| **0** | Plan + board reservation | PR-0 (this doc) | Solo |
| **A** | Trust & action clarity (P0) | A1–A5 | A1 ∥ A2 ∥ A4; A3 after A2; A5 independent |
| **B** | Intuition & IA (P1) | B1–B5 | B1 needs D2; B2–B4 parallel after A; B5 needs D1 |
| **C** | Speed (perceived + real) | C1–C4 | Highly parallel with B |
| **D** | Mobile product parity | D1–D4 | After D1 decision; D2–D4 parallel |
| **E** | Aesthetic polish | E1–E3 | Anytime after A; low risk |
| **F** | Optional / later | F1–F3 | Owner-gated |

---

## Wave 0 — Program anchor

### PR-0 — Design program + effort board (this PR)

| | |
|--|--|
| **Branch** | `grok/ux-improvement-program` |
| **Files** | `docs/design/ux-improvement-program.md`, `docs/rollouts/2026-08-04-ux-improvement-program.md`, `docs/EFFORT-LOG.md`, `STATUS.md` |
| **Tests** | Docs only |
| **Done when** | Plan merged; Planned rows on live board + mirror for Wave A–D program + first implementable slices |

---

## Wave A — Trust & action clarity (P0)

### PR-A1 — Honest run skip / incomplete statuses in UI

**Problem:** Budget / market-closed / broker-unhealthy skips can surface as success-ish “completed” or “did nothing on purpose,” which destroys trust.

| | |
|--|--|
| **Effort** | M |
| **Suggested branch** | `*/ux-honest-run-skips` |
| **Touches (expected)** | `src/lib/strategy.ts` (or run finisher), strategy run status types, `app/console/lib/last-run.ts`, Activity labels, Thesis last-run chip, tests under `test/` for status mapping |
| **Out of scope** | Changing skip *policy* — only honesty of status + labels |
| **Acceptance** | Skips never render as successful decision runs; Activity has distinct chips: e.g. *Skipped — LLM budget*, *Skipped — market closed*, *Skipped — broker unhealthy*; liveness / auto-tune do not treat pure skips as healthy decision completions (if currently true) |
| **Verify** | Full gate + unit tests for each skip class |
| **Risk** | Money-adjacent status semantics — mid-tier implement, frontier only if status machine is ambiguous |

---

### PR-A2 — Approval card progressive disclosure + sticky actions (web)

**Problem:** Approve/Reject buried under dense receipt sections on phone and long desktop cards.

| | |
|--|--|
| **Effort** | M |
| **Suggested branch** | `*/ux-approval-card-density` |
| **Touches** | `app/console/components/approval-card.tsx`, approvals page layout, possibly `app/console/console.css` for sticky footer |
| **Behavior** | Default collapsed: symbol, side, size/notional, Live/Paper, red-team chip, 2–3 line thesis; expand for reward/risk, RAG, gates, model detail. Mobile: sticky bottom action bar (above tab bar) for Approve/Reject. Live typed-confirm sheet keeps `tone="live"` parity with bulk. |
| **Acceptance** | On 390×844 viewport, primary CTAs visible without scrolling past thesis; expand still shows full receipt; no change to approve API contract |
| **Verify** | Existing approval tests + visual pass; lint/tsc |

---

### PR-A3 — First-run / readiness checklist hero

**Problem:** Attention items exist in `derive.ts` but empty desk still feels like broken cards, not a path.

| | |
|--|--|
| **Effort** | M |
| **Depends** | Optional after A2 (can land independent) |
| **Suggested branch** | `*/ux-first-run-checklist` |
| **Touches** | `app/console/lib/derive.ts` (export structured checklist), `app/console/page.tsx` (hero when incomplete), possibly shell banner; iOS Home later in D-wave |
| **Steps (canonical)** | (1) Connect broker (2) Select active account (3) Universe/index (4) LLM key + Green model (5) Run once → open Proposals |
| **Acceptance** | Incomplete readiness → checklist is the dominant Thesis surface; each step one CTA; complete readiness → checklist gone (or collapsed “You’re set”) |
| **Verify** | Unit tests for checklist derivation; no false “ready” when `hasAccount`/`hasUniverse`/LLM false |

---

### PR-A4 — Guardrails Advanced closed by default + Essentials first

| | |
|--|--|
| **Effort** | S |
| **Suggested branch** | `*/ux-guardrails-defaults` |
| **Touches** | `app/console/guardrails/page.tsx` (`defaultOpen` on Advanced / possibly Protective stops) |
| **Acceptance** | Advanced rulebook collapsed on first visit; Essentials (authority, caps, schedule) open; no policy default value changes |
| **Verify** | lint/tsc; smoke guardrails page |

---

### PR-A5 — Cross-surface noun pass (Proposals everywhere)

**Problem:** PWA still says “Approvals” while console/iOS say “Proposals”.

| | |
|--|--|
| **Effort** | S |
| **Suggested branch** | `*/ux-noun-proposals` |
| **Touches** | `app/mobile/mobile-pwa-client.tsx`, any user-facing strings “Approvals” for trade proposals; docs/mobile that are user-facing |
| **Acceptance** | User-visible strings aligned; routes can keep `/console/approvals` path (redirect alias optional later) |
| **Verify** | grep user-facing “Approvals” for trade-proposal context → only legacy path or intentional |

---

### PR-A6 — Run once single primary (owner complaint)

**Problem:** Two+ filled **Run once** controls within ~1 inch (iOS hero + Agent controls; web chrome + readiness + Home cadence + Guardrails Autonomy). Expert panel 2026-08-04.

| | |
|--|--|
| **Effort** | S |
| **Status** | **Shipping** on `grok/ux-expert-review-dup-run-once` |
| **Touches** | `ios/.../HomeView.swift`, `InsightsView.swift`, `app/console/page.tsx`, `readiness-checklist.tsx`, `guardrails/page.tsx`, `chrome.tsx` (Zap icon), `approval-card.tsx` (live label), `console.css` (focus), derive run-once step |
| **Rule** | Web chrome owns Run once; iOS Home hero owns it when ready+empty queue; nowhere else mounts a second filled primary |
| **Acceptance** | Ready iOS Home shows exactly one Run once; web phone Home does not stack cadence button under chrome; Guardrails Autonomy has no RunOnceButton |
| **Review** | `docs/reviews/2026-08-04-expert-panel-web-ios-ux.md` |
| **Follow-on** | PR-A7 target-stamp `Run once · alias · LIVE\|PAPER` |

---

## Wave B — Intuition & information architecture (P1)

### PR-B1 — Plain-language destination labels

**Needs D2.** Mapping recommendation:

| Current | Proposed label | `desc` keeps metaphor |
|---------|----------------|------------------------|
| Thesis | **Home** | Live thesis, actions, evidence… |
| Evidence | **Scan** | Market scan… |
| Journal | **Activity** | Decision journal… |
| Outcomes | **Results** | Realized performance… |
| Regime | **Macro** | Macro / regime board… |

| | |
|--|--|
| **Effort** | S–M |
| **Touches** | `app/console/components/nav.tsx` (`DESTINATIONS`), any hard-coded h1 that bypasses `destinationLabel`, tests for nav labels, mobile tab pin titles if stored by label |
| **Acceptance** | Rail label === page h1 via `destinationLabel`; localStorage pins by href not label so renames don’t break pins |
| **Risk** | Users with muscle memory — dual subtitle “Home · Thesis” for one release optional |

---

### PR-B2 — Single Autonomy surface

| | |
|--|--|
| **Effort** | M |
| **Touches** | New section on Guardrails or Strategy (prefer Guardrails Essentials), chrome deep-link `?focus=autonomy`, optional Thesis chip linking there |
| **Content** | systemState, strategyAuthority, cadence, Run once / Start / Stop, “why can’t I run?” from readiness |
| **Acceptance** | One URL answers “is the agent on and why not?” without hunting chrome + three pages |

---

### PR-B3 — Strategy page progressive structure

| | |
|--|--|
| **Effort** | M–L |
| **Touches** | `app/console/strategy/page.tsx` (~1.5k lines) — sub-nav or collapsible sections: Instructions · Models · Scoring · Presets |
| **Acceptance** | First paint shows Models + primary instructions; advanced weights collapsed; no behavior change to persisted policy |

---

### PR-B4 — Settings sticky TOC / jump chips

| | |
|--|--|
| **Effort** | S–M |
| **Touches** | `app/console/settings/page.tsx` + section anchors |
| **Acceptance** | Jump to Notifications / Display / Sharing / Danger without full-page scroll hunt |

---

### PR-B5 — Phone product decision implementation

**Needs D1.** If default (both ship, PWA = remote):

- Document in `docs/mobile-api-and-clients.md`  
- `/mobile` header: “Control remote — full desk on desktop”  
- Deep links from PWA empty states → `/console/...` where needed  
- Do **not** delete responsive console work  

If owner chooses single product: separate PR to redirect and retire the other.

---

## Wave C — Perceived & real speed (P1)

These are UX as much as perf. Prefer mid-tier implementers; keep money path out.

### PR-C1 — Dashboard snapshot short TTL cache

| | |
|--|--|
| **Effort** | M |
| **Touches** | `src/lib/dashboard.ts`, `/api/dashboard`, `/api/mobile/snapshot`, invalidation on writes that change snapshot material |
| **Acceptance** | Repeat polls within ~10s share work; SSE/write path invalidates; correctness tests for multi-account keying `(userId, accountNumber)` |
| **Risk** | Stale portfolio — TTL short; invalidate on command completion / policy write |

---

### PR-C2 — FIFO P&L compute-once per request

| | |
|--|--|
| **Effort** | M |
| **Touches** | `src/lib/performance.ts`, dashboard snapshot assembly |
| **Acceptance** | Thesis/Outcomes same numbers as before; fewer `calculatePnl` passes in a profiled unit test or counter |

---

### PR-C3 — Scan table virtualization

| | |
|--|--|
| **Effort** | M |
| **Touches** | `app/console/scan/scan-table.tsx` — `TableVirtuoso` (already a dep) |
| **Acceptance** | 100-row scan scrolls smoothly on mid phone; sticky symbol column preserved |

---

### PR-C4 — Console render memoization

| | |
|--|--|
| **Effort** | M |
| **Touches** | Split stream/freshness context if needed; `React.memo` on PositionsCard, EquityChart, ApprovalCard, ScanTable; `useMemo` derive block on Thesis |
| **Acceptance** | Profiling or intentional test: leaf cards don’t re-render on pure freshness tick when props stable |

---

## Wave D — Mobile & iOS parity (P1)

### PR-D1 — iOS brand palette + icon alignment

| | |
|--|--|
| **Effort** | S |
| **Touches** | `ios/SocraticTrade/AppComponents.swift` (`AppPalette.accent` → brand teal, not indigo), launch/login gradients, ensure App Icon assets match web full-bleed white candlestick program |
| **Acceptance** | Side-by-side with web: accent hue matches `--brand-accent` / dark variant |

---

### PR-D2 — iOS Home readiness checklist + hero

| | |
|--|--|
| **Effort** | M |
| **Depends** | A3 checklist semantics (can re-derive from `readiness` fields if web not merged) |
| **Touches** | `HomeView.swift`, maybe `MobileModels` |
| **Acceptance** | Incomplete setup: checklist hero; complete: equity + day P&L + agent state + primary CTA (Run once or Review N proposals) |

---

### PR-D3 — iOS command outcome feedback parity (PWA-style)

| | |
|--|--|
| **Effort** | M |
| **Touches** | `ProposalsView.swift`, `MobileStore.swift` — per-proposal busy + track command status through recentCommands |
| **Acceptance** | Approve/reject shows sending → queued/running → success/fail on the card, not only Activity |

---

### PR-D4 — PWA polish pass

| | |
|--|--|
| **Effort** | S–M |
| **Touches** | `app/mobile/mobile-pwa-client.tsx`, manifest if needed |
| **Items** | Humanize command labels (`strategy.run_once` → “Strategy run”); authority glossary (Ask-first / Autopilot not raw propose/decide); install/offline copy when snapshot stale but STOP available |

---

## Wave E — Aesthetic polish (P2)

### PR-E1 — Shared empty-state + chart theme

| | |
|--|--|
| **Effort** | M |
| **Touches** | Console empty states → one pattern; equity/regime chart colors from tokens |

---

### PR-E2 — Marketing welcome + login warmth

| | |
|--|--|
| **Effort** | M |
| **Needs** | D3 for `/` behavior |
| **Touches** | `app/welcome/page.tsx`, `app/login/page.tsx`, middleware or `app/page.tsx` for unauth welcome |
| **Acceptance** | Login carries three value bullets (match iOS); welcome above-fold shorter |

---

### PR-E3 — Command palette always visible on touch + chrome density

| | |
|--|--|
| **Effort** | S |
| **Touches** | `app/console/components/chrome.tsx`, shell mobile freshness collapse when healthy |

---

## Wave F — Optional / later (P3)

| ID | Item | Gate |
|----|------|------|
| F1 | Finish or delete `NAV_V2` half-migration | Product decision |
| F2 | iOS push / Live Activity for pending proposals | D4 + APNs |
| F3 | Full Coach chat on iOS (not heuristic cards) | Assistant API mobile contract |
| F4 | Lessons badge honesty (risk observation ≠ money proposal) | Product |
| F5 | Protection truth UI (RH poll-only vs broker-resting stops; short covers) | Money-path program — coordinate with exit-strategy / broker constraints |

---

## Suggested first month schedule

Week-oriented, assuming 1–2 mid-tier agents:

| Week | Land |
|------|------|
| **W1** | PR-0, A4, A5, A2, A1 start |
| **W2** | A1, A3, C3, D1 |
| **W3** | B1 (if D2), C1, C2, D2 |
| **W4** | B2, B4, C4, D3, D4 |

Owner can reorder: if trust pain is loudest, keep A1 first; if phone is the daily surface, promote D1–D3.

---

## File keepouts / conflict hotspots

| Hotspot | Why | Coordination |
|---------|-----|--------------|
| `app/console/components/approval-card.tsx` | Dense; money path UI | One owner at a time for A2 |
| `src/lib/strategy.ts` / run status | Money path | A1 needs careful review |
| `src/lib/dashboard.ts` | Snapshot cost | C1/C2 serialize or stack carefully |
| `app/console/components/nav.tsx` | Every UI PR | B1 owns labels; others don’t rename |
| `ios/*` | Small surface | One iOS PR stream preferred |
| `docs/EFFORT-LOG.md` | Merge magnet | Always union-merge; never delete peers |

---

## Verification checklist (every implementation PR)

```bash
npm run lint
npx tsc --noEmit
npm test
npm run build
```

iOS PRs additionally:

```bash
cd ios && xcodegen generate
xcodebuild -project SocraticTrade.xcodeproj -scheme SocraticTrade \
  -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
  CODE_SIGNING_ALLOWED=NO build
```

Visual: desktop Thesis + Proposals; phone 390 width; iOS simulator Home + Proposals when touched.

---

## How to claim a slice

1. Poll agent-sync; read this doc + live board.  
2. Move the matching Planned row → In Progress with your tag + branch (do not pre-assign unclaimed slices to other agents).  
3. Implement in `~/apps/trading-<you>` worktree only.  
4. Update rollout note for that slice; mirror effort board; land via `scripts/land.sh`.  
5. On merge: mark Completed (auto-deploy era = also effectively Deployed after `verify-deploy-sha` if you verify).

---

## Success metrics (qualitative, owner-visible)

- New session with no broker: **under 30 seconds to know the next click**.  
- Pending live proposal on phone: **Approve/Reject without hunting**.  
- Skip-only strategy tick: **never looks like a successful trade run**.  
- Web ↔ PWA ↔ iOS: **same nouns, same brand accent, same live-confirm phrase rules**.  
- Thesis first screen: **state + portfolio + next action**, not a research paper.

---

## Changelog

| Date | Note |
|------|------|
| 2026-08-04 | Initial program from full-app review; PR-0 docs land. |


---

## Closeout receipt (2026-08-05)

| Wave | Status | Key PRs |
|------|--------|---------|
| 0 Plan | Done | #2400 |
| A Trust | Done | #2418 A1, #2414 A2, #2417 A3, #2411 A4+A5 |
| B IA | Done | #2413 B1, #2425 Autonomy+TOC, #2426 B3 |
| C Speed | Done | #2423 C1–C4 |
| D Mobile | Done | #2424, #2435 Insights rename |
| E Polish | Done | #2426 |
| F Optional | Not started | Owner-gated |

Also: congress filing skill #2429. Rollout: `docs/rollouts/2026-08-05-ux-program-complete.md`.
