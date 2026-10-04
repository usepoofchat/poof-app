import { Channel, FrameType } from "@poof/protocol";
import { describe, expect, it } from "vitest";
import {
  PoofError,
  RoomSession,
  generateRoomKey,
  randomBytes,
  utf8,
  type ChatItem,
  type FileLike,
  type FrameCodec,
  type SessionDeps,
  type SessionStatus,
} from "../src/index.ts";
import { FakeRoomServer, FakeRtcNetwork, tick, waitFor, type FakeDataChannel } from "./fakes.ts";

const ROOM = "FFFFFFFFFFFFFFFFFFFFFF";
const ORIGIN = "https://poof.test";
const NAMES = ["alice", "bobby", "carol"] as const;
type Name = (typeof NAMES)[number];
const ID = Object.fromEntries(NAMES.map((n) => [n, n.padEnd(22, "_")])) as Record<Name, string>;
const MAX = 2 * 1024 * 1024;

/** Byte-for-byte equality. (`toEqual` on a 2 MB Uint8Array takes seconds.) */
function expectSameBytes(actual: Uint8Array | undefined, expected: Uint8Array): void {
  expect(actual).toBeInstanceOf(Uint8Array);
  expect(Buffer.from(actual!).equals(Buffer.from(expected))).toBe(true);
}

/** A room where files are on (as in a super room), with blob URLs captured instead of created. */
function world({ files = true, maxPeers = 2 } = {}) {
  const server = new FakeRoomServer();
  const room = server.createRoom(ROOM, 300_000, FakeRoomServer.OWNER_SECRET, maxPeers);
  if (files) room.plan = "super";
  const net = new FakeRtcNetwork();
  const key = generateRoomKey();
  const blobs = new Map<string, Blob>();
  const revoked: string[] = [];
  let n = 0;
  const make = (name: Name, overrides: Partial<SessionDeps> = {}) =>
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
      objectUrls: {
        create: (blob) => {
          const url = `blob:test/${++n}`;
          blobs.set(url, blob);
          return url;
        },
        revoke: (url) => revoked.push(url),
      },
      ...(name === "alice" ? { ownerSecret: FakeRoomServer.OWNER_SECRET } : {}),
      ...overrides,
    });
  return { server, net, make, blobs, revoked };
}

const status = (s: RoomSession): SessionStatus => s.getState().status;
const until = (s: RoomSession, st: SessionStatus) =>
  waitFor(() => status(s) === st, `status ${st} (is ${status(s)})`);
const connectedCount = (s: RoomSession) =>
  s.getState().members.filter((m) => m.state === "sealed").length;

async function join(w: ReturnType<typeof world>, names: Name[]) {
  const sessions: RoomSession[] = [];
  for (const name of names) {
    const s = w.make(name);
    await s.start();
    await waitFor(() => status(s) !== "loading", `${name} welcomed`);
    sessions.push(s);
  }
  for (const s of sessions)
    await waitFor(() => connectedCount(s) === names.length - 1, "everyone linked", 5000);
  return sessions as unknown as [RoomSession, RoomSession, RoomSession];
}

type FileItem = Extract<ChatItem, { kind: "file" }>;
const files = (s: RoomSession): FileItem[] =>
  s.getState().messages.filter((m): m is FileItem => m.kind === "file");
const fileItem = (s: RoomSession, id: string) => files(s).find((f) => f.id === id);

function data(size: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i += 65_536) out.set(randomBytes(Math.min(65_536, size - i)), i);
  return out;
}

function fileLike(
  bytes: Uint8Array<ArrayBuffer>,
  name = "photo.png",
  type = "image/png",
  size = bytes.length,
): FileLike {
  return { name, type, size, arrayBuffer: () => Promise.resolve(bytes.slice().buffer) };
}

async function blobBytes(
  w: ReturnType<typeof world>,
  url: string | undefined,
): Promise<Uint8Array> {
  const blob = w.blobs.get(url ?? "");
  if (!blob) throw new Error(`no blob at ${url}`);
  return new Uint8Array(await blob.arrayBuffer());
}

/** One session's link to another member, reached through private fields (test-only). */
function linkTo(s: RoomSession, peerId: string) {
  const member = (s as unknown as { links: Map<string, unknown> }).links.get(peerId) as {
    codec: FrameCodec;
    link: {
      channels: { ctl: FakeDataChannel; files: FakeDataChannel };
      send(ch: "ctl" | "files", d: Uint8Array): void;
    };
  };
  return { codec: member.codec, link: member.link, files: member.link.channels.files };
}

