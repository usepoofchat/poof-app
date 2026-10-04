import { describe, expect, it } from "vitest";
import {
  detectBrowserSupport,
  detectInAppBrowser,
  detectPlatform,
  type SupportEnv,
} from "../src/index.ts";

/** Real user agents (2025–2026 builds). */
const UA = {
  chromeDesktop:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  safariIphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1",
  chromeIphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0.7390.41 Mobile/15E148 Safari/604.1",
  ipadDesktopMode:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15",
  chromeAndroid:
    "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36",
  samsungInternet:
    "Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/28.0 Chrome/130.0.0.0 Mobile Safari/537.36",
  instagramIos:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 395.0.0.24.84 (iPhone15,2; iOS 18_6; en_US; en; scale=3.00; 1179x2556; 789520018)",
  instagramAndroid:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A.240905.003; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0.6668.100 Mobile Safari/537.36 Instagram 352.0.0.38.100 Android (34/14; 420dpi; 1080x2205; Google/google; Pixel 8; shiba; shiba; en_US; 650813018)",
  facebookIos:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/485.0.0.43.109;FBBV/650000000;FBDV/iPhone15,2;FBMD/iPhone;FBSN/iOS;FBSV/18.6;FBSS/3;FBCR/;FBID/phone;FBLC/en_US;FBOP/80]",
  facebookAndroid:
    "Mozilla/5.0 (Linux; Android 14; SM-S921B Build/UP1A.231005.007; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0.6668.100 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/485.0.0.51.109;]",
  messengerIos:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 LightSpeed [FBAN/MessengerLiteForiOS;FBAV/485.0.0.32.109;FBBV/650000000;FBDV/iPhone15,2;FBMD/iPhone;FBSN/iOS;FBSV/18.6;FBSS/3;FBCR/;FBID/phone;FBLC/en_US;FBOP/0]",
  messengerAndroid:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A.240905.003; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0.6668.100 Mobile Safari/537.36 [FB_IAB/Orca-Android;FBAV/485.0.0.19.109;]",
  whatsappAndroid:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A.240905.003; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0.6668.100 Mobile Safari/537.36 WhatsApp/2.25.20.80",
  telegramAndroid:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A.240905.003; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0.6668.100 Mobile Safari/537.36 Telegram-Android/11.14.1 (Google Pixel 8; Android 14; SDK 34; HIGH)",
  tiktokAndroid:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A.240905.003; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0.6668.100 Mobile Safari/537.36 trill_370504 JsSdk/1.0 NetType/WIFI Channel/googleplay AppName/musical_ly app_version/37.5.4 ByteLocale/en ByteFullLocale/en Region/US BytedanceWebview/d8a21c6",
  snapchatIos:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Snapchat/13.50.0.43 (like Safari/8619.1.26.30.5, panda)",
  lineIos:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Safari Line/15.10.0",
  wechat:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.50(0x1800323d) NetType/WIFI Language/zh_CN",
  linkedinIos:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [LinkedInApp]/9.30.1234",
  xIos: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Twitter for iPhone/10.70",
  androidWebview:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A.240905.003; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0.6668.100 Mobile Safari/537.36",
  iosWebview:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
};

describe("detectInAppBrowser", () => {
  it.each([
    ["instagramIos", "instagram"],
    ["instagramAndroid", "instagram"],
    ["facebookIos", "facebook"],
    ["facebookAndroid", "facebook"],
    ["messengerIos", "messenger"],
    ["messengerAndroid", "messenger"],
    ["whatsappAndroid", "whatsapp"],
    ["telegramAndroid", "telegram"],
    ["tiktokAndroid", "tiktok"],
    ["snapchatIos", "snapchat"],
    ["lineIos", "line"],
    ["wechat", "wechat"],
    ["linkedinIos", "linkedin"],
    ["xIos", "x"],
    ["androidWebview", "webview"],
    ["iosWebview", "webview"],
  ] as const)("%s → %s", (ua, expected) => {
    expect(detectInAppBrowser(UA[ua])).toBe(expected);
  });

  it.each([
    "chromeDesktop",
    "safariIphone",
    "chromeIphone",
    "ipadDesktopMode",
    "chromeAndroid",
    "samsungInternet",
  ] as const)("%s is a real browser", (ua) => {
    expect(detectInAppBrowser(UA[ua])).toBeNull();
  });

  it("an empty user agent is not an in-app browser", () => {
    expect(detectInAppBrowser("")).toBeNull();
  });
});

describe("detectPlatform", () => {
  it("tells iOS, Android and the rest apart, iPadOS in desktop mode included", () => {
    expect(detectPlatform(UA.safariIphone)).toBe("ios");
    expect(detectPlatform(UA.instagramAndroid)).toBe("android");
    expect(detectPlatform(UA.chromeDesktop)).toBe("other");
    expect(detectPlatform(UA.ipadDesktopMode, 5)).toBe("ios");
    expect(detectPlatform(UA.ipadDesktopMode, 0)).toBe("other");
  });
});

describe("detectBrowserSupport", () => {
  class FakePc {
    createDataChannel(): void {}
  }
  const full: SupportEnv = {
    isSecureContext: true,
    crypto: { subtle: {}, getRandomValues: () => undefined },
    RTCPeerConnection: FakePc,
    WebSocket: function WebSocket() {},
    TextEncoder,
    TextDecoder,
    BigInt,
    navigator: { userAgent: UA.chromeDesktop, maxTouchPoints: 0 },
  };

  it("a modern browser is fine", () => {
    expect(detectBrowserSupport(full)).toEqual({
      ok: true,
      missing: [],
      inApp: null,
      platform: "other",
    });
  });

  it("names everything that's missing", () => {
    expect(detectBrowserSupport({ ...full, isSecureContext: false }).missing).toEqual([
      "secure_context",
    ]);
    expect(
      detectBrowserSupport({ ...full, crypto: { getRandomValues: () => undefined } }).missing,
    ).toEqual(["webcrypto"]);
    expect(detectBrowserSupport({ ...full, crypto: undefined }).missing).toEqual(["webcrypto"]);
    expect(detectBrowserSupport({ ...full, RTCPeerConnection: undefined }).missing).toEqual([
      "webrtc",
    ]);
    // A stub without data channels (some locked-down builds) is as good as none.
    expect(
      detectBrowserSupport({ ...full, RTCPeerConnection: function Stub() {} }).missing,
    ).toEqual(["webrtc"]);
    expect(detectBrowserSupport({ ...full, WebSocket: undefined }).missing).toEqual(["websocket"]);
    expect(detectBrowserSupport({ ...full, BigInt: undefined }).missing).toEqual(["javascript"]);
    const none = detectBrowserSupport({});
    expect(none.ok).toBe(false);
    expect(none.missing).toEqual(["webcrypto", "webrtc", "websocket", "javascript"]);
  });

  it("an in-app browser that has everything still works, flagged", () => {
    const s = detectBrowserSupport({ ...full, navigator: { userAgent: UA.instagramIos } });
    expect(s).toEqual({ ok: true, missing: [], inApp: "instagram", platform: "ios" });
  });

  it("reads the real globals by default (Node has no WebRTC)", () => {
    const s = detectBrowserSupport();
    expect(s.missing).toContain("webrtc");
    expect(s.missing).not.toContain("webcrypto");
  });
});
