import { z } from "zod";
import { ID_LENGTH, OWNER_TOKEN_LENGTH } from "./constants.ts";

/**
 * Poof Note: a one-time message, encrypted in the browser, deleted from the server by its first
 * reading. The server stores ciphertext it can't open and two hashes; the key lives only in the
 * link's fragment (`/note/#<id>.<key>`, `.p` at the end when a password is also needed).
 */

/** Note lifetimes: 10 minutes, 1 hour or 24 hours. */
export const NOTE_TTLS_SECONDS = [600, 3600, 86_400] as const;
export type NoteTtl = (typeof NOTE_TTLS_SECONDS)[number];
/** What the person can type. */
export const NOTE_TEXT_MAX_CHARS = 10_000;
/** The encrypted note as stored: header + IV + ciphertext + tag. */
export const NOTE_CIPHERTEXT_MAX_BYTES = 16 * 1024;
/** POST /api/notes body cap (base64url of the largest ciphertext plus the other fields). */
export const NOTE_MAX_JSON_BODY_BYTES = 32 * 1024;
/** Wrong reveal attempts (a wrong password) a note survives; the next one deletes it. */
export const NOTE_MAX_WRONG_REVEALS = 10;
/** PBKDF2-SHA-256 iterations for the optional password. */
export const NOTE_PASSWORD_ITERATIONS = 200_000;
/** Where note links open on the web app. Everything note-specific stays in the fragment. */
export const NOTE_PATH = "/note/";

const base64url = (len: number) => new RegExp(`^[A-Za-z0-9_-]{${len}}$`);
const B64URL_MAX = Math.ceil((NOTE_CIPHERTEXT_MAX_BYTES * 4) / 3);

/** 16 random bytes, base64url, made by the creator's browser (it is part of the encryption's AAD). */
export const noteIdSchema = z.string().regex(base64url(ID_LENGTH), "invalid note id");
/** base64url(32 bytes): a secret the browser keeps, or the SHA-256 the server keeps of one. */
const token = z.string().regex(base64url(OWNER_TOKEN_LENGTH), "invalid token");
export const noteTtlSchema = z.union([
  z.literal(NOTE_TTLS_SECONDS[0]),
  z.literal(NOTE_TTLS_SECONDS[1]),
  z.literal(NOTE_TTLS_SECONDS[2]),
]);
export const noteCiphertextSchema = z
  .string()
  .min(1)
  .max(B64URL_MAX)
  .regex(/^[A-Za-z0-9_-]+$/, "invalid ciphertext");

export function isNoteId(value: unknown): value is string {
  return noteIdSchema.safeParse(value).success;
}

/**
 * POST /api/notes. `creatorHash` = SHA-256 of the creator's secret (for status and delete);
 * `revealHash` = SHA-256 of the reveal token, which only someone holding the link key (and the
 * password, if any) can compute. The server never sees the key, the secret or the token.
 */
export const createNoteRequestSchema = z.object({
  id: noteIdSchema,
  ciphertext: noteCiphertextSchema,
  ttl: noteTtlSchema,
  creatorHash: token,
  revealHash: token,
});
export type CreateNoteRequest = z.infer<typeof createNoteRequestSchema>;
export const createNoteResponseSchema = z.object({ id: noteIdSchema, expiresAt: z.number().int() });

/** POST /api/notes/:id/reveal: returns the ciphertext and deletes it, in one step. */
export const revealNoteRequestSchema = z.object({ revealToken: token });
export const revealNoteResponseSchema = z.object({ ciphertext: noteCiphertextSchema });

/** POST /api/notes/:id/status and DELETE /api/notes/:id: the creator only. */
export const noteCreatorRequestSchema = z.object({ creatorSecret: token });
export const noteStateSchema = z.enum(["waiting", "read", "deleted", "expired"]);
export type NoteState = z.infer<typeof noteStateSchema>;
export const noteStatusResponseSchema = z.object({
  state: noteStateSchema,
  /** When the note (or what's left of it) disappears. Absent once it's gone. */
  expiresAt: z.number().int().optional(),
});
export type NoteStatus = z.infer<typeof noteStatusResponseSchema>;
