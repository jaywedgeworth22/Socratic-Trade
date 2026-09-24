#!/usr/bin/env bash
# scripts/merge-shepherd.sh
#
# Drives auto-merge-armed PRs home and reports the state of EVERY open PR, so
# background work can't silently rot into CONFLICTING and be forgotten.
#
# It only *acts* (merge / update-branch / re-run verify) on PRs whose author
# already ARMED auto-merge (i.e. it went through scripts/land.sh). Everything
# else it only *reports* -- it never force-merges work nobody opted in to land.
#
# Why this is needed: the handoff protocol makes every PR edit docs/EFFORT-LOG.md
# + STATUS.md, so each merge turns every other open PR CONFLICTING. GitHub's
# native auto-merge can't self-heal that; land.sh arms auto-merge once and never
# comes back. This shepherd is the "come back": union-merge (.gitattributes) makes
# those board conflicts vanish on update-branch, and the shepherd re-syncs stuck
# PRs, re-runs flaky verify once, merges the green ones, and publishes a digest.
#
# Design notes:
# - GitHub reports PR mergeability lazily (often "UNKNOWN"), so we don't trust it;
#   we *attempt* the merge and react to the outcome -- the attempt forces the
#   computation and tells us whether it's really a conflict.
# - The only merge gate is the required `verify` check (ruleset: no approvals, not
#   strict, no thread-resolution), so `verify == SUCCESS` is our green signal.
#
# Env:
#   GITHUB_REPOSITORY   owner/repo (default: jaywedgeworth22/Socratic-Trade)
#   SHEPHERD_DRY_RUN=1  report only; attempt nothing
#   GH_TOKEN/GITHUB_TOKEN  auth. A PAT (repo+workflow scope) is preferred so that
#                          update-branch re-triggers verify; the default Actions
#                          GITHUB_TOKEN still merges green PRs + reports.
#   SHEPHERD_HAS_PAT       set to "0" by merge-shepherd.yml when no SHEPHERD_TOKEN
#                          secret exists, so update-branch re-syncs are skipped
#                          (report-only) instead of attempted with a token that
#                          can't re-trigger verify. Unset (e.g. the launchd driver,
#                          which uses a real user PAT) defaults to "1".
set -uo pipefail

REPO="${GITHUB_REPOSITORY:-jaywedgeworth22/Socratic-Trade}"
DRY="${SHEPHERD_DRY_RUN:-0}"
HAS_PAT="${SHEPHERD_HAS_PAT:-1}"
ISSUE_TITLE="Merge shepherd status"
# Who am I? Needed so the reran-marker check below (Codex review, round 3) only
# trusts a comment we ourselves posted, not one any commenter could spoof. A PAT
# resolves to its owning user via /user; the default Actions GITHUB_TOKEN is an
# app-installation token that 403s on /user, and always posts comments as the
# literal login "github-actions[bot]" -- so that's the fallback (and the direct
# value whenever HAS_PAT=0, skipping a doomed API call).
ME=""
[ "$HAS_PAT" = "1" ] && ME="$(gh api user --jq '.login' 2>/dev/null)"
ME="${ME:-github-actions[bot]}"
TMP="$(mktemp)"; trap 'rm -f "$TMP" "$TMP.md"' EXIT

row() { printf '%s\t%s\t%s\n' "$1" "$2" "$3" >>"$TMP"; }   # bucket \t num \t note

# Completed check conclusions that mean "done, and not passing" -- these get the
# same rerun-once-then-escalate treatment as FAILURE, instead of being left in
# WAITING forever (only genuinely in-flight states -- IN_PROGRESS/QUEUED/WAITING/
# REQUESTED/PENDING/EXPECTED -- should ever land in WAITING). ERROR is the
# terminal commit-status state (GitHub's StatusState enum) parallel to FAILURE.
is_failure_conclusion() {
  case "$1" in
    FAILURE|CANCELLED|TIMED_OUT|ACTION_REQUIRED|STARTUP_FAILURE|STALE|ERROR) return 0 ;;
    *) return 1 ;;
  esac
}

echo "[shepherd] scanning open PRs in $REPO (dry=$DRY)"
nums=$(gh pr list -R "$REPO" --state open --limit 80 --json number --jq '.[].number') || {
  echo "[shepherd] FATAL: gh pr list failed -- aborting instead of reporting a false all-clear" >&2
  exit 1
}

