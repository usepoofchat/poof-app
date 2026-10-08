import {
  CHAIN_CONFIG,
  PAYMENT_MAX_AGE_SECONDS,
  type ChainConfig,
  type ChainName,
  type TokenSymbol,
} from "@poof/protocol";
import { createPublicClient, defineChain, fallback, http, type Hex } from "viem";
import { fromBase58 } from "./base58.ts";

/**
 * Checks a payment on-chain, through public RPCs (tried in order, with fallback).
 *
 * A payment counts when the transaction succeeded, moved at least the amount due of the stablecoin
 * to Poof's address, came from the address that signed the redemption, is confirmed (EVM) or
 * finalized (Solana), and isn't too old.
 */

export type PaymentCheck =
  | { status: "pending"; confirmations: number; needed: number }
  /** `received` in micro-dollars. */
  | { status: "ok"; received: bigint }
  /** Money arrived, but not enough. Recorded, so a complaint can be checked. */
  | { status: "underpaid"; received: bigint }
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
  /** The transaction's hash (EVM) or signature (Solana). */
  txHash: string;
  /** Poof's address on this chain. */
  treasury: string;
  payer: string;
  message: string;
  signature: string;
  /** Micro-dollars. */
  required: bigint;
  now?: number;
}

const rejected = (reason: PaymentRejection): PaymentCheck => ({ status: "rejected", reason });

/** The chain reads a check needs. Real ones go through RPCs; tests pass fakes. */
export interface Readers {
  evm(chain: ChainName): EvmReader;
  solana(): SolanaReader;
}

export async function checkPayment(q: PaymentQuery, readers: Readers): Promise<PaymentCheck> {
  const chain = CHAIN_CONFIG[q.chain];
  const asset = chain.tokens[q.token];
  if (!asset) return rejected("not_a_payment");
  return chain.kind === "evm"
    ? checkEvmPayment(q, chain, asset, readers.evm(q.chain))
    : checkSolanaPayment(q, chain, asset, readers.solana());
}

// ── EVM: Ethereum, Base, Robinhood Chain ────────────────────────────────────

/** ERC-20 Transfer(address indexed from, address indexed to, uint256 value) */
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export interface EvmReader {
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

export function viemReader(chain: ChainConfig): EvmReader {
  const client = createPublicClient({
    chain: defineChain({
      id: chain.chainId ?? 0,
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
    getBlockNumber: () => client.getBlockNumber({ cacheTime: 0 }),
    async getBlockTimestamp(blockNumber) {
      return (await client.getBlock({ blockNumber })).timestamp;
    },
    verifyMessage: (address, message, signature) =>
      client.verifyMessage({ address, message, signature }),
  };
}

const topicAddress = (topic: string | undefined) =>
  topic ? `0x${topic.slice(-40)}`.toLowerCase() : "";

async function checkEvmPayment(
  q: PaymentQuery,
  chain: ChainConfig,
  token: string,
  reader: EvmReader,
): Promise<PaymentCheck> {
  const receipt = await reader.getReceipt(q.txHash as Hex);
  if (!receipt) return { status: "pending", confirmations: 0, needed: chain.confirmations };
  if (receipt.status !== "success") return rejected("not_a_payment");

  // Every Transfer of this token to Poof in the transaction, from the payer.
  const treasury = q.treasury.toLowerCase();
  const payer = q.payer.toLowerCase();
  const contract = token.toLowerCase();
  const toPoof = receipt.logs.filter(
    (log) =>
      log.address.toLowerCase() === contract &&
      log.topics[0] === TRANSFER_TOPIC &&
      topicAddress(log.topics[2]) === treasury,
  );
  if (toPoof.length === 0) return rejected("not_a_payment");
  const fromPayer = toPoof.filter((log) => topicAddress(log.topics[1]) === payer);
  if (fromPayer.length === 0) return rejected("wrong_payer");
  const received = fromPayer.reduce((sum, log) => sum + BigInt(log.data), 0n);

  if (!(await reader.verifyMessage(q.payer as Hex, q.message, q.signature as Hex))) {
    return rejected("bad_signature");
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
    return rejected("too_old");
  }
  return received >= q.required ? { status: "ok", received } : { status: "underpaid", received };
}

// ── Solana ──────────────────────────────────────────────────────────────────

/** A token account's balance, by the wallet that owns it and the token (mint). */
export interface TokenBalance {
  owner: string;
  mint: string;
  amount: bigint;
}

export interface SolanaTransaction {
  failed: boolean;
  /** Unix seconds, when its block was made. */
  blockTime: number | null;
  /** The addresses that signed it. */
  signers: readonly string[];
  /** Every token account the transaction touched, before and after it. */
  before: readonly TokenBalance[];
  after: readonly TokenBalance[];
}

export interface SolanaReader {
  /** The transaction, once finalized; null before that (or if it doesn't exist). */
  getTransaction(signature: string): Promise<SolanaTransaction | null>;
  /** How far along a transaction is; null if the cluster hasn't seen it. */
  getStatus(signature: string): Promise<{ confirmations: number; failed: boolean } | null>;
  /** ed25519 over the message's UTF-8 bytes, by the address's key. */
  verifyMessage(address: string, message: string, signature: string): Promise<boolean>;
}

interface RpcTokenBalance {
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string };
}
interface RpcTransaction {
  blockTime: number | null;
  meta: {
    err: unknown;
    preTokenBalances?: RpcTokenBalance[];
    postTokenBalances?: RpcTokenBalance[];
  } | null;
  transaction: { message: { accountKeys: { pubkey: string; signer: boolean }[] } };
}
interface RpcSignatureStatus {
  confirmations: number | null;
  err: unknown;
}

/**
 * One JSON-RPC call, through the first RPC that answers. Public Solana RPCs refuse Workers' shared
 * addresses now and then, so every RPC gets a few rounds.
 */
async function jsonRpc<T>(urls: readonly string[], method: string, params: unknown[]): Promise<T> {
  let failure: unknown = new Error("no RPC");
  for (let round = 0; round < 3; round++) {
    if (round > 0) await new Promise((resolve) => setTimeout(resolve, 400 * round));
    for (const url of urls) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
          signal: AbortSignal.timeout(8_000),
        });
        if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
        const body = await res.json<{ result?: T; error?: { message?: string } }>();
        if (body.error) throw new Error(body.error.message ?? "RPC error");
        return body.result as T;
      } catch (error) {
        failure = error;
      }
    }
  }
  throw failure;
}

