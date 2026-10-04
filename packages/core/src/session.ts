import {
  CloseCode,
  FrameType,
  PROTOCOL_VERSION,
  roomInfoSchema,
  type ChatPlaintext,
  type CtlPlaintext,
  type IceServer,
  type Limits,
  type Pass,
  type PeerRole,
  type RoomInfo,
  type ServerMessage,
} from "@poof/protocol";
import { inviteUrl } from "./api.ts";
import { fromBase64Url, toBase64Url, randomBytes, utf8, type Bytes } from "./encoding.ts";
import { PoofError } from "./errors.ts";
import { hashFile, type IncomingFileInfo, type OutgoingFile, type SendResult } from "./files.ts";
import { MemberLink, type MemberFailure } from "./member.ts";
import type { RtcFactory } from "./peer.ts";
import { serverError } from "./pay.ts";
import { createPhraseInvite } from "./phrase.ts";
import { SignalingClient, type SocketFactory } from "./signaling.ts";
import { normalizeChatText, normalizeNickname, sanitizeFileName, sanitizeMime } from "./text.ts";
import type {
  ChatItem,
  EndReason,
  LogCode,
  LogEntry,
  MemberView,
  SessionError,
  SessionErrorCode,
  SessionState,
  SessionStatus,
} from "./types.ts";

export interface SessionDeps {
  roomId: string;
  /** The 32-byte room key from the URL fragment. */
  roomKey: Uint8Array;
  /** Origin of the API ("https://api.usepoof.chat"). Used for REST and the WS URL. */
  origin: string;
  /**
   * Origin of the web app ("https://usepoof.chat"), for the invite link. Defaults to `origin`, for a
   * deployment that serves the app and the API from one origin.
   */
  appOrigin?: string;
  fetch: typeof fetch;
  createSocket: SocketFactory;
  createPeerConnection: RtcFactory;
  /** Random per session; stays the same across signaling reconnects. */
  peerId?: string;
  /** The creator's secret from `createRoom` (only on the creator's side). Enables `destroy()`. */
  ownerSecret?: string;
  now?: () => number;
  /** Key-exchange timeout after the channel opens. */
  pqTimeoutMs?: number;
  /**
   * When an established P2P link drops, wait this long for the server to say why (room.expired,
   * room.destroyed, peer.left) before declaring the connection lost. Needed because when a room
   * ends, both browsers tear down WebRTC at about the same time, so the data channel can close
   * before the WebSocket event arrives.
   */
  linkLossGraceMs?: number;
  /** Give up (error: connection_failed) if the signaling server never lets us in within this time. */
  joinTimeoutMs?: number;
  /** Group rooms: how long member lists may disagree (people still joining) before we warn. */
  membersGraceMs?: number;
  /** How long a sender waits for a recipient's hash check after the last chunk. */
  fileAckTimeoutMs?: number;
  /** Where received files become downloadable. Defaults to URL.createObjectURL / revokeObjectURL. */
  objectUrls?: { create(blob: Blob): string; revoke(url: string): void };
  signaling?: { pingIntervalMs?: number; pongTimeoutMs?: number; backoffMs?: readonly number[] };
}

const MAX_LOG_ENTRIES = 200;
const DEFAULT_PQ_TIMEOUT_MS = 10_000;
const DEFAULT_LINK_LOSS_GRACE_MS = 1500;
const DEFAULT_JOIN_TIMEOUT_MS = 15_000;
const DEFAULT_MEMBERS_GRACE_MS = 10_000;
/** After the deadline passes, wait this long for the server's room.expired before asking it. */
const EXPIRY_GRACE_MS = 3000;
const EXPIRY_RETRY_MS = 10_000;

const TERMINAL: ReadonlySet<SessionStatus> = new Set(["terminated", "expired", "error"]);
/** Statuses derived from the links (everything between "welcomed" and an ending). */
const LIVE: ReadonlySet<SessionStatus> = new Set(["waiting", "connecting", "connected", "sealed"]);

type Listener = (state: SessionState) => void;

