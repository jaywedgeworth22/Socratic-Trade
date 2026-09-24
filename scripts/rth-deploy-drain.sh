#!/usr/bin/env bash
# rth-deploy-drain.sh - After the US equity cash close, nudge Coolify to build
# origin/main when production is still behind (a weekday RTH merge was latched).
#
# The REAL block is the Dockerfile latch (failed image build; last healthy
# container stays up).  This drain is the evening retry so a 10:00 ET merge
# still ships without waiting for another human merge.
#
# It never triggers a rebuild during RTH unless HOTFIX=1 or
# RTH_DEPLOY_OVERRIDE=1 is already in THIS process environment.  A mid-session
# redeliver of a non-hotfix commit would only fail the Coolify build again.
#
# Trigger attempts, in order:
#   1. Redeliver the latest GitHub push webhook to Coolify (GitHub webhook IPs
#      are allowlisted at the Cloudflare edge; Actions IPs are not).  Needs
#      GH_PAT with admin:repo_hooks; GITHUB_TOKEN cannot do this.
#   2. POST COOLIFY_DEPLOY_WEBHOOK_URL when that secret is set.
#   3. POST Coolify /api/v1/deploy with COOLIFY_DEPLOY (deploy-only token).
# If none of them nudge, this script exits 1 so the 21:20 UTC job is red.
#
# Keep this file ASCII (AGENTS.md operator-script rule).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

log() { printf '[rth-deploy-drain] %s\n' "$*" >&2; }

command -v git >/dev/null 2>&1 || { log "error: git is required"; exit 1; }
command -v curl >/dev/null 2>&1 || { log "error: curl is required"; exit 1; }
command -v python3 >/dev/null 2>&1 || { log "error: python3 is required"; exit 1; }

if ! command -v npx >/dev/null 2>&1; then
  log "error: npx is required to evaluate the latch"
  exit 1
fi

set +e
LATCH_OUT="$(npx --yes tsx scripts/assert-rth-deploy-latch.ts 2>&1)"
LATCH_RC=$?
set -e
log "$LATCH_OUT"
if [ "$LATCH_RC" -eq 2 ]; then
  log "still regular US equity hours; not nudging Coolify"
  exit 0
fi
if [ "$LATCH_RC" -eq 3 ]; then
  log "HEAD is image-noop / docs-only; not nudging Coolify"
  exit 0
fi
if [ "$LATCH_RC" -ne 0 ]; then
  log "error: latch evaluator exited $LATCH_RC"
  exit 1
fi

HOST="${DEPLOY_VERIFY_HOST:-https://socratictrade.com}"
EXPECTED_REF="${1:-${DEPLOY_VERIFY_EXPECTED_SHA:-origin/main}}"
if [ "${DEPLOY_VERIFY_NO_FETCH:-0}" != "1" ]; then
  git fetch --quiet origin >/dev/null 2>&1 || log "warn: git fetch origin failed; using local refs"
fi
if ! git rev-parse --verify "$EXPECTED_REF" >/dev/null 2>&1; then
  log "error: cannot resolve $EXPECTED_REF"
  exit 1
fi
EXPECTED_SHA="$(git rev-parse "$EXPECTED_REF")"

HEALTH_JSON="$(curl -fsS --max-time 20 "${HOST%/}/api/health" || true)"
if [ -z "$HEALTH_JSON" ]; then
  log "error: ${HOST%/}/api/health did not answer; not nudging Coolify"
  exit 1
fi
LIVE_SHA="$(printf '%s' "$HEALTH_JSON" | python3 -c 'import json,sys
try:
    body=json.load(sys.stdin)
except Exception:
    sys.exit(0)
release=body.get("checks",{}).get("release") or {}
sha=release.get("sha") if isinstance(release, dict) else None
print(sha or "")')"
if [ -z "$LIVE_SHA" ]; then
  log "error: live release sha is missing; not nudging Coolify"
  exit 1
fi
if ! git cat-file -e "${LIVE_SHA}^{commit}" 2>/dev/null; then
  git fetch --quiet origin "$LIVE_SHA" >/dev/null 2>&1 || true
fi
if git merge-base --is-ancestor "$EXPECTED_SHA" "$LIVE_SHA" 2>/dev/null; then
  log "live $LIVE_SHA already contains $EXPECTED_SHA; nothing to drain"
  exit 0
