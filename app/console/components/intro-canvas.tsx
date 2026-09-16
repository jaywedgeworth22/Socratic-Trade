"use client";

/** First-load splash: a candlestick chart that waves, breaks apart, and the candles
 *  fly straight up into the top-left header logo, which keeps ticking. Pure Canvas,
 *  responsive, any background. Plays once per tab session; skipped for
 *  prefers-reduced-motion. Click to dismiss. The original middle act — assembling a
 *  large centered SOCRATIC / TRADE wordmark before a second flight to the header —
 *  is preserved behind CENTER_WORDMARK_STEP below. Phase handoff to the header
 *  chrome (hide the real logo until the candles assemble it, mobile brand row
 *  reveal/slide-away) goes through ../ui/intro-bus.ts. */

import { useEffect, useRef, useState } from "react";
import { sampleCells, buildTickerUnits, tickerUnitAt, TICKER_GREENS, TICKER_REDS, WORDMARK_AR } from "../ui/candle-ticker";
import { setIntroPhase } from "../ui/intro-bus";

type Cell = { nx: number; ntop: number; nh: number };
type Geo = { x: number; bt: number; bb: number; wt: number; wb: number; bw: number; col?: string; up?: boolean };
type Model = {
  M: number;
  candleAt: (j: number, t: number, L: Layout) => Geo;
  layout: (vw: number, vh: number) => Layout;
  LIFT: number; // when the first candle breaks off the chart and starts moving up
  END: number;
};
type Layout = {
  portrait: boolean; stackW: number; stackH: number; stackX: number; stackY: number;
  chart: { x0: number; x1: number; midY: number; amp: number };
  header: { x: number; y: number; w: number; h: number };
  sizeScale: number;
};

// CENTER_WORDMARK_STEP — the intro originally had a middle act: the candles first
// assembled into a large centered SOCRATIC / TRADE wordmark (wave ripple, short
// hold), then flew a second leg into the header logo. Owner cut it 2026-07-08
// because it made the intro too long; candles now fly chart -> header directly.
// All of the middle act's code is kept live below — flip this to true to restore
// the original three-act sequence. (Typed `boolean`, not literal `false`, so
// TypeScript/ESLint don't flag the preserved branch as unreachable.)
const CENTER_WORDMARK_STEP: boolean = false;

// shared across mounts so the loading->loaded transition doesn't restart it
let introStart: number | null = null;
let introDone = false;
let MODEL: Model | null = null;

// Chart-phase candle colors follow the live console theme (--con-pos/--con-neg),
// read via getComputedStyle when the animation starts (the canvas API can't
// resolve CSS var() strings itself). The hex literals are only the last-resort
// defaults for the moment before the theme can be read. Module-scoped (not baked
// into the cached MODEL) so candleAt reads the freshly-resolved values.
let CHART_POS = "#059669";
let CHART_NEG = "#dc2626";

// Top safe-area inset in CSS px. The page is viewport-fit=cover (app/layout.tsx), so in a
// home-screen/standalone install the top bar — and therefore the wordmark's landing box — sits
// BELOW the notch, not at y=0. The layout() fallback below has no way to know that on a
// first-ever visit (nothing cached, top bar not mounted yet), so it assembled the wordmark up
// under the notch and then visibly dropped it into place once the real logo mounted. Measured
// once via a throwaway probe, since env() is only reachable from CSS.
let SAFE_TOP = 0;
function readSafeAreaTop() {
  try {
    const probe = document.createElement("div");
    probe.style.cssText = "position:fixed;top:0;left:0;visibility:hidden;pointer-events:none;padding-top:env(safe-area-inset-top,0px)";
    document.body.appendChild(probe);
    const v = parseFloat(getComputedStyle(probe).paddingTop);
    probe.remove();
    if (Number.isFinite(v) && v >= 0 && v <= 200) SAFE_TOP = v;
  } catch { /* keep 0 */ }
}
function readIntroColors(el: HTMLElement) {
  const styles = getComputedStyle(el);
  const pos = styles.getPropertyValue("--con-pos").trim();
  const neg = styles.getPropertyValue("--con-neg").trim();
  if (pos) CHART_POS = pos;
  if (neg) CHART_NEG = neg;
}

