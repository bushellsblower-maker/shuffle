import { TABLE, onTable } from "./rules.ts";

/**
 * Shuffleboard sand (silicone beads on the wax) and its tuning knobs.
 *
 * - `glide`: multiplier on bare-wood friction. The beads roll under the weight,
 *   so every slide goes a little further than on bare wax.
 * - `drift`: peak sideways push (m/s²) from lumpy patches of sand. It bends the
 *   path without adding speed, and fades out as the weight stops.
 * - `grip`: ± fraction of friction that varies patch to patch, so the same
 *   power doesn't always stop on the same spot.
 * - `cell`: patch size (m) of the sand field.
 *
 * The field is re-sprinkled for every shot from a seed both the room and the
 * browsers know before the throw (`sandSeed`), so online replays still match
 * the room exactly while identical flicks land slightly differently.
 * Set `drift` and `grip` to 0 for a perfectly predictable table.
 */
export const SAND = {
  glide: 0.93,
  drift: 0.09,
  grip: 0.045,
  cell: 0.32,
} as const;

/** Bare waxed wood: constant (Coulomb) deceleration. */
export const WOOD_FRICTION = 1.55;
/** Effective sliding friction on sanded wax, plus a little air/drag. */
export const FRICTION = WOOD_FRICTION * SAND.glide;
export const DRAG = 0.1;
export const RESTITUTION = 0.9;
export const STOP_SPEED = 0.012;
export const MAX_SPEED = 6.2;
const SUBSTEP = 1 / 240;

export interface Body {
  x: number;
  d: number;
  vx: number;
  vd: number;
  /** Still on the playing surface and taking part in the simulation. */
  active: boolean;
}

export type PhysicsEvent =
  | { type: "hit"; a: number; b: number; impulse: number }
  | { type: "fall"; body: number; edge: "side" | "end" | "near" };

export function isMoving(b: Body): boolean {
  return b.active && (b.vx !== 0 || b.vd !== 0);
}

/** Integer hash → [-1, 1). Pure 32-bit integer maths, so every JS engine agrees. */
function hash(ix: number, iy: number, seed: number, salt: number): number {
  let h = Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iy, 0x165667b1) ^ Math.imul(seed, 0x9e3779b1) ^ salt;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca77);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae3d);
  h ^= h >>> 16;
  return (h >>> 0) / 2147483648 - 1;
}

/** Smooth value noise in [-1, 1] over `SAND.cell`-sized patches. */
function patch(x: number, d: number, seed: number, salt: number): number {
  const u = x / SAND.cell + 64;
  const v = d / SAND.cell + 64;
  const ix = Math.floor(u);
  const iv = Math.floor(v);
  const fx = u - ix;
  const fv = v - iv;
  const sx = fx * fx * (3 - 2 * fx);
  const sv = fv * fv * (3 - 2 * fv);
  const a = hash(ix, iv, seed, salt);
  const b = hash(ix + 1, iv, seed, salt);
  const c = hash(ix, iv + 1, seed, salt);
  const e = hash(ix + 1, iv + 1, seed, salt);
  return a + (b - a) * sx + (c - a) * sv + (a - b - c + e) * sx * sv;
}

/** Sand under a point: sideways push and friction change, both in [-1, 1]. */
export function sandAt(seed: number, x: number, d: number): { drift: number; grip: number } {
  return { drift: patch(x, d, seed, 0x51ed), grip: patch(x, d, seed, 0x2c1b) };
}

/** Seed of the sand field for one shot. Both ends of an online game derive it from the room's match state. */
export function sandSeed(matchSeed: number, round: number, shotIndex: number): number {
  return (Math.imul(matchSeed | 0, 0x2545f491) ^ Math.imul(round | 0, 0x9e3779b9) ^ Math.imul((shotIndex | 0) + 1, 0x632be5ab)) | 0;
}

