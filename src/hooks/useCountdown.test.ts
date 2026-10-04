import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatRemaining, useCountdown } from "./useCountdown.ts";

describe("formatRemaining", () => {
  it.each([
    [null, "--:--"],
    [0, "00:00"],
    [-5000, "00:00"],
    [1, "00:01"], // rounds up: 00:00 only when it's really over
    [999, "00:01"],
    [1000, "00:01"],
    [1001, "00:02"],
    [59_000, "00:59"],
    [10 * 60_000, "10:00"],
    [60 * 60_000 - 1, "60:00"],
    [60 * 60_000, "60:00"], // a 60-minute room starts at 60:00
    [60 * 60_000 + 1, "1:00:01"],
    [24 * 3600_000, "24:00:00"],
    [3600_000 + 62_000, "1:01:02"],
  ])("%s ms → %s", (ms, label) => {
    expect(formatRemaining(ms)).toBe(label);
  });
});

describe("useCountdown", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("has no deadline until expiresAt is known", () => {
    const { result } = renderHook(() => useCountdown(null));
    expect(result.current).toEqual({ remainingMs: null, label: "--:--" });
  });

  it("ticks every second and stops at 00:00", () => {
    const { result } = renderHook(() => useCountdown(1_000_000 + 3_000));
    expect(result.current.label).toBe("00:03");

    // Each tick lands a few ms after the whole second.
    act(() => void vi.advanceTimersByTime(1010));
    expect(result.current.label).toBe("00:02");
    act(() => void vi.advanceTimersByTime(1000));
    expect(result.current.label).toBe("00:01");
    act(() => void vi.advanceTimersByTime(1000));
    expect(result.current).toEqual({ remainingMs: 0, label: "00:00" });

    // No timer left running once it's over.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("follows a new deadline (e.g. after an upgrade) and cleans up on unmount", () => {
    const { result, rerender, unmount } = renderHook(({ at }) => useCountdown(at), {
      initialProps: { at: 1_000_000 + 5_000 },
    });
    expect(result.current.label).toBe("00:05");
    rerender({ at: 1_000_000 + 24 * 3_600_000 });
    expect(result.current.label).toBe("24:00:00");
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("starts at 00:00 when the deadline already passed", () => {
    const { result } = renderHook(() => useCountdown(1_000_000 - 10));
    expect(result.current).toEqual({ remainingMs: 0, label: "00:00" });
    expect(vi.getTimerCount()).toBe(0);
  });
});
