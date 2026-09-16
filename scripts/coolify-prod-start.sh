#!/usr/bin/env bash
# Boot script for the PRODUCTION app on the Coolify box (socratictrade.com).
# Coolify start_command runs this script directly; it self-wraps in
# scripts/infisical-run.mjs, so by phase 2 the full Infisical `prod` env
# (app secrets + AWS_*) is present.
#
# Phase 1 (no secrets yet): download pinned litestream + infisical CLI binaries
#   onto the persistent volume (cached across restarts), put them on PATH, then
#   re-exec this script under infisical-run.
# Phase 2 (secrets injected), gated by the DB_BOOTSTRAP runtime env var:
#   fresh (default) - start the app with whatever is in /app/data (empty on the
#                     first boot). An empty DB has no users and no broker
#                     accounts, so the scheduler cannot place orders. Safe to
#                     run while the Mac production process is still live.
#   live            - one-time restore of the production DB from the litestream
#                     R2 replica (guarded by a marker file on the volume), then
#                     run under `litestream replicate -exec` so PITR backup
#                     continuity is preserved. Flip to live ONLY after the Mac
#                     pm2 `trading` + `litestream` processes are stopped --
#                     otherwise two schedulers trade the same broker accounts.
#
# Requires NIXPACKS_PKGS="gnutar gzip" on the Coolify app (tar for the release
# tarballs; node/bash/coreutils are already in the nixpacks image).
set -euo pipefail

# Pinned BACK from 0.5.14 (2026-07-10): 0.5.14 in this container churned ~20
# sockets/s to the R2 endpoint and held thousands of dead TCP socks (peak 16.8k
# fds on one PID, ~715MB of pinned receive buffers), driving the kernel to
# tcp_mem exhaustion -- every connection's receive window clamped to ~6KB, git
# clones from GitHub trickled at ~20KB/s and died mid-transfer ("TLS unexpected
# eof"), wedging ALL Coolify deploys on the box. All 0.5.x releases read/write
# the same LTX replica format, so moving within 0.5.x is replica-compatible
# (the 0.5.14 restore at cutover read history written by earlier 0.5.x).
# Re-upgrade only after upstream fixes the socket churn.
# Full diagnosis: docs/rollouts/2026-07-10-deploy-blocker-tcpmem-litestream.md
LITESTREAM_VERSION="0.5.12"
INFISICAL_CLI_VERSION="0.43.98"  # matches the version production ran on the Mac

DATA_DIR="/app/data"
BIN_DIR="$DATA_DIR/.bin"
DB_PATH="$DATA_DIR/app.db"
MARKER="$DATA_DIR/.restored-from-replica"
CONFIG="/app/litestream.coolify.yml"
# Combined stdout+stderr of the `litestream replicate` process, teed to the persistent volume so
# the app (src/lib/runtime-health.ts's scanLitestreamRuntimeLogFile) can read litestream's own
# "compaction failed" / "validation error detected" lines. litestream owns the container's real
# stdout here (it wraps the app via `-exec`, not the other way around), so this file is the only
# channel the app has into that stream at all -- see the run_app call at the bottom of this script.
LITESTREAM_LOG_FILE="$DATA_DIR/litestream-runtime.log"

log() { echo "[coolify-prod-start] $*"; }

# Download $1 to $2 (node is guaranteed in the image; curl is not).
fetch() {
  node -e '
    const fs = require("node:fs");
    const [url, dest] = process.argv.slice(1);
    fetch(url, { redirect: "follow" })
      .then((r) => { if (!r.ok) throw new Error(url + " -> HTTP " + r.status); return r.arrayBuffer(); })
      .then((b) => fs.writeFileSync(dest, Buffer.from(b)))
      .catch((e) => { console.error("[coolify-prod-start] download failed:", e.message); process.exit(1); });
  ' "$1" "$2"
}

