import { DurableObject } from "cloudflare:workers";
import { gameBody } from "../src/history.ts";
import { newMatchState, parseShot, shooterOf, startNextRound, throwShot, upgradeMatch, type MatchState } from "../src/match.ts";
import {
  ROOM_IDLE_MS,
  parseClientMsg,
  type ClientMsg,
  type RoomSnapshot,
  type RoomStatus,
  type RoomTicket,
  type ServerMsg,
} from "../src/protocol.ts";
import { randomToken } from "../src/room-code.ts";
import type { Team } from "../src/rules.ts";
import { insertGame } from "./api.ts";
import { parseGameBody } from "./games.ts";
import type { Env } from "./index.ts";

interface Seat {
  name: string;
  token: string;
}

interface RoomData {
  code: string;
  status: RoomStatus;
  target: number;
  seats: [Seat | null, Seat | null];
  match: MatchState | null;
  seq: number;
  ready: [boolean, boolean];
  lastActive: number;
}

export interface RoomInfo {
  status: RoomStatus;
  host: string;
  target: number;
  open: boolean;
}

interface Attachment {
  seat: Team;
}

const other = (seat: Team) => (1 - seat) as Team;
const tag = (seat: Team) => `seat${seat}`;

/** One online match. The Durable Object name is the room code. */
export class Room extends DurableObject<Env> {
  private data: RoomData | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    void ctx.blockConcurrencyWhile(async () => {
      this.data = (await ctx.storage.get<RoomData>("room")) ?? null;
      if (this.data?.match) upgradeMatch(this.data.match);
    });
  }

  /* ---------- RPC from the Worker ---------- */

  async create(code: string, name: string, target: number): Promise<RoomTicket | null> {
    if (this.data) return null;
    const token = randomToken();
    this.data = {
      code,
      status: "lobby",
      target,
      seats: [{ name, token }, null],
      match: null,
      seq: 0,
      ready: [false, false],
      lastActive: Date.now(),
    };
    await this.save();
    return { code, seat: 0, token };
  }

  async join(name: string): Promise<RoomTicket | { error: string }> {
    const d = this.data;
    if (!d || d.status === "closed") return { error: "Room not found. Check the code." };
    if (d.seats[1] || d.status !== "lobby") return { error: "That room already has two players." };
    const host = d.seats[0]?.name ?? "";
    const token = randomToken();
    d.seats[1] = { name: name === host ? `${name.slice(0, 10)} 2` : name, token };
    await this.save();
    this.broadcast({ t: "state", room: this.snapshot() });
    return { code: d.code, seat: 1, token };
  }

  info(): RoomInfo | null {
    const d = this.data;
    if (!d || d.status === "closed") return null;
    return { status: d.status, host: d.seats[0]?.name ?? "", target: d.target, open: d.status === "lobby" && !d.seats[1] };
  }

  /* ---------- WebSocket ---------- */

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("Expected a WebSocket", { status: 426 });
    const d = this.data;
    if (!d || d.status === "closed") return new Response("Room not found", { status: 404 });
    const token = new URL(request.url).searchParams.get("token") ?? "";
    const seat = ([0, 1] as Team[]).find((s) => token && d.seats[s]?.token === token);
    if (seat === undefined) return new Response("Not a player in this room", { status: 403 });

    for (const old of this.ctx.getWebSockets(tag(seat))) {
      try {
        old.close(4000, "Opened on another tab");
      } catch {
        /* already closing */
      }
    }
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server, [tag(seat)]);
    server.serializeAttachment({ seat } satisfies Attachment);
    server.send(JSON.stringify({ t: "welcome", seat, room: this.snapshot() } satisfies ServerMsg));
    this.send(other(seat), { t: "state", room: this.snapshot() });
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string" || message.length > 2000) return;
    const msg = parseClientMsg(message);
    const att = ws.deserializeAttachment() as Attachment | null;
    if (!msg || !att || !this.data) return;
    const error = await this.handle(att.seat, msg, ws);
    if (error) {
      ws.send(JSON.stringify({ t: "error", message: error } satisfies ServerMsg));
      if (this.data) ws.send(JSON.stringify({ t: "state", room: this.snapshot() } satisfies ServerMsg));
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, reason);
    } catch {
      /* already closed */
    }
    if (this.data) this.broadcast({ t: "state", room: this.snapshot(ws) }, ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    if (this.data) this.broadcast({ t: "state", room: this.snapshot(ws) }, ws);
  }

  async alarm(): Promise<void> {
    const d = this.data;
    if (!d) return;
    if (Date.now() - d.lastActive >= ROOM_IDLE_MS - 1000) await this.close("Room expired after being idle");
    else await this.ctx.storage.setAlarm(d.lastActive + ROOM_IDLE_MS);
  }

  /* ---------- Game ---------- */

  private async handle(seat: Team, msg: ClientMsg, ws: WebSocket): Promise<string | null> {
    const d = this.data!;
    switch (msg.t) {
      case "start": {
        if (d.status !== "lobby") return null;
        if (seat !== 0) return "Only the host can start";
        if (!d.seats[1] || !this.connected(1)) return "Waiting for an opponent";
        d.status = "playing";
        d.match = newMatchState(d.target, 0);
        d.ready = [false, false];
        await this.save();
        this.broadcast({ t: "state", room: this.snapshot() });
        return null;
      }
      case "shot": {
        const m = d.match;
        if (d.status !== "playing" || !m) return "No match in progress";
        if (msg.seq !== d.seq) return "Out of sync";
        if (!this.connected(other(seat))) return "Opponent is offline. Play resumes when they're back.";
        const shot = parseShot(msg.shot);
        if (!shot) return "Invalid shot";
        const err = throwShot(m, seat, shot, msg.end);
        if (err) return err;
        const seq = d.seq++;
        d.ready = [false, false];
        await this.save();
        this.broadcast({ t: "shot", seat, seq, shot, room: this.snapshot() });
        if (m.phase === "matchEnd") await this.record(m);
        return null;
      }
      case "aim": {
        if (d.match && shooterOf(d.match) === seat) this.send(other(seat), { t: "aim", seat, aim: msg.aim });
        return null;
      }
      case "ready": {
        const m = d.match;
        if (!m || (m.phase !== "roundEnd" && m.phase !== "matchEnd")) return null;
        d.ready[seat] = true;
        if (d.ready[0] && d.ready[1]) {
          if (m.phase === "roundEnd") startNextRound(m);
          else d.match = newMatchState(d.target, m.winner === null ? 0 : other(m.winner));
          d.ready = [false, false];
        }
        await this.save();
        this.broadcast({ t: "state", room: this.snapshot() });
        return null;
      }
      case "leave": {
        if (d.status === "lobby" && seat === 1) {
          d.seats[1] = null;
          await this.save();
          try {
            ws.close(1000, "Left the room");
          } catch {
            /* already closed */
          }
          this.broadcast({ t: "state", room: this.snapshot(ws) }, ws);
          return null;
        }
        const name = d.seats[seat]?.name ?? "Opponent";
        await this.close(d.status === "lobby" ? `${name} closed the room` : `${name} left the match`);
        return null;
      }
    }
  }

  private async record(m: MatchState): Promise<void> {
    const d = this.data!;
    if (m.winner === null) return;
    const body = gameBody({
      id: `s3d-online-${d.code}-${m.startedAt}`,
      names: [d.seats[0]?.name ?? "ORANGE", d.seats[1]?.name ?? "CYAN"],
      scores: m.scores,
      target: m.target,
      winner: m.winner,
      rounds: m.rounds,
      mode: "online",
      room: d.code,
    });
    const parsed = parseGameBody(body);
    if (!parsed.ok) {
      console.error("shuffle room record", parsed.error);
      return;
    }
    try {
      await insertGame(this.env.DB, parsed.game);
    } catch (error) {
      console.error("shuffle room record", error instanceof Error ? error.message : "failed");
    }
  }

  /* ---------- Plumbing ---------- */

  private connected(seat: Team, closing?: WebSocket): boolean {
    return this.ctx.getWebSockets(tag(seat)).some((ws) => ws !== closing && ws.readyState === WebSocket.OPEN);
  }

  private snapshot(closing?: WebSocket): RoomSnapshot {
    const d = this.data!;
    return {
      code: d.code,
      status: d.status,
      target: d.target,
      players: [0, 1].map((s) => {
        const seat = d.seats[s];
        return seat ? { name: seat.name, connected: this.connected(s as Team, closing) } : null;
      }) as RoomSnapshot["players"],
      match: d.match,
      seq: d.seq,
      ready: [d.ready[0], d.ready[1]],
    };
  }

  private send(seat: Team, msg: ServerMsg): void {
    const text = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets(tag(seat))) {
      try {
        ws.send(text);
      } catch {
        /* socket went away */
      }
    }
  }

  private broadcast(msg: ServerMsg, except?: WebSocket): void {
    const text = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      try {
        ws.send(text);
      } catch {
        /* socket went away */
      }
    }
  }

  private async save(): Promise<void> {
    const d = this.data!;
    d.lastActive = Date.now();
    await this.ctx.storage.put("room", d);
    await this.ctx.storage.setAlarm(d.lastActive + ROOM_IDLE_MS);
  }

  private async close(reason: string): Promise<void> {
    const d = this.data!;
    d.status = "closed";
    this.broadcast({ t: "state", room: { ...this.snapshot(), reason } });
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close(4001, reason.slice(0, 120));
      } catch {
        /* already closed */
      }
    }
    this.data = null;
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }
}
