import assert from "node:assert/strict";
import { test } from "node:test";
import { BEAD_TRIANGLES, SURFACE, beadRadius, contrast, hex, hsl, luminance, over, type RGB } from "./surface.ts";

/** The original surface: pale maple, #f6ecd4 beads, #e0301e foul line. */
const OLD = { saturation: 52, lightness: [70, 77], bead: hex("#f6ecd4"), red: hex("#e0301e") } as const;
/** The first darkening (PR #4), with its sand: 2200 beads of 2.8 to 6.2 mm, 26000 dust specks, 15% of them 2×2. */
const PREV = {
  saturation: 54,
  lightness: [59, 65],
  bead: hex("#fbf3e0"),
  red: hex("#b42014"),
  beadCount: 2200,
  beadRadius: [0.0028, 0.0062],
  dustSpecks: 26000,
  dustCoarse: 0.15,
  dustAlpha: [0.22, 0.56],
} as const;
const CREAM = hex("#fff8e6");
/** Zone 4's tint, the strongest one painted over the wood. */
const ZONE4: [RGB, number] = [hex("#e62828"), 0.2];

const hue = (SURFACE.woodHue[0] + SURFACE.woodHue[1]) / 2;
const planks = (sat: number, ls: readonly number[]) => ls.map((l) => hsl(hue, sat, l));
const woodNow = planks(SURFACE.woodSaturation, SURFACE.woodLightness);
const woodPrev = planks(PREV.saturation, PREV.lightness);
const woodOld = planks(OLD.saturation, OLD.lightness);
const worst = (wood: RGB[], c: (w: RGB) => number) => Math.min(...wood.map(c));
const mean = (w: RGB[]) => w.reduce((s, c) => s + luminance(c), 0) / w.length;
const mid = (r: readonly [number, number]) => (r[0] + r[1]) / 2;

/** Mean and mean square of `beadRadius` over uniform draws: E[ab] = 1/4, E[(ab)²] = 1/9. */
function beadStats(range: readonly [number, number]): { mean: number; square: number } {
  const [lo, span] = [range[0], range[1] - range[0]];
  return { mean: lo + span / 4, square: lo * lo + (lo * span) / 2 + (span * span) / 9 };
}
/** Sand dust painted per texel: speck area times opacity. */
const dustCover = (specks: number, coarse: number, alpha: readonly [number, number]) => specks * (1 - coarse + 4 * coarse) * mid(alpha);

test("surface: the wood is noticeably darker than PR #4's, and still reads as wood", () => {
  const vsPrev = mean(woodNow) / mean(woodPrev);
  assert.ok(vsPrev < 0.8, `planks are noticeably darker than #4 (${vsPrev.toFixed(2)} of its luminance)`);
  const vsOld = mean(woodNow) / mean(woodOld);
  assert.ok(vsOld > 0.45, `but not so dark the maple turns to walnut (${vsOld.toFixed(2)} of the original)`);
  assert.ok(SURFACE.woodLightness[1] > SURFACE.woodLightness[0] && SURFACE.woodLightness[1] <= PREV.lightness[0], "every plank is darker than #4's darkest");
});

test("surface: sand beads and dust stand out more against the wood than before", () => {
  const bead = (b: RGB) => (w: RGB) => contrast(w, b);
  const beadNow = worst(woodNow, bead(hex(SURFACE.beadColor)));
  const beadPrev = worst(woodPrev, bead(PREV.bead));
  const beadOld = worst(woodOld, bead(OLD.bead));
  assert.ok(beadNow > beadPrev * 1.2, `beads vs #4: ${beadNow.toFixed(2)} vs ${beadPrev.toFixed(2)}`);
  assert.ok(beadNow > beadOld * 1.5, `beads vs original: ${beadNow.toFixed(2)} vs ${beadOld.toFixed(2)}`);

  const dust = (wood: RGB[], alpha: number) => worst(wood, (w) => contrast(w, over(w, CREAM, alpha)));
  const dustNow = dust(woodNow, mid(SURFACE.dustAlpha));
  assert.ok(dustNow > dust(woodPrev, mid(PREV.dustAlpha)), "dust specks show up better than on #4's wood");
  assert.ok(dustNow > dust(woodOld, 0.34), "and than on the original wood");
});

