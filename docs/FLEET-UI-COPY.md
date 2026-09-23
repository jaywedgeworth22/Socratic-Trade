# Fleet UI copy conventions (owner, 2026-08-07)

Binding for **Socratic-Trade**, **Congress.Trade**, and **Usage Monitor** — web + iOS.



## Theme default = light (owner ruling 2026-08-10 — ALL apps, ALL agents)

Owner: default UI theme is **light**. Agents keep inventing dark-first or
"system" defaults that land on dark because the Mac is dark — stop that.

- **Default for first visit / no stored preference:** always **light**.
- **Do not** boot into dark from `prefers-color-scheme` unless the user has
  explicitly chosen **System** (or Dark).
- Dark remains an **optional** user choice via Light | Dark | System (or
  equivalent) — never the product default.
- **Screenshots / ASC / marketing / design previews:** capture in **light**
  mode unless the owner explicitly asks for dark. Existing ASC packs that
  are already light do not need a redo for this rule alone.
- Applies to Socratic-Trade, Congress.Trade, Usage Monitor (web + iOS).
- Do not "make it look cool" with dark chrome by default. Light is correct.

## Proper nouns

- **Congress** and **Congressional** always take a capital **C** (U.S. proper nouns) in product copy, App Store text, and UI.
- Brand: **Congress.Trade**. Display URLs may use `https://Congress.Trade` (hostnames are case-insensitive; DNS/cert still resolve).
- Keep technical identifiers lowercase: `trade.congress.ios`, `congress.trade` event names, email local-parts as configured.
## Headings / titles / buttons
Use **Title Case** (capitalize main words):
- Examples: `Agent Controls`, `Run Once`, `Win Rate`, `Needs Attention`,
  `Pending Proposals`, `Review 2 Proposals`, `Current Policy`,
  `Connected Accounts`, `Delete Account`, `Price Alerts`, `Last Run`,
  `Backend Remains Authoritative`, `Portfolio Brief`, `User Info`.

## Values / answers / secondary status (right side of labeled rows, subtitles that are data)
Use **sentence case or lowercase** — not Title Case:
- Examples: `not reported`, `ask-first`, `intraday`, `not scheduled`,
  `every 60 min`, `open holdings`, `none waiting`,
  `account return minus SPY…` (lowercase leading **a**).

## Special cases
- `vs SPY` — leave as-is (exception to value casing).
- `Use` buttons — short; leave as `Use`.
- Prefer **not** saying “Live” for account reality. All connected accounts are real money.
  Paper only: `Alpaca (paper)` with lowercase **p**. No “Live” dots/pills next to account rows.
- Market session banner (when shown): stream glyph + **`Market Closed`** / **`Market Open`**
  (not bare `Closed` alone if redundant with a Markets card).

## Money
- Compact suffixes **lowercase**: `$99.8k`, `$1.2m`, `$3.4b`.
- Home / hero equity (and places with room): **full** currency `$99,812.34`, not compact.

## iOS navigation titles
Always `.navigationBarTitleDisplayMode(.inline)` (small, centered) on root tab screens —
**not** large left-aligned titles that collapse only after scroll.

## Ticker logos
Show company logos next to ticker symbols wherever symbols appear (positions, orders,
watchlist, fills, proposals, scan tables). Fall back to monogram; never leave a blank hole.
Same open icon source as ST: `ticker-logos` / app logo proxy.

## What is NOT in scope
- Code identifiers, API enums, log lines, internal “live stream” engineering labels
  (SSE, live snapshot) unless user-facing product chrome.

## Two spaces between sentences (owner rule 2026-08-08, strengthened 2026-08-10 — ALL agents, ALL contexts)

Owner (reaffirmed): **two spaces between sentences everywhere.** Not optional.
Not “web only.” Not “UI only.” **Every single agent, every app, every surface.**

**Where it applies (non-exhaustive — if humans read it, use two spaces):**
- In-app UI strings (web, PWA, iOS native, widgets)
- **App Store Connect** listing fields: description, promotional text, What’s New,
  review notes, support/marketing blurbs — and any other multi-sentence ASC text
- Push / email / Slack-to-owner product copy / help / privacy / terms prose
- Apple Notes completion notes, rollouts meant for the owner, README user prose
- Marketing, screenshots captions, TestFlight “What to Test”

**How:**
- Between sentences in a paragraph: `end.  Start` (two ASCII spaces after `.` `!` `?`)
- HTML/JSX/SwiftUI that collapses spaces: use NBSP+space
  (`&nbsp; ` / `{"\u00A0 "}` / `\u00A0 `) or a shared helper (ST: `SENTENCE_GAP`)
- Prefer ONE paragraph for short related sentences over stacked one-liners when
  the owner asked for density (see Socratic proposals empty-state, 2026-08-08)

**Does NOT apply:** code identifiers, commit messages (complete sentences OK with
normal spacing is fine for git), log lines, API enums, pure bullet lists of
fragments with no sentence terminator.

**Agent failure mode:** shipping App Store description or UI paragraphs with
single spaces after periods. Fix on sight.

## Run-once glyph = emoji bolt (owner preference 2026-08-08, Socratic-Trade)
The Run-once affordance uses the colored emoji ⚡ (U+26A1), not a line-icon Zap —
owner: the emoji "reads better than the one on the site." Keep Start/Resume on the
Play glyph (two "go" line-icons side-by-side read as competing primaries). When copy
references the control inline, use the ⚡ emoji there too.