fi
PENDING_FILES="$(git diff --name-only --no-renames "$LIVE_SHA" "$EXPECTED_SHA" 2>/dev/null || true)"
if [ -n "$PENDING_FILES" ]; then
  set +e
  NOOP_OUT="$(CHANGED_FILES="$PENDING_FILES" npx --yes tsx scripts/assert-rth-deploy-latch.ts 2>&1)"
  NOOP_RC=$?
  set -e
  if [ "$NOOP_RC" -eq 3 ]; then
    log "live is behind, but the pending diff is image-noop / docs-only; not nudging Coolify"
    log "$NOOP_OUT"
    exit 0
  fi
fi
log "live $LIVE_SHA is behind $EXPECTED_SHA; nudging Coolify"

nudge_ok=0

if command -v gh >/dev/null 2>&1; then
  REPO="${GITHUB_REPOSITORY:-jaywedgeworth22/Socratic-Trade}"
  HOOK_ID="$(gh api "repos/${REPO}/hooks" --jq '.[] | select(.config.url != null and (.config.url | test("host.jays.services/webhooks"))) | .id' 2>/dev/null | head -n 1 || true)"
  if [ -n "${HOOK_ID:-}" ]; then
    DELIVERY_ID="$(gh api "repos/${REPO}/hooks/${HOOK_ID}/deliveries?per_page=30" --jq '[.[] | select(.event == "push" and .redelivery == false)] | .[0].id // empty' 2>/dev/null || true)"
    if [ -n "${DELIVERY_ID:-}" ]; then
      if gh api -X POST "repos/${REPO}/hooks/${HOOK_ID}/deliveries/${DELIVERY_ID}/redeliver" >/dev/null 2>&1; then
        log "redelivered GitHub push delivery ${DELIVERY_ID} on hook ${HOOK_ID}"
        nudge_ok=1
      else
        log "warn: hook redeliver failed (GITHUB_TOKEN often cannot write hooks); trying deploy webhook"
      fi
    else
      log "warn: no recent push delivery on Coolify hook ${HOOK_ID}"
    fi
  else
    log "warn: no Coolify GitHub webhook found via gh"
  fi
else
  log "warn: gh is not installed; skipping webhook redeliver"
fi

if [ "$nudge_ok" -eq 0 ] && [ -n "${COOLIFY_DEPLOY_WEBHOOK_URL:-}" ]; then
  if curl -fsS --max-time 20 -X POST "$COOLIFY_DEPLOY_WEBHOOK_URL" >/dev/null; then
    log "posted COOLIFY_DEPLOY_WEBHOOK_URL"
    nudge_ok=1
  else
    log "warn: COOLIFY_DEPLOY_WEBHOOK_URL POST failed"
  fi
fi

if [ "$nudge_ok" -eq 0 ] && [ -n "${COOLIFY_DEPLOY:-}" ]; then
  APP_UUID="${COOLIFY_ST_APP_UUID:-${COOLIFY_APP_UUID:-}}"
  if [ -z "$APP_UUID" ]; then
    log "COOLIFY_ST_APP_UUID not set; skipping Coolify deploy API trigger"
    exit 0
  fi
  DEPLOY_HOST="${COOLIFY_API_HOST:-https://host.jays.services}"
  http_code="$(curl -sS --max-time 20 -o /tmp/rth-drain-deploy.out -w '%{http_code}' \
    -X POST \
    -H "Authorization: Bearer ${COOLIFY_DEPLOY}" \
    -H "Accept: application/json" \
    "${DEPLOY_HOST%/}/api/v1/deploy?uuid=${APP_UUID}" || true)"
  if [ "$http_code" = "200" ] || [ "$http_code" = "201" ]; then
    log "posted Coolify deploy API for ${APP_UUID} (http ${http_code})"
    nudge_ok=1
  else
    log "warn: Coolify deploy API failed (http ${http_code:-curl-error})"
  fi
  rm -f /tmp/rth-drain-deploy.out
fi

if [ "$nudge_ok" -eq 0 ]; then
  log "error: could not nudge Coolify.  Need GH_PAT hook redeliver, COOLIFY_DEPLOY_WEBHOOK_URL, or COOLIFY_DEPLOY.  Failing the drain job so Sentry pages instead of a silent-green freeze."
  exit 1
fi
log "nudge sent; verify with bash scripts/verify-deploy-sha.sh"
exit 0
