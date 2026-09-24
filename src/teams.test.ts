import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { SURFACE, contrast, hex, hsl, over } from "./surface.ts";
import { TEAM_COLORS, TEAM_NAMES, dimColor } from "./teams.ts";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const INK = hex("#0a0b0e");
const hue = ([r, g, b]: readonly number[]) => {
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
};

test("style.css and the favicon use the same team colours as the scene", () => {
  const css = read("./style.css");
  const cssVar = (name: string) => css.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, "i"))?.[1].toLowerCase();
  assert.equal(cssVar("a"), TEAM_COLORS[0]);
  assert.equal(cssVar("b"), TEAM_COLORS[1]);
  const icon = read("../public/favicon.svg");
  for (const c of TEAM_COLORS) assert.ok(icon.includes(`fill="${c}"`), `favicon has a ${c} weight`);
});

test("team 0 is red, not orange, and is called red", () => {
  const [r, g, b] = hex(TEAM_COLORS[0]);
  assert.ok(r > 0.9, "bright");
  assert.ok(r > 3 * g && r > 3 * b, "saturated red");
  const h = hue([r, g, b]);
  assert.ok(h < 5 || h > 345, `red hue, not orange (${h.toFixed(0)}°)`);
  assert.equal(TEAM_NAMES[0], "RED");
  assert.doesNotMatch(read("../index.html"), /orange/i);
});

test("both team colours read on the dark HUD panels", () => {
  for (const c of TEAM_COLORS) {
    const k = contrast(hex(c), INK);
    assert.ok(k >= 4.5, `${c} on ink is ${k.toFixed(2)}:1`);
  }
});

test("team red stays distinct from the foul line and the red zone on the wood", () => {
  const team = hex(TEAM_COLORS[0]);
  const foul = contrast(team, hex(SURFACE.red));
  assert.ok(foul >= 3, `team red vs foul line ${foul.toFixed(2)}:1`);
  const lightest = hsl(SURFACE.woodHue[1], SURFACE.woodSaturation, SURFACE.woodLightness[1]);
  const zone4 = over(lightest, [230 / 255, 40 / 255, 40 / 255], 0.2);
  const apart = Math.abs(((hue(team) - hue(zone4) + 540) % 360) - 180);
  assert.ok(apart > 15, `a red weight in zone 4 does not melt into the tint (${apart.toFixed(0)}° apart)`);
});

test("dimColor scales each sRGB channel", () => {
  assert.equal(dimColor("#27d3ff", 0.54), 0x15728a);
  assert.equal(dimColor("#ffffff", 1), 0xffffff);
  assert.equal(dimColor("#ff4550", 0), 0);
});
