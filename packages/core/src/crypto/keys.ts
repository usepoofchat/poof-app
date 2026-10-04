import { ROOM_KEY_BYTES, roomKeySchema } from "@poof/protocol";
import { fromBase64Url, randomBytes, toBase64Url, type Bytes } from "../encoding.ts";
import { PoofError } from "../errors.ts";

/** 32 random bytes. Lives only in the URL fragment and in memory. */
export function generateRoomKey(): Bytes {
  return randomBytes(ROOM_KEY_BYTES);
}

/** base64url, no padding: 43 chars. */
export function encodeRoomKey(key: Uint8Array): string {
  return toBase64Url(key);
}

export function decodeRoomKey(encoded: string): Bytes {
  if (!roomKeySchema.safeParse(encoded).success) {
    throw new PoofError("invalid_link", "Room key must be 43 base64url characters.");
  }
  return fromBase64Url(encoded);
}
