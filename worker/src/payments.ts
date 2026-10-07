import {
  CHAIN_CONFIG,
  ETH_USD_FEEDS,
  ETH_USD_MAX_AGE_SECONDS,
  NATIVE,
  PAYMENT_MAX_AGE_SECONDS,
  type ChainConfig,
  type ChainName,
  type TokenSymbol,
} from "@poof/protocol";
import { createPublicClient, defineChain, fallback, http, type Hex } from "viem";

/**
 * Checks a payment on-chain, through public RPCs (tried in order, with fallback).
 *
 * A payment counts when the transaction succeeded, sent at least the amount due to Poof's address
 * (a stablecoin transfer, or ETH as the transaction's own value), came from the address that
 * signed the redemption, has enough confirmations, and isn't too old.
 */

/** ERC-20 Transfer(address indexed from, address indexed to, uint256 value) */
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
/** AggregatorV3Interface.latestRoundData() */
const LATEST_ROUND_DATA = "0xfeaf968c";

/** The few chain reads a check needs. Real ones go through viem; tests pass a fake. */
export interface ChainReader {
  /** null if the transaction isn't mined (or doesn't exist). */
  getReceipt(hash: Hex): Promise<{
    status: "success" | "reverted";
    blockNumber: bigint;
    logs: readonly { address: string; topics: readonly string[]; data: string }[];
  } | null>;
  /** The transaction itself (for ETH: who sent how much to whom). */
  getTransaction(hash: Hex): Promise<{ from: string; to: string | null; value: bigint } | null>;
  getBlockNumber(): Promise<bigint>;
  getBlockTimestamp(blockNumber: bigint): Promise<bigint>;
  /** eth_call, for reading the ETH/USD price feed. */
  call(to: Hex, data: Hex): Promise<Hex>;
  /** EIP-191 signature check for EOAs and smart wallets (ERC-1271 / ERC-6492). */
  verifyMessage(address: Hex, message: string, signature: Hex): Promise<boolean>;
}

export function viemReader(chain: ChainConfig): ChainReader {
  const client = createPublicClient({
    chain: defineChain({
      id: chain.chainId,
      name: chain.label,
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [...chain.rpcUrls] } },
    }),
    transport: fallback(chain.rpcUrls.map((url) => http(url, { timeout: 8_000, retryCount: 1 }))),
  });
  const notFound = (error: unknown) => error instanceof Error && /NotFoundError$/.test(error.name);
  return {
    async getReceipt(hash) {
      try {
        const r = await client.getTransactionReceipt({ hash });
        return { status: r.status, blockNumber: r.blockNumber, logs: r.logs };
      } catch (error) {
        if (notFound(error)) return null;
        throw error;
      }
    },
    async getTransaction(hash) {
      try {
        const tx = await client.getTransaction({ hash });
        return { from: tx.from, to: tx.to, value: tx.value };
      } catch (error) {
        if (notFound(error)) return null;
        throw error;
      }
    },
    getBlockNumber: () => client.getBlockNumber({ cacheTime: 0 }),
    async getBlockTimestamp(blockNumber) {
      return (await client.getBlock({ blockNumber })).timestamp;
    },
    async call(to, data) {
      return (await client.call({ to, data })).data ?? "0x";
    },
    verifyMessage: (address, message, signature) =>
      client.verifyMessage({ address, message, signature }),
  };
}

/**
 * ETH/USD from the first Chainlink feed that answers with a fresh, positive price
 * (8 decimals). Throws if none does.
 */
export async function readEthUsd(
  readerFor: (chain: ChainName) => ChainReader,
  now = Date.now(),
): Promise<bigint> {
  for (const feed of ETH_USD_FEEDS) {
    try {
      const out = await readerFor(feed.chain).call(feed.address, LATEST_ROUND_DATA);
      const hex = out.slice(2);
      if (hex.length < 64 * 5) continue;
      const word = (i: number) => BigInt(`0x${hex.slice(i * 64, (i + 1) * 64)}`);
      const answer = BigInt.asIntN(256, word(1));
      const updatedAt = Number(word(3));
      if (answer > 0n && now / 1000 - updatedAt <= ETH_USD_MAX_AGE_SECONDS) return answer;
    } catch {
      // try the next feed
    }
  }
  throw new Error("no ETH price available");
}

