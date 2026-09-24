#!/usr/bin/env bash
# Ship all FOUR fleet iOS apps to TestFlight (sequential).
# Usage:
#   bash /Users/jay/apps/ios-fleet/ship-all.sh [--export-only] [--dry-run] [--allow-dirty]
#
# Resolves each app's preferred worktree from apps.json hints, falling back to
# common paths. Pass IOS_SOCRATIC_ROOT / IOS_CONGRESS_ROOT / IOS_USAGE_ROOT to override.

set -euo pipefail

FLEET_DIR="$(cd "$(dirname "$0")" && pwd)"
EXTRA_ARGS=()
for a in "$@"; do EXTRA_ARGS+=("$a"); done

resolve_root() {
  local key="$1" envvar="$2" hint="$3"
  if [[ -n "${!envvar:-}" && -d "${!envvar}" ]]; then
    echo "${!envvar}"
    return 0
  fi
  # Expand ~ in hint
  local expanded="${hint/#\~/$HOME}"
  if [[ -d "$expanded" ]]; then
    echo "$expanded"
    return 0
  fi
  case "$key" in
    socratic)
      for p in \
        "$HOME/apps/trading-grok-ios-tf" \
        "$HOME/apps/trading-grok" \
        "$HOME/apps/trading-monet" \
        "$HOME/Code/Socratic-Trade"
      do [[ -d "$p/ios" ]] && echo "$p" && return 0; done
      ;;
    congress)
      for p in \
        "$HOME/apps/congress-grok-ios-tf" \
        "$HOME/apps/Congress.Trade" \
        "$HOME/Code/Congress.Trade"
      do [[ -d "$p/clients/ios" ]] && echo "$p" && return 0; done
      ;;
    usage-local)
      # ship-now-gui.sh (the LaunchAgent path) ships this app from
      # usage-grok-tf-runner; apps.json's worktreeHint points at the sibling
      # usage-grok-ios-tf. Try the path known to work first.
      for p in \
        "$HOME/apps/usage-grok-tf-runner" \
        "$HOME/apps/usage-grok-ios-tf"
      do [[ -d "$p/ios" ]] && echo "$p" && return 0; done
      ;;
    usage)
      for p in \
        "$HOME/apps/usage-grok-ios-tf" \
        "$HOME/apps/usage-monitor-wave2-nav-web" \
        "$HOME/Code/Usage-Monitor"
      do [[ -d "$p/ios" ]] && echo "$p" && return 0; done
      ;;
  esac
  return 1
}

ship_one() {
  local key="$1" envvar="$2" hint="$3"
  local root
  root="$(resolve_root "$key" "$envvar" "$hint")" \
    || { echo "error: cannot resolve repo root for $key" >&2; return 1; }
  echo "========== $key @ $root =========="
  bash "${FLEET_DIR}/ship-testflight.sh" "$key" --repo-root "$root" "${EXTRA_ARGS[@]}"
}

ship_one socratic IOS_SOCRATIC_ROOT "~/apps/trading-grok-ios-tf"
ship_one congress IOS_CONGRESS_ROOT "~/apps/congress-grok-ios-tf"
ship_one usage IOS_USAGE_ROOT "~/apps/usage-grok-ios-tf"
# usage-local was registered in apps.json and shipped by ship-now-gui.sh, but this
# entry point silently skipped it -- "ship all" shipped three of four.
ship_one usage-local IOS_USAGE_LOCAL_ROOT "~/apps/usage-grok-tf-runner"
echo "========== all done =========="
