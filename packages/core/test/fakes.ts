import {
  CloseCode,
  PROTOCOL_VERSION,
  clientMessageSchema,
  type IceServer,
  type RoomInfo,
  type ServerMessage,
} from "@poof/protocol";
import type {
  RtcDataChannelLike,
  RtcFactory,
  RtcIceCandidateLike,
  RtcPeerConnectionLike,
  RtcStatsLike,
  WebSocketLike,
} from "../src/index.ts";
import { FakeAi } from "./fake-ai.ts";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
export { tick };

/** Wait until `predicate` is true (polling with real timers). */
export async function waitFor(
  predicate: () => boolean,
  what = "condition",
  timeoutMs = 3000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await tick();
  }
}

// ── WebSocket ───────────────────────────────────────────────────────────────

/** Client-side WebSocket double. The "server" drives it through the `server*` methods. */
export class FakeSocket implements WebSocketLike {
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  readonly sent: string[] = [];
  /** When true, the socket silently swallows traffic both ways (a dead mobile connection). */
  zombie = false;
  onClientSend: ((data: string) => void) | null = null;

  constructor(readonly url: string) {}

  send(data: string): void {
    if (this.readyState !== 1) throw new Error("socket not open");
    this.sent.push(data);
    if (!this.zombie) this.onClientSend?.(data);
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onClientSend = null;
    const onclose = this.onclose;
    queueMicrotask(() => onclose?.({ code, reason }));
  }

  // Server-side controls
  serverOpen(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  serverSend(data: string): void {
    if (this.zombie || this.readyState !== 1) return;
    this.onmessage?.({ data });
  }

  serverClose(code: number, reason = ""): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
}

// ── Room server ─────────────────────────────────────────────────────────────

interface RoomState {
  expiresAt: number;
  plan: "free" | "super";
  tier: "free" | "60m" | "24h";
  maxPeers: number;
  /** insertion order = join order */
  peers: Map<string, FakeSocket>;
  joinedAt: Map<string, number>;
  /** The creator's secret. The real server stores its hash; the fake compares it directly. */
  ownerSecret: string;
  /** The room includes the AI model (see FakeAi for its endpoints). */
  ai: boolean;
  /** The member who claimed the room with the creator's secret (RoomDO: the socket's `owner`). */
  owner: string | null;
  /** peerIds the creator removed. */
  banned: Set<string>;
}

/**
 * In-memory implementation of the room protocol (the same behaviour RoomDO has) plus a `fetch` that serves GET /api/rooms/:id. Lets the whole
 * engine run in Node, end to end, without Cloudflare.
 */
export class FakeRoomServer {
  readonly rooms = new Map<string, RoomState>();
  readonly sockets: FakeSocket[] = [];
  iceServers: IceServer[] = [{ urls: "stun:stun.test:3478" }];
  /** Server clock skew relative to the test clock. */
  clockSkewMs = 0;
  fetchCalls: string[] = [];
  /** Override the next GET /api/rooms/:id response. */
  nextRoomResponse: (() => Response | Promise<Response>) | null = null;
  /** A malicious server: return false to never tell these two members about each other. */
  pairFilter: ((a: string, b: string) => boolean) | null = null;
  /** Rejections send `rejected` but the close frame never arrives (as seen in wrangler dev). */
  loseRejectCloseFrames = false;
  /** false = an older server: no `owner` in welcome, and `claim` / `ban` are unknown. */
  ownerTools = true;
  private clock = 0;
  /** The AI model's endpoints. */
  readonly ai = new FakeAi();

  constructor(private readonly now: () => number = Date.now) {}

  /** Turn the AI model on for a room (as a pass with the AI would). */
  enableAi(roomId: string, budget?: number): void {
    const room = this.rooms.get(roomId);
    if (room) room.ai = true;
    this.ai.enable(roomId, budget);
  }

  /** The secret of the creator of every room this fake creates (tests pass it to the creator's session). */
  static readonly OWNER_SECRET = "o".repeat(43);

  createRoom(
    roomId: string,
    ttlMs = 300_000,
    ownerSecret = FakeRoomServer.OWNER_SECRET,
    maxPeers = 2,
  ): RoomState {
    const room: RoomState = {
      expiresAt: this.now() + ttlMs,
      plan: "free",
      tier: "free",
      maxPeers,
      peers: new Map(),
      joinedAt: new Map(),
      ownerSecret,
      ai: false,
      owner: null,
      banned: new Set(),
    };
    this.rooms.set(roomId, room);
    return room;
  }

