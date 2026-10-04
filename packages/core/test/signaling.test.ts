import { CloseCode, PROTOCOL_VERSION, type ServerMessage } from "@poof/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SignalingClient, type SignalingStatus } from "../src/index.ts";
import { FakeSocket } from "./fakes.ts";

const v = PROTOCOL_VERSION;
const ID = "A".repeat(22);

function setup(
  options: { backoffMs?: readonly number[]; pingIntervalMs?: number; pongTimeoutMs?: number } = {},
) {
  const sockets: FakeSocket[] = [];
  const messages: ServerMessage[] = [];
  const statuses: SignalingStatus[] = [];
  const terminal: Array<{ code: number; reason: string }> = [];
  const client = new SignalingClient({
    url: `ws://x/ws/rooms/${ID}?peerId=${ID}`,
    createSocket: (url) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      return s;
    },
    onMessage: (m) => messages.push(m),
    onStatus: (s) => statuses.push(s),
    onTerminalClose: (code, reason) => terminal.push({ code, reason }),
    ...options,
  });
  return { client, sockets, messages, statuses, terminal };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("SignalingClient: connecting and messages", () => {
  it("opens a socket to the given url and reports status", () => {
    const { client, sockets, statuses } = setup();
    client.connect();
    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.url).toContain(`peerId=${ID}`);
    expect(statuses).toEqual(["connecting"]);
    sockets[0]!.serverOpen();
    expect(statuses).toEqual(["connecting", "open"]);
    expect(client.isOpen).toBe(true);
  });

  it("delivers validated server messages and ignores everything else", () => {
    const { client, sockets, messages } = setup();
    client.connect();
    sockets[0]!.serverOpen();
    const good = { v, t: "room.expired" };
    sockets[0]!.serverSend(JSON.stringify(good));
    sockets[0]!.serverSend(JSON.stringify({ v, t: "nonsense" })); // unknown type
    sockets[0]!.serverSend(JSON.stringify({ v: 2, t: "room.expired" })); // wrong version
    sockets[0]!.serverSend("not json");
    sockets[0]!.serverSend("pong");
    expect(messages).toEqual([good]);
  });

  it("send() serialises a client message, and returns false when the socket isn't open", () => {
    const { client, sockets } = setup();
    expect(client.send({ v, t: "leave" })).toBe(false); // never connected
    client.connect();
    expect(client.send({ v, t: "leave" })).toBe(false); // still connecting
    sockets[0]!.serverOpen();
    expect(client.send({ v, t: "leave" })).toBe(true);
    expect(JSON.parse(sockets[0]!.sent[0]!)).toEqual({ v, t: "leave" });
  });
});

