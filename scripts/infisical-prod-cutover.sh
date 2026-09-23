#!/usr/bin/env bash
# One-time production cutover to Infisical - RUN THIS ON THE PRODUCTION BOX.
#
# This performs the host-side steps an agent cannot do remotely (it needs your
# Infisical machine-identity credentials and reads your live secret values, which
# never leave the box). It is idempotent and safe to re-run.
#
# AUTH - give it the machine identity's **Client ID + Client Secret** (universal
# auth, long-lived). The Client Secret is NOT an access token: the script/runner
# exchange the Client ID + Secret for a short-lived token automatically, so nothing
# expires in deploy.env. A pre-minted INFISICAL_TOKEN (a temporary JWT) is still
# accepted but NOT recommended (it expires - see the identity's Access Token TTL).
# Per project:
#   App (Socratic-Trade / slug socratic-trade): INFISICAL_CLIENT_ID + INFISICAL_CLIENT_SECRET
#                                               (or INFISICAL_TOKEN)
#   Shared (shared-at-ct): INFISICAL_SHARED_CLIENT_ID + INFISICAL_SHARED_CLIENT_SECRET
#                          (or INFISICAL_SHARED_TOKEN) - OPTIONAL; omit to use one project.
# The app project's values WIN over shared on any overlapping key.
#
# It does:
#   2) writes the bootstrap to ~/.config/agentic-trading/deploy.env (chmod 600) so
#      both deploy.yml and the PM2 process can reach Infisical, and imports the
#      current .env.local secrets into the Infisical prod env (bootstrap excluded).
#   3) re-creates the PM2 `trading` process to launch via `npm run start:secrets`,
#      verifies it boots (with REQUIRE_SECRETS_MANAGER=1 a plain start would refuse),
#      and - only with --scrub - backs up and trims .env.local to just the bootstrap.
#
# Usage:
#   INFISICAL_CLIENT_ID=... INFISICAL_CLIENT_SECRET=... \
#     bash scripts/infisical-prod-cutover.sh [--scrub] [--no-restart] [--dir DIR] [--app NAME]
#   ...or run with no creds set and it prompts (Client Secret hidden).
#
# NOTE: a bare `VAR=value` on its OWN line is NOT exported to this script; put it on
# the SAME line as the command, `export` it first, or just let the prompt ask.
set -euo pipefail

DIR="${DEPLOY_DIR:-$HOME/apps/trading-live}"
APP="${PM2_APP:-trading}"
ENV_DIR="$HOME/.config/agentic-trading"
ENV_FILE="$ENV_DIR/deploy.env"
PROJECT_ID="${INFISICAL_PROJECT_ID:-39d93bb7-76f9-498c-8b50-a7def52e072f}" # Socratic-Trade (slug: socratic-trade)
ENV_NAME="${INFISICAL_ENV:-prod}"
SECRETS_PATH="${INFISICAL_PATH:-/}"
SHARED_PROJECT_ID="${INFISICAL_SHARED_PROJECT_ID:-18f563a3-9c88-454c-96eb-28fc9678f3ba}" # shared-at-ct
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:4000/api/health}"
DO_SCRUB=0
DO_RESTART=1

# Credentials (Client ID/Secret preferred; access-token fallback). Defaulted empty
# so `set -u` never trips when they're unset.
APP_CLIENT_ID="${INFISICAL_CLIENT_ID:-}"
APP_CLIENT_SECRET="${INFISICAL_CLIENT_SECRET:-}"
APP_TOKEN="${INFISICAL_TOKEN:-}"
SHARED_CLIENT_ID="${INFISICAL_SHARED_CLIENT_ID:-}"
SHARED_CLIENT_SECRET="${INFISICAL_SHARED_CLIENT_SECRET:-}"
SHARED_TOKEN="${INFISICAL_SHARED_TOKEN:-}"

while [ $# -gt 0 ]; do
  case "$1" in
    --scrub) DO_SCRUB=1 ;;
    --no-restart) DO_RESTART=0 ;;
    --dir) DIR="$2"; shift ;;
    --app) APP="$2"; shift ;;
    -h|--help) sed -n '2,33p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done

log()  { printf '\n[cutover] %s\n' "$*"; }
die()  { printf '\n[cutover] ERROR: %s\n' "$*" >&2; exit 1; }

