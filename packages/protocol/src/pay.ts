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

export const CHAINS = ["ethereum", "base", "robinhood"] as const;
export type ChainName = (typeof CHAINS)[number];

/** USD stablecoins (6 decimals) and ETH, the chains' own coin (18 decimals). */
export const TOKENS = ["USDC", "USDG", "ETH"] as const;
export type TokenSymbol = (typeof TOKENS)[number];

/** ETH isn't a contract: it's the chain's native coin. */
export const NATIVE = "native" as const;

export interface ChainConfig {
  name: ChainName;
  label: string;
  chainId: number;
  /** Blocks on top of the payment's block before it counts. */
  confirmations: number;
  /** Public RPCs, tried in order. */
  rpcUrls: readonly string[];
  explorer: string;
  /** ERC-20 stablecoin contracts (6 decimals, checked on-chain), and ETH as NATIVE. */
  tokens: Partial<Record<TokenSymbol, `0x${string}` | typeof NATIVE>>;
}

export const TOKEN_DECIMALS = 6;
export const ETH_DECIMALS = 18;
export const decimalsOf = (symbol: TokenSymbol): number =>
  symbol === "ETH" ? ETH_DECIMALS : TOKEN_DECIMALS;

/** Mainnet only: payments are never accepted on a testnet. */
export const CHAIN_CONFIG: Record<ChainName, ChainConfig> = {
  ethereum: {
    name: "ethereum",
    label: "Ethereum",
    chainId: 1,
    confirmations: 2,
    rpcUrls: [
      "https://ethereum-rpc.publicnode.com",
      "https://eth.drpc.org",
      "https://cloudflare-eth.com",
    ],
    explorer: "https://etherscan.io",
    tokens: { USDC: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", ETH: NATIVE },
  },
  base: {
    name: "base",
    label: "Base",
    chainId: 8453,
    confirmations: 1,
    rpcUrls: [
      "https://mainnet.base.org",
      "https://base-rpc.publicnode.com",
      "https://base.drpc.org",
    ],
    explorer: "https://basescan.org",
    tokens: { USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", ETH: NATIVE },
  },
  robinhood: {
    name: "robinhood",
    label: "Robinhood Chain",
    chainId: 4663,
    confirmations: 1,
    rpcUrls: ["https://rpc.mainnet.chain.robinhood.com"],
    explorer: "https://robinhoodchain.blockscout.com",
    tokens: { USDG: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", ETH: NATIVE },
  },
};

/** A payment counts only if it was made at most this long before it is redeemed. */
export const PAYMENT_MAX_AGE_SECONDS = 24 * 60 * 60;

// ── ETH: a quote at the market price ────────────────────────────────────────

/**
 * Chainlink ETH/USD price feeds (8 decimals), read on-chain, tried in order. ETH is the same coin on
 * every chain here, so one price serves all three.
 */
export const ETH_USD_FEEDS: readonly { chain: ChainName; address: `0x${string}` }[] = [
  { chain: "ethereum", address: "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419" },
  { chain: "base", address: "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70" },
];
export const ETH_USD_DECIMALS = 8;
/** A feed answer older than this isn't used (the feeds update at least hourly). */
export const ETH_USD_MAX_AGE_SECONDS = 2 * 60 * 60;
/** How long an ETH quote holds: the payment must be mined before it ends. */
export const QUOTE_TTL_SECONDS = 15 * 60;

/**
 * The ETH amount for a dollar price at `ethUsd` (USD per ETH, 8 decimals), in wei, rounded up to a
 * whole gwei so it never comes out a hair under the price.
 */
export function weiForUsd(usdMicros: number, ethUsd: bigint): bigint {
  if (ethUsd <= 0n) throw new Error("no ETH price");
  // wei = usd × 1e18 / (ethUsd / 1e8) = micros × 1e20 / ethUsd
  const wei = (BigInt(usdMicros) * 10n ** 20n + ethUsd - 1n) / ethUsd;
  const gwei = 10n ** 9n;
  return ((wei + gwei - 1n) / gwei) * gwei;
}

/** What `wei` is worth at `ethUsd`, in micro-dollars (rounded down). */
export function usdMicrosForWei(wei: bigint, ethUsd: bigint): number {
  const micros = (wei * ethUsd) / 10n ** 20n;
  return micros > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(micros);
}

/** "0.000217 ETH": wei shown with up to 6 decimals, rounded up. */
export function formatEth(wei: bigint): string {
  const step = 10n ** 12n; // 1e-6 ETH
  const units = (wei + step - 1n) / step;
  const whole = units / 1_000_000n;
  const frac = (units % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${whole}${frac ? `.${frac}` : ""} ETH`;
}

// ── Passes ──────────────────────────────────────────────────────────────────

/** The message a pass signs: 32 random bytes, made and kept in the browser. */
export const PASS_MESSAGE_BYTES = 32;
/** RSA modulus for pass keys (RFC 9474, RSABSSA-SHA384-PSS-Randomized). */
export const PASS_KEY_BITS = 2048;
const B64URL = /^[A-Za-z0-9_-]+$/;

const hexHash = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const hexAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const hexSignature = z
  .string()
  .regex(/^0x[0-9a-fA-F]+$/)
  .max(20_000);
const b64url = (max: number) => z.string().min(1).max(max).regex(B64URL);

/**
 * The text the paying wallet signs (EIP-191 personal_sign). It ties this redemption to the address
 * the payment came from, so a transaction hash seen on-chain can't be redeemed by someone else.
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
    `Transaction: ${r.txHash.toLowerCase()}`,
    `Quant-room: ${variantId(r.variant)}`,
    `Pass: ${r.blindedHash}`,
  ].join("\n");
}

/** POST /api/pay/redeem */
export const redeemRequestSchema = z.object({
  chain: z.enum(CHAINS),
  token: z.enum(TOKENS),
  txHash: hexHash,
  variant: variantSchema,
  keyId: b64url(64),
  /** The blinded pass message (RFC 9474 Blind), base64url. */
  blindedMsg: b64url(400),
  /** personal_sign of `redeemMessage(...)` by the address the payment came from. */
  payer: hexAddress,
  signature: hexSignature,
  /** ETH only: the quote the payment was made against (from /api/pay/quote). */
  quote: z.string().min(1).max(1000).optional(),
});
export type RedeemRequest = z.infer<typeof redeemRequestSchema>;

/** GET /api/pay/quote?chain=…&variant=…: what to send in ETH right now, signed by Poof. */
export const quoteResponseSchema = z.object({
  chain: z.enum(CHAINS),
  variant: z.string(),
  usdMicros: z.number().int().positive(),
  /** USD per ETH, 8 decimals (Chainlink), as a decimal string. */
  ethUsd: z.string().regex(/^\d+$/),
  /** The amount to send, in wei, as a decimal string. */
  wei: z.string().regex(/^\d+$/),
  /** Unix ms: the payment must be mined before this. */
  expiresAt: z.number().int(),
  /** Opaque, signed by Poof: send it back with the redemption. */
  quote: z.string().min(1).max(1000),
});
export type QuoteResponse = z.infer<typeof quoteResponseSchema>;

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
export const payConfigSchema = z.object({
  treasury: hexAddress,
  chains: z.array(
    z.object({
      name: z.enum(CHAINS),
      label: z.string(),
      chainId: z.number().int(),
      confirmations: z.number().int(),
      explorer: z.string(),
      tokens: z.array(
        z.object({
          symbol: z.enum(TOKENS),
          /** null for ETH (the chain's own coin). */
          address: hexAddress.nullable(),
          decimals: z.number().int(),
        }),
      ),
    }),
  ),
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
