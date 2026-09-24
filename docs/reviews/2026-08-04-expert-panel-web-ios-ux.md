# Expert panel review — web console + iOS (2026-08-04)

**Trigger:** Owner — “shouldn’t have 2 Run Once buttons within 1 inch of each other.”  
**Method:** Four parallel expert agents (iOS HIG, web product/UX, trading-desk ops, visual/a11y) over `~/apps/trading-grok`.  
**Branch:** `grok/ux-expert-review-dup-run-once`  
**Related program:** `docs/design/ux-improvement-program.md` (many Wave A–E items already landed; this review closes a gap the program never named).

---

## Executive summary

The product’s **control model is basically correct** (sticky chrome scope + STOP + Run once on web; phone as thin remote; Live typed confirm on proposals). The failure mode the owner hit is **competing primaries**: the same money-adjacent verb was remounted as a filled CTA in multiple places within one viewport.

**Canonical rule (now binding):**

| Surface | Owns **Run once** primary |
|---------|---------------------------|
| Web console | **Chrome only** (labeled desktop / icon-only phone) |
| iOS | **Home hero** when ready + no pending proposals; Agent controls only when hero does not |
| PWA `/mobile` | Sticky control grid (single remote surface — OK) |
| Guardrails Autonomy / Insights / readiness card | **Explain / teach — no second filled Run once** |

---

## What shipped in this pass (P0 + consensus quick wins)

### Web
- Removed Home “Run cadence” mobile `RunOnceButton` (stacked under sticky chrome).
- Removed readiness checklist card-header `RunOnceButton`; teach “use top bar.”
- Incomplete readiness `run-once` step no longer deep-links to empty Proposals.
- Guardrails Autonomy: dropped duplicate `RunOnceButton`; kept status, Start/STOP, preflight.
- Run once icon: **Zap** (not Play — Start already uses Play).
- Live Approve always says **Approve live** + `LiveTag` (never color-only “Approve”).
- Input `:focus-visible` ring restored on `.con-input` / select / textarea.
- Proposals empty state teaches top-bar Run once + stopped→approve trap.

### iOS
- `StrategyControlsCard` omits Run once when `ReadyHomeHero` already owns it.
- Insights no longer has a third “Run Strategy Once” primary; points to Home.
- Ready hero: word-first **LIVE / PAPER** pill (not red-as-live).
- Agent overview card only during incomplete setup (was pure duplicate when ready).
- Needs attention rows are tappable → Proposals / Markets / Activity.
- Copy: **Start agent** / **Stop agent**; Activity labels match.

---

## Expert consensus — ranked backlog (not all shipped)

### P0 / money-adjacent (next slices)

| ID | Finding | Effort |
|----|---------|--------|
| R1 | Stamp Run once: `Run once · {alias} · LIVE\|PAPER` on web + iOS | M |
| R2 | Finish PR-A1 skip honesty on Home strategy bar | M |
| R3 | Approve-while-stopped guided Start (already banner; soft prompt after Run once) | S–M |
| R4 | STOP confirm parity: iOS one-tap vs web sheet+confirm | S–M |
| R5 | Live quieter than Paper (banner hidden for live) — word chip on scope | S |

### P1

| ID | Finding | Effort |
|----|---------|--------|
| R6 | Ready-state Home density (web): equity/P&L hero, collapse coach/framework | M |
| R7 | Command palette ops verbs (Run once / STOP / switch account, same gates) | M |
| R8 | j/k + a/r proposal triage hotkeys | M |
| R9 | iOS close-only / wind-down in Agent menu | M |
| R10 | iOS command outcome banner under Agent controls | M |
| R11 | Approve/reject button variant matrix (bulk vs single vs live) | M |
| R12 | iOS palette: Live ≠ system red; pos/neg brand hexes | M |

### P2

Insights IA vs Home attention, Settings touch targets (32px avatar), LiveTag min type size, Markets section index, palette dirty-guard, brand name “Socratic-Trade” consistency.

---

## Ideal control placement (trading desk)

```
Chrome (web):  [Scope · LIVE/PAPER] [State] … [Run once · alias · tier] [Start|STOP]
Body:          Proposals / Scan / Strategy content — never the only path to STOP
iOS Home:      Hero primary (Run once | Review N) → Agent Start/Stop → tappable attention
iOS other tabs: Optional compact toolbar Run later; never a third Insights primary
```

Do **not** merge Run once with Start. Run once = one proposal cycle (HITL). Start = autonomy schedule.

---

## Program updates

Add named micro-PRs under Wave A / B refinements:

1. **`ux-run-once-single-primary`** — this PR (landed).  
2. **`ux-run-once-target-stamp`** — R1.  
3. Keep **A1** skip honesty as highest remaining trust item.

---

## Verification (this PR)

```bash
npx vitest run test/console-readiness-checklist.test.ts
# full gate before land:
npm run lint && npx tsc --noEmit && npm test && npm run build
```

iOS: visual pass on Home (ready, empty queue) — one Run once in hero; Agent controls = Start agent + Stop agent only.