  get createSocket() {
    return (url: string): FakeSocket => {
      const socket = new FakeSocket(url);
      this.sockets.push(socket);
      const parsed = new URL(url);
      const roomId = parsed.pathname.split("/").pop() ?? "";
      const peerId = parsed.searchParams.get("peerId") ?? "";
      setTimeout(() => this.accept(socket, roomId, peerId), 0);
      return socket;
    };
  }

  /** Phrase mailboxes (MailboxDO): id → blob, one-time read. */
  readonly mailboxes = new Map<string, { blob: string; expiresAt: number }>();

  get fetch(): typeof fetch {
    return (input, init) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      this.fetchCalls.push(url);
      const path = new URL(url).pathname;
      if (path.startsWith("/api/ai/") || /^\/api\/rooms\/[^/]+\/ai$/.test(path)) {
        return this.ai.handle(path, init).then((r) => r ?? new Response(null, { status: 404 }));
      }
      const handshake = /\/api\/handshakes\/([^/]+)(\/take)?$/.exec(new URL(url).pathname);
      if (handshake)
        return Promise.resolve(this.mailbox(handshake[1] ?? "", Boolean(handshake[2]), init));
      const upgrade = /\/api\/rooms\/([^/]+)\/upgrade$/.exec(new URL(url).pathname);
      if (upgrade) return Promise.resolve(this.upgrade(upgrade[1] ?? "", init));
      if (this.nextRoomResponse) {
        const make = this.nextRoomResponse;
        this.nextRoomResponse = null;
        return Promise.resolve(make());
      }
      const roomId = new URL(url).pathname.split("/").pop() ?? "";
      const room = this.rooms.get(roomId);
      if (!room || this.now() >= room.expiresAt) {
        return Promise.resolve(
          Response.json({ error: { code: "room_not_found", message: "x" } }, { status: 404 }),
        );
      }
      const info: RoomInfo = {
        roomId,
        expiresAt: room.expiresAt + this.clockSkewMs,
        serverNow: this.now() + this.clockSkewMs,
        plan: room.plan,
        tier: room.tier,
        maxPeers: room.maxPeers,
        limits: { fileTransfer: room.plan === "super", fileMaxBytes: 2_097_152 },
        ai: room.ai,
        peers: room.peers.size,
      };
      return Promise.resolve(Response.json(info));
    };
  }

  /** Relay credentials the fake hands out on upgrade. */
  upgradeIceServers: IceServer[] = [
    { urls: "turns:turn.test:443?transport=tcp", username: "u2", credential: "c2" },
  ];

  /**
   * POST /api/rooms/:id/upgrade: the fake accepts any pass whose `msg` isn't "spent" (the real
   * server checks the blind signature) and mirrors RoomDO.upgrade.
   */
  readonly spentPasses = new Set<string>();
  private upgrade(roomId: string, init: RequestInit | undefined): Response {
    const room = this.rooms.get(roomId);
    const { ownerSecret, pass, aiHash } = JSON.parse(init?.body as string) as {
      ownerSecret: string;
      pass: { msg: string; variant: { lifetime: number; people: number; ai?: boolean } };
      aiHash?: string;
    };
    if (!room || this.now() >= room.expiresAt) {
      return Response.json(
        { error: { code: "room_not_found", message: "Room not found." } },
        { status: 404 },
      );
    }
    if (this.spentPasses.has(pass.msg)) {
      return Response.json(
        { error: { code: "pass_used", message: "That pass has already been used." } },
        { status: 409 },
      );
    }
    if (ownerSecret !== room.ownerSecret) {
      return Response.json(
        {
          error: {
            code: "not_owner",
            message: "Only the person who created the room can upgrade it.",
          },
        },
        { status: 403 },
      );
    }
    this.spentPasses.add(pass.msg);
    room.plan = "super";
    room.tier = pass.variant.lifetime === 86400 ? "24h" : "60m";
    room.expiresAt = this.now() + pass.variant.lifetime * 1000;
    room.maxPeers = Math.max(room.maxPeers, pass.variant.people);
    room.ai = pass.variant.ai === true;
    if (room.ai) {
      this.ai.enable(roomId);
      this.ai.rooms.get(roomId)!.aiHash = aiHash ?? null;
    }
    const limits = { fileTransfer: true, fileMaxBytes: 2_097_152 };
    for (const socket of room.peers.values()) {
      this.send(socket, {
        v: PROTOCOL_VERSION,
        t: "room.upgraded",
        plan: room.plan,
        tier: room.tier,
        expiresAt: room.expiresAt + this.clockSkewMs,
        serverNow: this.now() + this.clockSkewMs,
        maxPeers: room.maxPeers,
        limits,
        ai: room.ai,
        iceServers: this.upgradeIceServers,
      });
    }
    const info: RoomInfo = {
      roomId,
      expiresAt: room.expiresAt + this.clockSkewMs,
      serverNow: this.now() + this.clockSkewMs,
      plan: room.plan,
      tier: room.tier,
      maxPeers: room.maxPeers,
      limits,
      ai: room.ai,
      peers: room.peers.size,
    };
    return Response.json(info);
  }

