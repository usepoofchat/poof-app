import { waitUntil } from "cloudflare:workers";
import type { RoomKind, StatsResponse } from "@poof/protocol";

import { json } from "./http.ts";

const DAY_MS = 86_400_000;
// The stats page polls; every viewer in a location shares one answer for this long.
const CACHE_SECONDS = 15;
const KINDS: readonly RoomKind[] = ["classic", "super", "ai"];
// roomsV2 credits: quant-rooms of each kind credited every hour, inclusive.
const CREDIT_MIN = 1;
const CREDIT_MAX = 3;

const utcDay = (ms: number): number => Math.floor(ms / DAY_MS);
// Uniform in [0, 1). Nothing secret rides on it, but the lint rule wants one source of randomness.
const randomUnit = (): number => crypto.getRandomValues(new Uint32Array(1))[0]! / 2 ** 32;

/**
 * One more quant-room of this kind, today and all time. In the background, after the response, and a
 * failure is dropped: a lost count must never cost anyone their room.
 */
export function countRoom(env: Env, kind: RoomKind): void {
  const day = utcDay(Date.now());
  waitUntil(
    env.LEDGER.batch([
      env.LEDGER.prepare(
        "INSERT INTO room_stats (day, kind, count) VALUES (?, ?, 1) " +
          "ON CONFLICT (day, kind) DO UPDATE SET count = count + 1",
      ).bind(day, kind),
      env.LEDGER.prepare(
        "INSERT INTO room_totals (kind, count) VALUES (?, 1) " +
          "ON CONFLICT (kind) DO UPDATE SET count = count + 1",
      ).bind(kind),
    ]).catch(() => undefined),
  );
}

/**
 * Credited quant-rooms for roomsV2, run by the hourly cron: CREDIT_MIN..CREDIT_MAX of each kind, each
 * kind with its own draw. Only the credit_ tables: the real counters are never touched.
 */
export async function creditRooms(env: Env, now = Date.now(), random = randomUnit): Promise<void> {
  const day = utcDay(now);
  await env.LEDGER.batch(
    KINDS.flatMap((kind) => {
      const added = CREDIT_MIN + Math.floor(random() * (CREDIT_MAX - CREDIT_MIN + 1));
      return [
        env.LEDGER.prepare(
          "INSERT INTO credit_room_stats (day, kind, count) VALUES (?, ?, ?) " +
            "ON CONFLICT (day, kind) DO UPDATE SET count = count + excluded.count",
        ).bind(day, kind, added),
        env.LEDGER.prepare(
          "INSERT INTO credit_room_totals (kind, count) VALUES (?, ?) " +
            "ON CONFLICT (kind) DO UPDATE SET count = count + excluded.count",
        ).bind(kind, added),
      ];
    }),
  );
}

type CountRow = { kind: string; count: number };

/** GET /api/stats. Cached per location for CACHE_SECONDS under one key, whatever the query string. */
export async function getStats(request: Request, env: Env): Promise<Response> {
  const key = new Request(new URL("/api/stats", request.url).toString());
  const cache = caches.default;
  const cached = await cache.match(key);
  // A copy: headers of a cached response can't be changed, and CORS headers are added later.
  if (cached) return new Response(cached.body, cached);

  const now = Date.now();
  const day = utcDay(now);
  const [today, totals, creditToday, creditTotals] = await env.LEDGER.batch<CountRow>([
    env.LEDGER.prepare("SELECT kind, count FROM room_stats WHERE day = ?").bind(day),
    env.LEDGER.prepare("SELECT kind, count FROM room_totals"),
    env.LEDGER.prepare("SELECT kind, count FROM credit_room_stats WHERE day = ?").bind(day),
    env.LEDGER.prepare("SELECT kind, count FROM credit_room_totals"),
  ]);
  const countOf = (rows: CountRow[], kind: RoomKind): number =>
    rows.find((r) => r.kind === kind)?.count ?? 0;
  const counts = (todayRows: CountRow[], allRows: CountRow[]) =>
    Object.fromEntries(
      KINDS.map((k) => [k, { today: countOf(todayRows, k), all: countOf(allRows, k) }]),
    ) as StatsResponse["rooms"];
  const rooms = counts(today!.results, totals!.results);
  const credited = counts(creditToday!.results, creditTotals!.results);
  const roomsV2 = Object.fromEntries(
    KINDS.map((k) => [
      k,
      { today: rooms[k].today + credited[k].today, all: rooms[k].all + credited[k].all },
    ]),
  ) as StatsResponse["roomsV2"];

  const response = json({ rooms, roomsV2, at: now } satisfies StatsResponse);
  response.headers.set("Cache-Control", `public, max-age=${CACHE_SECONDS}`);
  waitUntil(cache.put(key, response.clone()));
  return response;
}
