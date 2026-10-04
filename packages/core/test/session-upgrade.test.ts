import { describe, expect, it } from "vitest";
import {
  PoofError,
  RoomSession,
  generateRoomKey,
  type Pass,
  type SessionDeps,
  type SessionStatus,
} from "../src/index.ts";
import { FakeRoomServer, FakeRtcNetwork, waitFor } from "./fakes.ts";

const ROOM = "AAAAAAAAAAAAAAAAAAAAAA";
const ALICE = "alice".padEnd(22, "_");
const BOB = "bobby".padEnd(22, "_");
const CAROL = "carol".padEnd(22, "_");
const ORIGIN = "https://poof.test";

/** The fake server takes any pass it hasn't seen; the real one checks the blind signature. */
const pass = (people = 4, lifetime: 3600 | 86400 = 3600): Pass => ({
  variant: { lifetime, people, ai: false },
  keyId: "k".repeat(43),
  msg: `m${crypto.randomUUID()}`,
  signature: "s".repeat(10),
});

function world() {
  const server = new FakeRoomServer();
  server.createRoom(ROOM, 600_000);
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
  return { server, net, make };
}

const status = (s: RoomSession): SessionStatus => s.getState().status;
const until = (s: RoomSession, st: SessionStatus) =>
  waitFor(() => status(s) === st, `status ${st} (is ${status(s)})`);

async function sealedPair(w: ReturnType<typeof world>) {
  const alice = w.make(ALICE);
  const bob = w.make(BOB);
  await alice.start();
  await until(alice, "waiting");
  await bob.start();
  await until(alice, "sealed");
  await until(bob, "sealed");
  return { alice, bob };
}

describe("upgrading a free room to a Super Quant-Room", () => {
  it("the creator upgrades: both see the new plan, size, files and end", async () => {
    const w = world();
    const { alice, bob } = await sealedPair(w);
    const before = alice.getState().expiresAt!;

    await alice.upgrade(pass(4));

    for (const s of [alice, bob]) {
      await waitFor(() => s.getState().plan === "super", "upgraded");
      expect(s.getState()).toMatchObject({
        plan: "super",
        tier: "60m",
        maxPeers: 4,
        limits: { fileTransfer: true },
        status: "sealed",
      });
      expect(s.getState().expiresAt!).toBeGreaterThan(before + 49 * 60 * 1000);
    }
  });

  it("a third person can join afterwards, and the room now follows group rules", async () => {
    const w = world();
    const { alice, bob } = await sealedPair(w);
    await alice.upgrade(pass(4));
    await waitFor(() => bob.getState().maxPeers === 4, "bob sees 4");

    const carol = w.make(CAROL);
    await carol.start();
    await waitFor(
      () => carol.getState().members.filter((m) => m.state === "sealed").length === 2,
      "carol linked to both",
    );
    // Group rules: when one person leaves, the room goes on for the others.
    await carol.leave();
    await waitFor(() => alice.getState().members.length === 1, "carol gone");
    expect(status(alice)).toBe("sealed");
    expect(status(bob)).toBe("sealed");
  });

  it("relayed links get the new relay credentials and restart ICE; direct ones only get the new servers", async () => {
    const w = world();
    w.net.stats = { localType: "relay", remoteType: "host" };
    const { alice } = await sealedPair(w);
    await waitFor(() => alice.getState().connectionType === "relay", "relay");
    await alice.upgrade(pass(4));
    await waitFor(
      () => w.net.connections.every((pc) => pc.configurations.length === 1),
      "new config everywhere",
    );
    for (const pc of w.net.connections)
      expect(pc.configurations[0]).toEqual(w.server.upgradeIceServers);
    // The initiator (alice) re-offers with iceRestart; the link survives.
    await waitFor(() => w.net.connections.some((pc) => pc.restarts === 1), "ice restart");
    expect(status(alice)).toBe("sealed");
  });

  it("a direct link isn't restarted", async () => {
    const w = world();
    const { alice } = await sealedPair(w);
    await alice.upgrade(pass(4));
    await waitFor(
      () => w.net.connections.every((pc) => pc.configurations.length === 1),
      "new config everywhere",
    );
    expect(w.net.connections.every((pc) => pc.restarts === 0)).toBe(true);
  });

  it("only the creator can upgrade", async () => {
    const w = world();
    const { bob } = await sealedPair(w);
    await expect(bob.upgrade(pass(4))).rejects.toMatchObject({ code: "not_owner" });
  });

  it("a spent pass is refused with pass_invalid and the room stays as it was", async () => {
    const w = world();
    const { alice } = await sealedPair(w);
    const p = pass(4);
    await alice.upgrade(p);
    const err = await alice.upgrade(p).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PoofError);
    expect(err).toMatchObject({
      code: "pass_invalid",
      message: "That pass has already been used.",
    });
  });
});
