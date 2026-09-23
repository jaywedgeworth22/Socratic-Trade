# 2026-07-05 — Logo concept exploration (12 marks)

## Update 3 — final selection: Dialectic + named lockup (same day)

- Owner narrowed the shortlist to **Dialectic only**, saved in two forms:
  the standalone mark (`dialectic.svg`, v2 tails) and a new
  **`dialectic-lockup.svg`** — the mark with `Socratic-Trade` set beside it
  (serif, emerald period, viewBox 292×64), added as a new
  `<symbol id="dialectic-lockup">` in the showcase.
- Showcase updated: Dialectic first with a "Selected" badge; Examined
  Trade/Stoa unbadged (archive); lockups section replaced by "The saved
  lockup" showing `dialectic-lockup` on both grounds; closing note records
  the selection. `logo-ideas.md` shortlist section replaced by
  "Selected mark (2026-07-05): Dialectic".
- Touched: `docs/branding/logo-ideas.html`, `docs/branding/logo-ideas.md`,
  `docs/branding/logo-ideas/dialectic-lockup.svg` (new),
  `STATUS.md`, this note. (Extraction script now writes 13 SVGs.)
- Verification: extraction re-run (13 files); full-page headless-Chromium
  screenshot re-checked (Selected badge, lockup rendering on both grounds).
  Docs/assets-only on an already-verified tree; the lockup keeps live serif
  text — outline to paths when cutting final exports.

## Update 2 — owner shortlist + Dialectic v2 (same day)

- Owner reviewed the twelve and shortlisted **The Examined Trade**,
  **Dialectic**, and **The Stoa** ("save those ideas").
- Owner feedback on Dialectic: "the triangular part of the chat bubbles looks
  odd or needs refinement" → **v2 redraw**: both speech-bubble tails are now
  integrated into each bubble's single outline path (outline bubble:
  `...H17l-7 8 3-8...`; filled bubble mirrored) instead of the previous
  separate stroke/triangle tail shapes. Standalone `dialectic.svg`
  regenerated; re-verified via headless-Chromium screenshot on both grounds.
- Showcase updated: shortlist cards moved to the top with a "Shortlist"
  badge + accent border, lockups now feature the three shortlisted marks,
  closing note records the owner decision (old studio recommendation kept
  for the record). `docs/branding/logo-ideas.md` gained an
  "Owner shortlist (2026-07-05)" section.
- Touched: `docs/branding/logo-ideas.html`, `docs/branding/logo-ideas.md`,
  `docs/branding/logo-ideas/dialectic.svg`, `STATUS.md`, this note.
- Verification: SVG extraction re-run (12 files); showcase screenshot
  re-checked (shortlist badges, reordering, Dialectic v2 tails); docs-only
  change on top of the already-verified tree (tsc/test/build unchanged from
  Update 1 — no code touched).

## Summary

First brand exploration for Socratic-Trade: twelve logo concepts crossing the
Socratic half of the name (question, dialogue, examination, Greek antiquity)
with the trading half (candlesticks, trend lines, delta). Delivered as:

- `docs/branding/logo-ideas.html` — self-contained, theme-aware showcase page
  (each mark previewed on light AND dark chips with a favicon-scale copy,
  plus two lockups and a studio recommendation). This file is the source of
  truth: every mark is an SVG `<symbol>`.
- `docs/branding/logo-ideas/*.svg` — 12 standalone SVGs extracted from those
  symbols (`inquiry`, `phi`, `examined`, `meander`, `dialectic`, `stoa`,
  `noctua`, `delta`, `laurel`, `serpentine`, `torch`, `wordmark`).
- `docs/branding/logo-ideas.md` — concept index, shared design rules, and the
  regeneration one-liner.

## Why / decisions

- User request ("make numerous logo ideas for this app") on branch
  `claude/logo-ideas-c5n61b`.
- All marks share one discipline: single ink color (`currentColor`) + the
  dashboard's existing emerald accent `#0e9f6e`, so any pick drops into the
  current UI tokens without a new palette. Rose `#e11d48` appears only in
  The Examined Trade (a red candle under the lens — deliberate).
- Recommendation recorded in the doc: **Phi** for app icon/favicon,
  **The Inquiry** for storytelling surfaces, **The Examined Trade** for
  reports.
- `PLAN.md` intentionally NOT changed: this is a design side-deliverable, no
  scope/timeline/approach change to the phased roadmap.

## Files

- `docs/branding/logo-ideas.html` (new)
- `docs/branding/logo-ideas.md` (new)
- `docs/branding/logo-ideas/{inquiry,phi,examined,meander,dialectic,stoa,noctua,delta,laurel,serpentine,torch,wordmark}.svg` (new, generated)
- `STATUS.md` (Active Focus entry)
- `docs/rollouts/2026-07-05-logo-ideas.md` (this note)

## Verification

- Rendered the showcase with headless Chromium
  (`/opt/pw-browsers/chromium --headless --screenshot ...`) and visually
  verified all 12 marks + lockups on both light and dark chips at full and
  favicon scale.
- Extraction script run; 12 SVGs written and listed.
- `npx tsc --noEmit` — clean.
- `npm test` — 776 passed / 1 failed (777, 86 files). The single failure is
  the KNOWN pre-existing date-sensitive `test/cache-provenance.test.ts`
  cross-user-leak assertion (documented in STATUS.md since 2026-06-21);
  unrelated — this change touches no `src/`, `app/`, or `test/` files.
- `npm run build` — green (full Next.js production build).
- (Cloud VM: fresh `npm install` first — no `node_modules` in a fresh clone.
  Incidental `package-lock.json` libc-field churn from older npm was reverted,
  not committed.)

## Branch-base correction (post-PR)

- The session branch `claude/logo-ideas-c5n61b` was cut from the unmerged
  `agent/claude-fix-dashboard-quickwins` tip (`57922ee`, dashboard quick-wins),
  not from `origin/main` — so PR #809's diff accidentally included that lane's
  code (`app/dashboard-client.tsx`, `src/lib/events.ts`,
  `src/lib/learned-context/store.ts`), which Codex review flagged.
- Fixed non-destructively with `git revert 57922ee` on this branch (no
  force-push, per repo rules). The PR diff vs `main` is now docs/assets-only
  again; the repo's `--squash` merge convention means `main` receives exactly
  the docs change. The quick-wins work is untouched on its own branch
  `agent/claude-fix-dashboard-quickwins` and should land via its own PR —
  including Codex's P1 finding there (Strategy Studio apply path can merge
  `strategyAuthority: "decide"` via `updatePolicy` without the decide-mode
  confirmation gate), which belongs to that lane, not this one.

## Follow-ups

- Owner to pick a direction (or ask for iterations on a shortlist); then cut
  proper exports (app icon sizes, favicon.ico, OG image) and wire into
  `app/layout.tsx` metadata.
- The wordmark SVG uses a serif font stack (`Iowan Old Style → Palatino →
  Georgia`), so its exact rendering is platform-dependent; a chosen final
  wordmark should be converted to outlined paths.
