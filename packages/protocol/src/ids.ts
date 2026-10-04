import { z } from "zod";
import {
  HANDSHAKE_ID_LENGTH,
  ID_LENGTH,
  OWNER_TOKEN_LENGTH,
  ROOM_KEY_LENGTH,
} from "./constants.ts";

const base64url = (len: number) => new RegExp(`^[A-Za-z0-9_-]{${len}}$`);

export const roomIdSchema = z.string().regex(base64url(ID_LENGTH), "invalid room id");
export const peerIdSchema = z.string().regex(base64url(ID_LENGTH), "invalid peer id");
export const handshakeIdSchema = z
  .string()
  .regex(base64url(HANDSHAKE_ID_LENGTH), "invalid handshake id");
/** One file transfer: 16 random bytes, base64url. Also the chat item id on every screen. */
export const fileIdSchema = z.string().regex(base64url(ID_LENGTH), "invalid file id");
export const roomKeySchema = z.string().regex(base64url(ROOM_KEY_LENGTH), "invalid room key");
/** base64url(32 random bytes), kept by the creator's browser. */
export const ownerSecretSchema = z
  .string()
  .regex(base64url(OWNER_TOKEN_LENGTH), "invalid owner secret");
/** base64url(SHA-256(owner secret bytes)), stored by the server. */
export const ownerHashSchema = z
  .string()
  .regex(base64url(OWNER_TOKEN_LENGTH), "invalid owner hash");

export function isRoomId(value: unknown): value is string {
  return roomIdSchema.safeParse(value).success;
}
export function isPeerId(value: unknown): value is string {
  return peerIdSchema.safeParse(value).success;
}
export function isHandshakeId(value: unknown): value is string {
  return handshakeIdSchema.safeParse(value).success;
}
