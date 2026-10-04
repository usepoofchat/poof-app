export type PoofErrorCode =
  | "invalid_link"
  | "room_not_found"
  | "room_full"
  | "pq_failed"
  | "pq_timeout"
  | "connection_failed"
  | "rate_limited"
  | "not_connected"
  | "invalid_message"
  | "frame_invalid"
  | "frame_out_of_order"
  | "decrypt_failed"
  /** The feature isn't on in this room (file transfer outside super rooms). */
  | "not_available"
  /** The file is over the room's `limits.fileMaxBytes`. */
  | "file_too_large"
  /** Only the person who created the room can destroy it. */
  | "not_owner"
  /** Phrase join: not four words from the list. */
  | "invalid_code"
  /** Phrase join: the code was already used or has expired (mailboxes are one-time, 3 min). */
  | "not_found_or_expired";

/** Error with a stable machine-readable `code`; UI maps codes to copy, never `message`. */
export class PoofError extends Error {
  readonly code: PoofErrorCode;

  constructor(code: PoofErrorCode, message?: string) {
    super(message ?? code);
    this.name = "PoofError";
    this.code = code;
  }
}