# A 64-char hex string is a machine-identity Client Secret, NOT an access token.
# Catching this turns the cryptic "malformed token" 403 into a clear message.
looks_like_client_secret() { case "$1" in *[!0-9a-fA-F]*) return 1 ;; esac; [ "${#1}" -eq 64 ]; }

# Read a single var's value out of a prior deploy.env (set -u-safe; never errors).
read_envfile_var() {
  [ -f "$ENV_FILE" ] || return 0
  ( set +u +e; . "$ENV_FILE" >/dev/null 2>&1; eval "printf '%s' \"\${$1-}\"" )
}

# Run `infisical` authenticated by ONLY the given short-lived token, with the long-lived
# client secrets / shared creds stripped from the child env (they aren't needed once a
# token is minted) - mirrors the runner's childEnv scoping so the verify/import children
# never inherit an exported Client Secret.
infisical_tok() {  # $1=access token; remaining args -> infisical
  local _tok="$1"; shift
  env -u INFISICAL_CLIENT_ID -u INFISICAL_CLIENT_SECRET \
      -u INFISICAL_SHARED_CLIENT_ID -u INFISICAL_SHARED_CLIENT_SECRET -u INFISICAL_SHARED_TOKEN \
      -u INFISICAL_UNIVERSAL_AUTH_CLIENT_ID -u INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET \
      INFISICAL_TOKEN="$_tok" infisical "$@"
}

# -- Preconditions -------------------------------------------------------------
command -v infisical >/dev/null 2>&1 || die "Infisical CLI not found. Install it: brew install infisical/get-cli/infisical (or npm i -g @infisical/cli)"
command -v pm2 >/dev/null 2>&1 || die "pm2 not found on PATH."
[ -d "$DIR" ] || die "Deploy dir not found: $DIR (pass --dir)."

# -- Credential resolution: env -> prior deploy.env -> interactive prompt --------
[ -n "$APP_CLIENT_ID" ]        || APP_CLIENT_ID="$(read_envfile_var INFISICAL_CLIENT_ID)"
[ -n "$APP_CLIENT_SECRET" ]    || APP_CLIENT_SECRET="$(read_envfile_var INFISICAL_CLIENT_SECRET)"
[ -n "$APP_TOKEN" ]            || APP_TOKEN="$(read_envfile_var INFISICAL_TOKEN)"
[ -n "$SHARED_CLIENT_ID" ]     || SHARED_CLIENT_ID="$(read_envfile_var INFISICAL_SHARED_CLIENT_ID)"
[ -n "$SHARED_CLIENT_SECRET" ] || SHARED_CLIENT_SECRET="$(read_envfile_var INFISICAL_SHARED_CLIENT_SECRET)"
[ -n "$SHARED_TOKEN" ]         || SHARED_TOKEN="$(read_envfile_var INFISICAL_SHARED_TOKEN)"

# App identity prompts (Client ID visible, Client Secret hidden) when nothing supplied.
if [ -z "$APP_CLIENT_ID" ] && [ -z "$APP_TOKEN" ] && [ -t 0 ]; then
  printf '[cutover] App (Socratic-Trade / socratic-trade) machine-identity Client ID: ' >&2
  IFS= read -r APP_CLIENT_ID || true
fi
if [ -n "$APP_CLIENT_ID" ] && [ -z "$APP_CLIENT_SECRET" ] && [ -t 0 ]; then
  printf '[cutover] App Client Secret (input hidden): ' >&2
  IFS= read -rs APP_CLIENT_SECRET || true; printf '\n' >&2
fi

# Validate app credentials + catch the Client-Secret-as-token mistake.
# Partial app identity (one half of the pair without the other) fails closed even when a
# stale INFISICAL_TOKEN is present, so we never persist an expiring token when the operator
# attempted the non-expiring Client ID/Secret pair (mirrors the runner/shared checks).
if { [ -n "$APP_CLIENT_ID" ] && [ -z "$APP_CLIENT_SECRET" ]; } \
   || { [ -z "$APP_CLIENT_ID" ] && [ -n "$APP_CLIENT_SECRET" ]; }; then
  die "Partial app identity: set BOTH INFISICAL_CLIENT_ID and INFISICAL_CLIENT_SECRET (or neither, to use a pre-minted INFISICAL_TOKEN)."
