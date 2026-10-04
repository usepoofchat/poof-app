import { describe, expect, it } from "vitest";
import {
  CHAT_MAX_CHARS,
  CloseCode,
  FILE_CHUNK_BYTES,
  FRAME,
  FrameType,
  Channel,
  HANDSHAKE_ID_LENGTH,
  ID_LENGTH,
  PROTOCOL_VERSION,
  ROOM_KEY_LENGTH,
  TERMINAL_CLOSE_CODES,
  TIER_TTL_SECONDS,
  chatPlaintextSchema,
  clientMessageSchema,
  createRoomRequestSchema,
  createRoomResponseSchema,
  ctlPlaintextSchema,
  fileAbortSchema,
  fileAckSchema,
  fileEndSchema,
  fileMetaSchema,
  isHandshakeId,
  isPeerId,
  isRoomId,
  putHandshakeRequestSchema,
  roomInfoSchema,
  roomKeySchema,
  serverMessageSchema,
  signalPayloadSchema,
  pqMessageSchema,
} from "../src/index.ts";

const id = "A".repeat(ID_LENGTH);
const limits = { fileTransfer: false, fileMaxBytes: 2_097_152 };
const v = PROTOCOL_VERSION;

describe("constants", () => {
  it("tier lifetimes match the product rules", () => {
    expect(TIER_TTL_SECONDS).toEqual({ free: 600, "60m": 3600, "24h": 86_400 });
  });

  it("close codes are unique application codes", () => {
    const codes = Object.values(CloseCode);
    expect(new Set(codes).size).toBe(codes.length);
    for (const c of codes) expect(c).toBeGreaterThanOrEqual(4000);
    expect(TERMINAL_CLOSE_CODES.has(CloseCode.RateLimited)).toBe(false); // retryable
    expect(TERMINAL_CLOSE_CODES.has(CloseCode.RoomExpired)).toBe(true);
  });

  it("frame header is version + channel + type + 8-byte seq", () => {
    expect(FRAME.HEADER_BYTES).toBe(1 + 1 + 1 + 8);
    expect(FRAME.NONCE_BYTES).toBe(12);
    expect(Object.values(Channel)).toEqual([1, 2]);
    expect(new Set(Object.values(FrameType)).size).toBe(Object.values(FrameType).length);
  });

  it("a file chunk frame fits in one DataChannel message on every browser", () => {
    const chunkFrame = FRAME.HEADER_BYTES + 16 + 4 + FILE_CHUNK_BYTES + FRAME.TAG_BYTES;
    expect(chunkFrame).toBeLessThanOrEqual(64 * 1024);
  });
});

describe("ids", () => {
  it("validates length and alphabet", () => {
    expect(isRoomId(id)).toBe(true);
    expect(isPeerId(id)).toBe(true);
    expect(isRoomId("A".repeat(21))).toBe(false);
    expect(isRoomId("A".repeat(23))).toBe(false);
    expect(isRoomId("A".repeat(21) + "+")).toBe(false);
    expect(isRoomId("A".repeat(21) + "=")).toBe(false);
    expect(isRoomId(undefined)).toBe(false);
    expect(isRoomId(42)).toBe(false);
    expect(isHandshakeId("A".repeat(HANDSHAKE_ID_LENGTH))).toBe(true);
    expect(isHandshakeId(id)).toBe(false);
    expect(roomKeySchema.safeParse("A".repeat(ROOM_KEY_LENGTH)).success).toBe(true);
    expect(roomKeySchema.safeParse("A".repeat(ROOM_KEY_LENGTH - 1)).success).toBe(false);
  });

  it("accepts the full base64url alphabet", () => {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    expect(isRoomId("-_".repeat(11))).toBe(true);
    expect(isRoomId(alphabet.slice(0, ID_LENGTH))).toBe(true);
    expect(isRoomId(alphabet.slice(-ID_LENGTH))).toBe(true);
  });
});

