import {
  Channel,
  FrameType,
  type ChannelId,
  chatPlaintextSchema,
  ctlPlaintextSchema,
  pqMessageSchema,
  type ChatPlaintext,
  type CtlPlaintext,
  type FrameTypeId,
  type IceServer,
  type PeerRole,
  type PqMessage,
  type SignalPayload,
} from "@poof/protocol";
import { FrameCodec } from "./crypto/frames.ts";
import { InitiatorHandshake, ResponderHandshake, type SessionKeys } from "./crypto/handshake.ts";
import { fromUtf8, utf8 } from "./encoding.ts";
import { PoofError } from "./errors.ts";
import { FileLane, type FileLaneHooks } from "./files.ts";
import { PeerLink, type ChannelName, type ConnectionType, type RtcFactory } from "./peer.ts";
import type { LogCode, LogEntry } from "./types.ts";

/** negotiating → upgrading → connected; `failed` and `closed` are final. */
export type MemberLinkState = "negotiating" | "upgrading" | "connected" | "failed" | "closed";

/** Why a link reports trouble. The session decides what it means (2-person vs group rules). */
export type MemberFailure =
  | { kind: "link" } // ICE failed, connection or channel closed
  | { kind: "pq"; timeout: boolean } // the hybrid key exchange failed or timed out
  | { kind: "frame"; code: string } // tampered, dropped, replayed or reflected frame
  | { kind: "other" };

export interface MemberLinkHooks {
  signal(payload: SignalPayload): void;
  log(code: LogCode, level: LogEntry["level"], data?: Record<string, unknown>): void;
  /** State or connection type changed. */
  changed(): void;
  /** The encrypted channel just came up. */
  connected(): void;
  chat(message: ChatPlaintext): void;
  /** Control messages other than `connection_type` (which the link handles itself). */
  ctl(message: CtlPlaintext): void;
  /** Reported at most once per link. */
  failed(failure: MemberFailure): void;
  /** Incoming files from this member (see files.ts). */
  files: FileLaneHooks;
}

export interface MemberLinkOptions {
  roomId: string;
  roomKey: Uint8Array;
  selfId: string;
  peerId: string;
  role: PeerRole;
  iceServers: IceServer[];
  createPeerConnection: RtcFactory;
  pqTimeoutMs: number;
  fileAckTimeoutMs?: number;
}

/**
 * Backpressure for file chunks: stop queueing above HIGH, resume at LOW. Per member, so a group
 * fan-out buffers at most ~9 × 256 KiB and chat on the other channel isn't stuck behind a file.
 */
const FILES_HIGH_WATER = 256 * 1024;
const FILES_LOW_WATER = 64 * 1024;
/**
 * Everything this browser shares with ONE other member: the WebRTC link, the hybrid key exchange
 * and the encrypted frame codec. A 2-person room has one; a group room has one per other member
 * (full mesh, pairwise keys).
 */
export class MemberLink {
  state: MemberLinkState = "negotiating";
  connectionType: ConnectionType | null = null;
  nickname: string | null = null;
  /** Group rooms: the members this peer says it has a confirmed link with. */
  reportedMembers: string[] | null = null;
  /** The encrypted channel was up at some point (for "joined"/"left" lines). */
  everConnected = false;

  readonly peerId: string;
  readonly role: PeerRole;
  /** File transfers with this member, both directions. */
  readonly files: FileLane;
  private readonly link: PeerLink;
  private handshake: InitiatorHandshake | ResponderHandshake | null = null;
  private codec: FrameCodec | null = null;
  private pqTimer: ReturnType<typeof setTimeout> | null = null;
  private connectionTypePromise: Promise<ConnectionType> | null = null;
  /** Serialises inbound DataChannel messages so async decrypt/handshake steps never interleave. */
  private inbound: Promise<void> = Promise.resolve();
  private reportedFailure = false;

