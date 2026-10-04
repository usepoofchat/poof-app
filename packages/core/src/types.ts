import type { Limits, Plan, Tier } from "@poof/protocol";
import type { FileFailReason } from "./files.ts";
import type { ConnectionType } from "./peer.ts";

export type SessionStatus =
  | "loading" // reading the link, loading the room
  | "waiting" // in the room, alone: show the invite UI
  | "connecting" // the other person arrived, WebRTC offer/answer/ICE in progress
  | "connected" // direct channel open, post-quantum key exchange running
  | "sealed" // hybrid key confirmed: chat enabled
  | "terminated" // the other person left, or the room was destroyed
  | "expired" // the server said the room's time is up
  | "error"; // this room can't be used (see `error.code`)

export type SessionErrorCode =
  | "invalid_link"
  | "room_not_found"
  | "room_full"
  | "pq_failed"
  | "connection_failed"
  | "rate_limited";

export interface SessionError {
  code: SessionErrorCode;
  message: string;
}

export type EndReason =
  | "peer_left"
  | "destroyed_by_peer"
  | "destroyed_by_me"
  | "left_by_me"
  | "connection_lost"
  | "replaced";

export type LogCode =
  | "key.loaded"
  | "signaling.connected"
  | "signaling.reconnecting"
  | "room.waiting"
  | "peer.joined"
  | "ice.gathering"
  | "ice.candidates"
  | "dc.open"
  | "path.direct"
  | "path.relay"
  | "pq.start"
  | "pq.exchange"
  | "pq.verify"
  | "pq.done"
  | "conn.failed"
  | "peer.left"
  | "room.expired"
  | "room.destroyed";

export interface LogEntry {
  ts: number;
  code: LogCode;
  level: "info" | "ok" | "warn" | "error";
  data?: Record<string, unknown>;
}

export type ChatItem =
  | {
      kind: "text";
      id: string;
      mine: boolean;
      /** Sender's peerId for received messages; null for mine. */
      from: string | null;
      text: string;
      ts: number;
      status: "sent" | "received";
    }
  | {
      /** Group rooms: "Peer 3FA2 joined" / "... left". Never sent over the wire. */
      kind: "system";
      id: string;
      ts: number;
      event: "joined" | "left";
      peerId: string;
    }
  | {
      /**
       * A file, mine or someone else's. The id is the transfer's fileId. Mine go
       * sending → sent (every byte is out, waiting for the recipients' hash check) → delivered | failed;
       * theirs go receiving → received | failed.
       */
      kind: "file";
      id: string;
      mine: boolean;
      from: string | null;
      /** Sanitised: no paths or control characters, ≤ 255 characters. */
      name: string;
      size: number;
      /** An image type the UI may preview inline, or application/octet-stream (download only). */
      mime: string;
      ts: number;
      status: "sending" | "sent" | "delivered" | "receiving" | "received" | "failed";
      /** 0..1. Mine: bytes sent, summed over recipients. Theirs: bytes received. */
      progress: number;
      /** Mine: how many people it went to, and how many verified it ("delivered to 2 of 3"). Theirs: 0. */
      recipients: number;
      delivered: number;
      /** Theirs, once received and verified: a blob: URL to download (or preview). Revoked when the room ends. */
      url?: string;
      /** When status is "failed": why. */
      error?: FileFailReason;
    };

/** Another person in the room, as this browser sees them. */
export interface MemberView {
  peerId: string;
  /** Short stable label derived from the peerId, e.g. "Peer 3FA2". */
  label: string;
  /** Their optional display name (sent over the encrypted channel), already normalised. */
  nickname: string | null;
  /** joining = link being set up; sealed = encrypted channel up; failed = link broke. */
  state: "joining" | "sealed" | "failed";
  connectionType: ConnectionType | null;
}

/**
 * Everything the UI renders. Immutable: every change produces a new object (and new arrays), so it
 * works directly with React's useSyncExternalStore.
 */
export interface SessionState {
  status: SessionStatus;
  error: SessionError | null;
  /** Why the session ended, when status is "terminated". */
  endReason: EndReason | null;
  roomId: string;
  /** Full invite URL including the #key fragment (for copy / QR). */
  inviteUrl: string;
  /** This browser created the room: it may destroy it. Everyone else can only leave. */
  isOwner: boolean;
  role: "initiator" | "responder" | null;
  peerPresent: boolean;
  connectionType: ConnectionType | null;
  /** 2 for free rooms, up to 10 for super rooms. Group behaviour applies when > 2. */
  maxPeers: number;
  /** Everyone else in the room (one entry in a 2-person room). */
  members: MemberView[];
  /** Group rooms: someone sees a different set of people than you do, for a while (split view). */
  membersMismatch: boolean;
  /** Your own optional display name. */
  nickname: string | null;
  plan: Plan;
  tier: Tier;
  /** Unix ms in the LOCAL clock domain (already corrected for clock skew vs. the server). */
  expiresAt: number | null;
  limits: Limits;
  /** Text, files and (group rooms) join/leave lines, in order. File progress lives on the file items. */
  messages: ChatItem[];
  log: LogEntry[];
  /** Set after createPhrase(). */
  phrase: { code: string; expiresAt: number } | null;
}