/** What `sendFile` needs from a file. A browser `File` fits. */
export interface FileLike {
  readonly name: string;
  readonly size: number;
  readonly type: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

type FileItem = Extract<ChatItem, { kind: "file" }>;

const browserObjectUrls = {
  create: (blob: Blob) => URL.createObjectURL(blob),
  revoke: (url: string) => URL.revokeObjectURL(url),
};

const EMPTY_LIMITS: Limits = { fileTransfer: false, fileMaxBytes: 0 };

/** "Peer 3FA2": the first two bytes of the peerId in hex. Stable, short, not secret. */
export function memberLabel(peerId: string): string {
  let hex: string;
  try {
    hex = Array.from(fromBase64Url(peerId).subarray(0, 2), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("");
  } catch {
    hex = peerId.slice(0, 4);
  }
  return `Peer ${hex.toUpperCase()}`;
}

/**
 * The headless room engine. One instance per room page. It owns the signaling socket and one
 * `MemberLink` per other person (WebRTC + hybrid key exchange + encrypted frames), and exposes a
 * single immutable `SessionState` plus a handful of commands. No DOM, no React.
 *
 * Two sets of rules:
 * - **2-person rooms** (`maxPeers === 2`, free): one link; when the other person leaves or the link
 *   breaks, the session ends and the conversation is wiped.
 * - **Group rooms** (`maxPeers > 2`, super): one link per member (mesh, pairwise keys); people come
 *   and go, the room goes on until it expires or the creator destroys it.
 */
export class RoomSession {
  private state: SessionState;
  private readonly listeners = new Set<Listener>();
  private readonly peerId: string;
  private readonly now: () => number;

  private signaling: SignalingClient | null = null;
  private readonly links = new Map<string, MemberLink>();
  private readonly lossTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private joinTimer: ReturnType<typeof setTimeout> | null = null;
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;
  private phraseTimer: ReturnType<typeof setTimeout> | null = null;
  private mismatchTimer: ReturnType<typeof setTimeout> | null = null;
  private clockOffsetMs = 0;
  private started = false;
  /** Files I'm sending → the links they go to (for cancel). */
  private readonly outgoingFiles = new Map<string, MemberLink[]>();
  /** blob: URLs of received files, revoked when the conversation is wiped. */
  private readonly objectUrls = new Set<string>();

  constructor(private readonly deps: SessionDeps) {
    this.now = deps.now ?? Date.now;
    this.peerId = deps.peerId ?? toBase64Url(randomBytes(16));
    this.state = {
      status: "loading",
      error: null,
      endReason: null,
      roomId: deps.roomId,
      inviteUrl: inviteUrl(deps.appOrigin ?? deps.origin, deps.roomId, deps.roomKey),
      isOwner: deps.ownerSecret !== undefined,
      role: null,
      peerPresent: false,
      connectionType: null,
      maxPeers: 2,
      members: [],
      membersMismatch: false,
      nickname: null,
      plan: "free",
      tier: "free",
      expiresAt: null,
      limits: EMPTY_LIMITS,
      messages: [],
      log: [],
      phrase: null,
    };
  }

  /** Group rules apply when the room can hold more than two people. */
  private get isGroup(): boolean {
    return this.state.maxPeers > 2;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  getState(): SessionState {
    return this.state;
  }

  /** For React's useSyncExternalStore. Returns the unsubscribe function. */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Load the room and join it. Safe to call once; later calls are ignored. */
  async start(): Promise<void> {
    if (this.started || this.state.status !== "loading") return;
    this.started = true;
    this.log("key.loaded", "ok");

    let info: RoomInfo;
    try {
      info = await this.fetchRoom();
    } catch (error) {
      if (error instanceof PoofError) this.fail(error.code as SessionErrorCode, error.message);
      else this.fail("connection_failed", "Could not load the room.");
      return;
    }
    if (TERMINAL.has(this.state.status)) return; // left/destroyed while loading
    this.applyRoomMeta(info);
    this.connectSignaling();
    this.scheduleExpiryCheck();
  }

  /**
   * Encrypt and send a chat message to everyone connected (one encryption per member). Resolves
   * with the message id once at least one member got it.
   */
  async sendMessage(text: string): Promise<string> {
    const targets = this.connectedLinks();
    if (this.state.status !== "sealed" || targets.length === 0) {
      throw new PoofError("not_connected", "Not connected to the other person.");
    }
    const clean = normalizeChatText(text);
    if (!clean) throw new PoofError("invalid_message", "Message is empty.");

    const id = crypto.randomUUID();
    const ts = this.now();
    const plaintext = utf8(JSON.stringify({ id, text: clean, ts }));
    const results = await Promise.allSettled(
      targets.map((link) => link.send(FrameType.Chat, plaintext)),
    );
    if (this.state.status !== "sealed" || !results.some((r) => r.status === "fulfilled")) {
      throw new PoofError("not_connected", "Connection closed.");
    }
    this.addMessage({ kind: "text", id, mine: true, from: null, text: clean, ts, status: "sent" });
    return id;
  }

  /**
   * Send a file to everyone connected, each over their own encrypted link (super rooms only).
   * Resolves with the fileId (= the chat item id) once the transfer has started; progress, the
   * hash check and failures then show on that item. Rejects with PoofError: `not_connected`,
   * `not_available` (files are off in this room) or `file_too_large`.
   */
  async sendFile(file: FileLike): Promise<string> {
    this.assertCanSendFile(file.size);
    const bytes = new Uint8Array(await file.arrayBuffer());
    this.assertCanSendFile(bytes.length);
    const sha256 = await hashFile(bytes);
    this.assertCanSendFile(bytes.length);

    const recipients = this.connectedLinks();
    const out: OutgoingFile = {
      fileId: toBase64Url(randomBytes(16)),
      name: sanitizeFileName(file.name),
      mime: sanitizeMime(file.type),
      bytes,
      sha256,
    };
    this.addMessage({
      kind: "file",
      id: out.fileId,
      mine: true,
      from: null,
      name: out.name,
      size: bytes.length,
      mime: out.mime,
      ts: this.now(),
      status: "sending",
      progress: 0,
      recipients: recipients.length,
      delivered: 0,
    });
    void this.fanOut(out, recipients);
    return out.fileId;
  }

  /** Cancel a file I'm sending (to everyone still receiving it) or one I'm receiving. */
  abortTransfer(fileId: string): void {
    const item = this.fileItem(fileId);
    if (!item) return;
    if (item.mine) {
      for (const link of this.outgoingFiles.get(fileId) ?? []) link.files.cancel(fileId);
    } else if (item.status === "receiving" && item.from) {
      this.links.get(item.from)?.files.cancel(fileId);
    }
  }

  /**
   * Set (or clear, with null/empty) your display name. It's normalised, shown to others as
   * "Ana · Peer 3FA2", and sent only over the encrypted links. Returns the normalised value.
   */
  setNickname(name: string | null): string | null {
    const nickname = normalizeNickname(name);
    if (TERMINAL.has(this.state.status) || nickname === this.state.nickname)
      return this.state.nickname;
    this.setState({ nickname });
    for (const link of this.connectedLinks()) void link.sendCtl({ kind: "hello", nickname });
    return nickname;
  }

  /**
   * "Share via code": put this room's invite link behind a fresh 4-word phrase (one-time, 3 min).
   * Sets `state.phrase` until it expires; a new call replaces it. Works while the room is alive.
   */
  async createPhrase(): Promise<{ code: string; expiresAt: number }> {
    if (TERMINAL.has(this.state.status) || this.state.expiresAt === null) {
      throw new PoofError("not_connected", "The room isn't ready.");
    }
    const { code, serverExpiresAt } = await createPhraseInvite({
      fetch: this.deps.fetch,
      origin: this.deps.origin,
      inviteUrl: this.state.inviteUrl,
    });
    if (TERMINAL.has(this.state.status))
      throw new PoofError("not_connected", "The room has ended.");
    // Never promise more time than the room itself has left.
    const expiresAt = Math.min(
      serverExpiresAt - this.clockOffsetMs,
      this.state.expiresAt ?? Infinity,
    );
    const phrase = { code, expiresAt };
    this.setState({ phrase });
    if (this.phraseTimer) clearTimeout(this.phraseTimer);
    this.phraseTimer = setTimeout(
      () => {
        this.phraseTimer = null;
        if (this.state.phrase === phrase) this.setState({ phrase: null });
      },
      Math.max(0, expiresAt - this.now()),
    );
    return phrase;
  }

  /** End the room for everyone. Only the creator can; others get PoofError("not_owner"). */
  destroy(): Promise<void> {
    const { ownerSecret } = this.deps;
    if (ownerSecret === undefined) {
      return Promise.reject(
        new PoofError("not_owner", "Only the person who created the room can destroy it."),
      );
    }
    if (!TERMINAL.has(this.state.status)) {
      this.signaling?.send({ v: PROTOCOL_VERSION, t: "destroy", ownerSecret });
      this.terminate("destroyed_by_me");
    }
    return Promise.resolve();
  }

  /**
   * Creator only: turn this room into the pass's Super Quant-Room (more time, more people, files).
   * Everyone in the room is told by the server (`room.upgraded`); this resolves once it's done.
   */
  async upgrade(pass: Pass): Promise<void> {
    const { ownerSecret } = this.deps;
    if (ownerSecret === undefined) {
      throw new PoofError("not_owner", "Only the person who created the room can upgrade it.");
    }
    if (TERMINAL.has(this.state.status))
      throw new PoofError("room_not_found", "The room has ended.");
    let res: Response;
    try {
      res = await this.deps.fetch(`${this.deps.origin}/api/rooms/${this.deps.roomId}/upgrade`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ownerSecret, pass }),
      });
    } catch {
      throw new PoofError("connection_failed", "Could not reach the server.");
    }
    if (!res.ok) throw serverError(res.status, await res.json().catch(() => null));
    const info = roomInfoSchema.safeParse(await res.json().catch(() => null));
    if (info.success && !TERMINAL.has(this.state.status)) {
      this.applyRoomMeta(info.data);
      this.scheduleExpiryCheck();
    }
  }

