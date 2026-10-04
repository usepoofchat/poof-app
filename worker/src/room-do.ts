import { DurableObject } from "cloudflare:workers";
import {
  AI_BUDGET,
  AI_PER_MINUTE,
  CloseCode,
  DEFAULT_FILE_MAX_BYTES,
  FILE_MAX_BYTES_CEILING,
  MAX_SIGNALS_PER_PAIRING,
  MAX_SIGNAL_BYTES,
  MAX_WS_MESSAGE_BYTES,
  PROTOCOL_VERSION,
  WS_PING,
  WS_PONG,
  clientMessageSchema,
  isPeerId,
  type Limits,
  type Plan,
  type RoomInfo,
  type ServerMessage,
  type Tier,
} from "@poof/protocol";
import { mintIceServers, turnCredentialTtl } from "./turn.ts";
import { ownerSecretMatches, positiveInt } from "./util.ts";

export interface RoomMeta {
  roomId: string;
  createdAt: number;
  expiresAt: number;
  plan: Plan;
  tier: Tier;
  maxPeers: number;
  /** Set by the super-room upgrade. */
  upgradedAt: number | null;
  /** base64url(SHA-256(creator's secret)). Only the creator can destroy the room. */
  ownerHash: string;
  /** File transfer in a free room (ROOM_FILES_FREE, local/e2e testing only). */
  freeFiles?: boolean;
  /** The AI model is part of this room (paid with the pass). */
  ai?: boolean;
  /**
   * base64url(SHA-256(aiToken)), registered by the creator once the room key exists. Members derive
   * the same token from the link, so the server can check AI calls without ever seeing the key.
   */
  aiHash?: string | null;
  /** AI requests used and allowed (reset by an upgrade that includes the AI). */
  aiUsed?: number;
  aiBudget?: number;
  /** Start (ms) and count of the current one-minute AI window. */
  aiWindow?: { start: number; count: number };
}

/** Why an AI call is refused. */
export type AiRefusal =
  | "room_not_found"
  | "ai_not_enabled"
  | "ai_not_ready"
  | "ai_forbidden"
  | "ai_budget_exhausted"
  | "rate_limited";

export interface CreateRoomOptions {
  roomId: string;
  ttlSeconds: number;
  plan: Plan;
  tier: Tier;
  maxPeers: number;
  ownerHash: string;
  freeFiles?: boolean;
  ai?: boolean;
}

/** The AI fields of a room that includes (or now includes) the AI model, with a fresh budget. */
function aiFields(lifetimeSeconds: number, aiHash: string | null): Partial<RoomMeta> {
  return {
    ai: true,
    aiHash,
    aiUsed: 0,
    aiBudget: AI_BUDGET[lifetimeSeconds] ?? AI_BUDGET[3600],
    aiWindow: { start: 0, count: 0 },
  };
}

/** Per-socket state, persisted across hibernation with serializeAttachment (max 2 KiB). */
interface PeerAttachment {
  peerId: string;
  joinedAt: number;
  /** signal messages relayed in the current pairing */
  signals: number;
  /** protocol errors so far; the second one closes the socket */
  errors: number;
  /** `active` sockets count toward capacity. `replaced`/`left` are closing and must be ignored. */
  state: "active" | "replaced" | "left";
  /** This socket proved it belongs to the room's creator (`claim`). */
  owner?: boolean;
}

/** Close codes that must not be sent on the wire (reserved by RFC 6455). */
const RESERVED_CLOSE_CODES = new Set([1005, 1006, 1015]);

const META_KEY = "meta";
/** peerIds the creator removed. Wiped with the room. */
const BANNED_KEY = "banned";
/** Plenty for a room of at most ten; the oldest entries make room for new ones. */
const MAX_BANNED = 64;

const encoder = new TextEncoder();

/**
 * True if `text` is over `maxBytes` in UTF-8. A UTF-16 unit takes 1 to 3 UTF-8 bytes, so only
 * strings in between the two bounds need encoding.
 */
function exceedsUtf8(text: string, maxBytes: number): boolean {
  if (text.length > maxBytes) return true;
  if (text.length * 3 <= maxBytes) return false;
  return encoder.encode(text).byteLength > maxBytes;
}

