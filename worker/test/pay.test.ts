import { RSABSSA } from "@cloudflare/blindrsa-ts";
import { env } from "cloudflare:workers";
import {
  CHAIN_CONFIG,
  priceMicros,
  redeemMessage,
  variantId,
  type ChainName,
  type Pass,
  type PayConfig,
  type ServerMessage,
  type TokenSymbol,
  type Variant,
} from "@poof/protocol";
import { pad, toHex, verifyMessage, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index.ts";
import { fromBase58, toBase58 } from "../src/base58.ts";
import { setChainReadersForTests } from "../src/pay.ts";
import {
  verifySolanaMessage,
  type EvmReader,
  type SolanaReader,
  type SolanaTransaction,
} from "../src/payments.ts";
import { fromBase64Url, toBase64Url } from "../src/util.ts";
import { TestSocket, newOwner, peer, totalOf } from "./helpers.ts";

const SITE = "https://usepoof.chat";
const TREASURY = env.PAY_TREASURY as Hex;
const SOLANA_TREASURY = env.PAY_TREASURY_SOLANA as string;
const USDC_ON_SOLANA = CHAIN_CONFIG.solana.tokens.USDC!;
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const V4: Variant = { lifetime: 3600, people: 4, ai: false };
const suite = () => RSABSSA.SHA384.PSS.Randomized();

// ── Fake chains: transactions we "mine", real wallet signatures ───────────────

interface FakeTx {
  chain: ChainName;
  status?: "success" | "reverted";
  blockNumber: bigint;
  minedAt: number;
  logs: { address: string; topics: string[]; data: string }[];
}

/** An EVM chain (Base by default). */
class FakeChain {
  txs = new Map<string, FakeTx>();
  head = 1000n;
  down = false;

  reader = (): EvmReader => ({
    getReceipt: async (hash) => {
      if (this.down) throw new Error("rpc down");
      const tx = this.txs.get(hash.toLowerCase());
      return tx
        ? { status: tx.status ?? "success", blockNumber: tx.blockNumber, logs: tx.logs }
        : null;
    },
    getBlockNumber: async () => this.head,
    getBlockTimestamp: async (n) => {
      const tx = [...this.txs.values()].find((t) => t.blockNumber === n);
      return BigInt(Math.floor((tx?.minedAt ?? Date.now()) / 1000));
    },
    verifyMessage: (address, message, signature) => verifyMessage({ address, message, signature }),
  });

  /** A stablecoin transfer from `from` to `to`, mined in a block `confirmations` deep. */
  pay(opts: {
    from: Hex;
    micros: number;
    chain?: ChainName;
    token?: TokenSymbol;
    to?: Hex;
    confirmations?: number;
    ageMs?: number;
  }): Hex {
    const chain = opts.chain ?? "base";
    const tokenAddress =
      CHAIN_CONFIG[chain].tokens[opts.token ?? "USDC"] ??
      "0x0000000000000000000000000000000000000001";
    const hash = toHex(crypto.getRandomValues(new Uint8Array(32)));
    this.head += 10n; // every payment in its own block
    this.txs.set(hash, {
      chain,
      blockNumber: this.head - BigInt((opts.confirmations ?? 5) - 1),
      minedAt: Date.now() - (opts.ageMs ?? 60_000),
      logs: [
        {
          address: tokenAddress,
          topics: [TRANSFER, pad(opts.from), pad(opts.to ?? TREASURY)],
          data: pad(toHex(BigInt(opts.micros))),
        },
      ],
    });
    return hash;
  }
}

/** Solana: token balances before and after, signers, finality. */
class FakeSolana {
  txs = new Map<string, { tx: SolanaTransaction; finalized: boolean; confirmations: number }>();
  down = false;

  reader = (): SolanaReader => ({
    getTransaction: async (signature) => {
      if (this.down) throw new Error("rpc down");
      const entry = this.txs.get(signature);
      return entry?.finalized ? entry.tx : null;
    },
    getStatus: async (signature) => {
      if (this.down) throw new Error("rpc down");
      const entry = this.txs.get(signature);
      return entry ? { confirmations: entry.confirmations, failed: entry.tx.failed } : null;
    },
    verifyMessage: verifySolanaMessage,
  });

  /** `from` sends USDC to `to` (Poof by default), paying the fee itself unless `feePayer` does. */
  pay(opts: {
    from: string;
    micros: number;
    to?: string;
    mint?: string;
    feePayer?: string;
    finalized?: boolean;
    confirmations?: number;
    ageMs?: number;
    failed?: boolean;
  }): string {
    const signature = toBase58(crypto.getRandomValues(new Uint8Array(64)));
    const mint = opts.mint ?? USDC_ON_SOLANA;
    const to = opts.to ?? SOLANA_TREASURY;
    const amount = BigInt(opts.micros);
    const had = 10_000_000n;
    this.txs.set(signature, {
      finalized: opts.finalized ?? true,
      confirmations: opts.confirmations ?? 0,
      tx: {
        failed: opts.failed ?? false,
        blockTime: Math.floor((Date.now() - (opts.ageMs ?? 60_000)) / 1000),
        signers: opts.feePayer ? [opts.feePayer, opts.from] : [opts.from],
        before: [
          { owner: opts.from, mint, amount: had },
          { owner: to, mint, amount: 0n },
        ],
        after: [
          { owner: opts.from, mint, amount: had - amount },
          { owner: to, mint, amount },
        ],
      },
    });
    return signature;
  }
}

let chain: FakeChain;
let solana: FakeSolana;
beforeEach(() => {
  chain = new FakeChain();
  solana = new FakeSolana();
  setChainReadersForTests({ evm: () => chain.reader(), solana: () => solana.reader() });
});
afterEach(() =>
  setChainReadersForTests({ evm: () => chain.reader(), solana: () => solana.reader() }),
);

/** A wallet, on either kind of chain: an address and a way to sign the redemption text. */
interface Signer {
  address: string;
  signMessage(message: string): Promise<string>;
}

const evmWallet = (account = privateKeyToAccount(generatePrivateKey())): Signer => ({
  address: account.address,
  signMessage: (message) => account.signMessage({ message }),
});

/** A Solana wallet: an ed25519 key; its address is the public key in base58. */
async function solanaWallet(): Promise<Signer> {
  const keys = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const publicKey = new Uint8Array(
    (await crypto.subtle.exportKey("raw", keys.publicKey)) as ArrayBuffer,
  );
  return {
    address: toBase58(publicKey),
    signMessage: async (message) =>
      toBase58(
        new Uint8Array(
          await crypto.subtle.sign("Ed25519", keys.privateKey, new TextEncoder().encode(message)),
        ),
      ),
  };
}

// ── The browser's side, done by hand (the engine does the same) ────────────────

function call(path: string, init: RequestInit = {}, withEnv: Env = env): Promise<Response> {
  return worker.fetch(
    new Request(`https://api.usepoof.chat${path}`, {
      ...init,
      headers: { Origin: SITE, "Content-Type": "application/json", ...init.headers },
    }),
    withEnv,
  );
}
const post = (path: string, body: unknown) =>
  call(path, { method: "POST", body: JSON.stringify(body) });

async function config(): Promise<PayConfig> {
  const res = await call("/api/pay/config");
  expect(res.status).toBe(200);
  return res.json();
}

async function hexSha256(data: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}

interface Blinded {
  variant: Variant;
  keyId: string;
  publicKey: CryptoKey;
  msg: Uint8Array;
  inv: Uint8Array;
  blindedMsg: Uint8Array;
}

async function blind(variant: Variant): Promise<Blinded> {
  const key = (await config()).keys.find((k) => k.variant === variantId(variant))!;
  const publicKey = await crypto.subtle.importKey(
    "spki",
    fromBase64Url(key.spki),
    { name: "RSA-PSS", hash: "SHA-384" },
    true,
    ["verify"],
  );
  const msg = suite().prepare(crypto.getRandomValues(new Uint8Array(32)));
  const { blindedMsg, inv } = await suite().blind(publicKey, msg);
  return { variant, keyId: key.keyId, publicKey, msg, inv, blindedMsg };
}

async function redeemBody(
  b: Blinded,
  txHash: string,
  wallet: Signer,
  chainName: ChainName = "base",
  token: TokenSymbol = "USDC",
) {
  const message = redeemMessage({
    chain: chainName,
    txHash,
    variant: b.variant,
    blindedHash: await hexSha256(b.blindedMsg),
  });
  return {
    chain: chainName,
    token,
    txHash,
    variant: b.variant,
    keyId: b.keyId,
    blindedMsg: toBase64Url(b.blindedMsg),
    payer: wallet.address,
    signature: await wallet.signMessage(message),
  };
}

async function finish(b: Blinded, blindSignature: string): Promise<Pass> {
  const sig = await suite().finalize(b.publicKey, b.msg, fromBase64Url(blindSignature), b.inv);
  return {
    variant: b.variant,
    keyId: b.keyId,
    msg: toBase64Url(b.msg),
    signature: toBase64Url(sig),
  };
}

/** Pay, redeem and finish: a pass for `variant`. */
async function buyPass(variant = V4, wallet = evmWallet()): Promise<Pass> {
  const b = await blind(variant);
  const tx = chain.pay({ from: wallet.address as Hex, micros: priceMicros(variant) });
  const res = await post("/api/pay/redeem", await redeemBody(b, tx, wallet));
  expect(res.status).toBe(200);
  return finish(b, ((await res.json()) as { blindSignature: string }).blindSignature);
}

const ledger = (tx: string) =>
  env.LEDGER.prepare("SELECT * FROM payments WHERE tx_hash = ?")
    .bind(tx.startsWith("0x") ? tx.toLowerCase() : tx)
    .first<Record<string, unknown>>();

// ── Tests ────────────────────────────────────────────────────────────────────

describe("GET /api/pay/config", () => {
  it("lists Poof's address, the chains and tokens, and one pass key per variant, readable by the site", async () => {
    const res = await call("/api/pay/config");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(SITE);
    const cfg = (await res.json()) as PayConfig;
    expect(
      cfg.chains.map((c) => [c.name, c.kind, c.chainId, c.treasury, c.tokens.map((t) => t.symbol)]),
    ).toEqual([
      ["ethereum", "evm", 1, "0x68222E6dC73e161045233B2b76a47d98F84A7e8C", ["USDC"]],
      ["base", "evm", 8453, "0x68222E6dC73e161045233B2b76a47d98F84A7e8C", ["USDC"]],
      ["robinhood", "evm", 4663, "0x68222E6dC73e161045233B2b76a47d98F84A7e8C", ["USDG"]],
      ["solana", "solana", null, "AGQzMmBEgxTeLonpt11isEu6KBDv4h3VbPofCEy4i8Et", ["USDC"]],
    ]);
    // Every stablecoin has 6 decimals; on Solana the address is the mint.
    expect(cfg.chains.flatMap((c) => c.tokens.map((t) => t.decimals))).toEqual([6, 6, 6, 6]);
    expect(cfg.chains[3]!.tokens[0]).toEqual({
      symbol: "USDC",
      address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      decimals: 6,
    });
    // 1 h and 24 h: 2 to 10 people, or 1 to 10 with the AI model.
    expect(cfg.keys).toHaveLength(38);
    expect(new Set(cfg.keys.map((k) => k.keyId)).size).toBe(38);
    expect(cfg.keys.filter((k) => k.variant.endsWith("-ai"))).toHaveLength(20);
    // Stable: the same keys every time.
    expect((await config()).keys).toEqual(cfg.keys);
  });

  it("leaves Solana out while Poof has no address there", async () => {
    const res = await call("/api/pay/config", {}, {
      ...env,
      PAY_TREASURY_SOLANA: "",
    } as unknown as Env);
    const cfg = (await res.json()) as PayConfig;
    expect(cfg.chains.map((c) => c.name)).toEqual(["ethereum", "base", "robinhood"]);
  });
});

describe("POST /api/pay/redeem", () => {
  it("a paid pass opens a Super Quant-Room of exactly that kind, and the ledger has price and amount but no room", async () => {
    const wallet = evmWallet();
    const b = await blind(V4);
    const tx = chain.pay({ from: wallet.address as Hex, micros: 588_000 });
    const res = await post("/api/pay/redeem", await redeemBody(b, tx, wallet));
    expect(res.status).toBe(200);
    const pass = await finish(b, ((await res.json()) as { blindSignature: string }).blindSignature);

    const owner = await newOwner();
    const created = await post("/api/rooms", { ownerHash: owner.ownerHash, pass });
    expect(created.status).toBe(200);
    const room = (await created.json()) as {
      roomId: string;
      plan: string;
      tier: string;
      maxPeers: number;
      expiresAt: number;
      serverNow: number;
      limits: { fileTransfer: boolean };
    };
    expect(room).toMatchObject({
      plan: "super",
      tier: "60m",
      maxPeers: 4,
      limits: { fileTransfer: true },
    });
    expect(room.expiresAt - room.serverNow).toBe(3600 * 1000);

    const row = await ledger(tx);
    expect(row).toMatchObject({
      chain: "base",
      token: "USDC",
      variant: "3600-4",
      required_micros: 588_000,
      received_micros: 588_000,
      status: "issued",
    });
    expect(JSON.stringify(row)).not.toContain(room.roomId);
    expect(Object.keys(row!)).not.toContain("payer");
  });

  it("24 hours for 10 people costs $1.562", async () => {
    const pass = await buyPass({ lifetime: 86400, people: 10, ai: false });
    const res = await post("/api/rooms", { ownerHash: (await newOwner()).ownerHash, pass });
    expect(await res.json()).toMatchObject({ tier: "24h", maxPeers: 10 });
    expect(priceMicros({ lifetime: 86400, people: 10, ai: false })).toBe(1_562_000);
  });

  it("says 'pending' until the payment is mined and confirmed", async () => {
    const wallet = evmWallet();
    const b = await blind(V4);
    // Not mined yet.
    const unknown = toHex(crypto.getRandomValues(new Uint8Array(32)));
    let res = await post("/api/pay/redeem", await redeemBody(b, unknown, wallet));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ status: "pending", confirmations: 0, needed: 1 });
    // Ethereum needs 2 confirmations; this one has 1.
    const tx = chain.pay({
      from: wallet.address as Hex,
      micros: 588_000,
      chain: "ethereum",
      confirmations: 1,
    });
    res = await post("/api/pay/redeem", await redeemBody(b, tx, wallet, "ethereum"));
    expect(await res.json()).toEqual({ status: "pending", confirmations: 1, needed: 2 });
    chain.head += 1n;
    res = await post("/api/pay/redeem", await redeemBody(b, tx, wallet, "ethereum"));
    expect(res.status).toBe(200);
  });

  it("too little: refused, and recorded with what was due and what arrived", async () => {
    const wallet = evmWallet();
    const b = await blind(V4);
    const tx = chain.pay({ from: wallet.address as Hex, micros: 500_000 });
    const res = await post("/api/pay/redeem", await redeemBody(b, tx, wallet));
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({
      error: {
        code: "payment_underpaid",
        message: "This quant-room costs $0.588 USDC; $0.50 USDC arrived.",
      },
    });
    expect(await ledger(tx)).toMatchObject({
      required_micros: 588_000,
      received_micros: 500_000,
      status: "underpaid",
    });
    // Trying again with the same transaction doesn't help.
    expect(
      (await post("/api/pay/redeem", await redeemBody(await blind(V4), tx, wallet))).status,
    ).toBe(402);
  });

  it("more than the price is fine, and recorded", async () => {
    const wallet = evmWallet();
    const b = await blind(V4);
    const tx = chain.pay({ from: wallet.address as Hex, micros: 1_000_000 });
    expect((await post("/api/pay/redeem", await redeemBody(b, tx, wallet))).status).toBe(200);
    expect(await ledger(tx)).toMatchObject({
      required_micros: 588_000,
      received_micros: 1_000_000,
      status: "issued",
    });
  });

  it("someone who didn't pay can't redeem another person's transaction", async () => {
    const payer = evmWallet();
    const thief = evmWallet();
    const tx = chain.pay({ from: payer.address as Hex, micros: 588_000 });
    // Signing as themselves: the payment didn't come from them.
    let res = await post("/api/pay/redeem", await redeemBody(await blind(V4), tx, thief));
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: { code: "payment_invalid" } });
    // Claiming to be the payer without the payer's signature.
    const body = await redeemBody(await blind(V4), tx, thief);
    res = await post("/api/pay/redeem", { ...body, payer: payer.address });
    expect(await res.json()).toMatchObject({
      error: { code: "payment_invalid", message: "The wallet signature doesn't match." },
    });
    expect(await ledger(tx)).toBeNull();
  });

  it("refuses transfers to another address, other tokens, failed and old transactions", async () => {
    const wallet = evmWallet();
    const cases: Hex[] = [
      chain.pay({
        from: wallet.address as Hex,
        micros: 588_000,
        to: "0x000000000000000000000000000000000000dEaD",
      }),
      chain.pay({ from: wallet.address as Hex, micros: 588_000, token: "USDG" }), // not a Base token
      chain.pay({ from: wallet.address as Hex, micros: 588_000, ageMs: 25 * 60 * 60 * 1000 }),
    ];
    const reverted = chain.pay({ from: wallet.address as Hex, micros: 588_000 });
    chain.txs.get(reverted)!.status = "reverted";
    cases.push(reverted);
    for (const tx of cases) {
      const res = await post("/api/pay/redeem", await redeemBody(await blind(V4), tx, wallet));
      expect(res.status).toBe(422);
    }
    // USDG isn't accepted on Base at all.
    const res = await post(
      "/api/pay/redeem",
      await redeemBody(await blind(V4), cases[0]!, wallet, "base", "USDG"),
    );
    expect(await res.json()).toMatchObject({
      error: { code: "payment_invalid", message: "USDG isn't accepted on Base." },
    });
  });

  it("one payment, one pass: a retry gets the same answer, a lost pass can be replaced once, then never", async () => {
    const wallet = evmWallet();
    const tx = chain.pay({ from: wallet.address as Hex, micros: 588_000 });
    const first = await blind(V4);
    const a = (await (
      await post("/api/pay/redeem", await redeemBody(first, tx, wallet))
    ).json()) as { blindSignature: string };
    const retry = (await (
      await post("/api/pay/redeem", await redeemBody(first, tx, wallet))
    ).json()) as { blindSignature: string };
    expect(retry.blindSignature).toBe(a.blindSignature);

    const replacement = await post(
      "/api/pay/redeem",
      await redeemBody(await blind(V4), tx, wallet),
    );
    expect(replacement.status).toBe(200);
    const third = await post("/api/pay/redeem", await redeemBody(await blind(V4), tx, wallet));
    expect(third.status).toBe(409);
    expect(await third.json()).toMatchObject({ error: { code: "payment_used" } });
    // Not for another variant either.
    const other = await post(
      "/api/pay/redeem",
      await redeemBody(await blind({ lifetime: 86400, people: 2, ai: false }), tx, wallet),
    );
    expect(other.status).not.toBe(200);
  });

  it("the same transaction can't be used on another chain's ledger entry to get a second pass", async () => {
    const wallet = evmWallet();
    const tx = chain.pay({ from: wallet.address as Hex, micros: 588_000, chain: "base" });
    expect(
      (await post("/api/pay/redeem", await redeemBody(await blind(V4), tx, wallet, "base"))).status,
    ).toBe(200);
    // Same hash claimed on Ethereum: the token contract there doesn't match the log.
    expect(
      (await post("/api/pay/redeem", await redeemBody(await blind(V4), tx, wallet, "ethereum")))
        .status,
    ).toBe(422);
  });

  it("a 503 when the chain can't be reached, nothing recorded", async () => {
    const wallet = evmWallet();
    const tx = chain.pay({ from: wallet.address as Hex, micros: 588_000 });
    chain.down = true;
    const res = await post("/api/pay/redeem", await redeemBody(await blind(V4), tx, wallet));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { code: "chain_unavailable" } });
    expect(await ledger(tx)).toBeNull();
  });

  it("refuses a key id that isn't the variant's key", async () => {
    const wallet = evmWallet();
    const tx = chain.pay({ from: wallet.address as Hex, micros: 588_000 });
    const body = await redeemBody(await blind(V4), tx, wallet);
    const res = await post("/api/pay/redeem", { ...body, keyId: "x".repeat(43) });
    expect(res.status).toBe(409);
  });

  it("refuses variants that can't be bought: 11 people, alone without the AI, odd lifetimes", async () => {
    const base = {
      chain: "base",
      token: "USDC",
      txHash: `0x${"1".repeat(64)}`,
      keyId: "k",
      blindedMsg: "AA",
      payer: `0x${"2".repeat(40)}`,
      signature: "0x00",
    };
    for (const variant of [
      { lifetime: 3600, people: 11, ai: true },
      { lifetime: 3600, people: 11, ai: false },
      { lifetime: 3600, people: 1, ai: false },
      { lifetime: 7200, people: 4, ai: false },
    ]) {
      expect((await post("/api/pay/redeem", { ...base, variant })).status).toBe(400);
    }
  });
});

