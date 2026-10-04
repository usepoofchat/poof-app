import { CHANNEL_LABEL, type IceServer, type PeerRole, type SignalPayload } from "@poof/protocol";

export type ConnectionType = "direct" | "relay";
export type ChannelName = "ctl" | "files";

// ── Minimal structural types over the WebRTC API (so the engine runs in Node tests) ────────────

export interface RtcDataChannelLike {
  readonly label: string;
  readonly readyState: string;
  binaryType: string;
  readonly bufferedAmount: number;
  bufferedAmountLowThreshold: number;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onerror: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onbufferedamountlow: (() => void) | null;
  send(data: string | Uint8Array): void;
  close(): void;
}

export interface RtcIceCandidateLike {
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
  usernameFragment: string | null;
}

export interface RtcStatsLike {
  forEach(callback: (report: Record<string, unknown>) => void): void;
  get(id: string): Record<string, unknown> | undefined;
}

export interface RtcPeerConnectionLike {
  readonly connectionState: string;
  readonly remoteDescription: { type: string; sdp: string } | null;
  onicecandidate: ((event: { candidate: RtcIceCandidateLike | null }) => void) | null;
  onconnectionstatechange: (() => void) | null;
  ondatachannel: ((event: { channel: RtcDataChannelLike }) => void) | null;
  createDataChannel(label: string, init?: { ordered?: boolean }): RtcDataChannelLike;
  createOffer(options?: { iceRestart?: boolean }): Promise<{ type: string; sdp?: string }>;
  createAnswer(): Promise<{ type: string; sdp?: string }>;
  setLocalDescription(description: { type: string; sdp?: string }): Promise<void>;
  setRemoteDescription(description: { type: "offer" | "answer"; sdp: string }): Promise<void>;
  addIceCandidate(candidate: {
    candidate: string;
    sdpMid?: string | null;
    sdpMLineIndex?: number | null;
    usernameFragment?: string | null;
  }): Promise<void>;
  getStats(): Promise<RtcStatsLike>;
  close(): void;
}

export type RtcFactory = (config: { iceServers: IceServer[] }) => RtcPeerConnectionLike;

/** Real RTCPeerConnection behind the structural interface. The one cast lives here, at the boundary. */
export const browserRtcFactory: RtcFactory = (config) =>
  new RTCPeerConnection(config) as unknown as RtcPeerConnectionLike;

export interface PeerCallbacks {
  onSignal(payload: SignalPayload): void;
  onChannelOpen(channel: ChannelName): void;
  onMessage(channel: ChannelName, data: string | Uint8Array): void;
  onIceGatheringComplete(types: ReadonlySet<string>): void;
  /** ICE failed, the connection closed, or a channel closed unexpectedly. Fires at most once. */
  onFailed(): void;
}

export interface PeerLinkOptions {
  role: PeerRole;
  iceServers: IceServer[];
  createPeerConnection: RtcFactory;
  callbacks: PeerCallbacks;
}

function describe(report: Record<string, unknown> | undefined): string | undefined {
  const type = report?.candidateType;
  return typeof type === "string" ? type : undefined;
}

/** One WebRTC connection with two ordered, reliable DataChannels: control/chat and files. */
export class PeerLink {
  private readonly pc: RtcPeerConnectionLike;
  private readonly channels: Record<ChannelName, RtcDataChannelLike | null> = {
    ctl: null,
    files: null,
  };
  private pendingCandidates: Array<Extract<SignalPayload, { kind: "candidate" }>["candidate"]> = [];
  private readonly candidateTypes = new Set<string>();
  private readonly drainWaiters: Record<
    ChannelName,
    Set<{ resolve(): void; reject(error: Error): void }>
  > = {
    ctl: new Set(),
    files: new Set(),
  };
  private closed = false;
  private failed = false;

