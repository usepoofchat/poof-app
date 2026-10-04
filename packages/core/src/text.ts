import { CHAT_MAX_CHARS, FILE_NAME_MAX_CHARS, NICKNAME_MAX_CHARS } from "@poof/protocol";

/**
 * Normalise chat text on both send and receive: NFKC, CRLF → LF, strip control characters EXCEPT
 * newline and tab (multi-line messages are a feature), trim, cap length by code points.
 */
export function normalizeChatText(value: string | null | undefined): string {
  const text = (value ?? "")
    .normalize("NFKC")
    .replace(/\r\n?/g, "\n")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "")
    .trim();
  const points = Array.from(text);
  return points.length > CHAT_MAX_CHARS ? points.slice(0, CHAT_MAX_CHARS).join("") : text;
}

/** Defensive file name cleanup for received files: no paths, no control chars, ≤ 255 characters. */
export function sanitizeFileName(value: string | null | undefined): string {
  const cleaned = (value ?? "")
    .normalize("NFKC")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, "")
    .replace(/[\\/:*?"<>|]/g, "_")
    .trim();
  const points = Array.from(cleaned).slice(0, FILE_NAME_MAX_CHARS).join("").trim();
  return points.replace(/^\.+$/, "") || "download";
}

/**
 * Types a received file may keep, so the UI can preview it inline. Everything else becomes
 * application/octet-stream (download only). Never HTML, SVG or anything else a browser would run:
 * a blob: URL has our origin, so opening such a file would be script on our page.
 */
const PREVIEW_MIME = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export function sanitizeMime(value: string | null | undefined): string {
  const mime = (value ?? "").trim().toLowerCase();
  return PREVIEW_MIME.has(mime) ? mime : "application/octet-stream";
}

/**
 * Display name cleanup, on send and on receipt: NFKC, no control characters or line breaks,
 * whitespace collapsed, ≤ 32 code points. Empty → null (no nickname).
 */
export function normalizeNickname(value: string | null | undefined): string | null {
  const text = (value ?? "")
    .normalize("NFKC")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const points = Array.from(text).slice(0, NICKNAME_MAX_CHARS).join("").trim();
  return points || null;
}