describe("spending passes", () => {
  it("a pass works once", async () => {
    const pass = await buyPass();
    expect(
      (await post("/api/rooms", { ownerHash: (await newOwner()).ownerHash, pass })).status,
    ).toBe(200);
    const again = await post("/api/rooms", { ownerHash: (await newOwner()).ownerHash, pass });
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: { code: "pass_used" } });
  });

  it("a forged pass, or a pass for a cheaper variant claiming a dearer one, is refused", async () => {
    const pass = await buyPass(V4);
    const forged = { ...pass, signature: toBase64Url(crypto.getRandomValues(new Uint8Array(256))) };
    expect(
      (await post("/api/rooms", { ownerHash: (await newOwner()).ownerHash, pass: forged })).status,
    ).toBe(403);
    const dearer = { ...pass, variant: { lifetime: 86400, people: 10, ai: false } };
    expect(
      (await post("/api/rooms", { ownerHash: (await newOwner()).ownerHash, pass: dearer })).status,
    ).toBe(403);
    // The real one still works: refused attempts don't burn it.
    expect(
      (await post("/api/rooms", { ownerHash: (await newOwner()).ownerHash, pass })).status,
    ).toBe(200);
  });
});

describe("stats counters", () => {
  it("a Super Quant-Room counts as super, with the AI as ai; a refused pass counts nothing", async () => {
    const [sup, ai] = [await totalOf("super"), await totalOf("ai")];
    const pass = await buyPass(V4);
    expect(
      (await post("/api/rooms", { ownerHash: (await newOwner()).ownerHash, pass })).status,
    ).toBe(200);
    expect(
      (await post("/api/rooms", { ownerHash: (await newOwner()).ownerHash, pass })).status,
    ).toBe(409);
    const aiPass = await buyPass({ lifetime: 3600, people: 1, ai: true });
    expect(
      (await post("/api/rooms", { ownerHash: (await newOwner()).ownerHash, pass: aiPass })).status,
    ).toBe(200);
    await vi.waitFor(async () => {
      expect(await totalOf("super")).toBe(sup + 1);
      expect(await totalOf("ai")).toBe(ai + 1);
    });
  });

  it("an upgraded free room counts once as classic, then as super", async () => {
    const owner = await newOwner();
    const classic = await totalOf("classic");
    const free = (await (await post("/api/rooms", { ownerHash: owner.ownerHash })).json()) as {
      roomId: string;
    };
    await vi.waitFor(async () => expect(await totalOf("classic")).toBe(classic + 1));
    const sup = await totalOf("super");
    const pass = await buyPass(V4);
    const res = await post(`/api/rooms/${free.roomId}/upgrade`, {
      ownerSecret: owner.ownerSecret,
      pass,
    });
    expect(res.status).toBe(200);
    await vi.waitFor(async () => expect(await totalOf("super")).toBe(sup + 1));
    expect(await totalOf("classic")).toBe(classic + 1);
  });
});

