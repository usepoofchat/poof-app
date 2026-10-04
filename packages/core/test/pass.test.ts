import { RSABSSA } from "@cloudflare/blindrsa-ts";
import { describe, expect, it } from "vitest";
import { variantId, type Variant } from "@poof/protocol";
import {
  blindedHash,
  finishPass,
  passKeyId,
  startPass,
  fromBase64Url,
  toBase64Url,
  type PassKey,
} from "../src/index.ts";

const V: Variant = { lifetime: 3600, people: 4, ai: false };
const suite = () => RSABSSA.SHA384.PSS.Randomized();

/** What the Worker does: a key per variant, and blind signing. */
async function issuer(variant = V) {
  const { privateKey, publicKey } = await suite().generateKey({
    publicExponent: Uint8Array.from([1, 0, 1]),
    modulusLength: 2048,
  });
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", publicKey));
  const key: PassKey = {
    variant: variantId(variant),
    keyId: await passKeyId(spki),
    spki: toBase64Url(spki),
  };
  return {
    key,
    sign: async (blinded: string) =>
      toBase64Url(await suite().blindSign(privateKey, fromBase64Url(blinded))),
    verify: (msg: string, sig: string) =>
      suite().verify(publicKey, fromBase64Url(sig), fromBase64Url(msg)),
  };
}

describe("passes (RFC 9474 blind RSA)", () => {
  it("a blinded pass signed by the server verifies, and the server never saw the message", async () => {
    const server = await issuer();
    const pending = await startPass([server.key], V);
    expect(pending.blindedMsg).not.toContain(pending.msg);
    const pass = await finishPass(pending, await server.sign(pending.blindedMsg));
    expect(pass).toMatchObject({ variant: V, keyId: server.key.keyId, msg: pending.msg });
    expect(await server.verify(pass.msg, pass.signature)).toBe(true);
    // Unlinkable: what the server signed and what is later spent share nothing.
    expect(pass.signature).not.toBe(await server.sign(pending.blindedMsg));
  });

  it("two passes for the same variant are different", async () => {
    const server = await issuer();
    const a = await startPass([server.key], V);
    const b = await startPass([server.key], V);
    expect(a.msg).not.toBe(b.msg);
    expect(a.blindedMsg).not.toBe(b.blindedMsg);
  });

  it("refuses a variant with no key, and a key whose id doesn't match its bytes", async () => {
    const server = await issuer();
    await expect(
      startPass([server.key], { lifetime: 86400, people: 4, ai: false }),
    ).rejects.toMatchObject({ code: "pay_unavailable" });
    await expect(startPass([{ ...server.key, keyId: "x".repeat(43) }], V)).rejects.toMatchObject({
      code: "pay_unavailable",
    });
  });

  it("refuses a signature from another key", async () => {
    const server = await issuer();
    const other = await issuer();
    const pending = await startPass([server.key], V);
    await expect(finishPass(pending, await other.sign(pending.blindedMsg))).rejects.toMatchObject({
      code: "pay_failed",
    });
  });

  it("the hash the wallet signs is the blinded message's SHA-256, in hex", async () => {
    const server = await issuer();
    const pending = await startPass([server.key], V);
    expect(await blindedHash(pending)).toMatch(/^[0-9a-f]{64}$/);
  });
});
