import assert from "node:assert/strict";
import { test } from "node:test";
import { GESTURE, THROW, dragIntent, flickThrow, inReach, type DragIntent, type PointerSample } from "./gesture.ts";
import { START, TABLE } from "./rules.ts";

/** Feed a drag path (pixel offsets from touch-down) through `dragIntent`, like pointermove does. */
function intentOf(path: [number, number][], canPlace = true): DragIntent {
  let intent: DragIntent = "undecided";
  for (const [dx, dy] of path) intent = dragIntent(intent, dx, dy, canPlace);
  return intent;
}

test("pull back and flick from the default spot are throws straight away, with no pick-up step", () => {
  assert.equal(intentOf([[0, 4], [1, 12], [2, 60]]), "shot", "pull back");
  assert.equal(intentOf([[0, -6], [0, -40]]), "shot", "flick");
  // An angled pull as wide as aiming allows (atan2 * 0.45 hits MAX_ANGLE at ~18°) is still a throw.
  assert.equal(intentOf([[3, 8], [6, 20], [20, 70]]), "shot");
});

test("a sideways slide on the near table picks the weight up", () => {
  assert.equal(intentOf([[5, 1], [GESTURE.placeSlop, 3]]), "place");
  assert.equal(intentOf([[-8, -2], [-30, 4]]), "place");
});

test("once decided, a drag stays what it was", () => {
  assert.equal(intentOf([[0, 20], [60, 5]]), "shot", "a pull swung sideways never becomes a pick-up");
  assert.equal(intentOf([[30, 0], [30, 120]]), "place", "a pick-up dragged back doesn't turn into a pull");
  assert.equal(intentOf([[0, -20], [40, -20]]), "shot");
});

test("small wobbles and touches away from the start area don't pick the weight up", () => {
  assert.equal(intentOf([[GESTURE.placeSlop - 1, 2], [-6, -3]]), "undecided");
  assert.equal(intentOf([[40, 2]], false), "undecided", "sideways on the far table does nothing, as before");
  assert.equal(intentOf([[40, 2], [40, 30]], false), "shot", "and can still become a pull");
});

/** Sample a continuous finger path at a fixed rate. `t` is milliseconds, the same clock as a pointer event. */
function sampleAt(hz: number, durationMs: number, at: (t: number) => { x: number; y: number }): PointerSample[] {
  const step = 1000 / hz;
  const n = Math.round(durationMs / step);
  const out: PointerSample[] = [];
  for (let i = 0; i <= n; i++) {
    const t = Math.min(durationMs, i * step);
    out.push({ ...at(t), t });
  }
  return out;
}

function close(actual: number, expected: number, tol: number, what: string): void {
  assert.ok(Math.abs(actual - expected) <= tol, `${what}: ${actual} vs ${expected} (tol ${tol})`);
}

test("the pick-up area is the near end of the table around the start box", () => {
  assert.ok(inReach({ x: 0, d: TABLE.launchD }));
  assert.ok(inReach({ x: TABLE.width / 2 + 0.1, d: START.minD }));
  assert.ok(inReach({ x: 0, d: START.maxD + GESTURE.reach - 0.01 }));
  assert.ok(!inReach({ x: 0, d: START.maxD + GESTURE.reach + 0.01 }));
  assert.ok(!inReach({ x: 0, d: TABLE.foul }));
  assert.ok(!inReach({ x: TABLE.width / 2 + GESTURE.sideReach + 0.01, d: TABLE.launchD }), "out over the gutter");
  assert.ok(!inReach(null));
});

/** Steady finger velocity, px/ms. Up the screen is −y. */
const STEADY = { vx: 0.18, vy: -2 };

function steadyAt(t: number): { x: number; y: number } {
  return { x: STEADY.vx * t, y: STEADY.vy * t };
}

test("the same steady flick sampled at 30, 60, and 120 Hz is the same throw", () => {
  const throws = [30, 60, 120].map((hz) => flickThrow(sampleAt(hz, 200, steadyAt)));
  const first = throws[0];
  assert.ok(first?.power != null);
  const expectedPower = Math.min(1, Math.max(THROW.minPower, -STEADY.vy / THROW.fullUpSpeed));
  for (const flick of throws) {
    assert.ok(flick);
    close(flick.vx, STEADY.vx, 1e-6, "vx");
    close(flick.vy, STEADY.vy, 1e-6, "vy");
    close(flick.power ?? NaN, expectedPower, 1e-6, "power");
    close(flick.angle, Math.atan2(STEADY.vx, -STEADY.vy) * THROW.aimScale, 1e-6, "angle");
    close(flick.power ?? NaN, first.power ?? NaN, 1e-6, "power across rates");
  }
});

