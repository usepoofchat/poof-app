import {
  NOTE_CIPHERTEXT_MAX_BYTES,
  NOTE_PASSWORD_ITERATIONS,
  NOTE_PATH,
  NOTE_TEXT_MAX_CHARS,
  createNoteResponseSchema,
  errorBodySchema,
  noteStatusResponseSchema,
  revealNoteResponseSchema,
  type NoteStatus,
  type NoteTtl,
} from "@poof/protocol";
import { hkdf, sha256 } from "./crypto/primitives.ts";
import {
  concat,
  fromBase64Url,
  fromUtf8,
  randomBytes,
  toBase64Url,
  utf8,
  type Bytes,
} from "./encoding.ts";
import { PoofError } from "./errors.ts";
import { createPhraseInvite, takePhraseUrl } from "./phrase.ts";

/**
 * Poof Note: a one-time message, encrypted here, in the browser.
 *
 *   link      = <app>/note/#<id>.<key>        (".p" at the end when a password is needed too)
 *   id        = 16 random bytes (public: the server's address for the note, and part of the AAD)
 *   key       = 32 random bytes, only ever in the link's fragment
 *   master    = HKDF-SHA256(key [‖ PBKDF2-SHA256(password, 200,000)], salt = id)
 *   aes key   = HKDF(master, "aes")            → AES-256-GCM
 *   token     = HKDF(master, "reveal")         → the server keeps SHA-256(token), never the token
 *   stored    = header(version, flags) ‖ IV(12) ‖ AES-GCM(text), AAD = label ‖ header ‖ id
 *
 * Reading a note needs the token, so neither someone holding only the id nor a wrong password can
 * use the note up; the server hands the ciphertext over once and erases it in the same step.
 */

const VERSION = 1;
const FLAG_PASSWORD = 0x01;
const HEADER_BYTES = 2;
const IV_BYTES = 12;
const ID_BYTES = 16;
const KEY_BYTES = 32;
const LABEL = utf8("poof/note/v1");
const INFO = {
  master: utf8("poof/v1/note/master"),
  aes: utf8("poof/v1/note/aes"),
  reveal: utf8("poof/v1/note/reveal"),
  password: utf8("poof/v1/note/password"),
} as const;
const NOTE_FRAGMENT = /^#?([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})(\.p)?$/;

export interface NoteLink {
  id: string;
  key: Bytes;
  /** The link says a password is needed as well (".p"). The server never learns this. */
  hasPassword: boolean;
}

export interface CreatedNote extends NoteLink {
  /** The full link to share: `<appOrigin>/note/#<id>.<key>[.p]`. */
  url: string;
  /** Kept by the writer's browser for status and delete; the server only has its SHA-256. */
  creatorSecret: string;
  /** Server time (ms) when the note disappears, read or not. */
  expiresAt: number;
}

/** `<id>.<key>` or `<id>.<key>.p`, with or without the leading "#". Throws invalid_link otherwise. */
export function parseNoteFragment(fragment: string): NoteLink {
  const m = NOTE_FRAGMENT.exec(fragment);
  if (!m?.[1] || !m[2]) throw new PoofError("invalid_link", "Not a note link.");
  return { id: m[1], key: fromBase64Url(m[2]), hasPassword: m[3] === ".p" };
}

export function notePath(link: NoteLink): string {
  return `${NOTE_PATH}#${link.id}.${toBase64Url(link.key)}${link.hasPassword ? ".p" : ""}`;
}

export function noteUrl(appOrigin: string, link: NoteLink): string {
  return `${appOrigin.replace(/\/+$/, "")}${notePath(link)}`;
}

/** The length the UI counts against. */
export function noteTextLength(text: string): number {
  return [...text].length;
}

/** Will this text fit once encrypted? (Characters outside ASCII take more room.) */
export function noteFits(text: string): boolean {
  const n = noteTextLength(text);
  return (
    n > 0 &&
    n <= NOTE_TEXT_MAX_CHARS &&
    HEADER_BYTES + IV_BYTES + utf8(text).length + 16 <= NOTE_CIPHERTEXT_MAX_BYTES
  );
}