// Cross-session cache of the real header logo's measured TOP (viewport px), one
// value per breakpoint bucket ("d" = >=lg desktop bar, "m" = <lg mobile brand row).
// The real logo's y depends on whether a RealityBanner (~32px, non-live accounts)
// sits above the bar — and that is unknowable while the console is still on its
// loading screen (no snapshot => no banner => the bar isn't even mounted yet). So
// on a first-ever visit the fallback can only guess the no-banner offset; but once
// the intro has landed on the real logo even once, we remember its top and prime
// the fallback with it next time, so the wordmark assembles exactly where it ends
// up (no "assemble high, then drop when the page loads"). localStorage (not
// session) so it survives across the new tab/session that actually replays the
// intro. Stale entries (account switched live<->paper) self-heal: the per-frame
// re-measure glides to the real logo and re-caches. Clamped to a sane range.
const HDR_Y_KEY = "st.introHdrY";
function readCachedHeaderTop(bucket: "d" | "m"): number | undefined {
  try {
    const raw = localStorage.getItem(HDR_Y_KEY);
    if (!raw) return undefined;
    const v = (JSON.parse(raw) as Record<string, unknown>)?.[bucket];
    return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 400 ? v : undefined;
  } catch { return undefined; }
}
function writeCachedHeaderTop(bucket: "d" | "m", y: number) {
  try {
    const raw = localStorage.getItem(HDR_Y_KEY);
    const o = raw ? (JSON.parse(raw) as Record<string, number>) : {};
    o[bucket] = Math.round(y);
    localStorage.setItem(HDR_Y_KEY, JSON.stringify(o));
  } catch { /* ignore */ }
}
// The eased landing box, persisted at module scope so a loading->loaded remount
// (which re-runs the effect) does NOT reset it to null and SNAP to the newly
// mounted real logo — it keeps easing smoothly from wherever the candles were.
let introCurHeader: { x: number; y: number; w: number; h: number } | null = null;

