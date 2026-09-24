import assert from "node:assert/strict";
import { test } from "node:test";
import { TABLE } from "./rules.ts";
import { World, slideDistance, stoppingDistance, speedForDistance, type Body } from "./physics.ts";
import { FOLLOW_SMOOTH, WALL_SIGN } from "./scene.ts";
import { followLead, smoothDamp, smoothMin, type Spring } from "./smooth.ts";
import { SWAP, swapPose, type Vec3 } from "./swap.ts";

interface Trace {
  /** Worst distance the camera focus trailed the lead weight while it moved. */
  lag: number;
  /** Furthest the focus went past where the lead weight came to rest. */
  overshoot: number;
  /** Largest backwards step of the focus in one frame. */
  backstep: number;
  /** Seconds after everything stopped until the focus was within 5 cm of the rest point. */
  settle: number;
}

/** Old follow: first-order lerp (rate 5) toward the furthest moving weight. */
function oldFollow(): (w: Body[], dt: number) => number {
  let cam: number = TABLE.launchD;
  let target: number = TABLE.launchD;
  return (bodies, dt) => {
    let lead: number = TABLE.launchD;
    for (const b of bodies) if (b.active && Math.hypot(b.vx, b.vd) > 0.05) lead = Math.max(lead, b.d);
    if (lead > TABLE.launchD) target = lead;
    cam += (target - cam) * (1 - Math.exp(-dt * 5));
    return cam;
  };
}

/** New follow: monotonic look-ahead target, critically damped spring (mirrors main.ts + Stage.render). */
function newFollow(): (w: Body[], dt: number) => number {
  let target: number = TABLE.launchD;
  const spring: Spring = { value: TABLE.launchD, vel: 0 };
  return (bodies, dt) => {
    for (const b of bodies) {
      if (!b.active) continue;
      target = Math.max(target, followLead(b.d, b.vd, Math.hypot(b.vx, b.vd)));
    }
    smoothDamp(spring, target, FOLLOW_SMOOTH, dt);
    return spring.value;
  };
}

function frames(fps: number | "jitter"): () => number {
  let i = 0;
  if (fps === "jitter") return () => [1 / 60, 1 / 60, 1 / 30, 1 / 45, 1 / 120, 1 / 20][i++ % 6];
  return () => 1 / fps;
}

function run(
  follow: (w: Body[], dt: number) => number,
  bodies: Body[],
  fps: number | "jitter",
): Trace {
  const world = new World(bodies);
  const nextDt = frames(fps);
  const t: Trace = { lag: 0, overshoot: 0, backstep: 0, settle: 0 };
  let prev: number = TABLE.launchD;
  let peak: number = TABLE.launchD;
  let stoppedFor = -1;
  for (let n = 0; n < 60 * 30; n++) {
    const dt = nextDt();
    world.step(dt);
    const cam = follow(bodies, dt);
    const live = bodies.filter((b) => b.active);
    const lead = Math.max(...live.map((b) => b.d));
    if (world.moving) {
      const movingLead = Math.max(...live.filter((b) => b.vx || b.vd).map((b) => b.d));
      t.lag = Math.max(t.lag, movingLead - cam);
    } else {
      stoppedFor = stoppedFor < 0 ? 0 : stoppedFor + dt;
      if (Math.abs(cam - lead) > 0.05) t.settle = stoppedFor + dt;
    }
    peak = Math.max(peak, cam);
    t.backstep = Math.max(t.backstep, prev - cam);
    prev = cam;
    if (stoppedFor > 4) break;
  }
  t.overshoot = peak - Math.max(...bodies.filter((b) => b.active).map((b) => b.d));
  return t;
}

const lone = (distance: number): Body[] => [
  { x: 0, d: TABLE.launchD, vx: 0, vd: speedForDistance(distance - TABLE.launchD), active: true },
];

test("stoppingDistance matches the integrated slide", () => {
  for (const v of [0.4, 1.5, 3, 4.5, 6.2]) {
    assert.ok(Math.abs(stoppingDistance(v) - slideDistance(v)) < 0.01, `v=${v}`);
  }
  assert.equal(stoppingDistance(0), 0);
});

test("followLead looks ahead of a moving weight but never past its stop", () => {
  assert.equal(followLead(3, 0, 0), -Infinity);
  for (const v of [0.3, 1, 2.5, 4, 6]) {
    const lead = followLead(2, v, v);
    assert.ok(lead > 2 && lead <= 2 + stoppingDistance(v) && lead <= 2 + 1.4, `v=${v}`);
  }
  assert.equal(followLead(2, -1, 1), 2, "no look-ahead toward the shooter");
});

test("smoothMin is a soft min", () => {
  assert.ok(Math.abs(smoothMin(1, 10, 0.3) - 1) < 1e-9);
  assert.ok(Math.abs(smoothMin(10, 1, 0.3) - 1) < 1e-9);
  assert.ok(smoothMin(1, 1, 0.3) < 1);
});