async function deriveNoteKeys(
  link: NoteLink,
  password: string | undefined,
): Promise<{ aes: CryptoKey; token: string }> {
  const id = fromBase64Url(link.id);
  let ikm: Uint8Array = link.key;
  if (link.hasPassword) {
    const pw = (password ?? "").normalize("NFKC");
    if (!pw) throw new PoofError("wrong_password", "This note needs a password.");
    const base = await crypto.subtle.importKey("raw", utf8(pw), "PBKDF2", false, ["deriveBits"]);
    const stretched = new Uint8Array(
      await crypto.subtle.deriveBits(
        {
          name: "PBKDF2",
          hash: "SHA-256",
          salt: concat(INFO.password, id),
          iterations: NOTE_PASSWORD_ITERATIONS,
        },
        base,
        256,
      ),
    );
    ikm = concat(link.key, stretched);
  }
  const master = await hkdf(ikm, id, INFO.master);
  const [aesRaw, token] = await Promise.all([
    hkdf(master, new Uint8Array(0), INFO.aes),
    hkdf(master, new Uint8Array(0), INFO.reveal),
  ]);
  const aes = await crypto.subtle.importKey(
    "raw",
    aesRaw,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  return { aes, token: toBase64Url(token) };
}

const headerFor = (link: NoteLink) =>
  new Uint8Array([VERSION, link.hasPassword ? FLAG_PASSWORD : 0]);
const aadFor = (header: Uint8Array, id: string) => concat(LABEL, header, fromBase64Url(id));

/** Encrypt a note's text for this link. Exposed for tests; createNote() is what the app uses. */
export async function sealNote(
  link: NoteLink,
  text: string,
  password?: string,
): Promise<{ ciphertext: string; revealToken: string }> {
  const { aes, token } = await deriveNoteKeys(link, password);
  const header = headerFor(link);
  const iv = randomBytes(IV_BYTES);
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: aadFor(header, link.id) },
      aes,
      utf8(text),
    ),
  );
  const blob = concat(header, iv, sealed);
  if (blob.length > NOTE_CIPHERTEXT_MAX_BYTES) {
    throw new PoofError("note_too_long", "This note is too long.");
  }
  return { ciphertext: toBase64Url(blob), revealToken: token };
}

/** Decrypt what the server handed over. Throws decrypt_failed if it isn't this note's ciphertext. */
export async function openNote(
  link: NoteLink,
  ciphertext: string,
  password?: string,
): Promise<string> {
  const { aes } = await deriveNoteKeys(link, password);
  let blob: Bytes;
  try {
    blob = fromBase64Url(ciphertext);
  } catch {
    throw new PoofError("decrypt_failed", "This note couldn't be opened.");
  }
  const header = blob.subarray(0, HEADER_BYTES);
  if (blob.length <= HEADER_BYTES + IV_BYTES || header[0] !== VERSION) {
    throw new PoofError("decrypt_failed", "This note couldn't be opened.");
  }
  try {
    const plain = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: blob.subarray(HEADER_BYTES, HEADER_BYTES + IV_BYTES),
        additionalData: aadFor(header, link.id),
      },
      aes,
      blob.subarray(HEADER_BYTES + IV_BYTES),
    );
    return fromUtf8(new Uint8Array(plain));
  } catch {
    throw new PoofError("decrypt_failed", "This note couldn't be opened.");
  }
}

async function call(fetchFn: typeof fetch, url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetchFn(url, init);
  } catch {
    throw new PoofError("connection_failed", "Could not reach the server.");
  }
}

async function errorCode(res: Response): Promise<string | null> {
  const body = errorBodySchema.safeParse(await res.json().catch(() => null));
  return body.success ? body.data.error.code : null;
}

const jsonInit = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

/** Write a note: encrypt it here, store the ciphertext, get the link to share. */
export async function createNote(opts: {
  fetch: typeof fetch;
  /** Origin of the API. */
  origin: string;
  /** Origin of the web app, for the link. Defaults to `origin`. */
  appOrigin?: string;
  text: string;
  ttl: NoteTtl;
  password?: string;
}): Promise<CreatedNote> {
  if (!noteFits(opts.text)) {
    throw new PoofError(
      opts.text.length ? "note_too_long" : "invalid_message",
      opts.text.length ? "This note is too long." : "The note is empty.",
    );
  }
  const secret = randomBytes(32);
  const creatorHash = toBase64Url(await sha256(secret));
  const hasPassword = Boolean(opts.password);
  for (let attempt = 0; attempt < 3; attempt++) {
    const link: NoteLink = {
      id: toBase64Url(randomBytes(ID_BYTES)),
      key: randomBytes(KEY_BYTES),
      hasPassword,
    };
    const { ciphertext, revealToken } = await sealNote(link, opts.text, opts.password);
    const revealHash = toBase64Url(await sha256(fromBase64Url(revealToken)));
    const res = await call(
      opts.fetch,
      `${opts.origin}/api/notes`,
      jsonInit("POST", { id: link.id, ciphertext, ttl: opts.ttl, creatorHash, revealHash }),
    );
    if (res.status === 409) continue; // practically never: someone else's id. Pick another.
    if (res.status === 429) throw new PoofError("rate_limited", "Too many notes. Try again soon.");
    if (!res.ok) throw new PoofError("connection_failed", `Server error ${res.status}.`);
    const parsed = createNoteResponseSchema.safeParse(await res.json().catch(() => null));
    if (!parsed.success) throw new PoofError("connection_failed", "Unexpected server response.");
    return {
      ...link,
      url: noteUrl(opts.appOrigin ?? opts.origin, link),
      creatorSecret: toBase64Url(secret),
      expiresAt: parsed.data.expiresAt,
    };
  }
  throw new PoofError("connection_failed", "Could not create the note. Try again.");
}

