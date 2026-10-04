import { RSABSSA } from "@cloudflare/blindrsa-ts";
import { env } from "cloudflare:workers";
import {
  CHAIN_CONFIG,
  priceMicros,
  redeemMessage,
  variantId,
  weiForUsd,
  type ChainName,
  type Pass,
  type PayConfig,
  type QuoteResponse,
  type ServerMessage,
  type TokenSymbol,
  type Variant,
} from "@poof/protocol";
import { pad, toHex, verifyMessage, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index.ts";
import { setChainReaderForTests } from "../src/pay.ts";
import type { ChainReader } from "../src/payments.ts";
import { fromBase64Url, toBase64Url } from "../src/util.ts";
import { TestSocket, newOwner, peer } from "./helpers.ts";

const SITE = "https://usepoof.chat";
const TREASURY = env.PAY_TREASURY as Hex;
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const V4: Variant = { lifetime: 3600, people: 4, ai: false };
const suite = () => RSABSSA.SHA384.PSS.Randomized();

// ── A fake chain: transactions we "mine", real wallet signatures ───────────────

interface FakeTx {
  chain: ChainName;
  status?: "success" | "reverted";
  blockNumber: bigint;
  minedAt: number;
  logs: { address: string; topics: string[]; data: string }[];
  /** The transaction itself: ETH payments carry their amount as `value`. */
  from: string;
  to: string;
  value: bigint;
}

class FakeChain {
  txs = new Map<string, FakeTx>();
  head = 1000n;
  down = false;
  /** Chainlink ETH/USD, 8 decimals: $2,707.23. */
  ethUsd = 270_723_000_000n;
  ethUsdUpdatedAt = Date.now();

  reader = (): ChainReader => ({
    getReceipt: async (hash) => {
      if (this.down) throw new Error("rpc down");
      const tx = this.txs.get(hash.toLowerCase());
      return tx
        ? { status: tx.status ?? "success", blockNumber: tx.blockNumber, logs: tx.logs }
        : null;
    },
    getTransaction: async (hash) => {
      if (this.down) throw new Error("rpc down");
      const tx = this.txs.get(hash.toLowerCase());
      return tx ? { from: tx.from, to: tx.to, value: tx.value } : null;
    },
    call: async () => {
      if (this.down) throw new Error("rpc down");
      const word = (n: bigint) => n.toString(16).padStart(64, "0");
      const t = BigInt(Math.floor(this.ethUsdUpdatedAt / 1000));
      return `0x${word(1n)}${word(this.ethUsd)}${word(t)}${word(t)}${word(1n)}`;
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
      from: opts.from,
      to: tokenAddress,
      value: 0n,
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

  /** ETH sent straight to `to` (the transaction's own value). */
  payEth(opts: { from: Hex; wei: bigint; chain?: ChainName; to?: Hex; minedAt?: number }): Hex {
    const hash = toHex(crypto.getRandomValues(new Uint8Array(32)));
    this.head += 10n;
    this.txs.set(hash, {
      chain: opts.chain ?? "base",
      from: opts.from,
      to: opts.to ?? TREASURY,
      value: opts.wei,
      blockNumber: this.head - 4n,
      minedAt: opts.minedAt ?? Date.now() - 60_000,
      logs: [],
    });
    return hash;
  }
}

let chain: FakeChain;
beforeEach(() => {
  chain = new FakeChain();
  setChainReaderForTests(() => chain.reader());
});
afterEach(() => setChainReaderForTests(() => chain.reader()));

// ── The browser's side, done by hand (the engine does the same) ────────────────

function call(path: string, init: RequestInit = {}): Promise<Response> {
  return worker.fetch(
    new Request(`https://api.usepoof.chat${path}`, {
      ...init,
      headers: { Origin: SITE, "Content-Type": "application/json", ...init.headers },
    }),
    env,
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
  txHash: Hex,
  wallet: PrivateKeyAccount,
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
    signature: await wallet.signMessage({ message }),
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
async function buyPass(
  variant = V4,
  wallet = privateKeyToAccount(generatePrivateKey()),
): Promise<Pass> {
  const b = await blind(variant);
  const tx = chain.pay({ from: wallet.address, micros: priceMicros(variant) });
  const res = await post("/api/pay/redeem", await redeemBody(b, tx, wallet));
  expect(res.status).toBe(200);
  return finish(b, ((await res.json()) as { blindSignature: string }).blindSignature);
}

const ledger = (tx: Hex) =>
  env.LEDGER.prepare("SELECT * FROM payments WHERE tx_hash = ?")
    .bind(tx.toLowerCase())
    .first<Record<string, unknown>>();

// ── Tests ────────────────────────────────────────────────────────────────────

describe("GET /api/pay/config", () => {
  it("lists Poof's address, the chains and tokens, and one pass key per variant, readable by the site", async () => {
    const res = await call("/api/pay/config");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(SITE);
    const cfg = (await res.json()) as PayConfig;
    expect(cfg.treasury).toBe("0x68222E6dC73e161045233B2b76a47d98F84A7e8C");
    expect(cfg.chains.map((c) => [c.name, c.chainId, c.tokens.map((t) => t.symbol)])).toEqual([
      ["ethereum", 1, ["USDC", "ETH"]],
      ["base", 8453, ["USDC", "ETH"]],
      ["robinhood", 4663, ["USDG", "ETH"]],
    ]);
    // ETH is the chain's own coin: no contract, 18 decimals.
    expect(cfg.chains[1]!.tokens.find((t) => t.symbol === "ETH")).toEqual({
      symbol: "ETH",
      address: null,
      decimals: 18,
    });
    // 1 h and 24 h, 2 to 10 people, no AI yet.
    expect(cfg.keys).toHaveLength(18);
    expect(new Set(cfg.keys.map((k) => k.keyId)).size).toBe(18);
    expect(cfg.keys.some((k) => k.variant.endsWith("-ai"))).toBe(false);
    // Stable: the same keys every time.
    expect((await config()).keys).toEqual(cfg.keys);
  });
});

describe("POST /api/pay/redeem", () => {
  it("a paid pass opens a Super Quant-Room of exactly that kind, and the ledger has price and amount but no room", async () => {
    const wallet = privateKeyToAccount(generatePrivateKey());
    const b = await blind(V4);
    const tx = chain.pay({ from: wallet.address, micros: 588_000 });
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
    const wallet = privateKeyToAccount(generatePrivateKey());
    const b = await blind(V4);
    // Not mined yet.
    const unknown = toHex(crypto.getRandomValues(new Uint8Array(32)));
    let res = await post("/api/pay/redeem", await redeemBody(b, unknown, wallet));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ status: "pending", confirmations: 0, needed: 1 });
    // Ethereum needs 2 confirmations; this one has 1.
    const tx = chain.pay({
      from: wallet.address,
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
    const wallet = privateKeyToAccount(generatePrivateKey());
    const b = await blind(V4);
    const tx = chain.pay({ from: wallet.address, micros: 500_000 });
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
    const wallet = privateKeyToAccount(generatePrivateKey());
    const b = await blind(V4);
    const tx = chain.pay({ from: wallet.address, micros: 1_000_000 });
    expect((await post("/api/pay/redeem", await redeemBody(b, tx, wallet))).status).toBe(200);
    expect(await ledger(tx)).toMatchObject({
      required_micros: 588_000,
      received_micros: 1_000_000,
      status: "issued",
    });
  });

  it("someone who didn't pay can't redeem another person's transaction", async () => {
    const payer = privateKeyToAccount(generatePrivateKey());
    const thief = privateKeyToAccount(generatePrivateKey());
    const tx = chain.pay({ from: payer.address, micros: 588_000 });
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
    const wallet = privateKeyToAccount(generatePrivateKey());
    const cases: Hex[] = [
      chain.pay({
        from: wallet.address,
        micros: 588_000,
        to: "0x000000000000000000000000000000000000dEaD",
      }),
      chain.pay({ from: wallet.address, micros: 588_000, token: "USDG" }), // not a Base token
      chain.pay({ from: wallet.address, micros: 588_000, ageMs: 25 * 60 * 60 * 1000 }),
    ];
    const reverted = chain.pay({ from: wallet.address, micros: 588_000 });
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
    const wallet = privateKeyToAccount(generatePrivateKey());
    const tx = chain.pay({ from: wallet.address, micros: 588_000 });
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
    const wallet = privateKeyToAccount(generatePrivateKey());
    const tx = chain.pay({ from: wallet.address, micros: 588_000, chain: "base" });
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
    const wallet = privateKeyToAccount(generatePrivateKey());
    const tx = chain.pay({ from: wallet.address, micros: 588_000 });
    chain.down = true;
    const res = await post("/api/pay/redeem", await redeemBody(await blind(V4), tx, wallet));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { code: "chain_unavailable" } });
    expect(await ledger(tx)).toBeNull();
  });

  it("refuses a key id that isn't the variant's key", async () => {
    const wallet = privateKeyToAccount(generatePrivateKey());
    const tx = chain.pay({ from: wallet.address, micros: 588_000 });
    const body = await redeemBody(await blind(V4), tx, wallet);
    const res = await post("/api/pay/redeem", { ...body, keyId: "x".repeat(43) });
    expect(res.status).toBe(409);
  });

  it("refuses variants that can't be bought: the AI model, 11 people, odd lifetimes", async () => {
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
      { lifetime: 3600, people: 4, ai: true },
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

describe("paying in ETH", () => {
  const getQuote = async (chainName: ChainName = "base", variant: Variant = V4) =>
    (await (
      await call(`/api/pay/quote?chain=${chainName}&variant=${variantId(variant)}`)
    ).json()) as QuoteResponse;

  async function ethBody(
    b: Blinded,
    tx: Hex,
    wallet: PrivateKeyAccount,
    quote: string | undefined,
    chainName: ChainName = "base",
  ) {
    return { ...(await redeemBody(b, tx, wallet, chainName, "ETH")), ...(quote ? { quote } : {}) };
  }

  it("quotes the site's dollar price in ETH at the Chainlink price, held 15 minutes", async () => {
    const q = await getQuote();
    expect(q).toMatchObject({
      chain: "base",
      variant: "3600-4",
      usdMicros: 588_000,
      ethUsd: "270723000000",
    });
    expect(BigInt(q.wei)).toBe(weiForUsd(588_000, chain.ethUsd));
    // $0.588 / $2,707.23 ≈ 0.0002172 ETH, rounded up to a whole gwei.
    expect(Number(q.wei) / 1e18).toBeCloseTo(0.588 / 2707.23, 8);
    expect(BigInt(q.wei) % 10n ** 9n).toBe(0n);
    expect(q.expiresAt - Date.now()).toBeGreaterThan(14 * 60 * 1000);
    expect(q.expiresAt - Date.now()).toBeLessThanOrEqual(15 * 60 * 1000);
  });

  it("the quoted ETH opens the room, and the ledger has the ETH and dollar amounts and the price used", async () => {
    const wallet = privateKeyToAccount(generatePrivateKey());
    const q = await getQuote();
    const b = await blind(V4);
    const tx = chain.payEth({ from: wallet.address, wei: BigInt(q.wei) });
    const res = await post("/api/pay/redeem", await ethBody(b, tx, wallet, q.quote));
    expect(res.status).toBe(200);
    const pass = await finish(b, ((await res.json()) as { blindSignature: string }).blindSignature);
    expect(
      (await post("/api/rooms", { ownerHash: (await newOwner()).ownerHash, pass })).status,
    ).toBe(200);
    const row = await ledger(tx);
    expect(row).toMatchObject({
      token: "ETH",
      required_micros: 588_000,
      required_units: q.wei,
      received_units: q.wei,
      eth_usd: "270723000000",
      status: "issued",
    });
    expect(row!.received_micros as number).toBeGreaterThanOrEqual(588_000);
  });

  it("too little ETH: refused, and recorded in ETH and dollars", async () => {
    const wallet = privateKeyToAccount(generatePrivateKey());
    const q = await getQuote();
    const tx = chain.payEth({ from: wallet.address, wei: BigInt(q.wei) / 2n });
    const res = await post("/api/pay/redeem", await ethBody(await blind(V4), tx, wallet, q.quote));
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({
      error: {
        code: "payment_underpaid",
        message: expect.stringMatching(
          /^This quant-room costs 0\.000218 ETH; 0\.000109 ETH arrived\.$/,
        ),
      },
    });
    expect(await ledger(tx)).toMatchObject({ status: "underpaid", required_units: q.wei });
  });

  it("needs its own quote, untouched, for this chain and quant-room", async () => {
    const wallet = privateKeyToAccount(generatePrivateKey());
    const q = await getQuote();
    const tx = chain.payEth({ from: wallet.address, wei: BigInt(q.wei) });
    const [payload, mac] = q.quote.split(".");
    const forged = JSON.parse(new TextDecoder().decode(fromBase64Url(payload!))) as { w: string };
    forged.w = "1";
    const tampered = `${toBase64Url(new TextEncoder().encode(JSON.stringify(forged)))}.${mac}`;
    for (const quote of [
      undefined,
      tampered,
      (await getQuote("base", { lifetime: 3600, people: 2, ai: false })).quote,
      (await getQuote("ethereum")).quote,
    ]) {
      const res = await post("/api/pay/redeem", await ethBody(await blind(V4), tx, wallet, quote));
      expect(res.status).toBe(422);
    }
    expect(await ledger(tx)).toBeNull();
  });

  it("ETH that arrives after the quote ran out is recorded as late, not accepted", async () => {
    const wallet = privateKeyToAccount(generatePrivateKey());
    const q = await getQuote();
    const tx = chain.payEth({
      from: wallet.address,
      wei: BigInt(q.wei),
      minedAt: q.expiresAt + 30_000,
    });
    const res = await post("/api/pay/redeem", await ethBody(await blind(V4), tx, wallet, q.quote));
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({
      error: { message: expect.stringContaining("after its ETH price ran out") },
    });
    expect(await ledger(tx)).toMatchObject({ status: "late", received_units: q.wei });
  });

  it("ETH sent elsewhere, or from another wallet than the one that signs, doesn't count", async () => {
    const wallet = privateKeyToAccount(generatePrivateKey());
    const other = privateKeyToAccount(generatePrivateKey());
    const q = await getQuote();
    const elsewhere = chain.payEth({
      from: wallet.address,
      wei: BigInt(q.wei),
      to: "0x000000000000000000000000000000000000dEaD",
    });
    expect(
      (await post("/api/pay/redeem", await ethBody(await blind(V4), elsewhere, wallet, q.quote)))
        .status,
    ).toBe(422);
    const fromOther = chain.payEth({ from: other.address, wei: BigInt(q.wei) });
    const res = await post(
      "/api/pay/redeem",
      await ethBody(await blind(V4), fromOther, wallet, q.quote),
    );
    expect(await res.json()).toMatchObject({
      error: { code: "payment_invalid", message: expect.stringContaining("another wallet") },
    });
  });

  it("works on Ethereum and Robinhood Chain too", async () => {
    for (const chainName of ["ethereum", "robinhood"] as const) {
      const wallet = privateKeyToAccount(generatePrivateKey());
      const q = await getQuote(chainName);
      expect(q.chain).toBe(chainName);
      const tx = chain.payEth({ from: wallet.address, wei: BigInt(q.wei), chain: chainName });
      expect(
        (
          await post(
            "/api/pay/redeem",
            await ethBody(await blind(V4), tx, wallet, q.quote, chainName),
          )
        ).status,
      ).toBe(200);
    }
  });

  it("no fresh ETH price: no quote (503)", async () => {
    chain.ethUsdUpdatedAt = Date.now() - 3 * 60 * 60 * 1000;
    const res = await call("/api/pay/quote?chain=base&variant=3600-4");
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { code: "chain_unavailable" } });
  });

  it("refuses odd quote requests", async () => {
    for (const qs of [
      "chain=solana&variant=3600-4",
      "chain=base&variant=3600-11",
      "chain=base&variant=3600-4-ai",
      "variant=3600-4",
    ]) {
      expect((await call(`/api/pay/quote?${qs}`)).status).toBe(400);
    }
  });
});
