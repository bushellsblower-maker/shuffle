// Production already has SHUFL's `games` table. This fills an empty local D1
// and, on an existing database, adds `ranked` and points `leaderboard` at
// verified rows only. History selects and `DELETE FROM games WHERE id = ?`
// do not name the new column, so they keep working.
import { ADD_RANKED_COLUMN, LEADERBOARD_SELECT, LEADERBOARD_VIEW, UNRANK_CLIENT_GAMES } from "./games.ts";

export const GAMES_SCHEMA = `CREATE TABLE IF NOT EXISTS games (
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
  meta_json TEXT,
  ranked INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_games_played_at ON games (played_at DESC);

CREATE VIEW IF NOT EXISTS leaderboard AS
${LEADERBOARD_SELECT};
`;

const ready = new WeakMap<object, Promise<void>>();

export function ensureGamesSchema(db: D1Database): Promise<void> {
  const existing = ready.get(db);
  if (existing) return existing;
  const pending = applyGamesSchema(db).catch((error: unknown) => {
    ready.delete(db);
    throw error;
  });
  ready.set(db, pending);
  return pending;
}

function statementsOf(sql: string): string[] {
  return sql
    .split(/;\s*\n\s*\n/)
    .map((s) => s.trim().replace(/;$/, ""))
    .filter(Boolean);
}

async function applyGamesSchema(db: D1Database): Promise<void> {
  const table = await db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'games'")
    .first<{ name: string }>();
  // Sequential: a later statement can see a column or view created just above it.
  if (!table?.name) {
    for (const sql of statementsOf(GAMES_SCHEMA)) await db.prepare(sql).run();
  }
  await ensureRanked(db);
}

async function ensureRanked(db: D1Database): Promise<void> {
  const info = await db.prepare("PRAGMA table_info(games)").all<{ name: string }>();
  const hasRanked = (info.results ?? []).some((col) => col.name === "ranked");
  const view = await db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'view' AND name = 'leaderboard'")
    .first<{ sql: string }>();
  const viewOk = typeof view?.sql === "string" && /\branked\s*=\s*1\b/.test(view.sql);
  if (hasRanked && viewOk) return;

  const statements: string[] = [];
  if (!hasRanked) statements.push(ADD_RANKED_COLUMN);
  statements.push(UNRANK_CLIENT_GAMES);
  if (!viewOk) {
    statements.push("DROP VIEW IF EXISTS leaderboard");
    statements.push(LEADERBOARD_VIEW);
  }
  for (const sql of statements) {
    try {
      await db.prepare(sql).run();
    } catch (error) {
      const msg = error instanceof Error ? error.message : "";
      if (sql === ADD_RANKED_COLUMN && /duplicate column/i.test(msg)) continue;
      throw error;
    }
  }
}
