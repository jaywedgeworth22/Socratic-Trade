---
name: codex-triage
description: Triage unresolved GitHub review threads (chatgpt-codex-connector, Cursor Bugbot, and any other review bot or human) — classify against current HEAD, fix real findings in one batch, reply, then resolve. Use when gating a merge, when branch protection blocks on conversation resolution, or when a bot re-reviews after push.
---

# Review-thread triage (Universal)

Name is historical (`codex-connector`).  Apply to **every** unresolved thread on the PR: Codex, Cursor Bugbot, Copilot, humans.

Unresolved threads block merge on every protected fleet repo even when checks are green.

## 1. Fetch unresolved threads

```bash
OWNER="$(gh repo view --json owner --jq .owner.login)"
REPO="$(gh repo view --json name --jq .name)"
gh api graphql -f query="query { repository(owner:\"$OWNER\", name:\"$REPO\") { pullRequest(number: <N>) { reviewThreads(first: 100) { nodes { id isResolved path line comments(first: 10) { nodes { author { login } body diffHunk } } } } } } }" \
  --jq '.data.repository.pullRequest.reviewThreads.nodes | map(select(.isResolved==false))'
```

## 2. Classify against current HEAD

Three buckets only:

- **addressed** — already fixed on this branch after the comment.
- **false_positive** — bot misread context, or the rule does not apply here.
- **real** — valid.  For money-path / auth / execution / policy / billing files, have a second agent (or a frontier child) adversarially verify before you change behavior.

Do not classify from the stale diff hunk.  Read the file at HEAD.

## 3. Fix reals in one batch

One commit with a regression test per behavior change.  **Push before resolving any thread** (race in step 5).

## 4. Reply, then resolve

Do not resolve without a reply.

```bash
gh api graphql -f query='mutation($t:ID!,$b:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$t,body:$b}){comment{id}}}' -F t=<threadId> -f b=<text>

gh api graphql -f query='mutation($t:ID!){resolveReviewThread(input:{threadId:$t}){thread{isResolved}}}' -F t=<threadId>
```

Reply shape (file/PR text = two ASCII spaces between sentences):

- **Real:** `Fixed in <short-sha>.  <function>.  Test: test/foo.test.ts.`
- **False positive:** why the rule does not apply, then resolve.
- **Addressed already:** cite the SHA that landed the fix.

Never blind-resolve to force a merge.  The gate exists because some findings are real (commit-author, licenses, money-path).

## 5. Auto-merge race

The instant the last thread resolves and CI is green, auto-merge fires.  Bots re-review every push and often never converge.

- Resolving the last thread **is** merging the PR.  Triple-check first.
- Round-2 comments often land on an already-merged PR.  Before resolving as "fixed," confirm the fix reached main:

```bash
git fetch origin
git merge-base --is-ancestor <fix-sha> origin/main && echo "on main" || echo "NOT on main"
```

If NOT on main, open a follow-up PR from the same branch.  Expect squash-merge conflicts — merge main in; this branch's newer rounds win in its own files.

## 6. Stop at round 2–3

Later rounds on a merged PR are mostly noise.  Triage genuine hazards; surface the rest to the owner (Notes + board comment).  the agent's job on these is the security/contract read, not infinite bot ping-pong.

## Canon

- `/Users/jay/apps/AGENT-SYNC.md` — Merge requirements
- App `AGENTS.md` Pre-Commit / Handoff
- Skills: `unstick-pr`, `land-lane`
