#!/usr/bin/env bash
# isolate-shared-box-batch.sh - soft-cap Congress.Trade OCR/scan batch load.
#
# 2026-08-06: Coolify's multiplexed SSH exec stream died mid-build (exit 255)
# under shared-box contention. Congress.Trade scan-cpu-worker OCR batches ran
# on the same host all day. A retry on a quiet box survived every earlier
# failure point. ST, CT, and UM still share the Hetzner cx43
# (docs/rollouts/2026-08-07-hetzner-fleet-cutover.md).
#
# Shared-box OCR CPU budget (Hetzner cx43 = 8 vCPU):
#   5.0  default -- as high as is reasonably advisable.  Leaves 3 cores for
#        Coolify SSH + ST (including next build) + UM + CT web.  Unconstrained
#        OCR was measured at 2.83 cores (283%) on 2026-08-12; 5.0 sits above
#        that peak so normal OCR is not throttled, but cannot take the box.
#   6.0+ too high -- a concurrent ST deploy + Coolify exec stream died
#        (2026-08-06 exit 255) when batch load left too little headroom.
#   2.0  CT compose runaway floor today; throttles OCR below the 2.83 peak.
# Durable CT compose should use the same 5.0 on scan-cpu-worker (congress-app
# stays at 2.0; combined CT ceiling 7.5 still leaves a core).
#
# This script NEVER restarts a container and NEVER touches Socratic-Trade,
# Coolify, or Usage Monitor. Default is dry-run. --apply requires
# ISOLATE_SHARED_BOX_APPLY=1 so a stray invocation cannot mutate production.
#
# Remaining host constraint (this repo cannot lift it):
#   - docker update limits are ephemeral; the next CT Coolify deploy overwrites
#     them unless the owner sets Coolify CPU limits on congress-app.
#   - If OCR runs in-process inside congress-app-live (no dedicated worker
#     container), capping workers finds nothing. --include-app caps the whole
#     CT app (also caps CT web). The durable fix is a CT-repo scan worker
#     with nice/cpuset, or moving OCR off-box.
#   - Coolify has no job-level retry-on-exit-255 that this repo can set.
#
# Usage:
#   bash scripts/isolate-shared-box-batch.sh
#   bash scripts/isolate-shared-box-batch.sh --include-app
#   ISOLATE_SHARED_BOX_APPLY=1 bash scripts/isolate-shared-box-batch.sh --apply
#   bash scripts/isolate-shared-box-batch.sh --docker-ps-file fixtures.tsv
#
# Keep this file pure ASCII (AGENTS.md: operator shell scripts, Apple bash 3.2).
set -euo pipefail

CPU_SHARES="${ISOLATE_CPU_SHARES:-256}"
CPUS="${ISOLATE_CPUS:-5}"
APPLY=0
INCLUDE_APP=0
PS_FILE=""

log() { printf '[isolate-batch] %s\n' "$*" >&2; }

fail_usage() {
  log "error: $*"
  exit 1
}

while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1; shift ;;
    --include-app) INCLUDE_APP=1; shift ;;
    --docker-ps-file)
      PS_FILE="${2:-}"
      [ -n "$PS_FILE" ] || fail_usage "--docker-ps-file needs a path"
      shift 2
      ;;
    -h|--help)
      awk 'NR==1{next} /^#/{sub(/^# ?/,""); print; next} {exit}' "$0"
      exit 0
      ;;
    *) fail_usage "unknown argument: $1" ;;
  esac
done

printf '%s' "$CPU_SHARES" | grep -Eq '^[0-9]+$' || fail_usage "CPU_SHARES must be an integer."
printf '%s' "$CPUS" | grep -Eq '^[0-9]+([.][0-9]+)?$' || fail_usage "CPUS must be a number."

PROTECTED_RE='socratic|coolify|usage-monitor|usage_monitor|litestream|mock-st-app-uuid'
if [ -n "${PROTECTED_CONTAINER_UUIDS:-}" ]; then
  PROTECTED_RE="${PROTECTED_RE}|${PROTECTED_CONTAINER_UUIDS}"
fi
WORKER_RE='scan-cpu|scan_cpu|scan-worker|scan_worker|ocr'
APP_RE='congress'

list_containers() {
  if [ -n "$PS_FILE" ]; then
    [ -f "$PS_FILE" ] || fail_usage "docker-ps file not found: ${PS_FILE}"
    cat "$PS_FILE"
    return 0
  fi
  command -v docker >/dev/null 2>&1 || fail_usage "docker is required (or pass --docker-ps-file for a dry plan)."
  docker ps --format '{{.ID}}\t{{.Names}}'
}

