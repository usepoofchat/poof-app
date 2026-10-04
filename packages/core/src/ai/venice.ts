import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import type { AiAttestation } from "@poof/protocol";
import {
  concat,
  equalBytes,
  fromBase64,
  fromUtf8,
  randomBytes,
  toBase64Url,
  utf8,
  type Bytes,
} from "../encoding.ts";
import { PoofError } from "../errors.ts";
import { hkdf, importAesKey, sha256 } from "../crypto/primitives.ts";

/**
 * Client side of the AI provider's end-to-end encrypted inference (secp256k1 ECDH + HKDF-SHA-256 +
 * AES-256-GCM), plus the room's AI token.
 *
 *   browser                                       enclave (Intel TDX)
 *   session keys (sk_c, pk_c)       ── pk_c ───►
 *   verifyAttestation(quote binds pk_m, nonce) ◄─ attestation
 *   per message: eph (sk_e, pk_e), ECDH(sk_e, pk_m) ─► pk_e ‖ iv ‖ AES-GCM(text)
 *   per chunk:   ECDH(sk_c, pk_s)              ◄─ pk_s ‖ iv ‖ AES-GCM(piece)
 *
 * The API in the middle only ever forwards hex ciphertext.
 */

/** A client session key pair: the enclave encrypts its answer to `publicKeyHex`. */
export interface AiSessionKeys {
  privateKey: Uint8Array;
  /** Uncompressed secp256k1 public key, lowercase hex (130 chars, "04…"). */
  publicKeyHex: string;
}

const HKDF_INFO = utf8("ecdsa_encryption");
const AI_TOKEN_INFO = utf8("poof/v1/ai-token");
const PUB_LEN = 65;
const IV_LEN = 12;
const TAG_LEN = 16;
/** Smallest encrypted payload: key ‖ IV ‖ tag, in hex. */
const MIN_CIPHER_HEX = 2 * (PUB_LEN + IV_LEN + TAG_LEN);

/** Intel TDX quote layout (v4): 48-byte header, then the 584-byte TD report body. */
const QUOTE_HEADER = 48;
const QUOTE_MIN_LEN = QUOTE_HEADER + 584;
const TEE_TYPE_TDX = 0x81;
const TD_ATTRIBUTES = QUOTE_HEADER + 120;
const REPORT_DATA = QUOTE_HEADER + 520;

/** Zero-fill secret bytes once they're no longer needed. */
export function wipe(bytes: Uint8Array): void {
  bytes.fill(0);
}

/** A fresh session key pair (one per AI request). */
export function generateAiSessionKeys(): AiSessionKeys {
  const privateKey = secp256k1.utils.randomSecretKey();
  return { privateKey, publicKeyHex: toHex(secp256k1.getPublicKey(privateKey, false)) };
}

/** 32 random bytes to bind an attestation to this request, and their hex. */
export function newAttestationNonce(): { bytes: Bytes; hex: string } {
  const nonce = randomBytes(32);
  return { bytes: nonce, hex: toHex(nonce) };
}

/**
 * Checks the enclave's attestation and returns the model's public key (130 hex chars, "04…").
 *
 * It checks that the TDX quote is a non-debug TD whose REPORTDATA binds the model's signing key
 * (its Ethereum address) and our fresh nonce. It does NOT verify Intel's signature chain over the
 * quote (DCAP: PCK certificate → Intel root); until that is added, the quote's authenticity rests
 * on the provider's `verified` flag.
 */
