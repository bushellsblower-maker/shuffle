// Validation for finished games. The row shape matches SHUFL so both Workers
// can share the `games` table. Only ranked rows count on the leaderboard:
// the room writes those, and browser posts are stored unranked.
import { CODE_ALPHABET, CODE_LENGTH } from "../src/room-code.ts";
import { TABLE, matchWinner } from "../src/rules.ts";

const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const ONLINE_ID_RE = new RegExp(`^s3d-online-[${CODE_ALPHABET}]{${CODE_LENGTH}}-\\d{13}$`);
const MAX_ROUNDS_JSON = 20_000;
/** Highest zone is `TABLE.zones.length`; a hanger adds one on top. */
const MAX_WEIGHT_VALUE = TABLE.zones.length + 1;
const MAX_ROUND_POINTS = TABLE.weightsPerSide * MAX_WEIGHT_VALUE;

export const MAX_GAME_BYTES = 48_000;
/** Finished games a single address may post inside `SAVE_WINDOW_MS`. */
export const SAVE_LIMIT = 30;
export const SAVE_WINDOW_MS = 10 * 60 * 1000;

// Existing rows default to ranked so SHUFL history and room-written online
// games stay on the board. The UPDATE then drops client-posted local/CPU rows.
export const ADD_RANKED_COLUMN = "ALTER TABLE games ADD COLUMN ranked INTEGER NOT NULL DEFAULT 1";

export const UNRANK_CLIENT_GAMES =
  "UPDATE games SET ranked = 0 WHERE ranked = 1 AND json_extract(meta_json, '$.source') = 'shuffle-3d' AND json_extract(meta_json, '$.mode') IN ('local', 'cpu')";

export const LEADERBOARD_SELECT = `SELECT
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
GROUP BY name_key`;

export const LEADERBOARD_VIEW = `CREATE VIEW leaderboard AS
${LEADERBOARD_SELECT}`;

export const INSERT_GAME = `
INSERT INTO games (
  id, played_at, name1, name2, score1, score2, target,
  winner_index, winner_name, rounds_json, hammer_mode, meta_json, ranked
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO NOTHING
`;

export type ParsedGame = {
  id: string;
  playedAt: string;
  name1: string;
  name2: string;
  score1: number;
  score2: number;
  target: number;
  winnerIndex: 0 | 1;
  winnerName: string;
  roundsJson: string;
  hammerMode: "winner" | "turns";
  metaJson: string | null;
};

/** A row ready to insert. `ranked` is 1 only for a result the room produced. */
export type StoredGame = ParsedGame & { ranked: 0 | 1 };

export type GameBodyResult = { ok: true; game: ParsedGame } | { ok: false; error: string };
export type ReviewResult = { ok: true; game: StoredGame } | { ok: false; error: string };

export function oversizeError(bytes: number, max = MAX_GAME_BYTES): string | null {
  if (!Number.isFinite(bytes) || bytes > max) return "Game body must be JSON under 48 KB";
  return null;
}

/** `changes` comes from the insert (`ON CONFLICT DO NOTHING`). Zero means the id was already stored. */
export function duplicateError(changes: number): string | null {
  return changes > 0 ? null : "Game already recorded";
}

/**
 * One slot in a fixed window. The Worker keeps the returned `hits` per
 * client address; the limit is best-effort per isolate and needs no extra binding.
 */
export function takeSaveSlot(
  hits: readonly number[],
  now: number,
  limit = SAVE_LIMIT,
  windowMs = SAVE_WINDOW_MS,
): { ok: true; hits: number[] } | { ok: false; error: string; hits: number[] } {
  const fresh = hits.filter((t) => now - t < windowMs);
  if (fresh.length >= limit) {
    return { ok: false, error: "Too many saves from this session. Try again in a few minutes.", hits: fresh };
  }
  return { ok: true, hits: [...fresh, now] };
}

export function parseLimit(raw: string | null, fallback: number, max: number): number {
  if (raw == null || raw.trim() === "") return fallback;
  if (!/^\d+$/.test(raw.trim())) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return fallback;
  return Math.min(n, max);
}

function cleanName(value: unknown, fallback: string): string {
  const text = String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 32);
  return text || fallback;
}

