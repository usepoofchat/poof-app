import type { SignalPayload } from "@poof/protocol";
import { describe, expect, it, vi } from "vitest";
import { PeerLink, type ChannelName, type ConnectionType } from "../src/index.ts";
import type { FakePeerConnection } from "./fakes.ts";
import { FakeRtcNetwork, tick, waitFor, type FakeStats } from "./fakes.ts";

interface Harness {
  link: PeerLink;
  net: FakeRtcNetwork;
  pc: () => FakePeerConnection;
  signals: SignalPayload[];
  opened: ChannelName[];
  messages: Array<{ channel: ChannelName; data: string | Uint8Array }>;
  gathered: Array<ReadonlySet<string>>;
  failed: () => number;
}

function harness(role: "initiator" | "responder", net = new FakeRtcNetwork()): Harness {
  const signals: SignalPayload[] = [];
  const opened: ChannelName[] = [];
  const messages: Array<{ channel: ChannelName; data: string | Uint8Array }> = [];
  const gathered: Array<ReadonlySet<string>> = [];
  let failedCount = 0;
  const link = new PeerLink({
    role,
    iceServers: [{ urls: "stun:x" }],
    createPeerConnection: net.factory,
    callbacks: {
      onSignal: (p) => signals.push(p),
      onChannelOpen: (c) => opened.push(c),
      onMessage: (channel, data) => messages.push({ channel, data }),
      onIceGatheringComplete: (t) => gathered.push(t),
      onFailed: () => failedCount++,
    },
  });
  return {
    link,
    net,
    pc: () => net.connections.at(-1)!,
    signals,
    opened,
    messages,
    gathered,
    failed: () => failedCount,
  };
}

/** Two links wired together through a shared fake network, signals delivered by hand. */
async function connectedPair() {
  const net = new FakeRtcNetwork();
  const a = harness("initiator", net);
  const b = harness("responder", net);
  await a.link.start();
  const offer = a.signals.find((s) => s.kind === "offer")!;
  await b.link.handleSignal(offer);
  const answer = b.signals.find((s) => s.kind === "answer")!;
  await a.link.handleSignal(answer);
  await waitFor(() => a.opened.length === 2 && b.opened.length === 2, "channels open");
  return { net, a, b };
}

describe("PeerLink negotiation", () => {
  it("initiator creates both ordered channels before the offer, then offers", async () => {
    const { link, pc, signals } = harness("initiator");
    await link.start();
    expect(pc().channels.map((c) => c.label)).toEqual(["poof-ctl", "poof-files"]);
    // Candidates trickle out after setLocalDescription, as in a real browser.
    expect(signals.filter((s) => s.kind === "offer")).toEqual([
      { kind: "offer", sdp: "fake-offer:pc1" },
    ]);
  });

  it("responder does nothing on start() and answers an incoming offer", async () => {
    const { link, signals, pc } = harness("responder");
    await link.start();
    expect(signals).toEqual([]);
    await link.handleSignal({ kind: "offer", sdp: "fake-offer:pc9" });
    expect(pc().remoteDescription).toEqual({ type: "offer", sdp: "fake-offer:pc9" });
    expect(signals.some((s) => s.kind === "answer")).toBe(true);
  });

  it("passes the ICE servers to the RTCPeerConnection", () => {
    const { net } = harness("initiator");
    expect(net.iceServersSeen).toEqual([[{ urls: "stun:x" }]]);
  });

  it("ignores an offer if it's the initiator and an answer if it's the responder", async () => {
    const i = harness("initiator");
    await i.link.start();
    const before = i.signals.length;
    await i.link.handleSignal({ kind: "offer", sdp: "x" });
    expect(i.signals).toHaveLength(before);

    const r = harness("responder");
    await r.link.handleSignal({ kind: "answer", sdp: "x" });
    expect(r.pc().remoteDescription).toBeNull();
  });

  it("opens both channels on both ends and reports them", async () => {
    const { a, b } = await connectedPair();
    expect([...a.opened].sort()).toEqual(["ctl", "files"]);
    expect([...b.opened].sort()).toEqual(["ctl", "files"]);
    expect(a.link.channelOpen("ctl")).toBe(true);
    expect(b.link.channelOpen("files")).toBe(true);
  });

  it("emits local candidates as signals and reports gathered types when gathering ends", async () => {
    const { a } = await connectedPair();
    const candidates = a.signals.filter((s) => s.kind === "candidate");
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0]).toMatchObject({
      kind: "candidate",
      candidate: { candidate: expect.stringContaining("typ host"), sdpMid: "0", sdpMLineIndex: 0 },
    });
    expect(a.gathered).toHaveLength(1);
    expect([...a.gathered[0]!]).toEqual(["host"]);
  });
});

