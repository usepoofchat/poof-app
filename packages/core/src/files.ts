import {
  FILE_CHUNK_BYTES,
  FrameType,
  fileAbortSchema,
  fileAckSchema,
  fileEndSchema,
  fileMetaSchema,
  type FileAbortReason,
  type FileMeta,
  type FrameTypeId,
  type Limits,
} from "@poof/protocol";
import { sha256 } from "./crypto/primitives.ts";
import { concat, fromBase64Url, fromUtf8, toBase64Url, utf8, type Bytes } from "./encoding.ts";
import { sanitizeFileName, sanitizeMime } from "./text.ts";

/**
 * File transfer between this browser and ONE other member, over that pair's encrypted `files`
 * channel. A group room runs one lane per member and sends a file to each of them separately.
 *
 *   sender                                   receiver
 *   file.meta { fileId, name, size, mime, chunks, sha256 } ─►  checks limits, size, chunk count
 *   file.chunk  fileId(16) ‖ index(4) ‖ ≤ 16 KiB  … ───────►  exact index and length, in place
 *   file.end { fileId } ───────────────────────────────────►  hashes the whole file
 *                       ◄─────────────────────────────────── file.ack { fileId, ok }
 *   either side, any time:  file.abort { fileId, reason }
 *
 * One transfer at a time per direction: outgoing files queue, and a second `file.meta` while one is
 * still arriving is refused with `busy`.
 */

/** Why a transfer to or from one member didn't complete. */
export type FileFailReason = FileAbortReason | "hash_mismatch" | "connection_lost" | "timeout";

/** How long the sender waits for the receiver's verdict after the last chunk. */
export const DEFAULT_FILE_ACK_TIMEOUT_MS = 30_000;

const FILE_ID_BYTES = 16;
const CHUNK_PREFIX_BYTES = FILE_ID_BYTES + 4;

export function chunkCount(size: number): number {
  return Math.ceil(size / FILE_CHUNK_BYTES);
}

/** `fileId(16) ‖ index(4, big-endian) ‖ data` */
export function encodeChunk(fileId: Uint8Array, index: number, data: Uint8Array): Bytes {
  const head = new Uint8Array(CHUNK_PREFIX_BYTES);
  head.set(fileId.subarray(0, FILE_ID_BYTES));
  new DataView(head.buffer).setUint32(FILE_ID_BYTES, index);
  return concat(head, data);
}

export function decodeChunk(
  plaintext: Uint8Array,
): { fileId: string; index: number; data: Uint8Array } | null {
  if (plaintext.length < CHUNK_PREFIX_BYTES) return null;
  const view = new DataView(plaintext.buffer, plaintext.byteOffset, plaintext.byteLength);
  return {
    fileId: toBase64Url(plaintext.subarray(0, FILE_ID_BYTES)),
    index: view.getUint32(FILE_ID_BYTES),
    data: plaintext.subarray(CHUNK_PREFIX_BYTES),
  };
}

/** base64url(SHA-256(bytes)), the form `file.meta` carries. */
export async function hashFile(bytes: Uint8Array): Promise<string> {
  return toBase64Url(await sha256(bytes));
}

/** The encrypted `files` channel of one member link. */
export interface FileWire {
  /** Encrypt and send one frame. Rejects once the link is gone. */
  send(type: FrameTypeId, plaintext: Uint8Array): Promise<void>;
  /** Resolves when the channel's send buffer has room for more chunks (backpressure). */
  ready(): Promise<void>;
}

export interface OutgoingFile {
  fileId: string;
  name: string;
  mime: string;
  bytes: Uint8Array;
  /** `hashFile(bytes)`, computed once for all recipients. */
  sha256: string;
}

/** A file the other side announced, already sanitised. */
export interface IncomingFileInfo {
  fileId: string;
  name: string;
  size: number;
  mime: string;
}

export interface FileLaneHooks {
  /** This room's limits, read when a file is announced. */
  limits(): Limits;
  /** A valid `file.meta` arrived. Return false to refuse it (e.g. a fileId that's already in use). */
  incomingStart(info: IncomingFileInfo): boolean;
  incomingProgress(fileId: string, receivedBytes: number): void;
  /** The whole file arrived and its hash matches. */
  incomingDone(fileId: string, bytes: Bytes): void;
  incomingFailed(fileId: string, reason: FileFailReason): void;
}

/** `allSent`: the last chunk is out; the receiver's verdict is pending. */
export type SendProgress = (sentBytes: number, allSent: boolean) => void;
export type SendResult = { ok: true } | { ok: false; reason: FileFailReason };