  /** Leave this room (the others are told). Call on unmount. */
  async leave(): Promise<void> {
    if (TERMINAL.has(this.state.status)) {
      this.releaseFiles(); // an expired room keeps its transcript (and files) until you leave
      return;
    }
    await Promise.all(this.connectedLinks().map((link) => link.sendCtl({ kind: "bye" })));
    this.signaling?.send({ v: PROTOCOL_VERSION, t: "leave" });
    this.terminate("left_by_me");
  }

  // ── Room loading ──────────────────────────────────────────────────────────

  private async fetchRoom(): Promise<RoomInfo> {
    let res: Response;
    try {
      res = await this.deps.fetch(`${this.deps.origin}/api/rooms/${this.deps.roomId}`);
    } catch {
      throw new PoofError("connection_failed", "Could not reach the server.");
    }
    if (res.status === 404)
      throw new PoofError("room_not_found", "This room doesn't exist or has expired.");
    if (res.status === 429)
      throw new PoofError("rate_limited", "Too many requests. Try again soon.");
    if (!res.ok) throw new PoofError("connection_failed", `Server error ${res.status}.`);
    const parsed = roomInfoSchema.safeParse(await res.json().catch(() => null));
    if (!parsed.success) throw new PoofError("connection_failed", "Unexpected server response.");
    return parsed.data;
  }

