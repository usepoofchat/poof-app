import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { CloseCode, type SignalPayload } from "@poof/protocol";
import { describe, expect, it } from "vitest";
import worker from "../src/index.ts";
import type { RoomMeta } from "../src/room-do.ts";
import { ANY_OWNER, TestSocket, createRoom, peer } from "./helpers.ts";

const v = 1;
const OFFER: SignalPayload = { kind: "offer", sdp: "v=0\r\n" };

/** A room opened up to `maxPeers` (super rooms will set this). */
async function groupRoom(maxPeers: number) {
  const room = await createRoom();
  const stub = env.ROOM.getByName(room.roomId);
  await runInDurableObject(stub, async (_instance, state) => {
    const meta = await state.storage.get<RoomMeta>("meta");
    if (!meta) throw new Error("no meta");
    await state.storage.put("meta", { ...meta, maxPeers });
  });
  await evictDurableObject(stub);
  return room;
}

async function join(roomId: string, label: string) {
  const s = await TestSocket.connect(roomId, peer(label));
  return s;
}

describe("group rooms: pairing", () => {
  it("each newcomer is paired with everyone already there; earlier joiner = initiator", async () => {
    const room = await groupRoom(10);
    const a = await join(room.roomId, "alice");
    expect((await a.next("welcome")).members).toEqual([]);

    const b = await join(room.roomId, "bob");
    expect((await b.next("welcome")).members).toEqual([peer("alice")]);
    expect(await a.next("paired")).toMatchObject({ role: "initiator", peerId: peer("bob") });
    expect(await b.next("paired")).toMatchObject({ role: "responder", peerId: peer("alice") });

    const c = await join(room.roomId, "carol");
    const welcome = await c.next("welcome");
    expect(welcome.members.sort()).toEqual([peer("alice"), peer("bob")].sort());
    expect(welcome.peers).toBe(3);
    expect(await a.next("paired")).toMatchObject({ role: "initiator", peerId: peer("carol") });
    expect(await b.next("paired")).toMatchObject({ role: "initiator", peerId: peer("carol") });
    const carolPairs = [await c.next("paired"), await c.next("paired")];
    expect(carolPairs.map((p) => p.role)).toEqual(["responder", "responder"]);
    expect(carolPairs.map((p) => p.peerId).sort()).toEqual([peer("alice"), peer("bob")].sort());

    // Nobody is paired twice.
    await a.expectNone("paired");
    await b.expectNone("paired");
    await c.expectNone("paired");
  });

  it("caps at maxPeers", async () => {
    const room = await groupRoom(3);
    for (const name of ["alice", "bob", "carol"])
      await (await join(room.roomId, name)).next("welcome");
    const dave = await join(room.roomId, "dave");
    expect(await dave.next("rejected")).toMatchObject({ code: CloseCode.RoomFull });
  });

  it("a member reconnecting with the same peerId re-pairs with everyone, keeping its role", async () => {
    const room = await groupRoom(10);
    const a = await join(room.roomId, "alice");
    await a.next("welcome");
    const b = await join(room.roomId, "bob");
    await b.next("welcome");
    const c = await join(room.roomId, "carol");
    await c.next("welcome");
    for (const s of [a, b, b, c, c]) await s.next("paired");
    await a.next("paired");

    const a2 = await join(room.roomId, "alice");
    await a.next("replaced");
    await a2.next("welcome");
    const pairs = [await a2.next("paired"), await a2.next("paired")];
    expect(pairs.every((p) => p.role === "initiator")).toBe(true);
    expect(await b.next("paired")).toMatchObject({ role: "responder", peerId: peer("alice") });
    expect(await c.next("paired")).toMatchObject({ role: "responder", peerId: peer("alice") });
  });
});