describe("signal payloads", () => {
  it("accepts offer, answer and candidate", () => {
    expect(signalPayloadSchema.safeParse({ kind: "offer", sdp: "v=0" }).success).toBe(true);
    expect(signalPayloadSchema.safeParse({ kind: "answer", sdp: "v=0" }).success).toBe(true);
    expect(
      signalPayloadSchema.safeParse({
        kind: "candidate",
        candidate: {
          candidate: "candidate:1",
          sdpMid: "0",
          sdpMLineIndex: 0,
          usernameFragment: null,
        },
      }).success,
    ).toBe(true);
    expect(
      signalPayloadSchema.safeParse({ kind: "candidate", candidate: { candidate: "" } }).success,
    ).toBe(true);
  });

  it("rejects unknown kinds, wrong types and oversized sdp", () => {
    expect(signalPayloadSchema.safeParse({ kind: "pranswer", sdp: "x" }).success).toBe(false);
    expect(signalPayloadSchema.safeParse({ kind: "offer" }).success).toBe(false);
    expect(signalPayloadSchema.safeParse({ kind: "offer", sdp: 1 }).success).toBe(false);
    expect(signalPayloadSchema.safeParse({ kind: "offer", sdp: "x".repeat(12_001) }).success).toBe(
      false,
    );
    expect(
      signalPayloadSchema.safeParse({
        kind: "candidate",
        candidate: { candidate: "x".repeat(2049) },
      }).success,
    ).toBe(false);
    expect(
      signalPayloadSchema.safeParse({
        kind: "candidate",
        candidate: { candidate: "c", sdpMLineIndex: -1 },
      }).success,
    ).toBe(false);
  });
});

describe("client messages", () => {
  it("accepts signal, destroy and leave", () => {
    expect(
      clientMessageSchema.safeParse({ v, t: "signal", payload: { kind: "offer", sdp: "x" } })
        .success,
    ).toBe(true);
    expect(
      clientMessageSchema.safeParse({
        v,
        t: "signal",
        to: id,
        payload: { kind: "offer", sdp: "x" },
      }).success,
    ).toBe(true);
    expect(
      clientMessageSchema.safeParse({
        v,
        t: "signal",
        to: "bad",
        payload: { kind: "offer", sdp: "x" },
      }).success,
    ).toBe(false);
    expect(
      clientMessageSchema.safeParse({ v, t: "destroy", ownerSecret: "S".repeat(43) }).success,
    ).toBe(true);
    expect(clientMessageSchema.safeParse({ v, t: "leave" }).success).toBe(true);
  });

  it("destroy needs a well-formed owner secret", () => {
    expect(clientMessageSchema.safeParse({ v, t: "destroy" }).success).toBe(false);
    expect(
      clientMessageSchema.safeParse({ v, t: "destroy", ownerSecret: "S".repeat(42) }).success,
    ).toBe(false);
    expect(
      clientMessageSchema.safeParse({ v, t: "destroy", ownerSecret: `${"S".repeat(42)}=` }).success,
    ).toBe(false);
  });

  it("rejects wrong versions, unknown types and missing fields", () => {
    expect(clientMessageSchema.safeParse({ v: 2, t: "leave" }).success).toBe(false);
    expect(clientMessageSchema.safeParse({ t: "leave" }).success).toBe(false);
    expect(clientMessageSchema.safeParse({ v, t: "ping" }).success).toBe(false);
    expect(clientMessageSchema.safeParse({ v, t: "signal" }).success).toBe(false);
    expect(clientMessageSchema.safeParse("leave").success).toBe(false);
    expect(clientMessageSchema.safeParse(null).success).toBe(false);
  });
});

