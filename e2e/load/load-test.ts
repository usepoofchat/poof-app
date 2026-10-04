// Load test for the Durable Object path: many rooms at once, two sockets each, signaling bursts in
// both directions, an optional idle period (hibernation), then destroy.
//
//   pnpm --filter @poof/e2e run load -- --url http://localhost:8787 --rooms 200 --concurrency 25
//
// Against `wrangler dev` each simulated person sends its own CF-Connecting-IP, so the per-IP rate
// limits don't cap the run. Cloudflare overwrites that header in front of a deployed Worker: from
// one machine, staging allows 5 new rooms and 10 joins per minute. See SECURITY.md (load testing).
import { parseArgs } from "node:util";
import {
  PROTOCOL_VERSION,
  serverMessageSchema,
  type ClientMessage,
  type CreateRoomResponse,
  type ServerMessage,
} from "@poof/protocol";

const { values: opts } = parseArgs({
  options: {
    url: { type: "string", default: "http://localhost:8787" },
    rooms: { type: "string", default: "100" },
    concurrency: { type: "string", default: "20" },
    signals: { type: "string", default: "50" },
    "idle-ms": { type: "string", default: "0" },
    "timeout-ms": { type: "string", default: "15000" },
  },
});
const BASE = opts.url.replace(/\/+$/, "");
const WS_BASE = BASE.replace(/^http/, "ws");
const ROOMS = Number(opts.rooms);
const CONCURRENCY = Number(opts.concurrency);
const SIGNALS = Number(opts.signals);
const IDLE_MS = Number(opts["idle-ms"]);
const TIMEOUT_MS = Number(opts["timeout-ms"]);

const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const randomId = () => b64url(crypto.getRandomValues(new Uint8Array(16)));
let ipSeq = 0;
const nextIp = () => {
  const n = ++ipSeq;
  return `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`;
};

// No constructor parameter properties: Node's type stripping doesn't support them.
class Failure extends Error {
  readonly stage: string;
  constructor(stage: string, detail: string) {
    super(`${stage}: ${detail}`);
    this.stage = stage;
  }
}

/** One participant's signaling socket, collecting messages until someone waits for them. */
class Peer {
  readonly inbox: ServerMessage[] = [];
  private wake: (() => void) | null = null;
  closed: number | null = null;
  readonly ws: WebSocket;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener("message", (e) => {
      const data = String(e.data);
      if (!data.startsWith("{")) return;
      const parsed = serverMessageSchema.safeParse(JSON.parse(data));
      if (parsed.success) this.inbox.push(parsed.data);
      this.wake?.();
    });
    ws.addEventListener("close", (e) => {
      this.closed = e.code;
      this.wake?.();
    });
  }

  static open(roomId: string): Promise<Peer> {
    // Node's WebSocket (undici) takes extra headers; browsers don't, which is fine for a CLI.
    const ws = new WebSocket(`${WS_BASE}/ws/rooms/${roomId}?peerId=${randomId()}`, {
      headers: { "CF-Connecting-IP": nextIp() },
    } as unknown as string[]);
    const peer = new Peer(ws);
    return new Promise((resolve, reject) => {
      ws.addEventListener("open", () => resolve(peer), { once: true });
      ws.addEventListener("error", () => reject(new Failure("ws_open", "connection failed")), {
        once: true,
      });
    });
  }

  send(msg: ClientMessage): void {
    this.ws.send(JSON.stringify(msg));
  }

  async next<T extends ServerMessage["t"]>(
    type: T,
    stage: string,
  ): Promise<Extract<ServerMessage, { t: T }>> {
    const deadline = Date.now() + TIMEOUT_MS;
    for (;;) {
      const i = this.inbox.findIndex((m) => m.t === type);
      if (i !== -1) return this.inbox.splice(i, 1)[0] as Extract<ServerMessage, { t: T }>;
      const rejected = this.inbox.find((m) => m.t === "rejected" || m.t === "error");
      if (rejected) throw new Failure(stage, JSON.stringify(rejected));
      if (this.closed !== null) throw new Failure(stage, `closed ${this.closed}`);
      if (Date.now() > deadline) throw new Failure(stage, `timeout waiting for ${type}`);
      await new Promise<void>((r) => {
        this.wake = r;
        setTimeout(r, 50);
      });
    }
  }

  close(): void {
    try {
      this.ws.close(1000);
    } catch {
      /* gone */
    }
  }
}

