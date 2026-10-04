import { StrictMode, type ReactNode } from "react";
import { act, render, renderHook, waitFor as rtlWaitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  PoofError,
  encodeRoomKey,
  generateRoomKey,
  joinByPhrase,
  type SessionStatus,
} from "@poof/core";
import { FakeRoomServer, FakeRtcNetwork } from "../../packages/core/test/fakes.ts";
import { RoomProvider } from "./RoomProvider.tsx";
import { MemoryStorage } from "../test/memoryStorage.ts";
import { readOwnerSecret, saveOwnerSecret } from "./ownerSecret.ts";
import { useRoom } from "./useRoom.ts";

const ORIGIN = "https://poof.test";
const ROOM = "R".repeat(22);

/**
 * A room on the fake server. `wrapper` is the creator's tab (its storage holds the owner secret, as
 * useCreateRoom leaves it); `guest` is someone who opened the invite link in another browser.
 */
function world() {
  const server = new FakeRoomServer();
  server.createRoom(ROOM);
  const net = new FakeRtcNetwork();
  const key = encodeRoomKey(generateRoomKey());
  const location = { pathname: "/join/", hash: `#${ROOM}.${key}` };
  const ownerStorage = new MemoryStorage();
  saveOwnerSecret(ROOM, FakeRoomServer.OWNER_SECRET, ownerStorage);
  const tab = (storage: Storage) =>
    function Tab({ children }: { children: ReactNode }) {
      return (
        <RoomProvider
          location={location}
          origin={ORIGIN}
          fetch={server.fetch}
          createSocket={server.createSocket}
          createPeerConnection={net.factory}
          storage={storage}
        >
          {children}
        </RoomProvider>
      );
    };
  return {
    server,
    net,
    key,
    ownerStorage,
    wrapper: tab(ownerStorage),
    guest: tab(new MemoryStorage()),
  };
}

async function until(get: () => SessionStatus, status: SessionStatus) {
  await rtlWaitFor(() => expect(get()).toBe(status), { timeout: 3000 });
}

