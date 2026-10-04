import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import worker from "../src/index.ts";
import { ANY_OWNER } from "./helpers.ts";

const CREATE_BODY = JSON.stringify(ANY_OWNER);

/** A limiter that allows `allowed` calls and then refuses, recording the keys it was asked about. */
function limiter(allowed: number): RateLimit & { keys: string[] } {
  const keys: string[] = [];
  let used = 0;
  return {
    keys,
    limit: vi.fn(async ({ key }: { key: string }) => {
      keys.push(key);
      used += 1;
      return { success: used <= allowed };
    }),
  };
}

function req(path: string, init: RequestInit = {}, ip = "203.0.113.7"): Request {
  return new Request(`http://poof.test${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip, ...init.headers },
  });
}

describe("rate limiting", () => {
  it("POST /api/rooms returns 429 JSON once the limiter refuses, keyed by client IP", async () => {
    const RL_CREATE_ROOM = limiter(2);
    const testEnv = { ...env, RL_CREATE_ROOM } as Env;

    expect(
      (await worker.fetch(req("/api/rooms", { method: "POST", body: CREATE_BODY }), testEnv))
        .status,
    ).toBe(200);
    expect(
      (await worker.fetch(req("/api/rooms", { method: "POST", body: CREATE_BODY }), testEnv))
        .status,
    ).toBe(200);
    const limited = await worker.fetch(
      req("/api/rooms", { method: "POST", body: CREATE_BODY }),
      testEnv,
    );
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({
      error: { code: "rate_limited", message: expect.any(String) },
    });
    expect(RL_CREATE_ROOM.keys).toEqual(["203.0.113.7", "203.0.113.7", "203.0.113.7"]);
  });

  it("room reads and handshake endpoints are limited too", async () => {
    const testEnv = { ...env, RL_ROOM_READ: limiter(0), RL_HANDSHAKE: limiter(0) } as Env;
    const id43 = "A".repeat(43);
    expect((await worker.fetch(req("/api/rooms/AAAAAAAAAAAAAAAAAAAAAA"), testEnv)).status).toBe(
      429,
    );
    expect(
      (
        await worker.fetch(
          req(`/api/handshakes/${id43}`, { method: "PUT", body: '{"blob":"YQ=="}' }),
          testEnv,
        )
      ).status,
    ).toBe(429);
    expect(
      (
        await worker.fetch(
          req(`/api/handshakes/${id43}/take`, { method: "POST", body: "{}" }),
          testEnv,
        )
      ).status,
    ).toBe(429);
  });

  it("a limited WebSocket join is closed with code 4005 so the client can read why", async () => {
    const testEnv = { ...env, RL_WS_JOIN: limiter(0) } as Env;
    const res = await worker.fetch(
      req("/ws/rooms/AAAAAAAAAAAAAAAAAAAAAA?peerId=alice_________________", {
        headers: { Upgrade: "websocket" },
      }),
      testEnv,
    );
    const ws = res.webSocket;
    expect(ws).toBeTruthy();
    ws!.accept();
    const closed = await new Promise<CloseEvent>((resolve) =>
      ws!.addEventListener("close", resolve),
    );
    expect(closed.code).toBe(4005);
  });

  it("limits are not applied to health checks", async () => {
    const testEnv = { ...env, RL_CREATE_ROOM: limiter(0) } as Env;
    expect((await worker.fetch(req("/api/health"), testEnv)).status).toBe(200);
  });
});
