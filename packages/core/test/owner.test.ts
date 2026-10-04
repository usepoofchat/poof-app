import { describe, expect, it } from "vitest";
import {
  PoofError,
  RoomSession,
  generateRoomKey,
  memberName,
  type ChatItem,
  type SessionDeps,
} from "../src/index.ts";
import { FakeRoomServer, FakeRtcNetwork, waitFor } from "./fakes.ts";

const ROOM = "OOOOOOOOOOOOOOOOOOOOOO";
const ORIGIN = "https://poof.test";
const ID = Object.fromEntries(
  ["alice", "bobby", "carol", "danny"].map((n) => [n, n.padEnd(22, "_")]),
) as Record<"alice" | "bobby" | "carol" | "danny", string>;

function world(maxPeers = 2, ownerTools = true) {
  const server = new FakeRoomServer();
  server.ownerTools = ownerTools;
  server.createRoom(ROOM, 300_000, FakeRoomServer.OWNER_SECRET, maxPeers);
  const net = new FakeRtcNetwork();
  const key = generateRoomKey();
  const make = (name: keyof typeof ID, overrides: Partial<SessionDeps> = {}) =>
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
  return { server, make };
}

const sealedWith = (s: RoomSession, n: number) =>
  s.getState().status === "sealed" &&
  s.getState().members.filter((m) => m.state === "sealed").length === n;

async function room(names: Array<keyof typeof ID>, maxPeers = 2, ownerTools = true) {
  const w = world(maxPeers, ownerTools);
  const sessions: RoomSession[] = [];
  for (const name of names) {
    const s = w.make(name);
    await s.start();
    await waitFor(() => s.getState().status !== "loading", `${name} welcomed`);
    sessions.push(s);
  }
  for (const [i, s] of sessions.entries())
    await waitFor(() => sealedWith(s, sessions.length - 1), `${names[i]} linked with everyone`);
  return { ...w, sessions };
}

const systemLines = (s: RoomSession) =>
  s
    .getState()
    .messages.flatMap((m: ChatItem) => (m.kind === "system" ? [`${m.event} ${m.peerId}`] : []));
const textOf = (s: RoomSession, text: string) =>
  s.getState().messages.find((m) => m.kind === "text" && m.text === text);
const ctlOf = (s: RoomSession, peerId: string) =>
  (s as unknown as { links: Map<string, { sendCtl(c: unknown): Promise<void> }> }).links.get(
    peerId,
  );

describe("default names", () => {
  it("are the same everywhere, and two words", () => {
    expect(memberName(ID.bobby)).toBe(memberName(ID.bobby));
    expect(memberName(ID.bobby)).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/);
    expect(memberName(ID.alice)).not.toBe(memberName(ID.bobby));
  });

  it("show up for you and for the others", async () => {
    const { sessions } = await room(["alice", "bobby"]);
    const [alice, bobby] = sessions as [RoomSession, RoomSession];
    expect(alice.getState().selfName).toBe(memberName(ID.alice));
    expect(bobby.getState().members[0]).toMatchObject({ name: memberName(ID.alice) });
  });
});

describe("owner", () => {
  it("the server names the creator; everyone sees it", async () => {
    const { sessions } = await room(["alice", "bobby", "carol"], 4);
    const [alice, bobby, carol] = sessions as [RoomSession, RoomSession, RoomSession];
    await waitFor(() => bobby.getState().ownerId === ID.alice, "bobby knows the owner");
    expect(alice.getState()).toMatchObject({ ownerId: ID.alice, ownerTools: true, isOwner: true });
    expect(carol.getState()).toMatchObject({ ownerId: ID.alice, isOwner: false });
    const onCarol = Object.fromEntries(carol.getState().members.map((m) => [m.peerId, m.owner]));
    expect(onCarol).toEqual({ [ID.alice]: true, [ID.bobby]: false });
  });

  it("an older server: no claim is sent, and the owner tools stay off", async () => {
    const { server, sessions } = await room(["alice", "bobby"], 2, false);
    const [alice] = sessions as [RoomSession];
    expect(alice.getState()).toMatchObject({ ownerTools: false, ownerId: null });
    const sent = server.socketsFor(ID.alice).flatMap((s) => s.sent);
    expect(sent.some((m) => m.includes('"claim"'))).toBe(false);
    expect(() => alice.ban(ID.bobby)).toThrow(PoofError);
    expect(alice.getState().status).toBe("sealed");
  });
});

