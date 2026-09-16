/** Shared candlestick-wordmark ticker used by both the console intro splash and
 *  the persistent top-bar brand logo, so the two render the identical wordmark
 *  (same letter sampling + the same 12-unit green-biased ticker) and can never
 *  drift. Client-only: sampling rasterizes text to an offscreen canvas. */

export type TickerCell = { nx: number; ntop: number; nh: number };
export type TickerUnit = { col: string; frac: number; off: number };
export type Wordmark = {
  cells: TickerCell[];
  ar: number;        // width / height of the wordmark bounding box
  ncol: number;      // distinct candle columns
  hcol: number[];    // per-cell column index (0..ncol-1)
  hshort: boolean[]; // per-cell "short stroke" flag (fuller body)
};

export const TICKER_GREENS = ["#047857", "#059669", "#089981"];
export const TICKER_REDS = ["#be123c", "#dc2626", "#e11d48"];

/** Measured aspect ratio (width / height) of the "SOCRATIC TRADE" wordmark at
 *  the shared sample params (700 200px Arial, tracking 10) — i.e. the exact
 *  value `sampleWordmark("SOCRATIC TRADE").ar` yields at runtime. It is
 *  hardcoded because the SSR pass and every component's FIRST paint need the
 *  wordmark's width before any canvas can be rasterized; using the true value
 *  (not a round guess) means the reserved width never changes when the runtime
 *  sampler runs, so the logo — and the intro that lands on it — never visibly
 *  resizes. This MUST equal `sampleWordmark("SOCRATIC TRADE").ar`; if the font
 *  or wordmark text changes, re-measure (Arial is metric-compatible, so this is
 *  stable across platforms). Was `13.8`, a ~5% overestimate that made the logo
 *  width pop narrower on mount — the owner-reported intro size jump. */
export const WORDMARK_AR = 13.081;

