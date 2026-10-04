import { describe, expect, it } from "vitest";
import {
  RoomSession,
  generateRoomKey,
  memberLabel,
  type ChatItem,
  type SessionDeps,
  type SessionStatus,
} from "../src/index.ts";
import { FakeRoomServer, FakeRtcNetwork, waitFor, type FakePeerConnection } from "./fakes.ts";

const ROOM = "GGGGGGGGGGGGGGGGGGGGGG";
const ORIGIN = "https://poof.test";
const NAMES = [
  "alice",
  "bobby",
  "carol",
  "danny",
  "erina",
  "frank",
  "grace",
  "heidi",
  "ivann",
  "judyy",
];
const ID = Object.fromEntries(NAMES.map((n) => [n, n.padEnd(22, "_")])) as Record<string, string>;

/** A group room (maxPeers 10) on the fake server, with a shared fake WebRTC network. */
function group(maxPeers = 10) {
  const server = new FakeRoomServer();
  server.createRoom(ROOM, 300_000, FakeRoomServer.OWNER_SECRET, maxPeers);
  const net = new FakeRtcNetwork();
  const key = generateRoomKey();
  const make = (name: string, overrides: Partial<SessionDeps> = {}) =>
    new RoomSession({
      roomId: ROOM,
      roomKey: key,
      origin: ORIGIN,
      fetch: server.fetch,
      createSocket: server.createSocket,
      createPeerConnection: net.factory,
      peerId: ID[name],
      pqTimeoutMs: 1500,
      membersGraceMs: 60,
      ...(name === "alice" ? { ownerSecret: FakeRoomServer.OWNER_SECRET } : {}),
      ...overrides,
    });
  return { server, net, key, make };
}

const status = (s: RoomSession): SessionStatus => s.getState().status;
const until = (s: RoomSession, st: SessionStatus, ms = 3000) =>
  waitFor(() => status(s) === st, `status ${st} (is ${status(s)})`, ms);
const connectedMembers = (s: RoomSession) =>
  s
    .getState()
    .members.filter((m) => m.state === "sealed")
    .map((m) => m.peerId)
    .sort();
const texts = (s: RoomSession) =>
  s
    .getState()
    .messages.flatMap((m: ChatItem) =>
      m.kind === "text" ? [`${m.mine ? "me" : m.from}: ${m.text}`] : [],
    );
const systemLines = (s: RoomSession) =>
  s
    .getState()
    .messages.flatMap((m: ChatItem) => (m.kind === "system" ? [`${m.event} ${m.peerId}`] : []));

/** Join people one by one and wait until everyone is linked with everyone. */
async function joinAll(g: ReturnType<typeof group>, names: string[]) {
  const sessions: RoomSession[] = [];
  for (const name of names) {
    const s = g.make(name);
    await s.start();
    await waitFor(() => status(s) !== "loading", `${name} welcomed`);
    sessions.push(s);
  }
  const everyoneElse = (name: string) =>
    names
      .filter((n) => n !== name)
      .map((n) => ID[n])
      .sort();
  for (const [i, s] of sessions.entries()) {
    await waitFor(
      () => JSON.stringify(connectedMembers(s)) === JSON.stringify(everyoneElse(names[i]!)),
      `${names[i]} linked with everyone (has ${connectedMembers(s).length})`,
      5000,
    );
  }
  return sessions;
}

