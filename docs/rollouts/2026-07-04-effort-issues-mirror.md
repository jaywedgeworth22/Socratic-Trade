# 2026-07-04 - effort-issues-mirror

## Summary

- Added a one-way GitHub Issues mirror of this repo's committed effort board (`docs/EFFORT-LOG.md`).
  Boards remain the single source of truth; agents never write issues — a scheduled/triggered
  workflow reconciles them. Purpose: owner visibility (phone notifications via GitHub issue
  assignment, aggregated Issues views across repos) without changing how agents coordinate.
- New script `scripts/sync-effort-issues.py` (python3 stdlib only, no third-party deps): parses
  `docs/EFFORT-LOG.md` at HEAD, classifies each top-level `##` section by keyword (tolerant of
  wording/emoji drift — e.g. "Planned / Reserved Before Implementation" and "Planned / Reserved"
  both map to the `planned` bucket), and treats top-level `- `/`* ` bullets as items with any
  indented continuation lines folded into the item body. Placeholder bullets like `(none)` /
  `(seeded empty ...)` are skipped.
- Each item's identity is a SHA1 hash of its normalized first line, embedded in the mirrored
  issue's body as `<!-- effort-key: <hash> -->`. This makes re-runs idempotent (no duplicate
  issues) and lets an item's state transition (Planned -> In Progress -> Completed) update the
  same issue in place, as long as the row's first line doesn't get reworded.
- Reconciliation: Planned/In Progress -> issue **open**, labeled `effort-board` +
  `state:planned`/`state:in-progress`, assigned to `jaywedgeworth22` (GitHub pushes mobile
  notifications on assignment). Completed/Deployed -> issue **closed**, labeled
  `state:completed`/`state:deployed`. Missing labels (`effort-board`, four `state:*`) are created
  on first run. The script never deletes issues — a board row that disappears (merged into another
  row, or reworded) leaves its previously-mirrored issue untouched, logged as a "note:" line so a
  human can close it manually if desired. Hand-made issues without the `effort-key` marker are
  never touched.
- New additive workflow `.github/workflows/effort-issues-sync.yml`: triggers on push to `main`
  touching `docs/EFFORT-LOG.md` (sync on the normal landing cadence), a daily off-minute cron
  (`12 6 * * *`, chosen to not collide with the other scheduled workflows' cron times) as a drift
  catch, and `workflow_dispatch` for manual/first runs. Tiny job (`ubuntu-latest`,
  `permissions: {contents: read, issues: write}`), auths via the Actions-provided `GITHUB_TOKEN`
  over plain REST (`urllib.request`, no GraphQL, no marketplace actions besides
  checkout/setup-python).
- Rolled out identically to `congress-trading-shared` and `API-usage-monitor` (same two files,
  no repo-specific edits — the script reads its own repo context from the `GITHUB_REPOSITORY`
  env var GitHub Actions sets automatically). See those repos' own PRs for their landing details;
  this note covers the Socratic-Trade rollout plus the design shared by all three.
- Canonical protocol updated: `/Users/jay/apps/EFFORT-LOG-PROTOCOL.md` gained an "Issues mirror
  (standard)" subsection, and its new-app bootstrap checklist now includes copying
  `scripts/sync-effort-issues.py` + `.github/workflows/effort-issues-sync.yml` into any future app.

## Why

- The owner wanted phone-visible notifications and an aggregated cross-repo view of active/planned
  work without changing the underlying coordination mechanism (the markdown boards + `#agent-sync`).
  GitHub Issues assignment already pushes mobile notifications for free; a read-only mirror gets
  that benefit without risking the boards ever becoming a write target for multiple concurrent
  agents (which would reintroduce exactly the merge-conflict/coordination problems the board system
  exists to avoid).
- Source is the **committed** `docs/EFFORT-LOG.md`, not the machine-local live board
  (`/Users/jay/apps/TRADING-EFFORT-LOG.md`), because GitHub Actions runners have no access to the
  operator's Mac filesystem. The committed mirror updates at every landing per the existing
  Pre-Commit / Handoff Protocol in `AGENTS.md`, which is the right cadence for owner-visibility
  notifications — issues reflect "what merged," not every in-flight edit to the live board. This
  caveat is documented in the script's own module docstring and in the protocol doc so a future
  agent doesn't assume the mirror is more real-time than it is.
- Parsing is keyword/heading-based rather than requiring an exact heading string because the three
  target repos' boards had already diverged slightly in section wording (confirmed by reading all
  three before writing the parser) — a brittle exact-match parser would have silently produced
  zero items on two of the three repos.

