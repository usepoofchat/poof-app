import { wordlist } from "@scure/bip39/wordlists/english.js";
import { putHandshakeResponseSchema, takeHandshakeResponseSchema } from "@poof/protocol";
import { parseRoomLocation, roomPath } from "./api.ts";
import { hkdf } from "./crypto/primitives.ts";
import {
  concat,
  fromBase64,
  fromUtf8,
  randomBytes,
  toBase64,
  toBase64Url,
  utf8,
  type Bytes,
} from "./encoding.ts";
import { PoofError } from "./errors.ts";

/**
 * 4-word phrase invite.
 *
 *   phrase = 4 words from the BIP-39 English list (2048 words → 44 bits), joined by "-"
 *   seed   = PBKDF2-SHA256(phrase, salt = "poof/v1/handshake", 200,000 iterations, 32 bytes)
 *   id     = base64url(HKDF(seed, "id"))      → the mailbox address (43 chars)
 *   key    = HKDF(seed, "key")                → AES-256-GCM
 *   blob   = base64(nonce(12) ‖ AES-GCM(key, nonce, room URL with #key))
 *
 * The mailbox id comes from the same slow derivation as the key, so the server can't recover the
 * phrase with a fast hash. Brute force costs 2^44 × 200k PBKDF2 iterations,
 * which is out of reach within a room's lifetime for a 10-minute room. Longer-lived rooms need a stronger invite.
 */

export const PHRASE_WORDS = 4;
export const PHRASE_KDF_ITERATIONS = 200_000;
const LABELS = {
  salt: "poof/v1/handshake",
  id: "poof/v1/handshake/id",
  key: "poof/v1/handshake/key",
} as const;
const NONCE_BYTES = 12;
const WORDS = new Set(wordlist);

/** Four random words. 2048 = 2^11, so taking 11 bits per word is unbiased. */
export function generatePhrase(): string {
  const random = randomBytes(PHRASE_WORDS * 2);
  const words: string[] = [];
  for (let i = 0; i < PHRASE_WORDS; i++) {
    const index = ((random[i * 2]! << 8) | random[i * 2 + 1]!) & 0x7ff;
    words.push(wordlist[index]!);
  }
  return words.join("-");
}

/**
 * Canonical form of what someone typed: lowercase words joined by "-". Accepts spaces, dashes,
 * dots, commas or underscores between words ("Amber otter quiet lantern" works). Null if it isn't
 * exactly four words from the list.
 */
export function normalizePhrase(input: string): string | null {
  const words = input
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .split(/[\s\-_.,]+/)
    .filter(Boolean);
  if (words.length !== PHRASE_WORDS || !words.every((w) => WORDS.has(w))) return null;
  return words.join("-");
}

export interface PhraseKeys {
  /** Mailbox id, 43-char base64url. */
  id: string;
  key: CryptoKey;
}

export async function derivePhraseKeys(phrase: string): Promise<PhraseKeys> {
  const subtle = crypto.subtle;
  const base = await subtle.importKey("raw", utf8(phrase), "PBKDF2", false, ["deriveBits"]);
  const seed = new Uint8Array(
    await subtle.deriveBits(
      {
        name: "PBKDF2",
        hash: "SHA-256",
        salt: utf8(LABELS.salt),
        iterations: PHRASE_KDF_ITERATIONS,
      },
      base,
      256,
    ),
  );
  const empty = new Uint8Array(0);
  const [id, rawKey] = await Promise.all([
    hkdf(seed, empty, utf8(LABELS.id)),
    hkdf(seed, empty, utf8(LABELS.key)),
  ]);
  const key = await subtle.importKey("raw", rawKey, { name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
  return { id: toBase64Url(id), key };
}

export async function sealInvite(key: CryptoKey, url: string): Promise<string> {
  const nonce = randomBytes(NONCE_BYTES);
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, utf8(url)),
  );
  return toBase64(concat(nonce, sealed));
}

/** Throws PoofError("decrypt_failed") if the blob wasn't sealed with this key or was altered. */
export async function openInvite(key: CryptoKey, blob: string): Promise<string> {
  let data: Bytes;
  try {
    data = fromBase64(blob);
  } catch {
    throw new PoofError("decrypt_failed", "That code doesn't open a room.");
  }
  if (data.length <= NONCE_BYTES)
    throw new PoofError("decrypt_failed", "That code doesn't open a room.");
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: data.subarray(0, NONCE_BYTES) },
      key,
      data.subarray(NONCE_BYTES),
    );
    return fromUtf8(new Uint8Array(plain));
  } catch {
    throw new PoofError("decrypt_failed", "That code doesn't open a room.");
  }
}

