# 2026-07-08 — npm `allowScripts` approval (deterministic native builds on npm 11)

## Summary

Added an `allowScripts` block to `package.json` approving the 7 packages that ship install
scripts — `@sentry/cli`, `better-sqlite3`, `fsevents` (x2), `sharp`, `esbuild`, `unrs-resolver` —
via `npm approve-scripts` against the current lockfile versions.

## Why

**Correction (per Codex review of PR #1166):** the `allowScripts` field / `npm approve-scripts` on
npm 11 is a *transitional, advisory* feature — npm 11 still **runs** install scripts by default and
only warns about unreviewed ones; the default does not flip to *blocking* unreviewed scripts until a
future npm major. So npm 11's default gating is **not** what skipped `better-sqlite3`'s build, and this
`package.json` block is not what "turns scripts back on" under stock npm 11.

The 2026-07-06 production incident's actual cause was fragile **host `~/.npmrc` state**: the box's
install config skipped install scripts (e.g. an `ignore-scripts` / `allow-scripts` setting), so
`better-sqlite3`'s `node-gyp rebuild` never ran, the native binding was never built, and the app
crash-looped on a missing `better-sqlite3` native `.node`. That was worked around by hand-editing the
host `~/.npmrc`, which was itself fragile — a stray `allow-scripts` line there triggered `EALLOWSCRIPTS`
and broke `npm ci` entirely.

Declaring the approvals **in `package.json`** is still worthwhile for two reasons: (1) it removes the
dependency on ad-hoc host `~/.npmrc` state, keeping the approvals in-repo and portable across every
install path (CI, Coolify, a fresh clone); and (2) it **pre-approves** these packages so that when
npm's default does flip to blocking unreviewed scripts, native builds keep working with no further
change. It does **not**, on its own, guarantee determinism if the host still forces `ignore-scripts` or
carries a malformed `allow-scripts` line — that host hygiene remains a separate requirement.

## Files

- `package.json` — new `allowScripts` block (7 entries). No dependency changes; no `package-lock.json`
  change.

## Deliberately NOT included

This was extracted from a larger uncommitted change sitting in the integration worktree
(`~/Code/Socratic-Trade`) that also (a) added `@sentry/cloudflare` and (b) regenerated the entire
lockfile (~7.7k lines). Both were dropped:
- `@sentry/cloudflare` is the Sentry SDK for the **Cloudflare Workers** runtime — dead weight in this
  Next.js/Coolify **server** app (imported nowhere; Sentry here is already handled by `@sentry/nextjs`).
  It belongs in **Congress.Trade** (the actual Worker), not here.
- The lockfile regeneration was a drifted npm-version artifact (e.g. `esbuild` 0.23.1→0.28.1), unrelated
  to the `allowScripts` fix and not carried here.

## Verification

- `npm approve-scripts <pkgs>` → 7 approved; `npm approve-scripts --allow-scripts-pending` → "No
  packages with unreviewed install scripts."
- `npm ci` clean with the block; `better-sqlite3` native `.node` builds.
- verify gate (tsc / test / build) via `land.sh`.

## Follow-ups

- If Congress.Trade wants Sentry-on-Workers, add `@sentry/cloudflare` **there**.
