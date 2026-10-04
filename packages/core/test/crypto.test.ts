import { Channel, FRAME, FrameType, type PqMessage } from "@poof/protocol";
import { describe, expect, it } from "vitest";
import {
  FrameCodec,
  InitiatorHandshake,
  PoofError,
  ResponderHandshake,
  concat,
  decodeRoomKey,
  encodeRoomKey,
  fromBase64Url,
  generateRoomKey,
  normalizeChatText,
  sanitizeFileName,
  sanitizeMime,
  toBase64Url,
  utf8,
  type SessionKeys,
} from "../src/index.ts";

const ROOM = "AAAAAAAAAAAAAAAAAAAAAA";
const PAIR = { initiator: "i".repeat(22), responder: "r".repeat(22) };

type Msg<T extends PqMessage["t"]> = Extract<PqMessage, { t: T }>;

/** Run a full honest handshake and return both sides' keys. */
async function handshake(
  roomKey = generateRoomKey(),
  responderKey = roomKey,
  roomId = ROOM,
  responderRoom = roomId,
  responderPair = PAIR,
) {
  const i = new InitiatorHandshake(roomId, roomKey, PAIR);
  const r = new ResponderHandshake(responderRoom, responderKey, responderPair);
  const hello = i.start() as Msg<"pq.hello">;
  const reply = (await r.handleHello(hello)) as Msg<"pq.reply">;
  const { confirm, keys: ki } = await i.handleReply(reply);
  const kr = await r.handleConfirm(confirm as Msg<"pq.confirm">);
  return { ki, kr, hello, reply, confirm };
}

function codecs(ki: SessionKeys, kr: SessionKeys) {
  return { initiator: new FrameCodec(ki), responder: new FrameCodec(kr) };
}

describe("encoding & room key", () => {
  it("round-trips base64url without padding", () => {
    for (const len of [0, 1, 2, 3, 31, 32, 33]) {
      const data = crypto.getRandomValues(new Uint8Array(len));
      const enc = toBase64Url(data);
      expect(enc).not.toMatch(/[+/=]/);
      expect(Array.from(fromBase64Url(enc))).toEqual(Array.from(data));
    }
  });

  it("room keys are 32 random bytes encoded as 43 chars", () => {
    const a = generateRoomKey();
    const b = generateRoomKey();
    expect(a).toHaveLength(32);
    expect(encodeRoomKey(a)).toHaveLength(43);
    expect(encodeRoomKey(a)).not.toBe(encodeRoomKey(b));
    expect(Array.from(decodeRoomKey(encodeRoomKey(a)))).toEqual(Array.from(a));
  });

  it("rejects malformed keys with invalid_link", () => {
    for (const bad of ["", "short", "x".repeat(44), "+".repeat(43), "a".repeat(42) + "="]) {
      expect(() => decodeRoomKey(bad)).toThrowError(
        expect.objectContaining({ code: "invalid_link" }),
      );
    }
  });
});

