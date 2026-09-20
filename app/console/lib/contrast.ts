/** WCAG 2.x relative-luminance / contrast helpers for console token checks.
 *
 *  Chip text is 11px/600 on a tone-soft fill, so the ratio that matters is
 *  text-on-soft-fill (not text-on-plain-surface). AA for that size is 4.5:1. */

export function srgbChannelToLinear(channel: number): number {
  const x = channel / 255;
  return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(hex: string): number {
  const normalized = hex.replace("#", "");
  if (normalized.length !== 6) {
    throw new Error(`expected #rrggbb, got ${hex}`);
  }
  const r = srgbChannelToLinear(parseInt(normalized.slice(0, 2), 16));
  const g = srgbChannelToLinear(parseInt(normalized.slice(2, 4), 16));
  const b = srgbChannelToLinear(parseInt(normalized.slice(4, 6), 16));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: string, b: string): number {
  const left = relativeLuminance(a);
  const right = relativeLuminance(b);
  const lighter = Math.max(left, right);
  const darker = Math.min(left, right);
  return (lighter + 0.05) / (darker + 0.05);
}

/** sRGB alpha-composite of `hex` at `alpha` over an opaque background. */
export function compositeOver(hex: string, alpha: number, background: string): string {
  const src = hex.replace("#", "");
  const dst = background.replace("#", "");
  const mix = (from: number, to: number) => Math.round(from * alpha + to * (1 - alpha));
  const channels = [0, 2, 4].map((offset) => {
    const from = parseInt(src.slice(offset, offset + 2), 16);
    const to = parseInt(dst.slice(offset, offset + 2), 16);
    return mix(from, to).toString(16).padStart(2, "0");
  });
  return `#${channels.join("")}`;
}

export const WCAG_AA_SMALL_TEXT = 4.5;
export const WCAG_AA_LARGE_TEXT = 3.0;
export const WCAG_AA_NON_TEXT_CONTRAST = 3.0;

/** Parse `rgba(r, g, b, a)` (commas or spaces, 0-255 channels, 0-1 alpha). */
export function parseRgba(value: string): { r: number; g: number; b: number; a: number } {
  const m = value.trim().match(/^rgba?\(([^)]+)\)$/i);
  if (!m) throw new Error(`expected rgba(...), got ${value}`);
  const parts = m[1].split(/[\s,]+/).filter(Boolean);
  if (parts.length < 3 || parts.length > 4) throw new Error(`bad rgba tuple: ${value}`);
  const r = parseInt(parts[0], 10);
  const g = parseInt(parts[1], 10);
  const b = parseInt(parts[2], 10);
  const a = parts[3] !== undefined ? parseFloat(parts[3]) : 1;
  return { r, g, b, a };
}

/** sRGB alpha-composite `rgba(r,g,b,a)` over an opaque hex background. */
export function compositeRgbaOver(rgba: string, background: string): string {
  const { r, g, b, a } = parseRgba(rgba);
  const bg = background.replace("#", "");
  const mix = (from: number, to: number) => Math.round(from * a + to * (1 - a));
  const channels = [0, 2, 4].map((offset) => {
    const to = parseInt(bg.slice(offset, offset + 2), 16);
    const mixed = mix(offset === 0 ? r : offset === 2 ? g : b, to);
    return mixed.toString(16).padStart(2, "0");
  });
  return `#${channels.join("")}`;
}

/** Contrast of an rgba border against an opaque hex background.
 *  Used for non-text UI components (WCAG 1.4.11), which require >= 3:1. */
export function rgbaContrast(rgba: string, background: string): number {
  return contrastRatio(compositeRgbaOver(rgba, background), background);
}

/** Parse `1px solid var(--con-foo)` (and variants) into the rgba value if it is one. */
export function tokenRgba(css: string, name: string): string | undefined {
  const re = new RegExp(`${name}:\\s*(rgba?\\([^)]+\\)|#[0-9a-fA-F]{3,8})`, "i");
  const m = css.match(re);
  if (!m) return undefined;
  const v = m[1];
  if (v.startsWith("#")) return v.toLowerCase();
  return v.replace(/\s+/g, "").toLowerCase();
}
