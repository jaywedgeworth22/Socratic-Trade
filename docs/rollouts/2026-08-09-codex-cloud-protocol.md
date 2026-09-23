# Codex Cloud protocol bootstrap (Socratic-Trade)

## Summary

Added repo-local Codex Cloud setup and maintenance hooks for the shared fleet protocols.

## Runtime environment contract

These must be configured as regular runtime environment variables when the agent phase needs them:

- `SLACK_BOT_TOKEN`
- `GH_TOKEN`

Optional coordination variables:

- `SLACK_CHANNEL_ID=C0BEZDJDNKV`
- `SLACK_PROJECT=Socratic-Trade`
- `SLACK_AGENT_NAME=Codex`
- `AGENT_SYNC_TOKEN`

Secret-category variables are available only during setup and are removed before the agent phase. Setup scripts therefore validate presence but do not persist secrets into dotfiles.

## Protocol coverage

- Slack: `scripts/codex-coordination.sh read|post|test`
- Effort logs: `AGENTS.md` and `docs/EFFORT-LOG.md`
- GitHub: setup validates API, issue, and PR access through `gh`
- Apple Notes: Mac-only; cloud agents must include a completion-note handoff body for local publication

## Verification

Run:

```bash
bash .codex/setup.sh
bash .codex/maintenance.sh
```

