# DEEPSEEK Full-Stack Review — Handoff Note for Fleet Agents (2026-08-21)

**Owner direction (2026-08-21): DEEPSEEK does NOT implement fixes.  This review is complete and is handed to the fleet as actionable instructions.**  Claim on the board first, then Slack, then implement per your seat's process.

## 1. Context & how to use this note

- The full-stack review (desktop web, mobile web, iOS, backend/ops) is DONE: outline in `docs/reviews/2026-08-20-deepseek-full-review.md`, four track reports in `docs/audits/2026-08-20-deepseek-{backend-ops-docs,api-routes,scripts,docs,desktop-web,ios,mobile-web}.md` (all on main), board umbrella `682e7e3467cd4def97a13ee67335cbb1` (completed).
- Every finding is FILED on the board as a DEEPSEEK review-finding with full evidence.  **Do NOT re-file; `board claim <id>` instead.**
- Per-area handoff files (each contains: top items in order, exact file:line anchors, fix approach, failing-first tests, verify commands, pitfalls, avoid-list):
  - `docs/handoffs/2026-08-21-desktop-web-handoff.md`
  - `docs/handoffs/2026-08-21-mobile-web-handoff.md`
  - `docs/handoffs/2026-08-21-ios-handoff.md`
  - `docs/handoffs/2026-08-21-backend-ops-handoff.md`
- Review base: `origin/main` `41a7a438d`.  Production was 8 commits behind at review time — verify against `origin/main`, not live, and check `bash scripts/verify-deploy-sha.sh` before claiming anything is observable.

## 2. Claim protocol (binding)

1. `board claim <full-id> --by <SEAT> --env Mac|cloud --where "<worktree> @ <branch>"`.
2. Post the claim to #agent-sync with the standard header (repo: Socratic-Trade, claim, state: WIP, cadence).
3. Add/update the effort-log row (`docs/EFFORT-LOG.md` + `/Users/jay/apps/TRADING-EFFORT-LOG.md`) — Planned → In Progress.
4. Implement in YOUR seat worktree (never `~/Code/Socratic-Trade`), branch under your seat's prefix.
5. Verify: `npm run lint` → `npx tsc --noEmit` → `npm test` → `npm run build`; Swift changes additionally `xcodebuild build` + `xcodebuild test` (see `ios/CLAUDE.md`); shell changes `bash -n` + ASCII scan.
6. Land via `bash scripts/land.sh` (or push branch + PR; never push main directly).  Add `docs/rollouts/YYYY-MM-DD-*.md` + STATUS/PLAN updates.
7. Close out: `board status <id> completed --resolution "Landed in #<PR>."` + Slack DONE + effort-log COMPLETED row.

## 3. Master work list (all board ids, grouped)

### Web console (desktop) — `2026-08-21-desktop-web-handoff.md`
| Severity | Board id | Item | Effort |
|---|---|---|---|
| P1 | `cf62f87a` | Legacy pending proposals (NULL executionMode) can never pass typed confirmation on a live account; card says "NO ACCOUNT"; same root in bulk approve | M |
| P1 | `c53ad066` | Guardrails "Discard" does not clear Universe-group edits — discarded edits resurface | S |
| P2 | `28c50b28` | No per-page tab titles | S |
| P2 | `cdee1562` | Read notification items below WCAG AA (4.24:1 / 2.79:1) | S |
| P2 | `7e93bbcc` | Legal/welcome pages CDN-cached one year | S |
| P2 | `9fdfa035` | Coach quick-action chips inert | S |
| P2 | `f49c871b` | Evidence sheet attaches latest run's rows to unrelated older decision | S |
| P2 | `adc4ec5b` | "Send test" races the delivery auto-save queue | S |
| P2 | (in desktop report) | Account-scope menu keyboard contract; tooltip aria-describedby; comparison-tile gross P&L; bulk live-approve dead-end | S-M |

### Mobile web — `2026-08-21-mobile-web-handoff.md`
| Severity | Board id | Item | Effort |
|---|---|---|---|
| P1 | `620ef423` (deepen) | Expired session 401s forever — console freezes on stale data, no route to /login (web-side half; also the sign-in deep-link drop) | M |
| P2 | `bf05f16a` (remaining) | Avatar trigger hard-capped 32×32 (inline style beats 44px floor); Segmented/checkbox/summary/theme-picker sub-44px; 320px scope collapse, no overflow guard | S-M |
| P2 | `acc07df6` (remaining) | No phone type-scale (424×11px/188×12.5px/13×10px); ~70px equity chart; unvirtualized scan card wall, both trees mounted; orbs animating under opaque console; Coach composer Enter-always-sends on touch | M |

