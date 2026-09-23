# 2026-07-05 — Logo concept exploration (docs-only)

## Summary

Owner asked for a number of logo ideas for **Socratic Trade** (some as
**Socratic-Trade**), with emphasis on options that aren't busy and where the
words are clear and fill most of the logo, plus some free-form directions.

Added `docs/branding/` with ten concept comps:

**Wordmark-led** (the name is the logo)
- **A · Full Stop** — `Socratic-Trade`: bold "Socratic" / light "Trade" split
  by a green geometric dot; the domain itself as the mark.
- **B · Inscription** — wide-tracked serif capitals, classical read without
  Greek-column clichés; small green "TRADE" under a hairline rule.
- **C · Dialogue** — two staggered italic serif lines set like printed Plato:
  green quotation dash, reply line, green full stop.
- **D · Trendline** — letterspaced caps over one thin rising line ending in a
  price dot (quiet descendant of the current favicon).
- **E · Delta** — stacked caps; the A of TRADE is a green delta.

**Mark-led** (symbol survives alone at favicon size)
- **F · Open Question** — question mark whose dot is a green candlestick.
- **G · Sigma** — one stroke that is a sigma, an S, and a zigzag price path.
- **H · Argument** — speech bubble holding a rising chart line.
- **I · Monogram** — serif `S.T` with the green period; small caps beneath.
- **J · Continuity** — the existing `public/icon.svg` unchanged, given a
  proper wordmark lockup.

## Round 2 (same day) — refined from the owner's Adobe Firefly comps

Owner shared four Firefly-generated images (letters built from candlesticks,
an owl perched on a scroll, circular chart-backdrop compositions, market
red/green) and asked for a better, more professional version. Kept the motifs,
cut the noise — each Round-2 concept uses the candlestick exactly once:

- **K · The Owl** — owl built from exactly two candlesticks (wicks = ear
  tufts/feet, bodies = face, amber beak) + stacked wordmark. Suggested primary.
- **L · The Seal** — circular seal, SOCRATIC/TRADE on curved arcs, owl center.
- **M · The Candle-I** — bold caps wordmark; the I of SOCRATIC is one green
  candle. The disciplined letters-as-candles.
- **N · The Cluster** — three candles up/down/up rising left→right; the only
  concept keeping the Firefly red (`#c22f4e` light / `#e0607a` dark).

Files added: `docs/branding/logo-concepts/{k-owl,l-owl-seal,m-candle-i,n-cluster}.svg`;
`logo-concepts.html` board updated with a Round 2 section (theme-aware owl eye
knockouts via a `--tbg` tile variable). Verification: same headless-Chromium
screenshot pass (owl variants iterated once — bubble-style beak/eye geometry
tuned; seal bottom-arc text switched from a clipped tagline to TRADE).

## Round 3 (same day) — combined shortlist + Firefly light/dark assets

Owner asked to save Inscription (B), Delta (E), Argument (H), and Monogram (I),
combine them with the three picks from the parallel logo session (branch
`claude/logo-ideas-c5n61b`, commit `a9c275a`: The Examined Trade, Dialectic v2,
The Stoa), add the four Adobe Firefly comps, and produce light + dark versions
of the Firefly images.

- New `docs/branding/shortlist.html` — single combined board (4 kept concepts +
  3 other-session marks + 4 Firefly images, each on light and dark tiles;
  Firefly images embedded as data URIs so the file is self-contained).
- New `docs/branding/firefly/` — background-removed transparent PNGs (white
  page removed from the two owl badges; baked-in transparency checkerboard
  removed from the candle-letters image, including inside closed letter
  counters via a two-pass edge-connected + interior-patch flood fill in
  Pillow/numpy), plus pre-composited `-on-light.jpg`/`-on-dark.jpg` versions
  and the dark-native chart scene as-is.
- New `docs/branding/logo-ideas/{examined,dialectic,stoa}.svg` — byte-exact
  copies of the other branch's shortlisted marks (same paths, so a future merge
  of that branch is conflict-free).

## Round 4 (same day) — upright candlestick wordmark (vector remake)

Owner asked for "Socratic Trade" in red/green candlesticks but vertically
normal, not tilted like the Firefly originals. Rebuilt the idea from scratch
as a generated vector: Liberation Sans Bold glyph masks rendered in Pillow,
each letter column converted to candlestick bodies+wicks (seeded random
green/red mix, ~62/38), emitted as SVG — perfectly upright, scales cleanly.

