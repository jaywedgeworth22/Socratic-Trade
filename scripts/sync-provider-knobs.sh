#!/usr/bin/env bash
# sync-provider-knobs.sh - make the API-Usage-Monitor app the source of truth for
# market-data subscription plans by syncing each plan's env-knob values into
# Infisical prod (where the trading app reads ALL provider quotas).
#
# PURE ASCII ONLY. This runs on the owner's Mac (bash 3.2.57), which mis-parses a
# non-ASCII byte placed directly next to a $VAR. Use '-', '->', '...'. Never add
# smart quotes / em dashes / arrows. Check: grep -nP '[^\x00-\x7F]' scripts/*.sh
#
# WHAT IT DOES
#   1. GET https://usage.jays.services/api/subscriptions  (Bearer USAGE_READ_TOKEN
#      from ~/.secrets/usage-monitor.env, falling back to USAGE_INGEST_TOKEN).
#      Prod UM denies ingest-token reads (Wave C). Bare JSON array; each element has
#      provider{id,name,displayName}, name, status, knobEnv (obj|null),
#      freeTierKnobEnv (obj|null).
#   2. Desired knobs per plan (scripts/provider-knob-diff.mjs, unit-tested):
#        active            -> knobEnv
#        canceled | paused -> freeTierKnobEnv
#        considering       -> skip     (not bought)
#        null map          -> skip
#      Guarded to an allow-list of provider keys + a safe value charset; anything
#      else the payload asks for is refused (defense vs a buggy/compromised monitor).
#   3. Read current values from Infisical prod (proven SSH + universal-auth CLI
#      path on the Coolify box) and WRITE ONLY DIFFS.
#   4. On any applied change, post ONE line to #agent-sync.
#
# Knob writes land in Infisical; the trading app reads them at boot, so a change
# takes effect on the next prod deploy/restart ("rides next deploy").
#
# USAGE
#   scripts/sync-provider-knobs.sh            # DRY RUN: print the diff, write nothing, exit 0
#   scripts/sync-provider-knobs.sh --apply    # write changed keys to Infisical + post to Slack
#
# SAFETY
#   - Monitor unreachable / empty payload -> exit 0, no writes, no Slack (launchd-safe).
#   - Dry run never writes and never posts to Slack.
#   - --apply refuses to write if it could not first read current Infisical state
#     (never writes blind).
#
# ENV OVERRIDES (defaults in [brackets])
#   USAGE_API            [https://usage.jays.services/api/subscriptions]
#   USAGE_MONITOR_ENV    [~/.secrets/usage-monitor.env]   USAGE_READ_TOKEN (preferred)
#                                                     or USAGE_INGEST_TOKEN (legacy)
#   KNOB_SYNC_SSH_KEY    [~/.ssh/hetzner]
#   KNOB_SYNC_SSH_HOST   [coolify]   (see private fleet-ops:ATTACK-MAP.md)
#   KNOB_SYNC_BOX_ENV    [/data/coolify/applications/${COOLIFY_APP_UUID:-socratic-trade}/.env]
#     Infisical ST machine identity lives in that host .env.
set -u

USAGE_API="${USAGE_API:-https://usage.jays.services/api/subscriptions}"
USAGE_MONITOR_ENV="${USAGE_MONITOR_ENV:-$HOME/.secrets/usage-monitor.env}"
SSH_KEY="${KNOB_SYNC_SSH_KEY:-$HOME/.ssh/hetzner}"
SSH_HOST="${KNOB_SYNC_SSH_HOST:-coolify}"
COOLIFY_APP_UUID="${COOLIFY_APP_UUID:-socratic-trade}"
BOX_ENV="${KNOB_SYNC_BOX_ENV:-/data/coolify/applications/${COOLIFY_APP_UUID}/.env}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HELPER="$SCRIPT_DIR/provider-knob-diff.mjs"
SLACK="$SCRIPT_DIR/slack-sync.sh"

APPLY=0
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    -h|--help) sed -n '2,45p' "$0"; exit 0 ;;
    *) echo "[knob-sync] unknown arg: $arg" >&2; exit 64 ;;
  esac
done

log()  { echo "[knob-sync] $*" >&2; }

command -v node >/dev/null 2>&1 || { log "node not found on PATH; cannot run the diff helper."; exit 0; }
[ -f "$HELPER" ] || { log "diff helper missing: $HELPER"; exit 0; }

