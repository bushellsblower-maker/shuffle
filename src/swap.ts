/**
 * End-swap fly-around: between rounds the camera lifts off the table, swings
 * out over the hall (other shuffleboards, pool tables), then lands behind the
 * end the next round shoots from. Plain maths so it can be tested in Node.
 *
 * Knobs:
 * - `duration`: seconds for the whole move.
 * - `radius`: furthest the camera gets from the table centre (m). Keep it in the
 *   aisle between the next shuffleboard and the pool tables (`HALL` in scene.ts).
 * - `height`: camera height at the top of the arc (m above the playing surface).
 * - `swing`: how far (radians) the arc swings round to the side of the table.
 * - `houseLights`: extra hemisphere light at the top of the arc, so the hall reads.
 * - `fogPush`: metres the fog is pushed back at the top of the arc.
 */
export const SWAP = {
  duration: 3.2,
  radius: 4.6,
  height: 3.0,
  swing: 1.2,
  houseLights: 0.75,
  fogPush: 11,
} as const;

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface SwapPose {
  pos: Vec3;
  look: Vec3;
  /** 0 at the ends of the move, 1 at the top of the arc; drives house lights and fog. */
  reveal: number;
}

const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
const smoother = (s: number) => s * s * s * (s * (s * 6 - 15) + 10);

function wrapAngle(a: number): number {
  const t = Math.PI * 2;
  return ((((a + Math.PI) % t) + t) % t) - Math.PI;
}

/**
 * Camera pose at progress `s` (0..1) from `from` to `to`, orbiting `centre`
 * on the `side` (+1 or -1) of the table and looking at `hall` mid-flight.
 * Starts exactly at `from` and ends exactly at `to`, with zero velocity at both ends.
 */
export function swapPose(
  s: number,
  from: { pos: Vec3; look: Vec3 },
  to: { pos: Vec3; look: Vec3 },
  centre: Vec3,
  hall: Vec3,
  side: 1 | -1,
): SwapPose {
  const k = Math.min(1, Math.max(0, s));
  const e = smoother(k);
  const reveal = Math.sin(Math.PI * k) ** 2;
  const polar = (p: Vec3) => ({ a: Math.atan2(p.x - centre.x, p.z - centre.z), r: Math.hypot(p.x - centre.x, p.z - centre.z) });
  const p0 = polar(from.pos);
  const p1 = polar(to.pos);
  const a = p0.a + wrapAngle(p1.a - p0.a) * e + side * SWAP.swing * reveal;
  const rBase = lerp(p0.r, p1.r, e);
  const r = lerp(rBase, Math.max(rBase, SWAP.radius), reveal);
  const yBase = lerp(from.pos.y, to.pos.y, e);
  const y = lerp(yBase, Math.max(yBase, SWAP.height), reveal);
  const look = {
    x: lerp(lerp(from.look.x, to.look.x, e), hall.x, reveal),
    y: lerp(lerp(from.look.y, to.look.y, e), hall.y, reveal),
    z: lerp(lerp(from.look.z, to.look.z, e), hall.z, reveal),
  };
  return { pos: { x: centre.x + Math.sin(a) * r, y, z: centre.z + Math.cos(a) * r }, look, reveal };
}
