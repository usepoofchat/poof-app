import {
  CHAT_MAX_CHARS,
  Channel,
  FILE_CHUNK_BYTES,
  FILE_NAME_MAX_CHARS,
  FRAME,
  FrameType,
  NICKNAME_MAX_CHARS,
  type ChannelId,
  type FrameTypeId,
} from "@poof/protocol";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { importAesKey } from "../src/crypto/primitives.ts";
import {
  FileLane,
  FrameCodec,
  InitiatorHandshake,
  PoofError,
  ResponderHandshake,
  chunkCount,
  decodeChunk,
  encodeChunk,
  fromBase64,
  fromBase64Url,
  generateRoomKey,
  hashFile,
  normalizeChatText,
  normalizeNickname,
  normalizePhrase,
  parseRoomLocation,
  sanitizeFileName,
  toBase64,
  toBase64Url,
  utf8,
  type FileLaneHooks,
} from "../src/index.ts";

/**
 * Property-based tests ("fuzzing") for everything that parses bytes or text from the other peer or
 * the server. The claims: hostile input is refused with our own error codes, never crashes with
 * something else, never gets through as if it were authentic, and honest input always round-trips.
 */

const FRAME_ERRORS = new Set(["frame_invalid", "frame_out_of_order", "decrypt_failed"]);

type CodecKeys = ConstructorParameters<typeof FrameCodec>[0];

/** Two ends of one link. `bKeys` makes more fresh receivers (each expects seq 0 again). */
async function codecPair(): Promise<{ a: FrameCodec; b: FrameCodec; bKeys: CodecKeys }> {
  const k1 = await importAesKey(crypto.getRandomValues(new Uint8Array(32)));
  const k2 = await importAesKey(crypto.getRandomValues(new Uint8Array(32)));
  const bKeys = { sendKey: k2, recvKey: k1 };
  return { a: new FrameCodec({ sendKey: k1, recvKey: k2 }), b: new FrameCodec(bKeys), bKeys };
}

/** Rejects with a PoofError whose code is in `codes`. */
async function expectRefused(promise: Promise<unknown>, codes: Set<string>): Promise<void> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(PoofError);
  expect(codes).toContain((error as PoofError).code);
}

const channelAndType = fc.oneof(
  fc
    .constantFrom(FrameType.Chat, FrameType.Ctl)
    .map((type) => ({ channel: Channel.Ctl as ChannelId, type })),
  fc
    .constantFrom(
      FrameType.FileMeta,
      FrameType.FileChunk,
      FrameType.FileEnd,
      FrameType.FileAbort,
      FrameType.FileAck,
    )
    .map((type) => ({ channel: Channel.Files as ChannelId, type: type as FrameTypeId })),
);
const plaintext = fc.uint8Array({ maxLength: 2048 });

