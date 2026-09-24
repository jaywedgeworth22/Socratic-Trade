#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> Codex Cloud maintenance: Socratic-Trade"
test -f AGENTS.md && test -f docs/EFFORT-LOG.md && echo "Protocol files: OK" || echo "Protocol files: CHECK"
if [ -x scripts/codex-coordination.sh ]; then
  scripts/codex-coordination.sh test || echo "Coordination check incomplete"
fi
echo "Apple Notes: Mac-only; preserve a completion handoff for local Notes publication."

