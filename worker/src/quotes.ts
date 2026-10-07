import {
  QUOTE_TTL_SECONDS,
  priceMicros,
  variantId,
  weiForUsd,
  type ChainName,
  type QuoteResponse,
  type Variant,
} from "@poof/protocol";
import { fromBase64Url, toBase64Url } from "./util.ts";

/**
 * ETH quotes: the dollar price of a variant turned into wei at the current ETH/USD price, held for
 * QUOTE_TTL_SECONDS. A quote is signed (HMAC, key derived from PASS_MASTER_KEY) so it can travel
 * through the browser and come back with the payment without the server keeping anything.
 */

interface QuoteBody {
  /** chain */ c: ChainName;
  /** variant id */ v: string;
  /** price, micro-dollars */ u: number;
  /** ETH/USD, 8 decimals */ p: string;
  /** wei */ w: string;
  /** expires at, unix ms */ e: number;
}

export interface Quote {
  chain: ChainName;
  variantId: string;
  usdMicros: number;
  ethUsd: bigint;
  wei: bigint;
  expiresAt: number;
}

async function quoteKey(master: string): Promise<CryptoKey> {
  const ikm = await crypto.subtle.importKey("raw", fromBase64Url(master), "HKDF", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0),
      info: new TextEncoder().encode("poof/v1/eth-quote"),
    },
    ikm,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign", "verify"],
  );
}

export async function makeQuote(
  master: string,
  chain: ChainName,
  variant: Variant,
  ethUsd: bigint,
  now = Date.now(),
): Promise<QuoteResponse> {
  const usdMicros = priceMicros(variant);
  const wei = weiForUsd(usdMicros, ethUsd);
  const body: QuoteBody = {
    c: chain,
    v: variantId(variant),
    u: usdMicros,
    p: ethUsd.toString(),
    w: wei.toString(),
    e: now + QUOTE_TTL_SECONDS * 1000,
  };
  const payload = new TextEncoder().encode(JSON.stringify(body));
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", await quoteKey(master), payload));
  return {
    chain,
    variant: body.v,
    usdMicros,
    ethUsd: body.p,
    wei: body.w,
    expiresAt: body.e,
    quote: `${toBase64Url(payload)}.${toBase64Url(mac)}`,
  };
}

/** The quote, if Poof signed it. Expiry is checked against the payment's block, not here. */
export async function readQuote(master: string, quote: string): Promise<Quote | null> {
  const [payloadB64, macB64] = quote.split(".");
  if (!payloadB64 || !macB64 || !/^[A-Za-z0-9_-]+$/.test(payloadB64 + macB64)) return null;
  const payload = fromBase64Url(payloadB64);
  const ok = await crypto.subtle.verify(
    "HMAC",
    await quoteKey(master),
    fromBase64Url(macB64),
    payload,
  );
  if (!ok) return null;
  try {
    const b = JSON.parse(new TextDecoder().decode(payload)) as QuoteBody;
    return {
      chain: b.c,
      variantId: b.v,
      usdMicros: b.u,
      ethUsd: BigInt(b.p),
      wei: BigInt(b.w),
      expiresAt: b.e,
    };
  } catch {
    return null;
  }
}
