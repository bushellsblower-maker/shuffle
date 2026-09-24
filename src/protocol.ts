/**
 * Online room protocol (JSON over one WebSocket per player).
 *
 * The room Durable Object is authoritative. A client only sends intents
 * (`shot`, `aim`, `ready`, ...). Every accepted shot is simulated in the room
 * and broadcast as `shot` with the input plus the resulting room snapshot, so
 * both browsers replay the same throw and then settle on the same positions.
 */
import type { MatchState, ShotInput } from "./match.ts";
import type { End, Team } from "./rules.ts";

export const MAX_NAME = 12;
/** Rooms with no game activity for this long are closed and forgotten. */
export const ROOM_IDLE_MS = 45 * 60 * 1000;

export interface PlayerInfo {
  name: string;
  connected: boolean;
}

export type RoomStatus = "lobby" | "playing" | "closed";

export interface RoomSnapshot {
  code: string;
  status: RoomStatus;
  target: number;
  players: [PlayerInfo | null, PlayerInfo | null];
  match: MatchState | null;
  /** Shots accepted in this room so far; a client's `shot` must carry the current value. */
  seq: number;
  /** Seats that pressed NEXT ROUND / REMATCH. */
  ready: [boolean, boolean];
  /** Why the room closed, when `status` is "closed". */
  reason?: string;
}

export interface AimInput {
  x: number;
  angle: number;
  power: number;
}

export type ClientMsg =
  | { t: "start" }
  /** `end`: the end the shooter is throwing from; the room rejects a shot for the wrong end. */
  | { t: "shot"; seq: number; shot: ShotInput; end?: End }
  | { t: "aim"; aim: AimInput | null }
  | { t: "ready" }
  | { t: "leave" };

export type ServerMsg =
  | { t: "welcome"; seat: Team; room: RoomSnapshot }
  | { t: "state"; room: RoomSnapshot }
  | { t: "shot"; seat: Team; seq: number; shot: ShotInput; room: RoomSnapshot }
  | { t: "aim"; seat: Team; aim: AimInput | null }
  | { t: "error"; message: string };

export interface RoomTicket {
  code: string;
  seat: Team;
  token: string;
}

export function cleanPlayerName(raw: unknown, fallback: string): string {
  const text = String(raw ?? "")
    .replace(/[\u0000-\u001f\u007f<>]/g, "")
    .trim()
    .toUpperCase()
    .slice(0, MAX_NAME);
  return text || fallback;
}

export function parseClientMsg(raw: string): ClientMsg | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object") return null;
  const m = v as Record<string, unknown>;
  switch (m.t) {
    case "start":
    case "ready":
    case "leave":
      return { t: m.t };
    case "shot": {
      if (typeof m.seq !== "number") return null;
      const msg = { t: "shot", seq: m.seq, shot: m.shot } as Extract<ClientMsg, { t: "shot" }>;
      if (m.end === 0 || m.end === 1) msg.end = m.end;
      else if (m.end !== undefined) return null;
      return msg;
    }
    case "aim": {
      if (m.aim === null) return { t: "aim", aim: null };
      const a = m.aim as Record<string, unknown> | undefined;
      if (!a || ![a.x, a.angle, a.power].every((n) => typeof n === "number" && Number.isFinite(n))) return null;
      return { t: "aim", aim: { x: a.x as number, angle: a.angle as number, power: a.power as number } };
    }
    default:
      return null;
  }
}
