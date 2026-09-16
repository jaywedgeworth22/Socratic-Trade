#!/usr/bin/env bash
# alert-deploy-freshness.sh - page when production is silently behind origin/main.
#
# 2026-08-06 class: five Coolify deploys died mid-build (SSH exec stream exit 255)
# while GitHub webhooks returned 200 and /api/health stayed green on the OLD sha.
# Nobody noticed for ~14h. verify-deploy-sha.sh is the post-merge assertion (it
# polls up to 25 min). This script is the standing watchdog: one probe, then
# decide whether the lag is still a legitimate in-flight build or a freeze.
#
# Predicate: the OLDEST commit on expected that is not an ancestor of live is
# older than STALE_SECONDS (default 3600). Tip-age alone is wrong - a second
# merge 10 min ago would hide a first merge that has been stuck for hours.
#
# It VERIFIES ONLY. It never triggers a deploy, never touches Coolify, and never
# posts a deploy claim. A stale verdict means investigate the webhook / build
# queue (see .claude/skills/deploy-verify/SKILL.md), not hand-deploy.
#
# Exit codes:
#   0  fresh enough (live contains expected, OR oldest undeployed is <1h)
#      Unreachable health is also 0 by default - UptimeRobot already pages
#      site-down; this watchdog is for the silent-green-on-old-sha class.
#   1  operational error (bad usage, missing git object, unexpected probe)
#   2  live release sha is null/absent
#   3  STALE: oldest undeployed commit is >= STALE_SECONDS old
#   4  live commit is divergent from expected
#   5  live commit id is not an object in this repo
#
# Usage:
#   bash scripts/alert-deploy-freshness.sh
#   bash scripts/alert-deploy-freshness.sh origin/main
#   DEPLOY_FRESHNESS_STALE_SECONDS=3600 bash scripts/alert-deploy-freshness.sh
#   DEPLOY_FRESHNESS_NOTIFY=1 bash scripts/alert-deploy-freshness.sh
#
# Keep this file pure ASCII (AGENTS.md: operator shell scripts, Apple bash 3.2).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VERIFY="${SCRIPT_DIR}/verify-deploy-sha.sh"
SLACK="${SCRIPT_DIR}/slack-sync.sh"

HOST="${DEPLOY_VERIFY_HOST:-https://socratictrade.com}"
EXPECTED_REF="${1:-${DEPLOY_VERIFY_EXPECTED_SHA:-origin/main}}"
STALE_SECONDS="${DEPLOY_FRESHNESS_STALE_SECONDS:-3600}"
NOTIFY="${DEPLOY_FRESHNESS_NOTIFY:-0}"
# success|failure|none - previous cron tick, used to de-dupe Slack pages.
PREVIOUS="${DEPLOY_FRESHNESS_PREVIOUS_CONCLUSION:-none}"
TREAT_UNREACHABLE_OK="${DEPLOY_FRESHNESS_TREAT_UNREACHABLE:-1}"
NO_FETCH="${DEPLOY_VERIFY_NO_FETCH:-0}"
CURL_TIMEOUT_SECONDS="${DEPLOY_VERIFY_CURL_TIMEOUT_SECONDS:-20}"

log() { printf '[deploy-freshness] %s\n' "$*" >&2; }

fail_usage() {
  log "error: $*"
  exit 1
}

[ -f "$VERIFY" ] || fail_usage "missing ${VERIFY}"
command -v git >/dev/null 2>&1 || fail_usage "git is required."
command -v jq >/dev/null 2>&1 || fail_usage "jq is required."
printf '%s' "$STALE_SECONDS" | grep -Eq '^[0-9]+$' || fail_usage "STALE_SECONDS must be an integer."
git rev-parse --git-dir >/dev/null 2>&1 || fail_usage "must run inside the Socratic.Trade git repo."

resolve_commit() {
  git rev-parse --verify --quiet "${1}^{commit}" 2>/dev/null || true
}