for num in $nums; do
  d=$(gh pr view "$num" -R "$REPO" \
        --json title,isDraft,autoMergeRequest,statusCheckRollup,labels,headRefOid,comments 2>/dev/null) || continue
  title=$(jq -r '.title' <<<"$d")
  draft=$(jq -r '.isDraft' <<<"$d")
  armed=$(jq -r '.autoMergeRequest != null' <<<"$d")
  sha=$(jq -r '.headRefOid' <<<"$d")
  # conclusion (SUCCESS/FAILURE/...) for a finished check; else status (IN_PROGRESS/QUEUED)
  # for a running one; else state (PENDING) for a commit-status; else NONE = no check at all.
  verify=$(jq -r '[.statusCheckRollup[]? | select((.name // .context)=="verify")][0] | (.conclusion // .status // .state // "NONE")' <<<"$d")
  nchecks=$(jq -r '[.statusCheckRollup[]?] | length' <<<"$d")   # any checks at all yet?
  # In-flight (not-yet-concluded) checks -- distinct from nchecks, which also counts
  # checks that already finished, possibly on a workflow other than "verify" itself.
  # Covers both check-run statuses (QUEUED/IN_PROGRESS/WAITING/REQUESTED/PENDING) and
  # commit-status states (PENDING/EXPECTED), so a verify-absent-but-other-checks-still-
  # in-flight PR isn't mistaken for "no CI at all" and re-synced mid-CI.
  running=$(jq -r '[.statusCheckRollup[]? | select((.status // "")=="IN_PROGRESS" or (.status // "")=="QUEUED" or (.status // "")=="WAITING" or (.status // "")=="REQUESTED" or (.status // "")=="PENDING" or (.state // "")=="PENDING" or (.state // "")=="EXPECTED")] | length' <<<"$d")
  # Reran marker is a PR comment scoped to this head sha (not a PR-wide label), so a
  # flaky failure on a later head still gets its own one-time rerun. Also scoped to
  # comments authored by us ($ME, resolved above) -- otherwise any PR commenter could
  # copy the visible head sha into a comment and trick the shepherd into skipping its
  # one-time flake-recovery rerun (Codex review, round 3).
  reran=$(jq -r --arg sha "$sha" --arg me "$ME" '[.comments[]? | select((.author.login // "")==$me) | (.body // "") | select(contains("shepherd-reran:" + $sha))] | length > 0' <<<"$d")

  if [ "$draft" = "true" ]; then row DRAFT "$num" "$title"; continue; fi
  if [ "$armed" != "true" ]; then row NOT-ARMED "$num" "$title  (verify=$verify -- parked / not landed via land.sh)"; continue; fi

  echo "[shepherd] #$num armed  verify=$verify reran=$reran"

  if [ "$DRY" = "1" ]; then
    case "$verify" in
      SUCCESS) row WOULD-MERGE "$num" "$title" ;;
      FAILURE|CANCELLED|TIMED_OUT|ACTION_REQUIRED|STARTUP_FAILURE|STALE|ERROR)
               row FAILING "$num" "$title  (verify=$verify; reran=$reran)" ;;
      NONE)    if [ "$running" -gt 0 ]; then row WAITING "$num" "$title  (CI running; verify not posted yet)";
               else row WOULD-SYNC "$num" "$title  (no CI at all -- would re-sync to re-trigger it)"; fi ;;
      *)       row WAITING "$num" "$title  (verify=$verify -- CI running)" ;;
    esac
    continue
  fi

  if [ "$verify" = "SUCCESS" ] && [ "$HAS_PAT" != "1" ]; then
    # Merging with the Actions GITHUB_TOKEN makes github-actions[bot] the merging
    # identity, and GitHub raises no workflow events for GITHUB_TOKEN actions --
    # the merge commit on main would then run NEITHER CI NOR ios-ship. Verified
    # 2026-08-13 on PR #2675 (bot-merged, sha ca38bb2979: zero `event: push` runs)
    # versus #2678/#2679/#2680 (human-merged: full run set). Report instead; the
    # launchd driver runs with a real PAT and does merge.
    row WAITING "$num" "$title  (green + armed; merge skipped -- no PAT, a bot merge would dispatch no post-merge CI)"

  elif [ "$verify" = "SUCCESS" ]; then
    # Attempt the merge; the attempt itself resolves mergeability.
    if out=$(gh pr merge "$num" -R "$REPO" --squash 2>&1); then
      row MERGED "$num" "$title"
    else
      lc=$(printf '%s' "$out" | tr '[:upper:]' '[:lower:]')
      if printf '%s' "$lc" | grep -Eq 'conflict|not mergeable|not up to date|behind|base branch was modified'; then
        # Behind/conflicting -- re-sync. union-merge (.gitattributes) auto-resolves board files.
        if [ "$HAS_PAT" != "1" ]; then
          row WAITING "$num" "$title  (behind main; re-sync skipped -- no PAT to re-trigger verify)"
        elif gh pr update-branch "$num" -R "$REPO" >/dev/null 2>&1; then
          row UNSTUCK "$num" "$title  (synced to main; verify re-running)"
        else
          gh pr edit "$num" -R "$REPO" --add-label needs-human-merge >/dev/null 2>&1 || true
          row CONFLICT "$num" "$title  (real conflict -- needs a human)"
        fi
      else
        row MERGE-RETRY "$num" "$title  (gh: $(printf '%s' "$out" | head -1 | cut -c1-80))"
      fi
    fi

  elif is_failure_conclusion "$verify" && [ "$reran" != "true" ]; then
    # Flake recovery: re-run non-passing workflow runs for this head sha, exactly once.
    # REST API conclusions are lowercase snake_case, mirroring is_failure_conclusion().
    runids=$(gh api "repos/$REPO/actions/runs?head_sha=$sha" \
               --jq '.workflow_runs[] | select(.conclusion=="failure" or .conclusion=="cancelled" or .conclusion=="timed_out" or .conclusion=="action_required" or .conclusion=="startup_failure" or .conclusion=="stale") | "\(.id)\t\(.conclusion)"' 2>/dev/null)
    rerun_ok=0
    while IFS="$(printf '\t')" read -r rid rconclusion; do
      [ -z "$rid" ] && continue
      # Only a cleanly "failure"-concluded run is safe to narrow to /rerun-failed-jobs
      # (and even then, only when it actually has a failed job -- a run that failed via
      # e.g. a required check never dispatching has none, and /rerun-failed-jobs 4xxs on
      # that with "nothing to rerun"). Every other run conclusion (cancelled/timed_out/
      # action_required/startup_failure/stale) can leave the REQUIRED job itself
      # cancelled or never-started rather than "failed" -- rerun-failed-jobs only
      # re-runs jobs with conclusion==failure (+ dependents), so it can silently never
      # re-trigger a cancelled/timed-out required check (Codex review, round 3). Always
      # use the all-jobs endpoint for those conclusions.
      if [ "$rconclusion" = "failure" ]; then
        failed_jobs=$(gh api "repos/$REPO/actions/runs/$rid/jobs" \
                        --jq '[.jobs[]? | select(.conclusion=="failure")] | length' 2>/dev/null)
        if [ "${failed_jobs:-0}" -gt 0 ]; then
          endpoint="rerun-failed-jobs"
        else
          endpoint="rerun"
        fi
      else
        endpoint="rerun"
      fi
      if gh api -X POST "repos/$REPO/actions/runs/$rid/$endpoint" >/dev/null 2>&1; then
        rerun_ok=1
      fi
    done <<<"$runids"
    if [ "$rerun_ok" = "1" ]; then
      # Only mark this head sha as retried when a rerun POST actually succeeded --
      # otherwise a failed rerun attempt would falsely block the one-time retry.
      gh pr comment "$num" -R "$REPO" --body "<!-- shepherd-reran:$sha -->" >/dev/null 2>&1 || true
      row RE-RAN "$num" "$title  (verify=$verify -- re-ran once for flake)"
    else
      row FAILING "$num" "$title  (verify=$verify -- rerun attempt failed; needs a human)"
    fi

  elif is_failure_conclusion "$verify"; then
    row FAILING "$num" "$title  (verify=$verify after a re-run -- needs a human)"

  elif [ "$verify" = "NONE" ] && [ "$running" -gt 0 ]; then
    # Other checks are still running but the "verify" status hasn't posted yet.
    # Do NOT re-sync (that would needlessly re-trigger CI) -- just wait.
    row WAITING "$num" "$title  (CI running; verify not posted yet)"

  elif [ "$verify" = "NONE" ]; then
    # Nothing is running and "verify" never posted -- either CI never dispatched at
    # all for this head (conflicting-never-run, or an Actions hiccup: #1166's case),
    # or every OTHER check already finished while verify itself never showed up.
    # Either way, re-sync to force a fresh CI run.
    if [ "$HAS_PAT" != "1" ]; then
      row WAITING "$num" "$title  (no verify check; re-sync skipped -- no PAT to re-trigger verify)"
    elif out=$(gh pr update-branch "$num" -R "$REPO" 2>&1); then
      row UNSTUCK "$num" "$title  (no CI had run -- re-synced to re-trigger verify)"
    elif printf '%s' "$out" | tr '[:upper:]' '[:lower:]' | grep -Eq 'conflict|not mergeable|cannot be'; then
      gh pr edit "$num" -R "$REPO" --add-label needs-human-merge >/dev/null 2>&1 || true
      row CONFLICT "$num" "$title  (real conflict -- needs a human)"
    else
      # "already up to date" but still no check -> CI genuinely needs a manual nudge
      row WAITING "$num" "$title  (no verify check + branch up-to-date -- CI may need a nudge)"
    fi

  else
    row WAITING "$num" "$title  (verify=$verify -- CI still running)"
  fi