  private mailbox(id: string, take: boolean, init: RequestInit | undefined): Response {
    if (take) {
      const box = this.mailboxes.get(id);
      this.mailboxes.delete(id);
      if (!box || this.now() >= box.expiresAt) {
        return Response.json(
          { error: { code: "handshake_not_found", message: "x" } },
          { status: 404 },
        );
      }
      return Response.json({ blob: box.blob });
    }
    const existing = this.mailboxes.get(id);
    if (existing && this.now() < existing.expiresAt) {
      return Response.json({ error: { code: "handshake_exists", message: "x" } }, { status: 409 });
    }
    const { blob } = JSON.parse(init?.body as string) as { blob: string };
    const box = { blob, expiresAt: this.now() + 180_000 };
    this.mailboxes.set(id, box);
    return Response.json({ expiresAt: box.expiresAt + this.clockSkewMs }, { status: 201 });
  }

  private send(socket: FakeSocket, msg: ServerMessage): void {
    socket.serverSend(JSON.stringify(msg));
  }

  /** Mirrors RoomDO.rejectSocket: a `rejected` message, then the close frame with the same code. */
  private reject(socket: FakeSocket, code: number, reason: string): void {
    this.send(socket, { v: PROTOCOL_VERSION, t: "rejected", code, reason });
    if (!this.loseRejectCloseFrames) socket.serverClose(code, reason);
  }

  private accept(socket: FakeSocket, roomId: string, peerId: string): void {
    if (socket.readyState === 3) return;
    socket.serverOpen();
    const room = this.rooms.get(roomId);
    if (!room || this.now() >= room.expiresAt) {
      this.reject(socket, CloseCode.RoomNotFound, "room_not_found");
      return;
    }

    if (room.banned.has(peerId)) {
      this.reject(socket, CloseCode.Banned, "banned");
      return;
    }
    const existing = room.peers.get(peerId);
    const others = [...room.peers.keys()].filter((id) => id !== peerId);
    if (others.length + 1 > room.maxPeers) {
      this.reject(socket, CloseCode.RoomFull, "room_full");
      return;
    }
    let joinedAt = this.clock++;
    if (existing) {
      joinedAt = room.joinedAt.get(peerId) ?? joinedAt;
      room.peers.delete(peerId);
      existing.onClientSend = null;
      if (room.owner === peerId) room.owner = null; // the new socket claims again
      this.send(existing, { v: PROTOCOL_VERSION, t: "replaced" });
      existing.serverClose(CloseCode.Replaced, "replaced");
    }
    room.peers.set(peerId, socket);
    room.joinedAt.set(peerId, joinedAt);

    socket.onClientSend = (data) => this.onClientMessage(roomId, peerId, socket, data);
    this.send(socket, {
      v: PROTOCOL_VERSION,
      t: "welcome",
      roomId,
      peerId,
      plan: room.plan,
      tier: room.tier,
      expiresAt: room.expiresAt + this.clockSkewMs,
      serverNow: this.now() + this.clockSkewMs,
      maxPeers: room.maxPeers,
      peers: others.length + 1,
      ...(this.ownerTools ? { owner: room.owner } : {}),
      members: others,
      limits: { fileTransfer: room.plan === "super", fileMaxBytes: 2_097_152 },
      ai: room.ai,
    });
    if (others.length > 0) this.pair(room, peerId, others);

    // A client that drops its socket leaves the room (unless it was already replaced).
    const prevOnclose = socket.close.bind(socket);
    socket.close = (code, reason) => {
      prevOnclose(code, reason);
      // A zombie socket's close never reaches the server (the network is gone).
      if (!socket.zombie && room.peers.get(peerId) === socket) this.drop(roomId, peerId, "closed");
    };
  }