describe("hybrid key exchange", () => {
  it("both sides derive matching directional keys", async () => {
    const { ki, kr } = await handshake();
    const { initiator, responder } = codecs(ki, kr);

    const toResponder = await initiator.seal(Channel.Ctl, FrameType.Chat, utf8("hi bob"));
    expect(new TextDecoder().decode((await responder.open(toResponder)).plaintext)).toBe("hi bob");

    const toInitiator = await responder.seal(Channel.Ctl, FrameType.Chat, utf8("hi alice"));
    expect(new TextDecoder().decode((await initiator.open(toInitiator)).plaintext)).toBe(
      "hi alice",
    );

    expect(Array.from(ki.sas)).toEqual(Array.from(kr.sas));
  });

  it("uses the ML-KEM-768 sizes and a fresh session every time", async () => {
    const key = generateRoomKey();
    const one = await handshake(key);
    const two = await handshake(key);
    expect(atob(one.hello.pk)).toHaveLength(1184);
    expect(atob(one.reply.ct)).toHaveLength(1088);
    expect(one.hello.pk).not.toBe(two.hello.pk);
    expect(Array.from(one.ki.sas)).not.toEqual(Array.from(two.ki.sas));
  });

  it("fails when the peers hold different room keys (e.g. a server without the link)", async () => {
    await expect(handshake(generateRoomKey(), generateRoomKey())).rejects.toMatchObject({
      code: "pq_failed",
    });
  });

  it("fails when the peers disagree about the room id (transcript binding)", async () => {
    const key = generateRoomKey();
    await expect(handshake(key, key, ROOM, "BBBBBBBBBBBBBBBBBBBBBB")).rejects.toMatchObject({
      code: "pq_failed",
    });
  });

  it("binds the two peer ids: a handshake between a different pair of members fails", async () => {
    const key = generateRoomKey();
    const otherPair = { initiator: PAIR.initiator, responder: "x".repeat(22) };
    await expect(handshake(key, key, ROOM, ROOM, otherPair)).rejects.toMatchObject({
      code: "pq_failed",
    });
    const swapped = { initiator: PAIR.responder, responder: PAIR.initiator };
    await expect(handshake(key, key, ROOM, ROOM, swapped)).rejects.toMatchObject({
      code: "pq_failed",
    });
  });

  it("detects a tampered public key in transit", async () => {
    // Flipping a bit either makes the key invalid (ML-KEM rejects it at encapsulation) or yields a
    // different shared secret (the MAC fails). Both must surface as pq_failed.
    for (let attempt = 0; attempt < 8; attempt++) {
      const key = generateRoomKey();
      const i = new InitiatorHandshake(ROOM, key, PAIR);
      const r = new ResponderHandshake(ROOM, key, PAIR);
      const hello = i.start() as Msg<"pq.hello">;
      const pk = Uint8Array.from(atob(hello.pk), (c) => c.charCodeAt(0));
      pk[(attempt * 37) % pk.length] = pk[(attempt * 37) % pk.length]! ^ 1;
      const forged = { ...hello, pk: btoa(String.fromCharCode(...pk)) };
      const run = async () => i.handleReply((await r.handleHello(forged)) as Msg<"pq.reply">);
      await expect(run()).rejects.toMatchObject({ code: "pq_failed" });
    }
  });

  it("detects a tampered ciphertext in transit (implicit rejection → MAC mismatch)", async () => {
    const key = generateRoomKey();
    const i = new InitiatorHandshake(ROOM, key, PAIR);
    const r = new ResponderHandshake(ROOM, key, PAIR);
    const reply = (await r.handleHello(i.start() as Msg<"pq.hello">)) as Msg<"pq.reply">;
    const ct = Uint8Array.from(atob(reply.ct), (c) => c.charCodeAt(0));
    ct[100] = ct[100]! ^ 1;
    const forged = { ...reply, ct: btoa(String.fromCharCode(...ct)) };
    await expect(i.handleReply(forged)).rejects.toMatchObject({ code: "pq_failed" });
  });

  it("detects a tampered responder MAC", async () => {
    const key = generateRoomKey();
    const i = new InitiatorHandshake(ROOM, key, PAIR);
    const r = new ResponderHandshake(ROOM, key, PAIR);
    const reply = (await r.handleHello(i.start() as Msg<"pq.hello">)) as Msg<"pq.reply">;
    const mac = Uint8Array.from(atob(reply.confirm), (c) => c.charCodeAt(0));
    mac[0] = mac[0]! ^ 1;
    await expect(
      i.handleReply({ ...reply, confirm: btoa(String.fromCharCode(...mac)) }),
    ).rejects.toMatchObject({ code: "pq_failed" });
  });

  it("rejects a reflected responder MAC as the initiator MAC (anti-reflection)", async () => {
    const key = generateRoomKey();
    const i = new InitiatorHandshake(ROOM, key, PAIR);
    const r = new ResponderHandshake(ROOM, key, PAIR);
    const reply = (await r.handleHello(i.start() as Msg<"pq.hello">)) as Msg<"pq.reply">;
    await i.handleReply(reply);
    await expect(
      r.handleConfirm({ v: 1, t: "pq.confirm", confirm: reply.confirm }),
    ).rejects.toMatchObject({ code: "pq_failed" });
  });

  it("rejects malformed fields and out-of-order messages", async () => {
    const key = generateRoomKey();
    const r = new ResponderHandshake(ROOM, key, PAIR);
    await expect(
      r.handleConfirm({ v: 1, t: "pq.confirm", confirm: "AAAA" }),
    ).rejects.toBeInstanceOf(PoofError);
    await expect(r.handleHello({ v: 1, t: "pq.hello", pk: "AAAA" })).rejects.toMatchObject({
      code: "pq_failed",
    });
    await expect(r.handleHello({ v: 1, t: "pq.hello", pk: "!!!" })).rejects.toMatchObject({
      code: "pq_failed",
    });

    const i = new InitiatorHandshake(ROOM, key, PAIR);
    await expect(
      i.handleReply({ v: 1, t: "pq.reply", ct: "AAAA", confirm: "AAAA" }),
    ).rejects.toMatchObject({ code: "pq_failed" });
  });

  it("a MITM that HOLDS the link can run two legs undetected by the MACs, but the safety codes differ", async () => {
    // Known, documented limitation: holding K_C lets an active attacker run one
    // honest handshake per leg. Both pass. The only defence is the out-of-band safety code (SAS).
    const key = generateRoomKey();
    const legA = await handshake(key);
    const legB = await handshake(key);
    expect(Array.from(legA.ki.sas)).not.toEqual(Array.from(legB.kr.sas));
  });
});