describe("RoomProvider + useRoom", () => {
  it("useRoom outside the provider is a programming error", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => renderHook(() => useRoom())).toThrow(/inside <RoomProvider>/);
    vi.restoreAllMocks();
  });

  it("starts in loading with the invite URL, then waits for the other person", async () => {
    const w = world();
    const { result } = renderHook(() => useRoom(), { wrapper: w.wrapper });
    expect(result.current.state).toMatchObject({
      status: "loading",
      roomId: ROOM,
      inviteUrl: `${ORIGIN}/join/#${ROOM}.${w.key}`,
    });
    await until(() => result.current.state.status, "waiting");
    expect(result.current.state.expiresAt).toBeGreaterThan(Date.now());
  });

  it("a broken link is an invalid_link error and never touches the server", async () => {
    const server = new FakeRoomServer();
    const { result } = renderHook(() => useRoom(), {
      wrapper: ({ children }) => (
        <RoomProvider
          location={{ pathname: "/join/", hash: "#nope.x" }}
          origin={ORIGIN}
          fetch={server.fetch}
          createSocket={server.createSocket}
        >
          {children}
        </RoomProvider>
      ),
    });
    expect(result.current.state).toMatchObject({
      status: "error",
      error: { code: "invalid_link" },
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(server.fetchCalls).toEqual([]);
    expect(server.sockets).toEqual([]);
  });

  it("two providers pair, chat both ways through actions, and destroy ends it for both", async () => {
    const w = world();
    const alice = renderHook(() => useRoom(), { wrapper: w.wrapper });
    await until(() => alice.result.current.state.status, "waiting");
    const bob = renderHook(() => useRoom(), { wrapper: w.guest });
    await until(() => alice.result.current.state.status, "sealed");
    await until(() => bob.result.current.state.status, "sealed");

    await act(() => alice.result.current.actions.sendMessage("hi bob"));
    await rtlWaitFor(() =>
      expect(bob.result.current.state.messages).toMatchObject([
        { kind: "text", mine: false, text: "hi bob" },
      ]),
    );
    await act(() => bob.result.current.actions.sendMessage("hi alice"));
    await rtlWaitFor(() => expect(alice.result.current.state.messages).toHaveLength(2));

    await act(() => alice.result.current.actions.destroy());
    expect(alice.result.current.state).toMatchObject({
      status: "terminated",
      endReason: "destroyed_by_me",
    });
    await until(() => bob.result.current.state.status, "terminated");
    expect(bob.result.current.state.endReason).toBe("destroyed_by_peer");
    expect(bob.result.current.state.messages).toEqual([]);
  });

  it("unmounting (leaving the route) ends the room for the other person", async () => {
    const w = world();
    const alice = renderHook(() => useRoom(), { wrapper: w.wrapper });
    await until(() => alice.result.current.state.status, "waiting");
    const bob = renderHook(() => useRoom(), { wrapper: w.guest });
    await until(() => alice.result.current.state.status, "sealed");

    bob.unmount();
    await until(() => alice.result.current.state.status, "terminated");
    expect(alice.result.current.state.endReason).toBe("peer_left");
  });

  it("closing the tab (pagehide) leaves the room", async () => {
    const w = world();
    const alice = renderHook(() => useRoom(), { wrapper: w.wrapper });
    await until(() => alice.result.current.state.status, "waiting");
    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });
    await until(() => alice.result.current.state.status, "terminated");
    expect(alice.result.current.state.endReason).toBe("left_by_me");
  });

  it("StrictMode's throwaway first mount never reaches the server", async () => {
    const w = world();
    const { result } = renderHook(() => useRoom(), {
      wrapper: ({ children }) => <StrictMode>{w.wrapper({ children })}</StrictMode>,
    });
    await until(() => result.current.state.status, "waiting");
    await new Promise((r) => setTimeout(r, 20));
    expect(w.server.fetchCalls).toHaveLength(1);
    expect(w.server.sockets).toHaveLength(1);
  });

  it("the creator's tab is the owner; the guest isn't and can't destroy", async () => {
    const w = world();
    const alice = renderHook(() => useRoom(), { wrapper: w.wrapper });
    expect(alice.result.current.state.isOwner).toBe(true);
    await until(() => alice.result.current.state.status, "waiting");
    const bob = renderHook(() => useRoom(), { wrapper: w.guest });
    expect(bob.result.current.state.isOwner).toBe(false);
    await until(() => bob.result.current.state.status, "sealed");

    await expect(bob.result.current.actions.destroy()).rejects.toMatchObject({ code: "not_owner" });
    expect(alice.result.current.state.status).toBe("sealed");
  });

  it("leave() ends a free room for the other person; the creator keeps the secret (refresh case)", async () => {
    const w = world();
    const alice = renderHook(() => useRoom(), { wrapper: w.wrapper });
    await until(() => alice.result.current.state.status, "waiting");
    const bob = renderHook(() => useRoom(), { wrapper: w.guest });
    await until(() => alice.result.current.state.status, "sealed");

    await act(() => alice.result.current.actions.leave());
    expect(alice.result.current.state.endReason).toBe("left_by_me");
    await until(() => bob.result.current.state.status, "terminated");
    expect(bob.result.current.state.endReason).toBe("peer_left");
    expect(readOwnerSecret(ROOM, w.ownerStorage)).toBe(FakeRoomServer.OWNER_SECRET);
  });

  it("the secret is forgotten once the room is destroyed", async () => {
    const w = world();
    const alice = renderHook(() => useRoom(), { wrapper: w.wrapper });
    await until(() => alice.result.current.state.status, "waiting");
    await act(() => alice.result.current.actions.destroy());
    expect(readOwnerSecret(ROOM, w.ownerStorage)).toBeUndefined();
  });

  it("actions before connecting reject with codes the UI can map", async () => {
    const w = world();
    const { result } = renderHook(() => useRoom(), { wrapper: w.wrapper });
    await until(() => result.current.state.status, "waiting");
    const { sendMessage, sendFile } = result.current.actions;
    await expect(sendMessage("too early")).rejects.toMatchObject({ code: "not_connected" });
    await expect(sendFile(new File(["x"], "x.txt"))).rejects.toBeInstanceOf(PoofError);
    await expect(sendFile(new File(["x"], "x.txt"))).rejects.toMatchObject({
      code: "not_connected",
    });
  });

  it("files: off in a free room; in a super room one arrives as a downloadable item, and can be cancelled", async () => {
    const created: Blob[] = [];
    const revoked: string[] = [];
    // jsdom has no blob: URLs; stand in for them.
    const original = Object.getOwnPropertyDescriptors(URL);
    URL.createObjectURL = (blob: Blob) => `blob:test/${created.push(blob)}`;
    URL.revokeObjectURL = (url: string) => void revoked.push(url);
    try {
      const free = world();
      const a0 = renderHook(() => useRoom(), { wrapper: free.wrapper });
      await until(() => a0.result.current.state.status, "waiting");
      renderHook(() => useRoom(), { wrapper: free.guest });
      await until(() => a0.result.current.state.status, "sealed");
      expect(a0.result.current.state.limits.fileTransfer).toBe(false);
      await expect(
        a0.result.current.actions.sendFile(new File(["x"], "x.txt")),
      ).rejects.toMatchObject({ code: "not_available" });

      const w = world();
      w.server.rooms.get(ROOM)!.plan = "super";
      const alice = renderHook(() => useRoom(), { wrapper: w.wrapper });
      await until(() => alice.result.current.state.status, "waiting");
      const bob = renderHook(() => useRoom(), { wrapper: w.guest });
      await until(() => bob.result.current.state.status, "sealed");
      expect(alice.result.current.state.limits).toEqual({
        fileTransfer: true,
        fileMaxBytes: 2_097_152,
      });

      await act(() =>
        alice.result.current.actions.sendFile(
          new File(["hello file"], "note.png", { type: "image/png" }),
        ),
      );
      await rtlWaitFor(() =>
        expect(bob.result.current.state.messages).toMatchObject([
          {
            kind: "file",
            mine: false,
            name: "note.png",
            mime: "image/png",
            size: 10,
            status: "received",
            url: "blob:test/1",
          },
        ]),
      );
      expect(await created[0]!.text()).toBe("hello file");
      await rtlWaitFor(() =>
        expect(alice.result.current.state.messages).toMatchObject([
          { kind: "file", mine: true, status: "delivered", delivered: 1 },
        ]),
      );
      // Cancelling a finished transfer changes nothing.
      act(() =>
        alice.result.current.actions.abortTransfer(alice.result.current.state.messages[0]!.id),
      );
      expect(alice.result.current.state.messages[0]).toMatchObject({ status: "delivered" });

      bob.unmount(); // leaving revokes what was received
      await rtlWaitFor(() => expect(revoked).toEqual(["blob:test/1"]));
    } finally {
      for (const name of ["createObjectURL", "revokeObjectURL"] as const) {
        const descriptor = original[name];
        if (descriptor) Object.defineProperty(URL, name, descriptor);
        else delete (URL as unknown as Record<string, unknown>)[name];
      }
    }
  });

  it("createPhrase fills state.phrase, and the code takes a guest to this room", async () => {
    const w = world();
    const { result } = renderHook(() => useRoom(), { wrapper: w.wrapper });
    await until(() => result.current.state.status, "waiting");
    await act(() => result.current.actions.createPhrase());
    const phrase = result.current.state.phrase;
    expect(phrase?.code).toMatch(/^[a-z]+(-[a-z]+){3}$/);
    expect(phrase!.expiresAt).toBeLessThanOrEqual(result.current.state.expiresAt!);

    const path = await joinByPhrase({ fetch: w.server.fetch, origin: ORIGIN, code: phrase!.code });
    expect(`${ORIGIN}${path}`).toBe(result.current.state.inviteUrl);
  });

  it("re-renders components only through useRoom (smoke render)", async () => {
    const w = world();
    function Status() {
      const { state } = useRoom();
      return <p data-testid="status">{state.status}</p>;
    }
    const view = render(<Status />, { wrapper: w.wrapper });
    expect(view.getByTestId("status").textContent).toBe("loading");
    await rtlWaitFor(() => expect(view.getByTestId("status").textContent).toBe("waiting"));
  });

  it("group rooms: members, nicknames and someone leaving, through the hook", async () => {
    const server = new FakeRoomServer();
    server.createRoom(ROOM, 300_000, FakeRoomServer.OWNER_SECRET, 4);
    const net = new FakeRtcNetwork();
    const key = encodeRoomKey(generateRoomKey());
    const location = { pathname: "/join/", hash: `#${ROOM}.${key}` };
    const tab = (storage: Storage) =>
      function Tab({ children }: { children: ReactNode }) {
        return (
          <RoomProvider
            location={location}
            origin={ORIGIN}
            fetch={server.fetch}
            createSocket={server.createSocket}
            createPeerConnection={net.factory}
            storage={storage}
          >
            {children}
          </RoomProvider>
        );
      };
    const ownerStorage = new MemoryStorage();
    saveOwnerSecret(ROOM, FakeRoomServer.OWNER_SECRET, ownerStorage);
    const alice = renderHook(() => useRoom(), { wrapper: tab(ownerStorage) });
    await until(() => alice.result.current.state.status, "waiting");
    const bob = renderHook(() => useRoom(), { wrapper: tab(new MemoryStorage()) });
    const carol = renderHook(() => useRoom(), { wrapper: tab(new MemoryStorage()) });
    const linked = (r: typeof alice) =>
      r.result.current.state.members.filter((m) => m.state === "sealed").length;
    await rtlWaitFor(() => expect([linked(alice), linked(bob), linked(carol)]).toEqual([2, 2, 2]), {
      timeout: 3000,
    });
    expect(alice.result.current.state.maxPeers).toBe(4);

    act(() => alice.result.current.actions.setNickname("Ana"));
    expect(alice.result.current.state.nickname).toBe("Ana");
    await rtlWaitFor(() =>
      expect(bob.result.current.state.members.some((m) => m.nickname === "Ana")).toBe(true),
    );

    carol.unmount();
    await rtlWaitFor(() => expect(linked(alice)).toBe(1));
    expect(alice.result.current.state.status).toBe("sealed");
    expect(
      alice.result.current.state.messages.some((m) => m.kind === "system" && m.event === "left"),
    ).toBe(true);
  });
});
