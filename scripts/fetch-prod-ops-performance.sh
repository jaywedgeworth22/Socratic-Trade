#!/usr/bin/env bash
# Fetch the production ops diagnostic PERFORMANCE rollup (realized P&L, win rate, profit
# factor, expectancy, thesis/Red-Team/model attribution, proposal funnel, equity curve).
# Requires OPS_DIAGNOSTIC_TOKEN in the environment (Cursor Cloud Secrets or local export) —
# the same token /api/ops/snapshot uses.  See docs/runbooks/ops-performance-endpoint.md.
set -euo pipefail

HOST="${OPS_SNAPSHOT_HOST:-https://socratictrade.com}"
# Optional: narrow to one connectedAccountId.  Omitted = every account the ops snapshot covers.
ACCOUNT="${OPS_PERFORMANCE_ACCOUNT:-}"
DAYS="${OPS_PERFORMANCE_DAYS:-90}"
OUT="${OPS_PERFORMANCE_OUT:-}"

TOKEN="${OPS_DIAGNOSTIC_TOKEN:-}"
if [ -z "$TOKEN" ]; then
  echo "error: OPS_DIAGNOSTIC_TOKEN is not set." >&2
  echo "Add it in Cursor Dashboard -> Cloud Agents -> Secrets (Runtime Secret)." >&2
  echo "Use the same value as production (Infisical). ADMIN_REINDEX_TOKEN is not a fallback." >&2
  exit 1
fi

URL="${HOST}/api/ops/performance?days=${DAYS}"
if [ -n "$ACCOUNT" ]; then
  URL="${URL}&account=${ACCOUNT}"
fi
echo "==> GET ${URL}" >&2

if [ -n "$OUT" ]; then
  curl -fsS -H "x-ops-token: ${TOKEN}" "$URL" -o "$OUT"
  echo "==> wrote ${OUT}" >&2
else
  curl -fsS -H "x-ops-token: ${TOKEN}" "$URL"
fi
