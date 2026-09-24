---
name: land-lane
description: Land a feature branch to main via the fleet worktree-and-script procedure; handles docs, verification gate, and auto-deploy consequences.
---

# Land a Feature Branch to Main

Use this procedure to merge a feature branch into `main` safely across the multi-agent fleet. **Do not run this from the main integration worktree** (`~/Code/Socratic-Trade`) **or from branch `main`** -- `land.sh` refuses to run from either.

## Preconditions

1. You are in your own agent-seat worktree (e.g., `~/apps/trading-claude`, `~/apps/trading-codex`).
2. Your branch name is seat-prefixed (e.g., `agent/claude/feature-name`, `ag/update-shared-v1.6.0-retry`).
3. `git status` is clean -- no uncommitted changes or untracked files (except `.env.local`).

## Node Version Trap (Critical)

Homebrew's default `node` is v26 since 2026-07-10. `better-sqlite3` prebuilds are pinned to Node 24 (MODULE_VERSION 137). Before running the gate, confirm `node --version` shows v24.x; if not:

```bash
export PATH=/opt/homebrew/opt/node@24/bin:$PATH
node --version                    # verify
npm rebuild better-sqlite3        # only if node_modules was built under v26
```

## Update Docs (Before Landing)

1. Open `docs/EFFORT-LOG.md` and locate your effort row. Move it from **In Progress** to **Completed** with a one-line status.
2. Update `STATUS.md`: add a stanza describing what landed and the next action.
3. Create `docs/rollouts/YYYY-MM-DD-slug.md` with:
   - Summary: what changed
   - Why: decision or context
   - Files: exact touched paths
   - Verification: exact commands run + any failures
   - Follow-ups: remaining work or risks

## Git Identity

Confirm `git config user.email` outputs `12656028+jaywedgeworth22@users.noreply.github.com`. If not, set it:

```bash
git config user.email "12656028+jaywedgeworth22@users.noreply.github.com"
```

## Gate and Land

With Node 24 on your PATH:

```bash
PATH=/opt/homebrew/opt/node@24/bin:$PATH bash scripts/land.sh
```

This script (idempotent):
- Refuses to run from the `main` integration worktree or branch `main`, and refuses a dirty tree
- Fetches origin, then **refuses to auto-merge if your branch and origin/main touched the same files** since the branch forked (a stale-overlap guard, distinct from a real git conflict) -- it prints the overlapping files and asks for a deliberate manual merge/review before retrying
- Merges origin/main (aborts with resolution instructions on a real conflict)
- Runs `npx tsc --noEmit` -> `npm test` -> `npm run build`
- Pushes your agent branch and opens a PR via `gh`

**If land.sh fails on docs:** `STATUS.md`, `PLAN.md`, and `docs/EFFORT-LOG.md` carry `merge=union` in `.gitattributes`, so concurrent additive edits combine instead of conflicting. Re-run after resolving whatever remains. Up to 3 attempts acceptable.

## Arm Auto-Merge

Once the PR is open and `verify` CI passes:

```bash
gh pr merge <PR-NUMBER> --squash --auto
```

**Not `--admin`** -- per AGENTS.md, it does not bypass the required-check ruleset on this repo.

## Know the Consequences

- **Merge-time behavior:** the instant `verify` passes and all review threads resolve, the PR auto-merges -- no further approval needed.
- **Auto-deploy is on** (owner-directed, 2026-07-10): the merge webhook fires immediately and Coolify builds/swaps the container in roughly 1-2 minutes. The ANNOUNCE-THEN-DEPLOY protocol is retired -- do not post deploy claims or manually trigger a Coolify deploy. Details: `docs/rollouts/2026-07-10-auto-deploy-on.md`.

## Workflow-File Pushes

If your branch touches `.github/workflows/*`, `land.sh` checks whether your `gh` token has the `workflow` OAuth scope. If it's missing, the script dies with instructions; the fix is to add the scope once, then re-run:

```bash
gh auth refresh -h github.com -s workflow
bash scripts/land.sh
```

`git push` goes through `gh auth git-credential`, so once the scope is present the normal push just works -- no separate SSH remote needed. The `ci-pending/` staging directory is only a fallback for the rare case the scope truly cannot be granted.

## Coordination (Multi-Agent)

If the box is under load (multiple lanes gating simultaneously), post per the repo-first format in `/Users/jay/apps/AGENT-SYNC.md`, e.g.:

```bash
bash scripts/slack-sync.sh post "repo: Socratic-Trade | [SEAT->FLEET] gating now"
```

After the gate completes, post a one-line follow-up (`gate done`).

---

## Canon (source of truth -- read these if anything conflicts)

- **AGENTS.md** -- Pre-Commit/Handoff Protocol, Verify before claiming done, land.sh section, Pull requests section (repo rules)
- **docs/rollouts/2026-07-10-auto-deploy-on.md** -- auto-deploy verification and rollback
- **scripts/land.sh** -- the actual implementation and idempotency guarantees
- **docs/EFFORT-LOG.md** -- shared cross-agent effort ledger format
- **/Users/jay/apps/AGENT-SYNC.md** -- Slack message format and seat coordination (canonical, read before your first message)
