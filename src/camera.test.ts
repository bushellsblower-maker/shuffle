import assert from "node:assert/strict";
import { test } from "node:test";
import { TABLE } from "./rules.ts";
import { World, slideDistance, stoppingDistance, speedForDistance, type Body } from "./physics.ts";
import { CAMERA, CENTRE, CameraRig, ROAM, clampRoam, type CameraMode } from "./rig.ts";
import { WALL_SIGN } from "./scene.ts";
import { easeOffset, followLead, smoothDamp, smoothMin, smootherstep, type Spring } from "./smooth.ts";
import { SWAP, swapPose, type Vec3 } from "./swap.ts";

const L = TABLE.length;
const dist = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/* ---------- harness ---------- */

type Fps = number | "jitter";

function frameTimes(fps: Fps): () => number {
  let i = 0;
  // A phone that can't hold its rate: mostly 60, with 30/45/120/20 fps frames mixed in.
  if (fps === "jitter") return () => [1 / 60, 1 / 60, 1 / 30, 1 / 45, 1 / 120, 1 / 20][i++ % 6];
  // Real vsync never lands on exactly 1/fps; a ±3% wobble exposes fixed-step aliasing.
  return () => (1 / fps) * (1 + 0.03 * Math.sin(i++ * 1.7));
}

interface Rig {
  setMode(mode: CameraMode, followD?: number): void;
  update(dt: number): void;
  snap(): void;
  readonly pos: Vec3;
  readonly look: Vec3;
  readonly focusD: number;
}

interface Frame {
  t: number;
  dt: number;
  pos: Vec3;
  look: Vec3;
  focus: number;
  /** Furthest live weight, as drawn. */
  lead: number;
  phase: "aim" | "follow" | "resolve" | "return";
}

/**
 * Drive a rig the way main.ts does through one shot: sit on the aim view,
 * throw, follow until everything stops, wait out the resolve (0.45 s still +
 * 0.35 s), then return to aim.
 */
function simulateShot(rig: Rig, bodies: Body[], fps: Fps, interp = true): Frame[] {
  const next = frameTimes(fps);
  const world = new World([]);
  const out: Frame[] = [];
  const drawn = (b: Body) => (interp ? world.drawn(b) : b);
  const record = (phase: Frame["phase"], t: number, dt: number) => {
    const lead = Math.max(...bodies.filter((b) => b.active).map((b) => drawn(b).d));
    out.push({ t, dt, pos: { ...rig.pos }, look: { ...rig.look }, focus: rig.focusD, lead, phase });
  };
  rig.setMode("aim");
  rig.snap();
  let t = 0;
  while (t < 0.5) {
    const dt = next();
    t += dt;
    rig.update(dt);
    record("aim", t, dt);
  }
  world.bodies = bodies;
  let followD: number = TABLE.launchD;
  rig.setMode("follow", followD);
  let phase: Frame["phase"] = "follow";
  let wait = 0;
  for (let n = 0; n < 60 * 40; n++) {
    const dt = next();
    t += dt;
    if (phase === "follow") {
      world.step(dt);
      for (const b of bodies) {
        if (b.active) followD = Math.max(followD, followLead(drawn(b).d, b.vd, Math.hypot(b.vx, b.vd)));
      }
      rig.setMode("follow", followD);
      if (!world.moving) phase = "resolve";
    } else if (phase === "resolve") {
      if ((wait += dt) > 0.8) {
        phase = "return";
        wait = 0;
        rig.setMode("aim");
      }
    } else if ((wait += dt) > 2.5) break;
    rig.update(dt);
    record(phase, t, dt);
  }
  return out;
}

const lone = (distance: number): Body[] => [
  { x: 0, d: TABLE.launchD, vx: 0, vd: speedForDistance(distance - TABLE.launchD), active: true },
];

/** Peak acceleration (m/s²) and largest one-frame velocity change (m/s) of a point over frames [from, to). */
function motion(frames: Frame[], key: "pos" | "look", from: number, to: number): { accel: number; kick: number } {
  const vel = (i: number) => {
    const a = frames[i - 1][key];
    const b = frames[i][key];
    const dt = frames[i].dt;
    return { x: (b.x - a.x) / dt, y: (b.y - a.y) / dt, z: (b.z - a.z) / dt };
  };
  let accel = 0;
  let kick = 0;
  for (let i = Math.max(2, from); i < Math.min(to, frames.length); i++) {
    const dv = dist(vel(i), vel(i - 1));
    kick = Math.max(kick, dv);
    accel = Math.max(accel, dv / ((frames[i].dt + frames[i - 1].dt) / 2));
  }
  return { accel, kick };
}

