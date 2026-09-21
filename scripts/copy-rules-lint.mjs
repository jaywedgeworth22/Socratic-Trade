#!/usr/bin/env node
/**
 * Copy-rule lint for user-facing web strings — mirrors the copy-rule tests the
 * iOS suite already runs (ios/SocraticTradeTests/UserFacingCopyTests.swift's
 * `assertOrdinary`, ios/SocraticTradeTests/OrderCancelTests.swift's inline
 * two-space check) for the console + public web pages.
 *
 * Owner rule this exists to enforce (docs/FLEET-UI-COPY.md, CLAUDE.md "Two
 * spaces between sentences"): the SOURCE looking compliant is not enough —
 * HTML collapses runs of plain ASCII whitespace to one rendered space, so a
 * literal "  " (two spaces) typed into JSX renders identically to a single
 * space. The only construct that survives rendering is NBSP + space
 * (`SENTENCE_GAP` in app/console/lib/format.ts, `"  "`). This lint
 * simulates that collapse rather than trusting the source text.
 *
 * Rules implemented:
 *   A. sentence-gap    — sentence boundaries must use SENTENCE_GAP (NBSP+space),
 *                         not one or two literal ASCII spaces. THE headline rule.
 *   B. compact-money   — `Intl.NumberFormat({ notation: "compact" })` output
 *                         must be lowercased ($1.2m, not $1.2M).
 *   C. central-time     — `.toLocale{String,DateString,TimeString}()` calls must
 *                         pass a `timeZone` option (Central Time, per format.ts).
 *   D. title-case-ish  — best-effort heuristic scan of heading/button-shaped
 *                         JSX props (title=, aria-label= on buttons, <h1-3>
 *                         text) for sentence-case leaks. Heuristic; report-only.
 *
 * Usage: `node scripts/copy-rules-lint.mjs [--json] [--dir app/console/page.tsx ...]`
 * With no --dir args, scans the default root set (see DEFAULT_ROOTS below).
 */

import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

// ── File selection ───────────────────────────────────────────────────────────

/** Default scan roots: the console app + public pages. Excludes app/mobile
 *  (PWA retired, owner 2026-08-16 — do not spend copy-review time there) and
 *  app/admin (peer-owned admin.socratictrade.com surface, separate cluster). */
export const DEFAULT_ROOTS = ["app"];

export const EXCLUDE_DIR_SEGMENTS = new Set([
  "node_modules",
  ".next",
  "mobile", // PWA retired — out of scope, owner 2026-08-16
  "api" // route handlers — no rendered copy
]);

export const PEER_LOCKED_FILES = new Set();

