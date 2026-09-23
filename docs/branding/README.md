# Branding — logo concepts (2026-07-05)

> **Start here: `shortlist.html`** — the owner's combined keepers in one page:
> Inscription, Delta, Argument, Monogram (this board), Examined Trade,
> Dialectic, Stoa (the earlier `logo-ideas` board, copied into `logo-ideas/`),
> and the four Adobe Firefly comps with backgrounds removed for light/dark use
> (full-res transparent PNGs + pre-composited versions in `firefly/`).

Fourteen logo directions for Socratic Trade, produced as concept comps across
two rounds (Round 2 refines the owner's Adobe Firefly comps). Open
`logo-concepts.html` in a browser to see every concept side by side on light
and dark grounds with rationale; the standalone SVGs live in
`logo-concepts/`.

## Palette

Taken from the product's existing tokens (`app/globals.css`, `public/icon.svg`):

- Ink `#0f1722` (light ground) / `#f2f6fa` (dark ground)
- Brand green `#0e9f6e` on light, mint `#63e6be` on dark
- Dark ground `#0b1018`

The standalone SVGs are exported in light-ground colors on a transparent
background; for dark grounds swap ink to `#f2f6fa` and green to `#63e6be`
(the HTML board does this via `currentColor` + a `--lg` CSS variable).

## Concepts

Wordmark-led (words are the logo):

- `a-full-stop.svg` — "Socratic-Trade": bold/light weight split with a green
  geometric dot; the domain itself as the logo.
- `b-inscription.svg` — wide-tracked serif caps, inscriptional/classical read.
- `c-dialogue.svg` — two staggered italic serif lines set like printed
  dialogue: quotation dash, reply, green full stop.
- `d-trendline.svg` — letterspaced caps over a thin rising line ending in a
  price dot (quiet descendant of the current favicon).
- `e-delta.svg` — stacked caps with a green delta/triangle as the A of TRADE.

Mark-led (symbol works alone as favicon/app icon):

- `f-open-question.svg` — question mark whose dot is a green candlestick.
- `g-sigma.svg` — one stroke that is a sigma, an S, and a zigzag price path.
- `h-argument.svg` — speech bubble holding a rising chart line.
- `i-monogram.svg` — serif "S.T" with the green period, small caps beneath.
- `j-continuity.svg` — the existing favicon unchanged, given a wordmark lockup.

Round 2 — refined from the owner's Adobe Firefly comps (kept the ideas —
candlestick letterforms, Athena's owl, market red/green — cut the noise; each
concept uses the candlestick exactly once):

- `k-owl.svg` — owl built from exactly two candlesticks (wicks = ear tufts and
  feet, bodies = face, amber `#e8a13a` beak) + stacked wordmark. Suggested
  primary identity.
- `l-owl-seal.svg` — circular seal: SOCRATIC/TRADE on the arcs, owl centered.
- `m-candle-i.svg` — clean bold wordmark where the I of SOCRATIC is a single
  green candle (the disciplined version of letters-made-of-candles).
- `n-cluster.svg` — three candles (up, down in red `#c22f4e`, up) rising left
  to right + wordmark; the only concept that keeps the Firefly red.

Note: the owl SVGs hardcode white eye-knockouts, so they suit light grounds;
the HTML board renders theme-aware dark variants (eyes knock out to the tile
background, down-red lightens to `#e0607a`).

## Status / caveats

- These are **concepts, not final assets**: type is set live with
  `Helvetica Neue`/`Georgia` font stacks and `textLength`, so exact rendering
  varies slightly by platform. A chosen direction should be redrawn with
  outlined letterforms before shipping.
- Nothing in the app references these files; `public/icon.svg` is untouched.
