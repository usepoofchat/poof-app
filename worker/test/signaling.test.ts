import { env } from "cloudflare:workers";
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { CloseCode, type SignalPayload } from "@poof/protocol";
import { describe, expect, it } from "vitest";
import type { RoomMeta } from "../src/room-do.ts";
import { TestSocket, api, createRoom, newOwner, peer } from "./helpers.ts";

const v = 1;
const OFFER: SignalPayload = { kind: "offer", sdp: "v=0\r\n" };

async function twoPeers() {
  const room = await createRoom();
  const a = await TestSocket.connect(room.roomId, peer("alice"));
  await a.next("welcome");
  const b = await TestSocket.connect(room.roomId, peer("bob"));
  await b.next("welcome");
  return { room, a, b };
}

describe("joining", () => {
  it("first peer gets welcome and waits", async () => {
    const room = await createRoom();
    const a = await TestSocket.connect(room.roomId, peer("alice"));
    const welcome = await a.next("welcome");
    expect(welcome).toMatchObject({
      v,
      roomId: room.roomId,
      peerId: peer("alice"),
      plan: "free",
      tier: "free",
      maxPeers: 2,
      peers: 1,
      expiresAt: room.expiresAt,
    });
    expect(Math.abs(welcome.serverNow - Date.now())).toBeLessThan(5000);
    await a.expectNone("paired");
  });

  it("second peer triggers `paired` for both with stable roles", async () => {
    const { a, b } = await twoPeers();
    const pa = await a.next("paired");
    const pb = await b.next("paired");
    expect(pa.role).toBe("initiator");
    expect(pb.role).toBe("responder");
    expect(pa.peerId).toBe(peer("bob"));
    expect(pb.peerId).toBe(peer("alice"));
    // No TURN secrets in tests: degrades to STUN only, never throws.
    expect(pa.iceServers.length).toBeGreaterThan(0);
    expect(pa.iceServers).toEqual(pb.iceServers);
  });

  it("rejects a third peer with room_full", async () => {
    const { room } = await twoPeers();
    const c = await TestSocket.connect(room.roomId, peer("carol"));
    expect(await c.next("rejected")).toEqual({
      v,
      t: "rejected",
      code: CloseCode.RoomFull,
      reason: "room_full",
    });
    expect(await c.waitClosed()).toMatchObject({ code: CloseCode.RoomFull });
    const info = (await (await api(`/api/rooms/${room.roomId}`)).json()) as { peers: number };
    expect(info.peers).toBe(2);
  });

  it("a rejected socket never takes a slot, sees relayed traffic, or announces a departure", async () => {
    const { room, a, b } = await twoPeers();
    await a.next("paired");
    await b.next("paired");
    const carol = await TestSocket.connect(room.roomId, peer("carol"));
    expect(await carol.waitClosed()).toMatchObject({ code: CloseCode.RoomFull });
    await a.expectNone("peer.left");
    await b.expectNone("peer.left");

    a.send({ v, t: "signal", payload: OFFER });
    expect((await b.next("signal")).payload).toEqual(OFFER);
    // Carol got her `rejected` and nothing else.
    expect(carol.messages.map((m) => m.t)).toEqual(["rejected"]);

    // Once a slot frees up, a newcomer gets in.
    b.send({ v, t: "leave" });
    await a.next("peer.left");
    const dave = await TestSocket.connect(room.roomId, peer("dave"));
    await dave.next("welcome");
    expect((await a.next("paired")).peerId).toBe(peer("dave"));
  });

  it("closes with room_not_found for an unknown room", async () => {
    const s = await TestSocket.connect("AAAAAAAAAAAAAAAAAAAAAA", peer("alice"));
    expect(await s.next("rejected")).toMatchObject({
      code: CloseCode.RoomNotFound,
      reason: "room_not_found",
    });
    expect(await s.waitClosed()).toMatchObject({ code: CloseCode.RoomNotFound });
  });

  it("400s on a malformed peerId or room id and on a non-upgrade request", async () => {
    const room = await createRoom();
    const badPeer = await api(`/ws/rooms/${room.roomId}?peerId=short`, {
      headers: { Upgrade: "websocket" },
    });
    expect(badPeer.status).toBe(400);
    const badRoom = await api(`/ws/rooms/nope?peerId=${peer("alice")}`, {
      headers: { Upgrade: "websocket" },
    });
    expect(badRoom.status).toBe(400);
    const plain = await api(`/ws/rooms/${room.roomId}?peerId=${peer("alice")}`);
    expect(plain.status).toBe(426);
  });

  it("rejects cross-origin WebSocket upgrades with a readable close code", async () => {
    const room = await createRoom();
    const s = await TestSocket.connect(room.roomId, peer("alice"), {
      Origin: "https://evil.example",
    });
    expect(await s.next("rejected")).toMatchObject({
      code: CloseCode.ForbiddenOrigin,
      reason: "forbidden_origin",
    });
    expect(await s.waitClosed()).toMatchObject({ code: CloseCode.ForbiddenOrigin });
  });

  it("answers the literal 'ping' with 'pong' without a JSON envelope", async () => {
    const room = await createRoom();
    const a = await TestSocket.connect(room.roomId, peer("alice"));
    await a.next("welcome");
    a.send("ping");
    await new Promise((r) => setTimeout(r, 100));
    expect(a.raw).toContain("pong");
  });
});