classify() {
  # $1 id, $2 name -> prints class: protected|worker|app|other
  local name="$2"
  local lname
  lname="$(printf '%s' "$name" | tr '[:upper:]' '[:lower:]')"
  if printf '%s' "$lname" | grep -Eq "$PROTECTED_RE"; then
    printf 'protected'
    return 0
  fi
  if printf '%s' "$lname" | grep -Eq "$WORKER_RE"; then
    printf 'worker'
    return 0
  fi
  if printf '%s' "$lname" | grep -Eq "$APP_RE"; then
    printf 'app'
    return 0
  fi
  printf 'other'
}

if [ "$APPLY" = "1" ] && [ "${ISOLATE_SHARED_BOX_APPLY:-0}" != "1" ]; then
  fail_usage "--apply refused: set ISOLATE_SHARED_BOX_APPLY=1 (this mutates live CPU limits; it does not restart)."
fi

PLAN="${TMPDIR:-/tmp}/isolate-batch-plan.$$"
trap 'rm -f "$PLAN"' EXIT
: > "$PLAN"

WORKERS=0
APPS=0
PROTECTED=0
OTHER=0
WOULD_CAP=0

while IFS="$(printf '\t')" read -r cid cname; do
  [ -n "${cid:-}" ] || continue
  [ -n "${cname:-}" ] || continue
  class="$(classify "$cid" "$cname")"
  action="skip"
  reason="$class"
  case "$class" in
    protected) PROTECTED=$((PROTECTED + 1)); reason="protected (ST/Coolify/UM)" ;;
    worker)
      WORKERS=$((WORKERS + 1))
      action="cap"
      reason="ocr/scan worker"
      ;;
    app)
      APPS=$((APPS + 1))
      if [ "$INCLUDE_APP" = "1" ]; then
        action="cap"
        reason="congress app (--include-app)"
      else
        reason="congress app (pass --include-app to cap; also caps CT web)"
      fi
      ;;
    other) OTHER=$((OTHER + 1)); reason="unrelated" ;;
  esac
  if [ "$action" = "cap" ]; then
    WOULD_CAP=$((WOULD_CAP + 1))
  fi
  printf '%s\t%s\t%s\t%s\t%s\n' "$action" "$cid" "$cname" "$class" "$reason" >> "$PLAN"
done <<EOF
$(list_containers)
EOF

log "cpu-shares=${CPU_SHARES} cpus=${CPUS} apply=${APPLY} include-app=${INCLUDE_APP}"
log "classified: workers=${WORKERS} congress-app=${APPS} protected=${PROTECTED} other=${OTHER} would-cap=${WOULD_CAP}"
log "remaining host constraint: docker update is ephemeral across CT Coolify recreates; this repo cannot set CT Coolify limits or a Coolify retry-on-255."

printf '%s\n' "ACTION  ID  NAME  CLASS  REASON"
while IFS="$(printf '\t')" read -r action cid cname class reason; do
  printf '%s  %s  %s  %s  %s\n' "$action" "$cid" "$cname" "$class" "$reason"
done < "$PLAN"

if [ "$WORKERS" = "0" ] && [ "$INCLUDE_APP" = "0" ]; then
  log "no dedicated OCR/scan worker container is running."
  log "remaining host constraint: CT OCR likely shares the congress-app process."
  log "durable options: Coolify CPU limit on congress-app; CT-repo nice/cpuset worker; OCR off-box."
  log "this script can cap congress-app with --include-app (also caps CT web; no restart)."
fi

if [ "$APPLY" != "1" ]; then
  log "dry-run only. Re-run with ISOLATE_SHARED_BOX_APPLY=1 --apply to docker update (no restart)."
  exit 0
fi

if [ "$WOULD_CAP" = "0" ]; then
  log "nothing to cap."
  exit 0
fi

command -v docker >/dev/null 2>&1 || fail_usage "docker is required for --apply."

FAILED=0
while IFS="$(printf '\t')" read -r action cid cname class reason; do
  [ "$action" = "cap" ] || continue
  log "docker update --cpu-shares ${CPU_SHARES} --cpus ${CPUS} ${cid} (${cname})"
  if docker update --cpu-shares "$CPU_SHARES" --cpus "$CPUS" "$cid" >/dev/null; then
    log "capped ${cname}"
  else
    log "FAILED to cap ${cname}"
    FAILED=1
  fi
done < "$PLAN"

[ "$FAILED" = "0" ] || exit 1
log "apply complete. Limits last until the next Coolify recreate of those containers."
exit 0
