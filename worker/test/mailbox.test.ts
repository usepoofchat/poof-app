import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { api, postJson } from "./helpers.ts";

const ID = "A".repeat(43);
const ID2 = "B".repeat(43);
const BLOB = "dGVzdC1ibG9i";

function put(id: string, body: unknown = { blob: BLOB }, headers: HeadersInit = {}) {
  return api(`/api/handshakes/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("handshake mailbox", () => {
  it("stores a blob and returns it exactly once", async () => {
    const res = await put(ID);
    expect(res.status).toBe(201);
    const { expiresAt } = (await res.json()) as { expiresAt: number };
    expect(expiresAt - Date.now()).toBeGreaterThan(170_000);
    expect(expiresAt - Date.now()).toBeLessThanOrEqual(180_000);

    const first = await postJson(`/api/handshakes/${ID}/take`);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ blob: BLOB });

    const second = await postJson(`/api/handshakes/${ID}/take`);
    expect(second.status).toBe(404);
  });

  it("two simultaneous takes yield exactly one blob", async () => {
    await put(ID);
    const results = await Promise.all([
      postJson(`/api/handshakes/${ID}/take`),
      postJson(`/api/handshakes/${ID}/take`),
      postJson(`/api/handshakes/${ID}/take`),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 404, 404]);
  });

  it("refuses to overwrite an unexpired blob", async () => {
    expect((await put(ID)).status).toBe(201);
    const dup = await put(ID, { blob: "b3RoZXI=" });
    expect(dup.status).toBe(409);
    // The original is intact.
    expect(await (await postJson(`/api/handshakes/${ID}/take`)).json()).toEqual({ blob: BLOB });
  });

  it("allows reuse of an id after it was taken", async () => {
    await put(ID);
    await postJson(`/api/handshakes/${ID}/take`);
    expect((await put(ID)).status).toBe(201);
  });

  it("isolates ids", async () => {
    await put(ID);
    expect((await postJson(`/api/handshakes/${ID2}/take`)).status).toBe(404);
  });

  it("validates id, blob size and shape", async () => {
    expect((await put("short")).status).toBe(422);
    expect((await postJson("/api/handshakes/short/take")).status).toBe(422);
    expect((await put(ID, {})).status).toBe(422);
    expect((await put(ID, { blob: "!!not base64!!" })).status).toBe(422);
    expect((await put(ID, { blob: "A".repeat(2049) })).status).toBe(422);
    const notJson = await api(`/api/handshakes/${ID}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "{{{",
    });
    expect(notJson.status).toBe(400);
  });

  it("requires JSON and same origin", async () => {
    const wrongType = await api(`/api/handshakes/${ID}`, {
      method: "PUT",
      headers: { "Content-Type": "text/plain" },
      body: "x",
    });
    expect(wrongType.status).toBe(415);
    expect((await put(ID, { blob: BLOB }, { Origin: "https://evil.example" })).status).toBe(403);
  });

  it("an expired blob can't be taken, and the alarm wipes it", async () => {
    await put(ID);
    const stub = env.MAILBOX.getByName(ID);
    await runInDurableObject(stub, async (_i, state) => {
      await state.storage.put("box", { blob: BLOB, expiresAt: Date.now() - 1 });
    });
    expect((await postJson(`/api/handshakes/${ID}/take`)).status).toBe(404);

    await put(ID2);
    const stub2 = env.MAILBOX.getByName(ID2);
    expect(await runDurableObjectAlarm(stub2)).toBe(true);
    await runInDurableObject(stub2, async (_i, state) => {
      expect(await state.storage.get("box")).toBeUndefined();
    });
  });

  it("uses the right verbs", async () => {
    expect((await api(`/api/handshakes/${ID}`)).status).toBe(405);
    expect((await api(`/api/handshakes/${ID}/take`)).status).toBe(405);
  });
});
