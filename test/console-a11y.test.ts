import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import {
  WCAG_AA_SMALL_TEXT,
  compositeOver,
  contrastRatio
} from "../app/console/lib/contrast";
import { isInteractiveTooltipTrigger } from "../app/console/lib/tooltip-trigger";
import { isTopmostFocusTrap, pushFocusTrap, releaseFocusTrap } from "../app/console/ui/focus-trap";

const CONSOLE_CSS = readFileSync(resolve(process.cwd(), "app/console/console.css"), "utf8");

function firstBlock(css: string, startMarker: string, endMarker: string): string {
  const start = css.indexOf(startMarker);
  const end = css.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < 0) {
    throw new Error(`could not slice ${startMarker} .. ${endMarker}`);
  }
  return css.slice(start, end);
}

function tokenHex(block: string, name: string): string {
  const match = block.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`));
  if (!match) {
    throw new Error(`missing ${name} in token block`);
  }
  return match[1].toLowerCase();
}

function allTokenHex(css: string, name: string): string[] {
  return [...css.matchAll(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`, "g"))].map((match) => match[1].toLowerCase());
}

describe("console light-theme chip contrast (#2561)", () => {
  const light = firstBlock(CONSOLE_CSS, ".console-root {", "/* ── DARK (explicit choice)");
  const tones: Array<{ name: string; token: string; softMix: number }> = [
    { name: "pos", token: "--con-pos", softMix: 0.11 },
    { name: "neg", token: "--con-neg", softMix: 0.1 },
    { name: "warn", token: "--con-warn", softMix: 0.12 },
    { name: "info", token: "--con-info", softMix: 0.12 },
    { name: "none", token: "--con-none", softMix: 0.1 }
  ];

  it("clears WCAG AA for small text on each tone-soft fill, not the plain surface", () => {
    for (const tone of tones) {
      const text = tokenHex(light, tone.token);
      const softOnWhite = compositeOver(text, tone.softMix, "#ffffff");
      const softOnSurface2 = compositeOver(text, tone.softMix, "#f4f6fa");
      expect(contrastRatio(text, softOnWhite), `${tone.name} on white soft ${text} / ${softOnWhite}`).toBeGreaterThanOrEqual(
        WCAG_AA_SMALL_TEXT
      );
      expect(
        contrastRatio(text, softOnSurface2),
        `${tone.name} on surface-2 soft ${text} / ${softOnSurface2}`
      ).toBeGreaterThanOrEqual(WCAG_AA_SMALL_TEXT);
    }
  });
});

describe("console dark faint contrast (#2561)", () => {
  it("lifts --con-faint identically in both dark blocks with AA headroom on surface-3", () => {
    const explicit = firstBlock(CONSOLE_CSS, '.console-root[data-theme="dark"] {', "/* ── DARK (system preference");
    const system = firstBlock(CONSOLE_CSS, ".console-root:not([data-theme=\"light\"]) {", "  color-scheme: dark;");
    const explicitFaint = tokenHex(explicit, "--con-faint");
    const systemFaint = tokenHex(system, "--con-faint");
    expect(explicitFaint).toBe(systemFaint);
    expect(allTokenHex(CONSOLE_CSS, "--con-faint").filter((hex) => hex === "#969696")).toEqual([]);
    // Opaque surface-3 is the tightest reading of the dark wash.
    expect(contrastRatio(explicitFaint, "#2a2a2a")).toBeGreaterThan(WCAG_AA_SMALL_TEXT + 0.5);
  });
});

describe("console tooltip trigger a11y (#2561)", () => {
  it("treats a native button as already focusable and a chip/time as not", () => {
    expect(isInteractiveTooltipTrigger(createElement("button", { type: "button" }, "Go"))).toBe(true);
    expect(isInteractiveTooltipTrigger(createElement("span", null, "Held"))).toBe(false);
    expect(isInteractiveTooltipTrigger(createElement("time", { dateTime: "2026-08-17" }, "2m"))).toBe(false);
    expect(isInteractiveTooltipTrigger([createElement("span", { key: "a" }, "a"), createElement("span", { key: "b" }, "b")])).toBe(
      false
    );
  });
});

describe("console stacked-surface Escape ownership (#2561)", () => {
  it("gives Escape/Tab ownership only to the topmost trap", () => {
    const sheet = pushFocusTrap({ blocking: false });
    const drawer = pushFocusTrap({ blocking: false });
    expect(isTopmostFocusTrap(sheet)).toBe(false);
    expect(isTopmostFocusTrap(drawer)).toBe(true);
    releaseFocusTrap(drawer);
    expect(isTopmostFocusTrap(sheet)).toBe(true);
    releaseFocusTrap(sheet);
  });
});

describe("collapsible card keyboard focus (board bf05f16a)", () => {
  const PRIMITIVES = readFileSync(resolve(process.cwd(), "app/console/ui/primitives.tsx"), "utf8");

  it("does not strip the focus outline from the collapsible Card <summary>", () => {
    const summary = PRIMITIVES.match(/<summary[^>]*>/);
    expect(summary, "collapsible Card renders a <summary>").not.toBeNull();
    expect(summary![0]).not.toMatch(/outline-none|outline-hidden/);
  });

  it("gives the disclosure summary an explicit, visible :focus-visible ring", () => {
    const rule = CONSOLE_CSS.match(/\.con-disclosure\s*>\s*summary:focus-visible\s*\{([^}]*)\}/);
    expect(rule, "console.css has a .con-disclosure > summary:focus-visible rule").not.toBeNull();
    expect(rule![1]).toMatch(/outline:\s*2px\s+solid\s+var\(--con-accent\)/);
    expect(rule![1]).not.toMatch(/outline:\s*none/);
  });
});