describe("POST /api/rooms/:id/upgrade", () => {
  it("the creator upgrades a free room: everyone in it learns the new end, size and relay credentials", async () => {
    const owner = await newOwner();
    const free = (await (await post("/api/rooms", { ownerHash: owner.ownerHash })).json()) as {
      roomId: string;
    };
    const alice = await TestSocket.connect(free.roomId, peer("alice"));
    const bob = await TestSocket.connect(free.roomId, peer("bob"));
    await alice.next("welcome");
    await bob.next("welcome");

    const pass = await buyPass(V4);
    const res = await post(`/api/rooms/${free.roomId}/upgrade`, {
      ownerSecret: owner.ownerSecret,
      pass,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      plan: "super",
      tier: "60m",
      maxPeers: 4,
      limits: { fileTransfer: true },
    });

    for (const s of [alice, bob]) {
      const msg = (await s.next("room.upgraded")) as Extract<ServerMessage, { t: "room.upgraded" }>;
      expect(msg).toMatchObject({
        plan: "super",
        tier: "60m",
        maxPeers: 4,
        limits: { fileTransfer: true },
      });
      expect(msg.expiresAt - msg.serverNow).toBeGreaterThan(3599 * 1000);
      expect(msg.iceServers.length).toBeGreaterThan(0);
    }
    // Two more people fit now.
    const carol = await TestSocket.connect(free.roomId, peer("carol"));
    expect((await carol.next("welcome")).t).toBe("welcome");
  });

  it("only the creator can upgrade, and a refused upgrade gives the pass back", async () => {
    const owner = await newOwner();
    const free = (await (await post("/api/rooms", { ownerHash: owner.ownerHash })).json()) as {
      roomId: string;
    };
    const pass = await buyPass(V4);
    const stranger = await newOwner();
    const res = await post(`/api/rooms/${free.roomId}/upgrade`, {
      ownerSecret: stranger.ownerSecret,
      pass,
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: "not_owner" } });
    expect(
      (await post(`/api/rooms/${free.roomId}/upgrade`, { ownerSecret: owner.ownerSecret, pass }))
        .status,
    ).toBe(200);
  });

  it("an unknown room: 404, pass given back", async () => {
    const pass = await buyPass(V4);
    const owner = await newOwner();
    expect(
      (
        await post("/api/rooms/AAAAAAAAAAAAAAAAAAAAAA/upgrade", {
          ownerSecret: owner.ownerSecret,
          pass,
        })
      ).status,
    ).toBe(404);
    expect((await post("/api/rooms", { ownerHash: owner.ownerHash, pass })).status).toBe(200);
  });
});

