import { inject, describe, expect, it } from "vitest";
import {
  RoomSession,
  createRoom,
  joinByPhrase,
  parseRoomLocation,
  type SessionStatus,
  type SocketFactory,
  type WebSocketLike,
} from "@poof/core";
import { FakeRtcNetwork, waitFor } from "../../packages/core/test/fakes.ts";

const origin = inject("baseUrl");

let ipCounter = 0;

/**
 * Every test acts as a different client. The worker rate-limits per `CF-Connecting-IP` (set by
 * Cloudflare's edge in production, passed through by wrangler dev), so distinct values keep the
 * tests from throttling each other while still exercising the real limiter.
 */
function client(ip = `10.20.${Math.floor(++ipCounter / 250)}.${(ipCounter % 250) + 1}`) {
  const headers = { "CF-Connecting-IP": ip };
  const clientFetch: typeof fetch = (input, init) =>
    fetch(input, {
      ...init,
      headers: { ...(init?.headers as Record<string, string> | undefined), ...headers },
    });
  // Node's global WebSocket accepts a headers option; the DOM typings don't know about it.
  const clientSocket: SocketFactory = (url) =>
    new WebSocket(url, { headers } as unknown as string[]) as unknown as WebSocketLike;
  return { ip, fetch: clientFetch, createSocket: clientSocket };
}

type Client = ReturnType<typeof client>;

async function newRoom(c: Client = client()) {
  const created = await createRoom({ fetch: c.fetch, origin });
  // Exactly what the browser does on /join/#<id>.<key>: parse the location back.
  const [pathname, hash] = created.path.split("#") as [string, string];
  return { created, ...parseRoomLocation(pathname, hash) };
}

function session(
  room: { roomId: string; key: Uint8Array },
  net: FakeRtcNetwork,
  c: Client,
  extra = {},
) {
  return new RoomSession({
    roomId: room.roomId,
    roomKey: room.key,
    origin,
    fetch: c.fetch,
    createSocket: c.createSocket,
    createPeerConnection: net.factory,
    ...extra,
  });
}

const status = (s: RoomSession): SessionStatus => s.getState().status;
const until = (s: RoomSession, st: SessionStatus) =>
  waitFor(
    () => status(s) === st,
    `status ${st} (is ${status(s)}: ${JSON.stringify(s.getState().error)})`,
    10_000,
  );

