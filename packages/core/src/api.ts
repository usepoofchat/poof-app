import { createRoomResponseSchema, type CreateRoomResponse } from "@poof/protocol";
import { decodeRoomKey, encodeRoomKey, generateRoomKey } from "./crypto/keys.ts";
import { sha256 } from "./crypto/primitives.ts";
import { randomBytes, toBase64Url, type Bytes } from "./encoding.ts";
import { PoofError } from "./errors.ts";

export interface CreatedRoom {
  roomId: string;
  key: Bytes;
  /** Path + fragment to navigate to: `/join/#<roomId>.<key>`. The fragment never leaves the browser. */
  path: string;
  /**
   * The creator's proof (base64url, 32 random bytes). NOT part of the invite link: only the creator's
   * browser keeps it, and only it can destroy the room. The server only ever saw its SHA-256.
   */
  ownerSecret: string;
  info: CreateRoomResponse;
}

/**
 * Create a room and generate its key. The key is generated AFTER the server responds, entirely in
 * the browser, and only ever placed in the URL fragment.
 */
export async function createRoom(opts: {
  fetch: typeof fetch;
  /** Origin of the API, e.g. "https://api.usepoof.chat". "" means same origin. */
  origin?: string;
}): Promise<CreatedRoom> {
  const secret = randomBytes(32);
  const ownerHash = toBase64Url(await sha256(secret));
  let res: Response;
  try {
    res = await opts.fetch(`${opts.origin ?? ""}/api/rooms`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ownerHash }),
    });
  } catch {
    throw new PoofError("connection_failed", "Could not reach the server.");
  }
  if (res.status === 429)
    throw new PoofError("rate_limited", "Too many rooms created. Try again soon.");
  if (!res.ok) throw new PoofError("connection_failed", `Server error ${res.status}.`);

  const parsed = createRoomResponseSchema.safeParse(await res.json().catch(() => null));
  if (!parsed.success) throw new PoofError("connection_failed", "Unexpected server response.");

  const key = generateRoomKey();
  return {
    roomId: parsed.data.roomId,
    key,
    path: roomPath(parsed.data.roomId, key),
    ownerSecret: toBase64Url(secret),
    info: parsed.data,
  };
}

/** Where invite links open on the web app. Everything room-specific stays in the fragment. */
export const INVITE_PATH = "/join/";

/** The invite part of a link: `<22-char room id>.<43-char key>`, all base64url. */
export function inviteFragment(roomId: string, key: Uint8Array): string {
  return `${roomId}.${encodeRoomKey(key)}`;
}

export function roomPath(roomId: string, key: Uint8Array): string {
  return `${INVITE_PATH}#${inviteFragment(roomId, key)}`;
}

/**
 * Full shareable URL for a room on the web app at `appOrigin`: `<appOrigin>/join/#<id>.<key>`. The
 * room id and the key are both after `#`, so neither reaches any server, not even in access logs.
 */
export function inviteUrl(appOrigin: string, roomId: string, key: Uint8Array): string {
  return `${appOrigin.replace(/\/+$/, "")}${roomPath(roomId, key)}`;
}

/**
 * Read the room id and key from an invite fragment (`<id>.<key>`, with or without a leading "#").
 * Throws PoofError("invalid_link") for anything else.
 */
export function parseInviteFragment(fragment: string): { roomId: string; key: Bytes } {
  const match = /^#?([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]+)$/.exec(fragment);
  if (!match?.[1] || !match[2]) throw new PoofError("invalid_link", "Not a room link.");
  return { roomId: match[1], key: decodeRoomKey(match[2]) };
}

/**
 * Read the room id and key from a location. Throws PoofError("invalid_link") for anything that isn't
 * exactly `/join/#<22-char id>.<43-char key>` (the trailing slash is optional).
 */
export function parseRoomLocation(pathname: string, hash: string): { roomId: string; key: Bytes } {
  if (!/^\/join\/?$/.test(pathname)) throw new PoofError("invalid_link", "Not a room link.");
  return parseInviteFragment(hash);
}