/**
 * One Durable Object per room. Owns: the room registry entry (meta + TTL alarm), the capacity lock,
 * pairing, signaling relay and presence. It never sees keys or message content: chat and files
 * travel over the WebRTC DataChannel between the two browsers.
 *
 * WebSockets use the Hibernation API, so an idle room costs nothing.
 */
export class RoomDO extends DurableObject<Env> {
  /** In-memory cache of storage (persist first, cache second). */
  private meta: RoomMeta | null = null;
  private banned: string[] = [];

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Heartbeat answered by the runtime without waking the object. Must be the exact literal string.
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(WS_PING, WS_PONG));
    void this.ctx.blockConcurrencyWhile(async () => {
      this.meta = (await this.ctx.storage.get<RoomMeta>(META_KEY)) ?? null;
      this.banned = (await this.ctx.storage.get<string[]>(BANNED_KEY)) ?? [];
    });
  }

  // ── RPC (called by the Worker) ────────────────────────────────────────────

  /** Create the room. Returns null if it already exists (id collision, practically impossible). */
  async create(opts: CreateRoomOptions): Promise<RoomInfo | null> {
    if (this.meta) return null;
    const now = Date.now();
    const meta: RoomMeta = {
      roomId: opts.roomId,
      createdAt: now,
      expiresAt: now + opts.ttlSeconds * 1000,
      plan: opts.plan,
      tier: opts.tier,
      maxPeers: opts.maxPeers,
      upgradedAt: null,
      ownerHash: opts.ownerHash,
      ...(opts.freeFiles ? { freeFiles: true } : {}),
      ...(opts.ai ? aiFields(opts.ttlSeconds, null) : {}),
    };
    await this.ctx.storage.put(META_KEY, meta);
    this.meta = meta;
    await this.ctx.storage.setAlarm(meta.expiresAt);
    return this.toInfo(meta, now);
  }

  /**
   * Super Quant-Room upgrade, paid with a pass (checked by the Worker). Only the creator can do it.
   * The room gets the pass's lifetime from now, its number of people (never fewer than it has) and
   * file sharing. Everyone in it hears about it right away, with relay credentials for the new end.
   */
  async upgrade(opts: {
    ownerSecret: string;
    tier: Tier;
    lifetimeSeconds: number;
    maxPeers: number;
    /** The pass includes the AI model. The new pass decides: without it, the AI is off from now. */
    ai: boolean;
    aiHash?: string;
  }): Promise<
    { ok: true; info: RoomInfo } | { ok: false; reason: "room_not_found" | "not_owner" }
  > {
    const meta = this.live();
    if (!meta) return { ok: false, reason: "room_not_found" };
    if (!(await ownerSecretMatches(opts.ownerSecret, meta.ownerHash)))
      return { ok: false, reason: "not_owner" };
    const now = Date.now();
    const next: RoomMeta = {
      ...meta,
      plan: "super",
      tier: opts.tier,
      expiresAt: now + opts.lifetimeSeconds * 1000,
      maxPeers: Math.max(meta.maxPeers, opts.maxPeers),
      upgradedAt: now,
      ...(opts.ai
        ? aiFields(opts.lifetimeSeconds, opts.aiHash ?? meta.aiHash ?? null)
        : { ai: false }),
    };
    await this.ctx.storage.put(META_KEY, next);
    this.meta = next;
    await this.ctx.storage.setAlarm(next.expiresAt);
    const iceServers = await mintIceServers(this.env, turnCredentialTtl(next.expiresAt));
    const info = this.toInfo(next, Date.now());
    for (const ws of this.activeSockets()) {
      this.send(ws, {
        v: PROTOCOL_VERSION,
        t: "room.upgraded",
        plan: next.plan,
        tier: next.tier,
        expiresAt: next.expiresAt,
        serverNow: info.serverNow,
        maxPeers: next.maxPeers,
        limits: info.limits,
        ai: info.ai,
        iceServers,
      });
    }
    return { ok: true, info };
  }

  /**
   * The creator registers the room's AI token hash (see RoomMeta.aiHash). Registering the same hash
   * again is fine (a reload of the creator's tab); a different one is refused.
   */
  async registerAi(opts: {
    ownerSecret: string;
    aiHash: string;
  }): Promise<
    | { ok: true }
    | { ok: false; reason: "room_not_found" | "not_owner" | "ai_not_enabled" | "ai_forbidden" }
  > {
    const meta = this.live();
    if (!meta) return { ok: false, reason: "room_not_found" };
    if (!(await ownerSecretMatches(opts.ownerSecret, meta.ownerHash)))
      return { ok: false, reason: "not_owner" };
    if (!meta.ai) return { ok: false, reason: "ai_not_enabled" };
    if (meta.aiHash) {
      return meta.aiHash === opts.aiHash ? { ok: true } : { ok: false, reason: "ai_forbidden" };
    }
    await this.save({ ...meta, aiHash: opts.aiHash });
    return { ok: true };
  }

  /**
   * Check an AI call: the room includes the AI, the token is the room's, and (when `spend`) there is
   * budget left this minute and overall. A spent request is counted before the call goes out.
   */
  async authorizeAi(opts: {
    aiToken: string;
    spend: boolean;
  }): Promise<{ ok: true } | { ok: false; reason: AiRefusal }> {
    const meta = this.live();
    if (!meta) return { ok: false, reason: "room_not_found" };
    if (!meta.ai) return { ok: false, reason: "ai_not_enabled" };
    if (!meta.aiHash) return { ok: false, reason: "ai_not_ready" };
    if (!(await ownerSecretMatches(opts.aiToken, meta.aiHash)))
      return { ok: false, reason: "ai_forbidden" };
    if (!opts.spend) return { ok: true };
    if ((meta.aiUsed ?? 0) >= (meta.aiBudget ?? 0))
      return { ok: false, reason: "ai_budget_exhausted" };
    const now = Date.now();
    const window =
      meta.aiWindow && now - meta.aiWindow.start < 60_000
        ? meta.aiWindow
        : { start: now, count: 0 };
    if (window.count >= AI_PER_MINUTE) return { ok: false, reason: "rate_limited" };
    await this.save({
      ...meta,
      aiUsed: (meta.aiUsed ?? 0) + 1,
      aiWindow: { start: window.start, count: window.count + 1 },
    });
    return { ok: true };
  }

  /** Give back a request the AI provider never answered. */
  async refundAi(): Promise<void> {
    const meta = this.live();
    if (!meta?.ai || !meta.aiUsed) return;
    await this.save({ ...meta, aiUsed: meta.aiUsed - 1 });
  }

  /** Public room info, or null if the room doesn't exist or has expired. */
  getInfo(): RoomInfo | null {
    const meta = this.live();
    return meta ? this.toInfo(meta, Date.now()) : null;
  }

  // ── WebSocket upgrade ─────────────────────────────────────────────────────

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected a WebSocket upgrade", { status: 426 });
    }
    const peerId = new URL(request.url).searchParams.get("peerId");
    if (!isPeerId(peerId)) {
      return new Response("Invalid peerId", { status: 400 });
    }

    const meta = this.live();
    if (!meta) {
      return this.rejectSocket(
        this.meta ? CloseCode.RoomExpired : CloseCode.RoomNotFound,
        this.meta ? "room_expired" : "room_not_found",
      );
    }

    if (this.banned.includes(peerId)) return this.rejectSocket(CloseCode.Banned, "banned");

    const active = this.activeSockets();
    const mine = active.filter((ws) => this.read(ws).peerId === peerId);
    const others = active.filter((ws) => this.read(ws).peerId !== peerId);

    if (others.length + 1 > meta.maxPeers) {
      return this.rejectSocket(CloseCode.RoomFull, "room_full");
    }

    // Same peerId again = the client reconnecting over a dead ("zombie") socket. Replace the old
    // socket instead of rejecting, and keep the original joinedAt so roles stay stable.
    let joinedAt = Date.now();
    for (const old of mine) {
      joinedAt = Math.min(joinedAt, this.read(old).joinedAt);
      this.write(old, { state: "replaced" });
      this.send(old, { v: PROTOCOL_VERSION, t: "replaced" });
      try {
        old.close(CloseCode.Replaced, "replaced");
      } catch {
        /* already closed */
      }
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server, [peerId]);
    const attachment: PeerAttachment = { peerId, joinedAt, signals: 0, errors: 0, state: "active" };
    server.serializeAttachment(attachment);

    this.send(server, {
      v: PROTOCOL_VERSION,
      t: "welcome",
      roomId: meta.roomId,
      peerId,
      plan: meta.plan,
      tier: meta.tier,
      expiresAt: meta.expiresAt,
      serverNow: Date.now(),
      maxPeers: meta.maxPeers,
      peers: others.length + 1,
      owner: this.ownerPeerId(),
      members: others.map((ws) => this.read(ws).peerId),
      limits: this.limits(meta),
      ai: meta.ai === true,
    });

    // Pair the newcomer with everyone already here (a reconnecting peer re-pairs with everyone).
    // Awaited (ctx.waitUntil is a no-op in Durable Objects); the socket's queued messages are
    // delivered as soon as the upgrade response goes out.
    if (others.length > 0) await this.pair(peerId, others);

    return new Response(null, { status: 101, webSocket: client });
  }

  // ── Hibernation handlers ──────────────────────────────────────────────────

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (this.read(ws).state !== "active") return;

    if (typeof message !== "string" || exceedsUtf8(message, MAX_WS_MESSAGE_BYTES)) {
      this.protocolError(
        ws,
        "protocol_error",
        "Expected a JSON text message within the size limit.",
      );
      return;
    }

    let json: unknown;
    try {
      json = JSON.parse(message);
    } catch {
      this.protocolError(ws, "protocol_error", "Invalid JSON.");
      return;
    }
    const parsed = clientMessageSchema.safeParse(json);
    if (!parsed.success) {
      this.protocolError(ws, "protocol_error", "Unknown or malformed message.");
      return;
    }
    const msg = parsed.data;

    switch (msg.t) {
      case "signal": {
        const att = this.read(ws);
        const others = this.activeSockets().filter((s) => s !== ws);
        // Every signal attempt spends the budget, refused ones too, so a socket can't keep the
        // object busy with signals that go nowhere. It grows with the links this socket negotiates.
        if (att.signals >= MAX_SIGNALS_PER_PAIRING * Math.max(1, others.length)) {
          this.send(ws, {
            v: PROTOCOL_VERSION,
            t: "error",
            code: "signal_rate_exceeded",
            message: "Too many signals.",
          });
          this.closeQuietly(ws, CloseCode.ProtocolError, "signal_rate_exceeded");
          return;
        }
        this.write(ws, { signals: att.signals + 1 });

        // Addressed (`to`) in group rooms; without it, the only other member (2-person rooms).
        const target = msg.to
          ? others.find((s) => this.read(s).peerId === msg.to)
          : others.length === 1
            ? others[0]
            : undefined;
        if (!target) {
          this.send(ws, {
            v: PROTOCOL_VERSION,
            t: "error",
            code: "not_paired",
            message: "No peer to signal.",
          });
          return;
        }
        if (exceedsUtf8(JSON.stringify(msg.payload), MAX_SIGNAL_BYTES)) {
          this.send(ws, {
            v: PROTOCOL_VERSION,
            t: "error",
            code: "signal_too_large",
            message: "Signal payload too large.",
          });
          return;
        }
        this.send(target, {
          v: PROTOCOL_VERSION,
          t: "signal",
          from: att.peerId,
          payload: msg.payload,
        });
        return;
      }
      case "leave": {
        const att = this.read(ws);
        this.write(ws, { state: "left" });
        for (const other of this.activeSockets()) {
          this.send(other, {
            v: PROTOCOL_VERSION,
            t: "peer.left",
            peerId: att.peerId,
            reason: "leave",
          });
        }
        this.closeQuietly(ws, 1000, "leave");
        return;
      }
      case "destroy": {
        const meta = this.live();
        if (!meta?.ownerHash || !(await ownerSecretMatches(msg.ownerSecret, meta.ownerHash))) {
          // The app only sends `destroy` with the creator's secret, so a wrong one is a modified
          // client guessing: it counts as a protocol error (the second one closes the socket).
          this.protocolError(
            ws,
            "not_owner",
            "Only the person who created the room can destroy it.",
          );
          return;
        }
        await this.terminate("destroyed", this.read(ws).peerId);
        return;
      }
      case "claim": {
        const meta = this.live();
        if (!meta || !(await ownerSecretMatches(msg.ownerSecret, meta.ownerHash))) {
          this.protocolError(ws, "not_owner", "Only the person who created the room can claim it.");
          return;
        }
        if (this.read(ws).state !== "active") return;
        // One creator: a claim from another tab of theirs moves the badge there.
        for (const other of this.activeSockets())
          if (other !== ws) this.write(other, { owner: false });
        this.write(ws, { owner: true });
        const peerId = this.read(ws).peerId;
        for (const other of this.activeSockets())
          this.send(other, { v: PROTOCOL_VERSION, t: "owner", peerId });
        return;
      }
      case "ban": {
        const meta = this.live();
        if (!meta || !(await ownerSecretMatches(msg.ownerSecret, meta.ownerHash))) {
          this.protocolError(
            ws,
            "not_owner",
            "Only the person who created the room can remove people.",
          );
          return;
        }
        if (msg.peerId === this.read(ws).peerId) return; // the creator can't remove themselves
        if (!this.banned.includes(msg.peerId)) {
          this.banned = [...this.banned, msg.peerId].slice(-MAX_BANNED);
          await this.ctx.storage.put(BANNED_KEY, this.banned);
        }
        const targets = this.activeSockets().filter((s) => this.read(s).peerId === msg.peerId);
        if (targets.length === 0) return;
        for (const target of targets) {
          this.write(target, { state: "left" });
          this.send(target, { v: PROTOCOL_VERSION, t: "banned" });
          this.closeQuietly(target, CloseCode.Banned, "banned");
        }
        for (const other of this.activeSockets()) {
          this.send(other, {
            v: PROTOCOL_VERSION,
            t: "peer.left",
            peerId: msg.peerId,
            reason: "banned",
          });
        }
        return;
      }
    }
  }

  override webSocketClose(ws: WebSocket, code: number): void {
    this.onSocketGone(ws);
    this.closeQuietly(ws, RESERVED_CLOSE_CODES.has(code) ? 1000 : code, "closing");
  }

  override webSocketError(ws: WebSocket): void {
    this.onSocketGone(ws);
  }

  // ── Expiry ────────────────────────────────────────────────────────────────

  override async alarm(): Promise<void> {
    const meta = this.meta;
    if (!meta) return;
    if (Date.now() < meta.expiresAt) {
      // Alarm fired for an older deadline (e.g. after an upgrade extended the room): re-arm.
      await this.ctx.storage.setAlarm(meta.expiresAt);
      return;
    }
    await this.terminate("expired");
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  /** Meta if the room exists and hasn't passed its deadline (the alarm may not have run yet). */
  private live(): RoomMeta | null {
    return this.meta && Date.now() < this.meta.expiresAt ? this.meta : null;
  }

  private limits(meta: RoomMeta): Limits {
    return {
      fileTransfer: meta.plan === "super" || meta.freeFiles === true,
      fileMaxBytes: Math.min(
        FILE_MAX_BYTES_CEILING,
        positiveInt(this.env.FILE_MAX_BYTES, DEFAULT_FILE_MAX_BYTES),
      ),
    };
  }

  private toInfo(meta: RoomMeta, now: number): RoomInfo {
    return {
      roomId: meta.roomId,
      expiresAt: meta.expiresAt,
      serverNow: now,
      plan: meta.plan,
      tier: meta.tier,
      maxPeers: meta.maxPeers,
      limits: this.limits(meta),
      ai: meta.ai === true,
      peers: this.activeSockets().length,
    };
  }

  private async save(meta: RoomMeta): Promise<void> {
    await this.ctx.storage.put(META_KEY, meta);
    this.meta = meta;
  }

  /** The member whose socket proved it belongs to the creator, if they're here. */
  private ownerPeerId(): string | null {
    const ws = this.activeSockets().find((s) => this.read(s).owner === true);
    return ws ? this.read(ws).peerId : null;
  }

  private activeSockets(): WebSocket[] {
    return this.ctx.getWebSockets().filter((ws) => this.read(ws).state === "active");
  }

  private read(ws: WebSocket): PeerAttachment {
    return ws.deserializeAttachment() as PeerAttachment;
  }

  private write(ws: WebSocket, patch: Partial<PeerAttachment>): void {
    try {
      ws.serializeAttachment({ ...this.read(ws), ...patch });
    } catch {
      /* socket already gone */
    }
  }

  private send(ws: WebSocket, msg: ServerMessage): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      /* closed; its close handler will clean up */
    }
  }

  private closeQuietly(ws: WebSocket, code: number, reason: string): void {
    try {
      ws.close(code, reason);
    } catch {
      /* already closed */
    }
  }

  /**
   * Accept a socket only to tell the client why it can't join, then close it with the same code.
   * The `rejected` message is what the client relies on; the close frame can get lost.
   * It goes through the hibernation API like every other socket, already marked `left` so nothing
   * counts or relays it: a plain `server.accept()` + `close()` made workerd throw an uncaught
   * "Network connection lost" once the client went away (seen in the browser smoke test).
   */
  private rejectSocket(code: number, reason: string): Response {
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server, ["rejected"]);
    const attachment: PeerAttachment = {
      peerId: "",
      joinedAt: 0,
      signals: 0,
      errors: 0,
      state: "left",
    };
    server.serializeAttachment(attachment);
    this.send(server, { v: PROTOCOL_VERSION, t: "rejected", code, reason });
    this.closeQuietly(server, code, reason);
    return new Response(null, { status: 101, webSocket: client });
  }

  private protocolError(
    ws: WebSocket,
    code: "protocol_error" | "not_owner",
    message: string,
  ): void {
    const att = this.read(ws);
    this.send(ws, { v: PROTOCOL_VERSION, t: "error", code, message });
    if (att.errors >= 1) {
      this.closeQuietly(ws, CloseCode.ProtocolError, "protocol_error");
    } else {
      this.write(ws, { errors: att.errors + 1 });
    }
  }

  /** A socket closed or errored. Replaced/left sockets were already handled; real drops notify the peer. */
  private onSocketGone(ws: WebSocket): void {
    const att = this.read(ws);
    if (att.state !== "active") return;
    this.write(ws, { state: "left" });
    for (const other of this.activeSockets()) {
      this.send(other, {
        v: PROTOCOL_VERSION,
        t: "peer.left",
        peerId: att.peerId,
        reason: "closed",
      });
    }
  }

  /**
   * Pair `peerId` (who just joined, or reconnected with the same peerId) with each member that was
   * already present when it joined (`present`). One `paired` per side per pair; roles: earliest
   * joinedAt = initiator. Only pre-existing members are paired here: someone who joins while we
   * await the ICE servers pairs with this peer in its own call, so no pair is announced twice.
   */
  private async pair(peerId: string, present: WebSocket[]): Promise<void> {
    const meta = this.live();
    if (!meta) return;
    const iceServers = await mintIceServers(this.env, turnCredentialTtl(meta.expiresAt));

    // State may have changed while we awaited the network.
    const active = this.activeSockets();
    const me = active.find((ws) => this.read(ws).peerId === peerId);
    if (!me) return;
    const presentIds = new Set(present.map((ws) => this.read(ws).peerId));
    const others = active.filter((ws) => ws !== me && presentIds.has(this.read(ws).peerId));

    this.write(me, { signals: 0 });
    for (const other of others) {
      this.write(other, { signals: 0 });
      const meFirst =
        this.read(me).joinedAt < this.read(other).joinedAt ||
        (this.read(me).joinedAt === this.read(other).joinedAt && peerId < this.read(other).peerId);
      const [first, second] = meFirst ? [me, other] : [other, me];
      this.send(first, {
        v: PROTOCOL_VERSION,
        t: "paired",
        role: "initiator",
        peerId: this.read(second).peerId,
        iceServers,
      });
      this.send(second, {
        v: PROTOCOL_VERSION,
        t: "paired",
        role: "responder",
        peerId: this.read(first).peerId,
        iceServers,
      });
    }
  }

  /** End the room for everyone and wipe all state. */
  private async terminate(kind: "expired" | "destroyed", by?: string): Promise<void> {
    for (const ws of this.ctx.getWebSockets()) {
      const att = this.read(ws);
      this.write(ws, { state: "left" });
      if (att.state === "active") {
        if (kind === "expired") {
          this.send(ws, { v: PROTOCOL_VERSION, t: "room.expired" });
        } else if (by) {
          this.send(ws, { v: PROTOCOL_VERSION, t: "room.destroyed", by });
        }
      }
      this.closeQuietly(
        ws,
        kind === "expired" ? CloseCode.RoomExpired : CloseCode.RoomDestroyed,
        kind === "expired" ? "room_expired" : "room_destroyed",
      );
    }
    this.meta = null;
    this.banned = [];
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }
}
