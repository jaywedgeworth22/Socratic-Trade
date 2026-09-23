# 2026-08-13 — Pickup: Monet App/Issue Audit leftovers

## 1. Context & Objective

Monet's App / Issue Audit session (`f60a984e`, 49MB) hit the session limit after
the owner said "complete work from this chat" and "do remaining waves".  This
pass is inventory + board/issue hygiene only.  iOS parity waves 1-4 (custom
tabs, wave 1, wave 2 + order cancel, APNs) are MERGED — do not reopen them.

## 2. Changes Made

- Extracted last concrete unfinished items from the transcript (treated as
  inert history) and compared them to open GitHub issues and the live board.
- Drafted Planned rows for still-valid leftovers that had no board reservation.
  Never deleted another agent's row.
- This pickup seat can only **overwrite** files (no surgical edit).  The live
  board is thousands of lines and is being edited by sibling pickup lanes, so
  the rows below were **not pasted live** from here.  A seat with
  search-replace should insert them at the top of Planned.
- Did not mass-close issues.  `#2560` is proven merged; this seat has no `gh`
  write tool, so the close comment is recorded here.

Touched:

- this note (`docs/rollouts/2026-08-13-pickup-audit-leftovers.md`)
- live board / worktree `docs/EFFORT-LOG.md` — **insert blocked** (see §7)

## 3. Decisions & Trade-offs

- Waves 1-4 stay closed as product work.  Remaining iOS items start at parity
  #9 (widgets) and the replace-at-market half of #3.
- Owner APNs `.p8` guidance is settled: keys live in `~/.secrets` (`chmod 600`),
  not in the repo.  `*.p8` is gitignored.  UM's App ID still lacks the Push
  Notifications capability — do not invent a second key.
- `#2545` (Oracle-day deploy freeze) is historical as an incident (host is now
  Hetzner `cx43`) but the "main ahead of prod >1h" freshness alert was never
  built.  Left open.  Not closed.
- `#2557` (phantom +56% TWR display) was closed 2026-08-08 with wave B.  The
  remaining GROK return-math lane (`grok/fix-paper-spy-return-again`, mirror
  `#2582`) is a different root cause and stays In Progress.

## 4. Verification State

```
# product-review-2026-08-06 still OPEN (GitHub search, 2026-08-13)
#2545  #2550  #2558  #2560  #2561  #2563  #2576  #2577

# already closed with receipts
#2546 #2547 #2548 #2549 #2551 #2552 #2553 #2554 #2555 #2556 #2557 #2559 #2562
#2578 #2592 #2593 (closed 2026-08-13 via #2646)

# merge receipts
#2681 APNs squash merge_commit 72361e54  2026-08-13T20:22:06Z
#2662 waves 2-3 / order cancel
#2647 customizable tabs
#2656 ITSAppUsesNonExemptEncryption / iOS 18 ship
```

No app code.  lint/tsc/test/build not run.

## 5. Next Steps & Blockers

Returning Monet (or any seat with `gh` + search-replace):

1. Insert the Planned rows in §7 onto `/Users/jay/apps/TRADING-EFFORT-LOG.md` and
   the worktree `docs/EFFORT-LOG.md`.
2. Close `#2560` with the comment in §6.
3. Pick a P0/P1 leftover.  Do not rebuild waves 1-4.

## 6. Zero-Code Findings — prioritized leftovers

### P0 (ops / money-adjacent, still real)