  /** Mirrors RoomDO.pair: the newcomer with each member already present; earlier joiner initiates. */
  private pair(room: RoomState, peerId: string, present: string[]): void {
    for (const otherId of present) {
      if (this.pairFilter && !this.pairFilter(peerId, otherId)) continue;
      const me = room.peers.get(peerId);
      const other = room.peers.get(otherId);
      if (!me || !other) continue;
      const meFirst = (room.joinedAt.get(peerId) ?? 0) < (room.joinedAt.get(otherId) ?? 0);
      const [first, second] = meFirst
        ? ([
            [peerId, me],
            [otherId, other],
          ] as const)
        : ([
            [otherId, other],
            [peerId, me],
          ] as const);
      this.send(first[1], {
        v: PROTOCOL_VERSION,
        t: "paired",
        role: "initiator",
        peerId: second[0],
        iceServers: this.iceServers,
      });
      this.send(second[1], {
        v: PROTOCOL_VERSION,
        t: "paired",
        role: "responder",
        peerId: first[0],
        iceServers: this.iceServers,
      });
    }
  }

  private onClientMessage(roomId: string, peerId: string, socket: FakeSocket, data: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    if (data === "ping") {
      socket.serverSend("pong");
      return;
    }
    const parsed = clientMessageSchema.safeParse(JSON.parse(data));
    if (!parsed.success) return;
    const msg = parsed.data;
    if (msg.t === "signal") {
      const others = [...room.peers.entries()].filter(([id]) => id !== peerId);
      const target = msg.to
        ? others.find(([id]) => id === msg.to)
        : others.length === 1
          ? others[0]
          : undefined;
      if (target)
        this.send(target[1], {
          v: PROTOCOL_VERSION,
          t: "signal",
          from: peerId,
          payload: msg.payload,
        });
    } else if (msg.t === "leave") {
      this.drop(roomId, peerId, "leave");
    } else if (!this.ownerTools && msg.t !== "destroy") {
      this.send(socket, { v: PROTOCOL_VERSION, t: "error", code: "protocol_error", message: "x" });
    } else if (msg.ownerSecret !== room.ownerSecret) {
      this.send(socket, { v: PROTOCOL_VERSION, t: "error", code: "not_owner", message: "x" });
    } else if (msg.t === "claim") {
      room.owner = peerId;
      for (const other of room.peers.values())
        this.send(other, { v: PROTOCOL_VERSION, t: "owner", peerId });
    } else if (msg.t === "ban") {
      this.ban(roomId, peerId, msg.peerId);
    } else {
      this.destroy(roomId, peerId);
    }
  }

  /** Mirrors RoomDO's `ban`: out, refused from now on, everyone else told. */
  private ban(roomId: string, by: string, target: string): void {
    const room = this.rooms.get(roomId);
    if (!room || target === by) return;
    room.banned.add(target);
    const socket = room.peers.get(target);
    if (!socket) return;
    room.peers.delete(target);
    socket.onClientSend = null;
    this.send(socket, { v: PROTOCOL_VERSION, t: "banned" });
    socket.serverClose(CloseCode.Banned, "banned");
    for (const other of room.peers.values()) {
      this.send(other, { v: PROTOCOL_VERSION, t: "peer.left", peerId: target, reason: "banned" });
    }
  }

  /** The socket is gone: tell the other peer (RoomDO.onSocketGone). */
  drop(roomId: string, peerId: string, reason: "closed" | "leave"): void {
    const room = this.rooms.get(roomId);
    if (!room?.peers.has(peerId)) return;
    room.peers.delete(peerId);
    if (room.owner === peerId) room.owner = null;
    for (const other of room.peers.values()) {
      this.send(other, { v: PROTOCOL_VERSION, t: "peer.left", peerId, reason });
    }
  }

  destroy(roomId: string, by: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    // Like RoomDO.terminate: the room is gone before anyone is told, so closing sockets can't
    // produce a spurious peer.left.
    this.rooms.delete(roomId);
    for (const socket of [...room.peers.values()]) {
      this.send(socket, { v: PROTOCOL_VERSION, t: "room.destroyed", by });
      socket.serverClose(CloseCode.RoomDestroyed, "room_destroyed");
    }
  }

