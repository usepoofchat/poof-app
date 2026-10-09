import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { NOTE_CIPHERTEXT_MAX_BYTES, NOTE_MAX_WRONG_REVEALS } from "@poof/protocol";
import { describe, expect, it, vi } from "vitest";
import worker from "../src/index.ts";
import { toBase64Url } from "../src/util.ts";
import { api, newOwner, postJson } from "./helpers.ts";

const b64 = (bytes: Uint8Array) => toBase64Url(bytes);
const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));

/** A note as the browser would send it: random id, opaque ciphertext, two hashes. */
async function newNote(overrides: Record<string, unknown> = {}) {
  const creator = await newOwner();
  const reveal = await newOwner();
  const id = b64(random(16));
  const body = {
    id,
    ciphertext: b64(random(200)),
    ttl: 600,
    creatorHash: creator.ownerHash,
    revealHash: reveal.ownerHash,
    ...overrides,
  };
  return { id, body, creatorSecret: creator.ownerSecret, revealToken: reveal.ownerSecret };
}

async function create(overrides: Record<string, unknown> = {}) {
  const note = await newNote(overrides);
  const res = await postJson("/api/notes", note.body);
  return { ...note, res };
}

const reveal = (id: string, revealToken: string) =>
  postJson(`/api/notes/${id}/reveal`, { revealToken });
const status = (id: string, creatorSecret: string) =>
  postJson(`/api/notes/${id}/status`, { creatorSecret });
const remove = (id: string, creatorSecret: string) =>
  api(`/api/notes/${id}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ creatorSecret }),
  });

describe("Poof Note: create", () => {
  it("stores the note and answers with its id and end time", async () => {
    const { id, res } = await create();
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; expiresAt: number };
    expect(body.id).toBe(id);
    expect(body.expiresAt - Date.now()).toBeGreaterThan(590_000);
    expect(body.expiresAt - Date.now()).toBeLessThanOrEqual(600_000);
  });

  it("takes only the three lifetimes", async () => {
    for (const ttl of [600, 3600, 86_400]) expect((await create({ ttl })).res.status).toBe(201);
    for (const ttl of [0, 60, 599, 7200, 172_800, "600"])
      expect((await create({ ttl })).res.status).toBe(400);
  });

  it("refuses ciphertext over 16 KiB and malformed fields", async () => {
    const atLimit = b64(random(NOTE_CIPHERTEXT_MAX_BYTES));
    expect((await create({ ciphertext: atLimit })).res.status).toBe(201);
    const over = b64(random(NOTE_CIPHERTEXT_MAX_BYTES + 3));
    expect((await create({ ciphertext: over })).res.status).toBe(400);
    expect((await create({ ciphertext: "not base64url!" })).res.status).toBe(400);
    expect((await create({ id: "short" })).res.status).toBe(400);
    expect((await create({ creatorHash: "x" })).res.status).toBe(400);
  });

  it("refuses a body over 32 KiB", async () => {
    const note = await newNote();
    const res = await postJson("/api/notes", { ...note.body, pad: "x".repeat(33 * 1024) });
    expect(res.status).toBe(413);
  });

  it("an id is used once", async () => {
    const first = await create();
    const again = await postJson("/api/notes", { ...(await newNote()).body, id: first.id });
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: { code: "note_exists" } });
  });
});

describe("Poof Note: the one reading", () => {
  it("returns the ciphertext once; the second request gets gone", async () => {
    const { id, body, revealToken } = await create();
    const first = await reveal(id, revealToken);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ciphertext: body.ciphertext });
    const second = await reveal(id, revealToken);
    expect(second.status).toBe(410);
    expect(await second.json()).toMatchObject({ error: { code: "note_gone" } });
  });

  it("the ciphertext is erased from storage by the reading itself", async () => {
    const { id, revealToken } = await create();
    await reveal(id, revealToken);
    await runInDurableObject(env.NOTE.getByName(id), async (_instance, state) => {
      const row = await state.storage.get<Record<string, unknown>>("note");
      expect(row).toMatchObject({ state: "read" });
      expect(row).not.toHaveProperty("ciphertext");
      expect(row).not.toHaveProperty("revealHash");
    });
  });

  it("two readings at the same moment: exactly one gets the note", async () => {
    const { id, revealToken } = await create();
    const results = await Promise.all([reveal(id, revealToken), reveal(id, revealToken)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 410]);
  });

  it("a wrong token (wrong password) leaves the note in place", async () => {
    const { id, revealToken } = await create();
    const { ownerSecret: wrong } = await newOwner();
    const res = await reveal(id, wrong);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: "wrong_secret" } });
    expect((await reveal(id, revealToken)).status).toBe(200);
  });

  it(`after ${NOTE_MAX_WRONG_REVEALS} wrong tries the note deletes itself`, async () => {
    const { id, revealToken, creatorSecret } = await create();
    const { ownerSecret: wrong } = await newOwner();
    for (let i = 0; i < NOTE_MAX_WRONG_REVEALS; i++)
      expect((await reveal(id, wrong)).status).toBe(403);
    expect((await reveal(id, revealToken)).status).toBe(410);
    expect(await (await status(id, creatorSecret)).json()).toMatchObject({ state: "deleted" });
  });

  it("an unknown or malformed id is simply gone", async () => {
    const { ownerSecret } = await newOwner();
    expect((await reveal(b64(random(16)), ownerSecret)).status).toBe(410);
    expect((await reveal("nope", ownerSecret)).status).toBe(410);
  });

  it("a GET never reads a note (link previews can't use it up)", async () => {
    const { id, revealToken } = await create();
    expect((await api(`/api/notes/${id}/reveal`)).status).toBe(405);
    expect((await api(`/api/notes/${id}`)).status).toBe(405);
    expect((await reveal(id, revealToken)).status).toBe(200);
  });
});

describe("Poof Note: the creator", () => {
  it("status: waiting, then read", async () => {
    const { id, creatorSecret, revealToken } = await create();
    expect(await (await status(id, creatorSecret)).json()).toMatchObject({ state: "waiting" });
    await reveal(id, revealToken);
    const after = (await (await status(id, creatorSecret)).json()) as { state: string };
    expect(after.state).toBe("read");
    expect(JSON.stringify(after)).not.toContain("ciphertext");
  });

  it("status needs the creator's secret", async () => {
    const { id } = await create();
    const { ownerSecret: someoneElse } = await newOwner();
    const res = await status(id, someoneElse);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: "not_owner" } });
  });

  it("delete with the secret: gone for the reader", async () => {
    const { id, creatorSecret, revealToken } = await create();
    const res = await remove(id, creatorSecret);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ state: "deleted" });
    expect((await reveal(id, revealToken)).status).toBe(410);
    expect(await (await status(id, creatorSecret)).json()).toMatchObject({ state: "deleted" });
  });

  it("delete without the secret does nothing", async () => {
    const { id, revealToken } = await create();
    const { ownerSecret: someoneElse } = await newOwner();
    expect((await remove(id, someoneElse)).status).toBe(403);
    const noBody = await api(`/api/notes/${id}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(noBody.status).toBe(400);
    expect((await reveal(id, revealToken)).status).toBe(200);
  });

  it("deleting after it was read changes nothing", async () => {
    const { id, creatorSecret, revealToken } = await create();
    await reveal(id, revealToken);
    expect(await (await remove(id, creatorSecret)).json()).toMatchObject({ state: "read" });
  });
});

