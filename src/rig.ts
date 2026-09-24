import { TABLE, type End } from "./rules.ts";
import { easeOffset, smoothDamp, smoothMin, smootherstep, type Spring } from "./smooth.ts";
import { SWAP, swapPose, type Vec3 } from "./swap.ts";

const L = TABLE.length;
const FOCUS_STEP = 1 / 240;
export const CENTRE: Vec3 = { x: 0, y: 0, z: -L / 2 };

export type CameraMode = "aim" | "follow" | "head" | "overview";

/** How a switch into a mode blends from wherever the camera is. */
interface Blend {
  /** Seconds for a blend that barely moves. */
  base: number;
  /** Extra seconds per metre the camera (or its look point) has to travel. */
  perMetre: number;
  /** Longest a blend may take (s). */
  max: number;
  /** Look-point blend time as a multiple of the position's: < 1 turns first, > 1 keeps looking back while it travels. */
  look: number;
}

/**
 * Camera feel. Every move is time-based (closed form or exactly solved), so it
 * is the same at 30, 60, or 144 fps; a higher frame rate only samples it finer.
 *
 * - `followSmooth`: smooth time (s) of the critically damped spring chasing the
 *   look-ahead point while a weight slides. Lower sticks tighter; higher floats.
 * - `engage`: seconds for that look-ahead to ramp in after the throw, so the
 *   camera pulls away from the aim view instead of lurching after the weight.
 * - `blend`: per mode, how switching into it eases out the old view (quintic, so
 *   no kick in speed or acceleration when it starts or lands, and the camera's
 *   current velocity carries into the move). See `Blend`.
 * - `blendPerSpeed`: extra blend seconds per m/s the camera is already moving, so
 *   a camera caught mid-flight (a throw during the return) turns round gently.
 * - `envSmooth`: smooth time (s) for the reflections turning with the end when
 *   the ends change without the fly-around.
 */
export const CAMERA = {
  followSmooth: 0.3,
  engage: 0.6,
  blend: {
    aim: { base: 0.55, perMetre: 0.1, max: 1.5, look: 1.15 },
    follow: { base: 0.4, perMetre: 0.1, max: 0.8, look: 0.8 },
    head: { base: 0.6, perMetre: 0.1, max: 1.4, look: 1 },
    overview: { base: 1, perMetre: 0.08, max: 2, look: 1.1 },
  } satisfies Record<CameraMode, Blend>,
  blendPerSpeed: 0.07,
  envSmooth: 0.4,
} as const;

/**
 * Free roam from the menu. World frame, metres; the hall walls are at x = ±8.6
 * and 2.2 m past each end of the table, the floor at y = -0.92.
 */
export const ROAM = {
  /** Box the camera stays inside: just inside the walls, above the floor, under a notional ceiling. */
  camera: { x: 8.1, yMin: -0.55, yMax: 4.6, zMin: -L - 2.05, zMax: 2.05 },
  /** Box the orbit pivot can be panned around in. */
  pivot: { x: 6, yMin: -0.6, yMax: 1.2, zMin: -L - 1.2, zMax: 1.2 },
  minDistance: 0.8,
  maxDistance: 9,
  /** Furthest the camera can drop from overhead (radians from straight up): just above level. */
  maxPolar: Math.PI * 0.48,
} as const;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Keep a free-roam camera and its pivot inside the hall, in place. */
export function clampRoam(pos: Vec3, pivot: Vec3): void {
  const c = ROAM.camera;
  const p = ROAM.pivot;
  pos.x = clamp(pos.x, -c.x, c.x);
  pos.y = clamp(pos.y, c.yMin, c.yMax);
  pos.z = clamp(pos.z, c.zMin, c.zMax);
  pivot.x = clamp(pivot.x, -p.x, p.x);
  pivot.y = clamp(pivot.y, p.yMin, p.yMax);
  pivot.z = clamp(pivot.z, p.zMin, p.zMax);
}

const v3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });
const set = (o: Vec3, s: Vec3) => {
  o.x = s.x;
  o.y = s.y;
  o.z = s.z;
};
const put = (o: Vec3, x: number, y: number, z: number) => {
  o.x = x;
  o.y = y;
  o.z = z;
};
const len = (a: Vec3) => Math.hypot(a.x, a.y, a.z);

interface ActiveBlend {
  t: number;
  pos: { dur: number; p0: Vec3; v0: Vec3 };
  look: { dur: number; p0: Vec3; v0: Vec3 };
}

interface Swap {
  t: number;
  from: { pos: Vec3; look: Vec3 };
  hall: Vec3;
  side: 1 | -1;
  yaw0: number;
}

/**
 * Where the main camera is and where it looks, in world space. `Stage` feeds
 * it the mode and end and copies `pos`/`look` onto the Three.js camera.
 */
