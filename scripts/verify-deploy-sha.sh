#!/usr/bin/env bash
# verify-deploy-sha.sh - assert that production is actually RUNNING a given commit.
#
# Merging to `main` auto-deploys `socratic-trade-prod` (AGENTS.md "Hosting & dev servers";
# docs/rollouts/2026-07-10-auto-deploy-on.md), but nothing in this repo ever CHECKED that the
# deploy landed. The app has published its own release identity on the PUBLIC liveness probe all
# along -- `/api/health` -> `.checks.release.sha`, produced by `runtimeReleaseIdentity()` in
# src/lib/runtime-health.ts -- and that field had zero consumers, so silent drift was invisible.
# On 2026-08-01 production was serving d456ca58 while origin/main was four commits ahead,
# including two code changes, and nothing anywhere noticed. This script is the missing assertion.
#
# It VERIFIES ONLY. It never triggers a deploy, never touches the Coolify API, and never posts a
# deploy claim -- auto-deploy on merge is the standing protocol and manual triggers/claims are
# explicitly retired. If this script fails, the fix is to investigate the webhook/build queue,
# not to hand-deploy.
#
# PREDICATE: "the live commit CONTAINS the expected commit" (`git merge-base --is-ancestor`), NOT
# "live sha == origin/main". A multi-agent fleet lands PRs continuously and builds serialize
# (`concurrent_builds=1`), so origin/main routinely advances past your merge while your own deploy
# is still building; strict equality would fail spuriously on every busy afternoon and the alarm
# would get ignored. Containment is the fact you actually care about: is my change live? It also
# makes the check safely cancellable -- if a newer commit is verified live, every earlier commit
# on main is live too.
#
# It reads the sha from the PUBLIC part of the payload and degrades gracefully if the field is
# absent (exit 2 with an actionable message) rather than silently passing. `null` is never a pass:
# nothing in this repo sets APP_RELEASE_SHA/SOURCE_COMMIT, so the value depends entirely on
# Coolify injecting one, and "unknown" must be as loud as "wrong".
#
# Exit codes -- each one is a different action for the operator:
#   0  live contains the expected commit: the deploy landed
#   1  operational error: bad usage, missing dependency, unresolvable ref, endpoint never answered
#   2  the live release sha is not exposed (null/absent): nothing can be verified
#   3  drift: live is BEHIND the expected commit when the poll window ran out
#   4  divergence: the live commit neither contains nor is contained by the expected commit
#   5  the live commit id is not an object in this repo, so it cannot be classified
#
# Usage:
#   bash scripts/verify-deploy-sha.sh                  # expect origin/main, poll up to 25 min
#   bash scripts/verify-deploy-sha.sh <sha-or-ref>     # expect a specific merge commit
#   DEPLOY_VERIFY_TIMEOUT_SECONDS=0 bash scripts/verify-deploy-sha.sh   # single shot, no polling
#
# Keep this file pure ASCII (AGENTS.md: operator shell scripts, Apple bash 3.2).
set -euo pipefail

HOST="${DEPLOY_VERIFY_HOST:-https://socratictrade.com}"
EXPECTED_REF="${1:-${DEPLOY_VERIFY_EXPECTED_SHA:-origin/main}}"
# Default window is deliberately generous. Builds serialize on the box, so a deploy queued behind
# another build legitimately takes far longer than the ~4 min a build alone needs; a 10-minute
# window would make this a known-flaky alarm that agents learn to ignore.
TIMEOUT_SECONDS="${DEPLOY_VERIFY_TIMEOUT_SECONDS:-1500}"
INTERVAL_SECONDS="${DEPLOY_VERIFY_INTERVAL_SECONDS:-20}"
CURL_TIMEOUT_SECONDS="${DEPLOY_VERIFY_CURL_TIMEOUT_SECONDS:-20}"
# Set to 1 when the caller has already fetched (CI checkout) or has no network for git.
NO_FETCH="${DEPLOY_VERIFY_NO_FETCH:-0}"

URL="${HOST%/}/api/health"

log() { printf '[verify-deploy-sha] %s\n' "$*" >&2; }

fail_usage() {
  log "error: $*"
  exit 1
}

command -v curl >/dev/null 2>&1 || fail_usage "curl is required."
command -v git >/dev/null 2>&1 || fail_usage "git is required."
command -v jq >/dev/null 2>&1 || fail_usage "jq is required (brew install jq / apt-get install jq)."
git rev-parse --git-dir >/dev/null 2>&1 || fail_usage "must run inside the Socratic.Trade git repo."

