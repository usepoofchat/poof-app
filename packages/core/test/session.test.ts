import { CloseCode, PROTOCOL_VERSION, Channel, FrameType } from "@poof/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FrameCodec } from "../src/index.ts";
import {
  PoofError,
  RoomSession,
  generateRoomKey,
  encodeRoomKey,
  utf8,
  type LogCode,
  type SessionDeps,
  type SessionState,
  type SessionStatus,
} from "../src/index.ts";
import type { FakeDataChannel } from "./fakes.ts";
import { FakeRoomServer, FakeRtcNetwork, FakeSocket, tick, waitFor } from "./fakes.ts";

const ROOM = "AAAAAAAAAAAAAAAAAAAAAA";
const ALICE = "alice".padEnd(22, "_");
const BOB = "bobby".padEnd(22, "_");
const CAROL = "carol".padEnd(22, "_");
const ORIGIN = "https://poof.test";

function world(server = new FakeRoomServer()) {
  server.createRoom(ROOM);
  const net = new FakeRtcNetwork();
  const key = generateRoomKey();
  // Alice created the room in every test: only her session holds the owner secret.
  const make = (peerId: string, overrides: Partial<SessionDeps> = {}) =>
    new RoomSession({
      roomId: ROOM,
      roomKey: key,
      origin: ORIGIN,
      fetch: server.fetch,
      createSocket: server.createSocket,
      createPeerConnection: net.factory,
      peerId,
      pqTimeoutMs: 1500,
      ...(peerId === ALICE ? { ownerSecret: FakeRoomServer.OWNER_SECRET } : {}),
      ...overrides,
    });
  return { server, net, key, make };
}

const status = (s: RoomSession): SessionStatus => s.getState().status;
const until = (s: RoomSession, st: SessionStatus) =>
  waitFor(() => status(s) === st, `status ${st} (is ${status(s)})`);

/** Alice (creator, initiator) and Bob (joiner) both reach "sealed". */
async function connectPair(w: ReturnType<typeof world>) {
  const alice = w.make(ALICE);
  const bob = w.make(BOB);
  await alice.start();
  await until(alice, "waiting");
  await bob.start();
  await until(alice, "sealed");
  await until(bob, "sealed");
  return { alice, bob };
}

const codes = (s: RoomSession): LogCode[] => s.getState().log.map((l) => l.code);
const texts = (s: RoomSession) =>
  s
    .getState()
    .messages.map((m) =>
      m.kind === "text" ? m.text : m.kind === "file" ? `[file ${m.name}]` : `[${m.event}]`,
    );

describe("happy path", () => {
  it("two peers connect, upgrade and chat both ways", async () => {
    const w = world();
    const { alice, bob } = await connectPair(w);

    expect(alice.getState()).toMatchObject({
      status: "sealed",
      role: "initiator",
      peerPresent: true,
      connectionType: "direct",
      plan: "free",
      tier: "free",
      error: null,
      endReason: null,
    });
    expect(bob.getState()).toMatchObject({
      status: "sealed",
      role: "responder",
      connectionType: "direct",
    });

    await alice.sendMessage("hello bob");
    await waitFor(() => texts(bob).length === 1, "bob receives");
    await bob.sendMessage("hello alice");
    await waitFor(() => texts(alice).length === 2, "alice receives");
    expect(texts(alice)).toEqual(["hello bob", "hello alice"]);
    expect(texts(bob)).toEqual(["hello bob", "hello alice"]);

    const [a0, a1] = alice.getState().messages;
    expect(a0).toMatchObject({ kind: "text", mine: true, status: "sent" });
    expect(a1).toMatchObject({ kind: "text", mine: false, status: "received" });
  });

  it("preserves the order of many rapid messages", async () => {
    const w = world();
    const { alice, bob } = await connectPair(w);
    await Promise.all(Array.from({ length: 25 }, (_, n) => alice.sendMessage(`m${n}`)));
    await waitFor(() => texts(bob).length === 25, "25 messages");
    expect(texts(bob)).toEqual(Array.from({ length: 25 }, (_, n) => `m${n}`));
  });

  it("logs the connection milestones in order, as data (not copy)", async () => {
    const w = world();
    const { alice, bob } = await connectPair(w);
    const expected: LogCode[] = [
      "key.loaded",
      "signaling.connected",
      "room.waiting",
      "peer.joined",
      "dc.open",
      "pq.start",
      "pq.verify",
      "pq.done",
    ];
    for (const s of [alice, bob]) {
      const seen = codes(s);
      let cursor = -1;
      for (const code of expected) {
        const at = seen.indexOf(code, cursor + 1);
        expect(at, `${code} after position ${cursor} in ${seen.join(",")}`).toBeGreaterThan(cursor);
        cursor = at;
      }
      expect(seen).toContain("path.direct");
      expect(seen).toContain("ice.candidates");
    }
    const entry = alice.getState().log.find((l) => l.code === "peer.joined");
    expect(entry).toMatchObject({ level: "info", data: { role: "initiator" } });
  });

  it("nothing readable crosses the DataChannel: only ML-KEM messages and ciphertext", async () => {
    const w = world();
    const { alice, bob } = await connectPair(w);
    await alice.sendMessage("TOP-SECRET-PLAINTEXT");
    await bob.sendMessage("ANOTHER-SECRET");
    await waitFor(() => texts(alice).length === 2, "messages");

    const wire = w.net.connections.flatMap((pc) => pc.channels.flatMap((c) => c.wire));
    const asText = (d: string | Uint8Array) =>
      typeof d === "string" ? d : new TextDecoder("latin1").decode(d);
    for (const data of wire) {
      expect(asText(data)).not.toContain("SECRET");
    }
    const strings = wire.filter((d): d is string => typeof d === "string");
    expect(strings).toHaveLength(3); // pq.hello, pq.reply, pq.confirm: the only plaintext JSON
    expect(strings.map((s) => (JSON.parse(s) as { t: string }).t).sort()).toEqual([
      "pq.confirm",
      "pq.hello",
      "pq.reply",
    ]);
    expect(wire.some((d) => d instanceof Uint8Array)).toBe(true);
  });

  it("the room key never reaches the server: not in any URL or socket", async () => {
    const w = world();
    const { alice, bob } = await connectPair(w);
    await alice.sendMessage("x");
    await waitFor(() => texts(bob).length === 1, "message");
    const key = encodeRoomKey(w.key);
    expect(w.server.fetchCalls.join(" ")).not.toContain(key);
    for (const socket of w.server.sockets) {
      expect(socket.url).not.toContain(key);
      expect(socket.sent.join(" ")).not.toContain(key);
    }
    expect(alice.getState().inviteUrl).toBe(`${ORIGIN}/join/#${ROOM}.${key}`);
  });

  it("puts the web app's origin in the invite link when the API lives elsewhere", () => {
    const w = world();
    const alice = w.make(ALICE, { appOrigin: "https://app.test" });
    expect(alice.getState().inviteUrl).toBe(
      `https://app.test/join/#${ROOM}.${encodeRoomKey(w.key)}`,
    );
  });

  it("connects through a relay and shows 'relay' on both sides when only one detects it", async () => {
    const w = world();
    w.net.statsResolver = (pc) =>
      pc.id === "pc1"
        ? { localType: "relay", remoteType: "host" }
        : { localType: "host", remoteType: "host" };
    const { alice, bob } = await connectPair(w);
    await waitFor(
      () =>
        alice.getState().connectionType === "relay" && bob.getState().connectionType === "relay",
      "both show relay",
    );
    expect(codes(bob)).toContain("path.relay");
  });
});

