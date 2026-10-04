import type { Bytes } from "../encoding.ts";

const subtle = crypto.subtle;

export async function sha256(data: Uint8Array): Promise<Bytes> {
  return new Uint8Array(await subtle.digest("SHA-256", bytesOf(data)));
}

/** HKDF-SHA-256. `salt` may be empty (treated as a zero-filled salt per RFC 5869). */
export async function hkdf(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  length = 32,
): Promise<Bytes> {
  const key = await subtle.importKey("raw", bytesOf(ikm), "HKDF", false, ["deriveBits"]);
  const bits = await subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: bytesOf(salt), info: bytesOf(info) },
    key,
    length * 8,
  );
  return new Uint8Array(bits);
}

export async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Bytes> {
  const k = await subtle.importKey("raw", bytesOf(key), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  return new Uint8Array(await subtle.sign("HMAC", k, bytesOf(data)));
}

/** Verifies via WebCrypto, which compares in constant time. */
export async function verifyHmacSha256(
  key: Uint8Array,
  data: Uint8Array,
  mac: Uint8Array,
): Promise<boolean> {
  const k = await subtle.importKey("raw", bytesOf(key), { name: "HMAC", hash: "SHA-256" }, false, [
    "verify",
  ]);
  return subtle.verify("HMAC", k, bytesOf(mac), bytesOf(data));
}

export function importAesKey(raw: Uint8Array): Promise<CryptoKey> {
  return subtle.importKey("raw", bytesOf(raw), { name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
}

/** Narrow a Uint8Array to the ArrayBuffer-backed type WebCrypto wants (copies only if needed). */
function bytesOf(data: Uint8Array): Bytes {
  return data.buffer instanceof ArrayBuffer ? (data as Bytes) : new Uint8Array(data);
}
