// Secrets are set with `wrangler secret put` (never in wrangler.jsonc), so `wrangler types`
// can't see them. Declare them here by merging into the generated global Env.
// This file must stay a script (no import/export) so the declaration is global.
interface Env {
  /** Cloudflare TURN key id. Optional: without it we fall back to STUN only (direct connections). */
  TURN_KEY_ID?: string;
  /** Cloudflare TURN API token. */
  TURN_API_TOKEN?: string;
  /**
   * 32+ random bytes, base64url. Seals the pass signing keys stored in D1. Without it (or without
   * PAY_TREASURY) Super Quant-Rooms can't be bought.
   */
  PASS_MASTER_KEY?: string;
  /** The AI provider's API key. Without it, AI requests answer ai_unavailable. */
  VENICE_API_KEY?: string;
}