fi
if [ -z "$APP_CLIENT_ID" ] && [ -z "$APP_TOKEN" ]; then
  die "No app credentials. Provide INFISICAL_CLIENT_ID + INFISICAL_CLIENT_SECRET (preferred) or a pre-minted INFISICAL_TOKEN. A bare 'VAR=value' on its own line is not inherited - pass it inline on the command, 'export' it, or run interactively to be prompted."
fi
if [ -z "$APP_CLIENT_ID" ] && looks_like_client_secret "$APP_TOKEN"; then
  die "INFISICAL_TOKEN looks like a 64-char Client SECRET, not an access token - that is the 'malformed token' 403. Provide INFISICAL_CLIENT_ID + INFISICAL_CLIENT_SECRET instead; the script exchanges them for a token automatically."
fi

export INFISICAL_DISABLE_UPDATE_CHECK=true

# All creds are now copied into the script's own APP_*/SHARED_* vars, so drop the
# operator-supplied credential ENV vars from this shell. Subsequent children (the mint
# login, verify/import, the health-check loop, and --scrub) then never inherit a long-lived
# secret; the PM2 start re-sources what it needs from deploy.env in its own subshell.
unset INFISICAL_CLIENT_ID INFISICAL_CLIENT_SECRET INFISICAL_TOKEN \
      INFISICAL_SHARED_CLIENT_ID INFISICAL_SHARED_CLIENT_SECRET INFISICAL_SHARED_TOKEN \
      INFISICAL_UNIVERSAL_AUTH_CLIENT_ID INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET || true

# Exchange a machine-identity Client ID + Client Secret for a short-lived access
# token (universal auth). `--plain --silent` prints just the raw token, which the
# CLI's secrets/export read via INFISICAL_TOKEN.
mint_token() {  # $1=client_id $2=client_secret $3=label -> prints the access token
  # Strip ALL Infisical credential vars from the login child and pass ONLY this identity's
  # pair via universal-auth env vars (not argv), so the app mint never sees the shared
  # Client Secret (and vice versa) and the secret never appears in `ps`.
  local tok
  tok="$(env -u INFISICAL_CLIENT_ID -u INFISICAL_CLIENT_SECRET -u INFISICAL_TOKEN \
             -u INFISICAL_SHARED_CLIENT_ID -u INFISICAL_SHARED_CLIENT_SECRET -u INFISICAL_SHARED_TOKEN \
             INFISICAL_UNIVERSAL_AUTH_CLIENT_ID="$1" INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET="$2" \
             infisical login --method=universal-auth --silent --plain 2>/dev/null)" \
    || die "universal-auth login failed for the $3 identity. Check the Client ID + Client Secret pairing/access (each secret only works with its OWN identity's Client ID; watch for rotation/lockout)."
  [ -n "$tok" ] || die "universal-auth login for the $3 identity returned an empty token."
  printf '%s' "$tok"
}

# Resolve the app access token: mint from client creds, else use a supplied token.
if [ -n "$APP_CLIENT_ID" ] && [ -n "$APP_CLIENT_SECRET" ]; then
  log "Authenticating app identity (universal auth)..."
  APP_TOKEN="$(mint_token "$APP_CLIENT_ID" "$APP_CLIENT_SECRET" app)"
fi
infisical_app() { infisical_tok "$APP_TOKEN" "$@"; }

# Partial shared identity (only one half of the pair) is a HARD ERROR - fail closed,
# mirroring the app path, rather than silently restarting prod without shared secrets.
if { [ -n "$SHARED_CLIENT_ID" ] && [ -z "$SHARED_CLIENT_SECRET" ]; } \
   || { [ -z "$SHARED_CLIENT_ID" ] && [ -n "$SHARED_CLIENT_SECRET" ]; }; then
  die "Partial shared identity: set BOTH INFISICAL_SHARED_CLIENT_ID and INFISICAL_SHARED_CLIENT_SECRET (or neither, to skip the shared overlay)."
fi

