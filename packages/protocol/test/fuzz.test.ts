import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  FILE_MAX_BYTES_CEILING,
  MAX_ICE_SERVERS,
  MAX_ROOM_PEERS,
  chatPlaintextSchema,
  clientMessageSchema,
  ctlPlaintextSchema,
  fileAbortSchema,
  fileAckSchema,
  fileEndSchema,
  fileMetaSchema,
  pqMessageSchema,
  roomInfoSchema,
  serverMessageSchema,
} from "../src/index.ts";

/** Every schema that parses data from the network: the server, the other peer, or a client. */
const SCHEMAS = {
  clientMessageSchema,
  serverMessageSchema,
  roomInfoSchema,
  pqMessageSchema,
  chatPlaintextSchema,
  ctlPlaintextSchema,
  fileMetaSchema,
  fileEndSchema,
  fileAbortSchema,
  fileAckSchema,
};

/** Objects shaped like our messages, with random values, so the fuzzer gets past the `t` switch. */
const messageLike = fc.record(
  {
    v: fc.oneof(fc.constant(1), fc.anything()),
    t: fc.constantFrom(
      "signal",
      "leave",
      "destroy",
      "welcome",
      "paired",
      "rejected",
      "error",
      "pq.hello",
      "pq.reply",
      "__proto__",
    ),
    kind: fc.constantFrom(
      "offer",
      "answer",
      "candidate",
      "hello",
      "members",
      "bye",
      "connection_type",
      "constructor",
    ),
    payload: fc.anything({ maxDepth: 2 }),
    fileId: fc.string({ maxLength: 30 }),
    peerIds: fc.array(fc.string({ maxLength: 30 }), { maxLength: 20 }),
    iceServers: fc.array(fc.anything({ maxDepth: 2 }), { maxLength: 20 }),
  },
  { requiredKeys: [] },
);

describe("schemas under arbitrary input", () => {
  it("safeParse never throws, whatever arrives", () => {
    fc.assert(
      fc.property(fc.oneof(fc.anything(), fc.jsonValue(), messageLike), (value) => {
        for (const schema of Object.values(SCHEMAS))
          expect(() => schema.safeParse(value)).not.toThrow();
      }),
      { numRuns: 1000 },
    );
  });

  it("whatever passes stays within the caps clients rely on", () => {
    const welcome = fc.record({
      v: fc.constant(1),
      t: fc.constant("welcome"),
      roomId: fc.constant("A".repeat(22)),
      peerId: fc.constant("B".repeat(22)),
      plan: fc.constantFrom("free", "super"),
      tier: fc.constantFrom("free", "60m", "24h"),
      expiresAt: fc.integer(),
      serverNow: fc.integer(),
      maxPeers: fc.integer({ min: -5, max: 1000 }),
      peers: fc.integer({ min: -5, max: 1000 }),
      members: fc.array(fc.constant("C".repeat(22)), { maxLength: 30 }),
      limits: fc.record({
        fileTransfer: fc.boolean(),
        fileMaxBytes: fc.oneof(fc.nat(), fc.integer({ min: 2 ** 26, max: 2 ** 40 })),
      }),
    });
    const paired = fc.record({
      v: fc.constant(1),
      t: fc.constant("paired"),
      role: fc.constantFrom("initiator", "responder"),
      peerId: fc.constant("C".repeat(22)),
      iceServers: fc.array(
        fc.record({ urls: fc.array(fc.constant("turn:x"), { maxLength: 30 }) }),
        { maxLength: 30 },
      ),
    });
    fc.assert(
      fc.property(fc.oneof(welcome, paired), (value) => {
        const parsed = serverMessageSchema.safeParse(value);
        if (!parsed.success) return;
        const msg = parsed.data;
        if (msg.t === "welcome") {
          expect(msg.maxPeers).toBeLessThanOrEqual(MAX_ROOM_PEERS);
          expect(msg.peers).toBeLessThanOrEqual(MAX_ROOM_PEERS);
          expect(msg.members.length).toBeLessThanOrEqual(MAX_ROOM_PEERS);
          expect(msg.limits.fileMaxBytes).toBeLessThanOrEqual(FILE_MAX_BYTES_CEILING);
        } else if (msg.t === "paired") {
          expect(msg.iceServers.length).toBeLessThanOrEqual(MAX_ICE_SERVERS);
        }
      }),
      { numRuns: 500 },
    );
  });
});
