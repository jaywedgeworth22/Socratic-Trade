# 2026-07-19 — Handoff: CLAUDE seat → Antigravity (all tasks from tonight's session)

Owner-directed handoff. This note is the single source of truth for what's done, what's
in-flight, and what's blocked. Written from the CLAUDE seat at ~08:00Z 2026-07-19.

## Summary

A long multi-part session: disk cleanup, MCP server verification/repair, a full open-PR-queue
sweep (billing-blocked GitHub Actions → rerouted to self-hosted Coolify runner), and landing the
consolidated bge-m3 program branch. Nearly everything is done. **One PR is still mid-flight and
two infra items need owner action.**

## Still in-flight — do not duplicate

**PR #1775** (`agent/ag-reindex-bge-m3` → main), head `6fc373c9`. Auto-merge (squash) is armed.
As of this note: OPEN, mergeStateStatus BLOCKED (checks running, not failing), runner
`coolify-hetzner-socratic-ci` shows busy — checks are actively executing.

A **CLAUDE-seat background agent is currently shepherding this PR to merge** (retry discipline on
infra-class check failures, `gh pr update-branch` on BEHIND, escalate-not-patch on any real
code-class failure). It also owns post-merge closeout: worktree removal
(`.claude/worktrees/land-ag-reindex-bge-m3`), effort-board completion row, and measuring whether
the post-merge auto-deploy actually fires (see wedge below).

**Antigravity: check `gh pr view 1775 --repo jaywedgeworth22/Socratic-Trade` and #agent-sync
before touching this PR.** If it's already MERGED, this task is done — verify via the effort
board / Slack closeout post. If it's still open and the CLAUDE seat has gone quiet (no
#agent-sync activity for >1h), the shepherd likely died with the session; pick it up using the
"still in-flight" procedure below rather than starting a competing shepherd.

What was fixed to get this PR here (context if you need to re-verify): three real test-suite bugs
found across three consecutive `land.sh` gate runs — (1) `test/reindex-all.test.ts` was bleeding
SQLite state across test files via a shared `DATABASE_URL`, now isolated; (2) the branch had
wrongly aligned a company-name-casing test expectation to a bug that PR #1735 fixed on main
(`clean()` uppercasing vs `normalizeCompanyName()` preserving case) — resolved by the main merge;
(3) `test/alpha-vantage-quota-alert-cooldown.test.ts`'s `flushBackgroundAlert()` helper raced
under full-suite core saturation — a fixed 50ms nap wasn't enough for the fire-and-forget alert's
cooldown write to land, causing a spurious duplicate-alert failure; fixed by polling for the
persisted cooldown row (bounded ~5s) instead. Full history:
`docs/rollouts/2026-07-18-bge-m3-reindexing.md` ("Landing retry" section) + git log on the branch.

## Owner-blocked — cannot be resolved by any agent right now

1. **Coolify API token is dead.** Every `https://host.jays.services/api/v1/...` call returns 401
   (it worked earlier tonight). No agent can inspect or trigger Coolify deploys/services until the
   owner reissues the token and updates `COOLIFY_API_TOKEN` in `~/.secrets/global-api-keys`. Do
   NOT attempt to hunt for or guess a replacement token.
2. **Prod deploy pipeline is wedged.** `main` advanced to `79803667` (a docs-only push at
   2026-07-18 23:54 CDT / 2026-07-19T04:54Z) and never deployed — prod is still running the prior
   release `7be71390` (deployed 01:41Z) as of this note, hours later. `merge == live` is
   currently **broken** for this repo. Root cause not confirmed (token is dead, so deployment
   history is uninspectable) — leading theory is a stuck/zombie deployment on the shared Hetzner
   box, same failure class as the 2026-07-10 litestream/tcp_mem incident, but NOT the same trigger
   (litestream is healthy, confirmed via `/api/health`). **Prod itself is healthy right now**
   (`ok: true`) — this only blocks *new* code from shipping, it is not a live incident.
3. Both items posted to #agent-sync already; re-post only if genuinely new information emerges.

## Root-caused, fix recommended but NOT executed (needs owner call)

