import { z } from "zod";
import { MAX_ICE_SERVERS, MAX_ICE_URLS, MAX_ROOM_PEERS, PROTOCOL_VERSION } from "./constants.ts";
import { limitsSchema, planSchema, tierSchema } from "./http.ts";
import { ownerSecretSchema, peerIdSchema, roomIdSchema } from "./ids.ts";

const v = z.literal(PROTOCOL_VERSION);

/** WebRTC signaling payload. Opaque to the server beyond this shape/size check. */
export const signalPayloadSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("offer"), sdp: z.string().max(12_000) }),
  z.object({ kind: z.literal("answer"), sdp: z.string().max(12_000) }),
  z.object({
    kind: z.literal("candidate"),
    candidate: z.object({
      candidate: z.string().max(2048),
      sdpMid: z.string().max(256).nullable().optional(),
      sdpMLineIndex: z.number().int().nonnegative().nullable().optional(),
      usernameFragment: z.string().max(256).nullable().optional(),
    }),
  }),
]);
export type SignalPayload = z.infer<typeof signalPayloadSchema>;

const iceUrl = z.string().max(512);
export const iceServerSchema = z.object({
  urls: z.union([iceUrl, z.array(iceUrl).max(MAX_ICE_URLS)]),
  username: z.string().max(512).optional(),
  credential: z.string().max(512).optional(),
});
export type IceServer = z.infer<typeof iceServerSchema>;

// ── client → server ─────────────────────────────────────────────────────────

export const clientMessageSchema = z.discriminatedUnion("t", [
  /**
   * `to` addresses one member in a group room. Without it the server relays to the only other
   * member, which is all a 2-person room ever needs.
   */
  z.object({
    v,
    t: z.literal("signal"),
    to: peerIdSchema.optional(),
    payload: signalPayloadSchema,
  }),
  /** Only the creator can destroy: `ownerSecret` must hash to the room's `ownerHash`. */
  z.object({ v, t: z.literal("destroy"), ownerSecret: ownerSecretSchema }),
  /**
   * The creator says who they are, so the server can tell everyone which member created the room
   * (`owner`). Sent after `welcome`, and only to a server whose `welcome` has `owner`.
   */
  z.object({ v, t: z.literal("claim"), ownerSecret: ownerSecretSchema }),
  /** Only the creator can remove someone: that member is disconnected and can't rejoin. */
  z.object({ v, t: z.literal("ban"), ownerSecret: ownerSecretSchema, peerId: peerIdSchema }),
  z.object({ v, t: z.literal("leave") }),
]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;

// ── server → client ─────────────────────────────────────────────────────────

export const peerRoleSchema = z.enum(["initiator", "responder"]);
export type PeerRole = z.infer<typeof peerRoleSchema>;

export const serverMessageSchema = z.discriminatedUnion("t", [
  z.object({
    v,
    t: z.literal("welcome"),
    roomId: roomIdSchema,
    peerId: peerIdSchema,
    plan: planSchema,
    tier: tierSchema,
    expiresAt: z.number().int(),
    /** Server clock at send time, so clients can correct skew in their countdown. */
    serverNow: z.number().int(),
    maxPeers: z.number().int().positive().max(MAX_ROOM_PEERS),
    /** Peers in the room, including this one. */
    peers: z.number().int().positive().max(MAX_ROOM_PEERS),
    /**
     * The member who proved they created the room (`claim`), or null while nobody has. Its presence
     * also tells the client this server understands `claim` and `ban`.
     */
    owner: peerIdSchema.nullable().optional(),
    /** The other members already present (a hint for the UI; links come with `paired`). */
    members: z.array(peerIdSchema).max(MAX_ROOM_PEERS),
    limits: limitsSchema,
    ai: z.boolean().default(false),
  }),
  z.object({
    v,
    t: z.literal("paired"),
    role: peerRoleSchema,
    peerId: peerIdSchema,
    iceServers: z.array(iceServerSchema).max(MAX_ICE_SERVERS),
  }),
  /** `from` is stamped by the server from the sender's socket, never taken from the client. */
  z.object({ v, t: z.literal("signal"), from: peerIdSchema, payload: signalPayloadSchema }),
  z.object({
    v,
    t: z.literal("peer.left"),
    peerId: peerIdSchema,
    reason: z.enum(["closed", "leave", "banned"]),
  }),
  /** This member proved they created the room (sent to everyone, the creator included). */
  z.object({ v, t: z.literal("owner"), peerId: peerIdSchema }),
  /** The creator removed you: this socket is being closed with CloseCode.Banned. */
  z.object({ v, t: z.literal("banned") }),
  /**
   * This peerId connected again (e.g. another tab, or a reconnect over a dead socket): this socket
   * is being closed. Sent as a message because a close event can lag behind (it needs the TCP
   * connection to be torn down), while a message arrives immediately.
   */
  z.object({ v, t: z.literal("replaced") }),
  z.object({ v, t: z.literal("room.expired") }),
  z.object({ v, t: z.literal("room.destroyed"), by: peerIdSchema }),
  z.object({
    v,
    t: z.literal("room.upgraded"),
    plan: planSchema,
    tier: tierSchema,
    expiresAt: z.number().int(),
    serverNow: z.number().int(),
    maxPeers: z.number().int().positive().max(MAX_ROOM_PEERS),
    limits: limitsSchema,
    ai: z.boolean().default(false),
    /**
     * Fresh relay credentials that last until the new end of the room. Links that go through the
     * relay restart ICE with them, since the old ones expire at the old end.
     */
    iceServers: z.array(iceServerSchema).max(MAX_ICE_SERVERS),
  }),
  /**
   * Sent right before the server closes a socket it won't admit (room_full, room_not_found,
   * room_expired, forbidden_origin, rate_limited). `code` is the same close code. The close frame
   * alone isn't enough: it can arrive late or not at all, while messages arrive.
   */
  z.object({
    v,
    t: z.literal("rejected"),
    code: z.number().int().min(4000).max(4999),
    reason: z.string().max(64),
  }),
  z.object({
    v,
    t: z.literal("error"),
    code: z.enum([
      "protocol_error",
      "signal_too_large",
      "signal_rate_exceeded",
      "not_paired",
      "not_owner",
    ]),
    message: z.string(),
  }),
]);
export type ServerMessage = z.infer<typeof serverMessageSchema>;
export type ServerMessageType = ServerMessage["t"];