# Decide whether the shared overlay is requested. An explicitly-set-but-malformed
# shared token is a HARD ERROR (fail closed) - never silently restart prod app-only
# when the operator asked for the shared App-A/B secrets.
SHARED_ENABLED=0
if [ -n "$SHARED_CLIENT_ID" ] && [ -n "$SHARED_CLIENT_SECRET" ]; then
  SHARED_ENABLED=1
elif [ -n "$SHARED_TOKEN" ]; then
  if looks_like_client_secret "$SHARED_TOKEN"; then
    die "INFISICAL_SHARED_TOKEN looks like a 64-char Client SECRET, not an access token. Provide INFISICAL_SHARED_CLIENT_ID + INFISICAL_SHARED_CLIENT_SECRET to enable the shared overlay, or unset INFISICAL_SHARED_TOKEN to intentionally skip it."
  fi
  SHARED_ENABLED=1
fi

# Resolve the shared access token: mint from client creds, else use the supplied token.
if [ "$SHARED_ENABLED" -eq 1 ] && [ -n "$SHARED_CLIENT_ID" ] && [ -n "$SHARED_CLIENT_SECRET" ]; then
  log "Authenticating shared identity (universal auth)..."
  SHARED_TOKEN="$(mint_token "$SHARED_CLIENT_ID" "$SHARED_CLIENT_SECRET" shared)"
fi
infisical_shared() { infisical_tok "$SHARED_TOKEN" "$@"; }

# -- Verify access before changing anything ------------------------------------
log "Verifying Infisical access (project $PROJECT_ID, env $ENV_NAME)..."
infisical_app secrets --projectId "$PROJECT_ID" --env "$ENV_NAME" --path "$SECRETS_PATH" >/dev/null \
  || die "Infisical could not read $PROJECT_ID/$ENV_NAME. Check that the Client ID + Client Secret are paired correctly (each secret only works with its OWN identity's Client ID), that the secret isn't rotated or locked out, and that the identity has access to the project."
log "Infisical access OK."

if [ "$SHARED_ENABLED" -eq 1 ]; then
  log "Verifying access to shared project $SHARED_PROJECT_ID..."
  infisical_shared secrets --projectId "$SHARED_PROJECT_ID" --env "$ENV_NAME" --path "$SECRETS_PATH" >/dev/null \
    || die "Shared project $SHARED_PROJECT_ID not readable. Check the shared Client ID + Secret pairing/access. (The app cutover does NOT need this - omit the shared vars to skip the overlay.)"
  log "Shared project access OK."
fi

# -- (2) Persist the bootstrap (chmod 600; never committed) --------------------
log "Writing bootstrap to $ENV_FILE"
mkdir -p "$ENV_DIR"; chmod 700 "$ENV_DIR"
umask 177
{
  printf '%s\n' "# Infisical bootstrap for the Socratic-Trade production box. Machine-managed by"
  printf '%s\n' "# scripts/infisical-prod-cutover.sh. chmod 600. NEVER commit this file."
  if [ -n "$APP_CLIENT_ID" ] && [ -n "$APP_CLIENT_SECRET" ]; then
    printf "export INFISICAL_CLIENT_ID='%s'\n" "$APP_CLIENT_ID"
    printf "export INFISICAL_CLIENT_SECRET='%s'\n" "$APP_CLIENT_SECRET"
  else
    printf '%s\n' "# NOTE: a raw INFISICAL_TOKEN expires (see the identity's Access Token TTL). Prefer"
    printf '%s\n' "# INFISICAL_CLIENT_ID + INFISICAL_CLIENT_SECRET so the runner mints fresh tokens."
    printf "export INFISICAL_TOKEN='%s'\n" "$APP_TOKEN"
  fi
  printf "export INFISICAL_PROJECT_ID='%s'\n" "$PROJECT_ID"
  printf "export INFISICAL_ENV='%s'\n" "$ENV_NAME"
  printf "export INFISICAL_PATH='%s'\n" "$SECRETS_PATH"
  printf '%s\n' "export REQUIRE_SECRETS_MANAGER=1"
  if [ "$SHARED_ENABLED" -eq 1 ]; then
    printf "export INFISICAL_SHARED_PROJECT_ID='%s'\n" "$SHARED_PROJECT_ID"
    if [ -n "$SHARED_CLIENT_ID" ] && [ -n "$SHARED_CLIENT_SECRET" ]; then
      printf "export INFISICAL_SHARED_CLIENT_ID='%s'\n" "$SHARED_CLIENT_ID"
      printf "export INFISICAL_SHARED_CLIENT_SECRET='%s'\n" "$SHARED_CLIENT_SECRET"
    else
      printf "export INFISICAL_SHARED_TOKEN='%s'\n" "$SHARED_TOKEN"
    fi
  fi
} > "$ENV_FILE"
umask 022
chmod 600 "$ENV_FILE"
[ "$SHARED_ENABLED" -eq 1 ] && log "Enabled app+shared overlay (shared project $SHARED_PROJECT_ID; app wins overlaps)."