describe("server messages", () => {
  const base = { v };
  const samples = [
    {
      t: "welcome",
      roomId: id,
      peerId: id,
      plan: "free",
      tier: "free",
      expiresAt: 1,
      serverNow: 1,
      maxPeers: 2,
      peers: 1,
      members: [],
      limits,
    },
    {
      t: "paired",
      role: "initiator",
      peerId: id,
      iceServers: [{ urls: "stun:x" }, { urls: ["turn:y"], username: "u", credential: "c" }],
    },
    { t: "signal", from: id, payload: { kind: "answer", sdp: "x" } },
    { t: "peer.left", peerId: id, reason: "leave" },
    { t: "replaced" },
    { t: "room.expired" },
    { t: "room.destroyed", by: id },
    {
      t: "room.upgraded",
      plan: "super",
      tier: "60m",
      expiresAt: 1,
      serverNow: 1,
      maxPeers: 4,
      limits: { fileTransfer: true, fileMaxBytes: 1 },
      iceServers: [{ urls: "turns:turn.example:443?transport=tcp", username: "u", credential: "c" }],
    },
    { t: "rejected", code: 4003, reason: "room_full" },
    { t: "error", code: "not_paired", message: "m" },
  ];

  it.each(samples)("parses %j", (sample) => {
    expect(serverMessageSchema.safeParse({ ...base, ...sample }).success).toBe(true);
  });

  it("rejects malformed variants", () => {
    expect(
      serverMessageSchema.safeParse({
        ...base,
        t: "paired",
        role: "boss",
        peerId: id,
        iceServers: [],
      }).success,
    ).toBe(false);
    expect(
      serverMessageSchema.safeParse({ ...base, t: "peer.left", peerId: id, reason: "kicked" })
        .success,
    ).toBe(false);
    expect(serverMessageSchema.safeParse({ ...base, t: "welcome", roomId: "short" }).success).toBe(
      false,
    );
    expect(
      serverMessageSchema.safeParse({ ...base, t: "signal", payload: { kind: "answer", sdp: "x" } })
        .success,
    ).toBe(false);
    expect(
      serverMessageSchema.safeParse({ ...base, t: "error", code: "nope", message: "m" }).success,
    ).toBe(false);
    expect(serverMessageSchema.safeParse({ t: "room.expired" }).success).toBe(false);
    expect(
      serverMessageSchema.safeParse({ ...base, t: "rejected", code: 1000, reason: "x" }).success,
    ).toBe(false);
    expect(
      serverMessageSchema.safeParse({ ...base, t: "rejected", code: 4003, reason: "x".repeat(65) })
        .success,
    ).toBe(false);
  });
});

describe("HTTP schemas", () => {
  const room = {
    roomId: id,
    expiresAt: 10,
    serverNow: 5,
    plan: "free",
    tier: "free",
    maxPeers: 2,
    limits,
  };

  it("create response and room info", () => {
    expect(createRoomResponseSchema.safeParse(room).success).toBe(true);
    expect(roomInfoSchema.safeParse({ ...room, peers: 1 }).success).toBe(true);
    expect(roomInfoSchema.safeParse(room).success).toBe(false); // peers required
    expect(createRoomResponseSchema.safeParse({ ...room, tier: "forever" }).success).toBe(false);
    expect(createRoomResponseSchema.safeParse({ ...room, maxPeers: 0 }).success).toBe(false);
    expect(
      createRoomResponseSchema.safeParse({
        ...room,
        limits: { fileTransfer: true, fileMaxBytes: -1 },
      }).success,
    ).toBe(false);
  });

  it("handshake put body", () => {
    expect(putHandshakeRequestSchema.safeParse({ blob: "YWJj" }).success).toBe(true);
    expect(putHandshakeRequestSchema.safeParse({ blob: "YW_j-" }).success).toBe(true);
    expect(putHandshakeRequestSchema.safeParse({ blob: "" }).success).toBe(false);
    expect(putHandshakeRequestSchema.safeParse({ blob: "not base64!" }).success).toBe(false);
    expect(putHandshakeRequestSchema.safeParse({ blob: "A".repeat(2049) }).success).toBe(false);
    expect(putHandshakeRequestSchema.safeParse({}).success).toBe(false);
  });
});