describe("state & subscriptions", () => {
  it("every change produces a new immutable state object; getState is stable in between", async () => {
    const w = world();
    const alice = w.make(ALICE);
    const seen: SessionState[] = [];
    alice.subscribe((s) => seen.push(s));
    const initial = alice.getState();
    expect(initial.status).toBe("loading");
    expect(alice.getState()).toBe(initial);

    await alice.start();
    await until(alice, "waiting");
    expect(seen.length).toBeGreaterThan(2);
    expect(new Set(seen).size).toBe(seen.length); // never the same object twice
    expect(seen.at(-1)).toBe(alice.getState());
    expect(initial.status).toBe("loading"); // old snapshots are untouched
    expect(initial.log).toHaveLength(0);
    const settled = alice.getState();
    await tick();
    expect(alice.getState()).toBe(settled);
  });

  it("unsubscribe stops notifications", async () => {
    const w = world();
    const alice = w.make(ALICE);
    const listener = vi.fn();
    const off = alice.subscribe(listener);
    off();
    await alice.start();
    await until(alice, "waiting");
    expect(listener).not.toHaveBeenCalled();
  });

  it("converts the server's deadline into the local clock (server clock 10 min ahead)", async () => {
    const w = world();
    w.server.clockSkewMs = 600_000;
    const alice = w.make(ALICE);
    await alice.start();
    await until(alice, "waiting");
    const roomExpiry = w.server.rooms.get(ROOM)!.expiresAt; // in the local clock
    expect(Math.abs(alice.getState().expiresAt! - roomExpiry)).toBeLessThan(50);
    const remaining = alice.getState().expiresAt! - Date.now();
    expect(remaining).toBeGreaterThan(290_000);
    expect(remaining).toBeLessThanOrEqual(300_000);
  });

  it("exposes plan, tier and limits from the server", async () => {
    const w = world();
    const room = w.server.rooms.get(ROOM)!;
    room.plan = "super";
    room.tier = "60m";
    const alice = w.make(ALICE);
    await alice.start();
    await until(alice, "waiting");
    expect(alice.getState()).toMatchObject({
      plan: "super",
      tier: "60m",
      limits: { fileTransfer: true, fileMaxBytes: 2_097_152 },
    });
  });

  it("builds the WebSocket URL from the origin (wss for https, ws for http) with the peerId", async () => {
    const w = world();
    await w.make(ALICE).start();
    await waitFor(() => w.server.sockets.length === 1, "socket");
    expect(w.server.sockets[0]!.url).toBe(`wss://poof.test/ws/rooms/${ROOM}?peerId=${ALICE}`);

    const w2 = world();
    await w2.make(BOB, { origin: "http://localhost:8787" }).start();
    await waitFor(() => w2.server.sockets.length === 1, "socket");
    expect(w2.server.sockets[0]!.url).toBe(`ws://localhost:8787/ws/rooms/${ROOM}?peerId=${BOB}`);
  });

  it("generates a random 22-char peerId when none is given", async () => {
    const w = world();
    const a = new RoomSession(baseDeps(w));
    const b = new RoomSession(baseDeps(w));
    await Promise.all([a.start(), b.start()]);
    await waitFor(() => w.server.sockets.length === 2, "sockets");
    const ids = w.server.sockets.map((s) => new URL(s.url).searchParams.get("peerId")!);
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });
});

