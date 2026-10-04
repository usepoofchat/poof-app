import {
  errorBodySchema,
  payConfigSchema,
  redeemMessage,
  redeemResponseSchema,
  type ChainName,
  type Pass,
  type PayConfig,
  type TokenSymbol,
} from "@poof/protocol";
import { PoofError } from "./errors.ts";
import { blindedHash, finishPass, type PendingPass } from "./pass.ts";

export {
  formatUsd,
  isValidVariant,
  priceMicros,
  purchasableVariants,
  variantId,
} from "@poof/protocol";
export type { ChainName, Pass, PayConfig, TokenSymbol, Variant } from "@poof/protocol";

/**
 * Paying for a Super Quant-Room, from the browser:
 *
 *   1. fetchPayConfig → where to pay, in what, and the pass keys
 *   2. startPass (pass.ts) → a blinded pass for the chosen variant; keep it until it's spent
 *   3. the wallet sends `transferData(...)` to the token contract (the price, to `config.treasury`)
 *   4. the wallet signs `paymentMessage(...)` (personal_sign)
 *   5. redeemPayment until it says "ok" (it says "pending" while the transfer confirms) → a Pass
 *   6. createRoom({ pass }) or session.upgrade(pass)
 */

export async function fetchPayConfig(opts: {
  fetch: typeof fetch;
  origin: string;
}): Promise<PayConfig> {
  let res: Response;
  try {
    res = await opts.fetch(`${opts.origin}/api/pay/config`);
  } catch {
    throw new PoofError("connection_failed", "Could not reach the server.");
  }
  if (res.status === 503)
    throw new PoofError("pay_unavailable", "Super Quant-Rooms can't be bought right now.");
  if (!res.ok) throw new PoofError("connection_failed", `Server error ${res.status}.`);
  const parsed = payConfigSchema.safeParse(await res.json().catch(() => null));
  if (!parsed.success) throw new PoofError("connection_failed", "Unexpected server response.");
  return parsed.data;
}

/** ERC-20 `transfer(to, amount)` calldata: what the wallet sends to the token contract. */
export function transferData(to: string, micros: number): `0x${string}` {
  if (!/^0x[0-9a-fA-F]{40}$/.test(to) || !Number.isSafeInteger(micros) || micros <= 0) {
    throw new PoofError("pay_failed", "Not a valid payment.");
  }
  const pad = (hex: string) => hex.padStart(64, "0");
  return `0xa9059cbb${pad(to.slice(2).toLowerCase())}${pad(micros.toString(16))}`;
}

/** The text the paying wallet signs: it ties this transaction to this blinded pass. */
export async function paymentMessage(
  chain: ChainName,
  txHash: string,
  pending: PendingPass,
): Promise<string> {
  return redeemMessage({
    chain,
    txHash,
    variant: pending.variant,
    blindedHash: await blindedHash(pending),
  });
}

export type RedeemOutcome =
  { status: "pending"; confirmations: number; needed: number } | { status: "ok"; pass: Pass };

/** Ask Poof to check the payment and sign the pass. Call again while it says "pending". */
export async function redeemPayment(opts: {
  fetch: typeof fetch;
  origin: string;
  chain: ChainName;
  token: TokenSymbol;
  txHash: string;
  pending: PendingPass;
  payer: string;
  signature: string;
}): Promise<RedeemOutcome> {
  let res: Response;
  try {
    res = await opts.fetch(`${opts.origin}/api/pay/redeem`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chain: opts.chain,
        token: opts.token,
        txHash: opts.txHash,
        variant: opts.pending.variant,
        keyId: opts.pending.keyId,
        blindedMsg: opts.pending.blindedMsg,
        payer: opts.payer,
        signature: opts.signature,
      }),
    });
  } catch {
    throw new PoofError("connection_failed", "Could not reach the server.");
  }
  const body: unknown = await res.json().catch(() => null);
  if (res.ok || res.status === 202) {
    const parsed = redeemResponseSchema.safeParse(body);
    if (!parsed.success) throw new PoofError("connection_failed", "Unexpected server response.");
    if (parsed.data.status === "pending") return parsed.data;
    return { status: "ok", pass: await finishPass(opts.pending, parsed.data.blindSignature) };
  }
  throw serverError(res.status, body);
}

/** A PoofError for a failed API call, with the server's own message where it gave one. */
export function serverError(status: number, body: unknown): PoofError {
  const err = errorBodySchema.safeParse(body);
  const message = err.success ? err.data.error.message : `Server error ${status}.`;
  if (status === 429) return new PoofError("rate_limited", message);
  if (!err.success) return new PoofError("connection_failed", message);
  switch (err.data.error.code) {
    case "pay_unavailable":
    case "key_changed":
      return new PoofError("pay_unavailable", message);
    case "chain_unavailable":
      return new PoofError("connection_failed", message);
    case "payment_invalid":
    case "payment_underpaid":
    case "payment_used":
      return new PoofError("pay_failed", message);
    case "pass_invalid":
    case "pass_used":
      return new PoofError("pass_invalid", message);
    case "not_owner":
      return new PoofError("not_owner", message);
    case "room_not_found":
      return new PoofError("room_not_found", message);
    default:
      return new PoofError("connection_failed", message);
  }
}
