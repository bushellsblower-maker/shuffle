import type { AimInput, ClientMsg, RoomSnapshot, RoomTicket, ServerMsg } from "./protocol.ts";

export type LinkState = "connecting" | "open" | "reconnecting";

export interface OnlineHandlers {
  message(msg: ServerMsg): void;
  link(state: LinkState): void;
  /** The room no longer exists or this seat was taken over; stop using it. */
  gone(reason: string): void;
}

export interface RoomPreview {
  status: RoomSnapshot["status"];
  host: string;
  target: number;
  open: boolean;
}

const TICKET_KEY = "shuffle.room";

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { ...init, headers: { "content-type": "application/json" } });
  } catch {
    throw new Error("Can't reach the game server. Check your connection.");
  }
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `Server error (${res.status})`);
  return body;
}

export const createRoom = (name: string, target: number) =>
  api<RoomTicket>("/api/rooms", { method: "POST", body: JSON.stringify({ name, target }) });

export const joinRoom = (code: string, name: string) =>
  api<RoomTicket>(`/api/rooms/${code}/join`, { method: "POST", body: JSON.stringify({ name }) });

export async function roomPreview(code: string): Promise<RoomPreview | null> {
  try {
    const res = await fetch(`/api/rooms/${code}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error();
    return (await res.json()) as RoomPreview;
  } catch {
    throw new Error("Can't reach the game server.");
  }
}

export function saveTicket(t: RoomTicket): void {
  localStorage.setItem(TICKET_KEY, JSON.stringify(t));
}

export function loadTicket(): RoomTicket | null {
  try {
    const t = JSON.parse(localStorage.getItem(TICKET_KEY) ?? "") as RoomTicket;
    return t && typeof t.code === "string" && typeof t.token === "string" && (t.seat === 0 || t.seat === 1) ? t : null;
  } catch {
    return null;
  }
}

export function clearTicket(): void {
  localStorage.removeItem(TICKET_KEY);
}

export function roomLink(code: string): string {
  return `${location.origin}/join/${code}`;
}

/** One player's socket to their room, reconnecting with backoff until closed. */
export class OnlineClient {
  private ws: WebSocket | null = null;
  private retry = 0;
  private retryTimer = 0;
  private pingTimer = 0;
  private closed = false;
  private everOpened = false;
  private lastAimSent = 0;
  private aimTimer = 0;
  private queuedAim: AimInput | null | undefined;
  readonly ticket: RoomTicket;
  private readonly on: OnlineHandlers;

  constructor(ticket: RoomTicket, on: OnlineHandlers) {
    this.ticket = ticket;
    this.on = on;
    document.addEventListener("visibilitychange", this.onVisible);
    window.addEventListener("online", this.onVisible);
    this.connect();
  }

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  send(msg: ClientMsg): boolean {
    if (!this.isOpen) return false;
    this.ws!.send(JSON.stringify(msg));
    return true;
  }

  /** Aim previews are cosmetic, so they are throttled and dropped while offline. */
  sendAim(aim: AimInput | null): void {
    const now = performance.now();
    clearTimeout(this.aimTimer);
    if (now - this.lastAimSent >= 70 || aim === null) {
      this.lastAimSent = now;
      this.send({ t: "aim", aim });
      return;
    }
    this.queuedAim = aim;
    this.aimTimer = window.setTimeout(() => {
      if (this.queuedAim === undefined) return;
      this.lastAimSent = performance.now();
      this.send({ t: "aim", aim: this.queuedAim });
      this.queuedAim = undefined;
    }, 70 - (now - this.lastAimSent));
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.retryTimer);
    clearInterval(this.pingTimer);
    clearTimeout(this.aimTimer);
    document.removeEventListener("visibilitychange", this.onVisible);
    window.removeEventListener("online", this.onVisible);
    const ws = this.ws;
    this.ws = null;
    if (ws && ws.readyState <= WebSocket.OPEN) ws.close(1000, "bye");
  }

  private onVisible = (): void => {
    if (this.closed || document.visibilityState !== "visible") return;
    if (!this.ws || this.ws.readyState > WebSocket.OPEN) {
      clearTimeout(this.retryTimer);
      this.retry = 0;
      this.connect();
    }
  };

  private connect(): void {
    if (this.closed) return;
    this.on.link(this.everOpened ? "reconnecting" : "connecting");
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const { code, token } = this.ticket;
    const ws = new WebSocket(`${proto}://${location.host}/api/rooms/${code}/ws?token=${encodeURIComponent(token)}`);
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.retry = 0;
      this.everOpened = true;
      this.on.link("open");
      clearInterval(this.pingTimer);
      this.pingTimer = window.setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send("ping");
      }, 20_000);
    };
    ws.onmessage = (e) => {
      if (this.ws !== ws || typeof e.data !== "string" || e.data === "pong") return;
      try {
        this.on.message(JSON.parse(e.data) as ServerMsg);
      } catch (err) {
        console.error("shuffle online message", err);
      }
    };
    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      clearInterval(this.pingTimer);
      this.ws = null;
      if (this.closed) return;
      if (e.code === 4000) return this.stop("This room is open in another tab.");
      if (e.code === 4001) return this.stop(e.reason || "The room was closed.");
      this.on.link("reconnecting");
      void this.scheduleRetry();
    };
  }

  private stop(reason: string): void {
    this.close();
    this.on.gone(reason);
  }

  private async scheduleRetry(): Promise<void> {
    this.retry++;
    // A failed upgrade looks like a plain drop in the browser, so ask whether the room still exists.
    if (this.retry >= 2) {
      try {
        if ((await roomPreview(this.ticket.code)) === null) return this.stop("That room has closed or expired.");
      } catch {
        /* offline: keep retrying */
      }
      if (this.closed) return;
    }
    const delay = Math.min(5000, 400 * 2 ** Math.min(this.retry, 4));
    clearTimeout(this.retryTimer);
    this.retryTimer = window.setTimeout(() => this.connect(), delay);
  }
}
