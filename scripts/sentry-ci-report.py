#!/usr/bin/env python3
"""
sentry-ci-report.py — reports CI workflow outcomes to the shared fleet-infra
Sentry project (org jays-services), via raw envelope HTTP (no sentry-sdk
dependency, no GitHub Actions marketplace action).

Invoked by .github/workflows/sentry-ci-report.yml, which listens for
`workflow_run: types: [requested, completed]` across every other workflow in
this repo and sets the env vars this script reads.  This script itself does not
know about GitHub Actions beyond reading those env vars — all the wiring lives
in the workflow file.

Three signals are sent, across the two phases of one observed run:
  1. REQUESTED phase, schedule-triggered runs only (WORKFLOW_RUN_ACTION ==
     "requested"): a Sentry Crons check-in with status "in_progress", which
     OPENS the check-in the moment GitHub creates the run — before a runner is
     even allocated.  No conclusion-based failure event is sent on this path:
     at request time the run's conclusion is still null, so there is nothing
     to alert on there.  A config-drift event CAN still be sent here (the
     unconditional stale-cron-key guard in section 0, or the
     unmapped-schedule event raised by resolve_cron_expr()) if this reporter's
     own CRON_SCHEDULES mapping has fallen out of date.  Before sending the
     in_progress check-in, this phase also asks the Actions API whether the
     observed run has already finished (fetch_observed_run_status()) and
     skips the check-in if so.  GitHub's own concurrency group does not
     GUARANTEE that this requested-phase reporter run is created before the
     completed-phase one — a very fast observed run can flip that order — so
     this check is what actually keeps the two reporter runs from racing to
     open a check-in the completed phase has already closed.
  2. COMPLETED phase, if the run's conclusion warrants an alert (failure /
     timed_out / startup_failure — see ALERT_CONCLUSIONS): a Sentry error event
     tagged with {app, workflow, branch, actor}, carrying the run URL,
     fingerprinted on [ci-failure, app, workflow] so every failure of one
     workflow groups into ONE Sentry issue instead of paging separately every
     time.
  3. COMPLETED phase, if the run was schedule-triggered (event == "schedule"):
     the terminal Sentry Crons check-in (status "error" when the conclusion is
     in ALERT_CONCLUSIONS, "ok" for every other conclusion — the monitor
     answers "did this cron fire", and a cancelled/skipped tick is not a
     failure of the schedule) with an upsert monitor_config whose schedule
     mirrors that workflow's own cron expression (see CRON_SCHEDULES below) so a
     nightly/weekly job that silently STOPS running raises a missed-check-in
     alert.  It carries the SAME check_in_id as (1), which is what CLOSES the
     in_progress check-in that phase opened.

The two phases are two separate GitHub jobs with no shared state, so the
check_in_id cannot simply be generated once and passed along: both phases
DERIVE it from the observed run, via checkin_id_for_run() (a uuid5 over the
app, the observed run id, and the run attempt).  Sentry closes an in_progress
check-in only when a terminal check-in arrives bearing the same id, so that
determinism is the whole mechanism.  See FLEET-INFRA-CB / board c630ceed for
why the in_progress phase exists at all: without it, checkin_margin had to
absorb the observed job runtime as well as GitHub's schedule-dispatch delay.

The branch is deliberately NOT part of the fingerprint (it was until
2026-08-12).  Branch names are unbounded and short-lived, so including one
minted a brand-new, permanent Sentry issue for every (workflow, branch) pair —
~85 of this fleet's 200+ unresolved fleet-infra issues came from that single
line, each one a dead feature branch nobody will ever look at again.  The
branch is still carried as a per-event TAG (searchable, and visible on every
event), which is where unbounded-cardinality data belongs.

The `app` tag + fingerprint component are required: fleet-infra is shared
across repos, and this repo shares workflow names ("CI", "Security",
"Effort Issues Sync") with Socratic.Trade / Congress.Trade, so without `app`
a "CI" failure here would dedup into the same Sentry issue as one there.
Per AGENT-SYNC.md "Observability", every event is tagged with `app:<repo>`.

Secrets: SENTRY_FLEET_DSN is read only from the environment (set by the
workflow from the repo secret) and is NEVER printed or logged in any form,
including in exception messages.
"""