if [ "$NO_FETCH" != "1" ]; then
  git fetch --quiet origin >/dev/null 2>&1 || log "warn: git fetch origin failed - resolving against local refs only."
fi

EXPECTED_SHA="$(resolve_commit "$EXPECTED_REF")"
[ -n "$EXPECTED_SHA" ] || fail_usage "cannot resolve expected ref '${EXPECTED_REF}' to a commit in this repo."

# watch_paths in Coolify skips docs/**, so a docs-only commit never deploys.
# Compare against the newest image-affecting commit instead.
IMAGE_AFFECTING_SHA="$(git log -1 --format="%H" "$EXPECTED_SHA" -- . ":(exclude)docs" 2>/dev/null || true)"
if [ -n "$IMAGE_AFFECTING_SHA" ]; then
  EXPECTED_SHA="$IMAGE_AFFECTING_SHA"
fi

# Single-shot reuse of the existing gate. Capture both streams; the gate logs to stderr.
set +e
VERIFY_OUT="$(
  DEPLOY_VERIFY_HOST="$HOST" \
  DEPLOY_VERIFY_TIMEOUT_SECONDS=0 \
  DEPLOY_VERIFY_NO_FETCH=1 \
  DEPLOY_VERIFY_CURL_TIMEOUT_SECONDS="$CURL_TIMEOUT_SECONDS" \
  bash "$VERIFY" "$EXPECTED_SHA" 2>&1
)"
VERIFY_CODE=$?
set -e

log "verify-deploy-sha exit ${VERIFY_CODE}"
printf '%s\n' "$VERIFY_OUT" | sed 's/^/[verify-deploy-sha] /' >&2

LIVE_SHA=""
LIVE_FULL=""
OLDEST_UNDEPLOYED=""
OLDEST_AGE=""
VERDICT="ok"
NOTIFY_REASON=""

extract_live_sha() {
  # Prefer a live probe so we do not depend on log-line wording.
  local body
  body="$(curl -sS --max-time "$CURL_TIMEOUT_SECONDS" "${HOST%/}/api/health" 2>/dev/null || true)"
  printf '%s' "$body" | jq -r '.checks.release.sha // empty' 2>/dev/null || true
}

maybe_notify() {
  # $1 reason tag, $2 message
  if [ "$NOTIFY" != "1" ]; then
    log "notify skipped (DEPLOY_FRESHNESS_NOTIFY=${NOTIFY})."
    return 0
  fi
  case "$PREVIOUS" in
    failure)
      if [ "$1" != "recovered" ]; then
        log "notify skipped (same incident as previous failure; de-dupe)."
        return 0
      fi
      ;;
    success|none)
      if [ "$1" = "recovered" ]; then
        log "notify skipped (no prior failure to recover from)."
        return 0
      fi
      ;;
    *)
      log "warn: unknown PREVIOUS_CONCLUSION '${PREVIOUS}' - treating as none."
      if [ "$1" = "recovered" ]; then
        return 0
      fi
      ;;
  esac
  if [ ! -f "$SLACK" ]; then
    log "notify skipped (slack-sync.sh not present)."
    return 0
  fi
  SLACK_AGENT_NAME="${SLACK_AGENT_NAME:-ST}" \
  SLACK_TOPIC="${SLACK_TOPIC:-Socratic.Trade}" \
    bash "$SLACK" post "$2" || log "warn: slack-sync post failed (token missing or Slack error)."
}