done

# ---- build digest (portable awk; no grep -P) ----
cnt() { awk -F'\t' -v b="$1" '$1==b{n++} END{print n+0}' "$TMP" 2>/dev/null; }
list() { awk -F'\t' -v b="$1" '$1==b{print "- #"$2" -- "$3}' "$TMP" 2>/dev/null; }
now="$(date -u '+%Y-%m-%d %H:%MZ' 2>/dev/null || echo now)"

{
  echo "_Last run: ${now}. The shepherd acts only on auto-merge-armed PRs; it reports the rest._"
  echo
  echo "| state | count |"
  echo "|---|---|"
  echo "| [merged] | $(cnt MERGED) |"
  echo "| [unstuck] synced to main | $(cnt UNSTUCK) |"
  echo "| [re-ran] verify (flake) | $(cnt RE-RAN) |"
  echo "| [merge-retry] transient merge error | $(cnt MERGE-RETRY) |"
  echo "| [conflict] real conflict -- needs human | $(cnt CONFLICT) |"
  echo "| [failing] verify failing -- needs human | $(cnt FAILING) |"
  echo "| [waiting] on CI | $(cnt WAITING) |"
  echo "| [not-armed] auto-merge NOT armed | $(cnt NOT-ARMED) |"
  echo "| [draft] | $(cnt DRAFT) |"
  [ "$DRY" = "1" ] && echo "| _(dry) would merge_ | $(cnt WOULD-MERGE) |"
  [ "$DRY" = "1" ] && echo "| _(dry) would re-sync_ | $(cnt WOULD-SYNC) |"
  for pair in \
    "CONFLICT:[conflict] Real conflict -- needs a human" \
    "FAILING:[failing] Verify failing after a re-run -- needs a human" \
    "MERGE-RETRY:[merge-retry] Merge attempt failed (non-conflict) -- will retry next run" \
    "NOT-ARMED:[not-armed] Auto-merge NOT armed (parked, or never landed via land.sh)" \
    "MERGED:[merged] Merged this run" \
    "UNSTUCK:[unstuck] Branch synced; verify re-running" \
    "RE-RAN:[re-ran] Verify re-run (flake recovery)" \
    "WAITING:[waiting] Waiting on CI"; do
    key="${pair%%:*}"; hdr="${pair#*:}"; body="$(list "$key")"
    [ -n "$body" ] && { echo; echo "### $hdr"; echo "$body"; }
  done
} > "$TMP.md"

cat "$TMP.md"
[ -n "${GITHUB_STEP_SUMMARY:-}" ] && cat "$TMP.md" >> "$GITHUB_STEP_SUMMARY"

if [ "$DRY" != "1" ]; then
  body="$(cat "$TMP.md")
<sub>Auto-maintained by the merge shepherd (\`scripts/merge-shepherd.sh\`, workflow \`merge-shepherd.yml\`). Overwritten each run.</sub>"
  existing=$(gh issue list -R "$REPO" --state open --search "\"$ISSUE_TITLE\" in:title" \
               --json number,title --jq "[.[] | select(.title==\"$ISSUE_TITLE\")][0].number" 2>/dev/null)
  if [ -n "$existing" ] && [ "$existing" != "null" ]; then
    gh issue edit "$existing" -R "$REPO" --body "$body" >/dev/null 2>&1 && echo "[shepherd] updated tracking issue #$existing"
  else
    gh issue create -R "$REPO" --title "$ISSUE_TITLE" --body "$body" >/dev/null 2>&1 && echo "[shepherd] created tracking issue"
  fi
fi

echo "[shepherd] done"
