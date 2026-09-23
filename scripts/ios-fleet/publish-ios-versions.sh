#!/usr/bin/env bash
# publish-ios-versions.sh — update the public fleet iOS version manifest.
#
# Called by ship-testflight.sh after a successful upload.  Also safe to run
# by hand.  Never prints secret values.  Failure is non-fatal for ships.
#
# Usage:
#   bash scripts/ios-fleet/publish-ios-versions.sh \
#     --bundle-id trade.socratic.app \
#     --version 1.0.68 \
#     [--build 202608211800] \
#     [--apple-id 6799238379] \
#     [--display-name "Socratic-Trade"]
#     [--base-json path] [--out-json path] [--skip-push] [--skip-local-write]
#
# Writes:
#   <this-dir>/ios-app-versions.json  (local cache; may be stale)
#   https://github.com/jaywedgeworth22/ai-fleet-coordinator  (site/ios-versions.json)
#
# SAFETY: the vendored ios-app-versions.json in this repo is a stale snapshot
# (2026-08-21).  Starting from that file and PUTting it would drop net.dealdex
# 1.0.2 and roll Usage Client 1.0.11→1.0.8, Usage Local 1.0.9→1.0.7, and
# Autorotate 1.0.4→1.0.1.  Always seed from the live remote (or an explicit
# --base-json).  Refuse to push a single-app / empty-apps document over a
# multi-app remote.  Same class as DealDex #173.

set -euo pipefail

FLEET_DIR="$(cd "$(dirname "$0")" && pwd)"
LOCAL_JSON="${FLEET_DIR}/ios-app-versions.json"
REPO="jaywedgeworth22/ai-fleet-coordinator"
REMOTE_PATH="site/ios-versions.json"

BUNDLE_ID=""
VERSION=""
BUILD=""
APPLE_ID=""
DISPLAY_NAME=""
BASE_JSON=""
OUT_JSON=""
SKIP_PUSH=0
SKIP_LOCAL_WRITE=0

usage() {
  sed -n '1,28p' "$0"
  exit 2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --bundle-id) BUNDLE_ID="$2"; shift 2 ;;
    --version) VERSION="$2"; shift 2 ;;
    --build) BUILD="$2"; shift 2 ;;
    --apple-id) APPLE_ID="$2"; shift 2 ;;
    --display-name) DISPLAY_NAME="$2"; shift 2 ;;
    --base-json) BASE_JSON="$2"; shift 2 ;;
    --out-json) OUT_JSON="$2"; shift 2 ;;
    --skip-push) SKIP_PUSH=1; shift ;;
    --skip-local-write) SKIP_LOCAL_WRITE=1; shift ;;
    -h|--help) usage ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

[[ -n "$BUNDLE_ID" && -n "$VERSION" ]] || { echo "need --bundle-id and --version" >&2; exit 2; }

fetch_remote_json() {
  local dest="$1"
  if ! command -v gh >/dev/null 2>&1; then
    return 1
  fi
  local b64
  b64="$(gh api "repos/${REPO}/contents/${REMOTE_PATH}" --jq .content 2>/dev/null || true)"
  [[ -n "$b64" ]] || return 1
  python3 -c 'import base64,sys; sys.stdout.write(base64.b64decode("".join(sys.argv[1].split())).decode())' "$b64" >"$dest"
}

TMP_REMOTE=""
cleanup() {
  if [[ -n "${TMP_REMOTE}" && -f "${TMP_REMOTE}" ]]; then
    rm -f "${TMP_REMOTE}"
  fi
}
trap cleanup EXIT

if [[ -z "$BASE_JSON" ]]; then
  TMP_REMOTE="$(mktemp)"
  if fetch_remote_json "$TMP_REMOTE"; then
    BASE_JSON="$TMP_REMOTE"
  elif [[ -f "$LOCAL_JSON" ]]; then
    BASE_JSON="$LOCAL_JSON"
  else
    echo "error: no remote ${REPO}/${REMOTE_PATH} and no local ${LOCAL_JSON}" >&2
    echo "error: refusing to publish an empty apps map (would wipe the fleet manifest)" >&2
    exit 1
  fi
fi

if [[ ! -f "$BASE_JSON" ]]; then
  echo "error: base json not found: ${BASE_JSON}" >&2
  exit 1
fi

MERGED="$(python3 - "$BASE_JSON" "$BUNDLE_ID" "$VERSION" "$BUILD" "$APPLE_ID" "$DISPLAY_NAME" <<'PY'
import json, sys, datetime
path, bundle, version, build, apple_id, display = sys.argv[1:7]
with open(path, "r", encoding="utf-8") as fh:
    data = json.load(fh)
if not isinstance(data, dict):
    print("error: base json is not an object", file=sys.stderr)
    sys.exit(1)
apps = data.get("apps")
if not isinstance(apps, dict) or not apps:
    print("error: base json has no apps; refusing to publish a one-app replacement", file=sys.stderr)
    sys.exit(1)
before = set(apps)
entry = dict(apps.get(bundle) or {})
entry["marketingVersion"] = version
if build:
    entry["build"] = build
if apple_id:
    entry["appleId"] = int(apple_id)
if display:
    entry["displayName"] = display
apps[bundle] = entry
after = set(apps)
lost = sorted(before - after)
if lost:
    print("error: merge dropped apps: " + ", ".join(lost), file=sys.stderr)
    sys.exit(1)
data["apps"] = apps
data["schemaVersion"] = 1
data["updatedAt"] = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
json.dump(data, sys.stdout, indent=2)
sys.stdout.write("\n")
PY
)"

if [[ "$SKIP_LOCAL_WRITE" -eq 0 ]]; then
  printf '%s' "$MERGED" >"$LOCAL_JSON"
  echo "local-manifest-updated ${BUNDLE_ID} ${VERSION}"
fi
if [[ -n "$OUT_JSON" ]]; then
  printf '%s' "$MERGED" >"$OUT_JSON"
fi

if [[ "$SKIP_PUSH" -eq 1 ]]; then
  echo "skip-push ${BUNDLE_ID} ${VERSION} apps=$(python3 -c 'import json,sys; print(len(json.load(sys.stdin).get("apps") or {}))' <<<"$MERGED")"
  exit 0
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "gh not installed; local manifest only" >&2
  exit 0
fi

CONTENT_B64="$(printf '%s' "$MERGED" | python3 -c 'import base64,sys; print(base64.b64encode(sys.stdin.buffer.read()).decode())')"
SHA="$(gh api "repos/${REPO}/contents/${REMOTE_PATH}" --jq .sha 2>/dev/null || true)"

ARGS=(
  --method PUT
  "repos/${REPO}/contents/${REMOTE_PATH}"
  -f message="chore: ${BUNDLE_ID} ${VERSION}"
  -f content="${CONTENT_B64}"
)
if [[ -n "$SHA" ]]; then
  ARGS+=(-f sha="$SHA")
fi

if gh api "${ARGS[@]}" >/dev/null; then
  echo "remote-manifest-updated ${REPO}/${REMOTE_PATH}"
else
  echo "remote-manifest-publish-failed" >&2
  exit 1
fi