  /** Adopt the server's view of the room. `expiresAt` is converted to the local clock. */
  private applyRoomMeta(meta: {
    expiresAt: number;
    serverNow: number;
    plan: SessionState["plan"];
    tier: SessionState["tier"];
    limits: Limits;
    maxPeers?: number;
  }): void {
    this.clockOffsetMs = meta.serverNow - this.now();
    this.setState({
      plan: meta.plan,
      tier: meta.tier,
      limits: meta.limits,
      expiresAt: meta.expiresAt - this.clockOffsetMs,
      ...(meta.maxPeers !== undefined ? { maxPeers: meta.maxPeers } : {}),
    });
  }

  // ── Signaling ─────────────────────────────────────────────────────────────

  private connectSignaling(): void {
    const url = new URL(this.deps.origin);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = `/ws/rooms/${this.deps.roomId}`;
    url.search = `?peerId=${this.peerId}`;

    this.signaling = new SignalingClient({
      url: url.toString(),
      createSocket: this.deps.createSocket,
      onMessage: (msg) => this.onServerMessage(msg),
      onStatus: (status) => {
        if (status === "reconnecting") this.log("signaling.reconnecting", "warn");
      },
      onTerminalClose: (code) => this.onTerminalClose(code),
      ...this.deps.signaling,
    });
    // Without this, an unreachable signaling server would leave the UI loading forever while the
    // client retries in the background.
    this.joinTimer = setTimeout(() => {
      this.joinTimer = null;
      if (this.state.status === "loading") {
        this.fail("connection_failed", "Could not join the room. Check your connection.");
      }
    }, this.deps.joinTimeoutMs ?? DEFAULT_JOIN_TIMEOUT_MS);
    this.signaling.connect();
  }

  private onServerMessage(msg: ServerMessage): void {
    if (TERMINAL.has(this.state.status)) return;
    switch (msg.t) {
      case "welcome":
        this.applyRoomMeta(msg);
        this.clearJoinTimer();
        if (this.state.status === "loading") {
          this.setState({ status: "waiting", peerPresent: msg.peers >= 2 });
          this.log("signaling.connected", "ok");
          this.log("room.waiting", "ok");
        }
        return;
      case "paired":
        this.onPaired(msg.peerId, msg.role, msg.iceServers);
        return;
      case "signal":
        // Signals can only follow `paired`, which creates the link; without one they're stale.
        this.links.get(msg.from)?.handleSignal(msg.payload);
        return;
      case "peer.left":
        this.onPeerLeft(msg.peerId);
        return;
      case "replaced":
        this.terminate("replaced");
        return;
      case "room.expired":
        this.expire();
        return;
      case "room.destroyed":
        this.log("room.destroyed", "warn");
        this.terminate(msg.by === this.peerId ? "destroyed_by_me" : "destroyed_by_peer");
        return;
      case "room.upgraded":
        this.applyRoomMeta(msg);
        this.scheduleExpiryCheck();
        // The old relay credentials end with the old deadline: relayed links rebuild with new ones.
        for (const link of this.links.values()) void link.refreshIceServers(msg.iceServers);
        return;
      case "rejected":
        // The close frame that follows can get lost; the message is enough.
        this.onTerminalClose(msg.code);
        return;
      case "error":
        return;
    }
  }

  private onTerminalClose(code: number): void {
    if (TERMINAL.has(this.state.status)) return;
    switch (code) {
      case CloseCode.RoomExpired:
        this.expire();
        return;
      case CloseCode.RoomDestroyed:
        this.terminate("destroyed_by_peer");
        return;
      case CloseCode.RoomFull:
        this.fail("room_full", "This room is full.");
        return;
      case CloseCode.RoomNotFound:
        this.fail("room_not_found", "This room doesn't exist or has expired.");
        return;
      case CloseCode.Replaced:
        this.terminate("replaced");
        return;
      default:
        this.fail("connection_failed", "Lost connection to the server.");
    }
  }