/** Frame index ranges of each part of a simulated shot; engage is the first 0.8 s of the follow. */
function parts(f: Frame[]) {
  const follow = f.findIndex((x) => x.phase === "follow");
  const resolve = f.findIndex((x) => x.phase === "resolve");
  const back = f.findIndex((x) => x.phase === "return");
  const engaged = f.findIndex((x) => x.t > f[follow].t + 0.8);
  return { follow, resolve, back, engaged, end: f.length };
}

/**
 * The camera as Stage drove it before `CameraRig` (end 0, portrait): a
 * Padé-approximated spring that stopped dead at its target, no look-ahead ramp,
 * and mode changes easing out an offset exponentially from full speed.
 */
class LegacyRig implements Rig {
  readonly pos: Vec3 = { x: 0, y: 3, z: 4 };
  readonly look: Vec3 = { x: 0, y: 0, z: -3 };
  private mode: CameraMode = "overview";
  private target: number = TABLE.launchD;
  private focus: Spring = { value: TABLE.launchD, vel: 0 };
  private want = { pos: { x: 0, y: 0, z: 0 }, look: { x: 0, y: 0, z: 0 } };
  private posOff = { x: 0, y: 0, z: 0 };
  private lookOff = { x: 0, y: 0, z: 0 };
  private rate = 3;

  get focusD(): number {
    return this.focus.value;
  }

  setMode(mode: CameraMode, followD?: number): void {
    if (followD !== undefined) this.target = followD;
    if (mode === this.mode) return;
    if (mode === "follow") this.focus = { value: this.target, vel: 0 };
    this.mode = mode;
    this.wanted();
    this.posOff = { x: this.pos.x - this.want.pos.x, y: this.pos.y - this.want.pos.y, z: this.pos.z - this.want.pos.z };
    this.lookOff = { x: this.look.x - this.want.look.x, y: this.look.y - this.want.look.y, z: this.look.z - this.want.look.z };
    this.rate = mode === "follow" ? 6 : 3;
  }

  snap(): void {
    this.wanted();
    Object.assign(this.pos, this.want.pos);
    Object.assign(this.look, this.want.look);
    this.posOff = { x: 0, y: 0, z: 0 };
    this.lookOff = { x: 0, y: 0, z: 0 };
  }

  update(dt: number): void {
    if (this.mode === "follow") {
      const s = this.focus;
      const omega = 2 / 0.26;
      const x = omega * dt;
      const decay = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
      const change = s.value - this.target;
      const temp = (s.vel + omega * change) * dt;
      let next = this.target + (change + temp) * decay;
      let vel = (s.vel - omega * temp) * decay;
      if (this.target - s.value > 0 === next > this.target) {
        next = this.target;
        vel = 0;
      }
      s.value = next;
      s.vel = vel;
    }
    this.wanted();
    const keep = Math.exp(-dt * this.rate);
    for (const k of ["x", "y", "z"] as const) {
      this.posOff[k] *= keep;
      this.lookOff[k] *= keep;
      this.pos[k] = this.want.pos[k] + this.posOff[k];
      this.look[k] = this.want.look[k] + this.lookOff[k];
    }
  }

  private wanted(): void {
    const { pos, look } = this.want;
    if (this.mode === "aim") {
      Object.assign(pos, { x: 0, y: 1.3, z: 1.55 });
      Object.assign(look, { x: 0, y: 0, z: -2.9 });
    } else if (this.mode === "follow") {
      const d = smoothMin(this.focus.value, L - 1.2, 0.3);
      Object.assign(pos, { x: 0, y: 1.15, z: -d + 2.1 });
      Object.assign(look, { x: 0, y: 0, z: -smoothMin(d + 2.6, L, 0.35) });
    } else {
      Object.assign(pos, { x: 0, y: 2.2, z: 2 });
      Object.assign(look, { x: 0, y: 0, z: -4.2 });
    }
  }
}

const RATES: Fps[] = [30, 60, 144, "jitter"];
const THROWS = [2.5, 4.5, 6.6, 7.0];

/* ---------- building blocks ---------- */

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

