"use client";

/** Minimal honest equity line: an SVG path over persisted snapshot points.
 *  No interpolation, no fabricated baselines — fewer than two points renders
 *  a sentence instead of a chart. Buckets are never overlaid on one axis. */

import { memo, useMemo } from "react";
import type { EquityCurvePoint } from "@/lib/types";
import { dayKey, fmtExact, fmtMoney, fmtPct, fmtSignedMoney } from "../lib/format";

const W = 640;
const H = 140;
const PAD = 6;

export const EquityChart = memo(function EquityChart({ points, label }: { points: EquityCurvePoint[]; label: string }) {
  const data = useMemo(
    () =>
      points
        .map((p) => ({ t: new Date(p.timestamp).getTime(), v: p.equity }))
        .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v))
        .sort((a, b) => a.t - b.t),
    [points]
  );

  if (data.length < 2) {
    return (
      <p className="py-4 text-[length:var(--con-fs-sm)] text-[color:var(--con-faint)]">
        Not enough history to draw the {label} curve yet — it needs at least two run snapshots.
      </p>
    );
  }

  const tMin = data[0].t;
  const tMax = data[data.length - 1].t;
  let vMin = data.reduce((min, d) => (d.v < min ? d.v : min), Infinity);
  let vMax = data.reduce((max, d) => (d.v > max ? d.v : max), -Infinity);
  // A near-flat curve (e.g. equity barely moved) would otherwise fill the whole
  // vertical range with noise, making a trivial wiggle look like a big swing.
  // Enforce a floor of ±0.5% around the data's own midpoint — real values are
  // never altered, only how much vertical room the axis gives them.
  const mean = data.reduce((sum, d) => sum + d.v, 0) / data.length;
  const minSpan = (Math.abs(mean) || Math.abs(data[data.length - 1].v) || 1) * 0.01;
  if (vMax - vMin < minSpan) {
    const center = (vMax + vMin) / 2;
    vMin = center - minSpan / 2;
    vMax = center + minSpan / 2;
  }
  const vSpan = vMax - vMin || 1;
  const tSpan = tMax - tMin || 1;

  const x = (t: number) => PAD + ((t - tMin) / tSpan) * (W - PAD * 2);
  const y = (v: number) => H - PAD - ((v - vMin) / vSpan) * (H - PAD * 2);
  const path = data.map((d, i) => `${i === 0 ? "M" : "L"}${x(d.t).toFixed(1)},${y(d.v).toFixed(1)}`).join(" ");
  const rising = data[data.length - 1].v >= data[0].v;
  const stroke = rising ? "var(--con-pos)" : "var(--con-neg)";
  const sameDay = dayKey(new Date(tMin).toISOString()) === dayKey(new Date(tMax).toISOString());
  const move = data[data.length - 1].v - data[0].v;
  const movePct = data[0].v !== 0 ? (move / data[0].v) * 100 : undefined;
  const tickLabel = (timestamp: number) =>
    sameDay
      ? new Date(timestamp).toLocaleTimeString([], { timeZone: "America/Chicago", hour: "numeric", minute: "2-digit" })
      : new Date(timestamp).toLocaleDateString(undefined, { timeZone: "America/Chicago" });

  return (
    <figure>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="w-full h-[120px] sm:h-auto"
        role="img"
        aria-label={`${label} equity from ${fmtMoney(data[0].v)} to ${fmtMoney(data[data.length - 1].v)}`}
      >
        <path d={path} fill="none" stroke={stroke} strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
      </svg>
      <figcaption className="con-num mt-1 flex justify-between text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
        <span title={fmtExact(points[0]?.timestamp)}>
          {tickLabel(tMin)} · {fmtMoney(data[0].v)}
        </span>
        <span title={`${label} move over the visible window`}>
          {fmtSignedMoney(move)}
          {movePct !== undefined ? ` · ${fmtPct(movePct, 2, true)}` : ""}
        </span>
        <span title={fmtExact(points[points.length - 1]?.timestamp)}>
          {tickLabel(tMax)} · {fmtMoney(data[data.length - 1].v)}
        </span>
      </figcaption>
    </figure>
  );
});