describe("group rooms: the mesh", () => {
  it("three people link pairwise, chat reaches everyone, and each message says who sent it", async () => {
    const g = group();
    const [alice, bob, carol] = await joinAll(g, ["alice", "bobby", "carol"]);
    for (const s of [alice!, bob!, carol!]) {
      expect(s.getState()).toMatchObject({
        status: "sealed",
        maxPeers: 10,
        role: null,
        peerPresent: true,
      });
    }
    // Three people, three pairwise connections.
    expect(g.net.connections.length).toBe(6);

    await alice!.sendMessage("hi all");
    await waitFor(() => texts(bob!).length === 1 && texts(carol!).length === 1, "fan-out");
    expect(texts(bob!)).toEqual([`${ID.alice}: hi all`]);
    expect(texts(carol!)).toEqual([`${ID.alice}: hi all`]);
    expect(texts(alice!)).toEqual(["me: hi all"]);

    await carol!.sendMessage("hey");
    await waitFor(() => texts(alice!).length === 2 && texts(bob!).length === 2, "reply fan-out");
    expect(texts(bob!)[1]).toBe(`${ID.carol}: hey`);
  });

  it("ten people: everyone ends up linked with the other nine", async () => {
    const g = group();
    const sessions = await joinAll(g, NAMES);
    expect(g.net.connections.length).toBe(90); // 45 pairs × 2 ends
    await sessions[9]!.sendMessage("from the last one");
    for (const s of sessions.slice(0, 9)) {
      await waitFor(() => texts(s).length === 1, "message to all nine");
    }
  });

  it("members get stable short labels and joined lines", async () => {
    const g = group();
    const [alice] = await joinAll(g, ["alice", "bobby", "carol"]);
    const bobView = alice!.getState().members.find((m) => m.peerId === ID.bobby);
    expect(bobView).toMatchObject({
      label: memberLabel(ID.bobby!),
      nickname: null,
      state: "sealed",
      connectionType: "direct",
    });
    expect(memberLabel(ID.bobby!)).toMatch(/^Peer [0-9A-F]{4}$/);
    expect(systemLines(alice!).sort()).toEqual([`joined ${ID.bobby}`, `joined ${ID.carol}`].sort());
  });

  it("a late joiner sees nothing that was said before (no history)", async () => {
    const g = group();
    const [alice, bob] = await joinAll(g, ["alice", "bobby"]);
    await alice!.sendMessage("before carol");
    await waitFor(() => texts(bob!).length === 1, "first message");
    const carol = g.make("carol");
    await carol.start();
    await waitFor(() => connectedMembers(carol).length === 2, "carol linked");
    expect(texts(carol)).toEqual([]);
  });

  it("is capped by the server at maxPeers", async () => {
    const g = group(3);
    await joinAll(g, ["alice", "bobby", "carol"]);
    const dan = g.make("danny");
    await dan.start();
    await until(dan, "error");
    expect(dan.getState().error?.code).toBe("room_full");
  });
});

describe("group rooms: people leaving", () => {
  it("someone leaving is a line in the chat; the others keep talking", async () => {
    const g = group();
    const [alice, bob, carol] = await joinAll(g, ["alice", "bobby", "carol"]);
    await alice!.sendMessage("before");
    await waitFor(() => texts(carol!).length === 1, "message");

    await bob!.leave();
    expect(bob!.getState()).toMatchObject({
      status: "terminated",
      endReason: "left_by_me",
      messages: [],
    });
    await waitFor(
      () => connectedMembers(alice!).length === 1 && connectedMembers(carol!).length === 1,
      "bob gone",
    );
    expect(systemLines(alice!)).toContain(`left ${ID.bobby}`);
    expect(alice!.getState().status).toBe("sealed");
    // The transcript stays (unlike a 2-person room).
    expect(texts(carol!)).toEqual([`${ID.alice}: before`]);

    await alice!.sendMessage("after");
    await waitFor(() => texts(carol!).length === 2, "still talking");
  });

  it("when everyone else is gone, you're back to waiting and the room is still alive", async () => {
    const g = group();
    const [alice, bob, carol] = await joinAll(g, ["alice", "bobby", "carol"]);
    await bob!.leave();
    await carol!.leave();
    await until(alice!, "waiting");
    expect(alice!.getState()).toMatchObject({ peerPresent: false, members: [] });
    expect(g.server.rooms.has(ROOM)).toBe(true);

    // Someone new can still come in.
    const dan = g.make("danny");
    await dan.start();
    await until(alice!, "sealed");
  });

  it("an abrupt disconnect (closed tab) is handled like a leave", async () => {
    const g = group();
    const [alice] = await joinAll(g, ["alice", "bobby", "carol"]);
    for (const socket of g.server.socketsFor(ID.bobby!)) socket.close();
    await waitFor(() => connectedMembers(alice!).length === 1, "bob dropped");
    expect(alice!.getState().status).toBe("sealed");
  });

  it("the creator's destroy ends it for everyone", async () => {
    const g = group();
    const [alice, bob, carol] = await joinAll(g, ["alice", "bobby", "carol"]);
    await expect(bob!.destroy()).rejects.toMatchObject({ code: "not_owner" });
    await alice!.destroy();
    await until(bob!, "terminated");
    await until(carol!, "terminated");
    expect(bob!.getState().endReason).toBe("destroyed_by_peer");
    expect(carol!.getState().messages).toEqual([]);
  });

  it("a broken link to one member doesn't end the room for the others", async () => {
    const g = group();
    const [alice, bob, carol] = await joinAll(g, ["alice", "bobby", "carol"]);
    // Tamper with everything Bob sends to Alice from now on (a flipped ciphertext bit).
    const aliceLinks = (
      alice as unknown as { links: Map<string, { link: { pc: FakePeerConnection } }> }
    ).links;
    const aliceSide = aliceLinks.get(ID.bobby!)!.link.pc;
    for (const channel of aliceSide.channels) {
      channel.other!.tamper = (d) => {
        if (typeof d === "string") return d;
        const copy = new Uint8Array(d);
        copy[copy.length - 1]! ^= 1;
        return copy;
      };
    }
    await bob!.sendMessage("garbled for alice");
    await waitFor(
      () => alice!.getState().members.find((m) => m.peerId === ID.bobby)?.state === "failed",
      "bob's link to alice marked failed",
    );
    expect(alice!.getState().status).toBe("sealed");
    // Carol's copy travels on its own link and may land after Alice's verdict.
    await waitFor(() => texts(carol!).length === 1, "bob to carol");
    expect(texts(carol!)).toEqual([`${ID.bobby}: garbled for alice`]);
    await alice!.sendMessage("carol still hears me");
    await waitFor(() => texts(carol!).length === 2, "alice to carol");
  });
});