describe("DataChannel schemas", () => {
  it("pq messages", () => {
    expect(pqMessageSchema.safeParse({ v, t: "pq.hello", pk: "AAAA" }).success).toBe(true);
    expect(
      pqMessageSchema.safeParse({ v, t: "pq.reply", ct: "AAAA", confirm: "AAAA" }).success,
    ).toBe(true);
    expect(pqMessageSchema.safeParse({ v, t: "pq.confirm", confirm: "AAAA" }).success).toBe(true);
    expect(pqMessageSchema.safeParse({ v, t: "pq.hello" }).success).toBe(false);
    expect(pqMessageSchema.safeParse({ v: 9, t: "pq.hello", pk: "AAAA" }).success).toBe(false);
    expect(pqMessageSchema.safeParse({ v, t: "pq.hello", pk: "A".repeat(4097) }).success).toBe(
      false,
    );
  });

  it("chat plaintext enforces the length cap", () => {
    expect(chatPlaintextSchema.safeParse({ id: "1", text: "hi", ts: 1 }).success).toBe(true);
    expect(chatPlaintextSchema.safeParse({ id: "1", text: "", ts: 1 }).success).toBe(false);
    expect(
      chatPlaintextSchema.safeParse({ id: "1", text: "x".repeat(CHAT_MAX_CHARS), ts: 1 }).success,
    ).toBe(true);
    expect(
      chatPlaintextSchema.safeParse({ id: "1", text: "x".repeat(CHAT_MAX_CHARS + 1), ts: 1 })
        .success,
    ).toBe(false);
    expect(chatPlaintextSchema.safeParse({ id: "", text: "x", ts: 1 }).success).toBe(false);
  });

  it("control plaintext", () => {
    expect(ctlPlaintextSchema.safeParse({ kind: "bye" }).success).toBe(true);
    expect(ctlPlaintextSchema.safeParse({ kind: "connection_type", value: "relay" }).success).toBe(
      true,
    );
    expect(ctlPlaintextSchema.safeParse({ kind: "connection_type", value: "lan" }).success).toBe(
      false,
    );
    expect(ctlPlaintextSchema.safeParse({ kind: "nuke" }).success).toBe(false);
  });

  it("carries nicknames and member lists for group rooms", () => {
    expect(ctlPlaintextSchema.safeParse({ kind: "hello", nickname: "Ana" }).success).toBe(true);
    expect(ctlPlaintextSchema.safeParse({ kind: "hello", nickname: null }).success).toBe(true);
    expect(ctlPlaintextSchema.safeParse({ kind: "hello", nickname: "x".repeat(500) }).success).toBe(
      false,
    );
    expect(ctlPlaintextSchema.safeParse({ kind: "members", peerIds: [id] }).success).toBe(true);
    expect(
      ctlPlaintextSchema.safeParse({ kind: "members", peerIds: Array(11).fill(id) }).success,
    ).toBe(false);
    expect(ctlPlaintextSchema.safeParse({ kind: "members", peerIds: ["bad"] }).success).toBe(false);
  });
});

describe("file transfer schemas", () => {
  const meta = {
    fileId: id,
    name: "a.png",
    size: 10,
    mime: "image/png",
    chunks: 1,
    sha256: "h".repeat(43),
  };

  it("file.meta", () => {
    expect(fileMetaSchema.safeParse(meta).success).toBe(true);
    expect(fileMetaSchema.safeParse({ ...meta, size: 0, chunks: 0 }).success).toBe(true);
    expect(fileMetaSchema.safeParse({ ...meta, fileId: "short" }).success).toBe(false);
    expect(fileMetaSchema.safeParse({ ...meta, size: -1 }).success).toBe(false);
    expect(fileMetaSchema.safeParse({ ...meta, size: 1.5 }).success).toBe(false);
    expect(fileMetaSchema.safeParse({ ...meta, chunks: -1 }).success).toBe(false);
    expect(fileMetaSchema.safeParse({ ...meta, sha256: "h".repeat(42) }).success).toBe(false);
    expect(fileMetaSchema.safeParse({ ...meta, name: "x".repeat(1025) }).success).toBe(false);
    expect(fileMetaSchema.safeParse({ ...meta, mime: "x".repeat(256) }).success).toBe(false);
  });

  it("file.end, file.abort, file.ack", () => {
    expect(fileEndSchema.safeParse({ fileId: id }).success).toBe(true);
    expect(fileEndSchema.safeParse({}).success).toBe(false);
    for (const reason of ["cancelled", "not_allowed", "too_large", "busy", "invalid"]) {
      expect(fileAbortSchema.safeParse({ fileId: id, reason }).success).toBe(true);
    }
    expect(fileAbortSchema.safeParse({ fileId: id, reason: "bored" }).success).toBe(false);
    expect(fileAckSchema.safeParse({ fileId: id, ok: true }).success).toBe(true);
    expect(fileAckSchema.safeParse({ fileId: id, ok: "yes" }).success).toBe(false);
  });
});

describe("create room request", () => {
  it("requires the creator's owner hash", () => {
    expect(createRoomRequestSchema.safeParse({ ownerHash: "h".repeat(43) }).success).toBe(true);
    expect(createRoomRequestSchema.safeParse({}).success).toBe(false);
    expect(createRoomRequestSchema.safeParse({ ownerHash: "h".repeat(44) }).success).toBe(false);
    expect(
      createRoomRequestSchema.safeParse({ ownerHash: "not base64url!".padEnd(43, "x") }).success,
    ).toBe(false);
  });
});
