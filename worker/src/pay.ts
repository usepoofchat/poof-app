import {
  CHAIN_CONFIG,
  CHAINS,
  MAX_JSON_BODY_BYTES,
  TOKEN_DECIMALS,
  passSchema,
  priceMicros,
  purchasableVariants,
  redeemMessage,
  redeemRequestSchema,
  variantId,
  type Pass,
  type PayConfig,
  type RedeemResponse,
  type TokenSymbol,
  type Variant,
} from "@poof/protocol";
import type { Hex } from "viem";
import { apiError, isRateLimited, json, readJson } from "./http.ts";
import { blindSign, passKeyFor, verifyPassSignature, type PassKeyRecord } from "./pass-keys.ts";
import { checkPayment, viemReader, type ChainReader } from "./payments.ts";
import { fromBase64Url, toBase64Url } from "./util.ts";

/**
 * Payments for Super Quant-Rooms: GET /api/pay/config and POST /api/pay/redeem.
 *
 * The ledger (D1 `payments`) records, per redeemed transaction, the price and what arrived. It never
 * records the quant-room: passes are blind-signed, so the server can't tell which payment a room
 * came from.
 */

type PayEnv = Pick<Env, "LEDGER" | "PASS_MASTER_KEY" | "PAY_TREASURY" | "RL_PAY">;

