import { MAX_ICE_SERVERS, iceServerSchema, type IceServer } from "@poof/protocol";
import { z } from "zod";

/**
 * Credentials are minted when two peers are paired (never from a public endpoint) and live as long
 * as the room has left, so nobody holds a working relay credential after the room is gone.
 */
export const MIN_TURN_CREDENTIAL_TTL_SECONDS = 60;
export const MAX_TURN_CREDENTIAL_TTL_SECONDS = 86_400;

/** Credential lifetime for a room that ends at `expiresAt` (ms). */
export function turnCredentialTtl(expiresAt: number, now = Date.now()): number {
  const left = Math.ceil((expiresAt - now) / 1000);
  return Math.min(MAX_TURN_CREDENTIAL_TTL_SECONDS, Math.max(MIN_TURN_CREDENTIAL_TTL_SECONDS, left));
}

/** Same provider as TURN, so no extra third party. STUN only → direct connections (no relay). */
const FALLBACK_ICE_SERVERS: IceServer[] = [{ urls: "stun:stun.cloudflare.com:3478" }];

/** Loose on purpose: the API's shape is checked here, our own caps after filtering. */
const responseSchema = z.object({
  iceServers: z.array(
    z.object({
      urls: z.union([z.string(), z.array(z.string())]),
      username: z.string().optional(),
      credential: z.string().optional(),
    }),
  ),
});

/**
 * Keep STUN and TURN over TLS (`turns:`) only: relayed traffic always runs inside TLS, so the relay
 * path never shows up as plain UDP/TCP TURN. Also drop the alternate port-53 URLs: browsers warn
 * about them and they are mostly blocked anyway.
 */
function filterUrls(servers: IceServer[]): IceServer[] {
  const out: IceServer[] = [];
  for (const server of servers) {
    const urls = (Array.isArray(server.urls) ? server.urls : [server.urls]).filter(
      (u) => (u.startsWith("stun:") || u.startsWith("turns:")) && !/:53(\?|$)/.test(u),
    );
    if (urls.length > 0) out.push({ ...server, urls });
  }
  return out;
}

/**
 * Mint ICE servers for a pairing. Never throws: on any failure (not configured, API error, timeout,
 * bad response) it degrades to STUN only, so rooms still work on networks that allow direct paths.
 */
export async function mintIceServers(
  env: Pick<Env, "TURN_KEY_ID" | "TURN_API_TOKEN">,
  ttlSeconds: number,
  fetcher: typeof fetch = fetch,
): Promise<IceServer[]> {
  const { TURN_KEY_ID: keyId, TURN_API_TOKEN: token } = env;
  if (!keyId || !token) return FALLBACK_ICE_SERVERS;

  try {
    const res = await fetcher(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ ttl: ttlSeconds }),
        signal: AbortSignal.timeout(3000),
      },
    );
    if (!res.ok) return FALLBACK_ICE_SERVERS;
    const parsed = responseSchema.safeParse(await res.json());
    if (!parsed.success) return FALLBACK_ICE_SERVERS;
    // What clients accept (`paired` schema): anything over the caps would make them drop the message.
    const servers = z
      .array(iceServerSchema)
      .max(MAX_ICE_SERVERS)
      .safeParse(filterUrls(parsed.data.iceServers));
    return servers.success && servers.data.length > 0 ? servers.data : FALLBACK_ICE_SERVERS;
  } catch {
    return FALLBACK_ICE_SERVERS;
  }
}
