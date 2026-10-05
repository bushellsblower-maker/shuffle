import { cleanPlayerName, type RoomTicket } from "../src/protocol.ts";
import { isRoomCode, normalizeCode, randomCode } from "../src/room-code.ts";
import { handleGamesApi, json, readJson } from "./api.ts";
import { recordAuditHit } from "./audit-hit.ts";
import type { Room } from "./room.ts";
import { VERSION_BUILT, VERSION_SHA } from "./version.generated.ts";

export { Room } from "./room.ts";

export interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  ROOMS: DurableObjectNamespace<Room>;
  AUDIT_HITS?: AnalyticsEngineDataset;
  CF_VERSION?: WorkerVersionMetadata;
}

const ROOM_PATH = /^\/api\/rooms\/([A-Za-z0-9]+)(\/join|\/ws)?$/;

const room = (env: Env, code: string) => env.ROOMS.get(env.ROOMS.idFromName(code));
const target = (v: unknown) => (v === 15 || v === "15" ? 15 : 21);

async function createRoom(request: Request, env: Env): Promise<Response> {
  const body = ((await readJson(request, 2_000)) ?? {}) as Record<string, unknown>;
  const name = cleanPlayerName(body.name, "HOST");
  for (let attempt = 0; attempt < 8; attempt++) {
    const code = randomCode();
    const ticket: RoomTicket | null = await room(env, code).create(code, name, target(body.target));
    if (ticket) return json(ticket, 201);
  }
  return json({ error: "Could not find a free room code. Try again." }, 503);
}

async function handleRoom(request: Request, env: Env, url: URL): Promise<Response> {
  if (url.pathname === "/api/rooms") {
    return request.method === "POST" ? createRoom(request, env) : json({ error: "Method not allowed" }, 405);
  }
  const match = ROOM_PATH.exec(url.pathname);
  const code = normalizeCode(match?.[1] ?? "");
  if (!match || !isRoomCode(code)) return json({ error: "Room not found. Check the code." }, 404);
  const stub = room(env, code);
  if (match[2] === "/ws") return stub.fetch(request);
  if (match[2] === "/join") {
    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
    const body = ((await readJson(request, 2_000)) ?? {}) as Record<string, unknown>;
    const result = await stub.join(cleanPlayerName(body.name, "GUEST"));
    if ("error" in result) return json(result, 409);
    return json(result);
  }
  const info = await stub.info();
  return info ? json(info) : json({ error: "Room not found. Check the code." }, 404);
}

function withVersion(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("X-Cybush-Version", VERSION_SHA);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
    webSocket: response.webSocket,
  });
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    recordAuditHit(request, env, ctx);
    return withVersion(await handleFetch(request, env));
  },
} satisfies ExportedHandler<Env>;

async function handleFetch(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/__version") {
    return json({
      app: "shuffle",
      sha: VERSION_SHA,
      built: VERSION_BUILT,
      cf_version_id: env.CF_VERSION?.id ?? null,
    });
  }
  if (url.pathname === "/api/games" || url.pathname === "/api/leaderboard") {
    return handleGamesApi(request, env.DB, url);
  }
  if (url.pathname === "/api/rooms" || url.pathname.startsWith("/api/rooms/")) {
    try {
      return await handleRoom(request, env, url);
    } catch (error) {
      console.error("shuffle rooms", error instanceof Error ? error.message : "failed");
      return json({ error: "Rooms are unavailable right now" }, 500);
    }
  }
  if (url.pathname.startsWith("/api/")) return json({ error: "Not found" }, 404);
  return env.ASSETS.fetch(request);
}