test("smoothDamp is critically damped and frame-rate independent", () => {
  const settle = (dt: number) => {
    const s: Spring = { value: 0, vel: 0 };
    let peak = 0;
    for (let t = 0; t < 2; t += dt) {
      smoothDamp(s, 1, 0.26, dt);
      peak = Math.max(peak, s.value);
    }
    return { peak, value: s.value };
  };
  for (const dt of [1 / 144, 1 / 60, 1 / 30, 1 / 10]) {
    const r = settle(dt);
    assert.ok(r.peak <= 1, `no overshoot at dt=${dt}`);
    assert.ok(Math.abs(r.value - 1) < 1e-3, `settles at dt=${dt}`);
  }
});

test("new follow trails a sliding weight much less, without overshooting it", () => {
  for (const fps of [60, 30, "jitter"] as const) {
    for (const dist of [2.5, 4.5, 6.6, 7.0]) {
      const before = run(oldFollow(), lone(dist), fps);
      const after = run(newFollow(), lone(dist), fps);
      const at = `fps=${fps} dist=${dist}`;
      assert.ok(after.lag < before.lag * 0.6, `${at} lag ${after.lag.toFixed(2)} vs ${before.lag.toFixed(2)}`);
      assert.ok(after.overshoot < 0.02, `${at} overshoot ${after.overshoot.toFixed(3)}`);
      assert.ok(after.settle <= before.settle, `${at} settle ${after.settle.toFixed(2)} vs ${before.settle.toFixed(2)}`);
      assert.equal(after.backstep, 0, `${at} never moves back`);
    }
  }
});

test("the back wall reads exactly: Everyday I'm Shuffling", () => {
  assert.equal(WALL_SIGN.join(" "), "Everyday I'm Shuffling");
});

test("end swap flies out over the hall and lands exactly behind the new end", () => {
  const L = TABLE.length;
  const centre = { x: 0, y: 0, z: -L / 2 };
  // End 0's HEAD view → end 1's aim view (mirrors what Stage passes in), and back again.
  const cases: { from: { pos: Vec3; look: Vec3 }; to: { pos: Vec3; look: Vec3 }; side: 1 | -1 }[] = [
    { from: { pos: { x: 0, y: 1.9, z: -L + 2 }, look: { x: 0, y: 0, z: -L + 1 } }, to: { pos: { x: 0, y: 1.3, z: -L - 1.55 }, look: { x: 0, y: 0, z: -L + 2.9 } }, side: 1 },
    { from: { pos: { x: 0, y: 1.3, z: -2 }, look: { x: 0, y: 0, z: -1 } }, to: { pos: { x: 0, y: 1.25, z: 1.8 }, look: { x: 0, y: 0, z: -3.1 } }, side: -1 },
  ];
  for (const { from, to, side } of cases) {
    const hall = { x: side * 2.2, y: -0.45, z: centre.z };
    const at = (s: number) => swapPose(s, from, to, centre, hall, side);
    const dist = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
    assert.ok(dist(at(0).pos, from.pos) < 1e-9 && dist(at(0).look, from.look) < 1e-9, "starts where the camera is");
    assert.ok(dist(at(1).pos, to.pos) < 1e-9 && dist(at(1).look, to.look) < 1e-9, "ends on the new end's view");
    assert.ok(at(0).reveal < 1e-9 && at(1).reveal < 1e-9 && Math.abs(at(0.5).reveal - 1) < 1e-9, "house lights peak mid-flight");

    const frames = Math.round(SWAP.duration * 60);
    let widest = 0;
    let highest = 0;
    let step = 0;
    let prev = at(0).pos;
    for (let i = 1; i <= frames; i++) {
      const p = at(i / frames).pos;
      widest = Math.max(widest, Math.hypot(p.x - centre.x, p.z - centre.z));
      highest = Math.max(highest, p.y);
      step = Math.max(step, dist(p, prev));
      prev = p;
      assert.ok(Math.abs(p.x) < 8.3 && p.z < 2.1 && p.z > -L - 2.1 && p.y > 0.5, `stays inside the hall at frame ${i}`);
    }
    assert.ok(widest > SWAP.radius - 0.05, `swings wide enough to see the other tables (${widest.toFixed(2)} m)`);
    assert.ok(highest > SWAP.height - 0.05, "rises over the tables");
    assert.ok(step < 0.25, `smooth at 60 fps (largest step ${step.toFixed(3)} m)`);
    assert.ok(dist(at(1 / frames).pos, from.pos) < 0.01 && dist(at(1 - 1 / frames).pos, to.pos) < 0.01, "eases in and out");
    assert.ok(Math.abs(at(0.5).pos.x) > 4, "the camera is out to the side of the hall mid-flight");
  }
});

test("new follow never yanks back when a hit hands the lead to another weight", () => {
  const shot = (): Body[] => [
    { x: 0, d: TABLE.launchD, vx: 0, vd: speedForDistance(6.5 - TABLE.launchD), active: true },
    { x: 0.03, d: 3, vx: 0, vd: 0, active: true },
  ];
  const before = run(oldFollow(), shot(), 60);
  const after = run(newFollow(), shot(), 60);
  assert.ok(before.backstep > 0, "old follow jumped backwards");
  assert.equal(after.backstep, 0);
});
