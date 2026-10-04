import { describe, expect, it, vi } from "vitest";
import { mintIceServers, turnCredentialTtl } from "../src/turn.ts";

const FALLBACK = [{ urls: "stun:stun.cloudflare.com:3478" }];

function fakeFetch(body: unknown, status = 200) {
  return vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), { status }));
}

describe("mintIceServers", () => {
  it("falls back to STUN when TURN isn't configured", async () => {
    const f = fakeFetch({});
    expect(await mintIceServers({}, 600, f)).toEqual(FALLBACK);
    expect(f).not.toHaveBeenCalled();
  });

  it("asks for credentials that live as long as the room, and keeps only STUN and TURN over TLS", async () => {
    const f = fakeFetch({
      iceServers: [
        { urls: ["stun:stun.cloudflare.com:3478", "stun:stun.cloudflare.com:53"] },
        {
          urls: [
            "turn:turn.cloudflare.com:3478?transport=udp",
            "turn:turn.cloudflare.com:3478?transport=tcp",
            "turn:turn.cloudflare.com:53?transport=udp",
            "turns:turn.cloudflare.com:5349?transport=tcp",
            "turns:turn.cloudflare.com:443?transport=tcp",
          ],
          username: "u",
          credential: "c",
        },
      ],
    });
    const servers = await mintIceServers({ TURN_KEY_ID: "key id", TURN_API_TOKEN: "tok" }, 600, f);

    expect(servers).toEqual([
      { urls: ["stun:stun.cloudflare.com:3478"] },
      {
        urls: [
          "turns:turn.cloudflare.com:5349?transport=tcp",
          "turns:turn.cloudflare.com:443?transport=tcp",
        ],
        username: "u",
        credential: "c",
      },
    ]);

    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://rtc.live.cloudflare.com/v1/turn/keys/key%20id/credentials/generate-ice-servers",
    );
    expect(JSON.parse(init.body as string)).toEqual({ ttl: 600 });
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
  });

  it("degrades to STUN on API errors, bad payloads and network failures", async () => {
    const env = { TURN_KEY_ID: "k", TURN_API_TOKEN: "t" };
    expect(await mintIceServers(env, 600, fakeFetch({ error: "nope" }, 500))).toEqual(FALLBACK);
    expect(await mintIceServers(env, 600, fakeFetch({ iceServers: "wrong" }))).toEqual(FALLBACK);
    expect(
      await mintIceServers(env, 600, fakeFetch({ iceServers: [{ urls: ["stun:x:53"] }] })),
    ).toEqual(FALLBACK);
    expect(
      await mintIceServers(
        env,
        600,
        fakeFetch({ iceServers: [{ urls: ["turn:x:3478?transport=udp"] }] }),
      ),
    ).toEqual(FALLBACK);
    const boom = vi.fn<typeof fetch>(async () => {
      throw new Error("network down");
    });
    expect(await mintIceServers(env, 600, boom)).toEqual(FALLBACK);
  });
});

describe("turnCredentialTtl", () => {
  const now = 1_000_000;
  it("is the time the room has left, rounded up", () => {
    expect(turnCredentialTtl(now + 600_000, now)).toBe(600);
    expect(turnCredentialTtl(now + 599_001, now)).toBe(600);
  });
  it("never goes below a minute or above a day", () => {
    expect(turnCredentialTtl(now + 5_000, now)).toBe(60);
    expect(turnCredentialTtl(now - 5_000, now)).toBe(60);
    expect(turnCredentialTtl(now + 3 * 86_400_000, now)).toBe(86_400);
  });
});
