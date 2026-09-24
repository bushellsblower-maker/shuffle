import { stoppingDistance } from "./physics.ts";

/**
 * Where the follow camera should aim for one sliding weight: a little ahead of
 * it, toward where it will stop, so the camera arrives with it instead of
 * trailing. Never past the stopping point of a straight slide.
 */
export function followLead(d: number, vd: number, speed: number): number {
  if (speed <= 0.05) return -Infinity;
  return d + Math.min(1.4, 0.4 * stoppingDistance(speed) * Math.max(0, vd / speed));
}

/** min(a, b) with a rounded corner of width ~k, so a value easing into the limit slows instead of stopping. */
export function smoothMin(a: number, b: number, k: number): number {
  const m = Math.min(a, b);
  return m - k * Math.log(Math.exp((m - a) / k) + Math.exp((m - b) / k));
}

export interface Spring {
  value: number;
  vel: number;
}

/**
 * Critically damped spring toward `target`, solved exactly for a target held
 * over the step, so it traces the same path at any frame rate. Position and
 * velocity stay continuous; from rest it never overshoots.
 */
export function smoothDamp(s: Spring, target: number, smoothTime: number, dt: number): void {
  const w = 2 / smoothTime;
  const c1 = s.value - target;
  const c2 = s.vel + w * c1;
  const e = Math.exp(-w * dt);
  s.value = target + (c1 + c2 * dt) * e;
  s.vel = (c2 - w * (c1 + c2 * dt)) * e;
}

/** 0 → 1 over u = 0..1 with zero slope and curvature at both ends (quintic smootherstep). */
export function smootherstep(u: number): number {
  const k = Math.min(1, Math.max(0, u));
  return k * k * k * (k * (k * 6 - 15) + 10);
}

/**
 * What is left at time `t` of an offset that starts at `p0` moving at `v0` and
 * eases to rest at 0 after `dur` (quintic Hermite). Position, velocity, and
 * acceleration are all continuous at both ends, so a camera blended with it
 * never kicks when a move starts or stops. Closed form in `t`: frame-rate independent.
 */
export function easeOffset(p0: number, v0: number, t: number, dur: number): number {
  if (t >= dur) return 0;
  const u = Math.max(0, t) / dur;
  const u3 = u * u * u;
  const u4 = u3 * u;
  const u5 = u4 * u;
  return p0 * (1 - 10 * u3 + 15 * u4 - 6 * u5) + v0 * dur * (u - 6 * u3 + 8 * u4 - 3 * u5);
}