  /** The room's alarm fires: everyone is told and the room disappears. */
  expire(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    this.rooms.delete(roomId);
    for (const socket of [...room.peers.values()]) {
      this.send(socket, { v: PROTOCOL_VERSION, t: "room.expired" });
      socket.serverClose(CloseCode.RoomExpired, "room_expired");
    }
  }

  socketsFor(peerId: string): FakeSocket[] {
    return this.sockets.filter((s) => new URL(s.url).searchParams.get("peerId") === peerId);
  }
}

// ── WebRTC ──────────────────────────────────────────────────────────────────

export class FakeDataChannel implements RtcDataChannelLike {
  binaryType = "blob";
  readyState = "connecting";
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onbufferedamountlow: (() => void) | null = null;
  other: FakeDataChannel | null = null;
  /** Everything this end sent, in order (what an eavesdropper on the wire would see). */
  readonly wire: Array<string | Uint8Array> = [];
  /** Rewrite or drop what this end sends (attacker in the middle). Return null to drop. */
  tamper: ((data: string | Uint8Array) => string | Uint8Array | null) | null = null;

  constructor(readonly label: string) {}

  send(data: string | Uint8Array): void {
    if (this.readyState !== "open") throw new Error("InvalidStateError");
    this.wire.push(data);
    const out = this.tamper ? this.tamper(data) : data;
    if (out === null) return;
    const payload = typeof out === "string" ? out : out.slice().buffer;
    const target = this.other;
    queueMicrotask(() => target?.onmessage?.({ data: payload }));
  }

  close(): void {
    if (this.readyState === "closed") return;
    this.readyState = "closed";
    const other = this.other;
    queueMicrotask(() => {
      this.onclose?.();
      if (other && other.readyState !== "closed") {
        other.readyState = "closed";
        other.onclose?.();
      }
    });
  }
}

export interface FakeStats {
  localType: string;
  remoteType: string;
  /** Use the nominated-candidate-pair fallback instead of transport.selectedCandidatePairId. */
  nominatedFallback?: boolean;
  /** Report no usable pair. */
  noPair?: boolean;
  throws?: boolean;
}

/** Shared by all fake peer connections created by one factory, so offers find their answerers. */
export class FakeRtcNetwork {
  readonly connections: FakePeerConnection[] = [];
  private nextId = 1;
  private readonly offers = new Map<string, FakePeerConnection>();
  stats: FakeStats = { localType: "host", remoteType: "host" };
  /** When set, connections created afterwards go to "failed" instead of connecting. */
  failConnections = false;
  /** When true, negotiation completes but the channels never appear (stuck in "negotiating"). */
  holdNegotiation = false;
  /** Called for every data channel created on either end (attach tamper hooks here). */
  channelHook: ((channel: FakeDataChannel, pc: FakePeerConnection) => void) | null = null;
  /** Per-connection stats override. */
  statsResolver: ((pc: FakePeerConnection) => FakeStats) | null = null;
  readonly iceServersSeen: IceServer[][] = [];

  readonly factory: RtcFactory = (config) => {
    this.iceServersSeen.push(config.iceServers);
    const pc = new FakePeerConnection(this, `pc${this.nextId++}`);
    this.connections.push(pc);
    return pc;
  };

  registerOffer(id: string, pc: FakePeerConnection): void {
    this.offers.set(id, pc);
  }

  offerer(id: string): FakePeerConnection | undefined {
    return this.offers.get(id);
  }
}