/**
 * Read a note, once. Only call this when the person asks to see it: the server erases the note as it
 * answers. A wrong password throws wrong_password and leaves the note in place.
 */
export async function revealNote(opts: {
  fetch: typeof fetch;
  origin: string;
  link: NoteLink;
  password?: string;
}): Promise<string> {
  const { token } = await deriveNoteKeys(opts.link, opts.password);
  const res = await call(
    opts.fetch,
    `${opts.origin}/api/notes/${opts.link.id}/reveal`,
    jsonInit("POST", { revealToken: token }),
  );
  if (res.status === 429) throw new PoofError("rate_limited", "Too many tries. Try again soon.");
  if (!res.ok) {
    const code = await errorCode(res);
    if (code === "wrong_secret")
      throw new PoofError("wrong_password", "That password doesn't open this note.");
    if (code === "note_gone" || res.status === 410)
      throw new PoofError("note_gone", "This note is gone.");
    throw new PoofError("connection_failed", `Server error ${res.status}.`);
  }
  const parsed = revealNoteResponseSchema.safeParse(await res.json().catch(() => null));
  if (!parsed.success) throw new PoofError("connection_failed", "Unexpected server response.");
  return openNote(opts.link, parsed.data.ciphertext, opts.password);
}

async function creatorCall(
  opts: { fetch: typeof fetch; origin: string; id: string; creatorSecret: string },
  method: "POST" | "DELETE",
): Promise<NoteStatus> {
  const path = method === "POST" ? `/api/notes/${opts.id}/status` : `/api/notes/${opts.id}`;
  const res = await call(
    opts.fetch,
    `${opts.origin}${path}`,
    jsonInit(method, { creatorSecret: opts.creatorSecret }),
  );
  if (res.status === 429) throw new PoofError("rate_limited", "Too many requests. Try again soon.");
  if (res.status === 403)
    throw new PoofError("not_owner", "Only the person who wrote the note can do that.");
  if (!res.ok) throw new PoofError("connection_failed", `Server error ${res.status}.`);
  const parsed = noteStatusResponseSchema.safeParse(await res.json().catch(() => null));
  if (!parsed.success) throw new PoofError("connection_failed", "Unexpected server response.");
  return parsed.data;
}

/** For the writer: waiting, read, deleted or expired. Never any content. */
export function noteStatus(opts: {
  fetch: typeof fetch;
  origin: string;
  id: string;
  creatorSecret: string;
}): Promise<NoteStatus> {
  return creatorCall(opts, "POST");
}

/** For the writer: delete the note before anyone reads it. */
export function deleteNote(opts: {
  fetch: typeof fetch;
  origin: string;
  id: string;
  creatorSecret: string;
}): Promise<NoteStatus> {
  return creatorCall(opts, "DELETE");
}

/** Put a note's link behind a fresh 4-word phrase (the same one-time mailbox as room invites). */
export function createNotePhrase(opts: {
  fetch: typeof fetch;
  origin: string;
  url: string;
}): Promise<{ code: string; serverExpiresAt: number }> {
  return createPhraseInvite({ fetch: opts.fetch, origin: opts.origin, inviteUrl: opts.url });
}

/** Four words in, the note's link out (still unread: reading it is a separate, deliberate step). */
export async function openNoteByPhrase(opts: {
  fetch: typeof fetch;
  origin: string;
  appOrigin?: string;
  code: string;
}): Promise<NoteLink> {
  const target = await takePhraseUrl(opts, "Those words don't open a note.");
  if (!/^\/note\/?$/.test(target.pathname)) {
    throw new PoofError("decrypt_failed", "Those words don't open a note.");
  }
  try {
    return parseNoteFragment(target.hash);
  } catch {
    throw new PoofError("decrypt_failed", "Those words don't open a note.");
  }
}
