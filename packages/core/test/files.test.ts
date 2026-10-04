import { FILE_CHUNK_BYTES, FrameType, type FrameTypeId, type Limits } from "@poof/protocol";
import { describe, expect, it } from "vitest";
import {
  FileLane,
  chunkCount,
  decodeChunk,
  encodeChunk,
  fromBase64Url,
  fromUtf8,
  hashFile,
  randomBytes,
  toBase64Url,
  utf8,
  type Bytes,
  type FileFailReason,
  type IncomingFileInfo,
  type OutgoingFile,
  type SendResult,
} from "../src/index.ts";
import { tick, waitFor } from "./fakes.ts";

const MAX = 2 * 1024 * 1024;

/** Byte-for-byte equality. (`toEqual` on a 2 MB Uint8Array takes seconds.) */
function expectSameBytes(actual: Uint8Array | undefined, expected: Uint8Array): void {
  expect(actual).toBeInstanceOf(Uint8Array);
  expect(Buffer.from(actual!).equals(Buffer.from(expected))).toBe(true);
}

/** Stands in for the channel's send buffer: the test closes it to hold the sender at its backpressure check. */
class Gate {
  private open = true;
  private waiters: Array<() => void> = [];
  /** Close by itself on this backpressure check (1-based), e.g. "after two chunks". */
  holdAt: number | null = null;
  calls = 0;
  hold(): void {
    this.open = false;
  }
  release(): void {
    this.open = true;
    this.holdAt = null;
    for (const w of this.waiters.splice(0)) w();
  }
  wait = (): Promise<void> => {
    this.calls++;
    if (this.holdAt !== null && this.calls >= this.holdAt) this.open = false;
    return this.open ? Promise.resolve() : new Promise((resolve) => this.waiters.push(resolve));
  };
}

interface Side {
  lane: FileLane;
  limits: Limits;
  gate: Gate;
  /** Frames this side put on the wire (before tampering). */
  sent: Array<{ type: FrameTypeId; plaintext: Bytes }>;
  started: IncomingFileInfo[];
  received: Map<string, Bytes>;
  failed: Map<string, FileFailReason>;
  progress: number[];
  refuse: boolean;
  broken: boolean;
  /** Rewrite (or drop, with null) what this side sends. */
  tamper: ((type: FrameTypeId, plaintext: Bytes) => Bytes | null) | null;
}

/** Two lanes wired back to back, delivering frames in order, like one member link. */
function pair(ackTimeoutMs?: number) {
  const make = (): Side => ({
    lane: null as unknown as FileLane,
    limits: { fileTransfer: true, fileMaxBytes: MAX },
    gate: new Gate(),
    sent: [],
    started: [],
    received: new Map(),
    failed: new Map(),
    progress: [],
    refuse: false,
    broken: false,
    tamper: null,
  });
  const a = make();
  const b = make();
  for (const [side, other] of [
    [a, b],
    [b, a],
  ] as const) {
    let inbound: Promise<void> = Promise.resolve();
    side.lane = new FileLane(
      {
        send: (type, plaintext) => {
          if (side.broken) return Promise.reject(new Error("gone"));
          const copy = plaintext.slice();
          side.sent.push({ type, plaintext: copy });
          const out = side.tamper ? side.tamper(type, copy) : copy;
          if (out) inbound = inbound.then(() => other.lane.handle(type, out.slice()));
          return Promise.resolve();
        },
        ready: side.gate.wait,
      },
      {
        limits: () => side.limits,
        incomingStart: (info) => {
          if (side.refuse) return false;
          side.started.push(info);
          return true;
        },
        incomingProgress: (_id, n) => side.progress.push(n),
        incomingDone: (id, bytes) => side.received.set(id, bytes),
        incomingFailed: (id, reason) => side.failed.set(id, reason),
      },
      ackTimeoutMs,
    );
  }
  return { a, b };
}

function data(size: number): Bytes {
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i += 65_536) out.set(randomBytes(Math.min(65_536, size - i)), i);
  return out;
}

async function file(bytes: Bytes, overrides: Partial<OutgoingFile> = {}): Promise<OutgoingFile> {
  return {
    fileId: toBase64Url(randomBytes(16)),
    name: "photo.png",
    mime: "image/png",
    bytes,
    sha256: await hashFile(bytes),
    ...overrides,
  };
}

