import { ID_BYTES } from "@poof/protocol";

const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** base64url without padding. */
export function toBase64Url(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out +=
      B64URL[(n >> 18) & 63]! + B64URL[(n >> 12) & 63]! + B64URL[(n >> 6) & 63]! + B64URL[n & 63]!;
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i]! << 16;
    out += B64URL[(n >> 18) & 63]! + B64URL[(n >> 12) & 63]!;
  } else if (rest === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out += B64URL[(n >> 18) & 63]! + B64URL[(n >> 12) & 63]! + B64URL[(n >> 6) & 63]!;
  }
  return out;
}

/** base64url without padding → bytes. Assumes the input already passed a base64url schema. */
export function fromBase64Url(text: string): Uint8Array {
  const out = new Uint8Array(Math.floor((text.length * 3) / 4));
  let bits = 0;
  let value = 0;
  let o = 0;
  for (const ch of text) {
    value = (value << 6) | B64URL.indexOf(ch);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (value >> bits) & 0xff;
    }
  }
  return out.subarray(0, o);
}

/** True if SHA-256(secret bytes) equals `expectedHash`. Constant-time on the hashes. */
export async function ownerSecretMatches(secret: string, expectedHash: string): Promise<boolean> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", fromBase64Url(secret)));
  const expected = fromBase64Url(expectedHash);
  return digest.length === expected.length && crypto.subtle.timingSafeEqual(digest, expected);
}

/** 16 random bytes → 22-char base64url id. Cryptographically secure. */
export function randomId(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(ID_BYTES)));
}

/** Parse a numeric var with a fallback; rejects non-positive or non-finite values. */
export function positiveInt(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}
