import {
  CHAIN_CONFIG,
  PAYMENT_MAX_AGE_SECONDS,
  type ChainConfig,
  type ChainName,
  type TokenSymbol,
} from "@poof/protocol";
import { createPublicClient, defineChain, fallback, http, type Hex } from "viem";

/**
 * Checks a stablecoin payment on-chain, through public RPCs (tried in order, with fallback).
 *
 * A payment counts when the transaction succeeded, sent at least the price in an accepted token to
 * Poof's address, came from the address that signed the redemption, has enough confirmations and
 * isn't older than PAYMENT_MAX_AGE_SECONDS.
 */

/** ERC-20 Transfer(address indexed from, address indexed to, uint256 value) */
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/** The few chain reads a check needs. Real ones go through viem; tests pass a fake. */
export interface ChainReader {
  /** null if the transaction isn't mined (or doesn't exist). */
  getReceipt(hash: Hex): Promise<{
    status: "success" | "reverted";
    blockNumber: bigint;
    logs: readonly { address: string; topics: readonly string[]; data: string }[];
  } | null>;
  getBlockNumber(): Promise<bigint>;
  getBlockTimestamp(blockNumber: bigint): Promise<bigint>;
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
  return {
    async getReceipt(hash) {
      try {
        const r = await client.getTransactionReceipt({ hash });
        return { status: r.status, blockNumber: r.blockNumber, logs: r.logs };
      } catch (error) {
        if (error instanceof Error && error.name === "TransactionReceiptNotFoundError") return null;
        throw error;
      }
    },
    getBlockNumber: () => client.getBlockNumber({ cacheTime: 0 }),
    async getBlockTimestamp(blockNumber) {
      return (await client.getBlock({ blockNumber })).timestamp;
    },
    verifyMessage: (address, message, signature) =>
      client.verifyMessage({ address, message, signature }),
  };
}

export type PaymentCheck =
  | { status: "pending"; confirmations: number; needed: number }
  | { status: "ok"; receivedMicros: number }
  /** Money arrived, but not enough. Recorded, so a complaint can be checked. */
  | { status: "underpaid"; receivedMicros: number }
  | { status: "rejected"; reason: PaymentRejection };

export type PaymentRejection =
  /** Not a successful transfer of this token to Poof's address. */
  | "not_a_payment"
  /** The transfer came from another address than the one that signed. */
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
  requiredMicros: number;
  now?: number;
}

const topicAddress = (topic: string | undefined) =>
  topic ? `0x${topic.slice(-40)}`.toLowerCase() : "";

export async function checkPayment(q: PaymentQuery, reader: ChainReader): Promise<PaymentCheck> {
  const chain = CHAIN_CONFIG[q.chain];
  const token = chain.tokens[q.token]?.toLowerCase();
  if (!token) return { status: "rejected", reason: "not_a_payment" };

  const receipt = await reader.getReceipt(q.txHash);
  if (!receipt) return { status: "pending", confirmations: 0, needed: chain.confirmations };
  if (receipt.status !== "success") return { status: "rejected", reason: "not_a_payment" };

  // Every Transfer of this token to Poof in the transaction, and who sent it.
  const treasury = q.treasury.toLowerCase();
  const toPoof = receipt.logs.filter(
    (log) =>
      log.address.toLowerCase() === token &&
      log.topics[0] === TRANSFER_TOPIC &&
      topicAddress(log.topics[2]) === treasury,
  );
  if (toPoof.length === 0) return { status: "rejected", reason: "not_a_payment" };
  const payer = q.payer.toLowerCase();
  const fromPayer = toPoof.filter((log) => topicAddress(log.topics[1]) === payer);
  if (fromPayer.length === 0) return { status: "rejected", reason: "wrong_payer" };

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
  if ((q.now ?? Date.now()) - minedAt > PAYMENT_MAX_AGE_SECONDS * 1000)
    return { status: "rejected", reason: "too_old" };

  const received = fromPayer.reduce((sum, log) => sum + BigInt(log.data), 0n);
  // 6-decimal tokens: units are micro-dollars. Cap absurd values instead of overflowing a number.
  const receivedMicros =
    received > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(received);
  return receivedMicros >= q.requiredMicros
    ? { status: "ok", receivedMicros }
    : { status: "underpaid", receivedMicros };
}
