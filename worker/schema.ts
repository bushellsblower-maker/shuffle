// Identical to shufl's migrations/0001_games.sql. The production database is
// SHUFL's and already has these objects; this only fills an empty local D1
// (`wrangler dev`). Every statement is idempotent.
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
  meta_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_games_played_at ON games (played_at DESC);

CREATE VIEW IF NOT EXISTS leaderboard AS
SELECT
  name_key,
  MAX(display_name) AS name,
  COUNT(DISTINCT id) AS games,
  SUM(win) AS wins
FROM (
  SELECT
    id,
    lower(trim(name1)) AS name_key,
    trim(name1) AS display_name,
    CASE WHEN winner_index = 0 THEN 1 ELSE 0 END AS win
  FROM games
  WHERE trim(name1) <> ''
  UNION ALL
  SELECT
    id,
    lower(trim(name2)) AS name_key,
    trim(name2) AS display_name,
    CASE WHEN winner_index = 1 THEN 1 ELSE 0 END AS win
  FROM games
  WHERE trim(name2) <> ''
) AS appearances
GROUP BY name_key;
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

async function applyGamesSchema(db: D1Database): Promise<void> {
  const found = await db
    .prepare("SELECT count(*) AS n FROM sqlite_master WHERE (type = 'table' AND name = 'games') OR (type = 'view' AND name = 'leaderboard')")
    .first<{ n: number }>();
  if (Number(found?.n) === 2) return;
  const statements = GAMES_SCHEMA.split(/;\s*\n\s*\n/)
    .map((s) => s.trim().replace(/;$/, ""))
    .filter(Boolean);
  await db.batch(statements.map((s) => db.prepare(s)));
}
