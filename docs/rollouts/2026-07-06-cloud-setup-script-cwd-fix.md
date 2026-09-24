# 2026-07-06 — Claude Code Cloud "Setup script" cwd fix

## Summary
Corrected the documented Claude Code Cloud "Setup script" value from a bare
`bash scripts/cloud-setup.sh` to `cd Socratic-Trade && bash
scripts/cloud-setup.sh`. Updated the header comment in
`scripts/cloud-setup.sh` and the instructions in `docs/slack-coordination.md`
accordingly. No application code changed.

## Why
The owner repeatedly hit a Claude Code Cloud environment failure creating
brand-new environments for this repo:

```
Setup script failed with exit code 127.
Script output:
bash: scripts/cloud-setup.sh: No such file or directory
```

This reproduced across multiple fresh environments with: the exact documented
Setup script value, correct env vars (SLACK_TOPIC, GCP_PROJECT_ID [legacy,
unused — GCP Secret Manager path was removed by PR #165], NODE_AUTH_TOKEN,
SLACK_BOT_TOKEN, SLACK_AGENT_NAME, SLACK_CHANNEL_ID, CLOUDFLARE_API_TOKEN),
`main` as the base branch, and "Full" network access. Ruled out along the way:
the script's existence/path/executable bit (present on `main` since old PR
#102), `.gitignore`/git-lfs/submodule issues (none), `.devcontainer/
devcontainer.json` (already correct — uses the same command and it works
there), and stale/cached session state (reproduced with an entirely new
environment + new session each time).

Root cause, found via a diagnostic Setup script probe
(`pwd && ls -la && ls -la scripts`):

```
/home/user
total 12
drwxr-xr-x  3 root root 4096 Jul  6 05:00 .
drwxr-xr-x  5 root root 4096 Jul  6 05:00 ..
drwxr-xr-x 15 root root 4096 Jul  6 05:00 ***SLACK_TOPIC***
ls: cannot access 'scripts': No such file or directory
```

The container's working directory when the Setup script runs is `/home/user`
— the **parent** of the cloned repo — not the repo root. `git clone` creates a
`Socratic-Trade/` subdirectory one level below that (standard `git clone`
behavior: the target directory matches the repo name), so the documented bare
`bash scripts/cloud-setup.sh` command never resolved a `scripts/` folder at
that cwd.

A red herring along the way: the `***SLACK_TOPIC***` entry in the `ls -la`
output is not a literal directory name — it's the environment's own
secret-redaction filter. The `SLACK_TOPIC` env var's value is literally the
string `Socratic-Trade`, which coincidentally matches the actual clone
directory name, so the output panel masked every occurrence of that string,
including the directory listing. The clone itself succeeded the entire time;
only the cwd assumption was wrong.

## Files
- `scripts/cloud-setup.sh` — header comment now explains the Claude Code Cloud
  cwd behavior and gives the corrected Setup script value.
- `docs/slack-coordination.md` — cloud setup instructions updated to the same
  corrected value, with a pointer back to the script's header comment.
- `STATUS.md` — dated entry summarizing the investigation and fix.
- `docs/EFFORT-LOG.md` / `/Users/jay/apps/TRADING-EFFORT-LOG.md` — In Progress
  row added.

## Verification
- `npx tsc --noEmit`
- `npm test`
- `npm run build`
(doc/comment-only change; run as the repo's standard pre-land gate, not
because logic changed)

## Follow-ups
- **Monet's cloud environment likely needs the same fix.** Per the PR #798
  record in `docs/EFFORT-LOG.md`, Monet's environment was configured with the
  bare `bash scripts/cloud-setup.sh` value — the same value that just failed
  repeatedly here. Flagged in `#agent-sync` (CLAUDE→FLEET, tagging MONET)
  with the corrected value; Monet (or the owner on Monet's behalf) needs to
  open its own "Update cloud environment" dialog and change the Setup script
  field to `cd Socratic-Trade && bash scripts/cloud-setup.sh`. This cannot be
  fixed from this session — it's a per-account cloud environment setting, not
  repo state.
- Codex/Antigravity cloud environments for this repo (if any exist) should be
  checked/updated the same way.
- No code path was affected; this is docs/comments only.
