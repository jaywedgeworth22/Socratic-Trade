# 2026-07-12 — shared-package-pin-check: resolve refs to commit SHAs before comparing

## Summary
Hardened `.github/workflows/shared-package-pin-check.yml` so it compares the two consumer
repos' `@jaywedgeworth22/congress-trading-shared` pins at the **commit** level instead of
the raw ref string. When the normalized ref strings differ but both specs are git-style
(`github:...#ref`, `git+...#ref`), the check now resolves each ref to a commit SHA against
`congress-trading-shared` (the shared package's own repo, which is public) via the GitHub
API before declaring a divergence — dereferencing annotated tags to the commit they point
at. A tag pin (`#v1.6.0`) and the equivalent raw-SHA pin (`#c4fcfb44...`) now compare EQUAL;
genuinely different commits still compare UNEQUAL and fail loudly. If exactly one side
resolves and the other errors, the check FAILS loudly rather than silently falling back to
a string compare that could be wrong. Only when NEITHER side resolves does it fall back to
the original normalized-string comparison (matches the pre-existing behavior for that edge
case).

## Why
This check false-failed every Socratic-Trade PR earlier today (2026-07-12) when
Congress.Trade re-pinned `congress-trading-shared` to a raw SHA that is exactly what tag
`v1.6.0` resolves to. The old check only did a normalized-string compare of the ref after
`#`, so `v1.6.0` (this repo) vs `c4fcfb4423a11318bda8486ecf3dd6ab1783e87a` (peer) read as a
divergence even though both consumers were on the identical commit. `main` self-healed by
moving this repo's own pin to the same raw-SHA form (see `package.json` /
`package-lock.json`), which made the string compare coincidentally pass again — but the
underlying bug was untouched and will recur the instant the two repos pin the same commit
via two different ref forms again. That is imminent: CODEX's pending `congress-trading-shared`
v1.7.0 bump uses the tag form (`#v1.7.0`), and if Socratic-Trade's side lags on a raw SHA (or
vice versa) the false-positive returns. This change makes the check correct by construction
instead of coincidentally-passing on today's specific pin state.

## Files
- `.github/workflows/shared-package-pin-check.yml` — added `is_git_spec`, `git_ref`,
  `parse_ref_json`, and `resolve_ref` shell functions plus the ref-resolution branch in the
  main comparison block; added `SHARED_REPO` env var (`jaywedgeworth22/congress-trading-shared`,
  the package's own public repo — distinct from `PEER_REPO`, which only hosts the peer
  consumer's `package.json`); updated the header comment block to describe the new
  resolve-before-compare behavior and the public-repo auth note.
- `docs/EFFORT-LOG.md` — new row.
- `STATUS.md` — new stanza.

## Verification
- `bash -n` on the extracted `run:` script block — syntax OK.
- ASCII-only check per AGENTS.md: `grep -nP '[^\x00-\x7F]' .github/workflows/shared-package-pin-check.yml`
  — no hits. Adjacency check (`\$\{?\w+\}?[^\x00-\x7F]`) — no hits.
- `actionlint` was not available in this environment; skipped per the task's "if available"
  caveat.
- **Replay-tested the compare logic against the live GitHub API** (shared repo is public, no
  token needed) by extracting the function definitions and the comparison block from the YAML
  into standalone scripts and sourcing them with hardcoded `LOCAL_SPEC`/`PEER_SPEC` values
  (bypassing the file-read/`gh api` peer-fetch steps, which aren't the code under test):
  - Case (a): `github:...#v1.6.0` vs `github:...#c4fcfb4423a11318bda8486ecf3dd6ab1783e87a`
    -> both resolved to `c4fcfb4423a11318bda8486ecf3dd6ab1783e87a` -> **OK, exit 0** (matches
    expected: tag == equivalent raw SHA).
  - Case (b): `github:...#v1.6.0` vs `github:...#6b37dd62dc71b38bcc5e333c82824bd2b609d79a`
    (the v1.7.0 SHA) -> resolved to `c4fcfb44...` vs `6b37dd62...` -> **::error:: DIVERGED,
    exit 1** (matches expected: genuinely different commits still fail).
  - Full output of both replays is in the PR discussion / session transcript; both matched the
    required outcomes exactly.
- Confirmed `package.json`'s own pin is unchanged
  (`github:jaywedgeworth22/congress-trading-shared#c4fcfb4423a11318bda8486ecf3dd6ab1783e87a`).
  **Correction to an assumption in the task brief:** the brief for this work asserted that the
  required `check-pin` status on `pull_request` events runs from `main`'s workflow definition,
  not the PR's. Verified directly against PR #1507's own `check-pin` run
  (`actions/runs/29223136804/job/86732042154`): the job log's line-by-line echo of the executed
  `run:` script contains this diff's new function names (`is_git_spec`, `resolve_ref`,
  `git_ref`, the `SHARED_REPO` env var) 8 times, and the run's `head_branch` is
  `claude/check-pin-ref-resolve` — i.e. GitHub Actions ran the **PR branch's** workflow file,
  not `main`'s. This matches documented GitHub Actions behavior for same-repo (non-fork)
  `pull_request` triggers (as opposed to `pull_request_target`, which does pin to the base
  branch's workflow for security). So this PR's own `check-pin` status already exercised the
  NEW ref-resolution logic, took the fast normalized-string-match path (both pins identical),
  and passed (`OK: both consumers pin ...`) — see Follow-ups for what this means in practice.
- Full verify gate run via `scripts/land.sh` (Node 24 PATH gate): `npx tsc --noEmit`,
  `npm test`, `npm run build` — see the landing commit's CI run for exact pass/fail; command
  outputs not duplicated here since `land.sh` re-runs them as part of the gate.

## Follow-ups / caveats
- **Correction, not a caveat:** the required `check-pin` status DOES run from the PR branch's
  own workflow definition (verified above), not `main`'s — this repo's `pull_request` trigger
  is same-repo, so it isn't subject to the `pull_request_target`-style base-branch pin. This
  PR's `check-pin` run already used the new ref-resolution logic. Net effect is the same either
  way for this specific PR (both pins matched, so it passed on the fast path regardless of
  which logic ran) but the mechanism differs from what was assumed going in.
- No app code changed; this is CI-config only. `PLAN.md` was not touched (no scope/timeline/
  approach change to the product).
