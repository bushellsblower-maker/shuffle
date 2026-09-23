import { TABLE, onTable } from "./rules.ts";

/** Waxed-wood slide: constant (Coulomb) deceleration plus a little air/drag. */
export const FRICTION = 1.55;
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

function integrate(b: Body, dt: number): void {
  const speed = Math.hypot(b.vx, b.vd);
  if (speed === 0) return;
  const decel = FRICTION + DRAG * speed;
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
  constructor(bodies: Body[] = []) {
    this.bodies = bodies;
  }

  step(dt: number): PhysicsEvent[] {
    const events: PhysicsEvent[] = [];
    this.acc = Math.min(this.acc + dt, 0.12);
    while (this.acc >= SUBSTEP) {
      this.acc -= SUBSTEP;
      for (const b of this.bodies) if (b.active) integrate(b, SUBSTEP);
      collide(this.bodies, events);
      checkEdges(this.bodies, events);
    }
    return events;
  }

  get moving(): boolean {
    return this.bodies.some(isMoving);
  }
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