export async function verifyAttestation(
  att: AiAttestation,
  nonce: Uint8Array,
  expectedModel: string,
): Promise<string> {
  if (nonce.length !== 32) attestationFailed("the nonce must be 32 bytes");
  if (att.verified !== true) attestationFailed("the provider did not verify the enclave");
  if (att.nonce?.toLowerCase() !== toHex(nonce)) {
    attestationFailed("the attestation is for another nonce");
  }
  if (att.model !== expectedModel) attestationFailed("the attestation is for another model");

  const modelKey = normaliseModelKey(att.signing_key ?? att.signing_public_key);
  if (!modelKey) return attestationFailed("the attestation has no valid signing key");

  const quote = decodeQuote(att.intel_quote);
  if (!quote || quote.length < QUOTE_MIN_LEN) {
    return attestationFailed("the TDX quote is missing or too short");
  }
  const view = new DataView(quote.buffer, quote.byteOffset, quote.byteLength);
  if (view.getUint32(4, true) !== TEE_TYPE_TDX) {
    attestationFailed("the quote is not from a TDX enclave");
  }
  if ((view.getUint8(TD_ATTRIBUTES) & 1) !== 0) attestationFailed("the enclave runs in debug mode");

  const reportData = quote.subarray(REPORT_DATA, REPORT_DATA + 64);
  if (!equalBytes(reportData.subarray(0, 20), ethAddress(fromHex(modelKey)))) {
    attestationFailed("the quote does not bind the signing key");
  }
  const boundNonce = reportData.subarray(32, 64);
  const rawMatch = equalBytes(boundNonce, nonce);
  const hashMatch = equalBytes(boundNonce, await sha256(nonce));
  if (!rawMatch && !hashMatch) attestationFailed("the quote does not bind our nonce");
  return modelKey;
}

function attestationFailed(reason: string): never {
  throw new PoofError("ai_attestation_failed", reason);
}

/** Encrypt one message to the model: hex(ephemeral pub ‖ IV ‖ AES-GCM ciphertext+tag). */
export async function encryptForModel(plaintext: string, modelPubKeyHex: string): Promise<string> {
  const modelKey = normaliseModelKey(modelPubKeyHex);
  if (!modelKey) throw new PoofError("ai_attestation_failed", "invalid model key");
  const ephemeral = secp256k1.utils.randomSecretKey();
  try {
    const ephemeralPub = secp256k1.getPublicKey(ephemeral, false);
    const key = await deriveKey(ephemeral, fromHex(modelKey));
    const iv = randomBytes(IV_LEN);
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, utf8(plaintext));
    return toHex(concat(ephemeralPub, iv, new Uint8Array(ct)));
  } finally {
    wipe(ephemeral);
  }
}

/**
 * Decrypt one streamed piece of the answer. Empty or whitespace-only content passes through;
 * anything else must be ciphertext to our session key, or it is refused (fail closed).
 */
export async function decryptAiChunk(content: string, keys: AiSessionKeys): Promise<string> {
  if (content.trim() === "") return content;
  if (content.length < MIN_CIPHER_HEX || !isHex(content)) {
    throw new PoofError("ai_failed", "the AI sent an unencrypted answer");
  }
  const data = fromHex(content);
  if (data[0] !== 0x04) throw new PoofError("ai_failed", "the AI sent an unencrypted answer");
  try {
    const key = await deriveKey(keys.privateKey, data.subarray(0, PUB_LEN));
    const iv = data.slice(PUB_LEN, PUB_LEN + IV_LEN);
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      key,
      data.slice(PUB_LEN + IV_LEN),
    );
    return fromUtf8(new Uint8Array(pt));
  } catch {
    throw new PoofError("ai_failed", "the AI answer could not be decrypted");
  }
}

/**
 * Parse the SSE body and yield decrypted text pieces in order. Ends at `data: [DONE]` (or a
 * finish chunk followed by end of stream); a stream that just stops is reported as `ai_failed`.
 */
