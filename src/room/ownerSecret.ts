/**
 * The creator's secret is the only thing poof keeps in the
 * browser. It lives in `sessionStorage` (this tab only), so a refresh of the creator's tab can still
 * destroy the room; closing the tab forgets it. Never in the URL, never in localStorage.
 *
 * Storage can be missing or throw (private modes, blocked site data): then the creator simply can't
 * destroy after a refresh, which is the safe failure.
 */

const KEY_PREFIX = "poof:owner:";

function defaultStorage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export function saveOwnerSecret(roomId: string, secret: string, storage = defaultStorage()): void {
  try {
    storage?.setItem(KEY_PREFIX + roomId, secret);
  } catch {
    /* quota or blocked: see above */
  }
}

export function readOwnerSecret(roomId: string, storage = defaultStorage()): string | undefined {
  try {
    const value = storage?.getItem(KEY_PREFIX + roomId);
    return value && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export function clearOwnerSecret(roomId: string, storage = defaultStorage()): void {
  try {
    storage?.removeItem(KEY_PREFIX + roomId);
  } catch {
    /* nothing to do */
  }
}
