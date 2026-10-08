import { createScheduledController } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { statsResponseSchema, type RoomKind } from "@poof/protocol";
import { describe, expect, it, vi } from "vitest";
import worker from "../src/index.ts";
import { creditRooms } from "../src/stats.ts";
import { ANY_OWNER, api, postJson, totalOf } from "./helpers.ts";

const today = (): number => Math.floor(Date.now() / 86_400_000);

/** GET /api/stats without the per-location cache, so a test sees what it just wrote. */
async function freshStats() {
  await caches.default.delete("http://poof.test/api/stats");
  const res = await api("/api/stats");
  expect(res.status).toBe(200);
  return { res, body: statsResponseSchema.parse(await res.json()) };
}

describe("quant-room counters", () => {
  it("a free room counts as classic, today and all time", async () => {
    const before = await totalOf("classic");
    expect((await postJson("/api/rooms", ANY_OWNER)).status).toBe(200);
    await vi.waitFor(async () => expect(await totalOf("classic")).toBe(before + 1));
    const day = await env.LEDGER.prepare(
      "SELECT count FROM room_stats WHERE day = ? AND kind = 'classic'",
    )
      .bind(today())
      .first<{ count: number }>();
    expect(day?.count).toBeGreaterThanOrEqual(1);
  });

  it("a refused request counts nothing", async () => {
    const before = await totalOf("classic");
    expect((await postJson("/api/rooms", { ownerHash: "short" })).status).toBe(400);
    await new Promise((r) => setTimeout(r, 50));
    expect(await totalOf("classic")).toBe(before);
  });

  it("stores no room id and no time finer than the day", async () => {
    const columns = async (table: string) =>
      (await env.LEDGER.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>()).results
        .map((c) => c.name)
        .sort();
    expect(await columns("room_stats")).toEqual(["count", "day", "kind"]);
    expect(await columns("room_totals")).toEqual(["count", "kind"]);
  });
});

/** All-time credited quant-rooms of a kind (roomsV2 minus the real ones). */
async function creditTotalOf(kind: RoomKind): Promise<number> {
  const row = await env.LEDGER.prepare("SELECT count FROM credit_room_totals WHERE kind = ?")
    .bind(kind)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

const KINDS: RoomKind[] = ["classic", "super", "ai"];
const totals = (of: (k: RoomKind) => Promise<number>) => Promise.all(KINDS.map(of));

describe("roomsV2 credits", () => {
  // First in this file: no test here has credited anything yet.
  it("start from the seed: today on the day the migration runs, and all time", async () => {
    const day = await env.LEDGER.prepare("SELECT kind, count FROM credit_room_stats WHERE day = ?")
      .bind(today())
      .all<{ kind: RoomKind; count: number }>();
    expect(Object.fromEntries(day.results.map((r) => [r.kind, r.count]))).toEqual({
      classic: 54,
      super: 18,
    });
    expect(await totals(creditTotalOf)).toEqual([143, 62, 0]);
  });

  it("the hourly cron credits 1 to 3 rooms of each kind, and no real ones", async () => {
    const [real, credited] = [await totals(totalOf), await totals(creditTotalOf)];
    await worker.scheduled(createScheduledController({ cron: "0 * * * *" }), env);
    expect(await totals(totalOf)).toEqual(real);
    const added = (await totals(creditTotalOf)).map((n, i) => n - credited[i]!);
    for (const n of added) {
      expect(n).toBeGreaterThanOrEqual(1);
      expect(n).toBeLessThanOrEqual(3);
    }
  });

  it("each kind draws its own number, from 1 up to 3", async () => {
    const credited = await totals(creditTotalOf);
    const draws = [0, 0.5, 0.999];
    await creditRooms(env, Date.now(), () => draws.shift()!);
    expect((await totals(creditTotalOf)).map((n, i) => n - credited[i]!)).toEqual([1, 2, 3]);
  });

  it("roomsV2 is the real rooms plus the credited ones, today and all time", async () => {
    await creditRooms(env, Date.now(), () => 0.999);
    // Yesterday's credited rooms: in all time, not in today.
    await creditRooms(env, Date.now() - 86_400_000, () => 0);
    const day = await env.LEDGER.prepare("SELECT kind, count FROM credit_room_stats WHERE day = ?")
      .bind(today())
      .all<{ kind: RoomKind; count: number }>();
    const { body } = await freshStats();
    for (const k of KINDS) {
      const creditToday = day.results.find((r) => r.kind === k)?.count ?? 0;
      expect(creditToday).toBeGreaterThanOrEqual(3);
      expect(body.rooms[k]).toEqual({ today: body.rooms[k].today, all: await totalOf(k) });
      expect(body.roomsV2[k]).toEqual({
        today: body.rooms[k].today + creditToday,
        all: body.rooms[k].all + (await creditTotalOf(k)),
      });
    }
  });
});

describe("GET /api/stats", () => {
  it("answers today and all time for every kind", async () => {
    await env.LEDGER.batch([
      env.LEDGER.prepare(
        "INSERT INTO room_stats (day, kind, count) VALUES (?, 'super', 3) " +
          "ON CONFLICT (day, kind) DO UPDATE SET count = 3",
      ).bind(today()),
      // Yesterday: in all time, not in today.
      env.LEDGER.prepare(
        "INSERT INTO room_stats (day, kind, count) VALUES (?, 'super', 5) " +
          "ON CONFLICT (day, kind) DO UPDATE SET count = 5",
      ).bind(today() - 1),
      env.LEDGER.prepare(
        "INSERT INTO room_totals (kind, count) VALUES ('super', 8) " +
          "ON CONFLICT (kind) DO UPDATE SET count = 8",
      ),
    ]);
    const before = Date.now();
    const { body } = await freshStats();
    expect(body.rooms.super).toEqual({ today: 3, all: 8 });
    expect(body.rooms.classic.all).toBe(await totalOf("classic"));
    expect(body.rooms.ai.all).toBe(await totalOf("ai"));
    expect(body.at).toBeGreaterThanOrEqual(before);
  });

  it("is public for a short while, and the site may read it", async () => {
    await caches.default.delete("http://poof.test/api/stats");
    const res = await api("/api/stats", { headers: { Origin: "https://usepoof.chat" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=15");
    expect(res.headers.get("access-control-allow-origin")).toBe("https://usepoof.chat");
  });

  it("serves one cached answer per location, whatever the query string", async () => {
    const { body: first } = await freshStats();
    await vi.waitFor(async () =>
      expect(await caches.default.match("http://poof.test/api/stats")).toBeDefined(),
    );
    expect((await postJson("/api/rooms", ANY_OWNER)).status).toBe(200);
    await vi.waitFor(async () =>
      expect(await totalOf("classic")).toBe(first.rooms.classic.all + 1),
    );

    const cached = await api(`/api/stats?bust=1`, {
      headers: { Origin: "https://usepoof.chat" },
    });
    expect(statsResponseSchema.parse(await cached.json())).toEqual(first);
    expect(cached.headers.get("access-control-allow-origin")).toBe("https://usepoof.chat");
  });

  it("only GET", async () => {
    const res = await api("/api/stats", { method: "DELETE" });
    expect(res.status).toBe(405);
  });
});
