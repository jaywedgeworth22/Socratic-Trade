"use client";

/** Persistent top-bar brand logo: a small candlestick "SOCRATIC TRADE" that
 *  ticks forever (one column left per second), replacing the typed wordmark.
 *  Sized to fit the console top bar; the intro splash shrinks into and hands off
 *  to this exact element (see intro-canvas.tsx, which measures [data-brand-logo]).
 *  Draws only candles — no background — so it sits on the header surface in both
 *  light and dark themes. Static frame for prefers-reduced-motion. */

import { useEffect, useRef } from "react";
import { sampleWordmark, buildTickerUnits, drawTicker, WORDMARK_AR, type Wordmark, type TickerUnit } from "./candle-ticker";

let CACHED: { wm: Wordmark; units: TickerUnit[] } | null = null;
function model() {
  if (!CACHED) CACHED = { wm: sampleWordmark("SOCRATIC TRADE"), units: buildTickerUnits() };
  return CACHED;
}

export function HeaderLogo({ height = 18 }: { height?: number }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const { wm, units } = model();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const H = height, W = Math.max(1, Math.round(H * wm.ar));
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    canvas.style.width = `${W}px`; canvas.style.height = `${H}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const box = { x: 0, y: 0, w: W, h: H };
    const render = (tick: number) => { ctx.clearRect(0, 0, W, H); drawTicker(ctx, wm, units, box, tick); };

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) { render(0); return; }

    let raf = 0, start: number | null = null, lastTick = -1;
    const loop = (now: number) => {
      // RAF is specified to pass a DOMHighResTimeStamp, but extension- and
      // polyfill-injected RAF shims exist that invoke the callback with no
      // argument. `undefined` then flowed into `start` (`undefined == null`),
      // every tick became NaN, and drawTicker indexed its unit array with NaN —
      // an unhandled TypeError on every frame (SOCRATIC-TRADE-2H on /login).
      // Fall back to the clock so the ticker still animates on those browsers.
      const ts = Number.isFinite(now) ? now : performance.now();
      if (start == null) start = ts;
      const tick = Math.floor((ts - start) / 1000);
      if (tick !== lastTick) { lastTick = tick; render(tick); }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [height]);

  return (
    <canvas
      ref={canvasRef}
      data-brand-logo
      role="img"
      aria-label="Socratic Trade"
      // Initial width uses the shared WORDMARK_AR — the SAME value the effect's
      // wm.ar yields — so the reserved box already equals the final size and the
      // canvas never resizes on mount (a stale ~13.8 guess popped it ~5% narrower,
      // which the landing intro measured and followed: the reported size jump).
      style={{
        display: "block",
        height: `${height}px`,
        width: `${Math.round(height * WORDMARK_AR)}px`,
        maxWidth: "100%",
        objectFit: "contain",
      }}
    />
  );
}