  constructor(
    private readonly opts: MemberLinkOptions,
    private readonly hooks: MemberLinkHooks,
  ) {
    this.peerId = opts.peerId;
    this.role = opts.role;
    this.link = new PeerLink({
      role: opts.role,
      iceServers: opts.iceServers,
      createPeerConnection: opts.createPeerConnection,
      callbacks: {
        onSignal: (payload) => {
          if (this.live) hooks.signal(payload);
        },
        onChannelOpen: (name) => {
          if (name === "ctl") this.onCtlOpen();
        },
        onMessage: (name, data) => this.enqueue(name, data),
        onIceGatheringComplete: (types) => {
          if (this.live) hooks.log("ice.candidates", "info", { types: [...types].sort() });
        },
        onFailed: () => this.report({ kind: "link" }),
      },
    });
    this.files = new FileLane(
      {
        send: (type, plaintext) => this.sendOn("files", type, plaintext),
        ready: () => this.filesReady(),
      },
      hooks.files,
      opts.fileAckTimeoutMs,
    );
  }

  get live(): boolean {
    return this.state !== "failed" && this.state !== "closed";
  }

  start(): void {
    this.link.start().catch(() => this.report({ kind: "link" }));
  }

  handleSignal(payload: SignalPayload): void {
    if (this.live) void this.link.handleSignal(payload);
  }

  /** Encrypt and send one frame on the ctl channel. Throws PoofError("not_connected"). */
  send(type: FrameTypeId, plaintext: Uint8Array): Promise<void> {
    return this.sendOn("ctl", type, plaintext);
  }

  private async sendOn(name: ChannelName, type: FrameTypeId, plaintext: Uint8Array): Promise<void> {
    const codec = this.codec;
    if (this.state !== "connected" || !codec) throw new PoofError("not_connected");
    const frame = await codec.seal(CHANNEL_ID[name], type, plaintext);
    if (this.state !== "connected") throw new PoofError("not_connected");
    try {
      this.link.send(name, frame);
    } catch {
      throw new PoofError("not_connected", "Connection closed.");
    }
  }

  private async filesReady(): Promise<void> {
    if (!this.live) throw new PoofError("not_connected");
    if (this.link.buffered("files") <= FILES_HIGH_WATER) return;
    try {
      await this.link.whenDrained("files", FILES_LOW_WATER);
    } catch {
      throw new PoofError("not_connected", "Connection closed.");
    }
  }

  /** Best effort: control messages never throw. */
  async sendCtl(payload: CtlPlaintext): Promise<void> {
    try {
      await this.send(FrameType.Ctl, utf8(JSON.stringify(payload)));
    } catch {
      /* best effort */
    }
  }

  /** Stop for good. `failed` keeps the member visible as broken; `closed` means gone. */
  close(final: "failed" | "closed" = "closed"): void {
    if (!this.live) return;
    this.state = final;
    this.clearPqTimer();
    this.files.close();
    this.link.close();
    this.handshake?.dispose();
    this.handshake = null;
    this.codec = null;
  }

  // ── Key exchange ──────────────────────────────────────────────────────────

  private onCtlOpen(): void {
    if (this.state !== "negotiating") return;
    this.hooks.log("dc.open", "ok");
    this.state = "upgrading";
    this.hooks.changed();

    this.pqTimer = setTimeout(() => {
      this.pqTimer = null;
      if (this.state === "upgrading") this.report({ kind: "pq", timeout: true });
    }, this.opts.pqTimeoutMs);

    // Connection type is detected in parallel; the key exchange doesn't wait for it.
    this.connectionTypePromise = this.link.detectConnectionType().then((type) => {
      if (this.live) {
        this.connectionType = type;
        this.hooks.log(
          type === "relay" ? "path.relay" : "path.direct",
          type === "relay" ? "warn" : "ok",
        );
        this.hooks.changed();
      }
      return type;
    });

    this.hooks.log("pq.start", "info");
    const pair =
      this.role === "initiator"
        ? { initiator: this.opts.selfId, responder: this.peerId }
        : { initiator: this.peerId, responder: this.opts.selfId };
    if (this.role === "initiator") {
      const hs = new InitiatorHandshake(this.opts.roomId, this.opts.roomKey, pair);
      this.handshake = hs;
      this.sendPq(hs.start());
    } else {
      this.handshake = new ResponderHandshake(this.opts.roomId, this.opts.roomKey, pair);
    }
  }

  private sendPq(msg: PqMessage): void {
    this.link.send("ctl", JSON.stringify(msg));
  }

