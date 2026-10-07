import {
  CloseCode,
  DEFAULT_MAX_PEERS,
  MAX_JSON_BODY_BYTES,
  MAX_ROOM_PEERS,
  TIER_TTL_SECONDS,
  isHandshakeId,
  createRoomRequestSchema,
  isRoomId,
  putHandshakeRequestSchema,
  upgradeRoomRequestSchema,
  type CreateRoomResponse,
  type Tier,
  type Variant,
} from "@poof/protocol";
import {
  apiError,
  hasJsonContentType,
  isAllowedOrigin,
  isRateLimited,
  json,
  preflight,
  readJson,
  rejectedSocket,
  withCors,
} from "./http.ts";
import { aiAttestation, aiChat, registerAi } from "./ai.ts";
import { payConfig, redeem, spendPass, unspendPass } from "./pay.ts";
import { positiveInt, randomId } from "./util.ts";

export { RoomDO } from "./room-do.ts";
export { MailboxDO } from "./mailbox-do.ts";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // The API only: the web app is served elsewhere and calls this origin (CORS below).
    if (url.pathname.startsWith("/ws/")) return handleWs(request, env, url);
    if (url.pathname.startsWith("/api/")) {
      if (request.method === "OPTIONS") return preflight(request, env.ALLOWED_ORIGINS);
      let response: Response;
      try {
        response = await handleApi(request, env, url);
      } catch {
        response = apiError("internal_error", "Something went wrong.", 500);
      }
      return withCors(request, env.ALLOWED_ORIGINS, response);
    }
    return apiError("not_found", "Not found.", 404);
  },
} satisfies ExportedHandler<Env>;

// ── WebSocket: /ws/rooms/:id?peerId= ────────────────────────────────────────

async function handleWs(request: Request, env: Env, url: URL): Promise<Response> {
  const match = /^\/ws\/rooms\/([^/]+)$/.exec(url.pathname);
  if (!match) return new Response("Not found", { status: 404 });
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return new Response("Expected a WebSocket upgrade", { status: 426 });
  }

  const roomId = match[1];
  const peerId = url.searchParams.get("peerId");
  if (!isRoomId(roomId) || !peerId) return new Response("Bad request", { status: 400 });

  if (!isAllowedOrigin(request, env.ALLOWED_ORIGINS)) {
    return rejectedSocket(CloseCode.ForbiddenOrigin, "forbidden_origin");
  }
  if (await isRateLimited(env.RL_WS_JOIN, request)) {
    return rejectedSocket(CloseCode.RateLimited, "rate_limited");
  }

  return env.ROOM.getByName(roomId).fetch(request);
}

// ── HTTP API ────────────────────────────────────────────────────────────────

async function handleApi(request: Request, env: Env, url: URL): Promise<Response> {
  const path = url.pathname;
  const method = request.method;

  if (path === "/api/health") {
    if (method !== "GET") return methodNotAllowed();
    return json({ ok: true, version: "1", commit: env.COMMIT_SHA });
  }

  // Mutating endpoints: allowed origins only, and JSON content type (forces a CORS preflight cross-site).
  if (method === "POST" || method === "PUT") {
    if (!isAllowedOrigin(request, env.ALLOWED_ORIGINS)) {
      return apiError("forbidden_origin", "Cross-origin requests are not allowed.", 403);
    }
    if (!hasJsonContentType(request)) {
      return apiError("unsupported_media_type", "Content-Type must be application/json.", 415);
    }
  }

  if (path === "/api/rooms") {
    if (method !== "POST") return methodNotAllowed();
    return createRoom(request, env);
  }

  if (path === "/api/pay/config") {
    if (method !== "GET") return methodNotAllowed();
    return payConfig(env);
  }
  if (path === "/api/pay/redeem") {
    if (method !== "POST") return methodNotAllowed();
    return redeem(request, env);
  }

  if (path === "/api/ai/attestation") {
    if (method !== "POST") return methodNotAllowed();
    return aiAttestation(request, env);
  }
  if (path === "/api/ai/chat") {
    if (method !== "POST") return methodNotAllowed();
    return aiChat(request, env);
  }
  const roomAi = /^\/api\/rooms\/([^/]+)\/ai$/.exec(path);
  if (roomAi) {
    if (method !== "POST") return methodNotAllowed();
    return registerAi(request, env, roomAi[1]);
  }

  const upgrade = /^\/api\/rooms\/([^/]+)\/upgrade$/.exec(path);
  if (upgrade) {
    if (method !== "POST") return methodNotAllowed();
    return upgradeRoom(request, env, upgrade[1]);
  }

  const room = /^\/api\/rooms\/([^/]+)$/.exec(path);
  if (room) {
    if (method !== "GET") return methodNotAllowed();
    return getRoom(request, env, room[1]);
  }

  const handshake = /^\/api\/handshakes\/([^/]+)(\/take)?$/.exec(path);
  if (handshake) {
    const id = handshake[1];
    if (handshake[2]) {
      if (method !== "POST") return methodNotAllowed();
      return takeHandshake(request, env, id);
    }
    if (method !== "PUT") return methodNotAllowed();
    return putHandshake(request, env, id);
  }

  return apiError("not_found", "Not found.", 404);
}