describe("the AI model", () => {
  const SOLO_AI: Variant = { lifetime: 3600, people: 1, ai: true };

  it("an AI pass makes a quant-room for one person with the AI", async () => {
    const pass = await buyPass(SOLO_AI);
    const owner = await newOwner();
    const res = await post("/api/rooms", { ownerHash: owner.ownerHash, pass });
    expect(res.status).toBe(200);
    const room = (await res.json()) as { roomId: string; ai: boolean; maxPeers: number };
    expect(room).toMatchObject({ plan: "super", tier: "60m", maxPeers: 1, ai: true });

    const me = await TestSocket.connect(room.roomId, peer("me"));
    expect(await me.next("welcome")).toMatchObject({ ai: true, maxPeers: 1 });
    // Nobody else fits: it's you and the AI.
    const other = await TestSocket.connect(room.roomId, peer("other"));
    expect((await other.next("rejected")).reason).toBe("room_full");
  });

  it("an upgrade with the AI turns it on (with the room's AI token hash); one without turns it off", async () => {
    const owner = await newOwner();
    const free = (await (await post("/api/rooms", { ownerHash: owner.ownerHash })).json()) as {
      roomId: string;
      ai: boolean;
    };
    expect(free.ai).toBe(false);
    const alice = await TestSocket.connect(free.roomId, peer("alice"));
    await alice.next("welcome");

    const aiHash = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
    const withAi = await post(`/api/rooms/${free.roomId}/upgrade`, {
      ownerSecret: owner.ownerSecret,
      pass: await buyPass({ lifetime: 3600, people: 4, ai: true }),
      aiHash,
    });
    expect(withAi.status).toBe(200);
    expect(await withAi.json()).toMatchObject({ ai: true, maxPeers: 4 });
    expect(await alice.next("room.upgraded")).toMatchObject({ ai: true });

    const without = await post(`/api/rooms/${free.roomId}/upgrade`, {
      ownerSecret: owner.ownerSecret,
      pass: await buyPass(V4),
    });
    expect(await without.json()).toMatchObject({ ai: false });
    expect(await alice.next("room.upgraded")).toMatchObject({ ai: false });
  });
});