from __future__ import annotations

import json
import os
import re
import sys
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path

# This repo's identity in the shared fleet-infra project. Tags every event and
# participates in the fingerprint so cross-repo CI failures never collapse into
# one Sentry issue.
APP = "socratic-trade"

CRON_SCHEDULES = {
    "CI": "47 7 * * *",
    "Cleanup Actions Caches": "5 3 * * *",
    "Effort Issues Sync": "12 6 * * *",
    "iOS TestFlight ship": "*/30 * * * *",
    "Security": "41 10 * * 1",
    "Playwright Smoke": "17 9 * * *",
    "Shared package pin check": "0 13 * * 1",
    "Deploy freshness": "13,33,53 * * * *",
    "RTH Deploy Latch": "20 21 * * 1-5",
}
_CRON_SCHEDULES_FOLDED = {name.casefold(): expr for name, expr in CRON_SCHEDULES.items()}

DEFAULT_CHECKIN_MARGIN = 15
CHECKIN_MARGIN_OVERRIDES = {
    "Deploy freshness": 600,
}
_CHECKIN_MARGINS_FOLDED = {name.casefold(): margin for name, margin in CHECKIN_MARGIN_OVERRIDES.items()}

DEFAULT_MAX_RUNTIME = 60
MAX_RUNTIME_OVERRIDES = {}
_MAX_RUNTIMES_FOLDED = {name.casefold(): runtime for name, runtime in MAX_RUNTIME_OVERRIDES.items()}

FLAP_DEBOUNCE_OVERRIDES = {}
_FLAP_DEBOUNCE_FOLDED = {name.casefold(): cfg for name, cfg in FLAP_DEBOUNCE_OVERRIDES.items()}

WORKFLOWS_DIR = Path(__file__).resolve().parent.parent / ".github" / "workflows"

# Terminal workflow_run conclusions that should raise a Sentry error event.
# Beyond a plain "failure", a run GitHub kills counts as broken: "timed_out"
# (hung past its limit) and "startup_failure" (the run never started) would
# otherwise slip through silently. Deliberately EXCLUDES "cancelled" / "skipped"
# / "neutral" / "stale" / "action_required" — those are normally intentional and
# alerting on them would just be pager noise.
ALERT_CONCLUSIONS = frozenset({"failure", "timed_out", "startup_failure"})


