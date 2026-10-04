import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { AI_BUDGET, AI_MAX_TOKENS, AI_MODEL, AI_PER_MINUTE } from "@poof/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setAiUpstreamForTests } from "../src/ai.ts";
import type { RoomDO, RoomMeta } from "../src/room-do.ts";
import { randomId, toBase64Url } from "../src/util.ts";
import { newOwner, postJson } from "./helpers.ts";

// ── A fake AI provider ─────────────────────────────────────────────────────────

interface Call {
  url: string;
  headers: Headers;
  body: Record<string, unknown> | null;
}

let calls: Call[] = [];
let answer: () => Response;

const SSE =
  'data: {"choices":[{"delta":{"content":"' + "ab".repeat(100) + '"}}]}\n\ndata: [DONE]\n\n';

beforeEach(() => {
  calls = [];
  answer = () => new Response(SSE, { headers: { "Content-Type": "text/event-stream" } });
  setAiUpstreamForTests(async (url, init) => {
    calls.push({
      url,
      headers: new Headers(init.headers),
      body:
        typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null,
    });
    return answer();
  });
});
afterEach(() => setAiUpstreamForTests(null));

// ── Helpers ────────────────────────────────────────────────────────────────────

/** An AI room as the API makes it from a pass, plus the creator's secret and the members' token. */
async function aiRoom(opts: { register?: boolean; lifetime?: number } = {}) {
  const owner = await newOwner();
  const roomId = randomId();
  const lifetime = opts.lifetime ?? 3600;
  await env.ROOM.getByName(roomId).create({
    roomId,
    ttlSeconds: lifetime,
    plan: "super",
    tier: lifetime === 86400 ? "24h" : "60m",
    maxPeers: 4,
    ownerHash: owner.ownerHash,
    ai: true,
  });
  const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
  const aiToken = toBase64Url(tokenBytes);
  const aiHash = toBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", tokenBytes)));
  if (opts.register !== false) {
    const res = await postJson(`/api/rooms/${roomId}/ai`, {
      ownerSecret: owner.ownerSecret,
      aiHash,
    });
    expect(res.status).toBe(200);
  }
  return { roomId, aiToken, aiHash, owner };
}

const hex = (bytes: number) =>
  Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");

const pubKey = () => "04" + hex(64);
const sealed = () => "04" + hex(64 + 12 + 40);

function chatBody(roomId: string, aiToken: string, extra: Record<string, unknown> = {}) {
  return {
    roomId,
    aiToken,
    clientPubKey: pubKey(),
    modelPubKey: pubKey(),
    messages: [
      { role: "system", content: sealed() },
      { role: "user", content: sealed() },
    ],
    ...extra,
  };
}

const code = async (res: Response) =>
  ((await res.json()) as { error?: { code: string } }).error?.code;

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("POST /api/rooms/:id/ai", () => {
  it("only the creator registers the token hash; the same hash again is fine, another isn't", async () => {
    const { roomId, aiHash, owner } = await aiRoom({ register: false });
    const stranger = await newOwner();
    const bad = await postJson(`/api/rooms/${roomId}/ai`, {
      ownerSecret: stranger.ownerSecret,
      aiHash,
    });
    expect(bad.status).toBe(403);
    expect(await code(bad)).toBe("not_owner");

    const body = { ownerSecret: owner.ownerSecret, aiHash };
    expect((await postJson(`/api/rooms/${roomId}/ai`, body)).status).toBe(200);
    expect((await postJson(`/api/rooms/${roomId}/ai`, body)).status).toBe(200);
    const other = await postJson(`/api/rooms/${roomId}/ai`, {
      ...body,
      aiHash: toBase64Url(crypto.getRandomValues(new Uint8Array(32))),
    });
    expect(await code(other)).toBe("ai_forbidden");
  });

  it("refuses a room without the AI", async () => {
    const owner = await newOwner();
    const created = (await (
      await postJson("/api/rooms", { ownerHash: owner.ownerHash })
    ).json()) as {
      roomId: string;
      ai: boolean;
    };
    expect(created.ai).toBe(false);
    const res = await postJson(`/api/rooms/${created.roomId}/ai`, {
      ownerSecret: owner.ownerSecret,
      aiHash: "h".repeat(43),
    });
    expect(await code(res)).toBe("ai_not_enabled");
  });
});

describe("POST /api/ai/attestation", () => {
  it("forwards the nonce and model, and returns the provider's attestation", async () => {
    const { roomId, aiToken } = await aiRoom();
    answer = () => Response.json({ verified: true, nonce: "x", model: AI_MODEL });
    const nonce = hex(32);
    const res = await postJson("/api/ai/attestation", { roomId, aiToken, nonce });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ verified: true, model: AI_MODEL });
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe("/api/v1/tee/attestation");
    expect(url.searchParams.get("model")).toBe(AI_MODEL);
    expect(url.searchParams.get("nonce")).toBe(nonce);
    expect(calls[0]!.headers.get("Authorization")).toBe("Bearer test-provider-key");
  });

  it("needs the room's token, and costs no budget", async () => {
    const { roomId, aiToken } = await aiRoom();
    const wrong = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
    const res = await postJson("/api/ai/attestation", { roomId, aiToken: wrong, nonce: hex(32) });
    expect(await code(res)).toBe("ai_forbidden");
    expect(calls).toHaveLength(0);
    for (let i = 0; i < AI_PER_MINUTE + 2; i++) {
      answer = () => Response.json({ verified: true });
      await postJson("/api/ai/attestation", { roomId, aiToken, nonce: hex(32) });
    }
    expect((await postJson("/api/ai/chat", chatBody(roomId, aiToken))).status).toBe(200);
  });

  it("a provider failure is ai_unavailable", async () => {
    const { roomId, aiToken } = await aiRoom();
    answer = () => new Response("down", { status: 502 });
    const res = await postJson("/api/ai/attestation", { roomId, aiToken, nonce: hex(32) });
    expect(res.status).toBe(503);
    expect(await code(res)).toBe("ai_unavailable");
  });
});

