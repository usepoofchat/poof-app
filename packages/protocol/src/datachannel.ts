import { z } from "zod";
import {
  CHAT_MAX_CHARS,
  MAX_ROOM_PEERS,
  NICKNAME_MAX_CHARS,
  PROTOCOL_VERSION,
} from "./constants.ts";
import { fileIdSchema, peerIdSchema } from "./ids.ts";

/**
 * DataChannel protocol (peer ↔ peer). Never seen by the server.
 *
 * Phase 1 (key exchange) uses plain JSON *text* messages on the ctl channel.
 * Phase 2 (everything else) uses binary AEAD frames, see FRAME / FrameType below.
 */

// ── Phase 1: hybrid key exchange (text frames) ──────────────────────────────

const v = z.literal(PROTOCOL_VERSION);
const b64 = z.string().min(1).max(4096);

export const pqMessageSchema = z.discriminatedUnion("t", [
  /** Initiator → responder: ML-KEM-768 public key (1184 bytes). */
  z.object({ v, t: z.literal("pq.hello"), pk: b64 }),
  /** Responder → initiator: ML-KEM ciphertext (1088 bytes) + responder confirmation MAC. */
  z.object({ v, t: z.literal("pq.reply"), ct: b64, confirm: b64 }),
  /** Initiator → responder: initiator confirmation MAC. */
  z.object({ v, t: z.literal("pq.confirm"), confirm: b64 }),
]);
export type PqMessage = z.infer<typeof pqMessageSchema>;

// ── Phase 2: AEAD frames (binary) ───────────────────────────────────────────

/** Frame header: version(1) channel(1) type(1) seq(8). AAD = these 11 bytes. */
export const FRAME = {
  VERSION: 1,
  HEADER_BYTES: 11,
  TAG_BYTES: 16,
  NONCE_BYTES: 12,
} as const;

export const Channel = {
  /** Chat + control. */
  Ctl: 0x01,
  /** File transfer. */
  Files: 0x02,
} as const;
export type ChannelId = (typeof Channel)[keyof typeof Channel];

export const FrameType = {
  Chat: 0x01,
  Ctl: 0x02,
  /** An AI answer (see ai.ts), sent by whoever asked. */
  Ai: 0x03,
  FileMeta: 0x10,
  FileChunk: 0x11,
  FileEnd: 0x12,
  FileAbort: 0x13,
  FileAck: 0x14,
} as const;
export type FrameTypeId = (typeof FrameType)[keyof typeof FrameType];

/** DataChannel labels. */
export const CHANNEL_LABEL = { Ctl: "poof-ctl", Files: "poof-files" } as const;

// ── Plaintexts ──────────────────────────────────────────────────────────────

export const chatPlaintextSchema = z.object({
  id: z.string().min(1).max(64),
  text: z.string().min(1).max(CHAT_MAX_CHARS),
  ts: z.number().int(),
});
export type ChatPlaintext = z.infer<typeof chatPlaintextSchema>;

export const ctlPlaintextSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("connection_type"), value: z.enum(["direct", "relay"]) }),
  /** Graceful end of session; lets the peer tell "left" from "connection failed". */
  z.object({ kind: z.literal("bye") }),
  /** Optional display name (null = none). Sent after the handshake and whenever it changes. */
  z.object({
    kind: z.literal("hello"),
    nickname: z
      .string()
      .max(NICKNAME_MAX_CHARS * 4)
      .nullable(),
  }),
  /**
   * Group rooms: the members this side has a confirmed link with. Lets everyone notice a server
   * that shows different people to different members (split view).
   */
  z.object({ kind: z.literal("members"), peerIds: z.array(peerIdSchema).max(MAX_ROOM_PEERS) }),
  /**
   * The sender is typing (on) or stopped (off). A hint for the UI only: never stored, and it carries
   * no text. Older clients drop unknown control kinds, so they simply never show it.
   */
  z.object({ kind: z.literal("typing"), on: z.boolean() }),
  /**
   * The sender asked the AI (`askId` = their question's message id): `thinking` while the answer
   * streams in, `failed` if it never came. The answer itself is a FrameType.Ai frame.
   */
  z.object({
    kind: z.literal("ai"),
    askId: z.string().min(1).max(64),
    state: z.enum(["thinking", "failed"]),
  }),
]);
export type CtlPlaintext = z.infer<typeof ctlPlaintextSchema>;

// ── File transfer (files channel) ──

const sha256b64 = z.string().regex(/^[A-Za-z0-9_-]{43}$/, "invalid sha256");

/** Sender → receiver: start of a transfer. Encrypted like every frame; the receiver re-checks it all. */
export const fileMetaSchema = z.object({
  fileId: fileIdSchema,
  name: z.string().max(1024),
  size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  mime: z.string().max(255),
  chunks: z.number().int().nonnegative(),
  /** base64url(SHA-256(whole file)), checked by the receiver before it accepts the file. */
  sha256: sha256b64,
});
export type FileMeta = z.infer<typeof fileMetaSchema>;

/** Sender → receiver: every chunk has been sent. */
export const fileEndSchema = z.object({ fileId: fileIdSchema });

/**
 * Either side stops a transfer. `cancelled`: a person pressed cancel. The rest come from the
 * receiver refusing it: files are off in its room (`not_allowed`), over the cap (`too_large`),
 * another file from the same sender is still arriving (`busy`), or the frames don't add up (`invalid`).
 */
export const FILE_ABORT_REASONS = [
  "cancelled",
  "not_allowed",
  "too_large",
  "busy",
  "invalid",
] as const;
export type FileAbortReason = (typeof FILE_ABORT_REASONS)[number];
export const fileAbortSchema = z.object({
  fileId: fileIdSchema,
  reason: z.enum(FILE_ABORT_REASONS),
});

/** Receiver → sender: the whole file arrived; `ok` is false when its hash didn't match. */
export const fileAckSchema = z.object({ fileId: fileIdSchema, ok: z.boolean() });
