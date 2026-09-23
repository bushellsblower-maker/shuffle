/** Finished-match records in the shape SHUFL's `POST /api/games` accepts (shared D1 `games` table). */
import type { RoundLog } from "./match.ts";
import type { Team } from "./rules.ts";

export const SOURCE = "shuffle-3d";
export type GameMode = "online" | "local" | "cpu";

export interface GameMeta {
  source: typeof SOURCE;
  mode: GameMode;
  /** Shuffle's order rule: the side that scored throws first next round. */
  order: "scorer-first";
  room?: string;
}

export interface GameBody {
  id: string;
  names: [string, string];
  scores: [number, number];
  target: number;
  winner: Team;
  rounds: RoundLog[];
  hammerMode: "turns";
  meta: GameMeta;
  playedAt: string;
}

export interface GameSummary {
  id: string;
  playedAt: string;
  names: [string, string];
  scores: [number, number];
  target: number;
  winnerIndex: number | null;
  winnerName: string | null;
  roundCount: number;
  meta: Record<string, unknown> | null;
}

export interface Leader {
  name: string;
  wins: number;
  games: number;
}

export function gameBody(args: {
  id: string;
  names: readonly [string, string];
  scores: readonly [number, number];
  target: number;
  winner: Team;
  rounds: readonly RoundLog[];
  mode: GameMode;
  room?: string;
  playedAt?: Date;
}): GameBody {
  const meta: GameMeta = { source: SOURCE, mode: args.mode, order: "scorer-first" };
  if (args.room) meta.room = args.room;
  return {
    id: args.id,
    names: [args.names[0], args.names[1]],
    scores: [args.scores[0], args.scores[1]],
    target: args.target,
    winner: args.winner,
    rounds: args.rounds.map((r) => ({ ...r, pts: [...r.pts], hangers: [...r.hangers], totals: [...r.totals] })),
    hammerMode: "turns",
    meta,
    playedAt: (args.playedAt ?? new Date()).toISOString(),
  };
}

/** Short label for where a stored game came from. */
export function sourceLabel(meta: Record<string, unknown> | null): string {
  if (meta?.source !== SOURCE) return "SHUFL";
  const mode = meta.mode === "online" ? "ONLINE" : meta.mode === "cpu" ? "CPU" : "LOCAL";
  return `3D · ${mode}`;
}
