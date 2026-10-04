import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  PoofError,
  RoomSession,
  browserRtcFactory,
  browserSocketFactory,
  inviteUrl,
  parseRoomLocation,
  type RtcFactory,
  type SessionDeps,
  type SessionState,
  type SocketFactory,
} from "@poof/core";
import { clearOwnerSecret, readOwnerSecret } from "./ownerSecret.ts";
import { RoomContext, type RoomActions, type RoomContextValue } from "./roomContext.ts";

export interface RoomProviderProps {
  children: ReactNode;
  /** Where the room link is read from. Defaults to `window.location` (path + #key fragment). */
  location?: { pathname: string; hash: string };
  /** Overridable for tests; the defaults are the real browser APIs. */
  origin?: string;
  fetch?: typeof fetch;
  createSocket?: SocketFactory;
  createPeerConnection?: RtcFactory;
  /** Where the creator's secret is looked up (default: this tab's sessionStorage). */
  storage?: Storage | null;
}

type Setup =
  | { ok: true; deps: SessionDeps; fallback: SessionState; storage: Storage | null | undefined }
  | { ok: false; fallback: SessionState };

/** The room is over for good: the creator's secret is useless from now on. */
function roomIsGone(state: SessionState): boolean {
  return (
    state.status === "expired" ||
    (state.status === "terminated" &&
      (state.endReason === "destroyed_by_me" || state.endReason === "destroyed_by_peer")) ||
    (state.status === "error" && state.error?.code === "room_not_found")
  );
}

/** State shown before the engine exists (first render) or when the link itself is unusable. */
function staticState(
  roomId: string,
  url: string,
  error: PoofError | null,
  isOwner = false,
): SessionState {
  return {
    status: error ? "error" : "loading",
    error: error ? { code: "invalid_link", message: error.message } : null,
    endReason: null,
    roomId,
    inviteUrl: url,
    isOwner,
    role: null,
    peerPresent: false,
    connectionType: null,
    maxPeers: 2,
    members: [],
    membersMismatch: false,
    nickname: null,
    plan: "free",
    tier: "free",
    expiresAt: null,
    limits: { fileTransfer: false, fileMaxBytes: 0 },
    messages: [],
    log: [],
    phrase: null,
    typing: [],
    ai: false,
    aiPending: [],
  };
}

function setup(props: RoomProviderProps): Setup {
  const { pathname, hash } = props.location ?? window.location;
  const origin = props.origin ?? window.location.origin;
  try {
    const { roomId, key } = parseRoomLocation(pathname, hash);
    const ownerSecret = readOwnerSecret(roomId, props.storage);
    return {
      ok: true,
      deps: {
        roomId,
        roomKey: key,
        origin,
        fetch: props.fetch ?? window.fetch.bind(window),
        createSocket: props.createSocket ?? browserSocketFactory,
        createPeerConnection: props.createPeerConnection ?? browserRtcFactory,
        ...(ownerSecret ? { ownerSecret } : {}),
      },
      fallback: staticState(
        roomId,
        inviteUrl(origin, roomId, key),
        null,
        ownerSecret !== undefined,
      ),
      storage: props.storage,
    };
  } catch (error) {
    const err =
      error instanceof PoofError ? error : new PoofError("invalid_link", "Not a room link.");
    return { ok: false, fallback: staticState("", "", err) };
  }
}

const noopSubscribe = () => () => {};

/**
 * Mounted by the `/join/` route. Reads the link and its props ONCE, on mount, runs one
 * `RoomSession` for as long as it stays mounted and exposes it through `useRoom()`. To switch rooms,
 * remount it (e.g. `key={roomId}`). Unmounting or closing the tab leaves the room, which ends it for
 * the other person too.
 */
export function RoomProvider(props: RoomProviderProps) {
  const [init] = useState(() => setup(props));
  const [session, setSession] = useState<RoomSession | null>(null);

  useEffect(() => {
    if (!init.ok) return;
    const s = new RoomSession(init.deps);
    // Not on leave: a refresh also leaves, and the creator must still be able to destroy afterwards.
    const unsubscribe = s.subscribe((st) => {
      if (roomIsGone(st)) clearOwnerSecret(init.deps.roomId, init.storage);
    });
    // Publish and start on the next task, not now: React StrictMode mounts, unmounts and remounts in
    // dev, and the throwaway first mount must never reach the server (it would show up as a ghost
    // peer) nor the screen. Until then the provider shows the `loading` fallback.
    const startTimer = setTimeout(() => {
      setSession(s);
      void s.start();
    }, 0);
    const onPageHide = () => void s.leave();
    window.addEventListener("pagehide", onPageHide);
    return () => {
      clearTimeout(startTimer);
      window.removeEventListener("pagehide", onPageHide);
      void s.leave();
      unsubscribe();
    };
  }, [init]);

  const subscribe = useMemo(
    () => (session ? (cb: () => void) => session.subscribe(cb) : noopSubscribe),
    [session],
  );
  const getSnapshot = useCallback(
    () => (session ? session.getState() : init.fallback),
    [session, init],
  );
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const actions = useMemo<RoomActions>(
    () => ({
      sendMessage: async (text) => {
        if (!session) throw new PoofError("not_connected", "Not connected to the other person.");
        await session.sendMessage(text);
      },
      sendFile: async (file) => {
        if (!session) throw new PoofError("not_connected", "Not connected to anyone.");
        await session.sendFile(file);
      },
      abortTransfer: (fileId) => {
        session?.abortTransfer(fileId);
      },
      createPhrase: async () => {
        if (!session) throw new PoofError("not_connected", "The room isn't ready.");
        await session.createPhrase();
      },
      destroy: () => session?.destroy() ?? Promise.resolve(),
      leave: () => session?.leave() ?? Promise.resolve(),
      setNickname: (name) => {
        session?.setNickname(name);
      },
    }),
    [session],
  );

  const value = useMemo<RoomContextValue>(() => ({ state, actions }), [state, actions]);
  return <RoomContext.Provider value={value}>{props.children}</RoomContext.Provider>;
}