test("smoothDamp is critically damped and lands in the same place at any frame rate", () => {
  const run = (dt: number) => {
    const s: Spring = { value: 0, vel: 0 };
    let peak = 0;
    let at05 = 0;
    for (let t = 0; t < 2 - 1e-9; t += dt) {
      smoothDamp(s, 1, 0.26, dt);
      peak = Math.max(peak, s.value);
      if (Math.abs(t + dt - 0.5) < dt / 2) at05 = s.value;
    }
    return { peak, value: s.value, at05 };
  };
  const ref = run(1 / 1000);
  for (const dt of [1 / 144, 1 / 60, 1 / 30, 1 / 10]) {
    const r = run(dt);
    assert.ok(r.peak <= 1, `no overshoot at dt=${dt}`);
    assert.ok(Math.abs(r.value - 1) < 1e-3, `settles at dt=${dt}`);
    assert.ok(Math.abs(r.at05 - ref.at05) < 1e-6, `same path at dt=${dt}`);
  }
});

test("easeOffset starts with the given offset and velocity and lands at rest with no kick", () => {
  const dur = 1.2;
  const h = 1e-5;
  const at = (t: number) => easeOffset(2, -3, t, dur);
  assert.ok(Math.abs(at(0) - 2) < 1e-12);
  assert.ok(Math.abs((at(h) - at(0)) / h + 3) < 1e-3, "keeps the starting velocity");
  assert.equal(at(dur), 0);
  assert.ok(Math.abs(at(dur - h)) < 1e-9, "arrives at rest");
  const acc = (t: number) => (at(t + h) - 2 * at(t) + at(t - h)) / (h * h);
  assert.ok(Math.abs(acc(h)) < 0.05 && Math.abs(acc(dur - h)) < 0.05, "no acceleration step at either end");
  let prev = Infinity;
  for (let t = 0; t <= dur; t += 0.01) {
    const v = easeOffset(1, 0, t, dur);
    assert.ok(v <= prev && v >= 0, "from rest it never overshoots");
    prev = v;
  }
  assert.ok(Math.abs(smootherstep(0.5) - 0.5) < 1e-12);
  assert.equal(smootherstep(-1), 0);
  assert.equal(smootherstep(2), 1);
});

test("weights are drawn with even motion at any frame rate (substep interpolation)", () => {
  for (const fps of [60, 90, 120, 144] as const) {
    for (const interp of [false, true]) {
      const b: Body = { x: 0, d: TABLE.launchD, vx: 0, vd: 4, active: true };
      const world = new World([b]);
      const next = frameTimes(fps);
      let prev: number = TABLE.launchD;
      let worst = 0;
      for (let n = 0; n < 40; n++) {
        const dt = next();
        world.step(dt);
        const d = interp ? world.drawn(b).d : b.d;
        // Drawn speed vs true speed over this frame; 0 is perfectly even.
        if (n > 1) worst = Math.max(worst, Math.abs((d - prev) / dt / Math.hypot(b.vx, b.vd) - 1));
        prev = d;
      }
      if (interp) assert.ok(worst < 0.1, `fps=${fps} drawn speed off by ${(worst * 100).toFixed(0)}%`);
      else assert.ok(worst > 0.2, `fps=${fps}: raw substeps judder (${(worst * 100).toFixed(0)}%), which is why drawn() exists`);
    }
  }
  const still: Body = { x: 0.1, d: 3, vx: 0, vd: 0, active: true };
  const w = new World([still]);
  w.step(1 / 60);
  still.d = 5;
  assert.equal(w.drawn(still).d, 5, "a weight put somewhere by hand is drawn there at once");
});

/* ---------- follow and return ---------- */

test("follow cam keeps the weight in frame, never overshoots its rest, never steps back", () => {
  for (const fps of RATES) {
    for (const d of THROWS) {
      const f = simulateShot(new CameraRig(), lone(d), fps);
      const p = parts(f);
      const rest = f[p.resolve].lead;
      const at = `fps=${fps} throw=${d}`;
      let lag = 0;
      let over = 0;
      let back = 0;
      let settle = 0;
      for (let i = p.follow; i < p.resolve; i++) lag = Math.max(lag, f[i].lead - f[i].focus);
      for (let i = p.follow; i < p.back; i++) over = Math.max(over, f[i].focus - rest);
      for (let i = p.follow + 1; i < p.back; i++) back = Math.max(back, f[i - 1].focus - f[i].focus);
      for (let i = p.resolve; i < p.back; i++) if (Math.abs(f[i].focus - rest) > 0.05) settle = f[i].t - f[p.resolve].t;
      // The view looks 2.6 m past the focus, so 1.4 m of lag still has the weight well up the screen.
      assert.ok(lag < 1.4, `${at} lag ${lag.toFixed(2)}`);
      assert.ok(over < 0.02, `${at} overshoot ${over.toFixed(3)}`);
      assert.equal(back, 0, `${at} never moves back`);
      assert.ok(settle < 0.25, `${at} settles ${settle.toFixed(2)} s after the weight stops`);
    }
  }
});