# Download a release tarball and install a single named binary into BIN_DIR.
install_from_tarball() {
  url="$1"; binary="$2"
  tmp="$(mktemp -d)"
  fetch "$url" "$tmp/pkg.tar.gz"
  tar -xzf "$tmp/pkg.tar.gz" -C "$tmp"
  # NOT `find ... | head -1`: this script runs under `set -euo pipefail`, so head
  # closing the pipe early makes find take SIGPIPE, the pipeline report 141, and the
  # BOOT abort -- a race on tarball size, not a deterministic failure. Same class as
  # FLEET-INFRA-BH in CI. Take the first line with parameter expansion instead; no
  # pipe, and no dependency on `find -quit` being present in the base image.
  found="$(find "$tmp" -type f -name "$binary")"
  found="${found%%$'\n'*}"
  if [ -z "$found" ]; then
    log "ERROR: $binary not found in $url"
    exit 1
  fi
  mv "$found" "$BIN_DIR/$binary"
  chmod +x "$BIN_DIR/$binary"
  rm -rf "$tmp"
}

if [ -z "${COOLIFY_PROD_PHASE2:-}" ]; then
  mkdir -p "$BIN_DIR"
  ARCH="$(uname -m)"
  case "$ARCH" in
    aarch64|arm64)
      LITESTREAM_ARCH="arm64"
      INFISICAL_ARCH="arm64"
      ;;
    *)
      LITESTREAM_ARCH="x86_64"
      INFISICAL_ARCH="amd64"
      ;;
  esac
  # Version-aware install: BIN_DIR lives on the persistent volume, so a plain
  # existence check would keep serving a stale cached binary forever after a
  # version change ("litestream version" prints the bare number, e.g. 0.5.12).
  installed_litestream="$("$BIN_DIR/litestream" version 2>/dev/null || true)"
  if [ "$installed_litestream" != "$LITESTREAM_VERSION" ]; then
    log "installing litestream $LITESTREAM_VERSION ($LITESTREAM_ARCH) (cached: ${installed_litestream:-none})"
    install_from_tarball \
      "https://github.com/benbjohnson/litestream/releases/download/v${LITESTREAM_VERSION}/litestream-${LITESTREAM_VERSION}-linux-${LITESTREAM_ARCH}.tar.gz" \
      litestream
  fi
  if [ ! -x "$BIN_DIR/infisical" ]; then
    log "installing infisical CLI $INFISICAL_CLI_VERSION ($INFISICAL_ARCH)"
    install_from_tarball \
      "https://github.com/Infisical/cli/releases/download/v${INFISICAL_CLI_VERSION}/cli_${INFISICAL_CLI_VERSION}_linux_${INFISICAL_ARCH}.tar.gz" \
      infisical
  fi
  export PATH="$BIN_DIR:$PATH"
  export COOLIFY_PROD_PHASE2=1
  log "binaries ready; re-exec under infisical-run"
  exec node scripts/infisical-run.mjs -- bash "$0" "$@"
fi

# --- phase 2: Infisical secrets are in the environment ---
# Fail-closed Datadog APM preload.  dd-trace must load before Next.js or the
# Next plugin stays silent.  Use --import (never --require) so
# test/toolchain-policy.test.ts stays green.  Missing keys = no-op, no crash.
maybe_arm_datadog() {
  _dd_flag_off() {
    case "${1:-}" in
      0|false|FALSE|no|NO|off|OFF) return 0 ;;
      *) return 1 ;;
    esac
  }
  if _dd_flag_off "${DD_TRACE_ENABLED:-}" || _dd_flag_off "${DD_APM_TRACING_ENABLED:-}"; then
    log "Datadog APM preload skipped (trace flag off)"
    return 0
  fi
  if [ -z "${DD_API_KEY:-}${DATADOG_API_KEY:-}${DD_AGENT_HOST:-}${DD_TRACE_AGENT_URL:-}${DD_TRACE_AGENT_HOSTNAME:-}${DD_TRACE_URL:-}" ]; then
    log "Datadog APM preload skipped (no DD_API_KEY / agent host)"
    return 0
  fi
  case " ${NODE_OPTIONS:-} " in
    *" --import ./scripts/datadog-preload.mjs "*|*" --import=./scripts/datadog-preload.mjs "*)
      ;;
    *)
      export NODE_OPTIONS="${NODE_OPTIONS:-} --import ./scripts/datadog-preload.mjs"
      ;;
  esac
  log "Datadog APM preload armed via NODE_OPTIONS --import (fail-closed if init fails)"
}
maybe_arm_datadog

