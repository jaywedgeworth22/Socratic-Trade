#!/usr/bin/env bash
# runner-availability.sh - Mac-side availability publisher for hybrid CI runner routing.
#
# Publishes the repo Actions variable VERIFY_RUNNER_STATE as JSON:
#   {"mode":"self"|"hosted","ts":<epoch seconds>}
# The CI router (ci.yml `classify` job) reads this variable natively and routes the
# required `verify` gate to the self-hosted Mac runner ONLY when mode=self and ts is
# fresh (<5 min). Anything else (busy, stale, absent) routes hosted instantly, so a
# busy or asleep Mac never queues CI work.
#
# Availability definition (resource-aware, pressure-based):
#   available = (1-min loadavg / hw.ncpu < LOAD_THRESHOLD)
#           AND (kern.memorystatus_vm_pressure_level == 1  -- kernel says pressure is normal)
#           AND (vm.page_free_wanted == 0                  -- kernel not actively reclaiming)
#           AND (swap used < MAX_SWAP_USED_GB              -- absolute anti-thrash floor)
#           AND (compressor occupancy / RAM < MAX_COMPRESSOR_FRAC)
#           AND (free+inactive RAM > MIN_FREE_RAM_GB       -- tertiary raw-headroom floor)
#           AND (GitHub Actions runner process alive)
#           AND (pm2 app "trading" online)
# Rationale: `free+inactive` alone is the wrong macOS signal -- it both under-counts
# reclaimable cache AND is blind to swap/compressor, so it can read healthy on a thrashing
# box. The kernel pressure level + swap/compressor terms encode "can this box take on a
# multi-GB verify job WITHOUT paging the live trading process." On a memory-tight box these
# terms correctly stay false (it keeps hosting on GitHub); they open only when the box
# genuinely has headroom. The self-lane verify job is additionally RSS-capped in ci.yml.
# Hysteresis: TWO consecutive available checks are required before flipping to
# mode=self; any single busy check flips to mode=hosted immediately.
# Self-path gate commands additionally run under `nice -n 19` (see ci.yml).
#
# Run under pm2 on the production Mac (owner-run, idempotent):
#   pm2 start ~/apps/trading-live/scripts/runner-availability.sh \
#     --name runner-availability --interpreter bash && pm2 save
#
# Requirements: gh (authenticated), node (for pm2 jlist parsing), macOS sysctl/vm_stat.
# Keep this file pure ASCII (AGENTS.md: operator shell scripts, Apple bash 3.2).
set -u

REPO="${RUNNER_AVAILABILITY_REPO:-jaywedgeworth22/Socratic-Trade}"
VAR_NAME="VERIFY_RUNNER_STATE"
INTERVAL_SECONDS="${RUNNER_AVAILABILITY_INTERVAL:-60}"
# CPU: 1-min loadavg / ncpu must be below this. Loosened from 0.6 to 0.8 because every
# self-path gate command runs under `nice -n 19` (see ci.yml), so the live trading process
# always outbids CI for CPU scheduling -- the CPU term does not need a large idle buffer.
LOAD_THRESHOLD="${RUNNER_AVAILABILITY_LOAD_THRESHOLD:-0.8}"
# Memory: gate on genuine PRESSURE, not raw free pages. On macOS `free+inactive` is a poor
# availability signal (the OS keeps free low by design and much of "inactive"/file cache is
# reclaimable) AND it is blind to swap/compressor, so it can read healthy while the box
# thrashes. We instead require the kernel's own pressure verdict to be normal and swap +
# compressor to be low. `nice -n 19` protects CPU scheduling but does NOTHING for memory,
# so this is the load-bearing safety gate for the live trading process.
MAX_SWAP_USED_GB="${RUNNER_AVAILABILITY_MAX_SWAP_USED_GB:-3}"
MAX_COMPRESSOR_FRAC="${RUNNER_AVAILABILITY_MAX_COMPRESSOR_FRAC:-0.25}"
MIN_FREE_RAM_GB="${RUNNER_AVAILABILITY_MIN_FREE_RAM_GB:-3}"
HYSTERESIS_REQUIRED="${RUNNER_AVAILABILITY_HYSTERESIS:-2}"
PM2_APP="${RUNNER_AVAILABILITY_PM2_APP:-trading}"
RUNNER_PROCESS_PATTERN="${RUNNER_AVAILABILITY_RUNNER_PATTERN:-Runner.Listener}"