test("follow never yanks back when a hit hands the lead to another weight", () => {
  const shot = (): Body[] => [
    { x: 0, d: TABLE.launchD, vx: 0, vd: speedForDistance(6.5 - TABLE.launchD), active: true },
    { x: 0.03, d: 3, vx: 0, vd: 0, active: true },
  ];
  const backstep = (f: Frame[]) => {
    const p = parts(f);
    let back = 0;
    for (let i = p.follow + 1; i < p.back; i++) back = Math.max(back, f[i - 1].focus - f[i].focus);
    return back;
  };
  for (const fps of RATES) assert.equal(backstep(simulateShot(new CameraRig(), shot(), fps)), 0, `fps=${fps}`);
});

test("no snaps: engaging, chasing, and returning are smooth at every frame rate", () => {
  for (const fps of RATES) {
    for (const d of THROWS) {
      const f = simulateShot(new CameraRig(), lone(d), fps);
      const old = simulateShot(new LegacyRig(), lone(d), fps, false);
      const p = parts(f);
      const q = parts(old);
      const at = `fps=${fps} throw=${d}`;
      const engage = motion(f, "pos", p.follow - 1, p.engaged);
      const chase = motion(f, "pos", p.engaged, p.back);
      const ret = motion(f, "pos", p.back - 1, p.end);
      const retLook = motion(f, "look", p.back - 1, p.end);
      const oldRet = motion(old, "pos", q.back - 1, q.end);
      // Budgets in m/s². The old camera hit 125 on engage and 400–2400 on return (a velocity step).
      assert.ok(engage.accel < 40, `${at} engage ${engage.accel.toFixed(0)} m/s²`);
      assert.ok(chase.accel < 30, `${at} chase ${chase.accel.toFixed(0)} m/s²`);
      assert.ok(ret.accel < 30 && retLook.accel < 30, `${at} return ${ret.accel.toFixed(0)} / look ${retLook.accel.toFixed(0)} m/s²`);
      assert.ok(ret.accel * 8 < oldRet.accel, `${at} return ${ret.accel.toFixed(0)} vs old ${oldRet.accel.toFixed(0)} m/s²`);
    }
  }
});

test("a snap can't hide behind a high frame rate: velocity steps shrink with the frame time", () => {
  for (const d of [4.5, 7.0]) {
    const kicks = (rig: () => Rig, interp: boolean) =>
      ([60, 144] as const).map((fps) => {
        const f = simulateShot(rig(), lone(d), fps, interp);
        const p = parts(f);
        return Math.max(motion(f, "pos", p.follow - 1, p.engaged).kick, motion(f, "pos", p.back - 1, p.end).kick);
      });
    const [n60, n144] = kicks(() => new CameraRig(), true);
    const [o60, o144] = kicks(() => new LegacyRig(), false);
    // Continuous motion: kick ≈ accel × dt, so 144 fps shows well under half the 60 fps kick.
    assert.ok(n144 < n60 * 0.5, `new ${n60.toFixed(2)} → ${n144.toFixed(2)} m/s`);
    assert.ok(n144 < 0.25, `new kick at 144 fps ${n144.toFixed(2)} m/s`);
    // The old one jumped in velocity: no better at 144 than at 60.
    assert.ok(o144 > o60 * 0.9 && o144 > 5, `old ${o60.toFixed(2)} → ${o144.toFixed(2)} m/s`);
  }
});

test("follow and return trace the same path at any frame rate", () => {
  const segment = (f: Frame[], phase: Frame["phase"]) => {
    const i0 = f.findIndex((x) => x.phase === phase);
    const t0 = f[i0 - 1].t;
    return f.filter((x) => x.phase === phase).map((x) => ({ t: x.t - t0, pos: x.pos }));
  };
  const sample = (s: { t: number; pos: Vec3 }[], t: number): Vec3 => {
    const i = s.findIndex((x) => x.t >= t);
    if (i <= 0) return s[Math.max(0, i)].pos;
    const a = s[i - 1];
    const b = s[i];
    const k = (t - a.t) / (b.t - a.t);
    return { x: a.pos.x + (b.pos.x - a.pos.x) * k, y: a.pos.y + (b.pos.y - a.pos.y) * k, z: a.pos.z + (b.pos.z - a.pos.z) * k };
  };
  const ref = simulateShot(new CameraRig(), lone(6.6), 480);
  for (const fps of [20, 30, 60, 144, "jitter"] as const) {
    const f = simulateShot(new CameraRig(), lone(6.6), fps);
    for (const phase of ["follow", "return"] as const) {
      const a = segment(f, phase);
      const r = segment(ref, phase);
      let worst = 0;
      for (const x of a) if (x.t <= r[r.length - 1].t) worst = Math.max(worst, dist(x.pos, sample(r, x.t)));
      assert.ok(worst < 0.03, `fps=${fps} ${phase} strays ${(worst * 100).toFixed(1)} cm from the 480 fps path`);
    }
  }
});

