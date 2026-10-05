import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { gameBody, sourceLabel, type GameBody } from "../src/history.ts";
import { newMatchState, shooterOf, startNextRound, throwShot, type RoundLog } from "../src/match.ts";
import { MIN_SPEED } from "../src/ai.ts";
import { speedForDistance } from "../src/physics.ts";
import { TABLE } from "../src/rules.ts";
import {
  ADD_RANKED_COLUMN,
  INSERT_GAME,
  LEADERBOARD_VIEW,
  MAX_GAME_BYTES,
  SAVE_LIMIT,
  UNRANK_CLIENT_GAMES,
  checkClientGame,
  duplicateError,
  oversizeError,
  parseGameBody,
  parseMeta,
  reviewSave,
  takeSaveSlot,
  type StoredGame,
} from "./games.ts";

const rounds = [{ n: 1, pts: [4, 0] as [number, number], hangers: [1, 0] as [number, number], totals: [4, 0] as [number, number], hammer: 1 as const }];

test("shuffle game bodies pass SHUFL's validation unchanged", () => {
  const body = gameBody({ id: "s3d-cpu-abc123def", names: ["ANN", "CPU"], scores: [21, 9], target: 21, winner: 0, rounds, mode: "cpu" });
  const parsed = parseGameBody(JSON.parse(JSON.stringify(body)));
  assert.ok(parsed.ok);
  if (!parsed.ok) return;
  assert.equal(parsed.game.id, "s3d-cpu-abc123def");
  assert.equal(parsed.game.winnerName, "ANN");
  assert.equal(parsed.game.hammerMode, "turns");
  assert.deepEqual(JSON.parse(parsed.game.roundsJson), rounds);
  assert.deepEqual(parseMeta(parsed.game.metaJson), { source: "shuffle-3d", mode: "cpu", order: "scorer-first" });
});

test("winner must be strictly ahead", () => {
  const body = gameBody({ id: "s3d-local-abc123def", names: ["A", "B"], scores: [21, 21], target: 21, winner: 0, rounds, mode: "local" });
  assert.deepEqual(parseGameBody(body), { ok: false, error: "Winner must be strictly ahead" });
});

test("browsers can post local and CPU games only", () => {
  const ok = gameBody({ id: "s3d-local-abc123def", names: ["A", "B"], scores: [21, 3], target: 21, winner: 0, rounds, mode: "local" });
  assert.equal(checkClientGame(ok), null);
  const online = gameBody({ id: "s3d-online-K7QMX-1", names: ["A", "B"], scores: [21, 3], target: 21, winner: 0, rounds, mode: "online" });
  assert.match(checkClientGame(online) ?? "", /recorded by the room/);
  assert.match(checkClientGame({ ...ok, meta: { source: "shufl", mode: "local" } }) ?? "", /shuffle-3d/);
  assert.match(checkClientGame({ ...ok, id: "g-123" }) ?? "", /id/);
});

test("history rows are labelled by source", () => {
  assert.equal(sourceLabel(null), "SHUFL");
  assert.equal(sourceLabel({ source: "shuffle-3d", mode: "online" }), "3D · ONLINE");
  assert.equal(sourceLabel({ source: "shuffle-3d", mode: "cpu" }), "3D · CPU");
  assert.equal(sourceLabel({ source: "shuffle-3d", mode: "local" }), "3D · LOCAL");
});

function buildRounds(slices: Array<[number, number]>, hangers: Array<[number, number]> = []): RoundLog[] {
  let a = 0;
  let b = 0;
  return slices.map(([p0, p1], i) => {
    a += p0;
    b += p1;
    const h = hangers[i] ?? [0, 0];
    return { n: i + 1, pts: [p0, p1], hangers: [h[0], h[1]], totals: [a, b], hammer: 1 };
  });
}

const legalRounds = buildRounds(
  [
    [5, 0],
    [0, 4],
    [16, 0],
  ],
  [
    [1, 0],
    [0, 0],
    [2, 0],
  ],
);

function finished(mode: "online" | "local" | "cpu", id: string): GameBody {
  return gameBody({
    id,
    names: ["ANN", "BOB"],
    scores: [21, 4],
    target: 21,
    winner: 0,
    rounds: legalRounds,
    mode,
    room: mode === "online" ? "K7QMX" : undefined,
  });
}

const onlineBody = () => finished("online", "s3d-online-K7QMX-1735689600000");

