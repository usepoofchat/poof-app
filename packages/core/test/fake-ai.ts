import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { AI_MODEL } from "@poof/protocol";
import { fromBase64Url, toBase64Url, utf8, type Bytes } from "../src/index.ts";

const INFO = utf8("ecdsa_encryption");
const hex = (data: Uint8Array) => Array.from(data, (b) => b.toString(16).padStart(2, "0")).join("");
const unhex = (text: string) =>
  Uint8Array.from(text.match(/../g) ?? [], (h) => parseInt(h, 16)) as Bytes;

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

/** One AI request as the fake enclave read it. */
export interface FakeAiRequest {
  roomId: string;
  system: string;
  user: string;
}

/**
 * The AI model's side for engine tests: the API's AI endpoints plus an enclave with a real
 * secp256k1 key, a TDX-shaped quote that binds it, and encrypted streamed answers.
 */
export class FakeAi {
  private readonly secret = secp256k1.utils.randomSecretKey();
  private readonly pub = secp256k1.getPublicKey(this.secret, false);
  readonly requests: FakeAiRequest[] = [];
  /** room id → its AI token hash and budget. */
  readonly rooms = new Map<string, { aiHash: string | null; used: number; budget: number }>();
  /** The answer to a request, in the pieces it streams in. */
  answer: (req: FakeAiRequest) => string[] = () => ["Hello", " there", "."];
  /** Make the next chat call fail with this HTTP status and error code. */
  failNext: { status: number; code: string } | null = null;
  /** Attest with the debug bit set (an enclave that can't be trusted). */
  debug = false;
  /** Hold the stream open until `release()` is called. */
  hold = false;
  private releases: Array<() => void> = [];

  release(): void {
    for (const r of this.releases.splice(0)) r();
  }

  enable(roomId: string, budget = 150): void {
    this.rooms.set(roomId, { aiHash: null, used: 0, budget });
  }

  /** Handles the AI routes; returns null for anything else. */
  async handle(path: string, init: RequestInit | undefined): Promise<Response | null> {
    const register = /^\/api\/rooms\/([^/]+)\/ai$/.exec(path);
    const body = () => JSON.parse(init?.body as string) as Record<string, string>;
    if (register) {
      const room = this.rooms.get(register[1] ?? "");
      if (!room) return error(403, "ai_not_enabled");
      const { aiHash } = body();
      if (room.aiHash && room.aiHash !== aiHash) return error(403, "ai_forbidden");
      room.aiHash = aiHash ?? null;
      return Response.json({ ok: true });
    }
    if (path === "/api/ai/attestation") {
      const { roomId, aiToken, nonce } = body();
      const refused = await this.check(roomId ?? "", aiToken ?? "");
      if (refused) return refused;
      return Response.json(this.attestation(unhex(nonce ?? "")));
    }
    if (path === "/api/ai/chat") {
      const req = JSON.parse(init?.body as string) as {
        roomId: string;
        aiToken: string;
        clientPubKey: string;
        messages: { role: string; content: string }[];
      };
      const refused = await this.check(req.roomId, req.aiToken);
      if (refused) return refused;
      const room = this.rooms.get(req.roomId)!;
      if (room.used >= room.budget) return error(429, "ai_budget_exhausted");
      if (this.failNext) {
        const { status, code } = this.failNext;
        this.failNext = null;
        return error(status, code);
      }
      room.used++;
      const hold = this.hold ? new Promise<void>((r) => this.releases.push(r)) : null;
      const [system, user] = await Promise.all(req.messages.map((m) => this.decrypt(m.content)));
      const request = { roomId: req.roomId, system: system ?? "", user: user ?? "" };
      this.requests.push(request);
      const pieces = await Promise.all(
        this.answer(request).map((p) => this.encryptTo(req.clientPubKey, p)),
      );
      const enc = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          for (const p of pieces) {
            controller.enqueue(
              enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`),
            );
          }
          if (hold) await hold;
          controller.enqueue(enc.encode("data: [DONE]\n\n"));
          controller.close();
        },
      });
      return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
    }
    return null;
  }

  private async check(roomId: string, aiToken: string): Promise<Response | null> {
    const room = this.rooms.get(roomId);
    if (!room) return error(403, "ai_not_enabled");
    if (!room.aiHash) return error(409, "ai_not_ready");
    const hash = toBase64Url(
      new Uint8Array(await crypto.subtle.digest("SHA-256", fromBase64Url(aiToken))),
    );
    return hash === room.aiHash ? null : error(403, "ai_forbidden");
  }

  private attestation(nonce: Uint8Array) {
    const quote = crypto.getRandomValues(new Uint8Array(1000));
    new DataView(quote.buffer).setUint32(4, 0x81, true);
    quote[168] = this.debug ? 0x01 : 0x00;
    quote.set(keccak_256(this.pub.subarray(1)).subarray(12), 568);
    quote.set(nonce, 600);
    return {
      verified: true,
      nonce: hex(nonce),
      model: AI_MODEL,
      intel_quote: hex(quote),
      signing_key: hex(this.pub),
    };
  }

  private async decrypt(cipherHex: string): Promise<string> {
    const data = unhex(cipherHex);
    const key = await aesKey(this.secret, data.subarray(0, 65));
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: data.slice(65, 77) },
      key,
      data.slice(77),
    );
    return new TextDecoder().decode(pt);
  }

  private async encryptTo(clientPubHex: string, text: string): Promise<string> {
    const eph = secp256k1.utils.randomSecretKey();
    const key = await aesKey(eph, unhex(clientPubHex));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(
      await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, utf8(text)),
    );
    return hex(secp256k1.getPublicKey(eph, false)) + hex(iv) + hex(ct);
  }
}

function error(status: number, code: string): Response {
  return Response.json({ error: { code, message: code } }, { status });
}