test("surface: sand beads are finer than #4's, and there is more sand overall", () => {
  const now = beadStats(SURFACE.beadRadius);
  const prev = beadStats(PREV.beadRadius);
  assert.ok(SURFACE.beadRadius[0] > 0 && SURFACE.beadRadius[1] > SURFACE.beadRadius[0], "radius range is a real range");
  assert.ok(now.mean <= prev.mean * 0.7, `beads are clearly finer (mean radius ${(now.mean * 1000).toFixed(2)} vs ${(prev.mean * 1000).toFixed(2)} mm)`);
  assert.ok(SURFACE.beadRadius[1] < PREV.beadRadius[0] * 1.6, "even the biggest bead is close to #4's smallest");
  assert.ok(SURFACE.beadCount >= PREV.beadCount * 2.5, `many more beads (${SURFACE.beadCount} vs ${PREV.beadCount})`);
  const cover = (SURFACE.beadCount * now.square) / (PREV.beadCount * prev.square);
  assert.ok(cover > 1.1, `the beads cover more of the table in total (${cover.toFixed(2)}× #4)`);

  assert.equal(beadRadius(0, 0.7), SURFACE.beadRadius[0]);
  assert.ok(Math.abs(beadRadius(0.999999, 0.999999) - SURFACE.beadRadius[1]) < 1e-8);
  assert.ok(beadRadius(0.5, 0.5) < mid(SURFACE.beadRadius), "sizes skew towards fine grains");
});

test("surface: the dusting is finer and denser than #4's", () => {
  assert.ok(SURFACE.dustCoarse <= PREV.dustCoarse / 3, `far fewer coarse 2×2 specks (${SURFACE.dustCoarse} vs ${PREV.dustCoarse})`);
  assert.ok(SURFACE.dustSpecks >= PREV.dustSpecks * 2, `many more specks (${SURFACE.dustSpecks} vs ${PREV.dustSpecks})`);
  const denser = dustCover(SURFACE.dustSpecks, SURFACE.dustCoarse, SURFACE.dustAlpha) / dustCover(PREV.dustSpecks, PREV.dustCoarse, PREV.dustAlpha);
  assert.ok(denser > 1.5, `more dust on the wood overall (${denser.toFixed(2)}× #4)`);
  const share = dustCover(SURFACE.dustSpecks, SURFACE.dustCoarse, SURFACE.dustAlpha) / (512 * 4096);
  assert.ok(share < 0.03, `but a dusting, not a coat of paint (${(share * 100).toFixed(1)}% of the wood)`);
});

test("surface: the sand stays cheap enough for phones", () => {
  assert.ok(Number.isInteger(SURFACE.beadCount) && SURFACE.beadCount > 0);
  const triangles = SURFACE.beadCount * BEAD_TRIANGLES;
  assert.ok(triangles <= 150_000, `beads are ${triangles} triangles in their single instanced draw`);
  assert.ok(SURFACE.beadCount * 64 <= 512 * 1024, "the full instance-matrix upload (each new round) stays under 512 KB");
  assert.ok(SURFACE.dustSpecks <= 100_000, "painting the dust at load stays quick");
});

test("surface: zone lines, numbers, and the foul line stay easy to read", () => {
  const ink = hex(SURFACE.ink);
  const inkWorst = worst(woodNow, (w) => contrast(over(w, ...ZONE4), ink));
  assert.ok(inkWorst >= 4.5, `ink on the darkest tinted zone is ${inkWorst.toFixed(2)}:1`);

  const redNow = worst(woodNow, (w) => contrast(w, hex(SURFACE.red)));
  const redPrev = worst(woodPrev, (w) => contrast(w, PREV.red));
  const redOld = worst(woodOld, (w) => contrast(w, OLD.red));
  assert.ok(redNow >= redPrev, `foul line keeps #4's contrast (${redNow.toFixed(2)} vs ${redPrev.toFixed(2)})`);
  assert.ok(redNow >= redOld, `and the original's (${redNow.toFixed(2)} vs ${redOld.toFixed(2)})`);
  const [r, g, b] = hex(SURFACE.red);
  assert.ok(r > 2 * g && r > 2 * b, "the foul line is still red, not brown");
});

test("surface: colour helpers", () => {
  assert.deepEqual(hsl(0, 100, 50), [1, 0, 0]);
  assert.deepEqual(hex("#ff8000"), [1, 128 / 255, 0]);
  assert.ok(Math.abs(contrast(hex("#000000"), hex("#ffffff")) - 21) < 1e-9);
});