  // ── Links ─────────────────────────────────────────────────────────────────

  private onPaired(peerId: string, role: PeerRole, iceServers: IceServer[]): void {
    // A modified server must not be able to make this browser open links without end.
    if (peerId === this.peerId) return;
    if (this.isGroup && !this.links.has(peerId) && this.links.size >= this.state.maxPeers - 1)
      return;
    // Once a channel is being upgraded or is live, a repeated `paired` (the server re-pairs when
    // someone reconnects its signaling socket) must not disturb it. Otherwise it restarts the attempt.
    const existing = this.isGroup ? this.links.get(peerId) : [...this.links.values()][0];
    if (existing && (existing.state === "upgrading" || existing.state === "connected")) return;
    if (this.isGroup) this.dropLink(peerId);
    else for (const id of [...this.links.keys()]) this.dropLink(id);

    this.log("peer.joined", "info", this.withPeer(peerId, { role }));
    this.log("ice.gathering", "info", this.withPeer(peerId));

    const link: MemberLink = new MemberLink(
      {
        roomId: this.deps.roomId,
        roomKey: this.deps.roomKey,
        selfId: this.peerId,
        peerId,
        role,
        iceServers,
        createPeerConnection: this.deps.createPeerConnection,
        pqTimeoutMs: this.deps.pqTimeoutMs ?? DEFAULT_PQ_TIMEOUT_MS,
        ...(this.deps.fileAckTimeoutMs !== undefined
          ? { fileAckTimeoutMs: this.deps.fileAckTimeoutMs }
          : {}),
      },
      {
        signal: (payload) => {
          this.signaling?.send({ v: PROTOCOL_VERSION, t: "signal", to: peerId, payload });
        },
        log: (code, level, data) => {
          if (this.links.get(peerId) === link) this.log(code, level, this.withPeer(peerId, data));
        },
        changed: () => {
          if (this.links.get(peerId) === link) this.refresh();
        },
        connected: () => this.onLinkConnected(link),
        chat: (message) => this.onChat(link, message),
        ctl: (message) => this.onCtl(link, message),
        failed: (failure) => this.onLinkFailed(link, failure),
        files: {
          limits: () => this.state.limits,
          incomingStart: (info) => this.onIncomingFile(link, info),
          incomingProgress: (fileId, received) => {
            const item = this.fileItem(fileId);
            if (item?.status === "receiving")
              this.updateFile(fileId, { progress: received / Math.max(1, item.size) });
          },
          incomingDone: (fileId, bytes) => this.onIncomingDone(fileId, bytes),
          // Not tied to the link still being current: a link that closes fails its file on the way out.
          incomingFailed: (fileId, reason) => {
            if (this.fileItem(fileId)?.status === "receiving")
              this.updateFile(fileId, { status: "failed", error: reason });
          },
        },
      },
    );
    this.links.set(peerId, link);
    this.refresh({ peerPresent: true, ...(this.isGroup ? {} : { role }) });
    link.start();
  }

  private onLinkConnected(link: MemberLink): void {
    if (TERMINAL.has(this.state.status) || this.links.get(link.peerId) !== link) return;
    if (this.state.nickname !== null)
      void link.sendCtl({ kind: "hello", nickname: this.state.nickname });
    if (!this.isGroup) return;
    this.addMessage({
      kind: "system",
      id: crypto.randomUUID(),
      ts: this.now(),
      event: "joined",
      peerId: link.peerId,
    });
    this.announceMembers();
  }

  private onPeerLeft(peerId: string): void {
    if (!this.isGroup) {
      this.log("peer.left", "warn");
      const { status } = this.state;
      if (status === "connecting") {
        // Someone opened the link and closed it again before connecting: the room is still ours.
        for (const id of [...this.links.keys()]) this.dropLink(id);
        this.setState({
          status: "waiting",
          role: null,
          peerPresent: false,
          members: [],
          connectionType: null,
        });
        return;
      }
      if (status === "connected" || status === "sealed") this.terminate("peer_left");
      else this.setState({ peerPresent: false });
      return;
    }

    const link = this.links.get(peerId);
    if (!link) return;
    this.log("peer.left", "warn", this.withPeer(peerId));
    if (link.everConnected) {
      this.addMessage({
        kind: "system",
        id: crypto.randomUUID(),
        ts: this.now(),
        event: "left",
        peerId,
      });
    }
    this.dropLink(peerId);
    this.refresh({ peerPresent: this.links.size > 0 });
    this.announceMembers();
  }

