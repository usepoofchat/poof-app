import { RSABSSA } from "@cloudflare/blindrsa-ts";
import { PASS_MESSAGE_BYTES, variantId, type Pass, type Variant } from "@poof/protocol";
import { bytes, fromBase64Url, randomBytes, toBase64Url, type Bytes } from "./encoding.ts";
import { PoofError } from "./errors.ts";

/**
 * One-time passes for Super Quant-Rooms (RFC 9474 blind RSA, RSABSSA-SHA384-PSS-Randomized).
 *
 *   browser                                   Poof
 *   msg = prepare(32 random bytes)
 *   blinded, inv = blind(key_variant, msg) ─► checks the payment, signs `blinded` without seeing msg
 *   sig = finalize(blinded sig, inv)       ◄─ blind signature
 *   … later: create the room with (msg, sig) ─► checks sig with key_variant, burns msg
 *
 * Poof never sees `msg` before it is spent, so it can't tell which payment a room came from.
 * There is one key per variant (lifetime × people), so a pass is worth exactly what was paid.
 */

const suite = () => RSABSSA.SHA384.PSS.Randomized();

/** A pass key as `/api/pay/config` lists it. */
export interface PassKey {
  variant: string;
  keyId: string;
  /** SubjectPublicKeyInfo, base64url. */
  spki: string;
}

/** Everything needed to finish a pass once the blind signature arrives. Plain strings: it can be stored. */
export interface PendingPass {
  variant: Variant;
  keyId: string;
  spki: string;
  /** Prepared message, base64url. */
  msg: string;
  /** Blinding inverse, base64url. Secret: whoever has it can link the pass to the payment. */
  inv: string;
  /** What goes to the server, base64url. */
  blindedMsg: string;
}

/** base64url(SHA-256(spki)): a key's id is its fingerprint, so it can't be relabelled. */
export async function passKeyId(spki: Bytes): Promise<string> {
  return toBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", spki)));
}

async function importPublicKey(spki: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "spki",
    fromBase64Url(spki),
    { name: "RSA-PSS", hash: "SHA-384" },
    true,
    ["verify"],
  );
}

/** Pick the key for `variant` from the published list and blind a fresh pass message for it. */
export async function startPass(keys: readonly PassKey[], variant: Variant): Promise<PendingPass> {
  const key = keys.find((k) => k.variant === variantId(variant));
  if (!key) throw new PoofError("pay_unavailable", "This quant-room can't be bought right now.");
  if ((await passKeyId(fromBase64Url(key.spki))) !== key.keyId) {
    throw new PoofError("pay_unavailable", "The pass key doesn't match its id.");
  }
  const publicKey = await importPublicKey(key.spki);
  const msg = suite().prepare(randomBytes(PASS_MESSAGE_BYTES));
  const { blindedMsg, inv } = await suite().blind(publicKey, msg);
  return {
    variant,
    keyId: key.keyId,
    spki: key.spki,
    msg: toBase64Url(msg),
    inv: toBase64Url(inv),
    blindedMsg: toBase64Url(blindedMsg),
  };
}

/** Hex SHA-256 of the blinded message: what the paying wallet signs, so the redemption is bound to it. */
export async function blindedHash(pending: Pick<PendingPass, "blindedMsg">): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", fromBase64Url(pending.blindedMsg)),
  );
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Unblind the server's signature into a pass. Throws if the signature isn't valid for the key. */
export async function finishPass(pending: PendingPass, blindSignature: string): Promise<Pass> {
  const publicKey = await importPublicKey(pending.spki);
  let signature: Bytes;
  try {
    signature = bytes(
      await suite().finalize(
        publicKey,
        fromBase64Url(pending.msg),
        fromBase64Url(blindSignature),
        fromBase64Url(pending.inv),
      ),
    );
  } catch {
    throw new PoofError("pay_failed", "The pass signature didn't check out.");
  }
  return {
    variant: pending.variant,
    keyId: pending.keyId,
    msg: pending.msg,
    signature: toBase64Url(signature),
  };
}
