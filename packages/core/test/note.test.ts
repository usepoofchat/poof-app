import {
  NOTE_MAX_WRONG_REVEALS,
  NOTE_TEXT_MAX_CHARS,
  createNoteRequestSchema,
  noteCreatorRequestSchema,
  revealNoteRequestSchema,
} from "@poof/protocol";
import { describe, expect, it } from "vitest";
import {
  PoofError,
  createNote,
  createNotePhrase,
  createPhraseInvite,
  deleteNote,
  encodeRoomKey,
  fromBase64Url,
  generateRoomKey,
  inviteUrl,
  joinByPhrase,
  noteFits,
  noteStatus,
  noteUrl,
  openNote,
  openNoteByPhrase,
  parseNoteFragment,
  randomBytes,
  revealNote,
  sealNote,
  toBase64Url,
  type NoteLink,
} from "../src/index.ts";
import { FakeRoomServer } from "./fakes.ts";

const ORIGIN = "https://poof.test";

const sha = async (b64: string) =>
  toBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", fromBase64Url(b64))));

/** In-memory notes API with the rules NoteDO has; the phrase mailbox comes from FakeRoomServer. */
function notesWorld() {
  const notes = new Map<
    string,
    {
      state: "waiting" | "read" | "deleted";
      expiresAt: number;
      creatorHash: string;
      ciphertext?: string;
      revealHash?: string;
      wrong: number;
    }
  >();
  const bodies: string[] = [];
  const rooms = new FakeRoomServer();
  let now = 1_000_000;
  const reply = (status: number, body: unknown) => Response.json(body, { status });
  const err = (status: number, code: string) => reply(status, { error: { code, message: code } });
  const live = (id: string) => {
    const n = notes.get(id);
    return n && now < n.expiresAt ? n : undefined;
  };

  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input : input.url,
    );
    if (!url.pathname.startsWith("/api/notes")) return rooms.fetch(input, init);
    const body = typeof init?.body === "string" ? init.body : "";
    bodies.push(body);
    const json = JSON.parse(body || "{}") as unknown;
    if (url.pathname === "/api/notes") {
      const p = createNoteRequestSchema.safeParse(json);
      if (!p.success) return err(400, "invalid_request");
      if (notes.has(p.data.id)) return err(409, "note_exists");
      const expiresAt = now + p.data.ttl * 1000;
      notes.set(p.data.id, {
        state: "waiting",
        expiresAt,
        creatorHash: p.data.creatorHash,
        ciphertext: p.data.ciphertext,
        revealHash: p.data.revealHash,
        wrong: 0,
      });
      return reply(201, { id: p.data.id, expiresAt });
    }
    const m = /^\/api\/notes\/([^/]+)(\/reveal|\/status)?$/.exec(url.pathname)!;
    const n = live(m[1]!);
    if (m[2] === "/reveal") {
      const p = revealNoteRequestSchema.parse(json);
      if (!n || n.state !== "waiting") return err(410, "note_gone");
      if ((await sha(p.revealToken)) !== n.revealHash) {
        n.wrong += 1;
        if (n.wrong >= NOTE_MAX_WRONG_REVEALS)
          Object.assign(n, { state: "deleted", ciphertext: undefined });
        return err(403, "wrong_secret");
      }
      const { ciphertext } = n;
      Object.assign(n, { state: "read", ciphertext: undefined, revealHash: undefined });
      return reply(200, { ciphertext });
    }
    const p = noteCreatorRequestSchema.parse(json);
    if (!n) return reply(200, { state: "expired" });
    if ((await sha(p.creatorSecret)) !== n.creatorHash) return err(403, "not_owner");
    if (init?.method === "DELETE" && n.state === "waiting")
      Object.assign(n, { state: "deleted", ciphertext: undefined });
    return reply(200, { state: n.state, expiresAt: n.expiresAt });
  }) as typeof fetch;

  return {
    fetch: fetchFn,
    notes,
    bodies,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const base = (w: ReturnType<typeof notesWorld>) => ({ fetch: w.fetch, origin: ORIGIN });
const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return "ok";
  } catch (e) {
    return e instanceof PoofError ? e.code : String(e);
  }
};

