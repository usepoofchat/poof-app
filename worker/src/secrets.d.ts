// Secrets are set with `wrangler secret put` (never in wrangler.jsonc), so `wrangler types`
// can't see them. Declare them here by merging into the generated global Env.
// This file must stay a script (no import/export) so the declaration is global.
interface Env {
  /** Cloudflare TURN key id. Optional: without it we fall back to STUN only (direct connections). */
  TURN_KEY_ID?: string;
  /** Cloudflare TURN API token. */
  TURN_API_TOKEN?: string;
}
