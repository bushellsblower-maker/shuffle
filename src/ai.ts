import { speedForDistance, MAX_SPEED } from "./physics.ts";
import { TABLE, isLive, zoneOf, type Team } from "./rules.ts";

export const MIN_SPEED = 0.6;
export const MAX_ANGLE = 0.14;

export interface Shot {
  x: number;
  angle: number;
  speed: number;
}

export function powerOf(speed: number): number {
  return Math.max(0, Math.min(1, (speed - MIN_SPEED) / (MAX_SPEED - MIN_SPEED)));
}

export function speedOf(power: number): number {
  return MIN_SPEED + (MAX_SPEED - MIN_SPEED) * power;
}

function gauss(rand: () => number): number {
  return Math.sqrt(-2 * Math.log(rand() || 1e-9)) * Math.cos(2 * Math.PI * rand());
}

const LANE = TABLE.width / 2 - TABLE.puckRadius - 0.02;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

function aimAt(tx: number, td: number, overshoot: number, fromX: number): Shot {
  const x = clamp(fromX, -LANE, LANE);
  const run = td - TABLE.launchD;
  const angle = clamp(Math.atan2(tx - x, run), -MAX_ANGLE, MAX_ANGLE);
  const dist = Math.hypot(tx - x, run);
  return { x, angle, speed: speedForDistance(dist + overshoot) };
}

export function planCpuShot(
  weights: readonly { team: Team; x: number; d: number }[],
  me: Team,
  rand: () => number = Math.random,
): Shot {
  const live = weights.filter(isLive);
  const best = (t: Team) => live.filter((w) => w.team === t).sort((a, b) => b.d - a.d)[0];
  const theirs = best((1 - me) as Team);
  const mine = best(me);

  let shot: Shot;
  const threatening = theirs && (!mine || theirs.d > mine.d) && zoneOf(theirs.d) >= 2;
  if (threatening && rand() < 0.65) {
    shot = aimAt(theirs.x, theirs.d, 0.9 + rand() * 0.6, theirs.x * 0.85);
  } else {
    const td = 6.45 + rand() * 0.66;
    const tx = (rand() - 0.5) * 0.55;
    shot = aimAt(tx, td, 0, tx * (0.5 + rand() * 0.5));
  }
  shot.speed = clamp(shot.speed * (1 + gauss(rand) * 0.022), MIN_SPEED, MAX_SPEED);
  shot.angle = clamp(shot.angle + gauss(rand) * 0.007, -MAX_ANGLE, MAX_ANGLE);
  return shot;
}
