import { z } from "zod";
import { MAX_ROOM_PEERS } from "./constants.ts";

/**
 * Super Quant-Rooms are paid in USD stablecoins sent to Poof's address. The prices and lifetimes
 * are the ones on https://usepoof.chat (room/index.html, `PRICE` and `AI_PRICE`): the site is the
 * source of truth, and `pnpm check:prices` compares the two.
 *
 * Amounts are integers in micro-dollars (6 decimals), the unit every accepted token uses.
 */

// ── Variants ────────────────────────────────────────────────────────────────

/** The Super lifetimes, in seconds: the "60m" and "24h" tiers. */
export const SUPER_LIFETIMES = [3600, 86400] as const;
export type SuperLifetime = (typeof SUPER_LIFETIMES)[number];

/** What a pass buys: a lifetime, a number of people and (later) the AI model. */
export interface Variant {
  lifetime: SuperLifetime;
  people: number;
  ai: boolean;
}

/** Passes with the AI model can be bought. */
export const AI_AVAILABLE = true;

/** Fewest people: two, or just you with the AI model. */
export const minPeople = (ai: boolean): number => (ai ? 1 : 2);

/** Canonical text form, used as the pass key id and in messages: "3600-4", "86400-10-ai". */
export function variantId(v: Variant): string {
  return `${v.lifetime}-${v.people}${v.ai ? "-ai" : ""}`;
}

export function parseVariantId(id: string): Variant | null {
  const m = /^(3600|86400)-(\d{1,2})(-ai)?$/.exec(id);
  if (!m) return null;
  const v: Variant = {
    lifetime: Number(m[1]) as SuperLifetime,
    people: Number(m[2]),
    ai: m[3] !== undefined,
  };
  return isValidVariant(v) ? v : null;
}

export function isValidVariant(v: Variant): boolean {
  return (
    SUPER_LIFETIMES.includes(v.lifetime) &&
    Number.isInteger(v.people) &&
    v.people >= minPeople(v.ai) &&
    v.people <= MAX_ROOM_PEERS &&
    (!v.ai || AI_AVAILABLE)
  );
}

/** Every variant that can be bought now. */
export function purchasableVariants(): Variant[] {
  const out: Variant[] = [];
  for (const lifetime of SUPER_LIFETIMES) {
    for (const ai of AI_AVAILABLE ? [false, true] : [false]) {
      for (let people = minPeople(ai); people <= MAX_ROOM_PEERS; people++)
        out.push({ lifetime, people, ai });
    }
  }
  return out;
}

export const variantSchema = z
  .object({
    lifetime: z.union([z.literal(SUPER_LIFETIMES[0]), z.literal(SUPER_LIFETIMES[1])]),
    people: z.number().int(),
    ai: z.boolean(),
  })
  .refine(isValidVariant, "not a variant that can be bought");

// ── Prices (micro-dollars) ──────────────────────────────────────────────────

/** room/index.html: PRICE = {3600: {base: 0.49, extra: 0.049}, 86400: {base: 1.49, extra: 0.009}} */
export const PRICE_MICROS: Record<SuperLifetime, { base: number; extraPerson: number }> = {
  3600: { base: 490_000, extraPerson: 49_000 },
  86400: { base: 1_490_000, extraPerson: 9_000 },
};
/** room/index.html: AI_PRICE = {3600: 2, 86400: 5} */
export const AI_PRICE_MICROS: Record<SuperLifetime, number> = { 3600: 2_000_000, 86400: 5_000_000 };

/** Same formula as the site: base + (people - 2) × extra + AI. */
export function priceMicros(v: Variant): number {
  const p = PRICE_MICROS[v.lifetime];
  return (
    p.base + Math.max(0, v.people - 2) * p.extraPerson + (v.ai ? AI_PRICE_MICROS[v.lifetime] : 0)
  );
}

/** "$0.588", "$1.49": the site's format (three decimals, one trailing zero dropped). */
export function formatUsd(micros: number): string {
  let s = (micros / 1_000_000).toFixed(3);
  if (s.endsWith("0")) s = s.slice(0, -1);
  return `$${s}`;
}

// ── Networks and tokens ─────────────────────────────────────────────────────

export const CHAINS = ["ethereum", "base", "robinhood", "solana"] as const;
export type ChainName = (typeof CHAINS)[number];

