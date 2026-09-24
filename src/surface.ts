/**
 * Look of the shuffleboard playing surface. The hall's neighbouring boards use
 * the same material, so they always match the active table.
 *
 * - `woodHue` / `woodSaturation` / `woodLightness`: plank colour (hsl). Each
 *   plank picks its hue and lightness from the ranges. Lower lightness makes
 *   the sand stand out more; `surface.test.ts` stops it going so dark that the
 *   markings stop reading.
 * - `grainDarken`: how many lightness points the grain streaks sit under their plank.
 * - `dustAlpha`: opacity range of the sand dust specks painted into the wood.
 * - `beadColor` / `beadGlow`: albedo and emissive of the 3D sand beads.
 * - `ink` / `red`: zone lines and numbers, and the foul line (matte decal).
 */
export const SURFACE = {
  woodHue: [34, 40],
  woodSaturation: 54,
  woodLightness: [59, 65],
  grainDarken: 16,
  dustAlpha: [0.22, 0.56],
  beadColor: "#fbf3e0",
  beadGlow: "#3a3222",
  ink: "#16161a",
  red: "#b42014",
} as const;

export type RGB = readonly [number, number, number];

/** hsl (degrees, %, %) to sRGB in [0, 1], as a canvas would fill it. */
export function hsl(h: number, s: number, l: number): RGB {
  const S = s / 100;
  const L = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = S * Math.min(L, 1 - L);
  const f = (n: number) => L - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [f(0), f(8), f(4)];
}

export function hex(css: string): RGB {
  const n = parseInt(css.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** `top` at opacity `alpha` painted over `base` (sRGB, as canvas blends). */
export function over(base: RGB, top: RGB, alpha: number): RGB {
  return [0, 1, 2].map((i) => base[i] + (top[i] - base[i]) * alpha) as unknown as RGB;
}

/** WCAG relative luminance. */
export function luminance(c: RGB): number {
  const lin = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
}

/** WCAG contrast ratio, 1 (none) to 21. */
export function contrast(a: RGB, b: RGB): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