export type PaymentCheck =
  | { status: "pending"; confirmations: number; needed: number }
  /** `received` in the asset's own units (micro-dollars for stablecoins, wei for ETH). */
  | { status: "ok"; received: bigint }
  /** Money arrived, but not enough. Recorded, so a complaint can be checked. */
  | { status: "underpaid"; received: bigint }
  /** ETH that arrived after its quote ran out. Recorded too. */
  | { status: "late"; received: bigint }
  | { status: "rejected"; reason: PaymentRejection };

export type PaymentRejection =
  /** Not a successful payment of this asset to Poof's address. */
  | "not_a_payment"
  /** The payment came from another address than the one that signed. */
  | "wrong_payer"
  | "bad_signature"
  | "too_old";

export interface PaymentQuery {
  chain: ChainName;
  token: TokenSymbol;
  txHash: Hex;
  treasury: Hex;
  payer: Hex;
  message: string;
  signature: Hex;
  /** In the asset's own units (micro-dollars, or wei for ETH). */
  required: bigint;
  /** ETH: the quote's end (unix ms); the payment must be mined before it. */
  minedBefore?: number;
  now?: number;
}

const topicAddress = (topic: string | undefined) =>
  topic ? `0x${topic.slice(-40)}`.toLowerCase() : "";

export async function checkPayment(q: PaymentQuery, reader: ChainReader): Promise<PaymentCheck> {
  const chain = CHAIN_CONFIG[q.chain];
  const asset = chain.tokens[q.token];
  if (!asset) return { status: "rejected", reason: "not_a_payment" };

  const receipt = await reader.getReceipt(q.txHash);
  if (!receipt) return { status: "pending", confirmations: 0, needed: chain.confirmations };
  if (receipt.status !== "success") return { status: "rejected", reason: "not_a_payment" };

  const treasury = q.treasury.toLowerCase();
  const payer = q.payer.toLowerCase();
  let received: bigint;
  if (asset === NATIVE) {
    // ETH: the transaction's own value, sent straight to Poof.
    const tx = await reader.getTransaction(q.txHash);
    if (!tx || tx.to?.toLowerCase() !== treasury || tx.value <= 0n) {
      return { status: "rejected", reason: "not_a_payment" };
    }
    if (tx.from.toLowerCase() !== payer) return { status: "rejected", reason: "wrong_payer" };
    received = tx.value;
  } else {
    // A stablecoin: every Transfer of this token to Poof in the transaction, from the payer.
    const token = asset.toLowerCase();
    const toPoof = receipt.logs.filter(
      (log) =>
        log.address.toLowerCase() === token &&
        log.topics[0] === TRANSFER_TOPIC &&
        topicAddress(log.topics[2]) === treasury,
    );
    if (toPoof.length === 0) return { status: "rejected", reason: "not_a_payment" };
    const fromPayer = toPoof.filter((log) => topicAddress(log.topics[1]) === payer);
    if (fromPayer.length === 0) return { status: "rejected", reason: "wrong_payer" };
    received = fromPayer.reduce((sum, log) => sum + BigInt(log.data), 0n);
  }

  if (!(await reader.verifyMessage(q.payer, q.message, q.signature))) {
    return { status: "rejected", reason: "bad_signature" };
  }

  const head = await reader.getBlockNumber();
  const confirmations = Number(head - receipt.blockNumber + 1n);
  if (confirmations < chain.confirmations) {
    return {
      status: "pending",
      confirmations: Math.max(0, confirmations),
      needed: chain.confirmations,
    };
  }

  const minedAt = Number(await reader.getBlockTimestamp(receipt.blockNumber)) * 1000;
  if ((q.now ?? Date.now()) - minedAt > PAYMENT_MAX_AGE_SECONDS * 1000) {
    return { status: "rejected", reason: "too_old" };
  }
  if (q.minedBefore !== undefined && minedAt > q.minedBefore) return { status: "late", received };

  return received >= q.required ? { status: "ok", received } : { status: "underpaid", received };
}