FETCH_ATTEMPTS=0
try_fetch() {
  # One fetch up front so `origin/main` and any freshly-pushed live commit are resolvable, plus at
  # most one more if we later see a commit id we do not have locally (objects still propagating).
  [ "$NO_FETCH" = "1" ] && return 0
  [ "$FETCH_ATTEMPTS" -ge 2 ] && return 0
  FETCH_ATTEMPTS=$((FETCH_ATTEMPTS + 1))
  git fetch --quiet origin >/dev/null 2>&1 || log "warn: git fetch origin failed - resolving against local refs only."
  return 0
}

json_field() {
  # $1 = JSON payload, $2 = jq filter. Prints the value, or nothing if the filter cannot be
  # evaluated. Never fails the caller - absence is a state this script reports, not a crash.
  printf '%s' "$1" | jq -r "$2" 2>/dev/null || true
}

resolve_commit() {
  # Prints the full 40-char sha for a ref or short sha, or nothing if this repo does not have it.
  git rev-parse --verify --quiet "${1}^{commit}" 2>/dev/null || true
}

try_fetch
EXPECTED_SHA="$(resolve_commit "$EXPECTED_REF")"
if [ -z "$EXPECTED_SHA" ]; then
  fail_usage "cannot resolve expected ref '${EXPECTED_REF}' to a commit in this repo."
fi

# watch_paths in Coolify skips docs/**, so a docs-only commit never deploys.
# Compare against the newest image-affecting commit instead.
IMAGE_AFFECTING_SHA="$(git log -1 --format="%H" "$EXPECTED_SHA" -- . ":(exclude)docs" 2>/dev/null || true)"
if [ -n "$IMAGE_AFFECTING_SHA" ]; then
  EXPECTED_SHA="$IMAGE_AFFECTING_SHA"
fi

log "expecting ${EXPECTED_SHA} (${EXPECTED_REF})"
log "probing ${URL} every ${INTERVAL_SECONDS}s for up to ${TIMEOUT_SECONDS}s"

START_EPOCH="$(date +%s)"
DEADLINE_EPOCH=$((START_EPOCH + TIMEOUT_SECONDS))

# Carried between attempts so the final exit reflects the LAST observed state rather than a
# transient one. A container restarting mid-deploy makes the probe unreachable for a few seconds;
# that must not be the verdict if a later attempt got a real answer.
LAST_CODE=1
LAST_MESSAGE="the health endpoint never returned a parseable payload."
LIVE_SHA=""
LIVE_UPTIME=""
LIVE_OK=""
LIVE_DB=""
LIVE_SCHEDULER_AGE=""

probe_once() {
  # Sets LIVE_* and LAST_CODE/LAST_MESSAGE. Returns 0 only when the expected commit is live.
  LIVE_SHA=""
  LIVE_UPTIME=""
  LIVE_OK=""
  LIVE_DB=""
  LIVE_SCHEDULER_AGE=""

  # Deliberately NOT `curl -f`: /api/health answers 503 with a full JSON body when a dependency is
  # degraded, and that body still carries the release identity we came for. A degraded app that is
  # running the right commit is a different problem from a stale deploy.
  local body
  body="$(curl -sS --max-time "$CURL_TIMEOUT_SECONDS" "$URL" 2>/dev/null || true)"
  if [ -z "$body" ]; then
    LAST_CODE=1
    LAST_MESSAGE="no response from ${URL} (is the app up? is DNS/edge healthy?)."
    return 1
  fi

  if ! printf '%s' "$body" | jq -e . >/dev/null 2>&1; then
    LAST_CODE=1
    LAST_MESSAGE="response from ${URL} was not JSON (Cloudflare error page? wrong host?)."
    return 1
  fi

  # One jq call per field, on purpose. The obvious `[...] | @tsv` + `IFS=$'\t' read` shortcut is
  # WRONG here: tab is an IFS *whitespace* character, so bash collapses runs of it and drops
  # leading/trailing empties - a missing `.checks.release.sha` silently shifts the next field into
  # LIVE_SHA and the script "sees" a release id that was never published. The payload is a few KB;
  # five jq invocations cost nothing next to getting this class of answer wrong.
  LIVE_SHA="$(json_field "$body" '.checks.release.sha // ""')"
  LIVE_UPTIME="$(json_field "$body" '.checks.release.processUptimeSeconds // ""')"
  LIVE_OK="$(json_field "$body" '.ok | tostring')"
  LIVE_DB="$(json_field "$body" '.checks.db // ""')"
  LIVE_SCHEDULER_AGE="$(json_field "$body" '.checks.schedulerAgeSeconds // ""')"

  if [ -z "$LIVE_SHA" ] || [ "$LIVE_SHA" = "null" ]; then
    LAST_CODE=2
    LAST_MESSAGE="the app reports no release sha (.checks.release.sha is null or absent).
  Nothing in this repo sets APP_RELEASE_SHA/SOURCE_COMMIT, so this value comes from Coolify's
  build environment - check that the deploy still injects SOURCE_COMMIT, and that the field has
  not moved off the public part of app/api/health/route.ts behind an operator token."
    return 1
  fi

  if ! printf '%s' "$LIVE_SHA" | grep -Eq '^[0-9a-fA-F]{7,64}$'; then
    LAST_CODE=2
    LAST_MESSAGE="the app reported a release id that is not a commit sha: '$(printf '%.64s' "$LIVE_SHA")'."
    return 1
  fi
  LIVE_SHA="$(printf '%s' "$LIVE_SHA" | tr '[:upper:]' '[:lower:]')"

  # Resolve the live id against real git objects instead of hand-rolling a prefix comparison.
  # getGitSha accepts 7-64 hex chars, so Coolify may inject a SHORT sha; string prefix matching in
  # bash has to run actual-is-prefix-of-expected and silently passes when written backwards.
  # `git rev-parse <short>^{commit}` handles both lengths and is unambiguous by construction.
  local live_full
  live_full="$(resolve_commit "$LIVE_SHA")"
  if [ -z "$live_full" ]; then
    try_fetch
    live_full="$(resolve_commit "$LIVE_SHA")"
  fi
  if [ -z "$live_full" ]; then
    LAST_CODE=5
    LAST_MESSAGE="production is running ${LIVE_SHA}, which is not a commit in this repo.
  Either the clone is shallow/stale, or the box built something that was never pushed to main."
    return 1
  fi

  if git merge-base --is-ancestor "$EXPECTED_SHA" "$live_full" 2>/dev/null; then
    LAST_CODE=0
    LAST_MESSAGE="live ${live_full} contains ${EXPECTED_SHA}."
    return 0
  fi

  if git merge-base --is-ancestor "$live_full" "$EXPECTED_SHA" 2>/dev/null; then
    LAST_CODE=3
    LAST_MESSAGE="production is BEHIND: live ${live_full}, expected ${EXPECTED_SHA}."
  else
    LAST_CODE=4
    LAST_MESSAGE="production is on a DIVERGENT commit: live ${live_full} neither contains nor is
  contained by ${EXPECTED_SHA}. Something deployed a non-main commit, or main was rewritten."
  fi
  return 1
}