/** Make the files channel to `peerId` look full, so the sender waits at its backpressure check. */
function jam(s: RoomSession, peerId: string) {
  const channel = linkTo(s, peerId).files;
  channel.bufferedAmount = 10 * 1024 * 1024;
  return () => {
    channel.bufferedAmount = 0;
    channel.onbufferedamountlow?.();
  };
}

describe("files between two people", () => {
  it("a 2 MB file arrives verified and downloadable; the sender sees it delivered", async () => {
    const w = world();
    const [alice, bob] = await join(w, ["alice", "bobby"]);
    const bytes = data(MAX);
    const seen: string[] = [];
    alice.subscribe((st) => {
      const item = st.messages.find((m) => m.kind === "file");
      if (item?.kind === "file" && seen.at(-1) !== item.status) seen.push(item.status);
    });

    const fileId = await alice.sendFile(fileLike(bytes, "holiday.png", "image/png"));
    await waitFor(() => fileItem(bob, fileId)?.status === "received", "received", 5000);
    await waitFor(() => fileItem(alice, fileId)?.status === "delivered", "delivered");

    expect(fileItem(alice, fileId)).toMatchObject({
      kind: "file",
      mine: true,
      from: null,
      name: "holiday.png",
      size: MAX,
      mime: "image/png",
      status: "delivered",
      progress: 1,
      recipients: 1,
      delivered: 1,
    });
    expect(fileItem(alice, fileId)?.url).toBeUndefined();
    const received = fileItem(bob, fileId);
    expect(received).toMatchObject({
      mine: false,
      from: ID.alice,
      name: "holiday.png",
      size: MAX,
      progress: 1,
    });
    expect(received?.url).toMatch(/^blob:test\//);
    expect(w.blobs.get(received!.url!)?.type).toBe("image/png");
    expectSameBytes(await blobBytes(w, received?.url), bytes);
    expect(seen).toEqual(["sending", "sent", "delivered"]);
  });

  it("files go both ways and keep their order with chat", async () => {
    const w = world();
    const [alice, bob] = await join(w, ["alice", "bobby"]);
    await alice.sendMessage("here it comes");
    const a = await alice.sendFile(fileLike(data(1000), "a.txt", "text/plain"));
    const b = await bob.sendFile(fileLike(data(5), "b.bin", ""));
    await waitFor(
      () => fileItem(bob, a)?.status === "received" && fileItem(alice, b)?.status === "received",
      "both received",
    );
    expect(fileItem(bob, a)?.mime).toBe("application/octet-stream"); // text/plain isn't previewed
    expect(bob.getState().messages.map((m) => m.kind)).toEqual(["text", "file", "file"]);
  });

  it("refuses when files are off (free room), when too large, and when nobody is there", async () => {
    const free = world({ files: false });
    const [alice] = await join(free, ["alice", "bobby"]);
    await expect(alice.sendFile(fileLike(data(10)))).rejects.toMatchObject({
      code: "not_available",
    });

    const w = world();
    const [a2] = await join(w, ["alice", "bobby"]);
    await expect(a2.sendFile(fileLike(data(10), "x", "", MAX + 1))).rejects.toMatchObject({
      code: "file_too_large",
    });
    // A file object that understates its size is caught after reading it.
    await expect(a2.sendFile(fileLike(data(MAX + 1), "x", "", 10))).rejects.toMatchObject({
      code: "file_too_large",
    });
    expect(files(a2)).toEqual([]);

    const alone = world();
    const solo = alone.make("alice");
    await solo.start();
    await until(solo, "waiting");
    const err = await solo.sendFile(fileLike(data(10))).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PoofError);
    expect((err as PoofError).code).toBe("not_connected");
  });

  it("the sender cancels: both sides show it failed as cancelled", async () => {
    const w = world();
    const [alice, bob] = await join(w, ["alice", "bobby"]);
    const unjam = jam(alice, ID.bobby);
    const fileId = await alice.sendFile(fileLike(data(10 * 16_384)));
    await waitFor(() => fileItem(bob, fileId)?.status === "receiving", "bob receiving");
    alice.abortTransfer(fileId);
    await waitFor(() => fileItem(alice, fileId)?.status === "failed", "alice failed");
    await waitFor(() => fileItem(bob, fileId)?.status === "failed", "bob failed");
    expect(fileItem(alice, fileId)?.error).toBe("cancelled");
    expect(fileItem(bob, fileId)?.error).toBe("cancelled");
    unjam();
    await tick();
    expect(fileItem(bob, fileId)?.url).toBeUndefined();
    expect(status(alice)).toBe("sealed"); // chat goes on
    await alice.sendMessage("never mind");
  });

  it("the receiver cancels: the sender sees it", async () => {
    const w = world();
    const [alice, bob] = await join(w, ["alice", "bobby"]);
    jam(alice, ID.bobby);
    const fileId = await alice.sendFile(fileLike(data(10 * 16_384)));
    await waitFor(() => fileItem(bob, fileId)?.status === "receiving", "bob receiving");
    bob.abortTransfer(fileId);
    expect(fileItem(bob, fileId)).toMatchObject({ status: "failed", error: "cancelled" });
    await waitFor(() => fileItem(alice, fileId)?.status === "failed", "alice told");
    expect(fileItem(alice, fileId)?.error).toBe("cancelled");
    alice.abortTransfer("unknown-id"); // harmless
  });

  it("received files are revoked when the room is destroyed, and the transcript is wiped", async () => {
    const w = world();
    const [alice, bob] = await join(w, ["alice", "bobby"]);
    const fileId = await alice.sendFile(fileLike(data(100)));
    await waitFor(() => fileItem(bob, fileId)?.status === "received", "received");
    const url = fileItem(bob, fileId)!.url!;
    await alice.destroy();
    await until(bob, "terminated");
    expect(w.revoked).toEqual([url]);
    expect(bob.getState().messages).toEqual([]);
  });

  it("when the room expires mid-transfer, the file fails but received files stay until you leave", async () => {
    const w = world();
    const [alice, bob] = await join(w, ["alice", "bobby"]);
    const done = await alice.sendFile(fileLike(data(100), "first.bin"));
    await waitFor(() => fileItem(bob, done)?.status === "received", "first received");
    jam(alice, ID.bobby);
    const stuck = await alice.sendFile(fileLike(data(10 * 16_384), "second.bin"));
    await waitFor(() => fileItem(bob, stuck)?.status === "receiving", "second arriving");

    w.server.expire(ROOM);
    await until(alice, "expired");
    await until(bob, "expired");
    await waitFor(() => fileItem(alice, stuck)?.status === "failed", "sender side failed");
    expect(fileItem(alice, stuck)?.error).toBe("connection_lost");
    expect(fileItem(bob, stuck)).toMatchObject({ status: "failed", error: "connection_lost" });
    expect(fileItem(bob, done)?.status).toBe("received");
    expect(w.revoked).toEqual([]);

    await bob.leave();
    expect(w.revoked).toEqual([fileItem(bob, done)!.url]);
  });

  it("a modified peer can't reuse a file id that's already on screen", async () => {
    const w = world();
    const [alice, bob] = await join(w, ["alice", "bobby"]);
    const fileId = await alice.sendFile(fileLike(data(10)));
    await waitFor(() => fileItem(bob, fileId)?.status === "received", "received");
    const { codec, link } = linkTo(bob, ID.alice);
    const meta = { fileId, name: "evil", size: 1, mime: "", chunks: 1, sha256: "A".repeat(43) };
    link.send(
      "files",
      await codec.seal(Channel.Files, FrameType.FileMeta, utf8(JSON.stringify(meta))),
    );
    await tick();
    await tick();
    expect(files(alice)).toHaveLength(1);
    expect(fileItem(alice, fileId)?.status).toBe("delivered");
  });

  it("a frame for the chat channel slipped onto the files channel ends the session", async () => {
    const w = world();
    const [alice, bob] = await join(w, ["alice", "bobby"]);
    const { codec, link } = linkTo(bob, ID.alice);
    link.send(
      "files",
      await codec.seal(
        Channel.Ctl,
        FrameType.Chat,
        utf8(JSON.stringify({ id: "x", text: "hi", ts: 1 })),
      ),
    );
    await until(alice, "terminated");
    expect(alice.getState().endReason).toBe("connection_lost");
  });
});