# -- (2) Import the box's current .env.local into Infisical (values stay local) -
ENV_LOCAL="$DIR/.env.local"
if [ -f "$ENV_LOCAL" ]; then
  log "Importing secrets from $ENV_LOCAL into Infisical $ENV_NAME (bootstrap vars excluded)..."
  imported=0
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|\#*) continue ;; esac
    key="${line%%=*}"
    [ "$key" = "$line" ] && continue                 # no '=' -> skip
    case "$key" in
      INFISICAL_*|REQUIRE_SECRETS_MANAGER|SECRETS_SOURCE) continue ;;  # bootstrap, not app secrets
    esac
    # `infisical secrets set KEY=VALUE` upserts; values never printed here.
    if infisical_app secrets set "$line" --projectId "$PROJECT_ID" --env "$ENV_NAME" --path "$SECRETS_PATH" >/dev/null; then
      printf '  + %s\n' "$key"; imported=$((imported+1))
    else
      printf '  ! failed to set %s\n' "$key" >&2
    fi
  done < "$ENV_LOCAL"
  log "Imported $imported secret(s)."
else
  log "No $ENV_LOCAL found - skipping import (assuming secrets are already in Infisical)."
fi

# -- (3) Switch the PM2 process to launch via Infisical ------------------------
if [ "$DO_RESTART" -eq 1 ]; then
  log "Switching PM2 '$APP' to 'npm run start:secrets'..."
  # Source the bootstrap ONLY inside this subshell - pm2 --update-env captures it for the
  # managed process, but it never lands in the parent shell (so the health-check/scrub
  # commands below don't inherit the long-lived Client Secret).
  ( cd "$DIR"
    # shellcheck disable=SC1090
    set -a; . "$ENV_FILE"; set +a
    pm2 delete "$APP" >/dev/null 2>&1 || true
    pm2 start npm --name "$APP" --update-env --cwd "$DIR" -- run start:secrets
    pm2 save )

  log "Verifying the app booted (REQUIRE_SECRETS_MANAGER=1 makes a non-manager start refuse)..."
  ok=0
  for _ in $(seq 1 30); do
    if curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then ok=1; break; fi
    sleep 2
  done
  if [ "$ok" -eq 1 ]; then
    log "Health check OK ($HEALTH_URL). The app is now sourcing secrets from Infisical."
  else
    echo "[cutover] WARNING: $HEALTH_URL did not respond in time. Check 'pm2 logs $APP' -" >&2
    echo "          a guard failure prints '[secrets] REQUIRE_SECRETS_MANAGER ...'." >&2
    echo "          NOT scrubbing .env.local. Re-run after fixing." >&2
    exit 1
  fi
else
  log "--no-restart: left PM2 untouched. deploy.yml will switch it on the next deploy (deploy.env present)."
fi

# -- (3 tail) Scrub .env.local - opt-in, with a backup -------------------------
if [ "$DO_SCRUB" -eq 1 ] && [ -f "$ENV_LOCAL" ]; then
  ts="$(date +%Y%m%d-%H%M%S)"
  cp "$ENV_LOCAL" "$ENV_LOCAL.bak.$ts"
  : > "$ENV_LOCAL"
  log "Scrubbed $ENV_LOCAL (backup: $ENV_LOCAL.bak.$ts). Secrets now come only from Infisical."
elif [ -f "$ENV_LOCAL" ]; then
  log "Done. Verify, then scrub the now-redundant local secrets:  bash scripts/infisical-prod-cutover.sh --scrub --no-restart"
fi

log "Cutover complete."
