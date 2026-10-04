import { describe, expect, it } from "vitest";
import {
  AI_SYSTEM_PROMPT,
  RoomSession,
  buildAiPrompt,
  generateRoomKey,
  mentionsAi,
  stripMention,
  type ChatItem,
  type SessionDeps,
  type SessionStatus,
} from "../src/index.ts";
import { FakeRoomServer, FakeRtcNetwork, waitFor } from "./fakes.ts";

const ROOM = "AAAAAAAAAAAAAAAAAAAAAA";
const ALICE = "alice".padEnd(22, "_");
const BOB = "bobby".padEnd(22, "_");
const CAROL = "carol".padEnd(22, "_");
const ORIGIN = "https://poof.test";

function world(maxPeers: number) {
  const server = new FakeRoomServer();
  server.createRoom(ROOM, 600_000, FakeRoomServer.OWNER_SECRET, maxPeers);
  server.enableAi(ROOM);
  const net = new FakeRtcNetwork();
  const key = generateRoomKey();
  const make = (peerId: string, overrides: Partial<SessionDeps> = {}) =>
    new RoomSession({
      roomId: ROOM,
      roomKey: key,
      origin: ORIGIN,
      fetch: server.fetch,
      createSocket: server.createSocket,
      createPeerConnection: net.factory,
      peerId,
      pqTimeoutMs: 1500,
      ...(peerId === ALICE ? { ownerSecret: FakeRoomServer.OWNER_SECRET } : {}),
      ...overrides,
    });
  return { server, net, make };
}

const status = (s: RoomSession): SessionStatus => s.getState().status;
const until = (s: RoomSession, st: SessionStatus) =>
  waitFor(() => status(s) === st, `status ${st} (is ${status(s)})`);
const aiItems = (s: RoomSession) =>
  s.getState().messages.filter((m): m is Extract<ChatItem, { kind: "ai" }> => m.kind === "ai");
const lastAi = (s: RoomSession) => aiItems(s).at(-1);
const aiDone = (s: RoomSession, n = 1) =>
  waitFor(
    () => aiItems(s).filter((m) => m.status !== "streaming").length >= n,
    `${n} finished AI answer(s)`,
  );

async function group(w: ReturnType<typeof world>) {
  const alice = w.make(ALICE);
  const bob = w.make(BOB);
  const carol = w.make(CAROL);
  await alice.start();
  await until(alice, "waiting");
  await bob.start();
  await carol.start();
  await waitFor(
    () =>
      [alice, bob, carol].every(
        (s) => s.getState().members.filter((m) => m.state === "sealed").length === 2,
      ),
    "everyone sealed with everyone",
  );
  return { alice, bob, carol };
}

describe("a quant-room for one, with the AI", () => {
  it("every message goes to the AI, with nobody else there; the answer streams in", async () => {
    const w = world(1);
    const me = w.make(ALICE);
    await me.start();
    await until(me, "waiting");
    expect(me.getState().ai).toBe(true);

    await me.sendMessage("hi, who are you?");
    await aiDone(me);
    expect(lastAi(me)).toMatchObject({ askedBy: null, text: "Hello there.", status: "done" });
    expect(me.getState().aiPending).toEqual([]);

    const [req] = w.server.ai.requests;
    expect(req!.system).toBe(AI_SYSTEM_PROMPT);
    expect(req!.user).toContain("hi, who are you?");
    // The creator registered the room's token hash on its own.
    expect(w.server.ai.rooms.get(ROOM)!.aiHash).toMatch(/^[A-Za-z0-9_-]{43}$/);
    await me.leave();
  });

  it("follow-up questions carry the earlier conversation, answers included", async () => {
    const w = world(1);
    const me = w.make(ALICE);
    await me.start();
    await until(me, "waiting");
    me.setNickname("Ana");
    w.server.ai.answer = (req) => [req.user.includes("second") ? "Two." : "One."];
    await me.sendMessage("first question");
    await aiDone(me);
    await me.sendMessage("second question");
    await aiDone(me, 2);
    const user = w.server.ai.requests[1]!.user;
    expect(user).toContain("Ana: first question\nAI: One.");
    expect(user.endsWith("Ana: second question")).toBe(true);
    await me.leave();
  });

  it("a room without the AI still needs someone to talk to", async () => {
    const w = world(2);
    w.server.rooms.get(ROOM)!.ai = false;
    const me = w.make(ALICE);
    await me.start();
    await until(me, "waiting");
    await expect(me.sendMessage("hello?")).rejects.toMatchObject({ code: "not_connected" });
    expect(w.server.ai.requests).toHaveLength(0);
    await me.leave();
  });
});

