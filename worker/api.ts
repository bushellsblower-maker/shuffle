import type { GameSummary, Leader } from "../src/history.ts";
import { checkClientGame, parseGameBody, parseLimit, parseMeta, roundCount, type StoredGame } from "./games.ts";
import { ensureGamesSchema } from "./schema.ts";

const MAX_BODY = 48_000;

// Insert-only: a replayed POST for an existing id is a no-op, so a browser
// cannot overwrite rows SHUFL or a room wrote.
const INSERT_GAME = `
INSERT INTO games (
  id, played_at, name1, name2, score1, score2, target,
  winner_index, winner_name, rounds_json, hammer_mode, meta_json
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO NOTHING
`;

const LIST_GAMES = `
SELECT id, played_at, name1, name2, score1, score2, target,
       winner_index, winner_name, rounds_json, meta_json
FROM games
ORDER BY played_at DESC, id DESC
LIMIT ?
`;

const LIST_LEADERS = `
SELECT name, wins, games
FROM leaderboard
ORDER BY wins DESC, games DESC, name COLLATE NOCASE ASC
LIMIT ?
`;

type GameRow = {
  id: string;
  played_at: string;
  name1: string;
  name2: string;
  score1: number;
  score2: number;
  target: number;
  winner_index: number | null;
  winner_name: string | null;
  rounds_json: string;
  meta_json: string | null;
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

export async function readJson(request: Request, max = MAX_BODY): Promise<unknown | undefined> {
  const declared = Number(request.headers.get("content-length") || "0");
  if (Number.isFinite(declared) && declared > max) return undefined;
  const text = await request.text();
  if (text.length > max) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export async function insertGame(db: D1Database, row: StoredGame): Promise<void> {
  await ensureGamesSchema(db);
  await db
    .prepare(INSERT_GAME)
    .bind(
      row.id,
      row.playedAt,
      row.name1,
      row.name2,
      row.score1,
      row.score2,
      row.target,
      row.winnerIndex,
      row.winnerName,
      row.roundsJson,
      row.hammerMode,
      row.metaJson,
    )
    .run();
}

function gameJson(row: GameRow): GameSummary {
  return {
    id: row.id,
    playedAt: row.played_at,
    names: [row.name1, row.name2],
    scores: [row.score1, row.score2],
    target: row.target,
    winnerIndex: row.winner_index,
    winnerName: row.winner_name,
    roundCount: roundCount(row.rounds_json),
    meta: parseMeta(row.meta_json),
  };
}

async function listGames(db: D1Database, url: URL): Promise<Response> {
  const limit = parseLimit(url.searchParams.get("limit"), 30, 100);
  const result = await db.prepare(LIST_GAMES).bind(limit).all<GameRow>();
  return json({ games: (result.results ?? []).map(gameJson) });
}

async function listLeaders(db: D1Database, url: URL): Promise<Response> {
  const limit = parseLimit(url.searchParams.get("limit"), 20, 50);
  const result = await db.prepare(LIST_LEADERS).bind(limit).all<Leader>();
  const leaders: Leader[] = (result.results ?? []).map((row) => ({
    name: row.name,
    wins: Number(row.wins) || 0,
    games: Number(row.games) || 0,
  }));
  return json({ leaders });
}

async function createGame(request: Request, db: D1Database): Promise<Response> {
  const body = await readJson(request);
  if (body === undefined) return json({ error: "Game body must be JSON under 48 KB" }, 400);
  const denied = checkClientGame(body);
  if (denied) return json({ error: denied }, 400);
  const game = parseGameBody(body);
  if (!game.ok) return json({ error: game.error }, 400);
  await insertGame(db, game.game);
  return json({ ok: true, id: game.game.id });
}

export async function handleGamesApi(request: Request, db: D1Database, url: URL): Promise<Response> {
  try {
    await ensureGamesSchema(db);
    if (url.pathname === "/api/games" && request.method === "GET") return listGames(db, url);
    if (url.pathname === "/api/games" && request.method === "POST") return createGame(request, db);
    if (url.pathname === "/api/leaderboard" && request.method === "GET") return listLeaders(db, url);
    return json({ error: "Method not allowed" }, 405);
  } catch (error) {
    console.error("shuffle history", error instanceof Error ? error.message : "failed");
    return json({ error: "History store failed" }, 500);
  }
}
