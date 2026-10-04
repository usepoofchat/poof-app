import { afterEach, describe, expect, it, vi } from "vitest";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import {
  PoofError,
  RoomSession,
  createPhraseInvite,
  derivePhraseKeys,
  encodeRoomKey,
  generatePhrase,
  generateRoomKey,
  inviteUrl,
  joinByPhrase,
  normalizePhrase,
  openInvite,
  sealInvite,
} from "../src/index.ts";
import { FakeRoomServer, FakeRtcNetwork, waitFor } from "./fakes.ts";

const ORIGIN = "https://poof.test";
const ROOM = "AAAAAAAAAAAAAAAAAAAAAA";
const WORDS = new Set(wordlist);

describe("generatePhrase", () => {
  it("is four words from the BIP-39 list, joined by dashes", () => {
    for (let i = 0; i < 50; i++) {
      const words = generatePhrase().split("-");
      expect(words).toHaveLength(4);
      for (const w of words) expect(WORDS.has(w)).toBe(true);
    }
  });

  it("doesn't repeat (44 bits of randomness)", () => {
    const seen = new Set(Array.from({ length: 200 }, generatePhrase));
    expect(seen.size).toBe(200);
  });

  it("uses the whole list (index is 11 random bits, unbiased)", () => {
    const counts = new Map<string, number>();
    for (let i = 0; i < 2000; i++)
      for (const w of generatePhrase().split("-")) counts.set(w, (counts.get(w) ?? 0) + 1);
    // 8000 draws over 2048 words: most words show up; a broken index (e.g. 8 bits) would cap at 256.
    expect(counts.size).toBeGreaterThan(1500);
  });
});

describe("normalizePhrase", () => {
  it.each([
    ["zoo-zone-zero-youth", "zoo-zone-zero-youth"],
    ["Zoo Zone Zero Youth", "zoo-zone-zero-youth"],
    ["  zoo   zone\tzero\nyouth ", "zoo-zone-zero-youth"],
    ["zoo.zone,zero_youth", "zoo-zone-zero-youth"],
    ["ＺＯＯ zone zero youth", "zoo-zone-zero-youth"], // full-width letters (NFKC)
  ])("%j → %s", (input, expected) => {
    expect(normalizePhrase(input)).toBe(expected);
  });

  it.each([
    "",
    "zoo zone zero",
    "zoo zone zero youth zoo",
    "zoo zone zero youths",
    "zoo zone zero <script>",
    "1234 zone zero youth",
    "amber otter quiet lantern", // looks right, but these aren't BIP-39 words
  ])("rejects %j", (input) => {
    expect(normalizePhrase(input)).toBeNull();
  });
});