describe("a group with the AI", () => {
  it("@ai asks it; the asker streams the answer and everyone gets it, labelled with who asked", async () => {
    const w = world(3);
    const { alice, bob, carol } = await group(w);
    bob.setNickname("Bob");

    await alice.sendMessage("plain message, no AI");
    await waitFor(() => carol.getState().messages.some((m) => m.kind === "text"), "carol got it");
    expect(w.server.ai.requests).toHaveLength(0);

    await bob.sendMessage("@ai what is 2+2?");
    await aiDone(bob);
    await waitFor(() => aiItems(alice).length === 1 && aiItems(carol).length === 1, "fan-out");
    for (const s of [alice, carol]) {
      expect(lastAi(s)).toMatchObject({ askedBy: BOB, text: "Hello there.", status: "done" });
      expect(
        s.getState().messages.some((m) => m.kind === "text" && m.text === "@ai what is 2+2?"),
      ).toBe(true);
    }
    expect(lastAi(bob)!.id).toBe(lastAi(alice)!.id);
    const user = w.server.ai.requests[0]!.user;
    expect(user.endsWith("Bob: what is 2+2?")).toBe(true);
    expect(user).toContain("plain message, no AI");
    for (const s of [alice, bob, carol]) await s.leave();
  });

  it("others see that the AI is thinking until the answer arrives", async () => {
    const w = world(3);
    const { alice, bob, carol } = await group(w);
    w.server.ai.hold = true;
    await carol.sendMessage("@ai slow one");
    await waitFor(
      () => alice.getState().aiPending.some((p) => p.askedBy === CAROL),
      "alice sees it",
    );
    expect(carol.getState().aiPending).toMatchObject([{ askedBy: null }]);
    await waitFor(() => w.server.ai.requests.length === 1, "the request reached the enclave");
    w.server.ai.release();
    await waitFor(() => aiItems(alice).length === 1, "answer");
    expect(alice.getState().aiPending).toEqual([]);
    for (const s of [alice, bob, carol]) await s.leave();
  });

  it("an empty @ai is refused before anything is sent", async () => {
    const w = world(3);
    const { alice, bob, carol } = await group(w);
    await expect(bob.sendMessage("@ai")).rejects.toMatchObject({ code: "invalid_message" });
    expect(w.server.ai.requests).toHaveLength(0);
    for (const s of [alice, bob, carol]) await s.leave();
  });
});

describe("when the AI can't answer", () => {
  it("budget used up: the answer fails with the reason, the others stop waiting", async () => {
    const w = world(3);
    const { alice, bob, carol } = await group(w);
    w.server.ai.rooms.get(ROOM)!.budget = 0;
    await bob.sendMessage("@ai anything");
    await aiDone(bob);
    expect(lastAi(bob)).toMatchObject({ status: "failed", error: "ai_budget_exhausted" });
    await waitFor(() => alice.getState().aiPending.length === 0, "alice stops waiting");
    expect(aiItems(alice)).toHaveLength(0);
    for (const s of [alice, bob, carol]) await s.leave();
  });

  it("an enclave in debug mode is refused: nothing is sent to it", async () => {
    const w = world(1);
    w.server.ai.debug = true;
    const me = w.make(ALICE);
    await me.start();
    await until(me, "waiting");
    await me.sendMessage("secret question");
    await aiDone(me);
    expect(lastAi(me)).toMatchObject({ status: "failed", error: "ai_attestation_failed" });
    expect(w.server.ai.requests).toHaveLength(0);
    await me.leave();
  });

  it("provider down: ai_unavailable, and the next question works", async () => {
    const w = world(1);
    const me = w.make(ALICE);
    await me.start();
    await until(me, "waiting");
    w.server.ai.failNext = { status: 503, code: "ai_unavailable" };
    await me.sendMessage("one");
    await aiDone(me);
    expect(lastAi(me)).toMatchObject({ status: "failed", error: "ai_unavailable" });
    await me.sendMessage("two");
    await aiDone(me, 2);
    expect(lastAi(me)).toMatchObject({ status: "done" });
    await me.leave();
  });

  it("leaving while it answers stops the stream and wipes everything", async () => {
    const w = world(1);
    w.server.ai.hold = true;
    const me = w.make(ALICE);
    await me.start();
    await until(me, "waiting");
    await me.sendMessage("long answer please");
    await waitFor(() => lastAi(me)?.text === "Hello there.", "streamed pieces");
    expect(lastAi(me)!.status).toBe("streaming");
    await me.leave();
    expect(me.getState()).toMatchObject({ status: "terminated", messages: [], aiPending: [] });
    w.server.ai.release();
  });
});

describe("the prompt", () => {
  it("@ai is recognised only at the start", () => {
    expect(mentionsAi("@ai hello")).toBe(true);
    expect(mentionsAi("  @AI, hello")).toBe(true);
    expect(mentionsAi("@aim high")).toBe(false);
    expect(mentionsAi("hey @ai")).toBe(false);
    expect(stripMention("@ai: what now?")).toBe("what now?");
  });

  it("drops the oldest lines first when the conversation is long", () => {
    const history = Array.from({ length: 5000 }, (_, i) => ({
      speaker: "Ana",
      text: `line ${i} ${"x".repeat(50)}`,
    }));
    const { user } = buildAiPrompt(history, { speaker: "Ana", text: "the question" });
    expect(new TextEncoder().encode(user).length).toBeLessThanOrEqual(120_200);
    expect(user).toContain("line 4999");
    expect(user).not.toContain("line 0 ");
    expect(user.endsWith("Ana: the question")).toBe(true);
  });
});
