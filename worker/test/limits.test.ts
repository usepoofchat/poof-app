import {
  CloseCode,
  MAX_JSON_BODY_BYTES,
  MAX_SIGNALS_PER_PAIRING,
  MAX_WS_MESSAGE_BYTES,
} from "@poof/protocol";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ANY_OWNER, TestSocket, api, createRoom, newOwner, peer } from "./helpers.ts";

const v = 1;
const ID = "C".repeat(43);

/** A body that arrives in pieces with no Content-Length, like a chunked upload. */
function streamOf(text: string, pieces = 4): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  const size = Math.ceil(bytes.length / pieces);
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) return controller.close();
      controller.enqueue(bytes.slice(offset, offset + size));
      offset += size;
    },
  });
}

function send(path: string, method: string, body: BodyInit, headers: Record<string, string> = {}) {
  return api(path, { method, headers: { "Content-Type": "application/json", ...headers }, body });
}

describe("request bodies", () => {
  const big = JSON.stringify({
    ownerHash: ANY_OWNER.ownerHash,
    pad: "x".repeat(MAX_JSON_BODY_BYTES),
  });

  it("a body over the cap is refused with 413 on both JSON endpoints", async () => {
    for (const [path, method] of [
      ["/api/rooms", "POST"],
      [`/api/handshakes/${ID}`, "PUT"],
    ] as const) {
      const res = await send(path, method, big);
      expect(res.status, path).toBe(413);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
        "payload_too_large",
      );
    }
  });

  it("a streamed body without Content-Length is cut off at the cap too", async () => {
    const res = await send("/api/rooms", "POST", streamOf(big));
    expect(res.status).toBe(413);
  });

  it("a declared Content-Length over the cap is refused before reading", async () => {
    const res = await send("/api/rooms", "POST", streamOf(JSON.stringify(ANY_OWNER)), {
      "Content-Length": String(MAX_JSON_BODY_BYTES + 1),
    });
    expect(res.status).toBe(413);
  });

  it("a body right at the cap is read normally", async () => {
    const base = JSON.stringify({ ...ANY_OWNER, pad: "" });
    const exact = JSON.stringify({
      ...ANY_OWNER,
      pad: "x".repeat(MAX_JSON_BODY_BYTES - base.length),
    });
    expect(exact.length).toBe(MAX_JSON_BODY_BYTES);
    expect((await send("/api/rooms", "POST", streamOf(exact))).status).toBe(200);
  });

  it("the cap is in bytes, not characters", async () => {
    // 2000 × "é" is 2000 characters but 4000 bytes, plus the JSON around it.
    const res = await send(
      "/api/rooms",
      "POST",
      JSON.stringify({ ...ANY_OWNER, pad: "é".repeat(2100) }),
    );
    expect(res.status).toBe(413);
  });
});

async function alone() {
  const room = await createRoom();
  const a = await TestSocket.connect(room.roomId, peer("alice"));
  await a.next("welcome");
  return { room, a };
}

describe("socket budgets", () => {
  it("measures messages in UTF-8 bytes", async () => {
    const { a } = await alone();
    // Under the limit in characters, over it in bytes.
    const sdp = "é".repeat(MAX_WS_MESSAGE_BYTES / 2);
    expect(sdp.length).toBeLessThan(MAX_WS_MESSAGE_BYTES);
    a.send({ v, t: "signal", payload: { kind: "offer", sdp } });
    expect(await a.next("error")).toMatchObject({ code: "protocol_error" });
  });

  it("signals that go nowhere still spend the budget, then the socket is closed", async () => {
    const { a } = await alone();
    for (let i = 0; i < MAX_SIGNALS_PER_PAIRING; i++) {
      a.send({ v, t: "signal", payload: { kind: "offer", sdp: "v=0" } });
    }
    a.send({ v, t: "signal", payload: { kind: "offer", sdp: "v=0" } });
    expect(await a.waitClosed()).toMatchObject({
      code: CloseCode.ProtocolError,
      reason: "signal_rate_exceeded",
    });
    expect(a.messages.filter((m) => m.t === "error" && m.code === "not_paired")).toHaveLength(
      MAX_SIGNALS_PER_PAIRING,
    );
  });

  it("a second wrong destroy secret closes the socket; the room lives on", async () => {
    const { room, a } = await alone();
    const { ownerSecret: wrong } = await newOwner();
    a.send({ v, t: "destroy", ownerSecret: wrong });
    expect(await a.next("error")).toMatchObject({ code: "not_owner" });
    a.send({ v, t: "destroy", ownerSecret: wrong });
    expect(await a.next("error")).toMatchObject({ code: "not_owner" });
    expect(await a.waitClosed()).toMatchObject({ code: CloseCode.ProtocolError });
    expect((await api(`/api/rooms/${room.roomId}`)).status).toBe(200);
  });
});

describe("socket fuzzing", () => {
  /** Valid-looking messages with wrong pieces, plus plain garbage. */
  const junk = fc.oneof(
    fc.string({ maxLength: 200 }),
    fc.jsonValue({ maxDepth: 3 }).map((j) => JSON.stringify(j)),
    fc
      .record({
        v: fc.oneof(fc.constant(1), fc.integer()),
        t: fc.constantFrom(
          "signal",
          "leave",
          "destroy",
          "welcome",
          "paired",
          "__proto__",
          "constructor",
        ),
        to: fc.option(fc.string({ maxLength: 30 }), { nil: undefined }),
        payload: fc.anything({ maxDepth: 2 }),
        ownerSecret: fc.option(fc.string({ maxLength: 50 }), { nil: undefined }),
      })
      .map((m) => JSON.stringify(m)),
  );

  it("garbage never takes the room down or reaches the other peer", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(junk, { minLength: 1, maxLength: 5 }), async (messages) => {
        const room = await createRoom();
        const a = await TestSocket.connect(room.roomId, peer("alice"));
        await a.next("welcome");
        const b = await TestSocket.connect(room.roomId, peer("bob"));
        await b.next("welcome");
        await a.next("paired");
        await b.next("paired");

        for (const m of messages) b.send(m);
        // Whatever happened to b's socket, the room still answers and a got nothing but presence.
        await new Promise((r) => setTimeout(r, 30));
        expect((await api(`/api/rooms/${room.roomId}`)).status).toBe(200);
        for (const msg of a.messages) expect(["peer.left", "signal"]).toContain(msg.t);
        // A relayed signal is always a schema-valid one, stamped with b's id.
        for (const msg of a.messages) if (msg.t === "signal") expect(msg.from).toBe(peer("bob"));

        // And the room keeps working: a third socket either joins or is told it's full.
        const c = await TestSocket.connect(room.roomId, peer("carol"));
        const deadline = Date.now() + 2000;
        while (!c.messages.some((m) => m.t === "welcome" || m.t === "rejected")) {
          expect(Date.now()).toBeLessThan(deadline);
          await new Promise((r) => setTimeout(r, 10));
        }
        for (const s of [a, b, c]) s.close();
      }),
      { numRuns: 40 },
    );
  });
});
