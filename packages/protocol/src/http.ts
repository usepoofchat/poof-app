import { z } from "zod";
import {
  FILE_MAX_BYTES_CEILING,
  HANDSHAKE_BLOB_MAX_BYTES,
  MAX_ROOM_PEERS,
  TIERS,
} from "./constants.ts";
import { ownerHashSchema, ownerSecretSchema, roomIdSchema } from "./ids.ts";
import { passSchema } from "./pay.ts";

export const planSchema = z.enum(["free", "super"]);
export type Plan = z.infer<typeof planSchema>;

export const tierSchema = z.enum(TIERS);

export const limitsSchema = z.object({
  fileTransfer: z.boolean(),
  fileMaxBytes: z.number().int().nonnegative().max(FILE_MAX_BYTES_CEILING),
});
export type Limits = z.infer<typeof limitsSchema>;

export const errorCodeSchema = z.enum([
  "rate_limited",
  "room_not_found",
  "handshake_exists",
  "handshake_not_found",
  "invalid_request",
  "invalid_handshake",
  "forbidden_origin",
  "unsupported_media_type",
  "payload_too_large",
  "method_not_allowed",
  "not_found",
  "internal_error",
  // Super Quant-Rooms
  "pay_unavailable",
  "chain_unavailable",
  "payment_invalid",
  "payment_underpaid",
  "payment_used",
  "key_changed",
  "pass_invalid",
  "pass_used",
  "not_owner",
]);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

export const errorBodySchema = z.object({
  error: z.object({ code: errorCodeSchema, message: z.string() }),
});
export type ErrorBody = z.infer<typeof errorBodySchema>;

/** POST /api/rooms. With a pass, the room is a Super Quant-Room of the pass's variant. */
export const createRoomRequestSchema = z.object({
  ownerHash: ownerHashSchema,
  pass: passSchema.optional(),
});
export type CreateRoomRequest = z.infer<typeof createRoomRequestSchema>;

export const createRoomResponseSchema = z.object({
  roomId: roomIdSchema,
  expiresAt: z.number().int(),
  serverNow: z.number().int(),
  plan: planSchema,
  tier: tierSchema,
  maxPeers: z.number().int().positive().max(MAX_ROOM_PEERS),
  limits: limitsSchema,
});
export type CreateRoomResponse = z.infer<typeof createRoomResponseSchema>;

/** POST /api/rooms/:id/upgrade: the creator turns the room into the pass's Super Quant-Room. */
export const upgradeRoomRequestSchema = z.object({
  ownerSecret: ownerSecretSchema,
  pass: passSchema,
});
export type UpgradeRoomRequest = z.infer<typeof upgradeRoomRequestSchema>;

/** GET /api/rooms/:id */
export const roomInfoSchema = createRoomResponseSchema.extend({
  peers: z.number().int().nonnegative().max(MAX_ROOM_PEERS),
});
export type RoomInfo = z.infer<typeof roomInfoSchema>;

/** PUT /api/handshakes/:id */
export const putHandshakeRequestSchema = z.object({
  blob: z
    .string()
    .min(1)
    .max(HANDSHAKE_BLOB_MAX_BYTES)
    .regex(/^[A-Za-z0-9+/_-]+={0,2}$/, "blob must be base64"),
});
export const putHandshakeResponseSchema = z.object({ expiresAt: z.number().int() });

/** POST /api/handshakes/:id/take */
export const takeHandshakeResponseSchema = z.object({
  blob: z.string().max(HANDSHAKE_BLOB_MAX_BYTES),
});

/** GET /api/health */
export const healthResponseSchema = z.object({
  ok: z.literal(true),
  version: z.string(),
  commit: z.string(),
});
