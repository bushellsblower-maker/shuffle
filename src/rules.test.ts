import assert from "node:assert/strict";
import { test } from "node:test";
import {
  TABLE,
  isLive,
  isHanger,
  matchWinner,
  nextFirstShooter,
  scoreRound,
  shooterFor,
  weightValue,
  zoneOf,
  type RestingWeight,
} from "./rules.ts";
import { World, slideDistance, speedForDistance } from "./physics.ts";

const R = TABLE.puckRadius;
const [, Z2, Z3, Z4] = TABLE.zones;

test("zones use the trailing edge, touching a line scores the lower zone", () => {
  assert.equal(zoneOf(TABLE.foul + R + 0.01), 1);
  assert.equal(zoneOf(Z2 + R - 0.001), 1);
  assert.equal(zoneOf(Z2 + R + 0.001), 2);
  assert.equal(zoneOf(Z3 + R + 0.001), 3);
  assert.equal(zoneOf(Z4 + R + 0.001), 4);
});

test("hanger adds +1 on top of its zone", () => {
  const d = TABLE.length - R / 2;
  assert.ok(isHanger(d));
  assert.deepEqual(weightValue(d), { zone: 4, hanger: true, value: 5 });
  assert.equal(isHanger(TABLE.length - R - 0.001), false);
});

test("short of the foul line or off the table is dead", () => {
  assert.equal(isLive({ x: 0, d: TABLE.foul }), false);
  assert.equal(isLive({ x: 0, d: TABLE.foul + R + 0.001 }), true);
  assert.equal(isLive({ x: TABLE.width, d: 6 }), false);
  assert.equal(isLive({ x: 0, d: TABLE.length + 0.01 }), false);
});

test("only the closest side scores, counting weights past the opponent's best", () => {
  const w: RestingWeight[] = [
    { team: 0, x: 0, d: TABLE.length - R / 2 }, // hanger: 5
    { team: 0, x: 0.2, d: Z3 + R + 0.05 }, // 3
    { team: 1, x: -0.2, d: Z2 + R + 0.1 }, // B best, zone 2
    { team: 0, x: 0.1, d: TABLE.foul + R + 0.1 }, // behind B's best: 0
    { team: 1, x: 0, d: 3 }, // dead
  ];
  const r = scoreRound(w);
  assert.equal(r.team, 0);
  assert.equal(r.points, 8);
  assert.deepEqual(
    r.counted.map((c) => c.index),
    [0, 1],
  );
});

test("no live weights or an exact tie scores nothing", () => {
  assert.equal(scoreRound([{ team: 0, x: 0, d: 2 }]).team, null);
  const tie = scoreRound([
    { team: 0, x: -0.2, d: 6 },
    { team: 1, x: 0.2, d: 6 },
  ]);
  assert.deepEqual(tie, { team: null, points: 0, counted: [] });
});

test("turn order and match end", () => {
  assert.deepEqual([0, 1, 2, 3].map((i) => shooterFor(1, i)), [1, 0, 1, 0]);
  assert.equal(nextFirstShooter(0, { team: 1, points: 2, counted: [] }), 1);
  assert.equal(nextFirstShooter(1, { team: null, points: 0, counted: [] }), 1);
  assert.equal(matchWinner([21, 12], 21), 0);
  assert.equal(matchWinner([14, 16], 15), 1);
  assert.equal(matchWinner([10, 12], 15), null);
});

test("physics: speedForDistance inverts slideDistance and weights exchange momentum", () => {
  const v = speedForDistance(6.5);
  assert.ok(Math.abs(slideDistance(v) - 6.5) < 0.005);
  const world = new World([
    { x: 0, d: 1, vx: 0, vd: 3, active: true },
    { x: 0, d: 2, vx: 0, vd: 0, active: true },
  ]);
  const events = [];
  for (let i = 0; i < 600 && world.moving; i++) events.push(...world.step(1 / 60));
  assert.ok(events.some((e) => e.type === "hit"));
  const [a, b] = world.bodies;
  assert.ok(b.d > a.d + 0.5, "struck weight travels further than the shooter");
});
