import { useCallback, useRef, useState } from "react";
import { PoofError, createRoom } from "@poof/core";
import { saveOwnerSecret } from "../room/ownerSecret.ts";

export type CreateRoomErrorCode = "rate_limited" | "connection_failed";

export interface CreateRoomOptions {
  /**
   * Go to the new room (`/join/#<id>.<key>`). Pass React Router's `navigate` for an in-app transition;
   * the default is a full page load, which also works.
   */
  navigate?: (path: string) => void;
  /** Overridable for tests. */
  fetch?: typeof fetch;
  origin?: string;
  /** Where the creator's secret is kept (default: this tab's sessionStorage). */
  storage?: Storage | null;
}

export interface CreateRoom {
  create: () => Promise<void>;
  creating: boolean;
  error: { code: CreateRoomErrorCode; message: string } | null;
}

const defaultNavigate = (path: string) => window.location.assign(path);

/** Landing page "Create room": asks the server for a room id, generates the key locally, navigates. */
export function useCreateRoom(options: CreateRoomOptions = {}): CreateRoom {
  const { navigate = defaultNavigate, fetch: fetchImpl, origin, storage } = options;
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<CreateRoom["error"]>(null);
  // A ref, not state: a double click lands before React re-renders with creating=true.
  const busy = useRef(false);

  const create = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    setCreating(true);
    setError(null);
    try {
      const room = await createRoom({ fetch: fetchImpl ?? window.fetch.bind(window), origin });
      // Before navigating: the room page reads it on mount. Only this tab can now destroy the room.
      saveOwnerSecret(room.roomId, room.ownerSecret, storage);
      navigate(room.path);
    } catch (err) {
      const code: CreateRoomErrorCode =
        err instanceof PoofError && err.code === "rate_limited"
          ? "rate_limited"
          : "connection_failed";
      setError({ code, message: err instanceof Error ? err.message : String(err) });
    } finally {
      busy.current = false;
      setCreating(false);
    }
  }, [navigate, fetchImpl, origin, storage]);

  return { create, creating, error };
}