function integrate(b: Body, dt: number, sand: number | null = null): void {
  const speed = Math.hypot(b.vx, b.vd);
  if (speed === 0) return;
  let decel = FRICTION + DRAG * speed;
  let drift = 0;
  if (sand !== null) {
    const s = sandAt(sand, b.x, b.d);
    decel *= 1 + SAND.grip * s.grip;
    drift = SAND.drift * s.drift * Math.min(1, speed / 0.6);
  }
  const next = speed - decel * dt;
  if (next <= STOP_SPEED) {
    const t = Math.min(dt, speed / decel);
    const avg = speed / 2;
    b.x += (b.vx / speed) * avg * t;
    b.d += (b.vd / speed) * avg * t;
    b.vx = 0;
    b.vd = 0;
    return;
  }
  const avg = (speed + next) / 2;
  b.x += (b.vx / speed) * avg * dt;
  b.d += (b.vd / speed) * avg * dt;
  if (drift !== 0) {
    // Turn the velocity sideways, then restore its magnitude: sand steers, it never pushes.
    const turn = (drift * dt) / speed;
    const vx = b.vx + b.vd * turn;
    const vd = b.vd - b.vx * turn;
    const k = next / Math.hypot(vx, vd);
    b.vx = vx * k;
    b.vd = vd * k;
    return;
  }
  const k = next / speed;
  b.vx *= k;
  b.vd *= k;
}

function collide(bodies: Body[], events: PhysicsEvent[]): void {
  const r2 = TABLE.puckRadius * 2;
  for (let i = 0; i < bodies.length; i++) {
    const a = bodies[i];
    if (!a.active) continue;
    for (let j = i + 1; j < bodies.length; j++) {
      const b = bodies[j];
      if (!b.active) continue;
      const dx = b.x - a.x;
      const dd = b.d - a.d;
      const dist2 = dx * dx + dd * dd;
      if (dist2 >= r2 * r2 || dist2 === 0) continue;
      const dist = Math.sqrt(dist2);
      const nx = dx / dist;
      const nd = dd / dist;
      const overlap = r2 - dist;
      a.x -= (nx * overlap) / 2;
      a.d -= (nd * overlap) / 2;
      b.x += (nx * overlap) / 2;
      b.d += (nd * overlap) / 2;
      const rel = (a.vx - b.vx) * nx + (a.vd - b.vd) * nd;
      if (rel <= 0) continue;
      const j2 = ((1 + RESTITUTION) * rel) / 2;
      a.vx -= j2 * nx;
      a.vd -= j2 * nd;
      b.vx += j2 * nx;
      b.vd += j2 * nd;
      events.push({ type: "hit", a: i, b: j, impulse: j2 });
    }
  }
}

function checkEdges(bodies: Body[], events: PhysicsEvent[]): void {
  bodies.forEach((b, i) => {
    if (!b.active || onTable(b.x, b.d)) return;
    b.active = false;
    const edge = b.d > TABLE.length ? "end" : b.d < 0 ? "near" : "side";
    events.push({ type: "fall", body: i, edge });
  });
}

export class World {
  private acc = 0;
  bodies: Body[];
  /** Sand field seed for the current shot (`sandSeed`); null slides on perfectly even wax. */
  sand: number | null;
  constructor(bodies: Body[] = [], sand: number | null = null) {
    this.bodies = bodies;
    this.sand = sand;
  }

  step(dt: number): PhysicsEvent[] {
    const events: PhysicsEvent[] = [];
    this.acc = Math.min(this.acc + dt, 0.12);
    while (this.acc >= SUBSTEP) {
      this.acc -= SUBSTEP;
      for (const b of this.bodies) if (b.active) integrate(b, SUBSTEP, this.sand);
      collide(this.bodies, events);
      checkEdges(this.bodies, events);
    }
    return events;
  }

  get moving(): boolean {
    return this.bodies.some(isMoving);
  }
}

/** Closed-form distance to rest from `speed` under friction + drag (cheap enough to call per frame). */
export function stoppingDistance(speed: number): number {
  if (speed <= 0) return 0;
  return speed / DRAG - (FRICTION / (DRAG * DRAG)) * Math.log1p((DRAG * speed) / FRICTION);
}

/** How far a lone weight launched at `speed` slides before stopping. */
export function slideDistance(speed: number): number {
  const b: Body = { x: 0, d: 0, vx: 0, vd: speed, active: true };
  let t = 0;
  while ((b.vd !== 0 || b.vx !== 0) && t < 30) {
    integrate(b, SUBSTEP);
    t += SUBSTEP;
  }
  return b.d;
}

/** Launch speed that slides a lone weight `distance` metres. */
export function speedForDistance(distance: number): number {
  let lo = 0;
  let hi = MAX_SPEED * 1.5;
  for (let i = 0; i < 32; i++) {
    const mid = (lo + hi) / 2;
    if (slideDistance(mid) < distance) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}
