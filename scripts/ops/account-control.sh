#!/usr/bin/env bash
# Ops-token account control for ONE explicitly named connected account.
# Wraps POST /api/ops/account-control (app/api/ops/account-control/route.ts).
# Runbook: docs/runbooks/ops-account-control.md
#
# Usage:
#   scripts/ops/account-control.sh list   <connectedAccountId>
#   scripts/ops/account-control.sh cancel <connectedAccountId> [--order <orderId>]... (--dry-run | --execute)
#   scripts/ops/account-control.sh state  <connectedAccountId> <active|close_only|halted> (--dry-run | --execute)
#
# Examples:
#   scripts/ops/account-control.sh list   becad9f1-c80e-4d31-abc9-2d57152e519c
#   scripts/ops/account-control.sh cancel becad9f1-c80e-4d31-abc9-2d57152e519c --dry-run
#   scripts/ops/account-control.sh cancel becad9f1-c80e-4d31-abc9-2d57152e519c --execute
#   scripts/ops/account-control.sh cancel becad9f1-c80e-4d31-abc9-2d57152e519c --order 12345 --order 12346 --execute
#   scripts/ops/account-control.sh state  becad9f1-c80e-4d31-abc9-2d57152e519c active --dry-run
#   scripts/ops/account-control.sh state  becad9f1-c80e-4d31-abc9-2d57152e519c active --execute
#
# Environment:
#   OPS_DIAGNOSTIC_TOKEN  required.  Read from the environment only; never printed, never put on a
#                         command line (curl reads the header from a bash process substitution).
#   OPS_HOST              optional, default https://socratictrade.com
#
# Mutating commands (cancel, state) refuse to run without an explicit --dry-run or --execute.
# Exit status: 0 on HTTP 2xx, 1 on usage errors, 2 on an HTTP error response.
# Keep this file pure ASCII (bash 3.2 on macOS mis-parses non-ASCII next to $VARS).
set -euo pipefail

HOST="${OPS_HOST:-https://socratictrade.com}"
ID_PATTERN='^[A-Za-z0-9._:-]{1,200}$'

usage() {
  sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//' >&2
  exit 1
}

die() {
  echo "error: $*" >&2
  exit 1
}

valid_id() {
  printf '%s' "$1" | grep -Eq "$ID_PATTERN"
}

if [ -z "${OPS_DIAGNOSTIC_TOKEN:-}" ]; then
  die "OPS_DIAGNOSTIC_TOKEN is not set.  Export it from your secret store first (do not paste it into a command)."
fi

[ "$#" -ge 2 ] || usage
COMMAND="$1"
ACCOUNT_ID="$2"
shift 2
valid_id "$ACCOUNT_ID" || die "connectedAccountId has unexpected characters."

MODE=""
ORDER_JSON=""
TARGET_STATE=""

case "$COMMAND" in
  list)
    [ "$#" -eq 0 ] || usage
    BODY="{\"action\":\"list_working_orders\",\"connectedAccountId\":\"${ACCOUNT_ID}\"}"
    ;;
  cancel)
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --order)
          [ "$#" -ge 2 ] || die "--order needs an order id."
          valid_id "$2" || die "order id has unexpected characters."
          if [ -n "$ORDER_JSON" ]; then ORDER_JSON="${ORDER_JSON},"; fi
          ORDER_JSON="${ORDER_JSON}\"$2\""
          shift 2
          ;;
        --dry-run) MODE="dry"; shift ;;
        --execute) MODE="execute"; shift ;;
        *) usage ;;
      esac
    done
    [ -n "$MODE" ] || die "cancel needs --dry-run or --execute."
    DRY="false"
    if [ "$MODE" = "dry" ]; then DRY="true"; fi
    if [ -n "$ORDER_JSON" ]; then
      BODY="{\"action\":\"cancel_working_orders\",\"connectedAccountId\":\"${ACCOUNT_ID}\",\"orderIds\":[${ORDER_JSON}],\"dryRun\":${DRY}}"
    else
      BODY="{\"action\":\"cancel_working_orders\",\"connectedAccountId\":\"${ACCOUNT_ID}\",\"dryRun\":${DRY}}"
    fi
    ;;
  state)
    [ "$#" -ge 1 ] || usage
    TARGET_STATE="$1"
    shift
    case "$TARGET_STATE" in
      active|close_only|halted) ;;
      *) die "state must be active, close_only, or halted." ;;
    esac
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --dry-run) MODE="dry"; shift ;;
        --execute) MODE="execute"; shift ;;
        *) usage ;;
      esac
    done
    [ -n "$MODE" ] || die "state needs --dry-run or --execute."
    DRY="false"
    if [ "$MODE" = "dry" ]; then DRY="true"; fi
    BODY="{\"action\":\"set_system_state\",\"connectedAccountId\":\"${ACCOUNT_ID}\",\"systemState\":\"${TARGET_STATE}\",\"dryRun\":${DRY}}"
    ;;
  *)
    usage
    ;;
esac

URL="${HOST}/api/ops/account-control"
echo "==> POST ${URL} (${COMMAND}${MODE:+, $MODE})" >&2

RESPONSE_FILE="$(mktemp "${TMPDIR:-/tmp}/ops-account-control.XXXXXX")"
trap 'rm -f "$RESPONSE_FILE"' EXIT

# The token travels in a header file produced by a bash builtin (printf) through a process
# substitution, so it never appears in any process's argv.
HTTP_STATUS="$(
  printf '%s' "$BODY" | curl -sS \
    -X POST \
    -H @<(printf 'x-ops-token: %s\n' "$OPS_DIAGNOSTIC_TOKEN") \
    -H 'content-type: application/json' \
    --data-binary @- \
    -o "$RESPONSE_FILE" \
    -w '%{http_code}' \
    "$URL"
)"

if command -v python3 >/dev/null 2>&1; then
  python3 -m json.tool "$RESPONSE_FILE" 2>/dev/null || cat "$RESPONSE_FILE"
else
  cat "$RESPONSE_FILE"
fi
echo >&2
echo "==> HTTP ${HTTP_STATUS}" >&2

case "$HTTP_STATUS" in
  2*) exit 0 ;;
  *) exit 2 ;;
esac
