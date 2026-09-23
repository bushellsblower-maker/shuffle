import assert from "node:assert/strict";
import { test } from "node:test";
import { gameBody, sourceLabel } from "../src/history.ts";
import { checkClientGame, parseGameBody, parseMeta } from "./games.ts";

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
