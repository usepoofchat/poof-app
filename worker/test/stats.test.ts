import { env } from "cloudflare:workers";
import { statsResponseSchema } from "@poof/protocol";
import { describe, expect, it, vi } from "vitest";
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
