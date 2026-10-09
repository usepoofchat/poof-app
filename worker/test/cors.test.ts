import { describe, expect, it } from "vitest";
import { ANY_OWNER, api, createRoom, postJson } from "./helpers.ts";

// ALLOWED_ORIGINS in wrangler.jsonc (production): the web app lives on another origin.
const SITE = "https://usepoof.chat";
const EVIL = "https://evil.example";

const preflight = (path: string, origin: string) =>
  api(path, {
    method: "OPTIONS",
    headers: {
      Origin: origin,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type",
    },
  });

describe("CORS for the web app", () => {
  it("answers the site's preflight, and nobody else's", async () => {
    const ok = await preflight("/api/rooms", SITE);
    expect(ok.status).toBe(204);
    expect(ok.headers.get("Access-Control-Allow-Origin")).toBe(SITE);
    expect(ok.headers.get("Access-Control-Allow-Methods")).toBe("GET, POST, PUT, DELETE");
    expect(ok.headers.get("Access-Control-Allow-Headers")).toBe("Content-Type");
    expect(ok.headers.get("Access-Control-Allow-Credentials")).toBeNull();

    const evil = await preflight("/api/rooms", EVIL);
    expect(evil.status).toBe(403);
    expect(evil.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("lets the site create a room and read it", async () => {
    const created = await postJson("/api/rooms", ANY_OWNER, { Origin: SITE });
    expect(created.status).toBe(200);
    expect(created.headers.get("Access-Control-Allow-Origin")).toBe(SITE);
    expect(created.headers.get("Vary")).toContain("Origin");

    const { roomId } = (await created.json()) as { roomId: string };
    const read = await api(`/api/rooms/${roomId}`, { headers: { Origin: SITE } });
    expect(read.status).toBe(200);
    expect(read.headers.get("Access-Control-Allow-Origin")).toBe(SITE);
  });

  it("also marks errors as readable by the site, so it can show them", async () => {
    const res = await api("/api/rooms/AAAAAAAAAAAAAAAAAAAAAA", { headers: { Origin: SITE } });
    expect(res.status).toBe(404);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(SITE);
  });

  it("gives other origins nothing to read, and refuses their writes", async () => {
    const room = await createRoom();
    const read = await api(`/api/rooms/${room.roomId}`, { headers: { Origin: EVIL } });
    expect(read.headers.get("Access-Control-Allow-Origin")).toBeNull();

    const write = await postJson("/api/rooms", ANY_OWNER, { Origin: EVIL });
    expect(write.status).toBe(403);
    expect(write.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("sends no CORS headers without an Origin (curl, tests)", async () => {
    const res = await postJson("/api/rooms", ANY_OWNER);
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("answers anything outside /api and /ws with a 404", async () => {
    expect((await api("/")).status).toBe(404);
    expect((await api("/index.html")).status).toBe(404);
  });
});
