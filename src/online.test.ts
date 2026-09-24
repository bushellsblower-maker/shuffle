import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_ANGLE, MIN_SPEED, speedOf } from "./ai.ts";
import {
  LANE,
  SHOTS_PER_ROUND,
  launchBody,
  newMatchState,
  nextShotSand,
  parseShot,
  shooterOf,
  simulateShot,
  startNextRound,
  throwShot,
  upgradeMatch,
  weightsLeft,
  type MatchState,
  type ShotInput,
  type TableWeight,
} from "./match.ts";
import { MAX_SPEED, World, sandSeed, speedForDistance } from "./physics.ts";
import { cleanPlayerName, parseClientMsg } from "./protocol.ts";
import { CODE_ALPHABET, CODE_LENGTH, codeFromLocation, isRoomCode, normalizeCode, randomCode } from "./room-code.ts";
import { TABLE, isLive, scoreRound, type Team } from "./rules.ts";

function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/* ---------- room codes ---------- */

test("room codes are short and avoid look-alike characters", () => {
  const rand = seeded(7);
  for (let i = 0; i < 500; i++) {
    const code = randomCode(rand);
    assert.equal(code.length, CODE_LENGTH);
    assert.ok(isRoomCode(code), code);
    assert.ok(!/[01OIL]/.test(code), code);
  }
  assert.equal(CODE_ALPHABET.length, new Set(CODE_ALPHABET).size);
  assert.equal(randomCode(() => 0.999999), CODE_ALPHABET.at(-1)!.repeat(CODE_LENGTH));
});

test("typed and linked room codes are normalised", () => {
  assert.equal(normalizeCode(" k7q-mx "), "K7QMX");
  assert.equal(normalizeCode("abcdefgh"), "ABCDE");
  assert.equal(isRoomCode("K7QMX"), true);
  assert.equal(isRoomCode("K7QM"), false);
  assert.equal(isRoomCode("K0QMX"), false);
  assert.equal(codeFromLocation("/join/k7qmx", ""), "K7QMX");
  assert.equal(codeFromLocation("/join/K7QMX/", ""), "K7QMX");
  assert.equal(codeFromLocation("/", "?room=k7qmx"), "K7QMX");
  assert.equal(codeFromLocation("/", "?room=nope0"), null);
  assert.equal(codeFromLocation("/", ""), null);
});

/* ---------- protocol ---------- */

test("client messages are parsed defensively", () => {
  assert.deepEqual(parseClientMsg('{"t":"start"}'), { t: "start" });
  assert.deepEqual(parseClientMsg('{"t":"ready","extra":1}'), { t: "ready" });
  assert.equal(parseClientMsg("not json"), null);
  assert.equal(parseClientMsg('{"t":"hack"}'), null);
  assert.equal(parseClientMsg('{"t":"shot"}'), null);
  const shot = { x: 0, angle: 0, speed: 3 };
  assert.deepEqual(parseClientMsg(JSON.stringify({ t: "shot", seq: 2, shot })), { t: "shot", seq: 2, shot });
  assert.deepEqual(parseClientMsg(JSON.stringify({ t: "shot", seq: 2, shot, end: 1 })), { t: "shot", seq: 2, shot, end: 1 });
  assert.equal(parseClientMsg(JSON.stringify({ t: "shot", seq: 2, shot, end: 2 })), null);
  assert.equal(parseClientMsg(JSON.stringify({ t: "shot", seq: 2, shot, end: "0" })), null);
  assert.deepEqual(parseClientMsg('{"t":"aim","aim":null}'), { t: "aim", aim: null });
  assert.equal(parseClientMsg('{"t":"aim","aim":{"x":"1","angle":0,"power":0}}'), null);
  assert.equal(cleanPlayerName("  <b>ann</b>\u0007 ", "X"), "BANN/B");
  assert.equal(cleanPlayerName("", "GUEST"), "GUEST");
  assert.equal(cleanPlayerName("a".repeat(30), "X").length, 12);
});