function baseDeps(w: ReturnType<typeof world>): SessionDeps {
  return {
    roomId: ROOM,
    roomKey: w.key,
    origin: ORIGIN,
    fetch: w.server.fetch,
    createSocket: w.server.createSocket,
    createPeerConnection: w.net.factory,
  };
}

describe("loading errors", () => {
  it("room not found", async () => {
    const w = world();
    w.server.rooms.delete(ROOM);
    const s = w.make(ALICE);
    await s.start();
    expect(s.getState()).toMatchObject({ status: "error", error: { code: "room_not_found" } });
    expect(w.server.sockets).toHaveLength(0); // never even opens a socket
  });

  it.each([
    ["rate limited", () => new Response("{}", { status: 429 }), "rate_limited"],
    ["server error", () => new Response("{}", { status: 500 }), "connection_failed"],
    ["not json", () => new Response("<html>", { status: 200 }), "connection_failed"],
    ["wrong shape", () => Response.json({ roomId: "x" }), "connection_failed"],
  ])("%s", async (_name, response, code) => {
    const w = world();
    w.server.nextRoomResponse = response;
    const s = w.make(ALICE);
    await s.start();
    expect(s.getState()).toMatchObject({ status: "error", error: { code } });
  });

  it("network failure", async () => {
    const w = world();
    const s = w.make(ALICE, {
      fetch: () => Promise.reject(new TypeError("offline")),
    });
    await s.start();
    expect(s.getState()).toMatchObject({ status: "error", error: { code: "connection_failed" } });
  });

  it("a third person gets room_full", async () => {
    const w = world();
    await connectPair(w);
    const carol = w.make(CAROL);
    await carol.start();
    await until(carol, "error");
    expect(carol.getState().error?.code).toBe("room_full");
  });

  it("a third person gets room_full from the message alone when the close frame never arrives", async () => {
    const w = world();
    await connectPair(w);
    w.server.loseRejectCloseFrames = true;
    const carol = w.make(CAROL);
    await carol.start();
    await until(carol, "error");
    expect(carol.getState().error?.code).toBe("room_full");
    // The engine closed its own socket instead of waiting for the server's close.
    const [socket] = w.server.socketsFor(CAROL);
    expect(socket?.readyState).toBe(3);
  });

  it("gives up with connection_failed if the signaling server never lets us in (no endless spinner)", async () => {
    const w = world();
    const dead = () => {
      // A socket that never opens and then closes abnormally, over and over.
      const s = new FakeSocket("wss://poof.test/ws");
      setTimeout(() => s.serverClose(1006), 5);
      return s;
    };
    const s = w.make(ALICE, {
      createSocket: dead,
      joinTimeoutMs: 120,
      signaling: { backoffMs: [10] },
    });
    await s.start();
    await until(s, "error");
    expect(s.getState().error?.code).toBe("connection_failed");
  });

  it("the join timeout is cancelled once the room welcomes us", async () => {
    const w = world();
    const s = w.make(ALICE, { joinTimeoutMs: 100 });
    await s.start();
    await until(s, "waiting");
    await new Promise((r) => setTimeout(r, 250));
    expect(status(s)).toBe("waiting");
  });

  it("start() twice is harmless", async () => {
    const w = world();
    const s = w.make(ALICE);
    await Promise.all([s.start(), s.start()]);
    await s.start();
    await until(s, "waiting");
    expect(w.server.sockets).toHaveLength(1);
  });

  it("an expired room is reported as not found", async () => {
    const w = world();
    w.server.rooms.get(ROOM)!.expiresAt = Date.now() - 1;
    const s = w.make(ALICE);
    await s.start();
    expect(s.getState().error?.code).toBe("room_not_found");
  });
});

describe("waiting room", () => {
  it("waits alone with no peer", async () => {
    const w = world();
    const alice = w.make(ALICE);
    await alice.start();
    await until(alice, "waiting");
    expect(alice.getState()).toMatchObject({
      peerPresent: false,
      role: null,
      connectionType: null,
    });
    expect(w.net.connections).toHaveLength(0);
  });

  it("goes back to waiting if the joiner leaves before the connection is up", async () => {
    const w = world();
    w.net.holdNegotiation = true; // channels never open: stays in "connecting"
    const alice = w.make(ALICE);
    const bob = w.make(BOB);
    await alice.start();
    await until(alice, "waiting");
    await bob.start();
    await until(alice, "connecting");
    expect(alice.getState().peerPresent).toBe(true);

    w.server.drop(ROOM, BOB, "closed");
    await until(alice, "waiting");
    expect(alice.getState()).toMatchObject({ peerPresent: false, role: null });
    expect(w.net.connections[0]!.closed).toBe(true);
    expect(codes(alice)).toContain("peer.left");
  });

  it("a repeated `paired` while negotiating restarts the WebRTC attempt (reconnecting peer)", async () => {
    const w = world();
    w.net.holdNegotiation = true;
    const alice = w.make(ALICE);
    await alice.start();
    await until(alice, "waiting");
    await w.make(BOB).start();
    await until(alice, "connecting");
    expect(w.net.connections).toHaveLength(2); // alice's + bob's

    const socket = w.server.socketsFor(ALICE).at(-1)!;
    socket.serverSend(
      JSON.stringify({
        v: PROTOCOL_VERSION,
        t: "paired",
        role: "initiator",
        peerId: BOB,
        iceServers: [{ urls: "stun:z" }],
      }),
    );
    expect(w.net.connections).toHaveLength(3);
    expect(w.net.connections[0]!.closed).toBe(true); // old attempt discarded
    expect(w.net.iceServersSeen.at(-1)).toEqual([{ urls: "stun:z" }]);
  });
});

