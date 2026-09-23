#!/usr/bin/env bash
# Codex Cloud setup for Socratic-Trade. Secrets must be runtime environment variables
# when the agent phase needs them; setup-only secrets are removed before the agent runs.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> Codex Cloud setup: Socratic-Trade"
test -f AGENTS.md && echo "AGENTS.md: OK" || { echo "AGENTS.md: MISSING" >&2; exit 1; }
test -f docs/EFFORT-LOG.md && echo "Effort-log mirror: OK" || { echo "docs/EFFORT-LOG.md: MISSING" >&2; exit 1; }
git remote get-url origin >/dev/null 2>&1 && echo "Git origin: OK" || echo "Git origin: MISSING"
if command -v gh >/dev/null 2>&1 && [ -n "${GH_TOKEN:-}" ]; then
  gh api user --jq .login >/dev/null 2>&1 && echo "GitHub API: OK" || echo "GitHub API: FAILED"
  gh issue list --limit 1 >/dev/null 2>&1 && gh pr list --limit 1 >/dev/null 2>&1 && echo "GitHub issues/PRs: OK" || echo "GitHub issues/PRs: CHECK"
else
  echo "GitHub API: GH_TOKEN is not a runtime environment variable"
fi
if [ -x scripts/codex-coordination.sh ]; then
  scripts/codex-coordination.sh test || echo "Slack/GitHub coordination check incomplete; verify runtime variables"
else
  echo "scripts/codex-coordination.sh: MISSING" >&2
  exit 1
fi
echo "Slack channel: ${SLACK_CHANNEL_ID:-C0BEZDJDNKV}"
echo "Slack project: ${SLACK_PROJECT:-Socratic-Trade}"
echo "Agent: ${SLACK_AGENT_NAME:-${AGENT_NAME:-CODEX}}"
echo "Apple Notes: Mac-only; cloud completion docs must include the Notes handoff body."
echo "Setup complete: Socratic-Trade"
