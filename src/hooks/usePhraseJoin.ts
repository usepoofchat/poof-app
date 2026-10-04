import { useCallback, useRef, useState } from "react";
import { PoofError, joinByPhrase } from "@poof/core";

export type PhraseJoinErrorCode =
  | "invalid_code" // not four words from the list
  | "not_found_or_expired" // already used, or older than 3 minutes
  | "decrypt_failed" // the code doesn't open a room on this site
  | "rate_limited"
  | "connection_failed";

export interface PhraseJoinOptions {
  /** Go to the room (`/join/#<id>.<key>`). Pass React Router's `navigate`; default is a full page load. */
  navigate?: (path: string) => void;
  /** Overridable for tests. */
  fetch?: typeof fetch;
  origin?: string;
}

export interface PhraseJoin {
  join: (code: string) => Promise<void>;
  joining: boolean;
  /** Why a phrase didn't open a room: the phrase's own codes plus the two network ones. */
  error: PhraseJoinErrorCode | null;
}

const KNOWN: ReadonlySet<string> = new Set<PhraseJoinErrorCode>([
  "invalid_code",
  "not_found_or_expired",
  "decrypt_failed",
  "rate_limited",
  "connection_failed",
]);

const defaultNavigate = (path: string) => window.location.assign(path);

/** Landing page "Have a code?": four words → the room. A code works once. */
export function usePhraseJoin(options: PhraseJoinOptions = {}): PhraseJoin {
  const { navigate = defaultNavigate, fetch: fetchImpl, origin } = options;
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<PhraseJoinErrorCode | null>(null);
  // A ref, not state: a double submit lands before React re-renders with joining=true. A second
  // take() would burn the one-time code and report "already used".
  const busy = useRef(false);

  const join = useCallback(
    async (code: string) => {
      if (busy.current) return;
      busy.current = true;
      setJoining(true);
      setError(null);
      try {
        const path = await joinByPhrase({
          fetch: fetchImpl ?? window.fetch.bind(window),
          origin: origin ?? window.location.origin,
          code,
        });
        navigate(path);
      } catch (err) {
        const known = err instanceof PoofError && KNOWN.has(err.code);
        setError(known ? (err.code as PhraseJoinErrorCode) : "connection_failed");
      } finally {
        busy.current = false;
        setJoining(false);
      }
    },
    [navigate, fetchImpl, origin],
  );

  return { join, joining, error };
}