const json = (value: unknown) => utf8(JSON.stringify(value));
const types = (side: Side) => side.sent.map((f) => f.type);
const sentJson = (side: Side, type: FrameTypeId) =>
  side.sent
    .filter((f) => f.type === type)
    .map((f) => JSON.parse(fromUtf8(f.plaintext)) as Record<string, unknown>);

/** Send and collect progress reports. */
function send(side: Side, out: OutgoingFile) {
  const progress: Array<[number, boolean]> = [];
  const result = side.lane.send(out, (n, all) => progress.push([n, all]));
  return { result, progress };
}

describe("chunk framing", () => {
  it("is fileId(16) ‖ index(4, BE) ‖ data, and round-trips", () => {
    const id = randomBytes(16);
    const encoded = encodeChunk(id, 0x01020304, utf8("abc"));
    expect(encoded.length).toBe(16 + 4 + 3);
    expect([...encoded.subarray(16, 20)]).toEqual([1, 2, 3, 4]);
    const decoded = decodeChunk(encoded);
    expect(decoded?.fileId).toBe(toBase64Url(id));
    expect(decoded?.index).toBe(0x01020304);
    expect(fromUtf8(decoded!.data)).toBe("abc");
    expect(decodeChunk(new Uint8Array(19))).toBeNull();
  });

  it("counts chunks", () => {
    expect(chunkCount(0)).toBe(0);
    expect(chunkCount(1)).toBe(1);
    expect(chunkCount(FILE_CHUNK_BYTES)).toBe(1);
    expect(chunkCount(FILE_CHUNK_BYTES + 1)).toBe(2);
    expect(chunkCount(MAX)).toBe(128);
  });
});

