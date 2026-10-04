/**
 * Can this browser run a room?
 *
 * Two different answers:
 * - `missing`: features a room can't work without. Any of them missing = show the "this browser
 *   can't open poof" screen instead of the app (`ok: false`).
 * - `inApp`: the link was opened inside another app (Instagram, Facebook, TikTok, …). Rooms usually
 *   work there, but that app's browser is not the person's browser: the host app can run its own
 *   script in every page it shows (Meta's in-app browsers have been seen injecting code), which no
 *   CSP stops, so it could read the room key and the conversation. The UI should recommend opening
 *   the link in the real browser and let the person continue anyway.
 *
 * Feature checks only look for the APIs; they never create a peer connection or touch the network.
 */

export type MissingFeature =
  /** Not https (or localhost): WebCrypto and WebRTC are off in insecure contexts. */
  | "secure_context"
  /** crypto.subtle and crypto.getRandomValues: all keys, the handshake and every frame. */
  | "webcrypto"
  /** RTCPeerConnection with data channels: chat and files go peer to peer. */
  | "webrtc"
  /** Signaling. */
  | "websocket"
  /** TextEncoder/TextDecoder and BigInt (frame counters). Only very old engines lack them. */
  | "javascript";

export type InAppBrowser =
  | "instagram"
  | "facebook"
  | "messenger"
  | "whatsapp"
  | "telegram"
  | "tiktok"
  | "snapchat"
  | "line"
  | "wechat"
  | "linkedin"
  | "x"
  /** An app's embedded browser we can't name (Android WebView, iOS WKWebView). */
  | "webview";

export type Platform = "ios" | "android" | "other";

export interface BrowserSupport {
  ok: boolean;
  missing: MissingFeature[];
  inApp: InAppBrowser | null;
  /** For the "open in your browser" instructions, which differ per platform. */
  platform: Platform;
}

/** What the check reads. Defaults to `globalThis`; tests pass their own. */
export interface SupportEnv {
  isSecureContext?: boolean;
  crypto?: { subtle?: unknown; getRandomValues?: unknown };
  RTCPeerConnection?: unknown;
  WebSocket?: unknown;
  TextEncoder?: unknown;
  TextDecoder?: unknown;
  BigInt?: unknown;
  navigator?: { userAgent?: string; maxTouchPoints?: number; platform?: string };
}

/** Order matters: Messenger's UA also says FBAN, so it's checked before Facebook. */
const IN_APP: ReadonlyArray<[InAppBrowser, RegExp]> = [
  ["instagram", /\bInstagram\b/i],
  ["messenger", /\bMessengerForiOS\b|\bFBAN\/Messenger|\bOrca-Android\b|\bMessengerLite/i],
  ["facebook", /\bFBAN\/|\bFBAV\/|\bFB_IAB\/|\bFBIOS\b|\bFBSS\//],
  ["whatsapp", /\bWhatsApp\b/i],
  ["telegram", /\bTelegram(?:-Android)?\b/i],
  ["tiktok", /\bmusical_ly\b|\bBytedanceWebview\b|\bTikTok\b|\bByteLocale\b/i],
  ["snapchat", /\bSnapchat\b/i],
  ["line", /\bLine\/\d/],
  ["wechat", /\bMicroMessenger\b/i],
  ["linkedin", /\bLinkedInApp\b/i],
  ["x", /\bTwitter(?:Android)?\b/],
];

export function detectPlatform(userAgent: string, maxTouchPoints = 0, platform = ""): Platform {
  if (/\bAndroid\b/i.test(userAgent)) return "android";
  if (/\b(iPhone|iPad|iPod)\b/.test(userAgent)) return "ios";
  // iPadOS asks for desktop sites by default and says "Macintosh"; touch gives it away.
  if (/\bMacintosh\b/.test(userAgent) && (maxTouchPoints > 1 || platform === "iPad")) return "ios";
  return "other";
}

export function detectInAppBrowser(
  userAgent: string,
  platform: Platform = detectPlatform(userAgent),
): InAppBrowser | null {
  for (const [name, pattern] of IN_APP) if (pattern.test(userAgent)) return name;
  // Android System WebView marks itself with "; wv)".
  if (platform === "android" && /;\s*wv\)/.test(userAgent)) return "webview";
  // iOS: every browser app includes "Safari/" (Chrome adds CriOS, Firefox FxiOS, …); a bare
  // WKWebView in some other app doesn't.
  if (platform === "ios" && /\bAppleWebKit\b/.test(userAgent) && !/\bSafari\//.test(userAgent))
    return "webview";
  return null;
}

function isFunction(value: unknown): boolean {
  return typeof value === "function";
}

export function detectBrowserSupport(env: SupportEnv = globalThis): BrowserSupport {
  const missing: MissingFeature[] = [];

  // `isSecureContext` is undefined outside browsers (Node, old engines): only an explicit false counts.
  if (env.isSecureContext === false) missing.push("secure_context");
  if (!env.crypto?.subtle || !isFunction(env.crypto.getRandomValues)) missing.push("webcrypto");

  const pc = env.RTCPeerConnection as { prototype?: { createDataChannel?: unknown } } | undefined;
  if (!isFunction(pc) || !isFunction(pc?.prototype?.createDataChannel)) missing.push("webrtc");

  if (!isFunction(env.WebSocket)) missing.push("websocket");
  if (!isFunction(env.TextEncoder) || !isFunction(env.TextDecoder) || !isFunction(env.BigInt))
    missing.push("javascript");

  const nav = env.navigator ?? {};
  const userAgent = nav.userAgent ?? "";
  const platform = detectPlatform(userAgent, nav.maxTouchPoints, nav.platform);
  return {
    ok: missing.length === 0,
    missing,
    inApp: detectInAppBrowser(userAgent, platform),
    platform,
  };
}