describe("Poof Note: expiry", () => {
  it("at the end of its lifetime the note is wiped: gone for the reader, expired for the creator", async () => {
    const { id, creatorSecret, revealToken } = await create();
    const stub = env.NOTE.getByName(id);
    await runInDurableObject(stub, async (_instance, state) => {
      const row = await state.storage.get<{ expiresAt: number }>("note");
      await state.storage.put("note", { ...row, expiresAt: Date.now() - 1 });
    });
    // Before the alarm runs, an expired note already reads as gone.
    expect((await reveal(id, revealToken)).status).toBe(410);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await runInDurableObject(stub, async (_instance, state) => {
      expect((await state.storage.list()).size).toBe(0);
    });
    expect(await (await status(id, creatorSecret)).json()).toEqual({ state: "expired" });
  });
});

describe("Poof Note: requests", () => {
  it("mutating note requests need the JSON content type and an allowed origin", async () => {
    const note = await newNote();
    const plain = await api("/api/notes", { method: "POST", body: JSON.stringify(note.body) });
    expect(plain.status).toBe(415);
    const foreign = await postJson("/api/notes", note.body, { Origin: "https://evil.example" });
    expect(foreign.status).toBe(403);
    const del = await api(`/api/notes/${note.id}`, {
      method: "DELETE",
      headers: { Origin: "https://evil.example", "Content-Type": "application/json" },
      body: "{}",
    });
    expect(del.status).toBe(403);
  });

  it("the CORS preflight allows DELETE for the web app", async () => {
    const res = await api(`/api/notes/${b64(random(16))}`, {
      method: "OPTIONS",
      headers: {
        Origin: env.ALLOWED_ORIGINS.split(",")[0]!,
        "Access-Control-Request-Method": "DELETE",
      },
    });
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("DELETE");
  });

  it("creating and reading are rate limited per IP", async () => {
    const limiter = (allowed: number) => {
      let used = 0;
      return { limit: vi.fn(async () => ({ success: ++used <= allowed })) };
    };
    const testEnv = { ...env, RL_NOTE_CREATE: limiter(1), RL_NOTE_READ: limiter(1) } as Env;
    const req = (path: string, body: unknown) =>
      new Request(`http://poof.test${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.9" },
        body: JSON.stringify(body),
      });
    const a = await newNote();
    const b = await newNote();
    expect((await worker.fetch(req("/api/notes", a.body), testEnv)).status).toBe(201);
    expect((await worker.fetch(req("/api/notes", b.body), testEnv)).status).toBe(429);
    expect(
      (
        await worker.fetch(
          req(`/api/notes/${a.id}/reveal`, { revealToken: a.revealToken }),
          testEnv,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await worker.fetch(
          req(`/api/notes/${a.id}/reveal`, { revealToken: a.revealToken }),
          testEnv,
        )
      ).status,
    ).toBe(429);
  });
});
