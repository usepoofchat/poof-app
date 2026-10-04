/**
 * Byte helpers. `Bytes` is an ArrayBuffer-backed Uint8Array, which is what WebCrypto's
 * `BufferSource` requires under TypeScript 5.7+ (a plain Uint8Array may be SharedArrayBuffer-backed).
 */
export type Bytes = Uint8Array<ArrayBuffer>;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

/** Copy any byte source into a fresh ArrayBuffer-backed Uint8Array. */
export function bytes(source: ArrayLike<number> | ArrayBuffer): Bytes {
  return source instanceof ArrayBuffer ? new Uint8Array(source).slice() : new Uint8Array(source);
}

export function utf8(text: string): Bytes {
  return bytes(encoder.encode(text));
}

export function fromUtf8(data: Uint8Array): string {
  return decoder.decode(data);
}

export function concat(...parts: Uint8Array[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Constant-time-ish equality for equal-length byte strings. */
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

function binary(data: Uint8Array): string {
  let s = "";
  const chunk = 0x8000;
  for (let i = 0; i < data.length; i += chunk) {
    s += String.fromCharCode(...data.subarray(i, i + chunk));
  }
  return s;
}

/** Standard base64 (with padding). Used where the wire format says "base64". */
export function toBase64(data: Uint8Array): string {
  return btoa(binary(data));
}

export function fromBase64(text: string): Bytes {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 !== 0) {
    throw new Error("invalid base64");
  }
  const raw = atob(text);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** base64url without padding. Used for ids and the URL-fragment key. */
export function toBase64Url(data: Uint8Array): string {
  return toBase64(data).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(text: string): Bytes {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error("invalid base64url");
  const padded =
    text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4);
  return fromBase64(padded);
}

export function randomBytes(length: number): Bytes {
  return crypto.getRandomValues(new Uint8Array(length));
}

/** Big-endian uint64 → 8 bytes. */
export function u64be(value: bigint): Bytes {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, value, false);
  return out;
}

export function readU64be(data: Uint8Array, offset = 0): bigint {
  return new DataView(data.buffer, data.byteOffset + offset, 8).getBigUint64(0, false);
}

/** Big-endian uint16 length prefix + data, for unambiguous transcript hashing. */
export function lengthPrefixed(data: Uint8Array): Bytes {
  if (data.length > 0xffff) throw new Error("field too long");
  const prefix = new Uint8Array(2);
  new DataView(prefix.buffer).setUint16(0, data.length, false);
  return concat(prefix, data);
}