describe("paying on Solana", () => {
  it("USDC to Poof's Solana address opens the room, and the ledger says so", async () => {
    const wallet = await solanaWallet();
    const b = await blind(V4);
    const tx = solana.pay({ from: wallet.address, micros: 588_000 });
    const res = await post("/api/pay/redeem", await redeemBody(b, tx, wallet, "solana"));
    expect(res.status).toBe(200);
    const pass = await finish(b, ((await res.json()) as { blindSignature: string }).blindSignature);
    expect(
      (await post("/api/rooms", { ownerHash: (await newOwner()).ownerHash, pass })).status,
    ).toBe(200);
    expect(await ledger(tx)).toMatchObject({
      chain: "solana",
      tx_hash: tx,
      token: "USDC",
      variant: "3600-4",
      required_micros: 588_000,
      received_micros: 588_000,
      status: "issued",
    });
  });

  it("the signed text keeps the signature's case (base58), unlike EVM hashes", async () => {
    const wallet = await solanaWallet();
    const b = await blind(V4);
    const tx = solana.pay({ from: wallet.address, micros: 588_000 });
    const message = redeemMessage({
      chain: "solana",
      txHash: tx,
      variant: V4,
      blindedHash: await hexSha256(b.blindedMsg),
    });
    expect(message).toContain(`Transaction: ${tx}\n`);
    expect(fromBase58(tx)).toHaveLength(64);
  });

  it("says 'pending' until the transaction is finalized", async () => {
    const wallet = await solanaWallet();
    const b = await blind(V4);
    const unknown = toBase58(crypto.getRandomValues(new Uint8Array(64)));
    let res = await post("/api/pay/redeem", await redeemBody(b, unknown, wallet, "solana"));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ status: "pending", confirmations: 0, needed: 32 });

    const tx = solana.pay({
      from: wallet.address,
      micros: 588_000,
      finalized: false,
      confirmations: 10,
    });
    res = await post("/api/pay/redeem", await redeemBody(b, tx, wallet, "solana"));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ status: "pending", confirmations: 10, needed: 32 });
    solana.txs.get(tx)!.finalized = true;
    res = await post("/api/pay/redeem", await redeemBody(b, tx, wallet, "solana"));
    expect(res.status).toBe(200);
  });

  it("too little: refused, and recorded", async () => {
    const wallet = await solanaWallet();
    const tx = solana.pay({ from: wallet.address, micros: 500_000 });
    const res = await post(
      "/api/pay/redeem",
      await redeemBody(await blind(V4), tx, wallet, "solana"),
    );
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({
      error: {
        code: "payment_underpaid",
        message: "This quant-room costs $0.588 USDC; $0.50 USDC arrived.",
      },
    });
    expect(await ledger(tx)).toMatchObject({ status: "underpaid", received_micros: 500_000 });
  });

  it("only the wallet whose USDC went to Poof can redeem: not a fee payer, not a copied signature", async () => {
    const payer = await solanaWallet();
    const sponsor = await solanaWallet();
    const thief = await solanaWallet();
    // The sponsor signed the transaction (it paid the fee), but the USDC came from the payer.
    const tx = solana.pay({ from: payer.address, micros: 588_000, feePayer: sponsor.address });
    let res = await post(
      "/api/pay/redeem",
      await redeemBody(await blind(V4), tx, sponsor, "solana"),
    );
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({
      error: { code: "payment_invalid", message: expect.stringContaining("another wallet") },
    });
    // Someone who saw the transaction on-chain, signing as themselves.
    res = await post("/api/pay/redeem", await redeemBody(await blind(V4), tx, thief, "solana"));
    expect(res.status).toBe(422);
    // Claiming to be the payer without the payer's key.
    const body = await redeemBody(await blind(V4), tx, thief, "solana");
    res = await post("/api/pay/redeem", { ...body, payer: payer.address });
    expect(await res.json()).toMatchObject({
      error: { code: "payment_invalid", message: "The wallet signature doesn't match." },
    });
    expect(await ledger(tx)).toBeNull();
    // The payer can.
    res = await post("/api/pay/redeem", await redeemBody(await blind(V4), tx, payer, "solana"));
    expect(res.status).toBe(200);
  });

  it("refuses a failed transaction, USDC sent elsewhere, another token, and an old payment", async () => {
    const wallet = await solanaWallet();
    const cases = [
      solana.pay({ from: wallet.address, micros: 588_000, failed: true }),
      solana.pay({ from: wallet.address, micros: 588_000, to: toBase58(new Uint8Array(32)) }),
      solana.pay({
        from: wallet.address,
        micros: 588_000,
        mint: toBase58(new Uint8Array(32).fill(7)),
      }),
      solana.pay({ from: wallet.address, micros: 588_000, ageMs: 25 * 60 * 60 * 1000 }),
    ];
    for (const tx of cases) {
      const res = await post(
        "/api/pay/redeem",
        await redeemBody(await blind(V4), tx, wallet, "solana"),
      );
      expect(res.status).toBe(422);
      expect(await ledger(tx)).toBeNull();
    }
    // A failed transaction that never finalizes isn't "pending" forever either.
    const failed = solana.pay({
      from: wallet.address,
      micros: 588_000,
      failed: true,
      finalized: false,
    });
    expect(
      (await post("/api/pay/redeem", await redeemBody(await blind(V4), failed, wallet, "solana")))
        .status,
    ).toBe(422);
  });

  it("a 503 when Solana can't be reached, nothing recorded", async () => {
    const wallet = await solanaWallet();
    const tx = solana.pay({ from: wallet.address, micros: 588_000 });
    solana.down = true;
    const res = await post(
      "/api/pay/redeem",
      await redeemBody(await blind(V4), tx, wallet, "solana"),
    );
    expect(res.status).toBe(503);
    expect(await ledger(tx)).toBeNull();
  });

  it("ids have to fit the chain: EVM ids on Solana, or Solana ids on Base, aren't a redemption", async () => {
    const evm = evmWallet();
    const sol = await solanaWallet();
    const evmTx = chain.pay({ from: evm.address as Hex, micros: 588_000 });
    const solTx = solana.pay({ from: sol.address, micros: 588_000 });
    expect(
      (await post("/api/pay/redeem", await redeemBody(await blind(V4), evmTx, evm, "solana")))
        .status,
    ).toBe(400);
    expect(
      (await post("/api/pay/redeem", await redeemBody(await blind(V4), solTx, sol, "base"))).status,
    ).toBe(400);
    // USDG isn't a Solana token.
    const res = await post(
      "/api/pay/redeem",
      await redeemBody(await blind(V4), solTx, sol, "solana", "USDG"),
    );
    expect(await res.json()).toMatchObject({
      error: { code: "payment_invalid", message: "USDG isn't accepted on Solana." },
    });
  });

  it("without Poof's Solana address, Solana payments are refused", async () => {
    const wallet = await solanaWallet();
    const tx = solana.pay({ from: wallet.address, micros: 588_000 });
    const res = await call(
      "/api/pay/redeem",
      {
        method: "POST",
        body: JSON.stringify(await redeemBody(await blind(V4), tx, wallet, "solana")),
      },
      { ...env, PAY_TREASURY_SOLANA: "" } as unknown as Env,
    );
    expect(res.status).toBe(422);
    expect(await ledger(tx)).toBeNull();
  });
});

describe("base58", () => {
  it("round-trips, keeps leading zeros, and refuses other characters", () => {
    const bytes = crypto.getRandomValues(new Uint8Array(64));
    expect(fromBase58(toBase58(bytes))).toEqual(bytes);
    expect(toBase58(new Uint8Array([0, 0, 1]))).toBe("112");
    expect(fromBase58("112")).toEqual(new Uint8Array([0, 0, 1]));
    expect(toBase58(new Uint8Array(0))).toBe("");
    expect(fromBase58("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")).toHaveLength(32);
    expect(() => fromBase58("0OIl")).toThrow();
  });
});
