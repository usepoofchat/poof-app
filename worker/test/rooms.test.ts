import { env } from "cloudflare:workers";
import { createRoomResponseSchema, roomInfoSchema } from "@poof/protocol";
import { describe, expect, it } from "vitest";
import { ANY_OWNER, api, createRoom, postJson } from "./helpers.ts";

describe("POST /api/rooms", () => {
  it("creates a free 10-minute room", async () => {
    const before = Date.now();
    const res = await postJson("/api/rooms", ANY_OWNER);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = createRoomResponseSchema.parse(await res.json());
    const after = Date.now();

    expect(body.plan).toBe("free");
    expect(body.tier).toBe("free");
    expect(body.maxPeers).toBe(2);
    expect(body.limits).toEqual({ fileTransfer: false, fileMaxBytes: 2 * 1024 * 1024 });
    // 10 minutes from when the server handled it, which was between `before` and `after`.
    expect(body.expiresAt).toBeGreaterThanOrEqual(before + 600_000);
    expect(body.expiresAt).toBeLessThanOrEqual(after + 600_000);
    expect(body.roomId).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it("generates distinct unguessable ids", async () => {
    const ids = new Set<string>();
    for (let i = 0; i < 5; i++) ids.add((await createRoom()).roomId);
    expect(ids.size).toBe(5);
  });

  it("does not hand out ICE/TURN credentials", async () => {
    const body = (await (await postJson("/api/rooms", ANY_OWNER)).json()) as Record<
      string,
      unknown
    >;
    expect(body).not.toHaveProperty("iceServers");
    expect(body).not.toHaveProperty("turn_servers");
  });

  it("requires application/json", async () => {
    const res = await api("/api/rooms", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "x",
    });
    expect(res.status).toBe(415);
    expect(await res.json()).toEqual({
      error: { code: "unsupported_media_type", message: expect.any(String) },
    });
  });

  it("rejects cross-origin browser requests", async () => {
    const res = await postJson("/api/rooms", ANY_OWNER, { Origin: "https://evil.example" });
    expect(res.status).toBe(403);
  });

  it("allows same-origin and requests without Origin", async () => {
    expect((await postJson("/api/rooms", ANY_OWNER, { Origin: "http://poof.test" })).status).toBe(
      200,
    );
    expect((await postJson("/api/rooms", ANY_OWNER)).status).toBe(200);
  });

  it("rejects wrong methods", async () => {
    expect((await api("/api/rooms")).status).toBe(405);
    expect((await api("/api/rooms", { method: "DELETE" })).status).toBe(405);
  });
});

describe("POST /api/rooms body", () => {
  it("requires a well-formed owner hash", async () => {
    for (const body of [{}, { ownerHash: "short" }, { ownerHash: 42 }, "nope"]) {
      const res = await postJson("/api/rooms", body);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: { code: "invalid_request" } });
    }
  });

  it("never echoes the owner hash back", async () => {
    const res = await postJson("/api/rooms", ANY_OWNER);
    expect(await res.text()).not.toContain(ANY_OWNER.ownerHash);
  });
});

describe("GET /api/rooms/:id", () => {
  it("returns public room info", async () => {
    const room = await createRoom();
    const res = await api(`/api/rooms/${room.roomId}`);
    expect(res.status).toBe(200);
    const info = roomInfoSchema.parse(await res.json());
    expect(info.roomId).toBe(room.roomId);
    expect(info.peers).toBe(0);
    expect(info.expiresAt).toBe(room.expiresAt);
    expect(Math.abs(info.serverNow - Date.now())).toBeLessThan(5000);
  });

  it("404s for unknown or malformed ids", async () => {
    expect((await api("/api/rooms/AAAAAAAAAAAAAAAAAAAAAA")).status).toBe(404);
    expect((await api("/api/rooms/not-a-room-id")).status).toBe(404);
    const body = (await (await api("/api/rooms/AAAAAAAAAAAAAAAAAAAAAA")).json()) as {
      error: { code: string };
    };
    expect(body.error.code).toBe("room_not_found");
  });
});

describe("misc routes", () => {
  it("health", async () => {
    const res = await api("/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, version: "1", commit: env.COMMIT_SHA });
  });

  it("unknown api path is a JSON 404", async () => {
    const res = await api("/api/nope");
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("not_found");
  });

  it("sets no cookies", async () => {
    const res = await postJson("/api/rooms", ANY_OWNER);
    expect(res.headers.get("set-cookie")).toBeNull();
  });
});