test("a match the room actually played is accepted as ranked", () => {
  const startedAt = 1735689600000;
  const m = newMatchState(15, 0, startedAt, 1);
  const draw = speedForDistance(6.6 - TABLE.launchD);
  let guard = 0;
  while (m.phase !== "matchEnd" && guard < 50) {
    while (m.phase === "aim") {
      const team = shooterOf(m)!;
      const lane = [-0.3, -0.1, 0.1, 0.3][Math.floor(m.shotIndex / 2)] ?? 0;
      const shot = team === 0 ? { x: lane, angle: 0, speed: draw } : { x: 0.3, angle: 0, speed: MIN_SPEED };
      assert.equal(throwShot(m, team, shot), null);
    }
    if (m.phase === "roundEnd") startNextRound(m);
    guard++;
  }
  assert.equal(m.phase, "matchEnd");
  assert.equal(m.winner, 0);
  const saved = reviewSave(
    "room",
    gameBody({
      id: `s3d-online-K7QMX-${startedAt}`,
      names: ["ANN", "BOB"],
      scores: m.scores,
      target: m.target,
      winner: 0,
      rounds: m.rounds,
      mode: "online",
      room: "K7QMX",
      playedAt: new Date(startedAt),
    }),
  );
  assert.equal(saved.ok, true, saved.ok ? "" : saved.error);
  if (saved.ok) assert.equal(saved.game.ranked, 1);
});

test("valid online result accepted", () => {
  const saved = reviewSave("room", onlineBody());
  assert.equal(saved.ok, true);
  if (!saved.ok) return;
  assert.equal(saved.game.ranked, 1);
  assert.equal(saved.game.id, "s3d-online-K7QMX-1735689600000");
  assert.equal(saved.game.winnerName, "ANN");
  assert.equal(saved.game.score1, 21);
  assert.equal(saved.game.score2, 4);
});

test("forged online result rejected", () => {
  const online = onlineBody();
  const forged = reviewSave("client", { ...online, ranked: 1 });
  assert.equal(forged.ok, false);
  if (forged.ok) return;
  assert.match(forged.error, /recorded by the room/);
  const localAsRoom = reviewSave("room", finished("local", "s3d-local-abc123def"));
  assert.equal(localAsRoom.ok, false);
  const shortId = reviewSave("room", { ...online, id: "s3d-online-K7QMX-1" });
  assert.equal(shortId.ok, false);
});

test("impossible score rejected", () => {
  const huge = finished("local", "s3d-local-abc123def");
  huge.scores = [21, 0];
  huge.rounds = buildRounds([[21, 0]]);
  const rejected = reviewSave("client", huge);
  assert.equal(rejected.ok, false);
  if (rejected.ok) return;
  assert.match(rejected.error, /outside the rules/);

  const hanger = finished("cpu", "s3d-cpu-abc123def");
  hanger.scores = [15, 0];
  hanger.target = 15;
  hanger.rounds = buildRounds([[15, 0]], [[4, 0]]);
  const badHanger = reviewSave("client", hanger);
  assert.equal(badHanger.ok, false);
  if (badHanger.ok) return;
  assert.match(badHanger.error, /outside the rules/);

  const continued = finished("local", "s3d-local-abc123xyz");
  continued.scores = [16, 0];
  continued.target = 15;
  continued.rounds = buildRounds([
    [15, 0],
    [1, 0],
  ]);
  const late = reviewSave("client", continued);
  assert.equal(late.ok, false);
  if (late.ok) return;
  assert.match(late.error, /already ended/);
});

test("duplicate rejected", () => {
  assert.equal(duplicateError(0), "Game already recorded");
  assert.equal(duplicateError(1), null);

  const db = migrated();
  const saved = reviewSave("client", finished("local", "s3d-local-abc123def"));
  assert.equal(saved.ok, true);
  if (!saved.ok) return;
  const insert = db.prepare(INSERT_GAME);
  assert.equal(Number(insert.run(...rowOf(saved.game)).changes), 1);
  const again = { ...saved.game, score1: 15, winnerName: "NOPE" };
  assert.equal(Number(insert.run(...rowOf(again)).changes), 0);
  assert.equal(duplicateError(0), "Game already recorded");
  const kept = db.prepare("SELECT score1, winner_name, ranked FROM games WHERE id = ?").get(saved.game.id) as {
    score1: number;
    winner_name: string;
    ranked: number;
  };
  assert.equal(kept.score1, 21);
  assert.equal(kept.winner_name, "ANN");
  assert.equal(kept.ranked, 0);
});

