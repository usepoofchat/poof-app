import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createPhraseInvite, generateRoomKey, inviteUrl } from "@poof/core";
import { FakeRoomServer } from "../../packages/core/test/fakes.ts";
import { usePhraseJoin } from "./usePhraseJoin.ts";

const ORIGIN = "https://poof.test";
const ROOM = "R".repeat(22);

async function invite(server: FakeRoomServer) {
  const url = inviteUrl(ORIGIN, ROOM, generateRoomKey());
  const { code } = await createPhraseInvite({
    fetch: server.fetch,
    origin: ORIGIN,
    inviteUrl: url,
  });
  return { url, code };
}

describe("usePhraseJoin", () => {
  it("turns the four words into the room path and navigates there", async () => {
    const server = new FakeRoomServer();
    const { url, code } = await invite(server);
    const navigate = vi.fn();
    const { result } = renderHook(() =>
      usePhraseJoin({ fetch: server.fetch, origin: ORIGIN, navigate }),
    );

    await act(() => result.current.join(code.replaceAll("-", " ")));
    expect(navigate).toHaveBeenCalledWith(url.slice(ORIGIN.length));
    expect(result.current).toMatchObject({ joining: false, error: null });
  });

  it("reports each failure with the code the UI maps to copy", async () => {
    const server = new FakeRoomServer();
    const { code } = await invite(server);
    const navigate = vi.fn();
    const { result } = renderHook(() =>
      usePhraseJoin({ fetch: server.fetch, origin: ORIGIN, navigate }),
    );

    await act(() => result.current.join("not four valid words"));
    expect(result.current.error).toBe("invalid_code");

    await act(() => result.current.join(code));
    expect(result.current.error).toBeNull();
    await act(() => result.current.join(code)); // one-time: the second use fails
    expect(result.current.error).toBe("not_found_or_expired");
    expect(navigate).toHaveBeenCalledTimes(1);

    const down = () => Promise.reject(new TypeError("offline"));
    const offline = renderHook(() => usePhraseJoin({ fetch: down, origin: ORIGIN, navigate }));
    await act(() => offline.result.current.join("zoo zone zero youth"));
    expect(offline.result.current.error).toBe("connection_failed");
  });

  it("a double submit takes the one-time code only once", async () => {
    const server = new FakeRoomServer();
    const { code } = await invite(server);
    const navigate = vi.fn();
    const fetch = vi.fn(server.fetch);
    const { result } = renderHook(() => usePhraseJoin({ fetch, origin: ORIGIN, navigate }));

    await act(async () => {
      await Promise.all([result.current.join(code), result.current.join(code)]);
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(result.current.error).toBeNull();
  });
});
