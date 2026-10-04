import { useState } from "react";
import { detectBrowserSupport, type BrowserSupport, type SupportEnv } from "@poof/core";

/**
 * Can this browser open a room? `{ ok, missing, inApp, platform }`, checked once on mount.
 *
 * - `ok: false`: render the "this browser can't open poof" screen INSTEAD of the room (before
 *   RoomProvider mounts). `missing` says why: secure_context, webcrypto, webrtc, websocket, javascript.
 * - `inApp` set: the link opened inside another app (instagram, facebook, whatsapp, …, or "webview").
 *   Recommend opening it in the browser (copy-link button + per-`platform` instructions), and let
 *   the person continue anyway.
 */
export function useBrowserSupport(env?: SupportEnv): BrowserSupport {
  const [support] = useState(() => detectBrowserSupport(env));
  return support;
}