describe("zombie sockets", () => {
  it("a creator whose socket died silently reconnects with the same peerId and still pairs", async () => {
    const w = world();
    const alice = w.make(ALICE, {
      signaling: { pingIntervalMs: 40, pongTimeoutMs: 40, backoffMs: [10] },
    });
    await alice.start();
    await until(alice, "waiting");
    const zombie = w.server.socketsFor(ALICE)[0]!;
    zombie.zombie = true; // phone locked: no traffic, no close event

    await waitFor(() => w.server.socketsFor(ALICE).length === 2, "alice reconnects");
    expect(codes(alice)).toContain("signaling.reconnecting");

    // Bob arrives: the room must NOT think alice is already there twice.
    const bob = w.make(BOB);
    await bob.start();
    await until(alice, "sealed");
    await until(bob, "sealed");
    await alice.sendMessage("still here");
    await waitFor(() => texts(bob).length === 1, "message");
  });

  it("if the joiner paired with the zombie first, the reconnecting creator re-pairs both", async () => {
    const w = world();
    const alice = w.make(ALICE, {
      signaling: { pingIntervalMs: 60, pongTimeoutMs: 60, backoffMs: [10] },
    });
    await alice.start();
    await until(alice, "waiting");
    w.server.socketsFor(ALICE)[0]!.zombie = true;

    const bob = w.make(BOB);
    await bob.start();
    await until(bob, "connecting"); // bob was paired with alice's dead socket
    await until(alice, "sealed"); // alice reconnected, got re-paired, and finished the handshake
    await until(bob, "sealed");
  });

  it("a duplicate tab with the same peerId replaces the first, which ends as 'replaced'", async () => {
    const w = world();
    const first = w.make(ALICE);
    await first.start();
    await until(first, "waiting");
    const second = w.make(ALICE);
    await second.start();
    await until(first, "terminated");
    expect(first.getState().endReason).toBe("replaced");
    await until(second, "waiting");
  });

  it("a repeated `paired` once the channel is being upgraded or live is ignored", async () => {
    const w = world();
    const { alice } = await connectPair(w);
    const before = w.net.connections.length;
    w.server
      .socketsFor(ALICE)
      .at(-1)!
      .serverSend(
        JSON.stringify({
          v: PROTOCOL_VERSION,
          t: "paired",
          role: "initiator",
          peerId: BOB,
          iceServers: [],
        }),
      );
    await tick();
    expect(w.net.connections).toHaveLength(before);
    expect(status(alice)).toBe("sealed");
  });
});

