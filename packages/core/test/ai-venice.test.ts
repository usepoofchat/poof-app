import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { describe, expect, it } from "vitest";
import { AI_MODEL, type AiAttestation } from "@poof/protocol";
import {
  PoofError,
  decryptAiChunk,
  deriveAiToken,
  encryptForModel,
  fromBase64Url,
  generateAiSessionKeys,
  newAttestationNonce,
  readAiStream,
  toBase64,
  toBase64Url,
  utf8,
  verifyAttestation,
  wipe,
  type AiSessionKeys,
  type Bytes,
} from "../src/index.ts";

const INFO = new TextEncoder().encode("ecdsa_encryption");

const hex = (data: Uint8Array) => Array.from(data, (b) => b.toString(16).padStart(2, "0")).join("");
const unhex = (text: string) =>
  Uint8Array.from(text.match(/../g) ?? [], (h) => parseInt(h, 16)) as Bytes;
const sha256 = async (data: Uint8Array) =>
  new Uint8Array(await crypto.subtle.digest("SHA-256", data as Bytes));

async function aesKey(secret: Uint8Array, pub: Uint8Array): Promise<CryptoKey> {
  const shared = secp256k1.getSharedSecret(secret, pub, false).slice(1, 33);
  const ikm = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveBits"]);
  const raw = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: INFO },
    ikm,
    256,
  );
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** The enclave side: a model key, decrypting requests and encrypting answers. */
function fakeEnclave() {
  const secret = secp256k1.utils.randomSecretKey();
  const pub = secp256k1.getPublicKey(secret, false);
  return {
    pubHex: hex(pub),
    pub,
    async decrypt(cipherHex: string): Promise<string> {
      const data = unhex(cipherHex);
      const key = await aesKey(secret, data.subarray(0, 65));
      const pt = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: data.slice(65, 77) },
        key,
        data.slice(77),
      );
      return new TextDecoder().decode(pt);
    },
    /** Encrypt one answer piece to the client session key, with a fresh server ephemeral key. */
    async encryptTo(clientPubHex: string, text: string): Promise<string> {
      const eph = secp256k1.utils.randomSecretKey();
      const ephPub = secp256k1.getPublicKey(eph, false);
      const key = await aesKey(eph, unhex(clientPubHex));
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = new Uint8Array(
        await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, utf8(text)),
      );
      return hex(ephPub) + hex(iv) + hex(ct);
    },
  };
}

function ethAddress(pub: Uint8Array): Uint8Array {
  return keccak_256(pub.subarray(1)).subarray(12);
}

interface QuoteOpts {
  length?: number;
  teeType?: number;
  debug?: boolean;
  address?: Uint8Array;
  nonceBinding?: Uint8Array;
}

/** A fake TDX v4 quote: header (48) ‖ TD report body (584) ‖ some "signature" bytes. */
function fakeQuote(pub: Uint8Array, nonceBinding: Uint8Array, opts: QuoteOpts = {}): Uint8Array {
  const quote = crypto.getRandomValues(new Uint8Array(opts.length ?? 1000));
  const view = new DataView(quote.buffer);
  view.setUint16(0, 4, true);
  if (quote.length >= 8) view.setUint32(4, opts.teeType ?? 0x81, true);
  if (quote.length > 168) quote[168] = opts.debug ? 0x01 : 0x10; // other attribute bits are allowed
  if (quote.length >= 632) {
    quote.set(opts.address ?? ethAddress(pub), 568);
    quote.fill(0, 588, 600);
    quote.set(opts.nonceBinding ?? nonceBinding, 600);
  }
  return quote;
}

async function setup(opts: QuoteOpts & { hashNonce?: boolean } = {}) {
  const enclave = fakeEnclave();
  const nonce = newAttestationNonce();
  const binding = opts.hashNonce ? await sha256(nonce.bytes) : nonce.bytes;
  const quote = fakeQuote(enclave.pub, binding, opts);
  const att: AiAttestation = {
    verified: true,
    nonce: nonce.hex,
    model: AI_MODEL,
    intel_quote: hex(quote),
    signing_key: enclave.pubHex,
    tee_provider: "tdx",
  };
  return { enclave, nonce, quote, att };
}