describe("FileLane: a file from one side to the other", () => {
  it("a 2 MB file arrives byte for byte, verified, with progress on both sides", async () => {
    const { a, b } = pair();
    const out = await file(data(MAX));
    const { result, progress } = send(a, out);
    expect(await result).toEqual({ ok: true });

    expectSameBytes(b.received.get(out.fileId), out.bytes);
    expect(b.started).toEqual([
      { fileId: out.fileId, name: "photo.png", size: MAX, mime: "image/png" },
    ]);
    expect(types(a)).toEqual([
      FrameType.FileMeta,
      ...Array<number>(128).fill(FrameType.FileChunk),
      FrameType.FileEnd,
    ]);
    expect(sentJson(b, FrameType.FileAck)).toEqual([{ fileId: out.fileId, ok: true }]);
    // Sender: one report per chunk, then "all sent".
    expect(progress).toHaveLength(129);
    expect(progress.at(-1)).toEqual([MAX, true]);
    expect(progress.slice(0, -1).every(([, all]) => !all)).toBe(true);
    // Receiver: strictly increasing up to the size.
    expect(b.progress.at(-1)).toBe(MAX);
    expect(b.progress.every((n, i) => i === 0 || n > b.progress[i - 1]!)).toBe(true);
  });

  it.each([0, 1, FILE_CHUNK_BYTES, FILE_CHUNK_BYTES + 1, 3 * FILE_CHUNK_BYTES - 7])(
    "edge size %i bytes",
    async (size) => {
      const { a, b } = pair();
      const out = await file(data(size));
      expect(await send(a, out).result).toEqual({ ok: true });
      expectSameBytes(b.received.get(out.fileId), out.bytes);
      expect(types(a).filter((t) => t === FrameType.FileChunk)).toHaveLength(chunkCount(size));
    },
  );

  it("waits for the channel to drain before queueing more chunks (backpressure)", async () => {
    const { a, b } = pair();
    a.gate.hold();
    const out = await file(data(5 * FILE_CHUNK_BYTES));
    const { result } = send(a, out);
    await waitFor(() => a.gate.calls === 1, "sender at the first backpressure check");
    await tick();
    expect(types(a)).toEqual([FrameType.FileMeta]); // no chunk while the buffer is "full"
    a.gate.release();
    expect(await result).toEqual({ ok: true });
    expect(a.gate.calls).toBe(5); // checked before every chunk
    expectSameBytes(b.received.get(out.fileId), out.bytes);
  });

  it("sends one file at a time: a second one waits for the first, so the receiver is never busy", async () => {
    const { a, b } = pair();
    const one = await file(data(3 * FILE_CHUNK_BYTES), { name: "one.bin" });
    const two = await file(data(2 * FILE_CHUNK_BYTES), { name: "two.bin" });
    const [r1, r2] = await Promise.all([send(a, one).result, send(a, two).result]);
    expect([r1, r2]).toEqual([{ ok: true }, { ok: true }]);
    expect(b.started.map((s) => s.name)).toEqual(["one.bin", "two.bin"]);
    expect(sentJson(b, FrameType.FileAbort)).toEqual([]);
    const metaAt = types(a).lastIndexOf(FrameType.FileMeta);
    const endAt = types(a).indexOf(FrameType.FileEnd);
    expect(metaAt).toBeGreaterThan(endAt); // file two started only after file one ended
  });

  it("the sender cancels mid-transfer: both sides stop, the receiver drops what it had", async () => {
    const { a, b } = pair();
    a.gate.holdAt = 3;
    const out = await file(data(10 * FILE_CHUNK_BYTES));
    const { result } = send(a, out);
    await waitFor(
      () => b.progress.length === 2 && a.gate.calls === 3,
      "two chunks in, sender waiting",
    );
    a.lane.cancel(out.fileId);
    a.gate.release();
    expect(await result).toEqual({ ok: false, reason: "cancelled" });
    await waitFor(() => b.failed.has(out.fileId), "receiver told");
    expect(b.failed.get(out.fileId)).toBe("cancelled");
    expect(b.received.size).toBe(0);
    expect(types(a)).not.toContain(FrameType.FileEnd);
    expect(sentJson(a, FrameType.FileAbort)).toEqual([{ fileId: out.fileId, reason: "cancelled" }]);
  });

  it("the receiver cancels mid-transfer: the sender stops", async () => {
    const { a, b } = pair();
    a.gate.hold();
    const out = await file(data(10 * FILE_CHUNK_BYTES));
    const { result } = send(a, out);
    await waitFor(() => b.started.length === 1, "announced");
    b.lane.cancel(out.fileId);
    expect(b.failed.get(out.fileId)).toBe("cancelled");
    expect(await result).toEqual({ ok: false, reason: "cancelled" });
    a.gate.release();
    await tick();
    expect(types(a).filter((t) => t === FrameType.FileChunk)).toHaveLength(0);
  });

  it("a cancelled queued file never starts", async () => {
    const { a, b } = pair();
    a.gate.hold();
    const one = await file(data(2 * FILE_CHUNK_BYTES));
    const two = await file(data(10));
    const first = send(a, one).result;
    const second = send(a, two).result;
    a.lane.cancel(two.fileId);
    a.gate.release();
    expect(await first).toEqual({ ok: true });
    expect(await second).toEqual({ ok: false, reason: "cancelled" });
    expect(sentJson(a, FrameType.FileMeta).map((m) => m.fileId)).toEqual([one.fileId]);
    expect(b.started).toHaveLength(1);
  });

  it("a receiver that refuses (too large for its room) stops the sender", async () => {
    const { a, b } = pair();
    b.limits = { fileTransfer: true, fileMaxBytes: 1000 };
    const out = await file(data(10 * FILE_CHUNK_BYTES));
    expect(await send(a, out).result).toEqual({ ok: false, reason: "too_large" });
    expect(b.started).toEqual([]);
    expect(types(a)).not.toContain(FrameType.FileEnd);
  });

  it("files off on the receiving side: refused with not_allowed (a modified sender gets nowhere)", async () => {
    const { a, b } = pair();
    b.limits = { fileTransfer: false, fileMaxBytes: 0 };
    const out = await file(data(100));
    expect(await send(a, out).result).toEqual({ ok: false, reason: "not_allowed" });
    expect(b.started).toEqual([]);
    expect(b.received.size).toBe(0);
  });

  it("a corrupted byte fails the hash check on both sides", async () => {
    const { a, b } = pair();
    a.tamper = (type, pt) => {
      if (type === FrameType.FileChunk) pt[pt.length - 1]! ^= 1;
      return pt;
    };
    const out = await file(data(FILE_CHUNK_BYTES + 5));
    expect(await send(a, out).result).toEqual({ ok: false, reason: "hash_mismatch" });
    expect(b.failed.get(out.fileId)).toBe("hash_mismatch");
    expect(b.received.size).toBe(0);
    expect(sentJson(b, FrameType.FileAck)).toEqual([{ fileId: out.fileId, ok: false }]);
  });

  it("no verdict from the receiver: the sender times out", async () => {
    const { a, b } = pair(40);
    b.tamper = (type, pt) => (type === FrameType.FileAck ? null : pt);
    const out = await file(data(10));
    const { result, progress } = send(a, out);
    expect(await result).toEqual({ ok: false, reason: "timeout" });
    expect(progress.at(-1)).toEqual([10, true]);
  });

  it("the link closes mid-transfer: both sides fail with connection_lost, queued files too", async () => {
    const { a, b } = pair();
    a.gate.hold();
    const out = await file(data(4 * FILE_CHUNK_BYTES));
    const later = await file(data(10));
    const first = send(a, out).result;
    const second = send(a, later).result;
    await waitFor(() => b.started.length === 1, "announced");
    a.lane.close();
    b.lane.close();
    expect(await first).toEqual({ ok: false, reason: "connection_lost" });
    expect(await second).toEqual({ ok: false, reason: "connection_lost" });
    expect(b.failed.get(out.fileId)).toBe("connection_lost");
  });

  it("the wire fails while sending: connection_lost", async () => {
    const { a } = pair();
    a.broken = true;
    expect(await send(a, await file(data(10))).result).toEqual({
      ok: false,
      reason: "connection_lost",
    });
  });
});