describe("ending the session", () => {
  it("peer closes abruptly: terminated, conversation wiped, link closed", async () => {
    const w = world();
    const { alice, bob } = await connectPair(w);
    await alice.sendMessage("private");
    await waitFor(() => texts(bob).length === 1, "message");

    w.server.drop(ROOM, ALICE, "closed"); // alice's socket vanished
    await until(bob, "terminated");
    expect(bob.getState()).toMatchObject({
      endReason: "peer_left",
      messages: [],
      peerPresent: false,
    });
    expect(w.net.connections.every((pc) => pc.closed || pc === w.net.connections[0])).toBe(true);
    await expect(bob.sendMessage("late")).rejects.toMatchObject({ code: "not_connected" });
  });

  it("leave() tells the peer (bye frame) and wipes both sides", async () => {
    const w = world();
    const { alice, bob } = await connectPair(w);
    await bob.sendMessage("bye soon");
    await waitFor(() => texts(alice).length === 1, "message");

    await bob.leave();
    expect(bob.getState()).toMatchObject({
      status: "terminated",
      endReason: "left_by_me",
      messages: [],
    });
    await until(alice, "terminated");
    expect(alice.getState()).toMatchObject({ endReason: "peer_left", messages: [] });
  });

  it("destroy() ends the room for both and removes it from the server", async () => {
    const w = world();
    const { alice, bob } = await connectPair(w);
    await alice.destroy();
    expect(alice.getState()).toMatchObject({
      status: "terminated",
      endReason: "destroyed_by_me",
      messages: [],
    });
    await until(bob, "terminated");
    expect(bob.getState().endReason).toBe("destroyed_by_peer");
    expect(w.server.rooms.has(ROOM)).toBe(false);
  });

  it("only the creator may destroy: the joiner gets not_owner and nothing ends", async () => {
    const w = world();
    const { alice, bob } = await connectPair(w);
    expect(alice.getState().isOwner).toBe(true);
    expect(bob.getState().isOwner).toBe(false);

    await expect(bob.destroy()).rejects.toMatchObject({ code: "not_owner" });
    expect(bob.getState().status).toBe("sealed");
    expect(alice.getState().status).toBe("sealed");
    expect(w.server.rooms.has(ROOM)).toBe(true);
    // Nothing was even sent.
    const sent = w.server.socketsFor(BOB).flatMap((s) => s.sent);
    expect(sent.some((m) => m.includes('"destroy"'))).toBe(false);
  });

  it("a wrong owner secret is refused by the server and the room survives", async () => {
    const w = world();
    const alice = w.make(ALICE, { ownerSecret: "x".repeat(43) });
    const bob = w.make(BOB);
    await alice.start();
    await until(alice, "waiting");
    await bob.start();
    await until(bob, "sealed");
    await alice.destroy();
    // Locally Alice is out (she asked to end it), but the server kept the room for Bob.
    expect(alice.getState().status).toBe("terminated");
    await new Promise((r) => setTimeout(r, 20));
    expect(w.server.rooms.has(ROOM)).toBe(true);
  });

  it("destroying from the waiting room works too", async () => {
    const w = world();
    const alice = w.make(ALICE);
    await alice.start();
    await until(alice, "waiting");
    await alice.destroy();
    expect(alice.getState().endReason).toBe("destroyed_by_me");
    expect(w.server.rooms.has(ROOM)).toBe(false);
  });

  it("an ICE failure after connecting ends as connection_lost, after the grace period", async () => {
    const w = world();
    const alice = w.make(ALICE, { linkLossGraceMs: 80 });
    const bob = w.make(BOB);
    await alice.start();
    await until(alice, "waiting");
    await bob.start();
    await until(alice, "sealed");

    const pc = w.net.connections[0]!;
    pc.connectionState = "failed";
    pc.onconnectionstatechange?.();
    expect(status(alice)).toBe("sealed"); // waiting for the server to explain
    await until(alice, "terminated");
    expect(alice.getState()).toMatchObject({ endReason: "connection_lost", messages: [] });
    expect(codes(alice)).toContain("conn.failed");
  });

  it("if the server explains within the grace period, that reason wins over connection_lost", async () => {
    const w = world();
    const { alice, bob } = await connectPair(w);
    // The peer's side of the data channel dies first...
    w.net.connections[0]!.channels[0]!.close();
    expect(status(bob)).toBe("sealed");
    // ...then the room is destroyed by the peer: the engine reports the real reason.
    w.server.destroy(ROOM, ALICE);
    await until(bob, "terminated");
    expect(bob.getState().endReason).toBe("destroyed_by_peer");
    void alice;
  });

  it("is idempotent: further actions after the end do nothing", async () => {
    const w = world();
    const { alice } = await connectPair(w);
    await alice.leave();
    const ended = alice.getState();
    await alice.leave();
    await alice.destroy();
    expect(alice.getState()).toBe(ended);
    await expect(alice.sendMessage("x")).rejects.toBeInstanceOf(PoofError);
  });

  it("leaving before start() ends it cleanly and start() then does nothing", async () => {
    const w = world();
    const s = w.make(ALICE);
    await s.leave();
    expect(s.getState().status).toBe("terminated");
    await s.start();
    expect(s.getState().status).toBe("terminated");
    expect(w.server.sockets).toHaveLength(0);
  });

  it("leaving while the room is still loading cancels the join", async () => {
    const w = world();
    let release: (r: Response) => void = () => undefined;
    w.server.nextRoomResponse = () => new Promise<Response>((resolve) => (release = resolve));
    const s = w.make(ALICE);
    const started = s.start();
    await s.leave();
    release(Response.json({ error: { code: "x", message: "y" } }, { status: 500 }));
    await started;
    expect(s.getState().status).toBe("terminated");
    expect(w.server.sockets).toHaveLength(0);
  });
});

describe("expiry", () => {
  it("the server's room.expired closes the P2P link but keeps the readable transcript", async () => {
    const w = world();
    const { alice, bob } = await connectPair(w);
    await alice.sendMessage("before the end");
    await waitFor(() => texts(bob).length === 1, "message");

    w.server.expire(ROOM);
    await until(alice, "expired");
    await until(bob, "expired");
    expect(bob.getState()).toMatchObject({ error: null, peerPresent: false });
    expect(texts(bob)).toEqual(["before the end"]); // kept
    expect(w.net.connections.every((pc) => pc.closed)).toBe(true); // P2P really closed
    await expect(bob.sendMessage("too late")).rejects.toMatchObject({ code: "not_connected" });
  });

  it("when the room ends, both browsers tear down WebRTC at once: still reported as expired, not lost", async () => {
    const w = world();
    const { alice, bob } = await connectPair(w);
    // Worst case ordering: bob's data channel closes BEFORE his room.expired message arrives.
    w.net.connections[0]!.close();
    await tick();
    w.server.expire(ROOM);
    await until(bob, "expired");
    expect(bob.getState().error).toBeNull();
    void alice;
  });

  it("closing with the 'expired' code is enough, even without the event", async () => {
    const w = world();
    const alice = w.make(ALICE);
    await alice.start();
    await until(alice, "waiting");
    w.server.socketsFor(ALICE)[0]!.serverClose(CloseCode.RoomExpired, "room_expired");
    await until(alice, "expired");
  });
});