function wholeNumber(value: unknown, min: number, max: number): number | null {
  let n: number;
  if (typeof value === "number" && Number.isInteger(value)) n = value;
  else if (typeof value === "string" && /^-?\d+$/.test(value.trim())) n = Number(value);
  else return null;
  if (n < min || n > max) return null;
  return n;
}

function parsePlayedAt(value: unknown, now: Date): string | null {
  if (value == null || value === "") return now.toISOString();
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (typeof value === "string") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  return null;
}

export function parseGameBody(value: unknown, now = new Date()): GameBodyResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "Game body must be an object" };
  }
  const body = value as Record<string, unknown>;
  const names = Array.isArray(body.names) ? body.names : [body.name1, body.name2];
  const name1 = cleanName(names[0], "TEAM A");
  const name2 = cleanName(names[1], "TEAM B");
  const scores = Array.isArray(body.scores) ? body.scores : [body.score1, body.score2];
  const score1 = wholeNumber(scores[0], 0, 999);
  const score2 = wholeNumber(scores[1], 0, 999);
  if (score1 === null || score2 === null) {
    return { ok: false, error: "Scores must be whole numbers from 0 to 999" };
  }
  const target = wholeNumber(body.target, 1, 99);
  if (target === null) return { ok: false, error: "Target must be a whole number from 1 to 99" };

  const winnerRaw = body.winner ?? body.winnerIndex;
  const winnerIndex = winnerRaw === 0 || winnerRaw === "0" ? 0 : winnerRaw === 1 || winnerRaw === "1" ? 1 : null;
  if (winnerIndex === null) return { ok: false, error: "A finished game needs a winner" };
  const ahead = winnerIndex === 0 ? score1 > score2 : score2 > score1;
  if (!ahead) return { ok: false, error: "Winner must be strictly ahead" };

  let rounds: unknown = body.rounds ?? [];
  if (typeof rounds === "string") {
    try {
      rounds = JSON.parse(rounds);
    } catch {
      return { ok: false, error: "Rounds must be a list" };
    }
  }
  if (!Array.isArray(rounds)) return { ok: false, error: "Rounds must be a list" };
  if (rounds.length > 200) return { ok: false, error: "Too many rounds" };
  let roundsJson: string;
  try {
    roundsJson = JSON.stringify(rounds);
  } catch {
    return { ok: false, error: "Rounds must be a list" };
  }
  if (roundsJson.length > MAX_ROUNDS_JSON) return { ok: false, error: "Round history is too large" };

  let id = typeof body.id === "string" ? body.id.trim() : "";
  if (!ID_RE.test(id)) {
    const started = wholeNumber(body.startedAt, 0, Number.MAX_SAFE_INTEGER);
    id = started !== null ? `g-${started}` : crypto.randomUUID();
  }

  const playedAt = parsePlayedAt(body.playedAt ?? body.endedAt, now);
  if (!playedAt) return { ok: false, error: "playedAt is not a valid time" };

  let metaJson: string | null = null;
  if (body.meta && typeof body.meta === "object" && !Array.isArray(body.meta)) {
    try {
      const meta = JSON.stringify(body.meta);
      if (meta.length <= 2_000) metaJson = meta;
    } catch {
      metaJson = null;
    }
  }

  return {
    ok: true,
    game: {
      id,
      playedAt,
      name1,
      name2,
      score1,
      score2,
      target,
      winnerIndex,
      winnerName: winnerIndex === 0 ? name1 : name2,
      roundsJson,
      hammerMode: body.hammerMode === "winner" ? "winner" : "turns",
      metaJson,
    },
  };
}

/**
 * Browsers may only post local and CPU matches from this game. Online matches
 * are written by the room Durable Object, so a client cannot fake one.
 */
export function checkClientGame(body: unknown): string | null {
  if (!body || typeof body !== "object") return "Game body must be an object";
  const b = body as Record<string, unknown>;
  const meta = b.meta as Record<string, unknown> | undefined;
  if (!meta || meta.source !== "shuffle-3d") return "Only shuffle-3d games can be posted here";
  if (meta.mode !== "local" && meta.mode !== "cpu") return "Online games are recorded by the room";
  if (typeof b.id !== "string" || !/^s3d-(local|cpu)-[A-Za-z0-9_-]{6,60}$/.test(b.id)) return "Invalid game id";
  return null;
}

