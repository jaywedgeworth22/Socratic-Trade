#!/usr/bin/env bash
# land.sh — safe agent landing flow
#
# Usage: bash scripts/land.sh [--pr-title "my title"] [--draft]
#
# Run this from your agent worktree (~/apps/trading-<name>) when you are
# ready to ship work. It:
#   1. Refuses to run from the main integration worktree or on branch main
#   2. Fetches origin
#   3. Merges origin/main (fast-forward or real merge; aborts on conflict)
#   4. Runs tsc, npm test, npm run build — all must pass
#   5. Allows .github/workflows/ changes when the gh token has the 'workflow' scope; only
#      blocks them when the scope is missing (then: gh auth refresh -s workflow, or ci-pending/)
#   6. Pushes the agent branch and opens a PR via gh
#
# Safe to re-run: idempotent.  Re-running after fixing a conflict or test
# failure picks up where it left off.
#
# Emergency escape hatch (HUMANS ONLY):
#   LAND_SKIP_VERIFY=1 bash scripts/land.sh   # skips tsc/test/build
#   LAND_FORCE_PUSH=1  bash scripts/land.sh   # skips worktree guard (rare)
#   LAND_ALLOW_DIRTY=1 bash scripts/land.sh    # bypasses dirty-tree guard after review
#   LAND_ALLOW_STALE_OVERLAP=1 bash scripts/land.sh
#                                             # bypasses stale-overlap guard after review

set -euo pipefail

# ── colour helpers ──────────────────────────────────────────────────────────
RED='\033[0;31m'; YELLOW='\033[1;33m'; GREEN='\033[0;32m'; BOLD='\033[1m'; RESET='\033[0m'
die()  { echo -e "${RED}[land] ERROR: $*${RESET}" >&2; exit 1; }
warn() { echo -e "${YELLOW}[land] WARN:  $*${RESET}" >&2; }
ok()   { echo -e "${GREEN}[land] OK:    $*${RESET}"; }
info() { echo -e "${BOLD}[land] $*${RESET}"; }

# ── resolve repo root from wherever this script lives ──────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

# -- supported runtime guard -------------------------------------------------
# `.nvmrc` is advisory unless the caller explicitly activates it. Refuse to
# install, verify, or publish with a different Node ABI than production/CI.
command -v node >/dev/null 2>&1 || die "Node is missing. Node 24.x is required."
NODE_VERSION="$(node -p 'process.versions.node' 2>/dev/null || echo "")"
case "$NODE_VERSION" in
  24.*) ;;
  *)
    die "Node 24.x is required; found '${NODE_VERSION:-unknown}'.
  On the deployment Mac run:
    export PATH=\"/opt/homebrew/opt/node@24/bin:\$PATH\"
  Then re-run bash scripts/land.sh."
    ;;
esac
ok "Node v${NODE_VERSION} matches the supported Node 24 runtime."

# ── 1. worktree / branch guards ────────────────────────────────────────────
MAIN_INTEGRATION_WORKTREE="$HOME/Code/Agentic Trading"
CURRENT_WORKTREE="$(git rev-parse --show-toplevel 2>/dev/null || echo "")"
CURRENT_BRANCH="$(git symbolic-ref --short HEAD 2>/dev/null || echo "DETACHED")"

if [[ -z "${LAND_FORCE_PUSH:-}" ]]; then
  # Normalise paths for comparison (resolve symlinks if any)
  RESOLVED_CURRENT="$(cd "$CURRENT_WORKTREE" 2>/dev/null && pwd -P)"
  RESOLVED_MAIN="$(cd "$MAIN_INTEGRATION_WORKTREE" 2>/dev/null && pwd -P 2>/dev/null || echo "__not_found__")"

  if [[ "$RESOLVED_CURRENT" == "$RESOLVED_MAIN" ]]; then
    die "You are in the MAIN INTEGRATION WORKTREE ('~/Code/Agentic Trading').
  That worktree is for human/Cursor review and merges only — NOT for agent landing.
  Work in your own worktree:
    Claude      → ~/apps/trading-claude   (branch agent/claude)
    Codex       → ~/apps/trading-codex    (branch agent/codex)
    Antigravity → ~/apps/trading-antigravity (branch agent/antigravity)
    Kimi        -> ~/apps/trading-kimi     (branch agent/kimi-lane)
  To override in a genuine emergency: LAND_FORCE_PUSH=1 bash scripts/land.sh"
  fi

  if [[ "$CURRENT_BRANCH" == "main" ]]; then
    die "You are on branch 'main'. Agents must work on their own agent/* branch.
  Check out your branch first:  git checkout agent/<yourname>
  To override in a genuine emergency: LAND_FORCE_PUSH=1 bash scripts/land.sh"
  fi
fi