describe("expiry safety net (fake timers)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Drive fake time forward while letting the async fakes settle. */
  const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

  async function connectWithFakeTime() {
    // Fake only timers and Date; WebCrypto still completes on the real event loop, so we alternate
    // advancing fake time with letting real I/O settle.
    vi.useFakeTimers({
      now: 1_000_000,
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
    });
    const w = world();
    const deps = { pqTimeoutMs: 600_000, signaling: { pingIntervalMs: 1e9, pongTimeoutMs: 1e9 } };
    const alice = w.make(ALICE, deps);
    const bob = w.make(BOB, deps);
    const settle = async (done: () => boolean) => {
      for (let i = 0; i < 400 && !done(); i++) {
        await advance(5);
        await new Promise((r) => setImmediate(r));
      }
    };
    await alice.start();
    await settle(() => status(alice) === "waiting");
    await bob.start();
    await settle(() => status(alice) === "sealed" && status(bob) === "sealed");
    expect(status(alice)).toBe("sealed");
    return { w, alice, bob };
  }

  it("reaching 00:00 locally does NOT end the session by itself; only the server's answer does", async () => {
    const { w, alice } = await connectWithFakeTime();
    const deadline = alice.getState().expiresAt!;

    await advance(deadline - Date.now() + 2000); // 2 s past the deadline, inside the grace
    expect(status(alice)).toBe("sealed");

    w.server.rooms.get(ROOM)!.expiresAt = deadline - 1; // the server really considers it over
    await advance(1500); // grace elapsed → safety net asks the server → 404
    expect(status(alice)).toBe("expired");
    expect(w.net.connections.every((pc) => pc.closed)).toBe(true);
  });

  it("if the server says the room was extended, follows the new deadline and stays connected", async () => {
    const { w, alice } = await connectWithFakeTime();
    const room = w.server.rooms.get(ROOM)!;
    const oldDeadline = alice.getState().expiresAt!;
    room.expiresAt += 3_600_000; // e.g. upgraded to a super room while the socket was dead

    await advance(oldDeadline - Date.now() + 3500);
    expect(status(alice)).toBe("sealed");
    expect(alice.getState().expiresAt).toBe(room.expiresAt);
    expect(w.server.fetchCalls.filter((u) => u.endsWith(ROOM)).length).toBeGreaterThanOrEqual(3); // initial ×2 + check
  });

  it("retries when the check itself fails (server unreachable)", async () => {
    const { w, alice } = await connectWithFakeTime();
    const deadline = alice.getState().expiresAt!;
    w.server.rooms.get(ROOM)!.expiresAt += 3_600_000; // the room is alive; only the check will fail
    w.server.nextRoomResponse = () => new Response("{}", { status: 503 });

    await advance(deadline - Date.now() + 3500);
    expect(status(alice)).toBe("sealed"); // a 503 is not "expired"

    w.server.rooms.delete(ROOM); // by the next attempt the room really is gone → 404
    await advance(10_500);
    expect(status(alice)).toBe("expired");
  });
});

describe("room.upgraded", () => {
  it("updates plan, tier, limits and the deadline for the live session", async () => {
    const w = world();
    const { alice } = await connectPair(w);
    const newDeadline = Date.now() + 3_600_000;
    w.server
      .socketsFor(ALICE)
      .at(-1)!
      .serverSend(
        JSON.stringify({
          v: PROTOCOL_VERSION,
          t: "room.upgraded",
          plan: "super",
          tier: "60m",
          expiresAt: newDeadline,
          serverNow: Date.now(),
          limits: { fileTransfer: true, fileMaxBytes: 2_097_152 },
        }),
      );
    expect(alice.getState()).toMatchObject({
      plan: "super",
      tier: "60m",
      limits: { fileTransfer: true, fileMaxBytes: 2_097_152 },
    });
    expect(Math.abs(alice.getState().expiresAt! - newDeadline)).toBeLessThan(100);
    expect(status(alice)).toBe("sealed");
  });
});

describe("connection failures", () => {
  it("ICE failure while negotiating is reported as connection_failed (firewall)", async () => {
    const w = world();
    w.net.holdNegotiation = true;
    const alice = w.make(ALICE);
    await alice.start();
    await until(alice, "waiting");
    await w.make(BOB).start();
    await until(alice, "connecting");

    const pc = w.net.connections[0]!;
    pc.connectionState = "failed";
    pc.onconnectionstatechange?.();
    expect(alice.getState()).toMatchObject({
      status: "error",
      error: { code: "connection_failed" },
      messages: [],
    });
    expect(codes(alice)).toContain("conn.failed");
    expect(pc.closed).toBe(true);
  });

  it("when both sides fail at once, the one that fails second sees its peer leave and goes back to waiting", async () => {
    const w = world();
    w.net.failConnections = true;
    const alice = w.make(ALICE);
    const bob = w.make(BOB);
    await alice.start();
    await until(alice, "waiting");
    await bob.start();
    await until(bob, "error");
    expect(bob.getState().error?.code).toBe("connection_failed");
    await until(alice, "waiting");
    expect(alice.getState().peerPresent).toBe(false);
  });
});