describe("zombie sockets (same peerId reconnects)", () => {
  it("replaces the old socket instead of rejecting, even while alone", async () => {
    const room = await createRoom();
    const old = await TestSocket.connect(room.roomId, peer("alice"));
    await old.next("welcome");
    const fresh = await TestSocket.connect(room.roomId, peer("alice"));
    const welcome = await fresh.next("welcome");
    expect(welcome.peers).toBe(1);
    await old.next("replaced"); // an explicit message, not only a close code
    expect(await old.waitClosed()).toMatchObject({ code: CloseCode.Replaced });
    await fresh.expectNone("peer.left");
  });

  it("does not pair a returning peer with its own zombie", async () => {
    const room = await createRoom();
    const zombie = await TestSocket.connect(room.roomId, peer("alice"));
    await zombie.next("welcome");
    const fresh = await TestSocket.connect(room.roomId, peer("alice"));
    await fresh.next("welcome");
    // Still alone: capacity is by distinct peerId.
    await fresh.expectNone("paired");
    const info = (await (await api(`/api/rooms/${room.roomId}`)).json()) as { peers: number };
    expect(info.peers).toBe(1);
  });

  it("re-pairs both peers when a peer reconnects while the other is present, keeping roles", async () => {
    const { room, a, b } = await twoPeers();
    await a.next("paired");
    await b.next("paired");

    const a2 = await TestSocket.connect(room.roomId, peer("alice"));
    await a2.next("welcome");
    const pa = await a2.next("paired");
    const pb = await b.next("paired");
    expect(pa.role).toBe("initiator"); // original joinedAt is kept
    expect(pb.role).toBe("responder");
    expect(pa.peerId).toBe(peer("bob"));
    expect(await a.waitClosed()).toMatchObject({ code: CloseCode.Replaced });
    // The replaced socket is not a departure: the other peer must not be told the peer left.
    await b.expectNone("peer.left");
  });
});