describe("group rooms: addressed signaling", () => {
  async function threeMembers() {
    const room = await groupRoom(10);
    const a = await join(room.roomId, "alice");
    await a.next("welcome");
    const b = await join(room.roomId, "bob");
    await b.next("welcome");
    const c = await join(room.roomId, "carol");
    await c.next("welcome");
    return { room, a, b, c };
  }

  it("delivers only to `to`, stamped with the sender as `from`", async () => {
    const { a, b, c } = await threeMembers();
    a.send({ v, t: "signal", to: peer("carol"), payload: OFFER });
    expect(await c.next("signal")).toEqual({ v, t: "signal", from: peer("alice"), payload: OFFER });
    await b.expectNone("signal");
    await a.expectNone("signal");
  });

  it("a client can't spoof `from`", async () => {
    const { a, c } = await threeMembers();
    a.send({ v, t: "signal", to: peer("carol"), from: peer("bob"), payload: OFFER });
    expect((await c.next("signal")).from).toBe(peer("alice"));
  });

  it("without `to` in a group, or to someone not here, the signal is refused", async () => {
    const { a, b } = await threeMembers();
    a.send({ v, t: "signal", payload: OFFER });
    expect(await a.next("error")).toMatchObject({ code: "not_paired" });
    a.send({ v, t: "signal", to: peer("nobody"), payload: OFFER });
    expect(await a.next("error")).toMatchObject({ code: "not_paired" });
    a.send({ v, t: "signal", to: peer("alice"), payload: OFFER }); // to yourself
    expect(await a.next("error")).toMatchObject({ code: "not_paired" });
    await b.expectNone("signal");
  });

  it("when one member leaves, the others are told and keep signaling", async () => {
    const { a, b, c } = await threeMembers();
    b.send({ v, t: "leave" });
    expect(await a.next("peer.left")).toMatchObject({ peerId: peer("bob"), reason: "leave" });
    expect(await c.next("peer.left")).toMatchObject({ peerId: peer("bob"), reason: "leave" });
    a.send({ v, t: "signal", to: peer("carol"), payload: OFFER });
    expect((await c.next("signal")).from).toBe(peer("alice"));
    a.send({ v, t: "signal", to: peer("bob"), payload: OFFER });
    expect(await a.next("error")).toMatchObject({ code: "not_paired" });
  });
});

describe("ROOM_MAX_PEERS_FREE (local/e2e testing only)", () => {
  async function maxPeersWith(value: string | undefined): Promise<number> {
    const testEnv = { ...env, ROOM_MAX_PEERS_FREE: value } as unknown as Env;
    const res = await worker.fetch(
      new Request("http://poof.test/api/rooms", {
        method: "POST",
        headers: { "Content-Type": "application/json", "CF-Connecting-IP": "198.51.100.9" },
        body: JSON.stringify(ANY_OWNER),
      }),
      testEnv,
    );
    return ((await res.json()) as { maxPeers: number }).maxPeers;
  }

  it("defaults to 2 and is clamped to 2..10", async () => {
    expect(await maxPeersWith("2")).toBe(2);
    expect(await maxPeersWith(undefined)).toBe(2);
    expect(await maxPeersWith("4")).toBe(4);
    expect(await maxPeersWith("1")).toBe(2);
    expect(await maxPeersWith("50")).toBe(10);
    expect(await maxPeersWith("nope")).toBe(2);
  });
});

describe("ROOM_FILES_FREE (local/e2e testing only)", () => {
  async function createWith(value: string | undefined) {
    const testEnv = { ...env, ROOM_FILES_FREE: value } as unknown as Env;
    const res = await worker.fetch(
      new Request("http://poof.test/api/rooms", {
        method: "POST",
        headers: { "Content-Type": "application/json", "CF-Connecting-IP": "198.51.100.10" },
        body: JSON.stringify(ANY_OWNER),
      }),
      testEnv,
    );
    return (await res.json()) as {
      roomId: string;
      limits: { fileTransfer: boolean; fileMaxBytes: number };
    };
  }

  it('is off unless exactly "1"', async () => {
    for (const value of [undefined, "0", "true", "yes"]) {
      expect((await createWith(value)).limits.fileTransfer).toBe(false);
    }
  });

  it('"1" turns files on for that room, and the room remembers it', async () => {
    const created = await createWith("1");
    expect(created.limits).toEqual({ fileTransfer: true, fileMaxBytes: 2 * 1024 * 1024 });
    // Later reads go through the normal env (ROOM_FILES_FREE "0"): the flag lives in the room's meta.
    const res = await worker.fetch(
      new Request(`http://poof.test/api/rooms/${created.roomId}`, {
        headers: { "CF-Connecting-IP": "198.51.100.10" },
      }),
      env,
    );
    expect(((await res.json()) as { limits: { fileTransfer: boolean } }).limits.fileTransfer).toBe(
      true,
    );
  });
});