describe("frame decoder", () => {
  it("random bytes are refused with a frame error, never accepted", async () => {
    const { bKeys } = await codecPair();
    await fc.assert(
      fc.asyncProperty(fc.uint8Array({ maxLength: 512 }), async (data) => {
        const fresh = new FrameCodec(bKeys);
        await expectRefused(fresh.open(data), FRAME_ERRORS);
      }),
      { numRuns: 500 },
    );
  });

  it("random bodies behind a valid header are refused (authentication, not parsing)", async () => {
    const { bKeys } = await codecPair();
    await fc.assert(
      fc.asyncProperty(
        channelAndType,
        fc.uint8Array({ minLength: FRAME.TAG_BYTES, maxLength: 512 }),
        async (ct, body) => {
          const fresh = new FrameCodec(bKeys);
          const head = new Uint8Array(FRAME.HEADER_BYTES);
          head.set([FRAME.VERSION, ct.channel, ct.type]); // seq 0: the one a fresh codec expects
          const frame = new Uint8Array(head.length + body.length);
          frame.set(head);
          frame.set(body, head.length);
          await expectRefused(fresh.open(frame), new Set(["decrypt_failed"]));
        },
      ),
      { numRuns: 300 },
    );
  });

  it("honest frames round-trip in order, on both channels", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.tuple(channelAndType, plaintext), { maxLength: 20 }),
        async (frames) => {
          const { a, b } = await codecPair();
          const sealed = await Promise.all(frames.map(([ct, p]) => a.seal(ct.channel, ct.type, p)));
          for (const [i, frame] of sealed.entries()) {
            const [ct, p] = frames[i]!;
            const opened = await b.open(frame);
            expect(opened).toEqual({ channel: ct.channel, type: ct.type, plaintext: p });
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it("any change to a sealed frame is caught: one flipped byte, a cut, extra bytes", async () => {
    const tamper = fc.oneof(
      fc.record({
        kind: fc.constant("flip" as const),
        at: fc.nat(),
        xor: fc.integer({ min: 1, max: 255 }),
      }),
      fc.record({ kind: fc.constant("cut" as const), at: fc.nat() }),
      fc.record({
        kind: fc.constant("append" as const),
        extra: fc.uint8Array({ minLength: 1, maxLength: 32 }),
      }),
    );
    await fc.assert(
      fc.asyncProperty(channelAndType, plaintext, tamper, async (ct, p, t) => {
        const { a, b } = await codecPair();
        const frame = await a.seal(ct.channel, ct.type, p);
        let bad: Uint8Array;
        if (t.kind === "flip") {
          bad = frame.slice();
          const at = t.at % bad.length;
          bad[at] = bad[at]! ^ t.xor;
        } else if (t.kind === "cut") {
          bad = frame.slice(0, t.at % frame.length);
        } else {
          bad = new Uint8Array([...frame, ...t.extra]);
        }
        await expectRefused(b.open(bad), FRAME_ERRORS);
      }),
      { numRuns: 300 },
    );
  });

  it("replayed, skipped and reflected frames are refused", async () => {
    await fc.assert(
      fc.asyncProperty(channelAndType, plaintext, async (ct, p) => {
        const { a, b, bKeys } = await codecPair();
        const first = await a.seal(ct.channel, ct.type, p);
        const second = await a.seal(ct.channel, ct.type, p);
        // Reflection: a frame back at its sender doesn't open (directional keys).
        await expectRefused(a.open(first), new Set(["decrypt_failed"]));
        // Skipping one.
        await expectRefused(new FrameCodec(bKeys).open(second), new Set(["frame_out_of_order"]));
        // Replay.
        await b.open(first);
        await expectRefused(b.open(first), new Set(["frame_out_of_order"]));
      }),
      { numRuns: 50 },
    );
  });
});

describe("key exchange messages", () => {
  const b64ish = fc.oneof(
    fc.string({ maxLength: 64 }),
    fc.uint8Array({ maxLength: 1300 }).map((bytes) => toBase64(bytes)),
    fc
      .constantFrom(1184, 1088, 32)
      .chain((n) => fc.uint8Array({ minLength: n, maxLength: n }).map((bytes) => toBase64(bytes))),
  );
  const PAIR = { initiator: "i".repeat(22), responder: "r".repeat(22) };
  const ROOM = "AAAAAAAAAAAAAAAAAAAAAA";

  it("a forged pq.hello, pq.reply or pq.confirm fails as pq_failed", async () => {
    const roomKey = generateRoomKey();
    await fc.assert(
      fc.asyncProperty(b64ish, b64ish, async (x, y) => {
        // Responder receiving a hello with garbage (or a random but well-sized) key.
        const r = new ResponderHandshake(ROOM, roomKey, PAIR);
        const hello = r.handleHello({ v: 1, t: "pq.hello", pk: x });
        // A random 1184-byte string is a valid ML-KEM key, so it may be accepted: that's fine, the
        // confirmation MAC is what proves the other side has the room key.
        const accepted = await hello.then(
          () => true,
          (e: unknown) => {
            if (e instanceof PoofError && e.code === "pq_failed") return false;
            throw e;
          },
        );
        if (accepted) {
          await expectRefused(
            r.handleConfirm({ v: 1, t: "pq.confirm", confirm: y }),
            new Set(["pq_failed"]),
          );
        }

        // Initiator receiving a forged reply.
        const i = new InitiatorHandshake(ROOM, roomKey, PAIR);
        i.start();
        await expectRefused(
          i.handleReply({ v: 1, t: "pq.reply", ct: x, confirm: y }),
          new Set(["pq_failed"]),
        );
      }),
      { numRuns: 60 },
    );
  });
});

describe("file lane", () => {
  const LIMIT = 3 * FILE_CHUNK_BYTES + 100;
  // Canonical base64url of 16 bytes (the last character carries 2 bits), like real ids.
  const FILE_IDS = ["AAAAAAAAAAAAAAAAAAAAAA", "BBBBBBBBBBBBBBBBBBBBBA"];

  function lane() {
    const sent: Array<{ type: number; body: unknown }> = [];
    const done: Array<{ fileId: string; bytes: Uint8Array }> = [];
    const started: Array<{ fileId: string; size: number }> = [];
    const hooks: FileLaneHooks = {
      limits: () => ({ fileTransfer: true, fileMaxBytes: LIMIT }),
      incomingStart: (info) => {
        started.push(info);
        return true;
      },
      incomingProgress: () => undefined,
      incomingDone: (fileId, bytes) => done.push({ fileId, bytes }),
      incomingFailed: () => undefined,
    };
    const l = new FileLane(
      {
        send: (type, p) => {
          sent.push({ type, body: p });
          return Promise.resolve();
        },
        ready: () => Promise.resolve(),
      },
      hooks,
    );
    return { lane: l, sent, done, started };
  }

  const json = (value: unknown) => utf8(JSON.stringify(value));
  const fileId = fc.constantFrom(...FILE_IDS);
  /** Plausible frames with wrong pieces, and raw garbage. */
  const frame = fc.oneof(
    fc.record({
      type: fc.constant(FrameType.FileMeta),
      body: fc
        .record({
          fileId,
          name: fc.string({ maxLength: 40 }),
          size: fc.oneof(fc.nat({ max: LIMIT + 10 }), fc.integer()),
          mime: fc.string({ maxLength: 20 }),
          chunks: fc.integer({ min: -1, max: 6 }),
          sha256: fc.uint8Array({ minLength: 32, maxLength: 32 }).map(toBase64Url),
        })
        .map(json),
    }),
    fc.record({
      type: fc.constant(FrameType.FileChunk),
      body: fc
        .tuple(fileId, fc.nat({ max: 5 }), fc.integer({ min: 0, max: FILE_CHUNK_BYTES + 2 }))
        .map(([id, index, len]) => encodeChunk(fromBase64Url(id), index, new Uint8Array(len))),
    }),
    fc.record({
      type: fc.constant(FrameType.FileEnd),
      body: fileId.map((id) => json({ fileId: id })),
    }),
    fc.record({
      type: fc.constant(FrameType.FileAbort),
      body: fc.tuple(fileId, fc.string()).map(([id, reason]) => json({ fileId: id, reason })),
    }),
    fc.record({
      type: fc.constant(FrameType.FileAck),
      body: fileId.map((id) => json({ fileId: id, ok: true })),
    }),
    fc.record({
      type: fc.constantFrom(
        FrameType.FileMeta,
        FrameType.FileChunk,
        FrameType.FileEnd,
        FrameType.FileAbort,
        FrameType.FileAck,
      ),
      body: fc.uint8Array({ maxLength: 64 }),
    }),
  );

  it("never throws, never allocates over the limit, and only hands over files whose hash matched", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(frame, { maxLength: 30 }), async (frames) => {
        const { lane: l, done, started } = lane();
        for (const f of frames) await l.handle(f.type as FrameTypeId, f.body);
        for (const s of started) expect(s.size).toBeLessThanOrEqual(LIMIT);
        // Random hashes can't match random content: nothing is handed over unless it was empty and
        // the fuzzer happened to announce the empty file's hash (it can't, the hash is random).
        expect(done).toEqual([]);
      }),
      { numRuns: 300 },
    );
  });

  it("an honest transfer arrives intact, even after junk before it", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(frame, { maxLength: 10 }),
        fc.uint8Array({ maxLength: LIMIT }),
        async (junk, bytes) => {
          const { lane: l, done } = lane();
          for (const f of junk) await l.handle(f.type as FrameTypeId, f.body);
          // A sender aborts what it started; the receiver drops any half-received file on abort.
          for (const id of FILE_IDS)
            await l.handle(FrameType.FileAbort, json({ fileId: id, reason: "cancelled" }));

          const id = "ZZZZZZZZZZZZZZZZZZZZZQ";
          const chunks = chunkCount(bytes.length);
          const meta = {
            fileId: id,
            name: "a.bin",
            size: bytes.length,
            mime: "",
            chunks,
            sha256: await hashFile(bytes),
          };
          await l.handle(FrameType.FileMeta, json(meta));
          for (let i = 0; i < chunks; i++) {
            const data = bytes.subarray(i * FILE_CHUNK_BYTES, (i + 1) * FILE_CHUNK_BYTES);
            await l.handle(FrameType.FileChunk, encodeChunk(fromBase64Url(id), i, data));
          }
          await l.handle(FrameType.FileEnd, json({ fileId: id }));
          expect(done).toHaveLength(1);
          expect(done[0]!.bytes).toEqual(bytes);
        },
      ),
      { numRuns: 60 },
    );
  });

  it("decodeChunk never throws", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 64 }), (data) => {
        const chunk = decodeChunk(data);
        if (data.length < 20) expect(chunk).toBeNull();
        else expect(chunk?.data.length).toBe(data.length - 20);
      }),
    );
  });
});

