/**
 * What a touch on the table means, before a throw. Pull back and flick are
 * vertical gestures from anywhere on screen; a sideways slide that starts on
 * the near end of the table picks the weight up so it can be moved within the
 * start box instead.
 *
 * A flick's strength is `flickThrow`: one time-weighted least-squares velocity
 * over the last few dozen milliseconds of pointer samples, read from each
 * event's own timestamp. Pure so it can be tested without a DOM.
 */
import { START, TABLE } from "./rules.ts";

/**
 * How a gesture becomes a throw. Speeds are pixels per millisecond because
 * `PointerEvent.timeStamp` is milliseconds; +y is down the screen.
 *
 * A steady flick (constant speed through the window) hits the same power as
 * the old two-point estimate. The window, the speed cap, and spike rejection
 * are what changed; the power curve itself did not.
 */
export const THROW = {
  /** Release velocity is fit over this many milliseconds ending at the lift. */
  windowMs: 80,
  /** Pointer samples older than this are dropped. Longer than `windowMs`, so a lift a few milliseconds after the last move still sees a full window. */
  historyMs: 160,
  /** Segment speed above this (px/ms) is cut back. Full power is `fullUpSpeed`, so a normal flick never reaches it. */
  maxSampleSpeed: 12,
  /** A sample this far (px) off the straight path through its neighbours is a one-event spike and is ignored. */
  spikePx: 40,
  /** Upward speed (px/ms) a flick must reach to leave the hand. */
  minUpSpeed: 0.25,
  /** Upward speed (px/ms) that maps to full power. */
  fullUpSpeed: 3.4,
  /** Lowest power a flick that clears `minUpSpeed` can launch at. */
  minPower: 0.05,
  /** How much of the finger's angle becomes the weight's launch angle (pull and flick). */
  aimScale: 0.45,
} as const;

export const GESTURE = {
  /** Pixels down (pull) or up (flick) that commit a touch to a throw. Once committed it can't pick the weight up. */
  shotSlop: 10,
  /** Pixels sideways, before any throw has started, that pick the weight up instead. */
  placeSlop: 14,
  /** How far beyond the start box, down the table (m), a touch can still pick the weight up. */
  reach: 0.45,
  /** How far outside the table's sides (m) a touch can still pick the weight up. */
  sideReach: 0.15,
} as const;

export type DragIntent = "undecided" | "shot" | "place";

/** Whether a touch at this table point (shooter-relative) can pick the weight up. */
export function inReach(hit: { x: number; d: number } | null): boolean {
  if (!hit) return false;
  return (
    Math.abs(hit.x) <= TABLE.width / 2 + GESTURE.sideReach &&
    hit.d >= START.minD - GESTURE.reach &&
    hit.d <= START.maxD + GESTURE.reach
  );
}

/**
 * Settle what a drag is from how far it has moved (`dx`, `dy` in pixels, +y
 * down the screen). Once decided it stays decided until the finger lifts.
 */
export function dragIntent(was: DragIntent, dx: number, dy: number, canPlace: boolean): DragIntent {
  if (was !== "undecided") return was;
  if (Math.abs(dy) > GESTURE.shotSlop) return "shot";
  if (canPlace && Math.abs(dx) >= GESTURE.placeSlop) return "place";
  return "undecided";
}

/** One pointer event. `t` is milliseconds on the same clock as `PointerEvent.timeStamp`. */
export interface PointerSample {
  x: number;
  y: number;
  t: number;
}

export interface FlickThrow {
  /** Screen velocity, px/ms. +y is down. */
  vx: number;
  vy: number;
  /** Null when the upward speed doesn't clear `THROW.minUpSpeed`. */
  power: number | null;
  /** Launch angle in radians, already multiplied by `THROW.aimScale`. */
  angle: number;
}

/** Same instant reported twice (a move and the lift). Not a tuning knob. */
const SAME_INSTANT_MS = 0.5;

function prepare(samples: readonly PointerSample[]): PointerSample[] {
  const sorted = samples
    .filter((s) => Number.isFinite(s.t) && Number.isFinite(s.x) && Number.isFinite(s.y))
    .slice()
    .sort((a, b) => a.t - b.t);
  const out: PointerSample[] = [];
  for (const s of sorted) {
    const prev = out[out.length - 1];
    if (prev && s.t - prev.t < SAME_INSTANT_MS) {
      out[out.length - 1] = s;
      continue;
    }
    out.push(s);
  }
  return out;
}

/** Distance from `mid` to the segment joining its neighbours. */
function chordOffset(prev: PointerSample, mid: PointerSample, next: PointerSample): number {
  const dx = next.x - prev.x;
  const dy = next.y - prev.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-8) return Math.hypot(mid.x - prev.x, mid.y - prev.y);
  const k = Math.min(1, Math.max(0, ((mid.x - prev.x) * dx + (mid.y - prev.y) * dy) / len2));
  return Math.hypot(mid.x - (prev.x + k * dx), mid.y - (prev.y + k * dy));
}

/** How far `c` lands from where a straight continuation of `a → b` would put it. */
function extrapolateOffset(a: PointerSample, b: PointerSample, c: PointerSample): number {
  const dt = b.t - a.t;
  if (dt <= 0) return 0;
  const k = (c.t - b.t) / dt;
  const x = b.x + (b.x - a.x) * k;
  const y = b.y + (b.y - a.y) * k;
  return Math.hypot(c.x - x, c.y - y);
}

