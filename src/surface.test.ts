import assert from "node:assert/strict";
import { test } from "node:test";
import { SURFACE, contrast, hex, hsl, luminance, over, type RGB } from "./surface.ts";

/** The surface before it was darkened: pale maple, #f6ecd4 beads, #e0301e foul line. */
const OLD = { saturation: 52, lightness: [70, 77], bead: hex("#f6ecd4"), red: hex("#e0301e") } as const;
const CREAM = hex("#fff8e6");
/** Zone 4's tint, the strongest one painted over the wood. */
const ZONE4: [RGB, number] = [hex("#e62828"), 0.2];

const hue = (SURFACE.woodHue[0] + SURFACE.woodHue[1]) / 2;
const planks = (sat: number, ls: readonly number[]) => ls.map((l) => hsl(hue, sat, l));
const woodNow = planks(SURFACE.woodSaturation, SURFACE.woodLightness);
const woodOld = planks(OLD.saturation, OLD.lightness);
const worst = (wood: RGB[], c: (w: RGB) => number) => Math.min(...wood.map(c));

test("surface: the wood is darker, but only a little", () => {
  const mean = (w: RGB[]) => w.reduce((s, c) => s + luminance(c), 0) / w.length;
  const ratio = mean(woodNow) / mean(woodOld);
  assert.ok(ratio < 0.85, `planks are noticeably darker (${ratio.toFixed(2)} of the old luminance)`);
  assert.ok(ratio > 0.6, `but still read as maple, not walnut (${ratio.toFixed(2)})`);
});

test("surface: sand beads and dust stand out more against the wood than before", () => {
  const bead = (b: RGB) => (w: RGB) => contrast(w, b);
  const beadNow = worst(woodNow, bead(hex(SURFACE.beadColor)));
  const beadOld = worst(woodOld, bead(OLD.bead));
  assert.ok(beadNow > beadOld * 1.25, `beads: ${beadNow.toFixed(2)} vs ${beadOld.toFixed(2)}`);

  const alpha = (SURFACE.dustAlpha[0] + SURFACE.dustAlpha[1]) / 2;
  const dustNow = worst(woodNow, (w) => contrast(w, over(w, CREAM, alpha)));
  const dustOld = worst(woodOld, (w) => contrast(w, over(w, CREAM, 0.34)));
  assert.ok(dustNow > dustOld, `dust: ${dustNow.toFixed(2)} vs ${dustOld.toFixed(2)}`);
});

test("surface: zone lines, numbers, and the foul line stay easy to read", () => {
  const ink = hex(SURFACE.ink);
  const inkWorst = worst(woodNow, (w) => contrast(over(w, ...ZONE4), ink));
  assert.ok(inkWorst >= 4.5, `ink on the darkest tinted zone is ${inkWorst.toFixed(2)}:1`);

  const redNow = worst(woodNow, (w) => contrast(w, hex(SURFACE.red)));
  const redOld = worst(woodOld, (w) => contrast(w, OLD.red));
  assert.ok(redNow >= redOld, `foul line red keeps its contrast (${redNow.toFixed(2)} vs ${redOld.toFixed(2)})`);
});

test("surface: colour helpers", () => {
  assert.deepEqual(hsl(0, 100, 50), [1, 0, 0]);
  assert.deepEqual(hex("#ff8000"), [1, 128 / 255, 0]);
  assert.ok(Math.abs(contrast(hex("#000000"), hex("#ffffff")) - 21) < 1e-9);
});
