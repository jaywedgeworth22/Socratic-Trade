# 2026-08-23 Cursor full-stack review (filing)

## Context and goal

Owner asked for a top-to-bottom pass of Socratic-Trade (desktop web, mobile web, iOS, backend pipeline, RAG/embeddings/ingest, recent trades, broker, errors, connections).  File every improvement on the Mac board, effort log, and GitHub.  Coordinate on Slack.  This rollout is filing-only.

## What changed

- Added `docs/reviews/2026-08-23-cursor-full-stack-review.md`.
- Prepended this effort on live `~/apps/TRADING-EFFORT-LOG.md` and `docs/EFFORT-LOG.md`.
- Board: 12 findings (`d4cb5e75` … `6e10da30`).
- GitHub: #3056–#3067.

No product code in this PR.

## Decisions

- Did not re-file 2026-08-20 DeepSeek items still open on the board.
- Did not implement the P0s in this session (owner asked to find and file).
- pm2 `shellular` shows errored because a live PID already holds the lock.  Did not kill it.

## Verification

- `curl -sS https://socratictrade.com/api/health`
- Sentry unresolved, freq, 7d
- `board file` x12, `gh issue create` x12
- Code grep on `stop_market`, budget throw, `slice(0, 500)`, `uniqueKeysWithValues`

## Next

Implement #3056 then #3057 then #3058.  Separate `cursor/` lanes.  Do not HOTFIX in RTH.