  constructor(private readonly opts: PeerLinkOptions) {
    const pc = opts.createPeerConnection({ iceServers: opts.iceServers });
    this.pc = pc;

    pc.onicecandidate = (event) => {
      if (this.closed) return;
      const c = event.candidate;
      if (!c) {
        this.opts.callbacks.onIceGatheringComplete(this.candidateTypes);
        return;
      }
      const match = / typ (\w+)/.exec(c.candidate);
      if (match?.[1]) this.candidateTypes.add(match[1]);
      this.opts.callbacks.onSignal({
        kind: "candidate",
        candidate: {
          candidate: c.candidate,
          sdpMid: c.sdpMid,
          sdpMLineIndex: c.sdpMLineIndex,
          usernameFragment: c.usernameFragment,
        },
      });
    };

    pc.onconnectionstatechange = () => {
      // "disconnected" is transient and may recover on its own; only terminal states count.
      if (pc.connectionState === "failed" || pc.connectionState === "closed") this.fail();
    };

    // The responder receives the channels the initiator created.
    pc.ondatachannel = (event) => {
      if (event.channel.label === CHANNEL_LABEL.Ctl) this.attach("ctl", event.channel);
      else if (event.channel.label === CHANNEL_LABEL.Files) this.attach("files", event.channel);
    };
  }

  /** Initiator: create both channels and the offer. Responder: nothing to do until an offer arrives. */
  async start(): Promise<void> {
    if (this.opts.role !== "initiator") return;
    // Channels exist BEFORE the offer so they are negotiated in it, and their handlers are attached
    // immediately so no early message can be missed (no race with the key exchange).
    this.attach("ctl", this.pc.createDataChannel(CHANNEL_LABEL.Ctl, { ordered: true }));
    this.attach("files", this.pc.createDataChannel(CHANNEL_LABEL.Files, { ordered: true }));
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    if (this.closed) return;
    this.opts.callbacks.onSignal({ kind: "offer", sdp: offer.sdp ?? "" });
  }

  /** Feed a signal relayed from the other peer. Candidates that arrive early are queued. */
  async handleSignal(payload: SignalPayload): Promise<void> {
    if (this.closed) return;
    try {
      if (payload.kind === "offer") {
        if (this.opts.role !== "responder") return;
        await this.pc.setRemoteDescription({ type: "offer", sdp: payload.sdp });
        await this.flushCandidates();
        const answer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(answer);
        if (this.closed) return;
        this.opts.callbacks.onSignal({ kind: "answer", sdp: answer.sdp ?? "" });
      } else if (payload.kind === "answer") {
        if (this.opts.role !== "initiator") return;
        await this.pc.setRemoteDescription({ type: "answer", sdp: payload.sdp });
        await this.flushCandidates();
      } else if (this.pc.remoteDescription) {
        await this.addCandidate(payload.candidate);
      } else {
        this.pendingCandidates.push(payload.candidate);
      }
    } catch {
      this.fail();
    }
  }

  channelOpen(name: ChannelName): boolean {
    return this.channels[name]?.readyState === "open";
  }

  /** Throws if the channel isn't open. */
  send(name: ChannelName, data: string | Uint8Array): void {
    const channel = this.channels[name];
    if (!channel || channel.readyState !== "open") throw new Error(`channel ${name} is not open`);
    channel.send(data);
  }

  /** Remaining bytes queued on a channel, for backpressure. */
  buffered(name: ChannelName): number {
    return this.channels[name]?.bufferedAmount ?? 0;
  }