/**
 * Put the room's invite URL behind a fresh phrase. Returns the phrase and the mailbox expiry in the
 * SERVER's clock (the session converts it). Retries with a new phrase if the id is taken.
 */
export async function createPhraseInvite(opts: {
  fetch: typeof fetch;
  /** Origin of the API. */
  origin: string;
  inviteUrl: string;
}): Promise<{ code: string; serverExpiresAt: number }> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const code = generatePhrase();
    const { id, key } = await derivePhraseKeys(code);
    const blob = await sealInvite(key, opts.inviteUrl);
    let res: Response;
    try {
      res = await opts.fetch(`${opts.origin}/api/handshakes/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ blob }),
      });
    } catch {
      throw new PoofError("connection_failed", "Could not reach the server.");
    }
    if (res.status === 409) continue; // astronomically rare: someone else's phrase. Pick another.
    if (res.status === 429) throw new PoofError("rate_limited", "Too many codes. Try again soon.");
    if (!res.ok) throw new PoofError("connection_failed", `Server error ${res.status}.`);
    const parsed = putHandshakeResponseSchema.safeParse(await res.json().catch(() => null));
    if (!parsed.success) throw new PoofError("connection_failed", "Unexpected server response.");
    return { code, serverExpiresAt: parsed.data.expiresAt };
  }
  throw new PoofError("connection_failed", "Could not create a code. Try again.");
}

/**
 * "Join a quant-room": turn a phrase into the room path to navigate to (`/join/#<id>.<key>`).
 * The mailbox is one-time: a code works once. The decrypted URL must point at the web app's origin
 * and be a well-formed room link, so a malicious blob can't redirect the person elsewhere.
 */
export async function joinByPhrase(opts: {
  fetch: typeof fetch;
  /** Origin of the API. */
  origin: string;
  /** Origin of the web app the invite must point at. Defaults to `origin`. */
  appOrigin?: string;
  code: string;
}): Promise<string> {
  const target = await takePhraseUrl(opts, "That code doesn't open a room.");
  let room: { roomId: string; key: Bytes };
  try {
    room = parseRoomLocation(target.pathname, target.hash);
  } catch {
    throw new PoofError("decrypt_failed", "That code doesn't open a room.");
  }
  return roomPath(room.roomId, room.key);
}

/**
 * Open a phrase's one-time mailbox and return the link inside it, checked to be on the web app's own
 * origin with no query string, so a malicious blob can't send the person elsewhere. What the link
 * must look like beyond that (a room, a note) is up to the caller.
 */
export async function takePhraseUrl(
  opts: { fetch: typeof fetch; origin: string; appOrigin?: string; code: string },
  wrongMessage: string,
): Promise<URL> {
  const phrase = normalizePhrase(opts.code);
  if (!phrase) throw new PoofError("invalid_code", "Enter the four words you were given.");

  const { id, key } = await derivePhraseKeys(phrase);
  let res: Response;
  try {
    res = await opts.fetch(`${opts.origin}/api/handshakes/${id}/take`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
  } catch {
    throw new PoofError("connection_failed", "Could not reach the server.");
  }
  if (res.status === 404)
    throw new PoofError("not_found_or_expired", "That code was already used or has expired.");
  if (res.status === 429) throw new PoofError("rate_limited", "Too many attempts. Try again soon.");
  if (!res.ok) throw new PoofError("connection_failed", `Server error ${res.status}.`);
  const parsed = takeHandshakeResponseSchema.safeParse(await res.json().catch(() => null));
  if (!parsed.success) throw new PoofError("connection_failed", "Unexpected server response.");

  let url: string;
  try {
    url = await openInvite(key, parsed.data.blob);
  } catch {
    throw new PoofError("decrypt_failed", wrongMessage);
  }
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    throw new PoofError("decrypt_failed", wrongMessage);
  }
  if (target.origin !== new URL(opts.appOrigin ?? opts.origin).origin || target.search !== "") {
    throw new PoofError("decrypt_failed", wrongMessage);
  }
  return target;
}