describe("client engine against the real worker", () => {
  it("creates a room, pairs two sessions through real Durable Objects, upgrades and chats", async () => {
    const c = client();
    const room = await newRoom(c);
    expect(room.created.info).toMatchObject({ plan: "free", tier: "free", maxPeers: 2 });
    const net = new FakeRtcNetwork();
    const alice = session(room, net, c, { ownerSecret: room.created.ownerSecret });
    const bob = session(room, net, c);

    await alice.start();
    await until(alice, "waiting");
    expect(alice.getState().expiresAt! - Date.now()).toBeGreaterThan(590_000);

    await bob.start();
    await until(alice, "sealed");
    await until(bob, "sealed");
    expect(alice.getState().role).toBe("initiator");
    expect(bob.getState().role).toBe("responder");

    // The real server handed out ICE servers on pairing; the engine used them.
    expect(net.iceServersSeen.length).toBe(2);
    expect(JSON.stringify(net.iceServersSeen[0])).toContain("stun:");

    await alice.sendMessage("hello from the e2e test");
    await waitFor(() => bob.getState().messages.length === 1, "message", 10_000);
    expect(bob.getState().messages[0]).toMatchObject({
      kind: "text",
      text: "hello from the e2e test",
      mine: false,
    });

    await bob.sendMessage("reply");
    await waitFor(() => alice.getState().messages.length === 2, "reply", 10_000);

    await alice.destroy();
    await until(bob, "terminated");
    expect(bob.getState().endReason).toBe("destroyed_by_peer");
    expect(bob.getState().messages).toEqual([]);
  });

  it("the real server refuses destroy from the joiner and keeps the room", async () => {
    const c = client();
    const room = await newRoom(c);
    const net = new FakeRtcNetwork();
    const alice = session(room, net, c, { ownerSecret: room.created.ownerSecret });
    // Bob forges a secret: the engine lets him try, the server must refuse.
    const bob = session(room, net, c, { ownerSecret: "f".repeat(43) });
    await alice.start();
    await until(alice, "waiting");
    await bob.start();
    await until(alice, "sealed");
    await until(bob, "sealed");

    await bob.destroy();
    await new Promise((r) => setTimeout(r, 500));
    // Bob left locally; for Alice the room is not destroyed (at most her peer left).
    expect(alice.getState().endReason).not.toBe("destroyed_by_peer");
    const info = await c.fetch(`${origin}/api/rooms/${room.roomId}`);
    expect(info.status).toBe(200);
  });

  it("phrase invite through the real mailbox: the code leads to the room once, then 404s", async () => {
    const c = client();
    const room = await newRoom(c);
    const net = new FakeRtcNetwork();
    const alice = session(room, net, c, { ownerSecret: room.created.ownerSecret });
    await alice.start();
    await until(alice, "waiting");

    const phrase = await alice.createPhrase();
    expect(alice.getState().phrase).toEqual(phrase);
    expect(phrase.expiresAt).toBeLessThanOrEqual(alice.getState().expiresAt!);

    const joiner = client();
    const path = await joinByPhrase({ fetch: joiner.fetch, origin, code: phrase.code });
    expect(`${origin}${path}`).toBe(alice.getState().inviteUrl);
    await expect(
      joinByPhrase({ fetch: joiner.fetch, origin, code: phrase.code }),
    ).rejects.toMatchObject({
      code: "not_found_or_expired",
    });

    // The path really opens the room.
    const [pathname, hash] = path.split("#") as [string, string];
    const bob = session(parseRoomLocation(pathname, hash), net, joiner);
    await bob.start();
    await until(alice, "sealed");
    await until(bob, "sealed");
  });

  it("the room is gone after it is destroyed (404 for newcomers)", async () => {
    const c = client();
    const room = await newRoom(c);
    const net = new FakeRtcNetwork();
    const alice = session(room, net, c, { ownerSecret: room.created.ownerSecret });
    await alice.start();
    await until(alice, "waiting");
    await alice.destroy();

    const late = session(room, net, c);
    await late.start();
    expect(late.getState()).toMatchObject({ status: "error", error: { code: "room_not_found" } });
  });

  it("rejects a third person with room_full (real capacity lock)", async () => {
    const c = client();
    const room = await newRoom(c);
    const net = new FakeRtcNetwork();
    const alice = session(room, net, c);
    const bob = session(room, net, c);
    await alice.start();
    await until(alice, "waiting");
    await bob.start();
    await until(bob, "sealed");

    const carol = session(room, net, c);
    await carol.start();
    await until(carol, "error");
    expect(carol.getState().error?.code).toBe("room_full");
  });

  it("a graceful leave ends the other side", async () => {
    const c = client();
    const room = await newRoom(c);
    const net = new FakeRtcNetwork();
    const alice = session(room, net, c);
    const bob = session(room, net, c);
    await alice.start();
    await until(alice, "waiting");
    await bob.start();
    await until(alice, "sealed");
    await until(bob, "sealed");

    await bob.leave();
    await until(alice, "terminated");
    expect(alice.getState().endReason).toBe("peer_left");
  });

  it("a session that reconnects its signaling socket with the same peerId is replaced, not paired with itself", async () => {
    const c = client();
    const room = await newRoom(c);
    const net = new FakeRtcNetwork();
    const first = session(room, net, c, { peerId: "s".repeat(22) });
    await first.start();
    await until(first, "waiting");

    const second = session(room, net, c, { peerId: "s".repeat(22) });
    await second.start();
    await until(first, "terminated");
    expect(first.getState().endReason).toBe("replaced");
    await until(second, "waiting");
    expect(second.getState().peerPresent).toBe(false);
  });

  it("the room key is never sent to the server", async () => {
    // Capture every URL and socket payload the engine uses against the real server.
    const c = client();
    const seen: string[] = [];
    const spyFetch: typeof fetch = (input, init) => {
      seen.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (typeof init?.body === "string") seen.push(init.body);
      return c.fetch(input, init);
    };
    const spySocket: SocketFactory = (url) => {
      seen.push(url);
      const ws = c.createSocket(url);
      const send = ws.send.bind(ws);
      ws.send = (data: string) => {
        seen.push(data);
        send(data);
      };
      return ws;
    };

    const created = await createRoom({ fetch: spyFetch, origin });
    const keyText = created.path.split("#")[1]!;
    const net = new FakeRtcNetwork();
    const make = () =>
      new RoomSession({
        roomId: created.roomId,
        roomKey: created.key,
        origin,
        fetch: spyFetch,
        createSocket: spySocket,
        createPeerConnection: net.factory,
      });
    const a = make();
    const b = make();
    await a.start();
    await until(a, "waiting");
    await b.start();
    await until(a, "sealed");
    await until(b, "sealed");
    await a.sendMessage("x");

    expect(seen.length).toBeGreaterThan(5);
    expect(seen.join("\n")).not.toContain(keyText);
  });
});