function checkRoomGame(body: unknown): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "Game body must be an object";
  const b = body as Record<string, unknown>;
  const meta = b.meta as Record<string, unknown> | undefined;
  if (!meta || typeof meta !== "object" || meta.source !== "shuffle-3d" || meta.mode !== "online") {
    return "Only a room-finished online game can be ranked";
  }
  if (typeof b.id !== "string" || !ONLINE_ID_RE.test(b.id)) return "Invalid online game id";
  return null;
}

function pair(value: unknown): [number, number] | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  if (!Number.isInteger(value[0]) || !Number.isInteger(value[1])) return null;
  return [value[0] as number, value[1] as number];
}

function hangersFit(points: number, hangers: number): boolean {
  if (!Number.isInteger(hangers) || hangers < 0 || hangers > TABLE.weightsPerSide) return false;
  if (points === 0) return hangers === 0;
  return hangers * MAX_WEIGHT_VALUE <= points;
}

/** Round points have to be ones the table can actually produce, and the match has to end on the crossing round. */
function rulesError(game: ParsedGame): string | null {
  if (game.target !== 15 && game.target !== 21) return "Target must be 15 or 21";
  let rounds: unknown;
  try {
    rounds = JSON.parse(game.roundsJson) as unknown;
  } catch {
    return "Rounds must be a list";
  }
  if (!Array.isArray(rounds) || rounds.length === 0) return "A finished game needs its rounds";

  let s0 = 0;
  let s1 = 0;
  for (let i = 0; i < rounds.length; i++) {
    const row = rounds[i];
    if (!row || typeof row !== "object") return "Round score is outside the rules";
    const rec = row as Record<string, unknown>;
    const pts = pair(rec.pts);
    const hangers = pair(rec.hangers);
    const totals = pair(rec.totals);
    if (!pts || !hangers || !totals || rec.n !== i + 1) return "Round score is outside the rules";
    if (pts[0] < 0 || pts[1] < 0 || pts[0] > MAX_ROUND_POINTS || pts[1] > MAX_ROUND_POINTS) {
      return "Round score is outside the rules";
    }
    if (pts[0] !== 0 && pts[1] !== 0) return "Only one side scores a round";
    if (!hangersFit(pts[0], hangers[0]) || !hangersFit(pts[1], hangers[1])) return "Round score is outside the rules";
    s0 += pts[0];
    s1 += pts[1];
    if (totals[0] !== s0 || totals[1] !== s1) return "Scores do not match the rounds";
    if (i !== rounds.length - 1 && (s0 >= game.target || s1 >= game.target)) return "The match would have already ended";
  }
  if (s0 !== game.score1 || s1 !== game.score2) return "Scores do not match the rounds";
  const winnerScore = game.winnerIndex === 0 ? s0 : s1;
  const loserScore = game.winnerIndex === 0 ? s1 : s0;
  if (winnerScore < game.target) return "Winner has not reached the target";
  if (loserScore >= game.target) return "Loser cannot have reached the target";
  if (matchWinner([s0, s1], game.target) !== game.winnerIndex) return "Winner does not match the scores";
  return null;
}

/**
 * Decide whether a finished game may be stored, and whether it counts on the
 * leaderboard. A browser post is always `ranked: 0`. A room post is `ranked: 1`
 * only when the body is an online result the room itself built.
 */
export function reviewSave(origin: "client" | "room", value: unknown, now = new Date()): ReviewResult {
  const denied = origin === "client" ? checkClientGame(value) : checkRoomGame(value);
  if (denied) return { ok: false, error: denied };
  const parsed = parseGameBody(value, now);
  if (!parsed.ok) return parsed;
  const rules = rulesError(parsed.game);
  if (rules) return { ok: false, error: rules };
  return { ok: true, game: { ...parsed.game, ranked: origin === "room" ? 1 : 0 } };
}

export function roundCount(roundsJson: string): number {
  try {
    const parsed = JSON.parse(roundsJson) as unknown;
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

export function parseMeta(metaJson: string | null): Record<string, unknown> | null {
  if (!metaJson) return null;
  try {
    const parsed = JSON.parse(metaJson) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