interface Outgoing {
  fileId: string;
  done: boolean;
  ackTimer: ReturnType<typeof setTimeout> | null;
  finish(result: SendResult): void;
}

interface Incoming {
  fileId: string;
  size: number;
  chunks: number;
  sha256: string;
  buffer: Bytes;
  next: number;
  received: number;
}

export class FileLane {
  private outgoing: Outgoing | null = null;
  private incoming: Incoming | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly queued = new Set<string>();
  private readonly cancelledEarly = new Set<string>();
  private closed = false;

  constructor(
    private readonly wire: FileWire,
    private readonly hooks: FileLaneHooks,
    private readonly ackTimeoutMs = DEFAULT_FILE_ACK_TIMEOUT_MS,
  ) {}

  /** Send a file to this member. Never rejects: the result says whether they verified it. */
  send(file: OutgoingFile, onProgress: SendProgress): Promise<SendResult> {
    this.queued.add(file.fileId);
    const result = this.queue.then(() => this.run(file, onProgress));
    this.queue = result;
    return result;
  }

  /** Stop a transfer in either direction (or a queued one) and tell the other side. */
  cancel(fileId: string): void {
    if (this.outgoing?.fileId === fileId) {
      this.outgoing.finish({ ok: false, reason: "cancelled" });
      this.abort(fileId, "cancelled");
    } else if (this.incoming?.fileId === fileId) {
      this.failIncoming("cancelled");
    } else if (this.queued.has(fileId)) {
      this.cancelledEarly.add(fileId);
    }
  }

  /** Handle a decrypted frame from the files channel. Frames arrive one at a time, in order. */
  async handle(type: FrameTypeId, plaintext: Uint8Array): Promise<void> {
    if (this.closed) return;
    switch (type) {
      case FrameType.FileMeta:
        return this.onMeta(parse(fileMetaSchema, plaintext));
      case FrameType.FileChunk:
        return this.onChunk(plaintext);
      case FrameType.FileEnd:
        return this.onEnd(parse(fileEndSchema, plaintext));
      case FrameType.FileAbort:
        return this.onAbort(parse(fileAbortSchema, plaintext));
      case FrameType.FileAck:
        return this.onAck(parse(fileAckSchema, plaintext));
    }
  }