function dropSpikes(samples: PointerSample[]): PointerSample[] {
  const n = samples.length;
  if (n < 3) return samples;
  const drop = new Array<boolean>(n).fill(false);
  for (let i = 1; i < n - 1; i++) {
    if (chordOffset(samples[i - 1], samples[i], samples[i + 1]) > THROW.spikePx) drop[i] = true;
  }
  // The lift itself can be the spike. Judge it from the last samples that aren't already spikes,
  // so a bad sample just before the lift doesn't make the real lift look like one too.
  let b = n - 2;
  while (b > 0 && drop[b]) b--;
  let a = b - 1;
  while (a > 0 && drop[a]) a--;
  if (a >= 0 && b > a && extrapolateOffset(samples[a], samples[b], samples[n - 1]) > THROW.spikePx) drop[n - 1] = true;
  if (!drop.some(Boolean)) return samples;
  const kept = samples.filter((_, i) => !drop[i]);
  return kept.length >= 2 ? kept : samples;
}

/** Keep [release − window, release], with a point exactly on the start of the window when we have one to interpolate. */
function clipWindow(samples: PointerSample[]): PointerSample[] {
  const end = samples[samples.length - 1];
  const t0 = end.t - THROW.windowMs;
  let i = 0;
  while (i < samples.length && samples[i].t < t0) i++;
  if (i === 0) return samples;
  const out: PointerSample[] = [];
  const prev = samples[i - 1];
  const next = samples[i];
  if (next && next.t - t0 >= SAME_INSTANT_MS) {
    const dt = next.t - prev.t;
    const k = dt > 0 ? (t0 - prev.t) / dt : 0;
    out.push({ x: prev.x + (next.x - prev.x) * k, y: prev.y + (next.y - prev.y) * k, t: t0 });
  }
  for (let j = i; j < samples.length; j++) out.push(samples[j]);
  return out.length >= 2 ? out : samples;
}

/**
 * Rebuild the path so no segment is faster than `maxSampleSpeed`. Later samples
 * keep their own deltas (they are not asked to catch up), so one fast event
 * can't smuggle its extra distance in through the points after it.
 */
function clampSpeeds(samples: PointerSample[]): PointerSample[] {
  const first = samples[0];
  const out: PointerSample[] = [{ x: first.x, y: first.y, t: first.t }];
  for (let i = 1; i < samples.length; i++) {
    const s = samples[i];
    const prevIn = samples[i - 1];
    const dt = s.t - prevIn.t;
    let dx = s.x - prevIn.x;
    let dy = s.y - prevIn.y;
    if (dt > 0) {
      const speed = Math.hypot(dx, dy) / dt;
      if (speed > THROW.maxSampleSpeed) {
        const k = THROW.maxSampleSpeed / speed;
        dx *= k;
        dy *= k;
      }
    }
    const prev = out[i - 1];
    out.push({ x: prev.x + dx, y: prev.y + dy, t: s.t });
  }
  return out;
}

/** Time-weighted least-squares velocity. Each sample counts for the time it covers, so 30 Hz and 120 Hz agree. */
function fitVelocity(samples: readonly PointerSample[]): { vx: number; vy: number } | null {
  const n = samples.length;
  if (n < 2) return null;
  const w = new Array<number>(n);
  w[0] = (samples[1].t - samples[0].t) / 2;
  w[n - 1] = (samples[n - 1].t - samples[n - 2].t) / 2;
  for (let i = 1; i < n - 1; i++) w[i] = (samples[i + 1].t - samples[i - 1].t) / 2;
  let wSum = 0;
  let mt = 0;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    const wi = w[i];
    if (wi <= 0) continue;
    wSum += wi;
    mt += wi * samples[i].t;
    mx += wi * samples[i].x;
    my += wi * samples[i].y;
  }
  if (wSum <= 0) return null;
  mt /= wSum;
  mx /= wSum;
  my /= wSum;
  let vt = 0;
  let ctx = 0;
  let cty = 0;
  for (let i = 0; i < n; i++) {
    const wi = w[i];
    if (wi <= 0) continue;
    const dt = samples[i].t - mt;
    vt += wi * dt * dt;
    ctx += wi * dt * (samples[i].x - mx);
    cty += wi * dt * (samples[i].y - my);
  }
  if (vt < 1e-9) return null;
  return { vx: ctx / vt, vy: cty / vt };
}

/**
 * Throw mapped from a flick's pointer samples, including the lift as the last
 * one. Times must be event timestamps in milliseconds, not frame numbers.
 * Returns null when there aren't two distinct samples to fit.
 */
export function flickThrow(samples: readonly PointerSample[]): FlickThrow | null {
  const prepared = prepare(samples);
  if (prepared.length < 2) return null;
  const fitted = fitVelocity(clampSpeeds(clipWindow(dropSpikes(prepared))));
  if (!fitted) return null;
  const { vx, vy } = fitted;
  const up = -vy;
  const power = up > THROW.minUpSpeed ? Math.min(1, Math.max(THROW.minPower, up / THROW.fullUpSpeed)) : null;
  return { vx, vy, power, angle: Math.atan2(vx, -vy) * THROW.aimScale };
}
