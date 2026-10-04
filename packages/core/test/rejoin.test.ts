import { describe, expect, it } from "vitest";
import {
  RoomSession,
  generateRoomKey,
  type SessionDeps,
  type SessionStatus,
} from "../src/index.ts";
import { FakeRoomServer, FakeRtcNetwork, waitFor } from "./fakes.ts";

const ROOM = "AAAAAAAAAAAAAAAAAAAAAA";
const ALICE = "alice".padEnd(22, "_");
const BOB = "bobby".padEnd(22, "_");
const CAROL = "carol".padEnd(22, "_");
const ORIGIN = "https://poof.test";

function world() {
  const server = new FakeRoomServer();
  server.createRoom(ROOM);
  const net = new FakeRtcNetwork();
  const key = generateRoomKey();
  // Alice created the room: only her sessions hold the owner secret.
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
  return { server, net, make };
}

const status = (s: RoomSession): SessionStatus => s.getState().status;
const until = (s: RoomSession, st: SessionStatus) =>
  waitFor(() => status(s) === st, `status ${st} (is ${status(s)})`);
const texts = (s: RoomSession) =>
  s.getState().messages.flatMap((m) => (m.kind === "text" ? [m.text] : []));

async function connectPair(w: ReturnType<typeof world>, bobDeps: Partial<SessionDeps> = {}) {
  const alice = w.make(ALICE);
  const bob = w.make(BOB, bobDeps);
  await alice.start();
  await until(alice, "waiting");
  await bob.start();
  await until(alice, "sealed");
  await until(bob, "sealed");
  return { alice, bob };
}

describe("reloading the page in a room for two", () => {
  it("suspend() ends this page quietly: no bye, no leave, and the other side waits", async () => {
    const w = world();
    const { alice, bob } = await connectPair(w);
    await alice.sendMessage("before");
    await waitFor(() => texts(bob).length === 1, "message");

    alice.suspend();
    expect(alice.getState()).toMatchObject({
      status: "terminated",
      endReason: "suspended",
      messages: [],
    });
    await until(bob, "waiting");
    expect(bob.getState()).toMatchObject({ peerAway: true, peerPresent: false, role: null });
    expect(texts(bob)).toEqual(["before"]);
    expect(w.server.rooms.has(ROOM)).toBe(true);
  });

  it("the creator comes back with the same peerId and secret: sealed again, the other side keeps the chat", async () => {
    const w = world();
    const { alice, bob } = await connectPair(w);
    await bob.sendMessage("hi");
    await waitFor(() => texts(alice).length === 1, "message");

    alice.suspend();
    await waitFor(() => bob.getState().peerAway, "bob waits");

    const again = w.make(ALICE);
    expect(again.getState().isOwner).toBe(true);
    await again.start();
    await until(again, "sealed");
    await until(bob, "sealed");
    expect(bob.getState().peerAway).toBe(false);
    expect(bob.getState().members.map((m) => m.peerId)).toEqual([ALICE]);
    expect(texts(bob)).toEqual(["hi"]);

    await again.sendMessage("back");
    await waitFor(() => texts(bob).length === 2, "bob receives");
    await bob.sendMessage("welcome back");
    await waitFor(() => texts(again).length === 2, "alice receives");
    expect(texts(again)).toEqual(["back", "welcome back"]);
  });

  it("the guest comes back too", async () => {
    const w = world();
    const { alice, bob } = await connectPair(w);
    bob.suspend();
    await waitFor(() => alice.getState().peerAway, "alice waits");
    const again = w.make(BOB);
    await again.start();
    await until(again, "sealed");
    await until(alice, "sealed");
    await alice.sendMessage("still here");
    await waitFor(() => texts(again).length === 1, "message");
  });

  it("can reload more than once", async () => {
    const w = world();
    const pair = await connectPair(w);
    const { bob } = pair;
    let alice = pair.alice;
    for (let i = 0; i < 3; i++) {
      alice.suspend();
      await waitFor(() => bob.getState().peerAway, `bob waits (${i})`);
      alice = w.make(ALICE);
      await alice.start();
      await until(alice, "sealed");
      await until(bob, "sealed");
    }
    await alice.sendMessage("third time");
    await waitFor(() => texts(bob).includes("third time"), "message");
  });

  it("nobody else takes the place while the room waits", async () => {
    const w = world();
    const { alice, bob } = await connectPair(w, { rejoinGraceMs: 300 });
    alice.suspend();
    await waitFor(() => bob.getState().peerAway, "bob waits");

    const carol = w.make(CAROL);
    await carol.start();
    await new Promise((r) => setTimeout(r, 100));
    expect(status(carol)).not.toBe("sealed");
    expect(bob.getState()).toMatchObject({ status: "waiting", peerAway: true, members: [] });
    // Bob gives up on alice; the room ends for him as if she had left.
    await until(bob, "terminated");
    expect(bob.getState().endReason).toBe("peer_left");
  });

  it("a fast reload the server didn't notice yet (old socket still there) still reconnects", async () => {
    const w = world();
    const { alice, bob } = await connectPair(w);
    await bob.sendMessage("kept");
    w.server.socketsFor(ALICE).at(-1)!.zombie = true; // its close never reaches the server
    alice.suspend(); // the data channel closes: bob's link breaks, no peer.left
    await new Promise((r) => setTimeout(r, 20));
    expect(status(bob)).toBe("sealed"); // within the loss grace

    const again = w.make(ALICE);
    await again.start(); // replaces the old socket; the server pairs again
    await until(again, "sealed");
    await until(bob, "sealed");
    await again.sendMessage("back fast");
    await waitFor(() => texts(bob).includes("back fast"), "message");
    expect(texts(bob)).toEqual(["kept", "back fast"]);
    expect(bob.getState().endReason).toBeNull();
  });

  it("leave() still ends the room for the other side right away", async () => {
    const w = world();
    const { alice, bob } = await connectPair(w);
    await alice.leave();
    await until(bob, "terminated");
    expect(bob.getState()).toMatchObject({ endReason: "peer_left", peerAway: false });
  });

  it("the room expiring while it waits ends it as expired", async () => {
    const w = world();
    const { alice, bob } = await connectPair(w);
    alice.suspend();
    await waitFor(() => bob.getState().peerAway, "bob waits");
    w.server.expire(ROOM);
    await until(bob, "expired");
    expect(bob.getState().peerAway).toBe(false);
  });
});