describe("signal relay", () => {
  it("relays to the other peer only, never echoes", async () => {
    const { a, b } = await twoPeers();
    await a.next("paired");
    await b.next("paired");

    a.send({ v, t: "signal", payload: OFFER });
    const got = await b.next("signal");
    expect(got.payload).toEqual(OFFER);
    await a.expectNone("signal");

    const answer: SignalPayload = { kind: "answer", sdp: "v=0\r\nanswer" };
    b.send({ v, t: "signal", payload: answer });
    expect((await a.next("signal")).payload).toEqual(answer);
  });

  it("relays ICE candidates verbatim", async () => {
    const { a, b } = await twoPeers();
    await a.next("paired");
    await b.next("paired");
    const candidate: SignalPayload = {
      kind: "candidate",
      candidate: {
        candidate: "candidate:1 1 udp 2122 10.0.0.1 5000 typ host",
        sdpMid: "0",
        sdpMLineIndex: 0,
      },
    };
    a.send({ v, t: "signal", payload: candidate });
    expect((await b.next("signal")).payload).toEqual(candidate);
  });

  it("refuses to signal when alone", async () => {
    const room = await createRoom();
    const a = await TestSocket.connect(room.roomId, peer("alice"));
    await a.next("welcome");
    a.send({ v, t: "signal", payload: OFFER });
    expect((await a.next("error")).code).toBe("not_paired");
  });

  it("answers a malformed message with an error, then closes on repeat", async () => {
    const { a, b } = await twoPeers();
    await a.next("paired");
    await b.next("paired");
    a.send({ v, t: "bogus" });
    expect((await a.next("error")).code).toBe("protocol_error");
    a.send("not json at all");
    expect((await a.next("error")).code).toBe("protocol_error");
    expect(await a.waitClosed()).toMatchObject({ code: CloseCode.ProtocolError });
    // The other side only sees the departure.
    expect((await b.next("peer.left")).reason).toBe("closed");
  });

  it("rejects unsupported protocol versions", async () => {
    const { a, b } = await twoPeers();
    await a.next("paired");
    await b.next("paired");
    a.send({ v: 2, t: "signal", payload: OFFER });
    expect((await a.next("error")).code).toBe("protocol_error");
    await b.expectNone("signal");
  });

  it("drops oversized signals without killing the socket", async () => {
    const { a, b } = await twoPeers();
    await a.next("paired");
    await b.next("paired");
    // zod caps sdp at 12k, the relay budget is 16k, so 12k passes and 13k fails validation.
    a.send({ v, t: "signal", payload: { kind: "offer", sdp: "x".repeat(13_000) } });
    expect((await a.next("error")).code).toBe("protocol_error");
    await b.expectNone("signal");
  });
});

describe("leaving", () => {
  it("graceful leave notifies the peer with reason=leave", async () => {
    const { a, b } = await twoPeers();
    await a.next("paired");
    await b.next("paired");
    a.send({ v, t: "leave" });
    const left = await b.next("peer.left");
    expect(left).toMatchObject({ peerId: peer("alice"), reason: "leave" });
  });

  it("an abrupt close notifies the peer with reason=closed, exactly once", async () => {
    const { a, b } = await twoPeers();
    await a.next("paired");
    await b.next("paired");
    a.close();
    const left = await b.next("peer.left");
    expect(left).toMatchObject({ peerId: peer("alice"), reason: "closed" });
    await b.expectNone("peer.left");
  });

  it("frees the slot after a peer leaves", async () => {
    const { room, a, b } = await twoPeers();
    await a.next("paired");
    await b.next("paired");
    a.send({ v, t: "leave" });
    await b.next("peer.left");
    const c = await TestSocket.connect(room.roomId, peer("carol"));
    expect((await c.next("welcome")).peers).toBe(2);
  });
});