  private onLinkFailed(link: MemberLink, failure: MemberFailure): void {
    if (TERMINAL.has(this.state.status) || this.links.get(link.peerId) !== link) return;
    const peer = link.peerId;

    if (!this.isGroup) {
      switch (failure.kind) {
        case "link":
          this.log("conn.failed", "error");
          if (this.state.status === "sealed") {
            // Give the server's explanation (expired / destroyed / peer left) a moment to arrive first.
            this.afterGrace(peer, () => this.terminate("connection_lost"));
          } else {
            this.fail(
              "connection_failed",
              "Could not establish a connection. A firewall may be blocking it.",
            );
          }
          return;
        case "pq":
          this.fail(
            "pq_failed",
            failure.timeout ? "The secure handshake timed out." : "The secure handshake failed.",
          );
          return;
        case "frame":
          this.log("conn.failed", "error", { reason: failure.code });
          this.terminate("connection_lost");
          return;
        case "other":
          this.fail("connection_failed", "Something went wrong with the connection.");
          return;
      }
    }

    // Group: only this member's link is affected.
    this.log(
      "conn.failed",
      "error",
      this.withPeer(peer, failure.kind === "frame" ? { reason: failure.code } : {}),
    );
    const markFailed = () => {
      if (this.links.get(peer) !== link) return;
      link.close("failed");
      this.refresh();
      this.announceMembers();
    };
    if (failure.kind === "link" && link.state === "connected") this.afterGrace(peer, markFailed);
    else markFailed();
  }

  /** Run `fn` after the link-loss grace period unless the member is dropped first. */
  private afterGrace(peerId: string, fn: () => void): void {
    if (this.lossTimers.has(peerId)) return;
    this.lossTimers.set(
      peerId,
      setTimeout(() => {
        this.lossTimers.delete(peerId);
        if (!TERMINAL.has(this.state.status)) fn();
      }, this.deps.linkLossGraceMs ?? DEFAULT_LINK_LOSS_GRACE_MS),
    );
  }

  private dropLink(peerId: string): void {
    this.links.get(peerId)?.close();
    this.links.delete(peerId);
    const timer = this.lossTimers.get(peerId);
    if (timer) clearTimeout(timer);
    this.lossTimers.delete(peerId);
  }

  private connectedLinks(): MemberLink[] {
    return [...this.links.values()].filter((link) => link.state === "connected");
  }

  // ── Inbound (already decrypted by the link) ───────────────────────────────

  private onChat(link: MemberLink, chat: ChatPlaintext): void {
    if (TERMINAL.has(this.state.status) || this.links.get(link.peerId) !== link) return;
    const text = normalizeChatText(chat.text);
    if (!text) return;
    this.addMessage({
      kind: "text",
      id: chat.id,
      mine: false,
      from: link.peerId,
      text,
      ts: this.now(),
      status: "received",
    });
  }

  private onCtl(link: MemberLink, ctl: CtlPlaintext): void {
    if (TERMINAL.has(this.state.status) || this.links.get(link.peerId) !== link) return;
    switch (ctl.kind) {
      case "bye":
        if (this.isGroup) this.onPeerLeft(link.peerId);
        else this.terminate("peer_left");
        return;
      case "hello":
        link.nickname = normalizeNickname(ctl.nickname);
        this.refresh();
        return;
      case "members":
        link.reportedMembers = ctl.peerIds;
        this.checkMembers();
        return;
      case "connection_type":
        return; // handled by the link
    }
  }

  // ── Group membership consistency (split-view check) ───────────────────────

  /** Tell everyone connected which members we have a confirmed link with. */
  private announceMembers(): void {
    if (!this.isGroup || TERMINAL.has(this.state.status)) return;
    const peerIds = this.connectedLinks().map((link) => link.peerId);
    for (const link of this.connectedLinks()) void link.sendCtl({ kind: "members", peerIds });
    this.checkMembers();
  }

  private membersDisagree(): boolean {
    const mine = new Set(this.connectedLinks().map((link) => link.peerId));
    for (const link of this.connectedLinks()) {
      if (!link.reportedMembers) continue;
      const expected = new Set([...mine, this.peerId]);
      expected.delete(link.peerId);
      const theirs = new Set(link.reportedMembers);
      if (theirs.size !== expected.size || [...theirs].some((id) => !expected.has(id))) return true;
    }
    return false;
  }

  /** People joining or leaving disagree briefly; only a lasting difference is worth a warning. */
  private checkMembers(): void {
    if (!this.isGroup || TERMINAL.has(this.state.status)) return;
    if (!this.membersDisagree()) {
      if (this.mismatchTimer) clearTimeout(this.mismatchTimer);
      this.mismatchTimer = null;
      if (this.state.membersMismatch) this.setState({ membersMismatch: false });
      return;
    }
    if (this.mismatchTimer || this.state.membersMismatch) return;
    this.mismatchTimer = setTimeout(() => {
      this.mismatchTimer = null;
      if (!TERMINAL.has(this.state.status) && this.membersDisagree())
        this.setState({ membersMismatch: true });
    }, this.deps.membersGraceMs ?? DEFAULT_MEMBERS_GRACE_MS);
  }

