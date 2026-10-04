import { createContext } from "react";
import type { SessionState } from "@poof/core";

/**
 * What the room screen can do.
 * Plain functions, safe to destructure (`const { sendMessage } = actions`).
 */
export interface RoomActions {
  /** Rejects with PoofError (`not_connected`, `invalid_message`); the UI maps the code to copy. */
  sendMessage: (text: string) => Promise<void>;
  /**
   * Send a file to everyone connected (super rooms: `state.limits.fileTransfer`). Resolves once it
   * has started; a file item in `state.messages` then shows progress, "delivered to N of M" and
   * failures. Rejects with PoofError: `not_connected`, `not_available`, `file_too_large`.
   */
  sendFile: (file: File) => Promise<void>;
  /** Cancel a file being sent or received (by its item id). */
  abortTransfer: (fileId: string) => void;
  /**
   * "Share via code": fills `state.phrase` ({ code, expiresAt }) with a one-time 4-word code, valid
   * for 3 minutes (or less if the room ends sooner). Calling it again replaces the code.
   */
  createPhrase: () => Promise<void>;
  /** Ends the room for everyone. Creator only (`state.isOwner`); others get PoofError("not_owner"). */
  destroy: () => Promise<void>;
  /** Leave the room (then navigate away). In a free room this ends it for the other person too. */
  leave: () => Promise<void>;
  /**
   * Your optional display name (null or "" clears it). Normalised (≤ 32 characters, one line),
   * shown to others next to your short label, sent only over the encrypted links.
   */
  setNickname: (name: string | null) => void;
}

export interface RoomContextValue {
  state: SessionState;
  actions: RoomActions;
}

export const RoomContext = createContext<RoomContextValue | null>(null);
