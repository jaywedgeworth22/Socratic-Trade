#!/usr/bin/env bash
# Fetch the production ops diagnostic snapshot (strategy runs, per-account state, audit).
# Requires OPS_DIAGNOSTIC_TOKEN in the environment (Cursor Cloud Secrets or local export).
# The same token must be set on trading-live (see docs/rollouts/2026-06-29-ops-diagnostic-snapshot.md).
set -euo pipefail

HOST="${OPS_SNAPSHOT_HOST:-https://socratictrade.com}"
RUNS="${OPS_SNAPSHOT_RUNS:-20}"
AUDIT="${OPS_SNAPSHOT_AUDIT:-40}"
# Opt-in broker order-list breakdown (live vs listed vs done_for_day). Off by default —
# getEquityOrders can paginate large Alpaca histories and slow the snapshot.
ORDERS="${OPS_SNAPSHOT_ORDERS:-}"
# Opt-in per-working-order role classification (protective stop, bracket leg, app-tracked
# entry/exit, external, ...) with a one-sentence whyResting. Implies ORDERS=1. Off by default
# for the same reason as ORDERS.
ORDERS_DETAIL="${OPS_SNAPSHOT_ORDERS_DETAIL:-}"
OUT="${OPS_SNAPSHOT_OUT:-}"

TOKEN="${OPS_DIAGNOSTIC_TOKEN:-}"
if [ -z "$TOKEN" ]; then
  echo "error: OPS_DIAGNOSTIC_TOKEN is not set." >&2
  echo "Add it in Cursor Dashboard -> Cloud Agents -> Secrets (Runtime Secret)." >&2
  echo "Use the same value on production (Infisical). ADMIN_REINDEX_TOKEN is not a fallback." >&2
  exit 1
fi

URL="${HOST}/api/ops/snapshot?runs=${RUNS}&audit=${AUDIT}"
if [ "${ORDERS}" = "1" ] || [ "${ORDERS}" = "true" ]; then
  URL="${URL}&orders=1"
fi
if [ "${ORDERS_DETAIL}" = "1" ] || [ "${ORDERS_DETAIL}" = "true" ]; then
  URL="${URL}&ordersDetail=1"
fi
echo "==> GET ${URL}" >&2

if [ -n "$OUT" ]; then
  curl -fsS -H "x-ops-token: ${TOKEN}" "$URL" -o "$OUT"
  echo "==> wrote ${OUT}" >&2
else
  curl -fsS -H "x-ops-token: ${TOKEN}" "$URL"
fi