export class CameraRig {
  readonly pos = v3(0, 3, 4);
  readonly look = v3(0, 0, -3);
  /** Camera velocity over the last frame (m/s), carried into the next blend. */
  readonly vel = v3();
  readonly lookVel = v3();
  portrait = true;
  /** 0..1: how far the house lights are up for the end-swap fly-around. */
  reveal = 0;
  /** Yaw of the environment reflections (radians): turned half round with the end so both ends reflect the same room. */
  readonly envYaw: Spring = { value: 0, vel: 0 };

  private modeNow: CameraMode = "overview";
  private endNow: End = 0;
  private time = 0;
  private held = false;
  /** Follow cam: where the caller wants to look, where the shot started, and the spring-smoothed value used. */
  private focusTarget: number = TABLE.launchD;
  private focusStart: number = TABLE.launchD;
  private readonly focus: Spring = { value: TABLE.launchD, vel: 0 };
  /** Ramped spring target at the end of the last frame, so each frame's substeps can sweep from it. */
  private focusAim: number = TABLE.launchD;
  private engaged = 0;
  private readonly wantPos = v3();
  private readonly wantLook = v3();
  private blend: ActiveBlend | null = null;
  private swap: Swap | null = null;

  get mode(): CameraMode {
    return this.modeNow;
  }

  get end(): End {
    return this.endNow;
  }

  /** True while the end-swap fly-around is playing. */
  get swapping(): boolean {
    return this.swap !== null;
  }

  /** True while a mode-change blend is still easing in. */
  get blending(): boolean {
    return this.blend !== null;
  }

  /** Smoothed distance down the table the follow cam is centred on. */
  get focusD(): number {
    return this.focus.value;
  }

  setMode(mode: CameraMode, followD?: number): void {
    if (followD !== undefined) this.focusTarget = followD;
    if (mode === this.modeNow) return;
    this.modeNow = mode;
    if (mode === "follow") {
      this.focus.value = this.focusStart = this.focusAim = this.focusTarget;
      this.focus.vel = 0;
      this.engaged = 0;
      // A shot mid fly-around cuts it short; the blend carries on from wherever the camera is.
      this.swap = null;
    }
    // Mid fly-around the swap already lands on the current mode's view.
    if (!this.swap) this.startBlend();
  }

  /** Turn to shoot from `end`. With `animate`, fly out over the hall and land behind it; otherwise just blend over. */
  setEnd(end: End, animate = false): void {
    if (end === this.endNow) return;
    this.endNow = end;
    if (!animate || this.held) {
      this.swap = null;
      this.startBlend();
      return;
    }
    // Alternate which side of the hall the camera swings out over.
    const camSide = end === 1 ? -1 : 1;
    const startAngle = Math.atan2(this.pos.x - CENTRE.x, this.pos.z - CENTRE.z);
    const side = (Math.cos(startAngle) >= 0 ? camSide : -camSide) as 1 | -1;
    this.blend = null;
    this.swap = {
      t: 0,
      from: { pos: { ...this.pos }, look: { ...this.look } },
      hall: v3(-camSide * 2.2, -0.45, CENTRE.z),
      side,
      yaw0: this.envYaw.value,
    };
  }

  snap(): void {
    this.swap = null;
    this.blend = null;
    this.computeWanted();
    set(this.pos, this.wantPos);
    set(this.look, this.wantLook);
    set(this.vel, v3());
    set(this.lookVel, v3());
    this.envYaw.value = this.yawTarget();
    this.envYaw.vel = 0;
  }

  /** Hand the camera to something else (free roam). Mode and end changes are remembered and blended to on `release`. */
  hold(): void {
    this.held = true;
    this.swap = null;
    this.blend = null;
  }

  /** While held: where the other controller put the camera this frame. */
  track(pos: Vec3, look: Vec3, dt: number): void {
    this.measure(pos, look, dt);
    set(this.pos, pos);
    set(this.look, look);
  }

  release(): void {
    if (!this.held) return;
    this.held = false;
    this.startBlend();
  }

  get holding(): boolean {
    return this.held;
  }