while true; do
  if probe_once; then
    log "PASS: ${LAST_MESSAGE}"
    log "  ok=${LIVE_OK} db=${LIVE_DB} schedulerAgeSeconds=${LIVE_SCHEDULER_AGE} processUptimeSeconds=${LIVE_UPTIME}"
    exit 0
  fi

  NOW_EPOCH="$(date +%s)"
  ELAPSED=$((NOW_EPOCH - START_EPOCH))
  log "waiting (${ELAPSED}s elapsed, exit-code-so-far ${LAST_CODE}): $(printf '%s\n' "$LAST_MESSAGE" | head -n 1)"

  # Only keep polling for states a pending deploy can still resolve: unreachable (container
  # restarting), behind (build still queued), unknown commit (objects still propagating). A missing
  # release sha is a configuration fact and a divergent commit is a "stop and look now" event -
  # sitting on either for 25 minutes just delays the alarm without changing the answer.
  case "$LAST_CODE" in
    2|4) break ;;
  esac

  [ "$NOW_EPOCH" -ge "$DEADLINE_EPOCH" ] && break
  sleep "$INTERVAL_SECONDS"
done

ELAPSED=$(($(date +%s) - START_EPOCH))
log "FAIL after ${ELAPSED}s: ${LAST_MESSAGE}"

# Distinguish "the deploy has not happened yet / never fired" from "a deploy happened and shipped
# the wrong thing". The health payload already carries processUptimeSeconds, so this costs nothing
# and it is the difference between chasing the webhook and chasing the build.
if [ "$LAST_CODE" = "3" ] && printf '%s' "$LIVE_UPTIME" | grep -Eq '^[0-9]+$'; then
  RESTART_WINDOW=$((ELAPSED + 120))
  if [ "$LIVE_UPTIME" -lt "$RESTART_WINDOW" ]; then
    log "  the app process restarted ${LIVE_UPTIME}s ago but came up on an older commit - a deploy"
    log "  ran and shipped the wrong revision (stale build cache, or a queued build still landing)."
  else
    log "  the app process has been up ${LIVE_UPTIME}s with no restart in this window - no deploy"
    log "  ever started. Check that the merge webhook fired and that the build queue is not wedged"
    log "  on a zombie in_progress deployment (see .claude/skills/deploy-verify/SKILL.md)."
  fi
fi

case "$LAST_CODE" in
  1) log "  this is an operational/reachability failure, not proof of drift." ;;
  4) log "  escalate on #agent-sync before anything else touches production." ;;
  5) log "  run 'git fetch origin' and re-run; if it persists, escalate on #agent-sync." ;;
esac

log "  do NOT hand-trigger a deploy to 'fix' this - investigate the webhook and build queue."
exit "$LAST_CODE"
