# 2026-07-20 - ci-trim-smoke

## Summary

- `.github/workflows/e2e.yml` ("Playwright Smoke") no longer runs on every pull request. Its
  triggers changed from `pull_request` + `merge_group` + `push: main` + weekly `schedule` to
  `push: main` + nightly `schedule` + `workflow_dispatch`. The `classify`/docs-only fast-path
  job body is left untouched (it's dormant for the remaining trigger types, not deleted), and
  the file's header comment was rewritten to describe the new state and how to restore PR
  coverage later without redesigning anything.
- Nothing about CI runner infrastructure changed. Owner explicitly approved "trim smoke AND add
  one runner" as two separate pieces of work; this note covers ONLY the smoke trim. Adding a
  second `socratic-ci` runner is out of scope here.

## Why

- The repo's single self-hosted ephemeral runner (label `socratic-ci`) was backlogged 71 queued
  runs deep. 25 of those (~35% of the backlog) were Playwright Smoke runs triggered by open
  pull requests — this repo currently has a very large number of concurrent agent worktrees
  /branches, so `pull_request`-triggered smoke was compounding fast. Smoke is also documented
  elsewhere in this repo as flaky (see the `e2e.yml` history and multiple rollout notes
  referencing intermittent smoke failures/OOM). Removing the per-PR trigger removes that whole
  slice of the backlog immediately, with no infrastructure change required.
- **Required-status-check investigation (the part that had to be gotten right):** removing a
  check's `pull_request` trigger entirely is only safe if nothing requires it to report on PRs.
  Checked both live gate mechanisms on this repo directly, rather than trusting older docs/notes
  that assumed `smoke` was required:
  - `gh api repos/jaywedgeworth22/Socratic-Trade/rulesets/17945518` (the `main-protection`
    ruleset) → `required_status_checks.required_status_checks` = `[{"context":"verify"}]` only.
  - `gh api repos/jaywedgeworth22/Socratic-Trade/branches/main/protection` (classic branch
    protection, layered on top of the ruleset on this repo) →
    `required_status_checks.contexts` = `["verify","gitleaks","check-pin"]` only.
  - Neither mechanism lists `smoke`. Grepped `.github/workflows/*.yml` and `scripts/land.sh` for
    any other place that might gate merges on the `smoke` context — none found.
  - Also checked whether the `merge_group` trigger was doing real work: the ruleset has no
    `merge_queue` rule and classic protection shows no merge-queue field, so GitHub's native
    merge queue is not enabled on this repo — `merge_group` events never fire here today, and
    the trigger was already inert before this change. Dropped it along with `pull_request` since
    both were serving the same (now-moot) "required PR check" purpose.
  - This matches `docs/rollouts/2026-07-04-ci-actions-efficiency.md` (`"Only 'verify' is a
    required status check today... smoke... not in the live ruleset today"`), so today's
    findings are consistent with that prior note, not a regression from some other state.
  - Net: since `smoke` was never required, the task's fallback plan (mirror `verify`'s
    fast-reporting-success gate-job pattern so a required check isn't stranded) was **not
    needed**. A straight trigger change is sufficient and simpler — no risk of ever reporting a
    fake-green `smoke` status, because there is no required `smoke` status to fake.
- Chose **nightly** (not weekly) for the retained `schedule` trigger specifically because the
  per-PR coverage is gone: a nightly full-browser run keeps smoke from silently rotting for a
  whole week between full runs, while still being a small, bounded, predictable addition to the
  runner queue (1 run/day) versus the ~25 queued PR-triggered runs removed.

## Files

- `.github/workflows/e2e.yml` — trigger block (`pull_request`/`merge_group` removed;
  `schedule` cadence changed from weekly `17 9 * * 1` to nightly `17 9 * * *`;
  `workflow_dispatch` added) and header/`classify`-job comments rewritten to match.
- `docs/EFFORT-LOG.md` — new row under `## In Progress`.
- `/Users/jay/apps/TRADING-EFFORT-LOG.md` — same row added to the branch-neutral live board.
- `STATUS.md` — new dated stanza (this change).

## Verification

- `PATH=/opt/homebrew/opt/node@24/bin:$PATH python3 -c "import yaml; yaml.safe_load(open('.github/workflows/e2e.yml')); print('YAML OK')"` → `YAML OK`.
- `PATH=/opt/homebrew/opt/node@24/bin:$PATH node -e "require('js-yaml').load(require('fs').readFileSync('.github/workflows/e2e.yml','utf8')); console.log('js-yaml OK')"` → `js-yaml OK` (used the locally-resolvable `js-yaml` already in `node_modules` rather than `npx --yes js-yaml`, which has no CLI entry point and errors as "not a recognized file extension" when pointed at a `.yml` path directly).
- Live GitHub API checks (not local, but load-bearing for the required-check decision above):
  `gh api repos/jaywedgeworth22/Socratic-Trade/rulesets` (and `/rulesets/17945518`),
  `gh api "repos/jaywedgeworth22/Socratic-Trade/rulesets?includes_parents=true"` (confirms no
  org-level ruleset also applies), `gh api repos/jaywedgeworth22/Socratic-Trade/branches/main/protection`.
- No source code changed (only `.github/workflows/e2e.yml` and docs), so the full
  `npm run lint && npx tsc --noEmit && npm test && npm run build` gate was not run for this
  change — nothing in that gate exercises workflow YAML. `scripts/land.sh`'s own `verify` job
  (tsc → test → build) will still run against this branch's PR via `ci.yml` as usual.

## Follow-ups

- Adding a second `socratic-ci` runner (the other half of the owner's approved plan) is
  deliberately NOT part of this change — separate effort, untouched runner infrastructure.
- If/when a second runner lands and the backlog recovers, consider restoring `pull_request:` (and
  `merge_group:` if the merge queue is ever enabled) to `e2e.yml`'s triggers — the `classify`
  docs-only fast-path logic was deliberately left in place (not deleted) specifically so that
  restoring PR coverage is a one-line trigger re-add, not a redesign.
- Nightly smoke failures now have no PR to attach to — worth confirming there's a notification
  path (Slack `#agent-sync` or similar) for a red nightly `Playwright Smoke` run on `main`, so a
  regression doesn't go unnoticed until the weekly-turned-nightly cadence happens to catch it.