### iOS — `2026-08-21-ios-handoff.md`
| Severity | Board id | Item | Effort |
|---|---|---|---|
| P1 | `830c892f` | Required merge gate never compiles/tests Swift (ruleset = verify only; ios-build not required) | S (owner ruleset edit) |
| P1 | `410bda84` | No privacy manifest (ITMS-91053 risk; UserDefaults CA92.1) | S |
| P1 | `d9f81e44` | Dictionary(uniqueKeysWithValues:) traps on duplicate command ids — hard crash | S |
| P1 | `179cc4b2` | One failed reload disables Approve/Run/Watchlist/Policy; no polling fallback when SSE down | M |
| P2 | (ce75f8d0) | All-or-nothing snapshot decode — one bad row blanks the app | M |
| P2 | `89249c60` (systemic half) | No API→iOS contract tests (riskRules defect already fixed) | M |
| P2 | `2056ceab` (iOS half) | Tone tokens fail AA on iOS (system green ≈2.4:1) | S |
| P2 | `06edecc0` | Stores violate the @Observable rule | M |
| P3 | `7035a2ba` | Version record drift: project.yml 1.0.8 vs TestFlight 1.0.68 | S |
| P3 | `1dbdc227` | No 5xx retry; Dynamic Type chrome; sub-44pt targets; SSE full reloads | M |

### Backend / API / Ops / Docs — `2026-08-21-backend-ops-handoff.md`
| Severity | Board id | Item | Effort |
|---|---|---|---|
| P1 | `99ab01c7` | rth-deploy-drain.sh exits 0 on failed nudge — failed drain silently green | S |
| P1 | `8c9ce3b9` | deployment.md mislabels live replica as R2 (live is B2; shared object-path footgun) | S |
| P2 | `220c6cc6` | Freshness watchdog pages on deliberately RTH-latched merges | M |
| P2 | `68d11cc9` | Retired-lane scripts shipped (runner-availability.sh, fleet-watchdog.service, infisical-prod-cutover.sh) | S |
| P2 | `7db3350e` | ops-observability-security.md documents Mac PM2 litestream + unexercised restore (both false) | S |
| P3 | `3a8bcdcf` | /api/proposals/from-draft has no rate limit (money path) | S |
| P3 | `d6f0a9d3` | API error honesty: history 200-on-failure, broker GETs generic 500, malformed JSON 500s, 3 error envelopes | S-M |
| P3 | `cc0caa64` | checkBrokerHealth awaited inline, no tick-level deadline | S |
| P3 | `51c52fd6` | /api/health public, unthrottled, per-request network+disk I/O | S |
| P3 | `67558af0` | /api/market/quotes stamps asOf = serve time | S |
| P3 | (in report) | Mac litestream scripts target dead R2; LITESTREAM_* vs AWS_* mismatch; restore-drill version skew; ASCII violations; EFFORT-LOG merged rows | S |

### Cross-cutting / already-fixed state (do NOT re-fix)
- `89249c60` riskRules decoder + `3b343933` sign-out clearing: FIXED on main — comment/close, don't re-file.
- Dead-controls cluster, home proposal rows, console-ships-too-much (#2884), tone-token AA batch (#2795/#2561), admin gate (all 26 routes), exit-code contract, broker-I/O discipline: verified holding.
- Prod lag: live `e0a4959a` vs main `41a7a438d` at review time — 8 commits (incl. #2973/#2947/#2959/#2974/#2785/#2795/#2817).  RTH latch intentionally pauses weekday-RTH deploys.

## 4. Verification & process requirements (all seats, all items)

- Gates: `npm run lint` (0 errors) → `npx tsc --noEmit` → `npm test` → `npm run build`; `xcodebuild build` + `xcodebuild test` for `ios/**` (never rely on tsc/vitest for Swift); `bash -n` + ASCII scan for shell.
- Per-item failing-first tests are specified in the per-area handoff files — write the test, watch it fail, then fix.
- Docs/process: effort-log rows (live + mirror), `docs/rollouts/YYYY-MM-DD-*.md`, STATUS/PLAN updates, PR with the `verify` gate green, merge via PR (never direct main push).
- Money-path rules (binding): placement/cancel/replace stay non-abortable; no AbortSignal on those paths; no new provider keys; no fake-execution paths; FMP never; don't re-impose paper-default ceremony.
- Board closeout: `board status <id> completed --resolution "Landed in #<PR>."`; Slack DONE; effort-log COMPLETED row.

## 5. Suggested first wave (smallest, highest value — any seat)

1. `99ab01c7` drain exit 1 (S) — ops
2. `8c9ce3b9` deployment.md B2 rewrite (S) — docs
3. `d9f81e44` iOS dict crash one-liner (S) — iOS
4. `c53ad066` Guardrails Discard (S) — web
5. `cdee1562` read-opacity one-word fix (S) — web
6. `410bda84` privacy manifest (S) — iOS
7. `3a8bcdcf` from-draft rate limit (S) — backend
8. `28c50b28` tab titles (S) — web
9. `7e93bbcc` legal cache (S) — web
10. `67558af0` quotes asOf (S) — backend
