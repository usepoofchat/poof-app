import { DurableObject } from "cloudflare:workers";
import { HANDSHAKE_TTL_SECONDS } from "@poof/protocol";

interface Box {
  blob: string;
  expiresAt: number;
}

const BOX_KEY = "box";

/**
 * One-time mailbox for the 4-word phrase invite. The id is derived client-side from the phrase with
 * a slow KDF, so the server can't brute-force it; the blob is AES-GCM encrypted under a key derived
 * from the same phrase. `take()` returns and deletes in one atomic step (a DO is single-threaded
 * and storage reads/writes hold the input gate), and an alarm wipes unread blobs after the TTL.
 */
export class MailboxDO extends DurableObject<Env> {
  /** Store a blob. Returns null if an unexpired blob already exists (409 at the HTTP layer). */
  async put(blob: string): Promise<{ expiresAt: number } | null> {
    const existing = await this.ctx.storage.get<Box>(BOX_KEY);
    if (existing && existing.expiresAt > Date.now()) return null;

    const box: Box = { blob, expiresAt: Date.now() + HANDSHAKE_TTL_SECONDS * 1000 };
    await this.ctx.storage.put(BOX_KEY, box);
    await this.ctx.storage.setAlarm(box.expiresAt);
    return { expiresAt: box.expiresAt };
  }

  /** Return the blob and delete it. Null if missing or expired. */
  async take(): Promise<string | null> {
    const box = await this.ctx.storage.get<Box>(BOX_KEY);
    if (!box) return null;
    await this.ctx.storage.deleteAll();
    return box.expiresAt > Date.now() ? box.blob : null;
  }

  override async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}
