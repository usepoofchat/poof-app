/** Wire protocol version. Bump on any incompatible change to WS or DataChannel messages. */
export const PROTOCOL_VERSION = 1 as const;

/** Room and peer ids: 16 random bytes, base64url, no padding = 22 chars. */
export const ID_BYTES = 16;
export const ID_LENGTH = 22;

/** Phrase-handshake mailbox id: 32 bytes base64url = 43 chars (derived client-side). */
export const HANDSHAKE_ID_LENGTH = 43;
export const HANDSHAKE_TTL_SECONDS = 180;
export const HANDSHAKE_BLOB_MAX_BYTES = 2048;

/** Room key in the URL fragment: 32 bytes base64url = 43 chars. */
export const ROOM_KEY_BYTES = 32;
export const ROOM_KEY_LENGTH = 43;

/**
 * Creator proof: the creator's browser keeps a random 32-byte secret and sends only its SHA-256 when
 * creating the room. Destroying the room requires the secret. Both are 43-char base64url.
 */
export const OWNER_TOKEN_LENGTH = 43;

export const DEFAULT_MAX_PEERS = 2;

/** Upper bound for any room (super rooms: up to 10 people). */
export const MAX_ROOM_PEERS = 10;

/** Optional display name, sent only over the encrypted channel. */
export const NICKNAME_MAX_CHARS = 32;

export const TIERS = ["free", "60m", "24h"] as const;
export type Tier = (typeof TIERS)[number];

/** Room lifetime per tier, in seconds. The free value can be overridden by the ROOM_TTL_FREE_SECONDS var. */
export const TIER_TTL_SECONDS: Record<Tier, number> = {
  free: 10 * 60,
  "60m": 60 * 60,
  "24h": 24 * 60 * 60,
};

/** File transfer cap for super rooms (bytes). Overridable with the FILE_MAX_BYTES var. */
export const DEFAULT_FILE_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Hard ceiling for `limits.fileMaxBytes`, whatever the server says. A receiver allocates the whole
 * file up front, so this bounds the memory a modified server + peer can make a browser reserve.
 * The Worker clamps FILE_MAX_BYTES to it, and clients reject room info above it.
 */
export const FILE_MAX_BYTES_CEILING = 64 * 1024 * 1024;

/**
 * File chunk payload. A chunk frame is 11 (header) + 20 (fileId + index) + 16 KiB + 16 (GCM tag)
 * bytes, far below the 64 KiB per-message limit every browser accepts on a DataChannel. 2 MB = 128 chunks per recipient.
 */
export const FILE_CHUNK_BYTES = 16 * 1024;

/** Received file names are cut to this many characters after sanitising. */
export const FILE_NAME_MAX_CHARS = 255;

/** Signaling limits (enforced by RoomDO). */
export const MAX_SIGNAL_BYTES = 16 * 1024;
export const MAX_SIGNALS_PER_PAIRING = 200;
export const MAX_WS_MESSAGE_BYTES = 32 * 1024;

/** Request bodies of the JSON endpoints (POST /api/rooms, PUT /api/handshakes/:id). */
export const MAX_JSON_BODY_BYTES = 4096;

/** ICE servers a client accepts in `paired`, and URLs per server (Cloudflare returns ~2 and ~8). */
export const MAX_ICE_SERVERS = 8;
export const MAX_ICE_URLS = 16;

/** Application heartbeat: literal strings so the DO can auto-answer without waking up. */
export const WS_PING = "ping";
export const WS_PONG = "pong";
export const WS_PING_INTERVAL_MS = 20_000;
export const WS_PONG_TIMEOUT_MS = 8_000;

/** Chat. */
export const CHAT_MAX_CHARS = 5000;

/** WebSocket close codes (application range 4000-4999). */
export const CloseCode = {
  ProtocolError: 4000,
  RoomExpired: 4001,
  RoomDestroyed: 4002,
  RoomFull: 4003,
  RoomNotFound: 4004,
  RateLimited: 4005,
  /** Same peerId connected again: the older socket is replaced (zombie-socket recovery). */
  Replaced: 4006,
  ForbiddenOrigin: 4007,
  /** The creator removed this person from the room; the same peerId can't come back. */
  Banned: 4008,
} as const;
export type CloseCodeValue = (typeof CloseCode)[keyof typeof CloseCode];

/** Close codes after which reconnecting is pointless. */
export const TERMINAL_CLOSE_CODES: ReadonlySet<number> = new Set([
  CloseCode.ProtocolError,
  CloseCode.RoomExpired,
  CloseCode.RoomDestroyed,
  CloseCode.RoomFull,
  CloseCode.RoomNotFound,
  CloseCode.Replaced,
  CloseCode.ForbiddenOrigin,
  CloseCode.Banned,
]);
