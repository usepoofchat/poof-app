import { ml_kem768 } from "@noble/post-quantum/ml-kem.js";
import { PROTOCOL_VERSION, type PqMessage } from "@poof/protocol";
import {
  bytes,
  concat,
  fromBase64,
  lengthPrefixed,
  toBase64,
  utf8,
  type Bytes,
} from "../encoding.ts";
import { PoofError } from "../errors.ts";
import { hkdf, hmacSha256, importAesKey, sha256, verifyHmacSha256 } from "./primitives.ts";

/**
 * Hybrid key exchange run over the DataChannel before any chat:
 *
 *   I → R  pq.hello   { pk }                     ML-KEM-768 public key (1184 B)
 *   R → I  pq.reply   { ct, confirm }            ciphertext (1088 B) + responder MAC
 *   I → R  pq.confirm { confirm }                initiator MAC
 *
 * The master key mixes the URL-fragment key `K_C` and the ML-KEM shared secret `SQ`:
 *
 *   T = SHA-256("poof/v1/transcript" ‖ len‖roomId ‖ len‖initiatorId ‖ len‖responderId ‖ len‖pk ‖ len‖ct)
 *   K = HKDF-SHA256(ikm = K_C ‖ SQ, salt = "poof/v1/salt", info = "poof/v1/master" ‖ T)
 *
 * Concatenating both secrets into the IKM is the standard hybrid combiner: K stays secret as long
 * as EITHER K_C or SQ does. From K we derive independent keys: one per direction, a confirmation
 * key and a safety-code key.
 *
 * What this does and does not give:
 *  - Someone WITHOUT K_C (e.g. the signaling server, a network attacker) cannot derive K.
 *  - Someone WITH K_C (anyone who holds the link) can run two independent handshakes, one per
 *    leg, and every check passes on each leg. Transcript binding does not stop that; only the
 *    out-of-band safety code (`sas`, which differs between the two legs) does.
 */

export const LABELS = {
  transcript: "poof/v1/transcript",
  salt: "poof/v1/salt",
  master: "poof/v1/master",
  confirm: "poof/v1/confirm",
  i2r: "poof/v1/key/initiator-to-responder",
  r2i: "poof/v1/key/responder-to-initiator",
  sas: "poof/v1/sas",
  initiatorMac: "poof/v1/mac/initiator",
  responderMac: "poof/v1/mac/responder",
} as const;

export interface SessionKeys {
  /** Key for frames this side sends. */
  sendKey: CryptoKey;
  /** Key for frames this side receives. */
  recvKey: CryptoKey;
  /** 32 bytes for the safety-code UI (not built yet). Equal on both ends of ONE handshake. */
  sas: Bytes;
}

const EMPTY: Bytes = new Uint8Array(0);

/**
 * The two peer ids of this link. Bound into the transcript so that, in a group room, a handshake
 * can't be replayed or spliced between a different pair of members.
 */
export interface HandshakePair {
  initiator: string;
  responder: string;
}

async function transcript(
  roomId: string,
  pair: HandshakePair,
  pk: Uint8Array,
  ct: Uint8Array,
): Promise<Bytes> {
  return sha256(
    concat(
      utf8(LABELS.transcript),
      lengthPrefixed(utf8(roomId)),
      lengthPrefixed(utf8(pair.initiator)),
      lengthPrefixed(utf8(pair.responder)),
      lengthPrefixed(pk),
      lengthPrefixed(ct),
    ),
  );
}

interface Derived {
  keysForInitiator: SessionKeys;
  keysForResponder: SessionKeys;
  confirmKey: Bytes;
  transcriptHash: Bytes;
}

async function derive(
  roomKey: Uint8Array,
  sq: Uint8Array,
  transcriptHash: Bytes,
): Promise<Derived> {
  const master = await hkdf(
    concat(roomKey, sq),
    utf8(LABELS.salt),
    concat(utf8(LABELS.master), transcriptHash),
  );
  const [confirmKey, i2r, r2i, sas] = await Promise.all([
    hkdf(master, EMPTY, utf8(LABELS.confirm)),
    hkdf(master, EMPTY, utf8(LABELS.i2r)),
    hkdf(master, EMPTY, utf8(LABELS.r2i)),
    hkdf(master, EMPTY, utf8(LABELS.sas)),
  ]);
  const [i2rKey, r2iKey] = await Promise.all([importAesKey(i2r), importAesKey(r2i)]);
  master.fill(0);
  i2r.fill(0);
  r2i.fill(0);
  return {
    keysForInitiator: { sendKey: i2rKey, recvKey: r2iKey, sas },
    keysForResponder: { sendKey: r2iKey, recvKey: i2rKey, sas },
    confirmKey,
    transcriptHash,
  };
}

const macInput = (label: string, t: Uint8Array) => concat(utf8(label), t);