describe("note links", () => {
  it("round-trip, with and without the password mark", () => {
    const link: NoteLink = { id: "A".repeat(22), key: randomBytes(32), hasPassword: false };
    const url = noteUrl("https://usepoof.chat/", link);
    expect(url).toMatch(/^https:\/\/usepoof\.chat\/note\/#A{22}\.[A-Za-z0-9_-]{43}$/);
    const back = parseNoteFragment(new URL(url).hash);
    expect(back.id).toBe(link.id);
    expect(back.key).toEqual(link.key);
    expect(back.hasPassword).toBe(false);
    expect(
      parseNoteFragment(noteUrl(ORIGIN, { ...link, hasPassword: true }).split("/note/")[1]!)
        .hasPassword,
    ).toBe(true);
  });

  it("anything else is not a note link", () => {
    for (const bad of [
      "",
      "#abc",
      `#${"A".repeat(22)}`,
      `#${"A".repeat(22)}.short`,
      `#${"A".repeat(22)}.${"B".repeat(43)}.x`,
    ])
      expect(() => parseNoteFragment(bad)).toThrow(PoofError);
  });
});

describe("note encryption", () => {
  const link = (): NoteLink => ({
    id: toBase64Url(randomBytes(16)),
    key: randomBytes(32),
    hasPassword: false,
  });

  it("seals and opens", async () => {
    const l = link();
    const { ciphertext } = await sealNote(l, "meet at 8 · ăîșț 🦊");
    expect(await openNote(l, ciphertext)).toBe("meet at 8 · ăîșț 🦊");
  });

  it("the ciphertext is bound to its note id (AAD) and to its key", async () => {
    const l = link();
    const { ciphertext } = await sealNote(l, "secret");
    expect(await code(openNote({ ...l, id: toBase64Url(randomBytes(16)) }, ciphertext))).toBe(
      "decrypt_failed",
    );
    expect(await code(openNote({ ...l, key: randomBytes(32) }, ciphertext))).toBe("decrypt_failed");
  });

  it("a changed byte is refused", async () => {
    const l = link();
    const raw = fromBase64Url((await sealNote(l, "secret")).ciphertext);
    raw[raw.length - 1] = raw[raw.length - 1]! ^ 1;
    expect(await code(openNote(l, toBase64Url(raw)))).toBe("decrypt_failed");
  });

  it("with a password, both the link and the password are needed", async () => {
    const l = { ...link(), hasPassword: true };
    const { ciphertext, revealToken } = await sealNote(l, "two keys", "correct horse");
    expect(await openNote(l, ciphertext, "correct horse")).toBe("two keys");
    expect(await code(openNote(l, ciphertext, "wrong horse"))).toBe("decrypt_failed");
    expect(await code(openNote({ ...l, key: randomBytes(32) }, ciphertext, "correct horse"))).toBe(
      "decrypt_failed",
    );
    // the reveal token changes with the password, so the server can't be asked with a guess
    expect((await sealNote(l, "two keys", "wrong horse")).revealToken).not.toBe(revealToken);
  });

  it("size: 10,000 plain characters fit; more, or text too big once encoded, don't", () => {
    expect(noteFits("a".repeat(NOTE_TEXT_MAX_CHARS))).toBe(true);
    expect(noteFits("a".repeat(NOTE_TEXT_MAX_CHARS + 1))).toBe(false);
    expect(noteFits("🦊".repeat(5000))).toBe(false); // 5,000 characters but 20 KB of UTF-8
    expect(noteFits("")).toBe(false);
  });
});

describe("Poof Note against the API", () => {
  it("write, then read once; the second reading is gone", async () => {
    const w = notesWorld();
    const note = await createNote({
      ...base(w),
      appOrigin: "https://usepoof.chat",
      text: "read once",
      ttl: 600,
    });
    expect(note.url.startsWith("https://usepoof.chat/note/#")).toBe(true);
    const link = parseNoteFragment(new URL(note.url).hash);
    expect(await revealNote({ ...base(w), link })).toBe("read once");
    expect(await code(revealNote({ ...base(w), link }))).toBe("note_gone");
  });

  it("the server never receives the key, the text, the password or the secrets", async () => {
    const w = notesWorld();
    const note = await createNote({
      ...base(w),
      text: "do not leak",
      ttl: 3600,
      password: "hunter2-but-long",
    });
    const link = parseNoteFragment(new URL(note.url).hash);
    await noteStatus({ ...base(w), id: note.id, creatorSecret: note.creatorSecret });
    await revealNote({ ...base(w), link, password: "hunter2-but-long" });
    const sent = w.bodies.join("\n");
    expect(sent).not.toContain(toBase64Url(link.key));
    expect(sent).not.toContain("do not leak");
    expect(sent).not.toContain("hunter2");
    expect(w.bodies[0]).not.toContain(note.creatorSecret);
  });

  it("a wrong password doesn't use the note up; the right one opens it", async () => {
    const w = notesWorld();
    const note = await createNote({
      ...base(w),
      text: "behind a password",
      ttl: 600,
      password: "right one",
    });
    const link = parseNoteFragment(new URL(note.url).hash);
    expect(link.hasPassword).toBe(true);
    expect(await code(revealNote({ ...base(w), link, password: "wrong one" }))).toBe(
      "wrong_password",
    );
    expect(await code(revealNote({ ...base(w), link }))).toBe("wrong_password"); // no password: not even asked
    expect(await revealNote({ ...base(w), link, password: "right one" })).toBe("behind a password");
  });

  it("expired notes are gone for the reader and expired for the writer", async () => {
    const w = notesWorld();
    const note = await createNote({ ...base(w), text: "soon gone", ttl: 600 });
    w.advance(600_001);
    const link = parseNoteFragment(new URL(note.url).hash);
    expect(await code(revealNote({ ...base(w), link }))).toBe("note_gone");
    expect(
      await noteStatus({ ...base(w), id: note.id, creatorSecret: note.creatorSecret }),
    ).toEqual({ state: "expired" });
  });

  it("status and delete need the writer's secret", async () => {
    const w = notesWorld();
    const note = await createNote({ ...base(w), text: "maybe", ttl: 600 });
    const other = toBase64Url(randomBytes(32));
    expect(await code(deleteNote({ ...base(w), id: note.id, creatorSecret: other }))).toBe(
      "not_owner",
    );
    expect(
      (await noteStatus({ ...base(w), id: note.id, creatorSecret: note.creatorSecret })).state,
    ).toBe("waiting");
    expect(
      (await deleteNote({ ...base(w), id: note.id, creatorSecret: note.creatorSecret })).state,
    ).toBe("deleted");
    const link = parseNoteFragment(new URL(note.url).hash);
    expect(await code(revealNote({ ...base(w), link }))).toBe("note_gone");
  });

  it("too long or empty notes are refused before anything is sent", async () => {
    const w = notesWorld();
    expect(
      await code(createNote({ ...base(w), text: "a".repeat(NOTE_TEXT_MAX_CHARS + 1), ttl: 600 })),
    ).toBe("note_too_long");
    expect(await code(createNote({ ...base(w), text: "", ttl: 600 }))).toBe("invalid_message");
    expect(w.bodies).toHaveLength(0);
  });
});

describe("a note by 4-word phrase", () => {
  it("the phrase opens the note's link; reading it is still a separate step", async () => {
    const w = notesWorld();
    const note = await createNote({ ...base(w), text: "said out loud", ttl: 600 });
    const { code: words } = await createNotePhrase({ ...base(w), url: note.url });
    const link = await openNoteByPhrase({ ...base(w), code: words });
    expect(link.id).toBe(note.id);
    expect(w.notes.get(note.id)!.state).toBe("waiting");
    expect(await revealNote({ ...base(w), link })).toBe("said out loud");
  });

  it("a room phrase doesn't open as a note, and a note phrase doesn't open as a room", async () => {
    const w = notesWorld();
    const roomUrl = inviteUrl(ORIGIN, "AAAAAAAAAAAAAAAAAAAAAA", generateRoomKey());
    const roomWords = (await createPhraseInvite({ ...base(w), inviteUrl: roomUrl })).code;
    expect(await code(openNoteByPhrase({ ...base(w), code: roomWords }))).toBe("decrypt_failed");
    const note = await createNote({ ...base(w), text: "x", ttl: 600 });
    const noteWords = (await createNotePhrase({ ...base(w), url: note.url })).code;
    expect(await code(joinByPhrase({ ...base(w), code: noteWords }))).toBe("decrypt_failed");
    expect(encodeRoomKey(generateRoomKey())).toHaveLength(43);
  });
});