test("local game saved as unranked", () => {
  const local = reviewSave("client", { ...finished("local", "s3d-local-abc123def"), ranked: 1 });
  assert.equal(local.ok, true);
  if (!local.ok) return;
  assert.equal(local.game.ranked, 0);

  const cpu = reviewSave("client", finished("cpu", "s3d-cpu-abc123def"));
  assert.equal(cpu.ok, true);
  if (!cpu.ok) return;
  assert.equal(cpu.game.ranked, 0);

  const db = migrated(true);
  const names = (db.prepare("SELECT name FROM leaderboard").all() as { name: string }[]).map((row) => row.name).sort();
  assert.deepEqual(names, ["CYAN", "RED", "SUE", "TIM"]);
  const history = (db.prepare("SELECT id FROM games").all() as { id: string }[]).map((row) => row.id).sort();
  assert.ok(history.includes("s3d-local-legacy0001"));
  assert.equal(db.prepare("DELETE FROM games WHERE id = ?").run("s3d-local-legacy0001").changes, 1);
  assert.equal(db.prepare("SELECT id FROM games WHERE id = ?").get("s3d-local-legacy0001"), undefined);
  const shufl = db.prepare(
    `INSERT INTO games (
      id, played_at, name1, name2, score1, score2, target,
      winner_index, winner_name, rounds_json, hammer_mode, meta_json
    ) VALUES ('g-shufl-new', '2026-10-05T00:00:00.000Z', 'NIA', 'JO', 11, 4, 11, 0, 'NIA', '[]', 'turns', NULL)`,
  ).run();
  assert.equal(Number(shufl.changes), 1);
  const ranked = db.prepare("SELECT ranked FROM games WHERE id = 'g-shufl-new'").get() as { ranked: number };
  assert.equal(ranked.ranked, 1);
  assert.ok((db.prepare("SELECT name FROM leaderboard").all() as { name: string }[]).some((row) => row.name === "NIA"));
});

test("oversize payload and session flood are rejected", () => {
  assert.equal(oversizeError(MAX_GAME_BYTES), null);
  assert.match(oversizeError(MAX_GAME_BYTES + 1) ?? "", /48 KB/);
  let hits: number[] = [];
  for (let i = 0; i < SAVE_LIMIT; i++) {
    const slot = takeSaveSlot(hits, 1_000 + i);
    assert.equal(slot.ok, true);
    if (slot.ok) hits = slot.hits;
  }
  const blocked = takeSaveSlot(hits, 1_000 + SAVE_LIMIT);
  assert.equal(blocked.ok, false);
  const later = takeSaveSlot(hits, 1_000 + SAVE_LIMIT + 10 * 60 * 1000);
  assert.equal(later.ok, true);
});

const LEGACY_SCHEMA = `CREATE TABLE games (
  id TEXT PRIMARY KEY,
  played_at TEXT NOT NULL,
  name1 TEXT NOT NULL,
  name2 TEXT NOT NULL,
  score1 INTEGER NOT NULL,
  score2 INTEGER NOT NULL,
  target INTEGER NOT NULL,
  winner_index INTEGER,
  winner_name TEXT,
  rounds_json TEXT NOT NULL,
  hammer_mode TEXT,
  meta_json TEXT
);
CREATE VIEW leaderboard AS
SELECT trim(name1) AS name, 1 AS wins, 1 AS games FROM games;`;

function migrated(seed = false): DatabaseSync {
  const sql = readFileSync(new URL("../migrations/0002_ranked.sql", import.meta.url), "utf8");
  assert.ok(sql.includes(ADD_RANKED_COLUMN));
  assert.ok(sql.includes(UNRANK_CLIENT_GAMES));
  assert.ok(sql.includes(LEADERBOARD_VIEW));
  const db = new DatabaseSync(":memory:");
  db.exec(LEGACY_SCHEMA);
  if (seed) seedLegacy(db);
  db.exec(sql);
  return db;
}

function seedLegacy(db: DatabaseSync): void {
  const insert = db.prepare(
    `INSERT INTO games (
      id, played_at, name1, name2, score1, score2, target,
      winner_index, winner_name, rounds_json, hammer_mode, meta_json
    ) VALUES (?, '2026-10-01T00:00:00.000Z', ?, ?, 21, 4, 21, 0, ?, '[]', 'turns', ?)`,
  );
  const meta = (mode: string) => JSON.stringify({ source: "shuffle-3d", mode, order: "scorer-first" });
  insert.run("s3d-local-legacy0001", "LOCAL A", "LOCAL B", "LOCAL A", meta("local"));
  insert.run("s3d-cpu-legacy00001", "CPU A", "CPU B", "CPU A", meta("cpu"));
  insert.run("s3d-online-K7QMX-1735689600000", "RED", "CYAN", "RED", meta("online"));
  insert.run("g-shufl-old", "SUE", "TIM", "SUE", null);
}

function rowOf(game: StoredGame): Array<string | number | null> {
  return [
    game.id,
    game.playedAt,
    game.name1,
    game.name2,
    game.score1,
    game.score2,
    game.target,
    game.winnerIndex,
    game.winnerName,
    game.roundsJson,
    game.hammerMode,
    game.metaJson,
    game.ranked,
  ];
}
