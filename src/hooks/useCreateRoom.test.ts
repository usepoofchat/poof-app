import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { readOwnerSecret } from "../room/ownerSecret.ts";
import { MemoryStorage } from "../test/memoryStorage.ts";
import { useCreateRoom } from "./useCreateRoom.ts";

const ROOM_ID = "A".repeat(22);

function roomResponse(): Response {
  return Response.json({
    roomId: ROOM_ID,
    expiresAt: Date.now() + 600_000,
    serverNow: Date.now(),
    plan: "free",
    tier: "free",
    maxPeers: 2,
    limits: { fileTransfer: false, fileMaxBytes: 2_097_152 },
  });
}

describe("useCreateRoom", () => {
  it("creates a room and navigates to /join/#<id>.<key> with a locally generated key", async () => {
    const fetch = vi.fn(() => Promise.resolve(roomResponse()));
    const navigate = vi.fn();
    const storage = new MemoryStorage();
    const { result } = renderHook(() => useCreateRoom({ fetch, navigate, origin: "", storage }));
    expect(result.current).toMatchObject({ creating: false, error: null });

    await act(() => result.current.create());

    // The creator's secret is kept in this tab only, and is neither in the link nor sent as-is.
    const secret = readOwnerSecret(ROOM_ID, storage);
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(String(navigate.mock.calls[0]?.[0])).not.toContain(secret);
    expect(JSON.stringify(fetch.mock.calls)).not.toContain(secret);

    expect(fetch).toHaveBeenCalledWith("/api/rooms", expect.objectContaining({ method: "POST" }));
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate.mock.calls[0]?.[0]).toMatch(
      new RegExp(`^/join/#${ROOM_ID}\\.[A-Za-z0-9_-]{43}$`),
    );
    // The key never went to the server.
    const key = String(navigate.mock.calls[0]?.[0]).split(".")[1] ?? "";
    expect(JSON.stringify(fetch.mock.calls)).not.toContain(key);
    expect(result.current).toMatchObject({ creating: false, error: null });
  });

  it("shows creating while the request runs and ignores double clicks", async () => {
    let respond: (r: Response) => void = () => {};
    const fetch = vi.fn(() => new Promise<Response>((resolve) => (respond = resolve)));
    const navigate = vi.fn();
    const { result } = renderHook(() => useCreateRoom({ fetch, navigate }));

    let first: Promise<void> = Promise.resolve();
    act(() => {
      first = result.current.create();
      void result.current.create();
    });
    await waitFor(() => expect(result.current.creating).toBe(true));
    expect(fetch).toHaveBeenCalledTimes(1);

    await act(async () => {
      respond(roomResponse());
      await first;
    });
    expect(result.current.creating).toBe(false);
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it("reports rate_limited on 429 and stays on the page", async () => {
    const fetch = vi.fn(() => Promise.resolve(new Response("{}", { status: 429 })));
    const navigate = vi.fn();
    const { result } = renderHook(() => useCreateRoom({ fetch, navigate }));
    await act(() => result.current.create());
    expect(result.current.error?.code).toBe("rate_limited");
    expect(result.current.creating).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("reports connection_failed when the server can't be reached, and recovers on retry", async () => {
    const fetch = vi
      .fn<() => Promise<Response>>()
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValueOnce(roomResponse());
    const navigate = vi.fn();
    const { result } = renderHook(() => useCreateRoom({ fetch, navigate }));

    await act(() => result.current.create());
    expect(result.current.error?.code).toBe("connection_failed");

    await act(() => result.current.create());
    expect(result.current.error).toBeNull();
    expect(navigate).toHaveBeenCalledTimes(1);
  });
});
