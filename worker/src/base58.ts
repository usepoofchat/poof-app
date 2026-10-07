/** Base58 (the Bitcoin alphabet), as Solana writes addresses and signatures. */

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const VALUE = new Map([...ALPHABET].map((c, i) => [c, i]));

export function fromBase58(text: string): Uint8Array {
  const bytes: number[] = []; // little-endian while building
  for (const c of text) {
    let carry = VALUE.get(c);
    if (carry === undefined) throw new Error("not base58");
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i]! * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  let zeros = 0;
  while (zeros < text.length && text[zeros] === "1") zeros++;
  return new Uint8Array([...new Array<number>(zeros).fill(0), ...bytes.reverse()]);
}

export function toBase58(bytes: Uint8Array): string {
  const digits: number[] = []; // little-endian while building
  for (const b of bytes) {
    let carry = b;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i]! << 8;
      digits[i] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let out = "";
  for (const b of bytes) {
    if (b !== 0) break;
    out += "1";
  }
  for (let i = digits.length - 1; i >= 0; i--) out += ALPHABET[digits[i]!];
  return out;
}
