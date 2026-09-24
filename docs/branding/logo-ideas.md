# Socratic-Trade — Logo Concepts

Twelve logo ideas exploring the two halves of the name: **Socratic** (question,
dialogue, examination, Greek antiquity) × **trading** (candlesticks, trend
lines, delta). First brand exploration for the app (dashboard title today:
"Agentic Trading Cockpit").

## Viewing

- Open `docs/branding/logo-ideas.html` in a browser — it previews every mark on
  light and dark grounds, with favicon-scale copies, two lockups, and a
  recommendation. The HTML is the **source of truth**: each mark lives in a
  `<symbol id="...">` block.
- The standalone files in `docs/branding/logo-ideas/*.svg` are extracted from
  those symbols (see "Regenerating" below).

## Shared design rules

- One ink color (`currentColor`; `#0f1722` on light, `#e7eef6` on dark) plus
  the dashboard's emerald accent `#0e9f6e` — the marks drop into the existing
  UI tokens (`--accent`, `--up`) without introducing a new palette.
- Rose `#e11d48` (the UI's `--down`) appears in exactly one mark (The Examined
  Trade), deliberately: a red candle under the lens.
- Every mark is drawn on a 64×64 grid (wordmark: 250×48) with stroke weights
  that survive 16–18 px favicon rendering.

## The twelve marks

| File | Name | Kind | Idea |
|------|------|------|------|
| `inquiry.svg` | The Inquiry | Pictogram | Question mark whose dot is a green candlestick — elenchus as price discovery. |
| `phi.svg` | Phi | Letterform | Φ (philosophy) with a candlestick spine; wick runs through the circle. |
| `examined.svg` | The Examined Trade | Pictogram | Magnifier over one green + one red candle — "the unexamined trade is not worth making." |
| `meander.svg` | Meander | Pattern mark | Greek key fret read literally as a staircase of higher highs, topped with a candle. |
| `dialectic.svg` | Dialectic | Pictogram | **SELECTED.** Two speech bubbles: a question asked, a trend answered. |
| `dialectic-lockup.svg` | Dialectic lockup | Lockup | **SELECTED.** The Dialectic mark with `Socratic-Trade` set beside it. |
| `stoa.svg` | The Stoa | Emblem | Temple whose middle column is a live candle. |
| `noctua.svg` | Noctua | Mascot | Athena's owl re-minted as a coin; chest feather is a small candle. |
| `delta.svg` | Delta | Letterform | Δ (change) framing a single candle. |
| `laurel.svg` | The Laurel | Emblem | Open wreath crowning the winning trade. |
| `serpentine.svg` | Serpentine | Monogram | The S of Socratic as one continuous price path ending on a last-print dot. |
| `torch.svg` | The Torch | Pictogram | Torch whose flame doubles as a candle body. |
| `wordmark.svg` | The Wordmark | Wordmark | Serif caps; the period of "Socratic-Trade" re-cut as a candlestick. |

## Selected mark (2026-07-05): Dialectic

After an initial shortlist (The Examined Trade, Dialectic, The Stoa), the
owner selected **Dialectic** and asked to save it in two forms:

- **`dialectic.svg`** — the standalone mark. Bubble tails were redrawn in v2
  after owner feedback ("the triangular part of the chat bubbles looks
  odd"): tails are now integrated into each bubble's outline path instead of
  separate triangle/stroke shapes.
- **`dialectic-lockup.svg`** — the mark with the name beside it
  (`Socratic-Trade`, serif, emerald period), viewBox 292×64.

The other eleven marks (including the two shortlist runners-up) stay in this
directory as archive/reference.

Next: cut real exports from the two saved assets (favicon.ico, app-icon
sizes, OG image) → outline the lockup's serif text to paths → wire into
`app/layout.tsx` metadata.

Earlier studio recommendation, for the record: Phi for app icon/favicon
(crisp at 16 px, ownable letter), The Inquiry for README/landing
storytelling, The Examined Trade for reports where showing a red candle is
honest.

## Regenerating the standalone SVGs

After editing a `<symbol>` in `logo-ideas.html`:

```bash
node -e '
const fs = require("fs");
const html = fs.readFileSync("docs/branding/logo-ideas.html", "utf8");
const re = /<symbol id="([^"]+)" viewBox="([^"]+)">([\s\S]*?)<\/symbol>/g;
let m;
while ((m = re.exec(html))) {
  const [, id, vb, body] = m;
  const [, , w, h] = vb.split(" ").map(Number);
  fs.writeFileSync(`docs/branding/logo-ideas/${id}.svg`,
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" width="${w * 2}" height="${h * 2}" style="color:#0f1722">${body}</svg>\n`);
}'
```

Note: standalone files hardcode dark ink (`color:#0f1722`) for light grounds;
for dark grounds embed the symbol inline and set `color`/`currentColor`, or
swap the style to `color:#e7eef6`.