function buildModel(): Model {
  const mulberry32 = (a: number) => () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const R = mulberry32(11);
  const rnd = (lo: number, hi: number) => lo + (hi - lo) * R();
  const gauss = (m: number, s: number) => {
    let u = 0, v = 0; while (!u) u = R(); while (!v) v = R();
    return m + s * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };

  // sampleCells is the shared letter sampler from candle-ticker.ts — the single
  // source used by both this splash and the persistent HeaderLogo.

  const SOC = sampleCells("SOCRATIC", 200, 10, 15), TRD = sampleCells("TRADE", 200, 10, 15);
  const gap = 200 * 0.34, blockW = Math.max(SOC.w, TRD.w), blockH = SOC.h + gap + TRD.h;
  const STACK: Cell[] = [];
  for (const c of SOC.cells) STACK.push({ nx: (c.cx + (blockW - SOC.w) / 2) / blockW, ntop: c.top / blockH, nh: c.h / blockH });
  for (const c of TRD.cells) STACK.push({ nx: (c.cx + (blockW - TRD.w) / 2) / blockW, ntop: (SOC.h + gap + c.top) / blockH, nh: c.h / blockH });
  const STACK_AR = blockW / blockH, M = STACK.length;

  function lineToM(text: string, m: number) {
    const s = sampleCells(text, 200, 10, 15), runs = s.cells, R2 = runs.length;
    const tot = runs.reduce((a, r) => a + r.h, 0);
    const raw = runs.map((r) => 1 + (m - R2) * r.h / tot), alloc = raw.map((x) => Math.floor(x));
    const rem = m - alloc.reduce((a, b) => a + b, 0);
    const ord = [...raw.keys()].sort((a, b) => raw[b] - alloc[b] - (raw[a] - alloc[a]));
    for (let i = 0; i < Math.max(0, rem); i++) alloc[ord[i]]++;
    let out: { cx: number; top: number; h: number }[] = [];
    for (let i = 0; i < runs.length; i++) { const c = Math.max(1, alloc[i]); for (let k = 0; k < c; k++) out.push({ cx: runs[i].cx, top: runs[i].top, h: runs[i].h }); } // overlap on the natural stroke (one clean candle), don't subdivide
    // If sampling produced nothing (canvas blocked, or the font never rasterized)
    // `out[out.length - 1]` is undefined and the pad loop below would fill the
    // wordmark with `{}` — every cell NaN. Pad from a real zero-cell instead so
    // the intro degrades to an invisible-but-valid wordmark rather than NaN
    // geometry that propagates into the ticker.
    const pad = out.length ? out[out.length - 1] : { cx: 0, top: 0, h: 0 };
    while (out.length < m) out.push({ ...(out[out.length - 1] ?? pad) });
    out = out.slice(0, m);
    const sw = s.w > 0 ? s.w : 1, sh = s.h > 0 ? s.h : 1;
    return { cells: out.map((c) => ({ nx: c.cx / sw, ntop: c.top / sh, nh: c.h / sh })) as Cell[], ar: sw / sh };
  }
  const HL = lineToM("SOCRATIC TRADE", M), HEADER = HL.cells, HEADER_AR = HL.ar;

  const rw: number[] = [0];
  for (let i = 0; i < M; i++) { let st = gauss(0, 11); if (R() < 0.16) st += gauss(0, 34); rw.push(rw[rw.length - 1] + st); }
  { const n = rw.length; let sx = 0, sy = 0, sxx = 0, sxy = 0; for (let i = 0; i < n; i++) { sx += i; sy += rw[i]; sxx += i * i; sxy += i * rw[i]; } const a1 = (n * sxy - sx * sy) / (n * sxx - sx * sx), a0 = (sy - a1 * sx) / n; for (let i = 0; i < n; i++) rw[i] -= a1 * i + a0; }
  const hi: number[] = [], lo: number[] = []; for (let i = 0; i < M; i++) { hi.push(rnd(5, 30)); lo.push(rnd(5, 30)); }
  const RWs = Math.max(...rw.map(Math.abs)) || 1, WAMP = 0.08;
  const chartPrice = (i: number, t: number) => {
    const trend = 0.82 - 0.55 * (i / M), wob = 0.18 * (rw[i] / RWs), u = i / M;
    const wv = WAMP * (0.6 * Math.sin(2 * Math.PI * 1.5 * u - t * 1.6) + 0.4 * Math.sin(2 * Math.PI * 2.6 * u - t * 1.05 + 0.7));
    return Math.max(0.02, Math.min(0.98, trend + wob + wv));
  };
  const G = TICKER_GREENS, RDc = TICKER_REDS;
  const BL: number[] = [], FD: number[] = [], AR: number[] = [], WX2: number[] = [], WY2: number[] = [], P4s: number[] = [], P4e: number[] = [], WX4: number[] = [], WY4: number[] = [], INFRAC: number[] = [], INCOL: string[] = [];
  for (let j = 0; j < M; j++) {
    BL.push(rnd(1.2, 2.6)); FD.push(rnd(2.6, 3.3)); AR.push(BL[j] + FD[j]);
    const a = rnd(0, 2 * Math.PI), r = rnd(0.35, 1) * 0.11; WX2.push(Math.cos(a) * r); WY2.push(Math.sin(a) * r);
    const s = rnd(0, 0.26); let e = rnd(0.8, 1); if (e < s + 0.42) e = Math.min(1, s + 0.42); P4s.push(s); P4e.push(e);
    const a2 = rnd(0, 2 * Math.PI), r2 = rnd(0.35, 1) * 0.06; WX4.push(Math.cos(a2) * r2); WY4.push(Math.sin(a2) * r2);
    const o = chartPrice(j, BL[j]), c = chartPrice(Math.min(j + 1, M), BL[j]), mag = Math.min(1, Math.abs(c - o) / 0.12);
    INFRAC.push(0.34 + 0.6 * mag); INCOL.push((c < o ? G : RDc)[Math.min(2, Math.floor(mag * 3))]);
  }
  // END: fade begins right after the candles land on the header logo — the
  // persistent HeaderLogo owns the forever-tick, so the overlay hands off at once
  // instead of holding and double-drawing the wordmark. Landing is T2B (all candles
  // arrived) on the direct path, or T4 (end of the second flight) with the center
  // wordmark act enabled. T3/T4 only shape the center-wordmark timeline.
  const T2B = Math.max(...AR), T3 = T2B + 0.75, T4 = T3 + 2.25;
  const END = (CENTER_WORDMARK_STEP ? T4 : T2B) + 0.2;
  // LIFT: the earliest candle breakaway — the moment candles start moving up. The
  // solid backdrop holds until here, then dissolves so the console reveals behind
  // the rising candles.
  const LIFT = Math.min(...BL);

  // Header ticker units — the shared green-biased walk from candle-ticker.ts, so the
  // splash's final ticker and the persistent HeaderLogo march through the identical
  // colours. Each header column shows one unit; the pattern marches one column left
  // per second (see headerTick), so neighbouring columns differ — never a solid block.
  const UNITS = buildTickerUnits();
  const hxKey = (nx: number) => Math.round(nx * 1000);
  const uniqHx = [...new Set(HEADER.map((c) => hxKey(c.nx)))].sort((a, b) => a - b);
  const hColMap = new Map(uniqHx.map((v, i) => [v, i]));
  // `?? 0` not `!`: see sampleWordmark in candle-ticker.ts — an undefined column
  // index becomes NaN in the tick arithmetic and crashes the RAF loop.
  const HCOL = HEADER.map((c) => hColMap.get(hxKey(c.nx)) ?? 0), HSHORT = HEADER.map((c) => c.nh < 0.16), NCOL = uniqHx.length;

  const layout = (vw: number, vh: number): Layout => {
    const portrait = vh > vw;
    const stackW = Math.min(portrait ? vw * 0.9 : vw * 0.8, vh * STACK_AR * 0.62), stackH = stackW / STACK_AR;
    const cm = Math.max(18, vw * 0.03);
    // Fallback header box, used until the real logo can be measured (the shell may
    // still be on its loading screen for the whole flight — owner hit this on prod).
    // It must match the REAL landing target's geometry per viewport so a late mount
    // is a small glide, not a jump. x/w follow the real logo's responsive formula;
    // the TOP (y) is primed from the cross-session cache (the real logo's last
    // measured top, which already includes any RealityBanner offset) and falls back
    // to the no-banner WITHIN-bar offset when we've never measured it:
    //  - <lg (1024): the MobileBrandRow wordmark — SAME height formula as shell.tsx
    //    (clamp(16..34, 88% of width / WORDMARK_AR)), centered in its rowH=logoH+20
    //    row => 10px below the bar top when no banner.
    //  - >=lg: the bar HeaderLogo — 18px tall at the left edge of the centered
    //    max-w-[1400px] px-4 bar; the ~43px control row centers the 18px logo at
    //    ~20px below the bar top when no banner (py-2 + (43-18)/2).
    let header: Layout["header"];
    if (vw < 1024) {
      const lh = Math.max(16, Math.min(34, Math.round((vw * 0.88) / WORDMARK_AR)));
      header = { x: (vw - lh * HEADER_AR) / 2, y: readCachedHeaderTop("m") ?? (SAFE_TOP + 10), w: lh * HEADER_AR, h: lh };
    } else {
      header = { x: Math.max(16, (vw - 1400) / 2 + 16), y: readCachedHeaderTop("d") ?? 20, w: 18 * HEADER_AR, h: 18 };
    }
    return {
      portrait, stackW, stackH, stackX: (vw - stackW) / 2, stackY: (vh - stackH) * 0.46,
      chart: { x0: cm, x1: vw - cm, midY: vh * (portrait ? 0.42 : 0.5), amp: vh * (portrait ? 0.34 : 0.4) },
      header, sizeScale: stackW / blockW,
    };
  };
  const chartGeom = (j: number, t: number, L: Layout): Geo => {
    const c = L.chart, x = c.x0 + (j + 0.5) * (c.x1 - c.x0) / M;
    const o = c.midY + (chartPrice(j, t) - 0.5) * c.amp, cl = c.midY + (chartPrice(j + 1, t) - 0.5) * c.amp;
    const bt = Math.min(o, cl), bb = Math.max(o, cl), bw = (c.x1 - c.x0) / M * 0.55;
    return { x, bt, bb, wt: bt - hi[j] * 0.35 * (c.amp / 300), wb: bb + lo[j] * 0.35 * (c.amp / 300), bw, up: cl < o };
  };
  const stackGeom = (j: number, L: Layout): Geo => {
    const s = STACK[j], top = L.stackY + s.ntop * L.stackH, h = s.nh * L.stackH;
    const bh = Math.max(3, h * INFRAC[j]), bt = top + (h - bh) / 2, bw = Math.max(2.4, L.sizeScale * 15 * 0.34);
    return { x: L.stackX + s.nx * L.stackW, bt, bb: bt + bh, wt: top, wb: top + h, bw };
  };
  const headerGeom = (j: number, L: Layout): Geo => {
    const s = HEADER[j], top = L.header.y + s.ntop * L.header.h, h = s.nh * L.header.h;
    const bh = Math.max(1.6, h * INFRAC[j]), bt = top + (h - bh) / 2, bw = Math.max(1.4, L.header.w / NCOL * 0.55);
    return { x: L.header.x + s.nx * L.header.w, bt, bb: bt + bh, wt: top, wb: top + h, bw };
  };
  const smoother = (p: number) => { p = Math.max(0, Math.min(1, p)); return p * p * p * (p * (p * 6 - 15) + 10); };
  const magnetic = (p: number) => { if (p <= 0) return 0; if (p >= 1) return 1; return smoother(p) + 0.055 * Math.sin(Math.PI * Math.max(0, p - 0.5) / 0.5); };
  const fly = (p: number, s: Geo, d: Geo, wx: number, wy: number, scale: number): Geo => {
    p = Math.max(0, Math.min(1, p)); const a = magnetic(p), bump = Math.sin(Math.PI * p), dy = wy * bump * scale;
    return { x: s.x + (d.x - s.x) * a + wx * bump * scale, bt: s.bt + (d.bt - s.bt) * a + dy, bb: s.bb + (d.bb - s.bb) * a + dy, wt: s.wt + (d.wt - s.wt) * a + dy, wb: s.wb + (d.wb - s.wb) * a + dy, bw: s.bw + (d.bw - s.bw) * a };
  };
  const waveY = (col: number, t: number, amp: number) => amp * (0.6 * Math.sin(0.42 * col - t * 1.4) + 0.4 * Math.sin(0.72 * col - t * 1.02 + 0.5));
  // CENTER words + morph: gentle ripple only. Bodies/colors stay as formed (no field
  // reshape — that caused the sudden "flip"); amplitude fades to zero over the morph.
  const waveRipple = (s: Geo, t: number, L: Layout) => {
    const amp = L.stackH * 0.05 * (t < T3 ? 1 : 1 - (t - T3) / (T4 - T3));
    const wy = waveY(s.x / 24, t, amp); s.wt += wy; s.wb += wy; s.bt += wy; s.bb += wy;
  };
  // HEADER: discrete per-second candlestick ticker — each column shows its own varied unit
  // and the pattern marches one column left per second (never one big block of red/green).
  // The march is anchored where landing completes (T2B direct / T4 with center wordmark);
  // the modulo handles negative offsets, so early-landing candles tick before the anchor.
  const TICK_T0 = CENTER_WORDMARK_STEP ? T4 : T2B;
  const headerTick = (s: Geo, j: number, t: number) => {
    const u = tickerUnitAt(UNITS, HCOL[j], Math.floor(t - TICK_T0));
    if (!u) return;
    const wh = s.wb - s.wt, frac = HSHORT[j] ? Math.max(u.frac, 0.82) : u.frac, bh = Math.max(1.4, wh * frac);
    s.bt = s.wt + (wh - bh) * u.off; s.bb = s.bt + bh; s.col = u.col;
  };
  const candleAt = (j: number, t: number, L: Layout): Geo => {
    if (t < BL[j]) { const g = chartGeom(j, t, L); g.col = g.up ? CHART_POS : CHART_NEG; return g; }
    const header = { ...headerGeom(j, L), col: INCOL[j] };
    if (!CENTER_WORDMARK_STEP) {
      // Direct path: each candle flies chart -> header logo in one leg, then ticks.
      if (t < AR[j]) { const g = chartGeom(j, BL[j], L); return { ...fly((t - BL[j]) / FD[j], g, header, WX2[j], WY2[j], L.stackW), col: INCOL[j] }; }
      headerTick(header, j, t);
      return header;
    }
    // Preserved center-wordmark path: chart -> big centered stack (ripple + hold) ->
    // second flight to the header logo -> tick.
    const stack = { ...stackGeom(j, L), col: INCOL[j] };
    if (t < AR[j]) { const g = chartGeom(j, BL[j], L); return { ...fly((t - BL[j]) / FD[j], g, stack, WX2[j], WY2[j], L.stackW), col: INCOL[j] }; }
    let s: Geo;
    if (t < T3) s = { ...stack };
    else if (t < T4) { const a = (t - T3) / (T4 - T3), pj = (a - P4s[j]) / (P4e[j] - P4s[j]); s = { ...fly(pj, stack, header, WX4[j], WY4[j], L.stackW), col: INCOL[j] }; }
    else s = { ...header };
    if (t < T4) waveRipple(s, t, L); else headerTick(s, j, t);
    return s;
  };
  return { M, candleAt, layout, LIFT, END };
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath(); ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

export function ConsoleIntro() {
  const [hidden, setHidden] = useState(introDone);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const bgRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (introDone) return;
    // deferred so we never call setState synchronously inside the effect body
    // (hide also settles the intro-bus phase: whether the splash finished or
    // never played, the header may now show the brand logo)
    const hide = () => { introDone = true; setIntroPhase("done"); queueMicrotask(() => setHidden(true)); };
    let sessionShown = false;
    try { sessionShown = sessionStorage.getItem("st.introShown") === "1"; } catch { /* ignore */ }
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (sessionShown || reduce) { hide(); return; }

    const canvas = canvasRef.current, wrap = wrapRef.current, bg = bgRef.current;
    if (!canvas || !wrap) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) { hide(); return; }
    if (!MODEL) { try { MODEL = buildModel(); } catch { hide(); return; } }
    const model = MODEL;
    // Resolve the theme's pos/neg tokens for the chart-phase candles at animation
    // start (wrap sits inside .console-root, so the --con-* scope is inherited).
    readIntroColors(wrap);
    // Must run BEFORE buildModel()'s layout() is first called below, so the very first frame
    // already places the landing box under the notch instead of correcting for it later.
    readSafeAreaTop();

    // Phones are DPR 3 (every iPhone since the X). Capping at 2 there rendered the candles —
    // thin round-capped strokes, the one shape that shows it — visibly soft on exactly the
    // screens this splash is most often seen on. The cap exists to stop a huge desktop canvas
    // from costing 3x the fill rate, and a phone canvas is small enough in CSS px that the
    // full ratio is cheap, so allow 3 only there.
    const phoneSized = Math.min(window.innerWidth, window.innerHeight) <= 500;
    const dpr = Math.min(window.devicePixelRatio || 1, phoneSized ? 3 : 2);
    let VW = 0, VH = 0, L = model.layout(1, 1), raf = 0, fading = false, done = false, fadeTimer = 0;
    // The intro's final candles land on the REAL top-bar brand logo so the splash
    // hands off seamlessly into it. We measure [data-brand-logo] (in the DOM behind
    // this overlay) and use its viewport rect as the header box; until it exists
    // (e.g. still loading) we fall back to the small computed top-left box.
    let headerBox: { x: number; y: number; w: number; h: number } | null = null;
    const measureHeader = () => {
      // Several [data-brand-logo] instances can exist (the desktop bar logo is
      // display:none below lg; the mobile brand row is lg:hidden) — land on the
      // first VISIBLE one, not just the first in the DOM.
      for (const el of Array.from(document.querySelectorAll<HTMLElement>("[data-brand-logo]"))) {
        const r = el.getBoundingClientRect();
        if (r.width > 2 && r.height > 2) { headerBox = { x: r.left, y: r.top, w: r.width, h: r.height }; return; }
      }
    };
    // Measure the OVERLAY, not window.innerWidth/innerHeight. `wrap` is position:fixed inset:0,
    // so its rect is by definition the box the canvas actually fills; window.innerHeight is the
    // VISUAL viewport, which on iOS Safari excludes the collapsed URL bar and so disagreed with
    // it by 60-90px. The chart's midY/amp were built from that taller number while the canvas
    // was the shorter one, which pushed the whole candle chart down and clipped its low wicks
    // off the bottom of every iPhone. Desktop never showed it because there the two agree.
    const readSize = () => {
      const r = wrap.getBoundingClientRect();
      return { w: Math.max(1, Math.round(r.width)), h: Math.max(1, Math.round(r.height)) };
    };
    const applySize = (w: number, h: number) => {
      VW = w; VH = h;
      canvas.width = VW * dpr; canvas.height = VH * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      L = model.layout(VW, VH);
      measureHeader();
    };
    const resize = () => { const s = readSize(); applySize(s.w, s.h); };
    resize();
    // iOS Safari fires resize when the URL bar collapses/expands on the tiniest scroll, which is
    // a chrome change, not a layout change — recomputing the model mid-flight made the candles
    // visibly jump. Absorb height-only deltas in that range while the animation is running (a
    // real rotation or split-view change moves the WIDTH too, and still goes through).
    const URL_BAR_SLOP = 120;
    const onResize = () => {
      const s = readSize();
      const chromeOnly = !done && s.w === VW && Math.abs(s.h - VH) <= URL_BAR_SLOP;
      if (chromeOnly) return;
      applySize(s.w, s.h);
    };
    window.addEventListener("resize", onResize);
    // The visual viewport is what actually changes on iOS (pinch-zoom, keyboard, URL bar); its
    // own resize event fires in cases the window one misses.
    window.visualViewport?.addEventListener("resize", onResize);

    const finish = () => {
      if (done) return; done = true;
      try { sessionStorage.setItem("st.introShown", "1"); } catch { /* ignore */ }
      hide();
    };
    const skip = () => { if (!fading) startFade(); };
    // startFade doubles as the "landed" signal: whether the candles finished
    // assembling the logo naturally or the user skipped, this is the moment the
    // real header logo may appear underneath the fading overlay.
    const startFade = () => { fading = true; setIntroPhase("landed"); if (wrap) { wrap.style.opacity = "0"; } fadeTimer = window.setTimeout(finish, 720); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" || e.key === "Enter" || e.key === " ") skip(); };
    wrap.addEventListener("click", skip);
    window.addEventListener("keydown", onKey);
    // The splash is definitely playing: the header hides its brand logo until
    // the candles assemble it (setIntroPhase("landed") in startFade).
    setIntroPhase("playing");

    let dissolved = false;
    // The landing box (introCurHeader, module-scoped) eases toward its target
    // (measured logo, else the layout fallback) instead of snapping, so a header
    // that mounts mid-flight or post-landing (slow first load) glides the
    // wordmark into place — and survives the loading->loaded remount.
    let lastNow: number | null = null;
    // Last real-logo top written to the cross-session cache (rounded px); avoids a
    // localStorage write every frame — only persist when the measured top changes.
    let cachedWriteY = -1;
    // While the page is still loading there's no logo to hand off to, so the
    // ticking wordmark simply stays up — it doubles as branded loading chrome
    // (the overlay is transparent after LIFT, so the loading/error screen shows
    // through beneath it). This backstop exists only for pages that never mount
    // a logo at all (e.g. the error shell): fade out eventually rather than
    // living forever. Keep it LONG — a short grace re-creates the owner-reported
    // "logo vanishes then reappears" gap on slow first loads. Click/Esc skips
    // instantly regardless.
    const MEASURE_WAIT = 45;
    const loop = (now: number) => {
      // Same RAF-timestamp guard as header-logo.tsx: a shim that calls back with
      // no argument made every derived time NaN, which crashed the ticker's unit
      // lookup (SOCRATIC-TRADE-2H). Fall back to the clock.
      const ts = Number.isFinite(now) ? now : performance.now();
      if (introStart == null) introStart = ts;
      const t = (ts - introStart) / 1000;
      const dt = lastNow == null ? 0.016 : Math.min(0.1, (ts - lastNow) / 1000); lastNow = ts;
      // Solid backdrop holds until the first candle lifts off, then dissolves so the
      // console/page reveals behind the rising candles (the canvas stays opaque).
      if (!dissolved && t >= model.LIFT) { dissolved = true; if (bg) bg.style.opacity = "0"; }
      // Re-measure the real logo EVERY frame (not just once) so the eased landing tracks its
      // FINAL geometry. The mobile brand row mounts its logo at a placeholder height and then
      // resizes to a width-scaled clamp (up to ~40% taller on wider phones/tablets); freezing
      // the first, smaller measurement made the assembled wordmark land narrow and then POP to
      // the larger real logo at handoff. measureHeader() keeps the previous box when no visible
      // logo is found, so this stays safe before the top bar has mounted.
      measureHeader();
      const target = headerBox ?? L.header; // real logo box, else viewport-matched fallback
      // Persist the real logo's top so the NEXT intro (a fresh tab/session) primes its
      // fallback with it and assembles the wordmark exactly where it ends up — including
      // any RealityBanner offset the loading screen can't know in advance.
      if (headerBox) {
        const ry = Math.round(headerBox.y);
        if (ry !== cachedWriteY) { cachedWriteY = ry; writeCachedHeaderTop(VW < 1024 ? "m" : "d", ry); }
      }
      let cur: { x: number; y: number; w: number; h: number };
      if (introCurHeader) {
        const a = 1 - Math.exp(-dt * 10);
        cur = {
          x: introCurHeader.x + (target.x - introCurHeader.x) * a,
          y: introCurHeader.y + (target.y - introCurHeader.y) * a,
          w: introCurHeader.w + (target.w - introCurHeader.w) * a,
          h: introCurHeader.h + (target.h - introCurHeader.h) * a
        };
      } else {
        cur = { ...target };
      }
      introCurHeader = cur;
      L.header = cur;
      ctx.clearRect(0, 0, VW, VH);
      // Once the backdrop has dissolved the real page shows through beneath the
      // flying candles — but they must not draw straight through foreground text.
      // Content that opts out via [data-intro-shield] (the readiness checklist
      // hero, whose text sits on the flight path around ~800px widths) gets its
      // rect clipped OUT, so candles pass visually behind it instead of over it.
      ctx.save();
      if (dissolved) {
        const shields: DOMRect[] = [];
        for (const el of Array.from(document.querySelectorAll<HTMLElement>("[data-intro-shield]"))) {
          const r = el.getBoundingClientRect();
          if (r.width > 1 && r.height > 1 && r.bottom > 0 && r.top < VH) shields.push(r);
        }
        if (shields.length > 0) {
          ctx.beginPath();
          ctx.rect(0, 0, VW, VH);
          for (const r of shields) ctx.rect(r.left, r.top, r.width, r.height);
          ctx.clip("evenodd");
        }
      }
      for (let j = 0; j < model.M; j++) {
        const c = model.candleAt(j, t, L); const col = c.col || CHART_POS;
        ctx.strokeStyle = col; ctx.lineWidth = Math.max(1, c.bw * 0.26); ctx.lineCap = "round";
        ctx.beginPath(); ctx.moveTo(c.x, c.wt); ctx.lineTo(c.x, c.wb); ctx.stroke();
        ctx.fillStyle = col; const bh = Math.max(1.4, c.bb - c.bt); roundRect(ctx, c.x - c.bw / 2, c.bt, c.bw, bh, Math.min(2, c.bw * 0.25)); ctx.fill();
      }
      ctx.restore();
      // Natural fade waits until the REAL logo exists and the glide has settled on
      // it — revealing the persistent logo under a wordmark that's elsewhere (or
      // under nothing at all, on a slow first load) caused a visible pop/gap.
      // User skip (click/Escape) still fades immediately via skip().
      const settled = !!headerBox && Math.abs(cur.x - headerBox.x) < 2 &&
        Math.abs(cur.y - headerBox.y) < 2 && Math.abs(cur.w - headerBox.w) < 2;
      if (!fading && t > model.END && (settled || t > model.END + MEASURE_WAIT)) startFade();
      if (!done) raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      if (fadeTimer) window.clearTimeout(fadeTimer);
      window.removeEventListener("resize", onResize);
      window.visualViewport?.removeEventListener("resize", onResize);
      window.removeEventListener("keydown", onKey);
      wrap.removeEventListener("click", skip);
    };
  }, []);

  if (hidden) return null;
  return (
    <div
      ref={wrapRef}
      aria-hidden
      style={{ position: "fixed", inset: 0, zIndex: 200, background: "transparent", transition: "opacity .7s ease", cursor: "pointer" }}
    >
      {/* Solid theme backdrop that covers the page until the candles lift off, then
          dissolves (opacity → 0) to reveal the console behind the rising candles. */}
      <div ref={bgRef} style={{ position: "absolute", inset: 0, background: "var(--con-bg)", transition: "opacity .9s ease" }} />
      <canvas ref={canvasRef} style={{ position: "relative", display: "block", width: "100%", height: "100%" }} />
    </div>
  );
}