  /** The link is gone: everything in flight fails with `connection_lost`. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.outgoing?.finish({ ok: false, reason: "connection_lost" });
    const incoming = this.incoming;
    this.incoming = null;
    if (incoming) this.hooks.incomingFailed(incoming.fileId, "connection_lost");
  }

  // ── Sending ───────────────────────────────────────────────────────────────

  private run(file: OutgoingFile, onProgress: SendProgress): Promise<SendResult> {
    this.queued.delete(file.fileId);
    if (this.cancelledEarly.delete(file.fileId))
      return Promise.resolve({ ok: false, reason: "cancelled" });
    if (this.closed) return Promise.resolve({ ok: false, reason: "connection_lost" });

    let resolve!: (result: SendResult) => void;
    const result = new Promise<SendResult>((r) => (resolve = r));
    const out: Outgoing = {
      fileId: file.fileId,
      done: false,
      ackTimer: null,
      finish: (r) => {
        if (out.done) return;
        out.done = true;
        if (out.ackTimer) clearTimeout(out.ackTimer);
        if (this.outgoing === out) this.outgoing = null;
        resolve(r);
      },
    };
    this.outgoing = out;
    // The result doesn't wait for the pump: a cancel or abort settles it even while the pump is
    // stuck behind backpressure. The pump notices `done` at its next step and stops.
    void this.pump(file, out, onProgress);
    return result;
  }

  private async pump(file: OutgoingFile, out: Outgoing, onProgress: SendProgress): Promise<void> {
    const { bytes, fileId } = file;
    const size = bytes.length;
    const chunks = chunkCount(size);
    try {
      const meta: FileMeta = {
        fileId,
        name: file.name,
        size,
        mime: file.mime,
        chunks,
        sha256: file.sha256,
      };
      await this.wire.send(FrameType.FileMeta, json(meta));
      const id = fromBase64Url(fileId);
      for (let index = 0; index < chunks && !out.done; index++) {
        await this.wire.ready();
        if (out.done) return;
        const start = index * FILE_CHUNK_BYTES;
        const end = Math.min(size, start + FILE_CHUNK_BYTES);
        await this.wire.send(
          FrameType.FileChunk,
          encodeChunk(id, index, bytes.subarray(start, end)),
        );
        if (!out.done) onProgress(end, false);
      }
      if (out.done) return;
      await this.wire.send(FrameType.FileEnd, json({ fileId }));
      if (out.done) return;
      onProgress(size, true);
      out.ackTimer = setTimeout(
        () => out.finish({ ok: false, reason: "timeout" }),
        this.ackTimeoutMs,
      );
    } catch {
      out.finish({ ok: false, reason: "connection_lost" });
    }
  }

  private abort(fileId: string, reason: FileAbortReason): void {
    this.wire.send(FrameType.FileAbort, json({ fileId, reason })).catch(() => {
      /* the link is gone; the other side finds out on its own */
    });
  }

  // ── Receiving ─────────────────────────────────────────────────────────────

  private onMeta(meta: FileMeta | null): void {
    if (!meta) return;
    const limits = this.hooks.limits();
    // Defence against a modified client: files are off in this room, whatever the sender thinks.
    if (!limits.fileTransfer) return this.abort(meta.fileId, "not_allowed");
    if (this.incoming) {
      if (this.incoming.fileId === meta.fileId) this.failIncoming("invalid");
      else this.abort(meta.fileId, "busy");
      return;
    }
    if (meta.size > limits.fileMaxBytes) return this.abort(meta.fileId, "too_large");
    if (meta.chunks !== chunkCount(meta.size)) return this.abort(meta.fileId, "invalid");

    const info: IncomingFileInfo = {
      fileId: meta.fileId,
      name: sanitizeFileName(meta.name),
      size: meta.size,
      mime: sanitizeMime(meta.mime),
    };
    if (!this.hooks.incomingStart(info)) return this.abort(meta.fileId, "invalid");
    this.incoming = {
      fileId: meta.fileId,
      size: meta.size,
      chunks: meta.chunks,
      sha256: meta.sha256,
      buffer: new Uint8Array(meta.size),
      next: 0,
      received: 0,
    };
  }

  private onChunk(plaintext: Uint8Array): void {
    const chunk = decodeChunk(plaintext);
    const incoming = this.incoming;
    // Chunks of a file we refused or cancelled can still be in flight: ignore them.
    if (!chunk || !incoming || chunk.fileId !== incoming.fileId) return;
    const last = incoming.chunks - 1;
    const expectedLength =
      chunk.index === last ? incoming.size - last * FILE_CHUNK_BYTES : FILE_CHUNK_BYTES;
    if (
      chunk.index !== incoming.next ||
      chunk.index > last ||
      chunk.data.length !== expectedLength
    ) {
      return this.failIncoming("invalid");
    }
    incoming.buffer.set(chunk.data, chunk.index * FILE_CHUNK_BYTES);
    incoming.next += 1;
    incoming.received += chunk.data.length;
    this.hooks.incomingProgress(incoming.fileId, incoming.received);
  }

  private async onEnd(end: { fileId: string } | null): Promise<void> {
    const incoming = this.incoming;
    if (!end || !incoming || end.fileId !== incoming.fileId) return;
    if (incoming.next !== incoming.chunks) return this.failIncoming("invalid");

    const ok = (await hashFile(incoming.buffer)) === incoming.sha256;
    if (this.incoming !== incoming) return; // cancelled or closed while hashing (already reported)
    this.incoming = null;
    this.wire.send(FrameType.FileAck, json({ fileId: incoming.fileId, ok })).catch(() => {
      /* the sender times out */
    });
    if (ok) this.hooks.incomingDone(incoming.fileId, incoming.buffer);
    else this.hooks.incomingFailed(incoming.fileId, "hash_mismatch");
  }

  private onAbort(abort: { fileId: string; reason: FileAbortReason } | null): void {
    if (!abort) return;
    if (this.outgoing?.fileId === abort.fileId)
      this.outgoing.finish({ ok: false, reason: abort.reason });
    if (this.incoming?.fileId === abort.fileId) {
      this.incoming = null;
      this.hooks.incomingFailed(abort.fileId, abort.reason);
    }
  }

  private onAck(ack: { fileId: string; ok: boolean } | null): void {
    if (!ack || this.outgoing?.fileId !== ack.fileId) return;
    this.outgoing.finish(ack.ok ? { ok: true } : { ok: false, reason: "hash_mismatch" });
  }

  /** Drop the file being received, tell the sender why, and report it. */
  private failIncoming(reason: FileAbortReason): void {
    const incoming = this.incoming;
    if (!incoming) return;
    this.incoming = null;
    this.abort(incoming.fileId, reason);
    this.hooks.incomingFailed(incoming.fileId, reason);
  }
}

function json(value: unknown): Bytes {
  return utf8(JSON.stringify(value));
}

interface Schema<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
}

function parse<T>(schema: Schema<T>, plaintext: Uint8Array): T | null {
  try {
    const parsed = schema.safeParse(JSON.parse(fromUtf8(plaintext)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
