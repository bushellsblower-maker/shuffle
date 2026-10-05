-- Ranked flag on the shared SHUFL `games` table.
-- Existing rows default to ranked, so SHUFL history and room-written online
-- games stay on the leaderboard. Client-posted shuffle local and CPU rows
-- are then marked ranked = 0. The leaderboard view counts ranked rows only.
-- History SELECTs and `DELETE FROM games WHERE id = ?` do not name the column.
--
-- The Worker applies these same statements on first use (worker/schema.ts).
-- A manual `wrangler d1 migrations apply shufl --remote` is not required.
-- Run it only to apply the change before the new Worker serves traffic.
-- Do not run it again after `ranked` exists: ALTER fails with
-- "duplicate column name: ranked".

ALTER TABLE games ADD COLUMN ranked INTEGER NOT NULL DEFAULT 1;

UPDATE games SET ranked = 0 WHERE ranked = 1 AND json_extract(meta_json, '$.source') = 'shuffle-3d' AND json_extract(meta_json, '$.mode') IN ('local', 'cpu');

DROP VIEW IF EXISTS leaderboard;

CREATE VIEW leaderboard AS
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
  WHERE ranked = 1 AND trim(name1) <> ''
  UNION ALL
  SELECT
    id,
    lower(trim(name2)) AS name_key,
    trim(name2) AS display_name,
    CASE WHEN winner_index = 1 THEN 1 ELSE 0 END AS win
  FROM games
  WHERE ranked = 1 AND trim(name2) <> ''
) AS appearances
GROUP BY name_key;