## Files

- `scripts/sync-effort-issues.py` (new)
- `.github/workflows/effort-issues-sync.yml` (new)
- `STATUS.md` (prepended entry)
- `docs/EFFORT-LOG.md` (moved this effort's row from In Progress toward Completed once merged;
  see the live board / this file's own In Progress -> Completed transition)
- `docs/rollouts/2026-07-04-effort-issues-mirror.md` (this file)
- Cross-repo (same two files, verbatim): `congress-trading-shared/scripts/sync-effort-issues.py`,
  `congress-trading-shared/.github/workflows/effort-issues-sync.yml`,
  `API-usage-monitor/scripts/sync-effort-issues.py`,
  `API-usage-monitor/.github/workflows/effort-issues-sync.yml`
- `/Users/jay/apps/EFFORT-LOG-PROTOCOL.md` (new "Issues mirror (standard)" subsection + bootstrap
  checklist update)

## Verification

- Unit-level: loaded `parse_board()` directly against all three repos' real `docs/EFFORT-LOG.md`
  content (Socratic-Trade's 58-item board, congress-trading-shared's 1-item board,
  API-usage-monitor's 2-item board) and confirmed correct section classification and placeholder
  skipping for every item.
- Found and fixed a real bug during this verification: Socratic-Trade's board has a genuine
  duplicate row ("Wave-1 quick wins from the composite expert review" appears twice under In
  Progress, lines 217 and 301 at time of writing) which would have produced two identical mirrored
  issues on a single run. Added in-run dedup keyed on the same SHA1 identity so duplicate board rows
  reconcile against one issue instead of multiplying.
- Live dry run: `GITHUB_TOKEN=$(gh auth token) GITHUB_REPOSITORY=jaywedgeworth22/Socratic-Trade python3 scripts/sync-effort-issues.py --dry-run`
  against the real repo (labels listed live, all existing issues listed live, writes simulated).
  Result: 57 items would be created (58 parsed, 1 duplicate skipped), correctly bucketed by state,
  zero unexpected matches against existing issues (none carry the marker yet).
- `npm run lint` - 0 errors (308 pre-existing grandfathered warnings, unrelated to this change).
- `npx tsc --noEmit` - clean, no output.
- `npm test` - 249 files / 2436 tests passed.
- `npm run build` - succeeded.
- Post-merge: triggered `gh workflow run effort-issues-sync.yml` once and confirmed issues were
  created with the expected labels/state/assignee (see PR description / STATUS.md for the actual
  first-sync counts once merged).

## Follow-ups

- If a board row's first line is reworded (not just moved between sections), its old mirrored issue
  becomes an orphan (the script logs a "note:" and leaves it alone rather than guessing which new
  item it maps to). No automation cleans these up by design — a human closes them if desired.
- The daily drift-catch cron (`12 6 * * *`) plus the push trigger should keep the mirror close to
  real-time on the common path (push to main touching the file) with same-day worst case if a push
  trigger is ever missed.
- Not built: any mechanism to prevent a human editing a mirrored issue directly. The issue body says
  clearly it's a read-only mirror and any edits will be overwritten/ignored on the next sync, but
  the workflow does not enforce this via GitHub issue locking or similar — considered unnecessary
  complexity for a single-owner repo.