  private async handlePq(msg: PqMessage): Promise<void> {
    const hs = this.handshake;
    if (this.state !== "upgrading" || !hs) return;

    if (hs instanceof InitiatorHandshake) {
      if (msg.t !== "pq.reply") throw new PoofError("pq_failed", "Unexpected handshake message");
      this.hooks.log("pq.exchange", "info");
      const { confirm, keys } = await hs.handleReply(msg);
      this.sendPq(confirm);
      this.hooks.log("pq.verify", "ok");
      await this.completeUpgrade(keys);
    } else {
      if (msg.t === "pq.hello") {
        this.sendPq(await hs.handleHello(msg));
        this.hooks.log("pq.exchange", "info");
      } else if (msg.t === "pq.confirm") {
        const keys = await hs.handleConfirm(msg);
        this.hooks.log("pq.verify", "ok");
        await this.completeUpgrade(keys);
      } else {
        throw new PoofError("pq_failed", "Unexpected handshake message");
      }
    }
  }

  private async completeUpgrade(keys: SessionKeys): Promise<void> {
    this.clearPqTimer();
    this.handshake?.dispose();
    this.handshake = null;
    this.codec = new FrameCodec(keys);
    this.state = "connected";
    this.everConnected = true;
    this.hooks.changed();
    this.hooks.log("pq.done", "ok");

    // Tell the peer what we saw. Relay wins on both sides, because getStats() can't reliably see
    // the remote side's use of a TURN relay.
    const type = (await this.connectionTypePromise) ?? "relay";
    await this.sendCtl({ kind: "connection_type", value: type });
    if (this.state === "connected") this.hooks.connected();
  }

  private clearPqTimer(): void {
    if (this.pqTimer) clearTimeout(this.pqTimer);
    this.pqTimer = null;
  }

  // ── Inbound ───────────────────────────────────────────────────────────────

  private enqueue(channel: ChannelName, data: string | Uint8Array): void {
    this.inbound = this.inbound
      .then(() => this.handleInbound(channel, data))
      .catch((error: unknown) => this.onInboundError(error));
  }

  private async handleInbound(channel: ChannelName, data: string | Uint8Array): Promise<void> {
    if (!this.live) return;

    if (channel === "files") {
      const codec = this.codec;
      if (typeof data === "string" || !codec) return; // only frames travel here, and only after the handshake
      const frame = await codec.open(data);
      if (frame.channel !== Channel.Files)
        throw new PoofError("frame_invalid", "Frame on the wrong channel");
      if (this.live) await this.files.handle(frame.type, frame.plaintext);
      return;
    }

    if (typeof data === "string") {
      const parsed = pqMessageSchema.safeParse(safeJson(data));
      if (!parsed.success) throw new PoofError("pq_failed", "Malformed handshake message");
      await this.handlePq(parsed.data);
      return;
    }

    const codec = this.codec;
    if (!codec) return; // binary frame before keys exist: ignore
    const frame = await codec.open(data);
    if (frame.channel !== Channel.Ctl)
      throw new PoofError("frame_invalid", "Frame on the wrong channel");
    if (!this.live) return;
    if (frame.type === FrameType.Chat) {
      const chat = chatPlaintextSchema.safeParse(safeJson(fromUtf8(frame.plaintext)));
      if (chat.success) this.hooks.chat(chat.data);
    } else if (frame.type === FrameType.Ctl) {
      const ctl = ctlPlaintextSchema.safeParse(safeJson(fromUtf8(frame.plaintext)));
      if (!ctl.success) return;
      if (ctl.data.kind === "connection_type") {
        if (ctl.data.value === "relay" && this.connectionType !== "relay") {
          this.connectionType = "relay";
          this.hooks.log("path.relay", "warn");
          this.hooks.changed();
        }
      } else {
        this.hooks.ctl(ctl.data);
      }
    }
  }

  private onInboundError(error: unknown): void {
    if (error instanceof PoofError) {
      if (error.code === "pq_failed") return this.report({ kind: "pq", timeout: false });
      if (
        error.code === "frame_invalid" ||
        error.code === "frame_out_of_order" ||
        error.code === "decrypt_failed"
      ) {
        return this.report({ kind: "frame", code: error.code });
      }
    }
    this.report({ kind: "other" });
  }

  private report(failure: MemberFailure): void {
    if (!this.live || this.reportedFailure) return;
    this.reportedFailure = true;
    this.hooks.failed(failure);
  }
}

const CHANNEL_ID: Record<ChannelName, ChannelId> = { ctl: Channel.Ctl, files: Channel.Files };

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