# Boot-time rotation for the litestream runtime log (2026-08-31).  The tee at the
# bottom of this script appends forever, and the file lives on the persistent
# production data volume -- it reached 237 MB unrotated.  At container start, if
# the log exceeds 64 MB: move the whole old log aside as .1 (overwriting any
# previous .1, so at most one generation is kept), then seed a fresh log with the
# newest 16 MB so runtime-health's litestream log scan keeps recent context.
LITESTREAM_LOG_ROTATE_BYTES=$((64 * 1024 * 1024))
LITESTREAM_LOG_KEEP_BYTES=$((16 * 1024 * 1024))
if [ -f "$LITESTREAM_LOG_FILE" ]; then
  litestream_log_size="$(wc -c < "$LITESTREAM_LOG_FILE" | tr -d '[:space:]')"
  case "$litestream_log_size" in
    ''|*[!0-9]*) litestream_log_size=0 ;;
  esac
  if [ "$litestream_log_size" -gt "$LITESTREAM_LOG_ROTATE_BYTES" ]; then
    log "rotating litestream runtime log ($litestream_log_size bytes > $LITESTREAM_LOG_ROTATE_BYTES)"
    mv -f "$LITESTREAM_LOG_FILE" "$LITESTREAM_LOG_FILE.1"
    tail -c "$LITESTREAM_LOG_KEEP_BYTES" "$LITESTREAM_LOG_FILE.1" > "$LITESTREAM_LOG_FILE"
  fi
fi

MODE="${DB_BOOTSTRAP:-fresh}"

# Production exit-code contract (docs/rollouts/2026-08-02-exit0-outage-audit.md):
# NO production code path may exit 0 spontaneously. The Coolify app runs under
# restart=unless-stopped, which restarts ANY spontaneous exit regardless of
# code -- but an exit 0 is always a lie in a server that must run forever: it
# corrupts forensics and, under any future on-failure-style policy, becomes a
# silent full outage. This supervisor gives every app exit a logged reason and
# translates an unexplained clean exit into a non-zero code:
#   40      = app exited 0 spontaneously (no stop signal forwarded) - always a bug
#   41      = R2 free-tier kill-switch (src/lib/r2-usage.ts); the restart
#             re-boots WITHOUT litestream via the marker branch below
#   42      = R2 replication resume; the restart re-enables litestream
#   43      = in-app exit-guard re-tagged a spontaneous process.exit(0)
#   130/143 = graceful shutdown after a forwarded SIGINT/SIGTERM (docker stop)
# The app is invoked as node_modules/.bin/next directly, NEVER via `npm run`:
# in-container npm dies on SIGTERM without forwarding it to the server (proven
# in the 2026-08-02 sandbox repro), so deploys hard-killed next-server and the
# recorded exit codes were garbage.
GOT_STOP_SIGNAL=""
run_app() {
  "$@" &
  APP_PID=$!
  trap 'GOT_STOP_SIGNAL=SIGTERM; log "forwarding SIGTERM to app (pid $APP_PID)"; kill -TERM "$APP_PID" 2>/dev/null || true' TERM
  trap 'GOT_STOP_SIGNAL=SIGINT; log "forwarding SIGINT to app (pid $APP_PID)"; kill -INT "$APP_PID" 2>/dev/null || true' INT
  set +e
  wait "$APP_PID"
  code=$?
  # A trap interrupts wait with 128+N while the child is still alive (or an
  # unreaped zombie); wait again until the real status is reaped.
  while kill -0 "$APP_PID" 2>/dev/null; do
    wait "$APP_PID"
    code=$?
  done
  set -e
  if [ "$code" -eq 0 ] && [ -z "$GOT_STOP_SIGNAL" ]; then
    log "FATAL: app exited 0 spontaneously (no stop signal was forwarded)."
    log "A clean exit is never valid in production - translating to exit 40 so every restart policy restarts us."
    exit 40
  fi
  if [ -n "$GOT_STOP_SIGNAL" ]; then
    log "app exited with code $code after forwarded $GOT_STOP_SIGNAL - propagating"
  else
    log "app exited with code $code - propagating"
  fi
  exit "$code"
}

