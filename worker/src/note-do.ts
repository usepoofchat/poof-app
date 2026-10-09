import { DurableObject } from "cloudflare:workers";
import { NOTE_MAX_WRONG_REVEALS, type NoteState, type NoteStatus } from "@poof/protocol";
import { ownerSecretMatches } from "./util.ts";

/** The one row a note keeps. After it is read or deleted, only the state and the end time remain. */
interface NoteRow {
  state: "waiting" | "read" | "deleted";
  expiresAt: number;
  creatorHash: string;
  /** Present only while the note is waiting. */
  ciphertext?: string;
  revealHash?: string;
  wrong?: number;
}

const ROW = "note";

export type RevealResult =
  { ok: true; ciphertext: string } | { ok: false; reason: "gone" | "wrong_secret" };

/**
 * One Durable Object per Poof Note, modelled on MailboxDO. It holds ciphertext it can't open: the key
 * is only in the link's fragment. `reveal()` hands the ciphertext over and erases it in the same step
 * (a DO runs one request at a time and storage writes hold the input gate), so a second reveal can
 * only ever get "gone". An alarm wipes everything at the end of the note's lifetime.
 */
export class NoteDO extends DurableObject<Env> {
  /** Store a new note. Null if this id is already in use (409 at the HTTP layer). */
  async create(opts: {
    ciphertext: string;
    ttlSeconds: number;
    creatorHash: string;
    revealHash: string;
  }): Promise<{ expiresAt: number } | null> {
    if (await this.ctx.storage.get<NoteRow>(ROW)) return null;
    const row: NoteRow = {
      state: "waiting",
      expiresAt: Date.now() + opts.ttlSeconds * 1000,
      creatorHash: opts.creatorHash,
      ciphertext: opts.ciphertext,
      revealHash: opts.revealHash,
      wrong: 0,
    };
    await this.ctx.storage.put(ROW, row);
    await this.ctx.storage.setAlarm(row.expiresAt);
    return { expiresAt: row.expiresAt };
  }

  /**
   * The one reading: the right token gets the ciphertext, which is erased before the answer leaves.
   * A wrong token (a wrong password) leaves the note in place, up to NOTE_MAX_WRONG_REVEALS times.
   */
  async reveal(revealToken: string): Promise<RevealResult> {
    const row = await this.live();
    if (!row || row.state !== "waiting" || !row.ciphertext || !row.revealHash) {
      return { ok: false, reason: "gone" };
    }
    if (!(await ownerSecretMatches(revealToken, row.revealHash))) {
      const wrong = (row.wrong ?? 0) + 1;
      if (wrong >= NOTE_MAX_WRONG_REVEALS) await this.forget(row, "deleted");
      else await this.ctx.storage.put(ROW, { ...row, wrong });
      return { ok: false, reason: "wrong_secret" };
    }
    const { ciphertext } = row;
    await this.forget(row, "read");
    return { ok: true, ciphertext };
  }

  /** For the creator: what happened to the note. Null when the secret doesn't match. */
  async status(creatorSecret: string): Promise<NoteStatus | null> {
    const row = await this.live();
    if (!row) return { state: "expired" };
    if (!(await ownerSecretMatches(creatorSecret, row.creatorHash))) return null;
    return { state: row.state satisfies NoteState, expiresAt: row.expiresAt };
  }

  /** The creator deletes the note before anyone reads it. */
  async remove(creatorSecret: string): Promise<NoteStatus | null> {
    const row = await this.live();
    if (!row) return { state: "expired" };
    if (!(await ownerSecretMatches(creatorSecret, row.creatorHash))) return null;
    if (row.state === "waiting") await this.forget(row, "deleted");
    return { state: row.state === "waiting" ? "deleted" : row.state, expiresAt: row.expiresAt };
  }

  override async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }

  /** The row while the note's lifetime lasts (the alarm may not have run yet). */
  private async live(): Promise<NoteRow | null> {
    const row = await this.ctx.storage.get<NoteRow>(ROW);
    return row && Date.now() < row.expiresAt ? row : null;
  }

  /** Drop the ciphertext and the reveal hash; keep only the state for the creator until the end. */
  private async forget(row: NoteRow, state: "read" | "deleted"): Promise<void> {
    await this.ctx.storage.put(ROW, {
      state,
      expiresAt: row.expiresAt,
      creatorHash: row.creatorHash,
    } satisfies NoteRow);
  }
}