const samples = {
  create: [] as number[],
  pair: [] as number[],
  relay: [] as number[],
  wake: [] as number[],
};
const failures = new Map<string, number>();
let completed = 0;

async function oneRoom(): Promise<void> {
  const secret = crypto.getRandomValues(new Uint8Array(32));
  const ownerHash = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", secret)));

  let t = performance.now();
  const res = await fetch(`${BASE}/api/rooms`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": nextIp() },
    body: JSON.stringify({ ownerHash }),
  });
  if (res.status !== 200) throw new Failure("create", `HTTP ${res.status}`);
  const room = (await res.json()) as CreateRoomResponse;
  samples.create.push(performance.now() - t);

  const peers: Peer[] = [];
  try {
    const a = await Peer.open(room.roomId);
    peers.push(a);
    await a.next("welcome", "welcome");
    t = performance.now();
    const b = await Peer.open(room.roomId);
    peers.push(b);
    await b.next("welcome", "welcome");
    await Promise.all([a.next("paired", "pair"), b.next("paired", "pair")]);
    samples.pair.push(performance.now() - t);

    // Bursts both ways at once; each signal carries its send time.
    const burst = async (from: Peer, to: Peer) => {
      for (let i = 0; i < SIGNALS; i++) {
        from.send({
          v: PROTOCOL_VERSION,
          t: "signal",
          payload: {
            kind: "candidate",
            candidate: { candidate: `t=${performance.now()}`, sdpMid: "0", sdpMLineIndex: 0 },
          },
        });
      }
      for (let i = 0; i < SIGNALS; i++) {
        const msg = await to.next("signal", "relay");
        if (msg.payload.kind === "candidate") {
          samples.relay.push(performance.now() - Number(msg.payload.candidate.candidate.slice(2)));
        }
      }
    };
    await Promise.all([burst(a, b), burst(b, a)]);

    if (IDLE_MS > 0) {
      // Quiet sockets: the object can hibernate. One signal afterwards measures the wake-up.
      await new Promise((r) => setTimeout(r, IDLE_MS));
      t = performance.now();
      a.send({ v: PROTOCOL_VERSION, t: "signal", payload: { kind: "offer", sdp: "v=0" } });
      await b.next("signal", "wake");
      samples.wake.push(performance.now() - t);
    }

    a.send({ v: PROTOCOL_VERSION, t: "destroy", ownerSecret: b64url(secret) });
    await Promise.all([a.next("room.destroyed", "destroy"), b.next("room.destroyed", "destroy")]);
  } finally {
    for (const p of peers) p.close();
  }
}

function pct(values: number[], p: number): string {
  if (values.length === 0) return "-";
  const sorted = [...values].sort((x, y) => x - y);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!.toFixed(1);
}

const started = performance.now();
let launched = 0;
async function worker(): Promise<void> {
  while (launched < ROOMS) {
    launched++;
    try {
      await oneRoom();
      completed++;
    } catch (e) {
      const stage =
        e instanceof Failure
          ? `${e.stage}: ${e.message.split(": ").slice(1).join(": ")}`
          : String(e);
      failures.set(stage, (failures.get(stage) ?? 0) + 1);
    }
  }
}
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, ROOMS) }, worker));
const seconds = (performance.now() - started) / 1000;

console.log(
  `\n${BASE}: ${ROOMS} rooms, ${CONCURRENCY} at a time, ${SIGNALS} signals each way, idle ${IDLE_MS} ms`,
);
console.log(
  `completed ${completed}/${ROOMS} in ${seconds.toFixed(1)} s (${(completed / seconds).toFixed(1)} rooms/s, ${((completed * SIGNALS * 2) / seconds).toFixed(0)} signals/s)`,
);
console.log("ms            p50     p95     p99     max");
for (const [name, values] of Object.entries(samples)) {
  if (values.length === 0) continue;
  console.log(
    `${name.padEnd(10)} ${[50, 95, 99, 100].map((p) => pct(values, p).padStart(7)).join(" ")}  (n=${values.length})`,
  );
}
if (failures.size > 0) {
  console.log("failures:");
  for (const [stage, n] of failures) console.log(`  ${n} × ${stage}`);
}
process.exit(failures.size > 0 ? 1 : 0);