describe("ban", () => {
  it("in a room for two: the guest is out, the creator keeps the room and the conversation", async () => {
    const w = await room(["alice", "bobby"]);
    const [alice, bobby] = w.sessions as [RoomSession, RoomSession];
    await bobby.sendMessage("hi");
    await waitFor(() => Boolean(textOf(alice, "hi")), "alice got hi");

    alice.ban(ID.bobby);
    await waitFor(() => bobby.getState().status === "terminated", "bobby removed");
    expect(bobby.getState().endReason).toBe("banned");
    await waitFor(() => alice.getState().status === "waiting", "alice waiting again");
    expect(alice.getState().members).toEqual([]);
    expect(textOf(alice, "hi")).toBeDefined();
    expect(systemLines(alice)).toEqual([`banned ${ID.bobby}`]);

    // bobby can't come back from that browser...
    const again = w.make("bobby");
    await again.start();
    await waitFor(() => again.getState().status === "error", "bobby refused");
    expect(again.getState().error?.code).toBe("banned");

    // ...but the seat is free for someone else
    const carol = w.make("carol");
    await carol.start();
    await waitFor(() => sealedWith(alice, 1) && sealedWith(carol, 1), "alice and carol");
  });

  it("in a group: everyone else drops the link and sees one line", async () => {
    const { sessions } = await room(["alice", "bobby", "carol"], 4);
    const [alice, bobby, carol] = sessions as [RoomSession, RoomSession, RoomSession];
    alice.ban(ID.bobby);
    await waitFor(() => bobby.getState().endReason === "banned", "bobby removed");
    await waitFor(() => sealedWith(carol, 1) && sealedWith(alice, 1), "alice and carol only");
    expect(carol.getState().members.map((m) => m.peerId)).toEqual([ID.alice]);
    expect(systemLines(carol)).toContain(`banned ${ID.bobby}`);
    expect(carol.getState().status).toBe("sealed");
  });

  it("only the creator can", async () => {
    const { sessions } = await room(["alice", "bobby"]);
    const [alice, bobby] = sessions as [RoomSession, RoomSession];
    expect(() => bobby.ban(ID.alice)).toThrow(/Only the person who created/);
    expect(alice.getState().status).toBe("sealed");
  });
});

describe("pin", () => {
  it("the creator pins for everyone, newcomers included, and can unpin", async () => {
    const w = await room(["alice", "bobby"], 4);
    const [alice, bobby] = w.sessions as [RoomSession, RoomSession];
    await waitFor(() => bobby.getState().ownerId === ID.alice, "bobby knows the owner");
    bobby.setNickname("Bob");
    await bobby.sendMessage("meet at 8");
    await waitFor(() => Boolean(textOf(alice, "meet at 8")), "alice got it");
    await waitFor(() => alice.getState().members[0]?.nickname === "Bob", "alice knows the name");

    alice.pin(textOf(alice, "meet at 8")!.id);
    expect(alice.getState().pinned).toMatchObject({
      text: "meet at 8",
      from: ID.bobby,
      nickname: "Bob",
    });
    await waitFor(() => bobby.getState().pinned !== null, "bobby sees the pin");
    expect(bobby.getState().pinned).toMatchObject({
      text: "meet at 8",
      from: null,
      nickname: "Bob",
    });

    const carol = w.make("carol");
    await carol.start();
    await waitFor(() => carol.getState().pinned !== null, "carol gets the pin on joining");
    expect(carol.getState().pinned).toMatchObject({
      text: "meet at 8",
      from: ID.bobby,
      name: memberName(ID.bobby),
    });

    alice.pin(null);
    await waitFor(
      () => bobby.getState().pinned === null && carol.getState().pinned === null,
      "unpinned everywhere",
    );
  });

  it("guests can't pin, and a forged pin from a guest is ignored", async () => {
    const { sessions } = await room(["alice", "bobby", "carol"], 4);
    const [alice, bobby, carol] = sessions as [RoomSession, RoomSession, RoomSession];
    await waitFor(() => carol.getState().ownerId === ID.alice, "carol knows the owner");
    expect(() => bobby.pin(null)).toThrow(/Only the person who created/);
    const forged = {
      kind: "pin",
      pin: { id: "x", text: "fake", author: ID.bobby, nickname: null },
    };
    await ctlOf(bobby, ID.carol)!.sendCtl(forged);
    await ctlOf(bobby, ID.alice)!.sendCtl(forged);
    await bobby.sendMessage("after"); // same channel, so once this arrives the pin has too
    await waitFor(
      () => Boolean(textOf(carol, "after")) && Boolean(textOf(alice, "after")),
      "after",
    );
    expect(carol.getState().pinned).toBeNull();
    expect(alice.getState().pinned).toBeNull();
  });
});