describe("text from the other side", () => {
  // eslint-disable-next-line no-control-regex
  const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;
  // eslint-disable-next-line no-control-regex
  const CONTROL_ALL = /[\u0000-\u001F\u007F-\u009F]/;
  const anyText = fc.oneof(
    fc.string({ maxLength: 300 }),
    fc.string({ unit: "binary", maxLength: 300 }),
  );

  it("chat text: no control characters but newline and tab, trimmed, within the cap", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          anyText,
          fc.string({ unit: "binary", minLength: CHAT_MAX_CHARS, maxLength: CHAT_MAX_CHARS + 50 }),
        ),
        (s) => {
          const out = normalizeChatText(s);
          expect(out).not.toMatch(CONTROL);
          expect(out).not.toMatch(/\r/);
          expect(out).toBe(out.trim());
          expect(Array.from(out).length).toBeLessThanOrEqual(CHAT_MAX_CHARS);
        },
      ),
    );
  });

  it("file names: no path or reserved characters, never empty or dots only, within the cap", () => {
    fc.assert(
      fc.property(
        fc.oneof(anyText, fc.constantFrom("..", ".", "../../etc/passwd", "C:\\x", "\u202Egnp.exe")),
        (s) => {
          const out = sanitizeFileName(s);
          expect(out).not.toMatch(/[\\/:*?"<>|]/);
          expect(out).not.toMatch(CONTROL_ALL);
          expect(out).not.toMatch(/^\.+$/);
          expect(out.length).toBeGreaterThan(0);
          expect(Array.from(out).length).toBeLessThanOrEqual(FILE_NAME_MAX_CHARS);
        },
      ),
    );
  });

  it("nicknames: single-spaced, no control characters, within the cap, or null", () => {
    fc.assert(
      fc.property(anyText, (s) => {
        const out = normalizeNickname(s);
        if (out === null) return;
        expect(out).not.toMatch(CONTROL_ALL);
        expect(out).not.toMatch(/\s{2,}/);
        expect(out).toBe(out.trim());
        expect(out.length).toBeGreaterThan(0);
        expect(Array.from(out).length).toBeLessThanOrEqual(NICKNAME_MAX_CHARS);
      }),
    );
  });
});

