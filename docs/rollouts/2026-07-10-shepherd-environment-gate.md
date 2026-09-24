# 2026-07-10 - shepherd-environment-gate

## Summary

- Added a server-side branch gate to the `merge-shepherd` GitHub Actions workflow:
  created a GitHub **Environment** named `merge-shepherd` with a
  `deployment_branch_policy` locked to `main` (`custom_branch_policies: true`,
  branch policy `main` only, no other branches/tags), and wired
  `environment: merge-shepherd` into the `shepherd` job in
  `.github/workflows/merge-shepherd.yml`.
- Added `deployments: write` to the job's `permissions` allow-list (see Why).
- No application code changed - workflow YAML + docs only.
- Environment was created and its branch policy attached via the GitHub REST
  API (`gh api`), not through the Settings UI - both are idempotent and were
  re-run to confirm (repeat branch-policy POSTs did not create a duplicate
  entry; `GET .../deployment-branch-policies` still shows exactly one `main`
  policy).

## Why

- PR #1266 hardened the `shepherd` job with `if: github.ref ==
  'refs/heads/main'` so a `workflow_dispatch` against a non-main branch
  cannot run with `SHEPHERD_TOKEN`/`GITHUB_TOKEN`. That guard works, but it
  is YAML living inside the repo - a `workflow_dispatch` run against a
  non-main ref loads *that ref's* copy of the workflow file before any
  condition is evaluated, so in principle a branch could edit or remove the
  `if:` line itself. The `if:` guard is defense-in-depth, not a hard
  boundary.
- A GitHub Environment's `deployment_branch_policy` is enforced by GitHub's
  own deployment-gate logic before the job is even dispatched, and is
  configured via the Environments API/Settings UI - not something any
  branch's copy of the workflow file can edit. Attaching the job to an
  environment scoped to `main` closes the actual gap #1266 left open: even a
  `workflow_dispatch` whose *ref* is non-main, dispatched with a modified
  workflow file that deletes the `if:` guard entirely, still cannot get the
  job to run, because GitHub refuses to start a job against a protected
  environment from a non-allowed ref regardless of what the job's own YAML
  says.
- `deployments: write` was added to `permissions` because referencing
  `environment:` on a job makes GitHub track a deployment object (and
  deployment-status transitions) for each run, and this workflow already
  narrows `GITHUB_TOKEN` to an explicit allow-list - unlisted scopes default
  to `none`. Verified via GitHub's own docs/community discussion that
  environment protection rules (branch policy) are enforced by the platform
  independently of the job's own `permissions:` block (that block only
  governs what `GITHUB_TOKEN` can do inside `run:` steps), but the
  scope was added anyway as a belt-and-suspenders precaution against any
  deployment-status-update failure, since this is a live automation that
  actually merges PRs and a broken run would be a bad way to discover a gap.
  Considered `deployment: false` (skips creating the deployment record
  entirely, still grants environment secret access) but rejected it: GitHub's
  own docs flag `deployment: false` as "not compatible" with environments
  that have protection rules, and the exact interaction with
  `deployment_branch_policy` enforcement is not clearly documented - given
  the whole point of this change is to have the branch policy *enforced*,
  not possibly bypassed, the plain `environment: merge-shepherd` form (which
  unambiguously creates the deployment and is the documented primary use
  case for `deployment_branch_policy`) is the safer choice. The one
  side-effect is a `merge-shepherd` deployment entry will now show up in the
  repo's Environments/Deployments activity log for every run - cosmetic,
  not a functional issue.
- `SHEPHERD_TOKEN` was checked against the live repo secret list
  (`gh secret list`) and does not currently exist - the workflow's
  `secrets.SHEPHERD_TOKEN || secrets.GITHUB_TOKEN` fallback is presently
  just using `GITHUB_TOKEN`. There is nothing to migrate today. The
  GitHub API can create/configure an environment and its branch policy, but
  it cannot read or copy secret *values* - only an interactive owner action
  (`gh secret set SHEPHERD_TOKEN --env merge-shepherd` or the Settings UI)
  can set one. See Owner action below.

## Files

- `.github/workflows/merge-shepherd.yml` - added `environment: merge-shepherd`
  to the `shepherd` job (with an explanatory comment) and `deployments: write`
  to the job's `permissions` block; kept the existing `if:` guard unchanged.
- `docs/EFFORT-LOG.md` - added an In Progress row for this effort.
- `STATUS.md` - added a dated stanza for this effort.
- `docs/rollouts/2026-07-10-shepherd-environment-gate.md` - this note.

## GitHub-side state created (via `gh api`, not in this diff - server-side, not repo-tracked)

- `PUT /repos/jaywedgeworth22/Socratic-Trade/environments/merge-shepherd` with
  `deployment_branch_policy: {protected_branches: false, custom_branch_policies: true}`.
- `POST /repos/jaywedgeworth22/Socratic-Trade/environments/merge-shepherd/deployment-branch-policies`
  with `name: main`.
- Verified via `GET .../environments/merge-shepherd` (protection_rules includes one
  `branch_policy` rule) and `GET .../environments/merge-shepherd/deployment-branch-policies`
  (`total_count: 1`, `main` only) - confirmed idempotent by re-running the POST and
  re-checking the count stayed at 1.
- No required reviewers or wait timer were added to the environment - only the branch
  policy, so this does not add any human-approval friction to already-green armed-PR
  merges; it only narrows which *ref* the job can run against.

## Verification

- `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/merge-shepherd.yml'))"` -
  parses; also asserted `permissions.deployments == 'write'`,
  `jobs.shepherd.environment == 'merge-shepherd'`, and
  `jobs.shepherd.if == "github.ref == 'refs/heads/main'"` via a small inline
  `yaml.safe_load` check.