describe("FileLane: the receiver checks everything", () => {
  const ID = toBase64Url(new Uint8Array(16).fill(7));
  const OTHER = toBase64Url(new Uint8Array(16).fill(9));

  async function metaFor(bytes: Bytes, overrides: Record<string, unknown> = {}) {
    return {
      fileId: ID,
      name: "a.bin",
      size: bytes.length,
      mime: "application/x-thing",
      chunks: chunkCount(bytes.length),
      sha256: await hashFile(bytes),
      ...overrides,
    };
  }
  const chunk = (fileId: string, index: number, bytes: Uint8Array) =>
    encodeChunk(fromBase64Url(fileId), index, bytes);
  const aborts = (side: Side) => sentJson(side, FrameType.FileAbort);

  it("sanitises the name and keeps only previewable image types", async () => {
    const { b } = pair();
    await b.lane.handle(
      FrameType.FileMeta,
      json(await metaFor(new Uint8Array(1), { name: "../x\u0000/evil.html", mime: "text/html" })),
    );
    expect(b.started[0]).toMatchObject({
      name: ".._x_evil.html",
      mime: "application/octet-stream",
    });
    const { b: b2 } = pair();
    await b2.lane.handle(
      FrameType.FileMeta,
      json(await metaFor(new Uint8Array(1), { mime: " IMAGE/PNG " })),
    );
    expect(b2.started[0]?.mime).toBe("image/png");
    const { b: b3 } = pair();
    await b3.lane.handle(
      FrameType.FileMeta,
      json(await metaFor(new Uint8Array(1), { mime: "image/svg+xml" })),
    );
    expect(b3.started[0]?.mime).toBe("application/octet-stream");
  });

  it("refuses a file whose chunk count doesn't match its size", async () => {
    const { b } = pair();
    await b.lane.handle(
      FrameType.FileMeta,
      json(await metaFor(new Uint8Array(100), { chunks: 2 })),
    );
    expect(b.started).toEqual([]);
    expect(aborts(b)).toEqual([{ fileId: ID, reason: "invalid" }]);
  });

  it("refuses a fileId the session says is taken", async () => {
    const { b } = pair();
    b.refuse = true;
    await b.lane.handle(FrameType.FileMeta, json(await metaFor(new Uint8Array(1))));
    expect(aborts(b)).toEqual([{ fileId: ID, reason: "invalid" }]);
  });

  it("a second file while one is arriving is refused as busy; the first carries on", async () => {
    const { b } = pair();
    const bytes = data(FILE_CHUNK_BYTES + 1);
    await b.lane.handle(FrameType.FileMeta, json(await metaFor(bytes)));
    await b.lane.handle(FrameType.FileChunk, chunk(ID, 0, bytes.subarray(0, FILE_CHUNK_BYTES)));
    await b.lane.handle(
      FrameType.FileMeta,
      json(await metaFor(new Uint8Array(1), { fileId: OTHER })),
    );
    expect(aborts(b)).toEqual([{ fileId: OTHER, reason: "busy" }]);
    await b.lane.handle(FrameType.FileChunk, chunk(ID, 1, bytes.subarray(FILE_CHUNK_BYTES)));
    await b.lane.handle(FrameType.FileEnd, json({ fileId: ID }));
    expectSameBytes(b.received.get(ID), bytes);
  });

  it("the same file announced twice is invalid", async () => {
    const { b } = pair();
    const meta = json(await metaFor(new Uint8Array(10)));
    await b.lane.handle(FrameType.FileMeta, meta);
    await b.lane.handle(FrameType.FileMeta, meta);
    expect(b.failed.get(ID)).toBe("invalid");
  });

  it.each([
    ["skips an index", (bytes: Bytes) => [chunk(ID, 1, bytes.subarray(0, FILE_CHUNK_BYTES))]],
    [
      "repeats an index",
      (bytes: Bytes) => [
        chunk(ID, 0, bytes.subarray(0, FILE_CHUNK_BYTES)),
        chunk(ID, 0, bytes.subarray(0, FILE_CHUNK_BYTES)),
      ],
    ],
    ["sends a short middle chunk", (bytes: Bytes) => [chunk(ID, 0, bytes.subarray(0, 100))]],
    [
      "sends a long last chunk",
      (bytes: Bytes) => [
        chunk(ID, 0, bytes.subarray(0, FILE_CHUNK_BYTES)),
        chunk(ID, 1, new Uint8Array(11)),
      ],
    ],
    [
      "sends more bytes than declared",
      (bytes: Bytes) => [
        chunk(ID, 0, bytes.subarray(0, FILE_CHUNK_BYTES)),
        chunk(ID, 1, bytes.subarray(FILE_CHUNK_BYTES)),
        chunk(ID, 2, new Uint8Array(1)),
      ],
    ],
  ])("a sender that %s is cut off", async (_what, frames) => {
    const { b } = pair();
    const bytes = data(FILE_CHUNK_BYTES + 10);
    await b.lane.handle(FrameType.FileMeta, json(await metaFor(bytes)));
    for (const frame of frames(bytes)) await b.lane.handle(FrameType.FileChunk, frame);
    await b.lane.handle(FrameType.FileEnd, json({ fileId: ID }));
    expect(b.failed.get(ID)).toBe("invalid");
    expect(aborts(b)).toEqual([{ fileId: ID, reason: "invalid" }]);
    expect(b.received.size).toBe(0);
  });

  it("an end before every chunk arrived is invalid", async () => {
    const { b } = pair();
    const bytes = data(FILE_CHUNK_BYTES + 10);
    await b.lane.handle(FrameType.FileMeta, json(await metaFor(bytes)));
    await b.lane.handle(FrameType.FileChunk, chunk(ID, 0, bytes.subarray(0, FILE_CHUNK_BYTES)));
    await b.lane.handle(FrameType.FileEnd, json({ fileId: ID }));
    expect(b.failed.get(ID)).toBe("invalid");
  });

  it("ignores garbage and frames for files it doesn't know", async () => {
    const { b } = pair();
    await b.lane.handle(FrameType.FileMeta, utf8("{not json"));
    await b.lane.handle(FrameType.FileMeta, json({ fileId: "short" }));
    await b.lane.handle(FrameType.FileChunk, chunk(OTHER, 0, new Uint8Array(5)));
    await b.lane.handle(FrameType.FileChunk, new Uint8Array(3));
    await b.lane.handle(FrameType.FileEnd, json({ fileId: OTHER }));
    await b.lane.handle(FrameType.FileAck, json({ fileId: OTHER, ok: true }));
    await b.lane.handle(FrameType.FileAbort, json({ fileId: OTHER, reason: "cancelled" }));
    expect(b.started).toEqual([]);
    expect(b.failed.size).toBe(0);
    expect(b.sent).toEqual([]);
  });

  it("an empty file is fine", async () => {
    const { b } = pair();
    await b.lane.handle(FrameType.FileMeta, json(await metaFor(new Uint8Array(0))));
    await b.lane.handle(FrameType.FileEnd, json({ fileId: ID }));
    expect(b.received.get(ID)).toEqual(new Uint8Array(0));
  });

  it("does nothing once closed", async () => {
    const { b } = pair();
    b.lane.close();
    await b.lane.handle(FrameType.FileMeta, json(await metaFor(new Uint8Array(1))));
    expect(b.started).toEqual([]);
    expect(b.sent).toEqual([]);
  });

  it("a result is reported once", async () => {
    const { a, b } = pair();
    const out = await file(data(10));
    const results: SendResult[] = [];
    await a.lane.send(out, () => {}).then((r) => results.push(r));
    a.lane.cancel(out.fileId);
    a.lane.close();
    await tick();
    expect(results).toEqual([{ ok: true }]);
    expect(b.received.size).toBe(1);
  });
});