WORK="$(mktemp -d 2>/dev/null || mktemp -d -t knobsync)"
cleanup() { [ -n "${WORK:-}" ] && rm -rf "$WORK"; }
trap cleanup EXIT INT TERM

# -- 1) read the usage-monitor token (never echoed) ----------------------------
# Prod GET /api/subscriptions wants USAGE_READ_TOKEN. Ingest is write-only
# there (Wave C) and 401s if used as a read bearer.
USAGE_TOKEN=""
_load_tok() {
  _name="$1"
  _line="$(grep -E "^(export )?${_name}=" "$USAGE_MONITOR_ENV" 2>/dev/null | tail -1 || true)"
  _val="${_line#*${_name}=}"
  case "$_val" in
    \"*\") _val="${_val#\"}"; _val="${_val%\"}" ;;
    \'*\') _val="${_val#\'}"; _val="${_val%\'}" ;;
  esac
  printf '%s' "$_val"
}
if [ -f "$USAGE_MONITOR_ENV" ]; then
  USAGE_TOKEN="$(_load_tok USAGE_READ_TOKEN)"
  if [ -z "$USAGE_TOKEN" ]; then
    USAGE_TOKEN="$(_load_tok USAGE_INGEST_TOKEN)"
  fi
fi
if [ -z "$USAGE_TOKEN" ]; then
  log "no USAGE_READ_TOKEN or USAGE_INGEST_TOKEN in $USAGE_MONITOR_ENV - cannot reach the monitor; nothing to do."
  exit 0
fi

# -- 2) fetch subscriptions (token via 0600 curl config, kept out of argv/ps) ---
umask 177
CURLCFG="$WORK/curl.cfg"
printf 'header = "Authorization: Bearer %s"\n' "$USAGE_TOKEN" > "$CURLCFG"
umask 022
USAGE_TOKEN=""  # dropped from the shell; it lives only in the 0600 config now

SUBS_JSON="$WORK/subs.json"
if ! curl -fsS --max-time 25 -K "$CURLCFG" "$USAGE_API" -o "$SUBS_JSON" 2>/dev/null; then
  log "monitor unreachable ($USAGE_API) - exit 0, no changes."
  exit 0
fi
if [ ! -s "$SUBS_JSON" ]; then
  log "monitor returned an empty body - exit 0, no changes."
  exit 0
fi

# -- 3) read current allowed knob values from Infisical prod (via the box) ------
# The remote reads the Infisical universal-auth creds from the Coolify app .env,
# mints a short-lived token, exports prod secrets, and returns ONLY the allowed
# knob keys (the grep mirrors ALLOWED_KEY_RE in provider-knob-diff.mjs so no
# unrelated secret ever leaves the box). Creds never leave the box; they are
# never printed.
CURRENT_ENV="$WORK/current.env"
READ_OK=0
if ssh -i "$SSH_KEY" -o BatchMode=yes -o ConnectTimeout=15 -o StrictHostKeyChecking=accept-new \
     "$SSH_HOST" "BOX_ENV='$BOX_ENV' bash -s" > "$CURRENT_ENV" 2>"$WORK/read.err" <<'REMOTE_READ'
set -u
ENVF="${BOX_ENV:?}"
[ -f "$ENVF" ] || { echo "box env file not found: $ENVF" >&2; exit 11; }
get_env() { grep -E "^(export )?$1=" "$ENVF" 2>/dev/null | tail -1 | sed -E "s/^(export )?$1=//; s/^\"(.*)\"$/\1/; s/^'(.*)'$/\1/"; }
CID="$(get_env INFISICAL_CLIENT_ID)"
CSECRET="$(get_env INFISICAL_CLIENT_SECRET)"
PID="$(get_env INFISICAL_PROJECT_ID)"
ENVN="$(get_env INFISICAL_ENV)"; ENVN="${ENVN:-prod}"
SPATH="$(get_env INFISICAL_PATH)"; SPATH="${SPATH:-/}"
[ -n "$CID" ] && [ -n "$CSECRET" ] && [ -n "$PID" ] || { echo "missing Infisical creds in $ENVF" >&2; exit 12; }
BIN="$(command -v infisical || true)"
if [ -z "$BIN" ]; then
  for c in /usr/local/bin/infisical /usr/bin/infisical /root/.local/bin/infisical /app/data/.bin/infisical /data/.bin/infisical; do
    [ -x "$c" ] && BIN="$c" && break
  done
fi
[ -n "$BIN" ] || { echo "infisical CLI not found on the box" >&2; exit 13; }
export INFISICAL_DISABLE_UPDATE_CHECK=true
TOKEN="$(env -u INFISICAL_TOKEN INFISICAL_UNIVERSAL_AUTH_CLIENT_ID="$CID" INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET="$CSECRET" "$BIN" login --method=universal-auth --plain --silent 2>/dev/null)"
[ -n "$TOKEN" ] || { echo "infisical universal-auth login failed" >&2; exit 14; }
INFISICAL_TOKEN="$TOKEN" "$BIN" export --projectId "$PID" --env "$ENVN" --path "$SPATH" --format dotenv 2>/dev/null \
  | grep -E '^(export )?(PROVIDER_QUOTA_|PROVIDER_RATE_LIMIT_|MASSIVE_|TIINGO_DROP_NEWS=|FINNHUB_DROP_RECOMMENDATION=|ALPACA_DATA_FEED=)' \
  || true
REMOTE_READ
then
  READ_OK=1
else
  log "could not read current Infisical state from the box: $(tr '\n' ' ' < "$WORK/read.err" 2>/dev/null)"
fi

# -- 4) compute the plan (pure helper; current may be empty if the read failed) -
PLAN="$WORK/plan.tsv"
if ! node "$HELPER" --plan "$CURRENT_ENV" < "$SUBS_JSON" > "$PLAN" 2>"$WORK/plan.err"; then
  log "diff helper failed: $(tr '\n' ' ' < "$WORK/plan.err" 2>/dev/null)"
  # A malformed monitor payload is a monitor problem -> stay quiet, exit 0.
  exit 0
fi

# Surface non-change diagnostics (rejects/conflicts/skips/summary) to stderr.
grep -E '^(REJECT|CONFLICT|SKIP|SUMMARY)' "$PLAN" 2>/dev/null | while IFS= read -r rec; do
  log "$rec"
done

CHANGES="$(grep -c '^CHANGE' "$PLAN" 2>/dev/null || echo 0)"
CHANGES="$(printf '%s' "$CHANGES" | tr -dc '0-9')"; CHANGES="${CHANGES:-0}"
if [ "$CHANGES" -eq 0 ]; then
  log "in sync - no knob changes to apply."
  exit 0
fi

# -- 5) act on the changes -----------------------------------------------------
if [ "$APPLY" -eq 0 ]; then
  echo "[knob-sync] DRY RUN - $CHANGES change(s) would be written to Infisical prod (env prod, path /):"
  # print each change as: KEY: old -> new (plan <name> <status>)
  grep '^CHANGE' "$PLAN" | while IFS= read -r rec; do
    k="$(printf '%s' "$rec" | cut -f2)"
    old="$(printf '%s' "$rec" | cut -f3)"
    new="$(printf '%s' "$rec" | cut -f4)"
    plan="$(printf '%s' "$rec" | cut -f5)"
    st="$(printf '%s' "$rec" | cut -f6)"
    echo "  $k: $old -> $new (plan $plan $st)"
  done
  echo "[knob-sync] re-run with --apply to write these and post to #agent-sync."
  exit 0
fi

# --apply: never write blind.
if [ "$READ_OK" -eq 0 ]; then
  log "--apply refused: could not read current Infisical state (would be writing blind). Fix the box read and re-run."
  exit 1
fi

# Build the KEY=VALUE args from CHANGE records (values are guard-validated: safe
# charset, no spaces/quotes/metacharacters, so they pass as plain ssh words).
APPLY_ARGS=()
while IFS= read -r rec; do
  k="$(printf '%s' "$rec" | cut -f2)"
  new="$(printf '%s' "$rec" | cut -f4)"
  APPLY_ARGS[${#APPLY_ARGS[@]}]="$k=$new"
done < <(grep '^CHANGE' "$PLAN")

log "applying $CHANGES change(s) to Infisical prod ..."
APPLY_OUT="$WORK/apply.out"
if ! ssh -i "$SSH_KEY" -o BatchMode=yes -o ConnectTimeout=15 -o StrictHostKeyChecking=accept-new \
     "$SSH_HOST" "BOX_ENV='$BOX_ENV' bash -s" "${APPLY_ARGS[@]}" > "$APPLY_OUT" 2>"$WORK/apply.err" <<'REMOTE_APPLY'
set -u
ENVF="${BOX_ENV:?}"
[ -f "$ENVF" ] || { echo "box env file not found: $ENVF" >&2; exit 11; }
get_env() { grep -E "^(export )?$1=" "$ENVF" 2>/dev/null | tail -1 | sed -E "s/^(export )?$1=//; s/^\"(.*)\"$/\1/; s/^'(.*)'$/\1/"; }
CID="$(get_env INFISICAL_CLIENT_ID)"
CSECRET="$(get_env INFISICAL_CLIENT_SECRET)"
PID="$(get_env INFISICAL_PROJECT_ID)"
ENVN="$(get_env INFISICAL_ENV)"; ENVN="${ENVN:-prod}"
SPATH="$(get_env INFISICAL_PATH)"; SPATH="${SPATH:-/}"
[ -n "$CID" ] && [ -n "$CSECRET" ] && [ -n "$PID" ] || { echo "missing Infisical creds in $ENVF" >&2; exit 12; }
BIN="$(command -v infisical || true)"
if [ -z "$BIN" ]; then
  for c in /usr/local/bin/infisical /usr/bin/infisical /root/.local/bin/infisical /app/data/.bin/infisical /data/.bin/infisical; do
    [ -x "$c" ] && BIN="$c" && break
  done
fi
[ -n "$BIN" ] || { echo "infisical CLI not found on the box" >&2; exit 13; }
export INFISICAL_DISABLE_UPDATE_CHECK=true
TOKEN="$(env -u INFISICAL_TOKEN INFISICAL_UNIVERSAL_AUTH_CLIENT_ID="$CID" INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET="$CSECRET" "$BIN" login --method=universal-auth --plain --silent 2>/dev/null)"
[ -n "$TOKEN" ] || { echo "infisical universal-auth login failed" >&2; exit 14; }
# Re-apply the key allow-list ON THE BOX (defense in depth) before every write.
ALLOW='^(PROVIDER_QUOTA_|PROVIDER_RATE_LIMIT_|MASSIVE_|TIINGO_DROP_NEWS=|FINNHUB_DROP_RECOMMENDATION=|ALPACA_DATA_FEED=)'
for kv in "$@"; do
  key="${kv%%=*}"
  if ! printf '%s' "$kv" | grep -Eq "$ALLOW"; then
    printf 'FAIL\t%s\t%s\n' "$key" "refused by box allow-list" ; continue
  fi
  if INFISICAL_TOKEN="$TOKEN" "$BIN" secrets set "$kv" --projectId "$PID" --env "$ENVN" --path "$SPATH" >/dev/null 2>&1; then
    printf 'OK\t%s\n' "$key"
  else
    printf 'FAIL\t%s\t%s\n' "$key" "infisical secrets set failed"
  fi
done
REMOTE_APPLY
then
  :
else
  log "apply session error: $(tr '\n' ' ' < "$WORK/apply.err" 2>/dev/null)"
fi

# -- 6) report + Slack one line per applied change -----------------------------
FAILN=0
while IFS= read -r out; do
  [ -z "$out" ] && continue
  tag="$(printf '%s' "$out" | cut -f1)"
  key="$(printf '%s' "$out" | cut -f2)"
  if [ "$tag" = "OK" ]; then
    # look up the full change record for this key to build the Slack line
    rec="$(awk -F'\t' -v k="$key" '$1=="CHANGE" && $2==k {print; exit}' "$PLAN")"
    old="$(printf '%s' "$rec" | cut -f3)"
    new="$(printf '%s' "$rec" | cut -f4)"
    plan="$(printf '%s' "$rec" | cut -f5)"
    st="$(printf '%s' "$rec" | cut -f6)"
    log "wrote $key: $old -> $new"
    MSG="repo: Socratic-Trade | [CLAUDE->FLEET] knob-sync applied: $key $old->$new (plan $plan $st); rides next deploy"
    if [ -x "$SLACK" ]; then
      "$SLACK" post "$MSG" >/dev/null 2>&1 || log "slack post failed for $key (write still succeeded)"
    fi
  else
    msg="$(printf '%s' "$out" | cut -f3)"
    log "FAILED $key: $msg"
    FAILN=$((FAILN + 1))
  fi
done < "$APPLY_OUT"

if [ "$FAILN" -gt 0 ]; then
  log "$FAILN change(s) failed to write - see above. Will retry on the next run."
  exit 1
fi
log "done."
exit 0
