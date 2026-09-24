#!/usr/bin/env bash
# Safe Infisical helpers for agents — NEVER dumps secret values to stdout/stderr.
#
# Usage:
#   bash scripts/infisical-secrets-safe.sh set KEY=VALUE --projectId ID --env prod
#   bash scripts/infisical-secrets-safe.sh has KEY --projectId ID --env prod
#   bash scripts/infisical-secrets-safe.sh names --projectId ID --env prod
#   bash scripts/infisical-secrets-safe.sh delete KEY --projectId ID --env prod
#
# LLM provider API keys must NEVER be stored in Infisical for Socratic-Trade.
# They belong on Connections (user_api_keys). `set` refuses those names.
#
# Forbidden (agents must not run these):
#   infisical secrets                 # bare list prints every value
#   infisical secrets get KEY --plain # without piping to wc/redaction
#   infisical secrets --output json|yaml|dotenv

set -euo pipefail

die() { echo "infisical-secrets-safe: ERROR: $*" >&2; exit 1; }
info() { echo "infisical-secrets-safe: $*" >&2; }

command -v infisical >/dev/null 2>&1 || die "infisical CLI not found"

# Runtime LLM keys for this app live on Connections, not Infisical. Agents have
# re-created GEMINI_API_KEY / DEEPSEEK_API_KEY in Infisical and then "fixed" the
# app to copy them onto the primary user. Refuse the write.
LLM_RUNTIME_KEYS="OPENAI_API_KEY ANTHROPIC_API_KEY XAI_API_KEY GEMINI_API_KEY MISTRAL_API_KEY DEEPSEEK_API_KEY MOONSHOT_API_KEY KIMI_API_KEY MOONSHOTAI_API_KEY OPENROUTER_API_KEY META_API_KEY MINIMAX_API_KEY"

is_llm_runtime_key() {
  local key="$1"
  for k in $LLM_RUNTIME_KEYS; do
    [ "$k" = "$key" ] && return 0
  done
  return 1
}

cmd="${1:-}"; shift || true
[ -n "$cmd" ] || die "missing command (set|has|names|delete)"

# Reject known-leaky patterns if someone passes them by mistake
for a in "$@"; do
  case "$a" in
    --plain|--output=*|json|yaml|dotenv)
      # allow --plain only for has (we consume it ourselves)
      if [ "$cmd" != "has" ] || [ "$a" != "--plain" ]; then
        if [ "$a" = "--plain" ] && [ "$cmd" = "has" ]; then
          :
        elif [[ "$a" == --output* ]] || [ "$a" = "json" ] || [ "$a" = "yaml" ] || [ "$a" = "dotenv" ]; then
          die "refusing $a — dumps secret values. Use set/has/names only."
        fi
      fi
      ;;
  esac
done

case "$cmd" in
  set)
    pair="${1:-}"; shift || true
    [ -n "$pair" ] || die "usage: set KEY=VALUE --projectId ID --env ENV"
    case "$pair" in
      *=*) ;;
      *) die "set argument must be KEY=VALUE" ;;
    esac
    key="${pair%%=*}"
    if is_llm_runtime_key "$key"; then
      die "refusing to set $key — LLM runtime keys must not live in Infisical for Socratic-Trade; paste them on Connections"
    fi
    # never echo value
    infisical secrets set "$pair" "$@" >/dev/null
    info "set ok key=$key"
    ;;
  has)
    key="${1:-}"; shift || true
    [ -n "$key" ] || die "usage: has KEY --projectId ID --env ENV"
    # capture plain value and only print length
    val="$(infisical secrets get "$key" --plain "$@" 2>/dev/null || true)"
    if [ -z "$val" ]; then
      info "missing key=$key"
      exit 1
    fi
    info "present key=$key len=${#val}"
    ;;
  names)
    # List key NAMES only via JSON + jq, never print secretValue
    raw="$(infisical secrets --output json "$@" 2>/dev/null || true)"
    [ -n "$raw" ] || die "names: empty response"
    if command -v jq >/dev/null 2>&1; then
      # Coolify/Infisical shapes vary; try common paths
      echo "$raw" | jq -r '
        if type=="array" then .[]
        elif .secrets then .secrets[]
        else empty end
        | (.secretKey // .key // .name // empty)
      ' | sort -u
    else
      die "jq required for names"
    fi
    ;;
  delete)
    key="${1:-}"; shift || true
    [ -n "$key" ] || die "usage: delete KEY --projectId ID --env ENV"
    # Default CLI type is personal; project secrets are shared.
    infisical secrets delete "$key" --type shared --silent "$@" >/dev/null
    info "deleted key=$key"
    ;;
  *)
    die "unknown command: $cmd"
    ;;
esac