describe("parsers of links, codes and manifests", () => {
  it("base64 and base64url round-trip, and garbage throws a plain Error", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 100 }), (bytes) => {
        expect(fromBase64(toBase64(bytes))).toEqual(bytes);
        expect(fromBase64Url(toBase64Url(bytes))).toEqual(bytes);
      }),
    );
    fc.assert(
      fc.property(fc.string({ maxLength: 60 }), (s) => {
        for (const decode of [fromBase64, fromBase64Url]) {
          try {
            decode(s);
          } catch (e) {
            expect(e).toBeInstanceOf(Error);
          }
        }
      }),
    );
  });

  it("room links: anything but /join/#<id>.<key> is invalid_link", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), fc.string({ maxLength: 60 }), (path, hash) => {
        try {
          const { roomId, key } = parseRoomLocation(path, hash);
          expect(roomId).toMatch(/^[A-Za-z0-9_-]{22}$/);
          expect(key.length).toBe(32);
        } catch (e) {
          expect(e).toBeInstanceOf(PoofError);
          expect((e as PoofError).code).toBe("invalid_link");
        }
      }),
    );
  });

  it("phrases: null or four lowercase words joined by dashes", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 80 }), (s) => {
        const out = normalizePhrase(s);
        if (out !== null) expect(out).toMatch(/^[a-z]+(-[a-z]+){3}$/);
      }),
    );
  });
});