test("shots outside what a gesture can produce are rejected", () => {
  assert.deepEqual(parseShot({ x: 0.1, angle: 0.05, speed: 3 }), { x: 0.1, angle: 0.05, speed: 3 });
  assert.ok(parseShot({ x: LANE, angle: MAX_ANGLE, speed: speedOf(1) }));
  assert.ok(parseShot({ x: -LANE, angle: -MAX_ANGLE, speed: speedOf(0) }));
  assert.equal(parseShot({ x: 1, angle: 0, speed: 3 }), null);
  assert.equal(parseShot({ x: 0, angle: 0.5, speed: 3 }), null);
  assert.equal(parseShot({ x: 0, angle: 0, speed: MAX_SPEED * 2 }), null);
  assert.equal(parseShot({ x: 0, angle: 0, speed: MIN_SPEED / 2 }), null);
  assert.equal(parseShot({ x: Number.NaN, angle: 0, speed: 3 }), null);
  assert.equal(parseShot("shot"), null);
});

/* ---------- match engine ---------- */

function randomShot(rand: () => number): ShotInput {
  return {
    x: (rand() * 2 - 1) * LANE,
    angle: (rand() * 2 - 1) * MAX_ANGLE * 0.6,
    speed: speedOf(0.55 + rand() * 0.25),
  };
}

/** What a browser does: step the same world (same sand) with whatever frame times it gets. */
function replayLikeBrowser(table: readonly TableWeight[], shot: ShotInput, id: number, team: Team, sand: number, rand: () => number): TableWeight[] {
  const bodies = table.map((w) => ({ x: w.x, d: w.d, vx: 0, vd: 0, active: true }));
  bodies.push(launchBody(shot));
  const meta = [...table, { id, team }];
  const world = new World(bodies);
  world.sand = sand;
  for (let i = 0; i < 10_000 && world.moving; i++) world.step(1 / 144 + rand() * (0.1 - 1 / 144));
  return bodies.flatMap((b, i) => (b.active && isLive(b) ? [{ id: meta[i].id, team: meta[i].team, x: b.x, d: b.d }] : []));
}

test("sync invariant: a browser replay on the same sand at any frame rate lands exactly where the room does", () => {
  const rand = seeded(42);
  for (let game = 0; game < 6; game++) {
    const m = newMatchState(21, 0, 0, 1000 + game);
    for (let id = 0; id < SHOTS_PER_ROUND; id++) {
      const team = shooterOf(m)!;
      const shot = randomShot(rand);
      const before = m.table.map((w) => ({ ...w }));
      // The browser only knows the match seed, round, and shot index from its last snapshot.
      const sand = sandSeed(m.seed, m.round, m.shotIndex);
      assert.equal(sand, nextShotSand(m));
      assert.equal(throwShot(m, team, shot), null);
      const browser = replayLikeBrowser(before, shot, id, team, sand, rand);
      assert.deepEqual(browser, m.table, `game ${game} shot ${id}`);
    }
  }
});

test("each shot gets its own sand, so identical throws don't land identically", () => {
  const shot: ShotInput = { x: 0.1, angle: 0, speed: speedForDistance(6.5 - TABLE.launchD) };
  const land = (sand: number | null) => simulateShot([], shot, 0, 0, sand)[0];
  assert.deepEqual(land(sandSeed(7, 1, 0)), land(sandSeed(7, 1, 0)), "same sand, same result");
  const spots = new Set([0, 1, 2, 3, 4, 5].map((i) => JSON.stringify(land(sandSeed(7, 1, i)))));
  assert.equal(spots.size, 6, "different shots of a round see different sand");
  assert.notDeepEqual(land(sandSeed(7, 1, 0)), land(sandSeed(8, 1, 0)), "different matches see different sand");
  assert.notDeepEqual(land(sandSeed(7, 1, 0)), land(sandSeed(7, 2, 0)), "different rounds see different sand");
});

