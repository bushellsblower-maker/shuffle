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
 * Critically damped spring toward `target` (Game Programming Gems 4 "SmoothDamp").
 * Stable for any frame time and never overshoots a target it is closing on.
 */
export function smoothDamp(s: Spring, target: number, smoothTime: number, dt: number): void {
  const omega = 2 / smoothTime;
  const x = omega * dt;
  const decay = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const change = s.value - target;
  const temp = (s.vel + omega * change) * dt;
  let next = target + (change + temp) * decay;
  let vel = (s.vel - omega * temp) * decay;
  if (target - s.value > 0 === next > target) {
    next = target;
    vel = 0;
  }
  s.value = next;
  s.vel = vel;
}
