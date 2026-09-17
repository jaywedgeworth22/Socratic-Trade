"use client";

/** Company/ticker logo for the console, ported from app/ui/ticker-logo.tsx but
 *  themed with console tokens. Loads /api/logos/ticker?symbol=X&theme=… and
 *  falls back to a monogram tile (never a bare gap). Theme resolution follows
 *  the console model: data-theme on the closest .console-root ancestor, else
 *  prefers-color-scheme — NOT the legacy `.dark` class on <html>. */

import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import type { TickerLogoDisplay } from "@/lib/ticker-logos";
import { normalizeTickerLogoSymbol } from "@/lib/ticker-logos";
import { cx } from "../lib/format";
import { Tooltip } from "./primitives";
import { useTickerLogoDisplay } from "../lib/useTickerLogoDisplay";
import { useTheme } from "@/app/ui/theme";

export type { TickerLogoDisplay };

/** Resolved light/dark for the console subtree containing `ref`. Reacts to both
 *  the explicit data-theme attribute (chrome toggle) and system changes. */
export function useConsoleResolvedTheme(): "dark" | "light" {
  const { resolvedTheme } = useTheme();
  return resolvedTheme;
}

export type TickerLogoSize = "sm" | "md" | "lg";

const SIZE_CLASS: Record<TickerLogoSize, string> = {
  sm: "h-5 w-5",
  md: "h-7 w-7",
  lg: "h-12 w-12"
};

const MONOGRAM_FONT_CLASS: Record<TickerLogoSize, string> = {
  sm: "text-[length:var(--con-fs-2xs)]",
  md: "text-[length:var(--con-fs-xs)]",
  lg: "text-base"
};

/** The full base symbol (before any class-share separator), e.g. "BRK.B" → "BRK",
 *  "ZTS" → "ZTS", "F" → "F". Truncating to two letters made the fallback read as a
 *  DIFFERENT ticker ("ZTS" → "ZT") — longer symbols shrink to fit the tile instead
 *  (fallbackFontPx below). */
function monogram(symbol: string): string {
  return symbol.split(/[.\-_]/)[0] || symbol;
}

const TILE_PX: Record<TickerLogoSize, number> = { sm: 20, md: 28, lg: 48 };

/** Fit font size (px) for fallback symbols longer than two characters: ~0.62em
 *  advance per semibold uppercase glyph, 4px breathing room, floored at 5px so a
 *  5-letter symbol still renders complete inside the fixed tile. Two characters
 *  or fewer keep the token font classes (undefined). */
function fallbackFontPx(size: TickerLogoSize, chars: number): number | undefined {
  if (chars <= 2) return undefined;
  return Math.max(5, Math.floor((TILE_PX[size] - 4) / (chars * 0.62)));
}

export function TickerLogo({
  symbol,
  display: explicitDisplay,
  size = "sm",
  className,
  title,
  fallback
}: {
  symbol: string;
  /** "tile" (default): logo on a neutral tile so dark/transparent marks stay
   *  visible in light mode too; "transparent": bare logo; "off": render the
   *  fallback (or nothing). */
  display?: TickerLogoDisplay;
  size?: TickerLogoSize;
  className?: string;
  title?: string;
  fallback?: ReactNode;
}) {
  const { tickerLogoDisplay: storedDisplay } = useTickerLogoDisplay();
  const display = explicitDisplay ?? storedDisplay;
  const normalized = useMemo(() => normalizeTickerLogoSymbol(symbol), [symbol]);
  const [failed, setFailed] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const theme = useConsoleResolvedTheme();

  useEffect(() => {
    setFailed(false);
  }, [normalized]);

  if (!normalized || display === "off") {
    return fallback ? <>{fallback}</> : null;
  }

  // Image failed (no logo match, or a network error): honor an explicit
  // fallback, otherwise a monogram tile so the slot is never a bare gap.
  if (failed) {
    if (fallback) return <>{fallback}</>;
    const label = monogram(normalized);
    const fontPx = fallbackFontPx(size, label.length);
    return (
      <Tooltip content={title}>
        <span
          ref={ref}
          className={cx(
            "con-logo-tile inline-flex shrink-0 select-none items-center justify-center overflow-hidden font-semibold uppercase leading-none",
            SIZE_CLASS[size],
            fontPx === undefined && MONOGRAM_FONT_CLASS[size],
            className
          )}
          style={fontPx === undefined ? undefined : { fontSize: fontPx, letterSpacing: "-0.02em" }}
          aria-hidden="true"
        >
          {label}
        </span>
      </Tooltip>
    );
  }

  return (
    <Tooltip content={title}>
      <span
        ref={ref}
        className={cx(
          "inline-flex shrink-0 items-center justify-center overflow-hidden",
          SIZE_CLASS[size],
          display === "tile" ? "con-logo-tile p-0.5" : "rounded-sm",
          className
        )}
        aria-hidden="true"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={`/api/logos/ticker?symbol=${encodeURIComponent(normalized)}&theme=${theme}`}
          alt=""
          className="h-full w-full object-contain"
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
        />
      </span>
    </Tooltip>
  );
}