describe("POST /api/ai/chat", () => {
  it("forces the model and its parameters, sends the E2EE headers and streams the answer untouched", async () => {
    const { roomId, aiToken } = await aiRoom();
    const body = chatBody(roomId, aiToken, { model: "something-else", max_tokens: 99999 });
    const res = await postJson("/api/ai/chat", body);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
    expect(await res.text()).toBe(SSE);

    const call = calls[0]!;
    expect(new URL(call.url).pathname).toBe("/api/v1/chat/completions");
    expect(call.headers.get("X-Venice-TEE-Client-Pub-Key")).toBe(body.clientPubKey);
    expect(call.headers.get("X-Venice-TEE-Model-Pub-Key")).toBe(body.modelPubKey);
    expect(call.headers.get("X-Venice-TEE-Signing-Algo")).toBe("ecdsa");
    expect(call.body).toEqual({
      model: AI_MODEL,
      messages: body.messages,
      stream: true,
      max_tokens: AI_MAX_TOKENS,
      venice_parameters: {
        enable_e2ee: true,
        include_venice_system_prompt: false,
        enable_web_search: "off",
      },
    });
  });

  it("never forwards readable text: plaintext, assistant turns or extra fields are refused", async () => {
    const { roomId, aiToken } = await aiRoom();
    for (const messages of [
      [{ role: "user", content: "hello there, this is plain text" }],
      [{ role: "assistant", content: sealed() }],
      [{ role: "user", content: "abc" }],
      [{ role: "user", content: sealed(), name: "x" }],
      [],
    ]) {
      const res = await postJson("/api/ai/chat", chatBody(roomId, aiToken, { messages }));
      expect(res.status).toBe(400);
    }
    expect(calls).toHaveLength(0);
  });

  it("wrong token, no AI, not registered yet", async () => {
    const { roomId } = await aiRoom();
    const wrong = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
    expect(await code(await postJson("/api/ai/chat", chatBody(roomId, wrong)))).toBe(
      "ai_forbidden",
    );

    const pending = await aiRoom({ register: false });
    expect(
      await code(await postJson("/api/ai/chat", chatBody(pending.roomId, pending.aiToken))),
    ).toBe("ai_not_ready");
    expect(await code(await postJson("/api/ai/chat", chatBody(randomId(), pending.aiToken)))).toBe(
      "room_not_found",
    );
    expect(calls).toHaveLength(0);
  });

  it("at most AI_PER_MINUTE requests a minute per room", async () => {
    const { roomId, aiToken } = await aiRoom();
    for (let i = 0; i < AI_PER_MINUTE; i++) {
      expect((await postJson("/api/ai/chat", chatBody(roomId, aiToken))).status).toBe(200);
    }
    const over = await postJson("/api/ai/chat", chatBody(roomId, aiToken));
    expect(over.status).toBe(429);
    expect(await code(over)).toBe("rate_limited");
  });

  it("stops at the room's budget; requests the provider didn't answer are given back", async () => {
    const { roomId, aiToken } = await aiRoom();
    // All but one request used already.
    await setAiUsed(roomId, AI_BUDGET[3600]! - 1);
    answer = () => new Response("no credit", { status: 402 });
    const failed = await postJson("/api/ai/chat", chatBody(roomId, aiToken));
    expect(await code(failed)).toBe("ai_unavailable");

    answer = () => new Response(SSE);
    expect((await postJson("/api/ai/chat", chatBody(roomId, aiToken))).status).toBe(200);
    const done = await postJson("/api/ai/chat", chatBody(roomId, aiToken));
    expect(done.status).toBe(429);
    expect(await code(done)).toBe("ai_budget_exhausted");
  });

  it("refuses bodies over the cap", async () => {
    const { roomId, aiToken } = await aiRoom();
    const huge = chatBody(roomId, aiToken, {
      messages: [{ role: "user", content: "a".repeat(600 * 1024) }],
    });
    expect((await postJson("/api/ai/chat", huge)).status).toBe(413);
  });
});

/** Set how many AI requests a room has used, straight in its storage. */
async function setAiUsed(roomId: string, used: number): Promise<void> {
  const stub = env.ROOM.getByName(roomId) as DurableObjectStub<RoomDO>;
  await runInDurableObject(stub, async (instance, state) => {
    const meta = (await state.storage.get<RoomMeta>("meta"))!;
    const next = { ...meta, aiUsed: used };
    await state.storage.put("meta", next);
    (instance as unknown as { meta: RoomMeta }).meta = next;
  });
}