/** USD stablecoins, 6 decimals on every chain: one unit is one micro-dollar. */
export const TOKENS = ["USDC", "USDG"] as const;
export type TokenSymbol = (typeof TOKENS)[number];
export const TOKEN_DECIMALS = 6;

/** How a chain works: EVM (Ethereum and its kin, 0x… addresses) or Solana (base58 addresses). */
export const CHAIN_KINDS = ["evm", "solana"] as const;
export type ChainKind = (typeof CHAIN_KINDS)[number];

export interface ChainConfig {
  name: ChainName;
  kind: ChainKind;
  label: string;
  /** EIP-155 chain id; null on Solana. */
  chainId: number | null;
  /**
   * EVM: blocks on top of the payment's block before it counts. Solana: the payment must be
   * finalized, which takes about this many slots (around 15 seconds).
   */
  confirmations: number;
  /** Public RPCs the server reads through, tried in order. */
  rpcUrls: readonly string[];
  explorer: string;
  /** Stablecoin contracts (EVM, 0x…) or mints (Solana, base58), 6 decimals, checked on-chain. */
  tokens: Partial<Record<TokenSymbol, string>>;
}

/** Mainnet only: payments are never accepted on a testnet. */
export const CHAIN_CONFIG: Record<ChainName, ChainConfig> = {
  ethereum: {
    name: "ethereum",
    kind: "evm",
    label: "Ethereum",
    chainId: 1,
    confirmations: 2,
    rpcUrls: [
      "https://ethereum-rpc.publicnode.com",
      "https://eth.drpc.org",
      "https://cloudflare-eth.com",
    ],
    explorer: "https://etherscan.io",
    tokens: { USDC: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" },
  },
  base: {
    name: "base",
    kind: "evm",
    label: "Base",
    chainId: 8453,
    confirmations: 1,
    rpcUrls: [
      "https://mainnet.base.org",
      "https://base-rpc.publicnode.com",
      "https://base.drpc.org",
    ],
    explorer: "https://basescan.org",
    tokens: { USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
  },
  robinhood: {
    name: "robinhood",
    kind: "evm",
    label: "Robinhood Chain",
    chainId: 4663,
    confirmations: 1,
    rpcUrls: ["https://rpc.mainnet.chain.robinhood.com"],
    explorer: "https://robinhoodchain.blockscout.com",
    tokens: { USDG: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" },
  },
  solana: {
    name: "solana",
    kind: "solana",
    label: "Solana",
    chainId: null,
    confirmations: 32,
    rpcUrls: ["https://solana-rpc.publicnode.com", "https://api.mainnet-beta.solana.com"],
    explorer: "https://solscan.io",
    tokens: { USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" },
  },
};

/** A payment counts only if it was made at most this long before it is redeemed. */
export const PAYMENT_MAX_AGE_SECONDS = 24 * 60 * 60;

// ── Ids on each kind of chain ───────────────────────────────────────────────

/** 0x and 40 hex digits: an EVM address. */
export const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
/** 0x and 64 hex digits: an EVM transaction hash. */
export const EVM_TX_HASH = /^0x[0-9a-fA-F]{64}$/;
const EVM_SIGNATURE = /^0x[0-9a-fA-F]+$/;
/** base58 of 32 bytes: a Solana address. */
export const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
/** base58 of 64 bytes: a Solana transaction signature (its id), or an ed25519 signature. */
export const SOLANA_SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;

/** Do the transaction id, the payer and the wallet signature have the chain's own formats? */
export function paymentIdsFit(r: {
  chain: ChainName;
  txHash: string;
  payer: string;
  signature: string;
}): boolean {
  return CHAIN_CONFIG[r.chain].kind === "evm"
    ? EVM_TX_HASH.test(r.txHash) && EVM_ADDRESS.test(r.payer) && EVM_SIGNATURE.test(r.signature)
    : SOLANA_SIGNATURE.test(r.txHash) &&
        SOLANA_ADDRESS.test(r.payer) &&
        SOLANA_SIGNATURE.test(r.signature);
}

/**
 * The transaction id as it goes into messages and the ledger: EVM hashes in lower case, Solana
 * signatures as they are (base58 is case-sensitive).
 */
export function canonicalTxId(chain: ChainName, txHash: string): string {
  return CHAIN_CONFIG[chain].kind === "evm" ? txHash.toLowerCase() : txHash;
}

// ── Passes ──────────────────────────────────────────────────────────────────

/** The message a pass signs: 32 random bytes, made and kept in the browser. */
export const PASS_MESSAGE_BYTES = 32;
/** RSA modulus for pass keys (RFC 9474, RSABSSA-SHA384-PSS-Randomized). */
export const PASS_KEY_BITS = 2048;
const B64URL = /^[A-Za-z0-9_-]+$/;

const b64url = (max: number) => z.string().min(1).max(max).regex(B64URL);

/**
 * The text the paying wallet signs (EVM: EIP-191 personal_sign; Solana: ed25519 over the UTF-8
 * bytes). It ties this redemption to the address the payment came from, so a transaction seen
 * on-chain can't be redeemed by someone else.
 */
export function redeemMessage(r: {
  chain: ChainName;
  txHash: string;
  variant: Variant;
  blindedHash: string;
}): string {
  return [
    "Poof: unlock a Super Quant-Room",
    `Chain: ${r.chain}`,
    `Transaction: ${canonicalTxId(r.chain, r.txHash)}`,
    `Quant-room: ${variantId(r.variant)}`,
    `Pass: ${r.blindedHash}`,
  ].join("\n");
}

/** POST /api/pay/redeem */
export const redeemRequestSchema = z
  .object({
    chain: z.enum(CHAINS),
    token: z.enum(TOKENS),
    /** The transaction: its hash (EVM) or its signature (Solana). */
    txHash: z.string().min(1).max(100),
    variant: variantSchema,
    keyId: b64url(64),
    /** The blinded pass message (RFC 9474 Blind), base64url. */
    blindedMsg: b64url(400),
    /** The address the payment came from, which signed `redeemMessage(...)`. */
    payer: z.string().min(1).max(64),
    /** EVM: the personal_sign signature (hex). Solana: the ed25519 signature (base58). */
    signature: z.string().min(1).max(20_000),
  })
  .refine(paymentIdsFit, "the ids don't fit the chain");
export type RedeemRequest = z.infer<typeof redeemRequestSchema>;

export const redeemResponseSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("pending"),
    confirmations: z.number().int().nonnegative(),
    needed: z.number().int(),
  }),
  z.object({ status: z.literal("ok"), blindSignature: b64url(400) }),
]);
export type RedeemResponse = z.infer<typeof redeemResponseSchema>;

