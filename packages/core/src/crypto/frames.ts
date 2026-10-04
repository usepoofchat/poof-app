import { Channel, FRAME, FrameType, type ChannelId, type FrameTypeId } from "@poof/protocol";
import { concat, readU64be, u64be, type Bytes } from "../encoding.ts";
import { PoofError } from "../errors.ts";
import type { SessionKeys } from "./handshake.ts";

/**
 * Binary AEAD frames for everything sent after the key exchange.
 *
 *   offset size  field
 *   0      1     version (0x01)
 *   1      1     channel (0x01 ctl, 0x02 files)
 *   2      1     type
 *   3      8     seq (uint64 BE, per channel per direction, starts at 0, strictly +1)
 *   11     …     AES-256-GCM(key = directional key, nonce = channel ‖ 000 ‖ seq, aad = bytes[0..11])
 *
 * Separate keys per direction + per-direction counters mean a frame can't be reflected back at its
 * sender, nonces never repeat, and a dropped/replayed/reordered frame is detected. DataChannels are
 * ordered and reliable, so any seq mismatch means tampering and terminates the session.
 */

const VALID_CHANNELS: ReadonlySet<number> = new Set(Object.values(Channel));
const VALID_TYPES: ReadonlySet<number> = new Set(Object.values(FrameType));
/** Which frame types may travel on which channel. */
const TYPES_BY_CHANNEL: Record<number, ReadonlySet<number>> = {
  [Channel.Ctl]: new Set([FrameType.Chat, FrameType.Ctl]),
  [Channel.Files]: new Set([
    FrameType.FileMeta,
    FrameType.FileChunk,
    FrameType.FileEnd,
    FrameType.FileAbort,
    FrameType.FileAck,
  ]),
};

export interface OpenedFrame {
  channel: ChannelId;
  type: FrameTypeId;
  plaintext: Bytes;
}

function header(channel: number, type: number, seq: bigint): Bytes {
  return concat(new Uint8Array([FRAME.VERSION, channel, type]), u64be(seq));
}

function nonce(channel: number, seq: bigint): Bytes {
  return concat(new Uint8Array([channel, 0, 0, 0]), u64be(seq));
}

export class FrameCodec {
  private readonly sendSeq = new Map<number, bigint>();
  private readonly recvSeq = new Map<number, bigint>();
  /** Serialises sealing so frames hit the wire in the order they were requested. */
  private sendChain: Promise<unknown> = Promise.resolve();

  constructor(private readonly keys: Pick<SessionKeys, "sendKey" | "recvKey">) {}

  /**
   * Encrypt a frame. Calls are serialised: awaiting `seal()` results in call order and sending each
   * immediately preserves the sequence the receiver expects.
   */
  seal(channel: ChannelId, type: FrameTypeId, plaintext: Uint8Array): Promise<Bytes> {
    const run = async (): Promise<Bytes> => {
      const seq = this.sendSeq.get(channel) ?? 0n;
      this.sendSeq.set(channel, seq + 1n);
      const head = header(channel, type, seq);
      const ciphertext = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: nonce(channel, seq), additionalData: head, tagLength: 128 },
        this.keys.sendKey,
        plaintext as Bytes,
      );
      return concat(head, new Uint8Array(ciphertext));
    };
    const result = this.sendChain.then(run, run);
    this.sendChain = result.catch(() => undefined);
    return result;
  }

  /**
   * Decrypt and authenticate a frame. The sequence check happens synchronously, before any await, so
   * concurrent calls can't race the counter; callers should still feed frames in arrival order.
   */
  async open(data: Uint8Array): Promise<OpenedFrame> {
    if (data.length < FRAME.HEADER_BYTES + FRAME.TAG_BYTES) {
      throw new PoofError("frame_invalid", "Frame too short");
    }
    const [version, channel, type] = [data[0]!, data[1]!, data[2]!];
    if (version !== FRAME.VERSION)
      throw new PoofError("frame_invalid", "Unsupported frame version");
    if (!VALID_CHANNELS.has(channel) || !VALID_TYPES.has(type)) {
      throw new PoofError("frame_invalid", "Unknown channel or type");
    }
    if (!TYPES_BY_CHANNEL[channel]?.has(type)) {
      throw new PoofError("frame_invalid", "Type not allowed on this channel");
    }

    const seq = readU64be(data, 3);
    const expected = this.recvSeq.get(channel) ?? 0n;
    if (seq !== expected) {
      throw new PoofError("frame_out_of_order", `Expected seq ${expected}, got ${seq}`);
    }
    this.recvSeq.set(channel, expected + 1n);

    try {
      const plaintext = await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: nonce(channel, seq),
          additionalData: data.slice(0, FRAME.HEADER_BYTES),
          tagLength: 128,
        },
        this.keys.recvKey,
        data.slice(FRAME.HEADER_BYTES),
      );
      return {
        channel: channel as ChannelId,
        type: type as FrameTypeId,
        plaintext: new Uint8Array(plaintext),
      };
    } catch {
      throw new PoofError("decrypt_failed", "Frame failed authentication");
    }
  }
}