function methodNotAllowed(): Response {
  return apiError("method_not_allowed", "Method not allowed.", 405);
}

async function createRoom(request: Request, env: Env): Promise<Response> {
  if (await isRateLimited(env.RL_CREATE_ROOM, request)) {
    return apiError("rate_limited", "Rate limit exceeded. Try again later.", 429);
  }

  const body = await readJson(request, MAX_JSON_BODY_BYTES);
  if (body instanceof Response) return body;
  const parsed = createRoomRequestSchema.safeParse(body.value);
  if (!parsed.success) return apiError("invalid_request", "Expected { ownerHash, pass? }.", 400);

  if (parsed.data.pass) return createSuperRoom(env, parsed.data.ownerHash, parsed.data.pass);

  const roomId = randomId();
  const ttlSeconds = positiveInt(env.ROOM_TTL_FREE_SECONDS, TIER_TTL_SECONDS.free);
  const info = await env.ROOM.getByName(roomId).create({
    roomId,
    ttlSeconds,
    plan: "free",
    tier: "free",
    // 2 in production. ROOM_MAX_PEERS_FREE opens free rooms to more people for local/e2e testing of
    // group rooms before super rooms exist. Clamped to 2..10.
    maxPeers: Math.min(
      MAX_ROOM_PEERS,
      Math.max(DEFAULT_MAX_PEERS, positiveInt(env.ROOM_MAX_PEERS_FREE, DEFAULT_MAX_PEERS)),
    ),
    ownerHash: parsed.data.ownerHash,
    // Off in production: files are a super-room feature. "1" turns them on for local/e2e testing.
    freeFiles: String(env.ROOM_FILES_FREE) === "1",
    // Off in production: the AI is paid. "1" adds it to free rooms for local testing.
    ai: String(env.ROOM_AI_FREE) === "1",
  });
  if (!info) return apiError("internal_error", "Could not create room.", 500);

  const { peers: _peers, ...created } = info;
  return json(created satisfies CreateRoomResponse);
}

const tierFor = (v: Variant): Tier => (v.lifetime === TIER_TTL_SECONDS["24h"] ? "24h" : "60m");

/** A Super Quant-Room, paid with a pass. The pass is burned first and given back if creation fails. */
async function createSuperRoom(env: Env, ownerHash: string, pass: unknown): Promise<Response> {
  const spent = await spendPass(env, pass);
  if (!spent.ok) return spent.response;
  const { variant } = spent;
  const roomId = randomId();
  const info = await env.ROOM.getByName(roomId)
    .create({
      roomId,
      ttlSeconds: variant.lifetime,
      plan: "super",
      tier: tierFor(variant),
      maxPeers: variant.people,
      ownerHash,
      ai: variant.ai,
    })
    .catch(() => null);
  if (!info) {
    await unspendPass(env, spent.msgHash);
    return apiError("internal_error", "Could not create room.", 500);
  }
  const { peers: _peers, ...created } = info;
  return json(created satisfies CreateRoomResponse);
}