export class FakePeerConnection implements RtcPeerConnectionLike {
  connectionState = "new";
  remoteDescription: { type: string; sdp: string } | null = null;
  localDescription: { type: string; sdp: string } | null = null;
  onicecandidate: ((event: { candidate: RtcIceCandidateLike | null }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  ondatachannel: ((event: { channel: RtcDataChannelLike }) => void) | null = null;
  readonly channels: FakeDataChannel[] = [];
  readonly addedCandidates: string[] = [];
  /** ICE servers passed to setConfiguration, in order. */
  readonly configurations: IceServer[][] = [];
  /** Offers made with iceRestart. */
  restarts = 0;
  closed = false;
  private peer: FakePeerConnection | null = null;

  constructor(
    private readonly net: FakeRtcNetwork,
    readonly id: string,
  ) {}

  createDataChannel(label: string): RtcDataChannelLike {
    const channel = new FakeDataChannel(label);
    this.channels.push(channel);
    this.net.channelHook?.(channel, this);
    return channel;
  }

  setConfiguration(config: { iceServers: IceServer[] }): void {
    this.configurations.push(config.iceServers);
  }

  createOffer(options?: { iceRestart?: boolean }): Promise<{ type: string; sdp?: string }> {
    if (options?.iceRestart) this.restarts += 1;
    return Promise.resolve({
      type: "offer",
      sdp: `fake-offer:${this.id}${options?.iceRestart ? ":restart" : ""}`,
    });
  }

  createAnswer(): Promise<{ type: string; sdp?: string }> {
    return Promise.resolve({ type: "answer", sdp: `fake-answer:${this.id}` });
  }

  async setLocalDescription(description: { type: string; sdp?: string }): Promise<void> {
    this.localDescription = { type: description.type, sdp: description.sdp ?? "" };
    if (description.type === "offer") {
      this.net.registerOffer(this.id, this);
    } else if (description.type === "answer") {
      // Answering completes the negotiation: connect the two ends.
      const offerId = this.remoteDescription?.sdp.split(":")[1];
      const offerer = offerId ? this.net.offerer(offerId) : undefined;
      if (offerer) this.connect(offerer);
    }
    queueMicrotask(() => {
      this.onicecandidate?.({
        candidate: {
          candidate: `candidate:1 1 udp 2122260223 10.0.0.${this.id.length} 5000 typ host`,
          sdpMid: "0",
          sdpMLineIndex: 0,
          usernameFragment: null,
        },
      });
      this.onicecandidate?.({ candidate: null });
    });
  }

  setRemoteDescription(description: { type: "offer" | "answer"; sdp: string }): Promise<void> {
    this.remoteDescription = { type: description.type, sdp: description.sdp };
    return Promise.resolve();
  }

  addIceCandidate(candidate: { candidate: string }): Promise<void> {
    if (!this.remoteDescription)
      return Promise.reject(new Error("InvalidStateError: no remote description"));
    this.addedCandidates.push(candidate.candidate);
    return Promise.resolve();
  }

  getStats(): Promise<RtcStatsLike> {
    const s = this.net.statsResolver?.(this) ?? this.net.stats;
    if (s.throws) return Promise.reject(new Error("stats unavailable"));
    const reports = new Map<string, Record<string, unknown>>();
    if (!s.noPair) {
      reports.set("pair", {
        id: "pair",
        type: "candidate-pair",
        state: "succeeded",
        nominated: true,
        localCandidateId: "L",
        remoteCandidateId: "R",
      });
      reports.set("L", { id: "L", type: "local-candidate", candidateType: s.localType });
      reports.set("R", { id: "R", type: "remote-candidate", candidateType: s.remoteType });
      if (!s.nominatedFallback)
        reports.set("T", { id: "T", type: "transport", selectedCandidatePairId: "pair" });
    }
    return Promise.resolve({
      forEach: (cb) => reports.forEach((value) => cb(value)),
      get: (id) => reports.get(id),
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.connectionState = "closed";
    for (const channel of this.channels) channel.close();
    this.peer?.peerClosed();
  }

  /** The other side closed its connection. */
  peerClosed(): void {
    if (this.closed) return;
    this.connectionState = "failed";
    queueMicrotask(() => this.onconnectionstatechange?.());
  }

  /** Make this connection (the answerer) and `offerer` talk to each other. */
  private connect(offerer: FakePeerConnection): void {
    // An ICE restart renegotiates an existing connection: the channels stay as they are.
    if (this.peer === offerer && this.connectionState === "connected") return;
    this.peer = offerer;
    offerer.peer = this;
    if (this.net.holdNegotiation) return;
    if (this.net.failConnections) {
      queueMicrotask(() => {
        for (const pc of [this, offerer]) {
          pc.connectionState = "failed";
          pc.onconnectionstatechange?.();
        }
      });
      return;
    }
    for (const local of offerer.channels) {
      const remote = new FakeDataChannel(local.label);
      this.channels.push(remote);
      this.net.channelHook?.(remote, this);
      local.other = remote;
      remote.other = local;
      this.ondatachannel?.({ channel: remote });
    }
    setTimeout(() => {
      for (const pc of [offerer, this]) {
        pc.connectionState = "connected";
        pc.onconnectionstatechange?.();
        for (const channel of pc.channels) {
          channel.readyState = "open";
          channel.onopen?.();
        }
      }
    }, 0);
  }
}