/** GET /api/pay/config: where to pay, what, and the pass key for every variant. */
export const payKeySchema = z.object({
  variant: z.string(),
  keyId: b64url(64),
  spki: b64url(1200),
});
const chainAddress = z.string().min(1).max(64);
export const payChainSchema = z
  .object({
    name: z.enum(CHAINS),
    kind: z.enum(CHAIN_KINDS),
    label: z.string(),
    /** EIP-155 chain id; null on Solana. */
    chainId: z.number().int().nullable(),
    confirmations: z.number().int(),
    explorer: z.string(),
    /** Poof's address on this chain: where to pay. */
    treasury: chainAddress,
    tokens: z.array(
      z.object({
        symbol: z.enum(TOKENS),
        /** The stablecoin's contract (EVM) or mint (Solana). */
        address: chainAddress,
        decimals: z.number().int(),
      }),
    ),
  })
  .refine((c) => {
    const fits = c.kind === "evm" ? EVM_ADDRESS : SOLANA_ADDRESS;
    return fits.test(c.treasury) && c.tokens.every((t) => fits.test(t.address));
  }, "the addresses don't fit the chain");
export type PayChain = z.infer<typeof payChainSchema>;
export const payConfigSchema = z.object({
  chains: z.array(payChainSchema),
  keys: z.array(payKeySchema),
});
export type PayConfig = z.infer<typeof payConfigSchema>;

/** A finished pass: what the browser keeps until it is spent. */
export const passSchema = z.object({
  variant: variantSchema,
  keyId: b64url(64),
  /** The pass message (prepared per RFC 9474), base64url. */
  msg: b64url(200),
  signature: b64url(400),
});
export type Pass = z.infer<typeof passSchema>;