log() { printf '[runner-availability] %s %s\n' "$(date '+%Y-%m-%dT%H:%M:%S')" "$*"; }

publish() {
  # publish <mode>  -- PATCH the repo variable (POST once if it does not exist yet).
  mode="$1"
  ts="$(date +%s)"
  value="{\"mode\":\"${mode}\",\"ts\":${ts}}"
  if gh api --method PATCH "repos/${REPO}/actions/variables/${VAR_NAME}" \
      -f name="${VAR_NAME}" -f value="${value}" >/dev/null 2>&1; then
    return 0
  fi
  # PATCH failed: variable may not exist yet -- try to create it.
  if gh api --method POST "repos/${REPO}/actions/variables" \
      -f name="${VAR_NAME}" -f value="${value}" >/dev/null 2>&1; then
    log "created repo variable ${VAR_NAME}"
    return 0
  fi
  log "WARN: could not publish ${VAR_NAME} (gh auth/network?) - router will treat state as stale and route hosted"
  return 1
}

# On shutdown (pm2 stop/restart, reboot), flip to hosted so the router never keeps
# routing to a Mac whose publisher just died. Staleness (>5 min) is the backstop if
# even this trap cannot run (hard power loss).
on_exit() {
  log "exiting - publishing mode=hosted"
  publish hosted || true
}
trap on_exit EXIT INT TERM