function listFilesRecursive(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (EXCLUDE_DIR_SEGMENTS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      listFilesRecursive(full, out);
    } else if (/\.(tsx|ts)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) && !/\.d\.ts$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

export function collectFiles(roots = DEFAULT_ROOTS) {
  const out = [];
  for (const root of roots) {
    const abs = path.isAbsolute(root) ? root : path.join(REPO_ROOT, root);
    const st = statSync(abs, { throwIfNoEntry: false });
    if (!st) continue;
    if (st.isDirectory()) listFilesRecursive(abs, out);
    else out.push(abs);
  }
  return out;
}

// ── Shared text extraction ───────────────────────────────────────────────────

/** Strips // and /* *\/ comments so developer prose in comments is never
 *  scored as user-facing copy (comments never render to a user). Naive but
 *  safe: does not run inside string/template literals since we only use it
 *  to find comment SPANS to exclude, not to alter the string candidates
 *  themselves (those are extracted from the original content). */
function commentSpans(content) {
  const spans = [];
  const re = /\/\/[^\n]*|\/\*[\s\S]*?\*\//g;
  let m;
  while ((m = re.exec(content))) {
    spans.push([m.index, m.index + m[0].length]);
  }
  return spans;
}

function inAnySpan(index, spans) {
  return spans.some(([a, b]) => index >= a && index < b);
}

/** Splits ONE template-literal body (the text strictly between its opening
 *  and closing backtick) into its literal segments, skipping every `${...}`
 *  interpolation span. Without this, code like
 *  `` `${v >= 0 ? "+" : ""}${suffix}` `` gets scanned as if the ternary's
 *  `? "` were prose (a real false positive this lint hit and had to fix —
 *  see the git history of this file). Returns {text, offset}[] with `offset`
 *  relative to the START of the template body (i.e. add the body's absolute
 *  start index to place these back in the file). Handles one level of
 *  brace-nesting inside `${}` and skips over any nested backtick template by
 *  jumping to its matching close (best-effort — deeply nested tagged
 *  templates inside `${}` are not this codebase's style). */
function splitTemplateLiteralBody(body) {
  const segments = [];
  let i = 0;
  let segStart = 0;
  while (i < body.length) {
    const ch = body[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "$" && body[i + 1] === "{") {
      segments.push({ text: body.slice(segStart, i), offset: segStart });
      let depth = 1;
      i += 2;
      while (i < body.length && depth > 0) {
        if (body[i] === "{") depth++;
        else if (body[i] === "}") depth--;
        else if (body[i] === "`") {
          i++;
          while (i < body.length && body[i] !== "`") {
            if (body[i] === "\\") i++;
            i++;
          }
        }
        i++;
      }
      segStart = i;
      continue;
    }
    i++;
  }
  segments.push({ text: body.slice(segStart), offset: segStart });
  return segments;
}

/** Extracts candidate user-facing copy strings from a .tsx/.ts file:
 *  quoted/template string literals (template literals split around their
 *  `${}` interpolations so embedded code is never scanned as prose), plus
 *  raw JSX text nodes (text sitting directly between `>` and `<`, which is
 *  not a quoted literal at all — this is exactly where consent-gate.tsx's
 *  literal "  " lived). Returns {text, index}[] with `index` = offset of the
 *  candidate in `content` (for line-number reporting and fix splicing). */
export function extractCandidates(content) {
  const spans = commentSpans(content);
  const candidates = [];

  const quoteRe = /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g;
  let m;
  while ((m = quoteRe.exec(content))) {
    if (inAnySpan(m.index, spans)) continue;
    candidates.push({ text: m[0].slice(1, -1), index: m.index + 1 });
    spans.push([m.index, m.index + m[0].length]); // don't let backtick-scan below re-enter this span
  }

  const backtickRe = /`(?:[^`\\]|\\.)*`/g;
  while ((m = backtickRe.exec(content))) {
    if (inAnySpan(m.index, spans)) continue;
    const bodyStart = m.index + 1;
    const body = m[0].slice(1, -1);
    for (const seg of splitTemplateLiteralBody(body)) {
      if (seg.text) candidates.push({ text: seg.text, index: bodyStart + seg.offset });
    }
  }

  // Raw JSX text nodes: content strictly between `>` and the next `<`, with
  // no `{`/`}` (expression boundary) inside, and containing at least one
  // letter (skip pure whitespace/indentation runs between tags).
  //
  // This heuristic has bitten this lint TWICE and shipped a real bug both
  // times, so it is deliberately conservative now:
  //   1. A blacklist version (excluding only whitespace-adjacent `<`/`>`)
  //      misread `vix > 30 ? … : vix < 13` (a comparison, not JSX) on
  //      app/console/macro/indicators.ts.
  //   2. The whitespace-blacklist fix above STILL misread the `=>` in
  //      `.sort((a, b) => …)` as a JSX-closing `>` (nothing requires a space
  //      before `=>`), and inserted a copy-rule "fix" INSIDE actual code —
  //      `?? ""` became `??  ""` — on app/console/scan/smart-money.tsx. That
  //      is corruption, not a copy bug, and blacklisting `=>` too would just
  //      start the same game against `>=`, `<=`, and TS generics next.
  //
  // Given that, this is a POSITIVE allowlist instead of a blacklist: only
  // treat `>` as a real JSX tag-close when the character immediately before
  // it is one Prettier actually puts there (a letter/digit ending a tag
  // name, a closing quote, a `}` ending an attribute expression, or `/` for
  // a self-closing tag) — no JS/TS operator token ends in any of those
  // characters. Symmetrically, `<` only counts as a real tag-open when
  // immediately followed by a letter (a tag name) or `/` (a closing tag).
  // A max span length is a second, independent guard against a mis-paired
  // `>`/`<` swallowing a huge unrelated chunk of code as one "candidate"
  // (the failure mode template-literal backtick pairing hit earlier in this
  // file's history). Real JSX text nodes in this codebase run long —
  // multi-sentence tooltip paragraphs of 500+ characters are ordinary
  // (verified against model-stats-drawer.tsx) — so this is a generous
  // backstop, not a tight content limit.
  // `<` is also allowlisted immediately before `>` so JSX Fragment shorthand
  // (`<>text</>`) is still recognized — there the opening tag IS just `<>`,
  // so the char before its `>` is `<` itself, not a tag name.
  const JSX_TEXT_MAX_SPAN = 2000;
  const jsxTextRe = /(?<=[A-Za-z0-9"'}/<])>([^<>{}]*[A-Za-z][^<>{}]*)<(?=[A-Za-z/])/g;
  while ((m = jsxTextRe.exec(content))) {
    if (m[1].length > JSX_TEXT_MAX_SPAN) continue;
    if (looksLikeCode(m[1])) continue;
    const start = m.index + 1;
    if (inAnySpan(start, spans)) continue;
    candidates.push({ text: m[1], index: start });
  }

  return candidates;
}

/** Third, independent, content-based safety net for the JSX-text-node
 *  heuristic above: even with the bracket allowlist and the length cap, TS
 *  generic type arguments (`useParams<{ id: string }>()`) can still pair an
 *  innocent `>` with a much later `<` (`useState<LoadState>`) and swallow
 *  real executable code as a "candidate" — this shipped as a real bug
 *  (`params.id ?? ""` became `params.id ??  ""`, a code change, on
 *  app/console/decisions/[id]/page.tsx). Real JSX text is English prose and
 *  essentially never contains a semicolon, an arrow token, or a statement
 *  keyword; anything that does gets rejected regardless of how it was
 *  bracket-matched. */
function looksLikeCode(text) {
  return /[;]|=>|\b(?:const|let|var|function|return|useState|useEffect|useCallback|useMemo|useRef|useParams|useRouter)\b/.test(text);
}

function lineOf(content, index) {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i++) {
    if (content[i] === "\n") line++;
  }
  return line;
}

// ── Rule A: sentence-gap ─────────────────────────────────────────────────────

const ABBREVIATION_SUFFIXES = [
  "e.g.",
  "i.e.",
  "u.s.",
  "u.k.",
  "mr.",
  "mrs.",
  "ms.",
  "dr.",
  "st.",
  "vs.",
  "etc.",
  "no.",
  "inc.",
  "corp.",
  "ltd.",
  "jr.",
  "sr.",
  "approx.",
  "ave.",
  "blvd.",
  "fig.",
  "vol.",
  "co.",
  "prof.",
  "gov.",
  "rev.", // "Rev. Rul. 2008-5" (IRS Revenue Ruling citation) — a real regression
  "rul.", // this lint's own fix pass shipped and had to revert: test/console-policy-diff.test.ts
  "reg.",
  "sec.",
  "std.",
  "art.",
  "ch.",
  // "Ann. Return" (annualized) -- a finance abbreviation this app uses as a Stat label.
  // Flagged app/admin/backtest-ic/backtest-ic-client.tsx:175 as a sentence boundary; it is not.
  // Left unguarded, the "fix" would have produced "Ann.  Return", which is wrong.
  "ann."
];

function isAbbreviationBoundary(text, punctuationStart, punctuationEnd) {
  const context = (text.slice(Math.max(0, punctuationStart - 12), punctuationStart) + text.slice(punctuationStart, punctuationEnd)).toLowerCase();
  return ABBREVIATION_SUFFIXES.some((ab) => context.endsWith(ab));
}

/** A leading numbered-list marker ("1. Acceptance of terms", "12. Contact")
 *  is not a sentence boundary — it is section numbering, and a single space
 *  after it is correct, ordinary style. This is a real bug this lint's own
 *  fix pass shipped and had to revert: terms-and-conditions/page.tsx and
 *  privacy-policy/page.tsx section titles ("1. Who we are") got rewritten to
 *  "1.  Who we are" because a lone digit run at the very start of a
 *  candidate string, followed by ". Capitalized Word", is indistinguishable
 *  from a real sentence boundary without this check. Only fires when the
 *  digit run starts at offset 0 of the CANDIDATE (the whole string/JSX-text
 *  node/template-segment) — "...normalized to 100.  Computed from..." is
 *  mid-sentence numeric content ending a real sentence, not a marker, and is
 *  correctly still flagged. */
function isLeadingListMarker(text, punctuationStart) {
  let digitsStart = punctuationStart;
  while (digitsStart > 0 && /[0-9]/.test(text[digitsStart - 1])) digitsStart--;
  return digitsStart === 0 && digitsStart < punctuationStart;
}

/** Finds sentence-boundary violations in one candidate string: a `.`/`!`/`?`
 *  (run of 1-3, for ellipses) immediately followed by ONE OR TWO literal ASCII
 *  spaces and then a capital letter or opening quote — i.e. anything that is
 *  NOT the NBSP+space SENTENCE_GAP construct. Both the "forgot the gap
 *  entirely" and "typed two literal spaces, which HTML then collapses to one"
 *  failure modes land in this same bucket, because both render identically
 *  wrong: one space. */
const SENTENCE_BOUNDARY_RE = /[.!?]{1,3}( {1,2})([A-Z“"'])/g;

export function findSentenceGapViolations(text) {
  const violations = [];
  let m;
  SENTENCE_BOUNDARY_RE.lastIndex = 0;
  while ((m = SENTENCE_BOUNDARY_RE.exec(text))) {
    const punctuationStart = m.index;
    // Walk back to the actual start of the punctuation run (regex matched
    // greedily but index points at its first char already for this pattern).
    let pStart = punctuationStart;
    while (pStart > 0 && /[.!?]/.test(text[pStart - 1])) pStart--;
    const pEnd = punctuationStart + m[0].length - m[1].length - m[2].length;
    if (isAbbreviationBoundary(text, pStart, pEnd)) continue;
    if (isLeadingListMarker(text, pStart)) continue;
    const spaceRunOffset = punctuationStart + m[0].length - m[1].length - m[2].length;
    violations.push({
      offset: m.index,
      match: m[0],
      spaceCount: m[1].length,
      // Offset (within `text`) of the space run itself — the exact span the
      // fixer replaces with SENTENCE_GAP's "  ".
      spaceRunOffset,
      spaceRunLength: m[1].length
    });
  }
  return violations;
}

// ── Fix pass (sentence-gap only — the mechanical, safe-to-automate rule) ────

/** Computes absolute-offset replacement spans for one file: every real
 *  sentence-gap violation's space run, as {start, length} into `content`.
 *  Sorted DESCENDING by start so callers can splice front-to-back without
 *  invalidating earlier offsets. */
export function computeSentenceGapFixSpans(content) {
  const spans = [];
  for (const c of extractCandidates(content)) {
    for (const v of findSentenceGapViolations(c.text)) {
      spans.push({ start: c.index + v.spaceRunOffset, length: v.spaceRunLength });
    }
  }
  spans.sort((a, b) => b.start - a.start);
  return spans;
}

/** Applies the fix: replaces each violating space run with SENTENCE_GAP's
 *  two-char "  " (NBSP + space) directly in the string content — this
 *  works whether the run sat inside a quoted/template string literal or a
 *  raw JSX text node, and needs no import since the NBSP is embedded as a
 *  literal escape in the source (mirrors format.ts's own SENTENCE_GAP
 *  definition, `"  "`). Returns the fixed content and how many spans
 *  were replaced. */
export function applySentenceGapFixes(content) {
  const spans = computeSentenceGapFixSpans(content);
  let fixed = content;
  for (const { start, length } of spans) {
    fixed = fixed.slice(0, start) + "  " + fixed.slice(start + length);
  }
  return { content: fixed, count: spans.length };
}

/** Fixes one file on disk. Refuses peer-locked files even if asked, so a
 *  bad --dir argument can never touch a file another PR owns. */
export function fixFile(filePath, { dryRun = false } = {}) {
  if (PEER_LOCKED_FILES.has(filePath)) {
    return { file: filePath, skipped: "peer-locked", count: 0 };
  }
  const content = readFileSync(filePath, "utf8");
  const { content: fixed, count } = applySentenceGapFixes(content);
  if (count > 0 && !dryRun) {
    writeFileSync(filePath, fixed, "utf8");
  }
  return { file: filePath, count, dryRun };
}

// ── Rule B: compact-money lowercase ──────────────────────────────────────────

/** Best-effort: for every `Intl.NumberFormat({ ... notation: "compact" ... })`
 *  definition, requires a `.toLowerCase()` within the following ~2000 chars
 *  (i.e. the formatter's own wrapping helper/export). Approximate — this repo
 *  has few compact-notation call sites, so a tight AST pass was not worth the
 *  build-time dependency; verify manually before trusting a "clean" file. */
export function findCompactMoneyViolations(content) {
  const violations = [];
  const compactRe = /new Intl\.NumberFormat\([^)]*notation:\s*["']compact["'][^)]*\)/g;
  let m;
  while ((m = compactRe.exec(content))) {
    // Search the REST OF THE FILE, not a fixed window: this repo has very
    // few compact-notation definitions, and their `.toLowerCase()` call can
    // legitimately be far away (e.g. a column renderer defined near the
    // bottom of a large table-column file). A tight window produced a false
    // positive on app/console/scan/columns.tsx, where the fix lives ~160
    // lines after the const.
    const rest = content.slice(m.index);
    if (!/\.toLowerCase\(\)/.test(rest)) {
      violations.push({ offset: m.index, match: m[0] });
    }
  }
  return violations;
}

// ── Rule C: Central-time timestamps ─────────────────────────────────────────

/** Extracts the full balanced-paren argument list following a `.toLocale*(`
 *  call so multi-line option objects are captured correctly. */
function extractCallArgs(content, openParenIndex) {
  let depth = 0;
  let i = openParenIndex;
  for (; i < content.length; i++) {
    if (content[i] === "(") depth++;
    else if (content[i] === ")") {
      depth--;
      if (depth === 0) return content.slice(openParenIndex + 1, i);
    }
  }
  return content.slice(openParenIndex + 1);
}

const LOCALE_CALL_RE = /\.toLocale(String|DateString|TimeString)\(/g;

/** `.toLocaleDateString`/`.toLocaleTimeString` only exist on Date — always a
 *  real candidate. Bare `.toLocaleString()` exists on BOTH Date and Number
 *  (`count.toLocaleString()` for thousand-separators is extremely common in
 *  this codebase and needs no timeZone at all), so it only counts as a
 *  central-time candidate when the receiver expression right before the call
 *  actually looks like a date/timestamp. Without this guard the rule
 *  false-positived on ~13 of 14 hits repo-wide (share counts, byte counts,
 *  vector counts, character counts) — verified by reading every site. */
const DATE_LOOKING_RECEIVER_RE = /(new Date\(|[Dd]ate\b|[Tt]imestamp|\bat\)?$|At\)?$|asOf)/;

export function findCentralTimeViolations(content) {
  const violations = [];
  let m;
  LOCALE_CALL_RE.lastIndex = 0;
  while ((m = LOCALE_CALL_RE.exec(content))) {
    const isBareToLocaleString = m[1] === "String";
    if (isBareToLocaleString) {
      const receiverContext = content.slice(Math.max(0, m.index - 60), m.index);
      if (!DATE_LOOKING_RECEIVER_RE.test(receiverContext)) continue;
    }
    const openParen = m.index + m[0].length - 1;
    const args = extractCallArgs(content, openParen);
    if (!/timeZone/.test(args)) {
      violations.push({ offset: m.index, match: `${m[0]}${args})`.slice(0, 80) });
    }
  }
  return violations;
}

// ── Rule D: Title Case headings/buttons (heuristic, report-only) ───────────

const SMALL_WORDS = new Set(["a", "an", "the", "of", "in", "on", "for", "and", "or", "vs", "to", "at", "by", "with", "as", "is"]);

function looksTitleCase(text) {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  return words.every((w, i) => {
    const bare = w.replace(/[^A-Za-z0-9&']/g, "");
    if (!bare) return true;
    if (/^[A-Z0-9&]/.test(bare)) return true; // capitalized or acronym/number/ampersand start
    if (i > 0 && SMALL_WORDS.has(bare.toLowerCase())) return true; // connector word
    return false;
  });
}

/** Flags heading/button-shaped strings (title= props, <h1-3> text, primary
 *  Btn/Button children) that read sentence-case instead of Title Case. Very
 *  approximate — many real headings route through chrome.tsx/primitives.tsx
 *  which this lint does not parse component-by-component, so treat this as a
 *  DIRECTIONAL count, not a precise inventory. */
export function findTitleCaseViolations(content) {
  const violations = [];
  const titlePropRe = /\btitle=["']([^"']{2,60})["']/g;
  let m;
  while ((m = titlePropRe.exec(content))) {
    const text = m[1];
    if (/[.!?]$/.test(text)) continue; // sentence, not a heading
    if (!looksTitleCase(text)) {
      violations.push({ offset: m.index, match: text, kind: "title-prop" });
    }
  }
  const headingRe = /<h[1-3][^>]*>([^<{]{2,60})<\/h[1-3]>/g;
  while ((m = headingRe.exec(content))) {
    const text = m[1].trim();
    if (!text || /[.!?]$/.test(text)) continue;
    if (!looksTitleCase(text)) {
      violations.push({ offset: m.index, match: text, kind: "heading" });
    }
  }
  return violations;
}

// ── Per-file / repo aggregate ────────────────────────────────────────────────

export function scanFile(filePath) {
  const content = readFileSync(filePath, "utf8");
  const candidates = extractCandidates(content);

  const sentenceGap = [];
  for (const c of candidates) {
    for (const v of findSentenceGapViolations(c.text)) {
      sentenceGap.push({
        file: filePath,
        line: lineOf(content, c.index + v.offset),
        match: v.match,
        spaceCount: v.spaceCount
      });
    }
  }

  const compactMoney = findCompactMoneyViolations(content).map((v) => ({
    file: filePath,
    line: lineOf(content, v.offset),
    match: v.match
  }));

  const centralTime = findCentralTimeViolations(content).map((v) => ({
    file: filePath,
    line: lineOf(content, v.offset),
    match: v.match
  }));

  const titleCase = findTitleCaseViolations(content).map((v) => ({
    file: filePath,
    line: lineOf(content, v.offset),
    match: v.match,
    kind: v.kind
  }));

  return { file: filePath, sentenceGap, compactMoney, centralTime, titleCase };
}

export function lintFiles(files) {
  const results = files.map(scanFile);
  const totals = {
    sentenceGap: results.reduce((n, r) => n + r.sentenceGap.length, 0),
    compactMoney: results.reduce((n, r) => n + r.compactMoney.length, 0),
    centralTime: results.reduce((n, r) => n + r.centralTime.length, 0),
    titleCase: results.reduce((n, r) => n + r.titleCase.length, 0)
  };
  return { results, totals };
}

export function lintRepo(roots = DEFAULT_ROOTS) {
  return lintFiles(collectFiles(roots));
}

// ── CLI ───────────────────────────────────────────────────────────────────

function isMain() {
  return import.meta.url === `file://${process.argv[1]}`;
}