  // ── Expiry ────────────────────────────────────────────────────────────────

  /**
   * Safety net for the server's room.expired event (a dead socket can't deliver it): shortly after
   * the deadline, ask the server. Only a server answer ends the session, never the local clock.
   */
  private scheduleExpiryCheck(): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    const { expiresAt } = this.state;
    if (expiresAt === null || TERMINAL.has(this.state.status)) return;
    const delay = Math.max(1000, expiresAt - this.now() + EXPIRY_GRACE_MS);
    this.expiryTimer = setTimeout(() => void this.checkExpiry(), delay);
  }

  private async checkExpiry(): Promise<void> {
    this.expiryTimer = null;
    if (TERMINAL.has(this.state.status)) return;
    try {
      const info = await this.fetchRoom();
      if (TERMINAL.has(this.state.status)) return;
      this.applyRoomMeta(info); // still alive (e.g. extended): follow the new deadline
      this.scheduleExpiryCheck();
    } catch (error) {
      if (error instanceof PoofError && error.code === "room_not_found") {
        this.expire();
      } else {
        this.expiryTimer = setTimeout(() => void this.checkExpiry(), EXPIRY_RETRY_MS);
      }
    }
  }

  // ── Endings ───────────────────────────────────────────────────────────────

  // ── Files ─────────────────────────────────────────────────────────────────

  private assertCanSendFile(size: number): void {
    if (this.state.status !== "sealed" || this.connectedLinks().length === 0) {
      throw new PoofError("not_connected", "Not connected to anyone.");
    }
    const { limits } = this.state;
    if (!limits.fileTransfer)
      throw new PoofError("not_available", "Files can be sent in super rooms only.");
    if (size > limits.fileMaxBytes) throw new PoofError("file_too_large", "The file is too large.");
  }

  /** Send one file to each recipient (in parallel, each with its own backpressure) and track it on the item. */
  private async fanOut(out: OutgoingFile, links: MemberLink[]): Promise<void> {
    const size = out.bytes.length;
    const lanes = links.map(() => ({ sent: 0, allSent: false, result: null as SendResult | null }));
    const update = () => {
      const failures = lanes.flatMap((l) => (l.result && !l.result.ok ? [l.result.reason] : []));
      const delivered = lanes.filter((l) => l.result?.ok).length;
      const finished = lanes.every((l) => l.result);
      // A recipient that finished either way no longer holds the progress bar back.
      const sentBytes = lanes.reduce((sum, l) => sum + (l.result || l.allSent ? size : l.sent), 0);
      const status: FileItem["status"] = finished
        ? delivered > 0
          ? "delivered"
          : "failed"
        : lanes.every((l) => l.result || l.allSent)
          ? "sent"
          : "sending";
      const total = size * lanes.length;
      this.updateFile(out.fileId, {
        status,
        delivered,
        progress: total > 0 ? sentBytes / total : status === "sending" ? 0 : 1,
        ...(status === "failed" ? { error: failures[0] ?? "connection_lost" } : {}),
      });
    };

    this.outgoingFiles.set(out.fileId, links);
    await Promise.all(
      links.map(async (link, i) => {
        const lane = lanes[i]!;
        lane.result = await link.files.send(out, (sent, allSent) => {
          lane.sent = sent;
          lane.allSent = allSent;
          update();
        });
        update();
      }),
    );
    this.outgoingFiles.delete(out.fileId);
  }

  private onIncomingFile(link: MemberLink, info: IncomingFileInfo): boolean {
    if (TERMINAL.has(this.state.status) || this.links.get(link.peerId) !== link) return false;
    if (this.state.messages.some((m) => m.id === info.fileId)) return false; // ids must stay unique
    this.addMessage({
      kind: "file",
      id: info.fileId,
      mine: false,
      from: link.peerId,
      name: info.name,
      size: info.size,
      mime: info.mime,
      ts: this.now(),
      status: "receiving",
      progress: 0,
      recipients: 0,
      delivered: 0,
    });
    return true;
  }

  private onIncomingDone(fileId: string, bytes: Bytes): void {
    const item = this.fileItem(fileId);
    if (TERMINAL.has(this.state.status) || item?.status !== "receiving") return;
    const url = (this.deps.objectUrls ?? browserObjectUrls).create(
      new Blob([bytes], { type: item.mime }),
    );
    this.objectUrls.add(url);
    this.updateFile(fileId, { status: "received", progress: 1, url });
  }

  private fileItem(fileId: string): FileItem | undefined {
    const item = this.state.messages.find((m) => m.id === fileId);
    return item?.kind === "file" ? item : undefined;
  }

  /** Patch a file item. Progress is kept to whole percents, so a 2 MB file is ~100 updates, not 128 × recipients. */
  private updateFile(
    fileId: string,
    patch: Partial<Pick<FileItem, "status" | "progress" | "delivered" | "url" | "error">>,
  ): void {
    const item = this.fileItem(fileId);
    if (!item) return;
    const next: FileItem = {
      ...item,
      ...patch,
      ...(patch.progress !== undefined
        ? { progress: Math.min(1, Math.floor(patch.progress * 100) / 100) }
        : {}),
    };
    if (
      next.status === item.status &&
      next.progress === item.progress &&
      next.delivered === item.delivered &&
      next.url === item.url &&
      next.error === item.error
    ) {
      return;
    }
    this.setState({ messages: this.state.messages.map((m) => (m === item ? next : m)) });
  }

  private releaseFiles(): void {
    const urls = this.deps.objectUrls ?? browserObjectUrls;
    for (const url of this.objectUrls) urls.revoke(url);
    this.objectUrls.clear();
  }

  /** Close everything and scrub secrets. */
  private shutdown(): void {
    this.clearJoinTimer();
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    if (this.phraseTimer) clearTimeout(this.phraseTimer);
    this.phraseTimer = null;
    if (this.mismatchTimer) clearTimeout(this.mismatchTimer);
    this.mismatchTimer = null;
    for (const id of [...this.links.keys()]) this.dropLink(id);
    this.outgoingFiles.clear();
    this.signaling?.close();
    this.signaling = null;
  }

  /** The conversation is over: wipe it from memory and from the state. */
  private terminate(reason: EndReason): void {
    if (TERMINAL.has(this.state.status)) return;
    this.shutdown();
    this.releaseFiles();
    this.setState({
      status: "terminated",
      endReason: reason,
      peerPresent: false,
      members: [],
      membersMismatch: false,
      messages: [],
      phrase: null,
    });
  }

  /**
   * The room's time is up (server-confirmed). The P2P links are closed (files in flight fail); the
   * transcript, received files included, stays readable until you leave.
   */
  private expire(): void {
    if (TERMINAL.has(this.state.status)) return;
    this.log("room.expired", "warn");
    this.shutdown();
    this.setState({ status: "expired", peerPresent: false, members: [], phrase: null });
  }

  private fail(code: SessionErrorCode, message: string): void {
    if (TERMINAL.has(this.state.status)) return;
    this.shutdown();
    this.releaseFiles();
    const error: SessionError = { code, message };
    this.setState({
      status: "error",
      error,
      peerPresent: false,
      members: [],
      messages: [],
      phrase: null,
    });
  }

  private clearJoinTimer(): void {
    if (this.joinTimer) clearTimeout(this.joinTimer);
    this.joinTimer = null;
  }

  // ── State ─────────────────────────────────────────────────────────────────

  /** Recompute everything derived from the links (status, members, connection type). */
  private refresh(patch: Partial<SessionState> = {}): void {
    if (TERMINAL.has(this.state.status)) return;
    const links = [...this.links.values()];
    const members: MemberView[] = links.map((link) => ({
      peerId: link.peerId,
      label: memberLabel(link.peerId),
      nickname: link.nickname,
      state: link.state === "connected" ? "sealed" : link.live ? "joining" : "failed",
      connectionType: link.connectionType,
    }));

    let { status } = this.state;
    if (LIVE.has(status)) {
      const has = (s: MemberLink["state"]) => links.some((link) => link.state === s);
      // Link states (member.ts) → the room's status, as the docs name it: waiting → connecting →
      // connected (channel open, post-quantum exchange running) → sealed.
      status = has("connected")
        ? "sealed"
        : has("upgrading")
          ? "connected"
          : has("negotiating")
            ? "connecting"
            : "waiting";
    }
    const types = links.filter((link) => link.live).map((link) => link.connectionType);
    const connectionType = types.includes("relay")
      ? "relay"
      : types.includes("direct")
        ? "direct"
        : null;

    this.setState({ status, members, connectionType, ...patch });
  }

  /** In group rooms, log lines say which member they're about. */
  private withPeer(
    peerId: string,
    data?: Record<string, unknown>,
  ): Record<string, unknown> | undefined {
    if (!this.isGroup) return data && Object.keys(data).length > 0 ? data : undefined;
    return { ...data, peer: memberLabel(peerId) };
  }

  private addMessage(item: ChatItem): void {
    this.setState({ messages: [...this.state.messages, item] });
  }

  private log(code: LogCode, level: LogEntry["level"], data?: Record<string, unknown>): void {
    const entry: LogEntry = { ts: this.now(), code, level, ...(data ? { data } : {}) };
    this.setState({ log: [...this.state.log, entry].slice(-MAX_LOG_ENTRIES) });
  }

  private setState(patch: Partial<SessionState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of [...this.listeners]) listener(this.state);
  }
}