case "$VERIFY_CODE" in
  0)
    VERDICT="fresh"
    log "PASS: live contains ${EXPECTED_SHA}."
    maybe_notify recovered "deploy freshness recovered: prod contains ${EXPECTED_SHA:0:12}.  Silent-freeze watch is clear.  #2545"
    exit 0
    ;;
  1)
    if [ "$TREAT_UNREACHABLE_OK" = "1" ]; then
      log "health unreachable or unparseable - not the silent-freeze class (UptimeRobot pages site-down). Treating as OK."
      exit 0
    fi
    log "FAIL: operational/reachability error from verify-deploy-sha."
    exit 1
    ;;
  2)
    VERDICT="no-sha"
    log "FAIL: production publishes no release sha."
    maybe_notify no-sha "deploy freshness: prod /api/health has no .checks.release.sha so drift cannot be verified.  Check Coolify SOURCE_COMMIT injection.  #2545"
    exit 2
    ;;
  4)
    VERDICT="divergent"
    LIVE_SHA="$(extract_live_sha)"
    log "FAIL: production is on a divergent commit (live ${LIVE_SHA:-unknown}, expected ${EXPECTED_SHA})."
    maybe_notify divergent "deploy freshness DIVERGENT: prod ${LIVE_SHA:-unknown} neither contains nor is contained by origin/main ${EXPECTED_SHA:0:12}.  Escalate before anything touches production.  #2545"
    exit 4
    ;;
  5)
    VERDICT="unknown-live"
    LIVE_SHA="$(extract_live_sha)"
    log "FAIL: live ${LIVE_SHA:-unknown} is not a commit in this repo."
    maybe_notify unknown "deploy freshness: prod is running ${LIVE_SHA:-unknown}, which is not in this repo.  Fetch and re-check; if it persists, escalate.  #2545"
    exit 5
    ;;
  3)
    ;;
  *)
    log "FAIL: unexpected verify-deploy-sha exit ${VERIFY_CODE}."
    exit 1
    ;;
esac

# Exit 3 from the gate: live is a strict ancestor of expected. Age the oldest gap.
LIVE_SHA="$(extract_live_sha)"
[ -n "$LIVE_SHA" ] || fail_usage "verify-deploy-sha reported behind but /api/health has no release sha."
LIVE_FULL="$(resolve_commit "$LIVE_SHA")"
[ -n "$LIVE_FULL" ] || fail_usage "cannot resolve live sha '${LIVE_SHA}' after a behind verdict."

OLDEST_UNDEPLOYED="$(git log --format=%H --reverse "${LIVE_FULL}..${EXPECTED_SHA}" | head -n 1)"
[ -n "$OLDEST_UNDEPLOYED" ] || fail_usage "live is behind expected but git log ${LIVE_FULL}..${EXPECTED_SHA} is empty."

OLDEST_CT="$(git log -1 --format=%ct "$OLDEST_UNDEPLOYED")"
NOW_EPOCH="$(date +%s)"
OLDEST_AGE=$((NOW_EPOCH - OLDEST_CT))
if [ "$OLDEST_AGE" -lt 0 ]; then
  OLDEST_AGE=0
fi

OLDEST_ISO="$(git log -1 --format=%cI "$OLDEST_UNDEPLOYED")"
log "oldest undeployed ${OLDEST_UNDEPLOYED} (${OLDEST_ISO}) age ${OLDEST_AGE}s (threshold ${STALE_SECONDS}s)"
log "  live ${LIVE_FULL}  expected ${EXPECTED_SHA}"

if [ "$OLDEST_AGE" -lt "$STALE_SECONDS" ]; then
  VERDICT="in-flight"
  log "PASS: main is ahead but the oldest undeployed commit is still inside the ${STALE_SECONDS}s deploy window."
  exit 0
fi

VERDICT="stale"
HOURS=$((OLDEST_AGE / 3600))
MINS=$(((OLDEST_AGE % 3600) / 60))
log "FAIL: production is STALE - oldest undeployed commit is ${HOURS}h${MINS}m old."
log "  this is the silent-freeze class (webhook 200s, health green on an old sha)."
log "  do NOT hand-trigger a deploy - investigate the webhook and Coolify build queue."

maybe_notify stale "deploy freshness STALE: prod ${LIVE_FULL:0:12} is behind origin/main ${EXPECTED_SHA:0:12}.  Oldest undeployed ${OLDEST_UNDEPLOYED:0:12} (${OLDEST_ISO}) is ${HOURS}h${MINS}m old.  Silent freeze class - webhook 200s, health green on the old sha.  Do not hand-trigger.  Investigate Coolify queue / SSH exec stream.  #2545"

exit 3