if [ "$MODE" != "live" ]; then
  log "DB_BOOTSTRAP=$MODE - starting WITHOUT restore/replication (empty-DB safe mode)"
  run_app node_modules/.bin/next start
fi

if [ ! -f "$MARKER" ]; then
  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  for f in "$DB_PATH" "$DB_PATH-wal" "$DB_PATH-shm"; do
    if [ -e "$f" ]; then
      log "moving aside pre-restore file $f"
      mv "$f" "$f.pre-restore-$ts"
    fi
  done
  log "restoring production DB from litestream replica"
  litestream restore -config "$CONFIG" "$DB_PATH"
  echo "$ts restored from litestream replica" > "$MARKER"
  log "restore complete"
fi

log "DB_BOOTSTRAP=live - starting under litestream replicate"

# Generic kill-switch (owner directive 2026-08-13): allows manual override to
# pause replication during outages or memory leak investigations.
LITESTREAM_DISABLE_MARKER="${DATA_DIR}/.litestream-disabled"
if [ -f "$LITESTREAM_DISABLE_MARKER" ]; then
  log "Generic kill-switch marker present ($LITESTREAM_DISABLE_MARKER) - starting WITHOUT litestream replication"
  run_app node_modules/.bin/next start
fi

# R2 free-tier kill-switch (owner directive 2026-08-01): when the app's R2 usage
# monitor projects >70% of the free tier it writes this marker and restarts the
# container. ONLY applies when the active litestream replica is still Cloudflare
# R2 -- once AWS_S3_ENDPOINT is Backblaze B2 (or any non-R2 S3), ignore the marker
# so historic R2 free-tier pressure cannot pause the real backup target.
# Resume (R2-era only): POST /api/admin/r2-usage/resume or delete the marker.
R2_DISABLE_MARKER="${R2_USAGE_DISABLE_MARKER:-$DATA_DIR/.litestream-r2-disabled}"
if [ -f "$R2_DISABLE_MARKER" ]; then
  case "${AWS_S3_ENDPOINT:-}" in
    *r2.cloudflarestorage.com*|*cloudflarestorage.com*)
      log "R2 kill-switch marker present ($R2_DISABLE_MARKER) and replica is Cloudflare R2 - starting WITHOUT litestream replication"
      log "marker contents: $(cat "$R2_DISABLE_MARKER" 2>/dev/null | head -c 500)"
      run_app node_modules/.bin/next start
      ;;
    *)
      log "R2 kill-switch marker present but replica endpoint is not Cloudflare R2 (endpoint host set; len=${#AWS_S3_ENDPOINT}) - ignoring marker so B2/other backup continues"
      log "marker contents: $(cat "$R2_DISABLE_MARKER" 2>/dev/null | head -c 500)"
      ;;
  esac
fi

# The `> >(tee -a ...) 2>&1` form (process substitution, NOT a `| tee` pipe) is deliberate: a
# pipe backgrounds the whole pipeline and makes `$!` inside run_app resolve to `tee`'s PID instead
# of litestream's, which would silently break the SIGTERM-forwarding contract above (the exact
# class of bug the 2026-08-02 exit-code audit exists to prevent). Process substitution redirects
# fds for this one call without wrapping it in a subshell, so `$!` still resolves to the real
# litestream PID -- verified locally (PID capture, SIGTERM forwarding, and exit-code propagation
# all unchanged) before landing this. tee also still mirrors everything to the script's own
# stdout/stderr, so nothing is removed from what Coolify's log collector already sees.
run_app litestream replicate -config "$CONFIG" -exec "node_modules/.bin/next start" > >(tee -a "$LITESTREAM_LOG_FILE") 2>&1