describe("PeerLink ICE candidates", () => {
  it("queues candidates that arrive before the remote description and flushes them after", async () => {
    const { link, pc } = harness("responder");
    const cand = (n: number): SignalPayload => ({
      kind: "candidate",
      candidate: { candidate: `candidate:${n}` },
    });
    await link.handleSignal(cand(1));
    await link.handleSignal(cand(2));
    expect(pc().addedCandidates).toEqual([]);

    await link.handleSignal({ kind: "offer", sdp: "fake-offer:pc9" });
    expect(pc().addedCandidates).toEqual(["candidate:1", "candidate:2"]);

    await link.handleSignal(cand(3)); // after: added immediately
    expect(pc().addedCandidates).toEqual(["candidate:1", "candidate:2", "candidate:3"]);
  });

  it("a rejected candidate doesn't tear the connection down", async () => {
    const { link, pc, failed } = harness("responder");
    await link.handleSignal({ kind: "offer", sdp: "fake-offer:pc9" });
    vi.spyOn(pc(), "addIceCandidate").mockRejectedValue(new Error("stale"));
    await link.handleSignal({ kind: "candidate", candidate: { candidate: "candidate:x" } });
    expect(failed()).toBe(0);
  });

  it("a failing offer/answer negotiation reports failure", async () => {
    const { link, pc, failed } = harness("responder");
    vi.spyOn(pc(), "setRemoteDescription").mockRejectedValue(new Error("bad sdp"));
    await link.handleSignal({ kind: "offer", sdp: "garbage" });
    expect(failed()).toBe(1);
  });
});

describe("PeerLink data", () => {
  it("delivers strings as strings and binary as Uint8Array, per channel", async () => {
    const { a, b } = await connectedPair();
    a.link.send("ctl", "hello");
    a.link.send("files", new Uint8Array([1, 2, 3]));
    await waitFor(() => b.messages.length === 2, "messages");
    expect(b.messages[0]).toEqual({ channel: "ctl", data: "hello" });
    expect(b.messages[1]!.channel).toBe("files");
    expect(b.messages[1]!.data).toBeInstanceOf(Uint8Array);
    expect(Array.from(b.messages[1]!.data as Uint8Array)).toEqual([1, 2, 3]);
  });

  it("sets binaryType to arraybuffer on every channel", async () => {
    const { net } = await connectedPair();
    for (const pc of net.connections) {
      for (const channel of pc.channels) expect(channel.binaryType).toBe("arraybuffer");
    }
  });

  it("send() throws when the channel isn't open", async () => {
    const { link } = harness("initiator");
    await link.start();
    expect(() => link.send("ctl", "x")).toThrow();
    expect(link.channelOpen("ctl")).toBe(false);
  });

  it("exposes the buffered amount for backpressure", async () => {
    const { a } = await connectedPair();
    expect(a.link.buffered("files")).toBe(0);
    expect(harness("responder").link.buffered("ctl")).toBe(0); // no channel yet
  });

  it("whenDrained() waits for bufferedamountlow at the given threshold", async () => {
    const { a, net } = await connectedPair();
    const files = net.connections[0]!.channels.find((c) => c.label === "poof-files")!;
    await a.link.whenDrained("files", 100); // already empty: resolves at once

    files.bufferedAmount = 500;
    let drained = 0;
    const waits = [a.link.whenDrained("files", 100), a.link.whenDrained("files", 100)];
    for (const w of waits) void w.then(() => drained++);
    await tick();
    expect(drained).toBe(0);
    expect(files.bufferedAmountLowThreshold).toBe(100);
    files.bufferedAmount = 50;
    files.onbufferedamountlow?.();
    await Promise.all(waits);
    expect(drained).toBe(2);
  });

  it("whenDrained() rejects when the link closes or fails, and when there's no channel", async () => {
    const { a, b, net } = await connectedPair();
    for (const pc of net.connections) for (const c of pc.channels) c.bufferedAmount = 500;
    const closing = a.link.whenDrained("files", 0);
    a.link.close();
    await expect(closing).rejects.toThrow();
    await expect(a.link.whenDrained("files", 0)).rejects.toThrow();

    const failing = b.link.whenDrained("files", 0);
    net.connections[1]!.connectionState = "failed";
    net.connections[1]!.onconnectionstatechange?.();
    await expect(failing).rejects.toThrow();

    await expect(harness("responder").link.whenDrained("files", 0)).rejects.toThrow();
  });
});