if (isMain()) {
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");
  const doFix = args.includes("--fix");
  const dirIdx = args.indexOf("--dir");
  const roots = dirIdx >= 0 ? args.slice(dirIdx + 1).filter((a) => !a.startsWith("--")) : DEFAULT_ROOTS;

  if (doFix) {
    // --fix only ever operates on the explicit --dir file list — never the
    // whole-repo default roots — so a fix pass is always a deliberate,
    // reviewable, curated set of files.
    if (dirIdx < 0) {
      console.error("--fix requires an explicit --dir <file...> list (never fixes the whole repo at once).");
      process.exit(1);
    }
    const files = collectFiles(roots);
    let total = 0;
    for (const f of files) {
      const result = fixFile(f);
      if (result.skipped) {
        console.log(`SKIP (peer-locked): ${path.relative(REPO_ROOT, f)}`);
        continue;
      }
      if (result.count > 0) {
        console.log(`fixed ${result.count.toString().padStart(3)}  ${path.relative(REPO_ROOT, f)}`);
        total += result.count;
      }
    }
    console.log(`\nTotal sentence-gap fixes applied: ${total}`);
    process.exit(0);
  }

  const { results, totals } = lintRepo(roots);

  if (asJson) {
    console.log(JSON.stringify({ totals, results: results.filter((r) => r.sentenceGap.length || r.compactMoney.length || r.centralTime.length || r.titleCase.length) }, null, 2));
  } else {
    console.log(`Copy-rule lint — scanned ${results.length} files under [${roots.join(", ")}]`);
    console.log(`  sentence-gap violations:   ${totals.sentenceGap}`);
    console.log(`  compact-money violations:  ${totals.compactMoney}`);
    console.log(`  central-time violations:   ${totals.centralTime}`);
    console.log(`  title-case violations:     ${totals.titleCase} (heuristic, report-only)`);
    console.log("");
    const byFile = new Map();
    for (const r of results) {
      const n = r.sentenceGap.length + r.compactMoney.length + r.centralTime.length + r.titleCase.length;
      if (n > 0) byFile.set(path.relative(REPO_ROOT, r.file), n);
    }
    const sorted = [...byFile.entries()].sort((a, b) => b[1] - a[1]);
    console.log(`Files with violations: ${sorted.length}`);
    for (const [file, n] of sorted.slice(0, 40)) {
      console.log(`  ${n.toString().padStart(4)}  ${file}`);
    }
    if (sorted.length > 40) console.log(`  ... and ${sorted.length - 40} more files`);
  }
}