test("changing mode mid-move carries the camera's velocity instead of snapping", () => {
  // A throw during the return, the round ending mid-blend, the menu opening during the return.
  for (const [first, second] of [["aim", "follow"], ["aim", "head"], ["head", "overview"], ["aim", "overview"]] as const) {
    for (const fps of [60, 144]) {
      const rig = new CameraRig();
      rig.setMode("follow", 6);
      rig.update(2);
      rig.snap();
      rig.setMode(first);
      const vel: Vec3[] = [];
      const switchAt = Math.round(0.35 * fps);
      for (let n = 0; n < fps; n++) {
        if (n === switchAt) rig.setMode(second, TABLE.launchD);
        rig.update(1 / fps);
        vel.push({ ...rig.vel });
      }
      const across = dist(vel[switchAt], vel[switchAt - 1]);
      const before = dist(vel[switchAt - 1], vel[switchAt - 2]);
      const at = `${first} → ${second} at ${fps} fps`;
      assert.ok(dist(vel[switchAt - 1], { x: 0, y: 0, z: 0 }) > 3, `${at}: the camera is mid-flight when the mode changes`);
      // No bigger a change than the blend was already making, plus what 40 m/s² adds in one frame.
      assert.ok(across < before + 40 / fps, `${at}: velocity jumped ${across.toFixed(2)} m/s in one frame (was ${before.toFixed(2)})`);
    }
  }
});

test("blend knobs: look turns first into follow, trails a little on the way back", () => {
  assert.ok(CAMERA.blend.follow.look < 1 && CAMERA.blend.aim.look > 1);
  for (const b of Object.values(CAMERA.blend)) assert.ok(b.base > 0 && b.max >= b.base && b.perMetre >= 0);
  assert.ok(CAMERA.engage > 0 && CAMERA.followSmooth > 0);
});

/* ---------- ends, reflections, roam ---------- */

test("the back wall reads exactly: Everyday I'm Shuffling", () => {
  assert.equal(WALL_SIGN.join(" "), "Everyday I'm Shuffling");
});

