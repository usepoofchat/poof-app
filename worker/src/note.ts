import {
  MAX_JSON_BODY_BYTES,
  NOTE_MAX_JSON_BODY_BYTES,
  createNoteRequestSchema,
  isNoteId,
  noteCreatorRequestSchema,
  revealNoteRequestSchema,
} from "@poof/protocol";
import { apiError, isRateLimited, json, readJson } from "./http.ts";

/** POST /api/notes { id, ciphertext, ttl, creatorHash, revealHash } */
export async function createNote(request: Request, env: Env): Promise<Response> {
  if (await isRateLimited(env.RL_NOTE_CREATE, request)) {
    return apiError("rate_limited", "Rate limit exceeded. Try again later.", 429);
  }
  const body = await readJson(request, NOTE_MAX_JSON_BODY_BYTES);
  if (body instanceof Response) return body;
  const parsed = createNoteRequestSchema.safeParse(body.value);
  if (!parsed.success) {
    return apiError(
      "invalid_request",
      "Expected { id, ciphertext, ttl, creatorHash, revealHash }.",
      400,
    );
  }
  const { id, ciphertext, ttl, creatorHash, revealHash } = parsed.data;
  const created = await env.NOTE.getByName(id).create({
    ciphertext,
    ttlSeconds: ttl,
    creatorHash,
    revealHash,
  });
  if (!created) return apiError("note_exists", "Note id already in use.", 409);
  return json({ id, expiresAt: created.expiresAt }, 201);
}

/** POST /api/notes/:id/reveal { revealToken }: the ciphertext, erased by this very request. */
export async function revealNote(
  request: Request,
  env: Env,
  id: string | undefined,
): Promise<Response> {
  if (await isRateLimited(env.RL_NOTE_READ, request)) {
    return apiError("rate_limited", "Rate limit exceeded. Try again later.", 429);
  }
  if (!isNoteId(id)) return gone();
  const body = await readJson(request, MAX_JSON_BODY_BYTES);
  if (body instanceof Response) return body;
  const parsed = revealNoteRequestSchema.safeParse(body.value);
  if (!parsed.success) return apiError("invalid_request", "Expected { revealToken }.", 400);
  const result = await env.NOTE.getByName(id).reveal(parsed.data.revealToken);
  if (result.ok) return json({ ciphertext: result.ciphertext });
  if (result.reason === "wrong_secret") {
    return apiError("wrong_secret", "That link or password doesn't open this note.", 403);
  }
  return gone();
}

/** POST /api/notes/:id/status { creatorSecret } and DELETE /api/notes/:id { creatorSecret } */
export async function noteForCreator(
  request: Request,
  env: Env,
  id: string | undefined,
  action: "status" | "remove",
): Promise<Response> {
  if (await isRateLimited(env.RL_NOTE_READ, request)) {
    return apiError("rate_limited", "Rate limit exceeded. Try again later.", 429);
  }
  if (!isNoteId(id)) return json({ state: "expired" });
  const body = await readJson(request, MAX_JSON_BODY_BYTES);
  if (body instanceof Response) return body;
  const parsed = noteCreatorRequestSchema.safeParse(body.value);
  if (!parsed.success) return apiError("invalid_request", "Expected { creatorSecret }.", 400);
  const stub = env.NOTE.getByName(id);
  const status =
    action === "status"
      ? await stub.status(parsed.data.creatorSecret)
      : await stub.remove(parsed.data.creatorSecret);
  if (!status) return apiError("not_owner", "Only the person who wrote the note can do that.", 403);
  return json(status);
}

function gone(): Response {
  return apiError("note_gone", "This note is gone.", 410);
}