/** POST /api/rooms/:id/upgrade { ownerSecret, pass } */
async function upgradeRoom(
  request: Request,
  env: Env,
  roomId: string | undefined,
): Promise<Response> {
  if (!isRoomId(roomId)) return apiError("room_not_found", "Room not found.", 404);
  if (await isRateLimited(env.RL_ROOM_READ, request)) {
    return apiError("rate_limited", "Rate limit exceeded. Try again later.", 429);
  }
  const body = await readJson(request, MAX_JSON_BODY_BYTES);
  if (body instanceof Response) return body;
  const parsed = upgradeRoomRequestSchema.safeParse(body.value);
  if (!parsed.success) return apiError("invalid_request", "Expected { ownerSecret, pass }.", 400);

  const spent = await spendPass(env, parsed.data.pass);
  if (!spent.ok) return spent.response;
  const { variant } = spent;
  const result = await env.ROOM.getByName(roomId)
    .upgrade({
      ownerSecret: parsed.data.ownerSecret,
      tier: tierFor(variant),
      lifetimeSeconds: variant.lifetime,
      maxPeers: variant.people,
      ai: variant.ai,
      ...(parsed.data.aiHash ? { aiHash: parsed.data.aiHash } : {}),
    })
    .catch(() => null);
  if (!result?.ok) {
    await unspendPass(env, spent.msgHash);
    if (result?.reason === "not_owner")
      return apiError("not_owner", "Only the person who created the room can upgrade it.", 403);
    if (result?.reason === "room_not_found")
      return apiError("room_not_found", "Room not found.", 404);
    return apiError("internal_error", "Could not upgrade the room.", 500);
  }
  return json(result.info);
}

async function getRoom(request: Request, env: Env, roomId: string | undefined): Promise<Response> {
  if (!isRoomId(roomId)) return apiError("room_not_found", "Room not found.", 404);
  if (await isRateLimited(env.RL_ROOM_READ, request)) {
    return apiError("rate_limited", "Rate limit exceeded. Try again later.", 429);
  }
  const info = await env.ROOM.getByName(roomId).getInfo();
  if (!info) return apiError("room_not_found", "Room not found.", 404);
  return json(info);
}

async function putHandshake(request: Request, env: Env, id: string | undefined): Promise<Response> {
  if (!isHandshakeId(id)) return apiError("invalid_handshake", "Invalid handshake id.", 422);
  if (await isRateLimited(env.RL_HANDSHAKE, request)) {
    return apiError("rate_limited", "Rate limit exceeded. Try again later.", 429);
  }

  const body = await readJson(request, MAX_JSON_BODY_BYTES);
  if (body instanceof Response) return body;
  if (body.value === null) return apiError("invalid_request", "Body must be JSON.", 400);
  const parsed = putHandshakeRequestSchema.safeParse(body.value);
  if (!parsed.success) return apiError("invalid_handshake", "Invalid blob.", 422);

  const stored = await env.MAILBOX.getByName(id).put(parsed.data.blob);
  if (!stored) return apiError("handshake_exists", "Handshake id already in use.", 409);
  return json({ expiresAt: stored.expiresAt }, 201);
}

async function takeHandshake(
  request: Request,
  env: Env,
  id: string | undefined,
): Promise<Response> {
  if (!isHandshakeId(id)) return apiError("invalid_handshake", "Invalid handshake id.", 422);
  if (await isRateLimited(env.RL_HANDSHAKE, request)) {
    return apiError("rate_limited", "Rate limit exceeded. Try again later.", 429);
  }
  const blob = await env.MAILBOX.getByName(id).take();
  if (blob === null) return apiError("handshake_not_found", "Code not found or expired.", 404);
  return json({ blob });
}
