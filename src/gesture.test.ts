import assert from "node:assert/strict";
import { test } from "node:test";
import { GESTURE, dragIntent, inReach, type DragIntent } from "./gesture.ts";
import { START, TABLE } from "./rules.ts";

/** Feed a drag path (pixel offsets from touch-down) through `dragIntent`, like pointermove does. */
function intentOf(path: [number, number][], canPlace = true): DragIntent {
  let intent: DragIntent = "undecided";
  for (const [dx, dy] of path) intent = dragIntent(intent, dx, dy, canPlace);
  return intent;
}

test("pull back and flick from the default spot are throws straight away, with no pick-up step", () => {
  assert.equal(intentOf([[0, 4], [1, 12], [2, 60]]), "shot", "pull back");
  assert.equal(intentOf([[0, -6], [0, -40]]), "shot", "flick");
  // An angled pull as wide as aiming allows (atan2 * 0.45 hits MAX_ANGLE at ~18°) is still a throw.
  assert.equal(intentOf([[3, 8], [6, 20], [20, 70]]), "shot");
});

test("a sideways slide on the near table picks the weight up", () => {
  assert.equal(intentOf([[5, 1], [GESTURE.placeSlop, 3]]), "place");
  assert.equal(intentOf([[-8, -2], [-30, 4]]), "place");
});

test("once decided, a drag stays what it was", () => {
  assert.equal(intentOf([[0, 20], [60, 5]]), "shot", "a pull swung sideways never becomes a pick-up");
  assert.equal(intentOf([[30, 0], [30, 120]]), "place", "a pick-up dragged back doesn't turn into a pull");
  assert.equal(intentOf([[0, -20], [40, -20]]), "shot");
});

test("small wobbles and touches away from the start area don't pick the weight up", () => {
  assert.equal(intentOf([[GESTURE.placeSlop - 1, 2], [-6, -3]]), "undecided");
  assert.equal(intentOf([[40, 2]], false), "undecided", "sideways on the far table does nothing, as before");
  assert.equal(intentOf([[40, 2], [40, 30]], false), "shot", "and can still become a pull");
});

test("the pick-up area is the near end of the table around the start box", () => {
  assert.ok(inReach({ x: 0, d: TABLE.launchD }));
  assert.ok(inReach({ x: TABLE.width / 2 + 0.1, d: START.minD }));
  assert.ok(inReach({ x: 0, d: START.maxD + GESTURE.reach - 0.01 }));
  assert.ok(!inReach({ x: 0, d: START.maxD + GESTURE.reach + 0.01 }));
  assert.ok(!inReach({ x: 0, d: TABLE.foul }));
  assert.ok(!inReach({ x: TABLE.width / 2 + GESTURE.sideReach + 0.01, d: TABLE.launchD }), "out over the gutter");
  assert.ok(!inReach(null));
});