describe("destroy", () => {
  it("ends the room for everyone and wipes it", async () => {
    const { room, a, b } = await twoPeers();
    await a.next("paired");
    await b.next("paired");

    a.send({ v, t: "destroy", ownerSecret: room.ownerSecret });
    expect(await b.next("room.destroyed")).toMatchObject({ by: peer("alice") });
    expect(await a.next("room.destroyed")).toMatchObject({ by: peer("alice") });
    expect(await a.waitClosed()).toMatchObject({ code: CloseCode.RoomDestroyed });
    expect(await b.waitClosed()).toMatchObject({ code: CloseCode.RoomDestroyed });
    expect((await api(`/api/rooms/${room.roomId}`)).status).toBe(404);

    const late = await TestSocket.connect(room.roomId, peer("carol"));
    expect(await late.waitClosed()).toMatchObject({ code: CloseCode.RoomNotFound });
  });

  it("only the creator's secret destroys; anyone else gets not_owner and the room lives on", async () => {
    const { room, a, b } = await twoPeers();
    await a.next("paired");
    await b.next("paired");
    const { ownerSecret: wrong } = await newOwner();

    b.send({ v, t: "destroy", ownerSecret: wrong });
    expect(await b.next("error")).toMatchObject({ code: "not_owner" });
    await a.expectNone("room.destroyed");
    expect((await api(`/api/rooms/${room.roomId}`)).status).toBe(200);

    // The pair keeps working.
    b.send({ v, t: "signal", payload: OFFER });
    expect((await a.next("signal")).payload).toEqual(OFFER);

    // The joiner can destroy if (and only if) it holds the creator's secret.
    b.send({ v, t: "destroy", ownerSecret: room.ownerSecret });
    expect(await a.next("room.destroyed")).toMatchObject({ by: peer("bob") });
  });

  it("a destroy without a secret is a protocol error, not a destroy", async () => {
    const { room, a } = await twoPeers();
    a.send({ v, t: "destroy" }); // no ownerSecret: rejected by the schema
    expect(await a.next("error")).toMatchObject({ code: "protocol_error" });
    expect((await api(`/api/rooms/${room.roomId}`)).status).toBe(200);
  });
});

describe("expiry", () => {
  async function expireNow(roomId: string) {
    const stub = env.ROOM.getByName(roomId);
    await runInDurableObject(stub, async (_instance, state) => {
      const meta = await state.storage.get<RoomMeta>("meta");
      if (!meta) throw new Error("no meta");
      await state.storage.put("meta", { ...meta, expiresAt: Date.now() - 1 });
    });
    // Reload from storage so the in-memory cache can't mask persistence bugs.
    await evictDurableObject(stub);
    return stub;
  }

  it("the alarm closes connected peers with room.expired and wipes the room", async () => {
    const { room, a, b } = await twoPeers();
    await a.next("paired");
    await b.next("paired");

    const stub = await expireNow(room.roomId);
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    await a.next("room.expired");
    await b.next("room.expired");
    expect(await a.waitClosed()).toMatchObject({ code: CloseCode.RoomExpired });
    expect(await b.waitClosed()).toMatchObject({ code: CloseCode.RoomExpired });
    expect((await api(`/api/rooms/${room.roomId}`)).status).toBe(404);
  });

  it("an expired room stops being joinable even before the alarm runs", async () => {
    const room = await createRoom();
    await expireNow(room.roomId);
    expect((await api(`/api/rooms/${room.roomId}`)).status).toBe(404);
    const s = await TestSocket.connect(room.roomId, peer("alice"));
    expect(await s.waitClosed()).toMatchObject({ code: CloseCode.RoomExpired });
  });

  it("re-arms instead of expiring when the deadline moved later (upgrade path)", async () => {
    const room = await createRoom();
    const stub = env.ROOM.getByName(room.roomId);
    await runInDurableObject(stub, async (_i, state) => {
      // An old deadline, still before the room's own: far enough out that it can't fire on its own
      // before the test runs it (a busy machine can take longer than a few ms to get there).
      await state.storage.setAlarm(Date.now() + 60_000);
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect((await api(`/api/rooms/${room.roomId}`)).status).toBe(200);
    await runInDurableObject(stub, async (_i, state) => {
      expect(await state.storage.getAlarm()).toBe(room.expiresAt);
    });
  });
});

describe("hibernation", () => {
  it("keeps pairing state and keeps relaying after the Durable Object is evicted", async () => {
    const { room, a, b } = await twoPeers();
    await a.next("paired");
    await b.next("paired");

    await evictDurableObject(env.ROOM.getByName(room.roomId));

    a.send({ v, t: "signal", payload: OFFER });
    expect((await b.next("signal")).payload).toEqual(OFFER);

    // Capacity is still enforced from the restored attachments.
    const c = await TestSocket.connect(room.roomId, peer("carol"));
    expect(await c.waitClosed()).toMatchObject({ code: CloseCode.RoomFull });
  });
});
