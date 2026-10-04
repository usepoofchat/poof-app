import { z } from "zod";
import { ownerSecretSchema, peerIdSchema, roomIdSchema } from "./ids.ts";

/**
 * The uncensored AI model in Super Quant-Rooms.
 *
 * The model runs in a hardware enclave (Intel TDX) at the AI provider. The asking browser encrypts
 * the conversation to the enclave's attested key; the API only forwards ciphertext, holds the
 * provider key and keeps a per-room budget. Nobody outside the enclave sees the text.
 */

/** The model every AI request uses (the API forces it). */
export const AI_MODEL = "e2ee-gemma-4-26b-a4b-uncensored-p";

/** Requests a quant-room may make, by lifetime (seconds). */
export const AI_BUDGET: Record<number, number> = { 3600: 150, 86400: 600 };
/** Requests per room per minute. */
export const AI_PER_MINUTE = 10;
/** Longest answer, in tokens. */
export const AI_MAX_TOKENS = 1024;
/** Longest answer the others accept over the mesh, in characters. */
export const AI_MAX_CHARS = 8000;
/** Biggest AI request body the API forwards. */
export const AI_MAX_BODY_BYTES = 512 * 1024;

/** A message that starts with this asks the AI (group rooms). */
export const AI_MENTION = /^\s*@ai\b[\s,:]*/i;

const hex = (min: number, max: number) =>
  z
    .string()
    .min(min)
    .max(max)
    .regex(/^[0-9a-f]+$/i, "expected hex");

/** base64url(SHA-256(aiToken)): what the room keeps to check members' AI calls. */
export const aiHashSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/, "invalid ai hash");
/** base64url of 32 bytes, derived from the room key (see core/ai). */
export const aiTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/, "invalid ai token");

/** POST /api/rooms/:id/ai: the creator registers the room's AI token hash. */
export const registerAiRequestSchema = z.object({
  ownerSecret: ownerSecretSchema,
  aiHash: aiHashSchema,
});

/** POST /api/ai/attestation */
export const aiAttestationRequestSchema = z.object({
  roomId: roomIdSchema,
  aiToken: aiTokenSchema,
  /** 32 random bytes, hex. */
  nonce: hex(64, 64),
});

/** An uncompressed secp256k1 public key, hex (04 ‖ x ‖ y). */
export const secp256k1PubSchema = hex(130, 130).regex(/^04/, "expected an uncompressed key");

/** Encrypted content: ephemeral key (65) ‖ IV (12) ‖ ciphertext ‖ tag (16), hex. */
export const aiCiphertextSchema = hex(186, 2 * AI_MAX_BODY_BYTES);

/** POST /api/ai/chat. Only encrypted user/system messages: nothing readable ever passes the API. */
export const aiChatRequestSchema = z.object({
  roomId: roomIdSchema,
  aiToken: aiTokenSchema,
  clientPubKey: secp256k1PubSchema,
  modelPubKey: z.string().regex(/^(04)?[0-9a-f]{128}$/i, "invalid model key"),
  messages: z
    .array(
      z.object({ role: z.enum(["system", "user"]), content: aiCiphertextSchema }).strict(),
    )
    .min(1)
    .max(4),
});
export type AiChatRequest = z.infer<typeof aiChatRequestSchema>;

/** The attestation fields the browser checks. Extra fields pass through untouched. */
export const aiAttestationSchema = z.object({
  verified: z.boolean().optional(),
  nonce: z.string().optional(),
  model: z.string().optional(),
  intel_quote: z.string().optional(),
  signing_key: z.string().optional(),
  signing_public_key: z.string().optional(),
  signing_address: z.string().optional(),
  tee_provider: z.string().optional(),
});
export type AiAttestation = z.infer<typeof aiAttestationSchema>;

/** Peer → peer (FrameType.Ai): an AI answer, sent by whoever asked, once it's complete. */
export const aiPlaintextSchema = z.object({
  id: z.string().min(1).max(64),
  /** The id of the question it answers (that person's text message). */
  askId: z.string().min(1).max(64),
  /** Who asked: the sender's own peerId. Receivers check it matches the link it came on. */
  askedBy: peerIdSchema,
  text: z.string().min(1).max(AI_MAX_CHARS),
  ts: z.number().int(),
});
export type AiPlaintext = z.infer<typeof aiPlaintextSchema>;