def slugify(name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    slug = re.sub(r"-+", "-", slug)
    return slug


def discover_workflow_names(workflows_dir: Path = WORKFLOWS_DIR) -> set[str] | None:
    """Return the `name:` of every workflow under .github/workflows.

    Returns None — meaning "cannot tell", so the caller must not report drift —
    when that directory is absent (the script running outside a checkout).  A
    deliberately dumb line scan rather than a YAML parse: this must not add a
    PyYAML dependency to a script whose whole point is having none, and the
    top-level `name:` of a GitHub workflow is always a plain unindented scalar.
    """
    if not workflows_dir.is_dir():
        return None
    names: set[str] = set()
    for path in sorted(workflows_dir.glob("*.y*ml")):
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for line in text.splitlines():
            m = re.match(r"^name:\s*(.+?)\s*$", line)
            if m:
                names.add(m.group(1).strip().strip("\"'"))
                break
    return names


def find_cron_schedule_drift(known_names: set[str] | None) -> list[str]:
    """CRON_SCHEDULES keys that match no real workflow `name:`, case-insensitively.

    Empty when the workflow set is unknown (None) or empty — "I could not read
    the workflows" must never masquerade as "every key is stale".
    """
    if not known_names:
        return []
    folded = {name.casefold() for name in known_names}
    return sorted(key for key in CRON_SCHEDULES if key.casefold() not in folded)


def checkin_id_for_run(run_id: str, run_attempt: str) -> str:
    """Derive the Sentry check_in_id for one observed run attempt, deterministically.

    The requested-phase and completed-phase reporters are two independent
    GitHub jobs with no shared state — nothing can be handed from one to the
    other — and Sentry closes an in_progress check-in ONLY when a later
    check-in arrives carrying the same check_in_id.  So both phases derive the
    id from the one thing they both observe: the triggering run.

    run_attempt is part of the key on purpose.  GitHub does not fire the
    `requested` activity type for a re-run, so on attempt >= 2 no in_progress
    check-in is ever opened; keying on the attempt gives that re-run a fresh
    id, so its terminal check-in stands alone instead of trying to close
    attempt 1's check-in, which Sentry already closed.
    """
    return uuid.uuid5(uuid.NAMESPACE_URL, f"sentry-ci-report/{APP}/run/{run_id}/attempt/{run_attempt}").hex


def build_monitor_config(workflow_name: str, cron_expr: str) -> dict:
    """The upsert monitor_config sent with BOTH the in_progress and terminal check-ins.

    Factored out so the two phases cannot drift apart: an in_progress check-in
    upserting a different schedule/margin than the terminal one would leave the
    monitor's config depending on which envelope Sentry saw last.
    """
    folded = workflow_name.casefold()
    monitor_config = {
        "schedule": {"type": "crontab", "value": cron_expr},
        "checkin_margin": _CHECKIN_MARGINS_FOLDED.get(folded, DEFAULT_CHECKIN_MARGIN),
        "max_runtime": _MAX_RUNTIMES_FOLDED.get(folded, DEFAULT_MAX_RUNTIME),
        "timezone": "UTC",
    }
    # FLEET-INFRA-CB (2026-09-08): only for workflows in
    # FLAP_DEBOUNCE_OVERRIDES -- require N consecutive FAILED check-ins
    # (Sentry counts error, missed and timeout check-ins alike toward
    # failure_issue_threshold) before opening/reopening the Sentry issue, and
    # one ok check-in to close it again, so a single slow-but-successful tick
    # can no longer flap the issue the way it did (count 322) under a tight
    # margin.  Consequence worth knowing on call: a single genuinely failed
    # ship tick (conclusion in ALERT_CONCLUSIONS, so status="error") no longer
    # opens or reopens this Crons issue by itself -- that failure still pages
    # immediately via the separate error-event path in main() section 2, which
    # is gated on ALERT_CONCLUSIONS and not on this threshold.  One false
    # max_runtime timeout is likewise absorbed; unlike a conclusion-based
    # failure a timeout has no error-event path of its own (see the
    # max_runtime block above), so two consecutive timeouts are needed before
    # this threshold surfaces one at all.  Every workflow NOT
    # listed keeps Sentry's own default (alert on the first miss) -- a blanket
    # threshold here would have meant CodeQL / Security / Shared package pin
    # check / Weekly Model Pricing Audit each needed to miss TWO consecutive
    # WEEKLY runs (~2 weeks) before anyone found out.
    flap_debounce = _FLAP_DEBOUNCE_FOLDED.get(folded)
    if flap_debounce:
        monitor_config.update(flap_debounce)
    return monitor_config


def resolve_cron_expr(
    workflow_name: str,
    envelope_url: str,
    auth_header: str,
    run_url: str,
    run_id: str,
) -> str | None:
    """Look up the mirrored cron expression for a scheduled workflow, or None.

    On a miss this both warns in the job log and raises the `unmapped-schedule`
    config-drift issue in Sentry, then returns None so the caller skips the
    check-in.  Shared by the requested and completed phases: duplicating it
    would let one phase send a check-in the other silently dropped.

    Lookup is case-folded — a workflow rename that only changes capitalisation
    must never again silently detach a job from its Crons monitor.
    """
    cron_expr = _CRON_SCHEDULES_FOLDED.get(workflow_name.casefold())
    if cron_expr:
        return cron_expr
    print(
        f"::warning::Schedule-triggered run for '{workflow_name}' has no known cron "
        "expression mapped in CRON_SCHEDULES; skipping check-in."
    )
    send_config_drift_event(
        envelope_url,
        auth_header,
        "unmapped-schedule",
        f"sentry-ci-report has no CRON_SCHEDULES entry for scheduled workflow "
        f"'{workflow_name}' [{APP}]",
        ["ci-report-config-drift", APP, "unmapped-schedule", workflow_name],
        {"workflow": workflow_name, "run_url": run_url, "run_id": run_id},
    )
    return None


def fetch_observed_run_status(run_id: str) -> str | None:
    """Ask the Actions API for the observed run's current status, or None.

    Exists for one race: GitHub's `sentry-ci-report-<run id>` concurrency
    group serializes the requested-phase and completed-phase reporter runs
    only when the requested-phase run is CREATED first, which is the normal
    case.  GitHub does not guarantee that order — for a very fast observed
    run, GitHub can create the completed-phase reporter run before the
    requested-phase one, so the terminal check-in would reach Sentry before
    the in_progress one it is meant to close.  Calling this before sending
    the in_progress check-in lets the requested phase notice that case
    (status == "completed") and skip its check-in entirely, so the
    completed phase's terminal check-in simply stands alone exactly as it
    did before this change, instead of an in_progress update landing after
    the check-in Sentry already closed.

    Fails open on any problem: returns None (never raises) when
    GITHUB_TOKEN, GITHUB_REPOSITORY, or run_id is empty, and on any
    exception while calling the API.  "Fail open" here means "behave as if
    this function did not exist" — the caller then sends the in_progress
    check-in as it always has.  That is safe because the worst case is
    exactly the pre-existing standalone terminal check-in PLUS a stray
    in_progress update Sentry receives after the fact, which is the same
    outcome this whole feature is meant to avoid, not a new failure mode.
    Never includes the token, the API URL, or exception text in output —
    only the exception's type name, to keep the job log free of anything
    sensitive.
    """
    token = os.environ.get("GITHUB_TOKEN", "").strip()
    repo = os.environ.get("GITHUB_REPOSITORY", "").strip()
    api_url = os.environ.get("GITHUB_API_URL", "https://api.github.com").strip() or "https://api.github.com"
    run_id = (run_id or "").strip()
    if not token or not repo or not run_id:
        return None

    req = urllib.request.Request(
        f"{api_url}/repos/{repo}/actions/runs/{run_id}",
        method="GET",
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "User-Agent": "sentry-ci-report",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        return data.get("status")
    except Exception as exc:  # noqa: BLE001 — fail open on ANY problem reading the observed run's status
        print(
            f"::warning::could not read the observed run's status ({type(exc).__name__}); "
            "sending the in_progress check-in anyway"
        )
        return None


def parse_dsn(dsn: str) -> tuple[str, str, str]:
    """Parse a Sentry DSN into (public_key, host, project_id). Raises ValueError
    without ever including the raw DSN in the message."""
    m = re.match(r"^https://([^@]+)@([^/]+)/(.+)$", dsn.strip())
    if not m:
        raise ValueError("SENTRY_FLEET_DSN is not in the expected https://<key>@<host>/<project> shape")
    return m.group(1), m.group(2), m.group(3)


def send_envelope(envelope_url: str, auth_header: str, item_type: str, item_payload: dict) -> None:
    item_body = json.dumps(item_payload).encode("utf-8")
    envelope_header = json.dumps({"sent_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}).encode("utf-8")
    item_header = json.dumps({"type": item_type, "length": len(item_body)}).encode("utf-8")
    body = envelope_header + b"\n" + item_header + b"\n" + item_body + b"\n"

    req = urllib.request.Request(
        envelope_url,
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/x-sentry-envelope",
            "X-Sentry-Auth": auth_header,
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            print(f"Sentry envelope POST ({item_type}) -> HTTP {resp.status}")
    except urllib.error.HTTPError as exc:
        # Never fail the reporter job over a Sentry-side hiccup; print details for debugging.
        detail = exc.read().decode("utf-8", errors="replace")[:500]
        print(f"::warning::Sentry envelope POST ({item_type}) failed: HTTP {exc.code}: {detail}")
    except urllib.error.URLError as exc:
        print(f"::warning::Sentry envelope POST ({item_type}) failed: {exc.reason}")
    except Exception as exc:  # noqa: BLE001 — fail open on ANY transient network error
        # Broad by design: a raw ConnectionResetError/OSError (e.g. the peer resets
        # the connection before returning any HTTP response) is NOT wrapped in
        # URLError, and must never red-X the observed workflow. Print only the
        # exception TYPE — never str(exc), which could echo the URL/auth header/DSN.
        print(f"::warning::Sentry envelope POST ({item_type}) failed: {type(exc).__name__}")


def send_config_drift_event(
    envelope_url: str,
    auth_header: str,
    kind: str,
    message: str,
    fingerprint: list[str],
    extra: dict,
) -> None:
    """Raise a Sentry issue about THIS reporter being misconfigured.

    Config drift used to surface only as a ::warning:: inside a job whose logs
    are never opened, which is how a dead cron monitor went unnoticed for
    months.  Fingerprints are bounded by workflow count (not branch count), so
    this cannot repeat the issue-explosion the branch fingerprint caused.
    """
    payload = {
        "event_id": uuid.uuid4().hex,
        "timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "platform": "other",
        "level": "warning",
        "environment": "fleet-ci",
        "message": message,
        "tags": {"app": APP, "drift": kind},
        "extra": extra,
        "fingerprint": fingerprint,
    }
    send_envelope(envelope_url, auth_header, "event", payload)


def main() -> int:
    dsn = os.environ.get("SENTRY_FLEET_DSN", "").strip()
    workflow_name = os.environ.get("WORKFLOW_NAME", "unknown")
    conclusion = os.environ.get("WORKFLOW_CONCLUSION", "unknown")
    event = os.environ.get("WORKFLOW_EVENT", "unknown")
    branch = os.environ.get("WORKFLOW_BRANCH", "unknown")
    actor = os.environ.get("WORKFLOW_ACTOR", "unknown")
    run_url = os.environ.get("WORKFLOW_RUN_URL", "")
    run_id = os.environ.get("WORKFLOW_RUN_ID", "")
    # github.event.action for the workflow_run event: "requested" (the run was
    # just created — no runner assigned yet, conclusion still null) or
    # "completed".  Defaults to "completed" so any caller that predates the
    # requested listener, or that simply does not set this, behaves exactly as
    # this script did before 2026-09-08.  Anything that is not literally
    # "requested" takes the completed path.
    run_action = os.environ.get("WORKFLOW_RUN_ACTION", "completed").strip() or "completed"
    # Attempt number of the observed run; part of the deterministic
    # check_in_id.  "1" for a first run, "2"+ for a re-run.
    run_attempt = os.environ.get("WORKFLOW_RUN_ATTEMPT", "1").strip() or "1"

    if not dsn:
        print("::warning::SENTRY_FLEET_DSN secret is not set; skipping Sentry report for this run.")
        return 0

    try:
        public_key, host, project_id = parse_dsn(dsn)
    except ValueError as exc:
        # Fail-safe: a malformed (but present) DSN is an operator/config problem, not a
        # real CI failure. Surface it loudly as an error annotation, but exit 0 so this
        # additive reporter never red-Xes the observed workflow's Actions history over an
        # observability misconfig — the same "never break CI" invariant the empty-DSN
        # branch above honors. (parse_dsn never puts the raw DSN in the message.)
        print(f"::error::{exc}")
        return 0

    envelope_url = f"https://{host}/api/{project_id}/envelope/"
    auth_header = (
        f"Sentry sentry_version=7, sentry_client=sentry-ci-report/1.0, sentry_key={public_key}"
    )

    # ── 0. Config-drift guard for CRON_SCHEDULES ────────────────────────────
    stale_keys = find_cron_schedule_drift(discover_workflow_names())
    if stale_keys:
        joined = ", ".join(repr(key) for key in stale_keys)
        print(
            f"::error::CRON_SCHEDULES key(s) {joined} match no workflow `name:` under "
            ".github/workflows/ — those cron check-ins are not being sent. "
            "Re-key CRON_SCHEDULES in scripts/sentry-ci-report.py to the current name."
        )
        send_config_drift_event(
            envelope_url,
            auth_header,
            "stale-cron-key",
            f"sentry-ci-report CRON_SCHEDULES has stale workflow name(s): {joined} [{APP}]",
            ["ci-report-config-drift", APP, "stale-cron-key"],
            {"stale_keys": stale_keys, "run_url": run_url},
        )

    # ── 1. Requested phase: open the in_progress check-in ───────────────────
    # This runs for schedule-triggered runs only.  It sends no failure event:
    # at request time github.event.workflow_run.conclusion is null, so there is
    # nothing yet to alert on.
    if run_action == "requested":
        if event != "schedule":
            print(
                f"Workflow '{workflow_name}' was requested by '{event}' (not schedule); "
                "no in_progress check-in sent."
            )
            return 0

        cron_expr = resolve_cron_expr(workflow_name, envelope_url, auth_header, run_url, run_id)
        if not cron_expr:
            return 0

        if not run_id:
            # Without the run id the two phases cannot agree on a
            # check_in_id, so this in_progress check-in could never be closed
            # by the completed phase — it would sit open until max_runtime and
            # then fire a timeout alert for a run that was perfectly healthy.
            # Staying silent here is strictly safer: the completed listener
            # still sends its own standalone terminal check-in (with a random
            # id), which is exactly the behavior this reporter had before the
            # requested phase existed.
            print(
                "::warning::Requested-phase check-in skipped for "
                f"'{workflow_name}': WORKFLOW_RUN_ID is empty, so the completed phase could "
                "not close this check-in and it would time out into a false alert. "
                "The completed phase will still send a standalone terminal check-in."
            )
            return 0

        observed_status = fetch_observed_run_status(run_id)
        if observed_status == "completed":
            print(
                f"Observed run {run_id} already completed before this requested-phase job ran; "
                "skipping the in_progress check-in so the completed phase's terminal check-in "
                "stands alone."
            )
            return 0

        monitor_slug = f"ci-{APP}-{slugify(workflow_name)}"
        check_in_id = checkin_id_for_run(run_id, run_attempt)
        send_envelope(
            envelope_url,
            auth_header,
            "check_in",
            {
                "check_in_id": check_in_id,
                "monitor_slug": monitor_slug,
                "status": "in_progress",
                "monitor_config": build_monitor_config(workflow_name, cron_expr),
            },
        )
        print(
            f"Sent Sentry Crons check-in 'in_progress' for monitor '{monitor_slug}' "
            f"(workflow '{workflow_name}', run {run_id} attempt {run_attempt}, "
            f"check_in_id {check_in_id})."
        )
        return 0

    # ── 2. Failure event ────────────────────────────────────────────────────
    pageworthy_branch = branch == "main" or branch.startswith("gh-readonly-queue/")
    if conclusion in ALERT_CONCLUSIONS and not pageworthy_branch:
        print(f"skip: branch {branch} failure not paged to Sentry (PR checks cover it)")
    elif conclusion in ALERT_CONCLUSIONS:
        event_payload = {
            "event_id": uuid.uuid4().hex,
            "timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "platform": "other",
            "level": "error",
            "environment": "fleet-ci",
            "message": f"CI workflow {conclusion}: {workflow_name} [{APP}]",
            # Branch/actor stay as TAGS (searchable, per-event) but must never
            # enter the fingerprint — see the module docstring.
            "tags": {"app": APP, "workflow": workflow_name, "branch": branch, "actor": actor},
            "extra": {"run_url": run_url, "run_id": run_id, "branch": branch},
            "fingerprint": ["ci-failure", APP, workflow_name],
        }
        send_envelope(envelope_url, auth_header, "event", event_payload)
        print(f"Sent Sentry {conclusion} event for workflow '{workflow_name}' on branch '{branch}'.")
    else:
        print(f"Workflow '{workflow_name}' concluded '{conclusion}' (no alert); no error event sent.")

    # ── 3. Terminal cron check-in (only for schedule-triggered runs) ────────
    if event == "schedule":
        cron_expr = resolve_cron_expr(workflow_name, envelope_url, auth_header, run_url, run_id)
        if cron_expr:
            # This monitor answers "did this cron fire", NOT "did the job
            # succeed with the exact conclusion 'success'".  So the terminal
            # status is keyed on the same ALERT_CONCLUSIONS set the error-event
            # path uses, which keeps the two signals from contradicting each
            # other: 'cancelled' / 'skipped' / 'neutral' / 'stale' /
            # 'action_required' are normally intentional, they deliberately
            # raise no Sentry error event, and they must not mint a Crons
            # failure with no explanatory event beside it either.  That is not
            # hypothetical here -- ios-ship.yml runs `13,43 * * * *` under
            # `concurrency: {group: ios-ship-usage, cancel-in-progress: false}`,
            # whose queue holds only one pending run, so any overrun past 30
            # minutes gets the queued tick cancelled as a matter of routine.
            # The check-in is still sent for EVERY conclusion, never skipped:
            # skipping it would leave the requested phase's in_progress
            # check-in open until max_runtime and turn a benign cancellation
            # into a false TIMEOUT.
            checkin_status = "error" if conclusion in ALERT_CONCLUSIONS else "ok"
            monitor_slug = f"ci-{APP}-{slugify(workflow_name)}"
            # Same deterministic id the requested phase used, which is what
            # CLOSES that in_progress check-in.  The uuid4 fallback is legacy:
            # with no run id the two phases cannot correlate, so this becomes a
            # standalone terminal check-in — exactly the pre-2026-09-08
            # behavior.
            check_in_id = checkin_id_for_run(run_id, run_attempt) if run_id else uuid.uuid4().hex
            checkin_payload = {
                "check_in_id": check_in_id,
                "monitor_slug": monitor_slug,
                "status": checkin_status,
                # Sentry's spec says monitor_config SHOULD only be sent on the
                # first check-in of a pair.  It is sent on both here anyway,
                # because the terminal check-in may be the ONLY one Sentry ever
                # sees for a run — the requested-phase reporter can be missed,
                # cancelled, or skipped entirely (GitHub never fires
                # `requested` for a re-run) — and a monitor that was never
                # upserted has no schedule at all.  The upsert is idempotent,
                # and build_monitor_config() guarantees both phases send byte
                # -identical config.
                "monitor_config": build_monitor_config(workflow_name, cron_expr),
            }
            send_envelope(envelope_url, auth_header, "check_in", checkin_payload)
            print(
                f"Sent Sentry Crons check-in '{checkin_status}' for monitor '{monitor_slug}' "
                f"(workflow '{workflow_name}', check_in_id {check_in_id})."
            )
    else:
        print(f"Workflow '{workflow_name}' was triggered by '{event}' (not schedule); no cron check-in sent.")

    return 0


if __name__ == "__main__":
    sys.exit(main())
