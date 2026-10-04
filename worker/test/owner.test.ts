import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { CloseCode } from "@poof/protocol";
import { describe, expect, it } from "vitest";
import type { RoomMeta } from "../src/room-do.ts";
import { TestSocket, api, createRoom, newOwner, peer } from "./helpers.ts";

const v = 1;

async function roomFor(maxPeers: number) {
  const room = await createRoom();
  if (maxPeers !== 2) {
    const stub = env.ROOM.getByName(room.roomId);
    await runInDurableObject(stub, async (_instance, state) => {
      const meta = await state.storage.get<RoomMeta>("meta");
      if (!meta) throw new Error("no meta");
      await state.storage.put("meta", { ...meta, maxPeers });
    });
    await evictDurableObject(stub);
  }
  return room;
}

async function join(roomId: string, label: string) {
  const s = await TestSocket.connect(roomId, peer(label));
  return { s, welcome: await s.next("welcome") };
}

describe("owner", () => {
  it("welcome says nobody has claimed yet; a claim tells everyone, newcomers learn it from welcome", async () => {
    const room = await roomFor(4);
    const a = await join(room.roomId, "alice");
    expect(a.welcome.owner).toBeNull();
    const b = await join(room.roomId, "bob");
    expect(b.welcome.owner).toBeNull();

    a.s.send({ v, t: "claim", ownerSecret: room.ownerSecret });
    expect(await a.s.next("owner")).toMatchObject({ peerId: peer("alice") });
    expect(await b.s.next("owner")).toMatchObject({ peerId: peer("alice") });

    const c = await join(room.roomId, "carol");
    expect(c.welcome.owner).toBe(peer("alice"));
  });

  it("a wrong secret claims nothing", async () => {
    const room = await roomFor(2);
    const a = await join(room.roomId, "alice");
    const b = await join(room.roomId, "bob");
    const { ownerSecret: wrong } = await newOwner();
    b.s.send({ v, t: "claim", ownerSecret: wrong });
    expect(await b.s.next("error")).toMatchObject({ code: "not_owner" });
    await a.s.expectNone("owner");
  });

  it("the badge goes with the creator's socket: gone when they leave, back when they claim again", async () => {
    const room = await roomFor(4);
    const a = await join(room.roomId, "alice");
    a.s.send({ v, t: "claim", ownerSecret: room.ownerSecret });
    await a.s.next("owner");
    a.s.send({ v, t: "leave" });
    await a.s.waitClosed();
    const b = await join(room.roomId, "bob");
    expect(b.welcome.owner).toBeNull();
  });
});

describe("ban", () => {
  it("removes the member, tells the others, and keeps them out", async () => {
    const room = await roomFor(4);
    const a = await join(room.roomId, "alice");
    const b = await join(room.roomId, "bob");
    const c = await join(room.roomId, "carol");

    a.s.send({ v, t: "ban", ownerSecret: room.ownerSecret, peerId: peer("bob") });
    await b.s.next("banned");
    expect(await b.s.waitClosed()).toMatchObject({ code: CloseCode.Banned });
    expect(await a.s.next("peer.left")).toMatchObject({ peerId: peer("bob"), reason: "banned" });
    expect(await c.s.next("peer.left")).toMatchObject({ peerId: peer("bob"), reason: "banned" });

    const again = await TestSocket.connect(room.roomId, peer("bob"));
    expect(await again.next("rejected")).toMatchObject({
      code: CloseCode.Banned,
      reason: "banned",
    });
    expect(await again.waitClosed()).toMatchObject({ code: CloseCode.Banned });

    // the seat is free for someone else
    const d = await join(room.roomId, "dave");
    expect(d.welcome.peers).toBe(3);
  });

  it("works in a room for two: the creator stays, the seat opens", async () => {
    const room = await roomFor(2);
    const a = await join(room.roomId, "alice");
    const b = await join(room.roomId, "bob");
    a.s.send({ v, t: "ban", ownerSecret: room.ownerSecret, peerId: peer("bob") });
    expect(await a.s.next("peer.left")).toMatchObject({ reason: "banned" });
    expect(await b.s.waitClosed()).toMatchObject({ code: CloseCode.Banned });
    const c = await join(room.roomId, "carol");
    expect(c.welcome.peers).toBe(2);
    expect((await api(`/api/rooms/${room.roomId}`)).status).toBe(200);
  });

  it("only the creator's secret bans; nobody can ban the creator's own socket", async () => {
    const room = await roomFor(4);
    const a = await join(room.roomId, "alice");
    const b = await join(room.roomId, "bob");
    const { ownerSecret: wrong } = await newOwner();

    b.s.send({ v, t: "ban", ownerSecret: wrong, peerId: peer("alice") });
    expect(await b.s.next("error")).toMatchObject({ code: "not_owner" });
    await a.s.expectNone("banned");

    a.s.send({ v, t: "ban", ownerSecret: room.ownerSecret, peerId: peer("alice") });
    await a.s.expectNone("banned");
    expect(a.s.closed).toBeNull();
  });

  it("the ban list goes with the room", async () => {
    const room = await roomFor(4);
    const a = await join(room.roomId, "alice");
    await join(room.roomId, "bob");
    a.s.send({ v, t: "ban", ownerSecret: room.ownerSecret, peerId: peer("bob") });
    await a.s.next("peer.left");
    a.s.send({ v, t: "destroy", ownerSecret: room.ownerSecret });
    await a.s.next("room.destroyed");
    await runInDurableObject(env.ROOM.getByName(room.roomId), async (_instance, state) => {
      expect(await state.storage.get("banned")).toBeUndefined();
    });
  });
});