info "Landing branch '${CURRENT_BRANCH}' from worktree '${CURRENT_WORKTREE}'"

if [[ -z "${LAND_ALLOW_DIRTY:-}" ]]; then
  if [[ -n "$(git status --porcelain)" ]]; then
    die "Working tree has uncommitted changes. Commit, stash, or clean them before landing.
  This script only pushes committed branch history, so dirty files would otherwise be easy to miss.
  To override in a genuine emergency: LAND_ALLOW_DIRTY=1 bash scripts/land.sh"
  fi
fi

# ── 1b. self-heal the pre-push hook ────────────────────────────────────────
# core.hooksPath is per-worktree and NOT inherited, so a freshly-created worktree
# would silently have NO hooks — the direct-push-to-main guard would never fire.
# land.sh is the canonical installer: make every land path self-heal it.
EXPECTED_HOOKS="scripts/githooks"
CURRENT_HOOKS="$(git config core.hooksPath 2>/dev/null || echo "")"
if [[ "$CURRENT_HOOKS" != "$EXPECTED_HOOKS" ]]; then
  if [[ -x "$REPO_ROOT/$EXPECTED_HOOKS/pre-push" ]]; then
    git config core.hooksPath "$EXPECTED_HOOKS"
    warn "core.hooksPath was '${CURRENT_HOOKS:-unset}' — set to '${EXPECTED_HOOKS}' so the main-push guard is active."
  else
    warn "Expected hook '${EXPECTED_HOOKS}/pre-push' missing/not-executable — the main-push guard may be inactive."
  fi
else
  ok "pre-push hook active (core.hooksPath=${EXPECTED_HOOKS})."
fi

# ── 2. fetch origin ────────────────────────────────────────────────────────
info "Fetching origin..."
git fetch origin

# ── 2b. stale-overlap guard ────────────────────────────────────────────────
# A branch can auto-merge cleanly while still reintroducing stale UI text or
# behavior if both it and main edited the same files since the branch forked.
# Stop before the automatic merge and require a deliberate review of overlaps.
if [[ -z "${LAND_ALLOW_STALE_OVERLAP:-}" ]]; then
  MERGE_BASE="$(git merge-base HEAD origin/main)"
  BRANCH_FILES="$(git diff --name-only "${MERGE_BASE}..HEAD" | sort -u)"
  MAIN_FILES="$(git diff --name-only "${MERGE_BASE}..origin/main" | sort -u)"
  OVERLAP_FILES="$(comm -12 <(printf '%s\n' "$BRANCH_FILES") <(printf '%s\n' "$MAIN_FILES") | sed '/^$/d')"

  if [[ -n "$OVERLAP_FILES" ]]; then
    die "Your branch and origin/main both changed these files since the branch forked:
$(echo "$OVERLAP_FILES" | sed 's/^/  /')

Auto-merging this can silently land stale text or behavior even without a Git conflict.
Manually merge/rebase origin/main, review each overlapping file, commit the result, then re-run.
After that deliberate review, bypass only if needed:
  LAND_ALLOW_STALE_OVERLAP=1 bash scripts/land.sh"
  fi
fi

# ── 3. merge origin/main into current branch ──────────────────────────────
info "Merging origin/main..."
if ! git merge --no-edit origin/main; then
  die "Merge conflict with origin/main.  Resolve conflicts, then re-run land.sh.
  Quick reference:
    git status                     # see conflicted files
    git diff                       # review them
    # edit files to resolve, then:
    git add <files>
    git merge --continue
    bash scripts/land.sh           # re-run to continue"
fi
ok "Merged origin/main cleanly."

# ── 4. verify gate: tsc → test → build ────────────────────────────────────
if [[ -n "${LAND_SKIP_VERIFY:-}" ]]; then
  warn "LAND_SKIP_VERIFY is set — skipping tsc/test/build.  HUMANS ONLY."
else
  info "Running verify gate (tsc → test → build)..."

  info "  [1/3] npx tsc --noEmit"
  if ! npx tsc --noEmit; then
    die "TypeScript errors found.  Fix them, then re-run land.sh."
  fi
  ok "  tsc clean."

  info "  [2/3] npm test"
  if ! VITEST_MAX_THREADS="${VITEST_MAX_THREADS:-4}" npm test -- --run 2>&1; then
    die "Tests failed.  Fix them, then re-run land.sh."
  fi
  ok "  tests pass."

  info "  [3/3] npm run build"
  if ! npm run build; then
    die "Build failed.  Fix it, then re-run land.sh.
  Note: if your PM2 preview starts erroring (ENOENT .next/server/...) after build,
  restart it: pm2 restart trading-$(basename "$CURRENT_WORKTREE" | sed 's/trading-//')"
  fi
  ok "  build clean."
fi

