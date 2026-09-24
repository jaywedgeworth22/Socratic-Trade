# Handoff: CLAUDE session (2026-07-19) → Antigravity

Full state of an owner-directed multi-day execution program: a top-to-bottom expert
review of Socratic-Trade, the Codex 46-item audit fix wave, a bge-m3 embedding
migration + RAG backfill program, and an EarningsCalls transcript program. This note
is the single source of truth for picking the work up cold — read it before touching
any of the branches below.

**Ground truth at handoff time** (re-verify before acting — this drifts fast):
- Production: `socratictrade.com` healthy, exact SHA `7be71390`, `ragEmbedProvider: openrouter`
  (bge-m3 is the live embedding model).
- Open PRs of interest: **#1777** `claude/corpus-reembed-hardening` — auto-merge ARMED,
  checks still dispatching (not stuck, just queued on the self-hosted runner).
- All other CLAUDE lanes below have **NO PR opened yet** — only local commits with
  effort-log/STATUS docs already added. They need `bash scripts/land.sh` run in their
  worktree to open PRs.
- Two worktrees have **uncommitted work** — see §3.

## 1. Standing fleet HOLD (do not lift until told)

Posted to #agent-sync: **do not run `POST /api/admin/reembed {action:'purge-legacy'}`
or any `symbols`-scoped corpus re-embed run** until PR #1777 (`corpus-reembed-hardening`)
merges and its prod deploy is verified. The code currently live in prod (absorbed from
my `corpus-reembed` design by another agent, PR #1764) has a **proven exploit**: a
symbol-scoped or partial re-embed run can satisfy the purge-completion gate, letting
purge-legacy delete voyage vectors that were never actually re-embedded into the bge-m3
space. #1777 fixes this (revision-namespaced watermarks, live-identity dedup, insider-form4
PIT fix) with an inverted exploit test proving the fix. **Once #1777 merges + deploys,
lift this hold** (post to #agent-sync) and only then proceed with the corpus re-embed /
backfill sequence in §5.

## 2. Ten Codex-audit + bge-m3 lanes — all built, adversarially verified, must-fixes applied

Owner directive: reindex all filings on baai/bge-m3, work the RAG/filings backlog, and
fix every item in a 46-item Codex review (docs/reviews/2026-07-18-backlog-clearing-plan.md
has the full disposition map). All ten lanes below are **code-complete, tested, and
adversarially verified** (a second agent tried to break each diff before it was allowed
to land — this caught 6 real defects that green test suites missed, all now fixed with
regression tests proving the fix). They need **landing** (`bash scripts/land.sh` in each
worktree, in the order below, since several share touched files):

| # | Branch | Worktree | Head | What / Codex items | Verify verdict |
|---|---|---|---|---|---|
| 1 | `claude/corpus-reembed-hardening` | `agent-a5c7fde1cd1e58641` | `ac6b6a31` | Purge-gate/identity/PIT hardening on the live-absorbed corpus-reembed code | 3 MUST-FIX found + fixed, exploit test inverted, 92/92 green — **PR #1777 open, auto-merge armed** |
| 2 | `claude/egress-ssrf-body-caps` | `agent-a4666c12105896819` | `4d50c23c` | Codex 11/13: SSRF egress guard (broker baseUrl allowlist + webhook DNS/IP checks) + streaming body caps + module-scope Apple JWKS | SAFE, 0 must-fix, 3 advisories (rebind-pin comment, save-time validation gap on 2 secondary routes, extend cap pattern) — **needs PR opened** |
| 3 | `claude/sec-ingest-worker-wiring` | `agent-af7fb4212d148a06c` | `58018cc8` | Codex 2/3/4: manifest schema fix + regenerated committed artifact + CI validation test, manifest→jobs seeder (dead-letter safe), SecIngestWorker startup + admin route | SAFE, 92/92, 1 advisory (manifest sentinel data unflagged — now fixed separately, see §4) — **NOTE: this code was largely absorbed onto main already (PR #1764/#1775 area) — check for duplication before landing, may be a docs-closure only** |
| 4 | `claude/ops-display-truth-batch` | `agent-a063b6c5961d64b43` | `eb4e9779` | Codex 43(partial)/45/46: executed-qty display, OpenRouter model branding fix, copy-quality fixes (ADR names, universe labels, doubled punctuation, RAG coverage labels). Item 33 correctly ceded to CODEX's `#1751` server-metrics rewrite (already merged) | SAFE, 0 must-fix, minor test-coverage advisories — **needs PR opened** |
| 5 | `claude/stop-coverage-alpaca-tif` | `agent-acf59a9fecaed9c26` | `08983933` | Codex 7/10: fixed/ATR synthetic-stop backstop when no broker bracket exists + Alpaca fractional-GTC→day normalization | 1 MUST-FIX found + fixed (short stop-tier fallback skipped the `stopLossPct` tier, would have placed a real unintended cover — now uses the 3-tier fallback exactly like the proactive layer), 70/70 green — **needs PR opened** |
| 6 | `claude/cf-jwt-enckey-fingerprints` | `agent-ace9ba75508810be1` | `e9f45c8e` | Codex 12/14/15: Cloudflare Access JWT validation (was trusting an unverified header), ENCRYPTION_KEY prod boot-refusal + versioned ciphertext + plaintext migration sweep, key fingerprints replacing masked-key display | SAFE, 0 must-fix, proved via a keyless full build that the new boot guard can't fire during CI/Coolify build (only at container start) — **needs PR opened** |
| 7 | `claude/stop-intent-idempotency` | `agent-aec1758ee2b7636e0` | `8d8a19de` | Codex 5/6: durable pre-network broker-stop placement intent + atomic idempotent recovered-fill booking. Manually merged with PR #1738 (already-merged sibling fix) per a verified keep-both resolution map. Migrations v53/v54 | 1 MUST-FIX found + fixed (accepted order filling before next tick dropped the fill and re-placed a stale-sized stop — now books via a 9th transaction site + defers), 250/250 green — **needs PR opened; HIGH PRIORITY money-path, land promptly** |
| 8 | `claude/decision-status-truth-fix` | `agent-a76603c7aabd157d7` | `75f6e87a` | Codex 22/23/24/26/29: temporal Red Team review labels, day-P&L baseline gap display, provider freshness-vs-availability split, scan count decomposition, running-vs-paused-market-closed status | 1 MUST-FIX found + fixed (account-switcher showed "Paused" for genuinely-running extended-hours accounts — now undefined-safe), 116/116 + 13/13 green — **needs PR opened** |
| 9 | `claude/ios-client-fixes` | `agent-a9f2947b97abdcd2e` | `4738e464` | Codex 30/31/32: native iOS typed live-approval confirmation (mirrors PWA), SSE frame parsing + reload coalescing, 401/403-only logout | Reviewed by reading (no compiler available for iOS SDK — only parse + macOS-typecheck); **owner should do one manual Xcode build + one live-approval test before fully trusting** — **needs PR opened, in progress per last report (gate chain running)** |
| 10 | `claude/bge-m3-metering-gate` | `agent-aac8181c7e70afb86` | `0a4a82c3` | Provider-aware RAG metering (fixed a live bug: bge-m3 usage was billed at Voyage's ~10x rate under `provider='voyage'`), explicit `RAG_EMBED_PROVIDER` gate, provider-aware `/api/health` probe (fixed a live 503) | SAFE, 0 must-fix — **ALREADY MERGED as PR #1766 → main `5f0323f7`, deployed, verified.** This row is done; the worktree still has local commits, safe to discard/ignore. |

**Landing order recommendation** (respects file overlaps — corpus-reembed-hardening and
sec-ingest-worker-wiring both touch RAG plumbing; stop-intent/stop-coverage/cf-jwt all
touch `db.ts` migrations):
1. `corpus-reembed-hardening` (#1777, already in flight — just watch it merge + deploy-verify, then lift the HOLD in §1)
2. `sec-ingest-worker-wiring` (check for absorption/duplication first)
3. `egress-ssrf-body-caps`
4. `ops-display-truth-batch`
5. `stop-coverage-alpaca-tif`
6. `cf-jwt-enckey-fingerprints`
7. `stop-intent-idempotency`
8. `decision-status-truth-fix`
9. `ios-client-fixes` (independent of the above; safe to land any time in parallel)

**Per-lane landing procedure** (each worktree already has its docs commit — `docs: effort-log
+ status for <branch>` — done, do NOT redo): `cd` into the worktree, `export
PATH=/opt/homebrew/opt/node@24/bin:$PATH` (node24 required — default node26 breaks
better-sqlite3), `bash scripts/land.sh` (merges main, runs lint/tsc/test/build, pushes,
opens PR), then `gh pr merge <n> --squash --auto` if not already auto-merge-armed, then
**deploy-verify**: poll `https://socratictrade.com/api/health` until `release.sha` matches
the new merge commit before considering the lane done (merge == auto-deploy on this repo).

## 3. Uncommitted work — finish or discard, do not lose

- **`agent-a9a1f0844bec6960a`** (`claude/advisory-cleanup-batch`, 19 dirty files, 0 commits
  yet): implements 4 verifier-advisory follow-ups — declare the `jose` npm dependency
  (currently a phantom resolving only via `@auth/core`), flag the RAG universe manifest's
  sentinel data with a machine-checkable `dataQuality` field, halve SEC discovery requests
  in the ingest seeder (was calling `fetchRecentFilings` twice per issuer for the same
  URL), rename the Voyage-labeled RAG health lanes to be provider-generic. Per its last
  report: tsc clean, scoped lint clean, 165/165 targeted tests green, was waiting on a
  full-suite + production-build run to finish before committing. **Action: check the
  worktree, let the pending run finish (or rerun `npm test` / `npm run build`), commit
  with the noreply author email, then land like the others above (low risk, no PR yet).**
- **`agent-aff653de5c9fda068`** (`claude/earningscalls-burst-smart-daily`, 14 dirty files,
  0 commits): implements the EarningsCalls transcript program — see §6, this is a live
  in-progress build, not yet verified. Check for a completion report before acting; if it
  died mid-run, resume it or re-dispatch a fresh implementer with the same brief (the
  design memo at `docs/rollouts/2026-07-19-earningscalls-burst-smart-daily.md` if it wrote
  one, or reconstruct from §6 below).

## 4. Fixed already, no action needed

- `PR #1770` (MONET, merged): `/api/health` now exposes OpenRouter prepaid-credit balance.
  UptimeRobot monitor "OpenRouter credits low" (keyword, threshold $10) is live and green
  (currently ~$49 remaining).
- `PR #1771` (MONET, open): fixes a SiliconFlow bge-m3 price-table bug my verifier
  originally filed — not mine to land, just don't duplicate it.
- `RAG_EMBED_PROVIDER=openrouter` — set directly in Infisical prod (Socratic-Trade
  project `39d93bb7-76f9-498c-8b50-a7def52e072f`, env `prod`) by me this session. Already
  live (confirmed in prod health above). No action needed.
- UptimeRobot monitors added this session (all UP): `congress.trade` health,
  `host.jays.services` (Coolify control plane) health, on top of the pre-existing
  Socratic + Usage Monitor monitors. Full fleet coverage now exists — no action needed
  unless adding a new app.
- EarningsCalls RapidAPI subscription — owner confirmed already subscribed; prod health
  shows the `earningscalls` dependency fully `ok:true` (no degraded flag). Do NOT assume
  transcripts are actually flowing yet, though — see §6's entitlement-probe risk.

## 5. Post-landing ops sequence (after §2 lanes land, especially #1)

From `docs/reviews/2026-07-18-backlog-clearing-plan.md` §3 — the RAG/filings backlog is
~99% un-ingested (Pinecone corpus was 8,476 vectors vs a 600k–1.2M target baseline; AG's
`agent/ag-reindex-bge-m3` lane did run a production re-embed via `scripts/reindex-all.ts`
already, per #agent-sync — verify actual corpus coverage before assuming more re-embed
work is needed):
1. Lift the fleet HOLD (§1) once `corpus-reembed-hardening` deploys.
2. Verify `rag_usage` rows now stamp `provider='openrouter'` correctly (the metering-gate
   fix, already live).
3. Check current Pinecone vector count / coverage via `/api/admin/rag-coverage` — AG's
   reindex may have already substantially filled the gap; don't blindly re-run.
4. If backfill is still needed: flip `SEC_INGEST_WORKER_ENABLED=1` in Infisical, seed a
   25-issuer pilot via `POST /api/admin/sec-ingest {action:'seed', limit:25}`, watch
   receipts/dead-letters for ≥1 day, then raise `RAG_INGEST_MAX_TEXTS_PER_DAY` to ~100k
   and seed the remaining ~975 issuers (projected 6–12 days, ~$7.50 total embed cost on
   OpenRouter's bge-m3 pricing).
5. Only after full coverage is verified: run the explicit `purge-legacy` action to remove
   dead Voyage vectors (never automatic, requires the exact confirm token).

## 6. EarningsCalls transcript program (owner directive, in progress)

Owner wants: 25 high-value transcripts ingested now (one-time burst), then 5/day ongoing
with smart selection, keeping ~25 requests/month as spare headroom under the RapidAPI free
plan's hard 200/month cap.

**Critical recon finding** (memo, if not yet committed, was at a scratchpad path this
session — reconstruct if lost): the live EarningsCalls.dev API has **no direct
symbol+fiscal-year+fiscal-quarter transcript endpoint**. Real costs: a shared
`/transcripts/recent` cursor-listing amortizes daily discovery to ~1 request, so 5
transcripts/day ≈ 6 requests; a 25-transcript burst (recent-favoring) ≈ 27 requests. The
owner's budget shape still works under a **rolling-31-day dispatch ledger** (dual bound:
monthly soft 180 + rolling 195), which is safer than the old fixed 6-per-pass ceiling.

**Program-blocking risk found**: the free RapidAPI plan may serve **250-character preview
text**, not full transcripts — unverified. The design mandates an **entitlement probe**
(2 requests: `/me` + one real fetch) before any burst or daily pass; on preview detection,
the program must refuse and notify the operator once (not retry-storm), because ingesting
250-char stubs into the fetch-once-forever cache would poison the corpus permanently.

Implementation brief given to the builder (branch `claude/earningscalls-burst-smart-daily`,
worktree `agent-aff653de5c9fda068`, currently dirty/uncommitted — see §3): entitlement
probe + preview guard (raise `MIN_TRANSCRIPT_CHARS` well above 250, ~1200, env-overridable,
non-preview bodies only get cached/ingested), rolling-ledger budget, a smart scorer
(holdings-weighted > earnings recency > scan-candidate rank > watchlist > universe-manifest
rank tail) with a persisted per-day audit of picks+scores+rationale, a one-shot
`earningscalls_burst_pending=25` internal-settings flag that the scheduler consumes
automatically on its next tick post-deploy (idempotent), and an admin route
`POST /api/admin/earningscalls {action:'burst'|'probe-entitlement'|'clear-entitlement-block'}`.
**Check the worktree for a completion report; if incomplete, this needs finishing before
it can land — do not skip the entitlement probe, it's the thing preventing silent corpus
poisoning.**

## 7. Deferred Codex-audit wave (not started / partially started)

Two lanes dispatched this session, both off current main (independent, low collision risk):
- **`claude/test-network-isolation`** — Codex item 37 (tests make unexpected live SEC
  requests to `company_tickers.json`; needs a deterministic CIK resolver injection + a
  vitest network-call guard that fails fast on unexpected outbound requests). Last report:
  finished its native `npm ci`, was about to run tsc/tests. Check for completion.
- **`claude/advisory-cleanup-batch`** — see §3, in progress uncommitted.

**Not yet started at all** (from the full Codex-46 disposition map in
`docs/reviews/2026-07-18-backlog-clearing-plan.md` §5 — these are legitimate next-wave
work, roughly in priority order):
- **Items 18–21 (decision-quality cluster, largest remaining chunk)**: immutable
  per-field decision-time evidence snapshot (18 — live evidence contradicted trade
  rationale, e.g. a proposal claiming ~14% dividend yield when the scan showed 5.26%);
  anomalous-data quarantine before scoring/prompts (19 — a Red Team explicitly flagged an
  FCF figure as a likely data artifact but approved anyway because the prose only claimed
  "positive FCF"); persisted decision-time portfolio receipt + fact-checking Red Team's
  own generated statements (20 — Red's stated portfolio composition didn't match the live
  account); bounded Red Team review retry/failover with a visible retry state + one-click
  manual retry before expiry (21 — two proposals sat pending ~a day with no verdict after
  a review timeout).
- **Item 27**: per-field freshness/staleness display on the market scan (distinguish
  stale-but-retained from genuinely unavailable).
- **Item 34**: prominent cost-surface banner when usage telemetry is degraded.
- **Items 39–42 (UX cluster)**: skip/reduce the branded intro animation for returning
  authenticated users + accessible content-shaped skeleton; collapse decision-card model
  prose behind evidence-aware sections; split the oversized Settings page + parallelize
  its loading waterfalls; Usage page information-architecture cleanup (search, trend
  charts, clearer cost-vs-billing distinction).
- **Item 44**: resolve broker "capabilities unconfirmed" at connection-validation time;
  remove a dead keyboard-stop handler in `app/console/settings/brokers.tsx`.
- **Item 43 (remainder)**: orders lifecycle grouping (bracket/OCO parent+legs), filters,
  search, export, pagination — the executed-qty/copy slice already shipped in
  `ops-display-truth-batch` (§2 row 4), this is the larger remaining piece.

## 8. Where to read more

- `docs/reviews/2026-07-18-backlog-clearing-plan.md` — the full quantified RAG backlog
  analysis + the complete 46-item Codex disposition map (what's fixed, what's deferred,
  what's owned by other lanes).
- `docs/rollouts/2026-07-18-*.md` and `docs/rollouts/2026-07-19-*.md` — per-lane rollout
  notes with exact files/tests/verification commands for every row in §2.
- `/Users/jay/apps/TRADING-EFFORT-LOG.md` (live board) and `docs/EFFORT-LOG.md` (repo
  mirror) — updated with rows for all of the above; keep them current as you land things.
- #agent-sync channel history — the fleet HOLD announcement, the metering-gate
  deploy-live warning, and this session's claims are all there for context.

## 9. Standing coordination notes

- Fleet is very active on other repos (Congress.Trade, Usage-Monitor/API-usage-monitor)
  doing an Oracle cloud cutover and effort-log normalization — unrelated to Socratic-Trade,
  safe to ignore unless a message explicitly names this repo.
- CODEX has been actively fixing CI-runner routing and landing its own Socratic-Trade
  lanes in parallel (PRs #1751, #1759, #1761, #1775, #1776, #1778, #1779 in the list
  above) — check for overlap before assuming any given file is untouched.
- Two PRs I don't recognize from this session appeared during handoff prep: **#1780
  `claude/checkpin-always-on-prs`** and **#1781
  `claude/model-availability-session-handoff-362fd3`** — these look like a possibly-parallel
  CLAUDE seat session; check their content before touching, they may already be someone
  else's active work.