async function attestationError(att: AiAttestation, nonce: Uint8Array, model = AI_MODEL) {
  const err: unknown = await verifyAttestation(att, nonce, model).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(PoofError);
  expect((err as PoofError).code).toBe("ai_attestation_failed");
  return (err as PoofError).message;
}

function sse(...chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}

const delta = (content: string | null) =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content } }] })}\n\n`;

async function collect(stream: ReadableStream<Uint8Array>, keys: AiSessionKeys): Promise<string[]> {
  const out: string[] = [];
  for await (const piece of readAiStream(stream, keys)) out.push(piece);
  return out;
}

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (e) {
    return e instanceof PoofError ? e.code : `not a PoofError: ${String(e)}`;
  }
}

describe("AI session keys and nonces", () => {
  it("makes uncompressed secp256k1 session keys", () => {
    const keys = generateAiSessionKeys();
    expect(keys.publicKeyHex).toMatch(/^04[0-9a-f]{128}$/);
    expect(keys.privateKey).toHaveLength(32);
    expect(hex(secp256k1.getPublicKey(keys.privateKey, false))).toBe(keys.publicKeyHex);
    expect(generateAiSessionKeys().publicKeyHex).not.toBe(keys.publicKeyHex);
  });

  it("makes 32-byte nonces with matching hex", () => {
    const n = newAttestationNonce();
    expect(n.bytes).toHaveLength(32);
    expect(n.hex).toMatch(/^[0-9a-f]{64}$/);
    expect(unhex(n.hex)).toEqual(n.bytes);
    expect(newAttestationNonce().hex).not.toBe(n.hex);
  });

  it("wipe zero-fills", () => {
    const b = Uint8Array.from([1, 2, 3]);
    wipe(b);
    expect(Array.from(b)).toEqual([0, 0, 0]);
  });
});

describe("encryptForModel", () => {
  it("the enclave decrypts what the client encrypted", async () => {
    const enclave = fakeEnclave();
    const text = "Hello enclave — ünïcødé 🙂";
    const ct = await encryptForModel(text, enclave.pubHex);
    expect(ct).toMatch(/^04[0-9a-f]+$/);
    expect(ct.length).toBe(2 * (65 + 12 + utf8(text).length + 16));
    expect(await enclave.decrypt(ct)).toBe(text);
  });

  it("uses a fresh ephemeral key and IV per message", async () => {
    const enclave = fakeEnclave();
    const a = await encryptForModel("same", enclave.pubHex);
    const b = await encryptForModel("same", enclave.pubHex);
    expect(a.slice(0, 130)).not.toBe(b.slice(0, 130));
    expect(a.slice(130, 154)).not.toBe(b.slice(130, 154));
  });

  it("accepts a 128-char model key without the 04 prefix, in any case", async () => {
    const enclave = fakeEnclave();
    const ct = await encryptForModel("hi", enclave.pubHex.slice(2).toUpperCase());
    expect(await enclave.decrypt(ct)).toBe("hi");
  });

  it("refuses a model key that isn't a curve point", async () => {
    const enclave = fakeEnclave();
    const bad = enclave.pubHex.slice(0, -2) + (enclave.pubHex.endsWith("00") ? "01" : "00");
    expect(await codeOf(encryptForModel("hi", bad))).toBe("ai_attestation_failed");
    expect(await codeOf(encryptForModel("hi", "04abcd"))).toBe("ai_attestation_failed");
  });
});

describe("decryptAiChunk", () => {
  it("decrypts a piece encrypted to the session key", async () => {
    const keys = generateAiSessionKeys();
    const enclave = fakeEnclave();
    expect(await decryptAiChunk(await enclave.encryptTo(keys.publicKeyHex, "piece"), keys)).toBe(
      "piece",
    );
  });

  it("accepts upper-case hex", async () => {
    const keys = generateAiSessionKeys();
    const ct = await fakeEnclave().encryptTo(keys.publicKeyHex, "x");
    expect(await decryptAiChunk(ct.toUpperCase(), keys)).toBe("x");
  });

  it("passes empty and whitespace-only content through", async () => {
    const keys = generateAiSessionKeys();
    expect(await decryptAiChunk("", keys)).toBe("");
    expect(await decryptAiChunk(" \n\t", keys)).toBe(" \n\t");
  });

  it("fails closed on plaintext, short, odd or non-04 content", async () => {
    const keys = generateAiSessionKeys();
    const ct = await fakeEnclave().encryptTo(keys.publicKeyHex, "secret");
    for (const content of [
      "Hello, I am not encrypted",
      "deadbeef",
      "04".padEnd(184, "0"),
      ct.slice(0, -1),
      `05${ct.slice(2)}`,
      `${ct}zz`,
    ]) {
      expect(await codeOf(decryptAiChunk(content, keys)), content).toBe("ai_failed");
    }
  });

  it("rejects tampered ciphertext, and ciphertext to another key", async () => {
    const keys = generateAiSessionKeys();
    const ct = await fakeEnclave().encryptTo(keys.publicKeyHex, "secret");
    const last = ct.slice(-2) === "00" ? "01" : "00";
    expect(await codeOf(decryptAiChunk(ct.slice(0, -2) + last, keys))).toBe("ai_failed");
    expect(await codeOf(decryptAiChunk(ct, generateAiSessionKeys()))).toBe("ai_failed");
    // An ephemeral key that isn't on the curve.
    const offCurve = `04${"00".repeat(64)}${ct.slice(130)}`;
    expect(await codeOf(decryptAiChunk(offCurve, keys))).toBe("ai_failed");
  });
});

describe("readAiStream", () => {
  it("yields decrypted pieces in order, across chunk boundaries", async () => {
    const keys = generateAiSessionKeys();
    const enclave = fakeEnclave();
    const pieces = ["Hel", "lo", " ", "wörld"];
    const role = `data: ${JSON.stringify({ choices: [{ delta: { role: "assistant" } }] })}\n\n`;
    const events = [role];
    for (const p of pieces) {
      events.push(
        p.trim() === "" ? delta(p) : delta(await enclave.encryptTo(keys.publicKeyHex, p)),
      );
    }
    events.push(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
    events.push(": keep-alive comment\n\n", "data: [DONE]\n\n");
    const whole = events.join("");
    // Split into 37-char chunks, so events break mid-line.
    const chunks: string[] = [];
    for (let i = 0; i < whole.length; i += 37) chunks.push(whole.slice(i, i + 37));
    expect(await collect(sse(...chunks), keys)).toEqual(pieces);
  });

  it("handles CRLF line endings, data without a space, and UTF-8 split across chunks", async () => {
    const keys = generateAiSessionKeys();
    const enclave = fakeEnclave();
    const a = await enclave.encryptTo(keys.publicKeyHex, "a");
    const body =
      `data:${JSON.stringify({ choices: [{ delta: { content: a } }] })}\r\n\r\n` +
      `: comment ✓\r\n\r\ndata: [DONE]\r\n\r\n`;
    const bytes = new TextEncoder().encode(body);
    const tick = body.indexOf("✓");
    const cut = new TextEncoder().encode(body.slice(0, tick)).length + 1; // inside the 3-byte char
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, cut));
        controller.enqueue(bytes.slice(cut));
        controller.close();
      },
    });
    expect(await collect(stream, keys)).toEqual(["a"]);
  });

  it("stops at [DONE] and ignores anything after it", async () => {
    const keys = generateAiSessionKeys();
    const ct = await fakeEnclave().encryptTo(keys.publicKeyHex, "one");
    expect(
      await collect(sse(delta(ct), "data: [DONE]\n\n", delta("plaintext after done")), keys),
    ).toEqual(["one"]);
  });

  it("ignores events with no content", async () => {
    const keys = generateAiSessionKeys();
    const ct = await fakeEnclave().encryptTo(keys.publicKeyHex, "x");
    const stream = sse(
      `data: ${JSON.stringify({ choices: [] })}\n\n`,
      `data: ${JSON.stringify({ id: "1", usage: { total_tokens: 3 } })}\n\n`,
      delta(null),
      delta(""),
      delta(ct),
      "event: ping\nid: 7\nretry: 100\n\n",
      "data: [DONE]\n\n",
    );
    expect(await collect(stream, keys)).toEqual(["x"]);
  });

  it("fails closed on a plaintext piece", async () => {
    const keys = generateAiSessionKeys();
    const ct = await fakeEnclave().encryptTo(keys.publicKeyHex, "ok");
    const seen: string[] = [];
    const run = async () => {
      for await (const p of readAiStream(
        sse(delta(ct), delta("leaked plaintext"), "data: [DONE]\n\n"),
        keys,
      )) {
        seen.push(p);
      }
    };
    expect(await codeOf(run())).toBe("ai_failed");
    expect(seen).toEqual(["ok"]);
  });

  it("fails on a tampered piece", async () => {
    const keys = generateAiSessionKeys();
    const ct = await fakeEnclave().encryptTo(keys.publicKeyHex, "ok");
    const tampered = ct.slice(0, 160) + (ct[160] === "0" ? "1" : "0") + ct.slice(161);
    expect(await codeOf(collect(sse(delta(tampered), "data: [DONE]\n\n"), keys))).toBe("ai_failed");
  });

  it("an error event means ai_unavailable", async () => {
    const keys = generateAiSessionKeys();
    const stream = sse(`data: ${JSON.stringify({ error: { message: "overloaded" } })}\n\n`);
    expect(await codeOf(collect(stream, keys))).toBe("ai_unavailable");
  });

  it("an unreadable event or a stream that breaks off means ai_failed", async () => {
    const keys = generateAiSessionKeys();
    const ct = await fakeEnclave().encryptTo(keys.publicKeyHex, "ok");
    expect(await codeOf(collect(sse("data: {not json\n\n"), keys))).toBe("ai_failed");
    expect(await codeOf(collect(sse(delta(ct)), keys))).toBe("ai_failed");
    const broken = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(delta(ct)));
        controller.error(new Error("network"));
      },
    });
    expect(await codeOf(collect(broken, keys))).toBe("ai_failed");
  });

  it("a finish chunk then end of stream (no [DONE]) is complete", async () => {
    const keys = generateAiSessionKeys();
    const ct = await fakeEnclave().encryptTo(keys.publicKeyHex, "end");
    const finish = `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}`;
    expect(await collect(sse(delta(ct), finish), keys)).toEqual(["end"]);
  });
});

describe("verifyAttestation", () => {
  it("accepts a quote binding the key and the raw nonce (hex quote)", async () => {
    const { enclave, nonce, att } = await setup();
    expect(await verifyAttestation(att, nonce.bytes, AI_MODEL)).toBe(enclave.pubHex);
  });

  it("accepts SHA-256(nonce) in REPORTDATA", async () => {
    const { enclave, nonce, att } = await setup({ hashNonce: true });
    expect(await verifyAttestation(att, nonce.bytes, AI_MODEL)).toBe(enclave.pubHex);
  });

  it("accepts base64, url-safe unpadded base64, upper-case nonce and a 128-char signing_public_key", async () => {
    const { enclave, nonce, quote, att } = await setup();
    const key128 = enclave.pubHex.slice(2).toUpperCase();
    for (const intel_quote of [toBase64(quote), toBase64Url(quote)]) {
      const variant: AiAttestation = {
        ...att,
        intel_quote,
        nonce: nonce.hex.toUpperCase(),
        signing_key: undefined,
        signing_public_key: key128,
      };
      expect(await verifyAttestation(variant, nonce.bytes, AI_MODEL)).toBe(enclave.pubHex);
    }
  });

  it("refuses when the provider did not verify", async () => {
    const { nonce, att } = await setup();
    await attestationError({ ...att, verified: false }, nonce.bytes);
    await attestationError({ ...att, verified: undefined }, nonce.bytes);
  });

  it("refuses another nonce", async () => {
    const { nonce, att } = await setup();
    await attestationError({ ...att, nonce: newAttestationNonce().hex }, nonce.bytes);
    await attestationError({ ...att, nonce: undefined }, nonce.bytes);
    await attestationError(att, newAttestationNonce().bytes);
    await attestationError(att, nonce.bytes.subarray(0, 16));
  });

  it("refuses another model", async () => {
    const { nonce, att } = await setup();
    await attestationError({ ...att, model: "some-other-model" }, nonce.bytes);
    await attestationError(att, nonce.bytes, "some-other-model");
  });

  it("refuses a missing or invalid signing key", async () => {
    const { nonce, att, enclave } = await setup();
    await attestationError({ ...att, signing_key: undefined }, nonce.bytes);
    await attestationError({ ...att, signing_key: "04abcdef" }, nonce.bytes);
    const offCurve = enclave.pubHex.slice(0, -2) + (enclave.pubHex.endsWith("00") ? "01" : "00");
    await attestationError({ ...att, signing_key: offCurve }, nonce.bytes);
    await attestationError(
      { ...att, signing_key: `02${enclave.pubHex.slice(2, 66)}` },
      nonce.bytes,
    );
  });

  it("refuses a missing, unparsable or short quote", async () => {
    const { nonce, att, enclave } = await setup();
    await attestationError({ ...att, intel_quote: undefined }, nonce.bytes);
    await attestationError({ ...att, intel_quote: "" }, nonce.bytes);
    await attestationError({ ...att, intel_quote: "not a quote!" }, nonce.bytes);
    const short = fakeQuote(enclave.pub, nonce.bytes, { length: 631 });
    await attestationError({ ...att, intel_quote: hex(short) }, nonce.bytes);
  });

  it("refuses a quote that isn't TDX", async () => {
    const { nonce, att } = await setup({ teeType: 0x00 });
    expect(await attestationError(att, nonce.bytes)).toMatch(/TDX/);
  });

  it("refuses a debug enclave", async () => {
    const { nonce, att } = await setup({ debug: true });
    expect(await attestationError(att, nonce.bytes)).toMatch(/debug/);
  });

  it("refuses a quote bound to another key", async () => {
    const other = fakeEnclave();
    const { nonce, att } = await setup({ address: ethAddress(other.pub) });
    expect(await attestationError(att, nonce.bytes)).toMatch(/signing key/);
    // …or the right quote with the key swapped.
    const good = await setup();
    await attestationError({ ...good.att, signing_key: other.pubHex }, good.nonce.bytes);
  });

  it("refuses a quote bound to another nonce", async () => {
    const { nonce, att } = await setup({ nonceBinding: newAttestationNonce().bytes });
    expect(await attestationError(att, nonce.bytes)).toMatch(/nonce/);
  });
});

describe("deriveAiToken", () => {
  it("is deterministic, 43 chars, and differs per room key", async () => {
    const roomKey = crypto.getRandomValues(new Uint8Array(32));
    const a = await deriveAiToken(roomKey);
    const b = await deriveAiToken(roomKey.slice());
    expect(a).toEqual(b);
    expect(a.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.hash).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const other = await deriveAiToken(crypto.getRandomValues(new Uint8Array(32)));
    expect(other.token).not.toBe(a.token);
    expect(other.hash).not.toBe(a.hash);
    expect(a.token).not.toBe(toBase64Url(roomKey));
  });

  it("hash = base64url(SHA-256(token bytes)), matching HKDF(roomKey, info poof/v1/ai-token)", async () => {
    const roomKey = crypto.getRandomValues(new Uint8Array(32));
    const { token, hash } = await deriveAiToken(roomKey);
    expect(hash).toBe(toBase64Url(await sha256(fromBase64Url(token))));
    const ikm = await crypto.subtle.importKey("raw", roomKey, "HKDF", false, ["deriveBits"]);
    const expected = await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: utf8("poof/v1/ai-token") },
      ikm,
      256,
    );
    expect(token).toBe(toBase64Url(new Uint8Array(expected)));
  });
});