test("rounds alternate ends, the room rejects a shot for the wrong end, and a rematch starts at end 0", () => {
  const m = newMatchState(15, 0, 0, 99);
  assert.equal(m.end, 0);
  assert.equal(m.seed, 99);
  const ends: number[] = [];
  for (let r = 0; r < 4; r++) {
    ends.push(m.end);
    while (m.phase === "aim") {
      const team = shooterOf(m)!;
      const wrong = (1 - m.end) as 0 | 1;
      assert.equal(throwShot(m, team, { x: 0, angle: 0, speed: MIN_SPEED }, wrong), "Out of sync");
      assert.equal(throwShot(m, team, { x: 0, angle: 0, speed: MIN_SPEED }, m.end), null);
    }
    assert.equal(m.phase, "roundEnd", "short throws never score");
    assert.equal(startNextRound(m), null);
  }
  assert.deepEqual(ends, [0, 1, 0, 1]);
  assert.equal(m.end, 0, "round 5 is back at end 0");
  assert.equal(m.seed, 99, "the sand seed lasts the whole match");
  assert.equal(newMatchState(15, 1, 0).end, 0);
});

test("rooms saved before ends and sand existed are upgraded in place", () => {
  const old = newMatchState(21, 0, 0, 5) as Partial<MatchState>;
  delete old.end;
  delete old.seed;
  old.round = 4;
  const m = upgradeMatch(old as MatchState);
  assert.equal(m.end, 1);
  assert.equal(m.seed, 0);
  const current = newMatchState(21, 0, 0, 5);
  current.round = 3;
  current.end = 0;
  assert.equal(upgradeMatch(current).end, 0, "a valid end is left alone");
});

test("the room enforces turn order and runs a round to its score", () => {
  const m = newMatchState(21, 1, 0);
  assert.equal(shooterOf(m), 1);
  assert.equal(throwShot(m, 0, { x: 0, angle: 0, speed: 3 }), "Not your turn");
  assert.equal(m.shotIndex, 0);
  const rand = seeded(3);
  for (let i = 0; i < SHOTS_PER_ROUND; i++) {
    const team = shooterOf(m)!;
    assert.equal(weightsLeft(m, team), TABLE.weightsPerSide - Math.floor(i / 2));
    assert.equal(throwShot(m, team, randomShot(rand)), null);
    assert.ok(m.table.every((w) => isLive(w)), "only live weights stay on the table");
    assert.deepEqual(
      m.table.map((w) => w.id),
      [...m.table.map((w) => w.id)].sort((a, b) => a - b),
      "table stays in throw order",
    );
  }
  assert.notEqual(m.phase, "aim");
  assert.equal(shooterOf(m), null);
  assert.equal(throwShot(m, 0, { x: 0, angle: 0, speed: 3 }), "The round is over");
  const expected = scoreRound(m.table);
  assert.deepEqual(m.last, expected);
  const pts: [number, number] = [0, 0];
  if (expected.team !== null) pts[expected.team] = expected.points;
  assert.deepEqual(m.scores, pts);
  assert.deepEqual(m.rounds[0].pts, pts);
  assert.deepEqual(m.rounds[0].totals, m.scores);
  assert.equal(m.rounds[0].hammer, 0, "the side throwing second has the hammer");

  if (m.phase === "roundEnd") {
    assert.equal(startNextRound(m), null);
    assert.equal(m.round, 2);
    assert.equal(m.shotIndex, 0);
    assert.deepEqual(m.table, []);
    assert.equal(m.firstShooter, expected.team ?? 1);
    assert.equal(startNextRound(m), "No round to advance");
  }
});

test("a match ends when a side reaches the target strictly ahead", () => {
  const m = newMatchState(15, 0, 0);
  const draw = speedForDistance(6.6 - TABLE.launchD);
  let rounds = 0;
  while (m.phase !== "matchEnd" && rounds < 50) {
    while (m.phase === "aim") {
      const team = shooterOf(m)!;
      // Team 0 draws to the 3/4 in separate lanes; team 1 throws short, so team 0 wins every round.
      const lane = [-0.3, -0.1, 0.1, 0.3][Math.floor(m.shotIndex / 2)];
      const shot = team === 0 ? { x: lane, angle: 0, speed: draw } : { x: 0.3, angle: 0, speed: MIN_SPEED };
      assert.equal(throwShot(m, team, shot), null);
    }
    if (m.phase === "roundEnd") startNextRound(m);
    rounds++;
  }
  assert.equal(m.phase, "matchEnd");
  assert.equal(m.winner, 0);
  assert.ok(m.scores[0] >= 15 && m.scores[0] > m.scores[1]);
  assert.equal(m.rounds.length, m.round);
  assert.equal(m.rounds.at(-1)!.totals[0], m.scores[0]);
});