- `docs/branding/firefly/candle-wordmark-upright.svg` (source of truth)
- `docs/branding/firefly/candle-wordmark-upright-{light,dark}.png` (exports)
- `shortlist.html` gains card **F5** showing it on both grounds.

## Round 5 (same day) — SOCRATIC ⇄ TRADE morph animation

Owner asked for an animation where one set of candlesticks alternates between
the two words: SOCRATIC held 3s → 6s semi-natural morph → TRADE held 3s → 6s
morph back (18s loop). Implementation: the Round-4 generator now produces
candle sets for both words (TRADE rendered at font 340 so the same ~110
candles fill it: 110 vs 109 slots, one jittered duplicate), maps candles
left-to-right/top-to-bottom, and emits per-candle CSS `@keyframes` animating
SVG geometry properties (x/y/height on body+wick rects) with per-candle
stagger (±1.2s), drift midpoints (±16/±22px wander, 0.75–1.3× height wobble),
and `ease-in-out` segments. Pure SVG+CSS, no JS; `prefers-reduced-motion`
freezes it on SOCRATIC. Colors stay with each candle through the morph.

- `docs/branding/firefly/candle-morph.svg` (76 KB, plays anywhere SVG+CSS does)
- `shortlist.html` gains animated card **F6** on both grounds.
- Verified via headless-Chromium screenshots at t=1s (SOCRATIC), 5s/7s
  (dispersed mid-flight), 10s (TRADE).

## Round 6 (same day) — Morph export formats (GIF / Live Photo / video)

Owner kept the SVG+CSS morph for the site and asked for portable exports.
Rendered the 18s loop to 360 frames (20 fps) with headless Chromium — each
frame is the animation paused at a negative `animation-delay` — then encoded
with ffmpeg (imageio-ffmpeg binary):

- `candle-morph.mp4` — full 18s loop, 1400x380 H.264 yuv420p, faststart.
- `candle-morph.gif` — 10 fps, 700px wide, palette-optimized, infinite loop.
- `candle-morph-livephoto.mov` + `.jpg` — one-way SOCRATIC->TRADE morph
  compressed to 3.0s (Live Photo length) so iPhone "bounce" plays it back and
  forth; MOV tagged with `Keys:ContentIdentifier` via exiftool. Caveat: the
  JPEG cannot receive Apple MakerNotes ContentIdentifier off-device (exiftool
  cannot create maker notes), so final Live Photo pairing happens on-device
  (intoLive app or Shortcuts "Make Live Photo" with the MOV) in seconds.

Fix (same day): the first encode flashed white every ~2s — headless-Chromium
batch captures corrupt the bottom row of each page, so every 40th frame
(t = odd .95s) was white. Re-rendered those 9 frames on a page with a
sacrificial dummy bottom row, re-encoded all three outputs, and verified by
decoding the final MP4 back to frames (zero bright outliers).

## Round 7 (same day) — transparent-background video exports

Owner asked for videos with transparency. Re-rendered the morph's 360 frames
with real alpha (Chromium `--default-background-color=00000000`, sacrificial
bottom rows to dodge the batch-capture artifact; alpha coverage verified per
frame), then encoded:

- `candle-morph-alpha.webm` — VP9 + alpha (yuva420p), 2.9 MB; plays with
  transparency in Chrome/Edge/Firefox `<video>`.
- `candle-morph-alpha.webp` — animated WebP with alpha, 15 fps, 3.8 MB;
  the GIF-replacement for chat/web embeds.
- ProRes 4444 MOV (yuva444p12le, ~113 MB) — generated and delivered to the
  owner directly; NOT committed (size). Regenerate from `candle-morph.svg`
  via the frame pipeline if needed. Safari/iOS note: Apple only plays
  HEVC-with-alpha, which can't be encoded on Linux — use the ProRes file in
  an Apple editor or convert on-device if a Safari-native alpha video is
  ever needed.

## Round 8 (same day) — console intro: chart flies into the logo

Owner asked for a page-open animation: a candlestick chart of an unnamed
asset on screen, whose candles all fly to the top-left and settle as the
logo that stays in the console header. Built as a one-shot ~5.8s SVG+CSS
animation (`docs/branding/firefly/console-intro.svg`, 1440x810 stage):

