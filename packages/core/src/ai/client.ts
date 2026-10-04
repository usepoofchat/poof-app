import { aiAttestationSchema, errorBodySchema, AI_MODEL } from "@poof/protocol";
import { PoofError } from "../errors.ts";
import {
  deriveAiToken,
  encryptForModel,
  generateAiSessionKeys,
  newAttestationNonce,
  readAiStream,
  verifyAttestation,
  wipe,
  type AiSessionKeys,
} from "./venice.ts";

export interface AiClientDeps {
  fetch: typeof fetch;
  /** Origin of the API. */
  origin: string;
  roomId: string;
  /** The room key from the link: the AI token is derived from it. */
  roomKey: Uint8Array;
}

/** One request: the system prompt and the conversation, each encrypted on its own. */
export interface AiPrompt {
  system: string;
  user: string;
}

interface Enclave {
  keys: AiSessionKeys;
  modelPubKey: string;
}

/** An API error body → the engine's error. AI codes first: the budget one comes with a 429. */
function aiError(status: number, body: unknown): PoofError {
  const err = errorBodySchema.safeParse(body);
  const message = err.success ? err.data.error.message : `Server error ${status}.`;
  switch (err.success ? err.data.error.code : null) {
    case "ai_not_enabled":
      return new PoofError("ai_not_enabled", message);
    case "ai_not_ready":
      return new PoofError("ai_not_ready", message);
    case "ai_budget_exhausted":
      return new PoofError("ai_budget_exhausted", message);
    case "room_not_found":
      return new PoofError("room_not_found", message);
    case "not_owner":
      return new PoofError("not_owner", message);
    case "rate_limited":
      return new PoofError("rate_limited", message);
    default:
      return status === 429
        ? new PoofError("rate_limited", message)
        : new PoofError("ai_unavailable", message);
  }
}

/**
 * Talks to the AI model through the API, end-to-end encrypted to its enclave:
 * 1. fetch the enclave's attestation (with a fresh nonce) and check it binds the model key;
 * 2. encrypt the prompt to that key and stream the encrypted answer back, decrypting as it comes.
 * The API only ever relays ciphertext. One enclave session (key pair + model key) is reused until
 * an answer fails to decrypt, then it's dropped and the next question attests again.
 */
export class AiClient {
  private token: Promise<{ token: string; hash: string }> | null = null;
  private enclave: Promise<Enclave> | null = null;

  constructor(private readonly deps: AiClientDeps) {}

  /** The room's AI token and its hash (derived from the room key, never sent anywhere but the API). */
  aiToken(): Promise<{ token: string; hash: string }> {
    this.token ??= deriveAiToken(this.deps.roomKey);
    return this.token;
  }

  /** Creator only: register the room's AI token hash, so members can use the AI. */
  async register(ownerSecret: string): Promise<void> {
    const { hash } = await this.aiToken();
    const res = await this.post(`/api/rooms/${this.deps.roomId}/ai`, {
      ownerSecret,
      aiHash: hash,
    });
    if (!res.ok) throw aiError(res.status, await res.json().catch(() => null));
  }

  /**
   * Ask the model. Yields the answer in pieces as it arrives. Rejects with PoofError: `ai_*`,
   * `rate_limited`, `room_not_found`, `connection_failed`.
   */
  async *ask(prompt: AiPrompt, signal?: AbortSignal): AsyncGenerator<string> {
    const { token } = await this.aiToken();
    const enclave = await this.attested();
    const [system, user] = await Promise.all([
      encryptForModel(prompt.system, enclave.modelPubKey),
      encryptForModel(prompt.user, enclave.modelPubKey),
    ]);
    const res = await this.post(
      "/api/ai/chat",
      {
        roomId: this.deps.roomId,
        aiToken: token,
        clientPubKey: enclave.keys.publicKeyHex,
        modelPubKey: enclave.modelPubKey,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      },
      signal,
    );
    if (!res.ok || !res.body) throw aiError(res.status, await res.json().catch(() => null));
    try {
      yield* readAiStream(res.body, enclave.keys);
    } catch (error) {
      // A stale or broken enclave session: start a fresh one next time.
      if (error instanceof PoofError && error.code === "ai_failed") this.forget();
      throw error;
    }
  }

  /** Drop the enclave session and wipe its private key. */
  forget(): void {
    const old = this.enclave;
    this.enclave = null;
    void old?.then((e) => wipe(e.keys.privateKey)).catch(() => undefined);
  }

  private attested(): Promise<Enclave> {
    if (!this.enclave) {
      const attempt = this.attest();
      this.enclave = attempt;
      attempt.catch(() => {
        if (this.enclave === attempt) this.enclave = null;
      });
    }
    return this.enclave;
  }

  private async attest(): Promise<Enclave> {
    const { token } = await this.aiToken();
    const nonce = newAttestationNonce();
    const res = await this.post("/api/ai/attestation", {
      roomId: this.deps.roomId,
      aiToken: token,
      nonce: nonce.hex,
    });
    if (!res.ok) throw aiError(res.status, await res.json().catch(() => null));
    const parsed = aiAttestationSchema.safeParse(await res.json().catch(() => null));
    if (!parsed.success) throw new PoofError("ai_attestation_failed", "Unreadable attestation.");
    const modelPubKey = await verifyAttestation(parsed.data, nonce.bytes, AI_MODEL);
    return { keys: generateAiSessionKeys(), modelPubKey };
  }

  private async post(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
    try {
      return await this.deps.fetch(`${this.deps.origin}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        ...(signal ? { signal } : {}),
      });
    } catch {
      if (signal?.aborted) throw new PoofError("ai_failed", "Stopped.");
      throw new PoofError("connection_failed", "Could not reach the server.");
    }
  }
}