test("a smooth accelerating flick agrees across 30, 60, and 120 Hz", () => {
  // Constant acceleration. The fit over the last THROW.windowMs is the velocity at the middle of that window.
  const v0 = -0.4;
  const a = -0.01;
  const duration = 200;
  const at = (t: number) => ({ x: 0.05 * t, y: v0 * t + 0.5 * a * t * t });
  const t1 = duration - THROW.windowMs;
  const expectedVy = v0 + 0.5 * a * (t1 + duration);
  const throws = [30, 60, 120].map((hz) => flickThrow(sampleAt(hz, duration, at)));
  for (const flick of throws) {
    assert.ok(flick?.power != null);
    close(flick.vy, expectedVy, 0.03, "vy");
    close(flick.vx, 0.05, 0.005, "vx");
  }
  const powers = throws.map((flick) => flick?.power ?? NaN);
  close(Math.max(...powers) - Math.min(...powers), 0, 0.015, "power spread across rates");
});

test("throw strength follows event timestamps, not how many samples arrived", () => {
  const fast = sampleAt(60, 200, steadyAt);
  const slow = fast.map((s) => ({ x: s.x, y: s.y, t: s.t * 2 }));
  const a = flickThrow(fast);
  const b = flickThrow(slow);
  assert.ok(a && b);
  close(b.vy, a.vy / 2, 1e-6, "half speed when the same points take twice as long");
  close(b.vx, a.vx / 2, 1e-6, "vx halves too");
  const reversed = flickThrow(fast.slice().reverse());
  assert.ok(reversed);
  close(reversed.vy, a.vy, 1e-6, "sample order doesn't matter");
});

test("a single spike sample barely moves the throw, at 30, 60, and 120 Hz", () => {
  for (const hz of [30, 60, 120]) {
    const clean = sampleAt(hz, 200, steadyAt);
    const mid = clean.findIndex((s) => Math.abs(s.t - (200 - THROW.windowMs / 2)) <= 1000 / hz);
    assert.ok(mid > 0 && mid < clean.length - 1, `interior sample at ${hz} Hz`);
    const spiked = clean.map((s, i) => (i === mid ? { ...s, x: s.x + 160, y: s.y - 140 } : s));
    const end = clean.map((s, i) => (i === clean.length - 1 ? { ...s, x: s.x + 180, y: s.y + 150 } : s));
    const base = flickThrow(clean);
    const fromMid = flickThrow(spiked);
    const fromEnd = flickThrow(end);
    assert.ok(base && fromMid && fromEnd);
    close(fromMid.vy, base.vy, 1e-6, `${hz} Hz interior spike vy`);
    close(fromMid.power ?? NaN, base.power ?? NaN, 1e-6, `${hz} Hz interior spike power`);
    close(fromEnd.vy, base.vy, 1e-6, `${hz} Hz release spike vy`);
    close(fromEnd.vx, base.vx, 1e-6, `${hz} Hz release spike vx`);
  }
});

test("one impossibly fast sample is capped instead of becoming the throw", () => {
  const flick = flickThrow([
    { x: 0, y: 0, t: 0 },
    { x: 0, y: -200, t: 10 },
  ]);
  assert.ok(flick);
  close(flick.vy, -THROW.maxSampleSpeed, 1e-9, "clamped speed");
  assert.equal(flick.power, 1);
});

test("a pause before the lift kills the flick, and a crawl never launches", () => {
  const moving: PointerSample[] = [];
  for (let t = 0; t <= 100; t += 16) moving.push({ x: 0, y: -2 * t, t });
  const held = moving[moving.length - 1].y;
  const paused = moving.concat([120, 140, 160, 180, 200].map((t) => ({ x: 0, y: held, t })));
  assert.equal(flickThrow(paused)?.power ?? null, null);
  assert.equal(flickThrow(sampleAt(60, 200, (t) => ({ x: 0, y: -0.1 * t })))?.power ?? null, null);
  assert.equal(flickThrow([{ x: 0, y: 0, t: 0 }]), null);
});
