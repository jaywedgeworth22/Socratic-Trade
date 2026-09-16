/**
 * Regression cover for SOCRATIC-TRADE-2H — "TypeError: Cannot read properties of
 * undefined (reading 'frac')", thrown unhandled inside requestAnimationFrame on
 * /login (Chrome 145 / Windows, mechanism auto.browser.browserapierrors.requestAnimationFrame).
 *
 * The ticker indexed its unit array with `(((col + tick) % P) + P) % P`. `%` yields
 * NaN for a non-finite operand, `units[NaN]` is undefined, and reading `.frac` off
 * it threw on EVERY frame. A non-finite `tick` reaches drawTicker whenever the RAF
 * callback runs without its DOMHighResTimeStamp argument, which extension- and
 * polyfill-injected RAF shims do: `start` then became undefined and every derived
 * tick was NaN.
 *
 * These tests exercise the pure ticker math only — sampleWordmark/sampleCells need a
 * real canvas, so the wordmark here is a hand-built fixture of the same shape.
 */

import { describe, expect, it } from "vitest";
import {
  buildTickerUnits,
  drawTicker,
  tickerUnitAt,
  type TickerUnit,
  type Wordmark
} from "../app/console/ui/candle-ticker";

/** A Wordmark of the shape sampleWordmark() returns, without needing a canvas. */
function fixtureWordmark(overrides: Partial<Wordmark> = {}): Wordmark {
  return {
    cells: [
      { nx: 0, ntop: 0.1, nh: 0.8 },
      { nx: 0.5, ntop: 0.2, nh: 0.6 },
      { nx: 1, ntop: 0.15, nh: 0.7 }
    ],
    ar: 13.081,
    ncol: 3,
    hcol: [0, 1, 2],
    hshort: [false, false, false],
    ...overrides
  };
}

/** Minimal 2D-context stand-in: drawTicker only issues these calls. */
function stubCtx() {
  const calls: string[] = [];
  const noop = (name: string) => () => { calls.push(name); };
  return {
    calls,
    strokeStyle: "",
    fillStyle: "",
    lineWidth: 0,
    lineCap: "" as CanvasLineCap,
    beginPath: noop("beginPath"),
    moveTo: noop("moveTo"),
    lineTo: noop("lineTo"),
    stroke: noop("stroke"),
    fill: noop("fill"),
    arcTo: noop("arcTo"),
    closePath: noop("closePath")
  };
}

const BOX = { x: 0, y: 0, w: 240, h: 18 };

describe("buildTickerUnits", () => {
  it("returns a full, well-formed unit walk", () => {
    const units = buildTickerUnits();
    expect(units).toHaveLength(12);
    for (const u of units) {
      expect(Number.isFinite(u.frac)).toBe(true);
      expect(Number.isFinite(u.off)).toBe(true);
      expect(typeof u.col).toBe("string");
    }
  });
});

describe("tickerUnitAt", () => {
  const units = buildTickerUnits();

  it("marches one unit left per tick and wraps in both directions", () => {
    expect(tickerUnitAt(units, 0, 0)).toBe(units[0]);
    expect(tickerUnitAt(units, 3, 2)).toBe(units[5]);
    expect(tickerUnitAt(units, 0, 12)).toBe(units[0]);
    // Negative ticks (a column that ticks before the march anchor) stay in range.
    expect(tickerUnitAt(units, 0, -1)).toBe(units[11]);
    expect(tickerUnitAt(units, 2, -30)).toBe(units[8]);
  });

  it("never returns undefined for a non-finite tick (the SOCRATIC-TRADE-2H input)", () => {
    for (const tick of [NaN, Infinity, -Infinity]) {
      const u = tickerUnitAt(units, 0, tick);
      expect(u).not.toBeNull();
      expect(Number.isFinite(u!.frac)).toBe(true);
    }
  });

  it("never returns undefined for a missing or non-finite column index", () => {
    for (const col of [NaN, Infinity, undefined as unknown as number]) {
      const u = tickerUnitAt(units, col, 3);
      expect(u).not.toBeNull();
      expect(Number.isFinite(u!.frac)).toBe(true);
    }
  });

  it("returns null only when there are no units at all", () => {
    expect(tickerUnitAt([] as TickerUnit[], 0, 0)).toBeNull();
  });
});

describe("drawTicker", () => {
  const units = buildTickerUnits();

  it("draws every cell on a well-formed frame", () => {
    const ctx = stubCtx();
    drawTicker(ctx as unknown as CanvasRenderingContext2D, fixtureWordmark(), units, BOX, 4);
    expect(ctx.calls.filter((c) => c === "stroke")).toHaveLength(3);
    expect(ctx.calls.filter((c) => c === "fill")).toHaveLength(3);
  });

  it("does not throw when the RAF timestamp made tick non-finite", () => {
    for (const tick of [NaN, Infinity, -Infinity]) {
      const ctx = stubCtx();
      expect(() =>
        drawTicker(ctx as unknown as CanvasRenderingContext2D, fixtureWordmark(), units, BOX, tick)
      ).not.toThrow();
      // Still renders — a bad timestamp freezes the animation, it does not blank the logo.
      expect(ctx.calls.filter((c) => c === "fill")).toHaveLength(3);
    }
  });

  it("does not throw on a wordmark whose column map left a hole", () => {
    const holed = fixtureWordmark({ hcol: [0, undefined as unknown as number, 2] });
    const ctx = stubCtx();
    expect(() =>
      drawTicker(ctx as unknown as CanvasRenderingContext2D, holed, units, BOX, 1)
    ).not.toThrow();
    expect(ctx.calls.filter((c) => c === "fill")).toHaveLength(3);
  });

  it("is a no-op rather than a divide-by-zero when there is nothing to draw", () => {
    const empty = fixtureWordmark({ cells: [], hcol: [], hshort: [], ncol: 0 });
    const ctx = stubCtx();
    expect(() =>
      drawTicker(ctx as unknown as CanvasRenderingContext2D, empty, units, BOX, 0)
    ).not.toThrow();
    expect(ctx.calls).toHaveLength(0);

    const ctx2 = stubCtx();
    expect(() =>
      drawTicker(ctx2 as unknown as CanvasRenderingContext2D, fixtureWordmark(), [], BOX, 0)
    ).not.toThrow();
    expect(ctx2.calls).toHaveLength(0);
  });
});