describe("AEAD frames", () => {
  async function pair() {
    const { ki, kr } = await handshake();
    return codecs(ki, kr);
  }

  it("round-trips every type on its channel", async () => {
    const { initiator, responder } = await pair();
    const cases = [
      [Channel.Ctl, FrameType.Chat],
      [Channel.Ctl, FrameType.Ctl],
      [Channel.Files, FrameType.FileMeta],
      [Channel.Files, FrameType.FileChunk],
      [Channel.Files, FrameType.FileEnd],
      [Channel.Files, FrameType.FileAbort],
      [Channel.Files, FrameType.FileAck],
    ] as const;
    for (const [channel, type] of cases) {
      const opened = await responder.open(await initiator.seal(channel, type, utf8("x")));
      expect(opened).toMatchObject({ channel, type });
    }
  });

  it("frames are not plaintext and have the documented layout", async () => {
    const { initiator } = await pair();
    const frame = await initiator.seal(Channel.Ctl, FrameType.Chat, utf8("secret secret secret"));
    expect(frame[0]).toBe(FRAME.VERSION);
    expect(frame[1]).toBe(Channel.Ctl);
    expect(frame[2]).toBe(FrameType.Chat);
    expect(frame).toHaveLength(
      FRAME.HEADER_BYTES + "secret secret secret".length + FRAME.TAG_BYTES,
    );
    expect(new TextDecoder("latin1").decode(frame)).not.toContain("secret");
  });

  it("the same plaintext never produces the same ciphertext (counter nonce)", async () => {
    const { initiator } = await pair();
    const a = await initiator.seal(Channel.Ctl, FrameType.Chat, utf8("same"));
    const b = await initiator.seal(Channel.Ctl, FrameType.Chat, utf8("same"));
    expect(Array.from(a.slice(FRAME.HEADER_BYTES))).not.toEqual(
      Array.from(b.slice(FRAME.HEADER_BYTES)),
    );
  });

  it("rejects replayed, dropped and reordered frames", async () => {
    const { initiator, responder } = await pair();
    const f0 = await initiator.seal(Channel.Ctl, FrameType.Chat, utf8("0"));
    const f1 = await initiator.seal(Channel.Ctl, FrameType.Chat, utf8("1"));
    const f2 = await initiator.seal(Channel.Ctl, FrameType.Chat, utf8("2"));

    await expect(responder.open(f1)).rejects.toMatchObject({ code: "frame_out_of_order" }); // gap
    await responder.open(f0);
    await expect(responder.open(f0)).rejects.toMatchObject({ code: "frame_out_of_order" }); // replay
    await responder.open(f1);
    await responder.open(f2);
  });

  it("keeps independent sequences per channel", async () => {
    const { initiator, responder } = await pair();
    const chat = await initiator.seal(Channel.Ctl, FrameType.Chat, utf8("c"));
    const file = await initiator.seal(Channel.Files, FrameType.FileMeta, utf8("f"));
    // Opening the file frame first is fine: its channel's counter is its own.
    await responder.open(file);
    await responder.open(chat);
  });

  it("rejects a frame reflected back to its sender (directional keys)", async () => {
    const { initiator } = await pair();
    const frame = await initiator.seal(Channel.Ctl, FrameType.Chat, utf8("mine"));
    // The sender's own receive counter expects seq 0 and its receive key differs from its send key.
    await expect(initiator.open(frame)).rejects.toMatchObject({ code: "decrypt_failed" });
  });

  it("rejects tampering with the type byte (valid for the channel, so only the AAD catches it)", async () => {
    const { initiator, responder } = await pair();
    const frame = await initiator.seal(Channel.Ctl, FrameType.Chat, utf8("hello"));
    frame[2] = FrameType.Ctl;
    await expect(responder.open(frame)).rejects.toMatchObject({ code: "decrypt_failed" });
  });

  it("rejects tampering with the sequence number, the ciphertext and the tag", async () => {
    // Each case needs a fresh pair: a failed open() still consumes the receiver's sequence number.
    const sample = await (async () => {
      const { initiator } = await pair();
      return initiator.seal(Channel.Ctl, FrameType.Chat, utf8("hello"));
    })();
    for (const index of [10, FRAME.HEADER_BYTES, sample.length - 1]) {
      const { initiator, responder } = await pair();
      const frame = await initiator.seal(Channel.Ctl, FrameType.Chat, utf8("hello"));
      frame[index] = frame[index]! ^ 0x01;
      await expect(responder.open(frame)).rejects.toBeInstanceOf(PoofError);
    }
  });

  it("rejects bad versions, unknown types, wrong channel/type pairs and short frames", async () => {
    const { initiator, responder } = await pair();
    const ok = await initiator.seal(Channel.Ctl, FrameType.Chat, utf8("x"));

    const badVersion = Uint8Array.from(ok);
    badVersion[0] = 9;
    await expect(responder.open(badVersion)).rejects.toMatchObject({ code: "frame_invalid" });

    const badType = Uint8Array.from(ok);
    badType[2] = 0x77;
    await expect(responder.open(badType)).rejects.toMatchObject({ code: "frame_invalid" });

    const wrongChannel = Uint8Array.from(ok);
    wrongChannel[1] = Channel.Files; // chat type on the files channel
    await expect(responder.open(wrongChannel)).rejects.toMatchObject({ code: "frame_invalid" });

    await expect(responder.open(new Uint8Array(10))).rejects.toMatchObject({
      code: "frame_invalid",
    });
    await expect(responder.open(concat(ok.slice(0, 11), new Uint8Array(3)))).rejects.toMatchObject({
      code: "frame_invalid",
    });
  });

  it("preserves send order under concurrent sealing", async () => {
    const { initiator, responder } = await pair();
    const frames = await Promise.all(
      Array.from({ length: 20 }, (_, n) =>
        initiator.seal(Channel.Ctl, FrameType.Chat, utf8(String(n))),
      ),
    );
    for (const [n, frame] of frames.entries()) {
      const opened = await responder.open(frame);
      expect(new TextDecoder().decode(opened.plaintext)).toBe(String(n));
    }
  });

  it("handles empty and large payloads", async () => {
    const { initiator, responder } = await pair();
    const empty = await responder.open(
      await initiator.seal(Channel.Ctl, FrameType.Ctl, new Uint8Array(0)),
    );
    expect(empty.plaintext).toHaveLength(0);
    const big = crypto.getRandomValues(new Uint8Array(60_000));
    const opened = await responder.open(
      await initiator.seal(Channel.Files, FrameType.FileChunk, big),
    );
    expect(Array.from(opened.plaintext)).toEqual(Array.from(big));
  });
});