export async function* readAiStream(
  body: ReadableStream<Uint8Array>,
  keys: AiSessionKeys,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let finished = false;
  let done = false;
  try {
    while (!done) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch {
        throw new PoofError("ai_failed", "the AI answer broke off");
      }
      if (chunk.done) {
        buffer += decoder.decode();
        done = true;
      } else {
        buffer += decoder.decode(chunk.value, { stream: true });
      }
      const lines = buffer.split("\n");
      buffer = done ? "" : lines.pop()!;
      for (const raw of lines) {
        const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
        if (!line.startsWith("data:")) continue; // blank separators, comments, other fields
        const data = line.slice(line.startsWith("data: ") ? 6 : 5).trim();
        if (data === "[DONE]") return;
        const event = parseEvent(data);
        if (event.finished) finished = true;
        if (event.content !== undefined) {
          const text = await decryptAiChunk(event.content, keys);
          if (text !== "") yield text;
        }
      }
    }
    if (!finished) throw new PoofError("ai_failed", "the AI answer broke off");
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/**
 * The room's AI token: HKDF-SHA-256(roomKey, info "poof/v1/ai-token"), base64url (43 chars), and
 * its hash base64url(SHA-256(token bytes)), the same form as ownerSecret/ownerHash.
 */
export async function deriveAiToken(roomKey: Uint8Array): Promise<{ token: string; hash: string }> {
  const raw = await hkdf(roomKey, new Uint8Array(0), AI_TOKEN_INFO, 32);
  try {
    return { token: toBase64Url(raw), hash: toBase64Url(await sha256(raw)) };
  } finally {
    wipe(raw);
  }
}

function parseEvent(data: string): { content?: string; finished: boolean } {
  let event: unknown;
  try {
    event = JSON.parse(data);
  } catch {
    throw new PoofError("ai_failed", "the AI sent an unreadable event");
  }
  if (typeof event !== "object" || event === null) {
    throw new PoofError("ai_failed", "the AI sent an unreadable event");
  }
  if ("error" in event && event.error !== undefined && event.error !== null) {
    throw new PoofError("ai_unavailable", "the AI returned an error");
  }
  const choice: unknown =
    "choices" in event && Array.isArray(event.choices) ? event.choices[0] : undefined;
  if (typeof choice !== "object" || choice === null) return { finished: false };
  const finished =
    "finish_reason" in choice &&
    choice.finish_reason !== null &&
    choice.finish_reason !== undefined;
  const delta: unknown = "delta" in choice ? choice.delta : undefined;
  if (typeof delta !== "object" || delta === null || !("content" in delta)) return { finished };
  const content = delta.content;
  if (content === null || content === undefined) return { finished };
  if (typeof content !== "string")
    throw new PoofError("ai_failed", "the AI sent an unreadable event");
  return { content, finished };
}

/** AES-256-GCM key from x(ECDH(secret, public)) via HKDF-SHA-256 ("ecdsa_encryption"). */
async function deriveKey(secret: Uint8Array, publicKey: Uint8Array): Promise<CryptoKey> {
  const point = secp256k1.getSharedSecret(secret, publicKey, false);
  const shared = point.slice(1, 33);
  wipe(point);
  try {
    const raw = await hkdf(shared, new Uint8Array(0), HKDF_INFO, 32);
    try {
      return await importAesKey(raw);
    } finally {
      wipe(raw);
    }
  } finally {
    wipe(shared);
  }
}

/** "04"-prefixed lowercase hex of a valid uncompressed secp256k1 key, or undefined. */
function normaliseModelKey(key: string | undefined): string | undefined {
  if (typeof key !== "string") return undefined;
  let hex = key.toLowerCase();
  if (hex.startsWith("0x")) hex = hex.slice(2);
  if (hex.length === 128) hex = `04${hex}`;
  if (hex.length !== 130 || !hex.startsWith("04") || !isHex(hex)) return undefined;
  return secp256k1.utils.isValidPublicKey(fromHex(hex), false) ? hex : undefined;
}

/** Ethereum address: the last 20 bytes of keccak256(x ‖ y). */
function ethAddress(uncompressed: Uint8Array): Uint8Array {
  return keccak_256(uncompressed.subarray(1)).subarray(12);
}

/** The quote as hex, or base64 (standard or url-safe, padding optional). */
function decodeQuote(quote: string | undefined): Bytes | undefined {
  if (typeof quote !== "string" || quote === "") return undefined;
  const text = quote.trim();
  if (isHex(text)) return fromHex(text);
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(text)) return undefined;
  const std = text.replace(/=+$/, "").replace(/-/g, "+").replace(/_/g, "/");
  try {
    return fromBase64(std + "=".repeat((4 - (std.length % 4)) % 4));
  } catch {
    return undefined;
  }
}

function isHex(text: string): boolean {
  return text.length % 2 === 0 && /^[0-9a-f]*$/i.test(text);
}

function toHex(data: Uint8Array): string {
  let out = "";
  for (const b of data) out += b.toString(16).padStart(2, "0");
  return out;
}

/** Callers check `isHex` first. */
function fromHex(hex: string): Bytes {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
}
