import { exports } from "cloudflare:workers";
import {
  serverMessageSchema,
  type CreateRoomResponse,
  type ServerMessage,
  type ServerMessageType,
} from "@poof/protocol";

import { toBase64Url } from "../src/util.ts";

const ORIGIN = "http://poof.test";

export async function api(path: string, init: RequestInit = {}): Promise<Response> {
  return exports.default.fetch(new Request(`${ORIGIN}${path}`, init));
}

export function postJson(
  path: string,
  body: unknown = {},
  headers: HeadersInit = {},
): Promise<Response> {
  return api(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

/** Any well-formed owner hash, for tests that never destroy. */
export const ANY_OWNER = { ownerHash: "h".repeat(43) };

/** A creator secret and its hash, exactly as the browser makes them. */
export async function newOwner(): Promise<{ ownerSecret: string; ownerHash: string }> {
  const secret = crypto.getRandomValues(new Uint8Array(32));
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", secret));
  return { ownerSecret: toBase64Url(secret), ownerHash: toBase64Url(hash) };
}

export async function createRoom(): Promise<CreateRoomResponse & { ownerSecret: string }> {
  const owner = await newOwner();
  const res = await postJson("/api/rooms", { ownerHash: owner.ownerHash });
  if (res.status !== 200) throw new Error(`createRoom failed: ${res.status}`);
  return { ...((await res.json()) as CreateRoomResponse), ownerSecret: owner.ownerSecret };
}

/** 22-char base64url peer id, deterministic from a label so tests are readable. */
export function peer(label: string): string {
  return label.padEnd(22, "_").slice(0, 22);
}

export interface Closed {
  code: number;
  reason: string;
}

/** A client WebSocket that records every message and waits for specific ones. */
export class TestSocket {
  readonly messages: ServerMessage[] = [];
  readonly raw: string[] = [];
  closed: Closed | null = null;
  private readonly waiters: Array<() => void> = [];

  private constructor(readonly ws: WebSocket) {
    ws.addEventListener("message", (event) => {
      const data = String(event.data);
      this.raw.push(data);
      // "pong" is a bare string (heartbeat auto-response), not JSON.
      if (data.startsWith("{")) {
        const parsed = serverMessageSchema.safeParse(JSON.parse(data));
        if (parsed.success) this.messages.push(parsed.data);
      }
      this.wake();
    });
    ws.addEventListener("close", (event) => {
      this.closed = { code: event.code, reason: event.reason };
      this.wake();
    });
  }

  /** Open a socket to a room. Resolves once the upgrade has completed (even if the DO then closes it). */
  static async connect(
    roomId: string,
    peerId: string,
    headers: Record<string, string> = {},
  ): Promise<TestSocket> {
    const res = await api(`/ws/rooms/${roomId}?peerId=${peerId}`, {
      headers: { Upgrade: "websocket", ...headers },
    });
    const ws = res.webSocket;
    if (!ws) throw new Error(`no websocket (status ${res.status})`);
    ws.accept();
    return new TestSocket(ws);
  }

  send(data: unknown): void {
    this.ws.send(typeof data === "string" ? data : JSON.stringify(data));
  }

  private wake(): void {
    for (const w of this.waiters.splice(0)) w();
  }

  /** Waits on real time: generous, because a busy CI machine can be several times slower. */
  private async until(predicate: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() > deadline) {
        throw new Error(
          `timed out waiting for ${what}; got ${JSON.stringify(this.messages.map((m) => m.t))} closed=${JSON.stringify(this.closed)}`,
        );
      }
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        setTimeout(resolve, 25);
      });
    }
  }

  /** Wait for the next not-yet-consumed message of a type. */
  async next<T extends ServerMessageType>(type: T): Promise<Extract<ServerMessage, { t: T }>> {
    const find = () => this.messages.findIndex((m) => m.t === type);
    await this.until(() => find() !== -1, `message ${type}`);
    const [msg] = this.messages.splice(find(), 1);
    return msg as Extract<ServerMessage, { t: T }>;
  }

  async waitClosed(): Promise<Closed> {
    await this.until(() => this.closed !== null, "close");
    return this.closed as Closed;
  }

  /** Give the event loop a moment, then assert no message of `type` arrived. */
  async expectNone(type: ServerMessageType, ms = 150): Promise<void> {
    await new Promise((r) => setTimeout(r, ms));
    if (this.messages.some((m) => m.t === type)) {
      throw new Error(`unexpected ${type} message`);
    }
  }

  close(): void {
    this.ws.close(1000, "test");
  }
}
