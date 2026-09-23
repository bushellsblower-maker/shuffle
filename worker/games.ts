// Validation for finished games. Mirrors shufl's src/games.ts so both Workers
// write rows SHUFL's history and leaderboard can read.
const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const MAX_ROUNDS_JSON = 20_000;

export type StoredGame = {
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

export type GameBodyResult = { ok: true; game: StoredGame } | { ok: false; error: string };

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