check_available() {
  # Returns 0 (available) or 1 (busy), logging the reason.
  ncpu="$(sysctl -n hw.ncpu 2>/dev/null || echo 0)"
  [ "$ncpu" -gt 0 ] 2>/dev/null || { log "busy: cannot read hw.ncpu"; return 1; }

  # vm.loadavg prints like: { 1.23 1.45 1.60 }
  load1="$(sysctl -n vm.loadavg 2>/dev/null | awk '{print $2}')"
  [ -n "$load1" ] || { log "busy: cannot read loadavg"; return 1; }
  load_ok="$(awk -v l="$load1" -v n="$ncpu" -v t="$LOAD_THRESHOLD" 'BEGIN{print (l/n < t) ? 1 : 0}')"
  if [ "$load_ok" != "1" ]; then
    log "busy: loadavg ${load1} / ${ncpu} cpus >= ${LOAD_THRESHOLD}"
    return 1
  fi

  pagesize="$(sysctl -n hw.pagesize 2>/dev/null || echo 16384)"

  # (1) Kernel pressure verdict must be normal (1). 2=warn, 4=critical. Unreadable -> busy.
  pressure="$(sysctl -n kern.memorystatus_vm_pressure_level 2>/dev/null || echo 0)"
  if [ "${pressure:-0}" != "1" ]; then
    log "busy: kernel memory pressure level ${pressure:-unknown} (need 1=normal)"
    return 1
  fi

  # (2) Kernel must not be actively trying to free pages right now.
  free_wanted="$(sysctl -n vm.page_free_wanted 2>/dev/null || echo 1)"
  if [ "${free_wanted:-1}" != "0" ]; then
    log "busy: kernel actively reclaiming (vm.page_free_wanted=${free_wanted})"
    return 1
  fi

  # (3) Absolute swap-used floor -- the single most predictive anti-thrash term. Parse
  # "total = X.XXM  used = Y.YYM  free = Z.ZZM" and compare used (GB) to the cap.
  # Only accept the megabyte form macOS actually emits ("used = Y.YYM"). If a future macOS
  # ever reports G/K units, the token won't match /M$/, swap_used_gb stays empty, and we
  # fail busy -- never mis-scale a large swap down into a false "available".
  swap_used_gb="$(sysctl -n vm.swapusage 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="used"){v=$(i+2); if(v ~ /M$/){sub(/M$/,"",v); printf "%.2f", v/1024}; exit}}')"
  [ -n "$swap_used_gb" ] || { log "busy: cannot read/parse vm.swapusage (non-MB units?)"; return 1; }
  swap_ok="$(awk -v u="$swap_used_gb" -v m="$MAX_SWAP_USED_GB" 'BEGIN{print (u+0 < m+0) ? 1 : 0}')"
  if [ "$swap_ok" != "1" ]; then
    log "busy: swap used ${swap_used_gb}GB >= ${MAX_SWAP_USED_GB}GB (under memory pressure)"
    return 1
  fi

  # (4) Compressor occupancy must be a small fraction of physical RAM (already-compressed
  # anon pages are not cheaply reclaimable, so a large compressor means little real headroom).
  memsize="$(sysctl -n hw.memsize 2>/dev/null || echo 0)"
  comp_pages="$(vm_stat | awk '/occupied by compressor/ {gsub(/\./,"",$NF); print $NF}')"
  # Fail-closed like every other term: unreadable compressor/memsize -> busy, never skip the
  # check (this is the load-bearing memory safety gate).
  { [ -n "$comp_pages" ] && [ "$memsize" -gt 0 ] 2>/dev/null; } || { log "busy: cannot read compressor pages / memsize"; return 1; }
  comp_ok="$(awk -v c="$comp_pages" -v p="$pagesize" -v m="$memsize" -v t="$MAX_COMPRESSOR_FRAC" \
    'BEGIN{print (c*p/m < t) ? 1 : 0}')"
  if [ "$comp_ok" != "1" ]; then
    log "busy: compressor occupies >= ${MAX_COMPRESSOR_FRAC} of physical RAM"
    return 1
  fi

  # (5) Tertiary raw-headroom floor: free+inactive still above a small absolute minimum.
  pages_free="$(vm_stat | awk '/Pages free/ {gsub(/\./,"",$3); print $3}')"
  pages_inactive="$(vm_stat | awk '/Pages inactive/ {gsub(/\./,"",$3); print $3}')"
  [ -n "$pages_free" ] && [ -n "$pages_inactive" ] || { log "busy: cannot read vm_stat"; return 1; }
  ram_ok="$(awk -v f="$pages_free" -v i="$pages_inactive" -v p="$pagesize" -v g="$MIN_FREE_RAM_GB" \
    'BEGIN{print ((f+i)*p > g*1024*1024*1024) ? 1 : 0}')"
  if [ "$ram_ok" != "1" ]; then
    log "busy: free+inactive RAM below ${MIN_FREE_RAM_GB}GB"
    return 1
  fi

  if ! pgrep -f "$RUNNER_PROCESS_PATTERN" >/dev/null 2>&1; then
    log "busy: GitHub Actions runner process (${RUNNER_PROCESS_PATTERN}) not running"
    return 1
  fi

  pm2_status="$(pm2 jlist 2>/dev/null | node -e '
    let s = "";
    process.stdin.on("data", d => s += d).on("end", () => {
      try {
        const apps = JSON.parse(s);
        const app = apps.find(a => a.name === process.env.PM2_APP);
        console.log(app ? app.pm2_env.status : "absent");
      } catch (e) { console.log("parse-error"); }
    });' 2>/dev/null)"
  if [ "$pm2_status" != "online" ]; then
    log "busy: pm2 app '${PM2_APP}' status is '${pm2_status:-unknown}' (need online)"
    return 1
  fi

  return 0
}

log "starting: repo=${REPO} interval=${INTERVAL_SECONDS}s load<${LOAD_THRESHOLD} pressure=normal swap<${MAX_SWAP_USED_GB}GB compressor<${MAX_COMPRESSOR_FRAC} free>${MIN_FREE_RAM_GB}GB hysteresis=${HYSTERESIS_REQUIRED}"

consecutive_available=0
current_mode="hosted"
publish hosted || true

while true; do
  if PM2_APP="$PM2_APP" check_available; then
    consecutive_available=$((consecutive_available + 1))
    if [ "$consecutive_available" -ge "$HYSTERESIS_REQUIRED" ]; then
      if [ "$current_mode" != "self" ]; then
        log "flipping to mode=self (${consecutive_available} consecutive available checks)"
      fi
      current_mode="self"
    fi
  else
    # Any single busy check flips to hosted immediately.
    if [ "$current_mode" != "hosted" ]; then
      log "flipping to mode=hosted (busy check)"
    fi
    consecutive_available=0
    current_mode="hosted"
  fi

  # Publish every cycle so ts stays fresh (router treats >5 min as stale -> hosted).
  publish "$current_mode" || true
  sleep "$INTERVAL_SECONDS"
done