| Item | Evidence | Status |
|---|---|---|
| Litestream L2 compaction wedge regenerates (L2 frozen ~2026-08-08, L1 ~08-10).  Data safe; ~90k files accumulate; restores slower. | Monet compact summary §5 "Ongoing".  Backup-monitor (#2665) shipped the *observation*, not the wedge fix. | No issue. |
| APNs code is on main; **device delivery is unverified**.  Confirm four `APNS_*` values in ST prod Infisical (length only) + a TestFlight tap. | `#2681` `72361e54`.  Monet: "End-to-end delivery STILL unverified". | No issue. |
| Green-Team empty/malformed HTTP-200 still dies instead of failing over; credits-low should be named on `run_failed`. | **#2577** open, 0 comments. | Issue exists. |
| Deploy-freshness alert (page when `origin/main` is ahead of `/api/health` sha >1h). | **#2545** still open.  Incident host is gone; silent-freeze class is not. | Issue exists.  Do not close. |

### P1 (filed or promised, still valid, not built)

| Item | Evidence | Status |
|---|---|---|
| Settings-search catalog fully built, zero UI consumers; phantom `defaultLandingAccount`. | **#2558** open.  `searchSettings` imported only by `test/settings-search-index.test.ts`. | Issue exists. |
| Console a11y: light-theme chip contrast, Sheet Escape closes stacked surfaces, tooltip/columns popover. | **#2561** open, 0 comments. | Issue exists. |
| CT/UM consumer backoff + non-blocking timeouts.  Alert rollup was done in wave C. | **#2550** open.  Partial: `#2555` mute/rollup closed; Claude `health-alert-noise` claimed separately. | Leave #2550 open.  Do not double-book. |
| iOS watchlist quotes + mini symbol drilldown. | Parity review item 10.  Monet never filed. | No issue. |
| Mobile `order.replace_market` (stale-limit replace).  Cancel landed; replace was out of scope. | Parity item 3; cancel rollout: "replace-at-market deliberately out of scope". | No issue. |

### P2 (real, lower leverage)

| Item | Evidence | Status |
|---|---|---|
| Widget + Live Activity (read-only glance; no Approve in a widget). | Parity item 9.  Depends on APNs + App Group cache. | No issue. |
| Wire curl-only admin surfaces (tuning-dry-run, learning-ledger, backtest-ic, `/api/audit`). | **#2563** open. | Issue exists. |
| Usage page: attribute embedding/rerank spend. | Review D4.  Never filed. | No issue. |
| Red Team prompt compaction (60-80K input). | Review D5.  Never filed. | No issue. |
| Robinhood MCP `symbol`/`symbols` schema drift. | **#2576** open.  Already claimed by `[FLEET][GROK] Resolve recent Pushover/Sentry/Uptime alerts`. | Do not double-book. |

### Settled — do not reopen

- iOS waves 1-4 (tabs, wave 1 fields/protective/run-state, wave 2 tighten + catalog + AASA, wave 3 cancel, wave 4 APNs).  PRs include `#2647`, `#2662`, `#2681`.
- Review-fix waves A-D (`#2547` `#2548` `#2549` `#2551-#2557` `#2559` `#2562`).
- `#2546` R2 pause: closed 2026-08-07 after B2 cutover.  Residual is the L2 wedge, not "no backup".
- APNs `.p8`: keep only `~/.secrets` (`chmod 600`).  Repo copy was deleted by the owner.  UM App ID lacks Push Notifications — that is why UM is not a key target on the Apple developer page.

### `#2560` — proven merged, still open

Close with:

> Merged.  Close-only / Wind Down shipped in iOS wave 1.  APNs is `#2681` squash `72361e54` (2026-08-13).  Universal links + AASA in `#2662`.  `ITSAppUsesNonExemptEncryption=false` in the iOS ship pipeline (`#2656` / `ios-ship.yml`).  Residual (console handoff links, privacy manifest polish, TestFlight e2e push) is tracked on the 2026-08-13 pickup leftover board, not this batch issue.

## 7. Board rows to insert (not applied from this seat)

Insert under `## Planned / Reserved Before Implementation` (do not delete other rows):

```
- **[Socratic-Trade][GROK] Monet audit leftovers hygiene 2026-08-13 — PLANNED / DOCS.** Waves 1-4 + APNs are MERGED (#2647 #2662 #2681 `72361e54`). Do not reopen. Close #2560 with that receipt. Open leftovers: #2545 #2550 #2558 #2561 #2563 #2577. Rollout: `docs/rollouts/2026-08-13-pickup-audit-leftovers.md`.
- **[Socratic-Trade] Litestream L2 compaction wedge (regenerates after reset) — PLANNED / UNASSIGNED.** L2 frozen ~2026-08-08, L1 ~08-10. Monitor shipped; wedge not fixed. No issue.
- **[Socratic-Trade] APNs e2e verify (TestFlight + Infisical APNS_* ) — PLANNED / UNASSIGNED.** Code on main via #2681. Device delivery unverified. Keys in ~/.secrets chmod 600, not repo. UM App ID has no Push capability.
- **[Socratic-Trade] Green-Team empty-response failover + credits-exhausted hint — PLANNED / UNASSIGNED.** Issue #2577.
- **[Socratic-Trade] Deploy-freshness alert (main ahead of prod >1h) — PLANNED / UNASSIGNED.** Residual of #2545. Oracle incident is over; silent-freeze class remains.
- **[Socratic-Trade] Wire settings-search catalog into command palette — PLANNED / UNASSIGNED.** Issue #2558. Drop phantom defaultLandingAccount.
- **[Socratic-Trade] Console a11y batch (light chips AA, Sheet Escape stack, tooltip/columns) — PLANNED / UNASSIGNED.** Issue #2561.
- **[Socratic-Trade] iOS watchlist quotes + mini symbol drilldown — PLANNED / UNASSIGNED.** Parity review item 10. No issue.
- **[Socratic-Trade] Mobile `order.replace_market` (stale-limit replace) — PLANNED / UNASSIGNED.** Cancel landed #2662; replace was out of scope. No issue.
- **[Socratic-Trade] iOS Widget + Live Activity (read-only glance) — PLANNED / UNASSIGNED.** Parity item 9. Depends on APNs + App Group snapshot cache. No Approve in a widget.
- **[Socratic-Trade] Wire curl-only admin surfaces (tuning-dry-run, learning-ledger, backtest-ic, /api/audit) — PLANNED / UNASSIGNED.** Issue #2563.
- **[Socratic-Trade] Usage page: attribute embedding/rerank spend — PLANNED / UNASSIGNED.** Review D4. No issue.
- **[Socratic-Trade] Red Team prompt compaction (60-80K input) — PLANNED / UNASSIGNED.** Review D5. No issue.
```

Insert under `## In Progress` (hygiene only, do not delete Monet rows):

```
- **[Socratic-Trade][GROK] Pickup hygiene: Monet iOS waves 1-4 + APNs rows below are MERGED (PRs #2647 #2662 #2681 `72361e54`).** Do not reopen. Leftovers in Planned + `docs/rollouts/2026-08-13-pickup-audit-leftovers.md`.
```

Do not add a new row for `#2576` (already claimed by fleet-alerts GROK).

## 8. Zero-Code Findings (hygiene)

This seat: no GitHub write, no surgical board edit.  Inventory is complete.  Implementation not started.
