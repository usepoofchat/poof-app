import { RSABSSA } from "@cloudflare/blindrsa-ts";
import { describe, expect, it } from "vitest";
import { variantId, type Variant } from "@poof/protocol";
import {
  createRoom,
  fetchPayConfig,
  fromBase64Url,
  passKeyId,
  paymentMessage,
  priceMicros,
  redeemPayment,
  startPass,
  toBase64Url,
  transferData,
  type PassKey,
} from "../src/index.ts";

const V: Variant = { lifetime: 3600, people: 4, ai: false };
const TX = `0x${"ab".repeat(32)}`;
const PAYER = `0x${"12".repeat(20)}`;
const suite = () => RSABSSA.SHA384.PSS.Randomized();

async function signer() {
  const { privateKey, publicKey } = await suite().generateKey({
    publicExponent: Uint8Array.from([1, 0, 1]),
    modulusLength: 2048,
  });
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", publicKey));
  const key: PassKey = {
    variant: variantId(V),
    keyId: await passKeyId(spki),
    spki: toBase64Url(spki),
  };
  return { key, privateKey };
}

const json = (body: unknown, status = 200) => Response.json(body, { status });

// RSA key generation (2048 bits) takes a random, sometimes long time, more so on a busy CI machine.
const RSA = { timeout: 30_000 };

describe("transferData", () => {
  it("is ERC-20 transfer(to, amount) calldata", () => {
    expect(transferData("0x68222E6dC73e161045233B2b76a47d98F84A7e8C", 588_000)).toBe(
      "0xa9059cbb" +
        "00000000000000000000000068222e6dc73e161045233b2b76a47d98f84a7e8c" +
        "000000000000000000000000000000000000000000000000000000000008f8e0",
    );
  });
  it("refuses a bad address or amount", () => {
    expect(() => transferData("0x123", 1)).toThrow();
    expect(() => transferData(`0x${"1".repeat(40)}`, 0)).toThrow();
    expect(() => transferData(`0x${"1".repeat(40)}`, 0.5)).toThrow();
  });
});

describe("prices", () => {
  it("match the site: $0.49 + $0.049 per extra person for 1 hour, $1.49 + $0.009 for 24 hours", () => {
    expect(priceMicros({ lifetime: 3600, people: 2, ai: false })).toBe(490_000);
    expect(priceMicros({ lifetime: 3600, people: 4, ai: false })).toBe(588_000);
    expect(priceMicros({ lifetime: 3600, people: 10, ai: false })).toBe(882_000);
    expect(priceMicros({ lifetime: 86400, people: 2, ai: false })).toBe(1_490_000);
    expect(priceMicros({ lifetime: 86400, people: 10, ai: false })).toBe(1_562_000);
    expect(priceMicros({ lifetime: 3600, people: 1, ai: true })).toBe(2_490_000);
  });
});

describe("paymentMessage", RSA, () => {
  it("keeps a Solana signature as it is (base58 is case-sensitive)", async () => {
    const { key } = await signer();
    const pending = await startPass([key], V);
    const sig =
      "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW";
    const message = await paymentMessage("solana", sig, pending);
    expect(message.split("\n")[1]).toBe("Chain: solana");
    expect(message.split("\n")[2]).toBe(`Transaction: ${sig}`);
  });

  it("names the chain, the transaction, the variant and the blinded pass", async () => {
    const { key } = await signer();
    const pending = await startPass([key], V);
    const message = await paymentMessage("base", TX.toUpperCase().replace("0X", "0x"), pending);
    expect(message.split("\n")).toEqual([
      "Poof: unlock a Super Quant-Room",
      "Chain: base",
      `Transaction: ${TX}`,
      "Quant-room: 3600-4",
      expect.stringMatching(/^Pass: [0-9a-f]{64}$/),
    ]);
  });
});

describe("redeemPayment", RSA, () => {
  it("reports pending, then turns the blind signature into a pass", async () => {
    const { key, privateKey } = await signer();
    const pending = await startPass([key], V);
    let calls = 0;
    const fetch: typeof globalThis.fetch = async (_url, init) => {
      calls += 1;
      if (calls === 1) return json({ status: "pending", confirmations: 0, needed: 2 }, 202);
      const body = JSON.parse(init?.body as string) as {
        blindedMsg: string;
        payer: string;
        txHash: string;
      };
      expect(body).toMatchObject({ payer: PAYER, txHash: TX });
      const blind = await suite().blindSign(privateKey, fromBase64Url(body.blindedMsg));
      return json({ status: "ok", blindSignature: toBase64Url(blind) });
    };
    const opts = {
      fetch,
      origin: "https://api.test",
      chain: "base" as const,
      token: "USDC" as const,
      txHash: TX,
      pending,
      payer: PAYER,
      signature: "0x00",
    };
    expect(await redeemPayment(opts)).toEqual({ status: "pending", confirmations: 0, needed: 2 });
    const done = await redeemPayment(opts);
    expect(done.status).toBe("ok");
    if (done.status === "ok")
      expect(done.pass).toMatchObject({ variant: V, keyId: key.keyId, msg: pending.msg });
  });

  it("passes the server's explanation through", async () => {
    const { key } = await signer();
    const pending = await startPass([key], V);
    const fetch: typeof globalThis.fetch = async () =>
      json(
        {
          error: {
            code: "payment_underpaid",
            message: "This quant-room costs $0.588; $0.5 arrived.",
          },
        },
        402,
      );
    await expect(
      redeemPayment({
        fetch,
        origin: "",
        chain: "base",
        token: "USDC",
        txHash: TX,
        pending,
        payer: PAYER,
        signature: "0x00",
      }),
    ).rejects.toMatchObject({
      code: "pay_failed",
      message: "This quant-room costs $0.588; $0.5 arrived.",
    });
  });
});

describe("fetchPayConfig / createRoom with a pass", () => {
  it("says pay_unavailable when the server can't sell rooms", async () => {
    const fetch: typeof globalThis.fetch = async () =>
      json({ error: { code: "pay_unavailable", message: "x" } }, 503);
    await expect(fetchPayConfig({ fetch, origin: "" })).rejects.toMatchObject({
      code: "pay_unavailable",
    });
  });

  it("sends the pass with the owner hash, and maps a spent pass to pass_invalid", async () => {
    const sent: unknown[] = [];
    const fetch: typeof globalThis.fetch = async (_u, init) => {
      sent.push(JSON.parse(init?.body as string));
      return json(
        { error: { code: "pass_used", message: "That pass has already been used." } },
        409,
      );
    };
    const p = { variant: V, keyId: "k".repeat(43), msg: "m", signature: "s" };
    await expect(createRoom({ fetch, origin: "", pass: p })).rejects.toMatchObject({
      code: "pass_invalid",
    });
    expect(sent[0]).toMatchObject({ pass: p, ownerHash: expect.any(String) });
  });
});
