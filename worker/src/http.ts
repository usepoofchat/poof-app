import {
  PROTOCOL_VERSION,
  type ErrorBody,
  type ErrorCode,
  type ServerMessage,
} from "@poof/protocol";

const SECURITY_HEADERS: Record<string, string> = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...SECURITY_HEADERS },
  });
}

export function apiError(code: ErrorCode, message: string, status: number): Response {
  const body: ErrorBody = { error: { code, message } };
  return json(body, status);
}

/**
 * Origin check for the WebSocket upgrade and mutating endpoints. WebSockets are not covered by CORS,
 * so a page on another site could otherwise open a socket (or POST) using the visitor's network.
 * Requests with no Origin header (curl, tests, non-browser clients) are allowed: the check exists to
 * stop cross-site browsers, which always send it.
 */
export function isAllowedOrigin(request: Request, allowedOrigins: string): boolean {
  const origin = request.headers.get("Origin");
  if (!origin) return true;
  let originUrl: URL;
  try {
    originUrl = new URL(origin);
  } catch {
    return false;
  }
  if (originUrl.host === new URL(request.url).host) return true;
  return allowedOrigins
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean)
    .includes(originUrl.origin);
}

/**
 * CORS for the web app, which lives on another origin (the site calls this API). Only origins in
 * ALLOWED_ORIGINS get an `Access-Control-Allow-Origin`; there are no cookies, so no credentials.
 * Same-origin requests don't need it, and requests without an Origin get nothing.
 */
const CORS_MAX_AGE_SECONDS = "600";

function corsOrigin(request: Request, allowedOrigins: string): string | null {
  const origin = request.headers.get("Origin");
  if (!origin || !isAllowedOrigin(request, allowedOrigins)) return null;
  return origin;
}

/** Answer a CORS preflight (OPTIONS) for /api/*. Disallowed origins get a 403 without CORS headers. */
export function preflight(request: Request, allowedOrigins: string): Response {
  const origin = corsOrigin(request, allowedOrigins);
  if (!origin) return apiError("forbidden_origin", "Cross-origin requests are not allowed.", 403);
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, POST, PUT",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": CORS_MAX_AGE_SECONDS,
      Vary: "Origin",
      ...SECURITY_HEADERS,
    },
  });
}

/** Let an allowed origin read this response. */
export function withCors(request: Request, allowedOrigins: string, response: Response): Response {
  const origin = corsOrigin(request, allowedOrigins);
  response.headers.append("Vary", "Origin");
  if (origin) response.headers.set("Access-Control-Allow-Origin", origin);
  return response;
}

/** Client IP as seen by Cloudflare. Used only as a transient rate-limit key; never stored or logged. */
export function clientKey(request: Request): string {
  return request.headers.get("CF-Connecting-IP") ?? "local";
}

/** True when the request is over its limit. Missing bindings (some local setups) fail open. */
export async function isRateLimited(
  binding: RateLimit | undefined,
  request: Request,
): Promise<boolean> {
  if (!binding) return false;
  const { success } = await binding.limit({ key: clientKey(request) });
  return !success;
}

/**
 * Accept a WebSocket only to tell the client why it can't join (`rejected` message, which the client
 * relies on), then close it with the same code.
 * Known: in `wrangler dev` workerd logs an uncaught "Network connection lost" when the client goes
 * away after this close (stateless Worker, so nothing is lost; `waitUntil` and listeners don't
 * silence it). RoomDO avoids it by rejecting through the hibernation API.
 */
export function rejectedSocket(code: number, reason: string): Response {
  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  server.accept();
  const msg: ServerMessage = { v: PROTOCOL_VERSION, t: "rejected", code, reason };
  server.send(JSON.stringify(msg));
  server.close(code, reason);
  return new Response(null, { status: 101, webSocket: client });
}

export function hasJsonContentType(request: Request): boolean {
  return (request.headers.get("Content-Type") ?? "").toLowerCase().startsWith("application/json");
}

/**
 * Read a request body as UTF-8 text, at most `maxBytes`. Returns null when it's bigger, without
 * buffering the rest: a declared Content-Length over the cap is refused before reading, and a
 * chunked body is cut off as soon as it passes the cap.
 */
export async function readBoundedText(request: Request, maxBytes: number): Promise<string | null> {
  const declared = request.headers.get("Content-Length");
  if (declared !== null && !(Number(declared) <= maxBytes)) return null;
  if (!request.body) return "";

  const reader = (request.body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

/** JSON body within MAX_JSON_BODY_BYTES: the parsed value, null if it isn't JSON, or a 413 response. */
export async function readJson(
  request: Request,
  maxBytes: number,
): Promise<{ value: unknown } | Response> {
  const raw = await readBoundedText(request, maxBytes);
  if (raw === null)
    return apiError("payload_too_large", `Body must be at most ${maxBytes} bytes.`, 413);
  try {
    return { value: JSON.parse(raw) as unknown };
  } catch {
    return { value: null };
  }
}