const mulberry32 = (a: number) => () => {
  a |= 0; a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

let _off: HTMLCanvasElement | null = null;
let _octx: CanvasRenderingContext2D | null = null;
function offscreen(): [HTMLCanvasElement, CanvasRenderingContext2D] {
  if (!_off) { _off = document.createElement("canvas"); _octx = _off.getContext("2d", { willReadFrequently: true })!; }
  return [_off, _octx!];
}

/** Rasterize `text` (bold) and slice it into candle cells at a fixed column
 *  pitch, using a coverage threshold so bold stems read at even weight. The
 *  single letter sampler shared by the intro splash and the header logo. */
export function sampleCells(text: string, fontPx: number, tracking: number, pitch: number) {
  const [off, octx] = offscreen();
  const font = `700 ${fontPx}px Arial, "Helvetica Neue", sans-serif`;
  octx.font = font;
  const widths = [...text].map((ch) => (ch === " " ? fontPx * 0.45 : octx.measureText(ch).width));
  const total = widths.reduce((a, b) => a + b, 0) + tracking * (text.length - 1);
  const padX = Math.ceil(fontPx * 0.35), H = Math.ceil(fontPx * 1.5);
  off.width = Math.ceil(total) + padX * 2; off.height = H;
  octx.clearRect(0, 0, off.width, off.height);
  octx.fillStyle = "#fff"; octx.textBaseline = "alphabetic"; octx.font = font;
  let x = padX; const topY = Math.round(fontPx * 1.1);
  for (let i = 0; i < text.length; i++) { if (text[i] !== " ") octx.fillText(text[i], x, topY); x += widths[i] + tracking; }
  const img = octx.getImageData(0, 0, off.width, off.height).data, W = off.width;
  let x0 = W, x1 = 0, y0 = H, y1 = 0;
  for (let yy = 0; yy < H; yy++) for (let xx = 0; xx < W; xx++) {
    if (img[(yy * W + xx) * 4 + 3] > 128) { if (xx < x0) x0 = xx; if (xx > x1) x1 = xx; if (yy < y0) y0 = yy; if (yy > y1) y1 = yy; }
  }
  const cells: { cx: number; top: number; h: number }[] = [];
  const half = Math.floor((pitch - 4) / 2);
  for (let cx = x0 + 2; cx < x1; cx += pitch) {
    const colv: number[] = [];
    for (let yy = 0; yy < H; yy++) { let s = 0, n = 0; for (let xx = cx; xx < cx + pitch - 4 && xx < W; xx++) { s += img[(yy * W + xx) * 4 + 3]; n++; } colv.push(n ? s / n / 255 : 0); }
    let yy = 0;
    while (yy < H) { if (colv[yy] > 0.42) { const s = yy; while (yy < H && colv[yy] > 0.42) yy++; if (yy - s >= Math.round(fontPx * 0.03)) cells.push({ cx: cx - x0 + half, top: s - y0, h: yy - s }); } else yy++; }
  }
  return { cells, w: x1 - x0, h: y1 - y0 };
}

/** Sample a wordmark into normalized cells + per-column indices. One candle per
 *  natural stroke column (adjacent columns get different ticker units). */
export function sampleWordmark(text: string): Wordmark {
  const s = sampleCells(text, 200, 10, 15);
  const cells: TickerCell[] = s.cells.map((c) => ({ nx: c.cx / s.w, ntop: c.top / s.h, nh: c.h / s.h }));
  const key = (nx: number) => Math.round(nx * 1000);
  const uniq = [...new Set(cells.map((c) => key(c.nx)))].sort((a, b) => a - b);
  const map = new Map(uniq.map((v, i) => [v, i]));
  // `?? 0` instead of a non-null assertion: the map is built from these exact
  // keys so a miss should be impossible, but a `!` here turns any future drift
  // into `undefined` flowing silently into the ticker index arithmetic as NaN.
  // Column 0 is a correct-looking fallback; a crash in the RAF loop is not.
  const hcol = cells.map((c) => map.get(key(c.nx)) ?? 0);
  const hshort = cells.map((c) => c.nh < 0.16);
  return { cells, ar: s.w / s.h, ncol: uniq.length, hcol, hshort };
}

/** The ticker unit for column `col` at integer `tick`, marching one unit left
 *  per tick. ALWAYS returns a unit when `units` is non-empty.
 *
 *  Why this is defensive rather than a bare `units[(((col + tick) % P) + P) % P]`:
 *  `x % P` is NaN for any non-finite `x`, and `units[NaN]` is `undefined`, so a
 *  single bad `tick` crashed the whole logo with "Cannot read properties of
 *  undefined (reading 'frac')" (SOCRATIC-TRADE-2H, unhandled inside
 *  requestAnimationFrame on /login). A non-finite `tick` reaches here whenever a
 *  RAF callback is invoked without its DOMHighResTimeStamp argument — which some
 *  extension/polyfill RAF shims do — because the callers derive `tick` from that
 *  timestamp. The animation frame is cosmetic; freezing it at the base frame is
 *  always better than throwing. */
export function tickerUnitAt(units: TickerUnit[], col: number, tick: number): TickerUnit | null {
  const P = units.length;
  if (P === 0) return null;
  const c = Number.isFinite(col) ? col : 0;
  const t = Number.isFinite(tick) ? tick : 0;
  return units[(((Math.trunc(c + t) % P) + P) % P)] ?? units[0];
}

/** The green-biased price walk of P candle "units" (colour + body fraction +
 *  vertical offset). Each column shows one unit; marching the index one column
 *  left per second gives a lively, varied ticker (never a solid red/green block). */
export function buildTickerUnits(P = 12): TickerUnit[] {
  const hr = mulberry32(9);
  const hgauss = (m: number, sd: number) => { let u = 0, v = 0; while (!u) u = hr(); while (!v) v = hr(); return m + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  const price: number[] = [0]; for (let i = 0; i < P; i++) price.push(price[price.length - 1] + hgauss(0.16, 0.9));
  const rets = price.slice(1).map((v, i) => v - price[i]), mx = Math.max(...rets.map(Math.abs)) || 1;
  return rets.map((r) => { const up = r >= 0, mag = Math.abs(r) / mx; return { col: (up ? TICKER_GREENS : TICKER_REDS)[Math.min(2, Math.floor(mag * 3))], frac: 0.4 + 0.45 * mag, off: up ? 0.3 : 0.62 }; });
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath(); ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

/** Draw the wordmark as a candlestick ticker into `box`, at integer `tick`
 *  (marches one column left per tick). Colours come from the units; no fill is
 *  drawn behind it, so it sits on any background. */
export function drawTicker(
  ctx: CanvasRenderingContext2D,
  wm: Wordmark,
  units: TickerUnit[],
  box: { x: number; y: number; w: number; h: number },
  tick: number,
) {
  if (units.length === 0 || wm.ncol === 0) return;
  const bw = Math.max(1, box.w / wm.ncol * 0.55);
  for (let j = 0; j < wm.cells.length; j++) {
    const c = wm.cells[j], top = box.y + c.ntop * box.h, h = c.nh * box.h;
    const u = tickerUnitAt(units, wm.hcol[j], tick);
    if (!u) continue;
    const frac = wm.hshort[j] ? Math.max(u.frac, 0.82) : u.frac, bh = Math.max(1, h * frac);
    const bt = top + (h - bh) * u.off, x = box.x + c.nx * box.w;
    ctx.strokeStyle = u.col; ctx.lineWidth = Math.max(0.8, bw * 0.26); ctx.lineCap = "round";
    ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, top + h); ctx.stroke();
    ctx.fillStyle = u.col; roundRect(ctx, x - bw / 2, bt, bw, bh, Math.min(1.5, bw * 0.25)); ctx.fill();
  }
}