describe("SignalingClient: reconnection", () => {
  it("reconnects with backoff after a non-terminal close, reusing the same url (peerId)", () => {
    const { client, sockets, statuses } = setup({ backoffMs: [100, 200, 400] });
    client.connect();
    sockets[0]!.serverOpen();
    sockets[0]!.serverClose(1006);
    expect(statuses.at(-1)).toBe("reconnecting");
    expect(sockets).toHaveLength(1);

    vi.advanceTimersByTime(99);
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(2);
    expect(sockets[1]!.url).toBe(sockets[0]!.url);
  });

  it("backs off progressively and resets after a successful open", () => {
    const { client, sockets } = setup({ backoffMs: [100, 200, 400] });
    client.connect();
    sockets[0]!.serverClose(1006); // never opened
    vi.advanceTimersByTime(100);
    sockets[1]!.serverClose(1006);
    vi.advanceTimersByTime(199);
    expect(sockets).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(3);
    sockets[2]!.serverClose(1006);
    vi.advanceTimersByTime(400);
    expect(sockets).toHaveLength(4);
    sockets[3]!.serverClose(1006);
    vi.advanceTimersByTime(399);
    expect(sockets).toHaveLength(4); // last backoff value repeats (400)
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(5);

    sockets[4]!.serverOpen(); // success resets the counter
    sockets[4]!.serverClose(1006);
    vi.advanceTimersByTime(100);
    expect(sockets).toHaveLength(6);
  });

  it("treats rate limiting (4005) as retryable", () => {
    const { client, sockets, terminal } = setup({ backoffMs: [50] });
    client.connect();
    sockets[0]!.serverClose(CloseCode.RateLimited);
    vi.advanceTimersByTime(50);
    expect(sockets).toHaveLength(2);
    expect(terminal).toEqual([]);
  });

  it.each([
    CloseCode.ProtocolError,
    CloseCode.RoomExpired,
    CloseCode.RoomDestroyed,
    CloseCode.RoomFull,
    CloseCode.RoomNotFound,
    CloseCode.Replaced,
    CloseCode.ForbiddenOrigin,
  ])("does not reconnect after terminal close code %i", (code) => {
    const { client, sockets, terminal, statuses } = setup({ backoffMs: [10] });
    client.connect();
    sockets[0]!.serverOpen();
    sockets[0]!.serverClose(code, "why");
    vi.advanceTimersByTime(10_000);
    expect(sockets).toHaveLength(1);
    expect(terminal).toEqual([{ code, reason: "why" }]);
    expect(statuses.at(-1)).toBe("closed");
  });

  it("close() stops everything and doesn't report a terminal close", () => {
    const { client, sockets, terminal } = setup({ backoffMs: [10] });
    client.connect();
    sockets[0]!.serverOpen();
    client.close();
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.readyState).toBe(3);
    expect(terminal).toEqual([]);
    expect(client.send({ v, t: "leave" })).toBe(false);
  });

  it("close() cancels a pending reconnect", () => {
    const { client, sockets } = setup({ backoffMs: [1000] });
    client.connect();
    sockets[0]!.serverClose(1006);
    client.close();
    vi.advanceTimersByTime(5000);
    expect(sockets).toHaveLength(1);
  });

  it("ignores events from a socket it already replaced", () => {
    const { client, sockets, messages } = setup({ backoffMs: [10] });
    client.connect();
    sockets[0]!.serverOpen();
    sockets[0]!.serverClose(1006);
    vi.advanceTimersByTime(10);
    sockets[1]!.serverOpen();
    // A late message from the dead socket must not leak in.
    sockets[0]!.onmessage?.({ data: JSON.stringify({ v, t: "room.expired" }) });
    expect(messages).toEqual([]);
  });
});

describe("SignalingClient: heartbeat", () => {
  it("sends the literal string 'ping' every interval", () => {
    const { client, sockets } = setup({ pingIntervalMs: 1000, pongTimeoutMs: 500 });
    client.connect();
    sockets[0]!.serverOpen();
    vi.advanceTimersByTime(1000);
    expect(sockets[0]!.sent).toEqual(["ping"]);
    sockets[0]!.serverSend("pong");
    vi.advanceTimersByTime(1000);
    expect(sockets[0]!.sent).toEqual(["ping", "ping"]);
  });

  it("declares a silent socket dead after the pong timeout and replaces it", () => {
    const { client, sockets } = setup({
      pingIntervalMs: 1000,
      pongTimeoutMs: 500,
      backoffMs: [100],
    });
    client.connect();
    sockets[0]!.serverOpen();
    sockets[0]!.zombie = true; // swallows everything, never closes
    vi.advanceTimersByTime(1000); // ping
    vi.advanceTimersByTime(499);
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(1); // pong timeout
    expect(sockets[0]!.readyState).toBe(3);
    vi.advanceTimersByTime(100); // backoff
    expect(sockets).toHaveLength(2);
  });

  it("any inbound message counts as proof of life, not just pong", () => {
    const { client, sockets } = setup({ pingIntervalMs: 1000, pongTimeoutMs: 500 });
    client.connect();
    sockets[0]!.serverOpen();
    vi.advanceTimersByTime(1000); // ping sent, pong deadline at +500
    vi.advanceTimersByTime(300);
    sockets[0]!.serverSend(JSON.stringify({ v, t: "room.expired" })); // not a pong
    vi.advanceTimersByTime(400); // past the original deadline, before the next ping
    expect(sockets[0]!.readyState).toBe(1);
    expect(sockets).toHaveLength(1);
  });

  it("a failing send() during heartbeat triggers a reconnect", () => {
    const { client, sockets } = setup({ pingIntervalMs: 1000, backoffMs: [50] });
    client.connect();
    sockets[0]!.serverOpen();
    sockets[0]!.readyState = 2; // closing: send() throws in FakeSocket
    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(50);
    expect(sockets).toHaveLength(2);
  });

  it("stops the heartbeat after close()", () => {
    const { client, sockets } = setup({ pingIntervalMs: 1000 });
    client.connect();
    sockets[0]!.serverOpen();
    client.close();
    vi.advanceTimersByTime(10_000);
    expect(sockets[0]!.sent).toEqual([]);
  });
});
