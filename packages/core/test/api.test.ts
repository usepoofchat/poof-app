import { describe, expect, it, vi } from "vitest";
import {
  PoofError,
  createRoom,
  decodeRoomKey,
  encodeRoomKey,
  generateRoomKey,
  inviteUrl,
  inviteFragment,
  parseInviteFragment,
  parseRoomLocation,
  roomPath,
  fromBase64Url,
  toBase64Url,
} from "../src/index.ts";
import { sha256 } from "../src/crypto/primitives.ts";

const ROOM_ID = "AAAAAAAAAAAAAAAAAAAAAA";
const created = {
  roomId: ROOM_ID,
  expiresAt: 2,
  serverNow: 1,
  plan: "free",
  tier: "free",
  maxPeers: 2,
  limits: { fileTransfer: false, fileMaxBytes: 2_097_152 },
};

function fetchReturning(body: unknown, status = 200) {
  return vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), { status }));
}

describe("createRoom", () => {
  it("POSTs JSON and returns the id, a fresh key and the room path", async () => {
    const f = fetchReturning(created);
    const room = await createRoom({ fetch: f, origin: "https://poof.test" });

    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe("https://poof.test/api/rooms");
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>)["Content-Type"]).toBe("application/json");

    expect(room.roomId).toBe(ROOM_ID);
    expect(room.key).toHaveLength(32);
    expect(room.path).toBe(`/join/#${ROOM_ID}.${encodeRoomKey(room.key)}`);
    expect(room.info.expiresAt).toBe(2);
  });

  it("sends only the SHA-256 of a fresh creator secret and returns the secret", async () => {
    const f = fetchReturning(created);
    const room = await createRoom({ fetch: f });
    expect(room.ownerSecret).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const body = JSON.parse(f.mock.calls[0]![1]?.body as string) as { ownerHash: string };
    const expected = toBase64Url(await sha256(fromBase64Url(room.ownerSecret)));
    expect(body).toEqual({ ownerHash: expected });
    expect(JSON.stringify(f.mock.calls)).not.toContain(room.ownerSecret);
    // ...and it isn't in the invite link either.
    expect(room.path).not.toContain(room.ownerSecret);

    const other = await createRoom({ fetch: f });
    expect(other.ownerSecret).not.toBe(room.ownerSecret);
  });

  it("generates a different key every time and never sends it to the server", async () => {
    const f = fetchReturning(created);
    const a = await createRoom({ fetch: f });
    const b = await createRoom({ fetch: f });
    expect(a.path).not.toBe(b.path);
    for (const [url, init] of f.mock.calls) {
      expect(url as string).not.toContain(encodeRoomKey(a.key));
      expect(init?.body as string).not.toContain(encodeRoomKey(a.key));
    }
  });

  it("maps 429 to rate_limited, other failures and network errors to connection_failed", async () => {
    await expect(createRoom({ fetch: fetchReturning({}, 429) })).rejects.toMatchObject({
      code: "rate_limited",
    });
    await expect(createRoom({ fetch: fetchReturning({}, 500) })).rejects.toMatchObject({
      code: "connection_failed",
    });
    const down = vi.fn<typeof fetch>(async () => {
      throw new TypeError("network");
    });
    await expect(createRoom({ fetch: down })).rejects.toMatchObject({ code: "connection_failed" });
  });

  it("rejects an unexpected response body", async () => {
    await expect(createRoom({ fetch: fetchReturning({ roomId: "short" }) })).rejects.toBeInstanceOf(
      PoofError,
    );
    const notJson = vi.fn<typeof fetch>(async () => new Response("<html>", { status: 200 }));
    await expect(createRoom({ fetch: notJson })).rejects.toMatchObject({
      code: "connection_failed",
    });
  });
});

describe("room links", () => {
  const key = generateRoomKey();
  const encoded = encodeRoomKey(key);

  it("builds paths and invite urls with the room id and key in the fragment", () => {
    expect(inviteFragment(ROOM_ID, key)).toBe(`${ROOM_ID}.${encoded}`);
    expect(roomPath(ROOM_ID, key)).toBe(`/join/#${ROOM_ID}.${encoded}`);
    expect(inviteUrl("https://poof.test", ROOM_ID, key)).toBe(
      `https://poof.test/join/#${ROOM_ID}.${encoded}`,
    );
    expect(inviteUrl("https://poof.test/", ROOM_ID, key)).toBe(
      `https://poof.test/join/#${ROOM_ID}.${encoded}`,
    );
  });

  it("neither the room id nor the key appears before the # (so no server ever sees them)", () => {
    const url = new URL(inviteUrl("https://poof.test", ROOM_ID, key));
    expect(url.pathname + url.search).toBe("/join/");
    expect(url.hash).toBe(`#${ROOM_ID}.${encoded}`);
  });

  it("parses a valid location and a bare fragment", () => {
    const parsed = parseRoomLocation("/join/", `#${ROOM_ID}.${encoded}`);
    expect(parsed.roomId).toBe(ROOM_ID);
    expect(Array.from(parsed.key)).toEqual(Array.from(key));
    expect(parseRoomLocation("/join", `${ROOM_ID}.${encoded}`).roomId).toBe(ROOM_ID); // no slash, bare hash
    expect(parseInviteFragment(`${ROOM_ID}.${encoded}`).roomId).toBe(ROOM_ID);
    expect(parseInviteFragment(`#${ROOM_ID}.${encoded}`).roomId).toBe(ROOM_ID);
  });

  it.each([
    ["wrong path", "/room/", `#${ROOM_ID}.${encoded}`],
    ["extra path", "/join/x", `#${ROOM_ID}.${encoded}`],
    ["the old /r/ form", `/r/${ROOM_ID}`, "#" + encoded],
    ["short id", "/join/", `#abc.${encoded}`],
    ["missing key", "/join/", `#${ROOM_ID}`],
    ["missing key after the dot", "/join/", `#${ROOM_ID}.`],
    ["short key", "/join/", `#${ROOM_ID}.abc`],
    ["bad key chars", "/join/", `#${ROOM_ID}.${"+".repeat(43)}`],
    ["two dots", "/join/", `#${ROOM_ID}.${encoded}.x`],
  ])("rejects %s with invalid_link", (_name, path, hash) => {
    expect(() => parseRoomLocation(path, hash)).toThrowError(
      expect.objectContaining({ code: "invalid_link" }),
    );
  });

  it("decodeRoomKey round-trips", () => {
    expect(Array.from(decodeRoomKey(encoded))).toEqual(Array.from(key));
  });
});
