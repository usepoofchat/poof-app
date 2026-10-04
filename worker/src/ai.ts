import {
  AI_MAX_BODY_BYTES,
  AI_MAX_TOKENS,
  AI_MODEL,
  MAX_JSON_BODY_BYTES,
  aiAttestationRequestSchema,
  aiChatRequestSchema,
  isRoomId,
  registerAiRequestSchema,
} from "@poof/protocol";
import { SECURITY_HEADERS, apiError, isRateLimited, json, readJson } from "./http.ts";
import type { AiRefusal } from "./room-do.ts";

/**
 * The uncensored AI model (Super Quant-Rooms that include it).
 *
 * The browser that asks encrypts the conversation to the model's enclave (end-to-end, see
 * packages/core/src/ai). This Worker only checks that the room has the AI and budget left, adds the
 * provider key, forces the model and its parameters, and streams the encrypted answer back
 * untouched. It never sees the text and logs nothing.
 */

/** Where the provider's API lives. Tests replace the fetch, not the URL. */
const PROVIDER = "https://api.venice.ai/api/v1";

type Upstream = (url: string, init: RequestInit) => Promise<Response>;
let upstream: Upstream = (url, init) => fetch(url, init);

/** Tests: answer provider calls with a fake. Pass null to restore the real fetch. */
export function setAiUpstreamForTests(fake: Upstream | null): void {
  upstream = fake ?? ((url, init) => fetch(url, init));
}

const REFUSALS: Record<AiRefusal, [Parameters<typeof apiError>[0], string, number]> = {
  room_not_found: ["room_not_found", "Room not found.", 404],
  ai_not_enabled: ["ai_not_enabled", "This quant-room doesn't include the AI model.", 403],
  ai_not_ready: ["ai_not_ready", "The AI model isn't set up for this quant-room yet.", 409],
  ai_forbidden: ["ai_forbidden", "Not allowed.", 403],
  ai_budget_exhausted: [
    "ai_budget_exhausted",
    "This quant-room has used all its AI requests.",
    429,
  ],
  rate_limited: ["rate_limited", "Too many AI requests. Try again in a minute.", 429],
};

const refused = (reason: AiRefusal): Response => apiError(...REFUSALS[reason]);

const unavailable = (): Response =>
  apiError("ai_unavailable", "The AI model can't be reached right now.", 503);

/** POST /api/rooms/:id/ai { ownerSecret, aiHash } */
export async function registerAi(
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
  const parsed = registerAiRequestSchema.safeParse(body.value);
  if (!parsed.success) return apiError("invalid_request", "Expected { ownerSecret, aiHash }.", 400);
  const result = await env.ROOM.getByName(roomId).registerAi(parsed.data);
  if (result.ok) return json({ ok: true });
  if (result.reason === "not_owner")
    return apiError("not_owner", "Only the person who created the room can set up its AI.", 403);
  return refused(result.reason);
}

/** POST /api/ai/attestation { roomId, aiToken, nonce }: the enclave's attestation, as the provider sent it. */
export async function aiAttestation(request: Request, env: Env): Promise<Response> {
  if (await isRateLimited(env.RL_AI, request)) {
    return apiError("rate_limited", "Rate limit exceeded. Try again later.", 429);
  }
  const body = await readJson(request, MAX_JSON_BODY_BYTES);
  if (body instanceof Response) return body;
  const parsed = aiAttestationRequestSchema.safeParse(body.value);
  if (!parsed.success)
    return apiError("invalid_request", "Expected { roomId, aiToken, nonce }.", 400);
  const { roomId, aiToken, nonce } = parsed.data;

  const auth = await env.ROOM.getByName(roomId).authorizeAi({ aiToken, spend: false });
  if (!auth.ok) return refused(auth.reason);
  if (!env.VENICE_API_KEY) return unavailable();

  const query = new URLSearchParams({ model: AI_MODEL, nonce: nonce.toLowerCase() });
  let res: Response;
  try {
    res = await upstream(`${PROVIDER}/tee/attestation?${query.toString()}`, {
      headers: { Authorization: `Bearer ${env.VENICE_API_KEY}` },
    });
  } catch {
    return unavailable();
  }
  if (!res.ok) return unavailable();
  const attestation: unknown = await res.json().catch(() => null);
  if (attestation === null || typeof attestation !== "object") return unavailable();
  return json(attestation);
}

/**
 * POST /api/ai/chat { roomId, aiToken, clientPubKey, modelPubKey, messages }: one AI request. Every
 * message is already encrypted (the schema accepts only hex ciphertext), so nothing readable passes.
 */
export async function aiChat(request: Request, env: Env): Promise<Response> {
  if (await isRateLimited(env.RL_AI, request)) {
    return apiError("rate_limited", "Rate limit exceeded. Try again later.", 429);
  }
  const body = await readJson(request, AI_MAX_BODY_BYTES);
  if (body instanceof Response) return body;
  const parsed = aiChatRequestSchema.safeParse(body.value);
  if (!parsed.success) return apiError("invalid_request", "Malformed AI request.", 400);
  const { roomId, aiToken, clientPubKey, modelPubKey, messages } = parsed.data;
  if (!env.VENICE_API_KEY) return unavailable();

  const room = env.ROOM.getByName(roomId);
  const auth = await room.authorizeAi({ aiToken, spend: true });
  if (!auth.ok) return refused(auth.reason);

  let res: Response;
  try {
    res = await upstream(`${PROVIDER}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.VENICE_API_KEY}`,
        "Content-Type": "application/json",
        "X-Venice-TEE-Client-Pub-Key": clientPubKey.toLowerCase(),
        "X-Venice-TEE-Model-Pub-Key": modelPubKey.toLowerCase(),
        "X-Venice-TEE-Signing-Algo": "ecdsa",
      },
      body: JSON.stringify({
        model: AI_MODEL,
        messages,
        stream: true,
        max_tokens: AI_MAX_TOKENS,
        venice_parameters: {
          enable_e2ee: true,
          include_venice_system_prompt: false,
          enable_web_search: "off",
        },
      }),
    });
  } catch {
    await room.refundAi();
    return unavailable();
  }
  if (!res.ok || !res.body) {
    await room.refundAi();
    await res.body?.cancel().catch(() => undefined);
    return unavailable();
  }
  return new Response(res.body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream; charset=utf-8", ...SECURITY_HEADERS },
  });
}