  /** Resolves once a channel's send buffer is at or below `lowWater`; rejects if the link ends first. */
  whenDrained(name: ChannelName, lowWater: number): Promise<void> {
    const channel = this.channels[name];
    if (this.closed || this.failed || !channel)
      return Promise.reject(new Error(`channel ${name} is not open`));
    if (channel.bufferedAmount <= lowWater) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const waiters = this.drainWaiters[name];
      waiters.add({ resolve, reject });
      channel.bufferedAmountLowThreshold = lowWater;
      channel.onbufferedamountlow = () => {
        channel.onbufferedamountlow = null;
        for (const waiter of waiters) waiter.resolve();
        waiters.clear();
      };
    });
  }

  /**
   * Inspect the selected ICE candidate pair. "relay" if either side goes through TURN. Unknown
   * (no pair, or stats unavailable) is reported as "relay": the conservative answer.
   */
  async detectConnectionType(): Promise<ConnectionType> {
    try {
      const stats = await this.pc.getStats();
      let pairId: string | undefined;
      stats.forEach((report) => {
        if (report.type === "transport" && typeof report.selectedCandidatePairId === "string") {
          pairId = report.selectedCandidatePairId;
        }
      });
      if (!pairId) {
        stats.forEach((report) => {
          if (
            report.type === "candidate-pair" &&
            report.state === "succeeded" &&
            report.nominated === true
          ) {
            pairId = String(report.id);
          }
        });
      }
      const pair = pairId ? stats.get(pairId) : undefined;
      if (!pair) return "relay";
      const local = describe(stats.get(String(pair.localCandidateId)));
      const remote = describe(stats.get(String(pair.remoteCandidateId)));
      return local === "relay" || remote === "relay" ? "relay" : "direct";
    } catch {
      return "relay";
    }
  }

  /** Restart ICE (initiator re-offers with iceRestart). Not used yet: a broken link ends the session. */
  async restartIce(): Promise<void> {
    if (this.closed || this.opts.role !== "initiator") return;
    const offer = await this.pc.createOffer({ iceRestart: true });
    await this.pc.setLocalDescription(offer);
    this.opts.callbacks.onSignal({ kind: "offer", sdp: offer.sdp ?? "" });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.rejectDrainWaiters();
    for (const channel of Object.values(this.channels)) {
      if (!channel) continue;
      channel.onopen = channel.onclose = channel.onerror = channel.onmessage = null;
      channel.onbufferedamountlow = null;
      try {
        channel.close();
      } catch {
        /* already closed */
      }
    }
    this.pc.onicecandidate = this.pc.onconnectionstatechange = this.pc.ondatachannel = null;
    try {
      this.pc.close();
    } catch {
      /* already closed */
    }
  }

  private attach(name: ChannelName, channel: RtcDataChannelLike): void {
    this.channels[name] = channel;
    channel.binaryType = "arraybuffer";
    channel.onopen = () => {
      if (!this.closed) this.opts.callbacks.onChannelOpen(name);
    };
    channel.onclose = () => this.fail();
    channel.onmessage = (event) => {
      if (this.closed) return;
      const { data } = event;
      if (typeof data === "string") this.opts.callbacks.onMessage(name, data);
      else if (data instanceof ArrayBuffer)
        this.opts.callbacks.onMessage(name, new Uint8Array(data));
      else if (ArrayBuffer.isView(data)) {
        this.opts.callbacks.onMessage(
          name,
          new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
        );
      }
    };
    // If the channel was already open by the time we attached (responder side), report it.
    if (channel.readyState === "open") queueMicrotask(() => channel.onopen?.());
  }

  private async flushCandidates(): Promise<void> {
    const queued = this.pendingCandidates;
    this.pendingCandidates = [];
    for (const candidate of queued) await this.addCandidate(candidate);
  }

  private async addCandidate(
    candidate: Extract<SignalPayload, { kind: "candidate" }>["candidate"],
  ): Promise<void> {
    try {
      await this.pc.addIceCandidate(candidate);
    } catch {
      // A stale or unusable candidate must not tear the connection down.
    }
  }

  private fail(): void {
    if (this.closed || this.failed) return;
    this.failed = true;
    this.rejectDrainWaiters();
    this.opts.callbacks.onFailed();
  }

  private rejectDrainWaiters(): void {
    for (const waiters of Object.values(this.drainWaiters)) {
      for (const waiter of waiters) waiter.reject(new Error("link closed"));
      waiters.clear();
    }
  }
}