describe("real server behaviours the engine relies on", () => {
  it("answers the literal 'ping' with 'pong'", async () => {
    const c = client();
    const room = await newRoom(c);
    const ws = c.createSocket(
      `${origin.replace("http", "ws")}/ws/rooms/${room.roomId}?peerId=${"p".repeat(22)}`,
    );
    const got: string[] = [];
    ws.onmessage = (e) => got.push(String(e.data));
    await new Promise<void>((resolve) => (ws.onopen = () => resolve()));
    ws.send("ping");
    await waitFor(() => got.includes("pong"), "pong");
    ws.close();
  });

  it("rejects cross-site browser origins on the WebSocket with a readable close code", async () => {
    const c = client();
    const room = await newRoom(c);
    const ws = new WebSocket(
      `${origin.replace("http", "ws")}/ws/rooms/${room.roomId}?peerId=${"q".repeat(22)}`,
      {
        headers: { Origin: "https://evil.example", "CF-Connecting-IP": c.ip },
      } as unknown as string[],
    );
    const closed = await new Promise<{ code: number }>(
      (resolve) => (ws.onclose = (e) => resolve({ code: e.code })),
    );
    expect(closed.code).toBe(4007);
  });

  it("rejects cross-site browser origins on POST /api/rooms", async () => {
    const c = client();
    const res = await c.fetch(`${origin}/api/rooms`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
      body: "{}",
    });
    expect(res.status).toBe(403);
  });

  it("sets security headers and no cookies on API responses", async () => {
    const c = client();
    const res = await c.fetch(`${origin}/api/rooms`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("the real rate limiter throttles room creation per client IP (5/min) and not other clients", async () => {
    const noisy = client();
    const create = (c: Client) =>
      c.fetch(`${origin}/api/rooms`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ownerHash: "h".repeat(43) }),
      });
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) statuses.push((await create(noisy)).status);
    expect(statuses.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(statuses.slice(5)).toEqual([429, 429]);

    const limited = await create(noisy);
    expect(await limited.json()).toEqual({
      error: { code: "rate_limited", message: expect.any(String) },
    });
    expect((await create(client())).status).toBe(200); // someone else is unaffected
  });

  it("the phrase mailbox round-trips once and then forgets", async () => {
    const c = client();
    const id = "m".repeat(43);
    const put = await c.fetch(`${origin}/api/handshakes/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ blob: "YmxvYg==" }),
    });
    expect(put.status).toBe(201);
    const take = () =>
      c.fetch(`${origin}/api/handshakes/${id}/take`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
    expect(await (await take()).json()).toEqual({ blob: "YmxvYg==" });
    expect((await take()).status).toBe(404);
  });
});