# ── 5. workflow-scope guard (scope-aware) ──────────────────────────────────
# Pushing .github/workflows/ requires the 'workflow' OAuth scope on the token git pushes with.
# `git push` here goes through `gh auth git-credential`, so the gh token's scopes are what matter.
# Only block when that scope is genuinely MISSING — when it's present (the common case now), allow
# the push instead of forcing a needless ci-pending/ detour.
WORKFLOW_FILES="$(git diff --name-only "origin/main...HEAD" -- '.github/workflows/' 2>/dev/null || true)"
if [[ -n "$WORKFLOW_FILES" ]]; then
  if gh auth status 2>&1 | grep -q "Token scopes:.*'workflow'"; then
    info "Diff includes .github/workflows/ — gh token has the 'workflow' scope, so the push is allowed:"
    echo "$WORKFLOW_FILES" | sed 's/^/  /'
  else
    die "Your branch modifies .github/workflows/ files:
$(echo "$WORKFLOW_FILES" | sed 's/^/  /')
Pushing these requires the 'workflow' OAuth scope, which the current gh token lacks.
Add it once with:  gh auth refresh -h github.com -s workflow
(or stage the file(s) under ci-pending/ for a human to move). Then re-run land.sh."
  fi
fi

# ── 6. push branch + open PR ──────────────────────────────────────────────
info "Pushing '${CURRENT_BRANCH}' to origin..."
git push --set-upstream origin "${CURRENT_BRANCH}"
ok "Branch pushed."

# Build PR title from commits since origin/main, falling back to branch name
COMMIT_SUBJECTS="$(git log --oneline "origin/main..HEAD" --format="%s" 2>/dev/null || true)"
COMMIT_COUNT="$(echo "$COMMIT_SUBJECTS" | grep -c . || true)"

if [[ -n "${1:-}" && "${1:-}" == "--pr-title" && -n "${2:-}" ]]; then
  PR_TITLE="${2}"
  shift 2
elif [[ "$COMMIT_COUNT" -eq 1 ]]; then
  # Parameter expansion, not `echo | head` -- see the SIGPIPE note in
  # scripts/alert-deploy-freshness.sh (FLEET-INFRA-BH).
  PR_TITLE="${COMMIT_SUBJECTS%%$'\n'*}"
else
  # Use first non-trivial commit subject; strip conventional commit prefix
  FIRST_SUBJECT="$(echo "$COMMIT_SUBJECTS" | tail -1)"
  PR_TITLE="${FIRST_SUBJECT:-${CURRENT_BRANCH}}"
fi

# Compose body from commit log
PR_BODY="$(cat <<EOF
## Commits
$(git log --oneline "origin/main..HEAD" --format="- %s (%h)" 2>/dev/null || echo "- (see branch)")

## Verify gate
- tsc: clean
- npm test: pass
- npm run build: clean

## Notes
Landed via \`scripts/land.sh\` from worktree \`${CURRENT_WORKTREE}\` on branch \`${CURRENT_BRANCH}\`.
$(if [[ -n "${LAND_SKIP_VERIFY:-}" ]]; then echo "⚠️  LAND_SKIP_VERIFY was set — verify gate was SKIPPED."; fi)
EOF
)"

DRAFT_FLAG=""
if [[ "${1:-}" == "--draft" ]]; then
  DRAFT_FLAG="--draft"
fi

info "Creating PR..."
PR_URL="$(gh pr create \
  --title "$PR_TITLE" \
  --body "$PR_BODY" \
  --base main \
  --head "${CURRENT_BRANCH}" \
  ${DRAFT_FLAG} 2>&1)" || {
  # If PR already exists, gh pr create exits non-zero but prints the URL
  # Try to surface it gracefully
  EXISTING="$(gh pr view "${CURRENT_BRANCH}" --json url --jq .url 2>/dev/null || true)"
  if [[ -n "$EXISTING" ]]; then
    warn "A PR already exists for this branch: ${EXISTING}"
    PR_URL="$EXISTING"
  else
    die "gh pr create failed: ${PR_URL}"
  fi
}

echo ""
ok "PR ready: ${PR_URL}"

info "Enabling auto-merge..."
if gh pr merge "${PR_URL}" --auto --squash >/dev/null 2>&1; then
  ok "Auto-merge enabled for ${PR_URL}"
else
  warn "Failed to enable auto-merge. You may need to merge manually."
fi

echo ""
echo -e "${BOLD}Next steps for reviewer:${RESET}"
echo "  1. Review the PR at the URL above"
echo "  2. Merge via GitHub UI  —OR—  pull to '~/Code/Agentic Trading' and:"
echo "       git fetch origin && git merge --ff-only origin/${CURRENT_BRANCH}"
echo "  3. If .github/workflows/ files are staged in ci-pending/:"
echo "       gh auth refresh -s workflow && cp ci-pending/*.yml .github/workflows/"
