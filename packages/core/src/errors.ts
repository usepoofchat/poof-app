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
  /** Only the person who created the room can do this (destroy, upgrade, remove people, pin). */
  | "not_owner"
  /** Phrase join: not four words from the list. */
  | "invalid_code"
  /** Phrase join: the code was already used or has expired (mailboxes are one-time, 3 min). */
  | "not_found_or_expired"
  /** Super Quant-Rooms can't be bought right now (no key for this variant, or payments are off). */
  | "pay_unavailable"
  /** The payment wasn't found, isn't confirmed yet, or doesn't match (see the message). */
  | "pay_failed"
  /** The pass was refused: already spent, or not valid. */
  | "pass_invalid"
  /** This quant-room doesn't include the AI model. */
  | "ai_not_enabled"
  /** The AI model isn't set up for this quant-room yet (its creator hasn't opened it). */
  | "ai_not_ready"
  /** This quant-room has used all its AI requests. */
  | "ai_budget_exhausted"
  /** The AI model can't be reached right now. */
  | "ai_unavailable"
  /** The AI enclave's attestation didn't check out: nothing was sent to it. */
  | "ai_attestation_failed"
  /** The AI answer broke off or couldn't be decrypted. */
  | "ai_failed";

/** Error with a stable machine-readable `code`; UI maps codes to copy, never `message`. */
export class PoofError extends Error {
  readonly code: PoofErrorCode;

  constructor(code: PoofErrorCode, message?: string) {
    super(message ?? code);
    this.name = "PoofError";
    this.code = code;
  }
}