- The chart is generated FROM the logo: the stacked SOCRATIC/TRADE candle
  wordmark (182 candles) defines each candle's color, and the random-walk
  chart's per-candle up/down direction follows that color, so every candle
  keeps its color through the flight.
- Chart holds 2s (faint gridlines), candles depart left-to-right in a wave
  (staggered, drift midpoints biased upward), settle into a ~300px-wide
  top-left wordmark; a header hairline + nav-pill ghosts fade in at the end.
- Base SVG attributes are the FINAL logo state, keyframes start at the chart
  state — so `prefers-reduced-motion` (animation:none) shows the settled
  header immediately.
- Added as card F7 (wide tile) on `shortlist.html`. Not wired into the app;
  wiring it into `/console` page-load is a follow-up if the owner picks it.

## Round 9 (same day) — realistic candle bodies in the word/logo candles

Owner noticed the word-part candles looked like solid bars (body filled almost
the entire letter-stroke height) while the chart-part candles looked like real
candlesticks (a fat body in the middle with wicks above and below). Fixed the
word/logo candle model so it matches the chart's realism:

- For each glyph-column run, the WICK now spans the full run (preserving the
  letter's height/legibility) and the BODY is a fat middle sub-portion
  (`frac` ~ 0.58-0.76 of the run, positioned via a per-candle offset), with a
  small minimum body so short letter features stay solid and readable.
- Applied to all three generators: `candle-wordmark-upright.svg`,
  `candle-morph.svg` (both word states + drift), and `console-intro.svg`'s
  settled-logo endpoint (the chart endpoint was already realistic).
- Regenerated every derived export for consistency: upright light/dark PNGs;
  morph MP4/GIF/alpha-WebM/animated-WebP/Live-Photo MOV+JPG; and the embedded
  data URIs in `shortlist.html`. ProRes 4444 is regenerate-on-demand (not
  committed). Verified via headless-Chromium screenshots (upright both grounds;
  morph at t=1/5/7/10s; console-intro chart/flight/settled) and per-frame
  white/alpha-coverage checks before each encode.

## Why / decisions

- Palette deliberately reuses the product's existing brand tokens rather than
  inventing a new one: ink `#0f1722`, accent green `#0e9f6e` (light) /
  mint `#63e6be` (dark), dark ground `#0b1018` — from `app/globals.css` and
  `public/icon.svg`. A logo pick therefore requires no app-wide recolor.
- Comps keep type "live" (Helvetica Neue / Georgia stacks + `textLength`)
  instead of hand-outlined paths so they stay cheap to iterate; the chosen
  direction must be redrawn with outlined letterforms before shipping.
- Suggested shortlist noted on the board: **A, D, F, G** (each passes a
  16 px favicon and black-and-white test).
- Docs-only: nothing in the app references these files; `public/icon.svg` and
  all app chrome are untouched.

## Files

- `docs/branding/README.md` (new)
- `docs/branding/logo-concepts.html` (new — self-contained board, both grounds)
- `docs/branding/logo-concepts/{a-full-stop,b-inscription,c-dialogue,d-trendline,e-delta,f-open-question,g-sigma,h-argument,i-monogram,j-continuity}.svg` (new)
- `STATUS.md` (new snapshot entry)
- `docs/EFFORT-LOG.md` (new In Progress row; the `/Users/jay/apps/` live board
  is not reachable from this cloud container — mirror the row there on the next
  local session)
- `docs/rollouts/2026-07-05-logo-concepts.md` (this note)
- `PLAN.md` unchanged — no scope/timeline/approach change.

## Verification

Rendering verified by screenshotting `logo-concepts.html` with headless
Chromium (`/opt/pw-browsers/chromium --headless --screenshot`) on light and
dark tiles; bubble-tail and candle-wick geometry fixed from the first pass.

Repo gate (docs-only change, run per protocol, all green in this session):

```bash
npm run lint       # 0 errors, 308 grandfathered warnings
npx tsc --noEmit   # clean
npm test           # 254 files / 2465 tests passed
npm run build      # exit 0
```

## Follow-ups

- Owner picks a direction (or asks for another round mixing elements).
- Winner: redraw with outlined letterforms; produce favicon/app-icon (replace
  or evolve `public/icon.svg`), horizontal + stacked lockups, mono/one-color
  variant; then wire into app chrome and OG images.
- Mirror the effort row to `/Users/jay/apps/TRADING-EFFORT-LOG.md`.