function decodeField(value: string, expectedLength: number, what: string): Bytes {
  let data: Bytes;
  try {
    data = fromBase64(value);
  } catch {
    throw new PoofError("pq_failed", `${what} is not valid base64`);
  }
  if (data.length !== expectedLength) {
    throw new PoofError("pq_failed", `${what} has the wrong length`);
  }
  return data;
}

const MAC_BYTES = 32;

export class InitiatorHandshake {
  private secretKey: Bytes | null = null;
  private publicKey: Bytes | null = null;

  constructor(
    private readonly roomId: string,
    private readonly roomKey: Uint8Array,
    private readonly pair: HandshakePair,
  ) {}

  /** Step 1: generate the ML-KEM keypair, return the `pq.hello` to send. */
  start(): PqMessage {
    const { publicKey, secretKey } = ml_kem768.keygen();
    this.publicKey = bytes(publicKey);
    this.secretKey = bytes(secretKey);
    return { v: PROTOCOL_VERSION, t: "pq.hello", pk: toBase64(this.publicKey) };
  }

  /** Step 3: verify the responder's MAC, return our `pq.confirm` and the session keys. */
  async handleReply(
    msg: Extract<PqMessage, { t: "pq.reply" }>,
  ): Promise<{ confirm: PqMessage; keys: SessionKeys }> {
    const { secretKey, publicKey } = this;
    if (!secretKey || !publicKey) throw new PoofError("pq_failed", "Handshake not started");
    this.secretKey = null;

    const ct = decodeField(msg.ct, ml_kem768.lengths.cipherText ?? 1088, "ciphertext");
    const responderMac = decodeField(msg.confirm, MAC_BYTES, "confirmation");

    let sq: Bytes;
    try {
      sq = bytes(ml_kem768.decapsulate(ct, secretKey));
    } catch {
      throw new PoofError("pq_failed", "Decapsulation failed");
    } finally {
      secretKey.fill(0);
    }

    const t = await transcript(this.roomId, this.pair, publicKey, ct);
    const d = await derive(this.roomKey, sq, t);
    sq.fill(0);

    const ok = await verifyHmacSha256(d.confirmKey, macInput(LABELS.responderMac, t), responderMac);
    if (!ok) throw new PoofError("pq_failed", "Responder confirmation did not verify");

    const mac = await hmacSha256(d.confirmKey, macInput(LABELS.initiatorMac, t));
    d.confirmKey.fill(0);
    return {
      confirm: { v: PROTOCOL_VERSION, t: "pq.confirm", confirm: toBase64(mac) },
      keys: d.keysForInitiator,
    };
  }

  /** Drop secrets if the handshake is abandoned. */
  dispose(): void {
    this.secretKey?.fill(0);
    this.secretKey = null;
  }
}

export class ResponderHandshake {
  private pending: { confirmKey: Bytes; transcriptHash: Bytes; keys: SessionKeys } | null = null;

  constructor(
    private readonly roomId: string,
    private readonly roomKey: Uint8Array,
    private readonly pair: HandshakePair,
  ) {}

  /** Step 2: encapsulate to the initiator's public key, return the `pq.reply` to send. */
  async handleHello(msg: Extract<PqMessage, { t: "pq.hello" }>): Promise<PqMessage> {
    if (this.pending) throw new PoofError("pq_failed", "Unexpected second pq.hello");
    const pk = decodeField(msg.pk, ml_kem768.lengths.publicKey ?? 1184, "public key");

    let ct: Bytes;
    let sq: Bytes;
    try {
      const out = ml_kem768.encapsulate(pk);
      ct = bytes(out.cipherText);
      sq = bytes(out.sharedSecret);
    } catch {
      throw new PoofError("pq_failed", "Encapsulation failed");
    }

    const t = await transcript(this.roomId, this.pair, pk, ct);
    const d = await derive(this.roomKey, sq, t);
    sq.fill(0);

    const mac = await hmacSha256(d.confirmKey, macInput(LABELS.responderMac, t));
    this.pending = { confirmKey: d.confirmKey, transcriptHash: t, keys: d.keysForResponder };
    return {
      v: PROTOCOL_VERSION,
      t: "pq.reply",
      ct: toBase64(ct),
      confirm: toBase64(mac),
    };
  }

  /** Step 4: verify the initiator's MAC; on success the keys are ready. */
  async handleConfirm(msg: Extract<PqMessage, { t: "pq.confirm" }>): Promise<SessionKeys> {
    const pending = this.pending;
    if (!pending) throw new PoofError("pq_failed", "Unexpected pq.confirm");
    this.pending = null;

    const mac = decodeField(msg.confirm, MAC_BYTES, "confirmation");
    const ok = await verifyHmacSha256(
      pending.confirmKey,
      macInput(LABELS.initiatorMac, pending.transcriptHash),
      mac,
    );
    pending.confirmKey.fill(0);
    if (!ok) throw new PoofError("pq_failed", "Initiator confirmation did not verify");
    return pending.keys;
  }

  dispose(): void {
    this.pending?.confirmKey.fill(0);
    this.pending = null;
  }
}
