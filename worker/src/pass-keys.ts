import { RSABSSA } from "@cloudflare/blindrsa-ts";
import { PASS_KEY_BITS, parseVariantId, variantId, type Variant } from "@poof/protocol";
import { fromBase64Url, toBase64Url } from "./util.ts";

/**
 * Pass keys: one RSA key per variant (RFC 9474, RSABSSA-SHA384-PSS-Randomized), made the first time
 * that variant is needed and kept in D1. The private half is sealed (AES-256-GCM) with a key derived
 * from the PASS_MASTER_KEY secret, so a copy of the database alone can't mint passes.
 *
 * A key's id is base64url(SHA-256(spki)): the browser checks it, so a key can't be swapped under an id.
 */

export const suite = (rsaRaw = false) => RSABSSA.SHA384.PSS.Randomized({ supportsRSARAW: rsaRaw });

export interface PassKeyRecord {
  variant: Variant;
  variantId: string;
  keyId: string;
  spki: string;
  privateKey: CryptoKey;
  publicKey: CryptoKey;
}

type KeyEnv = { LEDGER: D1Database; PASS_MASTER_KEY: string };

const RSA_PSS = { name: "RSA-PSS", hash: "SHA-384" } as const;

async function sealingKey(master: string): Promise<CryptoKey> {
  const raw = fromBase64Url(master);
  if (raw.length < 32) throw new Error("PASS_MASTER_KEY must be at least 32 bytes (base64url)");
  const ikm = await crypto.subtle.importKey("raw", raw, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0),
      info: new TextEncoder().encode("poof/v1/pass-key-seal"),
    },
    ikm,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function seal(master: string, variant: string, pkcs8: Uint8Array): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aad = new TextEncoder().encode(variant);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: aad },
      await sealingKey(master),
      pkcs8,
    ),
  );
  return `${toBase64Url(iv)}.${toBase64Url(ct)}`;
}

async function unseal(master: string, variant: string, sealed: string): Promise<Uint8Array> {
  const [iv, ct] = sealed.split(".");
  if (!iv || !ct) throw new Error("sealed key is malformed");
  const aad = new TextEncoder().encode(variant);
  return new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64Url(iv), additionalData: aad },
      await sealingKey(master),
      fromBase64Url(ct),
    ),
  );
}

export async function keyIdOf(spki: Uint8Array): Promise<string> {
  return toBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", spki)));
}

interface Row {
  variant: string;
  key_id: string;
  spki: string;
  sealed_private: string;
}

async function fromRow(env: KeyEnv, row: Row): Promise<PassKeyRecord> {
  const variant = parseVariantId(row.variant);
  if (!variant) throw new Error(`stored key has an unknown variant: ${row.variant}`);
  const pkcs8 = await unseal(env.PASS_MASTER_KEY, row.variant, row.sealed_private);
  const [privateKey, publicKey] = await Promise.all([
    // Extractable only in memory: blindrsa-ts re-imports it as RSA-RAW for the Workers fast path.
    crypto.subtle.importKey("pkcs8", pkcs8, RSA_PSS, true, ["sign"]),
    crypto.subtle.importKey("spki", fromBase64Url(row.spki), RSA_PSS, true, ["verify"]),
  ]);
  return {
    variant,
    variantId: row.variant,
    keyId: row.key_id,
    spki: row.spki,
    privateKey,
    publicKey,
  };
}

/** In-memory cache per isolate: keys never change once made. */
const cache = new Map<string, Promise<PassKeyRecord>>();

/** The key for `variant`, made and stored the first time it is asked for. */
export function passKeyFor(env: KeyEnv, variant: Variant): Promise<PassKeyRecord> {
  const id = variantId(variant);
  let hit = cache.get(id);
  if (!hit) {
    hit = loadOrCreate(env, id);
    cache.set(id, hit);
    hit.catch(() => cache.delete(id));
  }
  return hit;
}

async function loadOrCreate(env: KeyEnv, id: string): Promise<PassKeyRecord> {
  const existing = await env.LEDGER.prepare(
    "SELECT variant, key_id, spki, sealed_private FROM pass_keys WHERE variant = ?",
  )
    .bind(id)
    .first<Row>();
  if (existing) return fromRow(env, existing);

  const pair = (await crypto.subtle.generateKey(
    { ...RSA_PSS, modulusLength: PASS_KEY_BITS, publicExponent: new Uint8Array([1, 0, 1]) },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const spki = new Uint8Array(
    (await crypto.subtle.exportKey("spki", pair.publicKey)) as ArrayBuffer,
  );
  const pkcs8 = new Uint8Array(
    (await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer,
  );
  const row: Row = {
    variant: id,
    key_id: await keyIdOf(spki),
    spki: toBase64Url(spki),
    sealed_private: await seal(env.PASS_MASTER_KEY, id, pkcs8),
  };
  // Two isolates may race to make the same key: the first insert wins and both use it.
  await env.LEDGER.prepare(
    "INSERT INTO pass_keys (variant, key_id, spki, sealed_private, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (variant) DO NOTHING",
  )
    .bind(row.variant, row.key_id, row.spki, row.sealed_private, Date.now())
    .run();
  const stored = await env.LEDGER.prepare(
    "SELECT variant, key_id, spki, sealed_private FROM pass_keys WHERE variant = ?",
  )
    .bind(id)
    .first<Row>();
  if (!stored) throw new Error("pass key vanished after insert");
  return fromRow(env, stored);
}

/** Blind-sign a blinded pass message with the variant's key. */
export async function blindSign(key: PassKeyRecord, blindedMsg: Uint8Array): Promise<Uint8Array> {
  return suite(true).blindSign(key.privateKey, blindedMsg);
}

/** True if `signature` is a valid pass signature over `msg` for this key. */
export async function verifyPassSignature(
  key: PassKeyRecord,
  msg: Uint8Array,
  signature: Uint8Array,
): Promise<boolean> {
  try {
    return await suite().verify(key.publicKey, signature, msg);
  } catch {
    return false;
  }
}

/** For tests: forget the cached keys (the database is reset between test files). */
export function clearPassKeyCache(): void {
  cache.clear();
}