describe("derivePhraseKeys", () => {
  it("matches an independent PBKDF2 + HKDF computation (pins the KDF across versions)", async () => {
    // Python: pbkdf2_hmac('sha256', phrase, b'poof/v1/handshake', 200000, 32), then RFC 5869 HKDF
    // with an empty salt and info 'poof/v1/handshake/id', base64url without padding.
    const { id } = await derivePhraseKeys("abandon-ability-able-about");
    expect(id).toBe("kQLGO1UrRCh4QTp63j7cIYaRVgIrQ1seIzw7ERPxJn8");
  });

  it("is deterministic per phrase and different between phrases", async () => {
    const a1 = await derivePhraseKeys("zoo-zone-zero-youth");
    const a2 = await derivePhraseKeys("zoo-zone-zero-youth");
    const b = await derivePhraseKeys("zoo-zone-zero-ladder");
    expect(a1.id).toBe(a2.id);
    expect(a1.id).not.toBe(b.id);
    expect(a1.id).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe("sealInvite / openInvite", () => {
  it("round-trips and rejects the wrong key or any tampering", async () => {
    const { key } = await derivePhraseKeys("zoo-zone-zero-youth");
    const { key: other } = await derivePhraseKeys("zoo-zone-zero-ladder");
    const blob = await sealInvite(key, "https://poof.test/r/x#y");
    expect(await openInvite(key, blob)).toBe("https://poof.test/r/x#y");
    await expect(openInvite(other, blob)).rejects.toMatchObject({ code: "decrypt_failed" });

    const bytes = Uint8Array.from(atob(blob), (c) => c.charCodeAt(0));
    bytes[bytes.length - 1]! ^= 1;
    const tampered = btoa(String.fromCharCode(...bytes));
    await expect(openInvite(key, tampered)).rejects.toMatchObject({ code: "decrypt_failed" });
    await expect(openInvite(key, "not base64!")).rejects.toMatchObject({ code: "decrypt_failed" });
    await expect(openInvite(key, btoa("short"))).rejects.toMatchObject({ code: "decrypt_failed" });
  });

  it("never puts the URL in the clear", async () => {
    const { key } = await derivePhraseKeys("zoo-zone-zero-youth");
    const blob = await sealInvite(key, "https://poof.test/r/secret-room#secret-key");
    expect(atob(blob)).not.toContain("secret");
  });
});

describe("createPhraseInvite + joinByPhrase (fake mailbox)", () => {
  const roomUrl = () => inviteUrl(ORIGIN, ROOM, generateRoomKey());

  it("a code opens the room exactly once", async () => {
    const server = new FakeRoomServer();
    const url = roomUrl();
    const { code, serverExpiresAt } = await createPhraseInvite({
      fetch: server.fetch,
      origin: ORIGIN,
      inviteUrl: url,
    });
    expect(serverExpiresAt).toBeGreaterThan(Date.now());
    expect(server.mailboxes.size).toBe(1);
    // The server holds neither the phrase nor the URL.
    expect(JSON.stringify([...server.mailboxes])).not.toContain(code);
    expect(JSON.stringify([...server.mailboxes])).not.toContain(ROOM);

    const typed = code.replaceAll("-", " ").toUpperCase();
    const path = await joinByPhrase({ fetch: server.fetch, origin: ORIGIN, code: typed });
    expect(`${ORIGIN}${path}`).toBe(url);

    await expect(joinByPhrase({ fetch: server.fetch, origin: ORIGIN, code })).rejects.toMatchObject(
      {
        code: "not_found_or_expired",
      },
    );
  });

  it("with the API on another origin, the invite must point at the web app's origin", async () => {
    const server = new FakeRoomServer();
    const APP = "https://app.test";
    const url = inviteUrl(APP, ROOM, generateRoomKey());
    const { code } = await createPhraseInvite({
      fetch: server.fetch,
      origin: ORIGIN,
      inviteUrl: url,
    });
    const path = await joinByPhrase({ fetch: server.fetch, origin: ORIGIN, appOrigin: APP, code });
    expect(`${APP}${path}`).toBe(url);

    // The same invite is refused when the app is expected somewhere else.
    const again = await createPhraseInvite({ fetch: server.fetch, origin: ORIGIN, inviteUrl: url });
    await expect(
      joinByPhrase({ fetch: server.fetch, origin: ORIGIN, code: again.code }),
    ).rejects.toMatchObject({
      code: "decrypt_failed",
    });
  });

  it("rejects a malformed code before calling the server", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(
      joinByPhrase({ fetch, origin: ORIGIN, code: "hello world" }),
    ).rejects.toMatchObject({
      code: "invalid_code",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["another origin", "https://evil.example/join/#AAAAAAAAAAAAAAAAAAAAAA." + "k".repeat(43)],
    ["http instead of https", "http://poof.test/join/#AAAAAAAAAAAAAAAAAAAAAA." + "k".repeat(43)],
    [
      "a query string",
      "https://poof.test/join/?next=evil#AAAAAAAAAAAAAAAAAAAAAA." + "k".repeat(43),
    ],
    ["not a room path", "https://poof.test/elsewhere#AAAAAAAAAAAAAAAAAAAAAA." + "k".repeat(43)],
    ["no key", "https://poof.test/join/#AAAAAAAAAAAAAAAAAAAAAA"],
    ["not a URL", "javascript:alert(1)"],
  ])("refuses a blob that points at %s (no open redirect)", async (_label, evilUrl) => {
    const server = new FakeRoomServer();
    const code = "zoo-zone-zero-youth";
    const { id, key } = await derivePhraseKeys(code);
    server.mailboxes.set(id, {
      blob: await sealInvite(key, evilUrl),
      expiresAt: Date.now() + 60_000,
    });
    await expect(joinByPhrase({ fetch: server.fetch, origin: ORIGIN, code })).rejects.toMatchObject(
      {
        code: "decrypt_failed",
      },
    );
  });

  it("retries with a new phrase when the mailbox id is taken, and maps errors", async () => {
    let calls = 0;
    const busyOnce: typeof fetch = async () => {
      calls += 1;
      return calls === 1
        ? Response.json({ error: { code: "handshake_exists" } }, { status: 409 })
        : Response.json({ expiresAt: Date.now() + 180_000 }, { status: 201 });
    };
    await createPhraseInvite({ fetch: busyOnce, origin: ORIGIN, inviteUrl: roomUrl() });
    expect(calls).toBe(2);

    const limited: typeof fetch = async () => new Response("{}", { status: 429 });
    await expect(
      createPhraseInvite({ fetch: limited, origin: ORIGIN, inviteUrl: roomUrl() }),
    ).rejects.toMatchObject({
      code: "rate_limited",
    });
    const down: typeof fetch = () => Promise.reject(new TypeError("offline"));
    await expect(
      joinByPhrase({ fetch: down, origin: ORIGIN, code: "zoo zone zero youth" }),
    ).rejects.toBeInstanceOf(PoofError);
  });
});

describe("RoomSession.createPhrase", () => {
  afterEach(() => vi.useRealTimers());

  function session(server: FakeRoomServer) {
    return new RoomSession({
      roomId: ROOM,
      roomKey: generateRoomKey(),
      origin: ORIGIN,
      fetch: server.fetch,
      createSocket: server.createSocket,
      createPeerConnection: new FakeRtcNetwork().factory,
    });
  }

  it("fills state.phrase, and the code leads a joiner to this exact room", async () => {
    const server = new FakeRoomServer();
    server.createRoom(ROOM);
    const s = session(server);
    await s.start();
    await waitFor(() => s.getState().status === "waiting");

    const phrase = await s.createPhrase();
    expect(s.getState().phrase).toEqual(phrase);
    expect(phrase.expiresAt - Date.now()).toBeGreaterThan(170_000);
    const path = await joinByPhrase({ fetch: server.fetch, origin: ORIGIN, code: phrase.code });
    expect(`${ORIGIN}${path}`).toBe(s.getState().inviteUrl);
  });

  it("never outlives the room and clears itself when it expires", async () => {
    const server = new FakeRoomServer();
    server.createRoom(ROOM, 1_000); // the room has 1 s left, the mailbox would last 3 min
    const s = session(server);
    await s.start();
    await waitFor(() => s.getState().status === "waiting");

    const phrase = await s.createPhrase();
    expect(phrase.expiresAt).toBeLessThanOrEqual(s.getState().expiresAt!);
    await waitFor(() => s.getState().phrase === null, "phrase cleared", 3000);
  });

  it("is refused before the room is loaded and after it ended", async () => {
    const server = new FakeRoomServer();
    server.createRoom(ROOM);
    const s = session(server);
    await expect(s.createPhrase()).rejects.toMatchObject({ code: "not_connected" });
    await s.start();
    await waitFor(() => s.getState().status === "waiting");
    await s.leave();
    await expect(s.createPhrase()).rejects.toMatchObject({ code: "not_connected" });
    expect(encodeRoomKey(generateRoomKey())).toHaveLength(43);
  });
});
