import { waitUntil } from "cloudflare:workers";
import type { RoomKind, StatsResponse } from "@poof/protocol";

import { json } from "./http.ts";

const DAY_MS = 86_400_000;
// The stats page polls; every viewer in a location shares one answer for this long.
const CACHE_SECONDS = 15;
const KINDS: readonly RoomKind[] = ["classic", "super", "ai"];

const utcDay = (ms: number): number => Math.floor(ms / DAY_MS);

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

/** GET /api/stats. Cached per location for CACHE_SECONDS under one key, whatever the query string. */
export async function getStats(request: Request, env: Env): Promise<Response> {
  const key = new Request(new URL("/api/stats", request.url).toString());
  const cache = caches.default;
  const cached = await cache.match(key);
  // A copy: headers of a cached response can't be changed, and CORS headers are added later.
  if (cached) return new Response(cached.body, cached);

  const now = Date.now();
  const [today, totals] = await env.LEDGER.batch<{ kind: string; count: number }>([
    env.LEDGER.prepare("SELECT kind, count FROM room_stats WHERE day = ?").bind(utcDay(now)),
    env.LEDGER.prepare("SELECT kind, count FROM room_totals"),
  ]);
  const countOf = (rows: { kind: string; count: number }[], kind: RoomKind): number =>
    rows.find((r) => r.kind === kind)?.count ?? 0;
  const rooms = Object.fromEntries(
    KINDS.map((k) => [k, { today: countOf(today!.results, k), all: countOf(totals!.results, k) }]),
  ) as StatsResponse["rooms"];

  const response = json({ rooms, at: now } satisfies StatsResponse);
  response.headers.set("Cache-Control", `public, max-age=${CACHE_SECONDS}`);
  waitUntil(cache.put(key, response.clone()));
  return response;
}