test("end swap flies out over the hall and lands exactly behind the new end", () => {
  // End 0's HEAD view → end 1's aim view (mirrors what the rig passes in), and back again.
  const cases: { from: { pos: Vec3; look: Vec3 }; to: { pos: Vec3; look: Vec3 }; side: 1 | -1 }[] = [
    { from: { pos: { x: 0, y: 1.9, z: -L + 2 }, look: { x: 0, y: 0, z: -L + 1 } }, to: { pos: { x: 0, y: 1.3, z: -L - 1.55 }, look: { x: 0, y: 0, z: -L + 2.9 } }, side: 1 },
    { from: { pos: { x: 0, y: 1.3, z: -2 }, look: { x: 0, y: 0, z: -1 } }, to: { pos: { x: 0, y: 1.25, z: 1.8 }, look: { x: 0, y: 0, z: -3.1 } }, side: -1 },
  ];
  for (const { from, to, side } of cases) {
    const hall = { x: side * 2.2, y: -0.45, z: CENTRE.z };
    const at = (s: number) => swapPose(s, from, to, CENTRE, hall, side);
    assert.ok(dist(at(0).pos, from.pos) < 1e-9 && dist(at(0).look, from.look) < 1e-9, "starts where the camera is");
    assert.ok(dist(at(1).pos, to.pos) < 1e-9 && dist(at(1).look, to.look) < 1e-9, "ends on the new end's view");
    assert.ok(at(0).reveal < 1e-9 && at(1).reveal < 1e-9 && Math.abs(at(0.5).reveal - 1) < 1e-9, "house lights peak mid-flight");
    assert.ok(at(0).progress === 0 && at(1).progress === 1, "progress runs 0 → 1");

    const frames = Math.round(SWAP.duration * 60);
    let widest = 0;
    let highest = 0;
    let step = 0;
    let prev = at(0).pos;
    for (let i = 1; i <= frames; i++) {
      const p = at(i / frames).pos;
      widest = Math.max(widest, Math.hypot(p.x - CENTRE.x, p.z - CENTRE.z));
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

test("reflections turn with the end, so end 1 sees the same lit room as end 0", () => {
  const rig = new CameraRig();
  rig.setMode("head");
  rig.snap();
  assert.equal(rig.envYaw.value, 0);
  rig.setEnd(1, true);
  rig.setMode("aim");
  let mid = NaN;
  let reveal = 0;
  for (let t = 0; t < SWAP.duration + 0.1; t += 1 / 60) {
    rig.update(1 / 60);
    if (Math.abs(t - SWAP.duration / 2) < 1 / 120) mid = rig.envYaw.value;
    reveal = Math.max(reveal, rig.reveal);
  }
  assert.ok(mid > 0.5 && mid < Math.PI - 0.5, `turning mid-flight (${mid.toFixed(2)})`);
  assert.ok(Math.abs(rig.envYaw.value - Math.PI) < 1e-9, "a half turn once landed at end 1");
  assert.ok(reveal > 0.99 && rig.reveal < 1e-3, "house lights up mid-flight and back down after landing");
  // End 1's aim view is end 0's turned half round about the table centre, reflections included.
  const aim0 = new CameraRig();
  aim0.setMode("aim");
  aim0.snap();
  assert.ok(Math.abs(rig.pos.x + aim0.pos.x) < 1e-9 && Math.abs(rig.pos.z - (-L - aim0.pos.z)) < 1e-9 && Math.abs(rig.pos.y - aim0.pos.y) < 1e-9);

  rig.setEnd(0);
  for (let t = 0; t < 3; t += 1 / 60) rig.update(1 / 60);
  assert.ok(Math.abs(rig.envYaw.value) < 1e-3, "and back without the fly-around");
});

test("a shot mid fly-around takes over smoothly", () => {
  const rig = new CameraRig();
  rig.setMode("head");
  rig.snap();
  rig.setEnd(1, true);
  rig.setMode("aim");
  for (let t = 0; t < 1; t += 1 / 60) rig.update(1 / 60);
  const before = { ...rig.vel };
  rig.setMode("follow", TABLE.launchD);
  rig.update(1 / 60);
  assert.ok(!rig.swapping);
  assert.ok(dist(rig.vel, before) < 0.6, `velocity carried over (${dist(rig.vel, before).toFixed(2)} m/s change)`);
});

test("free roam: stays inside the hall, and hands back without a jump", () => {
  const pos = { x: 20, y: -5, z: 30 };
  const pivot = { x: -20, y: 9, z: -40 };
  clampRoam(pos, pivot);
  assert.deepEqual(pos, { x: ROAM.camera.x, y: ROAM.camera.yMin, z: ROAM.camera.zMax });
  assert.deepEqual(pivot, { x: -ROAM.pivot.x, y: ROAM.pivot.yMax, z: ROAM.pivot.zMin });
  assert.ok(ROAM.camera.x < 8.6 && ROAM.camera.zMax < 2.2 && ROAM.camera.zMin > -L - 2.2 && ROAM.camera.yMin > -0.92, "inside the walls and above the floor");

  const rig = new CameraRig();
  rig.setMode("overview");
  rig.snap();
  rig.hold();
  // The player drags the view round to the side of the hall, still moving when they let go.
  const p = { ...rig.pos };
  const look = { x: 0, y: 0, z: CENTRE.z };
  for (let n = 0; n < 60; n++) {
    p.x += 0.05;
    rig.update(1 / 60);
    rig.track(p, look, 1 / 60);
  }
  // A mode change while roaming (the menu going back to overview) is picked up on release.
  rig.setMode("aim");
  assert.ok(dist(rig.pos, p) < 1e-9, "the rig leaves a held camera alone");
  rig.release();
  const was = { ...rig.pos };
  rig.update(1 / 60);
  assert.ok(dist(rig.pos, was) < 0.06, `first frame back moves ${dist(rig.pos, was).toFixed(3)} m`);
  for (let t = 0; t < 3; t += 1 / 60) rig.update(1 / 60);
  assert.ok(!rig.blending && Math.abs(rig.pos.z - 1.55) < 1e-9, "lands on the aim view");
});
