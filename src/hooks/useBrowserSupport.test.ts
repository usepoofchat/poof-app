import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useBrowserSupport } from "./useBrowserSupport.ts";

describe("useBrowserSupport", () => {
  it("reports what's missing and where the link was opened, once", () => {
    const env = {
      isSecureContext: true,
      crypto: { subtle: {}, getRandomValues: () => undefined },
      WebSocket: function WebSocket() {},
      TextEncoder,
      TextDecoder,
      BigInt,
      navigator: {
        userAgent:
          "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 395.0.0.24.84",
      },
    };
    const { result, rerender } = renderHook(() => useBrowserSupport(env));
    expect(result.current).toEqual({
      ok: false,
      missing: ["webrtc"],
      inApp: "instagram",
      platform: "ios",
    });
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });

  it("jsdom (no WebRTC) is not supported", () => {
    const { result } = renderHook(() => useBrowserSupport());
    expect(result.current.ok).toBe(false);
    expect(result.current.missing).toContain("webrtc");
  });
});