describe("key exchange failures", () => {
  it("peers holding different keys fail with pq_failed, and never get a chat", async () => {
    const w = world();
    const alice = w.make(ALICE);
    const bob = w.make(BOB, { roomKey: generateRoomKey() }); // someone who got the wrong link
    await alice.start();
    await until(alice, "waiting");
    await bob.start();
    await until(alice, "error");
    expect(alice.getState().error?.code).toBe("pq_failed");
    // Alice gave up and left; bob, mid-handshake, sees the peer leave. He never reaches "sealed".
    await until(bob, "terminated");
    expect(bob.getState().messages).toEqual([]);
    expect(codes(bob)).not.toContain("pq.done");
    await expect(alice.sendMessage("x")).rejects.toBeInstanceOf(PoofError);
  });

  it("times out if the other side never answers the handshake", async () => {
    const w = world();
    w.net.channelHook = (channel) => {
      channel.tamper = (data) => (typeof data === "string" ? null : data); // drop all pq messages
    };
    const alice = w.make(ALICE, { pqTimeoutMs: 150 });
    const bob = w.make(BOB, { pqTimeoutMs: 150 });
    await alice.start();
    await until(alice, "waiting");
    await bob.start();
    await until(alice, "error");
    expect(alice.getState().error?.code).toBe("pq_failed");
    expect(alice.getState().error?.message).toMatch(/timed out/i);
  });

  it("rejects malformed handshake messages", async () => {
    const w = world();
    const alice = w.make(ALICE);
    const bob = w.make(BOB);
    w.net.channelHook = (channel: FakeDataChannel, pc) => {
      // Replace the initiator's pq.hello with garbage.
      if (pc.id === "pc1" && channel.label === "poof-ctl")
        channel.tamper = (d) => (typeof d === "string" ? "{not json" : d);
    };
    await alice.start();
    await until(alice, "waiting");
    await bob.start();
    await until(bob, "error");
    expect(bob.getState().error?.code).toBe("pq_failed");
  });
});

describe("wire tampering after the handshake", () => {
  /** Tamper only with what ALICE sends (pc1), and only once everything has settled. */
  async function tamperedPair(mutate: (data: Uint8Array, count: number) => Uint8Array | null) {
    const w = world();
    let armed = false;
    let count = 0;
    w.net.channelHook = (channel, pc) => {
      if (pc.id !== "pc1") return;
      channel.tamper = (data) => {
        if (!armed || typeof data === "string") return data;
        return mutate(data, count++);
      };
    };
    const { alice, bob } = await connectPair(w);
    await new Promise((r) => setTimeout(r, 60)); // let the connection_type frames land
    armed = true;
    return { w, alice, bob };
  }

  it("a flipped ciphertext bit terminates the session (authentication failure)", async () => {
    const { alice, bob } = await tamperedPair((d) => {
      const out = d.slice();
      out[out.length - 1] = out[out.length - 1]! ^ 1;
      return out;
    });
    await alice.sendMessage("hi");
    await until(bob, "terminated");
    expect(bob.getState()).toMatchObject({ endReason: "connection_lost", messages: [] });
    expect(
      bob
        .getState()
        .log.some((l) => l.code === "conn.failed" && l.data?.reason === "decrypt_failed"),
    ).toBe(true);
  });

  it("a dropped frame is detected by the sequence number", async () => {
    const { alice, bob } = await tamperedPair((d, n) => (n === 0 ? null : d));
    await alice.sendMessage("first (dropped)");
    await alice.sendMessage("second");
    await until(bob, "terminated");
    expect(bob.getState().endReason).toBe("connection_lost");
    expect(bob.getState().log.some((l) => l.data?.reason === "frame_out_of_order")).toBe(true);
    expect(texts(bob)).toEqual([]);
  });

  it("a replayed frame is rejected", async () => {
    let captured: Uint8Array | null = null;
    const { alice, bob, w } = await tamperedPair((d, n) => {
      if (n === 0) captured = d.slice();
      return d;
    });
    await alice.sendMessage("original");
    await waitFor(() => texts(bob).length === 1, "original");
    const channel = w.net.connections[1]!.channels.find((c) => c.label === "poof-ctl")!;
    channel.onmessage?.({ data: captured!.slice().buffer }); // attacker re-injects the captured frame
    await until(bob, "terminated");
    expect(bob.getState().endReason).toBe("connection_lost");
  });

  it("a frame reflected back at its sender is rejected (directional keys)", async () => {
    const { alice, bob, w } = await tamperedPair((d) => d);
    await alice.sendMessage("mine");
    await waitFor(() => texts(bob).length === 1, "delivered");
    const aliceCtl = w.net.connections[0]!.channels.find((c) => c.label === "poof-ctl")!;
    const sent = aliceCtl.wire.filter((d): d is Uint8Array => d instanceof Uint8Array).at(-1)!;
    aliceCtl.onmessage?.({ data: sent.slice().buffer }); // bounce alice's own frame back to her
    await until(alice, "terminated");
    expect(alice.getState().endReason).toBe("connection_lost");
  });
});