describe("group rooms: nicknames", () => {
  it("is sent over the encrypted links, normalised, and follows changes", async () => {
    const g = group();
    const [alice, bob, carol] = await joinAll(g, ["alice", "bobby", "carol"]);
    expect(alice!.setNickname("  Ana\u0000\n  Maria  ")).toBe("Ana Maria");
    await waitFor(
      () =>
        bob!.getState().members.find((m) => m.peerId === ID.alice)?.nickname === "Ana Maria" &&
        carol!.getState().members.find((m) => m.peerId === ID.alice)?.nickname === "Ana Maria",
      "nickname everywhere",
    );
    alice!.setNickname("");
    await waitFor(
      () => bob!.getState().members.find((m) => m.peerId === ID.alice)?.nickname === null,
      "cleared",
    );
    expect(alice!.getState().nickname).toBeNull();
    // The server never saw it.
    expect(JSON.stringify(g.server.sockets.flatMap((s) => s.sent))).not.toContain("Ana");
  });

  it("a nickname set before joining reaches people as they connect", async () => {
    const g = group();
    const alice = g.make("alice");
    alice.setNickname("Ana");
    await alice.start();
    await until(alice, "waiting");
    const bob = g.make("bobby");
    await bob.start();
    await waitFor(() => bob.getState().members[0]?.nickname === "Ana", "nickname on connect");
  });
});

describe("group rooms: split view (a server showing different people to different members)", () => {
  it("is flagged when the server never lets two members meet", async () => {
    const g = group();
    // Bob and Carol are never told about each other; both are linked with Alice.
    g.server.pairFilter = (a, b) => !([a, b].includes(ID.bobby!) && [a, b].includes(ID.carol!));
    const sessions = ["alice", "bobby", "carol"].map((n) => g.make(n));
    for (const s of sessions) await s.start();
    const [alice, bob, carol] = sessions;
    await waitFor(() => connectedMembers(alice!).length === 2, "alice linked with both");
    await waitFor(() => alice!.getState().membersMismatch, "alice warned", 2000);
    await waitFor(
      () => bob!.getState().membersMismatch && carol!.getState().membersMismatch,
      "both warned",
      2000,
    );
  });

  it("is not flagged once everyone sees everyone", async () => {
    const g = group();
    const sessions = await joinAll(g, ["alice", "bobby", "carol", "danny"]);
    await new Promise((r) => setTimeout(r, 150)); // longer than membersGraceMs
    for (const s of sessions) expect(s.getState().membersMismatch).toBe(false);
  });
});

describe("2-person rooms are unchanged by all this", () => {
  it("still end for both when one person leaves, and report the one member", async () => {
    const g = group(2);
    const [alice, bob] = await joinAll(g, ["alice", "bobby"]);
    expect(alice!.getState()).toMatchObject({ maxPeers: 2, role: "initiator" });
    expect(alice!.getState().members).toHaveLength(1);
    await bob!.leave();
    await until(alice!, "terminated");
    expect(alice!.getState().endReason).toBe("peer_left");
    expect(systemLines(alice!)).toEqual([]);
  });
});

describe("group rooms: a modified server", () => {
  it("can't make a browser open more links than the room holds, or one to itself", async () => {
    const g = group(3);
    const alice = g.make("alice");
    await alice.start();
    await until(alice, "waiting");
    const socket = g.server.socketsFor(ID.alice!).at(-1)!;
    const paired = (peerId: string) =>
      socket.serverSend(
        JSON.stringify({ v: 1, t: "paired", role: "initiator", peerId, iceServers: [] }),
      );

    paired(ID.alice!);
    for (const name of NAMES.slice(1)) paired(ID[name]!);
    await waitFor(() => alice.getState().members.length > 0, "links opened");
    await new Promise((r) => setTimeout(r, 50));

    const members = alice.getState().members.map((m) => m.peerId);
    expect(members).not.toContain(ID.alice);
    expect(members).toEqual([ID.bobby, ID.carol]);
    expect(g.net.connections.length).toBe(2);
    await alice.leave();
  });
});
