import assert from "node:assert/strict";
import { test } from "node:test";
import {
  TABLE,
  endForRound,
  isLive,
  isHanger,
  matchWinner,
  nextFirstShooter,
  scoreRound,
  shooterFor,
  toTable,
  weightValue,
  zoneOf,
  type End,
  type RestingWeight,
} from "./rules.ts";
import { FRICTION, SAND, WOOD_FRICTION, World, sandAt, sandSeed, slideDistance, speedForDistance, type Body } from "./physics.ts";

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

test("ends alternate every round and map onto the table by a half turn", () => {
  assert.deepEqual([1, 2, 3, 4, 5].map(endForRound), [0, 1, 0, 1, 0]);
  assert.deepEqual(toTable(0, 0.2, 1.5), { x: 0.2, d: 1.5 });
  assert.deepEqual(toTable(1, 0.2, 1.5), { x: -0.2, d: TABLE.length - 1.5 });
  for (const end of [0, 1] as End[]) {
    const a = toTable(end, -0.31, 6.4);
    const back = toTable(end, a.x, a.d);
    assert.ok(Math.abs(back.x + 0.31) < 1e-12 && Math.abs(back.d - 6.4) < 1e-12, "the map is its own inverse");
  }
});

test("only the end being shot toward scores", () => {
  // Weights placed in absolute table coordinates (end 0's frame), near absolute d = 0.
  const nearEnd = [
    { team: 0 as const, x: 0.1, d: R / 2 }, // hangs over the end-0 edge
    { team: 1 as const, x: -0.1, d: TABLE.length - Z3 - R - 0.05 }, // in end 0's zone 3 (mirrored)
  ];
  const shooting = (end: End) => scoreRound(nearEnd.map((w) => ({ team: w.team, ...toTable(end, w.x, w.d) })));
  const fromEnd1 = shooting(1);
  assert.equal(fromEnd1.team, 0, "shooting from end 1, the near-end zones are the far zones");
  assert.equal(fromEnd1.points, 5, "a zone-4 hanger at that end");
  assert.deepEqual(shooting(0), { team: null, points: 0, counted: [] }, "shooting from end 0 those weights are short of the foul line");
});

test("sand: slides go a bit further than bare wood, steer without adding speed, and stay subtle", () => {
  assert.ok(FRICTION < WOOD_FRICTION && SAND.glide > 0.85, "sand helps weights slide, gently");
  const v = speedForDistance(6.6 - TABLE.launchD);
  const xs: number[] = [];
  const ds: number[] = [];
  for (let i = 0; i < 120; i++) {
    const b: Body = { x: 0, d: TABLE.launchD, vx: 0, vd: v, active: true };
    const world = new World([b], sandSeed(31 + i, 1 + (i % 7), i % 8));
    let last = v;
    for (let t = 0; t < 4000 && world.moving; t++) {
      world.step(1 / 60);
      const sp = Math.hypot(b.vx, b.vd);
      assert.ok(sp <= last + 1e-9, "sand never speeds a weight up");
      last = sp;
    }
    xs.push(b.x);
    ds.push(b.d);
  }
  const mean = (a: number[]) => a.reduce((s, n) => s + n, 0) / a.length;
  const sd = (a: number[]) => Math.sqrt(mean(a.map((n) => (n - mean(a)) ** 2)));
  assert.ok(sd(xs) > 0.005 && sd(xs) < 0.04, `sideways spread ${sd(xs).toFixed(3)} m`);
  assert.ok(sd(ds) > 0.01 && sd(ds) < 0.07, `distance spread ${sd(ds).toFixed(3)} m`);
  assert.ok(Math.abs(mean(ds) - 6.6) < 0.03, `on average it still stops where the power says (${mean(ds).toFixed(3)})`);
  assert.ok(Math.max(...xs.map(Math.abs)) < 0.1, "never enough to steer a centre shot into the gutter");
});

test("sand field is smooth, bounded, and seeded", () => {
  let jump = 0;
  for (let d = 0; d < TABLE.length; d += 0.01) {
    const a = sandAt(3, 0.1, d);
    const b = sandAt(3, 0.1, d + 0.01);
    assert.ok(Math.abs(a.drift) <= 1 && Math.abs(a.grip) <= 1);
    jump = Math.max(jump, Math.abs(a.drift - b.drift), Math.abs(a.grip - b.grip));
  }
  assert.ok(jump < 0.15, `no steps in the field (${jump.toFixed(3)})`);
  assert.notDeepEqual(sandAt(3, 0.1, 2), sandAt(4, 0.1, 2));
  assert.deepEqual(sandAt(3, 0.1, 2), sandAt(3, 0.1, 2));
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