describe("sending messages", () => {
  it("rejects before the connection is ready", async () => {
    const w = world();
    const alice = w.make(ALICE);
    await expect(alice.sendMessage("x")).rejects.toMatchObject({ code: "not_connected" });
    await alice.start();
    await until(alice, "waiting");
    await expect(alice.sendMessage("x")).rejects.toMatchObject({ code: "not_connected" });
  });

  it("rejects empty or whitespace-only messages", async () => {
    const w = world();
    const { alice } = await connectPair(w);
    await expect(alice.sendMessage("")).rejects.toMatchObject({ code: "invalid_message" });
    await expect(alice.sendMessage("  \n\t ")).rejects.toMatchObject({ code: "invalid_message" });
    await expect(alice.sendMessage("\u0000\u0007")).rejects.toMatchObject({
      code: "invalid_message",
    });
    expect(alice.getState().messages).toEqual([]);
  });

  it("keeps newlines (Shift+Enter), strips control characters, normalises", async () => {
    const w = world();
    const { alice, bob } = await connectPair(w);
    await alice.sendMessage("line1\nline2\u0000\u0007\r\nline3  ");
    await waitFor(() => texts(bob).length === 1, "message");
    expect(texts(bob)[0]).toBe("line1\nline2\nline3");
    expect(texts(alice)[0]).toBe("line1\nline2\nline3"); // what I see is what they got
  });

  it("caps very long messages at 5,000 characters", async () => {
    const w = world();
    const { alice, bob } = await connectPair(w);
    await alice.sendMessage("x".repeat(9000));
    await waitFor(() => texts(bob).length === 1, "message");
    expect(texts(bob)[0]).toHaveLength(5000);
  });

  it("returns the message id used locally", async () => {
    const w = world();
    const { alice } = await connectPair(w);
    const id = await alice.sendMessage("hi");
    expect(alice.getState().messages[0]).toMatchObject({ id });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("markup is just text: nothing is interpreted, nothing is stripped but control characters", async () => {
    const w = world();
    const { alice, bob } = await connectPair(w);
    const payload = '<img src=x onerror=alert(1)> "><script>alert(1)</script> {{7*7}} ${x}';
    await alice.sendMessage(payload);
    await waitFor(() => texts(bob).length === 1, "message");
    expect(texts(bob)[0]).toBe(payload);
  });
});

describe("hostile or malformed peer input", () => {
  /** Seal arbitrary plaintext with Bob's keys and push it into Alice, as a modified client would. */
  /** The codec and raw link of Bob's (only) member link, as a modified client could use them. */
  function internals(bob: RoomSession) {
    const links = (bob as unknown as { links: Map<string, unknown> }).links;
    const member = [...links.values()][0] as {
      codec: FrameCodec;
      link: { send(ch: "ctl" | "files", d: Uint8Array): void };
    };
    return { codec: member.codec, link: member.link };
  }

  async function inject(bob: RoomSession, type: number, plaintext: Uint8Array) {
    const { codec, link } = internals(bob);
    link.send("ctl", await codec.seal(Channel.Ctl, type as never, plaintext));
  }

  it("ignores chat frames whose plaintext is invalid, and keeps working", async () => {
    const w = world();
    const { alice, bob } = await connectPair(w);
    await inject(bob, FrameType.Chat, utf8("not json"));
    await inject(bob, FrameType.Chat, utf8(JSON.stringify({ id: "1", text: "", ts: 1 })));
    await inject(
      bob,
      FrameType.Chat,
      utf8(JSON.stringify({ id: "1", text: "\u0000\u0001", ts: 1 })),
    ); // empties out
    await inject(bob, FrameType.Chat, utf8(JSON.stringify({ text: "no id" })));
    await inject(bob, FrameType.Ctl, utf8(JSON.stringify({ kind: "nuke" })));
    await bob.sendMessage("real one");
    await waitFor(() => texts(alice).length === 1, "real message");
    expect(texts(alice)).toEqual(["real one"]);
    expect(status(alice)).toBe("sealed");
  });

  it("normalises hostile text from a modified peer on receipt", async () => {
    const w = world();
    const { alice, bob } = await connectPair(w);
    await inject(
      bob,
      FrameType.Chat,
      utf8(JSON.stringify({ id: "x", text: "a\u0000b‮ c", ts: 1 })),
    );
    await waitFor(() => texts(alice).length === 1, "message");
    expect(texts(alice)[0]).not.toContain("\u0000");
  });

  it("drops file frames while file transfer isn't enabled, without crashing", async () => {
    const w = world();
    const { alice, bob } = await connectPair(w);
    const { codec, link } = internals(bob);
    link.send("files", await codec.seal(Channel.Files, FrameType.FileMeta, utf8("{}")));
    await tick();
    await tick();
    expect(status(alice)).toBe("sealed");
    expect(alice.getState().messages).toEqual([]);
  });

  it("ignores binary data that arrives before the keys exist", async () => {
    const w = world();
    const alice = w.make(ALICE);
    const bob = w.make(BOB);
    w.net.channelHook = (channel, pc) => {
      if (pc.id === "pc1" && channel.label === "poof-ctl") {
        channel.tamper = (d) => {
          if (typeof d === "string") {
            // Slip a binary frame in front of the pq.hello.
            queueMicrotask(() => channel.other?.onmessage?.({ data: new Uint8Array(40).buffer }));
          }
          return d;
        };
      }
    };
    await alice.start();
    await until(alice, "waiting");
    await bob.start();
    await until(alice, "sealed");
    await until(bob, "sealed");
  });
});