/** Real chain reads by default; tests swap in a fake chain. */
let readerFor = (chain: (typeof CHAINS)[number]): ChainReader => viemReader(CHAIN_CONFIG[chain]);
export function setChainReaderForTests(factory: typeof readerFor): void {
  readerFor = factory;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** Payments are on only when Poof's address and the pass master key are configured. */
function payEnabled(
  env: PayEnv,
): env is PayEnv & { PAY_TREASURY: string; PASS_MASTER_KEY: string } {
  return (
    ADDRESS.test(env.PAY_TREASURY ?? "") &&
    typeof env.PASS_MASTER_KEY === "string" &&
    env.PASS_MASTER_KEY.length >= 43
  );
}

function unavailable(): Response {
  return apiError("pay_unavailable", "Super Quant-Rooms can't be bought right now.", 503);
}

export async function payConfig(env: PayEnv): Promise<Response> {
  if (!payEnabled(env)) return unavailable();
  const keys = await Promise.all(purchasableVariants().map((v) => passKeyFor(env, v)));
  const body: PayConfig = {
    treasury: env.PAY_TREASURY,
    chains: CHAINS.map((name) => {
      const c = CHAIN_CONFIG[name];
      return {
        name,
        label: c.label,
        chainId: c.chainId,
        confirmations: c.confirmations,
        explorer: c.explorer,
        tokens: (Object.entries(c.tokens) as [TokenSymbol, string][]).map(([symbol, address]) => ({
          symbol,
          address,
          decimals: TOKEN_DECIMALS,
        })),
      };
    }),
    keys: keys.map((k) => ({ variant: k.variantId, keyId: k.keyId, spki: k.spki })),
  };
  return json(body);
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

interface PaymentRow {
  status: "issued" | "underpaid";
  blinded_hash: string | null;
  reissued: number;
  required_micros: number;
  received_micros: number;
}

export async function redeem(request: Request, env: PayEnv): Promise<Response> {
  if (!payEnabled(env)) return unavailable();
  if (await isRateLimited(env.RL_PAY, request)) {
    return apiError("rate_limited", "Too many attempts. Try again soon.", 429);
  }
  const body = await readJson(request, MAX_JSON_BODY_BYTES);
  if (body instanceof Response) return body;
  const parsed = redeemRequestSchema.safeParse(body.value);
  if (!parsed.success) return apiError("invalid_request", "Not a valid redemption.", 400);
  const r = parsed.data;
  const variant = r.variant;

  if (!CHAIN_CONFIG[r.chain].tokens[r.token]) {
    return apiError(
      "payment_invalid",
      `${r.token} isn't accepted on ${CHAIN_CONFIG[r.chain].label}.`,
      422,
    );
  }
  const key = await passKeyFor(env, variant);
  if (key.keyId !== r.keyId)
    return apiError("key_changed", "The pass key changed. Start again.", 409);

  const blinded = fromBase64Url(r.blindedMsg);
  const blindedHash = await sha256Hex(blinded);
  const txHash = r.txHash.toLowerCase() as Hex;
  const required = priceMicros(variant);

  const check = await checkPayment(
    {
      chain: r.chain,
      token: r.token,
      txHash,
      treasury: env.PAY_TREASURY,
      payer: r.payer as Hex,
      message: redeemMessage({ chain: r.chain, txHash, variant, blindedHash }),
      signature: r.signature as Hex,
      requiredMicros: required,
    },
    readerFor(r.chain),
  ).catch(() => null);
  if (!check)
    return apiError(
      "chain_unavailable",
      "Couldn't reach the blockchain. Try again in a moment.",
      503,
    );

  if (check.status === "pending") {
    return json(
      {
        status: "pending",
        confirmations: check.confirmations,
        needed: check.needed,
      } satisfies RedeemResponse,
      202,
    );
  }
  if (check.status === "rejected") {
    const messages = {
      not_a_payment: "That transaction isn't a payment to Poof in this token.",
      wrong_payer: "That payment came from another wallet. Sign with the wallet that paid.",
      bad_signature: "The wallet signature doesn't match.",
      too_old: "That payment is older than a day.",
    } as const;
    return apiError("payment_invalid", messages[check.reason], 422);
  }

  const now = Date.now();
  const status = check.status === "ok" ? "issued" : "underpaid";
  // First redemption of this transaction: claim it atomically before signing anything.
  const claim = await env.LEDGER.prepare(
    `INSERT INTO payments (chain, tx_hash, token, variant, required_micros, received_micros, status, blinded_hash, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (chain, tx_hash) DO NOTHING`,
  )
    .bind(
      r.chain,
      txHash,
      r.token,
      variantId(variant),
      required,
      check.receivedMicros,
      status,
      status === "issued" ? blindedHash : null,
      now,
      now,
    )
    .run();

  if (claim.meta.changes === 0) {
    const row = await env.LEDGER.prepare(
      "SELECT status, blinded_hash, reissued, required_micros, received_micros FROM payments WHERE chain = ? AND tx_hash = ?",
    )
      .bind(r.chain, txHash)
      .first<PaymentRow>();
    if (!row || row.status !== "issued")
      return underpaid(
        row?.required_micros ?? required,
        row?.received_micros ?? check.receivedMicros,
      );
    // The same blinded pass again (a lost response): same answer, nothing new is issued.
    if (row.blinded_hash === blindedHash) return signed(key, blinded);
    // A new pass for the same payment (the first one was lost): once, and only for the same variant.
    if (row.reissued) return apiError("payment_used", "That payment has already been used.", 409);
    const again = await env.LEDGER.prepare(
      "UPDATE payments SET reissued = 1, blinded_hash = ?, updated_at = ? WHERE chain = ? AND tx_hash = ? AND reissued = 0 AND variant = ?",
    )
      .bind(blindedHash, now, r.chain, txHash, variantId(variant))
      .run();
    if (again.meta.changes === 0)
      return apiError("payment_used", "That payment has already been used.", 409);
    return signed(key, blinded);
  }

  if (status === "underpaid") return underpaid(required, check.receivedMicros);
  return signed(key, blinded);
}

function underpaid(required: number, received: number): Response {
  const usd = (m: number) => `$${(m / 1_000_000).toFixed(6).replace(/0+$/, "").replace(/\.$/, "")}`;
  return apiError(
    "payment_underpaid",
    `This quant-room costs ${usd(required)}; ${usd(received)} arrived.`,
    402,
  );
}

async function signed(key: PassKeyRecord, blinded: Uint8Array): Promise<Response> {
  const blindSignature = toBase64Url(await blindSign(key, blinded));
  return json({ status: "ok", blindSignature } satisfies RedeemResponse);
}

// ── Spending a pass ─────────────────────────────────────────────────────────

export type SpendResult =
  { ok: true; variant: Variant; msgHash: string } | { ok: false; response: Response };

/** Check a pass and burn it. Call `unspend` if what it paid for then fails. */
export async function spendPass(env: PayEnv, raw: unknown): Promise<SpendResult> {
  if (!payEnabled(env)) return { ok: false, response: unavailable() };
  const parsed = passSchema.safeParse(raw);
  if (!parsed.success)
    return { ok: false, response: apiError("pass_invalid", "Not a valid pass.", 400) };
  const pass: Pass = parsed.data;
  const variant = pass.variant;
  const key = await passKeyFor(env, variant);
  const msg = fromBase64Url(pass.msg);
  if (
    key.keyId !== pass.keyId ||
    !(await verifyPassSignature(key, msg, fromBase64Url(pass.signature)))
  ) {
    return { ok: false, response: apiError("pass_invalid", "That pass isn't valid.", 403) };
  }
  const msgHash = await sha256Hex(msg);
  const spent = await env.LEDGER.prepare(
    "INSERT INTO spent_passes (msg_hash, key_id, spent_at) VALUES (?, ?, ?) ON CONFLICT (msg_hash) DO NOTHING",
  )
    .bind(msgHash, key.keyId, Date.now())
    .run();
  if (spent.meta.changes === 0)
    return { ok: false, response: apiError("pass_used", "That pass has already been used.", 409) };
  return { ok: true, variant, msgHash };
}

/** Give a pass back (its quant-room couldn't be made). */
export async function unspendPass(env: PayEnv, msgHash: string): Promise<void> {
  await env.LEDGER.prepare("DELETE FROM spent_passes WHERE msg_hash = ?").bind(msgHash).run();
}