describe("PeerLink connection type", () => {
  const cases: Array<[string, FakeStats, ConnectionType]> = [
    ["both host", { localType: "host", remoteType: "host" }, "direct"],
    ["srflx/srflx", { localType: "srflx", remoteType: "srflx" }, "direct"],
    ["prflx/host", { localType: "prflx", remoteType: "host" }, "direct"],
    ["local relay", { localType: "relay", remoteType: "host" }, "relay"],
    [
      "remote relay (only the remote side relays)",
      { localType: "host", remoteType: "relay" },
      "relay",
    ],
    ["srflx/relay", { localType: "srflx", remoteType: "relay" }, "relay"],
    ["both relay", { localType: "relay", remoteType: "relay" }, "relay"],
    [
      "nominated-pair fallback (direct)",
      { localType: "host", remoteType: "host", nominatedFallback: true },
      "direct",
    ],
    [
      "nominated-pair fallback (relay)",
      { localType: "relay", remoteType: "host", nominatedFallback: true },
      "relay",
    ],
    [
      "no active pair → conservative relay",
      { localType: "host", remoteType: "host", noPair: true },
      "relay",
    ],
    [
      "stats throw → conservative relay",
      { localType: "host", remoteType: "host", throws: true },
      "relay",
    ],
  ];

  it.each(cases)("%s → %s", async (_name, stats, expected) => {
    const { link, net } = harness("initiator");
    net.stats = stats;
    expect(await link.detectConnectionType()).toBe(expected);
  });
});

describe("PeerLink failure and close", () => {
  it("reports failure once when the connection fails", async () => {
    const { a } = await connectedPair();
    const pc = a.net.connections[0]!;
    pc.connectionState = "failed";
    pc.onconnectionstatechange?.();
    pc.onconnectionstatechange?.();
    expect(a.failed()).toBe(1);
  });

  it("ignores a transient 'disconnected' state", async () => {
    const { a } = await connectedPair();
    const pc = a.net.connections[0]!;
    pc.connectionState = "disconnected";
    pc.onconnectionstatechange?.();
    expect(a.failed()).toBe(0);
  });

  it("reports failure when the peer's channel closes", async () => {
    const { a, b } = await connectedPair();
    b.link.close();
    await waitFor(() => a.failed() === 1, "failure after peer closed");
  });

  it("close() is silent: no callbacks fire after it, and it's idempotent", async () => {
    const { a, b } = await connectedPair();
    a.link.close();
    a.link.close();
    await tick();
    await tick();
    expect(a.failed()).toBe(0);
    expect(a.net.connections[0]!.closed).toBe(true);
    expect(b.failed()).toBe(1); // the other side does notice
    // Late signals and sends after close are harmless.
    await a.link.handleSignal({ kind: "candidate", candidate: { candidate: "c" } });
    expect(() => a.link.send("ctl", "x")).toThrow();
  });

  it("restartIce() re-offers with iceRestart on the initiator only", async () => {
    const { a, b } = await connectedPair();
    const offers = (list: SignalPayload[]) => list.filter((s) => s.kind === "offer");
    expect(offers(a.signals)).toHaveLength(1);
    await a.link.restartIce();
    expect(offers(a.signals)).toHaveLength(2);
    expect(offers(a.signals).at(-1)).toEqual({ kind: "offer", sdp: "fake-offer:pc1:restart" });
    await b.link.restartIce();
    expect(offers(b.signals)).toHaveLength(0);
  });
});