CI runner network failures (a `check-pin` job's `git fetch` retried 3x over ~43 min before dying
with RPC/EOF errors) were diagnosed by a dedicated read-only investigation. Ranked verdict: **host
contention**, not a network-layer bug — `coolify-hetzner-socratic-ci` is deliberately the most
resource-starved container on the box (3072 MiB cap, `cpu_shares=256`, `oom_score_adj=600` —
preferred OOM-kill target, per `docs/rollouts/2026-07-18-coolify-ci-runner-routing.md`), and the
failure window overlaps suspiciously with the same window the 04:54Z deploy should have been
building. Recommended durable fix: **prevent the CI runner and a Coolify deploy build from running
heavy work concurrently on the same box** (queue/gate them, or delay auto-deploy dispatch briefly
after a push). This is an infra-policy decision for the owner, not something to implement
unilaterally — flag it, don't build it, unless directed.

## Fully complete tonight (verify via `gh pr list --state merged` if you want proof, but don't redo)

- **PR queue cleared**: #1728, #1733, #1735, #1736, #1737, #1738, #1739, #1740, #1741, #1742,
  #1745 all merged. Root cause of the original mass-CI-block was a **GitHub Actions billing hold**
  (owner account, not code) — worked around by rerouting required checks to the self-hosted
  Coolify runner (Codex's PR #1739 landed this; a duplicate CLAUDE-seat branch was caught and
  killed before push — see `docs/rollouts/2026-07-18-ci-self-hosted-billing-fallback.md` for the
  root-cause writeup, though its self-hosted fix was superseded by #1739's more complete version).
  GitHub Actions billing itself is still unresolved (owner action, Settings → Billing & plans) —
  low priority since the Coolify workaround works.
- **MCP server sweep**: Infisical/Coolify/FMP/Pinecone/Sentry/Hetzner/GitHub/Wrangler/Voyage all
  verified working (Voyage confirmed via a live embeddings API call, not just config presence).
  Owner-blocked items: Alpaca (missing `ALPACA_API_KEY`/`ALPACA_SECRET_KEY`), OAuth via `/mcp` for
  Cloudflare plugin + OpenRouter (both workspaces) + Robinhood.
- **Disk-janitor upgrade** (`~/.claude-disk-janitor/janitor.sh`, owner-directed): `PRESSURE_FREE`
  raised 42→48 GiB so the idle-worktree dependency-reap tier engages closer to "under ~50G free"
  rather than waiting for deep pressure — confirmed firing correctly tonight (log shows
  `idle-dep-reap` ticks as free space oscillated 33–49G under fleet load). Worktree **retirement**
  (not just dep-reap) was silently broken for months: dozens of long-dead worktrees carried only
  untracked `node_modules`/`.next`/build junk and so never registered as "clean" under a literal
  `git status --porcelain` check. Added `wt_blocking_dirt()` — ignores exactly that generated
  junk class, still blocks on any tracked change or real untracked file. Dry-run validated
  (`WT_REAP_DRYRUN=1`); zero false-positive retirements. Live retirement will surface naturally
  as worktrees cross the 7-day-idle bar on normal 30-min ticks — nothing further to do.
- **Board hygiene**: 4 stale rows on `/Users/jay/apps/TRADING-EFFORT-LOG.md` corrected in place
  (PRs #1738/#1739/#1740 were still labeled In-Progress/Landing despite being merged).
- **General disk cleanup**: ~9GB of dead `/tmp` scratch removed directly; free space partly
  recovered via the janitor's now-more-aggressive tiers. Current free space: **33Gi** (down again
  tonight from earlier highs — expected, this is a very active multi-agent box; the janitor is
  actively working it, not stuck).

## Files touched tonight (for context, not exhaustive)

- `~/.claude-disk-janitor/janitor.sh` — thresholds + `wt_blocking_dirt()` (see above)
- `~/.claude.json` — added `robinhood`, `sequential-thinking`, `render`, `github`, `hetzner` to
  user-scope `mcpServers`
- `agent/ag-reindex-bge-m3` branch — 3 test fixes (see "Still in-flight" above)
- `/Users/jay/apps/TRADING-EFFORT-LOG.md` + `docs/EFFORT-LOG.md` — multiple entries/corrections
- This file

## Recommended next actions for Antigravity, in order

1. Check PR #1775 state (see above) before doing anything else in this repo.
2. If idle/no urgent user ask: nothing else is actually blocking work — the repo is healthy,
   prod is healthy, the PR queue is clear. The two owner-blocked items (token, deploy wedge) are
   not agent-actionable; don't spin trying to route around them.
3. If the owner asks about deploy status: point to this note's "Owner-blocked" section rather than
   re-diagnosing from scratch — the investigation is fresh (this session).
