/**
 * What a touch on the table means, before a throw. Pull back and flick are
 * vertical gestures from anywhere on screen; a sideways slide that starts on
 * the near end of the table picks the weight up so it can be moved within the
 * start box instead. Pure so it can be tested without a DOM.
 */
import { START, TABLE } from "./rules.ts";

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