describe("text normalisation", () => {
  it("keeps newlines and tabs, strips other control characters", () => {
    expect(normalizeChatText("a\nb\tc")).toBe("a\nb\tc");
    expect(normalizeChatText("a\r\nb\rc")).toBe("a\nb\nc");
    expect(normalizeChatText("a\u0000b\u0007c\u007Fd\u0085e")).toBe("abcde");
  });

  it("NFKC-normalises, trims and caps by code points", () => {
    expect(normalizeChatText("  ﬁ  ")).toBe("fi");
    expect(normalizeChatText("😀".repeat(6000))).toBe("😀".repeat(5000));
    expect(normalizeChatText(null)).toBe("");
    expect(normalizeChatText("   ")).toBe("");
  });

  it("renders polyglot payloads as inert text (no HTML handling here, just preserved)", () => {
    const payload = '<img src=x onerror=alert(1)>"><script>alert(1)</script>';
    expect(normalizeChatText(payload)).toBe(payload);
  });

  it("sanitises file names", () => {
    expect(sanitizeFileName("../../etc/passwd")).toBe(".._.._etc_passwd");
    expect(sanitizeFileName('a<b>:"c|d?*.txt')).toBe("a_b___c_d__.txt");
    expect(sanitizeFileName("")).toBe("download");
    expect(sanitizeFileName("x".repeat(400))).toHaveLength(255);
    expect(sanitizeFileName("bad\u0000name")).toBe("badname");
    expect(sanitizeFileName("..")).toBe("download");
    expect(sanitizeFileName(" . ")).toBe("download");
    expect(Array.from(sanitizeFileName("😀".repeat(300)))).toHaveLength(255); // cut by characters, not UTF-16 units
  });

  it("keeps only image types a browser can preview safely", () => {
    for (const ok of ["image/png", "image/jpeg", "image/gif", "image/webp"])
      expect(sanitizeMime(ok)).toBe(ok);
    expect(sanitizeMime(" Image/PNG ")).toBe("image/png");
    for (const bad of [
      "text/html",
      "image/svg+xml",
      "application/pdf",
      "text/plain",
      "",
      null,
      undefined,
    ]) {
      expect(sanitizeMime(bad)).toBe("application/octet-stream");
    }
  });
});
