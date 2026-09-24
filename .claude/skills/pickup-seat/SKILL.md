---
name: pickup-seat
description: Pick up another agent seat's in-flight work after it hits a usage/time cap (owner-directed only).
---

# Pick Up a Seat's Work (Usage Cap Handoff)

Invoke when the owner directs you to pick up a capped-out peer seat's in-progress work. Never initiate; always wait for owner signal.

## INVENTORY: Map what was left behind

Before touching anything, gather facts:

```bash
# 1. Effort boards (In Progress rows + latest edits)
grep -A 5 "In Progress" /Users/jay/apps/TRADING-EFFORT-LOG.md
grep -A 5 "In Progress" docs/EFFORT-LOG.md

# 2. Open PRs: categorize armed+green vs. blocked-on-threads vs. unarmed
gh pr list --state open --json number,title,statusCheckRollup,autoMergeRequest

# 3. Dirty worktrees: hold the capped seat's uncommitted work
git worktree list
for wt in $(git worktree list | awk '{print $1}'); do
  echo "=== $wt ===" && (cd "$wt" && git status)
done

# 4. Recent branches without PRs (seat may have landed work not yet in a PR)
git for-each-ref --sort=-committerdate refs/remotes/origin | head -15

# 5. Slack history: claims, handoffs, last state
bash scripts/slack-sync.sh read 20
```

## CLAIM: Post to #agent-sync before working

Post repo-first per `/Users/jay/apps/AGENT-SYNC.md`'s canonical format, naming exactly what you are picking up:

```bash
bash scripts/slack-sync.sh post "repo: Socratic-Trade | [CLAUDE->agent/*] picking up MONET: effort#123,124 + PR#1234,1235; do not double-work"
```

Durability: put the same claim in `docs/EFFORT-LOG.md` (repo mirror), not only the live board
(`/Users/jay/apps/TRADING-EFFORT-LOG.md`) -- live-only rows have been lost before (see Canon).

## ADOPT: Verify lane is abandoned; commit with authorship credit

```bash
# Check: no commits or Slack posts from this seat since the cap
git log --oneline --author="<seat-email-or-name>" --since="2 hours ago"
bash scripts/slack-sync.sh read 20 | grep "\[SEAT"

# Adopt uncommitted work (assume it is intentional): commit with dual authorship.
# Match the Co-Authored-By convention already in this repo's history (per tool, not per seat) --
# e.g. MONET and CLAUDE are both Claude Code, so the trailer is "Claude <noreply@anthropic.com>",
# NOT a fabricated seat-specific address.
git add <files>
git commit -m "Uncommitted work from capped seat's session.

Landed as continuation during cap handoff; full authorship credit retained.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

Never reset/checkout over dirty files. Treat uncommitted code as salvageable.

## DISPOSITION: Classify and action each item

For each effort, PR, worktree, or branch:

- **Already merged** = verify with `git log origin/main`, flip board row to "Deployed"
- **Armed (ready to babysit)** = use the `unstick-pr` skill when threads resolve
- **Committed, not landed** = gate + land via the `land-lane` skill (or `land.sh` directly if clean)
- **Uncommitted, unfinished** = assess scope; adopt + complete only if owner-directed
- **Uncommitted, finished** = commit with authorship credit; land or hold
- **Claimed but not started** = release back to unclaimed; post to #agent-sync
- **Genuinely blocked** = board note with reason; escalate if P0

## HAND BACK: Return gracefully when seat returns

Answer disambiguation pings fast. Cede lanes the returning seat re-claims (especially its own
authored deltas). State exactly what you already did: commit SHAs, PR numbers, board rows
flipped, what is ready for them to merge/babysit.

## CLOSE OUT: Board rows + rollout note + Slack summary

Update both effort boards (`/Users/jay/apps/TRADING-EFFORT-LOG.md` and `docs/EFFORT-LOG.md`)
with final dispositions -- correct any premature claims in place, never delete another seat's
row. Commit the board update, then create `docs/rollouts/YYYY-MM-DD-pickup-[seat]-cap.md`
covering: efforts adopted, PRs handled (with final state), disposition summary, and the
verification commands actually run (`git log`, `gh pr list`, the land gate). Announce the
close-out on `#agent-sync`, repo-first, naming what is ready for the returning seat to resume.

## Canon (source of truth -- read these if anything conflicts)

- **AGENTS.md** -- effort-log rules (append-mostly, assignment = live claim)
- **/Users/jay/apps/EFFORT-LOG-PROTOCOL.md** -- protocol detail for board transitions
- **/Users/jay/apps/AGENT-SYNC.md** -- Slack message format and handoff discipline (canonical)
- **memory `codex-automerge-race-and-board-clobber`** -- why live-board-only claims get lost
- **scripts/land.sh** -- landing gate (tsc -> test -> build, CI checks, PR open)
- **scripts/slack-sync.sh** -- read/post agent-sync updates