  update(dt: number): void {
    this.time += dt;
    if (this.modeNow === "follow") {
      this.engaged += dt;
      const k = smootherstep(this.engaged / CAMERA.engage);
      const aim = this.focusStart + (this.focusTarget - this.focusStart) * k;
      // The target only arrives once a frame; sweep it across fixed-size substeps so a long frame follows the same path as short ones.
      const n = Math.max(1, Math.ceil(dt / FOCUS_STEP));
      for (let i = 1; i <= n; i++) smoothDamp(this.focus, this.focusAim + ((aim - this.focusAim) * i) / n, CAMERA.followSmooth, dt / n);
      this.focusAim = aim;
    }
    this.computeWanted();
    if (this.held) {
      this.reveal *= Math.exp(-dt * 4);
      smoothDamp(this.envYaw, this.yawTarget(), CAMERA.envSmooth, dt);
      return;
    }
    const pos = v3();
    const look = v3();
    if (this.swap) {
      const sw = this.swap;
      sw.t += dt;
      const pose = swapPose(sw.t / SWAP.duration, sw.from, { pos: this.wantPos, look: this.wantLook }, CENTRE, sw.hall, sw.side);
      set(pos, pose.pos);
      set(look, pose.look);
      this.reveal = pose.reveal;
      this.envYaw.value = sw.yaw0 + (this.yawTarget() - sw.yaw0) * pose.progress;
      this.envYaw.vel = 0;
      if (sw.t >= SWAP.duration) this.swap = null;
    } else {
      set(pos, this.wantPos);
      set(look, this.wantLook);
      const b = this.blend;
      if (b) {
        b.t += dt;
        const ease = (out: Vec3, part: ActiveBlend["pos"]) => {
          out.x += easeOffset(part.p0.x, part.v0.x, b.t, part.dur);
          out.y += easeOffset(part.p0.y, part.v0.y, b.t, part.dur);
          out.z += easeOffset(part.p0.z, part.v0.z, b.t, part.dur);
        };
        ease(pos, b.pos);
        ease(look, b.look);
        if (b.t >= Math.max(b.pos.dur, b.look.dur)) this.blend = null;
      }
      this.reveal *= Math.exp(-dt * 4);
      smoothDamp(this.envYaw, this.yawTarget(), CAMERA.envSmooth, dt);
    }
    this.measure(pos, look, dt);
    set(this.pos, pos);
    set(this.look, look);
  }

  private measure(pos: Vec3, look: Vec3, dt: number): void {
    if (dt <= 0) return;
    this.vel.x = (pos.x - this.pos.x) / dt;
    this.vel.y = (pos.y - this.pos.y) / dt;
    this.vel.z = (pos.z - this.pos.z) / dt;
    this.lookVel.x = (look.x - this.look.x) / dt;
    this.lookVel.y = (look.y - this.look.y) / dt;
    this.lookVel.z = (look.z - this.look.z) / dt;
  }

  private yawTarget(): number {
    return this.endNow === 1 ? Math.PI : 0;
  }

  /** Ease out the difference between where the camera is and the new mode's view, keeping its current velocity. */
  private startBlend(): void {
    if (this.held) return;
    this.computeWanted();
    const p0 = v3(this.pos.x - this.wantPos.x, this.pos.y - this.wantPos.y, this.pos.z - this.wantPos.z);
    const l0 = v3(this.look.x - this.wantLook.x, this.look.y - this.wantLook.y, this.look.z - this.wantLook.z);
    const cfg: Blend = CAMERA.blend[this.modeNow];
    const dur = Math.min(cfg.max, cfg.base + cfg.perMetre * Math.max(len(p0), len(l0))) + CAMERA.blendPerSpeed * len(this.vel);
    this.blend = {
      t: 0,
      pos: { dur, p0, v0: { ...this.vel } },
      look: { dur: dur * cfg.look, p0: l0, v0: { ...this.lookVel } },
    };
  }

  /** Wanted camera pose for the current mode, in world space. */
  private computeWanted(): void {
    const portrait = this.portrait;
    const p = this.wantPos;
    const l = this.wantLook;
    switch (this.modeNow) {
      case "aim":
        if (portrait) {
          put(p, 0, 1.3, 1.55);
          put(l, 0, 0, -2.9);
        } else {
          put(p, 0, 1.25, 1.8);
          put(l, 0, 0, -3.1);
        }
        break;
      case "follow": {
        // Soft limits: a hard min() makes the camera stop dead and kinks its pitch near the far end.
        const d = smoothMin(this.focus.value, L - 1.2, 0.3);
        put(p, 0, portrait ? 1.15 : 0.85, -d + (portrait ? 2.1 : 1.8));
        put(l, 0, 0, -smoothMin(d + 2.6, L, 0.35));
        break;
      }
      case "head":
        put(p, 0, portrait ? 1.9 : 1.3, -L + 2.0);
        put(l, 0, 0, -L + (portrait ? 1.0 : 0.95));
        break;
      case "overview":
        put(p, Math.sin(this.time * 0.15) * 1.6, 2.2, 1.2 + Math.cos(this.time * 0.15) * 0.8);
        put(l, 0, 0, -4.2);
        break;
    }
    toWorld(this.endNow, p);
    toWorld(this.endNow, l);
  }
}

/** Shooter-relative scene point → world, in place. End 1 is a half turn about the table centre. */
export function toWorld<T extends Vec3>(end: End, v: T): T {
  if (end === 1) {
    v.x = -v.x;
    v.z = -L - v.z;
  }
  return v;
}
