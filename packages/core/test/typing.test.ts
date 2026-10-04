import { ctlPlaintextSchema } from "@poof/protocol";
import { describe, expect, it, vi } from "vitest";
import { RoomSession, generateRoomKey, type SessionDeps } from "../src/index.ts";
import { FakeRoomServer, FakeRtcNetwork, waitFor } from "./fakes.ts";

const ROOM = "AAAAAAAAAAAAAAAAAAAAAA";
const ALICE = "alice".padEnd(22, "_");
const BOB = "bobby".padEnd(22, "_");
const ORIGIN = "https://poof.test";

function world() {
  const server = new FakeRoomServer();
  server.createRoom(ROOM);
  const net = new FakeRtcNetwork();
  const key = generateRoomKey();
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
  return { make };
}

async function connectPair(aliceDeps: Partial<SessionDeps> = {}) {
  const w = world();
  const alice = w.make(ALICE, aliceDeps);
  const bob = w.make(BOB);
  await alice.start();
  await waitFor(() => alice.getState().status === "waiting", "alice waiting");
  await bob.start();
  await waitFor(() => alice.getState().status === "sealed", "alice sealed");
  await waitFor(() => bob.getState().status === "sealed", "bob sealed");
  return { alice, bob };
}

const typing = (s: RoomSession) => s.getState().typing;

describe("typing indicator", () => {
  it("is part of the control protocol (on and off)", () => {
    expect(ctlPlaintextSchema.safeParse({ kind: "typing", on: true }).success).toBe(true);
    expect(ctlPlaintextSchema.safeParse({ kind: "typing", on: false }).success).toBe(true);
    expect(ctlPlaintextSchema.safeParse({ kind: "typing" }).success).toBe(false);
    expect(ctlPlaintextSchema.safeParse({ kind: "typing", on: "yes" }).success).toBe(false);
  });

  it("starts empty and does nothing before the room is sealed", async () => {
    const w = world();
    const alice = w.make(ALICE);
    expect(typing(alice)).toEqual([]);
    expect(() => alice.setTyping(true)).not.toThrow();
    expect(typing(alice)).toEqual([]);
  });

  it("shows the other person typing, then clears on 'off'", async () => {
    const { alice, bob } = await connectPair();
    alice.setTyping(true);
    await waitFor(() => typing(bob).length === 1, "bob sees alice typing");
    expect(typing(bob)).toEqual([ALICE]);
    expect(typing(alice)).toEqual([]); // your own typing is never in your own state
    alice.setTyping(false);
    await waitFor(() => typing(bob).length === 0, "bob sees alice stop");
  });

  it("clears when the message arrives", async () => {
    const { alice, bob } = await connectPair();
    alice.setTyping(true);
    await waitFor(() => typing(bob).length === 1, "bob sees alice typing");
    await alice.sendMessage("hi");
    await waitFor(() => bob.getState().messages.length === 1, "bob receives");
    expect(typing(bob)).toEqual([]);
  });

  it("sends 'on' at most every few seconds while typing, and 'off' only after an 'on'", async () => {
    let clock = 1_000_000;
    const { alice, bob } = await connectPair({ now: () => clock });
    const seen: string[][] = [];
    bob.subscribe((s) => seen.push(s.typing));
    alice.setTyping(false); // nothing to stop yet: no frame
    alice.setTyping(true);
    alice.setTyping(true);
    alice.setTyping(true);
    await waitFor(() => typing(bob).length === 1, "bob sees alice typing");
    alice.setTyping(false);
    await waitFor(() => typing(bob).length === 0, "bob sees alice stop");
    clock += 1000;
    alice.setTyping(true); // after an "off", "on" goes out again at once
    await waitFor(() => typing(bob).length === 1, "typing again");
    // bob's typing list changed exactly three times: on, off, on
    const changes = seen.filter((t, i) => i === 0 || t !== seen[i - 1]);
    expect(changes.map((t) => t.length)).toEqual([1, 0, 1]);
  });

  it("expires by itself when the 'off' never comes", async () => {
    const { alice, bob } = await connectPair();
    // fake timers (still ticking with the real clock) before the hint arrives, so its expiry timer is fake
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setTimeout", "clearTimeout"] });
    try {
      alice.setTyping(true);
      await waitFor(() => typing(bob).length === 1, "bob sees alice typing");
      vi.advanceTimersByTime(6100);
      expect(typing(bob)).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("is wiped when the room ends", async () => {
    const { alice, bob } = await connectPair();
    alice.setTyping(true);
    await waitFor(() => typing(bob).length === 1, "bob sees alice typing");
    await bob.leave();
    expect(typing(bob)).toEqual([]);
  });
});
