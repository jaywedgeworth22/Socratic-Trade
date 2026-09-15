# 2026-09-13 — Same-repo pull_request auto-merge

Branch `fx/automerge-fork-guard`.  Worktree `~/apps/trading-fx-automerge`.

`auto-merge-prs.yml` and `auto-merge-shared-dependency.yml` used `pull_request_target`.  The shared-dependency job had no same-repo guard.  Both now use `pull_request` and skip forks.  Arming still requires `GH_PAT` / `SHEPHERD_TOKEN` (absent today = no-op).
