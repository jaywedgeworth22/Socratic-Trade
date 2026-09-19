#!/usr/bin/env bash
# Canonical setup for a fresh, isolated checkout (Claude Code cloud/remote sandbox,
# Codespaces, devcontainer, or any throwaway clone). Idempotent - safe to re-run.
#
# IMPORTANT (Claude Code Cloud environments specifically): the container's working
# directory when the "Setup script" field runs is the PARENT of the cloned repo
# (e.g. /home/user), NOT the repo root - `git clone` creates a `Socratic.Trade/`
# subdirectory and the sandbox drops you one level above it. A bare
# `bash scripts/cloud-setup.sh` therefore fails with
# `bash: scripts/cloud-setup.sh: No such file or directory` (exit 127) because
# that path doesn't resolve from the parent directory.
#
# Point the environment's Setup script field at the fleet locator (works for
# every app; see ai-fleet-coordinator/docs/CLAUDE-CODE-CLOUD-ENVIRONMENTS.md):
#   set -euo pipefail
#   if [ -f scripts/cloud-setup.sh ]; then exec bash scripts/cloud-setup.sh; fi
#   shopt -s nullglob
#   matches=(*/scripts/cloud-setup.sh)
#   if [ "${#matches[@]}" -eq 1 ]; then exec bash "${matches[0]}"; fi
#   echo "ERROR: scripts/cloud-setup.sh not found from $(pwd)" >&2; ls -la >&2; exit 1
#
# Equivalent one-liner if you prefer the repo name:
#   cd Socratic.Trade && bash scripts/cloud-setup.sh
#
# (`.devcontainer/devcontainer.json`'s `postCreateCommand` does NOT need the `cd`
# - devcontainers set `workspaceFolder` to the repo root automatically. This `cd`
# is only required for the plain Claude Code Cloud "Setup script" text field.)
#
# The app boots keyless: local SQLite at data/app.db is infrastructure (settings,
# proposals, users), not an execution mode. No secrets are required for the UI,
# Market Scan, or watchlist/policy/account configuration. Inject OPENAI_API_KEY
# only if you want the LLM "Run once" / decide loop; placing orders requires a
# connected broker account (paper or live) - there is no local-simulation fallback.
set -euo pipefail

cd "$(dirname "$0")/.."

echo "==> Node: $(node --version 2>/dev/null || echo 'not found')  npm: $(npm --version 2>/dev/null || echo 'not found')"

# Deterministic install from the committed lockfile.
echo "==> Installing dependencies (npm ci)"
npm ci

# Resolve the local Infisical machine-identity bootstrap without sourcing the
# global key file as shell code and without copying/printing credential values.
# The runner repeats this resolution at launch. The global path is intentionally
# fixed; an inherited legacy override must not redirect setup to an arbitrary
# credential file. Cloud VMs do not have ~/.secrets/global-api-keys — missing
# identities are expected; do not fail setup for a keyless checkout.
unset GLOBAL_API_KEYS_FILE
echo "==> Checking Infisical bootstrap identity (values stay private)"
# Cloud VMs do not have ~/.secrets/global-api-keys. Missing identities are
# expected; do not fail the whole session setup for a keyless checkout.
node scripts/infisical-bootstrap-env.mjs || echo "==> Infisical bootstrap skipped (ok in keyless cloud)"

# Install the Slack coordination sync globally (SessionStart hook). No-op at
# runtime unless SLACK_BOT_TOKEN is set as an environment secret. Non-fatal:
# a hiccup here must never fail the whole environment setup.
echo "==> Installing Slack coordination sync (global SessionStart hook)"
bash scripts/setup-slack-sync.sh || echo "    (slack-sync install skipped; see docs/slack-coordination.md)"

echo "==> Setup complete. Start the app with: npm run dev:secrets   (Infisical runner on :3000)"
echo "    'npm run dev' (plain) is for tests-only — it no longer reads .env.local."
echo "    Verify a change with: npx tsc --noEmit && npm test && npm run build"