describe("files in a group room", () => {
  it("one file goes to everyone, each copy verified: delivered to 2 of 2", async () => {
    const w = world({ maxPeers: 10 });
    const [alice, bob, carol] = await join(w, ["alice", "bobby", "carol"]);
    const bytes = data(3 * 16_384 + 3);
    const fileId = await alice.sendFile(fileLike(bytes, "plan.pdf", "application/pdf"));
    for (const s of [bob, carol]) {
      await waitFor(() => fileItem(s, fileId)?.status === "received", "received");
      expect(fileItem(s, fileId)).toMatchObject({
        from: ID.alice,
        name: "plan.pdf",
        mime: "application/octet-stream",
      });
      expectSameBytes(await blobBytes(w, fileItem(s, fileId)?.url), bytes);
    }
    await waitFor(() => fileItem(alice, fileId)?.status === "delivered", "delivered");
    expect(fileItem(alice, fileId)).toMatchObject({ recipients: 2, delivered: 2, progress: 1 });
  });

  it("two people send to the same person at once: both arrive", async () => {
    const w = world({ maxPeers: 10 });
    const [alice, bob, carol] = await join(w, ["alice", "bobby", "carol"]);
    const [fromBob, fromCarol] = await Promise.all([
      bob.sendFile(fileLike(data(40_000), "b.bin")),
      carol.sendFile(fileLike(data(40_000), "c.bin")),
    ]);
    await waitFor(
      () =>
        fileItem(alice, fromBob)?.status === "received" &&
        fileItem(alice, fromCarol)?.status === "received",
      "both received",
    );
    expect(fileItem(alice, fromBob)?.from).toBe(ID.bobby);
    expect(fileItem(alice, fromCarol)?.from).toBe(ID.carol);
  });

  it("someone leaving mid-transfer doesn't stop it for the others: delivered to 1 of 2", async () => {
    const w = world({ maxPeers: 10 });
    const [alice, bob, carol] = await join(w, ["alice", "bobby", "carol"]);
    jam(alice, ID.carol);
    const fileId = await alice.sendFile(fileLike(data(5 * 16_384)));
    await waitFor(() => fileItem(bob, fileId)?.status === "received", "bob received");
    await waitFor(() => fileItem(carol, fileId)?.status === "receiving", "carol receiving");
    expect(fileItem(alice, fileId)?.status).toBe("sending");

    await carol.leave();
    await waitFor(() => fileItem(alice, fileId)?.status === "delivered", "delivered to bob");
    expect(fileItem(alice, fileId)).toMatchObject({ recipients: 2, delivered: 1, progress: 1 });
    expect(fileItem(alice, fileId)?.error).toBeUndefined();
    expect(status(alice)).toBe("sealed");
  });

  it("cancelling stops the copies still in flight; finished copies stay delivered", async () => {
    const w = world({ maxPeers: 10 });
    const [alice, bob, carol] = await join(w, ["alice", "bobby", "carol"]);
    jam(alice, ID.carol);
    const fileId = await alice.sendFile(fileLike(data(5 * 16_384)));
    await waitFor(() => fileItem(bob, fileId)?.status === "received", "bob received");
    await waitFor(() => fileItem(alice, fileId)?.delivered === 1, "bob's copy verified");
    alice.abortTransfer(fileId);
    await waitFor(() => fileItem(carol, fileId)?.status === "failed", "carol told");
    await waitFor(() => fileItem(alice, fileId)?.status === "delivered", "settled");
    expect(fileItem(alice, fileId)).toMatchObject({ delivered: 1, recipients: 2 });
    expect(fileItem(carol, fileId)?.error).toBe("cancelled");
  });

  it("when every copy fails, the item says why", async () => {
    const w = world({ maxPeers: 10 });
    const [alice, bob, carol] = await join(w, ["alice", "bobby", "carol"]);
    jam(alice, ID.bobby);
    jam(alice, ID.carol);
    const fileId = await alice.sendFile(fileLike(data(5 * 16_384)));
    await waitFor(
      () =>
        fileItem(bob, fileId)?.status === "receiving" &&
        fileItem(carol, fileId)?.status === "receiving",
      "both receiving",
    );
    bob.abortTransfer(fileId);
    carol.abortTransfer(fileId);
    await waitFor(() => fileItem(alice, fileId)?.status === "failed", "failed");
    expect(fileItem(alice, fileId)).toMatchObject({ delivered: 0, error: "cancelled" });
  });
});