export function solanaReader(chain: ChainConfig): SolanaReader {
  const balances = (list: RpcTokenBalance[] | undefined): TokenBalance[] =>
    (list ?? []).flatMap((b) =>
      b.owner ? [{ owner: b.owner, mint: b.mint, amount: BigInt(b.uiTokenAmount.amount) }] : [],
    );
  return {
    async getTransaction(signature) {
      const tx = await jsonRpc<RpcTransaction | null>(chain.rpcUrls, "getTransaction", [
        signature,
        { encoding: "jsonParsed", commitment: "finalized", maxSupportedTransactionVersion: 255 },
      ]);
      if (!tx) return null;
      return {
        failed: tx.meta === null || tx.meta.err !== null,
        blockTime: tx.blockTime,
        signers: tx.transaction.message.accountKeys.filter((k) => k.signer).map((k) => k.pubkey),
        before: balances(tx.meta?.preTokenBalances),
        after: balances(tx.meta?.postTokenBalances),
      };
    },
    async getStatus(signature) {
      const out = await jsonRpc<{ value: (RpcSignatureStatus | null)[] }>(
        chain.rpcUrls,
        "getSignatureStatuses",
        [[signature], { searchTransactionHistory: true }],
      );
      const s = out.value[0];
      if (!s) return null;
      return { confirmations: s.confirmations ?? chain.confirmations, failed: s.err !== null };
    },
    verifyMessage: verifySolanaMessage,
  };
}

/** ed25519 (as every Solana wallet signs messages): raw bytes, no prefix. */
export async function verifySolanaMessage(
  address: string,
  message: string,
  signature: string,
): Promise<boolean> {
  try {
    const publicKey = fromBase58(address);
    const sig = fromBase58(signature);
    if (publicKey.length !== 32 || sig.length !== 64) return false;
    const key = await crypto.subtle.importKey("raw", publicKey, { name: "Ed25519" }, false, [
      "verify",
    ]);
    return await crypto.subtle.verify("Ed25519", key, sig, new TextEncoder().encode(message));
  } catch {
    return false;
  }
}

async function checkSolanaPayment(
  q: PaymentQuery,
  chain: ChainConfig,
  mint: string,
  reader: SolanaReader,
): Promise<PaymentCheck> {
  const tx = await reader.getTransaction(q.txHash);
  if (!tx) {
    const status = await reader.getStatus(q.txHash);
    if (status?.failed) return rejected("not_a_payment");
    return {
      status: "pending",
      confirmations: Math.min(status?.confirmations ?? 0, chain.confirmations - 1),
      needed: chain.confirmations,
    };
  }
  if (tx.failed) return rejected("not_a_payment");

  // What Poof's token accounts gained, and what the payer's lost: the payment is the smaller.
  const total = (list: readonly TokenBalance[], owner: string) =>
    list.filter((b) => b.owner === owner && b.mint === mint).reduce((sum, b) => sum + b.amount, 0n);
  const received = total(tx.after, q.treasury) - total(tx.before, q.treasury);
  if (received <= 0n) return rejected("not_a_payment");
  const sent = total(tx.before, q.payer) - total(tx.after, q.payer);
  if (!tx.signers.includes(q.payer) || sent <= 0n) return rejected("wrong_payer");

  if (!(await reader.verifyMessage(q.payer, q.message, q.signature))) {
    return rejected("bad_signature");
  }

  if (
    tx.blockTime === null ||
    (q.now ?? Date.now()) - tx.blockTime * 1000 > PAYMENT_MAX_AGE_SECONDS * 1000
  ) {
    return rejected("too_old");
  }
  const paid = sent < received ? sent : received;
  return paid >= q.required
    ? { status: "ok", received: paid }
    : { status: "underpaid", received: paid };
}