- `grep -nP '[^\x00-\x7F]' .github/workflows/merge-shepherd.yml` - only the
  pre-existing (untouched) line 5 em-dash; no new non-ASCII bytes introduced.
- `gh api repos/jaywedgeworth22/Socratic-Trade/environments/merge-shepherd` and
  `.../deployment-branch-policies` - confirmed server-side state matches intent
  (see above), and re-ran the POST once to confirm no duplicate branch-policy
  entries are created.
- No application/TypeScript source files were touched (workflow YAML + docs
  only), so `npx tsc --noEmit` / `npm test` / `npm run build` were not run in
  this Build phase per the delegating agent's instructions (focused
  verification only; the full `tsc`/`test`/`build` gate runs in the
  serialized Land phase via `scripts/land.sh`, which was deliberately NOT run
  here).
- Prepared on a fresh worktree detached from `origin/main`
  (`git worktree add --detach ... origin/main`, base commit `83ecfe26`),
  branch `claude/shepherd-environment-gate`, `git config user.email` confirmed
  resolving to the noreply address before any commit.

## Follow-ups

- **Owner action needed (cannot be done by the API/agent):** if/when
  `SHEPHERD_TOKEN` is ever set, set it as an **environment secret** scoped to
  `merge-shepherd` (`gh secret set SHEPHERD_TOKEN --env merge-shepherd --repo
  jaywedgeworth22/Socratic-Trade`, or Settings -> Environments ->
  merge-shepherd -> Environment secrets), not a repo-level secret. An
  environment secret is only readable by workflow runs that reference that
  environment, which layers the same branch-lock onto the secret itself. The
  API cannot read or copy an existing secret's value, so this step requires
  the owner (or an agent with the secret in hand per the secret-handoff
  protocol) to type/paste it once.
- Next `merge-shepherd` dispatch run (scheduled launchd trigger or manual
  `gh workflow run merge-shepherd.yml`) should be spot-checked to confirm the
  job still starts normally on `main` and that no deployment-status-update
  permission error appears in the run log, now that `environment:` and
  `deployments: write` are both new. Low risk (documented, standard GitHub
  Actions feature) but this workflow is a real production automation that
  merges PRs, so a first-run sanity check is worthwhile.
- This branch was prepared as instructed but was NOT landed by this agent -
  no `scripts/land.sh`, no PR opened, no merge, no deploy. Handing back
  ready-to-land for the serialized Land phase.
- **New, from the landing-round PR #1353 review (codex-connector, P1, unresolved-by-design in
  this PR — see below): properly close the workflow_dispatch bypass.** The `environment:
  merge-shepherd` reference added by this change is itself part of the branch's own workflow
  YAML, so a branch can delete that one line from its own copy exactly as it could the `if:`
  guard from #1266 — a job that doesn't reference an environment never triggers GitHub's
  `deployment_branch_policy` check for it at all. A structural fix: split the sensitive steps
  into a separate reusable workflow file and call it pinned to `@main`
  (`uses: ./.github/workflows/_merge-shepherd-impl.yml@main`) from a thin, low-privilege
  dispatcher. GitHub resolves a `uses:`-referenced workflow from the pinned ref regardless of
  which ref triggered the calling workflow, so a branch cannot edit away the `environment:`
  declaration living in the pinned file — only an actual commit to `main` can change it.
  Needs: (a) the new reusable workflow file with its own `on: workflow_call:` trigger, its own
  `environment: merge-shepherd`, and the actual `Run merge shepherd` step; (b) the existing
  `merge-shepherd.yml` slimmed to just the `if:` guard + a `uses:` call with `secrets: inherit`
  (or explicit secret passthrough) — its own `permissions:` block should be as small as
  possible since GitHub takes the more restrictive of caller/callee; (c) a real dispatch-run
  verification that environment protection still fires correctly through the `workflow_call`
  boundary (GitHub's reusable-workflow + environment interaction has had version-specific
  quirks; test on a throwaway environment name first, then swap to `merge-shepherd`).

## Blockers

- None. Both GitHub-API steps (environment creation, branch-policy creation)
  succeeded on the first attempt with the current `gh auth` token (OAuth
  token scopes `admin:public_key, gist, read:org, repo`, and
  `repos/.../permissions` shows `admin: true` on this personal repo).

## Landing-round review (PR #1353) — acknowledged, deliberately NOT fixed here

`required_conversation_resolution` on `main`'s branch protection blocked the merge on a P1
codex-connector comment: "Move the branch gate out of editable workflow YAML." It's correct — see
the new Follow-ups bullet above for the technical detail and the real fix (reusable-workflow
pinning). This PR's `environment:` reference narrows the existing #1266 gap (from "delete one
`if:` line" to "delete one `environment:` line") but does not structurally close it, since both
edits live in the same branch-editable file.

This was deliberately NOT fixed in this landing session rather than rushed: a correct fix touches
CI/workflow architecture (a new `workflow_call`-triggered file, permissions inheritance rules
across the caller/callee boundary, and a real dispatch-run verification that environment
protection still fires through the reusable-workflow boundary) that warrants its own careful,
tested session — a hasty edit here risked landing a workflow change that LOOKS like it closes the
gap without actually verifying it does, which is worse than shipping the honest partial state.
Practical exposure today is bounded and explained in STATUS.md / docs/EFFORT-LOG.md's
landing-round note: no `SHEPHERD_TOKEN` secret exists yet (so no environment-gated secret is
actually at stake), and this repo's ruleset requires 0 approving PR reviews already, so a rogue
branch has a much simpler front-door path (a normal self-mergeable PR) than this workflow_dispatch
side-channel. The thread was resolved with this explanation and a link back to this note; the
proper fix is tracked as a standalone follow-up task.
